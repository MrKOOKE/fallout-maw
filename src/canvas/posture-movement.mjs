import { SYSTEM_ID } from "../constants.mjs";
import { getTokenActionHudIcons } from "../settings/accessors.mjs";

export const POSTURE_CHANGE_ACTION_POINT_COST = 3;
export const POSTURE_EFFECT_CHANGE_ROOT = "system.postures";

const POSTURE_MOVEMENT_FLAG = "postureMovement";
const ACTIVE_EFFECT_SHOW_ICON_ALWAYS = 2;
const DEPTH_EPSILON = 0.001;
const MOVEMENT_RESOURCE_KEY = "movementPoints";
const ACTION_RESOURCE_KEY = "actionPoints";
const MOVEMENT_RESOURCE_PREVIEW_HOOK = "falloutMawMovementResourcePreview";
const POSTURE_RESOURCE_SPENDING_FLAG = "postureResourceSpending";
const POSTURE_RESOURCE_SPENDING_LIMIT = 50;
const AUTOMATIC_POSTURE_OPTION = "falloutMawAutomaticPosture";

const POSTURE_ACTION_CONFIGS = Object.freeze({
  walk: Object.freeze({
    label: "FALLOUTMAW.Movement.Walk",
    icon: "fa-solid fa-person-walking",
    img: "icons/svg/walk.svg",
    depthFactor: 1,
    movementCostMultiplier: 1,
    weaponActionPointCostBonus: 0,
    speedMultiplier: 1,
    order: 0
  }),
  crawl: Object.freeze({
    label: "FALLOUTMAW.Movement.Crouch",
    icon: "fa-solid fa-person-praying",
    img: "icons/svg/leg.svg",
    depthFactor: 0.5,
    movementCostMultiplier: 2,
    weaponActionPointCostBonus: 0,
    speedMultiplier: 0.75,
    order: 1
  }),
  burrow: Object.freeze({
    label: "FALLOUTMAW.Movement.Prone",
    icon: "fa-solid fa-person-falling",
    img: "icons/svg/down.svg",
    depthFactor: 0.2,
    movementCostMultiplier: 3,
    weaponActionPointCostBonus: 0,
    speedMultiplier: 0.5,
    order: 2
  }),
  knocked: Object.freeze({
    label: "FALLOUTMAW.Movement.Knocked",
    icon: "fa-solid fa-person-falling-burst",
    img: "icons/svg/falling.svg",
    depthFactor: 0.2,
    movementCostMultiplier: 4,
    weaponActionPointCostBonus: 1,
    speedMultiplier: 0.5,
    order: 3
  })
});

const SELECTABLE_MOVEMENT_ACTIONS = new Set([...Object.keys(POSTURE_ACTION_CONFIGS), "displace"]);
const INCAPACITATING_STATUSES = new Set(["dead", "unconscious", "incapacitated"]);

export function registerPostureMovementHooks() {
  configureTokenMovementActions();
  Hooks.on("preUpdateToken", onPreUpdateTokenPostureMovement);
  Hooks.on("updateToken", onUpdateTokenPostureMovement);
  Hooks.on("renderTokenHUD", decorateTokenHudPosturePalette);
  Hooks.on("createActiveEffect", scheduleActorKnockdownFromEffect);
  Hooks.on("updateActiveEffect", scheduleActorKnockdownFromEffect);
  Hooks.on("updateActor", scheduleActorKnockdown);
  Hooks.on("canvasReady", () => void syncScenePostureMovement());
}

export function getPostureIconRows() {
  return Object.entries(POSTURE_ACTION_CONFIGS).map(([key, config]) => ({
    key,
    label: game.i18n.localize(config.label)
  }));
}

export function getActorPostureMovementCostMultiplier(actor) {
  const action = getActorPostureAction(actor);
  const base = Number(POSTURE_ACTION_CONFIGS[action]?.movementCostMultiplier) || 1;
  return Math.max(0, applyPostureNumberModifier(base, collectPostureNumberModifier(actor, action, "movementMultiplier")));
}

export function getActorPostureWeaponActionPointCostBonus(actor) {
  const action = getActorPostureAction(actor);
  const base = Number(POSTURE_ACTION_CONFIGS[action]?.weaponActionPointCostBonus) || 0;
  return applyPostureNumberModifier(base, collectPostureNumberModifier(actor, action, "weaponActionCost"));
}

export function getActorPostureAction(actor) {
  return normalizeMovementAction(getActorPostureEffectData(actor)?.action);
}

