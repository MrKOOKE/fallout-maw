import { SYSTEM_ID } from "../constants.mjs";

const POSTURE_MOVEMENT_FLAG = "postureMovement";
const ACTIVE_EFFECT_SHOW_ICON_ALWAYS = 2;
const DEPTH_EPSILON = 0.001;

const SELECTABLE_MOVEMENT_ACTIONS = new Set(["walk", "crawl", "burrow", "displace"]);
const POSTURE_ACTIONS = Object.freeze({
  crawl: Object.freeze({
    factor: 0.5,
    label: "FALLOUTMAW.Movement.Crouch",
    icon: "fa-solid fa-person-praying",
    img: "icons/svg/leg.svg"
  }),
  burrow: Object.freeze({
    factor: 0.2,
    label: "FALLOUTMAW.Movement.Prone",
    icon: "fa-solid fa-person-falling",
    img: "icons/svg/down.svg"
  })
});

export function registerPostureMovementHooks() {
  configureTokenMovementActions();
  Hooks.on("preUpdateToken", onPreUpdateTokenPostureMovement);
  Hooks.on("updateToken", onUpdateTokenPostureMovement);
  Hooks.on("canvasReady", () => void syncScenePostureMovement());
}

function configureTokenMovementActions() {
  const movement = CONFIG.Token?.movement;
  if (!movement?.actions) return;

  movement.defaultAction = "walk";
  for (const action of Object.keys(movement.actions)) {
    if (!SELECTABLE_MOVEMENT_ACTIONS.has(action)) delete movement.actions[action];
  }

  foundry.utils.mergeObject(movement.actions.walk, {
    label: "FALLOUTMAW.Movement.Walk",
    icon: "fa-solid fa-person-walking",
    img: "icons/svg/walk.svg",
    order: 0
  }, { inplace: true });

  for (const [action, config] of Object.entries(POSTURE_ACTIONS)) {
    if (!movement.actions[action]) continue;
    foundry.utils.mergeObject(movement.actions[action], {
      label: config.label,
      icon: config.icon,
      img: config.img,
      order: action === "crawl" ? 1 : 2,
      terrainAction: "walk"
    }, { inplace: true });
  }

  if (movement.actions.displace) movement.actions.displace.order = 99;
}

function onPreUpdateTokenPostureMovement(tokenDocument, changes, _options, userId) {
  if (game.user?.id && userId && game.user.id !== userId) return;
  if (!foundry.utils.hasProperty(changes, "movementAction")) return;

  const nextAction = normalizeMovementAction(foundry.utils.getProperty(changes, "movementAction"));
  const previousAction = normalizeMovementAction(tokenDocument?._source?.movementAction);
  const baseDepth = getPostureBaseDepth(tokenDocument, previousAction);
  const nextDepth = getDepthForMovementAction(baseDepth, nextAction);
  if (!Number.isFinite(nextDepth) || nextDepth <= 0) return;

  foundry.utils.setProperty(changes, "depth", nextDepth);
  foundry.utils.setProperty(changes, `flags.${SYSTEM_ID}.${POSTURE_MOVEMENT_FLAG}.baseDepth`, baseDepth);
}

function onUpdateTokenPostureMovement(tokenDocument, changes, _options, userId) {
  if (game.user?.id && userId && game.user.id !== userId && !game.user?.isActiveGM) return;
  if (!foundry.utils.hasProperty(changes, "movementAction")) return;
  void syncTokenPostureEffect(tokenDocument);
}

async function syncScenePostureMovement() {
  if (!game.user?.isActiveGM) return;
  for (const token of canvas?.tokens?.placeables ?? []) {
    await syncTokenPostureDocument(token.document);
    await syncTokenPostureEffect(token.document);
  }
}

