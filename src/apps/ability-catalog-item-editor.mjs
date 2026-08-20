import { TEMPLATES } from "../constants.mjs";
import { getCharacteristicSettings, getCoverSettings, getCreatureOptions, getDamageTypeSettings, getItemCategorySettings, getProficiencySettings, getResourceSettings, getSkillSettings } from "../settings/accessors.mjs";
import { getActiveRulesProfile } from "../settings/rules-profiles.mjs";
import { getFactionNamesWithDefault, getFactionSettings } from "../settings/factions.mjs";
import { STEALTH_LIGHT_LEVELS } from "../stealth/settings.mjs";
import {
  REGION_SPECIAL_PROPERTY_PENDING,
  REGION_SPECIAL_PROPERTY_SMOKE,
  createDefaultRegionSpecialPropertyData,
  normalizeRegionSpecialProperties
} from "../utils/region-special-properties.mjs";
import {
  ABILITY_ACQUISITION_ABILITY_MODES,
  ABILITY_ACQUISITION_CONDITION_TYPES,
  ABILITY_CATALOG_DRAG_TYPE,
  ABILITY_ACTION_EVENT_CONTROLS,
  ABILITY_ACTION_EXECUTOR_MODES,
  ABILITY_ACTION_ROUTE_BUDGET_MODES,
  ABILITY_ACTION_ROUTE_EVALUATION_MODES,
  ABILITY_ACTION_POINT_PAYERS,
  ABILITY_ACTION_POINT_COST_MODES,
  ABILITY_ACTION_TARGET_MODES,
  ABILITY_ACTION_TYPES,
  ABILITY_ATTACK_ACTION_ALL,
  ABILITY_ATTACKING_WEAPON_ACTION_KEYS,
  ABILITY_MOVEMENT_ROUTE_EXECUTION_MODES,
  ABILITY_ACTIVE_APPLICATION_COST_PAYERS,
  ABILITY_ACTIVE_APPLICATION_TARGET_MODES,
  ABILITY_ACTIVE_APPLICATION_SELECTION_MODES,
  ABILITY_AURA_MODES,
  ABILITY_AURA_TARGET_GROUPS,
  ABILITY_ATTACK_DISTANCE_MODES,
  ABILITY_ATTACK_DISTANCE_SIDES,
  ABILITY_CHANGE_VALUE_SOURCES,
  ABILITY_CHANGE_TYPES,
  ABILITY_CONDITION_TYPES,
  ABILITY_CONSTRUCT_TYPES,
  ABILITY_DAMAGE_AMOUNT_MODES,
  ABILITY_DAMAGE_LIMB_MODES,
  ABILITY_EQUIPMENT_OPERATORS,
  ABILITY_EVENT_TRACKING_TARGETS,
  ABILITY_EVENT_SUBJECTS,
  ABILITY_EVENT_REACTION_MODES,
  ABILITY_EVENT_EFFECT_TARGETS,
  ABILITY_FIXED_FUNCTION_KEYS,
  ABILITY_FUNCTION_TYPES,
  ABILITY_HEALTH_LIMB_ALL,
  ABILITY_HEALTH_TARGETS,
  ABILITY_POSTURE_ACTIONS,
  ABILITY_POSTURE_SUBJECTS,
  ABILITY_TRIAL_BRANCH_FLOWS,
  ABILITY_TRIAL_LINK_KINDS,
  ABILITY_TRIAL_LINK_MODES,
  ABILITY_TRIAL_LINK_RECIPIENTS,
  ABILITY_TRIAL_RESULT_KEYS,
  ABILITY_TRIAL_SELECTION_MODES,
  ABILITY_TRIAL_SUBJECTS,
  LOCKED_FEATURES_CATEGORY_ID,
  createAbilityAcquisitionCondition,
  createAbilityAction,
  createAbilityChange,
  createAbilityCondition,
  createAbilityConstruct,
  createAbilityConstructResource,
  createAbilityFunction,
  createAbilityTrialBranch,
  createAbilityTrialEntry,
  createAbilityTrialLink,
  getAbilityFunctionEffectDurationSeconds,
  normalizeAbilityEntry,
  normalizeAbilityConstructs,
  normalizeCommandBasicsSettings,
  normalizeCounterAttackSettings,
  normalizeOversightSettings,
  normalizeWatchOutSettings,
  normalizeCounterSniperSettings,
  normalizeCurseAndBlessingSettings,
  normalizeAllOrNothingSettings,
  normalizeAimingSettings,
  normalizeAtRandomSettings,
  normalizeDefensiveTacticsSettings,
  normalizeActiveApplicationSettings,
  normalizeAnatomyStudySettings,
  normalizeEmergencyOperationsSettings,
  normalizeExperimentalSurgerySettings,
  normalizeInconspicuousSettings,
  normalizeShadowSettings,
  normalizeSandmanSettings,
  normalizeNightmareSettings,
  normalizeSpecialMixSettings,
  normalizeActiveApplicationCost,
  normalizeAttackActionSettings,
  preserveMissingActiveApplicationTargetSettings,
  normalizeEventReactionSettings,
  normalizeEventReactionMode,
  normalizeFourLeafCloverSettings,
  normalizeLastChanceSettings,
  normalizeLethalAttackSettings,
  normalizeKeepAwaySettings,
  normalizeLookSettings,
  normalizeLungeSettings,
  normalizeLuckyCoinSettings,
  normalizeRageSettings,
  normalizeRicochetSettings,
  normalizeReaperSettings,
  normalizeToTheEndSettings,
  normalizeVersatileDevelopmentSettings,
  normalizeVirtuosoSettings,
  normalizeDeusExMachinaSettings,
  normalizeDisarmSettings,
  normalizeDoubleAttackSettings,
  normalizeFullControlSettings,
  normalizeFullForceSettings,
  normalizeHeightenedConcentrationSettings,
  normalizeKnockOffBalanceSettings,
  normalizeTwoHandsSettings,
  normalizeWhirlwindSettings,
  normalizeWhereAreYouGoingSettings,
  normalizeEventReactionProgressRequired,
  normalizeAbilityFunctions,
  getAbilitySourceId
} from "../settings/abilities.mjs";
import {
  WEAPON_SPECIAL_PROPERTIES,
  createDefaultWeaponSpecialPropertyData,
  getWeaponSpecialPropertyType,
  normalizeWeaponAdditionalProficiencyKeys,
  normalizeWeaponAttackPowerData,
  normalizeWeaponCriticalDamageData
} from "../utils/item-functions.mjs";
import { reconcileWeaponResourceCostReferences } from "../combat/weapon-resource-cost-references.mjs";
import {
  EVENT_REACTION_EXPECTED_RESULT_KEYS,
  EVENT_REACTION_SKILL_FILTER_ALL,
  buildEventReactionPathLevels,
  getEventReactionDepthProfile,
  isEventReactionFilterType,
  normalizeEventReactionExpectedResultKeys,
  normalizeEventReactionSkillKeys,
  resolveEventKeyForPathPrefix
} from "../events/event-reaction-schema.mjs";
import {
  buildEventReactionDepthFilterGroups,
  buildHiddenEventReactionDepthFilterRows,
  getEventReactionDepthFilterValues,
  getFirstUnusedEventReactionDepthFilterValue,
  setEventReactionDepthFilterValues
} from "../events/event-reaction-depth-ui.mjs";
import {
  getEventReactionProgressLabel,
  isEventReactionProgressTracked
} from "../events/event-reaction-progress.mjs";
import { REACTION_POINTS_RESOURCE_KEY } from "../events/reaction-costs.mjs";
import {
  SYSTEM_EVENT_PHASES,
  SYSTEM_EVENT_ROLES,
  getSelectableSystemEvents,
  getSystemEventDescriptor
} from "../events/catalog.mjs";
import {
  createFixedAbilityFunction,
  getFixedAbilityFunctionChoices,
  getFixedAbilityFunctionLabel
} from "../abilities/fixed-functions.mjs";
import { buildEffectKeyTokens } from "../utils/effect-key-tokens.mjs";
import { buildAbilityAcquisitionChangeKeyTokens } from "../utils/ability-acquisition-change-keys.mjs";
import { getEquipmentSlotSelectionKey } from "../utils/equipment-slots.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { getActorFormulaAutocompleteEntries } from "../utils/actor-formulas.mjs";
import { hasAdvancementPureValueFunctionChanges } from "../advancement/pure-value-keys.mjs";
import { activateEffectKeyAutocomplete } from "./effect-key-autocomplete.mjs";
import { activateDescriptionFormulaAutocomplete } from "./description-formula-autocomplete.mjs";
import { activateFormulaAutocomplete } from "./formula-autocomplete.mjs";
import { activateAdvancementPureValuesControls } from "./advancement-pure-values-control.mjs";
import { FalloutMaWFormApplicationV2 } from "./base-form-application-v2.mjs";
import { pickCatalogAbilities, resolveCatalogAbilityEntries } from "./ability-catalog-picker.mjs";
import {
  prepareAbilityAccumulationForDisplay,
  prepareAbilityAccumulatorExchangeForDisplay
} from "./ability-accumulation-ui.mjs";
import { findCatalogAbility } from "../abilities/purchase.mjs";
import { createAttackActionTrial } from "../abilities/attack-action-settings.mjs";

const TextEditor = foundry.applications.ux.TextEditor.implementation;
const ATTACK_HIT_OUTCOME_KEYS = Object.freeze([
  "criticalFailure",
  "failure",
  "success",
  "criticalSuccess"
]);

export class AbilityCatalogItemEditor extends FalloutMaWFormApplicationV2 {
  #activeTab = "details";
  #functionPickerActive = false;
  #fixedFunctionPickerActive = false;
  #closeSavePromise = null;

  constructor(catalogApp, categoryId, abilityId, options = {}) {
    super(options);
    this.catalogApp = catalogApp;
    this.categoryId = categoryId;
    this.abilityId = abilityId;
    this.ability = normalizeAbilityEntry(catalogApp.getAbility(categoryId, abilityId));
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-ability-catalog-item-editor",
    classes: ["fallout-maw", "fallout-maw-sheet", "fallout-maw-item-sheet", "sheet", "item", "ability-catalog-item-editor"],
    position: {
      width: 930,
      height: "auto"
    },
    window: {
      resizable: true
    },
    form: {
      submitOnChange: false,
      closeOnSubmit: false
    },
    actions: {
      editAbilityImage: this.#onEditAbilityImage,
      selectTab: this.#onSelectTab,
      addFunction: this.#onAddFunction,
      deleteFunction: this.#onDeleteFunction,
      addFunctionChange: this.#onAddFunctionChange,
      deleteFunctionChange: this.#onDeleteFunctionChange,
      enableFunctionChangeAccumulator: this.#onEnableFunctionChangeAccumulator,
      disableFunctionChangeAccumulator: this.#onDisableFunctionChangeAccumulator,
      addFunctionAction: this.#onAddFunctionAction,
      deleteFunctionAction: this.#onDeleteFunctionAction,
      addFunctionAttackChoice: this.#onAddFunctionAttackChoice,
      deleteFunctionAttackChoice: this.#onDeleteFunctionAttackChoice,
      addFunctionCondition: this.#onAddFunctionCondition,
      addFunctionConditionAlternative: this.#onAddFunctionConditionAlternative,
      deleteFunctionCondition: this.#onDeleteFunctionCondition,
      addConditionTrialEntry: this.#onAddConditionTrialEntry,
      deleteConditionTrialEntry: this.#onDeleteConditionTrialEntry,
      addConditionTrialBranch: this.#onAddConditionTrialBranch,
      deleteConditionTrialBranch: this.#onDeleteConditionTrialBranch,
      addConditionTrialLink: this.#onAddConditionTrialLink,
      deleteConditionTrialLink: this.#onDeleteConditionTrialLink,
      addAbilityConstruct: this.#onAddAbilityConstruct,
      deleteAbilityConstruct: this.#onDeleteAbilityConstruct,
      addAbilityConstructChange: this.#onAddAbilityConstructChange,
      deleteAbilityConstructChange: this.#onDeleteAbilityConstructChange,
      addAbilityConstructResource: this.#onAddAbilityConstructResource,
      deleteAbilityConstructResource: this.#onDeleteAbilityConstructResource,
      addActiveApplicationCost: this.#onAddActiveApplicationCost,
      deleteActiveApplicationCost: this.#onDeleteActiveApplicationCost,
      addAttackDamageType: this.#onAddAttackDamageType,
      deleteAttackDamageType: this.#onDeleteAttackDamageType,
      addAttackResourceCost: this.#onAddAttackResourceCost,
      deleteAttackResourceCost: this.#onDeleteAttackResourceCost,
      addAttackRegionDamage: this.#onAddAttackRegionDamage,
      deleteAttackRegionDamage: this.#onDeleteAttackRegionDamage,
      addAttackRegionSpecialProperty: this.#onAddAttackRegionSpecialProperty,
      deleteAttackRegionSpecialProperty: this.#onDeleteAttackRegionSpecialProperty,
      addAttackSpecialProperty: this.#onAddAttackSpecialProperty,
      deleteAttackSpecialProperty: this.#onDeleteAttackSpecialProperty,
      addAttackAdditionalProficiency: this.#onAddAttackAdditionalProficiency,
      deleteAttackAdditionalProficiency: this.#onDeleteAttackAdditionalProficiency,
      addAttackRequirement: this.#onAddAttackRequirement,
      deleteAttackRequirement: this.#onDeleteAttackRequirement,
      addAttackCriticalFailure: this.#onAddAttackCriticalFailure,
      deleteAttackCriticalFailure: this.#onDeleteAttackCriticalFailure,
      addAttackHitTrial: this.#onAddAttackHitTrial,
      deleteAttackHitTrial: this.#onDeleteAttackHitTrial,
      moveAttackHitTrialUp: this.#onMoveAttackHitTrialUp,
      moveAttackHitTrialDown: this.#onMoveAttackHitTrialDown,
      addAttackHitTrialEntry: this.#onAddAttackHitTrialEntry,
      deleteAttackHitTrialEntry: this.#onDeleteAttackHitTrialEntry,
      addAttackHitOutcomeLink: this.#onAddAttackHitOutcomeLink,
      deleteAttackHitOutcomeLink: this.#onDeleteAttackHitOutcomeLink,
      browseAttackSound: this.#onBrowseAttackSound,
      browseAttackExplosionSound: this.#onBrowseAttackExplosionSound,
      addConditionTriggerCost: this.#onAddConditionTriggerCost,
      deleteConditionTriggerCost: this.#onDeleteConditionTriggerCost,
      addConditionTrackingTarget: this.#onAddConditionTrackingTarget,
      deleteConditionTrackingTarget: this.#onDeleteConditionTrackingTarget,
      addConditionEventSkill: this.#onAddConditionEventSkill,
      deleteConditionEventSkill: this.#onDeleteConditionEventSkill,
      addConditionEventExpectedResult: this.#onAddConditionEventExpectedResult,
      deleteConditionEventExpectedResult: this.#onDeleteConditionEventExpectedResult,
      addConditionEventDepthFilter: this.#onAddConditionEventDepthFilter,
      deleteConditionEventDepthFilter: this.#onDeleteConditionEventDepthFilter,
      addConditionItemCategory: this.#onAddConditionItemCategory,
      deleteConditionItemCategory: this.#onDeleteConditionItemCategory,
      addConditionTargetFaction: this.#onAddConditionTargetFaction,
      deleteConditionTargetFaction: this.#onDeleteConditionTargetFaction,
      addConditionPosture: this.#onAddConditionPosture,
      deleteConditionPosture: this.#onDeleteConditionPosture,
      addConditionCover: this.#onAddConditionCover,
      deleteConditionCover: this.#onDeleteConditionCover,
      addConditionRegionDamageType: this.#onAddConditionRegionDamageType,
      deleteConditionRegionDamageType: this.#onDeleteConditionRegionDamageType,
      addConditionRegionSpecialProperty: this.#onAddConditionRegionSpecialProperty,
      deleteConditionRegionSpecialProperty: this.#onDeleteConditionRegionSpecialProperty,
      addConditionWeaponAction: this.#onAddConditionWeaponAction,
      deleteConditionWeaponAction: this.#onDeleteConditionWeaponAction,
      addConditionWeaponSkill: this.#onAddConditionWeaponSkill,
      deleteConditionWeaponSkill: this.#onDeleteConditionWeaponSkill,
      addConditionWeaponProficiency: this.#onAddConditionWeaponProficiency,
      deleteConditionWeaponProficiency: this.#onDeleteConditionWeaponProficiency,
      addConditionAuraTargetGroup: this.#onAddConditionAuraTargetGroup,
      deleteConditionAuraTargetGroup: this.#onDeleteConditionAuraTargetGroup,
      addFunctionPenalty: this.#onAddFunctionPenalty,
      deleteFunctionPenalty: this.#onDeleteFunctionPenalty,
      addToTheEndAdvantageSkill: this.#onAddToTheEndAdvantageSkill,
      deleteToTheEndAdvantageSkill: this.#onDeleteToTheEndAdvantageSkill,
      addAcquisitionRequirement: this.#onAddAcquisitionRequirement,
      deleteAcquisitionRequirement: this.#onDeleteAcquisitionRequirement,
      openAcquisitionAbilityPicker: this.#onOpenAcquisitionAbilityPicker,
      removeAcquisitionRequirementAbility: this.#onRemoveAcquisitionRequirementAbility
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.settings.abilityEditor
    }
  };

  get title() {
    return `${this.#isFeature ? "Особенность" : "Способность"}: ${this.ability.name}`;
  }

