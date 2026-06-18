import { createDefaultSkillSettings, normalizeSkillSettings } from "../formulas/index.mjs";
import { toInteger } from "../utils/numbers.mjs";

export const LOCKED_FEATURES_CATEGORY_ID = "features";
export const GENERAL_ABILITY_CATEGORY_ID = "general";
export const ABILITY_SOURCE_FLAG = "abilitySource";

export const ABILITY_FUNCTION_TYPES = Object.freeze({
  effectChanges: "effectChanges",
  acquisitionChanges: "acquisitionChanges",
  characteristicBonus: "characteristicBonus",
  skillBonus: "skillBonus",
  fixed: "fixed"
});

export const ABILITY_FIXED_FUNCTION_KEYS = Object.freeze({
  deusExMachina: "deusExMachina",
  curseAndBlessing: "curseAndBlessing",
  allOrNothing: "allOrNothing",
  reaper: "reaper",
  virtuoso: "virtuoso",
  fourLeafClover: "fourLeafClover",
  atRandom: "atRandom",
  lastChance: "lastChance",
  luckyCoin: "luckyCoin",
  disarm: "disarm",
  defensiveTactics: "defensiveTactics",
  rage: "rage",
  whirlwind: "whirlwind",
  lunge: "lunge",
  doubleAttack: "doubleAttack",
  counterAttack: "counterAttack",
  whereAreYouGoing: "whereAreYouGoing",
  fullForce: "fullForce"
});

export const ABILITY_CONDITION_TYPES = Object.freeze({
  healthPercent: "healthPercent",
  equipmentSlotOccupied: "equipmentSlotOccupied",
  targetFaction: "targetFaction",
  targetRace: "targetRace",
  targetType: "targetType",
  posture: "posture",
  occupiedCover: "occupiedCover",
  weaponAction: "weaponAction",
  weaponSkill: "weaponSkill",
  weaponProficiency: "weaponProficiency",
  aura: "aura",
  limitedChanges: "limitedChanges",
  cooldown: "cooldown",
  itemUse: "itemUse"
});

export const ABILITY_AURA_MODES = Object.freeze({
  applyToTargets: "applyToTargets",
  selfWhenPresent: "selfWhenPresent"
});

export const ABILITY_AURA_TARGET_GROUPS = Object.freeze(["ally", "enemy", "neutral"]);

export const ABILITY_POSTURE_SUBJECTS = Object.freeze({
  self: "self",
  target: "target"
});

export const ABILITY_POSTURE_ACTIONS = Object.freeze(["walk", "crawl", "burrow", "knocked"]);

export const ABILITY_HEALTH_TARGETS = Object.freeze({
  general: "general",
  limb: "limb",
  criticalLimb: "criticalLimb"
});

export const ABILITY_HEALTH_LIMB_ALL = "all";

export const ABILITY_ACQUISITION_CONDITION_TYPES = Object.freeze({
  race: "race",
  characteristic: "characteristic",
  skill: "skill"
});

export const ABILITY_EQUIPMENT_OPERATORS = Object.freeze({
  occupied: "occupied",
  empty: "empty"
});

export const ABILITY_CHANGE_TYPES = Object.freeze({
  add: "add",
  multiply: "multiply",
  override: "override",
  upgrade: "upgrade",
  downgrade: "downgrade"
});

export function createDefaultAbilityCatalog(skillSettings = createDefaultSkillSettings()) {
  const skills = normalizeSkillSettings(skillSettings);
  return {
    categories: [
      createAbilityCategory({
        id: LOCKED_FEATURES_CATEGORY_ID,
        name: "Особенности",
        locked: true
      }),
      createAbilityCategory({
        id: GENERAL_ABILITY_CATEGORY_ID,
        name: "Общая категория"
      }),
      ...skills.map(skill => createAbilityCategory({
        id: `skill-${skill.key}`,
        name: skill.label || skill.key
      }))
    ]
  };
}

export function normalizeAbilityCatalog(value = {}, skillSettings = createDefaultSkillSettings()) {
  const sourceCategories = Array.isArray(value?.categories) ? value.categories : [];
  const categories = sourceCategories.map((category, index) => normalizeAbilityCategory(category, index));
  const hasFeatures = categories.some(category => category.id === LOCKED_FEATURES_CATEGORY_ID);
  const normalized = hasFeatures ? categories : [
    createAbilityCategory({
      id: LOCKED_FEATURES_CATEGORY_ID,
      name: "Особенности",
      locked: true
    }),
    ...categories
  ];

  if (!normalized.length || (normalized.length === 1 && normalized[0].id === LOCKED_FEATURES_CATEGORY_ID && !sourceCategories.length)) {
    return createDefaultAbilityCatalog(skillSettings);
  }

  return {
    categories: normalized.map(category => category.id === LOCKED_FEATURES_CATEGORY_ID
      ? { ...category, name: "Особенности", locked: true }
      : { ...category, locked: false })
  };
}

