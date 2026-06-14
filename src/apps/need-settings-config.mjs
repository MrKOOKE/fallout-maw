import { TEMPLATES } from "../constants.mjs";
import { createDefaultNeedSettings, IDENTIFIER_PATTERN, validateFormula } from "../formulas/index.mjs";
import {
  getCharacteristicSettings,
  getDamageTypeSettings,
  getNeedSettings,
  getProficiencySettings,
  getResourceSettings,
  getSkillSettings
} from "../settings/accessors.mjs";
import { format, localize } from "../utils/i18n.mjs";
import { buildActionCostEffectKeyTokens, buildAllSkillsEffectKeyToken, buildCombatEffectKeyTokens, buildDamageMitigationEffectKeyTokens } from "../utils/effect-key-tokens.mjs";
import { FalloutMaWFormApplicationV2, getExpandedFormData } from "./base-form-application-v2.mjs";
import { activateEffectKeyAutocomplete, createEffectKeyToken } from "./effect-key-autocomplete.mjs";
import { activateFormulaAutocomplete } from "./formula-autocomplete.mjs";
import { activateSettingsReorder } from "./settings-reorder.mjs";

const { FormDataExtended } = foundry.applications.ux;

export class NeedSettingsConfig extends FalloutMaWFormApplicationV2 {
  constructor(options = {}) {
    super(options);
    this.needs = foundry.utils.deepClone(options.needs ?? getNeedSettings());
    this.onSave = options.onSave ?? null;
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-need-settings",
    classes: ["fallout-maw", "fallout-maw-config-form", "fallout-maw-formula-config", "need-settings-config"],
    position: {
      width: 900,
      height: "auto"
    },
    window: {
      resizable: true
    },
    actions: {
      createNeed: this.#onCreateNeed,
      deleteNeed: this.#onDeleteNeed,
      openNeedSettings: this.#onOpenNeedSettings,
      resetDefaults: this.#onResetDefaults
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.settings.needs
    }
  };

  get title() {
    return localize("FALLOUTMAW.Settings.Needs.Title");
  }

  async _prepareContext(options) {
    return {
      ...(await super._prepareContext(options)),
      needs: this.needs
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    activateFormulaAutocomplete(this.element, {
      characteristics: getCharacteristicSettings(),
      skills: getSkillSettings()
    });
    activateSettingsReorder(this.element, "[data-need-row]");
  }

  async _processFormData(_event, _form, _formData) {
    const needs = this.#readNeedsFromForm();
    this.#validateNeeds(needs);

    this.onSave?.(needs);
    this.needs = foundry.utils.deepClone(needs);
    ui.notifications.info(localize("FALLOUTMAW.Messages.NeedsSaved"));
    return this.forceRender();
  }

  static #onCreateNeed(event) {
    event.preventDefault();
    this.needs = this.#readNeedsFromForm();
    this.needs.push({
      key: this.#getUniqueKey("newNeed"),
      abbr: this.#getUniqueAbbr("new"),
      label: "Новая потребность",
      formula: "0",
      color: "#8f8456",
      settings: { accumulation: { perHour: 10 }, thresholds: [], diseases: [] }
    });
    return this.forceRender();
  }

  static #onDeleteNeed(event, target) {
    event.preventDefault();
    const rows = Array.from(this.form?.querySelectorAll("[data-need-row]") ?? []);
    const index = rows.indexOf(target.closest("[data-need-row]"));
    if (index < 0) return undefined;

