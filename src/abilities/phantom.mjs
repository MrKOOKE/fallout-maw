import { SYSTEM_ID } from "../constants.mjs";
import { registerDamageAppliedHandler } from "../combat/damage-hub.mjs";
import { registerWeaponAttackTerminalHandler } from "../combat/weapon-attack-controller.mjs";
import { canTokenPhysicallySeeTarget } from "../canvas/physical-los.mjs";
import {
  registerStealthObserverExclusionProvider
} from "../stealth/observers.mjs";
import { toggleActorStealth } from "../stealth/controller.mjs";
import { registerTokenTargetAlphaProvider } from "../canvas/token-target-alpha.mjs";
import {
  PHANTOM_VISION_FLAG_KEY,
  actorsArePhantomAllies,
  hasExplicitActorObservation
} from "../canvas/phantom-vision.mjs";
import {
  PHANTOM_ENTITY_FLAG_KEY,
  buildPhantomEntityData,
  isPhantomEntity
} from "./phantom-entity.mjs";

export const PHANTOM_FLAG_KEY = "phantom";
export const PHANTOM_EXPIRY_EFFECT_FLAG_KEY = "phantomExpiry";

const PHANTOM_OBSERVER_PROVIDER_ID = "fixed.phantom";
const PHANTOM_DAMAGE_HANDLER_ID = "fallout-maw.fixed.phantom";
const PHANTOM_WEAPON_TERMINAL_HANDLER_ID = "fallout-maw.fixed.phantom.weaponTerminal";
const PHANTOM_ALPHA_PROVIDER_ID = "fallout-maw.fixed.phantom";
const PHANTOM_ALLY_ALPHA = 0.4;
const PHANTOM_VISIBILITY_CACHE_LIMIT = 1000;
const PHANTOM_CLEANUP_OPTION = "falloutMawPhantomCleanup";

const phantomTokensBySourceActor = new Map();
const phantomVisibilityCache = new Map();
const pendingPhantomCleanup = new Set();
let phantomVisibilityRevision = 0;
let hooksRegistered = false;

export function registerPhantomRuntimeHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  registerStealthObserverExclusionProvider(PHANTOM_OBSERVER_PROVIDER_ID, observerSeesActivePhantom);
  registerDamageAppliedHandler(PHANTOM_DAMAGE_HANDLER_ID, onDamageApplied);
  registerWeaponAttackTerminalHandler(PHANTOM_WEAPON_TERMINAL_HANDLER_ID, onWeaponAttackTerminal);
  registerTokenTargetAlphaProvider(PHANTOM_ALPHA_PROVIDER_ID, getPhantomTokenTargetAlpha);
  Hooks.on("preCreateItem", item => !isPhantomEntity(item?.parent));
  Hooks.on("preCreateActiveEffect", effect => (
    !isPhantomEntity(effect?.parent) || isPhantomExpiryEffect(effect)
  ));
  Hooks.on("preCreateCombatant", combatant => (
    !isPhantomEntity(combatant?.actor) && !isPhantomEntity(combatant?.token)
  ));

  Hooks.on("canvasReady", () => {
    rebuildCurrentScenePhantomIndex();
  });
  Hooks.on("canvasTearDown", clearPhantomCanvasState);
  Hooks.on("drawToken", indexPhantomToken);
  Hooks.on("createToken", document => {
    invalidatePhantomVisibility();
    indexPhantomToken(document?.object ?? document);
  });
  Hooks.on("updateToken", document => {
    invalidatePhantomVisibility();
    const token = document?.object ?? document;
    indexPhantomToken(token);
  });
  Hooks.on("deleteToken", (document, options = {}) => {
    invalidatePhantomVisibility();
    unindexPhantomToken(document);
    if (options?.[PHANTOM_CLEANUP_OPTION] || !game.user?.isActiveGM) return;
    const actor = document?.actor;
    if (getPhantomData(actor)) void deletePhantomActor(actor);
    else void deletePhantomsLinked({ sourceTokenUuid: document?.uuid });
  });
  Hooks.on("deleteActor", (actor, options = {}) => {
    if (!game.user?.isActiveGM || options?.[PHANTOM_CLEANUP_OPTION]) return;
    const phantomData = getPhantomData(actor);
    if (phantomData) void deletePhantomToken(phantomData.phantomTokenUuid);
    else void deletePhantomsLinked({ sourceActorUuid: actor?.uuid });
  });
  Hooks.on("deleteActiveEffect", effect => {
    if (game.user?.isActiveGM && isPhantomExpiryEffect(effect)) void deletePhantomActor(effect.parent);
  });
  Hooks.on("updateActiveEffect", (effect, changes = {}) => {
    if (
      game.user?.isActiveGM
      && isPhantomExpiryEffect(effect)
      && (changes?.duration?.expired === true || effect?.duration?.expired === true)
    ) void deletePhantomActor(effect.parent);
  });
  Hooks.on("sightRefresh", invalidatePhantomVisibility);
  Hooks.on("initializeVisionSources", requestPhantomTargetAlphaRefresh);
  Hooks.on("updateActor", (_actor, changes = {}) => {
    if (phantomTokensBySourceActor.size && actorPhantomViewChanged(changes)) requestPhantomTargetAlphaRefresh();
  });
  Hooks.on(`${SYSTEM_ID}.factionSettingsChanged`, requestPhantomTargetAlphaRefresh);
}

