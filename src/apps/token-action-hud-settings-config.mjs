import { TEMPLATES } from "../constants.mjs";
import { getPostureIconRows } from "../canvas/posture-movement.mjs";
import {
  getSkillSettings,
  getSystemActionSettings,
  getTokenActionHudIcons,
  setSystemActionSettings,
  setTokenActionHudIcons
} from "../settings/accessors.mjs";
import { FalloutMaWFormApplicationV2 } from "./base-form-application-v2.mjs";

const DAMAGE_ICON_ROWS = Object.freeze([
  { section: "root", key: "damageReductionIcon", label: "Иконка снижения урона" },
  { section: "root", key: "damageBlockedIcon", label: "Иконка полного блокирования урона" },
  { section: "root", key: "dodgeConversionIcon", label: "Иконка уклонения от конвертации ОД" },
  { section: "root", key: "emptyWeaponSlotIcon", label: "Иконка пустого слота оружия" }
]);

const MAIN_ACTION_ICON_ROWS = Object.freeze([
  { key: "weapon", label: "Оружие" },
  { key: "items", label: "Предметы" },
  { key: "abilities", label: "Способности" },
  { key: "skills", label: "Испытания" },
  { key: "passengers", label: "Пассажиры" },
  { key: "actions", label: "Действия" },
  { key: "settings", label: "Настройки" }
]);

const ACTIVE_ACTION_ICON_ROWS = Object.freeze([
  { key: "grapple", label: "Захват" },
  { key: "dragGrappled", label: "Перетащить" },
  { key: "push", label: "Толчок" }
]);

const ADVANCEMENT_ACTION_ICON_ROW = Object.freeze({
  section: "root",
  key: "levelUpIcon",
  label: "Повышение уровня"
});

const ACTOR_CONTAINER_ACTION_ICON_ROWS = Object.freeze([
  { section: "activeActions", key: "boardTransport", label: "Сесть в транспорт" }
]);

const COMBAT_END_ICON_ROWS = Object.freeze([
  { key: "search", label: "Обыскать" },
  { key: "finish", label: "Добить" }
]);

const WEAPON_ACTION_ICON_ROWS = Object.freeze([
  { key: "aimedShot", labelKey: "FALLOUTMAW.Item.WeaponActionAimedShot" },
  { key: "snapshot", labelKey: "FALLOUTMAW.Item.WeaponActionSnapshot" },
  { key: "burst", labelKey: "FALLOUTMAW.Item.WeaponActionBurst" },
  { key: "volley", labelKey: "FALLOUTMAW.Item.WeaponActionVolley" },
  { key: "meleeAttack", labelKey: "FALLOUTMAW.Item.WeaponActionMeleeAttack" },
  { key: "aimedMeleeAttack", labelKey: "FALLOUTMAW.Item.WeaponActionAimedMeleeAttack" },
  { key: "push", labelKey: "FALLOUTMAW.Item.WeaponActionPush" },
  { key: "reload", labelKey: "FALLOUTMAW.Item.WeaponActionReload" },
  { key: "replaceWeapon", label: "Заменить оружие" },
  { key: "lightOn", labelKey: "FALLOUTMAW.Item.LightSourceToggleOn" },
  { key: "lightOff", labelKey: "FALLOUTMAW.Item.LightSourceToggleOff" },
  { key: "lightRecharge", labelKey: "FALLOUTMAW.Item.LightSourceRecharge" }
]);

const EXPERIENCE_AWARD_ROWS = Object.freeze([
  { key: "experienceSoundPath", labelKey: "FALLOUTMAW.Settings.HUD.ExperienceAwardSound", type: "audio" },
  { key: "levelUpSoundPath", labelKey: "FALLOUTMAW.Settings.HUD.LevelUpSound", type: "audio" },
  { key: "levelUpAnimationKey", labelKey: "FALLOUTMAW.Settings.HUD.LevelUpAnimation", type: "animation" }
]);

let activeHudSoundPickerPreview = null;

