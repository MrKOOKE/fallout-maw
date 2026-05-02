import { DEFAULT_BASE_PARAMETER_POOLS, DEFAULT_LIMBS, DEFAULT_LOAD_FORMULA } from "../config/defaults.mjs";
import { localize } from "../utils/i18n.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { normalizeFormulaMap } from "../formulas/index.mjs";

export function createEmptyCreatureOptions() {
  return { types: [], races: [] };
}

export function createRaceDefaults(characteristics = [], damageTypes = []) {
  return {
    characteristics: Object.fromEntries(characteristics.map(entry => [entry.key, 1])),
    baseParameters: createDefaultRaceBaseParameters(),
    limbs: createDefaultLimbs(),
    damageResistances: Object.fromEntries(damageTypes.map(entry => [entry.key, "0"])),
    progression: {
      skillPointsPerLevel: 0,
      researchPointsPerLevel: 0
    }
  };
}

export function createDefaultLimbs() {
  return DEFAULT_LIMBS.map(entry => ({ ...entry }));
}

export function createDefaultRaceBaseParameters() {
  return { ...DEFAULT_BASE_PARAMETER_POOLS, loadFormula: DEFAULT_LOAD_FORMULA };
}

export function normalizeCreatureOptions(options = {}, characteristics = [], damageTypes = []) {
  const defaults = createEmptyCreatureOptions();
  const normalized = {
    types: Array.isArray(options?.types) ? options.types : defaults.types,
    races: Array.isArray(options?.races) ? options.races : defaults.races
  };

  normalized.types = normalized.types
    .filter(type => type?.id)
    .map(type => ({
      id: String(type.id),
      name: String(type.name || localize("FALLOUTMAW.Common.Untitled"))
    }));

  const typeIds = new Set(normalized.types.map(type => type.id));
  normalized.races = normalized.races
    .filter(race => race?.id)
    .map(race => {
      const typeId = typeIds.has(race.typeId) ? race.typeId : normalized.types[0]?.id || "";
      return {
        id: String(race.id),
        typeId,
        name: String(race.name || localize("FALLOUTMAW.Common.Untitled")),
        characteristics: normalizeRaceCharacteristics(race.characteristics, characteristics),
        baseParameters: normalizeRaceBaseParameters(race.baseParameters),
        limbs: normalizeLimbs(race.limbs),
        damageResistances: normalizeFormulaMap(race.damageResistances, damageTypes),
        progression: {
          skillPointsPerLevel: toInteger(race.progression?.skillPointsPerLevel),
          researchPointsPerLevel: toInteger(race.progression?.researchPointsPerLevel)
        }
      };
    });

  return normalized;
}

function normalizeRaceCharacteristics(values = {}, characteristics = []) {
  return Object.fromEntries(characteristics.map(definition => [definition.key, toInteger(values?.[definition.key] ?? 1)]));
}

function normalizeRaceBaseParameters(values = {}) {
  const defaults = createDefaultRaceBaseParameters();
  return {
    characteristicDistributionPoints: toInteger(values?.characteristicDistributionPoints ?? defaults.characteristicDistributionPoints),
    signatureSkillPoints: toInteger(values?.signatureSkillPoints ?? defaults.signatureSkillPoints),
    traitPoints: toInteger(values?.traitPoints ?? defaults.traitPoints),
    proficiencyPoints: toInteger(values?.proficiencyPoints ?? defaults.proficiencyPoints),
    loadFormula: String(values?.loadFormula ?? defaults.loadFormula).trim() || defaults.loadFormula
  };
}

function normalizeLimbs(limbs) {
  const limbDataByKey = new Map(
    Array.isArray(limbs)
      ? limbs.map(limb => {
        const key = String(limb?.key ?? "").trim();
        return [key, {
          label: String(limb?.label ?? limb?.name ?? "").trim(),
          stateMax: Math.max(0, toInteger(limb?.stateMax ?? 100))
        }];
      })
      : []
  );

  return createDefaultLimbs().map(limb => ({
    ...limb,
    label: limbDataByKey.get(limb.key)?.label || limb.label,
    stateMax: limbDataByKey.get(limb.key)?.stateMax ?? limb.stateMax
  }));
}
