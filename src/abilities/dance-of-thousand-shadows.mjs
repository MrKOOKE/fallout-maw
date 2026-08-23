import { SYSTEM_ID } from "../constants.mjs";
import { registerDamageAppliedHandler } from "../combat/damage-hub.mjs";
import { registerWeaponAttackTerminalHandler } from "../combat/weapon-attack-controller.mjs";
import { registerCombatRoundStartHandler } from "../combat/turn-events.mjs";
import { hasAuraLineOfSight, measureTokenDistanceMeters } from "./aura-conditions.mjs";
import {
  PHANTOM_FLAG_KEY,
  buildPhantomActorData,
  buildPhantomTokenData,
  localViewRecognizesPhantom
} from "./phantom.mjs";
import { registerTokenTargetAlphaProvider } from "../canvas/token-target-alpha.mjs";
import { SYSTEM_RELOCATION_OPTION } from "../canvas/movement-interruptions.mjs";
import { synchronizeStealthMovementStateAfterRelocation } from "../stealth/movement.mjs";
import { isActorStealthed } from "../stealth/rules.mjs";
import { isPhantomEntity } from "./phantom-entity.mjs";

export const DANCE_OF_THOUSAND_SHADOWS_EFFECT_FLAG_KEY = "danceOfThousandShadows";
export const DANCE_OF_THOUSAND_SHADOWS_PHANTOM_FLAG_KEY = "danceOfThousandShadowsPhantom";

const DANCE_DAMAGE_HANDLER_ID = "fallout-maw.fixed.danceOfThousandShadows";
const DANCE_WEAPON_TERMINAL_HANDLER_ID = "fallout-maw.fixed.danceOfThousandShadows.weaponTerminal";
const DANCE_ALPHA_PROVIDER_ID = "fallout-maw.fixed.danceOfThousandShadows";
const DANCE_CLEANUP_OPTION = "falloutMawDanceOfThousandShadowsCleanup";
const DANCE_ALLY_ALPHA = 0.4;
const MAX_PLACEMENT_RINGS = 6;
const GRIDLESS_DIRECTIONS = 16;
const pendingSessionCleanup = new Set();
let hooksRegistered = false;

export function registerDanceOfThousandShadowsRuntimeHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;

  registerDamageAppliedHandler(DANCE_DAMAGE_HANDLER_ID, processDanceDamageResults);
  registerWeaponAttackTerminalHandler(DANCE_WEAPON_TERMINAL_HANDLER_ID, processDanceWeaponAttackTerminal);
  registerTokenTargetAlphaProvider(DANCE_ALPHA_PROVIDER_ID, getDancePhantomTargetAlpha);
  const registerRoundHandler = () => registerCombatRoundStartHandler(processDanceRoundStart);
  if (game.ready) registerRoundHandler();
  else Hooks.once("ready", registerRoundHandler);

  Hooks.on("deleteActiveEffect", (effect, options = {}) => {
    const data = getDanceEffectData(effect);
    if (!data || options?.[DANCE_CLEANUP_OPTION] || !game.user?.isActiveGM) return;
    void cleanupDanceSession(data);
  });
  Hooks.on("updateActiveEffect", (effect, changes = {}, options = {}) => {
    const data = getDanceEffectData(effect);
    if (!data || options?.[DANCE_CLEANUP_OPTION] || !game.user?.isActiveGM) return;
    if (changes?.disabled === true || changes?.duration?.expired === true || effect?.duration?.expired === true) {
      void cleanupDanceSession(data);
    }
  });
  Hooks.on("deleteToken", (token, options = {}) => {
    if (options?.[DANCE_CLEANUP_OPTION] || !game.user?.isActiveGM) return;
    const sourceEffect = findDanceEffectBySourceTokenUuid(token?.uuid);
    if (sourceEffect) void sourceEffect.delete({ [DANCE_CLEANUP_OPTION]: false });
  });
  Hooks.on("deleteActor", (actor, options = {}) => {
    if (options?.[DANCE_CLEANUP_OPTION] || !game.user?.isActiveGM) return;
    const phantomData = getDancePhantomData(actor);
    if (phantomData) {
      const effect = findDanceEffectBySessionId(phantomData.sessionId);
      if (effect) void effect.delete({ [DANCE_CLEANUP_OPTION]: false });
      else void cleanupDanceSession(phantomData);
      return;
    }
    const sourceData = getDanceEffectData(findActiveDanceEffect(actor));
    if (sourceData) void cleanupDanceSession(sourceData);
  });
  Hooks.on("drawToken", token => refreshDancePhantomAlpha(token));
  Hooks.on("createToken", token => refreshDancePhantomAlpha(token?.object ?? token));
  Hooks.on("updateToken", token => refreshDancePhantomAlpha(token?.object ?? token));
  Hooks.on("initializeVisionSources", refreshAllDancePhantomAlpha);
  Hooks.on("sightRefresh", refreshAllDancePhantomAlpha);
  Hooks.on(`${SYSTEM_ID}.factionSettingsChanged`, refreshAllDancePhantomAlpha);
}