  get #isFeature() {
    return this.categoryId === LOCKED_FEATURES_CATEGORY_ID;
  }

  async _prepareContext(options) {
    const isDetailsTab = this.#activeTab === "details";
    const isFunctionsTab = this.#activeTab === "functions";
    const characteristics = getCharacteristicSettings();
    const skills = getSkillSettings();
    const rulesProfile = getActiveRulesProfile();
    const descriptionHTML = isDetailsTab ? await TextEditor.enrichHTML(this.ability.description ?? "", {
      secrets: game.user?.isGM ?? false
    }) : "";
    const abilityConstructs = isFunctionsTab
      ? normalizeAbilityConstructs(this.ability.system?.constructs)
      : [];
    return {
      ...(await super._prepareContext(options)),
      ability: this.ability,
      system: this.ability.system,
      isFeature: this.#isFeature,
      isDetailsTab,
      isFunctionsTab,
      tabs: {
        details: {
          id: "details",
          group: "primary",
          cssClass: this.#activeTab === "details" ? "active" : ""
        },
        functions: {
          id: "functions",
          group: "primary",
          cssClass: this.#activeTab === "functions" ? "active" : ""
        }
      },
      descriptionHTML,
      canAddFunction: true,
      showFunctionPicker: this.#functionPickerActive,
      showFixedFunctionPicker: rulesProfile.fixedAbilityFunctionsEnabled !== false
        && this.#fixedFunctionPickerActive,
      functionChoices: buildFunctionChoices(rulesProfile.fixedAbilityFunctionsEnabled !== false),
      fixedFunctionChoices: getFixedAbilityFunctionChoices(),
      weaponProficienciesEnabled: rulesProfile.weaponProficienciesEnabled !== false,
      onlyFree: Boolean(this.ability.system?.acquisition?.onlyFree),
      onlyManual: Boolean(this.ability.system?.acquisition?.onlyManual),
      acquisitionRequirements: isDetailsTab ? (this.ability.system?.acquisitionRequirements ?? []).map(requirement => prepareAcquisitionRequirementForDisplay(requirement, {
        characteristicSettings: characteristics,
        skillSettings: skills
      })) : [],
      researchDifficulty: Math.max(0, toInteger(this.ability.system?.acquisition?.difficulty ?? 60)),
      researchSkillChoices: isDetailsTab ? skills.map((skill, index) => ({
        key: skill.key,
        label: skill.label,
        selected: skill.key === this.ability.system?.acquisition?.skillKey || (!this.ability.system?.acquisition?.skillKey && index === 0)
      })) : [],
      functions: isFunctionsTab
        ? normalizeAbilityFunctions(this.ability.system?.functions ?? [])
          .map(entry => prepareFunctionForDisplay(entry, { constructs: abilityConstructs }))
        : [],
      constructs: abilityConstructs.map(prepareAbilityConstructForDisplay)
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.element?.querySelector?.("[data-choose-ability-function]")?.addEventListener("change", event => this.#onChooseFunction(event));
    this.element?.querySelector?.("[data-choose-fixed-ability-function]")?.addEventListener("change", event => this.#onChooseFixedFunction(event));
    this.element?.querySelector?.("[data-fixed-ability-function-search]")?.addEventListener("input", event => this.#onFixedFunctionSearch(event));
    this.element?.querySelectorAll?.("[data-fixed-rescue-mode]")?.forEach(select => {
      select.addEventListener("change", () => syncFixedRescueCountVisibility(select));
      syncFixedRescueCountVisibility(select);
    });
    this.element?.querySelectorAll?.("[data-field='conditionType']")?.forEach(select => {
      select.addEventListener("change", event => this.#onConditionTypeChange(event));
    });
    this.element?.querySelectorAll?.("[data-field='action.type']")?.forEach(select => {
      select.addEventListener("change", event => this.#onActionTypeChange(event));
    });
    this.element?.querySelectorAll?.("[data-field='conditionEventKey']")?.forEach(select => {
      select.addEventListener("change", event => this.#onConditionTypeChange(event));
    });
    this.element?.querySelectorAll?.("[data-field='conditionEventPath']")?.forEach(select => {
      select.addEventListener("change", event => this.#onConditionEventPathChange(event));
    });
    this.element?.querySelectorAll?.("[data-field='conditionHealthTarget']")?.forEach(select => {
      select.addEventListener("change", event => this.#onConditionTypeChange(event));
    });
    this.element?.querySelectorAll?.("[data-field='conditionAuraMode']")?.forEach(select => {
      select.addEventListener("change", event => this.#onConditionTypeChange(event));
    });
    this.element?.querySelectorAll?.("[data-field='conditionTrialLinkType']")?.forEach(select => {
      select.addEventListener("change", event => this.#onConditionTrialLinkTypeChange(event));
    });
    this.element?.querySelectorAll?.("[data-field='conditionTrialLinkRecipient']")?.forEach(select => {
      select.addEventListener("change", event => this.#onConditionTypeChange(event));
    });
    this.element?.querySelectorAll?.("[data-field='conditionTrialBranchResultKey']")?.forEach(input => {
      input.addEventListener("change", event => this.#onConditionTypeChange(event));
    });
    this.element?.querySelectorAll?.("[data-field='conditionAttackDistanceMode']")?.forEach(select => {
      select.addEventListener("change", event => this.#onConditionTypeChange(event));
    });
    this.element?.querySelectorAll?.("[data-field='active.targetMode'], [data-field='active.targetSelectionMode']")?.forEach(select => {
      select.addEventListener("change", event => this.#onActiveApplicationTargetModeChange(event));
    });
    this.element?.querySelectorAll?.(
      "[data-field='attack.targeting.mode'], [data-field='attack.area.regionSpecialProperty.type'], [data-field='attack.specialProperty.type'], [data-field='attack.requirement.type'], [data-field='attack.hitTrial.subject'], [data-field='constructDamageAmountMode']"
    )?.forEach(select => {
      select.addEventListener("change", event => this.#onAttackSettingsStructureChange(event));
    });
    this.element?.querySelectorAll?.("[data-field='attack.attackSoundVolume']")?.forEach(slider => {
      slider.addEventListener("input", () => syncAttackSoundVolumeLabel(slider));
      syncAttackSoundVolumeLabel(slider);
    });
    this.element?.querySelectorAll?.("[data-field='action.actionPointCostMode']")?.forEach(select => {
      select.addEventListener("change", () => syncAbilityActionCostVisibility(select));
      syncAbilityActionCostVisibility(select);
    });
    this.element?.querySelectorAll?.("[data-field='action.attackActionKey']")?.forEach(select => {
      select.addEventListener("change", () => syncAbilityAttackChoiceControls(select));
      syncAbilityAttackChoiceControls(select);
    });
    this.element?.querySelectorAll?.("[data-field='acquisitionRequirementType']")?.forEach(select => {
      select.addEventListener("change", event => this.#onAcquisitionRequirementTypeChange(event));
    });
    this.#activateAcquisitionAbilityDropzones();
    activateAbilityFunctionKeyAutocomplete(this.element);
    activateAdvancementPureValuesControls(this.element);
    activateFormulaAutocomplete(this.element, {
      characteristics: getCharacteristicSettings(),
      skills: getSkillSettings(),
      actorReferences: getActorFormulaAutocompleteEntries()
    });
    activateDescriptionFormulaAutocomplete(this.element);
  }

  _processFormData(_event, _form, _formData) {
    this.#syncFromForm();
    return this.ability;
  }

  async close(options = {}) {
    if (!this.#closeSavePromise) {
      if (this.form) this.#syncFromForm();
      this.#closeSavePromise = this.catalogApp.saveAbility(this.categoryId, this.ability);
    }
    const saved = await this.#closeSavePromise;
    if (saved) this.ability = saved;
    return super.close(options);
  }

  static #onSelectTab(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    this.#activeTab = target.dataset.tab ?? "details";
    return this.#persist({ render: true, sync: false });
  }

  static #onEditAbilityImage(event) {
    event.preventDefault();
    this.#syncFromForm();
    const picker = new foundry.applications.apps.FilePicker.implementation({
      type: "image",
      current: this.ability.img,
      callback: path => {
        this.ability = normalizeAbilityEntry({
          ...this.ability,
          img: path
        });
        void this.#persist({ render: true, sync: false });
      }
    });
    return picker.render(true);
  }

  static #onAddFunction(event) {
    event.preventDefault();
    this.#syncFromForm();
    this.#functionPickerActive = true;
    this.#activeTab = "functions";
    return this.#persist({ render: true, sync: false });
  }

  #onChooseFunction(event) {
    event.preventDefault();
    this.#syncFromForm();
    const selected = String(event.currentTarget?.value ?? "");
    if (selected === ABILITY_FUNCTION_TYPES.fixed) {
      this.#functionPickerActive = false;
      this.#fixedFunctionPickerActive = true;
      this.#activeTab = "functions";
      return this.#persist({ render: true, sync: false });
    }
    if (![
      ABILITY_FUNCTION_TYPES.effectChanges,
      ABILITY_FUNCTION_TYPES.activeApplication,
      ABILITY_FUNCTION_TYPES.attackAction,
      ABILITY_FUNCTION_TYPES.acquisitionChanges
    ].includes(selected)) return undefined;
    this.ability.system.functions.push(createAbilityFunction(selected));
    this.#functionPickerActive = false;
    this.#fixedFunctionPickerActive = false;
    this.#activeTab = "functions";
    return this.#persist({ render: true, sync: false });
  }

  #onChooseFixedFunction(event) {
    event.preventDefault();
    this.#syncFromForm();
    const abilityFunction = createFixedAbilityFunction(event.currentTarget?.value ?? "");
    if (!abilityFunction) return undefined;
    this.ability.system.functions.push(abilityFunction);
    this.#functionPickerActive = false;
    this.#fixedFunctionPickerActive = false;
    this.#activeTab = "functions";
    return this.#persist({ render: true, sync: false });
  }

  #onFixedFunctionSearch(event) {
    const query = String(event.currentTarget?.value ?? "").trim().toLocaleLowerCase();
    const select = this.element?.querySelector("[data-choose-fixed-ability-function]");
    select?.querySelectorAll("option").forEach(option => {
      const value = String(option.value ?? "");
      if (!value) return;
      option.hidden = query && !String(option.textContent ?? "").toLocaleLowerCase().includes(query);
    });
  }

  #onConditionTypeChange(event) {
    event.preventDefault();
    event.stopPropagation();
    this.#syncFromForm();
    if (event.currentTarget?.dataset?.field === "conditionHealthTarget") {
      const functionRow = event.currentTarget.closest("[data-ability-function-row]");
      const conditionRow = event.currentTarget.closest("[data-ability-condition-row]");
      const functionIndex = getRowIndex(this.form, "[data-ability-function-row]", functionRow);
      const conditionIndex = getRowIndex(functionRow, "[data-ability-condition-row]", conditionRow);
      const condition = this.ability.system.functions?.[functionIndex]?.conditions?.[conditionIndex];
      if (condition) condition.limbKey = ABILITY_HEALTH_LIMB_ALL;
    }
    if (
      event.currentTarget?.dataset?.field === "conditionAuraMode"
      && event.currentTarget.value !== ABILITY_AURA_MODES.applyToTargets
    ) {
      const { condition } = this.#getConditionForTarget(event.currentTarget);
      if (condition) condition.auraIncludeSelf = false;
    }
    this.#activeTab = "functions";
    return this.#persist({ render: true, sync: false });
  }

  #onActionTypeChange(event) {
    event.preventDefault();
    event.stopPropagation();
    this.#syncFromForm();
    this.#activeTab = "functions";
    return this.#persist({ render: true, sync: false });
  }

  #onAcquisitionRequirementTypeChange(event) {
    event.preventDefault();
    event.stopPropagation();
    this.#syncFromForm();
    this.#activeTab = "details";
    return this.#persist({ render: true, sync: false });
  }

  #onActiveApplicationTargetModeChange(event) {
    event.preventDefault();
    event.stopPropagation();
    this.#syncFromForm();
    this.#activeTab = "functions";
    return this.#persist({ render: true, sync: false });
  }

  #onAttackSettingsStructureChange(event) {
    event.preventDefault();
    event.stopPropagation();
    this.#syncFromForm();
    if (event.currentTarget?.dataset?.field === "attack.requirement.type") {
      const abilityFunction = findAttackFunctionByTarget(this.ability, event.currentTarget);
      const functionRow = event.currentTarget.closest("[data-ability-function-row]");
      const requirementIndex = getRowIndex(
        functionRow,
        "[data-attack-requirement-row]",
        event.currentTarget.closest("[data-attack-requirement-row]")
      );
      const requirement = abilityFunction?.attackSettings?.requirements?.[requirementIndex];
      if (requirement) {
        const entries = requirement.type === "skill" ? getSkillSettings() : getCharacteristicSettings();
        if (!entries.some(entry => entry.key === requirement.key)) {
          requirement.key = entries.at(0)?.key ?? "";
        }
      }
    }
    this.#activeTab = "functions";
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteFunction(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const row = target.closest("[data-ability-function-row]");
    const index = getRowIndex(this.form, "[data-ability-function-row]", row);
    if (index >= 0) this.ability.system.functions.splice(index, 1);
    return this.#persist({ render: true, sync: false });
  }

  static #onAddFunctionChange(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const functionIndex = getRowIndex(this.form, "[data-ability-function-row]", target.closest("[data-ability-function-row]"));
    const entry = this.ability.system.functions[functionIndex];
    if ([ABILITY_FUNCTION_TYPES.effectChanges, ABILITY_FUNCTION_TYPES.activeApplication, ABILITY_FUNCTION_TYPES.acquisitionChanges].includes(entry?.type)) {
      entry?.changes?.push(createAbilityChange());
    }
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteFunctionChange(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const functionIndex = getRowIndex(this.form, "[data-ability-function-row]", target.closest("[data-ability-function-row]"));
    const changeIndex = getRowIndex(target.closest("[data-ability-function-row]"), "[data-ability-change-row]", target.closest("[data-ability-change-row]"));
    if (functionIndex >= 0 && changeIndex >= 0) this.ability.system.functions[functionIndex]?.changes?.splice(changeIndex, 1);
    return this.#persist({ render: true, sync: false });
  }

  static #onEnableFunctionChangeAccumulator(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const functionRow = target.closest("[data-ability-function-row]");
    const changeRow = target.closest("[data-ability-change-row]");
    const functionIndex = getRowIndex(this.form, "[data-ability-function-row]", functionRow);
    const changeIndex = getRowIndex(functionRow, "[data-ability-change-row]", changeRow);
    const abilityFunction = this.ability.system.functions?.[functionIndex];
    const change = abilityFunction?.changes?.[changeIndex];
    const accumulator = abilityFunction?.conditions
      ?.find(condition => condition?.type === ABILITY_CONDITION_TYPES.accumulation);
    if (change && accumulator) {
      change.valueSource = ABILITY_CHANGE_VALUE_SOURCES.accumulation;
      change.accumulatorExchange = {
        conditionId: String(accumulator.id ?? ""),
        mode: "invested"
      };
    }
    return this.#persist({ render: true, sync: false });
  }

  static #onDisableFunctionChangeAccumulator(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const functionRow = target.closest("[data-ability-function-row]");
    const changeRow = target.closest("[data-ability-change-row]");
    const functionIndex = getRowIndex(this.form, "[data-ability-function-row]", functionRow);
    const changeIndex = getRowIndex(functionRow, "[data-ability-change-row]", changeRow);
    const change = this.ability.system.functions?.[functionIndex]?.changes?.[changeIndex];
    if (change) {
      delete change.valueSource;
      delete change.accumulatorExchange;
    }
    return this.#persist({ render: true, sync: false });
  }

  static #onAddFunctionAction(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const functionIndex = getRowIndex(this.form, "[data-ability-function-row]", target.closest("[data-ability-function-row]"));
    const entry = this.ability.system.functions?.[functionIndex];
    if ([ABILITY_FUNCTION_TYPES.effectChanges, ABILITY_FUNCTION_TYPES.activeApplication].includes(entry?.type)) {
      entry.actions ??= [];
      entry.actions.push(createAbilityAction());
    }
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteFunctionAction(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const functionRow = target.closest("[data-ability-function-row]");
    const actionRow = target.closest("[data-ability-action-row]");
    const functionIndex = getRowIndex(this.form, "[data-ability-function-row]", functionRow);
    const actionIndex = Number(actionRow?.dataset.actionIndex ?? -1);
    if (functionIndex >= 0 && actionIndex >= 0) this.ability.system.functions?.[functionIndex]?.actions?.splice(actionIndex, 1);
    return this.#persist({ render: true, sync: false });
  }

  static #onAddFunctionAttackChoice(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const functionRow = target.closest("[data-ability-function-row]");
    const actionRow = target.closest("[data-ability-action-row]");
    const functionIndex = getRowIndex(this.form, "[data-ability-function-row]", functionRow);
    const actionIndex = Number(actionRow?.dataset.actionIndex ?? -1);
    const action = this.ability.system.functions?.[functionIndex]?.actions?.[actionIndex];
    if (!action || action.attackActionKeys?.includes(ABILITY_ATTACK_ACTION_ALL)) return undefined;
    const nextKey = ABILITY_ATTACKING_WEAPON_ACTION_KEYS.find(key => !action.attackActionKeys.includes(key));
    if (!nextKey) return undefined;
    action.attackActionKeys.push(nextKey);
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteFunctionAttackChoice(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const functionRow = target.closest("[data-ability-function-row]");
    const actionRow = target.closest("[data-ability-action-row]");
    const functionIndex = getRowIndex(this.form, "[data-ability-function-row]", functionRow);
    const actionIndex = Number(actionRow?.dataset.actionIndex ?? -1);
    const choiceIndex = Number(target.closest("[data-ability-attack-choice-row]")?.dataset.choiceIndex ?? -1);
    const choices = this.ability.system.functions?.[functionIndex]?.actions?.[actionIndex]?.attackActionKeys;
    if (Array.isArray(choices) && choices.length > 1 && choiceIndex >= 0) choices.splice(choiceIndex, 1);
    return this.#persist({ render: true, sync: false });
  }

  static #onAddToTheEndAdvantageSkill(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const functionIndex = getRowIndex(this.form, "[data-ability-function-row]", target.closest("[data-ability-function-row]"));
    const entry = this.ability.system.functions?.[functionIndex];
    if (entry?.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.toTheEnd) {
      const settings = normalizeToTheEndSettings(entry.fixedSettings);
      settings.advantageSkills.push({ skillKey: getFirstUnusedToTheEndAdvantageSkillKey(settings.advantageSkills), advantageCount: 1 });
      entry.fixedSettings = settings;
    }
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteToTheEndAdvantageSkill(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const functionRow = target.closest("[data-ability-function-row]");
    const functionIndex = getRowIndex(this.form, "[data-ability-function-row]", functionRow);
    const skillIndex = getRowIndex(functionRow, "[data-fixed-to-the-end-advantage-skill-row]", target.closest("[data-fixed-to-the-end-advantage-skill-row]"));
    const entry = this.ability.system.functions?.[functionIndex];
    const settings = normalizeToTheEndSettings(entry?.fixedSettings);
    if (entry?.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.toTheEnd && settings.advantageSkills.length > 1 && skillIndex >= 0) {
      settings.advantageSkills.splice(skillIndex, 1);
      entry.fixedSettings = settings;
    }
    return this.#persist({ render: true, sync: false });
  }

  static #onAddFunctionCondition(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const functionRow = target.closest("[data-ability-function-row]");
    const functionIndex = getRowIndex(this.form, "[data-ability-function-row]", functionRow);
    const entry = this.ability.system.functions[functionIndex];
    if ([ABILITY_FUNCTION_TYPES.effectChanges, ABILITY_FUNCTION_TYPES.activeApplication, ABILITY_FUNCTION_TYPES.acquisitionChanges].includes(entry?.type)) {
      entry?.conditions?.push(createAbilityCondition(""));
    }
    return this.#persist({ render: true, sync: false });
  }

  static #onAddFunctionConditionAlternative(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const functionRow = target.closest("[data-ability-function-row]");
    const conditionRow = target.closest("[data-ability-condition-row]");
    const functionIndex = getRowIndex(this.form, "[data-ability-function-row]", functionRow);
    const conditionIndex = getRowIndex(functionRow, "[data-ability-condition-row]", conditionRow);
    const conditions = this.ability.system.functions?.[functionIndex]?.conditions;
    const condition = conditions?.[conditionIndex];
    if (!condition) return this.#persist({ render: true, sync: false });

    const groupId = String(condition.groupId ?? "").trim() || foundry.utils.randomID();
    condition.groupId = groupId;
    conditions.splice(conditionIndex + 1, 0, createAbilityCondition({ type: "", groupId }));
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteFunctionCondition(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const functionRow = target.closest("[data-ability-function-row]");
    const conditionRow = target.closest("[data-ability-condition-row]");
    const functionIndex = getRowIndex(this.form, "[data-ability-function-row]", functionRow);
    const conditionIndex = getRowIndex(functionRow, "[data-ability-condition-row]", conditionRow);
    if (functionIndex >= 0 && conditionIndex >= 0) {
      const abilityFunction = this.ability.system.functions[functionIndex];
      const removed = abilityFunction?.conditions?.[conditionIndex];
      abilityFunction?.conditions?.splice(conditionIndex, 1);
      if (removed?.type === ABILITY_CONDITION_TYPES.accumulation) {
        for (const change of abilityFunction?.changes ?? []) {
          if (change?.accumulatorExchange?.conditionId !== removed.id) continue;
          delete change.valueSource;
          delete change.accumulatorExchange;
        }
      }
      if (removed?.type === ABILITY_CONDITION_TYPES.trial) {
        const candidates = new Set((removed.trialBranches ?? [])
          .flatMap(branch => branch?.links ?? [])
          .map(link => String(link?.constructId ?? ""))
          .filter(Boolean));
        this.ability.system.constructs = (this.ability.system.constructs ?? [])
          .filter(construct => (
            !candidates.has(String(construct?.id ?? ""))
            || isAbilityConstructLinked(this.ability, construct?.id)
          ));
      }
    }
    return this.#persist({ render: true, sync: false });
  }

  static #onAddConditionTrialEntry(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const { condition } = this.#getConditionForTarget(target);
    if (condition?.type !== ABILITY_CONDITION_TYPES.trial) {
      return this.#persist({ render: true, sync: false });
    }
    condition.trialEntries ??= [];
    condition.trialEntries.push(createAbilityTrialEntry());
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteConditionTrialEntry(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const { condition } = this.#getConditionForTarget(target);
    const entryIndex = Number(target.closest("[data-trial-entry-row]")?.dataset.trialEntryIndex ?? -1);
    if (condition?.type === ABILITY_CONDITION_TYPES.trial && entryIndex >= 0) {
      condition.trialEntries?.splice(entryIndex, 1);
    }
    return this.#persist({ render: true, sync: false });
  }

  static #onAddConditionTrialBranch(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const { condition } = this.#getConditionForTarget(target);
    if (condition?.type !== ABILITY_CONDITION_TYPES.trial) {
      return this.#persist({ render: true, sync: false });
    }
    condition.trialBranches ??= [];
    condition.trialBranches.push(createAbilityTrialBranch({
      name: `Ветка ${condition.trialBranches.length + 1}`,
      resultKeys: []
    }));
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteConditionTrialBranch(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const { condition } = this.#getConditionForTarget(target);
    const branchIndex = Number(target.closest("[data-trial-branch-row]")?.dataset.trialBranchIndex ?? -1);
    if (condition?.type === ABILITY_CONDITION_TYPES.trial && branchIndex >= 0) {
      const [removed] = condition.trialBranches?.splice(branchIndex, 1) ?? [];
      const constructIds = (removed?.links ?? [])
        .map(link => String(link?.constructId ?? ""))
        .filter(Boolean);
      if (constructIds.length) {
        const candidates = new Set(constructIds);
        this.ability.system.constructs = (this.ability.system.constructs ?? [])
          .filter(construct => (
            !candidates.has(String(construct?.id ?? ""))
            || isAbilityConstructLinked(this.ability, construct?.id)
          ));
      }
    }
    return this.#persist({ render: true, sync: false });
  }

  static #onAddConditionTrialLink(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const { condition } = this.#getConditionForTarget(target);
    const branchIndex = Number(target.closest("[data-trial-branch-row]")?.dataset.trialBranchIndex ?? -1);
    const branch = condition?.trialBranches?.[branchIndex];
    if (condition?.type !== ABILITY_CONDITION_TYPES.trial || !branch) {
      return this.#persist({ render: true, sync: false });
    }
    branch.links ??= [];
    branch.links.push(createAbilityTrialLink({
      kind: ABILITY_TRIAL_LINK_KINDS.pending
    }));
    return this.#persist({ render: true, sync: false });
  }

  #onConditionTrialLinkTypeChange(event) {
    event.preventDefault();
    event.stopPropagation();
    this.#syncFromForm();
    const target = event.currentTarget;
    const selectedType = String(target?.value ?? "");
    const { condition } = this.#getConditionForTarget(target);
    const branchIndex = Number(target.closest("[data-trial-branch-row]")?.dataset.trialBranchIndex ?? -1);
    const linkIndex = Number(target.closest("[data-trial-link-row]")?.dataset.trialLinkIndex ?? -1);
    const link = condition?.trialBranches?.[branchIndex]?.links?.[linkIndex];
    if (condition?.type !== ABILITY_CONDITION_TYPES.trial || !link) {
      return this.#persist({ render: true, sync: false });
    }

    this.ability.system.constructs ??= [];
    const previousConstructId = String(link.constructId ?? "");
    if ([
      ABILITY_TRIAL_LINK_KINDS.primaryChanges,
      ABILITY_TRIAL_LINK_KINDS.primaryChangesPercent
    ].includes(selectedType)) {
      condition.trialRoutesPrimaryChanges = true;
      link.kind = selectedType;
      link.constructId = "";
      link.percentFormula ||= "100";
    } else if (Object.values(ABILITY_CONSTRUCT_TYPES).includes(selectedType)) {
      const existing = this.ability.system.constructs
        .find(construct => String(construct?.id ?? "") === previousConstructId);
      if (!existing || existing.type !== selectedType) {
        const construct = prepareNewOrdinaryTrialConstruct(createAbilityConstruct(selectedType));
        this.ability.system.constructs.push(construct);
        link.constructId = construct.id;
      }
      link.kind = ABILITY_TRIAL_LINK_KINDS.construct;
    } else {
      link.kind = ABILITY_TRIAL_LINK_KINDS.pending;
      link.constructId = "";
    }

    if (
      previousConstructId
      && previousConstructId !== String(link.constructId ?? "")
      && !isAbilityConstructLinked(this.ability, previousConstructId)
    ) {
      this.ability.system.constructs = this.ability.system.constructs
        .filter(construct => String(construct?.id ?? "") !== previousConstructId);
    }
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteConditionTrialLink(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const { condition } = this.#getConditionForTarget(target);
    const branchIndex = Number(target.closest("[data-trial-branch-row]")?.dataset.trialBranchIndex ?? -1);
    const linkIndex = Number(target.closest("[data-trial-link-row]")?.dataset.trialLinkIndex ?? -1);
    const branch = condition?.trialBranches?.[branchIndex];
    if (condition?.type === ABILITY_CONDITION_TYPES.trial && branch && linkIndex >= 0) {
      const [removed] = branch.links?.splice(linkIndex, 1) ?? [];
      const constructId = String(removed?.constructId ?? "");
      if (constructId && !isAbilityConstructLinked(this.ability, constructId)) {
        this.ability.system.constructs = (this.ability.system.constructs ?? [])
          .filter(construct => String(construct?.id ?? "") !== constructId);
      }
    }
    return this.#persist({ render: true, sync: false });
  }

  static #onAddAbilityConstruct(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const requested = String(target?.dataset?.constructType ?? "");
    const type = Object.values(ABILITY_CONSTRUCT_TYPES).includes(requested)
      ? requested
      : ABILITY_CONSTRUCT_TYPES.temporaryEffect;
    this.ability.system.constructs ??= [];
    this.ability.system.constructs.push(createAbilityConstruct(type));
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteAbilityConstruct(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const constructRow = target.closest("[data-ability-construct-row]");
    const constructIndex = getRowIndex(this.form, "[data-ability-construct-row]", constructRow);
    if (constructIndex < 0) return this.#persist({ render: true, sync: false });
    const removedId = String(this.ability.system.constructs?.[constructIndex]?.id ?? "");
    this.ability.system.constructs?.splice(constructIndex, 1);
    for (const abilityFunction of this.ability.system.functions ?? []) {
      for (const condition of abilityFunction.conditions ?? []) {
        if (condition?.type !== ABILITY_CONDITION_TYPES.trial) continue;
        for (const branch of condition.trialBranches ?? []) {
          branch.links = (branch.links ?? [])
            .filter(link => String(link?.constructId ?? "") !== removedId);
        }
      }
    }
    return this.#persist({ render: true, sync: false });
  }

  static #onAddAbilityConstructChange(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const constructIndex = getRowIndex(
      this.form,
      "[data-ability-construct-row]",
      target.closest("[data-ability-construct-row]")
    );
    const construct = this.ability.system.constructs?.[constructIndex];
    if (construct?.type === ABILITY_CONSTRUCT_TYPES.temporaryEffect) {
      construct.changes ??= [];
      construct.changes.push(createAbilityChange());
    }
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteAbilityConstructChange(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const constructRow = target.closest("[data-ability-construct-row]");
    const constructIndex = getRowIndex(this.form, "[data-ability-construct-row]", constructRow);
    const changeIndex = getRowIndex(
      constructRow,
      "[data-ability-construct-change-row]",
      target.closest("[data-ability-construct-change-row]")
    );
    if (constructIndex >= 0 && changeIndex >= 0) {
      this.ability.system.constructs?.[constructIndex]?.changes?.splice(changeIndex, 1);
    }
    return this.#persist({ render: true, sync: false });
  }

  static #onAddAbilityConstructResource(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const constructIndex = getRowIndex(
      this.form,
      "[data-ability-construct-row]",
      target.closest("[data-ability-construct-row]")
    );
    const construct = this.ability.system.constructs?.[constructIndex];
    if (construct?.type === ABILITY_CONSTRUCT_TYPES.resourceChange) {
      construct.resources ??= [];
      construct.resources.push(createAbilityConstructResource());
    }
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteAbilityConstructResource(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const constructRow = target.closest("[data-ability-construct-row]");
    const constructIndex = getRowIndex(this.form, "[data-ability-construct-row]", constructRow);
    const resourceIndex = getRowIndex(
      constructRow,
      "[data-ability-construct-resource-row]",
      target.closest("[data-ability-construct-resource-row]")
    );
    if (constructIndex >= 0 && resourceIndex >= 0) {
      this.ability.system.constructs?.[constructIndex]?.resources?.splice(resourceIndex, 1);
    }
    return this.#persist({ render: true, sync: false });
  }

  static #onAddConditionTriggerCost(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const { condition } = this.#getConditionForTarget(target);
    if (condition?.type !== ABILITY_CONDITION_TYPES.triggerCost) {
      return this.#persist({ render: true, sync: false });
    }
    const costs = normalizeTriggerCostRows(condition.costs);
    costs.push({
      id: foundry.utils.randomID(),
      resourceKey: REACTION_POINTS_RESOURCE_KEY,
      formula: "1",
      overloadAmount: 0,
      overloadDurationSeconds: 0
    });
    condition.costs = costs;
    return this.#persist({ render: true, sync: false });
  }

  static #onAddActiveApplicationCost(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const functionRow = target.closest("[data-ability-function-row]");
    const functionIndex = getRowIndex(this.form, "[data-ability-function-row]", functionRow);
    const abilityFunction = this.ability.system.functions?.[functionIndex];
    if (abilityFunction?.type !== ABILITY_FUNCTION_TYPES.activeApplication) {
      return this.#persist({ render: true, sync: false });
    }
    const settings = normalizeActiveApplicationSettings(abilityFunction.activeSettings);
    settings.costs.push({
      id: foundry.utils.randomID(),
      resourceKey: REACTION_POINTS_RESOURCE_KEY,
      formula: "1",
      overloadAmount: 0,
      overloadDurationSeconds: 0,
      payer: ABILITY_ACTIVE_APPLICATION_COST_PAYERS.source
    });
    abilityFunction.activeSettings = settings;
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteActiveApplicationCost(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const functionRow = target.closest("[data-ability-function-row]");
    const costRow = target.closest("[data-active-application-cost-row]");
    const functionIndex = getRowIndex(this.form, "[data-ability-function-row]", functionRow);
    const costIndex = getRowIndex(functionRow, "[data-active-application-cost-row]", costRow);
    const abilityFunction = this.ability.system.functions?.[functionIndex];
    if (abilityFunction?.type !== ABILITY_FUNCTION_TYPES.activeApplication || costIndex < 0) {
      return this.#persist({ render: true, sync: false });
    }
    const settings = normalizeActiveApplicationSettings(abilityFunction.activeSettings);
    settings.costs.splice(costIndex, 1);
    abilityFunction.activeSettings = settings;
    return this.#persist({ render: true, sync: false });
  }

  static #onAddAttackDamageType(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const abilityFunction = findAttackFunctionByTarget(this.ability, target);
    if (!abilityFunction) return this.#persist({ render: true, sync: false });
    const settings = normalizeAttackActionSettings(abilityFunction.attackSettings);
    const damageTypes = getConfigurableDamageTypes(getDamageTypeSettings());
    const used = new Set(settings.damageTypes.map(entry => String(entry?.key ?? "")));
    const key = damageTypes.find(entry => !used.has(entry.key))?.key
      ?? damageTypes.at(0)?.key
      ?? settings.damageTypeKey
      ?? "firearm";
    settings.damageTypes.push({ key, percent: settings.damageTypes.length ? 0 : 100 });
    if (!settings.damageTypeKey) settings.damageTypeKey = key;
    abilityFunction.attackSettings = settings;
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteAttackDamageType(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const abilityFunction = findAttackFunctionByTarget(this.ability, target);
    const index = getRowIndex(
      target.closest("[data-ability-function-row]"),
      "[data-attack-damage-type-row]",
      target.closest("[data-attack-damage-type-row]")
    );
    if (!abilityFunction || index < 0) return this.#persist({ render: true, sync: false });
    const settings = normalizeAttackActionSettings(abilityFunction.attackSettings);
    settings.damageTypes.splice(index, 1);
    settings.damageTypeKey = settings.damageTypes.at(0)?.key ?? settings.damageTypeKey;
    abilityFunction.attackSettings = settings;
    return this.#persist({ render: true, sync: false });
  }

  static #onAddAttackResourceCost(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const abilityFunction = findAttackFunctionByTarget(this.ability, target);
    if (!abilityFunction) return this.#persist({ render: true, sync: false });
    const settings = normalizeAttackActionSettings(abilityFunction.attackSettings);
    settings.resourceCosts.push({
      id: foundry.utils.randomID(),
      resourceKey: REACTION_POINTS_RESOURCE_KEY,
      formula: "1",
      overloadAmount: 0,
      overloadDurationSeconds: 0
    });
    abilityFunction.attackSettings = settings;
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteAttackResourceCost(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const abilityFunction = findAttackFunctionByTarget(this.ability, target);
    const functionRow = target.closest("[data-ability-function-row]");
    const index = getRowIndex(
      functionRow,
      "[data-attack-resource-cost-row]",
      target.closest("[data-attack-resource-cost-row]")
    );
    if (!abilityFunction || index < 0) return this.#persist({ render: true, sync: false });
    const settings = normalizeAttackActionSettings(abilityFunction.attackSettings);
    const [removed] = settings.resourceCosts.splice(index, 1);
    const removedResourceKey = String(removed?.resourceKey ?? "").trim();
    const resourceStillUsed = removedResourceKey && settings.resourceCosts
      .some(cost => String(cost?.resourceKey ?? "").trim() === removedResourceKey);
    if (removedResourceKey && !resourceStillUsed) {
      settings.specialProperties = (settings.specialProperties ?? []).map(property => {
        if (getWeaponSpecialPropertyType(property) !== WEAPON_SPECIAL_PROPERTIES.attackPower) return property;
        return {
          ...property,
          attackPower: {
            ...property.attackPower,
            resourceCosts: (property.attackPower?.resourceCosts ?? [])
              .filter(cost => String(cost?.resourceKey ?? "").trim() !== removedResourceKey)
          }
        };
      });
      settings.criticalFailureConsequences = settings.criticalFailureConsequences
        .filter(consequence => String(consequence?.resourceKey ?? "").trim() !== removedResourceKey);
    }
    abilityFunction.attackSettings = settings;
    return this.#persist({ render: true, sync: false });
  }

  static #onAddAttackRegionDamage(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const abilityFunction = findAttackFunctionByTarget(this.ability, target);
    if (!abilityFunction) return this.#persist({ render: true, sync: false });
    const settings = normalizeAttackActionSettings(abilityFunction.attackSettings);
    const damageTypeKey = getConfigurableDamageTypes(getDamageTypeSettings()).at(0)?.key
      ?? settings.damageTypeKey
      ?? "firearm";
    settings.area.regionDamageEntries.push({ damageTypeKey, amount: "0" });
    abilityFunction.attackSettings = settings;
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteAttackRegionDamage(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const abilityFunction = findAttackFunctionByTarget(this.ability, target);
    const functionRow = target.closest("[data-ability-function-row]");
    const index = getRowIndex(
      functionRow,
      "[data-attack-region-damage-row]",
      target.closest("[data-attack-region-damage-row]")
    );
    if (!abilityFunction || index < 0) return this.#persist({ render: true, sync: false });
    const settings = normalizeAttackActionSettings(abilityFunction.attackSettings);
    settings.area.regionDamageEntries.splice(index, 1);
    abilityFunction.attackSettings = settings;
    return this.#persist({ render: true, sync: false });
  }

  static #onAddAttackRegionSpecialProperty(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const abilityFunction = findAttackFunctionByTarget(this.ability, target);
    if (!abilityFunction) return this.#persist({ render: true, sync: false });
    const settings = normalizeAttackActionSettings(abilityFunction.attackSettings);
    if (!normalizeRegionSpecialProperties(settings.area.regionSpecialProperties).length) {
      settings.area.regionSpecialProperties = [createDefaultRegionSpecialPropertyData()];
    }
    abilityFunction.attackSettings = settings;
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteAttackRegionSpecialProperty(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const abilityFunction = findAttackFunctionByTarget(this.ability, target);
    if (!abilityFunction) return this.#persist({ render: true, sync: false });
    const settings = normalizeAttackActionSettings(abilityFunction.attackSettings);
    settings.area.regionSpecialProperties = [];
    abilityFunction.attackSettings = settings;
    return this.#persist({ render: true, sync: false });
  }

  static #onAddAttackSpecialProperty(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const abilityFunction = findAttackFunctionByTarget(this.ability, target);
    if (!abilityFunction) return this.#persist({ render: true, sync: false });
    const settings = normalizeAttackActionSettings(abilityFunction.attackSettings);
    settings.specialProperties.push(createDefaultWeaponSpecialPropertyData());
    abilityFunction.attackSettings = settings;
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteAttackSpecialProperty(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const abilityFunction = findAttackFunctionByTarget(this.ability, target);
    const functionRow = target.closest("[data-ability-function-row]");
    const index = getRowIndex(
      functionRow,
      "[data-attack-special-property-row]",
      target.closest("[data-attack-special-property-row]")
    );
    if (!abilityFunction || index < 0) return this.#persist({ render: true, sync: false });
    const settings = normalizeAttackActionSettings(abilityFunction.attackSettings);
    settings.specialProperties.splice(index, 1);
    abilityFunction.attackSettings = settings;
    return this.#persist({ render: true, sync: false });
  }

  static #onAddAttackAdditionalProficiency(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const abilityFunction = findAttackFunctionByTarget(this.ability, target);
    const functionRow = target.closest("[data-ability-function-row]");
    const propertyIndex = getRowIndex(
      functionRow,
      "[data-attack-special-property-row]",
      target.closest("[data-attack-special-property-row]")
    );
    if (!abilityFunction || propertyIndex < 0) return this.#persist({ render: true, sync: false });
    const settings = normalizeAttackActionSettings(abilityFunction.attackSettings);
    const property = settings.specialProperties[propertyIndex];
    const keys = normalizeWeaponAdditionalProficiencyKeys(property?.proficiencyKeys);
    const used = new Set([String(settings.proficiencyKey ?? "").trim(), ...keys]);
    const next = getProficiencySettings().find(proficiency => !used.has(proficiency.key))?.key ?? "";
    if (property && next) property.proficiencyKeys = [...keys, next];
    abilityFunction.attackSettings = settings;
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteAttackAdditionalProficiency(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const abilityFunction = findAttackFunctionByTarget(this.ability, target);
    const functionRow = target.closest("[data-ability-function-row]");
    const propertyIndex = getRowIndex(
      functionRow,
      "[data-attack-special-property-row]",
      target.closest("[data-attack-special-property-row]")
    );
    const propertyRow = target.closest("[data-attack-special-property-row]");
    const proficiencyIndex = getRowIndex(
      propertyRow,
      "[data-attack-additional-proficiency-row]",
      target.closest("[data-attack-additional-proficiency-row]")
    );
    if (!abilityFunction || propertyIndex < 0 || proficiencyIndex < 0) return this.#persist({ render: true, sync: false });
    const settings = normalizeAttackActionSettings(abilityFunction.attackSettings);
    const property = settings.specialProperties[propertyIndex];
    if (property) {
      property.proficiencyKeys = normalizeWeaponAdditionalProficiencyKeys(property.proficiencyKeys);
      property.proficiencyKeys.splice(proficiencyIndex, 1);
    }
    abilityFunction.attackSettings = settings;
    return this.#persist({ render: true, sync: false });
  }

  static #onAddAttackRequirement(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const abilityFunction = findAttackFunctionByTarget(this.ability, target);
    if (!abilityFunction) return this.#persist({ render: true, sync: false });
    const settings = normalizeAttackActionSettings(abilityFunction.attackSettings);
    settings.requirements.push({
      type: "characteristic",
      key: getCharacteristicSettings().at(0)?.key ?? "",
      value: 0
    });
    abilityFunction.attackSettings = settings;
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteAttackRequirement(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const abilityFunction = findAttackFunctionByTarget(this.ability, target);
    const functionRow = target.closest("[data-ability-function-row]");
    const index = getRowIndex(
      functionRow,
      "[data-attack-requirement-row]",
      target.closest("[data-attack-requirement-row]")
    );
    if (!abilityFunction || index < 0) return this.#persist({ render: true, sync: false });
    const settings = normalizeAttackActionSettings(abilityFunction.attackSettings);
    settings.requirements.splice(index, 1);
    abilityFunction.attackSettings = settings;
    return this.#persist({ render: true, sync: false });
  }

  static #onAddAttackCriticalFailure(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const abilityFunction = findAttackFunctionByTarget(this.ability, target);
    if (!abilityFunction) return this.#persist({ render: true, sync: false });
    const settings = normalizeAttackActionSettings(abilityFunction.attackSettings);
    const resourceKey = String(settings.resourceCosts.at(0)?.resourceKey ?? "").trim();
    if (!resourceKey) return this.#persist({ render: true, sync: false });
    settings.criticalFailureConsequences.push({
      id: foundry.utils.randomID(),
      type: "extraResourceCost",
      resourceType: "actorResource",
      resourceKey,
      amount: 0
    });
    abilityFunction.attackSettings = settings;
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteAttackCriticalFailure(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const abilityFunction = findAttackFunctionByTarget(this.ability, target);
    const functionRow = target.closest("[data-ability-function-row]");
    const index = getRowIndex(
      functionRow,
      "[data-attack-critical-failure-row]",
      target.closest("[data-attack-critical-failure-row]")
    );
    if (!abilityFunction || index < 0) return this.#persist({ render: true, sync: false });
    const settings = normalizeAttackActionSettings(abilityFunction.attackSettings);
    settings.criticalFailureConsequences.splice(index, 1);
    abilityFunction.attackSettings = settings;
    return this.#persist({ render: true, sync: false });
  }

  static #onAddAttackHitTrial(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const abilityFunction = findAttackFunctionByTarget(this.ability, target);
    if (!abilityFunction) return this.#persist({ render: true, sync: false });
    const settings = normalizeAttackActionSettings(abilityFunction.attackSettings);
    const trial = createAttackActionTrial({
      entries: [{
        id: foundry.utils.randomID(),
        kind: "skill",
        key: getSkillSettings().at(0)?.key ?? ""
      }]
    });
    settings.hitResolution.trials.push(trial);
    abilityFunction.attackSettings = settings;
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteAttackHitTrial(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const abilityFunction = findAttackFunctionByTarget(this.ability, target);
    const trialIndex = getAttackHitTrialIndex(target);
    if (!abilityFunction || trialIndex < 0) return this.#persist({ render: true, sync: false });
    const settings = normalizeAttackActionSettings(abilityFunction.attackSettings);
    const [removed] = settings.hitResolution.trials.splice(trialIndex, 1);
    abilityFunction.attackSettings = settings;
    removeUnlinkedAttackOutcomeConstructs(this.ability, collectAttackTrialConstructIds(removed));
    return this.#persist({ render: true, sync: false });
  }

  static #onMoveAttackHitTrialUp(event, target) {
    return this.#moveAttackHitTrial(event, target, -1);
  }

  static #onMoveAttackHitTrialDown(event, target) {
    return this.#moveAttackHitTrial(event, target, 1);
  }

  static #moveAttackHitTrial(event, target, offset) {
    event.preventDefault();
    this.#syncFromForm();
    const abilityFunction = findAttackFunctionByTarget(this.ability, target);
    const trialIndex = getAttackHitTrialIndex(target);
    if (!abilityFunction || trialIndex < 0) return this.#persist({ render: true, sync: false });
    const settings = normalizeAttackActionSettings(abilityFunction.attackSettings);
    const nextIndex = trialIndex + offset;
    if (nextIndex < 0 || nextIndex >= settings.hitResolution.trials.length) {
      return this.#persist({ render: true, sync: false });
    }
    const [trial] = settings.hitResolution.trials.splice(trialIndex, 1);
    settings.hitResolution.trials.splice(nextIndex, 0, trial);
    abilityFunction.attackSettings = settings;
    return this.#persist({ render: true, sync: false });
  }

  static #onAddAttackHitTrialEntry(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const abilityFunction = findAttackFunctionByTarget(this.ability, target);
    const trialIndex = getAttackHitTrialIndex(target);
    if (!abilityFunction || trialIndex < 0) return this.#persist({ render: true, sync: false });
    const settings = normalizeAttackActionSettings(abilityFunction.attackSettings);
    settings.hitResolution.trials[trialIndex]?.entries.push({
      id: foundry.utils.randomID(),
      kind: "skill",
      key: getSkillSettings().at(0)?.key ?? ""
    });
    abilityFunction.attackSettings = settings;
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteAttackHitTrialEntry(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const abilityFunction = findAttackFunctionByTarget(this.ability, target);
    const trialIndex = getAttackHitTrialIndex(target);
    const entryIndex = Number(target.closest("[data-attack-hit-trial-entry-row]")?.dataset.entryIndex ?? -1);
    if (!abilityFunction || trialIndex < 0 || entryIndex < 0) {
      return this.#persist({ render: true, sync: false });
    }
    const settings = normalizeAttackActionSettings(abilityFunction.attackSettings);
    settings.hitResolution.trials[trialIndex]?.entries.splice(entryIndex, 1);
    abilityFunction.attackSettings = settings;
    return this.#persist({ render: true, sync: false });
  }

  static #onAddAttackHitOutcomeLink(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const abilityFunction = findAttackFunctionByTarget(this.ability, target);
    const trialIndex = getAttackHitTrialIndex(target);
    const outcomeKey = getAttackHitOutcomeKey(target);
    if (!abilityFunction || trialIndex < 0 || !outcomeKey) {
      return this.#persist({ render: true, sync: false });
    }
    const requested = String(target?.dataset?.constructType ?? "");
    const type = Object.values(ABILITY_CONSTRUCT_TYPES).includes(requested)
      ? requested
      : ABILITY_CONSTRUCT_TYPES.temporaryEffect;
    const construct = createAbilityConstruct(type);
    this.ability.system.constructs ??= [];
    this.ability.system.constructs.push(construct);
    const settings = normalizeAttackActionSettings(abilityFunction.attackSettings);
    const outcome = settings.hitResolution.trials[trialIndex]?.outcomes?.[outcomeKey];
    if (outcome) {
      outcome.links.push({
        id: foundry.utils.randomID(),
        constructId: construct.id,
        recipient: ABILITY_TRIAL_LINK_RECIPIENTS.subjects,
        mode: ABILITY_TRIAL_LINK_MODES.perSubject
      });
    }
    abilityFunction.attackSettings = settings;
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteAttackHitOutcomeLink(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const abilityFunction = findAttackFunctionByTarget(this.ability, target);
    const trialIndex = getAttackHitTrialIndex(target);
    const outcomeKey = getAttackHitOutcomeKey(target);
    const linkIndex = Number(target.closest("[data-attack-hit-outcome-link-row]")?.dataset.linkIndex ?? -1);
    if (!abilityFunction || trialIndex < 0 || !outcomeKey || linkIndex < 0) {
      return this.#persist({ render: true, sync: false });
    }
    const settings = normalizeAttackActionSettings(abilityFunction.attackSettings);
    const outcome = settings.hitResolution.trials[trialIndex]?.outcomes?.[outcomeKey];
    const [removed] = outcome?.links.splice(linkIndex, 1) ?? [];
    abilityFunction.attackSettings = settings;
    removeUnlinkedAttackOutcomeConstructs(this.ability, [removed?.constructId]);
    return this.#persist({ render: true, sync: false });
  }

  static async #onBrowseAttackSound(event, target) {
    event.preventDefault();
    return browseAttackAudioPath(target, "[data-field='attack.attackSoundPath']");
  }

  static async #onBrowseAttackExplosionSound(event, target) {
    event.preventDefault();
    return browseAttackAudioPath(target, "[data-field='attack.area.explosionSoundPath']");
  }

  static #onDeleteConditionTriggerCost(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const { condition, conditionIndex } = this.#getConditionForTarget(target);
    const conditionRow = target.closest("[data-ability-condition-row]");
    const costRow = target.closest("[data-trigger-cost-row]");
    const costIndex = getRowIndex(conditionRow, "[data-trigger-cost-row]", costRow);
    if (condition?.type !== ABILITY_CONDITION_TYPES.triggerCost || conditionIndex < 0 || costIndex < 0) {
      return this.#persist({ render: true, sync: false });
    }
    const costs = normalizeTriggerCostRows(condition.costs);
    costs.splice(costIndex, 1);
    condition.costs = costs;
    return this.#persist({ render: true, sync: false });
  }

  static #onAddConditionTrackingTarget(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const { condition } = this.#getConditionForTarget(target);
    if (!condition || condition.type !== ABILITY_CONDITION_TYPES.eventReaction) {
      return this.#persist({ render: true, sync: false });
    }
    const values = normalizeConditionValues(condition.trackingTargets)
      .filter(group => ABILITY_EVENT_TRACKING_TARGETS.includes(group));
    const next = ABILITY_EVENT_TRACKING_TARGETS.find(group => !values.includes(group));
    if (next) condition.trackingTargets = [...values, next];
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteConditionTrackingTarget(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const { condition } = this.#getConditionForTarget(target);
    const index = Number(target.closest("[data-event-tracking-target-index]")?.dataset.eventTrackingTargetIndex ?? -1);
    if (!condition || condition.type !== ABILITY_CONDITION_TYPES.eventReaction || index < 0) {
      return this.#persist({ render: true, sync: false });
    }
    const values = normalizeConditionValues(condition.trackingTargets)
      .filter(group => ABILITY_EVENT_TRACKING_TARGETS.includes(group));
    values.splice(index, 1);
    condition.trackingTargets = values;
    return this.#persist({ render: true, sync: false });
  }

  #onConditionEventPathChange(event) {
    event.preventDefault();
    this.#syncFromForm();
    const { condition } = this.#getConditionForTarget(event.currentTarget);
    if (!condition || condition.type !== ABILITY_CONDITION_TYPES.eventReaction) {
      return this.#persist({ render: true, sync: false });
    }
    const pathPrefix = String(event.currentTarget?.value ?? "").trim();
    const nextKey = resolveCatalogEventKeyForPath(pathPrefix, condition.eventKey);
    condition.eventKey = nextKey;
    return this.#persist({ render: true, sync: false });
  }

  static #onAddConditionEventSkill(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const { condition } = this.#getConditionForTarget(target);
    if (!condition || condition.type !== ABILITY_CONDITION_TYPES.eventReaction) {
      return this.#persist({ render: true, sync: false });
    }
    if (!getEventReactionDepthProfile(condition.eventKey).skillKeys) {
      return this.#persist({ render: true, sync: false });
    }
    const values = normalizeEventReactionSkillKeys(condition.skillKeys);
    const next = getFirstUnusedEventReactionSkillKey(values);
    if (next) condition.skillKeys = [...values, next];
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteConditionEventSkill(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const { condition } = this.#getConditionForTarget(target);
    const index = Number(target.closest("[data-event-skill-index]")?.dataset.eventSkillIndex ?? -1);
    if (!condition || condition.type !== ABILITY_CONDITION_TYPES.eventReaction || index < 0) {
      return this.#persist({ render: true, sync: false });
    }
    const values = normalizeEventReactionSkillKeys(condition.skillKeys);
    values.splice(index, 1);
    condition.skillKeys = values;
    return this.#persist({ render: true, sync: false });
  }

  static #onAddConditionEventExpectedResult(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const { condition } = this.#getConditionForTarget(target);
    if (!condition || condition.type !== ABILITY_CONDITION_TYPES.eventReaction) {
      return this.#persist({ render: true, sync: false });
    }
    if (!getEventReactionDepthProfile(condition.eventKey).expectedResultKeys) {
      return this.#persist({ render: true, sync: false });
    }
    const values = normalizeEventReactionExpectedResultKeys(condition.expectedResultKeys);
    const next = EVENT_REACTION_EXPECTED_RESULT_KEYS.find(key => !values.includes(key));
    if (next) condition.expectedResultKeys = [...values, next];
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteConditionEventExpectedResult(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const { condition } = this.#getConditionForTarget(target);
    const index = Number(target.closest("[data-event-expected-result-index]")?.dataset.eventExpectedResultIndex ?? -1);
    if (!condition || condition.type !== ABILITY_CONDITION_TYPES.eventReaction || index < 0) {
      return this.#persist({ render: true, sync: false });
    }
    const values = normalizeEventReactionExpectedResultKeys(condition.expectedResultKeys);
    values.splice(index, 1);
    condition.expectedResultKeys = values;
    return this.#persist({ render: true, sync: false });
  }

  static #onAddConditionEventDepthFilter(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const { condition } = this.#getConditionForTarget(target);
    if (!condition || condition.type !== ABILITY_CONDITION_TYPES.eventReaction) {
      return this.#persist({ render: true, sync: false });
    }
    const storageKey = String(target?.dataset.eventDepthStorageKey ?? "").trim();
    const next = getFirstUnusedEventReactionDepthFilterValue(condition, condition.eventKey, storageKey);
    if (next) {
      const values = getEventReactionDepthFilterValues(condition, storageKey);
      setEventReactionDepthFilterValues(condition, storageKey, [...values, next]);
    }
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteConditionEventDepthFilter(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const { condition } = this.#getConditionForTarget(target);
    const row = target.closest("[data-event-depth-filter-index]");
    const index = Number(row?.dataset.eventDepthFilterIndex ?? -1);
    const storageKey = String(row?.dataset.eventDepthStorageKey ?? "").trim();
    if (!condition || condition.type !== ABILITY_CONDITION_TYPES.eventReaction || !storageKey || index < 0) {
      return this.#persist({ render: true, sync: false });
    }
    const values = getEventReactionDepthFilterValues(condition, storageKey);
    values.splice(index, 1);
    setEventReactionDepthFilterValues(condition, storageKey, values);
    return this.#persist({ render: true, sync: false });
  }

  static #onAddConditionItemCategory(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const { condition } = this.#getConditionForTarget(target);
    if (!condition) return this.#persist({ render: true, sync: false });

    const categories = normalizeItemUseCategoryValues(condition.itemCategories);
    const nextCategory = getFirstUnusedItemUseCategory(categories);
    if (nextCategory) condition.itemCategories = [...categories, nextCategory];
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteConditionItemCategory(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const { condition } = this.#getConditionForTarget(target);
    const categoryIndex = Number(target.closest("[data-item-use-category-index]")?.dataset.itemUseCategoryIndex ?? -1);
    if (!condition || categoryIndex < 0) return this.#persist({ render: true, sync: false });

    const categories = normalizeItemUseCategoryValues(condition.itemCategories);
    categories.splice(categoryIndex, 1);
    condition.itemCategories = categories;
    return this.#persist({ render: true, sync: false });
  }

  static #onAddConditionTargetFaction(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const { condition } = this.#getConditionForTarget(target);
    if (!condition) return this.#persist({ render: true, sync: false });
    const values = normalizeConditionValues(condition.targetFactionNames);
    const next = getFirstUnusedTargetFaction(values);
    if (next) condition.targetFactionNames = [...values, next];
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteConditionTargetFaction(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const { condition } = this.#getConditionForTarget(target);
    const index = Number(target.closest("[data-target-faction-index]")?.dataset.targetFactionIndex ?? -1);
    if (condition && index >= 0) {
      const values = normalizeConditionValues(condition.targetFactionNames);
      values.splice(index, 1);
      condition.targetFactionNames = values;
    }
    return this.#persist({ render: true, sync: false });
  }

  static #onAddConditionPosture(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const { condition } = this.#getConditionForTarget(target);
    if (!condition) return this.#persist({ render: true, sync: false });
    const values = normalizeConditionValues(condition.postureActions);
    const next = ABILITY_POSTURE_ACTIONS.find(action => !values.includes(action));
    if (next) condition.postureActions = [...values, next];
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteConditionPosture(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const { condition } = this.#getConditionForTarget(target);
    const index = Number(target.closest("[data-posture-index]")?.dataset.postureIndex ?? -1);
    if (condition && index >= 0) {
      const values = normalizeConditionValues(condition.postureActions);
      values.splice(index, 1);
      condition.postureActions = values;
    }
    return this.#persist({ render: true, sync: false });
  }

  static #onAddConditionCover(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const { condition } = this.#getConditionForTarget(target);
    if (!condition) return this.#persist({ render: true, sync: false });
    const values = normalizeConditionValues(condition.coverKeys);
    const next = getFirstUnusedCoverKey(values);
    if (next) condition.coverKeys = [...values, next];
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteConditionCover(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const { condition } = this.#getConditionForTarget(target);
    const index = Number(target.closest("[data-cover-index]")?.dataset.coverIndex ?? -1);
    if (condition && index >= 0) {
      const values = normalizeConditionValues(condition.coverKeys);
      values.splice(index, 1);
      condition.coverKeys = values;
    }
    return this.#persist({ render: true, sync: false });
  }

  static #onAddConditionRegionDamageType(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const { condition } = this.#getConditionForTarget(target);
    if (!condition) return this.#persist({ render: true, sync: false });
    const values = normalizeConditionValues(condition.damageTypeKeys);
    const next = getFirstUnusedRegionDamageTypeKey(values);
    if (next) condition.damageTypeKeys = [...values, next];
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteConditionRegionDamageType(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const { condition } = this.#getConditionForTarget(target);
    const index = Number(target.closest("[data-region-damage-type-index]")?.dataset.regionDamageTypeIndex ?? -1);
    if (condition && index >= 0) {
      const values = normalizeConditionValues(condition.damageTypeKeys);
      values.splice(index, 1);
      condition.damageTypeKeys = values;
    }
    return this.#persist({ render: true, sync: false });
  }

  static #onAddConditionRegionSpecialProperty(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const { condition } = this.#getConditionForTarget(target);
    if (!condition) return this.#persist({ render: true, sync: false });
    const values = normalizeConditionValues(condition.regionSpecialPropertyTypes);
    const next = getFirstUnusedRegionSpecialPropertyType(values);
    if (next) condition.regionSpecialPropertyTypes = [...values, next];
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteConditionRegionSpecialProperty(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const { condition } = this.#getConditionForTarget(target);
    const index = Number(target.closest("[data-region-special-property-index]")?.dataset.regionSpecialPropertyIndex ?? -1);
    if (condition && index >= 0) {
      const values = normalizeConditionValues(condition.regionSpecialPropertyTypes);
      values.splice(index, 1);
      condition.regionSpecialPropertyTypes = values;
    }
    return this.#persist({ render: true, sync: false });
  }

  static #onAddConditionWeaponAction(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const { condition } = this.#getConditionForTarget(target);
    if (!condition) return this.#persist({ render: true, sync: false });
    const values = normalizeConditionValues(condition.weaponActionKeys);
    const next = getFirstUnusedWeaponActionKey(values);
    if (next) condition.weaponActionKeys = [...values, next];
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteConditionWeaponAction(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const { condition } = this.#getConditionForTarget(target);
    const index = Number(target.closest("[data-weapon-action-index]")?.dataset.weaponActionIndex ?? -1);
    if (condition && index >= 0) {
      const values = normalizeConditionValues(condition.weaponActionKeys);
      values.splice(index, 1);
      condition.weaponActionKeys = values;
    }
    return this.#persist({ render: true, sync: false });
  }

  static #onAddConditionWeaponSkill(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const { condition } = this.#getConditionForTarget(target);
    if (!condition) return this.#persist({ render: true, sync: false });
    const values = normalizeConditionValues(condition.skillKeys);
    const next = getFirstUnusedSkillKey(values);
    if (next) condition.skillKeys = [...values, next];
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteConditionWeaponSkill(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const { condition } = this.#getConditionForTarget(target);
    const index = Number(target.closest("[data-skill-index]")?.dataset.skillIndex ?? -1);
    if (condition && index >= 0) {
      const values = normalizeConditionValues(condition.skillKeys);
      values.splice(index, 1);
      condition.skillKeys = values;
    }
    return this.#persist({ render: true, sync: false });
  }

  static #onAddConditionWeaponProficiency(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const { condition } = this.#getConditionForTarget(target);
    if (!condition) return this.#persist({ render: true, sync: false });
    const values = normalizeConditionValues(condition.proficiencyKeys);
    const next = getFirstUnusedProficiencyKey(values);
    if (next) condition.proficiencyKeys = [...values, next];
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteConditionWeaponProficiency(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const { condition } = this.#getConditionForTarget(target);
    const index = Number(target.closest("[data-proficiency-index]")?.dataset.proficiencyIndex ?? -1);
    if (condition && index >= 0) {
      const values = normalizeConditionValues(condition.proficiencyKeys);
      values.splice(index, 1);
      condition.proficiencyKeys = values;
    }
    return this.#persist({ render: true, sync: false });
  }

  static #onAddConditionAuraTargetGroup(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const { condition } = this.#getConditionForTarget(target);
    if (!condition) return this.#persist({ render: true, sync: false });
    const values = normalizeConditionValues(condition.auraTargetGroups).filter(group => ABILITY_AURA_TARGET_GROUPS.includes(group));
    const next = ABILITY_AURA_TARGET_GROUPS.find(group => !values.includes(group));
    if (next) condition.auraTargetGroups = [...values, next];
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteConditionAuraTargetGroup(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const { condition } = this.#getConditionForTarget(target);
    const index = Number(target.closest("[data-aura-target-group-index]")?.dataset.auraTargetGroupIndex ?? -1);
    if (condition && index >= 0) {
      const values = normalizeConditionValues(condition.auraTargetGroups).filter(group => ABILITY_AURA_TARGET_GROUPS.includes(group));
      values.splice(index, 1);
      condition.auraTargetGroups = values;
    }
    return this.#persist({ render: true, sync: false });
  }

  #getConditionForTarget(target) {
    const functionRow = target.closest("[data-ability-function-row]");
    const conditionRow = target.closest("[data-ability-condition-row]");
    const functionIndex = getRowIndex(this.form, "[data-ability-function-row]", functionRow);
    const conditionIndex = getRowIndex(functionRow, "[data-ability-condition-row]", conditionRow);
    return {
      functionIndex,
      conditionIndex,
      condition: this.ability.system.functions?.[functionIndex]?.conditions?.[conditionIndex]
    };
  }

  static #onAddFunctionPenalty(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const functionIndex = getRowIndex(this.form, "[data-ability-function-row]", target.closest("[data-ability-function-row]"));
    const entry = this.ability.system.functions[functionIndex];
    if (entry?.type === ABILITY_FUNCTION_TYPES.fixed) return this.#persist({ render: true, sync: false });
    if (entry?.conditions?.some(condition => condition?.type === ABILITY_CONDITION_TYPES.eventReaction)) {
      return this.#persist({ render: true, sync: false });
    }
    if (entry?.conditions?.some(condition => isRuntimeCondition(condition?.type))) entry.penalties.push(createAbilityChange());
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteFunctionPenalty(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const functionRow = target.closest("[data-ability-function-row]");
    const penaltyIndex = getRowIndex(functionRow, "[data-ability-penalty-row]", target.closest("[data-ability-penalty-row]"));
    const functionIndex = getRowIndex(this.form, "[data-ability-function-row]", functionRow);
    if (functionIndex >= 0 && penaltyIndex >= 0) this.ability.system.functions[functionIndex]?.penalties?.splice(penaltyIndex, 1);
    return this.#persist({ render: true, sync: false });
  }

  static #onAddAcquisitionRequirement(event) {
    event.preventDefault();
    this.#syncFromForm();
    this.ability.system.acquisitionRequirements ??= [];
    this.ability.system.acquisitionRequirements.push(createAbilityAcquisitionCondition(""));
    this.#activeTab = "details";
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteAcquisitionRequirement(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const index = getRowIndex(this.form, "[data-acquisition-requirement-row]", target.closest("[data-acquisition-requirement-row]"));
    if (index >= 0) this.ability.system.acquisitionRequirements?.splice(index, 1);
    this.#activeTab = "details";
    return this.#persist({ render: true, sync: false });
  }

  static async #onOpenAcquisitionAbilityPicker(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const row = target.closest("[data-acquisition-requirement-row]");
    const index = getRowIndex(this.form, "[data-acquisition-requirement-row]", row);
    const requirement = index >= 0 ? this.ability.system.acquisitionRequirements?.[index] : null;
    if (!requirement || requirement.type !== ABILITY_ACQUISITION_CONDITION_TYPES.ability) return;

    const selected = await pickCatalogAbilities({
      selectedIds: requirement.abilityIds ?? [],
      excludeIds: [this.abilityId],
      title: "Выбор способностей"
    });
    if (!selected) return;

    requirement.abilityIds = selected;
    this.#activeTab = "details";
    return this.#persist({ render: true, sync: false });
  }

  static #onRemoveAcquisitionRequirementAbility(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const row = target.closest("[data-acquisition-requirement-row]");
    const index = getRowIndex(this.form, "[data-acquisition-requirement-row]", row);
    const requirement = index >= 0 ? this.ability.system.acquisitionRequirements?.[index] : null;
    if (!requirement) return;
    const abilityId = String(target.closest("[data-acquisition-requirement-ability-id]")?.dataset?.acquisitionRequirementAbilityId ?? "").trim();
    if (!abilityId) return;
    requirement.abilityIds = (requirement.abilityIds ?? []).filter(id => id !== abilityId);
    this.#activeTab = "details";
    return this.#persist({ render: true, sync: false });
  }

  #activateAcquisitionAbilityDropzones() {
    const dropzones = this.element?.querySelectorAll?.("[data-acquisition-ability-dropzone]") ?? [];
    for (const dropzone of dropzones) {
      dropzone.addEventListener("dragover", event => {
        event.preventDefault();
        dropzone.classList.add("drag-over");
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      });
      dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag-over"));
      dropzone.addEventListener("drop", event => void this.#onAcquisitionAbilityDrop(event, dropzone));
    }
  }

  async #onAcquisitionAbilityDrop(event, dropzone) {
    event.preventDefault();
    dropzone.classList.remove("drag-over");
    this.#syncFromForm();
    const row = dropzone.closest("[data-acquisition-requirement-row]");
    const index = getRowIndex(this.form, "[data-acquisition-requirement-row]", row);
    const requirement = index >= 0 ? this.ability.system.acquisitionRequirements?.[index] : null;
    if (!requirement || requirement.type !== ABILITY_ACQUISITION_CONDITION_TYPES.ability) return;

    const sourceId = await resolveDroppedAbilitySourceId(event);
    if (!sourceId) {
      ui.notifications.warn("Перетащите сюда способность из каталога.");
      return;
    }
    if (sourceId === this.abilityId) {
      ui.notifications.warn("Нельзя добавить эту же способность в её собственные условия.");
      return;
    }
    if (!findCatalogAbility(sourceId)) {
      ui.notifications.warn("Способность не найдена в каталоге.");
      return;
    }

    const abilityIds = [...(requirement.abilityIds ?? [])];
    if (abilityIds.includes(sourceId)) {
      ui.notifications.warn("Эта способность уже добавлена.");
      return;
    }
    abilityIds.push(sourceId);
    requirement.abilityIds = abilityIds;
    this.#activeTab = "details";
    return this.#persist({ render: true, sync: false });
  }

  #persist({ render = false, sync = true } = {}) {
    if (sync) this.#syncFromForm();
    if (render) return this.render();
    return this.ability;
  }

  #syncFromForm() {
    if (!this.form) return;
    const acquisition = this.ability.system?.acquisition ?? {};
    const onlyFreeInput = this.form.querySelector("[data-field='onlyFree']");
    const onlyManualInput = this.form.querySelector("[data-field='onlyManual']");
    const researchSkillInput = this.form.querySelector("[data-field='researchSkillKey']");
    const researchDifficultyInput = this.form.querySelector("[data-field='researchDifficulty']");
    const acquisitionRequirementsRoot = this.form.querySelector("[data-acquisition-requirements]");
    const onlyFree = onlyFreeInput ? Boolean(onlyFreeInput.checked) : Boolean(acquisition.onlyFree);
    this.ability = normalizeAbilityEntry({
      ...this.ability,
      name: this.form.querySelector("[data-field='name']")?.value ?? this.ability.name,
      img: this.form.querySelector("[data-field='img']")?.value ?? this.ability.img,
      description: readFieldValue(this.form.querySelector("[data-field='description']"), this.ability.description),
      system: {
        ...(this.ability.system ?? {}),
        category: this.form.querySelector("[data-field='category']")?.value ?? this.ability.system?.category,
        acquisition: {
          onlyFree,
          onlyManual: onlyFree ? false : (onlyManualInput ? Boolean(onlyManualInput.checked) : Boolean(acquisition.onlyManual)),
          skillKey: researchSkillInput?.value ?? acquisition.skillKey,
          difficulty: researchDifficultyInput?.value ?? acquisition.difficulty
        },
        cost: this.#isFeature ? 0 : this.form.querySelector("[data-field='cost']")?.value ?? this.ability.system?.cost,
        acquisitionRequirements: acquisitionRequirementsRoot ? readAcquisitionRequirements(acquisitionRequirementsRoot) : this.ability.system?.acquisitionRequirements,
        functions: this.#activeTab === "functions"
          ? readAbilityFunctions(this.form, this.ability.system?.functions)
          : this.ability.system?.functions,
        constructs: this.#activeTab === "functions"
          ? readAbilityConstructs(this.form)
          : this.ability.system?.constructs
      }
    });
  }
}