export class TokenActionHudSettings extends FalloutMaWFormApplicationV2 {
  constructor(options = {}) {
    super(options);
    this.icons = getTokenActionHudIcons();
    this.systemActions = getSystemActionSettings();
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
      browseHudImage: this.#onBrowseHudImage,
      browseHudAudio: this.#onBrowseHudAudio
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
      activeActionIconRows: this.#prepareIconRows("activeActions", ACTIVE_ACTION_ICON_ROWS),
      serviceActionIconRows: this.#prepareServiceActionIconRows(),
      combatEndIconRows: this.#prepareIconRows("combatEnd", COMBAT_END_ICON_ROWS),
      experienceAwardRows: this.#prepareExperienceAwardRows(),
      weaponActionIconRows: this.#prepareIconRows("weaponActions", WEAPON_ACTION_ICON_ROWS.map(row => ({
        ...row,
        label: row.label ?? game.i18n.localize(row.labelKey)
      }))),
      postureIconRows: this.#prepareIconRows("postures", getPostureIconRows()),
      skillIconRows: this.#prepareIconRows("skillIcons", getSkillSettings().map(skill => ({
        key: skill.key,
        label: skill.label
      })))
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    for (const input of this.element?.querySelectorAll("[data-hud-icon-input]") ?? []) {
      input.addEventListener("input", event => this.#previewIconInput(event.currentTarget));
    }
  }

  async _processFormData(_event, _form, _formData) {
    this.icons = this.#readIconsFromForm();
    this.#readExperienceAwardFromForm(this.icons);
    this.systemActions = this.#readSystemActionsFromForm();
    await setTokenActionHudIcons(this.icons);
    await setSystemActionSettings(this.systemActions);
  }

  static async #onBrowseHudImage(event, target) {
    event.preventDefault();
    const row = target.closest("[data-hud-icon-section][data-hud-icon-key]");
    if (!row) return undefined;
    return this.#browseImagePath(row.dataset.hudIconSection, row.dataset.hudIconKey);
  }

  static async #onBrowseHudAudio(event, target) {
    event.preventDefault();
    const row = target.closest("[data-hud-experience-key]");
    if (!row) return undefined;
    return this.#browseAudioPath(row.dataset.hudExperienceKey);
  }

  async #browseImagePath(section, key) {
    this.icons = this.#readIconsFromForm();
    this.#readExperienceAwardFromForm(this.icons);
    this.systemActions = this.#readSystemActionsFromForm();
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

  async #browseAudioPath(key) {
    this.icons = this.#readIconsFromForm();
    this.#readExperienceAwardFromForm(this.icons);
    this.systemActions = this.#readSystemActionsFromForm();
    const current = this.#getExperienceAwardValue(key);
    const picker = new foundry.applications.apps.FilePicker.implementation({
      type: "audio",
      current,
      callback: path => {
        this.#setExperienceAwardValue(key, path);
        this.forceRender();
      }
    });

    activateHudSoundPickerPreview(picker);
    await picker.browse(undefined, { render: false });
    return picker.render({ force: true });
  }

  #readIconsFromForm() {
    const icons = foundry.utils.deepClone(this.icons);
    for (const input of this.form?.querySelectorAll("[data-hud-icon-input]") ?? []) {
      const row = input.closest("[data-hud-icon-section][data-hud-icon-key]");
      if (!row) continue;
      if (row.dataset.hudIconSection === "systemActions") continue;
      this.#setIconValue(row.dataset.hudIconSection, row.dataset.hudIconKey, input.value?.trim() ?? "", icons);
    }
    return icons;
  }

  #readExperienceAwardFromForm(target = this.icons) {
    target.experienceAward ??= {};
    for (const input of this.form?.querySelectorAll("[data-hud-experience-input]") ?? []) {
      const key = String(input.dataset.hudExperienceInput ?? "");
      if (!key) continue;
      target.experienceAward[key] = input.value?.trim() ?? "";
    }
    return target.experienceAward;
  }

  #readSystemActionsFromForm() {
    const actions = foundry.utils.deepClone(this.systemActions);
    const byKey = new Map(actions.map(action => [String(action.key ?? ""), action]));
    for (const input of this.form?.querySelectorAll("[data-hud-icon-input]") ?? []) {
      const row = input.closest("[data-hud-icon-section='systemActions'][data-hud-icon-key]");
      if (!row) continue;
      const action = byKey.get(row.dataset.hudIconKey);
      if (!action) continue;
      action.img = input.value?.trim() ?? "";
    }
    return actions;
  }

  #prepareRootIconRows() {
    return DAMAGE_ICON_ROWS.map(row => ({
      ...row,
      img: this.#getIconValue(row.section, row.key)
    }));
  }

  #prepareServiceActionIconRows() {
    return [
      {
        ...ADVANCEMENT_ACTION_ICON_ROW,
        img: this.#getIconValue(ADVANCEMENT_ACTION_ICON_ROW.section, ADVANCEMENT_ACTION_ICON_ROW.key)
      },
      ...ACTOR_CONTAINER_ACTION_ICON_ROWS.map(row => ({
        ...row,
        img: this.#getIconValue(row.section, row.key)
      })),
      ...this.systemActions.map(action => ({
        section: "systemActions",
        key: action.key,
        label: action.label,
        img: action.img
      }))
    ];
  }

  #prepareExperienceAwardRows() {
    return EXPERIENCE_AWARD_ROWS.map(row => ({
      ...row,
      label: game.i18n.localize(row.labelKey),
      value: this.#getExperienceAwardValue(row.key),
      isAudio: row.type === "audio"
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
    if (section === "systemActions") return this.systemActions.find(action => action.key === key)?.img ?? "";
    return source[section]?.[key] ?? "";
  }

  #getExperienceAwardValue(key, source = this.icons) {
    return source.experienceAward?.[key] ?? "";
  }

  #setExperienceAwardValue(key, value, target = this.icons) {
    target.experienceAward ??= {};
    target.experienceAward[key] = value;
  }

  #setIconValue(section, key, value, target = this.icons) {
    if (section === "root") {
      target[key] = value;
      return;
    }
    if (section === "systemActions") {
      const action = this.systemActions.find(entry => entry.key === key);
      if (action) action.img = value;
      return;
    }
    target[section] ??= {};
    target[section][key] = value;
  }

  #previewIconInput(input) {
    const row = input?.closest("[data-hud-icon-section][data-hud-icon-key]");
    const preview = row?.querySelector("[data-hud-icon-preview]");
    if (!preview) return;
    preview.src = input.value?.trim() || "icons/svg/hazard.svg";
  }
}

