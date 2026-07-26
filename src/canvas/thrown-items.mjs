import { SYSTEM_ID } from "../constants.mjs";
import { getCreatureOptions } from "../settings/accessors.mjs";
import { getActorInventoryGridDimensions, getActorRootInventoryGridOptions } from "../utils/actor-display-data.mjs";
import {
  ROOT_CONTAINER_ID,
  createStoredPlacement,
  findFirstAvailableInventoryPlacement,
  getContainerInventoryGridOptions,
  getContextInventoryItems,
  getItemContainerParentId,
  isContainerItem,
  validateInventoryTree
} from "../utils/inventory-containers.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { grantActorInventoryItem } from "../utils/inventory-grants.mjs";
import { executeInventoryMutation } from "../inventory/mutation.mjs";

const { DialogV2 } = foundry.applications.api;
const THROWN_ITEM_SOCKET = `system.${SYSTEM_ID}`;
const THROWN_ITEM_SOCKET_SCOPE = "thrownItems";
const THROWN_ITEM_SOCKET_TIMEOUT_MS = 30000;
const THROWN_ITEM_SOCKET_RESULT_TTL_MS = 10 * 60 * 1000;
const THROWN_ITEM_FLAG = "thrownItem";
export const DELAYED_THROWN_ITEM_FLAG = "delayedThrownItem";
export const DELAYED_THROWN_ITEM_REGION_FLAG = "delayedThrownItemRegion";
const DEFAULT_TILE_IMAGE = "icons/svg/item-bag.svg";

let tilePatchRegistered = false;
let canvasPickupListenerRegistered = false;
const combatPickupPromptKeys = new Set();
const pendingThrownItemSocketRequests = new Map();
const activeThrownItemSocketRequests = new Map();
const completedThrownItemSocketRequests = new Map();
const thrownItemOperationOwners = new Map();
const cancelledThrownItemOperations = new Map();
const delayedThrownItemWorldOperationOwners = new Map();
const cancelledDelayedThrownItemWorldOperations = new Map();

export function registerThrownItemHooks() {
  game.socket.on(THROWN_ITEM_SOCKET, handleThrownItemSocketMessage);
  patchTileInteractions();
  registerCanvasPickupListener();
  Hooks.on("canvasReady", () => {
    patchTileInteractions();
    registerCanvasPickupListener();
  });
  Hooks.on("deleteCombat", combat => {
    void promptThrownItemPickupForCombat(combat);
  });
}

export async function createThrownItemTile({
  sceneId = "",
  itemData = null,
  point = null,
  sourceActorUuid = "",
  sourceItemUuid = "",
  sourceUserId = "",
  combatId = "",
  delayedThrownItemId = "",
  operationId = ""
} = {}) {
  if (!sceneId || !itemData || !point) return null;
  delayedThrownItemId = String(delayedThrownItemId ?? "").trim();
  operationId = String(operationId ?? "").trim() || foundry.utils.randomID();
  const droppedItemData = normalizeDroppedItemData(itemData);
  if (delayedThrownItemId) {
    foundry.utils.setProperty(droppedItemData, `flags.${SYSTEM_ID}.${DELAYED_THROWN_ITEM_FLAG}.id`, delayedThrownItemId);
  }
  const request = {
    sceneId,
    itemData: droppedItemData,
    point: serializePoint(point),
    sourceActorUuid: String(sourceActorUuid ?? ""),
    sourceItemUuid: String(sourceItemUuid ?? ""),
    sourceUserId: String(sourceUserId || game.user?.id || ""),
    combatId: String(combatId || game.combat?.id || ""),
    delayedThrownItemId,
    operationId
  };

  if (game.user?.isGM) return createThrownItemTileDocument(request, game.user.id);

  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("Нет активного GM для создания брошенного предмета.");
    return null;
  }

  try {
    const result = await requestThrownItemSocketWithRetry(
      "createThrownItemTile",
      request,
      gm,
      operationId
    );
    return result?.success ? result : null;
  } catch (error) {
    console.error(`${SYSTEM_ID} | Thrown item creation request failed`, error);
    ui.notifications.warn("GM не подтвердил создание брошенного предмета.");
    return null;
  }
}

async function handleThrownItemSocketMessage(payload = {}) {
  if (!payload || payload.scope !== THROWN_ITEM_SOCKET_SCOPE) return;
  if (payload.type === "response") {
    if (payload.recipientUserId && payload.recipientUserId !== game.user?.id) return;
    settleThrownItemSocketRequest(payload);
    return;
  }
  if (payload.type !== "request") return;
  if (!game.user?.isGM || payload.gmUserId !== game.user.id) return;

  const requesterUserId = String(payload.requesterUserId ?? "");
  const requestId = String(payload.requestId ?? "");
  if (!requesterUserId || !requestId) return;
  const cacheKey = `${requesterUserId}:${requestId}`;
  try {
    const result = await runIdempotentSocketRequest(
      activeThrownItemSocketRequests,
      completedThrownItemSocketRequests,
      cacheKey,
      () => handleThrownItemSocketRequest(payload.action, payload.request ?? {}, requesterUserId)
    );
    emitThrownItemSocketResponse({
      requestId,
      recipientUserId: requesterUserId,
      ok: true,
      result
    });
  } catch (error) {
    console.error(`${SYSTEM_ID} | Thrown item socket request failed`, error);
    emitThrownItemSocketResponse({
      requestId,
      recipientUserId: requesterUserId,
      ok: false,
      error: String(error?.message ?? error)
    });
  }
}

