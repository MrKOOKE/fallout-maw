import { BLEEDING_DAMAGE_TYPE_KEY, TEMPLATES } from "../constants.mjs";
import { IDENTIFIER_PATTERN } from "../formulas/index.mjs";
import {
  getDamageTypeSettings,
  getNeedSettings,
  getResourceSettings,
  resetDamageTypeSettings,
  setDamageTypeSettings
} from "../settings/accessors.mjs";
import { format, localize } from "../utils/i18n.mjs";
import { FalloutMaWFormApplicationV2, getExpandedFormData } from "./base-form-application-v2.mjs";
import { activateSettingsReorder } from "./settings-reorder.mjs";

const { FormDataExtended } = foundry.applications.ux;

export class DamageTypesConfig extends FalloutMaWFormApplicationV2 {
  constructor(options = {}) {
    super(options);
    this.damageTypes = getDamageTypeSettings();
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-damage-types",
    classes: ["fallout-maw", "fallout-maw-config-form", "damage-types-config"],
    position: {
      width: 900,
      height: "auto"
    },
    window: {
      resizable: true
    },
    actions: {
      createDamageType: this.#onCreateDamageType,
      deleteDamageType: this.#onDeleteDamageType,
      browseDamageTypeImage: this.#onBrowseDamageTypeImage,
      resetDefaults: this.#onResetDefaults,
      openDamageTypeSettings: this.#onOpenDamageTypeSettings
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
      damageTypes: this.damageTypes.map(damageType => ({
        ...damageType,
        hasImage: Boolean(damageType.img),
        locked: isLockedDamageType(damageType)
      }))
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
    this.damageTypes.push({ key: this.#getUniqueKey("newDamageType"), label: "Новый тип урона", color: "#f0d48a", img: "icons/svg/d20-grey.svg" });
    return this.forceRender();
  }

  static #onDeleteDamageType(event, target) {
    event.preventDefault();
    const rows = Array.from(this.form?.querySelectorAll("[data-damage-type-row]") ?? []);
    const index = rows.indexOf(target.closest("[data-damage-type-row]"));
    if (index < 0) return undefined;

    this.damageTypes = this.#readDamageTypesFromForm();
    if (isLockedDamageType(this.damageTypes[index])) return undefined;
    this.damageTypes.splice(index, 1);
    return this.forceRender();
  }

  static async #onBrowseDamageTypeImage(event, target) {
    event.preventDefault();
    const rows = Array.from(this.form?.querySelectorAll("[data-damage-type-row]") ?? []);
    const row = target.closest("[data-damage-type-row]");
    const index = rows.indexOf(row);
    if (index < 0) return undefined;

    this.damageTypes = this.#readDamageTypesFromForm();
    if (isLockedDamageType(this.damageTypes[index])) return undefined;
    const current = this.damageTypes[index]?.img ?? "";
    const picker = new foundry.applications.apps.FilePicker.implementation({
      type: "image",
      current,
      callback: path => {
        this.damageTypes[index].img = path;
        this.forceRender();
      }
    });

    await picker.browse(undefined, { render: false });
    return picker.render({ force: true });
  }

  static async #onResetDefaults(event) {
    event.preventDefault();
    await resetDamageTypeSettings();
    this.damageTypes = getDamageTypeSettings();
    return this.forceRender();
  }

  static #onOpenDamageTypeSettings(event, target) {
    event.preventDefault();
    this.damageTypes = this.#readDamageTypesFromForm();
    const rows = Array.from(this.form?.querySelectorAll("[data-damage-type-row]") ?? []);
    const index = rows.indexOf(target.closest("[data-damage-type-row]"));
    const damageType = this.damageTypes[index];
    if (!damageType) return undefined;
    if (isLockedDamageType(damageType)) return undefined;