function readAbilityFunctions(root, previousValue = []) {
  const previousFunctions = Array.isArray(previousValue) ? previousValue : Object.values(previousValue ?? {});
  return Array.from(root.querySelectorAll("[data-ability-function-row]") ?? []).map((row, index) => {
    const id = row.dataset.functionId || foundry.utils.randomID();
    const indexedFunction = previousFunctions[index];
    const previousFunction = previousFunctions.find(entry => String(entry?.id ?? "") === id)
      ?? (indexedFunction?.type === row.dataset.functionType ? indexedFunction : null);
    const type = previousFunction?.type === ABILITY_FUNCTION_TYPES.attackAction
      ? ABILITY_FUNCTION_TYPES.attackAction
      : row.dataset.functionType;
    return {
      id,
      type,
      includeInPureValues: Boolean(row.querySelector("[data-advancement-pure-values-input]")?.checked),
      fixedKey: row.querySelector("[data-field='fixedKey']")?.value ?? "",
      fixedSettings: readFixedFunctionSettings(row),
      activeSettings: readActiveApplicationSettings(row, previousFunction?.activeSettings),
      attackSettings: readAttackActionSettings(row, previousFunction?.attackSettings, type),
      reactionSettings: { durationSeconds: 0, costs: [] },
      changes: readAbilityChanges(row.querySelector("[data-ability-changes]"), "[data-ability-change-row]"),
      actions: readAbilityActions(row),
      conditions: readAbilityConditions(row.querySelector("[data-ability-conditions]")),
      penalties: readAbilityChanges(row.querySelector("[data-ability-penalties]"), "[data-ability-penalty-row]")
    };
  });
}

function readAbilityActions(row) {
  return Array.from(row.querySelectorAll("[data-ability-action-row]") ?? [])
    .sort((left, right) => (
      Number(left.dataset.actionIndex ?? 0) - Number(right.dataset.actionIndex ?? 0)
    ))
    .map(actionRow => ({
        id: actionRow.dataset.actionId || foundry.utils.randomID(),
        type: actionRow.querySelector("[data-field='action.type']")?.value ?? "",
        attackActionKeys: readFieldValues(actionRow, "[data-field='action.attackActionKey']"),
        executorMode: actionRow.querySelector("[data-field='action.executorMode']")?.value,
        targetMode: actionRow.querySelector("[data-field='action.targetMode']")?.value,
        actionPointCostMode: actionRow.querySelector("[data-field='action.actionPointCostMode']")?.value,
        actionPointPayer: actionRow.querySelector("[data-field='action.actionPointPayer']")?.value,
        fixedActionPointCost: actionRow.querySelector("[data-field='action.fixedActionPointCost']")?.value,
        actualActionPointCostPercent: actionRow.querySelector("[data-field='action.actualActionPointCostPercent']")?.value,
        routeBudgetMode: actionRow.querySelector("[data-field='action.routeBudgetMode']")?.value,
        routeBudgetFormula: actionRow.querySelector("[data-field='action.routeBudgetFormula']")?.value,
        routeBudgetEvaluation: actionRow.querySelector("[data-field='action.routeBudgetEvaluation']")?.value,
        routeExecutionMode: actionRow.querySelector("[data-field='action.routeExecutionMode']")?.value,
        routeMovementAction: actionRow.querySelector("[data-field='action.routeMovementAction']")?.value,
        routeAutoRotate: actionRow.querySelector("[data-field='action.routeAutoRotate']")?.checked,
        routeShowRuler: actionRow.querySelector("[data-field='action.routeShowRuler']")?.checked,
        skillKey: actionRow.querySelector("[data-field='action.skillKey']")?.value,
        skillDifficultyFormula: actionRow.querySelector("[data-field='action.skillDifficultyFormula']")?.value,
        skillAdvantageCount: actionRow.querySelector("[data-field='action.skillAdvantageCount']")?.value,
        skillDisadvantageCount: actionRow.querySelector("[data-field='action.skillDisadvantageCount']")?.value,
        skillSuccessControl: actionRow.querySelector("[data-field='action.skillSuccessControl']")?.value,
        skillFailureControl: actionRow.querySelector("[data-field='action.skillFailureControl']")?.value,
        treatmentClassShift: {
          itemTypes: readCheckedFieldValues(actionRow, "[data-field='action.treatmentClassItemType']"),
          steps: actionRow.querySelector("[data-field='action.treatmentClassSteps']")?.value
        }
      }));
}

function readActiveApplicationSettings(row, previousValue = {}) {
  if (row?.dataset?.functionType !== ABILITY_FUNCTION_TYPES.activeApplication) return {};
  const targetSelectionModeInput = row.querySelector("[data-field='active.targetSelectionMode']");
  const targetLimitInput = row.querySelector("[data-field='active.targetLimit']");
  const targetGroupInputs = Array.from(row.querySelectorAll("[data-field='active.targetGroup']") ?? []);
  const excludeSelfInput = row.querySelector("[data-field='active.excludeSelf']");
  const radiusFormulaInput = row.querySelector("[data-field='active.radiusFormula']");
  const wallsBlockInput = row.querySelector("[data-field='active.wallsBlock']");
  const persistentInput = row.querySelector("[data-field='active.persistent']");
  const changeEvaluationInput = row.querySelector("[data-field='active.changeEvaluation']");
  const settings = {
    name: row.querySelector("[data-field='active.name']")?.value ?? "",
    costs: readActiveApplicationCostRows(row),
    targetMode: row.querySelector("[data-field='active.targetMode']")?.value
  };
  if (targetSelectionModeInput) settings.targetSelectionMode = targetSelectionModeInput.value;
  if (targetLimitInput) settings.targetLimit = targetLimitInput.value;
  if (targetGroupInputs.length) {
    settings.targetGroups = targetGroupInputs
      .filter(input => input.checked)
      .map(input => String(input.value ?? "").trim())
      .filter(Boolean);
  }
  if (excludeSelfInput) settings.excludeSelf = Boolean(excludeSelfInput.checked);
  if (radiusFormulaInput) settings.radiusFormula = radiusFormulaInput.value;
  if (wallsBlockInput) settings.wallsBlock = Boolean(wallsBlockInput.checked);
  if (persistentInput) settings.persistent = Boolean(persistentInput.checked);
  if (changeEvaluationInput) settings.changeEvaluation = changeEvaluationInput.value;
  return preserveMissingActiveApplicationTargetSettings(settings, previousValue);
}

function readActiveApplicationCostRows(row) {
  return Array.from(row?.querySelectorAll("[data-active-application-cost-row]") ?? [])
    .map(costRow => ({
      ...readTriggerCostRow(costRow),
      payer: costRow.querySelector("[data-field='active.costPayer']")?.value
        ?? ABILITY_ACTIVE_APPLICATION_COST_PAYERS.source
    }));
}

function readAttackActionSettings(row, previousValue = {}, functionType = row?.dataset?.functionType) {
  if (functionType !== ABILITY_FUNCTION_TYPES.attackAction) return {};
  const previous = normalizeAttackActionSettings(previousValue);
  const getValue = (field, fallback = "") => (
    row.querySelector(`[data-field='${field}']`)?.value ?? fallback
  );
  const getChecked = (field, fallback = false) => {
    const input = row.querySelector(`[data-field='${field}']`);
    return input ? Boolean(input.checked) : Boolean(fallback);
  };
  const hasConeSettings = Boolean(row.querySelector("[data-attack-cone-settings]"));
  const hasTargetSettings = Boolean(row.querySelector("[data-attack-target-settings]"));
  const hasAreaSettings = Boolean(row.querySelector("[data-attack-area-settings]"));
  const damageTypes = readAttackDamageTypeRows(row);
  const resourceCosts = readAttackResourceCostRows(row);
  const specialProperties = readAttackSpecialPropertyRows(row, previous.specialProperties);
  const requirements = readAttackRequirementRows(row);
  const criticalFailureConsequences = row.querySelector("[data-attack-critical-failure-row]")
    ? readAttackCriticalFailureRows(row)
    : previous.criticalFailureConsequences;
  const next = {
    ...previous,
    name: getValue("attack.name", previous.name),
    damage: getValue("attack.damage", previous.damage),
    pellets: getValue("attack.pellets", previous.pellets),
    damageTypeKey: damageTypes.at(0)?.key
      ?? getValue("attack.damageTypeKey", previous.damageTypeKey),
    damageTypes,
    attackAnimationKey: getValue("attack.attackAnimationKey", previous.attackAnimationKey),
    attackSoundPath: getValue("attack.attackSoundPath", previous.attackSoundPath),
    attackSoundVolume: getValue("attack.attackSoundVolume", previous.attackSoundVolume),
    attackAnimationDelayMs: getValue("attack.attackAnimationDelayMs", previous.attackAnimationDelayMs),
    proficiencyKey: getValue("attack.proficiencyKey", previous.proficiencyKey),
    skillKey: getValue("attack.skillKey", previous.skillKey),
    accuracyBonus: getValue("attack.accuracyBonus", previous.accuracyBonus),
    criticalChanceModifier: getValue("attack.criticalChanceModifier", previous.criticalChanceModifier),
    maxRangeMeters: getValue("attack.maxRangeMeters", previous.maxRangeMeters),
    effectiveRange: {
      value: getValue("attack.effectiveRange.value", previous.effectiveRange.value),
      max: getValue("attack.effectiveRange.max", previous.effectiveRange.max)
    },
    penetration: getValue("attack.penetration", previous.penetration),
    noiseLevel: getValue("attack.noiseLevel", previous.noiseLevel),
    targeting: {
      ...previous.targeting,
      mode: getValue("attack.targeting.mode", previous.targeting.mode),
      targetLimitFormula: getValue(
        "attack.targeting.targetLimitFormula",
        previous.targeting.targetLimitFormula
      ),
      aimed: hasTargetSettings
        ? getChecked("attack.targeting.aimed", previous.targeting.aimed)
        : previous.targeting.aimed,
      allowRepeatedTargets: hasTargetSettings
        ? getChecked("attack.targeting.allowRepeatedTargets", previous.targeting.allowRepeatedTargets)
        : previous.targeting.allowRepeatedTargets,
      attackConeDegrees: hasConeSettings
        ? getValue("attack.targeting.attackConeDegrees", previous.targeting.attackConeDegrees)
        : previous.targeting.attackConeDegrees,
      directions: {
        thrust: hasConeSettings
          ? readAttackDirectionSettings(row, "thrust", previous.targeting.directions.thrust)
          : previous.targeting.directions.thrust,
        swing: hasConeSettings
          ? readAttackDirectionSettings(row, "swing", previous.targeting.directions.swing)
          : previous.targeting.directions.swing
      }
    },
    sequence: {
      count: getValue("attack.sequence.count", previous.sequence.count),
      difficultyPerAttack: getValue("attack.sequence.difficultyPerAttack", previous.sequence.difficultyPerAttack)
    },
    area: hasAreaSettings ? {
      ...previous.area,
      damageRadius: getValue("attack.area.damageRadius", previous.area.damageRadius),
      regionRadius: getValue("attack.area.regionRadius", previous.area.regionRadius),
      regionDamageEntries: readAttackRegionDamageRows(row),
      regionSpecialProperties: readAttackRegionSpecialProperties(row, previous.area.regionSpecialProperties),
      regionDurationSeconds: getValue("attack.area.regionDurationSeconds", previous.area.regionDurationSeconds),
      regionDelaySeconds: getValue("attack.area.regionDelaySeconds", previous.area.regionDelaySeconds),
      regionRadiusDeltaMeters: getValue("attack.area.regionRadiusDeltaMeters", previous.area.regionRadiusDeltaMeters),
      explosionAnimationKey: getValue("attack.area.explosionAnimationKey", previous.area.explosionAnimationKey),
      explosionSoundPath: getValue("attack.area.explosionSoundPath", previous.area.explosionSoundPath)
    } : previous.area,
    resourceCosts,
    specialProperties,
    requirements,
    hitResolution: readAttackHitResolution(row),
    criticalFailureConsequences
  };
  reconcileWeaponResourceCostReferences(next, previous.resourceCosts, {
    defaultType: "actorResource"
  });
  return normalizeAttackActionSettings(next);
}

function readAttackDirectionSettings(row, key, previous = {}) {
  const prefix = `attack.targeting.directions.${key}`;
  return {
    enabled: Boolean(row.querySelector(`[data-field='${prefix}.enabled']`)?.checked),
    accuracyModifier: row.querySelector(`[data-field='${prefix}.accuracyModifier']`)?.value
      ?? previous.accuracyModifier,
    criticalChanceModifier: row.querySelector(`[data-field='${prefix}.criticalChanceModifier']`)?.value
      ?? previous.criticalChanceModifier,
    damagePercentModifier: row.querySelector(`[data-field='${prefix}.damagePercentModifier']`)?.value
      ?? previous.damagePercentModifier
  };
}

function readAttackDamageTypeRows(row) {
  return Array.from(row?.querySelectorAll("[data-attack-damage-type-row]") ?? []).map(typeRow => ({
    key: String(typeRow.querySelector("[data-field='attack.damageType.key']")?.value ?? "").trim(),
    percent: typeRow.querySelector("[data-field='attack.damageType.percent']")?.value ?? 0
  })).filter(entry => entry.key);
}

function readAttackRegionDamageRows(row) {
  return Array.from(row?.querySelectorAll("[data-attack-region-damage-row]") ?? []).map(damageRow => ({
    damageTypeKey: String(damageRow.querySelector("[data-field='attack.area.regionDamage.damageTypeKey']")?.value ?? "").trim(),
    amount: damageRow.querySelector("[data-field='attack.area.regionDamage.amount']")?.value ?? "0"
  })).filter(entry => entry.damageTypeKey);
}

function readAttackRegionSpecialProperties(row, previous = []) {
  const specialRow = row?.querySelector("[data-attack-region-special-property-row]");
  if (!specialRow) return normalizeRegionSpecialProperties(previous);
  const type = specialRow.querySelector("[data-field='attack.area.regionSpecialProperty.type']")?.value
    ?? REGION_SPECIAL_PROPERTY_PENDING;
  return [createDefaultRegionSpecialPropertyData(type, {
    smoke: {
      thickness: specialRow.querySelector("[data-field='attack.area.regionSpecialProperty.thickness']")?.value ?? "1",
      densityPercent: specialRow.querySelector("[data-field='attack.area.regionSpecialProperty.densityPercent']")?.value ?? "50"
    }
  })];
}

function readAttackResourceCostRows(row) {
  return Array.from(row?.querySelectorAll("[data-attack-resource-cost-row]") ?? []).map(costRow => ({
    id: costRow.dataset.costId || foundry.utils.randomID(),
    resourceKey: String(costRow.querySelector("[data-field='attack.resourceCost.resourceKey']")?.value ?? "").trim(),
    formula: costRow.querySelector("[data-field='attack.resourceCost.formula']")?.value ?? "0",
    overloadAmount: costRow.querySelector("[data-field='attack.resourceCost.overloadAmount']")?.value ?? 0,
    overloadDurationSeconds: durationPartsToSeconds(
      costRow.querySelector("[data-field='attack.resourceCost.overloadDurationAmount']")?.value,
      costRow.querySelector("[data-field='attack.resourceCost.overloadDurationUnit']")?.value
    )
  })).filter(entry => entry.resourceKey);
}

function readAttackHitResolution(row) {
  const trials = Array.from(row?.querySelectorAll("[data-attack-hit-trial-row]") ?? []).map(trialRow => {
    const outcomes = {};
    for (const outcomeRow of trialRow.querySelectorAll("[data-attack-hit-outcome-row]") ?? []) {
      const resultKey = String(outcomeRow.dataset.outcomeKey ?? "");
      if (!ATTACK_HIT_OUTCOME_KEYS.includes(resultKey)) continue;
      outcomes[resultKey] = {
        id: String(outcomeRow.dataset.outcomeId ?? "").trim() || foundry.utils.randomID(),
        flow: outcomeRow.querySelector("[data-field='attack.hitOutcome.flow']")?.value ?? "continue",
        links: Array.from(outcomeRow.querySelectorAll("[data-attack-hit-outcome-link-row]") ?? [])
          .map(linkRow => ({
            id: String(linkRow.dataset.linkId ?? "").trim() || foundry.utils.randomID(),
            constructId: linkRow.querySelector("[data-field='attack.hitOutcome.constructId']")?.value ?? "",
            recipient: linkRow.querySelector("[data-field='attack.hitOutcome.recipient']")?.value
              ?? ABILITY_TRIAL_LINK_RECIPIENTS.subjects,
            mode: linkRow.querySelector("[data-field='attack.hitOutcome.mode']")?.value
              ?? ABILITY_TRIAL_LINK_MODES.perSubject
          }))
      };
    }
    return {
      id: String(trialRow.dataset.trialId ?? "").trim() || foundry.utils.randomID(),
      subject: trialRow.querySelector("[data-field='attack.hitTrial.subject']")?.value ?? "targets",
      sourceMode: trialRow.querySelector("[data-field='attack.hitTrial.sourceMode']")?.value ?? "once",
      entries: Array.from(trialRow.querySelectorAll("[data-attack-hit-trial-entry-row]") ?? [])
        .map(entryRow => ({
          id: String(entryRow.dataset.entryId ?? "").trim() || foundry.utils.randomID(),
          kind: "skill",
          key: entryRow.querySelector("[data-field='attack.hitTrial.entryKey']")?.value ?? ""
        })),
      selectionMode: trialRow.querySelector("[data-field='attack.hitTrial.selectionMode']")?.value ?? "best",
      difficultyFormula: trialRow.querySelector("[data-field='attack.hitTrial.difficultyFormula']")?.value ?? "0",
      outcomes
    };
  });
  return { trials };
}

function readAttackSpecialPropertyRows(row, previousValue = []) {
  const previous = Array.isArray(previousValue) ? previousValue : Object.values(previousValue ?? {});
  return Array.from(row?.querySelectorAll("[data-attack-special-property-row]") ?? []).map((propertyRow, index) => {
    const type = String(propertyRow.querySelector("[data-field='attack.specialProperty.type']")?.value ?? "");
    if (type === WEAPON_SPECIAL_PROPERTIES.criticalDamage) {
      const priorCriticalDamage = normalizeWeaponCriticalDamageData(
        previous[index]?.criticalDamage
      );
      return {
        type,
        criticalDamage: {
          outcomeId: propertyRow.querySelector(
            "[data-field='attack.specialProperty.criticalDamage.outcomeId']"
          )?.value ?? priorCriticalDamage.outcomeId,
          percentFormula: propertyRow.querySelector(
            "[data-field='attack.specialProperty.criticalDamage.percentFormula']"
          )?.value ?? priorCriticalDamage.percentFormula
        }
      };
    }
    if (type === WEAPON_SPECIAL_PROPERTIES.additionalProficiencies) {
      return {
        type,
        proficiencyKeys: normalizeWeaponAdditionalProficiencyKeys(Array.from(
          propertyRow.querySelectorAll("[data-field='attack.specialProperty.additionalProficiency']")
        ).map(select => select.value))
      };
    }
    if (type !== WEAPON_SPECIAL_PROPERTIES.attackPower) {
      return createDefaultWeaponSpecialPropertyData(type);
    }
    const priorPower = normalizeWeaponAttackPowerData(previous[index]?.attackPower);
    const resourceCosts = Array.from(propertyRow.querySelectorAll("[data-attack-power-resource-cost-row]") ?? [])
      .map(costRow => ({
        type: "actorResource",
        resourceKey: String(costRow.dataset.resourceKey ?? "").trim(),
        amount: costRow.querySelector("[data-field='attack.specialProperty.attackPower.resourceCost.amount']")?.value ?? 0
      }))
      .filter(cost => cost.resourceKey);
    const attackPower = normalizeWeaponAttackPowerData({
        level: {
          value: propertyRow.querySelector("[data-field='attack.specialProperty.attackPower.level.value']")?.value
            ?? priorPower.level.value,
          max: propertyRow.querySelector("[data-field='attack.specialProperty.attackPower.level.max']")?.value
            ?? priorPower.level.max
        },
        perLevel: {
          damagePercent: propertyRow.querySelector("[data-field='attack.specialProperty.attackPower.perLevel.damagePercent']")?.value
            ?? priorPower.perLevel.damagePercent,
          accuracyBonus: propertyRow.querySelector("[data-field='attack.specialProperty.attackPower.perLevel.accuracyBonus']")?.value
            ?? priorPower.perLevel.accuracyBonus,
          criticalChanceModifier: propertyRow.querySelector("[data-field='attack.specialProperty.attackPower.perLevel.criticalChanceModifier']")?.value
            ?? priorPower.perLevel.criticalChanceModifier,
          criticalDamagePercent: propertyRow.querySelector("[data-field='attack.specialProperty.attackPower.perLevel.criticalDamagePercent']")?.value
            ?? priorPower.perLevel.criticalDamagePercent,
          attackConeDegrees: propertyRow.querySelector("[data-field='attack.specialProperty.attackPower.perLevel.attackConeDegrees']")?.value
            ?? priorPower.perLevel.attackConeDegrees,
          maxRangeMeters: propertyRow.querySelector("[data-field='attack.specialProperty.attackPower.perLevel.maxRangeMeters']")?.value
            ?? priorPower.perLevel.maxRangeMeters,
          effectiveRange: {
            value: propertyRow.querySelector("[data-field='attack.specialProperty.attackPower.perLevel.effectiveRange.value']")?.value
              ?? priorPower.perLevel.effectiveRange.value,
            max: propertyRow.querySelector("[data-field='attack.specialProperty.attackPower.perLevel.effectiveRange.max']")?.value
              ?? priorPower.perLevel.effectiveRange.max
          },
          penetration: propertyRow.querySelector("[data-field='attack.specialProperty.attackPower.perLevel.penetration']")?.value
            ?? priorPower.perLevel.penetration
        }
      });
    return {
      type,
      attackPower: {
        ...attackPower,
        resourceCosts
      }
    };
  });
}

