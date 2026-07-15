import { getPrimaryCurrencyKey } from "../../settings/accessors.mjs";

const { ArrayField, BooleanField, HTMLField, NumberField, ObjectField, SchemaField, StringField, TypedObjectField, TypedSchemaField } = foundry.data.fields;
const OPTIONAL_FUNCTION_FIELD_OPTIONS = Object.freeze({ required: false });
const DEFAULT_WEAPON_ATTACK_CONE_DEGREES = 3;
const DEFAULT_WEAPON_ACTION_POINT_COST = 5;
const DEFAULT_WEAPON_PUSH_MAX_RANGE_METERS = 1;
const DEFAULT_RELOAD_ACTION_POINT_COST = 2;
const DEFAULT_CONDITION_WEAKENING_THRESHOLD = 10;
const WEAPON_SPECIAL_PROPERTY_PENDING = "pending";
const WEAPON_SPECIAL_PROPERTY_HIT_ALL_CONE_TARGETS = "hitAllConeTargets";
const WEAPON_SPECIAL_PROPERTY_ATTACK_POWER = "attackPower";
export class BaseItemDataModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      description: new HTMLField({ required: false, blank: true, initial: "" }),
      quantity: new NumberField({ required: true, integer: true, min: 0, initial: 1 }),
      maxStack: new NumberField({ required: true, integer: true, min: 1, initial: 1 }),
      stackParts: new ArrayField(new SchemaField({
        quantity: new NumberField({ required: true, integer: true, min: 1, initial: 1 }),
        x: new NumberField({ required: false, nullable: true, integer: true, min: 1, initial: null }),
        y: new NumberField({ required: false, nullable: true, integer: true, min: 1, initial: null }),
        rotated: new BooleanField({ required: false, nullable: true, initial: null })
      }), { required: true, initial: [] }),
      itemCategory: new StringField({ required: true, blank: true, initial: "" }),
      weight: new NumberField({ required: true, min: 0, initial: 0 }),
      price: new NumberField({ required: true, min: 0, initial: 0 }),
      priceCurrency: new StringField({ required: true, blank: true, initial: () => getPrimaryCurrencyKey() }),
      equipped: new BooleanField({ required: true, initial: false }),
      locked: new BooleanField({ required: true, initial: false }),
      container: new SchemaField({
        parentId: new StringField({ required: true, blank: true, initial: "" })
      }),
      occupiedSlots: new TypedObjectField(new BooleanField({ required: true, initial: false }), {
        required: true,
        initial: {}
      }),
      occupiedSlotMode: new StringField({ required: true, blank: false, choices: ["oneOf", "all"], initial: "all" }),
      weaponSlotRequirement: new SchemaField({
        mode: new StringField({ required: true, blank: false, choices: ["oneOf", "all"], initial: "oneOf" }),
        slots: new TypedObjectField(new BooleanField({ required: true, initial: false }), {
          required: true,
          initial: {}
        })
      }),
      placement: new SchemaField({
        mode: new StringField({ required: true, blank: true, initial: "inventory" }),
        equipmentSlot: new StringField({ required: true, blank: true, initial: "" }),
        weaponSet: new StringField({ required: true, blank: true, initial: "" }),
        weaponSlot: new StringField({ required: true, blank: true, initial: "" }),
        limbKey: new StringField({ required: true, blank: true, initial: "" }),
        constructPartOrder: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
        x: new NumberField({ required: true, integer: true, min: 1, initial: 1 }),
        y: new NumberField({ required: true, integer: true, min: 1, initial: 1 }),
        width: new NumberField({ required: true, integer: true, min: 1, initial: 1 }),
        height: new NumberField({ required: true, integer: true, min: 1, initial: 1 }),
        rotated: new BooleanField({ required: true, initial: false })
      })
    };
  }

  prepareBaseData() {
    super.prepareBaseData?.();
    if (!String(this.priceCurrency ?? "")) this.priceCurrency = getPrimaryCurrencyKey();
  }
}

export class GearDataModel extends BaseItemDataModel {
  static defineSchema() {
    return {
      ...super.defineSchema(),
      itemFunction: new StringField({ required: true, blank: true, initial: "" }),
      functions: new SchemaField({
        actorContainer: actorContainerFunctionField(OPTIONAL_FUNCTION_FIELD_OPTIONS),
        container: containerFunctionField(OPTIONAL_FUNCTION_FIELD_OPTIONS),
        condition: conditionFunctionField(OPTIONAL_FUNCTION_FIELD_OPTIONS),
        constructPart: constructPartFunctionField(OPTIONAL_FUNCTION_FIELD_OPTIONS),
        damageSource: damageSourceFunctionField(OPTIONAL_FUNCTION_FIELD_OPTIONS),
        energyConsumer: energyConsumerFunctionField(OPTIONAL_FUNCTION_FIELD_OPTIONS),
        energySource: energySourceFunctionField(OPTIONAL_FUNCTION_FIELD_OPTIONS),
        freeSettings: itemFreeSettingsFunctionField(OPTIONAL_FUNCTION_FIELD_OPTIONS),
        implant: implantFunctionField(OPTIONAL_FUNCTION_FIELD_OPTIONS),
        lightSource: lightSourceFunctionField(OPTIONAL_FUNCTION_FIELD_OPTIONS),
        module: moduleFunctionField(OPTIONAL_FUNCTION_FIELD_OPTIONS),
        prosthesis: prosthesisFunctionField(OPTIONAL_FUNCTION_FIELD_OPTIONS),
        trap: trapFunctionField(OPTIONAL_FUNCTION_FIELD_OPTIONS),
        weapon: weaponFunctionField({ fieldOptions: OPTIONAL_FUNCTION_FIELD_OPTIONS }),
        additionalWeapons: new TypedObjectField(weaponFunctionField({ named: true }), { required: false }),
        damageMitigation: new SchemaField({
          enabled: new BooleanField({ required: true, initial: false }),
          mode: new StringField({ required: true, blank: false, choices: ["defense", "resistance"], initial: "defense" }),
          limbSetIds: new ArrayField(new StringField({ required: true, blank: false, initial: "" }), { required: true, initial: [] }),
          entries: new TypedObjectField(
            new TypedObjectField(damageMitigationEntryField(), { required: true, initial: {} }),
            { required: true, initial: {} }
          )
        }, OPTIONAL_FUNCTION_FIELD_OPTIONS),
        firstAid: firstAidFunctionField(OPTIONAL_FUNCTION_FIELD_OPTIONS),
        needChange: needChangeFunctionField(OPTIONAL_FUNCTION_FIELD_OPTIONS),
        oneTimeUse: oneTimeUseFunctionField(OPTIONAL_FUNCTION_FIELD_OPTIONS),
        tools: new TypedObjectField(toolFunctionField(), { required: false })
      }),
      container: new SchemaField({
        parentId: new StringField({ required: true, blank: true, initial: "" }),
        columns: new NumberField({ required: true, integer: true, min: 1, initial: 1 }),
        rows: new NumberField({ required: true, integer: true, min: 1, initial: 1 }),
        maxLoad: new NumberField({ required: true, min: 0, initial: 0 })
      }),
      craft: craftRecipeField()
    };
  }
}

