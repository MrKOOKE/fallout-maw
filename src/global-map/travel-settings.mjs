import { FalloutMaWFormApplicationV2, getExpandedFormData } from "../apps/base-form-application-v2.mjs";
import { activateFormulaAutocomplete } from "../apps/formula-autocomplete.mjs";
import { FALLOUT_MAW } from "../config/system-config.mjs";
import { getCharacteristicSettings, getSkillSettings } from "../settings/accessors.mjs";
import { getTokenPrototypeDefaultForActorType } from "../settings/token-prototype-defaults.mjs";
import {
  GLOBAL_MAP_TRAVEL_SPEED_FORMULA_DEFAULT,
  GLOBAL_MAP_TRAVEL_SPEED_FORMULA_SETTING,
  TRAVEL_GROUP_IMAGE_DEFAULT
} from "./constants.mjs";
import {
  TRAVEL_SPEED_FORMULA_VARIABLES,
  getTravelSpeedFormula,
  validateTravelSpeedFormula
} from "./travel-speed.mjs";
import { queueGlobalMapApplicationPosition } from "./window-position.mjs";

const TEMPLATE = `systems/${FALLOUT_MAW.id}/templates/global-map/travel-settings.hbs`;

export class GlobalMapTravelSettings extends FalloutMaWFormApplicationV2 {
  #initialPositionApplied = false;

  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    id: "fallout-maw-global-map-travel-settings",
    classes: [...super.DEFAULT_OPTIONS.classes, "standard-form", "fallout-maw-global-map-editor"],
    position: { width: 420, height: "auto" },
    window: { title: "Путешествие", resizable: false },
    form: {
      handler: GlobalMapTravelSettings.handleFormSubmit,
      submitOnChange: false,
      closeOnSubmit: true
    }
  };

  static PARTS = {
    form: { template: TEMPLATE }
  };

  async _prepareContext() {
    return {
      speedFormula: getTravelSpeedFormula(),
      defaultSpeedFormula: GLOBAL_MAP_TRAVEL_SPEED_FORMULA_DEFAULT
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    activateFormulaAutocomplete(this.element, {
      characteristics: getCharacteristicSettings(),
      skills: getSkillSettings(),
      variables: TRAVEL_SPEED_FORMULA_VARIABLES
    });
    if (this.#initialPositionApplied) return;
    this.#initialPositionApplied = true;
    queueGlobalMapApplicationPosition(this);
  }

  async _processFormData(_event, _form, formData) {
    const values = getExpandedFormData(formData);
    const formula = String(values.speedFormula ?? "").trim() || GLOBAL_MAP_TRAVEL_SPEED_FORMULA_DEFAULT;
    validateTravelSpeedFormula(formula);
    await game.settings.set(FALLOUT_MAW.id, GLOBAL_MAP_TRAVEL_SPEED_FORMULA_SETTING, formula);
  }
}

export function getTravelGroupPrototypeToken() {
  return getTokenPrototypeDefaultForActorType("group");
}

export function getTravelGroupImage() {
  return String(getTravelGroupPrototypeToken()?.texture?.src ?? "").trim()
    || TRAVEL_GROUP_IMAGE_DEFAULT;
}