function readAttackRequirementRows(row) {
  return Array.from(row?.querySelectorAll("[data-attack-requirement-row]") ?? []).map(requirementRow => ({
    type: requirementRow.querySelector("[data-field='attack.requirement.type']")?.value ?? "characteristic",
    key: requirementRow.querySelector("[data-field='attack.requirement.key']")?.value ?? "",
    value: requirementRow.querySelector("[data-field='attack.requirement.value']")?.value ?? 0
  }));
}

function readAttackCriticalFailureRows(row) {
  return Array.from(row?.querySelectorAll("[data-attack-critical-failure-row]") ?? []).map(consequenceRow => ({
    id: consequenceRow.dataset.consequenceId || foundry.utils.randomID(),
    type: "extraResourceCost",
    resourceType: "actorResource",
    resourceKey: String(consequenceRow.querySelector("[data-field='attack.criticalFailure.resourceKey']")?.value ?? "").trim(),
    amount: consequenceRow.querySelector("[data-field='attack.criticalFailure.amount']")?.value ?? 0
  })).filter(entry => entry.resourceKey);
}

function syncFixedRescueCountVisibility(select) {
  const row = select?.closest?.(".fallout-maw-fixed-settings-row");
  const countField = row?.querySelector?.("[data-fixed-rescue-count]");
  if (countField) countField.hidden = String(select.value ?? "all") !== "count";
}

function readFixedFunctionSettings(row) {
  const fixedKey = row.querySelector("[data-field='fixedKey']")?.value ?? "";
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.curseAndBlessing) {
    return {
      energyCost: row.querySelector("[data-field='fixed.curse.energyCost']")?.value,
      triggerFormula: row.querySelector("[data-field='fixed.curse.triggerFormula']")?.value,
      durationSeconds: durationPartsToSeconds(
        row.querySelector("[data-field='fixed.curse.durationAmount']")?.value,
        row.querySelector("[data-field='fixed.curse.durationUnit']")?.value
      )
    };
  }
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.allOrNothing) {
    return {
      energyCost: row.querySelector("[data-field='fixed.allOrNothing.energyCost']")?.value,
      overloadEnergyCost: row.querySelector("[data-field='fixed.allOrNothing.overloadEnergyCost']")?.value,
      overloadDurationSeconds: durationPartsToSeconds(
        row.querySelector("[data-field='fixed.allOrNothing.overloadDurationAmount']")?.value,
        row.querySelector("[data-field='fixed.allOrNothing.overloadDurationUnit']")?.value
      ),
      chanceFormula: row.querySelector("[data-field='fixed.allOrNothing.chanceFormula']")?.value,
      pelletCoveragePercent: row.querySelector("[data-field='fixed.allOrNothing.pelletCoveragePercent']")?.value,
      burstCoveragePercent: row.querySelector("[data-field='fixed.allOrNothing.burstCoveragePercent']")?.value
    };
  }
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.reaper) {
    return {
      killChanceFormula: row.querySelector("[data-field='fixed.reaper.killChanceFormula']")?.value,
      attackChanceFormula: row.querySelector("[data-field='fixed.reaper.attackChanceFormula']")?.value
    };
  }
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.virtuoso) {
    return {
      accuracyBonus: row.querySelector("[data-field='fixed.virtuoso.accuracyBonus']")?.value,
      damagePercentBonus: row.querySelector("[data-field='fixed.virtuoso.damagePercentBonus']")?.value
    };
  }
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.versatileDevelopment) {
    return {
      minimumPureValueGapPercent: row.querySelector("[data-field='fixed.versatileDevelopment.minimumPureValueGapPercent']")?.value,
      developmentMultiplierBonus: row.querySelector("[data-field='fixed.versatileDevelopment.developmentMultiplierBonus']")?.value
    };
  }
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.aiming) {
    return {
      energyCost: row.querySelector("[data-field='fixed.aiming.energyCost']")?.value,
      innateDifficultyIgnorePercent: row.querySelector("[data-field='fixed.aiming.innateDifficultyIgnorePercent']")?.value
    };
  }
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.ricochet) {
    return {
      activationEnergyCost: row.querySelector("[data-field='fixed.ricochet.activationEnergyCost']")?.value,
      overloadEnergyCost: row.querySelector("[data-field='fixed.ricochet.overloadEnergyCost']")?.value,
      overloadDurationSeconds: row.querySelector("[data-field='fixed.ricochet.overloadDurationSeconds']")?.value,
      maxReflections: row.querySelector("[data-field='fixed.ricochet.maxReflections']")?.value,
      accuracyBonusPerReflection: row.querySelector("[data-field='fixed.ricochet.accuracyBonusPerReflection']")?.value,
      damagePercentBonusPerReflection: row.querySelector("[data-field='fixed.ricochet.damagePercentBonusPerReflection']")?.value
    };
  }
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.keepAway) {
    return {
      activationEnergyCost: row.querySelector("[data-field='fixed.keepAway.activationEnergyCost']")?.value,
      overloadEnergyCost: row.querySelector("[data-field='fixed.keepAway.overloadEnergyCost']")?.value,
      overloadDurationSeconds: row.querySelector("[data-field='fixed.keepAway.overloadDurationSeconds']")?.value,
      baseDifficulty: row.querySelector("[data-field='fixed.keepAway.baseDifficulty']")?.value,
      lostHealthPercentMultiplier: row.querySelector("[data-field='fixed.keepAway.lostHealthPercentMultiplier']")?.value
    };
  }
  if ([ABILITY_FIXED_FUNCTION_KEYS.lethalShot, ABILITY_FIXED_FUNCTION_KEYS.lethalStrike].includes(fixedKey)) {
    return {
      activationEnergyCost: row.querySelector("[data-field='fixed.lethalAttack.activationEnergyCost']")?.value,
      overloadEnergyCost: row.querySelector("[data-field='fixed.lethalAttack.overloadEnergyCost']")?.value,
      overloadDurationSeconds: row.querySelector("[data-field='fixed.lethalAttack.overloadDurationSeconds']")?.value,
      damagePercentBonus: row.querySelector("[data-field='fixed.lethalAttack.damagePercentBonus']")?.value,
      attackWaitDurationSeconds: row.querySelector("[data-field='fixed.lethalAttack.attackWaitDurationSeconds']")?.value
    };
  }
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.fourLeafClover) {
    return {
      currentCharges: row.querySelector("[data-field='fixed.fourLeafClover.currentCharges']")?.value,
      failureCharges: row.querySelector("[data-field='fixed.fourLeafClover.failureCharges']")?.value,
      criticalFailureCharges: row.querySelector("[data-field='fixed.fourLeafClover.criticalFailureCharges']")?.value
    };
  }
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.atRandom) {
    return {
      actionPointCostReduction: row.querySelector("[data-field='fixed.atRandom.actionPointCostReduction']")?.value,
      blockChanceFormula: row.querySelector("[data-field='fixed.atRandom.blockChanceFormula']")?.value,
      extraBlockChanceFormula: row.querySelector("[data-field='fixed.atRandom.extraBlockChanceFormula']")?.value
    };
  }
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.defensiveTactics) {
    return {
      dodgeLossReductionPercent: row.querySelector("[data-field='fixed.defensiveTactics.dodgeLossReductionPercent']")?.value,
      dodgeRoundRecoveryBonusPercent: row.querySelector("[data-field='fixed.defensiveTactics.dodgeRoundRecoveryBonusPercent']")?.value
    };
  }
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.lastChance) {
    return {
      energyCost: row.querySelector("[data-field='fixed.lastChance.energyCost']")?.value,
      chanceFormula: row.querySelector("[data-field='fixed.lastChance.chanceFormula']")?.value,
      overloadEnergyCost: row.querySelector("[data-field='fixed.lastChance.overloadEnergyCost']")?.value,
      overloadDurationSeconds: durationPartsToSeconds(
        row.querySelector("[data-field='fixed.lastChance.overloadDurationAmount']")?.value,
        row.querySelector("[data-field='fixed.lastChance.overloadDurationUnit']")?.value
      )
    };
  }
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.luckyCoin) {
    return {
      energyCost: row.querySelector("[data-field='fixed.luckyCoin.energyCost']")?.value,
      chanceFormula: row.querySelector("[data-field='fixed.luckyCoin.chanceFormula']")?.value,
      successBonusFormula: row.querySelector("[data-field='fixed.luckyCoin.successBonusFormula']")?.value,
      failurePenaltyFormula: row.querySelector("[data-field='fixed.luckyCoin.failurePenaltyFormula']")?.value,
      overloadEnergyCost: row.querySelector("[data-field='fixed.luckyCoin.overloadEnergyCost']")?.value,
      overloadDurationSeconds: durationPartsToSeconds(
        row.querySelector("[data-field='fixed.luckyCoin.overloadDurationAmount']")?.value,
        row.querySelector("[data-field='fixed.luckyCoin.overloadDurationUnit']")?.value
      )
    };
  }
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.whirlwind) {
    return {
      energyCost: row.querySelector("[data-field='fixed.whirlwind.energyCost']")?.value,
      overloadEnergyCost: row.querySelector("[data-field='fixed.whirlwind.overloadEnergyCost']")?.value,
      overloadDurationSeconds: durationPartsToSeconds(
        row.querySelector("[data-field='fixed.whirlwind.overloadDurationAmount']")?.value,
        row.querySelector("[data-field='fixed.whirlwind.overloadDurationUnit']")?.value
      ),
      accuracyModifier: row.querySelector("[data-field='fixed.whirlwind.accuracyModifier']")?.value
    };
  }
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.lunge) {
    return {
      energyCost: row.querySelector("[data-field='fixed.lunge.energyCost']")?.value,
      maxCells: row.querySelector("[data-field='fixed.lunge.maxCells']")?.value,
      overloadEnergyCost: row.querySelector("[data-field='fixed.lunge.overloadEnergyCost']")?.value,
      overloadDurationSeconds: durationPartsToSeconds(
        row.querySelector("[data-field='fixed.lunge.overloadDurationAmount']")?.value,
        row.querySelector("[data-field='fixed.lunge.overloadDurationUnit']")?.value
      )
    };
  }
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.doubleAttack) {
    return {
      energyCost: row.querySelector("[data-field='fixed.doubleAttack.energyCost']")?.value,
      duplicateCount: row.querySelector("[data-field='fixed.doubleAttack.duplicateCount']")?.value,
      requiredSkillKey: row.querySelector("[data-field='fixed.doubleAttack.requiredSkillKey']")?.value
    };
  }
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.fullForce) {
    return {
      energyCost: row.querySelector("[data-field='fixed.fullForce.energyCost']")?.value,
      requiredSkillKey: row.querySelector("[data-field='fixed.fullForce.requiredSkillKey']")?.value,
      damagePercentBonus: row.querySelector("[data-field='fixed.fullForce.damagePercentBonus']")?.value,
      conditionCostMultiplier: row.querySelector("[data-field='fixed.fullForce.conditionCostMultiplier']")?.value
    };
  }
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.twoHands) {
    return {
      energyCost: row.querySelector("[data-field='fixed.twoHands.energyCost']")?.value
    };
  }
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.commandBasics) {
    return {
      energyCost: row.querySelector("[data-field='fixed.commandBasics.energyCost']")?.value,
      overloadEnergyCost: row.querySelector("[data-field='fixed.commandBasics.overloadEnergyCost']")?.value,
      overloadDurationSeconds: durationPartsToSeconds(
        row.querySelector("[data-field='fixed.commandBasics.overloadDurationAmount']")?.value,
        row.querySelector("[data-field='fixed.commandBasics.overloadDurationUnit']")?.value
      ),
      targetLimitFormula: row.querySelector("[data-field='fixed.commandBasics.targetLimitFormula']")?.value,
      dodgeBonusFormula: row.querySelector("[data-field='fixed.commandBasics.dodgeBonusFormula']")?.value,
      dodgeDurationSeconds: durationPartsToSeconds(
        row.querySelector("[data-field='fixed.commandBasics.dodgeDurationAmount']")?.value,
        row.querySelector("[data-field='fixed.commandBasics.dodgeDurationUnit']")?.value
      )
    };
  }
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.knockOffBalance) {
    return {
      energyCost: row.querySelector("[data-field='fixed.knockOffBalance.energyCost']")?.value,
      overloadEnergyCost: row.querySelector("[data-field='fixed.knockOffBalance.overloadEnergyCost']")?.value,
      overloadDurationSeconds: durationPartsToSeconds(
        row.querySelector("[data-field='fixed.knockOffBalance.overloadDurationAmount']")?.value,
        row.querySelector("[data-field='fixed.knockOffBalance.overloadDurationUnit']")?.value
      ),
      targetLimitFormula: row.querySelector("[data-field='fixed.knockOffBalance.targetLimitFormula']")?.value,
      difficultyFormula: row.querySelector("[data-field='fixed.knockOffBalance.difficultyFormula']")?.value,
      targetSkillKey: row.querySelector("[data-field='fixed.knockOffBalance.targetSkillKey']")?.value,
      skillLimitFormula: row.querySelector("[data-field='fixed.knockOffBalance.skillLimitFormula']")?.value,
      skillDisadvantageCount: row.querySelector("[data-field='fixed.knockOffBalance.skillDisadvantageCount']")?.value,
      debuffDurationSeconds: durationPartsToSeconds(
        row.querySelector("[data-field='fixed.knockOffBalance.debuffDurationAmount']")?.value,
        row.querySelector("[data-field='fixed.knockOffBalance.debuffDurationUnit']")?.value
      )
    };
  }
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.look) {
    return {
      energyCost: row.querySelector("[data-field='fixed.look.energyCost']")?.value,
      overloadEnergyCost: row.querySelector("[data-field='fixed.look.overloadEnergyCost']")?.value,
      overloadDurationSeconds: durationPartsToSeconds(
        row.querySelector("[data-field='fixed.look.overloadDurationAmount']")?.value,
        row.querySelector("[data-field='fixed.look.overloadDurationUnit']")?.value
      ),
      difficultyFormula: row.querySelector("[data-field='fixed.look.difficultyFormula']")?.value,
      targetSkillKey: row.querySelector("[data-field='fixed.look.targetSkillKey']")?.value,
      failureResourceLoss: row.querySelector("[data-field='fixed.look.failureResourceLoss']")?.value,
      criticalFailureResourceLoss: row.querySelector("[data-field='fixed.look.criticalFailureResourceLoss']")?.value
    };
  }
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.toTheEnd) {
    return {
      energyCost: row.querySelector("[data-field='fixed.toTheEnd.energyCost']")?.value,
      overloadEnergyCost: row.querySelector("[data-field='fixed.toTheEnd.overloadEnergyCost']")?.value,
      overloadDurationSeconds: durationPartsToSeconds(
        row.querySelector("[data-field='fixed.toTheEnd.overloadDurationAmount']")?.value,
        row.querySelector("[data-field='fixed.toTheEnd.overloadDurationUnit']")?.value
      ),
      radiusFormula: row.querySelector("[data-field='fixed.toTheEnd.radiusFormula']")?.value,
      healingFormula: row.querySelector("[data-field='fixed.toTheEnd.healingFormula']")?.value,
      durationSeconds: durationPartsToSeconds(
        row.querySelector("[data-field='fixed.toTheEnd.durationAmount']")?.value,
        row.querySelector("[data-field='fixed.toTheEnd.durationUnit']")?.value
      ),
      characteristicBonusFormula: row.querySelector("[data-field='fixed.toTheEnd.characteristicBonusFormula']")?.value,
      advantageSkills: readToTheEndAdvantageSkills(row),
      suppressTraumas: row.querySelector("[data-field='fixed.toTheEnd.suppressTraumas']")?.checked
    };
  }
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.heightenedConcentration) {
    return {
      energyCost: row.querySelector("[data-field='fixed.heightenedConcentration.energyCost']")?.value,
      overloadEnergyCost: row.querySelector("[data-field='fixed.heightenedConcentration.overloadEnergyCost']")?.value,
      overloadDurationSeconds: durationPartsToSeconds(
        row.querySelector("[data-field='fixed.heightenedConcentration.overloadDurationAmount']")?.value,
        row.querySelector("[data-field='fixed.heightenedConcentration.overloadDurationUnit']")?.value
      ),
      skillKey: row.querySelector("[data-field='fixed.heightenedConcentration.skillKey']")?.value,
      checkCount: row.querySelector("[data-field='fixed.heightenedConcentration.checkCount']")?.value,
      advantageCount: row.querySelector("[data-field='fixed.heightenedConcentration.advantageCount']")?.value
    };
  }
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.anatomyStudy) {
    return {
      energyCost: row.querySelector("[data-field='fixed.anatomyStudy.energyCost']")?.value,
      actionPointCost: row.querySelector("[data-field='fixed.anatomyStudy.actionPointCost']")?.value,
      overloadEnergyCost: row.querySelector("[data-field='fixed.anatomyStudy.overloadEnergyCost']")?.value,
      overloadDurationSeconds: durationPartsToSeconds(
        row.querySelector("[data-field='fixed.anatomyStudy.overloadDurationAmount']")?.value,
        row.querySelector("[data-field='fixed.anatomyStudy.overloadDurationUnit']")?.value
      ),
      memoryFormula: row.querySelector("[data-field='fixed.anatomyStudy.memoryFormula']")?.value,
      damagePercentBonus: row.querySelector("[data-field='fixed.anatomyStudy.damagePercentBonus']")?.value,
      accuracyBonus: row.querySelector("[data-field='fixed.anatomyStudy.accuracyBonus']")?.value,
      criticalChanceBonus: row.querySelector("[data-field='fixed.anatomyStudy.criticalChanceBonus']")?.value,
      criticalDamagePercentBonus: row.querySelector("[data-field='fixed.anatomyStudy.criticalDamagePercentBonus']")?.value,
      drugEffectivenessPercentBonus: row.querySelector("[data-field='fixed.anatomyStudy.drugEffectivenessPercentBonus']")?.value,
      treatmentEffectivenessPercentBonus: row.querySelector("[data-field='fixed.anatomyStudy.treatmentEffectivenessPercentBonus']")?.value
    };
  }
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.specialMix) {
    return {
      energyCost: row.querySelector("[data-field='fixed.specialMix.energyCost']")?.value,
      actionPointCost: row.querySelector("[data-field='fixed.specialMix.actionPointCost']")?.value,
      overloadEnergyCost: row.querySelector("[data-field='fixed.specialMix.overloadEnergyCost']")?.value,
      overloadDurationSeconds: durationPartsToSeconds(
        row.querySelector("[data-field='fixed.specialMix.overloadDurationAmount']")?.value,
        row.querySelector("[data-field='fixed.specialMix.overloadDurationUnit']")?.value
      ),
      effectivenessPercentBonus: row.querySelector("[data-field='fixed.specialMix.effectivenessPercentBonus']")?.value,
      durationPercentBonus: row.querySelector("[data-field='fixed.specialMix.durationPercentBonus']")?.value,
      spoilDurationSeconds: durationPartsToSeconds(
        row.querySelector("[data-field='fixed.specialMix.spoilDurationAmount']")?.value,
        row.querySelector("[data-field='fixed.specialMix.spoilDurationUnit']")?.value
      )
    };
  }
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.experimentalSurgery) {
    return {
      treatmentEnergyCost: row.querySelector("[data-field='fixed.experimentalSurgery.treatmentEnergyCost']")?.value,
      allowedToolClassDeficit: row.querySelector("[data-field='fixed.experimentalSurgery.allowedToolClassDeficit']")?.value,
      extraSupplyChancePercent: row.querySelector("[data-field='fixed.experimentalSurgery.extraSupplyChancePercent']")?.value,
      supplyCostMultiplier: row.querySelector("[data-field='fixed.experimentalSurgery.supplyCostMultiplier']")?.value,
      patientDamageChancePercent: row.querySelector("[data-field='fixed.experimentalSurgery.patientDamageChancePercent']")?.value,
      patientHealthDamagePercent: row.querySelector("[data-field='fixed.experimentalSurgery.patientHealthDamagePercent']")?.value
    };
  }
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.emergencyOperations) {
    return {
      combatActionPointCost: row.querySelector("[data-field='fixed.emergencyOperations.combatActionPointCost']")?.value,
      activationEnergyCost: row.querySelector("[data-field='fixed.emergencyOperations.activationEnergyCost']")?.value,
      overloadEnergyCost: row.querySelector("[data-field='fixed.emergencyOperations.overloadEnergyCost']")?.value,
      overloadDurationSeconds: durationPartsToSeconds(
        row.querySelector("[data-field='fixed.emergencyOperations.overloadDurationAmount']")?.value,
        row.querySelector("[data-field='fixed.emergencyOperations.overloadDurationUnit']")?.value
      ),
      toolEfficiencyPercentBonus: row.querySelector("[data-field='fixed.emergencyOperations.toolEfficiencyPercentBonus']")?.value
    };
  }
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.inconspicuous) {
    return {
      attackStealthBonus: row.querySelector("[data-field='fixed.inconspicuous.attackStealthBonus']")?.value,
      stealthBonus: row.querySelector("[data-field='fixed.inconspicuous.stealthBonus']")?.value,
      stealthBonusDurationSeconds: durationPartsToSeconds(
        row.querySelector("[data-field='fixed.inconspicuous.stealthBonusDurationAmount']")?.value,
        row.querySelector("[data-field='fixed.inconspicuous.stealthBonusDurationUnit']")?.value
      )
    };
  }
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.shadow) {
    return {
      activationEnergyCost: row.querySelector("[data-field='fixed.shadow.activationEnergyCost']")?.value,
      overloadEnergyCost: row.querySelector("[data-field='fixed.shadow.overloadEnergyCost']")?.value,
      overloadDurationSeconds: durationPartsToSeconds(
        row.querySelector("[data-field='fixed.shadow.overloadDurationAmount']")?.value,
        row.querySelector("[data-field='fixed.shadow.overloadDurationUnit']")?.value
      ),
      durationSeconds: durationPartsToSeconds(
        row.querySelector("[data-field='fixed.shadow.durationAmount']")?.value,
        row.querySelector("[data-field='fixed.shadow.durationUnit']")?.value
      ),
      stealthBonus: row.querySelector("[data-field='fixed.shadow.stealthBonus']")?.value
    };
  }
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.sandman) {
    return {
      activationEnergyCost: row.querySelector("[data-field='fixed.sandman.activationEnergyCost']")?.value,
      maxCharges: row.querySelector("[data-field='fixed.sandman.maxCharges']")?.value,
      knockoutCharges: row.querySelector("[data-field='fixed.sandman.knockoutCharges']")?.value,
      killCharges: row.querySelector("[data-field='fixed.sandman.killCharges']")?.value,
      restoreCooldownSeconds: row.querySelector("[data-field='fixed.sandman.restoreCooldownSeconds']")?.value,
      damagePercentBonus: row.querySelector("[data-field='fixed.sandman.damagePercentBonus']")?.value
    };
  }
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.nightmare) {
    return {
      activationEnergyCost: row.querySelector("[data-field='fixed.nightmare.activationEnergyCost']")?.value,
      overloadEnergyCost: row.querySelector("[data-field='fixed.nightmare.overloadEnergyCost']")?.value,
      overloadDurationSeconds: durationPartsToSeconds(
        row.querySelector("[data-field='fixed.nightmare.overloadDurationAmount']")?.value,
        row.querySelector("[data-field='fixed.nightmare.overloadDurationUnit']")?.value
      ),
      witnessRadiusMeters: row.querySelector("[data-field='fixed.nightmare.witnessRadiusMeters']")?.value,
      witnessDifficultyFormula: row.querySelector("[data-field='fixed.nightmare.witnessDifficultyFormula']")?.value,
      fearDurationSeconds: row.querySelector("[data-field='fixed.nightmare.fearDurationSeconds']")?.value,
      incomingDamagePercent: row.querySelector("[data-field='fixed.nightmare.incomingDamagePercent']")?.value,
      outgoingDamagePercentPenalty: row.querySelector("[data-field='fixed.nightmare.outgoingDamagePercentPenalty']")?.value,
      actionPointPenalty: row.querySelector("[data-field='fixed.nightmare.actionPointPenalty']")?.value,
      movementPointPenalty: row.querySelector("[data-field='fixed.nightmare.movementPointPenalty']")?.value,
      allSkillsPercentPenalty: row.querySelector("[data-field='fixed.nightmare.allSkillsPercentPenalty']")?.value,
      darknessRadiusMeters: row.querySelector("[data-field='fixed.nightmare.darknessRadiusMeters']")?.value,
      darknessAbsorptionPercent: row.querySelector("[data-field='fixed.nightmare.darknessAbsorptionPercent']")?.value,
      darknessDurationSeconds: row.querySelector("[data-field='fixed.nightmare.darknessDurationSeconds']")?.value
    };
  }
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.counterAttack) {
    return {
      reactionEnergyCost: row.querySelector("[data-field='fixed.counterAttack.reactionEnergyCost']")?.value,
      reactionOverloadEnergyCost: row.querySelector("[data-field='fixed.counterAttack.reactionOverloadEnergyCost']")?.value,
      reactionOverloadDurationSeconds: durationPartsToSeconds(
        row.querySelector("[data-field='fixed.counterAttack.reactionOverloadDurationAmount']")?.value,
        row.querySelector("[data-field='fixed.counterAttack.reactionOverloadDurationUnit']")?.value
      ),
      requiredSkillKey: row.querySelector("[data-field='fixed.counterAttack.requiredSkillKey']")?.value
    };
  }
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.oversight) {
    return {
      energyCost: row.querySelector("[data-field='fixed.oversight.energyCost']")?.value,
      overloadEnergyCost: row.querySelector("[data-field='fixed.oversight.overloadEnergyCost']")?.value,
      overloadDurationSeconds: durationPartsToSeconds(
        row.querySelector("[data-field='fixed.oversight.overloadDurationAmount']")?.value,
        row.querySelector("[data-field='fixed.oversight.overloadDurationUnit']")?.value
      ),
      difficultyBase: row.querySelector("[data-field='fixed.oversight.difficultyBase']")?.value,
      sourceSkillKey: row.querySelector("[data-field='fixed.oversight.sourceSkillKey']")?.value,
      targetSkillKey: row.querySelector("[data-field='fixed.oversight.targetSkillKey']")?.value,
      dodgeRecoveryDivisor: row.querySelector("[data-field='fixed.oversight.dodgeRecoveryDivisor']")?.value,
      resourceThreshold: row.querySelector("[data-field='fixed.oversight.resourceThreshold']")?.value
    };
  }
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.watchOut) {
    return {
      reactionEnergyCost: row.querySelector("[data-field='fixed.watchOut.reactionEnergyCost']")?.value,
      reactionOverloadEnergyCost: row.querySelector("[data-field='fixed.watchOut.reactionOverloadEnergyCost']")?.value,
      reactionOverloadDurationSeconds: durationPartsToSeconds(
        row.querySelector("[data-field='fixed.watchOut.reactionOverloadDurationAmount']")?.value,
        row.querySelector("[data-field='fixed.watchOut.reactionOverloadDurationUnit']")?.value
      ),
      difficultyBase: row.querySelector("[data-field='fixed.watchOut.difficultyBase']")?.value,
      sourceSkillKey: row.querySelector("[data-field='fixed.watchOut.sourceSkillKey']")?.value,
      skillDivisor: row.querySelector("[data-field='fixed.watchOut.skillDivisor']")?.value,
      defaultMinimumHitChancePercent: row.querySelector("[data-field='fixed.watchOut.defaultMinimumHitChancePercent']")?.value
    };
  }
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.fullControl) {
    return {
      limitSkillKey: row.querySelector("[data-field='fixed.fullControl.limitSkillKey']")?.value,
      baseChangeLimit: row.querySelector("[data-field='fixed.fullControl.baseChangeLimit']")?.value,
      skillDivisor: row.querySelector("[data-field='fixed.fullControl.skillDivisor']")?.value,
      energyPerCharacteristicPoint: row.querySelector("[data-field='fixed.fullControl.energyPerCharacteristicPoint']")?.value,
      durationSeconds: durationPartsToSeconds(
        row.querySelector("[data-field='fixed.fullControl.durationAmount']")?.value,
        row.querySelector("[data-field='fixed.fullControl.durationUnit']")?.value
      )
    };
  }
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.counterSniper) {
    return {
      reactionEnergyCost: row.querySelector("[data-field='fixed.counterSniper.reactionEnergyCost']")?.value,
      reactionOverloadEnergyCost: row.querySelector("[data-field='fixed.counterSniper.reactionOverloadEnergyCost']")?.value,
      reactionOverloadDurationSeconds: row.querySelector("[data-field='fixed.counterSniper.reactionOverloadDurationSeconds']")?.value
    };
  }
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.whereAreYouGoing) {
    return {
      reactionEnergyCost: row.querySelector("[data-field='fixed.whereAreYouGoing.reactionEnergyCost']")?.value,
      reactionOverloadEnergyCost: row.querySelector("[data-field='fixed.whereAreYouGoing.reactionOverloadEnergyCost']")?.value,
      reactionOverloadDurationSeconds: durationPartsToSeconds(
        row.querySelector("[data-field='fixed.whereAreYouGoing.reactionOverloadDurationAmount']")?.value,
        row.querySelector("[data-field='fixed.whereAreYouGoing.reactionOverloadDurationUnit']")?.value
      )
    };
  }
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.rage) {
    return {
      energyCost: row.querySelector("[data-field='fixed.rage.energyCost']")?.value,
      overloadEnergyCost: row.querySelector("[data-field='fixed.rage.overloadEnergyCost']")?.value,
      overloadDurationSeconds: durationPartsToSeconds(
        row.querySelector("[data-field='fixed.rage.overloadDurationAmount']")?.value,
        row.querySelector("[data-field='fixed.rage.overloadDurationUnit']")?.value
      ),
      durationSeconds: durationPartsToSeconds(
        row.querySelector("[data-field='fixed.rage.durationAmount']")?.value,
        row.querySelector("[data-field='fixed.rage.durationUnit']")?.value
      ),
      movementPointBonus: row.querySelector("[data-field='fixed.rage.movementPointBonus']")?.value,
      actionPointBonus: row.querySelector("[data-field='fixed.rage.actionPointBonus']")?.value,
      advantageSkillKey: row.querySelector("[data-field='fixed.rage.advantageSkillKey']")?.value,
      advantageCount: row.querySelector("[data-field='fixed.rage.advantageCount']")?.value,
      disadvantageSkillKey: row.querySelector("[data-field='fixed.rage.disadvantageSkillKey']")?.value,
      disadvantageCount: row.querySelector("[data-field='fixed.rage.disadvantageCount']")?.value
    };
  }
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.disarm) {
    return {
      activeEnergyCost: row.querySelector("[data-field='fixed.disarm.activeEnergyCost']")?.value,
      activeActionPointCost: row.querySelector("[data-field='fixed.disarm.activeActionPointCost']")?.value,
      activeDifficultyBase: row.querySelector("[data-field='fixed.disarm.activeDifficultyBase']")?.value,
      activeOverloadEnergyCost: row.querySelector("[data-field='fixed.disarm.activeOverloadEnergyCost']")?.value,
      activeOverloadDurationSeconds: durationPartsToSeconds(
        row.querySelector("[data-field='fixed.disarm.activeOverloadDurationAmount']")?.value,
        row.querySelector("[data-field='fixed.disarm.activeOverloadDurationUnit']")?.value
      ),
      reactionEnergyCost: row.querySelector("[data-field='fixed.disarm.reactionEnergyCost']")?.value,
      reactionActionPointCost: row.querySelector("[data-field='fixed.disarm.reactionActionPointCost']")?.value,
      reactionDifficultyBase: row.querySelector("[data-field='fixed.disarm.reactionDifficultyBase']")?.value,
      reactionOverloadEnergyCost: row.querySelector("[data-field='fixed.disarm.reactionOverloadEnergyCost']")?.value,
      reactionOverloadDurationSeconds: durationPartsToSeconds(
        row.querySelector("[data-field='fixed.disarm.reactionOverloadDurationAmount']")?.value,
        row.querySelector("[data-field='fixed.disarm.reactionOverloadDurationUnit']")?.value
      )
    };
  }
  if (fixedKey !== ABILITY_FIXED_FUNCTION_KEYS.deusExMachina) return {};
  return {
    damageRequired: row.querySelector("[data-field='fixed.damageRequired']")?.value,
    insight: {
      skillBonus: row.querySelector("[data-field='fixed.insight.skillBonus']")?.value,
      durationSeconds: durationPartsToSeconds(
        row.querySelector("[data-field='fixed.insight.durationAmount']")?.value,
        row.querySelector("[data-field='fixed.insight.durationUnit']")?.value
      )
    },
    disintegrate: {
      destroyPercent: row.querySelector("[data-field='fixed.disintegrate.destroyPercent']")?.value
    },
    luckyFind: {
      valueMin: row.querySelector("[data-field='fixed.luckyFind.valueMin']")?.value,
      valueMax: row.querySelector("[data-field='fixed.luckyFind.valueMax']")?.value
    },
    rescue: {
      restoreMode: row.querySelector("[data-field='fixed.rescue.restoreMode']")?.value,
      restoreCount: row.querySelector("[data-field='fixed.rescue.restoreCount']")?.value
    }
  };
}

function readToTheEndAdvantageSkills(row) {
  return Array.from(row.querySelectorAll("[data-fixed-to-the-end-advantage-skill-row]") ?? []).map(skillRow => ({
    skillKey: skillRow.querySelector("[data-field='fixed.toTheEnd.advantageSkillKey']")?.value,
    advantageCount: skillRow.querySelector("[data-field='fixed.toTheEnd.advantageCount']")?.value
  }));
}

function readAbilityChanges(root, selector) {
  return Array.from(root?.querySelectorAll(selector) ?? []).map(changeRow => {
    const valueSource = changeRow.querySelector("[data-field='changeValueSource']")?.value ?? "";
    return {
      id: changeRow.dataset.changeId || foundry.utils.randomID(),
      key: changeRow.querySelector("[data-field='changeKey']")?.value ?? "",
      type: changeRow.querySelector("[data-field='changeType']")?.value ?? ABILITY_CHANGE_TYPES.add,
      value: changeRow.querySelector("[data-field='changeValue']")?.value ?? "0",
      phase: "initial",
      priority: changeRow.querySelector("[data-field='changePriority']")?.value ?? null,
      ...(valueSource === ABILITY_CHANGE_VALUE_SOURCES.accumulation ? {
        valueSource,
        accumulatorExchange: {
          conditionId: changeRow.querySelector("[data-field='changeAccumulatorConditionId']")?.value ?? "",
          mode: "invested"
        }
      } : {})
    };
  });
}

