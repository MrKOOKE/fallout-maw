import { FALLOUT_MAW, syncSystemConfig } from "./config/system-config.mjs";
import { FalloutMaWToken } from "./canvas/token.mjs";
import { FalloutMaWTokenLayer } from "./canvas/token-layer.mjs";
import { FalloutMaWTokenRuler } from "./canvas/token-ruler.mjs";
import { registerPostureMovementHooks } from "./canvas/posture-movement.mjs";
import { registerCoverHooks, registerCoverSocket } from "./canvas/cover.mjs";
import { registerTokenEquipmentHudHooks } from "./canvas/token-equipment-hud.mjs";
import { registerThrownItemHooks } from "./canvas/thrown-items.mjs";
import { registerTrapHooks } from "./canvas/traps.mjs";
import { registerLightNetworkHooks, registerLightNetworkSocket } from "./canvas/light-networks.mjs";
import { registerActorContainerHooks, registerActorContainerSocket } from "./canvas/actor-containers.mjs";
import { registerMovementInterruptionHooks } from "./canvas/movement-interruptions.mjs";
import {
  registerPeriodicDamageRegionHooks,
  syncPeriodicDamageRegionEffects
} from "./canvas/periodic-damage-regions.mjs";
import { registerCombatDodgeHooks, registerCombatDodgeSocket } from "./combat/dodge-resource.mjs";
import { registerCombatMovementHooks } from "./combat/movement-resources.mjs";
import { registerReactionResourceHooks } from "./combat/reaction-resources.mjs";
import { registerCombatEndResolutionHooks, registerCombatEndResolutionSocket } from "./combat/combat-end-resolution.mjs";
import { registerReactionHubConfig, registerReactionHubSocket } from "./combat/reaction-hub.mjs";
import { registerActiveActionHooks, registerActiveActionSocket } from "./combat/active-actions.mjs";
import { registerDataModels, registerTrackableAttributes } from "./data/index.mjs";
import { FalloutMaWActor, FalloutMaWCombat, FalloutMaWItem } from "./documents/index.mjs";
import { registerAdvancementMediaSocket } from "./advancement/media.mjs";
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
import { registerTravelGroupHudHooks, syncTravelGroupHud } from "./apps/travel-group-hud.mjs";
import { registerTravelMovementHooks, registerTravelMovementSocket } from "./global-map/travel-movement.mjs";
import { initializeCombatCarousel, registerCombatCarouselHooks } from "./apps/combat-carousel.mjs";
import { registerAnimationLibraryBrowserHooks } from "./apps/animation-library-browser.mjs";
import { registerTrapPlacementControlHooks } from "./apps/trap-placement-control.mjs";
import { registerWorldTimeControlHooks } from "./apps/world-time-control.mjs";
import { registerCampHooks, registerCampSocket } from "./apps/camp-window.mjs";
import { registerDynamicLightingHooks } from "./time/dynamic-lighting.mjs";
import { registerPersonalGeneratorHooks } from "./apps/personal-generator.mjs";
import { registerButcheringConfigHooks } from "./apps/butchering-config.mjs";
import { registerHackingHooks, registerHackingSocket } from "./apps/hacking-dialog.mjs";
import { registerSkillCheckSocket } from "./rolls/skill-check.mjs";
import { registerOneTimeSkillModifierHooks } from "./rolls/one-time-skill-modifiers.mjs";
import { registerDamageHubConfig, registerDamageSocket } from "./combat/damage-hub.mjs";
import { registerAttackAnimationSocket } from "./combat/attack-animations.mjs";
import { registerWeaponAttackSocket } from "./combat/weapon-attack-controller.mjs";
import { registerMedicineSocket } from "./apps/medicine-dialog.mjs";
import { registerRepairSocket } from "./apps/repair-dialog.mjs";
import { canStackItems, registerSearchInventorySocket } from "./apps/search-inventory.mjs";
import { initializeCraftRecipeWorldIndex } from "./apps/craft-window.mjs";
import { registerFirstAidSocket } from "./items/first-aid.mjs";
import { registerDroppedItemHooks } from "./items/dropped-items.mjs";
import { registerLightSourceHooks } from "./items/light-source.mjs";
import { registerEnergyConsumptionHooks } from "./items/energy-consumption.mjs";
import { registerAbilityEffectHooks, syncLoadedActorAbilityEffects } from "./abilities/effects.mjs";
import { registerAbilityCooldownHooks } from "./abilities/cooldowns.mjs";
import { registerAbilityItemUseHooks } from "./abilities/item-use-triggers.mjs";
import { registerFixedAbilityFunctionHooks, registerFixedAbilityFunctionSocket } from "./abilities/fixed-functions.mjs";
import { registerDangerSenseSocket } from "./abilities/danger-sense.mjs";
import { actorHasAbility, grantCatalogAbility } from "./abilities/purchase.mjs";
import { ABILITY_CATALOG_DRAG_TYPE, getAbilitySourceId } from "./settings/abilities.mjs";
import { registerDescriptionFormulaEnrichment } from "./formulas/description-formulas.mjs";
import { registerNeedThresholdHooks } from "./needs/need-thresholds.mjs";
import { registerRegenerationHooks } from "./needs/regeneration.mjs";
import { registerNaturalRaceItemHooks, syncLoadedActorNaturalRaceItems } from "./races/natural-items.mjs";
import { registerStealthHooks } from "./stealth/index.mjs";
import { initializeGlobalMapRuntime, registerGlobalMapSystem } from "./global-map/index.mjs";
import { registerSystemSheets } from "./sheets/index.mjs";
import { FalloutMaWDragDrop } from "./utils/drag-drop.mjs";
import { registerFormFocusDragGuard } from "./utils/form-focus-drag-guard.mjs";
import {
  ROOT_CONTAINER_ID,
  createAnchoredItemStackPartsForQuantity,
  createItemStackPartAdditionUpdate,
  createStoredPlacement,
  findFirstAvailableInventoryPlacement,
  getContainerInventoryGridOptions,
  getContextInventoryItems,
  getItemContainerParentId,
  getItemMaxStack,
  getItemQuantity,
  isContainerItem,
  usesVirtualInventoryStacks,
  validateInventoryTree
} from "./utils/inventory-containers.mjs";
import { escapeHTML, getActorInventoryGridDimensions, getActorRootInventoryGridOptions } from "./utils/actor-display-data.mjs";
import { toInteger } from "./utils/numbers.mjs";
import { resolveWorldItemSync } from "./utils/world-items.mjs";
const { DialogV2 } = foundry.applications.api;
const { FormDataExtended } = foundry.applications.ux;

