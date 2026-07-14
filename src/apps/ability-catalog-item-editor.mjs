import { TEMPLATES } from "../constants.mjs";
import { getCharacteristicSettings, getCoverSettings, getCreatureOptions, getItemCategorySettings, getProficiencySettings, getResourceSettings, getSkillSettings } from "../settings/accessors.mjs";
import { getFactionNamesWithDefault, getFactionSettings } from "../settings/factions.mjs";
import {
  ABILITY_ACQUISITION_CONDITION_TYPES,
  ABILITY_ACTION_POINT_COST_MODES,
  ABILITY_ACTION_TARGET_MODES,
  ABILITY_ATTACK_ACTION_ALL,
  ABILITY_ATTACKING_WEAPON_ACTION_KEYS,
  ABILITY_ACTIVE_APPLICATION_TARGET_MODES,
  ABILITY_AURA_MODES,
  ABILITY_AURA_TARGET_GROUPS,
  ABILITY_CHANGE_TYPES,
  ABILITY_CONDITION_TYPES,
  ABILITY_EQUIPMENT_OPERATORS,
  ABILITY_EVENT_TRACKING_TARGETS,
  ABILITY_EVENT_SUBJECTS,
  ABILITY_FIXED_FUNCTION_KEYS,
  ABILITY_FUNCTION_TYPES,
  ABILITY_HEALTH_LIMB_ALL,
  ABILITY_HEALTH_TARGETS,
  ABILITY_POSTURE_ACTIONS,
  ABILITY_POSTURE_SUBJECTS,
  LOCKED_FEATURES_CATEGORY_ID,
  createAbilityAcquisitionCondition,
  createAbilityAction,
  createAbilityChange,
  createAbilityCondition,
  createAbilityFunction,
  normalizeAbilityEntry,
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
  normalizeEventReactionSettings,
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
  normalizeAbilityFunctions
} from "../settings/abilities.mjs";
import {
  EVENT_REACTION_SKILL_FILTER_ALL,
  buildEventReactionPathLevels,
  isEventReactionFilterType,
  isEventReactionSkillCheckFamily,
  normalizeEventReactionSkillKeys,
  resolveEventKeyForPathPrefix
} from "../events/event-reaction-schema.mjs";
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
import { activateEffectKeyAutocomplete } from "./effect-key-autocomplete.mjs";
import { activateDescriptionFormulaAutocomplete } from "./description-formula-autocomplete.mjs";
import { activateFormulaAutocomplete } from "./formula-autocomplete.mjs";
import { FalloutMaWFormApplicationV2 } from "./base-form-application-v2.mjs";

const TextEditor = foundry.applications.ux.TextEditor.implementation;

export class AbilityCatalogItemEditor extends FalloutMaWFormApplicationV2 {
  #activeTab = "details";
  #functionPickerActive = false;
  #fixedFunctionPickerActive = false;
  #autosaveDebounced;
  #autosaveDirty = false;
  #autosaveInFlight = false;
  #autosavePromise = Promise.resolve(null);