    this.needs = this.#readNeedsFromForm();
    this.needs.splice(index, 1);
    return this.forceRender();
  }

  static async #onResetDefaults(event) {
    event.preventDefault();
    this.needs = createDefaultNeedSettings();
    return this.forceRender();
  }

  static #onOpenNeedSettings(event, target) {
    event.preventDefault();
    this.needs = this.#readNeedsFromForm();
    const rows = Array.from(this.form?.querySelectorAll("[data-need-row]") ?? []);
    const index = rows.indexOf(target.closest("[data-need-row]"));
    const need = this.needs[index];
    if (!need) return undefined;

    return new NeedAdvancedSettingsConfig({
      need,
      onSave: settings => {
        this.needs = this.#readNeedsFromForm();
        if (!this.needs[index]) return;
        this.needs[index].settings = settings;
        this.forceRender();
      }
    }).render({ force: true });
  }

  #readNeedsFromForm() {
    const rows = Array.from(this.form?.querySelectorAll("[data-need-row]") ?? []);
    return rows.map((row, index) => {
      const key = row.querySelector("[data-field='key']")?.value?.trim() ?? "";
      const existing = this.needs.find(need => need.key === key)?.settings
        ?? this.needs[index]?.settings
        ?? {};
      return {
        key,
        abbr: row.querySelector("[data-field='abbr']")?.value?.trim() ?? "",
        label: row.querySelector("[data-field='label']")?.value?.trim() ?? "",
        formula: row.querySelector("[data-field='formula']")?.value?.trim() ?? "0",
        color: row.querySelector("[data-field='color']")?.value?.trim() ?? "#8f8456",
        settings: foundry.utils.deepClone(existing)
      };
    });
  }

  #validateNeeds(needs) {
    validateFormulaSettings(needs, "Need");
  }

  #getUniqueKey(baseKey) {
    const keys = new Set(this.needs.map(need => need.key));
    if (!keys.has(baseKey)) return baseKey;

    let index = 2;
    while (keys.has(`${baseKey}${index}`)) index += 1;
    return `${baseKey}${index}`;
  }

  #getUniqueAbbr(baseAbbr) {
    const abbreviations = new Set(this.needs.map(need => need.abbr));
    if (!abbreviations.has(baseAbbr)) return baseAbbr;

    let index = 2;
    while (abbreviations.has(`${baseAbbr}${index}`)) index += 1;
    return `${baseAbbr}${index}`;
  }
}

function validateFormulaSettings(settings, validationPrefix) {
  const keys = new Set();
  const abbreviations = new Set();
  const characteristics = getCharacteristicSettings();
  const skills = getSkillSettings();

  for (const [index, setting] of settings.entries()) {
    const key = String(setting.key ?? "").trim();
    const abbr = String(setting.abbr ?? "").trim();

    if (!IDENTIFIER_PATTERN.test(key)) throwValidationError(format(`FALLOUTMAW.Validation.${validationPrefix}KeyInvalid`, { index: index + 1 }));
    if (keys.has(key)) throwValidationError(format(`FALLOUTMAW.Validation.${validationPrefix}KeyDuplicate`, { key }));

    if (!IDENTIFIER_PATTERN.test(abbr)) throwValidationError(format(`FALLOUTMAW.Validation.${validationPrefix}AbbrInvalid`, { index: index + 1 }));
    if (abbreviations.has(abbr)) throwValidationError(format(`FALLOUTMAW.Validation.${validationPrefix}AbbrDuplicate`, { abbr }));

    keys.add(key);
    abbreviations.add(abbr);

    try {
      validateFormula(setting.formula, { allowSkills: true, characteristics, skills });
    } catch (error) {
      throwValidationError(`${setting.label || key}: ${error.message}`);
    }
  }
}

function throwValidationError(message) {
  ui.notifications.error(message);
  throw new Error(message);
}

export class NeedAdvancedSettingsConfig extends FalloutMaWFormApplicationV2 {
  constructor({ need = {}, onSave = null } = {}) {
    super();
    this.need = foundry.utils.deepClone(need);
    this.need.settings = normalizeNeedAdvancedSettings(this.need.settings ?? {});
    this.onSave = onSave;
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-need-advanced-settings",
    classes: ["fallout-maw", "fallout-maw-config-form", "need-advanced-settings-config"],
    position: {
      width: 920,
      height: "auto"
    },
    window: {
      resizable: true
    },
    actions: {
      addThreshold: this.#onAddThreshold,
      deleteThreshold: this.#onDeleteThreshold,
      addThresholdEffect: this.#onAddThresholdEffect,
      deleteThresholdEffect: this.#onDeleteThresholdEffect,
      addDisease: this.#onAddDisease,
      deleteDisease: this.#onDeleteDisease,
      addDiseaseStage: this.#onAddDiseaseStage,
      deleteDiseaseStage: this.#onDeleteDiseaseStage,
      addDiseaseStageEffect: this.#onAddDiseaseStageEffect,
      deleteDiseaseStageEffect: this.#onDeleteDiseaseStageEffect
    },
    form: {
      handler: FalloutMaWFormApplicationV2.handleFormSubmit,
      submitOnChange: false,
      closeOnSubmit: true
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.settings.needSettings
    }
  };

