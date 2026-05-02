import {
  evaluateActionMovementFormulas,
  evaluateFormulaMap,
  evaluateSkillFormulas,
  getSkillValues,
  normalizeFormulaMap,
  normalizeNumberMap
} from "../../formulas/index.mjs";
import {
  getActionMovementFormulas,
  getCharacteristicSettings,
  getCreatureOptions,
  getDamageTypeSettings,
  getSkillSettings
} from "../../settings/accessors.mjs";
import { toInteger } from "../../utils/numbers.mjs";
import { resourceField, setResourceMaximum } from "./resources.mjs";

const { HTMLField, NumberField, ObjectField, SchemaField, StringField } = foundry.data.fields;

export class BaseActorDataModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      description: new HTMLField({ required: false, blank: true, initial: "" }),
      resources: new SchemaField({
        health: resourceField(10, 10),
        energy: resourceField(0, 0),
        dodge: resourceField(0, 0),
        actionPoints: resourceField(0, 0),
        movementPoints: resourceField(0, 0)
      }),
      attributes: new SchemaField({
        level: new NumberField({ required: true, integer: true, min: 1, initial: 1 })
      }),
      creature: new SchemaField({
        typeId: new StringField({ required: true, blank: true, initial: "" }),
        raceId: new StringField({ required: true, blank: true, initial: "" })
      }),
      characteristics: new ObjectField({ required: true, initial: {} }),
      skills: new ObjectField({ required: true, initial: {} }),
      damageResistances: new ObjectField({ required: false, initial: {} }, { persisted: false }),
      progression: new SchemaField({
        skillPointsPerLevel: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
        researchPointsPerLevel: new NumberField({ required: true, integer: true, min: 0, initial: 0 })
      })
    };
  }

  prepareDerivedData() {
    const characteristicSettings = getCharacteristicSettings();
    const skillSettings = getSkillSettings();
    const damageTypeSettings = getDamageTypeSettings();

    this.characteristics ??= {};
    this.skills ??= {};
    this.damageResistances ??= {};

    replaceObjectContents(this.characteristics, normalizeNumberMap(this.characteristics, characteristicSettings));

    const race = getCreatureOptions(characteristicSettings, damageTypeSettings).races.find(entry => entry.id === this.creature?.raceId);
    if (race?.progression) {
      this.progression.skillPointsPerLevel = toInteger(race.progression.skillPointsPerLevel);
      this.progression.researchPointsPerLevel = toInteger(race.progression.researchPointsPerLevel);
    }

    const skillBases = evaluateSkillFormulas(skillSettings, characteristicSettings, this.characteristics);
    replaceObjectContents(this.skills, normalizeSkillMap(this.skills, skillSettings, skillBases));

    const skillValues = getSkillValues(this.skills);
    const resourceMaximums = evaluateActionMovementFormulas(
      getActionMovementFormulas(),
      characteristicSettings,
      skillSettings,
      this.characteristics,
      skillValues
    );

    setResourceMaximum(this.resources.actionPoints, resourceMaximums.actionPoints);
    setResourceMaximum(this.resources.movementPoints, resourceMaximums.movementPoints);

    replaceObjectContents(
      this.damageResistances,
      evaluateFormulaMap(
        getRaceDamageResistanceFormulas(race, damageTypeSettings),
        damageTypeSettings,
        characteristicSettings,
        skillSettings,
        this.characteristics,
        skillValues
      )
    );
  }
}

export class CharacterDataModel extends BaseActorDataModel {}
export class NpcDataModel extends BaseActorDataModel {}

export class VehicleDataModel extends BaseActorDataModel {
  static defineSchema() {
    return {
      ...super.defineSchema(),
      crew: new NumberField({ required: true, integer: true, min: 0, initial: 0 })
    };
  }
}

export class HazardDataModel extends BaseActorDataModel {
  static defineSchema() {
    return {
      ...super.defineSchema(),
      difficulty: new NumberField({ required: true, integer: true, min: 0, initial: 0 })
    };
  }
}

function getRaceDamageResistanceFormulas(race, damageTypeSettings) {
  return normalizeFormulaMap(race?.damageResistances, damageTypeSettings);
}

function replaceObjectContents(target, source) {
  for (const key of Object.keys(target ?? {})) delete target[key];
  Object.assign(target, source);
}

function normalizeSkillMap(currentSkills = {}, skillSettings = [], skillBases = {}) {
  return Object.fromEntries(
    skillSettings.map(skill => {
      const current = currentSkills?.[skill.key];
      const bonus = current && typeof current === "object" ? toInteger(current.bonus) : 0;
      const base = toInteger(skillBases?.[skill.key]);
      return [skill.key, { base, bonus, value: Math.max(0, base + bonus) }];
    })
  );
}