async function handleThrownItemSocketRequest(action, request, requesterUserId) {
  if (action === "createThrownItemTile") {
    const tile = await createThrownItemTileDocument(request, requesterUserId);
    return serializeThrownItemTileResult(tile);
  }
  if (action === "pickupThrownItemTile") {
    return pickupThrownItemTile({
      ...request,
      requestingUserId: requesterUserId
    });
  }
  if (action === "deleteDelayedThrownItemWorldDocuments") {
    return deleteDelayedThrownItemWorldDocumentsNow(
      request?.delayedThrownItemId,
      requesterUserId
    );
  }
  if (action === "deleteThrownItemTileByOperation") {
    return deleteThrownItemTileByOperationNow(
      request?.operationId,
      requesterUserId
    );
  }
  throw new Error(`Unsupported thrown item socket action: ${String(action ?? "")}`);
}

async function createThrownItemTileDocument({
  sceneId = "",
  itemData = null,
  point = null,
  sourceActorUuid = "",
  sourceItemUuid = "",
  sourceUserId = "",
  combatId = "",
  delayedThrownItemId = "",
  operationId = ""
} = {}, requestingUserId = "") {
  const scene = game.scenes?.get(sceneId);
  if (!scene || !itemData || !point) return null;
  await assertThrownItemRequestPermission(sourceActorUuid, requestingUserId);
  operationId = String(operationId ?? "").trim() || foundry.utils.randomID();
  rememberThrownItemOperationOwner(operationId, sourceActorUuid);
  if (isThrownItemOperationCancelled(operationId)) return null;
  const existing = findThrownItemTileByOperation(scene, operationId);
  if (existing) return existing;

  const image = normalizeImagePath(itemData.img, DEFAULT_TILE_IMAGE);
  const dimensions = await getDroppedItemTileDimensions(scene, image);
  if (isThrownItemOperationCancelled(operationId)) return null;
  const x = Math.round(Number(point.x) || 0);
  const y = Math.round(Number(point.y) || 0);
  const created = await scene.createEmbeddedDocuments("Tile", [{
    name: String(itemData.name ?? game.i18n.localize("DOCUMENT.Item")),
    texture: {
      src: image,
      anchorX: 0.5,
      anchorY: 0.5
    },
    x,
    y,
    width: dimensions.width,
    height: dimensions.height,
    elevation: Number.isFinite(Number(point.elevation)) ? Number(point.elevation) : 0,
    sort: getNextTileSort(scene),
    hidden: false,
    locked: true,
    flags: {
      [SYSTEM_ID]: {
        [THROWN_ITEM_FLAG]: {
          itemData: normalizeDroppedItemData(itemData),
          sourceActorUuid: String(sourceActorUuid ?? ""),
          sourceItemUuid: String(sourceItemUuid ?? ""),
          sourceUserId: String(sourceUserId ?? ""),
          combatId: String(combatId ?? ""),
          operationId,
          createdAt: Number(game.time?.worldTime) || 0
        }
      }
    }
  }]);
  const tile = created?.[0] ?? null;
  if (tile && isThrownItemOperationCancelled(operationId)) {
    await scene.deleteEmbeddedDocuments("Tile", [tile.id]);
    return null;
  }
  return tile;
}

async function assertThrownItemRequestPermission(sourceActorUuid = "", requestingUserId = "") {
  const requester = game.users?.get(String(requestingUserId ?? "")) ?? game.user;
  if (!requester || requester.isGM) return;
  const actorUuid = String(sourceActorUuid ?? "").trim();
  const actor = actorUuid ? await fromUuid(actorUuid) : null;
  if (!actor || actor.documentName !== "Actor" || !actor.testUserPermission?.(requester, "OWNER")) {
    throw new Error("The requester cannot create a thrown item for this Actor.");
  }
}

function findThrownItemTileByOperation(scene, operationId = "") {
  const id = String(operationId ?? "").trim();
  if (!id) return null;
  return scene?.tiles?.contents?.find(
    tile => String(tile.getFlag?.(SYSTEM_ID, THROWN_ITEM_FLAG)?.operationId ?? "") === id
  ) ?? null;
}

function serializeThrownItemTileResult(tile) {
  return {
    success: Boolean(tile?.id),
    sceneId: String(tile?.parent?.id ?? ""),
    tileId: String(tile?.id ?? ""),
    tileUuid: String(tile?.uuid ?? "")
  };
}

export async function deleteDelayedThrownItemDocuments(delayedThrownItemId = "") {
  const id = String(delayedThrownItemId ?? "").trim();
  if (!id) return;
  await deleteDelayedThrownItemWorldDocumentsNow(id, game.user?.id ?? "");
  const actors = new Map((game.actors?.contents ?? []).map(actor => [actor.uuid, actor]));
  for (const scene of game.scenes?.contents ?? []) {
    for (const token of scene.tokens?.contents ?? []) {
      if (token.actor?.uuid) actors.set(token.actor.uuid, token.actor);
    }
  }
  for (const actor of actors.values()) {
    const matchingItems = actor.items.filter(item => getDelayedThrownItemId(item) === id);
    const itemIds = [];
    const updates = [];
    for (const item of matchingItems) {
      const quantity = Math.max(0, toInteger(item.system?.quantity));
      if (quantity > 1) {
        updates.push({
          _id: item.id,
          "system.quantity": quantity - 1,
          [`flags.${SYSTEM_ID}.-=${DELAYED_THROWN_ITEM_FLAG}`]: null
        });
      } else if (item.id) itemIds.push(item.id);
    }
    if (updates.length || itemIds.length) {
      await executeInventoryMutation({
        actor,
        updates,
        deletes: itemIds
      }, { reason: "delete-delayed-thrown-items" });
    }
  }
}

/**
 * Remove only the world-side documents for a delayed thrown item.
 *
 * This is intentionally separate from deleteDelayedThrownItemDocuments so a
 * failed inventory commit can compensate a previously-created Region/Tile
 * without deleting any Actor Item.
 */
