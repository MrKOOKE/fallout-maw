import { SYSTEM_ID } from "../constants.mjs";
import { requestSkillCheck } from "../rolls/skill-check.mjs";
import { canSpendCombatActionPoints, spendCombatActionPoints } from "../combat/reaction-resources.mjs";
import { requestDamageApplications } from "../combat/damage-hub.mjs";
import { playWeaponExplosionAnimation } from "../combat/attack-animations.mjs";
import { evaluateActorFormula, isFormulaTextConfigured } from "../utils/actor-formulas.mjs";
import { normalizeImagePath } from "../utils/actor-display-data.mjs";
import { getItemQuantity } from "../utils/inventory-containers.mjs";
import { ITEM_FUNCTIONS, getTrapFunction, hasItemFunction } from "../utils/item-functions.mjs";
import { selectRandomWeightedLimbKey } from "../utils/limb-randomization.mjs";
import { toInteger } from "../utils/numbers.mjs";
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

let activeTrapPlacement = null;
let trapTilePatchRegistered = false;
let trapCanvasInteractionRegistered = false;
let trapCanvasInteractionView = null;
let trapVisibilityRefreshQueued = false;
const pendingTrapActivationKeys = new Set();
const pendingTrapMovementKeys = new Set();

export function registerTrapHooks() {
  game.socket.on(TRAP_SOCKET, handleTrapSocketMessage);
  patchTrapTileVisibility();
  registerTrapCanvasInteractions();
  Hooks.on("canvasReady", () => {
    patchTrapTileVisibility();
    registerTrapCanvasInteractions();
    refreshTrapTileVisibility();
  });
  Hooks.on("controlToken", refreshTrapTileVisibility);
  Hooks.on("updateActor", (actor, changes = {}) => {
    const flat = foundry.utils.flattenObject(changes ?? {});
    if (`flags.${SYSTEM_ID}.factionBelongs` in flat || `flags.${SYSTEM_ID}.factionRelations` in flat) refreshTrapTileVisibility();
  });
  Hooks.on("createTile", tile => {
    if (isTrapTileDocument(tile)) refreshTrapTileVisibility();
  });
  Hooks.on("updateTile", tile => {
    if (isTrapTileDocument(tile)) refreshTrapTileVisibility();
  });
  Hooks.on("deleteTile", tile => {
    if (isTrapTileDocument(tile)) queueTrapTileVisibilityRefresh();
  });
  Hooks.on("preMoveToken", onTrapPreMoveToken);
  Hooks.on("createToken", token => {
    void processTrapContactForToken(token);
  });
  Hooks.on("canvasTearDown", cancelActiveTrapPlacement);
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
    preview: null
  };
  await createTrapPlacementPreview(activeTrapPlacement);
  const view = canvas.app?.view;
  view?.addEventListener("pointermove", onTrapPlacementPointerMove, { capture: true });
  view?.addEventListener("pointerdown", onTrapPlacementPointerDown, { capture: true });
  view?.addEventListener("contextmenu", onTrapPlacementContextMenu, { capture: true });
  window.addEventListener("keydown", onTrapPlacementKeyDown, { capture: true });
  ui.notifications.info(`${item.name}: выберите точку установки ловушки. Esc/ПКМ отменяет.`);
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