  get title() {
    return `Доп. настройки потребности: ${this.need.label || this.need.key}`;
  }

  async _prepareContext(options) {
    return {
      ...(await super._prepareContext(options)),
      need: this.need,
      settings: prepareNeedAdvancedSettings(this.need.settings)
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    activateEffectKeyAutocomplete(this.element, buildEffectKeyTokens());
  }

  async _processFormData(_event, _form, formData) {
    const data = getExpandedFormData(formData);
    this.onSave?.(normalizeNeedAdvancedSettings(data.settings ?? {}));
  }

  static #onAddThreshold(event) {
    event.preventDefault();
    this.#syncFromForm();
    this.need.settings.thresholds.push({ id: foundry.utils.randomID(), percent: 50, diseaseLevel: 0, effects: [] });
    return this.forceRender();
  }

  static #onDeleteThreshold(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const index = getRowIndex(this.form, target, "[data-need-threshold-row]");
    if (index >= 0) this.need.settings.thresholds.splice(index, 1);
    return this.forceRender();
  }

  static #onAddThresholdEffect(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const index = getRowIndex(this.form, target, "[data-need-threshold-row]");
    this.need.settings.thresholds[index]?.effects.push(createBlankEffect());
    return this.forceRender();
  }

  static #onDeleteThresholdEffect(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const thresholdElement = target.closest("[data-need-threshold-row]");
    const thresholdIndex = getRowIndex(this.form, target, "[data-need-threshold-row]");
    const effectIndex = getScopedRowIndex(thresholdElement, target, "[data-need-effect-row]");
    if (thresholdIndex >= 0 && effectIndex >= 0) this.need.settings.thresholds[thresholdIndex]?.effects.splice(effectIndex, 1);
    return this.forceRender();
  }

  static #onAddDisease(event) {
    event.preventDefault();
    this.#syncFromForm();
    this.need.settings.diseases.push({
      id: foundry.utils.randomID(),
      name: "Новая болезнь",
      img: "",
      stages: [{ id: foundry.utils.randomID(), level: 1, name: "1 стадия", img: "", healingDifficulty: 60, healingToolClass: "D", healingProgress: 100, healingSkillKey: "doctor", effects: [] }]
    });
    return this.forceRender();
  }

  static #onDeleteDisease(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const index = getRowIndex(this.form, target, "[data-need-disease-row]");
    if (index >= 0) this.need.settings.diseases.splice(index, 1);
    return this.forceRender();
  }

  static #onAddDiseaseStage(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const diseaseIndex = getRowIndex(this.form, target, "[data-need-disease-row]");
    const stages = this.need.settings.diseases[diseaseIndex]?.stages;
    if (stages) {
      stages.push({
        id: foundry.utils.randomID(),
        level: (stages.at(-1)?.level ?? 0) + 1,
        name: "",
        img: "",
        healingDifficulty: 60,
        healingToolClass: "D",
        healingProgress: 100,
        healingSkillKey: "doctor",
        effects: []
      });
    }
    return this.forceRender();
  }

  static #onDeleteDiseaseStage(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const diseaseElement = target.closest("[data-need-disease-row]");
    const diseaseIndex = getRowIndex(this.form, target, "[data-need-disease-row]");
    const stageIndex = getScopedRowIndex(diseaseElement, target, "[data-need-disease-stage-row]");
    if (diseaseIndex >= 0 && stageIndex >= 0) this.need.settings.diseases[diseaseIndex]?.stages.splice(stageIndex, 1);
    return this.forceRender();
  }

  static #onAddDiseaseStageEffect(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const diseaseElement = target.closest("[data-need-disease-row]");
    const diseaseIndex = getRowIndex(this.form, target, "[data-need-disease-row]");
    const stageIndex = getScopedRowIndex(diseaseElement, target, "[data-need-disease-stage-row]");
    this.need.settings.diseases[diseaseIndex]?.stages[stageIndex]?.effects.push(createBlankEffect());
    return this.forceRender();
  }

  static #onDeleteDiseaseStageEffect(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const diseaseElement = target.closest("[data-need-disease-row]");
    const stageElement = target.closest("[data-need-disease-stage-row]");
    const diseaseIndex = getRowIndex(this.form, target, "[data-need-disease-row]");
    const stageIndex = getScopedRowIndex(diseaseElement, target, "[data-need-disease-stage-row]");
    const effectIndex = getScopedRowIndex(stageElement, target, "[data-need-effect-row]");
    if (diseaseIndex >= 0 && stageIndex >= 0 && effectIndex >= 0) {
      this.need.settings.diseases[diseaseIndex]?.stages[stageIndex]?.effects.splice(effectIndex, 1);
    }
    return this.forceRender();
  }

  #syncFromForm() {
    if (!this.form) {
      this.need.settings = normalizeNeedAdvancedSettings(this.need.settings);
      return;
    }
    this.need.settings = normalizeNeedAdvancedSettings(getExpandedFormData(new FormDataExtended(this.form)).settings ?? {});
  }
}

