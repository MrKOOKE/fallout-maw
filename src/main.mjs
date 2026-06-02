import { FALLOUT_MAW, syncSystemConfig } from "./config/system-config.mjs";
import { FalloutMaWToken } from "./canvas/token.mjs";
import { FalloutMaWTokenRuler } from "./canvas/token-ruler.mjs";
import { registerPostureMovementHooks } from "./canvas/posture-movement.mjs";
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
import { initializeCombatCarousel, registerCombatCarouselHooks } from "./apps/combat-carousel.mjs";
import { registerAnimationLibraryBrowserHooks } from "./apps/animation-library-browser.mjs";
import { registerWorldTimeControlHooks } from "./apps/world-time-control.mjs";
import { registerPersonalGeneratorHooks } from "./apps/personal-generator.mjs";
import { registerSkillCheckSocket } from "./rolls/skill-check.mjs";
import { registerDamageHubConfig, registerDamageSocket } from "./combat/damage-hub.mjs";
import { registerAttackAnimationSocket } from "./combat/attack-animations.mjs";
import { registerWeaponAttackSocket } from "./combat/weapon-attack-controller.mjs";
import { registerMedicineSocket } from "./apps/medicine-dialog.mjs";
import { registerRepairSocket } from "./apps/repair-dialog.mjs";
import { canStackItems, registerSearchInventorySocket } from "./apps/search-inventory.mjs";
import { registerFirstAidSocket } from "./items/first-aid.mjs";
import { registerAbilityEffectHooks, syncLoadedActorAbilityEffects } from "./abilities/effects.mjs";
import { registerAbilityCooldownHooks } from "./abilities/cooldowns.mjs";
import { registerDescriptionFormulaEnrichment } from "./formulas/description-formulas.mjs";
import { registerNeedThresholdHooks } from "./needs/need-thresholds.mjs";
import { registerRegenerationHooks } from "./needs/regeneration.mjs";
import { registerNaturalRaceItemHooks, syncLoadedActorsNaturalRaceItems } from "./races/natural-items.mjs";
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
  getItemMaxStack,
  getItemQuantity,
  isContainerItem,
  validateInventoryTree
} from "./utils/inventory-containers.mjs";
import { escapeHTML, getActorInventoryGridDimensions, getActorRootInventoryGridOptions } from "./utils/actor-display-data.mjs";
import { toInteger } from "./utils/numbers.mjs";

const { DialogV2 } = foundry.applications.api;
const { FormDataExtended } = foundry.applications.ux;

Hooks.once("init", () => {
  console.log(`${FALLOUT_MAW.title} | Initializing system`);

  CONFIG.FalloutMaW = syncSystemConfig();
  CONFIG.Actor.documentClass = FalloutMaWActor;
  CONFIG.Item.documentClass = FalloutMaWItem;
  CONFIG.Token.objectClass = FalloutMaWToken;
  CONFIG.Token.rulerClass = FalloutMaWTokenRuler;
  CONFIG.time.roundTime = 6;
  CONFIG.time.turnTime = 0;
  CONFIG.ActiveEffect.expiryAction = "delete";
  registerDamageHubConfig();
  CONFIG.ux.DragDrop = FalloutMaWDragDrop;

  registerSystemSettings();
  registerDescriptionFormulaEnrichment();
  registerDataModels();
  registerSystemSheets();
  registerTrackableAttributes();
  registerPostureMovementHooks();
  registerCombatDodgeHooks();
  registerCombatMovementHooks();
  registerAbilityEffectHooks();
  registerAbilityCooldownHooks();
  registerNeedThresholdHooks();
  registerRegenerationHooks();
  registerNaturalRaceItemHooks();
  registerSkillCheckControlHooks();
  registerTokenActionHudHooks();
  registerCombatCarouselHooks();
  registerWorldTimeControlHooks();
  registerPersonalGeneratorHooks();
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
  initializeCombatCarousel();
  await syncLoadedActorAbilityEffects();
  await syncLoadedActorsNaturalRaceItems();
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

  const itemData = droppedItem.toObject();
  if (getItemMaxStack(itemData) > 1) {
    const quantity = await promptActorDropItemQuantity(itemData);
    if (!quantity) return false;
    foundry.utils.setProperty(itemData, "system.quantity", quantity);
  }

  const dropPlan = planActorDropItem(actor, itemData);
  if (!dropPlan) {
    ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));
    return false;
  }

  if (dropPlan.updates.length) await actor.updateEmbeddedDocuments("Item", dropPlan.updates);
  if (dropPlan.creates.length) await actor.createEmbeddedDocuments("Item", dropPlan.creates);
  return false;
});