export async function createPhantomForActor({
  sourceActor = null,
  sourceToken = null,
  abilityItem = null,
  abilityFunction = null,
  durationSeconds = 12
} = {}) {
  if (!game.user?.isGM || !sourceActor || !sourceToken?.parent) return null;
  if (findActivePhantomToken(sourceActor.uuid)) return null;

  const scene = sourceToken.parent;
  const startTime = Number(game.time?.worldTime) || 0;
  const duration = Math.max(1, Math.trunc(Number(durationSeconds) || 12));
  const commonData = {
    sourceActorUuid: sourceActor.uuid,
    sourceTokenUuid: sourceToken.uuid,
    abilityItemUuid: abilityItem?.uuid ?? "",
    abilityFunctionId: String(abilityFunction?.id ?? ""),
    createdAt: startTime,
    expiresAt: startTime + duration
  };

  let phantomActor = null;
  let phantomToken = null;
  try {
    phantomActor = await Actor.create(buildPhantomActorData(sourceActor, commonData), { renderSheet: false });
    if (!phantomActor) return null;
    [phantomToken] = await scene.createEmbeddedDocuments("Token", [
      buildPhantomTokenData(sourceToken, phantomActor, commonData)
    ], { animate: false });
    if (!phantomToken) throw new Error("Phantom token was not created");

    commonData.phantomActorUuid = phantomActor.uuid;
    commonData.phantomTokenUuid = phantomToken.uuid;
    await phantomActor.update({
      [`flags.${SYSTEM_ID}.${PHANTOM_FLAG_KEY}`]: commonData
    }, { [PHANTOM_CLEANUP_OPTION]: true });
    await phantomActor.createEmbeddedDocuments("ActiveEffect", [{
      type: "base",
      name: "Фантом: время существования",
      img: abilityItem?.img || sourceActor.img || "icons/svg/mystery-man.svg",
      origin: abilityItem?.uuid ?? "",
      transfer: false,
      disabled: false,
      showIcon: 0,
      duration: { seconds: duration, startTime },
      system: { changes: [] },
      flags: {
        [SYSTEM_ID]: {
          kind: "temporary",
          [PHANTOM_EXPIRY_EFFECT_FLAG_KEY]: true
        }
      }
    }], { animate: false });

    indexPhantomToken(phantomToken.object ?? phantomToken);
    const stealthed = await toggleActorStealth(sourceActor, true, { skipEntryDetection: true });
    if (!stealthed) throw new Error("Source actor could not enter stealth");
    return phantomToken;
  } catch (error) {
    console.error(`${SYSTEM_ID} | Phantom creation failed`, error);
    if (phantomToken) await deletePhantomToken(phantomToken.uuid);
    if (phantomActor) await deletePhantomActor(phantomActor);
    return null;
  }
}

export function buildPhantomActorData(sourceActor, phantomData = {}) {
  const sourceSystem = cloneData(
    sourceActor?._source?.system
      ?? sourceActor?.system?.toObject?.()
      ?? sourceActor?.system
      ?? {}
  );
  sourceSystem.currencies = {};
  const factionBelongs = cloneData(sourceActor?.getFlag?.(SYSTEM_ID, "factionBelongs") ?? []);
  const factionRelations = cloneData(sourceActor?.getFlag?.(SYSTEM_ID, "factionRelations") ?? {});
  return {
    name: `${sourceActor?.name ?? "Актёр"} — Фантом`,
    type: String(sourceActor?.type ?? "character"),
    img: sourceActor?.img || "icons/svg/mystery-man.svg",
    items: [],
    effects: [],
    ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE },
    system: sourceSystem,
    flags: {
      [SYSTEM_ID]: {
        [PHANTOM_ENTITY_FLAG_KEY]: buildPhantomEntityData(),
        [PHANTOM_FLAG_KEY]: cloneData(phantomData),
        factionBelongs,
        factionRelations
      }
    }
  };
}

