import { SYSTEM_ID } from "../constants.mjs";
import { getCreatureOptions, getCurrencySettings } from "../settings/accessors.mjs";
import { getActorInventoryGridDimensions, getActorRootInventoryGridOptions } from "../utils/actor-display-data.mjs";
import {
  ROOT_CONTAINER_ID,
  createItemStackPartRemovalUpdate,
  createStoredPlacement,
  findFirstAvailableResolvedInventoryPlacement,
  getAllContainedItems,
  getContextInventoryItems,
  getItemMaxStack,
  getItemQuantity,
  getItemStackPartQuantity,
  isContainerItem,
  usesVirtualInventoryStacks
} from "../utils/inventory-containers.mjs";
import { toInteger } from "../utils/numbers.mjs";

export const DROPPED_ITEMS_FLAG = "droppedItems";
export const DROPPED_ITEMS_ACTOR_FLAG = "droppedItemsActor";
const DROPPED_ITEMS_SOCKET = `system.${SYSTEM_ID}`;
const DROPPED_ITEMS_SOCKET_SCOPE = "fallout-maw.droppedItems";
const DROPPED_ITEMS_SOCKET_TIMEOUT = 10000;
const DROPPED_ITEMS_RADIUS_METERS = 2;
const DROPPED_ITEMS_FALLBACK_ICON = "icons/svg/item-bag.svg";

const pendingDroppedItemsSocketRequests = new Map();
const droppedItemsCleanupInProgress = new Set();
let droppedItemsCanvasView = null;
let droppedItemsCanvasDblClickHandler = null;
let droppedItemsSearchOpener = null;

export function registerDroppedItemHooks() {
  game.socket.on(DROPPED_ITEMS_SOCKET, handleDroppedItemsSocketMessage);
  Hooks.on("canvasReady", attachDroppedItemsCanvasInteraction);
  Hooks.on("deleteItem", item => void scheduleDroppedItemsActorCleanup(item?.parent));
  Hooks.on("deleteActor", actor => void cleanupDroppedItemsTileForActor(actor));
  Hooks.on("deleteTile", tile => void cleanupDroppedItemsActorForTile(tile));
}

export function registerDroppedItemsSearchOpener(opener) {
  droppedItemsSearchOpener = typeof opener === "function" ? opener : null;
}

export async function dropActorInventoryItem(actor, item, {
  quantity = 0,
  stackIndex = 0
} = {}) {
  if (!actor || !item) return null;
  const dropped = createDroppedItemEntryFromActorItem(actor, item, { quantity, stackIndex });
  const tile = await addDroppedItemToScene(actor, dropped);
  await removeDroppedItemFromActor(actor, item, dropped.quantity, { stackIndex });
  return tile;
}

export async function dropItemDataForActor(actor, itemData, containedItems = [], {
  quantity = 0,
  sourceActorUuid = ""
} = {}) {
  if (!actor || !itemData) return null;
  const dropped = {
    entryId: foundry.utils.randomID(),
    sourceActorUuid: String(sourceActorUuid || actor.uuid || ""),
    itemData: normalizeDroppedItemData(itemData, quantity),
    containedItems: normalizeDroppedContainedItems(containedItems),
    quantity: Math.max(1, toInteger(quantity) || getItemQuantity(itemData)),
    createdAt: Date.now()
  };
  return addDroppedItemToScene(actor, dropped);
}

export function canDropItemsForActor(actor) {
  return Boolean(canvas?.scene && getActorDropPosition(actor));
}

function attachDroppedItemsCanvasInteraction() {
  if (droppedItemsCanvasView && droppedItemsCanvasDblClickHandler) {
    droppedItemsCanvasView.removeEventListener("dblclick", droppedItemsCanvasDblClickHandler);
  }
  droppedItemsCanvasView = canvas?.app?.view ?? null;
  if (!droppedItemsCanvasView) return;
  droppedItemsCanvasDblClickHandler = event => void onDroppedItemsCanvasDoubleClick(event);
  droppedItemsCanvasView.addEventListener("dblclick", droppedItemsCanvasDblClickHandler);
}

