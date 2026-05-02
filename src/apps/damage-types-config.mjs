import { TEMPLATES } from "../constants.mjs";
import { IDENTIFIER_PATTERN } from "../formulas/index.mjs";
import { getDamageTypeSettings, resetDamageTypeSettings, setDamageTypeSettings } from "../settings/accessors.mjs";
import { format, localize } from "../utils/i18n.mjs";
import { FalloutMaWFormApplicationV2 } from "./base-form-application-v2.mjs";
import { activateSettingsReorder } from "./settings-reorder.mjs";

export class DamageTypesConfig extends FalloutMaWFormApplicationV2 {
  constructor(options = {}) {
    super(options);
    this.damageTypes = getDamageTypeSettings();
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-damage-types",
    classes: ["fallout-maw", "fallout-maw-config-form", "damage-types-config"],
    position: {
      width: 720,
      height: "auto"
    },
    window: {
      resizable: true
    },
    actions: {
      createDamageType: this.#onCreateDamageType,
      deleteDamageType: this.#onDeleteDamageType,
      resetDefaults: this.#onResetDefaults
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.settings.damageTypes
    }
  };

  get title() {
    return localize("FALLOUTMAW.Settings.DamageTypes.Title");
  }

  async _prepareContext(options) {
    return {
      ...(await super._prepareContext(options)),
      damageTypes: this.damageTypes
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    activateSettingsReorder(this.element, "[data-damage-type-row]");
  }

  async _processFormData(_event, _form, _formData) {
    const damageTypes = this.#readDamageTypesFromForm();
    this.#validateDamageTypes(damageTypes);
    await setDamageTypeSettings(damageTypes);
    this.damageTypes = getDamageTypeSettings();
    ui.notifications.info(localize("FALLOUTMAW.Messages.DamageTypesSaved"));
    return this.forceRender();
  }

  static #onCreateDamageType(event) {
    event.preventDefault();
    this.damageTypes = this.#readDamageTypesFromForm();
    this.damageTypes.push({ key: this.#getUniqueKey("newDamageType"), label: "Новый тип урона" });
    return this.forceRender();
  }

  static #onDeleteDamageType(event, target) {
    event.preventDefault();
    const rows = Array.from(this.form?.querySelectorAll("[data-damage-type-row]") ?? []);
    const index = rows.indexOf(target.closest("[data-damage-type-row]"));
    if (index < 0) return undefined;

    this.damageTypes = this.#readDamageTypesFromForm();
    this.damageTypes.splice(index, 1);
    return this.forceRender();
  }

  static async #onResetDefaults(event) {
    event.preventDefault();
    await resetDamageTypeSettings();
    this.damageTypes = getDamageTypeSettings();
    return this.forceRender();
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
      if (!IDENTIFIER_PATTERN.test(key)) {
        throwValidationError(format("FALLOUTMAW.Validation.DamageTypeKeyInvalid", { index: index + 1 }));
      }
      if (keys.has(key)) throwValidationError(format("FALLOUTMAW.Validation.DamageTypeKeyDuplicate", { key }));
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
