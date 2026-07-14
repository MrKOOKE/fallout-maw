import { activateEffectKeyAutocomplete } from "../apps/effect-key-autocomplete.mjs";
import { activateDescriptionFormulaAutocomplete } from "../apps/description-formula-autocomplete.mjs";
import { activateFormulaAutocomplete } from "../apps/formula-autocomplete.mjs";
import { NeedAdvancedSettingsConfig } from "../apps/need-settings-config.mjs";
import { BLEEDING_DAMAGE_TYPE_KEY, SYSTEM_ID, TEMPLATES } from "../constants.mjs";
import { getCharacteristicSettings, getCoverSettings, getCreatureOptions, getCurrencySettings, getDamageTypeSettings, getItemCategorySettings, getNeedSettings, getProficiencySettings, getResourceSettings, getSkillSettings, getToolSettings } from "../settings/accessors.mjs";
import { getFactionNamesWithDefault, getFactionSettings } from "../settings/factions.mjs";
import { getEquipmentSlotSelectionKey, groupRaceEquipmentSlotsBySet, groupRaceWeaponSlotsBySet } from "../utils/equipment-slots.mjs";
import {
  buildDamageMitigationLimbSetChoices,
  buildDamageMitigationTables,
  getSelectedDamageMitigationLimbSetIds
} from "../utils/damage-mitigation-display.mjs";
import {
  DAMAGE_MITIGATION_MODES,
  ITEM_FUNCTIONS,
  WEAPON_SPECIAL_PROPERTIES,
  getDamageSourceFunction,
  getEnergySourceFunction,
  getEnabledToolFunctions,
  createDefaultWeaponSpecialPropertyData,
  getProsthesisFunction,
  getSelectedToolFunctionKey,
  getToolKeyFromFunctionKey,
  getWeaponSpecialPropertyType,
  normalizeWeaponSpecialProperties,
  normalizeWeaponAttackPowerData,
  hasItemFunction
} from "../utils/item-functions.mjs";
import { FALLBACK_ICON, normalizeImagePath } from "../utils/actor-display-data.mjs";
import {
  computeContainerSpecialGridBaseAnchorSeed,
  finalizeContainerSpecialGridBlock,
  getContainerDimensions,
  getContainerSpecialGridBaseAnchor,
  getContainerSpecialGridBlocks,
  hasPersistedContainerSpecialGridBaseAnchor
} from "../utils/inventory-containers.mjs";
import {
  ABILITY_FIXED_FUNCTION_KEYS,
  ABILITY_ACTIVE_APPLICATION_TARGET_MODES,
  ABILITY_AURA_MODES,
  ABILITY_AURA_TARGET_GROUPS,
  ABILITY_CHANGE_TYPES,
  ABILITY_CONDITION_TYPES,
  ABILITY_EQUIPMENT_OPERATORS,
  ABILITY_EVENT_REACTOR_ROLES,
  ABILITY_EVENT_SUBJECTS,
  ABILITY_FUNCTION_TYPES,
  ABILITY_HEALTH_LIMB_ALL,
  ABILITY_HEALTH_TARGETS,
  ABILITY_POSTURE_ACTIONS,
  ABILITY_POSTURE_SUBJECTS,
  createAbilityChange,
  createAbilityCondition,
  createAbilityFunction,
  normalizeActiveApplicationSettings,
  normalizeEventReactionSettings,
  normalizeAllOrNothingSettings,
  normalizeAimingSettings,
  normalizeAtRandomSettings,
  normalizeCommandBasicsSettings,
  normalizeCounterAttackSettings,
  normalizeOversightSettings,
  normalizeWatchOutSettings,
  normalizeCounterSniperSettings,
  normalizeCurseAndBlessingSettings,
  normalizeDeusExMachinaSettings,
  normalizeDefensiveTacticsSettings,
  normalizeDisarmSettings,
  normalizeDoubleAttackSettings,
  normalizeFullControlSettings,
  normalizeFullForceSettings,
  normalizeHeightenedConcentrationSettings,
  normalizeFourLeafCloverSettings,
  normalizeLastChanceSettings,
  normalizeLethalAttackSettings,
  normalizeKeepAwaySettings,
  normalizeKnockOffBalanceSettings,
  normalizeLookSettings,
  normalizeLungeSettings,
  normalizeLuckyCoinSettings,
  normalizeRageSettings,
  normalizeRicochetSettings,
  normalizeToTheEndSettings,
  normalizeTwoHandsSettings,
  normalizeWhirlwindSettings,
  normalizeWhereAreYouGoingSettings,
  normalizeReaperSettings,
  normalizeVirtuosoSettings,
  normalizeAbilityFunctions
} from "../settings/abilities.mjs";
import { isEventReactionFilterType } from "../events/event-reaction-schema.mjs";
import { REACTION_POINTS_RESOURCE_KEY } from "../events/reaction-costs.mjs";
import {
  SYSTEM_EVENT_GROUPS,
  SYSTEM_EVENT_PHASES,
  SYSTEM_EVENT_ROLES,
  getSelectableSystemEvents,
  getSystemEventDescriptor
} from "../events/catalog.mjs";
import {
  ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY,
  createFixedAbilityFunction,
  getFixedAbilityFunctionChoices,
  getFixedAbilityFunctionLabel
} from "../abilities/fixed-functions.mjs";
import { buildEffectKeyTokens } from "../utils/effect-key-tokens.mjs";
import { buildAbilityAcquisitionChangeKeyTokens } from "../utils/ability-acquisition-change-keys.mjs";
import { captureApplicationScrollPositions, restoreApplicationScrollPositions } from "../utils/application-scroll.mjs";
import { isFormulaTextConfigured } from "../utils/actor-formulas.mjs";
import { escapeHtml } from "../utils/dom.mjs";
import { toInteger } from "../utils/numbers.mjs";
import {
  buildDurationPartsContext,
  buildDurationUnitChoices,
  durationPartsToSeconds,
  splitDurationSeconds
} from "../utils/duration-parts.mjs";
import {
  getWeaponModuleSlots,
  getWeaponModuleSlotItemData,
  getWeaponModuleTechnicalName,
  isModuleItemCompatibleWithSlot,
  isWeaponModuleItem
} from "../utils/weapon-modules.mjs";
import { resolveWorldItemSync } from "../utils/world-items.mjs";
import { getDroppedWorldItems, mergeDroppedUuids } from "../utils/document-drop.mjs";
import {
  getCraftKnowledgeVariants,
  getCraftKnowledgeItemUuid,
  hasCraftKnowledgeData,
  resolveCraftKnowledgeItem
} from "../items/recipe-knowledge.mjs";
import {
  preserveTextSelectionBeforePartSync,
  restoreTextSelectionAfterPartSync
} from "../utils/application-focus-state.mjs";

const { ItemSheetV2 } = foundry.applications.sheets;
const { ApplicationV2, DialogV2, HandlebarsApplicationMixin } = foundry.applications.api;
const TextEditor = foundry.applications.ux.TextEditor.implementation;
const FormDataExtended = foundry.applications.ux.FormDataExtended;
const DEFAULT_WEAPON_ATTACK_CONE_DEGREES = 3;
const DEFAULT_WEAPON_ACTION_POINT_COST = 5;
const DEFAULT_WEAPON_PUSH_MAX_RANGE_METERS = 1;
const DEFAULT_RELOAD_ACTION_POINT_COST = 2;
const DEFAULT_ATTACK_ANIMATION_DELAY_MS = 200;
const DEFAULT_CONDITION_WEAKENING_THRESHOLD = 10;
const DEFAULT_LIGHT_SOURCE_ANGLE_DEGREES = 360;
const DEFAULT_LIGHT_SOURCE_COLOR = "";
const TRAP_DETECTION_LIGHTING_CONDITION = "lighting";
const DEFAULT_TRAP_LIGHTING_THRESHOLDS = Object.freeze([
  Object.freeze({ illuminationPercent: 80, difficultyBonus: 20 }),
  Object.freeze({ illuminationPercent: 60, difficultyBonus: 40 }),
  Object.freeze({ illuminationPercent: 40, difficultyBonus: 60 }),
  Object.freeze({ illuminationPercent: 20, difficultyBonus: 80 }),
  Object.freeze({ illuminationPercent: 0, difficultyBonus: 120 })
]);
const CRAFT_ROOT_NODE_ID = "root";
const CRAFT_GRID_FALLBACK_STEP = 56;
const CRAFT_DRAG_THRESHOLD_PX = 4;
const CRAFT_MIN_ZOOM = 0.45;
const CRAFT_MAX_ZOOM = 2.5;
const CRAFT_SOCKET_DEPTH_PX = 9;
const CRAFT_SOCKET_HALF_WIDTH_PX = 8;
const CRAFT_BLOCK_SEARCH_RADIUS = 24;
const CRAFT_MODE_CREATE = "craft";
const CRAFT_MODE_DISASSEMBLY = "disassembly";
const CRAFT_LEGACY_BEND_PIXEL_THRESHOLD = 80;
const DEFAULT_CRAFT_RECIPE_ID = "recipe1";
const DEFAULT_CRAFT_RECIPE_NAME = "Рецепт_1";
let itemSheetSourceSyncHooksRegistered = false;
let activeWeaponSoundPickerPreview = null;
const activeCraftModes = new WeakMap();
const activeCraftRecipeIds = new WeakMap();
const activeContainerSpecialGridApps = new WeakMap();

export class FalloutMaWItemSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
  #scrollPositions = new Map();
  #functionPickerActive = false;
  #fixedAbilityFunctionPickerActive = false;
  #mitigationFillDrag = null;
  #craftMode = CRAFT_MODE_CREATE;
  #craftRecipeId = DEFAULT_CRAFT_RECIPE_ID;
  #craftSelection = null;
  #craftAttachSourceNodeId = "";
  #activeWeaponFunctionTab = ITEM_FUNCTIONS.weapon;
  #craftPanDrag = null;
  #craftNodeDrag = null;
  #craftLinkDrag = null;
  #craftSocketDrag = null;
  #craftLinkRenderFrame = 0;
  #craftResizeObserver = null;
  #craftViewportOverride = null;

  static DEFAULT_OPTIONS = {
    classes: ["fallout-maw", "fallout-maw-sheet", "fallout-maw-item-sheet", "sheet", "item"],
    position: {
      width: 930,
      height: "auto"
    },
    form: {
      submitOnChange: true
    },
    window: {
      resizable: true
    }
  };

  static PARTS = {
    body: {
      template: TEMPLATES.itemSheet,
      scrollable: [".tab.active"]
    }
  };

  static TABS = {
    primary: {
      tabs: [
        { id: "details", group: "primary", label: "FALLOUTMAW.Item.DetailsTab" },
        { id: "functions", group: "primary", label: "FALLOUTMAW.Item.FunctionsTab" },
        { id: "craft", group: "primary", label: "FALLOUTMAW.Item.CraftTab" }
      ],
      initial: "details"
    }
  };

  get item() {
    return this.document;
  }

  _preSyncPartState(partId, newElement, priorElement, state) {
    super._preSyncPartState(partId, newElement, priorElement, state);
    preserveTextSelectionBeforePartSync(priorElement, state);
  }

  _syncPartState(partId, newElement, priorElement, state) {
    super._syncPartState(partId, newElement, priorElement, state);
    restoreTextSelectionAfterPartSync(newElement, state);
  }

  render(options = {}) {
    this.#captureScrollPositions();
    return super.render(options);
  }

  changeTab(tab, group, options) {
    const previousTab = this.tabGroups[group];
    super.changeTab(tab, group, options);
    if ((group !== "primary") || (previousTab === tab)) return;
    if (options?.updatePosition === false) return;
    this.#fitAutoHeightToContent();
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const item = this.item;
    const type = item.type;
    const priceCurrency = item.system?.priceCurrency ?? "";
    const currencySettings = getCurrencySettings();
    const itemCategory = item.system?.itemCategory ?? "";
    const occupiedSlots = item.system?.occupiedSlots ?? {};
    const occupiedSlotMode = item.system?.occupiedSlotMode ?? "all";
    const weaponSlotRequirement = item.system?.weaponSlotRequirement ?? {};
    const occupiedWeaponSlots = weaponSlotRequirement.slots ?? {};
    const creatureOptions = getCreatureOptions();
    const characteristicSettings = getCharacteristicSettings();
    const damageTypeSettings = getDamageTypeSettings();
    const toolSettings = getToolSettings();
    const skillSettings = getSkillSettings();
    const proficiencySettings = getProficiencySettings();
    const equipmentSlotGroups = groupRaceEquipmentSlotsBySet(creatureOptions);
    const weaponSlotGroups = groupRaceWeaponSlotsBySet(creatureOptions);
    const equipmentSlotSelections = new Map();
    const weaponSlotSelections = new Map();
    const sheetHasItemFunction = functionKey => hasItemFunction(item, functionKey, { ignoreBroken: true });
    const hasActorContainerFunction = sheetHasItemFunction(ITEM_FUNCTIONS.actorContainer);
    const hasContainerFunction = sheetHasItemFunction(ITEM_FUNCTIONS.container);
    const hasDamageMitigationFunction = sheetHasItemFunction(ITEM_FUNCTIONS.damageMitigation);
    const hasDamageSourceFunction = sheetHasItemFunction(ITEM_FUNCTIONS.damageSource);
    const hasEnergyConsumerFunction = sheetHasItemFunction(ITEM_FUNCTIONS.energyConsumer);
    const hasEnergySourceFunction = sheetHasItemFunction(ITEM_FUNCTIONS.energySource);
    const hasFreeSettingsFunction = sheetHasItemFunction(ITEM_FUNCTIONS.freeSettings);
    const hasImplantFunction = sheetHasItemFunction(ITEM_FUNCTIONS.implant);
    const hasModuleFunction = sheetHasItemFunction(ITEM_FUNCTIONS.module);
    const hasProsthesisFunction = sheetHasItemFunction(ITEM_FUNCTIONS.prosthesis);
    const hasConditionFunction = sheetHasItemFunction(ITEM_FUNCTIONS.condition);
    const hasConstructPartFunction = sheetHasItemFunction(ITEM_FUNCTIONS.constructPart);
    const hasFirstAidFunction = sheetHasItemFunction(ITEM_FUNCTIONS.firstAid);
    const hasLightSourceFunction = sheetHasItemFunction(ITEM_FUNCTIONS.lightSource);
    const hasNeedChangeFunction = sheetHasItemFunction(ITEM_FUNCTIONS.needChange);
    const hasOneTimeUseFunction = sheetHasItemFunction(ITEM_FUNCTIONS.oneTimeUse);
    const hasTrapFunction = sheetHasItemFunction(ITEM_FUNCTIONS.trap);
    const hasWeaponFunction = sheetHasItemFunction(ITEM_FUNCTIONS.weapon);
    const hasToolFunction = sheetHasItemFunction(ITEM_FUNCTIONS.tool);
    const containerLoadReduction = Math.max(0, Math.min(100, Number(item.system?.functions?.container?.loadReduction) || 0));
    const descriptionHTML = await TextEditor.enrichHTML(item.system?.description ?? "", {
      secrets: item.isOwner,
      relativeTo: item,
      rollData: item.getRollData?.() ?? {}
    });
    const toolFunctions = buildToolFunctionEntries(item, toolSettings, skillSettings);
    const availableFunctionChoices = [
      {
        value: "",
        label: game.i18n.localize("FALLOUTMAW.Item.FunctionChoose"),
        disabled: true,
        selected: true
      },
      {
        value: ITEM_FUNCTIONS.container,
        label: game.i18n.localize("FALLOUTMAW.Item.FunctionContainer"),
        disabled: hasContainerFunction
      },
      {
        value: ITEM_FUNCTIONS.actorContainer,
        label: "Контейнер актеров",
        disabled: hasActorContainerFunction
      },
      {
        value: ITEM_FUNCTIONS.damageMitigation,
        label: game.i18n.localize("FALLOUTMAW.Item.FunctionDamageMitigation"),
        disabled: hasDamageMitigationFunction
      },
      {
        value: ITEM_FUNCTIONS.damageSource,
        label: game.i18n.localize("FALLOUTMAW.Item.FunctionDamageSource"),
        disabled: hasDamageSourceFunction
      },
      {
        value: ITEM_FUNCTIONS.energySource,
        label: game.i18n.localize("FALLOUTMAW.Item.FunctionEnergySource"),
        disabled: hasEnergySourceFunction
      },
      {
        value: ITEM_FUNCTIONS.energyConsumer,
        label: game.i18n.localize("FALLOUTMAW.Item.FunctionEnergyConsumer"),
        disabled: hasEnergyConsumerFunction
      },
      {
        value: ITEM_FUNCTIONS.freeSettings,
        label: "Свободная настройка",
        disabled: hasFreeSettingsFunction
      },
      {
        value: ITEM_FUNCTIONS.condition,
        label: game.i18n.localize("FALLOUTMAW.Item.FunctionCondition"),
        disabled: hasConditionFunction
      },
      {
        value: ITEM_FUNCTIONS.constructPart,
        label: "Деталь конструкта",
        disabled: hasConstructPartFunction
      },
      {
        value: ITEM_FUNCTIONS.firstAid,
        label: game.i18n.localize("FALLOUTMAW.Item.FunctionFirstAid"),
        disabled: hasFirstAidFunction
      },
      {
        value: ITEM_FUNCTIONS.lightSource,
        label: game.i18n.localize("FALLOUTMAW.Item.FunctionLightSource"),
        disabled: hasLightSourceFunction
      },
      {
        value: ITEM_FUNCTIONS.needChange,
        label: "Изменение потребностей",
        disabled: hasNeedChangeFunction
      },
      {
        value: ITEM_FUNCTIONS.oneTimeUse,
        label: game.i18n.localize("FALLOUTMAW.Item.FunctionOneTimeUse"),
        disabled: hasOneTimeUseFunction
      },
      {
        value: ITEM_FUNCTIONS.trap,
        label: game.i18n.localize("FALLOUTMAW.Item.FunctionTrap"),
        disabled: hasTrapFunction
      },
      {
        value: ITEM_FUNCTIONS.weapon,
        label: game.i18n.localize("FALLOUTMAW.Item.FunctionWeapon"),
        disabled: hasWeaponFunction
      },
      {
        value: ITEM_FUNCTIONS.module,
        label: game.i18n.localize("FALLOUTMAW.Item.FunctionModule"),
        disabled: hasModuleFunction
      },
      {
        value: ITEM_FUNCTIONS.implant,
        label: game.i18n.localize("FALLOUTMAW.Item.FunctionImplant"),
        disabled: hasImplantFunction
      },
      {
        value: ITEM_FUNCTIONS.prosthesis,
        label: game.i18n.localize("FALLOUTMAW.Item.FunctionProsthesis"),
        disabled: hasProsthesisFunction
      },
      {
        value: ITEM_FUNCTIONS.tool,
        label: game.i18n.localize("FALLOUTMAW.Item.FunctionTool"),
        disabled: hasToolFunction || !toolSettings.length
      }
    ];
    const abilityFunctionChoices = [
      {
        value: "",
        label: "Выберите функцию",
        disabled: true,
        selected: true
      },
      {
        value: ABILITY_FUNCTION_TYPES.fixed,
        label: "Фиксированные функции"
      },
      {
        value: ABILITY_FUNCTION_TYPES.activeApplication,
        label: "Активное применение"
      },
      {
        value: ABILITY_FUNCTION_TYPES.effectChanges,
        label: "Свободная настройка"
      },
      {
        value: ABILITY_FUNCTION_TYPES.acquisitionChanges,
        label: "Разовое изменение при приобретении"
      }
    ];

    for (const group of equipmentSlotGroups) {
      for (const slot of group.slots) {
        if (!equipmentSlotSelections.has(slot.selectionKey)) {
          equipmentSlotSelections.set(slot.selectionKey, {
            selectionKey: slot.selectionKey,
            label: slot.label,
            selected: Boolean(occupiedSlots[slot.selectionKey])
          });
        }
      }
    }

    for (const group of weaponSlotGroups) {
      for (const slot of group.slots) {
        if (!weaponSlotSelections.has(slot.selectionKey)) {
          weaponSlotSelections.set(slot.selectionKey, {
            selectionKey: slot.selectionKey,
            label: slot.label,
            selected: Boolean(occupiedWeaponSlots[slot.selectionKey])
          });
        }
      }
    }

    const craftRecipes = getCraftRecipeEntries(item);
    this.#craftRecipeId = resolveCraftRecipeId(item, this.#craftRecipeId);
    activeCraftModes.set(item, this.#craftMode);
    activeCraftRecipeIds.set(item, this.#craftRecipeId);
    const craft = prepareCraftContext(item, skillSettings, this.#craftSelection, this.#craftAttachSourceNodeId, this.#craftMode);
    craft.recipes = craftRecipes.map(recipe => ({
      id: recipe.id,
      name: recipe.name,
      selected: recipe.id === this.#craftRecipeId,
      canDelete: recipe.id !== DEFAULT_CRAFT_RECIPE_ID
    }));
    craft.activeRecipeId = this.#craftRecipeId;
    craft.canDeleteActiveRecipe = this.#craftRecipeId !== DEFAULT_CRAFT_RECIPE_ID;
    const weaponFunctionSections = buildWeaponFunctionSections(
      item,
      damageTypeSettings,
      skillSettings,
      proficiencySettings,
      characteristicSettings,
      hasConditionFunction,
      hasEnergyConsumerFunction
    );
    this.#activeWeaponFunctionTab = resolveActiveWeaponFunctionTab(this.#activeWeaponFunctionTab, weaponFunctionSections);
    for (const section of weaponFunctionSections) section.active = section.tabId === this.#activeWeaponFunctionTab;

    return foundry.utils.mergeObject(context, {
      item,
      system: item.system,
      sourceSystem: item.system?._source ?? item.system,
      owner: item.isOwner,
      editable: this.isEditable,
      itemType: type,
      descriptionHTML,
      isGear: type === "gear",
      isTrauma: type === "trauma",
      isDisease: type === "disease",
      traumaHealingSkillLabel: getHealingSkillLabel(item),
      healingSkillLabel: getHealingSkillLabel(item),
      isContainerFunction: hasContainerFunction,
      hasActorContainerFunction,
      actorContainerSlotRows: buildActorContainerSlotRows(item),
      hasDamageMitigationFunction,
      hasDamageSourceFunction,
      hasEnergyConsumerFunction,
      hasEnergySourceFunction,
      hasFreeSettingsFunction,
      itemFreeSettingsFunctionPath: "system.functions.freeSettings.entries",
      itemFreeSettingsFunctions: normalizeAbilityFunctions(item.system?.functions?.freeSettings?.entries ?? [])
        .map((entry, index) => prepareAbilityFunctionRowsForDisplay(entry, index, "system.functions.freeSettings.entries")),
      hasImplantFunction,
      implantLimbRows: buildImplantLimbRows(item, creatureOptions),
      canAddImplantLimb: canAddImplantLimb(item, creatureOptions),
      implantSkillChoices: buildSkillChoices(item.system?.functions?.implant?.skillKey, skillSettings),
      hasModuleFunction,
      weaponModuleTargetChoices: buildWeaponModuleTargetChoices(item.system?.functions?.module?.targetFunction),
      hasProsthesisFunction,
      prosthesisLimbRows: buildProsthesisLimbRows(item, creatureOptions),
      canAddProsthesisLimb: canAddProsthesisLimb(item, creatureOptions),
      prosthesisBlockedEffectRows: buildProsthesisBlockedEffectRows(item, damageTypeSettings),
      canAddProsthesisBlockedEffect: canAddProsthesisBlockedEffect(item, damageTypeSettings),
      prosthesisSkillChoices: buildSkillChoices(item.system?.functions?.prosthesis?.skillKey, skillSettings),
      damageSourceDamageTypeRows: buildDamageSourceDamageTypeRows(item, damageTypeSettings),
      damageSourceVolleyRegionDamageRows: buildDamageSourceVolleyRegionDamageRows(item, damageTypeSettings),
      energyClassChoices: buildEnergyClassChoices(item.system?.functions?.energySource?.class),
      energyConsumerInstalledSource: getEnergyConsumerInstalledSourceRow(item.system?.functions?.energyConsumer),
      energyConsumerSourceItems: buildEnergyConsumerSourceItems(item.system?.functions?.energyConsumer),
      hasConditionFunction,
      hasConstructPartFunction,
      hasFirstAidFunction,
      hasLightSourceFunction,
      hasNeedChangeFunction,
      hasOneTimeUseFunction,
      hasTrapFunction,
      trapInstallationSkillChoices: buildSkillChoices(item.system?.functions?.trap?.installation?.skillKey ?? "traps", skillSettings),
      trapDetectionSkillChoices: buildSkillChoices(item.system?.functions?.trap?.detection?.skillKey ?? "naturalist", skillSettings),
      trapDetectionConditionRows: buildTrapDetectionConditionRows(item.system?.functions?.trap?.detection?.conditions),
      canAddTrapDetectionCondition: canAddTrapDetectionCondition(item.system?.functions?.trap?.detection?.conditions),
      trapActivationModeChoices: buildTrapActivationModeChoices(item.system?.functions?.trap?.trigger?.activationMode ?? "exit"),
      trapRechargeUnitChoices: buildTrapRechargeUnitChoices(item.system?.functions?.trap?.recharge?.unit ?? "seconds"),
      isTrapLinkedActionMode: item.system?.functions?.trap?.trigger?.activationMode === "linkedAction",
      trapEffectModeChoices: buildTrapEffectModeChoices(item.system?.functions?.trap?.effect?.mode ?? "explosion"),
      isTrapEffectAttackMode: item.system?.functions?.trap?.effect?.mode === "attack",
      isTrapEffectExplosionMode: item.system?.functions?.trap?.effect?.mode !== "attack",
      trapEvasionSkillChoices: buildSkillChoices(item.system?.functions?.trap?.evasion?.skillKey ?? "athletics", skillSettings),
      trapDisarmToolChoices: buildToolChoices(item.system?.functions?.trap?.disarm?.toolKey ?? "mechanicalHacking", toolSettings),
      trapDisarmClassChoices: buildToolClassChoices(item.system?.functions?.trap?.disarm?.toolClass ?? "D"),
      trapDamageTypeRows: buildWeaponDamageTypeRowsForData(item.system?.functions?.trap?.effect ?? {}, damageTypeSettings),
      trapRegionDamageRows: buildVolleyRegionDamageRowsForData(item.system?.functions?.trap?.effect?.regionDamageEntries, damageTypeSettings),
      lightSourceResourceCosts: buildLightSourceResourceCostRows(item, hasConditionFunction, hasEnergyConsumerFunction),
      firstAidEffectRows: buildFirstAidEffectRows(item),
      firstAidWithdrawalEffectRows: buildFirstAidWithdrawalEffectRows(item),
      firstAidNeedRows: buildFirstAidNeedRows(item),
      needChangeNeedRows: buildNeedChangeNeedRows(item),
      needChangeDamageRows: buildNeedChangeDamageRows(item, damageTypeSettings),
      needChangeOrganismDevelopmentRows: buildNeedChangeOrganismDevelopmentRows(item, characteristicSettings),
      needChangeEffectRows: buildFirstAidEffectRowsFromChanges(item.system?.functions?.needChange?.changes),
      needChangeDuration: buildDurationPartsContext(item.system?.functions?.needChange?.durationSeconds),
      oneTimeUseEffectRows: buildFirstAidEffectRowsFromChanges(item.system?.functions?.oneTimeUse?.changes),
      oneTimeUseRecipeItems: buildOneTimeUseRecipeItemRows(item.system?.functions?.oneTimeUse?.recipeItemUuids),
      firstAidRemoveEffectRows: buildFirstAidRemoveEffectRows(item, damageTypeSettings),
      firstAidDuration: buildDurationPartsContext(item.system?.functions?.firstAid?.durationSeconds),
      firstAidWithdrawalDuration: buildDurationPartsContext(item.system?.functions?.firstAid?.withdrawalDurationSeconds),
      conditionRecoveryMethodRows: buildConditionRecoveryMethodRows(item, toolSettings),
      constructPartBlockedEffectRows: buildConstructPartBlockedEffectRows(item, damageTypeSettings),
      canAddConstructPartBlockedEffect: canAddConstructPartBlockedEffect(item, damageTypeSettings),
      constructPartWeaponSetRows: buildConstructPartWeaponSetRows(item),
      constructPartLossEffectRows: buildConstructPartLossEffectRows(item),
      constructPartNeedRows: buildConstructPartNeedRows(item),
      hasWeaponFunction,
      hasWeaponMagazineCost: hasWeaponResourceCost(item, "magazine"),
      hasToolFunction,
      toolFunctions,
      weaponModuleChoices: buildWeaponModuleChoices(item),
      weaponFunctionSections,
      weaponFunctionTabs: buildWeaponFunctionTabs(weaponFunctionSections),
      canAddAdditionalWeaponFunction: hasWeaponFunction,
      weaponDamageTypeChoices: buildWeaponDamageTypeChoices(item, damageTypeSettings),
      weaponDamageTypeRows: buildWeaponDamageTypeRows(item, damageTypeSettings),
      weaponSkillChoices: buildWeaponSkillChoices(item, skillSettings),
      weaponResourceCosts: buildWeaponResourceCostRows(item, hasConditionFunction, hasEnergyConsumerFunction),
      weaponActionChoices: buildWeaponActionChoices(item, damageTypeSettings),
      containerLoadReduction,
      canAddItemFunction: availableFunctionChoices.some(choice => choice.value && !choice.disabled),
      showFunctionPicker: this.#functionPickerActive,
      isAbility: type === "ability",
      isAbilityOnlyFree: Boolean(item.system?.acquisition?.onlyFree),
      isAbilityOnlyManual: Boolean(item.system?.acquisition?.onlyManual),
      canAddAbilityFunction: true,
      showFixedAbilityFunctionPicker: this.#fixedAbilityFunctionPickerActive,
      fixedAbilityFunctionChoices: getFixedAbilityFunctionChoices(),
      abilityFunctionChoices,
      abilityResearchSkillChoices: skillSettings.map((skill, index) => ({
        key: skill.key,
        label: skill.label,
        selected: skill.key === item.system?.acquisition?.skillKey || (!item.system?.acquisition?.skillKey && index === 0)
      })),
      abilityFunctions: normalizeAbilityFunctions(item.system?.functions ?? [])
        .map((entry, index) => prepareAbilityFunctionRowsForDisplay(entry, index, "system.functions", item)),
      itemFunctionChoices: availableFunctionChoices,
      currencies: currencySettings.map(currency => ({
        ...currency,
        selected: currency.key === priceCurrency
      })),
      itemCategoryChoices: buildItemCategoryChoices(itemCategory),
      equipmentSlotSelections: Array.from(equipmentSlotSelections.values()),
      equipmentSlotGroups: equipmentSlotGroups.map(group => ({
        raceNames: group.races.join(", "),
        slots: group.slots.map(slot => ({
          ...slot,
          selected: Boolean(occupiedSlots[slot.selectionKey])
        }))
      })),
      occupiedSlotModeChoices: buildWeaponSlotRequirementModeChoices(occupiedSlotMode),
      weaponSlotRequirementModeChoices: buildWeaponSlotRequirementModeChoices(weaponSlotRequirement.mode),
      weaponSlotSelections: Array.from(weaponSlotSelections.values()),
      weaponSlotGroups: weaponSlotGroups.map(group => ({
        raceNames: group.races.join(", "),
        slots: group.slots.map(slot => ({
          ...slot,
          selected: Boolean(occupiedWeaponSlots[slot.selectionKey])
        }))
      })),
      damageMitigationModeChoices: buildDamageMitigationModeChoices(item),
      damageMitigationUsesConstructPart: hasConstructPartFunction,
      damageMitigationLimbSetChoices: buildDamageMitigationLimbSetChoices(item, creatureOptions),
      damageMitigationTables: buildDamageMitigationTables(item, creatureOptions, damageTypeSettings),
      craft,
      totalWeight: item.totalWeight
    }, { inplace: false });
  }

  async _processSubmitData(event, form, submitData, options = {}) {
    if (hasSubmittedStackShapeChange(this.item, submitData)) {
      options.falloutMawRepackStacks = true;
    }
    if (form?.querySelector?.("[data-implant-limb-key-list]")) {
      const limbKeys = Array.from(form.querySelectorAll("[data-implant-limb-key-list] select"))
        .map(input => String(input.value ?? "").trim())
        .filter(Boolean);
      foundry.utils.setProperty(submitData, "system.functions.implant.limbKeys", Array.from(new Set(limbKeys)));
    }
    if (form?.querySelector?.("[data-prosthesis-limb-key-list]")) {
      const limbKeys = Array.from(form.querySelectorAll("[data-prosthesis-limb-key-list] select"))
        .map(input => String(input.value ?? "").trim())
        .filter(Boolean);
      foundry.utils.setProperty(submitData, "system.functions.prosthesis.limbKeys", Array.from(new Set(limbKeys)));
    }
    if (form?.querySelector?.("[data-prosthesis-blocked-effect-list]")) {
      const blocked = Array.from(form.querySelectorAll("[data-prosthesis-blocked-effect-list] select"))
        .map(input => String(input.value ?? "").trim())
        .filter(Boolean);
      foundry.utils.setProperty(submitData, "system.functions.prosthesis.blockedPeriodicEffects", Array.from(new Set(blocked)));
    }
    if (form?.querySelector?.("[data-construct-part-blocked-effect-list]")) {
      const blocked = Array.from(form.querySelectorAll("[data-construct-part-blocked-effect-list] select"))
        .map(input => String(input.value ?? "").trim())
        .filter(Boolean);
      foundry.utils.setProperty(submitData, "system.functions.constructPart.blockedPeriodicEffects", Array.from(new Set(blocked)));
    }
    const constructPartCriticalInput = form?.querySelector?.("[data-construct-part-critical]");
    if (constructPartCriticalInput) {
      const critical = Boolean(constructPartCriticalInput.checked);
      foundry.utils.setProperty(submitData, "system.functions.constructPart.critical", critical);
      foundry.utils.setProperty(
        submitData,
        "system.functions.constructPart.lossEffects",
        critical
          ? []
          : readConstructPartLossEffectsFromForm(form)
      );
    }
    if (form?.querySelector?.("[data-construct-part-need-row]")) {
      foundry.utils.setProperty(
        submitData,
        "system.functions.constructPart.needs",
        readConstructPartNeedsFromForm(form, this.item.system?.functions?.constructPart?.needs)
      );
    }
    const freeSettingsConditionWeakeningInput = form?.querySelector?.("[data-free-settings-condition-weakening]");
    if (freeSettingsConditionWeakeningInput) {
      foundry.utils.setProperty(
        submitData,
        "system.functions.freeSettings.useConditionWeakening",
        Boolean(freeSettingsConditionWeakeningInput.checked)
      );
    } else if (form?.querySelector?.("[data-free-settings-panel]")) {
      foundry.utils.setProperty(submitData, "system.functions.freeSettings.useConditionWeakening", false);
    }
    const trapEvasionDifficultyInput = form?.querySelector?.("[data-trap-evasion-difficulty]");
    if (trapEvasionDifficultyInput && String(trapEvasionDifficultyInput.value ?? "").trim() === "") {
      foundry.utils.setProperty(submitData, "system.functions.trap.evasion.difficulty", null);
    }
    const trapRechargeValueInput = form?.querySelector?.("[data-trap-recharge-value]");
    if (trapRechargeValueInput && String(trapRechargeValueInput.value ?? "").trim() === "") {
      foundry.utils.setProperty(submitData, "system.functions.trap.recharge.value", null);
    }
    normalizeSubmittedAbilityItemUseConditions(form, submitData);
    normalizeSubmittedEventReactionFunctions(form, submitData);
    normalizeSubmittedActiveApplicationFunctions(form, submitData);
    normalizeSubmittedFixedAbilityFunctions(form, submitData);
    normalizeSubmittedFirstAidCheckboxes(form, submitData);
    normalizeSubmittedFirstAidDurations(form, submitData);
    normalizeSubmittedNeedChangeDurations(form, submitData);
    preserveNeedChangeChangesOnSubmit(form, submitData, this.item);
    return super._processSubmitData(event, form, submitData, options);
  }

  _processFormData(event, form, formData) {
    const submitData = super._processFormData(event, form, formData);
    normalizeWeaponSpecialPropertiesInSubmitData(submitData);
    normalizeSubmittedAbilityItemUseConditions(form, submitData);
    normalizeSubmittedEventReactionFunctions(form, submitData);
    normalizeSubmittedActiveApplicationFunctions(form, submitData);
    normalizeSubmittedFixedAbilityFunctions(form, submitData);
    normalizeSubmittedFirstAidCheckboxes(form, submitData);
    normalizeSubmittedFirstAidDurations(form, submitData);
    normalizeSubmittedNeedChangeDurations(form, submitData);
    preserveNeedChangeChangesOnSubmit(form, submitData, this.item);
    return submitData;
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#fitAutoHeightToContent();
    this.element?.querySelectorAll("[data-equipment-slot-choice]").forEach(button => {
      button.addEventListener("click", event => this.#onEquipmentSlotChoice(event));
    });
    this.element?.querySelectorAll("[data-weapon-slot-choice]").forEach(button => {
      button.addEventListener("click", event => this.#onWeaponSlotChoice(event));
    });
    this.element?.querySelectorAll("[data-weapon-action-choice]").forEach(button => {
      button.addEventListener("click", event => this.#onWeaponActionChoice(event));
    });
    this.element?.querySelectorAll("[data-add-weapon-damage-type]").forEach(button => {
      button.addEventListener("click", event => this.#onAddWeaponDamageType(event));
    });
    this.element?.querySelectorAll("[data-delete-weapon-damage-type]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteWeaponDamageType(event));
    });
    this.element?.querySelectorAll("[data-weapon-damage-percent]").forEach(input => {
      input.addEventListener("input", event => this.#onWeaponDamagePercentInput(event));
      input.addEventListener("change", event => this.#onWeaponDamagePercentChange(event));
    });
    this.element?.querySelectorAll("[data-add-damage-source-damage-type]").forEach(button => {
      button.addEventListener("click", event => this.#onAddDamageSourceDamageType(event));
    });
    this.element?.querySelectorAll("[data-delete-damage-source-damage-type]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteDamageSourceDamageType(event));
    });
    this.element?.querySelectorAll("[data-damage-source-percent]").forEach(input => {
      input.addEventListener("input", event => this.#onDamageSourcePercentInput(event));
      input.addEventListener("change", event => this.#onDamageSourcePercentChange(event));
    });
    this.element?.querySelectorAll("[data-add-damage-source-volley-region-damage]").forEach(button => {
      button.addEventListener("click", event => this.#onAddDamageSourceVolleyRegionDamage(event));
    });
    this.element?.querySelectorAll("[data-delete-damage-source-volley-region-damage]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteDamageSourceVolleyRegionDamage(event));
    });
    this.element?.querySelectorAll("[data-add-trap-damage-type]").forEach(button => {
      button.addEventListener("click", event => this.#onAddTrapDamageType(event));
    });
    this.element?.querySelectorAll("[data-delete-trap-damage-type]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteTrapDamageType(event));
    });
    this.element?.querySelectorAll("[data-trap-damage-percent]").forEach(input => {
      input.addEventListener("input", event => this.#onTrapDamagePercentInput(event));
      input.addEventListener("change", event => this.#onTrapDamagePercentChange(event));
    });
    this.element?.querySelectorAll("[data-add-trap-region-damage]").forEach(button => {
      button.addEventListener("click", event => this.#onAddTrapRegionDamage(event));
    });
    this.element?.querySelectorAll("[data-delete-trap-region-damage]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteTrapRegionDamage(event));
    });
    this.element?.querySelector("[data-add-trap-detection-condition]")?.addEventListener("click", event => this.#onAddTrapDetectionCondition(event));
    this.element?.querySelectorAll("[data-delete-trap-detection-condition]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteTrapDetectionCondition(event));
    });
    this.element?.querySelectorAll("[data-trap-detection-condition-type]").forEach(select => {
      select.addEventListener("change", event => this.#onTrapDetectionConditionTypeChange(event));
    });
    this.element?.querySelectorAll("[data-add-trap-lighting-threshold]").forEach(button => {
      button.addEventListener("click", event => this.#onAddTrapLightingThreshold(event));
    });
    this.element?.querySelectorAll("[data-delete-trap-lighting-threshold]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteTrapLightingThreshold(event));
    });
    this.element?.querySelectorAll("[data-trap-effect-mode]").forEach(select => {
      select.addEventListener("change", event => this.#onTrapEffectModeChange(event));
    });
    this.element?.querySelectorAll("[data-weapon-damage-mode]").forEach(select => {
      select.addEventListener("change", event => this.#onWeaponDamageModeChange(event));
    });
    this.element?.querySelectorAll("[data-weapon-magazine-source-drop]").forEach(zone => {
      zone.addEventListener("dragover", event => this.#onWeaponMagazineSourceDragOver(event));
      zone.addEventListener("drop", event => this.#onWeaponMagazineSourceDrop(event));
    });
    this.element?.querySelectorAll("[data-select-weapon-magazine-source]").forEach(source => {
      source.addEventListener("click", event => this.#onSelectWeaponMagazineSource(event));
    });
    this.element?.querySelectorAll("[data-delete-weapon-magazine-source]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteWeaponMagazineSource(event));
    });
    this.element?.querySelectorAll("[data-energy-consumer-source-drop]").forEach(zone => {
      zone.addEventListener("dragover", event => this.#onEnergyConsumerSourceDragOver(event));
      zone.addEventListener("drop", event => this.#onEnergyConsumerSourceDrop(event));
    });
    this.element?.querySelectorAll("[data-select-energy-consumer-source]").forEach(source => {
      source.addEventListener("click", event => this.#onSelectEnergyConsumerSource(event));
    });
    this.element?.querySelectorAll("[data-delete-energy-consumer-source]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteEnergyConsumerSource(event));
    });
    this.element?.querySelector("[data-add-light-source-resource-cost]")?.addEventListener("click", event => this.#onAddLightSourceResourceCost(event));
    this.element?.querySelectorAll("[data-delete-light-source-resource-cost]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteLightSourceResourceCost(event));
    });
    this.element?.querySelectorAll("[data-add-volley-region-damage]").forEach(button => {
      button.addEventListener("click", event => this.#onAddVolleyRegionDamage(event));
    });
    this.element?.querySelectorAll("[data-delete-volley-region-damage]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteVolleyRegionDamage(event));
    });
    this.element?.querySelectorAll("[data-weapon-attack-mode-enabled]").forEach(input => {
      input.addEventListener("change", event => this.#onWeaponAttackModeEnabledChange(event));
    });
    this.element?.querySelectorAll("[data-browse-weapon-attack-sound]").forEach(button => {
      button.addEventListener("click", event => this.#onBrowseWeaponAttackSound(event));
    });
    this.element?.querySelectorAll("[data-browse-weapon-explosion-sound]").forEach(button => {
      button.addEventListener("click", event => this.#onBrowseWeaponExplosionSound(event));
    });
    this.element?.querySelector("[data-browse-trap-trigger-sound]")?.addEventListener("click", event => this.#onBrowseTrapTriggerSound(event));
    this.element?.querySelector("[data-add-item-function]")?.addEventListener("click", event => this.#onAddItemFunction(event));
    this.element?.querySelector("[data-add-prosthesis-limb]")?.addEventListener("click", event => this.#onAddProsthesisLimb(event));
    this.element?.querySelectorAll("[data-delete-prosthesis-limb]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteProsthesisLimb(event));
    });
    this.element?.querySelector("[data-add-implant-limb]")?.addEventListener("click", event => this.#onAddImplantLimb(event));
    this.element?.querySelectorAll("[data-delete-implant-limb]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteImplantLimb(event));
    });
    this.element?.querySelector("[data-add-prosthesis-blocked-effect]")?.addEventListener("click", event => this.#onAddProsthesisBlockedEffect(event));
    this.element?.querySelectorAll("[data-delete-prosthesis-blocked-effect]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteProsthesisBlockedEffect(event));
    });
    this.element?.querySelector("[data-add-construct-part-blocked-effect]")?.addEventListener("click", event => this.#onAddConstructPartBlockedEffect(event));
    this.element?.querySelectorAll("[data-delete-construct-part-blocked-effect]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteConstructPartBlockedEffect(event));
    });
    this.element?.querySelector("[data-add-construct-part-weapon-set]")?.addEventListener("click", event => this.#onAddConstructPartWeaponSet(event));
    this.element?.querySelectorAll("[data-delete-construct-part-weapon-set]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteConstructPartWeaponSet(event));
    });
    this.element?.querySelector("[data-add-construct-part-loss-effect]")?.addEventListener("click", event => this.#onAddConstructPartLossEffect(event));
    this.element?.querySelectorAll("[data-delete-construct-part-loss-effect]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteConstructPartLossEffect(event));
    });
    this.element?.querySelector("[data-add-construct-part-need]")?.addEventListener("click", event => this.#onAddConstructPartNeed(event));
    this.element?.querySelectorAll("[data-delete-construct-part-need]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteConstructPartNeed(event));
    });
    this.element?.querySelectorAll("[data-open-construct-part-need-settings]").forEach(button => {
      button.addEventListener("click", event => this.#onOpenConstructPartNeedSettings(event));
    });
    this.element?.querySelector("[data-construct-part-critical]")?.addEventListener("change", event => this.#onConstructPartCriticalChange(event));
    this.element?.querySelectorAll("[data-add-ability-function]").forEach(button => {
      button.addEventListener("click", event => this.#onAddAbilityFunction(event));
    });
    this.element?.querySelector("[data-add-additional-weapon-function]")?.addEventListener("click", event => this.#onAddAdditionalWeaponFunction(event));
    this.element?.querySelector("[data-add-module-weapon-function]")?.addEventListener("click", event => this.#onAddModuleWeaponFunction(event));
    this.element?.querySelectorAll("[data-delete-additional-weapon-function]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteAdditionalWeaponFunction(event));
    });
    this.element?.querySelectorAll("[data-delete-module-weapon-function]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteModuleWeaponFunction(event));
    });
    this.element?.querySelectorAll("[data-select-weapon-function-tab]").forEach(button => {
      button.addEventListener("click", event => this.#onSelectWeaponFunctionTab(event));
    });
    this.element?.querySelector("[data-choose-item-function]")?.addEventListener("change", event => this.#onChooseItemFunction(event));
    this.element?.querySelector("[data-choose-ability-function]")?.addEventListener("change", event => this.#onChooseAbilityFunction(event));
    this.element?.querySelector("[data-choose-fixed-ability-function]")?.addEventListener("change", event => this.#onChooseFixedAbilityFunction(event));
    this.element?.querySelector("[data-fixed-ability-function-search]")?.addEventListener("input", event => this.#onFixedAbilityFunctionSearch(event));
    this.element?.querySelectorAll("[data-fixed-rescue-mode]").forEach(select => {
      select.addEventListener("change", () => syncFixedRescueCountVisibility(select));
      syncFixedRescueCountVisibility(select);
    });
    this.element?.querySelectorAll("[data-add-fixed-to-the-end-advantage-skill]").forEach(button => {
      button.addEventListener("click", event => this.#onAddToTheEndAdvantageSkill(event));
    });
    this.element?.querySelectorAll("[data-delete-fixed-to-the-end-advantage-skill]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteToTheEndAdvantageSkill(event));
    });
    this.element?.querySelectorAll("[data-delete-ability-function]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteAbilityFunction(event));
    });
    this.element?.querySelectorAll("[data-add-ability-change]").forEach(button => {
      button.addEventListener("click", event => this.#onAddAbilityChange(event));
    });
    this.element?.querySelectorAll("[data-delete-ability-change]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteAbilityChange(event));
    });
    this.element?.querySelectorAll("[data-add-ability-condition]").forEach(button => {
      button.addEventListener("click", event => this.#onAddAbilityCondition(event));
    });
    this.element?.querySelectorAll("[data-add-ability-condition-alternative]").forEach(button => {
      button.addEventListener("click", event => this.#onAddAbilityConditionAlternative(event));
    });
    this.element?.querySelectorAll("[data-delete-ability-condition]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteAbilityCondition(event));
    });
    this.element?.querySelectorAll("[data-add-ability-reaction-cost]").forEach(button => {
      button.addEventListener("click", event => this.#onAddAbilityReactionCost(event));
    });
    this.element?.querySelectorAll("[data-delete-ability-reaction-cost]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteAbilityReactionCost(event));
    });
    this.element?.querySelectorAll("[data-add-ability-item-use-category]").forEach(button => {
      button.addEventListener("click", event => this.#onAddAbilityItemUseCategory(event));
    });
    this.element?.querySelectorAll("[data-delete-ability-item-use-category]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteAbilityItemUseCategory(event));
    });
    this.element?.querySelectorAll("select[data-ability-item-use-category]").forEach(select => {
      select.addEventListener("change", event => this.#onAbilityItemUseCategoryChange(event));
    });
    this.element?.querySelectorAll("[data-add-ability-target-faction]").forEach(button => {
      button.addEventListener("click", event => this.#onAddAbilityTargetFaction(event));
    });
    this.element?.querySelectorAll("[data-delete-ability-target-faction]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteAbilityTargetFaction(event));
    });
    this.element?.querySelectorAll("[data-add-ability-posture]").forEach(button => {
      button.addEventListener("click", event => this.#onAddAbilityPosture(event));
    });
    this.element?.querySelectorAll("[data-delete-ability-posture]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteAbilityPosture(event));
    });
    this.element?.querySelectorAll("[data-add-ability-cover]").forEach(button => {
      button.addEventListener("click", event => this.#onAddAbilityCover(event));
    });
    this.element?.querySelectorAll("[data-delete-ability-cover]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteAbilityCover(event));
    });
    this.element?.querySelectorAll("[data-add-ability-weapon-action]").forEach(button => {
      button.addEventListener("click", event => this.#onAddAbilityWeaponAction(event));
    });
    this.element?.querySelectorAll("[data-delete-ability-weapon-action]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteAbilityWeaponAction(event));
    });
    this.element?.querySelectorAll("[data-add-ability-weapon-skill]").forEach(button => {
      button.addEventListener("click", event => this.#onAddAbilityWeaponSkill(event));
    });
    this.element?.querySelectorAll("[data-delete-ability-weapon-skill]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteAbilityWeaponSkill(event));
    });
    this.element?.querySelectorAll("[data-add-ability-weapon-proficiency]").forEach(button => {
      button.addEventListener("click", event => this.#onAddAbilityWeaponProficiency(event));
    });
    this.element?.querySelectorAll("[data-delete-ability-weapon-proficiency]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteAbilityWeaponProficiency(event));
    });
    this.element?.querySelectorAll("[data-add-ability-aura-target-group]").forEach(button => {
      button.addEventListener("click", event => this.#onAddAbilityAuraTargetGroup(event));
    });
    this.element?.querySelectorAll("[data-delete-ability-aura-target-group]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteAbilityAuraTargetGroup(event));
    });
    this.element?.querySelectorAll("[data-ability-aura-mode]").forEach(select => {
      select.addEventListener("change", event => this.#onAbilityAuraModeChange(event));
    });
    this.element?.querySelectorAll("[data-add-ability-penalty]").forEach(button => {
      button.addEventListener("click", event => this.#onAddAbilityPenalty(event));
    });
    this.element?.querySelectorAll("[data-delete-ability-penalty]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteAbilityPenalty(event));
    });
    this.element?.querySelectorAll("[data-ability-condition-type]").forEach(select => {
      select.addEventListener("change", event => this.#onAbilityConditionTypeChange(event));
    });
    this.element?.querySelectorAll("[data-ability-condition-health-target]").forEach(select => {
      select.addEventListener("change", event => this.#onAbilityConditionTypeChange(event));
    });
    this.element?.querySelector("[data-ability-only-free]")?.addEventListener("change", event => this.#onAbilityOnlyFreeChange(event));
    this.element?.querySelector("[data-ability-only-manual]")?.addEventListener("change", event => this.#onAbilityOnlyManualChange(event));
    this.element?.querySelectorAll("[data-container-load-reduction]").forEach(input => {
      input.addEventListener("input", event => this.#onContainerLoadReductionInput(event));
      input.addEventListener("change", event => this.#onContainerLoadReductionChange(event));
    });
    this.element?.querySelector("[data-open-container-special-grids]")?.addEventListener("click", event => this.#onOpenContainerSpecialGrids(event));
    this.element?.querySelector("[data-add-actor-container-slot]")?.addEventListener("click", event => this.#onAddActorContainerSlot(event));
    this.element?.querySelectorAll("[data-delete-actor-container-slot]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteActorContainerSlot(event));
    });
    this.element?.querySelectorAll("[data-remove-item-function]").forEach(button => {
      button.addEventListener("click", event => this.#onRemoveItemFunction(event));
    });
    this.element?.querySelectorAll("[data-add-weapon-resource-cost]").forEach(button => {
      button.addEventListener("click", event => this.#onAddWeaponResourceCost(event));
    });
    this.element?.querySelectorAll("[data-delete-weapon-resource-cost]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteWeaponResourceCost(event));
    });
    this.element?.querySelectorAll("[data-add-weapon-module-slot]").forEach(button => {
      button.addEventListener("click", event => this.#onAddWeaponModuleSlot(event));
    });
    this.element?.querySelectorAll("[data-weapon-module-slot-key-select]").forEach(select => {
      select.addEventListener("change", event => this.#onWeaponModuleSlotKeyChange(event));
    });
    this.element?.querySelectorAll("[data-delete-weapon-module-slot]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteWeaponModuleSlot(event));
    });
    this.element?.querySelectorAll("[data-weapon-module-slot-drop]").forEach(zone => {
      zone.addEventListener("dragover", event => this.#onWeaponModuleSlotDragOver(event));
      zone.addEventListener("drop", event => this.#onWeaponModuleSlotDrop(event));
    });
    this.element?.querySelector("[data-add-condition-recovery-method]")?.addEventListener("click", event => this.#onAddConditionRecoveryMethod(event));
    this.element?.querySelectorAll("[data-delete-condition-recovery-method]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteConditionRecoveryMethod(event));
    });
    this.element?.querySelector("[data-add-first-aid-effect]")?.addEventListener("click", event => this.#onAddFirstAidEffect(event));
    this.element?.querySelectorAll("[data-delete-first-aid-effect]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteFirstAidEffect(event));
    });
    this.element?.querySelector("[data-add-first-aid-withdrawal-effect]")?.addEventListener("click", event => this.#onAddFirstAidWithdrawalEffect(event));
    this.element?.querySelectorAll("[data-delete-first-aid-withdrawal-effect]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteFirstAidWithdrawalEffect(event));
    });
    this.element?.querySelector("[data-add-first-aid-need]")?.addEventListener("click", event => this.#onAddFirstAidNeed(event));
    this.element?.querySelectorAll("[data-delete-first-aid-need]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteFirstAidNeed(event));
    });
    this.element?.querySelector("[data-add-need-change-need]")?.addEventListener("click", event => this.#onAddNeedChangeNeed(event));
    this.element?.querySelectorAll("[data-delete-need-change-need]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteNeedChangeNeed(event));
    });
    this.element?.querySelector("[data-add-need-change-damage]")?.addEventListener("click", event => this.#onAddNeedChangeDamage(event));
    this.element?.querySelectorAll("[data-delete-need-change-damage]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteNeedChangeDamage(event));
    });
    this.element?.querySelector("[data-add-need-change-organism-development]")?.addEventListener("click", event => this.#onAddNeedChangeOrganismDevelopment(event));
    this.element?.querySelectorAll("[data-delete-need-change-organism-development]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteNeedChangeOrganismDevelopment(event));
    });
    this.element?.querySelector("[data-add-need-change-effect]")?.addEventListener("click", event => this.#onAddNeedChangeEffect(event));
    this.element?.querySelectorAll("[data-delete-need-change-effect]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteNeedChangeEffect(event));
    });
    this.element?.querySelector("[data-add-one-time-use-effect]")?.addEventListener("click", event => this.#onAddOneTimeUseEffect(event));
    this.element?.querySelectorAll("[data-delete-one-time-use-effect]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteOneTimeUseEffect(event));
    });
    this.element?.querySelectorAll("[data-one-time-use-recipe-drop]").forEach(zone => {
      zone.addEventListener("dragover", event => this.#onOneTimeUseRecipeDragOver(event));
      zone.addEventListener("drop", event => this.#onOneTimeUseRecipeDrop(event));
    });
    this.element?.querySelectorAll("[data-delete-one-time-use-recipe]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteOneTimeUseRecipe(event));
    });
    this.element?.querySelectorAll("[data-need-change-charge-input]").forEach(input => {
      input.addEventListener("change", event => this.#onNeedChangeChargeInputChange(event));
    });
    this.element?.querySelector("[data-add-first-aid-remove-effect]")?.addEventListener("click", event => this.#onAddFirstAidRemoveEffect(event));
    this.element?.querySelectorAll("[data-delete-first-aid-remove-effect]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteFirstAidRemoveEffect(event));
    });
    this.element?.querySelectorAll("[data-first-aid-charge-input]").forEach(input => {
      input.addEventListener("change", event => this.#onFirstAidChargeInputChange(event));
    });
    this.element?.querySelector("[data-tool-function-key]")?.addEventListener("change", event => this.#onToolFunctionKeyChange(event));
    activateItemEffectKeyAutocompletes(this.element);
    activateFormulaAutocomplete(this.element, {
      characteristics: getCharacteristicSettings(),
      skills: getSkillSettings()
    });
    activateDescriptionFormulaAutocomplete(this.element);
    this.element?.querySelectorAll("[data-add-weapon-special-property]").forEach(button => {
      button.addEventListener("click", event => this.#onAddWeaponSpecialProperty(event));
    });
    this.element?.querySelectorAll("[data-weapon-special-property-type]").forEach(select => {
      select.addEventListener("change", event => this.#onWeaponSpecialPropertyTypeChange(event));
    });
    this.element?.querySelectorAll("[data-delete-weapon-special-property]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteWeaponSpecialProperty(event));
    });
    this.element?.querySelectorAll("[data-add-weapon-requirement]").forEach(button => {
      button.addEventListener("click", event => this.#onAddWeaponRequirement(event));
    });
    this.element?.querySelectorAll("[data-delete-weapon-requirement]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteWeaponRequirement(event));
    });
    this.element?.querySelectorAll("[data-weapon-requirement-type]").forEach(select => {
      select.addEventListener("change", event => this.#onWeaponRequirementTypeChange(event));
    });
    this.element?.querySelectorAll("[data-add-weapon-critical-failure-consequence]").forEach(button => {
      button.addEventListener("click", event => this.#onAddWeaponCriticalFailureConsequence(event));
    });
    this.element?.querySelectorAll("[data-delete-weapon-critical-failure-consequence]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteWeaponCriticalFailureConsequence(event));
    });
    this.element?.querySelectorAll("[data-mitigation-fill-handle]").forEach(handle => {
      handle.addEventListener("pointerdown", event => this.#onMitigationFillStart(event));
    });
    this.element?.querySelectorAll("[data-mitigation-limb-set-choice]").forEach(button => {
      button.addEventListener("click", event => this.#onMitigationLimbSetChoice(event));
    });
    this.#activateCraftEditor();
    this.#restoreScrollPositions();
  }

  #fitAutoHeightToContent() {
    if (this.options.position.height !== "auto") return;
    this.setPosition({ height: "auto" });
  }

  #captureScrollPositions() {
    this.#scrollPositions = captureApplicationScrollPositions(this.element, [
      ".window-content",
      ".fallout-maw-sheet-body > .tab.active"
    ]);
  }

  #restoreScrollPositions() {
    restoreApplicationScrollPositions(this.element, this.#scrollPositions, [
      ".window-content",
      ".fallout-maw-sheet-body > .tab.active"
    ]);
  }

  #activateCraftEditor() {
    this.#craftResizeObserver?.disconnect();
    this.#craftResizeObserver = null;
    const workspace = this.element?.querySelector("[data-craft-workspace]");
    if (!workspace) return;
    workspace.addEventListener("contextmenu", event => event.preventDefault());
    workspace.addEventListener("pointerdown", event => this.#onCraftWorkspacePointerDown(event));
    workspace.addEventListener("dragover", event => this.#onCraftDragOver(event));
    workspace.addEventListener("drop", event => this.#onCraftDrop(event));
    workspace.addEventListener("dragleave", event => this.#onCraftDragLeave(event));
    workspace.addEventListener("wheel", event => this.#onCraftWheel(event), { passive: false });
    workspace.addEventListener("pointermove", event => this.#onCraftAttachPointerMove(event));
    workspace.querySelectorAll("[data-craft-node-id]").forEach(node => {
      node.addEventListener("pointerdown", event => this.#onCraftNodePointerDown(event));
    });
    workspace.querySelectorAll("[data-craft-block-id]:not([data-craft-node-id])").forEach(block => {
      block.addEventListener("pointerdown", event => this.#onCraftBlockPointerDown(event));
    });
    workspace.querySelector("[data-craft-attach-node]")?.addEventListener("click", event => this.#onCraftAttachNode(event));
    workspace.querySelector("[data-craft-detach-node]")?.addEventListener("click", event => this.#onCraftDetachNode(event));
    workspace.querySelector("[data-craft-extract-node]")?.addEventListener("click", event => this.#onCraftExtractNode(event));
    workspace.querySelector("[data-craft-delete-link]")?.addEventListener("click", event => this.#onCraftDeleteLink(event));
    workspace.querySelector("[data-craft-delete-node]")?.addEventListener("click", event => this.#onCraftDeleteNode(event));
    workspace.querySelector("[data-craft-cancel-attach]")?.addEventListener("click", event => this.#onCraftCancelAttach(event));
    workspace.querySelector("[data-craft-node-quantity]")?.addEventListener("change", event => this.#onCraftNodeQuantityChange(event));
    workspace.querySelector("[data-craft-node-tool-use-as-item]")?.addEventListener("change", event => this.#onCraftNodeToolUseAsItemChange(event));
    workspace.querySelector("[data-craft-block-limit]")?.addEventListener("change", event => this.#onCraftBlockLimitChange(event));
    workspace.querySelector("[data-craft-link-skill]")?.addEventListener("change", event => this.#onCraftLinkSkillChange(event));
    workspace.querySelector("[data-craft-link-difficulty]")?.addEventListener("change", event => this.#onCraftLinkDifficultyChange(event));
    workspace.querySelector("[data-craft-link-no-check]")?.addEventListener("change", event => this.#onCraftLinkNoCheckChange(event));
    workspace.querySelector("[data-craft-link-failure-result]")?.addEventListener("change", event => this.#onCraftLinkFailureResultChange(event));
    this.element?.querySelector("[data-craft-recipe-select]")?.addEventListener("change", event => this.#onCraftRecipeSelect(event));
    this.element?.querySelector("[data-craft-add-recipe]")?.addEventListener("click", event => this.#onCraftAddRecipe(event));
    this.element?.querySelector("[data-craft-delete-recipe]")?.addEventListener("click", event => this.#onCraftDeleteRecipe(event));
    this.element?.querySelectorAll("[data-craft-mode]").forEach(button => {
      button.addEventListener("click", event => this.#onCraftModeChange(event));
    });
    this.element?.querySelector("[data-craft-calculate-cost]")?.addEventListener("click", event => this.#onCraftCalculateCost(event));
    this.element?.querySelector("[data-craft-reverse-creation]")?.addEventListener("click", event => this.#onCraftReverseCreation(event));
    this.element?.querySelector('[data-action="tab"][data-tab="craft"]')?.addEventListener("click", () => {
      this.#scheduleCraftLinkRenderAfterLayout();
      requestAnimationFrame(() => requestAnimationFrame(() => this.#normalizeLegacyCraftBends()));
    });
    if (typeof ResizeObserver === "function") {
      this.#craftResizeObserver = new ResizeObserver(() => this.#scheduleCraftLinkRender());
      this.#craftResizeObserver.observe(workspace);
    }
    const viewport = this.#getCraftViewport();
    this.#setCraftViewportStyle(viewport.x, viewport.y, viewport.zoom);
    this.#syncCraftNodeLayouts();
    this.#scheduleCraftLinkRenderAfterLayout();
    this.#normalizeLegacyCraftBends();
    this.#positionCraftPopover();
  }

  #onCraftWorkspacePointerDown(event) {
    if (event.target?.closest?.(".fallout-maw-craft-popover")) return;
    const committedBlockLimit = this.#commitFocusedCraftBlockLimitInput({ clearSelection: event.button === 0 });
    if (committedBlockLimit) {
      event.preventDefault();
      event.stopPropagation();
      return committedBlockLimit;
    }
    if (event.button === 0) {
      if (this.#craftAttachSourceNodeId) {
        const workspace = event.currentTarget;
        const target = getCraftAttachTarget(workspace, event, this.#craftAttachSourceNodeId);
        const targetNodeId = String(target?.dataset?.craftNodeId ?? "");
        if (targetNodeId) {
          event.preventDefault();
          event.stopPropagation();
          return this.#createCraftLink(this.#craftAttachSourceNodeId, targetNodeId, event);
        }
      }
      if (event.target?.closest?.("[data-craft-node-id], [data-craft-link-id]")) return;
      if (!this.#craftSelection && !this.#craftAttachSourceNodeId) return;
      this.#craftSelection = null;
      this.#craftAttachSourceNodeId = "";
      this.#hideCraftSnapPreview();
      return this.render();
    }
    if (event.button !== 2) return;
    event.preventDefault();
    event.stopPropagation();
    const viewport = this.#getCraftViewport();
    this.#craftPanDrag = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: viewport.x,
      startY: viewport.y,
      contextBlockId: "",
      moved: false
    };
    const onMove = moveEvent => this.#onCraftPanMove(moveEvent);
    const onUp = upEvent => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      this.#onCraftPanEnd(upEvent);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
  }

  #onCraftPanMove(event) {
    const drag = this.#craftPanDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    const nextX = drag.startX + (event.clientX - drag.startClientX);
    const nextY = drag.startY + (event.clientY - drag.startClientY);
    drag.moved = true;
    this.#setCraftViewportStyle(nextX, nextY);
  }

  #onCraftPanEnd(event) {
    const drag = this.#craftPanDrag;
    this.#craftPanDrag = null;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.moved) {
      if (drag.contextBlockId) {
        this.#craftSelection = { type: "block", id: drag.contextBlockId };
        this.#craftAttachSourceNodeId = "";
        return this.render();
      }
      return undefined;
    }
    const nextX = Math.round(drag.startX + (event.clientX - drag.startClientX));
    const nextY = Math.round(drag.startY + (event.clientY - drag.startClientY));
    this.#setCraftViewportStyle(nextX, nextY);
    return undefined;
  }

  #getCraftViewport() {
    return this.#craftViewportOverride ?? getCraftViewport(this.item);
  }

  #setCraftViewportStyle(x, y, zoom = this.#getCraftViewport().zoom) {
    const workspace = this.element?.querySelector("[data-craft-workspace]");
    const world = this.element?.querySelector("[data-craft-world]");
    const viewport = clampCraftViewportToVisibleNode(
      normalizeCraftViewport({ x, y, zoom }),
      workspace,
      getCraftNodesWithRoot(this.item)
    );
    this.#craftViewportOverride = viewport;
    workspace?.style.setProperty("--craft-pan-x", `${viewport.x}px`);
    workspace?.style.setProperty("--craft-pan-y", `${viewport.y}px`);
    workspace?.style.setProperty("--craft-zoom", String(viewport.zoom));
    workspace?.style.setProperty("--fallout-maw-craft-scaled-step", `${Math.round(getCraftGridStep(workspace) * viewport.zoom)}px`);
    world?.style.setProperty("--craft-pan-x", `${viewport.x}px`);
    world?.style.setProperty("--craft-pan-y", `${viewport.y}px`);
    world?.style.setProperty("--craft-zoom", String(viewport.zoom));
    return viewport;
  }

  #onCraftDragOver(event) {
    if (event.target?.closest?.(".fallout-maw-craft-popover")) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    const data = this.#getPreviewCraftDropData(event);
    const coords = this.#getCraftPointerGridCoordinates(event, data);
    const preview = this.#getCraftExternalDropPreview(event, coords, data);
    this.#showCraftSnapPreview(preview, preview);
  }

  async #onCraftDrop(event) {
    if (event.target?.closest?.(".fallout-maw-craft-popover")) return;
    event.preventDefault();
    event.stopPropagation();
    this.#hideCraftSnapPreview();
    const data = this.#getDragEventData(event);
    if (data?.type !== "Item") return undefined;
    const droppedItem = resolveWorldItemSync(data.uuid);
    if (!isValidCraftComponentItem(droppedItem)) {
      ui.notifications.warn("В крафт можно добавлять только предметы из глобального хранилища, кроме болезней, травм и способностей.");
      return undefined;
    }

    const footprint = getCraftItemFootprint(droppedItem);
    const coords = this.#getCraftPointerGridCoordinates(event, footprint);
    const nodes = getCraftNodesWithRoot(this.item);
    const newNode = createCraftNodeFromItem(droppedItem, coords);
    const target = this.#getCraftDropTarget(event);
    if (target) {
      const result = mergeCraftNodesIntoTarget({
        nodes: [...nodes, newNode],
        links: getCraftLinks(this.item),
        movingNodeIds: [newNode.id],
        target,
        preferredPoint: coords
      });
      this.#craftSelection = null;
      this.#craftAttachSourceNodeId = "";
      return this.#updateCraftRecipe(result);
    }

    nodes.push(newNode);
    const placedNodes = placeExtractedCraftNode(nodes, newNode.id);
    this.#craftSelection = null;
    this.#craftAttachSourceNodeId = "";
    return this.#updateCraftRecipe({ nodes: placedNodes });
  }

  #onCraftDragLeave(event) {
    const workspace = event.currentTarget;
    if (event.relatedTarget && workspace.contains(event.relatedTarget)) return;
    this.#hideCraftSnapPreview();
  }

  #onCraftWheel(event) {
    if (event.target?.closest?.(".fallout-maw-craft-popover")) return;
    event.preventDefault();
    const workspace = this.element?.querySelector("[data-craft-workspace]");
    const rect = workspace?.getBoundingClientRect();
    if (!rect) return undefined;
    const viewport = this.#getCraftViewport();
    const factor = Math.exp(-event.deltaY * 0.0015);
    const nextZoom = clampCraftZoom(viewport.zoom * factor);
    if (Math.abs(nextZoom - viewport.zoom) < 0.001) return undefined;
    const pointerX = event.clientX - rect.left - (rect.width / 2);
    const pointerY = event.clientY - rect.top - (rect.height / 2);
    const worldX = (pointerX - viewport.x) / viewport.zoom;
    const worldY = (pointerY - viewport.y) / viewport.zoom;
    const nextX = pointerX - (worldX * nextZoom);
    const nextY = pointerY - (worldY * nextZoom);
    const nextViewport = this.#setCraftViewportStyle(nextX, nextY, nextZoom);
    if (this.#craftPanDrag) {
      this.#craftPanDrag.startClientX = event.clientX;
      this.#craftPanDrag.startClientY = event.clientY;
      this.#craftPanDrag.startX = nextViewport.x;
      this.#craftPanDrag.startY = nextViewport.y;
    }
    return undefined;
  }

  #getPreviewCraftDropData(event) {
    const data = this.#getDragEventData(event);
    const source = data?.data?.system ?? {};
    const placement = source?.placement ?? {};
    return {
      width: Math.max(1, toInteger(placement.width) || 1),
      height: Math.max(1, toInteger(placement.height) || 1)
    };
  }

  #getCraftPointerGridCoordinates(event, { width = 1, height = 1 } = {}) {
    const workspace = this.element?.querySelector("[data-craft-workspace]");
    const rect = workspace?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const viewport = this.#getCraftViewport();
    const step = getCraftGridStep(workspace);
    const rawX = (event.clientX - rect.left - (rect.width / 2) - viewport.x) / (step * viewport.zoom);
    const rawY = (event.clientY - rect.top - (rect.height / 2) - viewport.y) / (step * viewport.zoom);
    return {
      x: snapCraftGridCoordinate(rawX, width),
      y: snapCraftGridCoordinate(rawY, height)
    };
  }

  #getCraftExternalDropPreview(event, coords = { x: 0, y: 0 }, { width = 1, height = 1 } = {}) {
    const previewNode = normalizeCraftNode({
      id: "__preview__",
      x: coords.x,
      y: coords.y,
      width,
      height
    });
    const nodes = getCraftNodesWithRoot(this.item);
    const target = this.#getCraftDropTarget(event);
    if (target) {
      const result = mergeCraftNodesIntoTarget({
        nodes: [...nodes, previewNode],
        links: getCraftLinks(this.item),
        movingNodeIds: [previewNode.id],
        target,
        preferredPoint: coords
      });
      return getCraftNodesBounds(result.nodes.filter(node => node.id === previewNode.id)) ?? craftNodeToBounds(previewNode);
    }
    const position = findNearestFreeCraftNodePosition(previewNode, getCraftOccupiedBounds(nodes));
    return craftNodeToBounds({ ...previewNode, ...position });
  }

  #getCraftDropTarget(event, { excludeNodeIds = new Set(), excludeBlockId = "" } = {}) {
    const workspace = this.element?.querySelector("[data-craft-workspace]");
    if (!workspace) return null;
    const excludedNodes = excludeNodeIds instanceof Set ? excludeNodeIds : new Set(excludeNodeIds ?? []);
    const pointElement = document.elementFromPoint(event.clientX, event.clientY);
    const directNode = pointElement?.closest?.("[data-craft-node-id]");
    if (directNode && workspace.contains(directNode)) {
      const nodeId = String(directNode.dataset.craftNodeId ?? "");
      const blockId = String(directNode.dataset.craftBlockId ?? "");
      if (!excludedNodes.has(nodeId) && (!blockId || blockId !== excludeBlockId)) return { type: "node", id: nodeId };
    }
    const directBlock = pointElement?.closest?.("[data-craft-block-id]");
    if (directBlock && workspace.contains(directBlock)) {
      const blockId = String(directBlock.dataset.craftBlockId ?? "");
      if (blockId && blockId !== excludeBlockId) return { type: "block", id: blockId };
    }

    let nearest = null;
    let nearestDistance = 34;
    for (const element of workspace.querySelectorAll("[data-craft-node-id], [data-craft-block-id]")) {
      const nodeId = String(element.dataset.craftNodeId ?? "");
      const blockId = String(element.dataset.craftBlockId ?? "");
      if ((nodeId && excludedNodes.has(nodeId)) || (blockId && blockId === excludeBlockId)) continue;
      const distance = getPointToDomRectDistance(event.clientX, event.clientY, element.getBoundingClientRect());
      if (distance < nearestDistance) {
        nearest = nodeId ? { type: "node", id: nodeId } : { type: "block", id: blockId };
        nearestDistance = distance;
      }
    }
    return nearest;
  }

  #onCraftNodePointerDown(event) {
    const nodeElement = event.currentTarget;
    const nodeId = String(nodeElement.dataset.craftNodeId ?? "");
    if (!nodeId) return;
    if (![0, 2].includes(event.button)) return;
    event.preventDefault();
    event.stopPropagation();

    const nodes = getCraftNodesWithRoot(this.item);
    const node = nodes.find(entry => entry.id === nodeId);
    if (!node) return;
    const blockId = String(node.blockId ?? "");
    if (event.button === 2) {
      this.#startCraftPanDrag(event, blockId);
      return undefined;
    }

    if (this.#craftAttachSourceNodeId) {
      if (nodeId !== this.#craftAttachSourceNodeId) return this.#createCraftLink(this.#craftAttachSourceNodeId, nodeId, event);
      this.#craftAttachSourceNodeId = "";
      return this.render();
    }

    const movingNodeIds = blockId && !event.shiftKey
      ? nodes.filter(entry => entry.blockId === blockId).map(entry => entry.id)
      : [nodeId];
    const movingNodes = nodes.filter(entry => movingNodeIds.includes(entry.id));
    const bounds = getCraftNodesBounds(movingNodes) ?? craftNodeToBounds(node);
    this.#craftNodeDrag = {
      pointerId: event.pointerId,
      nodeId,
      blockId: blockId && !event.shiftKey ? blockId : "",
      sourceBlockId: blockId,
      movingNodeIds,
      element: nodeElement,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: Number(nodeElement.dataset.craftX) || 0,
      startY: Number(nodeElement.dataset.craftY) || 0,
      previewX: bounds.x,
      previewY: bounds.y,
      previewWidth: bounds.width,
      previewHeight: bounds.height,
      moved: false
    };

    const onMove = moveEvent => this.#onCraftNodeMove(moveEvent);
    const onUp = upEvent => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      this.#onCraftNodeEnd(upEvent);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
  }

  #onCraftBlockPointerDown(event) {
    if (![0, 2].includes(event.button) || this.#craftAttachSourceNodeId) return;
    const blockElement = event.currentTarget;
    const blockId = String(blockElement.dataset.craftBlockId ?? "");
    if (!blockId) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.button === 2) {
      this.#startCraftPanDrag(event, blockId);
      return undefined;
    }
    const nodes = getCraftNodesWithRoot(this.item);
    const movingNodeIds = nodes.filter(node => node.blockId === blockId).map(node => node.id);
    if (!movingNodeIds.length) return;
    const bounds = getCraftNodesBounds(nodes.filter(node => movingNodeIds.includes(node.id))) ?? {
      x: Number(blockElement.dataset.craftX) || 0,
      y: Number(blockElement.dataset.craftY) || 0,
      width: Number(blockElement.dataset.craftWidth) || 1,
      height: Number(blockElement.dataset.craftHeight) || 1
    };
    this.#craftNodeDrag = {
      pointerId: event.pointerId,
      nodeId: "",
      blockId,
      sourceBlockId: blockId,
      movingNodeIds,
      element: blockElement,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: Number(blockElement.dataset.craftX) || 0,
      startY: Number(blockElement.dataset.craftY) || 0,
      previewX: bounds.x,
      previewY: bounds.y,
      previewWidth: bounds.width,
      previewHeight: bounds.height,
      moved: false
    };

    const onMove = moveEvent => this.#onCraftNodeMove(moveEvent);
    const onUp = upEvent => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      this.#onCraftNodeEnd(upEvent);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
  }

  #startCraftPanDrag(event, contextBlockId = "") {
    const viewport = this.#getCraftViewport();
    this.#craftPanDrag = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: viewport.x,
      startY: viewport.y,
      contextBlockId: String(contextBlockId ?? ""),
      moved: false
    };
    const onMove = moveEvent => this.#onCraftPanMove(moveEvent);
    const onUp = upEvent => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      this.#onCraftPanEnd(upEvent);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
  }

  #onCraftNodeMove(event) {
    const drag = this.#craftNodeDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    const dx = event.clientX - drag.startClientX;
    const dy = event.clientY - drag.startClientY;
    if (!drag.moved && Math.hypot(dx, dy) < CRAFT_DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    this.#setCraftDraggingState(drag, true);
    const step = getCraftGridStep(this.element?.querySelector("[data-craft-workspace]"));
    const zoom = this.#getCraftViewport().zoom;
    const deltaX = Math.round(dx / (step * zoom));
    const deltaY = Math.round(dy / (step * zoom));
    drag.deltaX = deltaX;
    drag.deltaY = deltaY;
    const resolved = resolveCraftDragPlacement(getCraftNodesWithRoot(this.item), drag.movingNodeIds, {
      deltaX,
      deltaY,
      movingBlockId: drag.blockId,
      sourceBlockId: drag.sourceBlockId
    });
    drag.resolvedDeltaX = resolved.deltaX;
    drag.resolvedDeltaY = resolved.deltaY;
    const preview = this.#getCraftNodeDragPreview(drag, resolved.deltaX, resolved.deltaY);
    this.#showCraftSnapPreview({ x: preview.x, y: preview.y }, preview);
  }

  #getCraftNodeDragPreview(drag, deltaX = 0, deltaY = 0) {
    const movingIds = new Set(drag.movingNodeIds ?? [drag.nodeId].filter(Boolean));
    const movingNodes = getCraftNodesWithRoot(this.item)
      .filter(node => movingIds.has(node.id))
      .map(node => ({ ...node, x: node.x + deltaX, y: node.y + deltaY }));
    return getCraftNodesBounds(movingNodes) ?? {
      x: (Number(drag.previewX) || 0) + deltaX,
      y: (Number(drag.previewY) || 0) + deltaY,
      width: Math.max(1, toInteger(drag.previewWidth) || 1),
      height: Math.max(1, toInteger(drag.previewHeight) || 1)
    };
  }

  #onCraftNodeEnd(event) {
    const drag = this.#craftNodeDrag;
    this.#craftNodeDrag = null;
    if (!drag || event.pointerId !== drag.pointerId) return undefined;
    this.#setCraftDraggingState(drag, false);
    this.#hideCraftSnapPreview();
    if (!drag.moved) {
      this.#craftSelection = drag.nodeId ? { type: "node", id: drag.nodeId } : { type: "block", id: drag.blockId };
      this.#craftAttachSourceNodeId = "";
      return this.render();
    }
    const deltaX = Number(drag.resolvedDeltaX ?? drag.deltaX ?? 0) || 0;
    const deltaY = Number(drag.resolvedDeltaY ?? drag.deltaY ?? 0) || 0;
    const movingIds = new Set(drag.movingNodeIds ?? [drag.nodeId].filter(Boolean));
    const target = this.#getCraftDropTarget(event, {
      excludeNodeIds: movingIds,
      excludeBlockId: drag.blockId || drag.sourceBlockId
    });
    const shiftedNodes = getCraftNodesWithRoot(this.item).map(node => (
      movingIds.has(node.id) ? { ...node, x: node.x + deltaX, y: node.y + deltaY } : node
    ));

    if (target) {
      const result = mergeCraftNodesIntoTarget({
        nodes: shiftedNodes,
        links: getCraftLinks(this.item),
        movingNodeIds: [...movingIds],
        target,
        preferredPoint: this.#getCraftPointerGridCoordinates(event, {
          width: drag.previewWidth,
          height: drag.previewHeight
        })
      });
      this.#craftSelection = null;
      this.#craftAttachSourceNodeId = "";
      return this.#updateCraftRecipe(result);
    }

    const nodes = resolveCraftMoveCollisions(shiftedNodes, [...movingIds], {
      movingBlockId: drag.blockId,
      sourceBlockId: drag.sourceBlockId
    });
    this.#craftSelection = null;
    this.#craftAttachSourceNodeId = "";
    return this.#updateCraftRecipe({ nodes });
  }

  #setCraftDraggingState(drag, enabled) {
    const method = enabled ? "add" : "remove";
    drag.element?.classList?.[method]?.("dragging");
    const workspace = this.element?.querySelector("[data-craft-workspace]");
    if (drag.blockId) {
      workspace?.querySelector(`[data-craft-block-id="${CSS.escape(drag.blockId)}"]`)?.classList?.[method]?.("dragging");
      workspace?.querySelector(`[data-craft-block-frame-id="${CSS.escape(drag.blockId)}"]`)?.classList?.[method]?.("dragging");
    }
    for (const nodeId of drag.movingNodeIds ?? []) {
      workspace?.querySelector(`[data-craft-node-id="${CSS.escape(nodeId)}"]`)?.classList?.[method]?.("dragging");
    }
  }

  #onCraftModeChange(event) {
    event.preventDefault();
    const mode = normalizeCraftMode(event.currentTarget?.dataset?.craftMode);
    if (mode === this.#craftMode) return undefined;
    this.#craftMode = mode;
    activeCraftModes.set(this.item, mode);
    this.#craftSelection = null;
    this.#craftAttachSourceNodeId = "";
    this.#craftViewportOverride = null;
    return this.render();
  }

  #onCraftRecipeSelect(event) {
    event.preventDefault();
    const recipeId = String(event.currentTarget?.value ?? "");
    if (!recipeId || recipeId === this.#craftRecipeId) return undefined;
    this.#craftRecipeId = resolveCraftRecipeId(this.item, recipeId);
    activeCraftRecipeIds.set(this.item, this.#craftRecipeId);
    this.#craftSelection = null;
    this.#craftAttachSourceNodeId = "";
    this.#craftViewportOverride = null;
    return this.render();
  }

  async #onCraftAddRecipe(event) {
    event.preventDefault();
    const recipes = getCraftRecipeEntries(this.item);
    const recipe = createBlankCraftRecipeEntry({
      id: getNextCraftRecipeId(recipes),
      name: getNextCraftRecipeName(recipes)
    });
    recipes.push(recipe);
    this.#craftRecipeId = recipe.id;
    activeCraftRecipeIds.set(this.item, this.#craftRecipeId);
    this.#craftSelection = null;
    this.#craftAttachSourceNodeId = "";
    this.#craftViewportOverride = null;
    return this.item.update({ "system.craft.recipes": recipes });
  }

  async #onCraftDeleteRecipe(event) {
    event.preventDefault();
    if (this.#craftRecipeId === DEFAULT_CRAFT_RECIPE_ID) {
      ui.notifications.warn(`${DEFAULT_CRAFT_RECIPE_NAME} удалить нельзя.`);
      return undefined;
    }

    const recipes = getCraftRecipeEntries(this.item);
    const recipe = recipes.find(entry => entry.id === this.#craftRecipeId);
    if (!recipe) return undefined;
    const confirmed = await DialogV2.confirm({
      window: { title: "Удалить рецепт" },
      content: `<p>Удалить ${escapeHtml(recipe.name)}?</p>`,
      yes: {
        icon: "fa-solid fa-trash",
        label: "Удалить"
      },
      no: {
        label: game.i18n.localize("Cancel")
      },
      rejectClose: false,
      modal: true
    });
    if (!confirmed) return undefined;

    const nextRecipes = recipes.filter(entry => entry.id !== recipe.id);
    this.#craftRecipeId = DEFAULT_CRAFT_RECIPE_ID;
    activeCraftRecipeIds.set(this.item, this.#craftRecipeId);
    this.#craftSelection = null;
    this.#craftAttachSourceNodeId = "";
    this.#craftViewportOverride = null;
    return this.item.update({ "system.craft.recipes": nextRecipes });
  }

  async #onCraftCalculateCost(event) {
    event.preventDefault();
    const calculation = calculateCraftItemCost(this.item);
    if (!calculation.componentCount && !calculation.toolCount) {
      ui.notifications.warn("В рецепте нет компонентов или расходуемых инструментов для расчёта стоимости.");
      return undefined;
    }

    const result = await openCraftCostDialog(calculation);
    if (!result) return undefined;

    const difficultyPercent = Math.max(0, Number(result.difficultyPercent) || 0);
    const toolCost = Math.max(0, Math.round(Number(result.toolCost) || 0));
    const finalPrice = Math.max(0, Math.round((calculation.componentCost * (1 + (difficultyPercent / 100))) + toolCost));
    await this.item.update({
      "system.price": finalPrice,
      "system.priceCurrency": calculation.currencyKey
    });
    ui.notifications.info(`Стоимость предмета обновлена: ${formatCraftCost(finalPrice)} ${calculation.currencyLabel}.`);
    return this.render();
  }

  async #onCraftReverseCreation(event) {
    event.preventDefault();
    const confirmed = await DialogV2.confirm({
      window: {
        title: "Реверсировать создание"
      },
      content: "<p>Скопировать схему создания в разбор, развернув связи и отзеркалив сетку относительно предмета?</p>",
      yes: {
        icon: "fa-solid fa-rotate",
        label: "Реверсировать"
      },
      no: {
        label: game.i18n.localize("Cancel")
      },
      rejectClose: false,
      modal: true
    });
    if (!confirmed) return undefined;

    const reversed = createReversedCraftRecipe(this.item);
    this.#craftMode = CRAFT_MODE_DISASSEMBLY;
    activeCraftModes.set(this.item, this.#craftMode);
    this.#craftSelection = null;
    this.#craftAttachSourceNodeId = "";
    this.#craftViewportOverride = null;
    return this.#updateCraftRecipe(reversed);
  }

  #onCraftAttachNode(event) {
    event.preventDefault();
    const nodeId = String(event.currentTarget.dataset.craftAttachNode ?? "");
    if (!nodeId) return undefined;
    this.#craftSelection = null;
    this.#craftAttachSourceNodeId = nodeId;
    return this.render();
  }

  #onCraftCancelAttach(event) {
    event.preventDefault();
    this.#craftAttachSourceNodeId = "";
    return this.render();
  }

  #onCraftDetachNode(event) {
    event.preventDefault();
    const nodeId = String(event.currentTarget.dataset.craftDetachNode ?? "");
    if (!nodeId) return undefined;
    const links = getCraftLinks(this.item).filter(link => link.fromNodeId !== nodeId && link.toNodeId !== nodeId);
    this.#craftSelection = { type: "node", id: nodeId };
    this.#craftAttachSourceNodeId = "";
    return this.#updateCraftRecipe({ links });
  }

  #onCraftDeleteLink(event) {
    event.preventDefault();
    const linkId = String(event.currentTarget.dataset.craftDeleteLink ?? "");
    if (!linkId) return undefined;
    const links = getCraftLinks(this.item).filter(link => link.id !== linkId);
    this.#craftSelection = null;
    this.#craftAttachSourceNodeId = "";
    return this.#updateCraftRecipe({ links });
  }

  #onCraftExtractNode(event) {
    event.preventDefault();
    const nodeId = String(event.currentTarget.dataset.craftExtractNode ?? "");
    if (!nodeId) return undefined;
    let nodes = getCraftNodesWithRoot(this.item).map(node => (
      node.id === nodeId ? { ...node, blockId: "" } : node
    ));
    const normalized = normalizeCraftRecipeParts(nodes, getCraftLinks(this.item));
    nodes = placeExtractedCraftNode(normalized.nodes, nodeId);
    this.#craftSelection = { type: "node", id: nodeId };
    this.#craftAttachSourceNodeId = "";
    return this.#updateCraftRecipe({ nodes, links: normalized.links });
  }

  #onCraftNodeQuantityChange(event) {
    const nodeId = String(event.currentTarget.dataset.craftNodeQuantity ?? "");
    if (!nodeId) return undefined;
    const quantity = Math.max(1, toInteger(event.currentTarget.value) || 1);
    event.currentTarget.value = String(quantity);
    const nodes = getCraftNodesWithRoot(this.item).map(node => (
      node.id === nodeId ? { ...node, quantity } : node
    ));
    return this.#updateCraftRecipe({ nodes });
  }

  #onCraftBlockLimitChange(event) {
    return this.#commitCraftBlockLimitInput(event.currentTarget);
  }

  #commitFocusedCraftBlockLimitInput({ clearSelection = false } = {}) {
    const input = document.activeElement;
    if (!input?.matches?.("[data-craft-block-limit]") || !this.element?.contains(input)) return null;
    return this.#commitCraftBlockLimitInput(input, { clearSelection });
  }

  #commitCraftBlockLimitInput(input, { clearSelection = false } = {}) {
    if (!input) return null;
    const blockId = String(input.dataset.craftBlockLimit ?? "");
    if (!blockId) return undefined;
    const blockLimit = normalizeCraftBlockLimit(input.value);
    input.value = Number.isInteger(blockLimit) && blockLimit > 0 ? String(blockLimit) : "";
    const nodes = getCraftNodesWithRoot(this.item).map(node => (
      String(node.blockId ?? "") === blockId ? { ...node, blockLimit } : node
    ));
    this.#craftSelection = clearSelection ? null : { type: "block", id: blockId };
    return this.#updateCraftRecipe({ nodes });
  }

  async #onCraftNodeToolUseAsItemChange(event) {
    event.stopPropagation();
    const nodeId = String(event.currentTarget.dataset.craftNodeToolUseAsItem ?? "");
    if (!nodeId) return undefined;
    const node = getCraftNodesWithRoot(this.item).find(entry => entry.id === nodeId);
    const source = resolveCraftNodeSourceItem(node);
    const toolKey = getSelectedToolFunctionKey(source);
    if (!source || !toolKey) return undefined;
    await source.update({
      [`system.functions.tools.${toolKey}.useAsItem`]: Boolean(event.currentTarget.checked)
    });
    return this.render();
  }

  #onCraftLinkNoCheckChange(event) {
    const linkId = String(event.currentTarget.dataset.craftLinkNoCheck ?? "");
    if (!linkId) return undefined;
    const noCheck = Boolean(event.currentTarget.checked);
    const links = getCraftLinks(this.item).map(link => (
      link.id === linkId ? { ...link, noCheck } : link
    ));
    return this.#updateCraftRecipe({ links });
  }

  #onCraftLinkFailureResultChange(event) {
    const linkId = String(event.currentTarget.dataset.craftLinkFailureResult ?? "");
    if (!linkId) return undefined;
    const failureResult = Boolean(event.currentTarget.checked);
    const links = getCraftLinks(this.item).map(link => (
      link.id === linkId ? { ...link, failureResult, noCheck: failureResult ? true : link.noCheck } : link
    ));
    return this.#updateCraftRecipe({ links });
  }

  #onCraftLinkSkillChange(event) {
    const linkId = String(event.currentTarget.dataset.craftLinkSkill ?? "");
    if (!linkId) return undefined;
    const skillKey = String(event.currentTarget.value ?? "");
    const links = getCraftLinks(this.item).map(link => (
      link.id === linkId ? { ...link, skillKey } : link
    ));
    return this.#updateCraftRecipe({ links });
  }

  #onCraftLinkDifficultyChange(event) {
    const linkId = String(event.currentTarget.dataset.craftLinkDifficulty ?? "");
    if (!linkId) return undefined;
    const difficulty = normalizeCraftLinkDifficulty(event.currentTarget.value);
    event.currentTarget.value = String(difficulty);
    const links = getCraftLinks(this.item).map(link => (
      link.id === linkId ? { ...link, difficulty } : link
    ));
    return this.#updateCraftRecipe({ links });
  }

  #onCraftDeleteNode(event) {
    event.preventDefault();
    const nodeId = String(event.currentTarget.dataset.craftDeleteNode ?? "");
    if (!nodeId) return undefined;
    const nodes = getCraftNodesWithRoot(this.item);
    const node = nodes.find(entry => entry.id === nodeId);
    if (!node || node.root) return undefined;
    const links = getCraftLinks(this.item).filter(link => link.fromNodeId !== nodeId && link.toNodeId !== nodeId);
    this.#craftSelection = null;
    this.#craftAttachSourceNodeId = "";
    return this.#updateCraftRecipe({
      nodes: nodes.filter(entry => entry.id !== nodeId),
      links
    });
  }

  #onCraftAttachPointerMove(event) {
    if (!this.#craftAttachSourceNodeId) return;
    const workspace = this.element?.querySelector("[data-craft-workspace]");
    if (!workspace) return;
    workspace.querySelectorAll(".fallout-maw-craft-node.attach-target").forEach(node => node.classList.remove("attach-target"));
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest?.("[data-craft-node-id]");
    if (target
      && workspace.contains(target)
      && target.dataset.craftNodeId !== this.#craftAttachSourceNodeId
      && this.#canCreateCraftLink(this.#craftAttachSourceNodeId, String(target.dataset.craftNodeId ?? ""))
    ) {
      target.classList.add("attach-target");
    }
    this.#renderCraftLinks({ previewEvent: event });
  }

  #showCraftSnapPreview({ x = 0, y = 0 } = {}, { width = 1, height = 1 } = {}) {
    const preview = this.element?.querySelector("[data-craft-snap-preview]");
    if (!preview) return;
    preview.hidden = false;
    preview.style.setProperty("--craft-x", String(x));
    preview.style.setProperty("--craft-y", String(y));
    preview.style.setProperty("--craft-width", String(Math.max(1, toInteger(width) || 1)));
    preview.style.setProperty("--craft-height", String(Math.max(1, toInteger(height) || 1)));
    this.#applyCraftElementLayout(preview, { x, y, width, height });
  }

  #hideCraftSnapPreview() {
    this.element?.querySelector("[data-craft-snap-preview]")?.setAttribute("hidden", "");
  }

  #scheduleCraftLinkRender() {
    if (this.#craftLinkRenderFrame) return;
    this.#craftLinkRenderFrame = requestAnimationFrame(() => {
      this.#craftLinkRenderFrame = 0;
      if (!this.#isCraftWorkspaceRenderable()) return;
      this.#syncCraftNodeLayouts();
      this.#renderCraftLinks();
    });
  }

  #scheduleCraftLinkRenderAfterLayout() {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => this.#scheduleCraftLinkRender());
    });
  }

  #isCraftWorkspaceRenderable() {
    const workspace = this.element?.querySelector("[data-craft-workspace]");
    const svg = workspace?.querySelector("[data-craft-links]");
    if (!workspace || !svg) return false;
    if (!workspace.getClientRects().length || !svg.getClientRects().length) return false;
    const workspaceRect = workspace.getBoundingClientRect();
    const svgRect = svg.getBoundingClientRect();
    return workspaceRect.width > 0 && workspaceRect.height > 0 && svgRect.width > 0 && svgRect.height > 0;
  }

  #syncCraftNodeLayouts() {
    this.element?.querySelectorAll("[data-craft-block-id]").forEach(block => {
      this.#applyCraftElementLayout(block, {
        x: Number(block.dataset.craftX) || 0,
        y: Number(block.dataset.craftY) || 0,
        width: Number(block.dataset.craftWidth) || 1,
        height: Number(block.dataset.craftHeight) || 1
      });
    });
    this.element?.querySelectorAll("[data-craft-block-frame-id]").forEach(block => {
      this.#applyCraftElementLayout(block, {
        x: Number(block.dataset.craftX) || 0,
        y: Number(block.dataset.craftY) || 0,
        width: Number(block.dataset.craftWidth) || 1,
        height: Number(block.dataset.craftHeight) || 1
      });
    });
    this.element?.querySelectorAll("[data-craft-node-id]").forEach(node => {
      this.#applyCraftElementLayout(node, {
        x: Number(node.dataset.craftX) || 0,
        y: Number(node.dataset.craftY) || 0,
        width: Number(node.dataset.craftWidth) || 1,
        height: Number(node.dataset.craftHeight) || 1
      });
    });
  }

  #applyCraftElementLayout(element, { x = 0, y = 0, width = 1, height = 1 } = {}) {
    const metrics = getCraftGridMetrics(this.element?.querySelector("[data-craft-workspace]"));
    const normalizedWidth = Math.max(1, toInteger(width) || 1);
    const normalizedHeight = Math.max(1, toInteger(height) || 1);
    const widthPx = (normalizedWidth * metrics.cell) + ((normalizedWidth - 1) * metrics.gap);
    const heightPx = (normalizedHeight * metrics.cell) + ((normalizedHeight - 1) * metrics.gap);
    element.style.setProperty("--craft-offset-x", `${(Number(x) || 0) * metrics.step}px`);
    element.style.setProperty("--craft-offset-y", `${(Number(y) || 0) * metrics.step}px`);
    element.style.setProperty("--craft-node-width", `${widthPx}px`);
    element.style.setProperty("--craft-node-height", `${heightPx}px`);
    element.style.setProperty("--craft-node-half-width", `${widthPx / 2}px`);
    element.style.setProperty("--craft-node-half-height", `${heightPx / 2}px`);
  }

  async #createCraftLink(fromNodeId, toNodeId, event = null) {
    const nodes = getCraftNodesWithRoot(this.item);
    if (!nodes.some(node => node.id === fromNodeId) || !nodes.some(node => node.id === toNodeId)) return undefined;
    if (getCraftResolvedEndpointId(nodes.find(node => node.id === fromNodeId)) === getCraftResolvedEndpointId(nodes.find(node => node.id === toNodeId))) {
      return undefined;
    }
    const links = getCraftLinks(this.item).filter(link => (
      getCraftResolvedLinkKey(link, nodes) !== getCraftResolvedPairKey(fromNodeId, toNodeId, nodes)
    ));
    const skillKey = getDefaultCraftSkillKey(getSkillSettings());
    const anchors = event ? this.#getCraftNewLinkAnchors(fromNodeId, toNodeId, event) : {};
    const link = {
      id: foundry.utils.randomID(),
      fromNodeId,
      toNodeId,
      skillKey,
      difficulty: 60,
      ...buildCraftAnchorUpdateData(anchors)
    };
    links.push(link);
    this.#craftSelection = { type: "link", id: link.id };
    this.#craftAttachSourceNodeId = "";
    return this.#updateCraftRecipe({ nodes, links });
  }

  #getCraftNewLinkAnchors(fromNodeId, toNodeId, event) {
    const workspace = this.element?.querySelector("[data-craft-workspace]");
    const svg = workspace?.querySelector("[data-craft-links]");
    const fromElement = this.#getCraftEndpointElement(fromNodeId, workspace);
    const toElement = this.#getCraftEndpointElement(toNodeId, workspace);
    const from = getElementRectRelativeToSvg(fromElement, svg);
    const to = getElementRectRelativeToSvg(toElement, svg);
    if (!from || !to || !svg) return {};
    const cursor = getCraftSvgPointFromEvent(event, svg);
    return {
      from: anchorToData(getCraftResolvedAnchor(from, null, getRectCenter(to))),
      to: anchorToData(getCraftSnapAnchor(to, cursor, getRectCenter(from)))
    };
  }

  #renderCraftLinks({ previewEvent = null } = {}) {
    const workspace = this.element?.querySelector("[data-craft-workspace]");
    const svg = workspace?.querySelector("[data-craft-links]");
    if (!workspace || !svg) return;
    if (!this.#isCraftWorkspaceRenderable()) return;
    svg.replaceChildren();
    const nodeData = new Map(getCraftNodesWithRoot(this.item).map(node => [node.id, node]));
    const selectedLinkId = this.#craftSelection?.type === "link" ? this.#craftSelection.id : "";
    for (const link of getCraftLinks(this.item)) {
      const fromNode = nodeData.get(link.fromNodeId);
      const toNode = nodeData.get(link.toNodeId);
      if (!fromNode || !toNode || getCraftResolvedEndpointId(fromNode) === getCraftResolvedEndpointId(toNode)) continue;
      const from = this.#getCraftEndpointElement(link.fromNodeId, workspace);
      const to = this.#getCraftEndpointElement(link.toNodeId, workspace);
      if (!from || !to) continue;
      const bend = this.#craftLinkDrag?.linkId === link.id
        ? this.#craftLinkDrag.bend
        : this.#craftSocketDrag?.linkId === link.id
          ? this.#craftSocketDrag.bend
        : getCraftLinkBend(link, svg);
      const anchors = this.#craftLinkDrag?.linkId === link.id
        ? this.#craftLinkDrag.anchors
        : this.#craftSocketDrag?.linkId === link.id
          ? this.#craftSocketDrag.anchors
          : getCraftLinkAnchors(link);
      this.#appendCraftLinkPath(svg, getCraftConnectorGeometry(from, to, svg, bend, anchors), link, selectedLinkId);
    }
    if (this.#craftAttachSourceNodeId && previewEvent) {
      const source = this.#getCraftEndpointElement(this.#craftAttachSourceNodeId, workspace);
      if (source) {
        const target = getCraftAttachTarget(workspace, previewEvent, this.#craftAttachSourceNodeId);
        const targetNodeId = String(target?.dataset?.craftNodeId ?? "");
        const canLinkTarget = targetNodeId && this.#canCreateCraftLink(this.#craftAttachSourceNodeId, targetNodeId);
        if (target && canLinkTarget) target.classList.add("attach-target");
        const geometry = target && canLinkTarget
          ? getCraftAttachPreviewGeometry(source, this.#getCraftEndpointElement(targetNodeId, workspace), svg, previewEvent)
          : getCraftConnectorGeometryToPoint(source, previewEvent, svg);
        this.#appendCraftPreviewConnector(svg, geometry);
      }
    }
    this.#positionCraftPopover();
  }

  #canCreateCraftLink(fromNodeId, toNodeId) {
    const nodes = getCraftNodesWithRoot(this.item);
    const from = nodes.find(node => node.id === fromNodeId);
    const to = nodes.find(node => node.id === toNodeId);
    return Boolean(from && to && getCraftResolvedEndpointId(from) !== getCraftResolvedEndpointId(to));
  }

  #getCraftEndpointElement(nodeId, workspace = this.element?.querySelector("[data-craft-workspace]")) {
    const node = getCraftNodesWithRoot(this.item).find(entry => entry.id === nodeId);
    const blockId = String(node?.blockId ?? "");
    return (blockId ? workspace?.querySelector(`[data-craft-block-id="${CSS.escape(blockId)}"]`) : null)
      ?? workspace?.querySelector(`[data-craft-node-id="${CSS.escape(nodeId)}"]`)
      ?? null;
  }

  #appendCraftLinkPath(svg, geometry, link, selectedLinkId) {
    if (!geometry?.centerPath) return;
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.classList.add("fallout-maw-craft-link");
    if (isCraftLinkFailureResult(link)) group.classList.add("failure-result");
    if (link.id === selectedLinkId) group.classList.add("selected");
    group.dataset.craftLinkId = link.id;
    for (const [className, pathData] of [
      ["fallout-maw-craft-link-hit", geometry.centerPath],
      ["fallout-maw-craft-link-shadow", geometry.centerPath],
      ["fallout-maw-craft-link-wall", geometry.centerPath],
      ["fallout-maw-craft-link-glass", geometry.centerPath],
      ["fallout-maw-craft-link-highlight", geometry.centerPath]
    ]) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.classList.add(className);
      path.setAttribute("d", pathData);
      group.appendChild(path);
    }
    for (const [role, point] of [["from", geometry.start], ["to", geometry.end]]) {
      for (const [className, socketPath] of [
        ["fallout-maw-craft-link-socket-shadow", point.socketPath],
        ["fallout-maw-craft-link-socket", point.socketPath]
      ]) {
        const socket = document.createElementNS("http://www.w3.org/2000/svg", "path");
        socket.classList.add(className);
        socket.dataset.craftSocketRole = role;
        socket.setAttribute("d", socketPath);
        if (className === "fallout-maw-craft-link-socket") {
          socket.addEventListener("pointerdown", event => this.#onCraftSocketPointerDown(event, link, role, svg));
        }
        group.appendChild(socket);
      }
    }
    group.addEventListener("pointerdown", event => this.#onCraftLinkPointerDown(event, link, svg));
    group.addEventListener("dblclick", event => {
      event.preventDefault();
      event.stopPropagation();
      this.#craftSelection = { type: "link", id: link.id };
      this.#craftAttachSourceNodeId = "";
      this.render();
    });
    svg.appendChild(group);
  }

  #onCraftLinkPointerDown(event, link, svg) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const start = getCraftSvgPointFromEvent(event, svg);
    const anchors = this.#getCraftLinkAnchorData(link, svg);
    this.#craftLinkDrag = {
      pointerId: event.pointerId,
      linkId: link.id,
      startClientX: event.clientX,
      startClientY: event.clientY,
      bend: getCraftLinkBend(link, svg) ?? start,
      anchors,
      moved: false
    };
    const onMove = moveEvent => this.#onCraftLinkMove(moveEvent);
    const onUp = upEvent => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      this.#onCraftLinkEnd(upEvent);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
  }

  #onCraftLinkMove(event) {
    const drag = this.#craftLinkDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    const dx = event.clientX - drag.startClientX;
    const dy = event.clientY - drag.startClientY;
    if (!drag.moved && Math.hypot(dx, dy) < CRAFT_DRAG_THRESHOLD_PX) return;
    const svg = this.element?.querySelector("[data-craft-links]");
    if (!svg) return;
    drag.moved = true;
    drag.bend = getCraftSvgPointFromEvent(event, svg);
    this.#renderCraftLinks();
  }

  #onCraftLinkEnd(event) {
    const drag = this.#craftLinkDrag;
    this.#craftLinkDrag = null;
    if (!drag || event.pointerId !== drag.pointerId) return undefined;
    this.#craftAttachSourceNodeId = "";
    if (!drag.moved) {
      this.#craftSelection = { type: "link", id: drag.linkId };
      return this.render();
    }
    const svg = this.element?.querySelector("[data-craft-links]");
    if (!svg) return undefined;
    const links = getCraftLinks(this.item).map(link => (
      link.id === drag.linkId
        ? { ...link, ...craftSvgPointToStoredBend(svg, drag.bend), ...buildCraftAnchorUpdateData(drag.anchors) }
        : link
    ));
    this.#craftSelection = null;
    return this.#updateCraftRecipe({ links });
  }

  #onCraftSocketPointerDown(event, link, role, svg) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const anchors = this.#getCraftLinkAnchorData(link, svg);
    this.#craftSocketDrag = {
      pointerId: event.pointerId,
      linkId: link.id,
      role,
      anchors,
      bend: getCraftLinkBend(link, svg),
      moved: false,
      startClientX: event.clientX,
      startClientY: event.clientY
    };
    const onMove = moveEvent => this.#onCraftSocketMove(moveEvent);
    const onUp = upEvent => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      this.#onCraftSocketEnd(upEvent);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
  }

  #onCraftSocketMove(event) {
    const drag = this.#craftSocketDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    const dx = event.clientX - drag.startClientX;
    const dy = event.clientY - drag.startClientY;
    if (!drag.moved && Math.hypot(dx, dy) < CRAFT_DRAG_THRESHOLD_PX) return;
    const workspace = this.element?.querySelector("[data-craft-workspace]");
    const svg = workspace?.querySelector("[data-craft-links]");
    const link = getCraftLinks(this.item).find(entry => entry.id === drag.linkId);
    const nodeId = drag.role === "from" ? link?.fromNodeId : link?.toNodeId;
    const nodeElement = nodeId ? this.#getCraftEndpointElement(nodeId, workspace) : null;
    const rect = getElementRectRelativeToSvg(nodeElement, svg);
    if (!rect || !svg) return;
    drag.moved = true;
    drag.anchors = {
      ...drag.anchors,
      [drag.role]: anchorToData(getNearestRectAnchor(rect, getCraftSvgPointFromEvent(event, svg)))
    };
    this.#renderCraftLinks();
  }

  #onCraftSocketEnd(event) {
    const drag = this.#craftSocketDrag;
    this.#craftSocketDrag = null;
    if (!drag || event.pointerId !== drag.pointerId) return undefined;
    if (!drag.moved) return undefined;
    const links = getCraftLinks(this.item).map(link => (
      link.id === drag.linkId ? { ...link, ...buildCraftAnchorUpdateData(drag.anchors) } : link
    ));
    this.#craftSelection = null;
    return this.#updateCraftRecipe({ links });
  }

  #getCraftLinkAnchorData(link, svg) {
    const workspace = this.element?.querySelector("[data-craft-workspace]");
    const fromElement = this.#getCraftEndpointElement(link.fromNodeId, workspace);
    const toElement = this.#getCraftEndpointElement(link.toNodeId, workspace);
    const from = getElementRectRelativeToSvg(fromElement, svg);
    const to = getElementRectRelativeToSvg(toElement, svg);
    if (!from || !to) return getCraftLinkAnchors(link);
    const bend = getCraftLinkBend(link, svg);
    const fromAnchor = getCraftResolvedAnchor(from, getCraftLinkAnchor(link, "from"), bend ?? getRectCenter(to));
    const toAnchor = getCraftResolvedAnchor(to, getCraftLinkAnchor(link, "to"), bend ?? getRectCenter(from));
    return {
      from: anchorToData(fromAnchor),
      to: anchorToData(toAnchor)
    };
  }

  #appendCraftPreviewConnector(svg, geometry) {
    if (!geometry?.centerPath) return;
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.classList.add("fallout-maw-craft-link", "preview");
    for (const [className, pathData] of [
      ["fallout-maw-craft-link-shadow", geometry.centerPath],
      ["fallout-maw-craft-link-wall", geometry.centerPath],
      ["fallout-maw-craft-link-glass", geometry.centerPath],
      ["fallout-maw-craft-link-highlight", geometry.centerPath]
    ]) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.classList.add(className);
      path.setAttribute("d", pathData);
      group.appendChild(path);
    }
    if (geometry.start?.socketPath) {
      const socket = document.createElementNS("http://www.w3.org/2000/svg", "path");
      socket.classList.add("fallout-maw-craft-link-socket");
      socket.setAttribute("d", geometry.start.socketPath);
      group.appendChild(socket);
    }
    if (geometry.end?.socketPath) {
      const socket = document.createElementNS("http://www.w3.org/2000/svg", "path");
      socket.classList.add("fallout-maw-craft-link-socket");
      socket.setAttribute("d", geometry.end.socketPath);
      group.appendChild(socket);
    }
    svg.appendChild(group);
  }

  #updateCraftRecipe({ nodes = null, links = null, viewport = null } = {}) {
    const updateData = {};
    const recipes = getCraftRecipeEntries(this.item);
    const recipeId = resolveCraftRecipeId(this.item, this.#craftRecipeId);
    const index = Math.max(0, recipes.findIndex(recipe => recipe.id === recipeId));
    const recipe = cloneCraftRecipeEntry(recipes[index] ?? recipes[0]);
    const mode = getActiveCraftMode(this.item);
    const current = mode === CRAFT_MODE_DISASSEMBLY ? recipe.disassembly : recipe;
    if (nodes || links) {
      const normalized = normalizeCraftRecipeParts(
        nodes ? nodes.map(normalizeCraftNode) : getCraftNodesWithRoot(this.item),
        links ? links.map(normalizeCraftLink) : getCraftLinks(this.item)
      );
      if (nodes) current.nodes = normalized.nodes;
      if (nodes || links) current.links = normalized.links;
    }
    if (viewport) current.viewport = normalizeCraftViewport(viewport);
    if (mode === CRAFT_MODE_DISASSEMBLY) recipe.disassembly = current;

    recipes[index] = recipe;
    updateData["system.craft.recipes"] = recipes;
    if (recipe.id === DEFAULT_CRAFT_RECIPE_ID) {
      updateData["system.craft.nodes"] = recipe.nodes;
      updateData["system.craft.links"] = recipe.links;
      updateData["system.craft.viewport"] = recipe.viewport;
      updateData["system.craft.disassembly"] = recipe.disassembly;
    }
    return this.item.update(updateData);
  }

  #normalizeLegacyCraftBends() {
    const svg = this.element?.querySelector("[data-craft-links]");
    if (!svg) return undefined;
    const rect = svg.getBoundingClientRect();
    if (!svg.getClientRects().length || rect.width <= 0 || rect.height <= 0) return undefined;
    const links = getCraftLinks(this.item);
    if (!links.some(link => isLegacyCraftBend(link))) return undefined;
    return this.#updateCraftRecipe({
      links: links.map(link => (
        isLegacyCraftBend(link) ? { ...link, ...craftSvgPointToStoredBend(svg, getRawCraftLinkBend(link)) } : link
      ))
    });
  }

  #positionCraftPopover() {
    const workspace = this.element?.querySelector("[data-craft-workspace]");
    const popover = workspace?.querySelector("[data-craft-popover]");
    if (!workspace || !popover || popover.hidden) return;
    const workspaceRect = workspace.getBoundingClientRect();
    const target = this.#getCraftPopoverTargetElement(workspace);
    if (!target) return;
    const targetRect = target.getBoundingClientRect();
    const preferredLeft = targetRect.right - workspaceRect.left + 12;
    const preferredTop = targetRect.top - workspaceRect.top;
    const popoverWidth = popover.offsetWidth || 220;
    const popoverHeight = popover.offsetHeight || 160;
    let left = preferredLeft;
    if ((left + popoverWidth + 8) > workspaceRect.width) left = (targetRect.left - workspaceRect.left) - popoverWidth - 12;
    left = Math.max(8, Math.min(workspaceRect.width - popoverWidth - 8, left));
    const top = Math.max(8, Math.min(workspaceRect.height - popoverHeight - 8, preferredTop));
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
  }

  #getCraftPopoverTargetElement(workspace) {
    if (this.#craftSelection?.type === "node") {
      return workspace.querySelector(`[data-craft-node-id="${CSS.escape(this.#craftSelection.id)}"]`);
    }
    if (this.#craftSelection?.type === "block") {
      return workspace.querySelector(`[data-craft-block-frame-id="${CSS.escape(this.#craftSelection.id)}"]`)
        ?? workspace.querySelector(`[data-craft-block-id="${CSS.escape(this.#craftSelection.id)}"]`);
    }
    if (this.#craftSelection?.type === "link") {
      return workspace.querySelector(`[data-craft-link-id="${CSS.escape(this.#craftSelection.id)}"]`);
    }
    if (this.#craftAttachSourceNodeId) {
      return workspace.querySelector(`[data-craft-node-id="${CSS.escape(this.#craftAttachSourceNodeId)}"]`);
    }
    return null;
  }

  #onEquipmentSlotChoice(event) {
    event.preventDefault();
    const key = event.currentTarget.dataset.equipmentSlotChoice;
    if (!key) return;

    const input = this.element.querySelector(`[data-equipment-slot-input="${key}"]`);
    if (!input) return;

    input.checked = !input.checked;
    this.element.querySelectorAll(`[data-equipment-slot-choice="${key}"]`).forEach(button => {
      button.classList.toggle("active", input.checked);
      button.setAttribute("aria-pressed", String(input.checked));
    });
    return this.item.update({ [`system.occupiedSlots.${key}`]: input.checked });
  }

  #onWeaponSlotChoice(event) {
    event.preventDefault();
    const key = event.currentTarget.dataset.weaponSlotChoice;
    if (!key) return;

    const input = this.element.querySelector(`[data-weapon-slot-input="${key}"]`);
    if (!input) return;

    input.checked = !input.checked;
    this.element.querySelectorAll(`[data-weapon-slot-choice="${key}"]`).forEach(button => {
      button.classList.toggle("active", input.checked);
      button.setAttribute("aria-pressed", String(input.checked));
    });
    return this.item.update({ [`system.weaponSlotRequirement.slots.${key}`]: input.checked });
  }

  #onWeaponActionChoice(event) {
    event.preventDefault();
    const key = event.currentTarget.dataset.weaponActionChoice;
    if (!key) return;

    const section = getWeaponFunctionSection(event.currentTarget);
    const path = getWeaponFunctionPath(section);
    const input = section?.querySelector(`[data-weapon-action-input="${key}"]`);
    if (!input) return;

    input.checked = !input.checked;
    event.currentTarget.classList.toggle("active", input.checked);
    event.currentTarget.setAttribute("aria-pressed", String(input.checked));
    return this.item.update({ [`${path}.availableActions.${key}`]: input.checked });
  }

  #onWeaponAttackModeEnabledChange(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    const input = event.currentTarget;
    const section = input.closest("[data-weapon-function-section]");
    const action = input.closest("[data-weapon-action-settings]");
    const path = getWeaponFunctionPath(section);
    const actionKey = String(action?.dataset.weaponActionSettings ?? "");
    const mode = String(input.dataset.weaponAttackModeEnabled ?? "");
    if (!path || !actionKey || !mode) return undefined;

    const modeInputs = Array.from(action.querySelectorAll("[data-weapon-attack-mode-enabled]"));
    const enabledInputs = modeInputs.filter(entry => entry.checked);
    if (!enabledInputs.length) {
      input.checked = true;
      return undefined;
    }

    return this.item.update({ [`${path}.${actionKey}.${mode}.enabled`]: input.checked });
  }

  async #onAddAbilityFunction(event) {
    event.preventDefault();
    const functionPath = this.#getAbilityFunctionPathForEvent(event);
    const functionType = String(event.currentTarget?.dataset?.abilityFunctionType ?? "");
    if (Object.values(ABILITY_FUNCTION_TYPES).includes(functionType)) {
      const functions = this.#getSubmittedAbilityFunctions(functionPath);
      functions.push(createAbilityFunction(functionType));
      return this.#submitCurrentForm({ [functionPath]: functions });
    }
    this.#functionPickerActive = true;
    await this.#submitCurrentForm();
    return this.render();
  }

  async #onChooseAbilityFunction(event) {
    event.preventDefault();
    const functionType = String(event.currentTarget?.value ?? "");
    if (!Object.values(ABILITY_FUNCTION_TYPES).includes(functionType)) return undefined;
    if (functionType === ABILITY_FUNCTION_TYPES.fixed) {
      this.#functionPickerActive = false;
      this.#fixedAbilityFunctionPickerActive = true;
      await this.#submitCurrentForm();
      return this.render();
    }
    const functionPath = this.#getAbilityFunctionPathForEvent(event);
    const functions = this.#getSubmittedAbilityFunctions(functionPath);
    functions.push(createAbilityFunction(functionType));
    this.#functionPickerActive = false;
    this.#fixedAbilityFunctionPickerActive = false;
    return this.#submitCurrentForm({ [functionPath]: functions });
  }

  #onChooseFixedAbilityFunction(event) {
    event.preventDefault();
    const fixedKey = String(event.currentTarget?.value ?? "");
    const abilityFunction = createFixedAbilityFunction(fixedKey);
    if (!abilityFunction) return undefined;
    const functions = this.#getSubmittedAbilityFunctions("system.functions");
    functions.push(abilityFunction);
    this.#functionPickerActive = false;
    this.#fixedAbilityFunctionPickerActive = false;
    return this.#submitCurrentForm({ "system.functions": functions });
  }

  #onFixedAbilityFunctionSearch(event) {
    const query = String(event.currentTarget?.value ?? "").trim().toLocaleLowerCase();
    const select = this.element?.querySelector("[data-choose-fixed-ability-function]");
    select?.querySelectorAll("option").forEach(option => {
      const value = String(option.value ?? "");
      if (!value) return;
      option.hidden = query && !String(option.textContent ?? "").toLocaleLowerCase().includes(query);
    });
  }

  #onAddToTheEndAdvantageSkill(event) {
    event.preventDefault();
    const functionIndex = Number(event.currentTarget?.closest?.("[data-ability-function-row]")?.dataset.functionIndex ?? -1);
    const functionPath = this.#getAbilityFunctionPathForEvent(event);
    const functions = this.#getSubmittedAbilityFunctions(functionPath);
    const entry = functions[functionIndex];
    if (entry?.fixedKey !== ABILITY_FIXED_FUNCTION_KEYS.toTheEnd) return undefined;
    const settings = normalizeToTheEndSettings(entry.fixedSettings);
    settings.advantageSkills.push({ skillKey: getFirstUnusedToTheEndAdvantageSkillKey(settings.advantageSkills), advantageCount: 1 });
    entry.fixedSettings = settings;
    return this.#submitCurrentForm({ [functionPath]: functions });
  }

  #onDeleteToTheEndAdvantageSkill(event) {
    event.preventDefault();
    event.stopPropagation();
    const functionIndex = Number(event.currentTarget?.closest?.("[data-ability-function-row]")?.dataset.functionIndex ?? -1);
    const skillIndex = Number(event.currentTarget?.closest?.("[data-fixed-to-the-end-advantage-skill-row]")?.dataset.rowIndex ?? -1);
    const functionPath = this.#getAbilityFunctionPathForEvent(event);
    const functions = this.#getSubmittedAbilityFunctions(functionPath);
    const entry = functions[functionIndex];
    const settings = normalizeToTheEndSettings(entry?.fixedSettings);
    if (entry?.fixedKey !== ABILITY_FIXED_FUNCTION_KEYS.toTheEnd || settings.advantageSkills.length <= 1 || skillIndex < 0) return undefined;
    settings.advantageSkills.splice(skillIndex, 1);
    entry.fixedSettings = settings;
    return this.#submitCurrentForm({ [functionPath]: functions });
  }

  #onDeleteAbilityFunction(event) {
    event.preventDefault();
    event.stopPropagation();
    const row = event.currentTarget?.closest?.("[data-ability-function-row]");
    const functionId = String(row?.dataset.functionId ?? "");
    const rowIndex = Number(row?.dataset.functionIndex ?? -1);
    const functionPath = this.#getAbilityFunctionPathForEvent(event);
    const functions = this.#getSubmittedAbilityFunctions(functionPath);
    const index = functionId
      ? functions.findIndex(entry => entry.id === functionId)
      : rowIndex;
    if (index < 0) return undefined;
    functions.splice(index, 1);
    return this.#submitCurrentForm({ [functionPath]: functions });
  }

  #onAddAbilityChange(event) {
    event.preventDefault();
    const functionIndex = Number(event.currentTarget?.closest?.("[data-ability-function-row]")?.dataset.functionIndex ?? -1);
    const functionPath = this.#getAbilityFunctionPathForEvent(event);
    const functions = this.#getSubmittedAbilityFunctions(functionPath);
    if (!functions[functionIndex]) return undefined;
    if (![ABILITY_FUNCTION_TYPES.effectChanges, ABILITY_FUNCTION_TYPES.activeApplication, ABILITY_FUNCTION_TYPES.acquisitionChanges].includes(functions[functionIndex].type)) return undefined;
    functions[functionIndex].changes.push(createAbilityChange());
    return this.#submitCurrentForm({ [functionPath]: functions });
  }

  #onDeleteAbilityChange(event) {
    event.preventDefault();
    event.stopPropagation();
    const functionIndex = Number(event.currentTarget?.closest?.("[data-ability-function-row]")?.dataset.functionIndex ?? -1);
    const changeIndex = Number(event.currentTarget?.closest?.("[data-ability-change-row]")?.dataset.changeIndex ?? -1);
    const functionPath = this.#getAbilityFunctionPathForEvent(event);
    const functions = this.#getSubmittedAbilityFunctions(functionPath);
    if (!functions[functionIndex]?.changes?.[changeIndex]) return undefined;
    functions[functionIndex].changes.splice(changeIndex, 1);
    return this.#submitCurrentForm({ [functionPath]: functions });
  }

  #onAddAbilityCondition(event) {
    event.preventDefault();
    const functionIndex = Number(event.currentTarget?.closest?.("[data-ability-function-row]")?.dataset.functionIndex ?? -1);
    const functionPath = this.#getAbilityFunctionPathForEvent(event);
    const functions = this.#getSubmittedAbilityFunctions(functionPath);
    if (!functions[functionIndex]) return undefined;
    if (![ABILITY_FUNCTION_TYPES.effectChanges, ABILITY_FUNCTION_TYPES.activeApplication, ABILITY_FUNCTION_TYPES.acquisitionChanges].includes(functions[functionIndex].type)) return undefined;
    functions[functionIndex].conditions.push(createAbilityCondition(""));
    return this.#submitCurrentForm({ [functionPath]: functions });
  }

  #onAddAbilityConditionAlternative(event) {
    event.preventDefault();
    const functionIndex = Number(event.currentTarget?.closest?.("[data-ability-function-row]")?.dataset.functionIndex ?? -1);
    const conditionIndex = Number(event.currentTarget?.closest?.("[data-ability-condition-row]")?.dataset.conditionIndex ?? -1);
    const functionPath = this.#getAbilityFunctionPathForEvent(event);
    const functions = this.#getSubmittedAbilityFunctions(functionPath);
    const conditions = functions[functionIndex]?.conditions;
    const condition = conditions?.[conditionIndex];
    if (!condition) return undefined;

    const groupId = String(condition.groupId ?? "").trim() || foundry.utils.randomID();
    condition.groupId = groupId;
    conditions.splice(conditionIndex + 1, 0, createAbilityCondition({ type: "", groupId }));
    return this.#submitCurrentForm({ [functionPath]: functions });
  }

  #onDeleteAbilityCondition(event) {
    event.preventDefault();
    event.stopPropagation();
    const functionIndex = Number(event.currentTarget?.closest?.("[data-ability-function-row]")?.dataset.functionIndex ?? -1);
    const conditionIndex = Number(event.currentTarget?.closest?.("[data-ability-condition-row]")?.dataset.conditionIndex ?? -1);
    const functionPath = this.#getAbilityFunctionPathForEvent(event);
    const functions = this.#getSubmittedAbilityFunctions(functionPath);
    if (!functions[functionIndex]?.conditions?.[conditionIndex]) return undefined;
    functions[functionIndex].conditions.splice(conditionIndex, 1);
    return this.#submitCurrentForm({ [functionPath]: functions });
  }

  #onAddAbilityReactionCost(event) {
    event.preventDefault();
    const functionIndex = Number(event.currentTarget?.closest?.("[data-ability-function-row]")?.dataset.functionIndex ?? -1);
    const functionPath = this.#getAbilityFunctionPathForEvent(event);
    const functions = this.#getSubmittedAbilityFunctions(functionPath);
    const entry = functions[functionIndex];
    if (entry?.type !== ABILITY_FUNCTION_TYPES.effectChanges) return undefined;
    const settings = normalizeEventReactionSettings(entry.reactionSettings);
    settings.costs.push({
      id: foundry.utils.randomID(),
      resourceKey: REACTION_POINTS_RESOURCE_KEY,
      formula: "1"
    });
    entry.reactionSettings = settings;
    return this.#submitCurrentForm({ [functionPath]: functions });
  }

  #onDeleteAbilityReactionCost(event) {
    event.preventDefault();
    event.stopPropagation();
    const functionIndex = Number(event.currentTarget?.closest?.("[data-ability-function-row]")?.dataset.functionIndex ?? -1);
    const costIndex = Number(event.currentTarget?.closest?.("[data-ability-reaction-cost-row]")?.dataset.costIndex ?? -1);
    const functionPath = this.#getAbilityFunctionPathForEvent(event);
    const functions = this.#getSubmittedAbilityFunctions(functionPath);
    const entry = functions[functionIndex];
    if (entry?.type !== ABILITY_FUNCTION_TYPES.effectChanges || costIndex < 0) return undefined;
    const settings = normalizeEventReactionSettings(entry.reactionSettings);
    settings.costs.splice(costIndex, 1);
    entry.reactionSettings = settings;
    return this.#submitCurrentForm({ [functionPath]: functions });
  }

  #onAddAbilityItemUseCategory(event) {
    event.preventDefault();
    const { condition, functions, functionPath } = this.#getAbilityConditionForEvent(event);
    if (!condition) return undefined;

    const categories = normalizeAbilityItemUseCategoryValues(condition.itemCategories);
    const nextCategory = getFirstUnusedAbilityItemUseCategory(categories);
    if (!nextCategory) return undefined;

    condition.itemCategories = [...categories, nextCategory];
    return this.#submitCurrentForm({ [functionPath]: functions });
  }

  #onDeleteAbilityItemUseCategory(event) {
    event.preventDefault();
    event.stopPropagation();
    const { condition, functions, functionPath } = this.#getAbilityConditionForEvent(event);
    const categoryIndex = Number(event.currentTarget?.closest?.("[data-item-use-category-index]")?.dataset.itemUseCategoryIndex ?? -1);
    if (!condition || categoryIndex < 0) return undefined;

    const categories = normalizeAbilityItemUseCategoryValues(condition.itemCategories);
    categories.splice(categoryIndex, 1);
    condition.itemCategories = categories;
    return this.#submitCurrentForm({ [functionPath]: functions });
  }

  #onAbilityItemUseCategoryChange(event) {
    event.preventDefault();
    return this.#submitCurrentForm();
  }

  #onAddAbilityTargetFaction(event) {
    event.preventDefault();
    const { condition, functions, functionPath } = this.#getAbilityConditionForEvent(event);
    if (!condition) return undefined;
    const values = normalizeAbilityConditionValues(condition.targetFactionNames);
    const next = getFirstUnusedAbilityTargetFaction(values);
    if (!next) return undefined;
    condition.targetFactionNames = [...values, next];
    return this.#submitCurrentForm({ [functionPath]: functions });
  }

  #onDeleteAbilityTargetFaction(event) {
    event.preventDefault();
    const { condition, functions, functionPath } = this.#getAbilityConditionForEvent(event);
    const index = Number(event.currentTarget?.closest?.("[data-target-faction-index]")?.dataset.targetFactionIndex ?? -1);
    if (!condition || index < 0) return undefined;
    const values = normalizeAbilityConditionValues(condition.targetFactionNames);
    values.splice(index, 1);
    condition.targetFactionNames = values;
    return this.#submitCurrentForm({ [functionPath]: functions });
  }

  #onAddAbilityPosture(event) {
    event.preventDefault();
    const { condition, functions, functionPath } = this.#getAbilityConditionForEvent(event);
    if (!condition) return undefined;
    const values = normalizeAbilityConditionValues(condition.postureActions);
    const next = ABILITY_POSTURE_ACTIONS.find(action => !values.includes(action));
    if (!next) return undefined;
    condition.postureActions = [...values, next];
    return this.#submitCurrentForm({ [functionPath]: functions });
  }

  #onDeleteAbilityPosture(event) {
    event.preventDefault();
    const { condition, functions, functionPath } = this.#getAbilityConditionForEvent(event);
    const index = Number(event.currentTarget?.closest?.("[data-posture-index]")?.dataset.postureIndex ?? -1);
    if (!condition || index < 0) return undefined;
    const values = normalizeAbilityConditionValues(condition.postureActions);
    values.splice(index, 1);
    condition.postureActions = values;
    return this.#submitCurrentForm({ [functionPath]: functions });
  }

  #onAddAbilityCover(event) {
    event.preventDefault();
    const { condition, functions, functionPath } = this.#getAbilityConditionForEvent(event);
    if (!condition) return undefined;
    const values = normalizeAbilityConditionValues(condition.coverKeys);
    const next = getFirstUnusedAbilityCoverKey(values);
    if (!next) return undefined;
    condition.coverKeys = [...values, next];
    return this.#submitCurrentForm({ [functionPath]: functions });
  }

  #onDeleteAbilityCover(event) {
    event.preventDefault();
    const { condition, functions, functionPath } = this.#getAbilityConditionForEvent(event);
    const index = Number(event.currentTarget?.closest?.("[data-cover-index]")?.dataset.coverIndex ?? -1);
    if (!condition || index < 0) return undefined;
    const values = normalizeAbilityConditionValues(condition.coverKeys);
    values.splice(index, 1);
    condition.coverKeys = values;
    return this.#submitCurrentForm({ [functionPath]: functions });
  }

  #onAddAbilityWeaponAction(event) {
    event.preventDefault();
    const { condition, functions, functionPath } = this.#getAbilityConditionForEvent(event);
    if (!condition) return undefined;
    const values = normalizeAbilityConditionValues(condition.weaponActionKeys);
    const next = getFirstUnusedAbilityWeaponActionKey(values);
    if (!next) return undefined;
    condition.weaponActionKeys = [...values, next];
    return this.#submitCurrentForm({ [functionPath]: functions });
  }

  #onDeleteAbilityWeaponAction(event) {
    event.preventDefault();
    const { condition, functions, functionPath } = this.#getAbilityConditionForEvent(event);
    const index = Number(event.currentTarget?.closest?.("[data-weapon-action-index]")?.dataset.weaponActionIndex ?? -1);
    if (!condition || index < 0) return undefined;
    const values = normalizeAbilityConditionValues(condition.weaponActionKeys);
    values.splice(index, 1);
    condition.weaponActionKeys = values;
    return this.#submitCurrentForm({ [functionPath]: functions });
  }

  #onAddAbilityWeaponSkill(event) {
    event.preventDefault();
    const { condition, functions, functionPath } = this.#getAbilityConditionForEvent(event);
    if (!condition) return undefined;
    const values = normalizeAbilityConditionValues(condition.skillKeys);
    const next = getFirstUnusedAbilitySkillKey(values);
    if (!next) return undefined;
    condition.skillKeys = [...values, next];
    return this.#submitCurrentForm({ [functionPath]: functions });
  }

  #onDeleteAbilityWeaponSkill(event) {
    event.preventDefault();
    const { condition, functions, functionPath } = this.#getAbilityConditionForEvent(event);
    const index = Number(event.currentTarget?.closest?.("[data-skill-index]")?.dataset.skillIndex ?? -1);
    if (!condition || index < 0) return undefined;
    const values = normalizeAbilityConditionValues(condition.skillKeys);
    values.splice(index, 1);
    condition.skillKeys = values;
    return this.#submitCurrentForm({ [functionPath]: functions });
  }

  #onAddAbilityWeaponProficiency(event) {
    event.preventDefault();
    const { condition, functions, functionPath } = this.#getAbilityConditionForEvent(event);
    if (!condition) return undefined;
    const values = normalizeAbilityConditionValues(condition.proficiencyKeys);
    const next = getFirstUnusedAbilityProficiencyKey(values);
    if (!next) return undefined;
    condition.proficiencyKeys = [...values, next];
    return this.#submitCurrentForm({ [functionPath]: functions });
  }

  #onDeleteAbilityWeaponProficiency(event) {
    event.preventDefault();
    const { condition, functions, functionPath } = this.#getAbilityConditionForEvent(event);
    const index = Number(event.currentTarget?.closest?.("[data-proficiency-index]")?.dataset.proficiencyIndex ?? -1);
    if (!condition || index < 0) return undefined;
    const values = normalizeAbilityConditionValues(condition.proficiencyKeys);
    values.splice(index, 1);
    condition.proficiencyKeys = values;
    return this.#submitCurrentForm({ [functionPath]: functions });
  }

  #onAddAbilityAuraTargetGroup(event) {
    event.preventDefault();
    const { condition, functions, functionPath } = this.#getAbilityConditionForEvent(event);
    if (!condition) return undefined;
    const values = normalizeAbilityConditionValues(condition.auraTargetGroups).filter(group => ABILITY_AURA_TARGET_GROUPS.includes(group));
    const next = ABILITY_AURA_TARGET_GROUPS.find(group => !values.includes(group));
    if (!next) return undefined;
    condition.auraTargetGroups = [...values, next];
    return this.#submitCurrentForm({ [functionPath]: functions });
  }

  #onDeleteAbilityAuraTargetGroup(event) {
    event.preventDefault();
    const { condition, functions, functionPath } = this.#getAbilityConditionForEvent(event);
    const index = Number(event.currentTarget?.closest?.("[data-aura-target-group-index]")?.dataset.auraTargetGroupIndex ?? -1);
    if (!condition || index < 0) return undefined;
    const values = normalizeAbilityConditionValues(condition.auraTargetGroups).filter(group => ABILITY_AURA_TARGET_GROUPS.includes(group));
    values.splice(index, 1);
    condition.auraTargetGroups = values;
    return this.#submitCurrentForm({ [functionPath]: functions });
  }

  async #onAbilityAuraModeChange(event) {
    event.preventDefault();
    const path = String(event.currentTarget?.name ?? "");
    if (!path) return undefined;
    const updateData = { [path]: event.currentTarget.value };
    if (event.currentTarget.value === ABILITY_AURA_MODES.selfWhenPresent) {
      updateData[path.replace(/\.auraMode$/, ".auraIncludeSelf")] = false;
    }
    await this.#submitCurrentForm(updateData);
    return this.render();
  }

  #getAbilityConditionForEvent(event) {
    const functionIndex = Number(event.currentTarget?.closest?.("[data-ability-function-row]")?.dataset.functionIndex ?? -1);
    const conditionIndex = Number(event.currentTarget?.closest?.("[data-ability-condition-row]")?.dataset.conditionIndex ?? -1);
    const functionPath = this.#getAbilityFunctionPathForEvent(event);
    const functions = this.#getSubmittedAbilityFunctions(functionPath);
    return {
      functionIndex,
      conditionIndex,
      functionPath,
      functions,
      condition: functions[functionIndex]?.conditions?.[conditionIndex]
    };
  }

  #onAddAbilityPenalty(event) {
    event.preventDefault();
    const functionIndex = Number(event.currentTarget?.closest?.("[data-ability-function-row]")?.dataset.functionIndex ?? -1);
    const functionPath = this.#getAbilityFunctionPathForEvent(event);
    const functions = this.#getSubmittedAbilityFunctions(functionPath);
    if (functions[functionIndex]?.type === ABILITY_FUNCTION_TYPES.fixed) return undefined;
    if (functions[functionIndex]?.conditions?.some(condition => condition?.type === ABILITY_CONDITION_TYPES.eventReaction)) return undefined;
    if (!functions[functionIndex]?.conditions?.some(condition => isAbilityRuntimeCondition(condition?.type))) return undefined;
    functions[functionIndex].penalties.push(createAbilityChange());
    return this.#submitCurrentForm({ [functionPath]: functions });
  }

  #onDeleteAbilityPenalty(event) {
    event.preventDefault();
    event.stopPropagation();
    const functionIndex = Number(event.currentTarget?.closest?.("[data-ability-function-row]")?.dataset.functionIndex ?? -1);
    const penaltyIndex = Number(event.currentTarget?.closest?.("[data-ability-penalty-row]")?.dataset.penaltyIndex ?? -1);
    const functionPath = this.#getAbilityFunctionPathForEvent(event);
    const functions = this.#getSubmittedAbilityFunctions(functionPath);
    if (!functions[functionIndex]?.penalties?.[penaltyIndex]) return undefined;
    functions[functionIndex].penalties.splice(penaltyIndex, 1);
    return this.#submitCurrentForm({ [functionPath]: functions });
  }

  async #onAbilityConditionTypeChange(event) {
    event.preventDefault();
    const path = String(event.currentTarget?.name ?? "");
    if (!path) return undefined;
    const updateData = { [path]: event.currentTarget.value };
    if (event.currentTarget?.matches?.("[data-ability-condition-health-target]")) {
      updateData[path.replace(/\.healthTarget$/, ".limbKey")] = ABILITY_HEALTH_LIMB_ALL;
    }
    await this.#submitCurrentForm(updateData);
    return this.render();
  }

  #onAbilityOnlyFreeChange(event) {
    event.preventDefault();
    const checked = Boolean(event.currentTarget?.checked);
    return this.#submitCurrentForm({
      "system.acquisition.onlyFree": checked,
      "system.acquisition.onlyManual": checked ? false : Boolean(this.item.system?.acquisition?.onlyManual)
    });
  }

  #onAbilityOnlyManualChange(event) {
    event.preventDefault();
    const checked = Boolean(event.currentTarget?.checked);
    return this.#submitCurrentForm({
      "system.acquisition.onlyFree": checked ? false : Boolean(this.item.system?.acquisition?.onlyFree),
      "system.acquisition.onlyManual": checked
    });
  }

  #getSubmittedAbilityFunctions(functionPath = "system.functions") {
    if (!this.form) return normalizeAbilityFunctions(foundry.utils.getProperty(this.item, functionPath) ?? []);
    const formData = new FormDataExtended(this.form);
    const submitData = this._processFormData(null, this.form, formData);
    return normalizeAbilityFunctions(foundry.utils.getProperty(submitData, functionPath) ?? foundry.utils.getProperty(this.item, functionPath) ?? []);
  }

  #getAbilityFunctionPathForEvent(event) {
    return String(
      event.currentTarget?.dataset?.functionPath
      ?? event.currentTarget?.closest?.("[data-ability-function-row]")?.dataset?.functionPath
      ?? "system.functions"
    );
  }

  #submitCurrentForm(updateData = {}) {
    if (this.form) return this.submit({ updateData });
    if (Object.keys(updateData).length) return this.item.update(updateData);
    return undefined;
  }

  #onAddItemFunction(event) {
    event.preventDefault();
    this.#functionPickerActive = true;
    return this.render();
  }

  #onChooseItemFunction(event) {
    event.preventDefault();
    const functionKey = String(event.currentTarget?.value ?? "");
    if (!functionKey) return undefined;

    if (functionKey === ITEM_FUNCTIONS.actorContainer) {
      this.#functionPickerActive = false;
      return this.item.update({
        "system.functions.actorContainer.enabled": true,
        "system.functions.actorContainer.slots": [
          createActorContainerSlotData()
        ],
        "system.quantity": 1,
        "system.maxStack": 1
      });
    }

    if (functionKey === ITEM_FUNCTIONS.container) {
      this.#functionPickerActive = false;
      return this.item.update({
        "system.itemFunction": ITEM_FUNCTIONS.container,
        "system.functions.container.enabled": true,
        "system.functions.container.loadReduction": Number(this.item.system?.functions?.container?.loadReduction) || 0,
        "system.functions.container.extraWeaponSlots": Math.max(0, toInteger(this.item.system?.functions?.container?.extraWeaponSlots)),
        "system.quantity": 1,
        "system.maxStack": 1
      });
    }

    if (functionKey === ITEM_FUNCTIONS.damageMitigation) {
      this.#functionPickerActive = false;
      return this.item.update({
        "system.functions.damageMitigation.enabled": true,
        "system.functions.damageMitigation.mode": DAMAGE_MITIGATION_MODES.defense
      });
    }

    if (functionKey === ITEM_FUNCTIONS.damageSource) {
      this.#functionPickerActive = false;
      return this.item.update({
        "system.functions.damageSource": createDefaultDamageSourceFunctionData({ enabled: true })
      });
    }

    if (functionKey === ITEM_FUNCTIONS.energySource) {
      this.#functionPickerActive = false;
      return this.item.update({
        "system.functions.energySource": createDefaultEnergySourceFunctionData({ enabled: true })
      });
    }

    if (functionKey === ITEM_FUNCTIONS.energyConsumer) {
      this.#functionPickerActive = false;
      return this.item.update({
        "system.functions.energyConsumer": createDefaultEnergyConsumerFunctionData({ enabled: true })
      });
    }

    if (functionKey === ITEM_FUNCTIONS.freeSettings) {
      this.#functionPickerActive = false;
      const entries = normalizeAbilityFunctions(this.item.system?.functions?.freeSettings?.entries ?? []);
      if (!entries.length) entries.push(createAbilityFunction(ABILITY_FUNCTION_TYPES.effectChanges));
      return this.item.update({
        "system.functions.freeSettings.enabled": true,
        "system.functions.freeSettings.useConditionWeakening": Boolean(this.item.system?.functions?.freeSettings?.useConditionWeakening),
        "system.functions.freeSettings.entries": entries
      });
    }

    if (functionKey === ITEM_FUNCTIONS.condition) {
      this.#functionPickerActive = false;
      return this.item.update({
        "system.functions.condition.enabled": true,
        "system.functions.condition.value": 0,
        "system.functions.condition.max": 0,
        "system.functions.condition.weakeningThreshold": DEFAULT_CONDITION_WEAKENING_THRESHOLD,
        "system.functions.condition.recoveryMethods": []
      });
    }

    if (functionKey === ITEM_FUNCTIONS.constructPart) {
      this.#functionPickerActive = false;
      return this.item.update({
        "system.functions.constructPart.enabled": true,
        "system.functions.constructPart.partType": "",
        "system.functions.constructPart.aimedDifficultyPercent": 0,
        "system.functions.constructPart.aimedDifficultyBonus": 0,
        "system.functions.constructPart.critical": false,
        "system.functions.constructPart.blockedPeriodicEffects": [],
        "system.functions.constructPart.lossEffects": [],
        "system.functions.constructPart.weaponSets": [],
        "system.functions.constructPart.needs": []
      });
    }

    if (functionKey === ITEM_FUNCTIONS.firstAid) {
      this.#functionPickerActive = false;
      return this.item.update({
        "system.functions.firstAid.enabled": true,
        "system.functions.firstAid.healing": 0,
        "system.functions.firstAid.healingIsPercentage": false,
        "system.functions.firstAid.durationSeconds": 0,
        "system.functions.firstAid.intervalSeconds": 6,
        "system.functions.firstAid.actionPointCost": 0,
        "system.functions.firstAid.maxDistance": 0,
        "system.functions.firstAid.difficulty": 0,
        "system.functions.firstAid.criticalSuccessHealingBonus": 20,
        "system.functions.firstAid.criticalFailureDamageMin": 1,
        "system.functions.firstAid.criticalFailureDamageMax": 10,
        "system.functions.firstAid.charges.value": 1,
        "system.functions.firstAid.charges.max": 1,
        "system.functions.firstAid.needs": [],
        "system.functions.firstAid.limbSelection.count": 0,
        "system.functions.firstAid.limbSelection.value": 0,
        "system.functions.firstAid.removeEffects": [],
        "system.functions.firstAid.changes": [],
        "system.functions.firstAid.withdrawalDurationSeconds": 0,
        "system.functions.firstAid.withdrawalIntervalSeconds": 6,
        "system.functions.firstAid.withdrawal": []
      });
    }

    if (functionKey === ITEM_FUNCTIONS.lightSource) {
      this.#functionPickerActive = false;
      return this.item.update({
        "system.functions.lightSource": createDefaultLightSourceFunctionData({ enabled: true })
      });
    }

    if (functionKey === ITEM_FUNCTIONS.needChange) {
      this.#functionPickerActive = false;
      return this.item.update({
        "system.functions.needChange.enabled": true,
        "system.functions.needChange.charges.value": 1,
        "system.functions.needChange.charges.max": 1,
        "system.functions.needChange.needs": [],
        "system.functions.needChange.damages": [],
        "system.functions.needChange.organismDevelopment": [],
        "system.functions.needChange.healthRecovery": 0,
        "system.functions.needChange.durationSeconds": 0,
        "system.functions.needChange.intervalSeconds": 6,
        "system.functions.needChange.changes": []
      });
    }

    if (functionKey === ITEM_FUNCTIONS.oneTimeUse) {
      this.#functionPickerActive = false;
      return this.item.update({
        "system.functions.oneTimeUse.enabled": true,
        "system.functions.oneTimeUse.repeatApplicationBlocked": false,
        "system.functions.oneTimeUse.changes": [],
        "system.functions.oneTimeUse.recipeItemUuids": []
      });
    }

    if (functionKey === ITEM_FUNCTIONS.trap) {
      this.#functionPickerActive = false;
      return this.item.update({
        "system.functions.trap": createDefaultTrapFunctionData({ enabled: true })
      });
    }

    if (functionKey === ITEM_FUNCTIONS.weapon) {
      this.#functionPickerActive = false;
      return this.item.update({
        "system.functions.weapon": createDefaultWeaponFunctionData({ enabled: true })
      });
    }

    if (functionKey === ITEM_FUNCTIONS.module) {
      this.#functionPickerActive = false;
      return this.item.update({
        "system.functions.module.enabled": true,
        "system.functions.module.name": "",
        "system.functions.module.targetFunction": "weapon",
        "system.functions.module.additionalWeapons": {}
      });
    }

    if (functionKey === ITEM_FUNCTIONS.implant) {
      this.#functionPickerActive = false;
      return this.item.update({
        "system.functions.implant.enabled": true,
        "system.functions.implant.limbKeys": [],
        "system.functions.implant.difficulty": 60,
        "system.functions.implant.skillKey": "doctor"
      });
    }

    if (functionKey === ITEM_FUNCTIONS.prosthesis) {
      this.#functionPickerActive = false;
      return this.item.update({
        "system.functions.prosthesis.enabled": true,
        "system.functions.prosthesis.limbKeys": [],
        "system.functions.prosthesis.blockedPeriodicEffects": [],
        "system.functions.prosthesis.integrationPercent": 0,
        "system.functions.prosthesis.breakShockResistant": false,
        "system.functions.prosthesis.difficulty": 60,
        "system.functions.prosthesis.skillKey": "doctor"
      });
    }

    if (functionKey === ITEM_FUNCTIONS.tool) {
      const toolKey = getSelectedToolFunctionKey(this.item) || getToolSettings()[0]?.key || "";
      if (!toolKey) return undefined;
      this.#functionPickerActive = false;
      return this.item.update(createToolFunctionSelectionUpdate(this.item, toolKey, { enabled: true }));
    }

    const toolKey = getToolKeyFromFunctionKey(functionKey);
    if (toolKey) {
      this.#functionPickerActive = false;
      return this.item.update(createToolFunctionSelectionUpdate(this.item, toolKey, { enabled: true }));
    }

    return undefined;
  }

  #onAddActorContainerSlot(event) {
    event.preventDefault();
    const slots = getActorContainerSlotData(this.item);
    slots.push(createActorContainerSlotData());
    return this.item.update({ "system.functions.actorContainer.slots": slots });
  }

  #onDeleteActorContainerSlot(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.dataset?.deleteActorContainerSlot);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const slots = getActorContainerSlotData(this.item);
    slots.splice(index, 1);
    return this.item.update({ "system.functions.actorContainer.slots": slots });
  }

  #onOpenContainerSpecialGrids(event) {
    event.preventDefault();
    let app = activeContainerSpecialGridApps.get(this.item);
    if (!app) {
      app = new ContainerSpecialGridApplication(this.item);
      activeContainerSpecialGridApps.set(this.item, app);
    }
    return app.render({ force: true });
  }

  #onAddImplantLimb(event) {
    event.preventDefault();
    const current = this.#getSubmittedImplantLimbKeys();
    const choices = buildImplantLimbChoiceEntries(getCreatureOptions(), current);
    const nextKey = choices.find(choice => !current.includes(choice.key))?.key ?? "";
    if (!nextKey) return undefined;
    return this.item.update({ "system.functions.implant.limbKeys": [...current, nextKey] });
  }

  #onDeleteImplantLimb(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.dataset?.deleteImplantLimb);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const current = this.#getSubmittedImplantLimbKeys();
    current.splice(index, 1);
    return this.item.update({ "system.functions.implant.limbKeys": current });
  }

  #onAddProsthesisLimb(event) {
    event.preventDefault();
    const current = this.#getSubmittedProsthesisLimbKeys();
    const choices = buildProsthesisLimbChoiceEntries(getCreatureOptions(), current);
    const nextKey = choices.find(choice => !current.includes(choice.key))?.key ?? "";
    if (!nextKey) return undefined;
    return this.item.update({ "system.functions.prosthesis.limbKeys": [...current, nextKey] });
  }

  #onDeleteProsthesisLimb(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.dataset?.deleteProsthesisLimb);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const current = this.#getSubmittedProsthesisLimbKeys();
    current.splice(index, 1);
    return this.item.update({ "system.functions.prosthesis.limbKeys": current });
  }

  #onAddProsthesisBlockedEffect(event) {
    event.preventDefault();
    const current = this.#getSubmittedProsthesisBlockedEffects();
    const choices = buildProsthesisBlockedEffectChoiceEntries(getDamageTypeSettings(), current);
    const nextKey = choices.find(choice => !current.includes(choice.key))?.key ?? "";
    if (!nextKey) return undefined;
    return this.item.update({ "system.functions.prosthesis.blockedPeriodicEffects": [...current, nextKey] });
  }

  #onDeleteProsthesisBlockedEffect(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.dataset?.deleteProsthesisBlockedEffect);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const current = this.#getSubmittedProsthesisBlockedEffects();
    current.splice(index, 1);
    return this.item.update({ "system.functions.prosthesis.blockedPeriodicEffects": current });
  }

  #onAddConstructPartBlockedEffect(event) {
    event.preventDefault();
    const current = this.#getSubmittedConstructPartBlockedEffects();
    const choices = buildConstructPartBlockedEffectChoiceEntries(getDamageTypeSettings(), current);
    const nextKey = choices.find(choice => !current.includes(choice.key))?.key ?? "";
    if (!nextKey) return undefined;
    return this.item.update({ "system.functions.constructPart.blockedPeriodicEffects": [...current, nextKey] });
  }

  #onDeleteConstructPartBlockedEffect(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.dataset?.deleteConstructPartBlockedEffect);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const current = this.#getSubmittedConstructPartBlockedEffects();
    current.splice(index, 1);
    return this.item.update({ "system.functions.constructPart.blockedPeriodicEffects": current });
  }

  #getSubmittedImplantLimbKeys() {
    if (!this.form) return normalizeImplantLimbKeys(this.item.system?.functions?.implant?.limbKeys);
    const formData = new FormDataExtended(this.form);
    const submitData = this._processFormData(null, this.form, formData);
    return normalizeImplantLimbKeys(
      foundry.utils.getProperty(submitData, "system.functions.implant.limbKeys")
        ?? this.item.system?.functions?.implant?.limbKeys
    );
  }

  #getSubmittedProsthesisLimbKeys() {
    if (!this.form) return normalizeProsthesisLimbKeys(this.item.system?.functions?.prosthesis?.limbKeys);
    const formData = new FormDataExtended(this.form);
    const submitData = this._processFormData(null, this.form, formData);
    return normalizeProsthesisLimbKeys(
      foundry.utils.getProperty(submitData, "system.functions.prosthesis.limbKeys")
        ?? this.item.system?.functions?.prosthesis?.limbKeys
    );
  }

  #getSubmittedProsthesisBlockedEffects() {
    if (!this.form) return normalizeProsthesisBlockedEffects(this.item.system?.functions?.prosthesis?.blockedPeriodicEffects);
    const formData = new FormDataExtended(this.form);
    const submitData = this._processFormData(null, this.form, formData);
    return normalizeProsthesisBlockedEffects(
      foundry.utils.getProperty(submitData, "system.functions.prosthesis.blockedPeriodicEffects")
        ?? this.item.system?.functions?.prosthesis?.blockedPeriodicEffects
    );
  }

  #getSubmittedConstructPartBlockedEffects() {
    if (!this.form) return getConstructPartBlockedEffects(this.item);
    const formData = new FormDataExtended(this.form);
    const submitData = this._processFormData(null, this.form, formData);
    return normalizeConstructPartBlockedEffects(
      foundry.utils.getProperty(submitData, "system.functions.constructPart.blockedPeriodicEffects")
        ?? getConstructPartBlockedEffects(this.item)
    );
  }

  async #onRemoveItemFunction(event) {
    event.preventDefault();
    const functionKey = String(event.currentTarget?.dataset?.removeItemFunction ?? "");
    const functionLabel = getItemFunctionLabel(functionKey);
    const confirmed = await DialogV2.confirm({
      window: {
        title: game.i18n.localize("FALLOUTMAW.Item.DeleteFunction")
      },
      content: `<p>${game.i18n.format("FALLOUTMAW.Item.DeleteFunctionConfirm", { function: functionLabel })}</p>`,
      yes: {
        icon: "fa-solid fa-trash",
        label: game.i18n.localize("FALLOUTMAW.Common.Delete")
      },
      no: {
        label: game.i18n.localize("Cancel")
      },
      rejectClose: false,
      modal: true
    });
    if (!confirmed) return undefined;

    if (functionKey === ITEM_FUNCTIONS.actorContainer) {
      return this.item.update({ "system.functions.actorContainer": globalThis._del });
    }

    if (functionKey === ITEM_FUNCTIONS.container) {
      return this.item.update({
        "system.itemFunction": "",
        "system.functions.container": globalThis._del
      });
    }
    if (functionKey === ITEM_FUNCTIONS.damageMitigation) {
      return this.item.update({ "system.functions.damageMitigation": globalThis._del });
    }
    if (functionKey === ITEM_FUNCTIONS.damageSource) {
      return this.item.update({ "system.functions.damageSource": globalThis._del });
    }
    if (functionKey === ITEM_FUNCTIONS.energySource) {
      return this.item.update({ "system.functions.energySource": globalThis._del });
    }
    if (functionKey === ITEM_FUNCTIONS.energyConsumer) {
      const additionalWeapons = removeWeaponResourceCostTypeFromEntries(
        getAdditionalWeaponFunctionEntries(this.item),
        "energyConsumer"
      );
      const moduleWeapons = removeWeaponResourceCostTypeFromEntries(
        getModuleWeaponFunctionEntries(this.item),
        "energyConsumer"
      );
      const update = { "system.functions.energyConsumer": globalThis._del };
      if (this.item.system?.functions?.lightSource?.enabled) {
        update["system.functions.lightSource.resourceCosts"] = (this.item.system.functions.lightSource.resourceCosts ?? [])
          .filter(cost => cost.type !== "energyConsumer");
      }
      if (this.item.system?.functions?.weapon?.enabled) {
        update["system.functions.weapon"] = removeWeaponResourceCostTypeFromWeaponData(
          this.item.system?.functions?.weapon ?? {},
          "energyConsumer"
        );
      }
      if (additionalWeapons && Object.keys(additionalWeapons).length) {
        update["system.functions.additionalWeapons"] = additionalWeapons;
      }
      if (this.item.system?.functions?.module?.enabled && moduleWeapons && Object.keys(moduleWeapons).length) {
        update["system.functions.module.additionalWeapons"] = moduleWeapons;
      }
      return this.item.update(update);
    }
    if (functionKey === ITEM_FUNCTIONS.freeSettings) {
      return this.item.update({ "system.functions.freeSettings": globalThis._del });
    }
    if (functionKey === ITEM_FUNCTIONS.condition) {
      const additionalWeapons = Object.fromEntries(getAdditionalWeaponFunctionEntries(this.item)
        .map(({ id, data }) => [
          id,
          {
            ...foundry.utils.deepClone(data),
            resourceCosts: (data?.resourceCosts ?? []).filter(cost => cost.type !== "condition")
          }
        ]));
      const update = { "system.functions.condition": globalThis._del };
      if (this.item.system?.functions?.freeSettings?.enabled) {
        update["system.functions.freeSettings.useConditionWeakening"] = false;
      }
      if (this.item.system?.functions?.weapon?.enabled) {
        update["system.functions.weapon.resourceCosts"] = (this.item.system.functions.weapon.resourceCosts ?? [])
          .filter(cost => cost.type !== "condition");
      }
      if (Object.keys(additionalWeapons).length) update["system.functions.additionalWeapons"] = additionalWeapons;
      return this.item.update(update);
    }
    if (functionKey === ITEM_FUNCTIONS.constructPart) {
      return this.item.update({
        "system.functions.constructPart": globalThis._del,
        "system.placement.limbKey": ""
      });
    }
    if (functionKey === ITEM_FUNCTIONS.firstAid) {
      return this.item.update({ "system.functions.firstAid": globalThis._del });
    }
    if (functionKey === ITEM_FUNCTIONS.needChange) {
      return this.item.update({ "system.functions.needChange": globalThis._del });
    }
    if (functionKey === ITEM_FUNCTIONS.oneTimeUse) {
      return this.item.update({ "system.functions.oneTimeUse": globalThis._del });
    }
    if (functionKey === ITEM_FUNCTIONS.lightSource) {
      return this.item.update({ "system.functions.lightSource": globalThis._del });
    }
    if (functionKey === ITEM_FUNCTIONS.trap) {
      return this.item.update({ "system.functions.trap": globalThis._del });
    }
    if (functionKey === ITEM_FUNCTIONS.weapon) {
      return this.item.update({
        "system.functions.weapon": globalThis._del,
        "system.functions.additionalWeapons": globalThis._del
      });
    }
    if (functionKey === ITEM_FUNCTIONS.module) {
      return this.item.update({ "system.functions.module": globalThis._del });
    }
    if (functionKey === ITEM_FUNCTIONS.implant) {
      return this.item.update({
        "system.functions.implant": globalThis._del,
        "system.placement.limbKey": ""
      });
    }
    if (functionKey === ITEM_FUNCTIONS.prosthesis) {
      return this.item.update({
        "system.functions.prosthesis": globalThis._del,
        "system.placement.limbKey": ""
      });
    }
    if (functionKey === ITEM_FUNCTIONS.tool) {
      return this.item.update({ "system.functions.tools": globalThis._del });
    }
    const toolKey = getToolKeyFromFunctionKey(functionKey);
    if (toolKey) {
      const tools = this.item.system?.functions?.tools ?? {};
      const path = Object.keys(tools).length <= 1
        ? "system.functions.tools"
        : `system.functions.tools.${toolKey}`;
      return this.item.update({ [path]: globalThis._del });
    }
    return undefined;
  }

  #onToolFunctionKeyChange(event) {
    event.preventDefault();
    const nextToolKey = String(event.currentTarget?.value ?? "").trim();
    if (!nextToolKey) return undefined;
    const previousToolKey = String(event.currentTarget?.dataset?.toolFunctionKey ?? getSelectedToolFunctionKey(this.item)).trim();
    return this.item.update(createToolFunctionSelectionUpdate(this.item, nextToolKey, {
      enabled: true,
      sourceToolKey: previousToolKey
    }));
  }

  #onAddConstructPartWeaponSet(event) {
    event.preventDefault();
    const weaponSets = getConstructPartWeaponSets(this.item);
    weaponSets.push(createConstructPartWeaponSetData());
    return this.item.update({ "system.functions.constructPart.weaponSets": weaponSets });
  }

  #onDeleteConstructPartWeaponSet(event) {
    event.preventDefault();
    const index = toInteger(event.currentTarget?.dataset?.deleteConstructPartWeaponSet);
    const weaponSets = getConstructPartWeaponSets(this.item);
    if (index < 0 || index >= weaponSets.length) return undefined;
    weaponSets.splice(index, 1);
    return this.item.update({ "system.functions.constructPart.weaponSets": weaponSets });
  }

  #onAddConstructPartLossEffect(event) {
    event.preventDefault();
    const lossEffects = this.#getSubmittedConstructPartLossEffects({ keepEmpty: true });
    lossEffects.push({ key: "", type: "add", value: "0", phase: "initial", priority: null });
    return this.item.update({ "system.functions.constructPart.lossEffects": lossEffects });
  }

  #onDeleteConstructPartLossEffect(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.dataset?.deleteConstructPartLossEffect);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const lossEffects = this.#getSubmittedConstructPartLossEffects({ keepEmpty: true });
    lossEffects.splice(index, 1);
    return this.item.update({ "system.functions.constructPart.lossEffects": lossEffects });
  }

  #onAddConstructPartNeed(event) {
    event.preventDefault();
    const needs = this.#getSubmittedConstructPartNeeds({ keepEmpty: true });
    needs.push(createConstructPartNeedData(needs));
    return this.item.update({ "system.functions.constructPart.needs": needs });
  }

  #onDeleteConstructPartNeed(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.dataset?.deleteConstructPartNeed);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const needs = this.#getSubmittedConstructPartNeeds({ keepEmpty: true });
    needs.splice(index, 1);
    return this.item.update({ "system.functions.constructPart.needs": needs });
  }

  #onOpenConstructPartNeedSettings(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.dataset?.openConstructPartNeedSettings);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const needs = this.#getSubmittedConstructPartNeeds({ keepEmpty: true });
    const need = needs[index];
    if (!need) return undefined;

    return new NeedAdvancedSettingsConfig({
      need,
      onSave: settings => {
        const current = this.#getSubmittedConstructPartNeeds({ keepEmpty: true });
        if (!current[index]) return;
        current[index].settings = settings;
        return this.item.update({ "system.functions.constructPart.needs": current });
      }
    }).render({ force: true });
  }

  async #onConstructPartCriticalChange(event) {
    event.preventDefault();
    event.stopPropagation();
    const critical = Boolean(event.currentTarget?.checked);
    const update = {
      "system.functions.constructPart.critical": critical
    };
    if (critical) update["system.functions.constructPart.lossEffects"] = [];
    await this.item.update(update);
    return this.render({ force: true });
  }

  #getSubmittedConstructPartLossEffects({ keepEmpty = false } = {}) {
    if (!this.form) return normalizeConstructPartLossEffects(this.item.system?.functions?.constructPart?.lossEffects, { keepEmpty });
    const formData = new FormDataExtended(this.form);
    const submitData = this._processFormData(null, this.form, formData);
    return normalizeConstructPartLossEffects(
      foundry.utils.getProperty(submitData, "system.functions.constructPart.lossEffects")
        ?? this.item.system?.functions?.constructPart?.lossEffects,
      { keepEmpty }
    );
  }

  #onAddAdditionalWeaponFunction(event) {
    event.preventDefault();
    const additionalWeapons = Object.fromEntries(getAdditionalWeaponFunctionEntries(this.item)
      .map(({ id, data }) => [id, foundry.utils.deepClone(data)]));
    const id = foundry.utils.randomID();
    additionalWeapons[id] = createDefaultWeaponFunctionData({
      id,
      name: getNextAdditionalWeaponFunctionName(Object.values(additionalWeapons)),
      enabled: true,
      moduleSlots: []
    });
    this.#activeWeaponFunctionTab = getAdditionalWeaponFunctionTabId(id);
    return this.item.update({ "system.functions.additionalWeapons": additionalWeapons });
  }

  #onDeleteAdditionalWeaponFunction(event) {
    event.preventDefault();
    event.stopPropagation();
    const id = String(event.currentTarget?.dataset?.deleteAdditionalWeaponFunction ?? "");
    if (!id) return undefined;
    if (this.#activeWeaponFunctionTab === getAdditionalWeaponFunctionTabId(id)) this.#activeWeaponFunctionTab = ITEM_FUNCTIONS.weapon;
    const path = getAdditionalWeaponFunctionEntries(this.item).length <= 1
      ? "system.functions.additionalWeapons"
      : `system.functions.additionalWeapons.${id}`;
    return this.item.update({ [path]: globalThis._del });
  }

  #onAddModuleWeaponFunction(event) {
    event.preventDefault();
    const moduleWeapons = Object.fromEntries(getModuleWeaponFunctionEntries(this.item)
      .map(({ id, data }) => [id, foundry.utils.deepClone(data)]));
    const id = foundry.utils.randomID();
    moduleWeapons[id] = createDefaultWeaponFunctionData({
      id,
      name: getNextAdditionalWeaponFunctionName(Object.values(moduleWeapons)),
      enabled: true,
      moduleSlots: []
    });
    this.#activeWeaponFunctionTab = getModuleWeaponFunctionTabId(id);
    return this.item.update({ "system.functions.module.additionalWeapons": moduleWeapons });
  }

  #onDeleteModuleWeaponFunction(event) {
    event.preventDefault();
    event.stopPropagation();
    const id = String(event.currentTarget?.dataset?.deleteModuleWeaponFunction ?? "");
    if (!id) return undefined;
    if (this.#activeWeaponFunctionTab === getModuleWeaponFunctionTabId(id)) this.#activeWeaponFunctionTab = ITEM_FUNCTIONS.weapon;
    const path = getModuleWeaponFunctionEntries(this.item).length <= 1
      ? "system.functions.module.additionalWeapons"
      : `system.functions.module.additionalWeapons.${id}`;
    return this.item.update({ [path]: globalThis._del });
  }

  #onSelectWeaponFunctionTab(event) {
    event.preventDefault();
    const tabId = String(event.currentTarget?.dataset?.selectWeaponFunctionTab ?? "");
    if (!tabId || tabId === this.#activeWeaponFunctionTab) return undefined;
    this.#activeWeaponFunctionTab = tabId;
    return this.render({ force: true });
  }

  #onAddWeaponResourceCost(event) {
    event.preventDefault();
    const path = getWeaponFunctionPath(getWeaponFunctionSection(event.currentTarget));
    const weaponData = foundry.utils.getProperty(this.item, path) ?? {};
    const costs = [...(weaponData?.resourceCosts ?? [])];
    const type = getDefaultNewWeaponResourceCostType(
      weaponData,
      hasItemFunction(this.item, ITEM_FUNCTIONS.condition, { ignoreBroken: true }),
      hasItemFunction(this.item, ITEM_FUNCTIONS.energyConsumer, { ignoreBroken: true })
    );
    costs.push({ type, amount: 0 });
    return this.item.update({ [`${path}.resourceCosts`]: costs });
  }

  #onDeleteWeaponResourceCost(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.dataset?.deleteWeaponResourceCost);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const path = getWeaponFunctionPath(getWeaponFunctionSection(event.currentTarget));
    const costs = [...(foundry.utils.getProperty(this.item, path)?.resourceCosts ?? [])];
    const weaponData = foundry.utils.getProperty(this.item, path) ?? {};
    if (isLockedWeaponMagazineResourceCost(weaponData, costs, index)) return undefined;
    costs.splice(index, 1);
    return this.item.update({ [`${path}.resourceCosts`]: costs });
  }

  #onAddWeaponModuleSlot(event) {
    event.preventDefault();
    const path = getWeaponFunctionPath(getWeaponFunctionSection(event.currentTarget));
    const weaponData = foundry.utils.getProperty(this.item, path) ?? {};
    const slots = [...getWeaponModuleSlots(weaponData)];
    slots.push({
      id: foundry.utils.randomID(),
      moduleKey: "",
      itemUuid: "",
      itemData: {}
    });
    return this.item.update({ [`${path}.moduleSlots`]: slots });
  }

  #onWeaponModuleSlotKeyChange(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    const index = Number(event.currentTarget?.dataset?.weaponModuleSlotKeySelect);
    const moduleKey = String(event.currentTarget?.value ?? "").trim();
    if (!Number.isInteger(index) || index < 0 || !moduleKey) return undefined;
    const path = getWeaponFunctionPath(getWeaponFunctionSection(event.currentTarget));
    const slots = [...getWeaponModuleSlots(foundry.utils.getProperty(this.item, path) ?? {})];
    const slot = slots[index];
    if (!slot) return undefined;
    slots[index] = {
      ...slot,
      moduleKey,
      itemUuid: "",
      itemData: {}
    };
    return this.item.update({ [`${path}.moduleSlots`]: slots });
  }

  #onDeleteWeaponModuleSlot(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.dataset?.deleteWeaponModuleSlot);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const path = getWeaponFunctionPath(getWeaponFunctionSection(event.currentTarget));
    const slots = [...getWeaponModuleSlots(foundry.utils.getProperty(this.item, path) ?? {})];
    slots.splice(index, 1);
    return this.item.update({ [`${path}.moduleSlots`]: slots });
  }

  #onWeaponModuleSlotDragOver(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  async #onWeaponModuleSlotDrop(event) {
    event.preventDefault();
    const zone = event.currentTarget;
    const index = Number(zone?.dataset?.weaponModuleSlotDrop);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const data = this.#getDragEventData(event);
    if (data?.type !== "Item") return undefined;
    const droppedItem = data.uuid ? resolveWorldItemSync(data.uuid) : null;
    if (!droppedItem || !isWeaponModuleItem(droppedItem)) return ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Item.WeaponModuleDropInvalid"));

    const path = getWeaponFunctionPath(getWeaponFunctionSection(zone));
    const weaponData = foundry.utils.getProperty(this.item, path) ?? {};
    const slots = [...getWeaponModuleSlots(weaponData)];
    const slot = slots[index];
    if (!slot || !isModuleItemCompatibleWithSlot(droppedItem, slot)) {
      return ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Item.WeaponModuleDropInvalid"));
    }
    const itemData = droppedItem.toObject();
    foundry.utils.setProperty(itemData, "system.quantity", 1);
    slots[index] = {
      ...slot,
      itemUuid: droppedItem.uuid,
      itemData
    };
    return this.item.update({ [`${path}.moduleSlots`]: slots });
  }

  #getDragEventData(event) {
    const cachedPayload = CONFIG.ux.DragDrop?.getPayload?.();
    if (cachedPayload && (typeof cachedPayload === "object")) return cachedPayload;

    try {
      const textEditor = foundry.applications.ux.TextEditor?.implementation ?? globalThis.TextEditor?.implementation ?? globalThis.TextEditor;
      const data = textEditor.getDragEventData(event);
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

  #onAddConditionRecoveryMethod(event) {
    event.preventDefault();
    const methods = [...(this.item.system?.functions?.condition?.recoveryMethods ?? [])];
    const firstTool = getToolSettings().at(0)?.key ?? "";
    methods.push({
      type: "tools",
      toolKey: firstTool,
      toolClass: "D",
      difficulty: 0
    });
    return this.item.update({ "system.functions.condition.recoveryMethods": methods });
  }

  #onDeleteConditionRecoveryMethod(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.dataset?.deleteConditionRecoveryMethod);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const methods = [...(this.item.system?.functions?.condition?.recoveryMethods ?? [])];
    methods.splice(index, 1);
    return this.item.update({ "system.functions.condition.recoveryMethods": methods });
  }

  #onAddFirstAidEffect(event) {
    event.preventDefault();
    const changes = [...(this.item.system?.functions?.firstAid?.changes ?? [])];
    changes.push({ key: "", type: "add", value: "0", phase: "initial", priority: null });
    return this.item.update({ "system.functions.firstAid.changes": changes });
  }

  #onDeleteFirstAidEffect(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.dataset?.deleteFirstAidEffect);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const changes = [...(this.item.system?.functions?.firstAid?.changes ?? [])];
    changes.splice(index, 1);
    return this.item.update({ "system.functions.firstAid.changes": changes });
  }

  #onAddFirstAidWithdrawalEffect(event) {
    event.preventDefault();
    const changes = [...(this.item.system?.functions?.firstAid?.withdrawal ?? [])];
    changes.push({ key: "", type: "add", value: "0", phase: "initial", priority: null });
    return this.item.update({ "system.functions.firstAid.withdrawal": changes });
  }

  #onDeleteFirstAidWithdrawalEffect(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.dataset?.deleteFirstAidWithdrawalEffect);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const changes = [...(this.item.system?.functions?.firstAid?.withdrawal ?? [])];
    changes.splice(index, 1);
    return this.item.update({ "system.functions.firstAid.withdrawal": changes });
  }

  #onAddFirstAidNeed(event) {
    event.preventDefault();
    const source = this.item.system?.functions?.firstAid?.needs ?? [];
    const current = Array.isArray(source)
      ? [...source]
      : Object.entries(source).map(([needKey, value]) => ({ needKey, value }));
    const existing = new Set(current.map(entry => String(entry?.needKey ?? "")));
    const need = getNeedSettings().find(entry => !existing.has(entry.key)) ?? getNeedSettings()[0];
    if (!need) return undefined;
    current.push({ needKey: need.key, value: 0 });
    return this.item.update({ "system.functions.firstAid.needs": current });
  }

  #onDeleteFirstAidNeed(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.dataset?.deleteFirstAidNeed);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const current = [...(this.item.system?.functions?.firstAid?.needs ?? [])];
    current.splice(index, 1);
    return this.item.update({ "system.functions.firstAid.needs": current });
  }

  #onAddNeedChangeNeed(event) {
    event.preventDefault();
    const current = getNeedChangeNeeds(this.item);
    const existing = new Set(current.map(entry => String(entry?.needKey ?? "")));
    const need = buildNeedChangeChoiceGroups(this.item)
      .flatMap(group => group.choices)
      .find(entry => !existing.has(entry.value))
      ?? buildNeedChangeChoiceGroups(this.item).flatMap(group => group.choices)[0];
    if (!need) return undefined;
    current.push({ needKey: need.value, value: 0 });
    return this.item.update({ "system.functions.needChange.needs": current });
  }

  #onDeleteNeedChangeNeed(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.dataset?.deleteNeedChangeNeed);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const current = getNeedChangeNeeds(this.item);
    current.splice(index, 1);
    return this.item.update({ "system.functions.needChange.needs": current });
  }

  #onAddNeedChangeDamage(event) {
    event.preventDefault();
    const current = getNeedChangeDamages(this.item);
    const existing = new Set(current.map(entry => String(entry?.damageTypeKey ?? "")));
    const damageType = getDamageTypeSettings()
      .find(entry => !existing.has(entry.key));
    if (!damageType) return undefined;
    current.push({ damageTypeKey: damageType.key, value: 0 });
    return this.item.update({ "system.functions.needChange.damages": current });
  }

  #onDeleteNeedChangeDamage(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.dataset?.deleteNeedChangeDamage);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const current = getNeedChangeDamages(this.item);
    current.splice(index, 1);
    return this.item.update({ "system.functions.needChange.damages": current });
  }

  #onAddNeedChangeOrganismDevelopment(event) {
    event.preventDefault();
    const current = getNeedChangeOrganismDevelopment(this.item);
    const existing = new Set(current.map(entry => String(entry?.characteristicKey ?? "")));
    const characteristic = getCharacteristicSettings()
      .find(entry => !existing.has(entry.key));
    if (!characteristic) return undefined;
    current.push({ characteristicKey: characteristic.key, value: 0 });
    return this.item.update({ "system.functions.needChange.organismDevelopment": current });
  }

  #onDeleteNeedChangeOrganismDevelopment(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.dataset?.deleteNeedChangeOrganismDevelopment);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const current = getNeedChangeOrganismDevelopment(this.item);
    current.splice(index, 1);
    return this.item.update({ "system.functions.needChange.organismDevelopment": current });
  }

  #onAddNeedChangeEffect(event) {
    event.preventDefault();
    const changes = [...(this.item.system?.functions?.needChange?.changes ?? [])];
    changes.push({ key: "", type: "add", value: "0", phase: "initial", priority: null });
    return this.item.update({ "system.functions.needChange.changes": changes });
  }

  #onDeleteNeedChangeEffect(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.dataset?.deleteNeedChangeEffect);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const changes = [...(this.item.system?.functions?.needChange?.changes ?? [])];
    changes.splice(index, 1);
    return this.item.update({ "system.functions.needChange.changes": changes });
  }

  #onAddOneTimeUseEffect(event) {
    event.preventDefault();
    const changes = [...(this.item.system?.functions?.oneTimeUse?.changes ?? [])];
    changes.push({ key: "", type: "add", value: "0", phase: "initial", priority: null });
    return this.item.update({ "system.functions.oneTimeUse.changes": changes });
  }

  #onDeleteOneTimeUseEffect(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.dataset?.deleteOneTimeUseEffect);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const changes = [...(this.item.system?.functions?.oneTimeUse?.changes ?? [])];
    changes.splice(index, 1);
    return this.item.update({ "system.functions.oneTimeUse.changes": changes });
  }

  #onOneTimeUseRecipeDragOver(event) {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "link";
  }

  async #onOneTimeUseRecipeDrop(event) {
    event.preventDefault();
    event.stopPropagation();
    const droppedItems = await getDroppedWorldItems(event);
    if (!droppedItems.length) return undefined;
    const recipeItems = droppedItems.filter(item => getCraftKnowledgeItemUuid(item) && hasCraftKnowledgeData(item));
    if (!recipeItems.length) {
      return ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Item.OneTimeUseRecipeNoCraft"));
    }

    const recipeItemUuids = this.item.system?.functions?.oneTimeUse?.recipeItemUuids ?? [];
    const index = Number(event.currentTarget?.dataset?.oneTimeUseRecipeIndex);
    return this.item.update({
      "system.functions.oneTimeUse.recipeItemUuids": mergeDroppedUuids(recipeItemUuids, recipeItems, index)
    });
  }

  #onDeleteOneTimeUseRecipe(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.dataset?.deleteOneTimeUseRecipe);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const recipeItemUuids = [...(this.item.system?.functions?.oneTimeUse?.recipeItemUuids ?? [])];
    recipeItemUuids.splice(index, 1);
    return this.item.update({ "system.functions.oneTimeUse.recipeItemUuids": recipeItemUuids });
  }

  #onNeedChangeChargeInputChange(event) {
    event.preventDefault();
    event.stopPropagation();
    const submitData = this.form
      ? this._processFormData(null, this.form, new FormDataExtended(this.form))
      : {};
    const needChange = submitData.system?.functions?.needChange ?? this.item.system?.functions?.needChange ?? {};
    const max = Math.max(1, toInteger(needChange.charges?.max) || 1);
    const value = Math.max(0, Math.min(max, toInteger(needChange.charges?.value)));
    return this.#submitCurrentForm({
      "system.functions.needChange.charges.max": max,
      "system.functions.needChange.charges.value": value
    });
  }

  #onAddFirstAidRemoveEffect(event) {
    event.preventDefault();
    const current = normalizeFirstAidRemoveEffects(this.item.system?.functions?.firstAid?.removeEffects);
    const existing = new Set(current.map(entry => entry.damageTypeKey));
    const damageType = getFirstAidRemovablePeriodicDamageTypes(getDamageTypeSettings())
      .find(entry => !existing.has(entry.key));
    if (!damageType) return undefined;
    current.push({ damageTypeKey: damageType.key });
    return this.item.update({ "system.functions.firstAid.removeEffects": current });
  }

  #onDeleteFirstAidRemoveEffect(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.dataset?.deleteFirstAidRemoveEffect);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const current = normalizeFirstAidRemoveEffects(this.item.system?.functions?.firstAid?.removeEffects);
    current.splice(index, 1);
    return this.item.update({ "system.functions.firstAid.removeEffects": current });
  }

  #onFirstAidChargeInputChange(event) {
    event.preventDefault();
    event.stopPropagation();
    const submitData = this.form
      ? this._processFormData(null, this.form, new FormDataExtended(this.form))
      : {};
    const firstAid = submitData.system?.functions?.firstAid ?? this.item.system?.functions?.firstAid ?? {};
    const max = Math.max(1, toInteger(firstAid.charges?.max) || 1);
    const value = Math.max(0, Math.min(max, toInteger(firstAid.charges?.value)));
    const count = Math.max(0, Math.min(max, toInteger(firstAid.limbSelection?.count)));
    return this.#submitCurrentForm({
      "system.functions.firstAid.charges.max": max,
      "system.functions.firstAid.charges.value": value,
      "system.functions.firstAid.limbSelection.count": count
    });
  }

  #onAddWeaponSpecialProperty(event) {
    event.preventDefault();
    const path = getWeaponFunctionPath(getWeaponFunctionSection(event.currentTarget));
    const properties = normalizeWeaponSpecialProperties(foundry.utils.getProperty(this.item, path)?.specialProperties ?? []);
    properties.push(createDefaultWeaponSpecialPropertyData());
    return this.item.update({ [`${path}.specialProperties`]: properties });
  }

  #getSubmittedConstructPartNeeds({ keepEmpty = false } = {}) {
    if (!this.form) return normalizeConstructPartNeeds(this.item.system?.functions?.constructPart?.needs, { keepEmpty });
    return readConstructPartNeedsFromForm(this.form, this.item.system?.functions?.constructPart?.needs, { keepEmpty });
  }

  #onWeaponSpecialPropertyTypeChange(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    const index = Number(event.currentTarget?.dataset?.weaponSpecialPropertyType);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const type = String(event.currentTarget?.value ?? "").trim();
    const path = getWeaponFunctionPath(getWeaponFunctionSection(event.currentTarget));
    const weaponData = foundry.utils.getProperty(this.item, path) ?? {};
    const properties = normalizeWeaponSpecialProperties(weaponData?.specialProperties ?? []);
    properties[index] = createDefaultWeaponSpecialPropertyData(type, properties[index]);
    return this.item.update({ [`${path}.specialProperties`]: properties });
  }

  #onDeleteWeaponSpecialProperty(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.dataset?.deleteWeaponSpecialProperty);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const path = getWeaponFunctionPath(getWeaponFunctionSection(event.currentTarget));
    const properties = normalizeWeaponSpecialProperties(foundry.utils.getProperty(this.item, path)?.specialProperties ?? []);
    properties.splice(index, 1);
    return this.item.update({ [`${path}.specialProperties`]: properties });
  }

  #onAddWeaponRequirement(event) {
    event.preventDefault();
    const path = getWeaponFunctionPath(getWeaponFunctionSection(event.currentTarget));
    const requirements = [...(foundry.utils.getProperty(this.item, path)?.requirements ?? [])];
    requirements.push({
      type: "characteristic",
      key: getCharacteristicSettings().at(0)?.key ?? "",
      value: 0
    });
    return this.item.update({ [`${path}.requirements`]: requirements });
  }

  #onDeleteWeaponRequirement(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.dataset?.deleteWeaponRequirement);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const path = getWeaponFunctionPath(getWeaponFunctionSection(event.currentTarget));
    const requirements = [...(foundry.utils.getProperty(this.item, path)?.requirements ?? [])];
    requirements.splice(index, 1);
    return this.item.update({ [`${path}.requirements`]: requirements });
  }

  #onWeaponRequirementTypeChange(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    const index = Number(event.currentTarget?.dataset?.weaponRequirementType);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const type = String(event.currentTarget?.value ?? "") === "skill" ? "skill" : "characteristic";
    const path = getWeaponFunctionPath(getWeaponFunctionSection(event.currentTarget));
    const key = type === "skill"
      ? getSkillSettings().at(0)?.key ?? ""
      : getCharacteristicSettings().at(0)?.key ?? "";
    return this.item.update({
      [`${path}.requirements.${index}.type`]: type,
      [`${path}.requirements.${index}.key`]: key
    });
  }

  #onAddWeaponCriticalFailureConsequence(event) {
    event.preventDefault();
    const section = getWeaponFunctionSection(event.currentTarget);
    const path = getWeaponFunctionPath(section);
    const actionKey = String(event.currentTarget?.dataset?.addWeaponCriticalFailureConsequence ?? "");
    if (!actionKey) return undefined;
    const weaponData = foundry.utils.getProperty(this.item, path) ?? {};
    const actionData = weaponData?.[actionKey] ?? {};
    const consequences = [...(actionData.criticalFailureConsequences ?? [])];
    consequences.push({
      type: "extraResourceCost",
      resourceType: getAvailableWeaponResourceTypes(weaponData).at(0) ?? "",
      amount: 0
    });
    return this.item.update({ [`${path}.${actionKey}.criticalFailureConsequences`]: consequences });
  }

  #onDeleteWeaponCriticalFailureConsequence(event) {
    event.preventDefault();
    const section = getWeaponFunctionSection(event.currentTarget);
    const path = getWeaponFunctionPath(section);
    const actionKey = String(event.currentTarget?.dataset?.weaponActionKey ?? "");
    const index = Number(event.currentTarget?.dataset?.deleteWeaponCriticalFailureConsequence);
    if (!actionKey || !Number.isInteger(index) || index < 0) return undefined;
    const actionData = foundry.utils.getProperty(this.item, `${path}.${actionKey}`) ?? {};
    const consequences = [...(actionData.criticalFailureConsequences ?? [])];
    consequences.splice(index, 1);
    return this.item.update({ [`${path}.${actionKey}.criticalFailureConsequences`]: consequences });
  }

  #onAddWeaponDamageType(event) {
    event.preventDefault();
    const section = getWeaponFunctionSection(event.currentTarget);
    const path = getWeaponFunctionPath(section);
    const entries = readWeaponDamageTypeRows(section);
    const damageTypes = getConfigurableDamageTypes(getDamageTypeSettings());
    const existingKeys = new Set(entries.map(entry => entry.key));
    const key = damageTypes.find(type => !existingKeys.has(type.key))?.key
      ?? damageTypes.at(0)?.key
      ?? "firearm";
    const used = entries.reduce((total, entry) => total + clampPercent(entry.percent), 0);
    entries.push({ key, percent: Math.max(0, 100 - used) });
    return this.item.update({ [`${path}.damageTypes`]: entries });
  }

  #onDeleteWeaponDamageType(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.dataset?.deleteWeaponDamageType);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const section = getWeaponFunctionSection(event.currentTarget);
    const path = getWeaponFunctionPath(section);
    const entries = readWeaponDamageTypeRows(section);
    entries.splice(index, 1);
    if (!entries.length) entries.push({ key: "firearm", percent: 100 });
    return this.item.update({ [`${path}.damageTypes`]: entries });
  }

  #onWeaponDamagePercentInput(event) {
    const input = event.currentTarget;
    const section = getWeaponFunctionSection(input);
    const row = input.closest("[data-weapon-damage-type-row]");
    if (!row) return;
    const index = Number(row.dataset.weaponDamageTypeRow);
    if (!Number.isInteger(index)) return;
    row.querySelectorAll("[data-weapon-damage-percent]").forEach(percentInput => {
      if (percentInput !== input) percentInput.value = input.value;
    });
    const entries = normalizeWeaponDamageTypeOverflow(readWeaponDamageTypeRows(section), index);
    writeWeaponDamageTypePercents(section, entries);
  }

  #onWeaponDamagePercentChange(event) {
    event.preventDefault();
    const section = getWeaponFunctionSection(event.currentTarget);
    const path = getWeaponFunctionPath(section);
    const row = event.currentTarget.closest("[data-weapon-damage-type-row]");
    const index = Number(row?.dataset?.weaponDamageTypeRow);
    const entries = normalizeWeaponDamageTypeOverflow(readWeaponDamageTypeRows(section), Number.isInteger(index) ? index : -1);
    writeWeaponDamageTypePercents(section, entries);
    return this.item.update({ [`${path}.damageTypes`]: entries });
  }

  #onAddDamageSourceDamageType(event) {
    event.preventDefault();
    const entries = readDamageSourceDamageTypeRows(this.element);
    const damageTypes = getConfigurableDamageTypes(getDamageTypeSettings());
    const existingKeys = new Set(entries.map(entry => entry.key));
    const key = damageTypes.find(type => !existingKeys.has(type.key))?.key
      ?? damageTypes.at(0)?.key
      ?? "firearm";
    const used = entries.reduce((total, entry) => total + clampPercent(entry.percent), 0);
    entries.push({ key, percent: Math.max(0, 100 - used) });
    return this.item.update({ "system.functions.damageSource.damageTypes": entries });
  }

  #onDeleteDamageSourceDamageType(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.dataset?.deleteDamageSourceDamageType);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const entries = readDamageSourceDamageTypeRows(this.element);
    entries.splice(index, 1);
    if (!entries.length) entries.push({ key: "firearm", percent: 100 });
    return this.item.update({ "system.functions.damageSource.damageTypes": entries });
  }

  #onDamageSourcePercentInput(event) {
    const input = event.currentTarget;
    const row = input.closest("[data-damage-source-type-row]");
    if (!row) return;
    const index = Number(row.dataset.damageSourceTypeRow);
    if (!Number.isInteger(index)) return;
    row.querySelectorAll("[data-damage-source-percent]").forEach(percentInput => {
      if (percentInput !== input) percentInput.value = input.value;
    });
    const entries = normalizeWeaponDamageTypeOverflow(readDamageSourceDamageTypeRows(this.element), index);
    writeDamageSourceTypePercents(this.element, entries);
  }

  #onDamageSourcePercentChange(event) {
    event.preventDefault();
    const row = event.currentTarget.closest("[data-damage-source-type-row]");
    const index = Number(row?.dataset?.damageSourceTypeRow);
    const entries = normalizeWeaponDamageTypeOverflow(readDamageSourceDamageTypeRows(this.element), Number.isInteger(index) ? index : -1);
    writeDamageSourceTypePercents(this.element, entries);
    return this.item.update({ "system.functions.damageSource.damageTypes": entries });
  }

  #onAddDamageSourceVolleyRegionDamage(event) {
    event.preventDefault();
    const entries = readDamageSourceVolleyRegionDamageRows(this.element);
    const damageTypes = getConfigurableDamageTypes(getDamageTypeSettings());
    const existingKeys = new Set(entries.map(entry => entry.damageTypeKey));
    const damageTypeKey = damageTypes.find(type => !existingKeys.has(type.key))?.key
      ?? damageTypes.at(0)?.key
      ?? "firearm";
    entries.push({ damageTypeKey, amount: "0" });
    return this.item.update({ "system.functions.damageSource.volley.regionDamageEntries": entries });
  }

  #onDeleteDamageSourceVolleyRegionDamage(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.dataset?.deleteDamageSourceVolleyRegionDamage);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const entries = readDamageSourceVolleyRegionDamageRows(this.element);
    entries.splice(index, 1);
    return this.item.update({ "system.functions.damageSource.volley.regionDamageEntries": entries });
  }

  #onAddTrapDamageType(event) {
    event.preventDefault();
    const entries = readTrapDamageTypeRows(this.element);
    const damageTypes = getConfigurableDamageTypes(getDamageTypeSettings());
    const existingKeys = new Set(entries.map(entry => entry.key));
    const key = damageTypes.find(type => !existingKeys.has(type.key))?.key
      ?? damageTypes.at(0)?.key
      ?? "firearm";
    entries.push({ key, percent: 0 });
    return this.item.update({ "system.functions.trap.effect.damageTypes": normalizeWeaponDamageTypeOverflow(entries, entries.length - 1) });
  }

  #onDeleteTrapDamageType(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.dataset?.deleteTrapDamageType);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const entries = readTrapDamageTypeRows(this.element);
    entries.splice(index, 1);
    return this.item.update({ "system.functions.trap.effect.damageTypes": entries.length ? entries : [{ key: "firearm", percent: 100 }] });
  }

  #onTrapDamagePercentInput(event) {
    const input = event.currentTarget;
    const row = input.closest("[data-trap-damage-type-row]");
    if (!row) return;
    const index = Number(row.dataset.trapDamageTypeRow);
    if (!Number.isInteger(index)) return;
    const entries = normalizeWeaponDamageTypeOverflow(readTrapDamageTypeRows(this.element), index);
    writeTrapDamageTypePercents(this.element, entries);
  }

  #onTrapDamagePercentChange(event) {
    event.preventDefault();
    const row = event.currentTarget.closest("[data-trap-damage-type-row]");
    const index = Number(row?.dataset?.trapDamageTypeRow);
    const entries = normalizeWeaponDamageTypeOverflow(readTrapDamageTypeRows(this.element), Number.isInteger(index) ? index : -1);
    writeTrapDamageTypePercents(this.element, entries);
    return this.item.update({ "system.functions.trap.effect.damageTypes": entries });
  }

  #onAddTrapRegionDamage(event) {
    event.preventDefault();
    const entries = readTrapRegionDamageRows(this.element);
    const damageTypes = getConfigurableDamageTypes(getDamageTypeSettings());
    const existingKeys = new Set(entries.map(entry => entry.damageTypeKey));
    const damageTypeKey = damageTypes.find(type => !existingKeys.has(type.key))?.key
      ?? damageTypes.at(0)?.key
      ?? "firearm";
    entries.push({ damageTypeKey, amount: "0" });
    return this.item.update({ "system.functions.trap.effect.regionDamageEntries": entries });
  }

  #onDeleteTrapRegionDamage(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.dataset?.deleteTrapRegionDamage);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const entries = readTrapRegionDamageRows(this.element);
    entries.splice(index, 1);
    return this.item.update({ "system.functions.trap.effect.regionDamageEntries": entries });
  }

  #getSubmittedTrapDetectionConditions() {
    if (!this.form) {
      return normalizeTrapDetectionConditions(this.item.system?.functions?.trap?.detection?.conditions);
    }
    const formData = new FormDataExtended(this.form);
    const submitData = this._processFormData(null, this.form, formData);
    return normalizeTrapDetectionConditions(
      foundry.utils.getProperty(submitData, "system.functions.trap.detection.conditions")
      ?? this.item.system?.functions?.trap?.detection?.conditions
    );
  }

  #onAddTrapDetectionCondition(event) {
    event.preventDefault();
    const conditions = this.#getSubmittedTrapDetectionConditions();
    if (!canAddTrapDetectionCondition(conditions)) return undefined;
    conditions.push(createTrapDetectionCondition());
    return this.#submitCurrentForm({ "system.functions.trap.detection.conditions": conditions });
  }

  #onDeleteTrapDetectionCondition(event) {
    event.preventDefault();
    event.stopPropagation();
    const index = Number(event.currentTarget?.closest?.("[data-trap-detection-condition-row]")?.dataset.trapDetectionConditionRow ?? -1);
    const conditions = this.#getSubmittedTrapDetectionConditions();
    if (!conditions[index]) return undefined;
    conditions.splice(index, 1);
    return this.#submitCurrentForm({ "system.functions.trap.detection.conditions": conditions });
  }

  #onTrapDetectionConditionTypeChange(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    const index = Number(event.currentTarget?.closest?.("[data-trap-detection-condition-row]")?.dataset.trapDetectionConditionRow ?? -1);
    const conditions = this.#getSubmittedTrapDetectionConditions();
    const condition = conditions[index];
    if (!condition) return undefined;
    const type = String(event.currentTarget?.value ?? "");
    conditions[index] = createTrapDetectionCondition(type, { id: condition.id });
    return this.#submitCurrentForm({ "system.functions.trap.detection.conditions": conditions });
  }

  #onAddTrapLightingThreshold(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.closest?.("[data-trap-detection-condition-row]")?.dataset.trapDetectionConditionRow ?? -1);
    const conditions = this.#getSubmittedTrapDetectionConditions();
    const condition = conditions[index];
    if (condition?.type !== TRAP_DETECTION_LIGHTING_CONDITION) return undefined;
    condition.thresholds.push({ illuminationPercent: 0, difficultyBonus: 0 });
    return this.#submitCurrentForm({ "system.functions.trap.detection.conditions": conditions });
  }

  #onDeleteTrapLightingThreshold(event) {
    event.preventDefault();
    event.stopPropagation();
    const conditionIndex = Number(event.currentTarget?.closest?.("[data-trap-detection-condition-row]")?.dataset.trapDetectionConditionRow ?? -1);
    const thresholdIndex = Number(event.currentTarget?.closest?.("[data-trap-lighting-threshold-row]")?.dataset.trapLightingThresholdRow ?? -1);
    const conditions = this.#getSubmittedTrapDetectionConditions();
    const condition = conditions[conditionIndex];
    if (condition?.type !== TRAP_DETECTION_LIGHTING_CONDITION || !condition.thresholds[thresholdIndex]) return undefined;
    condition.thresholds.splice(thresholdIndex, 1);
    return this.#submitCurrentForm({ "system.functions.trap.detection.conditions": conditions });
  }

  #onTrapEffectModeChange(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    const mode = String(event.currentTarget?.value ?? "") === "attack" ? "attack" : "explosion";
    return this.item.update({ "system.functions.trap.effect.mode": mode });
  }

  #onWeaponDamageModeChange(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    const section = getWeaponFunctionSection(event.currentTarget);
    const path = getWeaponFunctionPath(section);
    const mode = String(event.currentTarget?.value ?? "") === "source" ? "source" : "manual";
    const weaponData = foundry.utils.getProperty(this.item, path) ?? {};
    const updateData = { [`${path}.damageMode`]: mode };
    if (mode === "source") {
      Object.assign(updateData, buildWeaponMagazineSourceModeUpdates(path, weaponData));
    }
    return this.item.update(updateData);
  }

  #onWeaponMagazineSourceDragOver(event) {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "link";
  }

  async #onWeaponMagazineSourceDrop(event) {
    event.preventDefault();
    event.stopPropagation();
    const section = getWeaponFunctionSection(event.currentTarget);
    const path = getWeaponFunctionPath(section);
    if (!path) return undefined;
    const droppedItems = await getDroppedWorldItems(event);
    if (!droppedItems.length) return undefined;
    const sourceItems = droppedItems.filter(isWorldDamageSourceItem);
    if (!sourceItems.length) {
      ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Item.WeaponReloadSourceWorldOnly"));
      return undefined;
    }
    const weaponData = foundry.utils.getProperty(this.item, path) ?? {};
    const sources = getWeaponMagazineSourceUuids(weaponData);
    const index = Number(event.currentTarget?.dataset?.weaponMagazineSourceIndex);
    const uniqueSources = mergeDroppedUuids(sources, sourceItems, index);
    return this.item.update({
      [`${path}.magazine.sourceItemUuid`]: sourceItems[0].uuid,
      [`${path}.magazine.sourceItemUuids`]: uniqueSources
    });
  }

  #onSelectWeaponMagazineSource(event) {
    event.preventDefault();
    event.stopPropagation();
    const path = getWeaponFunctionPath(getWeaponFunctionSection(event.currentTarget));
    if (!path) return undefined;
    const uuid = String(event.currentTarget?.dataset?.selectWeaponMagazineSource ?? "").trim();
    if (!uuid) return undefined;
    return this.item.update({ [`${path}.magazine.sourceItemUuid`]: uuid });
  }

  #onDeleteWeaponMagazineSource(event) {
    event.preventDefault();
    event.stopPropagation();
    const path = getWeaponFunctionPath(getWeaponFunctionSection(event.currentTarget));
    if (!path) return undefined;
    const index = Number(event.currentTarget?.dataset?.deleteWeaponMagazineSource);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const weaponData = foundry.utils.getProperty(this.item, path) ?? {};
    const sources = getWeaponMagazineSourceUuids(weaponData);
    const removed = sources.splice(index, 1).at(0) ?? "";
    const active = String(weaponData?.magazine?.sourceItemUuid ?? "");
    return this.item.update({
      [`${path}.magazine.sourceItemUuid`]: active === removed ? (sources.at(0) ?? "") : active,
      [`${path}.magazine.sourceItemUuids`]: sources
    });
  }

  #onEnergyConsumerSourceDragOver(event) {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "link";
  }

  async #onEnergyConsumerSourceDrop(event) {
    event.preventDefault();
    event.stopPropagation();
    const droppedItems = await getDroppedWorldItems(event);
    if (!droppedItems.length) return undefined;
    const sourceItems = droppedItems.filter(isWorldEnergySourceItem);
    if (!sourceItems.length) {
      ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Item.EnergySourceWorldOnly"));
      return undefined;
    }
    const item = sourceItems[0];
    const consumerData = this.item.system?.functions?.energyConsumer ?? {};
    const sources = getEnergyConsumerSourceUuids(consumerData);
    const index = Number(event.currentTarget?.dataset?.energyConsumerSourceIndex);
    const uniqueSources = mergeDroppedUuids(sources, sourceItems, index);
    return this.item.update({
      "system.functions.energyConsumer.sourceItemUuid": item.uuid,
      "system.functions.energyConsumer.sourceItemUuids": uniqueSources,
      "system.functions.energyConsumer.installedSource": createInstalledEnergySourceData(item)
    });
  }

  #onSelectEnergyConsumerSource(event) {
    event.preventDefault();
    event.stopPropagation();
    const uuid = String(event.currentTarget?.dataset?.selectEnergyConsumerSource ?? "").trim();
    if (!uuid) return undefined;
    const sourceItem = getEnergyConsumerSourceItem({ sourceItemUuid: uuid });
    return this.item.update({
      "system.functions.energyConsumer.sourceItemUuid": uuid,
      "system.functions.energyConsumer.installedSource": sourceItem ? createInstalledEnergySourceData(sourceItem) : createEmptyInstalledEnergySourceData()
    });
  }

  #onDeleteEnergyConsumerSource(event) {
    event.preventDefault();
    event.stopPropagation();
    const consumerData = this.item.system?.functions?.energyConsumer ?? {};
    const target = String(event.currentTarget?.dataset?.deleteEnergyConsumerSource ?? "");
    if (target === "active") {
      return this.item.update({
        "system.functions.energyConsumer.sourceItemUuid": "",
        "system.functions.energyConsumer.installedSource": createEmptyInstalledEnergySourceData()
      });
    }
    const index = Number(target);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const sources = getEnergyConsumerSourceUuids(consumerData);
    const removed = sources.splice(index, 1).at(0) ?? "";
    const active = String(consumerData?.sourceItemUuid ?? "");
    const installedUuid = String(consumerData?.installedSource?.sourceItemUuid ?? "");
    const removedActive = active === removed || installedUuid === removed;
    return this.item.update({
      "system.functions.energyConsumer.sourceItemUuid": removedActive ? "" : active,
      "system.functions.energyConsumer.sourceItemUuids": sources,
      "system.functions.energyConsumer.installedSource": removedActive ? createEmptyInstalledEnergySourceData() : consumerData?.installedSource
    });
  }

  #onAddLightSourceResourceCost(event) {
    event.preventDefault();
    const costs = [...(this.item.system?.functions?.lightSource?.resourceCosts ?? [])];
    const hasEnergyConsumer = hasItemFunction(this.item, ITEM_FUNCTIONS.energyConsumer, { ignoreBroken: true });
    const hasCondition = hasItemFunction(this.item, ITEM_FUNCTIONS.condition, { ignoreBroken: true });
    costs.push({
      type: hasEnergyConsumer ? "energyConsumer" : (hasCondition ? "condition" : "energyConsumer"),
      amountPerHour: 0
    });
    return this.item.update({ "system.functions.lightSource.resourceCosts": costs });
  }

  #onDeleteLightSourceResourceCost(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.dataset?.deleteLightSourceResourceCost);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const costs = [...(this.item.system?.functions?.lightSource?.resourceCosts ?? [])];
    costs.splice(index, 1);
    return this.item.update({ "system.functions.lightSource.resourceCosts": costs });
  }

  #onAddVolleyRegionDamage(event) {
    event.preventDefault();
    const section = getWeaponFunctionSection(event.currentTarget);
    const path = getWeaponFunctionPath(section);
    const entries = readVolleyRegionDamageRows(section);
    const damageTypes = getConfigurableDamageTypes(getDamageTypeSettings());
    const existingKeys = new Set(entries.map(entry => entry.damageTypeKey));
    const damageTypeKey = damageTypes.find(type => !existingKeys.has(type.key))?.key
      ?? damageTypes.at(0)?.key
      ?? "firearm";
    entries.push({ damageTypeKey, amount: "0" });
    return this.item.update({ [`${path}.volley.regionDamageEntries`]: entries });
  }

  #onDeleteVolleyRegionDamage(event) {
    event.preventDefault();
    const section = getWeaponFunctionSection(event.currentTarget);
    const path = getWeaponFunctionPath(section);
    const index = Number(event.currentTarget?.dataset?.deleteVolleyRegionDamage);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const entries = readVolleyRegionDamageRows(section);
    entries.splice(index, 1);
    return this.item.update({ [`${path}.volley.regionDamageEntries`]: entries });
  }

  async #onBrowseWeaponAttackSound(event) {
    event.preventDefault();
    const section = getWeaponFunctionSection(event.currentTarget);
    const input = section?.querySelector("[data-weapon-attack-sound-input]");
    if (!input) return undefined;
    const picker = new foundry.applications.apps.FilePicker.implementation({
      type: "audio",
      current: input.value ?? "",
      callback: path => {
        input.value = path;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    activateWeaponSoundPickerPreview(picker);
    await picker.browse(undefined, { render: false });
    return picker.render({ force: true });
  }

  async #onBrowseWeaponExplosionSound(event) {
    event.preventDefault();
    const section = getWeaponFunctionSection(event.currentTarget);
    const input = section?.querySelector("[data-weapon-explosion-sound-input]");
    if (!input) return undefined;
    const picker = new foundry.applications.apps.FilePicker.implementation({
      type: "audio",
      current: input.value ?? "",
      callback: path => {
        input.value = path;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    activateWeaponSoundPickerPreview(picker);
    await picker.browse(undefined, { render: false });
    return picker.render({ force: true });
  }

  async #onBrowseTrapTriggerSound(event) {
    event.preventDefault();
    const input = this.element?.querySelector("[data-trap-trigger-sound-input]");
    if (!input) return undefined;
    const picker = new foundry.applications.apps.FilePicker.implementation({
      type: "audio",
      current: input.value ?? "",
      callback: path => {
        input.value = path;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    activateWeaponSoundPickerPreview(picker);
    await picker.browse(undefined, { render: false });
    return picker.render({ force: true });
  }

  #onMitigationLimbSetChoice(event) {
    event.preventDefault();
    const groupId = String(event.currentTarget?.dataset?.mitigationLimbSetChoice ?? "");
    if (!groupId) return undefined;

    const choices = buildDamageMitigationLimbSetChoices(this.item, getCreatureOptions());
    const validIds = new Set(choices.map(choice => choice.id));
    if (!validIds.has(groupId)) return undefined;

    const selected = new Set(getSelectedDamageMitigationLimbSetIds(this.item, choices));
    if (selected.has(groupId)) {
      if (selected.size <= 1) return undefined;
      selected.delete(groupId);
    } else {
      selected.add(groupId);
    }

    return this.item.update({ "system.functions.damageMitigation.limbSetIds": Array.from(selected) });
  }

  #onMitigationFillStart(event) {
    if (event.button !== 0) return;

    const handle = event.currentTarget;
    const input = handle.closest(".fallout-maw-mitigation-cell")?.querySelector("input");
    if (!input) return;

    event.preventDefault();
    event.stopPropagation();
    this.#endMitigationFillDrag(false);

    const originCell = input.closest("[data-mitigation-cell]");
    const cells = this.#getMitigationFillCells();
    if (!originCell || !cells.length) return;

    this.#mitigationFillDrag = {
      pointerId: event.pointerId,
      value: input.value,
      origin: {
        group: String(originCell.dataset.mitigationGroup ?? ""),
        row: Number(originCell.dataset.mitigationRow) || 0,
        column: Number(originCell.dataset.mitigationColumn) || 0
      },
      cells,
      activeInputs: new Set()
    };
    handle.setPointerCapture?.(event.pointerId);
    this.#updateMitigationFillRectangle(originCell);
    document.addEventListener("pointermove", this.#onMitigationFillMove);
    document.addEventListener("pointerup", this.#onMitigationFillEnd);
    document.addEventListener("pointercancel", this.#onMitigationFillCancel);
  }

  #onMitigationFillMove = event => {
    const drag = this.#mitigationFillDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;

    const element = document.elementFromPoint(event.clientX, event.clientY);
    const cell = element?.closest?.("[data-mitigation-cell]");
    if (!cell || !this.element?.contains(cell)) return;

    this.#updateMitigationFillRectangle(cell);
  };

  #onMitigationFillEnd = event => {
    const drag = this.#mitigationFillDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.#endMitigationFillDrag(true);
  };

  #onMitigationFillCancel = event => {
    const drag = this.#mitigationFillDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.#endMitigationFillDrag(false);
  };

  #getMitigationFillCells() {
    return Array.from(this.element?.querySelectorAll("[data-mitigation-cell]") ?? [])
      .map(cell => {
        const input = cell.querySelector("input");
        if (!input) return null;
        return {
          cell,
          input,
          group: String(cell.dataset.mitigationGroup ?? ""),
          row: Number(cell.dataset.mitigationRow) || 0,
          column: Number(cell.dataset.mitigationColumn) || 0,
          originalValue: input.value
        };
      })
      .filter(Boolean);
  }

  #updateMitigationFillRectangle(targetCell) {
    const drag = this.#mitigationFillDrag;
    if (!drag) return;

    const target = {
      group: String(targetCell.dataset.mitigationGroup ?? ""),
      row: Number(targetCell.dataset.mitigationRow) || 0,
      column: Number(targetCell.dataset.mitigationColumn) || 0
    };
    if (target.group !== drag.origin.group) return;
    const minRow = Math.min(drag.origin.row, target.row);
    const maxRow = Math.max(drag.origin.row, target.row);
    const minColumn = Math.min(drag.origin.column, target.column);
    const maxColumn = Math.max(drag.origin.column, target.column);
    const nextActiveInputs = new Set();

    for (const entry of drag.cells) {
      const inRectangle = entry.group === drag.origin.group
        && entry.row >= minRow
        && entry.row <= maxRow
        && entry.column >= minColumn
        && entry.column <= maxColumn;

      if (inRectangle) {
        entry.input.value = drag.value;
        entry.cell.classList.add("fill-target");
        nextActiveInputs.add(entry.input);
      } else {
        entry.input.value = entry.originalValue;
        entry.cell.classList.remove("fill-target");
      }
    }

    drag.activeInputs = nextActiveInputs;
  }

  #endMitigationFillDrag(save) {
    const drag = this.#mitigationFillDrag;
    if (!drag) return;

    document.removeEventListener("pointermove", this.#onMitigationFillMove);
    document.removeEventListener("pointerup", this.#onMitigationFillEnd);
    document.removeEventListener("pointercancel", this.#onMitigationFillCancel);
    this.#mitigationFillDrag = null;

    const inputs = Array.from(drag.activeInputs);
    window.setTimeout(() => {
      for (const input of inputs) input.closest(".fallout-maw-mitigation-cell")?.classList.remove("fill-target");
    }, 180);

    if (!save) {
      for (const entry of drag.cells) entry.input.value = entry.originalValue;
      return;
    }

    if (!inputs.length) return;
    const updateData = {};
    for (const input of inputs) updateData[input.name] = Number(input.value) || 0;
    return this.item.update(updateData);
  }

  #onContainerLoadReductionInput(event) {
    const value = normalizePercentInput(event.currentTarget?.value);
    this.#syncContainerLoadReductionInputs(value);
  }

  #onContainerLoadReductionChange(event) {
    event.preventDefault();
    const value = normalizePercentInput(event.currentTarget?.value);
    this.#syncContainerLoadReductionInputs(value);
    return this.item.update({ "system.functions.container.loadReduction": value });
  }

  #syncContainerLoadReductionInputs(value) {
    this.element?.querySelectorAll("[data-container-load-reduction]").forEach(input => {
      input.value = String(value);
    });
  }
}

class ContainerSpecialGridApplication extends HandlebarsApplicationMixin(ApplicationV2) {
  #item = null;
  #itemUuid = "";
  #formWidth = 1;
  #formHeight = 1;
  #selection = null;
  #panDrag = null;
  #blockDrag = null;
  #viewportOverride = null;
  #resizeObserver = null;
  #hookIds = [];

  static DEFAULT_OPTIONS = {
    classes: ["fallout-maw", "fallout-maw-sheet", "fallout-maw-container-special-grid-window"],
    position: {
      width: 760,
      height: 620
    },
    window: {
      resizable: true
    }
  };

  static PARTS = {
    body: {
      template: TEMPLATES.itemContainerSpecialGrids
    }
  };

  constructor(item, options = {}) {
    super({
      id: `fallout-maw-container-special-grids-${item?.id ?? foundry.utils.randomID()}`,
      ...options
    });
    this.#item = item ?? null;
    this.#itemUuid = String(item?.uuid ?? "");
  }

  get title() {
    const name = String(this.item?.name ?? "");
    return name ? `${game.i18n.localize("FALLOUTMAW.Item.ContainerSpecialGrid")}: ${name}` : game.i18n.localize("FALLOUTMAW.Item.ContainerSpecialGrid");
  }

  get item() {
    if (this.#itemUuid) {
      const item = globalThis.fromUuidSync?.(this.#itemUuid) ?? foundry.utils.fromUuidSync?.(this.#itemUuid);
      if (item?.documentName === "Item" || (globalThis.Item && item instanceof globalThis.Item)) this.#item = item;
    }
    return this.#item;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const item = this.item;
    const blocks = getContainerSpecialGridBlocks(item);
    const viewport = this.#getViewport();
    const baseBlock = getContainerSpecialGridBaseBlock(item);
    const selectedBlock = this.#selection?.type === "base"
      ? { ...baseBlock, isBase: true }
      : blocks.find(block => block.id === this.#selection?.id) ?? null;
    return {
      ...context,
      item,
      form: {
        width: Math.max(1, toInteger(this.#formWidth) || 1),
        height: Math.max(1, toInteger(this.#formHeight) || 1)
      },
      baseBlock: baseBlock
        ? {
          ...baseBlock,
          label: game.i18n.localize("FALLOUTMAW.Item.ContainerSettings"),
          style: buildCraftNodeStyle(baseBlock),
          selected: this.#selection?.type === "base"
        }
        : null,
      blocks: blocks.map(block => ({
        ...block,
        label: `${game.i18n.localize("FALLOUTMAW.Item.ContainerSpecialGridBlock")} ${block.width} x ${block.height}`,
        style: buildCraftNodeStyle(block),
        selected: this.#selection?.type === "block" && this.#selection.id === block.id
      })),
      selectedBlock,
      viewportStyle: `--craft-pan-x: ${Math.round(viewport.x)}px; --craft-pan-y: ${Math.round(viewport.y)}px; --craft-zoom: ${viewport.zoom};`
    };
  }

  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    await this.#ensureBaseAnchorPersisted();
    this.#hookIds = [
      ["updateItem", Hooks.on("updateItem", item => {
        if (item?.uuid !== this.#itemUuid) return;
        this.#item = item;
        if (this.rendered) void this.render({ force: true });
      })],
      ["deleteItem", Hooks.on("deleteItem", item => {
        if (item?.uuid === this.#itemUuid) void this.close();
      })]
    ];
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#activate();
  }

  async _onClose(options) {
    await super._onClose(options);
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    for (const [hook, id] of this.#hookIds) Hooks.off(hook, id);
    this.#hookIds = [];
    if (this.#item) activeContainerSpecialGridApps.delete(this.#item);
  }

  #activate() {
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    const workspace = this.element?.querySelector("[data-container-special-grid-workspace]");
    if (!workspace) return;
    workspace.addEventListener("contextmenu", event => event.preventDefault());
    workspace.addEventListener("pointerdown", event => this.#onWorkspacePointerDown(event));
    workspace.addEventListener("wheel", event => this.#onWheel(event), { passive: false });
    this.element?.querySelector("[data-container-special-grid-add]")?.addEventListener("click", event => this.#onAddBlock(event));
    this.element?.querySelector("[data-container-special-grid-base-id]")?.addEventListener("pointerdown", event => this.#onBasePointerDown(event));
    this.element?.querySelectorAll("[data-container-special-grid-block-id]").forEach(block => {
      block.addEventListener("pointerdown", event => this.#onBlockPointerDown(event));
    });
    this.element?.querySelector("[data-container-special-grid-delete]")?.addEventListener("click", event => this.#onDeleteBlock(event));
    this.element?.querySelectorAll("[data-container-special-grid-selected-width], [data-container-special-grid-selected-height]").forEach(input => {
      input.addEventListener("change", event => this.#onSelectedSizeChange(event));
    });
    this.#syncBlockLayouts();
    this.#setViewportStyle(this.#getViewport().x, this.#getViewport().y, this.#getViewport().zoom);
    this.#positionPopover();
    if (typeof ResizeObserver === "function") {
      this.#resizeObserver = new ResizeObserver(() => {
        this.#syncBlockLayouts();
        this.#positionPopover();
      });
      this.#resizeObserver.observe(workspace);
    }
  }

  #onAddBlock(event) {
    event.preventDefault();
    const widthInput = this.element?.querySelector("[data-container-special-grid-width]");
    const heightInput = this.element?.querySelector("[data-container-special-grid-height]");
    this.#formWidth = Math.max(1, toInteger(widthInput?.value) || 1);
    this.#formHeight = Math.max(1, toInteger(heightInput?.value) || 1);
    const blocks = getContainerSpecialGridBlocks(this.item);
    const block = finalizeContainerSpecialGridBlock({
      id: foundry.utils.randomID(),
      width: this.#formWidth,
      height: this.#formHeight,
      x: 0,
      y: 0
    });
    const position = findNearestFreeCraftNodePosition(block, getContainerSpecialGridBlockers(this.item));
    blocks.push(finalizeContainerSpecialGridBlock({ ...block, ...position }));
    this.#selection = null;
    return this.#updateSpecialGrids({ blocks });
  }

  #onDeleteBlock(event) {
    event.preventDefault();
    const blockId = String(event.currentTarget?.dataset?.containerSpecialGridDelete ?? "");
    if (!blockId) return undefined;
    const blocks = getContainerSpecialGridBlocks(this.item).filter(block => block.id !== blockId);
    if (this.#selection?.id === blockId) this.#selection = null;
    return this.#updateSpecialGrids({ blocks });
  }

  #onWorkspacePointerDown(event) {
    if (event.target?.closest?.(".fallout-maw-craft-popover")) return;
    if (event.button === 0) {
      if (!this.#selection) return;
      event.preventDefault();
      event.stopPropagation();
      this.#selection = null;
      return this.render({ force: true });
    }
    if (event.button !== 2) return;
    event.preventDefault();
    event.stopPropagation();
    this.#startPanDrag(event);
  }

  #onBasePointerDown(event) {
    if (![0, 2].includes(event.button)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.button === 2) {
      this.#startPanDrag(event);
      return;
    }
    this.#selection = { type: "base", id: "__base__" };
    return this.render({ force: true });
  }

  #onBlockPointerDown(event) {
    if (![0, 2].includes(event.button)) return;
    const blockElement = event.currentTarget;
    const blockId = String(blockElement.dataset.containerSpecialGridBlockId ?? "");
    if (!blockId) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.button === 2) {
      this.#startPanDrag(event);
      return;
    }
    const block = getContainerSpecialGridBlocks(this.item).find(entry => entry.id === blockId);
    if (!block) return;
    this.#blockDrag = {
      pointerId: event.pointerId,
      blockId,
      element: blockElement,
      startClientX: event.clientX,
      startClientY: event.clientY,
      previewX: block.x,
      previewY: block.y,
      previewWidth: block.width,
      previewHeight: block.height,
      moved: false
    };
    const onMove = moveEvent => this.#onBlockMove(moveEvent);
    const onUp = upEvent => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      this.#onBlockEnd(upEvent);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
  }

  #startPanDrag(event) {
    const viewport = this.#getViewport();
    this.#panDrag = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: viewport.x,
      startY: viewport.y,
      moved: false
    };
    const onMove = moveEvent => this.#onPanMove(moveEvent);
    const onUp = upEvent => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      this.#onPanEnd(upEvent);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
  }

  #onPanMove(event) {
    const drag = this.#panDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    drag.moved = true;
    this.#setViewportStyle(
      drag.startX + (event.clientX - drag.startClientX),
      drag.startY + (event.clientY - drag.startClientY)
    );
  }

  #onPanEnd(event) {
    const drag = this.#panDrag;
    this.#panDrag = null;
    if (!drag || event.pointerId !== drag.pointerId || !drag.moved) return undefined;
    this.#setViewportStyle(
      Math.round(drag.startX + (event.clientX - drag.startClientX)),
      Math.round(drag.startY + (event.clientY - drag.startClientY))
    );
    return undefined;
  }

  #onWheel(event) {
    if (event.target?.closest?.(".fallout-maw-craft-popover")) return;
    event.preventDefault();
    const workspace = this.element?.querySelector("[data-container-special-grid-workspace]");
    const rect = workspace?.getBoundingClientRect();
    if (!rect) return undefined;
    const viewport = this.#getViewport();
    const factor = Math.exp(-event.deltaY * 0.0015);
    const nextZoom = clampCraftZoom(viewport.zoom * factor);
    if (Math.abs(nextZoom - viewport.zoom) < 0.001) return undefined;
    const pointerX = event.clientX - rect.left - (rect.width / 2);
    const pointerY = event.clientY - rect.top - (rect.height / 2);
    const worldX = (pointerX - viewport.x) / viewport.zoom;
    const worldY = (pointerY - viewport.y) / viewport.zoom;
    this.#setViewportStyle(pointerX - (worldX * nextZoom), pointerY - (worldY * nextZoom), nextZoom);
    return undefined;
  }

  #onBlockMove(event) {
    const drag = this.#blockDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    const dx = event.clientX - drag.startClientX;
    const dy = event.clientY - drag.startClientY;
    if (!drag.moved && Math.hypot(dx, dy) < CRAFT_DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    this.#setDraggingState(drag, true);
    const step = getCraftGridStep(this.element?.querySelector("[data-container-special-grid-workspace]"));
    const zoom = this.#getViewport().zoom;
    const deltaX = Math.round(dx / (step * zoom));
    const deltaY = Math.round(dy / (step * zoom));
    const nodes = getContainerSpecialGridNodesWithBase(this.item);
    const resolved = resolveCraftDragPlacement(nodes, [drag.blockId], { deltaX, deltaY });
    drag.deltaX = resolved.deltaX;
    drag.deltaY = resolved.deltaY;
    this.#showSnapPreview({
      x: drag.previewX + resolved.deltaX,
      y: drag.previewY + resolved.deltaY,
      width: drag.previewWidth,
      height: drag.previewHeight
    });
  }

  #onBlockEnd(event) {
    const drag = this.#blockDrag;
    this.#blockDrag = null;
    if (!drag || event.pointerId !== drag.pointerId) return undefined;
    this.#setDraggingState(drag, false);
    this.#hideSnapPreview();
    if (!drag.moved) {
      this.#selection = { type: "block", id: drag.blockId };
      return this.render({ force: true });
    }
    const deltaX = Number(drag.deltaX) || 0;
    const deltaY = Number(drag.deltaY) || 0;
    const blocks = getContainerSpecialGridBlocks(this.item).map(block => (
      block.id === drag.blockId ? { ...block, x: block.x + deltaX, y: block.y + deltaY } : block
    ));
    this.#selection = null;
    return this.#updateSpecialGrids({ blocks });
  }

  #onSelectedSizeChange(event) {
    event.preventDefault();
    const popover = event.currentTarget?.closest?.("[data-container-special-grid-popover]");
    const widthInput = popover?.querySelector("[data-container-special-grid-selected-width]");
    const heightInput = popover?.querySelector("[data-container-special-grid-selected-height]");
    const id = String(widthInput?.dataset?.containerSpecialGridSelectedWidth || heightInput?.dataset?.containerSpecialGridSelectedHeight || "");
    if (!id) return undefined;
    const width = Math.max(1, toInteger(widthInput?.value) || 1);
    const height = Math.max(1, toInteger(heightInput?.value) || 1);
    const result = resolveContainerSpecialGridSizeChange(this.item, id, width, height);
    if (!result) return undefined;

    if (result.base) {
      return this.item?.update({
        "system.container.columns": result.base.columns,
        "system.container.rows": result.base.rows,
        "system.functions.container.specialGrids.blocks": result.blocks,
        "system.functions.container.specialGrids.baseAnchor": result.baseAnchor
      });
    }

    return this.#updateSpecialGrids({ blocks: result.blocks });
  }

  #getViewport() {
    return this.#viewportOverride ?? getContainerSpecialGridViewport(this.item);
  }

  #setViewportStyle(x, y, zoom = this.#getViewport().zoom) {
    const workspace = this.element?.querySelector("[data-container-special-grid-workspace]");
    const world = this.element?.querySelector("[data-container-special-grid-world]");
    const viewport = clampCraftViewportToVisibleNode(
      normalizeCraftViewport({ x, y, zoom }),
      workspace,
      getContainerSpecialGridNodesWithBase(this.item)
    );
    this.#viewportOverride = viewport;
    workspace?.style.setProperty("--craft-pan-x", `${viewport.x}px`);
    workspace?.style.setProperty("--craft-pan-y", `${viewport.y}px`);
    workspace?.style.setProperty("--craft-zoom", String(viewport.zoom));
    workspace?.style.setProperty("--fallout-maw-craft-scaled-step", `${Math.round(getCraftGridStep(workspace) * viewport.zoom)}px`);
    world?.style.setProperty("--craft-pan-x", `${viewport.x}px`);
    world?.style.setProperty("--craft-pan-y", `${viewport.y}px`);
    world?.style.setProperty("--craft-zoom", String(viewport.zoom));
    return viewport;
  }

  #syncBlockLayouts() {
    this.element?.querySelectorAll("[data-container-special-grid-base-id], [data-container-special-grid-base-frame-id], [data-container-special-grid-block-id], [data-container-special-grid-block-frame-id]").forEach(element => {
      this.#applyBlockLayout(element, {
        x: Number(element.dataset.craftX) || 0,
        y: Number(element.dataset.craftY) || 0,
        width: Number(element.dataset.craftWidth) || 1,
        height: Number(element.dataset.craftHeight) || 1
      });
    });
  }

  #applyBlockLayout(element, { x = 0, y = 0, width = 1, height = 1 } = {}) {
    const metrics = getCraftGridMetrics(this.element?.querySelector("[data-container-special-grid-workspace]"));
    const normalizedWidth = Math.max(1, toInteger(width) || 1);
    const normalizedHeight = Math.max(1, toInteger(height) || 1);
    const widthPx = (normalizedWidth * metrics.cell) + ((normalizedWidth - 1) * metrics.gap);
    const heightPx = (normalizedHeight * metrics.cell) + ((normalizedHeight - 1) * metrics.gap);
    element.style.setProperty("--craft-offset-x", `${(Number(x) || 0) * metrics.step}px`);
    element.style.setProperty("--craft-offset-y", `${(Number(y) || 0) * metrics.step}px`);
    element.style.setProperty("--craft-node-width", `${widthPx}px`);
    element.style.setProperty("--craft-node-height", `${heightPx}px`);
    element.style.setProperty("--craft-node-half-width", `${widthPx / 2}px`);
    element.style.setProperty("--craft-node-half-height", `${heightPx / 2}px`);
  }

  #showSnapPreview(bounds = {}) {
    const preview = this.element?.querySelector("[data-container-special-grid-snap-preview]");
    if (!preview) return;
    this.#applyBlockLayout(preview, bounds);
    preview.removeAttribute("hidden");
  }

  #hideSnapPreview() {
    this.element?.querySelector("[data-container-special-grid-snap-preview]")?.setAttribute("hidden", "");
  }

  #setDraggingState(drag, enabled) {
    const method = enabled ? "add" : "remove";
    drag.element?.classList?.[method]?.("dragging");
    const workspace = this.element?.querySelector("[data-container-special-grid-workspace]");
    workspace?.querySelector(`[data-container-special-grid-block-frame-id="${CSS.escape(drag.blockId)}"]`)?.classList?.[method]?.("dragging");
  }

  #positionPopover() {
    const workspace = this.element?.querySelector("[data-container-special-grid-workspace]");
    const popover = workspace?.querySelector("[data-container-special-grid-popover]");
    if (!workspace || !popover || !this.#selection?.id) return;
    const target = this.#selection.type === "base"
      ? (
        workspace.querySelector(`[data-container-special-grid-base-frame-id="${CSS.escape(this.#selection.id)}"]`)
        ?? workspace.querySelector(`[data-container-special-grid-base-id="${CSS.escape(this.#selection.id)}"]`)
      )
      : (
        workspace.querySelector(`[data-container-special-grid-block-frame-id="${CSS.escape(this.#selection.id)}"]`)
        ?? workspace.querySelector(`[data-container-special-grid-block-id="${CSS.escape(this.#selection.id)}"]`)
      );
    if (!target) return;
    const workspaceRect = workspace.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const popoverWidth = popover.offsetWidth || 220;
    const popoverHeight = popover.offsetHeight || 130;
    let left = targetRect.right - workspaceRect.left + 12;
    if ((left + popoverWidth + 8) > workspaceRect.width) left = (targetRect.left - workspaceRect.left) - popoverWidth - 12;
    left = Math.max(8, Math.min(workspaceRect.width - popoverWidth - 8, left));
    const top = Math.max(8, Math.min(workspaceRect.height - popoverHeight - 8, targetRect.top - workspaceRect.top));
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
  }

  #updateSpecialGrids({ blocks = null, viewport = null } = {}) {
    const updateData = {};
    if (blocks) updateData["system.functions.container.specialGrids.blocks"] = blocks.map(finalizeContainerSpecialGridBlock);
    if (viewport) updateData["system.functions.container.specialGrids.viewport"] = normalizeCraftViewport(viewport);
    if (!Object.keys(updateData).length) return undefined;
    return this.item?.update(updateData);
  }

  async #ensureBaseAnchorPersisted() {
    const item = this.item;
    if (!item || hasPersistedContainerSpecialGridBaseAnchor(item)) return;
    const anchor = computeContainerSpecialGridBaseAnchorSeed(getContainerDimensions(item));
    await item.update({ "system.functions.container.specialGrids.baseAnchor": anchor });
  }
}

function hasSubmittedStackShapeChange(item, submitData = {}) {
  if (!item || !submitData?.system) return false;
  const submittedQuantity = Number(submitData.system.quantity);
  const submittedMaxStack = Number(submitData.system.maxStack);
  return (
    (Number.isFinite(submittedQuantity) && submittedQuantity !== Number(item.system?.quantity))
    || (Number.isFinite(submittedMaxStack) && submittedMaxStack !== Number(item.system?.maxStack))
  );
}

export function registerItemSheetSourceSyncHooks() {
  if (itemSheetSourceSyncHooksRegistered) return;
  itemSheetSourceSyncHooksRegistered = true;
  Hooks.on("updateItem", item => {
    if (!item || item.actor) return;
    if (hasItemFunction(item, ITEM_FUNCTIONS.damageSource)) refreshWeaponSheetsForDamageSource(item.uuid);
    if (hasItemFunction(item, ITEM_FUNCTIONS.energySource)) refreshEnergyConsumerSheetsForSource(item.uuid);
  });
}

function activateWeaponSoundPickerPreview(picker) {
  const bindPreview = () => {
    const files = picker.element?.querySelector?.("[data-files]");
    if (!files || files.dataset.falloutMawWeaponSoundPreview) return;
    files.dataset.falloutMawWeaponSoundPreview = "1";
    files.addEventListener("click", event => {
      const row = event.target?.closest?.("[data-file][data-path]");
      if (!row || !files.contains(row)) return;
      previewWeaponSoundPickerPath(row.dataset.path);
    });
  };
  picker.addEventListener?.("render", bindPreview);
  picker.addEventListener?.("close", stopActiveWeaponSoundPickerPreview, { once: true });
}

async function previewWeaponSoundPickerPath(path = "") {
  const src = String(path ?? "").trim();
  if (!src) return;
  await stopActiveWeaponSoundPickerPreview();
  try {
    activeWeaponSoundPickerPreview = await game.audio?.play?.(src, {
      context: game.audio?.interface,
      loop: false,
      volume: 0.8
    }) ?? null;
  } catch (error) {
    console.warn(`Fallout MaW | Failed to preview weapon sound "${src}".`, error);
  }
}

async function stopActiveWeaponSoundPickerPreview() {
  const sound = activeWeaponSoundPickerPreview;
  activeWeaponSoundPickerPreview = null;
  try {
    await sound?.stop?.();
  } catch (error) {
    console.warn("Fallout MaW | Failed to stop weapon sound preview.", error);
  }
}

function getHealingSkillLabel(item) {
  if (!["trauma", "disease"].includes(item?.type)) return "";
  const key = item.system?.healingSkillKey ?? "";
  return getSkillSettings().find(skill => skill.key === key)?.label ?? key;
}

function buildActorContainerSlotRows(item) {
  return getActorContainerSlotData(item).map((slot, index) => ({
    ...slot,
    index
  }));
}

function getActorContainerSlotData(itemOrData) {
  return (Array.isArray(itemOrData?.system?.functions?.actorContainer?.slots)
    ? itemOrData.system.functions.actorContainer.slots
    : [])
    .map(slot => normalizeActorContainerSlotData(slot));
}

function createActorContainerSlotData() {
  return normalizeActorContainerSlotData({
    id: foundry.utils.randomID(),
    width: 1,
    height: 1,
    quantity: 1
  });
}

function getContainerSpecialGridData(itemOrData = null) {
  const data = itemOrData?.system ?? itemOrData ?? {};
  return data.functions?.container?.specialGrids ?? {};
}

function getContainerSpecialGridViewport(itemOrData = null) {
  return normalizeCraftViewport(getContainerSpecialGridData(itemOrData)?.viewport ?? {});
}

function getContainerSpecialGridBaseBlock(itemOrData = null) {
  const data = itemOrData?.system ?? itemOrData ?? {};
  const width = Math.max(1, toInteger(data.container?.columns) || 1);
  const height = Math.max(1, toInteger(data.container?.rows) || 1);
  const anchor = getContainerSpecialGridBaseAnchor(itemOrData);
  return finalizeContainerSpecialGridBlock({
    id: "__base__",
    x: anchor.left + (width / 2),
    y: anchor.top + (height / 2),
    width,
    height
  });
}

function getContainerSpecialGridNodesWithBase(itemOrData = null) {
  return [
    getContainerSpecialGridBaseBlock(itemOrData),
    ...getContainerSpecialGridBlocks(itemOrData)
  ].filter(Boolean);
}

function getContainerSpecialGridBlockers(itemOrData = null, { excludeBlockIds = new Set() } = {}) {
  const excluded = excludeBlockIds instanceof Set ? excludeBlockIds : new Set(excludeBlockIds ?? []);
  return getContainerSpecialGridNodesWithBase(itemOrData)
    .filter(block => !excluded.has(block.id))
    .map(craftNodeToBounds);
}

function resizeContainerSpecialGridBlockFromTopLeft(block = {}, width, height) {
  const oldWidth = Math.max(1, toInteger(block.width) || 1);
  const oldHeight = Math.max(1, toInteger(block.height) || 1);
  const centerX = Number(block.x) || 0;
  const centerY = Number(block.y) || 0;
  const left = centerX - (oldWidth / 2);
  const top = centerY - (oldHeight / 2);
  const nextWidth = Math.max(1, toInteger(width) || 1);
  const nextHeight = Math.max(1, toInteger(height) || 1);
  return finalizeContainerSpecialGridBlock({
    ...block,
    id: String(block?.id ?? ""),
    x: left + (nextWidth / 2),
    y: top + (nextHeight / 2),
    width: nextWidth,
    height: nextHeight
  });
}

function getContainerSpecialGridPushDelta(bounds, blockers = []) {
  let dx = 0;
  let dy = 0;
  for (const blocker of blockers) {
    if (!craftBoundsOverlap(bounds, blocker)) continue;
    const pushDown = blocker.bottom - bounds.top;
    const pushRight = blocker.right - bounds.left;
    if (pushDown > 0) dy = Math.max(dy, pushDown);
    if (pushRight > 0) dx = Math.max(dx, pushRight);
  }
  return { dx, dy };
}

function getContainerSpecialGridExpansion(oldBounds, newBounds) {
  return {
    grewRight: newBounds.right > oldBounds.right,
    grewBottom: newBounds.bottom > oldBounds.bottom,
    grewTop: newBounds.top < oldBounds.top,
    grewLeft: newBounds.left < oldBounds.left,
    oldBounds,
    newBounds
  };
}

function hasContainerSpecialGridExpansion(expansion) {
  return Boolean(expansion?.grewRight || expansion?.grewBottom || expansion?.grewTop || expansion?.grewLeft);
}

function blockOverlapsContainerSpecialGridExpansion(bounds, expansion) {
  const { oldBounds, newBounds } = expansion;
  if (!hasContainerSpecialGridExpansion(expansion)) return false;
  if (expansion.grewBottom && newBounds.bottom > oldBounds.bottom) {
    const overlapsBottomStrip = bounds.top < newBounds.bottom
      && bounds.bottom > oldBounds.bottom
      && bounds.left < newBounds.right
      && bounds.right > newBounds.left;
    if (overlapsBottomStrip) return true;
  }
  if (expansion.grewTop && newBounds.top < oldBounds.top) {
    const overlapsTopStrip = bounds.bottom > newBounds.top
      && bounds.top < oldBounds.top
      && bounds.left < newBounds.right
      && bounds.right > newBounds.left;
    if (overlapsTopStrip) return true;
  }
  if (expansion.grewRight && newBounds.right > oldBounds.right) {
    const overlapsRightStrip = bounds.left < newBounds.right
      && bounds.right > oldBounds.right
      && bounds.top < newBounds.bottom
      && bounds.bottom > newBounds.top;
    if (overlapsRightStrip) return true;
  }
  if (expansion.grewLeft && newBounds.left < oldBounds.left) {
    const overlapsLeftStrip = bounds.right > newBounds.left
      && bounds.left < oldBounds.left
      && bounds.top < newBounds.bottom
      && bounds.bottom > newBounds.top;
    if (overlapsLeftStrip) return true;
  }
  return false;
}

function getContainerSpecialGridExpansionPushDelta(bounds, expansion) {
  const { oldBounds, newBounds } = expansion;
  let dx = 0;
  let dy = 0;
  if (!blockOverlapsContainerSpecialGridExpansion(bounds, expansion)) return { dx, dy };
  if (expansion.grewBottom && bounds.top < newBounds.bottom) {
    dy = Math.max(dy, newBounds.bottom - bounds.top);
  }
  if (expansion.grewTop && bounds.bottom > newBounds.top) {
    dy = Math.min(dy, oldBounds.top - bounds.bottom);
  }
  if (expansion.grewRight && bounds.left < newBounds.right) {
    dx = Math.max(dx, newBounds.right - bounds.left);
  }
  if (expansion.grewLeft && bounds.right > newBounds.left) {
    dx = Math.min(dx, oldBounds.left - bounds.right);
  }
  return { dx, dy };
}

function getContainerSpecialGridResizePushDelta(nodeBounds, nodeId, blocks, fixedId, expansion) {
  let dx = 0;
  let dy = 0;
  for (const other of blocks) {
    if (other.id === nodeId) continue;
    const otherBounds = craftNodeToBounds(other);
    if (!craftBoundsOverlap(nodeBounds, otherBounds)) continue;
    if (other.id === fixedId) {
      const delta = getContainerSpecialGridExpansionPushDelta(nodeBounds, expansion);
      dx = Math.max(dx, delta.dx);
      dy = Math.max(dy, delta.dy);
      continue;
    }
    const pushDown = otherBounds.bottom - nodeBounds.top;
    const pushRight = otherBounds.right - nodeBounds.left;
    if (pushDown > 0) dy = Math.max(dy, pushDown);
    if (pushRight > 0) dx = Math.max(dx, pushRight);
  }
  return { dx, dy };
}

function resolveContainerSpecialGridPushLayout(nodes = [], fixedId = null, oldFixedBounds = null) {
  let blocks = nodes.map(node => ({ ...node }));
  const movableIds = new Set(
    fixedId === "__base__"
      ? blocks.filter(node => node.id !== "__base__").map(node => node.id)
      : blocks.filter(node => node.id !== fixedId && node.id !== "__base__").map(node => node.id)
  );
  const fixed = blocks.find(node => node.id === fixedId);
  const expansion = fixed && oldFixedBounds
    ? getContainerSpecialGridExpansion(oldFixedBounds, craftNodeToBounds(fixed))
    : null;

  if (!expansion || !hasContainerSpecialGridExpansion(expansion)) {
    return blocks;
  }

  const pushMovableBlocks = () => {
    let changed = false;
    const movable = blocks
      .filter(node => movableIds.has(node.id))
      .sort((a, b) => (a.y - b.y) || (a.x - b.x) || String(a.id).localeCompare(String(b.id)));
    for (const node of movable) {
      const nodeBounds = craftNodeToBounds(node);
      if (!blockOverlapsContainerSpecialGridExpansion(nodeBounds, expansion)
        && !blocks.some(other => other.id !== node.id
          && other.id !== fixedId
          && craftBoundsOverlap(nodeBounds, craftNodeToBounds(other)))) {
        continue;
      }
      const { dx, dy } = getContainerSpecialGridResizePushDelta(nodeBounds, node.id, blocks, fixedId, expansion);
      if (!dx && !dy) continue;
      const index = blocks.findIndex(entry => entry.id === node.id);
      blocks[index] = { ...node, x: node.x + dx, y: node.y + dy };
      changed = true;
    }
    return changed;
  };

  for (let iteration = 0; iteration < 64; iteration += 1) {
    if (!pushMovableBlocks()) break;
  }

  return blocks;
}

function resolveContainerSpecialGridSizeChange(itemOrData = null, blockId = "", width = 1, height = 1) {
  const nextWidth = Math.max(1, toInteger(width) || 1);
  const nextHeight = Math.max(1, toInteger(height) || 1);
  const baseBlock = getContainerSpecialGridBaseBlock(itemOrData);
  const blocks = getContainerSpecialGridBlocks(itemOrData);

  if (blockId === "__base__") {
    const oldBaseBounds = craftNodeToBounds(baseBlock);
    const resizedBase = resizeContainerSpecialGridBlockFromTopLeft(baseBlock, nextWidth, nextHeight);
    const newBaseBounds = craftNodeToBounds(resizedBase);
    const resolved = resolveContainerSpecialGridPushLayout([resizedBase, ...blocks], "__base__", oldBaseBounds);
    return {
      base: { columns: nextWidth, rows: nextHeight },
      baseAnchor: { left: newBaseBounds.left, top: newBaseBounds.top },
      blocks: resolved
        .filter(node => node.id !== "__base__")
        .map(finalizeContainerSpecialGridBlock)
    };
  }

  const current = blocks.find(block => block.id === blockId);
  if (!current) return null;
  const oldBlockBounds = craftNodeToBounds(current);
  const resized = resizeContainerSpecialGridBlockFromTopLeft(current, nextWidth, nextHeight);
  const resolved = resolveContainerSpecialGridPushLayout(
    [baseBlock, ...blocks.map(block => (block.id === blockId ? resized : block))],
    blockId,
    oldBlockBounds
  );
  return {
    blocks: resolved
      .filter(node => node.id !== "__base__")
      .map(finalizeContainerSpecialGridBlock)
  };
}

function normalizeActorContainerSlotData(slot = {}) {
  return {
    id: String(slot?.id ?? "").trim() || foundry.utils.randomID(),
    width: Math.max(1, toInteger(slot?.width) || 1),
    height: Math.max(1, toInteger(slot?.height) || 1),
    quantity: Math.max(0, toInteger(slot?.quantity))
  };
}

function getItemFunctionLabel(functionKey = "") {
  if (functionKey === ITEM_FUNCTIONS.actorContainer) return "Контейнер актеров";
  if (functionKey === ITEM_FUNCTIONS.container) return game.i18n.localize("FALLOUTMAW.Item.FunctionContainer");
  if (functionKey === ITEM_FUNCTIONS.damageMitigation) return game.i18n.localize("FALLOUTMAW.Item.FunctionDamageMitigation");
  if (functionKey === ITEM_FUNCTIONS.damageSource) return game.i18n.localize("FALLOUTMAW.Item.FunctionDamageSource");
  if (functionKey === ITEM_FUNCTIONS.energySource) return game.i18n.localize("FALLOUTMAW.Item.FunctionEnergySource");
  if (functionKey === ITEM_FUNCTIONS.energyConsumer) return game.i18n.localize("FALLOUTMAW.Item.FunctionEnergyConsumer");
  if (functionKey === ITEM_FUNCTIONS.freeSettings) return "Свободная настройка";
  if (functionKey === ITEM_FUNCTIONS.condition) return game.i18n.localize("FALLOUTMAW.Item.FunctionCondition");
  if (functionKey === ITEM_FUNCTIONS.constructPart) return "Деталь конструкта";
  if (functionKey === ITEM_FUNCTIONS.firstAid) return game.i18n.localize("FALLOUTMAW.Item.FunctionFirstAid");
  if (functionKey === ITEM_FUNCTIONS.lightSource) return game.i18n.localize("FALLOUTMAW.Item.FunctionLightSource");
  if (functionKey === ITEM_FUNCTIONS.needChange) return "Изменение потребностей";
  if (functionKey === ITEM_FUNCTIONS.oneTimeUse) return game.i18n.localize("FALLOUTMAW.Item.FunctionOneTimeUse");
  if (functionKey === ITEM_FUNCTIONS.trap) return game.i18n.localize("FALLOUTMAW.Item.FunctionTrap");
  if (functionKey === ITEM_FUNCTIONS.weapon) return game.i18n.localize("FALLOUTMAW.Item.FunctionWeapon");
  if (functionKey === ITEM_FUNCTIONS.module) return game.i18n.localize("FALLOUTMAW.Item.FunctionModule");
  if (functionKey === ITEM_FUNCTIONS.implant) return game.i18n.localize("FALLOUTMAW.Item.FunctionImplant");
  if (functionKey === ITEM_FUNCTIONS.prosthesis) return game.i18n.localize("FALLOUTMAW.Item.FunctionProsthesis");
  if (functionKey === ITEM_FUNCTIONS.tool) return game.i18n.localize("FALLOUTMAW.Item.FunctionTool");
  const toolKey = getToolKeyFromFunctionKey(functionKey);
  if (toolKey) return getToolSettings().find(tool => tool.key === toolKey)?.label ?? toolKey;
  return game.i18n.localize("FALLOUTMAW.Item.Function");
}

function buildConstructPartWeaponSetRows(item) {
  return getConstructPartWeaponSets(item).map((entry, index) => ({
    ...entry,
    index,
    label: entry.label,
    quantity: entry.quantity
  }));
}

function getConstructPartWeaponSets(itemOrData) {
  return (Array.isArray(itemOrData?.system?.functions?.constructPart?.weaponSets)
    ? itemOrData.system.functions.constructPart.weaponSets
    : [])
    .map(entry => normalizeConstructPartWeaponSetData(entry));
}

function createConstructPartWeaponSetData() {
  return normalizeConstructPartWeaponSetData({
    id: foundry.utils.randomID(),
    label: "",
    quantity: 1
  });
}

function normalizeConstructPartWeaponSetData(entry = {}) {
  return {
    id: String(entry?.id ?? "").trim() || foundry.utils.randomID(),
    label: String(entry?.label ?? "").trim(),
    quantity: Math.max(0, toInteger(entry?.quantity ?? 1))
  };
}

function buildConstructPartLossEffectRows(item) {
  return normalizeConstructPartLossEffects(item.system?.functions?.constructPart?.lossEffects, { keepEmpty: true })
    .map((effect, index) => prepareConstructPartLossEffectRow(effect, index));
}

function buildConstructPartNeedRows(item) {
  return normalizeConstructPartNeeds(item.system?.functions?.constructPart?.needs, { keepEmpty: true })
    .map((need, index) => ({ ...need, index }));
}

function readConstructPartNeedsFromForm(form, currentValue = [], { keepEmpty = false } = {}) {
  const current = normalizeConstructPartNeeds(currentValue, { keepEmpty: true });
  return Array.from(form?.querySelectorAll("[data-construct-part-need-row]") ?? [])
    .map((row, index) => {
      const key = row.querySelector("[data-construct-part-need-key]")?.value?.trim() ?? "";
      const existing = current.find(need => need.key === key) ?? current[index] ?? {};
      return {
        key,
        abbr: row.querySelector("[data-construct-part-need-abbr]")?.value?.trim() ?? "",
        label: row.querySelector("[data-construct-part-need-label]")?.value?.trim() ?? "",
        color: row.querySelector("[data-construct-part-need-color]")?.value?.trim() ?? "#8f8456",
        formula: row.querySelector("[data-construct-part-need-formula]")?.value?.trim() || "0",
        settings: foundry.utils.deepClone(existing.settings ?? { accumulation: { perHour: 10 }, thresholds: [], diseases: [] })
      };
    })
    .filter(need => keepEmpty || need.key);
}

function readConstructPartLossEffectsFromForm(form, { keepEmpty = false } = {}) {
  return Array.from(form?.querySelectorAll("[data-construct-part-loss-effect-row]") ?? [])
    .map(row => ({
      key: row.querySelector("[data-construct-part-loss-effect-key]")?.value?.trim() ?? "",
      type: row.querySelector("[data-construct-part-loss-effect-type]")?.value ?? "add",
      value: row.querySelector("[data-construct-part-loss-effect-value]")?.value ?? "0",
      phase: "initial",
      priority: row.querySelector("[data-construct-part-loss-effect-priority]")?.value ?? null
    }))
    .filter(effect => keepEmpty || effect.key);
}

function normalizeConstructPartLossEffects(value = [], { keepEmpty = false } = {}) {
  const effects = Array.isArray(value) ? value : Object.values(value ?? {});
  return effects
    .map(effect => ({
      key: String(effect?.key ?? "").trim(),
      type: ["add", "multiply", "override"].includes(String(effect?.type ?? "")) ? String(effect.type) : "add",
      value: String(effect?.value ?? "0"),
      phase: String(effect?.phase || "initial"),
      priority: effect?.priority === "" || effect?.priority === null || effect?.priority === undefined
        ? null
        : toInteger(effect.priority)
    }))
    .filter(effect => keepEmpty || effect.key);
}

function prepareConstructPartLossEffectRow(effect = {}, index = 0) {
  const type = String(effect?.type ?? "add");
  return {
    ...effect,
    index,
    priority: effect?.priority ?? "",
    typeChoices: [
      { value: "add", label: game.i18n.localize("FALLOUTMAW.Effects.ChangeAdd"), selected: type === "add" },
      { value: "multiply", label: game.i18n.localize("FALLOUTMAW.Effects.ChangeMultiply"), selected: type === "multiply" },
      { value: "override", label: game.i18n.localize("FALLOUTMAW.Effects.ChangeOverride"), selected: type === "override" }
    ]
  };
}

function activateItemEffectKeyAutocompletes(root) {
  if (!root) return;
  activateEffectKeyAutocomplete(root, buildEffectKeyTokens({ includeFirstAidHealing: true }), {
    selector: "input[data-effect-key-autocomplete]:not([data-ability-acquisition-change-key])"
  });
  activateEffectKeyAutocomplete(root, buildAbilityAcquisitionChangeKeyTokens(), {
    selector: "input[data-ability-acquisition-change-key]"
  });
}

function prepareAbilityFunctionRowsForDisplay(entry, functionIndex = 0, functionPath = "system.functions", item = null) {
  const type = String(entry?.type ?? ABILITY_FUNCTION_TYPES.effectChanges);
  const isAcquisitionChanges = type === ABILITY_FUNCTION_TYPES.acquisitionChanges;
  const isEffectChanges = type === ABILITY_FUNCTION_TYPES.effectChanges;
  const isActiveApplication = type === ABILITY_FUNCTION_TYPES.activeApplication;
  const isFixed = type === ABILITY_FUNCTION_TYPES.fixed;
  const fixedKey = String(entry?.fixedKey ?? "");
  const activeApplicationSettings = isActiveApplication
    ? prepareActiveApplicationSettingsForDisplay(entry?.activeSettings)
    : null;
  const fixedDeusSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.deusExMachina
    ? prepareDeusExMachinaSettingsForDisplay(entry?.fixedSettings, entry, item)
    : null;
  const fixedCurseAndBlessingSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.curseAndBlessing
    ? prepareCurseAndBlessingSettingsForDisplay(entry?.fixedSettings)
    : null;
  const fixedAllOrNothingSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.allOrNothing
    ? prepareAllOrNothingSettingsForDisplay(entry?.fixedSettings)
    : null;
  const fixedReaperSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.reaper
    ? prepareReaperSettingsForDisplay(entry?.fixedSettings)
    : null;
  const fixedVirtuosoSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.virtuoso
    ? prepareVirtuosoSettingsForDisplay(entry?.fixedSettings)
    : null;
  const fixedAimingSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.aiming
    ? prepareAimingSettingsForDisplay(entry?.fixedSettings)
    : null;
  const fixedRicochetSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.ricochet
    ? normalizeRicochetSettings(entry?.fixedSettings)
    : null;
  const fixedKeepAwaySettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.keepAway
    ? normalizeKeepAwaySettings(entry?.fixedSettings)
    : null;
  const fixedLethalAttackSettings = [ABILITY_FIXED_FUNCTION_KEYS.lethalShot, ABILITY_FIXED_FUNCTION_KEYS.lethalStrike].includes(fixedKey)
    ? normalizeLethalAttackSettings(entry?.fixedSettings)
    : null;
  const fixedFourLeafCloverSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.fourLeafClover
    ? prepareFourLeafCloverSettingsForDisplay(entry?.fixedSettings)
    : null;
  const fixedAtRandomSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.atRandom
    ? prepareAtRandomSettingsForDisplay(entry?.fixedSettings)
    : null;
  const fixedLastChanceSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.lastChance
    ? prepareLastChanceSettingsForDisplay(entry?.fixedSettings)
    : null;
  const fixedLuckyCoinSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.luckyCoin
    ? prepareLuckyCoinSettingsForDisplay(entry?.fixedSettings)
    : null;
  const fixedDisarmSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.disarm
    ? prepareDisarmSettingsForDisplay(entry?.fixedSettings)
    : null;
  const fixedDefensiveTacticsSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.defensiveTactics
    ? prepareDefensiveTacticsSettingsForDisplay(entry?.fixedSettings)
    : null;
  const fixedRageSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.rage
    ? prepareRageSettingsForDisplay(entry?.fixedSettings)
    : null;
  const fixedWhirlwindSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.whirlwind
    ? prepareWhirlwindSettingsForDisplay(entry?.fixedSettings)
    : null;
  const fixedLungeSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.lunge
    ? prepareLungeSettingsForDisplay(entry?.fixedSettings)
    : null;
  const fixedDoubleAttackSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.doubleAttack
    ? prepareDoubleAttackSettingsForDisplay(entry?.fixedSettings)
    : null;
  const fixedCounterAttackSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.counterAttack
    ? prepareCounterAttackSettingsForDisplay(entry?.fixedSettings)
    : null;
  const fixedOversightSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.oversight
    ? prepareOversightSettingsForDisplay(entry?.fixedSettings)
    : null;
  const fixedWatchOutSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.watchOut
    ? prepareWatchOutSettingsForDisplay(entry?.fixedSettings)
    : null;
  const fixedFullControlSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.fullControl
    ? prepareFullControlSettingsForDisplay(entry?.fixedSettings)
    : null;
  const fixedCounterSniperSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.counterSniper
    ? normalizeCounterSniperSettings(entry?.fixedSettings)
    : null;
  const fixedWhereAreYouGoingSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.whereAreYouGoing
    ? prepareWhereAreYouGoingSettingsForDisplay(entry?.fixedSettings)
    : null;
  const fixedFullForceSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.fullForce
    ? prepareFullForceSettingsForDisplay(entry?.fixedSettings)
    : null;
  const fixedTwoHandsSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.twoHands
    ? normalizeTwoHandsSettings(entry?.fixedSettings)
    : null;
  const fixedCommandBasicsSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.commandBasics
    ? prepareCommandBasicsSettingsForDisplay(entry?.fixedSettings)
    : null;
  const fixedKnockOffBalanceSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.knockOffBalance
    ? prepareKnockOffBalanceSettingsForDisplay(entry?.fixedSettings)
    : null;
  const fixedLookSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.look
    ? prepareLookSettingsForDisplay(entry?.fixedSettings)
    : null;
  const fixedToTheEndSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.toTheEnd
    ? prepareToTheEndSettingsForDisplay(entry?.fixedSettings)
    : null;
  const fixedHeightenedConcentrationSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.heightenedConcentration
    ? prepareHeightenedConcentrationSettingsForDisplay(entry?.fixedSettings)
    : null;
  const hasEventReaction = (entry?.conditions ?? []).some(condition => condition?.type === ABILITY_CONDITION_TYPES.eventReaction);
  const conditions = (entry?.conditions ?? []).map((condition, index) => prepareAbilityConditionForDisplay(condition, functionIndex, index, {
    changeCount: entry?.changes?.length ?? 0,
    allowLimitedChanges: isEffectChanges || isActiveApplication,
    allowEventReaction: isEffectChanges,
    eventReactionMode: hasEventReaction,
    functionPath
  }));
  const hasRuntimeConditions = (entry?.conditions ?? []).some(condition => isAbilityRuntimeCondition(condition?.type));
  const eventReactionSettings = isEffectChanges && hasEventReaction
    ? prepareAbilityEventReactionSettingsForDisplay(entry?.reactionSettings)
    : null;
  return {
    ...entry,
    functionIndex,
    functionPath,
    isAcquisitionChanges,
    isEffectChanges,
    isActiveApplication,
    isFixed,
    canConfigureChanges: isEffectChanges || isAcquisitionChanges || isActiveApplication,
    fixedKey,
    activeApplicationSettings,
    fixedDeusSettings,
    fixedCurseAndBlessingSettings,
    fixedAllOrNothingSettings,
    fixedReaperSettings,
    fixedVirtuosoSettings,
    fixedAimingSettings,
    fixedRicochetSettings,
    fixedKeepAwaySettings,
    fixedLethalAttackSettings,
    fixedFourLeafCloverSettings,
    fixedAtRandomSettings,
    fixedLastChanceSettings,
    fixedLuckyCoinSettings,
    fixedDisarmSettings,
    fixedDefensiveTacticsSettings,
    fixedRageSettings,
    fixedWhirlwindSettings,
    fixedLungeSettings,
    fixedDoubleAttackSettings,
    fixedCounterAttackSettings,
    fixedOversightSettings,
    fixedWatchOutSettings,
    fixedFullControlSettings,
    fixedCounterSniperSettings,
    fixedWhereAreYouGoingSettings,
    fixedFullForceSettings,
    fixedTwoHandsSettings,
    fixedCommandBasicsSettings,
    fixedKnockOffBalanceSettings,
    fixedLookSettings,
    fixedToTheEndSettings,
    fixedHeightenedConcentrationSettings,
    hasEventReaction,
    eventReactionSettings,
    hasUnsupportedEventReactionPenalties: hasEventReaction && Boolean(entry?.penalties?.length),
    typeLabel: getAbilityFunctionTypeLabel(entry, fixedKey),
    changes: (entry?.changes ?? []).map((change, index) => prepareAbilityChangeForDisplay(change, functionIndex, index, functionPath)),
    conditions,
    conditionGroups: buildAbilityConditionDisplayGroups(conditions),
    penalties: (entry?.penalties ?? []).map((change, index) => prepareAbilityPenaltyForDisplay(change, functionIndex, index, functionPath)),
    hasConditions: Boolean(entry?.conditions?.length),
    hasPenalties: Boolean(entry?.penalties?.length),
    canAddPenalty: !hasEventReaction && hasRuntimeConditions
  };
}

function prepareAbilityEventReactionSettingsForDisplay(settings = {}) {
  const normalized = normalizeEventReactionSettings(settings);
  return {
    ...normalized,
    costs: normalized.costs.map((cost, index) => ({
      ...cost,
      index,
      resourceChoices: buildAbilityEventReactionResourceChoices(cost.resourceKey),
      isUnsupportedResource: !isKnownAbilityEventReactionResource(cost.resourceKey)
    }))
  };
}

function prepareAbilityChangeForDisplay(change, functionIndex, index, functionPath = "system.functions") {
  return {
    ...change,
    functionPath,
    functionIndex,
    index,
    priority: change?.priority ?? "",
    typeChoices: buildAbilityChangeTypeChoices(change?.type)
  };
}

function getAbilityFunctionTypeLabel(entry = {}, fixedKey = "") {
  const type = String(entry?.type ?? ABILITY_FUNCTION_TYPES.effectChanges);
  if (type === ABILITY_FUNCTION_TYPES.fixed) return getFixedAbilityFunctionLabel(fixedKey);
  if (type === ABILITY_FUNCTION_TYPES.activeApplication) return "Активное применение";
  if (type === ABILITY_FUNCTION_TYPES.acquisitionChanges) return "Разовое изменение при приобретении";
  return "Свободная настройка";
}

function prepareActiveApplicationSettingsForDisplay(settings = {}) {
  const normalized = normalizeActiveApplicationSettings(settings);
  const overloadDuration = splitAbilityDurationSeconds(normalized.overloadDurationSeconds);
  const duration = splitAbilityDurationSeconds(normalized.durationSeconds);
  return {
    ...normalized,
    overloadDurationAmount: overloadDuration.amount,
    overloadDurationUnitChoices: buildAbilityDurationUnitChoices(overloadDuration.unit),
    durationAmount: duration.amount,
    durationUnitChoices: buildAbilityDurationUnitChoices(duration.unit),
    targetModeChoices: [
      { value: ABILITY_ACTIVE_APPLICATION_TARGET_MODES.self, label: "Себе", selected: normalized.targetMode === ABILITY_ACTIVE_APPLICATION_TARGET_MODES.self },
      { value: ABILITY_ACTIVE_APPLICATION_TARGET_MODES.others, label: "Другим", selected: normalized.targetMode === ABILITY_ACTIVE_APPLICATION_TARGET_MODES.others }
    ],
    isTargetOthers: normalized.targetMode === ABILITY_ACTIVE_APPLICATION_TARGET_MODES.others,
    targetGroupChoices: buildActiveApplicationTargetGroupChoices(normalized.targetGroups)
  };
}

function buildActiveApplicationTargetGroupChoices(value = []) {
  const selected = normalizeAbilityConditionValues(value).filter(group => ABILITY_AURA_TARGET_GROUPS.includes(group));
  const labels = {
    ally: "Союзник",
    enemy: "Враг",
    neutral: "Нейтрал"
  };
  return ABILITY_AURA_TARGET_GROUPS.map(group => ({
    value: group,
    label: labels[group] ?? group,
    selected: selected.includes(group)
  }));
}

function prepareAbilityPenaltyForDisplay(change, functionIndex, index, functionPath = "system.functions") {
  return {
    ...prepareAbilityChangeForDisplay(change, functionIndex, index, functionPath),
    penaltyIndex: index
  };
}

function prepareDeusExMachinaSettingsForDisplay(settings = {}, abilityFunction = {}, item = null) {
  const normalized = normalizeDeusExMachinaSettings(settings);
  const duration = splitAbilityDurationSeconds(normalized.insight.durationSeconds);
  const stateKey = [String(abilityFunction?.id ?? ""), ABILITY_FIXED_FUNCTION_KEYS.deusExMachina].filter(Boolean).join(":");
  const state = item?.getFlag?.(SYSTEM_ID, ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY)
    ?? item?.flags?.[SYSTEM_ID]?.[ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY]
    ?? {};
  return {
    ...normalized,
    damageCurrent: Math.max(0, toInteger(state?.[stateKey]?.damage)),
    insightDurationAmount: duration.amount,
    insightDurationUnitChoices: buildAbilityDurationUnitChoices(duration.unit),
    restoreModeChoices: [
      { value: "all", label: "Все ключевые конечности", selected: normalized.rescue.restoreMode === "all" },
      { value: "count", label: "Ограниченное число", selected: normalized.rescue.restoreMode !== "all" }
    ],
    isRestoreCountMode: normalized.rescue.restoreMode !== "all"
  };
}

function prepareCurseAndBlessingSettingsForDisplay(settings = {}) {
  const normalized = normalizeCurseAndBlessingSettings(settings);
  const duration = splitAbilityDurationSeconds(normalized.durationSeconds);
  return {
    ...normalized,
    durationAmount: duration.amount,
    durationUnitChoices: buildAbilityDurationUnitChoices(duration.unit)
  };
}

function prepareAllOrNothingSettingsForDisplay(settings = {}) {
  const normalized = normalizeAllOrNothingSettings(settings);
  const duration = splitAbilityDurationSeconds(normalized.overloadDurationSeconds);
  return {
    ...normalized,
    overloadDurationAmount: duration.amount,
    overloadDurationUnitChoices: buildAbilityDurationUnitChoices(duration.unit)
  };
}

function prepareReaperSettingsForDisplay(settings = {}) {
  return normalizeReaperSettings(settings);
}

function prepareVirtuosoSettingsForDisplay(settings = {}) {
  return normalizeVirtuosoSettings(settings);
}

function prepareAimingSettingsForDisplay(settings = {}) {
  return normalizeAimingSettings(settings);
}

function prepareFourLeafCloverSettingsForDisplay(settings = {}) {
  return normalizeFourLeafCloverSettings(settings);
}

function prepareAtRandomSettingsForDisplay(settings = {}) {
  return normalizeAtRandomSettings(settings);
}

function prepareDefensiveTacticsSettingsForDisplay(settings = {}) {
  return normalizeDefensiveTacticsSettings(settings);
}

function prepareRageSettingsForDisplay(settings = {}) {
  const normalized = normalizeRageSettings(settings);
  const duration = splitAbilityDurationSeconds(normalized.durationSeconds);
  const overloadDuration = splitAbilityDurationSeconds(normalized.overloadDurationSeconds);
  const skillSettings = getSkillSettings();
  return {
    ...normalized,
    durationAmount: duration.amount,
    durationUnitChoices: buildAbilityDurationUnitChoices(duration.unit),
    overloadDurationAmount: overloadDuration.amount,
    overloadDurationUnitChoices: buildAbilityDurationUnitChoices(overloadDuration.unit),
    advantageSkillChoices: buildSkillChoices(normalized.advantageSkillKey, skillSettings),
    disadvantageSkillChoices: buildSkillChoices(normalized.disadvantageSkillKey, skillSettings)
  };
}

function prepareWhirlwindSettingsForDisplay(settings = {}) {
  const normalized = normalizeWhirlwindSettings(settings);
  const overloadDuration = splitAbilityDurationSeconds(normalized.overloadDurationSeconds);
  return {
    ...normalized,
    overloadDurationAmount: overloadDuration.amount,
    overloadDurationUnitChoices: buildAbilityDurationUnitChoices(overloadDuration.unit)
  };
}

function prepareLungeSettingsForDisplay(settings = {}) {
  const normalized = normalizeLungeSettings(settings);
  const overloadDuration = splitAbilityDurationSeconds(normalized.overloadDurationSeconds);
  return {
    ...normalized,
    overloadDurationAmount: overloadDuration.amount,
    overloadDurationUnitChoices: buildAbilityDurationUnitChoices(overloadDuration.unit)
  };
}

function prepareDoubleAttackSettingsForDisplay(settings = {}) {
  const normalized = normalizeDoubleAttackSettings(settings);
  return {
    ...normalized,
    skillChoices: buildSkillChoices(normalized.requiredSkillKey, getSkillSettings())
  };
}

function prepareCounterAttackSettingsForDisplay(settings = {}) {
  const normalized = normalizeCounterAttackSettings(settings);
  const overloadDuration = splitAbilityDurationSeconds(normalized.reactionOverloadDurationSeconds);
  return {
    ...normalized,
    reactionOverloadDurationAmount: overloadDuration.amount,
    reactionOverloadDurationUnitChoices: buildAbilityDurationUnitChoices(overloadDuration.unit),
    skillChoices: buildSkillChoices(normalized.requiredSkillKey, getSkillSettings())
  };
}

function prepareOversightSettingsForDisplay(settings = {}) {
  const normalized = normalizeOversightSettings(settings);
  const overloadDuration = splitAbilityDurationSeconds(normalized.overloadDurationSeconds);
  const skills = getSkillSettings();
  return {
    ...normalized,
    overloadDurationAmount: overloadDuration.amount,
    overloadDurationUnitChoices: buildAbilityDurationUnitChoices(overloadDuration.unit),
    sourceSkillChoices: buildSkillChoices(normalized.sourceSkillKey, skills),
    targetSkillChoices: buildSkillChoices(normalized.targetSkillKey, skills)
  };
}

function prepareWatchOutSettingsForDisplay(settings = {}) {
  const normalized = normalizeWatchOutSettings(settings);
  const overloadDuration = splitAbilityDurationSeconds(normalized.reactionOverloadDurationSeconds);
  return {
    ...normalized,
    reactionOverloadDurationAmount: overloadDuration.amount,
    reactionOverloadDurationUnitChoices: buildAbilityDurationUnitChoices(overloadDuration.unit),
    sourceSkillChoices: buildSkillChoices(normalized.sourceSkillKey, getSkillSettings())
  };
}

function prepareFullControlSettingsForDisplay(settings = {}) {
  const normalized = normalizeFullControlSettings(settings);
  const duration = splitAbilityDurationSeconds(normalized.durationSeconds);
  return {
    ...normalized,
    durationAmount: duration.amount,
    durationUnitChoices: buildAbilityDurationUnitChoices(duration.unit),
    limitSkillChoices: buildSkillChoices(normalized.limitSkillKey, getSkillSettings())
  };
}

function prepareWhereAreYouGoingSettingsForDisplay(settings = {}) {
  const normalized = normalizeWhereAreYouGoingSettings(settings);
  const overloadDuration = splitAbilityDurationSeconds(normalized.reactionOverloadDurationSeconds);
  return {
    ...normalized,
    reactionOverloadDurationAmount: overloadDuration.amount,
    reactionOverloadDurationUnitChoices: buildAbilityDurationUnitChoices(overloadDuration.unit)
  };
}

function prepareFullForceSettingsForDisplay(settings = {}) {
  const normalized = normalizeFullForceSettings(settings);
  return {
    ...normalized,
    skillChoices: buildSkillChoices(normalized.requiredSkillKey, getSkillSettings())
  };
}

function prepareCommandBasicsSettingsForDisplay(settings = {}) {
  const normalized = normalizeCommandBasicsSettings(settings);
  const overloadDuration = splitAbilityDurationSeconds(normalized.overloadDurationSeconds);
  const dodgeDuration = splitAbilityDurationSeconds(normalized.dodgeDurationSeconds);
  return {
    ...normalized,
    overloadDurationAmount: overloadDuration.amount,
    overloadDurationUnitChoices: buildAbilityDurationUnitChoices(overloadDuration.unit),
    dodgeDurationAmount: dodgeDuration.amount,
    dodgeDurationUnitChoices: buildAbilityDurationUnitChoices(dodgeDuration.unit)
  };
}

function prepareKnockOffBalanceSettingsForDisplay(settings = {}) {
  const normalized = normalizeKnockOffBalanceSettings(settings);
  const overloadDuration = splitAbilityDurationSeconds(normalized.overloadDurationSeconds);
  const debuffDuration = splitAbilityDurationSeconds(normalized.debuffDurationSeconds);
  return {
    ...normalized,
    overloadDurationAmount: overloadDuration.amount,
    overloadDurationUnitChoices: buildAbilityDurationUnitChoices(overloadDuration.unit),
    debuffDurationAmount: debuffDuration.amount,
    debuffDurationUnitChoices: buildAbilityDurationUnitChoices(debuffDuration.unit),
    targetSkillChoices: buildSkillChoices(normalized.targetSkillKey, getSkillSettings())
  };
}

function prepareLookSettingsForDisplay(settings = {}) {
  const normalized = normalizeLookSettings(settings);
  const overloadDuration = splitAbilityDurationSeconds(normalized.overloadDurationSeconds);
  return {
    ...normalized,
    overloadDurationAmount: overloadDuration.amount,
    overloadDurationUnitChoices: buildAbilityDurationUnitChoices(overloadDuration.unit),
    targetSkillChoices: buildSkillChoices(normalized.targetSkillKey, getSkillSettings())
  };
}

function prepareToTheEndSettingsForDisplay(settings = {}) {
  const normalized = normalizeToTheEndSettings(settings);
  const overloadDuration = splitAbilityDurationSeconds(normalized.overloadDurationSeconds);
  const duration = splitAbilityDurationSeconds(normalized.durationSeconds);
  return {
    ...normalized,
    overloadDurationAmount: overloadDuration.amount,
    overloadDurationUnitChoices: buildAbilityDurationUnitChoices(overloadDuration.unit),
    durationAmount: duration.amount,
    durationUnitChoices: buildAbilityDurationUnitChoices(duration.unit),
    advantageSkillRows: buildToTheEndAdvantageSkillRows(normalized.advantageSkills)
  };
}

function buildToTheEndAdvantageSkillRows(advantageSkills = []) {
  return advantageSkills.map((entry, index) => ({
    index,
    advantageCount: entry.advantageCount,
    canDelete: advantageSkills.length > 1,
    skillChoices: buildToTheEndAdvantageSkillChoices(entry.skillKey)
  }));
}

function buildToTheEndAdvantageSkillChoices(selectedKey = "") {
  const selected = String(selectedKey ?? "").trim();
  const entries = [...getSkillSettings()];
  if (selected && !entries.some(entry => entry.key === selected)) entries.push({ key: selected, label: selected });
  return entries.map(entry => ({
    key: entry.key,
    label: entry.label || entry.key,
    selected: entry.key === selected
  }));
}

function getFirstUnusedToTheEndAdvantageSkillKey(advantageSkills = []) {
  const selected = new Set(advantageSkills.map(entry => String(entry?.skillKey ?? "").trim()).filter(Boolean));
  return getSkillSettings().find(skill => !selected.has(skill.key))?.key ?? "resilience";
}

function prepareHeightenedConcentrationSettingsForDisplay(settings = {}) {
  const normalized = normalizeHeightenedConcentrationSettings(settings);
  const overloadDuration = splitAbilityDurationSeconds(normalized.overloadDurationSeconds);
  return {
    ...normalized,
    overloadDurationAmount: overloadDuration.amount,
    overloadDurationUnitChoices: buildAbilityDurationUnitChoices(overloadDuration.unit),
    skillChoices: buildSkillChoices(normalized.skillKey, getSkillSettings())
  };
}

function prepareLastChanceSettingsForDisplay(settings = {}) {
  const normalized = normalizeLastChanceSettings(settings);
  const duration = splitAbilityDurationSeconds(normalized.overloadDurationSeconds);
  return {
    ...normalized,
    overloadDurationAmount: duration.amount,
    overloadDurationUnitChoices: buildAbilityDurationUnitChoices(duration.unit)
  };
}

function prepareLuckyCoinSettingsForDisplay(settings = {}) {
  const normalized = normalizeLuckyCoinSettings(settings);
  const duration = splitAbilityDurationSeconds(normalized.overloadDurationSeconds);
  return {
    ...normalized,
    overloadDurationAmount: duration.amount,
    overloadDurationUnitChoices: buildAbilityDurationUnitChoices(duration.unit)
  };
}

function prepareDisarmSettingsForDisplay(settings = {}) {
  const normalized = normalizeDisarmSettings(settings);
  const activeDuration = splitAbilityDurationSeconds(normalized.activeOverloadDurationSeconds);
  const reactionDuration = splitAbilityDurationSeconds(normalized.reactionOverloadDurationSeconds);
  return {
    ...normalized,
    activeOverloadDurationAmount: activeDuration.amount,
    activeOverloadDurationUnitChoices: buildAbilityDurationUnitChoices(activeDuration.unit),
    reactionOverloadDurationAmount: reactionDuration.amount,
    reactionOverloadDurationUnitChoices: buildAbilityDurationUnitChoices(reactionDuration.unit)
  };
}

function prepareAbilityConditionForDisplay(condition, functionIndex, index, {
  changeCount = 0,
  allowLimitedChanges = false,
  allowEventReaction = false,
  eventReactionMode = false,
  functionPath = "system.functions"
} = {}) {
  const type = String(condition?.type ?? "");
  const isEventReaction = type === ABILITY_CONDITION_TYPES.eventReaction;
  const isEventReactionFilter = isEventReactionFilterType(type);
  const isUnsupportedEventCondition = eventReactionMode
    && ((!isEventReaction && !isEventReactionFilter) || (isEventReaction && !allowEventReaction));
  const isHealth = type === ABILITY_CONDITION_TYPES.healthPercent;
  const isEquipment = type === ABILITY_CONDITION_TYPES.equipmentSlotOccupied;
  const isTargetFaction = type === ABILITY_CONDITION_TYPES.targetFaction;
  const isTargetRace = type === ABILITY_CONDITION_TYPES.targetRace;
  const isTargetType = type === ABILITY_CONDITION_TYPES.targetType;
  const isPosture = type === ABILITY_CONDITION_TYPES.posture;
  const isOccupiedCover = type === ABILITY_CONDITION_TYPES.occupiedCover;
  const isWeaponAction = type === ABILITY_CONDITION_TYPES.weaponAction;
  const isWeaponSkill = type === ABILITY_CONDITION_TYPES.weaponSkill;
  const isWeaponProficiency = type === ABILITY_CONDITION_TYPES.weaponProficiency;
  const isAura = type === ABILITY_CONDITION_TYPES.aura;
  const isLimitedChanges = type === ABILITY_CONDITION_TYPES.limitedChanges;
  const isCooldown = type === ABILITY_CONDITION_TYPES.cooldown;
  const isEnergyConsumption = type === ABILITY_CONDITION_TYPES.energyConsumption;
  const isItemUse = type === ABILITY_CONDITION_TYPES.itemUse;
  const maxLimit = Math.max(1, changeCount);
  const duration = splitAbilityDurationSeconds(condition?.durationSeconds);
  const healthTarget = Object.values(ABILITY_HEALTH_TARGETS).includes(condition?.healthTarget)
    ? condition.healthTarget
    : ABILITY_HEALTH_TARGETS.general;
  const isHealthGeneral = healthTarget === ABILITY_HEALTH_TARGETS.general;
  const isHealthLimb = healthTarget === ABILITY_HEALTH_TARGETS.limb;
  const isHealthCriticalLimb = healthTarget === ABILITY_HEALTH_TARGETS.criticalLimb;
  const eventDisplay = isEventReaction
    ? buildAbilityEventReactionDisplay(condition?.eventKey)
    : { groups: [], selectedEvent: null, isUnsupported: false };
  return {
    ...condition,
    functionPath,
    functionIndex,
    index,
    healthTarget,
    isPending: !isEventReaction && !isHealth && !isEquipment && !isTargetFaction && !isTargetRace && !isTargetType && !isPosture && !isOccupiedCover && !isWeaponAction && !isWeaponSkill && !isWeaponProficiency && !isAura && !isLimitedChanges && !isCooldown && !isEnergyConsumption && !isItemUse,
    isEventReaction,
    isEventReactionFilter,
    isUnsupportedEventCondition,
    showEventSubject: eventReactionMode && isEventReactionFilter,
    isHealth,
    isHealthGeneral,
    isHealthLimb,
    isHealthCriticalLimb,
    showLimbChoice: isHealth && !isHealthGeneral,
    isEquipment,
    isTargetFaction,
    isTargetRace,
    isTargetType,
    isPosture,
    isOccupiedCover,
    isWeaponAction,
    isWeaponSkill,
    isWeaponProficiency,
    isAura,
    isLimitedChanges,
    isCooldown,
    isEnergyConsumption,
    isItemUse,
    canAddAlternative: !isEventReaction && !isUnsupportedEventCondition && !isLimitedChanges && !isCooldown && !isEnergyConsumption && !isItemUse,
    changeLimit: Math.max(1, Math.min(maxLimit, toInteger(condition?.limit ?? 1))),
    changeLimitMax: maxLimit,
    changeLimitTotal: changeCount,
    requiredCount: isAura ? normalizeAbilityFormulaText(condition?.requiredCount, "1") : Math.max(1, toInteger(condition?.requiredCount ?? 1)),
    durationSeconds: Math.max(0, toInteger(condition?.durationSeconds)),
    energyConsumptionName: String(condition?.name ?? "").trim(),
    amountPerHour: Math.max(0, Number(condition?.amountPerHour) || 0),
    durationAmount: duration.amount,
    durationUnitChoices: buildAbilityDurationUnitChoices(duration.unit),
    typeLabel: getAbilityConditionTypeLabel(type),
    typeChoices: buildAbilityConditionTypeChoices(type, { allowLimitedChanges, allowEventReaction, eventReactionMode }),
    eventGroups: eventDisplay.groups,
    selectedEvent: eventDisplay.selectedEvent,
    isUnsupportedEventKey: eventDisplay.isUnsupported,
    reactorRoleChoices: buildAbilityEventReactorRoleChoices(condition?.reactorRole),
    eventSubjectChoices: buildAbilityEventSubjectChoices(condition?.eventSubject),
    healthTargetChoices: buildAbilityHealthTargetChoices(healthTarget),
    limbChoices: buildAbilityLimbChoices(condition?.limbKey, { criticalOnly: isHealthCriticalLimb }),
    healthOperatorChoices: [
      { value: "lte", label: "<=", selected: String(condition?.operator ?? "lte") !== "gte" },
      { value: "gte", label: ">=", selected: String(condition?.operator ?? "lte") === "gte" }
    ],
    equipmentOperatorChoices: [
      { value: ABILITY_EQUIPMENT_OPERATORS.occupied, label: "Занят", selected: condition?.operator !== ABILITY_EQUIPMENT_OPERATORS.empty },
      { value: ABILITY_EQUIPMENT_OPERATORS.empty, label: "Не занят", selected: condition?.operator === ABILITY_EQUIPMENT_OPERATORS.empty }
    ],
    equipmentSlotChoices: buildAbilityEquipmentSlotChoices(condition?.equipmentSlotKey),
    targetFactionRows: buildAbilityTargetFactionRows(condition?.targetFactionNames),
    canAddTargetFaction: Boolean(getFirstUnusedAbilityTargetFaction(condition?.targetFactionNames)),
    targetRaceChoices: buildAbilityTargetRaceChoices(condition?.targetRaceId),
    targetTypeChoices: buildAbilityTargetTypeChoices(condition?.targetTypeId),
    postureSubjectChoices: buildAbilityPostureSubjectChoices(condition?.postureSubject),
    postureRows: buildAbilityPostureRows(condition?.postureActions),
    canAddPosture: normalizeAbilityConditionValues(condition?.postureActions).length < ABILITY_POSTURE_ACTIONS.length,
    coverRows: buildAbilityCoverRows(condition?.coverKeys),
    canAddCover: Boolean(getFirstUnusedAbilityCoverKey(condition?.coverKeys)),
    weaponActionRows: buildAbilityWeaponActionRows(condition?.weaponActionKeys),
    canAddWeaponAction: Boolean(getFirstUnusedAbilityWeaponActionKey(condition?.weaponActionKeys)),
    skillRows: buildAbilitySkillRows(condition?.skillKeys),
    canAddSkill: Boolean(getFirstUnusedAbilitySkillKey(condition?.skillKeys)),
    proficiencyRows: buildAbilityProficiencyRows(condition?.proficiencyKeys),
    canAddProficiency: Boolean(getFirstUnusedAbilityProficiencyKey(condition?.proficiencyKeys)),
    auraModeChoices: buildAbilityAuraModeChoices(condition?.auraMode),
    auraTargetGroupsLabel: getAbilityAuraTargetGroupsLabel(condition?.auraMode),
    showAuraIncludeSelf: condition?.auraMode !== ABILITY_AURA_MODES.selfWhenPresent,
    auraTargetGroupRows: buildAbilityAuraTargetGroupRows(condition?.auraTargetGroups),
    canAddAuraTargetGroup: normalizeAbilityConditionValues(condition?.auraTargetGroups).filter(group => ABILITY_AURA_TARGET_GROUPS.includes(group)).length < ABILITY_AURA_TARGET_GROUPS.length,
    auraRadiusMeters: normalizeAbilityFormulaText(condition?.auraRadiusMeters, "0"),
    auraWallsBlockChoices: buildAbilityBooleanChoices(condition?.auraWallsBlock !== false),
    auraIncludeSelfChoices: buildAbilityBooleanChoices(condition?.auraIncludeSelf !== false),
    auraCombatOnlyChoices: buildAbilityBooleanChoices(Boolean(condition?.auraCombatOnly)),
    auraCombatantsOnlyChoices: buildAbilityBooleanChoices(Boolean(condition?.auraCombatantsOnly)),
    auraIgnoreIncapacitatedChoices: buildAbilityBooleanChoices(condition?.auraIgnoreIncapacitated !== false),
    auraIgnoreHiddenChoices: buildAbilityBooleanChoices(condition?.auraIgnoreHidden !== false),
    itemCategoryRows: buildAbilityItemUseCategoryRows(condition?.itemCategories),
    canAddItemCategory: Boolean(getFirstUnusedAbilityItemUseCategory(condition?.itemCategories))
  };
}

function buildAbilityConditionDisplayGroups(conditions = []) {
  const groups = [];
  for (const condition of conditions) {
    const groupId = String(condition?.groupId ?? "").trim();
    const previous = groups.at(-1);
    if (groupId && previous?.groupId === groupId) {
      previous.conditions.push(condition);
    } else {
      groups.push({
        id: groupId || condition?.id || foundry.utils.randomID(),
        groupId,
        conditions: [condition]
      });
    }
  }
  return groups.map(group => ({
    ...group,
    isOrGroup: Boolean(group.groupId && group.conditions.length > 1)
  }));
}

function getAbilityConditionTypeLabel(type) {
  return buildAbilityConditionTypeChoices(type, { allowLimitedChanges: true }).find(choice => choice.value === type)?.label ?? type;
}

function buildAbilityChangeTypeChoices(selected = ABILITY_CHANGE_TYPES.add) {
  return [
    { value: ABILITY_CHANGE_TYPES.add, label: "Добавить" },
    { value: ABILITY_CHANGE_TYPES.multiply, label: "Умножить" },
    { value: ABILITY_CHANGE_TYPES.override, label: "Заменить" },
    { value: ABILITY_CHANGE_TYPES.upgrade, label: "Повысить до" },
    { value: ABILITY_CHANGE_TYPES.downgrade, label: "Понизить до" }
  ].map(choice => ({
    ...choice,
    selected: choice.value === selected
  }));
}

function buildAbilityConditionTypeChoices(selected = "", {
  allowLimitedChanges = true,
  allowEventReaction = false,
  eventReactionMode = false
} = {}) {
  const choices = [
    { value: "", label: "", selected: !selected },
    { value: ABILITY_CONDITION_TYPES.healthPercent, label: "Состояние ОЗ", selected: selected === ABILITY_CONDITION_TYPES.healthPercent },
    { value: ABILITY_CONDITION_TYPES.equipmentSlotOccupied, label: "Занятость слотов экипировки", selected: selected === ABILITY_CONDITION_TYPES.equipmentSlotOccupied },
    { value: ABILITY_CONDITION_TYPES.targetFaction, label: "Фракция цели", selected: selected === ABILITY_CONDITION_TYPES.targetFaction },
    { value: ABILITY_CONDITION_TYPES.targetRace, label: "Раса цели", selected: selected === ABILITY_CONDITION_TYPES.targetRace },
    { value: ABILITY_CONDITION_TYPES.targetType, label: "Тип цели", selected: selected === ABILITY_CONDITION_TYPES.targetType },
    { value: ABILITY_CONDITION_TYPES.posture, label: "Положение", selected: selected === ABILITY_CONDITION_TYPES.posture },
    { value: ABILITY_CONDITION_TYPES.occupiedCover, label: "Занимаемое укрытие", selected: selected === ABILITY_CONDITION_TYPES.occupiedCover },
    { value: ABILITY_CONDITION_TYPES.weaponAction, label: "Тип атаки", selected: selected === ABILITY_CONDITION_TYPES.weaponAction },
    { value: ABILITY_CONDITION_TYPES.weaponSkill, label: "Задействованный оружием навык", selected: selected === ABILITY_CONDITION_TYPES.weaponSkill },
    { value: ABILITY_CONDITION_TYPES.weaponProficiency, label: "Задействованное оружейное владение", selected: selected === ABILITY_CONDITION_TYPES.weaponProficiency },
    { value: ABILITY_CONDITION_TYPES.aura, label: "Аура", selected: selected === ABILITY_CONDITION_TYPES.aura }
  ];
  if (allowEventReaction || selected === ABILITY_CONDITION_TYPES.eventReaction) {
    choices.splice(1, 0, {
      value: ABILITY_CONDITION_TYPES.eventReaction,
      label: localizeAbilityEventReactionUi("ConditionLabel", "Event reaction"),
      selected: selected === ABILITY_CONDITION_TYPES.eventReaction
    });
  }
  if (allowLimitedChanges || selected === ABILITY_CONDITION_TYPES.limitedChanges) {
    choices.push({
      value: ABILITY_CONDITION_TYPES.limitedChanges,
      label: "Ограниченное количество изменений",
      selected: selected === ABILITY_CONDITION_TYPES.limitedChanges
    });
  }
  choices.push({
    value: ABILITY_CONDITION_TYPES.cooldown,
    label: "Перезарядка",
    selected: selected === ABILITY_CONDITION_TYPES.cooldown
  });
  choices.push({
    value: ABILITY_CONDITION_TYPES.energyConsumption,
    label: "Потребление энергии",
    selected: selected === ABILITY_CONDITION_TYPES.energyConsumption
  });
  choices.push({
    value: ABILITY_CONDITION_TYPES.itemUse,
    label: "Применение предмета",
    selected: selected === ABILITY_CONDITION_TYPES.itemUse
  });
  if (!eventReactionMode) return choices;
  return choices
    .filter(choice => (
      !choice.value
      || choice.value === ABILITY_CONDITION_TYPES.eventReaction
      || isEventReactionFilterType(choice.value)
      || choice.value === selected
    ))
    .map(choice => choice.value === selected
      && choice.value
      && choice.value !== ABILITY_CONDITION_TYPES.eventReaction
      && !isEventReactionFilterType(choice.value)
      ? { ...choice, label: `${choice.label} — ${localizeAbilityEventReactionUi("Unsupported", "unsupported")}` }
      : choice);
}

function buildAbilityEventReactionDisplay(selectedKey = "") {
  const key = String(selectedKey ?? "").trim();
  const selectedDescriptor = getSystemEventDescriptor(key);
  const descriptors = [...getSelectableSystemEvents()];
  if (selectedDescriptor && !descriptors.some(event => event.key === selectedDescriptor.key)) {
    descriptors.push(selectedDescriptor);
  }

  const groups = Object.values(SYSTEM_EVENT_GROUPS).flatMap(group => (
    Object.values(SYSTEM_EVENT_PHASES).map(phase => ({
      key: `${group.key}:${phase.key}`,
      label: `${localizeAbilityCatalogValue(group.labelKey, group.key)} В· ${localizeAbilityCatalogValue(phase.labelKey, phase.key)}`,
      events: descriptors
        .filter(event => event.group === group.key && event.phase === phase.key)
        .map(event => prepareAbilityEventReactionChoice(event, key))
    }))
  )).filter(group => group.events.length);

  if (key && !selectedDescriptor) {
    groups.unshift({
      key: "unsupported",
      label: localizeAbilityEventReactionUi("UnsupportedGroup", "Unsupported saved event"),
      events: [{
        key,
        label: key,
        optionLabel: key,
        description: localizeAbilityEventReactionUi("UnknownEventDescription", "This saved event is not present in the current catalog."),
        selected: true,
        supported: false
      }]
    });
  }

  return {
    groups,
    selectedEvent: selectedDescriptor
      ? prepareSelectedAbilityEventMetadata(selectedDescriptor)
      : key ? {
        key,
        label: key,
        description: localizeAbilityEventReactionUi("UnknownEventDescription", "This saved event is not present in the current catalog."),
        phaseLabel: localizeAbilityEventReactionUi("Unknown", "Unknown"),
        rolesLabel: localizeAbilityEventReactionUi("Unknown", "Unknown"),
        supported: false
      } : null,
    isUnsupported: Boolean(key && (!selectedDescriptor || !selectedDescriptor.selectable))
  };
}

function prepareAbilityEventReactionChoice(descriptor, selectedKey = "") {
  const metadata = prepareSelectedAbilityEventMetadata(descriptor);
  return {
    ...metadata,
    optionLabel: `${metadata.label} · ${metadata.phaseLabel}`,
    selected: descriptor.key === selectedKey
  };
}

function prepareSelectedAbilityEventMetadata(descriptor) {
  const phase = SYSTEM_EVENT_PHASES[descriptor.phase];
  const phaseLabel = localizeAbilityCatalogValue(phase?.labelKey, descriptor.phase);
  const roleLabels = descriptor.roles.map(role => localizeAbilityCatalogValue(SYSTEM_EVENT_ROLES[role]?.labelKey, role));
  return {
    key: descriptor.key,
    label: localizeAbilityCatalogValue(descriptor.labelKey, descriptor.key),
    description: localizeAbilityCatalogValue(descriptor.descriptionKey, descriptor.key),
    phaseLabel,
    rolesLabel: roleLabels.join(", "),
    supported: Boolean(descriptor.selectable)
  };
}

function buildAbilityEventReactorRoleChoices(selected = ABILITY_EVENT_REACTOR_ROLES.any) {
  const labels = {
    [ABILITY_EVENT_REACTOR_ROLES.source]: localizeAbilityEventReactionUi("ReactorRoles.Source", "Event source"),
    [ABILITY_EVENT_REACTOR_ROLES.target]: localizeAbilityEventReactionUi("ReactorRoles.Target", "Event target"),
    [ABILITY_EVENT_REACTOR_ROLES.observer]: localizeAbilityEventReactionUi("ReactorRoles.Observer", "Observer"),
    [ABILITY_EVENT_REACTOR_ROLES.any]: localizeAbilityEventReactionUi("ReactorRoles.Any", "Any matching actor")
  };
  return Object.values(ABILITY_EVENT_REACTOR_ROLES).map(value => ({
    value,
    label: labels[value] ?? value,
    selected: value === selected
  }));
}

function buildAbilityEventSubjectChoices(selected = ABILITY_EVENT_SUBJECTS.reactor) {
  const labels = {
    [ABILITY_EVENT_SUBJECTS.reactor]: localizeAbilityEventReactionUi("EventSubjects.Reactor", "Reactor"),
    [ABILITY_EVENT_SUBJECTS.eventSource]: localizeAbilityEventReactionUi("EventSubjects.EventSource", "Event source"),
    [ABILITY_EVENT_SUBJECTS.eventTarget]: localizeAbilityEventReactionUi("EventSubjects.EventTarget", "Event target")
  };
  return Object.values(ABILITY_EVENT_SUBJECTS).map(value => ({
    value,
    label: labels[value] ?? value,
    selected: value === selected
  }));
}

function buildAbilityEventReactionResourceChoices(selected = "") {
  const key = String(selected ?? "").trim();
  const resources = getAbilityEventReactionResourceDefinitions();
  if (key && !resources.some(resource => resource.key === key)) {
    resources.push({
      key,
      label: `${key} — ${localizeAbilityEventReactionUi("Unsupported", "unsupported")}`,
      supported: false
    });
  }
  return resources.map(resource => ({
    value: resource.key,
    label: resource.label,
    selected: resource.key === (key || REACTION_POINTS_RESOURCE_KEY),
    supported: resource.supported !== false
  }));
}

function getAbilityEventReactionResourceDefinitions() {
  const resources = getResourceSettings().map(resource => ({
    key: String(resource?.key ?? "").trim(),
    label: String(resource?.label ?? resource?.key ?? "").trim(),
    supported: true
  })).filter(resource => resource.key);
  if (!resources.some(resource => resource.key === REACTION_POINTS_RESOURCE_KEY)) {
    resources.unshift({
      key: REACTION_POINTS_RESOURCE_KEY,
      label: localizeAbilityEventReactionUi("Resources.ReactionPoints", "Reaction points"),
      supported: true
    });
  }
  return resources;
}

function isKnownAbilityEventReactionResource(resourceKey = "") {
  const key = String(resourceKey ?? "").trim();
  return Boolean(key && getAbilityEventReactionResourceDefinitions().some(resource => resource.key === key));
}

function localizeAbilityCatalogValue(key = "", fallback = "") {
  if (!key) return String(fallback ?? "");
  const localized = game.i18n.localize(key);
  return localized && localized !== key ? localized : String(fallback ?? key);
}

function localizeAbilityEventReactionUi(path = "", fallback = "") {
  return localizeAbilityCatalogValue(`FALLOUTMAW.Events.Reaction.${path}`, fallback);
}

function buildAbilityWeaponActionEntries() {
  return [
    { key: "aimedShot", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionAimedShot") },
    { key: "snapshot", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionSnapshot") },
    { key: "burst", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionBurst") },
    { key: "volley", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionVolley") },
    { key: "meleeAttack", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionMeleeAttack") },
    { key: "aimedMeleeAttack", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionAimedMeleeAttack") }
  ];
}

function buildAbilityWeaponActionRows(value = []) {
  return normalizeAbilityConditionValues(value).map((actionKey, index) => ({
    index,
    choices: getAbilityWeaponActionEntriesWithSelected(actionKey).map(entry => ({
      value: entry.key,
      label: entry.label || entry.key,
      selected: entry.key === actionKey
    }))
  }));
}

function getAbilityWeaponActionEntriesWithSelected(selected = "") {
  const entries = buildAbilityWeaponActionEntries();
  if (selected && !entries.some(entry => entry.key === selected)) entries.push({ key: selected, label: selected });
  return entries;
}

function getFirstUnusedAbilityWeaponActionKey(value = []) {
  const selected = new Set(normalizeAbilityConditionValues(value));
  return buildAbilityWeaponActionEntries().find(entry => !selected.has(entry.key))?.key ?? "";
}

function buildAbilitySkillRows(value = []) {
  return normalizeAbilityConditionValues(value).map((skillKey, index) => ({
    index,
    choices: getAbilitySkillEntriesWithSelected(skillKey).map(entry => ({
      value: entry.key,
      label: entry.label || entry.key,
      selected: entry.key === skillKey
    }))
  }));
}

function getAbilitySkillEntriesWithSelected(selected = "") {
  const entries = [...getSkillSettings()];
  if (selected && !entries.some(entry => entry.key === selected)) entries.push({ key: selected, label: selected });
  return entries;
}

function getFirstUnusedAbilitySkillKey(value = []) {
  const selected = new Set(normalizeAbilityConditionValues(value));
  return getSkillSettings().find(entry => !selected.has(entry.key))?.key ?? "";
}

function buildAbilityProficiencyRows(value = []) {
  return normalizeAbilityConditionValues(value).map((proficiencyKey, index) => ({
    index,
    choices: getAbilityProficiencyEntriesWithSelected(proficiencyKey).map(entry => ({
      value: entry.key,
      label: entry.label || entry.key,
      selected: entry.key === proficiencyKey
    }))
  }));
}

function getAbilityProficiencyEntriesWithSelected(selected = "") {
  const entries = [...getProficiencySettings()];
  if (selected && !entries.some(entry => entry.key === selected)) entries.push({ key: selected, label: selected });
  return entries;
}

function getFirstUnusedAbilityProficiencyKey(value = []) {
  const selected = new Set(normalizeAbilityConditionValues(value));
  return getProficiencySettings().find(entry => !selected.has(entry.key))?.key ?? "";
}

function isAbilityRuntimeCondition(type = "") {
  return [
    ABILITY_CONDITION_TYPES.healthPercent,
    ABILITY_CONDITION_TYPES.equipmentSlotOccupied,
    ABILITY_CONDITION_TYPES.targetFaction,
    ABILITY_CONDITION_TYPES.targetRace,
    ABILITY_CONDITION_TYPES.targetType,
    ABILITY_CONDITION_TYPES.posture,
    ABILITY_CONDITION_TYPES.occupiedCover,
    ABILITY_CONDITION_TYPES.weaponAction,
    ABILITY_CONDITION_TYPES.weaponSkill,
    ABILITY_CONDITION_TYPES.weaponProficiency,
    ABILITY_CONDITION_TYPES.aura,
    ABILITY_CONDITION_TYPES.cooldown,
    ABILITY_CONDITION_TYPES.energyConsumption
  ].includes(type);
}

function buildAbilityAuraModeChoices(selected = ABILITY_AURA_MODES.applyToTargets) {
  return [
    { value: ABILITY_AURA_MODES.applyToTargets, label: "Обычный" },
    { value: ABILITY_AURA_MODES.selfWhenPresent, label: "Сбор внешних условий для наложения на себя" }
  ].map(choice => ({
    ...choice,
    selected: choice.value === selected
  }));
}

function getAbilityAuraTargetGroupsLabel(mode = "") {
  return mode === ABILITY_AURA_MODES.selfWhenPresent
    ? "Цели для сбора условий"
    : "Цели воздействия";
}

function normalizeAbilityFormulaText(value = "", fallback = "0") {
  return String(value ?? "").trim() || fallback;
}

function buildAbilityAuraTargetGroupRows(value = []) {
  const selected = normalizeAbilityConditionValues(value).filter(group => ABILITY_AURA_TARGET_GROUPS.includes(group));
  return selected.map((group, index) => ({
    index,
    choices: ABILITY_AURA_TARGET_GROUPS.map(entry => ({
      value: entry,
      label: getAbilityAuraTargetGroupLabel(entry),
      selected: entry === group,
      disabled: entry !== group && selected.includes(entry)
    }))
  }));
}

function getAbilityAuraTargetGroupLabel(group = "") {
  return {
    ally: "Союзники",
    enemy: "Враги",
    neutral: "Нейтралы"
  }[group] ?? group;
}

function buildAbilityBooleanChoices(selected = false) {
  return [
    { value: "true", label: "Да", selected: Boolean(selected) },
    { value: "false", label: "Нет", selected: !selected }
  ];
}

function buildAbilityHealthTargetChoices(selected = ABILITY_HEALTH_TARGETS.general) {
  return [
    { value: ABILITY_HEALTH_TARGETS.general, label: "Общее" },
    { value: ABILITY_HEALTH_TARGETS.limb, label: "Конечности" },
    { value: ABILITY_HEALTH_TARGETS.criticalLimb, label: "Критические конечности" }
  ].map(choice => ({
    ...choice,
    selected: choice.value === selected
  }));
}

function buildAbilityLimbChoices(selected = ABILITY_HEALTH_LIMB_ALL, { criticalOnly = false } = {}) {
  const selectedKey = String(selected ?? ABILITY_HEALTH_LIMB_ALL).trim() || ABILITY_HEALTH_LIMB_ALL;
  const limbs = new Map([[ABILITY_HEALTH_LIMB_ALL, "Все"]]);
  for (const race of getCreatureOptions().races ?? []) {
    for (const limb of race.limbs ?? []) {
      if (criticalOnly && !limb?.critical) continue;
      const key = String(limb?.key ?? "").trim();
      if (!key || limbs.has(key)) continue;
      limbs.set(key, String(limb?.label || key));
    }
  }
  if (selectedKey && !limbs.has(selectedKey)) limbs.set(selectedKey, selectedKey);
  return Array.from(limbs.entries()).map(([value, label]) => ({
    value,
    label,
    selected: value === selectedKey
  }));
}

function buildAbilityEquipmentSlotChoices(selected = "") {
  const slots = new Map();
  for (const race of getCreatureOptions().races ?? []) {
    for (const slot of race.equipmentSlots ?? []) {
      const key = String(slot.key || getEquipmentSlotSelectionKey(slot.label) || slot.label || "").trim();
      if (!key || slots.has(key)) continue;
      slots.set(key, String(slot.label || key));
    }
  }
  if (selected && !slots.has(selected)) slots.set(selected, selected);
  return Array.from(slots.entries()).map(([value, label]) => ({
    value,
    label,
    selected: value === selected
  }));
}

function buildAbilityTargetFactionRows(value = []) {
  return normalizeAbilityConditionValues(value).map((faction, index) => ({
    index,
    choices: getFactionNamesWithDefault(getFactionSettings()).map(name => ({
      value: name,
      label: name,
      selected: name === faction
    }))
  }));
}

function getFirstUnusedAbilityTargetFaction(value = []) {
  const selected = new Set(normalizeAbilityConditionValues(value));
  return getFactionNamesWithDefault(getFactionSettings()).find(name => !selected.has(name)) ?? "";
}

function buildAbilityTargetRaceChoices(selected = "") {
  const races = [...(getCreatureOptions().races ?? [])];
  if (selected && !races.some(race => race.id === selected)) races.push({ id: selected, name: selected });
  return [
    { value: "", label: "", selected: !selected },
    ...races.map(race => ({ value: race.id, label: race.name || race.id, selected: race.id === selected }))
  ];
}

function buildAbilityTargetTypeChoices(selected = "") {
  const types = [...(getCreatureOptions().types ?? [])];
  if (selected && !types.some(type => type.id === selected)) types.push({ id: selected, name: selected });
  return [
    { value: "", label: "", selected: !selected },
    ...types.map(type => ({ value: type.id, label: type.name || type.id, selected: type.id === selected }))
  ];
}

function buildAbilityPostureSubjectChoices(selected = ABILITY_POSTURE_SUBJECTS.self) {
  return [
    { value: ABILITY_POSTURE_SUBJECTS.self, label: "Свое положение" },
    { value: ABILITY_POSTURE_SUBJECTS.target, label: "Положение цели" }
  ].map(choice => ({ ...choice, selected: choice.value === selected }));
}

function buildAbilityPostureRows(value = []) {
  const labels = { walk: "Стоя", crawl: "В приседе", burrow: "Лежа", knocked: "Опрокинут" };
  return normalizeAbilityConditionValues(value).map((posture, index) => ({
    index,
    choices: ABILITY_POSTURE_ACTIONS.map(action => ({
      value: action,
      label: labels[action] ?? action,
      selected: action === posture
    }))
  }));
}

function buildAbilityCoverRows(value = []) {
  return normalizeAbilityConditionValues(value).map((coverKey, index) => ({
    index,
    choices: getAbilityCoverEntriesWithSelected(coverKey).map(entry => ({
      value: entry.key,
      label: entry.label || entry.key,
      selected: entry.key === coverKey
    }))
  }));
}

function getAbilityCoverEntriesWithSelected(selected = "") {
  const entries = [...getCoverSettings().entries];
  if (selected && !entries.some(entry => entry.key === selected)) entries.push({ key: selected, label: selected });
  return entries;
}

function getFirstUnusedAbilityCoverKey(value = []) {
  const selected = new Set(normalizeAbilityConditionValues(value));
  return getCoverSettings().entries.find(entry => !selected.has(entry.key))?.key ?? "";
}

function normalizeAbilityConditionValues(value = []) {
  const source = Array.isArray(value) ? value : Object.values(value ?? {});
  return Array.from(new Set(source.map(entry => String(entry ?? "").trim()).filter(Boolean)));
}

function buildAbilityItemUseCategoryRows(selectedCategories = []) {
  const selected = normalizeAbilityItemUseCategoryValues(selectedCategories);
  return selected.map((category, index) => ({
    index,
    choices: buildAbilityItemUseCategoryChoices(category, selected)
  }));
}

function buildAbilityItemUseCategoryChoices(selectedCategory = "", selectedCategories = []) {
  const selected = String(selectedCategory ?? "").trim();
  const categories = getAbilityItemUseCategoryLabels(selectedCategories);
  return categories.map(category => ({
    value: category,
    label: category,
    selected: category === selected
  }));
}

function getAbilityItemUseCategoryLabels(extraCategories = []) {
  const categories = getItemCategorySettings()
    .map(category => String(category?.label ?? category ?? "").trim())
    .filter(Boolean);
  for (const category of normalizeAbilityItemUseCategoryValues(extraCategories)) {
    if (!categories.includes(category)) categories.push(category);
  }
  return categories;
}

function getFirstUnusedAbilityItemUseCategory(selectedCategories = []) {
  const selected = new Set(normalizeAbilityItemUseCategoryValues(selectedCategories));
  return getAbilityItemUseCategoryLabels().find(category => !selected.has(category)) ?? "";
}

function normalizeAbilityItemUseCategoryValues(value = []) {
  return Array.from(new Set((Array.isArray(value) ? value : Object.values(value ?? {}))
    .map(category => String(category ?? "").trim())
    .filter(Boolean)));
}

function splitAbilityDurationSeconds(value) {
  return splitDurationSeconds(value);
}

function buildAbilityDurationUnitChoices(selected = "seconds") {
  return buildDurationUnitChoices(selected);
}

function abilityDurationPartsToSeconds(amount, unit) {
  return durationPartsToSeconds(amount, unit);
}

function preserveNeedChangeChangesOnSubmit(form = null, submitData = {}, item = null) {
  const hasChangeInputs = Boolean(form?.querySelector?.("[name^=\"system.functions.needChange.changes.\"]"));
  if (hasChangeInputs) return;
  const existing = item?.system?.functions?.needChange?.changes;
  if (!Array.isArray(existing) || !existing.length) return;
  foundry.utils.setProperty(
    submitData,
    "system.functions.needChange.changes",
    foundry.utils.deepClone(existing)
  );
}

function normalizeSubmittedNeedChangeDurations(form = null, submitData = {}) {
  const durationAmount = form?.querySelector?.("[data-need-change-duration-amount]");
  if (durationAmount) {
    foundry.utils.setProperty(
      submitData,
      "system.functions.needChange.durationSeconds",
      durationPartsToSeconds(durationAmount.value, form.querySelector("[data-need-change-duration-unit]")?.value)
    );
  }
}

function normalizeSubmittedFirstAidCheckboxes(form = null, submitData = {}) {
  const healingIsPercentage = form?.querySelector?.("input[type='checkbox'][name='system.functions.firstAid.healingIsPercentage']");
  if (!healingIsPercentage) return;
  foundry.utils.setProperty(
    submitData,
    "system.functions.firstAid.healingIsPercentage",
    Boolean(healingIsPercentage.checked)
  );
}

function normalizeSubmittedFirstAidDurations(form = null, submitData = {}) {
  const durationAmount = form?.querySelector?.("[data-first-aid-duration-amount]");
  if (durationAmount) {
    foundry.utils.setProperty(
      submitData,
      "system.functions.firstAid.durationSeconds",
      durationPartsToSeconds(durationAmount.value, form.querySelector("[data-first-aid-duration-unit]")?.value)
    );
  }
  const withdrawalAmount = form?.querySelector?.("[data-first-aid-withdrawal-duration-amount]");
  if (withdrawalAmount) {
    foundry.utils.setProperty(
      submitData,
      "system.functions.firstAid.withdrawalDurationSeconds",
      durationPartsToSeconds(withdrawalAmount.value, form.querySelector("[data-first-aid-withdrawal-duration-unit]")?.value)
    );
  }
}

function prepareAbilityFunctionForDisplay(entry, characteristics, skills) {
  const type = String(entry?.type ?? ABILITY_FUNCTION_TYPES.characteristicBonus);
  const targetSettings = type === ABILITY_FUNCTION_TYPES.skillBonus ? skills : characteristics;
  return {
    ...entry,
    typeLabel: type === ABILITY_FUNCTION_TYPES.skillBonus ? "Изменение навыка" : "Изменение характеристики",
    conditionEnabled: Boolean(entry?.condition?.enabled),
    conditionLte: String(entry?.condition?.operator ?? "lte") !== "gte",
    conditionGte: String(entry?.condition?.operator ?? "lte") === "gte",
    value: toInteger(entry?.value),
    conditionPercent: Math.max(0, Math.min(100, toInteger(entry?.condition?.percent ?? 50))),
    targetChoices: targetSettings.map(setting => ({
      key: setting.key,
      label: setting.label,
      selected: setting.key === entry?.target
    }))
  };
}

function normalizeConstructPartNeeds(value = [], { keepEmpty = false } = {}) {
  const needs = Array.isArray(value) ? value : Object.values(value ?? {});
  return needs
    .map(need => ({
      key: String(need?.key ?? "").trim(),
      abbr: String(need?.abbr ?? "").trim(),
      label: String(need?.label ?? "").trim(),
      color: String(need?.color ?? "#8f8456").trim() || "#8f8456",
      formula: String(need?.formula ?? "0").trim() || "0",
      settings: foundry.utils.deepClone(need?.settings ?? { accumulation: { perHour: 10 }, thresholds: [], diseases: [] })
    }))
    .filter(need => keepEmpty || need.key);
}

function createConstructPartNeedData(existingNeeds = []) {
  const key = getUniqueConstructPartNeedId("newNeed", existingNeeds.map(need => need.key));
  const abbr = getUniqueConstructPartNeedId("new", existingNeeds.map(need => need.abbr));
  return {
    key,
    abbr,
    label: "Новая потребность",
    color: "#8f8456",
    formula: "0",
    settings: { accumulation: { perHour: 10 }, thresholds: [], diseases: [] }
  };
}

function getUniqueConstructPartNeedId(baseId = "", existingIds = []) {
  const used = new Set(existingIds.map(id => String(id ?? "").trim()).filter(Boolean));
  if (!used.has(baseId)) return baseId;
  let index = 2;
  while (used.has(`${baseId}${index}`)) index += 1;
  return `${baseId}${index}`;
}

function normalizeWeaponSpecialPropertiesInSubmitData(submitData = {}) {
  const functions = submitData?.system?.functions;
  if (!functions || typeof functions !== "object") return;
  normalizeSubmittedWeaponFunctionSpecialProperties(functions.weapon);

  const additionalWeapons = functions.additionalWeapons;
  if (Array.isArray(additionalWeapons)) {
    additionalWeapons.forEach(weaponData => normalizeSubmittedWeaponFunctionSpecialProperties(weaponData));
  } else {
    Object.values(additionalWeapons ?? {}).forEach(weaponData => normalizeSubmittedWeaponFunctionSpecialProperties(weaponData));
  }

  const moduleAdditionalWeapons = functions.module?.additionalWeapons;
  if (Array.isArray(moduleAdditionalWeapons)) {
    moduleAdditionalWeapons.forEach(weaponData => normalizeSubmittedWeaponFunctionSpecialProperties(weaponData));
  } else {
    Object.values(moduleAdditionalWeapons ?? {}).forEach(weaponData => normalizeSubmittedWeaponFunctionSpecialProperties(weaponData));
  }
}

function normalizeSubmittedAbilityItemUseConditions(form = null, submitData = {}) {
  for (const row of form?.querySelectorAll?.("[data-ability-condition-row]") ?? []) {
    const type = row.querySelector("input[name$='.type'], select[name$='.type']")?.value;
    if (type !== ABILITY_CONDITION_TYPES.itemUse) continue;

    const functionRow = row.closest("[data-ability-function-row]");
    const functionPath = String(functionRow?.dataset.functionPath ?? "");
    const functionIndex = Number(functionRow?.dataset.functionIndex ?? -1);
    const conditionIndex = Number(row.dataset.conditionIndex ?? -1);
    if (!functionPath || functionIndex < 0 || conditionIndex < 0) continue;

    const conditionPath = `${functionPath}.${functionIndex}.conditions.${conditionIndex}`;
    const categories = Array.from(row.querySelectorAll("[data-ability-item-use-category]") ?? [])
      .map(input => String(input.value ?? "").trim())
      .filter(Boolean);
    const durationSeconds = abilityDurationPartsToSeconds(
      row.querySelector("[data-ability-duration-amount]")?.value,
      row.querySelector("[data-ability-duration-unit]")?.value
    );

    foundry.utils.setProperty(submitData, `${conditionPath}.itemCategories`, categories);
    foundry.utils.setProperty(submitData, `${conditionPath}.durationSeconds`, durationSeconds);
  }
}

function normalizeSubmittedEventReactionFunctions(form = null, submitData = {}) {
  for (const row of form?.querySelectorAll?.("[data-ability-function-row][data-function-type='effectChanges']") ?? []) {
    const settingsRoot = row.querySelector("[data-ability-reaction-settings]");
    if (!settingsRoot) continue;
    const functionPath = String(row.dataset.functionPath ?? "");
    const functionIndex = Number(row.dataset.functionIndex ?? -1);
    if (!functionPath || functionIndex < 0) continue;

    const durationSeconds = Math.max(0, toInteger(
      settingsRoot.querySelector("[data-ability-reaction-duration-seconds]")?.value
    ));
    const costs = Array.from(settingsRoot.querySelectorAll("[data-ability-reaction-cost-row]") ?? []).map((costRow, index) => ({
      id: String(costRow.querySelector("[data-ability-reaction-cost-id]")?.value ?? costRow.dataset.costId ?? `cost-${index + 1}`).trim(),
      resourceKey: String(costRow.querySelector("[data-ability-reaction-resource-key]")?.value ?? "").trim(),
      formula: String(costRow.querySelector("[data-ability-reaction-cost-formula]")?.value ?? "0").trim()
    }));
    foundry.utils.setProperty(submitData, `${functionPath}.${functionIndex}.reactionSettings`, {
      durationSeconds,
      costs
    });
  }
}

function normalizeSubmittedActiveApplicationFunctions(form = null, submitData = {}) {
  for (const row of form?.querySelectorAll?.("[data-ability-function-row][data-function-type='activeApplication']") ?? []) {
    const functionPath = String(row.dataset.functionPath ?? "");
    const functionIndex = Number(row.dataset.functionIndex ?? -1);
    if (!functionPath || functionIndex < 0) continue;
    const overloadDurationSeconds = abilityDurationPartsToSeconds(
      row.querySelector("[data-active-application-overload-duration-amount]")?.value,
      row.querySelector("[data-active-application-overload-duration-unit]")?.value
    );
    const durationSeconds = abilityDurationPartsToSeconds(
      row.querySelector("[data-active-application-duration-amount]")?.value,
      row.querySelector("[data-active-application-duration-unit]")?.value
    );
    foundry.utils.setProperty(submitData, `${functionPath}.${functionIndex}.activeSettings.overloadDurationSeconds`, overloadDurationSeconds);
    foundry.utils.setProperty(submitData, `${functionPath}.${functionIndex}.activeSettings.durationSeconds`, durationSeconds);
  }
}

function normalizeSubmittedFixedAbilityFunctions(form = null, submitData = {}) {
  for (const row of form?.querySelectorAll?.("[data-ability-function-row][data-function-type='fixed']") ?? []) {
    const functionPath = String(row.dataset.functionPath ?? "");
    const functionIndex = Number(row.dataset.functionIndex ?? -1);
    const functionId = String(row.dataset.functionId ?? "").trim();
    const fixedKey = String(row.querySelector("input[name$='.fixedKey']")?.value ?? "").trim();
    if (!functionPath || functionIndex < 0) continue;

    if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.curseAndBlessing) {
      const durationSeconds = abilityDurationPartsToSeconds(
        row.querySelector("[data-fixed-curse-duration-amount]")?.value,
        row.querySelector("[data-fixed-curse-duration-unit]")?.value
      );
      foundry.utils.setProperty(submitData, `${functionPath}.${functionIndex}.fixedSettings.durationSeconds`, durationSeconds);
      continue;
    }

    if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.allOrNothing) {
      const durationSeconds = abilityDurationPartsToSeconds(
        row.querySelector("[data-fixed-all-or-nothing-overload-duration-amount]")?.value,
        row.querySelector("[data-fixed-all-or-nothing-overload-duration-unit]")?.value
      );
      foundry.utils.setProperty(submitData, `${functionPath}.${functionIndex}.fixedSettings.overloadDurationSeconds`, durationSeconds);
      continue;
    }

    if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.lastChance) {
      const durationSeconds = abilityDurationPartsToSeconds(
        row.querySelector("[data-fixed-last-chance-overload-duration-amount]")?.value,
        row.querySelector("[data-fixed-last-chance-overload-duration-unit]")?.value
      );
      foundry.utils.setProperty(submitData, `${functionPath}.${functionIndex}.fixedSettings.overloadDurationSeconds`, durationSeconds);
      continue;
    }

    if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.luckyCoin) {
      const durationSeconds = abilityDurationPartsToSeconds(
        row.querySelector("[data-fixed-lucky-coin-overload-duration-amount]")?.value,
        row.querySelector("[data-fixed-lucky-coin-overload-duration-unit]")?.value
      );
      foundry.utils.setProperty(submitData, `${functionPath}.${functionIndex}.fixedSettings.overloadDurationSeconds`, durationSeconds);
      continue;
    }

    if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.heightenedConcentration) {
      const durationSeconds = abilityDurationPartsToSeconds(
        row.querySelector("[data-fixed-heightened-concentration-overload-duration-amount]")?.value,
        row.querySelector("[data-fixed-heightened-concentration-overload-duration-unit]")?.value
      );
      foundry.utils.setProperty(submitData, `${functionPath}.${functionIndex}.fixedSettings.overloadDurationSeconds`, durationSeconds);
      continue;
    }

    if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.disarm) {
      const activeDurationSeconds = abilityDurationPartsToSeconds(
        row.querySelector("[data-fixed-disarm-active-overload-duration-amount]")?.value,
        row.querySelector("[data-fixed-disarm-active-overload-duration-unit]")?.value
      );
      const reactionDurationSeconds = abilityDurationPartsToSeconds(
        row.querySelector("[data-fixed-disarm-reaction-overload-duration-amount]")?.value,
        row.querySelector("[data-fixed-disarm-reaction-overload-duration-unit]")?.value
      );
      foundry.utils.setProperty(submitData, `${functionPath}.${functionIndex}.fixedSettings.activeOverloadDurationSeconds`, activeDurationSeconds);
      foundry.utils.setProperty(submitData, `${functionPath}.${functionIndex}.fixedSettings.reactionOverloadDurationSeconds`, reactionDurationSeconds);
      continue;
    }

    if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.rage) {
      const durationSeconds = abilityDurationPartsToSeconds(
        row.querySelector("[data-fixed-rage-duration-amount]")?.value,
        row.querySelector("[data-fixed-rage-duration-unit]")?.value
      );
      const overloadDurationSeconds = abilityDurationPartsToSeconds(
        row.querySelector("[data-fixed-rage-overload-duration-amount]")?.value,
        row.querySelector("[data-fixed-rage-overload-duration-unit]")?.value
      );
      foundry.utils.setProperty(submitData, `${functionPath}.${functionIndex}.fixedSettings.durationSeconds`, durationSeconds);
      foundry.utils.setProperty(submitData, `${functionPath}.${functionIndex}.fixedSettings.overloadDurationSeconds`, overloadDurationSeconds);
      continue;
    }

    if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.whirlwind) {
      const overloadDurationSeconds = abilityDurationPartsToSeconds(
        row.querySelector("[data-fixed-whirlwind-overload-duration-amount]")?.value,
        row.querySelector("[data-fixed-whirlwind-overload-duration-unit]")?.value
      );
      foundry.utils.setProperty(submitData, `${functionPath}.${functionIndex}.fixedSettings.overloadDurationSeconds`, overloadDurationSeconds);
      continue;
    }

    if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.lunge) {
      const overloadDurationSeconds = abilityDurationPartsToSeconds(
        row.querySelector("[data-fixed-lunge-overload-duration-amount]")?.value,
        row.querySelector("[data-fixed-lunge-overload-duration-unit]")?.value
      );
      foundry.utils.setProperty(submitData, `${functionPath}.${functionIndex}.fixedSettings.overloadDurationSeconds`, overloadDurationSeconds);
      continue;
    }

    if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.counterAttack) {
      const overloadDurationSeconds = abilityDurationPartsToSeconds(
        row.querySelector("[data-fixed-counter-attack-overload-duration-amount]")?.value,
        row.querySelector("[data-fixed-counter-attack-overload-duration-unit]")?.value
      );
      foundry.utils.setProperty(submitData, `${functionPath}.${functionIndex}.fixedSettings.reactionOverloadDurationSeconds`, overloadDurationSeconds);
      continue;
    }

    if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.commandBasics) {
      const overloadDurationSeconds = abilityDurationPartsToSeconds(
        row.querySelector("[data-fixed-command-basics-overload-duration-amount]")?.value,
        row.querySelector("[data-fixed-command-basics-overload-duration-unit]")?.value
      );
      const dodgeDurationSeconds = abilityDurationPartsToSeconds(
        row.querySelector("[data-fixed-command-basics-dodge-duration-amount]")?.value,
        row.querySelector("[data-fixed-command-basics-dodge-duration-unit]")?.value
      );
      foundry.utils.setProperty(submitData, `${functionPath}.${functionIndex}.fixedSettings.overloadDurationSeconds`, overloadDurationSeconds);
      foundry.utils.setProperty(submitData, `${functionPath}.${functionIndex}.fixedSettings.dodgeDurationSeconds`, dodgeDurationSeconds);
      continue;
    }

    if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.knockOffBalance) {
      const overloadDurationSeconds = abilityDurationPartsToSeconds(
        row.querySelector("[data-fixed-knock-off-balance-overload-duration-amount]")?.value,
        row.querySelector("[data-fixed-knock-off-balance-overload-duration-unit]")?.value
      );
      const debuffDurationSeconds = abilityDurationPartsToSeconds(
        row.querySelector("[data-fixed-knock-off-balance-debuff-duration-amount]")?.value,
        row.querySelector("[data-fixed-knock-off-balance-debuff-duration-unit]")?.value
      );
      foundry.utils.setProperty(submitData, `${functionPath}.${functionIndex}.fixedSettings.overloadDurationSeconds`, overloadDurationSeconds);
      foundry.utils.setProperty(submitData, `${functionPath}.${functionIndex}.fixedSettings.debuffDurationSeconds`, debuffDurationSeconds);
      continue;
    }

    if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.look) {
      const overloadDurationSeconds = abilityDurationPartsToSeconds(
        row.querySelector("[data-fixed-look-overload-duration-amount]")?.value,
        row.querySelector("[data-fixed-look-overload-duration-unit]")?.value
      );
      foundry.utils.setProperty(submitData, `${functionPath}.${functionIndex}.fixedSettings.overloadDurationSeconds`, overloadDurationSeconds);
      continue;
    }

    if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.toTheEnd) {
      const overloadDurationSeconds = abilityDurationPartsToSeconds(
        row.querySelector("[data-fixed-to-the-end-overload-duration-amount]")?.value,
        row.querySelector("[data-fixed-to-the-end-overload-duration-unit]")?.value
      );
      const durationSeconds = abilityDurationPartsToSeconds(
        row.querySelector("[data-fixed-to-the-end-duration-amount]")?.value,
        row.querySelector("[data-fixed-to-the-end-duration-unit]")?.value
      );
      const suppressTraumas = Boolean(row.querySelector("[data-fixed-to-the-end-suppress-traumas]")?.checked);
      const advantageSkills = readSubmittedToTheEndAdvantageSkills(row);
      foundry.utils.setProperty(submitData, `${functionPath}.${functionIndex}.fixedSettings.overloadDurationSeconds`, overloadDurationSeconds);
      foundry.utils.setProperty(submitData, `${functionPath}.${functionIndex}.fixedSettings.durationSeconds`, durationSeconds);
      foundry.utils.setProperty(submitData, `${functionPath}.${functionIndex}.fixedSettings.advantageSkills`, advantageSkills);
      foundry.utils.setProperty(submitData, `${functionPath}.${functionIndex}.fixedSettings.suppressTraumas`, suppressTraumas);
      continue;
    }

    if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.oversight) {
      const overloadDurationSeconds = abilityDurationPartsToSeconds(
        row.querySelector("[data-fixed-oversight-overload-duration-amount]")?.value,
        row.querySelector("[data-fixed-oversight-overload-duration-unit]")?.value
      );
      foundry.utils.setProperty(submitData, `${functionPath}.${functionIndex}.fixedSettings.overloadDurationSeconds`, overloadDurationSeconds);
      continue;
    }

    if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.watchOut) {
      const overloadDurationSeconds = abilityDurationPartsToSeconds(
        row.querySelector("[data-fixed-watch-out-overload-duration-amount]")?.value,
        row.querySelector("[data-fixed-watch-out-overload-duration-unit]")?.value
      );
      foundry.utils.setProperty(submitData, `${functionPath}.${functionIndex}.fixedSettings.reactionOverloadDurationSeconds`, overloadDurationSeconds);
      continue;
    }

    if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.fullControl) {
      const durationSeconds = abilityDurationPartsToSeconds(
        row.querySelector("[data-fixed-full-control-duration-amount]")?.value,
        row.querySelector("[data-fixed-full-control-duration-unit]")?.value
      );
      foundry.utils.setProperty(submitData, `${functionPath}.${functionIndex}.fixedSettings.durationSeconds`, durationSeconds);
      continue;
    }

    if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.whereAreYouGoing) {
      const overloadDurationSeconds = abilityDurationPartsToSeconds(
        row.querySelector("[data-fixed-where-are-you-going-overload-duration-amount]")?.value,
        row.querySelector("[data-fixed-where-are-you-going-overload-duration-unit]")?.value
      );
      foundry.utils.setProperty(submitData, `${functionPath}.${functionIndex}.fixedSettings.reactionOverloadDurationSeconds`, overloadDurationSeconds);
      continue;
    }

    if (fixedKey !== ABILITY_FIXED_FUNCTION_KEYS.deusExMachina) continue;

    const durationSeconds = abilityDurationPartsToSeconds(
      row.querySelector("[data-fixed-insight-duration-amount]")?.value,
      row.querySelector("[data-fixed-insight-duration-unit]")?.value
    );
    foundry.utils.setProperty(submitData, `${functionPath}.${functionIndex}.fixedSettings.insight.durationSeconds`, durationSeconds);

    const stateKey = [functionId, fixedKey].filter(Boolean).join(":");
    const currentDamage = Math.max(0, toInteger(row.querySelector("[data-fixed-damage-current]")?.value));
    const requiredDamage = Math.max(1, toInteger(row.querySelector("input[name$='.fixedSettings.damageRequired']")?.value));
    foundry.utils.setProperty(
      submitData,
      `flags.${SYSTEM_ID}.${ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY}.${stateKey}.fixedKey`,
      fixedKey
    );
    foundry.utils.setProperty(
      submitData,
      `flags.${SYSTEM_ID}.${ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY}.${stateKey}.damage`,
      currentDamage
    );
    foundry.utils.setProperty(
      submitData,
      `flags.${SYSTEM_ID}.${ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY}.${stateKey}.readyNotified`,
      currentDamage >= requiredDamage
    );
  }
}

function readSubmittedToTheEndAdvantageSkills(row) {
  return Array.from(row.querySelectorAll("[data-fixed-to-the-end-advantage-skill-row]") ?? []).map(skillRow => ({
    skillKey: skillRow.querySelector("[data-fixed-to-the-end-advantage-skill-key]")?.value,
    advantageCount: skillRow.querySelector("[data-fixed-to-the-end-advantage-count]")?.value
  }));
}

function syncFixedRescueCountVisibility(select) {
  const row = select?.closest?.(".fallout-maw-fixed-settings-row");
  const countField = row?.querySelector?.("[data-fixed-rescue-count]");
  if (countField) countField.hidden = String(select.value ?? "all") !== "count";
}

function normalizeSubmittedWeaponFunctionSpecialProperties(weaponData = null) {
  if (!weaponData || typeof weaponData !== "object") return;
  if (!Object.hasOwn(weaponData, "specialProperties")) return;
  weaponData.specialProperties = normalizeWeaponSpecialProperties(weaponData.specialProperties);
}

function buildWeaponFunctionSections(
  item,
  damageTypeSettings,
  skillSettings,
  proficiencySettings,
  characteristicSettings,
  hasConditionFunction,
  hasEnergyConsumerFunction
) {
  const sections = [];
  if (hasItemFunction(item, ITEM_FUNCTIONS.weapon, { ignoreBroken: true })) {
    const primaryWeapon = item.system?.functions?.weapon ?? {};
    const sourcePrimaryWeapon = item.system?._source?.functions?.weapon ?? {};
    const additionalWeapons = getAdditionalWeaponFunctionEntries(item);
    const sourceAdditionalWeapons = getAdditionalWeaponFunctionEntries({ system: item.system?._source ?? {} });
    sections.push(buildWeaponFunctionSection({
      title: game.i18n.localize("FALLOUTMAW.Item.FunctionWeapon"),
      tabId: ITEM_FUNCTIONS.weapon,
      path: "system.functions.weapon",
      weaponData: primaryWeapon,
      sourceWeaponData: sourcePrimaryWeapon,
      damageTypeSettings,
      skillSettings,
      proficiencySettings,
      characteristicSettings,
      hasConditionFunction,
      hasEnergyConsumerFunction,
      isPrimary: true,
      canAddAdditional: true,
      canHaveModuleSlots: true
    }));
    sections.push(...additionalWeapons.map(({ id, data: weaponData }, index) => buildWeaponFunctionSection({
      title: String(weaponData?.name ?? "").trim() || getDefaultAdditionalWeaponFunctionName(index),
      tabId: getAdditionalWeaponFunctionTabId(id),
      path: `system.functions.additionalWeapons.${id}`,
      weaponData,
      sourceWeaponData: sourceAdditionalWeapons.find(entry => entry.id === id)?.data ?? {},
      damageTypeSettings,
      skillSettings,
      proficiencySettings,
      characteristicSettings,
      hasConditionFunction,
      hasEnergyConsumerFunction,
      isAdditional: true,
      isNamed: true,
      id,
      index
    })));
  }
  if (hasItemFunction(item, ITEM_FUNCTIONS.module, { ignoreBroken: true })) {
    const moduleWeapons = getModuleWeaponFunctionEntries(item);
    const sourceModuleWeapons = getModuleWeaponFunctionEntries({ system: item.system?._source ?? {} });
    sections.push(...moduleWeapons.map(({ id, data: weaponData }, index) => buildWeaponFunctionSection({
      title: String(weaponData?.name ?? "").trim() || getDefaultAdditionalWeaponFunctionName(index),
      tabId: getModuleWeaponFunctionTabId(id),
      path: `system.functions.module.additionalWeapons.${id}`,
      weaponData,
      sourceWeaponData: sourceModuleWeapons.find(entry => entry.id === id)?.data ?? {},
      damageTypeSettings,
      skillSettings,
      proficiencySettings,
      characteristicSettings,
      hasConditionFunction,
      hasEnergyConsumerFunction,
      isModuleWeapon: true,
      isNamed: true,
      id,
      index
    })));
  }
  return sections;
}

function buildWeaponFunctionTabs(sections = []) {
  return sections.map(section => ({
    id: section.tabId,
    title: section.title,
    active: Boolean(section.active),
    canDelete: Boolean(section.isAdditional || section.isModuleWeapon),
    deleteId: section.id,
    isAdditional: section.isAdditional,
    isModuleWeapon: section.isModuleWeapon
  }));
}

function resolveActiveWeaponFunctionTab(activeTab = ITEM_FUNCTIONS.weapon, sections = []) {
  if (sections.some(section => section.tabId === activeTab)) return activeTab;
  return sections.at(0)?.tabId ?? ITEM_FUNCTIONS.weapon;
}

function getAdditionalWeaponFunctionTabId(id = "") {
  return `additional:${String(id ?? "")}`;
}

function getModuleWeaponFunctionTabId(id = "") {
  return `module:${String(id ?? "")}`;
}

function buildWeaponFunctionSection({
  title = "",
  tabId = ITEM_FUNCTIONS.weapon,
  path = "system.functions.weapon",
  weaponData = {},
  sourceWeaponData = {},
  damageTypeSettings = [],
  skillSettings = [],
  proficiencySettings = [],
  characteristicSettings = [],
  hasConditionFunction = false,
  hasEnergyConsumerFunction = false,
  isPrimary = false,
  canAddAdditional = false,
  canHaveModuleSlots = false,
  isAdditional = false,
  isModuleWeapon = false,
  isNamed = false,
  id = "",
  index = -1
} = {}) {
  const formWeaponData = getWeaponFormData(weaponData, sourceWeaponData);
  const effectiveWeaponData = getWeaponDisplayData(formWeaponData);
  return {
    title,
    tabId,
    path,
    weaponData: formWeaponData,
    effectiveWeaponData,
    isPrimary,
    isAdditional,
    isModuleWeapon,
    isNamed,
    canAddAdditional,
    canHaveModuleSlots,
    id,
    index,
    damageModeChoices: buildWeaponDamageModeChoices(formWeaponData?.damageMode),
    usesDamageSource: isSourceDamageMode(formWeaponData),
    hasMagazineCost: hasWeaponResourceCostData(formWeaponData, "magazine") || isSourceDamageMode(formWeaponData),
    magazineSourceItems: buildWeaponMagazineSourceItems(formWeaponData),
    moduleSlots: canHaveModuleSlots ? buildWeaponModuleSlotRows(formWeaponData) : [],
    hasVolleyAction: Boolean(formWeaponData?.availableActions?.volley),
    damageTypeRows: buildWeaponDamageTypeRowsForData(effectiveWeaponData, damageTypeSettings, formWeaponData),
    skillChoices: buildWeaponSkillChoicesForData(formWeaponData, skillSettings),
    proficiencyChoices: buildWeaponProficiencyChoicesForData(formWeaponData, proficiencySettings),
    resourceCosts: buildWeaponResourceCostRowsForData(formWeaponData, hasConditionFunction, hasEnergyConsumerFunction),
    specialProperties: buildWeaponSpecialPropertyRowsForData(formWeaponData),
    requirements: buildWeaponRequirementRowsForData(formWeaponData, characteristicSettings, skillSettings),
    actionChoices: buildWeaponActionChoicesForData(effectiveWeaponData, formWeaponData, damageTypeSettings)
  };
}

function getWeaponFormData(weaponData = {}, sourceWeaponData = {}) {
  // Form controls must submit persisted values, not derived source or module totals.
  const formData = foundry.utils.deepClone(weaponData ?? {});
  if (!sourceWeaponData || typeof sourceWeaponData !== "object") return formData;
  return foundry.utils.mergeObject(formData, sourceWeaponData, { inplace: true });
}

function buildWeaponModuleChoices(excludeItem = null) {
  const excludeUuid = String(excludeItem?.uuid ?? "");
  const choices = getAllWorldAndActorItems()
    .filter(item => item?.uuid !== excludeUuid && isWeaponModuleItem(item))
    .map(item => ({
      value: getWeaponModuleTechnicalName(item),
      label: getWeaponModuleTechnicalName(item),
      uuid: item.uuid
    }))
    .filter(choice => choice.value);
  const unique = [];
  const used = new Set();
  for (const choice of choices) {
    if (used.has(choice.value)) continue;
    used.add(choice.value);
    unique.push(choice);
  }
  return unique.length ? unique : [{
    value: "",
    label: game.i18n.localize("FALLOUTMAW.Item.WeaponModuleNoAvailable")
  }];
}

function buildWeaponModuleSlotRows(weaponData = {}) {
  const slots = getWeaponModuleSlots(weaponData);
  const usedModuleKeys = new Set(slots.map(slot => String(slot.moduleKey ?? "").trim()).filter(Boolean));
  return slots.map((slot, index) => {
    const itemData = getWeaponModuleSlotItemData(slot);
    return {
      index,
      id: slot.id,
      moduleKey: slot.moduleKey,
      choices: buildWeaponModuleSlotChoices(slot.moduleKey, usedModuleKeys),
      item: itemData ? {
        name: getWeaponModuleTechnicalName(itemData),
        img: normalizeImagePath(itemData.img, FALLBACK_ICON)
      } : null
    };
  });
}

function buildWeaponModuleSlotChoices(selected = "", excludedKeys = new Set()) {
  const selectedKey = String(selected ?? "");
  const availableChoices = buildWeaponModuleChoices()
    .filter(choice => !excludedKeys.has(choice.value) || choice.value === selectedKey || !choice.value);
  const moduleChoices = availableChoices.some(choice => choice.value) ? availableChoices : [{
    value: "",
    label: game.i18n.localize("FALLOUTMAW.Item.WeaponModuleNoAvailable")
  }];
  return [
    {
      value: "",
      label: game.i18n.localize("FALLOUTMAW.Item.WeaponModuleChooseSlot"),
      selected: !selectedKey,
      disabled: true
    },
    ...moduleChoices.map(choice => ({
      ...choice,
      selected: choice.value === selectedKey,
      disabled: !choice.value
    }))
  ];
}

function buildWeaponResourceCostRows(item, hasConditionFunction, hasEnergyConsumerFunction) {
  return buildWeaponResourceCostRowsForData(
    item.system?.functions?.weapon ?? {},
    hasConditionFunction,
    hasEnergyConsumerFunction
  );
}

function buildWeaponResourceCostRowsForData(weaponData, hasConditionFunction, hasEnergyConsumerFunction) {
  const costs = Array.isArray(weaponData?.resourceCosts)
    ? weaponData.resourceCosts
    : Object.values(weaponData?.resourceCosts ?? {});
  let lockedMagazineUsed = false;
  const rows = costs.map((cost, index) => {
    const type = String(cost?.type ?? "magazine");
    const locked = isSourceDamageMode(weaponData) && type === "magazine" && !lockedMagazineUsed;
    if (type === "magazine") lockedMagazineUsed = true;
    return {
      index,
      amount: Number(cost.amount) || 0,
      locked,
      type,
      typeChoices: buildWeaponResourceTypeChoices(type, hasConditionFunction, hasEnergyConsumerFunction)
    };
  });
  if (isSourceDamageMode(weaponData) && !lockedMagazineUsed) {
    rows.push({
      index: costs.length,
      amount: 1,
      locked: true,
      type: "magazine",
      typeChoices: buildWeaponResourceTypeChoices("magazine", hasConditionFunction, hasEnergyConsumerFunction)
    });
  }
  return rows;
}

function isLockedWeaponMagazineResourceCost(weaponData = {}, costs = [], index = -1) {
  if (!isSourceDamageMode(weaponData) || !Number.isInteger(index) || index < 0) return false;
  if (String(costs[index]?.type ?? "") !== "magazine") return false;
  return !costs.slice(0, index).some(cost => String(cost?.type ?? "") === "magazine");
}

function getDefaultNewWeaponResourceCostType(
  weaponData = {},
  hasConditionFunction = false,
  hasEnergyConsumerFunction = false
) {
  const used = new Set((weaponData?.resourceCosts ?? []).map(cost => String(cost?.type ?? "")));
  if (isSourceDamageMode(weaponData)) used.add("magazine");
  if (hasEnergyConsumerFunction && !used.has("energyConsumer")) return "energyConsumer";
  if (hasConditionFunction && !used.has("condition")) return "condition";
  if (!used.has("quantity")) return "quantity";
  if (!used.has("magazine")) return "magazine";
  return hasConditionFunction ? "condition" : "quantity";
}

function buildWeaponSpecialPropertyRowsForData(weaponData) {
  const properties = normalizeWeaponSpecialProperties(weaponData?.specialProperties ?? []);
  return properties.map((property, index) => ({
    index,
    type: getWeaponSpecialPropertyType(property),
    choices: buildWeaponSpecialPropertyChoices(property, properties),
    isAttackPower: getWeaponSpecialPropertyType(property) === WEAPON_SPECIAL_PROPERTIES.attackPower,
    attackPower: buildWeaponAttackPowerSettingsForData(weaponData, property)
  }));
}

function buildWeaponSpecialPropertyChoices(selected, properties = []) {
  const selectedType = getWeaponSpecialPropertyType(selected);
  const usedTypes = new Set(properties.map(property => getWeaponSpecialPropertyType(property)).filter(Boolean));
    return [
      {
      value: WEAPON_SPECIAL_PROPERTIES.pending,
      label: game.i18n.localize("FALLOUTMAW.Item.WeaponSpecialPropertyChoose"),
      disabled: false
    },
    {
      value: WEAPON_SPECIAL_PROPERTIES.hitAllConeTargets,
      label: game.i18n.localize("FALLOUTMAW.Item.WeaponSpecialHitAllConeTargets")
    },
    {
      value: WEAPON_SPECIAL_PROPERTIES.attackPower,
      label: game.i18n.localize("FALLOUTMAW.Item.WeaponSpecialAttackPower")
    }
  ].map(choice => ({
    ...choice,
    selected: choice.value === selectedType,
    disabled: Boolean(choice.disabled || (
      choice.value
      && choice.value !== WEAPON_SPECIAL_PROPERTIES.pending
      && choice.value !== selectedType
      && usedTypes.has(choice.value)
    ))
  }));
}

function buildWeaponAttackPowerSettingsForData(weaponData = {}, property = {}) {
  const attackPower = normalizeWeaponAttackPowerData(property?.attackPower);
  const perLevel = attackPower.perLevel;
  return {
    level: attackPower.level,
    perLevel,
    resourceCostRows: buildWeaponAttackPowerResourceCostRows(weaponData, attackPower.resourceCosts)
  };
}

function buildWeaponAttackPowerResourceCostRows(weaponData = {}, configuredCosts = []) {
  const configured = new Map((configuredCosts ?? []).map(cost => [String(cost?.type ?? ""), toInteger(cost?.amount)]));
  const baseCosts = getWeaponAttackPowerBaseResourceCosts(weaponData);
  const types = new Set([
    ...baseCosts.map(cost => cost.type),
    ...configured.keys()
  ]);
  return Array.from(types)
    .filter(Boolean)
    .map((type, index) => {
      const base = baseCosts.find(cost => cost.type === type)?.amount ?? 0;
      return {
        index,
        type,
        label: getWeaponResourceTypeLabel(type),
        base,
        amount: configured.get(type) ?? 0
      };
    });
}

function getWeaponAttackPowerBaseResourceCosts(weaponData = {}) {
  const costs = Array.isArray(weaponData?.resourceCosts)
    ? weaponData.resourceCosts
    : Object.values(weaponData?.resourceCosts ?? {});
  const totals = new Map();
  for (const cost of costs) {
    const type = String(cost?.type ?? "").trim();
    if (!type) continue;
    totals.set(type, (totals.get(type) ?? 0) + Math.max(0, toInteger(cost?.amount)));
  }
  if (isSourceDamageMode(weaponData) && !totals.has("magazine")) totals.set("magazine", 1);
  return Array.from(totals, ([type, amount]) => ({ type, amount }));
}

function buildWeaponRequirementRowsForData(weaponData, characteristicSettings = [], skillSettings = []) {
  return (weaponData?.requirements ?? []).map((requirement, index) => {
    const type = String(requirement?.type ?? "characteristic") === "skill" ? "skill" : "characteristic";
    return {
      index,
      type,
      key: String(requirement?.key ?? ""),
      value: Math.max(0, Number(requirement?.value) || 0),
      typeChoices: buildWeaponRequirementTypeChoices(type),
      keyChoices: buildWeaponRequirementKeyChoices(type, requirement?.key, characteristicSettings, skillSettings)
    };
  });
}

function buildWeaponRequirementTypeChoices(selected) {
  return [
    { value: "characteristic", label: game.i18n.localize("FALLOUTMAW.Item.WeaponRequirementCharacteristic") },
    { value: "skill", label: game.i18n.localize("FALLOUTMAW.Item.WeaponRequirementSkill") }
  ].map(choice => ({
    ...choice,
    selected: choice.value === selected
  }));
}

function buildWeaponRequirementKeyChoices(type, selected, characteristicSettings = [], skillSettings = []) {
  const entries = type === "skill" ? skillSettings : characteristicSettings;
  return entries.map(entry => ({
    value: entry.key,
    label: entry.label,
    selected: entry.key === String(selected ?? "")
  }));
}

function buildWeaponSlotRequirementModeChoices(selected) {
  const value = selected === "all" ? "all" : "oneOf";
  return [
    { value: "oneOf", label: game.i18n.localize("FALLOUTMAW.Item.WeaponSlotModeOneOf") },
    { value: "all", label: game.i18n.localize("FALLOUTMAW.Item.WeaponSlotModeAll") }
  ].map(choice => ({
    ...choice,
    selected: choice.value === value
  }));
}

function getAvailableWeaponResourceTypes(weaponData = {}) {
  return Array.from(new Set((weaponData?.resourceCosts ?? [])
    .map(cost => String(cost?.type ?? "").trim())
    .filter(Boolean)));
}

function getWeaponResourceTypeLabel(type = "") {
  if (type === "magazine") return game.i18n.localize("FALLOUTMAW.Item.WeaponCostMagazine");
  if (type === "condition") return game.i18n.localize("FALLOUTMAW.Item.WeaponCostCondition");
  if (type === "energyConsumer") return game.i18n.localize("FALLOUTMAW.Item.WeaponCostEnergy");
  if (type === "quantity") return game.i18n.localize("FALLOUTMAW.Item.WeaponCostQuantity");
  return String(type || "-");
}

function buildWeaponCriticalFailureConsequenceRows(actionData = {}, weaponData = {}) {
  const resourceTypes = getAvailableWeaponResourceTypes(weaponData);
  return (actionData?.criticalFailureConsequences ?? []).map((consequence, index) => ({
    index,
    type: String(consequence?.type ?? "extraResourceCost"),
    amount: Number(consequence?.amount) || 0,
    typeChoices: [{
      value: "extraResourceCost",
      label: game.i18n.localize("FALLOUTMAW.Item.WeaponCriticalFailureExtraResourceCost"),
      selected: true
    }],
    resourceChoices: resourceTypes.map(type => ({
      value: type,
      label: getWeaponResourceTypeLabel(type),
      selected: type === String(consequence?.resourceType ?? "")
    }))
  }));
}

function buildWeaponDamageTypeChoices(item, damageTypeSettings) {
  const choices = getConfigurableDamageTypes(damageTypeSettings);
  const selected = String(item.system?.functions?.weapon?.damageTypeKey ?? "");
  return choices.map(damageType => ({
    value: damageType.key,
    label: damageType.label,
    selected: damageType.key === selected
  }));
}

function buildWeaponDamageTypeRows(item, damageTypeSettings) {
  return buildWeaponDamageTypeRowsForData(
    item.system?.functions?.weapon,
    damageTypeSettings,
    item.system?._source?.functions?.weapon
  );
}

function buildDamageSourceDamageTypeRows(item, damageTypeSettings) {
  return buildWeaponDamageTypeRowsForData(
    item.system?.functions?.damageSource,
    damageTypeSettings,
    item.system?._source?.functions?.damageSource
  );
}

function buildDamageSourceVolleyRegionDamageRows(item, damageTypeSettings) {
  return buildVolleyRegionDamageRowsForData(
    item.system?.functions?.damageSource?.volley?.regionDamageEntries,
    damageTypeSettings
  );
}

function buildWeaponDamageModeChoices(selected = "manual") {
  const value = String(selected ?? "") === "source" ? "source" : "manual";
  return [
    { value: "manual", label: game.i18n.localize("FALLOUTMAW.Item.WeaponDamageModeManual") },
    { value: "source", label: game.i18n.localize("FALLOUTMAW.Item.WeaponDamageModeSource") }
  ].map(choice => ({
    ...choice,
    selected: choice.value === value
  }));
}

function isSourceDamageMode(weaponData = {}) {
  return String(weaponData?.damageMode ?? "manual") === "source";
}

function getWeaponDisplayData(weaponData = {}) {
  if (!isSourceDamageMode(weaponData)) return weaponData;
  const sourceItem = getWeaponMagazineSourceItem(weaponData);
  if (!sourceItem || !hasItemFunction(sourceItem, ITEM_FUNCTIONS.damageSource)) return weaponData;
  const source = getDamageSourceFunction(sourceItem);
  return {
    ...weaponData,
    damage: source.damage,
    pellets: normalizeDamageFormula(source.pellets || "1"),
    damageTypeKey: source.damageTypeKey,
    damageTypes: source.damageTypes,
    attackAnimationKey: String(source.attackAnimationKey ?? ""),
    accuracyBonus: addFormulaTexts(weaponData.accuracyBonus, source.accuracyBonus),
    criticalChanceModifier: addFormulaTexts(weaponData.criticalChanceModifier, source.criticalChanceModifier),
    criticalDamagePercent: addFormulaTexts(weaponData.criticalDamagePercent, source.criticalDamagePercent),
    maxRangeMeters: addFormulaTexts(weaponData.maxRangeMeters, source.maxRangeMeters),
    effectiveRange: {
      value: addFormulaTexts(weaponData.effectiveRange?.value, source.effectiveRange?.value),
      max: addFormulaTexts(weaponData.effectiveRange?.max, source.effectiveRange?.max)
    },
    penetration: addFormulaTexts(weaponData.penetration, source.penetration),
    volley: mergeDamageSourceVolleyData(weaponData.volley, source.volley)
  };
}

function mergeDamageSourceVolleyData(weaponVolley = {}, sourceVolley = {}) {
  return {
    ...(weaponVolley ?? {}),
    damageRadius: normalizeDamageFormula(sourceVolley?.damageRadius),
    regionRadius: normalizeDamageFormula(sourceVolley?.regionRadius),
    regionDamageEntries: Array.isArray(sourceVolley?.regionDamageEntries)
      ? foundry.utils.deepClone(sourceVolley.regionDamageEntries)
      : [],
    regionDurationSeconds: normalizeDamageFormula(sourceVolley?.regionDurationSeconds),
    regionDelaySeconds: normalizeDamageFormula(sourceVolley?.regionDelaySeconds),
    regionRadiusDeltaMeters: normalizeDamageFormula(sourceVolley?.regionRadiusDeltaMeters),
    explosionAnimationKey: String(sourceVolley?.explosionAnimationKey ?? "")
  };
}

function addFormulaTexts(left, right) {
  const leftText = normalizeDamageFormula(left);
  const rightText = normalizeDamageFormula(right);
  if (leftText === "0") return rightText;
  if (rightText === "0") return leftText;
  return `(${leftText}) + (${rightText})`;
}

function buildWeaponMagazineSourceItems(weaponData = {}) {
  const activeUuid = String(weaponData?.magazine?.sourceItemUuid ?? "").trim();
  const rows = getWeaponMagazineSourceUuids(weaponData).map((uuid, index) => {
    const item = getWeaponMagazineSourceItem({ magazine: { sourceItemUuid: uuid } });
    const source = item ? getDamageSourceFunction(item) : null;
    return {
      index,
      uuid,
      name: String(source?.name ?? "").trim() || item?.name || uuid,
      img: normalizeImagePath(item?.img, FALLBACK_ICON),
      active: uuid === activeUuid,
      empty: false
    };
  });
  rows.push({
    index: rows.length,
    uuid: "",
    name: "",
    active: false,
    empty: true
  });
  return rows;
}

function buildEnergyClassChoices(selected = "D") {
  const current = String(selected ?? "D") || "D";
  return ["D", "C", "B", "A", "S"].map(value => ({
    value,
    label: value,
    selected: value === current
  }));
}

function buildEnergyConsumerSourceItems(consumerData = {}) {
  const installed = normalizeInstalledEnergySourceData(consumerData?.installedSource);
  const activeUuid = installed.sourceItemUuid || String(consumerData?.sourceItemUuid ?? "").trim();
  const rows = getEnergyConsumerSourceUuids(consumerData).map((uuid, index) => {
    const item = getEnergyConsumerSourceItem({ sourceItemUuid: uuid });
    const source = item ? getEnergySourceFunction(item) : null;
    const active = uuid === activeUuid;
    return {
      index,
      uuid,
      name: String(source?.name ?? "").trim() || item?.name || uuid,
      class: String(source?.class ?? "").trim(),
      img: normalizeImagePath(item?.img, FALLBACK_ICON),
      active,
      reserve: active && installed.sourceItemUuid === uuid
        ? installed.reserve
        : {
          value: Math.max(0, Number(source?.reserve?.value) || Number(source?.reserve?.max) || 0),
          max: Math.max(0, Number(source?.reserve?.max) || 0)
        },
      empty: false
    };
  });
  rows.push({
    index: rows.length,
    uuid: "",
    name: "",
    active: false,
    empty: true
  });
  return rows;
}

function getEnergyConsumerInstalledSourceRow(consumerData = {}) {
  const installed = normalizeInstalledEnergySourceData(consumerData?.installedSource);
  if (!installed.sourceItemUuid) return null;
  const sourceItem = getEnergyConsumerSourceItem({ sourceItemUuid: installed.sourceItemUuid });
  return {
    uuid: installed.sourceItemUuid,
    name: installed.name || String(getEnergySourceFunction(sourceItem)?.name ?? "").trim() || sourceItem?.name || installed.sourceItemUuid,
    class: installed.class || String(getEnergySourceFunction(sourceItem)?.class ?? "").trim(),
    img: normalizeImagePath(installed.img || sourceItem?.img, FALLBACK_ICON),
    reserve: installed.reserve
  };
}

function createInstalledEnergySourceData(item = null) {
  if (!item) return createEmptyInstalledEnergySourceData();
  const source = getEnergySourceFunction(item);
  const max = Math.max(0, Number(source?.reserve?.max) || 0);
  const value = Math.max(0, Number(source?.reserve?.value) || max);
  const itemData = typeof item.toObject === "function" ? item.toObject() : {};
  delete itemData._id;
  return normalizeInstalledEnergySourceData({
    sourceItemUuid: item.uuid,
    name: String(source?.name ?? "").trim() || item.name || "",
    class: String(source?.class ?? "").trim(),
    img: String(item.img ?? "").trim(),
    itemData,
    reserve: {
      value,
      max
    }
  });
}

function createEmptyInstalledEnergySourceData() {
  return normalizeInstalledEnergySourceData();
}

function normalizeInstalledEnergySourceData(source = {}) {
  const max = Math.max(0, Number(source?.reserve?.max) || 0);
  const value = Math.max(0, Math.min(max || Number.POSITIVE_INFINITY, Number(source?.reserve?.value) || 0));
  return {
    sourceItemUuid: String(source?.sourceItemUuid ?? "").trim(),
    name: String(source?.name ?? "").trim(),
    class: String(source?.class ?? "").trim(),
    img: String(source?.img ?? "").trim(),
    itemData: source?.itemData && typeof source.itemData === "object" ? foundry.utils.deepClone(source.itemData) : {},
    reserve: {
      value,
      max
    }
  };
}

function getEnergyConsumerSourceItem(consumerData = {}) {
  const uuid = String(consumerData?.sourceItemUuid ?? "").trim();
  if (!uuid) return null;
  return resolveWorldItemSync(uuid);
}

function getEnergyConsumerSourceUuids(consumerData = {}) {
  return uniqueStrings([
    ...(Array.isArray(consumerData?.sourceItemUuids) ? consumerData.sourceItemUuids : []),
    String(consumerData?.sourceItemUuid ?? "")
  ]);
}

function buildLightSourceResourceCostRows(item, hasConditionFunction = false, hasEnergyConsumerFunction = false) {
  return (item.system?.functions?.lightSource?.resourceCosts ?? []).map((cost, index) => {
    const selected = String(cost?.type ?? "energyConsumer");
    return {
      index,
      type: selected,
      amountPerHour: Number(cost?.amountPerHour) || 0,
      typeChoices: buildLightSourceResourceTypeChoices(selected, hasConditionFunction, hasEnergyConsumerFunction)
    };
  });
}

function buildLightSourceResourceTypeChoices(selected, hasConditionFunction = false, hasEnergyConsumerFunction = false) {
  const choices = [];
  if (hasEnergyConsumerFunction) choices.push({ value: "energyConsumer", label: game.i18n.localize("FALLOUTMAW.Item.FunctionEnergyConsumer") });
  if (hasConditionFunction) choices.push({ value: "condition", label: game.i18n.localize("FALLOUTMAW.Item.WeaponCostCondition") });
  if (!choices.length) choices.push({ value: "energyConsumer", label: game.i18n.localize("FALLOUTMAW.Item.FunctionEnergyConsumer") });
  if (!choices.some(choice => choice.value === selected)) choices.push({ value: selected, label: selected });
  return choices.map(choice => ({
    ...choice,
    selected: choice.value === selected
  }));
}

function getWeaponMagazineSourceItem(weaponData = {}) {
  const uuid = String(weaponData?.magazine?.sourceItemUuid ?? "").trim();
  if (!uuid) return null;
  return resolveWorldItemSync(uuid);
}

function getWeaponMagazineSourceUuids(weaponData = {}) {
  return uniqueStrings([
    ...(Array.isArray(weaponData?.magazine?.sourceItemUuids) ? weaponData.magazine.sourceItemUuids : []),
    String(weaponData?.magazine?.sourceItemUuid ?? "")
  ]);
}

function uniqueStrings(values = []) {
  return Array.from(new Set((values ?? []).map(value => String(value ?? "").trim()).filter(Boolean)));
}

function refreshWeaponSheetsForDamageSource(sourceUuid = "") {
  const uuid = String(sourceUuid ?? "").trim();
  if (!uuid) return;
  for (const item of getAllWorldAndActorItems()) {
    if (!itemReferencesDamageSource(item, uuid)) continue;
    for (const app of Object.values(item.apps ?? {})) {
      app.render?.({ force: true });
    }
  }
}

function refreshEnergyConsumerSheetsForSource(sourceUuid = "") {
  const uuid = String(sourceUuid ?? "").trim();
  if (!uuid) return;
  for (const item of getAllWorldAndActorItems()) {
    if (!itemReferencesEnergySource(item, uuid)) continue;
    for (const app of Object.values(item.apps ?? {})) {
      app.render?.({ force: true });
    }
  }
}

function getAllWorldAndActorItems() {
  return [
    ...(game.items?.contents ?? []),
    ...(game.actors?.contents ?? []).flatMap(actor => actor.items?.contents ?? [])
  ];
}

function itemReferencesDamageSource(item, sourceUuid = "") {
  if (!item || !hasItemFunction(item, ITEM_FUNCTIONS.weapon, { ignoreBroken: true })) return false;
  return getWeaponFunctionDataList(item).some(weaponData => (
    getWeaponMagazineSourceUuids(weaponData).includes(sourceUuid)
  ));
}

function itemReferencesEnergySource(item, sourceUuid = "") {
  if (!item || !hasItemFunction(item, ITEM_FUNCTIONS.energyConsumer, { ignoreBroken: true })) return false;
  return getEnergyConsumerSourceUuids(item.system?.functions?.energyConsumer).includes(sourceUuid);
}

function getWeaponFunctionDataList(item) {
  const functions = item.system?.functions ?? {};
  const entries = [];
  if (functions.weapon?.enabled) entries.push(functions.weapon);
  const additional = functions.additionalWeapons;
  if (additional && typeof additional === "object") {
    entries.push(...Object.values(additional).filter(data => data?.enabled));
  }
  return entries;
}

function buildWeaponDamageTypeRowsForData(weaponData, damageTypeSettings, sourceWeaponData) {
  const choices = getConfigurableDamageTypes(damageTypeSettings);
  const rows = normalizeWeaponDamageTypeRows(
    weaponData,
    choices,
    sourceWeaponData
  );
  return rows.map((entry, index) => ({
    index,
    key: entry.key,
    percent: clampPercent(entry.percent),
    choices: choices.map(damageType => ({
      value: damageType.key,
      label: damageType.label,
      selected: damageType.key === entry.key
    }))
  }));
}

function buildVolleyRegionDamageRowsForData(entries = [], damageTypeSettings = []) {
  const choices = getConfigurableDamageTypes(damageTypeSettings);
  return normalizeVolleyRegionDamageEntries(entries).map((entry, index) => ({
    index,
    damageTypeKey: entry.damageTypeKey,
    amount: normalizeDamageFormula(entry.amount),
    choices: choices.map(damageType => ({
      value: damageType.key,
      label: damageType.label,
      selected: damageType.key === entry.damageTypeKey
    }))
  }));
}

function buildWeaponSkillChoices(item, skillSettings) {
  return buildWeaponSkillChoicesForData(item.system?.functions?.weapon ?? {}, skillSettings);
}

function buildWeaponSkillChoicesForData(weaponData, skillSettings) {
  const selected = String(weaponData?.skillKey ?? "");
  return skillSettings.map(skill => ({
    value: skill.key,
    label: skill.label,
    selected: skill.key === selected
  }));
}

function buildWeaponModuleTargetChoices(selected = "weapon") {
  const value = String(selected ?? "") === "weapon" ? "weapon" : "weapon";
  return [{
    value: "weapon",
    label: game.i18n.localize("FALLOUTMAW.Item.FunctionWeapon"),
    selected: value === "weapon"
  }];
}

function buildWeaponProficiencyChoicesForData(weaponData, proficiencySettings) {
  const selected = String(weaponData?.proficiencyKey ?? "");
  const fallback = proficiencySettings[0]?.key ?? "";
  const selectedKey = proficiencySettings.some(proficiency => proficiency.key === selected) ? selected : fallback;
  if (!proficiencySettings.length) {
    return [{ value: "", label: game.i18n.localize("FALLOUTMAW.Settings.Proficiencies.Empty"), selected: true }];
  }
  return proficiencySettings.map(proficiency => ({
    value: proficiency.key,
    label: proficiency.label,
    selected: proficiency.key === selectedKey
  }));
}

function hasWeaponResourceCost(item, type) {
  return hasWeaponResourceCostData(item.system?.functions?.weapon ?? {}, type);
}

function hasWeaponResourceCostData(weaponData, type) {
  if (type === "magazine" && isSourceDamageMode(weaponData)) return true;
  return (weaponData?.resourceCosts ?? []).some(cost => cost.type === type);
}

function buildWeaponResourceTypeChoices(selected, hasConditionFunction, hasEnergyConsumerFunction) {
  const choices = [
    { value: "magazine", label: game.i18n.localize("FALLOUTMAW.Item.WeaponCostMagazine") },
    { value: "quantity", label: game.i18n.localize("FALLOUTMAW.Item.WeaponCostQuantity") }
  ];
  if (hasEnergyConsumerFunction) {
    choices.push({ value: "energyConsumer", label: game.i18n.localize("FALLOUTMAW.Item.WeaponCostEnergy") });
  }
  if (hasConditionFunction) {
    choices.push({ value: "condition", label: game.i18n.localize("FALLOUTMAW.Item.WeaponCostCondition") });
  }
  return choices.map(choice => ({
    ...choice,
    selected: choice.value === selected
  }));
}

function removeWeaponResourceCostTypeFromEntries(entries = [], type = "") {
  return Object.fromEntries(entries.map(({ id, data }) => [
    id,
    removeWeaponResourceCostTypeFromWeaponData(data, type)
  ]));
}

function removeWeaponResourceCostTypeFromWeaponData(weaponData = {}, type = "") {
  const normalizedType = String(type ?? "").trim();
  const data = foundry.utils.deepClone(weaponData ?? {});
  if (!normalizedType || !data || typeof data !== "object") return data;

  data.resourceCosts = (Array.isArray(data.resourceCosts) ? data.resourceCosts : Object.values(data.resourceCosts ?? {}))
    .filter(cost => String(cost?.type ?? "") !== normalizedType);

  if (Array.isArray(data.specialProperties)) {
    data.specialProperties = data.specialProperties.map(property => {
      const next = foundry.utils.deepClone(property ?? {});
      if (Array.isArray(next.attackPower?.resourceCosts)) {
        next.attackPower.resourceCosts = next.attackPower.resourceCosts
          .filter(cost => String(cost?.type ?? "") !== normalizedType);
      }
      return next;
    });
  }

  for (const value of Object.values(data)) {
    if (!Array.isArray(value?.criticalFailureConsequences)) continue;
    value.criticalFailureConsequences = value.criticalFailureConsequences
      .filter(consequence => String(consequence?.resourceType ?? "") !== normalizedType);
  }

  return data;
}

function buildWeaponActionChoices(item, damageTypeSettings = []) {
  return buildWeaponActionChoicesForData(
    item.system?.functions?.weapon ?? {},
    item.system?._source?.functions?.weapon ?? {},
    damageTypeSettings
  );
}

function buildWeaponActionChoicesForData(weaponData = {}, sourceWeaponData = {}, damageTypeSettings = []) {
  const actions = weaponData?.availableActions ?? {};
  const hasMagazineCost = hasWeaponResourceCostData(weaponData, "magazine");
  const fallbackCone = Number(weaponData.attackConeDegrees) || DEFAULT_WEAPON_ATTACK_CONE_DEGREES;
  return [
    { key: "aimedShot", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionAimedShot") },
    { key: "snapshot", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionSnapshot") },
    { key: "burst", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionBurst") },
    { key: "volley", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionVolley"), isVolley: true },
    { key: "meleeAttack", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionMeleeAttack"), isMelee: true },
    { key: "aimedMeleeAttack", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionAimedMeleeAttack"), isMelee: true },
    { key: "reload", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionReload"), isReload: true, autoSelected: hasMagazineCost }
  ].map(action => {
    const actionData = weaponData?.[action.key] ?? {};
    const sourceActionData = sourceWeaponData?.[action.key] ?? {};
    const actionName = String(actionData?.name ?? "").trim();
    const hasActionCone = Object.hasOwn(sourceActionData, "attackConeDegrees");
    const thrust = prepareWeaponAttackModeSettings(actionData?.thrust);
    const swing = prepareWeaponAttackModeSettings(actionData?.swing);
    if (!thrust.enabled && !swing.enabled) {
      thrust.enabled = true;
      swing.enabled = true;
    }
    return {
      ...action,
      name: actionName,
      displayLabel: actionName || action.label,
      selected: Boolean(actions[action.key]) || Boolean(action.autoSelected),
      isBurst: action.key === "burst",
      isVolley: action.key === "volley",
      isMelee: Boolean(action.isMelee),
      actionPointCost: getWeaponActionPointCostForData(weaponData, action.key),
      attackConeDegrees: Number(hasActionCone ? actionData.attackConeDegrees : fallbackCone) || DEFAULT_WEAPON_ATTACK_CONE_DEGREES,
      burstCount: Math.max(1, Number(weaponData?.burst?.count) || 3),
      burstDifficultyPerShot: getWeaponBurstDifficultyPerShotForData(weaponData),
      volleyDamageRadius: normalizeDamageFormula(weaponData?.volley?.damageRadius),
      volleyRegionRadius: normalizeDamageFormula(weaponData?.volley?.regionRadius),
      volleyRegionDamageRows: buildVolleyRegionDamageRowsForData(weaponData?.volley?.regionDamageEntries, damageTypeSettings),
      volleyRegionDurationSeconds: normalizeDamageFormula(weaponData?.volley?.regionDurationSeconds),
      volleyRegionDelaySeconds: normalizeDamageFormula(weaponData?.volley?.regionDelaySeconds),
      volleyRegionRadiusDeltaMeters: normalizeDamageFormula(weaponData?.volley?.regionRadiusDeltaMeters),
      criticalFailureConsequences: action.isReload ? [] : buildWeaponCriticalFailureConsequenceRows(actionData, weaponData),
      thrust,
      swing
    };
  });
}

function getWeaponBurstDifficultyPerShotForData(weaponData = {}) {
  const value = Number(weaponData?.burst?.difficultyPerShot);
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 10;
}

function getWeaponActionPointCostForData(weaponData = {}, actionKey = "") {
  const value = Number(weaponData?.[actionKey]?.actionPointCost);
  const fallback = actionKey === "reload" ? DEFAULT_RELOAD_ACTION_POINT_COST : DEFAULT_WEAPON_ACTION_POINT_COST;
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : fallback;
}

function prepareWeaponAttackModeSettings(modeData = {}) {
  return {
    enabled: modeData?.enabled !== false,
    accuracyModifier: Number(modeData?.accuracyModifier) || 0,
    criticalChanceModifier: Number(modeData?.criticalChanceModifier) || 0,
    damagePercentModifier: Number(modeData?.damagePercentModifier) || 0
  };
}

function createDefaultDamageSourceFunctionData(source = {}) {
  return foundry.utils.mergeObject({
    enabled: false,
    name: "",
    damage: 0,
    pellets: 1,
    damageTypeKey: "firearm",
    damageTypes: [{ key: "firearm", percent: 100 }],
    attackAnimationKey: "",
    attackSoundPath: "",
    attackAnimationDelayMs: DEFAULT_ATTACK_ANIMATION_DELAY_MS,
    accuracyBonus: 0,
    criticalChanceModifier: 0,
    criticalDamagePercent: 0,
    maxRangeMeters: 0,
    effectiveRange: {
      value: 0,
      max: 0
    },
    penetration: 0,
    volley: createDefaultDamageSourceVolleyData()
  }, foundry.utils.deepClone(source), { inplace: false });
}

function createDefaultDamageSourceVolleyData() {
  return {
    damageRadius: 0,
    regionRadius: 0,
    regionDamageEntries: [],
    regionDurationSeconds: 0,
    regionDelaySeconds: 0,
    regionRadiusDeltaMeters: 0,
    explosionAnimationKey: "",
    explosionSoundPath: ""
  };
}

function createDefaultEnergySourceFunctionData(source = {}) {
  return foundry.utils.mergeObject({
    enabled: false,
    name: "",
    class: "D",
    reserve: {
      value: 0,
      max: 0
    }
  }, foundry.utils.deepClone(source), { inplace: false });
}

function createDefaultEnergyConsumerFunctionData(source = {}) {
  return foundry.utils.mergeObject({
    enabled: false,
    sourceItemUuid: "",
    sourceItemUuids: [],
    activeSourceUuid: "",
    activeConditions: {},
    installedSource: createEmptyInstalledEnergySourceData()
  }, foundry.utils.deepClone(source), { inplace: false });
}

function createDefaultLightSourceFunctionData(source = {}) {
  return foundry.utils.mergeObject({
    enabled: false,
    name: "",
    dim: 0,
    bright: 0,
    angle: DEFAULT_LIGHT_SOURCE_ANGLE_DEGREES,
    rotation: 0,
    color: DEFAULT_LIGHT_SOURCE_COLOR,
    resourceCosts: []
  }, foundry.utils.deepClone(source), { inplace: false });
}

function createDefaultTrapFunctionData(source = {}) {
  return foundry.utils.mergeObject({
    enabled: false,
    actionPointCost: 0,
    installation: {
      difficulty: 60,
      skillKey: "traps"
    },
    detection: {
      radiusMeters: 1,
      difficulty: 60,
      skillKey: "naturalist",
      conditions: []
    },
    trigger: {
      activationMode: "exit",
      widthCells: 1,
      heightCells: 1,
      imageScale: 0.5
    },
    recharge: {
      value: null,
      unit: "seconds"
    },
    evasion: {
      difficulty: null,
      skillKey: "athletics",
      avoidPercent: 50
    },
    disarm: {
      toolKey: "mechanicalHacking",
      toolClass: "D",
      difficulty: 60,
      attempts: 1
    },
    effect: {
      mode: "explosion",
      damageRadiusMeters: 0,
      penetration: 0,
      damage: 0,
      pellets: 1,
      damageTypeKey: "firearm",
      damageTypes: [{ key: "firearm", percent: 100 }],
      regionRadius: 0,
      regionDamageEntries: [],
      regionDurationSeconds: 0,
      regionDelaySeconds: 0,
      regionRadiusDeltaMeters: 0
    },
    triggerAnimationKey: "",
    triggerSoundPath: ""
  }, foundry.utils.deepClone(source), { inplace: false });
}

function createDefaultWeaponFunctionData(source = {}) {
  return foundry.utils.mergeObject({
    enabled: false,
    damageMode: "manual",
    damage: 0,
    pellets: 1,
    damageTypeKey: "firearm",
    damageTypes: [{ key: "firearm", percent: 100 }],
    attackAnimationKey: "",
    attackSoundPath: "",
    attackAnimationDelayMs: DEFAULT_ATTACK_ANIMATION_DELAY_MS,
    proficiencyKey: "pistol",
    skillKey: "rangedCombat",
    accuracyBonus: 0,
    criticalChanceModifier: 0,
    criticalDamagePercent: 150,
    attackConeDegrees: DEFAULT_WEAPON_ATTACK_CONE_DEGREES,
    maxRangeMeters: 0,
    effectiveRange: {
      value: 0,
      max: 0
    },
    penetration: 0,
    magazine: {
      value: 0,
      max: 0,
      sourceItemUuid: "",
      sourceItemUuids: []
    },
    resourceCosts: [],
    moduleSlots: [],
    specialProperties: [],
    requirements: [],
    availableActions: {
      aimedShot: false,
      snapshot: false,
      burst: false,
      volley: false,
      meleeAttack: false,
      aimedMeleeAttack: false,
      push: false,
      reload: false
    },
    aimedShot: {
      name: "",
      actionPointCost: DEFAULT_WEAPON_ACTION_POINT_COST,
      attackConeDegrees: DEFAULT_WEAPON_ATTACK_CONE_DEGREES,
      criticalFailureConsequences: []
    },
    snapshot: {
      name: "",
      actionPointCost: DEFAULT_WEAPON_ACTION_POINT_COST,
      attackConeDegrees: DEFAULT_WEAPON_ATTACK_CONE_DEGREES,
      criticalFailureConsequences: []
    },
    burst: {
      name: "",
      actionPointCost: DEFAULT_WEAPON_ACTION_POINT_COST,
      attackConeDegrees: DEFAULT_WEAPON_ATTACK_CONE_DEGREES,
      count: 3,
      difficultyPerShot: 10,
      criticalFailureConsequences: []
    },
    volley: {
      name: "",
      actionPointCost: DEFAULT_WEAPON_ACTION_POINT_COST,
      damageRadius: 0,
      regionRadius: 0,
      regionDamageEntries: [],
      regionDurationSeconds: 0,
      regionDelaySeconds: 0,
      regionRadiusDeltaMeters: 0,
      explosionAnimationKey: "",
      explosionSoundPath: "",
      criticalFailureConsequences: []
    },
    meleeAttack: createDefaultWeaponMeleeActionData(),
    aimedMeleeAttack: createDefaultWeaponMeleeActionData(),
    push: createDefaultWeaponPushActionData(),
    reload: {
      name: "",
      actionPointCost: DEFAULT_RELOAD_ACTION_POINT_COST
    }
  }, foundry.utils.deepClone(source), { inplace: false });
}

function createDefaultWeaponMeleeActionData() {
  return {
    name: "",
    actionPointCost: DEFAULT_WEAPON_ACTION_POINT_COST,
    attackConeDegrees: DEFAULT_WEAPON_ATTACK_CONE_DEGREES,
    criticalFailureConsequences: [],
    thrust: {
      enabled: true,
      accuracyModifier: 0,
      criticalChanceModifier: 0,
      damagePercentModifier: 0
    },
    swing: {
      enabled: true,
      accuracyModifier: 0,
      criticalChanceModifier: 0,
      damagePercentModifier: 0
    }
  };
}

function getNextAdditionalWeaponFunctionName(additionalWeapons = []) {
  const usedNames = new Set(additionalWeapons.map(entry => String(entry?.name ?? "").trim()).filter(Boolean));
  for (let index = 0; index < 1000; index += 1) {
    const name = getDefaultAdditionalWeaponFunctionName(index);
    if (!usedNames.has(name)) return name;
  }
  return getDefaultAdditionalWeaponFunctionName(additionalWeapons.length);
}

function getDefaultAdditionalWeaponFunctionName(index) {
  return `${game.i18n.localize("FALLOUTMAW.Item.AdditionalWeaponFunction")} ${index + 1}`;
}

function prepareCraftContext(item, skillSettings = [], selection = null, attachSourceNodeId = "", mode = CRAFT_MODE_CREATE) {
  mode = normalizeCraftMode(mode);
  const nodes = getCraftNodesWithRoot(item);
  const links = getCraftLinks(item);
  const blocks = getCraftBlocks(nodes);
  const viewport = getCraftViewport(item);
  const selectedNodeIndex = selection?.type === "node"
    ? nodes.findIndex(node => node.id === selection.id)
    : -1;
  const selectedNode = selectedNodeIndex >= 0
    ? prepareCraftNodeForDisplay(nodes[selectedNodeIndex], selectedNodeIndex, links)
    : null;
  const selectedBlock = selection?.type === "block"
    ? blocks.find(block => block.id === selection.id) ?? null
    : null;
  const selectedLinkIndex = selection?.type === "link"
    ? links.findIndex(link => link.id === selection.id)
    : -1;
  const selectedLink = selectedLinkIndex >= 0
    ? prepareCraftLinkForDisplay(links[selectedLinkIndex], selectedLinkIndex, nodes, skillSettings, mode)
    : null;
  const attachSourceNode = nodes.find(node => node.id === attachSourceNodeId) ?? null;
  return {
    mode,
    modes: [
      {
        key: CRAFT_MODE_CREATE,
        label: "Создание",
        selected: mode === CRAFT_MODE_CREATE
      },
      {
        key: CRAFT_MODE_DISASSEMBLY,
        label: "Разбор",
        selected: mode === CRAFT_MODE_DISASSEMBLY
      }
    ],
    canReverseCreation: mode === CRAFT_MODE_DISASSEMBLY && hasCraftRecipeData(getCraftRecipeData(item, CRAFT_MODE_CREATE)),
    canCalculateCost: mode === CRAFT_MODE_CREATE,
    linkFieldPrefix: mode === CRAFT_MODE_DISASSEMBLY ? "system.craft.disassembly.links" : "system.craft.links",
    blocks: blocks.map(block => ({
      ...block,
      label: `Craft block ${block.id}`,
      style: buildCraftNodeStyle(block),
      selected: selection?.type === "block" && selection.id === block.id
    })),
    nodes: nodes.map((node, index) => ({
      ...prepareCraftNodeForDisplay(node, index, links),
      style: buildCraftNodeStyle(node),
      selected: selection?.type === "node" && selection.id === node.id,
      attaching: attachSourceNodeId === node.id
    })),
    links,
    viewport,
    viewportStyle: `--craft-pan-x: ${Math.round(viewport.x)}px; --craft-pan-y: ${Math.round(viewport.y)}px; --craft-zoom: ${viewport.zoom};`,
    selectedNode,
    selectedBlock,
    selectedLink,
    attachSourceNode,
    hasPopover: Boolean(selectedNode || selectedBlock || selectedLink)
  };
}

function calculateCraftItemCost(item) {
  const currencies = getCurrencySettings();
  const targetCurrency = currencies.find(currency => currency.key === item?.system?.priceCurrency)
    ?? currencies.find(currency => currency.primaryTrade)
    ?? currencies[0]
    ?? { key: "", label: "", value: 1 };
  const nodes = getCraftNodesWithRootForMode(item, CRAFT_MODE_CREATE);
  const root = nodes.find(node => node.root);
  const resultQuantity = Math.max(1, toInteger(root?.quantity) || toInteger(item?.system?.quantity) || 1);
  let componentTotal = 0;
  let toolTotal = 0;
  let componentCount = 0;
  let toolCount = 0;
  let missingPriceCount = 0;
  let invalidToolSupplyCount = 0;

  for (const node of nodes) {
    if (node.root) continue;
    const source = resolveCraftNodeSourceItem(node);
    if (!source) {
      missingPriceCount += 1;
      continue;
    }
    const quantity = Math.max(1, toInteger(node.quantity) || 1);
    const price = convertCraftCostCurrency(Number(source.system?.price) || 0, source.system?.priceCurrency, targetCurrency, currencies);
    const toolFunction = getCraftNodeToolFunction(node);
    if (isCraftNodeToolRequirement(node, toolFunction)) {
      toolCount += 1;
      const maximumSupply = Math.max(0, toInteger(toolFunction.supply?.max));
      if (maximumSupply <= 0) {
        invalidToolSupplyCount += 1;
        continue;
      }
      toolTotal += price * (quantity / maximumSupply);
      continue;
    }
    componentCount += 1;
    componentTotal += price * quantity;
  }

  const difficulty = getCraftLinksForMode(item, CRAFT_MODE_CREATE)
    .filter(link => !link.noCheck)
    .reduce((maximum, link) => Math.max(maximum, normalizeCraftLinkDifficulty(link.difficulty)), 0);
  const difficultyPercent = calculateCraftDifficultyCostPercent(difficulty);

  return {
    componentCost: Math.max(0, Math.round(componentTotal / resultQuantity)),
    toolCost: Math.max(0, Math.round(toolTotal / resultQuantity)),
    componentCount,
    toolCount,
    difficulty,
    difficultyPercent,
    resultQuantity,
    currencyKey: String(targetCurrency.key ?? ""),
    currencyLabel: String(targetCurrency.label ?? targetCurrency.key ?? ""),
    missingPriceCount,
    invalidToolSupplyCount
  };
}

function convertCraftCostCurrency(amount, sourceCurrencyKey, targetCurrency, currencies = getCurrencySettings()) {
  const value = Math.max(0, Number(amount) || 0);
  const sourceCurrency = currencies.find(currency => currency.key === sourceCurrencyKey) ?? targetCurrency;
  const sourceRate = Math.max(0, Number(sourceCurrency?.value) || 0);
  const targetRate = Math.max(0, Number(targetCurrency?.value) || 0);
  if (!sourceRate || !targetRate) return value;
  return (value * sourceRate) / targetRate;
}

function calculateCraftDifficultyCostPercent(difficulty) {
  const tens = Math.floor(Math.max(0, Number(difficulty) || 0) / 10);
  const completedTiers = Math.floor(tens / 5);
  const remainingTens = tens - (5 * completedTiers);
  return (5 * completedTiers * (completedTiers + 1) / 2) + ((completedTiers + 1) * remainingTens);
}

async function openCraftCostDialog(calculation) {
  const currencyLabel = escapeHtml(calculation.currencyLabel);
  const notes = [];
  if (calculation.resultQuantity > 1) notes.push(`Расчёт разделён на ${calculation.resultQuantity} результата.`);
  if (calculation.missingPriceCount) notes.push(`Не удалось прочитать ${calculation.missingPriceCount} компонентов.`);
  if (calculation.invalidToolSupplyCount) notes.push(`У ${calculation.invalidToolSupplyCount} инструментов не задан максимальный запас.`);
  const initialFinal = Math.round((calculation.componentCost * (1 + (calculation.difficultyPercent / 100))) + calculation.toolCost);
  const content = `
    <div class="fallout-maw-craft-cost-dialog">
      <p><strong>Компоненты:</strong> ${formatCraftCost(calculation.componentCost)} ${currencyLabel}</p>
      <p><strong>Сложность рецепта:</strong> ${calculation.difficulty}</p>
      <div class="form-group">
        <label for="fallout-maw-craft-cost-difficulty">Надбавка за сложность, %</label>
        <input id="fallout-maw-craft-cost-difficulty" name="difficultyPercent" type="number" value="${calculation.difficultyPercent}" min="0" step="1">
      </div>
      <div class="form-group">
        <label for="fallout-maw-craft-cost-tools">Стоимость расхода инструментов</label>
        <input id="fallout-maw-craft-cost-tools" name="toolCost" type="number" value="${formatCraftCost(calculation.toolCost)}" min="0" step="1">
      </div>
      <p class="fallout-maw-craft-cost-dialog-total"><strong>Итоговая стоимость:</strong> <span data-craft-cost-total>${formatCraftCost(initialFinal)}</span> ${currencyLabel}</p>
      ${notes.length ? `<p class="fallout-maw-craft-cost-dialog-note">${notes.map(escapeHtml).join(" ")}</p>` : ""}
    </div>
  `;

  const result = await DialogV2.wait({
    window: { title: "Расчёт стоимости крафта" },
    content,
    render: (_event, dialog) => activateCraftCostDialog(dialog, calculation.componentCost),
    buttons: [
      {
        action: "apply",
        label: "Применить",
        icon: "fa-solid fa-check",
        default: true,
        callback: (_event, button) => {
          const data = new FormDataExtended(button.form).object;
          return {
            difficultyPercent: data.difficultyPercent,
            toolCost: data.toolCost
          };
        }
      },
      {
        action: "cancel",
        label: game.i18n.localize("Cancel"),
        icon: "fa-solid fa-xmark",
        type: "button"
      }
    ],
    position: { width: 480 },
    rejectClose: false,
    modal: true
  });
  return result && result !== "cancel" ? result : null;
}

function activateCraftCostDialog(dialog, componentCost) {
  const form = dialog.element?.querySelector("form");
  if (!form) return;
  const difficultyInput = form.elements.namedItem("difficultyPercent");
  const toolInput = form.elements.namedItem("toolCost");
  const total = form.querySelector("[data-craft-cost-total]");
  const update = () => {
    const difficultyPercent = Math.max(0, Number(difficultyInput?.value) || 0);
    const toolCost = Math.max(0, Math.round(Number(toolInput?.value) || 0));
    if (total) total.textContent = formatCraftCost(Math.round((componentCost * (1 + (difficultyPercent / 100))) + toolCost));
  };
  difficultyInput?.addEventListener("input", update);
  toolInput?.addEventListener("input", update);
  update();
}

function formatCraftCost(value) {
  return new Intl.NumberFormat(game.i18n.lang, { maximumFractionDigits: 0 }).format(Math.max(0, Math.round(Number(value) || 0)));
}

function normalizeCraftMode(mode) {
  return String(mode ?? "") === CRAFT_MODE_DISASSEMBLY ? CRAFT_MODE_DISASSEMBLY : CRAFT_MODE_CREATE;
}

function getActiveCraftMode(item) {
  return normalizeCraftMode(activeCraftModes.get(item));
}

function getCraftRecipeData(item, mode = getActiveCraftMode(item)) {
  const recipe = getActiveCraftRecipeEntry(item);
  if (normalizeCraftMode(mode) === CRAFT_MODE_DISASSEMBLY) return recipe.disassembly ?? {};
  return recipe;
}

function getActiveCraftRecipeEntry(item) {
  const recipes = getCraftRecipeEntries(item);
  const id = resolveCraftRecipeId(item, activeCraftRecipeIds.get(item));
  return recipes.find(recipe => recipe.id === id) ?? recipes[0] ?? createDefaultCraftRecipeEntry(item);
}

function resolveCraftRecipeId(item, recipeId = "") {
  const requested = String(recipeId ?? "").trim();
  const recipes = getCraftRecipeEntries(item);
  if (recipes.some(recipe => recipe.id === requested)) return requested;
  return recipes[0]?.id ?? DEFAULT_CRAFT_RECIPE_ID;
}

function getCraftRecipeEntries(itemOrCraft = {}) {
  const craft = itemOrCraft?.system?.craft ?? itemOrCraft ?? {};
  const legacyRecipe = createDefaultCraftRecipeEntry({ system: { craft } });
  const source = Array.isArray(craft?.recipes) && craft.recipes.length
    ? craft.recipes
    : [legacyRecipe];
  const usedIds = new Set();
  const entries = source.map((entry, index) => {
    const fallback = (index === 0 || entry?.id === DEFAULT_CRAFT_RECIPE_ID) ? legacyRecipe : {};
    const normalized = normalizeCraftRecipeEntry(mergeCraftRecipeWithLegacyFallback(entry, fallback), index, usedIds);
    usedIds.add(normalized.id);
    return normalized;
  });
  if (!entries.some(entry => entry.id === DEFAULT_CRAFT_RECIPE_ID)) {
    entries.unshift(legacyRecipe);
  }
  return entries;
}

function createDefaultCraftRecipeEntry(itemOrCraft = {}) {
  const craft = itemOrCraft?.system?.craft ?? itemOrCraft ?? {};
  return normalizeCraftRecipeEntry({
    id: DEFAULT_CRAFT_RECIPE_ID,
    name: DEFAULT_CRAFT_RECIPE_NAME,
    nodes: craft.nodes ?? [],
    links: craft.links ?? [],
    viewport: craft.viewport ?? {},
    disassembly: craft.disassembly ?? {}
  }, 0);
}

function normalizeCraftRecipeEntry(entry = {}, index = 0, usedIds = new Set()) {
  const fallbackId = index === 0 ? DEFAULT_CRAFT_RECIPE_ID : `recipe${index + 1}`;
  let id = String(entry?.id ?? fallbackId).trim() || fallbackId;
  id = getUniqueCraftRecipeId(id, usedIds);
  return {
    id,
    name: String(entry?.name ?? (index === 0 ? DEFAULT_CRAFT_RECIPE_NAME : `Рецепт_${index + 1}`)).trim() || `Рецепт_${index + 1}`,
    ...normalizeCraftRecipeLayout(entry),
    disassembly: normalizeCraftRecipeLayout(entry?.disassembly)
  };
}

function mergeCraftRecipeWithLegacyFallback(entry = {}, fallback = {}) {
  const source = foundry.utils.deepClone(entry ?? {});
  const hasLegacyData = hasCraftRecipeEntryData(fallback);
  const isDefaultRecipe = !source.id || source.id === DEFAULT_CRAFT_RECIPE_ID;
  if (!hasLegacyData || !isDefaultRecipe || hasCraftRecipeEntryData(source)) {
    return { ...fallback, ...source };
  }
  return {
    ...source,
    nodes: fallback.nodes,
    links: fallback.links,
    viewport: fallback.viewport,
    disassembly: fallback.disassembly
  };
}

function createBlankCraftRecipeEntry(overrides = {}) {
  return normalizeCraftRecipeEntry({
    nodes: [],
    links: [],
    viewport: {},
    disassembly: {},
    ...overrides
  }, 1);
}

function cloneCraftRecipeEntry(entry = {}, overrides = {}) {
  return normalizeCraftRecipeEntry({
    ...foundry.utils.deepClone(entry ?? {}),
    ...overrides
  }, 1);
}

function normalizeCraftRecipeLayout(layout = {}) {
  return {
    nodes: Array.from(layout?.nodes ?? []).map(normalizeCraftNode),
    links: Array.from(layout?.links ?? []).map(normalizeCraftLink),
    viewport: normalizeCraftViewport(layout?.viewport ?? {})
  };
}

function getNextCraftRecipeId(recipes = []) {
  const used = new Set(recipes.map(recipe => recipe.id));
  let index = 2;
  while (used.has(`recipe${index}`)) index += 1;
  return `recipe${index}`;
}

function getNextCraftRecipeName(recipes = []) {
  const used = new Set(recipes.map(recipe => String(recipe.name ?? "")));
  for (let index = 2; index < 1000; index += 1) {
    const name = `Рецепт_${index}`;
    if (!used.has(name)) return name;
  }
  return `Рецепт_${recipes.length + 1}`;
}

function getUniqueCraftRecipeId(baseId = "recipe", usedIds = new Set()) {
  const used = usedIds instanceof Set ? usedIds : new Set(usedIds ?? []);
  const base = String(baseId ?? "").trim() || "recipe";
  if (!used.has(base)) return base;
  let index = 2;
  while (used.has(`${base}${index}`)) index += 1;
  return `${base}${index}`;
}

function hasCraftRecipeEntryData(recipe = {}) {
  return Boolean(
    (recipe?.nodes ?? []).length
    || (recipe?.links ?? []).length
    || (recipe?.disassembly?.nodes ?? []).length
    || (recipe?.disassembly?.links ?? []).length
  );
}

function hasCraftRecipeData(craft = {}) {
  return Boolean((craft?.nodes ?? []).length || (craft?.links ?? []).length);
}

function prepareCraftNodeForDisplay(node, index, links) {
  const quantity = Math.max(1, toInteger(node.quantity) || 1);
  const linked = links.some(link => link.fromNodeId === node.id || link.toNodeId === node.id);
  const toolFunction = getCraftNodeToolFunction(node);
  const toolRequirements = getCraftNodeToolRequirements(node);
  return {
    ...node,
    index,
    linked,
    hasToolFunction: Boolean(toolFunction?.toolKey),
    isToolRequirement: toolRequirements.length > 0,
    toolRequirementLabel: formatCraftToolRequirementLabel(toolRequirements),
    toolUseAsItem: Boolean(toolFunction?.useAsItem),
    quantity,
    hasQuantityBadge: quantity > 1
  };
}

function createDefaultWeaponPushActionData() {
  return {
    name: "",
    actionPointCost: DEFAULT_WEAPON_ACTION_POINT_COST,
    attackConeDegrees: DEFAULT_WEAPON_ATTACK_CONE_DEGREES,
    maxRangeMeters: DEFAULT_WEAPON_PUSH_MAX_RANGE_METERS,
    accuracyModifier: 0,
    pushDifficultyModifier: 0,
    criticalFailureConsequences: []
  };
}

function getCraftNodeToolRequirements(node = {}) {
  const toolFunction = getCraftNodeToolFunction(node);
  if (!toolFunction || toolFunction.useAsItem) return [];
  return [{
    toolKey: String(toolFunction.toolKey ?? ""),
    toolClass: String(toolFunction.toolClass ?? "D")
  }].filter(tool => tool.toolKey);
}

function getCraftNodeToolFunction(node = {}) {
  const source = resolveCraftNodeSourceItem(node);
  if (!source) return null;
  return getEnabledToolFunctions(source)[0] ?? null;
}

function isCraftNodeToolRequirement(node = {}, toolFunction = getCraftNodeToolFunction(node)) {
  return Boolean(!node.root && toolFunction && !toolFunction.useAsItem);
}

function resolveCraftNodeSourceItem(node = {}) {
  const uuid = String(node?.itemUuid ?? "").trim();
  if (!uuid) return null;
  return resolveWorldItemSync(uuid);
}

function formatCraftToolRequirementLabel(requirements = []) {
  if (!requirements.length) return "";
  const toolLabels = new Map(getToolSettings().map(tool => [tool.key, tool.label]));
  return requirements
    .map(requirement => `${toolLabels.get(requirement.toolKey) ?? requirement.toolKey} ${requirement.toolClass}`)
    .join(", ");
}

function getCraftBlocks(nodes = []) {
  return Array.from(groupCraftNodesByBlock(nodes).entries())
    .map(([id, blockNodes]) => ({
      id,
      nodeIds: blockNodes.map(node => node.id),
      nodeCount: blockNodes.length,
      blockLimit: getCraftBlockLimit(blockNodes),
      isToolBlock: blockNodes.length > 0 && blockNodes.every(node => isCraftNodeToolRequirement(node)),
      ...getCraftNodesBounds(blockNodes)
    }))
    .filter(block => block.nodeIds.length > 1 && block.width > 0 && block.height > 0);
}

function getCraftBlockLimit(nodes = []) {
  for (const node of nodes) {
    const limit = normalizeCraftBlockLimit(node.blockLimit);
    if (Number.isInteger(limit) && limit > 0) return limit;
  }
  return null;
}

function prepareCraftLinkForDisplay(link, index, nodes, skillSettings = [], mode = CRAFT_MODE_CREATE) {
  const from = nodes.find(node => node.id === link.fromNodeId);
  const to = nodes.find(node => node.id === link.toNodeId);
  const skillKey = String(link.skillKey ?? getDefaultCraftSkillKey(skillSettings));
  const failureResult = isCraftLinkFailureResult(link);
  const canSetFailureResult = isCraftLinkConnectedToOutputResource(link, nodes, mode);
  return {
    ...link,
    index,
    title: `${from?.name ?? "?"} -> ${to?.name ?? "?"}`,
    difficulty: normalizeCraftLinkDifficulty(link.difficulty),
    noCheck: failureResult || Boolean(link.noCheck),
    failureResult,
    canSetFailureResult,
    skillChoices: skillSettings.map((skill, skillIndex) => ({
      key: skill.key,
      label: skill.label,
      selected: skill.key === skillKey || (!skillKey && skillIndex === 0)
    }))
  };
}

function buildCraftNodeStyle(node) {
  const width = Math.max(1, toInteger(node.width) || 1);
  const height = Math.max(1, toInteger(node.height) || 1);
  const widthPx = (width * 52) + ((width - 1) * 4);
  const heightPx = (height * 52) + ((height - 1) * 4);
  return [
    `--craft-x: ${Number(node.x) || 0};`,
    `--craft-y: ${Number(node.y) || 0};`,
    `--craft-width: ${width};`,
    `--craft-height: ${height};`,
    `--craft-offset-x: ${(Number(node.x) || 0) * CRAFT_GRID_FALLBACK_STEP}px;`,
    `--craft-offset-y: ${(Number(node.y) || 0) * CRAFT_GRID_FALLBACK_STEP}px;`,
    `--craft-node-width: ${widthPx}px;`,
    `--craft-node-height: ${heightPx}px;`,
    `--craft-node-half-width: ${widthPx / 2}px;`,
    `--craft-node-half-height: ${heightPx / 2}px;`
  ].join(" ");
}

function getCraftNodesWithRoot(item) {
  const nodes = getCraftNodes(item);
  const rootIndex = nodes.findIndex(node => node.root);
  const root = createCraftRootNode(item, rootIndex >= 0 ? nodes[rootIndex] : {});
  if (rootIndex >= 0) {
    nodes[rootIndex] = root;
    return nodes;
  }
  return [root, ...nodes];
}

function getCraftNodes(item) {
  return Array.from(getCraftRecipeData(item)?.nodes ?? [])
    .map(normalizeCraftNode)
    .map(refreshCraftNodeFromSource)
    .filter(node => node.id);
}

function refreshCraftNodeFromSource(node = {}) {
  if (node.root) return node;
  const source = resolveCraftNodeSourceItem(node);
  if (!source) return node;
  const footprint = getCraftItemFootprint(source);
  return normalizeCraftNode({
    ...node,
    name: source.name ?? node.name,
    img: normalizeImagePath(source.img || node.img, FALLBACK_ICON),
    type: source.type ?? node.type,
    width: footprint.width,
    height: footprint.height
  });
}

function getCraftLinks(item) {
  const nodes = getCraftNodesWithRoot(item);
  return normalizeCraftLinksForNodes(Array.from(getCraftRecipeData(item)?.links ?? []), nodes);
}

function getCraftViewport(item) {
  return normalizeCraftViewport(getCraftRecipeData(item)?.viewport ?? {});
}

function createCraftRootNode(item, source = {}) {
  const placement = item.system?.placement ?? {};
  const width = Math.max(1, toInteger(placement.width) || toInteger(source.width) || 1);
  const height = Math.max(1, toInteger(placement.height) || toInteger(source.height) || 1);
  return normalizeCraftNode({
    ...source,
    id: String(source.id || CRAFT_ROOT_NODE_ID),
    itemUuid: item.uuid,
    name: item.name,
    img: normalizeImagePath(item.img || FALLBACK_ICON),
    type: item.type,
    width,
    height,
    quantity: Math.max(1, toInteger(source.quantity) || 1),
    blockId: String(source.blockId ?? ""),
    blockLimit: normalizeCraftBlockLimit(source.blockLimit),
    root: true
  });
}

function createCraftNodeFromItem(item, { x = 0, y = 0 } = {}) {
  const { width, height } = getCraftItemFootprint(item);
  return normalizeCraftNode({
    id: foundry.utils.randomID(),
    itemUuid: item.uuid,
    name: item.name,
    img: normalizeImagePath(item.img || FALLBACK_ICON),
    type: item.type,
    x,
    y,
    width,
    height,
    quantity: 1,
    blockId: "",
    root: false
  });
}

function normalizeCraftNode(node = {}) {
  const width = Math.max(1, toInteger(node.width) || 1);
  const height = Math.max(1, toInteger(node.height) || 1);
  return {
    id: String(node.id || foundry.utils.randomID()),
    itemUuid: String(node.itemUuid ?? ""),
    name: String(node.name ?? ""),
    img: normalizeImagePath(String(node.img || FALLBACK_ICON)),
    type: String(node.type ?? ""),
    x: snapCraftGridCoordinate(node.x, width),
    y: snapCraftGridCoordinate(node.y, height),
    width,
    height,
    quantity: Math.max(1, toInteger(node.quantity) || 1),
    blockId: String(node.blockId ?? ""),
    blockLimit: normalizeCraftBlockLimit(node.blockLimit),
    root: Boolean(node.root)
  };
}

function normalizeCraftBlockLimit(value) {
  if (value === null || value === undefined || value === "") return null;
  const limit = Math.max(0, toInteger(value));
  return limit > 0 ? limit : null;
}

function getCraftItemFootprint(item) {
  const placement = item?.system?.placement ?? {};
  return {
    width: Math.max(1, toInteger(placement.width) || 1),
    height: Math.max(1, toInteger(placement.height) || 1)
  };
}

function snapCraftGridCoordinate(value, size = 1) {
  const number = Number(value);
  const offset = (Math.max(1, toInteger(size) || 1) - 1) / 2;
  return (Number.isFinite(number) ? Math.round(number - offset) : 0) + offset;
}

function normalizeCraftLink(link = {}) {
  let bendX = toOptionalNumber(link.bendX);
  let bendY = toOptionalNumber(link.bendY);
  const fromAnchorOffset = toOptionalNumber(link.fromAnchorOffset);
  const toAnchorOffset = toOptionalNumber(link.toAnchorOffset);
  if (bendX === 0 && bendY === 0) {
    bendX = null;
    bendY = null;
  }
  return {
    id: String(link.id || getCraftFallbackLinkId(link)),
    fromNodeId: String(link.fromNodeId ?? ""),
    toNodeId: String(link.toNodeId ?? ""),
    skillKey: String(link.skillKey ?? "repair"),
    difficulty: normalizeCraftLinkDifficulty(link.difficulty),
    noCheck: isCraftLinkNoCheck(link),
    failureResult: isCraftLinkFailureResult(link),
    bendX,
    bendY,
    fromAnchorSide: normalizeCraftAnchorSide(link.fromAnchorSide),
    fromAnchorOffset: Number.isFinite(fromAnchorOffset) ? clampNumber(fromAnchorOffset, 0, 1) : null,
    toAnchorSide: normalizeCraftAnchorSide(link.toAnchorSide),
    toAnchorOffset: Number.isFinite(toAnchorOffset) ? clampNumber(toAnchorOffset, 0, 1) : null
  };
}

function normalizeCraftLinkDifficulty(value, fallback = 60) {
  const number = Number(value);
  return Math.max(0, Number.isFinite(number) ? Math.trunc(number) : fallback);
}

function isCraftLinkFailureResult(link = {}) {
  const value = link?.failureResult;
  return value === true || value === "true" || value === 1 || value === "1" || value === "on";
}

function isCraftLinkNoCheck(link = {}) {
  if (isCraftLinkFailureResult(link)) return true;
  const value = link?.noCheck;
  return value === true || value === "true" || value === 1 || value === "1" || value === "on";
}

function isCraftOutputResourceNode(node, mode = CRAFT_MODE_CREATE) {
  if (!node || isCraftNodeToolRequirement(node)) return false;
  return normalizeCraftMode(mode) === CRAFT_MODE_DISASSEMBLY ? !node.root : Boolean(node.root);
}

function isCraftLinkConnectedToOutputResource(link, nodes = [], mode = CRAFT_MODE_CREATE) {
  const from = nodes.find(node => node.id === link.fromNodeId);
  const to = nodes.find(node => node.id === link.toNodeId);
  return isCraftOutputResourceNode(from, mode) || isCraftOutputResourceNode(to, mode);
}

function getCraftFallbackLinkId(link = {}) {
  return [
    "link",
    String(link.fromNodeId ?? ""),
    String(link.toNodeId ?? ""),
    String(link.skillKey ?? "repair"),
    String(link.difficulty ?? 60),
    String(link.fromAnchorSide ?? ""),
    String(link.fromAnchorOffset ?? ""),
    String(link.toAnchorSide ?? ""),
    String(link.toAnchorOffset ?? ""),
    String(link.noCheck ?? false),
    String(link.failureResult ?? false),
    String(link.bendX ?? ""),
    String(link.bendY ?? "")
  ].join(":");
}

function normalizeCraftRecipeParts(nodes = [], links = []) {
  const normalizedNodes = normalizeCraftBlockData(nodes.map(normalizeCraftNode));
  return {
    nodes: normalizedNodes,
    links: normalizeCraftLinksForNodes(links, normalizedNodes)
  };
}

function createReversedCraftRecipe(item) {
  const sourceNodes = getCraftNodesWithRootForMode(item, CRAFT_MODE_CREATE);
  const sourceLinks = getCraftLinksForMode(item, CRAFT_MODE_CREATE);
  const root = sourceNodes.find(node => node.root) ?? createCraftRootNode(item);
  const rootY = Number(root.y) || 0;
  const nodes = sourceNodes.map(node => normalizeCraftNode({
    ...foundry.utils.deepClone(node),
    y: mirrorCraftY(node.y, rootY)
  }));
  const links = sourceLinks.map(link => normalizeCraftLink({
    ...foundry.utils.deepClone(link),
    fromNodeId: link.toNodeId,
    toNodeId: link.fromNodeId,
    bendY: Number.isFinite(toOptionalNumber(link.bendY)) ? mirrorCraftY(link.bendY, rootY) : null,
    fromAnchorSide: mirrorCraftVerticalAnchorSide(link.toAnchorSide),
    fromAnchorOffset: link.toAnchorOffset,
    toAnchorSide: mirrorCraftVerticalAnchorSide(link.fromAnchorSide),
    toAnchorOffset: link.fromAnchorOffset
  }));
  return {
    ...normalizeCraftRecipeParts(nodes, links),
    viewport: normalizeCraftViewport(getCraftViewportForMode(item, CRAFT_MODE_CREATE))
  };
}

function getCraftNodesWithRootForMode(item, mode) {
  const nodes = getCraftNodesForMode(item, mode);
  const rootIndex = nodes.findIndex(node => node.root);
  const root = createCraftRootNode(item, rootIndex >= 0 ? nodes[rootIndex] : {});
  if (rootIndex >= 0) {
    nodes[rootIndex] = root;
    return nodes;
  }
  return [root, ...nodes];
}

function getCraftNodesForMode(item, mode) {
  return Array.from(getCraftRecipeData(item, mode)?.nodes ?? [])
    .map(normalizeCraftNode)
    .map(refreshCraftNodeFromSource)
    .filter(node => node.id);
}

function getCraftLinksForMode(item, mode) {
  const nodes = getCraftNodesWithRootForMode(item, mode);
  return normalizeCraftLinksForNodes(Array.from(getCraftRecipeData(item, mode)?.links ?? []), nodes);
}

function getCraftViewportForMode(item, mode) {
  return normalizeCraftViewport(getCraftRecipeData(item, mode)?.viewport ?? {});
}

function mirrorCraftY(value, originY = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? originY - (number - originY) : originY;
}

function mirrorCraftVerticalAnchorSide(side) {
  const normalized = normalizeCraftAnchorSide(side);
  if (normalized === "top") return "bottom";
  if (normalized === "bottom") return "top";
  return normalized;
}

function normalizeCraftBlockData(nodes = []) {
  const blockCounts = new Map();
  for (const node of nodes) {
    if (!node.blockId) continue;
    blockCounts.set(node.blockId, (blockCounts.get(node.blockId) ?? 0) + 1);
  }
  const normalized = nodes.map(node => (
    node.blockId && (blockCounts.get(node.blockId) ?? 0) > 1 ? node : { ...node, blockId: "", blockLimit: null }
  ));
  return normalizeCraftBlockLimits(normalized);
}

function normalizeCraftBlockLimits(nodes = []) {
  const limits = new Map();
  for (const node of nodes) {
    const blockId = String(node.blockId ?? "");
    if (!blockId || limits.has(blockId)) continue;
    limits.set(blockId, normalizeCraftBlockLimit(node.blockLimit));
  }
  return nodes.map(node => {
    const blockId = String(node.blockId ?? "");
    return blockId ? { ...node, blockLimit: limits.get(blockId) ?? null } : { ...node, blockLimit: null };
  });
}

function normalizeCraftLinksForNodes(links = [], nodes = []) {
  const nodeIds = new Set(nodes.map(node => node.id));
  const result = [];
  const used = new Set();
  for (const rawLink of links) {
    const link = normalizeCraftLink(rawLink);
    if (!link.id || !nodeIds.has(link.fromNodeId) || !nodeIds.has(link.toNodeId) || link.fromNodeId === link.toNodeId) continue;
    const key = getCraftResolvedLinkKey(link, nodes);
    if (!key || used.has(key)) continue;
    used.add(key);
    result.push(link);
  }
  return result;
}

function getCraftResolvedLinkKey(link, nodes = []) {
  return getCraftResolvedPairKey(link.fromNodeId, link.toNodeId, nodes);
}

function getCraftResolvedPairKey(fromNodeId, toNodeId, nodes = []) {
  const from = nodes.find(node => node.id === fromNodeId);
  const to = nodes.find(node => node.id === toNodeId);
  const fromKey = getCraftResolvedEndpointId(from);
  const toKey = getCraftResolvedEndpointId(to);
  if (!fromKey || !toKey || fromKey === toKey) return "";
  return [fromKey, toKey].sort().join("|");
}

function getCraftResolvedEndpointId(node) {
  if (!node) return "";
  return node.blockId ? `block:${node.blockId}` : `node:${node.id}`;
}

function groupCraftNodesByBlock(nodes = []) {
  const groups = new Map();
  for (const node of nodes) {
    const blockId = String(node.blockId ?? "");
    if (!blockId) continue;
    const group = groups.get(blockId) ?? [];
    group.push(node);
    groups.set(blockId, group);
  }
  return groups;
}

function craftNodeToBounds(node = {}) {
  const width = Math.max(1, toInteger(node.width) || 1);
  const height = Math.max(1, toInteger(node.height) || 1);
  const x = Number(node.x) || 0;
  const y = Number(node.y) || 0;
  return {
    left: x - (width / 2),
    right: x + (width / 2),
    top: y - (height / 2),
    bottom: y + (height / 2),
    x,
    y,
    width,
    height
  };
}

function getCraftNodesBounds(nodes = []) {
  const bounds = nodes.map(craftNodeToBounds);
  if (!bounds.length) return null;
  const left = Math.min(...bounds.map(bound => bound.left));
  const right = Math.max(...bounds.map(bound => bound.right));
  const top = Math.min(...bounds.map(bound => bound.top));
  const bottom = Math.max(...bounds.map(bound => bound.bottom));
  return {
    left,
    right,
    top,
    bottom,
    x: (left + right) / 2,
    y: (top + bottom) / 2,
    width: Math.max(1, Math.round(right - left)),
    height: Math.max(1, Math.round(bottom - top))
  };
}

function mergeCraftNodesIntoTarget({ nodes = [], links = [], movingNodeIds = [], target = null, preferredPoint = null } = {}) {
  const movingIds = new Set(movingNodeIds);
  const targetNodes = getCraftTargetNodes(nodes, target).filter(node => !movingIds.has(node.id));
  const movingNodes = nodes.filter(node => movingIds.has(node.id));
  if (!targetNodes.length || !movingNodes.length) return { nodes, links };
  const targetBlockId = String(targetNodes.find(node => node.blockId)?.blockId ?? foundry.utils.randomID());
  const targetNodeIds = new Set(targetNodes.map(node => node.id));
  let nextNodes = nodes.map(node => {
    if (movingIds.has(node.id) || targetNodeIds.has(node.id) || (node.blockId && targetNodes.some(targetNode => targetNode.blockId === node.blockId))) {
      return { ...node, blockId: targetBlockId };
    }
    return node;
  });
  const nextMovingNodes = nextNodes.filter(node => movingIds.has(node.id));
  const stationaryNodes = nextNodes.filter(node => !movingIds.has(node.id));
  const placement = findCraftGroupPlacement({
    movingNodes: nextMovingNodes,
    stationaryNodes,
    targetBounds: getCraftNodesBounds(nextNodes.filter(node => node.blockId === targetBlockId && !movingIds.has(node.id))) ?? getCraftNodesBounds(targetNodes),
    preferredPoint
  });
  nextNodes = nextNodes.map(node => (
    movingIds.has(node.id) ? { ...node, x: node.x + placement.dx, y: node.y + placement.dy } : node
  ));
  return normalizeCraftRecipeParts(nextNodes, links);
}

function getCraftTargetNodes(nodes = [], target = null) {
  if (!target) return [];
  if (target.type === "block") return nodes.filter(node => node.blockId === target.id);
  const targetNode = nodes.find(node => node.id === target.id);
  if (!targetNode) return [];
  return targetNode.blockId ? nodes.filter(node => node.blockId === targetNode.blockId) : [targetNode];
}

function placeExtractedCraftNode(nodes = [], nodeId = "") {
  const node = nodes.find(entry => entry.id === nodeId);
  if (!node) return nodes;
  const blockers = getCraftOccupiedBounds(nodes, { excludeNodeIds: [nodeId] });
  const position = findNearestFreeCraftNodePosition(node, blockers);
  return nodes.map(entry => (
    entry.id === nodeId ? { ...entry, x: position.x, y: position.y } : entry
  ));
}

function getCraftOccupiedBounds(nodes = [], { excludeNodeIds = [], ignoreBlockIds = [] } = {}) {
  const excluded = new Set(excludeNodeIds);
  const ignoredBlocks = new Set(ignoreBlockIds);
  const candidates = nodes.filter(node => !excluded.has(node.id));
  const occupied = [];
  const groupedNodeIds = new Set();
  for (const [blockId, blockNodes] of groupCraftNodesByBlock(candidates).entries()) {
    if (ignoredBlocks.has(blockId)) continue;
    if (blockNodes.length <= 1) continue;
    const bounds = getCraftNodesBounds(blockNodes);
    if (!bounds) continue;
    occupied.push(bounds);
    blockNodes.forEach(node => groupedNodeIds.add(node.id));
  }
  for (const node of candidates) {
    if (groupedNodeIds.has(node.id)) continue;
    occupied.push(craftNodeToBounds(node));
  }
  return occupied;
}

function getCraftDragBlockers(nodes = [], movingNodeIds = [], { movingBlockId = "", sourceBlockId = "" } = {}) {
  const ignoreBlockIds = [];
  if (movingBlockId) ignoreBlockIds.push(movingBlockId);
  else if (sourceBlockId) ignoreBlockIds.push(sourceBlockId);
  return getCraftOccupiedBounds(nodes, { excludeNodeIds: movingNodeIds, ignoreBlockIds });
}

function findNearestFreeCraftNodePosition(node = {}, blockers = []) {
  const width = Math.max(1, toInteger(node.width) || 1);
  const height = Math.max(1, toInteger(node.height) || 1);
  const origin = {
    x: snapCraftGridCoordinate(node.x, width),
    y: snapCraftGridCoordinate(node.y, height)
  };
  let best = null;
  const seen = new Set();
  for (let radius = 0; radius <= CRAFT_BLOCK_SEARCH_RADIUS; radius += 1) {
    for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
      for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
        if (Math.max(Math.abs(offsetX), Math.abs(offsetY)) !== radius) continue;
        const candidate = {
          x: snapCraftGridCoordinate(origin.x + offsetX, width),
          y: snapCraftGridCoordinate(origin.y + offsetY, height)
        };
        const key = `${candidate.x}:${candidate.y}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const bounds = craftNodeToBounds({ ...node, ...candidate, width, height });
        if (blockers.some(blocker => craftBoundsOverlap(bounds, blocker))) continue;
        const distance = ((candidate.x - origin.x) ** 2) + ((candidate.y - origin.y) ** 2);
        const score = distance + (candidate.y * 0.0001) + (candidate.x * 0.000001);
        if (!best || score < best.score) best = { ...candidate, score };
      }
    }
    if (best) return { x: best.x, y: best.y };
  }
  return origin;
}

function findCraftGroupPlacement({ movingNodes = [], stationaryNodes = [], targetBounds = null, preferredPoint = null } = {}) {
  const movingBounds = getCraftNodesBounds(movingNodes);
  if (!movingBounds || !targetBounds) return { dx: 0, dy: 0 };
  const desired = preferredPoint ?? { x: targetBounds.x, y: targetBounds.y };
  let best = null;
  for (let radius = 0; radius <= CRAFT_BLOCK_SEARCH_RADIUS; radius += 1) {
    const minX = Math.floor(targetBounds.left - movingBounds.width - radius);
    const maxX = Math.ceil(targetBounds.right + movingBounds.width + radius);
    const minY = Math.floor(targetBounds.top - movingBounds.height - radius);
    const maxY = Math.ceil(targetBounds.bottom + movingBounds.height + radius);
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        const candidateX = snapCraftGridCoordinate(x, movingBounds.width);
        const candidateY = snapCraftGridCoordinate(y, movingBounds.height);
        const dx = candidateX - movingBounds.x;
        const dy = candidateY - movingBounds.y;
        if (craftNodesOverlapAny(movingNodes, stationaryNodes, dx, dy)) continue;
        const movedBounds = offsetCraftBounds(movingBounds, dx, dy);
        const distance = Math.hypot(movedBounds.x - desired.x, movedBounds.y - desired.y);
        const expansion = getCraftBoundsUnionArea(targetBounds, movedBounds);
        const score = distance + (expansion * 0.001);
        if (!best || score < best.score) best = { dx, dy, score };
      }
    }
    if (best) return best;
  }
  return { dx: 0, dy: 0 };
}

function resolveCraftDragPlacement(nodes = [], movingNodeIds = [], { deltaX = 0, deltaY = 0, movingBlockId = "", sourceBlockId = "" } = {}) {
  const movingIds = new Set(movingNodeIds);
  const movingNodes = nodes.filter(node => movingIds.has(node.id));
  if (!movingNodes.length) return { deltaX, deltaY, bounds: null };
  const blockers = getCraftDragBlockers(nodes, [...movingIds], { movingBlockId, sourceBlockId });
  const preferredBounds = offsetCraftBounds(getCraftNodesBounds(movingNodes), deltaX, deltaY);
  if (!blockers.some(blocker => craftBoundsOverlap(preferredBounds, blocker))) {
    return { deltaX, deltaY, bounds: preferredBounds };
  }
  return findNearestFreeCraftGroupDelta(movingNodes, blockers, { deltaX, deltaY });
}

function resolveCraftMoveCollisions(nodes = [], movingNodeIds = [], options = {}) {
  const resolved = resolveCraftDragPlacement(nodes, movingNodeIds, { ...options, deltaX: 0, deltaY: 0 });
  if (!resolved.deltaX && !resolved.deltaY) return nodes;
  const movingIds = new Set(movingNodeIds);
  return nodes.map(node => (
    movingIds.has(node.id) ? { ...node, x: node.x + resolved.deltaX, y: node.y + resolved.deltaY } : node
  ));
}

function findNearestFreeCraftGroupDelta(movingNodes = [], blockers = [], { deltaX = 0, deltaY = 0 } = {}) {
  const originBounds = getCraftNodesBounds(movingNodes);
  if (!originBounds) return { deltaX, deltaY, bounds: null };
  let best = null;
  const seen = new Set();
  for (let radius = 0; radius <= CRAFT_BLOCK_SEARCH_RADIUS; radius += 1) {
    for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
      for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
        if (Math.max(Math.abs(offsetX), Math.abs(offsetY)) !== radius) continue;
        const candidateDeltaX = deltaX + offsetX;
        const candidateDeltaY = deltaY + offsetY;
        const key = `${candidateDeltaX}:${candidateDeltaY}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const bounds = offsetCraftBounds(originBounds, candidateDeltaX, candidateDeltaY);
        if (blockers.some(blocker => craftBoundsOverlap(bounds, blocker))) continue;
        const distance = (offsetX ** 2) + (offsetY ** 2);
        const score = distance + (bounds.y * 0.0001) + (bounds.x * 0.000001);
        if (!best || score < best.score) best = { deltaX: candidateDeltaX, deltaY: candidateDeltaY, bounds, score };
      }
    }
    if (best) return best;
  }
  return { deltaX, deltaY, bounds: offsetCraftBounds(originBounds, deltaX, deltaY) };
}

function craftNodesOverlapAny(movingNodes = [], stationaryNodes = [], dx = 0, dy = 0) {
  return movingNodes.some(moving => {
    const movingBounds = offsetCraftBounds(craftNodeToBounds(moving), dx, dy);
    return stationaryNodes.some(stationary => craftBoundsOverlap(movingBounds, craftNodeToBounds(stationary)));
  });
}

function craftBoundsOverlap(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function offsetCraftBounds(bounds, dx = 0, dy = 0) {
  return {
    ...bounds,
    left: bounds.left + dx,
    right: bounds.right + dx,
    top: bounds.top + dy,
    bottom: bounds.bottom + dy,
    x: bounds.x + dx,
    y: bounds.y + dy
  };
}

function getCraftBoundsUnionArea(a, b) {
  const width = Math.max(a.right, b.right) - Math.min(a.left, b.left);
  const height = Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top);
  return Math.max(0, width * height);
}

function toOptionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeCraftViewport(viewport = {}) {
  return {
    x: Math.round(Number(viewport.x) || 0),
    y: Math.round(Number(viewport.y) || 0),
    zoom: clampCraftZoom(viewport.zoom)
  };
}

function clampCraftZoom(value) {
  const zoom = Number(value);
  if (!Number.isFinite(zoom)) return 1;
  return Math.max(CRAFT_MIN_ZOOM, Math.min(CRAFT_MAX_ZOOM, zoom));
}

function isValidCraftComponentItem(item) {
  return Boolean(item && !item.actor && !["ability", "trauma", "disease"].includes(item.type));
}

function getDefaultCraftSkillKey(skillSettings = []) {
  return skillSettings.some(skill => skill.key === "repair")
    ? "repair"
    : String(skillSettings.at(0)?.key ?? "");
}

function getCraftGridStep(element) {
  return getCraftGridMetrics(element).step;
}

function getCraftGridMetrics(element) {
  const computed = element ? getComputedStyle(element) : null;
  const cell = parseCssLength(computed?.getPropertyValue("--fallout-maw-inventory-cell-size"), element) || 52;
  const gap = parseCssLength(computed?.getPropertyValue("--fallout-maw-inventory-grid-gap"), element) || 4;
  const step = Math.max(1, cell + gap) || CRAFT_GRID_FALLBACK_STEP;
  return { cell, gap, step };
}

function clampCraftViewportToVisibleNode(viewport, workspace, nodes = []) {
  const workspaceRect = workspace?.getBoundingClientRect();
  if (!workspaceRect || workspaceRect.width <= 0 || workspaceRect.height <= 0 || !nodes.length) return viewport;
  const metrics = getCraftGridMetrics(workspace);
  const context = { metrics, width: workspaceRect.width, height: workspaceRect.height };
  if (nodes.some(node => isCraftNodeVisibleInViewport(node, viewport, context))) return viewport;
  let nearestAdjustment = null;
  for (const node of nodes) {
    const nodeRect = getCraftNodeScreenRect(node, viewport, context);
    const dx = getCraftNodeContainmentDelta(nodeRect.left, nodeRect.right, context.width);
    const dy = getCraftNodeContainmentDelta(nodeRect.top, nodeRect.bottom, context.height);
    const distance = Math.hypot(dx, dy);
    if (!nearestAdjustment || distance < nearestAdjustment.distance) {
      nearestAdjustment = { dx, dy, distance };
    }
  }
  if (!nearestAdjustment) return viewport;
  return normalizeCraftViewport({
    ...viewport,
    x: viewport.x + nearestAdjustment.dx,
    y: viewport.y + nearestAdjustment.dy
  });
}

function isCraftNodeVisibleInViewport(node, viewport, context) {
  const nodeRect = getCraftNodeScreenRect(node, viewport, context);
  return nodeRect.left >= 0
    && nodeRect.right <= context.width
    && nodeRect.top >= 0
    && nodeRect.bottom <= context.height;
}

function getCraftNodeContainmentDelta(start, end, size) {
  const nodeSize = end - start;
  if (nodeSize > size) return (size / 2) - ((start + end) / 2);
  if (start < 0) return -start;
  if (end > size) return size - end;
  return 0;
}

function getCraftNodeScreenRect(node, viewport, context) {
  const metrics = context.metrics;
  const width = Math.max(1, toInteger(node.width) || 1);
  const height = Math.max(1, toInteger(node.height) || 1);
  const widthPx = (width * metrics.cell) + ((width - 1) * metrics.gap);
  const heightPx = (height * metrics.cell) + ((height - 1) * metrics.gap);
  const centerX = ((Number(node.x) || 0) * metrics.step);
  const centerY = ((Number(node.y) || 0) * metrics.step);
  const zoom = clampCraftZoom(viewport.zoom);
  const screenCenterX = (context.width / 2) + viewport.x + (centerX * zoom);
  const screenCenterY = (context.height / 2) + viewport.y + (centerY * zoom);
  const halfWidth = (widthPx * zoom) / 2;
  const halfHeight = (heightPx * zoom) / 2;
  return {
    left: screenCenterX - halfWidth,
    right: screenCenterX + halfWidth,
    top: screenCenterY - halfHeight,
    bottom: screenCenterY + halfHeight
  };
}

function parseCssLength(value, element) {
  const raw = String(value ?? "").trim();
  const numeric = Number.parseFloat(raw);
  if (!Number.isFinite(numeric)) return 0;
  if (raw.endsWith("rem")) return numeric * (Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
  if (raw.endsWith("em")) return numeric * (Number.parseFloat(getComputedStyle(element).fontSize) || 16);
  return numeric;
}

function getCraftConnectorGeometry(fromElement, toElement, svg, bend = null, anchors = null) {
  const from = getElementRectRelativeToSvg(fromElement, svg);
  const to = getElementRectRelativeToSvg(toElement, svg);
  if (!from || !to) return null;
  return buildCraftConnectorGeometry(from, to, bend, anchors);
}

function getCraftConnectorGeometryToPoint(fromElement, event, svg) {
  const from = getElementRectRelativeToSvg(fromElement, svg);
  const point = getCraftSvgPointFromEvent(event, svg);
  const to = {
    left: point.x,
    right: point.x,
    top: point.y,
    bottom: point.y,
    width: 1,
    height: 1
  };
  if (!from) return null;
  return buildCraftConnectorGeometry(from, to, null, {
    from: anchorToData(getCraftResolvedAnchor(from, null, point))
  });
}

function getCraftAttachPreviewGeometry(fromElement, toElement, svg, event) {
  const from = getElementRectRelativeToSvg(fromElement, svg);
  const to = getElementRectRelativeToSvg(toElement, svg);
  const point = getCraftSvgPointFromEvent(event, svg);
  if (!from || !to) return null;
  return buildCraftConnectorGeometry(from, to, null, {
    from: anchorToData(getCraftResolvedAnchor(from, null, getRectCenter(to))),
    to: anchorToData(getCraftSnapAnchor(to, point, getRectCenter(from)))
  });
}

function getCraftAttachTarget(workspace, event, sourceNodeId) {
  const pointElement = document.elementFromPoint(event.clientX, event.clientY)?.closest?.("[data-craft-node-id]");
  if (pointElement && workspace.contains(pointElement) && pointElement.dataset.craftNodeId !== sourceNodeId) return pointElement;
  let nearest = null;
  let nearestDistance = 34;
  for (const node of workspace.querySelectorAll("[data-craft-node-id]")) {
    if (node.dataset.craftNodeId === sourceNodeId) continue;
    const rect = node.getBoundingClientRect();
    const distance = getPointToDomRectDistance(event.clientX, event.clientY, rect);
    if (distance < nearestDistance) {
      nearest = node;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function getPointToDomRectDistance(x, y, rect) {
  const dx = Math.max(rect.left - x, 0, x - rect.right);
  const dy = Math.max(rect.top - y, 0, y - rect.bottom);
  return Math.hypot(dx, dy);
}

function getCraftSvgPointFromEvent(event, svg) {
  const svgRect = svg.getBoundingClientRect();
  const zoom = getCraftSvgZoom(svg);
  return {
    x: (event.clientX - svgRect.left) / zoom,
    y: (event.clientY - svgRect.top) / zoom
  };
}

function getElementRectRelativeToSvg(element, svg) {
  if (!element || !svg) return null;
  const rect = element.getBoundingClientRect();
  const svgRect = svg.getBoundingClientRect();
  const zoom = getCraftSvgZoom(svg);
  return {
    left: (rect.left - svgRect.left) / zoom,
    right: (rect.right - svgRect.left) / zoom,
    top: (rect.top - svgRect.top) / zoom,
    bottom: (rect.bottom - svgRect.top) / zoom,
    width: rect.width / zoom,
    height: rect.height / zoom
  };
}

function getCraftSvgZoom(svg) {
  const workspace = svg?.closest?.("[data-craft-workspace]");
  const zoom = Number.parseFloat(getComputedStyle(workspace ?? svg).getPropertyValue("--craft-zoom"));
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

function getRawCraftLinkBend(link) {
  const x = toOptionalNumber(link.bendX);
  const y = toOptionalNumber(link.bendY);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function getCraftLinkBend(link, svg = null) {
  const bend = getRawCraftLinkBend(link);
  if (!bend) return null;
  if (!svg || isLegacyCraftBend(link)) return bend;
  return craftStoredBendToSvgPoint(svg, bend);
}

function isLegacyCraftBend(link) {
  const bend = getRawCraftLinkBend(link);
  if (!bend) return false;
  return Math.max(Math.abs(bend.x), Math.abs(bend.y)) > CRAFT_LEGACY_BEND_PIXEL_THRESHOLD;
}

function craftStoredBendToSvgPoint(svg, bend) {
  const center = getCraftSvgLocalCenter(svg);
  const metrics = getCraftGridMetrics(svg?.closest?.("[data-craft-workspace]"));
  return {
    x: center.x + (bend.x * metrics.step),
    y: center.y + (bend.y * metrics.step)
  };
}

function craftSvgPointToStoredBend(svg, point) {
  const center = getCraftSvgLocalCenter(svg);
  const metrics = getCraftGridMetrics(svg?.closest?.("[data-craft-workspace]"));
  return {
    bendX: roundCraftBendCoordinate((Number(point?.x) || 0) - center.x, metrics.step),
    bendY: roundCraftBendCoordinate((Number(point?.y) || 0) - center.y, metrics.step)
  };
}

function roundCraftBendCoordinate(value, step) {
  const normalizedStep = Math.max(1, Number(step) || CRAFT_GRID_FALLBACK_STEP);
  return Math.round((value / normalizedStep) * 1000) / 1000;
}

function getCraftSvgLocalCenter(svg) {
  const rect = svg?.getBoundingClientRect?.();
  const zoom = getCraftSvgZoom(svg);
  const width = rect?.width ? rect.width / zoom : 0;
  const height = rect?.height ? rect.height / zoom : 0;
  return {
    x: width / 2,
    y: height / 2
  };
}

function buildCraftConnectorGeometry(from, to, bend = null, anchors = null) {
  const fromCenter = getRectCenter(from);
  const toCenter = getRectCenter(to);
  let startAnchor;
  let endAnchor;
  let path;
  if (bend) {
    startAnchor = getCraftResolvedAnchor(from, anchors?.from, bend);
    endAnchor = getCraftResolvedAnchor(to, anchors?.to, bend);
    path = buildBentTubeCenterPath(startAnchor, bend, endAnchor);
  } else {
    startAnchor = getCraftResolvedAnchor(from, anchors?.from, toCenter);
    endAnchor = getCraftResolvedAnchor(to, anchors?.to, fromCenter);
    path = buildDefaultTubeCenterPath(startAnchor, endAnchor);
  }
  return {
    centerPath: path,
    start: {
      ...startAnchor.tubePoint,
      socketPath: buildCraftSocketPath(startAnchor)
    },
    end: {
      ...endAnchor.tubePoint,
      socketPath: buildCraftSocketPath(endAnchor)
    }
  };
}

function buildDefaultTubeCenterPath(startAnchor, endAnchor) {
  const start = startAnchor.tubePoint;
  const end = endAnchor.tubePoint;
  const distance = Math.max(1, getPointDistance(start, end));
  const direction = normalizeVector({ x: end.x - start.x, y: end.y - start.y });
  const baseHandle = Math.min(120, distance * 0.34);
  const startHandle = baseHandle * Math.max(0, dotVector(startAnchor.normal, direction));
  const endHandle = baseHandle * Math.max(0, dotVector(endAnchor.normal, { x: -direction.x, y: -direction.y }));
  const c1 = addScaledVector(start, startAnchor.normal, startHandle);
  const c2 = addScaledVector(end, endAnchor.normal, endHandle);
  return `M ${formatPoint(start)} C ${formatPoint(c1)} ${formatPoint(c2)} ${formatPoint(end)}`;
}

function buildBentTubeCenterPath(startAnchor, bend, endAnchor) {
  const start = startAnchor.tubePoint;
  const end = endAnchor.tubePoint;
  if (isPointNearSegment(bend, start, end, 10)) return buildDefaultTubeCenterPath(startAnchor, endAnchor);
  const startDistance = getPointDistance(start, bend);
  const endDistance = getPointDistance(end, bend);
  const startDirection = normalizeVector({ x: bend.x - start.x, y: bend.y - start.y });
  const endDirection = normalizeVector({ x: end.x - bend.x, y: end.y - bend.y });
  const startHandle = Math.min(100, startDistance * 0.34) * Math.max(0, dotVector(startAnchor.normal, startDirection));
  const endHandle = Math.min(100, endDistance * 0.34) * Math.max(0, dotVector(endAnchor.normal, { x: -endDirection.x, y: -endDirection.y }));
  const bendTangent = getBendTangent(start, bend, end);
  const bendHandleA = Math.min(90, startDistance * 0.28);
  const bendHandleB = Math.min(90, endDistance * 0.28);
  const c1 = addScaledVector(start, startAnchor.normal, startHandle);
  const c2 = addScaledVector(bend, bendTangent, -bendHandleA);
  const c3 = addScaledVector(bend, bendTangent, bendHandleB);
  const c4 = addScaledVector(end, endAnchor.normal, endHandle);
  return `M ${formatPoint(start)} C ${formatPoint(c1)} ${formatPoint(c2)} ${formatPoint(bend)} C ${formatPoint(c3)} ${formatPoint(c4)} ${formatPoint(end)}`;
}

function getRectAnchor(rect, toward) {
  const center = getRectCenter(rect);
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  if (!dx && !dy) {
    const normal = { x: 0, y: 1 };
    return {
      side: "bottom",
      offset: 0.5,
      point: center,
      tubePoint: addScaledVector(center, normal, CRAFT_SOCKET_DEPTH_PX),
      normal,
      tangent: { x: 1, y: 0 }
    };
  }
  const halfWidth = Math.max(1, rect.width / 2);
  const halfHeight = Math.max(1, rect.height / 2);
  const socketHalfWidth = CRAFT_SOCKET_HALF_WIDTH_PX;
  let point;
  let normal;
  let side;
  let offset;
  if (Math.abs(dx / halfWidth) > Math.abs(dy / halfHeight)) {
    const sign = Math.sign(dx) || 1;
    const scale = halfWidth / Math.abs(dx);
    point = {
      x: center.x + (sign * halfWidth),
      y: clampNumber(center.y + (dy * scale), rect.top + socketHalfWidth, rect.bottom - socketHalfWidth)
    };
    side = sign < 0 ? "left" : "right";
    offset = (point.y - rect.top) / Math.max(1, rect.height);
    normal = { x: sign, y: 0 };
  } else {
    const sign = Math.sign(dy) || 1;
    const scale = halfHeight / Math.abs(dy);
    point = {
      x: clampNumber(center.x + (dx * scale), rect.left + socketHalfWidth, rect.right - socketHalfWidth),
      y: center.y + (sign * halfHeight)
    };
    side = sign < 0 ? "top" : "bottom";
    offset = (point.x - rect.left) / Math.max(1, rect.width);
    normal = { x: 0, y: sign };
  }
  return {
    side,
    offset: clampNumber(offset, 0, 1),
    point,
    tubePoint: addScaledVector(point, normal, CRAFT_SOCKET_DEPTH_PX),
    normal,
    tangent: { x: -normal.y, y: normal.x }
  };
}

function getNearestRectAnchor(rect, point) {
  const distances = [
    { side: "left", value: Math.abs(point.x - rect.left) },
    { side: "right", value: Math.abs(point.x - rect.right) },
    { side: "top", value: Math.abs(point.y - rect.top) },
    { side: "bottom", value: Math.abs(point.y - rect.bottom) }
  ].sort((a, b) => a.value - b.value);
  const side = distances[0]?.side ?? "bottom";
  const offset = side === "left" || side === "right"
    ? (point.y - rect.top) / Math.max(1, rect.height)
    : (point.x - rect.left) / Math.max(1, rect.width);
  return getRectAnchorFromData(rect, { side, offset });
}

function getCraftSnapAnchor(rect, point, fallbackToward) {
  return isPointInsideRect(point, rect)
    ? getRectAnchor(rect, fallbackToward)
    : getNearestRectAnchor(rect, point);
}

function isPointInsideRect(point, rect) {
  return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
}

function getCraftResolvedAnchor(rect, anchor, fallbackToward) {
  return anchor?.side ? getRectAnchorFromData(rect, anchor) : getRectAnchor(rect, fallbackToward);
}

function getRectAnchorFromData(rect, anchor) {
  const side = normalizeCraftAnchorSide(anchor?.side) || "bottom";
  const rawOffset = Number(anchor?.offset);
  const offset = Number.isFinite(rawOffset) ? clampNumber(rawOffset, 0, 1) : 0.5;
  const socketHalfWidth = CRAFT_SOCKET_HALF_WIDTH_PX;
  let point;
  let normal;
  if (side === "left" || side === "right") {
    const sign = side === "left" ? -1 : 1;
    point = {
      x: sign < 0 ? rect.left : rect.right,
      y: clampNumber(rect.top + (rect.height * offset), rect.top + socketHalfWidth, rect.bottom - socketHalfWidth)
    };
    normal = { x: sign, y: 0 };
  } else {
    const sign = side === "top" ? -1 : 1;
    point = {
      x: clampNumber(rect.left + (rect.width * offset), rect.left + socketHalfWidth, rect.right - socketHalfWidth),
      y: sign < 0 ? rect.top : rect.bottom
    };
    normal = { x: 0, y: sign };
  }
  return {
    side,
    offset,
    point,
    tubePoint: addScaledVector(point, normal, CRAFT_SOCKET_DEPTH_PX),
    normal,
    tangent: { x: -normal.y, y: normal.x }
  };
}

function anchorToData(anchor) {
  const offset = toOptionalNumber(anchor?.offset);
  return {
    side: normalizeCraftAnchorSide(anchor?.side),
    offset: Number.isFinite(offset) ? clampNumber(offset, 0, 1) : null
  };
}

function getCraftLinkAnchor(link, role) {
  const offset = toOptionalNumber(link?.[`${role}AnchorOffset`]);
  return {
    side: normalizeCraftAnchorSide(link?.[`${role}AnchorSide`]),
    offset: Number.isFinite(offset) ? clampNumber(offset, 0, 1) : null
  };
}

function getCraftLinkAnchors(link) {
  return {
    from: getCraftLinkAnchor(link, "from"),
    to: getCraftLinkAnchor(link, "to")
  };
}

function buildCraftAnchorUpdateData(anchors = {}) {
  const fromOffset = toOptionalNumber(anchors.from?.offset);
  const toOffset = toOptionalNumber(anchors.to?.offset);
  return {
    fromAnchorSide: normalizeCraftAnchorSide(anchors.from?.side),
    fromAnchorOffset: Number.isFinite(fromOffset) ? clampNumber(fromOffset, 0, 1) : null,
    toAnchorSide: normalizeCraftAnchorSide(anchors.to?.side),
    toAnchorOffset: Number.isFinite(toOffset) ? clampNumber(toOffset, 0, 1) : null
  };
}

function normalizeCraftAnchorSide(side) {
  const value = String(side ?? "");
  return ["left", "right", "top", "bottom"].includes(value) ? value : "";
}

function buildCraftSocketPath(anchor) {
  const halfWidth = CRAFT_SOCKET_HALF_WIDTH_PX;
  const inset = 0.5;
  const outer = addScaledVector(anchor.point, anchor.normal, CRAFT_SOCKET_DEPTH_PX);
  const inner = addScaledVector(anchor.point, anchor.normal, inset);
  const corners = [
    addScaledVector(inner, anchor.tangent, -halfWidth),
    addScaledVector(inner, anchor.tangent, halfWidth),
    addScaledVector(outer, anchor.tangent, halfWidth),
    addScaledVector(outer, anchor.tangent, -halfWidth)
  ];
  return `M ${formatPoint(corners[0])} L ${formatPoint(corners[1])} L ${formatPoint(corners[2])} L ${formatPoint(corners[3])} Z`;
}

function getBendTangent(start, bend, end) {
  const incoming = normalizeVector({ x: bend.x - start.x, y: bend.y - start.y });
  const outgoing = normalizeVector({ x: end.x - bend.x, y: end.y - bend.y });
  const tangent = normalizeVector({ x: incoming.x + outgoing.x, y: incoming.y + outgoing.y });
  if (tangent.x || tangent.y) return tangent;
  return normalizeVector({ x: end.x - start.x, y: end.y - start.y });
}

function normalizeVector(vector) {
  const length = Math.hypot(vector.x, vector.y);
  if (length < 0.0001) return { x: 0, y: 0 };
  return { x: vector.x / length, y: vector.y / length };
}

function dotVector(a, b) {
  return (a.x * b.x) + (a.y * b.y);
}

function getPointDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function isPointNearSegment(point, start, end, threshold) {
  return getPointToSegmentDistance(point, start, end) <= threshold;
}

function getPointToSegmentDistance(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = (dx * dx) + (dy * dy);
  if (lengthSquared < 0.0001) return getPointDistance(point, start);
  const t = clampNumber(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, 0, 1);
  const projection = {
    x: start.x + (dx * t),
    y: start.y + (dy * t)
  };
  return getPointDistance(point, projection);
}

function addScaledVector(point, vector, scale) {
  return {
    x: point.x + (vector.x * scale),
    y: point.y + (vector.y * scale)
  };
}

function addVectors(a, b) {
  return {
    x: a.x + b.x,
    y: a.y + b.y
  };
}

function clampNumber(value, min, max) {
  if (min > max) return (min + max) / 2;
  return Math.max(min, Math.min(max, value));
}

function formatPoint(point) {
  return `${roundPathNumber(point.x)} ${roundPathNumber(point.y)}`;
}

function getRectCenter(rect) {
  return {
    x: rect.left + (rect.width / 2),
    y: rect.top + (rect.height / 2)
  };
}

function getRectEdgePoint(rect, toward) {
  const center = getRectCenter(rect);
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  if (!dx && !dy) return center;
  const halfWidth = Math.max(1, rect.width / 2);
  const halfHeight = Math.max(1, rect.height / 2);
  const scale = Math.min(
    dx ? Math.abs(halfWidth / dx) : Number.POSITIVE_INFINITY,
    dy ? Math.abs(halfHeight / dy) : Number.POSITIVE_INFINITY
  );
  return {
    x: center.x + (dx * scale),
    y: center.y + (dy * scale)
  };
}

function roundPathNumber(value) {
  return Number(value).toFixed(2).replace(/\.?0+$/, "");
}

function getWeaponFunctionSection(element) {
  return element?.closest?.("[data-weapon-function-section]") ?? null;
}

function getWeaponFunctionPath(section) {
  return String(section?.dataset?.weaponFunctionPath ?? "") || "system.functions.weapon";
}

function getAdditionalWeaponFunctionEntries(item) {
  const additionalWeapons = item?.system?.functions?.additionalWeapons;
  return getWeaponFunctionEntries(additionalWeapons);
}

function getModuleWeaponFunctionEntries(item) {
  const moduleWeapons = item?.system?.functions?.module?.additionalWeapons;
  return getWeaponFunctionEntries(moduleWeapons);
}

function getWeaponFunctionEntries(additionalWeapons) {
  if (Array.isArray(additionalWeapons)) {
    return additionalWeapons
      .map((data, index) => ({
        id: String(data?.id || `legacy${index}`),
        data: {
          ...data,
          id: String(data?.id || `legacy${index}`)
        }
      }))
      .filter(entry => entry.id);
  }
  if (!additionalWeapons || typeof additionalWeapons !== "object") return [];
  return Object.entries(additionalWeapons)
    .map(([id, data]) => ({
      id: String(id),
      data: {
        ...data,
        id: String(data?.id || id)
      }
    }))
    .filter(entry => entry.id);
}

function buildToolFunctionEntries(item, toolSettings, skillSettings) {
  const skillChoices = [
    { value: "", label: "Не используется" },
    ...skillSettings.map(skill => ({ value: skill.key, label: skill.label }))
  ];
  const classChoices = ["D", "C", "B", "A", "S"];
  const functions = item.system?.functions?.tools ?? {};
  const selectedToolKey = getSelectedToolFunctionKey(item) || toolSettings[0]?.key || "";
  const selectedTool = toolSettings.find(tool => tool.key === selectedToolKey) ?? toolSettings[0];
  if (!selectedTool) return [];
  const data = functions?.[selectedTool.key] ?? {};
  const skillKey = String(data.skillKey ?? "");
  const toolClass = String(data.toolClass ?? "D");

  return [selectedTool].map(tool => {
    return {
      ...tool,
      functionKey: ITEM_FUNCTIONS.tool,
      enabled: hasItemFunction(item, ITEM_FUNCTIONS.tool, { ignoreBroken: true }),
      useAsItem: Boolean(data.useAsItem),
      toolClass,
      toolChoices: toolSettings.map(choice => ({
        value: choice.key,
        label: choice.label,
        selected: choice.key === tool.key
      })),
      classChoices: classChoices.map(value => ({
        value,
        label: value,
        selected: value === toolClass
      })),
      skillChoices: skillChoices.map(choice => ({
        ...choice,
        selected: choice.value === skillKey
      })),
      supplyValue: Number(data.supply?.value) || 0,
      supplyMax: Number(data.supply?.max) || 0,
      skillValue: Number(data.skillValue) || 0,
      skillKey
    };
  });
}

function buildSkillChoices(selectedKey = "", skillSettings = []) {
  const selected = String(selectedKey ?? "");
  return skillSettings.map(skill => ({
    key: skill.key,
    label: skill.label,
    selected: skill.key === selected
  }));
}

function createTrapDetectionCondition(type = "", source = {}) {
  const normalizedType = type === TRAP_DETECTION_LIGHTING_CONDITION ? TRAP_DETECTION_LIGHTING_CONDITION : "";
  return {
    id: String(source?.id ?? "").trim() || foundry.utils.randomID(),
    type: normalizedType,
    thresholds: normalizedType === TRAP_DETECTION_LIGHTING_CONDITION
      ? DEFAULT_TRAP_LIGHTING_THRESHOLDS.map(entry => ({ ...entry }))
      : []
  };
}

function normalizeTrapDetectionConditions(conditions = []) {
  return (Array.isArray(conditions) ? conditions : Object.values(conditions ?? {}))
    .map(condition => {
      const type = condition?.type === TRAP_DETECTION_LIGHTING_CONDITION ? TRAP_DETECTION_LIGHTING_CONDITION : "";
      return {
        id: String(condition?.id ?? "").trim() || foundry.utils.randomID(),
        type,
        thresholds: type === TRAP_DETECTION_LIGHTING_CONDITION
          ? (Array.isArray(condition?.thresholds) ? condition.thresholds : Object.values(condition?.thresholds ?? {}))
            .map(threshold => ({
              illuminationPercent: Math.max(0, Math.min(100, toInteger(threshold?.illuminationPercent))),
              difficultyBonus: Math.max(0, toInteger(threshold?.difficultyBonus))
            }))
          : []
      };
    })
    .filter((condition, index, entries) => (
      condition.type !== TRAP_DETECTION_LIGHTING_CONDITION
      || entries.findIndex(entry => entry.type === TRAP_DETECTION_LIGHTING_CONDITION) === index
    ));
}

function buildTrapDetectionConditionRows(conditions = []) {
  return normalizeTrapDetectionConditions(conditions).map((condition, index) => ({
    ...condition,
    index,
    isPending: !condition.type,
    isLighting: condition.type === TRAP_DETECTION_LIGHTING_CONDITION,
    typeLabel: game.i18n.localize("FALLOUTMAW.Item.TrapDetectionConditionLighting"),
    typeChoices: [
      {
        value: "",
        label: game.i18n.localize("FALLOUTMAW.Item.TrapDetectionConditionSelect"),
        selected: !condition.type,
        disabled: true
      },
      {
        value: TRAP_DETECTION_LIGHTING_CONDITION,
        label: game.i18n.localize("FALLOUTMAW.Item.TrapDetectionConditionLighting"),
        selected: condition.type === TRAP_DETECTION_LIGHTING_CONDITION
      }
    ],
    thresholdRows: condition.thresholds.map((threshold, thresholdIndex) => ({
      ...threshold,
      thresholdIndex
    }))
  }));
}

function canAddTrapDetectionCondition(conditions = []) {
  const normalized = normalizeTrapDetectionConditions(conditions);
  return !normalized.some(condition => !condition.type || condition.type === TRAP_DETECTION_LIGHTING_CONDITION);
}

function buildTrapActivationModeChoices(selectedMode = "exit") {
  const selected = ["enter", "exit", "linkedAction"].includes(selectedMode) ? selectedMode : "exit";
  return [
    {
      value: "enter",
      label: game.i18n.localize("FALLOUTMAW.Item.TrapActivationModeEnter"),
      selected: selected === "enter"
    },
    {
      value: "exit",
      label: game.i18n.localize("FALLOUTMAW.Item.TrapActivationModeExit"),
      selected: selected === "exit"
    },
    {
      value: "linkedAction",
      label: game.i18n.localize("FALLOUTMAW.Item.TrapActivationModeLinkedAction"),
      selected: selected === "linkedAction"
    }
  ];
}

function buildTrapRechargeUnitChoices(selectedUnit = "seconds") {
  const selected = ["seconds", "minutes", "hours"].includes(selectedUnit) ? selectedUnit : "seconds";
  return [
    {
      value: "seconds",
      label: game.i18n.localize("FALLOUTMAW.Item.TrapRechargeUnitSeconds"),
      selected: selected === "seconds"
    },
    {
      value: "minutes",
      label: game.i18n.localize("FALLOUTMAW.Item.TrapRechargeUnitMinutes"),
      selected: selected === "minutes"
    },
    {
      value: "hours",
      label: game.i18n.localize("FALLOUTMAW.Item.TrapRechargeUnitHours"),
      selected: selected === "hours"
    }
  ];
}

function buildTrapEffectModeChoices(selectedMode = "explosion") {
  const selected = ["explosion", "attack"].includes(selectedMode) ? selectedMode : "explosion";
  return [
    {
      value: "explosion",
      label: game.i18n.localize("FALLOUTMAW.Item.TrapEffectModeExplosion"),
      selected: selected === "explosion"
    },
    {
      value: "attack",
      label: game.i18n.localize("FALLOUTMAW.Item.TrapEffectModeAttack"),
      selected: selected === "attack"
    }
  ];
}

function buildToolChoices(selectedKey = "", toolSettings = []) {
  const selected = String(selectedKey ?? "");
  return toolSettings.map(tool => ({
    key: tool.key,
    label: tool.label,
    selected: tool.key === selected
  }));
}

function buildToolClassChoices(selectedClass = "D") {
  const selected = String(selectedClass ?? "D") || "D";
  return ["D", "C", "B", "A", "S"].map(value => ({
    value,
    label: value,
    selected: value === selected
  }));
}

function buildImplantLimbRows(item, creatureOptions) {
  const selected = normalizeImplantLimbKeys(item.system?.functions?.implant?.limbKeys);
  const choices = buildImplantLimbChoiceEntries(creatureOptions, selected);
  return selected.map((selectedKey, index) => {
    const usedByOtherRows = new Set(selected.filter((_, usedIndex) => usedIndex !== index));
    return {
      key: selectedKey,
      choices: choices
        .filter(choice => choice.key === selectedKey || !usedByOtherRows.has(choice.key))
        .map(choice => ({
          ...choice,
          selected: choice.key === selectedKey
        }))
    };
  });
}

function buildProsthesisLimbRows(item, creatureOptions) {
  const selected = normalizeProsthesisLimbKeys(item.system?.functions?.prosthesis?.limbKeys);
  const choices = buildProsthesisLimbChoiceEntries(creatureOptions, selected);
  return selected.map((selectedKey, index) => {
    const usedByOtherRows = new Set(selected.filter((_, usedIndex) => usedIndex !== index));
    return {
      key: selectedKey,
      choices: choices
        .filter(choice => choice.key === selectedKey || !usedByOtherRows.has(choice.key))
        .map(choice => ({
          ...choice,
          selected: choice.key === selectedKey
        }))
    };
  });
}

function buildProsthesisBlockedEffectRows(item, damageTypeSettings = []) {
  const selected = normalizeProsthesisBlockedEffects(item.system?.functions?.prosthesis?.blockedPeriodicEffects);
  const choices = buildProsthesisBlockedEffectChoiceEntries(damageTypeSettings, selected);
  return selected.map((selectedKey, index) => {
    const usedByOtherRows = new Set(selected.filter((_, usedIndex) => usedIndex !== index));
    return {
      key: selectedKey,
      choices: choices
        .filter(choice => choice.key === selectedKey || !usedByOtherRows.has(choice.key))
        .map(choice => ({
          ...choice,
          selected: choice.key === selectedKey
        }))
    };
  });
}

function canAddProsthesisBlockedEffect(item, damageTypeSettings = []) {
  const selected = normalizeProsthesisBlockedEffects(item.system?.functions?.prosthesis?.blockedPeriodicEffects);
  return buildProsthesisBlockedEffectChoiceEntries(damageTypeSettings, selected).some(choice => !selected.includes(choice.key));
}

function buildConstructPartBlockedEffectRows(item, damageTypeSettings = []) {
  const selected = getConstructPartBlockedEffects(item);
  const choices = buildConstructPartBlockedEffectChoiceEntries(damageTypeSettings, selected);
  return selected.map((selectedKey, index) => {
    const usedByOtherRows = new Set(selected.filter((_, usedIndex) => usedIndex !== index));
    return {
      key: selectedKey,
      choices: choices
        .filter(choice => choice.key === selectedKey || !usedByOtherRows.has(choice.key))
        .map(choice => ({
          ...choice,
          selected: choice.key === selectedKey
        }))
    };
  });
}

function canAddConstructPartBlockedEffect(item, damageTypeSettings = []) {
  const selected = getConstructPartBlockedEffects(item);
  return buildConstructPartBlockedEffectChoiceEntries(damageTypeSettings, selected).some(choice => !selected.includes(choice.key));
}

function buildProsthesisBlockedEffectChoiceEntries(damageTypeSettings = [], extraKeys = []) {
  const choices = new Map();
  choices.set(BLEEDING_DAMAGE_TYPE_KEY, game.i18n.localize("FALLOUTMAW.Item.ProsthesisBleedingEffect"));
  for (const damageType of getFirstAidRemovablePeriodicDamageTypes(damageTypeSettings)) {
    choices.set(damageType.key, damageType.periodicLabel || damageType.label || damageType.key);
  }
  for (const key of normalizeProsthesisBlockedEffects(extraKeys)) {
    if (!choices.has(key)) choices.set(key, key);
  }
  return Array.from(choices, ([key, label]) => ({ key, label }));
}

function buildConstructPartBlockedEffectChoiceEntries(damageTypeSettings = [], extraKeys = []) {
  return buildProsthesisBlockedEffectChoiceEntries(damageTypeSettings, extraKeys);
}

function normalizeProsthesisBlockedEffects(value) {
  const source = Array.isArray(value)
    ? value
    : value && typeof value === "object" ? Object.values(value) : [];
  return Array.from(new Set(source
    .map(key => String(key ?? "").trim())
    .filter(Boolean)));
}

function normalizeConstructPartBlockedEffects(value) {
  return normalizeProsthesisBlockedEffects(value);
}

function getConstructPartBlockedEffects(itemOrData = null) {
  return normalizeConstructPartBlockedEffects(
    itemOrData?._source?.system?.functions?.constructPart?.blockedPeriodicEffects
      ?? itemOrData?.system?._source?.functions?.constructPart?.blockedPeriodicEffects
      ?? []
  );
}

function canAddImplantLimb(item, creatureOptions) {
  const selected = normalizeImplantLimbKeys(item.system?.functions?.implant?.limbKeys);
  return buildImplantLimbChoiceEntries(creatureOptions, selected).some(choice => !selected.includes(choice.key));
}

function buildImplantLimbChoiceEntries(creatureOptions, extraKeys = []) {
  return buildProsthesisLimbChoiceEntries(creatureOptions, normalizeImplantLimbKeys(extraKeys));
}

function normalizeImplantLimbKeys(value) {
  const source = Array.isArray(value)
    ? value
    : value && typeof value === "object" ? Object.values(value) : [];
  return Array.from(new Set(source
    .map(key => String(key ?? "").trim())
    .filter(Boolean)));
}

function canAddProsthesisLimb(item, creatureOptions) {
  const selected = normalizeProsthesisLimbKeys(item.system?.functions?.prosthesis?.limbKeys);
  return buildProsthesisLimbChoiceEntries(creatureOptions, selected).some(choice => !selected.includes(choice.key));
}

function buildProsthesisLimbChoiceEntries(creatureOptions, extraKeys = []) {
  const limbs = new Map();
  for (const race of creatureOptions?.races ?? []) {
    for (const limb of race.limbs ?? []) {
      const key = String(limb?.key ?? "").trim();
      if (!key || limbs.has(key)) continue;
      limbs.set(key, String(limb?.label ?? key));
    }
  }
  for (const key of normalizeProsthesisLimbKeys(extraKeys)) {
    if (!limbs.has(key)) limbs.set(key, key);
  }
  return Array.from(limbs, ([key, label]) => ({ key, label }));
}

function normalizeProsthesisLimbKeys(value) {
  const source = Array.isArray(value)
    ? value
    : value && typeof value === "object" ? Object.values(value) : [];
  return Array.from(new Set(source
    .map(key => String(key ?? "").trim())
    .filter(Boolean)));
}

function createToolFunctionSelectionUpdate(item, toolKey = "", { enabled = true, sourceToolKey = "" } = {}) {
  const key = String(toolKey ?? "").trim();
  if (!key) return {};

  const sourceKey = String(sourceToolKey || getSelectedToolFunctionKey(item) || key).trim();
  const sourceData = foundry.utils.deepClone(item.system?.functions?.tools?.[sourceKey] ?? item.system?.functions?.tools?.[key] ?? {});
  const update = {
    [`system.functions.tools.${key}.enabled`]: Boolean(enabled),
    [`system.functions.tools.${key}.useAsItem`]: Boolean(item.system?.functions?.tools?.[key]?.useAsItem),
    [`system.functions.tools.${key}.toolClass`]: String(sourceData.toolClass ?? "D") || "D",
    [`system.functions.tools.${key}.supply.value`]: Math.max(0, toInteger(sourceData.supply?.value)),
    [`system.functions.tools.${key}.supply.max`]: Math.max(0, toInteger(sourceData.supply?.max)),
    [`system.functions.tools.${key}.skillValue`]: Math.max(0, toInteger(sourceData.skillValue)),
    [`system.functions.tools.${key}.skillKey`]: String(sourceData.skillKey ?? "")
  };

  for (const existingKey of Object.keys(item.system?.functions?.tools ?? {})) {
    if (existingKey !== key) update[`system.functions.tools.${existingKey}`] = globalThis._del;
  }

  return update;
}

function buildItemCategoryChoices(selectedCategory = "") {
  const selected = String(selectedCategory ?? "").trim();
  const categories = getItemCategorySettings()
    .map(category => String(category?.label ?? category ?? "").trim())
    .filter(Boolean);
  if (selected && !categories.includes(selected)) categories.push(selected);

  return [
    { value: "", label: "", selected: !selected },
    ...categories.map(label => ({
      value: label,
      label,
      selected: label === selected
    }))
  ];
}

function buildConditionRecoveryMethodRows(item, toolSettings = []) {
  const classChoices = ["D", "C", "B", "A", "S"];
  return (item.system?.functions?.condition?.recoveryMethods ?? []).map((method, index) => {
    const type = String(method?.type ?? "tools") === "tools" ? "tools" : "tools";
    const toolKey = String(method?.toolKey ?? "");
    const toolChoices = toolSettings.map(tool => ({
      value: tool.key,
      label: tool.label,
      selected: tool.key === toolKey
    }));
    if (!toolChoices.some(choice => choice.selected) && toolChoices[0]) toolChoices[0].selected = true;
    return {
      index,
      type,
      toolKey,
      toolClass: String(method?.toolClass ?? "D"),
      difficulty: Math.max(0, toInteger(method?.difficulty)),
      typeChoices: [{
        value: "tools",
        label: game.i18n.localize("FALLOUTMAW.Item.ConditionRecoveryMethodTools"),
        selected: true
      }],
      toolChoices,
      classChoices: classChoices.map(value => ({
        value,
        label: value,
        selected: value === String(method?.toolClass ?? "D")
      }))
    };
  });
}

function buildFirstAidEffectRows(item) {
  return buildFirstAidEffectRowsFromChanges(item.system?.functions?.firstAid?.changes);
}

function buildOneTimeUseRecipeItemRows(values = []) {
  const rows = (values ?? []).map((value, index) => {
    const item = resolveCraftKnowledgeItem(value);
    const variants = item ? getCraftKnowledgeVariants(item) : [];
    return {
      index,
      uuid: String(value ?? ""),
      name: item?.name ?? game.i18n.localize("FALLOUTMAW.Common.MissingItem"),
      img: normalizeImagePath(item?.img, FALLBACK_ICON),
      variantCount: variants.length,
      hasCraft: variants.some(variant => (variant.nodes?.length || variant.links?.length)),
      hasDisassembly: variants.some(variant => (variant.disassembly?.nodes?.length || variant.disassembly?.links?.length)),
      missing: !item,
      empty: false
    };
  });
  rows.push({
    index: rows.length,
    uuid: "",
    name: "",
    img: FALLBACK_ICON,
    variantCount: 0,
    hasCraft: false,
    hasDisassembly: false,
    missing: false,
    empty: true
  });
  return rows;
}

function buildFirstAidEffectRowsFromChanges(changes = []) {
  return (changes ?? []).map((change, index) => ({
    index,
    key: String(change?.key ?? ""),
    type: String(change?.type ?? "add"),
    value: String(change?.value ?? "0"),
    priority: change?.priority ?? "",
    typeChoices: buildFirstAidEffectTypeChoices(change?.type)
  }));
}

function buildFirstAidWithdrawalEffectRows(item) {
  return (item.system?.functions?.firstAid?.withdrawal ?? []).map((change, index) => ({
    index,
    key: String(change?.key ?? ""),
    type: String(change?.type ?? "add"),
    value: String(change?.value ?? "0"),
    priority: change?.priority ?? "",
    typeChoices: buildFirstAidEffectTypeChoices(change?.type)
  }));
}

function buildFirstAidNeedRows(item) {
  const choiceGroups = buildNeedChangeChoiceGroups(item);
  const source = Array.isArray(item.system?.functions?.firstAid?.needs)
    ? item.system.functions.firstAid.needs
    : Object.entries(item.system?.functions?.firstAid?.needs ?? {}).map(([needKey, value]) => ({ needKey, value }));
  return source.map((entry, index) => ({
    index,
    needKey: String(entry?.needKey ?? ""),
    value: toInteger(entry?.value),
    choiceGroups: selectNeedChoiceGroups(choiceGroups, String(source[index]?.needKey ?? ""))
  }));
}

function buildNeedChangeNeedRows(item) {
  const choiceGroups = buildNeedChangeChoiceGroups(item);
  const source = getNeedChangeNeeds(item);
  return source.map((entry, index) => ({
    index,
    needKey: String(entry?.needKey ?? ""),
    value: toInteger(entry?.value),
    choiceGroups: selectNeedChoiceGroups(choiceGroups, String(entry?.needKey ?? ""))
  }));
}

function buildNeedChangeOrganismDevelopmentRows(item, characteristicSettings = getCharacteristicSettings()) {
  const settings = Array.isArray(characteristicSettings) ? characteristicSettings : getCharacteristicSettings();
  const source = getNeedChangeOrganismDevelopment(item);
  return source.map((entry, index) => ({
    index,
    characteristicKey: String(entry?.characteristicKey ?? ""),
    value: Number(entry?.value) || 0,
    choices: settings.map(characteristic => ({
      value: characteristic.key,
      label: characteristic.label || characteristic.key,
      selected: characteristic.key === entry.characteristicKey
    }))
  }));
}

function getNeedChangeOrganismDevelopment(item) {
  const source = item.system?.functions?.needChange?.organismDevelopment ?? [];
  return (Array.isArray(source) ? source : [])
    .map(entry => ({
      characteristicKey: String(entry?.characteristicKey ?? "").trim(),
      value: Number(entry?.value)
    }))
    .filter(entry => entry.characteristicKey);
}

function buildNeedChangeDamageRows(item, damageTypeSettings = getDamageTypeSettings()) {
  const settings = Array.isArray(damageTypeSettings) ? damageTypeSettings : getDamageTypeSettings();
  const source = getNeedChangeDamages(item);
  return source.map((entry, index) => ({
    index,
    damageTypeKey: String(entry?.damageTypeKey ?? ""),
    value: Math.max(0, toInteger(entry?.value)),
    choices: settings.map(damageType => ({
      value: damageType.key,
      label: damageType.label || damageType.key,
      selected: damageType.key === entry.damageTypeKey
    }))
  }));
}

function getNeedChangeDamages(item) {
  const source = item.system?.functions?.needChange?.damages ?? [];
  return (Array.isArray(source) ? source : [])
    .map(entry => ({
      damageTypeKey: String(entry?.damageTypeKey ?? "").trim(),
      value: Math.max(0, toInteger(entry?.value))
    }))
    .filter(entry => entry.damageTypeKey);
}

function getNeedChangeNeeds(item) {
  const source = item.system?.functions?.needChange?.needs ?? [];
  return (Array.isArray(source)
    ? source
    : Object.entries(source).map(([needKey, value]) => ({ needKey, value })))
    .map(entry => ({
      needKey: String(entry?.needKey ?? ""),
      value: toInteger(entry?.value)
    }));
}

function buildNeedChangeChoiceGroups(item = null) {
  const primaryChoices = getNeedSettings().map(need => ({
    value: need.key,
    label: need.label || need.key
  }));
  const primaryKeys = new Set(primaryChoices.map(choice => choice.value));
  const additionalChoices = collectConstructPartNeedSettings(item)
    .filter(need => !primaryKeys.has(need.key))
    .map(need => ({
      value: need.key,
      label: need.label || need.key
    }));

  return [
    { label: "Основные", choices: primaryChoices },
    { label: "Дополнительные", choices: additionalChoices }
  ].filter(group => group.choices.length);
}

function selectNeedChoiceGroups(groups = [], selectedKey = "") {
  const selected = String(selectedKey ?? "");
  const result = groups.map(group => ({
    ...group,
    choices: group.choices.map(choice => ({
      ...choice,
      selected: choice.value === selected
    }))
  }));
  if (selected && !result.some(group => group.choices.some(choice => choice.value === selected))) {
    const additional = result.find(group => group.label === "Дополнительные");
    const choice = { value: selected, label: selected, selected: true };
    if (additional) additional.choices.push(choice);
    else result.push({ label: "Дополнительные", choices: [choice] });
  }
  return result;
}

function collectConstructPartNeedSettings(item = null) {
  const byKey = new Map();
  const addNeeds = needs => {
    for (const need of normalizeConstructPartNeeds(needs)) {
      if (!need.key || byKey.has(need.key)) continue;
      byKey.set(need.key, need);
    }
  };

  addNeeds(item?.system?.functions?.constructPart?.needs);
  for (const worldItem of game.items ?? []) {
    if (worldItem?.type === "gear" && hasItemFunction(worldItem, ITEM_FUNCTIONS.constructPart, { ignoreBroken: true })) {
      addNeeds(worldItem.system?.functions?.constructPart?.needs);
    }
  }
  for (const actor of game.actors ?? []) {
    for (const actorItem of actor.items ?? []) {
      if (actorItem?.type === "gear" && hasItemFunction(actorItem, ITEM_FUNCTIONS.constructPart, { ignoreBroken: true })) {
        addNeeds(actorItem.system?.functions?.constructPart?.needs);
      }
    }
  }
  return Array.from(byKey.values());
}

function buildFirstAidRemoveEffectRows(item, damageTypeSettings = getDamageTypeSettings()) {
  const settings = getFirstAidRemovablePeriodicDamageTypes(damageTypeSettings);
  const source = normalizeFirstAidRemoveEffects(item.system?.functions?.firstAid?.removeEffects);
  return source.map((entry, index) => ({
    index,
    damageTypeKey: entry.damageTypeKey,
    choices: settings.map(damageType => ({
      value: damageType.key,
      label: damageType.label || damageType.key,
      selected: damageType.key === entry.damageTypeKey
    }))
  }));
}

function normalizeFirstAidRemoveEffects(removeEffects = []) {
  const source = Array.isArray(removeEffects)
    ? removeEffects
    : Object.entries(removeEffects ?? {}).map(([damageTypeKey, enabled]) => ({ damageTypeKey, enabled }));
  return source
    .map(entry => ({
      damageTypeKey: String(entry?.damageTypeKey ?? entry?.key ?? "").trim()
    }))
    .filter(entry => entry.damageTypeKey);
}

function getFirstAidRemovablePeriodicDamageTypes(damageTypeSettings = []) {
  return (Array.isArray(damageTypeSettings) ? damageTypeSettings : [])
    .filter(damageType => {
      const key = String(damageType?.key ?? "").trim();
      return key === BLEEDING_DAMAGE_TYPE_KEY || Boolean(damageType?.settings?.periodic?.enabled);
    })
    .map(damageType => ({
      key: String(damageType.key ?? "").trim(),
      label: String(damageType.label ?? damageType.key ?? "").trim(),
      periodicLabel: String(damageType?.settings?.periodic?.effectName ?? "").trim()
    }))
    .filter(damageType => damageType.key);
}

function buildFirstAidEffectTypeChoices(selected = "add") {
  const value = String(selected ?? "add");
  return [
    { value: "add", label: game.i18n.localize("FALLOUTMAW.Effects.ChangeAdd") },
    { value: "multiply", label: game.i18n.localize("FALLOUTMAW.Effects.ChangeMultiply") },
    { value: "override", label: game.i18n.localize("FALLOUTMAW.Effects.ChangeOverride") }
  ].map(choice => ({
    ...choice,
    selected: choice.value === value
  }));
}

function normalizePercentInput(value) {
  return Math.max(0, Math.min(100, Math.trunc(Number(value) || 0)));
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Math.trunc(Number(value) || 0)));
}

function normalizeWeaponDamageTypeRows(weaponData = {}, damageTypeSettings = [], sourceWeaponData = null) {
  const validKeys = new Set(getConfigurableDamageTypes(damageTypeSettings).map(type => type.key));
  const configuredFallback = String(weaponData?.damageTypeKey ?? "").trim();
  const fallbackKey = validKeys.has(configuredFallback)
    ? configuredFallback
    : damageTypeSettings.at(0)?.key ?? "firearm";
  const hasConfiguredDamageTypes = sourceWeaponData ? Object.hasOwn(sourceWeaponData, "damageTypes") : Array.isArray(weaponData?.damageTypes);
  const rows = hasConfiguredDamageTypes && Array.isArray(weaponData?.damageTypes)
    ? weaponData.damageTypes
      .map(entry => ({
        key: String(entry?.key ?? "").trim(),
        percent: clampPercent(entry?.percent)
      }))
      .filter(entry => entry.key && (!validKeys.size || validKeys.has(entry.key)))
    : [];
  if (!rows.length) return [{ key: fallbackKey, percent: 100 }];
  if (!rows.some(entry => entry.percent > 0)) rows[0].percent = 100;
  return rows;
}

function readWeaponDamageTypeRows(root) {
  const rows = Array.from(root?.querySelectorAll("[data-weapon-damage-type-row]") ?? []);
  return rows.map(row => ({
    key: String(row.querySelector("[data-weapon-damage-type-key]")?.value ?? "").trim(),
    percent: clampPercent(row.querySelector("[data-weapon-damage-percent]")?.value)
  })).filter(entry => entry.key);
}

function readVolleyRegionDamageRows(root) {
  const rows = Array.from(root?.querySelectorAll("[data-volley-region-damage-row]") ?? []);
  return normalizeVolleyRegionDamageEntries(rows.map(row => ({
    damageTypeKey: String(row.querySelector("[data-volley-region-damage-type]")?.value ?? "").trim(),
    amount: normalizeDamageFormula(row.querySelector("[data-volley-region-damage-amount]")?.value)
  })));
}

function getConfigurableDamageTypes(damageTypeSettings = []) {
  return damageTypeSettings.filter(damageType => !damageType?.locked && !damageType?.system);
}

function readDamageSourceVolleyRegionDamageRows(root) {
  const rows = Array.from(root?.querySelectorAll("[data-damage-source-volley-region-damage-row]") ?? []);
  return normalizeVolleyRegionDamageEntries(rows.map(row => ({
    damageTypeKey: String(row.querySelector("[data-damage-source-volley-region-damage-type]")?.value ?? "").trim(),
    amount: normalizeDamageFormula(row.querySelector("[data-damage-source-volley-region-damage-amount]")?.value)
  })));
}

function normalizeVolleyRegionDamageEntries(entries = []) {
  const values = Array.isArray(entries) ? entries : Object.values(entries ?? {});
  return values
    .map(entry => ({
      damageTypeKey: String(entry?.damageTypeKey ?? "").trim(),
      amount: normalizeDamageFormula(entry?.amount)
    }))
    .filter(entry => entry.damageTypeKey || isFormulaTextConfigured(entry.amount));
}

function normalizeDamageFormula(value) {
  return String(value ?? "0").trim() || "0";
}

function normalizeWeaponDamageTypeOverflow(entries = [], changedIndex = -1) {
  const normalized = entries.map(entry => ({
    key: String(entry?.key ?? "").trim(),
    percent: clampPercent(entry?.percent)
  })).filter(entry => entry.key);
  const total = normalized.reduce((sum, entry) => sum + entry.percent, 0);
  if (total <= 100) return normalized;

  let excess = total - 100;
  let candidates = normalized
    .map((entry, index) => ({ entry, index }))
    .filter(candidate => candidate.index !== changedIndex && candidate.entry.percent > 0);

  while (excess > 0 && candidates.length) {
    const share = Math.max(1, Math.ceil(excess / candidates.length));
    for (const candidate of candidates) {
      if (excess <= 0) break;
      const reduction = Math.min(candidate.entry.percent, share, excess);
      candidate.entry.percent -= reduction;
      excess -= reduction;
    }
    candidates = candidates.filter(candidate => candidate.entry.percent > 0);
  }

  if (excess > 0 && normalized[changedIndex]) normalized[changedIndex].percent = Math.max(0, normalized[changedIndex].percent - excess);
  return normalized;
}

function writeWeaponDamageTypePercents(root, entries = []) {
  const rows = Array.from(root?.querySelectorAll("[data-weapon-damage-type-row]") ?? []);
  rows.forEach((row, index) => {
    const value = String(clampPercent(entries[index]?.percent));
    row.querySelectorAll("[data-weapon-damage-percent]").forEach(input => {
      input.value = value;
    });
  });
}

function readDamageSourceDamageTypeRows(root) {
  const rows = Array.from(root?.querySelectorAll("[data-damage-source-type-row]") ?? []);
  return rows.map(row => ({
    key: String(row.querySelector("[data-damage-source-type-key]")?.value ?? "").trim(),
    percent: clampPercent(row.querySelector("[data-damage-source-percent]")?.value)
  })).filter(entry => entry.key);
}

function readTrapDamageTypeRows(root) {
  const rows = Array.from(root?.querySelectorAll("[data-trap-damage-type-row]") ?? []);
  return rows.map(row => ({
    key: String(row.querySelector("[data-trap-damage-type-key]")?.value ?? "").trim(),
    percent: clampPercent(row.querySelector("[data-trap-damage-percent]")?.value)
  })).filter(entry => entry.key);
}

function readTrapRegionDamageRows(root) {
  const rows = Array.from(root?.querySelectorAll("[data-trap-region-damage-row]") ?? []);
  return normalizeVolleyRegionDamageEntries(rows.map(row => ({
    damageTypeKey: String(row.querySelector("[data-trap-region-damage-type]")?.value ?? "").trim(),
    amount: normalizeDamageFormula(row.querySelector("[data-trap-region-damage-amount]")?.value)
  })));
}

function writeDamageSourceTypePercents(root, entries = []) {
  const rows = Array.from(root?.querySelectorAll("[data-damage-source-type-row]") ?? []);
  rows.forEach((row, index) => {
    const value = String(clampPercent(entries[index]?.percent));
    row.querySelectorAll("[data-damage-source-percent]").forEach(input => {
      input.value = value;
    });
  });
}

function writeTrapDamageTypePercents(root, entries = []) {
  const rows = Array.from(root?.querySelectorAll("[data-trap-damage-type-row]") ?? []);
  rows.forEach((row, index) => {
    const value = String(clampPercent(entries[index]?.percent));
    row.querySelectorAll("[data-trap-damage-percent]").forEach(input => {
      input.value = value;
    });
  });
}

function buildWeaponMagazineSourceModeUpdates(path, weaponData = {}) {
  const updateData = {
    [`${path}.availableActions.reload`]: true
  };
  if (!weaponData?.magazine) {
    updateData[`${path}.magazine.value`] = 0;
    updateData[`${path}.magazine.max`] = 0;
    updateData[`${path}.magazine.sourceItemUuid`] = "";
    updateData[`${path}.magazine.sourceItemUuids`] = [];
  }
  return updateData;
}

async function getDroppedItem(event) {
  const transfer = event?.dataTransfer;
  if (!transfer) return null;
  let data = null;
  try {
    data = JSON.parse(transfer.getData("text/plain") || "{}");
  } catch (_error) {
    data = null;
  }
  if (!data || data.type !== "Item") return null;
  return resolveWorldItemSync(data.uuid);
}

function isWorldDamageSourceItem(item) {
  return Boolean(item && !item.actor && hasItemFunction(item, ITEM_FUNCTIONS.damageSource));
}

function isWorldEnergySourceItem(item) {
  return Boolean(item && !item.actor && hasItemFunction(item, ITEM_FUNCTIONS.energySource));
}

function buildDamageMitigationModeChoices(item) {
  const mode = String(item.system?.functions?.damageMitigation?.mode || DAMAGE_MITIGATION_MODES.defense);
  return [
    {
      value: DAMAGE_MITIGATION_MODES.defense,
      label: game.i18n.localize("FALLOUTMAW.Item.MitigationModeDefense"),
      selected: mode === DAMAGE_MITIGATION_MODES.defense
    },
    {
      value: DAMAGE_MITIGATION_MODES.resistance,
      label: game.i18n.localize("FALLOUTMAW.Item.MitigationModeResistance"),
      selected: mode === DAMAGE_MITIGATION_MODES.resistance
    }
  ];
}