async function onDroppedItemsCanvasDoubleClick(event) {
  const tile = getDroppedItemsTileAtClientPoint(event);
  if (!tile) return;
  event.preventDefault?.();
  event.stopPropagation?.();
  const actor = getDroppedItemsPickupActor();
  if (!actor) {
    ui.notifications.warn("Выберите токен или назначьте персонажа, чтобы забрать выброшенные предметы.");
    return;
  }
  await openDroppedItemsSearch(tile.document ?? tile, actor);
}

function getDroppedItemsTileAtClientPoint(event) {
  if (!canvas?.scene || !canvas?.canvasCoordinatesFromClient) return null;
  const point = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
  return (canvas.tiles?.placeables ?? [])
    .filter(tile => isDroppedItemsTile(tile.document ?? tile))
    .filter(tile => isPointInsideDroppedItemsTile(point, tile.document ?? tile))
    .sort((left, right) => (Number(right.document?.sort) || 0) - (Number(left.document?.sort) || 0))
    .at(0) ?? null;
}

function isPointInsideDroppedItemsTile(point, tile) {
  const center = getTileCenter(tile);
  const halfWidth = Math.max(1, Number(tile?.width) || 1) / 2;
  const halfHeight = Math.max(1, Number(tile?.height) || 1) / 2;
  return Math.abs((Number(point?.x) || 0) - center.x) <= halfWidth
    && Math.abs((Number(point?.y) || 0) - center.y) <= halfHeight;
}

function getDroppedItemsPickupActor() {
  const controlled = canvas?.tokens?.controlled
    ?.map(token => token.actor)
    .find(actor => actor?.testUserPermission?.(game.user, "OWNER"));
  if (controlled) return controlled;
  const character = game.user?.character;
  if (character?.testUserPermission?.(game.user, "OWNER")) return character;
  return game.actors?.contents?.find(actor => actor.testUserPermission?.(game.user, "OWNER")) ?? null;
}

async function openDroppedItemsSearch(tile, actor) {
  if (!droppedItemsSearchOpener) {
    ui.notifications.warn("Окно обыска еще не готово.");
    return;
  }
  try {
    const result = game.user?.isGM
      ? await performDroppedItemsActorEnsure({
        sceneId: tile.parent?.id ?? canvas?.scene?.id ?? "",
        tileId: tile.id
      }, game.user?.id ?? "")
      : await requestDroppedItemsSocket("ensureDroppedItemsActor", {
        sceneId: tile.parent?.id ?? canvas?.scene?.id ?? "",
        tileId: tile.id
      });
    const droppedActor = await fromUuid(String(result?.actorUuid ?? ""));
    if (!droppedActor) throw new Error("Выброшенные предметы не найдены.");
    await droppedItemsSearchOpener({
      searcherActor: actor,
      searchedActor: droppedActor
    });
  } catch (error) {
    console.error(`${SYSTEM_ID} | Dropped items search failed`, error);
    ui.notifications.warn(error.message || "Не удалось открыть обыск выброшенных предметов.");
  }
}

async function requestDroppedItemsSocket(action = "", payload = {}) {
  const gm = getResponsibleGM();
  if (!gm) throw new Error("Нет активного GM для подбора выброшенных предметов.");
  const requestId = foundry.utils.randomID();
  const requesterUserId = game.user?.id ?? "";
  const promise = new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingDroppedItemsSocketRequests.delete(requestId);
      reject(new Error("GM не ответил на запрос подбора."));
    }, DROPPED_ITEMS_SOCKET_TIMEOUT);
    pendingDroppedItemsSocketRequests.set(requestId, { resolve, reject, timeout });
  });
  game.socket.emit(DROPPED_ITEMS_SOCKET, {
    scope: DROPPED_ITEMS_SOCKET_SCOPE,
    type: "request",
    action,
    requestId,
    requesterUserId,
    gmUserId: gm.id,
    payload
  });
  return promise;
}