export class AbilityDataModel extends BaseItemDataModel {
  static defineSchema() {
    return {
      ...super.defineSchema(),
      category: new StringField({ required: true, blank: true, initial: "" }),
      cost: new NumberField({ required: true, min: 0, initial: 0 }),
      formula: new StringField({ required: true, blank: true, initial: "" }),
      acquisition: new SchemaField({
        onlyFree: new BooleanField({ required: true, initial: false }),
        onlyManual: new BooleanField({ required: true, initial: false }),
        skillKey: new StringField({ required: true, blank: true, initial: "" }),
        difficulty: new NumberField({ required: true, integer: true, min: 0, initial: 60 })
      }),
      acquisitionRequirements: new ArrayField(abilityAcquisitionRequirementField(), { required: true, initial: [] }),
      functions: new ArrayField(abilityFunctionField(), { required: true, initial: [] })
    };
  }
}

function abilityFunctionField() {
  return new SchemaField({
    id: new StringField({ required: true, blank: true, initial: () => foundry.utils.randomID() }),
    type: new StringField({
      required: true,
      blank: false,
      choices: ["effectChanges", "activeApplication", "acquisitionChanges", "characteristicBonus", "skillBonus", "fixed"],
      initial: "effectChanges"
    }),
    fixedKey: new StringField({ required: true, blank: true, initial: "" }),
    fixedSettings: new ObjectField({ required: true, initial: {} }),
    activeSettings: new ObjectField({ required: true, initial: {} }),
    reactionSettings: new SchemaField({
      durationSeconds: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      costs: new ArrayField(new SchemaField({
        id: new StringField({ required: true, blank: true, initial: () => foundry.utils.randomID() }),
        resourceKey: new StringField({ required: true, blank: true, initial: "" }),
        formula: new StringField({ required: true, blank: true, initial: "0" }),
        overloadAmount: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
        overloadDurationSeconds: new NumberField({ required: true, integer: true, min: 0, initial: 0 })
      }), { required: true, initial: [] })
    }),
    changes: new ArrayField(abilityChangeField(), { required: true, initial: [] }),
    actions: new ArrayField(abilityActionField(), { required: true, initial: [] }),
    conditions: new ArrayField(abilityConditionField(), { required: true, initial: [] }),
    penalties: new ArrayField(abilityChangeField(), { required: true, initial: [] }),
    target: new StringField({ required: true, blank: true, initial: "" }),
    value: new NumberField({ required: true, initial: 0 }),
    condition: new SchemaField({
      enabled: new BooleanField({ required: true, initial: false }),
      resource: new StringField({ required: true, blank: false, choices: ["health"], initial: "health" }),
      operator: new StringField({ required: true, blank: false, choices: ["lte", "gte", "occupied", "empty"], initial: "lte" }),
      percent: new NumberField({ required: true, integer: true, min: 0, max: 100, initial: 50 }),
      equipmentSlotKey: new StringField({ required: true, blank: true, initial: "" })
    })
  });
}

function abilityActionField() {
  return new SchemaField({
    id: new StringField({ required: true, blank: true, initial: () => foundry.utils.randomID() }),
    type: new StringField({ required: true, blank: true, choices: ["", "weaponAttack"], initial: "weaponAttack" }),
    attackActionKeys: new ArrayField(new StringField({ required: true, blank: false }), { required: true, initial: ["all"] }),
    targetMode: new StringField({
      required: true,
      blank: false,
      choices: ["triggerActor", "triggerTarget", "free"],
      initial: "triggerActor"
    }),
    actionPointCostMode: new StringField({
      required: true,
      blank: false,
      choices: ["none", "fixed", "actual"],
      initial: "none"
    }),
    fixedActionPointCost: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
    actualActionPointCostPercent: new NumberField({ required: true, integer: true, min: 0, initial: 100 })
  });
}

function abilityChangeField() {
  return new SchemaField({
    id: new StringField({ required: true, blank: true, initial: () => foundry.utils.randomID() }),
    key: new StringField({ required: true, blank: true, initial: "" }),
    type: new StringField({
      required: true,
      blank: false,
      choices: ["add", "multiply", "override", "upgrade", "downgrade"],
      initial: "add"
    }),
    value: new StringField({ required: true, blank: true, initial: "0" }),
    phase: new StringField({ required: true, blank: false, initial: "initial" }),
    priority: new NumberField({ required: false, nullable: true, integer: true, initial: null })
  });
}

function abilityConditionField() {
  return new SchemaField({
    id: new StringField({ required: true, blank: true, initial: () => foundry.utils.randomID() }),
    groupId: new StringField({ required: true, blank: true, initial: "" }),
    type: new StringField({
      required: true,
      blank: true,
      choices: ["", "toggleable", "eventReaction", "triggerCost", "healthPercent", "equipmentSlotOccupied", "targetFaction", "targetRace", "targetType", "posture", "occupiedCover", "weaponAction", "weaponSkill", "weaponProficiency", "aura", "limitedChanges", "cooldown", "duration", "energyConsumption", "itemUse"],
      initial: ""
    }),
    costs: new ArrayField(new SchemaField({
      id: new StringField({ required: true, blank: true, initial: () => foundry.utils.randomID() }),
      resourceKey: new StringField({ required: true, blank: true, initial: "" }),
      formula: new StringField({ required: true, blank: true, initial: "0" }),
      overloadAmount: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      overloadDurationSeconds: new NumberField({ required: true, integer: true, min: 0, initial: 0 })
    }), { required: true, initial: [] }),
    eventKey: new StringField({ required: true, blank: true, initial: "" }),
    progressRequired: new NumberField({ required: true, min: 0.01, initial: 1 }),
    combatOnly: new BooleanField({ required: true, initial: false }),
    reactionMode: new StringField({
      required: true,
      blank: true,
      choices: ["", "standard", "isolatedAuto"],
      initial: ""
    }),
    autoApply: new BooleanField({ required: true, initial: false }),
    trackingTargets: new ArrayField(new StringField({
      required: true,
      blank: false,
      choices: ["owner", "ally", "enemy", "neutral"],
      initial: "owner"
    }), { required: true, initial: [] }),
    eventSubject: new StringField({
      required: true,
      blank: false,
      choices: ["reactor", "eventSource", "eventTarget"],
      initial: "reactor"
    }),
    name: new StringField({ required: true, blank: true, initial: "" }),
    cooldownSeconds: new NumberField({ required: false, nullable: true, integer: true, min: 0, initial: null }),
    amountPerHour: new NumberField({ required: true, min: 0, initial: 0 }),
    operator: new StringField({ required: true, blank: false, choices: ["lte", "gte", "occupied", "empty"], initial: "lte" }),
    percent: new NumberField({ required: true, integer: true, min: 0, max: 100, initial: 50 }),
    healthTarget: new StringField({
      required: true,
      blank: false,
      choices: ["general", "limb", "criticalLimb"],
      initial: "general"
    }),
    limbKey: new StringField({ required: true, blank: false, initial: "all" }),
    equipmentSlotKey: new StringField({ required: true, blank: true, initial: "" }),
    targetFactionNames: new ArrayField(new StringField({ required: true, blank: false, initial: "" }), {
      required: true,
      initial: []
    }),
    targetRaceId: new StringField({ required: true, blank: true, initial: "" }),
    targetTypeId: new StringField({ required: true, blank: true, initial: "" }),
    postureSubject: new StringField({ required: true, blank: false, choices: ["self", "target"], initial: "self" }),
    postureActions: new ArrayField(new StringField({
      required: true,
      blank: false,
      choices: ["walk", "crawl", "burrow", "knocked"],
      initial: "walk"
    }), { required: true, initial: [] }),
    coverKeys: new ArrayField(new StringField({ required: true, blank: false, initial: "" }), {
      required: true,
      initial: []
    }),
    weaponActionKeys: new ArrayField(new StringField({ required: true, blank: false, initial: "" }), {
      required: true,
      initial: []
    }),
    skillKeys: new ArrayField(new StringField({ required: true, blank: false, initial: "" }), {
      required: true,
      initial: []
    }),
    expectedResultKeys: new ArrayField(new StringField({
      required: true,
      blank: false,
      initial: "failure"
    }), {
      required: true,
      initial: []
    }),
    eventFilters: new ObjectField({ required: true, nullable: false, initial: {} }),
    proficiencyKeys: new ArrayField(new StringField({ required: true, blank: false, initial: "" }), {
      required: true,
      initial: []
    }),
    auraMode: new StringField({
      required: true,
      blank: false,
      choices: ["applyToTargets", "selfWhenPresent"],
      initial: "applyToTargets"
    }),
    auraTargetGroups: new ArrayField(new StringField({
      required: true,
      blank: false,
      choices: ["ally", "enemy", "neutral"],
      initial: "enemy"
    }), { required: true, initial: [] }),
    auraRadiusMeters: new StringField({ required: true, blank: true, initial: "0" }),
    auraWallsBlock: new BooleanField({ required: true, initial: true }),
    auraIncludeSelf: new BooleanField({ required: true, initial: true }),
    auraCombatOnly: new BooleanField({ required: true, initial: false }),
    auraCombatantsOnly: new BooleanField({ required: true, initial: false }),
    auraIgnoreIncapacitated: new BooleanField({ required: true, initial: true }),
    auraIgnoreHidden: new BooleanField({ required: true, initial: true }),
    limit: new NumberField({ required: true, integer: true, min: 1, initial: 1 }),
    limitFormula: new StringField({ required: true, blank: true, initial: "1" }),
    requiredCount: new StringField({ required: true, blank: true, initial: "1" }),
    itemCategories: new ArrayField(new StringField({ required: true, blank: false, initial: "" }), {
      required: true,
      initial: []
    }),
    durationSeconds: new NumberField({ required: true, integer: true, min: 0, initial: 0 })
  });
}

