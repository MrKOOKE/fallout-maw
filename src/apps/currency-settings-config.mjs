import { TEMPLATES } from "../constants.mjs";
import { IDENTIFIER_PATTERN } from "../formulas/index.mjs";
import { getCurrencySettings, resetCurrencySettings, setCurrencySettings } from "../settings/accessors.mjs";
import { format, localize } from "../utils/i18n.mjs";
import { FalloutMaWFormApplicationV2 } from "./base-form-application-v2.mjs";
import { activateSettingsReorder } from "./settings-reorder.mjs";

export class CurrencySettingsConfig extends FalloutMaWFormApplicationV2 {
  constructor(options = {}) {
    super(options);
    this.currencies = getCurrencySettings();
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-currency-settings",
    classes: ["fallout-maw", "fallout-maw-config-form", "currency-settings-config"],
    position: {
      width: 980,
      height: "auto"
    },
    window: {
      resizable: true
    },
    actions: {
      browseCurrencyImage: this.#onBrowseCurrencyImage,
      createCurrency: this.#onCreateCurrency,
      deleteCurrency: this.#onDeleteCurrency,
      resetDefaults: this.#onResetDefaults
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.settings.currencies
    }
  };

  get title() {
    return localize("FALLOUTMAW.Settings.Currencies.Title");
  }

  async _prepareContext(options) {
    return {
      ...(await super._prepareContext(options)),
      currencies: this.currencies.map(currency => ({
        ...currency,
        hasImage: Boolean(currency.img)
      }))
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    activateSettingsReorder(this.element, "[data-currency-row]");
  }

  async _processFormData(_event, _form, _formData) {
    const currencies = this.#readCurrenciesFromForm();
    this.#validateCurrencies(currencies);
    await setCurrencySettings(currencies);
    this.currencies = getCurrencySettings();
    ui.notifications.info(localize("FALLOUTMAW.Messages.CurrenciesSaved"));
    return this.forceRender();
  }

  static #onCreateCurrency(event) {
    event.preventDefault();
    this.currencies = this.#readCurrenciesFromForm();
    this.currencies.push({
      key: this.#getUniqueKey("newCurrency"),
      label: "Новая валюта",
      img: "",
      value: 1
    });
    return this.forceRender();
  }

  static #onDeleteCurrency(event, target) {
    event.preventDefault();
    const rows = Array.from(this.form?.querySelectorAll("[data-currency-row]") ?? []);
    const index = rows.indexOf(target.closest("[data-currency-row]"));
    if (index < 0) return undefined;

    this.currencies = this.#readCurrenciesFromForm();
    this.currencies.splice(index, 1);
    return this.forceRender();
  }

  static async #onBrowseCurrencyImage(event, target) {
    event.preventDefault();
    const rows = Array.from(this.form?.querySelectorAll("[data-currency-row]") ?? []);
    const row = target.closest("[data-currency-row]");
    const index = rows.indexOf(row);
    if (index < 0) return undefined;

    this.currencies = this.#readCurrenciesFromForm();
    const current = this.currencies[index]?.img ?? "";
    const picker = new foundry.applications.apps.FilePicker.implementation({
      type: "image",
      current,
      callback: path => {
        this.currencies[index].img = path;
        this.forceRender();
      }
    });

    await picker.browse(undefined, { render: false });
    return picker.render({ force: true });
  }

  static async #onResetDefaults(event) {
    event.preventDefault();
    await resetCurrencySettings();
    this.currencies = getCurrencySettings();
    return this.forceRender();
  }

  #readCurrenciesFromForm() {
    const rows = Array.from(this.form?.querySelectorAll("[data-currency-row]") ?? []);
    return rows.map(row => ({
      key: row.querySelector("[data-field='key']")?.value?.trim() ?? "",
      label: row.querySelector("[data-field='label']")?.value?.trim() ?? "",
      img: row.querySelector("[data-field='img']")?.value?.trim() ?? "",
      value: row.querySelector("[data-field='value']")?.value?.trim() ?? "0"
    }));
  }

  #validateCurrencies(currencies) {
    const keys = new Set();

    for (const [index, currency] of currencies.entries()) {
      const key = String(currency.key ?? "").trim();
      if (!IDENTIFIER_PATTERN.test(key)) {
        throwValidationError(format("FALLOUTMAW.Validation.CurrencyKeyInvalid", { index: index + 1 }));
      }
      if (keys.has(key)) throwValidationError(format("FALLOUTMAW.Validation.CurrencyKeyDuplicate", { key }));

      const value = Number(currency.value);
      if (!Number.isFinite(value) || (value < 0)) {
        throwValidationError(format("FALLOUTMAW.Validation.CurrencyValueInvalid", { index: index + 1 }));
      }

      keys.add(key);
    }
  }

  #getUniqueKey(baseKey) {
    const keys = new Set(this.currencies.map(currency => currency.key));
    if (!keys.has(baseKey)) return baseKey;

    let index = 2;
    while (keys.has(`${baseKey}${index}`)) index += 1;
    return `${baseKey}${index}`;
  }
}

function throwValidationError(message) {
  ui.notifications.error(message);
  throw new Error(message);
}