async function handleDroppedItemsSocketMessage(message = {}) {
  if (message.scope !== DROPPED_ITEMS_SOCKET_SCOPE) return;
  if (message.type === "response") {
    if (message.recipientUserId && message.recipientUserId !== game.user?.id) return;
    const pending = pendingDroppedItemsSocketRequests.get(message.requestId);
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    pendingDroppedItemsSocketRequests.delete(message.requestId);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error || "Dropped items socket request failed."));
    return;
  }
  if (message.type !== "request") return;
  if (!game.user?.isGM || message.gmUserId !== game.user.id) return;
  try {
    let result = null;
    if (message.action === "ensureDroppedItemsActor") {
      result = await performDroppedItemsActorEnsure(message.payload ?? {}, message.requesterUserId ?? "");
    } else if (message.action === "cleanupDroppedItemsActor") {
      const actor = await resolveDroppedActor(String(message.payload?.actorUuid ?? ""));
      if (actor) await cleanupDroppedItemsActorIfEmpty(actor);
      result = {
        actorUuid: String(message.payload?.actorUuid ?? ""),
        deleted: !game.actors?.get(actor?.id ?? "")
      };
    }
    game.socket.emit(DROPPED_ITEMS_SOCKET, {
      scope: DROPPED_ITEMS_SOCKET_SCOPE,
      type: "response",
      requestId: message.requestId,
      recipientUserId: message.requesterUserId,
      ok: true,
      result
    });
  } catch (error) {
    console.error(`${SYSTEM_ID} | Dropped items socket request failed`, error);
    game.socket.emit(DROPPED_ITEMS_SOCKET, {
      scope: DROPPED_ITEMS_SOCKET_SCOPE,
      type: "response",
      requestId: message.requestId,
      recipientUserId: message.requesterUserId,
      ok: false,
      error: error.message
    });
  }
}

async function performDroppedItemsActorEnsure(payload = {}, requesterUserId = "") {
  const scene = game.scenes?.get(String(payload.sceneId ?? "")) ?? canvas?.scene;
  const tile = scene?.tiles?.get(String(payload.tileId ?? ""));
  if (!scene || !tile) throw new Error("Выброшенные предметы не найдены.");

  let state = getDroppedItemsFlag(tile);
  let actor = await resolveDroppedActor(state.actorUuid);
  if (!actor && !state.items.length) {
    await tile.delete();
    throw new Error("Выброшенные предметы не найдены.");
  }
  if (!actor) {
    actor = await createDroppedItemsActor(tile, requesterUserId);
    state = {
      ...state,
      actorUuid: actor.uuid
    };
  }
  if (!state.items.length && !(actor.items?.contents ?? []).length) {
    await cleanupDroppedItemsActorIfEmpty(actor);
    throw new Error("Выброшенные предметы не найдены.");
  }

  if (state.items.length) {
    const createData = buildDroppedItemCreateData(actor, state.items);
    if (createData.length) await actor.createEmbeddedDocuments("Item", createData, { keepId: true, render: false });
  }

  await tile.update({
    name: "Выброшенные предметы",
    [`flags.${SYSTEM_ID}.${DROPPED_ITEMS_FLAG}.actorUuid`]: actor.uuid,
    [`flags.${SYSTEM_ID}.${DROPPED_ITEMS_FLAG}.items`]: [],
    [`flags.${SYSTEM_ID}.${DROPPED_ITEMS_FLAG}.updatedAt`]: Date.now()
  });
  return { actorUuid: actor.uuid };
}

function buildDroppedItemCreateData(actor, entries = []) {
  const creates = [];
  const reservedPlacements = [];
  for (const entry of entries) {
    const itemData = foundry.utils.deepClone(entry.itemData);
    const quantity = Math.max(1, toInteger(entry.quantity) || getItemQuantity(itemData));
    foundry.utils.setProperty(itemData, "system.quantity", quantity);
    if (isContainerItem(itemData)) {
      const containerCreates = buildDroppedContainerCreateData(actor, itemData, entry.containedItems ?? [], reservedPlacements);
      creates.push(...containerCreates);
      continue;
    }
    creates.push(...buildDroppedStackCreateData(actor, itemData, quantity, reservedPlacements));
  }
  return creates;
}