export function normalizeAbilityEntry(value = {}, index = 0) {
  const id = String(value?.id ?? "").trim() || foundry.utils.randomID();
  const system = value?.system ?? {};
  return {
    id,
    name: String(value?.name ?? "").trim() || `Новая способность ${index + 1}`,
    img: String(value?.img ?? "").trim() || "icons/svg/aura.svg",
    visible: value?.visible !== false,
    description: String(value?.description ?? system.description ?? "").trim(),
    system: {
      cost: Math.max(0, toInteger(system.cost ?? value?.cost)),
      formula: String(system.formula ?? value?.formula ?? "").trim(),
      acquisition: normalizeAbilityAcquisition(system.acquisition ?? value?.acquisition),
      acquisitionRequirements: normalizeAbilityAcquisitionConditions(system.acquisitionRequirements ?? value?.acquisitionRequirements),
      functions: normalizeAbilityFunctions(system.functions ?? value?.functions)
    }
  };
}

export function normalizeAbilityFunctions(value = []) {
  return (Array.isArray(value) ? value : Object.values(value ?? {}))
    .map((entry, index) => normalizeAbilityFunction(entry, index));
}

export function createAbilityFunction(type = ABILITY_FUNCTION_TYPES.effectChanges, options = {}) {
  return normalizeAbilityFunction({
    id: foundry.utils.randomID(),
    type,
    fixedKey: options?.fixedKey,
    fixedSettings: options?.fixedSettings,
    changes: [],
    conditions: [],
    penalties: []
  });
}

export function createAbilityChange() {
  return normalizeAbilityChange({
    id: foundry.utils.randomID(),
    key: "",
    type: ABILITY_CHANGE_TYPES.add,
    value: "0",
    phase: "initial",
    priority: null
  });
}

export function createAbilityCondition(type = ABILITY_CONDITION_TYPES.healthPercent) {
  const data = typeof type === "object" && type !== null ? type : { type };
  return normalizeAbilityCondition({
    id: foundry.utils.randomID(),
    groupId: "",
    ...data
  });
}

export function createAbilityAcquisitionCondition(type = "") {
  const data = typeof type === "object" && type !== null ? type : { type };
  return normalizeAbilityAcquisitionCondition({
    id: foundry.utils.randomID(),
    ...data
  });
}

export function prepareAbilityItemData(ability = {}, { categoryId = "" } = {}) {
  const normalized = normalizeAbilityEntry(ability);
  return {
    name: normalized.name,
    type: "ability",
    img: normalized.img || "icons/svg/aura.svg",
    system: {
      description: normalized.description,
      cost: normalized.system.cost,
      formula: normalized.system.formula,
      acquisition: foundry.utils.deepClone(normalized.system.acquisition),
      acquisitionRequirements: foundry.utils.deepClone(normalized.system.acquisitionRequirements),
      functions: foundry.utils.deepClone(normalized.system.functions)
    },
    flags: {
      "fallout-maw": {
        [ABILITY_SOURCE_FLAG]: {
          id: normalized.id,
          categoryId
        }
      }
    }
  };
}

export function getAbilitySourceId(item) {
  return String(item?.getFlag?.("fallout-maw", ABILITY_SOURCE_FLAG)?.id ?? item?.flags?.["fallout-maw"]?.[ABILITY_SOURCE_FLAG]?.id ?? "");
}

export function getAbilitySourceCategoryId(item) {
  return String(item?.getFlag?.("fallout-maw", ABILITY_SOURCE_FLAG)?.categoryId ?? item?.flags?.["fallout-maw"]?.[ABILITY_SOURCE_FLAG]?.categoryId ?? "");
}

function createAbilityCategory({ id = "", name = "", locked = false, abilities = [] } = {}) {
  return {
    id: String(id || foundry.utils.randomID()),
    name: String(name || "Новая категория"),
    locked: Boolean(locked),
    abilities: (Array.isArray(abilities) ? abilities : []).map(normalizeAbilityEntry)
  };
}

function normalizeAbilityCategory(value = {}, index = 0) {
  return createAbilityCategory({
    id: String(value?.id ?? "").trim() || `category-${index + 1}`,
    name: String(value?.name ?? "").trim() || `Категория ${index + 1}`,
    locked: Boolean(value?.locked),
    abilities: value?.abilities
  });
}

