import { FALLOUT_MAW } from "../config.mjs";
import FormulaField from "../fields/formula-field.mjs";

export class SkillFormulasDataModel extends foundry.abstract.DataModel {
  static defineSchema() {
    return Object.fromEntries(Object.keys(FALLOUT_MAW.skills).map(key => [
      key,
      new FormulaField({ required: true, blank: false, initial: "0" })
    ]));
  }
}
