import { TEMPLATES } from "../constants.mjs";
import { getSkillCheckControl, setSkillCheckControl } from "../settings/accessors.mjs";
import { localize } from "../utils/i18n.mjs";
import { FalloutMaWFormApplicationV2, getFlatFormData } from "./base-form-application-v2.mjs";

export class SkillCheckControl extends FalloutMaWFormApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "fallout-maw-skill-check-control",
    classes: ["fallout-maw", "fallout-maw-skill-check-control"],
    position: {
      left: 92,
      top: 36,
      width: 650,
      height: "auto"
    },
    window: {
      resizable: false
    },
    form: {
      handler: SkillCheckControl.handleFormSubmit,
      submitOnChange: true,
      closeOnSubmit: false
    },
    actions: {
      reset: SkillCheckControl.#onReset
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.skillCheckControl
    }
  };

  get title() {
    return localize("FALLOUTMAW.SkillCheckControl.Title");
  }

  async _prepareContext(options) {
    const control = getSkillCheckControl();
    return {
      ...(await super._prepareContext(options)),
      control,
      resultModes: getResultModeOptions(control.resultMode),
      edgeModes: getEdgeModeOptions(control.edgeMode)
    };
  }

  async _processFormData(_event, _form, formData) {
    await setSkillCheckControl(readControlFormData(getFlatFormData(formData)));
    return undefined;
  }

  static async #onReset(event) {
    event.preventDefault();
    await setSkillCheckControl({});
    return this.forceRender();
  }
}

function readControlFormData(data = {}) {
  return {
    resultMode: String(data.resultMode ?? "standard"),
    skillModifier: Number(data.skillModifier) || 0,
    difficultyModifier: Number(data.difficultyModifier) || 0,
    criticalSuccessBonus: Number(data.criticalSuccessBonus) || 0,
    criticalFailureBonus: Number(data.criticalFailureBonus) || 0,
    edgeMode: String(data.edgeMode ?? "none"),
    resetResultAfterUse: Boolean(data.resetResultAfterUse),
    resetModifiersAfterUse: Boolean(data.resetModifiersAfterUse),
    resetEdgeModeAfterUse: Boolean(data.resetEdgeModeAfterUse)
  };
}

function getResultModeOptions(current) {
  return [
    ["standard", "FALLOUTMAW.SkillCheckControl.ResultModes.Standard"],
    ["criticalSuccess", "FALLOUTMAW.SkillCheck.CriticalSuccess"],
    ["success", "FALLOUTMAW.SkillCheck.Success"],
    ["failure", "FALLOUTMAW.SkillCheck.Failure"],
    ["criticalFailure", "FALLOUTMAW.SkillCheck.CriticalFailure"]
  ].map(([value, label]) => ({
    value,
    label,
    checked: current === value
  }));
}

function getEdgeModeOptions(current) {
  return [
    ["none", "FALLOUTMAW.SkillCheck.None"],
    ["advantage", "FALLOUTMAW.SkillCheck.Advantage"],
    ["disadvantage", "FALLOUTMAW.SkillCheck.Disadvantage"]
  ].map(([value, label]) => ({
    value,
    label,
    checked: current === value
  }));
}
