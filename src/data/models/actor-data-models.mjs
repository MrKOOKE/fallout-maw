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
  getConstructPartNeedSettings,
  getProficiencySettings,
  getRaceNeedSettings,
  getResourceSettings,
  getSkillAdvancementSettings,
  getSkillSettings
} from "../../settings/accessors.mjs";
import { BLEEDING_DAMAGE_TYPE_KEY } from "../../constants.mjs";
import {
  DEFAULT_PROFICIENCY_POINTS_PER_LEVEL_FORMULA,
  DEFAULT_RESEARCH_POINTS_PER_LEVEL_FORMULA,
  DEFAULT_SKILL_DEVELOPMENT_LIMIT,
  DEFAULT_SKILL_POINTS_PER_LEVEL_FORMULA
} from "../../config/defaults.mjs";
import { createDefaultInventorySize } from "../../settings/creature-options.mjs";
import { prepareActorOrganismDevelopmentLimitBase } from "../../races/organism-development.mjs";
import { resourceField } from "./resources.mjs";
import {
  CONSTRUCT_PART_MITIGATION_LIMB_KEY,
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
import { prepareActorEffectChangeForApplication } from "../../utils/active-effect-changes.mjs";
import {
  getConstructPartLimbKey,
  getConstructPartSlotId,
  getConstructPartSlots,
  getConstructPartTypeLabel,
  getInstalledConstructPartForSlot
} from "../../utils/construct-parts.mjs";

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
      limbSilhouetteOverride: new BooleanField({ required: true, initial: false }),
      limbSilhouette: new ObjectField({ required: true, nullable: true, initial: null }),
      currencies: new TypedObjectField(
        new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
        { required: true, initial: {} }
      ),
      attributes: new SchemaField({
        level: new NumberField({ required: true, integer: true, min: 1, initial: 1 }),
        initiativeBonus: new NumberField({ required: true, integer: true, initial: 0 }),
        initiative: new NumberField({ required: true, integer: true, initial: 0, persisted: false })
      }),
      combat: new SchemaField({
        accuracy: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
        criticalChance: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
        damageFlat: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
        damagePercent: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
        burstStability: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
        finishingBlow: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
        finishingBlowChance: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
        unconsciousnessResistance: new NumberField({ required: true, integer: true, initial: 0, persisted: false })
      }),
      healing: new SchemaField({
        incomingPercent: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
        outgoingPercent: new NumberField({ required: true, integer: true, initial: 0, persisted: false })
      }),
      trade: new SchemaField({
        infiniteInventory: new BooleanField({ required: true, initial: false }),
        markupPercent: new NumberField({ required: true, integer: true, initial: 0 }),
        sell: tradeAdjustmentField("increase"),
        buy: tradeAdjustmentField("decrease"),
        categoryOverrides: new ArrayField(tradeCategoryOverrideField(), { required: true, initial: [] }),
        itemOverrides: new ArrayField(tradeItemOverrideField(), { required: true, initial: [] })
      }),
      hacking: new SchemaField({
        enabled: new BooleanField({ required: true, initial: false }),
        methods: new ArrayField(hackingMethodField(), { required: true, initial: [] })
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
        researchPointsPerLevel: new StringField({ required: true, blank: true, initial: DEFAULT_RESEARCH_POINTS_PER_LEVEL_FORMULA }),
        proficiencyPointsPerLevel: new StringField({ required: true, blank: true, initial: DEFAULT_PROFICIENCY_POINTS_PER_LEVEL_FORMULA })
      }),
      organismDevelopment: new SchemaField({
        limit: new NumberField({ required: true, integer: true, min: 0, initial: 50, persisted: false })
      }),
      development: developmentField()
    };
  }

  prepareBaseData() {
    this.resources ??= {};
    ensureReactionResourceBase(this.resources);
    prepareActorOrganismDevelopmentLimitBase(this);
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
    this.limbSilhouetteOverride ??= false;
    this.limbSilhouette ??= null;
    this.currencies ??= {};
    this.combat ??= {};
    this.healing ??= {};
    this.trade ??= {};
    this.hacking ??= {};
    this.damageDefenses ??= {};
    this.damageDefenseBonuses ??= {};
    this.damageResistances ??= {};
    this.damageResistanceBonuses ??= {};
    this.development ??= {};

    const sourceSystem = this.parent?._source?.system ?? {};
    const isConstruct = this.parent?.type === "construct";
    const preparedBonusMode = isConstruct ? "delta" : "prepared";
    const sourceResources = mergePreparedBonuses(sourceSystem.resources, this.resources, { preparedBonusMode });
    const sourceNeeds = mergePreparedBonuses(sourceSystem.needs, this.needs, { preparedBonusMode });
    const sourceProficiencies = mergePreparedBonuses(sourceSystem.proficiencies, this.proficiencies, { preparedBonusMode });

    const baseCharacteristics = normalizeNumberMap(this.characteristics, characteristicSettings);
    const characteristicBonuses = normalizeNumberMap(this.development?.characteristics, characteristicSettings);
    replaceObjectContents(this.characteristics, normalizeCharacteristicMap(
      baseCharacteristics,
      characteristicSettings,
      mergeNumberMaps(characteristicBonuses, abilityBonuses.characteristics)
    ));
    this.attributes.initiativeBonus = toInteger(this.attributes.initiativeBonus);
    this.attributes.initiative = toInteger(this.characteristics.perception) + this.attributes.initiativeBonus;
    replaceObjectContents(this.currencies, normalizeNumberMap(this.currencies, currencySettings));

    const race = isConstruct
      ? null
      : getCreatureOptions(characteristicSettings, damageTypeSettings).races.find(entry => entry.id === this.creature?.raceId);
    const needSettings = isConstruct
      ? getConstructPartNeedSettings(this.parent?.items)
      : getRaceNeedSettings(race);
    prepareActorInventorySize(this.inventory, race);
    if (race?.progression) {
      this.progression.skillPointsPerLevel = String(race.progression.skillPointsPerLevel ?? DEFAULT_SKILL_POINTS_PER_LEVEL_FORMULA);
      this.progression.researchPointsPerLevel = String(race.progression.researchPointsPerLevel ?? DEFAULT_RESEARCH_POINTS_PER_LEVEL_FORMULA);
      this.progression.proficiencyPointsPerLevel = String(race.progression.proficiencyPointsPerLevel ?? DEFAULT_PROFICIENCY_POINTS_PER_LEVEL_FORMULA);
    }

    replaceObjectContents(this.development, normalizeActorDevelopment(this.development, characteristicSettings, skillSettings, proficiencySettings));

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
    replaceObjectContents(this.proficiencies, normalizeProficiencyMap(sourceProficiencies, proficiencySettings));

    const skillValues = getSkillValues(this.skills);
    const constructLimbData = isConstruct ? getConstructPartLimbData(this.parent) : null;
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
      normalizeLimbMap(this.limbs, limbSettings, limbMaximums, limbSource)
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
    const reactionResource = {
      ...(sourceResources?.[REACTION_RESOURCE_KEY] ?? {}),
      bonus: sourceResources?.[REACTION_RESOURCE_KEY]?.bonus
    };
    replaceObjectContents(this.resources, normalizeResourceMap(sourceResources, resourceSettings, resourceMaximums, {
      actor: this.parent,
      sourceResources: sourceSystem.resources,
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
    replaceObjectContents(this.needs, normalizeResourceMap(sourceNeeds, needSettings, needMaximums, {
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
export class ConstructDataModel extends BaseActorDataModel {
  static defineSchema() {
    return {
      ...super.defineSchema(),
      constructPartSlots: new ArrayField(constructPartSlotField(), { required: true, initial: [] })
    };
  }
}

function constructPartSlotField() {
  return new SchemaField({
    id: new StringField({ required: true, blank: false, initial: () => foundry.utils.randomID() }),
    partType: new StringField({ required: true, blank: true, initial: "" }),
    order: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
    profile: new SchemaField({
      name: new StringField({ required: true, blank: true, initial: "" }),
      img: new StringField({ required: true, blank: true, initial: "" }),
      conditionMax: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      constructPart: new ObjectField({ required: true, initial: {} })
    })
  });
}

function hackingMethodField() {
  return new SchemaField({
    id: new StringField({ required: true, blank: false, initial: () => foundry.utils.randomID() }),
    toolKey: new StringField({ required: true, blank: true, initial: "" }),
    toolClass: new StringField({
      required: true,
      blank: false,
      choices: ["D", "C", "B", "A", "S"],
      initial: "D"
    }),
    difficulty: new NumberField({ required: true, integer: true, min: 0, initial: 60 }),
    toolCost: new NumberField({ required: true, integer: true, min: 1, initial: 1 }),
    attempts: new NumberField({ required: true, integer: true, min: 0, initial: 3 }),
    attemptsRemaining: new NumberField({ required: true, integer: true, min: 0, initial: 3 })
  });
}

function tradeAdjustmentField(initialDirection = "increase") {
  return new SchemaField({
    percent: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
    direction: new StringField({
      required: true,
      blank: false,
      choices: ["increase", "decrease"],
      initial: initialDirection
    })
  });
}

function tradeCategoryOverrideField() {
  return new SchemaField({
    id: new StringField({ required: true, blank: false, initial: () => foundry.utils.randomID() }),
    category: new StringField({ required: true, blank: true, initial: "" }),
    sell: tradeAdjustmentField("increase"),
    buy: tradeAdjustmentField("decrease")
  });
}

function tradeItemOverrideField() {
  return new SchemaField({
    id: new StringField({ required: true, blank: false, initial: () => foundry.utils.randomID() }),
    itemUuid: new StringField({ required: true, blank: true, initial: "" }),
    itemId: new StringField({ required: true, blank: true, initial: "" }),
    name: new StringField({ required: true, blank: true, initial: "" }),
    img: new StringField({ required: true, blank: true, initial: "" }),
    mode: new StringField({ required: true, blank: false, choices: ["percent", "fixed"], initial: "percent" }),
    sell: tradeAdjustmentField("increase"),
    buy: tradeAdjustmentField("decrease"),
    fixedSell: tradeFixedPriceField(),
    fixedBuy: tradeFixedPriceField()
  });
}

function tradeFixedPriceField() {
  return new SchemaField({
    value: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
    currencyKey: new StringField({ required: true, blank: true, initial: "" })
  });
}

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
    advantage: new NumberField({ required: true, integer: true, min: 0, initial: 0, persisted: false }),
    disadvantage: new NumberField({ required: true, integer: true, min: 0, initial: 0, persisted: false }),
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
    aimedDifficultyBonus: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
    implantLimitBase: new NumberField({ required: true, integer: true, min: 0, initial: 1, persisted: false }),
    implantLimitBonus: new NumberField({ required: true, integer: true, initial: 0 }),
    implantLimit: new NumberField({ required: true, integer: true, min: 0, initial: 1, persisted: false }),
    critical: new BooleanField({ required: true, initial: false, persisted: false }),
    missing: new BooleanField({ required: true, initial: false }),
    maxBonus: new NumberField({ required: true, integer: true, initial: 0 }),
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
      const advantage = Math.max(0, toInteger(current.advantage));
      const disadvantage = Math.max(0, toInteger(current.disadvantage));
      const developmentBonus = toInteger(skillBonuses?.[skill.key]);
      const abilityBonus = toInteger(abilityBonuses?.[skill.key]);
      const value = Math.min(Math.max(base + bonus + developmentBonus + abilityBonus, min), max);
      return [skill.key, { base, min, bonus, advantage, disadvantage, developmentBonus, abilityBonus, value, max }];
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
    proficiencies: new TypedObjectField(
      new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
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

function normalizeResourceMap(
  currentResources = {},
  settings = [],
  maximums = {},
  { actor = null, sourceResources = {}, trackSpent = false, defaultToMin = false } = {}
) {
  return Object.fromEntries(
    settings.map(setting => {
      const current = currentResources?.[setting.key];
      const min = Math.max(0, toInteger(current?.min));
      const baseMax = toInteger(maximums?.[setting.key]);
      let bonus = current && typeof current === "object" ? toInteger(current.bonus) : 0;
      let max = Math.max(min, baseMax + bonus);
      const overriddenMax = resolveResourceBonusOverrideMaximum(actor, setting.key, {
        baseMax,
        sourceBonus: toInteger(sourceResources?.[setting.key]?.bonus)
      });
      if (Number.isFinite(overriddenMax)) {
        max = Math.max(min, Math.trunc(overriddenMax));
        bonus = max - baseMax;
      }
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

function resolveResourceBonusOverrideMaximum(actor, resourceKey = "", { baseMax = 0, sourceBonus = 0 } = {}) {
  const key = String(resourceKey ?? "").trim();
  if (!actor || !key) return Number.NaN;

  const changes = collectInitialResourceBonusChanges(actor, key);
  if (!changes.some(change => change.type === "override")) return Number.NaN;

  let value = toInteger(baseMax) + toInteger(sourceBonus);
  for (const change of changes) {
    const prepared = prepareActorEffectChangeForApplication(actor, change, { stage: "initial-active-effect" });
    const amount = Number(prepared?.value);
    if (!Number.isFinite(amount)) continue;

    if (prepared.type === "multiply") value *= amount;
    else if (prepared.type === "override") value = amount;
    else if (prepared.type === "upgrade") value = Math.max(value, amount);
    else if (prepared.type === "downgrade") value = Math.min(value, amount);
    else value += amount;
  }
  return value;
}

function collectInitialResourceBonusChanges(actor, resourceKey = "") {
  const acceptedKey = `system.resources.${resourceKey}.bonus`;
  const changes = [];
  for (const effect of actor?.allApplicableEffects?.() ?? actor?.effects ?? []) {
    if (!effect?.active || effect.disabled) continue;
    for (const change of effect.system?.changes ?? []) {
      if (String(change?.phase ?? "initial") !== "initial") continue;
      if (String(change?.key ?? "").trim() !== acceptedKey) continue;
      changes.push({
        ...foundry.utils.deepClone(change),
        effect,
        priority: getEffectChangePriority(change)
      });
    }
  }
  return changes.sort((left, right) => getEffectChangePriority(left) - getEffectChangePriority(right));
}

function getEffectChangePriority(change = {}) {
  const priority = Number(change?.priority);
  if (Number.isFinite(priority)) return Math.trunc(priority);
  const ActiveEffect = foundry.documents?.ActiveEffect?.implementation ?? globalThis.ActiveEffect;
  return toInteger(ActiveEffect?.CHANGE_TYPES?.[change?.type]?.defaultPriority);
}

function mergePreparedBonuses(source = {}, prepared = {}, { preparedBonusMode = "prepared" } = {}) {
  const keys = new Set([
    ...Object.keys(source ?? {}),
    ...Object.keys(prepared ?? {})
  ]);
  return Object.fromEntries(
    Array.from(keys).map(key => {
      const value = source?.[key] ?? prepared?.[key] ?? {};
      const sourceBonus = toInteger(value?.bonus);
      const preparedBonus = toInteger(prepared?.[key]?.bonus ?? value?.bonus);
      return [
        key,
        {
          ...value,
          bonus: preparedBonusMode === "delta"
            ? preparedBonus - sourceBonus
            : preparedBonus
        }
      ];
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
      const current = currentLimbs?.[setting.key] ?? sourceLimbs?.[setting.key];
      const source = sourceLimbs?.[setting.key];
      const baseMax = Math.max(0, toInteger(maximums?.[setting.key] ?? setting?.stateMax));
      const maxBonus = toInteger(current?.maxBonus ?? source?.maxBonus);
      const max = Math.max(0, baseMax + maxBonus);
      const configuredMin = Number(setting?.min);
      const min = Number.isFinite(configuredMin) ? Math.trunc(configuredMin) : -max;
      const spent = normalizeLimbSpent(current, source, min, max);
      const value = Math.min(Math.max(max - spent, min), max);
      const missing = Boolean(source?.missing ?? current?.missing);
      const implantLimitBase = Math.max(0, toInteger(setting?.implantLimit ?? 1));
      const implantLimitBonus = toInteger(current?.implantLimitBonus ?? source?.implantLimitBonus);
      return [setting.key, {
        label: String(setting?.label ?? setting?.name ?? setting?.key ?? ""),
        damageMultiplier: toDecimal(setting?.damageMultiplier, 1),
        aimedDifficultyPercent: toInteger(setting?.aimedDifficultyPercent),
        aimedDifficultyBonus: toInteger(setting?.aimedDifficultyBonus),
        implantLimitBase,
        implantLimitBonus,
        implantLimit: Math.max(0, implantLimitBase + implantLimitBonus),
        critical: Boolean(setting?.critical),
        missing,
        maxBonus,
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
    const isConstructPart = item.type === "gear"
      && hasItemFunction(item, ITEM_FUNCTIONS.constructPart)
      && String(item.system?.placement?.mode ?? "") === ITEM_FUNCTIONS.constructPart;
    if (item.type !== "gear" || (!item.system?.equipped && !isConstructPart) || !hasItemFunction(item, ITEM_FUNCTIONS.damageMitigation)) continue;
    const mitigation = getDamageMitigationFunction(item);
    const mode = String(mitigation.mode || DAMAGE_MITIGATION_MODES.defense);
    const weakening = getConditionWeakeningData(item);
    const weakeningRatio = weakening.active ? weakening.ratio : 1;
    const constructPartLimbKey = isConstructPart
      ? getConstructPartLimbKey(getConstructPartSlotId(item))
      : "";

    for (const [rawLimbKey, damageEntries] of Object.entries(mitigation.entries ?? {})) {
      const limbKey = rawLimbKey === CONSTRUCT_PART_MITIGATION_LIMB_KEY && constructPartLimbKey
        ? constructPartLimbKey
        : rawLimbKey;
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

function getConstructPartLimbData(actor) {
  const settings = [];
  const source = {};

  for (const slot of getConstructPartSlots(actor)) {
    const item = getInstalledConstructPartForSlot(actor, slot.id);
    const key = getConstructPartLimbKey(slot.id);
    if (!key) continue;
    const part = item ? getConstructPartFunction(item) : slot.profile?.constructPart ?? {};
    const label = getConstructPartTypeLabel(item ?? slot) || slot.profile?.name || key;
    const hasCondition = Boolean(item && hasItemFunction(item, ITEM_FUNCTIONS.condition));
    const condition = hasCondition ? getConditionFunction(item) : {};
    const max = hasCondition
      ? Math.max(0, toInteger(condition.max))
      : item ? 0 : Math.max(0, toInteger(slot.profile?.conditionMax));
    const value = hasCondition ? Math.max(0, Math.min(max, toInteger(condition.value))) : 0;
    const missing = !item || (hasCondition && max > 0 && value <= 0);
    settings.push({
      key,
      label,
      stateMax: String(max),
      min: 0,
      damageMultiplier: 1,
      aimedDifficultyPercent: toInteger(part.aimedDifficultyPercent),
      aimedDifficultyBonus: toInteger(part.aimedDifficultyBonus),
      implantLimitBase: 0,
      implantLimitBonus: 0,
      implantLimit: 0,
      critical: Boolean(part.critical)
    });
    source[key] = {
      label,
      value,
      max,
      maxBonus: 0,
      spent: Math.max(0, max - value),
      missing,
      damageAccumulation: {}
    };
  }
  return { settings, source };
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