export function buildPhantomTokenData(sourceToken, phantomActor, phantomData = {}) {
  const texture = cloneData(sourceToken?.texture?.toObject?.() ?? sourceToken?.texture ?? {});
  const bar1 = cloneData(sourceToken?.bar1?.toObject?.() ?? sourceToken?.bar1 ?? {});
  const bar2 = cloneData(sourceToken?.bar2?.toObject?.() ?? sourceToken?.bar2 ?? {});
  const sight = cloneData(sourceToken?._source?.sight ?? sourceToken?.sight?.toObject?.() ?? sourceToken?.sight ?? {});
  const detectionModes = cloneData(
    sourceToken?._source?.detectionModes
      ?? sourceToken?.detectionModes?.toObject?.()
      ?? sourceToken?.detectionModes
      ?? []
  );
  return {
    name: String(sourceToken?.name ?? sourceToken?.actor?.name ?? "Фантом"),
    actorId: phantomActor.id,
    actorLink: false,
    x: Number(sourceToken?.x) || 0,
    y: Number(sourceToken?.y) || 0,
    elevation: Number(sourceToken?.elevation) || 0,
    width: Math.max(0.5, Number(sourceToken?.width) || 1),
    height: Math.max(0.5, Number(sourceToken?.height) || 1),
    depth: Math.max(0, Number(sourceToken?.depth) || 1),
    rotation: Number(sourceToken?.rotation) || 0,
    disposition: sourceToken?.disposition ?? CONST.TOKEN_DISPOSITIONS.NEUTRAL,
    displayName: sourceToken?.displayName ?? CONST.TOKEN_DISPLAY_MODES.NONE,
    displayBars: sourceToken?.displayBars ?? CONST.TOKEN_DISPLAY_MODES.NONE,
    bar1,
    bar2,
    // The persisted TokenDocument is opaque. Source/allied viewpoints receive
    // local translucency through FalloutMaWToken._getTargetAlpha.
    alpha: 1,
    texture,
    sight,
    detectionModes,
    hidden: false,
    locked: true,
    flags: {
      [SYSTEM_ID]: {
        [PHANTOM_ENTITY_FLAG_KEY]: buildPhantomEntityData(),
        [PHANTOM_FLAG_KEY]: cloneData(phantomData),
        [PHANTOM_VISION_FLAG_KEY]: {
          sourceActorUuid: String(phantomData?.sourceActorUuid ?? ""),
          sourceTokenUuid: String(phantomData?.sourceTokenUuid ?? "")
        }
      }
    }
  };
}

export function getPhantomData(document = null) {
  return document?.getFlag?.(SYSTEM_ID, PHANTOM_FLAG_KEY)
    ?? document?.flags?.[SYSTEM_ID]?.[PHANTOM_FLAG_KEY]
    ?? document?._source?.flags?.[SYSTEM_ID]?.[PHANTOM_FLAG_KEY]
    ?? null;
}

function observerSeesActivePhantom(hiddenToken, observerToken) {
  const phantomToken = findActivePhantomToken(hiddenToken?.actor?.uuid, hiddenToken);
  if (!phantomToken) return false;
  const key = `${tokenUuid(phantomToken)}|${tokenUuid(observerToken)}`;
  const signature = buildVisibilitySignature(phantomToken, observerToken);
  const cached = phantomVisibilityCache.get(key);
  if (cached?.signature === signature) return cached.visible;
  const visible = canTokenPhysicallySeeTarget(observerToken, phantomToken);
  phantomVisibilityCache.set(key, { signature, visible });
  trimVisibilityCache();
  return visible;
}

function findActivePhantomToken(sourceActorUuid = "", hiddenToken = null) {
  const sourceUuid = String(sourceActorUuid ?? "").trim();
  if (!sourceUuid || !canvas?.ready) return null;
  let token = phantomTokensBySourceActor.get(sourceUuid) ?? null;
  if (token && token.document?.parent?.id !== canvas.scene?.id) token = null;
  if (!token) {
    token = (canvas.tokens?.placeables ?? []).find(candidate => (
      String(getPhantomData(candidate?.document)?.sourceActorUuid ?? "") === sourceUuid
    )) ?? null;
    if (token) phantomTokensBySourceActor.set(sourceUuid, token);
  }
  if (!token || token.document?.hidden === true) return null;
  if (hiddenToken?.document?.parent?.id && token.document?.parent?.id !== hiddenToken.document.parent.id) return null;
  const data = getPhantomData(token.document);
  const expiresAt = Number(data?.expiresAt);
  if (Number.isFinite(expiresAt) && (Number(game.time?.worldTime) || 0) >= expiresAt) return null;
  return token;
}