function readAbilityConditions(root) {
  return Array.from(root?.querySelectorAll("[data-ability-condition-row]") ?? []).map(row => {
    const auraMode = row.querySelector("[data-field='conditionAuraMode']")?.value ?? ABILITY_AURA_MODES.applyToTargets;
    const reactionMode = normalizeEventReactionMode(row.querySelector("[data-field='conditionReactionMode']")?.value);
    return {
      id: row.dataset.conditionId || foundry.utils.randomID(),
      groupId: row.querySelector("[data-field='conditionGroupId']")?.value ?? row.dataset.conditionGroupId ?? "",
      type: row.querySelector("[data-field='conditionType']")?.value || "",
      trialSubject: row.querySelector("[data-field='conditionTrialSubject']")?.value ?? ABILITY_TRIAL_SUBJECTS.targets,
      trialEntries: Array.from(row.querySelectorAll("[data-trial-entry-row]") ?? []).map(entryRow => ({
        id: entryRow.dataset.trialEntryId || foundry.utils.randomID(),
        kind: entryRow.querySelector("[data-field='conditionTrialEntryKind']")?.value ?? "skill",
        key: entryRow.querySelector("[data-field='conditionTrialEntryKey']")?.value ?? ""
      })),
      trialSelectionMode: row.querySelector("[data-field='conditionTrialSelectionMode']")?.value
        ?? ABILITY_TRIAL_SELECTION_MODES.best,
      trialDifficultyFormula: row.querySelector("[data-field='conditionTrialDifficultyFormula']")?.value ?? "0",
      trialRoutesPrimaryChanges: Boolean(
        row.querySelector("[data-field='conditionTrialRoutesPrimaryChanges']")?.value === "true"
      ),
      trialBranches: Array.from(row.querySelectorAll("[data-trial-branch-row]") ?? []).map(branchRow => ({
        id: branchRow.dataset.trialBranchId || foundry.utils.randomID(),
        name: branchRow.querySelector("[data-field='conditionTrialBranchName']")?.value ?? "",
        resultKeys: readCheckedFieldValues(branchRow, "[data-field='conditionTrialBranchResultKey']"),
        flow: branchRow.querySelector("[data-field='conditionTrialBranchFlow']")?.value
          ?? ABILITY_TRIAL_BRANCH_FLOWS.continue,
        links: Array.from(branchRow.querySelectorAll("[data-trial-link-row]") ?? []).map(linkRow => {
          const selectedType = String(
            linkRow.querySelector("[data-field='conditionTrialLinkType']")?.value ?? ""
          );
          const kind = [
            ABILITY_TRIAL_LINK_KINDS.primaryChanges,
            ABILITY_TRIAL_LINK_KINDS.primaryChangesPercent
          ].includes(selectedType)
            ? selectedType
            : Object.values(ABILITY_CONSTRUCT_TYPES).includes(selectedType)
              ? ABILITY_TRIAL_LINK_KINDS.construct
              : ABILITY_TRIAL_LINK_KINDS.pending;
          return {
            id: linkRow.dataset.trialLinkId || foundry.utils.randomID(),
            kind,
            constructId: linkRow.querySelector("[data-field='conditionTrialLinkConstructId']")?.value ?? "",
            percentFormula: linkRow.querySelector("[data-field='conditionTrialLinkPercentFormula']")?.value
              ?? "100",
            durationPercentFormula: linkRow.querySelector("[data-field='conditionTrialLinkDurationPercentFormula']")?.value
              ?? "100",
            recipient: linkRow.querySelector("[data-field='conditionTrialLinkRecipient']")?.value
              ?? ABILITY_TRIAL_LINK_RECIPIENTS.subjects,
            mode: linkRow.querySelector("[data-field='conditionTrialLinkMode']")?.value
              ?? ABILITY_TRIAL_LINK_MODES.perSubject
          };
        })
      })),
      eventKey: row.querySelector("[data-field='conditionEventKey']")?.value ?? "",
      progressRequired: row.querySelector("[data-field='conditionEventProgressRequired']")?.value ?? 1,
      combatOnly: Boolean(row.querySelector("[data-field='conditionCombatOnly']")?.checked),
      allowUnconscious: Boolean(row.querySelector("[data-field='conditionAllowUnconscious']")?.checked),
      allowDead: Boolean(row.querySelector("[data-field='conditionAllowDead']")?.checked),
      reactionMode,
      autoApply: reactionMode === ABILITY_EVENT_REACTION_MODES.isolatedAuto,
      accumulation: {
        name: row.querySelector("[data-field='conditionAccumulationName']")?.value ?? "",
        valueSource: row.querySelector("[data-field='conditionAccumulationValueSource']")?.value,
        percent: row.querySelector("[data-field='conditionAccumulationPercent']")?.value,
        groupBy: row.querySelector("[data-field='conditionAccumulationGroupBy']")?.value,
        totalCap: row.querySelector("[data-field='conditionAccumulationTotalCap']")?.value,
        bucketCap: row.querySelector("[data-field='conditionAccumulationBucketCap']")?.value,
        rounding: row.querySelector("[data-field='conditionAccumulationRounding']")?.value,
        durationPolicy: row.querySelector("[data-field='conditionAccumulationDurationPolicy']")?.value
      },
      trackingTargets: readFieldValues(row, "[data-field='conditionTrackingTarget']"),
      eventSubject: row.querySelector("[data-field='conditionEventSubject']")?.value ?? ABILITY_EVENT_SUBJECTS.reactor,
      effectTarget: row.querySelector("[data-field='conditionEffectTarget']")?.value ?? ABILITY_EVENT_EFFECT_TARGETS.reactor,
      chanceFormula: row.querySelector("[data-field='conditionChanceFormula']")?.value ?? "100",
      timeFrom: row.querySelector("[data-field='conditionTimeFrom']")?.value ?? "00:00",
      timeTo: row.querySelector("[data-field='conditionTimeTo']")?.value ?? "23:59",
      illuminationLevel: row.querySelector("[data-field='conditionIlluminationLevel']")?.value ?? "normal",
      damageTypeKeys: readFieldValues(row, "[data-field='conditionRegionDamageType']"),
      regionSpecialPropertyTypes: readFieldValues(row, "[data-field='conditionRegionSpecialProperty']"),
      operator: row.querySelector("[data-field='conditionOperator']")?.value ?? "lte",
      percent: row.querySelector("[data-field='conditionPercent']")?.value ?? 50,
      healthTarget: row.querySelector("[data-field='conditionHealthTarget']")?.value ?? ABILITY_HEALTH_TARGETS.general,
      limbKey: row.querySelector("[data-field='conditionLimbKey']")?.value ?? ABILITY_HEALTH_LIMB_ALL,
      equipmentSlotKey: row.querySelector("[data-field='conditionEquipmentSlotKey']")?.value ?? "",
      targetFactionNames: readFieldValues(row, "[data-field='conditionTargetFaction']"),
      targetRaceId: row.querySelector("[data-field='conditionTargetRace']")?.value ?? "",
      targetTypeId: row.querySelector("[data-field='conditionTargetType']")?.value ?? "",
      postureSubject: row.querySelector("[data-field='conditionPostureSubject']")?.value ?? ABILITY_POSTURE_SUBJECTS.self,
      postureActions: readFieldValues(row, "[data-field='conditionPosture']"),
      coverKeys: readFieldValues(row, "[data-field='conditionCover']"),
      attackDistanceMode: row.querySelector("[data-field='conditionAttackDistanceMode']")?.value ?? ABILITY_ATTACK_DISTANCE_MODES.effective,
      attackDistanceSide: row.querySelector("[data-field='conditionAttackDistanceSide']")?.value ?? ABILITY_ATTACK_DISTANCE_SIDES.both,
      attackDistanceMinMeters: row.querySelector("[data-field='conditionAttackDistanceMinMeters']")?.value ?? null,
      attackDistanceMaxMeters: row.querySelector("[data-field='conditionAttackDistanceMaxMeters']")?.value ?? null,
      weaponActionKeys: readFieldValues(row, "[data-field='conditionWeaponAction']"),
      skillKeys: (() => {
        const eventSkills = readFieldValues(row, "[data-field='conditionEventSkill']");
        if (eventSkills.length) return eventSkills;
        return readFieldValues(row, "[data-field='conditionSkill']");
      })(),
      expectedResultKeys: readFieldValues(row, "[data-field='conditionEventExpectedResult']"),
      eventFilters: readEventReactionDepthFilters(row),
      costs: readTriggerCostRows(row),
      proficiencyKeys: readFieldValues(row, "[data-field='conditionProficiency']"),
      auraMode,
      auraTargetGroups: readFieldValues(row, "[data-field='conditionAuraTargetGroup']"),
      auraRadiusMeters: row.querySelector("[data-field='conditionAuraRadiusMeters']")?.value ?? 0,
      auraWallsBlock: readBooleanField(row.querySelector("[data-field='conditionAuraWallsBlock']"), true),
      auraIncludeSelf: auraMode === ABILITY_AURA_MODES.applyToTargets
        ? readBooleanField(row.querySelector("[data-field='conditionAuraIncludeSelf']"), true)
        : false,
      auraCombatOnly: readBooleanField(row.querySelector("[data-field='conditionAuraCombatOnly']"), false),
      auraCombatantsOnly: readBooleanField(row.querySelector("[data-field='conditionAuraCombatantsOnly']"), false),
      auraIgnoreIncapacitated: readBooleanField(row.querySelector("[data-field='conditionAuraIgnoreIncapacitated']"), true),
      auraAllowUnconscious: readBooleanField(row.querySelector("[data-field='conditionAuraAllowUnconscious']"), false),
      auraAllowDead: readBooleanField(row.querySelector("[data-field='conditionAuraAllowDead']"), false),
      auraIgnoreHidden: readBooleanField(row.querySelector("[data-field='conditionAuraIgnoreHidden']"), true),
      auraTriggerOnCreate: readBooleanField(row.querySelector("[data-field='conditionAuraTriggerOnCreate']"), true),
      auraTriggerOnEnter: readBooleanField(row.querySelector("[data-field='conditionAuraTriggerOnEnter']"), true),
      auraRepeatSeconds: row.querySelector("[data-field='conditionAuraRepeatSeconds']")?.value ?? 6,
      limit: row.querySelector("[data-field='conditionLimitLegacy']")?.value ?? 1,
      limitFormula: row.querySelector("[data-field='conditionLimitFormula']")?.value
        ?? row.querySelector("[data-field='conditionLimit']")?.value
        ?? 1,
      usesSpent: row.querySelector("[data-field='conditionUsesSpent']")?.value ?? 0,
      usesMax: row.querySelector("[data-field='conditionUsesMax']")?.value ?? 1,
      name: row.querySelector("[data-field='conditionToggleName']")?.value
        ?? row.querySelector("[data-field='conditionEnergyConsumptionName']")?.value
        ?? "",
      cooldownSeconds: (() => {
        const amount = row.querySelector("[data-field='conditionToggleCooldownAmount']")?.value;
        if (String(amount ?? "").trim() === "") return null;
        return durationPartsToSeconds(
          amount,
          row.querySelector("[data-field='conditionToggleCooldownUnit']")?.value
        );
      })(),
      amountPerHour: row.querySelector("[data-field='conditionAmountPerHour']")?.value ?? 0,
      requiredCount: row.querySelector("[data-field='conditionRequiredCount']")?.value ?? 1,
      itemCategories: readFieldValues(row, "[data-field='conditionItemCategory']"),
      durationSeconds: readConditionDurationSeconds(row)
    };
  });
}

function readAbilityConstructs(root) {
  const seen = new Set();
  return Array.from(root?.querySelectorAll("[data-ability-construct-row]") ?? []).map(constructRow => {
    const type = constructRow.querySelector("[data-field='constructType']")?.value
      ?? ABILITY_CONSTRUCT_TYPES.temporaryEffect;
    return {
      id: constructRow.dataset.constructId || foundry.utils.randomID(),
      type,
      name: constructRow.querySelector("[data-field='constructName']")?.value ?? "",
      durationSeconds: (() => {
        const amount = constructRow.querySelector("[data-field='constructDurationAmount']");
        if (!amount) {
          return constructRow.querySelector("[data-field='constructDurationSeconds']")?.value ?? 0;
        }
        return durationPartsToSeconds(
          amount.value,
          constructRow.querySelector("[data-field='constructDurationUnit']")?.value
        );
      })(),
      changes: Array.from(constructRow.querySelectorAll("[data-ability-construct-change-row]") ?? [])
        .map(changeRow => ({
          id: changeRow.dataset.changeId || foundry.utils.randomID(),
          key: changeRow.querySelector("[data-field='constructChangeKey']")?.value ?? "",
          type: changeRow.querySelector("[data-field='constructChangeType']")?.value ?? ABILITY_CHANGE_TYPES.add,
          value: changeRow.querySelector("[data-field='constructChangeValue']")?.value ?? "0",
          phase: "initial",
          priority: changeRow.querySelector("[data-field='constructChangePriority']")?.value ?? null
        })),
      resources: Array.from(constructRow.querySelectorAll("[data-ability-construct-resource-row]") ?? [])
        .map(resourceRow => ({
          id: resourceRow.dataset.resourceId || foundry.utils.randomID(),
          resourceKey: resourceRow.querySelector("[data-field='constructResourceKey']")?.value ?? "",
          formula: resourceRow.querySelector("[data-field='constructResourceFormula']")?.value ?? "0"
        })),
      damage: {
        amountMode: constructRow.querySelector("[data-field='constructDamageAmountMode']")?.value ?? "base",
        formula: constructRow.querySelector("[data-field='constructDamageFormula']")?.value ?? "0",
        damageTypeKey: constructRow.querySelector("[data-field='constructDamageTypeKey']")?.value ?? "",
        limbMode: constructRow.querySelector("[data-field='constructDamageLimbMode']")?.value ?? "random"
      }
    };
  }).filter(construct => {
    if (seen.has(construct.id)) return false;
    seen.add(construct.id);
    return true;
  });
}

function readCheckedFieldValues(root, selector) {
  return Array.from(root?.querySelectorAll(selector) ?? [])
    .filter(input => input.checked)
    .map(input => String(input.value ?? "").trim())
    .filter(Boolean);
}

function readTriggerCostRows(conditionRow) {
  return Array.from(conditionRow?.querySelectorAll("[data-trigger-cost-row]") ?? [])
    .map(costRow => readTriggerCostRow(costRow));
}

function readTriggerCostRow(costRow) {
  const overloadDurationRaw = costRow.querySelector("[data-field='triggerCost.overloadDurationAmount']")?.value;
  const overloadDurationSeconds = overloadDurationRaw === "" || overloadDurationRaw === undefined || overloadDurationRaw === null
    ? 0
    : durationPartsToSeconds(
      overloadDurationRaw,
      costRow.querySelector("[data-field='triggerCost.overloadDurationUnit']")?.value
    );
  return {
    id: costRow.dataset.costId || foundry.utils.randomID(),
    resourceKey: costRow.querySelector("[data-field='triggerCost.resourceKey']")?.value ?? "",
    formula: costRow.querySelector("[data-field='triggerCost.formula']")?.value ?? "0",
    overloadAmount: overloadDurationSeconds > 0
      ? Math.max(0, toInteger(costRow.querySelector("[data-field='triggerCost.overloadAmount']")?.value ?? 0))
      : 0,
    overloadDurationSeconds
  };
}

function readAcquisitionRequirements(root) {
  return Array.from(root?.querySelectorAll("[data-acquisition-requirement-row]") ?? []).map(row => ({
    id: row.dataset.requirementId || foundry.utils.randomID(),
    type: row.querySelector("[data-field='acquisitionRequirementType']")?.value || "",
    raceId: row.querySelector("[data-field='acquisitionRequirementRaceId']")?.value ?? "",
    characteristicKey: row.querySelector("[data-field='acquisitionRequirementCharacteristicKey']")?.value ?? "",
    skillKey: row.querySelector("[data-field='acquisitionRequirementSkillKey']")?.value ?? "",
    value: row.querySelector("[data-field='acquisitionRequirementValue']")?.value ?? 0,
    mode: row.querySelector("[data-field='acquisitionRequirementMode']")?.value ?? "",
    abilityIds: Array.from(row.querySelectorAll("[data-field='acquisitionRequirementAbilityId']") ?? [])
      .map(input => String(input.value ?? "").trim())
      .filter(Boolean)
  }));
}

function readFieldValue(element, fallback = "") {
  if (!element) return fallback;
  if ("value" in element) return element.value;
  return element.getAttribute("value") ?? fallback;
}

function readBooleanField(element, fallback = false) {
  if (!element) return Boolean(fallback);
  if (String(element.type ?? "").toLowerCase() === "checkbox") return Boolean(element.checked);
  return String(readFieldValue(element, fallback ? "true" : "false")) === "true";
}

function prepareFunctionForDisplay(entry, { constructs = [] } = {}) {
  const normalized = normalizeAbilityFunctions([entry])[0] ?? createAbilityFunction();
  const isAcquisitionChanges = normalized.type === ABILITY_FUNCTION_TYPES.acquisitionChanges;
  const isEffectChanges = normalized.type === ABILITY_FUNCTION_TYPES.effectChanges;
  const isActiveApplication = normalized.type === ABILITY_FUNCTION_TYPES.activeApplication;
  const isAttackAction = normalized.type === ABILITY_FUNCTION_TYPES.attackAction;
  const isFixed = normalized.type === ABILITY_FUNCTION_TYPES.fixed;
  const fixedKey = String(normalized.fixedKey ?? "");
  const activeApplicationSettings = isActiveApplication
    ? prepareActiveApplicationSettingsForDisplay(normalized.activeSettings)
    : null;
  const attackActionSettings = isAttackAction
    ? prepareAttackActionSettingsForDisplay(normalized.attackSettings, constructs)
    : null;
  const fixedDeusSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.deusExMachina
    ? prepareDeusExMachinaSettingsForDisplay(normalized.fixedSettings)
    : null;
  const fixedCurseAndBlessingSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.curseAndBlessing
    ? prepareCurseAndBlessingSettingsForDisplay(normalized.fixedSettings)
    : null;
  const fixedAllOrNothingSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.allOrNothing
    ? prepareAllOrNothingSettingsForDisplay(normalized.fixedSettings)
    : null;
  const fixedReaperSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.reaper
    ? prepareReaperSettingsForDisplay(normalized.fixedSettings)
    : null;
  const fixedVirtuosoSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.virtuoso
    ? normalizeVirtuosoSettings(normalized.fixedSettings)
    : null;
  const fixedVersatileDevelopmentSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.versatileDevelopment
    ? normalizeVersatileDevelopmentSettings(normalized.fixedSettings)
    : null;
  const fixedAimingSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.aiming
    ? normalizeAimingSettings(normalized.fixedSettings)
    : null;
  const fixedRicochetSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.ricochet
    ? normalizeRicochetSettings(normalized.fixedSettings)
    : null;
  const fixedKeepAwaySettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.keepAway
    ? normalizeKeepAwaySettings(normalized.fixedSettings)
    : null;
  const fixedLethalAttackSettings = [ABILITY_FIXED_FUNCTION_KEYS.lethalShot, ABILITY_FIXED_FUNCTION_KEYS.lethalStrike].includes(fixedKey)
    ? normalizeLethalAttackSettings(normalized.fixedSettings)
    : null;
  const fixedFourLeafCloverSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.fourLeafClover
    ? prepareFourLeafCloverSettingsForDisplay(normalized.fixedSettings)
    : null;
  const fixedAtRandomSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.atRandom
    ? prepareAtRandomSettingsForDisplay(normalized.fixedSettings)
    : null;
  const fixedDefensiveTacticsSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.defensiveTactics
    ? prepareDefensiveTacticsSettingsForDisplay(normalized.fixedSettings)
    : null;
  const fixedLastChanceSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.lastChance
    ? prepareLastChanceSettingsForDisplay(normalized.fixedSettings)
    : null;
  const fixedLuckyCoinSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.luckyCoin
    ? prepareLuckyCoinSettingsForDisplay(normalized.fixedSettings)
    : null;
  const fixedWhirlwindSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.whirlwind
    ? prepareWhirlwindSettingsForDisplay(normalized.fixedSettings)
    : null;
  const fixedLungeSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.lunge
    ? prepareLungeSettingsForDisplay(normalized.fixedSettings)
    : null;
  const fixedDoubleAttackSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.doubleAttack
    ? prepareDoubleAttackSettingsForDisplay(normalized.fixedSettings)
    : null;
  const fixedCounterAttackSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.counterAttack
    ? prepareCounterAttackSettingsForDisplay(normalized.fixedSettings)
    : null;
  const fixedOversightSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.oversight
    ? prepareOversightSettingsForDisplay(normalized.fixedSettings)
    : null;
  const fixedWatchOutSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.watchOut
    ? prepareWatchOutSettingsForDisplay(normalized.fixedSettings)
    : null;
  const fixedFullControlSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.fullControl
    ? prepareFullControlSettingsForDisplay(normalized.fixedSettings)
    : null;
  const fixedCounterSniperSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.counterSniper
    ? normalizeCounterSniperSettings(normalized.fixedSettings)
    : null;
  const fixedWhereAreYouGoingSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.whereAreYouGoing
    ? prepareWhereAreYouGoingSettingsForDisplay(normalized.fixedSettings)
    : null;
  const fixedFullForceSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.fullForce
    ? prepareFullForceSettingsForDisplay(normalized.fixedSettings)
    : null;
  const fixedTwoHandsSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.twoHands
    ? normalizeTwoHandsSettings(normalized.fixedSettings)
    : null;
  const fixedCommandBasicsSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.commandBasics
    ? prepareCommandBasicsSettingsForDisplay(normalized.fixedSettings)
    : null;
  const fixedKnockOffBalanceSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.knockOffBalance
    ? prepareKnockOffBalanceSettingsForDisplay(normalized.fixedSettings)
    : null;
  const fixedLookSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.look
    ? prepareLookSettingsForDisplay(normalized.fixedSettings)
    : null;
  const fixedToTheEndSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.toTheEnd
    ? prepareToTheEndSettingsForDisplay(normalized.fixedSettings)
    : null;
  const fixedHeightenedConcentrationSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.heightenedConcentration
    ? prepareHeightenedConcentrationSettingsForDisplay(normalized.fixedSettings)
    : null;
  const fixedAnatomyStudySettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.anatomyStudy
    ? prepareAnatomyStudySettingsForDisplay(normalized.fixedSettings)
    : null;
  const fixedSpecialMixSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.specialMix
    ? prepareSpecialMixSettingsForDisplay(normalized.fixedSettings)
    : null;
  const fixedExperimentalSurgerySettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.experimentalSurgery
    ? normalizeExperimentalSurgerySettings(normalized.fixedSettings)
    : null;
  const fixedEmergencyOperationsSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.emergencyOperations
    ? prepareEmergencyOperationsSettingsForDisplay(normalized.fixedSettings)
    : null;
  const fixedInconspicuousSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.inconspicuous
    ? prepareInconspicuousSettingsForDisplay(normalized.fixedSettings)
    : null;
  const fixedShadowSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.shadow
    ? prepareShadowSettingsForDisplay(normalized.fixedSettings)
    : null;
  const fixedSandmanSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.sandman
    ? normalizeSandmanSettings(normalized.fixedSettings)
    : null;
  const fixedNightmareSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.nightmare
    ? prepareNightmareSettingsForDisplay(normalized.fixedSettings)
    : null;
  const fixedRageSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.rage
    ? prepareRageSettingsForDisplay(normalized.fixedSettings)
    : null;
  const fixedDisarmSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.disarm
    ? prepareDisarmSettingsForDisplay(normalized.fixedSettings)
    : null;
  const hasEventReaction = normalized.conditions.some(condition => condition.type === ABILITY_CONDITION_TYPES.eventReaction);
  const hasTriggerCostCondition = normalized.conditions
    .some(condition => condition?.type === ABILITY_CONDITION_TYPES.triggerCost);
  const hasToggleableCondition = normalized.conditions
    .some(condition => condition?.type === ABILITY_CONDITION_TYPES.toggleable);
  const conditions = normalized.conditions.map(condition => prepareConditionForDisplay(condition, {
    changeCount: normalized.changes.length,
    allowLimitedChanges: isEffectChanges || isActiveApplication,
    allowEventReaction: isEffectChanges,
    allowAccumulation: isEffectChanges,
    allowToggleable: isEffectChanges
      && (!hasToggleableCondition || condition?.type === ABILITY_CONDITION_TYPES.toggleable),
    allowTriggerCost: isEffectChanges
      && (!hasTriggerCostCondition || condition?.type === ABILITY_CONDITION_TYPES.triggerCost),
    eventReactionMode: hasEventReaction,
    constructs,
    abilityFunction: normalized
  }));
  const hasRuntimeConditions = normalized.conditions.some(condition => isRuntimeCondition(condition.type));
  const preparedActions = normalized.actions.map((action, index) => prepareAbilityActionForDisplay(action, index, {
    allowEventSkillCheck: isEffectChanges && hasEventReaction,
    allowTreatmentClassShift: isActiveApplication
  }));
  return {
    ...normalized,
    isAcquisitionChanges,
    isEffectChanges,
    isActiveApplication,
    isAttackAction,
    isFixed,
    canConfigureChanges: isEffectChanges || isAcquisitionChanges || isActiveApplication,
    canConfigureActions: isEffectChanges || isActiveApplication,
    showPureValuesToggle: isEffectChanges && hasAdvancementPureValueFunctionChanges(normalized),
    fixedKey,
    activeApplicationSettings,
    attackActionSettings,
    fixedWhereAreYouGoingSettings,
    fixedDeusSettings,
    fixedCurseAndBlessingSettings,
    fixedAllOrNothingSettings,
    fixedReaperSettings,
    fixedVirtuosoSettings,
    fixedVersatileDevelopmentSettings,
    fixedAimingSettings,
    fixedRicochetSettings,
    fixedKeepAwaySettings,
    fixedLethalAttackSettings,
    fixedFourLeafCloverSettings,
    fixedAtRandomSettings,
    fixedDefensiveTacticsSettings,
    fixedLastChanceSettings,
    fixedLuckyCoinSettings,
    fixedWhirlwindSettings,
    fixedLungeSettings,
    fixedDoubleAttackSettings,
    fixedCounterAttackSettings,
    fixedOversightSettings,
    fixedWatchOutSettings,
    fixedFullControlSettings,
    fixedCounterSniperSettings,
    fixedFullForceSettings,
    fixedTwoHandsSettings,
    fixedCommandBasicsSettings,
    fixedKnockOffBalanceSettings,
    fixedLookSettings,
    fixedToTheEndSettings,
    fixedHeightenedConcentrationSettings,
    fixedAnatomyStudySettings,
    fixedSpecialMixSettings,
    fixedExperimentalSurgerySettings,
    fixedEmergencyOperationsSettings,
    fixedInconspicuousSettings,
    fixedShadowSettings,
    fixedSandmanSettings,
    fixedNightmareSettings,
    fixedRageSettings,
    fixedDisarmSettings,
    hasEventReaction,
    hasUnsupportedEventReactionPenalties: hasEventReaction && Boolean(normalized.penalties.length),
    typeLabel: getAbilityFunctionTypeLabel(normalized, fixedKey),
    changes: normalized.changes.map((change, index) => (
      prepareChangeForDisplay(change, index, normalized.conditions)
    )),
    actions: preparedActions,
    ordinaryActions: preparedActions,
    hasOrdinaryActions: Boolean(preparedActions.length),
    conditions,
    conditionGroups: buildConditionDisplayGroups(conditions),
    penalties: normalized.penalties.map(prepareChangeForDisplay),
    hasConditions: Boolean(normalized.conditions.length),
    hasPenalties: Boolean(normalized.penalties.length),
    canAddPenalty: !hasEventReaction && hasRuntimeConditions
  };
}

function prepareAbilityActionForDisplay(action, index, {
  allowEventSkillCheck = false,
  allowTreatmentClassShift = false
} = {}) {
  const type = String(action?.type ?? "");
  const isPending = !type;
  const isWeaponAttack = type === ABILITY_ACTION_TYPES.weaponAttack;
  const isMovementRoute = type === ABILITY_ACTION_TYPES.movementRoute;
  const isEventSkillCheck = type === ABILITY_ACTION_TYPES.eventSkillCheck;
  const isTreatmentClassShift = type === ABILITY_ACTION_TYPES.treatmentClassShift;
  const typeChoices = [
    { value: "", label: "", selected: isPending },
    {
      value: ABILITY_ACTION_TYPES.weaponAttack,
      label: game.i18n.localize("FALLOUTMAW.Ability.Actions.WeaponAttack"),
      selected: isWeaponAttack
    },
    {
      value: ABILITY_ACTION_TYPES.movementRoute,
      label: game.i18n.localize("FALLOUTMAW.Ability.Actions.MovementRoute"),
      selected: isMovementRoute
    },
    ...((allowEventSkillCheck || isEventSkillCheck) ? [{
      value: ABILITY_ACTION_TYPES.eventSkillCheck,
      label: game.i18n.localize("FALLOUTMAW.Ability.Actions.EventSkillCheck"),
      selected: isEventSkillCheck
    }] : []),
    ...((allowTreatmentClassShift || isTreatmentClassShift) ? [{
      value: ABILITY_ACTION_TYPES.treatmentClassShift,
      label: "Разовое изменение класса травм/болезней",
      selected: isTreatmentClassShift
    }] : [])
  ];
  const common = {
    ...action,
    index,
    typeChoices,
    executorModeChoices: [
      { value: ABILITY_ACTION_EXECUTOR_MODES.source, label: game.i18n.localize("FALLOUTMAW.Ability.Actions.ExecutorSource"), selected: action.executorMode === ABILITY_ACTION_EXECUTOR_MODES.source },
      { value: ABILITY_ACTION_EXECUTOR_MODES.targets, label: game.i18n.localize("FALLOUTMAW.Ability.Actions.ExecutorTargets"), selected: action.executorMode === ABILITY_ACTION_EXECUTOR_MODES.targets }
    ],
    targetModeChoices: [
      { value: ABILITY_ACTION_TARGET_MODES.triggerActor, label: game.i18n.localize("FALLOUTMAW.Ability.Actions.TargetTrigger"), selected: action.targetMode === ABILITY_ACTION_TARGET_MODES.triggerActor },
      { value: ABILITY_ACTION_TARGET_MODES.free, label: game.i18n.localize("FALLOUTMAW.Ability.Actions.TargetFree"), selected: action.targetMode === ABILITY_ACTION_TARGET_MODES.free }
    ],
    costModeChoices: [
      { value: ABILITY_ACTION_POINT_COST_MODES.none, label: game.i18n.localize("FALLOUTMAW.Ability.Actions.CostNone"), selected: action.actionPointCostMode === ABILITY_ACTION_POINT_COST_MODES.none },
      { value: ABILITY_ACTION_POINT_COST_MODES.fixed, label: game.i18n.localize("FALLOUTMAW.Ability.Actions.CostFixed"), selected: action.actionPointCostMode === ABILITY_ACTION_POINT_COST_MODES.fixed },
      { value: ABILITY_ACTION_POINT_COST_MODES.actual, label: game.i18n.localize("FALLOUTMAW.Ability.Actions.CostActual"), selected: action.actionPointCostMode === ABILITY_ACTION_POINT_COST_MODES.actual }
    ],
    actionPointPayerChoices: [
      { value: ABILITY_ACTION_POINT_PAYERS.source, label: game.i18n.localize("FALLOUTMAW.Ability.Actions.ActionPointPayerSource"), selected: action.actionPointPayer === ABILITY_ACTION_POINT_PAYERS.source },
      { value: ABILITY_ACTION_POINT_PAYERS.executor, label: game.i18n.localize("FALLOUTMAW.Ability.Actions.ActionPointPayerExecutor"), selected: action.actionPointPayer === ABILITY_ACTION_POINT_PAYERS.executor }
    ],
    usesFixedActionPointCost: action.actionPointCostMode === ABILITY_ACTION_POINT_COST_MODES.fixed,
    usesActualActionPointCost: action.actionPointCostMode === ABILITY_ACTION_POINT_COST_MODES.actual
  };
  if (isPending || (!isWeaponAttack && !isMovementRoute && !isEventSkillCheck && !isTreatmentClassShift)) {
    return {
      ...common,
      isPending,
      isWeaponAttack: false,
      isMovementRoute: false,
      isEventSkillCheck: false,
      isTreatmentClassShift: false,
      typeChoices
    };
  }
  if (isTreatmentClassShift) {
    const shift = action?.treatmentClassShift ?? {};
    return {
      ...common,
      isPending: false,
      isWeaponAttack: false,
      isMovementRoute: false,
      isEventSkillCheck: false,
      isTreatmentClassShift: true,
      shiftsTraumas: shift.itemTypes?.includes("trauma"),
      shiftsDiseases: shift.itemTypes?.includes("disease")
    };
  }
  if (isEventSkillCheck) {
    return {
      ...common,
      isPending: false,
      isWeaponAttack: false,
      isMovementRoute: false,
      isEventSkillCheck: true,
      skillChoices: [
        { value: "", label: game.i18n.localize("FALLOUTMAW.Ability.Actions.EventSkillInherited"), selected: !action.skillKey },
        ...buildSkillChoices(action.skillKey, getSkillSettings())
      ],
      skillSuccessControlChoices: buildAbilityEventControlChoices(action.skillSuccessControl),
      skillFailureControlChoices: buildAbilityEventControlChoices(action.skillFailureControl)
    };
  }
  if (isMovementRoute) {
    return {
      ...common,
      isPending: false,
      isWeaponAttack: false,
      isMovementRoute: true,
      isEventSkillCheck: false,
      routeBudgetModeChoices: [
        { value: ABILITY_ACTION_ROUTE_BUDGET_MODES.movementCost, label: game.i18n.localize("FALLOUTMAW.Ability.Actions.RouteBudgetMovementCost"), selected: action.routeBudgetMode === ABILITY_ACTION_ROUTE_BUDGET_MODES.movementCost },
        { value: ABILITY_ACTION_ROUTE_BUDGET_MODES.distance, label: game.i18n.localize("FALLOUTMAW.Ability.Actions.RouteBudgetDistance"), selected: action.routeBudgetMode === ABILITY_ACTION_ROUTE_BUDGET_MODES.distance }
      ],
      routeEvaluationChoices: [
        { value: ABILITY_ACTION_ROUTE_EVALUATION_MODES.source, label: game.i18n.localize("FALLOUTMAW.Ability.Actions.RouteEvaluationSource"), selected: action.routeBudgetEvaluation === ABILITY_ACTION_ROUTE_EVALUATION_MODES.source },
        { value: ABILITY_ACTION_ROUTE_EVALUATION_MODES.executor, label: game.i18n.localize("FALLOUTMAW.Ability.Actions.RouteEvaluationExecutor"), selected: action.routeBudgetEvaluation === ABILITY_ACTION_ROUTE_EVALUATION_MODES.executor }
      ],
      routeExecutionChoices: [
        { value: ABILITY_MOVEMENT_ROUTE_EXECUTION_MODES.sequential, label: game.i18n.localize("FALLOUTMAW.Ability.Actions.RouteExecutionSequential"), selected: action.routeExecutionMode === ABILITY_MOVEMENT_ROUTE_EXECUTION_MODES.sequential },
        { value: ABILITY_MOVEMENT_ROUTE_EXECUTION_MODES.parallel, label: game.i18n.localize("FALLOUTMAW.Ability.Actions.RouteExecutionParallel"), selected: action.routeExecutionMode === ABILITY_MOVEMENT_ROUTE_EXECUTION_MODES.parallel }
      ],
      routeMovementActionChoices: buildAbilityMovementActionChoices(action.routeMovementAction)
    };
  }
  const selected = new Set(action.attackActionKeys ?? []);
  const allSelected = selected.has(ABILITY_ATTACK_ACTION_ALL);
  const choices = [
    { key: ABILITY_ATTACK_ACTION_ALL, label: game.i18n.localize("FALLOUTMAW.Ability.Actions.AllAttacks") },
    ...buildWeaponActionEntries()
  ];
  return {
    ...common,
    isPending: false,
    isWeaponAttack: true,
    isMovementRoute: false,
    isEventSkillCheck: false,
    typeChoices,
    attackActionRows: (allSelected ? [ABILITY_ATTACK_ACTION_ALL] : action.attackActionKeys).map((selectedKey, choiceIndex) => ({
      choiceIndex,
      choices: choices.map(choice => ({ ...choice, selected: choice.key === selectedKey }))
    })),
    canAddAttackAction: !allSelected && selected.size < ABILITY_ATTACKING_WEAPON_ACTION_KEYS.length,
    canDeleteAttackAction: !allSelected && selected.size > 1,
    usesFixedActionPointCost: action.actionPointCostMode === ABILITY_ACTION_POINT_COST_MODES.fixed,
    usesActualActionPointCost: action.actionPointCostMode === ABILITY_ACTION_POINT_COST_MODES.actual,
    executorModeChoices: [
      { value: ABILITY_ACTION_EXECUTOR_MODES.source, label: game.i18n.localize("FALLOUTMAW.Ability.Actions.ExecutorSource"), selected: action.executorMode === ABILITY_ACTION_EXECUTOR_MODES.source },
      { value: ABILITY_ACTION_EXECUTOR_MODES.targets, label: game.i18n.localize("FALLOUTMAW.Ability.Actions.ExecutorTargets"), selected: action.executorMode === ABILITY_ACTION_EXECUTOR_MODES.targets }
    ],
    targetModeChoices: [
      { value: ABILITY_ACTION_TARGET_MODES.triggerActor, label: game.i18n.localize("FALLOUTMAW.Ability.Actions.TargetTrigger"), selected: action.targetMode === ABILITY_ACTION_TARGET_MODES.triggerActor },
      { value: ABILITY_ACTION_TARGET_MODES.free, label: game.i18n.localize("FALLOUTMAW.Ability.Actions.TargetFree"), selected: action.targetMode === ABILITY_ACTION_TARGET_MODES.free }
    ],
    costModeChoices: [
      { value: ABILITY_ACTION_POINT_COST_MODES.none, label: game.i18n.localize("FALLOUTMAW.Ability.Actions.CostNone"), selected: action.actionPointCostMode === ABILITY_ACTION_POINT_COST_MODES.none },
      { value: ABILITY_ACTION_POINT_COST_MODES.fixed, label: game.i18n.localize("FALLOUTMAW.Ability.Actions.CostFixed"), selected: action.actionPointCostMode === ABILITY_ACTION_POINT_COST_MODES.fixed },
      { value: ABILITY_ACTION_POINT_COST_MODES.actual, label: game.i18n.localize("FALLOUTMAW.Ability.Actions.CostActual"), selected: action.actionPointCostMode === ABILITY_ACTION_POINT_COST_MODES.actual }
    ]
  };
}

