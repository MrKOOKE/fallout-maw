import { TEMPLATES } from "../constants.mjs";
import { normalizeActionMovementFormulas, validateFormula } from "../formulas/index.mjs";
import {
  getActionMovementFormulas,
  getCharacteristicSettings,
  getSkillSettings,
  resetActionMovementFormulas,
  setActionMovementFormulas
} from "../settings/accessors.mjs";
import { localize } from "../utils/i18n.mjs";
import { FalloutMaWFormApplicationV2, getExpandedFormData } from "./base-form-application-v2.mjs";
import { activateFormulaAutocomplete } from "./formula-autocomplete.mjs";

export class ActionMovementFormulasConfig extends FalloutMaWFormApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "fallout-maw-action-movement-formulas",
    classes: ["fallout-maw", "fallout-maw-config-form", "fallout-maw-formula-config", "action-movement-formulas-config"],
    position: {
      width: 640,
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
      template: TEMPLATES.settings.actionMovementFormulas
    }
  };

  get title() {
    return localize("FALLOUTMAW.Settings.ActionMovement.Title");
  }

  async _prepareContext(options) {
    return {
      ...(await super._prepareContext(options)),
      formulas: getActionMovementFormulas()
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    activateFormulaAutocomplete(this.element, {
      characteristics: getCharacteristicSettings(),
      skills: getSkillSettings()
    });
  }

  async _processFormData(_event, _form, formData) {
    const formulas = normalizeActionMovementFormulas(getExpandedFormData(formData).formulas);
    const characteristics = getCharacteristicSettings();
    const skills = getSkillSettings();

    for (const [key, formula] of Object.entries(formulas)) {
      try {
        validateFormula(formula, { allowSkills: true, characteristics, skills });
      } catch (error) {
        ui.notifications.error(`${getFormulaLabel(key)}: ${error.message}`);
        throw error;
      }
    }

    await setActionMovementFormulas(formulas);
    ui.notifications.info(localize("FALLOUTMAW.Messages.ActionMovementSaved"));
    return this.forceRender();
  }

  static async #onResetDefaults(event) {
    event.preventDefault();
    await resetActionMovementFormulas();
    return this.forceRender();
  }
}

function getFormulaLabel(key) {
  return key === "actionPoints"
    ? localize("FALLOUTMAW.Settings.ActionMovement.ActionPointsFormula")
    : localize("FALLOUTMAW.Settings.ActionMovement.MovementPointsFormula");
}
