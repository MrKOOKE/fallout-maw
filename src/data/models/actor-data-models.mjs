import {
  calculateSkillDevelopmentBonuses,
  normalizeActorDevelopment,
  resolveSkillAdvancementMultiplierChanges
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
  getConstructPartNeedSettings,
  getPreparedRuntimeSettings,
  getRaceNeedSettings
} from "../../settings/accessors.mjs";
import { calculateLevelHealthBonus, usesIndependentHealthModel } from "../../combat/independent-health.mjs";
import { BLEEDING_DAMAGE_TYPE_KEY } from "../../constants.mjs";
import {
  DEFAULT_PROFICIENCY_POINTS_PER_LEVEL_FORMULA,
  DEFAULT_HEALTH_PER_LEVEL_FORMULA,
  DEFAULT_RESEARCH_POINTS_PER_LEVEL_FORMULA,
  DEFAULT_SKILL_DEVELOPMENT_LIMIT,
  DEFAULT_SKILL_POINTS_PER_LEVEL_FORMULA
} from "../../config/defaults.mjs";
import { createDefaultInventorySize } from "../../settings/creature-options.mjs";
import { prepareActorOrganismDevelopmentLimitBase } from "../../races/organism-development.mjs";
import { resourceField } from "./resources.mjs";
import {
  ITEM_FUNCTIONS,
  getConditionFunction,
  getConstructPartFunction,
  hasItemFunction
} from "../../utils/item-functions.mjs";
import {
  buildEmptyLimbDamageMap,
  buildEquippedItemDamageMitigation,
  expandLimbDamageMapSelectors
} from "../../items/damage-mitigation-preparation.mjs";
import { normalizeResearchCollection } from "../../research/storage.mjs";
import { getSkillAdvancementMultiplierChanges } from "../../abilities/evaluation.mjs";
import {
  applyAdvancementPureCharacteristic,
  collectAdvancementPureValueProjection
} from "../../advancement/pure-value-effects.mjs";
import { prepareActorEffectChangeForApplication } from "../../utils/active-effect-changes.mjs";
import { getActorFormulaApplicationPhase } from "../../utils/actor-formulas.mjs";
import { getActorEffectChangeEntries } from "../../documents/actor-effect-preparation-index.mjs";
import {
  getActorGearItems,
  getConstructPartLimbKey,
  getConstructPartSlots,
  getConstructPartTypeLabel,
  getInstalledConstructPartsBySlot
} from "../../utils/construct-parts.mjs";
import { SKILL_CHECK_ACTIONS } from "../../rolls/skill-check-action-effects.mjs";
import {
  CONSCIOUSNESS_RESOURCE_KEY,
  calculateCriticalLimbAverageMaximum,
  resolveConsciousnessMaximum
} from "../../combat/consciousness.mjs";

