import {
  calculateSkillDevelopmentBonuses,
  normalizeActorDevelopment
} from "../../advancement/index.mjs";
import {
  evaluateFormula,
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
  getProficiencySettings,
  getRaceNeedSettings,
  getResourceSettings,
  getSkillAdvancementSettings,
  getSkillSettings
} from "../../settings/accessors.mjs";
import { BLEEDING_DAMAGE_TYPE_KEY } from "../../constants.mjs";
import {
  DEFAULT_RESEARCH_POINTS_PER_LEVEL_FORMULA,
  DEFAULT_SKILL_DEVELOPMENT_LIMIT,
  DEFAULT_SKILL_POINTS_PER_LEVEL_FORMULA
} from "../../config/defaults.mjs";
import { createDefaultInventorySize } from "../../settings/creature-options.mjs";
import { resourceField } from "./resources.mjs";
import {
  DAMAGE_MITIGATION_MODES,
  ITEM_FUNCTIONS,
  getConditionFunction,
  getConstructPartFunction,
  getConditionWeakeningData,
  getDamageMitigationFunction,
  hasItemFunction
} from "../../utils/item-functions.mjs";
import { normalizeResearchCollection } from "../../research/storage.mjs";
import { getAbilitySkillAdvancementBaseBonuses } from "../../abilities/evaluation.mjs";

const REACTION_RESOURCE_KEY = "reactionPoints";
import { toInteger } from "../../utils/numbers.mjs";

const { ArrayField, BooleanField, HTMLField, NumberField, ObjectField, SchemaField, StringField, TypedObjectField } = foundry.data.fields;

