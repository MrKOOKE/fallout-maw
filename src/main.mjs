import { FALLOUT_MAW, syncSystemConfig } from "./config/system-config.mjs";
import { FalloutMaWToken, initializeEffectTooltips } from "./canvas/token.mjs";
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
import { registerCanvasTargetSelectionLifecycleHooks } from "./canvas/target-selection-lifecycle.mjs";
import {
  registerPeriodicDamageRegionHooks,
  syncPeriodicDamageRegionEffects
} from "./canvas/periodic-damage-regions.mjs";
import { registerSmokeVisionHooks } from "./canvas/smoke-vision.mjs";
import { configureSmokePerceptionFormulaEvaluator } from "./canvas/smoke-perception.mjs";
import { registerCombatDodgeHooks, registerCombatDodgeSocket } from "./combat/dodge-resource.mjs";
import { registerCombatMovementHooks } from "./combat/movement-resources.mjs";
import { registerReactionResourceHooks } from "./combat/reaction-resources.mjs";
import { registerCombatTurnNavigationSocket } from "./combat/turn-navigation-socket.mjs";
import { registerCombatLifecycleLeaseQueries } from "./combat/combat-lifecycle-lease.mjs";
import { registerCombatEndResolutionHooks, registerCombatEndResolutionSocket } from "./combat/combat-end-resolution.mjs";
import { registerReactionHubConfig, registerReactionHubSocket } from "./combat/reaction-hub.mjs";
import { registerActiveActionHooks, registerActiveActionSocket } from "./combat/active-actions.mjs";
import { registerDataModels, registerTrackableAttributes } from "./data/index.mjs";
import {
  FalloutMaWActiveEffect,
  FalloutMaWActor,
  FalloutMaWCombat,
  FalloutMaWCombatant,
  FalloutMaWItem,
  FalloutMaWTokenDocument
} from "./documents/index.mjs";
import { registerAdvancementMediaSocket } from "./advancement/media.mjs";
import { getCreatureOptions } from "./settings/accessors.mjs";
import {
  registerSystemSettings,
  initializeSettingsPresets,
  finalizeSettingsPresetStartup
} from "./settings/index.mjs";
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
import { registerCampHooks, registerCampSocket } from "./apps/camp-window.mjs";
import { registerCalendarRuntimeHooks } from "./calendar/runtime.mjs";
import { registerDynamicLightingHooks } from "./time/dynamic-lighting.mjs";
import { registerActorFactionConfigHooks } from "./apps/faction-settings-config.mjs";
import { registerPersonalGeneratorHooks } from "./apps/personal-generator.mjs";
import { registerButcheringConfigHooks } from "./apps/butchering-config.mjs";
import { registerHackingHooks, registerHackingSocket } from "./apps/hacking-dialog.mjs";
import { registerSkillCheckSocket } from "./rolls/skill-check.mjs";
import { registerOneTimeSkillModifierHooks } from "./rolls/one-time-skill-modifiers.mjs";
import {
  registerDamageHubConfig,
  registerDamageSocket,
  startConsciousnessStatusSynchronization
} from "./combat/damage-hub.mjs";
import { migrateWorldConsciousnessData } from "./migrations/world.mjs";
import { removeObsoleteWorldSettings } from "./migrations/obsolete-world-settings.mjs";
import { registerAttackAnimationSocket } from "./combat/attack-animations.mjs";
import { registerWeaponAttackSocket } from "./combat/weapon-attack-controller.mjs";
import { registerMedicineSocket } from "./apps/medicine-dialog.mjs";
import { registerRepairSocket } from "./apps/repair-dialog.mjs";
import {
  canStackItems,
  registerSearchInventorySocket,
  transferItemBetweenActors
} from "./apps/search-inventory.mjs";
import { initializeCraftRecipeWorldIndex } from "./apps/craft-window.mjs";
import { registerFirstAidSocket } from "./items/first-aid.mjs";
import { registerDroppedItemHooks } from "./items/dropped-items.mjs";
import { registerLightSourceHooks } from "./items/light-source.mjs";
import { registerEnergyConsumptionHooks } from "./items/energy-consumption.mjs";
import {
  registerAbilityEffectHooks,
  syncActiveSceneActorAbilityEffects
} from "./abilities/effects.mjs";
import { registerActiveEffectAuraHooks } from "./abilities/active-effect-auras.mjs";
import { registerAbilityCooldownHooks } from "./abilities/cooldowns.mjs";
import { registerLimitedUseHooks, registerLimitedUseSocket } from "./abilities/limited-uses.mjs";
import { registerAbilityItemUseHooks } from "./abilities/item-use-triggers.mjs";
import { registerFixedAbilityFunctionHooks, registerFixedAbilityFunctionSocket } from "./abilities/fixed-functions.mjs";
import { registerDangerSenseSocket } from "./abilities/danger-sense.mjs";
import { actorHasAbility, grantAbilityItemData, grantCatalogAbility } from "./abilities/purchase.mjs";
import { ABILITY_CATALOG_DRAG_TYPE, getAbilitySourceId } from "./settings/abilities.mjs";
import { registerDescriptionFormulaEnrichment } from "./formulas/description-formulas.mjs";
import { registerSystemEventDispatcherSocket } from "./events/dispatcher.mjs";
import {
  publishFoundrySystemEventApi,
  recoverFoundrySystemEventEffects,
  registerFoundrySystemEventAuthorityHooks,
  registerFoundrySystemEventIntegration
} from "./events/foundry-integration.mjs";
import { registerFoundryMovementSystemEventHooks } from "./events/foundry-movement-events.mjs";
import {
  armFoundryVisionTracking,
  registerFoundryVisionSystemEventHooks
} from "./events/foundry-vision-events.mjs";
import { registerFoundryCompatibilitySystemEventHooks } from "./events/foundry-compatibility-events.mjs";
import { registerFoundryDocumentSystemEventHooks } from "./events/foundry-document-events.mjs";
import { registerFoundryWorldSystemEventHooks } from "./events/foundry-world-events.mjs";
import {
  registerNeedThresholdHooks,
  syncLoadedActorNeedThresholdEffects
} from "./needs/need-thresholds.mjs";
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
  getItemStackAdditionOverflowQuantity,
  isContainerItem,
  usesVirtualInventoryStacks,
  validateInventoryTree
} from "./utils/inventory-containers.mjs";
import { escapeHTML, getActorInventoryGridDimensions, getActorRootInventoryGridOptions } from "./utils/actor-display-data.mjs";
import { toInteger } from "./utils/numbers.mjs";
import { evaluateEffectChangeNumber } from "./utils/effect-change-values.mjs";
import { resolveWorldItemSync } from "./utils/world-items.mjs";
import { executeInventoryMutation } from "./inventory/mutation.mjs";
import { registerInventoryRepairHooks } from "./inventory/migration.mjs";
const { DialogV2 } = foundry.applications.api;
const { FormDataExtended } = foundry.applications.ux;

