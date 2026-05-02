import { IDENTIFIER_PATTERN } from "../formulas.mjs";
import { getDamageTypeSettings, resetDamageTypeSettings, setDamageTypeSettings } from "../settings.mjs";
import { activateSettingsReorder } from "./settings-reorder.mjs";

export class DamageTypesConfig extends FormApplication {
  constructor(object = {}, options = {}) {
    super(object, options);
    this.damageTypes = getDamageTypeSettings();
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "fallout-maw-damage-types",
      title: "Настройка типов урона",
      template: "systems/fallout-maw/templates/settings/damage-types-config.hbs",
      classes: ["fallout-maw", "damage-types-config"],
      width: 720,
      height: "auto",
      resizable: true,
      closeOnSubmit: false
    });
  }

  getData(options = {}) {
    return {
      ...super.getData(options),
      damageTypes: this.damageTypes
    };
  }

  activateListeners(html) {
    super.activateListeners(html);
    activateSettingsReorder(html, "[data-damage-type-row]");
    html.find("[data-action='create-damage-type']").on("click", this.#onCreateDamageType.bind(this));
    html.find("[data-action='delete-damage-type']").on("click", this.#onDeleteDamageType.bind(this));
    html.find("[data-action='reset-defaults']").on("click", this.#onResetDefaults.bind(this));
  }

  async _updateObject(_event, formData) {
    const damageTypes = this.#readDamageTypesFromForm();
    this.#validateDamageTypes(damageTypes);
    await setDamageTypeSettings(damageTypes);
    this.damageTypes = getDamageTypeSettings();
    ui.notifications.info("Настройка типов урона сохранена.");
    this.render(true);
  }

  #onCreateDamageType(event) {
    event.preventDefault();
    this.damageTypes = this.#readDamageTypesFromForm();
    this.damageTypes.push({
      key: this.#getUniqueKey("newDamageType"),
      label: "Новый тип урона"
    });
    this.render(true);
  }

  #onDeleteDamageType(event) {
    event.preventDefault();
    const rows = Array.from(this.form?.querySelectorAll("[data-damage-type-row]") ?? []);
    const index = rows.indexOf(event.currentTarget.closest("[data-damage-type-row]"));
    if (index < 0) return;
    this.damageTypes = this.#readDamageTypesFromForm();
    this.damageTypes.splice(index, 1);
    this.render(true);
  }

  async #onResetDefaults(event) {
    event.preventDefault();
    await resetDamageTypeSettings();
    this.damageTypes = getDamageTypeSettings();
    this.render(true);
  }

  #readDamageTypesFromForm() {
    const rows = Array.from(this.form?.querySelectorAll("[data-damage-type-row]") ?? []);
    return rows.map(row => ({
      key: row.querySelector("[data-field='key']")?.value?.trim() ?? "",
      label: row.querySelector("[data-field='label']")?.value?.trim() ?? ""
    }));
  }

  #validateDamageTypes(damageTypes) {
    const keys = new Set();
    for (const [index, damageType] of damageTypes.entries()) {
      const key = String(damageType.key ?? "").trim();
      if (!IDENTIFIER_PATTERN.test(key)) throwValidationError(`Тип урона ${index + 1}: ключ должен быть идентификатором латиницей.`);
      if (keys.has(key)) throwValidationError(`Ключ типа урона "${key}" повторяется.`);
      keys.add(key);
    }
  }

  #getUniqueKey(baseKey) {
    const keys = new Set(this.damageTypes.map(damageType => damageType.key));
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