async function promptActorDropItemQuantity(itemData) {
  const initial = Math.max(1, getItemQuantity(itemData));
  const formData = await DialogV2.input({
    window: { title: game.i18n.localize("FALLOUTMAW.Item.Quantity") },
    content: `
      <p><strong>${escapeHTML(itemData?.name ?? "")}</strong></p>
      <label class="fallout-maw-stacked-field">
        <span>${game.i18n.localize("FALLOUTMAW.Item.Quantity")}: 1+</span>
        <input type="number" name="quantity" value="${initial}" min="1" step="1" autofocus>
      </label>
    `,
    ok: {
      label: game.i18n.localize("FALLOUTMAW.Common.Create"),
      icon: "fa-solid fa-check",
      callback: (_event, button) => new FormDataExtended(button.form).object
    },
    buttons: [{
      action: "cancel",
      label: game.i18n.localize("FALLOUTMAW.Common.Cancel")
    }],
    position: { width: 420 },
    rejectClose: false
  });
  if (!formData || formData === "cancel") return 0;
  return Math.max(1, toInteger(formData.quantity));
}

function planActorDropItem(actor, itemData) {
  const maxStack = getItemMaxStack(itemData);
  let remainingQuantity = Math.max(1, getItemQuantity(itemData));
  const updates = [];
  const creates = [];
  const reservedPlacements = new Map();

  if (maxStack > 1) {
    for (const target of getActorDropStackTargets(actor, itemData)) {
      if (remainingQuantity <= 0) break;
      const availableSpace = Math.max(0, getItemMaxStack(target) - getItemQuantity(target));
      const transferredQuantity = Math.min(remainingQuantity, availableSpace);
      if (!transferredQuantity) continue;
      updates.push({
        _id: target.id,
        "system.quantity": getItemQuantity(target) + transferredQuantity
      });
      remainingQuantity -= transferredQuantity;
    }
  }

  while (remainingQuantity > 0) {
    const stackQuantity = Math.min(remainingQuantity, maxStack);
    const stackData = foundry.utils.deepClone(itemData);
    foundry.utils.setProperty(stackData, "system.quantity", stackQuantity);
    const targetPlacement = findFirstActorDropPlacement(actor, stackData, reservedPlacements);
    if (!targetPlacement) return null;
    const createData = createActorDropItemData(stackData, targetPlacement);
    creates.push(createData);
    if (!reservedPlacements.has(targetPlacement.parentId)) reservedPlacements.set(targetPlacement.parentId, []);
    reservedPlacements.get(targetPlacement.parentId).push(targetPlacement.placement);
    remainingQuantity -= stackQuantity;
  }

  const rootDimensions = getActorRootInventoryDimensions(actor);
  const projectedItems = projectActorDropItems(actor, { updates, creates });
  if (!validateInventoryTree(projectedItems, rootDimensions, {
    rootOptions: getActorRootInventoryGridOptions(actor, ROOT_CONTAINER_ID)
  }).valid) return null;
  return { updates, creates };
}

function getActorDropStackTargets(actor, itemData) {
  return getActorDropInventoryContexts(actor).flatMap(context => (
    context.items.filter(item => canStackItems(itemData, item))
  ));
}

function createActorDropItemData(itemData, targetPlacement) {
  const createData = foundry.utils.deepClone(itemData);
  const storedPlacement = createStoredPlacement(targetPlacement.placement, itemData);
  delete createData._id;
  delete createData.id;
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
  return createData;
}

function projectActorDropItems(actor, { updates = [], creates = [] } = {}) {
  const itemMap = new Map(actor.items.contents.map(item => [item.id, item.toObject()]));
  for (const update of updates) {
    if (!update?._id || !itemMap.has(update._id)) continue;
    const nextData = foundry.utils.deepClone(itemMap.get(update._id));
    for (const [key, value] of Object.entries(update)) {
      if (key === "_id") continue;
      foundry.utils.setProperty(nextData, key, value);
    }
    itemMap.set(update._id, nextData);
  }
  let syntheticIndex = 0;
  for (const createData of creates) {
    const syntheticId = `drop-item-${syntheticIndex += 1}`;
    const nextData = foundry.utils.deepClone(createData);
    nextData._id = syntheticId;
    nextData.id = syntheticId;
    itemMap.set(syntheticId, nextData);
  }
  return Array.from(itemMap.values());
}

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

function getActorDropInventoryContexts(actor) {
  const rootDimensions = getActorRootInventoryDimensions(actor);
  const allItems = actor.items.contents;
  return [
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
}

function findFirstActorDropPlacement(actor, itemData, reservedPlacements = new Map()) {
  const allItems = actor.items.contents;
  const rootDimensions = getActorRootInventoryDimensions(actor);

  for (const context of getActorDropInventoryContexts(actor)) {
    const placement = findFirstAvailableInventoryPlacement(
      context.items,
      context.dimensions.columns,
      context.dimensions.rows,
      itemData,
      allItems,
      [],
      reservedPlacements.get(context.parentId) ?? [],
      getActorRootInventoryGridOptions(actor, context.parentId)
    );
    if (!placement) continue;

    const projectedItems = projectActorDropItems(actor, {
      creates: [createActorDropItemData(itemData, { parentId: context.parentId, placement })]
    });
    if (validateInventoryTree(projectedItems, rootDimensions, {
      rootOptions: getActorRootInventoryGridOptions(actor, ROOT_CONTAINER_ID)
    }).valid) {
      return { parentId: context.parentId, placement };
    }
  }

  return null;
}