export async function activateDanceOfThousandShadows({
  sourceActor = null,
  sourceToken = null,
  abilityItem = null,
  abilityFunction = null,
  settings = {}
} = {}) {
  if (!game.user?.isGM || !sourceActor || sourceToken?.documentName !== "Token" || !sourceToken.parent) return null;
  if (findActiveDanceEffect(sourceActor)) return null;
  if (!isActiveCanvasScene(sourceToken.parent)) return null;

  const startTime = Number(game.time?.worldTime) || 0;
  const durationSeconds = Math.max(1, toInteger(settings.durationSeconds, 18));
  const sessionId = foundry.utils.randomID();
  const commonData = {
    sessionId,
    sourceActorUuid: sourceActor.uuid,
    sourceTokenUuid: sourceToken.uuid,
    sceneId: sourceToken.parent.id,
    abilityItemId: String(abilityItem?.id ?? ""),
    abilityItemUuid: String(abilityItem?.uuid ?? ""),
    abilityFunctionId: String(abilityFunction?.id ?? ""),
    createdAt: startTime,
    expiresAt: startTime + durationSeconds,
    settings: normalizeRuntimeSettings(settings),
    killTargetUuids: []
  };

  let phantomActor = null;
  let effect = null;
  try {
    phantomActor = await Actor.create(buildDancePhantomActorData(sourceActor, commonData), { renderSheet: false });
    if (!phantomActor) throw new Error("Dance phantom actor was not created");
    commonData.phantomActorUuid = phantomActor.uuid;
    await phantomActor.update({
      [`flags.${SYSTEM_ID}.${DANCE_OF_THOUSAND_SHADOWS_PHANTOM_FLAG_KEY}`]: commonData
    }, { [DANCE_CLEANUP_OPTION]: true });

    [effect] = await sourceActor.createEmbeddedDocuments("ActiveEffect", [{
      type: "base",
      name: abilityItem?.name || "Танец тысячи теней",
      img: abilityItem?.img || sourceActor.img || "icons/svg/mystery-man.svg",
      origin: abilityItem?.uuid ?? sourceActor.uuid,
      transfer: false,
      disabled: false,
      showIcon: 2,
      duration: { seconds: durationSeconds, startTime },
      system: { changes: [] },
      flags: {
        [SYSTEM_ID]: {
          kind: "temporary",
          [DANCE_OF_THOUSAND_SHADOWS_EFFECT_FLAG_KEY]: commonData
        }
      }
    }], { animate: false });
    if (!effect) throw new Error("Dance source effect was not created");

    const reconciled = await reconcileDancePhantoms(effect, { round: game.combat?.round ?? 0 });
    if (!reconciled || !getDancePhantomTokens(commonData).length) {
      throw new Error("No valid dance phantom placement was found");
    }
    return effect;
  } catch (error) {
    console.error(`${SYSTEM_ID} | Dance of Thousand Shadows activation failed`, error);
    if (effect) await effect.delete({ [DANCE_CLEANUP_OPTION]: true });
    if (phantomActor && game.actors?.get(phantomActor.id)) {
      await phantomActor.delete({ [DANCE_CLEANUP_OPTION]: true });
    }
    return null;
  }
}

