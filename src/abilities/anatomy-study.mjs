import { SYSTEM_ID } from "../constants.mjs";
import {
  ABILITY_FIXED_FUNCTION_KEYS,
  ABILITY_FUNCTION_TYPES,
  normalizeAnatomyStudySettings
} from "../settings/abilities.mjs";
import { getActiveRulesProfile } from "../settings/rules-profiles.mjs";
import { evaluateActorFormula } from "../utils/actor-formulas.mjs";

const FIXED_FUNCTION_STATE_FLAG_KEY = "abilityFixedFunctionState";

export const ANATOMY_STUDY_BONUS_KEYS = Object.freeze({
  damage: "damage",
  accuracy: "accuracy",
  criticalChance: "criticalChance",
  criticalDamage: "criticalDamage",
  drugEffectiveness: "drugEffectiveness",
  treatmentEffectiveness: "treatmentEffectiveness"
});

const ANATOMY_STUDY_BONUS_DEFINITIONS = Object.freeze([
  Object.freeze({ key: ANATOMY_STUDY_BONUS_KEYS.damage, label: "Урон", settingKey: "damagePercentBonus", suffix: "%" }),
  Object.freeze({ key: ANATOMY_STUDY_BONUS_KEYS.accuracy, label: "Точность", settingKey: "accuracyBonus", suffix: "" }),
  Object.freeze({ key: ANATOMY_STUDY_BONUS_KEYS.criticalChance, label: "Шанс на крит", settingKey: "criticalChanceBonus", suffix: "%" }),
  Object.freeze({ key: ANATOMY_STUDY_BONUS_KEYS.criticalDamage, label: "Критический урон", settingKey: "criticalDamagePercentBonus", suffix: "%" }),
  Object.freeze({ key: ANATOMY_STUDY_BONUS_KEYS.drugEffectiveness, label: "Эффективность препаратов", settingKey: "drugEffectivenessPercentBonus", suffix: "%" }),
  Object.freeze({ key: ANATOMY_STUDY_BONUS_KEYS.treatmentEffectiveness, label: "Лечение здоровья, травм и болезней", settingKey: "treatmentEffectivenessPercentBonus", suffix: "%" })
]);

const VALID_ANATOMY_STUDY_BONUS_KEYS = new Set(ANATOMY_STUDY_BONUS_DEFINITIONS.map(entry => entry.key));

export function getAnatomyStudyBonusDefinitions(settings = {}) {
  const normalized = normalizeAnatomyStudySettings(settings);
  return ANATOMY_STUDY_BONUS_DEFINITIONS.map(definition => {
    const value = Math.max(0, Number(normalized[definition.settingKey]) || 0);
    return {
      ...definition,
      value,
      valueLabel: `+${value}${definition.suffix}`
    };
  });
}

export function getAnatomyStudyMemoryCapacity(actor = null, settings = {}) {
  const normalized = normalizeAnatomyStudySettings(settings);
  return Math.max(0, Math.floor(evaluateActorFormula(normalized.memoryFormula, actor, {
    fallback: 10,
    minimum: 0,
    context: "anatomy study memory"
  })));
}

export function getAnatomyStudyFunctionState(abilityItem = null, abilityFunction = {}) {
  const state = getFixedAbilityState(abilityItem);
  return normalizeAnatomyStudyKnowledge(state[getFixedFunctionStateKey(abilityFunction)]);
}

export function normalizeAnatomyStudyKnowledge(value = {}) {
  const sourceRaces = Array.isArray(value?.races)
    ? value.races
    : Object.entries(value?.races ?? {}).map(([raceId, race]) => ({ raceId, ...race }));
  const races = [];
  const seenRaces = new Set();
  for (const sourceRace of sourceRaces) {
    const raceId = String(sourceRace?.raceId ?? "").trim();
    if (!raceId || seenRaces.has(raceId)) continue;
    const bonuses = Array.from(new Set((Array.isArray(sourceRace?.bonuses)
      ? sourceRace.bonuses
      : Object.keys(sourceRace?.bonuses ?? {}).filter(key => sourceRace.bonuses[key]))
      .map(key => String(key ?? "").trim())
      .filter(key => VALID_ANATOMY_STUDY_BONUS_KEYS.has(key))));
    if (!bonuses.length) continue;
    seenRaces.add(raceId);
    races.push({ raceId, bonuses });
  }
  return {
    fixedKey: ABILITY_FIXED_FUNCTION_KEYS.anatomyStudy,
    races
  };
}

export function getAnatomyStudyMemoryUsage(knowledge = {}) {
  return normalizeAnatomyStudyKnowledge(knowledge).races
    .reduce((total, race) => total + race.bonuses.length, 0);
}

export function getAnatomyStudyRaceBonusKeys(knowledge = {}, raceId = "") {
  const key = String(raceId ?? "").trim();
  if (!key) return [];
  return normalizeAnatomyStudyKnowledge(knowledge).races
    .find(race => race.raceId === key)?.bonuses ?? [];
}

export function getAnatomyStudyAvailableBonusKeys(knowledge = {}, raceId = "") {
  const learned = new Set(getAnatomyStudyRaceBonusKeys(knowledge, raceId));
  return ANATOMY_STUDY_BONUS_DEFINITIONS
    .map(entry => entry.key)
    .filter(key => !learned.has(key));
}