async function handleTrapDetectionForToken(tile, token) {
  if (!game.user?.isActiveGM) return;
  const actor = token?.actor ?? token?.document?.actor;
  const trap = getTrapFlag(tile);
  if (!tile || !actor || !trap) return false;
  if (actor.uuid === trap.ownerActorUuid) return false;
  if (isActorSafeForTrap(trap, actor)) {
    await revealTrapToActor(tile, actor);
    return true;
  }

  const attempted = new Set(asStringArray(trap.attemptedDetectionActorUuids));
  if (attempted.has(actor.uuid)) return false;
  attempted.add(actor.uuid);
  await tile.update({ [`flags.${SYSTEM_ID}.${TRAP_FLAG}.attemptedDetectionActorUuids`]: Array.from(attempted) }, { render: false });

  const difficulty = Math.max(0, toInteger(trap.data?.detection?.difficulty));
  const skillKey = String(trap.data?.detection?.skillKey ?? "naturalist");
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

async function requestTrapActivation(tile, token) {
  const sceneId = tile?.parent?.id ?? canvas.scene?.id ?? "";
  const tileId = tile?.id ?? "";
  const tokenId = token?.id ?? token?.document?.id ?? "";
  const key = `${sceneId}:${tileId}:${tokenId}`;
  if (!sceneId || !tileId || !tokenId || pendingTrapActivationKeys.has(key)) return;
  pendingTrapActivationKeys.add(key);
  window.setTimeout(() => pendingTrapActivationKeys.delete(key), 10000);

  if (game.user?.isActiveGM) {
    await activateTrapTileNow({ sceneId, tileId, tokenId });
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
    request: { sceneId, tileId, tokenId }
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

async function activateTrapTileNow({ sceneId = "", tileId = "", tokenId = "" } = {}) {
  const scene = game.scenes?.get(sceneId) ?? canvas.scene;
  const tile = scene?.tiles?.get(tileId);
  const token = scene?.tokens?.get(tokenId);
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
  const rect = getTrapPlacementRectFromPoint(point, trapData, canvas.scene);
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

  const created = await requestCreateTrapDocuments({
    sceneId: canvas.scene?.id ?? placement.sceneId,
    point: rect,
    ownerActorUuid: actor.uuid,
    sourceItemUuid: item.uuid,
    itemData: item.toObject(),
    trapData
  });
  if (!created && !game.user?.isGM) return;
  await consumeTrapItem(item);
  await placement.application?.render?.({ force: true });
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
  updateTrapPlacementPreview(activeTrapPlacement, point);
}

function onTrapPlacementKeyDown(event) {
  if (!activeTrapPlacement || event.key !== "Escape") return;
  event.preventDefault?.();
  event.stopPropagation?.();
  event.stopImmediatePropagation?.();
  cancelActiveTrapPlacement({ notify: true });
}

function cancelActiveTrapPlacement({ notify = false } = {}) {
  if (!activeTrapPlacement) return;
  const view = canvas?.app?.view;
  view?.removeEventListener("pointermove", onTrapPlacementPointerMove, { capture: true });
  view?.removeEventListener("pointerdown", onTrapPlacementPointerDown, { capture: true });
  view?.removeEventListener("contextmenu", onTrapPlacementContextMenu, { capture: true });
  window.removeEventListener("keydown", onTrapPlacementKeyDown, { capture: true });
  destroyTrapPlacementPreview(activeTrapPlacement);
  activeTrapPlacement = null;
  if (notify) ui.notifications.info("Установка ловушки отменена.");
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
  const rect = getTrapPlacementRectFromPoint(point, placement.trapData, canvas.scene);
  preview.container.position.set(rect.x, rect.y);
  preview.graphics.clear()
    .lineStyle(3, PREVIEW_BORDER_COLOR, 0.95)
    .beginFill(PREVIEW_FILL_COLOR, 0.16)
    .drawRect(0, 0, rect.width, rect.height)
    .endFill();
  if (preview.sprite) fitSpriteIntoRect(preview.sprite, rect.width, rect.height, placement.trapData?.trigger?.imageScale);
}

function destroyTrapPlacementPreview(placement) {
  const preview = placement?.preview;
  if (!preview?.container) return;
  preview.container.destroy({ children: true, texture: false, baseTexture: false });
  placement.preview = null;
}

function fitSpriteIntoRect(sprite, width, height, imageScale = 0.5) {
  const textureWidth = Math.max(1, Number(sprite.texture?.width) || 1);
  const textureHeight = Math.max(1, Number(sprite.texture?.height) || 1);
  const scale = Math.min(width / textureWidth, height / textureHeight) * Math.max(0, Number(imageScale) || 0);
  sprite.anchor.set(0.5, 0.5);
  sprite.scale.set(scale, scale);
  sprite.position.set(width / 2, height / 2);
}

function registerTrapCanvasInteractions() {
  const view = canvas?.app?.view;
  if (!view || trapCanvasInteractionView === view) return;
  if (trapCanvasInteractionView && trapCanvasInteractionRegistered) {
    trapCanvasInteractionView.removeEventListener("dblclick", onTrapTileDoubleClick, { capture: true });
  }
  view.addEventListener("dblclick", onTrapTileDoubleClick, { capture: true });
  trapCanvasInteractionView = view;
  trapCanvasInteractionRegistered = true;
}

function onTrapTileDoubleClick(event) {
  const tile = getTrapTileAtCanvasEvent(event);
  if (!tile) return;
  event.preventDefault?.();
  event.stopPropagation?.();
  event.stopImmediatePropagation?.();
  void pickupTrapTile(tile);
}

function getTrapTileAtCanvasEvent(event) {
  if (!Number.isFinite(Number(event?.clientX)) || !Number.isFinite(Number(event?.clientY))) return null;
  const point = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
  return (canvas.scene?.tiles?.contents ?? [])
    .filter(tile => isTrapTileDocument(tile) && isTrapVisibleForCurrentViewer(tile) && isPointInsideTile(tile, point))
    .sort((left, right) => (Number(right.sort) || 0) - (Number(left.sort) || 0))
    .at(0) ?? null;
}

async function pickupTrapTile(tile) {
  const trap = getTrapFlag(tile);
  const actor = getTrapViewerActor();
  if (!trap || !actor || !actor.isOwner || !canActorPickupTrap(trap, actor)) {
    ui.notifications.warn("Забрать ловушку может только владелец, член его фракции или союзник.");
    return;
  }
  const confirmed = await foundry.applications.api.DialogV2.confirm({
    window: { title: "Забрать ловушку" },
    content: `<p>Забрать <strong>${escapeHTML(tile.name)}</strong>?</p>`,
    rejectClose: false,
    modal: true
  });
  if (!confirmed) return;
  await requestPickupTrapDocuments(tile, actor);
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

async function pickupTrapDocumentsNow({ sceneId = "", tileId = "", actorUuid = "" } = {}) {
  const scene = game.scenes?.get(sceneId) ?? canvas.scene;
  const tile = scene?.tiles?.get(tileId);
  const actor = actorUuid ? await fromUuid(actorUuid) : null;
  const trap = getTrapFlag(tile);
  if (!scene || !tile || !actor || !trap || !canActorPickupTrap(trap, actor)) return;
  await restoreTrapItemToOwner(actor, trap);
  await deleteTrapDocuments(tile);
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
  const ownerActor = request.ownerActorUuid ? await fromUuid(String(request.ownerActorUuid)) : null;
  const factionState = createTrapFactionState(ownerActor);
  const gridSize = getSceneGridSize(scene);
  const width = Math.max(1, trapData.trigger.widthCells) * gridSize;
  const height = Math.max(1, trapData.trigger.heightCells) * gridSize;
  const rect = getTrapPlacementRectFromPoint(point, trapData, scene);
  const left = Math.round(rect.x);
  const top = Math.round(rect.y);
  const x = Math.round(left + (width / 2));
  const y = Math.round(top + (height / 2));
  const center = { x, y };

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
    width,
    height,
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
          detectionRegionId: "",
          triggerRegionId: "",
          data: trapData,
          createdAt: Number(game.time?.worldTime) || 0
        }
      }
    }
  }]);
  const tile = createdTiles?.[0] ?? null;
  if (!tile) return null;

  const detectionRadius = metersToPixels(trapData.detection.radiusMeters, scene, request.ownerActorUuid);
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
    shapes: [{
      type: "rectangle",
      x: left,
      y: top,
      width,
      height,
      anchorX: 0,
      anchorY: 0,
      rotation: 0,
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
    [`flags.${SYSTEM_ID}.${TRAP_FLAG}.detectionRegionId`]: detectionRegion?.id ?? "",
    [`flags.${SYSTEM_ID}.${TRAP_FLAG}.triggerRegionId`]: triggerRegion?.id ?? ""
  }, { render: false });
  await processTrapInitialDetection(tile);
  return tile;
}

