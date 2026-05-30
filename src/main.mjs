import { FALLOUT_MAW, syncSystemConfig } from "./config/system-config.mjs";
import { FalloutMaWTokenRuler } from "./canvas/token-ruler.mjs";
import { registerThrownItemHooks } from "./canvas/thrown-items.mjs";
import { registerCombatDodgeHooks, registerCombatDodgeSocket } from "./combat/dodge-resource.mjs";
import { registerCombatMovementHooks } from "./combat/movement-resources.mjs";
import { registerDataModels, registerTrackableAttributes } from "./data/index.mjs";
import { FalloutMaWActor, FalloutMaWItem } from "./documents/index.mjs";
import { getCreatureOptions } from "./settings/accessors.mjs";
import { registerSystemSettings, finalizeSystemSettings } from "./settings/index.mjs";
import {
  refreshSkillCheckControlButton,
  registerSkillCheckControlHooks,
  registerSkillCheckControlSocket
} from "./rolls/skill-check-control.mjs";
import {
  refreshTokenActionHudControlButton,
  registerTokenActionHudHooks,
  registerTokenActionHudSocket,
  syncTokenActionHud
} from "./apps/token-action-hud.mjs";
import { registerAnimationLibraryBrowserHooks } from "./apps/animation-library-browser.mjs";
import { registerWorldTimeControlHooks } from "./apps/world-time-control.mjs";
import { registerSkillCheckSocket } from "./rolls/skill-check.mjs";
import { registerDamageSocket } from "./combat/damage-hub.mjs";
import { registerAttackAnimationSocket } from "./combat/attack-animations.mjs";
import { registerWeaponAttackSocket } from "./combat/weapon-attack-controller.mjs";
import { registerMedicineSocket } from "./apps/medicine-dialog.mjs";
import { registerRepairSocket } from "./apps/repair-dialog.mjs";
import { registerSearchInventorySocket } from "./apps/search-inventory.mjs";
import { registerFirstAidSocket } from "./items/first-aid.mjs";
import { registerAbilityEffectHooks, syncLoadedActorAbilityEffects } from "./abilities/effects.mjs";
import { registerNeedThresholdHooks } from "./needs/need-thresholds.mjs";
import { registerRegenerationHooks } from "./needs/regeneration.mjs";
import { registerStealthHooks } from "./stealth/index.mjs";
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
import { getActorInventoryGridDimensions } from "./utils/actor-display-data.mjs";

Hooks.once("init", () => {
  console.log(`${FALLOUT_MAW.title} | Initializing system`);

  CONFIG.FalloutMaW = syncSystemConfig();
  CONFIG.Actor.documentClass = FalloutMaWActor;
  CONFIG.Item.documentClass = FalloutMaWItem;
  CONFIG.Token.rulerClass = FalloutMaWTokenRuler;
  CONFIG.time.roundTime = 6;
  CONFIG.time.turnTime = 0;
  CONFIG.ActiveEffect.expiryAction = "delete";
  CONFIG.ux.DragDrop = FalloutMaWDragDrop;

  registerSystemSettings();
  registerDataModels();
  registerSystemSheets();
  registerTrackableAttributes();
  registerCombatDodgeHooks();
  registerCombatMovementHooks();
  registerAbilityEffectHooks();
  registerNeedThresholdHooks();
  registerRegenerationHooks();
  registerSkillCheckControlHooks();
  registerTokenActionHudHooks();
  registerWorldTimeControlHooks();
  registerAnimationLibraryBrowserHooks();
  registerStealthHooks();
});

Hooks.once("ready", async () => {
  await finalizeSystemSettings();
  registerSkillCheckControlSocket();
  refreshSkillCheckControlButton();
  registerSkillCheckSocket();
  registerDamageSocket();
  registerAttackAnimationSocket();
  registerCombatDodgeSocket();
  registerWeaponAttackSocket();
  registerThrownItemHooks();
  registerMedicineSocket();
  registerRepairSocket();
  registerSearchInventorySocket();
  registerFirstAidSocket();
  registerTokenActionHudSocket();
  refreshTokenActionHudControlButton();
  syncTokenActionHud();
  await syncLoadedActorAbilityEffects();
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
  return getActorInventoryGridDimensions(actor, race);
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