  constructor(catalogApp, categoryId, abilityId, options = {}) {
    super(options);
    this.catalogApp = catalogApp;
    this.categoryId = categoryId;
    this.abilityId = abilityId;
    this.ability = normalizeAbilityEntry(catalogApp.getAbility(categoryId, abilityId));
    this.#autosaveDebounced = foundry.utils.debounce(() => void this.#flushAutosave(), 600);
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
      addFunctionAction: this.#onAddFunctionAction,
      deleteFunctionAction: this.#onDeleteFunctionAction,
      addFunctionAttackChoice: this.#onAddFunctionAttackChoice,
      deleteFunctionAttackChoice: this.#onDeleteFunctionAttackChoice,
      addFunctionCondition: this.#onAddFunctionCondition,
      addFunctionConditionAlternative: this.#onAddFunctionConditionAlternative,
      deleteFunctionCondition: this.#onDeleteFunctionCondition,
      addFunctionReactionCost: this.#onAddFunctionReactionCost,
      deleteFunctionReactionCost: this.#onDeleteFunctionReactionCost,
      addConditionTrackingTarget: this.#onAddConditionTrackingTarget,
      deleteConditionTrackingTarget: this.#onDeleteConditionTrackingTarget,
      addConditionEventSkill: this.#onAddConditionEventSkill,
      deleteConditionEventSkill: this.#onDeleteConditionEventSkill,
      addConditionItemCategory: this.#onAddConditionItemCategory,
      deleteConditionItemCategory: this.#onDeleteConditionItemCategory,
      addConditionTargetFaction: this.#onAddConditionTargetFaction,
      deleteConditionTargetFaction: this.#onDeleteConditionTargetFaction,
      addConditionPosture: this.#onAddConditionPosture,
      deleteConditionPosture: this.#onDeleteConditionPosture,
      addConditionCover: this.#onAddConditionCover,
      deleteConditionCover: this.#onDeleteConditionCover,
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
      deleteAcquisitionRequirement: this.#onDeleteAcquisitionRequirement
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
    const descriptionHTML = isDetailsTab ? await TextEditor.enrichHTML(this.ability.description ?? "", {
      secrets: game.user?.isGM ?? false
    }) : "";
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
      showFixedFunctionPicker: this.#fixedFunctionPickerActive,
      functionChoices: buildFunctionChoices(),
      fixedFunctionChoices: getFixedAbilityFunctionChoices(),
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
      functions: isFunctionsTab ? normalizeAbilityFunctions(this.ability.system?.functions ?? []).map(prepareFunctionForDisplay) : []
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.form?.addEventListener("input", this.#onAutosaveInput);
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
    this.element?.querySelectorAll?.("[data-field='active.targetMode']")?.forEach(select => {
      select.addEventListener("change", event => this.#onActiveApplicationTargetModeChange(event));
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
    activateAbilityFunctionKeyAutocomplete(this.element);
    activateFormulaAutocomplete(this.element, {
      characteristics: getCharacteristicSettings(),
      skills: getSkillSettings()
    });
    activateDescriptionFormulaAutocomplete(this.element);
  }

  async _processFormData(_event, _form, _formData) {
    this.#syncFromForm();
    this.#queueAutosave();
    return this.#flushAutosave({ force: true });
  }

  #onAutosaveInput = event => {
    if (!event.target?.closest?.("[data-field]")) return;
    this.#queueAutosave();
  };

  _onChangeForm(formConfig, event) {
    super._onChangeForm(formConfig, event);
    if (!event.target?.closest?.("[data-field]")) return;
    this.#queueAutosave();
  }

  async close(options = {}) {
    if (this.form) this.#syncFromForm();
    if (this.#autosaveDirty) await this.#flushAutosave({ force: true });
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
    if (![ABILITY_FUNCTION_TYPES.effectChanges, ABILITY_FUNCTION_TYPES.activeApplication, ABILITY_FUNCTION_TYPES.acquisitionChanges].includes(selected)) return undefined;
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
    if (event.currentTarget?.dataset?.field === "conditionAuraMode" && event.currentTarget.value === ABILITY_AURA_MODES.selfWhenPresent) {
      const { condition } = this.#getConditionForTarget(event.currentTarget);
      if (condition) condition.auraIncludeSelf = false;
    }
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
    const functionIndex = getRowIndex(this.form, "[data-ability-function-row]", functionRow);
    const actionIndex = getRowIndex(functionRow, "[data-ability-action-row]", target.closest("[data-ability-action-row]"));
    if (functionIndex >= 0 && actionIndex >= 0) this.ability.system.functions?.[functionIndex]?.actions?.splice(actionIndex, 1);
    return this.#persist({ render: true, sync: false });
  }

  static #onAddFunctionAttackChoice(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const functionRow = target.closest("[data-ability-function-row]");
    const actionRow = target.closest("[data-ability-action-row]");
    const functionIndex = getRowIndex(this.form, "[data-ability-function-row]", functionRow);
    const actionIndex = getRowIndex(functionRow, "[data-ability-action-row]", actionRow);
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
    const actionIndex = getRowIndex(functionRow, "[data-ability-action-row]", actionRow);
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
      this.ability.system.functions[functionIndex]?.conditions?.splice(conditionIndex, 1);
    }
    return this.#persist({ render: true, sync: false });
  }

  static #onAddFunctionReactionCost(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const functionRow = target.closest("[data-ability-function-row]");
    const functionIndex = getRowIndex(this.form, "[data-ability-function-row]", functionRow);
    const entry = this.ability.system.functions?.[functionIndex];
    if (entry?.type !== ABILITY_FUNCTION_TYPES.effectChanges) return this.#persist({ render: true, sync: false });
    const settings = normalizeEventReactionSettings(entry.reactionSettings);
    settings.costs.push({
      id: foundry.utils.randomID(),
      resourceKey: REACTION_POINTS_RESOURCE_KEY,
      formula: "1",
      overloadAmount: 0,
      overloadDurationSeconds: 0
    });
    entry.reactionSettings = settings;
    return this.#persist({ render: true, sync: false });
  }

  static #onDeleteFunctionReactionCost(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const functionRow = target.closest("[data-ability-function-row]");
    const costRow = target.closest("[data-event-reaction-cost-row]");
    const functionIndex = getRowIndex(this.form, "[data-ability-function-row]", functionRow);
    const costIndex = getRowIndex(functionRow, "[data-event-reaction-cost-row]", costRow);
    const entry = this.ability.system.functions?.[functionIndex];
    if (entry?.type !== ABILITY_FUNCTION_TYPES.effectChanges || costIndex < 0) {
      return this.#persist({ render: true, sync: false });
    }
    const settings = normalizeEventReactionSettings(entry.reactionSettings);
    settings.costs.splice(costIndex, 1);
    entry.reactionSettings = settings;
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
    if (!isEventReactionSkillCheckFamily(nextKey)) condition.skillKeys = [];
    return this.#persist({ render: true, sync: false });
  }