function normalizeAbilityAcquisition(value = {}) {
  const onlyFree = Boolean(value?.onlyFree);
  const onlyManual = onlyFree ? false : Boolean(value?.onlyManual);
  return {
    onlyFree,
    onlyManual,
    skillKey: String(value?.skillKey ?? "").trim(),
    difficulty: Math.max(0, toInteger(value?.difficulty ?? 60))
  };
}

function normalizeAbilityFunction(value = {}, index = 0) {
  const rawType = String(value?.type ?? "").trim();
  const isLegacy = [ABILITY_FUNCTION_TYPES.characteristicBonus, ABILITY_FUNCTION_TYPES.skillBonus].includes(rawType);
  const type = Object.values(ABILITY_FUNCTION_TYPES).includes(rawType) && !isLegacy
    ? rawType
    : ABILITY_FUNCTION_TYPES.effectChanges;
  const conditions = normalizeAbilityConditions(value?.conditions ?? (value?.condition ? [value.condition] : []));
  return {
    id: String(value?.id ?? "").trim() || foundry.utils.randomID(),
    type,
    fixedKey: type === ABILITY_FUNCTION_TYPES.fixed ? normalizeFixedFunctionKey(value?.fixedKey) : "",
    fixedSettings: type === ABILITY_FUNCTION_TYPES.fixed
      ? normalizeFixedFunctionSettings(value?.fixedKey, value?.fixedSettings ?? value?.settings)
      : {},
    changes: isLegacy
      ? legacyFunctionToChanges(value)
      : normalizeAbilityChanges(value?.changes ?? value?.effects),
    conditions,
    penalties: normalizeAbilityChanges(value?.penalties),
    sort: index
  };
}

function legacyFunctionToChanges(value = {}) {
  const target = String(value?.target ?? "").trim();
  const amount = toNumber(value?.value);
  if (!target || !amount) return [];
  const key = value.type === ABILITY_FUNCTION_TYPES.skillBonus
    ? `system.skills.${target}.bonus`
    : `system.characteristics.${target}`;
  return [normalizeAbilityChange({
    id: String(value?.id ?? "").trim() || foundry.utils.randomID(),
    key,
    type: ABILITY_CHANGE_TYPES.add,
    value: String(amount),
    phase: "initial",
    priority: null
  })];
}

function normalizeAbilityChanges(value = []) {
  return (Array.isArray(value) ? value : Object.values(value ?? {}))
    .map(normalizeAbilityChange);
}

function normalizeAbilityChange(value = {}) {
  const type = Object.values(ABILITY_CHANGE_TYPES).includes(value?.type) ? value.type : ABILITY_CHANGE_TYPES.add;
  return {
    id: String(value?.id ?? "").trim() || foundry.utils.randomID(),
    key: String(value?.key ?? "").trim(),
    type,
    value: String(value?.value ?? "0"),
    phase: String(value?.phase || "initial"),
    priority: value?.priority === "" || value?.priority === null || value?.priority === undefined
      ? null
      : toInteger(value.priority)
  };
}

function normalizeAbilityConditions(value = []) {
  return (Array.isArray(value) ? value : Object.values(value ?? {}))
    .map(normalizeAbilityCondition);
}

function normalizeAbilityAcquisitionConditions(value = []) {
  return (Array.isArray(value) ? value : Object.values(value ?? {}))
    .map(normalizeAbilityAcquisitionCondition);
}

function normalizeAbilityAcquisitionCondition(value = {}) {
  const rawType = String(value?.type ?? "").trim();
  const type = Object.values(ABILITY_ACQUISITION_CONDITION_TYPES).includes(rawType) ? rawType : "";
  if (!type) return { id: String(value?.id ?? "").trim() || "", type: "" };

  const id = String(value?.id ?? "").trim() || foundry.utils.randomID();
  if (type === ABILITY_ACQUISITION_CONDITION_TYPES.race) {
    return {
      id,
      type,
      raceId: String(value?.raceId ?? "").trim()
    };
  }

  if (type === ABILITY_ACQUISITION_CONDITION_TYPES.characteristic) {
    return {
      id,
      type,
      characteristicKey: String(value?.characteristicKey ?? value?.key ?? "").trim(),
      value: Math.max(0, toInteger(value?.value ?? value?.minimum))
    };
  }

  return {
    id,
    type,
    skillKey: String(value?.skillKey ?? value?.key ?? "").trim(),
    value: Math.max(0, toInteger(value?.value ?? value?.minimum))
  };
}