function normalizeNeedAdvancedSettings(settings = {}) {
  return {
    accumulation: {
      perHour: Math.max(0, Number(settings.accumulation?.perHour) || 0)
    },
    thresholds: normalizeIndexedCollection(settings.thresholds).map((entry, index) => ({
      id: String(entry?.id ?? `threshold-${index + 1}`),
      percent: clampPercent(Number(entry?.percent) || 0),
      diseaseLevel: Math.max(0, Math.trunc(Number(entry?.diseaseLevel) || 0)),
      effects: normalizeEffects(entry?.effects)
    })).sort((left, right) => left.percent - right.percent),
    diseases: normalizeIndexedCollection(settings.diseases).map((entry, index) => ({
      id: String(entry?.id ?? `disease-${index + 1}`),
      name: String(entry?.name ?? "").trim() || `Болезнь ${index + 1}`,
      img: String(entry?.img ?? "").trim(),
      stages: normalizeIndexedCollection(entry?.stages).map((stage, stageIndex) => ({
        id: String(stage?.id ?? `stage-${stageIndex + 1}`),
        level: Math.max(0, Math.trunc(Number(stage?.level) || 0)),
        name: String(stage?.name ?? "").trim(),
        img: String(stage?.img ?? "").trim(),
        healingDifficulty: Math.max(0, Math.trunc(Number(stage?.healingDifficulty) || 60)),
        healingToolClass: normalizeToolClass(stage?.healingToolClass),
        healingProgress: Math.max(1, Math.trunc(Number(stage?.healingProgress ?? stage?.healingProgressMax) || 100)),
        healingSkillKey: String(stage?.healingSkillKey ?? "doctor").trim() || "doctor",
        effects: normalizeEffects(stage?.effects)
      })).filter(stage => stage.level > 0)
    })).filter(disease => disease.stages.length)
  };
}

function prepareNeedAdvancedSettings(settings = {}) {
  const skillSettings = getSkillSettings();
  return {
    accumulation: {
      perHour: Math.max(0, Number(settings.accumulation?.perHour) || 0)
    },
    thresholds: (settings.thresholds ?? []).map(threshold => ({
      ...threshold,
      effects: (threshold.effects ?? []).map(prepareEffectRow)
    })),
    diseases: (settings.diseases ?? []).map(disease => ({
      ...disease,
      stages: (disease.stages ?? []).map(stage => ({
        ...stage,
        healingToolClassChoices: buildHealingToolClassChoices(stage.healingToolClass),
        healingSkillChoices: buildHealingSkillChoices(stage.healingSkillKey, skillSettings),
        effects: (stage.effects ?? []).map(prepareEffectRow)
      }))
    }))
  };
}