function indexPhantomToken(token) {
  const object = token?.object ?? token;
  const document = object?.document ?? object;
  const data = getPhantomData(document);
  const sourceActorUuid = String(data?.sourceActorUuid ?? "").trim();
  if (!sourceActorUuid || !object?.actor) return false;
  phantomTokensBySourceActor.set(sourceActorUuid, object);
  return true;
}

function unindexPhantomToken(token) {
  const data = getPhantomData(token?.document ?? token);
  const sourceActorUuid = String(data?.sourceActorUuid ?? "").trim();
  if (sourceActorUuid) phantomTokensBySourceActor.delete(sourceActorUuid);
}

function rebuildCurrentScenePhantomIndex() {
  phantomTokensBySourceActor.clear();
  for (const token of canvas?.tokens?.placeables ?? []) indexPhantomToken(token);
  invalidatePhantomVisibility();
}

function clearPhantomCanvasState() {
  phantomTokensBySourceActor.clear();
  invalidatePhantomVisibility();
}

function getPhantomTokenTargetAlpha(token, baseAlpha = 1) {
  const phantomData = getPhantomData(token?.document ?? token);
  if (!phantomData) return baseAlpha;
  const sourceActor = resolvePhantomSourceActor(phantomData);
  return localViewRecognizesPhantom(sourceActor)
    ? Math.min(baseAlpha, PHANTOM_ALLY_ALPHA)
    : baseAlpha;
}

export function localViewRecognizesPhantom(sourceActor) {
  if (!sourceActor) return false;

  // Foundry has already resolved control, actor permissions and free-view state
  // into the client's active vision sources. If at least one current viewpoint
  // is the source actor or its ally, that combined local view recognizes the copy.
  let hasActorVisionSource = false;
  for (const visionSource of canvas?.effects?.visionSources ?? []) {
    if (!visionSource?.active) continue;
    const observerActor = visionSource?.object?.actor ?? visionSource?.object?.document?.actor;
    if (!observerActor) continue;
    hasActorVisionSource = true;
    if (actorsArePhantomAllies(sourceActor, observerActor)) return true;
  }
  if (hasActorVisionSource) return false;

  // With no active source Foundry gives a GM unrestricted scene vision. Preserve
  // that omniscient view without pretending that GM ownership makes every actor
  // an ally. A non-GM free view is resolved from explicit OBSERVER rights only.
  if (game.user?.isGM) return true;
  return (canvas?.tokens?.placeables ?? []).some(observerToken => (
    hasExplicitActorObservation(observerToken?.actor, game.user)
    && actorsArePhantomAllies(sourceActor, observerToken.actor)
  ));
}

function resolvePhantomSourceActor(phantomData = {}) {
  const sourceToken = fromUuidSync(String(phantomData?.sourceTokenUuid ?? ""));
  return sourceToken?.actor
    ?? fromUuidSync(String(phantomData?.sourceActorUuid ?? ""))
    ?? null;
}

function requestPhantomTargetAlphaRefresh() {
  for (const token of phantomTokensBySourceActor.values()) {
    token?.renderFlags?.set?.({ refreshState: true });
  }
}

function actorPhantomViewChanged(changes = {}) {
  const paths = Object.keys(foundry.utils.flattenObject(changes));
  const belongsRoot = `flags.${SYSTEM_ID}.factionBelongs`;
  const relationsRoot = `flags.${SYSTEM_ID}.factionRelations`;
  return paths.some(path => (
    path === "ownership"
    || path.startsWith("ownership.")
    || path === belongsRoot
    || path.startsWith(`${belongsRoot}.`)
    || path === relationsRoot
    || path.startsWith(`${relationsRoot}.`)
  ));
}

async function onDamageApplied({ results = [] } = {}) {
  if (!game.user?.isActiveGM) return;
  const actors = new Map();
  for (const result of results.flat(Infinity).filter(Boolean)) {
    if (result.mode && result.mode !== "damage") continue;
    if (result.phantomDestroyed !== true) continue;
    if (isWeaponAttackDamageResult(result)) continue;
    const actor = resolveDamageResultActor(result);
    if (getPhantomData(actor)) actors.set(actor.uuid, actor);
  }
  for (const actor of actors.values()) void deletePhantomActor(actor);
}

