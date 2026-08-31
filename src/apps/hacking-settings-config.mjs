import { TEMPLATES } from "../constants.mjs";
import {
  getHackingSettings,
  getSkillSettings,
  setHackingSettings
} from "../settings/accessors.mjs";
import { FalloutMaWFormApplicationV2, getFlatFormData } from "./base-form-application-v2.mjs";

export class HackingSettingsConfig extends FalloutMaWFormApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "fallout-maw-hacking-settings",
    classes: ["fallout-maw", "fallout-maw-config-form", "fallout-maw-hacking-settings"],
    position: { width: 520, height: "auto" },
    window: { resizable: true },
    form: { closeOnSubmit: true }
  };

  static PARTS = {
    form: { template: TEMPLATES.settings.hacking }
  };

  get title() {
    return "Настройка взлома";
  }

  async _prepareContext(options) {
    const skills = getSkillSettings();
    const settings = getHackingSettings(skills);
    return {
      ...(await super._prepareContext(options)),
      skillChoices: skills.map(skill => ({
        key: skill.key,
        label: skill.label,
        selected: skill.key === settings.skillKey
      }))
    };
  }

  async _processFormData(_event, _form, formData) {
    await setHackingSettings(getFlatFormData(formData));
    ui.notifications.info("Настройки взлома сохранены.");
  }
}