Hooks.once("init", () => {
  console.log(`${FALLOUT_MAW.title} | Initializing system`);

  CONFIG.FalloutMaW = syncSystemConfig();
  CONFIG.Actor.documentClass = FalloutMaWActor;
  CONFIG.Combat.documentClass = FalloutMaWCombat;
  CONFIG.Item.documentClass = FalloutMaWItem;
  CONFIG.Token.objectClass = FalloutMaWToken;
  CONFIG.Canvas.layers.tokens.layerClass = FalloutMaWTokenLayer;
  CONFIG.Token.rulerClass = FalloutMaWTokenRuler;
  CONFIG.time.roundTime = 6;
  CONFIG.time.turnTime = 0;
  CONFIG.ActiveEffect.expiryAction = "delete";
  registerDamageHubConfig();
  registerReactionHubConfig();
  CONFIG.ux.DragDrop = FalloutMaWDragDrop;

  registerSystemSettings();
  registerDescriptionFormulaEnrichment();
  registerDataModels();
  registerSystemSheets();
  registerFormFocusDragGuard();
  registerTrackableAttributes();
  registerPostureMovementHooks();
  registerCoverHooks();
  registerTokenEquipmentHudHooks();
  registerMovementInterruptionHooks();
  registerPeriodicDamageRegionHooks();
  registerCombatDodgeHooks();
  registerCombatMovementHooks();
  registerReactionResourceHooks();
  registerCombatEndResolutionHooks();
  registerActiveActionHooks();
  registerAbilityEffectHooks();
  registerAbilityCooldownHooks();
  registerAbilityItemUseHooks();
  registerFixedAbilityFunctionHooks();
  registerOneTimeSkillModifierHooks();
  registerNeedThresholdHooks();
  registerRegenerationHooks();
  registerNaturalRaceItemHooks();
  registerDroppedItemHooks();
  registerLightSourceHooks();
  registerEnergyConsumptionHooks();
  registerSkillCheckControlHooks();
  registerTokenActionHudHooks();
  registerTravelGroupHudHooks();
  registerTravelMovementHooks();
  registerCombatCarouselHooks();
  registerWorldTimeControlHooks();
  registerDynamicLightingHooks();
  registerCampHooks();
  registerPersonalGeneratorHooks();
  registerButcheringConfigHooks();
  registerHackingHooks();
  registerAnimationLibraryBrowserHooks();
  registerTrapPlacementControlHooks();
  registerLightNetworkHooks();
  registerActorContainerHooks();
  registerStealthHooks();
  registerGlobalMapSystem();
});

