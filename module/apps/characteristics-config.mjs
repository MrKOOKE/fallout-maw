import { IDENTIFIER_PATTERN } from "../formulas.mjs";
import { getCharacteristicSettings, resetCharacteristicSettings, setCharacteristicSettings } from "../settings.mjs";
import { activateSettingsReorder } from "./settings-reorder.mjs";

export class CharacteristicsConfig extends FormApplication {
  constructor(object = {}, options = {}) {
    super(object, options);
    this.characteristics = getCharacteristicSettings();
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "fallout-maw-characteristics",
      title: "Настройка характеристик",
      template: "systems/fallout-maw/templates/settings/characteristics-config.hbs",
      classes: ["fallout-maw", "characteristics-config"],
      width: 720,
      height: "auto",
      resizable: true,
      closeOnSubmit: false
    });
  }

  getData(options = {}) {
    return {
      ...super.getData(options),
      characteristics: this.characteristics
    };
  }

  activateListeners(html) {
    super.activateListeners(html);
    activateSettingsReorder(html, "[data-characteristic-row]");
    html.find("[data-action='create-characteristic']").on("click", this.#onCreateCharacteristic.bind(this));
    html.find("[data-action='delete-characteristic']").on("click", this.#onDeleteCharacteristic.bind(this));
    html.find("[data-action='reset-defaults']").on("click", this.#onResetDefaults.bind(this));
  }

  async _updateObject(_event, formData) {
    const characteristics = this.#readCharacteristicsFromForm();
    this.#validateCharacteristics(characteristics);
    await setCharacteristicSettings(characteristics);
    this.characteristics = getCharacteristicSettings();
    ui.notifications.info("Настройки характеристик сохранены.");
    this.render(true);
  }

  #onCreateCharacteristic(event) {
    event.preventDefault();
    this.characteristics = this.#readCharacteristicsFromForm();
    this.characteristics.push({
      key: this.#getUniqueKey("newCharacteristic"),
      abbr: this.#getUniqueAbbr("new"),
      label: "Новая характеристика"
    });
    this.render(true);
  }

  #onDeleteCharacteristic(event) {
    event.preventDefault();
    const rows = Array.from(this.form?.querySelectorAll("[data-characteristic-row]") ?? []);
    const index = rows.indexOf(event.currentTarget.closest("[data-characteristic-row]"));
    if (index < 0) return;
    this.characteristics = this.#readCharacteristicsFromForm();
    this.characteristics.splice(index, 1);
    this.render(true);
  }

  async #onResetDefaults(event) {
    event.preventDefault();
    await resetCharacteristicSettings();
    this.characteristics = getCharacteristicSettings();
    this.render(true);
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
      if (!IDENTIFIER_PATTERN.test(key)) throwValidationError(`Характеристика ${index + 1}: ключ должен быть идентификатором латиницей.`);
      if (keys.has(key)) throwValidationError(`Ключ характеристики "${key}" повторяется.`);
      if (!IDENTIFIER_PATTERN.test(abbr)) throwValidationError(`Характеристика ${index + 1}: код должен быть идентификатором латиницей.`);
      if (abbreviations.has(abbr)) throwValidationError(`Код характеристики "${abbr}" повторяется.`);
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