function buildDroppedStackCreateData(actor, itemData, quantity = 1, reservedPlacements = []) {
  const creates = [];
  const maxStack = Math.max(1, getItemMaxStack(itemData));
  let remaining = Math.max(1, toInteger(quantity));
  while (remaining > 0) {
    const stackQuantity = Math.min(remaining, maxStack);
    const placement = getFirstAvailableActorRootPlacement(actor, itemData, reservedPlacements);
    if (!placement) throw new Error("В инвентаре нет места для выброшенного предмета.");
    reservedPlacements.push(placement);
    creates.push(createDroppedInventoryItemData(itemData, stackQuantity, placement));
    remaining -= stackQuantity;
  }
  return creates;
}

function buildDroppedContainerCreateData(actor, rootItemData, containedItems = [], reservedPlacements = []) {
  const placement = getFirstAvailableActorRootPlacement(actor, rootItemData, reservedPlacements);
  if (!placement) throw new Error("В инвентаре нет места для выброшенного контейнера.");
  reservedPlacements.push(placement);

  const oldRootId = String(rootItemData?._id ?? rootItemData?.id ?? "");
  const idMap = new Map([[oldRootId, foundry.utils.randomID()]]);
  for (const item of containedItems) {
    const oldId = String(item?._id ?? item?.id ?? "");
    if (oldId && !idMap.has(oldId)) idMap.set(oldId, foundry.utils.randomID());
  }

  const rootData = createDroppedInventoryItemData(rootItemData, 1, placement, { id: idMap.get(oldRootId) });
  const creates = [rootData];
  for (const item of containedItems) {
    const data = foundry.utils.deepClone(item);
    const oldId = String(data._id ?? data.id ?? "");
    const oldParentId = String(data.system?.container?.parentId ?? ROOT_CONTAINER_ID);
    const id = idMap.get(oldId) ?? foundry.utils.randomID();
    data._id = id;
    data.id = id;
    foundry.utils.setProperty(data, "system.equipped", false);
    foundry.utils.setProperty(data, "system.locked", false);
    foundry.utils.setProperty(data, "system.container.parentId", idMap.get(oldParentId) ?? ROOT_CONTAINER_ID);
    creates.push(data);
  }
  return creates;
}

function createDroppedInventoryItemData(itemData, quantity = 1, placement = null, { id = "" } = {}) {
  const data = foundry.utils.deepClone(itemData);
  const itemId = id || foundry.utils.randomID();
  data._id = itemId;
  data.id = itemId;
  const storedPlacement = createStoredPlacement(placement, data);
  foundry.utils.setProperty(data, "system.quantity", Math.max(1, toInteger(quantity)));
  foundry.utils.setProperty(data, "system.equipped", false);
  foundry.utils.setProperty(data, "system.locked", false);
  foundry.utils.setProperty(data, "system.container.parentId", ROOT_CONTAINER_ID);
  foundry.utils.setProperty(data, "system.placement", {
    mode: storedPlacement.mode,
    equipmentSlot: storedPlacement.equipmentSlot,
    weaponSet: storedPlacement.weaponSet,
    weaponSlot: storedPlacement.weaponSlot,
    limbKey: storedPlacement.limbKey,
    constructPartOrder: storedPlacement.constructPartOrder,
    x: storedPlacement.x,
    y: storedPlacement.y,
    width: storedPlacement.width,
    height: storedPlacement.height,
    rotated: storedPlacement.rotated
  });
  return data;
}

function getFirstAvailableActorRootPlacement(actor, itemData, reservedPlacements = []) {
  const race = getCreatureOptions().races.find(entry => entry.id === actor.system?.creature?.raceId);
  const dimensions = getActorInventoryGridDimensions(actor, race);
  const contextItems = getContextInventoryItems(ROOT_CONTAINER_ID, actor.items);
  return findFirstAvailableResolvedInventoryPlacement(
    contextItems,
    dimensions.columns,
    dimensions.rows,
    itemData,
    actor.items,
    [],
    reservedPlacements,
    getActorRootInventoryGridOptions(actor, ROOT_CONTAINER_ID)
  );
}

function getResponsibleGM() {
  return (game.users?.contents ?? [])
    .filter(user => user.active && user.isGM)
    .sort((left, right) => left.id.localeCompare(right.id))
    .at(0) ?? null;
}

