import { TEMPLATES } from "../constants.mjs";
import {
  getStealthSettings,
  resetStealthSettings,
  setStealthSettings
} from "../settings/accessors.mjs";
import { STEALTH_LIGHT_LEVELS } from "../stealth/settings.mjs";
import { FalloutMaWFormApplicationV2, getExpandedFormData } from "./base-form-application-v2.mjs";

export class StealthSettingsConfig extends FalloutMaWFormApplicationV2 {
  constructor(options = {}) {
    super(options);
    this.settings = getStealthSettings();
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-stealth-settings",
    classes: ["fallout-maw", "fallout-maw-config-form", "fallout-maw-stealth-settings"],
    position: {
      width: 760,
      height: "auto"
    },
    window: {
      resizable: true
    },
    actions: {
      resetDefaults: this.#onResetDefaults
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.settings.stealth
    }
  };

  get title() {
    return "Настройка скрытности";
  }

  async _prepareContext(options) {
    return {
      ...(await super._prepareContext(options)),
      settings: this.settings,
      levels: STEALTH_LIGHT_LEVELS.map(level => ({
        ...level,
        settings: this.settings[level.key]
      }))
    };
  }

  async _processFormData(_event, _form, formData) {
    const data = getExpandedFormData(formData);
    await setStealthSettings(data);
    this.settings = getStealthSettings();
    ui.notifications.info("Настройки скрытности сохранены.");
    return this.forceRender();
  }

  static async #onResetDefaults(event) {
    event.preventDefault();
    await resetStealthSettings();
    this.settings = getStealthSettings();
    return this.forceRender();
  }
}