export class BaseActorDataModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      description: new HTMLField({ required: false, blank: true, initial: "" }),
      resources: new TypedObjectField(resourceField(), { required: true, initial: {} }),
      needs: new TypedObjectField(resourceField(), { required: true, initial: {} }),
      load: resourceField(0, 0, { required: true, persisted: false }),
      inventory: inventoryField(),
      limbs: new TypedObjectField(limbField(), { required: true, initial: {} }),
      currencies: new TypedObjectField(
        new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
        { required: true, initial: {} }
      ),
      attributes: new SchemaField({
        level: new NumberField({ required: true, integer: true, min: 1, initial: 1 }),
        initiative: new NumberField({ required: true, integer: true, initial: 0, persisted: false })
      }),
      combat: new SchemaField({
        burstStability: new NumberField({ required: true, integer: true, initial: 0, persisted: false })
      }),
      healing: new SchemaField({
        incomingPercent: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
        outgoingPercent: new NumberField({ required: true, integer: true, initial: 0, persisted: false })
      }),
      trade: new SchemaField({
        infiniteInventory: new BooleanField({ required: true, initial: false }),
        markupPercent: new NumberField({ required: true, integer: true, initial: 0 })
      }),
      creature: new SchemaField({
        typeId: new StringField({ required: true, blank: true, initial: "" }),
        raceId: new StringField({ required: true, blank: true, initial: "" }),
        subtypeId: new StringField({ required: true, blank: true, initial: "" })
      }),
      characteristics: new TypedObjectField(
        new NumberField({ required: true, integer: true, initial: 0 }),
        { required: true, initial: {} }
      ),
      skills: new TypedObjectField(skillField(), { required: true, initial: {} }),
      researches: new ArrayField(researchField(), { required: true, initial: [] }),
      proficiencies: new TypedObjectField(resourceField(), { required: true, initial: {} }),
      damageDefenses: new TypedObjectField(
        new TypedObjectField(new NumberField({ required: true, integer: true, initial: 0 }), {
          required: true,
          initial: {}
        }),
        { required: true, initial: {}, persisted: false }
      ),
      damageDefenseBonuses: new TypedObjectField(
        new TypedObjectField(new NumberField({ required: true, integer: true, initial: 0 }), {
          required: true,
          initial: {}
        }),
        { required: true, initial: {}, persisted: false }
      ),
      damageResistances: new TypedObjectField(
        new TypedObjectField(new NumberField({ required: true, integer: true, initial: 0 }), {
          required: true,
          initial: {}
        }),
        { required: true, initial: {}, persisted: false }
      ),
      damageResistanceBonuses: new TypedObjectField(
        new TypedObjectField(new NumberField({ required: true, integer: true, initial: 0 }), {
          required: true,
          initial: {}
        }),
        { required: true, initial: {}, persisted: false }
      ),
      progression: new SchemaField({
        skillPointsPerLevel: new StringField({ required: true, blank: true, initial: DEFAULT_SKILL_POINTS_PER_LEVEL_FORMULA }),
        researchPointsPerLevel: new StringField({ required: true, blank: true, initial: DEFAULT_RESEARCH_POINTS_PER_LEVEL_FORMULA })
      }),
      development: developmentField()
    };
  }

  prepareBaseData() {
    this.resources ??= {};
    ensureReactionResourceBase(this.resources);
  }

  prepareDerivedData() {
    const characteristicSettings = getCharacteristicSettings();
    const skillSettings = getSkillSettings();
    const damageTypeSettings = getDamageTypeSettings();
    const currencySettings = getCurrencySettings();
    const resourceSettings = getResourceSettings();
    const proficiencySettings = getProficiencySettings();
    const skillAdvancementSettings = getSkillAdvancementSettings(characteristicSettings, skillSettings);
    const abilityBonuses = {
      characteristics: Object.fromEntries(characteristicSettings.map(entry => [entry.key, 0])),
      skills: Object.fromEntries(skillSettings.map(entry => [entry.key, 0]))
    };

    this.characteristics ??= {};
    this.skills ??= {};
    this.researches ??= [];
    this.proficiencies ??= {};
    this.resources ??= {};
    this.needs ??= {};
    this.inventory ??= {};
    this.limbs ??= {};
    this.currencies ??= {};
    this.combat ??= {};
    this.healing ??= {};
    this.trade ??= {};
    this.damageDefenses ??= {};
    this.damageDefenseBonuses ??= {};
    this.damageResistances ??= {};
    this.damageResistanceBonuses ??= {};
    this.development ??= {};

    const baseCharacteristics = normalizeNumberMap(this.characteristics, characteristicSettings);
    const characteristicBonuses = normalizeNumberMap(this.development?.characteristics, characteristicSettings);
    replaceObjectContents(this.characteristics, normalizeCharacteristicMap(
      baseCharacteristics,
      characteristicSettings,
      mergeNumberMaps(characteristicBonuses, abilityBonuses.characteristics)
    ));
    this.attributes.initiative = toInteger(this.characteristics.perception);
    replaceObjectContents(this.currencies, normalizeNumberMap(this.currencies, currencySettings));

    const isConstruct = this.parent?.type === "construct";
    const race = isConstruct
      ? null
      : getCreatureOptions(characteristicSettings, damageTypeSettings).races.find(entry => entry.id === this.creature?.raceId);
    const needSettings = getRaceNeedSettings(race);
    prepareActorInventorySize(this.inventory, race);
    if (race?.progression) {
      this.progression.skillPointsPerLevel = String(race.progression.skillPointsPerLevel ?? DEFAULT_SKILL_POINTS_PER_LEVEL_FORMULA);
      this.progression.researchPointsPerLevel = String(race.progression.researchPointsPerLevel ?? DEFAULT_RESEARCH_POINTS_PER_LEVEL_FORMULA);
    }

    replaceObjectContents(this.development, normalizeActorDevelopment(this.development, characteristicSettings, skillSettings));

    const skillBases = evaluateSkillFormulas(skillSettings, characteristicSettings, this.characteristics);
    const skillAdvancementBaseBonuses = getAbilitySkillAdvancementBaseBonuses(this.parent, skillSettings);
    const skillBonuses = calculateSkillDevelopmentBonuses(
      skillSettings,
      this.characteristics,
      skillAdvancementSettings,
      this.development,
      skillAdvancementBaseBonuses
    );
    replaceObjectContents(this.skills, normalizeSkillMap(this.skills, skillSettings, skillBases, skillBonuses, skillAdvancementSettings, abilityBonuses.skills));
    replaceArrayContents(this.researches, normalizeResearchCollection(this.researches));
    replaceObjectContents(this.proficiencies, normalizeProficiencyMap(this.proficiencies, proficiencySettings));

    const skillValues = getSkillValues(this.skills);
    const constructLimbData = isConstruct ? getConstructPartLimbData(this.parent?.items) : null;
    const limbSettings = constructLimbData?.settings ?? race?.limbs ?? [];
    const limbSource = constructLimbData?.source ?? this.parent?._source?.system?.limbs ?? {};
    const limbMaximums = evaluateLimbMaximums(
      limbSettings,
      characteristicSettings,
      skillSettings,
      this.characteristics,
      skillValues
    );
    replaceObjectContents(
      this.limbs,
      normalizeLimbMap(constructLimbData?.source ?? this.limbs, limbSettings, limbMaximums, limbSource)
    );

    const resourceMaximums = isConstruct
      ? buildZeroResourceMaximums(resourceSettings)
      : evaluateResourceSettings(
        resourceSettings,
        characteristicSettings,
        skillSettings,
        this.characteristics,
        skillValues,
        buildLimbResourceFormulaVariables(limbMaximums)
      );
    const reactionResource = isConstruct
      ? { min: 0, spent: 0, bonus: 0, value: 0, max: 0 }
      : {
        ...(this.parent?._source?.system?.resources?.[REACTION_RESOURCE_KEY] ?? {}),
        bonus: this.resources?.[REACTION_RESOURCE_KEY]?.bonus
      };
    replaceObjectContents(this.resources, normalizeResourceMap(isConstruct ? {} : this.resources, resourceSettings, resourceMaximums, {
      trackSpent: true
    }));
    ensureReactionResource(this.resources, reactionResource);
    synchronizeAggregateHealthResource(this.resources, this.limbs);

    const needMaximums = evaluateNeedSettings(
      needSettings,
      characteristicSettings,
      skillSettings,
      this.characteristics,
      skillValues
    );
    replaceObjectContents(this.needs, normalizeResourceMap(this.needs, needSettings, needMaximums, {
      defaultToMin: true
    }));

    const baseDamageDefenses = buildEmptyLimbDamageMap(this.limbs, damageTypeSettings);
    const baseDamageResistances = buildLimbDamageDefenseMap(
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
    applyBleedingResistanceFormula(baseDamageResistances, this.limbs, race, {
      characteristicSettings,
      skillSettings,
      characteristics: this.characteristics,
      skills: skillValues
    });
    const itemMitigation = buildEquippedItemDamageMitigation(this.parent?.items, this.limbs, damageTypeSettings);
    const damageDefenseBonuses = expandLimbDamageMapSelectors(this.damageDefenseBonuses, this.limbs, damageTypeSettings);
    const damageResistanceBonuses = expandLimbDamageMapSelectors(this.damageResistanceBonuses, this.limbs, damageTypeSettings);
    replaceObjectContents(this.damageDefenses, mergeLimbDamageMaps(baseDamageDefenses, itemMitigation.defenses, damageDefenseBonuses));
    replaceObjectContents(this.damageResistances, mergeLimbDamageMaps(baseDamageResistances, itemMitigation.resistances, damageResistanceBonuses));
  }
}

