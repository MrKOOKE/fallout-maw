import { TEMPLATES } from "../constants.mjs";
import { IDENTIFIER_PATTERN } from "../formulas/index.mjs";
import {
  getProficiencySettings,
  resetProficiencySettings,
  setProficiencySettings
} from "../settings/accessors.mjs";
import { format, localize } from "../utils/i18n.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { FalloutMaWFormApplicationV2 } from "./base-form-application-v2.mjs";
import { activateSettingsReorder } from "./settings-reorder.mjs";

export class ProficiencySettingsConfig extends FalloutMaWFormApplicationV2 {
  constructor(options = {}) {
    super(options);
    this.proficiencies = getProficiencySettings();
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-proficiency-settings",
    classes: ["fallout-maw", "fallout-maw-config-form", "proficiency-settings-config"],
    position: {
      width: 820,
      height: "auto"
    },
    window: {
      resizable: true
    },
    actions: {
      createProficiency: this.#onCreateProficiency,
      deleteProficiency: this.#onDeleteProficiency,
      resetDefaults: this.#onResetDefaults
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.settings.proficiencies
    }
  };

  get title() {
    return localize("FALLOUTMAW.Settings.Proficiencies.Title");
  }

  async _prepareContext(options) {
    return {
      ...(await super._prepareContext(options)),
      proficiencies: this.proficiencies
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    activateSettingsReorder(this.element, "[data-proficiency-row]");
  }

  async _processFormData(_event, _form, _formData) {
    const proficiencies = this.#readProficienciesFromForm();
    this.#validateProficiencies(proficiencies);

    await setProficiencySettings(proficiencies);
    this.proficiencies = getProficiencySettings();
    ui.notifications.info(localize("FALLOUTMAW.Messages.ProficienciesSaved"));
    return this.forceRender();
  }

  static #onCreateProficiency(event) {
    event.preventDefault();
    this.proficiencies = this.#readProficienciesFromForm();
    this.proficiencies.push({
      key: this.#getUniqueKey("newProficiency"),
      abbr: this.#getUniqueAbbr("new"),
      label: "Новое владение",
      max: 1000
    });
    return this.forceRender();
  }

  static #onDeleteProficiency(event, target) {
    event.preventDefault();
    const rows = Array.from(this.form?.querySelectorAll("[data-proficiency-row]") ?? []);
    const index = rows.indexOf(target.closest("[data-proficiency-row]"));
    if (index < 0) return undefined;

    this.proficiencies = this.#readProficienciesFromForm();
    this.proficiencies.splice(index, 1);
    return this.forceRender();
  }

  static async #onResetDefaults(event) {
    event.preventDefault();
    await resetProficiencySettings();
    this.proficiencies = getProficiencySettings();
    return this.forceRender();
  }

  #readProficienciesFromForm() {
    const rows = Array.from(this.form?.querySelectorAll("[data-proficiency-row]") ?? []);
    return rows.map(row => ({
      key: row.querySelector("[data-field='key']")?.value?.trim() ?? "",
      abbr: row.querySelector("[data-field='abbr']")?.value?.trim() ?? "",
      label: row.querySelector("[data-field='label']")?.value?.trim() ?? "",
      max: Math.max(0, toInteger(row.querySelector("[data-field='max']")?.value))
    }));
  }

  #validateProficiencies(proficiencies) {
    const keys = new Set();
    const abbreviations = new Set();

    for (const [index, proficiency] of proficiencies.entries()) {
      const key = String(proficiency.key ?? "").trim();
      const abbr = String(proficiency.abbr ?? "").trim();

      if (!IDENTIFIER_PATTERN.test(key)) throwValidationError(format("FALLOUTMAW.Validation.ProficiencyKeyInvalid", { index: index + 1 }));
      if (keys.has(key)) throwValidationError(format("FALLOUTMAW.Validation.ProficiencyKeyDuplicate", { key }));

      if (!IDENTIFIER_PATTERN.test(abbr)) throwValidationError(format("FALLOUTMAW.Validation.ProficiencyAbbrInvalid", { index: index + 1 }));
      if (abbreviations.has(abbr)) throwValidationError(format("FALLOUTMAW.Validation.ProficiencyAbbrDuplicate", { abbr }));

      keys.add(key);
      abbreviations.add(abbr);
    }
  }

  #getUniqueKey(baseKey) {
    const keys = new Set(this.proficiencies.map(proficiency => proficiency.key));
    if (!keys.has(baseKey)) return baseKey;

    let index = 2;
    while (keys.has(`${baseKey}${index}`)) index += 1;
    return `${baseKey}${index}`;
  }

  #getUniqueAbbr(baseAbbr) {
    const abbreviations = new Set(this.proficiencies.map(proficiency => proficiency.abbr));
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
