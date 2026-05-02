import { FALLOUT_MAW } from "./config.mjs";
import {
  evaluateFormulaMap,
  evaluateActionMovementFormulas,
  evaluateSkillFormulas,
  normalizeActionMovementFormulas,
  normalizeCharacteristicSettings,
  normalizeDamageTypeSettings,
  normalizeFormulaMap,
  normalizeNumberMap,
  normalizeSkillSettings
} from "./formulas.mjs";

const CREATURE_OPTIONS_SETTING = "creatureOptions";
const CHARACTERISTICS_SETTING = "characteristics";
const SKILL_SETTINGS_SETTING = "skillSettings";
const DAMAGE_TYPES_SETTING = "damageTypes";
const ACTION_MOVEMENT_FORMULAS_SETTING = "actionMovementFormulas";

const {
  BooleanField,
  HTMLField,
  NumberField,
  ObjectField,
  SchemaField,
  StringField
} = foundry.data.fields;

function resourceField(value = 0, max = value) {
  return new SchemaField({
    min: new NumberField({ required: true, integer: true, initial: 0 }),
    value: new NumberField({ required: true, integer: true, initial: value }),
    max: new NumberField({ required: true, integer: true, initial: max })
  });
}

class BaseActorDataModel extends foundry.abstract.TypeDataModel {
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

  static migrateData(source) {
    source = super.migrateData(source);
    return source;
  }

  prepareDerivedData() {
    const characteristicSettings = getCharacteristicSetting();
    const skillSettings = getSkillSetting();
    const damageTypeSettings = getDamageTypeSetting();
    replaceObjectContents(this.characteristics, normalizeNumberMap(this.characteristics, characteristicSettings));
    this.damageResistances ??= {};
    const skillBases = evaluateSkillFormulas(skillSettings, characteristicSettings, this.characteristics);
    replaceObjectContents(this.skills, normalizeSkillMap(this.skills, skillSettings, skillBases));
    const skillValues = getSkillValues(this.skills);

    const resourceMaximums = evaluateActionMovementFormulas(
      getActionMovementFormulaSetting(),
      characteristicSettings,
      skillSettings,
      this.characteristics,
      skillValues
    );
    setResourceMax(this.resources.actionPoints, resourceMaximums.actionPoints);
    setResourceMax(this.resources.movementPoints, resourceMaximums.movementPoints);

    replaceObjectContents(this.damageResistances, evaluateFormulaMap(
      getRaceDamageResistanceFormulas(this.creature?.raceId, damageTypeSettings),
      damageTypeSettings,
      characteristicSettings,
      skillSettings,
      this.characteristics,
      skillValues
    ));
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

class BaseItemDataModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      description: new HTMLField({ required: false, blank: true, initial: "" }),
      quantity: new NumberField({ required: true, integer: true, min: 0, initial: 1 }),
      weight: new NumberField({ required: true, min: 0, initial: 0 }),
      price: new NumberField({ required: true, min: 0, initial: 0 }),
      equipped: new BooleanField({ required: true, initial: false })
    };
  }
}

export class GearDataModel extends BaseItemDataModel {}

export class WeaponDataModel extends BaseItemDataModel {
  static defineSchema() {
    return {
      ...super.defineSchema(),
      damage: new StringField({ required: true, blank: true, initial: "" }),
      range: new NumberField({ required: true, min: 0, initial: 0 })
    };
  }
}

export class ArmorDataModel extends BaseItemDataModel {
  static defineSchema() {
    return {
      ...super.defineSchema(),
      defense: new NumberField({ required: true, integer: true, min: 0, initial: 0 })
    };
  }
}

export class AbilityDataModel extends BaseItemDataModel {
  static defineSchema() {
    return {
      ...super.defineSchema(),
      cost: new NumberField({ required: true, min: 0, initial: 0 }),
      formula: new StringField({ required: true, blank: true, initial: "" })
    };
  }
}

export class EffectDataModel extends BaseItemDataModel {
  static defineSchema() {
    return {
      ...super.defineSchema(),
      target: new StringField({ required: true, blank: true, initial: "" }),
      duration: new StringField({ required: true, blank: true, initial: "" })
    };
  }
}

function getCharacteristicSetting() {
  try {
    return normalizeCharacteristicSettings(game.settings.get(FALLOUT_MAW.id, CHARACTERISTICS_SETTING));
  } catch (_error) {
    return normalizeCharacteristicSettings();
  }
}

function getSkillSetting() {
  try {
    return normalizeSkillSettings(game.settings.get(FALLOUT_MAW.id, SKILL_SETTINGS_SETTING));
  } catch (_error) {
    return normalizeSkillSettings();
  }
}

function getActionMovementFormulaSetting() {
  try {
    return normalizeActionMovementFormulas(game.settings.get(FALLOUT_MAW.id, ACTION_MOVEMENT_FORMULAS_SETTING));
  } catch (_error) {
    return normalizeActionMovementFormulas();
  }
}

function getDamageTypeSetting() {
  try {
    return normalizeDamageTypeSettings(game.settings.get(FALLOUT_MAW.id, DAMAGE_TYPES_SETTING));
  } catch (_error) {
    return normalizeDamageTypeSettings();
  }
}

function getRaceDamageResistanceFormulas(raceId, damageTypeSettings) {
  try {
    const options = game.settings.get(FALLOUT_MAW.id, CREATURE_OPTIONS_SETTING);
    const race = options?.races?.find(race => race.id === raceId);
    return normalizeFormulaMap(race?.damageResistances, damageTypeSettings);
  } catch (_error) {
    return normalizeFormulaMap({}, damageTypeSettings);
  }
}

function replaceObjectContents(target, source) {
  for (const key of Object.keys(target ?? {})) delete target[key];
  Object.assign(target, source);
}

function normalizeSkillMap(currentSkills = {}, skillSettings = [], skillBases = {}) {
  return Object.fromEntries(skillSettings.map(skill => {
    const current = currentSkills?.[skill.key];
    const bonus = (current && typeof current === "object") ? toInteger(current.bonus) : 0;
    const base = toInteger(skillBases?.[skill.key]);
    return [skill.key, {
      base,
      bonus,
      value: Math.max(0, base + bonus)
    }];
  }));
}

function getSkillValues(skills = {}) {
  return Object.fromEntries(Object.entries(skills).map(([key, skill]) => [
    key,
    (skill && typeof skill === "object") ? toInteger(skill.value) : toInteger(skill)
  ]));
}

function setResourceMax(resource, value) {
  if (!resource) return;
  resource.max = Math.max(Number(resource.min) || 0, toInteger(value));
}

function toInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}
