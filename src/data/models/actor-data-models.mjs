import {
  evaluateFormulaMap,
  evaluateNeedSettings,
  evaluateResourceSettings,
  evaluateSkillFormulas,
  getSkillValues,
  normalizeFormulaMap,
  normalizeNumberMap
} from "../../formulas/index.mjs";
import {
  getCharacteristicSettings,
  getCreatureOptions,
  getCurrencySettings,
  getDamageTypeSettings,
  getNeedSettings,
  getResourceSettings,
  getSkillSettings
} from "../../settings/accessors.mjs";
import { resourceField } from "./resources.mjs";
import { toInteger } from "../../utils/numbers.mjs";

const { HTMLField, NumberField, SchemaField, StringField, TypedObjectField } = foundry.data.fields;

export class BaseActorDataModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      description: new HTMLField({ required: false, blank: true, initial: "" }),
      resources: new TypedObjectField(resourceField(), { required: true, initial: {} }),
      needs: new TypedObjectField(resourceField(), { required: true, initial: {} }),
      load: resourceField(0, 0, { required: true, persisted: false }),
      limbs: new TypedObjectField(limbField(), { required: true, initial: {} }),
      currencies: new TypedObjectField(
        new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
        { required: true, initial: {} }
      ),
      attributes: new SchemaField({
        level: new NumberField({ required: true, integer: true, min: 1, initial: 1 })
      }),
      creature: new SchemaField({
        typeId: new StringField({ required: true, blank: true, initial: "" }),
        raceId: new StringField({ required: true, blank: true, initial: "" })
      }),
      characteristics: new TypedObjectField(
        new NumberField({ required: true, integer: true, initial: 0 }),
        { required: true, initial: {} }
      ),
      skills: new TypedObjectField(skillField(), { required: true, initial: {} }),
      damageResistances: new TypedObjectField(
        new TypedObjectField(new NumberField({ required: true, integer: true, min: 0, initial: 0 }), {
          required: true,
          initial: {}
        }),
        { required: true, initial: {}, persisted: false }
      ),
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
    const currencySettings = getCurrencySettings();
    const resourceSettings = getResourceSettings();
    const needSettings = getNeedSettings();

    this.characteristics ??= {};
    this.skills ??= {};
    this.resources ??= {};
    this.needs ??= {};
    this.limbs ??= {};
    this.currencies ??= {};
    this.damageResistances ??= {};

    replaceObjectContents(this.characteristics, normalizeNumberMap(this.characteristics, characteristicSettings));
    replaceObjectContents(this.currencies, normalizeNumberMap(this.currencies, currencySettings));

    const race = getCreatureOptions(characteristicSettings, damageTypeSettings).races.find(entry => entry.id === this.creature?.raceId);
    if (race?.progression) {
      this.progression.skillPointsPerLevel = toInteger(race.progression.skillPointsPerLevel);
      this.progression.researchPointsPerLevel = toInteger(race.progression.researchPointsPerLevel);
    }

    replaceObjectContents(this.limbs, normalizeLimbMap(this.limbs, race?.limbs ?? []));

    const skillBases = evaluateSkillFormulas(skillSettings, characteristicSettings, this.characteristics);
    replaceObjectContents(this.skills, normalizeSkillMap(this.skills, skillSettings, skillBases));

    const skillValues = getSkillValues(this.skills);
    const resourceMaximums = evaluateResourceSettings(
      resourceSettings,
      characteristicSettings,
      skillSettings,
      this.characteristics,
      skillValues
    );
    replaceObjectContents(this.resources, normalizeResourceMap(this.resources, resourceSettings, resourceMaximums));

    const needMaximums = evaluateNeedSettings(
      needSettings,
      characteristicSettings,
      skillSettings,
      this.characteristics,
      skillValues
    );
    replaceObjectContents(this.needs, normalizeResourceMap(this.needs, needSettings, needMaximums));

    replaceObjectContents(
      this.damageResistances,
      buildLimbDamageResistanceMap(
        this.limbs,
        evaluateFormulaMap(
          getRaceDamageResistanceFormulas(race, damageTypeSettings),
          damageTypeSettings,
          characteristicSettings,
          skillSettings,
          this.characteristics,
          skillValues
        )
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

function skillField() {
  return new SchemaField({
    base: new NumberField({ required: true, integer: true, initial: 0 }),
    bonus: new NumberField({ required: true, integer: true, initial: 0 }),
    value: new NumberField({ required: true, integer: true, initial: 0 })
  });
}

function limbField() {
  return new SchemaField({
    label: new StringField({ required: true, blank: true, initial: "" }),
    min: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
    value: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
    max: new NumberField({ required: true, integer: true, min: 0, initial: 0 })
  });
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

function normalizeResourceMap(currentResources = {}, settings = [], maximums = {}) {
  return Object.fromEntries(
    settings.map(setting => {
      const current = currentResources?.[setting.key];
      const min = Math.max(0, toInteger(current?.min));
      const max = Math.max(min, toInteger(maximums?.[setting.key]));
      const spent = shouldTrackSpent(setting?.key)
        ? getTrackedResourceSpent(current, min, max)
        : Math.max(0, toInteger(current?.spent));
      const fallbackValue = shouldTrackSpent(setting?.key)
        ? max - spent
        : current && typeof current === "object"
          ? current.value
          : max;
      const value = Math.min(Math.max(toInteger(fallbackValue), min), max);
      return [setting.key, { min, spent, value, max }];
    })
  );
}

function normalizeLimbMap(currentLimbs = {}, settings = []) {
  return Object.fromEntries(
    settings.map(setting => {
      const current = currentLimbs?.[setting.key];
      const min = Math.max(0, toInteger(current?.min));
      const max = Math.max(min, toInteger(setting?.stateMax));
      const fallbackValue = current && typeof current === "object" ? current.value : max;
      const value = Math.min(Math.max(toInteger(fallbackValue), min), max);
      return [setting.key, {
        label: String(setting?.label ?? setting?.name ?? setting?.key ?? ""),
        min,
        value,
        max
      }];
    })
  );
}

function buildLimbDamageResistanceMap(limbs = {}, resistanceValues = {}) {
  return Object.fromEntries(
    Object.keys(limbs ?? {}).map(limbKey => [limbKey, { ...resistanceValues }])
  );
}

function shouldTrackSpent(resourceKey) {
  return (resourceKey === "actionPoints") || (resourceKey === "movementPoints");
}

function getTrackedResourceSpent(resource, min, max) {
  if (resource && (typeof resource === "object") && ("spent" in resource)) {
    return Math.min(Math.max(0, toInteger(resource.spent)), Math.max(0, max - min));
  }

  const value = resource && (typeof resource === "object") ? toInteger(resource.value) : max;
  return Math.min(Math.max(0, max - Math.min(Math.max(value, min), max)), Math.max(0, max - min));
}
