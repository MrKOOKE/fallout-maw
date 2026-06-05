const { ArrayField, BooleanField, HTMLField, NumberField, ObjectField, SchemaField, StringField, TypedObjectField } = foundry.data.fields;
const DEFAULT_WEAPON_ATTACK_CONE_DEGREES = 3;
const DEFAULT_WEAPON_ACTION_POINT_COST = 5;
const DEFAULT_WEAPON_PUSH_MAX_RANGE_METERS = 1;
const DEFAULT_RELOAD_ACTION_POINT_COST = 2;
const DEFAULT_CONDITION_WEAKENING_THRESHOLD = 20;
const WEAPON_SPECIAL_PROPERTIES = Object.freeze({
  hitAllConeTargets: "hitAllConeTargets"
});

export class BaseItemDataModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      description: new HTMLField({ required: false, blank: true, initial: "" }),
      quantity: new NumberField({ required: true, integer: true, min: 0, initial: 1 }),
      maxStack: new NumberField({ required: true, integer: true, min: 1, initial: 1 }),
      itemCategory: new StringField({ required: true, blank: true, initial: "" }),
      weight: new NumberField({ required: true, min: 0, initial: 0 }),
      price: new NumberField({ required: true, min: 0, initial: 0 }),
      priceCurrency: new StringField({ required: true, blank: true, initial: "" }),
      equipped: new BooleanField({ required: true, initial: false }),
      container: new SchemaField({
        parentId: new StringField({ required: true, blank: true, initial: "" })
      }),
      occupiedSlots: new TypedObjectField(new BooleanField({ required: true, initial: false }), {
        required: true,
        initial: {}
      }),
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
        height: new NumberField({ required: true, integer: true, min: 1, initial: 1 })
      })
    };
  }
}

export class GearDataModel extends BaseItemDataModel {
  static defineSchema() {
    return {
      ...super.defineSchema(),
      itemFunction: new StringField({ required: true, blank: true, initial: "" }),
      functions: new SchemaField({
        container: containerFunctionField(),
        condition: conditionFunctionField(),
        constructPart: constructPartFunctionField(),
        damageSource: damageSourceFunctionField(),
        freeSettings: itemFreeSettingsFunctionField(),
        module: moduleFunctionField(),
        prosthesis: prosthesisFunctionField(),
        weapon: weaponFunctionField(),
        additionalWeapons: new TypedObjectField(weaponFunctionField({ named: true }), { required: true, initial: {} }),
        damageMitigation: new SchemaField({
          enabled: new BooleanField({ required: true, initial: false }),
          mode: new StringField({ required: true, blank: false, choices: ["defense", "resistance"], initial: "defense" }),
          limbSetIds: new ArrayField(new StringField({ required: true, blank: false, initial: "" }), { required: true, initial: [] }),
          entries: new TypedObjectField(
            new TypedObjectField(damageMitigationEntryField(), { required: true, initial: {} }),
            { required: true, initial: {} }
          )
        }),
        firstAid: firstAidFunctionField(),
        tools: new TypedObjectField(toolFunctionField(), { required: true, initial: {} })
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
      choices: ["effectChanges", "acquisitionChanges", "characteristicBonus", "skillBonus"],
      initial: "effectChanges"
    }),
    changes: new ArrayField(abilityChangeField(), { required: true, initial: [] }),
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
      choices: ["", "healthPercent", "equipmentSlotOccupied", "limitedChanges", "cooldown"],
      initial: ""
    }),
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
    limit: new NumberField({ required: true, integer: true, min: 1, initial: 1 }),
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

function itemFreeSettingsFunctionField() {
  return new SchemaField({
    enabled: new BooleanField({ required: true, initial: false }),
    entries: new ArrayField(abilityFunctionField(), { required: true, initial: [] })
  });
}

function containerFunctionField() {
  return new SchemaField({
    enabled: new BooleanField({ required: true, initial: false }),
    loadReduction: new NumberField({ required: true, integer: true, min: 0, max: 100, initial: 0 }),
    extraWeaponSlots: new NumberField({ required: true, integer: true, min: 0, initial: 0 })
  });
}

function conditionFunctionField() {
  return new SchemaField({
    enabled: new BooleanField({ required: true, initial: false }),
    value: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
    max: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
    weakeningThreshold: new NumberField({ required: true, integer: true, min: 1, initial: DEFAULT_CONDITION_WEAKENING_THRESHOLD }),
    recoveryMethods: new ArrayField(conditionRecoveryMethodField(), { required: true, initial: [] })
  });
}

function conditionRecoveryMethodField() {
  return new SchemaField({
    type: new StringField({ required: true, blank: false, choices: ["tools"], initial: "tools" }),
    toolKey: new StringField({ required: true, blank: true, initial: "" }),
    toolClass: new StringField({ required: true, blank: false, choices: ["D", "C", "B", "A", "S"], initial: "D" }),
    difficulty: new NumberField({ required: true, integer: true, min: 0, initial: 0 })
  });
}

function damageSourceFunctionField() {
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
  });
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

function weaponFunctionField({ named = false } = {}) {
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
    specialProperties: new ArrayField(new StringField({
      required: true,
      blank: false,
      choices: Object.values(WEAPON_SPECIAL_PROPERTIES),
      initial: WEAPON_SPECIAL_PROPERTIES.hitAllConeTargets
    }), { required: true, initial: [] }),
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
  return new SchemaField(schema);
}

function moduleFunctionField() {
  return new SchemaField({
    enabled: new BooleanField({ required: true, initial: false }),
    name: new StringField({ required: true, blank: true, initial: "" }),
    targetFunction: new StringField({ required: true, blank: false, choices: ["weapon"], initial: "weapon" }),
    weapon: weaponModuleModifiersField(),
    additionalWeapons: new TypedObjectField(weaponFunctionField({ named: true }), { required: true, initial: {} })
  });
}

function constructPartFunctionField() {
  return new SchemaField({
    enabled: new BooleanField({ required: true, initial: false }),
    partType: new StringField({ required: true, blank: true, initial: "" }),
    critical: new BooleanField({ required: true, initial: false }),
    lossEffects: new ArrayField(limbLossEffectField(), { required: true, initial: [] }),
    weaponSets: new ArrayField(constructPartWeaponSetField(), { required: true, initial: [] })
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

function prosthesisFunctionField() {
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
  });
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

function weaponRequirementField() {
  return new SchemaField({
    type: new StringField({ required: true, blank: false, choices: ["characteristic", "skill"], initial: "characteristic" }),
    key: new StringField({ required: true, blank: true, initial: "" }),
    value: new NumberField({ required: true, integer: true, min: 0, initial: 0 })
  });
}

function toolFunctionField() {
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
  });
}

function firstAidFunctionField() {
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
    changes: new ArrayField(traumaEffectField(), { required: true, initial: [] })
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
