import { TEMPLATES } from "../constants.mjs";
import { IDENTIFIER_PATTERN } from "../formulas/index.mjs";
import { getCharacteristicSettings, resetCharacteristicSettings, setCharacteristicSettings } from "../settings/accessors.mjs";
import { format, localize } from "../utils/i18n.mjs";
import { FalloutMaWFormApplicationV2 } from "./base-form-application-v2.mjs";
import { activateSettingsReorder } from "./settings-reorder.mjs";

export class CharacteristicsConfig extends FalloutMaWFormApplicationV2 {
  constructor(options = {}) {
    super(options);
    this.characteristics = getCharacteristicSettings();
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-characteristics",
    classes: ["fallout-maw", "fallout-maw-config-form", "characteristics-config"],
    position: {
      width: 720,
      height: "auto"
    },
    window: {
      resizable: true
    },
    actions: {
      createCharacteristic: this.#onCreateCharacteristic,
      deleteCharacteristic: this.#onDeleteCharacteristic,
      resetDefaults: this.#onResetDefaults
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.settings.characteristics
    }
  };

  get title() {
    return localize("FALLOUTMAW.Settings.Characteristics.Title");
  }

  async _prepareContext(options) {
    return {
      ...(await super._prepareContext(options)),
      characteristics: this.characteristics
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    activateSettingsReorder(this.element, "[data-characteristic-row]");
  }

  async _processFormData(_event, _form, _formData) {
    const characteristics = this.#readCharacteristicsFromForm();
    this.#validateCharacteristics(characteristics);
    await setCharacteristicSettings(characteristics);
    this.characteristics = getCharacteristicSettings();
    ui.notifications.info(localize("FALLOUTMAW.Messages.CharacteristicsSaved"));
    return this.forceRender();
  }

  static #onCreateCharacteristic(event) {
    event.preventDefault();
    this.characteristics = this.#readCharacteristicsFromForm();
    this.characteristics.push({
      key: this.#getUniqueKey("newCharacteristic"),
      abbr: this.#getUniqueAbbr("new"),
      label: "Новая характеристика"
    });
    return this.forceRender();
  }

  static #onDeleteCharacteristic(event, target) {
    event.preventDefault();
    const rows = Array.from(this.form?.querySelectorAll("[data-characteristic-row]") ?? []);
    const index = rows.indexOf(target.closest("[data-characteristic-row]"));
    if (index < 0) return undefined;

    this.characteristics = this.#readCharacteristicsFromForm();
    this.characteristics.splice(index, 1);
    return this.forceRender();
  }

  static async #onResetDefaults(event) {
    event.preventDefault();
    await resetCharacteristicSettings();
    this.characteristics = getCharacteristicSettings();
    return this.forceRender();
  }

  #readCharacteristicsFromForm() {
    const rows = Array.from(this.form?.querySelectorAll("[data-characteristic-row]") ?? []);
    return rows.map(row => ({
      key: row.querySelector("[data-field='key']")?.value?.trim() ?? "",
      abbr: row.querySelector("[data-field='abbr']")?.value?.trim() ?? "",
      label: row.querySelector("[data-field='label']")?.value?.trim() ?? ""
    }));
  }

  #validateCharacteristics(characteristics) {
    const keys = new Set();
    const abbreviations = new Set();

    for (const [index, characteristic] of characteristics.entries()) {
      const key = String(characteristic.key ?? "").trim();
      const abbr = String(characteristic.abbr ?? "").trim();

      if (!IDENTIFIER_PATTERN.test(key)) {
        throwValidationError(format("FALLOUTMAW.Validation.CharacteristicKeyInvalid", { index: index + 1 }));
      }
      if (keys.has(key)) throwValidationError(format("FALLOUTMAW.Validation.CharacteristicKeyDuplicate", { key }));

      if (!IDENTIFIER_PATTERN.test(abbr)) {
        throwValidationError(format("FALLOUTMAW.Validation.CharacteristicAbbrInvalid", { index: index + 1 }));
      }
      if (abbreviations.has(abbr)) {
        throwValidationError(format("FALLOUTMAW.Validation.CharacteristicAbbrDuplicate", { abbr }));
      }

      keys.add(key);
      abbreviations.add(abbr);
    }
  }

  #getUniqueKey(baseKey) {
    const keys = new Set(this.characteristics.map(characteristic => characteristic.key));
    if (!keys.has(baseKey)) return baseKey;

    let index = 2;
    while (keys.has(`${baseKey}${index}`)) index += 1;
    return `${baseKey}${index}`;
  }

  #getUniqueAbbr(baseAbbr) {
    const abbreviations = new Set(this.characteristics.map(characteristic => characteristic.abbr));
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