function buildAbilityMovementActionChoices(selectedValue = "") {
  const selected = String(selectedValue ?? "").trim();
  const actions = Object.entries(globalThis.CONFIG?.Token?.movement?.actions ?? {})
    .sort(([leftKey, left], [rightKey, right]) => (
      (Number(left?.order) || 0) - (Number(right?.order) || 0)
      || leftKey.localeCompare(rightKey)
    ));
  return [
    {
      value: "",
      label: game.i18n.localize("FALLOUTMAW.Ability.Actions.RouteMovementCurrent"),
      selected: !selected
    },
    ...actions.map(([value, config]) => ({
      value,
      label: game.i18n.localize(String(config?.label ?? value)),
      selected: selected === value
    }))
  ];
}

function syncAbilityActionCostVisibility(select) {
  const actionRow = select?.closest?.("[data-ability-action-row]");
  if (!actionRow) return;
  const mode = String(select.value ?? "");
  const fixed = actionRow.querySelector("[data-ability-action-fixed-cost]");
  const actual = actionRow.querySelector("[data-ability-action-actual-cost]");
  if (fixed) fixed.hidden = mode !== ABILITY_ACTION_POINT_COST_MODES.fixed;
  if (actual) actual.hidden = mode !== ABILITY_ACTION_POINT_COST_MODES.actual;
}

function syncAbilityAttackChoiceControls(select) {
  const actionRow = select?.closest?.("[data-ability-action-row]");
  if (!actionRow) return;
  const selects = Array.from(actionRow.querySelectorAll("[data-field='action.attackActionKey']"));
  const selected = new Set(selects.map(entry => String(entry.value ?? "")));
  const locked = selected.has(ABILITY_ATTACK_ACTION_ALL);
  const add = actionRow.querySelector("[data-action='addFunctionAttackChoice']");
  if (add) add.disabled = locked || selected.size >= ABILITY_ATTACKING_WEAPON_ACTION_KEYS.length;
  for (const button of actionRow.querySelectorAll("[data-action='deleteFunctionAttackChoice']")) {
    button.disabled = locked || selects.length <= 1;
  }
}

function prepareTriggerCostRowsForDisplay(costs = []) {
  return normalizeTriggerCostRows(costs).map((cost, index) => {
    const overloadDuration = splitDurationSeconds(cost.overloadDurationSeconds);
    return {
      ...cost,
      index,
      overloadDurationAmount: cost.overloadDurationSeconds > 0 ? overloadDuration.amount : "",
      overloadDurationUnitChoices: buildDurationUnitChoices(overloadDuration.unit),
      resourceChoices: buildEventReactionResourceChoices(cost.resourceKey),
      isUnsupportedResource: !isKnownEventReactionResource(cost.resourceKey)
    };
  });
}

function prepareActiveApplicationCostRowsForDisplay(costs = []) {
  return (Array.isArray(costs) ? costs : Object.values(costs ?? {})).map((source, index) => {
    const cost = normalizeActiveApplicationCost(source);
    const overloadDuration = splitDurationSeconds(cost.overloadDurationSeconds);
    return {
      ...cost,
      index,
      overloadDurationAmount: cost.overloadDurationSeconds > 0 ? overloadDuration.amount : "",
      overloadDurationUnitChoices: buildDurationUnitChoices(overloadDuration.unit),
      resourceChoices: buildEventReactionResourceChoices(cost.resourceKey),
      payerChoices: [
        {
          value: ABILITY_ACTIVE_APPLICATION_COST_PAYERS.source,
          label: game.i18n.localize("FALLOUTMAW.Ability.ActiveApplication.CostPayerSource"),
          selected: cost.payer === ABILITY_ACTIVE_APPLICATION_COST_PAYERS.source
        },
        {
          value: ABILITY_ACTIVE_APPLICATION_COST_PAYERS.targets,
          label: game.i18n.localize("FALLOUTMAW.Ability.ActiveApplication.CostPayerTargets"),
          selected: cost.payer === ABILITY_ACTIVE_APPLICATION_COST_PAYERS.targets
        }
      ],
      isUnsupportedResource: !isKnownEventReactionResource(cost.resourceKey)
    };
  });
}

function normalizeTriggerCostRows(costs = []) {
  return normalizeEventReactionSettings({ costs }).costs;
}

function prepareChangeForDisplay(change, index, conditions = []) {
  return {
    ...change,
    index,
    priority: change.priority ?? "",
    typeChoices: buildChangeTypeChoices(change.type),
    accumulatorExchangeSettings: prepareAbilityAccumulatorExchangeForDisplay(change, conditions)
  };
}

function prepareDeusExMachinaSettingsForDisplay(settings = {}) {
  const normalized = normalizeDeusExMachinaSettings(settings);
  const duration = splitDurationSeconds(normalized.insight.durationSeconds);
  return {
    ...normalized,
    insightDurationAmount: duration.amount,
    insightDurationUnitChoices: buildDurationUnitChoices(duration.unit),
    restoreModeChoices: [
      { value: "all", label: "Все ключевые конечности", selected: normalized.rescue.restoreMode === "all" },
      { value: "count", label: "Ограниченное число", selected: normalized.rescue.restoreMode !== "all" }
    ],
    isRestoreCountMode: normalized.rescue.restoreMode !== "all"
  };
}

function prepareCurseAndBlessingSettingsForDisplay(settings = {}) {
  const normalized = normalizeCurseAndBlessingSettings(settings);
  const duration = splitDurationSeconds(normalized.durationSeconds);
  return {
    ...normalized,
    durationAmount: duration.amount,
    durationUnitChoices: buildDurationUnitChoices(duration.unit)
  };
}

function prepareAllOrNothingSettingsForDisplay(settings = {}) {
  const normalized = normalizeAllOrNothingSettings(settings);
  const duration = splitDurationSeconds(normalized.overloadDurationSeconds);
  return {
    ...normalized,
    overloadDurationAmount: duration.amount,
    overloadDurationUnitChoices: buildDurationUnitChoices(duration.unit)
  };
}