  static #onAddConditionEventSkill(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const { condition } = this.#getConditionForTarget(target);
    if (!condition || condition.type !== ABILITY_CONDITION_TYPES.eventReaction) {
      return this.#persist({ render: true, sync: false });
    }
    if (!isEventReactionSkillCheckFamily(condition.eventKey)) {
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

  #persist({ render = false, sync = true } = {}) {
    if (sync) this.#syncFromForm();
    this.#queueAutosave();
    if (render) return this.render();
    return this.ability;
  }

  #queueAutosave() {
    this.#autosaveDirty = true;
    this.#autosaveDebounced();
  }

  async #flushAutosave({ force = false } = {}) {
    this.#autosaveDebounced.cancel?.();
    if (this.#autosaveInFlight) {
      await this.#autosavePromise;
      return this.#flushAutosave({ force });
    }
    if (!force && !this.#autosaveDirty) return this.ability;

    if (this.form) this.#syncFromForm();
    this.#autosaveDirty = false;
    this.#autosaveInFlight = true;
    this.#autosavePromise = this.catalogApp.saveAbility(this.categoryId, this.ability);

    try {
      const saved = await this.#autosavePromise;
      if (saved) this.ability = saved;
      return this.ability;
    } finally {
      this.#autosaveInFlight = false;
      if (this.#autosaveDirty) this.#autosaveDebounced();
    }
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
        acquisition: {
          onlyFree,
          onlyManual: onlyFree ? false : (onlyManualInput ? Boolean(onlyManualInput.checked) : Boolean(acquisition.onlyManual)),
          skillKey: researchSkillInput?.value ?? acquisition.skillKey,
          difficulty: researchDifficultyInput?.value ?? acquisition.difficulty
        },
        cost: this.#isFeature ? 0 : this.form.querySelector("[data-field='cost']")?.value ?? this.ability.system?.cost,
        acquisitionRequirements: acquisitionRequirementsRoot ? readAcquisitionRequirements(acquisitionRequirementsRoot) : this.ability.system?.acquisitionRequirements,
        functions: this.#activeTab === "functions" ? readAbilityFunctions(this.form) : this.ability.system?.functions
      }
    });
  }
}

function readAbilityFunctions(root) {
  return Array.from(root.querySelectorAll("[data-ability-function-row]") ?? []).map(row => ({
    id: row.dataset.functionId || foundry.utils.randomID(),
    type: row.dataset.functionType,
    fixedKey: row.querySelector("[data-field='fixedKey']")?.value ?? "",
    fixedSettings: readFixedFunctionSettings(row),
    activeSettings: readActiveApplicationSettings(row),
    reactionSettings: readEventReactionSettings(row),
    changes: readAbilityChanges(row.querySelector("[data-ability-changes]"), "[data-ability-change-row]"),
    actions: readAbilityActions(row),
    conditions: readAbilityConditions(row.querySelector("[data-ability-conditions]")),
    penalties: readAbilityChanges(row.querySelector("[data-ability-penalties]"), "[data-ability-penalty-row]")
  }));
}

function readAbilityActions(row) {
  return Array.from(row.querySelectorAll("[data-ability-action-row]") ?? []).map(actionRow => ({
    id: actionRow.dataset.actionId || foundry.utils.randomID(),
    type: "weaponAttack",
    attackActionKeys: Array.from(actionRow.querySelectorAll("[data-field='action.attackActionKey']") ?? [])
      .map(input => String(input.value ?? "").trim())
      .filter(Boolean),
    targetMode: actionRow.querySelector("[data-field='action.targetMode']")?.value,
    actionPointCostMode: actionRow.querySelector("[data-field='action.actionPointCostMode']")?.value,
    fixedActionPointCost: actionRow.querySelector("[data-field='action.fixedActionPointCost']")?.value,
    actualActionPointCostPercent: actionRow.querySelector("[data-field='action.actualActionPointCostPercent']")?.value
  }));
}