function normalizeIndexedCollection(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  return Object.keys(value).sort((left, right) => Number(left) - Number(right)).map(key => value[key]);
}

function normalizeEffects(effects) {
  return normalizeIndexedCollection(effects).map(entry => {
    const priority = Number(entry?.priority);
    const effect = {
      key: String(entry?.key ?? "").trim(),
      type: String(entry?.type ?? "add").trim() || "add",
      value: String(entry?.value ?? "0"),
      phase: "initial"
    };
    if (Number.isFinite(priority)) effect.priority = Math.trunc(priority);
    return effect;
  }).filter(effect => effect.key);
}

function prepareEffectRow(effect = {}) {
  return {
    ...effect,
    addSelected: String(effect?.type ?? "add") === "add",
    overrideSelected: String(effect?.type ?? "") === "override",
    priority: Number.isFinite(Number(effect?.priority)) ? Number(effect.priority) : ""
  };
}

function createBlankEffect() {
  return { key: "", type: "add", value: "0", phase: "initial", priority: null };
}

function buildHealingToolClassChoices(selected = "D") {
  const normalized = normalizeToolClass(selected);
  return ["D", "C", "B", "A", "S"].map(value => ({ value, label: value, selected: value === normalized }));
}

function buildHealingSkillChoices(selected = "doctor", skills = []) {
  const normalized = String(selected || "doctor");
  return skills.map(skill => ({ key: skill.key, label: skill.label, selected: skill.key === normalized }));
}

function normalizeToolClass(value) {
  const normalized = String(value ?? "D").trim().toUpperCase();
  return ["D", "C", "B", "A", "S"].includes(normalized) ? normalized : "D";
}

function getRowIndex(form, target, selector) {
  const row = target.closest(selector);
  const rows = Array.from(form?.querySelectorAll(selector) ?? []);
  return rows.indexOf(row);
}

function getScopedRowIndex(scope, target, selector) {
  const row = target.closest(selector);
  const rows = Array.from(scope?.querySelectorAll(selector) ?? []);
  return rows.indexOf(row);
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function buildEffectKeyTokens() {
  return [
    ...getCharacteristicSettings().map(entry => createEffectKeyToken({
      code: entry.abbr || entry.key,
      key: entry.key,
      label: entry.label,
      path: `system.characteristics.${entry.key}`,
      group: "Характеристики"
    })),
    ...getSkillSettings().map(entry => createEffectKeyToken({
      code: entry.abbr || entry.key,
      key: entry.key,
      label: entry.label,
      path: `system.skills.${entry.key}.bonus`,
      group: "Навыки"
    })),
    buildAllSkillsEffectKeyToken(),
    ...getResourceSettings().map(entry => createEffectKeyToken({
      code: entry.abbr || entry.key,
      key: entry.key,
      label: entry.label,
      path: `system.resources.${entry.key}.bonus`,
      group: "Ресурсы"
    })),
    ...getNeedSettings().map(entry => createEffectKeyToken({
      code: entry.abbr || entry.key,
      key: entry.key,
      label: entry.label,
      path: `system.needs.${entry.key}.bonus`,
      group: "Потребности"
    })),
    ...getProficiencySettings().map(entry => createEffectKeyToken({
      code: entry.abbr || entry.key,
      key: entry.key,
      label: entry.label,
      path: `system.proficiencies.${entry.key}.bonus`,
      group: "Владения"
    })),
    ...buildDamageMitigationEffectKeyTokens(),
    ...buildActionCostEffectKeyTokens(),
    ...buildCombatEffectKeyTokens()
  ].filter(Boolean);
}
