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
import {
  DAMAGE_MITIGATION_MODES,
  ITEM_FUNCTIONS,
  getDamageMitigationFunction,
  hasItemFunction
} from "../../utils/item-functions.mjs";
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
      damageDefenses: new TypedObjectField(
        new TypedObjectField(new NumberField({ required: true, integer: true, min: 0, initial: 0 }), {
          required: true,
          initial: {}
        }),
        { required: true, initial: {}, persisted: false }
      ),
      damageReductions: new TypedObjectField(
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
    this.damageDefenses ??= {};
    this.damageReductions ??= {};

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

    const baseDamageResistances = buildLimbDamageResistanceMap(
      this.limbs,
      evaluateFormulaMap(
        getRaceDamageResistanceFormulas(race, damageTypeSettings),
        damageTypeSettings,
        characteristicSettings,
        skillSettings,
        this.characteristics,
        skillValues
      )
    );
    const itemMitigation = buildEquippedItemDamageMitigation(this.parent?.items, this.limbs, damageTypeSettings);
    replaceObjectContents(this.damageResistances, mergeLimbDamageMaps(baseDamageResistances, itemMitigation.resistances));
    replaceObjectContents(this.damageDefenses, itemMitigation.defenses);
    replaceObjectContents(this.damageReductions, itemMitigation.reductions);
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

function buildEmptyLimbDamageMap(limbs = {}, damageTypeSettings = []) {
  return Object.fromEntries(
    Object.keys(limbs ?? {}).map(limbKey => [
      limbKey,
      Object.fromEntries(damageTypeSettings.map(damageType => [damageType.key, 0]))
    ])
  );
}

function buildEquippedItemDamageMitigation(items, limbs = {}, damageTypeSettings = []) {
  const defenses = buildEmptyLimbDamageMap(limbs, damageTypeSettings);
  const resistances = buildEmptyLimbDamageMap(limbs, damageTypeSettings);
  const reductions = buildEmptyLimbDamageMap(limbs, damageTypeSettings);
  const limbKeys = new Set(Object.keys(limbs ?? {}));
  const damageTypeKeys = new Set(damageTypeSettings.map(damageType => damageType.key));

  for (const item of items?.contents ?? Array.from(items ?? [])) {
    if (item.type !== "gear" || !item.system?.equipped || !hasItemFunction(item, ITEM_FUNCTIONS.damageMitigation)) continue;
    const mitigation = getDamageMitigationFunction(item);
    const mode = String(mitigation.mode || DAMAGE_MITIGATION_MODES.defense);
    const finalReduction = Math.max(0, toInteger(mitigation.finalReduction));

    for (const [limbKey, damageEntries] of Object.entries(mitigation.entries ?? {})) {
      if (!limbKeys.has(limbKey)) continue;
      for (const [damageTypeKey, entry] of Object.entries(damageEntries ?? {})) {
        if (!damageTypeKeys.has(damageTypeKey)) continue;
        const value = Math.max(0, toInteger(entry?.value));
        if (!value) continue;

        if (mode === DAMAGE_MITIGATION_MODES.defense) defenses[limbKey][damageTypeKey] += value;
        else if (mode === DAMAGE_MITIGATION_MODES.resistance) resistances[limbKey][damageTypeKey] += value;
        else continue;

        reductions[limbKey][damageTypeKey] += finalReduction;
      }
    }
  }

  return { defenses, resistances, reductions };
}

function mergeLimbDamageMaps(base = {}, bonus = {}) {
  return Object.fromEntries(
    Object.entries(base ?? {}).map(([limbKey, damageTypes]) => [
      limbKey,
      Object.fromEntries(
        Object.entries(damageTypes ?? {}).map(([damageTypeKey, value]) => [
          damageTypeKey,
          Math.max(0, toInteger(value)) + Math.max(0, toInteger(bonus?.[limbKey]?.[damageTypeKey]))
        ])
      )
    ])
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
