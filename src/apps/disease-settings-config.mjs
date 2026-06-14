import { TEMPLATES } from "../constants.mjs";
import {
  getCharacteristicSettings,
  getDamageTypeSettings,
  getDiseaseSettings,
  getNeedSettings,
  getProficiencySettings,
  getResourceSettings,
  getSkillSettings,
  resetDiseaseSettings,
  setDiseaseSettings
} from "../settings/accessors.mjs";
import { buildActionCostEffectKeyTokens, buildAllSkillsEffectKeyToken, buildCombatEffectKeyTokens, buildDamageMitigationEffectKeyTokens } from "../utils/effect-key-tokens.mjs";
import { FalloutMaWFormApplicationV2, getExpandedFormData } from "./base-form-application-v2.mjs";
import { activateEffectKeyAutocomplete, createEffectKeyToken } from "./effect-key-autocomplete.mjs";

const { FormDataExtended } = foundry.applications.ux;

export class DiseaseSettingsConfig extends FalloutMaWFormApplicationV2 {
  #expandedDiseaseIds = new Set();

  constructor(options = {}) {
    super(options);
    this.settings = getDiseaseSettings();
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-disease-settings",
    classes: ["fallout-maw", "fallout-maw-config-form", "disease-settings-config"],
    position: {
      width: 980,
      height: 820
    },
    window: {
      resizable: true
    },
    actions: {
      addDisease: this.#onAddDisease,
      deleteDisease: this.#onDeleteDisease,
      toggleDisease: this.#onToggleDisease,
      addDiseaseStage: this.#onAddDiseaseStage,
      deleteDiseaseStage: this.#onDeleteDiseaseStage,
      addDiseaseStageEffect: this.#onAddDiseaseStageEffect,
      deleteDiseaseStageEffect: this.#onDeleteDiseaseStageEffect,
      resetDefaults: this.#onResetDefaults
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.settings.diseases
    }
  };

  get title() {
    return "Настройка болезней";
  }

  async _prepareContext(options) {
    return {
      ...(await super._prepareContext(options)),
      settings: prepareDiseaseSettings(this.settings, this.#expandedDiseaseIds)
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    activateEffectKeyAutocomplete(this.element, buildEffectKeyTokens());
  }

  async _processFormData(_event, _form, formData) {
    const data = getExpandedFormData(formData);
    this.settings = await setDiseaseSettings(normalizeDiseaseSettingsFromForm(data.settings ?? {}));
    ui.notifications.info("Настройка болезней сохранена.");
    return this.forceRender();
  }

  static #onAddDisease(event) {
    event.preventDefault();
    this.#syncFromForm();
    const id = foundry.utils.randomID();
    this.settings.diseases.push({
      id,
      name: "Новая болезнь",
      img: "",
      stages: [createDiseaseStage(1)]
    });
    this.#expandedDiseaseIds.add(id);
    return this.forceRender();
  }

  static #onDeleteDisease(event, target) {
    event.preventDefault();
    const diseaseId = getDiseaseId(target);
    this.#syncFromForm();
    const index = getRowIndex(this.form, target, "[data-disease-row]");
    if (index >= 0) this.settings.diseases.splice(index, 1);
    if (diseaseId) this.#expandedDiseaseIds.delete(diseaseId);
    return this.forceRender();
  }

  static #onToggleDisease(event, target) {
    event.preventDefault();
    const diseaseId = getDiseaseId(target);
    if (!diseaseId) return undefined;
    this.#syncFromForm();
    if (this.#expandedDiseaseIds.has(diseaseId)) this.#expandedDiseaseIds.delete(diseaseId);
    else this.#expandedDiseaseIds.add(diseaseId);
    return this.forceRender();
  }

  static #onAddDiseaseStage(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const diseaseIndex = getRowIndex(this.form, target, "[data-disease-row]");
    const stages = this.settings.diseases[diseaseIndex]?.stages;
    if (stages) stages.push(createDiseaseStage((stages.at(-1)?.level ?? 0) + 1));
    return this.forceRender();
  }

  static #onDeleteDiseaseStage(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const diseaseElement = target.closest("[data-disease-row]");
    const diseaseIndex = getRowIndex(this.form, target, "[data-disease-row]");
    const stageIndex = getScopedRowIndex(diseaseElement, target, "[data-disease-stage-row]");
    if (diseaseIndex >= 0 && stageIndex >= 0) this.settings.diseases[diseaseIndex]?.stages.splice(stageIndex, 1);
    return this.forceRender();
  }

  static #onAddDiseaseStageEffect(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const diseaseElement = target.closest("[data-disease-row]");
    const diseaseIndex = getRowIndex(this.form, target, "[data-disease-row]");
    const stageIndex = getScopedRowIndex(diseaseElement, target, "[data-disease-stage-row]");
    this.settings.diseases[diseaseIndex]?.stages[stageIndex]?.effects.push({ key: "", type: "add", value: "0", phase: "initial", priority: null });
    return this.forceRender();
  }

  static #onDeleteDiseaseStageEffect(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const diseaseElement = target.closest("[data-disease-row]");
    const stageElement = target.closest("[data-disease-stage-row]");
    const diseaseIndex = getRowIndex(this.form, target, "[data-disease-row]");
    const stageIndex = getScopedRowIndex(diseaseElement, target, "[data-disease-stage-row]");
    const effectIndex = getScopedRowIndex(stageElement, target, "[data-disease-effect-row]");
    if (diseaseIndex >= 0 && stageIndex >= 0 && effectIndex >= 0) this.settings.diseases[diseaseIndex]?.stages[stageIndex]?.effects.splice(effectIndex, 1);
    return this.forceRender();
  }

  static async #onResetDefaults(event) {
    event.preventDefault();
    this.settings = await resetDiseaseSettings();
    this.#expandedDiseaseIds.clear();
    return this.forceRender();
  }

  #syncFromForm() {
    if (!this.form) return;
    this.settings = normalizeDiseaseSettingsFromForm(getExpandedFormData(new FormDataExtended(this.form)).settings ?? {});
  }
}

