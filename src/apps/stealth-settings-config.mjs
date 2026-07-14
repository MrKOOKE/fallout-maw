import { TEMPLATES } from "../constants.mjs";
import {
  getStealthSettings,
  getSkillSettings,
  setStealthSettings
} from "../settings/accessors.mjs";
import { DEFAULT_STEALTH_SETTINGS } from "../stealth/settings.mjs";
import { FalloutMaWFormApplicationV2, getExpandedFormData } from "./base-form-application-v2.mjs";
import { activateFormulaAutocomplete } from "./formula-autocomplete.mjs";

const DETECTION_RANGE_FORMULA_VARIABLES = Object.freeze([
  { key: "skill", abbr: "skill", label: "Навык обнаружения" },
  { key: "skill", abbr: "навык", label: "Навык обнаружения" }
]);

const AUTO_DETECTION_FORMULA_VARIABLES = Object.freeze([
  { key: "actionPointsMax", abbr: "ОД", label: "Максимум ОД" },
  { key: "movementPointsMax", abbr: "ОП", label: "Максимум ОП" }
]);

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
    form: {
      closeOnSubmit: true
    },
    actions: {
      addAttenuationLevel: this.#onAddAttenuationLevel,
      removeAttenuationLevel: this.#onRemoveAttenuationLevel,
      addDifficultyLevel: this.#onAddDifficultyLevel,
      removeDifficultyLevel: this.#onRemoveDifficultyLevel
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
    const skills = getSkillSettings();
    return {
      ...(await super._prepareContext(options)),
      settings: this.settings,
      difficultySkillChoices: skills.map(skill => ({
        key: skill.key,
        label: skill.label,
        selected: skill.key === this.settings.difficulty.skillKey
      })),
      detectionSkillChoices: skills.map(skill => ({
        key: skill.key,
        label: skill.label,
        selected: skill.key === this.settings.detection.skillKey
      })),
      attenuationLevels: this.settings.attenuationLevels.map((level, index) => ({ ...level, index })),
      difficultyLevels: this.settings.difficultyLevels.map((level, index) => ({ ...level, index }))
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    activateFormulaAutocomplete(this.element, {
      skills: getSkillSettings(),
      variables: [...DETECTION_RANGE_FORMULA_VARIABLES, ...AUTO_DETECTION_FORMULA_VARIABLES]
    });
  }

  async _processFormData(_event, _form, formData) {
    const data = getExpandedFormData(formData);
    await setStealthSettings(data);
    this.settings = getStealthSettings();
    ui.notifications.info("Настройки скрытности сохранены.");
    return this.forceRender();
  }

  static async #onAddAttenuationLevel(event) {
    event.preventDefault();
    this.#syncSettingsFromForm();
    this.settings.attenuationLevels.push({ threshold: 0, penaltyPercent: 0 });
    return this.forceRender();
  }

  static async #onRemoveAttenuationLevel(event, target) {
    event.preventDefault();
    this.#syncSettingsFromForm();
    this.settings.attenuationLevels.splice(Math.max(0, Number(target?.dataset?.index) || 0), 1);
    if (!this.settings.attenuationLevels.length) {
      this.settings.attenuationLevels = foundry.utils.deepClone(DEFAULT_STEALTH_SETTINGS.attenuationLevels);
    }
    return this.forceRender();
  }

  static async #onAddDifficultyLevel(event) {
    event.preventDefault();
    this.#syncSettingsFromForm();
    this.settings.difficultyLevels.push({ threshold: 0, difficultyBonus: 0 });
    return this.forceRender();
  }

  static async #onRemoveDifficultyLevel(event, target) {
    event.preventDefault();
    this.#syncSettingsFromForm();
    this.settings.difficultyLevels.splice(Math.max(0, Number(target?.dataset?.index) || 0), 1);
    if (!this.settings.difficultyLevels.length) {
      this.settings.difficultyLevels = foundry.utils.deepClone(DEFAULT_STEALTH_SETTINGS.difficultyLevels);
    }
    return this.forceRender();
  }

  #syncSettingsFromForm() {
    const form = this.element?.querySelector?.("form") ?? this.element;
    if (!form) return;
    this.settings = getExpandedFormData(new FormDataExtended(form));
    if (!Array.isArray(this.settings.attenuationLevels)) this.settings.attenuationLevels = Object.values(this.settings.attenuationLevels ?? {});
    if (!Array.isArray(this.settings.difficultyLevels)) this.settings.difficultyLevels = Object.values(this.settings.difficultyLevels ?? {});
  }
}