function configureTokenMovementActions() {
  const movement = CONFIG.Token?.movement;
  if (!movement?.actions) return;

  movement.defaultAction = "walk";
  for (const action of Object.keys(movement.actions)) {
    if (!SELECTABLE_MOVEMENT_ACTIONS.has(action)) delete movement.actions[action];
  }

  for (const [action, config] of Object.entries(POSTURE_ACTION_CONFIGS)) {
    movement.actions[action] ??= {};
    const update = {
      label: config.label,
      icon: config.icon,
      img: getConfiguredPostureIcon(action),
      order: config.order,
      speedMultiplier: config.speedMultiplier,
      costMultiplier: 1
    };
    if (action !== "walk") update.terrainAction = "walk";
    foundry.utils.mergeObject(movement.actions[action], update, { inplace: true });
  }

  if (movement.actions.displace) movement.actions.displace.order = 99;
}

function onPreUpdateTokenPostureMovement(tokenDocument, changes, options, userId) {
  if (game.user?.id && userId && game.user.id !== userId) return;
  if (!foundry.utils.hasProperty(changes, "movementAction")) return;

  const nextAction = normalizeMovementAction(foundry.utils.getProperty(changes, "movementAction"));
  const previousAction = normalizeMovementAction(tokenDocument?._source?.movementAction);
  const baseDepth = getPostureBaseDepth(tokenDocument, previousAction);
  const nextDepth = getDepthForMovementAction(baseDepth, nextAction);
  if (!Number.isFinite(nextDepth) || nextDepth <= 0) return;

  const changeCost = getPostureChangeResourceCost(tokenDocument, previousAction, nextAction, options);
  if (changeCost > 0) {
    if (!canSpendPostureChangeResources(tokenDocument?.actor, changeCost)) {
      ui.notifications.warn(`${tokenDocument?.actor?.name ?? ""}: не хватает ОП/ОД для смены положения (${changeCost}).`);
      return false;
    }
    foundry.utils.setProperty(changes, `flags.${SYSTEM_ID}.${POSTURE_MOVEMENT_FLAG}.pendingChangeCost`, {
      id: foundry.utils.randomID(),
      amount: changeCost,
      previousAction,
      nextAction,
      userId
    });
  }

  foundry.utils.setProperty(changes, "depth", nextDepth);
  foundry.utils.setProperty(changes, `flags.${SYSTEM_ID}.${POSTURE_MOVEMENT_FLAG}.baseDepth`, baseDepth);
}

function onUpdateTokenPostureMovement(tokenDocument, changes, options, userId) {
  if (game.user?.id && userId && game.user.id !== userId && !game.user?.isActiveGM) return;
  if (!foundry.utils.hasProperty(changes, "movementAction")) return;
  void syncTokenPostureEffect(tokenDocument);
  const isRequestingUser = !game.user?.id || !userId || game.user.id === userId;
  if (options?.isUndo) {
    if (isRequestingUser) void restoreLastPostureChangeResources(tokenDocument);
  } else if (isRequestingUser) {
    void spendPendingPostureChangeCost(tokenDocument);
  }
}