export async function deleteDelayedThrownItemWorldDocuments(delayedThrownItemId = "") {
  const id = String(delayedThrownItemId ?? "").trim();
  if (!id) return false;
  if (game.user?.isGM) {
    await deleteDelayedThrownItemWorldDocumentsNow(id, game.user.id);
    return true;
  }

  const gm = getResponsibleGM();
  if (!gm) return false;
  try {
    const result = await requestThrownItemSocketWithRetry(
      "deleteDelayedThrownItemWorldDocuments",
      { delayedThrownItemId: id },
      gm,
      `cleanup-world:${id}`
    );
    return Boolean(result?.success);
  } catch (error) {
    console.error(`${SYSTEM_ID} | Delayed thrown item world cleanup failed`, error);
    return false;
  }
}

/**
 * Compensate a failed inventory spend by removing the prepared thrown-item
 * Tile identified by its durable operation marker.
 */
export async function deleteThrownItemTileByOperation(operationId = "") {
  const id = String(operationId ?? "").trim();
  if (!id) return false;
  if (game.user?.isGM) {
    await deleteThrownItemTileByOperationNow(id, game.user.id);
    return true;
  }

  const gm = getResponsibleGM();
  if (!gm) return false;
  try {
    const result = await requestThrownItemSocketWithRetry(
      "deleteThrownItemTileByOperation",
      { operationId: id },
      gm,
      `delete-thrown-tile:${id}`
    );
    return Boolean(result?.success);
  } catch (error) {
    console.error(`${SYSTEM_ID} | Thrown item Tile compensation failed`, error);
    return false;
  }
}

async function deleteThrownItemTileByOperationNow(operationId = "", requestingUserId = "") {
  const id = String(operationId ?? "").trim();
  if (!id) return { success: false, deletedTiles: 0 };
  const matches = [];
  for (const scene of game.scenes?.contents ?? []) {
    for (const tile of scene.tiles?.contents ?? []) {
      const thrown = tile.getFlag?.(SYSTEM_ID, THROWN_ITEM_FLAG);
      if (String(thrown?.operationId ?? "") === id) matches.push({ scene, tile, thrown });
    }
  }
  await assertThrownItemTileCleanupPermission(id, matches, requestingUserId);
  cancelThrownItemOperation(id);
  let deletedTiles = 0;
  for (const scene of game.scenes?.contents ?? []) {
    const tileIds = (scene.tiles?.contents ?? [])
      .filter(tile => String(
        tile.getFlag?.(SYSTEM_ID, THROWN_ITEM_FLAG)?.operationId ?? ""
      ) === id)
      .map(tile => tile.id)
      .filter(Boolean);
    if (!tileIds.length) continue;
    await scene.deleteEmbeddedDocuments("Tile", tileIds);
    deletedTiles += tileIds.length;
  }
  return { success: true, deletedTiles };
}

async function assertThrownItemTileCleanupPermission(operationId, matches, requestingUserId) {
  const requester = game.users?.get(String(requestingUserId ?? "")) ?? game.user;
  if (!requester || requester.isGM) return;
  if (!matches.length) {
    const actorUuid = String(thrownItemOperationOwners.get(operationId)?.actorUuid ?? "");
    const actor = actorUuid ? await fromUuid(actorUuid) : null;
    if (actor?.testUserPermission?.(requester, "OWNER")) return;
    throw new Error("The requester cannot cancel this thrown item operation.");
  }
  for (const entry of matches) {
    const actorUuid = String(entry.thrown?.sourceActorUuid ?? "").trim();
    const actor = actorUuid ? await fromUuid(actorUuid) : null;
    if (!actor?.testUserPermission?.(requester, "OWNER")) {
      throw new Error("The requester cannot remove this thrown item Tile.");
    }
  }
}

function rememberThrownItemOperationOwner(operationId = "", sourceActorUuid = "") {
  const id = String(operationId ?? "").trim();
  if (!id) return;
  thrownItemOperationOwners.set(id, {
    actorUuid: String(sourceActorUuid ?? "").trim(),
    expiresAt: Date.now() + THROWN_ITEM_SOCKET_RESULT_TTL_MS
  });
  pruneThrownItemOperationState();
}

function cancelThrownItemOperation(operationId = "") {
  const id = String(operationId ?? "").trim();
  if (!id) return;
  cancelledThrownItemOperations.set(
    id,
    Date.now() + THROWN_ITEM_SOCKET_RESULT_TTL_MS
  );
  pruneThrownItemOperationState();
}

function isThrownItemOperationCancelled(operationId = "") {
  const id = String(operationId ?? "").trim();
  if (!id) return false;
  const expiresAt = Number(cancelledThrownItemOperations.get(id)) || 0;
  if (expiresAt > Date.now()) return true;
  if (expiresAt) cancelledThrownItemOperations.delete(id);
  return false;
}

function pruneThrownItemOperationState(now = Date.now()) {
  for (const [id, entry] of thrownItemOperationOwners) {
    if (Number(entry?.expiresAt) <= now) thrownItemOperationOwners.delete(id);
  }
  for (const [id, expiresAt] of cancelledThrownItemOperations) {
    if (Number(expiresAt) <= now) cancelledThrownItemOperations.delete(id);
  }
  for (const [id, entry] of delayedThrownItemWorldOperationOwners) {
    if (Number(entry?.expiresAt) <= now) delayedThrownItemWorldOperationOwners.delete(id);
  }
  for (const [id, expiresAt] of cancelledDelayedThrownItemWorldOperations) {
    if (Number(expiresAt) <= now) cancelledDelayedThrownItemWorldOperations.delete(id);
  }
  while (thrownItemOperationOwners.size > 200) {
    thrownItemOperationOwners.delete(thrownItemOperationOwners.keys().next().value);
  }
  while (cancelledThrownItemOperations.size > 200) {
    cancelledThrownItemOperations.delete(cancelledThrownItemOperations.keys().next().value);
  }
  while (delayedThrownItemWorldOperationOwners.size > 200) {
    delayedThrownItemWorldOperationOwners.delete(
      delayedThrownItemWorldOperationOwners.keys().next().value
    );
  }
  while (cancelledDelayedThrownItemWorldOperations.size > 200) {
    cancelledDelayedThrownItemWorldOperations.delete(
      cancelledDelayedThrownItemWorldOperations.keys().next().value
    );
  }
}