async function onWeaponAttackTerminal({ damageResults = [] } = {}) {
  if (!game.user?.isActiveGM) return;
  const actors = new Map();
  for (const result of damageResults.flat(Infinity).filter(Boolean)) {
    if (result.phantomDestroyed !== true || !isWeaponAttackDamageResult(result)) continue;
    const actor = resolveDamageResultActor(result);
    if (getPhantomData(actor)) actors.set(actor.uuid, actor);
  }
  await Promise.all(Array.from(actors.values(), actor => deletePhantomActor(actor)));
}

function isWeaponAttackDamageResult(result = {}) {
  return result?.source?.weaponAttackDamage === true;
}

function resolveDamageResultActor(result = {}) {
  const targetToken = fromUuidSync(String(result?.source?.targetTokenUuid ?? ""));
  return result?.actor
    ?? targetToken?.actor
    ?? fromUuidSync(String(result?.actorUuid ?? ""));
}

async function deletePhantomsLinked({ sourceActorUuid = "", sourceTokenUuid = "" } = {}) {
  const actors = (game.actors?.contents ?? []).filter(actor => {
    const data = getPhantomData(actor);
    return data && (
      (sourceActorUuid && data.sourceActorUuid === sourceActorUuid)
      || (sourceTokenUuid && data.sourceTokenUuid === sourceTokenUuid)
    );
  });
  await Promise.all(actors.map(deletePhantomActor));
}

async function deletePhantomActor(actor) {
  const data = getPhantomData(actor);
  const baseActor = actor?.parent?.baseActor
    ?? fromUuidSync(String(data?.phantomActorUuid ?? ""))
    ?? game.actors?.get(actor?.id)
    ?? actor;
  if (!game.user?.isActiveGM || !baseActor?.id || !getPhantomData(baseActor)) return false;
  if (pendingPhantomCleanup.has(baseActor.uuid)) return false;
  pendingPhantomCleanup.add(baseActor.uuid);
  try {
    const cleanupOperations = [
      deletePhantomToken(getPhantomData(baseActor)?.phantomTokenUuid)
    ];
    if (game.actors?.get(baseActor.id)) {
      cleanupOperations.push(baseActor.delete({ [PHANTOM_CLEANUP_OPTION]: true }));
    }
    const results = await Promise.all(cleanupOperations.map(operation => (
      Promise.resolve(operation).catch(error => {
        console.error(`${SYSTEM_ID} | Phantom cleanup failed`, error);
        return false;
      })
    )));
    return results.some(Boolean);
  } finally {
    pendingPhantomCleanup.delete(baseActor.uuid);
  }
}

async function deletePhantomToken(uuid = "") {
  const document = fromUuidSync(String(uuid ?? ""));
  if (!document?.id || document.documentName !== "Token") return false;
  await document.delete({ [PHANTOM_CLEANUP_OPTION]: true, animate: false });
  return true;
}

function isPhantomExpiryEffect(effect) {
  const expiry = effect?.getFlag?.(SYSTEM_ID, PHANTOM_EXPIRY_EFFECT_FLAG_KEY)
    ?? effect?.flags?.[SYSTEM_ID]?.[PHANTOM_EXPIRY_EFFECT_FLAG_KEY]
    ?? effect?._source?.flags?.[SYSTEM_ID]?.[PHANTOM_EXPIRY_EFFECT_FLAG_KEY];
  return Boolean(expiry && getPhantomData(effect?.parent));
}

function invalidatePhantomVisibility() {
  phantomVisibilityRevision += 1;
  phantomVisibilityCache.clear();
}

function buildVisibilitySignature(phantomToken, observerToken) {
  return `${phantomVisibilityRevision}|${tokenPositionSignature(phantomToken)}|${tokenPositionSignature(observerToken)}`;
}

function tokenPositionSignature(token) {
  const document = token?.document ?? token;
  return [document?.x, document?.y, document?.elevation, document?.rotation, document?.width, document?.height].join(":");
}

function tokenUuid(token) {
  return String(token?.document?.uuid ?? token?.uuid ?? "");
}

function trimVisibilityCache() {
  while (phantomVisibilityCache.size > PHANTOM_VISIBILITY_CACHE_LIMIT) {
    phantomVisibilityCache.delete(phantomVisibilityCache.keys().next().value);
  }
}

function cloneData(value) {
  return foundry.utils.deepClone(value);
}
