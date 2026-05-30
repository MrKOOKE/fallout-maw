import { TEMPLATES } from "../constants.mjs";
import {
  getCombatSettings,
  resetCombatSettings,
  setCombatSettings
} from "../settings/accessors.mjs";
import { FalloutMaWFormApplicationV2, getExpandedFormData } from "./base-form-application-v2.mjs";

export class CombatSettingsConfig extends FalloutMaWFormApplicationV2 {
  constructor(options = {}) {
    super(options);
    this.settings = getCombatSettings();
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-combat-settings",
    classes: ["fallout-maw", "fallout-maw-config-form", "fallout-maw-combat-settings"],
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
      template: TEMPLATES.settings.combat
    }
  };

  get title() {
    return game.i18n.localize("FALLOUTMAW.Settings.Combat.Title");
  }

  async _prepareContext(options) {
    return {
      ...(await super._prepareContext(options)),
      settings: this.settings
    };
  }

  async _processFormData(_event, form, formData) {
    const data = getExpandedFormData(formData);
    data.dodge ??= {};
    data.dodge.enabled = Boolean(form.querySelector("[name='dodge.enabled']")?.checked);
    data.dodge.restoreOnCombatStart = Boolean(form.querySelector("[name='dodge.restoreOnCombatStart']")?.checked);
    data.dodge.restoreOnCombatEnd = Boolean(form.querySelector("[name='dodge.restoreOnCombatEnd']")?.checked);
    await setCombatSettings(data);
    this.settings = getCombatSettings();
    ui.notifications.info(game.i18n.localize("FALLOUTMAW.Messages.CombatSettingsSaved"));
    return this.forceRender();
  }

  static async #onResetDefaults(event) {
    event.preventDefault();
    await resetCombatSettings();
    this.settings = getCombatSettings();
    return this.forceRender();
  }
}
