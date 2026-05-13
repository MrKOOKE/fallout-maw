import { TEMPLATES } from "../constants.mjs";
import { getSkillSettings, getTokenActionHudIcons, setTokenActionHudIcons } from "../settings/accessors.mjs";
import { FalloutMaWFormApplicationV2 } from "./base-form-application-v2.mjs";

const DAMAGE_ICON_ROWS = Object.freeze([
  { section: "root", key: "damageReductionIcon", label: "Иконка снижения урона" },
  { section: "root", key: "damageBlockedIcon", label: "Иконка полного блокирования урона" },
  { section: "root", key: "emptyWeaponSlotIcon", label: "Иконка пустого слота оружия" }
]);

const MAIN_ACTION_ICON_ROWS = Object.freeze([
  { key: "weapon", label: "Оружие" },
  { key: "items", label: "Предметы" },
  { key: "abilities", label: "Способности" },
  { key: "skills", label: "Испытания" },
  { key: "actions", label: "Действия" },
  { key: "settings", label: "Настройки" }
]);

const WEAPON_ACTION_ICON_ROWS = Object.freeze([
  { key: "aimedShot", labelKey: "FALLOUTMAW.Item.WeaponActionAimedShot" },
  { key: "snapshot", labelKey: "FALLOUTMAW.Item.WeaponActionSnapshot" },
  { key: "burst", labelKey: "FALLOUTMAW.Item.WeaponActionBurst" },
  { key: "volley", labelKey: "FALLOUTMAW.Item.WeaponActionVolley" },
  { key: "meleeAttack", labelKey: "FALLOUTMAW.Item.WeaponActionMeleeAttack" },
  { key: "aimedMeleeAttack", labelKey: "FALLOUTMAW.Item.WeaponActionAimedMeleeAttack" },
  { key: "reload", labelKey: "FALLOUTMAW.Item.WeaponActionReload" }
]);

export class TokenActionHudSettings extends FalloutMaWFormApplicationV2 {
  constructor(options = {}) {
    super(options);
    this.icons = getTokenActionHudIcons();
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-token-action-hud-settings",
    classes: ["fallout-maw", "fallout-maw-config-form", "fallout-maw-token-action-hud-settings"],
    position: {
      width: 760,
      height: "auto"
    },
    window: {
      resizable: true
    },
    form: {
      handler: TokenActionHudSettings.handleFormSubmit,
      submitOnChange: false,
      closeOnSubmit: true
    },
    actions: {
      browseHudImage: this.#onBrowseHudImage
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.settings.tokenActionHud
    }
  };

  get title() {
    return game.i18n.localize("FALLOUTMAW.Settings.HUD.Title");
  }

  async _prepareContext(options) {
    return {
      ...(await super._prepareContext(options)),
      damageIconRows: this.#prepareRootIconRows(),
      mainActionIconRows: this.#prepareIconRows("mainActions", MAIN_ACTION_ICON_ROWS),
      weaponActionIconRows: this.#prepareIconRows("weaponActions", WEAPON_ACTION_ICON_ROWS.map(row => ({
        ...row,
        label: game.i18n.localize(row.labelKey)
      }))),
      skillIconRows: this.#prepareIconRows("skillIcons", getSkillSettings().map(skill => ({
        key: skill.key,
        label: skill.label
      })))
    };
  }

  async _processFormData(_event, _form, _formData) {
    this.icons = this.#readIconsFromForm();
    await setTokenActionHudIcons(this.icons);
  }

  static async #onBrowseHudImage(event, target) {
    event.preventDefault();
    const row = target.closest("[data-hud-icon-section][data-hud-icon-key]");
    if (!row) return undefined;
    return this.#browseImagePath(row.dataset.hudIconSection, row.dataset.hudIconKey);
  }

  async #browseImagePath(section, key) {
    this.icons = this.#readIconsFromForm();
    const current = this.#getIconValue(section, key);
    const picker = new foundry.applications.apps.FilePicker.implementation({
      type: "image",
      current,
      callback: path => {
        this.#setIconValue(section, key, path);
        this.forceRender();
      }
    });

    await picker.browse(undefined, { render: false });
    return picker.render({ force: true });
  }

  #readIconsFromForm() {
    const icons = foundry.utils.deepClone(this.icons);
    for (const input of this.form?.querySelectorAll("[data-hud-icon-input]") ?? []) {
      const row = input.closest("[data-hud-icon-section][data-hud-icon-key]");
      if (!row) continue;
      this.#setIconValue(row.dataset.hudIconSection, row.dataset.hudIconKey, input.value?.trim() ?? "", icons);
    }
    return icons;
  }

  #prepareRootIconRows() {
    return DAMAGE_ICON_ROWS.map(row => ({
      ...row,
      img: this.#getIconValue(row.section, row.key)
    }));
  }

  #prepareIconRows(section, rows) {
    return rows.map(row => ({
      ...row,
      section,
      img: this.#getIconValue(section, row.key)
    }));
  }

  #getIconValue(section, key, source = this.icons) {
    if (section === "root") return source[key] ?? "";
    return source[section]?.[key] ?? "";
  }

  #setIconValue(section, key, value, target = this.icons) {
    if (section === "root") {
      target[key] = value;
      return;
    }
    target[section] ??= {};
    target[section][key] = value;
  }
}