export async function swapWithDancePhantom({ sourceActor = null, sourceToken = null, phantomToken = null } = {}) {
  const effect = findActiveDanceEffect(sourceActor);
  const effectData = getDanceEffectData(effect);
  const phantomData = getDancePhantomData(phantomToken);
  const scene = sourceToken?.parent;
  if (
    !game.user?.isGM
    || !effectData
    || !phantomData
    || phantomData.sessionId !== effectData.sessionId
    || sourceToken?.uuid !== effectData.sourceTokenUuid
    || sourceToken?.documentName !== "Token"
    || phantomToken?.documentName !== "Token"
    || phantomToken.parent?.id !== scene?.id
    || !isActiveCanvasScene(scene)
  ) return false;

  const sourceWasStealthed = isActorStealthed(sourceActor);
  const sourcePosition = getTokenSwapPosition(sourceToken);
  const phantomPosition = getTokenSwapPosition(phantomToken);
  const swapped = await moveDanceTokensAsDisplacement(scene, sourceToken, phantomToken, {
    sourcePosition,
    phantomPosition
  });
  if (!swapped) return false;

  if (sourceWasStealthed) {
    try {
      await synchronizeStealthMovementStateAfterRelocation(sourceToken, { skipEntryDetection: true });
    } catch (error) {
      console.error(`${SYSTEM_ID} | Failed to synchronize stealth after a phantom swap`, error);
      await moveDanceTokensAsDisplacement(scene, sourceToken, phantomToken, {
        sourcePosition: phantomPosition,
        phantomPosition: sourcePosition
      });
      return false;
    }
  }
  return true;
}

export function findActiveDanceEffect(actor = null) {
  const now = Number(game.time?.worldTime) || 0;
  return Array.from(actor?.effects ?? []).find(effect => {
    const data = getDanceEffectData(effect);
    if (!data || effect.disabled || effect.duration?.expired === true) return false;
    const expiresAt = Number(data.expiresAt);
    return !Number.isFinite(expiresAt) || expiresAt > now;
  }) ?? null;
}

export function getDanceEffectData(effect = null) {
  return effect?.getFlag?.(SYSTEM_ID, DANCE_OF_THOUSAND_SHADOWS_EFFECT_FLAG_KEY)
    ?? effect?.flags?.[SYSTEM_ID]?.[DANCE_OF_THOUSAND_SHADOWS_EFFECT_FLAG_KEY]
    ?? effect?._source?.flags?.[SYSTEM_ID]?.[DANCE_OF_THOUSAND_SHADOWS_EFFECT_FLAG_KEY]
    ?? null;
}

export function getDancePhantomData(document = null) {
  return document?.getFlag?.(SYSTEM_ID, DANCE_OF_THOUSAND_SHADOWS_PHANTOM_FLAG_KEY)
    ?? document?.flags?.[SYSTEM_ID]?.[DANCE_OF_THOUSAND_SHADOWS_PHANTOM_FLAG_KEY]
    ?? document?._source?.flags?.[SYSTEM_ID]?.[DANCE_OF_THOUSAND_SHADOWS_PHANTOM_FLAG_KEY]
    ?? null;
}

export function getDancePhantomTokens(effectOrData = null) {
  const data = getDanceEffectData(effectOrData) ?? effectOrData;
  const sessionId = String(data?.sessionId ?? "").trim();
  const scene = game.scenes?.get(String(data?.sceneId ?? ""));
  if (!sessionId || !scene) return [];
  return (scene.tokens?.contents ?? []).filter(token => getDancePhantomData(token)?.sessionId === sessionId);
}

export function buildDanceKillChanges(settings = {}, stacks = 0) {
  const normalized = normalizeRuntimeSettings(settings);
  const count = Math.max(0, toInteger(stacks));
  if (!count) return [];
  return [
    createAddChange("system.skills.stealth.bonus", count * normalized.stealthBonusPerKill),
    createAddChange("system.combat.damagePercent", count * normalized.damagePercentPerKill),
    createAddChange("system.combat.criticalChance", count * normalized.criticalChancePerKill)
  ].filter(change => Number(change.value) !== 0);
}

