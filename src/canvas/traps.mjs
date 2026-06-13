import { SYSTEM_ID, TEMPLATES } from "../constants.mjs";
import { requestSkillCheck } from "../rolls/skill-check.mjs";
import { canSpendCombatActionPoints, spendCombatActionPoints } from "../combat/reaction-resources.mjs";
import { requestDamageApplications } from "../combat/damage-hub.mjs";
import { playWeaponExplosionAnimation } from "../combat/attack-animations.mjs";
import { buildWeaponExplosionDamageRequests, executeWeaponAttackAgainstToken } from "../combat/weapon-attack-controller.mjs";
import { evaluateActorFormula, isFormulaTextConfigured } from "../utils/actor-formulas.mjs";
import { normalizeImagePath, prepareInventoryContext } from "../utils/actor-display-data.mjs";
import { getItemQuantity } from "../utils/inventory-containers.mjs";
import { getCreatureOptions, getToolSettings } from "../settings/accessors.mjs";
import { ITEM_FUNCTIONS, getEnabledToolFunctions, getEnabledWeaponFunctions, getTrapFunction, getWeaponFunctionModuleSlots, hasItemFunction } from "../utils/item-functions.mjs";
import { applyWeaponModuleModifiers } from "../utils/weapon-modules.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { analyzeLightingPoint } from "../stealth/index.mjs";
import {
  DEFAULT_FACTION_NAME,
  getActorFactionBelongs,
  getActorPrimaryFaction,
  getFactionNamesWithDefault,
  getFactionSettings,
  getRelationTo
} from "../settings/factions.mjs";

const TRAP_SOCKET = `system.${SYSTEM_ID}`;
const TRAP_SOCKET_SCOPE = "fallout-maw.traps";
const TRAP_FLAG = "trap";
const PERIODIC_DAMAGE_REGION_BEHAVIOR_TYPE = "fallout-maw.periodicDamage";
const DEFAULT_TRAP_IMAGE = "icons/svg/hazard.svg";
const DEFAULT_REGION_DAMAGE_INTERVAL_SECONDS = 6;
const PREVIEW_BORDER_COLOR = 0xf0a23a;
const PREVIEW_FILL_COLOR = 0xf0a23a;
const TRAP_CONTROLLED_MOVEMENT_OPTION = "falloutMawTrapControlledMovement";
const TRAP_SAFE_HIGHLIGHT_LAYER = "fallout-maw-safe-traps";
const TRAP_SAFE_HIGHLIGHT_COLOR = 0x43c96b;
const TRAP_HOSTILE_HIGHLIGHT_COLOR = 0xd85f5f;
const TRAP_INTERACTION_HIGHLIGHT_LAYER = "fallout-maw-interaction-traps";
const TRAP_INTERACTION_HIGHLIGHT_COLOR = 0xf0c84b;
const TRAP_LINKED_ACTOR_HIGHLIGHT_LAYER = "fallout-maw-linked-actor-tokens";
const TRAP_LINKED_ACTOR_HIGHLIGHT_COLOR = 0xe34fcb;
const TRAP_LINKED_ACTION_MODE = "linkedAction";
const TRAP_EFFECT_EXPLOSION_MODE = "explosion";
const TRAP_EFFECT_ATTACK_MODE = "attack";
const TRAP_DETECTION_LIGHTING_CONDITION = "lighting";
const TRAP_RECHARGE_UNITS = Object.freeze({
  seconds: 1,
  minutes: 60,
  hours: 3600
});
const TRAP_BLOCKED_CANVAS_EVENT_TYPES = Object.freeze([
  "pointerdown",
  "pointerup",
  "mousedown",
  "mouseup",
  "click",
  "dblclick",
  "auxclick",
  "contextmenu"
]);
const TRAP_LINKED_ACTIONS = Object.freeze([
  ["aimedShot", "FALLOUTMAW.Item.WeaponActionAimedShot"],
  ["snapshot", "FALLOUTMAW.Item.WeaponActionSnapshot"],
  ["burst", "FALLOUTMAW.Item.WeaponActionBurst"],
  ["volley", "FALLOUTMAW.Item.WeaponActionVolley"],
  ["meleeAttack", "FALLOUTMAW.Item.WeaponActionMeleeAttack"],
  ["aimedMeleeAttack", "FALLOUTMAW.Item.WeaponActionAimedMeleeAttack"],
  ["push", "FALLOUTMAW.Item.WeaponActionPush"]
]);
const TOOL_CLASS_RANKS = Object.freeze({ D: 0, C: 1, B: 2, A: 3, S: 4 });
const { ApplicationV2, DialogV2, HandlebarsApplicationMixin } = foundry.applications.api;

let activeTrapPlacement = null;
let activeTrapInteraction = null;
let activeTrapLinkedActorSelection = null;
let trapTilePatchRegistered = false;
let trapGmFreeDoubleClickListenerRegistered = false;
let trapVisibilityRefreshQueued = false;
let trapDetectionRefreshTimeout = 0;
const pendingTrapActivationKeys = new Set();
const pendingTrapMovementKeys = new Set();

export function registerTrapHooks() {
  game.socket.on(TRAP_SOCKET, handleTrapSocketMessage);
  patchTrapTileVisibility();
  registerTrapGmFreeDoubleClickListener();
  Hooks.on("canvasReady", () => {
    patchTrapTileVisibility();
    registerTrapGmFreeDoubleClickListener();
    refreshTrapTileVisibility();
    refreshTrapInteractionHighlights();
    void processDueTrapRecharges();
  });
  Hooks.on("controlToken", () => {
    refreshTrapTileVisibility();
    refreshTrapInteractionHighlights();
  });
  Hooks.on("sightRefresh", () => {
    refreshTrapTileVisibility();
    queueTrapDetectionRefresh();
  });
  Hooks.on("visibilityRefresh", refreshTrapTileVisibility);
  Hooks.on("lightingRefresh", queueTrapDetectionRefresh);
  Hooks.on("updateWorldTime", () => void processDueTrapRecharges());
  Hooks.on("updateToken", queueTrapTileVisibilityRefresh);
  Hooks.on("updateActor", (actor, changes = {}) => {
    const flat = foundry.utils.flattenObject(changes ?? {});
    if (`flags.${SYSTEM_ID}.factionBelongs` in flat || `flags.${SYSTEM_ID}.factionRelations` in flat) refreshTrapTileVisibility();
  });
  Hooks.on("createTile", tile => {
    if (isTrapTileDocument(tile)) {
      refreshTrapTileVisibility();
      refreshTrapInteractionHighlights();
    }
  });
  Hooks.on("updateTile", tile => {
    if (isTrapTileDocument(tile)) {
      refreshTrapTileVisibility();
      refreshTrapInteractionHighlights();
    }
  });
  Hooks.on("deleteTile", tile => {
    if (isTrapTileDocument(tile)) queueTrapTileVisibilityRefresh();
  });
  Hooks.on("preMoveToken", onTrapPreMoveToken);
  Hooks.on("createToken", token => {
    void processTrapContactForToken(token);
  });
  Hooks.on("canvasTearDown", () => {
    if (trapDetectionRefreshTimeout) window.clearTimeout(trapDetectionRefreshTimeout);
    trapDetectionRefreshTimeout = 0;
    cancelActiveTrapPlacement();
    cancelTrapInteractionMode();
    cancelTrapLinkedActorSelection();
  });
}

export async function startTrapPlacement({ actor = null, token = null, item = null, application = null } = {}) {
  const sourceActor = actor ?? item?.actor ?? token?.actor ?? token?.document?.actor ?? null;
  if (!sourceActor?.isOwner || !item || !hasItemFunction(item, ITEM_FUNCTIONS.trap)) return false;
  if (!canvas?.ready || !canvas.scene) {
    ui.notifications.warn("Сцена не готова для установки ловушки.");
    return false;
  }
  if (getItemQuantity(item) <= 0) {
    ui.notifications.warn(`${item.name}: нет доступной штучности.`);
    return false;
  }
  if (!game.user?.isGM && !getResponsibleGM()) {
    ui.notifications.warn("Нет активного GM для создания ловушки на сцене.");
    return false;
  }

  cancelActiveTrapPlacement();
  activeTrapPlacement = {
    actorUuid: sourceActor.uuid,
    actorId: sourceActor.id,
    itemId: item.id,
    sourceItemUuid: item.uuid,
    sceneId: canvas.scene.id,
    tokenId: token?.id ?? token?.document?.id ?? "",
    application,
    trapData: normalizeTrapData(getTrapFunction(item)),
    itemData: item.toObject(),
    preview: null,
    rotation: 0,
    lastPoint: null,
    inputShield: createTrapCanvasInputShield("crosshair")
  };
  await createTrapPlacementPreview(activeTrapPlacement);
  bindTrapCanvasInput(activeTrapPlacement, onTrapPlacementCanvasEvent, { pointerMove: true });
  window.addEventListener("keydown", onTrapPlacementKeyDown, { capture: true });
  ui.notifications.info(`${item.name}: выберите точку установки ловушки. Esc/ПКМ отменяет.`);
  return true;
}

export function startTrapInteractionMode({ actor = null, token = null } = {}) {
  const sourceActor = actor ?? token?.actor ?? token?.document?.actor ?? getTrapViewerActor();
  if (!sourceActor?.isOwner) {
    ui.notifications.warn("Для работы с ловушками нужен выбранный актёр.");
    return false;
  }
  if (!canvas?.ready || !canvas.scene) {
    ui.notifications.warn("Сцена не готова для работы с ловушками.");
    return false;
  }

  cancelActiveTrapPlacement();
  cancelTrapInteractionMode();
  activeTrapInteraction = {
    actorUuid: sourceActor.uuid,
    tokenId: token?.id ?? token?.document?.id ?? "",
    sceneId: canvas.scene.id,
    inputShield: createTrapCanvasInputShield("pointer")
  };
  bindTrapCanvasInput(activeTrapInteraction, onTrapInteractionCanvasEvent);
  window.addEventListener("keydown", onTrapInteractionKeyDown, { capture: true });
  refreshTrapInteractionHighlights();
  ui.notifications.info("Режим ловушек: выберите подсвеченную ловушку. Esc/ПКМ отменяет.");
  return true;
}

function onTrapPreMoveToken(token, movement, options = {}) {
  if (options[TRAP_CONTROLLED_MOVEMENT_OPTION]) return;
  if (game.paused) return false;
  const tokenDocument = token?.document ?? token;
  const actor = tokenDocument?.actor ?? token?.actor;
  const scene = tokenDocument?.parent ?? canvas.scene;
  if (!scene || !actor || !movement) return;

  const trapTiles = (scene.tiles?.contents ?? []).filter(isTrapTileDocument);
  if (!trapTiles.length) return;

  const event = findFirstTrapMovementEvent(tokenDocument, actor, movement, trapTiles);
  if (event) {
    void runTrapMovementInterruption(tokenDocument, movement, event);
    return false;
  }
}

async function processTrapContactForToken(token) {
  if (!game.user?.isActiveGM) return;
  const tokenDocument = token?.document ?? token;
  const actor = tokenDocument?.actor ?? token?.actor;
  const scene = tokenDocument?.parent ?? canvas.scene;
  if (!scene || !actor) return;

  const point = getTokenCenter(tokenDocument);
  const trapTiles = (scene.tiles?.contents ?? []).filter(isTrapTileDocument);
  for (const tile of trapTiles) {
    const trap = getTrapFlag(tile);
    if (!trap || trap.ownerActorUuid === actor.uuid) continue;
    if (isActorSafeForTrap(trap, actor)) {
      await revealTrapToActor(tile, actor);
      continue;
    }
    const trapData = normalizeTrapData(trap.data);
    const detectionRadius = metersToPixels(trapData.detection.radiusMeters, scene, trap.ownerActorUuid);
    if (detectionRadius > 0) {
      const center = getTileCenter(tile);
      if (Math.hypot(point.x - center.x, point.y - center.y) <= detectionRadius) {
        await handleTrapDetectionForToken(tile, tokenDocument);
      }
    }
  }
}

async function processTrapInitialDetection(tile) {
  if (!game.user?.isActiveGM) return;
  const scene = tile?.parent ?? canvas.scene;
  const trap = getTrapFlag(tile);
  if (!scene || !trap) return;
  const trapData = normalizeTrapData(trap.data);
  const detectionRadius = metersToPixels(trapData.detection.radiusMeters, scene, trap.ownerActorUuid);
  if (detectionRadius <= 0) return;

  const center = getTileCenter(tile);
  for (const token of scene.tokens?.contents ?? []) {
    const actor = token?.actor;
    if (!actor || actor.uuid === trap.ownerActorUuid) continue;
    if (isActorSafeForTrap(trap, actor)) {
      await revealTrapToActor(tile, actor);
      continue;
    }
    const point = getTokenCenter(token);
    if (Math.hypot(point.x - center.x, point.y - center.y) > detectionRadius) continue;
    await handleTrapDetectionForToken(tile, token);
  }
}

function queueTrapDetectionRefresh() {
  if (!game.user?.isActiveGM || !canvas?.ready || trapDetectionRefreshTimeout) return;
  trapDetectionRefreshTimeout = window.setTimeout(async () => {
    trapDetectionRefreshTimeout = 0;
    const trapTiles = (canvas.scene?.tiles?.contents ?? []).filter(isTrapTileDocument);
    for (const tile of trapTiles) await processTrapInitialDetection(tile);
  }, 100);
}