async function deleteDelayedThrownItemWorldDocumentsNow(delayedThrownItemId = "", requestingUserId = "") {
  const id = String(delayedThrownItemId ?? "").trim();
  if (!id) return { success: false, deletedTiles: 0, deletedRegions: 0 };
  await assertDelayedThrownItemCleanupPermission(id, requestingUserId);
  cancelDelayedThrownItemWorldOperation(id);

  let deletedTiles = 0;
  let deletedRegions = 0;
  for (const scene of game.scenes?.contents ?? []) {
    const tileIds = (scene.tiles?.contents ?? [])
      .filter(tile => getDelayedThrownItemId(tile.getFlag?.(SYSTEM_ID, THROWN_ITEM_FLAG)?.itemData) === id)
      .map(tile => tile.id)
      .filter(Boolean);
    const regionIds = (scene.regions?.contents ?? [])
      .filter(region => String(
        region.getFlag?.(SYSTEM_ID, DELAYED_THROWN_ITEM_REGION_FLAG)?.id ?? ""
      ) === id)
      .map(region => region.id)
      .filter(Boolean);
    if (tileIds.length) {
      await scene.deleteEmbeddedDocuments("Tile", tileIds);
      deletedTiles += tileIds.length;
    }
    if (regionIds.length) {
      await scene.deleteEmbeddedDocuments("Region", regionIds);
      deletedRegions += regionIds.length;
    }
  }
  return { success: true, deletedTiles, deletedRegions };
}

async function assertDelayedThrownItemCleanupPermission(delayedThrownItemId, requestingUserId) {
  const requester = game.users?.get(String(requestingUserId ?? "")) ?? game.user;
  if (!requester || requester.isGM) return;

  const actorUuids = new Set();
  for (const scene of game.scenes?.contents ?? []) {
    for (const tile of scene.tiles?.contents ?? []) {
      const thrown = tile.getFlag?.(SYSTEM_ID, THROWN_ITEM_FLAG);
      if (getDelayedThrownItemId(thrown?.itemData) !== delayedThrownItemId) continue;
      if (thrown?.sourceActorUuid) actorUuids.add(String(thrown.sourceActorUuid));
    }
    for (const region of scene.regions?.contents ?? []) {
      const delayed = region.getFlag?.(SYSTEM_ID, DELAYED_THROWN_ITEM_REGION_FLAG);
      if (String(delayed?.id ?? "") !== delayedThrownItemId) continue;
      const actorUuid = String(delayed?.source?.attackerUuid ?? "").trim();
      if (actorUuid) actorUuids.add(actorUuid);
    }
  }

  const registeredOwnerActorUuid = String(
    delayedThrownItemWorldOperationOwners.get(delayedThrownItemId)?.actorUuid ?? ""
  ).trim();
  if (registeredOwnerActorUuid) actorUuids.add(registeredOwnerActorUuid);

  if (!actorUuids.size) {
    throw new Error("The requester cannot cancel an unknown delayed thrown item operation.");
  }
  for (const actorUuid of actorUuids) {
    const actor = await fromUuid(actorUuid);
    if (actor?.testUserPermission?.(requester, "OWNER")) return;
  }
  throw new Error("The requester cannot remove these delayed thrown item documents.");
}

export function registerDelayedThrownItemWorldOperation(
  delayedThrownItemId = "",
  ownerActorUuid = ""
) {
  const id = String(delayedThrownItemId ?? "").trim();
  if (!id) return false;
  delayedThrownItemWorldOperationOwners.set(id, {
    actorUuid: String(ownerActorUuid ?? "").trim(),
    expiresAt: Date.now() + THROWN_ITEM_SOCKET_RESULT_TTL_MS
  });
  pruneThrownItemOperationState();
  return true;
}

export function isDelayedThrownItemWorldOperationCancelled(delayedThrownItemId = "") {
  const id = String(delayedThrownItemId ?? "").trim();
  if (!id) return false;
  const expiresAt = Number(cancelledDelayedThrownItemWorldOperations.get(id)) || 0;
  if (expiresAt > Date.now()) return true;
  if (expiresAt) cancelledDelayedThrownItemWorldOperations.delete(id);
  return false;
}

function cancelDelayedThrownItemWorldOperation(delayedThrownItemId = "") {
  const id = String(delayedThrownItemId ?? "").trim();
  if (!id) return;
  cancelledDelayedThrownItemWorldOperations.set(
    id,
    Date.now() + THROWN_ITEM_SOCKET_RESULT_TTL_MS
  );
  pruneThrownItemOperationState();
}

async function attachDelayedThrownItemRegionToActor(itemData = null, actor = null, scene = null) {
  const delayedThrownItemId = String(itemData?.flags?.[SYSTEM_ID]?.[DELAYED_THROWN_ITEM_FLAG]?.id ?? "").trim();
  if (!delayedThrownItemId || !actor || !scene) return;
  const token = getActorSceneTokenDocument(actor, scene);
  if (!token) return;
  const center = getTokenCenterPoint(token.object ?? token);
  const levelId = String(token._source?.level ?? token.level?.id ?? token.level ?? "").trim();
  const updates = [];
  for (const region of scene.regions?.contents ?? []) {
    if (String(region.getFlag?.(SYSTEM_ID, DELAYED_THROWN_ITEM_REGION_FLAG)?.id ?? "") !== delayedThrownItemId) continue;
    updates.push({
      _id: region.id,
      shapes: moveRegionShapesToPoint(region, center),
      elevation: { bottom: null, top: null },
      levels: levelId ? [levelId] : [],
      hidden: Boolean(token.hidden),
      attachment: { token: token.id }
    });
  }
  if (updates.length) await scene.updateEmbeddedDocuments("Region", updates);
}