function normalizeAbilityCondition(value = {}) {
  const legacyEnabled = Boolean(value?.enabled);
  const rawType = String(value?.type ?? "").trim();
  const type = Object.values(ABILITY_CONDITION_TYPES).includes(rawType)
    ? rawType
    : legacyEnabled ? ABILITY_CONDITION_TYPES.healthPercent : "";
  const groupId = String(value?.groupId ?? "").trim();
  if (!type) return { id: String(value?.id ?? "").trim() || "", groupId, type: "" };

  const id = String(value?.id ?? "").trim() || foundry.utils.randomID();

  if (type === ABILITY_CONDITION_TYPES.targetFaction) {
    return {
      id,
      groupId,
      type,
      targetFactionNames: normalizeStringList(value?.targetFactionNames ?? value?.factions ?? value?.faction)
    };
  }

  if (type === ABILITY_CONDITION_TYPES.targetRace) {
    return {
      id,
      groupId,
      type,
      targetRaceId: String(value?.targetRaceId ?? value?.raceId ?? "").trim()
    };
  }

  if (type === ABILITY_CONDITION_TYPES.targetType) {
    return {
      id,
      groupId,
      type,
      targetTypeId: String(value?.targetTypeId ?? value?.typeId ?? "").trim()
    };
  }

  if (type === ABILITY_CONDITION_TYPES.posture) {
    const postureSubject = String(value?.postureSubject ?? value?.subject ?? "") === ABILITY_POSTURE_SUBJECTS.target
      ? ABILITY_POSTURE_SUBJECTS.target
      : ABILITY_POSTURE_SUBJECTS.self;
    return {
      id,
      groupId,
      type,
      postureSubject,
      postureActions: normalizeStringList(value?.postureActions ?? value?.postures ?? value?.actions)
        .filter(action => ABILITY_POSTURE_ACTIONS.includes(action))
    };
  }

  if (type === ABILITY_CONDITION_TYPES.occupiedCover) {
    return {
      id,
      groupId,
      type,
      coverKeys: normalizeStringList(value?.coverKeys ?? value?.covers ?? value?.cover)
    };
  }

  if (type === ABILITY_CONDITION_TYPES.weaponAction) {
    return {
      id,
      groupId,
      type,
      weaponActionKeys: normalizeConditionKeyList(value?.weaponActionKeys, value?.weaponActionKey)
    };
  }

  if (type === ABILITY_CONDITION_TYPES.weaponSkill) {
    return {
      id,
      groupId,
      type,
      skillKeys: normalizeConditionKeyList(value?.skillKeys, value?.skillKey)
    };
  }

  if (type === ABILITY_CONDITION_TYPES.weaponProficiency) {
    return {
      id,
      groupId,
      type,
      proficiencyKeys: normalizeConditionKeyList(value?.proficiencyKeys, value?.proficiencyKey)
    };
  }

  if (type === ABILITY_CONDITION_TYPES.aura) {
    const auraMode = normalizeAuraMode(value?.auraMode);
    return {
      id,
      groupId,
      type,
      auraMode,
      auraTargetGroups: normalizeAuraTargetGroups(value?.auraTargetGroups),
      auraRadiusMeters: normalizeFormulaText(value?.auraRadiusMeters, "0"),
      requiredCount: normalizeFormulaText(value?.requiredCount, "1"),
      auraWallsBlock: normalizeBoolean(value?.auraWallsBlock, true),
      auraIncludeSelf: auraMode === ABILITY_AURA_MODES.applyToTargets ? normalizeBoolean(value?.auraIncludeSelf, true) : false,
      auraCombatOnly: normalizeBoolean(value?.auraCombatOnly, false),
      auraCombatantsOnly: normalizeBoolean(value?.auraCombatantsOnly, false),
      auraIgnoreIncapacitated: normalizeBoolean(value?.auraIgnoreIncapacitated, true),
      auraIgnoreHidden: normalizeBoolean(value?.auraIgnoreHidden, true)
    };
  }

  if (type === ABILITY_CONDITION_TYPES.limitedChanges) {
    return {
      id,
      groupId,
      type,
      operator: "lte",
      percent: 50,
      equipmentSlotKey: "",
      healthTarget: ABILITY_HEALTH_TARGETS.general,
      limbKey: ABILITY_HEALTH_LIMB_ALL,
      limit: Math.max(1, toInteger(value?.limit ?? value?.count ?? 1)),
      durationSeconds: 0
    };
  }

  if (type === ABILITY_CONDITION_TYPES.cooldown) {
    return {
      id,
      groupId,
      type,
      operator: "lte",
      percent: 50,
      equipmentSlotKey: "",
      healthTarget: ABILITY_HEALTH_TARGETS.general,
      limbKey: ABILITY_HEALTH_LIMB_ALL,
      limit: 1,
      durationSeconds: Math.max(0, toInteger(value?.durationSeconds ?? value?.duration ?? value?.seconds))
    };
  }

  if (type === ABILITY_CONDITION_TYPES.itemUse) {
    return {
      id,
      groupId,
      type,
      operator: "lte",
      percent: 50,
      equipmentSlotKey: "",
      healthTarget: ABILITY_HEALTH_TARGETS.general,
      limbKey: ABILITY_HEALTH_LIMB_ALL,
      limit: 1,
      requiredCount: String(Math.max(1, toInteger(value?.requiredCount ?? value?.count ?? value?.limit ?? 1))),
      itemCategories: normalizeItemUseCategories(value?.itemCategories ?? value?.categories ?? value?.category),
      durationSeconds: Math.max(0, toInteger(value?.durationSeconds ?? value?.duration ?? value?.seconds))
    };
  }

  if (type === ABILITY_CONDITION_TYPES.equipmentSlotOccupied) {
    return {
      id,
      groupId,
      type,
      operator: String(value?.operator ?? "") === ABILITY_EQUIPMENT_OPERATORS.empty
        ? ABILITY_EQUIPMENT_OPERATORS.empty
        : ABILITY_EQUIPMENT_OPERATORS.occupied,
      equipmentSlotKey: String(value?.equipmentSlotKey ?? "").trim(),
      percent: 50,
      healthTarget: ABILITY_HEALTH_TARGETS.general,
      limbKey: ABILITY_HEALTH_LIMB_ALL,
      limit: 1,
      durationSeconds: 0
    };
  }

  const rawHealthTarget = String(value?.healthTarget ?? "").trim();
  const healthTarget = Object.values(ABILITY_HEALTH_TARGETS).includes(rawHealthTarget)
    ? rawHealthTarget
    : ABILITY_HEALTH_TARGETS.general;

  return {
    id,
    groupId,
    type,
    operator: String(value?.operator ?? "lte") === "gte" ? "gte" : "lte",
    percent: Math.max(0, Math.min(100, toInteger(value?.percent ?? 50))),
    equipmentSlotKey: "",
    healthTarget,
    limbKey: String(value?.limbKey ?? ABILITY_HEALTH_LIMB_ALL).trim() || ABILITY_HEALTH_LIMB_ALL,
    limit: 1,
    durationSeconds: 0
  };
}

