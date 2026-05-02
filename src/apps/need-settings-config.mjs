import { TEMPLATES } from "../constants.mjs";
import { IDENTIFIER_PATTERN, validateFormula } from "../formulas/index.mjs";
import {
  getCharacteristicSettings,
  getNeedSettings,
  getSkillSettings,
  resetNeedSettings,
  setNeedSettings
} from "../settings/accessors.mjs";
import { format, localize } from "../utils/i18n.mjs";
import { FalloutMaWFormApplicationV2 } from "./base-form-application-v2.mjs";
import { activateFormulaAutocomplete } from "./formula-autocomplete.mjs";
import { activateSettingsReorder } from "./settings-reorder.mjs";

export class NeedSettingsConfig extends FalloutMaWFormApplicationV2 {
  constructor(options = {}) {
    super(options);
    this.needs = getNeedSettings();
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

    await setNeedSettings(needs);
    this.needs = getNeedSettings();
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
      formula: "0"
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
    await resetNeedSettings();
    this.needs = getNeedSettings();
    return this.forceRender();
  }

  #readNeedsFromForm() {
    const rows = Array.from(this.form?.querySelectorAll("[data-need-row]") ?? []);
    return rows.map(row => ({
      key: row.querySelector("[data-field='key']")?.value?.trim() ?? "",
      abbr: row.querySelector("[data-field='abbr']")?.value?.trim() ?? "",
      label: row.querySelector("[data-field='label']")?.value?.trim() ?? "",
      formula: row.querySelector("[data-field='formula']")?.value?.trim() ?? "0"
    }));
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