function getActorSceneTokenDocument(actor = null, scene = null) {
  return (scene?.tokens?.contents ?? []).find(token => {
    const tokenActor = token.actor;
    return tokenActor?.uuid === actor?.uuid || tokenActor?.id === actor?.id;
  }) ?? null;
}

function getTokenCenterPoint(token = null) {
  const document = token?.document ?? token;
  const object = token?.object ?? token;
  if (Number.isFinite(Number(object?.center?.x)) && Number.isFinite(Number(object?.center?.y))) {
    return {
      x: Number(object.center.x),
      y: Number(object.center.y),
      elevation: Number(document?.elevation) || 0
    };
  }
  const gridSize = Math.max(1, Number(document?.parent?.grid?.size ?? canvas.grid?.size) || 100);
  return {
    x: (Number(document?.x) || 0) + ((Number(document?.width) || 1) * gridSize / 2),
    y: (Number(document?.y) || 0) + ((Number(document?.height) || 1) * gridSize / 2),
    elevation: Number(document?.elevation) || 0
  };
}

function moveRegionShapesToPoint(region = null, point = null) {
  const target = serializePoint(point);
  return (region?.shapes ?? []).map(shape => {
    const clone = shape.clone();
    clone.move(target);
    return clone.toObject();
  });
}

function getDelayedThrownItemId(itemOrData = null) {
  if (!itemOrData) return "";
  if (typeof itemOrData.getFlag === "function") {
    return String(itemOrData.getFlag(SYSTEM_ID, DELAYED_THROWN_ITEM_FLAG)?.id ?? "").trim();
  }
  return String(itemOrData?.flags?.[SYSTEM_ID]?.[DELAYED_THROWN_ITEM_FLAG]?.id ?? "").trim();
}

function patchTileInteractions() {
  if (tilePatchRegistered) return;
  const TileClass = CONFIG.Tile?.objectClass;
  if (!TileClass?.prototype) return;

  const originalCanView = TileClass.prototype._canView;
  const originalCanHover = TileClass.prototype._canHover;
  const originalOnClickLeft2 = TileClass.prototype._onClickLeft2;

  TileClass.prototype._canView = function(user, event) {
    if (isThrownItemTile(this)) return true;
    return originalCanView.call(this, user, event);
  };

  TileClass.prototype._canHover = function(user, event) {
    if (isThrownItemTile(this)) return true;
    return originalCanHover.call(this, user, event);
  };

  TileClass.prototype._onClickLeft2 = function(event) {
    if (!isThrownItemTile(this)) return originalOnClickLeft2.call(this, event);
    event?.stopPropagation?.();
    void promptPickupThrownItem(this.document);
    return false;
  };

  tilePatchRegistered = true;
}

function registerCanvasPickupListener() {
  const view = canvas.app?.view;
  if (canvasPickupListenerRegistered || !view) return;
  view.addEventListener("dblclick", onCanvasThrownItemDoubleClick, { capture: true });
  canvasPickupListenerRegistered = true;
}

function onCanvasThrownItemDoubleClick(event) {
  const tile = getThrownItemTileAtCanvasEvent(event);
  if (!tile) return;
  event.preventDefault?.();
  event.stopPropagation?.();
  event.stopImmediatePropagation?.();
  void promptPickupThrownItem(tile);
}

function getThrownItemTileAtCanvasEvent(event) {
  if (!Number.isFinite(Number(event?.clientX)) || !Number.isFinite(Number(event?.clientY))) return null;
  const point = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
  return getThrownItemTilesAtPoint(point).at(0) ?? null;
}

function getThrownItemTilesAtPoint(point) {
  return (canvas.scene?.tiles?.contents ?? [])
    .filter(tile => !tile.hidden && tile.getFlag?.(SYSTEM_ID, THROWN_ITEM_FLAG) && isPointInsideTile(tile, point))
    .sort((left, right) => getTileSortValue(right) - getTileSortValue(left));
}

function isPointInsideTile(tile, point) {
  if (!tile || !point) return false;
  if (tile.shape?.testPoint?.(point)) return true;
  const left = Number(tile.x) || 0;
  const top = Number(tile.y) || 0;
  const width = Math.abs(Number(tile.width) || 0);
  const height = Math.abs(Number(tile.height) || 0);
  return point.x >= left && point.x <= left + width && point.y >= top && point.y <= top + height;
}

function getTileSortValue(tile) {
  return Number(tile?.sort ?? tile?.object?._lastSortedIndex ?? 0) || 0;
}

function isThrownItemTile(tile) {
  return Boolean(tile?.document?.getFlag?.(SYSTEM_ID, THROWN_ITEM_FLAG));
}

async function promptPickupThrownItem(tileDocument) {
  const thrownItem = tileDocument?.getFlag?.(SYSTEM_ID, THROWN_ITEM_FLAG);
  if (!thrownItem?.itemData) return;

  const actor = getPickupActor();
  if (!actor) {
    ui.notifications.warn("Выберите свой токен или назначьте персонажа для подбора предмета.");
    return;
  }
  if (!actor.isOwner) {
    ui.notifications.warn(`Нет прав на добавление предмета актеру ${actor.name}.`);
    return;
  }

  const confirmed = await DialogV2.confirm({
    window: { title: "Подбор предмета" },
    content: `<p>Забрать <strong>${escapeHTML(thrownItem.itemData.name ?? tileDocument.name)}</strong> в инвентарь <strong>${escapeHTML(actor.name)}</strong>?</p>`,
    rejectClose: false,
    modal: true
  });
  if (!confirmed) return;

  await requestPickupThrownItemTile(tileDocument, actor);
}