Hooks.once("init", () => {
  console.log(`${FALLOUT_MAW.title} | Initializing system`);

  CONFIG.FalloutMaW = syncSystemConfig();
  CONFIG.ActiveEffect.documentClass = FalloutMaWActiveEffect;
  CONFIG.Actor.documentClass = FalloutMaWActor;
  CONFIG.Combat.documentClass = FalloutMaWCombat;
  CONFIG.Combatant.documentClass = FalloutMaWCombatant;
  CONFIG.Item.documentClass = FalloutMaWItem;
  CONFIG.Token.documentClass = FalloutMaWTokenDocument;
  CONFIG.Token.objectClass = FalloutMaWToken;
  CONFIG.Canvas.layers.tokens.layerClass = FalloutMaWTokenLayer;
  CONFIG.Token.rulerClass = FalloutMaWTokenRuler;
  CONFIG.time.roundTime = 6;
  CONFIG.time.turnTime = 0;
  CONFIG.ActiveEffect.expiryAction = "delete";
  registerDamageHubConfig();
  registerReactionHubConfig();
  registerFoundrySystemEventIntegration();
  registerFoundrySystemEventAuthorityHooks();
  publishFoundrySystemEventApi();
  registerFoundryMovementSystemEventHooks();
  registerFoundryVisionSystemEventHooks();
  registerFoundryCompatibilitySystemEventHooks();
  registerFoundryDocumentSystemEventHooks();
  registerFoundryWorldSystemEventHooks();
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
  registerCanvasTargetSelectionLifecycleHooks();
  registerPeriodicDamageRegionHooks();
  configureSmokePerceptionFormulaEvaluator(evaluateEffectChangeNumber);
  registerSmokeVisionHooks();
  registerCombatDodgeHooks();
  registerCombatMovementHooks();
  registerReactionResourceHooks();
  registerCombatLifecycleLeaseQueries();
  registerCombatEndResolutionHooks();
  registerActiveActionHooks();
  registerAbilityEffectHooks();
  registerActiveEffectAuraHooks();
  registerAbilityCooldownHooks();
  registerLimitedUseHooks();
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
  registerCalendarRuntimeHooks();
  registerDynamicLightingHooks();
  registerCampHooks();
  registerActorFactionConfigHooks();
  registerPersonalGeneratorHooks();
  registerButcheringConfigHooks();
  registerHackingHooks();
  registerAnimationLibraryBrowserHooks();
  registerTrapPlacementControlHooks();
  registerLightNetworkHooks();
  registerActorContainerHooks();
  registerInventoryRepairHooks();
  registerStealthHooks();
  registerGlobalMapSystem();
});