export class CharacterDataModel extends BaseActorDataModel {}
export class ConstructDataModel extends BaseActorDataModel {}

function getRaceDamageResistanceFormulas(race, damageTypeSettings) {
  return normalizeFormulaMap(race?.damageResistances, damageTypeSettings);
}

function applyBleedingResistanceFormula(resistances = {}, limbs = {}, race = null, formulaContext = {}) {
  const formula = String(race?.bleedingResistanceFormula ?? "0").trim() || "0";
  let value = 0;
  try {
    value = Math.max(0, evaluateFormula(formula, formulaContext));
  } catch (error) {
    console.warn(`fallout-maw | Bleeding resistance formula failed for ${race?.id ?? "race"}: ${error.message}`);
  }
  for (const limbKey of Object.keys(limbs ?? {})) {
    resistances[limbKey] ??= {};
    resistances[limbKey][BLEEDING_DAMAGE_TYPE_KEY] = value;
  }
}

function skillField() {
  return new SchemaField({
    base: new NumberField({ required: true, integer: true, initial: 0 }),
    min: new NumberField({ required: true, integer: true, initial: 0 }),
    bonus: new NumberField({ required: true, integer: true, initial: 0 }),
    developmentBonus: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
    abilityBonus: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
    max: new NumberField({ required: true, integer: true, min: 0, initial: DEFAULT_SKILL_DEVELOPMENT_LIMIT }),
    value: new NumberField({ required: true, integer: true, initial: 0 })
  });
}