function abilityAcquisitionRequirementField() {
  return new SchemaField({
    id: new StringField({ required: true, blank: true, initial: () => foundry.utils.randomID() }),
    type: new StringField({
      required: true,
      blank: true,
      choices: ["", "race", "characteristic", "skill"],
      initial: ""
    }),
    raceId: new StringField({ required: true, blank: true, initial: "" }),
    characteristicKey: new StringField({ required: true, blank: true, initial: "" }),
    skillKey: new StringField({ required: true, blank: true, initial: "" }),
    value: new NumberField({ required: true, integer: true, min: 0, initial: 0 })
  });
}

function itemFreeSettingsFunctionField(options = {}) {
  return new SchemaField({
    enabled: new BooleanField({ required: true, initial: false }),
    useConditionWeakening: new BooleanField({ required: true, initial: false }),
    entries: new ArrayField(abilityFunctionField(), { required: true, initial: [] })
  }, options);
}

function actorContainerFunctionField(options = {}) {
  return new SchemaField({
    enabled: new BooleanField({ required: true, initial: false }),
    slots: new ArrayField(actorContainerSlotField(), { required: true, initial: [] })
  }, options);
}

function actorContainerSlotField() {
  return new SchemaField({
    id: new StringField({ required: true, blank: true, initial: () => foundry.utils.randomID() }),
    width: new NumberField({ required: true, integer: true, min: 1, initial: 1 }),
    height: new NumberField({ required: true, integer: true, min: 1, initial: 1 }),
    quantity: new NumberField({ required: true, integer: true, min: 0, initial: 1 })
  });
}

function containerFunctionField(options = {}) {
  return new SchemaField({
    enabled: new BooleanField({ required: true, initial: false }),
    loadReduction: new NumberField({ required: true, integer: true, min: 0, max: 100, initial: 0 }),
    extraWeaponSlots: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
    specialGrids: containerSpecialGridsField()
  }, options);
}

function containerSpecialGridsField() {
  return new SchemaField({
    blocks: new ArrayField(containerSpecialGridBlockField(), { required: true, initial: [] }),
    baseAnchor: new SchemaField({
      left: new NumberField({ required: false }),
      top: new NumberField({ required: false })
    }, { required: false, nullable: true }),
    viewport: new SchemaField({
      x: new NumberField({ required: true, integer: true, initial: 0 }),
      y: new NumberField({ required: true, integer: true, initial: 0 }),
      zoom: new NumberField({ required: true, min: 0.1, initial: 1 })
    })
  });
}

function containerSpecialGridBlockField() {
  return new SchemaField({
    id: new StringField({ required: true, blank: true, initial: () => foundry.utils.randomID() }),
    x: new NumberField({ required: true, initial: 0 }),
    y: new NumberField({ required: true, initial: 0 }),
    width: new NumberField({ required: true, integer: true, min: 1, initial: 1 }),
    height: new NumberField({ required: true, integer: true, min: 1, initial: 1 })
  });
}

function conditionFunctionField(options = {}) {
  return new SchemaField({
    enabled: new BooleanField({ required: true, initial: false }),
    value: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
    max: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
    weakeningThreshold: new NumberField({ required: true, integer: true, min: 1, initial: DEFAULT_CONDITION_WEAKENING_THRESHOLD }),
    recoveryMethods: new ArrayField(conditionRecoveryMethodField(), { required: true, initial: [] })
  }, options);
}

function conditionRecoveryMethodField() {
  return new SchemaField({
    type: new StringField({ required: true, blank: false, choices: ["tools"], initial: "tools" }),
    toolKey: new StringField({ required: true, blank: true, initial: "" }),
    toolClass: new StringField({ required: true, blank: false, choices: ["D", "C", "B", "A", "S"], initial: "D" }),
    difficulty: new NumberField({ required: true, integer: true, min: 0, initial: 0 })
  });
}

function damageSourceFunctionField(options = {}) {
  return new SchemaField({
    enabled: new BooleanField({ required: true, initial: false }),
    name: new StringField({ required: true, blank: true, initial: "" }),
    damage: new StringField({ required: true, blank: true, initial: "0" }),
    pellets: new StringField({ required: true, blank: true, initial: "1" }),
    damageTypeKey: new StringField({ required: true, blank: false, initial: "firearm" }),
    damageTypes: new ArrayField(weaponDamageTypeField(), { required: true, initial: [{ key: "firearm", percent: 100 }] }),
    attackAnimationKey: new StringField({ required: true, blank: true, initial: "" }),
    attackSoundPath: new StringField({ required: true, blank: true, initial: "" }),
    attackAnimationDelayMs: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
    accuracyBonus: new StringField({ required: true, blank: true, initial: "0" }),
    criticalChanceModifier: new StringField({ required: true, blank: true, initial: "0" }),
    criticalDamagePercent: new StringField({ required: true, blank: true, initial: "0" }),
    maxRangeMeters: new StringField({ required: true, blank: true, initial: "0" }),
    effectiveRange: new SchemaField({
      value: new StringField({ required: true, blank: true, initial: "0" }),
      max: new StringField({ required: true, blank: true, initial: "0" })
    }),
    penetration: new StringField({ required: true, blank: true, initial: "0" }),
    volley: damageSourceVolleyField()
  }, options);
}

