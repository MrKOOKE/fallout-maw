import { TEMPLATES } from "../constants.mjs";
import {
  getCombatSettings,
  resetCombatSettings,
  setCombatSettings
} from "../settings/accessors.mjs";
import { FalloutMaWFormApplicationV2, getExpandedFormData } from "./base-form-application-v2.mjs";
import { activateFormulaAutocomplete } from "./formula-autocomplete.mjs";

const UNCONSCIOUSNESS_FORMULA_VARIABLES = Object.freeze([
  { key: "damage", abbr: "damage", label: "Урон" },
  { key: "normalDamage", abbr: "normalDamage", label: "Урон в обычной зоне" },
  { key: "negativeDamage", abbr: "negativeDamage", label: "Урон в минусовой зоне" },
  { key: "previous", abbr: "previous", label: "Значение до урона" },
  { key: "next", abbr: "next", label: "Значение после урона" },
  { key: "min", abbr: "min", label: "Минимум конечности" },
  { key: "max", abbr: "max", label: "Максимум конечности" },
  { key: "missingStateRatio", abbr: "missingStateRatio", label: "Доля недостающего состояния" },
  { key: "negativeDepthRatio", abbr: "negativeDepthRatio", label: "Доля глубины минуса" },
  { key: "critical", abbr: "critical", label: "Критическая часть: 1 или 0" },
  { key: "resistance", abbr: "resistance", label: "Сопротивление потере сознания" }
]);

const AREA_MOVEMENT_FORMULA_VARIABLES = Object.freeze([
  { key: "actionPointsMax", abbr: "ОД", label: "Максимум ОД" },
  { key: "movementPointsMax", abbr: "ОП", label: "Максимум ОП" }
]);

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

  async _onRender(context, options) {
    await super._onRender(context, options);
    activateFormulaAutocomplete(this.element, {
      variables: [...UNCONSCIOUSNESS_FORMULA_VARIABLES, ...AREA_MOVEMENT_FORMULA_VARIABLES]
    });
  }

  async _processFormData(_event, _form, formData) {
    const data = getExpandedFormData(formData);
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
