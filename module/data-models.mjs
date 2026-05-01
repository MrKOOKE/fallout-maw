import { FALLOUT_MAW } from "./config.mjs";
import {
  evaluateActionMovementFormulas,
  evaluateSkillFormulas,
  normalizeActionMovementFormulas,
  normalizeCharacteristicSettings,
  normalizeNumberMap,
  normalizeSkillFormulas
} from "./formulas.mjs";

const CHARACTERISTICS_SETTING = "characteristics";
const SKILL_SETTINGS_SETTING = "skillSettings";
const LEGACY_SKILL_FORMULAS_SETTING = "skillFormulas";
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
        stamina: resourceField(10, 10),
        energy: resourceField(0, 0)
      }),
      attributes: new SchemaField({
        level: new NumberField({ required: true, integer: true, min: 1, initial: 1 }),
        dodge: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
        actionPoints: new NumberField({ required: true, integer: true, min: 0, initial: 0 }, { persisted: false }),
        movementPoints: new NumberField({ required: true, integer: true, min: 0, initial: 0 }, { persisted: false })
      }),
      creature: new SchemaField({
        typeId: new StringField({ required: true, blank: true, initial: "" }),
        raceId: new StringField({ required: true, blank: true, initial: "" })
      }),
      characteristics: new ObjectField({ required: true, initial: {} }),
      skills: new ObjectField({ required: true, initial: {} }, { persisted: false }),
      progression: new SchemaField({
        skillPointsPerLevel: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
        researchPointsPerLevel: new NumberField({ required: true, integer: true, min: 0, initial: 0 })
      })
    };
  }

  static migrateData(source) {
    source = super.migrateData(source);
    if (source.attributes) {
      if ((source.attributes.dodge === undefined) && (source.attributes.armor !== undefined)) {
        source.attributes.dodge = source.attributes.armor;
      }
      if ((source.attributes.movementPoints === undefined) && (source.attributes.speed !== undefined)) {
        source.attributes.movementPoints = source.attributes.speed;
      }
      delete source.attributes.armor;
      delete source.attributes.speed;
    }
    delete source.skills;
    return source;
  }

  prepareDerivedData() {
    const characteristicSettings = getCharacteristicSetting();
    const skillSettings = getSkillSetting();
    replaceObjectContents(this.characteristics, normalizeNumberMap(this.characteristics, characteristicSettings));
    replaceObjectContents(this.skills, evaluateSkillFormulas(skillSettings, characteristicSettings, this.characteristics));

    const attributes = evaluateActionMovementFormulas(
      getActionMovementFormulaSetting(),
      characteristicSettings,
      skillSettings,
      this.characteristics,
      this.skills
    );
    this.attributes.actionPoints = attributes.actionPoints;
    this.attributes.movementPoints = attributes.movementPoints;
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
    return normalizeSkillFormulas(game.settings.get(FALLOUT_MAW.id, SKILL_SETTINGS_SETTING));
  } catch (_error) {
    try {
      return normalizeSkillFormulas(game.settings.get(FALLOUT_MAW.id, LEGACY_SKILL_FORMULAS_SETTING));
    } catch (_innerError) {
      return normalizeSkillFormulas();
    }
  }
}

function getActionMovementFormulaSetting() {
  try {
    return normalizeActionMovementFormulas(game.settings.get(FALLOUT_MAW.id, ACTION_MOVEMENT_FORMULAS_SETTING));
  } catch (_error) {
    return normalizeActionMovementFormulas();
  }
}

function replaceObjectContents(target, source) {
  for (const key of Object.keys(target ?? {})) delete target[key];
  Object.assign(target, source);
}
