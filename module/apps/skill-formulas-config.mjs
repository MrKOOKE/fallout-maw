import { IDENTIFIER_PATTERN, validateFormula } from "../formulas.mjs";
import { getCharacteristicSettings, getSkillSettings, resetSkillSettings, setSkillSettings } from "../settings.mjs";
import { activateFormulaAutocomplete } from "./formula-autocomplete.mjs";
import { activateSettingsReorder } from "./settings-reorder.mjs";

export class SkillFormulasConfig extends FormApplication {
  constructor(object = {}, options = {}) {
    super(object, options);
    this.skills = getSkillSettings();
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "fallout-maw-skill-settings",
      title: localize("FALLOUTMAW.Settings.Skills.Title"),
      template: "systems/fallout-maw/templates/settings/skill-formulas-config.hbs",
      classes: ["fallout-maw", "skill-settings-config"],
      width: 900,
      height: "auto",
      resizable: true,
      closeOnSubmit: false
    });
  }

  getData(options = {}) {
    return {
      ...super.getData(options),
      skills: this.skills
    };
  }

  activateListeners(html) {
    super.activateListeners(html);
    activateFormulaAutocomplete(html, { characteristics: getCharacteristicSettings() });
    activateSettingsReorder(html, "[data-skill-row]");
    html.find("[data-action='create-skill']").on("click", this.#onCreateSkill.bind(this));
    html.find("[data-action='delete-skill']").on("click", this.#onDeleteSkill.bind(this));
    html.find("[data-action='reset-defaults']").on("click", this.#onResetDefaults.bind(this));
  }

  async _updateObject(_event, formData) {
    const skills = this.#readSkillsFromForm();
    this.#validateSkills(skills);
    await setSkillSettings(skills);
    this.skills = getSkillSettings();
    ui.notifications.info(localize("FALLOUTMAW.Messages.SkillsSaved"));
    this.render(true);
  }

  #onCreateSkill(event) {
    event.preventDefault();
    this.skills = this.#readSkillsFromForm();
    this.skills.push({
      key: this.#getUniqueKey("newSkill"),
      abbr: this.#getUniqueAbbr("new"),
      label: "Новый навык",
      formula: "0"
    });
    this.render(true);
  }

  #onDeleteSkill(event) {
    event.preventDefault();
    const rows = Array.from(this.form?.querySelectorAll("[data-skill-row]") ?? []);
    const index = rows.indexOf(event.currentTarget.closest("[data-skill-row]"));
    if (index < 0) return;
    this.skills = this.#readSkillsFromForm();
    this.skills.splice(index, 1);
    this.render(true);
  }

  async #onResetDefaults(event) {
    event.preventDefault();
    await resetSkillSettings();
    this.skills = getSkillSettings();
    this.render(true);
  }

  #readSkillsFromForm() {
    const rows = Array.from(this.form?.querySelectorAll("[data-skill-row]") ?? []);
    return rows.map(row => ({
      key: row.querySelector("[data-field='key']")?.value?.trim() ?? "",
      abbr: row.querySelector("[data-field='abbr']")?.value?.trim() ?? "",
      label: row.querySelector("[data-field='label']")?.value?.trim() ?? "",
      formula: row.querySelector("[data-field='formula']")?.value?.trim() ?? "0"
    }));
  }

  #validateSkills(skills) {
    const keys = new Set();
    const abbreviations = new Set();
    const characteristics = getCharacteristicSettings();
    for (const [index, skill] of skills.entries()) {
      const key = String(skill.key ?? "").trim();
      const abbr = String(skill.abbr ?? "").trim();
      if (!IDENTIFIER_PATTERN.test(key)) throwValidationError(format("FALLOUTMAW.Validation.SkillKeyInvalid", { index: index + 1 }));
      if (keys.has(key)) throwValidationError(format("FALLOUTMAW.Validation.SkillKeyDuplicate", { key }));
      if (!IDENTIFIER_PATTERN.test(abbr)) throwValidationError(format("FALLOUTMAW.Validation.SkillAbbrInvalid", { index: index + 1 }));
      if (abbreviations.has(abbr)) throwValidationError(format("FALLOUTMAW.Validation.SkillAbbrDuplicate", { abbr }));
      keys.add(key);
      abbreviations.add(abbr);
      try {
        validateFormula(skill.formula, { characteristics });
      } catch (error) {
        throwValidationError(`${skill.label || key}: ${error.message}`);
      }
    }
  }

  #getUniqueKey(baseKey) {
    const keys = new Set(this.skills.map(skill => skill.key));
    if (!keys.has(baseKey)) return baseKey;
    let index = 2;
    while (keys.has(`${baseKey}${index}`)) index += 1;
    return `${baseKey}${index}`;
  }

  #getUniqueAbbr(baseAbbr) {
    const abbreviations = new Set(this.skills.map(skill => skill.abbr));
    if (!abbreviations.has(baseAbbr)) return baseAbbr;
    let index = 2;
    while (abbreviations.has(`${baseAbbr}${index}`)) index += 1;
    return `${baseAbbr}${index}`;
  }
}

function throwValidationError(message) {
  ui.notifications.error(message);
  throw new Error(message);
}

function localize(key) {
  return game.i18n.localize(key);
}

function format(key, data) {
  return game.i18n.format(key, data);
}
