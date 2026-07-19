import { FALLOUT_MAW } from "../config/system-config.mjs";
import { BLEEDING_DAMAGE_TYPE_KEY, TEMPLATES } from "../constants.mjs";
import { TRAVEL_GROUP_FLAG } from "../global-map/constants.mjs";
import { moveTravelCarrierPassenger } from "../global-map/travel-groups.mjs";
import { getTravelGroupUnits, resolveTravelGroupUnitActor } from "../global-map/travel-group-data.mjs";
import { AdvancementApplication } from "../advancement/application.mjs";
import {
  getCharacteristicSettings,
  getActorNeedSettings,
  getCreatureOptions,
  getCurrencySettings,
  getDamageTypeSettings,
  getDiseaseSettings,
  getLevelSettings,
  getNeedSettings,
  getProficiencyInfluenceSettings,
  getProficiencySettings,
  getResourceSettings,
  getSkillAdvancementSettings,
  getSkillSettings,
  getToolSettings
} from "../settings/accessors.mjs";
import { getLevelThreshold } from "../settings/levels.mjs";
import { createDefaultInventorySize } from "../settings/creature-options.mjs";
import {
  canUseWeaponSlotForItem,
  doesItemOccupyEquipmentSlot,
  getEquipmentSlotSelectionKey,
  getRaceEquipmentSlotsForItem,
  getRequiredEquipmentSlotsForItem,
  getRequiredWeaponSlotsForItem,
  getValidSelectedEquipmentSlotKeys,
  getValidSelectedEquipmentSlotKeysForOptions,
  getValidSelectedWeaponSlotKeys,
  getValidSelectedWeaponSlotKeysForOptions,
  getWeaponSlotRequirement,
  getWeaponSlotRequirementSize,
  isContainerWeaponSetKey
} from "../utils/equipment-slots.mjs";
import { buildDamageMitigationTables, buildDamageTypeIconClass, buildDamageTypeIconStyle } from "../utils/damage-mitigation-display.mjs";
import {
  ALL_LIMB_MAX_BONUS_EFFECT_KEY,
  ALL_LIMB_IMPLANT_LIMIT_EFFECT_KEY,
  ALL_SKILLS_ADVANTAGE_EFFECT_KEY,
  ALL_SKILLS_BONUS_EFFECT_KEY,
  ALL_SKILLS_DISADVANTAGE_EFFECT_KEY,
  ALL_COMBAT_ADVANTAGE_EFFECT_KEY,
  ALL_COMBAT_DISADVANTAGE_EFFECT_KEY,
  ABILITY_OVERLOAD_ENERGY_COST_EFFECT_KEY,
  evaluateActorEffectChangeNumber,
  expandActorEffectChangeKeys,
  getAbilityOverloadCostEffectKey,
  getResourceKeyFromOverloadEffectKey,
  getActorSuppressedTraumaDiseaseIds,
  isActorTraumaDiseaseEffectSuppressed,
  ONE_TIME_SKILL_MODIFIER_EFFECT_KEY,
  SMART_FUDGE_RESULT_EFFECT_KEYS
} from "../utils/active-effect-changes.mjs";
import { buildCombatEffectKeyTokens, buildReverseInteractionEffectKeyTokens } from "../utils/effect-key-tokens.mjs";
import { buildEffectTooltipHTML } from "../canvas/token.mjs";
import { DELAYED_THROWN_ITEM_FLAG } from "../canvas/thrown-items.mjs";
  import {
    completeResearch,
    deleteResearchWithConfirm,
    openCreateResearchDialog,
    openManageResearchDialog,
    openResearchTimeDialog,
  prepareResearchesForDisplay
} from "../research/index.mjs";
import { prepareOrganismDevelopmentForDisplay, ORGANISM_DEVELOPMENT_LIMIT_EFFECT_KEY } from "../races/organism-development.mjs";
import { requestSkillCheck } from "../rolls/skill-check.mjs";
import {
  applyDestroyedLimbConsequences,
  clearLimbLossState,
  getActorHealingModifierPercent,
  getActorTraumas,
  getDestroyedLimbStateLabel,
  getLimbHealingCap,
  isLimbDestroyed
} from "../combat/damage-hub.mjs";
import { canSpendWeaponSwitchActionPoints, spendWeaponSwitchActionPoints, WEAPON_SWITCH_COST_KEY } from "../combat/weapon-switching.mjs";
import { openLimbDamageDialog } from "../apps/limb-damage-dialog.mjs";
import {
  getActorRootInventoryGridOptions,
  prepareIndicatorEntry as prepareDisplayIndicatorEntry,
  prepareInventoryContext as prepareDisplayInventoryContext
} from "../utils/actor-display-data.mjs";
import { createLimbSilhouetteHud } from "../utils/limb-silhouette.mjs";
import { LimbSilhouetteConfig } from "../apps/limb-silhouette-config.mjs";
import {
  getActorContainerFlag,
  hasActorContainer,
  moveActorContainerPassenger,
  prepareActorContainerGridContext,
  prepareActorContainerInventoryContext,
  resolveActorContainerPassengerActor
} from "../utils/actor-containers.mjs";
import {
  evaluateActorFormula,
  formatActorFormulaForDisplay,
  isFormulaTextConfigured
} from "../utils/actor-formulas.mjs";
import { scaleFirstAidSignedValue } from "../utils/first-aid-scaling.mjs";
import { openPersonalGenerator } from "../apps/personal-generator.mjs";
import { openHackingSettings } from "../apps/hacking-dialog.mjs";
import { openButcheringConfig } from "../apps/butchering-config.mjs";
import { openConstructStructure } from "../apps/construct-structure.mjs";
import { ActorTradeSettingsConfig } from "../apps/actor-trade-settings-config.mjs";
import { openActorFactionConfig } from "../apps/faction-settings-config.mjs";
import {
  DAMAGE_MITIGATION_MODES,
  ITEM_FUNCTIONS,
  getActiveItemChargesData,
  getActorInstalledModuleItems,
  getConditionFunction,
  getConstructPartFunction,
  getConditionWeakeningData,
  getDamageMitigationFunction,
  getDamageSourceFunction,
  getEnergyConsumerFunction,
  getEnergySourceFunction,
  getFirstAidChargesData,
  getFirstAidFunction,
  getLightSourceFunction,
  getNeedChangeFunction,
  getOneTimeUseFunction,
  getEnabledWeaponFunctions,
  getWeaponAttackPowerState,
  getWeaponFunctionModuleSlots,
  getModuleFunction,
  getProsthesisFunction,
  getToolFunction,
  hasItemFunction
} from "../utils/item-functions.mjs";
import {
  ROOT_CONTAINER_ID,
  INFINITE_ROOT_INVENTORY_EMPTY_ROWS,
  LOCKED_STORAGE_PARENT_ID,
  LOCKED_STORAGE_PLACEMENT_MODE,
  buildInventoryCellStyle as buildInventoryCellStyleHelper,
  createAnchoredItemStackPartsForQuantity,
  createItemStackPartAdditionUpdate,
  createItemStackPartMergeUpdate,
  createItemStackPartPlacementUpdate,
  createItemStackPartRemovalUpdate,
  createItemStackPartSplitUpdate,
  createStoredPlacement,
  createInventoryPlacement as createInventoryPlacementHelper,
  createInventoryTreePlacementRepairUpdates,
  createInventoryHoverPlacementChecker,
  findFirstAvailableInventoryPlacement as findFirstAvailableInventoryPlacementHelper,
  getContainerContentsWeight,
  getContainerInventoryGridOptions,
  getContainerMaxLoad,
  getContextInventoryItems,
  getItemActorLoadWeight,
  getItemContainerParentId,
  getItemFootprint as getItemFootprintHelper,
  getItemMaxStack as getItemMaxStackHelper,
  getItemQuantity as getItemQuantityHelper,
  getItemStackAdditionOverflowQuantity,
  getItemStackPartQuantity,
  getItemTotalWeight,
  hasContainerCycle,
  isContainerItem,
  isItemInButcheringStorage,
  isInventoryPlacementAvailable as isInventoryPlacementAvailableHelper,
  normalizeInventoryPlacement as normalizeInventoryPlacementHelper,
  placementContainsInventoryCell as placementContainsInventoryCellHelper,
  prepareInventoryGridContext,
  resetInventoryHoverCheckerCache,
  usesVirtualInventoryStacks,
  validateInventoryTree
} from "../utils/inventory-containers.mjs";
import {
  applyInventoryDragRotation,
  canShowInventoryRotateAction,
  createInventoryRotationUpdate,
  getInventoryRotationUnavailableLabel,
  resolveInventoryItemRotation
} from "../utils/inventory-rotation.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { grantActorInventoryItem } from "../utils/inventory-grants.mjs";
import { activateInventoryTooltipTab } from "../utils/inventory-tooltip-tabs.mjs";
import { formatDurationShort } from "../utils/duration-parts.mjs";
import { resolveWorldItemSync } from "../utils/world-items.mjs";
import {
  preserveTextSelectionBeforePartSync,
  restoreTextSelectionAfterPartSync
} from "../utils/application-focus-state.mjs";
import { getOverlayBaseZIndex, reserveOverlayZIndex } from "../utils/overlay-layer.mjs";
import { getNaturalWeaponSetContext, isNaturalRaceItem, isNaturalRaceWeapon } from "../races/natural-items.mjs";
import { getAbilityItemUseProgressEntries } from "../abilities/runtime-state.mjs";
import { getEventReactionProgressEntries } from "../events/event-reaction-progress.mjs";
import {
  getContextualAbilityChangeValue,
  getPreparedSourceContextualAbilityChanges
} from "../abilities/evaluation.mjs";
import { getWeaponSkillDamageBonuses } from "../combat/weapon-skill-damage.mjs";
import {
  buildParallelPercentAttribution,
  createItemValueAttributionStep
} from "../utils/item-value-attribution.mjs";
import { decomposePreparedSkillValue } from "../utils/skill-value-attribution.mjs";
import { buildAbilityTooltipCostGroups } from "../utils/ability-tooltip-costs.mjs";
import { actorHasAbility, grantCatalogAbility } from "../abilities/purchase.mjs";
import { getFixedAbilityEnergyCost, getFixedAbilityFunctionProgressEntries, getFixedWeaponPreviewModifiers } from "../abilities/fixed-functions.mjs";
import {
  getAbilityOverloadResourceCostSources,
  isAbilityOverloadReactionCostId,
  withAbilityOverloadCostRows
} from "../abilities/overload.mjs";
import { isAbilityResourceCostActive } from "../abilities/resource-cost-policy.mjs";
import {
  ABILITY_ACTIVE_APPLICATION_COST_PAYERS,
  ABILITY_ACTIVE_APPLICATION_TARGET_MODES,
  ABILITY_CATALOG_DRAG_TYPE,
  ABILITY_FIXED_FUNCTION_KEYS,
  ABILITY_FUNCTION_TYPES,
  getAbilitySourceId,
  normalizeActiveApplicationSettings,
  normalizeAbilityFunctions,
  normalizeAllOrNothingSettings,
  normalizeAimingSettings,
  normalizeCounterAttackSettings,
  normalizeCounterSniperSettings,
  normalizeCurseAndBlessingSettings,
  normalizeDisarmSettings,
  normalizeDoubleAttackSettings,
  normalizeFullForceSettings,
  normalizeHeightenedConcentrationSettings,
  normalizeLastChanceSettings,
  normalizeLethalAttackSettings,
  normalizeKeepAwaySettings,
  normalizeRicochetSettings,
  normalizeLuckyCoinSettings,
  normalizeRageSettings,
  normalizeWhereAreYouGoingSettings
} from "../settings/abilities.mjs";
import { findOneTimeUseStudiedEffect, isOneTimeUseRepeatBlocked } from "../items/one-time-use.mjs";
import {
  actorKnowsCraftItem,
  hasCraftKnowledgeData,
  resolveCraftKnowledgeItem
} from "../items/recipe-knowledge.mjs";
import { canUseActiveItem, useActiveItem } from "../items/active-item-use.mjs";
import { openItemInteractionDialog } from "../items/item-interaction-dialogs.mjs";
import { dropActorInventoryItem } from "../items/dropped-items.mjs";
import {
  createConstructPartSlotFromItem,
  ensureConstructPartSlots,
  getConstructPartLimbKey,
  getConstructPartSlot,
  getConstructPartSlotId,
  getConstructPartSlots,
  getInstalledConstructPartForLimb,
  getInstalledConstructPartForSlot,
  isConstructPartCompatibleWithSlot,
  isInstalledConstructPartItem
} from "../utils/construct-parts.mjs";
import {
  getItemInteractionState,
  resolveActorInteractionToken
} from "../items/item-interactions.mjs";
import {
  applyWeaponModuleModifiers,
  WEAPON_MODULE_ACTION_KEYS,
  getWeaponModuleDisplayName,
  getWeaponModuleSlots,
  getWeaponModuleSlotItemData,
  getWeaponModuleTechnicalName,
  isModuleItemCompatibleWithSlot
} from "../utils/weapon-modules.mjs";
import { getWeaponActionPointCostAttribution } from "../utils/weapon-tooltip-attribution.mjs";
import { FalloutMaWContainerSheet } from "./container-sheet.mjs";
import {
  clearInventoryPlacementPreviews,
  clearInventoryVirtualCells,
  getInventoryGridPointerPosition as getInventoryGridPointerPositionFromElement,
  renderInventoryPlacementPreview,
  syncInventoryVirtualCell
} from "../utils/inventory-grid-dom.mjs";
import { resolveInventoryPointerPlacement } from "../utils/inventory-grid-hover.mjs";

const { ActorSheetV2 } = foundry.applications.sheets;
const { DialogV2, HandlebarsApplicationMixin } = foundry.applications.api;
const { FormDataExtended } = foundry.applications.ux;
const TextEditor = foundry.applications.ux.TextEditor.implementation;
const ACTOR_SHEET_REFERENCE_WIDTH = 2560;
const ACTOR_SHEET_REFERENCE_HEIGHT = 1440;
const ACTOR_SHEET_FALLBACK_VIEWPORT_WIDTH = 1280;
const ACTOR_SHEET_FALLBACK_VIEWPORT_HEIGHT = 720;
const ACTOR_SHEET_WORLD_SIDEBAR_PEEK_WIDTH = 420;
const SELECTED_HUD_WEAPON_FLAG = "selectedHudWeaponItemId";
const SELECTED_HUD_WEAPON_SET_FLAG = "selectedHudWeaponSetKey";
let recipeKnowledgeTooltipListenersActive = false;
let recipeKnowledgeTooltipTimer = null;
let recipeKnowledgeTooltipAnchor = null;
let recipeKnowledgeTooltipPendingAnchor = null;
let recipeKnowledgeTooltipElement = null;
let recipeKnowledgeTooltipCloseTimer = null;
const recipeKnowledgeMiddleActiveAnchors = new WeakSet();

export class FalloutMaWActorSheet extends HandlebarsApplicationMixin(ActorSheetV2) {
  #freeEdit = false;
  #actorNameDraft = null;
  #activeLimbKey = "";
  #draggedItemData = null;
  #draggedItemId = "";
  #dragPreviewSourceKey = "";
  #hoverPreviewInputKey = "";
  #hoverPreviewKey = "";
  #dragDrop = null;
  #tooltipTimer = null;
  #tooltipCloseTimer = null;
  #tooltipElement = null;
  #tooltipAnchorElement = null;
  #tooltipPointer = { x: 0, y: 0 };
  #tooltipPinned = false;
  #tooltipItemId = "";
  #tooltipWeaponTabIndex = 0;
  #tooltipDocumentPointerDownHandler = null;
  #tooltipDocumentKeyHandler = null;
  #tooltipBaseMode = false;
  #tooltipCompareMode = false;
  #inventoryContextMenuOpen = false;
  #uiScale = 1;
  #viewportResizeHandler = null;
  #tabScrollPositions = new Map();
  #worldSidebarPeek = false;

  static DEFAULT_OPTIONS = {
    classes: ["fallout-maw", "fallout-maw-sheet", "fallout-maw-actor-sheet", "sheet", "actor"],
    position: {
      width: ACTOR_SHEET_REFERENCE_WIDTH,
      height: ACTOR_SHEET_REFERENCE_HEIGHT
    },
    form: {
      submitOnChange: true
    },
    window: {
      resizable: false
    },
    actions: {
        openPersonalGenerator: this.#onOpenPersonalGenerator,
        openHackingSettings: this.#onOpenHackingSettings,
        openButcheringConfig: this.#onOpenButcheringConfig,
        openConstructStructure: this.#onOpenConstructStructure,
        openTradeSettings: this.#onOpenTradeSettings,
        openFactionConfig: this.#onOpenFactionConfig,
        openActorLimbSilhouette: this.#onOpenActorLimbSilhouette,
        openDevelopment: this.#onOpenDevelopment,
        toggleFreeEdit: this.#onToggleFreeEdit,
        clearInventory: this.#onClearInventory,
        editActorImage: this.#onEditActorImage,
        selectLimb: this.#onSelectLimb,
        openLimbControl: this.#onOpenLimbControl,
        deleteTrauma: this.#onDeleteTrauma,
        deleteDisease: this.#onDeleteDisease,
        deleteAbility: this.#onDeleteAbility,
        createResearch: this.#onCreateResearch,
        deleteResearch: this.#onDeleteResearch,
        manageResearch: this.#onManageResearch,
        openResearchTime: this.#onOpenResearchTime,
        createEffect: this.#onCreateEffect,
      editEffect: this.#onEditEffect,
      toggleEffect: this.#onToggleEffect,
      deleteEffect: this.#onDeleteEffect,
      selectHudWeaponSet: this.#onSelectHudWeaponSet,
      rollSkill: this.#onRollSkill
    }
  };

  static PARTS = {
    tabs: {
      template: TEMPLATES.actorSheet.tabs
    },
    inventory: {
      template: TEMPLATES.actorSheet.inventory
    },
    indicators: {
      template: TEMPLATES.actorSheet.indicators
    },
    identity: {
      template: TEMPLATES.actorSheet.identity
    },
    research: {
      template: TEMPLATES.actorSheet.research
    },
    effects: {
      template: TEMPLATES.actorSheet.effects
    }
  };

  _preSyncPartState(partId, newElement, priorElement, state) {
    super._preSyncPartState(partId, newElement, priorElement, state);
    preserveTextSelectionBeforePartSync(priorElement, state);
  }

  _syncPartState(partId, newElement, priorElement, state) {
    super._syncPartState(partId, newElement, priorElement, state);
    restoreTextSelectionAfterPartSync(newElement, state);
  }

  static TABS = {
    primary: {
      tabs: [
        { id: "inventory", group: "primary", label: "FALLOUTMAW.Tabs.InventoryEquipment" },
        { id: "indicators", group: "primary", label: "FALLOUTMAW.Tabs.Indicators" },
        { id: "identity", group: "primary", label: "FALLOUTMAW.Tabs.IdentityData" },
        { id: "research", group: "primary", label: "FALLOUTMAW.Tabs.Research" },
        { id: "effects", group: "primary", label: "FALLOUTMAW.Tabs.Effects" }
      ],
      initial: "inventory"
    }
  };

  get actor() {
    return this.document;
  }

  setPosition(position = {}) {
    const fullscreenPosition = this.#getFullscreenSheetPosition(position);
    const result = super.setPosition(fullscreenPosition);
    this.#applyUiScale(fullscreenPosition.scale);
    this.#syncOverlayScale();
    return result;
  }

  _getHeaderControls() {
    const controls = super._getHeaderControls();
    if (isTravelGroupCarrierActor(this.actor)) return controls;
    if (game.user?.isGM) {
      controls.unshift({
        action: "openHackingSettings",
        icon: "fa-solid fa-lock",
        label: "Настройки взлома",
        ownership: "OWNER"
      });
      controls.unshift({
        action: "openButcheringConfig",
        icon: "fa-solid fa-drumstick-bite",
        label: "Разделка",
        ownership: "OWNER"
      });
    }
    controls.unshift({
      action: "openTradeSettings",
      icon: "fa-solid fa-cash-register",
      label: "Торговля",
      ownership: "OWNER"
    });
    controls.unshift({
      action: "openFactionConfig",
      icon: "fa-solid fa-flag",
      label: game.i18n.localize("FALLOUTMAW.Factions.ActorButton"),
      ownership: "OWNER"
    });
    controls.unshift({
      action: "openActorLimbSilhouette",
      icon: "fa-solid fa-person",
      label: "Индивидуальный силуэт",
      ownership: "OWNER"
    });
    controls.unshift(this.actor.type === "construct"
      ? {
        action: "openConstructStructure",
        icon: "fa-solid fa-sitemap",
        label: "Строение конструкта",
        ownership: "OWNER"
      }
      : {
        action: "openPersonalGenerator",
        icon: "fa-solid fa-user-gear",
        label: game.i18n.localize("FALLOUTMAW.Actor.PersonalGenerator"),
        ownership: "OWNER"
      });
    return controls;
  }

  get _dragDrop() {
    return this.#dragDrop ??= new foundry.applications.ux.DragDrop.implementation({
      dragSelector: ".draggable",
      permissions: {
        dragstart: this._canDragStart.bind(this),
        drop: this._canDragDrop.bind(this)
      },
      callbacks: {
        dragstart: this._onDragStart.bind(this),
        dragover: this._onDragOver.bind(this),
        drop: this._onDrop.bind(this),
        dragend: this._onDragEnd.bind(this)
      }
    });
  }

  async _prepareContext(options) {
    if (isTravelGroupCarrierActor(this.actor)) this.tabGroups.primary = "inventory";
    const context = await super._prepareContext(options);
    const actor = this.actor;
    const isConstruct = actor.type === "construct";
    const creatureOptions = getCreatureOptions();
    const characteristicSettings = getCharacteristicSettings();
    const currencySettings = getCurrencySettings();
    const damageTypeSettings = getDamageTypeSettings();
    const diseaseSettings = getDiseaseSettings();
    const resourceSettings = getResourceSettings();
    const proficiencySettings = getProficiencySettings();
    const skillSettings = getSkillSettings();
    const skillAdvancementSettings = getSkillAdvancementSettings(characteristicSettings, skillSettings);
    const levelSettings = getLevelSettings();
    const typeId = actor.system?.creature?.typeId;
    const raceId = actor.system?.creature?.raceId;
    const subtypeId = actor.system?.creature?.subtypeId;
    const race = creatureOptions.races.find(entry => entry.id === raceId);
    const subtype = (race?.naturalItemSets ?? []).find(entry => entry.id === subtypeId) ?? null;
    const needSettings = getActorNeedSettings(actor);
    const sourceSystem = actor.system?._source ?? actor.system;
    const limbEntries = Object.entries(actor.system?.limbs ?? {});
    const activeLimbKey = limbEntries.some(([key]) => key === this.#activeLimbKey)
      ? this.#activeLimbKey
      : (limbEntries[0]?.[0] ?? "");
    const displayLimbs = Object.fromEntries(limbEntries.map(([key, limb]) => [
      key,
      prepareLimbDisplayData(actor, key, limb)
    ]));
    const limbs = limbEntries.map(([key, limb]) => prepareDisplayIndicatorEntry({
      key,
      label: String(limb?.label ?? key),
      color: "#8f8456",
      data: displayLimbs[key],
      inputName: `system.limbs.${key}.value`,
      active: key === activeLimbKey
    }));
    const limbSilhouette = prepareSheetLimbSilhouette(getActorConfiguredLimbSilhouette(actor, race), displayLimbs, activeLimbKey);

    this.#activeLimbKey = activeLimbKey;

    const inventory = prepareDisplayInventoryContext(actor, race);
    markActiveHudWeaponSet(actor, inventory);
    const level = Math.max(1, toInteger(actor.system?.attributes?.level));
    const currentExperience = Math.max(0, toInteger(actor.system?.development?.experience));
    const maxLevel = levelSettings[levelSettings.length - 1]?.level ?? 100;
    const canManageSheetDocuments = Boolean(game.user?.isGM);
    const loadValue = Math.max(0, Number(actor.system.load?.value) || 0);
    const loadMax = Math.max(0, Number(actor.system.load?.max) || 0);
    const infiniteLoad = Boolean(actor.system?.trade?.infiniteInventory);
    const loadRatio = !infiniteLoad && loadMax > 0 ? (loadValue / loadMax) : 0;
    const loadPercent = Math.max(0, Math.min(100, loadRatio * 100));
    const currentThreshold = level <= 1
      ? 0
      : getLevelThreshold(levelSettings, Math.max(0, level - 1));
    const nextThreshold = getLevelThreshold(levelSettings, Math.max(1, level));
    const progressionRange = Math.max(1, nextThreshold - currentThreshold);
    const progressionPercent = level >= maxLevel
      ? 100
      : Math.max(0, Math.min(100, ((currentExperience - currentThreshold) / progressionRange) * 100));

    const _mergedContext = foundry.utils.mergeObject(context, {
      actor,
      system: actor.system,
      sourceSystem,
      config: FALLOUT_MAW,
      owner: actor.isOwner,
      isConstruct,
      editable: this.isEditable,
      freeEdit: this.#freeEdit,
      editLockAttribute: this.#freeEdit ? "" : "disabled",
      canManageResearchControls: canManageSheetDocuments,
      canManageEffectControls: canManageSheetDocuments,
      actorName: this.#actorNameDraft ?? actor.name,
      load: {
        value: formatWeight(loadValue),
        max: infiniteLoad ? "∞" : formatWeight(loadMax),
        percent: Number(loadPercent.toFixed(2)),
        trend: "negative",
        state: loadRatio >= 1 ? "critical" : loadRatio >= 0.75 ? "warning" : "normal"
      },
      currencies: currencySettings.map(currency => ({
        ...currency,
        amount: toInteger(sourceSystem.currencies?.[currency.key] ?? actor.system.currencies?.[currency.key]),
        hasImage: Boolean(currency.img)
      })),
      creatureTypeName: creatureOptions.types.find(type => type.id === typeId)?.name || "",
      creatureRaceName: race?.name || "",
      creatureSubtypeName: subtype?.label || game.i18n.localize("FALLOUTMAW.Actor.NoSubtype"),
      creatureTypes: creatureOptions.types.map(type => ({ ...type, selected: type.id === typeId })),
      creatureRaces: creatureOptions.races.map(race => ({ ...race, selected: race.id === raceId })),
      creatureSubtypes: buildCreatureSubtypeOptions(creatureOptions.races, raceId, subtypeId),
      progressionExperienceDisplay: `${currentExperience} / ${nextThreshold}`,
      progressionExperienceNext: nextThreshold,
      progressionExperiencePercent: Number(progressionPercent.toFixed(2)),
      characteristics: characteristicSettings.map(characteristic => ({
        ...characteristic,
        value: toInteger(actor.system?.characteristics?.[characteristic.key]),
        sourceValue: toInteger(sourceSystem.characteristics?.[characteristic.key] ?? actor.system?.characteristics?.[characteristic.key])
      })),
      resources: resourceSettings.map(resource => prepareDisplayIndicatorEntry({
        ...resource,
        data: actor.system.resources?.[resource.key],
        inputName: `system.resources.${resource.key}.value`
      })),
      needs: needSettings.map(need => prepareDisplayIndicatorEntry({
        ...need,
        data: actor.system.needs?.[need.key],
        inputName: `system.needs.${need.key}.value`
      })),
      limbs,
      activeLimb: limbs.find(limb => limb.active) ?? null,
      skills: skillSettings.map(skill => {
        const current = actor.system.skills?.[skill.key] ?? {};
        const source = sourceSystem.skills?.[skill.key] ?? {};
        return prepareDisplayIndicatorEntry({
          ...skill,
          color: "#7fa85a",
          data: {
            min: current.min,
            value: current.value,
            max: current.max ?? skillAdvancementSettings.developmentLimit
          },
          base: toInteger(current.base),
          bonus: toInteger(source.bonus),
          developmentBonus: toInteger(current.developmentBonus)
        });
      }),
      abilities: prepareAbilityEntries(actor, {
        characteristicSettings,
        skillSettings
      }),
      proficiencies: proficiencySettings.map(proficiency => {
        const current = actor.system.proficiencies?.[proficiency.key] ?? {};
        return prepareDisplayIndicatorEntry({
          ...proficiency,
          color: "#b08a4a",
          data: current,
          inputName: `system.proficiencies.${proficiency.key}.value`,
          bonus: toInteger(current.bonus),
          settingMax: toInteger(proficiency.max)
        });
      }),
      developmentPointEntries: prepareDevelopmentPointEntries(actor.system?.development, actor.system?.proficiencies),
      researches: prepareResearchesForDisplay(actor.system?.researches, skillSettings, actor.system?.skills),
      organismDevelopment: prepareOrganismDevelopmentForDisplay(actor),
      damageResistances: damageTypeSettings.map(damageType => ({
        ...damageType,
        value: toInteger(actor.system.damageResistances?.[activeLimbKey]?.[damageType.key])
      })),
      damageDefenses: damageTypeSettings.map(damageType => ({
        ...damageType,
        value: toInteger(actor.system.damageDefenses?.[activeLimbKey]?.[damageType.key])
      })),
      limbSilhouette,
      traumas: prepareTraumaEntries(actor, {
        characteristicSettings,
        resourceSettings,
        needSettings,
        proficiencySettings,
        skillSettings,
        damageTypeSettings,
        limbs
      }),
      diseases: prepareDiseaseEntries(actor, diseaseSettings, {
        characteristicSettings,
        resourceSettings,
        needSettings,
        proficiencySettings,
        skillSettings,
        damageTypeSettings,
        limbs
      }),
      travelGroup: await prepareTravelGroupSheetContext(actor),
      inventory,
      effectCategories: prepareEffectCategories(getActorEffectsForDisplay(actor), actor)
    }, { inplace: false });
    return _mergedContext;
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.element?.classList.toggle("fallout-maw-travel-carrier-sheet", isTravelGroupCarrierActor(this.actor));
    this.#hoverPreviewKey = "";
    this.setPosition();
    this.#bindViewportResize();
    this.#relocateEffectsAddButton();
    this.#activateCreatureSelectors();
    this.#activateActorNameInput();
    this.#activateInventoryInteractions();
    this.#activateWeaponSlotAspectSizing();
    this.#activateLimbControlClicks();
    this.#activateDevelopmentPointInputs();
    this.#activateTabScrollPersistence();
    this.#restoreActiveTabScroll();
    this.#syncFreeEditHeaderButton();
    this.#syncWorldSidebarPeekToggle();
    this.#syncInventoryTooltipAfterRender();
  }

  _onClose(options) {
    super._onClose(options);
    this.#unbindViewportResize();
    this.#closeInventoryContextMenu();
    this.#clearInventoryTooltip({ force: true });
  }

  async _onDrop(event) {
    const data = this.#getDragEventData(event);
    if (data?.type === "ActorContainerPassenger") return this.#onDropActorContainerPassenger(event, data);
    if (data?.type === ABILITY_CATALOG_DRAG_TYPE) return this.#onDropCatalogAbility(data);
    if (data?.type !== "Item") return super._onDrop(event);

    const passengerElement = event.target?.closest?.("[data-actor-container-passenger]");
    if (passengerElement) {
      const used = await this.#onDropItemOnActorContainerPassenger(data, passengerElement);
      if (used !== null) return used;
    }

    this.#clearDragPreviewCache();
    this.#clearInventoryDropPreview();
    const dropped = await this.#getDroppedItemFromData(data);
    if (!dropped) return null;
    if (dropped.itemData?.type === "ability") return this.#onDropAbilityItem(dropped);

    const zone = this.#getDropZone(event);
    const parentId = this.#getInventoryContextParentId(zone);
    const sourceOwned = dropped.item?.parent === this.actor;
    let itemData = dropped.itemData;
    const sourceStackIndex = Math.max(0, toInteger(data.stackIndex));
    const sourceStackQuantity = Math.max(0, toInteger(data.stackQuantity));
    if (sourceOwned && usesVirtualInventoryStacks(dropped.item)) {
      foundry.utils.setProperty(itemData, "system.quantity", sourceStackQuantity || getItemStackPartQuantity(dropped.item, sourceStackIndex));
      dropped.itemData = itemData;
    }
    const targetElement = getInventoryGridItemElementAtPointer(event, this.element)
      ?? zone?.closest?.("[data-inventory-grid-item][data-item-id]");
    const targetStackIndex = Math.max(0, toInteger(targetElement?.dataset?.stackIndex));
    const pointedTargetItem = (
      targetElement
      && String(targetElement.dataset.inventoryParentId ?? ROOT_CONTAINER_ID) === String(parentId ?? ROOT_CONTAINER_ID)
    )
      ? this.actor.items.get(String(targetElement.dataset.itemId ?? "")) ?? null
      : null;
    if (
      sourceOwned
      && usesVirtualInventoryStacks(dropped.item)
      && targetElement?.dataset?.itemId === dropped.item.id
      && targetStackIndex !== sourceStackIndex
    ) {
      const updateData = createItemStackPartMergeUpdate(dropped.item, sourceStackIndex, targetStackIndex, getItemQuantity(itemData));
      if (!updateData) return null;
      if (!this.#validateProjectedInventoryState({ updates: [updateData] })) return null;
      await this.actor.updateEmbeddedDocuments("Item", [updateData]);
      return this.actor.items.get(dropped.item.id) ?? null;
    }
    const targetItem = (
      pointedTargetItem
      && (!sourceOwned || pointedTargetItem.id !== dropped.item?.id)
    )
      ? pointedTargetItem
      : this.#getTargetStackItem(zone, sourceOwned ? dropped.item?.id ?? "" : "", parentId);
    if (sourceOwned && this.#canStackDroppedItem(itemData, targetItem)) {
      const quantity = await this.#getDroppedStackQuantity(dropped, targetItem, event, { targetStackIndex });
      if (!quantity) return null;
      return this.#stackDroppedItemQuantity(dropped.item, itemData, targetItem, quantity, sourceStackIndex, targetStackIndex);
    }

    const placement = this.#getPlacementForDropZone(zone, itemData, [sourceOwned ? dropped.item?.id ?? "" : ""], parentId, event);
    if (!placement) return null;

    if (placement.mode === ITEM_FUNCTIONS.constructPart) {
      return this.#installConstructPart(dropped, placement, { sourceOwned });
    }

    if (!sourceOwned && placement.mode === "inventory") {
      itemData = await this.#getExternalDroppedInventoryItemData(itemData);
      if (!itemData) return null;
    }

    if (sourceOwned) {
      return this.#moveOwnedItem(dropped.item, placement, targetItem, parentId, sourceStackIndex);
    }

    return this.#createOrStackDroppedItem(itemData, placement, targetItem, parentId);
  }

  async #onDropCatalogAbility(data = {}) {
    const sourceId = String(data.sourceId ?? "").trim();
    if (!sourceId || !this.actor?.isOwner) return null;
    const abilityName = String(data.name ?? "").trim() || "Способность";
    if (actorHasAbility(this.actor, sourceId)) {
      ui.notifications.warn(`${this.actor.name} уже имеет способность: ${abilityName}.`);
      return null;
    }
    const item = await grantCatalogAbility(this.actor, sourceId);
    if (item) {
      ui.notifications.info(`${this.actor.name}: добавлена способность ${item.name}.`);
      return item;
    }
    ui.notifications.warn(`Не удалось добавить способность: ${abilityName}.`);
    return null;
  }

  async #onDropAbilityItem(dropped = {}) {
    if (!this.actor?.isOwner) return null;
    const itemData = foundry.utils.deepClone(dropped.itemData ?? {});
    const sourceId = getAbilitySourceId(dropped.item ?? itemData);
    const abilityName = String(itemData.name ?? dropped.item?.name ?? "").trim() || "Способность";

    if (sourceId) {
      if (actorHasAbility(this.actor, sourceId)) {
        ui.notifications.warn(`${this.actor.name} уже имеет способность: ${abilityName}.`);
        return null;
      }
      const item = await grantCatalogAbility(this.actor, sourceId);
      if (item) {
        ui.notifications.info(`${this.actor.name}: добавлена способность ${item.name}.`);
        return item;
      }
    }

    delete itemData._id;
    delete itemData.id;
    const [created] = await this.actor.createEmbeddedDocuments("Item", [itemData]);
    if (created) ui.notifications.info(`${this.actor.name}: добавлена способность ${created.name}.`);
    return created ?? null;
  }

  _onDragOver(event) {
    const data = this.#getDragEventData(event);
    if (data?.type === ABILITY_CATALOG_DRAG_TYPE) {
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      this.#clearActorContainerDropPreview();
      this.#clearInventoryDropPreview();
      return;
    }
    if (data?.type === "ActorContainerPassenger") {
      const cell = this.#getActorContainerCellAtPointer(event);
      this.#clearActorContainerDropPreview();
      cell?.classList.add("drop-preview");
      if (event.dataTransfer) event.dataTransfer.dropEffect = cell ? "move" : "none";
      return;
    }
    const passengerElement = event.target?.closest?.("[data-actor-container-passenger]");
    const previewItem = data?.type === "Item" ? this.#getPreviewItemData(event) : null;
    if (passengerElement && previewItem && isActorContainerUsableItem(previewItem)) {
      this.#clearActorContainerDropPreview();
      passengerElement.classList.add("drop-preview");
      if (event.dataTransfer) event.dataTransfer.dropEffect = "link";
      return;
    }
    const zone = this.#getDropZone(event);
    if (!zone) return;
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    this.#draggedItemData = this.#getPreviewItemData(event);
    this.#setInventoryHoverPreview(zone, event);
  }

  async _onDragStart(event) {
    const passenger = event.currentTarget?.closest?.("[data-actor-container-passenger]");
    if (passenger) {
      const passengerId = String(passenger.dataset.passengerId ?? "");
      const vehicleActorUuid = String(passenger.dataset.vehicleActorUuid ?? this.actor.uuid ?? "");
      const travelUnitId = String(passenger.dataset.travelUnitId ?? "");
      if (!passengerId || (!vehicleActorUuid && !travelUnitId) || !this.actor?.isOwner) return;
      const dragData = {
        type: "ActorContainerPassenger",
        vehicleActorUuid,
        travelUnitId,
        passengerId
      };
      event.dataTransfer?.setData("application/json", JSON.stringify(dragData));
      event.dataTransfer?.setData("text/plain", JSON.stringify(dragData));
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      passenger.classList.add("dragging");
      return;
    }
    await super._onDragStart(event);
    resetInventoryHoverCheckerCache();
    this.#clearInventoryTooltip({ force: true });
    this.#clearInventoryDropPreview();
    const item = this.actor.items.get(event.currentTarget?.dataset?.itemId ?? "");
    const stackIndex = Math.max(0, toInteger(event.currentTarget?.dataset?.stackIndex));
    const stackQuantity = Math.max(0, toInteger(event.currentTarget?.dataset?.stackQuantity));
    this.#draggedItemId = item?.id ?? "";
    this.#dragPreviewSourceKey = this.#draggedItemId ? `owned:${this.#draggedItemId}` : "";
    this.#draggedItemData = item?.toObject() ?? null;
    if (item && usesVirtualInventoryStacks(item)) {
      foundry.utils.setProperty(this.#draggedItemData, "system.quantity", stackQuantity || getItemStackPartQuantity(item, stackIndex));
    }
    if (item) {
      const dragData = item.toDragData();
      dragData.itemId = item.id;
      dragData.stackIndex = stackIndex;
      dragData.stackQuantity = stackQuantity || (usesVirtualInventoryStacks(item) ? getItemStackPartQuantity(item, stackIndex) : getItemQuantity(item));
      event.dataTransfer?.setData("text/plain", JSON.stringify(dragData));
    }
    event.currentTarget?.classList?.add("dragging");
    this.#highlightEquipmentSlotsForItem(this.#draggedItemData);
  }

  _onDragEnd() {
    this.#clearActorContainerDropPreview();
    this.#clearDragPreviewCache();
    this.#clearInventoryDropPreview();
    this.#clearInventoryDraggingState();
  }

  async #onDropActorContainerPassenger(event, data) {
    this.#clearActorContainerDropPreview();
    const cell = this.#getActorContainerCellAtPointer(event);
    if (!cell) return null;
    const sourceUnitId = String(data.travelUnitId ?? "");
    const targetUnitId = String(cell.dataset.travelUnitId ?? "");
    if (sourceUnitId || targetUnitId) {
      if (!isTravelGroupCarrierActor(this.actor) || !sourceUnitId || sourceUnitId !== targetUnitId) return null;
      return moveTravelCarrierPassenger({
        carrierActorId: this.actor.id,
        unitId: sourceUnitId,
        passengerId: String(data.passengerId ?? ""),
        target: {
          slotId: cell.dataset.slotId,
          slotIndex: Number(cell.dataset.slotIndex),
          x: Number(cell.dataset.x),
          y: Number(cell.dataset.y)
        }
      });
    }
    const sourceVehicleUuid = String(data.vehicleActorUuid ?? "");
    const targetVehicleUuid = String(cell.dataset.vehicleActorUuid ?? this.actor.uuid ?? "");
    if (!sourceVehicleUuid || sourceVehicleUuid !== targetVehicleUuid) return null;
    const vehicleActor = await resolveActorByUuid(sourceVehicleUuid);
    if (!vehicleActor?.isOwner) return null;
    const moved = await moveActorContainerPassenger(vehicleActor, String(data.passengerId ?? ""), {
      slotId: cell.dataset.slotId,
      slotIndex: cell.dataset.slotIndex,
      x: cell.dataset.x,
      y: cell.dataset.y
    });
    if (!moved) ui.notifications.warn("Пассажир не помещается в выбранную область.");
    else this.render({ parts: ["inventory"] });
    return moved;
  }

  async #onDropItemOnActorContainerPassenger(data, passengerElement) {
    const dropped = await this.#getDroppedItemFromData(data);
    if (!dropped?.item || !isActorContainerUsableItem(dropped.item)) return null;
    const vehicleActor = await resolveActorByUuid(String(passengerElement.dataset.vehicleActorUuid ?? this.actor.uuid ?? ""));
    if (!vehicleActor) {
      ui.notifications.warn("Не удалось найти транспорт пассажира.");
      return false;
    }
    const targetActor = await resolveActorContainerPassengerActor(vehicleActor, String(passengerElement.dataset.passengerId ?? ""));
    if (!targetActor) {
      ui.notifications.warn("Не удалось найти актера пассажира.");
      return false;
    }
    if (!targetActor.testUserPermission?.(game.user, "OBSERVER")) {
      ui.notifications.warn("Нет прав наблюдателя на этого пассажира.");
      return false;
    }
    this.#clearDragPreviewCache();
    this.#clearInventoryDropPreview();
    this.#clearActorContainerDropPreview();
    return useActiveItem({
      actor: dropped.item.actor ?? this.actor,
      item: dropped.item,
      application: this,
      targetActor
    });
  }

  #getActorContainerCellAtPointer(event) {
    const target = event?.target;
    const direct = target?.closest?.("[data-actor-container-cell]");
    if (direct && this.element?.contains(direct)) return direct;
    const clientX = Number(event?.clientX);
    const clientY = Number(event?.clientY);
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
    const pointedElement = document.elementFromPoint(clientX, clientY);
    const grid = target?.closest?.(".fallout-maw-actor-container-grid")
      ?? pointedElement?.closest?.(".fallout-maw-actor-container-grid");
    if (!grid || !this.element?.contains(grid)) return null;
    const pointer = getInventoryGridPointerPositionFromElement(event, grid);
    if (!pointer) return null;
    return syncInventoryVirtualCell(grid, pointer, {
      actorContainerCell: "",
      travelUnitId: String(grid.dataset.travelUnitId ?? ""),
      vehicleActorUuid: String(grid.dataset.vehicleActorUuid ?? ""),
      slotId: String(grid.dataset.slotId ?? ""),
      slotIndex: String(grid.dataset.slotIndex ?? "")
    });
  }

  #clearActorContainerDropPreview() {
    this.element?.querySelectorAll("[data-actor-container-cell].drop-preview, [data-actor-container-passenger].drop-preview")
      .forEach(element => element.classList.remove("drop-preview"));
  }

  static #onToggleFreeEdit(event) {
    event.preventDefault();
    this.#actorNameDraft = null;
    this.#freeEdit = !this.#freeEdit;
    return this.render({ force: true });
  }

  static async #onClearInventory(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!this.#freeEdit || !this.actor?.isOwner || !this.isEditable) return undefined;

    const inventoryItemIds = getInventoryBulkDeleteItemIds(this.actor);
    const equippedItemIds = getInventoryBulkDeleteItemIds(this.actor, { equippedOnly: true });
    if (!inventoryItemIds.length && !equippedItemIds.length) {
      ui.notifications?.warn?.(game.i18n.localize("FALLOUTMAW.Messages.InventoryClearEmpty"));
      return undefined;
    }

    const result = await DialogV2.confirm({
      window: {
        icon: "fa-solid fa-trash",
        title: game.i18n.localize("FALLOUTMAW.Actor.ClearInventoryTitle")
      },
      modal: true,
      rejectClose: false,
      content: `
        <p>${game.i18n.format("FALLOUTMAW.Actor.ClearInventoryConfirm", {
          actor: escapeHTML(this.actor.name),
          count: inventoryItemIds.length
        })}</p>
        <div class="checkbox fallout-maw-inventory-clear-equipped-option">
          <span>${game.i18n.format("FALLOUTMAW.Actor.ClearInventoryEquipped", {
            count: equippedItemIds.length
          })}</span>
          <input type="checkbox" name="deleteEquipped" aria-label="${escapeAttribute(game.i18n.format("FALLOUTMAW.Actor.ClearInventoryEquipped", {
            count: equippedItemIds.length
          }))}" ${equippedItemIds.length ? "" : "disabled"}>
        </div>
      `,
      yes: {
        icon: "fa-solid fa-trash",
        label: "FALLOUTMAW.Common.Delete",
        callback: (_event, button) => ({
          confirmed: true,
          deleteEquipped: Boolean(button.form.elements.deleteEquipped?.checked)
        })
      },
      no: {
        label: "FALLOUTMAW.Common.Cancel"
      }
    });
    if (!result?.confirmed) return undefined;

    const itemIds = getInventoryBulkDeleteItemIds(this.actor, {
      includeEquipped: Boolean(result.deleteEquipped)
    });
    if (!itemIds.length) {
      ui.notifications?.warn?.(game.i18n.localize("FALLOUTMAW.Messages.InventoryClearEmpty"));
      return undefined;
    }

    await this.actor.deleteEmbeddedDocuments("Item", itemIds);
    ui.notifications?.info?.(game.i18n.format("FALLOUTMAW.Messages.InventoryCleared", { count: itemIds.length }));
    return this.render({ parts: ["inventory"] });
  }

  static async #onEditActorImage(event, target) {
    event.preventDefault();
    event.stopPropagation();
    if (!this.#freeEdit || !this.actor?.isOwner || !this.isEditable) return undefined;
    if (target.nodeName !== "IMG") return undefined;

    const attr = target.dataset.edit || "img";
    const current = foundry.utils.getProperty(this.actor._source, attr) ?? target.getAttribute("src") ?? "";
    const defaultArtwork = this.actor.constructor.getDefaultArtwork?.(this.actor._source) ?? {};
    const defaultImage = foundry.utils.getProperty(defaultArtwork, attr);
    const picker = new foundry.applications.apps.FilePicker.implementation({
      current,
      type: "image",
      redirectToRoot: defaultImage ? [defaultImage] : [],
      callback: path => {
        const previous = target.getAttribute("src") ?? "";
        target.src = path;
        const updateData = { [attr]: path };
        syncActorTokenIdentity(this.actor, updateData);
        return this.actor.update(updateData).catch(error => {
          target.src = previous;
          console.error(error);
          ui.notifications?.error(error?.message ?? "Не удалось изменить портрет актера.");
        });
      },
      position: {
        top: this.position.top + 40,
        left: this.position.left + 10
      },
      document: this.actor
    });
    return picker.browse();
  }

  static #onOpenDevelopment(event) {
    event.preventDefault();
    return new AdvancementApplication(this.actor).render(true);
  }

  static #onOpenPersonalGenerator(event) {
    event.preventDefault();
    return openPersonalGenerator(this.actor);
  }

  static #onOpenHackingSettings(event) {
    event.preventDefault();
    return openHackingSettings(this.actor);
  }

  static #onOpenButcheringConfig(event) {
    event.preventDefault();
    return openButcheringConfig(this.actor);
  }

  static #onOpenConstructStructure(event) {
    event.preventDefault();
    return openConstructStructure(this.actor);
  }

  static #onOpenTradeSettings(event) {
    event.preventDefault();
    return new ActorTradeSettingsConfig(this.actor).render(true);
  }

  static #onOpenFactionConfig(event) {
    event.preventDefault();
    return openActorFactionConfig(this.actor);
  }

  static #onOpenActorLimbSilhouette(event) {
    event.preventDefault();
    const actor = this.actor;
    const limbEntries = Object.entries(actor.system?.limbs ?? {});
    if (!limbEntries.length) {
      ui.notifications.warn("У актера нет частей тела для настройки силуэта.");
      return undefined;
    }

    const race = getCreatureOptions().races.find(entry => entry.id === actor.system?.creature?.raceId);
    const editorRace = {
      id: actor.id ?? "",
      name: actor.name ?? "",
      limbs: limbEntries.map(([key, limb]) => ({
        key,
        label: String(limb?.label ?? key)
      }))
    };
    const silhouette = foundry.utils.deepClone(getActorConfiguredLimbSilhouette(actor, race));
    return new LimbSilhouetteConfig({
      race: editorRace,
      silhouette,
      title: actor.name,
      onSave: async savedSilhouette => {
        await actor.update({
          "system.limbSilhouetteOverride": true,
          "system.limbSilhouette": savedSilhouette
        });
        ui.notifications.info("Индивидуальный силуэт сохранен.");
      }
    }).render({ force: true });
  }

  static #onSelectLimb(event, target) {
    if (!game.user?.isGM) return undefined;
    event.preventDefault();
    const limbKey = target.dataset.limbKey ?? "";
    if (!limbKey || (limbKey === this.#activeLimbKey)) return undefined;
    this.#activeLimbKey = limbKey;
    return this.render({ parts: ["indicators"] });
  }

  static #onOpenLimbControl(event, target) {
    if (!game.user?.isGM) return undefined;
    event.preventDefault();
    const limbKey = target.closest("[data-limb-key]")?.dataset.limbKey ?? target.dataset.limbKey ?? "";
    if (!limbKey) return undefined;
    return openLimbDamageDialog(this.actor, limbKey);
  }

  static #onDeleteTrauma(event, target) {
    event.preventDefault();
    if (!this.#freeEdit) return undefined;
    const itemId = target.closest("[data-trauma-id]")?.dataset.traumaId ?? "";
    return this.actor.items.get(itemId)?.delete();
  }

  static #onDeleteDisease(event, target) {
    event.preventDefault();
    if (!this.#freeEdit) return undefined;
    const itemId = target.closest("[data-disease-id]")?.dataset.diseaseId ?? "";
    return this.actor.items.get(itemId)?.delete();
  }

  static #onDeleteAbility(event, target) {
    event.preventDefault();
    event.stopPropagation();
    if (!this.#freeEdit) return undefined;
    const itemId = target.closest("[data-ability-id]")?.dataset.abilityId ?? "";
    const item = this.actor.items.get(itemId);
    if (item?.type !== "ability") return undefined;
    return item.delete();
  }

  #activateLimbControlClicks() {
    const root = this.element;
    if (!root || root.dataset.limbControlClicksBound === "true") return;
    root.dataset.limbControlClicksBound = "true";
    root.addEventListener("click", event => this.#onLimbControlClick(event), { capture: true });
    root.addEventListener("keydown", event => this.#onLimbControlKeyDown(event), { capture: true });
  }

  #activateDevelopmentPointInputs() {
    const root = this.element;
    if (!root || root.dataset.developmentPointInputsBound === "true") return;
    root.dataset.developmentPointInputsBound = "true";
    root.addEventListener("change", event => {
      const input = event.target?.closest?.("[data-development-point-input]");
      if (!input) return;
      event.preventDefault();
      event.stopPropagation();
      return this.#onDevelopmentPointInputChange(input);
    }, { capture: true });
  }

  #activateActorNameInput() {
    const root = this.element;
    if (!root || root.dataset.actorNameInputBound === "true") return;
    root.dataset.actorNameInputBound = "true";

    root.addEventListener("input", event => {
      const input = event.target?.closest?.("[data-actor-name-input]");
      if (!input || !this.element?.contains(input)) return;
      if (!this.#freeEdit || !this.isEditable) return;
      this.#actorNameDraft = String(input.value ?? "");
    }, { capture: true });

    root.addEventListener("change", event => {
      const input = event.target?.closest?.("[data-actor-name-input]");
      if (!input || !this.element?.contains(input)) return;
      event.preventDefault();
      event.stopPropagation();
      void this.#commitActorNameInput(input);
    }, { capture: true });

    root.addEventListener("keydown", event => {
      const input = event.target?.closest?.("[data-actor-name-input]");
      if (!input || !this.element?.contains(input)) return;
      if (event.key !== "Enter") return;
      event.preventDefault();
      event.stopPropagation();
      input.blur();
    }, { capture: true });
  }

  async #commitActorNameInput(input) {
    if (!this.#freeEdit || !this.isEditable) {
      this.#actorNameDraft = null;
      input.value = this.actor.name;
      return undefined;
    }

    const name = String(input.value ?? "");
    this.#actorNameDraft = name;
    if (name === this.actor.name) {
      this.#actorNameDraft = null;
      return undefined;
    }

    const updateData = { name };
    syncActorTokenIdentity(this.actor, updateData);
    try {
      await this.actor.update(updateData);
      this.#actorNameDraft = null;
    } catch (error) {
      this.#actorNameDraft = null;
      input.value = this.actor.name;
      console.error(error);
      ui.notifications?.error(error?.message ?? "Не удалось изменить имя актера.");
    }
    return undefined;
  }

  async #onDevelopmentPointInputChange(input) {
    if (!this.#freeEdit) return undefined;
    const key = String(input.dataset.developmentPointInput ?? "");
    if (!key) return undefined;
    return this.actor.update({ [`system.development.points.${key}`]: Math.max(0, toInteger(input.value)) });
  }

  #syncFreeEditHeaderButton() {
    const header = this.element?.querySelector(".window-header");
    if (isTravelGroupCarrierActor(this.actor)) {
      header?.querySelector(".fallout-maw-window-free-edit-toggle")?.remove();
      return;
    }
    if (!header || !this.isEditable) return;

    let button = header.querySelector(".fallout-maw-window-free-edit-toggle");
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "fallout-maw-window-free-edit-toggle";
      button.innerHTML = `<i class="fa-solid fa-lock" inert></i>`;
      button.addEventListener("click", event => {
        event.preventDefault();
        this.#actorNameDraft = null;
        this.#freeEdit = !this.#freeEdit;
        return this.render({ force: true });
      });
      header.querySelector(".window-title")?.after(button);
    }

    if (!button) return;
    const label = this.#freeEdit
      ? game.i18n.localize("FALLOUTMAW.Actor.LockCoreFields")
      : game.i18n.localize("FALLOUTMAW.Actor.UnlockCoreFields");
    button.classList.toggle("active", this.#freeEdit);
    button.classList.toggle("locked", !this.#freeEdit);
    button.classList.toggle("unlocked", this.#freeEdit);
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    button.dataset.tooltip = label;

    const icon = button.querySelector("i");
    if (!icon) return;
    icon.classList.toggle("fa-lock", !this.#freeEdit);
    icon.classList.toggle("fa-lock-open", this.#freeEdit);
  }

  #syncWorldSidebarPeekToggle() {
    const root = this.element;
    if (!root) return;

    root.classList.toggle("fallout-maw-world-sidebar-peek", Boolean(this.#worldSidebarPeek && game.user?.isGM));
    let button = root.querySelector(":scope > .fallout-maw-world-sidebar-peek-toggle");
    if (!game.user?.isGM) {
      button?.remove();
      return;
    }

    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "fallout-maw-world-sidebar-peek-toggle";
      button.innerHTML = `<i class="fa-solid fa-chevron-left" inert></i>`;
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        this.#worldSidebarPeek = !this.#worldSidebarPeek;
        this.setPosition();
        this.#syncWorldSidebarPeekToggle();
      });
      root.append(button);
    }

    const label = this.#worldSidebarPeek
      ? "Закрыть обзор боковой панели"
      : "Открыть обзор боковой панели";
    button.classList.toggle("active", this.#worldSidebarPeek);
    button.setAttribute("aria-pressed", this.#worldSidebarPeek ? "true" : "false");
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    button.dataset.tooltip = label;

    const icon = button.querySelector("i");
    icon?.classList.toggle("fa-chevron-left", !this.#worldSidebarPeek);
    icon?.classList.toggle("fa-chevron-right", this.#worldSidebarPeek);
  }

  #onLimbControlKeyDown(event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    this.#onLimbControlClick(event);
  }

  #onLimbControlClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    const card = target?.closest("[data-limb-control-card]");
    if (!card || !this.element?.contains(card)) return;
    if (target.closest("input, select, textarea, [data-action='deleteTrauma']")) return;
    if (!game.user?.isGM) return;

    event.preventDefault();
    event.stopPropagation();
    const limbKey = card.dataset.limbKey ?? "";
    if (!limbKey) return;
    this.#activeLimbKey = limbKey;
    void openLimbDamageDialog(this.actor, limbKey);
  }

  static #onCreateResearch(event) {
    event.preventDefault();
    if (!game.user?.isGM) return undefined;
    return openCreateResearchDialog(this.actor);
  }

  static #onManageResearch(event, target) {
    event.preventDefault();
    if (!game.user?.isGM) return undefined;
    const researchId = target.closest("[data-research-id]")?.dataset.researchId ?? "";
    if (!researchId) return undefined;
    return openManageResearchDialog(this.actor, researchId);
  }

  static #onDeleteResearch(event, target) {
    event.preventDefault();
    if (!game.user?.isGM) return undefined;
    const researchId = target.closest("[data-research-id]")?.dataset.researchId ?? "";
    if (!researchId) return undefined;
    return deleteResearchWithConfirm(this.actor, researchId);
  }

  static #onOpenResearchTime(event, target) {
    event.preventDefault();
    const researchId = target.closest("[data-research-id]")?.dataset.researchId ?? "";
    if (!researchId) return undefined;
    const research = this.actor.getResearch(researchId);
    if (research && (Number(research.progress) >= Number(research.target))) {
      return completeResearch(this.actor, researchId);
    }
    return openResearchTimeDialog(this.actor, researchId);
  }

  static async #onCreateEffect(event) {
    event.preventDefault();
    if (!game.user?.isGM) return undefined;
    const [effect] = await this.actor.createEmbeddedDocuments("ActiveEffect", [{
      type: "base",
      name: game.i18n.localize("FALLOUTMAW.Effects.NewEffect"),
      img: "icons/svg/aura.svg",
      disabled: false,
      flags: {
        "fallout-maw": {
          kind: "active"
        }
      },
      system: {
        changes: []
      }
    }]);
    effect?.sheet?.render(true);
    return this.render({ parts: ["effects"] });
  }

  static #onEditEffect(event, target) {
    event.preventDefault();
    if (!game.user?.isGM) return undefined;
    const effect = getEffectFromTarget(this.actor, target);
    return effect?.sheet?.render(true);
  }

  static #onToggleEffect(event, target) {
    event.preventDefault();
    if (!game.user?.isGM) return undefined;
    const effect = getEffectFromTarget(this.actor, target);
    return effect?.update({ disabled: !effect.disabled });
  }

  static #onDeleteEffect(event, target) {
    event.preventDefault();
    if (!game.user?.isGM) return undefined;
    const effect = getEffectFromTarget(this.actor, target);
    return effect?.delete();
  }

  static #onRollSkill(event, target) {
    event.preventDefault();
    const skillKey = target.dataset.skillKey ?? "";
    if (!skillKey) return undefined;
    return requestSkillCheck({
      actor: this.actor,
      skillKey,
      animate: true,
      prompt: true,
      requester: "actorSheet"
    });
  }

  static async #onSelectHudWeaponSet(event, target) {
    event.preventDefault();
    const actor = this.actor;
    if (!actor?.isOwner) return undefined;
    const weaponSetKey = String(target.dataset.weaponSet ?? "");
    if (!weaponSetKey) return undefined;

    const race = getCreatureOptions().races.find(entry => entry.id === actor.system?.creature?.raceId);
    const inventory = prepareDisplayInventoryContext(actor, race);
    const weaponSets = getSheetHudWeaponSets(inventory);
    const set = weaponSets.find(entry => entry.key === weaponSetKey) ?? null;
    if (!set) return undefined;

    await actor.setFlag(FALLOUT_MAW.id, SELECTED_HUD_WEAPON_SET_FLAG, weaponSetKey);
    const firstWeaponId = getUniqueWeaponSetSlots(set.slots).at(0)?.item?.id ?? "";
    if (firstWeaponId) await actor.setFlag(FALLOUT_MAW.id, SELECTED_HUD_WEAPON_FLAG, firstWeaponId);
    return this.render({ parts: ["inventory"] });
  }

  #relocateEffectsAddButton() {
    const root = this.element;
    const button = root?.querySelector(".fallout-maw-effects-tab .fallout-maw-floating-add");
    if (!root || !button) return;
    for (const existing of root.querySelectorAll(":scope > .fallout-maw-floating-add")) {
      if (existing !== button) existing.remove();
    }
    root.append(button);
  }

  #activateCreatureSelectors() {
    const root = this.element;
    const typeSelect = root?.querySelector("[data-creature-type-select]");
    const raceSelect = root?.querySelector("[data-creature-race-select]");
    const subtypeSelect = root?.querySelector("[data-creature-subtype-select]");
    if (!typeSelect || !raceSelect) return;

    const selectFirstVisible = select => {
      const option = Array.from(select.options).find(entry => entry.value && !entry.hidden && !entry.disabled);
      select.value = option?.value ?? "";
    };

    const updateSubtypeOptions = () => {
      if (!subtypeSelect) return;
      const raceId = raceSelect.value;
      let selectedAvailable = false;
      for (const option of subtypeSelect.options) {
        const optionRaceId = option.dataset.raceId;
        const visible = !option.value || (raceId && optionRaceId === raceId);
        option.hidden = !visible;
        option.disabled = !visible;
        if (visible && option.selected && option.value) selectedAvailable = true;
      }
      if (!selectedAvailable) selectFirstVisible(subtypeSelect);
    };

    const updateRaceOptions = ({ selectDefault = false } = {}) => {
      const typeId = typeSelect.value;
      let selectedAvailable = false;

      for (const option of raceSelect.options) {
        const optionTypeId = option.dataset.typeId;
        const visible = !option.value || (typeId && optionTypeId === typeId);
        option.hidden = !visible;
        option.disabled = !visible;
        if (visible && option.selected && option.value) selectedAvailable = true;
      }

      if (selectDefault || !selectedAvailable) selectFirstVisible(raceSelect);
      updateSubtypeOptions();
    };

    raceSelect.addEventListener("change", event => {
      const selected = event.currentTarget.selectedOptions[0];
      if (selected?.dataset.typeId) typeSelect.value = selected.dataset.typeId;
      updateRaceOptions();
      updateSubtypeOptions();
    });
    typeSelect.addEventListener("change", () => updateRaceOptions({ selectDefault: true }));
    updateRaceOptions();
    updateSubtypeOptions();
  }

  #activateInventoryInteractions() {
    const root = this.element;
    const inventoryTab = root?.querySelector('[data-tab="inventory"]');
    if (!inventoryTab) return;
    if (root.dataset.falloutMawInventoryInteractions === "true") return;
    root.dataset.falloutMawInventoryInteractions = "true";

    root.addEventListener("dragleave", event => this.#onInventoryDragLeave(event));
    root.addEventListener("contextmenu", event => this.#onInventoryContextMenu(event));
    root.addEventListener("mouseover", event => this.#onInventoryItemMouseOver(event));
    root.addEventListener("mousemove", event => this.#onInventoryItemMouseMove(event));
    root.addEventListener("mouseout", event => this.#onInventoryItemMouseOut(event));
    root.addEventListener("mousedown", event => this.#onInventoryMiddleMouseDown(event));
    root.addEventListener("auxclick", event => this.#onInventoryAuxClick(event));
    root.addEventListener("click", event => this.#onInventoryClick(event));
  }

  #activateTabScrollPersistence() {
    const root = this.element;
    if (!root || (root.dataset.falloutMawTabScrollPersistence === "true")) return;
    root.dataset.falloutMawTabScrollPersistence = "true";
    root.addEventListener("scroll", event => this.#onTabScroll(event), true);
  }

  #onTabScroll(event) {
    const tab = event.target?.closest?.(".tab[data-tab]");
    if (!tab) return;
    const scrollContainer = event.target?.closest?.("[data-scroll-key]");
    const key = scrollContainer
      ? `${tab.dataset.tab}:${scrollContainer.dataset.scrollKey}`
      : tab.dataset.tab;
    this.#tabScrollPositions.set(key, event.target?.scrollTop ?? tab.scrollTop ?? 0);
  }

  #restoreActiveTabScroll() {
    const activeTab = this.element?.querySelector?.(".tab.active[data-tab]");
    if (!activeTab) return;

    const view = this.element?.ownerDocument?.defaultView ?? window;
    view.requestAnimationFrame(() => {
      if (!this.element?.isConnected) return;
      const nextActiveTab = this.element.querySelector(".tab.active[data-tab]");
      if (!nextActiveTab || (nextActiveTab.dataset.tab !== activeTab.dataset.tab)) return;
      nextActiveTab.scrollTop = this.#tabScrollPositions.get(nextActiveTab.dataset.tab) ?? 0;
      for (const container of nextActiveTab.querySelectorAll("[data-scroll-key]")) {
        const key = `${nextActiveTab.dataset.tab}:${container.dataset.scrollKey}`;
        container.scrollTop = this.#tabScrollPositions.get(key) ?? 0;
      }
    });
  }

  #onInventoryDragLeave(event) {
    const zone = event.target?.closest?.("[data-drop-zone], [data-equipment-drop-surface], [data-inventory-drop-surface]");
    if (!zone) return;

    const hoveredElement = document.elementFromPoint(event.clientX, event.clientY);
    const hoveredZone = hoveredElement?.closest?.("[data-drop-zone], [data-equipment-drop-surface], [data-inventory-drop-surface]") ?? null;
    if (hoveredZone === zone) return;

    const hoveredSheet = hoveredElement?.closest?.(".fallout-maw-actor-sheet");
    if (hoveredSheet === this.element) return;

    this.#clearActorContainerDropPreview();
    this.#clearDragPreviewCache();
    this.#clearInventoryDropPreview();
  }

  #onInventoryContextMenu(event) {
    const itemElement = event.target?.closest?.("[data-item-id], [data-ability-id]");
    if (!itemElement) return;

    const itemId = itemElement.dataset.itemId ?? itemElement.dataset.abilityId ?? "";
    const item = this.actor.items.get(itemId);
    if (!item) return;
    if (isItemInButcheringStorage(item)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (item.type === "ability" && !game.user?.isGM) return;
    event.preventDefault();
    event.stopPropagation();
    this.#showInventoryContextMenu(item, event, {
      stackIndex: Math.max(0, toInteger(itemElement.dataset.stackIndex)),
      stackQuantity: Math.max(0, toInteger(itemElement.dataset.stackQuantity))
    });
  }

  #onInventoryItemMouseOver(event) {
    if (this.#inventoryContextMenuOpen) return;
    if (this.#tooltipPinned) return;
    if (event.target?.closest?.("[data-tooltip-ignore]")) return;
    const itemElement = event.target?.closest?.("[data-tooltip-item]");
    if (!itemElement) return;
    if (itemElement.contains(event.relatedTarget)) return;

    const item = this.actor.items.get(itemElement.dataset.tooltipItem);
    if (!item) return;
    this.#tooltipBaseMode = Boolean(event.altKey);
    this.#tooltipCompareMode = Boolean(event.ctrlKey);
    this.#tooltipPointer = { x: event.clientX, y: event.clientY };
    this.#cancelInventoryTooltipClose();
    if (this.#tooltipElement && !this.#tooltipPinned) {
      if (this.#tooltipTimer) {
        clearTimeout(this.#tooltipTimer);
        this.#tooltipTimer = null;
      }
      this.#clearNestedInventoryTooltip({ force: true });
      this.#tooltipAnchorElement = itemElement;
      this.#tooltipItemId = item.id;
      this.#tooltipWeaponTabIndex = 0;
      void this.#showInventoryTooltip(item, { refresh: true });
      return;
    }

    this.#clearInventoryTooltip();
    this.#tooltipBaseMode = Boolean(event.altKey);
    this.#tooltipCompareMode = Boolean(event.ctrlKey);
    this.#tooltipAnchorElement = itemElement;
    this.#tooltipItemId = item.id;
    this.#tooltipWeaponTabIndex = 0;
    this.#tooltipTimer = setTimeout(() => this.#showInventoryTooltip(item), 500);
  }

  #activateWeaponSlotAspectSizing() {
    const images = this.element?.querySelectorAll(".fallout-maw-weapon-slot .fallout-maw-inventory-item > img") ?? [];
    for (const image of images) {
      const applyAspect = () => setWeaponSlotImageAspect(image);
      if (image.complete && image.naturalWidth && image.naturalHeight) applyAspect();
      else image.addEventListener("load", applyAspect, { once: true });
    }
  }

  #onInventoryItemMouseMove(event) {
    if (this.#inventoryContextMenuOpen) return;
    if (this.#tooltipPinned) return;
    if (event.target?.closest?.("[data-tooltip-ignore]")) return;
    if (!event.target?.closest?.("[data-tooltip-item]")) return;
    this.#tooltipPointer = { x: event.clientX, y: event.clientY };
  }

  #onInventoryItemMouseOut(event) {
    if (this.#tooltipPinned) return;
    const itemElement = event.target?.closest?.("[data-tooltip-item]");
    if (!itemElement || itemElement.contains(event.relatedTarget)) return;
    const nextItemElement = event.relatedTarget?.closest?.("[data-tooltip-item]");
    if (nextItemElement && this.element?.contains(nextItemElement)) return;
    if (this.#tooltipElement?.contains(event.relatedTarget)) return;
    this.#scheduleInventoryTooltipClose();
  }

  #onInventoryMiddleMouseDown(event) {
    if (event.button !== 1) return;
    if (!event.target?.closest?.("[data-tooltip-item], .fallout-maw-inventory-tooltip")) return;
    event.preventDefault();
  }

  #onInventoryAuxClick(event) {
    if (this.#inventoryContextMenuOpen) return;
    if (event.button !== 1) return;
    const itemElement = event.target?.closest?.("[data-tooltip-item]");
    if (!itemElement) return;

    event.preventDefault();
    event.stopPropagation();
    const item = this.actor.items.get(itemElement.dataset.tooltipItem);
    if (!item) return;

    const sameTooltip = this.#tooltipElement && this.#tooltipItemId === item.id;
    const shouldPin = !(sameTooltip && this.#tooltipPinned);
    this.#clearInventoryTooltip({ force: true });
    if (!shouldPin) return;

    this.#tooltipPinned = true;
    this.#tooltipBaseMode = Boolean(event.altKey);
    this.#tooltipCompareMode = Boolean(event.ctrlKey);
    this.#tooltipPointer = { x: event.clientX, y: event.clientY };
    this.#tooltipAnchorElement = itemElement;
    this.#tooltipWeaponTabIndex = 0;
    void this.#showInventoryTooltip(item, { pinned: true });
  }

  async #onInventoryClick(event) {
    if (event.shiftKey && event.button === 0) {
      const itemElement = event.target?.closest?.("[data-inventory-grid-item][data-item-id]");
      if (itemElement && this.element?.contains(itemElement)) {
        const item = this.actor.items.get(itemElement.dataset.itemId ?? "");
        if (item) {
          event.preventDefault();
          event.stopPropagation();
          if (isItemInButcheringStorage(item)) return;
          this.#closeInventoryContextMenu();
          this.#clearInventoryTooltip({ force: true });
          await this.#cycleInventoryItemContainer(item, {
            sourceStackIndex: Math.max(0, toInteger(itemElement.dataset.stackIndex)),
            sourceStackQuantity: Math.max(0, toInteger(itemElement.dataset.stackQuantity))
          });
          return;
        }
      }
    }
    this.#closeInventoryContextMenu();
  }

  #getDropZone(eventOrTarget) {
    const target = eventOrTarget?.target ?? eventOrTarget;
    const pointedCell = this.#getInventoryCellAtPointer(eventOrTarget, target);
    if (pointedCell) return pointedCell;

    const targetItem = target?.closest?.("[data-inventory-grid-item][data-item-id]");
    if (targetItem && this.element?.contains(targetItem)) return targetItem;
    const specificZone = target?.closest?.("[data-inventory-cell], [data-equipment-slot], [data-weapon-slot]");
    if (specificZone) return specificZone;
    const equipmentSurface = target?.closest?.("[data-equipment-drop-surface]");
    if (equipmentSurface) return equipmentSurface;
    const containerSurface = target?.closest?.("[data-container-drop-surface]");
    if (containerSurface) return containerSurface;
    const surface = target?.closest?.("[data-inventory-drop-surface]");
    if (surface) return surface;
    if (target?.closest?.(".fallout-maw-actor-sheet")) return this.element.querySelector('[data-tab="inventory"]');
    return this.element?.querySelector('[data-tab="inventory"]') ?? null;
  }

  #getInventoryCellAtPointer(eventOrTarget, target = null) {
    const clientX = Number(eventOrTarget?.clientX);
    const clientY = Number(eventOrTarget?.clientY);
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;

    const pointedElement = document.elementFromPoint(clientX, clientY);
    const grid = (
      target?.closest?.("[data-inventory-grid]")
      ?? pointedElement?.closest?.("[data-inventory-grid]")
      ?? null
    );
    if (!grid || !this.element?.contains(grid)) return null;

    const pointer = this.#getInventoryGridPointerPosition(eventOrTarget, grid);
    if (!pointer) return null;

    return syncInventoryVirtualCell(grid, pointer, {
      inventoryParentId: String(grid.dataset.inventoryParentId ?? ROOT_CONTAINER_ID)
    });
  }

  #getInventoryContextParentId(zone = null) {
    if (!zone) return ROOT_CONTAINER_ID;
    return String(zone.dataset.inventoryParentId ?? zone.dataset.containerId ?? ROOT_CONTAINER_ID);
  }

  #getContextInventoryItems(parentId = ROOT_CONTAINER_ID) {
    return getContextInventoryItems(parentId, this.actor.items);
  }

  #isLockedStorageParentId(parentId = ROOT_CONTAINER_ID) {
    return String(parentId ?? ROOT_CONTAINER_ID) === LOCKED_STORAGE_PARENT_ID;
  }

  #getStoredInventoryParentId(parentId = ROOT_CONTAINER_ID) {
    return this.#isLockedStorageParentId(parentId) ? ROOT_CONTAINER_ID : parentId;
  }

  #getInventoryPlacementModeForParent(parentId = ROOT_CONTAINER_ID) {
    return this.#isLockedStorageParentId(parentId) ? LOCKED_STORAGE_PLACEMENT_MODE : "inventory";
  }

  #createContextInventoryPlacement(placement = {}, parentId = ROOT_CONTAINER_ID) {
    return {
      ...placement,
      mode: this.#getInventoryPlacementModeForParent(parentId),
      equipmentSlot: "",
      weaponSet: "",
      weaponSlot: "",
      limbKey: ""
    };
  }

  #highlightEquipmentSlotsForItem(itemData) {
    const race = this.#getCurrentRace();
    const selectedSlots = getRaceEquipmentSlotsForItem(race, itemData);
    let highlighted = false;

    for (const slot of selectedSlots) {
      this.element?.querySelector(`[data-equipment-slot="${CSS.escape(slot.key)}"]`)?.classList.add("drop-match-preview");
      highlighted = true;
    }

    if (this.actor?.type === "construct") {
      for (const slot of getConstructPartSlots(this.actor)) {
        if (!isConstructPartCompatibleWithSlot(itemData, slot)) continue;
        if (getInstalledConstructPartForSlot(this.actor, slot.id)) continue;
        this.element?.querySelector(`[data-construct-part-slot="${CSS.escape(slot.id)}"]`)?.classList.add("drop-match-preview");
        highlighted = true;
      }
    }

    if (!getValidSelectedWeaponSlotKeys(race, itemData).size) return highlighted;
    for (const set of race?.weaponSets ?? []) {
      for (const slot of set.slots ?? []) {
        if (!canUseWeaponSlotForItem(race, itemData, set.key, slot.key)) continue;
        this.element?.querySelector(
          `[data-weapon-set="${CSS.escape(set.key)}"][data-weapon-slot="${CSS.escape(slot.key)}"]`
        )?.classList.add("drop-match-preview");
        highlighted = true;
      }
    }
    this.element?.querySelectorAll("[data-weapon-set^='container:'][data-weapon-slot]").forEach(element => {
      element.classList.add("drop-match-preview");
      highlighted = true;
    });
    return highlighted;
  }

  #setInventoryHoverPreview(zone = null, event = null) {
    if (!zone) {
      this.#clearInventoryHoverPreview();
      return;
    }
    if (zone.dataset.constructPartSlot) {
      const slot = getConstructPartSlot(this.actor, zone.dataset.constructPartSlot);
      const compatible = slot
        && this.#draggedItemData
        && isConstructPartCompatibleWithSlot(this.#draggedItemData, slot)
        && !getInstalledConstructPartForSlot(this.actor, slot.id);
      if (!compatible) {
        this.#clearInventoryHoverPreview();
        return;
      }
      this.#applySingleZonePreview(zone, `construct-part:${slot.id}:${this.#draggedItemId}`);
      return;
    }
    if (zone.dataset.inventoryCell !== undefined || zone.dataset.inventoryGridItem !== undefined) {
      this.#setInventoryCellHoverPreview(zone, event);
      return;
    }
    if (zone.dataset.dropZone === undefined) {
      this.#clearInventoryHoverPreview();
      return;
    }
    if (zone.classList.contains("drop-match-preview")) {
      this.#clearInventoryHoverPreview();
      return;
    }
    this.#applySingleZonePreview(zone, `zone:${zone.dataset.dropZone ?? ""}:${zone.dataset.equipmentSlot ?? ""}:${zone.dataset.weaponSet ?? ""}:${zone.dataset.weaponSlot ?? ""}`);
  }

  #setInventoryCellHoverPreview(zone, event = null) {
    if (!this.#draggedItemData) {
      this.#applySingleZonePreview(zone, `cell:${this.#getInventoryContextParentId(zone)}:${zone.dataset.x ?? ""}:${zone.dataset.y ?? ""}`);
      return;
    }

    const sourceItemId = this.#draggedItemId || "";
    const parentId = this.#getInventoryContextParentId(zone);
    const inputKey = `inventory:${parentId}:${zone.dataset.x ?? ""}:${zone.dataset.y ?? ""}:${sourceItemId}:${this.#dragPreviewSourceKey}:${Boolean(this.#draggedItemData?.system?.placement?.rotated)}`;
    if (this.#hoverPreviewInputKey === inputKey) return;
    this.#hoverPreviewInputKey = inputKey;
    const targetItem = this.#getTargetStackItem(zone, sourceItemId, parentId);
    const stackRoom = targetItem
      && this.#areStackable(this.#draggedItemData, targetItem)
      && (getItemQuantity(targetItem) < getItemMaxStack(targetItem));
    if (stackRoom) {
      this.#applyInventoryStackPreview(targetItem, parentId);
      return;
    }

    const excludeItemIds = sourceItemId ? [sourceItemId] : [];
    const { columns, rows } = this.#getInventoryGridDimensions(parentId);
    const gridOptions = this.#getInventoryGridOptions(parentId);
    const isPlacementAvailable = createInventoryHoverPlacementChecker(
      this.#getContextInventoryItems(parentId),
      columns,
      rows,
      this.actor.items,
      excludeItemIds,
      gridOptions,
      parentId
    );
    const placement = resolveInventoryPointerPlacement({
      anchor: { x: toInteger(zone.dataset.x), y: toInteger(zone.dataset.y) },
      itemData: this.#draggedItemData,
      items: this.actor.items,
      dimensions: { columns, rows },
      options: gridOptions,
      sourceItem: sourceItemId ? this.actor.items.get(sourceItemId) : null,
      findNearest: Boolean(targetItem),
      isPlacementAvailable
    });
    if (!placement) {
      if (this.#hoverPreviewKey === "none") return;
      this.#clearInventoryHoverPreviewClasses();
      this.#hoverPreviewKey = "none";
      return;
    }
    this.#applyInventoryPlacementPreview(placement, parentId);
  }

  #applySingleZonePreview(zone, key = "") {
    const previewKey = `single:${key}`;
    if (this.#hoverPreviewKey === previewKey) return;
    this.#clearInventoryHoverPreviewClasses();
    this.#hoverPreviewKey = previewKey;
    zone?.classList?.add("drop-preview");
  }

  #applyInventoryPlacementPreview(placement, parentId = ROOT_CONTAINER_ID) {
    if (!placement) return;
    const previewKey = `placement:${parentId}:${placement.x}:${placement.y}:${placement.width}:${placement.height}:${Boolean(placement.rotated)}`;
    if (this.#hoverPreviewKey === previewKey) return;
    this.#clearInventoryHoverPreviewClasses();
    this.#hoverPreviewKey = previewKey;
    const grid = this.#getInventoryGridElement(parentId);
    renderInventoryPlacementPreview(grid, placement, {
      className: "drop-preview",
      kind: "placement"
    });
  }

  #applyInventoryStackPreview(targetItem, parentId = ROOT_CONTAINER_ID) {
    if (!targetItem) return;
    const previewKey = `stack:${parentId}:${targetItem.id}:${getItemQuantity(targetItem)}:${getItemMaxStack(targetItem)}`;
    if (this.#hoverPreviewKey === previewKey) return;
    this.#clearInventoryHoverPreviewClasses();
    this.#hoverPreviewKey = previewKey;
    const escapedItemId = CSS.escape(targetItem.id);
    const escapedParentId = CSS.escape(parentId);
    this.element?.querySelector(
      `[data-inventory-grid-item][data-item-id="${escapedItemId}"][data-inventory-parent-id="${escapedParentId}"]`
    )?.classList.add("drop-stack-preview");

    const placement = normalizeInventoryPlacement(targetItem.system?.placement ?? {}, targetItem, this.actor.items);
    const grid = this.#getInventoryGridElement(parentId);
    renderInventoryPlacementPreview(grid, placement, { className: "drop-stack-preview", kind: "stack" });
  }

  #clearInventoryHoverPreview() {
    this.#hoverPreviewInputKey = "";
    this.#clearInventoryHoverPreviewClasses();
  }

  #clearInventoryHoverPreviewClasses() {
    this.#hoverPreviewKey = "";
    clearInventoryPlacementPreviews(this.element);
    this.element?.querySelectorAll(".drop-preview, .drop-stack-preview").forEach(element => {
      element.classList.remove("drop-preview", "drop-stack-preview");
    });
  }

  #clearInventoryDropPreview() {
    this.#clearInventoryHoverPreview();
    clearInventoryVirtualCells(this.element);
    this.element?.querySelectorAll(".drop-match-preview").forEach(element => {
      element.classList.remove("drop-match-preview");
    });
  }

  #clearDragPreviewCache() {
    this.#draggedItemData = null;
    this.#draggedItemId = "";
    this.#dragPreviewSourceKey = "";
  }

  #clearInventoryDraggingState() {
    this.element?.querySelectorAll(".dragging").forEach(element => {
      element.classList.remove("dragging");
    });
  }

  #getPlacementForDropZone(zone, itemData = null, excludeItemIds = [], parentId = ROOT_CONTAINER_ID, event = null) {
    if (zone.dataset.inventoryCell !== undefined || zone.dataset.inventoryGridItem !== undefined) {
      const placement = this.#getInventoryPointerPlacement(zone, itemData, excludeItemIds, parentId, event)
        ?? createInventoryPlacement(toInteger(zone.dataset.x), toInteger(zone.dataset.y), itemData, this.actor.items);
      return this.#createContextInventoryPlacement(placement, parentId);
    }

    if (zone.dataset.constructPartSlot) {
      const slot = getConstructPartSlot(this.actor, zone.dataset.constructPartSlot);
      if (!slot || !isConstructPartCompatibleWithSlot(itemData, slot)) {
        ui.notifications?.warn?.("Тип детали не совпадает с типом этого слота конструкта.");
        return null;
      }
      const footprint = getItemFootprint(itemData);
      return {
        mode: ITEM_FUNCTIONS.constructPart,
        equipmentSlot: "",
        weaponSet: "",
        weaponSlot: "",
        limbKey: slot.id,
        constructPartOrder: slot.order,
        x: 1,
        y: 1,
        width: footprint.width,
        height: footprint.height
      };
    }

    if (zone.dataset.equipmentSlot) {
      const footprint = getItemFootprint(itemData);
      return {
        mode: "equipment",
        equipmentSlot: zone.dataset.equipmentSlot,
        weaponSet: "",
        weaponSlot: "",
        x: 1,
        y: 1,
        width: footprint.width,
        height: footprint.height
      };
    }

    if (zone.dataset.equipmentDropSurface !== undefined) {
      const footprint = getItemFootprint(itemData);
      return {
        mode: "equipment",
        equipmentSlot: "",
        weaponSet: "",
        weaponSlot: "",
        x: 1,
        y: 1,
        width: footprint.width,
        height: footprint.height
      };
    }

    if (zone.dataset.weaponSet && zone.dataset.weaponSlot) {
      const footprint = getItemFootprint(itemData);
      return {
        mode: "weapon",
        equipmentSlot: "",
        weaponSet: zone.dataset.weaponSet,
        weaponSlot: zone.dataset.weaponSlot,
        x: 1,
        y: 1,
        width: footprint.width,
        height: footprint.height
      };
    }

    const placement = this.#getFirstAvailableInventoryPlacement(itemData, excludeItemIds, [], parentId);
    return placement ? this.#createContextInventoryPlacement(placement, parentId) : null;
  }

  #getInventoryPointerPlacement(
    zone,
    itemData = null,
    excludeItemIds = [],
    parentId = ROOT_CONTAINER_ID,
    event = null,
    { findNearest = true } = {}
  ) {
    if (!event) return null;
    const grid = zone?.closest?.("[data-inventory-grid]");
    if (!grid || !this.element?.contains(grid)) return null;
    const pointer = this.#getInventoryGridPointerPosition(event, grid);
    if (!pointer) return null;

    const { columns, rows } = this.#getInventoryGridDimensions(parentId);
    const gridOptions = this.#getInventoryGridOptions(parentId);
    const excluded = Array.isArray(excludeItemIds) ? excludeItemIds.filter(Boolean) : [excludeItemIds].filter(Boolean);
    const isPlacementAvailable = createInventoryHoverPlacementChecker(
      this.#getContextInventoryItems(parentId),
      columns,
      rows,
      this.actor.items,
      excluded,
      gridOptions,
      parentId
    );
    const sourceItemId = excluded[0] ?? "";
    return resolveInventoryPointerPlacement({
      anchor: pointer,
      itemData,
      items: this.actor.items,
      dimensions: { columns, rows },
      options: gridOptions,
      sourceItem: sourceItemId ? this.actor.items.get(sourceItemId) : null,
      findNearest,
      isPlacementAvailable
    });
  }

  #getInventoryGridPointerPosition(event, grid) {
    const parentId = String(grid?.dataset?.inventoryParentId ?? ROOT_CONTAINER_ID);
    return getInventoryGridPointerPositionFromElement(event, grid, {
      allowOverflowRows: this.#getInventoryGridOptions(parentId).allowOverflowRows
    });
  }

  #getInventoryGridElement(parentId = ROOT_CONTAINER_ID) {
    const escapedParentId = CSS.escape(String(parentId ?? ROOT_CONTAINER_ID));
    return this.element?.querySelector(`[data-inventory-grid][data-inventory-parent-id="${escapedParentId}"]`) ?? null;
  }

  #getNearestInventoryCellInGrid(originX, originY, itemData = null, excludeItemIds = [], parentId = ROOT_CONTAINER_ID, columns = 1, rows = 1) {
    const gridOptions = this.#getInventoryGridOptions(parentId);
    const excluded = Array.isArray(excludeItemIds) ? excludeItemIds.filter(Boolean) : [excludeItemIds].filter(Boolean);
    const isPlacementAvailable = createInventoryHoverPlacementChecker(
      this.#getContextInventoryItems(parentId),
      columns,
      rows,
      this.actor.items,
      excluded,
      gridOptions,
      parentId
    );
    return resolveInventoryPointerPlacement({
      anchor: { x: originX, y: originY },
      itemData,
      items: this.actor.items,
      dimensions: { columns, rows },
      options: gridOptions,
      sourceItem: excluded[0] ? this.actor.items.get(excluded[0]) : null,
      findNearest: true,
      isPlacementAvailable
    });
  }

  #getInventoryGridDimensions(parentId = ROOT_CONTAINER_ID) {
    if (this.#isLockedStorageParentId(parentId)) {
      return getInventoryGridDimensions(this.#getCurrentRace(), this.actor);
    }
    if (parentId && (parentId !== ROOT_CONTAINER_ID)) {
      return getContainerInventoryGridOptions(this.actor.items.get(parentId));
    }
    return getInventoryGridDimensions(this.#getCurrentRace(), this.actor);
  }

  #getInventoryGridOptions(parentId = ROOT_CONTAINER_ID) {
    if (this.#isLockedStorageParentId(parentId)) {
      return {
        allowOverflowRows: true,
        extraRows: INFINITE_ROOT_INVENTORY_EMPTY_ROWS,
        placementMode: LOCKED_STORAGE_PLACEMENT_MODE,
        preferredPlacementModes: [LOCKED_STORAGE_PLACEMENT_MODE]
      };
    }
    if (parentId && (parentId !== ROOT_CONTAINER_ID)) {
      return getContainerInventoryGridOptions(this.actor.items.get(parentId));
    }
    return getActorRootInventoryGridOptions(this.actor, parentId);
  }

  #getFirstAvailableInventoryPlacement(itemData = null, excludeItemIds = [], reservedPlacements = [], parentId = ROOT_CONTAINER_ID, options = {}) {
    const { columns, rows } = this.#getInventoryGridDimensions(parentId);
    return findFirstAvailableInventoryPlacement(
      this.#getContextInventoryItems(parentId),
      columns,
      rows,
      itemData,
      this.actor.items,
      excludeItemIds,
      reservedPlacements,
      { ...this.#getInventoryGridOptions(parentId), ...options }
    );
  }

  #isInventoryPlacementAvailable(placement, excludeItemIds = [], reservedPlacements = [], parentId = ROOT_CONTAINER_ID) {
    const { columns, rows } = this.#getInventoryGridDimensions(parentId);
    return isInventoryPlacementAvailable(
      placement,
      this.#getContextInventoryItems(parentId),
      columns,
      rows,
      this.actor.items,
      excludeItemIds,
      reservedPlacements,
      this.#getInventoryGridOptions(parentId)
    );
  }

  async #getDroppedItemFromData(data) {
    if (data?.type !== "Item") return null;

    const ownedItem = data.itemId ? this.actor.items.get(data.itemId) : null;
    if (ownedItem) return { item: ownedItem, itemData: applyInventoryDragRotation(ownedItem.toObject(), data) };

    const item = await Item.implementation.fromDropData(data).catch(() => null);
    if (!(item instanceof Item)) return null;
    return { item, itemData: applyInventoryDragRotation(item.toObject(), data) };
  }

  #getPreviewItemData(event) {
    const data = this.#getDragEventData(event);
    if (data?.type !== "Item") {
      this.#clearDragPreviewCache();
      return null;
    }

    const sourceKey = this.#getDragPreviewSourceKey(data);
    if (this.#draggedItemData && sourceKey && (sourceKey === this.#dragPreviewSourceKey)) {
      return applyInventoryDragRotation(this.#draggedItemData, data);
    }

    const ownedItem = data.itemId ? this.actor.items.get(data.itemId) : null;
    if (ownedItem) {
      this.#draggedItemId = ownedItem.id;
      this.#dragPreviewSourceKey = sourceKey;
      this.#draggedItemData = applyInventoryDragRotation(ownedItem.toObject(), data);
      return this.#draggedItemData;
    }

    const droppedDocument = data.uuid ? resolveWorldItemSync(data.uuid) : null;
    if (droppedDocument instanceof Item) {
      this.#dragPreviewSourceKey = sourceKey;
      this.#draggedItemData = applyInventoryDragRotation(droppedDocument.toObject(), data);
      return this.#draggedItemData;
    }
    this.#clearDragPreviewCache();
    return null;
  }

  #getDragPreviewSourceKey(data = {}) {
    if (data?.itemId) return `owned:${data.itemId}`;
    if (data?.uuid) return `uuid:${data.uuid}`;
    if (data?._id) return `id:${data._id}`;
    return "";
  }

  #getDragEventData(event) {
    const cachedPayload = CONFIG.ux.DragDrop?.getPayload?.();
    if (cachedPayload && (typeof cachedPayload === "object")) return cachedPayload;

    try {
      const data = TextEditor.getDragEventData(event);
      if (data && (typeof data === "object")) return data;
    } catch (_error) {
      // Fall through to explicit transfer payloads.
    }

    for (const type of ["application/json", "text/plain"]) {
      const raw = event.dataTransfer?.getData(type);
      if (!raw) continue;
      try {
        return JSON.parse(raw);
      } catch (_error) {
        continue;
      }
    }

    return null;
  }

  #getTargetStackItem(target, sourceItemId = "", parentId = ROOT_CONTAINER_ID) {
    const itemElement = target?.closest?.("[data-item-id]");
    if (itemElement && itemElement.dataset.itemId !== sourceItemId) {
      if (!itemElement.closest("[data-inventory-grid]")) return null;
      if (String(itemElement.dataset.inventoryParentId ?? ROOT_CONTAINER_ID) !== String(parentId ?? ROOT_CONTAINER_ID)) return null;
      return this.actor.items.get(itemElement.dataset.itemId) ?? null;
    }

    const cell = target?.closest?.("[data-inventory-cell]");
    if (!cell) return null;
    const x = toInteger(cell.dataset.x);
    const y = toInteger(cell.dataset.y);
    const placementMode = this.#getInventoryPlacementModeForParent(parentId);
    return this.#getContextInventoryItems(parentId).find(item => {
      if (item.id === sourceItemId) return false;
      const placement = normalizeInventoryPlacement(item.system?.placement ?? {}, item, this.actor.items);
      return placement.mode === placementMode && placementContainsInventoryCell(placement, x, y);
    }) ?? null;
  }

  async #moveOwnedItem(item, placement, targetItem = null, parentId = ROOT_CONTAINER_ID, sourceStackIndex = 0) {
    const detachedSlotId = placement.mode === ITEM_FUNCTIONS.constructPart
      ? ""
      : await this.#prepareConstructPartDetachment(item);
    if (detachedSlotId === null) return null;

    if (placement.mode === "inventory" || placement.mode === LOCKED_STORAGE_PLACEMENT_MODE) {
      const itemData = item.toObject();
      foundry.utils.setProperty(itemData, "system.placement.rotated", Boolean(placement.rotated));
      if (usesVirtualInventoryStacks(item)) {
        foundry.utils.setProperty(itemData, "system.quantity", getItemStackPartQuantity(item, sourceStackIndex));
      }
      const moved = await this.#insertItemIntoInventory(itemData, placement, { sourceItem: item, targetItem, parentId, sourceStackIndex });
      if (moved && detachedSlotId) await this.#completeConstructPartDetachment(detachedSlotId);
      return moved;
    }

    const placementResolution = this.#resolvePlacementWithReplacements(item.toObject(), placement, [item.id]);
    if (!placementResolution) return null;
    const { placement: resolvedPlacement, conflicts } = placementResolution;
    const spendsWeaponSwitch = resolvedPlacement.mode === "weapon";
    if (spendsWeaponSwitch && !canSpendWeaponSwitchActionPoints(this.actor)) return null;
    const storedPlacement = createStoredPlacement(resolvedPlacement, item);
    const wasEquipment = item.system?.placement?.mode === "equipment";
    const isEquipment = resolvedPlacement.mode === "equipment";
    const updateData = {
      _id: item.id,
      "system.equipped": isEquipment ? true : (wasEquipment ? false : Boolean(item.system?.equipped)),
      "system.container.parentId": ROOT_CONTAINER_ID,
      "system.placement.mode": storedPlacement.mode,
      "system.placement.equipmentSlot": storedPlacement.equipmentSlot,
      "system.placement.weaponSet": storedPlacement.weaponSet,
      "system.placement.weaponSlot": storedPlacement.weaponSlot,
      "system.placement.limbKey": storedPlacement.limbKey,
      "system.placement.constructPartOrder": storedPlacement.constructPartOrder,
      "system.placement.x": storedPlacement.x,
      "system.placement.y": storedPlacement.y,
      "system.placement.width": storedPlacement.width,
      "system.placement.height": storedPlacement.height,
      "system.placement.rotated": storedPlacement.rotated
    };
    const replacementUpdates = this.#createUnequipReplacementUpdates(conflicts, [item.id]);
    if (!replacementUpdates) return null;
    const updates = [...replacementUpdates, updateData];
    if (!this.#validateProjectedInventoryState({ updates })) return null;
    await this.actor.updateEmbeddedDocuments("Item", updates);
    if (spendsWeaponSwitch) await spendWeaponSwitchActionPoints(this.actor);
    if (detachedSlotId) await this.#completeConstructPartDetachment(detachedSlotId);
    return this.actor.items.get(item.id) ?? null;
  }

  async #installConstructPart(dropped, placement, { sourceOwned = false } = {}) {
    const slot = getConstructPartSlot(this.actor, placement?.limbKey);
    const candidate = dropped?.item ?? dropped?.itemData;
    if (!slot || !isConstructPartCompatibleWithSlot(candidate, slot)) {
      ui.notifications?.warn?.("Тип детали не совпадает с типом этого слота конструкта.");
      return null;
    }

    const current = getInstalledConstructPartForSlot(this.actor, slot.id);
    if (current) {
      if (sourceOwned && current.id === dropped?.item?.id) return current;
      ui.notifications?.warn?.("Сначала снимите установленную деталь из этого слота.");
      return null;
    }

    await ensureConstructPartSlots(this.actor);
    const sourceItem = sourceOwned ? dropped?.item : null;
    const previousSlotId = sourceItem && isInstalledConstructPartItem(sourceItem)
      ? getConstructPartSlotId(sourceItem)
      : "";
    if (previousSlotId && previousSlotId !== slot.id && !this.#canDetachConstructPart(previousSlotId)) return null;

    if (sourceOwned) {
      await this.#moveOwnedItem(sourceItem, placement, null, ROOT_CONTAINER_ID, 0);
    } else {
      await this.#createOrStackDroppedItem(dropped?.itemData, placement, null, ROOT_CONTAINER_ID);
    }

    const installed = getInstalledConstructPartForSlot(this.actor, slot.id);
    if (!installed) return null;
    const refreshedSlot = createConstructPartSlotFromItem(installed, { id: slot.id, order: slot.order });
    const slots = getConstructPartSlots(this.actor).map(entry => entry.id === slot.id ? refreshedSlot : entry);
    await this.actor.update({ "system.constructPartSlots": slots });

    if (previousSlotId && previousSlotId !== slot.id) {
      await this.#completeConstructPartDetachment(previousSlotId);
    }
    const limbKey = getConstructPartLimbKey(slot.id);
    if (isLimbDestroyed(this.actor, limbKey)) {
      await applyDestroyedLimbConsequences(this.actor, [limbKey], { ignoreInstalledProsthesis: true });
    } else {
      await clearLimbLossState(this.actor, limbKey);
    }
    return getInstalledConstructPartForSlot(this.actor, slot.id);
  }

  async #prepareConstructPartDetachment(item) {
    if (!isInstalledConstructPartItem(item)) return "";
    const slotId = getConstructPartSlotId(item);
    if (!slotId || !this.#canDetachConstructPart(slotId)) return null;
    await ensureConstructPartSlots(this.actor);
    return slotId;
  }

  #canDetachConstructPart(slotId = "") {
    const occupied = this.actor.items?.contents?.some(item => (
      String(item.system?.placement?.mode ?? "") === "weapon"
      && String(item.system?.placement?.weaponSet ?? "").startsWith(`container:constructPart:${slotId}:`)
    ));
    if (!occupied) return true;
    ui.notifications?.warn?.("Сначала снимите оружие, установленное в слоты этой детали конструкта.");
    return false;
  }

  async #completeConstructPartDetachment(slotId = "") {
    const limbKey = getConstructPartLimbKey(slotId);
    if (!limbKey || getInstalledConstructPartForSlot(this.actor, slotId)) return;
    await applyDestroyedLimbConsequences(this.actor, [limbKey], { ignoreInstalledProsthesis: true });
  }

  #canStackDroppedItem(itemData, targetItem = null) {
    return Boolean(
      targetItem
      && this.#areStackable(itemData, targetItem)
      && (usesVirtualInventoryStacks(targetItem) || getItemQuantity(targetItem) < getItemMaxStack(targetItem))
    );
  }

  async #getDroppedStackQuantity(dropped, targetItem, _event, { targetStackIndex = null } = {}) {
    const sourceQuantity = Math.max(1, getItemQuantity(
      usesVirtualInventoryStacks(dropped?.item) ? dropped?.itemData : (dropped?.item ?? dropped?.itemData)
    ));
    const availableSpace = usesVirtualInventoryStacks(targetItem)
      ? Math.max(0, getItemMaxStack(targetItem) - getItemStackPartQuantity(targetItem, targetStackIndex))
      : Math.max(0, getItemMaxStack(targetItem) - getItemQuantity(targetItem));
    const maxTransfer = Math.min(sourceQuantity, availableSpace);
    return maxTransfer > 0 ? maxTransfer : 0;
  }

  async #stackDroppedItemQuantity(sourceItem, itemData, targetItem, quantity, sourceStackIndex = 0, targetStackIndex = null) {
    const transferQuantity = Math.max(1, toInteger(quantity));
    const sourceOwned = sourceItem?.parent === this.actor;
    const sourceQuantity = Math.max(1, getItemQuantity(usesVirtualInventoryStacks(itemData) ? itemData : (sourceOwned ? sourceItem : itemData)));
    const targetQuantity = getItemQuantity(targetItem);
    const availableSpace = usesVirtualInventoryStacks(targetItem)
      ? Number.POSITIVE_INFINITY
      : Math.max(0, getItemMaxStack(targetItem) - targetQuantity);
    const appliedQuantity = Math.min(transferQuantity, sourceQuantity, availableSpace);
    if (!appliedQuantity) return null;

    const updates = [
      usesVirtualInventoryStacks(targetItem)
        ? createItemStackPartAdditionUpdate(targetItem, appliedQuantity, targetStackIndex)
        : {
          _id: targetItem.id,
          "system.quantity": targetQuantity + appliedQuantity
        }
    ].filter(Boolean);
    const deletes = [];
    if (sourceOwned) {
      if (usesVirtualInventoryStacks(sourceItem)) {
        const sourceUpdate = createItemStackPartRemovalUpdate(sourceItem, appliedQuantity, sourceStackIndex);
        if ((sourceUpdate?.["system.quantity"] ?? sourceQuantity) <= 0) deletes.push(sourceItem.id);
        else if (sourceUpdate) updates.push(sourceUpdate);
      } else if (appliedQuantity >= sourceQuantity) deletes.push(sourceItem.id);
      else {
        updates.push({
          _id: sourceItem.id,
          "system.quantity": sourceQuantity - appliedQuantity
        });
      }
    }

    if (!this.#validateProjectedInventoryState({ updates, deletes })) return null;
    await this.actor.updateEmbeddedDocuments("Item", updates);
    if (deletes.length) await this.actor.deleteEmbeddedDocuments("Item", deletes);
    return this.actor.items.get(targetItem.id) ?? null;
  }

  async #getExternalDroppedInventoryItemData(itemData) {
    if (getItemMaxStack(itemData) <= 1) return itemData;
    const quantity = await promptItemStackQuantity({
      item: itemData,
      title: game.i18n.localize("FALLOUTMAW.Item.Quantity"),
      actionLabel: game.i18n.localize("FALLOUTMAW.Common.Create"),
      max: null,
      value: Math.max(1, getItemQuantity(itemData))
    });
    if (!quantity) return null;

    const createData = foundry.utils.deepClone(itemData);
    foundry.utils.setProperty(createData, "system.quantity", quantity);
    return createData;
  }

  async #createOrStackDroppedItem(itemData, placement, targetItem = null, parentId = ROOT_CONTAINER_ID) {
    if (!itemData) return null;
    if (placement.mode === "inventory" || placement.mode === LOCKED_STORAGE_PLACEMENT_MODE) {
      return this.#insertItemIntoInventory(itemData, placement, { targetItem, parentId });
    }

    const placementResolution = this.#resolvePlacementWithReplacements(itemData, placement);
    if (!placementResolution) return null;
    const { placement: resolvedPlacement, conflicts } = placementResolution;
    const spendsWeaponSwitch = resolvedPlacement.mode === "weapon";
    if (spendsWeaponSwitch && !canSpendWeaponSwitchActionPoints(this.actor)) return null;
    const storedPlacement = createStoredPlacement(resolvedPlacement, itemData);

    const createData = foundry.utils.deepClone(itemData);
    delete createData._id;
    delete createData.id;
    foundry.utils.mergeObject(createData, {
      system: {
        equipped: resolvedPlacement.mode === "equipment",
        container: {
          parentId: ROOT_CONTAINER_ID
        },
        placement: {
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
        }
      }
    });
    const replacementUpdates = this.#createUnequipReplacementUpdates(conflicts);
    if (!replacementUpdates) return null;
    if (!this.#validateProjectedInventoryState({ updates: replacementUpdates, creates: [createData] })) return null;
    if (replacementUpdates.length) await this.actor.updateEmbeddedDocuments("Item", replacementUpdates);
    const created = await this.actor.createEmbeddedDocuments("Item", [createData]);
    if (spendsWeaponSwitch) await spendWeaponSwitchActionPoints(this.actor);
    return created;
  }

  async #insertItemIntoInventory(itemData, requestedPlacement, { sourceItem = null, targetItem = null, parentId = ROOT_CONTAINER_ID, sourceStackIndex = 0 } = {}) {
    if (usesVirtualInventoryStacks(itemData)) {
      return this.#insertVirtualStackItemIntoInventory(itemData, requestedPlacement, { sourceItem, targetItem, parentId, sourceStackIndex });
    }

    const maxStack = getItemMaxStack(itemData);
    let remainingQuantity = Math.max(1, getItemQuantity(itemData));
    const excludedIds = [sourceItem?.id ?? ""].filter(Boolean);
    const storedParentId = this.#getStoredInventoryParentId(parentId);
    const preferredPlacement = this.#createContextInventoryPlacement(
      normalizeInventoryPlacement(requestedPlacement, itemData, this.actor.items),
      parentId
    );
    const stackTargets = this.#getCompatibleStackTarget(itemData, targetItem, excludedIds, parentId);
    const targetUpdates = [];

    for (const stackTarget of stackTargets) {
      const availableSpace = Math.max(0, getItemMaxStack(stackTarget) - getItemQuantity(stackTarget));
      if (!availableSpace) continue;

      const transferredQuantity = Math.min(remainingQuantity, availableSpace);
      if (!transferredQuantity) continue;

      targetUpdates.push({
        _id: stackTarget.id,
        "system.quantity": getItemQuantity(stackTarget) + transferredQuantity
      });
      remainingQuantity -= transferredQuantity;
      if (!remainingQuantity) break;
    }

    const reservedPlacements = [];
    const createData = [];
    let sourceUpdate = null;
    let deleteSource = Boolean(sourceItem);

    if (sourceItem && remainingQuantity > 0) {
      const sourcePlacement = this.#getSourceInventoryPlacement(
        sourceItem,
        itemData,
        parentId,
        targetItem ? null : preferredPlacement,
        targetItem,
        reservedPlacements
      );
      if (!sourcePlacement) {
        this.#warnInventoryNoSpace();
        return null;
      }

      const sourceQuantity = Math.min(remainingQuantity, maxStack);
      remainingQuantity -= sourceQuantity;
      reservedPlacements.push(sourcePlacement);
      const storedPlacement = createStoredPlacement(sourcePlacement, sourceItem);
      sourceUpdate = {
        _id: sourceItem.id,
        "system.quantity": sourceQuantity,
        "system.equipped": false,
        ...(this.#isLockedStorageParentId(parentId) ? { "system.locked": true } : {}),
        "system.container.parentId": storedParentId,
        "system.placement.mode": storedPlacement.mode,
        "system.placement.equipmentSlot": storedPlacement.equipmentSlot,
        "system.placement.weaponSet": storedPlacement.weaponSet,
        "system.placement.weaponSlot": storedPlacement.weaponSlot,
        "system.placement.limbKey": storedPlacement.limbKey,
        "system.placement.x": storedPlacement.x,
        "system.placement.y": storedPlacement.y,
        "system.placement.width": storedPlacement.width,
        "system.placement.height": storedPlacement.height,
        "system.placement.rotated": storedPlacement.rotated
      };
      deleteSource = false;
    }

    let nextPlacement = this.#isInventoryPlacementAvailable(preferredPlacement, excludedIds, reservedPlacements, parentId)
      ? preferredPlacement
      : null;
    while (remainingQuantity > 0) {
      const stackQuantity = Math.min(remainingQuantity, maxStack);
      const placement = nextPlacement ?? this.#getFirstAvailableInventoryPlacement(itemData, excludedIds, reservedPlacements, parentId);
      if (!placement) {
        this.#warnInventoryNoSpace();
        return null;
      }

      createData.push(this.#createInventoryStackData(itemData, stackQuantity, placement, parentId));
      reservedPlacements.push(placement);
      remainingQuantity -= stackQuantity;
      nextPlacement = null;
    }

    if (!this.#validateProjectedInventoryState({
      updates: [...targetUpdates, ...(sourceUpdate ? [sourceUpdate] : [])],
      deletes: (!sourceUpdate && deleteSource && sourceItem) ? [sourceItem.id] : [],
      creates: createData
    })) return null;

    if (targetUpdates.length) await this.actor.updateEmbeddedDocuments("Item", targetUpdates);
    if (sourceUpdate) await this.actor.updateEmbeddedDocuments("Item", [sourceUpdate]);
    else if (deleteSource && sourceItem) await this.actor.deleteEmbeddedDocuments("Item", [sourceItem.id]);
    if (createData.length) return this.actor.createEmbeddedDocuments("Item", createData);
    if (sourceUpdate) return this.actor.items.get(sourceItem.id) ?? null;
    if (targetUpdates.length) return this.actor.items.get(targetUpdates[0]._id) ?? null;
    return null;
  }

  async #insertVirtualStackItemIntoInventory(itemData, requestedPlacement, {
    sourceItem = null,
    targetItem = null,
    parentId = ROOT_CONTAINER_ID,
    sourceStackIndex = 0
  } = {}) {
    const quantity = Math.max(1, getItemQuantity(itemData));
    const storedParentId = this.#getStoredInventoryParentId(parentId);
    const preferredPlacement = this.#createContextInventoryPlacement(
      normalizeInventoryPlacement(requestedPlacement, itemData, this.actor.items),
      parentId
    );

    if (
      sourceItem
      && (!targetItem || sourceItem.id === targetItem.id)
      && getItemContainerParentId(sourceItem) === storedParentId
      && sourceItem.system?.placement?.mode === this.#getInventoryPlacementModeForParent(parentId)
    ) {
      const placementUpdate = createItemStackPartPlacementUpdate(sourceItem, sourceStackIndex, preferredPlacement);
      if (!placementUpdate || !this.#validateProjectedInventoryState({ updates: [placementUpdate] })) return null;
      await this.actor.updateEmbeddedDocuments("Item", [placementUpdate]);
      return this.actor.items.get(sourceItem.id) ?? null;
    }

    const excludedIds = [sourceItem?.id ?? ""].filter(Boolean);
    const target = this.#getCompatibleVirtualStackTarget(itemData, targetItem, excludedIds, parentId);
    const { columns, rows } = this.#getInventoryGridDimensions(parentId);
    const overflowQuantity = target ? getItemStackAdditionOverflowQuantity(target, quantity) : quantity;
    const stackParts = createAnchoredItemStackPartsForQuantity({
      itemData,
      quantity: overflowQuantity,
      preferredPlacement,
      contextItems: this.#getContextInventoryItems(parentId),
      columns,
      rows,
      allItems: this.actor.items,
      excludeItemIds: excludedIds,
      options: this.#getInventoryGridOptions(parentId)
    });
    if (!stackParts) {
      this.#warnInventoryNoSpace();
      return null;
    }
    const updates = [];
    const creates = [];
    const deletes = [];

    if (target) {
      const additionUpdate = createItemStackPartAdditionUpdate(target, quantity, null, stackParts);
      if (additionUpdate) updates.push(additionUpdate);
    } else {
      const createData = foundry.utils.deepClone(itemData);
      delete createData._id;
      delete createData.id;
      const storedPlacement = createStoredPlacement(preferredPlacement, itemData);
      const primaryPart = stackParts[0] ?? null;
      foundry.utils.mergeObject(createData, {
        system: {
          quantity,
          stackParts,
          equipped: false,
          ...(this.#isLockedStorageParentId(parentId) ? { locked: true } : {}),
          container: {
            parentId: storedParentId
          },
          placement: {
            mode: storedPlacement.mode,
            equipmentSlot: storedPlacement.equipmentSlot,
            weaponSet: storedPlacement.weaponSet,
            weaponSlot: storedPlacement.weaponSlot,
            limbKey: storedPlacement.limbKey,
            x: primaryPart?.x ?? storedPlacement.x,
            y: primaryPart?.y ?? storedPlacement.y,
            width: storedPlacement.width,
            height: storedPlacement.height,
            rotated: primaryPart?.rotated ?? storedPlacement.rotated
          }
        }
      });
      creates.push(createData);
    }

    if (sourceItem) {
      const sourceQuantity = getItemQuantity(sourceItem);
      const removalUpdate = createItemStackPartRemovalUpdate(sourceItem, quantity, sourceStackIndex);
      if ((removalUpdate?.["system.quantity"] ?? sourceQuantity) <= 0) deletes.push(sourceItem.id);
      else if (removalUpdate) updates.push(removalUpdate);
    }

    if (!this.#validateProjectedInventoryState({ updates, deletes, creates })) return null;
    if (updates.length) await this.actor.updateEmbeddedDocuments("Item", updates);
    if (deletes.length) await this.actor.deleteEmbeddedDocuments("Item", deletes);
    if (creates.length) return this.actor.createEmbeddedDocuments("Item", creates);
    return target ? this.actor.items.get(target.id) ?? null : null;
  }

  #getCompatibleStackTarget(itemData, preferredTarget = null, excludeItemIds = [], parentId = ROOT_CONTAINER_ID) {
    const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
    const storedParentId = this.#getStoredInventoryParentId(parentId);
    const placementMode = this.#getInventoryPlacementModeForParent(parentId);
    const canUsePreferredTarget = preferredTarget
      && !excluded.has(preferredTarget.id)
      && (getItemContainerParentId(preferredTarget) === storedParentId)
      && preferredTarget.system?.placement?.mode === placementMode
      && this.#areStackable(itemData, preferredTarget)
      && (getItemQuantity(preferredTarget) < getItemMaxStack(preferredTarget));
    return canUsePreferredTarget ? [preferredTarget] : [];
  }

  #getCompatibleVirtualStackTarget(itemData, preferredTarget = null, excludeItemIds = [], parentId = ROOT_CONTAINER_ID) {
    const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
    const storedParentId = this.#getStoredInventoryParentId(parentId);
    const placementMode = this.#getInventoryPlacementModeForParent(parentId);
    const candidates = [];
    if (preferredTarget) candidates.push(preferredTarget);
    candidates.push(...this.#getContextInventoryItems(parentId));
    return candidates.find(candidate => (
      candidate
      && !excluded.has(candidate.id)
      && usesVirtualInventoryStacks(candidate)
      && getItemContainerParentId(candidate) === storedParentId
      && candidate.system?.placement?.mode === placementMode
      && this.#areStackable(itemData, candidate)
    )) ?? null;
  }

  #getSourceInventoryPlacement(
    sourceItem,
    itemData,
    parentId = ROOT_CONTAINER_ID,
    preferredPlacement = null,
    targetItem = null,
    reservedPlacements = []
  ) {
    const excludedIds = [sourceItem.id, targetItem?.id ?? ""].filter(Boolean);
    const storedParentId = this.#getStoredInventoryParentId(parentId);
    const placementMode = this.#getInventoryPlacementModeForParent(parentId);
    const currentPlacement = (
      sourceItem.system?.placement?.mode === placementMode
      && (getItemContainerParentId(sourceItem) === storedParentId)
    )
      ? normalizeInventoryPlacement(sourceItem.system?.placement ?? {}, itemData, this.actor.items)
      : null;

    if (targetItem && currentPlacement && this.#isInventoryPlacementAvailable(currentPlacement, excludedIds, reservedPlacements, parentId)) {
      return currentPlacement;
    }
    if (preferredPlacement && this.#isInventoryPlacementAvailable(preferredPlacement, excludedIds, reservedPlacements, parentId)) {
      return preferredPlacement;
    }
    if (currentPlacement && this.#isInventoryPlacementAvailable(currentPlacement, excludedIds, reservedPlacements, parentId)) {
      return currentPlacement;
    }
    const placement = this.#getFirstAvailableInventoryPlacement(itemData, excludedIds, reservedPlacements, parentId);
    return placement ? this.#createContextInventoryPlacement(placement, parentId) : null;
  }

  #createInventoryStackData(itemData, quantity, placement, parentId = ROOT_CONTAINER_ID) {
    const createData = foundry.utils.deepClone(itemData);
    delete createData._id;
    delete createData.id;
    const storedPlacement = createStoredPlacement(this.#createContextInventoryPlacement(placement, parentId), itemData);
    foundry.utils.mergeObject(createData, {
      system: {
        quantity,
        equipped: false,
        ...(this.#isLockedStorageParentId(parentId) ? { locked: true } : {}),
        container: {
          parentId: this.#getStoredInventoryParentId(parentId)
        },
        placement: {
          mode: storedPlacement.mode,
          equipmentSlot: storedPlacement.equipmentSlot,
          weaponSet: storedPlacement.weaponSet,
          weaponSlot: storedPlacement.weaponSlot,
          limbKey: storedPlacement.limbKey,
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

  #validateProjectedInventoryState({ updates = [], deletes = [], creates = [] } = {}) {
    const projectedItems = this.#projectInventoryState({ updates, deletes, creates });
    const validation = validateInventoryTree(projectedItems, getInventoryGridDimensions(this.#getCurrentRace(), this.actor), {
      rootOptions: this.#getInventoryGridOptions(ROOT_CONTAINER_ID)
    });
    if (validation.valid) {
      const loadValidation = validateActorLoadLimit(this.actor, projectedItems);
      if (loadValidation.valid) return true;
      this.#warnInventoryValidation(loadValidation);
      return false;
    }
    this.#warnInventoryValidation(validation);
    return false;
  }

  async #repairInventoryTreePlacements() {
    const repairUpdates = createInventoryTreePlacementRepairUpdates(
      this.actor.items.contents,
      getInventoryGridDimensions(this.#getCurrentRace(), this.actor),
      {
        rootOptions: this.#getInventoryGridOptions(ROOT_CONTAINER_ID)
      }
    );
    const projectedItems = repairUpdates
      ? this.#projectInventoryState({ updates: repairUpdates })
      : [];
    const validation = repairUpdates
      ? validateInventoryTree(projectedItems, getInventoryGridDimensions(this.#getCurrentRace(), this.actor), {
        rootOptions: this.#getInventoryGridOptions(ROOT_CONTAINER_ID)
      })
      : { valid: false, reason: "placement-repair" };
    if (!Array.isArray(repairUpdates)) {
      this.#warnInventoryValidation(validation);
      return false;
    }
    if (!validation.valid) {
      this.#warnInventoryValidation(validation);
      return false;
    }
    if (!repairUpdates.length) return true;
    await this.actor.updateEmbeddedDocuments("Item", repairUpdates);
    return true;
  }

  #projectInventoryState({ updates = [], deletes = [], creates = [] } = {}) {
    const itemMap = new Map(this.actor.items.contents.map(item => [item.id, item.toObject()]));

    for (const update of updates) {
      if (!update?._id || !itemMap.has(update._id)) continue;
      const nextData = foundry.utils.deepClone(itemMap.get(update._id));
      for (const [key, value] of Object.entries(update)) {
        if (key === "_id") continue;
        foundry.utils.setProperty(nextData, key, value);
      }
      itemMap.set(update._id, nextData);
    }

    for (const deleteId of deletes) {
      itemMap.delete(deleteId);
    }

    let syntheticIndex = 0;
    for (const createData of creates) {
      const syntheticId = String(createData?._id ?? `synthetic-${syntheticIndex += 1}`);
      const nextData = foundry.utils.deepClone(createData);
      nextData._id = syntheticId;
      nextData.id = syntheticId;
      itemMap.set(syntheticId, nextData);
    }

    return Array.from(itemMap.values());
  }

  #warnInventoryValidation(validation) {
    if (validation?.reason === "recursive") {
      ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Messages.ContainerRecursiveError"));
      return;
    }
    if (validation?.reason === "max-load") {
      ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Messages.ContainerMaxLoadExceeded"));
      return;
    }
    if (validation?.reason === "actor-load-limit") {
      ui.notifications.warn(getActorLoadLimitExceededMessage());
      return;
    }
    this.#warnInventoryNoSpace();
  }

  #resolvePlacement(itemData, placement, excludeItemIds = [], reservedPlacements = [], parentId = ROOT_CONTAINER_ID, options = {}) {
    if (placement.mode === "inventory") {
      return this.#resolveInventoryPlacement(itemData, placement, excludeItemIds, reservedPlacements, parentId);
    }
    if (placement.mode === "equipment") {
      return this.#resolveEquipmentPlacement(itemData, placement, excludeItemIds, options);
    }
    if (placement.mode === "weapon") {
      return this.#resolveWeaponPlacement(itemData, placement, excludeItemIds, options);
    }

    const footprint = getItemFootprint(itemData);
    return {
      ...placement,
      width: footprint.width,
      height: footprint.height
    };
  }

  #resolvePlacementWithReplacements(itemData, placement, excludeItemIds = [], reservedPlacements = [], parentId = ROOT_CONTAINER_ID) {
    const resolvedPlacement = this.#resolvePlacement(itemData, placement, excludeItemIds, reservedPlacements, parentId, {
      allowReplacement: true
    });
    if (!resolvedPlacement) return null;
    return {
      placement: resolvedPlacement,
      conflicts: this.#getPlacementConflictingItems(itemData, resolvedPlacement, excludeItemIds)
    };
  }

  #resolveWeaponPlacement(itemData, placement, excludeItemIds = [], { allowReplacement = false } = {}) {
    if (placement.mode !== "weapon") return placement;

    const requiredSlotKeys = this.#getWeaponPlacementSlotKeys(itemData, placement);
    if (!requiredSlotKeys.length) return null;

    const blocked = requiredSlotKeys.some(slotKey => Boolean(this.#getWeaponItemForSlot(
      placement.weaponSet,
      slotKey,
      excludeItemIds
    )));
    if (blocked && !allowReplacement) return null;

    const footprint = getItemFootprint(itemData);
    return {
      ...placement,
      width: footprint.width,
      height: footprint.height
    };
  }

  #getWeaponPlacementSlotKeys(itemData, placement = {}) {
    const race = this.#getCurrentRace();
    const setKey = String(placement.weaponSet ?? "");
    const primarySlotKey = String(placement.weaponSlot ?? "");
    if (!setKey || !primarySlotKey) return [];
    const requirement = getWeaponSlotRequirement(itemData);
    if (!requirement.selectedKeys.size) return [];

    if (isContainerWeaponSetKey(setKey)) {
      const inventory = prepareDisplayInventoryContext(this.actor, race);
      const set = (inventory.weaponSets ?? []).find(entry => entry.key === setKey);
      const slots = set?.slots ?? [];
      const primaryIndex = slots.findIndex(slot => slot.key === primarySlotKey);
      if (primaryIndex < 0) return [];
      const size = getWeaponSlotRequirementSize(itemData, race);
      const requiredSlots = slots.slice(primaryIndex, primaryIndex + size);
      return requiredSlots.length === size ? requiredSlots.map(slot => slot.key) : [];
    }

    if (!canUseWeaponSlotForItem(race, itemData, setKey, primarySlotKey)) return [];
    return getRequiredWeaponSlotsForItem(race, itemData, setKey, primarySlotKey).map(slot => slot.key);
  }

  #resolveInventoryPlacement(itemData, placement, excludeItemIds = [], reservedPlacements = [], parentId = ROOT_CONTAINER_ID) {
    const normalizedPlacement = normalizeInventoryPlacement(placement, itemData, this.actor.items);
    return this.#isInventoryPlacementAvailable(normalizedPlacement, excludeItemIds, reservedPlacements, parentId)
      ? normalizedPlacement
      : null;
  }

  #resolveEquipmentPlacement(itemData, placement, excludeItemIds = [], { allowReplacement = false } = {}) {
    if (placement.mode !== "equipment") return placement;

    const race = this.#getCurrentRace();
    const selectedSlots = getRaceEquipmentSlotsForItem(race, itemData);
    const targetSlot = placement.equipmentSlot
      ? selectedSlots.find(slot => slot.key === placement.equipmentSlot)
      : selectedSlots[0];
    if (!targetSlot) return null;

    const requiredSlots = getRequiredEquipmentSlotsForItem(race, itemData, targetSlot.key);
    if (!requiredSlots.length) return null;
    const blocked = requiredSlots.some(slot => Boolean(this.#getEquipmentItemForSlot(slot, excludeItemIds)));
    if (blocked && !allowReplacement) return null;

    const footprint = getItemFootprint(itemData);
    return {
      ...placement,
      equipmentSlot: targetSlot.key,
      width: footprint.width,
      height: footprint.height
    };
  }

  #getPlacementConflictingItems(itemData, placement = {}, excludeItemIds = []) {
    if (placement.mode === "equipment") return this.#getEquipmentConflictingItems(itemData, placement, excludeItemIds);
    if (placement.mode === "weapon") return this.#getWeaponConflictingItems(itemData, placement, excludeItemIds);
    return [];
  }

  #getEquipmentConflictingItems(itemData, placement = {}, excludeItemIds = []) {
    const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
    const race = this.#getCurrentRace();
    const targetSlots = getRequiredEquipmentSlotsForItem(race, itemData, placement.equipmentSlot);
    if (!targetSlots.length) return [];

    return this.actor.items.contents.filter(item => {
      if (excluded.has(item.id)) return false;
      if (item.system?.placement?.mode !== "equipment") return false;
      return targetSlots.some(slot => doesItemOccupyEquipmentSlot(item, slot));
    });
  }

  async _processSubmitData(event, form, submitData, options = {}) {
    syncActorTokenIdentity(this.actor, submitData);
    return super._processSubmitData(event, form, submitData, options);
  }

  _onChangeForm(formConfig, event) {
    if (event?.target?.closest?.("[data-actor-name-input]")) return undefined;
    return super._onChangeForm(formConfig, event);
  }

  #getWeaponConflictingItems(itemData, placement = {}, excludeItemIds = []) {
    const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
    const conflicts = new Map();
    for (const slotKey of this.#getWeaponPlacementSlotKeys(itemData, placement)) {
      const item = this.#getWeaponItemForSlot(placement.weaponSet, slotKey, excludeItemIds);
      if (!item || excluded.has(item.id)) continue;
      conflicts.set(item.id, item);
    }
    return Array.from(conflicts.values());
  }

  #createUnequipReplacementUpdates(items = [], excludeItemIds = []) {
    const conflicts = Array.from(new Map(items.filter(Boolean).map(item => [item.id, item])).values());
    if (!conflicts.length) return [];

    const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
    for (const item of conflicts) excluded.add(item.id);

    const reservedPlacements = [];
    const updates = [];
    for (const item of conflicts) {
      const placementContext = this.#getFirstAvailableInventoryPlacementContext(item, Array.from(excluded), reservedPlacements);
      if (!placementContext) {
        this.#warnInventoryNoSpace();
        return null;
      }
      reservedPlacements.push({ ...placementContext, itemData: item });
      updates.push(this.#createInventoryPlacementUpdate(item, placementContext));
    }
    return updates;
  }

  #getEquipmentItemForSlot(slot, excludeItemIds = []) {
    const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
    return this.actor.items.contents.find(item => {
      if (excluded.has(item.id)) return false;
      if (item.system?.placement?.mode !== "equipment") return false;
      return doesItemOccupyEquipmentSlot(item, slot);
    }) ?? null;
  }

  #getWeaponItemForSlot(setKey = "", slotKey = "", excludeItemIds = []) {
    const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
    const inventory = prepareDisplayInventoryContext(this.actor, this.#getCurrentRace());
    const set = (inventory.weaponSets ?? []).find(entry => entry.key === setKey);
    const slot = (set?.slots ?? []).find(entry => entry.key === slotKey);
    const itemId = String(slot?.item?.id ?? "");
    return itemId && !excluded.has(itemId) ? this.actor.items.get(itemId) ?? null : null;
  }

  #getCurrentRace() {
    return getCreatureOptions().races.find(entry => entry.id === this.actor.system?.creature?.raceId) ?? null;
  }

  #areStackable(sourceData, targetItem) {
    const sourceSystem = sourceData?.system ?? {};
    const targetSystem = targetItem?.system ?? {};
    const creatureOptions = getCreatureOptions();
    return (
      sourceData?.type === targetItem?.type
      && !isContainerItem(sourceData)
      && !isContainerItem(targetItem)
      && sourceData?.name === targetItem?.name
      && sourceData?.img === targetItem?.img
      && Number(sourceSystem.weight) === Number(targetSystem.weight)
      && Number(sourceSystem.price) === Number(targetSystem.price)
      && String(sourceSystem.priceCurrency ?? "") === String(targetSystem.priceCurrency ?? "")
      && getItemMaxStack(sourceSystem) === getItemMaxStack(targetSystem)
      && getItemFootprint(sourceSystem).width === getItemFootprint(targetSystem).width
      && getItemFootprint(sourceSystem).height === getItemFootprint(targetSystem).height
      && serializeSet(getValidSelectedEquipmentSlotKeysForOptions(creatureOptions, sourceSystem)) === serializeSet(getValidSelectedEquipmentSlotKeysForOptions(creatureOptions, targetSystem))
      && serializeWeaponSlotRequirement(sourceSystem, creatureOptions) === serializeWeaponSlotRequirement(targetSystem, creatureOptions)
      && serializeItemFunctions(sourceSystem.functions) === serializeItemFunctions(targetSystem.functions)
    );
  }

  #canEquipInventoryItem(item) {
    if (!item) return false;
    const race = this.#getCurrentRace();
    if (getRaceEquipmentSlotsForItem(race, item).length) return true;
    return Boolean(this.#findAutoWeaponPlacement(item.toObject(), [item.id], { allowReplacement: true }));
  }

  #findAutoWeaponPlacement(itemData, excludeItemIds = [], { allowReplacement = false } = {}) {
    if (!this.#isWeaponSlotItem(itemData)) return null;
    const inventory = prepareDisplayInventoryContext(this.actor, this.#getCurrentRace());
    const candidates = [];
    for (const set of inventory.weaponSets ?? []) {
      for (const slot of set.slots ?? []) {
        candidates.push({
          mode: "weapon",
          equipmentSlot: "",
          weaponSet: set.key,
          weaponSlot: slot.key,
          x: 1,
          y: 1
        });
      }
    }

    for (const placement of candidates) {
      const resolvedPlacement = this.#resolvePlacement(itemData, placement, excludeItemIds);
      if (!resolvedPlacement) continue;
      return {
        placement: resolvedPlacement,
        conflicts: []
      };
    }
    if (!allowReplacement) return null;

    for (const placement of candidates) {
      const resolution = this.#resolvePlacementWithReplacements(itemData, placement, excludeItemIds);
      if (resolution) return resolution;
    }
    return null;
  }

  #isWeaponSlotItem(itemData) {
    return Boolean(getWeaponSlotRequirement(itemData).selectedKeys.size);
  }

  async #showInventoryContextMenu(item, event, { stackIndex = 0, stackQuantity = 0 } = {}) {
    this.#clearInventoryTooltip({ force: true });
    this.#closeInventoryContextMenu();
    this.#inventoryContextMenuOpen = true;
    if (isNaturalRaceWeapon(item)) return this.#showNaturalWeaponContextMenu(item, event);
    const isAbility = item.type === "ability";
    const placementMode = String(item.system?.placement?.mode ?? "");
    const isSlottedEquipment = placementMode === "equipment";
    const isSlottedWeapon = placementMode === "weapon";
    const isSlottedConstructPart = isInstalledConstructPartItem(item);
    const isSlottedItem = isSlottedEquipment || isSlottedWeapon || isSlottedConstructPart;
    const isEquipped = Boolean(item.system?.equipped);
    const isContainer = isContainerItem(item);
    const canEquip = this.#canEquipInventoryItem(item);
    const canRotate = canShowInventoryRotateAction(item);
    const rotationResolution = canRotate ? this.#resolveInventoryRotation(item) : null;
    const rotateUnavailableLabel = getInventoryRotationUnavailableLabel();
    const menu = document.createElement("nav");
    menu.className = "fallout-maw-inventory-context-menu";
    menu.dataset.pointerX = String(event.clientX);
    menu.dataset.pointerY = String(event.clientY);
    this.#applyOverlayUiScale(menu);
    const menuOptions = [];
    if (game.user?.isGM) {
      menuOptions.push(["edit", "fa-pen-to-square", game.i18n.localize("FALLOUTMAW.Common.Edit")]);
    }
    if (isAbility) {
      if (game.user?.isGM) {
        menuOptions.push(["delete", "fa-trash", game.i18n.localize("FALLOUTMAW.Common.Delete")]);
      }
      menu.innerHTML = menuOptions
        .map(([action, icon, label]) => `<button type="button" data-action="${action}"><i class="fa-solid ${icon}"></i>${label}</button>`)
        .join("");
      document.body.append(menu);
      this.#syncInventoryOverlayLayer({ bringToFront: true });
      this.#positionOverlayAtPointer(menu, { x: event.clientX, y: event.clientY }, 8);

      menu.addEventListener("click", clickEvent => {
        const action = clickEvent.target.closest("button")?.dataset.action;
        if (!action) return;
        clickEvent.preventDefault();
        this.#closeInventoryContextMenu();
        if (action === "edit" && game.user?.isGM) return item.sheet?.render(true);
        if (action === "delete" && game.user?.isGM) return item.delete();
        return undefined;
      });
      return;
    }
    const { getCraftWindowOpenOptionsForItem, openCraftWindow } = await import("../apps/craft-window.mjs");
    const craftOpenOptions = await getCraftWindowOpenOptionsForItem(item);
    if (isContainer) {
      menuOptions.push(["open", "fa-box-open", game.i18n.localize("FALLOUTMAW.Item.Open")]);
    }
    for (const [index, option] of craftOpenOptions.entries()) {
      menuOptions.push([`craft-open-${index}`, option.icon, option.label]);
    }
    const interactionState = getItemInteractionState(this.actor, item, { token: resolveActorInteractionToken(this.actor) });
    if (interactionState.hasInteraction) {
      menuOptions.push(["interact", "fa-hand-pointer", "Взаимодействие"]);
    }
    if (canUseActiveItem(item)) {
      menuOptions.push(["use", "fa-play", "Применить"]);
    }
    if (canRotate) {
      menuOptions.push(["rotate", "fa-rotate", game.i18n.localize("FALLOUTMAW.Item.Rotate"), !rotationResolution, rotationResolution ? "" : rotateUnavailableLabel]);
    }
    if (isSlottedItem || isEquipped) {
      menuOptions.push(["unequip", "fa-hand", game.i18n.localize("FALLOUTMAW.Item.Unequip")]);
    } else if (canEquip) {
      menuOptions.push(["equip", "fa-shirt", game.i18n.localize("FALLOUTMAW.Item.Equip")]);
    }
    if (getItemQuantity(item) > 1) {
      menuOptions.push(["split", "fa-code-branch", "Разделить"]);
    }
    menuOptions.push(["drop", "fa-arrow-down", "Выбросить"]);
    if (game.user?.isGM && !isSlottedItem) {
      menuOptions.push(["copy", "fa-copy", game.i18n.localize("FALLOUTMAW.Common.Copy")]);
    }
    if (game.user?.isGM) {
      menuOptions.push(["delete", "fa-trash", game.i18n.localize("FALLOUTMAW.Common.Delete")]);
    }
    menu.innerHTML = menuOptions
      .map(([action, icon, label, disabled = false, title = ""]) => `<button type="button" data-action="${action}"${disabled ? " disabled" : ""}${title ? ` title="${escapeAttribute(title)}"` : ""}><i class="fa-solid ${icon}"></i>${label}</button>`)
      .join("");
    document.body.append(menu);
    this.#syncInventoryOverlayLayer({ bringToFront: true });
    this.#positionOverlayAtPointer(menu, { x: event.clientX, y: event.clientY }, 8);

    menu.addEventListener("click", async clickEvent => {
      const action = clickEvent.target.closest("button")?.dataset.action;
      if (!action) return;
      clickEvent.preventDefault();
      this.#closeInventoryContextMenu();
      if (action === "edit" && game.user?.isGM) return item.sheet?.render(true);
      if (action === "open") return this.#openContainerSheet(item);
      if (action.startsWith("craft-open-")) {
        const option = craftOpenOptions[toInteger(action.slice("craft-open-".length))];
        if (!option) return undefined;
        return openCraftWindow({ actor: this.actor, selection: option });
      }
      if (action === "interact") return openItemInteractionDialog({ actor: this.actor, item, application: this });
      if (action === "use") return useActiveItem({ actor: this.actor, item, application: this });
      if (action === "rotate") return this.#rotateInventoryItem(item);
      if (action === "equip") return this.#equipInventoryItem(item);
      if (action === "unequip") return this.#unequipInventoryItem(item);
      if (action === "split") return this.#splitInventoryItem(item, { stackIndex, stackQuantity });
      if (action === "drop") return this.#dropInventoryItem(item, { stackIndex, stackQuantity });
      if (action === "copy" && game.user?.isGM) return this.#copyInventoryItem(item);
      if (action === "delete" && game.user?.isGM) return this.#deleteInventoryItem(item, { stackIndex, stackQuantity });
      return undefined;
    });
  }

  #showNaturalWeaponContextMenu(item, event) {
    if (!game.user?.isGM) {
      this.#inventoryContextMenuOpen = false;
      return;
    }
    const menu = document.createElement("nav");
    menu.className = "fallout-maw-inventory-context-menu";
    menu.dataset.pointerX = String(event.clientX);
    menu.dataset.pointerY = String(event.clientY);
    this.#applyOverlayUiScale(menu);
    menu.innerHTML = `<button type="button" data-action="edit"><i class="fa-solid fa-pen-to-square"></i>${game.i18n.localize("FALLOUTMAW.Common.Edit")}</button>`;
    document.body.append(menu);
    this.#syncInventoryOverlayLayer({ bringToFront: true });
    this.#positionOverlayAtPointer(menu, { x: event.clientX, y: event.clientY }, 8);
    menu.addEventListener("click", clickEvent => {
      const action = clickEvent.target.closest("button")?.dataset.action;
      if (action !== "edit") return;
      clickEvent.preventDefault();
      this.#closeInventoryContextMenu();
      return item.sheet?.render(true);
    });
  }

  #closeInventoryContextMenu() {
    document.querySelectorAll(".fallout-maw-inventory-context-menu").forEach(menu => menu.remove());
    this.#inventoryContextMenuOpen = false;
  }

  #openContainerSheet(item) {
    if (!isContainerItem(item)) return null;
    const app = new FalloutMaWContainerSheet({
      document: item,
      evaluatingActorUuid: getInventoryTooltipPerspectiveActor(this.actor)?.uuid ?? ""
    });
    app.render({ force: true });
    app.bringToFront();
    return app;
  }

  #resolveInventoryRotation(item) {
    const parentId = item.system?.placement?.mode === LOCKED_STORAGE_PLACEMENT_MODE
      ? LOCKED_STORAGE_PARENT_ID
      : getItemContainerParentId(item);
    const { columns, rows } = this.#getInventoryGridDimensions(parentId);
    return resolveInventoryItemRotation({
      item,
      parentId,
      contextItems: this.#getContextInventoryItems(parentId),
      columns,
      rows,
      allItems: this.actor.items,
      excludeItemIds: [item.id],
      options: this.#getInventoryGridOptions(parentId)
    });
  }

  async #rotateInventoryItem(item, resolution = this.#resolveInventoryRotation(item)) {
    const updateData = createInventoryRotationUpdate(item, resolution);
    if (!updateData) {
      this.#warnInventoryNoSpace();
      return null;
    }
    if (!this.#validateProjectedInventoryState({ updates: [updateData] })) return null;
    await this.actor.updateEmbeddedDocuments("Item", [updateData]);
    return this.actor.items.get(item.id) ?? null;
  }

  async #copyInventoryItem(item) {
    const data = item.toObject();
    delete data._id;
    delete data.id;
    const parentId = getItemContainerParentId(item);
    if (usesVirtualInventoryStacks(item) && String(item.system?.placement?.mode ?? "inventory") === "inventory") {
      try {
        return await grantActorInventoryItem(this.actor, data, {
          quantity: getItemQuantityHelper(item),
          parentId
        });
      } catch (_error) {
        this.#warnInventoryNoSpace();
        return null;
      }
    }
    const placement = this.#getFirstAvailableInventoryPlacement(data, [], [], parentId);
    if (!placement) {
      this.#warnInventoryNoSpace();
      return null;
    }
    foundry.utils.setProperty(data, "system.container.parentId", parentId);
    foundry.utils.setProperty(data, "system.placement", createStoredPlacement(placement, item));
    if (!this.#validateProjectedInventoryState({ creates: [data] })) return null;
    return this.actor.createEmbeddedDocuments("Item", [data]);
  }

  async #splitInventoryItem(item, { stackIndex = 0, stackQuantity = 0 } = {}) {
    const quantity = usesVirtualInventoryStacks(item)
      ? Math.max(1, stackQuantity || getItemStackPartQuantity(item, stackIndex))
      : getItemQuantity(item);
    if (quantity <= 1) return null;
    const amount = await promptItemStackQuantity({
      item,
      title: "Разделить предмет",
      actionLabel: "Разделить",
      max: quantity - 1,
      value: Math.max(1, Math.floor(quantity / 2))
    });
    if (!amount) return null;

    if (usesVirtualInventoryStacks(item)) {
      const splitData = item.toObject();
      foundry.utils.setProperty(splitData, "system.quantity", amount);
      const parentId = item.system?.placement?.mode === LOCKED_STORAGE_PLACEMENT_MODE
        ? LOCKED_STORAGE_PARENT_ID
        : getItemContainerParentId(item);
      const placement = this.#getFirstAvailableInventoryPlacement(splitData, [], [], parentId);
      if (!placement) {
        this.#warnInventoryNoSpace();
        return null;
      }
      const updateData = createItemStackPartSplitUpdate(item, stackIndex, amount, placement);
      if (!updateData || !this.#validateProjectedInventoryState({ updates: [updateData] })) return null;
      await this.actor.updateEmbeddedDocuments("Item", [updateData]);
      return this.actor.items.get(item.id) ?? null;
    }

    const data = item.toObject();
    delete data._id;
    delete data.id;
    foundry.utils.setProperty(data, "system.quantity", amount);
    const parentId = getItemContainerParentId(item);
    const placement = this.#getFirstAvailableInventoryPlacement(data, [], [], parentId);
    if (!placement) {
      this.#warnInventoryNoSpace();
      return null;
    }
    foundry.utils.setProperty(data, "system.container.parentId", parentId);
    foundry.utils.setProperty(data, "system.placement", createStoredPlacement(placement, data));
    const updateData = {
      _id: item.id,
      "system.quantity": quantity - amount
    };
    if (!this.#validateProjectedInventoryState({ updates: [updateData], creates: [data] })) return null;
    await item.update({ "system.quantity": quantity - amount });
    return this.actor.createEmbeddedDocuments("Item", [data]);
  }

  async #dropInventoryItem(item, { stackIndex = 0, stackQuantity = 0 } = {}) {
    const detachedSlotId = await this.#prepareConstructPartDetachment(item);
    if (detachedSlotId === null) return null;
    const quantity = usesVirtualInventoryStacks(item)
      ? Math.max(1, stackQuantity || getItemStackPartQuantity(item, stackIndex))
      : getItemQuantity(item);
    try {
      await dropActorInventoryItem(this.actor, item, {
        quantity,
        stackIndex: Math.max(0, toInteger(stackIndex))
      });
      this.#clearInventoryTooltip({ force: true });
      this.render({ force: true });
    } catch (error) {
      console.error("fallout-maw | Actor sheet item drop failed", error);
      ui.notifications.warn(error.message || "Не удалось выбросить предмет.");
    }
    return null;
  }

  async #deleteInventoryItem(item, { stackIndex = 0, stackQuantity = 0 } = {}) {
    const detachedSlotId = await this.#prepareConstructPartDetachment(item);
    if (detachedSlotId === null) return null;
    if (!usesVirtualInventoryStacks(item)) {
      await item.delete();
      if (detachedSlotId) await this.#completeConstructPartDetachment(detachedSlotId);
      return null;
    }
    const quantity = Math.max(1, stackQuantity || getItemStackPartQuantity(item, stackIndex));
    const updateData = createItemStackPartRemovalUpdate(item, quantity, stackIndex);
    if (!updateData) return null;
    const deletes = updateData["system.quantity"] <= 0 ? [item.id] : [];
    const updates = deletes.length ? [] : [updateData];
    if (!this.#validateProjectedInventoryState({ updates, deletes })) return null;
    if (updates.length) await this.actor.updateEmbeddedDocuments("Item", updates);
    if (deletes.length) await this.actor.deleteEmbeddedDocuments("Item", deletes);
    if (detachedSlotId) await this.#completeConstructPartDetachment(detachedSlotId);
    return null;
  }

  async #equipInventoryItem(item) {
    const race = this.#getCurrentRace();
    const selectedSlots = getRaceEquipmentSlotsForItem(race, item);
    const placementResolution = selectedSlots.length
      ? this.#resolvePlacementWithReplacements(item.toObject(), {
        mode: "equipment",
        equipmentSlot: "",
        weaponSet: "",
        weaponSlot: "",
        x: 1,
        y: 1
      }, [item.id])
      : this.#findAutoWeaponPlacement(item.toObject(), [item.id], { allowReplacement: true });
    if (!placementResolution) {
      this.#warnItemHasNoSlots();
      return null;
    }
    const spendsWeaponSwitch = placementResolution.placement.mode === "weapon";
    if (spendsWeaponSwitch && !canSpendWeaponSwitchActionPoints(this.actor)) return null;

    const storedPlacement = createStoredPlacement(placementResolution.placement, item);
    const updateData = {
      _id: item.id,
      "system.equipped": placementResolution.placement.mode === "equipment",
      "system.container.parentId": ROOT_CONTAINER_ID,
      "system.placement.mode": storedPlacement.mode,
      "system.placement.equipmentSlot": storedPlacement.equipmentSlot,
      "system.placement.weaponSet": storedPlacement.weaponSet,
      "system.placement.weaponSlot": storedPlacement.weaponSlot,
      "system.placement.limbKey": storedPlacement.limbKey,
      "system.placement.x": storedPlacement.x,
      "system.placement.y": storedPlacement.y,
      "system.placement.width": storedPlacement.width,
      "system.placement.height": storedPlacement.height,
      "system.placement.rotated": storedPlacement.rotated
    };
    const replacementUpdates = this.#createUnequipReplacementUpdates(placementResolution.conflicts, [item.id]);
    if (!replacementUpdates) return null;
    const updates = [...replacementUpdates, updateData];
    if (!this.#validateProjectedInventoryState({ updates })) return null;
    await this.actor.updateEmbeddedDocuments("Item", updates);
    if (spendsWeaponSwitch) await spendWeaponSwitchActionPoints(this.actor);
    return this.actor.items.get(item.id) ?? null;
  }

  async #unequipInventoryItem(item) {
    const detachedSlotId = await this.#prepareConstructPartDetachment(item);
    if (detachedSlotId === null) return null;
    const currentPlacement = item.system?.placement ?? {};
    const currentParentId = getItemContainerParentId(item);
    const currentInventoryPlacement = (
      currentPlacement.mode === "inventory"
      && this.#isInventoryPlacementAvailable(
        normalizeInventoryPlacement(currentPlacement, item, this.actor.items),
        [item.id],
        [],
        currentParentId
      )
    )
      ? {
        parentId: currentParentId,
        placement: normalizeInventoryPlacement(currentPlacement, item, this.actor.items)
      }
      : null;
    const placementContext = currentInventoryPlacement
      ?? this.#getFirstAvailableInventoryPlacementContext(item, [item.id]);
    if (!placementContext) {
      this.#warnInventoryNoSpace();
      return null;
    }
    const updateData = this.#createInventoryPlacementUpdate(item, placementContext);
    if (!this.#validateProjectedInventoryState({ updates: [updateData] })) return null;
    await this.actor.updateEmbeddedDocuments("Item", [updateData]);
    if (detachedSlotId) await this.#completeConstructPartDetachment(detachedSlotId);
    return this.actor.items.get(item.id) ?? null;
  }

  async #cycleInventoryItemContainer(item, { sourceStackIndex = 0, sourceStackQuantity = 0 } = {}) {
    if (item.system?.placement?.mode !== "inventory") return null;
    if (!await this.#repairInventoryTreePlacements()) return null;
    item = this.actor.items.get(item.id) ?? item;
    if (item.system?.placement?.mode !== "inventory") return null;

    const itemData = item.toObject();
    if (usesVirtualInventoryStacks(item)) {
      foundry.utils.setProperty(itemData, "system.quantity", Math.max(1, sourceStackQuantity || getItemStackPartQuantity(item, sourceStackIndex)));
    }
    const currentParentId = getItemContainerParentId(item);
    const candidates = this.#getInventoryPlacementParentCandidates(item, [item.id]);
    if (candidates.length < 2) {
      this.#warnInventoryNoSpace();
      return null;
    }

    const currentIndex = candidates.findIndex(parentId => String(parentId ?? ROOT_CONTAINER_ID) === currentParentId);
    const startIndex = currentIndex >= 0 ? currentIndex + 1 : 0;
    for (let offset = 0; offset < candidates.length; offset += 1) {
      const parentId = candidates[(startIndex + offset) % candidates.length];
      if (String(parentId ?? ROOT_CONTAINER_ID) === currentParentId) continue;
      const weightOk = this.#canFitItemWeightInParent(item, parentId);
      if (!weightOk) continue;
      const placement = this.#getFirstAvailableInventoryPlacement(itemData, [item.id], [], parentId);
      if (!placement) continue;

      if (usesVirtualInventoryStacks(item)) {
        const moved = await this.#insertItemIntoInventory(itemData, placement, {
          sourceItem: item,
          parentId,
          sourceStackIndex
        });
        return moved ?? null;
      }

      const updateData = this.#createInventoryPlacementUpdate(item, { parentId, placement });
      if (!this.#validateProjectedInventoryState({ updates: [updateData] })) return null;
      await this.actor.updateEmbeddedDocuments("Item", [updateData]);
      return this.actor.items.get(item.id) ?? null;
    }

    this.#warnInventoryNoSpace();
    return null;
  }

  #getFirstAvailableInventoryPlacementContext(itemData = null, excludeItemIds = [], reservedPlacementContexts = []) {
    for (const parentId of this.#getInventoryPlacementParentCandidates(itemData, excludeItemIds)) {
      const reservedPlacements = reservedPlacementContexts
        .filter(entry => String(entry?.parentId ?? ROOT_CONTAINER_ID) === String(parentId ?? ROOT_CONTAINER_ID))
        .map(entry => entry.placement);
      if (!this.#canFitItemWeightInParent(itemData, parentId, reservedPlacementContexts, excludeItemIds)) continue;
      const placement = this.#getFirstAvailableInventoryPlacement(itemData, excludeItemIds, reservedPlacements, parentId);
      if (placement) return { parentId, placement };
    }
    return null;
  }

  #getInventoryPlacementParentCandidates(itemData = null, excludeItemIds = []) {
    const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
    const candidates = [ROOT_CONTAINER_ID];
    const inventory = prepareDisplayInventoryContext(this.actor, this.#getCurrentRace());
    for (const container of inventory.containers ?? []) {
      const parentId = String(container?.id ?? "");
      if (!parentId || excluded.has(parentId)) continue;
      if (hasContainerCycle(itemData, parentId, this.actor.items)) continue;
      candidates.push(parentId);
    }
    return candidates;
  }

  #canFitItemWeightInParent(itemData = null, parentId = ROOT_CONTAINER_ID, reservedPlacementContexts = [], excludeItemIds = []) {
    if (!parentId) return true;
    const container = this.actor.items.get(parentId);
    if (!container) return false;
    const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
    const releasedLoad = this.actor.items.contents
      .filter(item => excluded.has(item.id) && String(item.system?.container?.parentId ?? ROOT_CONTAINER_ID) === String(parentId))
      .reduce((total, item) => total + getItemTotalWeight(item, this.actor.items), 0);
    const currentLoad = Math.max(0, getContainerContentsWeight(container, this.actor.items) - releasedLoad);
    const reservedLoad = reservedPlacementContexts
      .filter(entry => String(entry?.parentId ?? ROOT_CONTAINER_ID) === parentId)
      .reduce((total, entry) => total + getItemTotalWeight(entry.itemData, this.actor.items), 0);
    return currentLoad + reservedLoad + getItemTotalWeight(itemData, this.actor.items) <= getContainerMaxLoad(container) + 0.0001;
  }

  #createInventoryPlacementUpdate(item, placementContext = {}) {
    const storedPlacement = createStoredPlacement(placementContext.placement, item);
    return {
      _id: item.id,
      "system.equipped": false,
      "system.container.parentId": String(placementContext.parentId ?? ROOT_CONTAINER_ID),
      "system.placement.mode": storedPlacement.mode,
      "system.placement.equipmentSlot": storedPlacement.equipmentSlot,
      "system.placement.weaponSet": storedPlacement.weaponSet,
      "system.placement.weaponSlot": storedPlacement.weaponSlot,
      "system.placement.limbKey": storedPlacement.limbKey,
      "system.placement.x": storedPlacement.x,
      "system.placement.y": storedPlacement.y,
      "system.placement.width": storedPlacement.width,
      "system.placement.height": storedPlacement.height,
      "system.placement.rotated": storedPlacement.rotated
    };
  }

  #warnInventoryNoSpace() {
    ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));
  }

  #warnItemHasNoSlots() {
    ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Messages.ItemHasNoEquipmentSlots"));
  }

  async #showInventoryTooltip(item, { pinned = false, refresh = false } = {}) {
    const evaluatingActor = getInventoryTooltipPerspectiveActor(this.actor);
    const tooltipHTML = await renderInventoryItemTooltipHTML(item, this.actor, {
      activeWeaponIndex: this.#tooltipWeaponTabIndex,
      baseMode: this.#tooltipBaseMode,
      compareActor: evaluatingActor === this.actor ? getInventoryTooltipCompareActor() : evaluatingActor,
      compareMode: this.#tooltipCompareMode,
      evaluatingActor
    });
    if (refresh && this.#tooltipItemId !== item.id) return;
    if (!this.#tooltipTimer && !pinned && !refresh) return;
    if (this.#tooltipTimer) {
      clearTimeout(this.#tooltipTimer);
      this.#tooltipTimer = null;
    }

    if (this.#tooltipElement && !this.#tooltipPinned && !pinned) {
      this.#clearNestedInventoryTooltip({ force: true });
      this.#tooltipElement.innerHTML = tooltipHTML;
      this.#tooltipElement.classList.remove("pinned");
      this.#tooltipPinned = false;
      this.#syncInventoryTooltipPointerEvents();
      this.#tooltipItemId = item.id;
      this.#bindInventoryTooltipKeyMode();
      this.#syncInventoryOverlayLayer();
      this.#positionInventoryTooltip();
      requestAnimationFrame(() => {
        if (!this.#tooltipElement) return;
        const description = this.#tooltipElement.querySelector(".description");
        description?.classList.toggle("overflowing", description.clientHeight < description.scrollHeight);
        this.#syncInventoryOverlayLayer();
        this.#positionInventoryTooltip();
      });
      return;
    }

    const tooltip = document.createElement("aside");
    tooltip.className = "fallout-maw-inventory-tooltip";
    tooltip.classList.toggle("pinned", Boolean(pinned));
    this.#applyOverlayUiScale(tooltip);
    tooltip.innerHTML = tooltipHTML;
    this.#syncInventoryTooltipPointerEvents(tooltip, { pinned });
    tooltip.addEventListener("pointerdown", () => this.#syncInventoryOverlayLayer({ bringToFront: true }));
    tooltip.addEventListener("pointerenter", () => this.#cancelInventoryTooltipClose());
    tooltip.addEventListener("click", event => this.#onInventoryTooltipClick(event));
    tooltip.addEventListener("auxclick", event => this.#onInventoryTooltipAuxClick(event));
    tooltip.addEventListener("contextmenu", event => this.#onInventoryTooltipContextMenu(event));
    tooltip.addEventListener("mouseleave", event => {
      if (!this.#tooltipPinned) this.#clearInventoryTooltip();
    });
    document.body.append(tooltip);
    this.#tooltipElement = tooltip;
    this.#tooltipPinned = Boolean(pinned);
    this.#tooltipItemId = item.id;
    if (pinned) this.#bindInventoryTooltipDocumentClose();
    this.#bindInventoryTooltipKeyMode();
    this.#syncInventoryOverlayLayer({ bringToFront: pinned });
    this.#positionInventoryTooltip();
    requestAnimationFrame(() => {
      const description = tooltip.querySelector(".description");
      description?.classList.toggle("overflowing", description.clientHeight < description.scrollHeight);
      this.#syncInventoryOverlayLayer();
      this.#positionInventoryTooltip();
    });
  }

  #positionInventoryTooltip() {
    if (!this.#tooltipElement) return;
    this.#positionInventoryTooltipAtAnchor(this.#tooltipElement, this.#tooltipAnchorElement);
  }

  async #onInventoryTooltipClick(event) {
    this.#clearNestedInventoryTooltip({ force: true });

    const moduleRemove = event.target?.closest?.("[data-tooltip-module-remove]");
    if (moduleRemove && this.#tooltipElement?.contains(moduleRemove)) {
      event.preventDefault();
      event.stopPropagation();
      await this.#removeWeaponModuleFromTooltipSlot(moduleRemove);
      return;
    }

    const moduleChoice = event.target?.closest?.("[data-tooltip-module-choice]");
    if (moduleChoice && this.#tooltipElement?.contains(moduleChoice)) {
      event.preventDefault();
      event.stopPropagation();
      await this.#installWeaponModuleFromTooltipChoice(moduleChoice);
      return;
    }

    const moduleSlot = event.target?.closest?.("[data-tooltip-module-slot]");
    if (moduleSlot && this.#tooltipElement?.contains(moduleSlot)) {
      event.preventDefault();
      event.stopPropagation();
      this.#toggleWeaponModulePicker(moduleSlot);
      return;
    }

    const button = event.target?.closest?.("[data-tooltip-weapon-tab]");
    if (!button || !this.#tooltipElement?.contains(button)) return;
    event.preventDefault();
    event.stopPropagation();

    const index = Math.max(0, toInteger(button.dataset.tooltipWeaponTab));
    if (index === this.#tooltipWeaponTabIndex) return;
    this.#tooltipWeaponTabIndex = index;
    if (this.#tooltipCompareMode || this.#tooltipElement?.querySelector(".fallout-maw-tooltip-comparison")) {
      void this.#refreshInventoryTooltip();
      return;
    }
    this.#activateInventoryTooltipWeaponTab(index);
  }

  async #onInventoryTooltipContextMenu(event) {
    const moduleSlot = event.target?.closest?.("[data-tooltip-module-slot]");
    if (!moduleSlot || !this.#tooltipElement?.contains(moduleSlot)) return;
    event.preventDefault();
    event.stopPropagation();
  }

  #onInventoryTooltipAuxClick(event) {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();

    const nestedAnchor = event.target?.closest?.("[data-tooltip-html]");
    if (nestedAnchor && this.#tooltipElement?.contains(nestedAnchor)) {
      return;
    }
    this.#clearNestedInventoryTooltip({ force: true });
    this.#pinInventoryTooltip();
  }

  #activateInventoryTooltipWeaponTab(index) {
    activateInventoryTooltipTab(this.#tooltipElement, index);
  }

  async #refreshInventoryTooltip() {
    if (!this.#tooltipElement || !this.#tooltipItemId) return;
    const item = this.actor.items.get(this.#tooltipItemId);
    if (!item) return;
    this.#clearNestedInventoryTooltip({ force: true });
    const evaluatingActor = getInventoryTooltipPerspectiveActor(this.actor);
    const tooltipHTML = await renderInventoryItemTooltipHTML(item, this.actor, {
      activeWeaponIndex: this.#tooltipWeaponTabIndex,
      baseMode: this.#tooltipBaseMode,
      compareActor: evaluatingActor === this.actor ? getInventoryTooltipCompareActor() : evaluatingActor,
      compareMode: this.#tooltipCompareMode,
      evaluatingActor
    });
    if (!this.#tooltipElement || this.#tooltipItemId !== item.id) return;
    this.#tooltipElement.innerHTML = tooltipHTML;
    this.#tooltipElement.classList.toggle("pinned", this.#tooltipPinned);
    this.#syncInventoryTooltipPointerEvents();
    this.#syncInventoryOverlayLayer({ bringToFront: this.#tooltipPinned });
    if (!this.#tooltipPinned && this.#resolveInventoryTooltipAnchor(this.#tooltipItemId)) this.#positionInventoryTooltip();
    else this.#clampInventoryTooltipToViewport(this.#tooltipElement);
    requestAnimationFrame(() => {
      if (!this.#tooltipElement) return;
      const description = this.#tooltipElement.querySelector(".description");
      description?.classList.toggle("overflowing", description.clientHeight < description.scrollHeight);
      this.#syncInventoryOverlayLayer();
      if (!this.#tooltipPinned && this.#resolveInventoryTooltipAnchor(this.#tooltipItemId)) this.#positionInventoryTooltip();
      else this.#clampInventoryTooltipToViewport(this.#tooltipElement);
    });
  }

  #toggleWeaponModulePicker(slotElement) {
    this.#tooltipPinned = true;
    this.#tooltipElement?.classList.add("pinned");
    if (this.#tooltipElement) this.#tooltipElement.style.pointerEvents = "auto";
    this.#bindInventoryTooltipDocumentClose();
    this.#syncInventoryOverlayLayer({ bringToFront: true });
    const weaponIndex = Math.max(0, toInteger(slotElement?.dataset?.tooltipWeaponIndex));
    const slotIndex = Math.max(0, toInteger(slotElement?.dataset?.tooltipModuleSlotIndex));
    const panelKey = `${weaponIndex}:${slotIndex}`;
    const panel = this.#tooltipElement?.querySelector(`[data-tooltip-module-picker-panel="${CSS.escape(panelKey)}"]`);
    if (!panel) return;
    const wasActive = panel.classList.contains("active");
    this.#tooltipElement.querySelectorAll("[data-tooltip-module-picker-panel]").forEach(entry => entry.classList.remove("active"));
    this.#tooltipElement.querySelectorAll("[data-tooltip-module-slot]").forEach(entry => entry.classList.remove("selecting"));
    if (wasActive) {
      this.#clampInventoryTooltipToViewport(this.#tooltipElement);
      return;
    }
    panel.classList.add("active");
    slotElement.classList.add("selecting");
    requestAnimationFrame(() => this.#clampInventoryTooltipToViewport(this.#tooltipElement));
  }

  async #installWeaponModuleFromTooltipChoice(choiceElement) {
    const { item, entries, weaponIndex, slotIndex } = this.#getTooltipWeaponModuleSlotContext(choiceElement);
    if (!item) return;
    const moduleItem = this.actor.items.get(String(choiceElement?.dataset?.tooltipModuleChoice ?? ""));
    if (!moduleItem) return;
    await this.#installWeaponModule(item, entries[weaponIndex], slotIndex, moduleItem);
  }

  async #removeWeaponModuleFromTooltipSlot(slotElement) {
    const { item, entry, slotIndex, slot } = this.#getTooltipWeaponModuleSlotContext(slotElement);
    const itemData = getWeaponModuleSlotItemData(slot);
    if (!item || !entry || !itemData?.system) return;
    await this.#uninstallWeaponModule(item, entry, slotIndex, itemData);
  }

  #getTooltipWeaponModuleSlotContext(slotElement) {
    const item = this.#tooltipItemId ? this.actor.items.get(this.#tooltipItemId) : null;
    const entries = item ? getEnabledWeaponFunctions(item) : [];
    const weaponIndex = Math.max(0, toInteger(slotElement?.dataset?.tooltipWeaponIndex));
    const slotIndex = Math.max(0, toInteger(slotElement?.dataset?.tooltipModuleSlotIndex));
    const entry = entries[weaponIndex] ?? null;
    const slot = entry?.canHaveModuleSlots ? getWeaponModuleSlots(entry?.data ?? {})[slotIndex] ?? null : null;
    return { item, entries, entry, weaponIndex, slotIndex, slot };
  }

  async #installWeaponModule(weapon, entry, slotIndex, moduleItem) {
    const path = getWeaponFunctionUpdatePath(entry);
    if (!path) return;
    const slots = getWeaponModuleSlots(entry.data ?? {});
    const slot = slots[slotIndex];
    if (!slot || !isModuleItemCompatibleWithSlot(moduleItem, slot)) return;
    const oldItemData = getWeaponModuleSlotItemData(slot);

    const itemData = moduleItem.toObject();
    delete itemData._id;
    foundry.utils.setProperty(itemData, "system.quantity", 1);
    slots[slotIndex] = { ...slot, itemUuid: moduleItem.uuid, itemData };

    await weapon.update({ [`${path}.moduleSlots`]: slots });
    if (oldItemData?.system) await this.#insertItemIntoInventory(oldItemData, createInventoryPlacementHelper(1, 1, oldItemData, this.actor.items));
    const quantity = getItemQuantityHelper(moduleItem);
    if (usesVirtualInventoryStacks(moduleItem)) {
      const updateData = createItemStackPartRemovalUpdate(moduleItem, 1, 0);
      if (!updateData || (updateData["system.quantity"] ?? 0) <= 0) await moduleItem.delete();
      else {
        const { _id, ...changes } = updateData;
        await moduleItem.update(changes);
      }
    } else if (quantity > 1) await moduleItem.update({ "system.quantity": quantity - 1 });
    else await moduleItem.delete();
    this.#restoreTooltipModuleSlotsTab(weapon.id);
    await this.#refreshInventoryTooltip();
  }

  async #uninstallWeaponModule(weapon, entry, slotIndex, itemData) {
    const path = getWeaponFunctionUpdatePath(entry);
    if (!path) return;
    const slots = getWeaponModuleSlots(entry.data ?? {});
    const slot = slots[slotIndex];
    if (!slot) return;
    slots[slotIndex] = { ...slot, itemUuid: "", itemData: {} };
    await weapon.update({ [`${path}.moduleSlots`]: slots });
    await this.#insertItemIntoInventory(itemData, createInventoryPlacementHelper(1, 1, itemData, this.actor.items));
    this.#restoreTooltipModuleSlotsTab(weapon.id);
    await this.#refreshInventoryTooltip();
  }

  #restoreTooltipModuleSlotsTab(weaponId = "") {
    const weapon = this.actor.items.get(String(weaponId ?? ""));
    if (!weapon) return;
    this.#tooltipWeaponTabIndex = getWeaponTooltipModuleSlotsTabIndex(weapon, this.actor);
  }

  #pinInventoryTooltip() {
    this.#tooltipPinned = true;
    this.#tooltipElement?.classList.add("pinned");
    this.#syncInventoryTooltipPointerEvents();
    this.#bindInventoryTooltipDocumentClose();
    this.#syncInventoryOverlayLayer({ bringToFront: true });
  }

  #syncInventoryTooltipPointerEvents(tooltip = this.#tooltipElement, { pinned = this.#tooltipPinned } = {}) {
    if (!tooltip) return;
    tooltip.style.pointerEvents = pinned ? "auto" : "none";
  }

  #clearNestedInventoryTooltip() {
    const tooltipAnchor = game.tooltip?.element;
    if (tooltipAnchor && this.#tooltipElement?.contains(tooltipAnchor)) game.tooltip.deactivate();
  }

  #scheduleInventoryTooltipClose() {
    if (this.#tooltipPinned || this.#tooltipCloseTimer) return;
    const view = this.element?.ownerDocument?.defaultView ?? window;
    this.#tooltipCloseTimer = view.setTimeout(() => {
      this.#tooltipCloseTimer = null;
      this.#clearInventoryTooltip();
    }, 160);
  }

  #cancelInventoryTooltipClose() {
    if (!this.#tooltipCloseTimer) return;
    const view = this.element?.ownerDocument?.defaultView ?? window;
    view.clearTimeout(this.#tooltipCloseTimer);
    this.#tooltipCloseTimer = null;
  }

  #positionInventoryTooltipAtAnchor(element, anchor) {
    if (!element) return;
    if (!anchor?.isConnected) {
      this.#positionOverlayAtPointer(element, this.#tooltipPointer, 14);
      return;
    }

    const { viewportWidth, viewportHeight } = this.#getViewportMetrics();
    const margin = Math.max(8, 12 * this.#uiScale);
    const gap = Math.max(10, 12 * this.#uiScale);

    const anchorRect = anchor.getBoundingClientRect();
    const aboveAvailable = Math.max(0, anchorRect.top - margin - gap);
    const belowAvailable = Math.max(0, viewportHeight - anchorRect.bottom - margin - gap);
    const placeAbove = aboveAvailable >= Math.min(220 * this.#uiScale, belowAvailable) || belowAvailable < (160 * this.#uiScale);
    this.#syncInventoryTooltipAvailableHeight(element, viewportHeight, margin, this.#uiScale);

    let tooltipRect = element.getBoundingClientRect();

    let left = anchorRect.left - tooltipRect.width - gap;
    let direction = "left";
    if (left < margin) {
      left = anchorRect.right + gap;
      direction = "right";
    }
    if ((left + tooltipRect.width) > (viewportWidth - margin)) {
      left = Math.max(margin, viewportWidth - tooltipRect.width - margin);
      direction = "clamped";
    }

    const top = placeAbove
      ? anchorRect.top - tooltipRect.height - gap
      : anchorRect.bottom + gap;

    element.dataset.tooltipDirection = direction;
    element.style.left = `${Math.round(left)}px`;
    element.style.top = `${Math.round(Math.max(margin, Math.min(viewportHeight - tooltipRect.height - margin, top)))}px`;

    this.#syncInventoryTooltipAvailableHeight(element, viewportHeight, margin, this.#uiScale);
    tooltipRect = element.getBoundingClientRect();
    if (placeAbove && tooltipRect.bottom > (anchorRect.top - gap)) {
      element.style.top = `${Math.round(Math.max(margin, anchorRect.top - tooltipRect.height - gap))}px`;
    } else if ((tooltipRect.top + tooltipRect.height) > (viewportHeight - margin)) {
      element.style.top = `${Math.round(Math.max(margin, viewportHeight - tooltipRect.height - margin))}px`;
    }
  }

  #clampInventoryTooltipToViewport(element) {
    if (!element) return;
    const { viewportWidth, viewportHeight } = this.#getViewportMetrics();
    const margin = Math.max(8, 12 * this.#uiScale);
    this.#syncInventoryTooltipAvailableHeight(element, viewportHeight, margin, this.#uiScale);
    const rect = element.getBoundingClientRect();
    let left = Number.parseFloat(element.style.left);
    let top = Number.parseFloat(element.style.top);
    if (!Number.isFinite(left)) left = rect.left;
    if (!Number.isFinite(top)) top = rect.top;
    left = Math.max(margin, Math.min(viewportWidth - rect.width - margin, left));
    top = Math.max(margin, Math.min(viewportHeight - rect.height - margin, top));
    element.style.left = `${Math.round(left)}px`;
    element.style.top = `${Math.round(top)}px`;
  }

  #syncInventoryTooltipAvailableHeight(element, viewportHeight, margin, scale = 1) {
    if (!element) return;
    const safeScale = Math.max(0.1, Number(scale) || 1);
    const viewportAvailableHeight = Math.max(0, viewportHeight - (margin * 2));
    const maxTooltipHeight = Math.max(80, Math.floor(viewportAvailableHeight / safeScale));
    element.style.setProperty("--fallout-maw-tooltip-max-height", `${maxTooltipHeight}px`);

    const picker = element.querySelector(".tooltip-module-picker-panels:has(.tooltip-module-picker-panel.active)");
    if (!picker) {
      element.style.removeProperty("--fallout-maw-module-picker-max-height");
      return;
    }

    const tooltipRect = element.getBoundingClientRect();
    const pickerRect = picker.getBoundingClientRect();
    const nonPickerHeight = Math.max(0, tooltipRect.height - pickerRect.height);
    const maxPickerHeight = Math.max(80, Math.floor((viewportAvailableHeight - nonPickerHeight) / safeScale));
    element.style.setProperty("--fallout-maw-module-picker-max-height", `${maxPickerHeight}px`);
  }

  #bindInventoryTooltipDocumentClose() {
    if (this.#tooltipDocumentPointerDownHandler) return;
    const view = this.element?.ownerDocument?.defaultView ?? window;
    this.#tooltipDocumentPointerDownHandler = event => {
      const insideParentTooltip = this.#tooltipElement?.contains(event.target);
      if (event.button === 1 && insideParentTooltip) {
        event.preventDefault();
        return;
      }
      if (!this.#tooltipPinned || !this.#tooltipElement) return;
      if (insideParentTooltip) {
        this.#clearNestedInventoryTooltip();
        return;
      }
      this.#clearInventoryTooltip({ force: true });
    };
    view.document.addEventListener("pointerdown", this.#tooltipDocumentPointerDownHandler, { capture: true });
  }

  #unbindInventoryTooltipDocumentClose() {
    if (!this.#tooltipDocumentPointerDownHandler) return;
    const view = this.element?.ownerDocument?.defaultView ?? window;
    view.document.removeEventListener("pointerdown", this.#tooltipDocumentPointerDownHandler, { capture: true });
    this.#tooltipDocumentPointerDownHandler = null;
  }

  #bindInventoryTooltipKeyMode() {
    if (this.#tooltipDocumentKeyHandler) return;
    const view = this.element?.ownerDocument?.defaultView ?? window;
    this.#tooltipDocumentKeyHandler = event => {
      if (!["Alt", "Control"].includes(event.key)) return;
      const active = event.type === "keydown";
      let changed = false;
      if (event.key === "Alt" && this.#tooltipBaseMode !== active) {
        this.#tooltipBaseMode = active;
        changed = true;
      }
      if (event.key === "Control" && this.#tooltipCompareMode !== active) {
        this.#tooltipCompareMode = active;
        changed = true;
      }
      if (!changed) return;
      void this.#refreshInventoryTooltip();
    };
    view.document.addEventListener("keydown", this.#tooltipDocumentKeyHandler, { capture: true });
    view.document.addEventListener("keyup", this.#tooltipDocumentKeyHandler, { capture: true });
  }

  #unbindInventoryTooltipKeyMode() {
    if (!this.#tooltipDocumentKeyHandler) return;
    const view = this.element?.ownerDocument?.defaultView ?? window;
    view.document.removeEventListener("keydown", this.#tooltipDocumentKeyHandler, { capture: true });
    view.document.removeEventListener("keyup", this.#tooltipDocumentKeyHandler, { capture: true });
    this.#tooltipDocumentKeyHandler = null;
  }

  #clearInventoryTooltip({ force = false } = {}) {
    if (this.#tooltipTimer) {
      clearTimeout(this.#tooltipTimer);
      this.#tooltipTimer = null;
    }
    this.#cancelInventoryTooltipClose();
    if (this.#tooltipPinned && !force) return;
    this.#unbindInventoryTooltipDocumentClose();
    this.#unbindInventoryTooltipKeyMode();
    this.#clearNestedInventoryTooltip({ force: true });
    this.#tooltipElement?.remove();
    this.#tooltipElement = null;
    this.#tooltipAnchorElement = null;
    this.#tooltipPinned = false;
    this.#tooltipItemId = "";
    this.#tooltipWeaponTabIndex = 0;
    this.#tooltipBaseMode = false;
    this.#tooltipCompareMode = false;
  }

  #resolveInventoryTooltipAnchor(itemId = "") {
    if (this.#tooltipAnchorElement?.isConnected && this.element?.contains(this.#tooltipAnchorElement)) return this.#tooltipAnchorElement;
    const expectedItemId = String(itemId ?? "");
    if (!expectedItemId) return null;
    const anchor = this.element?.querySelector(`[data-tooltip-item="${CSS.escape(expectedItemId)}"]`);
    if (!anchor) return null;
    this.#tooltipAnchorElement = anchor;
    return anchor;
  }

  #syncInventoryTooltipAfterRender() {
    if (!this.#tooltipElement || !this.#tooltipItemId) return;
    this.#cancelInventoryTooltipClose();
    const anchor = this.#resolveInventoryTooltipAnchor(this.#tooltipItemId);
    if (!anchor && !this.#tooltipPinned) {
      this.#clearInventoryTooltip({ force: true });
      return;
    }
    this.#syncInventoryOverlayLayer({ bringToFront: this.#tooltipPinned });
    void this.#refreshInventoryTooltip();
  }

  #getFullscreenSheetPosition(position = {}) {
    const { viewportWidth, viewportHeight } = this.#getViewportMetrics();
    const scale = Math.max(
      0.1,
      Math.min(
        viewportWidth / ACTOR_SHEET_REFERENCE_WIDTH,
        viewportHeight / ACTOR_SHEET_REFERENCE_HEIGHT
      ) || 1
    );
    const peekWidth = this.#getWorldSidebarPeekWidth(viewportWidth);
    const width = ACTOR_SHEET_REFERENCE_WIDTH - (peekWidth / scale);
    const height = ACTOR_SHEET_REFERENCE_HEIGHT;
    const resolvedPosition = {
      left: peekWidth > 0 ? 0 : Math.max(0, (viewportWidth - (width * scale)) / 2),
      top: Math.max(0, (viewportHeight - (height * scale)) / 2),
      width,
      height,
      scale
    };

    return resolvedPosition;
  }

  #getWorldSidebarPeekWidth(viewportWidth = 0) {
    if (!game.user?.isGM || !this.#worldSidebarPeek) return 0;
    const safeViewportWidth = Math.max(0, Number(viewportWidth) || 0);
    if (safeViewportWidth < 900) return 0;
    return Math.min(
      ACTOR_SHEET_WORLD_SIDEBAR_PEEK_WIDTH,
      Math.max(300, safeViewportWidth * 0.28),
      Math.max(0, safeViewportWidth - 720)
    );
  }

  #getViewportMetrics() {
    const view = this.element?.ownerDocument?.defaultView ?? window;
    const documentElement = view.document?.documentElement ?? document.documentElement;
    return {
      view,
      viewportWidth: view.innerWidth || documentElement?.clientWidth || ACTOR_SHEET_FALLBACK_VIEWPORT_WIDTH,
      viewportHeight: view.innerHeight || documentElement?.clientHeight || ACTOR_SHEET_FALLBACK_VIEWPORT_HEIGHT
    };
  }

  #applyUiScale(scale = 1) {
    const normalizedScale = Math.max(0.1, Number(scale) || 1);
    this.#uiScale = normalizedScale;
    this.element?.style?.setProperty("--fallout-maw-ui-scale", String(normalizedScale));
  }

  #applyOverlayUiScale(element) {
    if (!element) return;
    element.style.setProperty("--fallout-maw-ui-scale", String(this.#uiScale));
  }

  #syncInventoryOverlayLayer({ bringToFront = false } = {}) {
    if (bringToFront) this.bringToFront?.();
    const baseZIndex = getOverlayBaseZIndex(this.element);
    if (this.#tooltipElement) this.#tooltipElement.style.zIndex = String(baseZIndex + 2);
    if (game.tooltip?.element && this.#tooltipElement?.contains(game.tooltip.element)) {
      game.tooltip.tooltip.style.zIndex = String(baseZIndex + 3);
    }
    const ownerDocument = this.element?.ownerDocument ?? document;
    for (const menu of ownerDocument.querySelectorAll(".fallout-maw-inventory-context-menu")) {
      menu.style.zIndex = String(baseZIndex + 2);
    }
    if (bringToFront || this.#tooltipPinned || this.#inventoryContextMenuOpen) {
      reserveOverlayZIndex(baseZIndex + 3);
    }
  }

  #positionOverlayAtPointer(element, pointer = {}, baseMargin = 14) {
    if (!element) return;
    const { viewportWidth, viewportHeight } = this.#getViewportMetrics();
    const rect = element.getBoundingClientRect();
    const margin = Math.max(8, baseMargin * this.#uiScale);
    const pointerX = Number(pointer?.x);
    const pointerY = Number(pointer?.y);
    const x = Math.min(
      (Number.isFinite(pointerX) ? pointerX : 0) + margin,
      viewportWidth - rect.width - margin
    );
    const y = Math.min(
      (Number.isFinite(pointerY) ? pointerY : 0) + margin,
      viewportHeight - rect.height - margin
    );
    element.style.left = `${Math.max(margin, x)}px`;
    element.style.top = `${Math.max(margin, y)}px`;
  }

  #syncOverlayScale() {
    if (this.#tooltipElement) {
      this.#applyOverlayUiScale(this.#tooltipElement);
      if (this.#tooltipPinned) this.#clampInventoryTooltipToViewport(this.#tooltipElement);
      else this.#positionInventoryTooltip();
    }

    for (const menu of document.querySelectorAll(".fallout-maw-inventory-context-menu")) {
      this.#applyOverlayUiScale(menu);
      this.#positionOverlayAtPointer(menu, {
        x: Number(menu.dataset.pointerX),
        y: Number(menu.dataset.pointerY)
      }, 8);
    }
    this.#syncInventoryOverlayLayer();
  }

  #bindViewportResize() {
    const { view } = this.#getViewportMetrics();
    if (this.#viewportResizeHandler) return;
    this.#viewportResizeHandler = () => this.setPosition();
    view.addEventListener("resize", this.#viewportResizeHandler);
  }

  #unbindViewportResize() {
    if (!this.#viewportResizeHandler) return;
    const view = this.element?.ownerDocument?.defaultView ?? window;
    view.removeEventListener("resize", this.#viewportResizeHandler);
    this.#viewportResizeHandler = null;
  }
}

function isActorContainerUsableItem(itemOrData = null) {
  return hasItemFunction(itemOrData, ITEM_FUNCTIONS.firstAid)
    || hasItemFunction(itemOrData, ITEM_FUNCTIONS.needChange)
    || hasItemFunction(itemOrData, ITEM_FUNCTIONS.oneTimeUse);
}

function isTravelGroupCarrierActor(actor = null) {
  return Boolean(actor?.getFlag?.(FALLOUT_MAW.id, TRAVEL_GROUP_FLAG)?.groupId);
}

async function prepareTravelGroupSheetContext(actor = null) {
  const group = actor?.getFlag?.(FALLOUT_MAW.id, TRAVEL_GROUP_FLAG);
  if (!group?.groupId) return { visible: false, vehicles: [], walkers: [] };
  const sourceUnits = getTravelGroupUnits(actor);
  const vehicles = [];
  const walkers = [];
  for (const unit of sourceUnits) {
    const unitActor = await resolveTravelGroupUnitActor(unit);
    const useLiveActorContainer = unit.tokenData?.actorLink !== false
      && unitActor
      && hasActorContainer(unitActor);
    const actorContainers = useLiveActorContainer
      ? prepareActorContainerInventoryContext(unitActor)
      : prepareActorContainerSnapshotContext(unit.actorContainer);
    const entry = {
      id: unit.id,
      actorUuid: unit.actorUuid || unitActor?.uuid || "",
      name: unit.actorName || unitActor?.name || unit.tokenData?.name || "Участник путешествия",
      img: unit.actorImg || unitActor?.img || unit.tokenData?.texture?.src || "icons/svg/mystery-man.svg",
      missing: !unitActor && !actorContainers.visible
    };
    if (actorContainers.visible) {
      vehicles.push({
        ...entry,
        seatGroups: actorContainers.groups,
        occupied: actorContainers.occupied ?? 0,
        hasSeats: actorContainers.visible
      });
    } else {
      walkers.push(entry);
    }
  }
  return {
    visible: true,
    groupId: String(group.groupId ?? ""),
    vehicles,
    walkers,
    hasVehicles: vehicles.length > 0,
    hasWalkers: walkers.length > 0,
    empty: vehicles.length === 0 && walkers.length === 0
  };
}

function prepareActorContainerSnapshotContext(snapshot = null) {
  if (!snapshot) return { visible: false, groups: [] };
  return prepareActorContainerGridContext(snapshot.seats, snapshot.passengers);
}

async function resolveActorByUuid(uuid = "") {
  const normalized = String(uuid ?? "").trim();
  if (!normalized) return null;
  if (normalized.startsWith("Actor.")) {
    const actor = game.actors?.get(normalized.slice("Actor.".length));
    if (actor) return actor;
  }
  const fromUuid = globalThis.fromUuid ?? foundry.utils.fromUuid;
  const resolved = await fromUuid?.(normalized);
  return resolved instanceof Actor ? resolved : null;
}

export function getInventoryTooltipCompareActor() {
  const token = (globalThis.canvas?.tokens?.controlled ?? []).find(entry => (
    entry?.actor?.testUserPermission?.(game.user, "LIMITED")
  )) ?? null;
  return token?.actor ?? null;
}

export function getInventoryTooltipPerspectiveActor(sourceActor = null) {
  const controlledActor = getInventoryTooltipCompareActor();
  if (controlledActor && controlledActor !== sourceActor) {
    const ownsSource = sourceActor?.testUserPermission?.(game.user, "OWNER") ?? false;
    if (game.user?.isGM || !ownsSource) return controlledActor;
  }
  const ownsSource = sourceActor?.testUserPermission?.(game.user, "OWNER") ?? false;
  if (!ownsSource && game.user?.character) return game.user.character;
  return sourceActor;
}

export async function renderInventoryItemTooltipHTML(item, sourceActor, {
  activeWeaponIndex = 0,
  baseMode = false,
  compareActor = null,
  compareMode = false,
  evaluatingActor = sourceActor
} = {}) {
  ensureRecipeKnowledgeTooltipListeners();
  const descriptionHTML = await renderInventoryItemDescriptionHTML(item, evaluatingActor);
  const recipeKnowledgePreviews = await prepareOneTimeUseRecipeKnowledgePreviews(item, evaluatingActor);
  if (item.type === "ability") return renderAbilityItemTooltipContentHTML(item, evaluatingActor, { descriptionHTML });
  const itemHTML = renderInventoryItemTooltipContentHTML(item, sourceActor, {
    activeWeaponIndex,
    baseMode,
    descriptionHTML,
    evaluatingActor,
    recipeKnowledgePreviews
  });
  if (!compareMode) return itemHTML;
  if (!compareActor) return itemHTML;

  const equippedItems = findComparableEquippedItems(item, compareActor);
  if (!equippedItems.length) return itemHTML;

  const equippedHTMLs = [];
  for (const equippedItem of equippedItems) {
    const equippedDescriptionHTML = await renderInventoryItemDescriptionHTML(equippedItem, compareActor);
    const equippedRecipeKnowledgePreviews = await prepareOneTimeUseRecipeKnowledgePreviews(equippedItem, compareActor);
    equippedHTMLs.push(renderInventoryItemTooltipContentHTML(equippedItem, compareActor, {
      activeWeaponIndex: 0,
      baseMode,
      descriptionHTML: equippedDescriptionHTML,
      evaluatingActor: compareActor,
      recipeKnowledgePreviews: equippedRecipeKnowledgePreviews
    }));
  }
  return renderInventoryTooltipComparisonHTML(itemHTML, equippedHTMLs);
}

async function renderInventoryItemDescriptionHTML(item, evaluatingActor = null) {
  const descriptionSource = String(item?.system?.description ?? "").trim();
  if (!descriptionSource) return "";
  return TextEditor.enrichHTML(descriptionSource, {
    async: true,
    secrets: item?.isOwner,
    relativeTo: item,
    rollData: evaluatingActor?.getRollData?.() ?? {}
  });
}

async function prepareOneTimeUseRecipeKnowledgePreviews(item, actor = null) {
  if (!hasItemFunction(item, ITEM_FUNCTIONS.oneTimeUse, { ignoreBroken: true })) return new Map();
  const previews = new Map();
  for (const uuid of getOneTimeUseFunction(item).recipeItemUuids ?? []) {
    const recipeItem = resolveCraftKnowledgeItem(uuid);
    if (!recipeItem || !hasCraftKnowledgeData(recipeItem) || previews.has(recipeItem.uuid)) continue;
    previews.set(recipeItem.uuid, await renderCraftKnowledgeTooltipHTML(recipeItem, actor));
  }
  return previews;
}

export async function renderCraftKnowledgeTooltipHTML(item, actor = null) {
  const { renderCraftKnowledgeVariantsHTML } = await import("../apps/craft-window.mjs");
  return `
    <section class="fallout-maw-recipe-knowledge-preview">
      ${renderCraftKnowledgeVariantsHTML(item, actor)}
    </section>
  `;
}

export function activateCraftKnowledgeTooltip(anchor, html, { locked = false, replace = false } = {}) {
  if (!anchor?.isConnected || !html) return null;
  reconcileCraftKnowledgeTooltipState();
  cancelCraftKnowledgeTooltipClose();
  if (isCraftKnowledgeTooltipPinned()) {
    if (!locked || recipeKnowledgeTooltipAnchor === anchor) return null;
    removeCraftKnowledgeTooltip();
  }
  if (!replace && recipeKnowledgeTooltipElement?.isConnected && game.tooltip?.element === anchor) {
    if (locked) pinCraftKnowledgeTooltip(anchor);
    return recipeKnowledgeTooltipElement.querySelector(".fallout-maw-recipe-knowledge-tooltip-host");
  }
  const host = anchor.ownerDocument.createElement("div");
  host.className = "fallout-maw-recipe-knowledge-tooltip-host";
  host.innerHTML = String(html);
  const radioGroup = `craft-knowledge-${foundry.utils.randomID()}`;
  host.querySelectorAll(".fallout-maw-recipe-knowledge-variant-tabs > input[type='radio']").forEach((input, index) => {
    const previousId = input.id;
    const nextId = `${radioGroup}-${index}`;
    const label = previousId ? host.querySelector(`label[for="${CSS.escape(previousId)}"]`) : null;
    input.id = nextId;
    input.name = radioGroup;
    if (label) label.htmlFor = nextId;
  });
  const anchorRect = anchor.getBoundingClientRect();
  const direction = (window.innerWidth - anchorRect.right) >= anchorRect.left ? "RIGHT" : "LEFT";
  game.tooltip.activate(anchor, {
    html: host,
    cssClass: "fallout-maw-inventory-tooltip fallout-maw-recipe-knowledge-tooltip",
    direction
  });
  const tooltip = game.tooltip.tooltip;
  tooltip.style.pointerEvents = "none";
  host.addEventListener("pointerenter", cancelCraftKnowledgeTooltipClose);
  host.addEventListener("pointerleave", event => scheduleCraftKnowledgeTooltipClose(anchor, event.relatedTarget));
  host.addEventListener("auxclick", event => {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    pinCraftKnowledgeTooltip(anchor);
  });
  recipeKnowledgeTooltipElement = tooltip;
  recipeKnowledgeTooltipAnchor = anchor;
  if (locked) pinCraftKnowledgeTooltip(anchor);
  import("../apps/craft-window.mjs").then(({ activateCraftKnowledgeVariants }) => {
    activateCraftKnowledgeVariants(host);
  });
  return host;
}

export function isCraftKnowledgeTooltipOpen() {
  reconcileCraftKnowledgeTooltipState();
  if (isCraftKnowledgeTooltipPinned()) return true;
  return Boolean(
    recipeKnowledgeTooltipElement === game.tooltip?.tooltip
    && game.tooltip?.element === recipeKnowledgeTooltipAnchor
    && recipeKnowledgeTooltipElement?.classList?.contains("active")
    && recipeKnowledgeTooltipElement?.classList?.contains("fallout-maw-recipe-knowledge-tooltip")
  );
}

export function reanchorCraftKnowledgeTooltip(anchor) {
  if (isCraftKnowledgeTooltipPinned() || !isCraftKnowledgeTooltipOpen() || !anchor?.isConnected) return false;
  const host = recipeKnowledgeTooltipElement.querySelector(".fallout-maw-recipe-knowledge-tooltip-host");
  if (!host) return false;
  const rect = anchor.getBoundingClientRect();
  game.tooltip.activate(anchor, {
    html: host,
    cssClass: "fallout-maw-inventory-tooltip fallout-maw-recipe-knowledge-tooltip",
    direction: (window.innerWidth - rect.right) >= rect.left ? "RIGHT" : "LEFT"
  });
  game.tooltip.tooltip.style.pointerEvents = "none";
  recipeKnowledgeTooltipElement = game.tooltip.tooltip;
  recipeKnowledgeTooltipAnchor = anchor;
  return true;
}

export function toggleCraftKnowledgeTooltipPin(anchor) {
  if (!isCraftKnowledgeTooltipOpen() || recipeKnowledgeTooltipAnchor !== anchor) return false;
  if (isCraftKnowledgeTooltipPinned()) removeCraftKnowledgeTooltip(anchor);
  else pinCraftKnowledgeTooltip(anchor);
  return true;
}

function pinCraftKnowledgeTooltip(anchor) {
  if (isCraftKnowledgeTooltipPinned() || game.tooltip?.element !== anchor) return recipeKnowledgeTooltipElement;
  const tooltip = game.tooltip.lockTooltip();
  tooltip.classList.add("pinned");
  tooltip.style.pointerEvents = "auto";
  tooltip.dataset.locked = "true";
  recipeKnowledgeTooltipElement = tooltip;
  return tooltip;
}

function isCraftKnowledgeTooltipPinned() {
  return Boolean(
    recipeKnowledgeTooltipElement?.isConnected
    && recipeKnowledgeTooltipElement.classList.contains("locked-tooltip")
    && recipeKnowledgeTooltipElement.classList.contains("fallout-maw-recipe-knowledge-tooltip")
  );
}

function reconcileCraftKnowledgeTooltipState() {
  if (!recipeKnowledgeTooltipElement || recipeKnowledgeTooltipElement.isConnected) return;
  recipeKnowledgeTooltipElement = null;
  recipeKnowledgeTooltipAnchor = null;
  cancelCraftKnowledgeTooltipClose();
}

export function scheduleCraftKnowledgeTooltipClose(anchor, relatedTarget = null) {
  if (!recipeKnowledgeTooltipElement?.isConnected || recipeKnowledgeTooltipAnchor !== anchor) return;
  if (isCraftKnowledgeTooltipPinned()) return;
  if (anchor?.contains?.(relatedTarget)) return;
  cancelCraftKnowledgeTooltipClose();
  recipeKnowledgeTooltipCloseTimer = window.setTimeout(() => {
    recipeKnowledgeTooltipCloseTimer = null;
    if (anchor?.matches?.(":hover")) return;
    removeCraftKnowledgeTooltip();
  }, 160);
}

export function cancelCraftKnowledgeTooltipClose() {
  if (!recipeKnowledgeTooltipCloseTimer) return;
  window.clearTimeout(recipeKnowledgeTooltipCloseTimer);
  recipeKnowledgeTooltipCloseTimer = null;
}

export function removeCraftKnowledgeTooltip(anchor = null) {
  if (anchor && recipeKnowledgeTooltipAnchor !== anchor) return;
  cancelCraftKnowledgeTooltipClose();
  if (isCraftKnowledgeTooltipPinned()) {
    game.tooltip?.dismissLockedTooltip?.(recipeKnowledgeTooltipElement);
  } else if (game.tooltip?.element === recipeKnowledgeTooltipAnchor) game.tooltip.deactivate();
  recipeKnowledgeTooltipElement = null;
  recipeKnowledgeTooltipAnchor = null;
}

function ensureRecipeKnowledgeTooltipListeners() {
  if (recipeKnowledgeTooltipListenersActive || !globalThis.document?.body) return;
  recipeKnowledgeTooltipListenersActive = true;
  document.addEventListener("pointerover", event => {
    const anchor = event.target.closest?.("[data-recipe-knowledge-tooltip-html]");
    if (!anchor || anchor.contains(event.relatedTarget)) return;
    cancelCraftKnowledgeTooltipClose();
    if (recipeKnowledgeTooltipTimer) window.clearTimeout(recipeKnowledgeTooltipTimer);
    recipeKnowledgeTooltipPendingAnchor = anchor;
    if (isCraftKnowledgeTooltipOpen()) {
      activateCraftKnowledgeTooltip(anchor, anchor.dataset.recipeKnowledgeTooltipHtml);
      return;
    }
    recipeKnowledgeTooltipTimer = window.setTimeout(() => {
      recipeKnowledgeTooltipTimer = null;
      if (recipeKnowledgeTooltipPendingAnchor !== anchor || !anchor.isConnected) return;
      activateCraftKnowledgeTooltip(anchor, anchor.dataset.recipeKnowledgeTooltipHtml);
    }, 500);
  }, true);
  document.addEventListener("pointerout", event => {
    const anchor = event.target.closest?.("[data-recipe-knowledge-tooltip-html]");
    if (!anchor || anchor.contains(event.relatedTarget)) return;
    if (recipeKnowledgeTooltipTimer) window.clearTimeout(recipeKnowledgeTooltipTimer);
    recipeKnowledgeTooltipTimer = null;
    if (recipeKnowledgeTooltipPendingAnchor === anchor) recipeKnowledgeTooltipPendingAnchor = null;
    scheduleCraftKnowledgeTooltipClose(anchor, event.relatedTarget);
  }, true);
  document.addEventListener("pointerdown", event => {
    if (event.button !== 1) return;
    const anchor = event.target.closest?.("[data-recipe-knowledge-tooltip-html]");
    if (!anchor) return;
    if (toggleCraftKnowledgeTooltipPin(anchor)) recipeKnowledgeMiddleActiveAnchors.add(anchor);
    event.preventDefault();
  }, true);
  document.addEventListener("auxclick", event => {
    if (event.button !== 1) return;
    const anchor = event.target.closest?.("[data-recipe-knowledge-tooltip-html]");
    if (!anchor) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (recipeKnowledgeMiddleActiveAnchors.has(anchor)) {
      recipeKnowledgeMiddleActiveAnchors.delete(anchor);
      return;
    }
    activateCraftKnowledgeTooltip(anchor, anchor.dataset.recipeKnowledgeTooltipHtml, { locked: true });
  }, true);
}

function renderInventoryTooltipComparisonHTML(itemHTML = "", equippedHTMLs = []) {
  const hoveredLabel = game.i18n.localize("FALLOUTMAW.Common.Inventory");
  const equippedLabel = game.i18n.localize("FALLOUTMAW.Common.Equipped");
  const columns = [
    { label: hoveredLabel, html: itemHTML, className: "" },
    ...equippedHTMLs.map((html, index) => ({
      label: equippedHTMLs.length > 1 ? `${equippedLabel} ${index + 1}` : equippedLabel,
      html,
      className: "equipped"
    }))
  ];
  const manyClass = columns.length > 2 ? " many" : "";
  return `
    <section class="fallout-maw-tooltip-comparison${manyClass}" style="--fallout-maw-tooltip-comparison-columns: ${columns.length};">
      ${columns.map(column => `
        <article class="fallout-maw-tooltip-comparison-column ${column.className}">
          <div class="fallout-maw-tooltip-comparison-label">${escapeHTML(column.label)}</div>
          <div class="fallout-maw-tooltip-comparison-stack">${column.html}</div>
        </article>
      `).join("")}
    </section>
  `;
}

function findComparableEquippedItems(item, actor) {
  if (!item || !actor?.items) return [];
  const equipmentItems = findComparableEquippedEquipmentItems(item, actor);
  if (equipmentItems.length) return equipmentItems;
  return findComparableEquippedWeaponItems(item, actor);
}

function findComparableEquippedEquipmentItems(item, actor) {
  const race = getTooltipActorRace(actor);
  const hoveredSlotKeys = getValidSelectedEquipmentSlotKeys(race, item);
  if (!hoveredSlotKeys.size) return [];
  return getTooltipActorItems(actor).filter(candidate => {
    if (!isComparableEquippedCandidate(candidate, item, "equipment")) return false;
    return hasSetOverlap(hoveredSlotKeys, getValidSelectedEquipmentSlotKeys(race, candidate));
  });
}

function findComparableEquippedWeaponItems(item, actor) {
  if (!getWeaponSlotRequirement(item).selectedKeys.size && !hasItemFunction(item, ITEM_FUNCTIONS.weapon)) return [];
  const race = getTooltipActorRace(actor);
  const inventory = prepareDisplayInventoryContext(actor, race);
  const weaponSets = getSheetHudWeaponSets(inventory);
  const activeSetKey = getActiveTooltipHudWeaponSetKey(actor, weaponSets);
  const activeSet = weaponSets.find(set => set.key === activeSetKey) ?? null;
  if (!activeSet) return [];

  const matchingSlots = (activeSet.slots ?? []).filter(slot => (
    canUseWeaponSlotForItem(race, item, activeSet.key, slot.key)
  ));
  if (!matchingSlots.length) return [];

  const seenItemIds = new Set();
  const items = [];
  for (const slot of matchingSlots) {
    const candidate = actor.items.get(slot.item?.id ?? "");
    if (!isComparableEquippedCandidate(candidate, item, "weapon")) continue;
    if (seenItemIds.has(candidate.id)) continue;
    seenItemIds.add(candidate.id);
    items.push(candidate);
  }
  return items;
}

function markActiveHudWeaponSet(actor, inventory = {}) {
  const weaponSets = getSheetHudWeaponSets(inventory);
  const activeSetKey = getActiveTooltipHudWeaponSetKey(actor, weaponSets);
  if (inventory.naturalWeaponSet) {
    inventory.naturalWeaponSet.active = inventory.naturalWeaponSet.key === activeSetKey;
  }
  for (const set of inventory.weaponSets ?? []) set.active = set.key === activeSetKey;
  return activeSetKey;
}

function getSheetHudWeaponSets(inventory = {}) {
  return [
    ...(inventory.naturalWeaponSet ? [inventory.naturalWeaponSet] : []),
    ...(inventory.weaponSets ?? [])
  ];
}

function getUniqueWeaponSetSlots(slots = []) {
  const seen = new Set();
  const result = [];
  for (const slot of slots ?? []) {
    const id = String(slot.item?.id ?? "");
    if (!id || slot.phantom || seen.has(id)) continue;
    seen.add(id);
    result.push(slot);
  }
  return result;
}

function getActiveTooltipHudWeaponSetKey(actor, weaponSets = []) {
  if (!weaponSets.length) return "";
  const selectedSetKey = String(actor?.getFlag?.(FALLOUT_MAW.id, SELECTED_HUD_WEAPON_SET_FLAG) ?? "");
  if (weaponSets.some(set => set.key === selectedSetKey)) return selectedSetKey;

  const selectedId = String(actor?.getFlag?.(FALLOUT_MAW.id, SELECTED_HUD_WEAPON_FLAG) ?? "");
  const selectedSet = selectedId
    ? weaponSets.find(set => (set.slots ?? []).some(slot => slot.item?.id === selectedId && !slot.phantom))
    : null;
  return selectedSet?.key ?? weaponSets[0].key;
}

function getTooltipActorItems(actor) {
  if (Array.isArray(actor?.items?.contents)) return actor.items.contents;
  if (typeof actor?.items?.values === "function") return Array.from(actor.items.values());
  return [];
}

function isComparableEquippedCandidate(candidate, sourceItem, placementMode = "") {
  if (!candidate || candidate.id === sourceItem?.id) return false;
  if (getItemContainerParentId(candidate)) return false;
  const mode = String(candidate.system?.placement?.mode ?? "");
  if (mode !== placementMode) return false;
  return placementMode === "weapon" || Boolean(candidate.system?.equipped);
}

function hasSetOverlap(left, right) {
  for (const value of left ?? []) {
    if (right?.has(value)) return true;
  }
  return false;
}

function getTooltipActorRace(actor) {
  const raceId = actor?.system?.creature?.raceId;
  return getCreatureOptions().races.find(entry => entry.id === raceId) ?? null;
}

function renderAbilityItemTooltipContentHTML(item, actor, { descriptionHTML = "" } = {}) {
  const functionSections = buildAbilityTooltipFunctionSections(item, actor);
  return `
    <section class="content fallout-maw-ability-tooltip-content">
      ${functionSections}
      <section class="description">${descriptionHTML || "Описание не задано."}</section>
    </section>
  `;
}

function buildAbilityTooltipFunctionSections(item, actor = null) {
  const progressRows = [
    ...getAbilityItemUseProgressEntries(item),
    ...getFixedAbilityFunctionProgressEntries(item),
    ...getEventReactionProgressEntries(item)
  ]
    .map(entry => [entry.label, entry.value ?? `${entry.current} / ${entry.required}`]);
  const hasActiveApplication = normalizeAbilityFunctions(item?.system?.functions ?? [])
    .some(abilityFunction => abilityFunction.type === ABILITY_FUNCTION_TYPES.activeApplication);
  const resourceCostRows = buildAbilityResourceCostRows(item, actor);
  const sections = [
    renderTooltipFunctionSection(
      hasActiveApplication
        ? game.i18n.localize("FALLOUTMAW.Ability.ActiveApplication.ActivationCosts")
        : "Энергия",
      resourceCostRows
    ),
    renderTooltipFunctionSection("Прогресс условий", progressRows)
  ].filter(Boolean);
  if (!sections.length) return "";
  return `<section class="functions">${sections.join("")}</section>`;
}

function buildAbilityResourceCostRows(item, actor = null) {
  if (!actor || item?.type !== "ability") return [];
  const functions = normalizeAbilityFunctions(item.system?.functions ?? []);
  const activeApplicationEntry = functions.find(abilityFunction => abilityFunction.type === ABILITY_FUNCTION_TYPES.activeApplication);
  if (activeApplicationEntry) {
    const settings = normalizeActiveApplicationSettings(activeApplicationEntry.activeSettings);
    return buildActiveApplicationResourceCostRows(item, actor, activeApplicationEntry, settings);
  }
  const entry = functions
    .find(abilityFunction => (
      abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.curseAndBlessing
      || abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.allOrNothing
      || abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.lastChance
      || abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.luckyCoin
      || abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.heightenedConcentration
      || abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.disarm
      || abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.counterAttack
      || abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.counterSniper
      || abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.whereAreYouGoing
      || abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.rage
      || abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.doubleAttack
      || abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.fullForce
      || abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.aiming
      || abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.ricochet
      || abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.keepAway
      || abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.lethalShot
      || abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.lethalStrike
    ));
  if (!entry) return [];
  if (entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.disarm) {
    const settings = normalizeDisarmSettings(entry.fixedSettings);
    const activeBase = Math.max(0, toInteger(settings.activeEnergyCost));
    const reactionBase = Math.max(0, toInteger(settings.reactionEnergyCost));
    return [
      ["Активация: базовый расход", String(activeBase)],
      ["Активация: итог", renderAbilityEnergyCostTotal(item, actor, entry, activeBase)],
      ["Реакция: базовый расход", String(reactionBase)],
      ["Реакция: итог", renderAbilityEnergyCostTotal(item, actor, entry, reactionBase)]
    ];
  }
  if (entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.counterAttack) {
    const settings = normalizeCounterAttackSettings(entry.fixedSettings);
    const reactionBase = Math.max(0, toInteger(settings.reactionEnergyCost));
    return [
      ["Реакция: базовый расход", String(reactionBase)],
      ["Реакция: итог", renderAbilityEnergyCostTotal(item, actor, entry, reactionBase)]
    ];
  }
  if (entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.counterSniper) {
    const settings = normalizeCounterSniperSettings(entry.fixedSettings);
    const reactionBase = Math.max(0, toInteger(settings.reactionEnergyCost));
    return [
      ["Реакция: базовый расход", String(reactionBase)],
      ["Реакция: итог", renderAbilityEnergyCostTotal(item, actor, entry, reactionBase)]
    ];
  }
  if (entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.whereAreYouGoing) {
    const settings = normalizeWhereAreYouGoingSettings(entry.fixedSettings);
    const reactionBase = Math.max(0, toInteger(settings.reactionEnergyCost));
    return [
      ["Реакция: базовый расход", String(reactionBase)],
      ["Реакция: итог", renderAbilityEnergyCostTotal(item, actor, entry, reactionBase)]
    ];
  }
  if (entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.keepAway) {
    const settings = normalizeKeepAwaySettings(entry.fixedSettings);
    const activationBase = Math.max(0, toInteger(settings.activationEnergyCost));
    return [
      ["Активация: базовый расход", String(activationBase)],
      ["Активация: итог", renderAbilityEnergyCostTotal(item, actor, entry, activationBase)],
      ["Перегрузка", `${Math.max(0, toInteger(settings.overloadEnergyCost))} на ${Math.max(0, toInteger(settings.overloadDurationSeconds))} сек.`]
    ];
  }
  if (entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.ricochet) {
    const settings = normalizeRicochetSettings(entry.fixedSettings);
    const activationBase = Math.max(0, toInteger(settings.activationEnergyCost));
    return [
      ["Активация: базовый расход", String(activationBase)],
      ["Активация: итог", renderAbilityEnergyCostTotal(item, actor, entry, activationBase)],
      ["Перегрузка", `${Math.max(0, toInteger(settings.overloadEnergyCost))} на ${Math.max(0, toInteger(settings.overloadDurationSeconds))} сек.`]
    ];
  }
  if ([ABILITY_FIXED_FUNCTION_KEYS.lethalShot, ABILITY_FIXED_FUNCTION_KEYS.lethalStrike].includes(entry.fixedKey)) {
    const settings = normalizeLethalAttackSettings(entry.fixedSettings);
    const activationBase = Math.max(0, toInteger(settings.activationEnergyCost));
    return [
      ["Активация: базовый расход", String(activationBase)],
      ["Активация: итог", renderAbilityEnergyCostTotal(item, actor, entry, activationBase)],
      ["Перегрузка", `${Math.max(0, toInteger(settings.overloadEnergyCost))} на ${Math.max(0, toInteger(settings.overloadDurationSeconds))} сек.`],
      ["Бонус урона", `+${Math.max(0, toInteger(settings.damagePercentBonus))}%`],
      ["Ожидание атаки", `${Math.max(0, toInteger(settings.attackWaitDurationSeconds))} сек.`]
    ];
  }
  const settings = entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.allOrNothing
    ? normalizeAllOrNothingSettings(entry.fixedSettings)
    : entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.lastChance
      ? normalizeLastChanceSettings(entry.fixedSettings)
      : entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.luckyCoin
        ? normalizeLuckyCoinSettings(entry.fixedSettings)
        : entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.heightenedConcentration
          ? normalizeHeightenedConcentrationSettings(entry.fixedSettings)
          : entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.rage
            ? normalizeRageSettings(entry.fixedSettings)
            : entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.doubleAttack
              ? normalizeDoubleAttackSettings(entry.fixedSettings)
              : entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.fullForce
                ? normalizeFullForceSettings(entry.fixedSettings)
                : entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.aiming
                  ? normalizeAimingSettings(entry.fixedSettings)
                  : normalizeCurseAndBlessingSettings(entry.fixedSettings);
  const multiplier = entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.doubleAttack
    ? Math.max(1, toInteger(settings.duplicateCount))
    : 1;
  const base = Math.max(0, toInteger(settings.energyCost)) * multiplier;
  return [
    ["Базовый расход", String(base)],
    ["Итог", renderAbilityEnergyCostTotal(item, actor, entry, Math.max(0, toInteger(settings.energyCost)), { multiplier })]
  ];
}

function buildActiveApplicationResourceCostRows(item, actor, abilityFunction, settings = {}) {
  const costs = Array.isArray(settings.costs) ? settings.costs : Object.values(settings.costs ?? {});
  if (!costs.length) return [];

  const resourceLabels = getAbilityTooltipResourceLabels();
  const sourceLabel = game.i18n.localize("FALLOUTMAW.Ability.ActiveApplication.CostPayerSource");
  const targetsLabel = game.i18n.localize("FALLOUTMAW.Ability.ActiveApplication.CostPayerTargets");
  const sourceCosts = costs.filter(cost => cost.payer !== ABILITY_ACTIVE_APPLICATION_COST_PAYERS.targets);
  const targetCosts = costs.filter(cost => cost.payer === ABILITY_ACTIVE_APPLICATION_COST_PAYERS.targets);
  const plans = [];

  if (settings.targetMode === ABILITY_ACTIVE_APPLICATION_TARGET_MODES.self) {
    const payerLabel = sourceCosts.length && targetCosts.length
      ? `${sourceLabel} / ${targetsLabel}`
      : (targetCosts.length ? targetsLabel : sourceLabel);
    plans.push({ costs, payerLabel, evaluateForActor: true });
  } else {
    if (sourceCosts.length) plans.push({ costs: sourceCosts, payerLabel: sourceLabel, evaluateForActor: true });
    if (targetCosts.length) plans.push({ costs: targetCosts, payerLabel: targetsLabel, evaluateForActor: false });
  }

  const rows = plans.flatMap(plan => buildActiveApplicationPayerCostRows(
    item,
    actor,
    abilityFunction,
    plan,
    resourceLabels
  ));
  rows.push(...buildActiveApplicationConfiguredOverloadRows(costs, resourceLabels));
  return rows;
}

function getAbilityTooltipResourceLabels() {
  const labels = new Map(getResourceSettings().map(resource => [resource.key, resource.label]));
  labels.set(
    "reactionPoints",
    game.i18n.localize("FALLOUTMAW.Events.Reaction.Resources.ReactionPoints")
  );
  return labels;
}

function buildActiveApplicationPayerCostRows(item, actor, abilityFunction, plan = {}, resourceLabels = new Map()) {
  const baseRows = Array.isArray(plan.costs) ? plan.costs : Object.values(plan.costs ?? {});
  if (!baseRows.length) return [];
  if (plan.evaluateForActor === false) {
    return baseRows.map(row => {
      const resourceKey = String(row?.resourceKey ?? "").trim();
      const resourceLabel = resourceLabels.get(resourceKey) ?? resourceKey;
      return [
        `${resourceLabel} — ${plan.payerLabel}`,
        formatActorFormulaForDisplay(row?.formula ?? "0", null, { includeValues: false })
      ];
    });
  }

  // Runtime prepares the same payer-owned vector before the registry evaluates
  // each formula. In particular, accumulated overload is appended once per
  // resource rather than once per configured cost row.
  const effectiveBaseRows = baseRows.filter(row => !isAbilityOverloadReactionCostId(row?.id));
  const preparedRows = withAbilityOverloadCostRows(actor, item, abilityFunction, effectiveBaseRows);
  const groups = buildAbilityTooltipCostGroups(effectiveBaseRows, preparedRows, {
    evaluateRow: row => evaluateAbilityTooltipResourceCostRow(actor, item, row)
  });

  return groups.map(group => {
    const resourceLabel = resourceLabels.get(group.resourceKey) ?? group.resourceKey;
    const { base, total } = group;
    const label = `${resourceLabel} — ${plan.payerLabel}`;
    if (total === base) return [label, String(total)];
    const breakdown = buildActiveApplicationResourceCostBreakdown(item, actor, {
      title: label,
      resourceKey: group.resourceKey,
      base,
      total,
      baseRows: group.baseRows
    });
    return [label, renderChangedNumber(total, base, { higherIsBetter: false, breakdown })];
  });
}

function evaluateAbilityTooltipResourceCostRow(actor, item, row = {}) {
  const resourceKey = String(row?.resourceKey ?? "").trim();
  if (!resourceKey || !isAbilityResourceCostActive(actor, resourceKey)) return 0;
  return Math.max(0, Math.trunc(evaluateActorFormula(row.formula, actor, {
    fallback: 0,
    minimum: 0,
    context: `${item?.name ?? "ability"} tooltip resource cost (${resourceKey})`
  })));
}

function buildActiveApplicationResourceCostBreakdown(item, actor, {
  title = "",
  resourceKey = "",
  base = 0,
  total = 0,
  baseRows = []
} = {}) {
  const formulas = baseRows
    .map(row => String(row?.formula ?? "0").trim() || "0")
    .map(formula => `(${formatActorFormulaForDisplay(formula, actor, { includeValues: true })})`)
    .join(" + ");
  const breakdown = {
    title,
    actorName: actor?.name,
    img: item?.img,
    base: {
      name: item?.name,
      img: item?.img,
      value: base,
      ...(formulas ? { valueLabel: `${formulas} = ${formatNumber(base)}` } : {})
    },
    sources: [],
    total: base,
    formatValue: formatNumber
  };
  for (const source of getAbilityOverloadResourceCostSources(actor, item, resourceKey)) {
    appendBreakdownStep(breakdown, source, { minimum: 0 });
  }
  reconcileBreakdownTotal(breakdown, total, item);
  return breakdown;
}

function buildActiveApplicationConfiguredOverloadRows(costs = [], resourceLabels = new Map()) {
  return costs.flatMap(cost => {
    const amount = Math.max(0, toInteger(cost?.overloadAmount));
    const durationSeconds = Math.max(0, toInteger(cost?.overloadDurationSeconds));
    if (!amount || !durationSeconds) return [];
    const payerKey = cost.payer === ABILITY_ACTIVE_APPLICATION_COST_PAYERS.targets
      ? "FALLOUTMAW.Ability.ActiveApplication.CostPayerTargets"
      : "FALLOUTMAW.Ability.ActiveApplication.CostPayerSource";
    const payerLabel = game.i18n.localize(payerKey);
    const resourceKey = String(cost?.resourceKey ?? "").trim();
    const resourceLabel = resourceLabels.get(resourceKey) ?? resourceKey;
    return [[
      `Перегрузка — ${payerLabel}`,
      `${resourceLabel}: ${amount} на ${formatDurationShort(durationSeconds)}`
    ]];
  });
}

function renderAbilityEnergyCostTotal(item, actor, entry, baseCost = 0, { multiplier = 1 } = {}) {
  const safeMultiplier = Math.max(1, toInteger(multiplier));
  const base = Math.max(0, toInteger(baseCost)) * safeMultiplier;
  const total = getFixedAbilityEnergyCost(actor, item, entry, Math.max(0, toInteger(baseCost))) * safeMultiplier;
  if (total === base) return String(total);
  const breakdown = {
    title: localizeOrFallback("FALLOUTMAW.Item.TooltipBreakdownAbilityCost", "Расход энергии способности"),
    actorName: actor?.name,
    img: item?.img,
    base: { name: item?.name, img: item?.img, value: base },
    sources: [],
    total: base,
    formatValue: formatNumber
  };
  for (const source of getAbilityOverloadResourceCostSources(actor, item)) {
    appendBreakdownStep(breakdown, {
      ...source,
      value: Math.max(0, Number(source.value) || 0) * safeMultiplier
    }, { minimum: 0 });
  }
  reconcileBreakdownTotal(breakdown, total, item);
  return renderChangedNumber(total, base, { higherIsBetter: false, breakdown });
}

function renderInventoryItemTooltipContentHTML(item, sourceActor, {
  activeWeaponIndex = 0,
  baseMode = false,
  descriptionHTML = "",
  evaluatingActor = sourceActor,
  includeRecipeKnowledge = true,
  recipeKnowledgePreviews = new Map()
} = {}) {
  const currencySettings = getCurrencySettings();
  const currency = currencySettings.find(entry => entry.key === item.system?.priceCurrency);
  const quantity = Math.max(1, toInteger(item.system?.quantity));
  const unitWeight = Number(item.system?.weight) || 0;
  const unitPrice = Number(item.system?.price) || 0;
  const totalWeight = Number(getItemTotalWeight(item, sourceActor?.items).toFixed(1));
  const totalPrice = unitPrice * quantity;
  const weightLabel = formatUnitAndTotal(unitWeight, totalWeight, quantity, game.i18n.localize("FALLOUTMAW.Common.Kg"));
  const priceHTML = renderTooltipPriceValue(unitPrice, totalPrice, quantity, currency);
  const armedStatus = renderArmedDelayedExplosionStatus(item);
  const functionSections = buildInventoryTooltipFunctionSections(item, sourceActor, {
    activeWeaponIndex,
    baseMode,
    evaluatingActor,
    includeRecipeKnowledge,
    recipeKnowledgePreviews
  });
  return `
    <section class="content">
      <section class="header">
        <div class="top">
          <div class="name">${escapeHTML(item.name)}</div>
        </div>
        <div class="bottom">
          <div class="metric">${game.i18n.localize("FALLOUTMAW.Item.Weight")}: ${weightLabel}</div>
          <div class="metric price-metric">${priceHTML}</div>
        </div>
      </section>
      ${armedStatus}
      ${functionSections}
      ${descriptionHTML ? `<section class="description">${descriptionHTML}</section>` : ""}
    </section>
  `;
}

function renderArmedDelayedExplosionStatus(item = null) {
  const state = item?.getFlag?.(FALLOUT_MAW.id, DELAYED_THROWN_ITEM_FLAG);
  const explodeAtWorldTime = Number(state?.explodeAtWorldTime);
  if (!state?.id || !Number.isFinite(explodeAtWorldTime)) return "";
  const remainingSeconds = Math.max(0, Math.ceil(explodeAtWorldTime - (Number(game.time?.worldTime) || 0)));
  return `
    <section class="fallout-maw-tooltip-armed-status" data-armed-explode-at="${explodeAtWorldTime}">
      <strong>${escapeHTML(game.i18n.localize("FALLOUTMAW.Item.WeaponArmed"))}</strong>
      <span data-armed-time-remaining>${escapeHTML(game.i18n.localize("FALLOUTMAW.Item.WeaponExplosionTimeRemaining"))}: ${remainingSeconds} ${escapeHTML(game.i18n.localize("FALLOUTMAW.Common.SecondsShort"))}</span>
    </section>
  `;
}

function formatWeight(value) {
  const numeric = Number(value) || 0;
  if (Number.isInteger(numeric)) return String(numeric);
  return numeric.toFixed(1).replace(/\.0$/, "");
}

function formatNumber(value) {
  const numeric = Number(value) || 0;
  if (Number.isInteger(numeric)) return String(numeric);
  return numeric.toFixed(2).replace(/\.?0+$/, "");
}

function formatSignedNumber(value) {
  const numeric = Number(value) || 0;
  return numeric > 0 ? `+${formatNumber(numeric)}` : formatNumber(numeric);
}

function formatUnitAndTotal(unitValue, totalValue, quantity = 1, suffix = "") {
  const suffixText = String(suffix ?? "").trim();
  const values = quantity > 1
    ? `${formatNumber(unitValue)} / ${formatNumber(totalValue)}`
    : formatNumber(unitValue);
  return suffixText ? `${values} ${suffixText}` : values;
}

function renderTooltipPriceValue(unitValue, totalValue, quantity = 1, currency = null) {
  const value = quantity > 1
    ? `${formatNumber(unitValue)} / ${formatNumber(totalValue)}`
    : formatNumber(unitValue);
  const icon = String(currency?.img || "icons/svg/coins.svg").trim();
  const label = String(currency?.label ?? "").trim();
  return `
    <span class="metric-value">${escapeHTML(value)}</span>
    <span class="currency-inline-icon">${icon ? `<img src="${escapeAttribute(icon)}" alt="${escapeAttribute(label)}">` : ""}</span>
  `;
}

function renderTooltipMeterValue(value, max = 0) {
  const safeValue = Math.max(0, toInteger(value));
  const safeMax = Math.max(0, toInteger(max));
  const text = safeMax ? `${safeValue} / ${safeMax}` : String(safeValue);
  if (!safeMax) return text;
  const percent = Math.max(0, Math.min(100, (safeValue / safeMax) * 100));
  const stateClass = percent >= 80 ? "high" : percent >= 30 ? "medium" : "low";
  return {
    html: `
      <span class="function-meter-value">${escapeHTML(text)}</span>
      <span class="function-meter-track ${stateClass}" aria-hidden="true">
        <span class="function-meter-fill" style="width: ${formatNumber(percent)}%;"></span>
      </span>
    `
  };
}

function buildInventoryTooltipFunctionSections(item, sourceActor, {
  activeWeaponIndex = 0,
  baseMode = false,
  evaluatingActor = sourceActor,
  includeRecipeKnowledge = true,
  recipeKnowledgePreviews = new Map()
} = {}) {
  const sections = [
    buildContainerTooltipSection(item, sourceActor),
    buildConditionTooltipSection(item),
    buildFirstAidTooltipSection(item, evaluatingActor),
    buildNeedChangeTooltipSection(item, evaluatingActor),
    buildOneTimeUseTooltipSection(item, evaluatingActor, { includeRecipeKnowledge, recipeKnowledgePreviews }),
    buildDamageMitigationTooltipSection(item, evaluatingActor),
    buildDamageSourceTooltipSection(item, evaluatingActor),
    buildEnergySourceTooltipSection(item),
    buildEnergyConsumerTooltipSection(item),
    buildLightSourceTooltipSection(item),
    buildModuleTooltipSection(item, evaluatingActor),
    buildConstructPartTooltipSection(item),
    buildProsthesisTooltipSection(item, evaluatingActor),
    ...buildWeaponTooltipSections(item, activeWeaponIndex, { sourceActor, evaluatingActor, baseMode }),
    ...buildToolTooltipSections(item)
  ].filter(Boolean);
  if (!sections.length) return "";
  return `<section class="functions">${sections.join("")}</section>`;
}

function buildContainerTooltipSection(item, actor) {
  if (!hasItemFunction(item, ITEM_FUNCTIONS.container, { ignoreBroken: true })) return "";
  const system = item.system ?? {};
  const rows = [
    ["Размер", `${toInteger(system.container?.columns)} x ${toInteger(system.container?.rows)}`],
    ["Нагруженность", `${formatWeight(getContainerContentsWeight(item, actor?.items))} / ${formatWeight(getContainerMaxLoad(item))} ${game.i18n.localize("FALLOUTMAW.Common.Kg")}`]
  ];
  const extraWeaponSlots = toInteger(system.functions?.container?.extraWeaponSlots);
  const loadReduction = Math.max(0, Math.min(100, Number(system.functions?.container?.loadReduction) || 0));
  if (extraWeaponSlots) rows.push([game.i18n.localize("FALLOUTMAW.Item.ContainerExtraWeaponSlots"), extraWeaponSlots]);
  if (loadReduction) rows.push([game.i18n.localize("FALLOUTMAW.Item.ContainerLoadReduction"), `${loadReduction}%`]);
  return renderTooltipFunctionSection(game.i18n.localize("FALLOUTMAW.Item.FunctionContainer"), rows);
}

function buildConditionTooltipSection(item) {
  if (!hasItemFunction(item, ITEM_FUNCTIONS.condition, { ignoreBroken: true })) return "";
  const condition = getConditionFunction(item);
  const max = Math.max(0, toInteger(condition.max));
  const value = Math.max(0, toInteger(condition.value));
  const rows = [
    [game.i18n.localize("FALLOUTMAW.Item.ConditionValue"), renderTooltipMeterValue(value, max)],
    [game.i18n.localize("FALLOUTMAW.Item.ConditionWeakeningThreshold"), Math.max(1, toInteger(condition.weakeningThreshold) || 10)]
  ];
  rows.push(...getConditionRecoveryMethodRows(condition));
  return renderTooltipFunctionSection(game.i18n.localize("FALLOUTMAW.Item.FunctionCondition"), rows);
}

function buildFirstAidTooltipSection(item, actor = null) {
  if (!hasItemFunction(item, ITEM_FUNCTIONS.firstAid, { ignoreBroken: true })) return "";
  const firstAid = getFirstAidFunction(item);
  const charges = getFirstAidChargesData(item);
  const rows = [
    [game.i18n.localize("FALLOUTMAW.Item.FirstAidCharges"), renderTooltipMeterValue(charges.value, charges.max)]
  ];
  const outgoingPercent = getActorHealingModifierPercent(actor, "outgoing");
  const outgoingMultiplier = Math.max(0, 1 + (outgoingPercent / 100));
  const actionPointCost = Math.max(0, toInteger(firstAid.actionPointCost));
  if (actionPointCost) rows.push([game.i18n.localize("FALLOUTMAW.Item.FirstAidActionPointCost"), actionPointCost]);
  const healing = Math.max(0, toInteger(firstAid.healing));
  if (healing) {
    const effectiveHealing = firstAid.healingIsPercentage
      ? healing * outgoingMultiplier
      : scaleFirstAidTooltipHealing(healing, outgoingMultiplier);
    const breakdown = buildFirstAidHealingAttribution(item, actor, healing, effectiveHealing, {
      isPercentage: firstAid.healingIsPercentage
    });
    rows.push([
      game.i18n.localize("FALLOUTMAW.Item.FirstAidHealing"),
      firstAid.healingIsPercentage
        ? renderChangedPercentValue(effectiveHealing, healing, { breakdown })
        : renderChangedNumber(effectiveHealing, healing, { breakdown })
    ]);
  }
  const limbCount = Math.max(0, Math.min(charges.value, charges.max, toInteger(firstAid.limbSelection?.count)));
  const limbValue = toInteger(firstAid.limbSelection?.value);
  if (limbCount && limbValue) {
    const limbLabel = game.i18n.localize("FALLOUTMAW.Item.FirstAidLimbHealingPerCharge");
    const effectiveLimbValue = limbValue > 0
      ? scaleFirstAidTooltipHealing(limbValue, outgoingMultiplier, { zeroWhenDisabled: true })
      : limbValue;
    rows.push([limbLabel, limbValue > 0
      ? renderChangedSignedNumber(effectiveLimbValue, limbValue, {
        breakdown: buildFirstAidHealingAttribution(item, actor, limbValue, effectiveLimbValue, { title: limbLabel })
      })
      : formatSignedNumber(limbValue)]);
    rows.push([game.i18n.localize("FALLOUTMAW.Item.FirstAidChargeLimitPerUse"), limbCount]);
  }
  rows.push(...getFirstAidRemoveEffectTooltipRows(firstAid));
  rows.push(...getFirstAidNeedTooltipRows(firstAid));
  const changeRows = getFirstAidChangeTooltipRows(firstAid, actor, item);
  const durationSeconds = Math.max(0, toInteger(firstAid.durationSeconds));
  if (durationSeconds && changeRows.length) {
    rows.push([game.i18n.localize("FALLOUTMAW.Item.FirstAidDuration"), formatDurationShort(durationSeconds)]);
  }
  rows.push(...changeRows);
  const maxDistance = Number(firstAid.maxDistance) || 0;
  if (maxDistance) rows.push([game.i18n.localize("FALLOUTMAW.Item.FirstAidMaxDistance"), formatNumber(maxDistance)]);
  const difficulty = Math.max(0, toInteger(firstAid.difficulty));
  if (difficulty) rows.push([game.i18n.localize("FALLOUTMAW.Item.FirstAidDifficulty"), difficulty]);
  const criticalSuccess = Math.max(0, toInteger(firstAid.criticalSuccessHealingBonus));
  if (criticalSuccess) rows.push([game.i18n.localize("FALLOUTMAW.Item.FirstAidCriticalSuccessBonus"), `${criticalSuccess}%`]);
  const criticalMin = Math.max(0, toInteger(firstAid.criticalFailureDamageMin));
  const criticalMax = Math.max(criticalMin, toInteger(firstAid.criticalFailureDamageMax));
  if (criticalMin || criticalMax) rows.push([game.i18n.localize("FALLOUTMAW.Item.FirstAidCriticalFailureDamageMax"), `${criticalMin}-${criticalMax}`]);
  const withdrawalChangeRows = getFirstAidWithdrawalChangeTooltipRows(firstAid, actor, item);
  const withdrawalDurationSeconds = Math.max(0, toInteger(firstAid.withdrawalDurationSeconds));
  if (withdrawalDurationSeconds) {
    rows.push([game.i18n.localize("FALLOUTMAW.Item.FirstAidWithdrawalDuration"), formatDurationShort(withdrawalDurationSeconds)]);
  }
  rows.push(...withdrawalChangeRows);
  return renderTooltipFunctionSection(game.i18n.localize("FALLOUTMAW.Item.FunctionFirstAid"), rows);
}

function scaleFirstAidTooltipHealing(value = 0, multiplier = 1, { zeroWhenDisabled = false } = {}) {
  const base = Number(value) || 0;
  if (!base) return 0;
  const safeMultiplier = Math.max(0, Number(multiplier) || 0);
  if (zeroWhenDisabled && safeMultiplier <= 0) return 0;
  return scaleFirstAidSignedValue(base, safeMultiplier);
}

function scaleFirstAidTooltipHealingChange(value = 0, multiplier = 1) {
  const safeMultiplier = Math.max(0, Number(multiplier) || 0);
  if (safeMultiplier <= 0) return 0;
  if (safeMultiplier === 1) return toInteger(value);
  return toInteger(scaleFirstAidTooltipHealing(value, safeMultiplier, { zeroWhenDisabled: true }));
}

function buildFirstAidHealingAttribution(item, actor, base = 0, total = 0, { isPercentage = false, title = "" } = {}) {
  const formatValue = isPercentage
    ? value => `${formatNumber(value)}%`
    : formatNumber;
  const breakdown = {
    title: title || game.i18n.localize("FALLOUTMAW.Item.FirstAidHealing"),
    actorName: actor?.name,
    img: item?.img,
    base: { name: item?.name, img: item?.img, value: base },
    sources: [],
    total: base,
    formatValue
  };
  const modifier = collectActorPreparedPathAttribution(actor, "system.healing.outgoingPercent", {
    preparedValue: getActorHealingModifierPercent(actor, "outgoing"),
    suffix: "%"
  });
  appendParallelPercentSources(breakdown, modifier.sources, {
    expectedPercent: modifier.value,
    total,
    contributionUnit: isPercentage
      ? "%"
      : localizeOrFallback("FALLOUTMAW.Item.TooltipBreakdownHealingUnit", "лечения")
  });
  return breakdown;
}

function buildNeedChangeTooltipSection(item, actor = null) {
  if (!hasItemFunction(item, ITEM_FUNCTIONS.needChange, { ignoreBroken: true })) return "";
  const needChange = getNeedChangeFunction(item);
  const charges = getActiveItemChargesData(item);
  const rows = [
    [game.i18n.localize("FALLOUTMAW.Item.FirstAidCharges"), renderTooltipMeterValue(charges.value, charges.max)]
  ];
  rows.push(...getConfiguredNeedTooltipRows(needChange.needs, actor));
  rows.push(...getNeedChangeDamageTooltipRows(needChange.damages));
  rows.push(...getNeedChangeOrganismDevelopmentTooltipRows(needChange.organismDevelopment));
  const healthRecovery = Math.max(0, toInteger(needChange.healthRecovery));
  if (healthRecovery > 0) {
    rows.push([[game.i18n.localize("FALLOUTMAW.Item.NeedChangeHealthRecovery"), String(healthRecovery)]]);
  }
  const changeRows = getFirstAidEffectChangeTooltipRows(needChange.changes, actor, "FALLOUTMAW.Item.FirstAidEffectChanges");
  const durationSeconds = Math.max(0, toInteger(needChange.durationSeconds));
  if (durationSeconds && changeRows.length) {
    rows.push([game.i18n.localize("FALLOUTMAW.Item.FirstAidDuration"), formatDurationShort(durationSeconds)]);
  }
  rows.push(...changeRows);
  return renderTooltipFunctionSection("Изменение потребностей", rows);
}

function getNeedChangeOrganismDevelopmentTooltipRows(entries = []) {
  const labels = new Map(getCharacteristicSettings().map(entry => [entry.key, entry.label ?? entry.key]));
  const values = (Array.isArray(entries) ? entries : [])
    .map(entry => {
      const key = String(entry?.characteristicKey ?? "").trim();
      const value = Number(entry?.value);
      if (!key || !Number.isFinite(value) || value <= 0) return "";
      const formatted = Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
      return `${labels.get(key) ?? key}: +${formatted}`;
    })
    .filter(Boolean);
  return values.length
    ? [[game.i18n.localize("FALLOUTMAW.Item.NeedChangeOrganismDevelopment"), { html: renderTooltipValueTokens(values) }]]
    : [];
}

function getNeedChangeDamageTooltipRows(damages = []) {
  const labels = new Map(getDamageTypeSettings().map(entry => [entry.key, entry.label ?? entry.key]));
  const values = (Array.isArray(damages) ? damages : [])
    .map(entry => {
      const key = String(entry?.damageTypeKey ?? "").trim();
      const value = Math.max(0, toInteger(entry?.value));
      if (!key || !value) return "";
      return `${labels.get(key) ?? key}: ${value}`;
    })
    .filter(Boolean);
  return values.length
    ? [[game.i18n.localize("FALLOUTMAW.Item.NeedChangeDamage"), { html: renderTooltipValueTokens(values) }]]
    : [];
}

function buildOneTimeUseTooltipSection(item, actor = null, { includeRecipeKnowledge = true, recipeKnowledgePreviews = new Map() } = {}) {
  if (!hasItemFunction(item, ITEM_FUNCTIONS.oneTimeUse, { ignoreBroken: true })) return "";
  const oneTimeUse = getOneTimeUseFunction(item);
  const rows = [];
  if (Boolean(oneTimeUse.repeatApplicationBlocked)) {
    const studiedEffect = actor ? findOneTimeUseStudiedEffect(actor) : null;
    const alreadyApplied = Boolean(actor) && isOneTimeUseRepeatBlocked(oneTimeUse, studiedEffect, item.name);
    rows.push([
      game.i18n.localize("FALLOUTMAW.Item.OneTimeUseAlreadyApplied"),
      game.i18n.localize(alreadyApplied ? "FALLOUTMAW.Common.Yes" : "FALLOUTMAW.Common.No")
    ]);
  }
  if (includeRecipeKnowledge) {
    const recipeItems = (oneTimeUse.recipeItemUuids ?? [])
      .map(uuid => resolveCraftKnowledgeItem(uuid))
      .filter(item => item && hasCraftKnowledgeData(item));
    if (recipeItems.length) {
      rows.push([
        game.i18n.localize("FALLOUTMAW.Item.OneTimeUseRecipeKnowledge"),
        {
          html: `<span class="fallout-maw-recipe-knowledge-chip-list">${recipeItems.map(recipeItem => {
            const preview = recipeKnowledgePreviews.get(recipeItem.uuid) ?? "";
            const known = actorKnowsCraftItem(actor, recipeItem);
            return `<span class="fallout-maw-recipe-knowledge-chip ${known ? "known" : "unknown"}"
              ${preview ? `data-recipe-knowledge-tooltip-html="${escapeAttribute(preview)}"` : ""}>
              <img src="${escapeAttribute(recipeItem.img || "icons/svg/item-bag.svg")}" alt="">
              <span>${escapeHTML(recipeItem.name)}</span>
              <i class="fa-solid ${known ? "fa-book-open" : "fa-book"}"></i>
            </span>`;
          }).join("")}</span>`
        }
      ]);
    }
  }
  rows.push(...getFirstAidEffectChangeTooltipRows(oneTimeUse.changes, actor, "FALLOUTMAW.Item.OneTimeUseChanges"));
  if (!rows.length) return "";
  return renderTooltipFunctionSection(game.i18n.localize("FALLOUTMAW.Item.FunctionOneTimeUse"), rows);
}

function getFirstAidNeedTooltipRows(firstAid = {}) {
  return getConfiguredNeedTooltipRows(firstAid.needs);
}

function getConfiguredNeedTooltipRows(needs = [], actor = null) {
  const needLabels = new Map([
    ...getNeedSettings().map(need => [need.key, need.label ?? need.key]),
    ...getActorNeedSettings(actor).map(need => [need.key, need.label ?? need.key])
  ]);
  const source = Array.isArray(needs)
    ? needs
    : Object.entries(needs ?? {}).map(([needKey, value]) => ({ needKey, value }));
  const values = source
    .map(entry => {
      const key = String(entry?.needKey ?? "").trim();
      const value = toInteger(entry?.value);
      if (!key || !value) return "";
      return `${needLabels.get(key) ?? key}: ${formatSignedNumber(value)}`;
    })
    .filter(Boolean);
  return values.length
    ? [[game.i18n.localize("FALLOUTMAW.Item.FirstAidNeeds"), { html: renderTooltipValueTokens(values) }]]
    : [];
}

function getFirstAidRemoveEffectTooltipRows(firstAid = {}) {
  const source = Array.isArray(firstAid.removeEffects)
    ? firstAid.removeEffects
    : Object.entries(firstAid.removeEffects ?? {}).map(([damageTypeKey]) => ({ damageTypeKey }));
  const labels = new Map(getDamageTypeSettings().map(damageType => [
    damageType.key,
    damageType.label || damageType.key
  ]));
  const values = Array.from(new Set(source
    .map(entry => String(entry?.damageTypeKey ?? entry?.key ?? "").trim())
    .filter(Boolean)))
    .map(key => labels.get(key) ?? key);
  return values.length
    ? [[game.i18n.localize("FALLOUTMAW.Item.FirstAidRemoveEffects"), { html: renderTooltipValueTokens(values) }]]
    : [];
}

function getFirstAidChangeTooltipRows(firstAid = {}, actor = null, item = null) {
  return getFirstAidEffectChangeTooltipRows(firstAid.changes, actor, "FALLOUTMAW.Item.FirstAidEffectChanges", {
    applyOutgoingHealing: true,
    item
  });
}

function getFirstAidWithdrawalChangeTooltipRows(firstAid = {}, actor = null, item = null) {
  return getFirstAidEffectChangeTooltipRows(firstAid.withdrawal, actor, "FALLOUTMAW.Item.FirstAidWithdrawalChanges", {
    applyOutgoingHealing: true,
    item,
    prefixHealingLabel: true
  });
}

function getFirstAidEffectChangeTooltipRows(changes = [], actor = null, labelKey = "FALLOUTMAW.Item.FirstAidEffectChanges", {
  applyOutgoingHealing = false,
  item = null,
  prefixHealingLabel = false
} = {}) {
  const sourceChanges = Array.isArray(changes) ? changes : Object.values(changes ?? {});
  const healingChanges = applyOutgoingHealing
    ? sourceChanges.filter(change => isFirstAidTooltipHealingChange(change))
    : [];
  const effectChanges = healingChanges.length
    ? sourceChanges.filter(change => !isFirstAidTooltipHealingChange(change))
    : sourceChanges;
  const pathLabels = buildEffectPathLabelMap({
    characteristicSettings: getCharacteristicSettings(),
    resourceSettings: getResourceSettings(),
    needSettings: getNeedSettings(),
    proficiencySettings: getProficiencySettings(),
    skillSettings: getSkillSettings(),
    damageTypeSettings: getDamageTypeSettings(),
    limbs: Object.entries(actor?.system?.limbs ?? {}).map(([key, limb]) => ({
      key,
      label: limb?.label ?? key
    }))
  });
  const summaries = prepareTraumaEffectEntries(effectChanges, pathLabels)
    .map(entry => entry.summary)
    .filter(Boolean);
  const rows = summaries.length
    ? [[game.i18n.localize(labelKey), { html: renderTooltipValueTokens(summaries) }]]
    : [];
  if (!healingChanges.length) return rows;

  const outgoingPercent = getActorHealingModifierPercent(actor, "outgoing");
  const outgoingMultiplier = Math.max(0, 1 + (outgoingPercent / 100));
  const baseHealing = Math.max(0, healingChanges.reduce((total, change) => total + toInteger(change?.value), 0));
  const effectiveHealing = outgoingMultiplier <= 0
    ? 0
    : Math.max(0, healingChanges.reduce((total, change) => (
      total + scaleFirstAidTooltipHealingChange(change?.value, outgoingMultiplier)
    ), 0));
  if (!baseHealing && !effectiveHealing) return rows;

  const healingName = game.i18n.localize("FALLOUTMAW.Item.FirstAidHealingPerTick");
  const healingLabel = prefixHealingLabel
    ? `${game.i18n.localize(labelKey)} — ${healingName}`
    : healingName;
  rows.push([healingLabel, renderChangedNumber(effectiveHealing, baseHealing, {
    breakdown: buildFirstAidHealingAttribution(item, actor, baseHealing, effectiveHealing, { title: healingLabel })
  })]);
  return rows;
}

function isFirstAidTooltipHealingChange(change = {}) {
  const key = String(change?.key ?? "").trim().toLocaleLowerCase();
  return key === "fallout-maw.healing" || key === "healing";
}

function buildDamageMitigationTooltipSection(item, actor) {
  if (!hasItemFunction(item, ITEM_FUNCTIONS.damageMitigation, { ignoreBroken: true })) return "";
  const mitigation = getDamageMitigationFunction(item);
  const mode = String(mitigation.mode || DAMAGE_MITIGATION_MODES.defense);
  const modeLabel = mode === DAMAGE_MITIGATION_MODES.resistance
    ? game.i18n.localize("FALLOUTMAW.Item.MitigationModeResistance")
    : game.i18n.localize("FALLOUTMAW.Item.MitigationModeDefense");
  const rows = [[game.i18n.localize("FALLOUTMAW.Item.MitigationMode"), modeLabel]];
  const tableHTML = renderDamageMitigationTooltipTables(buildDamageMitigationTables(item, getCreatureOptions(), getDamageTypeSettings(), {
    actorRaceId: actor?.system?.creature?.raceId ?? ""
  }));
  const content = `${renderTooltipFunctionGrid(rows)}${tableHTML}`;
  if (!content.trim()) return "";
  return `
    <section class="function-section damage-mitigation-tooltip-section">
      <h4>${escapeHTML(game.i18n.localize("FALLOUTMAW.Item.FunctionDamageMitigation"))}</h4>
      ${content}
    </section>
  `;
}

function renderDamageMitigationTooltipTables(tables = []) {
  if (!tables.length) return "";
  return `
    <div class="tooltip-mitigation-table-list">
      ${tables.map(table => `
        <section class="tooltip-mitigation-table">
          ${tables.length > 1 ? `<h5>${escapeHTML(table.raceNames)}</h5>` : ""}
          <div class="tooltip-mitigation-matrix" style="--fallout-maw-mitigation-columns: ${Math.max(1, toInteger(table.columns))};">
            <span class="tooltip-mitigation-cell tooltip-mitigation-header"></span>
            ${table.limbs.map(limb => `
              <span class="tooltip-mitigation-cell tooltip-mitigation-header" title="${escapeAttribute(limb.label)}">${escapeHTML(limb.shortLabel)}</span>
            `).join("")}
            ${table.rows.map(row => `
              <span class="tooltip-mitigation-cell tooltip-mitigation-damage-type" title="${escapeAttribute(row.damageTypeLabel)}">
                ${renderDamageTypeIcon(row)}
              </span>
              ${row.cells.map(cell => `
                <span class="tooltip-mitigation-cell tooltip-mitigation-value mitigation-value-${escapeAttribute(cell.valueClass)}">${escapeHTML(formatNumber(cell.value))}</span>
              `).join("")}
            `).join("")}
          </div>
        </section>
      `).join("")}
    </div>
  `;
}

function renderDamageTypeIcon(damageType = {}) {
  const img = String(damageType.damageTypeImg ?? "").trim() || "icons/svg/d20-grey.svg";
  const label = String(damageType.damageTypeLabel ?? "");
  const iconClass = String(damageType.damageTypeIconClass ?? "").trim() || buildDamageTypeIconClass(damageType);
  const style = String(damageType.damageTypeIconStyle ?? "").trim() || buildDamageTypeIconStyle(damageType);
  return `
    <span class="${escapeAttribute(iconClass)}" style="${escapeAttribute(style)}">
      <img src="${escapeAttribute(img)}" alt="${escapeAttribute(label)}">
    </span>
  `;
}

function buildDamageSourceTooltipSection(item, actor = null) {
  if (!hasItemFunction(item, ITEM_FUNCTIONS.damageSource, { ignoreBroken: true })) return "";
  const source = getDamageSourceFunction(item);
  const sourceName = String(source?.name ?? "").trim();
  const rows = [
    [game.i18n.localize("FALLOUTMAW.Item.DamageSourceName"), sourceName || item.name],
    [game.i18n.localize("FALLOUTMAW.Item.DamageSourceDamage"), formatFormulaDamageValue(source?.damage, actor)],
    [game.i18n.localize("FALLOUTMAW.Item.WeaponDamageDistribution"), {
      html: renderTooltipValueTokens(getWeaponDamageTypeLabels(source))
    }]
  ];
  const pellets = Math.max(1, evaluateTooltipFormula(source?.pellets, actor, { fallback: 1, minimum: 1 }) || 1);
  if (pellets > 1) rows.push([game.i18n.localize("FALLOUTMAW.Item.WeaponPellets"), pellets]);
  const accuracyBonus = evaluateTooltipFormula(source?.accuracyBonus, actor, { minimum: -Infinity });
  if (accuracyBonus) rows.push([game.i18n.localize("FALLOUTMAW.Item.WeaponAccuracyBonus"), renderSignedTooltipModifier(accuracyBonus, {
    breakdown: buildDamageSourceFormulaAttribution(item, actor, game.i18n.localize("FALLOUTMAW.Item.WeaponAccuracyBonus"), source?.accuracyBonus, accuracyBonus)
  })]);
  const criticalChanceModifier = evaluateTooltipFormula(source?.criticalChanceModifier, actor, { minimum: -Infinity });
  if (criticalChanceModifier) rows.push([game.i18n.localize("FALLOUTMAW.Item.WeaponCriticalChanceModifier"), renderSignedTooltipModifier(criticalChanceModifier, {
    suffix: "%",
    breakdown: buildDamageSourceFormulaAttribution(item, actor, game.i18n.localize("FALLOUTMAW.Item.WeaponCriticalChanceModifier"), source?.criticalChanceModifier, criticalChanceModifier, { suffix: "%" })
  })]);
  const criticalDamagePercent = evaluateTooltipFormula(source?.criticalDamagePercent, actor);
  if (criticalDamagePercent) rows.push([game.i18n.localize("FALLOUTMAW.Item.WeaponCriticalDamagePercent"), renderSignedTooltipModifier(criticalDamagePercent, {
    suffix: "%",
    breakdown: buildDamageSourceFormulaAttribution(item, actor, game.i18n.localize("FALLOUTMAW.Item.WeaponCriticalDamagePercent"), source?.criticalDamagePercent, criticalDamagePercent, { suffix: "%" })
  })]);
  const maxRangeMeters = evaluateTooltipFormula(source?.maxRangeMeters, actor);
  if (maxRangeMeters) rows.push([game.i18n.localize("FALLOUTMAW.Item.WeaponMaxRange"), `${formatNumber(maxRangeMeters)} м`]);
  const effectiveValue = evaluateTooltipFormula(source?.effectiveRange?.value, actor);
  const effectiveMax = evaluateTooltipFormula(source?.effectiveRange?.max, actor);
  if (effectiveValue || effectiveMax) rows.push([game.i18n.localize("FALLOUTMAW.Item.WeaponEffectiveRange"), `${formatNumber(effectiveValue)} / ${formatNumber(effectiveMax)} м`]);
  const penetration = evaluateTooltipFormula(source?.penetration, actor);
  if (penetration) rows.push([game.i18n.localize("FALLOUTMAW.Item.WeaponPenetration"), penetration]);
  rows.push(...getWeaponVolleyRows(source, { actor }));
  return renderTooltipFunctionSection(game.i18n.localize("FALLOUTMAW.Item.FunctionDamageSource"), rows);
}

function buildDamageSourceFormulaAttribution(item, actor, title = "", formula = 0, total = 0, { suffix = "" } = {}) {
  const formulaText = String(formula ?? "").trim() || "0";
  const formulaLabel = formatActorFormulaForDisplay(formulaText, actor, { includeValues: Boolean(actor) });
  const formattedTotal = `${formatNumber(total)}${suffix}`;
  return {
    title,
    actorName: actor?.name,
    img: item?.img,
    base: {
      name: item?.name,
      img: item?.img,
      value: total,
      valueLabel: formulaText === String(total) ? formattedTotal : `${formulaLabel} = ${formattedTotal}`
    },
    sources: [],
    total,
    formatValue: value => `${formatNumber(value)}${suffix}`
  };
}

function buildEnergySourceTooltipSection(item) {
  if (!hasItemFunction(item, ITEM_FUNCTIONS.energySource, { ignoreBroken: true })) return "";
  const source = getEnergySourceFunction(item);
  const name = String(source?.name ?? "").trim() || item.name;
  const reserve = source?.reserve ?? {};
  const rows = [
    [game.i18n.localize("FALLOUTMAW.Item.EnergySourceName"), name],
    [game.i18n.localize("FALLOUTMAW.Item.EnergySourceClass"), String(source?.class ?? "").trim()],
    [game.i18n.localize("FALLOUTMAW.Item.EnergySourceReserve"), formatReserveTooltipValue(reserve)]
  ];
  return renderTooltipFunctionSection(game.i18n.localize("FALLOUTMAW.Item.FunctionEnergySource"), rows);
}

function buildEnergyConsumerTooltipSection(item) {
  if (!hasItemFunction(item, ITEM_FUNCTIONS.energyConsumer, { ignoreBroken: true })) return "";
  const consumer = getEnergyConsumerFunction(item);
  const installed = normalizeTooltipInstalledEnergySource(consumer.installedSource);
  const acceptedLabels = getTooltipAcceptedEnergySourceLabels(consumer);
  const rows = [
    [
      game.i18n.localize("FALLOUTMAW.Item.LightSourceCurrentEnergySource"),
      installed.sourceItemUuid ? (installed.name || game.i18n.localize("FALLOUTMAW.Item.FunctionEnergySource")) : game.i18n.localize("FALLOUTMAW.Item.LightSourceNoEnergySource")
    ],
    [game.i18n.localize("FALLOUTMAW.Item.EnergySourceClass"), installed.class],
    [game.i18n.localize("FALLOUTMAW.Item.EnergySourceReserve"), installed.sourceItemUuid ? formatReserveTooltipValue(installed.reserve) : ""],
    [game.i18n.localize("FALLOUTMAW.Item.LightSourceAvailableEnergySources"), acceptedLabels.length
      ? { html: renderTooltipValueTokens(acceptedLabels) }
      : ""]
  ];
  return renderTooltipFunctionSection(game.i18n.localize("FALLOUTMAW.Item.FunctionEnergyConsumer"), rows);
}

function buildLightSourceTooltipSection(item) {
  if (!hasItemFunction(item, ITEM_FUNCTIONS.lightSource, { ignoreBroken: true })) return "";
  const light = getLightSourceFunction(item);
  const name = String(light?.name ?? "").trim() || item.name;
  const rows = [
    [game.i18n.localize("FALLOUTMAW.Item.LightSourceName"), name],
    [game.i18n.localize("FALLOUTMAW.Item.LightSourceDim"), `${formatNumber(Math.max(0, Number(light?.dim) || 0))} м`],
    [game.i18n.localize("FALLOUTMAW.Item.LightSourceBright"), `${formatNumber(Math.max(0, Number(light?.bright) || 0))} м`],
    [game.i18n.localize("FALLOUTMAW.Item.LightSourceAngle"), Math.max(0, Math.min(360, Number(light?.angle) || 360))],
    [game.i18n.localize("FALLOUTMAW.Item.LightSourceRotation"), formatNumber(Number(light?.rotation) || 0)],
    [game.i18n.localize("FALLOUTMAW.Item.LightSourceColor"), String(light?.color ?? "").trim() || game.i18n.localize("FALLOUTMAW.Common.None")],
    [game.i18n.localize("FALLOUTMAW.Item.LightSourceResourceCosts"), getLightSourceCostTooltipLabel(light?.resourceCosts)]
  ];
  return renderTooltipFunctionSection(game.i18n.localize("FALLOUTMAW.Item.FunctionLightSource"), rows);
}

function formatReserveTooltipValue(reserve = {}) {
  const max = Math.max(0, Number(reserve?.max) || 0);
  const value = Math.max(0, Math.min(max || Number.POSITIVE_INFINITY, Number(reserve?.value) || 0));
  return max ? `${formatNumber(value)} / ${formatNumber(max)}` : formatNumber(value);
}

function normalizeTooltipInstalledEnergySource(source = {}) {
  const max = Math.max(0, Number(source?.reserve?.max) || 0);
  const value = Math.max(0, Math.min(max || Number.POSITIVE_INFINITY, Number(source?.reserve?.value) || 0));
  return {
    sourceItemUuid: String(source?.sourceItemUuid ?? "").trim(),
    name: String(source?.name ?? "").trim(),
    class: String(source?.class ?? "").trim(),
    reserve: { value, max }
  };
}

function getTooltipAcceptedEnergySourceLabels(consumer = {}) {
  const uuids = Array.from(new Set([
    ...(Array.isArray(consumer?.sourceItemUuids) ? consumer.sourceItemUuids : []),
    String(consumer?.sourceItemUuid ?? "")
  ].map(value => String(value ?? "").trim()).filter(Boolean)));
  return uuids.map(uuid => {
    const source = resolveWorldItemSync(uuid);
    const data = getEnergySourceFunction(source);
    return String(data?.name ?? "").trim() || source?.name || uuid;
  }).filter(Boolean);
}

function getLightSourceCostTooltipLabel(costs = []) {
  const entries = (Array.isArray(costs) ? costs : [])
    .map(cost => {
      const amount = Math.max(0, Number(cost?.amountPerHour) || 0);
      const type = String(cost?.type ?? "").trim();
      if (!type || amount <= 0) return "";
      const label = type === "condition"
        ? game.i18n.localize("FALLOUTMAW.Item.FunctionCondition")
        : type === "energyConsumer"
          ? game.i18n.localize("FALLOUTMAW.Item.FunctionEnergyConsumer")
          : type;
      return `${label}: ${formatNumber(amount)}/ч`;
    })
    .filter(Boolean);
  if (!entries.length) return game.i18n.localize("FALLOUTMAW.Item.LightSourceNoResourceCosts");
  return { html: renderTooltipValueTokens(entries) };
}

function buildModuleTooltipSection(item, evaluatingActor = null) {
  if (!hasItemFunction(item, ITEM_FUNCTIONS.module, { ignoreBroken: true })) return "";
  if (String(getModuleFunction(item).targetFunction ?? "weapon") !== "weapon") return "";
  return renderTooltipFunctionSection(game.i18n.localize("FALLOUTMAW.Item.FunctionModule"), getModuleTooltipRows(item, evaluatingActor));
}

function buildConstructPartTooltipSection(item) {
  if (!hasItemFunction(item, ITEM_FUNCTIONS.constructPart, { ignoreBroken: true })) return "";
  const constructPart = getConstructPartFunction(item);
  const partType = String(constructPart.partType ?? "").trim() || item.name;
  const blockedLabels = getProsthesisBlockedEffectLabels(getConstructPartBlockedEffects(item));
  const rows = [
    ["Тип детали", partType],
    ["Критическая деталь", game.i18n.localize(constructPart.critical ? "FALLOUTMAW.Common.Yes" : "FALLOUTMAW.Common.No")],
    [game.i18n.localize("FALLOUTMAW.Item.ProsthesisBlockedEffects"), blockedLabels.length
      ? { html: renderTooltipValueTokens(blockedLabels) }
      : ""]
  ];
  return renderTooltipFunctionSection("Деталь конструкта", rows);
}

function getConstructPartBlockedEffects(itemOrData = null) {
  const source = itemOrData?._source?.system?.functions?.constructPart?.blockedPeriodicEffects
    ?? itemOrData?.system?._source?.functions?.constructPart?.blockedPeriodicEffects
    ?? [];
  return Array.from(new Set((Array.isArray(source)
    ? source
    : source && typeof source === "object" ? Object.values(source) : [])
    .map(key => String(key ?? "").trim())
    .filter(Boolean)));
}

function buildProsthesisTooltipSection(item, actor = null) {
  if (!hasItemFunction(item, ITEM_FUNCTIONS.prosthesis, { ignoreBroken: true })) return "";
  const prosthesis = getProsthesisFunction(item);
  const limbLabels = getProsthesisLimbLabels(prosthesis.limbKeys, actor);
  const blockedLabels = getProsthesisBlockedEffectLabels(prosthesis.blockedPeriodicEffects);
  const rows = [
    [game.i18n.localize("FALLOUTMAW.Item.ProsthesisLimbs"), limbLabels.length
      ? { html: renderTooltipValueTokens(limbLabels) }
      : ""],
    [game.i18n.localize("FALLOUTMAW.Item.ProsthesisIntegration"), `${Math.max(0, Math.min(100, toInteger(prosthesis.integrationPercent)))}%`],
    [game.i18n.localize("FALLOUTMAW.Item.ProsthesisBreakShockResistant"), game.i18n.localize(prosthesis.breakShockResistant ? "FALLOUTMAW.Common.Yes" : "FALLOUTMAW.Common.No")],
    [game.i18n.localize("FALLOUTMAW.Item.ProsthesisDifficulty"), Math.max(0, toInteger(prosthesis.difficulty ?? 60))],
    [game.i18n.localize("FALLOUTMAW.Item.ProsthesisSkill"), getSkillLabel(prosthesis.skillKey ?? "doctor")],
    [game.i18n.localize("FALLOUTMAW.Item.ProsthesisBlockedEffects"), blockedLabels.length
      ? { html: renderTooltipValueTokens(blockedLabels) }
      : ""]
  ];
  return renderTooltipFunctionSection(game.i18n.localize("FALLOUTMAW.Item.FunctionProsthesis"), rows);
}

function getProsthesisBlockedEffectLabels(effectKeys = []) {
  const keys = Array.from(new Set((effectKeys ?? []).map(key => String(key ?? "").trim()).filter(Boolean)));
  if (!keys.length) return [game.i18n.localize("FALLOUTMAW.Item.ProsthesisNoBlockedEffects")];
  const damageTypes = new Map(getDamageTypeSettings().map(damageType => {
    const key = String(damageType.key ?? "");
    const periodicLabel = String(damageType?.settings?.periodic?.effectName ?? "").trim();
    const fallbackLabel = String(damageType.label ?? damageType.key ?? "");
    return [key, periodicLabel || fallbackLabel];
  }));
  return keys.map(key => {
    if (key === BLEEDING_DAMAGE_TYPE_KEY) return game.i18n.localize("FALLOUTMAW.Item.ProsthesisBleedingEffect");
    return damageTypes.get(key) ?? key;
  });
}

function getProsthesisLimbLabels(limbKeys = [], actor = null) {
  const keys = Array.from(new Set((limbKeys ?? []).map(key => String(key ?? "").trim()).filter(Boolean)));
  const actorLabels = new Map(Object.entries(actor?.system?.limbs ?? {}).map(([key, limb]) => [key, String(limb?.label ?? key)]));
  if (!keys.length) return [game.i18n.localize("FALLOUTMAW.Item.ProsthesisNoLimbs")];
  return keys.map(key => actorLabels.get(key) ?? getConfiguredLimbLabel(key));
}

function getConfiguredLimbLabel(limbKey = "") {
  const key = String(limbKey ?? "").trim();
  for (const race of getCreatureOptions().races ?? []) {
    const limb = (race.limbs ?? []).find(entry => entry.key === key);
    if (limb) return String(limb.label ?? key);
  }
  return key;
}

function getModuleTooltipRows(item, evaluatingActor = null) {
  const moduleData = getModuleFunction(item);
  const weapon = moduleData.weapon ?? {};
  const rows = [
    [game.i18n.localize("FALLOUTMAW.Item.ModuleName"), getWeaponModuleTechnicalName(item)],
    [game.i18n.localize("FALLOUTMAW.Item.ModuleTargetFunction"), game.i18n.localize("FALLOUTMAW.Item.FunctionWeapon")]
  ];
  pushModuleChangeRow(rows, game.i18n.localize("FALLOUTMAW.Item.WeaponDamage"), weapon.damage);
  pushModuleChangeRow(rows, game.i18n.localize("FALLOUTMAW.Item.WeaponAccuracyBonus"), weapon.accuracyBonus);
  pushModuleChangeRow(rows, game.i18n.localize("FALLOUTMAW.Item.WeaponCriticalChanceModifier"), weapon.criticalChanceModifier, { suffix: "%" });
  pushModuleChangeRow(rows, game.i18n.localize("FALLOUTMAW.Item.WeaponCriticalDamagePercent"), weapon.criticalDamagePercent, { suffix: "%" });
  pushModuleChangeRow(rows, game.i18n.localize("FALLOUTMAW.Item.WeaponMaxRange"), weapon.maxRangeMeters, { suffix: " м" });
  pushModuleEffectiveRangeRow(rows, weapon.effectiveRange);
  pushModuleChangeRow(rows, game.i18n.localize("FALLOUTMAW.Item.WeaponPenetration"), weapon.penetration);
  pushModuleChangeRow(rows, game.i18n.localize("FALLOUTMAW.Item.WeaponMagazine"), weapon.magazineMax);
  rows.push(...getModuleActionPointRows(weapon.actionPointCosts));
  rows.push(...getModuleAddedWeaponFunctionRows(item, moduleData.additionalWeapons, evaluatingActor));
  return rows;
}

function getModuleAddedWeaponFunctionRows(item, additionalWeapons = {}, evaluatingActor = null) {
  return normalizeTooltipWeaponFunctionEntries(additionalWeapons)
    .filter(({ data }) => data?.enabled)
    .map(({ id, data }, index) => {
      const title = String(data?.name ?? "").trim() || getDefaultTooltipWeaponFunctionName(index);
      const entry = {
        id,
        isPrimary: false,
        canHaveModuleSlots: false,
        name: title,
        data
      };
      const tooltipHTML = renderAddedWeaponFunctionTooltipHTML(title, buildWeaponTooltipRows(item, entry, {
        actor: evaluatingActor,
        baseMode: false
      }));
      return ["Добавляет функцию", {
        html: `
          <span class="weapon-tab-list tooltip-added-weapon-function-list">
            <span class="tooltip-added-weapon-function-chip"
              data-tooltip-html="${escapeAttribute(tooltipHTML)}"
              data-tooltip-class="fallout-maw-inventory-tooltip fallout-maw-module-item-tooltip"
              data-tooltip-direction="RIGHT">
              ${escapeHTML(title)}
            </span>
          </span>
        `
      }];
    });
}

function renderAddedWeaponFunctionTooltipHTML(title, rows = []) {
  return `
    <section class="content">
      <section class="functions">
        ${renderTooltipFunctionSection(title, rows)}
      </section>
    </section>
  `;
}

function normalizeTooltipWeaponFunctionEntries(functions = {}) {
  if (Array.isArray(functions)) {
    return functions
      .map((data, index) => ({
        id: String(data?.id || `legacy${index}`),
        data: {
          ...data,
          id: String(data?.id || `legacy${index}`)
        }
      }))
      .filter(entry => entry.id);
  }
  if (!functions || typeof functions !== "object") return [];
  return Object.entries(functions)
    .map(([id, data]) => ({
      id: String(id),
      data: {
        ...data,
        id: String(data?.id || id)
      }
    }))
    .filter(entry => entry.id);
}

function getDefaultTooltipWeaponFunctionName(index = 0) {
  return `${game.i18n.localize("FALLOUTMAW.Item.AdditionalWeaponFunction")} ${index + 1}`;
}

function summarizeMitigationCoverage(entries = {}) {
  const limbCount = Object.values(entries ?? {}).filter(damageEntries => (
    Object.values(damageEntries ?? {}).some(entry => toInteger(entry?.value) !== 0)
  )).length;
  const damageTypeCount = new Set(Object.values(entries ?? {}).flatMap(damageEntries => (
    Object.entries(damageEntries ?? {})
      .filter(([_key, entry]) => toInteger(entry?.value) !== 0)
      .map(([key]) => key)
  ))).size;
  if (!limbCount && !damageTypeCount) return "";
  return `${limbCount} частей / ${damageTypeCount} типов`;
}

function buildWeaponTooltipSections(item, activeWeaponIndex = 0, {
  sourceActor = null,
  evaluatingActor = sourceActor,
  baseMode = false
} = {}) {
  if (!hasItemFunction(item, ITEM_FUNCTIONS.weapon, { ignoreBroken: true })) return [];
  const entries = getEnabledWeaponFunctions(item, { ignoreBroken: true });
  if (!entries.length) return [];

  const installedModuleTabs = getWeaponInstalledModuleTooltipTabs(item, sourceActor, evaluatingActor);
  const moduleTabIndex = entries.length + installedModuleTabs.length;
  const hasModuleSlots = entries.some((entry) => entry?.canHaveModuleSlots && getWeaponModuleSlots(entry.data ?? {}).length);
  const maxTabIndex = hasModuleSlots ? moduleTabIndex : Math.max(entries.length - 1, moduleTabIndex - 1);
  const activeIndex = Math.max(0, Math.min(maxTabIndex, toInteger(activeWeaponIndex)));
  const tabs = [
    ...entries.map((entry, index) => {
      const active = index === activeIndex;
      return `
        <button type="button" class="${active ? "active" : ""}" data-tooltip-weapon-tab="${index}" aria-selected="${active ? "true" : "false"}">
          ${escapeHTML(getWeaponTooltipSectionTitle(item, entry, index))}
        </button>
      `;
    }),
    ...installedModuleTabs.map((entry, index) => {
      const tabIndex = entries.length + index;
      const active = activeIndex === tabIndex;
      return `
        <button type="button" class="${active ? "active" : ""}" data-tooltip-weapon-tab="${tabIndex}" aria-selected="${active ? "true" : "false"}">
          ${escapeHTML(entry.title)}
        </button>
      `;
    }),
    hasModuleSlots ? (() => {
      const active = activeIndex === moduleTabIndex;
      return `
        <button type="button" class="${active ? "active" : ""}" data-tooltip-weapon-tab="${moduleTabIndex}" aria-selected="${active ? "true" : "false"}">
          ${escapeHTML(game.i18n.localize("FALLOUTMAW.Item.WeaponModuleSlots"))}
        </button>
      `;
    })() : ""
  ].join("");
  const panels = [
    ...entries.map((entry, index) => `
      <div class="weapon-tab-panel ${index === activeIndex ? "active" : ""}" data-tooltip-weapon-panel="${index}">
        ${renderTooltipFunctionGrid(buildWeaponTooltipRows(item, entry, { actor: evaluatingActor, baseMode }))}
      </div>
    `),
    ...installedModuleTabs.map((entry, index) => {
      const tabIndex = entries.length + index;
      return `
        <div class="weapon-tab-panel ${tabIndex === activeIndex ? "active" : ""}" data-tooltip-weapon-panel="${tabIndex}">
          ${entry.sections.join("")}
        </div>
      `;
    }),
    hasModuleSlots ? `
      <div class="weapon-tab-panel ${moduleTabIndex === activeIndex ? "active" : ""}" data-tooltip-weapon-panel="${moduleTabIndex}">
        ${renderWeaponTooltipModuleSlots(item, entries, sourceActor, evaluatingActor)}
      </div>
    ` : ""
  ].join("");
  return [`
    <section class="function-section weapon-tab-section">
      <div class="weapon-tab-list" role="tablist">${tabs}</div>
      ${panels}
    </section>
  `];
}

export function getWeaponTooltipModuleSlotsTabIndex(item, actor = null) {
  if (!hasItemFunction(item, ITEM_FUNCTIONS.weapon, { ignoreBroken: true })) return 0;
  return getEnabledWeaponFunctions(item, { ignoreBroken: true }).length + getWeaponInstalledModuleTooltipTabs(item, actor).length;
}

function getWeaponInstalledModuleTooltipTabs(item, sourceActor = null, evaluatingActor = sourceActor) {
  if (!sourceActor || !item?.id) return [];
  return getActorInstalledModuleItems(sourceActor)
    .filter(moduleItem => String(moduleItem.system?.placement?.parentItemId ?? "") === item.id)
    .map(moduleItem => ({
      item: moduleItem,
      title: getWeaponModuleDisplayName(moduleItem),
      sections: buildInstalledWeaponModuleTooltipSections(moduleItem, sourceActor, evaluatingActor)
    }))
    .filter(entry => entry.sections.length);
}

function buildInstalledWeaponModuleTooltipSections(item, sourceActor = null, evaluatingActor = sourceActor) {
  return [
    buildContainerTooltipSection(item, sourceActor),
    buildConditionTooltipSection(item),
    buildFirstAidTooltipSection(item, evaluatingActor),
    buildNeedChangeTooltipSection(item, evaluatingActor),
    buildOneTimeUseTooltipSection(item, evaluatingActor),
    buildDamageMitigationTooltipSection(item, evaluatingActor),
    buildDamageSourceTooltipSection(item, evaluatingActor),
    buildEnergySourceTooltipSection(item),
    buildEnergyConsumerTooltipSection(item),
    buildLightSourceTooltipSection(item),
    buildModuleTooltipSection(item, evaluatingActor),
    buildConstructPartTooltipSection(item),
    buildProsthesisTooltipSection(item, evaluatingActor),
    ...buildToolTooltipSections(item)
  ].filter(Boolean);
}

function renderWeaponTooltipModuleSlots(item, entries = [], sourceActor = null, evaluatingActor = sourceActor) {
  const slots = entries.flatMap((entry, weaponIndex) => !entry?.canHaveModuleSlots ? [] : getWeaponModuleSlots(entry.data ?? {}).map((slot, slotIndex) => ({
    entry,
    weaponIndex,
    slotIndex,
    slot,
    itemData: getWeaponModuleSlotItemData(slot)
  })));
  if (!slots.length) return `<p class="fallout-maw-empty-list">${escapeHTML(game.i18n.localize("FALLOUTMAW.Item.WeaponModuleNoSlots"))}</p>`;
  return `
    <div class="tooltip-module-grid">
      ${slots.map(({ entry, weaponIndex, slotIndex, slot, itemData }) => `
        <div class="tooltip-module-card">
          ${itemData ? `
            <button type="button" class="tooltip-module-remove" data-tooltip-module-remove data-tooltip-weapon-index="${weaponIndex}" data-tooltip-module-slot-index="${slotIndex}">
              <i class="fa-solid fa-trash"></i>
            </button>
          ` : ""}
          <button type="button" class="tooltip-module-slot ${itemData ? "filled" : "empty"}"
            data-tooltip-module-slot
            data-tooltip-weapon-index="${weaponIndex}"
            data-tooltip-module-slot-index="${slotIndex}"
            ${itemData ? renderInstalledModuleTooltipAttributes(itemData, sourceActor, evaluatingActor) : ""}>
            ${itemData ? `<img src="${escapeAttribute(itemData.img || "icons/svg/item-bag.svg")}" alt="">` : `<i class="fa-solid fa-plus"></i>`}
          </button>
          <span>${escapeHTML(slot.moduleKey || getWeaponTooltipSectionTitle(null, entry, weaponIndex))}</span>
        </div>
      `).join("")}
    </div>
    <div class="tooltip-module-picker-panels">
      ${slots.map(({ weaponIndex, slotIndex, slot }) => renderWeaponTooltipModulePickerPanel(item, sourceActor, evaluatingActor, slot, weaponIndex, slotIndex)).join("")}
    </div>
  `;
}

function renderInstalledModuleTooltipAttributes(item, sourceActor = null, evaluatingActor = sourceActor) {
  const html = renderInventoryItemTooltipContentHTML(item, sourceActor, { evaluatingActor });
  return [
    `data-tooltip-html="${escapeAttribute(html)}"`,
    `data-tooltip-class="fallout-maw-inventory-tooltip fallout-maw-module-item-tooltip"`,
    `data-tooltip-direction="RIGHT"`
  ].join(" ");
}

function renderWeaponTooltipModulePickerPanel(item, sourceActor, evaluatingActor, slot, weaponIndex, slotIndex) {
  const panelKey = `${weaponIndex}:${slotIndex}`;
  const candidates = getTooltipWeaponModuleCandidates(sourceActor, item, slot);
  const content = candidates.length
    ? `<div class="tooltip-module-choice-list">${candidates.map(candidate => renderWeaponTooltipModuleChoice(candidate, weaponIndex, slotIndex, sourceActor, evaluatingActor)).join("")}</div>`
    : `<p class="fallout-maw-empty-list">Нет подходящих модулей.</p>`;
  return `
    <div class="tooltip-module-picker-panel" data-tooltip-module-picker-panel="${escapeAttribute(panelKey)}">
      <h5>${escapeHTML(slot.moduleKey || game.i18n.localize("FALLOUTMAW.Item.WeaponModuleSlots"))}</h5>
      ${content}
    </div>
  `;
}

function getTooltipWeaponModuleCandidates(actor, item, slot) {
  if (!actor?.items) return [];
  return actor.items.contents
    .filter(candidate => candidate.id !== item.id && isModuleItemCompatibleWithSlot(candidate, slot) && getItemQuantityHelper(candidate) > 0)
    .sort((left, right) => getWeaponModuleDisplayName(left).localeCompare(getWeaponModuleDisplayName(right), game.i18n.lang));
}

function renderWeaponTooltipModuleChoice(item, weaponIndex, slotIndex, sourceActor = null, evaluatingActor = sourceActor) {
  return `
    <div class="tooltip-module-choice" role="button" tabindex="0"
      data-tooltip-module-choice="${escapeAttribute(item.id)}"
      data-tooltip-weapon-index="${weaponIndex}"
      data-tooltip-module-slot-index="${slotIndex}"
      ${renderInstalledModuleTooltipAttributes(item, sourceActor, evaluatingActor)}>
      <img src="${escapeAttribute(item.img || "icons/svg/item-bag.svg")}" alt="">
      <span class="tooltip-module-choice-body">
        <strong>${escapeHTML(getWeaponModuleDisplayName(item))}</strong>
        ${renderModuleChangePreview(item, evaluatingActor)}
      </span>
    </div>
  `;
}

function renderModuleChangePreview(item, evaluatingActor = null) {
  const rows = getModuleTooltipRows(item, evaluatingActor).slice(2).filter(row => hasTooltipRowValue(row?.[1]));
  if (!rows.length) return `<span class="tooltip-module-choice-empty">Нет изменений</span>`;
  return `
    <span class="tooltip-module-choice-effects">
      ${rows.map(([label, value]) => `
        <span>
          <em>${escapeHTML(formatTooltipLabel(label))}</em>
          <b>${renderTooltipRowValue(value)}</b>
        </span>
      `).join("")}
    </span>
  `;
}

function buildWeaponTooltipRows(item, entry = {}, { actor = null, baseMode = false } = {}) {
  const rawData = entry.data ?? {};
  const moduleSlots = getWeaponFunctionModuleSlots(item, entry.id);
  const data = getEffectiveWeaponTooltipData(rawData, {
    applyModules: !baseMode,
    moduleSlots
  });
  const baseData = getEffectiveWeaponTooltipData(rawData, { applyModules: false });
  const stats = getWeaponTooltipCalculatedStats(item, data, {
    actor,
    baseMode,
    baseData,
    moduleSlots,
    rawData
  });
  const baseStats = baseMode ? stats : getWeaponTooltipCalculatedStats(item, baseData, { actor, baseMode: true });
  data._evaluatedPellets = Math.max(1, evaluateTooltipFormula(data.pellets, actor, { fallback: 1, minimum: 1 }));
  const rows = [
    [game.i18n.localize("FALLOUTMAW.Item.WeaponDamage"), renderChangedWeaponDamageValue(data, stats.damage, baseStats.damage, {
      baseMode,
      breakdown: stats.breakdowns?.damage
    })],
    [game.i18n.localize("FALLOUTMAW.Item.WeaponDamageDistribution"), {
      html: renderTooltipValueTokens(getWeaponDamageTypeLabels(getEffectiveWeaponDamageData(item, data)))
    }]
  ];
  if (isSourceDamageMode(data)) {
    rows.push([game.i18n.localize("FALLOUTMAW.Item.FunctionDamageSource"), getWeaponDamageSourceLabel(data)]);
  }
  const magazineMax = hasWeaponResourceCostData(data, "magazine") ? toInteger(data.magazine?.max) : 0;
  if (magazineMax) {
    rows.push([game.i18n.localize("FALLOUTMAW.Item.WeaponMagazine"), renderTooltipMeterValue(toInteger(data.magazine?.value), magazineMax)]);
  }
  rows.push(
    [game.i18n.localize("FALLOUTMAW.Item.WeaponMaxRange"), renderChangedDistanceValue(evaluateTooltipFormula(data.maxRangeMeters, actor), evaluateTooltipFormula(baseData.maxRangeMeters, actor), {
      baseMode,
      breakdown: stats.breakdowns?.maxRangeMeters
    })],
    [game.i18n.localize("FALLOUTMAW.Item.WeaponEffectiveRange"), renderChangedEffectiveRangeValue(data.effectiveRange, baseData.effectiveRange, {
      actor,
      baseMode,
      breakdowns: stats.breakdowns?.effectiveRange
    })]
  );
  rows.push(...getWeaponActionDetailRows(data, { actor }));
  rows.push([game.i18n.localize("FALLOUTMAW.Item.WeaponSkill"), getSkillLabel(data.skillKey)]);
  if (isWeaponActionEnabled(data, "burst")) {
    const baseRecoil = getWeaponBurstDifficultyPerShot(baseData);
    const recoil = baseMode ? baseRecoil : getEffectiveWeaponBurstDifficultyPerShot(data, actor);
    rows.push([game.i18n.localize("FALLOUTMAW.Item.WeaponRecoil"), renderChangedSignedNumber(recoil, baseRecoil, {
      baseMode,
      higherIsBetter: false,
      breakdown: stats.breakdowns?.recoil
    })]);
  }
  const accuracyBonus = stats.accuracyBonus;
  if (accuracyBonus || (!baseMode && accuracyBonus !== baseStats.accuracyBonus)) {
    rows.push([game.i18n.localize("FALLOUTMAW.Item.WeaponAccuracyBonus"), renderChangedSignedNumber(accuracyBonus, baseStats.accuracyBonus, {
      baseMode,
      breakdown: stats.breakdowns?.accuracyBonus
    })]);
  }
  const criticalChanceModifier = stats.criticalChanceModifier;
  if (criticalChanceModifier || (!baseMode && criticalChanceModifier !== baseStats.criticalChanceModifier)) {
    rows.push([game.i18n.localize("FALLOUTMAW.Item.WeaponCriticalChanceModifier"), renderChangedSignedPercentValue(criticalChanceModifier, baseStats.criticalChanceModifier, {
      baseMode,
      breakdown: stats.breakdowns?.criticalChanceModifier
    })]);
  }
  const criticalDamagePercent = stats.criticalDamagePercent;
  if (criticalDamagePercent || (!baseMode && criticalDamagePercent !== baseStats.criticalDamagePercent)) {
    rows.push([game.i18n.localize("FALLOUTMAW.Item.WeaponCriticalDamagePercent"), renderChangedPercentValue(criticalDamagePercent, baseStats.criticalDamagePercent, {
      baseMode,
      breakdown: stats.breakdowns?.criticalDamagePercent
    })]);
  }
  const penetration = stats.penetration;
  if (penetration || (!baseMode && penetration !== baseStats.penetration)) rows.push([game.i18n.localize("FALLOUTMAW.Item.WeaponPenetration"), renderChangedNumber(penetration, baseStats.penetration, {
    baseMode,
    breakdown: stats.breakdowns?.penetration
  })]);
  rows.push(...getWeaponResourceCostRows(data, baseData, {
    baseMode,
    resourceCostMultipliers: stats.resourceCostMultipliers,
    breakdowns: stats.breakdowns?.resourceCosts
  }));
  const requirements = getWeaponRequirementLabels(data, actor, item);
  if (requirements.length) rows.push([game.i18n.localize("FALLOUTMAW.Item.WeaponUseRequirements"), {
    html: renderTooltipValueTokens(requirements)
  }]);
  const actions = getWeaponActionLabels(data, baseData, { actor, baseMode, item, moduleSlots });
  if (actions.length) rows.push([game.i18n.localize("FALLOUTMAW.Item.WeaponActions"), {
    html: renderTooltipValueTokens(actions)
  }]);
  return rows;
}

function getWeaponTooltipSectionTitle(item, entry = {}, index = 0) {
  const configuredName = String(entry.data?.name ?? entry.name ?? "").trim();
  if (configuredName) return configuredName;
  if (entry.isPrimary) return game.i18n.localize("FALLOUTMAW.Item.FunctionWeapon");
  return `${game.i18n.localize("FALLOUTMAW.Item.FunctionWeapon")} ${index + 1}`;
}

function getWeaponFunctionUpdatePath(entry = {}) {
  if (!entry) return "";
  if (entry.isPrimary || String(entry.id ?? "") === ITEM_FUNCTIONS.weapon) return "system.functions.weapon";
  const id = String(entry.id ?? "").trim();
  return id ? `system.functions.additionalWeapons.${id}` : "";
}

function renderChangedWeaponDamageValue(data = {}, value = 0, baseValue = 0, { baseMode = false, breakdown = null } = {}) {
  const text = formatWeaponDamageValue(data, value);
  if (baseMode || toInteger(value) === toInteger(baseValue)) return text;
  return renderChangedTooltipText(text, value > baseValue, breakdown);
}

function renderChangedNumber(value = 0, baseValue = 0, { baseMode = false, higherIsBetter = true, breakdown = null } = {}) {
  const text = formatNumber(value);
  if (baseMode || Number(value) === Number(baseValue)) return text;
  return renderChangedTooltipText(text, (Number(value) > Number(baseValue)) === higherIsBetter, breakdown);
}

function renderChangedSignedNumber(value = 0, baseValue = 0, options = {}) {
  const text = formatSignedNumber(value);
  if (options.baseMode || Number(value) === Number(baseValue)) return text;
  return renderChangedTooltipText(text, (Number(value) > Number(baseValue)) === (options.higherIsBetter !== false), options.breakdown);
}

function renderChangedSignedPercentValue(value = 0, baseValue = 0, options = {}) {
  const text = `${formatSignedNumber(value)}%`;
  if (options.baseMode || Number(value) === Number(baseValue)) return text;
  return renderChangedTooltipText(text, (Number(value) > Number(baseValue)) === (options.higherIsBetter !== false), options.breakdown);
}

function renderSignedTooltipModifier(value = 0, { suffix = "", higherIsBetter = true, breakdown = null } = {}) {
  const numeric = Number(value) || 0;
  const text = `${formatSignedNumber(numeric)}${suffix}`;
  if (!numeric) return text;
  return renderChangedTooltipText(text, (numeric > 0) === higherIsBetter, breakdown);
}

function renderChangedPercentValue(value = 0, baseValue = 0, options = {}) {
  const text = `${formatNumber(value)}%`;
  if (options.baseMode || Number(value) === Number(baseValue)) return text;
  return renderChangedTooltipText(text, (Number(value) > Number(baseValue)) === (options.higherIsBetter !== false), options.breakdown);
}

function renderChangedDistanceValue(value = 0, baseValue = 0, options = {}) {
  const text = `${formatNumber(value)} м`;
  if (options.baseMode || Number(value) === Number(baseValue)) return text;
  return renderChangedTooltipText(text, (Number(value) > Number(baseValue)) === (options.higherIsBetter !== false), options.breakdown);
}

function renderChangedEffectiveRangeValue(range = {}, baseRange = {}, { actor = null, baseMode = false, breakdowns = {} } = {}) {
  const value = evaluateTooltipFormula(range?.value, actor);
  const max = evaluateTooltipFormula(range?.max, actor);
  const baseValue = evaluateTooltipFormula(baseRange?.value, actor);
  const baseMax = evaluateTooltipFormula(baseRange?.max, actor);
  if (baseMode || (value === baseValue && max === baseMax)) return `${formatNumber(value)} / ${formatNumber(max)} м`;
  const valueHtml = value === baseValue
    ? escapeHTML(formatNumber(value))
    : renderChangedTooltipSpan(formatNumber(value), value < baseValue, breakdowns?.value);
  const maxHtml = max === baseMax
    ? escapeHTML(formatNumber(max))
    : renderChangedTooltipSpan(formatNumber(max), max > baseMax, breakdowns?.max);
  return { html: `${valueHtml} / ${maxHtml} м` };
}

function pushModuleChangeRow(rows, label, value = 0, { suffix = "", higherIsBetter = true } = {}) {
  const numeric = Number(value) || 0;
  if (!numeric) return;
  rows.push([label, renderModuleChangeValue(numeric, { suffix, higherIsBetter })]);
}

function pushModuleEffectiveRangeRow(rows, range = {}) {
  const value = Number(range?.value) || 0;
  const max = Number(range?.max) || 0;
  if (!value && !max) return;
  const valueHtml = value ? renderChangedTooltipSpan(`${formatSignedNumber(value)} м`, value < 0) : escapeHTML("0 м");
  const maxHtml = max ? renderChangedTooltipSpan(`${formatSignedNumber(max)} м`, max > 0) : escapeHTML("0 м");
  rows.push([game.i18n.localize("FALLOUTMAW.Item.WeaponEffectiveRange"), { html: `${valueHtml} / ${maxHtml}` }]);
}

function getModuleActionPointRows(actionPointCosts = {}) {
  const labels = new Map([
    ["aimedShot", game.i18n.localize("FALLOUTMAW.Item.WeaponActionAimedShot")],
    ["snapshot", game.i18n.localize("FALLOUTMAW.Item.WeaponActionSnapshot")],
    ["burst", game.i18n.localize("FALLOUTMAW.Item.WeaponActionBurst")],
    ["volley", game.i18n.localize("FALLOUTMAW.Item.WeaponActionVolley")],
    ["meleeAttack", game.i18n.localize("FALLOUTMAW.Item.WeaponActionMeleeAttack")],
    ["aimedMeleeAttack", game.i18n.localize("FALLOUTMAW.Item.WeaponActionAimedMeleeAttack")],
    ["push", game.i18n.localize("FALLOUTMAW.Item.WeaponActionPush")],
    ["reload", game.i18n.localize("FALLOUTMAW.Item.WeaponActionReload")]
  ]);
  return WEAPON_MODULE_ACTION_KEYS
    .map(key => [labels.get(key) ?? key, Number(actionPointCosts?.[key]) || 0])
    .filter(([_label, value]) => value)
    .map(([label, value]) => [label, renderModuleChangeValue(value, { suffix: " ОД", higherIsBetter: false })]);
}

function renderModuleChangeValue(value = 0, { suffix = "", higherIsBetter = true } = {}) {
  const numeric = Number(value) || 0;
  const text = `${formatSignedNumber(numeric)}${suffix}`;
  return renderChangedTooltipText(text, (numeric > 0) === higherIsBetter);
}

function renderChangedTooltipText(text, positive, breakdown = null) {
  return { html: renderChangedTooltipSpan(text, positive, breakdown) };
}

function renderChangedTooltipSpan(text, positive, breakdown = null) {
  const hasBreakdown = Boolean(breakdown?.sources?.length || breakdown?.base);
  const className = [
    "function-value-change",
    positive ? "positive" : "negative",
    hasBreakdown ? "fallout-maw-item-value-attribution" : ""
  ].filter(Boolean).join(" ");
  const attributes = hasBreakdown
    ? [
      "data-item-value-breakdown",
      `data-tooltip-html="${escapeAttribute(renderItemValueBreakdownTooltipHTML(breakdown))}"`,
      `data-tooltip-class="fallout-maw-effect-tooltip fallout-maw-item-value-breakdown-tooltip"`,
      `data-tooltip-direction="RIGHT"`
    ].join(" ")
    : "";
  return `<span class="${className}" ${attributes}>${escapeHTML(text)}</span>`;
}

function renderItemValueBreakdownTooltipHTML(breakdown = {}) {
  const formatter = typeof breakdown.formatValue === "function" ? breakdown.formatValue : formatNumber;
  const base = breakdown.base ?? null;
  const sources = (breakdown.sources ?? []).filter(source => source && source.hidden !== true);
  const rows = [...(base ? [{ ...base, isBase: true }] : []), ...sources];
  const title = String(breakdown.title ?? localizeOrFallback("FALLOUTMAW.Item.TooltipBreakdownTitle", "Расчёт значения"));
  const actorName = String(breakdown.actorName ?? "").trim();
  const headerImg = String(breakdown.img ?? base?.img ?? "").trim() || "icons/svg/item-bag.svg";
  return `
    <article class="fallout-maw-effect-tooltip-content fallout-maw-item-value-breakdown-content">
      <header>
        <img src="${escapeAttribute(headerImg)}" alt="">
        <div>
          <strong>${escapeHTML(title)}</strong>
          ${actorName ? `<span>${escapeHTML(localizeOrFallback("FALLOUTMAW.Item.TooltipBreakdownPerspective", "Расчёт для"))}: ${escapeHTML(actorName)}</span>` : ""}
        </div>
      </header>
      <section class="changes">
        <h4>${escapeHTML(localizeOrFallback("FALLOUTMAW.Item.TooltipBreakdownSources", "Источники"))}</h4>
        <ol>${rows.map(source => renderItemValueBreakdownSource(source, formatter)).join("")}</ol>
      </section>
      <footer class="fallout-maw-item-value-breakdown-total">
        <strong>${escapeHTML(localizeOrFallback("FALLOUTMAW.Item.TooltipBreakdownTotal", "Итого"))}</strong>
        <span>${escapeHTML(formatter(Number(breakdown.total) || 0))}</span>
      </footer>
    </article>
  `;
}

function renderItemValueBreakdownSource(source = {}, formatter = formatNumber) {
  const fallbackKey = source.isBase ? "FALLOUTMAW.Item.TooltipBreakdownBase" : "FALLOUTMAW.Item.TooltipBreakdownOther";
  const fallbackName = source.isBase ? "Базовое значение" : "Другой источник";
  const name = localizeTooltipSourceName(source.name || localizeOrFallback(fallbackKey, fallbackName));
  const img = String(source.img ?? "").trim() || "icons/svg/item-bag.svg";
  const operation = source.valueLabel || formatItemValueBreakdownOperation(source, formatter);
  const hasTransition = Number.isFinite(Number(source.before)) && Number.isFinite(Number(source.after));
  const transition = hasTransition
    ? `${formatSignedBreakdownValue(Number(source.after) - Number(source.before), formatter)} · ${formatter(Number(source.before))} → ${formatter(Number(source.after))}`
    : "";
  const details = [
    ...(Array.isArray(source.detailLabels) ? source.detailLabels : []),
    source.detailLabel,
    source.contributionLabel,
    transition
  ].map(value => String(value ?? "").trim()).filter(Boolean);
  return `
    <li class="fallout-maw-item-value-breakdown-source">
      <span class="fallout-maw-item-value-breakdown-source-name">
        <img src="${escapeAttribute(img)}" alt="">
        <strong>${escapeHTML(name)}</strong>
      </span>
      <span class="fallout-maw-item-value-breakdown-source-value">
        <b>${escapeHTML(operation)}</b>
        ${details.map(detail => `<small>${escapeHTML(detail)}</small>`).join("")}
      </span>
    </li>
  `;
}

function formatSignedBreakdownValue(value = 0, formatter = formatNumber) {
  const numeric = Number(value) || 0;
  if (!numeric) return formatter(0);
  const absolute = String(formatter(Math.abs(numeric))).replace(/^[+−-]/, "");
  return `${numeric > 0 ? "+" : "−"}${absolute}`;
}

function formatItemValueBreakdownOperation(source = {}, formatter = formatNumber) {
  if (source.isBase) return `${localizeOrFallback("FALLOUTMAW.Item.TooltipBreakdownBase", "База")}: ${formatter(Number(source.value) || 0)}`;
  const value = Number(source.value) || 0;
  const operation = String(source.operation ?? source.type ?? "add");
  if (operation === "multiply") return `×${formatter(value)}`;
  if (operation === "subtract") return `−${formatter(value)}`;
  if (operation === "override") return `→ ${formatter(value)}`;
  if (operation === "upgrade") return `min ${formatter(value)}`;
  if (operation === "downgrade") return `max ${formatter(value)}`;
  return formatSignedNumber(value);
}

function localizeTooltipSourceName(value = "") {
  const text = String(value ?? "");
  return game.i18n.has(text) ? game.i18n.localize(text) : text;
}

function getWeaponTooltipCalculatedStats(item, data = {}, {
  actor = null,
  baseMode = false,
  baseData = data,
  moduleSlots = [],
  rawData = baseData
} = {}) {
  const contextual = baseMode ? null : getWeaponTooltipAbilityContext(item, data);
  const fixedModifiers = baseMode
    ? { combatValues: {}, resourceCostMultipliers: {}, sources: [] }
    : getFixedWeaponPreviewModifiers(actor, item, data);
  const damageFlatAttribution = contextual ? collectActorCombatValueAttribution(actor, "damageFlat", contextual) : emptyCombatAttribution();
  const damagePercentAttribution = contextual ? collectActorCombatValueAttribution(actor, "damagePercent", contextual) : emptyCombatAttribution();
  const accuracyAttribution = contextual ? collectActorCombatValueAttribution(actor, "accuracy", contextual) : emptyCombatAttribution();
  const criticalChanceAttribution = contextual ? collectActorCombatValueAttribution(actor, "criticalChance", contextual) : emptyCombatAttribution();
  const contextualDamageFlat = damageFlatAttribution.value;
  const contextualDamagePercent = damagePercentAttribution.value + toInteger(fixedModifiers.combatValues?.damagePercent);
  const contextualAccuracy = accuracyAttribution.value + toInteger(fixedModifiers.combatValues?.accuracy);
  const contextualCriticalChance = criticalChanceAttribution.value;
  const proficiencyDamage = baseMode ? 0 : getWeaponProficiencyInfluenceBonus(actor, data, "damage");
  const skillDamageBonuses = baseMode ? { flat: 0, percent: 0 } : getWeaponSkillDamageBonuses(actor, data.skillKey);
  const baseDamageFormula = getEffectiveWeaponDamageData(item, data).damage;
  const formulaDamage = actor
    ? evaluateActorFormula(baseDamageFormula, actor, {
      minimum: 0,
      context: `${item?.name ?? "weapon"} tooltip damage`
    })
    : Math.max(0, toInteger(baseDamageFormula));
  const attackPowerDamagePercent = baseMode ? 0 : toInteger(data.attackPowerDamagePercent);
  const damagePercent = attackPowerDamagePercent + proficiencyDamage + contextualDamagePercent + skillDamageBonuses.percent;
  const modifiedDamage = Math.round(formulaDamage * Math.max(0, 100 + damagePercent) / 100)
    + contextualDamageFlat
    + skillDamageBonuses.flat;
  const weakening = baseMode ? { active: false, ratio: 1, steps: 0 } : getConditionWeakeningData(item, { minimumRatio: 0.1 });
  const conditionAccuracyPenalty = weakening.active ? weakening.steps * 10 : 0;
  const conditionCritPenalty = weakening.active ? weakening.steps * 3 : 0;
  const proficiencyAccuracy = baseMode ? 0 : getWeaponProficiencyInfluenceBonus(actor, data, "accuracy");
  const proficiencyCriticalChance = baseMode ? 0 : getWeaponProficiencyInfluenceBonus(actor, data, "criticalChance");
  const proficiencyCriticalDamage = baseMode ? 0 : getWeaponProficiencyInfluenceBonus(actor, data, "criticalDamage");
  const result = {
    damage: Math.max(0, Math.floor(modifiedDamage * (weakening.active ? weakening.ratio : 1))),
    accuracyBonus: evaluateTooltipFormula(data.accuracyBonus, actor, { minimum: -Infinity })
      + proficiencyAccuracy
      + contextualAccuracy
      - conditionAccuracyPenalty,
    criticalChanceModifier: evaluateTooltipFormula(data.criticalChanceModifier, actor, { minimum: -Infinity })
      + proficiencyCriticalChance
      + contextualCriticalChance
      - conditionCritPenalty,
    criticalDamagePercent: Math.max(0, evaluateTooltipFormula(data.criticalDamagePercent, actor, { fallback: 150 })
      + proficiencyCriticalDamage),
    penetration: Math.max(0, evaluateTooltipFormula(data.penetration, actor)),
    resourceCostMultipliers: fixedModifiers.resourceCostMultipliers ?? {}
  };
  if (!baseMode) {
    result.breakdowns = buildWeaponTooltipValueBreakdowns({
      item,
      actor,
      rawData,
      baseData,
      data,
      moduleSlots,
      result,
      formulaDamage,
      damagePercent,
      contextualDamageFlat,
      proficiencyDamage,
      proficiencyAccuracy,
      proficiencyCriticalChance,
      proficiencyCriticalDamage,
      skillDamageBonuses,
      weakening,
      conditionAccuracyPenalty,
      conditionCritPenalty,
      fixedModifiers,
      damageFlatAttribution,
      damagePercentAttribution,
      accuracyAttribution,
      criticalChanceAttribution
    });
  }
  return result;
}

function emptyCombatAttribution() {
  return { value: 0, sources: [] };
}

function buildWeaponTooltipValueBreakdowns({
  item,
  actor,
  rawData,
  baseData,
  data,
  moduleSlots,
  result,
  formulaDamage,
  damagePercent,
  proficiencyDamage,
  proficiencyAccuracy,
  proficiencyCriticalChance,
  proficiencyCriticalDamage,
  skillDamageBonuses,
  weakening,
  conditionAccuracyPenalty,
  conditionCritPenalty,
  fixedModifiers,
  damageFlatAttribution,
  damagePercentAttribution,
  accuracyAttribution,
  criticalChanceAttribution
} = {}) {
  const common = { item, actor, rawData, baseData, data, moduleSlots };
  const damage = buildWeaponDataFieldAttribution({
    ...common,
    path: "damage",
    title: game.i18n.localize("FALLOUTMAW.Item.WeaponDamage"),
    total: formulaDamage,
    minimum: 0,
    integer: true
  });
  const damagePercentSources = [];
  appendWeaponDamagePercentSources({ sources: damagePercentSources }, {
    item,
    actor,
    data,
    proficiencyDamage,
    skillDamageBonuses,
    fixedModifiers,
    damagePercentAttribution
  });
  appendParallelPercentSources(damage, damagePercentSources, {
    expectedPercent: damagePercent,
    round: Math.round,
    contributionUnit: localizeOrFallback("FALLOUTMAW.Item.TooltipBreakdownDamageUnit", "урона")
  });
  appendAttributionDeltaSources(damage, damageFlatAttribution.sources);
  if (skillDamageBonuses.flat) {
    const formulaLabel = skillDamageBonuses.flatFormula
      ? formatActorFormulaForDisplay(skillDamageBonuses.flatFormula, actor, { includeValues: Boolean(actor) })
      : "";
    appendBreakdownStep(damage, {
      name: localizeOrFallback("FALLOUTMAW.Item.TooltipBreakdownBaseBonus", "Базовый бонус"),
      img: actor?.img,
      operation: "add",
      value: skillDamageBonuses.flat,
      valueLabel: formatSignedNumber(skillDamageBonuses.flat),
      ...(formulaLabel ? { detailLabel: `${formulaLabel} = ${formatSignedNumber(skillDamageBonuses.flat)}` } : {})
    });
  }
  if (weakening?.active && Math.abs((Number(weakening.ratio) || 0) - 1) > 0.000001) {
    appendBreakdownStep(damage, {
      name: localizeOrFallback("FALLOUTMAW.Item.TooltipBreakdownCondition", "Состояние предмета"),
      img: item?.img,
      operation: "multiply",
      value: weakening.ratio,
      valueLabel: `×${formatNumber(weakening.ratio)}`
    }, { minimum: 0, round: Math.floor });
  }
  reconcileBreakdownTotal(damage, result.damage, item);

  const accuracyBonus = buildWeaponDataFieldAttribution({
    ...common,
    path: "accuracyBonus",
    title: game.i18n.localize("FALLOUTMAW.Item.WeaponAccuracyBonus"),
    total: evaluateTooltipFormula(data?.accuracyBonus, actor, { minimum: -Infinity }),
    minimum: Number.NEGATIVE_INFINITY,
    formatValue: formatSignedNumber
  });
  appendProficiencyAttribution(accuracyBonus, actor, data, proficiencyAccuracy);
  appendAttributionDeltaSources(accuracyBonus, accuracyAttribution.sources);
  appendFixedCombatAttribution(accuracyBonus, fixedModifiers, "accuracy");
  if (conditionAccuracyPenalty) appendBreakdownStep(accuracyBonus, {
    name: localizeOrFallback("FALLOUTMAW.Item.TooltipBreakdownCondition", "Состояние предмета"),
    img: item?.img,
    operation: "subtract",
    value: conditionAccuracyPenalty
  });
  reconcileBreakdownTotal(accuracyBonus, result.accuracyBonus, item);

  const criticalChanceModifier = buildWeaponDataFieldAttribution({
    ...common,
    path: "criticalChanceModifier",
    title: game.i18n.localize("FALLOUTMAW.Item.WeaponCriticalChanceModifier"),
    total: evaluateTooltipFormula(data?.criticalChanceModifier, actor, { minimum: -Infinity }),
    minimum: Number.NEGATIVE_INFINITY,
    formatValue: value => `${formatSignedNumber(value)}%`
  });
  appendProficiencyAttribution(criticalChanceModifier, actor, data, proficiencyCriticalChance, { suffix: "%" });
  appendAttributionDeltaSources(criticalChanceModifier, criticalChanceAttribution.sources, { suffix: "%" });
  if (conditionCritPenalty) appendBreakdownStep(criticalChanceModifier, {
    name: localizeOrFallback("FALLOUTMAW.Item.TooltipBreakdownCondition", "Состояние предмета"),
    img: item?.img,
    operation: "subtract",
    value: conditionCritPenalty,
    valueLabel: `−${formatNumber(conditionCritPenalty)}%`
  });
  reconcileBreakdownTotal(criticalChanceModifier, result.criticalChanceModifier, item);

  const criticalDamagePercent = buildWeaponDataFieldAttribution({
    ...common,
    path: "criticalDamagePercent",
    title: game.i18n.localize("FALLOUTMAW.Item.WeaponCriticalDamagePercent"),
    total: evaluateTooltipFormula(data?.criticalDamagePercent, actor, { fallback: 150 }),
    fallback: 150,
    minimum: 0,
    formatValue: value => `${formatNumber(value)}%`
  });
  appendProficiencyAttribution(criticalDamagePercent, actor, data, proficiencyCriticalDamage, { suffix: "%", minimum: 0 });
  reconcileBreakdownTotal(criticalDamagePercent, result.criticalDamagePercent, item);

  const penetration = buildWeaponDataFieldAttribution({
    ...common,
    path: "penetration",
    title: game.i18n.localize("FALLOUTMAW.Item.WeaponPenetration"),
    total: result.penetration,
    minimum: 0,
    integer: true
  });
  reconcileBreakdownTotal(penetration, result.penetration, item);

  const maxRangeMeters = buildWeaponDataFieldAttribution({
    ...common,
    path: "maxRangeMeters",
    title: game.i18n.localize("FALLOUTMAW.Item.WeaponMaxRange"),
    total: evaluateTooltipFormula(data?.maxRangeMeters, actor),
    minimum: 0,
    formatValue: value => `${formatNumber(value)} м`
  });
  const effectiveRange = {
    value: buildWeaponDataFieldAttribution({
      ...common,
      path: "effectiveRange.value",
      title: `${game.i18n.localize("FALLOUTMAW.Item.WeaponEffectiveRange")} — min`,
      total: evaluateTooltipFormula(data?.effectiveRange?.value, actor),
      minimum: 0,
      formatValue: value => `${formatNumber(value)} м`
    }),
    max: buildWeaponDataFieldAttribution({
      ...common,
      path: "effectiveRange.max",
      title: `${game.i18n.localize("FALLOUTMAW.Item.WeaponEffectiveRange")} — max`,
      total: evaluateTooltipFormula(data?.effectiveRange?.max, actor),
      minimum: 0,
      formatValue: value => `${formatNumber(value)} м`
    })
  };
  const recoil = buildWeaponRecoilAttribution(item, actor, baseData, data);
  const resourceCosts = buildWeaponResourceCostAttributions(item, actor, baseData, data, fixedModifiers);

  return {
    damage,
    accuracyBonus,
    criticalChanceModifier,
    criticalDamagePercent,
    penetration,
    maxRangeMeters,
    effectiveRange,
    recoil,
    resourceCosts
  };
}

function buildWeaponResourceCostAttributions(item, actor, baseData = {}, data = {}, fixedModifiers = {}) {
  const breakdowns = new Map();
  for (const cost of data?.resourceCosts ?? []) {
    const type = String(cost?.type ?? "").trim();
    if (!type || breakdowns.has(type)) continue;
    const rawAmount = Math.max(0, toInteger(cost?.amount));
    const baseAmount = Math.max(0, toInteger(
      (baseData?.resourceCosts ?? []).find(entry => String(entry?.type ?? "") === type)?.amount
    ));
    const breakdown = {
      title: getWeaponResourceTypeLabel(type),
      actorName: actor?.name,
      img: item?.img,
      base: { name: item?.name, img: item?.img, value: baseAmount },
      sources: [],
      total: baseAmount,
      formatValue: formatNumber
    };
    if (rawAmount !== baseAmount) appendBreakdownStep(breakdown, {
      name: localizeOrFallback("FALLOUTMAW.Item.WeaponSpecialAttackPower", "Атакующая мощность"),
      img: item?.img,
      operation: "add",
      value: rawAmount - baseAmount
    }, { minimum: 0 });

    for (const source of fixedModifiers?.sources ?? []) {
      const multiplier = Number(source?.resourceCostMultipliers?.[type]);
      if (!Number.isFinite(multiplier) || multiplier === 1) continue;
      appendBreakdownStep(breakdown, {
        name: source.name,
        img: source.img,
        operation: "multiply",
        value: multiplier
      }, { minimum: 0 });
    }
    const aggregateMultiplier = Math.max(0, Number(fixedModifiers?.resourceCostMultipliers?.[type]) || 1);
    const expected = Math.max(0, Math.ceil(rawAmount * aggregateMultiplier));
    if (Math.ceil(breakdown.total) !== expected) reconcileBreakdownTotal(breakdown, expected, item);
    else breakdown.total = expected;
    breakdowns.set(type, breakdown);
  }
  return breakdowns;
}

function buildWeaponDataFieldAttribution({
  item,
  actor,
  rawData = {},
  baseData = {},
  data = {},
  moduleSlots = [],
  path = "",
  title = "",
  total = 0,
  fallback = 0,
  minimum = Number.NEGATIVE_INFINITY,
  integer = false,
  formatValue = formatNumber
} = {}) {
  const sourceItem = isSourceDamageMode(rawData) ? getWeaponDamageSourceItem(rawData) : null;
  const sourceFunction = sourceItem && hasItemFunction(sourceItem, ITEM_FUNCTIONS.damageSource)
    ? getDamageSourceFunction(sourceItem)
    : null;
  const usesSourceAsBase = path === "damage" && Boolean(sourceFunction);
  const rawFormula = usesSourceAsBase
    ? foundry.utils.getProperty(sourceFunction, path)
    : foundry.utils.getProperty(rawData, path);
  const rawValue = evaluateTooltipFormula(rawFormula, actor, { fallback, minimum });
  const rawFormulaText = String(rawFormula ?? "").trim();
  const rawFormulaLabel = rawFormulaText && rawFormulaText !== String(rawValue)
    ? formatActorFormulaForDisplay(rawFormulaText, actor, { includeValues: Boolean(actor) })
    : "";
  const breakdown = {
    title,
    actorName: actor?.name,
    img: item?.img,
    base: {
      name: usesSourceAsBase ? sourceItem?.name : item?.name,
      img: usesSourceAsBase ? sourceItem?.img : item?.img,
      value: rawValue,
      ...(rawFormulaLabel ? { detailLabel: `${rawFormulaLabel} = ${formatValue(rawValue)}` } : {})
    },
    sources: [],
    total: rawValue,
    formatValue
  };

  if (sourceFunction && !usesSourceAsBase) {
    const sourceFormula = foundry.utils.getProperty(sourceFunction, path);
    const sourceValue = evaluateTooltipFormula(sourceFormula, actor, {
      fallback: 0,
      minimum: Number.NEGATIVE_INFINITY
    });
    if (sourceValue) appendBreakdownStep(breakdown, {
      name: sourceItem?.name,
      img: sourceItem?.img,
      operation: "add",
      value: sourceValue,
      detailLabel: `${formatActorFormulaForDisplay(sourceFormula, actor, { includeValues: Boolean(actor) })} = ${formatValue(sourceValue)}`
    }, { minimum });
  }

  const baseTarget = evaluateWeaponTooltipField(item, baseData, path, actor, { fallback, minimum });
  reconcileBreakdownTotal(breakdown, baseTarget, item, {
    name: localizeOrFallback("FALLOUTMAW.Item.TooltipBreakdownBaseFormula", "Базовая формула")
  });

  for (const slot of getWeaponModuleSlots({ moduleSlots })) {
    const itemData = getWeaponModuleSlotItemData(slot);
    const modifier = foundry.utils.getProperty(getModuleFunction(itemData)?.weapon ?? {}, path);
    const amount = integer ? toInteger(modifier) : Number(modifier);
    if (!Number.isFinite(amount) || !amount) continue;
    appendBreakdownStep(breakdown, {
      name: getWeaponModuleDisplayName(itemData),
      img: itemData?.img,
      operation: "add",
      value: amount
    }, { minimum });
  }

  const attackPower = getWeaponAttackPowerState(rawData);
  const perLevel = foundry.utils.getProperty(attackPower?.perLevel ?? {}, path);
  const attackPowerAmount = (integer ? toInteger(perLevel) : Number(perLevel)) * Math.max(0, toInteger(attackPower?.increments));
  if (attackPower?.active && Number.isFinite(attackPowerAmount) && attackPowerAmount) {
    appendBreakdownStep(breakdown, {
      name: `${localizeOrFallback("FALLOUTMAW.Item.WeaponSpecialAttackPower", "Атакующая мощность")} (${attackPower.increments})`,
      img: item?.img,
      operation: "add",
      value: attackPowerAmount
    }, { minimum });
  }

  reconcileBreakdownTotal(breakdown, total, item);
  return breakdown;
}

function evaluateWeaponTooltipField(item, data = {}, path = "", actor = null, options = {}) {
  const source = path === "damage" ? getEffectiveWeaponDamageData(item, data) : data;
  return evaluateTooltipFormula(foundry.utils.getProperty(source, path), actor, options);
}

function appendWeaponDamagePercentSources(breakdown, {
  item,
  actor,
  data,
  proficiencyDamage,
  skillDamageBonuses,
  fixedModifiers,
  damagePercentAttribution
} = {}) {
  const attackPowerDamagePercent = toInteger(data?.attackPowerDamagePercent);
  if (attackPowerDamagePercent) appendInformationalPercentSource(breakdown, {
    name: localizeOrFallback("FALLOUTMAW.Item.WeaponSpecialAttackPower", "Атакующая мощность"),
    img: item?.img,
    value: attackPowerDamagePercent
  });
  if (proficiencyDamage) appendInformationalPercentSource(breakdown, buildProficiencySource(actor, data, proficiencyDamage));
  for (const source of damagePercentAttribution?.sources ?? []) appendInformationalPercentSource(breakdown, source);
  for (const source of fixedModifiers?.sources ?? []) {
    const value = toInteger(source?.combatValues?.damagePercent);
    if (value) appendInformationalPercentSource(breakdown, {
      name: source.name,
      img: source.img,
      value
    });
  }
  if (skillDamageBonuses?.percent) appendInformationalPercentSource(breakdown, {
    name: localizeOrFallback("FALLOUTMAW.Item.TooltipBreakdownBaseBonus", "Базовый бонус"),
    img: actor?.img,
    value: skillDamageBonuses.percent,
    valueLabel: `${formatSignedNumber(skillDamageBonuses.percent)}%`,
    ...(skillDamageBonuses.percentFormula ? {
      detailLabel: `${formatActorFormulaForDisplay(skillDamageBonuses.percentFormula, actor, { includeValues: Boolean(actor) })} = ${formatSignedNumber(skillDamageBonuses.percent)}%`
    } : {})
  });
}

function appendInformationalPercentSource(breakdown, source = {}) {
  const value = Number(source.value) || 0;
  if (!value) return;
  breakdown.sources.push({
    ...source,
    operation: source.operation ?? "add",
    value,
    valueLabel: source.valueLabel ?? `${formatSignedNumber(value)}%`
  });
}

function appendParallelPercentSources(breakdown, sources = [], {
  expectedPercent = null,
  direction = 1,
  round = null,
  total = null,
  contributionUnit = ""
} = {}) {
  if (!breakdown) return null;
  const normalized = (sources ?? []).filter(source => Number(source?.value));
  const expected = Number(expectedPercent);
  if (expectedPercent !== null && expectedPercent !== undefined && Number.isFinite(expected)) {
    const attributed = normalized.reduce((sum, source) => sum + (Number(source?.value) || 0), 0);
    const residual = expected - attributed;
    if (Math.abs(residual) > 0.000001) normalized.push({
      name: localizeOrFallback("FALLOUTMAW.Item.TooltipBreakdownPreparedActor", "Подготовленные данные персонажа"),
      img: breakdown.img,
      value: residual
    });
  }
  const result = buildParallelPercentAttribution(breakdown.total, normalized, {
    direction,
    minimumFactor: 0,
    round
  });
  const unit = String(contributionUnit ?? "").trim();
  const separator = unit && !/^[%°]/.test(unit) ? " " : "";
  breakdown.sources.push(...result.sources.map(source => ({
    ...source,
    valueLabel: source.valueLabel ?? `${formatSignedNumber(source.percent)}%`,
    contributionLabel: `${formatSignedBreakdownValue(source.contribution, formatNumber)}${separator}${unit}`
  })));
  breakdown.total = total !== null && total !== undefined && Number.isFinite(Number(total))
    ? Number(total)
    : result.total;
  return result;
}

function appendProficiencyAttribution(breakdown, actor, data, value = 0, { suffix = "", minimum = Number.NEGATIVE_INFINITY } = {}) {
  if (!value) return;
  const source = buildProficiencySource(actor, data, value);
  appendBreakdownStep(breakdown, {
    ...source,
    valueLabel: `${formatSignedNumber(value)}${suffix}`
  }, { minimum });
}

function buildProficiencySource(actor, data = {}, value = 0) {
  const proficiency = getWeaponProficiencySetting(data);
  return {
    name: `${localizeOrFallback("FALLOUTMAW.Item.TooltipBreakdownProficiency", "Владение")}: ${proficiency?.label ?? proficiency?.key ?? "—"}`,
    img: actor?.img,
    operation: "add",
    value
  };
}

function appendFixedCombatAttribution(breakdown, fixedModifiers = {}, key = "") {
  for (const source of fixedModifiers?.sources ?? []) {
    const value = Number(source?.combatValues?.[key]) || 0;
    if (!value) continue;
    appendBreakdownStep(breakdown, {
      name: source.name,
      img: source.img,
      operation: "add",
      value
    });
  }
}

function appendAttributionDeltaSources(breakdown, sources = [], { suffix = "" } = {}) {
  for (const source of sources ?? []) {
    const value = Number(source?.value) || 0;
    if (!value) continue;
    appendBreakdownStep(breakdown, {
      ...source,
      operation: "add",
      value,
      valueLabel: source.valueLabel ?? `${formatSignedNumber(value)}${suffix}`
    });
  }
}

function appendBreakdownStep(breakdown, source = {}, options = {}) {
  if (!breakdown) return null;
  const step = createItemValueAttributionStep(breakdown.total, source, options);
  breakdown.sources.push(step);
  breakdown.total = step.after;
  return step;
}

function reconcileBreakdownTotal(breakdown, target = 0, item = null, { name = "" } = {}) {
  if (!breakdown) return;
  const expected = Number(target) || 0;
  const current = Number(breakdown.total) || 0;
  if (Math.abs(expected - current) < 0.000001) {
    breakdown.total = expected;
    return;
  }
  appendBreakdownStep(breakdown, {
    name: name || localizeOrFallback("FALLOUTMAW.Item.TooltipBreakdownPreparedValue", "Итоговый расчёт"),
    img: item?.img,
    operation: "add",
    value: expected - current
  });
}

function collectActorCombatValueAttribution(actor, key = "", context = null) {
  if (!actor) return emptyCombatAttribution();
  const path = `system.combat.${String(key ?? "").trim()}`;
  const suffix = ["damagePercent", "criticalChance", "burstStability"].includes(key) ? "%" : "";
  const prepared = collectActorPreparedPathAttribution(actor, path, {
    preparedValue: actor?.system?.combat?.[key],
    suffix
  });
  let running = prepared.value;
  const sources = [...prepared.sources];

  if (context) {
    for (const change of getPreparedSourceContextualAbilityChanges(actor, path, context)) {
      const operationStep = createItemValueAttributionStep(running, {
        operation: change.type,
        value: change.value
      });
      const delta = operationStep.after - running;
      running = operationStep.after;
      if (!delta) continue;
      sources.push({
        name: change.sourceName || localizeOrFallback("FALLOUTMAW.Item.TooltipBreakdownContextAbility", "Контекстная способность"),
        img: change.sourceImg || actor.img,
        operation: "add",
        value: delta,
        valueLabel: formatConfiguredAttributionOperation(change.type, change.value, delta, suffix)
      });
    }
    const contextualValue = getTooltipContextualCombatValue(actor, key, context);
    if (contextualValue !== running) {
      sources.push({
        name: localizeOrFallback("FALLOUTMAW.Item.TooltipBreakdownContext", "Контекстный расчёт"),
        img: actor.img,
        operation: "add",
        value: contextualValue - running,
        valueLabel: `${formatSignedNumber(contextualValue - running)}${suffix}`
      });
      running = contextualValue;
    }
  }
  return { value: running, sources };
}

function collectActorPreparedPathAttribution(actor, path = "", {
  preparedValue = 0,
  suffix = "",
  expandEffectKeys = false
} = {}) {
  if (!actor || !path) return emptyCombatAttribution();
  let running = toInteger(foundry.utils.getProperty(actor?._source ?? {}, path));
  const sources = [];
  if (running) sources.push({
    name: `${actor.name}: ${localizeOrFallback("FALLOUTMAW.Item.TooltipBreakdownBase", "База")}`,
    img: actor.img,
    operation: "add",
    value: running,
    valueLabel: `${formatSignedNumber(running)}${suffix}`
  });

  for (const { effect, change } of collectActorEffectAttributionChanges(actor, path, { expandEffectKeys })) {
    const stage = String(change?.phase ?? "initial") === "initial" ? "initial-active-effect" : "prepared";
    const amount = evaluateActorEffectChangeNumber(actor, { ...change, effect }, { fallback: Number.NaN, stage });
    if (!Number.isFinite(amount)) continue;
    const operationStep = createItemValueAttributionStep(running, { operation: change.type, value: amount });
    const delta = operationStep.after - running;
    running = operationStep.after;
    if (!delta) continue;
    const document = getTooltipEffectSourceDocument(effect);
    sources.push({
      name: document?.name ?? effect?.name,
      img: document?.img ?? effect?.img,
      operation: "add",
      value: delta,
      valueLabel: formatConfiguredAttributionOperation(change.type, amount, delta, suffix)
    });
  }

  const expected = toInteger(preparedValue);
  if (expected !== running) {
    sources.push({
      name: localizeOrFallback("FALLOUTMAW.Item.TooltipBreakdownPreparedActor", "Подготовленные данные персонажа"),
      img: actor.img,
      operation: "add",
      value: expected - running,
      valueLabel: `${formatSignedNumber(expected - running)}${suffix}`
    });
    running = expected;
  }
  return { value: running, sources };
}

function collectActorEffectAttributionChanges(actor, path = "", { expandEffectKeys = false } = {}) {
  const entries = [];
  const suppressedIds = getActorSuppressedTraumaDiseaseIds(actor);
  for (const effect of actor?.allApplicableEffects?.() ?? actor?.effects ?? []) {
    if (effect?.disabled || effect?.active === false) continue;
    if (isActorTraumaDiseaseEffectSuppressed(actor, effect, suppressedIds)) continue;
    for (const originalChange of effect?.system?.changes ?? effect?.changes ?? []) {
      const changes = expandEffectKeys
        ? expandActorEffectChangeKeys(actor, originalChange)
        : [originalChange];
      for (const change of changes) {
        if (String(change?.key ?? "").trim() !== path) continue;
        entries.push({ effect, change });
      }
    }
  }
  return entries.sort((left, right) => (
    getTooltipEffectChangePhaseOrder(left.change) - getTooltipEffectChangePhaseOrder(right.change)
    || getTooltipEffectChangePriority(left.change) - getTooltipEffectChangePriority(right.change)
  ));
}

function getTooltipEffectChangePhaseOrder(change = {}) {
  const phase = String(change?.phase ?? "initial");
  if (phase === "initial") return 0;
  if (phase === "final") return 2;
  return 1;
}

function getTooltipEffectChangePriority(change = {}) {
  const configured = Number(change?.priority);
  if (change?.priority !== null && change?.priority !== undefined && change?.priority !== "" && Number.isFinite(configured)) {
    return Math.trunc(configured);
  }
  const ActiveEffect = foundry.documents?.ActiveEffect?.implementation ?? globalThis.ActiveEffect;
  return toInteger(ActiveEffect?.CHANGE_TYPES?.[change?.type]?.defaultPriority);
}

function getTooltipEffectSourceDocument(effect = null) {
  const parent = effect?.parent;
  if (parent?.documentName === "Item") return parent;
  const originUuid = String(effect?.origin ?? "").trim();
  if (originUuid) {
    try {
      const origin = globalThis.fromUuidSync?.(originUuid) ?? foundry.utils.fromUuidSync?.(originUuid);
      if (origin?.documentName === "Item") return origin;
      if (origin?.parent?.documentName === "Item") return origin.parent;
    } catch (_error) {
      // Compendium and unloaded embedded origins are allowed to fall back to the effect itself.
    }
  }
  return effect;
}

function formatConfiguredAttributionOperation(operation = "add", amount = 0, delta = 0, suffix = "") {
  const configured = String(operation ?? "add");
  const value = Number(amount) || 0;
  const deltaText = `${formatSignedNumber(delta)}${suffix}`;
  if (configured === "multiply") return `×${formatNumber(value)} (${deltaText})`;
  if (configured === "subtract") return `−${formatNumber(value)}${suffix} (${deltaText})`;
  if (configured === "override") return `→ ${formatNumber(value)}${suffix} (${deltaText})`;
  if (configured === "upgrade") return `min ${formatNumber(value)}${suffix} (${deltaText})`;
  if (configured === "downgrade") return `max ${formatNumber(value)}${suffix} (${deltaText})`;
  return `${formatSignedNumber(value)}${suffix}`;
}

function buildWeaponRecoilAttribution(item, actor, baseData = {}, data = {}) {
  const base = getWeaponBurstDifficultyPerShot(baseData);
  const total = getEffectiveWeaponBurstDifficultyPerShot(data, actor);
  const breakdown = {
    title: game.i18n.localize("FALLOUTMAW.Item.WeaponRecoil"),
    actorName: actor?.name,
    img: item?.img,
    base: { name: item?.name, img: item?.img, value: base },
    sources: [],
    total: base,
    formatValue: formatNumber
  };
  const stability = collectActorCombatValueAttribution(actor, "burstStability");
  appendParallelPercentSources(breakdown, stability.sources, {
    expectedPercent: stability.value,
    direction: -1,
    round: Math.round,
    total,
    contributionUnit: localizeOrFallback("FALLOUTMAW.Item.TooltipBreakdownRecoilUnit", "сложности")
  });
  return breakdown;
}

function getWeaponTooltipAbilityContext(item, data = {}) {
  return {
    weaponUuid: String(item?.uuid ?? "").trim(),
    weaponData: data
  };
}

function getTooltipContextualCombatValue(actor, key, context = {}) {
  if (!actor) return 0;
  return getContextualAbilityChangeValue(actor, `system.combat.${key}`, {
    ...context,
    baseValue: toInteger(actor?.system?.combat?.[key])
  });
}

function getWeaponProficiencyInfluenceBonus(actor, data = {}, influenceKey = "") {
  if (!actor) return 0;
  const proficiency = getWeaponProficiencySetting(data);
  if (!proficiency) return 0;
  const range = getProficiencyInfluenceSettings()?.[influenceKey] ?? { min: 0, max: 0 };
  const minimum = toInteger(range.min);
  const maximum = toInteger(range.max);
  const actorValue = toInteger(actor.system?.proficiencies?.[proficiency.key]?.value);
  const settingMax = Math.max(0, toInteger(proficiency.max));
  const ratio = settingMax > 0 ? Math.max(0, Math.min(1, actorValue / settingMax)) : 0;
  return Math.round(minimum + ((maximum - minimum) * ratio));
}

function getWeaponProficiencySetting(data = {}) {
  const proficiencies = getProficiencySettings();
  if (!proficiencies.length) return null;
  const key = String(data?.proficiencyKey ?? "");
  return proficiencies.find(proficiency => proficiency.key === key) ?? proficiencies[0] ?? null;
}

function formatWeaponDamageValue(data = {}, damage = 0) {
  const effectiveDamage = Math.max(0, toInteger(damage));
  const pellets = Math.max(1, toInteger(data._evaluatedPellets ?? data.pellets));
  return pellets > 1 ? `${effectiveDamage} / ${pellets}` : String(effectiveDamage);
}

function formatFormulaDamageValue(formula, actor = null) {
  const text = String(formula ?? "0").trim() || "0";
  const displayFormula = formatActorFormulaForDisplay(text, actor, { includeValues: Boolean(actor) });
  if (!actor) return displayFormula;
  const value = evaluateActorFormula(text, actor, {
    minimum: 0,
    context: "damage source tooltip"
  });
  return text === String(value) ? String(value) : `${value} (${displayFormula})`;
}

function evaluateTooltipFormula(formula, actor = null, options = {}) {
  if (!actor) return Number(formula) || Number(options.fallback) || 0;
  return evaluateActorFormula(formula, actor, options);
}

function getWeaponDamageDistributionLabel(item, data = {}) {
  return getWeaponDamageTypeLabels(getEffectiveWeaponDamageData(item, data)).join(", ");
}

function getWeaponVolleyRows(data = {}, { actor = null } = {}) {
  const volley = data.volley ?? {};
  const rows = [];
  const damageRadius = evaluateTooltipFormula(volley.damageRadius, actor);
  if (damageRadius > 0) rows.push(["Радиус взрыва", `${formatNumber(damageRadius)} м`]);

  const regionDamage = getWeaponDamageEntryLabels(volley.regionDamageEntries, actor);
  const regionRadius = evaluateTooltipFormula(volley.regionRadius, actor);
  const regionDuration = evaluateTooltipFormula(volley.regionDurationSeconds, actor);
  const explosionDelay = evaluateTooltipFormula(volley.regionDelaySeconds, actor);
  const regionDelta = evaluateTooltipFormula(volley.regionRadiusDeltaMeters, actor);
  if (regionRadius > 0) rows.push(["Радиус области", `${formatNumber(regionRadius)} м`]);
  if (regionDamage.length) {
    rows.push(["Урон области", { html: renderTooltipValueTokens(regionDamage) }]);
  }
  if (regionDuration > 0) rows.push(["Длительность области", `${formatNumber(regionDuration)} с`]);
  if (explosionDelay > 0) rows.push(["Задержка до взрыва", `${formatNumber(explosionDelay)} с`]);
  if (regionDelta !== 0) rows.push(["Изменение радиуса", `${regionDelta > 0 ? "+" : ""}${formatNumber(regionDelta)} м`]);
  return rows;
}

function getWeaponActionDetailRows(data = {}, { actor = null } = {}) {
  const rows = [];
  if (isWeaponActionEnabled(data, "volley")) rows.push(...getWeaponVolleyRows(data, { actor }));
  return rows;
}

function getWeaponBurstDifficultyPerShot(data = {}) {
  return Math.max(0, toInteger(data?.burst?.difficultyPerShot));
}

function getEffectiveWeaponBurstDifficultyPerShot(data = {}, actor = null) {
  const base = getWeaponBurstDifficultyPerShot(data);
  const stabilityPercent = toInteger(actor?.system?.combat?.burstStability);
  return Math.max(0, Math.round(base * Math.max(0, 1 - (stabilityPercent / 100))));
}

function isWeaponActionEnabled(data = {}, actionKey = "") {
  if (actionKey === "reload" && hasWeaponResourceCostData(data, "magazine")) return true;
  return Boolean(data?.availableActions?.[actionKey]);
}

function getWeaponDamageEntryLabels(entries = [], actor = null) {
  return getWeaponDamageEntryRows(entries, actor)
    .map(([label, value]) => `${label}: ${value}`);
}

function getWeaponDamageEntryRows(entries = [], actor = null) {
  const damageTypes = getDamageTypeSettings();
  const labels = new Map(damageTypes.map(type => [type.key, type.label ?? type.key]));
  return (entries ?? [])
    .map(entry => {
      const key = String(entry?.damageTypeKey ?? "").trim();
      const formula = String(entry?.amount ?? "0").trim() || "0";
      const amount = actor
        ? evaluateActorFormula(formula, actor, {
          minimum: 0,
          context: "tooltip damage entry"
        })
        : 0;
      if (!key || (actor ? amount <= 0 : !isFormulaTextConfigured(formula))) return null;
      const displayFormula = formatActorFormulaForDisplay(formula, actor, { includeValues: Boolean(actor) });
      const amountLabel = formula === String(amount) ? String(amount) : `${amount} (${displayFormula})`;
      return [labels.get(key) ?? key, actor ? amountLabel : displayFormula];
    })
    .filter(Boolean);
}

function getWeaponDamageTypeLabels(data = {}) {
  return getWeaponDamageTypeEntries(data).map(entry => `${entry.label}: ${entry.percent}%`);
}

function getWeaponDamageTypeEntries(data = {}) {
  const damageTypes = getDamageTypeSettings();
  const labels = new Map(damageTypes.map(type => [type.key, type.label ?? type.key]));
  const rows = Array.isArray(data.damageTypes) && data.damageTypes.length
    ? data.damageTypes
    : [{ key: data.damageTypeKey, percent: 100 }];
  return rows
    .filter(row => String(row?.key ?? "").trim())
    .map(row => {
      const key = String(row.key ?? "");
      return {
        key,
        label: labels.get(key) ?? key,
        percent: toInteger(row.percent) || 100
      };
    });
}

function isSourceDamageMode(data = {}) {
  return String(data?.damageMode ?? "manual") === "source";
}

function getEffectiveWeaponDamageData(_item, data = {}) {
  if (data?.source === "damageSource") return data;
  if (!isSourceDamageMode(data)) return data;
  const sourceItem = getWeaponDamageSourceItem(data);
  if (!sourceItem || !hasItemFunction(sourceItem, ITEM_FUNCTIONS.damageSource)) {
    return {
      damage: 0,
      damageTypeKey: "firearm",
      damageTypes: [{ key: "firearm", percent: 100 }]
    };
  }
  const source = getDamageSourceFunction(sourceItem);
  return {
    ...data,
    source: "damageSource",
    damage: source.damage,
    damageTypeKey: source.damageTypeKey,
    damageTypes: source.damageTypes
  };
}

function getEffectiveWeaponTooltipData(data = {}, { applyModules = true, moduleSlots = null } = {}) {
  const moduleOptions = Array.isArray(moduleSlots) ? { moduleSlots } : {};
  if (!isSourceDamageMode(data)) {
    const effective = applyModules ? applyWeaponModuleModifiers(data, moduleOptions) : data;
    return applyModules ? applyWeaponAttackPowerTooltipModifiers(effective) : effective;
  }
  const sourceItem = getWeaponDamageSourceItem(data);
  if (!sourceItem || !hasItemFunction(sourceItem, ITEM_FUNCTIONS.damageSource)) {
    const effective = applyModules ? applyWeaponModuleModifiers(data, moduleOptions) : data;
    return applyModules ? applyWeaponAttackPowerTooltipModifiers(effective) : effective;
  }
  const merged = mergeWeaponDataWithDamageSource(data, getDamageSourceFunction(sourceItem));
  const effective = applyModules ? applyWeaponModuleModifiers(merged, moduleOptions) : merged;
  return applyModules ? applyWeaponAttackPowerTooltipModifiers(effective) : effective;
}

function mergeWeaponDataWithDamageSource(data = {}, source = {}) {
  return {
    ...data,
    source: "damageSource",
    damage: source.damage,
    pellets: source.pellets,
    damageTypeKey: source.damageTypeKey,
    damageTypes: source.damageTypes,
    attackAnimationKey: String(source.attackAnimationKey ?? ""),
    accuracyBonus: addFormulaTexts(data.accuracyBonus, source.accuracyBonus),
    criticalChanceModifier: addFormulaTexts(data.criticalChanceModifier, source.criticalChanceModifier),
    criticalDamagePercent: addFormulaTexts(data.criticalDamagePercent, source.criticalDamagePercent),
    maxRangeMeters: addFormulaTexts(data.maxRangeMeters, source.maxRangeMeters),
    effectiveRange: {
      value: addFormulaTexts(data.effectiveRange?.value, source.effectiveRange?.value),
      max: addFormulaTexts(data.effectiveRange?.max, source.effectiveRange?.max)
    },
    penetration: addFormulaTexts(data.penetration, source.penetration),
    volley: mergeDamageSourceVolleyData(data.volley, source.volley)
  };
}

function applyWeaponAttackPowerTooltipModifiers(data = {}) {
  const state = getWeaponAttackPowerState(data);
  if (!state.active || state.increments <= 0) return data;
  const result = foundry.utils.deepClone(data);
  const multiplier = Math.max(0, toInteger(state.increments));
  const perLevel = state.perLevel ?? {};

  result.attackPowerDamagePercent = toInteger(perLevel.damagePercent) * multiplier;
  addTooltipFormulaNumber(result, "accuracyBonus", perLevel.accuracyBonus, multiplier);
  addTooltipFormulaNumber(result, "criticalChanceModifier", perLevel.criticalChanceModifier, multiplier);
  addTooltipFormulaNumber(result, "criticalDamagePercent", perLevel.criticalDamagePercent, multiplier, { min: 0 });
  addTooltipNumber(result, "attackConeDegrees", perLevel.attackConeDegrees, multiplier, { min: 0 });
  addTooltipFormulaNumber(result, "maxRangeMeters", perLevel.maxRangeMeters, multiplier, { min: 0 });
  addTooltipFormulaNumber(result, "effectiveRange.value", perLevel.effectiveRange?.value, multiplier, { min: 0 });
  addTooltipFormulaNumber(result, "effectiveRange.max", perLevel.effectiveRange?.max, multiplier, { min: 0 });
  addTooltipFormulaNumber(result, "penetration", perLevel.penetration, multiplier, { min: 0, integer: true });
  applyWeaponAttackPowerTooltipResourceCosts(result, state.resourceCosts, multiplier);
  return result;
}

function applyWeaponAttackPowerTooltipResourceCosts(data = {}, resourceCosts = [], multiplier = 0) {
  const costs = Array.isArray(data.resourceCosts) ? foundry.utils.deepClone(data.resourceCosts) : [];
  if (isSourceDamageMode(data) && !costs.some(cost => String(cost?.type ?? "") === "magazine")) {
    costs.push({ type: "magazine", amount: 1 });
  }

  for (const cost of resourceCosts ?? []) {
    const type = String(cost?.type ?? "").trim();
    const delta = toInteger(cost?.amount) * Math.max(0, toInteger(multiplier));
    if (!type || !delta) continue;
    let target = costs.find(entry => String(entry?.type ?? "") === type);
    if (!target) {
      target = { type, amount: 0 };
      costs.push(target);
    }
    target.amount = Math.max(0, toInteger(target.amount) + delta);
  }
  data.resourceCosts = costs;
}

function addTooltipFormulaNumber(target, path, delta, multiplier = 1, { min = null, integer = false } = {}) {
  const change = (integer ? toInteger(delta) : Number(delta)) * Math.max(0, toInteger(multiplier));
  if (!Number.isFinite(change) || change === 0) return;
  const currentRaw = foundry.utils.getProperty(target, path);
  const current = Number(currentRaw);
  if (Number.isFinite(current)) {
    const next = Number.isFinite(Number(min)) ? Math.max(Number(min), current + change) : current + change;
    foundry.utils.setProperty(target, path, integer ? Math.trunc(next) : next);
    return;
  }
  foundry.utils.setProperty(target, path, addFormulaTexts(currentRaw, integer ? Math.trunc(change) : change));
}

function addTooltipNumber(target, path, delta, multiplier = 1, { min = null, integer = false } = {}) {
  const change = (integer ? toInteger(delta) : Number(delta)) * Math.max(0, toInteger(multiplier));
  if (!Number.isFinite(change) || change === 0) return;
  const currentRaw = foundry.utils.getProperty(target, path);
  const current = integer ? toInteger(currentRaw) : Number(currentRaw);
  const fallback = Number.isFinite(current) ? current : 0;
  let next = fallback + change;
  if (Number.isFinite(Number(min))) next = Math.max(Number(min), next);
  foundry.utils.setProperty(target, path, integer ? Math.trunc(next) : next);
}

function mergeDamageSourceVolleyData(weaponVolley = {}, sourceVolley = {}) {
  return {
    ...(weaponVolley ?? {}),
    damageRadius: normalizeFormulaText(sourceVolley?.damageRadius),
    regionRadius: normalizeFormulaText(sourceVolley?.regionRadius),
    regionDamageEntries: Array.isArray(sourceVolley?.regionDamageEntries)
      ? foundry.utils.deepClone(sourceVolley.regionDamageEntries)
      : [],
    regionDurationSeconds: normalizeFormulaText(sourceVolley?.regionDurationSeconds),
    regionDelaySeconds: normalizeFormulaText(sourceVolley?.regionDelaySeconds),
    regionRadiusDeltaMeters: normalizeFormulaText(sourceVolley?.regionRadiusDeltaMeters),
    explosionAnimationKey: String(sourceVolley?.explosionAnimationKey ?? "")
  };
}

function getWeaponDamageSourceLabel(data = {}) {
  const sourceItem = getWeaponDamageSourceItem(data);
  if (!sourceItem) return "—";
  const source = getDamageSourceFunction(sourceItem);
  return String(source?.name ?? "").trim() || sourceItem.name;
}

function getWeaponDamageSourceItem(data = {}) {
  const uuid = String(data?.magazine?.sourceItemUuid ?? "").trim();
  if (!uuid) return null;
  return resolveWorldItemSync(uuid);
}

function getSkillLabel(skillKey = "") {
  const key = String(skillKey ?? "");
  if (!key) return "—";
  return getSkillSettings().find(skill => skill.key === key)?.label ?? key;
}

function getCharacteristicLabel(characteristicKey = "") {
  const key = String(characteristicKey ?? "");
  if (!key) return "";
  return getCharacteristicSettings().find(characteristic => characteristic.key === key)?.label ?? key;
}

function getToolLabel(toolKey = "") {
  const key = String(toolKey ?? "");
  if (!key) return "—";
  return getToolSettings().find(tool => tool.key === key)?.label ?? key;
}

function getConditionRecoveryMethodRows(condition = {}) {
  return (condition.recoveryMethods ?? [])
    .filter(method => String(method?.type ?? "tools") === "tools")
    .map(method => {
      const toolKey = String(method.toolKey ?? "").trim();
      const tool = toolKey
        ? getToolLabel(toolKey)
        : game.i18n.localize("FALLOUTMAW.Item.ConditionRecoveryMethodTools");
      const toolClass = String(method.toolClass ?? "D");
      const difficulty = Math.max(0, toInteger(method.difficulty));
      return [tool, `${game.i18n.localize("FALLOUTMAW.Item.ConditionRecoveryClass")}: ${toolClass}, СЛ: ${difficulty}`];
    });
}

function getWeaponResourceCostRows(data = {}, baseData = {}, {
  baseMode = false,
  resourceCostMultipliers = {},
  breakdowns = new Map()
} = {}) {
  return (data.resourceCosts ?? [])
    .filter(cost => !(String(cost?.type ?? "") === "magazine" && Math.max(0, toInteger(cost?.amount)) <= 1))
    .map((cost, index) => {
      const costType = String(cost?.type ?? "").trim();
      const rawAmount = Math.max(0, toInteger(cost?.amount));
      const multiplier = baseMode ? 1 : Math.max(0, Number(resourceCostMultipliers?.[costType]) || 1);
      const amount = Math.max(0, Math.ceil(rawAmount * multiplier));
      const baseAmount = Math.max(0, toInteger(
        (baseData.resourceCosts ?? []).find(entry => String(entry?.type ?? "") === costType)?.amount ?? 0
      ));
      const type = getWeaponResourceTypeLabel(costType);
      return [type, renderChangedNumber(amount, baseAmount, {
        baseMode,
        higherIsBetter: false,
        breakdown: breakdowns?.get?.(costType)
      })];
    })
    .filter(([type]) => Boolean(type));
}

function getWeaponResourceTypeLabel(type = "") {
  if (type === "magazine") return game.i18n.localize("FALLOUTMAW.Item.WeaponCostMagazine");
  if (type === "condition") return game.i18n.localize("FALLOUTMAW.Item.WeaponCostCondition");
  if (type === "energyConsumer") return game.i18n.localize("FALLOUTMAW.Item.WeaponCostEnergy");
  if (type === "quantity") return game.i18n.localize("FALLOUTMAW.Item.WeaponCostQuantity");
  return String(type || "—");
}

function getWeaponRequirementLabels(data = {}, actor = null, item = null) {
  return (data.requirements ?? [])
    .map(requirement => getWeaponRequirementLabel(requirement, actor, item))
    .filter(label => hasTooltipRowValue(label));
}

function getWeaponRequirementLabel(requirement = {}, actor = null, item = null) {
  const type = String(requirement?.type ?? "") === "skill" ? "skill" : "characteristic";
  const key = String(requirement?.key ?? "").trim();
  const required = Math.max(0, toInteger(requirement?.value));
  if (!key || !required) return "";
  const label = type === "skill" ? getSkillLabel(key) : getCharacteristicLabel(key);
  if (!actor) return `${label} ${required}`;
  const current = getActorWeaponRequirementValue(actor, { type, key });
  const text = `${label} ${current}/${required}`;
  return {
    html: renderChangedTooltipSpan(text, current >= required, buildWeaponRequirementAttribution(item, actor, {
      type,
      key,
      label,
      current
    }))
  };
}

function buildWeaponRequirementAttribution(item, actor, { type = "characteristic", key = "", label = "", current = 0 } = {}) {
  if (type === "skill") {
    return buildWeaponSkillRequirementAttribution(item, actor, { key, label, current });
  }

  const path = `system.characteristics.${key}`;
  const rawBase = toInteger(foundry.utils.getProperty(actor?._source ?? {}, path));
  const attribution = collectActorPreparedPathAttribution(actor, path, { preparedValue: current });
  const breakdown = {
    title: `${game.i18n.localize("FALLOUTMAW.Item.WeaponUseRequirements")}: ${label}`,
    actorName: actor?.name,
    img: item?.img ?? actor?.img,
    base: {
      name: `${actor?.name ?? ""}: ${localizeOrFallback("FALLOUTMAW.Item.TooltipBreakdownBase", "База")}`,
      img: actor?.img,
      value: rawBase
    },
    sources: [],
    total: rawBase,
    formatValue: formatNumber
  };
  const sources = rawBase ? attribution.sources.slice(1) : attribution.sources;
  appendAttributionDeltaSources(breakdown, sources);
  reconcileBreakdownTotal(breakdown, current, item);
  return breakdown;
}

function buildWeaponSkillRequirementAttribution(item, actor, { key = "", label = "", current = 0 } = {}) {
  const skill = actor?.system?.skills?.[key] ?? {};
  const prepared = decomposePreparedSkillValue(skill);
  const bonusPath = `system.skills.${key}.bonus`;
  const rawBonus = toInteger(foundry.utils.getProperty(actor?._source ?? {}, bonusPath));
  const bonusAttribution = collectActorPreparedPathAttribution(actor, bonusPath, {
    preparedValue: skill.bonus,
    expandEffectKeys: true
  });
  const breakdown = {
    title: `${game.i18n.localize("FALLOUTMAW.Item.WeaponUseRequirements")}: ${label}`,
    actorName: actor?.name,
    img: item?.img ?? actor?.img,
    base: {
      name: `${actor?.name ?? ""}: ${localizeOrFallback("FALLOUTMAW.Advancement.BaseSkill", "База навыка")}`,
      img: actor?.img,
      value: prepared.base
    },
    sources: [],
    total: prepared.base,
    formatValue: formatNumber
  };

  if (rawBonus) appendBreakdownStep(breakdown, {
    name: localizeOrFallback("FALLOUTMAW.Item.TooltipBreakdownSkillBonus", "Бонус навыка"),
    img: actor?.img,
    operation: "add",
    value: rawBonus
  });

  const effectSources = rawBonus ? bonusAttribution.sources.slice(1) : bonusAttribution.sources;
  appendAttributionDeltaSources(breakdown, effectSources);
  if (prepared.developmentBonus) appendBreakdownStep(breakdown, {
    name: localizeOrFallback("FALLOUTMAW.Advancement.DevelopmentBonus", "Бонус развития"),
    img: actor?.img,
    operation: "add",
    value: prepared.developmentBonus
  });
  if (prepared.abilityBonus) appendBreakdownStep(breakdown, {
    name: localizeOrFallback("FALLOUTMAW.Item.TooltipBreakdownAbilityBonus", "Бонус способностей"),
    img: actor?.img,
    operation: "add",
    value: prepared.abilityBonus
  });

  const clamped = Math.min(Math.max(breakdown.total, prepared.min), prepared.max);
  if (clamped !== breakdown.total) appendBreakdownStep(breakdown, {
    name: `${localizeOrFallback("FALLOUTMAW.Item.TooltipBreakdownSkillLimit", "Предел навыка")} (${formatNumber(prepared.min)}–${formatNumber(prepared.max)})`,
    img: actor?.img,
    operation: "override",
    value: clamped
  });

  reconcileBreakdownTotal(breakdown, current, item);
  return breakdown;
}

function getActorWeaponRequirementValue(actor, requirement = {}) {
  const key = String(requirement?.key ?? "").trim();
  if (!key) return 0;
  if (String(requirement?.type ?? "") === "skill") return toInteger(actor?.system?.skills?.[key]?.value);
  return toInteger(actor?.system?.characteristics?.[key]);
}

function getWeaponActionLabels(data = {}, baseData = {}, {
  actor = null,
  baseMode = false,
  item = null,
  moduleSlots = []
} = {}) {
  const definitions = [
    ["aimedShot", game.i18n.localize("FALLOUTMAW.Item.WeaponActionAimedShot")],
    ["snapshot", game.i18n.localize("FALLOUTMAW.Item.WeaponActionSnapshot")],
    ["burst", game.i18n.localize("FALLOUTMAW.Item.WeaponActionBurst")],
    ["volley", game.i18n.localize("FALLOUTMAW.Item.WeaponActionVolley")],
    ["meleeAttack", game.i18n.localize("FALLOUTMAW.Item.WeaponActionMeleeAttack")],
    ["aimedMeleeAttack", game.i18n.localize("FALLOUTMAW.Item.WeaponActionAimedMeleeAttack")],
    ["push", game.i18n.localize("FALLOUTMAW.Item.WeaponActionPush")],
    ["reload", game.i18n.localize("FALLOUTMAW.Item.WeaponActionReload")]
  ];
  return definitions
    .filter(([key]) => isWeaponActionEnabled(data, key))
    .map(([key, label]) => {
      const name = String(data[key]?.name ?? "").trim() || label;
      const attribution = getWeaponActionPointCostAttribution(actor, data, key, baseData, { moduleSlots });
      const cost = baseMode ? attribution.configuredCost : attribution.cost;
      const baseCost = attribution.baseCost;
      const costText = `${cost} ОД`;
      const costHtml = baseMode || cost === baseCost
        ? escapeHTML(costText)
        : renderChangedTooltipSpan(costText, cost < baseCost, buildWeaponActionCostBreakdown(item, actor, name, attribution));
      return { html: `${escapeHTML(name)} (${costHtml})` };
    });
}

function buildWeaponActionCostBreakdown(item, actor, actionName = "", attribution = {}) {
  const breakdown = {
    title: `${actionName} — ${localizeOrFallback("FALLOUTMAW.Item.TooltipBreakdownActionCost", "стоимость действия")}`,
    actorName: actor?.name,
    img: item?.img,
    base: { name: item?.name, img: item?.img, value: attribution.baseCost },
    sources: [],
    total: attribution.baseCost,
    formatValue: value => `${formatNumber(value)} ОД`
  };
  for (const source of attribution.sources ?? []) {
    const steps = source.steps?.length ? source.steps : [source];
    for (const step of steps) {
      if (Number.isFinite(Number(step.before)) && Number(step.before) !== breakdown.total) {
        reconcileBreakdownTotal(breakdown, Number(step.before), item, {
          name: localizeOrFallback("FALLOUTMAW.Item.TooltipBreakdownConfiguredCost", "Настройки оружия")
        });
      }
      const before = Number.isFinite(Number(step.before)) ? Number(step.before) : breakdown.total;
      const after = Number.isFinite(Number(step.after)) ? Number(step.after) : before + (Number(source.delta) || 0);
      breakdown.sources.push({
        name: source.name,
        img: source.img,
        operation: step.operation ?? source.operation ?? "add",
        value: Number(step.value) || 0,
        valueLabel: formatConfiguredAttributionOperation(
          step.operation ?? source.operation,
          step.value,
          after - before,
          " ОД"
        ),
        before,
        after,
        delta: after - before
      });
      breakdown.total = after;
    }
  }
  reconcileBreakdownTotal(breakdown, attribution.cost, item);
  return breakdown;
}

function hasWeaponResourceCostData(weaponData = {}, type = "") {
  if (type === "magazine" && String(weaponData?.damageMode ?? "manual") === "source") return true;
  return (weaponData?.resourceCosts ?? []).some(cost => String(cost?.type ?? "") === type);
}

function renderTooltipValueTokens(values = [], { comma = false } = {}) {
  return values
    .map((value, index) => {
      const suffix = comma && index < values.length - 1 ? "," : "";
      const content = value && typeof value === "object" && Object.hasOwn(value, "html")
        ? `${value.html}${escapeHTML(suffix)}`
        : escapeHTML(`${value}${suffix}`);
      return `<span class="function-value-token">${content}</span>`;
    })
    .join(" ");
}

function buildToolTooltipSections(item) {
  const tools = item.system?.functions?.tools ?? {};
  return getToolSettings()
    .filter(tool => tools?.[tool.key]?.enabled)
    .map(tool => {
      const data = getToolFunction(item, tool.key);
      const rows = [
        ["Класс", String(data.toolClass ?? "D")],
        ["Запас", `${toInteger(data.supply?.value)} / ${toInteger(data.supply?.max)}`],
        ["Навык", `${getSkillLabel(data.skillKey)} ${toInteger(data.skillValue)}`]
      ];
      return renderTooltipFunctionSection(tool.label ?? tool.key, rows);
    });
}

function renderTooltipFunctionSection(title, rows = []) {
  const content = renderTooltipFunctionGrid(rows);
  if (!content) return "";
  return `
    <section class="function-section">
      <h4>${escapeHTML(title)}</h4>
      ${content}
    </section>
  `;
}

function renderTooltipFunctionGrid(rows = []) {
  const content = rows
    .filter(row => hasTooltipRowValue(row?.[1]))
    .map(([label, value]) => `
      <div class="function-row">
        <span>${escapeHTML(formatTooltipLabel(label))}</span>
        <strong>${renderTooltipRowValue(value)}</strong>
      </div>
    `).join("");
  if (!content) return "";
  return `<div class="function-grid">${content}</div>`;
}

function renderTooltipSingleValueSection(title, value) {
  if (!hasTooltipRowValue(value)) return "";
  return `
    <section class="function-section single-value">
      <h4>${escapeHTML(title)}</h4>
      <strong>${renderTooltipRowValue(value)}</strong>
    </section>
  `;
}

function hasTooltipRowValue(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === "object" && Object.hasOwn(value, "html")) return String(value.html ?? "").trim() !== "";
  return String(value).trim() !== "";
}

function renderTooltipRowValue(value) {
  if (typeof value === "object" && Object.hasOwn(value, "html")) return String(value.html ?? "");
  return escapeHTML(value);
}

function formatTooltipLabel(label = "") {
  const text = String(label ?? "").trim();
  if (!text) return "";
  return /[:：]$/.test(text) ? text : `${text}:`;
}

function formatProgress(value) {
  return formatNumber(Math.max(0, Number(value) || 0));
}

function formatMultiplier(value) {
  return formatNumber(Math.max(1, Number(value) || 1));
}

function formatHours(value) {
  const numeric = Math.max(0, Number(value) || 0);
  return numeric.toFixed(1).replace(/\.0$/, "");
}

function calculateDiseaseWorseningMultiplier(actor, needKey) {
  const need = actor?.system?.needs?.[String(needKey ?? "")];
  if (!need) return 1;
  const min = toInteger(need.min);
  const max = Math.max(min, toInteger(need.max));
  const value = Math.min(max, Math.max(min, toInteger(need.value)));
  const percent = ((value - min) / Math.max(1, max - min)) * 100;
  return Math.max(1, Math.floor(percent / 10) * 2);
}

function calculateDiseaseHoursUntilWorsening(item, multiplier) {
  const progress = Math.max(0, Math.min(100, Number(item?.system?.worseningProgress) || 0));
  const baseSeconds = Math.max(1, toInteger(item?.system?.worseningBaseSeconds) || (24 * 60 * 60));
  const safeMultiplier = Math.max(1, Number(multiplier) || 1);
  return ((100 - progress) / 100) * (baseSeconds / 3600) / safeMultiplier;
}

function escapeHTML(value) {
  const element = document.createElement("span");
  element.textContent = String(value ?? "");
  return element.innerHTML;
}

function escapeAttribute(value) {
  return escapeHTML(value).replace(/"/g, "&quot;");
}

function prepareIndicatorEntry({
  key = "",
  label = "",
  color = "#8f8456",
  data = {},
  inputName = "",
  active = false,
  ...extra
} = {}) {
  const min = Math.max(-100, toInteger(data?.min));
  const max = Math.max(min, toInteger(data?.max));
  const value = Math.min(Math.max(toInteger(data?.value), min), max);
  const negativeRange = min < 0 ? Math.abs(min) : 0;
  const positiveFloor = Math.max(0, min);
  const positiveRange = Math.max(0, max - positiveFloor);
  const isNegative = value < 0 && negativeRange > 0;
  const percent = isNegative
    ? ((Math.abs(value) / negativeRange) * 100)
    : (positiveRange > 0 ? (((Math.max(value, positiveFloor) - positiveFloor) / positiveRange) * 100) : 0);
  const segments = getIndicatorSegmentCount(isNegative ? negativeRange : positiveRange || max);
  const normalizedColor = normalizeIndicatorColor(isNegative ? "#c8463d" : color);

  return {
    ...extra,
    key,
    label,
    color: normalizedColor,
    min,
    value,
    max,
    active,
    inputName,
    isNegative,
    percent: Number(percent.toFixed(2)),
    segments,
    meterStyle: buildIndicatorMeterStyle(normalizedColor, segments),
    fillStyle: buildIndicatorFillStyle(normalizedColor, percent, { reverse: isNegative })
  };
}

function getIndicatorSegmentCount(value = 0) {
  if (value <= 0) return 10;
  return Math.max(1, Math.min(24, Math.trunc(value)));
}

function buildIndicatorMeterStyle(color, segments) {
  const baseColor = normalizeIndicatorColor(color);
  return [
    `--meter-sections: ${segments}`,
    `--meter-color: ${baseColor}`,
    `--meter-color-strong: ${mixHexColor(baseColor, "#ffffff", 0.2)}`,
    `--meter-color-dark: ${mixHexColor(baseColor, "#000000", 0.28)}`,
    `--meter-color-soft: ${hexToRgba(baseColor, 0.2)}`,
    `--meter-color-glow: ${hexToRgba(baseColor, 0.34)}`
  ].join("; ");
}

function buildIndicatorFillStyle(color, percent, { reverse = false } = {}) {
  const baseColor = normalizeIndicatorColor(color);
  const strongColor = mixHexColor(baseColor, "#ffffff", 0.2);
  const darkColor = mixHexColor(baseColor, "#000000", 0.28);
  return [
    reverse ? "margin-left: auto" : "",
    `width: ${Number(percent.toFixed(2))}%`,
    `background: linear-gradient(180deg, ${strongColor}, ${darkColor})`,
    `box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.22), 0 0 14px ${hexToRgba(baseColor, 0.34)}`
  ].filter(Boolean).join("; ");
}

function normalizeIndicatorColor(color) {
  const normalized = String(color ?? "").trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{6}$/.test(normalized)) return `#${normalized}`;
  if (/^[0-9a-f]{3}$/.test(normalized)) return `#${normalized.split("").map(char => `${char}${char}`).join("")}`;
  return "#8f8456";
}

function mixHexColor(hexColor, mixWith, amount = 0.5) {
  const base = hexToRgb(normalizeIndicatorColor(hexColor));
  const mix = hexToRgb(normalizeIndicatorColor(mixWith));
  const ratio = Math.max(0, Math.min(1, Number(amount) || 0));
  const channels = [base.r, base.g, base.b].map((channel, index) => {
    const target = [mix.r, mix.g, mix.b][index];
    return Math.round(channel + ((target - channel) * ratio));
  });
  return `#${channels.map(channel => channel.toString(16).padStart(2, "0")).join("")}`;
}

function hexToRgba(hexColor, alpha = 1) {
  const { r, g, b } = hexToRgb(normalizeIndicatorColor(hexColor));
  const normalizedAlpha = Math.max(0, Math.min(1, Number(alpha) || 0));
  return `rgba(${r}, ${g}, ${b}, ${normalizedAlpha})`;
}

function hexToRgb(hexColor) {
  const normalized = normalizeIndicatorColor(hexColor).slice(1);
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16)
  };
}

function serializeSet(set) {
  return Array.from(set).sort().join("|");
}

function serializeWeaponSlotRequirement(system = {}, creatureOptions = getCreatureOptions()) {
  const requirement = getWeaponSlotRequirement(system);
  return `${requirement.mode}:${serializeSet(getValidSelectedWeaponSlotKeysForOptions(creatureOptions, system))}`;
}

function serializeItemFunctions(functions = {}) {
  return JSON.stringify(normalizeItemFunctionsForStack(functions));
}

function normalizeItemFunctionsForStack(functions = {}) {
  return normalizeStackComparableValue(functions);
}

function normalizeStackComparableValue(value) {
  if (typeof value?.toObject === "function") return normalizeStackComparableValue(value.toObject(false));
  if (value instanceof Set) return Array.from(value).sort();
  if (Array.isArray(value)) return value.map(entry => normalizeStackComparableValue(entry));
  if (!value || typeof value !== "object") return value ?? null;

  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  return Object.fromEntries(entries.map(([key, entryValue]) => [key, normalizeStackComparableValue(entryValue)]));
}

function getInventoryGridDimensions(race, actor = null) {
  const actorInventory = actor?.system?.inventory;
  const columns = toInteger(actorInventory?.columns);
  const rows = toInteger(actorInventory?.rows);
  if (columns > 0 && rows > 0) return { columns, rows };
  const inventorySize = race?.inventorySize ?? createDefaultInventorySize();
  return {
    columns: Math.max(1, toInteger(inventorySize.columns)),
    rows: Math.max(1, toInteger(inventorySize.rows))
  };
}

function getItemQuantity(itemOrSystem) {
  return getItemQuantityHelper(itemOrSystem);
}

function getItemMaxStack(itemOrSystem) {
  return getItemMaxStackHelper(itemOrSystem);
}

function getItemFootprint(itemOrSystem, items = null) {
  return getItemFootprintHelper(itemOrSystem, items);
}

async function promptItemStackQuantity({ item, title = "Количество", actionLabel = "Ок", max = 1, value = 1 } = {}) {
  const numericMax = Number(max);
  const hasLimit = Number.isFinite(numericMax) && numericMax > 0;
  const limit = hasLimit ? Math.max(1, toInteger(numericMax)) : null;
  const initial = hasLimit
    ? Math.max(1, Math.min(limit, toInteger(value) || limit))
    : Math.max(1, toInteger(value) || 1);
  const rangeLabel = hasLimit ? `1 / ${limit}` : "1+";
  const maxAttribute = hasLimit ? ` max="${limit}"` : "";
  const formData = await DialogV2.input({
    window: { title },
    content: `
      <p><strong>${escapeHTML(item?.name ?? "")}</strong></p>
      <label class="fallout-maw-stacked-field">
        <span>${game.i18n.localize("FALLOUTMAW.Item.Quantity")}: ${rangeLabel}</span>
        <input type="number" name="quantity" value="${initial}" min="1"${maxAttribute} step="1" autofocus>
      </label>
    `,
    ok: {
      label: actionLabel,
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
  const quantity = Math.max(1, toInteger(formData.quantity));
  return hasLimit ? Math.min(limit, quantity) : quantity;
}

function createInventoryPlacement(x = 1, y = 1, itemOrSystem = null, items = null) {
  return createInventoryPlacementHelper(x, y, itemOrSystem, items);
}

function normalizeInventoryPlacement(placement = {}, itemOrSystem = null, items = null) {
  return normalizeInventoryPlacementHelper(placement, itemOrSystem, items);
}

function placementContainsInventoryCell(placement, x, y) {
  return placementContainsInventoryCellHelper(placement, x, y);
}

function isInventoryPlacementAvailable(placement, items, columns, rows, allItems = items, excludeItemIds = [], reservedPlacements = [], options = {}) {
  return isInventoryPlacementAvailableHelper(placement, items, columns, rows, allItems, excludeItemIds, reservedPlacements, options);
}

function findFirstAvailableInventoryPlacement(items, columns, rows, itemOrSystem = null, allItems = items, excludeItemIds = [], reservedPlacements = [], options = {}) {
  return findFirstAvailableInventoryPlacementHelper(items, columns, rows, itemOrSystem, allItems, excludeItemIds, reservedPlacements, options);
}

function buildInventoryCellStyle(x, y, placement = null) {
  return buildInventoryCellStyleHelper(x, y, placement);
}

function setWeaponSlotImageAspect(image) {
  const width = Number(image?.naturalWidth);
  const height = Number(image?.naturalHeight);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
  const slot = image.closest(".fallout-maw-weapon-slot");
  if (!slot) return;
  slot.style.setProperty("--fallout-maw-weapon-slot-image-aspect", String(Math.max(1, width / height)));
}

function validateActorLoadLimit(actor, projectedItems = []) {
  if (actor?.system?.trade?.infiniteInventory) return { valid: true };
  const limit = getActorLoadLimit(actor);
  if (limit <= 0) return { valid: true };

  const currentLoad = Number(actor?.system?.load?.value) || calculateActorLoad(actor?.items?.contents ?? []);
  const projectedLoad = calculateActorLoad(projectedItems);
  if (projectedLoad <= (limit + 0.0001)) return { valid: true };
  if (projectedLoad <= (currentLoad + 0.0001)) return { valid: true };
  return { valid: false, reason: "actor-load-limit", value: projectedLoad, limit };
}

function getActorLoadLimit(actor) {
  if (actor?.system?.trade?.infiniteInventory) return 0;
  const max = Number(actor?.system?.load?.max) || 0;
  const percent = Math.max(0, Number(actor?.system?.load?.limitPercent) || 0);
  if (max > 0 && percent > 0) return (max * percent) / 100;
  return Number(actor?.system?.load?.limit) || 0;
}

function calculateActorLoad(items = []) {
  const itemList = Array.isArray(items) ? items : Array.from(items ?? []);
  return Number(itemList.reduce((total, item) => (
    isNaturalRaceItem(item) || getItemContainerParentId(item) || String(item.system?.placement?.mode ?? "") === ITEM_FUNCTIONS.constructPart
      ? total
      : total + (Number(getItemActorLoadWeight(item, itemList)) || 0)
  ), 0).toFixed(1));
}

const INVENTORY_BULK_DELETE_EQUIPPED_MODES = new Set(["equipment", "weapon", "prosthesis", "implant"]);

function getInventoryBulkDeleteItemIds(actor, { includeEquipped = false, equippedOnly = false } = {}) {
  return Array.from(actor?.items ?? [])
    .filter(item => isInventoryBulkDeleteItem(item, { includeEquipped, equippedOnly }))
    .map(item => item.id);
}

function isInventoryBulkDeleteItem(item, { includeEquipped = false, equippedOnly = false } = {}) {
  if (!item || item.type !== "gear" || isNaturalRaceItem(item)) return false;

  const placementMode = String(item.system?.placement?.mode ?? "inventory");
  if (placementMode === ITEM_FUNCTIONS.constructPart) return false;

  const equipped = Boolean(item.system?.equipped) || INVENTORY_BULK_DELETE_EQUIPPED_MODES.has(placementMode);
  if (equippedOnly) return equipped;
  if (equipped) return includeEquipped;
  return true;
}

function getActorLoadLimitExceededMessage() {
  const key = "FALLOUTMAW.Messages.ActorLoadLimitExceeded";
  const localized = game.i18n.localize(key);
  return localized === key ? "Актер не может нести такой вес." : localized;
}

function prepareInventoryContext(actor, race) {
  const currencies = getCurrencySettings();
  const { columns, rows } = getInventoryGridDimensions(race, actor);
  const allItems = actor.items.contents.filter(item => !["ability", "trauma", "disease"].includes(item.type) && !isNaturalRaceItem(item));
  const allItemData = allItems.map(item => createInventoryItemData(item, allItems, currencies));
  const naturalWeaponSet = getNaturalWeaponSetContext(actor, race, currencies);
  const assignedItemIds = new Set();
  const topLevelItems = allItemData.filter(item => !item.parentId);

  const equipmentSlots = (race?.equipmentSlots ?? []).map(slot => {
    const item = topLevelItems.find(candidate => (
      candidate.placement?.mode === "equipment"
      && doesItemOccupyEquipmentSlot(candidate, slot)
    ));
    if (item) assignedItemIds.add(item.id);
    return { ...slot, item };
  });

  const prosthesisSlots = Object.entries(actor.system?.limbs ?? {}).map(([key, limb]) => {
    const item = topLevelItems.find(candidate => (
      candidate.placement?.mode === "prosthesis"
      && candidate.placement?.limbKey === key
    ));
    if (item) assignedItemIds.add(item.id);
    return {
      key,
      label: limb?.label ?? key,
      item
    };
  });

  const weaponSets = (race?.weaponSets ?? []).map(set => ({
    ...set,
    slots: (set.slots ?? []).map(slot => {
      const limb = (race?.limbs ?? []).find(entry => entry.key === slot.limbKey);
      const item = topLevelItems.find(candidate => (
        candidate.placement?.mode === "weapon"
        && candidate.placement?.weaponSet === set.key
        && candidate.placement?.weaponSlot === slot.key
      ));
      if (item) assignedItemIds.add(item.id);
      return {
        ...slot,
        label: limb?.label || slot.limbKey || slot.key,
        item
      };
    })
  }));

  const inventoryItems = allItems.filter(item => (
    !assignedItemIds.has(item.id)
    && !getItemContainerParentId(item)
  ));
  const grid = prepareInventoryGridContext(inventoryItems, columns, rows, allItems, (item, placement) => ({
    ...createInventoryItemData(item, allItems, currencies, placement),
    gridStyle: buildInventoryCellStyle(placement.x, placement.y, placement)
  }), getActorRootInventoryGridOptions(actor, ROOT_CONTAINER_ID));
  const containers = topLevelItems
    .filter(item => item.isContainer && item.equipped)
    .map(item => {
      const containerDocument = actor.items.get(item.id);
      const gridOptions = getContainerInventoryGridOptions(containerDocument);
      const contents = getContextInventoryItems(item.id, allItems);
      const containerLoadValue = Math.max(0, Number(getContainerContentsWeight(containerDocument, allItems)) || 0);
      const containerLoadMax = Math.max(0, Number(getContainerMaxLoad(containerDocument)) || 0);
      const containerLoadRatio = containerLoadMax > 0 ? (containerLoadValue / containerLoadMax) : 0;
      return {
        ...item,
        grid: prepareInventoryGridContext(contents, gridOptions.columns, gridOptions.rows, allItems, (childItem, placement) => ({
          ...createInventoryItemData(childItem, allItems, currencies, placement),
          gridStyle: buildInventoryCellStyle(placement.x, placement.y, placement)
        }), gridOptions),
        load: {
          value: formatWeight(containerLoadValue),
          max: formatWeight(containerLoadMax),
          percent: Number(Math.max(0, Math.min(100, containerLoadRatio * 100)).toFixed(2)),
          trend: "negative",
          state: containerLoadRatio >= 1 ? "critical" : containerLoadRatio >= 0.75 ? "warning" : "normal"
        }
      };
    });

  return {
    equipmentSlots,
    prosthesisSlots,
    weaponSets,
    naturalWeaponSet,
    containers,
    grid
  };
}

function createInventoryItemData(item, allItems, currencies = [], placement = null) {
  const resolvedPlacement = placement ?? normalizeInventoryPlacement(item.system?.placement ?? {}, item, allItems);
  const container = item.system?.container ?? {};
  const firstAidCharges = getActiveItemChargesData(item);
  const showFirstAidCharges = (
    hasItemFunction(item, ITEM_FUNCTIONS.firstAid, { ignoreBroken: true })
    || hasItemFunction(item, ITEM_FUNCTIONS.needChange, { ignoreBroken: true })
  ) && firstAidCharges.max > 1;
  return {
    id: item.id,
    uuid: item.uuid,
    name: item.name,
    img: item.img,
    type: item.type,
    quantity: getItemQuantity(item),
    maxStack: getItemMaxStack(item),
    showQuantity: getItemMaxStack(item) > 1,
    firstAidCharges,
    showFirstAidCharges,
    weight: Number(item.system?.weight) || 0,
    totalWeight: Number(getItemTotalWeight(item, allItems).toFixed(1)),
    price: Number(item.system?.price) || 0,
    priceCurrency: item.system?.priceCurrency ?? "",
    priceCurrencyLabel: currencies.find(currency => currency.key === item.system?.priceCurrency)?.label ?? "",
    equipped: Boolean(item.system?.equipped),
    occupiedSlots: item.system?.occupiedSlots ?? {},
    itemFunction: item.system?.itemFunction ?? "",
    isContainer: isContainerItem(item),
    parentId: getItemContainerParentId(item),
    placement: resolvedPlacement,
    container: {
      parentId: String(container.parentId ?? ""),
      columns: Math.max(1, toInteger(container.columns) || 1),
      rows: Math.max(1, toInteger(container.rows) || 1),
      maxLoad: Math.max(0, Number(container.maxLoad) || 0)
    }
  };
}

function prepareAbilityEntries(actor, { characteristicSettings = [], skillSettings = [] } = {}) {
  const characteristicLabels = new Map(characteristicSettings.map(entry => [entry.key, entry.label]));
  const skillLabels = new Map(skillSettings.map(entry => [entry.key, entry.label]));
  return actor.items.filter(item => item.type === "ability").map(item => ({
    id: item.id,
    uuid: item.uuid,
    name: item.name,
    img: item.img,
    description: item.system?.description ?? "",
    cost: toInteger(item.system?.cost),
    effects: prepareAbilityEffectSummaries(item.system?.functions, characteristicLabels, skillLabels)
  }));
}

function prepareAbilityEffectSummaries(functions = [], characteristicLabels = new Map(), skillLabels = new Map()) {
  return (Array.isArray(functions) ? functions : []).map(entry => {
    const labelMap = entry?.type === "skillBonus" ? skillLabels : characteristicLabels;
    const targetLabel = labelMap.get(entry?.target) ?? entry?.target ?? "";
    const value = toInteger(entry?.value);
    const sign = value >= 0 ? "+" : "";
    const condition = entry?.condition?.enabled
      ? ` при ОЗ ${entry.condition.operator === "gte" ? ">=" : "<="} ${toInteger(entry.condition.percent)}%`
      : "";
    return `${targetLabel}: ${sign}${value}${condition}`;
  }).filter(Boolean);
}

function prepareTraumaEntries(actor, settings = {}) {
  const pathLabels = buildEffectPathLabelMap(settings);
  const skillLabels = new Map((settings.skillSettings ?? []).map(skill => [skill.key, skill.label]));
  const suppressedIds = getActorSuppressedTraumaDiseaseIds(actor).trauma;
  return getActorTraumas(actor).map(item => ({
    id: item.id,
    uuid: item.uuid,
    name: item.name,
    img: item.img,
    suppressed: suppressedIds.has(item.id),
    suppressedLabel: "Временно подавлена",
    limbLabel: item.system?.limbLabel ?? item.system?.limbKey ?? "",
    damageTypeLabel: item.system?.damageTypeLabel ?? item.system?.damageTypeKey ?? "",
    sources: prepareTraumaSourceEntries(item),
    thresholdPercent: toInteger(item.system?.thresholdPercent),
    healingDifficulty: toInteger(item.system?.healingDifficulty ?? 60),
    healingToolClass: String(item.system?.healingToolClass ?? "D").trim().toUpperCase() || "D",
    healingProgress: toInteger(item.system?.healingProgress),
    healingProgressMax: toInteger(item.system?.healingProgressMax ?? item.system?.healingProgress ?? 100),
    healingSkillLabel: skillLabels.get(item.system?.healingSkillKey) ?? item.system?.healingSkillKey ?? "doctor",
    effects: prepareTraumaEffectEntries(item.system?.effects, pathLabels)
  }));
}

function prepareDiseaseEntries(actor, diseaseSettings = {}, settings = {}) {
  const pathLabels = buildEffectPathLabelMap(settings);
  const skillLabels = new Map((settings.skillSettings ?? []).map(skill => [skill.key, skill.label]));
  const diseases = Array.isArray(diseaseSettings?.diseases) ? diseaseSettings.diseases : [];
  const suppressedIds = getActorSuppressedTraumaDiseaseIds(actor).disease;
  return actor.items.filter(item => item.type === "disease").map(item => {
    const diseaseProfile = diseases.find(entry => entry.id === item.system?.diseaseId);
    const stageProfile = diseaseProfile?.stages?.find(stage => stage.id === item.system?.stageId);
    const level = toInteger(item.system?.level);
    const worseningMultiplier = calculateDiseaseWorseningMultiplier(actor, item.system?.needKey);
    const stageName = stageProfile?.name || item.name || (level ? `Стадия ${level}` : "");
    return {
      id: item.id,
      uuid: item.uuid,
      name: diseaseProfile?.name || item.name,
      img: diseaseProfile?.img || item.img,
      suppressed: suppressedIds.has(item.id),
      suppressedLabel: "Временно подавлена",
      stageLabel: level ? `${stageName} (${level})` : stageName,
      worseningProgressLabel: formatProgress(item.system?.worseningProgress),
      worseningProgressMax: Math.max(1, toInteger(item.system?.worseningProgressMax) || 100),
      worseningMultiplierLabel: formatMultiplier(worseningMultiplier),
      worseningHoursLeftLabel: formatHours(calculateDiseaseHoursUntilWorsening(item, worseningMultiplier)),
      healingDifficulty: toInteger(item.system?.healingDifficulty ?? 60),
      healingToolClass: String(item.system?.healingToolClass ?? "D").trim().toUpperCase() || "D",
      healingProgress: toInteger(item.system?.healingProgress),
      healingProgressMax: toInteger(item.system?.healingProgressMax ?? item.system?.healingProgress ?? 100),
      healingSkillLabel: skillLabels.get(item.system?.healingSkillKey) ?? item.system?.healingSkillKey ?? "doctor",
      effects: prepareTraumaEffectEntries(item.system?.effects, pathLabels)
    };
  });
}

function prepareTraumaSourceEntries(item) {
  const sources = Array.isArray(item.system?.sources) && item.system.sources.length
    ? item.system.sources
    : [{
      limbLabel: item.system?.limbLabel ?? item.system?.limbKey ?? "",
      damageTypeLabel: item.system?.damageTypeLabel ?? item.system?.damageTypeKey ?? "",
      thresholdPercent: item.system?.thresholdPercent
    }];

  return sources.map(source => {
    const limbLabel = String(source.limbLabel ?? source.limbKey ?? "").trim();
    const damageTypeLabel = String(source.damageTypeLabel ?? source.damageTypeKey ?? "").trim();
    const thresholdPercent = toInteger(source.thresholdPercent);
    return {
      limbLabel,
      damageTypeLabel,
      thresholdPercent,
      summary: `${limbLabel} - ${damageTypeLabel}: ${thresholdPercent}%`
    };
  });
}

function prepareTraumaEffectEntries(effects = [], pathLabels = new Map()) {
  const effectList = Array.isArray(effects) ? effects : Object.values(effects ?? {});
  return effectList.map(effect => {
    const pathLabel = getEffectPathLabel(effect?.key, pathLabels);
    const type = String(effect?.type || "add");
    const value = formatEffectChangeValue(type, effect?.value);
    const typeLabel = getEffectTypeLabel(type);
    return {
      pathLabel,
      typeLabel,
      value,
      summary: `${pathLabel}: ${value}`,
      title: `${typeLabel}: ${pathLabel} ${value}`
    };
  });
}

function buildEffectPathLabelMap({
  characteristicSettings = [],
  resourceSettings = [],
  needSettings = [],
  proficiencySettings = [],
  skillSettings = [],
  damageTypeSettings = [],
  limbs = []
} = {}) {
  const map = new Map();
  const valueLabel = game.i18n.localize("FALLOUTMAW.Common.Value");
  const maximumLabel = game.i18n.localize("FALLOUTMAW.Common.Maximum");
  const bonusLabel = game.i18n.localize("FALLOUTMAW.Actor.Bonus");
  const baseLabel = game.i18n.localize("FALLOUTMAW.Actor.Base");
  const developmentBonusLabel = game.i18n.localize("FALLOUTMAW.Advancement.DevelopmentBonus");

  for (const entry of characteristicSettings) {
    map.set(`system.characteristics.${entry.key}`, entry.label);
  }

  map.set("system.load.max", game.i18n.localize("FALLOUTMAW.Common.Load"));
  map.set("system.load.bonus", game.i18n.localize("FALLOUTMAW.Common.Load"));
  map.set("system.inventory.columnsBonus", "Инвентарь: ширина");
  map.set("system.inventory.rowsBonus", "Инвентарь: высота");

  addEffectPathLabels(map, "system.skills", skillSettings, {
    value: valueLabel,
    max: maximumLabel,
    bonus: bonusLabel,
    advantage: "Преимущество",
    disadvantage: "Помеха",
    base: baseLabel,
    developmentBonus: developmentBonusLabel
  });
  map.set(ALL_SKILLS_BONUS_EFFECT_KEY, "Все навыки");
  map.set(ALL_SKILLS_ADVANTAGE_EFFECT_KEY, "Преимущество: все навыки");
  map.set(ALL_SKILLS_DISADVANTAGE_EFFECT_KEY, "Помеха: все навыки");
  map.set(ALL_COMBAT_ADVANTAGE_EFFECT_KEY, game.i18n.localize("FALLOUTMAW.Effects.CombatAllAdvantage"));
  map.set(ALL_COMBAT_DISADVANTAGE_EFFECT_KEY, game.i18n.localize("FALLOUTMAW.Effects.CombatAllDisadvantage"));
  map.set(ABILITY_OVERLOAD_ENERGY_COST_EFFECT_KEY, "Расход энергии на способность");
  for (const entry of resourceSettings) {
    const resourceKey = String(entry?.key ?? "").trim();
    if (!resourceKey || resourceKey === "power") continue;
    const resourceLabel = String(entry?.label ?? resourceKey).trim() || resourceKey;
    map.set(
      getAbilityOverloadCostEffectKey(resourceKey),
      `Расход ${resourceLabel.toLocaleLowerCase()} на способность`
    );
  }
  map.set(getAbilityOverloadCostEffectKey("reactionPoints"), "Расход очков реакции на способность");
  map.set(ONE_TIME_SKILL_MODIFIER_EFFECT_KEY, "Следующая проверка выбранного навыка");
  map.set(SMART_FUDGE_RESULT_EFFECT_KEYS.criticalSuccess, "Подтасовка: критический успех");
  map.set(SMART_FUDGE_RESULT_EFFECT_KEYS.success, "Подтасовка: успех");
  map.set(SMART_FUDGE_RESULT_EFFECT_KEYS.failure, "Подтасовка: провал");
  map.set(SMART_FUDGE_RESULT_EFFECT_KEYS.criticalFailure, "Подтасовка: критический провал");
  addEffectPathLabels(map, "system.resources", resourceSettings, {
    value: valueLabel,
    max: maximumLabel
  });
  addEffectPathLabels(map, "system.resources", resourceSettings.filter(entry => String(entry?.key ?? "").trim() !== "health"), {
    bonus: bonusLabel
  });
  map.set("system.resources.reactionPoints.value", `Очки реакции: ${valueLabel}`);
  map.set("system.resources.reactionPoints.max", `Очки реакции: ${maximumLabel}`);
  map.set("system.resources.reactionPoints.bonus", `Очки реакции: ${bonusLabel}`);
  addEffectPathLabels(map, "system.needs", needSettings, {
    value: valueLabel,
    max: maximumLabel,
    bonus: bonusLabel
  });
  addEffectPathLabels(map, "system.proficiencies", proficiencySettings, {
    value: valueLabel,
    max: maximumLabel,
    bonus: bonusLabel
  });
  addEffectPathLabels(map, "system.limbs", limbs, {
    value: valueLabel,
    max: maximumLabel,
    maxBonus: bonusLabel
  });
  const limbMaxBonusLabel = "Максимальное ОЗ частей тела";
  map.set(ALL_LIMB_MAX_BONUS_EFFECT_KEY, `${limbMaxBonusLabel}: Все части тела`);
  const implantLimitLabel = "Изменение доступных имплантов";
  map.set(ALL_LIMB_IMPLANT_LIMIT_EFFECT_KEY, `${implantLimitLabel}: Все части тела`);
  map.set("system.limbs.all.implantLimit", `${implantLimitLabel}: Все части тела`);
  for (const limb of limbs) {
    const limbKey = String(limb?.key ?? "").trim();
    if (!limbKey) continue;
    const limbLabel = String(limb?.label ?? limbKey).trim() || limbKey;
    map.set(`system.limbs.${limbKey}.maxBonus`, `${limbMaxBonusLabel}: ${limbLabel}`);
    map.set(`system.limbs.${limbKey}.implantLimitBonus`, `${implantLimitLabel}: ${limbLabel}`);
    map.set(`system.limbs.${limbKey}.implantLimit`, `${implantLimitLabel}: ${limbLabel}`);
  }
  map.set(
    ORGANISM_DEVELOPMENT_LIMIT_EFFECT_KEY,
    game.i18n.localize("FALLOUTMAW.Settings.CreatureOptions.OrganismDevelopmentLimit")
  );
  addDamageEffectPathLabels(map, "system.damageDefenseBonuses", localizeOrFallback("FALLOUTMAW.Effects.DamageDefenseBonuses", "Бонус защиты от урона"), limbs, damageTypeSettings);
  addDamageEffectPathLabels(map, "system.damageResistanceBonuses", localizeOrFallback("FALLOUTMAW.Effects.DamageResistanceBonuses", "Бонус сопротивлений урону"), limbs, damageTypeSettings);
  for (const token of buildCombatEffectKeyTokens()) {
    if (token?.path && token?.label) map.set(token.path, token.label);
  }
  map.set("system.healing.incomingPercent", "Входящее лечение, %");
  map.set("system.healing.outgoingPercent", "Исходящее лечение, %");
  map.set("system.costs.actions.aimedShot", `${game.i18n.localize("FALLOUTMAW.Item.WeaponActionAimedShot")}: стоимость`);
  map.set("system.costs.actions.snapshot", `${game.i18n.localize("FALLOUTMAW.Item.WeaponActionSnapshot")}: стоимость`);
  map.set("system.costs.actions.burst", `${game.i18n.localize("FALLOUTMAW.Item.WeaponActionBurst")}: стоимость`);
  map.set("system.costs.actions.volley", `${game.i18n.localize("FALLOUTMAW.Item.WeaponActionVolley")}: стоимость`);
  map.set("system.costs.actions.meleeAttack", `${game.i18n.localize("FALLOUTMAW.Item.WeaponActionMeleeAttack")}: стоимость`);
  map.set("system.costs.actions.aimedMeleeAttack", `${game.i18n.localize("FALLOUTMAW.Item.WeaponActionAimedMeleeAttack")}: стоимость`);
  map.set("system.costs.actions.push", `${game.i18n.localize("FALLOUTMAW.Item.WeaponActionPush")}: стоимость`);
  map.set("system.costs.actions.reload", `${game.i18n.localize("FALLOUTMAW.Item.WeaponActionReload")}: стоимость`);
  map.set(WEAPON_SWITCH_COST_KEY, "Смена оружия: стоимость");
  const firstAidHealingLabel = game.i18n.localize("FALLOUTMAW.Item.FirstAidHealingPerTick");
  map.set("fallout-maw.healing", firstAidHealingLabel);
  map.set("healing", firstAidHealingLabel);
  for (const token of buildReverseInteractionEffectKeyTokens()) map.set(token.path, token.label);

  return map;
}

function addEffectPathLabels(map, rootPath, entries = [], fields = {}) {
  for (const entry of entries) {
    const label = String(entry?.label ?? entry?.key ?? "");
    const key = String(entry?.key ?? "");
    if (!key) continue;
    for (const [field, fieldLabel] of Object.entries(fields)) {
      map.set(`${rootPath}.${key}.${field}`, `${label}: ${fieldLabel}`);
    }
  }
}

function addDamageEffectPathLabels(map, rootPath, rootLabel, limbs = [], damageTypes = []) {
  const allLabel = localizeOrFallback("FALLOUTMAW.Common.All", "Все");
  const allLimbsLabel = `${allLabel} ${localizeOrFallback("FALLOUTMAW.Common.Limbs", "части тела").toLocaleLowerCase()}`;
  const allDamageTypesLabel = `${allLabel} ${localizeOrFallback("FALLOUTMAW.Common.DamageTypes", "типы урона").toLocaleLowerCase()}`;
  map.set(`${rootPath}.all.all`, `${rootLabel}: ${allLimbsLabel}, ${allDamageTypesLabel}`);
  for (const damageType of damageTypes) {
    const damageTypeKey = String(damageType?.key ?? "");
    const damageTypeLabel = String(damageType?.label ?? damageTypeKey);
    if (!damageTypeKey) continue;
    map.set(`${rootPath}.all.${damageTypeKey}`, `${rootLabel}: ${allLimbsLabel}, ${damageTypeLabel}`);
  }

  for (const limb of limbs) {
    const limbKey = String(limb?.key ?? "");
    const limbLabel = String(limb?.label ?? limbKey);
    if (!limbKey) continue;
    map.set(`${rootPath}.${limbKey}.all`, `${rootLabel}: ${limbLabel}, ${allDamageTypesLabel}`);
    for (const damageType of damageTypes) {
      const damageTypeKey = String(damageType?.key ?? "");
      const damageTypeLabel = String(damageType?.label ?? damageTypeKey);
      if (!damageTypeKey) continue;
      map.set(`${rootPath}.${limbKey}.${damageTypeKey}`, `${rootLabel}: ${limbLabel}, ${damageTypeLabel}`);
    }
  }
}

function getEffectPathLabel(path, pathLabels = new Map()) {
  const normalized = String(path ?? "").trim();
  if (!normalized) return localizeOrFallback("FALLOUTMAW.Common.Untitled", "Untitled");
  if (pathLabels.has(normalized)) return pathLabels.get(normalized);
  const overloadResourceKey = getResourceKeyFromOverloadEffectKey(normalized);
  if (overloadResourceKey === "power") return "Расход энергии на способность";
  if (overloadResourceKey) {
    return `Расход ${overloadResourceKey} на способность`;
  }
  return humanizeEffectPath(normalized);
}

function humanizeEffectPath(path) {
  const parts = String(path ?? "")
    .replace(/^system\./, "")
    .split(".")
    .filter(Boolean)
    .map(part => part.replace(/([a-z])([A-Z])/g, "$1 $2"))
    .map(part => part.charAt(0).toUpperCase() + part.slice(1));
  return parts.join(" / ") || String(path ?? "");
}

function getEffectTypeLabel(type) {
  if (type === "multiply") return game.i18n.localize("FALLOUTMAW.Effects.ChangeMultiply");
  return game.i18n.localize(type === "override" ? "FALLOUTMAW.Effects.ChangeOverride" : "FALLOUTMAW.Effects.ChangeAdd");
}

function formatEffectChangeValue(type, value) {
  const text = String(value ?? "").trim() || "0";
  if (type === "override") return `= ${text}`;
  if (type === "multiply") return `x ${text}`;
  if (/^-/.test(text) || /^\+/.test(text)) return text;
  return `+${text}`;
}

function localizeOrFallback(key, fallback) {
  const localized = game.i18n.localize(key);
  return localized === key ? fallback : localized;
}

function syncActorTokenIdentity(actor, submitData = {}) {
  if (!actor) return;

  if (foundry.utils.hasProperty(submitData, "name")) {
    const name = String(foundry.utils.getProperty(submitData, "name") ?? "").trim();
    if (name) {
      const tokenNamePath = actor.isToken ? "token.name" : "prototypeToken.name";
      foundry.utils.setProperty(submitData, tokenNamePath, name);
    }
  }

  if (foundry.utils.hasProperty(submitData, "img")) {
    const img = String(foundry.utils.getProperty(submitData, "img") ?? "").trim();
    if (img) {
      const tokenImagePath = actor.isToken ? "token.texture.src" : "prototypeToken.texture.src";
      foundry.utils.setProperty(submitData, tokenImagePath, img);
    }
  }
}

function getActorConfiguredLimbSilhouette(actor, race = null) {
  return actor?.system?.limbSilhouetteOverride
    ? (actor.system?.limbSilhouette ?? null)
    : (race?.limbSilhouette ?? null);
}

function prepareSheetLimbSilhouette(silhouette, limbs = {}, activeLimbKey = "") {
  const prepared = createLimbSilhouetteHud(silhouette, limbs);
  if (!prepared?.visible) return prepared;
  return {
    ...prepared,
    parts: prepared.parts.map(part => ({
      ...part,
      active: part.limbKey === activeLimbKey
    }))
  };
}

function getActorEffectsForDisplay(actor) {
  if (typeof actor.allApplicableEffects === "function") return Array.from(actor.allApplicableEffects());
  return actor.effects.contents;
}

function getEffectFromTarget(actor, target) {
  const row = target.closest("[data-effect-id]");
  const effectId = row?.dataset.effectId ?? "";
  const parentItemId = row?.dataset.effectParentItemId ?? "";
  const itemEffect = parentItemId ? actor.items.get(parentItemId)?.effects.get(effectId) : null;
  if (itemEffect) return itemEffect;
  const uuid = row?.dataset.effectUuid ?? "";
  if (uuid && typeof globalThis.fromUuidSync === "function") return globalThis.fromUuidSync(uuid);
  return actor.effects.get(effectId);
}

function prepareEffectCategories(effects = [], actor = null) {
  const categories = [
    {
      key: "temporary",
      label: game.i18n.localize("FALLOUTMAW.Effects.KindTemporary"),
      effects: []
    },
    {
      key: "active",
      label: game.i18n.localize("FALLOUTMAW.Effects.KindActive"),
      effects: []
    },
    {
      key: "passive",
      label: game.i18n.localize("FALLOUTMAW.Effects.KindPassive"),
      effects: []
    },
    {
      key: "inactive",
      label: game.i18n.localize("FALLOUTMAW.Effects.KindInactive"),
      effects: []
    }
  ];
  const categoryMap = new Map(categories.map(category => [category.key, category]));

  for (const effect of effects) {
    effect.updateDuration?.();
    const kind = effect.disabled ? "inactive" : getEffectCategoryKey(effect);
    categoryMap.get(kind)?.effects.push({
      id: effect.id,
      uuid: effect.uuid,
      parentItemId: effect.parent?.documentName === "Item" ? effect.parent.id : "",
      name: effect.name,
      img: effect.img,
      disabled: effect.disabled,
      changes: effect.system?.changes?.length ?? effect.changes?.length ?? 0,
      duration: getEffectDurationLabel(effect),
      tooltipHTML: buildEffectTooltipHTML(effect, actor)
    });
  }

  return categories;
}

function prepareDevelopmentPointEntries(development = {}) {
  const points = development?.points ?? {};
  return [
    { key: "characteristics", label: "Очки характеристик" },
    { key: "signatureSkills", label: "Очки коронных" },
    { key: "skills", label: "Очки навыков" },
    { key: "researches", label: "Свободные ОИ" },
    { key: "traits", label: "Очки особенностей" },
    { key: "proficiencies", label: "Очки владений" }
  ].map(entry => ({
    ...entry,
    value: Math.max(0, toInteger(points?.[entry.key]))
  }));
}

function prepareLimbDisplayData(actor, limbKey, limb = {}) {
  const constructPart = getInstalledConstructPart(actor, limbKey);
  if (constructPart) {
    const hasCondition = hasItemFunction(constructPart, ITEM_FUNCTIONS.condition);
    const condition = hasCondition ? getConditionFunction(constructPart) : {};
    const conditionMax = Math.max(0, toInteger(condition.max));
    const conditionValue = Math.max(0, Math.min(conditionMax, toInteger(condition.value)));
    const ratio = hasCondition && conditionMax > 0 ? Math.max(0, Math.min(1, conditionValue / conditionMax)) : 1;
    const part = getConstructPartFunction(constructPart);
    const partType = String(part.partType ?? "").trim() || constructPart.name;
    return {
      ...limb,
      label: partType,
      value: hasCondition ? conditionValue : 1,
      max: hasCondition ? conditionMax : 1,
      min: 0,
      scaleMax: hasCondition ? conditionMax : 1,
      displayValue: hasCondition ? conditionValue : "∞",
      displayMax: hasCondition ? conditionMax : "",
      stateLabel: constructPart.name,
      fill: mixHexColor("#5a6f7a", "#d9eef5", ratio),
      popoverRows: [
        ["Деталь конструкта", partType],
        ["Предмет", constructPart.name],
        ["Состояние", hasCondition ? `${conditionValue} / ${conditionMax}` : "∞"]
      ]
    };
  }
  const prosthesis = getInstalledActorProsthesis(actor, limbKey);
  if (prosthesis) {
    const hasCondition = hasItemFunction(prosthesis, ITEM_FUNCTIONS.condition);
    const condition = hasCondition ? getConditionFunction(prosthesis) : {};
    const conditionMax = Math.max(0, toInteger(condition.max));
    const conditionValue = Math.max(0, toInteger(condition.value));
    const ratio = hasCondition && conditionMax > 0 ? Math.max(0, Math.min(1, conditionValue / conditionMax)) : 1;
    return {
      ...limb,
      value: hasCondition ? conditionValue : toInteger(limb?.max),
      max: hasCondition ? conditionMax : toInteger(limb?.max),
      min: 0,
      scaleMax: hasCondition ? conditionMax : toInteger(limb?.max),
      displayValue: hasCondition ? conditionValue : "∞",
      displayMax: hasCondition ? conditionMax : "",
      stateLabel: prosthesis.name,
      fill: mixHexColor("#16517a", "#8fd8ff", ratio),
      popoverRows: [
        ["Протез", prosthesis.name],
        ["Состояние", hasCondition ? `${conditionValue} / ${conditionMax}` : "∞"],
        ["Интеграция", `${Math.max(0, Math.min(100, toInteger(getProsthesisFunction(prosthesis).integrationPercent)))}%`]
      ]
    };
  }
  if (isLimbDestroyed(actor, limbKey)) {
    const stateLabel = getDestroyedLimbStateLabel(actor, limbKey);
    return {
      ...limb,
      displayValue: stateLabel,
      displayMax: "",
      stateLabel,
      fill: "rgba(6, 8, 8, 0.96)"
    };
  }
  const max = getLimbHealingCap(actor, limbKey);
  if (max >= toInteger(limb?.max)) return limb;
  const min = toInteger(limb?.min);
  const value = Math.min(Math.max(toInteger(limb?.value), min), max);
  return {
    ...limb,
    value,
    max,
    scaleMax: limb.max
  };
}

function normalizeFormulaText(value, fallback = "0") {
  return String(value ?? fallback).trim() || fallback;
}

function addFormulaTexts(left, right) {
  const leftText = normalizeFormulaText(left);
  const rightText = normalizeFormulaText(right);
  if (leftText === "0") return rightText;
  if (rightText === "0") return leftText;
  return `(${leftText}) + (${rightText})`;
}

function getInstalledActorProsthesis(actor, limbKey = "") {
  const key = String(limbKey ?? "").trim();
  if (!key) return null;
  return actor?.items?.find(item => (
    item.type === "gear"
    && item.system?.equipped
    && hasItemFunction(item, ITEM_FUNCTIONS.prosthesis)
    && String(item.system?.placement?.mode ?? "") === "prosthesis"
    && String(item.system?.placement?.limbKey ?? "") === key
  )) ?? null;
}

function getInstalledConstructPart(actor, limbKey = "") {
  return getInstalledConstructPartForLimb(actor, limbKey);
}

function getEffectCategoryKey(effect) {
  const kind = String(effect.getFlag("fallout-maw", "kind") || "");
  if (["temporary", "active", "passive"].includes(kind)) return kind;
  if (effect.isTemporary) return "temporary";
  return "active";
}

function getEffectDurationLabel(effect) {
  if (!effect.duration?.remaining) return "";
  return effect.duration.label ?? "";
}

function getInventoryGridItemElementAtPointer(event = null, root = null) {
  const direct = event?.target?.closest?.("[data-inventory-grid-item][data-item-id]");
  if (direct && (!root || root.contains(direct))) return direct;
  const clientX = Number(event?.clientX);
  const clientY = Number(event?.clientY);
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  const pointed = document.elementFromPoint(clientX, clientY)?.closest?.("[data-inventory-grid-item][data-item-id]") ?? null;
  return pointed && (!root || root.contains(pointed)) ? pointed : null;
}

function buildCreatureSubtypeOptions(races = [], selectedRaceId = "", selectedSubtypeId = "") {
  return races.flatMap(race => (race.naturalItemSets ?? []).map(set => ({
    id: set.id,
    raceId: race.id,
    label: set.label,
    selected: race.id === selectedRaceId && set.id === selectedSubtypeId
  })));
}
