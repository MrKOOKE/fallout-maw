import FormulaField from "../fields/formula-field.mjs";

export class ActionMovementFormulasDataModel extends foundry.abstract.DataModel {
  static defineSchema() {
    return {
      actionPoints: new FormulaField({ required: true, blank: false, initial: "5 + (dex/3 + str/5)", allowSkills: true }),
      movementPoints: new FormulaField({ required: true, blank: false, initial: "2 + ath/50", allowSkills: true })
    };
  }
}