export function buildAnatomyStudyKnowledgeUpdate({
  abilityItem = null,
  abilityFunction = {},
  actor = abilityItem?.parent ?? null,
  raceId = "",
  bonusKey = "",
  remove = false
} = {}) {
  const normalizedRaceId = String(raceId ?? "").trim();
  const normalizedBonusKey = String(bonusKey ?? "").trim();
  if (!normalizedRaceId || !VALID_ANATOMY_STUDY_BONUS_KEYS.has(normalizedBonusKey)) {
    return { ok: false, reason: "Некорректное направление исследования.", state: null };
  }

  const rootState = cloneValue(getFixedAbilityState(abilityItem));
  const stateKey = getFixedFunctionStateKey(abilityFunction);
  const knowledge = getAnatomyStudyFunctionState(abilityItem, abilityFunction);
  const races = knowledge.races.map(race => ({ ...race, bonuses: [...race.bonuses] }));
  const race = races.find(entry => entry.raceId === normalizedRaceId);
  const learned = race?.bonuses.includes(normalizedBonusKey) === true;

  if (remove) {
    if (!learned) return { ok: false, reason: "Это знание уже отсутствует.", state: null };
    race.bonuses = race.bonuses.filter(key => key !== normalizedBonusKey);
    const nextRaces = races.filter(entry => entry.bonuses.length);
    rootState[stateKey] = {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.anatomyStudy,
      races: nextRaces
    };
    return { ok: true, state: rootState, knowledge: rootState[stateKey] };
  }

  if (learned) return { ok: false, reason: "Это направление для расы уже изучено.", state: null };
  const capacity = getAnatomyStudyMemoryCapacity(actor, abilityFunction?.fixedSettings);
  if (getAnatomyStudyMemoryUsage(knowledge) >= capacity) {
    return { ok: false, reason: `Память заполнена (${capacity}/${capacity}).`, state: null };
  }
  if (race) race.bonuses.push(normalizedBonusKey);
  else races.push({ raceId: normalizedRaceId, bonuses: [normalizedBonusKey] });
  rootState[stateKey] = {
    fixedKey: ABILITY_FIXED_FUNCTION_KEYS.anatomyStudy,
    races
  };
  return { ok: true, state: rootState, knowledge: rootState[stateKey] };
}

export function getActorAnatomyStudyRaceBonuses(actor = null) {
  const byRace = new Map();
  if (!actor || getActiveRulesProfile().fixedAbilityFunctionsEnabled === false) return byRace;
  for (const abilityItem of actor.items ?? []) {
    if (abilityItem?.type !== "ability") continue;
    for (const abilityFunction of abilityItem.system?.functions ?? []) {
      if (
        abilityFunction.type !== ABILITY_FUNCTION_TYPES.fixed
        || abilityFunction.fixedKey !== ABILITY_FIXED_FUNCTION_KEYS.anatomyStudy
      ) continue;
      const definitions = getAnatomyStudyBonusDefinitions(abilityFunction.fixedSettings);
      const valuesByKey = new Map(definitions.map(definition => [definition.key, definition.value]));
      for (const race of getAnatomyStudyFunctionState(abilityItem, abilityFunction).races) {
        const bonuses = byRace.get(race.raceId) ?? createEmptyAnatomyStudyBonuses();
        for (const bonusKey of race.bonuses) {
          bonuses[bonusKey] = Math.max(bonuses[bonusKey] ?? 0, valuesByKey.get(bonusKey) ?? 0);
        }
        byRace.set(race.raceId, bonuses);
      }
    }
  }
  return byRace;
}

export function getActorAnatomyStudyBonus(actor = null, targetActor = null, bonusKey = "") {
  const raceId = getActorRaceId(targetActor);
  const key = String(bonusKey ?? "").trim();
  if (!raceId || !VALID_ANATOMY_STUDY_BONUS_KEYS.has(key)) return 0;
  return Math.max(0, Number(getActorAnatomyStudyRaceBonuses(actor).get(raceId)?.[key]) || 0);
}

export function getActorRaceId(actor = null) {
  return String(actor?.system?.creature?.raceId ?? "").trim();
}

export function isActorDeadForAnatomyStudy(actor = null) {
  const defeatedStatus = globalThis.CONFIG?.specialStatusEffects?.DEFEATED;
  return Boolean(
    actor?.statuses?.has?.("dead")
    || (defeatedStatus && actor?.statuses?.has?.(defeatedStatus))
  );
}

function createEmptyAnatomyStudyBonuses() {
  return Object.fromEntries(ANATOMY_STUDY_BONUS_DEFINITIONS.map(entry => [entry.key, 0]));
}

function getFixedAbilityState(abilityItem = null) {
  const state = abilityItem?.getFlag?.(SYSTEM_ID, FIXED_FUNCTION_STATE_FLAG_KEY)
    ?? abilityItem?.flags?.[SYSTEM_ID]?.[FIXED_FUNCTION_STATE_FLAG_KEY];
  return state && typeof state === "object" ? state : {};
}

function getFixedFunctionStateKey(abilityFunction = {}) {
  return [String(abilityFunction?.id ?? ""), String(abilityFunction?.fixedKey ?? "")]
    .filter(Boolean)
    .join(":");
}

function cloneValue(value) {
  if (globalThis.foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
  return structuredClone(value);
}