Hooks.on("openDetachedWindow", (_id, win) => {
  registerFormFocusDragGuard(win?.document);
});

Hooks.once("ready", initializeGlobalMapRuntime);

Hooks.once("ready", async () => {
  await finalizeSystemSettings();
  registerSkillCheckControlSocket();
  refreshSkillCheckControlButton();
  registerSkillCheckSocket();
  registerDamageSocket();
  registerReactionHubSocket();
  registerAdvancementMediaSocket();
  registerAttackAnimationSocket();
  registerCombatDodgeSocket();
  registerCombatEndResolutionSocket();
  registerCoverSocket();
  registerActiveActionSocket();
  registerWeaponAttackSocket();
  registerThrownItemHooks();
  registerTrapHooks();
  registerLightNetworkSocket();
  registerActorContainerSocket();
  registerMedicineSocket();
  registerRepairSocket();
  registerSearchInventorySocket();
  registerHackingSocket();
  registerFirstAidSocket();
  registerTokenActionHudSocket();
  registerTravelMovementSocket();
  registerFixedAbilityFunctionSocket();
  registerDangerSenseSocket();
  registerCampSocket();
  refreshTokenActionHudControlButton();
  syncTokenActionHud();
  syncTravelGroupHud();
  initializeCombatCarousel();
  await syncLoadedActorNaturalRaceItems();
  await syncLoadedActorAbilityEffects();
  await syncPeriodicDamageRegionEffects();
  initializeCraftRecipeWorldIndex();
});