async function requestPickupThrownItemTile(tileDocument, actor) {
  const request = {
    sceneId: tileDocument.parent?.id ?? canvas.scene?.id ?? "",
    tileId: tileDocument.id,
    actorUuid: actor.uuid,
    operationId: `pickup:${tileDocument.parent?.id ?? canvas.scene?.id ?? ""}:${tileDocument.id}:${actor.uuid}`
  };
  if (!request.sceneId || !request.tileId || !request.actorUuid) return false;

  if (game.user?.isGM) {
    const result = await pickupThrownItemTile({
      ...request,
      requestingUserId: game.user.id
    });
    return Boolean(result?.success);
  }

  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("Нет активного GM для подбора брошенного предмета.");
    return false;
  }

  try {
    const result = await requestThrownItemSocketWithRetry(
      "pickupThrownItemTile",
      request,
      gm,
      request.operationId
    );
    return Boolean(result?.success);
  } catch (error) {
    console.error(`${SYSTEM_ID} | Thrown item pickup request failed`, error);
    ui.notifications.warn("GM не подтвердил подбор брошенного предмета.");
    return false;
  }
}

async function pickupThrownItemTile({ sceneId = "", tileId = "", actorUuid = "", requestingUserId = "" } = {}) {
  const scene = game.scenes?.get(sceneId);
  const tile = scene?.tiles?.get(tileId);
  const actor = await fromUuid(actorUuid);
  const pickupMarker = String(tile?.uuid ?? `${scene?.uuid ?? `Scene.${sceneId}`}.Tile.${tileId}`);
  const existingPickup = actor?.items?.find?.(
    item => String(item.getFlag?.(SYSTEM_ID, "thrownPickupTileUuid") ?? "") === pickupMarker
  );
  if (actor && existingPickup && !tile) {
    return { success: true, alreadyPickedUp: true, itemId: existingPickup.id };
  }
  const thrownItem = tile?.getFlag?.(SYSTEM_ID, THROWN_ITEM_FLAG);
  if (!scene || !tile || !actor || !thrownItem?.itemData) {
    return { success: false, reason: "missingDocument" };
  }
  const requestingUser = game.users?.get(requestingUserId);
  if (requestingUser && !requestingUser.isGM && !actor.testUserPermission(requestingUser, "OWNER")) {
    throw new Error("The requester cannot pick up an item for this Actor.");
  }

  const itemData = normalizePickedUpItemData(thrownItem.itemData);
  foundry.utils.setProperty(itemData, `flags.${SYSTEM_ID}.thrownPickupTileUuid`, pickupMarker);
  if (existingPickup) {
    await attachDelayedThrownItemRegionToActor(itemData, actor, scene);
    await scene.deleteEmbeddedDocuments("Tile", [tile.id]);
    return { success: true, alreadyPickedUp: true, itemId: existingPickup.id };
  }
  if (!isContainerItem(itemData)) {
    const parentIds = [
      ROOT_CONTAINER_ID,
      ...actor.items.contents
        .filter(item => isContainerItem(item) && !getItemContainerParentId(item) && item.system?.equipped)
        .map(item => item.id)
    ];
    let grantedItem = null;
    let grantError = null;
    for (const parentId of parentIds) {
      try {
        grantedItem = await grantActorInventoryItem(actor, itemData, {
          quantity: Math.max(1, toInteger(itemData.system?.quantity) || 1),
          parentId,
          merge: false
        });
        if (grantedItem) break;
      } catch (error) {
        grantError = error;
      }
    }
    if (!grantedItem) {
      console.warn(`${SYSTEM_ID} | Thrown item pickup failed`, grantError);
      ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));
      return { success: false, reason: "noInventorySpace" };
    }
    await attachDelayedThrownItemRegionToActor(itemData, actor, scene);
    await scene.deleteEmbeddedDocuments("Tile", [tile.id]);
    return { success: true, itemId: grantedItem.id ?? "" };
  }

  const targetPlacement = findFirstActorDropPlacement(actor, itemData);
  if (!targetPlacement) {
    ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));
    return { success: false, reason: "noInventorySpace" };
  }

  const storedPlacement = createStoredPlacement(targetPlacement.placement, itemData);
  foundry.utils.mergeObject(itemData, {
    system: {
      equipped: false,
      container: {
        parentId: targetPlacement.parentId
      },
      placement: {
        mode: storedPlacement.mode,
        equipmentSlot: storedPlacement.equipmentSlot,
        weaponSet: storedPlacement.weaponSet,
        weaponSlot: storedPlacement.weaponSlot,
        x: storedPlacement.x,
        y: storedPlacement.y,
        width: storedPlacement.width,
        height: storedPlacement.height,
        rotated: storedPlacement.rotated
      }
    }
  });

  const created = await executeInventoryMutation({
    actor,
    creates: [itemData]
  }, { reason: "pickup-thrown-item" });
  await attachDelayedThrownItemRegionToActor(itemData, actor, scene);
  await scene.deleteEmbeddedDocuments("Tile", [tile.id]);
  return {
    success: true,
    itemId: String(created?.createdDocuments?.[0]?.id ?? "")
  };
}