function researchField() {
  return new SchemaField({
    id: new StringField({ required: true, blank: false, initial: () => foundry.utils.randomID() }),
    name: new StringField({ required: true, blank: true, initial: "" }),
    skillKey: new StringField({ required: true, blank: true, initial: "" }),
    progress: new NumberField({ required: true, min: 0, initial: 0 }),
    target: new NumberField({ required: true, min: 1, initial: 1 }),
    difficulty: new NumberField({ required: true, integer: true, min: 0, initial: 60 }),
    type: new StringField({ required: true, blank: true, initial: "" }),
    sourceId: new StringField({ required: true, blank: true, initial: "" }),
    sourceCategoryId: new StringField({ required: true, blank: true, initial: "" }),
    freeSpent: new NumberField({ required: true, min: 0, initial: 0 }),
    rewards: new ArrayField(new ObjectField({ required: true, initial: {} }), { required: true, initial: [] })
  });
}

function inventoryField() {
  return new SchemaField({
    columns: new NumberField({ required: true, integer: true, min: 1, initial: 1, persisted: false }),
    rows: new NumberField({ required: true, integer: true, min: 1, initial: 1, persisted: false }),
    columnsBonus: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
    rowsBonus: new NumberField({ required: true, integer: true, initial: 0, persisted: false })
  }, { required: true, persisted: false });
}

function limbField() {
  return new SchemaField({
    label: new StringField({ required: true, blank: true, initial: "" }),
    damageMultiplier: new NumberField({ required: true, initial: 1, persisted: false }),
    aimedDifficultyPercent: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
    critical: new BooleanField({ required: true, initial: false, persisted: false }),
    missing: new BooleanField({ required: true, initial: false }),
    min: new NumberField({ required: true, integer: true, initial: -100, persisted: false }),
    spent: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
    value: new NumberField({ required: true, integer: true, initial: 0 }),
    max: new NumberField({ required: true, integer: true, min: 0, initial: 0, persisted: false }),
    damageAccumulation: new TypedObjectField(new NumberField({ required: true, min: 0, initial: 0 }), {
      required: true,
      initial: {}
    })
  });
}

function prepareActorInventorySize(inventory = {}, race = null) {
  const fallback = createDefaultInventorySize();
  const size = race?.inventorySize ?? fallback;
  const columnsBonus = toInteger(inventory.columnsBonus);
  const rowsBonus = toInteger(inventory.rowsBonus);
  inventory.columnsBonus = columnsBonus;
  inventory.rowsBonus = rowsBonus;
  inventory.columns = Math.max(1, toInteger(size.columns ?? fallback.columns) + columnsBonus);
  inventory.rows = Math.max(1, toInteger(size.rows ?? fallback.rows) + rowsBonus);
}

function replaceObjectContents(target, source) {
  for (const key of Object.keys(target ?? {})) delete target[key];
  Object.assign(target, source);
}

function replaceArrayContents(target, source) {
  target.length = 0;
  target.push(...source);
}

function normalizeSkillMap(currentSkills = {}, skillSettings = [], skillBases = {}, skillBonuses = {}, skillAdvancementSettings = {}, abilityBonuses = {}) {
  const min = 0;
  const max = Math.max(min, toInteger(skillAdvancementSettings?.developmentLimit ?? DEFAULT_SKILL_DEVELOPMENT_LIMIT));
  return Object.fromEntries(
    skillSettings.map(skill => {
      const current = currentSkills?.[skill.key] ?? {};
      const base = toInteger(skillBases?.[skill.key]);
      const bonus = toInteger(current.bonus);
      const developmentBonus = toInteger(skillBonuses?.[skill.key]);
      const abilityBonus = toInteger(abilityBonuses?.[skill.key]);
      const value = Math.min(Math.max(base + bonus + developmentBonus + abilityBonus, min), max);
      return [skill.key, { base, min, bonus, developmentBonus, abilityBonus, value, max }];
    })
  );
}

function normalizeCharacteristicMap(currentCharacteristics = {}, characteristicSettings = [], developmentBonuses = {}) {
  return Object.fromEntries(
    characteristicSettings.map(characteristic => [
      characteristic.key,
      toInteger(currentCharacteristics?.[characteristic.key]) + toInteger(developmentBonuses?.[characteristic.key])
    ])
  );
}

function mergeNumberMaps(...maps) {
  const result = {};
  for (const map of maps) {
    for (const [key, value] of Object.entries(map ?? {})) {
      result[key] = toInteger(result[key]) + toInteger(value);
    }
  }
  return result;
}