function damageSourceVolleyField() {
  return new SchemaField({
    damageRadius: new StringField({ required: true, blank: true, initial: "0" }),
    regionRadius: new StringField({ required: true, blank: true, initial: "0" }),
    regionDamageEntries: new ArrayField(weaponDamageEntryField(), { required: true, initial: [] }),
    regionDurationSeconds: new StringField({ required: true, blank: true, initial: "0" }),
    regionDelaySeconds: new StringField({ required: true, blank: true, initial: "0" }),
    regionRadiusDeltaMeters: new StringField({ required: true, blank: true, initial: "0" }),
    explosionAnimationKey: new StringField({ required: true, blank: true, initial: "" }),
    explosionSoundPath: new StringField({ required: true, blank: true, initial: "" })
  });
}

function trapFunctionField(options = {}) {
  return new SchemaField({
    enabled: new BooleanField({ required: true, initial: false }),
    actionPointCost: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
    installation: new SchemaField({
      difficulty: new NumberField({ required: true, integer: true, min: 0, initial: 60 }),
      skillKey: new StringField({ required: true, blank: false, initial: "traps" })
    }),
    detection: new SchemaField({
      radiusMeters: new StringField({ required: true, blank: true, initial: "1" }),
      difficulty: new NumberField({ required: true, integer: true, min: 0, initial: 60 }),
      skillKey: new StringField({ required: true, blank: false, initial: "naturalist" }),
      conditions: new ArrayField(trapDetectionConditionField(), { required: true, initial: [] })
    }),
    trigger: new SchemaField({
      activationMode: new StringField({ required: true, blank: false, choices: ["enter", "exit", "linkedAction"], initial: "exit" }),
      widthCells: new NumberField({ required: true, integer: true, min: 1, initial: 1 }),
      heightCells: new NumberField({ required: true, integer: true, min: 1, initial: 1 }),
      imageScale: new NumberField({ required: true, min: 0, initial: 0.5 })
    }),
    recharge: new SchemaField({
      value: new NumberField({ required: false, nullable: true, integer: true, min: 0, initial: null }),
      unit: new StringField({ required: true, blank: false, choices: ["seconds", "minutes", "hours"], initial: "seconds" })
    }),
    evasion: new SchemaField({
      difficulty: new NumberField({ required: false, nullable: true, integer: true, min: 0, initial: null }),
      skillKey: new StringField({ required: true, blank: false, initial: "athletics" }),
      avoidPercent: new NumberField({ required: true, integer: true, min: 1, max: 100, initial: 50 })
    }),
    disarm: new SchemaField({
      toolKey: new StringField({ required: true, blank: true, initial: "mechanicalHacking" }),
      toolClass: new StringField({ required: true, blank: false, choices: ["D", "C", "B", "A", "S"], initial: "D" }),
      difficulty: new NumberField({ required: true, integer: true, min: 0, initial: 60 }),
      attempts: new NumberField({ required: true, integer: true, min: 0, initial: 1 })
    }),
    effect: new SchemaField({
      mode: new StringField({ required: true, blank: false, choices: ["explosion", "attack"], initial: "explosion" }),
      damageRadiusMeters: new StringField({ required: true, blank: true, initial: "0" }),
      penetration: new StringField({ required: true, blank: true, initial: "0" }),
      damage: new StringField({ required: true, blank: true, initial: "0" }),
      pellets: new StringField({ required: true, blank: true, initial: "1" }),
      damageTypeKey: new StringField({ required: true, blank: false, initial: "firearm" }),
      damageTypes: new ArrayField(weaponDamageTypeField(), { required: true, initial: [{ key: "firearm", percent: 100 }] }),
      regionRadius: new StringField({ required: true, blank: true, initial: "0" }),
      regionDamageEntries: new ArrayField(weaponDamageEntryField(), { required: true, initial: [] }),
      regionDurationSeconds: new StringField({ required: true, blank: true, initial: "0" }),
      regionDelaySeconds: new StringField({ required: true, blank: true, initial: "0" }),
      regionRadiusDeltaMeters: new StringField({ required: true, blank: true, initial: "0" })
    }),
    triggerAnimationKey: new StringField({ required: true, blank: true, initial: "" }),
    triggerSoundPath: new StringField({ required: true, blank: true, initial: "" })
  }, options);
}

function trapDetectionConditionField() {
  return new SchemaField({
    id: new StringField({ required: true, blank: false, initial: () => foundry.utils.randomID() }),
    type: new StringField({ required: true, blank: true, choices: ["", "lighting"], initial: "" }),
    thresholds: new ArrayField(new SchemaField({
      illuminationPercent: new NumberField({ required: true, integer: true, min: 0, max: 100, initial: 0 }),
      difficultyBonus: new NumberField({ required: true, integer: true, min: 0, initial: 0 })
    }), { required: true, initial: [] })
  });
}