Hooks.on("openDetachedWindow", (_id, win) => {
  registerFormFocusDragGuard(win?.document);
});

Hooks.once("ready", () => {
  // Foundry dispatches ready with Hooks.callAll and does not await callback
  // Promises. Register request handlers before starting any asynchronous
  // maintenance so the live UI never observes a half-registered system.
  initializeEffectTooltips();
  initializeGlobalMapRuntime();
  registerSkillCheckControlSocket();
  registerSkillCheckSocket();
  registerDamageSocket();
  registerSystemEventDispatcherSocket();
  registerLimitedUseSocket();
  registerReactionHubSocket();
  registerAdvancementMediaSocket();
  registerAttackAnimationSocket();
  registerCombatDodgeSocket();
  registerCombatTurnNavigationSocket();
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
  void initializeFalloutMawReadyState().catch(error => {
    console.error(`${FALLOUT_MAW.title} | Ready initialization failed`, error);
  });
});

async function initializeFalloutMawReadyState() {
  const startupStarted = globalThis.performance?.now?.() ?? Date.now();
  const presetsStarted = globalThis.performance?.now?.() ?? Date.now();
  await initializeSettingsPresets();
  const presetsFinished = globalThis.performance?.now?.() ?? Date.now();
  await migrateWorldConsciousnessData();
  await syncLoadedActorNaturalRaceItems();
  await syncLoadedActorNeedThresholdEffects();
  refreshSkillCheckControlButton();
  refreshTokenActionHudControlButton();
  syncTokenActionHud();
  syncTravelGroupHud();
  initializeCombatCarousel();
  await recoverFoundrySystemEventEffects();
  await syncActiveSceneActorAbilityEffects();
  await syncPeriodicDamageRegionEffects();
  await armFoundryVisionTracking();
  await startConsciousnessStatusSynchronization();
  initializeCraftRecipeWorldIndex();
  await removeObsoleteWorldSettings();
  // Ignore setting mutations produced by startup maintenance. From this point
  // onward, a managed setting change is a real runtime/user change and may use
  // the normal debounced preset autosave path.
  await finalizeSettingsPresetStartup();
  const startupFinished = globalThis.performance?.now?.() ?? Date.now();
  const profile = Object.freeze({
    settingsPresetsMs: Math.round(presetsFinished - presetsStarted),
    readyStateMs: Math.round(startupFinished - startupStarted)
  });
  if (globalThis.CONFIG?.FalloutMaW) CONFIG.FalloutMaW.startupProfile = profile;
  console.info(`${FALLOUT_MAW.title} | Startup profile`, profile);
}

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

  const droppedItem = await Item.implementation.fromDropData(data).catch(() => null);
  if (!(droppedItem instanceof Item)) return false;

  const itemData = droppedItem.toObject();
  if (getItemMaxStack(itemData) > 1) {
    const quantity = await promptActorDropItemQuantity(itemData);
    if (!quantity) return false;
    foundry.utils.setProperty(itemData, "system.quantity", quantity);
  }

  const sourceActor = droppedItem.parent?.documentName === "Actor"
    ? droppedItem.parent
    : null;
  if (sourceActor && sourceActor.uuid !== actor.uuid) {
    await transferItemBetweenActors({
      sourceActor,
      targetActor: actor,
      sourceItem: droppedItem,
      targetMode: "inventory",
      targetParentId: ROOT_CONTAINER_ID,
      quantity: getItemQuantity(itemData),
      sourceStackIndex: Math.max(0, toInteger(data.stackIndex)),
      allowLocked: true
    });
    return false;
  }

  const dropPlan = planActorDropItem(actor, itemData);
  if (!dropPlan) {
    ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));
    return false;
  }

  await executeInventoryMutation({
    actor,
    updates: dropPlan.updates,
    creates: dropPlan.creates
  }, { reason: "canvas-drop" });
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
  const { item: created, cancelled } = await grantAbilityItemData(actor, itemData);
  if (cancelled) {
    ui.notifications.warn("Выбор изменений способности не завершён. Способность не добавлена.");
    return false;
  }
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
    const transferQuantity = remainingQuantity;
    const overflowQuantity = getItemStackAdditionOverflowQuantity(target, transferQuantity);
    const parts = createAnchoredItemStackPartsForQuantity({
      itemData,
      quantity: overflowQuantity,
      contextItems: context.items,
      columns: context.dimensions.columns,
      rows: context.dimensions.rows,
      allItems: actor.items.contents,
      reservedPlacements: reservedPlacements.get(parentId) ?? [],
      options: context.options
    });
    if (!parts) continue;
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
      options: context.options
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