async function handleTrapDetectionForToken(tile, token) {
  if (!game.user?.isActiveGM) return;
  const actor = token?.actor ?? token?.document?.actor;
  const trap = getTrapFlag(tile);
  if (!tile || !actor || !trap) return false;
  if (trap.armed === false || trap.disarmed === true) return false;
  if (actor.uuid === trap.ownerActorUuid) return false;
  if (isActorSafeForTrap(trap, actor)) {
    await revealTrapToActor(tile, actor);
    return true;
  }
  if (!canTokenSeeTrap(tile, token)) return false;

  const attempted = new Set(asStringArray(trap.attemptedDetectionActorUuids));
  if (attempted.has(actor.uuid)) return false;
  attempted.add(actor.uuid);
  await tile.update({ [`flags.${SYSTEM_ID}.${TRAP_FLAG}.attemptedDetectionActorUuids`]: Array.from(attempted) }, { render: false });

  const trapData = normalizeTrapData(trap.data);
  const difficulty = Math.max(0, trapData.detection.difficulty + getTrapDetectionLightingDifficultyBonus(tile, trapData));
  const skillKey = trapData.detection.skillKey;
  const outcome = await requestSkillCheck({
    actor,
    skillKey,
    data: { difficulty },
    animate: false,
    createMessage: true,
    prompt: false,
    requester: "trapDetection"
  });
  if (!isSkillCheckSuccess(outcome)) return false;

  await revealTrapToActor(tile, actor);
  ui.notifications.info(`${actor.name}: ловушка обнаружена.`);
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<p><strong>${escapeHTML(actor.name)}</strong> обнаруживает ловушку.</p>`
  });
  pauseGameForTrap();
  return true;
}

async function handleTrapActivationForToken(tile, token) {
  if (!game.user?.isActiveGM) return;
  const actor = token?.actor ?? token?.document?.actor;
  const trap = getTrapFlag(tile);
  if (!tile || !actor || !trap || trap.armed === false) return;
  if (actor.uuid === trap.ownerActorUuid) return;
  if (isActorSafeForTrap(trap, actor)) return;
  await tile.update({ [`flags.${SYSTEM_ID}.${TRAP_FLAG}.armed`]: false }, { render: false });
  await triggerTrap(tile, token);
}

async function requestTrapActivation(tile, token, { announce = false } = {}) {
  const sceneId = tile?.parent?.id ?? canvas.scene?.id ?? "";
  const tileId = tile?.id ?? "";
  const tokenId = token?.id ?? token?.document?.id ?? "";
  const key = `${sceneId}:${tileId}:${tokenId}`;
  if (!sceneId || !tileId || !tokenId || pendingTrapActivationKeys.has(key)) return;
  pendingTrapActivationKeys.add(key);
  window.setTimeout(() => pendingTrapActivationKeys.delete(key), 10000);

  if (game.user?.isActiveGM) {
    await activateTrapTileNow({ sceneId, tileId, tokenId, announce });
    pendingTrapActivationKeys.delete(key);
    return;
  }

  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("Нет активного GM для срабатывания ловушки.");
    pendingTrapActivationKeys.delete(key);
    return;
  }
  game.socket.emit(TRAP_SOCKET, {
    scope: TRAP_SOCKET_SCOPE,
    action: "activateTrapTile",
    gmUserId: gm.id,
    senderUserId: game.user?.id ?? "",
    request: { sceneId, tileId, tokenId, announce }
  });
}

async function requestTrapDetectionStop(tile, token) {
  const request = createTrapTokenRequest(tile, token);
  if (!request.sceneId || !request.tileId || !request.tokenId) return;
  if (game.user?.isActiveGM) {
    await resolveTrapDetectionStopNow(request);
    return;
  }
  const gm = getResponsibleGM();
  if (!gm) return;
  game.socket.emit(TRAP_SOCKET, {
    scope: TRAP_SOCKET_SCOPE,
    action: "resolveTrapDetectionStop",
    gmUserId: gm.id,
    senderUserId: game.user?.id ?? "",
    request
  });
}

async function requestTrapTriggerEnterNotice(tile, token) {
  const request = createTrapTokenRequest(tile, token);
  if (!request.sceneId || !request.tileId || !request.tokenId) return;
  if (game.user?.isActiveGM) {
    await announceTrapTriggerEnterNow(request);
    return;
  }
  const gm = getResponsibleGM();
  if (!gm) return;
  game.socket.emit(TRAP_SOCKET, {
    scope: TRAP_SOCKET_SCOPE,
    action: "announceTrapTriggerEnter",
    gmUserId: gm.id,
    senderUserId: game.user?.id ?? "",
    request
  });
}

async function resolveTrapDetectionStopNow({ sceneId = "", tileId = "", tokenId = "" } = {}) {
  const scene = game.scenes?.get(sceneId) ?? canvas.scene;
  const tile = scene?.tiles?.get(tileId);
  const token = scene?.tokens?.get(tokenId);
  await handleTrapDetectionForToken(tile, token);
}

async function announceTrapTriggerEnterNow({ sceneId = "", tileId = "", tokenId = "" } = {}) {
  const scene = game.scenes?.get(sceneId) ?? canvas.scene;
  const tile = scene?.tiles?.get(tileId);
  const token = scene?.tokens?.get(tokenId);
  const actor = token?.actor;
  const trap = getTrapFlag(tile);
  if (!scene || !tile || !actor || !trap || actor.uuid === trap.ownerActorUuid || isActorSafeForTrap(trap, actor)) return;
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<p><strong>${escapeHTML(actor.name)}</strong> активирует ловушку.</p>`
  });
  ui.notifications.warn(`${actor.name}: ловушка активирована.`);
  pauseGameForTrap();
}

async function activateTrapTileNow({ sceneId = "", tileId = "", tokenId = "", announce = false } = {}) {
  const scene = game.scenes?.get(sceneId) ?? canvas.scene;
  const tile = scene?.tiles?.get(tileId);
  const token = scene?.tokens?.get(tokenId);
  if (announce) await announceTrapTriggerEnterNow({ sceneId, tileId, tokenId });
  await handleTrapActivationForToken(tile, token);
}

async function onTrapPlacementPointerDown(event) {
  if (!activeTrapPlacement) return;
  if (event.button !== 0) return;
  event.preventDefault?.();
  event.stopPropagation?.();
  event.stopImmediatePropagation?.();

  const placement = activeTrapPlacement;
  const actor = await fromUuid(placement.actorUuid);
  const item = actor?.items?.get(placement.itemId);
  if (!actor?.isOwner || !item || !hasItemFunction(item, ITEM_FUNCTIONS.trap)) {
    cancelActiveTrapPlacement();
    return;
  }
  if (getItemQuantity(item) <= 0) {
    ui.notifications.warn(`${item.name}: нет доступной штучности.`);
    cancelActiveTrapPlacement();
    return;
  }

  const trapData = normalizeTrapData(getTrapFunction(item));
  const apCost = Math.max(0, toInteger(trapData.actionPointCost));
  if (!canSpendCombatActionPoints(actor, apCost, { label: "установки ловушки" })) return;

  const point = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
  const rect = getTrapPlacementRectFromPoint(point, trapData, canvas.scene, placement.rotation);
  const clipped = getTrapPlacementClippedArea(rect, canvas.scene);
  if (!clipped.polygons.length) {
    ui.notifications.warn(`${item.name}: стены полностью отсекают область установки.`);
    return;
  }
  cancelActiveTrapPlacement();
  await spendCombatActionPoints(actor, apCost);

  const outcome = await requestSkillCheck({
    actor,
    skillKey: trapData.installation.skillKey,
    data: { difficulty: trapData.installation.difficulty },
    animate: false,
    createMessage: true,
    prompt: false,
    requester: "trapInstallation"
  });
  if (!isSkillCheckSuccess(outcome)) {
    ui.notifications.warn(`${item.name}: установка не удалась.`);
    await placement.application?.render?.({ force: true });
    return;
  }

  const linkedAction = trapData.trigger.activationMode === TRAP_LINKED_ACTION_MODE
    ? await selectTrapLinkedAction()
    : null;
  if (trapData.trigger.activationMode === TRAP_LINKED_ACTION_MODE && !linkedAction) {
    ui.notifications.info(`${item.name}: установка отменена до выбора связанного действия.`);
    await placement.application?.render?.({ force: true });
    return;
  }

  const currentItem = actor.items?.get(placement.itemId);
  if (!currentItem || getItemQuantity(currentItem) <= 0) {
    ui.notifications.warn(`${item.name}: предмет больше недоступен.`);
    await placement.application?.render?.({ force: true });
    return;
  }
  const created = await requestCreateTrapDocuments({
    sceneId: canvas.scene?.id ?? placement.sceneId,
    point: rect,
    ownerActorUuid: actor.uuid,
    sourceItemUuid: currentItem.uuid,
    itemData: currentItem.toObject(),
    trapData,
    placementRect: rect,
    rotation: placement.rotation,
    linkedAction
  });
  if (!created && !game.user?.isGM) return;
  await consumeTrapItem(currentItem);
  await placement.application?.render?.({ force: true });
}

function onTrapPlacementCanvasEvent(event) {
  if (!activeTrapPlacement) return;
  stopTrapCanvasInputEvent(event);
  if (event.type === "pointermove") {
    onTrapPlacementPointerMove(event);
    return;
  }
  if (event.type === "contextmenu" || event.type === "auxclick" || event.button === 2) {
    onTrapPlacementContextMenu(event);
    return;
  }
  if (!["pointerdown", "mousedown"].includes(event.type) || event.button !== 0) return;
  const placement = activeTrapPlacement;
  if (placement.inputPending) return;
  placement.inputPending = true;
  void onTrapPlacementPointerDown(event).finally(() => {
    if (activeTrapPlacement === placement) placement.inputPending = false;
  });
}

function onTrapPlacementContextMenu(event) {
  if (!activeTrapPlacement) return;
  event.preventDefault?.();
  event.stopPropagation?.();
  event.stopImmediatePropagation?.();
  cancelActiveTrapPlacement({ notify: true });
}

function onTrapPlacementPointerMove(event) {
  if (!activeTrapPlacement) return;
  const point = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
  activeTrapPlacement.lastPoint = point;
  updateTrapPlacementPreview(activeTrapPlacement, point);
}

function onTrapPlacementKeyDown(event) {
  if (!activeTrapPlacement) return;
  event.preventDefault?.();
  event.stopPropagation?.();
  event.stopImmediatePropagation?.();
  if (event.code === "KeyR" || String(event.key ?? "").toLowerCase() === "r" || String(event.key ?? "").toLowerCase() === "к") {
    if (event.repeat) return;
    rotateActiveTrapPlacement();
    return;
  }
  if (event.key === "Escape") cancelActiveTrapPlacement({ notify: true });
}

function rotateActiveTrapPlacement() {
  const placement = activeTrapPlacement;
  if (!placement) return;
  placement.rotation = normalizeTrapRotation((placement.rotation ?? 0) + 90);
  if (placement.lastPoint) updateTrapPlacementPreview(placement, placement.lastPoint);
}

function cancelActiveTrapPlacement({ notify = false } = {}) {
  if (!activeTrapPlacement) return;
  const placement = activeTrapPlacement;
  unbindTrapCanvasInput(placement);
  window.removeEventListener("keydown", onTrapPlacementKeyDown, { capture: true });
  destroyTrapPlacementPreview(placement);
  activeTrapPlacement = null;
  if (notify) ui.notifications.info("Установка ловушки отменена.");
}

function createTrapCanvasInputShield(cursor = "crosshair") {
  if (!document.body) return null;
  if (canvas?.currentMouseManager) {
    if (canvas.currentMouseManager.interactionData) canvas.currentMouseManager.interactionData.cancelled = true;
    canvas.currentMouseManager.cancel();
  }
  const shield = document.createElement("div");
  shield.dataset.falloutMawTrapInputShield = "true";
  Object.assign(shield.style, {
    position: "fixed",
    inset: "0",
    zIndex: "100000",
    background: "transparent",
    cursor,
    pointerEvents: "auto"
  });
  document.body.appendChild(shield);
  return shield;
}

function bindTrapCanvasInput(session, listener, { pointerMove = false } = {}) {
  if (!session || typeof listener !== "function") return;
  const targets = [canvas?.app?.view, session.inputShield].filter(Boolean);
  const types = pointerMove
    ? ["pointermove", ...TRAP_BLOCKED_CANVAS_EVENT_TYPES]
    : [...TRAP_BLOCKED_CANVAS_EVENT_TYPES];
  for (const target of targets) {
    for (const type of types) target.addEventListener(type, listener, true);
  }
  session.canvasInputBinding = { targets, types, listener };
}

function unbindTrapCanvasInput(session, { delay = 300 } = {}) {
  const binding = session?.canvasInputBinding;
  const shield = session?.inputShield;
  if (session) {
    session.canvasInputBinding = null;
    session.inputShield = null;
  }
  const cleanup = () => {
    if (binding) {
      for (const target of binding.targets) {
        for (const type of binding.types) target.removeEventListener(type, binding.listener, true);
      }
    }
    shield?.remove?.();
  };
  if (delay > 0) window.setTimeout(cleanup, delay);
  else cleanup();
}

function stopTrapCanvasInputEvent(event) {
  event.preventDefault?.();
  event.stopPropagation?.();
  event.stopImmediatePropagation?.();
}

async function selectTrapLinkedAction() {
  const token = await waitForTrapLinkedActorSelection();
  if (!token?.actor) return null;
  const dialog = new TrapLinkedActionDialog({ token });
  return dialog.wait();
}

function waitForTrapLinkedActorSelection() {
  cancelTrapLinkedActorSelection();
  if (!canvas?.ready || !canvas.app?.view) return Promise.resolve(null);
  return new Promise(resolve => {
    activeTrapLinkedActorSelection = {
      resolve,
      inputShield: createTrapCanvasInputShield("crosshair")
    };
    bindTrapCanvasInput(activeTrapLinkedActorSelection, onTrapLinkedActorCanvasEvent);
    window.addEventListener("keydown", onTrapLinkedActorKeyDown, { capture: true });
    refreshTrapLinkedActorHighlights();
    ui.notifications.info("Выберите подсвеченного актёра для связи с ловушкой. Esc/ПКМ отменяет.");
  });
}

function onTrapLinkedActorCanvasEvent(event) {
  if (!activeTrapLinkedActorSelection) return;
  stopTrapCanvasInputEvent(event);
  if (event.type === "contextmenu" || event.type === "auxclick" || event.button === 2) {
    cancelTrapLinkedActorSelection();
    return;
  }
  if (!["pointerdown", "mousedown"].includes(event.type) || event.button !== 0) return;
  const token = getTrapLinkedActorTokenAtEvent(event);
  if (token) finishTrapLinkedActorSelection(token);
}

function onTrapLinkedActorKeyDown(event) {
  if (!activeTrapLinkedActorSelection) return;
  event.preventDefault?.();
  event.stopPropagation?.();
  event.stopImmediatePropagation?.();
  if (event.key === "Escape") cancelTrapLinkedActorSelection();
}

function finishTrapLinkedActorSelection(token = null) {
  const selection = activeTrapLinkedActorSelection;
  if (!selection) return;
  cleanupTrapLinkedActorSelection();
  selection.resolve(token);
}

function cancelTrapLinkedActorSelection() {
  finishTrapLinkedActorSelection(null);
  refreshTrapLinkedActorHighlights();
}

function cleanupTrapLinkedActorSelection() {
  const selection = activeTrapLinkedActorSelection;
  unbindTrapCanvasInput(selection);
  window.removeEventListener("keydown", onTrapLinkedActorKeyDown, { capture: true });
  activeTrapLinkedActorSelection = null;
  refreshTrapLinkedActorHighlights();
}

function getTrapLinkedActorTokenAtEvent(event) {
  if (!Number.isFinite(Number(event?.clientX)) || !Number.isFinite(Number(event?.clientY))) return null;
  const point = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
  return [...(canvas.tokens?.placeables ?? [])]
    .filter(token => token.actor && token.visible !== false && token.renderable !== false)
    .sort((left, right) => (right._lastSortedIndex ?? 0) - (left._lastSortedIndex ?? 0))
    .find(token => token.bounds?.contains?.(point.x, point.y) || token.hitArea?.contains?.(point.x - token.x, point.y - token.y)) ?? null;
}

function refreshTrapLinkedActorHighlights() {
  const grid = canvas?.interface?.grid;
  if (!canvas?.ready || !grid) return;
  const layer = grid.getHighlightLayer?.(TRAP_LINKED_ACTOR_HIGHLIGHT_LAYER)
    ?? grid.addHighlightLayer?.(TRAP_LINKED_ACTOR_HIGHLIGHT_LAYER);
  layer?.clear?.();
  if (!layer || !activeTrapLinkedActorSelection) return;
  for (const token of canvas.tokens?.placeables ?? []) {
    if (!token.actor || token.visible === false || token.renderable === false) continue;
    const bounds = token.bounds;
    if (!bounds) continue;
    const width = Math.max(3, CONFIG.Canvas.objectBorderThickness * canvas.dimensions.uiScale);
    layer.lineStyle(width, TRAP_LINKED_ACTOR_HIGHLIGHT_COLOR, 0.95);
    layer.drawRect(bounds.x, bounds.y, bounds.width, bounds.height);
  }
}

class TrapLinkedActionDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  #token = null;
  #expandedWeaponId = "";
  #selectedAction = null;
  #resultPromise = null;
  #resolveResult = null;
  #settled = false;

  constructor({ token = null } = {}) {
    super();
    this.#token = token;
    this.#resultPromise = new Promise(resolve => {
      this.#resolveResult = resolve;
    });
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-trap-linked-action-dialog",
    classes: ["fallout-maw", "fallout-maw-trap-linked-action-dialog"],
    position: { width: 720, height: "auto" },
    window: { resizable: true },
    actions: {
      toggleWeapon: this.#onToggleWeapon,
      selectAction: this.#onSelectAction,
      confirmAction: this.#onConfirmAction,
      cancelAction: this.#onCancelAction
    }
  };

  static PARTS = {
    body: { template: TEMPLATES.trapLinkedActionDialog }
  };

  get title() {
    return `Связать ловушку - ${this.#token?.name ?? this.#token?.actor?.name ?? "актёр"}`;
  }

  async wait() {
    await this.render({ force: true });
    return this.#resultPromise;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const weaponSets = prepareTrapLinkedWeaponSets(this.#token?.actor, {
      expandedWeaponId: this.#expandedWeaponId,
      selectedAction: this.#selectedAction
    });
    return {
      ...context,
      actorName: this.#token?.name ?? this.#token?.actor?.name ?? "Актёр",
      weaponSets,
      hasWeapons: weaponSets.some(set => set.weapons.length > 0),
      canConfirm: Boolean(this.#selectedAction)
    };
  }

  async _onClose(options) {
    await super._onClose(options);
    this.#finish(null);
  }

  #finish(result) {
    if (this.#settled) return;
    this.#settled = true;
    this.#resolveResult?.(result);
  }

  static #onToggleWeapon(event, target) {
    event.preventDefault();
    const itemId = String(target.dataset.weaponItemId ?? "");
    this.#expandedWeaponId = this.#expandedWeaponId === itemId ? "" : itemId;
    return this.render({ force: true });
  }

  static #onSelectAction(event, target) {
    event.preventDefault();
    this.#selectedAction = {
      sceneId: canvas.scene?.id ?? "",
      tokenId: this.#token?.id ?? "",
      actorUuid: this.#token?.actor?.uuid ?? "",
      weaponItemId: String(target.dataset.weaponItemId ?? ""),
      weaponFunctionId: String(target.dataset.weaponFunctionId ?? ITEM_FUNCTIONS.weapon),
      actionKey: String(target.dataset.weaponActionKey ?? ""),
      actorName: this.#token?.name ?? this.#token?.actor?.name ?? "",
      weaponName: String(target.dataset.weaponName ?? ""),
      actionName: String(target.dataset.weaponActionName ?? "")
    };
    return this.render({ force: true });
  }

  static async #onConfirmAction(event) {
    event.preventDefault();
    if (!this.#selectedAction) return;
    this.#finish(normalizeTrapLinkedAction(this.#selectedAction));
    await this.close();
  }

  static #onCancelAction(event) {
    event.preventDefault();
    return this.close();
  }
}

function prepareTrapLinkedWeaponSets(actor, { expandedWeaponId = "", selectedAction = null } = {}) {
  if (!actor) return [];
  const race = getCreatureOptions().races.find(entry => entry.id === actor.system?.creature?.raceId);
  const inventory = prepareInventoryContext(actor, race);
  const sets = [
    ...(inventory.naturalWeaponSet ? [inventory.naturalWeaponSet] : []),
    ...(inventory.weaponSets ?? [])
  ];
  return sets.map(set => {
    const seen = new Set();
    const weapons = [];
    for (const slot of set.slots ?? []) {
      const itemId = String(slot.item?.id ?? "");
      if (!itemId || seen.has(itemId) || slot.phantom || slot.item?.phantom || slot.useDisabled || slot.item?.useDisabled) continue;
      seen.add(itemId);
      const weapon = actor.items?.get(itemId);
      if (!weapon) continue;
      const functions = getEnabledWeaponFunctions(weapon).map(weaponFunction => {
        const functionId = weaponFunction.isPrimary ? ITEM_FUNCTIONS.weapon : weaponFunction.id;
        const weaponData = applyWeaponModuleModifiers(weaponFunction.data ?? {}, {
          moduleSlots: getWeaponFunctionModuleSlots(weapon, functionId)
        });
        const actions = TRAP_LINKED_ACTIONS
          .filter(([actionKey]) => Boolean(weaponData.availableActions?.[actionKey]))
          .map(([actionKey, labelKey]) => {
            const actionName = String(weaponData?.[actionKey]?.name ?? "").trim() || game.i18n.localize(labelKey);
            return {
              actionKey,
              actionName,
              selected: selectedAction?.weaponItemId === itemId
                && selectedAction?.weaponFunctionId === functionId
                && selectedAction?.actionKey === actionKey
            };
          });
        return {
          functionId,
          label: weaponFunction.isPrimary ? "Основная функция" : (weaponFunction.name || "Дополнительная функция"),
          actions
        };
      }).filter(entry => entry.actions.length > 0);
      if (!functions.length) continue;
      weapons.push({
        itemId,
        name: weapon.name,
        img: normalizeImagePath(weapon.img, "icons/svg/sword.svg"),
        expanded: expandedWeaponId === itemId,
        functions
      });
    }
    return { key: set.key, label: set.label || set.key, weapons };
  }).filter(set => set.weapons.length > 0);
}

async function createTrapPlacementPreview(placement) {
  const layer = canvas?.stage;
  if (!layer || !placement) return;
  const container = new PIXI.Container();
  container.eventMode = "none";
  const graphics = new PIXI.Graphics();
  container.addChild(graphics);
  const image = normalizeImagePath(placement.itemData?.img, DEFAULT_TRAP_IMAGE);
  let sprite = null;
  try {
    const texture = await foundry.canvas.loadTexture(image);
    if (texture?.valid) {
      sprite = new PIXI.Sprite(texture);
      sprite.alpha = 0.55;
      container.addChild(sprite);
    }
  } catch (error) {
    console.warn(`${SYSTEM_ID} | Trap placement preview texture failed to load: ${image}`, error);
  }
  layer.addChild(container);
  placement.preview = { container, graphics, sprite };
}

function updateTrapPlacementPreview(placement, point) {
  const preview = placement?.preview;
  if (!preview?.container) return;
  const rotation = normalizeTrapRotation(placement.rotation);
  const rect = getTrapPlacementRectFromPoint(point, placement.trapData, canvas.scene, rotation);
  const clipped = getTrapPlacementClippedArea(rect, canvas.scene);
  preview.container.position.set(rect.x, rect.y);
  preview.graphics.clear();
  for (const polygon of clipped.polygons) {
    const points = getPolygonPointObjects(polygon)
      .flatMap(point => [point.x - rect.x, point.y - rect.y]);
    if (points.length < 6) continue;
    preview.graphics
      .lineStyle(3, PREVIEW_BORDER_COLOR, 0.95)
      .beginFill(PREVIEW_FILL_COLOR, 0.16)
      .drawPolygon(points)
      .endFill();
  }
  if (preview.sprite) {
    preview.sprite.visible = Boolean(clipped.polygons.length);
    fitSpriteIntoRect(
      preview.sprite,
      rect.width,
      rect.height,
      placement.trapData?.trigger?.imageScale,
      rotation
    );
  }
}

function destroyTrapPlacementPreview(placement) {
  const preview = placement?.preview;
  if (!preview?.container) return;
  preview.container.destroy({ children: true, texture: false, baseTexture: false });
  placement.preview = null;
}

function fitSpriteIntoRect(sprite, width, height, imageScale = 0.5, rotation = 0, x = 0, y = 0) {
  const textureWidth = Math.max(1, Number(sprite.texture?.width) || 1);
  const textureHeight = Math.max(1, Number(sprite.texture?.height) || 1);
  const normalizedRotation = normalizeTrapRotation(rotation);
  const rotated = normalizedRotation === 90 || normalizedRotation === 270;
  const fitWidth = rotated ? textureHeight : textureWidth;
  const fitHeight = rotated ? textureWidth : textureHeight;
  const scale = Math.min(width / fitWidth, height / fitHeight) * Math.max(0, Number(imageScale) || 0);
  sprite.anchor.set(0.5, 0.5);
  sprite.scale.set(scale, scale);
  sprite.rotation = Math.toRadians?.(normalizedRotation) ?? (normalizedRotation * Math.PI / 180);
  sprite.position.set((Number(x) || 0) + (width / 2), (Number(y) || 0) + (height / 2));
}

function getTrapTileAtCanvasEvent(event) {
  if (!Number.isFinite(Number(event?.clientX)) || !Number.isFinite(Number(event?.clientY))) return null;
  const point = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
  const interactionActor = activeTrapInteraction ? getActiveTrapInteractionActor() : (shouldOpenGmTrapFreeDialog() ? null : getTrapViewerActor());
  return (canvas.scene?.tiles?.contents ?? [])
    .filter(tile => (
      isTrapTileDocument(tile)
      && (interactionActor ? isTrapVisibleToActor(tile, interactionActor) : isTrapVisibleForCurrentViewer(tile))
      && isPointInsideTile(tile, point)
    ))
    .sort((left, right) => (Number(right.sort) || 0) - (Number(left.sort) || 0))
    .at(0) ?? null;
}

function registerTrapGmFreeDoubleClickListener() {
  const view = canvas?.app?.view;
  if (trapGmFreeDoubleClickListenerRegistered || !view) return;
  view.addEventListener("dblclick", onTrapGmFreeCanvasDoubleClick, { capture: true });
  trapGmFreeDoubleClickListenerRegistered = true;
}

function onTrapGmFreeCanvasDoubleClick(event) {
  if (!shouldOpenGmTrapFreeDialog()) return;
  const tile = getTrapTileAtCanvasEvent(event);
  if (!tile) return;
  event.preventDefault?.();
  event.stopPropagation?.();
  event.stopImmediatePropagation?.();
  void openTrapGmFreeDialog(tile);
}

async function onTrapInteractionPointerDown(event) {
  if (!activeTrapInteraction || event.button !== 0) return;
  const tile = getTrapTileAtCanvasEvent(event);
  if (!tile) return;
  event.preventDefault?.();
  event.stopPropagation?.();
  event.stopImmediatePropagation?.();

  const actor = getActiveTrapInteractionActor();
  cancelTrapInteractionMode();
  if (!actor?.isOwner) {
    ui.notifications.warn("Для работы с ловушкой нужен выбранный актёр.");
    return;
  }
  await openTrapInteractionDialog(tile, actor);
}

function onTrapInteractionCanvasEvent(event) {
  if (!activeTrapInteraction) return;
  stopTrapCanvasInputEvent(event);
  if (event.type === "contextmenu" || event.type === "auxclick" || event.button === 2) {
    onTrapInteractionContextMenu(event);
    return;
  }
  if (!["pointerdown", "mousedown"].includes(event.type) || event.button !== 0) return;
  void onTrapInteractionPointerDown(event);
}

function onTrapInteractionContextMenu(event) {
  if (!activeTrapInteraction) return;
  event.preventDefault?.();
  event.stopPropagation?.();
  event.stopImmediatePropagation?.();
  cancelTrapInteractionMode({ notify: true });
}

function onTrapInteractionKeyDown(event) {
  if (!activeTrapInteraction) return;
  event.preventDefault?.();
  event.stopPropagation?.();
  event.stopImmediatePropagation?.();
  if (event.key === "Escape") cancelTrapInteractionMode({ notify: true });
}

function cancelTrapInteractionMode({ notify = false } = {}) {
  if (!activeTrapInteraction) {
    refreshTrapInteractionHighlights();
    return;
  }
  const interaction = activeTrapInteraction;
  unbindTrapCanvasInput(interaction);
  window.removeEventListener("keydown", onTrapInteractionKeyDown, { capture: true });
  activeTrapInteraction = null;
  refreshTrapInteractionHighlights();
  if (notify) ui.notifications.info("Режим ловушек отменён.");
}

function getActiveTrapInteractionActor() {
  const uuid = String(activeTrapInteraction?.actorUuid ?? "");
  if (uuid) return fromUuidSyncSafe(uuid);
  return getTrapViewerActor();
}

async function openTrapInteractionDialog(tile, actor) {
  const trap = getTrapFlag(tile);
  if (!trap || !actor) return;
  const canPickup = canActorPickupTrap(trap, actor);
  const action = await DialogV2.wait({
    window: { title: tile.name || "Ловушка" },
    content: `<p><strong>${escapeHTML(tile.name || "Ловушка")}</strong></p>`,
    buttons: canPickup
      ? [
          { action: "pickup", label: "Забрать", icon: "fa-solid fa-hand", default: true },
          { action: "cancel", label: "Отмена", icon: "fa-solid fa-xmark", type: "button" }
        ]
      : [
          { action: "disarm", label: "Обезвредить", icon: "fa-solid fa-screwdriver-wrench", default: true },
          { action: "cancel", label: "Отмена", icon: "fa-solid fa-xmark", type: "button" }
        ],
    rejectClose: false,
    modal: true,
    position: { width: 360 }
  });
  if (action === "pickup") return requestPickupTrapDocuments(tile, actor);
  if (action === "disarm") return openTrapDisarmDialog(tile, actor);
  return undefined;
}

async function openTrapDisarmDialog(tile, actor) {
  return new TrapDisarmDialog({ tile, actor }).render({ force: true });
}

class TrapDisarmDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  #tile = null;
  #actor = null;
  #selectedToolId = "";
  #localAttemptsRemaining = null;
  #localDisarmed = false;
  #disarmInFlight = false;

  constructor({ tile, actor } = {}) {
    super();
    this.#tile = tile;
    this.#actor = actor;
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-trap-disarm-dialog",
    classes: ["fallout-maw", "fallout-maw-trap-disarm-dialog"],
    position: {
      width: 900,
      height: "auto"
    },
    window: {
      resizable: true
    },
    actions: {
      selectTool: this.#onSelectTool,
      disarmTrap: this.#onDisarmTrap,
      pickupTrap: this.#onPickupTrap,
      closeDialog: this.#onCloseDialog
    }
  };

  static PARTS = {
    body: {
      template: TEMPLATES.trapDisarmDialog
    }
  };

  get title() {
    return `Обезвреживание - ${this.#tile?.name || "Ловушка"}`;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const trap = getTrapFlag(this.#tile);
    const trapData = normalizeTrapData(trap?.data);
    const disarm = trapData.disarm;
    const disarmed = this.#localDisarmed || trap?.disarmed === true || trap?.armed === false;
    const attemptsRemaining = this.#localAttemptsRemaining ?? getTrapDisarmAttemptsRemaining(trap);
    const tools = getTrapDisarmToolCandidates(this.#actor, disarm);
    if (!this.#selectedToolId || !tools.some(tool => tool.itemId === this.#selectedToolId)) {
      this.#selectedToolId = String(trap?.lastDisarmToolItemId ?? tools[0]?.itemId ?? "");
    }
    const toolLabel = getToolSettings().find(tool => tool.key === disarm.toolKey)?.label ?? disarm.toolKey;
    const selectedTool = tools.find(tool => tool.itemId === this.#selectedToolId) ?? null;
    const attemptsFinished = attemptsRemaining <= 0;
    return {
      ...context,
      title: "ОБЕЗВРЕЖИВАНИЕ",
      targetName: this.#tile?.name || "Ловушка",
      toolLabel,
      requiredClass: disarm.toolClass,
      difficulty: disarm.difficulty,
      attemptsRemaining,
      attemptsTotal: disarm.attempts,
      statusLabel: disarmed ? "Ловушка обезврежена" : (attemptsFinished ? "Попытки исчерпаны" : "Ловушка активна"),
      statusClass: disarmed ? "status-ok" : (attemptsFinished ? "status-bad" : "status-warn"),
      disarmed,
      tools: tools.map(tool => ({ ...tool, selected: tool.itemId === this.#selectedToolId })),
      hasTools: tools.length > 0,
      selectedToolId: this.#selectedToolId,
      selectedTool,
      canPickup: disarmed && this.#actor?.isOwner,
      disarmDisabled: disarmed || !this.#actor?.isOwner || attemptsFinished || !selectedTool
    };
  }

  static #onSelectTool(event, target) {
    event.preventDefault();
    this.#selectedToolId = String(target.dataset.trapDisarmTool ?? "");
    return this.render({ force: true });
  }

  static async #onDisarmTrap(event) {
    event.preventDefault();
    if (this.#disarmInFlight) return undefined;
    const trap = getTrapFlag(this.#tile);
    if (!trap || trap.disarmed === true || trap.armed === false || !this.#actor?.isOwner) return undefined;
    const trapData = normalizeTrapData(trap.data);
    const disarm = trapData.disarm;
    const remaining = this.#localAttemptsRemaining ?? getTrapDisarmAttemptsRemaining(trap);
    if (remaining <= 0) {
      ui.notifications.warn("Попытки обезвреживания закончились.");
      return this.render({ force: true });
    }
    const tools = getTrapDisarmToolCandidates(this.#actor, disarm);
    const selectedTool = tools.find(tool => tool.itemId === this.#selectedToolId);
    if (!selectedTool) {
      ui.notifications.warn("Нет подходящего инструмента для обезвреживания.");
      return this.render({ force: true });
    }

    this.#disarmInFlight = true;
    try {
      const outcome = await requestSkillCheck({
        actor: this.#actor,
        skillKey: "traps",
        data: { difficulty: disarm.difficulty },
        animate: false,
        createMessage: true,
        prompt: false,
        requester: "trapDisarm"
      });
      const success = isSkillCheckSuccess(outcome);
      const nextRemaining = Math.max(0, remaining - (success ? 0 : 1));
      await requestDisarmTrapDocuments(this.#tile, this.#actor, {
        success,
        toolItemId: selectedTool.itemId,
        attemptsRemaining: nextRemaining
      });
      this.#localAttemptsRemaining = success ? null : nextRemaining;
      if (success) this.#localDisarmed = true;
    } finally {
      this.#disarmInFlight = false;
    }
    return this.render({ force: true });
  }

  static async #onPickupTrap(event) {
    event.preventDefault();
    if (!this.#actor?.isOwner) return undefined;
    await requestPickupTrapDocuments(this.#tile, this.#actor);
    return this.close();
  }

  static #onCloseDialog(event) {
    event.preventDefault();
    return this.close();
  }
}

async function requestPickupTrapDocuments(tile, actor) {
  const request = {
    sceneId: tile?.parent?.id ?? canvas.scene?.id ?? "",
    tileId: tile?.id ?? "",
    actorUuid: actor?.uuid ?? ""
  };
  if (!request.sceneId || !request.tileId || !request.actorUuid) return;
  if (game.user?.isGM) {
    await pickupTrapDocumentsNow(request);
    return;
  }
  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("Нет активного GM для забора ловушки.");
    return;
  }
  game.socket.emit(TRAP_SOCKET, {
    scope: TRAP_SOCKET_SCOPE,
    action: "pickupTrapDocuments",
    gmUserId: gm.id,
    senderUserId: game.user?.id ?? "",
    request
  });
}

async function requestDisarmTrapDocuments(tile, actor, { success = false, toolItemId = "", attemptsRemaining = 0 } = {}) {
  const request = {
    sceneId: tile?.parent?.id ?? canvas.scene?.id ?? "",
    tileId: tile?.id ?? "",
    actorUuid: actor?.uuid ?? "",
    success: Boolean(success),
    toolItemId: String(toolItemId ?? ""),
    attemptsRemaining: Math.max(0, toInteger(attemptsRemaining))
  };
  if (!request.sceneId || !request.tileId || !request.actorUuid) return;
  if (game.user?.isGM) {
    await disarmTrapDocumentsNow(request);
    return;
  }
  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("Нет активного GM для обезвреживания ловушки.");
    return;
  }
  game.socket.emit(TRAP_SOCKET, {
    scope: TRAP_SOCKET_SCOPE,
    action: "disarmTrapDocuments",
    gmUserId: gm.id,
    senderUserId: game.user?.id ?? "",
    request
  });
}

async function pickupTrapDocumentsNow({ sceneId = "", tileId = "", actorUuid = "" } = {}) {
  const scene = game.scenes?.get(sceneId) ?? canvas.scene;
  const tile = scene?.tiles?.get(tileId);
  const actor = actorUuid ? await fromUuid(actorUuid) : null;
  const trap = getTrapFlag(tile);
  if (!scene || !tile || !actor || !trap || !canActorPickupTrap(trap, actor)) return;
  await restoreTrapItemToOwner(actor, trap);
  await deleteTrapDocuments(tile);
}

async function disarmTrapDocumentsNow({ sceneId = "", tileId = "", actorUuid = "", success = false, toolItemId = "", attemptsRemaining = 0 } = {}) {
  const scene = game.scenes?.get(sceneId) ?? canvas.scene;
  const tile = scene?.tiles?.get(tileId);
  const actor = actorUuid ? await fromUuid(actorUuid) : null;
  const trap = getTrapFlag(tile);
  if (!scene || !tile || !actor || !trap || canActorPickupTrap(trap, actor)) return;

  if (success) {
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<p><strong>${escapeHTML(actor.name)}</strong> обезвреживает ловушку <strong>${escapeHTML(tile.name)}</strong>.</p>`
    });
    ui.notifications.info(`${actor.name}: ловушка обезврежена.`);
    await markTrapDisarmed(tile, actor, { toolItemId, attemptsRemaining });
    return;
  }

  const remaining = Math.max(0, toInteger(attemptsRemaining));
  await tile.update({
    [`flags.${SYSTEM_ID}.${TRAP_FLAG}.disarmAttemptsRemaining`]: remaining,
    [`flags.${SYSTEM_ID}.${TRAP_FLAG}.lastDisarmToolItemId`]: String(toolItemId ?? "")
  }, { render: false });
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<p><strong>${escapeHTML(actor.name)}</strong> не смог обезвредить ловушку <strong>${escapeHTML(tile.name)}</strong>. Осталось попыток: ${remaining}.</p>`
  });
  if (remaining <= 0) ui.notifications.warn(`${tile.name}: попытки обезвреживания закончились.`);
}

async function restoreTrapItemToOwner(actor, trap) {
  const sourceItem = trap.sourceItemUuid ? await fromUuid(trap.sourceItemUuid) : null;
  if (sourceItem?.parent?.uuid === actor.uuid) {
    await sourceItem.update({ "system.quantity": getItemQuantity(sourceItem) + 1 });
    return;
  }
  const itemData = foundry.utils.deepClone(trap.itemData ?? {});
  if (!itemData?.name) return;
  delete itemData._id;
  foundry.utils.setProperty(itemData, "system.quantity", 1);
  await actor.createEmbeddedDocuments("Item", [itemData]);
}

function getTrapViewerActor() {
  return (canvas?.tokens?.controlled ?? [])
    .map(token => token?.actor)
    .find(actor => actor?.isOwner) ?? game.user?.character ?? null;
}

async function requestCreateTrapDocuments(request = {}) {
  if (game.user?.isGM) return createTrapDocumentsNow(request);
  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("Нет активного GM для создания ловушки на сцене.");
    return null;
  }
  game.socket.emit(TRAP_SOCKET, {
    scope: TRAP_SOCKET_SCOPE,
    action: "createTrapDocuments",
    gmUserId: gm.id,
    senderUserId: game.user?.id ?? "",
    request: serializeTrapCreateRequest(request)
  });
  return true;
}

async function handleTrapSocketMessage(payload = {}) {
  if (!payload || payload.scope !== TRAP_SOCKET_SCOPE || payload.senderUserId === game.user?.id) return;
  if (!game.user?.isGM || payload.gmUserId !== game.user.id) return;
  if (payload.action === "createTrapDocuments") await createTrapDocumentsNow(payload.request ?? {});
  if (payload.action === "pickupTrapDocuments") await pickupTrapDocumentsNow(payload.request ?? {});
  if (payload.action === "disarmTrapDocuments") await disarmTrapDocumentsNow(payload.request ?? {});
  if (payload.action === "activateTrapTile") await activateTrapTileNow(payload.request ?? {});
  if (payload.action === "resolveTrapDetectionStop") await resolveTrapDetectionStopNow(payload.request ?? {});
  if (payload.action === "announceTrapTriggerEnter") await announceTrapTriggerEnterNow(payload.request ?? {});
}

async function createTrapDocumentsNow(request = {}) {
  const scene = game.scenes?.get(String(request.sceneId ?? "")) ?? canvas.scene;
  if (!scene || !game.user?.isGM) return null;

  const point = serializePoint(request.point);
  const itemData = request.itemData ?? {};
  const trapData = normalizeTrapData(request.trapData);
  const rotation = normalizeTrapRotation(request.rotation);
  const ownerActor = request.ownerActorUuid ? await fromUuid(String(request.ownerActorUuid)) : null;
  const factionState = createTrapFactionState(ownerActor);
  const rect = normalizeTrapPlacementRect(request.placementRect, scene)
    ?? getTrapPlacementRectFromPoint(point, trapData, scene, rotation);
  const clipped = getTrapPlacementClippedArea(rect, scene);
  if (!clipped.polygons.length) {
    ui.notifications.warn(`${String(itemData.name ?? "Ловушка")}: стены полностью отсекают область установки.`);
    return null;
  }
  const width = rect.width;
  const height = rect.height;
  const tileDimensions = getTileDocumentDimensionsForVisualRect(rect, rotation);
  const left = Math.round(rect.x);
  const top = Math.round(rect.y);
  const x = Math.round(left + (width / 2));
  const y = Math.round(top + (height / 2));

  const createdTiles = await scene.createEmbeddedDocuments("Tile", [{
    name: String(itemData.name ?? "Ловушка"),
    texture: {
      src: normalizeImagePath(itemData.img, DEFAULT_TRAP_IMAGE),
      anchorX: 0.5,
      anchorY: 0.5,
      fit: "contain",
      scaleX: trapData.trigger.imageScale,
      scaleY: trapData.trigger.imageScale
    },
    x,
    y,
    width: tileDimensions.width,
    height: tileDimensions.height,
    rotation,
    elevation: Number.isFinite(Number(point.elevation)) ? Number(point.elevation) : 0,
    sort: getNextTileSort(scene),
    hidden: false,
    locked: true,
    flags: {
      [SYSTEM_ID]: {
        [TRAP_FLAG]: {
          armed: true,
          ownerActorUuid: String(request.ownerActorUuid ?? ""),
          ownerPrimaryFaction: factionState.ownerPrimaryFaction,
          safeFactionNames: factionState.safeFactionNames,
          sourceItemUuid: String(request.sourceItemUuid ?? ""),
          itemData: foundry.utils.deepClone(itemData),
          visibleActorUuids: [String(request.ownerActorUuid ?? "")].filter(Boolean),
          attemptedDetectionActorUuids: [],
          disarmAttemptsRemaining: trapData.disarm.attempts,
          lastDisarmToolItemId: "",
          detectionRegionId: "",
          triggerRegionId: "",
          recharging: false,
          rearmAt: 0,
          rechargeStartedAt: 0,
          linkedAction: normalizeTrapLinkedAction(request.linkedAction),
          data: trapData,
          createdAt: Number(game.time?.worldTime) || 0
        }
      }
    }
  }]);
  const tile = createdTiles?.[0] ?? null;
  if (!tile) return null;

  await createTrapActivationDocuments(scene, tile, trapData, rect, clipped, request.ownerActorUuid);
  await processTrapInitialDetection(tile);
  return tile;
}

async function createTrapActivationDocuments(scene, tile, trapData, rect, clipped = null, ownerActorUuid = "") {
  if (!scene || !tile || !game.user?.isGM) return null;
  const normalizedTrapData = normalizeTrapData(trapData);
  const triggerRect = normalizeTrapPlacementRect(rect, scene) ?? getTrapTileRectangle(tile);
  const clippedArea = clipped?.polygons?.length ? clipped : getTrapPlacementClippedArea(triggerRect, scene);
  if (!clippedArea.polygons.length) return null;
  const center = {
    x: Math.round(triggerRect.x + (triggerRect.width / 2)),
    y: Math.round(triggerRect.y + (triggerRect.height / 2))
  };
  const detectionRadius = metersToPixels(normalizedTrapData.detection.radiusMeters, scene, ownerActorUuid);
  const levelId = getRegionRestrictionLevelId(scene);
  const regionData = [];
  if (detectionRadius > 0) {
    regionData.push({
      name: `${tile.name}: обнаружение`,
      color: "#d6c45f",
      shapes: [{
        type: "circle",
        x: center.x,
        y: center.y,
        radius: detectionRadius,
        gridBased: false
      }],
      elevation: { bottom: null, top: null },
      levels: levelId ? [levelId] : [],
      restriction: { enabled: Boolean(levelId), type: "move", priority: 0 },
      visibility: CONST.REGION_VISIBILITY.LAYER,
      highlightMode: "shapes",
      displayMeasurements: false,
      flags: {
        [SYSTEM_ID]: {
          trapRegion: {
            kind: "detection",
            trapTileId: tile.id
          }
        }
      }
    });
  }
  regionData.push({
    name: `${tile.name}: активация`,
    color: "#d85f5f",
    shapes: clippedArea.polygons.map(polygon => ({
      type: "polygon",
      points: polygon.points.map(value => Math.round(value)),
      origin: null
    })),
    elevation: { bottom: null, top: null },
    levels: levelId ? [levelId] : [],
    restriction: { enabled: Boolean(levelId), type: "move", priority: 0 },
    visibility: CONST.REGION_VISIBILITY.LAYER,
    highlightMode: "shapes",
    displayMeasurements: false,
    flags: {
      [SYSTEM_ID]: {
        trapRegion: {
          kind: "activation",
          trapTileId: tile.id
        }
      }
    }
  });

  const regions = await scene.createEmbeddedDocuments("Region", regionData);
  const detectionRegion = regions.find(region => region.getFlag?.(SYSTEM_ID, "trapRegion")?.kind === "detection");
  const triggerRegion = regions.find(region => region.getFlag?.(SYSTEM_ID, "trapRegion")?.kind === "activation");
  await tile.update({
    [`flags.${SYSTEM_ID}.${TRAP_FLAG}.armed`]: true,
    [`flags.${SYSTEM_ID}.${TRAP_FLAG}.recharging`]: false,
    [`flags.${SYSTEM_ID}.${TRAP_FLAG}.rearmAt`]: 0,
    [`flags.${SYSTEM_ID}.${TRAP_FLAG}.rechargeStartedAt`]: 0,
    [`flags.${SYSTEM_ID}.${TRAP_FLAG}.detectionRegionId`]: detectionRegion?.id ?? "",
    [`flags.${SYSTEM_ID}.${TRAP_FLAG}.triggerRegionId`]: triggerRegion?.id ?? "",
    [`flags.${SYSTEM_ID}.${TRAP_FLAG}.attemptedDetectionActorUuids`]: [],
    alpha: 1
  }, { render: false });
  return { detectionRegion, triggerRegion };
}

async function triggerTrap(tile, triggeringToken) {
  const scene = tile.parent ?? canvas.scene;
  const trap = getTrapFlag(tile);
  if (!scene || !trap) return;

  const trapData = normalizeTrapData(trap.data);
  if (trapData.trigger.activationMode === TRAP_LINKED_ACTION_MODE) {
    await triggerLinkedTrapAction(tile, triggeringToken, trap);
    await finishTrapAfterActivation(tile, trapData);
    return;
  }
  const ownerActor = trap.ownerActorUuid ? await fromUuid(trap.ownerActorUuid) : null;
  const center = getTileCenter(tile);
  const damageBase = evaluateActorFormula(trapData.effect.damage, ownerActor, { fallback: 0, minimum: 0, context: "trap damage" });
  const pellets = Math.max(1, evaluateActorFormula(trapData.effect.pellets, ownerActor, { fallback: 1, minimum: 1, context: "trap pellets" }));
  const penetrationPower = evaluateActorFormula(trapData.effect.penetration, ownerActor, { fallback: 0, minimum: 0, context: "trap penetration" });
  const damageTypes = normalizeDamageTypeEntries(trapData.effect.damageTypes, trapData.effect.damageTypeKey);
  const requests = [];

  if (trapData.effect.mode === TRAP_EFFECT_ATTACK_MODE) {
    const targetToken = triggeringToken?.object
      ?? canvas.tokens?.get?.(triggeringToken?.id)
      ?? triggeringToken;
    if (targetToken?.actor) {
      requests.push(...buildWeaponExplosionDamageRequests({
        targetToken,
        center: getTokenCenter(targetToken),
        radiusPixels: 0,
        baseDamage: damageBase,
        pelletCount: pellets,
        damageTypes,
        penetrationPower,
        source: {
          kind: "trapAttack",
          trapTileId: tile.id,
          trapName: tile.name,
          ownerActorUuid: trap.ownerActorUuid,
          sourceItemUuid: trap.sourceItemUuid,
          targetTokenId: targetToken.document?.id ?? targetToken.id ?? ""
        }
      }));
    }
    await playWeaponExplosionAnimation({
      weaponData: {
        volley: {
          explosionAnimationKey: trapData.triggerAnimationKey,
          explosionSoundPath: trapData.triggerSoundPath
        }
      },
      center,
      radiusPixels: 0
    });
    if (requests.length) await requestDamageApplications(requests);
    await finishTrapAfterActivation(tile, trapData);
    return;
  }

  const triggerRect = getTrapTileRectangle(tile);
  const radiusPixels = metersToPixels(trapData.effect.damageRadiusMeters, scene, trap.ownerActorUuid);
  const targets = getTrapDamageTargets(scene, triggerRect, radiusPixels, triggeringToken);

  for (const token of targets) {
    const actor = token.actor;
    if (!actor) continue;
    let damageMultiplier = 1;
    if (trapData.evasion.difficulty !== null) {
      const targetDistance = getPointDistanceFromRectangle(getTokenCenter(token), triggerRect);
      const evasionDifficulty = getTrapEvasionDifficultyAtDistance(
        trapData.evasion.difficulty,
        targetDistance,
        radiusPixels
      );
      const outcome = await requestSkillCheck({
        actor,
        skillKey: trapData.evasion.skillKey,
        data: { difficulty: evasionDifficulty },
        animate: false,
        createMessage: true,
        prompt: false,
        requester: "trapEvasion"
      });
      if (isSkillCheckSuccess(outcome)) {
        damageMultiplier = Math.max(0, 1 - (trapData.evasion.avoidPercent / 100));
      }
    }
    requests.push(...buildWeaponExplosionDamageRequests({
      targetToken: token.object ?? canvas.tokens?.get?.(token.id) ?? token,
      center,
      radiusPixels,
      baseDamage: damageBase,
      pelletCount: pellets,
      damageTypes,
      penetrationPower,
      damageModifier: amount => Math.round(amount * damageMultiplier),
      source: {
        kind: "trap",
        trapTileId: tile.id,
        trapName: tile.name,
        ownerActorUuid: trap.ownerActorUuid,
        sourceItemUuid: trap.sourceItemUuid,
        blastCenter: serializePoint(center),
        blastRadius: trapData.effect.damageRadiusMeters
      }
    }));
  }

  await playWeaponExplosionAnimation({
    weaponData: {
      volley: {
        explosionAnimationKey: trapData.triggerAnimationKey,
        explosionSoundPath: trapData.triggerSoundPath
      }
    },
    center,
    radiusPixels
  });
  if (requests.length) await requestDamageApplications(requests);
  await createTrapEffectRegion(scene, tile, trapData, center, ownerActor);
  await finishTrapAfterActivation(tile, trapData);
}

async function triggerLinkedTrapAction(tile, triggeringToken, trap) {
  const scene = tile?.parent ?? canvas.scene;
  const trapData = normalizeTrapData(trap?.data);
  const linkedAction = normalizeTrapLinkedAction(trap?.linkedAction);
  const targetToken = triggeringToken?.object
    ?? canvas.tokens?.get?.(triggeringToken?.id)
    ?? triggeringToken;
  const attackerDocument = scene?.tokens?.get(linkedAction?.tokenId ?? "");
  const attackerToken = attackerDocument?.object ?? canvas.tokens?.get?.(attackerDocument?.id);
  const weapon = attackerDocument?.actor?.items?.get(linkedAction?.weaponItemId ?? "");

  await playWeaponExplosionAnimation({
    weaponData: {
      volley: {
        explosionAnimationKey: trapData.triggerAnimationKey,
        explosionSoundPath: trapData.triggerSoundPath
      }
    },
    center: getTileCenter(tile),
    radiusPixels: 0
  });

  if (!linkedAction
    || !targetToken?.actor
    || !attackerToken?.actor
    || attackerToken.actor.uuid !== linkedAction.actorUuid
    || !weapon) {
    ui.notifications.warn(`${tile?.name ?? "Ловушка"}: связанный актёр или оружие недоступны.`);
    return false;
  }
  const executed = await executeWeaponAttackAgainstToken({
    attackerToken,
    targetToken,
    weapon,
    actionKey: linkedAction.actionKey,
    weaponFunctionId: linkedAction.weaponFunctionId
  });
  if (!executed) {
    ui.notifications.warn(`${attackerToken.name}: действие «${linkedAction.actionName || linkedAction.actionKey}» сейчас невозможно.`);
  }
  return executed;
}

async function createTrapEffectRegion(scene, tile, trapData, center, ownerActor) {
  const radiusPixels = metersToPixels(trapData.effect.regionRadius, scene, ownerActor);
  const damageEntries = (Array.isArray(trapData.effect.regionDamageEntries) ? trapData.effect.regionDamageEntries : [])
    .map(entry => ({
      damageTypeKey: String(entry?.damageTypeKey ?? "").trim(),
      amount: String(entry?.amount ?? "0").trim() || "0"
    }))
    .filter(entry => entry.damageTypeKey && isFormulaTextConfigured(entry.amount));
  if (!radiusPixels || !damageEntries.length) return null;

  const levelId = getRegionRestrictionLevelId(scene);
  const created = await scene.createEmbeddedDocuments("Region", [{
    name: `${tile.name}: область`,
    color: "#dd8431",
    shapes: [{
      type: "circle",
      x: center.x,
      y: center.y,
      radius: radiusPixels,
      gridBased: false
    }],
    elevation: { bottom: null, top: null },
    levels: levelId ? [levelId] : [],
    restriction: { enabled: Boolean(levelId), type: "move", priority: 0 },
    visibility: CONST.REGION_VISIBILITY.ALWAYS,
    highlightMode: "shapes",
    displayMeasurements: false,
    behaviors: [{
      name: game.i18n.localize("FALLOUTMAW.RegionBehavior.PeriodicDamage.Name"),
      type: PERIODIC_DAMAGE_REGION_BEHAVIOR_TYPE,
      system: {
        damageEntries,
        intervalSeconds: DEFAULT_REGION_DAMAGE_INTERVAL_SECONDS,
        delaySeconds: Math.max(0, toInteger(trapData.effect.regionDelaySeconds)),
        durationSeconds: Math.max(0, toInteger(trapData.effect.regionDurationSeconds)),
        radiusDeltaMeters: Number(trapData.effect.regionRadiusDeltaMeters) || 0,
        deleteRegionWhenExpired: true
      }
    }]
  }]);
  return created?.[0] ?? null;
}

async function finishTrapAfterActivation(tile, trapData) {
  const rechargeSeconds = getTrapRechargeSeconds(trapData);
  if (rechargeSeconds <= 0) return deleteTrapDocuments(tile);
  return startTrapRecharge(tile, rechargeSeconds);
}

async function startTrapRecharge(tile, rechargeSeconds) {
  const scene = tile?.parent ?? canvas.scene;
  const trap = getTrapFlag(tile);
  if (!scene || !tile || !trap || !game.user?.isGM) return null;
  await deleteTrapRegions(tile);
  const now = Number(game.time?.worldTime) || 0;
  await tile.update({
    alpha: 0.45,
    "texture.tint": "#777777",
    [`flags.${SYSTEM_ID}.${TRAP_FLAG}.armed`]: false,
    [`flags.${SYSTEM_ID}.${TRAP_FLAG}.recharging`]: true,
    [`flags.${SYSTEM_ID}.${TRAP_FLAG}.rechargeStartedAt`]: now,
    [`flags.${SYSTEM_ID}.${TRAP_FLAG}.rearmAt`]: now + Math.max(1, toInteger(rechargeSeconds)),
    [`flags.${SYSTEM_ID}.${TRAP_FLAG}.detectionRegionId`]: "",
    [`flags.${SYSTEM_ID}.${TRAP_FLAG}.triggerRegionId`]: ""
  }, { render: false });
  queueTrapTileVisibilityRefresh();
  return tile;
}

async function processDueTrapRecharges() {
  if (!game.user?.isGM || !canvas?.ready || !canvas.scene) return;
  const now = Number(game.time?.worldTime) || 0;
  const dueTiles = (canvas.scene.tiles?.contents ?? [])
    .filter(tile => {
      const trap = getTrapFlag(tile);
      return trap?.recharging === true
        && trap.disarmed !== true
        && Number(trap.rearmAt) > 0
        && Number(trap.rearmAt) <= now;
    })
    .sort((left, right) => (Number(getTrapFlag(left)?.rearmAt) || 0) - (Number(getTrapFlag(right)?.rearmAt) || 0));
  for (const tile of dueTiles) {
    await restoreTrapFromRecharge(tile);
  }
}

async function restoreTrapFromRecharge(tile) {
  const scene = tile?.parent ?? canvas.scene;
  const trap = getTrapFlag(tile);
  if (!scene || !tile || !trap || !game.user?.isGM) return null;
  await deleteTrapRegions(tile);
  const trapData = normalizeTrapData(trap.data);
  const rect = getTrapTileRectangle(tile);
  const clipped = getTrapPlacementClippedArea(rect, scene);
  if (!clipped.polygons.length) return null;
  const created = await createTrapActivationDocuments(scene, tile, trapData, rect, clipped, trap.ownerActorUuid);
  if (!created) return null;
  await tile.update({
    alpha: 1,
    "texture.tint": "#ffffff"
  }, { render: false });
  queueTrapTileVisibilityRefresh();
  await processTrapInitialDetection(tile);
  return tile;
}

async function deleteTrapDocuments(tile) {
  const scene = tile?.parent ?? canvas.scene;
  const trap = getTrapFlag(tile);
  if (!scene || !tile || !trap) return;
  await deleteTrapRegions(tile);
  await scene.deleteEmbeddedDocuments("Tile", [tile.id]);
  queueTrapTileVisibilityRefresh();
}

async function deleteTrapRegions(tile) {
  const scene = tile?.parent ?? canvas.scene;
  const trap = getTrapFlag(tile);
  if (!scene || !tile || !trap) return;
  const regionIds = [trap.detectionRegionId, trap.triggerRegionId].filter(id => scene.regions?.get(id));
  if (regionIds.length) await scene.deleteEmbeddedDocuments("Region", regionIds);
}

async function markTrapDisarmed(tile, actor = null, { toolItemId = "", attemptsRemaining = null } = {}) {
  const trap = getTrapFlag(tile);
  if (!tile || !trap || !game.user?.isGM) return;
  await deleteTrapRegions(tile);
  const visible = new Set(asStringArray(trap.visibleActorUuids));
  if (actor?.uuid) visible.add(actor.uuid);
  await tile.update({
    hidden: false,
    alpha: 1,
    "texture.tint": "#ffffff",
    [`flags.${SYSTEM_ID}.${TRAP_FLAG}.armed`]: false,
    [`flags.${SYSTEM_ID}.${TRAP_FLAG}.disarmed`]: true,
    [`flags.${SYSTEM_ID}.${TRAP_FLAG}.recharging`]: false,
    [`flags.${SYSTEM_ID}.${TRAP_FLAG}.rearmAt`]: 0,
    [`flags.${SYSTEM_ID}.${TRAP_FLAG}.rechargeStartedAt`]: 0,
    [`flags.${SYSTEM_ID}.${TRAP_FLAG}.visibleActorUuids`]: Array.from(visible),
    [`flags.${SYSTEM_ID}.${TRAP_FLAG}.disarmAttemptsRemaining`]: attemptsRemaining === null ? getTrapDisarmAttemptsRemaining(trap) : Math.max(0, toInteger(attemptsRemaining)),
    [`flags.${SYSTEM_ID}.${TRAP_FLAG}.lastDisarmToolItemId`]: String(toolItemId ?? ""),
    [`flags.${SYSTEM_ID}.${TRAP_FLAG}.detectionRegionId`]: "",
    [`flags.${SYSTEM_ID}.${TRAP_FLAG}.triggerRegionId`]: ""
  }, { render: false });
  queueTrapTileVisibilityRefresh();
}

function patchTrapTileVisibility() {
  if (trapTilePatchRegistered) return;
  const TileClass = CONFIG.Tile?.objectClass;
  if (!TileClass?.prototype) return;
  const originalRefreshVisibility = TileClass.prototype._refreshVisibility;
  const originalCanView = TileClass.prototype._canView;
  const originalCanHover = TileClass.prototype._canHover;
  const originalOnClickLeft2 = TileClass.prototype._onClickLeft2;

  TileClass.prototype._refreshVisibility = function(...args) {
    const result = originalRefreshVisibility?.apply(this, args);
    if (isTrapTileDocument(this.document) && !isTrapVisibleForCurrentViewer(this.document)) {
      this.visible = false;
      if (this.mesh) this.mesh.visible = false;
      if (this.bg) this.bg.visible = false;
      if (this.controls) this.controls.visible = false;
    }
    return result;
  };

  TileClass.prototype._canView = function(user, event) {
    if (isTrapTileDocument(this.document) && !isTrapVisibleForCurrentViewer(this.document)) return false;
    return originalCanView.call(this, user, event);
  };

  TileClass.prototype._canHover = function(user, event) {
    if (isTrapTileDocument(this.document) && !isTrapVisibleForCurrentViewer(this.document)) return false;
    return originalCanHover.call(this, user, event);
  };

  TileClass.prototype._onClickLeft2 = function(event) {
    if (!isTrapTileDocument(this.document) || !shouldOpenGmTrapFreeDialog()) return originalOnClickLeft2.call(this, event);
    event?.stopPropagation?.();
    void openTrapGmFreeDialog(this.document);
    return false;
  };

  trapTilePatchRegistered = true;
}

function shouldOpenGmTrapFreeDialog() {
  return Boolean(game.user?.isGM && !(canvas?.tokens?.controlled ?? []).length);
}

async function openTrapGmFreeDialog(tile) {
  const trap = getTrapFlag(tile);
  if (!game.user?.isGM || !trap) return;
  const disarmed = trap.disarmed === true || trap.armed === false;
  const action = await DialogV2.wait({
    window: { title: tile.name || "Ловушка" },
    content: `<p><strong>${escapeHTML(tile.name || "Ловушка")}</strong></p>`,
    buttons: disarmed
      ? [
          { action: "delete", label: "Удалить", icon: "fa-solid fa-trash" },
          { action: "cancel", label: "Отмена", icon: "fa-solid fa-xmark", type: "button" }
        ]
      : [
          { action: "disarm", label: "Обезвредить", icon: "fa-solid fa-screwdriver-wrench" },
          { action: "apply", label: "Применить", icon: "fa-solid fa-burst" },
          { action: "delete", label: "Удалить", icon: "fa-solid fa-trash" },
          { action: "cancel", label: "Отмена", icon: "fa-solid fa-xmark", type: "button" }
        ],
    rejectClose: false,
    modal: true,
    position: { width: 380 }
  });
  if (action === "disarm") return markTrapDisarmed(tile, null);
  if (action === "delete") return deleteTrapDocuments(tile);
  if (action === "apply") return triggerTrap(tile, null);
  return undefined;
}

function refreshTrapTileVisibility() {
  refreshTrapSafeHighlights();
  for (const tile of canvas?.tiles?.placeables ?? []) {
    if (!isTrapTileDocument(tile.document)) continue;
    tile.renderFlags?.set?.({ refreshVisibility: true, refreshState: true });
  }
}

function queueTrapTileVisibilityRefresh() {
  if (trapVisibilityRefreshQueued) return;
  trapVisibilityRefreshQueued = true;
  globalThis.setTimeout(() => {
    trapVisibilityRefreshQueued = false;
    refreshTrapTileVisibility();
    refreshTrapInteractionHighlights();
  }, 0);
}

function isTrapVisibleForCurrentViewer(tileDocument) {
  const trap = getTrapFlag(tileDocument);
  if (!trap) return true;
  const controlled = (canvas?.tokens?.controlled ?? []).filter(token => token?.actor);
  if (game.user?.isGM && !controlled.length) return true;
  const actors = getTrapCurrentViewerActors();
  if (!actors.length) return false;
  return actors.some(actor => isTrapKnownToActor(trap, actor)) && isTrapInCurrentVision(tileDocument);
}

function refreshTrapSafeHighlights() {
  const grid = canvas?.interface?.grid;
  if (!canvas?.ready || !grid) return;
  const layer = grid.getHighlightLayer?.(TRAP_SAFE_HIGHLIGHT_LAYER)
    ?? grid.addHighlightLayer?.(TRAP_SAFE_HIGHLIGHT_LAYER);
  layer?.clear?.();
  if (!layer) return;
  const actors = getTrapCurrentViewerActors();
  if (!actors.length) return;
  for (const tile of canvas.scene?.tiles?.contents ?? []) {
    if (!isTrapTileDocument(tile)) continue;
    if (!isTrapVisibleForCurrentViewer(tile)) continue;
    const trap = getTrapFlag(tile);
    const color = actors.some(actor => isActorSafeForTrap(trap, actor))
      ? TRAP_SAFE_HIGHLIGHT_COLOR
      : TRAP_HOSTILE_HIGHLIGHT_COLOR;
    drawTrapActivationHighlight(layer, tile, color);
  }
}

function refreshTrapInteractionHighlights() {
  const grid = canvas?.interface?.grid;
  if (!canvas?.ready || !grid) return;
  const layer = grid.getHighlightLayer?.(TRAP_INTERACTION_HIGHLIGHT_LAYER)
    ?? grid.addHighlightLayer?.(TRAP_INTERACTION_HIGHLIGHT_LAYER);
  layer?.clear?.();
  if (!layer || !activeTrapInteraction) return;
  const actor = getActiveTrapInteractionActor();
  if (!actor) return;
  for (const tile of canvas.scene?.tiles?.contents ?? []) {
    if (!isTrapTileDocument(tile) || !isTrapVisibleToActor(tile, actor)) continue;
    drawTrapInnerOutline(layer, tile, TRAP_INTERACTION_HIGHLIGHT_COLOR);
  }
}

function drawTrapActivationHighlight(layer, tile, color) {
  const polygons = getTrapActivationPolygons(tile);
  if (!polygons.length) return;
  const width = Math.max(2, CONFIG.Canvas.objectBorderThickness * canvas.dimensions.uiScale);
  layer.lineStyle(width, color, 0.95);
  layer.beginFill(color, 0.16);
  for (const polygon of polygons) layer.drawPolygon(polygon.points);
  layer.endFill();
}

function drawTrapInnerOutline(layer, tile, color) {
  const width = Math.max(2, CONFIG.Canvas.objectBorderThickness * canvas.dimensions.uiScale);
  const rect = getTrapTileRectangle(tile);
  const line = Math.min(width, rect.width / 2, rect.height / 2);
  layer.beginFill(color, 0.95);
  layer.drawRect(rect.x, rect.y, rect.width, line);
  layer.drawRect(rect.x, rect.y + rect.height - line, rect.width, line);
  layer.drawRect(rect.x, rect.y + line, line, Math.max(0, rect.height - (line * 2)));
  layer.drawRect(rect.x + rect.width - line, rect.y + line, line, Math.max(0, rect.height - (line * 2)));
  layer.endFill();
}

function isTrapSafeForCurrentViewer(tileDocument) {
  const trap = getTrapFlag(tileDocument);
  if (!trap) return false;
  return getTrapCurrentViewerActors().some(actor => isActorSafeForTrap(trap, actor));
}

function getTrapCurrentViewerActors() {
  const controlled = (canvas?.tokens?.controlled ?? [])
    .map(token => token?.actor)
    .filter(Boolean);
  if (controlled.length) return controlled;
  return [game.user?.character].filter(Boolean);
}

function getTrapFlag(tileOrDocument) {
  return tileOrDocument?.getFlag?.(SYSTEM_ID, TRAP_FLAG)
    ?? tileOrDocument?.document?.getFlag?.(SYSTEM_ID, TRAP_FLAG)
    ?? null;
}

function isTrapTileDocument(tileDocument) {
  return Boolean(tileDocument?.getFlag?.(SYSTEM_ID, TRAP_FLAG));
}

function findFirstTrapMovementEvent(tokenDocument, actor, movement = {}, trapTiles = []) {
  const samples = getMovementSamples(tokenDocument, movement);
  if (!actor || samples.length < 2) return null;

  for (let index = 1; index < samples.length; index += 1) {
    const segmentSamples = getGridMovementSamplesBetween(tokenDocument, samples[index - 1], samples[index]);
    for (let segmentIndex = 1; segmentIndex < segmentSamples.length; segmentIndex += 1) {
      const previous = segmentSamples[segmentIndex - 1];
      const current = segmentSamples[segmentIndex];
      const candidates = [];
      for (const tile of trapTiles) {
        const trap = getTrapFlag(tile);
        if (!trap || trap.armed === false || trap.ownerActorUuid === actor.uuid || isActorSafeForTrap(trap, actor)) continue;

        const trapData = normalizeTrapData(trap.data);
        const detectionRadius = metersToPixels(trapData.detection.radiusMeters, tile.parent ?? canvas.scene, trap.ownerActorUuid);
        const attempted = new Set(asStringArray(trap.attemptedDetectionActorUuids));
        if (detectionRadius > 0 && !attempted.has(actor.uuid)) {
          const center = getTileCenter(tile);
          const isDetected = Math.hypot(current.point.x - center.x, current.point.y - center.y) <= detectionRadius;
          if (isDetected && canTokenSeeTrap(tile, tokenDocument, { observerPoint: current.point })) {
            candidates.push({ type: "detection", tile, priority: 0, waypoint: current.waypoint });
          }
        }

        const wasInsideTrigger = isPointInsideTile(tile, previous.point);
        const isInsideTrigger = isPointInsideTile(tile, current.point);
        if (!wasInsideTrigger && isInsideTrigger) {
          const type = trapData.trigger.activationMode !== "exit" ? "triggerImmediate" : "triggerEnter";
          candidates.push({ type, tile, priority: 1, waypoint: current.waypoint });
        }
        if (trapData.trigger.activationMode === "exit" && wasInsideTrigger && !isInsideTrigger) {
          candidates.push({ type: "triggerExit", tile, priority: 2, waypoint: previous.waypoint });
        }
      }
      if (candidates.length) {
        candidates.sort((left, right) => left.priority - right.priority);
        const { type, tile, waypoint } = candidates[0];
        return { type, tile, waypoint };
      }
    }
  }
  return null;
}

function getMovementSamples(tokenDocument, movement = {}) {
  const waypoints = [
    {},
    ...(movement.passed?.waypoints ?? []),
    movement.destination
  ].filter(Boolean);
  const samples = waypoints
    .map(waypoint => ({ waypoint, point: getTokenCenterAt(tokenDocument, waypoint) }))
    .filter(sample => sample.point);
  const unique = [];
  const seen = new Set();
  for (const sample of samples) {
    const key = `${Math.round(sample.point.x)}:${Math.round(sample.point.y)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(sample);
  }
  return unique;
}

function getGridMovementSamplesBetween(tokenDocument, previous, current) {
  const start = previous?.point;
  const end = current?.point;
  if (!start || !end) return [previous, current].filter(Boolean);

  const scene = tokenDocument?.parent ?? canvas.scene;
  const gridSize = Math.max(1, getSceneGridSize(scene));
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  const steps = Math.max(1, Math.ceil(distance / Math.max(1, gridSize / 3)));
  const samples = [previous];
  const seen = new Set([getMovementSampleKey(previous)]);

  for (let step = 1; step < steps; step += 1) {
    const point = interpolatePoint(start, end, step / steps);
    const waypoint = createSnappedWaypointAtTokenCenter(tokenDocument, point, current.waypoint);
    const key = getPositionKey(waypoint);
    if (seen.has(key)) continue;
    seen.add(key);
    samples.push({ waypoint, point: getTokenCenterAt(tokenDocument, waypoint) });
  }

  const currentWaypoint = createSnappedWaypointAtTokenCenter(tokenDocument, current.point, current.waypoint);
  const currentKey = getPositionKey(currentWaypoint);
  if (!seen.has(currentKey)) samples.push({ waypoint: currentWaypoint, point: getTokenCenterAt(tokenDocument, currentWaypoint) });
  return samples.filter(sample => sample?.point);
}

async function runTrapMovementInterruption(tokenDocument, movement, event) {
  const key = `${tokenDocument?.parent?.id ?? ""}:${tokenDocument?.id ?? ""}:${movement?.id ?? ""}:${event?.type ?? ""}`;
  if (!tokenDocument || !event?.tile || pendingTrapMovementKeys.has(key)) return;
  pendingTrapMovementKeys.add(key);
  try {
    await moveTokenToTrapEvent(tokenDocument, event.waypoint, movement);
    if (event.type === "detection") await requestTrapDetectionStop(event.tile, tokenDocument);
    else if (event.type === "triggerEnter") await requestTrapTriggerEnterNotice(event.tile, tokenDocument);
    else if (event.type === "triggerImmediate") await requestTrapActivation(event.tile, tokenDocument, { announce: true });
    else if (event.type === "triggerExit") await requestTrapActivation(event.tile, tokenDocument);
  } finally {
    pendingTrapMovementKeys.delete(key);
  }
}

async function moveTokenToTrapEvent(tokenDocument, waypoint = {}, movement = {}) {
  const destination = prepareTrapMovementWaypoint(waypoint, tokenDocument);
  await tokenDocument.move([destination], {
    [TRAP_CONTROLLED_MOVEMENT_OPTION]: true,
    autoRotate: Boolean(movement?.autoRotate),
    showRuler: false
  });
  await waitForTrapMovementAnimation(tokenDocument);
}

function prepareTrapMovementWaypoint(waypoint = {}, tokenDocument = null) {
  return {
    x: waypoint.x ?? tokenDocument?._source?.x ?? tokenDocument?.x,
    y: waypoint.y ?? tokenDocument?._source?.y ?? tokenDocument?.y,
    elevation: waypoint.elevation ?? tokenDocument?._source?.elevation ?? tokenDocument?.elevation,
    width: waypoint.width ?? tokenDocument?._source?.width ?? tokenDocument?.width,
    height: waypoint.height ?? tokenDocument?._source?.height ?? tokenDocument?.height,
    depth: waypoint.depth ?? tokenDocument?._source?.depth ?? tokenDocument?.depth,
    shape: waypoint.shape ?? tokenDocument?._source?.shape ?? tokenDocument?.shape,
    level: waypoint.level ?? tokenDocument?._source?.level ?? tokenDocument?.level,
    action: waypoint.action,
    snapped: waypoint.snapped,
    explicit: waypoint.explicit,
    checkpoint: true
  };
}

function createSnappedWaypointAtTokenCenter(tokenDocument, point, sourceWaypoint = {}) {
  const document = tokenDocument?.document ?? tokenDocument;
  const width = sourceWaypoint?.width ?? document?._source?.width ?? document?.width;
  const height = sourceWaypoint?.height ?? document?._source?.height ?? document?.height;
  const depth = sourceWaypoint?.depth ?? document?._source?.depth ?? document?.depth;
  const shape = sourceWaypoint?.shape ?? document?._source?.shape ?? document?.shape;
  const level = sourceWaypoint?.level ?? document?._source?.level ?? document?.level;
  let pivot = null;
  if (typeof document?.getCenterPoint === "function") {
    pivot = document.getCenterPoint({ x: 0, y: 0, elevation: 0, width, height, depth, shape, level });
  }
  const size = getSceneGridSize(document?.parent ?? canvas.scene);
  const rawPosition = {
    x: Math.round(point.x - (Number(pivot?.x) || ((Number(width) || 1) * size / 2))),
    y: Math.round(point.y - (Number(pivot?.y) || ((Number(height) || 1) * size / 2))),
    elevation: sourceWaypoint?.elevation ?? document?._source?.elevation ?? document?.elevation,
    width,
    height,
    depth,
    shape,
    level
  };
  const snapped = document?.getSnappedPosition?.(rawPosition) ?? rawPosition;
  return {
    ...sourceWaypoint,
    x: Math.round(Number(snapped.x ?? rawPosition.x) || 0),
    y: Math.round(Number(snapped.y ?? rawPosition.y) || 0),
    elevation: snapped.elevation ?? rawPosition.elevation,
    width,
    height,
    depth,
    shape,
    level,
    snapped: true,
    checkpoint: true
  };
}

async function waitForTrapMovementAnimation(tokenDocument) {
  await new Promise(resolve => requestAnimationFrame(resolve));
  try {
    await (tokenDocument?.movement?.animation?.ended ?? tokenDocument?.object?.movementAnimationPromise);
  } catch (_error) {
    // Foundry movement can be cancelled by another module; trap resolution should continue at the stopped point.
  }
}

function getPositionKey(waypoint = {}) {
  return `${Math.round(Number(waypoint?.x) || 0)}:${Math.round(Number(waypoint?.y) || 0)}:${Math.round(Number(waypoint?.elevation) || 0)}`;
}

function getMovementSampleKey(sample = {}) {
  const waypoint = sample.waypoint ?? {};
  if (Number.isFinite(Number(waypoint.x)) && Number.isFinite(Number(waypoint.y))) return getPositionKey(waypoint);
  const point = sample.point ?? {};
  return `${Math.round(Number(point.x) || 0)}:${Math.round(Number(point.y) || 0)}:${Math.round(Number(waypoint.elevation) || 0)}`;
}

function interpolatePoint(start, end, t) {
  return {
    x: start.x + ((end.x - start.x) * Math.max(0, Math.min(1, t))),
    y: start.y + ((end.y - start.y) * Math.max(0, Math.min(1, t)))
  };
}

function isTrapVisibleToActor(tile, actor) {
  const trap = getTrapFlag(tile);
  if (!trap || !actor) return false;
  if (!isTrapKnownToActor(trap, actor)) return false;
  return isTrapInCurrentVision(tile);
}

async function revealTrapToActor(tile, actor) {
  if (!tile || !actor?.uuid) return false;
  const trap = getTrapFlag(tile);
  if (!trap) return false;
  const visible = new Set(asStringArray(trap.visibleActorUuids));
  if (visible.has(actor.uuid)) return false;
  visible.add(actor.uuid);
  await tile.update({ [`flags.${SYSTEM_ID}.${TRAP_FLAG}.visibleActorUuids`]: Array.from(visible) }, { render: false });
  refreshTrapTileVisibility();
  return true;
}

function canActorPickupTrap(trap, actor) {
  return Boolean(actor?.uuid && (
    trap?.disarmed === true
    || (trap?.armed === false && trap?.recharging !== true)
    || actor.uuid === trap?.ownerActorUuid
    || isActorSafeForTrap(trap, actor)
  ));
}

function isActorSafeForTrap(trap, actor) {
  if (!trap || !actor) return false;
  if (actor.uuid === trap.ownerActorUuid) return true;
  const ownerActor = fromUuidSyncSafe(trap.ownerActorUuid);
  if (ownerActor && isActorFactionSafeForOwner(ownerActor, actor)) return true;
  const safeFactions = new Set(asStringArray(trap.safeFactionNames));
  if (!safeFactions.size) return false;
  const actorFactions = getActorTrapFactionNames(actor);
  return actorFactions.some(name => safeFactions.has(name));
}

function isActorFactionSafeForOwner(ownerActor, actor) {
  return getActorTrapFactionNames(actor).some(factionName => getRelationTo(ownerActor, factionName) === "ally");
}

function createTrapFactionState(ownerActor) {
  const ownerPrimaryFaction = normalizeTrapFactionName(getActorPrimaryFaction(ownerActor));
  const safeFactionNames = new Set();
  for (const factionName of getActorTrapFactionNames(ownerActor)) safeFactionNames.add(factionName);
  for (const factionName of getFactionNamesWithDefault(getFactionSettings())) {
    const normalized = normalizeTrapFactionName(factionName);
    if (!normalized) continue;
    if (getRelationTo(ownerActor, normalized) === "ally") safeFactionNames.add(normalized);
  }
  return {
    ownerPrimaryFaction,
    safeFactionNames: Array.from(safeFactionNames)
  };
}

function getActorTrapFactionNames(actor) {
  const names = new Set([
    ...getActorFactionBelongs(actor),
    getActorPrimaryFaction(actor)
  ].map(normalizeTrapFactionName).filter(Boolean));
  return Array.from(names);
}

function normalizeTrapFactionName(value) {
  const name = String(value ?? "").trim();
  if (!name || name === DEFAULT_FACTION_NAME) return "";
  return name;
}

function fromUuidSyncSafe(uuid) {
  try {
    return globalThis.fromUuidSync?.(uuid) ?? null;
  } catch (_error) {
    return null;
  }
}

function getTokenCenterAt(tokenDocument, data = {}) {
  const document = tokenDocument?.document ?? tokenDocument;
  if (typeof document?.getCenterPoint === "function") {
    const center = document.getCenterPoint(data);
    return { x: Number(center.x) || 0, y: Number(center.y) || 0 };
  }
  const size = getSceneGridSize(document?.parent ?? canvas.scene);
  return {
    x: (Number(data.x ?? document?.x) || 0) + ((Number(data.width ?? document?.width) || 1) * size / 2),
    y: (Number(data.y ?? document?.y) || 0) + ((Number(data.height ?? document?.height) || 1) * size / 2)
  };
}

function getTrapDamageTargets(scene, triggerRect, radiusPixels, triggeringToken) {
  const triggering = triggeringToken?.document ?? triggeringToken ?? null;
  const tokens = scene.tokens?.contents ?? [];
  const targets = tokens
    .filter(token => token?.actor)
    .filter(token => {
      if (radiusPixels <= 0) return token.id === triggering?.id;
      return getPointDistanceFromRectangle(getTokenCenter(token), triggerRect) <= radiusPixels;
    });
  if (!targets.length && triggering?.actor) return [triggering];
  return targets;
}

function getTrapEvasionDifficultyAtDistance(baseDifficulty, distancePixels, radiusPixels) {
  const base = Math.max(0, toInteger(baseDifficulty));
  if (base <= 0 || radiusPixels <= 0) return base;
  const distanceRatio = Math.max(0, Math.min(1, Number(distancePixels) / radiusPixels));
  return Math.max(0, Math.round(base * (1 - (0.8 * distanceRatio))));
}

function getPointDistanceFromRectangle(point, rect) {
  const left = Number(rect?.x) || 0;
  const top = Number(rect?.y) || 0;
  const right = left + Math.max(0, Number(rect?.width) || 0);
  const bottom = top + Math.max(0, Number(rect?.height) || 0);
  const x = Number(point?.x) || 0;
  const y = Number(point?.y) || 0;
  const nearestX = Math.max(left, Math.min(right, x));
  const nearestY = Math.max(top, Math.min(bottom, y));
  return Math.hypot(x - nearestX, y - nearestY);
}

function normalizeTrapData(source = {}) {
  const data = foundry.utils.deepClone(source ?? {});
  return {
    enabled: data.enabled !== false,
    actionPointCost: Math.max(0, toInteger(data.actionPointCost)),
    installation: {
      difficulty: Math.max(0, toInteger(data.installation?.difficulty)),
      skillKey: String(data.installation?.skillKey ?? "traps").trim() || "traps"
    },
    detection: {
      radiusMeters: String(data.detection?.radiusMeters ?? "1").trim() || "1",
      difficulty: Math.max(0, toInteger(data.detection?.difficulty)),
      skillKey: String(data.detection?.skillKey ?? "naturalist").trim() || "naturalist",
      conditions: normalizeTrapDetectionConditions(data.detection?.conditions)
    },
    trigger: {
      activationMode: normalizeTrapActivationMode(data.trigger?.activationMode),
      widthCells: Math.max(1, toInteger(data.trigger?.widthCells) || 1),
      heightCells: Math.max(1, toInteger(data.trigger?.heightCells) || 1),
      imageScale: normalizeTrapImageScale(data.trigger?.imageScale)
    },
    recharge: {
      value: normalizeTrapRechargeValue(data.recharge?.value),
      unit: normalizeTrapRechargeUnit(data.recharge?.unit)
    },
    evasion: {
      difficulty: normalizeNullableDifficulty(data.evasion?.difficulty),
      skillKey: String(data.evasion?.skillKey ?? "athletics").trim() || "athletics",
      avoidPercent: Math.max(1, Math.min(100, toInteger(data.evasion?.avoidPercent) || 50))
    },
    disarm: {
      toolKey: String(data.disarm?.toolKey ?? "mechanicalHacking").trim() || "mechanicalHacking",
      toolClass: normalizeToolClass(data.disarm?.toolClass),
      difficulty: normalizeTrapDisarmNumber(data.disarm?.difficulty, 60),
      attempts: normalizeTrapDisarmNumber(data.disarm?.attempts, 1)
    },
    effect: {
      mode: normalizeTrapEffectMode(data.effect?.mode),
      damageRadiusMeters: String(data.effect?.damageRadiusMeters ?? "0").trim() || "0",
      penetration: String(data.effect?.penetration ?? "0").trim() || "0",
      damage: String(data.effect?.damage ?? "0").trim() || "0",
      pellets: String(data.effect?.pellets ?? "1").trim() || "1",
      damageTypeKey: String(data.effect?.damageTypeKey ?? "firearm").trim() || "firearm",
      damageTypes: normalizeDamageTypeEntries(data.effect?.damageTypes, data.effect?.damageTypeKey),
      regionRadius: String(data.effect?.regionRadius ?? "0").trim() || "0",
      regionDamageEntries: normalizeRegionDamageEntries(data.effect?.regionDamageEntries),
      regionDurationSeconds: String(data.effect?.regionDurationSeconds ?? "0").trim() || "0",
      regionDelaySeconds: String(data.effect?.regionDelaySeconds ?? "0").trim() || "0",
      regionRadiusDeltaMeters: String(data.effect?.regionRadiusDeltaMeters ?? "0").trim() || "0"
    },
    triggerAnimationKey: String(data.triggerAnimationKey ?? "").trim(),
    triggerSoundPath: String(data.triggerSoundPath ?? "").trim()
  };
}

function normalizeNullableDifficulty(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  return Math.max(0, toInteger(value));
}

function normalizeTrapActivationMode(value) {
  const mode = String(value ?? "exit").trim();
  return ["enter", "exit", TRAP_LINKED_ACTION_MODE].includes(mode) ? mode : "exit";
}

function normalizeTrapRechargeValue(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Math.max(0, toInteger(value));
  return number > 0 ? number : null;
}

function normalizeTrapRechargeUnit(value) {
  const unit = String(value ?? "seconds").trim();
  return Object.hasOwn(TRAP_RECHARGE_UNITS, unit) ? unit : "seconds";
}

function normalizeTrapEffectMode(value) {
  const mode = String(value ?? TRAP_EFFECT_EXPLOSION_MODE).trim();
  return mode === TRAP_EFFECT_ATTACK_MODE ? TRAP_EFFECT_ATTACK_MODE : TRAP_EFFECT_EXPLOSION_MODE;
}

function normalizeTrapDetectionConditions(conditions = []) {
  const normalized = (Array.isArray(conditions) ? conditions : Object.values(conditions ?? {}))
    .map(condition => {
      const type = condition?.type === TRAP_DETECTION_LIGHTING_CONDITION
        ? TRAP_DETECTION_LIGHTING_CONDITION
        : "";
      return {
        id: String(condition?.id ?? "").trim(),
        type,
        thresholds: type === TRAP_DETECTION_LIGHTING_CONDITION
          ? (Array.isArray(condition?.thresholds) ? condition.thresholds : Object.values(condition?.thresholds ?? {}))
            .map(threshold => ({
              illuminationPercent: Math.max(0, Math.min(100, toInteger(threshold?.illuminationPercent))),
              difficultyBonus: Math.max(0, toInteger(threshold?.difficultyBonus))
            }))
          : []
      };
    });
  const lightingIndex = normalized.findIndex(condition => condition.type === TRAP_DETECTION_LIGHTING_CONDITION);
  return normalized.filter((condition, index) => (
    condition.type !== TRAP_DETECTION_LIGHTING_CONDITION || index === lightingIndex
  ));
}

function getTrapDetectionLightingDifficultyBonus(tile, trapData) {
  const condition = trapData?.detection?.conditions
    ?.find(entry => entry.type === TRAP_DETECTION_LIGHTING_CONDITION);
  if (!condition?.thresholds?.length) return 0;
  const illuminationPercent = getTrapIlluminationPercent(tile);
  return condition.thresholds.reduce((bonus, threshold) => (
    illuminationPercent <= threshold.illuminationPercent
      ? Math.max(bonus, threshold.difficultyBonus)
      : bonus
  ), 0);
}

function getTrapIlluminationPercent(tile) {
  const samples = getTrapVisibilityTestPoints(tile).map(point => analyzeLightingPoint(point));
  const brightest = samples.reduce(
    (best, sample) => sample.effectiveDarkness < best.effectiveDarkness ? sample : best,
    samples[0] ?? analyzeLightingPoint(getTileCenter(tile))
  );
  return Math.max(0, Math.min(100, Math.round((1 - brightest.effectiveDarkness) * 100)));
}

function getTrapRechargeSeconds(trapData = {}) {
  const recharge = normalizeTrapData(trapData).recharge;
  if (!recharge.value) return 0;
  return Math.max(0, recharge.value * (TRAP_RECHARGE_UNITS[recharge.unit] ?? 1));
}

function normalizeTrapLinkedAction(source = null) {
  if (!source || typeof source !== "object") return null;
  const action = {
    sceneId: String(source.sceneId ?? "").trim(),
    tokenId: String(source.tokenId ?? "").trim(),
    actorUuid: String(source.actorUuid ?? "").trim(),
    weaponItemId: String(source.weaponItemId ?? "").trim(),
    weaponFunctionId: String(source.weaponFunctionId ?? ITEM_FUNCTIONS.weapon).trim() || ITEM_FUNCTIONS.weapon,
    actionKey: String(source.actionKey ?? "").trim(),
    actorName: String(source.actorName ?? "").trim(),
    weaponName: String(source.weaponName ?? "").trim(),
    actionName: String(source.actionName ?? "").trim()
  };
  if (!action.tokenId || !action.actorUuid || !action.weaponItemId || !action.actionKey) return null;
  return action;
}

function normalizeTrapImageScale(value) {
  const scale = Number(value);
  if (!Number.isFinite(scale)) return 0.5;
  return Math.max(0, scale);
}

function normalizeTrapDisarmNumber(value, fallback) {
  if (value === null || value === undefined || String(value).trim() === "") return fallback;
  return Math.max(0, toInteger(value));
}

function normalizeToolClass(value) {
  const toolClass = String(value ?? "D").trim().toUpperCase();
  return Object.hasOwn(TOOL_CLASS_RANKS, toolClass) ? toolClass : "D";
}

function isToolClassAtLeast(actualClass, requiredClass) {
  return (TOOL_CLASS_RANKS[normalizeToolClass(actualClass)] ?? 0) >= (TOOL_CLASS_RANKS[normalizeToolClass(requiredClass)] ?? 0);
}

function getTrapDisarmAttemptsRemaining(trap) {
  const configured = normalizeTrapData(trap?.data).disarm.attempts;
  const stored = trap?.disarmAttemptsRemaining;
  if (stored === null || stored === undefined || stored === "") return configured;
  return Math.max(0, toInteger(stored));
}

function getTrapDisarmToolCandidates(actor, disarm = {}) {
  const requiredToolKey = String(disarm.toolKey ?? "").trim();
  const requiredClass = normalizeToolClass(disarm.toolClass);
  if (!actor || !requiredToolKey) return [];
  return (actor.items?.contents ?? [])
    .flatMap(item => getEnabledToolFunctions(item)
      .filter(tool => String(tool.toolKey ?? "") === requiredToolKey)
      .map(tool => {
        const supplyMax = Math.max(0, toInteger(tool.supply?.max));
        const supplyValue = Math.max(0, Math.min(supplyMax || Number.MAX_SAFE_INTEGER, toInteger(tool.supply?.value)));
        return {
          item,
          itemId: item.id,
          name: item.name,
          img: item.img,
          toolKey: String(tool.toolKey ?? ""),
          toolClass: normalizeToolClass(tool.toolClass),
          supplyValue,
          supplyMax
        };
      }))
    .filter(tool => isToolClassAtLeast(tool.toolClass, requiredClass) && tool.supplyValue > 0)
    .sort((left, right) => {
      const rankDelta = (TOOL_CLASS_RANKS[right.toolClass] ?? 0) - (TOOL_CLASS_RANKS[left.toolClass] ?? 0);
      if (rankDelta) return rankDelta;
      return String(left.name ?? "").localeCompare(String(right.name ?? ""));
    });
}

function normalizeDamageTypeEntries(entries = [], fallbackKey = "firearm") {
  const source = Array.isArray(entries) ? entries : Object.values(entries ?? {});
  const normalized = source
    .map(entry => ({
      damageTypeKey: String(entry?.damageTypeKey ?? entry?.key ?? "").trim(),
      percent: Math.max(0, Math.min(100, toInteger(entry?.percent)))
    }))
    .filter(entry => entry.damageTypeKey);
  if (!normalized.length) return [{ damageTypeKey: String(fallbackKey ?? "firearm").trim() || "firearm", percent: 100 }];
  if (!normalized.some(entry => entry.percent > 0)) normalized[0].percent = 100;
  return normalized;
}

function normalizeRegionDamageEntries(entries = []) {
  return (Array.isArray(entries) ? entries : Object.values(entries ?? {}))
    .map(entry => ({
      damageTypeKey: String(entry?.damageTypeKey ?? "").trim(),
      amount: String(entry?.amount ?? "0").trim() || "0"
    }))
    .filter(entry => entry.damageTypeKey || isFormulaTextConfigured(entry.amount));
}

function metersToPixels(value, scene, actorOrUuid = null) {
  const actor = typeof actorOrUuid === "string"
    ? (globalThis.fromUuidSync?.(actorOrUuid) ?? null)
    : actorOrUuid;
  const meters = evaluateActorFormula(value, actor, { fallback: 0, minimum: 0, context: "trap distance" });
  if (meters <= 0) return 0;
  const size = getSceneGridSize(scene);
  const distance = Math.max(1, Number(scene?.grid?.distance ?? canvas?.grid?.distance ?? 1) || 1);
  return meters * (size / distance);
}

function getSceneGridSize(scene) {
  return Math.max(1, Number(scene?.grid?.size ?? canvas?.grid?.size ?? 100) || 100);
}

function getTileCenter(tile) {
  const topLeft = getTileTopLeft(tile);
  const dimensions = getTileEffectiveDimensions(tile);
  return {
    x: topLeft.x + (dimensions.width / 2),
    y: topLeft.y + (dimensions.height / 2)
  };
}

function getTrapTileRectangle(tile) {
  const topLeft = getTileTopLeft(tile);
  const dimensions = getTileEffectiveDimensions(tile);
  return new PIXI.Rectangle(topLeft.x, topLeft.y, dimensions.width, dimensions.height);
}

function getTileTopLeft(tile) {
  const { width, height } = getTileEffectiveDimensions(tile);
  const texture = tile?.texture ?? tile?.document?.texture ?? {};
  const anchorX = Number.isFinite(Number(texture.anchorX)) ? Number(texture.anchorX) : 0.5;
  const anchorY = Number.isFinite(Number(texture.anchorY)) ? Number(texture.anchorY) : 0.5;
  return {
    x: (Number(tile?.x) || 0) - (anchorX * width),
    y: (Number(tile?.y) || 0) - (anchorY * height)
  };
}

function getTileEffectiveDimensions(tile) {
  const width = Math.abs(Number(tile?.width) || 0);
  const height = Math.abs(Number(tile?.height) || 0);
  const rotation = normalizeTrapRotation(tile?.rotation ?? tile?.document?.rotation);
  if (rotation === 90 || rotation === 270) return { width: height, height: width };
  return { width, height };
}

function getTokenCenter(token) {
  const document = token?.document ?? token;
  const object = document?.object ?? token?.object ?? token;
  if (object?.center) return { x: Number(object.center.x) || 0, y: Number(object.center.y) || 0 };
  const size = getSceneGridSize(document?.parent ?? canvas.scene);
  return {
    x: (Number(document?.x) || 0) + ((Number(document?.width) || 1) * size / 2),
    y: (Number(document?.y) || 0) + ((Number(document?.height) || 1) * size / 2)
  };
}

function getTrapPlacementRectFromPoint(point, trapData, scene, rotation = 0) {
  const dimensions = getTrapPlacementDimensions(trapData, scene, rotation);
  const width = dimensions.width;
  const height = dimensions.height;
  const center = getSnappedTrapCenter(point, scene, width, height);
  return {
    x: Math.round(center.x - (width / 2)),
    y: Math.round(center.y - (height / 2)),
    width,
    height,
    elevation: Number(point?.elevation) || 0
  };
}

function normalizeTrapPlacementRect(source = null, scene = null) {
  if (!source) return null;
  const x = Number(source.x);
  const y = Number(source.y);
  const width = Number(source.width);
  const height = Number(source.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
    elevation: Number.isFinite(Number(source.elevation)) ? Number(source.elevation) : 0
  };
}

function getTrapPlacementDimensions(trapData, scene, rotation = 0) {
  const size = getSceneGridSize(scene);
  const baseWidth = Math.max(1, toInteger(trapData?.trigger?.widthCells) || 1) * size;
  const baseHeight = Math.max(1, toInteger(trapData?.trigger?.heightCells) || 1) * size;
  const normalizedRotation = normalizeTrapRotation(rotation);
  if (normalizedRotation === 90 || normalizedRotation === 270) return { width: baseHeight, height: baseWidth };
  return { width: baseWidth, height: baseHeight };
}

function getTileDocumentDimensionsForVisualRect(rect, rotation = 0) {
  const width = Math.max(1, Math.round(Number(rect?.width) || 0));
  const height = Math.max(1, Math.round(Number(rect?.height) || 0));
  const normalizedRotation = normalizeTrapRotation(rotation);
  if (normalizedRotation === 90 || normalizedRotation === 270) return { width: height, height: width };
  return { width, height };
}

function getSnappedTrapCenter(point, scene, width, height) {
  const size = getSceneGridSize(scene);
  const source = { x: Number(point?.x) || 0, y: Number(point?.y) || 0 };
  if (canvas.scene?.id === scene?.id && canvas.grid && !canvas.grid.isGridless && canvas.grid.isSquare) {
    const modes = CONST.GRID_SNAPPING_MODES;
    const modeX = getTrapCenterSnapMode(width, size, modes);
    const modeY = getTrapCenterSnapMode(height, size, modes);
    if (canvas.grid.getSnappedPoint) {
      if (modeX === modeY) return canvas.grid.getSnappedPoint(source, { mode: modeX, resolution: 1 });
      return {
        x: canvas.grid.getSnappedPoint(source, { mode: modeX, resolution: 1 }).x,
        y: canvas.grid.getSnappedPoint(source, { mode: modeY, resolution: 1 }).y
      };
    }
  }
  return {
    x: snapTrapCenterCoordinate(source.x, size, width),
    y: snapTrapCenterCoordinate(source.y, size, height)
  };
}

function getTrapCenterSnapMode(length, gridSize, modes) {
  const cells = Math.max(1, Math.round((Number(length) || gridSize) / gridSize));
  return cells % 2 === 0 ? modes.VERTEX : modes.CENTER;
}

function snapTrapCenterCoordinate(value, gridSize, length) {
  const cells = Math.max(1, Math.round((Number(length) || gridSize) / gridSize));
  if (cells % 2 === 0) return Math.round((Number(value) || 0) / gridSize) * gridSize;
  return (Math.round(((Number(value) || 0) - (gridSize / 2)) / gridSize) * gridSize) + (gridSize / 2);
}

function normalizeTrapRotation(rotation = 0) {
  const value = Math.round((Number(rotation) || 0) / 90) * 90;
  return ((value % 360) + 360) % 360;
}

function getTrapPlacementClippedArea(rect, scene) {
  const rectangle = new PIXI.Rectangle(
    Number(rect?.x) || 0,
    Number(rect?.y) || 0,
    Math.max(1, Number(rect?.width) || 0),
    Math.max(1, Number(rect?.height) || 0)
  ).normalize();
  const emptyResult = { polygons: [], bounds: null };
  if (canvas.scene?.id !== scene?.id) return emptyResult;

  const backend = CONFIG.Canvas?.polygonBackends?.move;
  const level = canvas.level;
  if (!backend?.create || !level?.parent) return emptyResult;

  const origin = {
    x: rectangle.x + (rectangle.width / 2),
    y: rectangle.y + (rectangle.height / 2),
    elevation: Number(rect?.elevation) || 0
  };
  try {
    const polygon = backend.create(origin, {
      type: "move",
      level,
      edgeTypes: { wall: { mode: 2 } },
      boundaryShapes: [rectangle],
      radius: Math.hypot(rectangle.width, rectangle.height),
      angle: 360
    });
    return normalizeTrapPlacementPolygons(polygon);
  } catch (error) {
    console.warn(`${SYSTEM_ID} | Trap placement wall clipping failed`, error);
    return emptyResult;
  }
}

function normalizeTrapPlacementPolygons(polygon) {
  const polygons = [];
  const source = Array.isArray(polygon?.polygons) && polygon.polygons.length ? polygon.polygons : [polygon];
  for (const entry of source) {
    const points = Array.isArray(entry?.points) ? entry.points : [];
    if (points.length < 6) continue;
    const normalized = new PIXI.Polygon(points.map(value => Math.round(Number(value) || 0)));
    if (getPolygonArea(normalized) <= 1) continue;
    polygons.push(normalized);
  }
  if (!polygons.length) return { polygons: [], bounds: null };
  return {
    polygons,
    bounds: getBoundingRectForPolygons(polygons)
  };
}

function getBoundingRectForPolygons(polygons = []) {
  const points = polygons.flatMap(getPolygonPointObjects);
  if (!points.length) return null;
  const minX = Math.min(...points.map(point => point.x));
  const minY = Math.min(...points.map(point => point.y));
  const maxX = Math.max(...points.map(point => point.x));
  const maxY = Math.max(...points.map(point => point.y));
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY)
  };
}

function getPolygonPointObjects(polygon) {
  const points = Array.isArray(polygon?.points) ? polygon.points : [];
  const result = [];
  for (let index = 0; index < points.length - 1; index += 2) {
    result.push({
      x: Number(points[index]) || 0,
      y: Number(points[index + 1]) || 0
    });
  }
  return result;
}

function getPolygonArea(polygon) {
  const points = getPolygonPointObjects(polygon);
  if (points.length < 3) return 0;
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += (current.x * next.y) - (next.x * current.y);
  }
  return Math.abs(area / 2);
}

function getTrapVisibilityTestPoints(tileDocument) {
  const rect = getTrapTileRectangle(tileDocument);
  const elevation = Number(tileDocument?.elevation ?? tileDocument?.document?.elevation) || 0;
  const insetX = Math.min(rect.width / 4, Math.max(1, rect.width / 2));
  const insetY = Math.min(rect.height / 4, Math.max(1, rect.height / 2));
  return [
    { x: rect.x + (rect.width / 2), y: rect.y + (rect.height / 2), elevation },
    { x: rect.x + insetX, y: rect.y + insetY, elevation },
    { x: rect.x + rect.width - insetX, y: rect.y + insetY, elevation },
    { x: rect.x + rect.width - insetX, y: rect.y + rect.height - insetY, elevation },
    { x: rect.x + insetX, y: rect.y + rect.height - insetY, elevation }
  ];
}

function canTokenSeeTrap(tileDocument, token, { observerPoint = null } = {}) {
  if (!canvas?.ready || !canvas?.visibility) return false;
  if (!canvas.visibility.tokenVision) return true;

  const tokenDocument = token?.document ?? token;
  const tokenObject = tokenDocument?.object ?? token?.object;
  const VisionSource = CONFIG.Canvas.visionSourceClass;
  if (!tokenDocument || !tokenObject?.hasSight || !VisionSource) return false;
  if (typeof tokenObject._getVisionSourceData !== "function") return false;
  if (typeof canvas.visibility._createVisibilityTestConfig !== "function") return false;

  const source = new VisionSource({
    sourceId: `${tokenObject.sourceId ?? tokenDocument.id}.trap-visibility.${foundry.utils.randomID()}`,
    object: tokenObject
  });
  try {
    Object.assign(source.blinded, tokenObject._getVisionBlindedStates?.() ?? {});
    const sourceData = tokenObject._getVisionSourceData();
    const origin = observerPoint ?? getTokenCenter(tokenDocument);
    source.initialize({
      ...sourceData,
      x: Number(origin?.x) || 0,
      y: Number(origin?.y) || 0,
      elevation: Number(origin?.elevation ?? sourceData?.elevation ?? tokenDocument.elevation) || 0,
      disabled: false,
      preview: false
    });
    if (source.isBlinded) return false;

    const points = getTrapVisibilityTestPoints(tileDocument);
    const object = tileDocument?.object ?? tileDocument?.document?.object ?? null;
    const config = canvas.visibility._createVisibilityTestConfig(points, { tolerance: 0, object });
    for (const modeId of ["basicSight", "lightPerception"]) {
      const mode = tokenDocument.detectionModes?.[modeId];
      const detectionMode = CONFIG.Canvas.detectionModes?.[modeId];
      if (mode && detectionMode?.testVisibility(source, mode, config) === true) return true;
    }
    return false;
  } catch (error) {
    console.error(`${SYSTEM_ID} | Trap vision test failed`, error);
    return false;
  } finally {
    source.destroy();
  }
}

function isTrapInCurrentVision(tileDocument) {
  if (!canvas?.visibility || !canvas?.ready) return false;
  if (!canvas.visibility.tokenVision) return true;
  const points = getTrapVisibilityTestPoints(tileDocument);
  const object = tileDocument?.object ?? tileDocument?.document?.object ?? null;
  return canvas.visibility.testVisibility(points, { tolerance: 0, object });
}

function isTrapKnownToActor(trap, actor) {
  if (!trap || !actor?.uuid) return false;
  if (trap.disarmed === true || trap.armed === false) return true;
  const visible = new Set(asStringArray(trap.visibleActorUuids));
  return actor.uuid === trap.ownerActorUuid || visible.has(actor.uuid) || isActorSafeForTrap(trap, actor);
}

function getTrapActivationPolygons(tileDocument) {
  const scene = tileDocument?.parent ?? canvas.scene;
  const trap = getTrapFlag(tileDocument);
  const regionId = String(trap?.triggerRegionId ?? "");
  const region = regionId ? scene?.regions?.get(regionId) : null;
  const shapes = Array.from(region?.shapes ?? []);
  const polygons = [];
  for (const shape of shapes) {
    if (shape?.type !== "polygon" || !Array.isArray(shape.points) || shape.points.length < 6) continue;
    const polygon = new PIXI.Polygon(shape.points.map(value => Math.round(Number(value) || 0)));
    if (getPolygonArea(polygon) <= 1) continue;
    polygons.push(polygon);
  }
  return polygons;
}

function isPointInsideTile(tile, point) {
  const { x: left, y: top } = getTileTopLeft(tile);
  const { width, height } = getTileEffectiveDimensions(tile);
  return point.x >= left && point.x <= left + width && point.y >= top && point.y <= top + height;
}

function getNextTileSort(scene) {
  return Math.max(0, ...(scene?.tiles?.contents ?? []).map(tile => Number(tile.sort) || 0)) + 1;
}

function getRegionRestrictionLevelId(scene) {
  if (canvas.scene?.id === scene?.id && canvas.level?.id) return canvas.level.id;
  return scene?._view ?? scene?.initialLevel?.id ?? scene?.firstLevel?.id ?? "";
}

async function consumeTrapItem(item) {
  const quantity = getItemQuantity(item);
  if (quantity <= 0) return false;
  const nextQuantity = Math.max(0, quantity - 1);
  if (nextQuantity <= 0) await item.delete();
  else await item.update({ "system.quantity": nextQuantity });
  return true;
}

function serializeTrapCreateRequest(request = {}) {
  return {
    sceneId: String(request.sceneId ?? ""),
    point: serializePoint(request.point),
    ownerActorUuid: String(request.ownerActorUuid ?? ""),
    sourceItemUuid: String(request.sourceItemUuid ?? ""),
    itemData: foundry.utils.deepClone(request.itemData ?? {}),
    trapData: normalizeTrapData(request.trapData),
    placementRect: normalizeTrapPlacementRect(request.placementRect),
    rotation: normalizeTrapRotation(request.rotation),
    linkedAction: normalizeTrapLinkedAction(request.linkedAction)
  };
}

function serializePoint(point = {}) {
  return {
    x: Number(point?.x) || 0,
    y: Number(point?.y) || 0,
    elevation: Number(point?.elevation) || 0
  };
}

function asStringArray(value) {
  return (Array.isArray(value) ? value : [])
    .map(entry => String(entry ?? "").trim())
    .filter(Boolean);
}

function isSkillCheckSuccess(outcome) {
  const key = String(outcome?.result?.key ?? "");
  return key === "success" || key === "criticalSuccess";
}

function getResponsibleGM() {
  return game.users?.activeGM ?? (game.users?.contents ?? [])
    .filter(user => user.active && user.isGM)
    .sort((left, right) => left.id.localeCompare(right.id))
    .at(0) ?? null;
}

function createTrapTokenRequest(tile, token) {
  return {
    sceneId: tile?.parent?.id ?? canvas.scene?.id ?? "",
    tileId: tile?.id ?? "",
    tokenId: token?.id ?? token?.document?.id ?? ""
  };
}

function pauseGameForTrap() {
  if (!game.user?.isGM || game.paused) return;
  game.togglePause(true, { broadcast: true });
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[character]));
}