function normalizeStringList(value = []) {
  const source = Array.isArray(value)
    ? value
    : value && typeof value === "object" ? Object.values(value) : [value];
  return Array.from(new Set(source.map(entry => String(entry ?? "").trim()).filter(Boolean)));
}

function normalizeConditionKeyList(value = [], previous = "") {
  const normalized = normalizeStringList(value);
  const previousKey = String(previous ?? "").trim();
  if (previousKey && !normalized.includes(previousKey)) normalized.push(previousKey);
  return normalized;
}

function normalizeAuraMode(value) {
  const mode = String(value ?? "").trim();
  return Object.values(ABILITY_AURA_MODES).includes(mode)
    ? mode
    : ABILITY_AURA_MODES.applyToTargets;
}

function normalizeAuraTargetGroups(value = []) {
  const normalized = normalizeStringList(value).filter(group => ABILITY_AURA_TARGET_GROUPS.includes(group));
  return normalized.length ? normalized : ["enemy"];
}

function normalizeFormulaText(value = "", fallback = "0") {
  return String(value ?? "").trim() || fallback;
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return Boolean(fallback);
  if (typeof value === "string") return value === "true";
  return Boolean(value);
}

function normalizeFixedFunctionKey(value = "") {
  const key = String(value ?? "").trim();
  return Object.values(ABILITY_FIXED_FUNCTION_KEYS).includes(key)
    ? key
    : ABILITY_FIXED_FUNCTION_KEYS.deusExMachina;
}