function createDroppedItemEntryFromActorItem(actor, item, { quantity = 0, stackIndex = 0 } = {}) {
  const requestedQuantity = getDroppedItemQuantity(item, { quantity, stackIndex });
  const itemData = normalizeDroppedItemData(item.toObject(), requestedQuantity);
  const containedItems = isContainerItem(item)
    ? getAllContainedItems(item.id, actor.items).map(contained => contained.toObject())
    : [];
  return {
    entryId: foundry.utils.randomID(),
    sourceActorUuid: String(actor.uuid ?? ""),
    itemData,
    containedItems: normalizeDroppedContainedItems(containedItems),
    quantity: requestedQuantity,
    createdAt: Date.now()
  };
}

function getDroppedItemQuantity(item, { quantity = 0, stackIndex = 0 } = {}) {
  if (isContainerItem(item)) return 1;
  const available = usesVirtualInventoryStacks(item)
    ? Math.max(1, getItemStackPartQuantity(item, Math.max(0, toInteger(stackIndex))))
    : Math.max(1, getItemQuantity(item));
  return Math.max(1, Math.min(available, toInteger(quantity) || available));
}

function normalizeDroppedItemData(itemData, quantity = 0) {
  const data = foundry.utils.deepClone(itemData);
  foundry.utils.setProperty(data, "system.quantity", Math.max(1, toInteger(quantity) || getItemQuantity(data)));
  foundry.utils.setProperty(data, "system.equipped", false);
  foundry.utils.setProperty(data, "system.locked", false);
  foundry.utils.setProperty(data, "system.container.parentId", ROOT_CONTAINER_ID);
  return data;
}

function normalizeDroppedContainedItems(containedItems = []) {
  return (Array.isArray(containedItems) ? containedItems : [])
    .map(item => {
      const data = foundry.utils.deepClone(item);
      foundry.utils.setProperty(data, "system.equipped", false);
      foundry.utils.setProperty(data, "system.locked", false);
      return data;
    });
}

async function removeDroppedItemFromActor(actor, item, quantity = 0, { stackIndex = 0 } = {}) {
  if (isContainerItem(item)) {
    const ids = [
      item.id,
      ...getAllContainedItems(item.id, actor.items).map(contained => contained.id)
    ].filter(Boolean);
    if (ids.length) await actor.deleteEmbeddedDocuments("Item", ids);
    return;
  }

  const sourceQuantity = Math.max(1, getItemQuantity(item));
  const amount = Math.max(1, Math.min(sourceQuantity, toInteger(quantity) || sourceQuantity));
  if (amount >= sourceQuantity) {
    await actor.deleteEmbeddedDocuments("Item", [item.id]);
    return;
  }

  if (usesVirtualInventoryStacks(item)) {
    const update = createItemStackPartRemovalUpdate(item, amount, stackIndex);
    if (update) await actor.updateEmbeddedDocuments("Item", [update]);
    return;
  }

  await actor.updateEmbeddedDocuments("Item", [{
    _id: item.id,
    "system.quantity": sourceQuantity - amount
  }]);
}

async function addDroppedItemToScene(actor, droppedEntry) {
  const scene = canvas?.scene;
  if (!scene) throw new Error("No active scene for item drop.");
  const position = getActorDropPosition(actor);
  if (!position) throw new Error("No actor token for item drop.");
  const existing = findNearbyDroppedItemsTile(scene, position);
  if (existing) return appendDroppedItemToTile(existing, droppedEntry);
  return createDroppedItemsTile(scene, position, droppedEntry);
}

function getActorDropPosition(actor) {
  const token = actor?.getActiveTokens?.(false, true)?.at(0)
    ?? canvas?.tokens?.controlled?.find(controlled => controlled.actor?.uuid === actor?.uuid)
    ?? canvas?.tokens?.placeables?.find(placeable => placeable.actor?.uuid === actor?.uuid)
    ?? null;
  const center = token?.center;
  if (center) return { x: Math.round(center.x), y: Math.round(center.y) };
  const document = token?.document
    ?? (token && token.x !== undefined && token.y !== undefined ? token : null)
    ?? actor?.getActiveTokens?.()?.at(0)?.document
    ?? null;
  if (!document) return null;
  const width = Math.max(1, Number(document.width) || 1) * getSceneGridSize(canvas.scene);
  const height = Math.max(1, Number(document.height) || 1) * getSceneGridSize(canvas.scene);
  return {
    x: Math.round((Number(document.x) || 0) + (width / 2)),
    y: Math.round((Number(document.y) || 0) + (height / 2))
  };
}