export async function reconcileDancePhantoms(effect = null, { round = 0 } = {}) {
  const data = getDanceEffectData(effect);
  if (!game.user?.isGM || !data || !isDanceEffectCurrent(effect)) return false;
  const scene = game.scenes?.get(String(data.sceneId ?? ""));
  const sourceToken = fromUuidSync(String(data.sourceTokenUuid ?? ""));
  const sourceActor = fromUuidSync(String(data.sourceActorUuid ?? ""));
  const phantomActor = fromUuidSync(String(data.phantomActorUuid ?? ""));
  if (
    !scene
    || !sourceToken?.actor
    || sourceToken.actor.uuid !== sourceActor?.uuid
    || !phantomActor
    || !isActiveCanvasScene(scene)
    || !sourceToken.object
  ) return false;

  const settings = normalizeRuntimeSettings(data.settings);
  const anchors = collectDanceAnchorTokens(scene, sourceToken, settings.radiusMeters);
  const existing = getDancePhantomTokens(data);
  const staleIds = existing.map(token => token.id);

  const occupancy = collectOccupiedTokenRects(
    scene,
    data.sessionId,
    sourceToken?._source?.level ?? sourceToken.level
  );
  const creates = [];
  for (const anchor of anchors) {
    const placement = findDancePhantomPlacement({
      sourceToken,
      anchorToken: anchor,
      occupancy,
      variation: `${data.sessionId}:${round}:${anchor.uuid}`
    });
    if (!placement) continue;
    occupancy.push(placement.rect);
    const tokenData = {
      ...data,
      anchorTokenUuid: anchor.uuid
    };
    creates.push(buildDancePhantomTokenData(sourceToken, phantomActor, tokenData, placement));
  }

  if (staleIds.length) await scene.deleteEmbeddedDocuments("Token", staleIds, { animate: false, [DANCE_CLEANUP_OPTION]: true });
  if (creates.length) await scene.createEmbeddedDocuments("Token", creates, { animate: false });
  return true;
}

export function findDancePhantomPlacement({
  sourceToken = null,
  anchorToken = null,
  occupancy = [],
  variation = ""
} = {}) {
  const sourceObject = sourceToken?.object;
  const anchorObject = anchorToken?.object;
  const grid = canvas?.grid;
  if (!sourceObject || !anchorObject || !grid) return null;

  const size = getTokenPixelSize(sourceToken);
  for (const candidates of buildPlacementCandidateRings(sourceToken, anchorToken, MAX_PLACEMENT_RINGS)) {
    const valid = candidates
      .map(position => validatePlacementCandidate({ sourceToken, anchorToken, position, size, occupancy }))
      .filter(Boolean);
    if (!valid.length) continue;
    valid.sort((left, right) => (
      right.clearance - left.clearance
      || compareVariedPlacement(left, right, variation)
    ));
    return valid[0];
  }
  return null;
}

function buildDancePhantomActorData(sourceActor, data) {
  const actorData = buildPhantomActorData(sourceActor, data);
  delete actorData.flags?.[SYSTEM_ID]?.[PHANTOM_FLAG_KEY];
  actorData.name = `${sourceActor?.name ?? "Актёр"} — Тень`;
  actorData.flags[SYSTEM_ID][DANCE_OF_THOUSAND_SHADOWS_PHANTOM_FLAG_KEY] = cloneData(data);
  return actorData;
}

function buildDancePhantomTokenData(sourceToken, phantomActor, data, placement) {
  const tokenData = buildPhantomTokenData(sourceToken, phantomActor, data);
  delete tokenData.flags?.[SYSTEM_ID]?.[PHANTOM_FLAG_KEY];
  tokenData.name = `${sourceToken?.name ?? sourceToken?.actor?.name ?? "Актёр"} — Тень`;
  tokenData.x = placement.x;
  tokenData.y = placement.y;
  tokenData.elevation = placement.elevation;
  tokenData.level = placement.level;
  tokenData.flags[SYSTEM_ID][DANCE_OF_THOUSAND_SHADOWS_PHANTOM_FLAG_KEY] = cloneData(data);
  return tokenData;
}

function collectDanceAnchorTokens(scene, sourceToken, radiusMeters) {
  const sourceObject = sourceToken.object;
  const sourceLevel = String(sourceToken?._source?.level ?? sourceToken?.level ?? "");
  return (scene.tokens?.contents ?? [])
    .filter(token => {
      if (!token?.actor || isPhantomEntity(token)) return false;
      if (String(token?._source?.level ?? token?.level ?? "") !== sourceLevel) return false;
      const object = token.object;
      if (!object) return false;
      if (token.id === sourceToken.id) return true;
      return measureTokenDistanceMeters(sourceObject, object) <= radiusMeters
        && hasAuraLineOfSight(sourceObject, object);
    })
    .sort((left, right) => String(left.uuid).localeCompare(String(right.uuid)));
}

