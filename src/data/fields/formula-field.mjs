import { validateFormula } from "../../formulas/index.mjs";

export class FormulaField extends foundry.data.fields.StringField {
  constructor(options = {}, context = {}) {
    const {
      allowSkills = false,
      characteristics = undefined,
      skills = undefined,
      ...fieldOptions
    } = options;

    super(fieldOptions, context);
    this.allowSkills = allowSkills;
    this.characteristics = characteristics;
    this.skills = skills;
  }

  _validateType(value) {
    validateFormula(value, {
      allowSkills: this.allowSkills,
      characteristics: this.characteristics,
      skills: this.skills
    });
    return super._validateType(value);
  }
}