const REACTION_RESOURCE_KEY = "reactionPoints";
const EMPTY_SKILL_ADVANCEMENT_CHANGES = Object.freeze({});
import { toInteger } from "../../utils/numbers.mjs";
import { composePreparedSkillValue } from "../../utils/skill-value.mjs";

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
      skillCheck: new SchemaField({
        actions: new SchemaField(Object.fromEntries(SKILL_CHECK_ACTIONS.map(action => [
          action.id,
          skillCheckActionEffectField()
        ]))),
        disabledResults: new SchemaField({
          criticalFailure: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
          failure: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
          success: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
          criticalSuccess: new NumberField({ required: true, integer: true, initial: 0, persisted: false })
        })
      }),
      combat: new SchemaField({
        accuracy: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
        criticalChance: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
        criticalDamagePercent: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
        damageFlat: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
        damagePercent: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
        burstStability: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
        attackRangeBonus: new NumberField({ required: true, initial: 0, persisted: false }),
        effectiveRangeNearBonus: new NumberField({ required: true, initial: 0, persisted: false }),
        effectiveRangeFarBonus: new NumberField({ required: true, initial: 0, persisted: false }),
        effectiveRangeNearPenaltyPercent: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
        effectiveRangeFarPenaltyPercent: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
        aimedEffectiveRangeNearBonus: new NumberField({ required: true, initial: 0, persisted: false }),
        aimedEffectiveRangeFarBonus: new NumberField({ required: true, initial: 0, persisted: false }),
        aimedEffectiveRangeNearRestrictionDisabled: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
        aimedEffectiveRangeFarRestrictionDisabled: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
        attackActionPointMovementLossPercentBonus: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
        attackActionPointMovementLossDisabled: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
        conditionLossMultiplier: new NumberField({ required: true, min: 0, initial: 1, persisted: false }),
        finishingBlow: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
        finishingBlowChance: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
        stun: new NumberField({ required: true, integer: true, min: 0, max: 100, initial: 0, persisted: false }),
        unconsciousnessResistance: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
        consciousnessRecoveryTarget: new NumberField({ required: true, integer: true, min: 0, initial: 0 })
      }),
      stealth: new SchemaField({
        illuminationPenaltyPercent: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
        attackBonuses: new SchemaField({
          accuracy: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
          criticalChance: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
          damagePercent: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
          criticalDamagePercent: new NumberField({ required: true, integer: true, initial: 0, persisted: false })
        })
      }),
      healing: new SchemaField({
        incomingPercent: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
        outgoingPercent: new NumberField({ required: true, integer: true, initial: 0, persisted: false })
      }),
      requirements: new SchemaField({
        equipmentPercent: new NumberField({ required: true, initial: 0, persisted: false }),
        weaponPercent: new NumberField({ required: true, initial: 0, persisted: false })
      }),
      equipmentEffectiveness: new SchemaField({
        protectionPercent: new NumberField({ required: true, initial: 0, persisted: false }),
        bonusPercent: new NumberField({ required: true, initial: 0, persisted: false })
      }),
      firstAid: new SchemaField({
        incomingEffectivenessPercent: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
        outgoingEffectivenessPercent: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
        durationPercent: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
        withdrawalResistancePercent: new NumberField({ required: true, integer: true, initial: 0, persisted: false })
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
        healthPerLevel: new StringField({ required: true, blank: true, initial: DEFAULT_HEALTH_PER_LEVEL_FORMULA }),
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
    const {
      characteristicSettings,
      skillSettings,
      damageTypeSettings,
      currencySettings,
      resourceSettings,
      rulesProfile,
      proficiencySettings,
      skillAdvancementSettings,
      creatureOptions
    } = getPreparedRuntimeSettings();
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
    this.skillCheck ??= {};
    this.skillCheck.actions ??= {};
    this.skillCheck.disabledResults ??= {};
    this.combat ??= {};
    this.stealth ??= {};
    this.stealth.attackBonuses ??= {};
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
    const advancementPureValues = collectAdvancementPureValueProjection(
      this.parent,
      characteristicSettings,
      skillSettings
    );
    const sourceResources = mergePreparedBonuses(sourceSystem.resources, this.resources, { preparedBonusMode });
    const sourceNeeds = mergePreparedBonuses(sourceSystem.needs, this.needs, { preparedBonusMode });
    const sourceProficiencies = mergePreparedBonuses(sourceSystem.proficiencies, this.proficiencies, { preparedBonusMode });

    const baseCharacteristics = normalizeNumberMap(this.characteristics, characteristicSettings);
    const characteristicBonuses = normalizeNumberMap(this.development?.characteristics, characteristicSettings);
    const cleanCharacteristics = normalizeCharacteristicMap(
      Object.fromEntries(characteristicSettings.map(characteristic => [
        characteristic.key,
        applyAdvancementPureCharacteristic(
          advancementPureValues,
          characteristic.key,
          sourceSystem.characteristics?.[characteristic.key]
        )
      ])),
      characteristicSettings,
      characteristicBonuses
    );
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
      : creatureOptions.races.find(entry => entry.id === this.creature?.raceId);
    const needSettings = isConstruct
      ? getConstructPartNeedSettings(this.parent?.items)
      : getRaceNeedSettings(race);
    prepareActorInventorySize(this.inventory, race);
    if (race?.progression) {
      this.progression.healthPerLevel = String(race.progression.healthPerLevel ?? DEFAULT_HEALTH_PER_LEVEL_FORMULA);
      this.progression.skillPointsPerLevel = String(race.progression.skillPointsPerLevel ?? DEFAULT_SKILL_POINTS_PER_LEVEL_FORMULA);
      this.progression.researchPointsPerLevel = String(race.progression.researchPointsPerLevel ?? DEFAULT_RESEARCH_POINTS_PER_LEVEL_FORMULA);
      this.progression.proficiencyPointsPerLevel = String(race.progression.proficiencyPointsPerLevel ?? DEFAULT_PROFICIENCY_POINTS_PER_LEVEL_FORMULA);
    }

    replaceObjectContents(this.development, normalizeActorDevelopment(this.development, characteristicSettings, skillSettings, proficiencySettings));

    const skillBases = evaluateSkillFormulas(skillSettings, characteristicSettings, this.characteristics);
    const cleanSkillBases = mergeNumberMaps(
      evaluateSkillFormulas(skillSettings, characteristicSettings, cleanCharacteristics),
      advancementPureValues.skillBonusDeltas
    );
    const skillAdvancementMultiplierChanges = resolveSkillAdvancementMultiplierChanges(
      skillSettings,
      cleanCharacteristics,
      skillAdvancementSettings,
      this.development,
      cleanSkillBases,
      skillAdvancementSettings.mode === "fixed"
        ? EMPTY_SKILL_ADVANCEMENT_CHANGES
        : getSkillAdvancementMultiplierChanges(this.parent, skillSettings)
    );
    const skillBonuses = skillAdvancementSettings.mode === "fixed"
      ? skillAdvancementMultiplierChanges.developmentBonuses
      : calculateSkillDevelopmentBonuses(
        skillSettings,
        this.characteristics,
        skillAdvancementSettings,
        this.development,
        skillAdvancementMultiplierChanges
      );
    replaceObjectContents(this.skills, normalizeSkillMap(
      this.skills,
      skillSettings,
      skillBases,
      skillBonuses,
      skillAdvancementSettings,
      abilityBonuses.skills,
      skillAdvancementMultiplierChanges.pureValues
    ));
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

    const limbResourceFormulaVariables = buildLimbResourceFormulaVariables(this.limbs);
    const usesIndependentHealth = usesIndependentHealthModel(this.parent, { rulesProfile, resourceSettings });
    const evaluatedResourceSettings = usesIndependentHealth
      ? resourceSettings.map(setting => setting.key === "health"
        ? { ...setting, formula: String(race?.baseParameters?.healthFormula ?? "0") }
        : setting)
      : resourceSettings;
    const resourceMaximums = isConstruct
      ? buildConstructResourceMaximums(resourceSettings, limbResourceFormulaVariables)
      : evaluateResourceSettings(
        evaluatedResourceSettings,
        characteristicSettings,
        skillSettings,
        this.characteristics,
        skillValues,
        limbResourceFormulaVariables
      );
    if (usesIndependentHealth) {
      this.development.health = calculateLevelHealthBonus(
        this.progression.healthPerLevel,
        cleanCharacteristics,
        characteristicSettings,
        this.attributes.level
      );
      resourceMaximums.health = Math.max(0, toInteger(resourceMaximums.health) + toInteger(this.development.health));
    }
    const reactionResource = {
      ...(sourceResources?.[REACTION_RESOURCE_KEY] ?? {}),
      bonus: sourceResources?.[REACTION_RESOURCE_KEY]?.bonus
    };
    replaceObjectContents(this.resources, normalizeResourceMap(sourceResources, resourceSettings, resourceMaximums, {
      actor: this.parent,
      sourceResources: sourceSystem.resources,
      trackSpent: true,
      consciousnessRecoveryTarget: this.combat.consciousnessRecoveryTarget
    }));
    ensureReactionResource(this.resources, reactionResource);
    if (!usesIndependentHealth) synchronizeAggregateHealthResource(this.resources, this.limbs);

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
    const itemMitigation = buildEquippedItemDamageMitigation(
      getActorGearItems(this.parent),
      this.limbs,
      damageTypeSettings,
      this.parent
    );
    const damageDefenseBonuses = expandLimbDamageMapSelectors(this.damageDefenseBonuses, this.limbs, damageTypeSettings);
    const damageResistanceBonuses = expandLimbDamageMapSelectors(this.damageResistanceBonuses, this.limbs, damageTypeSettings);
    replaceObjectContents(this.damageDefenses, mergeLimbDamageMaps(baseDamageDefenses, itemMitigation.defenses, damageDefenseBonuses));
    replaceObjectContents(this.damageResistances, mergeLimbDamageMaps(baseDamageResistances, itemMitigation.resistances, damageResistanceBonuses));
  }
}