function collectOccupiedTokenRects(scene, ignoredSessionId = "", level = "") {
  const requestedLevel = String(level ?? "");
  return (scene.tokens?.contents ?? [])
    .filter(token => (
      token?.actor
      && getDancePhantomData(token)?.sessionId !== ignoredSessionId
      && String(token?._source?.level ?? token?.level ?? "") === requestedLevel
    ))
    .map(token => getTokenRect(token));
}

function* buildPlacementCandidateRings(sourceToken, anchorToken, maxRings) {
  const grid = canvas.grid;
  if (grid.isGridless) {
    const center = anchorToken.getCenterPoint();
    const step = Math.max(1, Number(grid.size) || 100);
    const sourceSize = getTokenPixelSize(sourceToken);
    for (let ring = 1; ring <= maxRings; ring += 1) {
      const radius = ring * step;
      const candidates = [];
      for (let index = 0; index < GRIDLESS_DIRECTIONS; index += 1) {
        const angle = index * Math.PI * 2 / GRIDLESS_DIRECTIONS;
        candidates.push({
          x: center.x + Math.cos(angle) * radius - sourceSize.width / 2,
          y: center.y + Math.sin(angle) * radius - sourceSize.height / 2,
          elevation: Number(anchorToken.elevation) || 0,
          level: anchorToken?._source?.level ?? anchorToken.level
        });
      }
      yield candidates;
    }
    return;
  }

  let frontier = [grid.getOffset(anchorToken.getCenterPoint())];
  const visited = new Set(frontier.map(offsetKey));
  for (let ring = 1; ring <= maxRings; ring += 1) {
    const next = [];
    for (const offset of frontier) {
      for (const adjacent of grid.getAdjacentOffsets(offset) ?? []) {
        const key = offsetKey(adjacent);
        if (visited.has(key)) continue;
        visited.add(key);
        next.push(adjacent);
      }
    }
    frontier = next;
    yield frontier.map(offset => offsetToTokenPosition(grid, sourceToken, anchorToken, offset));
  }
}

function offsetToTokenPosition(grid, sourceToken, anchorToken, offset) {
  const center = grid.getCenterPoint(offset);
  const pivot = sourceToken.getCenterPoint({
    x: 0,
    y: 0,
    width: sourceToken.width,
    height: sourceToken.height,
    depth: sourceToken.depth,
    shape: sourceToken.shape
  });
  const raw = {
    x: center.x - pivot.x,
    y: center.y - pivot.y,
    elevation: Number(anchorToken.elevation) || 0,
    level: anchorToken?._source?.level ?? anchorToken.level
  };
  const snapped = sourceToken.getSnappedPosition?.(raw) ?? raw;
  return { ...raw, x: Math.round(snapped.x), y: Math.round(snapped.y) };
}

function validatePlacementCandidate({ sourceToken, anchorToken, position, size, occupancy }) {
  const rect = { x: position.x, y: position.y, width: size.width, height: size.height };
  if (!isRectInsideScene(rect)) return null;
  if (occupancy.some(other => rectanglesOverlap(rect, other))) return null;

  const origin = anchorToken.getCenterPoint({ elevation: position.elevation });
  const destination = sourceToken.getCenterPoint({
    x: position.x,
    y: position.y,
    elevation: position.elevation,
    width: sourceToken.width,
    height: sourceToken.height,
    depth: sourceToken.depth,
    shape: sourceToken.shape
  });
  if (sourceToken.object.checkCollision(destination, { origin, type: "move", mode: "any" })) return null;
  const sourceOrigin = sourceToken.getCenterPoint();
  if (sourceToken.object.checkCollision(destination, { origin: sourceOrigin, type: "sight", mode: "any" })) return null;
  return {
    ...position,
    rect,
    clearance: getPlacementClearance(rect, occupancy)
  };
}

function getPlacementClearance(rect, occupancy) {
  if (!occupancy.length) return Number.MAX_SAFE_INTEGER;
  return Math.min(...occupancy.map(other => rectangleGap(rect, other)));
}