async function triggerTrap(tile, triggeringToken) {
  const scene = tile.parent ?? canvas.scene;
  const trap = getTrapFlag(tile);
  if (!scene || !trap) return;

  const trapData = normalizeTrapData(trap.data);
  const ownerActor = trap.ownerActorUuid ? await fromUuid(trap.ownerActorUuid) : null;
  const center = getTileCenter(tile);
  const radiusPixels = metersToPixels(trapData.effect.damageRadiusMeters, scene, trap.ownerActorUuid);
  const targets = getTrapDamageTargets(scene, center, radiusPixels, trap.ownerActorUuid, triggeringToken);
  const damageBase = evaluateActorFormula(trapData.effect.damage, ownerActor, { fallback: 0, minimum: 0, context: "trap damage" });
  const pellets = Math.max(1, evaluateActorFormula(trapData.effect.pellets, ownerActor, { fallback: 1, minimum: 1, context: "trap pellets" }));
  const penetrationPower = evaluateActorFormula(trapData.effect.penetration, ownerActor, { fallback: 0, minimum: 0, context: "trap penetration" });
  const damageTypes = normalizeDamageTypeEntries(trapData.effect.damageTypes, trapData.effect.damageTypeKey);
  const requests = [];

  for (const token of targets) {
    const actor = token.actor;
    if (!actor) continue;
    let damage = damageBase;
    if (trapData.evasion.difficulty !== null) {
      const outcome = await requestSkillCheck({
        actor,
        skillKey: trapData.evasion.skillKey,
        data: { difficulty: trapData.evasion.difficulty },
        animate: false,
        createMessage: true,
        prompt: false,
        requester: "trapEvasion"
      });
      if (isSkillCheckSuccess(outcome)) {
        damage = Math.max(0, Math.round(damage * (1 - (trapData.evasion.avoidPercent / 100))));
      }
    }
    for (let pellet = 0; pellet < pellets; pellet += 1) {
      const limbKey = selectRandomWeightedLimbKey(actor);
      for (const entry of distributeDamageByType(damage, damageTypes)) {
        requests.push({
          actor,
          limbKey,
          amount: entry.amount,
          damageTypeKey: entry.damageTypeKey,
          scope: "healthAndLimb",
          applyMitigation: true,
          source: {
            kind: "trap",
            trapTileId: tile.id,
            trapName: tile.name,
            ownerActorUuid: trap.ownerActorUuid,
            sourceItemUuid: trap.sourceItemUuid,
            penetrationPower
          }
        });
      }
    }
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
  await deleteTrapDocuments(tile);
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

async function deleteTrapDocuments(tile) {
  const scene = tile?.parent ?? canvas.scene;
  const trap = getTrapFlag(tile);
  if (!scene || !tile || !trap) return;
  const regionIds = [trap.detectionRegionId, trap.triggerRegionId].filter(id => scene.regions?.get(id));
  if (regionIds.length) await scene.deleteEmbeddedDocuments("Region", regionIds);
  await scene.deleteEmbeddedDocuments("Tile", [tile.id]);
  queueTrapTileVisibilityRefresh();
}

function patchTrapTileVisibility() {
  if (trapTilePatchRegistered) return;
  const TileClass = CONFIG.Tile?.objectClass;
  if (!TileClass?.prototype) return;
  const originalRefreshVisibility = TileClass.prototype._refreshVisibility;
  const originalCanView = TileClass.prototype._canView;
  const originalCanHover = TileClass.prototype._canHover;

  TileClass.prototype._refreshVisibility = function(...args) {
    const result = originalRefreshVisibility?.apply(this, args);
    if (isTrapTileDocument(this.document) && !isTrapVisibleForCurrentViewer(this.document)) {
      if (this.mesh) this.mesh.visible = false;
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

  trapTilePatchRegistered = true;
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
  }, 0);
}

function isTrapVisibleForCurrentViewer(tileDocument) {
  const trap = getTrapFlag(tileDocument);
  if (!trap) return true;
  const controlled = (canvas?.tokens?.controlled ?? []).filter(token => token?.actor);
  if (game.user?.isGM && !controlled.length) return true;
  const actorUuids = controlled.length
    ? controlled.map(token => token.actor.uuid)
    : [game.user?.character?.uuid ?? ""].filter(Boolean);
  if (!actorUuids.length) return false;
  const visible = new Set(asStringArray(trap.visibleActorUuids));
  return actorUuids.some(uuid => {
    if (uuid === trap.ownerActorUuid || visible.has(uuid)) return true;
    const actor = fromUuidSyncSafe(uuid);
    return isActorSafeForTrap(trap, actor);
  });
}

function refreshTrapSafeHighlights() {
  const grid = canvas?.interface?.grid;
  if (!canvas?.ready || !grid) return;
  const layer = grid.getHighlightLayer?.(TRAP_SAFE_HIGHLIGHT_LAYER)
    ?? grid.addHighlightLayer?.(TRAP_SAFE_HIGHLIGHT_LAYER);
  layer?.clear?.();
  if (!layer) return;
  for (const tile of canvas.scene?.tiles?.contents ?? []) {
    if (!isTrapTileDocument(tile)) continue;
    if (!isTrapVisibleForCurrentViewer(tile) || !isTrapSafeForCurrentViewer(tile)) continue;
    drawTrapSafeHighlight(layer, tile);
  }
}

function drawTrapSafeHighlight(layer, tile) {
  const width = Math.max(2, CONFIG.Canvas.objectBorderThickness * canvas.dimensions.uiScale);
  const rect = getTrapTileRectangle(tile);
  const line = Math.min(width, rect.width / 2, rect.height / 2);
  layer.beginFill(TRAP_SAFE_HIGHLIGHT_COLOR, 0.95);
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
          if (isDetected) {
            candidates.push({ type: "detection", tile, priority: 0, waypoint: current.waypoint });
          }
        }

        const wasInsideTrigger = isPointInsideTile(tile, previous.point);
        const isInsideTrigger = isPointInsideTile(tile, current.point);
        if (!wasInsideTrigger && isInsideTrigger) {
          candidates.push({ type: "triggerEnter", tile, priority: 1, waypoint: current.waypoint });
        }
        if (wasInsideTrigger && !isInsideTrigger) {
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
  const visible = new Set(asStringArray(trap.visibleActorUuids));
  return actor.uuid === trap.ownerActorUuid || visible.has(actor.uuid) || isActorSafeForTrap(trap, actor);
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
  return Boolean(actor?.uuid && (actor.uuid === trap?.ownerActorUuid || isActorSafeForTrap(trap, actor)));
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

function getTrapDamageTargets(scene, center, radiusPixels, ownerActorUuid, triggeringToken) {
  const triggering = triggeringToken?.document ?? triggeringToken ?? null;
  const tokens = scene.tokens?.contents ?? [];
  const targets = tokens
    .filter(token => token?.actor)
    .filter(token => {
      if (radiusPixels <= 0) return token.id === triggering?.id;
      const tokenCenter = getTokenCenter(token);
      return Math.hypot(tokenCenter.x - center.x, tokenCenter.y - center.y) <= radiusPixels;
    });
  if (!targets.length && triggering?.actor) return [triggering];
  return targets;
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
      skillKey: String(data.detection?.skillKey ?? "naturalist").trim() || "naturalist"
    },
    trigger: {
      widthCells: Math.max(1, toInteger(data.trigger?.widthCells) || 1),
      heightCells: Math.max(1, toInteger(data.trigger?.heightCells) || 1),
      imageScale: normalizeTrapImageScale(data.trigger?.imageScale)
    },
    evasion: {
      difficulty: normalizeNullableDifficulty(data.evasion?.difficulty),
      skillKey: String(data.evasion?.skillKey ?? "athletics").trim() || "athletics",
      avoidPercent: Math.max(1, Math.min(100, toInteger(data.evasion?.avoidPercent) || 50))
    },
    effect: {
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

function normalizeTrapImageScale(value) {
  const scale = Number(value);
  if (!Number.isFinite(scale)) return 0.5;
  return Math.max(0, scale);
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

function distributeDamageByType(amount, damageTypes = []) {
  const total = Math.max(0, toInteger(amount));
  if (total <= 0) return [];
  const entries = normalizeDamageTypeEntries(damageTypes);
  const percentTotal = entries.reduce((sum, entry) => sum + Math.max(0, entry.percent), 0) || 100;
  let allocated = 0;
  return entries.map((entry, index) => {
    const amountForType = index === entries.length - 1
      ? Math.max(0, total - allocated)
      : Math.max(0, Math.round(total * (entry.percent / percentTotal)));
    allocated += amountForType;
    return { damageTypeKey: entry.damageTypeKey, amount: amountForType };
  }).filter(entry => entry.amount > 0 && entry.damageTypeKey);
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
  return {
    x: topLeft.x + ((Number(tile?.width) || 0) / 2),
    y: topLeft.y + ((Number(tile?.height) || 0) / 2)
  };
}

function getTrapTileRectangle(tile) {
  const topLeft = getTileTopLeft(tile);
  const width = Math.abs(Number(tile?.width) || 0);
  const height = Math.abs(Number(tile?.height) || 0);
  return new PIXI.Rectangle(topLeft.x, topLeft.y, width, height);
}

function getTileTopLeft(tile) {
  const width = Math.abs(Number(tile?.width) || 0);
  const height = Math.abs(Number(tile?.height) || 0);
  const texture = tile?.texture ?? tile?.document?.texture ?? {};
  const anchorX = Number.isFinite(Number(texture.anchorX)) ? Number(texture.anchorX) : 0.5;
  const anchorY = Number.isFinite(Number(texture.anchorY)) ? Number(texture.anchorY) : 0.5;
  return {
    x: (Number(tile?.x) || 0) - (anchorX * width),
    y: (Number(tile?.y) || 0) - (anchorY * height)
  };
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

function getTrapPlacementRectFromPoint(point, trapData, scene) {
  const gridSize = getSceneGridSize(scene);
  const width = Math.max(1, toInteger(trapData?.trigger?.widthCells) || 1) * gridSize;
  const height = Math.max(1, toInteger(trapData?.trigger?.heightCells) || 1) * gridSize;
  const topLeft = getSnappedTopLeft(point, scene);
  return {
    x: Math.round(topLeft.x),
    y: Math.round(topLeft.y),
    width,
    height,
    elevation: Number(point?.elevation) || 0
  };
}

function getSnappedTopLeft(point, scene) {
  if (canvas.scene?.id === scene?.id && canvas.grid && !canvas.grid.isGridless) {
    const source = { x: Number(point?.x) || 0, y: Number(point?.y) || 0 };
    const offset = canvas.grid.getOffset?.(source);
    const topLeft = offset ? canvas.grid.getTopLeftPoint?.(offset) : null;
    if (topLeft) return topLeft;
  }
  const size = getSceneGridSize(scene);
  return {
    x: Math.floor((Number(point?.x) || 0) / size) * size,
    y: Math.floor((Number(point?.y) || 0) / size) * size
  };
}

function isPointInsideTile(tile, point) {
  const { x: left, y: top } = getTileTopLeft(tile);
  const width = Math.abs(Number(tile?.width) || 0);
  const height = Math.abs(Number(tile?.height) || 0);
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
    trapData: normalizeTrapData(request.trapData)
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