function weaponFunctionField({ named = false, fieldOptions = {} } = {}) {
  const schema = {
    enabled: new BooleanField({ required: true, initial: false }),
    damageMode: new StringField({ required: true, blank: false, choices: ["manual", "source"], initial: "manual" }),
    damage: new StringField({ required: true, blank: true, initial: "0" }),
    pellets: new StringField({ required: true, blank: true, initial: "1" }),
    damageTypeKey: new StringField({ required: true, blank: false, initial: "firearm" }),
    damageTypes: new ArrayField(weaponDamageTypeField(), { required: true, initial: [{ key: "firearm", percent: 100 }] }),
    attackAnimationKey: new StringField({ required: true, blank: true, initial: "" }),
    attackSoundPath: new StringField({ required: true, blank: true, initial: "" }),
    attackAnimationDelayMs: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
    proficiencyKey: new StringField({ required: true, blank: true, initial: "pistol" }),
    skillKey: new StringField({ required: true, blank: false, initial: "rangedCombat" }),
    accuracyBonus: new StringField({ required: true, blank: true, initial: "0" }),
    criticalChanceModifier: new StringField({ required: true, blank: true, initial: "0" }),
    criticalDamagePercent: new StringField({ required: true, blank: true, initial: "150" }),
    attackConeDegrees: new NumberField({ required: true, min: 0, initial: DEFAULT_WEAPON_ATTACK_CONE_DEGREES }),
    maxRangeMeters: new StringField({ required: true, blank: true, initial: "0" }),
    effectiveRange: new SchemaField({
      value: new StringField({ required: true, blank: true, initial: "0" }),
      max: new StringField({ required: true, blank: true, initial: "0" })
    }),
    penetration: new StringField({ required: true, blank: true, initial: "0" }),
    magazine: new SchemaField({
      value: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      max: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      sourceItemUuid: new StringField({ required: true, blank: true, initial: "" }),
      sourceItemUuids: new ArrayField(new StringField({ required: true, blank: false, initial: "" }), { required: true, initial: [] })
    }),
    resourceCosts: new ArrayField(weaponResourceCostField(), { required: true, initial: [] }),
    moduleSlots: new ArrayField(weaponModuleSlotField(), { required: true, initial: [] }),
    specialProperties: new ArrayField(weaponSpecialPropertyField(), { required: true, initial: [] }),
    requirements: new ArrayField(weaponRequirementField(), { required: true, initial: [] }),
    availableActions: new SchemaField({
      aimedShot: new BooleanField({ required: true, initial: false }),
      snapshot: new BooleanField({ required: true, initial: false }),
      burst: new BooleanField({ required: true, initial: false }),
      volley: new BooleanField({ required: true, initial: false }),
      meleeAttack: new BooleanField({ required: true, initial: false }),
      aimedMeleeAttack: new BooleanField({ required: true, initial: false }),
      push: new BooleanField({ required: true, initial: false }),
      reload: new BooleanField({ required: true, initial: false })
    }),
    aimedShot: weaponActionSettingsField(),
    snapshot: weaponActionSettingsField(),
    burst: new SchemaField({
      name: new StringField({ required: true, blank: true, initial: "" }),
      actionPointCost: new NumberField({ required: true, integer: true, min: 0, initial: DEFAULT_WEAPON_ACTION_POINT_COST }),
      attackConeDegrees: new NumberField({ required: true, min: 0, initial: DEFAULT_WEAPON_ATTACK_CONE_DEGREES }),
      count: new NumberField({ required: true, integer: true, min: 1, initial: 3 }),
      difficultyPerShot: new NumberField({ required: true, integer: true, min: 0, initial: 10 }),
      criticalFailureConsequences: new ArrayField(weaponCriticalFailureConsequenceField(), { required: true, initial: [] })
    }),
    volley: new SchemaField({
      name: new StringField({ required: true, blank: true, initial: "" }),
      actionPointCost: new NumberField({ required: true, integer: true, min: 0, initial: DEFAULT_WEAPON_ACTION_POINT_COST }),
      damageRadius: new StringField({ required: true, blank: true, initial: "0" }),
      regionRadius: new StringField({ required: true, blank: true, initial: "0" }),
      regionDamageEntries: new ArrayField(weaponDamageEntryField(), { required: true, initial: [] }),
      regionDurationSeconds: new StringField({ required: true, blank: true, initial: "0" }),
      regionDelaySeconds: new StringField({ required: true, blank: true, initial: "0" }),
      regionRadiusDeltaMeters: new StringField({ required: true, blank: true, initial: "0" }),
      explosionAnimationKey: new StringField({ required: true, blank: true, initial: "" }),
      explosionSoundPath: new StringField({ required: true, blank: true, initial: "" }),
      criticalFailureConsequences: new ArrayField(weaponCriticalFailureConsequenceField(), { required: true, initial: [] })
    }),
    meleeAttack: weaponMeleeActionSettingsField(),
    aimedMeleeAttack: weaponMeleeActionSettingsField(),
    push: weaponPushActionSettingsField(),
    reload: weaponSimpleActionSettingsField(DEFAULT_RELOAD_ACTION_POINT_COST)
  };
  if (named) {
    schema.id = new StringField({ required: true, blank: true, initial: "" });
    schema.name = new StringField({ required: true, blank: true, initial: "" });
  }
  return new SchemaField(schema, fieldOptions);
}

function moduleFunctionField(options = {}) {
  return new SchemaField({
    enabled: new BooleanField({ required: true, initial: false }),
    name: new StringField({ required: true, blank: true, initial: "" }),
    targetFunction: new StringField({ required: true, blank: false, choices: ["weapon"], initial: "weapon" }),
    weapon: weaponModuleModifiersField(),
    additionalWeapons: new TypedObjectField(weaponFunctionField({ named: true }), { required: false })
  }, options);
}

function constructPartFunctionField(options = {}) {
  return new SchemaField({
    enabled: new BooleanField({ required: true, initial: false }),
    partType: new StringField({ required: true, blank: true, initial: "" }),
    aimedDifficultyPercent: new NumberField({ required: true, integer: true, initial: 0 }),
    aimedDifficultyBonus: new NumberField({ required: true, integer: true, initial: 0 }),
    critical: new BooleanField({ required: true, initial: false }),
    blockedPeriodicEffects: new ArrayField(new StringField({ required: true, blank: false, initial: "" }), {
      required: true,
      initial: () => []
    }),
    lossEffects: new ArrayField(limbLossEffectField(), { required: true, initial: [] }),
    weaponSets: new ArrayField(constructPartWeaponSetField(), { required: true, initial: [] }),
    needs: new ArrayField(needDefinitionField(), { required: true, initial: [] })
  }, options);
}

function energySourceFunctionField(options = {}) {
  return new SchemaField({
    enabled: new BooleanField({ required: true, initial: false }),
    name: new StringField({ required: true, blank: true, initial: "" }),
    class: new StringField({ required: true, blank: false, choices: ["D", "C", "B", "A", "S"], initial: "D" }),
    reserve: new SchemaField({
      value: new NumberField({ required: true, min: 0, initial: 0 }),
      max: new NumberField({ required: true, min: 0, initial: 0 })
    })
  }, options);
}

function energyConsumerFunctionField(options = {}) {
  return new SchemaField({
    enabled: new BooleanField({ required: true, initial: false }),
    sourceItemUuid: new StringField({ required: true, blank: true, initial: "" }),
    sourceItemUuids: new ArrayField(new StringField({ required: true, blank: false, initial: "" }), { required: true, initial: [] }),
    activeSourceUuid: new StringField({ required: true, blank: true, initial: "" }),
    activeConditions: new TypedObjectField(new BooleanField({ required: true, initial: false }), { required: true, initial: {} }),
    installedSource: installedEnergySourceField()
  }, options);
}

function lightSourceFunctionField(options = {}) {
  return new SchemaField({
    enabled: new BooleanField({ required: true, initial: false }),
    name: new StringField({ required: true, blank: true, initial: "" }),
    dim: new NumberField({ required: true, min: 0, initial: 0 }),
    bright: new NumberField({ required: true, min: 0, initial: 0 }),
    angle: new NumberField({ required: true, min: 0, initial: 360 }),
    rotation: new NumberField({ required: true, initial: 0 }),
    color: new StringField({ required: true, blank: true, initial: "" }),
    resourceCosts: new ArrayField(lightSourceResourceCostField(), { required: true, initial: [] })
  }, options);
}

function installedEnergySourceField() {
  return new SchemaField({
      sourceItemUuid: new StringField({ required: true, blank: true, initial: "" }),
      name: new StringField({ required: true, blank: true, initial: "" }),
      class: new StringField({ required: true, blank: true, initial: "" }),
      img: new StringField({ required: true, blank: true, initial: "" }),
      itemData: new ObjectField({ required: true, initial: {} }),
      reserve: new SchemaField({
        value: new NumberField({ required: true, min: 0, initial: 0 }),
        max: new NumberField({ required: true, min: 0, initial: 0 })
    })
  });
}

function limbLossEffectField() {
  return new SchemaField({
    key: new StringField({ required: true, blank: true, initial: "" }),
    type: new StringField({
      required: true,
      blank: false,
      choices: ["add", "multiply", "override"],
      initial: "add"
    }),
    value: new StringField({ required: true, blank: true, initial: "0" }),
    phase: new StringField({ required: true, blank: false, initial: "initial" }),
    priority: new NumberField({ required: false, nullable: true, integer: true, initial: null })
  });
}

function constructPartWeaponSetField() {
  return new SchemaField({
    id: new StringField({ required: true, blank: true, initial: () => foundry.utils.randomID() }),
    label: new StringField({ required: true, blank: true, initial: "" }),
    quantity: new NumberField({ required: true, integer: true, min: 0, initial: 1 })
  });
}