async function promptThrownItemPickupForCombat(combat) {
  const combatId = String(combat?.id ?? "");
  const userId = String(game.user?.id ?? "");
  if (!combatId || !userId) return;

  const promptKey = `${combatId}:${userId}`;
  if (combatPickupPromptKeys.has(promptKey)) return;

  const entries = await getThrownItemPickupEntriesForCombat(combat, userId);
  if (!entries.length) return;
  combatPickupPromptKeys.add(promptKey);

  const pickedIndexes = new Set();
  const itemList = entries.map((entry, index) => `
    <li data-thrown-item-row="${index}" style="display:flex; align-items:center; gap:0.5rem; margin:0.35rem 0;">
      <span style="flex:1;"><strong>${escapeHTML(entry.thrownItem.itemData?.name ?? entry.tile.name)}</strong> -> ${escapeHTML(entry.actor.name)}</span>
      <button type="button" data-thrown-item-pickup="${index}">
        <i class="fa-solid fa-hand"></i>
        <span>Забрать</span>
      </button>
    </li>
  `).join("");

  await DialogV2.wait({
    window: { title: "Возврат метнутых предметов" },
    content: `<p>Забрать метнутые в этом бою предметы?</p><ul style="list-style:none; padding-left:0;">${itemList}</ul>`,
    buttons: [{
      action: "takeAll",
      label: "Забрать все",
      icon: "fa-solid fa-check",
      callback: async (_event, _button, dialog) => {
        for (const [index, entry] of entries.entries()) {
          if (pickedIndexes.has(index)) continue;
          if (!entry.tile.parent?.tiles?.get(entry.tile.id)) {
            markThrownItemPickupRow(dialog, index, pickedIndexes);
            continue;
          }
          await requestPickupThrownItemTile(entry.tile, entry.actor);
          markThrownItemPickupRow(dialog, index, pickedIndexes);
        }
        closeThrownItemPickupDialogIfEmpty(dialog, entries, pickedIndexes);
        return "takeAll";
      }
    }],
    render: (_event, dialog) => {
      for (const button of dialog.element.querySelectorAll("[data-thrown-item-pickup]")) {
        button.addEventListener("click", async event => {
          event.preventDefault();
          event.stopPropagation();
          const index = toInteger(button.dataset.thrownItemPickup);
          if (pickedIndexes.has(index)) return;
          const entry = entries[index];
          if (!entry) return;
          button.disabled = true;
          if (entry.tile.parent?.tiles?.get(entry.tile.id)) await requestPickupThrownItemTile(entry.tile, entry.actor);
          markThrownItemPickupRow(dialog, index, pickedIndexes);
          closeThrownItemPickupDialogIfEmpty(dialog, entries, pickedIndexes);
        });
      }
    },
    rejectClose: false,
    modal: true
  });
}

function markThrownItemPickupRow(dialog, index, pickedIndexes) {
  pickedIndexes.add(index);
  const row = dialog.element.querySelector(`[data-thrown-item-row="${index}"]`);
  if (!row) return;
  row.style.opacity = "0.45";
  row.style.textDecoration = "line-through";
  const button = row.querySelector("[data-thrown-item-pickup]");
  if (button) button.disabled = true;
}

function closeThrownItemPickupDialogIfEmpty(dialog, entries, pickedIndexes) {
  if (pickedIndexes.size < entries.length) return;
  void dialog.close({ submitted: true });
}

async function getThrownItemPickupEntriesForCombat(combat, userId) {
  const entries = [];
  const combatId = String(combat?.id ?? "");
  for (const scene of getCombatThrownItemScenes(combat)) {
    for (const tile of scene.tiles?.contents ?? []) {
      const thrownItem = tile.getFlag?.(SYSTEM_ID, THROWN_ITEM_FLAG);
      if (!thrownItem?.itemData) continue;
      if (String(thrownItem.combatId ?? "") !== combatId) continue;
      if (String(thrownItem.sourceUserId ?? "") !== userId) continue;

      const actor = await fromUuid(String(thrownItem.sourceActorUuid ?? ""));
      if (!actor?.isOwner) continue;
      entries.push({ scene, tile, thrownItem, actor });
    }
  }
  return entries;
}

function getCombatThrownItemScenes(combat) {
  const scenes = new Map();
  const addScene = sceneOrId => {
    const scene = typeof sceneOrId === "string" ? game.scenes?.get(sceneOrId) : sceneOrId;
    if (scene?.id) scenes.set(scene.id, scene);
  };

  addScene(combat?.scene);
  for (const combatant of combat?.combatants ?? []) addScene(combatant.sceneId);
  if (!scenes.size && game.combat?.id === combat?.id) addScene(canvas.scene);
  return scenes.values();
}

function getPickupActor() {
  return (canvas.tokens?.controlled ?? []).find(token => token.actor?.isOwner)?.actor
    ?? (game.user?.character?.isOwner ? game.user.character : null);
}

function findFirstActorDropPlacement(actor, itemData) {
  const allItems = actor.items.contents;
  const item = { system: itemData.system ?? {} };
  const rootDimensions = getActorRootInventoryDimensions(actor);
  const contexts = [
    {
      parentId: ROOT_CONTAINER_ID,
      items: getContextInventoryItems(ROOT_CONTAINER_ID, allItems),
      dimensions: rootDimensions,
      options: getActorRootInventoryGridOptions(actor, ROOT_CONTAINER_ID)
    },
    ...allItems
      .filter(candidate => isContainerItem(candidate) && !getItemContainerParentId(candidate) && candidate.system?.equipped)
      .map(container => {
        const dimensions = getContainerInventoryGridOptions(container);
        return {
          parentId: container.id,
          items: getContextInventoryItems(container.id, allItems),
          dimensions,
          options: dimensions
        };
      })
  ];

  for (const context of contexts) {
    const placement = findFirstAvailableInventoryPlacement(
      context.items,
      context.dimensions.columns,
      context.dimensions.rows,
      item,
      allItems,
      [],
      [],
      context.options
    );
    if (!placement) continue;

    const projectedItem = normalizePickedUpItemData(itemData);
    const storedPlacement = createStoredPlacement(placement, item);
    foundry.utils.mergeObject(projectedItem, {
      system: {
        equipped: false,
        container: {
          parentId: context.parentId
        },
        placement: {
          mode: storedPlacement.mode,
          equipmentSlot: storedPlacement.equipmentSlot,
          weaponSet: storedPlacement.weaponSet,
          weaponSlot: storedPlacement.weaponSlot,
          x: storedPlacement.x,
          y: storedPlacement.y,
          width: storedPlacement.width,
          height: storedPlacement.height,
          rotated: storedPlacement.rotated
        }
      }
    });

    const projectedItems = [
      ...allItems.map(existingItem => existingItem.toObject()),
      projectedItem
    ];
    if (validateInventoryTree(projectedItems, rootDimensions, {
      rootOptions: getActorRootInventoryGridOptions(actor, ROOT_CONTAINER_ID)
    }).valid) {
      return { parentId: context.parentId, placement };
    }
  }

  return null;
}