function prepareReaperSettingsForDisplay(settings = {}) {
  return normalizeReaperSettings(settings);
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

function prepareLastChanceSettingsForDisplay(settings = {}) {
  const normalized = normalizeLastChanceSettings(settings);
  const duration = splitDurationSeconds(normalized.overloadDurationSeconds);
  return {
    ...normalized,
    overloadDurationAmount: duration.amount,
    overloadDurationUnitChoices: buildDurationUnitChoices(duration.unit)
  };
}

function prepareLuckyCoinSettingsForDisplay(settings = {}) {
  const normalized = normalizeLuckyCoinSettings(settings);
  const duration = splitDurationSeconds(normalized.overloadDurationSeconds);
  return {
    ...normalized,
    overloadDurationAmount: duration.amount,
    overloadDurationUnitChoices: buildDurationUnitChoices(duration.unit)
  };
}

function prepareWhirlwindSettingsForDisplay(settings = {}) {
  const normalized = normalizeWhirlwindSettings(settings);
  const duration = splitDurationSeconds(normalized.overloadDurationSeconds);
  return {
    ...normalized,
    overloadDurationAmount: duration.amount,
    overloadDurationUnitChoices: buildDurationUnitChoices(duration.unit)
  };
}

function prepareLungeSettingsForDisplay(settings = {}) {
  const normalized = normalizeLungeSettings(settings);
  const duration = splitDurationSeconds(normalized.overloadDurationSeconds);
  return {
    ...normalized,
    overloadDurationAmount: duration.amount,
    overloadDurationUnitChoices: buildDurationUnitChoices(duration.unit)
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
  const overloadDuration = splitDurationSeconds(normalized.reactionOverloadDurationSeconds);
  return {
    ...normalized,
    reactionOverloadDurationAmount: overloadDuration.amount,
    reactionOverloadDurationUnitChoices: buildDurationUnitChoices(overloadDuration.unit),
    skillChoices: buildSkillChoices(normalized.requiredSkillKey, getSkillSettings())
  };
}

function prepareOversightSettingsForDisplay(settings = {}) {
  const normalized = normalizeOversightSettings(settings);
  const overloadDuration = splitDurationSeconds(normalized.overloadDurationSeconds);
  const skills = getSkillSettings();
  return {
    ...normalized,
    overloadDurationAmount: overloadDuration.amount,
    overloadDurationUnitChoices: buildDurationUnitChoices(overloadDuration.unit),
    sourceSkillChoices: buildSkillChoices(normalized.sourceSkillKey, skills),
    targetSkillChoices: buildSkillChoices(normalized.targetSkillKey, skills)
  };
}

function prepareWatchOutSettingsForDisplay(settings = {}) {
  const normalized = normalizeWatchOutSettings(settings);
  const overloadDuration = splitDurationSeconds(normalized.reactionOverloadDurationSeconds);
  return {
    ...normalized,
    reactionOverloadDurationAmount: overloadDuration.amount,
    reactionOverloadDurationUnitChoices: buildDurationUnitChoices(overloadDuration.unit),
    sourceSkillChoices: buildSkillChoices(normalized.sourceSkillKey, getSkillSettings())
  };
}

function prepareFullControlSettingsForDisplay(settings = {}) {
  const normalized = normalizeFullControlSettings(settings);
  const duration = splitDurationSeconds(normalized.durationSeconds);
  return {
    ...normalized,
    durationAmount: duration.amount,
    durationUnitChoices: buildDurationUnitChoices(duration.unit),
    limitSkillChoices: buildSkillChoices(normalized.limitSkillKey, getSkillSettings())
  };
}

function prepareWhereAreYouGoingSettingsForDisplay(settings = {}) {
  const normalized = normalizeWhereAreYouGoingSettings(settings);
  const overloadDuration = splitDurationSeconds(normalized.reactionOverloadDurationSeconds);
  return {
    ...normalized,
    reactionOverloadDurationAmount: overloadDuration.amount,
    reactionOverloadDurationUnitChoices: buildDurationUnitChoices(overloadDuration.unit)
  };
}

function prepareFullForceSettingsForDisplay(settings = {}) {
  const normalized = normalizeFullForceSettings(settings);
  return {
    ...normalized,
    skillChoices: buildSkillChoices(normalized.requiredSkillKey, getSkillSettings())
  };
}

function getAbilityFunctionTypeLabel(entry, fixedKey = "") {
  if (entry.type === ABILITY_FUNCTION_TYPES.fixed) return getFixedAbilityFunctionLabel(fixedKey);
  if (entry.type === ABILITY_FUNCTION_TYPES.activeApplication) return "Активное применение";
  if (entry.type === ABILITY_FUNCTION_TYPES.attackAction) return "Атакующее действие";
  if (entry.type === ABILITY_FUNCTION_TYPES.acquisitionChanges) return "Разовое изменение при приобретении";
  return "Свободная настройка";
}

function prepareActiveApplicationSettingsForDisplay(settings = {}) {
  const normalized = normalizeActiveApplicationSettings(settings);
  return {
    ...normalized,
    activationCosts: prepareActiveApplicationCostRowsForDisplay(normalized.costs),
    targetModeChoices: [
      { value: ABILITY_ACTIVE_APPLICATION_TARGET_MODES.self, label: "Себе", selected: normalized.targetMode === ABILITY_ACTIVE_APPLICATION_TARGET_MODES.self },
      { value: ABILITY_ACTIVE_APPLICATION_TARGET_MODES.others, label: "Другим", selected: normalized.targetMode === ABILITY_ACTIVE_APPLICATION_TARGET_MODES.others }
    ],
    targetSelectionModeChoices: [
      { value: ABILITY_ACTIVE_APPLICATION_SELECTION_MODES.manual, label: "Ручной выбор", selected: normalized.targetSelectionMode === ABILITY_ACTIVE_APPLICATION_SELECTION_MODES.manual },
      { value: ABILITY_ACTIVE_APPLICATION_SELECTION_MODES.all, label: "Все подходящие", selected: normalized.targetSelectionMode === ABILITY_ACTIVE_APPLICATION_SELECTION_MODES.all }
    ],
    changeEvaluationChoices: [
      { value: "target", label: "От параметров цели", selected: normalized.changeEvaluation === "target" },
      { value: "source", label: "От параметров активатора (снимок)", selected: normalized.changeEvaluation === "source" }
    ],
    isTargetOthers: normalized.targetMode === ABILITY_ACTIVE_APPLICATION_TARGET_MODES.others,
    isManualTargetSelection: normalized.targetSelectionMode === ABILITY_ACTIVE_APPLICATION_SELECTION_MODES.manual,
    targetGroupChoices: buildTargetGroupChoices(normalized.targetGroups)
  };
}

function prepareAttackActionSettingsForDisplay(settings = {}, constructs = []) {
  const normalized = normalizeAttackActionSettings(settings);
  const damageTypes = getConfigurableDamageTypes(getDamageTypeSettings());
  const targetMode = String(normalized.targeting?.mode ?? "cone");
  const resourceCosts = (normalized.resourceCosts ?? []).map((cost, index) => {
    const overloadDuration = splitDurationSeconds(cost.overloadDurationSeconds);
    return {
      ...cost,
      index,
      resourceChoices: buildEventReactionResourceChoices(cost.resourceKey),
      isUnsupportedResource: !isKnownEventReactionResource(cost.resourceKey),
      overloadDurationAmount: cost.overloadDurationSeconds > 0 ? overloadDuration.amount : "",
      overloadDurationUnitChoices: buildDurationUnitChoices(overloadDuration.unit)
    };
  });
  return {
    ...normalized,
    attackSoundVolume: normalizeAttackSoundVolume(normalized.attackSoundVolume),
    attackSoundVolumePercent: formatAttackSoundVolumePercent(normalized.attackSoundVolume),
    targetModeChoices: [
      { value: "cone", label: "Конус", selected: targetMode === "cone" },
      { value: "selectedTargets", label: "Выбранные цели", selected: targetMode === "selectedTargets" },
      { value: "area", label: "Область", selected: targetMode === "area" }
    ],
    isCone: targetMode === "cone",
    isTargets: targetMode === "selectedTargets",
    isArea: targetMode === "area",
    proficiencyChoices: buildAttackProficiencyChoices(normalized.proficiencyKey),
    skillChoices: buildSkillChoices(normalized.skillKey, getSkillSettings()),
    damageTypeRows: (normalized.damageTypes ?? []).map((entry, index) => ({
      ...entry,
      index,
      choices: buildAttackDamageTypeChoices(entry.key, damageTypes)
    })),
    resourceCosts,
    hitResolution: {
      trials: buildAttackHitTrialRows(normalized.hitResolution?.trials, constructs)
    },
    area: {
      ...normalized.area,
      regionDamageRows: (normalized.area?.regionDamageEntries ?? []).map((entry, index) => ({
        ...entry,
        index,
        choices: buildAttackDamageTypeChoices(entry.damageTypeKey, damageTypes)
      }))
      ,regionSpecialProperties: buildAttackRegionSpecialPropertyRows(normalized.area?.regionSpecialProperties)
    },
    specialProperties: prepareAttackSpecialPropertiesForDisplay(
      normalized.specialProperties,
      resourceCosts,
      normalized.hitResolution,
      normalized.proficiencyKey
    ),
    requirements: prepareAttackRequirementsForDisplay(normalized.requirements),
    criticalFailureConsequences: (normalized.criticalFailureConsequences ?? []).map((entry, index) => ({
      ...entry,
      index,
      resourceChoices: buildAttackConfiguredResourceChoices(resourceCosts, entry.resourceKey)
    }))
  };
}

function buildAttackRegionSpecialPropertyRows(properties = []) {
  return normalizeRegionSpecialProperties(properties).map((property, index) => ({
    ...property,
    index,
    isSmoke: property.type === REGION_SPECIAL_PROPERTY_SMOKE,
    choices: [
      {
        value: REGION_SPECIAL_PROPERTY_PENDING,
        label: game.i18n.localize("FALLOUTMAW.RegionBehavior.PeriodicDamage.ChooseSpecialProperty")
      },
      {
        value: REGION_SPECIAL_PROPERTY_SMOKE,
        label: game.i18n.localize("FALLOUTMAW.RegionBehavior.PeriodicDamage.Smoke")
      }
    ].map(choice => ({ ...choice, selected: choice.value === property.type }))
  }));
}

function buildAttackHitTrialRows(value = [], constructs = []) {
  const trials = Array.isArray(value) ? value : Object.values(value ?? {});
  return trials.map((trial, index) => {
    const subject = trial?.subject === "source" ? "source" : "targets";
    return {
      ...trial,
      index,
      number: index + 1,
      isSource: subject === "source",
      canMoveUp: index > 0,
      canMoveDown: index < trials.length - 1,
      subjectChoices: [
        { value: "source", label: "Применяющий" },
        { value: "targets", label: "Цели" }
      ].map(choice => ({ ...choice, selected: choice.value === subject })),
      sourceModeChoices: [
        { value: "once", label: "Один раз за применение" },
        { value: "perTarget", label: "Отдельно для каждой цели" }
      ].map(choice => ({ ...choice, selected: choice.value === trial?.sourceMode })),
      selectionModeChoices: [
        { value: "best", label: "Лучшее текущее значение" },
        { value: "worst", label: "Худшее текущее значение" }
      ].map(choice => ({ ...choice, selected: choice.value === trial?.selectionMode })),
      entries: (trial?.entries ?? []).map((entry, entryIndex) => ({
        ...entry,
        index: entryIndex,
        skillChoices: buildSkillChoices(entry?.key, getSkillSettings())
      })),
      outcomes: ATTACK_HIT_OUTCOME_KEYS.map(resultKey => (
        buildAttackHitOutcomeRow(trial?.outcomes?.[resultKey], resultKey, constructs)
      ))
    };
  });
}

function buildAttackHitOutcomeRow(outcome = {}, resultKey = "failure", constructs = []) {
  const labels = {
    criticalFailure: "Критический провал",
    failure: "Провал",
    success: "Успех",
    criticalSuccess: "Критический успех"
  };
  return {
    ...outcome,
    resultKey,
    label: labels[resultKey] ?? resultKey,
    consequenceCount: outcome?.links?.length ?? 0,
    flowChoices: [
      { value: "continue", label: "Продолжить цепочку" },
      { value: "stopSubject", label: "Остановить для этого участника" },
      { value: "stopAll", label: "Остановить всю атаку" }
    ].map(choice => ({ ...choice, selected: choice.value === outcome?.flow })),
    links: buildAttackHitOutcomeLinkRows(outcome?.links, constructs)
  };
}

function buildAttackHitOutcomeLinkRows(value = [], constructs = []) {
  const normalizedConstructs = normalizeAbilityConstructs(constructs);
  return (Array.isArray(value) ? value : Object.values(value ?? {})).map((link, index) => {
    const constructId = String(link?.constructId ?? "");
    const constructIndex = normalizedConstructs.findIndex(construct => construct.id === constructId);
    const construct = constructIndex >= 0
      ? prepareAbilityConstructForDisplay(normalizedConstructs[constructIndex], constructIndex)
      : null;
    return {
      ...link,
      index,
      construct,
      hasConstruct: Boolean(construct),
      recipientChoices: [
        { value: "subjects", label: "Проходившие это испытание" },
        { value: "source", label: "Применяющий" },
        { value: "targets", label: "Все цели атаки" }
      ].map(choice => ({ ...choice, selected: choice.value === link?.recipient })),
      modeChoices: [
        { value: "perSubject", label: "Отдельно каждому участнику" },
        { value: "once", label: "Один раз" }
      ].map(choice => ({ ...choice, selected: choice.value === link?.mode }))
    };
  });
}

function buildAttackDamageAmountModeChoices(selected = "base") {
  return [
    { value: "base", label: "Базовый урон оружия" },
    { value: "formula", label: "Своя формула урона" },
    { value: "percent", label: "Процент базового урона" }
  ].map(choice => ({ ...choice, selected: choice.value === selected }));
}

function buildAttackDamageLimbModeChoices(selected = "random") {
  return [
    { value: "random", label: "Случайная часть тела" },
    { value: "randomCritical", label: "Случайная ключевая конечность" },
    { value: "selected", label: "Выбранная часть тела" },
    { value: "healthOnly", label: "Только общее здоровье" }
  ].map(choice => ({ ...choice, selected: choice.value === selected }));
}

function buildAttackDamageTypeChoices(selected = "", damageTypes = getConfigurableDamageTypes(getDamageTypeSettings())) {
  const key = String(selected ?? "").trim();
  const entries = [...damageTypes];
  if (key && !entries.some(entry => entry.key === key)) {
    entries.push({ key, label: key });
  }
  return entries.map(entry => ({
    value: entry.key,
    label: entry.label || entry.key,
    selected: entry.key === key
  }));
}

function buildAttackProficiencyChoices(selected = "") {
  const key = String(selected ?? "").trim();
  const entries = [...getProficiencySettings()];
  if (key && !entries.some(entry => entry.key === key)) entries.push({ key, label: key });
  if (!entries.length) return [{ value: "", label: "Владения не настроены", selected: true }];
  return entries.map(entry => ({
    value: entry.key,
    label: entry.label || entry.key,
    selected: entry.key === key
  }));
}

function prepareAttackSpecialPropertiesForDisplay(
  properties = [],
  resourceCosts = [],
  hitResolution = {},
  primaryProficiencyKey = ""
) {
  const source = Array.isArray(properties) ? properties : Object.values(properties ?? {});
  const normalized = source.map(property => ({
    ...(property && typeof property === "object" ? property : {}),
    type: getWeaponSpecialPropertyType(property)
  }));
  const weaponProficienciesEnabled = getActiveRulesProfile().weaponProficienciesEnabled !== false;
  return normalized.map((property, index) => {
    const type = getWeaponSpecialPropertyType(property);
    const attackPower = normalizeWeaponAttackPowerData(property.attackPower);
    const criticalDamage = normalizeWeaponCriticalDamageData(property.criticalDamage);
    const usedCriticalOutcomeIds = new Set(normalized
      .filter((candidate, candidateIndex) => (
        candidateIndex !== index
        && getWeaponSpecialPropertyType(candidate) === WEAPON_SPECIAL_PROPERTIES.criticalDamage
      ))
      .map(candidate => normalizeWeaponCriticalDamageData(candidate.criticalDamage).outcomeId)
      .filter(Boolean));
    const configuredPowerCosts = Array.isArray(property?.attackPower?.resourceCosts)
      ? property.attackPower.resourceCosts
      : Object.values(property?.attackPower?.resourceCosts ?? {});
    return {
      ...property,
      index,
      type,
      isAttackPower: type === WEAPON_SPECIAL_PROPERTIES.attackPower,
      isCriticalDamage: type === WEAPON_SPECIAL_PROPERTIES.criticalDamage,
      isAdditionalProficiencies: type === WEAPON_SPECIAL_PROPERTIES.additionalProficiencies
        && weaponProficienciesEnabled,
      additionalProficiencyRows: buildAttackAdditionalProficiencyRows(property, primaryProficiencyKey),
      choices: buildAttackSpecialPropertyChoices(type, normalized),
      criticalDamage: {
        ...criticalDamage,
        outcomeChoices: buildAttackCriticalDamageOutcomeChoices(
          hitResolution,
          criticalDamage.outcomeId,
          usedCriticalOutcomeIds
        )
      },
      attackPower: {
        ...attackPower,
        resourceCostRows: buildAttackPowerResourceCostRows(
          resourceCosts,
          configuredPowerCosts
        )
      }
    };
  });
}

function buildAttackSpecialPropertyChoices(selected = "", properties = []) {
  const used = new Set(properties.map(property => getWeaponSpecialPropertyType(property)));
  const weaponProficienciesEnabled = getActiveRulesProfile().weaponProficienciesEnabled !== false;
  return [
    { value: WEAPON_SPECIAL_PROPERTIES.pending, label: "Выберите свойство" },
    {
      value: WEAPON_SPECIAL_PROPERTIES.hitAllConeTargets,
      label: game.i18n.localize("FALLOUTMAW.Item.WeaponSpecialHitAllConeTargets")
    },
    {
      value: WEAPON_SPECIAL_PROPERTIES.attackPower,
      label: game.i18n.localize("FALLOUTMAW.Item.WeaponSpecialAttackPower")
    },
    {
      value: WEAPON_SPECIAL_PROPERTIES.criticalDamage,
      label: "Критический урон по исходу"
    },
    {
      value: WEAPON_SPECIAL_PROPERTIES.additionalProficiencies,
      label: game.i18n.localize("FALLOUTMAW.Item.WeaponSpecialAdditionalProficiencies")
    }
  ].filter(choice => (
    weaponProficienciesEnabled
    || choice.value !== WEAPON_SPECIAL_PROPERTIES.additionalProficiencies
  )).map(choice => ({
    ...choice,
    selected: choice.value === selected,
    disabled: Boolean(
      choice.value !== WEAPON_SPECIAL_PROPERTIES.pending
      && choice.value !== WEAPON_SPECIAL_PROPERTIES.criticalDamage
      && choice.value !== selected
      && used.has(choice.value)
    )
  }));
}

function buildAttackAdditionalProficiencyRows(property = {}, primaryProficiencyKey = "") {
  const keys = normalizeWeaponAdditionalProficiencyKeys(property?.proficiencyKeys);
  const used = new Set(keys);
  const primary = String(primaryProficiencyKey ?? "").trim();
  return keys.map((key, index) => ({
    index,
    choices: getProficiencySettings().map(proficiency => ({
      value: proficiency.key,
      label: proficiency.label || proficiency.key,
      selected: proficiency.key === key,
      disabled: proficiency.key !== key && (proficiency.key === primary || used.has(proficiency.key))
    }))
  }));
}

function buildAttackCriticalDamageOutcomeChoices(
  hitResolution = {},
  selected = "",
  unavailableIds = new Set()
) {
  const selectedId = String(selected ?? "").trim();
  const labels = {
    criticalFailure: "Критический провал",
    failure: "Провал",
    success: "Успех",
    criticalSuccess: "Критический успех"
  };
  const trials = Array.isArray(hitResolution?.trials)
    ? hitResolution.trials
    : Object.values(hitResolution?.trials ?? {});
  const choices = trials.flatMap((trial, trialIndex) => (
    ATTACK_HIT_OUTCOME_KEYS.map(resultKey => {
      const value = String(trial?.outcomes?.[resultKey]?.id ?? "").trim();
      return {
        value,
        label: `Испытание ${trialIndex + 1} — ${labels[resultKey] ?? resultKey}`,
        selected: value === selectedId,
        disabled: !value || (unavailableIds.has(value) && value !== selectedId)
      };
    })
  )).filter(choice => choice.value);
  if (selectedId && !choices.some(choice => choice.value === selectedId)) {
    choices.push({
      value: selectedId,
      label: `${selectedId} — ветка не найдена`,
      selected: true
    });
  }
  if (choices.length) {
    return [{
      value: "",
      label: "Выберите исход испытания",
      selected: !selectedId,
      disabled: true
    }, ...choices];
  }
  return [{
    value: "",
    label: "Сначала добавьте испытание",
    selected: true,
    disabled: true
  }];
}

function buildAttackPowerResourceCostRows(baseCosts = [], configuredCosts = []) {
  const configured = new Map((configuredCosts ?? []).map(cost => [
    String(cost?.resourceKey ?? cost?.type ?? "").trim(),
    Number(cost?.amount) || 0
  ]));
  const baseByKey = new Map();
  for (const cost of baseCosts) {
    const key = String(cost?.resourceKey ?? "").trim();
    if (!key) continue;
    const formulas = baseByKey.get(key) ?? [];
    formulas.push(String(cost.formula ?? "0"));
    baseByKey.set(key, formulas);
  }
  const keys = new Set([...baseByKey.keys(), ...configured.keys()]);
  return Array.from(keys).filter(Boolean).map((resourceKey, index) => ({
    index,
    resourceKey,
    label: getEventReactionResourceDefinitions().find(resource => resource.key === resourceKey)?.label
      ?? resourceKey,
    base: (baseByKey.get(resourceKey) ?? []).join(" + ") || "0",
    amount: configured.get(resourceKey) ?? 0
  }));
}

function prepareAttackRequirementsForDisplay(requirements = []) {
  const characteristics = getCharacteristicSettings();
  const skills = getSkillSettings();
  return (requirements ?? []).map((requirement, index) => {
    const type = String(requirement?.type ?? "") === "skill" ? "skill" : "characteristic";
    return {
      ...requirement,
      index,
      type,
      typeChoices: [
        { value: "characteristic", label: "Характеристика" },
        { value: "skill", label: "Навык" }
      ].map(choice => ({ ...choice, selected: choice.value === type })),
      keyChoices: buildAttackRequirementKeyChoices(type, requirement?.key, characteristics, skills)
    };
  });
}

function buildAttackRequirementKeyChoices(type, selected = "", characteristics = [], skills = []) {
  const key = String(selected ?? "").trim();
  const entries = [...(type === "skill" ? skills : characteristics)];
  if (key && !entries.some(entry => entry.key === key)) entries.push({ key, label: key });
  return entries.map(entry => ({
    value: entry.key,
    label: entry.label || entry.key,
    selected: entry.key === key
  }));
}

function buildAttackConfiguredResourceChoices(resourceCosts = [], selected = "") {
  const key = String(selected ?? "").trim();
  const configured = Array.from(new Set(resourceCosts.map(cost => String(cost?.resourceKey ?? "").trim()).filter(Boolean)));
  if (key && !configured.includes(key)) configured.push(key);
  return configured.map(resourceKey => ({
    value: resourceKey,
    label: getEventReactionResourceDefinitions().find(resource => resource.key === resourceKey)?.label
      ?? resourceKey,
    selected: resourceKey === key
  }));
}

function normalizeAttackSoundVolume(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.max(0, Math.min(1, number));
}

function formatAttackSoundVolumePercent(value) {
  return `${Math.round(normalizeAttackSoundVolume(value) * 100)}%`;
}

function syncAttackSoundVolumeLabel(slider) {
  const label = slider?.closest("label")?.querySelector("[data-attack-sound-volume-label]");
  if (label) label.textContent = formatAttackSoundVolumePercent(slider.value);
}

async function browseAttackAudioPath(target, selector) {
  const functionRow = target?.closest?.("[data-ability-function-row]");
  const input = functionRow?.querySelector?.(selector);
  if (!input) return undefined;
  const picker = new foundry.applications.apps.FilePicker.implementation({
    type: "audio",
    current: input.value ?? "",
    callback: path => {
      input.value = path;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  await picker.browse(undefined, { render: false });
  return picker.render({ force: true });
}

function buildTargetGroupChoices(value = []) {
  const selected = normalizeConditionValues(value).filter(group => ABILITY_AURA_TARGET_GROUPS.includes(group));
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

function prepareCommandBasicsSettingsForDisplay(settings = {}) {
  const normalized = normalizeCommandBasicsSettings(settings);
  const overloadDuration = splitDurationSeconds(normalized.overloadDurationSeconds);
  const dodgeDuration = splitDurationSeconds(normalized.dodgeDurationSeconds);
  return {
    ...normalized,
    overloadDurationAmount: overloadDuration.amount,
    overloadDurationUnitChoices: buildDurationUnitChoices(overloadDuration.unit),
    dodgeDurationAmount: dodgeDuration.amount,
    dodgeDurationUnitChoices: buildDurationUnitChoices(dodgeDuration.unit)
  };
}

function prepareKnockOffBalanceSettingsForDisplay(settings = {}) {
  const normalized = normalizeKnockOffBalanceSettings(settings);
  const overloadDuration = splitDurationSeconds(normalized.overloadDurationSeconds);
  const debuffDuration = splitDurationSeconds(normalized.debuffDurationSeconds);
  return {
    ...normalized,
    overloadDurationAmount: overloadDuration.amount,
    overloadDurationUnitChoices: buildDurationUnitChoices(overloadDuration.unit),
    debuffDurationAmount: debuffDuration.amount,
    debuffDurationUnitChoices: buildDurationUnitChoices(debuffDuration.unit),
    targetSkillChoices: buildSkillChoices(normalized.targetSkillKey, getSkillSettings())
  };
}

function prepareLookSettingsForDisplay(settings = {}) {
  const normalized = normalizeLookSettings(settings);
  const overloadDuration = splitDurationSeconds(normalized.overloadDurationSeconds);
  return {
    ...normalized,
    overloadDurationAmount: overloadDuration.amount,
    overloadDurationUnitChoices: buildDurationUnitChoices(overloadDuration.unit),
    targetSkillChoices: buildSkillChoices(normalized.targetSkillKey, getSkillSettings())
  };
}

function prepareToTheEndSettingsForDisplay(settings = {}) {
  const normalized = normalizeToTheEndSettings(settings);
  const overloadDuration = splitDurationSeconds(normalized.overloadDurationSeconds);
  const duration = splitDurationSeconds(normalized.durationSeconds);
  return {
    ...normalized,
    overloadDurationAmount: overloadDuration.amount,
    overloadDurationUnitChoices: buildDurationUnitChoices(overloadDuration.unit),
    durationAmount: duration.amount,
    durationUnitChoices: buildDurationUnitChoices(duration.unit),
    advantageSkillRows: buildToTheEndAdvantageSkillRows(normalized.advantageSkills)
  };
}

function buildToTheEndAdvantageSkillRows(advantageSkills = []) {
  return advantageSkills.map((entry, index) => ({
    index,
    advantageCount: entry.advantageCount,
    canDelete: advantageSkills.length > 1,
    skillChoices: buildSkillChoices(entry.skillKey, getSkillSettings())
  }));
}

function getFirstUnusedToTheEndAdvantageSkillKey(advantageSkills = []) {
  const selected = new Set(advantageSkills.map(entry => String(entry?.skillKey ?? "").trim()).filter(Boolean));
  return getSkillSettings().find(skill => !selected.has(skill.key))?.key ?? "resilience";
}

function prepareHeightenedConcentrationSettingsForDisplay(settings = {}) {
  const normalized = normalizeHeightenedConcentrationSettings(settings);
  const overloadDuration = splitDurationSeconds(normalized.overloadDurationSeconds);
  return {
    ...normalized,
    overloadDurationAmount: overloadDuration.amount,
    overloadDurationUnitChoices: buildDurationUnitChoices(overloadDuration.unit),
    skillChoices: buildSkillChoices(normalized.skillKey, getSkillSettings())
  };
}

function prepareAnatomyStudySettingsForDisplay(settings = {}) {
  const normalized = normalizeAnatomyStudySettings(settings);
  const overloadDuration = splitDurationSeconds(normalized.overloadDurationSeconds);
  return {
    ...normalized,
    overloadDurationAmount: overloadDuration.amount,
    overloadDurationUnitChoices: buildDurationUnitChoices(overloadDuration.unit)
  };
}

function buildAbilityEventControlChoices(selectedValue = ABILITY_ACTION_EVENT_CONTROLS.none) {
  return [
    { value: ABILITY_ACTION_EVENT_CONTROLS.none, label: game.i18n.localize("FALLOUTMAW.Ability.Actions.EventControlNone") },
    { value: ABILITY_ACTION_EVENT_CONTROLS.cancelCurrent, label: game.i18n.localize("FALLOUTMAW.Ability.Actions.EventControlCancelCurrent") },
    { value: ABILITY_ACTION_EVENT_CONTROLS.cancelRemaining, label: game.i18n.localize("FALLOUTMAW.Ability.Actions.EventControlCancelRemaining") }
  ].map(choice => ({ ...choice, selected: choice.value === selectedValue }));
}

function prepareSpecialMixSettingsForDisplay(settings = {}) {
  const normalized = normalizeSpecialMixSettings(settings);
  const overloadDuration = splitDurationSeconds(normalized.overloadDurationSeconds);
  const spoilDuration = splitDurationSeconds(normalized.spoilDurationSeconds);
  return {
    ...normalized,
    overloadDurationAmount: overloadDuration.amount,
    overloadDurationUnitChoices: buildDurationUnitChoices(overloadDuration.unit),
    spoilDurationAmount: spoilDuration.amount,
    spoilDurationUnitChoices: buildDurationUnitChoices(spoilDuration.unit)
  };
}

function prepareEmergencyOperationsSettingsForDisplay(settings = {}) {
  const normalized = normalizeEmergencyOperationsSettings(settings);
  const overloadDuration = splitDurationSeconds(normalized.overloadDurationSeconds);
  return {
    ...normalized,
    overloadDurationAmount: overloadDuration.amount,
    overloadDurationUnitChoices: buildDurationUnitChoices(overloadDuration.unit)
  };
}

function prepareInconspicuousSettingsForDisplay(settings = {}) {
  const normalized = normalizeInconspicuousSettings(settings);
  const duration = splitDurationSeconds(normalized.stealthBonusDurationSeconds);
  return {
    ...normalized,
    stealthBonusDurationAmount: duration.amount,
    stealthBonusDurationUnitChoices: buildDurationUnitChoices(duration.unit)
  };
}

function prepareShadowSettingsForDisplay(settings = {}) {
  const normalized = normalizeShadowSettings(settings);
  const duration = splitDurationSeconds(normalized.durationSeconds);
  const overloadDuration = splitDurationSeconds(normalized.overloadDurationSeconds);
  return {
    ...normalized,
    durationAmount: duration.amount,
    durationUnitChoices: buildDurationUnitChoices(duration.unit),
    overloadDurationAmount: overloadDuration.amount,
    overloadDurationUnitChoices: buildDurationUnitChoices(overloadDuration.unit)
  };
}

function prepareNightmareSettingsForDisplay(settings = {}) {
  const normalized = normalizeNightmareSettings(settings);
  const overloadDuration = splitDurationSeconds(normalized.overloadDurationSeconds);
  return {
    ...normalized,
    overloadDurationAmount: overloadDuration.amount,
    overloadDurationUnitChoices: buildDurationUnitChoices(overloadDuration.unit)
  };
}

function prepareRageSettingsForDisplay(settings = {}) {
  const normalized = normalizeRageSettings(settings);
  const duration = splitDurationSeconds(normalized.durationSeconds);
  const overloadDuration = splitDurationSeconds(normalized.overloadDurationSeconds);
  const skillSettings = getSkillSettings();
  return {
    ...normalized,
    durationAmount: duration.amount,
    durationUnitChoices: buildDurationUnitChoices(duration.unit),
    overloadDurationAmount: overloadDuration.amount,
    overloadDurationUnitChoices: buildDurationUnitChoices(overloadDuration.unit),
    advantageSkillChoices: buildSkillChoices(normalized.advantageSkillKey, skillSettings),
    disadvantageSkillChoices: buildSkillChoices(normalized.disadvantageSkillKey, skillSettings)
  };
}

function prepareDisarmSettingsForDisplay(settings = {}) {
  const normalized = normalizeDisarmSettings(settings);
  const activeDuration = splitDurationSeconds(normalized.activeOverloadDurationSeconds);
  const reactionDuration = splitDurationSeconds(normalized.reactionOverloadDurationSeconds);
  return {
    ...normalized,
    activeOverloadDurationAmount: activeDuration.amount,
    activeOverloadDurationUnitChoices: buildDurationUnitChoices(activeDuration.unit),
    reactionOverloadDurationAmount: reactionDuration.amount,
    reactionOverloadDurationUnitChoices: buildDurationUnitChoices(reactionDuration.unit)
  };
}

function prepareConditionForDisplay(condition, {
  changeCount = 0,
  allowLimitedChanges = false,
  allowEventReaction = false,
  allowAccumulation = false,
  allowToggleable = false,
  allowTriggerCost = false,
  eventReactionMode = false,
  constructs = [],
  abilityFunction = null
} = {}) {
  const type = String(condition?.type ?? "");
  const isToggleable = type === ABILITY_CONDITION_TYPES.toggleable;
  const isEventReaction = type === ABILITY_CONDITION_TYPES.eventReaction;
  const isAccumulation = type === ABILITY_CONDITION_TYPES.accumulation;
  const isTriggerCost = type === ABILITY_CONDITION_TYPES.triggerCost;
  const isTriggerChance = type === ABILITY_CONDITION_TYPES.triggerChance;
  const isEventReactionFilter = isEventReactionFilterType(type);
  const isDuration = type === ABILITY_CONDITION_TYPES.duration;
  const isLimitedEffectCopies = type === ABILITY_CONDITION_TYPES.limitedEffectCopies;
  const isSelectedChanges = type === ABILITY_CONDITION_TYPES.selectedChanges;
  const isTimeOfDay = type === ABILITY_CONDITION_TYPES.timeOfDay;
  const isIllumination = type === ABILITY_CONDITION_TYPES.illumination;
  const isRegionPresence = type === ABILITY_CONDITION_TYPES.regionPresence;
  const isUnsupportedEventCondition = eventReactionMode
    && ((!isToggleable && !isEventReaction && !isAccumulation && !isTriggerCost && !isEventReactionFilter && !isDuration && !isLimitedEffectCopies && !isSelectedChanges) || (isEventReaction && !allowEventReaction));
  const isHealth = type === ABILITY_CONDITION_TYPES.healthPercent;
  const isEquipment = type === ABILITY_CONDITION_TYPES.equipmentSlotOccupied;
  const isTargetFaction = type === ABILITY_CONDITION_TYPES.targetFaction;
  const isTargetRace = type === ABILITY_CONDITION_TYPES.targetRace;
  const isTargetType = type === ABILITY_CONDITION_TYPES.targetType;
  const isPosture = type === ABILITY_CONDITION_TYPES.posture;
  const isOccupiedCover = type === ABILITY_CONDITION_TYPES.occupiedCover;
  const isAttackDistance = type === ABILITY_CONDITION_TYPES.attackDistance;
  const isWeaponAction = type === ABILITY_CONDITION_TYPES.weaponAction;
  const isWeaponSkill = type === ABILITY_CONDITION_TYPES.weaponSkill;
  const isEngagedSkill = type === ABILITY_CONDITION_TYPES.engagedSkill;
  const isSkillCondition = isWeaponSkill || isEngagedSkill;
  const isWeaponProficiency = type === ABILITY_CONDITION_TYPES.weaponProficiency
    && getActiveRulesProfile().weaponProficienciesEnabled !== false;
  const isTrial = type === ABILITY_CONDITION_TYPES.trial;
  const isAura = type === ABILITY_CONDITION_TYPES.aura;
  const isLimitedChanges = type === ABILITY_CONDITION_TYPES.limitedChanges;
  const isLimitedUses = type === ABILITY_CONDITION_TYPES.limitedUses;
  const isCooldown = type === ABILITY_CONDITION_TYPES.cooldown;
  const isEnergyConsumption = type === ABILITY_CONDITION_TYPES.energyConsumption;
  const isItemUse = type === ABILITY_CONDITION_TYPES.itemUse;
  const maxLimit = Math.max(1, changeCount);
  const duration = splitDurationSeconds(condition?.durationSeconds);
  const toggleCooldown = splitDurationSeconds(condition?.cooldownSeconds ?? 0);
  const attackDistanceMode = Object.values(ABILITY_ATTACK_DISTANCE_MODES).includes(condition?.attackDistanceMode)
    ? condition.attackDistanceMode
    : ABILITY_ATTACK_DISTANCE_MODES.effective;
  const healthTarget = Object.values(ABILITY_HEALTH_TARGETS).includes(condition?.healthTarget)
    ? condition.healthTarget
    : ABILITY_HEALTH_TARGETS.general;
  const isHealthGeneral = healthTarget === ABILITY_HEALTH_TARGETS.general;
  const isHealthLimb = healthTarget === ABILITY_HEALTH_TARGETS.limb;
  const isHealthCriticalLimb = healthTarget === ABILITY_HEALTH_TARGETS.criticalLimb;
  const eventDisplay = isEventReaction
    ? buildEventReactionDisplay(condition?.eventKey)
    : { pathLevels: [], selectedEvent: null, isUnsupported: false, showEventTiming: false, showEventSkillFilters: false, showEventExpectedResultFilters: false };
  const trackingTargets = normalizeConditionValues(condition?.trackingTargets)
    .filter(group => ABILITY_EVENT_TRACKING_TARGETS.includes(group));
  const eventSkillKeys = isEventReaction
    ? normalizeEventReactionSkillKeys(condition?.skillKeys)
    : [];
  const eventExpectedResultKeys = isEventReaction
    ? normalizeEventReactionExpectedResultKeys(condition?.expectedResultKeys)
    : [];
  const showEventSkillFilters = isEventReaction && eventDisplay.showEventSkillFilters;
  const showEventExpectedResultFilters = isEventReaction && eventDisplay.showEventExpectedResultFilters;
  const eventDepthFilterGroups = isEventReaction
    ? buildEventReactionDepthFilterGroups(condition, condition?.eventKey, { localize: localizeCatalogValue })
    : [];
  const showEventProgress = isEventReaction && isEventReactionProgressTracked(condition?.eventKey);
  const reactionMode = normalizeEventReactionMode(condition?.reactionMode, condition?.autoApply);
  return {
    ...condition,
    healthTarget,
    isPending: !isToggleable && !isEventReaction && !isAccumulation && !isTriggerCost && !isTriggerChance && !isTimeOfDay && !isIllumination && !isRegionPresence && !isHealth && !isEquipment && !isTargetFaction && !isTargetRace && !isTargetType && !isPosture && !isOccupiedCover && !isAttackDistance && !isWeaponAction && !isSkillCondition && !isWeaponProficiency && !isTrial && !isAura && !isLimitedChanges && !isSelectedChanges && !isLimitedEffectCopies && !isLimitedUses && !isCooldown && !isDuration && !isEnergyConsumption && !isItemUse,
    isToggleable,
    isEventReaction,
    isAccumulation,
    accumulationSettings: isAccumulation
      ? prepareAbilityAccumulationForDisplay(condition?.accumulation)
      : null,
    isTriggerCost,
    isTriggerChance,
    isEventReactionFilter,
    isUnsupportedEventCondition,
    showEventSubject: eventReactionMode && isEventReactionFilter,
    triggerCosts: isTriggerCost ? prepareTriggerCostRowsForDisplay(condition?.costs) : [],
    reactionMode,
    reactionModeChoices: buildEventReactionModeChoices(reactionMode),
    showEventProgress,
    eventProgressLabel: showEventProgress ? getEventReactionProgressLabel(condition?.eventKey) : "",
    eventProgressRequired: normalizeEventReactionProgressRequired(condition?.progressRequired),
    combatOnly: Boolean(condition?.combatOnly),
    allowUnconscious: Boolean(condition?.allowUnconscious),
    allowDead: Boolean(condition?.allowDead),
    autoApply: reactionMode === ABILITY_EVENT_REACTION_MODES.isolatedAuto,
    trackingTargetRows: buildEventTrackingTargetRows(trackingTargets),
    canAddTrackingTarget: trackingTargets.length < ABILITY_EVENT_TRACKING_TARGETS.length,
    showEventTiming: Boolean(eventDisplay.showEventTiming),
    showEventSkillFilters,
    eventPathLevels: eventDisplay.pathLevels ?? [],
    eventSkillRows: showEventSkillFilters
      ? buildEventReactionSkillRows(eventSkillKeys)
      : [],
    canAddEventSkill: eventDisplay.showEventSkillFilters
      ? Boolean(getFirstUnusedEventReactionSkillKey(eventSkillKeys))
      : false,
    hiddenEventSkillRows: isEventReaction && !showEventSkillFilters
      ? eventSkillKeys.map((value, index) => ({ value, index }))
      : [],
    showEventExpectedResultFilters,
    eventExpectedResultRows: showEventExpectedResultFilters
      ? buildEventReactionExpectedResultRows(eventExpectedResultKeys)
      : [],
    canAddEventExpectedResult: eventDisplay.showEventExpectedResultFilters
      ? Boolean(getFirstUnusedEventReactionExpectedResultKey(eventExpectedResultKeys))
      : false,
    hiddenEventExpectedResultRows: isEventReaction && !showEventExpectedResultFilters
      ? eventExpectedResultKeys.map((value, index) => ({ value, index }))
      : [],
    eventDepthFilterGroups,
    hiddenEventDepthFilterRows: isEventReaction
      ? buildHiddenEventReactionDepthFilterRows(condition, condition?.eventKey)
      : [],
    isTimeOfDay,
    isIllumination,
    isRegionPresence,
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
    isAttackDistance,
    showAttackDistanceSide: isAttackDistance && attackDistanceMode === ABILITY_ATTACK_DISTANCE_MODES.outsideEffective,
    showAttackDistanceFree: isAttackDistance && attackDistanceMode === ABILITY_ATTACK_DISTANCE_MODES.free,
    isWeaponAction,
    isWeaponSkill,
    isEngagedSkill,
    isSkillCondition,
    skillConditionLabel: isEngagedSkill ? "Задействованные навыки" : "Задействованные оружием навыки",
    isWeaponProficiency,
    isTrial,
    trialSubjectChoices: buildTrialSubjectChoices(condition?.trialSubject),
    trialEntryRows: buildTrialEntryRows(condition?.trialEntries),
    trialSelectionModeChoices: buildTrialSelectionModeChoices(condition?.trialSelectionMode),
    trialBranchRows: buildTrialBranchRows(condition?.trialBranches, constructs, {
      abilityFunction
    }),
    hasTrialConstructs: Boolean(constructs.length),
    isAura,
    isLimitedChanges,
    isSelectedChanges,
    isLimitedEffectCopies,
    isLimitedUses,
    isCooldown,
    isDuration,
    isEnergyConsumption,
    isItemUse,
    canAddAlternative: !isToggleable && !isEventReaction && !isAccumulation && !isTriggerCost && !isTrial && !isUnsupportedEventCondition && !isLimitedChanges && !isSelectedChanges && !isLimitedEffectCopies && !isLimitedUses && !isCooldown && !isDuration && !isEnergyConsumption && !isItemUse,
    toggleName: String(condition?.name ?? "").trim(),
    toggleCooldownAmount: condition?.cooldownSeconds === null || condition?.cooldownSeconds === undefined
      ? ""
      : toggleCooldown.amount,
    toggleCooldownUnitChoices: buildDurationUnitChoices(toggleCooldown.unit),
    chanceFormula: String(condition?.chanceFormula ?? "100").trim() || "100",
    changeLimit: Math.max(1, Math.min(maxLimit, toInteger(condition?.limit ?? 1))),
    changeLimitFormula: String(condition?.limitFormula ?? condition?.limit ?? 1).trim() || "1",
    changeLimitMax: maxLimit,
    changeLimitTotal: changeCount,
    effectCopyLimit: Math.max(1, toInteger(condition?.limit ?? 1)),
    effectCopyLimitFormula: String(condition?.limitFormula ?? condition?.limit ?? 1).trim() || "1",
    usesSpent: Math.max(0, toInteger(condition?.usesSpent ?? 0)),
    usesMax: Math.max(1, toInteger(condition?.usesMax ?? 1)),
    requiredCount: isAura ? normalizeFormulaText(condition?.requiredCount, "1") : Math.max(1, toInteger(condition?.requiredCount ?? 1)),
    durationSeconds: Math.max(0, toInteger(condition?.durationSeconds)),
    energyConsumptionName: String(condition?.name ?? "").trim(),
    amountPerHour: Math.max(0, Number(condition?.amountPerHour) || 0),
    durationAmount: duration.amount,
    durationUnitChoices: buildDurationUnitChoices(duration.unit),
    typeLabel: getConditionTypeLabel(type),
    typeChoices: buildConditionTypeChoices(type, { allowLimitedChanges, allowEventReaction, allowAccumulation, allowToggleable, allowTriggerCost, eventReactionMode }),
    eventPathLevels: eventDisplay.pathLevels ?? [],
    selectedEvent: eventDisplay.selectedEvent,
    isUnsupportedEventKey: eventDisplay.isUnsupported,
    eventSubjectChoices: buildEventSubjectChoices(condition?.eventSubject),
    effectTargetChoices: buildEffectTargetChoices(condition?.effectTarget),
    illuminationLevelChoices: buildIlluminationLevelChoices(condition?.illuminationLevel),
    regionDamageTypeRows: buildRegionDamageTypeRows(condition?.damageTypeKeys),
    canAddRegionDamageType: Boolean(getFirstUnusedRegionDamageTypeKey(condition?.damageTypeKeys)),
    regionSpecialPropertyRows: buildRegionSpecialPropertyRows(condition?.regionSpecialPropertyTypes),
    canAddRegionSpecialProperty: Boolean(
      getFirstUnusedRegionSpecialPropertyType(condition?.regionSpecialPropertyTypes)
    ),
    healthTargetChoices: buildHealthTargetChoices(healthTarget),
    limbChoices: buildLimbChoices(condition?.limbKey, { criticalOnly: isHealthCriticalLimb }),
    healthOperatorChoices: [
      { value: "lte", label: "<=", selected: String(condition?.operator ?? "lte") !== "gte" },
      { value: "gte", label: ">=", selected: String(condition?.operator ?? "lte") === "gte" }
    ],
    equipmentOperatorChoices: [
      { value: ABILITY_EQUIPMENT_OPERATORS.occupied, label: "Занят", selected: condition?.operator !== ABILITY_EQUIPMENT_OPERATORS.empty },
      { value: ABILITY_EQUIPMENT_OPERATORS.empty, label: "Не занят", selected: condition?.operator === ABILITY_EQUIPMENT_OPERATORS.empty }
    ],
    equipmentSlotChoices: buildEquipmentSlotChoices(condition?.equipmentSlotKey),
    targetFactionRows: buildTargetFactionRows(condition?.targetFactionNames),
    canAddTargetFaction: Boolean(getFirstUnusedTargetFaction(condition?.targetFactionNames)),
    targetRaceChoices: buildTargetRaceChoices(condition?.targetRaceId),
    targetTypeChoices: buildTargetTypeChoices(condition?.targetTypeId),
    postureSubjectChoices: buildPostureSubjectChoices(condition?.postureSubject),
    postureRows: buildPostureRows(condition?.postureActions),
    canAddPosture: normalizeConditionValues(condition?.postureActions).length < ABILITY_POSTURE_ACTIONS.length,
    coverRows: buildCoverRows(condition?.coverKeys),
    canAddCover: Boolean(getFirstUnusedCoverKey(condition?.coverKeys)),
    attackDistanceModeChoices: buildAttackDistanceModeChoices(attackDistanceMode),
    attackDistanceSideChoices: buildAttackDistanceSideChoices(condition?.attackDistanceSide),
    attackDistanceMinMeters: condition?.attackDistanceMinMeters ?? "",
    attackDistanceMaxMeters: condition?.attackDistanceMaxMeters ?? "",
    weaponActionRows: buildWeaponActionRows(condition?.weaponActionKeys),
    canAddWeaponAction: Boolean(getFirstUnusedWeaponActionKey(condition?.weaponActionKeys)),
    skillRows: buildSkillRows(condition?.skillKeys),
    canAddSkill: Boolean(getFirstUnusedSkillKey(condition?.skillKeys)),
    proficiencyRows: buildProficiencyRows(condition?.proficiencyKeys),
    canAddProficiency: Boolean(getFirstUnusedProficiencyKey(condition?.proficiencyKeys)),
    auraModeChoices: buildAuraModeChoices(condition?.auraMode),
    auraTargetGroupsLabel: getAuraTargetGroupsLabel(condition?.auraMode),
    showAuraIncludeSelf: condition?.auraMode === ABILITY_AURA_MODES.applyToTargets,
    showAuraTriggerTiming: condition?.auraMode === ABILITY_AURA_MODES.triggerConditions,
    showActiveApplicationAuraProjectionHint: (
      abilityFunction?.type === ABILITY_FUNCTION_TYPES.activeApplication
      && condition?.auraMode === ABILITY_AURA_MODES.applyToTargets
    ),
    auraTargetGroupRows: buildAuraTargetGroupRows(condition?.auraTargetGroups),
    canAddAuraTargetGroup: normalizeConditionValues(condition?.auraTargetGroups).filter(group => ABILITY_AURA_TARGET_GROUPS.includes(group)).length < ABILITY_AURA_TARGET_GROUPS.length,
    auraRadiusMeters: normalizeFormulaText(condition?.auraRadiusMeters, "0"),
    auraWallsBlockChoices: buildBooleanChoices(condition?.auraWallsBlock !== false),
    auraIncludeSelfChoices: buildBooleanChoices(condition?.auraIncludeSelf !== false),
    auraCombatOnlyChoices: buildBooleanChoices(Boolean(condition?.auraCombatOnly)),
    auraCombatantsOnlyChoices: buildBooleanChoices(Boolean(condition?.auraCombatantsOnly)),
    auraIgnoreIncapacitatedChoices: buildBooleanChoices(condition?.auraIgnoreIncapacitated !== false),
    auraAllowUnconsciousChoices: buildBooleanChoices(condition?.auraAllowUnconscious === true),
    auraAllowDeadChoices: buildBooleanChoices(condition?.auraAllowDead === true),
    auraIgnoreHiddenChoices: buildBooleanChoices(condition?.auraIgnoreHidden !== false),
    auraTriggerOnCreateChoices: buildBooleanChoices(condition?.auraTriggerOnCreate !== false),
    auraTriggerOnEnterChoices: buildBooleanChoices(condition?.auraTriggerOnEnter !== false),
    auraRepeatSeconds: Math.max(1, toInteger(condition?.auraRepeatSeconds ?? 6)),
    itemCategoryRows: buildItemUseCategoryRows(condition?.itemCategories),
    canAddItemCategory: Boolean(getFirstUnusedItemUseCategory(condition?.itemCategories))
  };
}

function buildConditionDisplayGroups(conditions = []) {
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

function buildIlluminationLevelChoices(selected = "normal") {
  const key = STEALTH_LIGHT_LEVELS.some(level => level.key === selected) ? selected : "normal";
  return STEALTH_LIGHT_LEVELS.map(level => ({
    value: level.key,
    label: level.label,
    selected: level.key === key
  }));
}

function prepareAcquisitionRequirementForDisplay(requirement, { characteristicSettings = [], skillSettings = [] } = {}) {
  const type = String(requirement?.type ?? "");
  const isRace = type === ABILITY_ACQUISITION_CONDITION_TYPES.race;
  const isCharacteristic = type === ABILITY_ACQUISITION_CONDITION_TYPES.characteristic;
  const isSkill = type === ABILITY_ACQUISITION_CONDITION_TYPES.skill;
  const isAbility = type === ABILITY_ACQUISITION_CONDITION_TYPES.ability;
  const mode = String(requirement?.mode ?? ABILITY_ACQUISITION_ABILITY_MODES.present);
  return {
    ...requirement,
    value: Math.max(0, toInteger(requirement?.value)),
    mode,
    isPending: !isRace && !isCharacteristic && !isSkill && !isAbility,
    isRace,
    isCharacteristic,
    isSkill,
    isAbility,
    typeLabel: getAcquisitionRequirementTypeLabel(type),
    typeChoices: buildAcquisitionRequirementTypeChoices(type),
    raceChoices: buildRaceChoices(requirement?.raceId),
    characteristicChoices: buildCharacteristicChoices(requirement?.characteristicKey, characteristicSettings),
    skillChoices: buildSkillChoices(requirement?.skillKey, skillSettings),
    modeChoices: buildAcquisitionAbilityModeChoices(mode),
    abilityEntries: isAbility ? resolveCatalogAbilityEntries(requirement?.abilityIds ?? []) : []
  };
}

function getConditionTypeLabel(type) {
  return buildConditionTypeChoices(type, {
    allowLimitedChanges: true,
    allowAccumulation: true
  }).find(choice => choice.value === type)?.label ?? type;
}

function getAcquisitionRequirementTypeLabel(type) {
  return buildAcquisitionRequirementTypeChoices(type).find(choice => choice.value === type)?.label ?? type;
}

function buildFunctionChoices(includeFixed = true) {
  return [
    { value: "", label: "Выберите функцию", disabled: true, selected: true },
    { value: ABILITY_FUNCTION_TYPES.fixed, label: "Фиксированные функции" },
    { value: ABILITY_FUNCTION_TYPES.activeApplication, label: "Активное применение" },
    { value: ABILITY_FUNCTION_TYPES.attackAction, label: "Атакующее действие" },
    { value: ABILITY_FUNCTION_TYPES.effectChanges, label: "Свободная настройка" },
    { value: ABILITY_FUNCTION_TYPES.acquisitionChanges, label: "Разовое изменение при приобретении" }
  ].filter(choice => includeFixed || choice.value !== ABILITY_FUNCTION_TYPES.fixed);
}

function activateAbilityFunctionKeyAutocomplete(root) {
  if (!root) return;
  activateEffectKeyAutocomplete(root, buildEffectKeyTokens({ includePeriodicHealing: true }), {
    selector: "input[data-effect-key-autocomplete]:not([data-ability-acquisition-change-key])"
  });
  activateEffectKeyAutocomplete(root, buildAbilityAcquisitionChangeKeyTokens(), {
    selector: "input[data-ability-acquisition-change-key]"
  });
}

function buildChangeTypeChoices(selected = ABILITY_CHANGE_TYPES.add) {
  const labels = {
    [ABILITY_CHANGE_TYPES.add]: "Добавить",
    [ABILITY_CHANGE_TYPES.multiply]: "Умножить",
    [ABILITY_CHANGE_TYPES.override]: "Заменить",
    [ABILITY_CHANGE_TYPES.upgrade]: "Повысить до",
    [ABILITY_CHANGE_TYPES.downgrade]: "Понизить до"
  };
  return Object.values(ABILITY_CHANGE_TYPES).map(value => ({
    value,
    label: labels[value] ?? value,
    selected: value === selected
  }));
}

function buildAttackDistanceModeChoices(selected = ABILITY_ATTACK_DISTANCE_MODES.effective) {
  return [
    { value: ABILITY_ATTACK_DISTANCE_MODES.effective, label: "Эффективная дистанция" },
    { value: ABILITY_ATTACK_DISTANCE_MODES.outsideEffective, label: "Вне эффективной дистанции" },
    { value: ABILITY_ATTACK_DISTANCE_MODES.free, label: "Свободный" }
  ].map(choice => ({ ...choice, selected: choice.value === selected }));
}

function buildAttackDistanceSideChoices(selected = ABILITY_ATTACK_DISTANCE_SIDES.both) {
  const normalized = Object.values(ABILITY_ATTACK_DISTANCE_SIDES).includes(selected)
    ? selected
    : ABILITY_ATTACK_DISTANCE_SIDES.both;
  return [
    { value: ABILITY_ATTACK_DISTANCE_SIDES.near, label: "Ближняя" },
    { value: ABILITY_ATTACK_DISTANCE_SIDES.far, label: "Дальняя" },
    { value: ABILITY_ATTACK_DISTANCE_SIDES.both, label: "Обе" }
  ].map(choice => ({ ...choice, selected: choice.value === normalized }));
}

function buildConditionTypeChoices(selected = "", {
  allowLimitedChanges = true,
  allowEventReaction = false,
  allowAccumulation = false,
  allowToggleable = false,
  allowTriggerCost = false,
  eventReactionMode = false
} = {}) {
  const choices = [
    { value: "", label: "", selected: !selected },
    { value: ABILITY_CONDITION_TYPES.triggerChance, label: "Вероятность срабатывания", selected: selected === ABILITY_CONDITION_TYPES.triggerChance },
    { value: ABILITY_CONDITION_TYPES.timeOfDay, label: "Время суток", selected: selected === ABILITY_CONDITION_TYPES.timeOfDay },
    { value: ABILITY_CONDITION_TYPES.illumination, label: "Степень освещения", selected: selected === ABILITY_CONDITION_TYPES.illumination },
    { value: ABILITY_CONDITION_TYPES.regionPresence, label: "Нахождение в области", selected: selected === ABILITY_CONDITION_TYPES.regionPresence },
    { value: ABILITY_CONDITION_TYPES.healthPercent, label: "Состояние ОЗ", selected: selected === ABILITY_CONDITION_TYPES.healthPercent },
    { value: ABILITY_CONDITION_TYPES.equipmentSlotOccupied, label: "Занятость слотов экипировки", selected: selected === ABILITY_CONDITION_TYPES.equipmentSlotOccupied },
    { value: ABILITY_CONDITION_TYPES.targetFaction, label: "Фракция цели", selected: selected === ABILITY_CONDITION_TYPES.targetFaction },
    { value: ABILITY_CONDITION_TYPES.targetRace, label: "Раса цели", selected: selected === ABILITY_CONDITION_TYPES.targetRace },
    { value: ABILITY_CONDITION_TYPES.targetType, label: "Тип цели", selected: selected === ABILITY_CONDITION_TYPES.targetType },
    { value: ABILITY_CONDITION_TYPES.posture, label: "Положение", selected: selected === ABILITY_CONDITION_TYPES.posture },
    { value: ABILITY_CONDITION_TYPES.occupiedCover, label: "Занимаемое укрытие", selected: selected === ABILITY_CONDITION_TYPES.occupiedCover },
    { value: ABILITY_CONDITION_TYPES.attackDistance, label: "Дистанция атаки", selected: selected === ABILITY_CONDITION_TYPES.attackDistance },
    { value: ABILITY_CONDITION_TYPES.weaponAction, label: "Тип атаки", selected: selected === ABILITY_CONDITION_TYPES.weaponAction },
    { value: ABILITY_CONDITION_TYPES.weaponSkill, label: "Задействованный оружием навык", selected: selected === ABILITY_CONDITION_TYPES.weaponSkill },
    { value: ABILITY_CONDITION_TYPES.engagedSkill, label: "Задействованный навык", selected: selected === ABILITY_CONDITION_TYPES.engagedSkill },
    { value: ABILITY_CONDITION_TYPES.weaponProficiency, label: "Задействованное оружейное владение", selected: selected === ABILITY_CONDITION_TYPES.weaponProficiency },
    { value: ABILITY_CONDITION_TYPES.trial, label: "Испытание", selected: selected === ABILITY_CONDITION_TYPES.trial },
    { value: ABILITY_CONDITION_TYPES.aura, label: "Аура", selected: selected === ABILITY_CONDITION_TYPES.aura }
  ];
  if (allowToggleable || selected === ABILITY_CONDITION_TYPES.toggleable) {
    choices.splice(1, 0, {
      value: ABILITY_CONDITION_TYPES.toggleable,
      label: game.i18n.localize("FALLOUTMAW.Ability.Toggle.ConditionLabel"),
      selected: selected === ABILITY_CONDITION_TYPES.toggleable
    });
  }
  if (allowEventReaction || selected === ABILITY_CONDITION_TYPES.eventReaction) {
    choices.splice(1, 0, {
      value: ABILITY_CONDITION_TYPES.eventReaction,
      label: localizeEventReactionUi("ConditionLabel", "Event reaction"),
      selected: selected === ABILITY_CONDITION_TYPES.eventReaction
    });
  }
  if (allowAccumulation || selected === ABILITY_CONDITION_TYPES.accumulation) {
    choices.splice(1, 0, {
      value: ABILITY_CONDITION_TYPES.accumulation,
      label: "Накопление",
      selected: selected === ABILITY_CONDITION_TYPES.accumulation
    });
  }
  if (allowTriggerCost || selected === ABILITY_CONDITION_TYPES.triggerCost) {
    choices.splice(1, 0, {
      value: ABILITY_CONDITION_TYPES.triggerCost,
      label: game.i18n.localize("FALLOUTMAW.Ability.TriggerCost.ConditionLabel"),
      selected: selected === ABILITY_CONDITION_TYPES.triggerCost
    });
  }
  if (allowLimitedChanges || selected === ABILITY_CONDITION_TYPES.limitedChanges) {
    choices.push({
      value: ABILITY_CONDITION_TYPES.limitedChanges,
      label: "Ограниченное количество изменений",
      selected: selected === ABILITY_CONDITION_TYPES.limitedChanges
    });
  }
  if (allowLimitedChanges || selected === ABILITY_CONDITION_TYPES.selectedChanges) {
    choices.push({
      value: ABILITY_CONDITION_TYPES.selectedChanges,
      label: "Выбор изменений (постоянный)",
      selected: selected === ABILITY_CONDITION_TYPES.selectedChanges
    });
  }
  if (allowLimitedChanges || selected === ABILITY_CONDITION_TYPES.limitedEffectCopies) {
    choices.push({
      value: ABILITY_CONDITION_TYPES.limitedEffectCopies,
      label: "Ограниченное количество копий эффекта",
      selected: selected === ABILITY_CONDITION_TYPES.limitedEffectCopies
    });
  }
  if (allowLimitedChanges || selected === ABILITY_CONDITION_TYPES.limitedUses) {
    choices.push({
      value: ABILITY_CONDITION_TYPES.limitedUses,
      label: "Ограниченное количество применений",
      selected: selected === ABILITY_CONDITION_TYPES.limitedUses
    });
  }
  choices.push({
    value: ABILITY_CONDITION_TYPES.cooldown,
    label: "Перезарядка",
    selected: selected === ABILITY_CONDITION_TYPES.cooldown
  });
  choices.push({
    value: ABILITY_CONDITION_TYPES.duration,
    label: "Длительность",
    selected: selected === ABILITY_CONDITION_TYPES.duration
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
  const activeChoices = getActiveRulesProfile().weaponProficienciesEnabled !== false
    ? choices
    : choices.filter(choice => choice.value !== ABILITY_CONDITION_TYPES.weaponProficiency);
  if (!eventReactionMode) return activeChoices;
  return activeChoices
    .filter(choice => (
      !choice.value
      || choice.value === ABILITY_CONDITION_TYPES.toggleable
      || choice.value === ABILITY_CONDITION_TYPES.eventReaction
      || choice.value === ABILITY_CONDITION_TYPES.accumulation
      || choice.value === ABILITY_CONDITION_TYPES.triggerCost
      || choice.value === ABILITY_CONDITION_TYPES.duration
      || choice.value === ABILITY_CONDITION_TYPES.limitedEffectCopies
      || choice.value === ABILITY_CONDITION_TYPES.selectedChanges
      || isEventReactionFilterType(choice.value)
      || choice.value === selected
    ))
    .map(choice => choice.value === selected
      && choice.value
      && choice.value !== ABILITY_CONDITION_TYPES.toggleable
      && choice.value !== ABILITY_CONDITION_TYPES.eventReaction
      && choice.value !== ABILITY_CONDITION_TYPES.accumulation
      && choice.value !== ABILITY_CONDITION_TYPES.triggerCost
      && choice.value !== ABILITY_CONDITION_TYPES.duration
      && choice.value !== ABILITY_CONDITION_TYPES.limitedEffectCopies
      && !isEventReactionFilterType(choice.value)
      ? { ...choice, label: `${choice.label} — ${localizeEventReactionUi("Unsupported", "unsupported")}` }
      : choice);
}

function buildEventReactionDisplay(selectedKey = "") {
  const key = String(selectedKey ?? "").trim();
  const depth = getEventReactionDepthProfile(key);
  const selectedDescriptor = getSystemEventDescriptor(key);
  const descriptors = [...getSelectableSystemEvents()];
  if (selectedDescriptor && !descriptors.some(event => event.key === selectedDescriptor.key)) {
    descriptors.push(selectedDescriptor);
  }

  const pathLevels = buildEventReactionPathLevels(key, {
    descriptors,
    localizeEventLabel: descriptor => localizeCatalogValue(descriptor.labelKey, descriptor.key),
    unsupportedLabel: localizeEventReactionUi("UnsupportedGroup", "Unsupported saved event")
  }).map((level, index, levels) => ({
    ...level,
    levelLabel: index === 0
      ? localizeEventReactionUi("Event", "Event")
      : level.isLeafLevel
        ? localizeEventReactionUi("Timing", "Timing")
        : localizeEventReactionUi("SubEvent", "Sub-event"),
    selectLabel: index === 0
      ? localizeEventReactionUi("SelectEvent", "Select an event")
      : level.isLeafLevel
        ? localizeEventReactionUi("SelectTiming", "Select timing")
        : localizeEventReactionUi("SelectSubEvent", "Select a sub-event"),
    isLast: index === levels.length - 1
  }));

  return {
    pathLevels,
    showEventTiming: false,
    showEventSkillFilters: depth.skillKeys,
    showEventExpectedResultFilters: depth.expectedResultKeys,
    selectedEvent: selectedDescriptor
      ? prepareSelectedEventMetadata(selectedDescriptor)
      : key ? {
        key,
        label: key,
        description: localizeEventReactionUi("UnknownEventDescription", "This saved event is not present in the current catalog."),
        phaseLabel: localizeEventReactionUi("Unknown", "Unknown"),
        rolesLabel: localizeEventReactionUi("Unknown", "Unknown"),
        supported: false
      } : null,
    isUnsupported: Boolean(key && (!selectedDescriptor || !selectedDescriptor.selectable))
  };
}

function prepareSelectedEventMetadata(descriptor) {
  const phase = SYSTEM_EVENT_PHASES[descriptor.phase];
  const phaseLabel = localizeCatalogValue(phase?.labelKey, descriptor.phase);
  const roleLabels = descriptor.roles.map(role => localizeCatalogValue(SYSTEM_EVENT_ROLES[role]?.labelKey, role));
  return {
    key: descriptor.key,
    label: localizeCatalogValue(descriptor.labelKey, descriptor.key),
    description: localizeCatalogValue(descriptor.descriptionKey, descriptor.key),
    phaseLabel,
    rolesLabel: roleLabels.join(", "),
    supported: Boolean(descriptor.selectable)
  };
}

function resolveCatalogEventKeyForPath(pathPrefix = "", preferredEventKey = "") {
  return resolveEventKeyForPathPrefix(pathPrefix, preferredEventKey, getSelectableSystemEvents());
}

function buildEventReactionModeChoices(selectedMode = ABILITY_EVENT_REACTION_MODES.standard) {
  return [
    {
      value: ABILITY_EVENT_REACTION_MODES.standard,
      label: localizeEventReactionUi("ReactionModes.Standard", "Standard reaction")
    },
    {
      value: ABILITY_EVENT_REACTION_MODES.isolatedAuto,
      label: localizeEventReactionUi("ReactionModes.IsolatedAuto", "Isolated automatic application")
    }
  ].map(choice => ({ ...choice, selected: choice.value === selectedMode }));
}

function buildEventReactionSkillRows(value = []) {
  const selected = normalizeEventReactionSkillKeys(value);
  return selected.map((skillKey, index) => ({
    index,
    choices: buildEventReactionSkillChoices(skillKey, selected)
  }));
}

function buildEventReactionSkillChoices(selectedKey = "", selectedKeys = []) {
  const selected = String(selectedKey ?? "").trim();
  const taken = new Set(normalizeEventReactionSkillKeys(selectedKeys));
  const choices = [{
    value: EVENT_REACTION_SKILL_FILTER_ALL,
    label: localizeEventReactionUi("AllSkills", "All skills"),
    selected: selected === EVENT_REACTION_SKILL_FILTER_ALL,
    disabled: selected !== EVENT_REACTION_SKILL_FILTER_ALL && taken.has(EVENT_REACTION_SKILL_FILTER_ALL)
  }];
  for (const entry of getSkillSettings()) {
    const value = String(entry?.key ?? "").trim();
    if (!value) continue;
    choices.push({
      value,
      label: entry.label || value,
      selected: value === selected,
      disabled: value !== selected && taken.has(value)
    });
  }
  if (selected && selected !== EVENT_REACTION_SKILL_FILTER_ALL && !choices.some(choice => choice.value === selected)) {
    choices.push({
      value: selected,
      label: selected,
      selected: true,
      disabled: false
    });
  }
  return choices;
}

function getFirstUnusedEventReactionSkillKey(value = []) {
  const selected = new Set(normalizeEventReactionSkillKeys(value));
  if (!selected.has(EVENT_REACTION_SKILL_FILTER_ALL)) return EVENT_REACTION_SKILL_FILTER_ALL;
  return getSkillSettings().find(entry => entry.key && !selected.has(entry.key))?.key ?? "";
}

function buildEventReactionExpectedResultRows(value = []) {
  const selected = normalizeEventReactionExpectedResultKeys(value);
  return selected.map((resultKey, index) => ({
    index,
    choices: buildEventReactionExpectedResultChoices(resultKey, selected)
  }));
}

function buildEventReactionExpectedResultChoices(selectedKey = "", selectedKeys = []) {
  const selected = String(selectedKey ?? "").trim();
  const taken = new Set(normalizeEventReactionExpectedResultKeys(selectedKeys));
  const labels = {
    criticalFailure: localizeCatalogValue("FALLOUTMAW.SkillCheck.CriticalFailure", "Critical failure"),
    failure: localizeCatalogValue("FALLOUTMAW.SkillCheck.Failure", "Failure"),
    success: localizeCatalogValue("FALLOUTMAW.SkillCheck.Success", "Success"),
    criticalSuccess: localizeCatalogValue("FALLOUTMAW.SkillCheck.CriticalSuccess", "Critical success")
  };
  const choices = EVENT_REACTION_EXPECTED_RESULT_KEYS.map(value => ({
    value,
    label: labels[value] ?? value,
    selected: value === selected,
    disabled: value !== selected && taken.has(value)
  }));
  if (selected && !choices.some(choice => choice.value === selected)) {
    choices.push({ value: selected, label: selected, selected: true, disabled: false });
  }
  return choices;
}

function getFirstUnusedEventReactionExpectedResultKey(value = []) {
  const selected = new Set(normalizeEventReactionExpectedResultKeys(value));
  return EVENT_REACTION_EXPECTED_RESULT_KEYS.find(key => !selected.has(key)) ?? "";
}

function buildEventTrackingTargetRows(value = []) {
  const selected = normalizeConditionValues(value).filter(group => ABILITY_EVENT_TRACKING_TARGETS.includes(group));
  return selected.map((group, index) => ({
    index,
    choices: ABILITY_EVENT_TRACKING_TARGETS.map(entry => ({
      value: entry,
      label: getEventTrackingTargetLabel(entry),
      selected: entry === group,
      disabled: entry !== group && selected.includes(entry)
    }))
  }));
}

function getEventTrackingTargetLabel(group = "") {
  return {
    owner: localizeEventReactionUi("TrackingTargetOptions.Owner", "Owner"),
    ally: localizeEventReactionUi("TrackingTargetOptions.Ally", "Ally"),
    enemy: localizeEventReactionUi("TrackingTargetOptions.Enemy", "Enemy"),
    neutral: localizeEventReactionUi("TrackingTargetOptions.Neutral", "Neutral"),
    activeApplicationTarget: localizeEventReactionUi(
      "TrackingTargetOptions.ActiveApplicationTarget",
      "Active application target"
    )
  }[group] ?? group;
}

function buildEventSubjectChoices(selected = ABILITY_EVENT_SUBJECTS.reactor) {
  const labels = {
    [ABILITY_EVENT_SUBJECTS.reactor]: localizeEventReactionUi("EventSubjects.Reactor", "Reactor"),
    [ABILITY_EVENT_SUBJECTS.eventSource]: localizeEventReactionUi("EventSubjects.EventSource", "Event source"),
    [ABILITY_EVENT_SUBJECTS.eventTarget]: localizeEventReactionUi("EventSubjects.EventTarget", "Event target")
  };
  return Object.values(ABILITY_EVENT_SUBJECTS).map(value => ({
    value,
    label: labels[value] ?? value,
    selected: value === selected
  }));
}

function buildEffectTargetChoices(selected = ABILITY_EVENT_EFFECT_TARGETS.reactor) {
  const labels = {
    [ABILITY_EVENT_EFFECT_TARGETS.reactor]: localizeEventReactionUi("EffectTargets.Reactor", "Reactor"),
    [ABILITY_EVENT_EFFECT_TARGETS.eventTarget]: localizeEventReactionUi("EffectTargets.EventTarget", "Event target")
  };
  return Object.values(ABILITY_EVENT_EFFECT_TARGETS).map(value => ({
    value,
    label: labels[value] ?? value,
    selected: value === selected
  }));
}

function buildEventReactionResourceChoices(selected = "") {
  const key = String(selected ?? "").trim();
  const resources = getEventReactionResourceDefinitions();
  if (key && !resources.some(resource => resource.key === key)) {
    resources.push({
      key,
      label: `${key} — ${localizeEventReactionUi("Unsupported", "unsupported")}`,
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

function prepareAbilityConstructForDisplay(construct, index) {
  const normalized = normalizeAbilityConstructs([construct])[0]
    ?? createAbilityConstruct(ABILITY_CONSTRUCT_TYPES.temporaryEffect);
  const duration = splitDurationSeconds(normalized.durationSeconds);
  const isTemporaryEffect = normalized.type === ABILITY_CONSTRUCT_TYPES.temporaryEffect;
  const isResourceChange = normalized.type === ABILITY_CONSTRUCT_TYPES.resourceChange;
  const isDamage = normalized.type === ABILITY_CONSTRUCT_TYPES.damage;
  const damageAmountMode = normalized.damage?.amountMode ?? ABILITY_DAMAGE_AMOUNT_MODES.base;
  return {
    ...normalized,
    index,
    isTemporaryEffect,
    isResourceChange,
    isDamage,
    durationAmount: duration.amount,
    durationUnitChoices: buildDurationUnitChoices(duration.unit),
    typeLabel: isTemporaryEffect
      ? "Временный эффект"
      : (isResourceChange ? "Изменение ресурса" : "Урон"),
    changes: normalized.changes.map((change, changeIndex) => (
      prepareChangeForDisplay(change, changeIndex, [])
    )),
    resources: normalized.resources.map((resource, resourceIndex) => ({
      ...resource,
      index: resourceIndex,
      resourceChoices: buildEventReactionResourceChoices(resource.resourceKey)
    })),
    damage: {
      ...normalized.damage,
      isBase: damageAmountMode === ABILITY_DAMAGE_AMOUNT_MODES.base,
      isFormula: damageAmountMode === ABILITY_DAMAGE_AMOUNT_MODES.formula,
      isPercent: damageAmountMode === ABILITY_DAMAGE_AMOUNT_MODES.percent,
      amountModeChoices: buildAttackDamageAmountModeChoices(damageAmountMode),
      damageTypeChoices: buildAttackDamageTypeChoices(
        normalized.damage?.damageTypeKey,
        getConfigurableDamageTypes(getDamageTypeSettings())
      ),
      limbModeChoices: buildAttackDamageLimbModeChoices(normalized.damage?.limbMode),
      ordinaryLimbModeChoices: buildAttackDamageLimbModeChoices(normalized.damage?.limbMode)
        .filter(choice => choice.value !== ABILITY_DAMAGE_LIMB_MODES.selected)
    }
  };
}

function buildTrialSubjectChoices(selected = ABILITY_TRIAL_SUBJECTS.targets) {
  return [
    { value: ABILITY_TRIAL_SUBJECTS.targets, label: "Цели функции" },
    { value: ABILITY_TRIAL_SUBJECTS.source, label: "Владелец способности" }
  ].map(choice => ({ ...choice, selected: choice.value === selected }));
}

function buildTrialEntryRows(value = []) {
  return (Array.isArray(value) ? value : Object.values(value ?? {})).map((entry, index) => ({
    ...entry,
    index,
    skillChoices: buildSkillChoices(entry?.key, getSkillSettings())
  }));
}

function buildTrialSelectionModeChoices(selected = ABILITY_TRIAL_SELECTION_MODES.best) {
  return [
    { value: ABILITY_TRIAL_SELECTION_MODES.best, label: "Лучшее текущее значение" },
    { value: ABILITY_TRIAL_SELECTION_MODES.worst, label: "Худшее текущее значение" }
  ].map(choice => ({ ...choice, selected: choice.value === selected }));
}

function buildTrialBranchRows(value = [], constructs = [], { abilityFunction = null } = {}) {
  const branches = Array.isArray(value) ? value : Object.values(value ?? {});
  const linkContext = {
    primaryChangeCount: (abilityFunction?.changes ?? []).length,
    primaryDurationSeconds: getAbilityFunctionEffectDurationSeconds(abilityFunction)
  };
  const claimedByOtherBranches = branches.map((branch, branchIndex) => new Set(
    branches.flatMap((candidate, candidateIndex) => (
      candidateIndex === branchIndex ? [] : normalizeConditionValues(candidate?.resultKeys)
    ))
  ));
  const labels = {
    criticalFailure: "Критический провал",
    failure: "Провал",
    success: "Успех",
    criticalSuccess: "Критический успех"
  };
  return branches.map((branch, index) => {
    const selected = new Set(normalizeConditionValues(branch?.resultKeys));
    return {
      ...branch,
      index,
      consequenceCount: (branch?.links ?? []).length,
      resultChoices: ABILITY_TRIAL_RESULT_KEYS.map(resultKey => ({
        value: resultKey,
        label: labels[resultKey] ?? resultKey,
        checked: selected.has(resultKey),
        disabled: !selected.has(resultKey) && claimedByOtherBranches[index].has(resultKey)
      })),
      flowChoices: buildTrialBranchFlowChoices(branch?.flow),
      links: buildTrialLinkRows(branch?.links, constructs, linkContext)
    };
  });
}

function buildTrialBranchFlowChoices(selected = ABILITY_TRIAL_BRANCH_FLOWS.continue) {
  return [
    { value: ABILITY_TRIAL_BRANCH_FLOWS.continue, label: "Продолжить цепочку" },
    { value: ABILITY_TRIAL_BRANCH_FLOWS.stopSubject, label: "Остановить для участников ветки" },
    { value: ABILITY_TRIAL_BRANCH_FLOWS.stopAll, label: "Остановить всю цепочку" }
  ].map(choice => ({ ...choice, selected: choice.value === selected }));
}

function prepareNewOrdinaryTrialConstruct(construct = {}) {
  if (construct?.type !== ABILITY_CONSTRUCT_TYPES.damage) return construct;
  const damageTypeKey = getConfigurableDamageTypes(getDamageTypeSettings()).at(0)?.key
    ?? "firearm";
  construct.damage = {
    ...(construct.damage ?? {}),
    amountMode: ABILITY_DAMAGE_AMOUNT_MODES.formula,
    formula: "0",
    damageTypeKey
  };
  return construct;
}

function buildTrialLinkRows(value = [], constructs = [], {
  primaryChangeCount = 0,
  primaryDurationSeconds = 0
} = {}) {
  const normalizedConstructs = normalizeAbilityConstructs(constructs);
  return (Array.isArray(value) ? value : Object.values(value ?? {})).map((link, index) => {
    const kind = Object.values(ABILITY_TRIAL_LINK_KINDS).includes(link?.kind)
      ? link.kind
      : ABILITY_TRIAL_LINK_KINDS.construct;
    const isPrimaryChanges = kind === ABILITY_TRIAL_LINK_KINDS.primaryChanges;
    const isPrimaryChangesPercent = kind === ABILITY_TRIAL_LINK_KINDS.primaryChangesPercent;
    const isConstruct = kind === ABILITY_TRIAL_LINK_KINDS.construct;
    const recipient = Object.values(ABILITY_TRIAL_LINK_RECIPIENTS).includes(link?.recipient)
      ? link.recipient
      : ABILITY_TRIAL_LINK_RECIPIENTS.subjects;
    const constructId = String(link?.constructId ?? "");
    const constructIndex = isConstruct
      ? normalizedConstructs.findIndex(construct => construct.id === constructId)
      : -1;
    const construct = constructIndex >= 0
      ? prepareAbilityConstructForDisplay(normalizedConstructs[constructIndex], constructIndex)
      : null;
    const typeKey = isPrimaryChanges || isPrimaryChangesPercent
      ? kind
      : (construct?.type ?? "");
    const typeChoices = [
      { value: "", label: "Выберите последствие" },
      { value: ABILITY_TRIAL_LINK_KINDS.primaryChanges, label: "Основные изменения" },
      { value: ABILITY_TRIAL_LINK_KINDS.primaryChangesPercent, label: "Процент от основных изменений" },
      { value: ABILITY_CONSTRUCT_TYPES.damage, label: "Самостоятельное: урон" },
      { value: ABILITY_CONSTRUCT_TYPES.temporaryEffect, label: "Самостоятельное: временный эффект" },
      { value: ABILITY_CONSTRUCT_TYPES.resourceChange, label: "Самостоятельное: изменение ресурса" }
    ].map(choice => ({ ...choice, selected: choice.value === typeKey }));
    const constructChoices = normalizedConstructs.map(construct => ({
      value: construct.id,
      label: construct.name || (
        construct.type === ABILITY_CONSTRUCT_TYPES.temporaryEffect
          ? "Безымянный временный эффект"
          : "Безымянное изменение ресурса"
      ),
      selected: construct.id === constructId
    }));
    if (constructId && !constructChoices.some(choice => choice.value === constructId)) {
      constructChoices.push({
        value: constructId,
        label: `${constructId} — конструкт не найден`,
        selected: true
      });
    }
    return {
      ...link,
      index,
      kind,
      isPrimaryChanges,
      isPrimaryChangesPercent,
      isConstruct,
      isPending: !typeKey,
      typeKey,
      typeChoices,
      primaryChangeCount,
      primaryDurationSeconds,
      hasPrimaryDuration: primaryDurationSeconds > 0,
      usesPrimaryDurationPercent: primaryDurationSeconds > 0 && (
        isPrimaryChangesPercent || construct?.isTemporaryEffect
      ),
      durationPercentFormula: String(link?.durationPercentFormula ?? "100"),
      construct,
      hasConstruct: Boolean(construct),
      constructChoices,
      recipientChoices: [
        { value: ABILITY_TRIAL_LINK_RECIPIENTS.subjects, label: "Участники этой ветки" },
        { value: ABILITY_TRIAL_LINK_RECIPIENTS.source, label: "Владелец способности" },
        { value: ABILITY_TRIAL_LINK_RECIPIENTS.targets, label: "Все цели функции" }
      ].map(choice => ({ ...choice, selected: choice.value === recipient })),
      modeChoices: recipient !== ABILITY_TRIAL_LINK_RECIPIENTS.source
        ? [{
            value: ABILITY_TRIAL_LINK_MODES.perSubject,
            label: recipient === ABILITY_TRIAL_LINK_RECIPIENTS.targets
              ? "Каждой цели функции"
              : "Каждому участнику ветки",
            selected: true
          }]
        : [
            { value: ABILITY_TRIAL_LINK_MODES.once, label: "Один раз за ветку" },
            { value: ABILITY_TRIAL_LINK_MODES.perSubject, label: "За каждого участника ветки" }
          ].map(choice => ({ ...choice, selected: choice.value === link?.mode }))
    };
  });
}

function isAbilityConstructLinked(ability, constructId) {
  const id = String(constructId ?? "");
  if (!id) return false;
  return (ability?.system?.functions ?? []).some(abilityFunction => (
    (abilityFunction?.conditions ?? []).some(condition => (
      condition?.type === ABILITY_CONDITION_TYPES.trial
      && (condition?.trialBranches ?? []).some(branch => (
        (branch?.links ?? []).some(link => String(link?.constructId ?? "") === id)
      ))
    ))
    || (abilityFunction?.attackSettings?.hitResolution?.trials ?? []).some(trial => (
      ATTACK_HIT_OUTCOME_KEYS.some(resultKey => (
        (trial?.outcomes?.[resultKey]?.links ?? [])
          .some(link => String(link?.constructId ?? "") === id)
      ))
    ))
  ));
}

function getAttackHitTrialIndex(target) {
  return Number(target?.closest?.("[data-attack-hit-trial-row]")?.dataset?.trialIndex ?? -1);
}

function getAttackHitOutcomeKey(target) {
  const key = String(target?.closest?.("[data-attack-hit-outcome-row]")?.dataset?.outcomeKey ?? "");
  return ATTACK_HIT_OUTCOME_KEYS.includes(key) ? key : "";
}

function collectAttackTrialConstructIds(trial = null) {
  return ATTACK_HIT_OUTCOME_KEYS.flatMap(resultKey => (
    trial?.outcomes?.[resultKey]?.links ?? []
  )).map(link => String(link?.constructId ?? "")).filter(Boolean);
}

function removeUnlinkedAttackOutcomeConstructs(ability, constructIds = []) {
  const ids = new Set((constructIds ?? []).map(id => String(id ?? "")).filter(Boolean));
  if (!ids.size) return;
  ability.system.constructs = (ability.system.constructs ?? []).filter(construct => (
    !ids.has(String(construct?.id ?? ""))
    || isAbilityConstructLinked(ability, construct?.id)
  ));
}

function getEventReactionResourceDefinitions() {
  const resources = getResourceSettings().map(resource => ({
    key: String(resource?.key ?? "").trim(),
    label: String(resource?.label ?? resource?.key ?? "").trim(),
    supported: true
  })).filter(resource => resource.key);
  if (!resources.some(resource => resource.key === REACTION_POINTS_RESOURCE_KEY)) {
    resources.unshift({
      key: REACTION_POINTS_RESOURCE_KEY,
      label: localizeEventReactionUi("Resources.ReactionPoints", "Reaction points"),
      supported: true
    });
  }
  return resources;
}

function getConfigurableDamageTypes(damageTypeSettings = []) {
  return (damageTypeSettings ?? []).filter(damageType => !damageType?.locked && !damageType?.system);
}

function findAttackFunctionByTarget(ability, target) {
  const row = target?.closest?.("[data-ability-function-row]");
  const id = String(row?.dataset?.functionId ?? "");
  if (!id) return null;
  const abilityFunction = (ability?.system?.functions ?? [])
    .find(entry => String(entry?.id ?? "") === id);
  return abilityFunction?.type === ABILITY_FUNCTION_TYPES.attackAction ? abilityFunction : null;
}

function isKnownEventReactionResource(resourceKey = "") {
  const key = String(resourceKey ?? "").trim();
  return Boolean(key && getEventReactionResourceDefinitions().some(resource => resource.key === key));
}

function localizeCatalogValue(key = "", fallback = "") {
  if (!key) return String(fallback ?? "");
  const localized = game.i18n.localize(key);
  return localized && localized !== key ? localized : String(fallback ?? key);
}

function localizeEventReactionUi(path = "", fallback = "") {
  return localizeCatalogValue(`FALLOUTMAW.Events.Reaction.${path}`, fallback);
}

function isRuntimeCondition(type = "") {
  return [
    ABILITY_CONDITION_TYPES.toggleable,
    ABILITY_CONDITION_TYPES.triggerChance,
    ABILITY_CONDITION_TYPES.timeOfDay,
    ABILITY_CONDITION_TYPES.illumination,
    ABILITY_CONDITION_TYPES.regionPresence,
    ABILITY_CONDITION_TYPES.healthPercent,
    ABILITY_CONDITION_TYPES.equipmentSlotOccupied,
    ABILITY_CONDITION_TYPES.targetFaction,
    ABILITY_CONDITION_TYPES.targetRace,
    ABILITY_CONDITION_TYPES.targetType,
    ABILITY_CONDITION_TYPES.posture,
    ABILITY_CONDITION_TYPES.occupiedCover,
    ABILITY_CONDITION_TYPES.attackDistance,
    ABILITY_CONDITION_TYPES.weaponAction,
    ABILITY_CONDITION_TYPES.weaponSkill,
    ABILITY_CONDITION_TYPES.engagedSkill,
    ABILITY_CONDITION_TYPES.weaponProficiency,
    ABILITY_CONDITION_TYPES.aura,
    ABILITY_CONDITION_TYPES.cooldown,
    ABILITY_CONDITION_TYPES.energyConsumption
  ].includes(type);
}

function buildAuraModeChoices(selected = ABILITY_AURA_MODES.applyToTargets) {
  return [
    { value: ABILITY_AURA_MODES.triggerConditions, label: "Запускать условия по целям" },
    { value: ABILITY_AURA_MODES.applyToTargets, label: "Накладывать изменения на цели" },
    { value: ABILITY_AURA_MODES.selfWhenPresent, label: "Сбор внешних условий для наложения на себя" }
  ].map(choice => ({
    ...choice,
    selected: choice.value === selected
  }));
}

function getAuraTargetGroupsLabel(mode = "") {
  if (mode === ABILITY_AURA_MODES.triggerConditions) return "Цели условий ауры";
  return mode === ABILITY_AURA_MODES.selfWhenPresent
    ? "Цели для сбора условий"
    : "Цели воздействия";
}

function normalizeFormulaText(value = "", fallback = "0") {
  return String(value ?? "").trim() || fallback;
}

function buildAuraTargetGroupRows(value = []) {
  const selected = normalizeConditionValues(value).filter(group => ABILITY_AURA_TARGET_GROUPS.includes(group));
  return selected.map((group, index) => ({
    index,
    choices: ABILITY_AURA_TARGET_GROUPS.map(entry => ({
      value: entry,
      label: getAuraTargetGroupLabel(entry),
      selected: entry === group,
      disabled: entry !== group && selected.includes(entry)
    }))
  }));
}

function getAuraTargetGroupLabel(group = "") {
  return {
    ally: "Союзники",
    enemy: "Враги",
    neutral: "Нейтралы"
  }[group] ?? group;
}

function buildBooleanChoices(selected = false) {
  return [
    { value: "true", label: "Да", selected: Boolean(selected) },
    { value: "false", label: "Нет", selected: !selected }
  ];
}

function buildHealthTargetChoices(selected = ABILITY_HEALTH_TARGETS.general) {
  return [
    { value: ABILITY_HEALTH_TARGETS.general, label: "Общее" },
    { value: ABILITY_HEALTH_TARGETS.limb, label: "Конечности" },
    { value: ABILITY_HEALTH_TARGETS.criticalLimb, label: "Критические конечности" }
  ].map(choice => ({
    ...choice,
    selected: choice.value === selected
  }));
}

function buildLimbChoices(selected = ABILITY_HEALTH_LIMB_ALL, { criticalOnly = false } = {}) {
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

function buildAcquisitionRequirementTypeChoices(selected = "") {
  const labels = {
    [ABILITY_ACQUISITION_CONDITION_TYPES.race]: "Раса",
    [ABILITY_ACQUISITION_CONDITION_TYPES.characteristic]: "Характеристика",
    [ABILITY_ACQUISITION_CONDITION_TYPES.skill]: "Навык",
    [ABILITY_ACQUISITION_CONDITION_TYPES.ability]: "Другая способность"
  };
  return [
    { value: "", label: "", selected: !selected },
    ...Object.values(ABILITY_ACQUISITION_CONDITION_TYPES).map(value => ({
      value,
      label: labels[value] ?? value,
      selected: selected === value
    }))
  ];
}

function buildAcquisitionAbilityModeChoices(selected = ABILITY_ACQUISITION_ABILITY_MODES.present) {
  const mode = Object.values(ABILITY_ACQUISITION_ABILITY_MODES).includes(selected)
    ? selected
    : ABILITY_ACQUISITION_ABILITY_MODES.present;
  const labels = {
    [ABILITY_ACQUISITION_ABILITY_MODES.present]: "Наличие способности",
    [ABILITY_ACQUISITION_ABILITY_MODES.absent]: "Отсутствие способности"
  };
  return Object.values(ABILITY_ACQUISITION_ABILITY_MODES).map(value => ({
    value,
    label: labels[value] ?? value,
    selected: value === mode
  }));
}

async function resolveDroppedAbilitySourceId(event) {
  const data = TextEditor.getDragEventData(event);
  if (data?.type === ABILITY_CATALOG_DRAG_TYPE) {
    return String(data.sourceId ?? "").trim();
  }
  if (data?.type === "Item") {
    const item = await fromUuid(String(data.uuid ?? "").trim());
    if (item?.type === "ability") return getAbilitySourceId(item);
  }
  return "";
}

function buildRaceChoices(selected = "") {
  const races = [...(getCreatureOptions().races ?? [])];
  if (selected && !races.some(race => race.id === selected)) races.push({ id: selected, name: selected });
  return races.map(race => ({
    value: race.id,
    label: race.name || race.id,
    selected: race.id === selected
  }));
}

function buildCharacteristicChoices(selected = "", characteristicSettings = []) {
  const entries = [...characteristicSettings];
  if (selected && !entries.some(entry => entry.key === selected)) entries.push({ key: selected, label: selected });
  return entries.map(entry => ({
    value: entry.key,
    label: entry.label || entry.key,
    selected: entry.key === selected
  }));
}

function buildSkillChoices(selected = "", skillSettings = []) {
  const entries = [...skillSettings];
  if (selected && !entries.some(entry => entry.key === selected)) entries.push({ key: selected, label: selected });
  return entries.map(entry => ({
    value: entry.key,
    label: entry.label || entry.key,
    selected: entry.key === selected
  }));
}

function buildWeaponActionEntries() {
  return [
    { key: "aimedShot", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionAimedShot") },
    { key: "snapshot", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionSnapshot") },
    { key: "burst", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionBurst") },
    { key: "volley", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionVolley") },
    { key: "meleeAttack", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionMeleeAttack") },
    { key: "aimedMeleeAttack", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionAimedMeleeAttack") },
    { key: "push", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionPush") }
  ];
}

function buildWeaponActionRows(value = []) {
  return normalizeConditionValues(value).map((actionKey, index) => ({
    index,
    choices: getWeaponActionEntriesWithSelected(actionKey).map(entry => ({
      value: entry.key,
      label: entry.label || entry.key,
      selected: entry.key === actionKey
    }))
  }));
}

function getWeaponActionEntriesWithSelected(selected = "") {
  const entries = buildWeaponActionEntries();
  if (selected && !entries.some(entry => entry.key === selected)) entries.push({ key: selected, label: selected });
  return entries;
}

function getFirstUnusedWeaponActionKey(value = []) {
  const selected = new Set(normalizeConditionValues(value));
  return buildWeaponActionEntries().find(entry => !selected.has(entry.key))?.key ?? "";
}

function buildSkillRows(value = []) {
  return normalizeConditionValues(value).map((skillKey, index) => ({
    index,
    choices: getSkillEntriesWithSelected(skillKey).map(entry => ({
      value: entry.key,
      label: entry.label || entry.key,
      selected: entry.key === skillKey
    }))
  }));
}

function getSkillEntriesWithSelected(selected = "") {
  const entries = [...getSkillSettings()];
  if (selected && !entries.some(entry => entry.key === selected)) entries.push({ key: selected, label: selected });
  return entries;
}

function getFirstUnusedSkillKey(value = []) {
  const selected = new Set(normalizeConditionValues(value));
  return getSkillSettings().find(entry => !selected.has(entry.key))?.key ?? "";
}

function buildProficiencyRows(value = []) {
  return normalizeConditionValues(value).map((proficiencyKey, index) => ({
    index,
    choices: getProficiencyEntriesWithSelected(proficiencyKey).map(entry => ({
      value: entry.key,
      label: entry.label || entry.key,
      selected: entry.key === proficiencyKey
    }))
  }));
}

function getProficiencyEntriesWithSelected(selected = "") {
  const entries = [...getProficiencySettings()];
  if (selected && !entries.some(entry => entry.key === selected)) entries.push({ key: selected, label: selected });
  return entries;
}

function getFirstUnusedProficiencyKey(value = []) {
  const selected = new Set(normalizeConditionValues(value));
  return getProficiencySettings().find(entry => !selected.has(entry.key))?.key ?? "";
}

function buildEquipmentSlotChoices(selected = "") {
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

function buildTargetFactionRows(value = []) {
  const selected = normalizeConditionValues(value);
  return selected.map((faction, index) => ({
    index,
    choices: getFactionNamesWithDefault(getFactionSettings()).map(name => ({
      value: name,
      label: name,
      selected: name === faction
    }))
  }));
}

function getFirstUnusedTargetFaction(value = []) {
  const selected = new Set(normalizeConditionValues(value));
  return getFactionNamesWithDefault(getFactionSettings()).find(name => !selected.has(name)) ?? "";
}

function buildTargetRaceChoices(selected = "") {
  return [{ value: "", label: "", selected: !selected }, ...buildRaceChoices(selected)];
}

function buildTargetTypeChoices(selected = "") {
  const types = [...(getCreatureOptions().types ?? [])];
  if (selected && !types.some(type => type.id === selected)) types.push({ id: selected, name: selected });
  return [
    { value: "", label: "", selected: !selected },
    ...types.map(type => ({ value: type.id, label: type.name || type.id, selected: type.id === selected }))
  ];
}

function buildPostureSubjectChoices(selected = ABILITY_POSTURE_SUBJECTS.self) {
  return [
    { value: ABILITY_POSTURE_SUBJECTS.self, label: "Свое положение" },
    { value: ABILITY_POSTURE_SUBJECTS.target, label: "Положение цели" }
  ].map(choice => ({ ...choice, selected: choice.value === selected }));
}

function buildPostureRows(value = []) {
  const labels = {
    walk: "Стоя",
    crawl: "В приседе",
    burrow: "Лежа",
    knocked: "Опрокинут"
  };
  return normalizeConditionValues(value).map((posture, index) => ({
    index,
    choices: ABILITY_POSTURE_ACTIONS.map(action => ({
      value: action,
      label: labels[action] ?? action,
      selected: action === posture
    }))
  }));
}

function buildCoverRows(value = []) {
  return normalizeConditionValues(value).map((coverKey, index) => ({
    index,
    choices: getCoverEntriesWithSelected(coverKey).map(entry => ({
      value: entry.key,
      label: entry.label || entry.key,
      selected: entry.key === coverKey
    }))
  }));
}

function getCoverEntriesWithSelected(selected = "") {
  const entries = [...getCoverSettings().entries];
  if (selected && !entries.some(entry => entry.key === selected)) entries.push({ key: selected, label: selected });
  return entries;
}

function getFirstUnusedCoverKey(value = []) {
  const selected = new Set(normalizeConditionValues(value));
  return getCoverSettings().entries.find(entry => !selected.has(entry.key))?.key ?? "";
}

function buildRegionDamageTypeRows(value = []) {
  const selected = normalizeConditionValues(value);
  return selected.map((damageTypeKey, index) => ({
    index,
    choices: getRegionDamageTypesWithSelected(damageTypeKey).map(entry => ({
      value: entry.key,
      label: entry.label || entry.key,
      selected: entry.key === damageTypeKey,
      disabled: entry.key !== damageTypeKey && selected.includes(entry.key)
    }))
  }));
}

function getRegionDamageTypesWithSelected(selected = "") {
  const entries = [...getConfigurableDamageTypes(getDamageTypeSettings())];
  if (selected && !entries.some(entry => entry.key === selected)) entries.push({ key: selected, label: selected });
  return entries;
}

function getFirstUnusedRegionDamageTypeKey(value = []) {
  const selected = new Set(normalizeConditionValues(value));
  return getConfigurableDamageTypes(getDamageTypeSettings()).find(entry => !selected.has(entry.key))?.key ?? "";
}

function buildRegionSpecialPropertyRows(value = []) {
  const selected = normalizeConditionValues(value);
  return selected.map((type, index) => ({
    index,
    choices: [{ value: REGION_SPECIAL_PROPERTY_SMOKE, label: "Задымление" }].map(choice => ({
      ...choice,
      selected: choice.value === type,
      disabled: choice.value !== type && selected.includes(choice.value)
    }))
  }));
}

function getFirstUnusedRegionSpecialPropertyType(value = []) {
  const selected = new Set(normalizeConditionValues(value));
  return [REGION_SPECIAL_PROPERTY_SMOKE].find(type => !selected.has(type)) ?? "";
}

function normalizeConditionValues(value = []) {
  const source = Array.isArray(value) ? value : Object.values(value ?? {});
  return Array.from(new Set(source.map(entry => String(entry ?? "").trim()).filter(Boolean)));
}

function buildItemUseCategoryRows(selectedCategories = []) {
  const selected = normalizeItemUseCategoryValues(selectedCategories);
  return selected.map((category, index) => ({
    index,
    choices: buildItemUseCategoryChoices(category, selected)
  }));
}

function buildItemUseCategoryChoices(selectedCategory = "", selectedCategories = []) {
  const selected = String(selectedCategory ?? "").trim();
  const categories = getItemUseCategoryLabels(selectedCategories);
  return categories.map(category => ({
    value: category,
    label: category,
    selected: category === selected
  }));
}

function getItemUseCategoryLabels(extraCategories = []) {
  const categories = getItemCategorySettings()
    .map(category => String(category?.label ?? category ?? "").trim())
    .filter(Boolean);
  for (const category of normalizeItemUseCategoryValues(extraCategories)) {
    if (!categories.includes(category)) categories.push(category);
  }
  return categories;
}

function getFirstUnusedItemUseCategory(selectedCategories = []) {
  const selected = new Set(normalizeItemUseCategoryValues(selectedCategories));
  return getItemUseCategoryLabels().find(category => !selected.has(category)) ?? "";
}

function normalizeItemUseCategoryValues(value = []) {
  return Array.from(new Set((Array.isArray(value) ? value : Object.values(value ?? {}))
    .map(category => String(category ?? "").trim())
    .filter(Boolean)));
}

function readEventReactionDepthFilters(row) {
  const filters = {};
  for (const input of row?.querySelectorAll?.(
    "[data-field='conditionEventDepthFilter'][data-event-depth-storage-key]"
  ) ?? []) {
    const storageKey = String(input.dataset.eventDepthStorageKey ?? "").trim();
    const value = String(input.value ?? "").trim();
    if (!storageKey || !value) continue;
    const entries = filters[storageKey] ?? [];
    if (!entries.includes(value)) entries.push(value);
    filters[storageKey] = entries;
  }
  return filters;
}

function readFieldValues(root, selector) {
  return Array.from(root?.querySelectorAll(selector) ?? [])
    .filter(input => input.type !== "checkbox" || input.checked)
    .map(input => String(input.value ?? "").trim())
    .filter(Boolean);
}

function readConditionDurationSeconds(row) {
  const amountInput = row.querySelector("[data-field='conditionDurationAmount']");
  if (amountInput) {
    return durationPartsToSeconds(
      amountInput.value,
      row.querySelector("[data-field='conditionDurationUnit']")?.value
    );
  }
  return row.querySelector("[data-field='conditionDurationSeconds']")?.value ?? 0;
}

function splitDurationSeconds(value) {
  const seconds = Math.max(0, toInteger(value));
  if (seconds > 0 && seconds % 3600 === 0) return { amount: seconds / 3600, unit: "hours" };
  if (seconds > 0 && seconds % 60 === 0) return { amount: seconds / 60, unit: "minutes" };
  return { amount: seconds, unit: "seconds" };
}

function buildDurationUnitChoices(selected = "seconds") {
  return [
    { value: "seconds", label: "секунды" },
    { value: "minutes", label: "минуты" },
    { value: "hours", label: "часы" }
  ].map(choice => ({
    ...choice,
    selected: choice.value === selected
  }));
}

function durationPartsToSeconds(amount, unit) {
  const multipliers = { seconds: 1, minutes: 60, hours: 3600 };
  const multiplier = multipliers[String(unit ?? "seconds")] ?? 1;
  return Math.max(0, toInteger(amount) * multiplier);
}

function getRowIndex(root, selector, row) {
  if (!root || !row) return -1;
  return Array.from(root.querySelectorAll(selector) ?? []).indexOf(row);
}
