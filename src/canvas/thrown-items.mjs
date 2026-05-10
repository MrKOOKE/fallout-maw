import { SYSTEM_ID } from "../constants.mjs";
import { getCreatureOptions } from "../settings/accessors.mjs";
import { createDefaultInventorySize } from "../settings/creature-options.mjs";
import {
  ROOT_CONTAINER_ID,
  createStoredPlacement,
  findFirstAvailableInventoryPlacement,
  getContainerDimensions,
  getContextInventoryItems,
  getItemContainerParentId,
  isContainerItem,
  validateInventoryTree
} from "../utils/inventory-containers.mjs";
import { toInteger } from "../utils/numbers.mjs";

const { DialogV2 } = foundry.applications.api;
const THROWN_ITEM_SOCKET = `system.${SYSTEM_ID}`;
const THROWN_ITEM_SOCKET_SCOPE = "thrownItems";
const THROWN_ITEM_FLAG = "thrownItem";
const DEFAULT_TILE_IMAGE = "icons/svg/item-bag.svg";

let tilePatchRegistered = false;
let canvasPickupListenerRegistered = false;

export function registerThrownItemHooks() {
  game.socket.on(THROWN_ITEM_SOCKET, handleThrownItemSocketMessage);
  patchTileInteractions();
  registerCanvasPickupListener();
  Hooks.on("canvasReady", () => {
    patchTileInteractions();
    registerCanvasPickupListener();
  });
}

export async function createThrownItemTile({ sceneId = "", itemData = null, point = null, sourceActorUuid = "", sourceItemUuid = "" } = {}) {
  if (!sceneId || !itemData || !point) return null;
  const request = {
    sceneId,
    itemData: normalizeDroppedItemData(itemData),
    point: serializePoint(point),
    sourceActorUuid: String(sourceActorUuid ?? ""),
    sourceItemUuid: String(sourceItemUuid ?? "")
  };

  if (game.user?.isGM) return createThrownItemTileDocument(request);

  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("Нет активного GM для создания брошенного предмета.");
    return null;
  }

  game.socket.emit(THROWN_ITEM_SOCKET, {
    scope: THROWN_ITEM_SOCKET_SCOPE,
    action: "createThrownItemTile",
    gmUserId: gm.id,
    senderUserId: game.user?.id ?? "",
    request
  });
  return null;
}

async function handleThrownItemSocketMessage(payload = {}) {
  if (!payload || payload.scope !== THROWN_ITEM_SOCKET_SCOPE || payload.senderUserId === game.user?.id) return;
  if (!game.user?.isGM || payload.gmUserId !== game.user.id) return;

  if (payload.action === "createThrownItemTile") {
    await createThrownItemTileDocument(payload.request ?? {});
    return;
  }

  if (payload.action === "pickupThrownItemTile") {
    await pickupThrownItemTile({
      ...(payload.request ?? {}),
      requestingUserId: payload.senderUserId
    });
  }
}

async function createThrownItemTileDocument({ sceneId = "", itemData = null, point = null, sourceActorUuid = "", sourceItemUuid = "" } = {}) {
  const scene = game.scenes?.get(sceneId);
  if (!scene || !itemData || !point) return null;

  const size = getDroppedItemTileSize(scene);
  const x = Math.round(Number(point.x) || 0);
  const y = Math.round(Number(point.y) || 0);
  const created = await scene.createEmbeddedDocuments("Tile", [{
    name: String(itemData.name ?? game.i18n.localize("DOCUMENT.Item")),
    texture: {
      src: normalizeImagePath(itemData.img, DEFAULT_TILE_IMAGE),
      anchorX: 0.5,
      anchorY: 0.5
    },
    x,
    y,
    width: size,
    height: size,
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
          createdAt: Number(game.time?.worldTime) || 0
        }
      }
    }
  }]);
  return created?.[0] ?? null;
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
    actorUuid: actor.uuid
  };
  if (!request.sceneId || !request.tileId || !request.actorUuid) return;

  if (game.user?.isGM) {
    await pickupThrownItemTile(request);
    return;
  }

  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("Нет активного GM для подбора брошенного предмета.");
    return;
  }

  game.socket.emit(THROWN_ITEM_SOCKET, {
    scope: THROWN_ITEM_SOCKET_SCOPE,
    action: "pickupThrownItemTile",
    gmUserId: gm.id,
    senderUserId: game.user?.id ?? "",
    request
  });
}

async function pickupThrownItemTile({ sceneId = "", tileId = "", actorUuid = "", requestingUserId = "" } = {}) {
  const scene = game.scenes?.get(sceneId);
  const tile = scene?.tiles?.get(tileId);
  const actor = await fromUuid(actorUuid);
  const thrownItem = tile?.getFlag?.(SYSTEM_ID, THROWN_ITEM_FLAG);
  if (!scene || !tile || !actor || !thrownItem?.itemData) return;
  const requestingUser = game.users?.get(requestingUserId);
  if (requestingUser && !requestingUser.isGM && !actor.testUserPermission(requestingUser, "OWNER")) return;

  const itemData = normalizePickedUpItemData(thrownItem.itemData);
  const targetPlacement = findFirstActorDropPlacement(actor, itemData);
  if (!targetPlacement) {
    ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));
    return;
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
        height: storedPlacement.height
      }
    }
  });

  await actor.createEmbeddedDocuments("Item", [itemData]);
  await scene.deleteEmbeddedDocuments("Tile", [tile.id]);
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
      dimensions: rootDimensions
    },
    ...allItems
      .filter(candidate => isContainerItem(candidate) && !getItemContainerParentId(candidate) && candidate.system?.equipped)
      .map(container => ({
        parentId: container.id,
        items: getContextInventoryItems(container.id, allItems),
        dimensions: getContainerDimensions(container)
      }))
  ];

  for (const context of contexts) {
    const placement = findFirstAvailableInventoryPlacement(
      context.items,
      context.dimensions.columns,
      context.dimensions.rows,
      item,
      allItems,
      [],
      []
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
          height: storedPlacement.height
        }
      }
    });

    const projectedItems = [
      ...allItems.map(existingItem => existingItem.toObject()),
      projectedItem
    ];
    if (validateInventoryTree(projectedItems, rootDimensions).valid) {
      return { parentId: context.parentId, placement };
    }
  }

  return null;
}

function getActorRootInventoryDimensions(actor) {
  const race = getCreatureOptions().races.find(entry => entry.id === actor.system?.creature?.raceId);
  const inventorySize = race?.inventorySize ?? createDefaultInventorySize();
  return {
    columns: Math.max(1, toInteger(inventorySize.columns) || createDefaultInventorySize().columns),
    rows: Math.max(1, toInteger(inventorySize.rows) || createDefaultInventorySize().rows)
  };
}

function normalizeDroppedItemData(itemData) {
  const data = foundry.utils.deepClone(itemData);
  delete data._id;
  foundry.utils.mergeObject(data, {
    system: {
      quantity: 1,
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
  return data;
}

function normalizePickedUpItemData(itemData) {
  return normalizeDroppedItemData(itemData);
}

function getDroppedItemTileSize(scene) {
  const gridSize = Math.max(1, Number(scene?.grid?.size ?? canvas.grid?.size) || 100);
  return Math.max(24, Math.round(gridSize * 0.45));
}

function getNextTileSort(scene) {
  const sorts = (scene.tiles?.contents ?? []).map(tile => Number(tile.sort) || 0);
  return Math.max(0, ...sorts) + 1;
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