function readEventReactionSettings(row) {
  if (row?.dataset?.functionType !== ABILITY_FUNCTION_TYPES.effectChanges) return {};
  return {
    durationSeconds: 0,
    costs: Array.from(row.querySelectorAll("[data-event-reaction-cost-row]") ?? []).map(costRow => {
      const overloadDurationRaw = costRow.querySelector("[data-field='reaction.cost.overloadDurationAmount']")?.value;
      const overloadDurationSeconds = overloadDurationRaw === "" || overloadDurationRaw === undefined || overloadDurationRaw === null
        ? 0
        : durationPartsToSeconds(
          overloadDurationRaw,
          costRow.querySelector("[data-field='reaction.cost.overloadDurationUnit']")?.value
        );
      return {
        id: costRow.dataset.costId || foundry.utils.randomID(),
        resourceKey: costRow.querySelector("[data-field='reaction.cost.resourceKey']")?.value ?? "",
        formula: costRow.querySelector("[data-field='reaction.cost.formula']")?.value ?? "0",
        overloadAmount: overloadDurationSeconds > 0
          ? Math.max(0, toInteger(costRow.querySelector("[data-field='reaction.cost.overloadAmount']")?.value ?? 0))
          : 0,
        overloadDurationSeconds
      };
    })
  };
}

function readActiveApplicationSettings(row) {
  if (row?.dataset?.functionType !== ABILITY_FUNCTION_TYPES.activeApplication) return {};
  return {
    energyCost: row.querySelector("[data-field='active.energyCost']")?.value,
    overloadEnergyCost: row.querySelector("[data-field='active.overloadEnergyCost']")?.value,
    overloadDurationSeconds: durationPartsToSeconds(
      row.querySelector("[data-field='active.overloadDurationAmount']")?.value,
      row.querySelector("[data-field='active.overloadDurationUnit']")?.value
    ),
    targetMode: row.querySelector("[data-field='active.targetMode']")?.value,
    targetLimit: row.querySelector("[data-field='active.targetLimit']")?.value,
    targetGroups: readFieldValues(row, "[data-field='active.targetGroup']"),
    excludeSelf: readBooleanField(row.querySelector("[data-field='active.excludeSelf']"), true),
    durationSeconds: durationPartsToSeconds(
      row.querySelector("[data-field='active.durationAmount']")?.value,
      row.querySelector("[data-field='active.durationUnit']")?.value
    )
  };
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
  return Array.from(root?.querySelectorAll(selector) ?? []).map(changeRow => ({
    id: changeRow.dataset.changeId || foundry.utils.randomID(),
    key: changeRow.querySelector("[data-field='changeKey']")?.value ?? "",
    type: changeRow.querySelector("[data-field='changeType']")?.value ?? ABILITY_CHANGE_TYPES.add,
    value: changeRow.querySelector("[data-field='changeValue']")?.value ?? "0",
    phase: "initial",
    priority: changeRow.querySelector("[data-field='changePriority']")?.value ?? null
  }));
}

function readAbilityConditions(root) {
  return Array.from(root?.querySelectorAll("[data-ability-condition-row]") ?? []).map(row => {
    const auraMode = row.querySelector("[data-field='conditionAuraMode']")?.value ?? ABILITY_AURA_MODES.applyToTargets;
    return {
      id: row.dataset.conditionId || foundry.utils.randomID(),
      groupId: row.querySelector("[data-field='conditionGroupId']")?.value ?? row.dataset.conditionGroupId ?? "",
      type: row.querySelector("[data-field='conditionType']")?.value || "",
      eventKey: row.querySelector("[data-field='conditionEventKey']")?.value ?? "",
      combatOnly: Boolean(row.querySelector("[data-field='conditionCombatOnly']")?.checked),
      trackingTargets: readFieldValues(row, "[data-field='conditionTrackingTarget']"),
      eventSubject: row.querySelector("[data-field='conditionEventSubject']")?.value ?? ABILITY_EVENT_SUBJECTS.reactor,
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
      weaponActionKeys: readFieldValues(row, "[data-field='conditionWeaponAction']"),
      skillKeys: (() => {
        const eventSkills = readFieldValues(row, "[data-field='conditionEventSkill']");
        if (eventSkills.length) return eventSkills;
        return readFieldValues(row, "[data-field='conditionSkill']");
      })(),
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
      auraIgnoreHidden: readBooleanField(row.querySelector("[data-field='conditionAuraIgnoreHidden']"), true),
      limit: row.querySelector("[data-field='conditionLimit']")?.value ?? 1,
      name: row.querySelector("[data-field='conditionEnergyConsumptionName']")?.value ?? "",
      amountPerHour: row.querySelector("[data-field='conditionAmountPerHour']")?.value ?? 0,
      requiredCount: row.querySelector("[data-field='conditionRequiredCount']")?.value ?? 1,
      itemCategories: readFieldValues(row, "[data-field='conditionItemCategory']"),
      durationSeconds: readConditionDurationSeconds(row)
    };
  });
}