function implantFunctionField(options = {}) {
  return new SchemaField({
    enabled: new BooleanField({ required: true, initial: false }),
    limbKeys: new ArrayField(new StringField({ required: true, blank: false, initial: "" }), {
      required: true,
      initial: []
    }),
    difficulty: new NumberField({ required: true, integer: true, min: 0, initial: 60 }),
    skillKey: new StringField({ required: true, blank: false, initial: "doctor" })
  }, options);
}

function prosthesisFunctionField(options = {}) {
  return new SchemaField({
    enabled: new BooleanField({ required: true, initial: false }),
    limbKeys: new ArrayField(new StringField({ required: true, blank: false, initial: "" }), {
      required: true,
      initial: []
    }),
    blockedPeriodicEffects: new ArrayField(new StringField({ required: true, blank: false, initial: "" }), {
      required: true,
      initial: []
    }),
    integrationPercent: new NumberField({ required: true, integer: true, min: 0, max: 100, initial: 0 }),
    breakShockResistant: new BooleanField({ required: true, initial: false }),
    difficulty: new NumberField({ required: true, integer: true, min: 0, initial: 60 }),
    skillKey: new StringField({ required: true, blank: false, initial: "doctor" })
  }, options);
}

function weaponModuleModifiersField() {
  return new SchemaField({
    damage: new NumberField({ required: true, integer: true, initial: 0 }),
    accuracyBonus: new NumberField({ required: true, integer: true, initial: 0 }),
    criticalChanceModifier: new NumberField({ required: true, integer: true, initial: 0 }),
    criticalDamagePercent: new NumberField({ required: true, integer: true, initial: 0 }),
    attackConeDegrees: new NumberField({ required: true, initial: 0 }),
    maxRangeMeters: new NumberField({ required: true, initial: 0 }),
    effectiveRange: new SchemaField({
      value: new NumberField({ required: true, initial: 0 }),
      max: new NumberField({ required: true, initial: 0 })
    }),
    penetration: new NumberField({ required: true, integer: true, initial: 0 }),
    magazineMax: new NumberField({ required: true, integer: true, initial: 0 }),
    actionPointCosts: new SchemaField({
      aimedShot: new NumberField({ required: true, integer: true, initial: 0 }),
      snapshot: new NumberField({ required: true, integer: true, initial: 0 }),
      burst: new NumberField({ required: true, integer: true, initial: 0 }),
      volley: new NumberField({ required: true, integer: true, initial: 0 }),
      meleeAttack: new NumberField({ required: true, integer: true, initial: 0 }),
      aimedMeleeAttack: new NumberField({ required: true, integer: true, initial: 0 }),
      push: new NumberField({ required: true, integer: true, initial: 0 }),
      reload: new NumberField({ required: true, integer: true, initial: 0 })
    })
  });
}

function weaponSpecialPropertyField() {
  return new TypedSchemaField({
    [WEAPON_SPECIAL_PROPERTY_PENDING]: {},
    [WEAPON_SPECIAL_PROPERTY_HIT_ALL_CONE_TARGETS]: {},
    [WEAPON_SPECIAL_PROPERTY_ATTACK_POWER]: {
      attackPower: weaponAttackPowerField()
    }
  }, { required: true });
}

function weaponAttackPowerField() {
  return new SchemaField({
    level: new SchemaField({
      value: new NumberField({ required: true, integer: true, min: 1, initial: 1 }),
      max: new NumberField({ required: true, integer: true, min: 1, initial: 1 })
    }),
    perLevel: weaponAttackPowerPerLevelField(),
    resourceCosts: new ArrayField(weaponAttackPowerResourceCostField(), { required: true, initial: [] })
  });
}

function weaponAttackPowerPerLevelField() {
  return new SchemaField({
    damagePercent: new NumberField({ required: true, integer: true, initial: 0 }),
    accuracyBonus: new NumberField({ required: true, integer: true, initial: 0 }),
    criticalChanceModifier: new NumberField({ required: true, integer: true, initial: 0 }),
    criticalDamagePercent: new NumberField({ required: true, integer: true, initial: 0 }),
    attackConeDegrees: new NumberField({ required: true, initial: 0 }),
    maxRangeMeters: new NumberField({ required: true, initial: 0 }),
    effectiveRange: new SchemaField({
      value: new NumberField({ required: true, initial: 0 }),
      max: new NumberField({ required: true, initial: 0 })
    }),
    penetration: new NumberField({ required: true, integer: true, initial: 0 })
  });
}

function weaponAttackPowerResourceCostField() {
  return new SchemaField({
    type: new StringField({ required: true, blank: false, initial: "magazine" }),
    amount: new NumberField({ required: true, integer: true, initial: 0 })
  });
}

function weaponModuleSlotField() {
  return new SchemaField({
    id: new StringField({ required: true, blank: true, initial: "" }),
    moduleKey: new StringField({ required: true, blank: true, initial: "" }),
    itemUuid: new StringField({ required: true, blank: true, initial: "" }),
    itemData: new ObjectField({ required: true, initial: {} })
  });
}

function weaponDamageEntryField() {
  return new SchemaField({
    damageTypeKey: new StringField({ required: true, blank: true, initial: "firearm" }),
    amount: new StringField({ required: true, blank: true, initial: "0" })
  });
}

function weaponActionSettingsField() {
  return new SchemaField({
    name: new StringField({ required: true, blank: true, initial: "" }),
    actionPointCost: new NumberField({ required: true, integer: true, min: 0, initial: DEFAULT_WEAPON_ACTION_POINT_COST }),
    attackConeDegrees: new NumberField({ required: true, min: 0, initial: DEFAULT_WEAPON_ATTACK_CONE_DEGREES }),
    criticalFailureConsequences: new ArrayField(weaponCriticalFailureConsequenceField(), { required: true, initial: [] })
  });
}

function weaponSimpleActionSettingsField(actionPointCost = DEFAULT_WEAPON_ACTION_POINT_COST) {
  return new SchemaField({
    name: new StringField({ required: true, blank: true, initial: "" }),
    actionPointCost: new NumberField({ required: true, integer: true, min: 0, initial: actionPointCost })
  });
}

function weaponMeleeActionSettingsField() {
  return new SchemaField({
    name: new StringField({ required: true, blank: true, initial: "" }),
    actionPointCost: new NumberField({ required: true, integer: true, min: 0, initial: DEFAULT_WEAPON_ACTION_POINT_COST }),
    attackConeDegrees: new NumberField({ required: true, min: 0, initial: DEFAULT_WEAPON_ATTACK_CONE_DEGREES }),
    criticalFailureConsequences: new ArrayField(weaponCriticalFailureConsequenceField(), { required: true, initial: [] }),
    thrust: weaponAttackModeSettingsField(),
    swing: weaponAttackModeSettingsField()
  });
}

function weaponPushActionSettingsField() {
  return new SchemaField({
    name: new StringField({ required: true, blank: true, initial: "" }),
    actionPointCost: new NumberField({ required: true, integer: true, min: 0, initial: DEFAULT_WEAPON_ACTION_POINT_COST }),
    attackConeDegrees: new NumberField({ required: true, min: 0, initial: DEFAULT_WEAPON_ATTACK_CONE_DEGREES }),
    maxRangeMeters: new NumberField({ required: true, min: 0, initial: DEFAULT_WEAPON_PUSH_MAX_RANGE_METERS }),
    accuracyModifier: new NumberField({ required: true, integer: true, initial: 0 }),
    pushDifficultyModifier: new NumberField({ required: true, integer: true, initial: 0 }),
    criticalFailureConsequences: new ArrayField(weaponCriticalFailureConsequenceField(), { required: true, initial: [] })
  });
}