function rectangleGap(left, right) {
  const dx = Math.max(0, Math.max(left.x - (right.x + right.width), right.x - (left.x + left.width)));
  const dy = Math.max(0, Math.max(left.y - (right.y + right.height), right.y - (left.y + left.height)));
  return Math.hypot(dx, dy);
}

function rectanglesOverlap(left, right) {
  const epsilon = 1;
  return left.x < right.x + right.width - epsilon
    && left.x + left.width > right.x + epsilon
    && left.y < right.y + right.height - epsilon
    && left.y + left.height > right.y + epsilon;
}

function isRectInsideScene(rect) {
  const bounds = canvas?.dimensions?.sceneRect ?? canvas?.dimensions?.rect;
  if (!bounds) return true;
  return rect.x >= bounds.x
    && rect.y >= bounds.y
    && rect.x + rect.width <= bounds.x + bounds.width
    && rect.y + rect.height <= bounds.y + bounds.height;
}

function getTokenRect(token) {
  const bounds = token?.object?.bounds;
  if (bounds) return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  const size = getTokenPixelSize(token);
  return { x: Number(token?.x) || 0, y: Number(token?.y) || 0, ...size };
}

function getTokenPixelSize(token) {
  const gridSize = Math.max(1, Number(canvas?.grid?.size) || 100);
  return {
    width: Math.max(1, Number(token?.object?.bounds?.width) || (Number(token?.width) || 1) * gridSize),
    height: Math.max(1, Number(token?.object?.bounds?.height) || (Number(token?.height) || 1) * gridSize)
  };
}

function getTokenSwapPosition(token) {
  return {
    x: Number(token.x) || 0,
    y: Number(token.y) || 0,
    elevation: Number(token.elevation) || 0,
    level: token?._source?.level ?? token.level
  };
}

async function moveDanceTokensAsDisplacement(scene, sourceToken, phantomToken, {
  sourcePosition,
  phantomPosition
} = {}) {
  const results = await scene.moveTokens({
    [sourceToken.id]: {
      destination: { ...phantomPosition, action: "displace" }
    },
    [phantomToken.id]: {
      destination: { ...sourcePosition, action: "displace" }
    }
  }, {
    animate: false,
    showRuler: false,
    [SYSTEM_RELOCATION_OPTION]: true
  });
  return results?.[sourceToken.id] === true && results?.[phantomToken.id] === true;
}

async function processDanceRoundStart({ combat = null, round = 0 } = {}) {
  if (!game.user?.isActiveGM || !combat?.started || !canvas?.ready || !canvas.scene) return;
  const combatScenes = collectDanceCombatScenes(combat);
  if (!combatScenes.has(canvas.scene.id)) return;
  const effects = collectActiveDanceEffects()
    .filter(effect => getDanceEffectData(effect)?.sceneId === canvas.scene.id);
  for (const effect of effects) {
    try {
      await reconcileDancePhantoms(effect, { round });
    } catch (error) {
      console.error(`${SYSTEM_ID} | Dance phantom round refresh failed`, error);
    }
  }
}

function collectDanceCombatScenes(combat) {
  const scenes = new Map();
  const addScene = sceneOrId => {
    const scene = typeof sceneOrId === "string" ? game.scenes?.get(sceneOrId) : sceneOrId;
    if (scene?.id) scenes.set(scene.id, scene);
  };
  addScene(combat?.scene);
  for (const combatant of combat?.combatants ?? []) addScene(combatant?.sceneId);
  if (!scenes.size && game.combat?.id === combat?.id) addScene(canvas.scene);
  return scenes;
}

