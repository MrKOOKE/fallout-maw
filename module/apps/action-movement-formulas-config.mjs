import { normalizeActionMovementFormulas, validateFormula } from "../formulas.mjs";
import {
  getActionMovementFormulas,
  getCharacteristicSettings,
  getSkillSettings,
  resetActionMovementFormulas,
  setActionMovementFormulas
} from "../settings.mjs";
import { activateFormulaAutocomplete } from "./formula-autocomplete.mjs";

export class ActionMovementFormulasConfig extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "fallout-maw-action-movement-formulas",
      title: "Базовые формулы ОД/ОП",
      template: "systems/fallout-maw/templates/settings/action-movement-formulas-config.hbs",
      classes: ["fallout-maw", "action-movement-formulas-config"],
      width: 640,
      height: "auto",
      resizable: true,
      closeOnSubmit: false
    });
  }

  getData(options = {}) {
    return {
      ...super.getData(options),
      formulas: getActionMovementFormulas()
    };
  }

  activateListeners(html) {
    super.activateListeners(html);
    activateFormulaAutocomplete(html, {
      characteristics: getCharacteristicSettings(),
      skills: getSkillSettings()
    });
    html.find("[data-action='reset-defaults']").on("click", this.#onResetDefaults.bind(this));
  }

  async _updateObject(_event, formData) {
    const formulas = normalizeActionMovementFormulas(foundry.utils.expandObject(formData).formulas);
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
    ui.notifications.info("Формулы ОД/ОП сохранены.");
    this.render(true);
  }

  async #onResetDefaults(event) {
    event.preventDefault();
    await resetActionMovementFormulas();
    this.render(true);
  }
}

function getFormulaLabel(key) {
  return key === "actionPoints" ? "Базовые очки действия" : "Базовые очки перемещения";
}
