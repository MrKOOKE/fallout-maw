import { TEMPLATES } from "../constants.mjs";
import { getCharacteristicSettings, getCreatureOptions, getSkillSettings } from "../settings/accessors.mjs";
import {
  ABILITY_ACQUISITION_CONDITION_TYPES,
  ABILITY_CHANGE_TYPES,
  ABILITY_CONDITION_TYPES,
  ABILITY_EQUIPMENT_OPERATORS,
  ABILITY_FUNCTION_TYPES,
  ABILITY_HEALTH_LIMB_ALL,
  ABILITY_HEALTH_TARGETS,
  LOCKED_FEATURES_CATEGORY_ID,
  createAbilityAcquisitionCondition,
  createAbilityChange,
  createAbilityCondition,
  createAbilityFunction,
  normalizeAbilityEntry,
  normalizeAbilityFunctions
} from "../settings/abilities.mjs";
import { buildEffectKeyTokens } from "../utils/effect-key-tokens.mjs";
import { buildAbilityAcquisitionChangeKeyTokens } from "../utils/ability-acquisition-change-keys.mjs";
import { getEquipmentSlotSelectionKey } from "../utils/equipment-slots.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { activateEffectKeyAutocomplete } from "./effect-key-autocomplete.mjs";
import { FalloutMaWFormApplicationV2 } from "./base-form-application-v2.mjs";

const TextEditor = foundry.applications.ux.TextEditor.implementation;

export class AbilityCatalogItemEditor extends FalloutMaWFormApplicationV2 {
  #activeTab = "details";
  #functionPickerActive = false;
  #saveDebounced;