function developmentField() {
  return new SchemaField({
    initialized: new BooleanField({ required: true, initial: false }),
    experience: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
    points: new SchemaField({
      characteristics: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      signatureSkills: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      traits: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      proficiencies: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      skills: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      researches: new NumberField({ required: true, integer: true, min: 0, initial: 0 })
    }),
    characteristics: new TypedObjectField(
      new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      { required: true, initial: {} }
    ),
    traits: new TypedObjectField(
      new BooleanField({ required: true, initial: false }),
      { required: true, initial: {} }
    ),
    skills: new TypedObjectField(
      new SchemaField({
        points: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
        signature: new BooleanField({ required: true, initial: false })
      }),
      { required: true, initial: {} }
    )
  });
}

function normalizeResourceMap(currentResources = {}, settings = [], maximums = {}, { trackSpent = false, defaultToMin = false } = {}) {
  return Object.fromEntries(
    settings.map(setting => {
      const current = currentResources?.[setting.key];
      const min = Math.max(0, toInteger(current?.min));
      const bonus = current && typeof current === "object" ? toInteger(current.bonus) : 0;
      const max = Math.max(min, toInteger(maximums?.[setting.key]) + bonus);
      const spent = trackSpent
        ? getTrackedResourceSpent(current, min, max)
        : Math.max(0, toInteger(current?.spent));
      const fallbackValue = trackSpent
        ? max - spent
        : current && typeof current === "object"
          ? current.value
          : defaultToMin ? min : max;
      const value = Math.min(Math.max(toInteger(fallbackValue), min), max);
      return [setting.key, { min, spent, bonus, value, max }];
    })
  );
}

function buildZeroResourceMaximums(settings = []) {
  return Object.fromEntries((settings ?? []).map(setting => [setting.key, 0]));
}

function ensureReactionResourceBase(resources = {}) {
  const current = resources[REACTION_RESOURCE_KEY];
  if (current && typeof current === "object") {
    resources[REACTION_RESOURCE_KEY] = {
      min: 0,
      spent: Math.max(0, toInteger(current.spent)),
      bonus: toInteger(current.bonus),
      value: Math.max(0, toInteger(current.value)),
      max: Math.max(0, toInteger(current.max))
    };
    return;
  }
  resources[REACTION_RESOURCE_KEY] = { min: 0, spent: 0, bonus: 0, value: 0, max: 0 };
}

function ensureReactionResource(resources = {}, currentResource = resources[REACTION_RESOURCE_KEY]) {
  const current = currentResource;
  const min = 0;
  const bonus = current && typeof current === "object" ? toInteger(current.bonus) : 0;
  const max = Math.max(min, bonus);
  const spent = getTrackedResourceSpent(current, min, max);
  const value = Math.min(Math.max(max - spent, min), max);
  resources[REACTION_RESOURCE_KEY] = {
    min,
    spent,
    bonus,
    value,
    max
  };
}

function normalizeLimbMap(currentLimbs = {}, settings = [], maximums = {}, sourceLimbs = {}) {
  return Object.fromEntries(
    settings.map(setting => {
      const current = currentLimbs?.[setting.key];
      const source = sourceLimbs?.[setting.key];
      const max = Math.max(0, toInteger(maximums?.[setting.key] ?? setting?.stateMax));
      const configuredMin = Number(setting?.min);
      const min = Number.isFinite(configuredMin) ? Math.trunc(configuredMin) : -max;
      const spent = normalizeLimbSpent(current, source, min, max);
      const value = Math.min(Math.max(max - spent, min), max);
      const missing = Boolean(source?.missing ?? current?.missing);
      return [setting.key, {
        label: String(setting?.label ?? setting?.name ?? setting?.key ?? ""),
        damageMultiplier: toDecimal(setting?.damageMultiplier, 1),
        aimedDifficultyPercent: toInteger(setting?.aimedDifficultyPercent),
        critical: Boolean(setting?.critical),
        missing,
        min,
        spent,
        value,
        max,
        damageAccumulation: normalizeDamageAccumulation(current?.damageAccumulation)
      }];
    })
  );
}