function activateHudSoundPickerPreview(picker) {
  const bindPreview = () => {
    const files = picker.element?.querySelector?.("[data-files]");
    if (!files || files.dataset.falloutMawHudSoundPreview) return;
    files.dataset.falloutMawHudSoundPreview = "1";
    files.addEventListener("click", event => {
      const row = event.target?.closest?.("[data-file][data-path]");
      if (!row || !files.contains(row)) return;
      previewHudSoundPickerPath(row.dataset.path);
    });
  };
  picker.addEventListener?.("render", bindPreview);
  picker.addEventListener?.("close", stopActiveHudSoundPickerPreview, { once: true });
}

async function previewHudSoundPickerPath(path = "") {
  const src = String(path ?? "").trim();
  if (!src) return;
  await stopActiveHudSoundPickerPreview();
  try {
    activeHudSoundPickerPreview = await game.audio?.play?.(src, {
      context: game.audio?.interface,
      loop: false,
      volume: 0.8
    }) ?? null;
  } catch (error) {
    console.warn(`Fallout MaW | Failed to preview HUD sound "${src}".`, error);
  }
}

async function stopActiveHudSoundPickerPreview() {
  const sound = activeHudSoundPickerPreview;
  activeHudSoundPickerPreview = null;
  try {
    await sound?.stop?.();
  } catch (error) {
    console.warn("Fallout MaW | Failed to stop HUD sound preview.", error);
  }
}