function weaponCriticalFailureConsequenceField() {
  return new SchemaField({
    type: new StringField({ required: true, blank: false, initial: "extraResourceCost" }),
    resourceType: new StringField({ required: true, blank: true, initial: "" }),
    amount: new NumberField({ required: true, integer: true, min: 0, initial: 0 })
  });
}

function weaponAttackModeSettingsField() {
  return new SchemaField({
    enabled: new BooleanField({ required: true, initial: true }),
    accuracyModifier: new NumberField({ required: true, integer: true, initial: 0 }),
    criticalChanceModifier: new NumberField({ required: true, integer: true, initial: 0 }),
    damagePercentModifier: new NumberField({ required: true, integer: true, initial: 0 })
  });
}

function weaponDamageTypeField() {
  return new SchemaField({
    key: new StringField({ required: true, blank: false, initial: "firearm" }),
    percent: new NumberField({ required: true, integer: true, min: 0, max: 100, initial: 100 })
  });
}

function craftRecipeField() {
  return new SchemaField({
    mode: new StringField({ required: true, blank: false, choices: ["craft", "disassembly"], initial: "craft" }),
    nodes: new ArrayField(craftNodeField(), { required: true, initial: [] }),
    links: new ArrayField(craftLinkField(), { required: true, initial: [] }),
    viewport: craftViewportField(),
    disassembly: craftRecipeLayoutField(),
    recipes: new ArrayField(craftRecipeVariantField(), { required: true, initial: [] })
  });
}

function craftRecipeVariantField() {
  return new SchemaField({
    id: new StringField({ required: true, blank: false, initial: () => foundry.utils.randomID() }),
    name: new StringField({ required: true, blank: false, initial: "Рецепт_1" }),
    nodes: new ArrayField(craftNodeField(), { required: true, initial: [] }),
    links: new ArrayField(craftLinkField(), { required: true, initial: [] }),
    viewport: craftViewportField(),
    disassembly: craftRecipeLayoutField()
  });
}

function craftRecipeLayoutField() {
  return new SchemaField({
    nodes: new ArrayField(craftNodeField(), { required: true, initial: [] }),
    links: new ArrayField(craftLinkField(), { required: true, initial: [] }),
    viewport: craftViewportField()
  });
}

function craftViewportField() {
  return new SchemaField({
    x: new NumberField({ required: true, initial: 0 }),
    y: new NumberField({ required: true, initial: 0 }),
    zoom: new NumberField({ required: true, min: 0.1, initial: 1 })
  });
}

function craftNodeField() {
  return new SchemaField({
    id: new StringField({ required: true, blank: false, initial: () => foundry.utils.randomID() }),
    itemUuid: new StringField({ required: true, blank: true, initial: "" }),
    name: new StringField({ required: true, blank: true, initial: "" }),
    img: new StringField({ required: true, blank: true, initial: "" }),
    type: new StringField({ required: true, blank: true, initial: "" }),
    x: new NumberField({ required: true, initial: 0 }),
    y: new NumberField({ required: true, initial: 0 }),
    width: new NumberField({ required: true, integer: true, min: 1, initial: 1 }),
    height: new NumberField({ required: true, integer: true, min: 1, initial: 1 }),
    quantity: new NumberField({ required: true, integer: true, min: 1, initial: 1 }),
    blockId: new StringField({ required: true, blank: true, initial: "" }),
    blockLimit: new NumberField({ required: false, nullable: true, integer: true, min: 0, initial: null }),
    root: new BooleanField({ required: true, initial: false })
  });
}

function craftLinkField() {
  return new SchemaField({
    id: new StringField({ required: true, blank: false, initial: () => foundry.utils.randomID() }),
    fromNodeId: new StringField({ required: true, blank: false, initial: "" }),
    toNodeId: new StringField({ required: true, blank: false, initial: "" }),
    skillKey: new StringField({ required: true, blank: true, initial: "repair" }),
    difficulty: new NumberField({ required: true, integer: true, min: 0, initial: 60 }),
    noCheck: new BooleanField({ required: true, initial: false }),
    failureResult: new BooleanField({ required: true, initial: false }),
    bendX: new NumberField({ required: false, nullable: true, initial: null }),
    bendY: new NumberField({ required: false, nullable: true, initial: null }),
    fromAnchorSide: new StringField({ required: true, blank: true, initial: "" }),
    fromAnchorOffset: new NumberField({ required: false, nullable: true, initial: null }),
    toAnchorSide: new StringField({ required: true, blank: true, initial: "" }),
    toAnchorOffset: new NumberField({ required: false, nullable: true, initial: null })
  });
}

function weaponResourceCostField() {
  return new SchemaField({
    type: new StringField({ required: true, blank: false, initial: "magazine" }),
    amount: new NumberField({ required: true, integer: true, min: 0, initial: 0 })
  });
}

function lightSourceResourceCostField() {
  return new SchemaField({
    type: new StringField({ required: true, blank: false, choices: ["condition", "energyConsumer"], initial: "energyConsumer" }),
    amountPerHour: new NumberField({ required: true, min: 0, initial: 0 })
  });
}

function weaponRequirementField() {
  return new SchemaField({
    type: new StringField({ required: true, blank: false, choices: ["characteristic", "skill"], initial: "characteristic" }),
    key: new StringField({ required: true, blank: true, initial: "" }),
    value: new NumberField({ required: true, integer: true, min: 0, initial: 0 })
  });
}

function toolFunctionField(options = {}) {
  return new SchemaField({
    enabled: new BooleanField({ required: true, initial: false }),
    useAsItem: new BooleanField({ required: true, initial: false }),
    toolClass: new StringField({ required: true, blank: false, choices: ["D", "C", "B", "A", "S"], initial: "D" }),
    supply: new SchemaField({
      value: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      max: new NumberField({ required: true, integer: true, min: 0, initial: 0 })
    }),
    skillValue: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
    skillKey: new StringField({ required: true, blank: true, initial: "" })
  }, options);
}

function firstAidFunctionField(options = {}) {
  return new SchemaField({
    enabled: new BooleanField({ required: true, initial: false }),
    healing: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
    healingIsPercentage: new BooleanField({ required: true, initial: false }),
    durationSeconds: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
    intervalSeconds: new NumberField({ required: true, integer: true, min: 1, initial: 6 }),
    actionPointCost: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
    maxDistance: new NumberField({ required: true, min: 0, initial: 0 }),
    difficulty: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
    criticalSuccessHealingBonus: new NumberField({ required: true, integer: true, min: 0, initial: 20 }),
    criticalFailureDamageMin: new NumberField({ required: true, integer: true, min: 0, initial: 1 }),
    criticalFailureDamageMax: new NumberField({ required: true, integer: true, min: 0, initial: 10 }),
    charges: new SchemaField({
      value: new NumberField({ required: true, integer: true, min: 0, initial: 1 }),
      max: new NumberField({ required: true, integer: true, min: 1, initial: 1 })
    }),
    needs: new ArrayField(new SchemaField({
      needKey: new StringField({ required: true, blank: true, initial: "" }),
      value: new NumberField({ required: true, integer: true, initial: 0 })
    }), { required: true, initial: [] }),
    limbSelection: new SchemaField({
      count: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      value: new NumberField({ required: true, integer: true, initial: 0 })
    }),
    removeEffects: new ArrayField(new SchemaField({
      damageTypeKey: new StringField({ required: true, blank: true, initial: "" })
    }), { required: true, initial: [] }),
    changes: new ArrayField(traumaEffectField(), { required: true, initial: [] }),
    withdrawalDurationSeconds: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
    withdrawalIntervalSeconds: new NumberField({ required: true, integer: true, min: 1, initial: 6 }),
    withdrawal: new ArrayField(traumaEffectField(), { required: true, initial: [] })
  }, options);
}