  constructor(catalogApp, categoryId, abilityId, options = {}) {
    super(options);
    this.catalogApp = catalogApp;
    this.categoryId = categoryId;
    this.abilityId = abilityId;
    this.ability = normalizeAbilityEntry(catalogApp.getAbility(categoryId, abilityId));
    this.#saveDebounced = foundry.utils.debounce(() => void this.#persist(), 250);
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
    actions: {
      editAbilityImage: this.#onEditAbilityImage,
      selectTab: this.#onSelectTab,
      addFunction: this.#onAddFunction,
      deleteFunction: this.#onDeleteFunction,
      addFunctionChange: this.#onAddFunctionChange,
      deleteFunctionChange: this.#onDeleteFunctionChange,
      addFunctionCondition: this.#onAddFunctionCondition,
      addFunctionConditionAlternative: this.#onAddFunctionConditionAlternative,
      deleteFunctionCondition: this.#onDeleteFunctionCondition,
      addFunctionPenalty: this.#onAddFunctionPenalty,
      deleteFunctionPenalty: this.#onDeleteFunctionPenalty,
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
    const characteristics = getCharacteristicSettings();
    const skills = getSkillSettings();
    const descriptionHTML = await TextEditor.enrichHTML(this.ability.description ?? "", {
      secrets: game.user?.isGM ?? false
    });
    return {
      ...(await super._prepareContext(options)),
      ability: this.ability,
      system: this.ability.system,
      isFeature: this.#isFeature,
      isDetailsTab: this.#activeTab === "details",
      isFunctionsTab: this.#activeTab === "functions",
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
      functionChoices: buildFunctionChoices(),
      onlyFree: Boolean(this.ability.system?.acquisition?.onlyFree),
      onlyManual: Boolean(this.ability.system?.acquisition?.onlyManual),
      acquisitionRequirements: (this.ability.system?.acquisitionRequirements ?? []).map(requirement => prepareAcquisitionRequirementForDisplay(requirement, {
        characteristicSettings: characteristics,
        skillSettings: skills
      })),
      researchDifficulty: Math.max(0, toInteger(this.ability.system?.acquisition?.difficulty ?? 60)),
      researchSkillChoices: skills.map((skill, index) => ({
        key: skill.key,
        label: skill.label,
        selected: skill.key === this.ability.system?.acquisition?.skillKey || (!this.ability.system?.acquisition?.skillKey && index === 0)
      })),
      functions: normalizeAbilityFunctions(this.ability.system?.functions ?? []).map(prepareFunctionForDisplay)
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.form?.addEventListener("input", this.#onAutosaveInput);
    this.form?.addEventListener("change", this.#onAutosaveChange);
    this.element?.querySelector?.("[data-choose-ability-function]")?.addEventListener("change", event => this.#onChooseFunction(event));
    this.element?.querySelectorAll?.("[data-field='conditionType']")?.forEach(select => {
      select.addEventListener("change", event => this.#onConditionTypeChange(event));
    });
    this.element?.querySelectorAll?.("[data-field='conditionHealthTarget']")?.forEach(select => {
      select.addEventListener("change", event => this.#onConditionTypeChange(event));
    });
    this.element?.querySelectorAll?.("[data-field='acquisitionRequirementType']")?.forEach(select => {
      select.addEventListener("change", event => this.#onAcquisitionRequirementTypeChange(event));
    });
    activateAbilityFunctionKeyAutocomplete(this.element);
  }

  async _processFormData(_event, _form, _formData) {
    return this.#persist();
  }

  #onAutosaveInput = event => {
    if (!event.target?.closest?.("[data-field]")) return;
    this.#saveDebounced();
  };

  #onAutosaveChange = event => {
    if (!event.target?.closest?.("[data-field]")) return;
    return this.#persist();
  };

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
    if (![ABILITY_FUNCTION_TYPES.effectChanges, ABILITY_FUNCTION_TYPES.acquisitionChanges].includes(selected)) return undefined;
    this.ability.system.functions.push(createAbilityFunction(selected));
    this.#functionPickerActive = false;
    this.#activeTab = "functions";
    return this.#persist({ render: true, sync: false });
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
    if (functionIndex >= 0) this.ability.system.functions[functionIndex]?.changes?.push(createAbilityChange());
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

  static #onAddFunctionCondition(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const functionRow = target.closest("[data-ability-function-row]");
    const functionIndex = getRowIndex(this.form, "[data-ability-function-row]", functionRow);
    if (functionIndex >= 0) this.ability.system.functions[functionIndex]?.conditions?.push(createAbilityCondition(""));
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

  static #onAddFunctionPenalty(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const functionIndex = getRowIndex(this.form, "[data-ability-function-row]", target.closest("[data-ability-function-row]"));
    const entry = this.ability.system.functions[functionIndex];
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

  async #persist({ render = false, sync = true } = {}) {
    if (sync) this.#syncFromForm();
    const saved = await this.catalogApp.saveAbility(this.categoryId, this.ability);
    if (saved) this.ability = saved;
    if (render) return this.render();
    return saved;
  }

  #syncFromForm() {
    if (!this.form) return;
    const onlyFree = Boolean(this.form.querySelector("[data-field='onlyFree']")?.checked);
    this.ability = normalizeAbilityEntry({
      ...this.ability,
      name: this.form.querySelector("[data-field='name']")?.value ?? this.ability.name,
      img: this.form.querySelector("[data-field='img']")?.value ?? this.ability.img,
      description: readFieldValue(this.form.querySelector("[data-field='description']"), this.ability.description),
      system: {
        ...(this.ability.system ?? {}),
        acquisition: {
          onlyFree,
          onlyManual: onlyFree ? false : Boolean(this.form.querySelector("[data-field='onlyManual']")?.checked),
          skillKey: this.form.querySelector("[data-field='researchSkillKey']")?.value ?? this.ability.system?.acquisition?.skillKey,
          difficulty: this.form.querySelector("[data-field='researchDifficulty']")?.value ?? this.ability.system?.acquisition?.difficulty
        },
        cost: this.#isFeature ? 0 : this.form.querySelector("[data-field='cost']")?.value ?? this.ability.system?.cost,
        acquisitionRequirements: readAcquisitionRequirements(this.form.querySelector("[data-acquisition-requirements]")),
        functions: readAbilityFunctions(this.form)
      }
    });
  }
}

function readAbilityFunctions(root) {
  return Array.from(root.querySelectorAll("[data-ability-function-row]") ?? []).map(row => ({
    id: row.dataset.functionId || foundry.utils.randomID(),
    type: row.dataset.functionType,
    changes: readAbilityChanges(row.querySelector(":scope > [data-ability-changes]"), "[data-ability-change-row]"),
    conditions: readAbilityConditions(row.querySelector("[data-ability-conditions]")),
    penalties: readAbilityChanges(row.querySelector("[data-ability-penalties]"), "[data-ability-penalty-row]")
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
  return Array.from(root?.querySelectorAll("[data-ability-condition-row]") ?? []).map(row => ({
    id: row.dataset.conditionId || foundry.utils.randomID(),
    groupId: row.querySelector("[data-field='conditionGroupId']")?.value ?? row.dataset.conditionGroupId ?? "",
    type: row.querySelector("[data-field='conditionType']")?.value || "",
    operator: row.querySelector("[data-field='conditionOperator']")?.value ?? "lte",
    percent: row.querySelector("[data-field='conditionPercent']")?.value ?? 50,
    healthTarget: row.querySelector("[data-field='conditionHealthTarget']")?.value ?? ABILITY_HEALTH_TARGETS.general,
    limbKey: row.querySelector("[data-field='conditionLimbKey']")?.value ?? ABILITY_HEALTH_LIMB_ALL,
    equipmentSlotKey: row.querySelector("[data-field='conditionEquipmentSlotKey']")?.value ?? "",
    limit: row.querySelector("[data-field='conditionLimit']")?.value ?? 1,
    durationSeconds: row.querySelector("[data-field='conditionDurationSeconds']")?.value ?? 0
  }));
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

function prepareFunctionForDisplay(entry) {
  const normalized = normalizeAbilityFunctions([entry])[0] ?? createAbilityFunction();
  const isAcquisitionChanges = normalized.type === ABILITY_FUNCTION_TYPES.acquisitionChanges;
  const isEffectChanges = normalized.type === ABILITY_FUNCTION_TYPES.effectChanges;
  const conditions = normalized.conditions.map(condition => prepareConditionForDisplay(condition, {
    changeCount: normalized.changes.length,
    allowLimitedChanges: isEffectChanges
  }));
  const hasRuntimeConditions = normalized.conditions.some(condition => isRuntimeCondition(condition.type));
  return {
    ...normalized,
    isAcquisitionChanges,
    isEffectChanges,
    typeLabel: isAcquisitionChanges
      ? "Разовое изменение при приобретении"
      : "Свободная настройка",
    changes: normalized.changes.map(prepareChangeForDisplay),
    conditions,
    conditionGroups: buildConditionDisplayGroups(conditions),
    penalties: normalized.penalties.map(prepareChangeForDisplay),
    hasConditions: Boolean(normalized.conditions.length),
    hasPenalties: Boolean(normalized.penalties.length),
    canAddPenalty: hasRuntimeConditions
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

function prepareConditionForDisplay(condition, { changeCount = 0, allowLimitedChanges = false } = {}) {
  const type = String(condition?.type ?? "");
  const isHealth = type === ABILITY_CONDITION_TYPES.healthPercent;
  const isEquipment = type === ABILITY_CONDITION_TYPES.equipmentSlotOccupied;
  const isLimitedChanges = type === ABILITY_CONDITION_TYPES.limitedChanges;
  const isCooldown = type === ABILITY_CONDITION_TYPES.cooldown;
  const maxLimit = Math.max(1, changeCount);
  const healthTarget = Object.values(ABILITY_HEALTH_TARGETS).includes(condition?.healthTarget)
    ? condition.healthTarget
    : ABILITY_HEALTH_TARGETS.general;
  const isHealthGeneral = healthTarget === ABILITY_HEALTH_TARGETS.general;
  const isHealthLimb = healthTarget === ABILITY_HEALTH_TARGETS.limb;
  const isHealthCriticalLimb = healthTarget === ABILITY_HEALTH_TARGETS.criticalLimb;
  return {
    ...condition,
    healthTarget,
    isPending: !isHealth && !isEquipment && !isLimitedChanges && !isCooldown,
    isHealth,
    isHealthGeneral,
    isHealthLimb,
    isHealthCriticalLimb,
    showLimbChoice: isHealth && !isHealthGeneral,
    isEquipment,
    isLimitedChanges,
    isCooldown,
    canAddAlternative: !isLimitedChanges && !isCooldown,
    changeLimit: Math.max(1, Math.min(maxLimit, toInteger(condition?.limit ?? 1))),
    changeLimitMax: maxLimit,
    changeLimitTotal: changeCount,
    durationSeconds: Math.max(0, toInteger(condition?.durationSeconds)),
    typeLabel: getConditionTypeLabel(type),
    typeChoices: buildConditionTypeChoices(type, { allowLimitedChanges }),
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
    equipmentSlotChoices: buildEquipmentSlotChoices(condition?.equipmentSlotKey)
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

function buildConditionTypeChoices(selected = "", { allowLimitedChanges = true } = {}) {
  const choices = [
    { value: "", label: "", selected: !selected },
    { value: ABILITY_CONDITION_TYPES.healthPercent, label: "Состояние ОЗ", selected: selected === ABILITY_CONDITION_TYPES.healthPercent },
    { value: ABILITY_CONDITION_TYPES.equipmentSlotOccupied, label: "Занятость слотов экипировки", selected: selected === ABILITY_CONDITION_TYPES.equipmentSlotOccupied }
  ];
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
  return choices;
}

function isRuntimeCondition(type = "") {
  return [
    ABILITY_CONDITION_TYPES.healthPercent,
    ABILITY_CONDITION_TYPES.equipmentSlotOccupied,
    ABILITY_CONDITION_TYPES.cooldown
  ].includes(type);
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

function getRowIndex(root, selector, row) {
  if (!root || !row) return -1;
  return Array.from(root.querySelectorAll(selector) ?? []).indexOf(row);
}