function skillCheckActionEffectField() {
  return new SchemaField({
    bonus: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
    advantage: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
    disadvantage: new NumberField({ required: true, integer: true, initial: 0, persisted: false })
  });
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
    bonusPercent: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
    pureValue: new NumberField({ required: true, integer: true, min: 0, initial: 0, persisted: false }),
    developmentLimitPureOnly: new BooleanField({ required: true, initial: true, persisted: false }),
    advantage: new NumberField({ required: true, integer: true, min: 0, initial: 0, persisted: false }),
    disadvantage: new NumberField({ required: true, integer: true, min: 0, initial: 0, persisted: false }),
    criticalSuccessChance: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
    criticalFailureChance: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
    developmentBonus: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
    abilityBonus: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
    max: new NumberField({ required: true, integer: true, min: 0, initial: DEFAULT_SKILL_DEVELOPMENT_LIMIT }),
    valueBeforePercent: new NumberField({ required: true, integer: true, initial: 0, persisted: false }),
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

function normalizeSkillMap(
  currentSkills = {},
  skillSettings = [],
  skillBases = {},
  skillBonuses = {},
  skillAdvancementSettings = {},
  abilityBonuses = {},
  pureValues = {}
) {
  const min = 0;
  const max = Math.max(min, toInteger(skillAdvancementSettings?.developmentLimit ?? DEFAULT_SKILL_DEVELOPMENT_LIMIT));
  const developmentLimitPureOnly = skillAdvancementSettings?.developmentLimitPureOnly !== false;
  return Object.fromEntries(
    skillSettings.map(skill => {
      const current = currentSkills?.[skill.key] ?? {};
      const base = toInteger(skillBases?.[skill.key]);
      const bonus = toInteger(current.bonus);
      const bonusPercent = toInteger(current.bonusPercent);
      const advantage = Math.max(0, toInteger(current.advantage));
      const disadvantage = Math.max(0, toInteger(current.disadvantage));
      const criticalSuccessChance = toInteger(current.criticalSuccessChance);
      const criticalFailureChance = toInteger(current.criticalFailureChance);
      const developmentBonus = toInteger(skillBonuses?.[skill.key]);
      const abilityBonus = toInteger(abilityBonuses?.[skill.key]);
      const pureValue = Math.max(0, toInteger(
        pureValues?.[skill.key] ?? (base + developmentBonus)
      ));
      const preparedValue = composePreparedSkillValue({
        base,
        bonus,
        developmentBonus,
        abilityBonus,
        bonusPercent,
        pureValue,
        developmentLimitPureOnly,
        min,
        max
      });
      return [skill.key, {
        base,
        min,
        bonus,
        bonusPercent,
        pureValue,
        developmentLimitPureOnly,
        advantage,
        disadvantage,
        criticalSuccessChance,
        criticalFailureChance,
        developmentBonus,
        abilityBonus,
        valueBeforePercent: preparedValue.valueBeforePercent,
        value: preparedValue.value,
        max
      }];
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
    health: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
    healthInitialized: new BooleanField({ required: true, initial: false }),
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
  {
    actor = null,
    sourceResources = {},
    trackSpent = false,
    defaultToMin = false,
    consciousnessRecoveryTarget = 0
  } = {}
) {
  const initialBonusChanges = collectInitialResourceBonusChangesByKey(
    actor,
    settings.map(setting => setting?.key)
  );
  return Object.fromEntries(
    settings.map(setting => {
      const current = currentResources?.[setting.key];
      const min = setting.key === CONSCIOUSNESS_RESOURCE_KEY
        ? 0
        : Math.max(0, toInteger(current?.min));
      const baseMax = toInteger(maximums?.[setting.key]);
      let bonus = current && typeof current === "object" ? toInteger(current.bonus) : 0;
      let max = Math.max(min, baseMax + bonus);
      const overriddenMax = resolveResourceBonusOverrideMaximum(actor, setting.key, {
        baseMax,
        sourceBonus: toInteger(sourceResources?.[setting.key]?.bonus),
        changes: initialBonusChanges.get(String(setting.key ?? "").trim()) ?? []
      });
      if (Number.isFinite(overriddenMax)) {
        max = Math.max(min, Math.trunc(overriddenMax));
        bonus = max - baseMax;
      }
      const storedRecoveryTarget = setting.key === CONSCIOUSNESS_RESOURCE_KEY
        ? Math.max(0, toInteger(consciousnessRecoveryTarget))
        : 0;
      const calculatedMax = max;
      if (setting.key === CONSCIOUSNESS_RESOURCE_KEY) {
        max = resolveConsciousnessMaximum(calculatedMax, storedRecoveryTarget);
      }
      let spent = trackSpent
        ? getTrackedResourceSpent(current, min, max)
        : Math.max(0, toInteger(current?.spent));
      const fallbackValue = trackSpent
        ? max - spent
        : current && typeof current === "object"
          ? current.value
          : defaultToMin ? min : max;
      let value = Math.min(Math.max(toInteger(fallbackValue), min), max);
      let recoveryTarget = 0;
      if (setting.key === CONSCIOUSNESS_RESOURCE_KEY) {
        recoveryTarget = storedRecoveryTarget;
        if (recoveryTarget > 0 && value >= recoveryTarget) {
          recoveryTarget = 0;
          max = calculatedMax;
          spent = trackSpent
            ? getTrackedResourceSpent(current, min, max)
            : Math.min(Math.max(0, spent), Math.max(0, max - min));
          value = Math.min(Math.max(max - spent, min), max);
        } else if (recoveryTarget <= 0 && max > min && value <= min) {
          recoveryTarget = max;
        }
      }
      const normalizedSpent = trackSpent ? Math.max(0, max - value) : spent;
      return [setting.key, { min, spent: normalizedSpent, bonus, value, max, recoveryTarget }];
    })
  );
}

function resolveResourceBonusOverrideMaximum(
  actor,
  resourceKey = "",
  { baseMax = 0, sourceBonus = 0, changes = [] } = {}
) {
  const key = String(resourceKey ?? "").trim();
  if (!actor || !key) return Number.NaN;

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

function collectInitialResourceBonusChangesByKey(actor, resourceKeys = []) {
  const changesByResourceKey = new Map();
  const resourceKeyByEffectKey = new Map();
  for (const value of resourceKeys ?? []) {
    const resourceKey = String(value ?? "").trim();
    if (!resourceKey || changesByResourceKey.has(resourceKey)) continue;
    changesByResourceKey.set(resourceKey, []);
    const effectKey = `system.resources.${resourceKey}.bonus`;
    if (!actor?._falloutMawRoutedFinalEffectKeys?.has?.(effectKey)) {
      resourceKeyByEffectKey.set(effectKey, resourceKey);
    }
  }
  if (!actor || !resourceKeyByEffectKey.size) return changesByResourceKey;

  for (const { effect, change } of getActorEffectChangeEntries(actor, resourceKeyByEffectKey.keys())) {
    if (!effect?.active || effect.disabled) continue;
    const resourceKey = resourceKeyByEffectKey.get(String(change?.key ?? "").trim());
    if (!resourceKey) continue;
    if (getActorFormulaApplicationPhase(change, actor) !== "initial") continue;
    changesByResourceKey.get(resourceKey).push({
      ...foundry.utils.deepClone(change),
      effect,
      priority: getEffectChangePriority(change)
    });
  }
  for (const changes of changesByResourceKey.values()) {
    changes.sort((left, right) => getEffectChangePriority(left) - getEffectChangePriority(right));
  }
  return changesByResourceKey;
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

function buildConstructResourceMaximums(settings = [], variables = {}) {
  const maximums = buildZeroResourceMaximums(settings);
  if (Object.hasOwn(maximums, CONSCIOUSNESS_RESOURCE_KEY)) {
    maximums[CONSCIOUSNESS_RESOURCE_KEY] = Math.max(0, toInteger(variables.criticalLimbs));
  }
  return maximums;
}

function ensureReactionResourceBase(resources = {}) {
  const current = resources[REACTION_RESOURCE_KEY];
  if (current && typeof current === "object") {
    resources[REACTION_RESOURCE_KEY] = {
      min: 0,
      spent: Math.max(0, toInteger(current.spent)),
      bonus: toInteger(current.bonus),
      value: Math.max(0, toInteger(current.value)),
      max: Math.max(0, toInteger(current.max)),
      recoveryTarget: 0
    };
    return;
  }
  resources[REACTION_RESOURCE_KEY] = {
    min: 0,
    spent: 0,
    bonus: 0,
    value: 0,
    max: 0,
    recoveryTarget: 0
  };
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
    max,
    recoveryTarget: 0
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
      return [proficiency.key, { min, spent: 0, bonus, value, max, recoveryTarget: 0 }];
    })
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

function buildLimbResourceFormulaVariables(limbs = {}) {
  return {
    limbs: Object.values(limbs ?? {}).reduce((sum, limb) => sum + Math.max(0, toInteger(limb?.max)), 0),
    criticalLimbs: calculateCriticalLimbAverageMaximum(limbs)
  };
}

function buildLimbDamageDefenseMap(limbs = {}, defenseValues = {}) {
  return Object.fromEntries(
    Object.keys(limbs ?? {}).map(limbKey => [limbKey, { ...defenseValues }])
  );
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
  const installedPartsBySlot = getInstalledConstructPartsBySlot(actor);

  for (const slot of getConstructPartSlots(actor, { installedPartsBySlot })) {
    const item = installedPartsBySlot.get(slot.id) ?? null;
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