async function processDanceDamageResults({ results = [] } = {}) {
  if (!game.user?.isActiveGM) return;
  const phantomTokenUuids = new Set();
  const killsByEffect = new Map();
  for (const result of results.flat(Infinity).filter(Boolean)) {
    if (result.mode && result.mode !== "damage") continue;
    const targetActor = resolveDamageResultActor(result);
    const phantomData = getDancePhantomData(targetActor) ?? getDancePhantomData(targetActor?.parent?.baseActor);
    if (phantomData) {
      if (result.phantomDestroyed !== true) continue;
      if (isWeaponAttackDamageResult(result)) continue;
      const tokenUuid = String(targetActor?.token?.uuid ?? result.source?.targetTokenUuid ?? "").trim();
      if (tokenUuid) phantomTokenUuids.add(tokenUuid);
      continue;
    }
    if (!isDamageResultKill(result, targetActor)) continue;
    const attackerUuid = String(
      result.source?.attackerUuid
      ?? result.source?.attackerActorUuid
      ?? result.source?.sourceActorUuid
      ?? ""
    ).trim();
    const attacker = attackerUuid ? fromUuidSync(attackerUuid) : null;
    const effect = findActiveDanceEffect(attacker);
    if (!effect) continue;
    const targetKey = String(targetActor?.token?.uuid ?? targetActor?.uuid ?? result.actorUuid ?? "").trim();
    if (!targetKey) continue;
    const targets = killsByEffect.get(effect.uuid) ?? { effect, targetKeys: new Set() };
    targets.targetKeys.add(targetKey);
    killsByEffect.set(effect.uuid, targets);
  }

  if (phantomTokenUuids.size) {
    void deleteDamagedDancePhantoms(phantomTokenUuids).catch(error => {
      console.error(`${SYSTEM_ID} | Dance phantom cleanup failed`, error);
    });
  }
  for (const { effect, targetKeys } of killsByEffect.values()) {
    await addDanceKills(effect, targetKeys);
  }
}