function createDiseaseStage(level) {
  return {
    id: foundry.utils.randomID(),
    level,
    name: "",
    img: "",
    worseningHours: 24,
    healingDifficulty: 60,
    healingToolClass: "D",
    healingProgress: 100,
    healingSkillKey: "doctor",
    effects: []
  };
}

function normalizeDiseaseSettingsFromForm(settings = {}) {
  return {
    diseases: normalizeIndexedCollection(settings.diseases).map((entry, index) => ({
      id: String(entry?.id ?? `disease-${index + 1}`),
      name: String(entry?.name ?? "").trim() || `Болезнь ${index + 1}`,
      img: String(entry?.img ?? "").trim(),
      stages: normalizeIndexedCollection(entry?.stages).map((stage, stageIndex) => ({
        id: String(stage?.id ?? `stage-${stageIndex + 1}`),
        level: Math.max(0, Math.trunc(Number(stage?.level) || 0)),
        name: String(stage?.name ?? "").trim(),
        img: String(stage?.img ?? "").trim(),
        worseningHours: Math.max(1, Math.trunc(Number(stage?.worseningHours) || 24)),
        healingDifficulty: Math.max(0, Math.trunc(Number(stage?.healingDifficulty) || 60)),
        healingToolClass: normalizeToolClass(stage?.healingToolClass),
        healingProgress: Math.max(1, Math.trunc(Number(stage?.healingProgress ?? stage?.healingProgressMax) || 100)),
        healingSkillKey: String(stage?.healingSkillKey ?? "doctor").trim() || "doctor",
        effects: normalizeEffects(stage?.effects)
      })).filter(stage => stage.level > 0)
    })).filter(disease => disease.stages.length)
  };
}

function prepareDiseaseSettings(settings = {}, expandedDiseaseIds = new Set()) {
  const skillSettings = getSkillSettings();
  return {
    diseases: (settings.diseases ?? []).map(disease => ({
      ...disease,
      collapse: getDiseaseCollapseState(disease.id, expandedDiseaseIds),
      stages: (disease.stages ?? []).map(stage => ({
        ...stage,
        healingToolClassChoices: buildHealingToolClassChoices(stage.healingToolClass),
        healingSkillChoices: buildHealingSkillChoices(stage.healingSkillKey, skillSettings),
        effects: (stage.effects ?? []).map(prepareEffectRow)
      }))
    }))
  };
}

function getDiseaseCollapseState(id, expandedDiseaseIds) {
  const expanded = expandedDiseaseIds.has(String(id ?? ""));
  return {
    cssClass: expanded ? "" : "collapsed",
    ariaExpanded: String(expanded),
    iconClass: expanded ? "fa-chevron-down" : "fa-chevron-right"
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

function getDiseaseId(target) {
  return String(target.closest("[data-disease-row]")?.dataset.diseaseId ?? "");
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

function buildEffectKeyTokens() {
  return [
    ...getCharacteristicSettings().map(entry => createEffectKeyToken({ code: entry.abbr || entry.key, key: entry.key, label: entry.label, path: `system.characteristics.${entry.key}`, group: "Характеристики" })),
    ...getSkillSettings().map(entry => createEffectKeyToken({ code: entry.abbr || entry.key, key: entry.key, label: entry.label, path: `system.skills.${entry.key}.bonus`, group: "Навыки" })),
    buildAllSkillsEffectKeyToken(),
    ...getResourceSettings().map(entry => createEffectKeyToken({ code: entry.abbr || entry.key, key: entry.key, label: entry.label, path: `system.resources.${entry.key}.bonus`, group: "Ресурсы" })),
    ...getNeedSettings().map(entry => createEffectKeyToken({ code: entry.abbr || entry.key, key: entry.key, label: entry.label, path: `system.needs.${entry.key}.bonus`, group: "Потребности" })),
    ...getProficiencySettings().map(entry => createEffectKeyToken({ code: entry.abbr || entry.key, key: entry.key, label: entry.label, path: `system.proficiencies.${entry.key}`, group: "Владения" })),
    ...buildDamageMitigationEffectKeyTokens(),
    ...buildActionCostEffectKeyTokens(),
    ...buildCombatEffectKeyTokens()
  ].filter(Boolean);
}
