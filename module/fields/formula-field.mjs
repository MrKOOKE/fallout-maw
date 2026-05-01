import { validateFormula } from "../formulas.mjs";

export default class FormulaField extends foundry.data.fields.StringField {
  constructor(options = {}, context = {}) {
    const { allowSkills = false, ...fieldOptions } = options;
    super(fieldOptions, context);
    this.allowSkills = allowSkills;
  }

  _validateType(value) {
    validateFormula(value, { allowSkills: this.allowSkills });
    super._validateType(value);
  }
}