async function processDanceWeaponAttackTerminal({ damageResults = [] } = {}) {
  if (!game.user?.isActiveGM) return;
  const phantomTokenUuids = new Set();
  for (const result of damageResults.flat(Infinity).filter(Boolean)) {
    if (result.phantomDestroyed !== true || !isWeaponAttackDamageResult(result)) continue;
    const targetActor = resolveDamageResultActor(result);
    const phantomData = getDancePhantomData(targetActor) ?? getDancePhantomData(targetActor?.parent?.baseActor);
    if (!phantomData) continue;
    const tokenUuid = String(targetActor?.token?.uuid ?? result.source?.targetTokenUuid ?? "").trim();
    if (tokenUuid) phantomTokenUuids.add(tokenUuid);
  }
  if (phantomTokenUuids.size) await deleteDamagedDancePhantoms(phantomTokenUuids);
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

async function deleteDamagedDancePhantoms(tokenUuids = []) {
  const tokenIdsByScene = new Map();
  for (const tokenUuid of tokenUuids) {
    const token = fromUuidSync(String(tokenUuid ?? ""));
    const scene = token?.parent;
    if (!token?.id || token.documentName !== "Token" || !scene?.id || !getDancePhantomData(token)) continue;
    const tokenIds = tokenIdsByScene.get(scene) ?? [];
    tokenIds.push(token.id);
    tokenIdsByScene.set(scene, tokenIds);
  }
  for (const [scene, tokenIds] of tokenIdsByScene) {
    await scene.deleteEmbeddedDocuments("Token", tokenIds, {
      animate: false,
      [DANCE_CLEANUP_OPTION]: true
    });
  }
}

async function addDanceKills(effect, targetKeys) {
  const data = getDanceEffectData(effect);
  if (!data || !isDanceEffectCurrent(effect)) return false;
  const kills = new Set((Array.isArray(data.killTargetUuids) ? data.killTargetUuids : []).map(String));
  const before = kills.size;
  for (const key of targetKeys) kills.add(String(key));
  if (kills.size === before) return false;
  const nextData = { ...data, killTargetUuids: [...kills] };
  await effect.update({
    [`flags.${SYSTEM_ID}.${DANCE_OF_THOUSAND_SHADOWS_EFFECT_FLAG_KEY}`]: nextData,
    "system.changes": buildDanceKillChanges(data.settings, kills.size)
  });
  return true;
}

function isDamageResultKill(result, actor) {
  const damage = Math.max(0, Number(result?.healthDelta) || 0) + Math.max(0, Number(result?.limbDelta) || 0);
  if (!actor || damage <= 0) return false;
  if (actor.statuses?.has?.("dead")) return true;
  const resultValue = Number(result?.healthValue);
  const resultMin = Number(result?.healthMin);
  if (Number.isFinite(resultValue) && Number.isFinite(resultMin) && resultValue <= resultMin) return true;
  const health = actor.system?.resources?.health;
  return Boolean(health) && Number(health.value) <= Number(health.min);
}

async function cleanupDanceSession(data = {}) {
  const sessionId = String(data.sessionId ?? "").trim();
  if (!game.user?.isActiveGM || !sessionId || pendingSessionCleanup.has(sessionId)) return false;
  pendingSessionCleanup.add(sessionId);
  try {
    const scene = game.scenes?.get(String(data.sceneId ?? ""));
    const tokenIds = (scene?.tokens?.contents ?? [])
      .filter(token => getDancePhantomData(token)?.sessionId === sessionId)
      .map(token => token.id);
    if (tokenIds.length) {
      await scene.deleteEmbeddedDocuments("Token", tokenIds, { animate: false, [DANCE_CLEANUP_OPTION]: true });
    }
    const phantomActor = fromUuidSync(String(data.phantomActorUuid ?? ""));
    const baseActor = phantomActor?.parent?.baseActor ?? phantomActor;
    if (baseActor?.id && game.actors?.get(baseActor.id)) {
      await baseActor.delete({ [DANCE_CLEANUP_OPTION]: true });
    }
    return true;
  } finally {
    pendingSessionCleanup.delete(sessionId);
  }
}

function collectActiveDanceEffects() {
  const effects = [];
  const actors = new Map();
  for (const actor of game.actors?.contents ?? []) actors.set(actor.uuid, actor);
  for (const token of canvas?.tokens?.placeables ?? []) {
    if (token?.actor?.uuid) actors.set(token.actor.uuid, token.actor);
  }
  for (const actor of actors.values()) {
    const effect = findActiveDanceEffect(actor);
    if (effect) effects.push(effect);
  }
  return effects;
}

function findDanceEffectBySessionId(sessionId = "") {
  const requested = String(sessionId).trim();
  return collectActiveDanceEffects().find(effect => getDanceEffectData(effect)?.sessionId === requested) ?? null;
}

function findDanceEffectBySourceTokenUuid(tokenUuid = "") {
  const requested = String(tokenUuid).trim();
  return collectActiveDanceEffects().find(effect => getDanceEffectData(effect)?.sourceTokenUuid === requested) ?? null;
}

function isDanceEffectCurrent(effect) {
  if (!effect || effect.disabled || effect.duration?.expired === true) return false;
  const expiresAt = Number(getDanceEffectData(effect)?.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt > (Number(game.time?.worldTime) || 0);
}

function getDancePhantomTargetAlpha(token, baseAlpha = 1) {
  const data = getDancePhantomData(token?.document ?? token);
  if (!data) return baseAlpha;
  const sourceToken = fromUuidSync(String(data.sourceTokenUuid ?? ""));
  const sourceActor = sourceToken?.actor ?? fromUuidSync(String(data.sourceActorUuid ?? ""));
  return localViewRecognizesPhantom(sourceActor)
    ? Math.min(baseAlpha, DANCE_ALLY_ALPHA)
    : baseAlpha;
}

function refreshDancePhantomAlpha(token) {
  const object = token?.object ?? token;
  if (getDancePhantomData(object?.document ?? object)) object?.renderFlags?.set?.({ refreshState: true });
}

function refreshAllDancePhantomAlpha() {
  for (const token of canvas?.tokens?.placeables ?? []) refreshDancePhantomAlpha(token);
}

function isActiveCanvasScene(scene) {
  return Boolean(canvas?.ready && scene?.id && canvas.scene?.id === scene.id);
}

function normalizeRuntimeSettings(value = {}) {
  return {
    durationSeconds: Math.max(1, toInteger(value.durationSeconds, 18)),
    radiusMeters: Math.max(0, toNumber(value.radiusMeters, 20)),
    stealthBonusPerKill: toNumber(value.stealthBonusPerKill, 10),
    damagePercentPerKill: toNumber(value.damagePercentPerKill, 5),
    criticalChancePerKill: toNumber(value.criticalChancePerKill, 2)
  };
}

function createAddChange(key, value) {
  return {
    key,
    type: "add",
    value: String(value),
    phase: "initial",
    priority: null
  };
}

function compareVariedPlacement(left, right, variation) {
  return hashString(`${variation}:${left.x}:${left.y}`) - hashString(`${variation}:${right.x}:${right.y}`);
}

function hashString(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function offsetKey(offset) {
  return `${offset?.i ?? ""}:${offset?.j ?? ""}:${offset?.k ?? ""}`;
}

function toInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cloneData(value) {
  return foundry.utils.deepClone(value);
}