    return new DamageTypeSettingsConfig({
      damageType,
      onSave: settings => {
        this.damageTypes = this.#readDamageTypesFromForm();
        if (!this.damageTypes[index]) return;
        this.damageTypes[index].settings = settings;
        this.forceRender();
      }
    }).render({ force: true });
  }

  #readDamageTypesFromForm() {
    const rows = Array.from(this.form?.querySelectorAll("[data-damage-type-row]") ?? []);
    return rows.map((row, index) => {
      const key = row.querySelector("[data-field='key']")?.value?.trim() ?? "";
      const existing = this.damageTypes.find(damageType => damageType.key === key)?.settings
        ?? this.damageTypes[index]?.settings
        ?? {};
      const current = this.damageTypes[index] ?? {};
      if (isLockedDamageType(current)) {
        return {
          key: current.key,
          label: current.label,
          color: current.color,
          img: current.img,
          locked: true,
          system: true,
          settings: foundry.utils.deepClone(existing)
        };
      }
      return {
        key,
        label: row.querySelector("[data-field='label']")?.value?.trim() ?? "",
        color: row.querySelector("[data-field='color']")?.value?.trim() ?? "#f0d48a",
        img: row.querySelector("[data-field='img']")?.value?.trim() ?? "icons/svg/d20-grey.svg",
        settings: foundry.utils.deepClone(existing)
      };
    });
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

class DamageTypeSettingsConfig extends FalloutMaWFormApplicationV2 {
  constructor({ damageType = {}, onSave = null } = {}) {
    super();
    this.damageType = foundry.utils.deepClone(damageType);
    this.damageType.settings = normalizeSettingsFromForm(this.damageType.settings ?? {});
    this.onSave = onSave;
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-damage-type-settings",
    classes: ["fallout-maw", "fallout-maw-config-form", "damage-type-settings-config"],
    position: {
      width: 620,
      height: "auto"
    },
    window: {
      resizable: true
    },
    actions: {
      addResourceLimit: this.#onAddResourceLimit,
      deleteResourceLimit: this.#onDeleteResourceLimit
    },
    form: {
      handler: FalloutMaWFormApplicationV2.handleFormSubmit,
      submitOnChange: false,
      closeOnSubmit: true
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.settings.damageTypeSettings
    }
  };

  get title() {
    return `Доп. настройки урона: ${this.damageType.label || this.damageType.key}`;
  }

  async _prepareContext(options) {
    return {
      ...(await super._prepareContext(options)),
      damageType: this.damageType,
      settings: this.damageType.settings ?? {},
      needOptions: prepareNeedOptions(this.damageType.settings?.needIncrease?.needKey ?? ""),
      resourceLimitRows: prepareResourceLimitRows(this.damageType.settings?.resourceLimit?.resources ?? [])
    };
  }

  async _processFormData(_event, _form, formData) {
    const data = getExpandedFormData(formData);
    this.onSave?.(normalizeSettingsFromForm(data.settings ?? {}));
  }

  static #onAddResourceLimit(event) {
    event.preventDefault();
    this.damageType.settings = normalizeSettingsFromCurrentForm(this.form, this.damageType.settings);
    this.damageType.settings.resourceLimit.resources.push({
      resourceKey: getDefaultResourceKey(),
      percent: 100
    });
    return this.forceRender();
  }

  static #onDeleteResourceLimit(event, target) {
    event.preventDefault();
    const rows = Array.from(this.form?.querySelectorAll("[data-resource-limit-row]") ?? []);
    const index = rows.indexOf(target.closest("[data-resource-limit-row]"));
    if (index < 0) return undefined;

    this.damageType.settings = normalizeSettingsFromCurrentForm(this.form, this.damageType.settings);
    this.damageType.settings.resourceLimit.resources.splice(index, 1);
    return this.forceRender();
  }
}

function toInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function toDecimal(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeSettingsFromForm(settings = {}) {
  const resourceLimit = settings.resourceLimit ?? settings.resourceBlock ?? {};
  return {
    periodic: {
      enabled: toBoolean(settings.periodic?.enabled, false),
      effectName: String(settings.periodic?.effectName ?? "").trim(),
      img: String(settings.periodic?.img ?? "").trim(),
      immediatePercent: toDecimal(settings.periodic?.immediatePercent, 100),
      delayedPercent: toDecimal(settings.periodic?.delayedPercent, 0),
      tickCount: toInteger(settings.periodic?.tickCount),
      intervalSeconds: toInteger(settings.periodic?.intervalSeconds || 6)
    },
    bleeding: {
      enabled: toBoolean(settings.bleeding?.enabled, false),
      effectName: String(settings.bleeding?.effectName ?? "Кровотечение").trim(),
      img: String(settings.bleeding?.img ?? "icons/skills/wounds/blood-drip-droplet-red.webp").trim(),
      percent: Math.max(0, Math.min(100, toDecimal(settings.bleeding?.percent, 0))),
      durationSeconds: Math.max(1, toInteger(settings.bleeding?.durationSeconds || 24))
    },
    needIncrease: {
      enabled: toBoolean(settings.needIncrease?.enabled, false),
      needKey: String(settings.needIncrease?.needKey ?? "").trim(),
      percent: Math.max(0, toDecimal(settings.needIncrease?.percent, 100)),
      preventHealthDamage: toBoolean(settings.needIncrease?.preventHealthDamage, false)
    },
    resourceLimit: {
      enabled: toBoolean(resourceLimit.enabled, false),
      effectName: String(resourceLimit.effectName ?? "").trim(),
      img: String(resourceLimit.img ?? "").trim(),
      color: String(resourceLimit.color ?? "#3f8cff").trim() || "#3f8cff",
      durationSeconds: toInteger(resourceLimit.durationSeconds || 12),
      resources: normalizeResourceLimitRows(resourceLimit.resources)
    },
    equipmentConditionDamage: {
      enabled: toBoolean(settings.equipmentConditionDamage?.enabled, true),
      formula: String(settings.equipmentConditionDamage?.formula ?? "protected + unconditional").trim()
        || "protected + unconditional"
    }
  };
}

function normalizeSettingsFromCurrentForm(form, fallback = {}) {
  if (!form) return normalizeSettingsFromForm(fallback);
  return normalizeSettingsFromForm(getExpandedFormData(new FormDataExtended(form)).settings ?? {});
}

function normalizeResourceLimitRows(resources) {
  const entries = Array.isArray(resources)
    ? resources
    : Object.keys(resources ?? {})
      .sort((left, right) => Number(left) - Number(right))
      .map(key => resources[key]);
  return entries
    .map(entry => ({
      resourceKey: String(entry?.resourceKey ?? "").trim(),
      percent: Math.max(0, toDecimal(entry?.percent, 100))
    }))
    .filter(entry => entry.resourceKey);
}

function prepareResourceLimitRows(resources = []) {
  const resourceSettings = getResourceSettings();
  return resources.map(entry => ({
    ...entry,
    options: resourceSettings.map(resource => ({
      ...resource,
      selected: resource.key === entry.resourceKey
    }))
  }));
}

function prepareNeedOptions(selectedKey = "") {
  return getNeedSettings().map(need => ({
    ...need,
    selected: need.key === selectedKey
  }));
}

function getDefaultResourceKey() {
  return getResourceSettings()[0]?.key ?? "";
}

function toBoolean(value, fallback = false) {
  if (value === true || value === "true" || value === "on" || value === "1") return true;
  if (value === false || value === "false" || value === "0" || value === "") return false;
  return fallback;
}

function isLockedDamageType(damageType = {}) {
  return Boolean(damageType?.locked || damageType?.system || damageType?.key === BLEEDING_DAMAGE_TYPE_KEY);
}

function throwValidationError(message) {
  ui.notifications.error(message);
  throw new Error(message);
}
