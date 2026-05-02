import { TEMPLATES } from "../constants.mjs";
import { IDENTIFIER_PATTERN, validateFormula } from "../formulas/index.mjs";
import {
  getCharacteristicSettings,
  getResourceSettings,
  getSkillSettings,
  resetResourceSettings,
  setResourceSettings
} from "../settings/accessors.mjs";
import { format, localize } from "../utils/i18n.mjs";
import { FalloutMaWFormApplicationV2 } from "./base-form-application-v2.mjs";
import { activateFormulaAutocomplete } from "./formula-autocomplete.mjs";
import { activateSettingsReorder } from "./settings-reorder.mjs";

export class ResourceSettingsConfig extends FalloutMaWFormApplicationV2 {
  constructor(options = {}) {
    super(options);
    this.resources = getResourceSettings();
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-resource-settings",
    classes: ["fallout-maw", "fallout-maw-config-form", "fallout-maw-formula-config", "resource-settings-config"],
    position: {
      width: 900,
      height: "auto"
    },
    window: {
      resizable: true
    },
    actions: {
      createResource: this.#onCreateResource,
      deleteResource: this.#onDeleteResource,
      resetDefaults: this.#onResetDefaults
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.settings.resources
    }
  };

  get title() {
    return localize("FALLOUTMAW.Settings.Resources.Title");
  }

  async _prepareContext(options) {
    return {
      ...(await super._prepareContext(options)),
      resources: this.resources
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    activateFormulaAutocomplete(this.element, {
      characteristics: getCharacteristicSettings(),
      skills: getSkillSettings()
    });
    activateSettingsReorder(this.element, "[data-resource-row]");
  }

  async _processFormData(_event, _form, _formData) {
    const resources = this.#readResourcesFromForm();
    this.#validateResources(resources);

    await setResourceSettings(resources);
    this.resources = getResourceSettings();
    ui.notifications.info(localize("FALLOUTMAW.Messages.ResourcesSaved"));
    return this.forceRender();
  }

  static #onCreateResource(event) {
    event.preventDefault();
    this.resources = this.#readResourcesFromForm();
    this.resources.push({
      key: this.#getUniqueKey("newResource"),
      abbr: this.#getUniqueAbbr("new"),
      label: "Новый ресурс",
      formula: "0"
    });
    return this.forceRender();
  }

  static #onDeleteResource(event, target) {
    event.preventDefault();
    const rows = Array.from(this.form?.querySelectorAll("[data-resource-row]") ?? []);
    const index = rows.indexOf(target.closest("[data-resource-row]"));
    if (index < 0) return undefined;

    this.resources = this.#readResourcesFromForm();
    this.resources.splice(index, 1);
    return this.forceRender();
  }

  static async #onResetDefaults(event) {
    event.preventDefault();
    await resetResourceSettings();
    this.resources = getResourceSettings();
    return this.forceRender();
  }

  #readResourcesFromForm() {
    const rows = Array.from(this.form?.querySelectorAll("[data-resource-row]") ?? []);
    return rows.map(row => ({
      key: row.querySelector("[data-field='key']")?.value?.trim() ?? "",
      abbr: row.querySelector("[data-field='abbr']")?.value?.trim() ?? "",
      label: row.querySelector("[data-field='label']")?.value?.trim() ?? "",
      formula: row.querySelector("[data-field='formula']")?.value?.trim() ?? "0"
    }));
  }

  #validateResources(resources) {
    validateFormulaSettings(resources, "Resource");
  }

  #getUniqueKey(baseKey) {
    const keys = new Set(this.resources.map(resource => resource.key));
    if (!keys.has(baseKey)) return baseKey;

    let index = 2;
    while (keys.has(`${baseKey}${index}`)) index += 1;
    return `${baseKey}${index}`;
  }

  #getUniqueAbbr(baseAbbr) {
    const abbreviations = new Set(this.resources.map(resource => resource.abbr));
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