function readAcquisitionRequirements(root) {
  return Array.from(root?.querySelectorAll("[data-acquisition-requirement-row]") ?? []).map(row => ({
    id: row.dataset.requirementId || foundry.utils.randomID(),
    type: row.querySelector("[data-field='acquisitionRequirementType']")?.value || "",
    raceId: row.querySelector("[data-field='acquisitionRequirementRaceId']")?.value ?? "",
    characteristicKey: row.querySelector("[data-field='acquisitionRequirementCharacteristicKey']")?.value ?? "",
    skillKey: row.querySelector("[data-field='acquisitionRequirementSkillKey']")?.value ?? "",
    value: row.querySelector("[data-field='acquisitionRequirementValue']")?.value ?? 0
  }));
}

function readFieldValue(element, fallback = "") {
  if (!element) return fallback;
  if ("value" in element) return element.value;
  return element.getAttribute("value") ?? fallback;
}

function readBooleanField(element, fallback = false) {
  if (!element) return Boolean(fallback);
  return String(readFieldValue(element, fallback ? "true" : "false")) === "true";
}

function prepareFunctionForDisplay(entry) {
  const normalized = normalizeAbilityFunctions([entry])[0] ?? createAbilityFunction();
  const isAcquisitionChanges = normalized.type === ABILITY_FUNCTION_TYPES.acquisitionChanges;
  const isEffectChanges = normalized.type === ABILITY_FUNCTION_TYPES.effectChanges;
  const isActiveApplication = normalized.type === ABILITY_FUNCTION_TYPES.activeApplication;
  const isFixed = normalized.type === ABILITY_FUNCTION_TYPES.fixed;
  const fixedKey = String(normalized.fixedKey ?? "");
  const activeApplicationSettings = isActiveApplication
    ? prepareActiveApplicationSettingsForDisplay(normalized.activeSettings)
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
  const fixedRageSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.rage
    ? prepareRageSettingsForDisplay(normalized.fixedSettings)
    : null;
  const fixedDisarmSettings = fixedKey === ABILITY_FIXED_FUNCTION_KEYS.disarm
    ? prepareDisarmSettingsForDisplay(normalized.fixedSettings)
    : null;
  const hasEventReaction = normalized.conditions.some(condition => condition.type === ABILITY_CONDITION_TYPES.eventReaction);
  const eventReactionSettings = isEffectChanges && hasEventReaction
    ? prepareEventReactionSettingsForDisplay(normalized.reactionSettings)
    : null;
  const conditions = normalized.conditions.map(condition => prepareConditionForDisplay(condition, {
    changeCount: normalized.changes.length,
    allowLimitedChanges: isEffectChanges || isActiveApplication,
    allowEventReaction: isEffectChanges,
    eventReactionMode: hasEventReaction,
    eventReactionSettings
  }));
  const hasRuntimeConditions = normalized.conditions.some(condition => isRuntimeCondition(condition.type));
  return {
    ...normalized,
    isAcquisitionChanges,
    isEffectChanges,
    isActiveApplication,
    isFixed,
    canConfigureChanges: isEffectChanges || isAcquisitionChanges || isActiveApplication,
    canConfigureActions: isEffectChanges || isActiveApplication,
    fixedKey,
    activeApplicationSettings,
    fixedWhereAreYouGoingSettings,
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
    fixedRageSettings,
    fixedDisarmSettings,
    hasEventReaction,
    eventReactionSettings,
    hasUnsupportedEventReactionPenalties: hasEventReaction && Boolean(normalized.penalties.length),
    typeLabel: getAbilityFunctionTypeLabel(normalized, fixedKey),
    changes: normalized.changes.map(prepareChangeForDisplay),
    actions: normalized.actions.map(prepareAbilityActionForDisplay),
    conditions,
    conditionGroups: buildConditionDisplayGroups(conditions),
    penalties: normalized.penalties.map(prepareChangeForDisplay),
    hasConditions: Boolean(normalized.conditions.length),
    hasPenalties: Boolean(normalized.penalties.length),
    canAddPenalty: !hasEventReaction && hasRuntimeConditions
  };
}