Hooks.on("dropCanvasData", async (canvas, data, event) => {
  if (data?.type === ABILITY_CATALOG_DRAG_TYPE) return dropAbilityOnCanvasToken(canvas, data);

  const droppedAbility = data?.type === "Item" ? await resolveDroppedAbilityItem(data) : null;
  if (droppedAbility) return dropAbilityItemOnCanvasToken(canvas, data, droppedAbility);

  if (data?.type !== "Item") return undefined;

  const target = getDropTargetToken(canvas, data);
  const actor = target?.actor;
  if (!actor) return undefined;
  if (!actor.isOwner) {
    ui.notifications.warn(`Нет прав на добавление предмета актеру ${actor.name}.`);
    return false;
  }

  const droppedItem = resolveWorldItemSync(data.uuid);
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

async function dropAbilityOnCanvasToken(canvas, data = {}) {
  const target = getDropTargetToken(canvas, data);
  const actor = target?.actor;
  if (!actor) return undefined;
  if (!actor.isOwner) {
    ui.notifications.warn(`Нет прав на добавление способности актеру ${actor.name}.`);
    return false;
  }

  const sourceId = String(data.sourceId ?? "").trim();
  const abilityName = String(data.name ?? "").trim() || "Способность";
  if (!sourceId) return false;
  if (actorHasAbility(actor, sourceId)) {
    ui.notifications.warn(`${actor.name} уже имеет способность: ${abilityName}.`);
    return false;
  }

  const item = await grantCatalogAbility(actor, sourceId);
  if (item) ui.notifications.info(`${actor.name}: добавлена способность ${item.name}.`);
  else ui.notifications.warn(`Не удалось добавить способность: ${abilityName}.`);
  return false;
}

async function dropAbilityItemOnCanvasToken(canvas, data = {}, item = null) {
  const target = getDropTargetToken(canvas, data);
  const actor = target?.actor;
  if (!actor) return undefined;
  if (!actor.isOwner) {
    ui.notifications.warn(`Нет прав на добавление способности актеру ${actor.name}.`);
    return false;
  }

  const sourceId = getAbilitySourceId(item);
  const abilityName = String(item?.name ?? "").trim() || "Способность";
  if (sourceId) {
    if (actorHasAbility(actor, sourceId)) {
      ui.notifications.warn(`${actor.name} уже имеет способность: ${abilityName}.`);
      return false;
    }
    const created = await grantCatalogAbility(actor, sourceId);
    if (created) ui.notifications.info(`${actor.name}: добавлена способность ${created.name}.`);
    else ui.notifications.warn(`Не удалось добавить способность: ${abilityName}.`);
    return false;
  }

  const itemData = item.toObject();
  delete itemData._id;
  delete itemData.id;
  const [created] = await actor.createEmbeddedDocuments("Item", [itemData]);
  if (created) ui.notifications.info(`${actor.name}: добавлена способность ${created.name}.`);
  return false;
}

async function resolveDroppedAbilityItem(data = {}) {
  const worldItem = data.uuid ? resolveWorldItemSync(data.uuid) : null;
  if (worldItem) return worldItem.type === "ability" ? worldItem : null;

  try {
    const item = await Item.implementation.fromDropData(data);
    return item?.type === "ability" ? item : null;
  } catch (_error) {
    return null;
  }
}

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
  if (usesVirtualInventoryStacks(itemData)) return planActorDropVirtualItem(actor, itemData);

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

function planActorDropVirtualItem(actor, itemData) {
  let remainingQuantity = Math.max(1, getItemQuantity(itemData));
  const updates = [];
  const creates = [];
  const reservedPlacements = new Map();
  const contexts = getActorDropInventoryContexts(actor);

  for (const target of getActorDropStackTargets(actor, itemData).filter(usesVirtualInventoryStacks)) {
    if (remainingQuantity <= 0) break;
    const parentId = getItemContainerParentId(target);
    const context = contexts.find(entry => entry.parentId === parentId);
    if (!context) continue;
    const parts = createAnchoredItemStackPartsForQuantity({
      itemData,
      quantity: remainingQuantity,
      contextItems: context.items,
      columns: context.dimensions.columns,
      rows: context.dimensions.rows,
      allItems: actor.items.contents,
      reservedPlacements: reservedPlacements.get(parentId) ?? [],
      options: getActorRootInventoryGridOptions(actor, parentId)
    });
    if (!parts?.length) continue;
    const transferQuantity = parts.reduce((total, part) => total + Math.max(1, toInteger(part.quantity)), 0);
    const updateData = createItemStackPartAdditionUpdate(target, transferQuantity, null, parts);
    if (!updateData) continue;
    updates.push(updateData);
    if (!reservedPlacements.has(parentId)) reservedPlacements.set(parentId, []);
    reservedPlacements.get(parentId).push(...parts.map(part => createPlacementFromStackPart(itemData, part)));
    remainingQuantity -= transferQuantity;
  }

  for (const context of contexts) {
    if (remainingQuantity <= 0) break;
    const parentId = context.parentId;
    const parts = createAnchoredItemStackPartsForQuantity({
      itemData,
      quantity: remainingQuantity,
      contextItems: context.items,
      columns: context.dimensions.columns,
      rows: context.dimensions.rows,
      allItems: actor.items.contents,
      reservedPlacements: reservedPlacements.get(parentId) ?? [],
      options: getActorRootInventoryGridOptions(actor, parentId)
    });
    if (!parts?.length) continue;
    const createQuantity = parts.reduce((total, part) => total + Math.max(1, toInteger(part.quantity)), 0);
    const stackData = foundry.utils.deepClone(itemData);
    foundry.utils.setProperty(stackData, "system.quantity", createQuantity);
    foundry.utils.setProperty(stackData, "system.stackParts", parts);
    creates.push(createActorDropItemData(stackData, {
      parentId,
      placement: createPlacementFromStackPart(stackData, parts[0])
    }));
    if (!reservedPlacements.has(parentId)) reservedPlacements.set(parentId, []);
    reservedPlacements.get(parentId).push(...parts.map(part => createPlacementFromStackPart(stackData, part)));
    remainingQuantity -= createQuantity;
  }

  if (remainingQuantity > 0) return null;
  const rootDimensions = getActorRootInventoryDimensions(actor);
  const projectedItems = projectActorDropItems(actor, { updates, creates });
  if (!validateInventoryTree(projectedItems, rootDimensions, {
    rootOptions: getActorRootInventoryGridOptions(actor, ROOT_CONTAINER_ID)
  }).valid) return null;
  return { updates, creates };
}

function createPlacementFromStackPart(itemData, part = {}) {
  const placement = itemData?.system?.placement ?? {};
  return {
    ...placement,
    x: Math.max(1, toInteger(part?.x)),
    y: Math.max(1, toInteger(part?.y)),
    rotated: Boolean(part?.rotated ?? placement.rotated)
  };
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
        height: storedPlacement.height,
        rotated: storedPlacement.rotated
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
      context.options
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