function normalizeFixedFunctionSettings(fixedKey = "", value = {}) {
  const normalizedKey = normalizeFixedFunctionKey(fixedKey);
  if (normalizedKey === ABILITY_FIXED_FUNCTION_KEYS.deusExMachina) {
    return normalizeDeusExMachinaSettings(value);
  }
  if (normalizedKey === ABILITY_FIXED_FUNCTION_KEYS.curseAndBlessing) {
    return normalizeCurseAndBlessingSettings(value);
  }
  if (normalizedKey === ABILITY_FIXED_FUNCTION_KEYS.allOrNothing) {
    return normalizeAllOrNothingSettings(value);
  }
  if (normalizedKey === ABILITY_FIXED_FUNCTION_KEYS.reaper) {
    return normalizeReaperSettings(value);
  }
  if (normalizedKey === ABILITY_FIXED_FUNCTION_KEYS.virtuoso) {
    return normalizeVirtuosoSettings(value);
  }
  if (normalizedKey === ABILITY_FIXED_FUNCTION_KEYS.fourLeafClover) {
    return normalizeFourLeafCloverSettings(value);
  }
  if (normalizedKey === ABILITY_FIXED_FUNCTION_KEYS.atRandom) {
    return normalizeAtRandomSettings(value);
  }
  if (normalizedKey === ABILITY_FIXED_FUNCTION_KEYS.lastChance) {
    return normalizeLastChanceSettings(value);
  }
  if (normalizedKey === ABILITY_FIXED_FUNCTION_KEYS.luckyCoin) {
    return normalizeLuckyCoinSettings(value);
  }
  if (normalizedKey === ABILITY_FIXED_FUNCTION_KEYS.disarm) {
    return normalizeDisarmSettings(value);
  }
  if (normalizedKey === ABILITY_FIXED_FUNCTION_KEYS.defensiveTactics) {
    return normalizeDefensiveTacticsSettings(value);
  }
  if (normalizedKey === ABILITY_FIXED_FUNCTION_KEYS.rage) {
    return normalizeRageSettings(value);
  }
  if (normalizedKey === ABILITY_FIXED_FUNCTION_KEYS.whirlwind) {
    return normalizeWhirlwindSettings(value);
  }
  if (normalizedKey === ABILITY_FIXED_FUNCTION_KEYS.lunge) {
    return normalizeLungeSettings(value);
  }
  if (normalizedKey === ABILITY_FIXED_FUNCTION_KEYS.doubleAttack) {
    return normalizeDoubleAttackSettings(value);
  }
  if (normalizedKey === ABILITY_FIXED_FUNCTION_KEYS.counterAttack) {
    return normalizeCounterAttackSettings(value);
  }
  if (normalizedKey === ABILITY_FIXED_FUNCTION_KEYS.whereAreYouGoing) {
    return normalizeWhereAreYouGoingSettings(value);
  }
  if (normalizedKey === ABILITY_FIXED_FUNCTION_KEYS.fullForce) {
    return normalizeFullForceSettings(value);
  }
  return {};
}

export function normalizeDeusExMachinaSettings(value = {}) {
  const rescueMode = String(value?.rescue?.restoreMode ?? value?.rescueRestoreMode ?? "") === "count" ? "count" : "all";
  return {
    damageRequired: Math.max(1, toInteger(value?.damageRequired ?? 2000)),
    insight: {
      skillBonus: toInteger(value?.insight?.skillBonus ?? value?.insightSkillBonus ?? 20),
      durationSeconds: Math.max(0, toInteger(value?.insight?.durationSeconds ?? value?.insightDurationSeconds ?? 86400))
    },
    disintegrate: {
      destroyPercent: Math.max(0, Math.min(100, toInteger(value?.disintegrate?.destroyPercent ?? value?.disintegrateDestroyPercent ?? 100)))
    },
    luckyFind: {
      valueMin: Math.max(0, toInteger(value?.luckyFind?.valueMin ?? value?.luckyFindValueMin ?? 1000)),
      valueMax: Math.max(0, toInteger(value?.luckyFind?.valueMax ?? value?.luckyFindValueMax ?? 5000))
    },
    rescue: {
      restoreMode: rescueMode,
      restoreCount: Math.max(1, toInteger(value?.rescue?.restoreCount ?? value?.rescueRestoreCount ?? 1))
    }
  };
}

export function normalizeCurseAndBlessingSettings(value = {}) {
  return {
    energyCost: Math.max(0, toInteger(value?.energyCost ?? 10)),
    triggerFormula: String(value?.triggerFormula ?? "30+gambling/10").trim() || "30+gambling/10",
    durationSeconds: Math.max(0, toInteger(value?.durationSeconds ?? 12))
  };
}