function prepareAbilityActionForDisplay(action, index) {
  const selected = new Set(action.attackActionKeys ?? []);
  const allSelected = selected.has(ABILITY_ATTACK_ACTION_ALL);
  const choices = [
    { key: ABILITY_ATTACK_ACTION_ALL, label: game.i18n.localize("FALLOUTMAW.Ability.Actions.AllAttacks") },
    ...buildWeaponActionEntries()
  ];
  return {
    ...action,
    index,
    isWeaponAttack: action.type === "weaponAttack",
    attackActionRows: (allSelected ? [ABILITY_ATTACK_ACTION_ALL] : action.attackActionKeys).map((selectedKey, choiceIndex) => ({
      choiceIndex,
      choices: choices.map(choice => ({ ...choice, selected: choice.key === selectedKey }))
    })),
    canAddAttackAction: !allSelected && selected.size < ABILITY_ATTACKING_WEAPON_ACTION_KEYS.length,
    canDeleteAttackAction: !allSelected && selected.size > 1,
    usesFixedActionPointCost: action.actionPointCostMode === ABILITY_ACTION_POINT_COST_MODES.fixed,
    usesActualActionPointCost: action.actionPointCostMode === ABILITY_ACTION_POINT_COST_MODES.actual,
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

function prepareEventReactionSettingsForDisplay(settings = {}) {
  const normalized = normalizeEventReactionSettings(settings);
  return {
    ...normalized,
    costs: normalized.costs.map((cost, index) => {
      const overloadDuration = splitDurationSeconds(cost.overloadDurationSeconds);
      return {
        ...cost,
        index,
        overloadDurationAmount: cost.overloadDurationSeconds > 0 ? overloadDuration.amount : "",
        overloadDurationUnitChoices: buildDurationUnitChoices(overloadDuration.unit),
        resourceChoices: buildEventReactionResourceChoices(cost.resourceKey),
        isUnsupportedResource: !isKnownEventReactionResource(cost.resourceKey)
      };
    })
  };
}

function prepareChangeForDisplay(change, index) {
  return {
    ...change,
    index,
    priority: change.priority ?? "",
    typeChoices: buildChangeTypeChoices(change.type)
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
  if (entry.type === ABILITY_FUNCTION_TYPES.acquisitionChanges) return "Разовое изменение при приобретении";
  return "Свободная настройка";
}

function prepareActiveApplicationSettingsForDisplay(settings = {}) {
  const normalized = normalizeActiveApplicationSettings(settings);
  const overloadDuration = splitDurationSeconds(normalized.overloadDurationSeconds);
  const duration = splitDurationSeconds(normalized.durationSeconds);
  return {
    ...normalized,
    overloadDurationAmount: overloadDuration.amount,
    overloadDurationUnitChoices: buildDurationUnitChoices(overloadDuration.unit),
    durationAmount: duration.amount,
    durationUnitChoices: buildDurationUnitChoices(duration.unit),
    targetModeChoices: [
      { value: ABILITY_ACTIVE_APPLICATION_TARGET_MODES.self, label: "Себе", selected: normalized.targetMode === ABILITY_ACTIVE_APPLICATION_TARGET_MODES.self },
      { value: ABILITY_ACTIVE_APPLICATION_TARGET_MODES.others, label: "Другим", selected: normalized.targetMode === ABILITY_ACTIVE_APPLICATION_TARGET_MODES.others }
    ],
    isTargetOthers: normalized.targetMode === ABILITY_ACTIVE_APPLICATION_TARGET_MODES.others,
    targetGroupChoices: buildTargetGroupChoices(normalized.targetGroups)
  };
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
  eventReactionMode = false,
  eventReactionSettings = null
} = {}) {
  const type = String(condition?.type ?? "");
  const isEventReaction = type === ABILITY_CONDITION_TYPES.eventReaction;
  const isEventReactionFilter = isEventReactionFilterType(type);
  const isDuration = type === ABILITY_CONDITION_TYPES.duration;
  const isUnsupportedEventCondition = eventReactionMode
    && ((!isEventReaction && !isEventReactionFilter && !isDuration) || (isEventReaction && !allowEventReaction));
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
  const duration = splitDurationSeconds(condition?.durationSeconds);
  const healthTarget = Object.values(ABILITY_HEALTH_TARGETS).includes(condition?.healthTarget)
    ? condition.healthTarget
    : ABILITY_HEALTH_TARGETS.general;
  const isHealthGeneral = healthTarget === ABILITY_HEALTH_TARGETS.general;
  const isHealthLimb = healthTarget === ABILITY_HEALTH_TARGETS.limb;
  const isHealthCriticalLimb = healthTarget === ABILITY_HEALTH_TARGETS.criticalLimb;
  const eventDisplay = isEventReaction
    ? buildEventReactionDisplay(condition?.eventKey)
    : { pathLevels: [], selectedEvent: null, isUnsupported: false, showEventTiming: false, showEventSkillFilters: false };
  const trackingTargets = normalizeConditionValues(condition?.trackingTargets)
    .filter(group => ABILITY_EVENT_TRACKING_TARGETS.includes(group));
  const eventSkillKeys = isEventReaction && eventDisplay.showEventSkillFilters
    ? normalizeEventReactionSkillKeys(condition?.skillKeys)
    : [];
  return {
    ...condition,
    healthTarget,
    isPending: !isEventReaction && !isHealth && !isEquipment && !isTargetFaction && !isTargetRace && !isTargetType && !isPosture && !isOccupiedCover && !isWeaponAction && !isWeaponSkill && !isWeaponProficiency && !isAura && !isLimitedChanges && !isCooldown && !isDuration && !isEnergyConsumption && !isItemUse,
    isEventReaction,
    isEventReactionFilter,
    isUnsupportedEventCondition,
    showEventSubject: eventReactionMode && isEventReactionFilter,
    eventReactionSettings: isEventReaction ? eventReactionSettings : null,
    combatOnly: Boolean(condition?.combatOnly),
    trackingTargetRows: buildEventTrackingTargetRows(trackingTargets),
    canAddTrackingTarget: trackingTargets.length < ABILITY_EVENT_TRACKING_TARGETS.length,
    showEventTiming: Boolean(eventDisplay.showEventTiming),
    showEventSkillFilters: Boolean(eventDisplay.showEventSkillFilters),
    eventPathLevels: eventDisplay.pathLevels ?? [],
    eventSkillRows: eventDisplay.showEventSkillFilters
      ? buildEventReactionSkillRows(eventSkillKeys)
      : [],
    canAddEventSkill: eventDisplay.showEventSkillFilters
      ? Boolean(getFirstUnusedEventReactionSkillKey(eventSkillKeys))
      : false,
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
    isDuration,
    isEnergyConsumption,
    isItemUse,
    canAddAlternative: !isEventReaction && !isUnsupportedEventCondition && !isLimitedChanges && !isCooldown && !isDuration && !isEnergyConsumption && !isItemUse,
    changeLimit: Math.max(1, Math.min(maxLimit, toInteger(condition?.limit ?? 1))),
    changeLimitMax: maxLimit,
    changeLimitTotal: changeCount,
    requiredCount: isAura ? normalizeFormulaText(condition?.requiredCount, "1") : Math.max(1, toInteger(condition?.requiredCount ?? 1)),
    durationSeconds: Math.max(0, toInteger(condition?.durationSeconds)),
    energyConsumptionName: String(condition?.name ?? "").trim(),
    amountPerHour: Math.max(0, Number(condition?.amountPerHour) || 0),
    durationAmount: duration.amount,
    durationUnitChoices: buildDurationUnitChoices(duration.unit),
    typeLabel: getConditionTypeLabel(type),
    typeChoices: buildConditionTypeChoices(type, { allowLimitedChanges, allowEventReaction, eventReactionMode }),
    eventPathLevels: eventDisplay.pathLevels ?? [],
    selectedEvent: eventDisplay.selectedEvent,
    isUnsupportedEventKey: eventDisplay.isUnsupported,
    eventSubjectChoices: buildEventSubjectChoices(condition?.eventSubject),
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
    weaponActionRows: buildWeaponActionRows(condition?.weaponActionKeys),
    canAddWeaponAction: Boolean(getFirstUnusedWeaponActionKey(condition?.weaponActionKeys)),
    skillRows: buildSkillRows(condition?.skillKeys),
    canAddSkill: Boolean(getFirstUnusedSkillKey(condition?.skillKeys)),
    proficiencyRows: buildProficiencyRows(condition?.proficiencyKeys),
    canAddProficiency: Boolean(getFirstUnusedProficiencyKey(condition?.proficiencyKeys)),
    auraModeChoices: buildAuraModeChoices(condition?.auraMode),
    auraTargetGroupsLabel: getAuraTargetGroupsLabel(condition?.auraMode),
    showAuraIncludeSelf: condition?.auraMode !== ABILITY_AURA_MODES.selfWhenPresent,
    auraTargetGroupRows: buildAuraTargetGroupRows(condition?.auraTargetGroups),
    canAddAuraTargetGroup: normalizeConditionValues(condition?.auraTargetGroups).filter(group => ABILITY_AURA_TARGET_GROUPS.includes(group)).length < ABILITY_AURA_TARGET_GROUPS.length,
    auraRadiusMeters: normalizeFormulaText(condition?.auraRadiusMeters, "0"),
    auraWallsBlockChoices: buildBooleanChoices(condition?.auraWallsBlock !== false),
    auraIncludeSelfChoices: buildBooleanChoices(condition?.auraIncludeSelf !== false),
    auraCombatOnlyChoices: buildBooleanChoices(Boolean(condition?.auraCombatOnly)),
    auraCombatantsOnlyChoices: buildBooleanChoices(Boolean(condition?.auraCombatantsOnly)),
    auraIgnoreIncapacitatedChoices: buildBooleanChoices(condition?.auraIgnoreIncapacitated !== false),
    auraIgnoreHiddenChoices: buildBooleanChoices(condition?.auraIgnoreHidden !== false),
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

function prepareAcquisitionRequirementForDisplay(requirement, { characteristicSettings = [], skillSettings = [] } = {}) {
  const type = String(requirement?.type ?? "");
  const isRace = type === ABILITY_ACQUISITION_CONDITION_TYPES.race;
  const isCharacteristic = type === ABILITY_ACQUISITION_CONDITION_TYPES.characteristic;
  const isSkill = type === ABILITY_ACQUISITION_CONDITION_TYPES.skill;
  return {
    ...requirement,
    value: Math.max(0, toInteger(requirement?.value)),
    isPending: !isRace && !isCharacteristic && !isSkill,
    isRace,
    isCharacteristic,
    isSkill,
    typeLabel: getAcquisitionRequirementTypeLabel(type),
    typeChoices: buildAcquisitionRequirementTypeChoices(type),
    raceChoices: buildRaceChoices(requirement?.raceId),
    characteristicChoices: buildCharacteristicChoices(requirement?.characteristicKey, characteristicSettings),
    skillChoices: buildSkillChoices(requirement?.skillKey, skillSettings)
  };
}

function getConditionTypeLabel(type) {
  return buildConditionTypeChoices(type, { allowLimitedChanges: true }).find(choice => choice.value === type)?.label ?? type;
}

function getAcquisitionRequirementTypeLabel(type) {
  return buildAcquisitionRequirementTypeChoices(type).find(choice => choice.value === type)?.label ?? type;
}

function buildFunctionChoices() {
  return [
    { value: "", label: "Выберите функцию", disabled: true, selected: true },
    { value: ABILITY_FUNCTION_TYPES.fixed, label: "Фиксированные функции" },
    { value: ABILITY_FUNCTION_TYPES.activeApplication, label: "Активное применение" },
    { value: ABILITY_FUNCTION_TYPES.effectChanges, label: "Свободная настройка" },
    { value: ABILITY_FUNCTION_TYPES.acquisitionChanges, label: "Разовое изменение при приобретении" }
  ];
}

function activateAbilityFunctionKeyAutocomplete(root) {
  if (!root) return;
  activateEffectKeyAutocomplete(root, buildEffectKeyTokens(), {
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

function buildConditionTypeChoices(selected = "", {
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
      label: localizeEventReactionUi("ConditionLabel", "Event reaction"),
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
  if (!eventReactionMode) return choices;
  return choices
    .filter(choice => (
      !choice.value
      || choice.value === ABILITY_CONDITION_TYPES.eventReaction
      || choice.value === ABILITY_CONDITION_TYPES.duration
      || isEventReactionFilterType(choice.value)
      || choice.value === selected
    ))
    .map(choice => choice.value === selected
      && choice.value
      && choice.value !== ABILITY_CONDITION_TYPES.eventReaction
      && choice.value !== ABILITY_CONDITION_TYPES.duration
      && !isEventReactionFilterType(choice.value)
      ? { ...choice, label: `${choice.label} — ${localizeEventReactionUi("Unsupported", "unsupported")}` }
      : choice);
}

function buildEventReactionDisplay(selectedKey = "") {
  const key = String(selectedKey ?? "").trim();
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
    showEventSkillFilters: isEventReactionSkillCheckFamily(key),
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
    neutral: localizeEventReactionUi("TrackingTargetOptions.Neutral", "Neutral")
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

function buildAuraModeChoices(selected = ABILITY_AURA_MODES.applyToTargets) {
  return [
    { value: ABILITY_AURA_MODES.applyToTargets, label: "Обычный" },
    { value: ABILITY_AURA_MODES.selfWhenPresent, label: "Сбор внешних условий для наложения на себя" }
  ].map(choice => ({
    ...choice,
    selected: choice.value === selected
  }));
}

function getAuraTargetGroupsLabel(mode = "") {
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
    [ABILITY_ACQUISITION_CONDITION_TYPES.skill]: "Навык"
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