function findNearbyDroppedItemsTile(scene, position) {
  const radius = getPixelsForMeters(scene, DROPPED_ITEMS_RADIUS_METERS);
  return scene.tiles?.contents
    ?.filter(tile => {
      const state = getDroppedItemsFlag(tile);
      return state.items.length || state.actorUuid;
    })
    .map(tile => ({ tile, distance: getPointDistance(position, getTileCenter(tile)) }))
    .filter(candidate => candidate.distance <= radius)
    .sort((left, right) => left.distance - right.distance)
    .at(0)?.tile ?? null;
}

async function appendDroppedItemToTile(tile, droppedEntry) {
  const state = getDroppedItemsFlag(tile);
  const actor = game.user?.isGM ? await resolveDroppedActor(state.actorUuid) : null;
  if (actor) {
    const createData = buildDroppedItemCreateData(actor, [droppedEntry]);
    if (createData.length) await actor.createEmbeddedDocuments("Item", createData, { keepId: true, render: false });
    await tile.update({
      name: "Выброшенные предметы",
      [`flags.${SYSTEM_ID}.${DROPPED_ITEMS_FLAG}.actorUuid`]: actor.uuid,
      [`flags.${SYSTEM_ID}.${DROPPED_ITEMS_FLAG}.items`]: [],
      [`flags.${SYSTEM_ID}.${DROPPED_ITEMS_FLAG}.updatedAt`]: Date.now()
    });
    return tile;
  }
  const items = [...state.items, droppedEntry];
  await tile.update({
    name: state.actorUuid ? "Выброшенные предметы" : getDroppedTileName(items),
    [`flags.${SYSTEM_ID}.${DROPPED_ITEMS_FLAG}.items`]: items,
    [`flags.${SYSTEM_ID}.${DROPPED_ITEMS_FLAG}.updatedAt`]: Date.now()
  });
  return tile;
}

