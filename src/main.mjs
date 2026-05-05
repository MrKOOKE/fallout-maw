import { FALLOUT_MAW, syncSystemConfig } from "./config/system-config.mjs";
import { registerDataModels, registerTrackableAttributes } from "./data/index.mjs";
import { FalloutMaWActor, FalloutMaWItem } from "./documents/index.mjs";
import { getCreatureOptions } from "./settings/accessors.mjs";
import { createDefaultInventorySize } from "./settings/creature-options.mjs";
import { registerSystemSettings, finalizeSystemSettings } from "./settings/index.mjs";
import { registerSkillCheckSocket } from "./rolls/skill-check.mjs";
import { registerSystemSheets } from "./sheets/index.mjs";
import { FalloutMaWDragDrop } from "./utils/drag-drop.mjs";
import {
  ROOT_CONTAINER_ID,
  createStoredPlacement,
  findFirstAvailableInventoryPlacement,
  getContainerDimensions,
  getContextInventoryItems,
  getItemContainerParentId,
  isContainerItem,
  validateInventoryTree
} from "./utils/inventory-containers.mjs";

Hooks.once("init", () => {
  console.log(`${FALLOUT_MAW.title} | Initializing system`);

  CONFIG.FalloutMaW = syncSystemConfig();
  CONFIG.Actor.documentClass = FalloutMaWActor;
  CONFIG.Item.documentClass = FalloutMaWItem;
  CONFIG.time.roundTime = 6;
  CONFIG.time.turnTime = 0;
  CONFIG.ActiveEffect.expiryAction = "delete";
  CONFIG.ux.DragDrop = FalloutMaWDragDrop;

  registerSystemSettings();
  registerSystemSheets();
  registerDataModels();
  registerTrackableAttributes();
});

Hooks.once("ready", async () => {
  await finalizeSystemSettings();
  registerSkillCheckSocket();
});

Hooks.on("dropCanvasData", async (canvas, data, event) => {
  if (data?.type !== "Item") return undefined;

  const target = getDropTargetToken(canvas, data);
  const actor = target?.actor;
  if (!actor) return undefined;
  if (!actor.isOwner) {
    ui.notifications.warn(`Нет прав на добавление предмета актеру ${actor.name}.`);
    return false;
  }

  const droppedItem = await foundry.utils.getDocumentClass("Item").fromDropData(data);
  if (!droppedItem) return false;

  const targetPlacement = findFirstActorDropPlacement(actor, droppedItem);
  if (!targetPlacement) {
    ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));
    return false;
  }

  const createData = droppedItem.toObject();
  const storedPlacement = createStoredPlacement(targetPlacement.placement, droppedItem);
  delete createData._id;
  foundry.utils.mergeObject(createData, {
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

  await actor.createEmbeddedDocuments("Item", [createData]);
  return false;
});

function getDropTargetToken(canvas, data) {
  const collisionTest = ({ t: token }) => token.visible
    && token.renderable
    && token.interactive
    && token.hitArea?.contains(data.x - token.x, data.y - token.y);

  return Array.from(
    canvas.tokens.quadtree.getObjects(new PIXI.Rectangle(data.x, data.y, 0, 0), { collisionTest })
  )
    .sort((left, right) => left._lastSortedIndex - right._lastSortedIndex)
    .at(0) ?? null;
}

function getActorRootInventoryDimensions(actor) {
  const race = getCreatureOptions().races.find(entry => entry.id === actor.system?.creature?.raceId);
  const inventorySize = race?.inventorySize ?? createDefaultInventorySize();
  return {
    columns: Math.max(1, toInteger(inventorySize.columns) || createDefaultInventorySize().columns),
    rows: Math.max(1, toInteger(inventorySize.rows) || createDefaultInventorySize().rows)
  };
}

function findFirstActorDropPlacement(actor, item) {
  const allItems = actor.items.contents;
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

    const storedPlacement = createStoredPlacement(placement, item);
    const createData = item.toObject();
    delete createData._id;
    foundry.utils.mergeObject(createData, {
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
      createData
    ];
    if (validateInventoryTree(projectedItems, rootDimensions).valid) {
      return { parentId: context.parentId, placement };
    }
  }

  return null;
}

function toInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}