function getActorRootInventoryDimensions(actor) {
  const race = getCreatureOptions().races.find(entry => entry.id === actor.system?.creature?.raceId);
  return getActorInventoryGridDimensions(actor, race);
}

function normalizeDroppedItemData(itemData) {
  const data = foundry.utils.deepClone(itemData);
  delete data._id;
  const quantity = Math.max(1, toInteger(data.system?.quantity) || 1);
  foundry.utils.mergeObject(data, {
    system: {
      quantity,
      equipped: false,
      container: { parentId: "" },
      placement: {
        mode: "inventory",
        equipmentSlot: "",
        weaponSet: "",
        weaponSlot: "",
        x: 1,
        y: 1
      }
    }
  });
  foundry.utils.setProperty(data, "system.stackParts", []);
  return data;
}

function normalizePickedUpItemData(itemData) {
  return normalizeDroppedItemData(itemData);
}

function getDroppedItemTileSize(scene) {
  const gridSize = Math.max(1, Number(scene?.grid?.size ?? canvas.grid?.size) || 100);
  return Math.max(24, Math.round(gridSize * 0.45));
}

async function getDroppedItemTileDimensions(scene, image) {
  const height = getDroppedItemTileSize(scene);
  let aspectRatio = 1;
  try {
    const texture = await foundry.canvas.loadTexture(image);
    const textureWidth = Number(texture?.width ?? texture?.baseTexture?.width);
    const textureHeight = Number(texture?.height ?? texture?.baseTexture?.height);
    if (textureWidth > 0 && textureHeight > 0) aspectRatio = textureWidth / textureHeight;
  } catch (_error) {
    aspectRatio = 1;
  }
  return {
    width: Math.max(1, Math.round(height * aspectRatio)),
    height
  };
}

function getNextTileSort(scene) {
  const sorts = (scene.tiles?.contents ?? []).map(tile => Number(tile.sort) || 0);
  return Math.max(0, ...sorts) + 1;
}

function requestThrownItemSocket(action, request, gm, requestId = "") {
  const id = String(requestId ?? "").trim() || foundry.utils.randomID();
  const existing = pendingThrownItemSocketRequests.get(id);
  if (existing?.promise) return existing.promise;
  const requesterUserId = String(game.user?.id ?? "");
  let entry;
  const promise = new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingThrownItemSocketRequests.delete(id);
      const error = new Error(`GM did not answer thrown item request: ${String(action ?? "")}.`);
      error.code = "socket-timeout";
      reject(error);
    }, THROWN_ITEM_SOCKET_TIMEOUT_MS);
    entry = { resolve, reject, timeout, promise: null };
  });
  entry.promise = promise;
  pendingThrownItemSocketRequests.set(id, entry);

  try {
    game.socket.emit(THROWN_ITEM_SOCKET, {
      scope: THROWN_ITEM_SOCKET_SCOPE,
      type: "request",
      action,
      requestId: id,
      requesterUserId,
      gmUserId: gm.id,
      request
    });
  } catch (error) {
    window.clearTimeout(entry.timeout);
    pendingThrownItemSocketRequests.delete(id);
    entry.reject(error);
  }
  return promise;
}

async function requestThrownItemSocketWithRetry(action, request, gm, requestId = "") {
  try {
    return await requestThrownItemSocket(action, request, gm, requestId);
  } catch (error) {
    if (error?.code !== "socket-timeout") throw error;
    return requestThrownItemSocket(action, request, gm, requestId);
  }
}

function settleThrownItemSocketRequest(payload) {
  const requestId = String(payload.requestId ?? "");
  const pending = pendingThrownItemSocketRequests.get(requestId);
  if (!pending) return;
  window.clearTimeout(pending.timeout);
  pendingThrownItemSocketRequests.delete(requestId);
  if (payload.ok) pending.resolve(payload.result);
  else pending.reject(new Error(payload.error || "Thrown item socket request failed."));
}

function emitThrownItemSocketResponse({
  requestId = "",
  recipientUserId = "",
  ok = false,
  result = null,
  error = ""
} = {}) {
  game.socket.emit(THROWN_ITEM_SOCKET, {
    scope: THROWN_ITEM_SOCKET_SCOPE,
    type: "response",
    requestId,
    recipientUserId,
    ok,
    result,
    error
  });
}

async function runIdempotentSocketRequest(activeRequests, completedRequests, key, callback) {
  const now = Date.now();
  const completed = completedRequests.get(key);
  if (completed?.expiresAt > now) return completed.result;
  if (completed) completedRequests.delete(key);
  if (activeRequests.has(key)) return activeRequests.get(key);

  const promise = Promise.resolve().then(callback);
  activeRequests.set(key, promise);
  try {
    const result = await promise;
    completedRequests.set(key, {
      expiresAt: now + THROWN_ITEM_SOCKET_RESULT_TTL_MS,
      result
    });
    pruneSocketResultCache(completedRequests, now);
    return result;
  } finally {
    activeRequests.delete(key);
  }
}

function pruneSocketResultCache(cache, now = Date.now()) {
  for (const [key, entry] of cache) {
    if (entry?.expiresAt <= now) cache.delete(key);
  }
  while (cache.size > 200) cache.delete(cache.keys().next().value);
}

function getResponsibleGM() {
  return (game.users?.contents ?? [])
    .filter(user => user.active && user.isGM)
    .sort((left, right) => left.id.localeCompare(right.id))
    .at(0) ?? null;
}

function normalizeImagePath(path, fallback = "") {
  return String(path ?? "").trim() || fallback;
}

function serializePoint(point) {
  const data = {
    x: Number(point?.x) || 0,
    y: Number(point?.y) || 0
  };
  if (Number.isFinite(Number(point?.elevation))) data.elevation = Number(point.elevation);
  return data;
}

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}
