import { createDefaultSkillSettings, normalizeSkillSettings } from "../formulas/index.mjs";
import { toInteger } from "../utils/numbers.mjs";
import {
  normalizeIlluminationLevel,
  normalizeTimeOfDayText
} from "../abilities/environment-conditions.mjs";

export const LOCKED_FEATURES_CATEGORY_ID = "features";
export const GENERAL_ABILITY_CATEGORY_ID = "general";
export const ABILITY_SOURCE_FLAG = "abilitySource";
export const ABILITY_CATALOG_DRAG_TYPE = "fallout-maw-ability-catalog-entry";

export const ABILITY_FUNCTION_TYPES = Object.freeze({
  effectChanges: "effectChanges",
  activeApplication: "activeApplication",
  acquisitionChanges: "acquisitionChanges",
  characteristicBonus: "characteristicBonus",
  skillBonus: "skillBonus",
  fixed: "fixed"
});

export const ABILITY_ACTION_TYPES = Object.freeze({
  weaponAttack: "weaponAttack",
  movementRoute: "movementRoute"
});

/** Formula context used by constructor actions which operate on a route. */
export const ABILITY_ACTION_ROUTE_EVALUATION_MODES = Object.freeze({
  source: "source",
  executor: "executor"
});

/** Unit constrained by a movement-route constructor action. */
export const ABILITY_ACTION_ROUTE_BUDGET_MODES = Object.freeze({
  movementCost: "movementCost",
  distance: "distance"
});

/** Actor which pays an action-point cost attached to a constructor action. */
export const ABILITY_ACTION_POINT_PAYERS = Object.freeze({
  source: "source",
  executor: "executor"
});

/** How confirmed movement routes are committed. */
export const ABILITY_MOVEMENT_ROUTE_EXECUTION_MODES = Object.freeze({
  sequential: "sequential",
  parallel: "parallel"
});

export const ABILITY_ATTACKING_WEAPON_ACTION_KEYS = Object.freeze([
  "aimedShot",
  "snapshot",
  "burst",
  "volley",
  "meleeAttack",
  "aimedMeleeAttack",
  "push"
]);

export const ABILITY_ATTACK_ACTION_ALL = "all";

export const ABILITY_ACTION_TARGET_MODES = Object.freeze({
  triggerActor: "triggerActor",
  free: "free"
});

export const ABILITY_ACTION_EXECUTOR_MODES = Object.freeze({
  source: "source",
  targets: "targets"
});

export const ABILITY_ACTION_POINT_COST_MODES = Object.freeze({
  none: "none",
  fixed: "fixed",
  actual: "actual"
});

export const ABILITY_FIXED_FUNCTION_KEYS = Object.freeze({
  deusExMachina: "deusExMachina",
  curseAndBlessing: "curseAndBlessing",
  allOrNothing: "allOrNothing",
  reaper: "reaper",
  virtuoso: "virtuoso",
  aiming: "aiming",
  ricochet: "ricochet",
  keepAway: "keepAway",
  lethalShot: "lethalShot",
  lethalStrike: "lethalStrike",
  hawkEye: "hawkEye",
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
  oversight: "oversight",
  watchOut: "watchOut",
  dangerSense: "dangerSense",
  fullControl: "fullControl",
  counterSniper: "counterSniper",
  whereAreYouGoing: "whereAreYouGoing",
  fullForce: "fullForce",
  twoHands: "twoHands",
  commandBasics: "commandBasics",
  knockOffBalance: "knockOffBalance",
  look: "look",
  toTheEnd: "toTheEnd",
  heightenedConcentration: "heightenedConcentration",
  grapplingMaster: "grapplingMaster"
});

export const ABILITY_CONDITION_TYPES = Object.freeze({
  toggleable: "toggleable",
  eventReaction: "eventReaction",
  triggerCost: "triggerCost",
  timeOfDay: "timeOfDay",
  illumination: "illumination",
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
  duration: "duration",
  energyConsumption: "energyConsumption",
  itemUse: "itemUse"
});

export const ABILITY_EVENT_TRACKING_TARGETS = Object.freeze(["owner", "ally", "enemy", "neutral"]);

export const ABILITY_EVENT_SUBJECTS = Object.freeze({
  reactor: "reactor",
  eventSource: "eventSource",
  eventTarget: "eventTarget"
});

export const ABILITY_EVENT_REACTION_MODES = Object.freeze({
  standard: "standard",
  isolatedAuto: "isolatedAuto"
});

export function normalizeEventReactionMode(value = "", legacyAutoApply = false) {
  const normalized = String(value ?? "").trim();
  if (Object.values(ABILITY_EVENT_REACTION_MODES).includes(normalized)) return normalized;
  return normalizeBoolean(legacyAutoApply, false)
    ? ABILITY_EVENT_REACTION_MODES.isolatedAuto
    : ABILITY_EVENT_REACTION_MODES.standard;
}

export function normalizeEventReactionProgressRequired(value = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 1;
  return Math.max(0.01, Math.round((numeric + Number.EPSILON) * 10000) / 10000);
}

export const ABILITY_AURA_MODES = Object.freeze({
  applyToTargets: "applyToTargets",
  selfWhenPresent: "selfWhenPresent"
});

export const ABILITY_AURA_TARGET_GROUPS = Object.freeze(["ally", "enemy", "neutral"]);

export const ABILITY_ACTIVE_APPLICATION_TARGET_MODES = Object.freeze({
  self: "self",
  others: "others"
});

export const ABILITY_ACTIVE_APPLICATION_SELECTION_MODES = Object.freeze({
  manual: "manual",
  all: "all"
});

/** Actor group charged by one active-application activation-cost row. */
export const ABILITY_ACTIVE_APPLICATION_COST_PAYERS = Object.freeze({
  source: "source",
  targets: "targets"
});

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
        locked: true,
        abilities: []
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

export function createTwoHandsAbilityCatalogEntry() {
  return normalizeAbilityEntry({
    id: "fixed-two-hands",
    name: "С двух рук",
    img: "icons/svg/combat.svg",
    visible: true,
    description: "<p>Переключаемая функция: парный залп двух активных оружий в текущем наборе. Каждый залп расходует 10 энергии, а стоимость ОД берется по самому дорогому выбранному действию.</p>",
    system: {
      cost: 0,
      formula: "",
      acquisition: {
        onlyFree: false,
        onlyManual: false,
        skillKey: "meleeCombat",
        difficulty: 60
      },
      acquisitionRequirements: [],
      functions: [
        {
          id: "fixed-two-hands-function",
          type: ABILITY_FUNCTION_TYPES.fixed,
          fixedKey: ABILITY_FIXED_FUNCTION_KEYS.twoHands,
          fixedSettings: {
            energyCost: 10
          },
          changes: [],
          conditions: [],
          penalties: []
        }
      ]
    }
  });
}

