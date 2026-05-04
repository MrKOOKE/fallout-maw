import { TEMPLATES } from "../constants.mjs";
import { getLevelSettings, resetLevelSettings, setLevelSettings } from "../settings/accessors.mjs";
import { localize } from "../utils/i18n.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { FalloutMaWFormApplicationV2 } from "./base-form-application-v2.mjs";
import { activateSettingsReorder } from "./settings-reorder.mjs";

export class LevelSettingsConfig extends FalloutMaWFormApplicationV2 {
  constructor(options = {}) {
    super(options);
    this.levels = getLevelSettings();
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-level-settings",
    classes: ["fallout-maw", "fallout-maw-config-form", "level-settings-config"],
    position: {
      width: 520,
      height: 860
    },
    window: {
      resizable: true
    },
    actions: {
      createLevel: this.#onCreateLevel,
      deleteLevel: this.#onDeleteLevel,
      resetDefaults: this.#onResetDefaults
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.settings.levels
    }
  };

  get title() {
    return localize("FALLOUTMAW.Settings.Levels.Title");
  }

  async _prepareContext(options) {
    return {
      ...(await super._prepareContext(options)),
      levels: this.levels
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    activateSettingsReorder(this.element, "[data-level-row]");
  }

  async _processFormData(_event, _form, _formData) {
    const levels = Array.from(this.form?.querySelectorAll("[data-level-row]") ?? []).map(row => ({
      level: Math.max(0, toInteger(row.querySelector("[data-field='level']")?.value)),
      experience: Math.max(0, toInteger(row.querySelector("[data-field='experience']")?.value))
    }));

    await setLevelSettings(levels);
    this.levels = getLevelSettings();
    ui.notifications.info(localize("FALLOUTMAW.Messages.LevelsSaved"));
    return this.forceRender();
  }

  static async #onResetDefaults(event) {
    event.preventDefault();
    await resetLevelSettings();
    this.levels = getLevelSettings();
    return this.forceRender();
  }

  static #onCreateLevel(event) {
    event.preventDefault();
    this.levels = this.#readLevelsFromForm();
    const maxLevel = Math.max(...this.levels.map(level => level.level), 0);
    const maxExperience = Math.max(...this.levels.map(level => level.experience), 0);
    this.levels.push({
      level: maxLevel + 1,
      experience: maxExperience
    });
    return this.forceRender();
  }

  static #onDeleteLevel(event, target) {
    event.preventDefault();
    const rows = Array.from(this.form?.querySelectorAll("[data-level-row]") ?? []);
    const index = rows.indexOf(target.closest("[data-level-row]"));
    if (index < 0) return undefined;

    this.levels = this.#readLevelsFromForm();
    this.levels.splice(index, 1);
    return this.forceRender();
  }

  #readLevelsFromForm() {
    return Array.from(this.form?.querySelectorAll("[data-level-row]") ?? []).map(row => ({
      level: Math.max(0, toInteger(row.querySelector("[data-field='level']")?.value)),
      experience: Math.max(0, toInteger(row.querySelector("[data-field='experience']")?.value))
    }));
  }
}