function needChangeFunctionField(options = {}) {
  return new SchemaField({
    enabled: new BooleanField({ required: true, initial: false }),
    charges: new SchemaField({
      value: new NumberField({ required: true, integer: true, min: 0, initial: 1 }),
      max: new NumberField({ required: true, integer: true, min: 1, initial: 1 })
    }),
    needs: new ArrayField(needChangeEntryField(), { required: true, initial: [] }),
    damages: new ArrayField(needChangeDamageEntryField(), { required: true, initial: [] }),
    organismDevelopment: new ArrayField(needChangeOrganismDevelopmentEntryField(), { required: true, initial: [] }),
    healthRecovery: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
    durationSeconds: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
    intervalSeconds: new NumberField({ required: true, integer: true, min: 1, initial: 6 }),
    changes: new ArrayField(traumaEffectField(), { required: true, initial: [] })
  }, options);
}

function needChangeOrganismDevelopmentEntryField() {
  return new SchemaField({
    characteristicKey: new StringField({ required: true, blank: true, initial: "" }),
    value: new NumberField({ required: true, initial: 0 })
  });
}

function needChangeDamageEntryField() {
  return new SchemaField({
    damageTypeKey: new StringField({ required: true, blank: true, initial: "" }),
    value: new NumberField({ required: true, integer: true, min: 0, initial: 0 })
  });
}

function oneTimeUseFunctionField(options = {}) {
  return new SchemaField({
    enabled: new BooleanField({ required: true, initial: false }),
    repeatApplicationBlocked: new BooleanField({ required: true, initial: false }),
    changes: new ArrayField(abilityChangeField(), { required: true, initial: [] }),
    recipeItemUuids: new ArrayField(new StringField({ required: true, blank: false, initial: "" }), { required: true, initial: [] })
  }, options);
}

function needChangeEntryField() {
  return new SchemaField({
    needKey: new StringField({ required: true, blank: true, initial: "" }),
    value: new NumberField({ required: true, integer: true, initial: 0 })
  });
}

function needDefinitionField() {
  return new SchemaField({
    key: new StringField({ required: true, blank: true, initial: "" }),
    abbr: new StringField({ required: true, blank: true, initial: "" }),
    label: new StringField({ required: true, blank: true, initial: "" }),
    color: new StringField({ required: true, blank: true, initial: "#8f8456" }),
    formula: new StringField({ required: true, blank: true, initial: "0" }),
    settings: new ObjectField({ required: true, initial: {} })
  });
}

export class TraumaDataModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      description: new HTMLField({ required: false, blank: true, initial: "" }),
      limbSetId: new StringField({ required: true, blank: true, initial: "" }),
      limbKey: new StringField({ required: true, blank: true, initial: "" }),
      limbLabel: new StringField({ required: true, blank: true, initial: "" }),
      stageId: new StringField({ required: true, blank: true, initial: "" }),
      damageTypeKey: new StringField({ required: true, blank: true, initial: "" }),
      damageTypeLabel: new StringField({ required: true, blank: true, initial: "" }),
      thresholdPercent: new NumberField({ required: true, integer: true, min: 0, max: 100, initial: 0 }),
      thresholdValue: new NumberField({ required: true, integer: true, initial: 0 }),
      triggeredAtValue: new NumberField({ required: true, integer: true, initial: 0 }),
      healingDifficulty: new NumberField({ required: true, integer: true, min: 0, initial: 60 }),
      healingToolClass: new StringField({ required: true, blank: false, choices: ["D", "C", "B", "A", "S"], initial: "D" }),
      healingProgress: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      healingProgressMax: new NumberField({ required: true, integer: true, min: 0, initial: 100 }),
      healingSkillKey: new StringField({ required: true, blank: false, initial: "doctor" }),
      damageSnapshot: new TypedObjectField(new NumberField({ required: true, min: 0, initial: 0 }), {
        required: true,
        initial: {}
      }),
      sources: new ArrayField(traumaSourceField(), { required: true, initial: [] }),
      generated: new BooleanField({ required: true, initial: true }),
      effects: new ArrayField(traumaEffectField(), { required: true, initial: [] })
    };
  }
}

export class DiseaseDataModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      description: new HTMLField({ required: false, blank: true, initial: "" }),
      needKey: new StringField({ required: true, blank: true, initial: "" }),
      needLabel: new StringField({ required: true, blank: true, initial: "" }),
      diseaseId: new StringField({ required: true, blank: true, initial: "" }),
      stageId: new StringField({ required: true, blank: true, initial: "" }),
      level: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      thresholdPercent: new NumberField({ required: true, integer: true, min: 0, max: 100, initial: 0 }),
      worseningProgress: new NumberField({ required: true, min: 0, initial: 0 }),
      worseningProgressMax: new NumberField({ required: true, integer: true, min: 1, initial: 100 }),
      worseningBaseSeconds: new NumberField({ required: true, integer: true, min: 1, initial: 86400 }),
      lastWorseningTime: new NumberField({ required: true, min: 0, initial: 0 }),
      worseningMultiplier: new NumberField({ required: true, min: 1, initial: 1 }),
      healingDifficulty: new NumberField({ required: true, integer: true, min: 0, initial: 60 }),
      healingToolClass: new StringField({ required: true, blank: false, choices: ["D", "C", "B", "A", "S"], initial: "D" }),
      healingProgress: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      healingProgressMax: new NumberField({ required: true, integer: true, min: 0, initial: 100 }),
      healingSkillKey: new StringField({ required: true, blank: false, initial: "doctor" }),
      generated: new BooleanField({ required: true, initial: true }),
      effects: new ArrayField(traumaEffectField(), { required: true, initial: [] })
    };
  }
}

function damageMitigationEntryField() {
  return new SchemaField({
    value: new NumberField({ required: true, integer: true, initial: 0 })
  });
}

function traumaEffectField() {
  return new SchemaField({
    key: new StringField({ required: true, blank: true, initial: "" }),
    type: new StringField({ required: true, blank: false, initial: "add" }),
    value: new StringField({ required: true, blank: true, initial: "0" }),
    phase: new StringField({ required: true, blank: false, initial: "initial" }),
    priority: new NumberField({ required: false, nullable: true, integer: true, initial: null })
  });
}

function traumaSourceField() {
  return new SchemaField({
    limbKey: new StringField({ required: true, blank: true, initial: "" }),
    limbLabel: new StringField({ required: true, blank: true, initial: "" }),
    damageTypeKey: new StringField({ required: true, blank: true, initial: "" }),
    damageTypeLabel: new StringField({ required: true, blank: true, initial: "" }),
    thresholdPercent: new NumberField({ required: true, integer: true, min: 0, max: 100, initial: 0 })
  });
}