async function syncScenePostureMovement() {
  if (!game.user?.isActiveGM) return;
  for (const token of canvas?.tokens?.placeables ?? []) {
    await syncTokenPostureDocument(token.document);
    await syncTokenPostureEffect(token.document);
    await knockdownTokenIfActorIncapacitated(token.document);
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
  const posture = isPostureEffectAction(action) ? POSTURE_ACTION_CONFIGS[action] : null;
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
    img: getConfiguredPostureIcon(action),
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

async function spendPendingPostureChangeCost(tokenDocument) {
  const pending = tokenDocument?.getFlag?.(SYSTEM_ID, POSTURE_MOVEMENT_FLAG)?.pendingChangeCost;
  if (!pending?.amount) return;
  if (game.user?.id && pending.userId && game.user.id !== pending.userId) return;

  const amount = Math.max(0, toInteger(pending.amount));
  if (amount > 0) await spendPostureChangeResources(tokenDocument, amount, pending);

  await tokenDocument.update({
    [`flags.${SYSTEM_ID}.${POSTURE_MOVEMENT_FLAG}.-=pendingChangeCost`]: null
  }, { [AUTOMATIC_POSTURE_OPTION]: true });
}

function getPostureBaseDepth(tokenDocument, previousAction) {
  const flaggedDepth = Number(tokenDocument?.getFlag?.(SYSTEM_ID, POSTURE_MOVEMENT_FLAG)?.baseDepth);
  if (isPostureEffectAction(previousAction) && Number.isFinite(flaggedDepth) && flaggedDepth > 0) return flaggedDepth;

  const currentDepth = Number(tokenDocument?._source?.depth ?? tokenDocument?.depth);
  return Number.isFinite(currentDepth) && currentDepth > 0 ? currentDepth : 1;
}

function getDepthForMovementAction(baseDepth, action) {
  const factor = POSTURE_ACTION_CONFIGS[action]?.depthFactor ?? 1;
  return roundDepth(Math.max(0.01, baseDepth * factor));
}

function getPostureChangeResourceCost(tokenDocument, previousAction, nextAction, options = {}) {
  if (options?.[AUTOMATIC_POSTURE_OPTION]) return 0;
  if (options?.isUndo) return 0;
  if (!game.combat) return 0;
  if (!tokenDocument?.actor) return 0;
  if (previousAction === nextAction) return 0;
  if (!POSTURE_ACTION_CONFIGS[previousAction] || !POSTURE_ACTION_CONFIGS[nextAction]) return 0;
  return POSTURE_CHANGE_ACTION_POINT_COST;
}

function canSpendPostureChangeResources(actor, amount) {
  const state = getPostureChangeResourceState(actor);
  if (!state) return true;
  return state.total >= amount;
}

async function spendPostureChangeResources(tokenDocument, amount, pending = {}) {
  const actor = tokenDocument?.actor;
  const state = getPostureChangeResourceState(actor);
  if (!state || !actor?.isOwner) return;

  const cost = Math.max(0, toInteger(amount));
  const movementSpend = Math.min(cost, state.movement.value);
  const actionSpend = Math.min(Math.max(0, cost - movementSpend), state.action.value);
  if (!movementSpend && !actionSpend) return;

  const updates = {};
  if (movementSpend) updates[`system.resources.${MOVEMENT_RESOURCE_KEY}.value`] = Math.max(0, state.movement.current - movementSpend);
  if (actionSpend) updates[`system.resources.${ACTION_RESOURCE_KEY}.value`] = Math.max(0, state.action.current - actionSpend);
  updates[`flags.${SYSTEM_ID}.${POSTURE_RESOURCE_SPENDING_FLAG}`] = [
    ...getPostureResourceSpendingStack(actor),
    createPostureResourceSpendingEntry(tokenDocument, pending, {
      [MOVEMENT_RESOURCE_KEY]: movementSpend,
      [ACTION_RESOURCE_KEY]: actionSpend
    })
  ].slice(-POSTURE_RESOURCE_SPENDING_LIMIT);
  await actor.update(updates);
}

async function restoreLastPostureChangeResources(tokenDocument) {
  const actor = tokenDocument?.actor;
  if (!actor?.isOwner) return;

  const stack = getPostureResourceSpendingStack(actor);
  const index = findLastPostureResourceSpendingIndex(stack, tokenDocument);
  if (index < 0) return;

  const entry = stack[index];
  const nextStack = stack.slice();
  nextStack.splice(index, 1);
  const updates = {
    [`flags.${SYSTEM_ID}.${POSTURE_RESOURCE_SPENDING_FLAG}`]: nextStack
  };

  for (const key of [MOVEMENT_RESOURCE_KEY, ACTION_RESOURCE_KEY]) {
    const resource = actor.system?.resources?.[key];
    if (!resource) continue;

    const current = toInteger(resource.value);
    const min = Math.max(0, toInteger(resource.min));
    const max = Math.max(min, toInteger(resource.max));
    const restored = Math.min(max, Math.max(min, current + Math.max(0, toInteger(entry?.resources?.[key]))));
    updates[`system.resources.${key}.value`] = restored;
    updates[`system.resources.${key}.spent`] = Math.max(0, max - restored);
  }

  await actor.update(updates);
}

function createPostureResourceSpendingEntry(tokenDocument, pending = {}, resources = {}) {
  return {
    id: pending.id || foundry.utils.randomID(),
    actorUuid: tokenDocument?.actor?.uuid ?? "",
    sceneId: tokenDocument?.parent?.id ?? tokenDocument?.scene?.id ?? "",
    tokenId: tokenDocument?.id ?? "",
    round: game.combat?.round ?? 0,
    resources,
    posture: {
      previousAction: normalizeMovementAction(pending.previousAction),
      nextAction: normalizeMovementAction(pending.nextAction)
    }
  };
}

function getPostureResourceSpendingStack(actor) {
  const stack = actor?.getFlag?.(SYSTEM_ID, POSTURE_RESOURCE_SPENDING_FLAG);
  return Array.isArray(stack) ? stack.filter(entry => entry && typeof entry === "object") : [];
}

function findLastPostureResourceSpendingIndex(stack, tokenDocument) {
  const actorUuid = tokenDocument?.actor?.uuid ?? "";
  const sceneId = tokenDocument?.parent?.id ?? tokenDocument?.scene?.id ?? "";
  const tokenId = tokenDocument?.id ?? "";
  return stack.findLastIndex(entry => (
    entry?.actorUuid === actorUuid
    && entry?.tokenId === tokenId
    && (!entry?.sceneId || !sceneId || entry.sceneId === sceneId)
  ));
}

function getPostureChangeResourceState(actor) {
  const movement = actor?.system?.resources?.[MOVEMENT_RESOURCE_KEY];
  const action = actor?.system?.resources?.[ACTION_RESOURCE_KEY];
  if (!movement || !action) return null;

  const movementValue = Math.max(0, toInteger(movement.value));
  const actionValue = Math.max(0, toInteger(action.value));
  return {
    movement: {
      current: movementValue,
      value: movementValue
    },
    action: {
      current: actionValue,
      value: actionValue
    },
    total: movementValue + actionValue
  };
}

function decorateTokenHudPosturePalette(app, element) {
  const root = getHookHtmlElement(app, element);
  const tokenDocument = app?.document ?? app?.object?.document;
  if (!root || !tokenDocument) return;

  decorateSelectedPostureButton(root, tokenDocument);
  for (const entry of root.querySelectorAll("[data-movement-action]")) {
    const action = normalizeMovementAction(entry.dataset.movementAction);
    const config = POSTURE_ACTION_CONFIGS[action];
    if (!config) continue;

    const img = entry.querySelector("img");
    if (img) img.src = getConfiguredPostureIcon(action);

    const currentAction = normalizeMovementAction(tokenDocument._source?.movementAction);
    const cost = getPostureChangeResourceCost(tokenDocument, currentAction, action);
    if (cost <= 0) continue;

    entry.addEventListener("pointerenter", () => publishPostureChangeResourcePreview(tokenDocument, cost));
    entry.addEventListener("pointerleave", () => clearPostureChangeResourcePreview(tokenDocument));
    entry.addEventListener("pointerdown", () => clearPostureChangeResourcePreview(tokenDocument));
  }
}

function decorateSelectedPostureButton(root, tokenDocument) {
  const action = normalizeMovementAction(tokenDocument?._source?.movementAction);
  if (!POSTURE_ACTION_CONFIGS[action]) return;

  const button = root.querySelector('[data-palette="movementActions"], [data-control="movementAction"]');
  const img = button?.querySelector?.("img");
  if (img) img.src = getConfiguredPostureIcon(action);
}

function getHookHtmlElement(app, element) {
  if (element instanceof HTMLElement) return element;
  if (element?.[0] instanceof HTMLElement) return element[0];
  if (app?.element instanceof HTMLElement) return app.element;
  if (app?.element?.[0] instanceof HTMLElement) return app.element[0];
  return null;
}

function publishPostureChangeResourcePreview(tokenDocument, cost) {
  Hooks.callAll(MOVEMENT_RESOURCE_PREVIEW_HOOK, {
    actorUuid: tokenDocument?.actor?.uuid ?? "",
    sceneId: tokenDocument?.parent?.id ?? tokenDocument?.scene?.id ?? "",
    tokenId: tokenDocument?.id ?? "",
    cost: Math.max(0, toInteger(cost)),
    resources: getPostureChangeResourcePreviewResources(tokenDocument?.actor, cost)
  });
}

function clearPostureChangeResourcePreview(tokenDocument) {
  Hooks.callAll(MOVEMENT_RESOURCE_PREVIEW_HOOK, {
    actorUuid: tokenDocument?.actor?.uuid ?? "",
    sceneId: tokenDocument?.parent?.id ?? tokenDocument?.scene?.id ?? "",
    tokenId: tokenDocument?.id ?? "",
    resources: {}
  });
}

function getPostureChangeResourcePreviewResources(actor, amount) {
  const state = getPostureChangeResourceState(actor);
  const cost = Math.max(0, toInteger(amount));
  if (!state || cost <= 0) return {};
  const movementSpend = Math.min(cost, state.movement.value);
  const actionSpend = Math.min(Math.max(0, cost - movementSpend), state.action.value);
  return {
    [MOVEMENT_RESOURCE_KEY]: movementSpend,
    [ACTION_RESOURCE_KEY]: actionSpend
  };
}

function scheduleActorKnockdownFromEffect(effect) {
  scheduleActorKnockdown(effect?.parent);
}

function scheduleActorKnockdown(actor) {
  if (!game.user?.isActiveGM || !actor?.id) return;
  window.setTimeout(() => void knockdownActorIfIncapacitated(actor), 0);
}

async function knockdownActorIfIncapacitated(actor) {
  if (!isActorIncapacitated(actor)) return;
  for (const token of canvas?.tokens?.placeables ?? []) {
    const tokenDocument = token.document;
    if (!isTokenForActor(tokenDocument, actor)) continue;
    await knockdownTokenIfActorIncapacitated(tokenDocument);
  }
}

async function knockdownTokenIfActorIncapacitated(tokenDocument) {
  if (!isActorIncapacitated(tokenDocument?.actor)) return;
  if (normalizeMovementAction(tokenDocument._source?.movementAction) === "knocked") return;
  await tokenDocument.update({ movementAction: "knocked" }, { [AUTOMATIC_POSTURE_OPTION]: true });
}

function isTokenForActor(tokenDocument, actor) {
  if (!tokenDocument?.actor || !actor) return false;
  if (tokenDocument.actor.uuid === actor.uuid) return true;
  if (tokenDocument.actor.baseActor?.uuid === actor.uuid) return true;
  return tokenDocument.actor.id === actor.id;
}

function isActorIncapacitated(actor) {
  const statuses = actor?.statuses;
  if (!statuses) return false;

  const defeated = CONFIG.specialStatusEffects?.DEFEATED;
  if (defeated && statuses.has(defeated)) return true;
  for (const status of INCAPACITATING_STATUSES) {
    if (statuses.has(status)) return true;
  }
  return false;
}

function getActorPostureEffectData(actor) {
  for (const effect of actor?.effects ?? []) {
    const data = effect.getFlag?.(SYSTEM_ID, POSTURE_MOVEMENT_FLAG);
    if (data?.action) return data;
  }
  return null;
}

function collectPostureNumberModifier(actor, action = "", key = "") {
  const modifier = { add: 0, multiplier: 1, override: null };
  const changeKey = `${POSTURE_EFFECT_CHANGE_ROOT}.${action}.${key}`;
  if (!action || !key) return modifier;

  for (const effect of getActorApplicableEffects(actor)) {
    if (effect.disabled) continue;
    for (const change of effect.system?.changes ?? effect.changes ?? []) {
      if (String(change.key ?? "").trim() !== changeKey) continue;
      const value = evaluatePostureEffectChangeNumber(actor, change.value);
      if (!Number.isFinite(value)) continue;
      if (change.type === "override") modifier.override = value;
      else if (change.type === "multiply") modifier.multiplier *= value;
      else modifier.add += value;
    }
  }
  return modifier;
}

function applyPostureNumberModifier(baseValue = 0, modifier = {}) {
  let value = Number(baseValue) || 0;
  const override = modifier?.override;
  if (override !== null && override !== undefined && override !== "") {
    const number = Number(override);
    if (Number.isFinite(number)) value = number;
  }
  const multiplier = Number(modifier?.multiplier);
  value *= Number.isFinite(multiplier) ? multiplier : 1;
  value += Number(modifier?.add) || 0;
  return value;
}

function getActorApplicableEffects(actor) {
  if (typeof actor?.allApplicableEffects === "function") return Array.from(actor.allApplicableEffects());
  return Array.from(actor?.effects ?? []);
}

function evaluatePostureEffectChangeNumber(actor, value) {
  const text = String(value ?? "").trim();
  if (!text) return 0;
  const direct = Number(text);
  if (Number.isFinite(direct)) return direct;

  try {
    const roll = new Roll(text, actor?.getRollData?.() ?? {});
    roll.evaluateSync?.({ strict: false });
    return Number(roll.total);
  } catch (_error) {
    return NaN;
  }
}

function getConfiguredPostureIcon(action) {
  try {
    return getTokenActionHudIcons().postures?.[action] || POSTURE_ACTION_CONFIGS[action]?.img || "icons/svg/walk.svg";
  } catch (_error) {
    return POSTURE_ACTION_CONFIGS[action]?.img || "icons/svg/walk.svg";
  }
}

function roundDepth(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000;
}

function isPostureEffectAction(action) {
  return action !== "walk" && Object.hasOwn(POSTURE_ACTION_CONFIGS, action);
}

function normalizeMovementAction(action) {
  const value = String(action ?? "").trim();
  return value || "walk";
}

function toInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}