export function createCommandBasicsAbilityCatalogEntry() {
  return normalizeAbilityEntry({
    id: "fixed-command-basics",
    name: "Основы командования",
    img: "icons/svg/upgrade.svg",
    visible: true,
    description: "<p>Активная способность: за 30 энергии отдаёт одну из трёх команд союзникам или членам одной фракции. «Цельсь, пли» заставляет до 2 + Речь / 50 союзников выполнить неприцельный выстрел; «Коли» - неприцельную атаку; «Ложись» даёт +10 + Речь / 10 к уклонению на 12 секунд. Перегрузка: +100 энергии на 12 секунд.</p>",
    system: {
      cost: 0,
      formula: "",
      acquisition: {
        onlyFree: false,
        onlyManual: false,
        skillKey: "speech",
        difficulty: 60
      },
      acquisitionRequirements: [],
      functions: [
        {
          id: "fixed-command-basics-function",
          type: ABILITY_FUNCTION_TYPES.fixed,
          fixedKey: ABILITY_FIXED_FUNCTION_KEYS.commandBasics,
          fixedSettings: normalizeCommandBasicsSettings(),
          changes: [],
          conditions: [],
          penalties: []
        }
      ]
    }
  });
}

export function createKnockOffBalanceAbilityCatalogEntry() {
  return normalizeAbilityEntry({
    id: "fixed-knock-off-balance",
    name: "Выбить из колеи",
    img: "icons/svg/daze.svg",
    visible: true,
    description: "<p>Стоимость активации: 20 энергии. Перегрузка: 20 энергии на 12 секунд.</p><p>После активации можно выбрать до [[2+speech/50]] целей с интеллектом выше 0, затем до [[1+speech/100]] навыков. Цели проходят проверку Науки со сложностью [[50+speech]]. При провале на 12 секунд получают двойную помеху к выбранным навыкам.</p>",
    system: {
      cost: 0,
      formula: "",
      acquisition: {
        onlyFree: false,
        onlyManual: false,
        skillKey: "speech",
        difficulty: 60
      },
      acquisitionRequirements: [],
      functions: [
        {
          id: "fixed-knock-off-balance-function",
          type: ABILITY_FUNCTION_TYPES.fixed,
          fixedKey: ABILITY_FIXED_FUNCTION_KEYS.knockOffBalance,
          fixedSettings: normalizeKnockOffBalanceSettings(),
          changes: [],
          conditions: [],
          penalties: []
        }
      ]
    }
  });
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
      category: String(system.category ?? value?.category ?? "").trim(),
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
    activeSettings: options?.activeSettings,
    reactionSettings: options?.reactionSettings,
    changes: [],
    actions: [],
    conditions: [],
    penalties: []
  });
}

