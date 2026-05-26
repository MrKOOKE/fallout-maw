import { createDefaultSkillSettings, normalizeSkillSettings } from "../formulas/index.mjs";
import { toInteger } from "../utils/numbers.mjs";

export const LOCKED_FEATURES_CATEGORY_ID = "features";
export const GENERAL_ABILITY_CATEGORY_ID = "general";
export const ABILITY_SOURCE_FLAG = "abilitySource";
export const ABILITY_FUNCTION_TYPES = Object.freeze({
  characteristicBonus: "characteristicBonus",
  skillBonus: "skillBonus"
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

export function createAbilityFunction(type = ABILITY_FUNCTION_TYPES.characteristicBonus) {
  return normalizeAbilityFunction({
    id: foundry.utils.randomID(),
    type,
    target: "",
    value: 0,
    condition: {
      enabled: false,
      resource: "health",
      operator: "lte",
      percent: 50
    }
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
  const type = Object.values(ABILITY_FUNCTION_TYPES).includes(value?.type)
    ? value.type
    : ABILITY_FUNCTION_TYPES.characteristicBonus;
  const condition = value?.condition ?? {};
  return {
    id: String(value?.id ?? "").trim() || foundry.utils.randomID(),
    type,
    target: String(value?.target ?? "").trim(),
    value: toInteger(value?.value),
    condition: {
      enabled: Boolean(condition?.enabled),
      resource: "health",
      operator: String(condition?.operator ?? "lte") === "gte" ? "gte" : "lte",
      percent: Math.max(0, Math.min(100, toInteger(condition?.percent ?? 50)))
    },
    sort: index
  };
}