async function createDroppedItemsTile(scene, position, droppedEntry) {
  const size = getSceneGridSize(scene);
  const [tile] = await scene.createEmbeddedDocuments("Tile", [{
    name: getDroppedTileName([droppedEntry]),
    x: Math.round(position.x),
    y: Math.round(position.y),
    width: size,
    height: size,
    elevation: 0,
    texture: {
      src: String(droppedEntry.itemData?.img || DROPPED_ITEMS_FALLBACK_ICON),
      anchorX: 0.5,
      anchorY: 0.5,
      fit: "contain",
      scaleX: 0.85,
      scaleY: 0.85
    },
    sort: getNextTileSort(scene),
    hidden: false,
    locked: true,
    flags: {
      [SYSTEM_ID]: {
        [DROPPED_ITEMS_FLAG]: {
          actorUuid: "",
          items: [droppedEntry],
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      }
    }
  }]);
  return tile;
}

function getDroppedItemsFlag(tile) {
  const flag = tile?.getFlag?.(SYSTEM_ID, DROPPED_ITEMS_FLAG) ?? {};
  return {
    ...flag,
    actorUuid: String(flag.actorUuid ?? ""),
    items: Array.isArray(flag.items) ? flag.items : []
  };
}

function isDroppedItemsTile(tile) {
  const state = getDroppedItemsFlag(tile);
  return Boolean(state.actorUuid || state.items.length);
}

async function resolveDroppedActor(actorUuid = "") {
  const uuid = String(actorUuid ?? "");
  if (!uuid) return null;
  try {
    const actor = await fromUuid(uuid);
    return actor instanceof Actor ? actor : null;
  } catch (_error) {
    return null;
  }
}

async function createDroppedItemsActor(tile, requesterUserId = "") {
  const ownership = { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER };
  const requester = requesterUserId ? game.users?.get(requesterUserId) : game.user;
  if (requester?.id) ownership[requester.id] = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
  const sceneId = String(tile.parent?.id ?? canvas?.scene?.id ?? "");
  const actor = await Actor.create({
    name: "Выброшенные предметы",
    type: "construct",
    img: String(tile.texture?.src || DROPPED_ITEMS_FALLBACK_ICON),
    ownership,
    system: {
      trade: {
        infiniteInventory: true,
        markupPercent: 0
      }
    },
    flags: {
      [SYSTEM_ID]: {
        [DROPPED_ITEMS_ACTOR_FLAG]: {
          sceneId,
          tileId: String(tile.id ?? "")
        }
      }
    }
  }, { renderSheet: false });
  return actor;
}

export function isDroppedItemsActor(actor) {
  return Boolean(actor?.getFlag?.(SYSTEM_ID, DROPPED_ITEMS_ACTOR_FLAG));
}

function getDroppedItemsActorFlag(actor) {
  return actor?.getFlag?.(SYSTEM_ID, DROPPED_ITEMS_ACTOR_FLAG) ?? {};
}

function scheduleDroppedItemsActorCleanup(actor) {
  if (!isDroppedItemsActor(actor)) return;
  window.setTimeout(() => void requestDroppedItemsActorCleanup(actor), 0);
}

export async function requestDroppedItemsActorCleanup(actorOrUuid) {
  const actorUuid = String(
    (typeof actorOrUuid === "string" ? actorOrUuid : actorOrUuid?.uuid) ?? ""
  );
  if (!actorUuid) return { cleaned: false, deleted: false };

  if (game.user?.isGM) {
    const actor = (typeof actorOrUuid === "object" && actorOrUuid?.id
      ? game.actors.get(actorOrUuid.id)
      : null) ?? await resolveDroppedActor(actorUuid);
    if (actor) {
      await cleanupDroppedItemsActorIfEmpty(actor);
      return { cleaned: true, deleted: !game.actors.get(actor.id) };
    }
    return { cleaned: false, deleted: !game.actors?.find?.(entry => entry.uuid === actorUuid) };
  }

  try {
    const result = await requestDroppedItemsSocket("cleanupDroppedItemsActor", { actorUuid });
    const deleted = Boolean(result?.deleted) || !game.actors?.find?.(entry => entry.uuid === actorUuid);
    return { cleaned: true, deleted };
  } catch (error) {
    console.error(`${SYSTEM_ID} | Dropped items cleanup request failed`, error);
    return { cleaned: false, deleted: false };
  }
}

export async function cleanupDroppedItemsActorIfEmpty(actor) {
  if (!game.user?.isGM || !actor) return;
  actor = game.actors.get(actor.id) ?? actor;
  if (!isDroppedItemsActor(actor)) return;
  const hasContents = droppedItemsActorHasContents(actor);
  if (hasContents) return;
  const flag = getDroppedItemsActorFlag(actor);
  const scene = game.scenes?.get(String(flag.sceneId ?? "")) ?? canvas?.scene;
  const tile = scene?.tiles?.get(String(flag.tileId ?? ""));
  const actorKey = getDroppedItemsCleanupKey(actor);
  const tileKey = getDroppedItemsCleanupKey(tile);
  if (droppedItemsCleanupInProgress.has(actorKey) || (tileKey && droppedItemsCleanupInProgress.has(tileKey))) return;
  droppedItemsCleanupInProgress.add(actorKey);
  if (tileKey) droppedItemsCleanupInProgress.add(tileKey);
  try {
    if (tile) await tile.delete();
    if (game.actors?.get(actor.id)) await actor.delete();
  } finally {
    droppedItemsCleanupInProgress.delete(actorKey);
    if (tileKey) droppedItemsCleanupInProgress.delete(tileKey);
  }
}

function countDroppedLootItems(actor) {
  return (actor?.items?.contents ?? []).filter(item => (
    !isDroppedLootSystemItem(item) && !isEmbeddedNaturalRaceItem(item)
  )).length;
}

function isDroppedLootSystemItem(item) {
  return ["ability", "trauma", "disease"].includes(String(item?.type ?? ""));
}

function isEmbeddedNaturalRaceItem(item) {
  return Boolean(item?.getFlag?.(SYSTEM_ID, "naturalRaceItem") ?? item?.flags?.[SYSTEM_ID]?.naturalRaceItem);
}

function droppedItemsActorHasContents(actor) {
  if (countDroppedLootItems(actor) > 0) return true;
  return getCurrencySettings().some(currency => Math.max(0, toInteger(actor?.system?.currencies?.[currency.key])) > 0);
}

export { droppedItemsActorHasContents };

async function cleanupDroppedItemsTileForActor(actor) {
  if (!game.user?.isGM || !isDroppedItemsActor(actor)) return;
  const flag = getDroppedItemsActorFlag(actor);
  const scene = game.scenes?.get(String(flag.sceneId ?? "")) ?? canvas?.scene;
  const tile = scene?.tiles?.get(String(flag.tileId ?? ""));
  const actorKey = getDroppedItemsCleanupKey(actor);
  const tileKey = getDroppedItemsCleanupKey(tile);
  if (droppedItemsCleanupInProgress.has(actorKey) || (tileKey && droppedItemsCleanupInProgress.has(tileKey))) return;
  droppedItemsCleanupInProgress.add(actorKey);
  if (tileKey) droppedItemsCleanupInProgress.add(tileKey);
  try {
    if (tile) await tile.delete();
  } finally {
    droppedItemsCleanupInProgress.delete(actorKey);
    if (tileKey) droppedItemsCleanupInProgress.delete(tileKey);
  }
}

async function cleanupDroppedItemsActorForTile(tile) {
  if (!game.user?.isGM) return;
  const state = getDroppedItemsFlag(tile);
  const actor = await resolveDroppedActor(state.actorUuid);
  if (!actor || !isDroppedItemsActor(actor)) return;
  const actorKey = getDroppedItemsCleanupKey(actor);
  const tileKey = getDroppedItemsCleanupKey(tile);
  if (droppedItemsCleanupInProgress.has(actorKey) || droppedItemsCleanupInProgress.has(tileKey)) return;
  droppedItemsCleanupInProgress.add(actorKey);
  droppedItemsCleanupInProgress.add(tileKey);
  try {
    if (game.actors?.get(actor.id)) await actor.delete();
  } finally {
    droppedItemsCleanupInProgress.delete(actorKey);
    droppedItemsCleanupInProgress.delete(tileKey);
  }
}

function getDroppedItemsCleanupKey(document) {
  if (!document) return "";
  return String(document.uuid ?? `${document.documentName ?? document.constructor?.documentName ?? "Document"}.${document.id ?? ""}`);
}

function getDroppedTileName(items = []) {
  const count = items.length;
  if (count === 1) return String(items[0]?.itemData?.name ?? "Dropped item");
  return `Dropped items (${count})`;
}

function getTileCenter(tile) {
  const anchorX = Number(tile?.texture?.anchorX ?? 0.5);
  const anchorY = Number(tile?.texture?.anchorY ?? 0.5);
  return {
    x: (Number(tile?.x) || 0) + ((0.5 - anchorX) * (Number(tile?.width) || 0)),
    y: (Number(tile?.y) || 0) + ((0.5 - anchorY) * (Number(tile?.height) || 0))
  };
}

function getPointDistance(left, right) {
  return Math.hypot((Number(left?.x) || 0) - (Number(right?.x) || 0), (Number(left?.y) || 0) - (Number(right?.y) || 0));
}

function getPixelsForMeters(scene, meters = 0) {
  const gridDistance = Math.max(0.0001, Number(scene?.grid?.distance ?? canvas?.grid?.distance) || 1);
  return Math.max(0, Number(meters) || 0) * (getSceneGridSize(scene) / gridDistance);
}

function getSceneGridSize(scene) {
  return Math.max(1, Number(scene?.grid?.size ?? canvas?.grid?.size) || 100);
}

function getNextTileSort(scene) {
  const sorts = scene?.tiles?.contents?.map(tile => Number(tile.sort) || 0) ?? [];
  return Math.max(0, ...sorts) + 1;
}