export function createAbilityAction(type = "") {
  return normalizeAbilityAction({
    id: foundry.utils.randomID(),
    type,
    attackActionKeys: [ABILITY_ATTACK_ACTION_ALL],
    executorMode: ABILITY_ACTION_EXECUTOR_MODES.source,
    targetMode: ABILITY_ACTION_TARGET_MODES.triggerActor,
    actionPointCostMode: ABILITY_ACTION_POINT_COST_MODES.none,
    actionPointPayer: ABILITY_ACTION_POINT_PAYERS.executor,
    fixedActionPointCost: 0,
    actualActionPointCostPercent: 100,
    routeBudgetMode: ABILITY_ACTION_ROUTE_BUDGET_MODES.movementCost,
    routeBudgetFormula: "0",
    routeBudgetEvaluation: ABILITY_ACTION_ROUTE_EVALUATION_MODES.executor,
    routeExecutionMode: ABILITY_MOVEMENT_ROUTE_EXECUTION_MODES.sequential,
    routeMovementAction: "",
    routeAutoRotate: false,
    routeShowRuler: true
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
      category: normalized.system.category,
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
  let conditions = normalizeAbilityConditions(value?.conditions ?? (value?.condition ? [value.condition] : []));
  const legacyReactionSettings = type === ABILITY_FUNCTION_TYPES.effectChanges
    ? normalizeEventReactionSettings(value?.reactionSettings)
    : { durationSeconds: 0, costs: [] };
  if (type === ABILITY_FUNCTION_TYPES.effectChanges) {
    conditions = consolidateTriggerCostConditions(conditions, legacyReactionSettings.costs);
  }
  const legacyReactionDuration = Math.max(0, toInteger(value?.reactionSettings?.durationSeconds ?? value?.reactionSettings?.duration ?? 0));
  if (
    type === ABILITY_FUNCTION_TYPES.effectChanges
    && legacyReactionDuration > 0
    && !conditions.some(condition => condition?.type === ABILITY_CONDITION_TYPES.duration)
  ) {
    conditions = [
      ...conditions,
      normalizeAbilityCondition({
        type: ABILITY_CONDITION_TYPES.duration,
        durationSeconds: legacyReactionDuration
      })
    ];
  }
  const activeSettings = type === ABILITY_FUNCTION_TYPES.activeApplication
    ? normalizeActiveApplicationSettings(value?.activeSettings ?? value?.settings)
    : {};
  const legacyActiveDuration = type === ABILITY_FUNCTION_TYPES.activeApplication
    ? Math.max(0, toInteger(value?.activeSettings?.durationSeconds ?? value?.settings?.durationSeconds ?? 0))
    : 0;
  if (
    legacyActiveDuration > 0
    && !conditions.some(condition => condition?.type === ABILITY_CONDITION_TYPES.duration)
  ) {
    conditions = [
      ...conditions,
      normalizeAbilityCondition({
        type: ABILITY_CONDITION_TYPES.duration,
        durationSeconds: legacyActiveDuration
      })
    ];
  }
  return {
    id: String(value?.id ?? "").trim() || foundry.utils.randomID(),
    type,
    fixedKey: type === ABILITY_FUNCTION_TYPES.fixed ? normalizeFixedFunctionKey(value?.fixedKey) : "",
    fixedSettings: type === ABILITY_FUNCTION_TYPES.fixed
      ? normalizeFixedFunctionSettings(value?.fixedKey, value?.fixedSettings ?? value?.settings)
      : {},
    activeSettings,
    // Legacy storage is intentionally cleared after its rows have been migrated
    // into the standalone triggerCost condition above.
    reactionSettings: { durationSeconds: 0, costs: [] },
    changes: isLegacy
      ? legacyFunctionToChanges(value)
      : normalizeAbilityChanges(value?.changes ?? value?.effects),
    actions: [ABILITY_FUNCTION_TYPES.effectChanges, ABILITY_FUNCTION_TYPES.activeApplication].includes(type)
      ? normalizeAbilityActions(value?.actions)
      : [],
    conditions,
    penalties: normalizeAbilityChanges(value?.penalties),
    sort: index
  };
}

export function normalizeAbilityActions(value = []) {
  return (Array.isArray(value) ? value : Object.values(value ?? {}))
    .map(entry => normalizeAbilityAction(entry));
}

export function normalizeAbilityAction(value = {}) {
  const hasExplicitType = Object.prototype.hasOwnProperty.call(value ?? {}, "type");
  const rawType = String(value?.type ?? "").trim();
  const type = Object.values(ABILITY_ACTION_TYPES).includes(rawType)
    ? rawType
    : hasExplicitType && rawType === ""
      ? ""
      : ABILITY_ACTION_TYPES.weaponAttack;
  if (!type) {
    return {
      id: String(value?.id ?? "").trim() || foundry.utils.randomID(),
      type: "",
      attackActionKeys: [ABILITY_ATTACK_ACTION_ALL],
      executorMode: ABILITY_ACTION_EXECUTOR_MODES.source,
      targetMode: ABILITY_ACTION_TARGET_MODES.triggerActor,
      actionPointCostMode: ABILITY_ACTION_POINT_COST_MODES.none,
      actionPointPayer: ABILITY_ACTION_POINT_PAYERS.executor,
      fixedActionPointCost: 0,
      actualActionPointCostPercent: 100,
      routeBudgetMode: ABILITY_ACTION_ROUTE_BUDGET_MODES.movementCost,
      routeBudgetFormula: "0",
      routeBudgetEvaluation: ABILITY_ACTION_ROUTE_EVALUATION_MODES.executor,
      routeExecutionMode: ABILITY_MOVEMENT_ROUTE_EXECUTION_MODES.sequential,
      routeMovementAction: "",
      routeAutoRotate: false,
      routeShowRuler: true
    };
  }
  const rawKeys = Array.isArray(value?.attackActionKeys)
    ? value.attackActionKeys
    : Object.values(value?.attackActionKeys ?? {});
  const keys = Array.from(new Set(rawKeys.map(key => String(key ?? "").trim()).filter(Boolean)));
  const attackActionKeys = keys.includes(ABILITY_ATTACK_ACTION_ALL)
    ? [ABILITY_ATTACK_ACTION_ALL]
    : keys.filter(key => ABILITY_ATTACKING_WEAPON_ACTION_KEYS.includes(key));
  const rawTargetMode = String(value?.targetMode ?? "");
  const targetMode = rawTargetMode === "triggerTarget"
    ? ABILITY_ACTION_TARGET_MODES.triggerActor
    : Object.values(ABILITY_ACTION_TARGET_MODES).includes(rawTargetMode)
      ? rawTargetMode
      : ABILITY_ACTION_TARGET_MODES.triggerActor;
  const executorMode = Object.values(ABILITY_ACTION_EXECUTOR_MODES).includes(value?.executorMode)
    ? value.executorMode
    : ABILITY_ACTION_EXECUTOR_MODES.source;
  const normalizedActionPointCostMode = Object.values(ABILITY_ACTION_POINT_COST_MODES).includes(value?.actionPointCostMode)
    ? value.actionPointCostMode
    : ABILITY_ACTION_POINT_COST_MODES.none;
  const normalizedActionPointPayer = Object.values(ABILITY_ACTION_POINT_PAYERS).includes(value?.actionPointPayer)
    ? value.actionPointPayer
    : ABILITY_ACTION_POINT_PAYERS.executor;
  const routeBudgetMode = Object.values(ABILITY_ACTION_ROUTE_BUDGET_MODES).includes(value?.routeBudgetMode)
    ? value.routeBudgetMode
    : ABILITY_ACTION_ROUTE_BUDGET_MODES.movementCost;
  const legacyRouteEvaluation = value?.routeBudgetEvaluation ?? value?.routeDistanceEvaluation;
  const routeBudgetEvaluation = Object.values(ABILITY_ACTION_ROUTE_EVALUATION_MODES).includes(legacyRouteEvaluation)
    ? legacyRouteEvaluation
    : ABILITY_ACTION_ROUTE_EVALUATION_MODES.executor;
  const routeExecutionMode = Object.values(ABILITY_MOVEMENT_ROUTE_EXECUTION_MODES).includes(value?.routeExecutionMode)
    ? value.routeExecutionMode
    : ABILITY_MOVEMENT_ROUTE_EXECUTION_MODES.sequential;
  return {
    id: String(value?.id ?? "").trim() || foundry.utils.randomID(),
    type,
    attackActionKeys: attackActionKeys.length ? attackActionKeys : [ABILITY_ATTACK_ACTION_ALL],
    executorMode,
    targetMode,
    actionPointCostMode: type === ABILITY_ACTION_TYPES.movementRoute
      ? ABILITY_ACTION_POINT_COST_MODES.none
      : normalizedActionPointCostMode,
    actionPointPayer: type === ABILITY_ACTION_TYPES.movementRoute
      ? ABILITY_ACTION_POINT_PAYERS.executor
      : normalizedActionPointPayer,
    fixedActionPointCost: type === ABILITY_ACTION_TYPES.movementRoute
      ? 0
      : Math.max(0, toInteger(value?.fixedActionPointCost)),
    actualActionPointCostPercent: Math.max(0, toInteger(value?.actualActionPointCostPercent ?? 100)),
    routeBudgetMode,
    routeBudgetFormula: normalizeFormulaText(value?.routeBudgetFormula ?? value?.routeDistanceFormula, "0"),
    routeBudgetEvaluation,
    routeExecutionMode,
    routeMovementAction: String(value?.routeMovementAction ?? "").trim(),
    routeAutoRotate: normalizeBoolean(value?.routeAutoRotate, false),
    routeShowRuler: normalizeBoolean(value?.routeShowRuler, true)
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

export function normalizeActiveApplicationSettings(value = {}) {
  const hasExplicitTargetGroups = value !== null
    && typeof value === "object"
    && Object.hasOwn(value, "targetGroups");
  const targetMode = String(value?.targetMode ?? "").trim() === ABILITY_ACTIVE_APPLICATION_TARGET_MODES.others
    ? ABILITY_ACTIVE_APPLICATION_TARGET_MODES.others
    : ABILITY_ACTIVE_APPLICATION_TARGET_MODES.self;
  const targetSelectionMode = String(value?.targetSelectionMode ?? value?.selectionMode ?? "").trim()
    === ABILITY_ACTIVE_APPLICATION_SELECTION_MODES.all
    ? ABILITY_ACTIVE_APPLICATION_SELECTION_MODES.all
    : ABILITY_ACTIVE_APPLICATION_SELECTION_MODES.manual;
  const targetGroups = normalizeStringList(value?.targetGroups)
    .filter(group => ABILITY_AURA_TARGET_GROUPS.includes(group));
  const rawCosts = Array.isArray(value?.costs) ? value.costs : Object.values(value?.costs ?? {});
  const costs = rawCosts.map(row => normalizeActiveApplicationCost(row));
  if (!costs.length) {
    const legacyEnergyCost = Math.max(0, toInteger(value?.energyCost ?? 0));
    const legacyOverloadAmount = Math.max(0, toInteger(value?.overloadEnergyCost ?? 0));
    const legacyOverloadDurationSeconds = Math.max(0, toInteger(value?.overloadDurationSeconds ?? 0));
    if (legacyEnergyCost > 0 || (legacyOverloadAmount > 0 && legacyOverloadDurationSeconds > 0)) {
      costs.push(normalizeActiveApplicationCost({
        resourceKey: "power",
        formula: String(legacyEnergyCost),
        overloadAmount: legacyOverloadAmount,
        overloadDurationSeconds: legacyOverloadDurationSeconds,
        payer: ABILITY_ACTIVE_APPLICATION_COST_PAYERS.source
      }));
    }
  }
  const excludeSelf = value?.excludeSelf === undefined
    ? value?.includeSelf === undefined ? true : !normalizeBoolean(value.includeSelf, false)
    : normalizeBoolean(value.excludeSelf, true);
  return {
    name: String(value?.name ?? "").trim(),
    costs,
    targetMode,
    targetSelectionMode,
    targetLimit: normalizeFormulaText(value?.targetLimit, "1"),
    targetGroups: hasExplicitTargetGroups ? targetGroups : ["ally"],
    excludeSelf,
    includeSelf: !excludeSelf,
    radiusFormula: normalizeFormulaText(value?.radiusFormula ?? value?.targetRadiusFormula, ""),
    wallsBlock: normalizeBoolean(value?.wallsBlock ?? value?.targetWallsBlock, false),
    // Active applications historically evaluated each change against the
    // recipient actor.  Keep that behavior unless a constructor explicitly
    // requests a source snapshot (as Encouraging Speech does).
    changeEvaluation: String(value?.changeEvaluation ?? value?.formulaContext ?? "").trim() === "source"
      ? "source"
      : "target"
  };
}

/** Normalize an activation cost without leaking its payer field into trigger/reaction costs. */
export function normalizeActiveApplicationCost(value = {}) {
  const cost = normalizeEventReactionCost(value);
  const payer = Object.values(ABILITY_ACTIVE_APPLICATION_COST_PAYERS).includes(value?.payer)
    ? value.payer
    : ABILITY_ACTIVE_APPLICATION_COST_PAYERS.source;
  return { ...cost, payer };
}

const ACTIVE_APPLICATION_TARGET_SETTING_KEYS = Object.freeze([
  "targetSelectionMode",
  "targetLimit",
  "targetGroups",
  "excludeSelf",
  "radiusFormula",
  "wallsBlock",
  "changeEvaluation"
]);

export function preserveMissingActiveApplicationTargetSettings(value = {}, previous = {}) {
  const current = value !== null && typeof value === "object" && !Array.isArray(value)
    ? { ...value }
    : {};
  const previousSettings = normalizeActiveApplicationSettings(previous);
  for (const key of ACTIVE_APPLICATION_TARGET_SETTING_KEYS) {
    if (Object.hasOwn(current, key)) continue;
    const previousValue = previousSettings[key];
    current[key] = Array.isArray(previousValue) ? [...previousValue] : previousValue;
  }
  return current;
}

export function normalizeEventReactionSettings(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const rows = Array.isArray(source.costs) ? source.costs : Object.values(source.costs ?? {});
  return {
    durationSeconds: 0,
    costs: rows.map(row => normalizeEventReactionCost(row))
  };
}

export function getAbilityFunctionTriggerCostRows(abilityFunction = {}) {
  const conditions = consolidateTriggerCostConditions(
    normalizeAbilityConditions(abilityFunction?.conditions ?? []),
    []
  );
  const condition = conditions.find(entry => entry?.type === ABILITY_CONDITION_TYPES.triggerCost);
  return condition?.costs ?? [];
}

function consolidateTriggerCostConditions(conditions = [], legacyCosts = []) {
  const source = Array.isArray(conditions) ? conditions : [];
  const triggerConditions = source
    .filter(condition => condition?.type === ABILITY_CONDITION_TYPES.triggerCost);
  const normalizedLegacyCosts = (Array.isArray(legacyCosts) ? legacyCosts : Object.values(legacyCosts ?? {}))
    .map(row => normalizeEventReactionCost(row));
  if (!triggerConditions.length && !normalizedLegacyCosts.length) return source;

  const costs = triggerConditions.flatMap(condition => (
    Array.isArray(condition?.costs) ? condition.costs : Object.values(condition?.costs ?? {})
  )).map(row => normalizeEventReactionCost(row));

  // Partially migrated documents can contain the same rows in both stores.
  // Merge them as multisets: keep intentional duplicate rows, but never bill a
  // mirrored legacy copy for a second time.
  const existingCounts = new Map();
  for (const row of costs) {
    const signature = getTriggerCostMigrationSignature(row);
    existingCounts.set(signature, (existingCounts.get(signature) ?? 0) + 1);
  }
  const legacyCounts = new Map();
  for (const row of normalizedLegacyCosts) {
    const signature = getTriggerCostMigrationSignature(row);
    const occurrence = (legacyCounts.get(signature) ?? 0) + 1;
    legacyCounts.set(signature, occurrence);
    if (occurrence > (existingCounts.get(signature) ?? 0)) costs.push(row);
  }

  const merged = {
    id: String(triggerConditions[0]?.id ?? "").trim() || foundry.utils.randomID(),
    groupId: "",
    type: ABILITY_CONDITION_TYPES.triggerCost,
    costs
  };
  const firstIndex = source.findIndex(condition => condition?.type === ABILITY_CONDITION_TYPES.triggerCost);
  if (firstIndex < 0) return [...source, merged];
  return source.flatMap((condition, index) => {
    if (condition?.type !== ABILITY_CONDITION_TYPES.triggerCost) return [condition];
    return index === firstIndex ? [merged] : [];
  });
}

function getTriggerCostMigrationSignature(row = {}) {
  return JSON.stringify({
    resourceKey: String(row?.resourceKey ?? "").trim(),
    formula: String(row?.formula ?? "0").trim(),
    overloadAmount: Math.max(0, toInteger(row?.overloadAmount)),
    overloadDurationSeconds: Math.max(0, toInteger(row?.overloadDurationSeconds))
  });
}

export function getAbilityFunctionEffectDurationSeconds(abilityFunction = {}) {
  const fromConditions = (abilityFunction?.conditions ?? [])
    .filter(condition => condition?.type === ABILITY_CONDITION_TYPES.duration)
    .map(condition => Math.max(0, toInteger(condition?.durationSeconds ?? condition?.duration ?? condition?.seconds)))
    .filter(seconds => seconds > 0);
  return fromConditions.length ? fromConditions[0] : 0;
}

export function isAbilityFunctionTimedTriggerCost(abilityFunction = {}) {
  if (abilityFunction?.type !== ABILITY_FUNCTION_TYPES.effectChanges) return false;
  const conditions = abilityFunction?.conditions ?? [];
  if (!conditions.some(condition => condition?.type === ABILITY_CONDITION_TYPES.triggerCost)) return false;
  if (getAbilityFunctionEffectDurationSeconds(abilityFunction) <= 0) return false;
  if (conditions.some(condition => [
    ABILITY_CONDITION_TYPES.eventReaction,
    ABILITY_CONDITION_TYPES.itemUse,
    ABILITY_CONDITION_TYPES.aura
  ].includes(condition?.type))) return false;
  return conditions.some(condition => [
    ABILITY_CONDITION_TYPES.toggleable,
    ABILITY_CONDITION_TYPES.timeOfDay,
    ABILITY_CONDITION_TYPES.illumination,
    ABILITY_CONDITION_TYPES.healthPercent,
    ABILITY_CONDITION_TYPES.equipmentSlotOccupied,
    ABILITY_CONDITION_TYPES.posture,
    ABILITY_CONDITION_TYPES.occupiedCover,
    ABILITY_CONDITION_TYPES.energyConsumption
  ].includes(condition?.type));
}

export function normalizeEventReactionCost(value = {}) {
  const overloadDurationSeconds = Math.max(0, toInteger(
    value?.overloadDurationSeconds ?? value?.overloadDuration ?? 0
  ));
  const rawOverload = value?.overloadAmount ?? value?.overload ?? value?.overloadFormula;
  const overloadAmount = overloadDurationSeconds > 0
    ? Math.max(0, toInteger(rawOverload ?? 0))
    : 0;
  return {
    id: String(value?.id ?? "").trim() || foundry.utils.randomID(),
    resourceKey: String(value?.resourceKey ?? value?.key ?? "").trim(),
    formula: String(value?.formula ?? value?.value ?? "0").trim(),
    overloadAmount,
    overloadDurationSeconds
  };
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

  if (type === ABILITY_CONDITION_TYPES.toggleable) {
    return {
      id,
      groupId,
      type,
      name: String(value?.name ?? value?.toggleName ?? "").trim(),
      cooldownSeconds: normalizeOptionalSeconds(value?.cooldownSeconds)
    };
  }

  if (type === ABILITY_CONDITION_TYPES.eventReaction) {
    const reactionMode = normalizeEventReactionMode(value?.reactionMode, value?.autoApply);
    return {
      id,
      groupId,
      type,
      eventKey: String(value?.eventKey ?? value?.key ?? "").trim(),
      progressRequired: normalizeEventReactionProgressRequired(value?.progressRequired),
      combatOnly: normalizeBoolean(value?.combatOnly, false),
      reactionMode,
      // Kept as a serialized compatibility mirror for already saved data.
      autoApply: reactionMode === ABILITY_EVENT_REACTION_MODES.isolatedAuto,
      trackingTargets: normalizeEventTrackingTargets(value?.trackingTargets),
      skillKeys: normalizeConditionKeyList(value?.skillKeys, value?.skillKey),
      expectedResultKeys: normalizeConditionKeyList(value?.expectedResultKeys, value?.expectedResultKey),
      eventFilters: normalizeEventReactionDepthFilterMap(value?.eventFilters)
    };
  }

  if (type === ABILITY_CONDITION_TYPES.triggerCost) {
    const rows = Array.isArray(value?.costs) ? value.costs : Object.values(value?.costs ?? {});
    return {
      id,
      // Trigger cost is function metadata and never participates in an OR group.
      groupId: "",
      type,
      costs: rows.map(row => normalizeEventReactionCost(row))
    };
  }

  const rawEventSubject = String(value?.eventSubject ?? "").trim();
  const eventSubject = Object.values(ABILITY_EVENT_SUBJECTS).includes(rawEventSubject)
    ? rawEventSubject
    : ABILITY_EVENT_SUBJECTS.reactor;

  if (type === ABILITY_CONDITION_TYPES.timeOfDay) {
    return {
      id,
      groupId,
      type,
      eventSubject,
      timeFrom: normalizeTimeOfDayText(value?.timeFrom, "00:00"),
      timeTo: normalizeTimeOfDayText(value?.timeTo, "23:59")
    };
  }

  if (type === ABILITY_CONDITION_TYPES.illumination) {
    return {
      id,
      groupId,
      type,
      eventSubject,
      illuminationLevel: normalizeIlluminationLevel(value?.illuminationLevel)
    };
  }

  if (type === ABILITY_CONDITION_TYPES.targetFaction) {
    return {
      id,
      groupId,
      type,
      eventSubject,
      targetFactionNames: normalizeStringList(value?.targetFactionNames ?? value?.factions ?? value?.faction)
    };
  }

  if (type === ABILITY_CONDITION_TYPES.targetRace) {
    return {
      id,
      groupId,
      type,
      eventSubject,
      targetRaceId: String(value?.targetRaceId ?? value?.raceId ?? "").trim()
    };
  }

  if (type === ABILITY_CONDITION_TYPES.targetType) {
    return {
      id,
      groupId,
      type,
      eventSubject,
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
      eventSubject,
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
      eventSubject,
      coverKeys: normalizeStringList(value?.coverKeys ?? value?.covers ?? value?.cover)
    };
  }

  if (type === ABILITY_CONDITION_TYPES.weaponAction) {
    return {
      id,
      groupId,
      type,
      eventSubject,
      weaponActionKeys: normalizeConditionKeyList(value?.weaponActionKeys, value?.weaponActionKey)
    };
  }

  if (type === ABILITY_CONDITION_TYPES.weaponSkill) {
    return {
      id,
      groupId,
      type,
      eventSubject,
      skillKeys: normalizeConditionKeyList(value?.skillKeys, value?.skillKey)
    };
  }

  if (type === ABILITY_CONDITION_TYPES.weaponProficiency) {
    return {
      id,
      groupId,
      type,
      eventSubject,
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
    const rawLimit = value?.limit ?? value?.count ?? 1;
    const legacyLimit = Math.max(1, toInteger(rawLimit));
    const rawFormula = value?.limitFormula ?? value?.formula
      ?? (typeof rawLimit === "string" && !Number.isFinite(Number(rawLimit)) ? rawLimit : String(legacyLimit));
    return {
      id,
      groupId,
      type,
      operator: "lte",
      percent: 50,
      equipmentSlotKey: "",
      healthTarget: ABILITY_HEALTH_TARGETS.general,
      limbKey: ABILITY_HEALTH_LIMB_ALL,
      // `limit` remains as a numeric compatibility field for old sheets and
      // migrations.  New constructors may use an actor formula instead.
      limit: legacyLimit,
      limitFormula: normalizeFormulaText(rawFormula, String(legacyLimit)),
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

  if (type === ABILITY_CONDITION_TYPES.duration) {
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

  if (type === ABILITY_CONDITION_TYPES.energyConsumption) {
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
      name: String(value?.name ?? "").trim(),
      amountPerHour: Math.max(0, toNumber(value?.amountPerHour ?? value?.amount ?? 0)),
      durationSeconds: 0
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
      eventSubject,
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
    eventSubject,
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

function normalizeEventReactionDepthFilterMap(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, entries]) => [
    String(key ?? "").trim(),
    normalizeStringList(entries)
  ]).filter(([key]) => Boolean(key)));
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

function normalizeEventTrackingTargets(value = []) {
  return normalizeStringList(value).filter(group => ABILITY_EVENT_TRACKING_TARGETS.includes(group));
}

function normalizeFormulaText(value = "", fallback = "0") {
  return String(value ?? "").trim() || fallback;
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return Boolean(fallback);
  if (Array.isArray(value)) {
    const selected = value.findLast(entry => entry !== undefined && entry !== null && entry !== "");
    return normalizeBoolean(selected, fallback);
  }
  if (typeof value === "string") return value === "true";
  return Boolean(value);
}

function normalizeOptionalSeconds(value) {
  if (value === "" || value === undefined || value === null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : null;
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
  if (normalizedKey === ABILITY_FIXED_FUNCTION_KEYS.aiming) {
    return normalizeAimingSettings(value);
  }
  if (normalizedKey === ABILITY_FIXED_FUNCTION_KEYS.ricochet) {
    return normalizeRicochetSettings(value);
  }
  if (normalizedKey === ABILITY_FIXED_FUNCTION_KEYS.keepAway) {
    return normalizeKeepAwaySettings(value);
  }
  if ([ABILITY_FIXED_FUNCTION_KEYS.lethalShot, ABILITY_FIXED_FUNCTION_KEYS.lethalStrike].includes(normalizedKey)) {
    return normalizeLethalAttackSettings(value);
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
  if (normalizedKey === ABILITY_FIXED_FUNCTION_KEYS.oversight) {
    return normalizeOversightSettings(value);
  }
  if (normalizedKey === ABILITY_FIXED_FUNCTION_KEYS.watchOut) {
    return normalizeWatchOutSettings(value);
  }
  if (normalizedKey === ABILITY_FIXED_FUNCTION_KEYS.fullControl) {
    return normalizeFullControlSettings(value);
  }
  if (normalizedKey === ABILITY_FIXED_FUNCTION_KEYS.counterSniper) {
    return normalizeCounterSniperSettings(value);
  }
  if (normalizedKey === ABILITY_FIXED_FUNCTION_KEYS.whereAreYouGoing) {
    return normalizeWhereAreYouGoingSettings(value);
  }
  if (normalizedKey === ABILITY_FIXED_FUNCTION_KEYS.fullForce) {
    return normalizeFullForceSettings(value);
  }
  if (normalizedKey === ABILITY_FIXED_FUNCTION_KEYS.twoHands) {
    return normalizeTwoHandsSettings(value);
  }
  if (normalizedKey === ABILITY_FIXED_FUNCTION_KEYS.commandBasics) {
    return normalizeCommandBasicsSettings(value);
  }
  if (normalizedKey === ABILITY_FIXED_FUNCTION_KEYS.knockOffBalance) {
    return normalizeKnockOffBalanceSettings(value);
  }
  if (normalizedKey === ABILITY_FIXED_FUNCTION_KEYS.look) {
    return normalizeLookSettings(value);
  }
  if (normalizedKey === ABILITY_FIXED_FUNCTION_KEYS.toTheEnd) {
    return normalizeToTheEndSettings(value);
  }
  if (normalizedKey === ABILITY_FIXED_FUNCTION_KEYS.heightenedConcentration) {
    return normalizeHeightenedConcentrationSettings(value);
  }
  if (normalizedKey === ABILITY_FIXED_FUNCTION_KEYS.grapplingMaster) {
    return normalizeGrapplingMasterSettings(value);
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

export function normalizeGrapplingMasterSettings(value = {}) {
  return {
    checkDifficultyBonus: Math.max(0, toInteger(value?.checkDifficultyBonus ?? 50)),
    targetAttackDisadvantageBonus: Math.max(0, toInteger(value?.targetAttackDisadvantageBonus ?? 1))
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

export function normalizeAimingSettings(value = {}) {
  return {
    energyCost: Math.max(0, toInteger(value?.energyCost ?? 20)),
    innateDifficultyIgnorePercent: Math.max(1, Math.min(100, toInteger(value?.innateDifficultyIgnorePercent ?? 100)))
  };
}

export function normalizeKeepAwaySettings(value = {}) {
  return {
    activationEnergyCost: Math.max(0, toInteger(value?.activationEnergyCost ?? 10)),
    overloadEnergyCost: Math.max(0, toInteger(value?.overloadEnergyCost ?? 10)),
    overloadDurationSeconds: Math.max(0, toInteger(value?.overloadDurationSeconds ?? 6)),
    baseDifficulty: Math.max(0, toInteger(value?.baseDifficulty ?? 50)),
    lostHealthPercentMultiplier: Math.max(0, toNumber(value?.lostHealthPercentMultiplier ?? 2.5))
  };
}

export function createOversightAbilityCatalogEntry() {
  return normalizeAbilityEntry({
    id: "fixed-oversight",
    name: "Надзор",
    img: "icons/svg/eye.svg",
    visible: true,
    description: "<p>Активная боевая способность: цель проверяет Скрытность против 50 + Натуралист. При провале получает метку и снижение восстановления уклонения; каждые потраченные 5 ОП/ОД/ОР открывают реакционную атаку.</p>",
    system: {
      cost: 0,
      formula: "",
      acquisition: { onlyFree: false, onlyManual: false, skillKey: "naturalist", difficulty: 60 },
      acquisitionRequirements: [],
      functions: [{
        id: "fixed-oversight-function",
        type: ABILITY_FUNCTION_TYPES.fixed,
        fixedKey: ABILITY_FIXED_FUNCTION_KEYS.oversight,
        fixedSettings: normalizeOversightSettings(),
        changes: [], conditions: [], penalties: []
      }]
    }
  });
}

export function createWatchOutAbilityCatalogEntry() {
  return normalizeAbilityEntry({
    id: "fixed-watch-out",
    name: "Берегись!",
    img: "icons/svg/shield.svg",
    visible: true,
    description: "<p>Реакция на атаку по другому союзнику: если вы видите атакующего и цель, повышает сложность всех проверок попадания текущей атаки на 10 + Натуралист / 10. Активация способности настраивает минимальный исходный шанс попадания.</p>",
    system: {
      cost: 0,
      formula: "",
      acquisition: { onlyFree: false, onlyManual: false, skillKey: "naturalist", difficulty: 60 },
      acquisitionRequirements: [],
      functions: [{
        id: "fixed-watch-out-function",
        type: ABILITY_FUNCTION_TYPES.fixed,
        fixedKey: ABILITY_FIXED_FUNCTION_KEYS.watchOut,
        fixedSettings: normalizeWatchOutSettings(),
        changes: [], conditions: [], penalties: []
      }]
    }
  });
}

export function createDangerSenseAbilityCatalogEntry() {
  return normalizeAbilityEntry({
    id: "fixed-danger-sense",
    name: "Чутье",
    img: "icons/svg/aura.svg",
    visible: true,
    description: "<p>Пассивная способность: при провале обнаружения ловушки или скрытого противника владелец получает предупреждение, что рядом есть опасность.</p>",
    system: {
      cost: 0,
      formula: "",
      acquisition: { onlyFree: false, onlyManual: false, skillKey: "naturalist", difficulty: 60 },
      acquisitionRequirements: [],
      functions: [{
        id: "fixed-danger-sense-function",
        type: ABILITY_FUNCTION_TYPES.fixed,
        fixedKey: ABILITY_FIXED_FUNCTION_KEYS.dangerSense,
        fixedSettings: {},
        changes: [], conditions: [], penalties: []
      }]
    }
  });
}

export function createFullControlAbilityCatalogEntry() {
  return normalizeAbilityEntry({
    id: "fixed-full-control",
    name: "Полный контроль",
    img: "icons/svg/upgrade.svg",
    visible: true,
    description: "<p>Активная способность: на 24 часа перераспределяет характеристики в максимум энергии и обратно. Общий лимит изменений зависит от Контроля энергии.</p>",
    system: {
      cost: 0,
      formula: "",
      acquisition: { onlyFree: false, onlyManual: false, skillKey: "energy", difficulty: 60 },
      acquisitionRequirements: [],
      functions: [{
        id: "fixed-full-control-function",
        type: ABILITY_FUNCTION_TYPES.fixed,
        fixedKey: ABILITY_FIXED_FUNCTION_KEYS.fullControl,
        fixedSettings: normalizeFullControlSettings(),
        changes: [], conditions: [], penalties: []
      }]
    }
  });
}

export function createHeightenedConcentrationAbilityCatalogEntry() {
  return normalizeAbilityEntry({
    id: "fixed-heightened-concentration",
    name: "Повышенная концентрация",
    img: "icons/svg/aura.svg",
    visible: true,
    description: "<p>Активная способность: за 20 энергии следующие 3 проверки Натуралиста получают преимущество. Перегрузка: +40 энергии на 1 час.</p>",
    system: {
      cost: 0,
      formula: "",
      acquisition: { onlyFree: false, onlyManual: false, skillKey: "naturalist", difficulty: 60 },
      acquisitionRequirements: [],
      functions: [{
        id: "fixed-heightened-concentration-function",
        type: ABILITY_FUNCTION_TYPES.fixed,
        fixedKey: ABILITY_FIXED_FUNCTION_KEYS.heightenedConcentration,
        fixedSettings: normalizeHeightenedConcentrationSettings(),
        changes: [], conditions: [], penalties: []
      }]
    }
  });
}

export function normalizeRicochetSettings(value = {}) {
  return {
    activationEnergyCost: Math.max(0, toInteger(value?.activationEnergyCost ?? 20)),
    overloadEnergyCost: Math.max(0, toInteger(value?.overloadEnergyCost ?? 20)),
    overloadDurationSeconds: Math.max(0, toInteger(value?.overloadDurationSeconds ?? 12)),
    maxReflections: Math.max(0, toInteger(value?.maxReflections ?? 3)),
    accuracyBonusPerReflection: toInteger(value?.accuracyBonusPerReflection ?? 10),
    damagePercentBonusPerReflection: toInteger(value?.damagePercentBonusPerReflection ?? 10)
  };
}

export function normalizeLethalAttackSettings(value = {}) {
  return {
    activationEnergyCost: Math.max(0, toInteger(value?.activationEnergyCost ?? 40)),
    overloadEnergyCost: Math.max(0, toInteger(value?.overloadEnergyCost ?? 100)),
    overloadDurationSeconds: Math.max(0, toInteger(value?.overloadDurationSeconds ?? 3600)),
    damagePercentBonus: Math.max(0, toInteger(value?.damagePercentBonus ?? 200)),
    attackWaitDurationSeconds: Math.max(0, toInteger(value?.attackWaitDurationSeconds ?? 12))
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

export function normalizeOversightSettings(value = {}) {
  return {
    energyCost: Math.max(0, toInteger(value?.energyCost ?? 20)),
    overloadEnergyCost: Math.max(0, toInteger(value?.overloadEnergyCost ?? 100)),
    overloadDurationSeconds: Math.max(0, toInteger(value?.overloadDurationSeconds ?? 60)),
    difficultyBase: toInteger(value?.difficultyBase ?? 50),
    sourceSkillKey: String(value?.sourceSkillKey ?? "naturalist").trim() || "naturalist",
    targetSkillKey: String(value?.targetSkillKey ?? "stealth").trim() || "stealth",
    dodgeRecoveryDivisor: Math.max(1, toInteger(value?.dodgeRecoveryDivisor ?? 10)),
    resourceThreshold: Math.max(1, toInteger(value?.resourceThreshold ?? 5))
  };
}

export function normalizeWatchOutSettings(value = {}) {
  return {
    reactionEnergyCost: Math.max(0, toInteger(value?.reactionEnergyCost ?? 10)),
    reactionOverloadEnergyCost: Math.max(0, toInteger(value?.reactionOverloadEnergyCost ?? 30)),
    reactionOverloadDurationSeconds: Math.max(0, toInteger(value?.reactionOverloadDurationSeconds ?? 6)),
    difficultyBase: toInteger(value?.difficultyBase ?? 10),
    sourceSkillKey: String(value?.sourceSkillKey ?? "naturalist").trim() || "naturalist",
    skillDivisor: Math.max(1, toInteger(value?.skillDivisor ?? 10)),
    defaultMinimumHitChancePercent: Math.max(1, Math.min(100, toInteger(value?.defaultMinimumHitChancePercent ?? 1)))
  };
}

export function normalizeFullControlSettings(value = {}) {
  return {
    limitSkillKey: String(value?.limitSkillKey ?? "energy").trim() || "energy",
    baseChangeLimit: Math.max(0, toInteger(value?.baseChangeLimit ?? 4)),
    skillDivisor: Math.max(1, toInteger(value?.skillDivisor ?? 50)),
    energyPerCharacteristicPoint: Math.max(0, toInteger(value?.energyPerCharacteristicPoint ?? 20)),
    durationSeconds: Math.max(0, toInteger(value?.durationSeconds ?? 86400))
  };
}

export function normalizeCounterSniperSettings(value = {}) {
  return {
    reactionEnergyCost: Math.max(0, toInteger(value?.reactionEnergyCost ?? value?.energyCost ?? 20)),
    reactionOverloadEnergyCost: Math.max(0, toInteger(value?.reactionOverloadEnergyCost ?? value?.overloadEnergyCost ?? 40)),
    reactionOverloadDurationSeconds: Math.max(0, toInteger(value?.reactionOverloadDurationSeconds ?? value?.overloadDurationSeconds ?? 12))
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

export function normalizeTwoHandsSettings(value = {}) {
  return {
    energyCost: Math.max(0, toInteger(value?.energyCost ?? 10))
  };
}

export function normalizeCommandBasicsSettings(value = {}) {
  return {
    energyCost: Math.max(0, toInteger(value?.energyCost ?? 30)),
    overloadEnergyCost: Math.max(0, toInteger(value?.overloadEnergyCost ?? 100)),
    overloadDurationSeconds: Math.max(0, toInteger(value?.overloadDurationSeconds ?? 12)),
    targetLimitFormula: String(value?.targetLimitFormula ?? "2+speech/50").trim() || "2+speech/50",
    dodgeBonusFormula: String(value?.dodgeBonusFormula ?? "10+speech/10").trim() || "10+speech/10",
    dodgeDurationSeconds: Math.max(0, toInteger(value?.dodgeDurationSeconds ?? 12))
  };
}

export function normalizeKnockOffBalanceSettings(value = {}) {
  return {
    energyCost: Math.max(0, toInteger(value?.energyCost ?? 20)),
    overloadEnergyCost: Math.max(0, toInteger(value?.overloadEnergyCost ?? 20)),
    overloadDurationSeconds: Math.max(0, toInteger(value?.overloadDurationSeconds ?? 12)),
    targetLimitFormula: String(value?.targetLimitFormula ?? "2+speech/50").trim() || "2+speech/50",
    difficultyFormula: String(value?.difficultyFormula ?? "50+speech").trim() || "50+speech",
    targetSkillKey: String(value?.targetSkillKey ?? "science").trim() || "science",
    skillLimitFormula: String(value?.skillLimitFormula ?? "1+speech/100").trim() || "1+speech/100",
    skillDisadvantageCount: Math.max(1, toInteger(value?.skillDisadvantageCount ?? 2)),
    debuffDurationSeconds: Math.max(0, toInteger(value?.debuffDurationSeconds ?? 12))
  };
}

export function normalizeLookSettings(value = {}) {
  return {
    energyCost: Math.max(0, toInteger(value?.energyCost ?? 10)),
    overloadEnergyCost: Math.max(0, toInteger(value?.overloadEnergyCost ?? 20)),
    overloadDurationSeconds: Math.max(0, toInteger(value?.overloadDurationSeconds ?? 12)),
    difficultyFormula: String(value?.difficultyFormula ?? "50+speech").trim() || "50+speech",
    targetSkillKey: String(value?.targetSkillKey ?? "science").trim() || "science",
    failureResourceLoss: Math.max(0, toInteger(value?.failureResourceLoss ?? 3)),
    criticalFailureResourceLoss: Math.max(0, toInteger(value?.criticalFailureResourceLoss ?? 6))
  };
}

export function normalizeToTheEndSettings(value = {}) {
  return {
    energyCost: Math.max(0, toInteger(value?.energyCost ?? 100)),
    overloadEnergyCost: Math.max(0, toInteger(value?.overloadEnergyCost ?? 300)),
    overloadDurationSeconds: Math.max(0, toInteger(value?.overloadDurationSeconds ?? 43200)),
    radiusFormula: String(value?.radiusFormula ?? "20+speech/10").trim() || "20+speech/10",
    healingFormula: String(value?.healingFormula ?? "50+speech").trim() || "50+speech",
    durationSeconds: Math.max(0, toInteger(value?.durationSeconds ?? 18)),
    characteristicBonusFormula: String(value?.characteristicBonusFormula ?? "1+speech/100").trim() || "1+speech/100",
    advantageSkills: normalizeToTheEndAdvantageSkills(value),
    suppressTraumas: normalizeBoolean(value?.suppressTraumas, true)
  };
}

function normalizeToTheEndAdvantageSkills(value = {}) {
  const raw = value?.advantageSkills !== undefined
    ? (Array.isArray(value.advantageSkills) ? value.advantageSkills : Object.values(value.advantageSkills ?? {}))
    : [{
      skillKey: value?.resilienceSkillKey ?? "resilience",
      advantageCount: value?.resilienceAdvantageCount ?? 1
    }];
  const normalized = raw
    .map(entry => ({
      skillKey: String(entry?.skillKey ?? entry?.key ?? "").trim(),
      advantageCount: Math.max(0, toInteger(entry?.advantageCount ?? entry?.count ?? entry?.value ?? 1))
    }))
    .filter(entry => entry.skillKey);
  return normalized.length ? normalized : [{ skillKey: "resilience", advantageCount: 1 }];
}

export function normalizeHeightenedConcentrationSettings(value = {}) {
  return {
    energyCost: Math.max(0, toInteger(value?.energyCost ?? 20)),
    overloadEnergyCost: Math.max(0, toInteger(value?.overloadEnergyCost ?? 40)),
    overloadDurationSeconds: Math.max(0, toInteger(value?.overloadDurationSeconds ?? 3600)),
    skillKey: String(value?.skillKey ?? "naturalist").trim() || "naturalist",
    checkCount: Math.max(1, toInteger(value?.checkCount ?? value?.checks ?? 3)),
    advantageCount: Math.max(1, toInteger(value?.advantageCount ?? 1))
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