export function normalizeAllOrNothingSettings(value = {}) {
  return {
    energyCost: Math.max(0, toInteger(value?.energyCost ?? 10)),
    overloadEnergyCost: Math.max(0, toInteger(value?.overloadEnergyCost ?? 20)),
    overloadDurationSeconds: Math.max(0, toInteger(value?.overloadDurationSeconds ?? 1800)),
    chanceFormula: String(value?.chanceFormula ?? "50 + gambling/10").trim() || "50 + gambling/10",
    pelletCoveragePercent: Math.max(0, Math.min(100, toInteger(value?.pelletCoveragePercent ?? 50))),
    burstCoveragePercent: Math.max(0, Math.min(100, toInteger(value?.burstCoveragePercent ?? 50)))
  };
}

export function normalizeReaperSettings(value = {}) {
  return {
    killChanceFormula: String(value?.killChanceFormula ?? "50+gambling/10").trim() || "50+gambling/10",
    attackChanceFormula: String(value?.attackChanceFormula ?? "10+gambling/15").trim() || "10+gambling/15"
  };
}

export function normalizeFourLeafCloverSettings(value = {}) {
  return {
    currentCharges: Math.max(0, toInteger(value?.currentCharges ?? 0)),
    failureCharges: Math.max(0, toInteger(value?.failureCharges ?? 1)),
    criticalFailureCharges: Math.max(0, toInteger(value?.criticalFailureCharges ?? 3))
  };
}

export function normalizeAtRandomSettings(value = {}) {
  return {
    actionPointCostReduction: Math.max(0, toInteger(value?.actionPointCostReduction ?? 1)),
    blockChanceFormula: String(value?.blockChanceFormula ?? "110-gambling/5").trim() || "110-gambling/5",
    extraBlockChanceFormula: String(value?.extraBlockChanceFormula ?? "60+gambling/5").trim() || "60+gambling/5"
  };
}

export function normalizeLastChanceSettings(value = {}) {
  return {
    energyCost: Math.max(0, toInteger(value?.energyCost ?? 10)),
    chanceFormula: String(value?.chanceFormula ?? "70+gambling/10").trim() || "70+gambling/10",
    overloadEnergyCost: Math.max(0, toInteger(value?.overloadEnergyCost ?? 50)),
    overloadDurationSeconds: Math.max(0, toInteger(value?.overloadDurationSeconds ?? 43200))
  };
}

export function normalizeLuckyCoinSettings(value = {}) {
  return {
    energyCost: Math.max(0, toInteger(value?.energyCost ?? 10)),
    chanceFormula: String(value?.chanceFormula ?? "50+gambling/10").trim() || "50+gambling/10",
    successBonusFormula: String(value?.successBonusFormula ?? "10+gambling/5").trim() || "10+gambling/5",
    failurePenaltyFormula: String(value?.failurePenaltyFormula ?? "5+gambling/10").trim() || "5+gambling/10",
    overloadEnergyCost: Math.max(0, toInteger(value?.overloadEnergyCost ?? 10)),
    overloadDurationSeconds: Math.max(0, toInteger(value?.overloadDurationSeconds ?? 3600))
  };
}

export function normalizeDisarmSettings(value = {}) {
  return {
    activeEnergyCost: Math.max(0, toInteger(value?.activeEnergyCost ?? value?.energyCost ?? 30)),
    activeActionPointCost: Math.max(0, toInteger(value?.activeActionPointCost ?? 3)),
    activeDifficultyBase: Math.max(0, toInteger(value?.activeDifficultyBase ?? 50)),
    activeOverloadEnergyCost: Math.max(0, toInteger(value?.activeOverloadEnergyCost ?? value?.overloadEnergyCost ?? 50)),
    activeOverloadDurationSeconds: Math.max(0, toInteger(value?.activeOverloadDurationSeconds ?? value?.overloadDurationSeconds ?? 12)),
    reactionEnergyCost: Math.max(0, toInteger(value?.reactionEnergyCost ?? 20)),
    reactionActionPointCost: Math.max(0, toInteger(value?.reactionActionPointCost ?? 2)),
    reactionDifficultyBase: Math.max(0, toInteger(value?.reactionDifficultyBase ?? 20)),
    reactionOverloadEnergyCost: Math.max(0, toInteger(value?.reactionOverloadEnergyCost ?? 20)),
    reactionOverloadDurationSeconds: Math.max(0, toInteger(value?.reactionOverloadDurationSeconds ?? 6))
  };
}

export function normalizeDefensiveTacticsSettings(value = {}) {
  return {
    dodgeLossReductionPercent: Math.max(0, toInteger(value?.dodgeLossReductionPercent ?? 10)),
    dodgeRoundRecoveryBonusPercent: Math.max(0, toInteger(value?.dodgeRoundRecoveryBonusPercent ?? 30))
  };
}