function normalizeLimbSpent(current, source, min, max) {
  const capacity = Math.max(0, max - min);
  if (!current || typeof current !== "object") return 0;

  const hasSourceSpent = source && typeof source === "object" && Object.hasOwn(source, "spent");
  const explicitSpent = hasSourceSpent ? Number(source.spent) : NaN;
  if (Number.isFinite(explicitSpent)) return Math.min(Math.max(0, Math.trunc(explicitSpent)), capacity);

  const currentValue = Math.min(Math.max(toInteger(current.value), min), max);
  return Math.min(Math.max(0, max - currentValue), capacity);
}

function toDecimal(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeDamageAccumulation(value = {}) {
  return Object.fromEntries(
    Object.entries(value ?? {})
      .map(([key, amount]) => [key, Math.max(0, Number(amount) || 0)])
      .filter(([_key, amount]) => amount > 0)
  );
}

function normalizeProficiencyMap(currentProficiencies = {}, proficiencySettings = []) {
  return Object.fromEntries(
    proficiencySettings.map(proficiency => {
      const current = currentProficiencies?.[proficiency.key];
      const min = 0;
      const bonus = current && typeof current === "object" ? toInteger(current.bonus) : 0;
      const max = Math.max(min, toInteger(proficiency.max) + bonus);
      const value = Math.min(Math.max(toInteger(current?.value), min), max);
      return [proficiency.key, { min, spent: 0, bonus, value, max }];
    })
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

function evaluateLimbMaximums(settings = [], characteristicSettings = [], skillSettings = [], characteristics = {}, skills = {}) {
  return Object.fromEntries(
    settings.map(setting => {
      const key = String(setting?.key ?? "").trim();
      try {
        return [
          key,
          Math.max(0, evaluateFormula(setting?.stateMax ?? "0", {
            characteristicSettings,
            skillSettings,
            characteristics,
            skills
          }))
        ];
      } catch (error) {
        console.warn(`fallout-maw | Limb state formula failed for ${key}: ${error.message}`);
        return [key, 0];
      }
    }).filter(([key]) => key)
  );
}

function buildLimbResourceFormulaVariables(limbMaximums = {}) {
  return {
    limbs: Object.values(limbMaximums ?? {}).reduce((sum, value) => sum + Math.max(0, toInteger(value)), 0)
  };
}

function buildLimbDamageDefenseMap(limbs = {}, defenseValues = {}) {
  return Object.fromEntries(
    Object.keys(limbs ?? {}).map(limbKey => [limbKey, { ...defenseValues }])
  );
}

function buildEquippedItemDamageMitigation(items, limbs = {}, damageTypeSettings = []) {
  const defenses = buildEmptyLimbDamageMap(limbs, damageTypeSettings);
  const resistances = buildEmptyLimbDamageMap(limbs, damageTypeSettings);
  const limbKeys = new Set(Object.keys(limbs ?? {}));
  const damageTypeKeys = new Set(damageTypeSettings.map(damageType => damageType.key));

  for (const item of items?.contents ?? Array.from(items ?? [])) {
    if (item.type !== "gear" || !item.system?.equipped || !hasItemFunction(item, ITEM_FUNCTIONS.damageMitigation)) continue;
    const mitigation = getDamageMitigationFunction(item);
    const mode = String(mitigation.mode || DAMAGE_MITIGATION_MODES.defense);
    const weakening = getConditionWeakeningData(item);
    const weakeningRatio = weakening.active ? weakening.ratio : 1;

    for (const [limbKey, damageEntries] of Object.entries(mitigation.entries ?? {})) {
      if (!limbKeys.has(limbKey)) continue;
      for (const [damageTypeKey, entry] of Object.entries(damageEntries ?? {})) {
        if (!damageTypeKeys.has(damageTypeKey)) continue;
        const baseValue = toInteger(entry?.value);
        const value = baseValue > 0 ? Math.floor(baseValue * weakeningRatio) : baseValue;
        if (!value) continue;

        if (mode === DAMAGE_MITIGATION_MODES.resistance) resistances[limbKey][damageTypeKey] += value;
        else defenses[limbKey][damageTypeKey] += value;
      }
    }
  }

  return { defenses, resistances };
}

function mergeLimbDamageMaps(base = {}, ...bonuses) {
  return Object.fromEntries(
    Object.entries(base ?? {}).map(([limbKey, damageTypes]) => [
      limbKey,
      Object.fromEntries(
        Object.entries(damageTypes ?? {}).map(([damageTypeKey, value]) => [
          damageTypeKey,
          toInteger(value) + bonuses.reduce((sum, bonus) => sum + toInteger(bonus?.[limbKey]?.[damageTypeKey]), 0)
        ])
      )
    ])
  );
}

function getConstructPartLimbData(items) {
  const settings = [];
  const source = {};
  const constructParts = (items?.contents ?? Array.from(items ?? []))
    .filter(item => (
      item?.type === "gear"
      && hasItemFunction(item, ITEM_FUNCTIONS.constructPart)
      && String(item.system?.placement?.mode ?? "") === ITEM_FUNCTIONS.constructPart
    ))
    .sort(compareConstructPartItems);

  for (const item of constructParts) {
    const key = `constructPart:${item.id}`;
    const part = getConstructPartFunction(item);
    const label = String(part.partType ?? "").trim() || item.name || key;
    const hasCondition = hasItemFunction(item, ITEM_FUNCTIONS.condition);
    const condition = hasCondition ? getConditionFunction(item) : {};
    const max = hasCondition ? Math.max(0, toInteger(condition.max)) : 0;
    const value = hasCondition ? Math.max(0, Math.min(max, toInteger(condition.value))) : 0;
    const missing = hasCondition && max > 0 && value <= 0;
    settings.push({
      key,
      label,
      stateMax: String(max),
      min: 0,
      damageMultiplier: 1,
      aimedDifficultyPercent: toInteger(part.aimedDifficultyPercent),
      critical: Boolean(part.critical)
    });
    source[key] = {
      label,
      value,
      max,
      spent: Math.max(0, max - value),
      missing,
      damageAccumulation: {}
    };
  }
  return { settings, source };
}

function compareConstructPartItems(left, right) {
  const leftOrder = toInteger(left.system?.placement?.constructPartOrder);
  const rightOrder = toInteger(right.system?.placement?.constructPartOrder);
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  return String(left.id).localeCompare(String(right.id));
}

function expandLimbDamageMapSelectors(source = {}, limbs = {}, damageTypeSettings = []) {
  const result = buildEmptyLimbDamageMap(limbs, damageTypeSettings);
  const limbKeys = Object.keys(limbs ?? {});
  const damageTypeKeys = damageTypeSettings.map(damageType => damageType.key).filter(Boolean);

  for (const [limbSelector, damageEntries] of Object.entries(source ?? {})) {
    const selectedLimbs = isAllSelector(limbSelector)
      ? limbKeys
      : limbKeys.includes(limbSelector) ? [limbSelector] : [];
    if (!selectedLimbs.length) continue;

    for (const [damageTypeSelector, value] of Object.entries(damageEntries ?? {})) {
      const selectedDamageTypes = isAllSelector(damageTypeSelector)
        ? damageTypeKeys
        : damageTypeKeys.includes(damageTypeSelector) ? [damageTypeSelector] : [];
      const bonus = toInteger(value);
      if (!selectedDamageTypes.length || !bonus) continue;

      for (const limbKey of selectedLimbs) {
        for (const damageTypeKey of selectedDamageTypes) {
          result[limbKey][damageTypeKey] += bonus;
        }
      }
    }
  }

  return result;
}

function isAllSelector(value) {
  return String(value ?? "").trim() === "all";
}

function synchronizeAggregateHealthResource(resources = {}, limbs = {}) {
  const health = resources?.health;
  if (!health) return;

  const entries = Object.values(limbs ?? {}).filter(limb => limb && typeof limb === "object");
  const min = 0;
  const aggregate = entries.reduce((result, limb) => {
    if (Boolean(limb?.missing)) {
      return result;
    }
    result.max += Math.max(0, toInteger(limb?.max));
    result.value += Math.max(0, toInteger(limb?.value));
    return result;
  }, { value: 0, max: 0 });

  health.min = min;
  health.bonus = 0;
  health.max = aggregate.max;
  health.value = Math.min(Math.max(aggregate.value, min), aggregate.max);
  health.spent = Math.max(0, aggregate.max - health.value);
}

function getTrackedResourceSpent(resource, min, max) {
  if (resource && (typeof resource === "object") && ("spent" in resource)) {
    return Math.min(Math.max(0, toInteger(resource.spent)), Math.max(0, max - min));
  }

  const value = resource && (typeof resource === "object") ? toInteger(resource.value) : max;
  return Math.min(Math.max(0, max - Math.min(Math.max(value, min), max)), Math.max(0, max - min));
}