async function syncTokenPostureDocument(tokenDocument) {
  if (!tokenDocument?.id) return;
  const action = normalizeMovementAction(tokenDocument._source?.movementAction);
  const baseDepth = getPostureBaseDepth(tokenDocument, action);
  const expectedDepth = getDepthForMovementAction(baseDepth, action);
  if (!Number.isFinite(expectedDepth) || expectedDepth <= 0) return;
  if (Math.abs((Number(tokenDocument.depth) || 0) - expectedDepth) <= DEPTH_EPSILON) return;

  await tokenDocument.update({
    depth: expectedDepth,
    [`flags.${SYSTEM_ID}.${POSTURE_MOVEMENT_FLAG}.baseDepth`]: baseDepth
  });
}

async function syncTokenPostureEffect(tokenDocument) {
  const actor = tokenDocument?.actor;
  if (!actor?.isOwner) return;

  const action = normalizeMovementAction(tokenDocument?._source?.movementAction);
  const posture = POSTURE_ACTIONS[action] ?? null;
  const existing = actor.effects.filter(effect => effect.getFlag(SYSTEM_ID, POSTURE_MOVEMENT_FLAG));

  if (!posture) {
    if (existing.length) await actor.deleteEmbeddedDocuments("ActiveEffect", existing.map(effect => effect.id));
    return;
  }

  const signature = JSON.stringify({ action, tokenUuid: tokenDocument.uuid });
  const current = existing.find(effect => effect.getFlag(SYSTEM_ID, POSTURE_MOVEMENT_FLAG)?.signature === signature);
  const obsolete = existing.filter(effect => effect.id !== current?.id).map(effect => effect.id);
  if (obsolete.length) await actor.deleteEmbeddedDocuments("ActiveEffect", obsolete);

  const data = buildPostureEffectData(tokenDocument, action, posture, signature);
  if (current) {
    const update = getEffectUpdateData(current, data);
    if (Object.keys(update).length) await current.update(update);
    return;
  }

  await actor.createEmbeddedDocuments("ActiveEffect", [data]);
}

function buildPostureEffectData(tokenDocument, action, posture, signature) {
  return {
    type: "base",
    name: game.i18n.localize(posture.label),
    img: posture.img,
    origin: tokenDocument.uuid,
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    system: { changes: [] },
    flags: {
      core: {
        overlay: true
      },
      [SYSTEM_ID]: {
        kind: "posture",
        [POSTURE_MOVEMENT_FLAG]: {
          action,
          tokenUuid: tokenDocument.uuid,
          signature
        }
      }
    }
  };
}

function getEffectUpdateData(effect, data) {
  const update = {};
  for (const key of ["name", "img", "origin", "transfer", "disabled", "showIcon"]) {
    if (effect[key] !== data[key]) update[key] = data[key];
  }
  const currentData = effect.getFlag(SYSTEM_ID, POSTURE_MOVEMENT_FLAG) ?? {};
  const nextData = data.flags[SYSTEM_ID][POSTURE_MOVEMENT_FLAG];
  if (JSON.stringify(currentData) !== JSON.stringify(nextData)) {
    update[`flags.${SYSTEM_ID}.${POSTURE_MOVEMENT_FLAG}`] = nextData;
  }
  if (effect.getFlag("core", "overlay") !== true) update["flags.core.overlay"] = true;
  return update;
}

function getPostureBaseDepth(tokenDocument, previousAction) {
  const flaggedDepth = Number(tokenDocument?.getFlag?.(SYSTEM_ID, POSTURE_MOVEMENT_FLAG)?.baseDepth);
  if (isPostureMovementAction(previousAction) && Number.isFinite(flaggedDepth) && flaggedDepth > 0) return flaggedDepth;

  const currentDepth = Number(tokenDocument?._source?.depth ?? tokenDocument?.depth);
  return Number.isFinite(currentDepth) && currentDepth > 0 ? currentDepth : 1;
}

function getDepthForMovementAction(baseDepth, action) {
  const factor = POSTURE_ACTIONS[action]?.factor ?? 1;
  return roundDepth(Math.max(0.01, baseDepth * factor));
}

function roundDepth(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000;
}

function isPostureMovementAction(action) {
  return Object.hasOwn(POSTURE_ACTIONS, action);
}

function normalizeMovementAction(action) {
  const value = String(action ?? "").trim();
  return value || "walk";
}