export function normalizeRageSettings(value = {}) {
  return {
    energyCost: Math.max(0, toInteger(value?.energyCost ?? 30)),
    overloadEnergyCost: Math.max(0, toInteger(value?.overloadEnergyCost ?? 100)),
    overloadDurationSeconds: Math.max(0, toInteger(value?.overloadDurationSeconds ?? 7200)),
    durationSeconds: Math.max(0, toInteger(value?.durationSeconds ?? 18)),
    movementPointBonus: Math.max(0, toInteger(value?.movementPointBonus ?? 3)),
    actionPointBonus: Math.max(0, toInteger(value?.actionPointBonus ?? 1)),
    advantageSkillKey: String(value?.advantageSkillKey ?? "meleeCombat").trim() || "meleeCombat",
    advantageCount: Math.max(0, toInteger(value?.advantageCount ?? 1)),
    disadvantageSkillKey: String(value?.disadvantageSkillKey ?? "rangedCombat").trim() || "rangedCombat",
    disadvantageCount: Math.max(0, toInteger(value?.disadvantageCount ?? 1))
  };
}

export function normalizeVirtuosoSettings(value = {}) {
  return {
    accuracyBonus: toInteger(value?.accuracyBonus ?? 20),
    damagePercentBonus: toInteger(value?.damagePercentBonus ?? 20)
  };
}

export function normalizeWhirlwindSettings(value = {}) {
  return {
    energyCost: Math.max(0, toInteger(value?.energyCost ?? 20)),
    overloadEnergyCost: Math.max(0, toInteger(value?.overloadEnergyCost ?? 40)),
    overloadDurationSeconds: Math.max(0, toInteger(value?.overloadDurationSeconds ?? 18)),
    accuracyModifier: toInteger(value?.accuracyModifier ?? -30)
  };
}

export function normalizeLungeSettings(value = {}) {
  return {
    energyCost: Math.max(0, toInteger(value?.energyCost ?? 10)),
    overloadEnergyCost: Math.max(0, toInteger(value?.overloadEnergyCost ?? 40)),
    overloadDurationSeconds: Math.max(0, toInteger(value?.overloadDurationSeconds ?? 12)),
    maxCells: Math.max(1, toInteger(value?.maxCells ?? 2))
  };
}

export function normalizeDoubleAttackSettings(value = {}) {
  return {
    energyCost: Math.max(0, toInteger(value?.energyCost ?? 40)),
    duplicateCount: Math.max(1, toInteger(value?.duplicateCount ?? 1)),
    requiredSkillKey: String(value?.requiredSkillKey ?? "meleeCombat").trim() || "meleeCombat"
  };
}

export function normalizeCounterAttackSettings(value = {}) {
  return {
    reactionEnergyCost: Math.max(0, toInteger(value?.reactionEnergyCost ?? value?.energyCost ?? 20)),
    reactionOverloadEnergyCost: Math.max(0, toInteger(value?.reactionOverloadEnergyCost ?? value?.overloadEnergyCost ?? 20)),
    reactionOverloadDurationSeconds: Math.max(0, toInteger(value?.reactionOverloadDurationSeconds ?? value?.overloadDurationSeconds ?? 18)),
    requiredSkillKey: String(value?.requiredSkillKey ?? "meleeCombat").trim() || "meleeCombat"
  };
}

export function normalizeWhereAreYouGoingSettings(value = {}) {
  return {
    reactionEnergyCost: Math.max(0, toInteger(value?.reactionEnergyCost ?? value?.energyCost ?? 20)),
    reactionOverloadEnergyCost: Math.max(0, toInteger(value?.reactionOverloadEnergyCost ?? value?.overloadEnergyCost ?? 40)),
    reactionOverloadDurationSeconds: Math.max(0, toInteger(value?.reactionOverloadDurationSeconds ?? value?.overloadDurationSeconds ?? 6))
  };
}

export function normalizeFullForceSettings(value = {}) {
  return {
    energyCost: Math.max(0, toInteger(value?.energyCost ?? 10)),
    requiredSkillKey: String(value?.requiredSkillKey ?? "meleeCombat").trim() || "meleeCombat",
    damagePercentBonus: Math.max(0, toInteger(value?.damagePercentBonus ?? 100)),
    conditionCostMultiplier: Math.max(1, toInteger(value?.conditionCostMultiplier ?? 5))
  };
}

function normalizeItemUseCategories(value = []) {
  const source = Array.isArray(value)
    ? value
    : value && typeof value === "object" ? Object.values(value) : [value];
  return Array.from(new Set(source
    .map(category => String(category ?? "").trim())
    .filter(Boolean)));
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

