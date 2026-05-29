import { createDefaultSkillSettings, normalizeSkillSettings } from "../formulas/index.mjs";
import { toInteger } from "../utils/numbers.mjs";

export const LOCKED_FEATURES_CATEGORY_ID = "features";
export const GENERAL_ABILITY_CATEGORY_ID = "general";
export const ABILITY_SOURCE_FLAG = "abilitySource";

export const ABILITY_FUNCTION_TYPES = Object.freeze({
  effectChanges: "effectChanges",
  acquisitionChanges: "acquisitionChanges",
  characteristicBonus: "characteristicBonus",
  skillBonus: "skillBonus"
});

export const ABILITY_CONDITION_TYPES = Object.freeze({
  healthPercent: "healthPercent",
  equipmentSlotOccupied: "equipmentSlotOccupied"
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
    description: String(value?.description ?? system.description ?? "").trim(),
    system: {
      cost: Math.max(0, toInteger(system.cost ?? value?.cost)),
      formula: String(system.formula ?? value?.formula ?? "").trim(),
      acquisition: normalizeAbilityAcquisition(system.acquisition ?? value?.acquisition),
      functions: normalizeAbilityFunctions(system.functions ?? value?.functions)
    }
  };
}

export function normalizeAbilityFunctions(value = []) {
  return (Array.isArray(value) ? value : Object.values(value ?? {}))
    .map((entry, index) => normalizeAbilityFunction(entry, index));
}

export function createAbilityFunction(type = ABILITY_FUNCTION_TYPES.effectChanges) {
  return normalizeAbilityFunction({
    id: foundry.utils.randomID(),
    type,
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

function normalizeAbilityCondition(value = {}) {
  const legacyEnabled = Boolean(value?.enabled);
  const rawType = String(value?.type ?? "").trim();
  const type = Object.values(ABILITY_CONDITION_TYPES).includes(rawType)
    ? rawType
    : legacyEnabled ? ABILITY_CONDITION_TYPES.healthPercent : "";
  if (!type) return { id: "", type: "" };

  if (type === ABILITY_CONDITION_TYPES.equipmentSlotOccupied) {
    return {
      id: String(value?.id ?? "").trim() || foundry.utils.randomID(),
      type,
      operator: String(value?.operator ?? "") === ABILITY_EQUIPMENT_OPERATORS.empty
        ? ABILITY_EQUIPMENT_OPERATORS.empty
        : ABILITY_EQUIPMENT_OPERATORS.occupied,
      equipmentSlotKey: String(value?.equipmentSlotKey ?? "").trim(),
      percent: 50
    };
  }

  return {
    id: String(value?.id ?? "").trim() || foundry.utils.randomID(),
    type,
    operator: String(value?.operator ?? "lte") === "gte" ? "gte" : "lte",
    percent: Math.max(0, Math.min(100, toInteger(value?.percent ?? 50))),
    equipmentSlotKey: ""
  };
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

