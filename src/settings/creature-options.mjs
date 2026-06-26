import {
  DEFAULT_BASE_PARAMETER_POOLS,
  DEFAULT_EQUIPMENT_SLOTS,
  DEFAULT_INVENTORY_SIZE,
  DEFAULT_LIMBS,
  DEFAULT_LOAD_FORMULA,
  DEFAULT_LOAD_LIMIT_PERCENT,
  DEFAULT_PROFICIENCY_POINTS_PER_LEVEL_FORMULA,
  DEFAULT_RESEARCH_POINTS_PER_LEVEL_FORMULA,
  DEFAULT_SKILL_POINTS_PER_LEVEL_FORMULA,
  DEFAULT_WEAPON_SETS
} from "../config/defaults.mjs";
import { localize } from "../utils/i18n.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { createDefaultNeedSettings, normalizeFormulaMap, normalizeNeedSettings } from "../formulas/index.mjs";
import { normalizeLimbSilhouette } from "../utils/limb-silhouette.mjs";
import { createDefaultNaturalItemSetEntry, normalizeNaturalItemSetEntries } from "../races/natural-items.mjs";

export const DEFAULT_BLEEDING_RESISTANCE_FORMULA = "0";
export const DEFAULT_REGENERATION_FORMULA = "10 + con * 5";

export function createEmptyCreatureOptions() {
  return { types: [], races: [] };
}

export function createRaceDefaults(characteristics = [], damageTypes = []) {
  return {
    characteristics: Object.fromEntries(characteristics.map(entry => [entry.key, 1])),
    baseParameters: createDefaultRaceBaseParameters(),
    limbs: createDefaultLimbs(),
    limbSilhouette: null,
    equipmentSlots: createDefaultEquipmentSlots(),
    weaponSets: createDefaultWeaponSets(),
    naturalItemSets: [createDefaultNaturalItemSetEntry()],
    inventorySize: createDefaultInventorySize(),
    regeneration: createDefaultRegeneration(),
    bleedingResistanceFormula: DEFAULT_BLEEDING_RESISTANCE_FORMULA,
    damageResistances: Object.fromEntries(damageTypes.map(entry => [entry.key, "0"])),
    needSettings: createDefaultNeedSettings(),
    progression: {
      skillPointsPerLevel: DEFAULT_SKILL_POINTS_PER_LEVEL_FORMULA,
      researchPointsPerLevel: DEFAULT_RESEARCH_POINTS_PER_LEVEL_FORMULA,
      proficiencyPointsPerLevel: DEFAULT_PROFICIENCY_POINTS_PER_LEVEL_FORMULA
    }
  };
}

export function createDefaultLimbs() {
  return DEFAULT_LIMBS.map(entry => ({
    ...entry,
    lossEffects: cloneLimbLossEffects(entry.lossEffects)
  }));
}

export function createDefaultEquipmentSlots() {
  return DEFAULT_EQUIPMENT_SLOTS.map(entry => ({ ...entry }));
}

export function createDefaultWeaponSets() {
  return DEFAULT_WEAPON_SETS.map(set => ({
    ...set,
    slots: set.slots.map(slot => ({ ...slot }))
  }));
}

export function createDefaultInventorySize() {
  return { ...DEFAULT_INVENTORY_SIZE };
}

export function createDefaultRaceBaseParameters() {
  return { ...DEFAULT_BASE_PARAMETER_POOLS, loadFormula: DEFAULT_LOAD_FORMULA, loadLimitPercent: DEFAULT_LOAD_LIMIT_PERCENT };
}

export function createDefaultRegeneration() {
  return { formula: DEFAULT_REGENERATION_FORMULA };
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
      const limbs = normalizeLimbs(race.limbs);
      const limbSilhouette = normalizeLimbSilhouette(race.limbSilhouette, limbs);
      return {
        id: String(race.id),
        typeId,
        name: String(race.name || localize("FALLOUTMAW.Common.Untitled")),
        characteristics: normalizeRaceCharacteristics(race.characteristics, characteristics),
        baseParameters: normalizeRaceBaseParameters(race.baseParameters),
        limbs,
        limbSilhouette,
        equipmentSlots: normalizeEquipmentSlots(race.equipmentSlots),
        weaponSets: normalizeWeaponSets(race.weaponSets, limbs),
        naturalItemSets: normalizeNaturalItemSetEntries(race.naturalItemSets, race.naturalWeapons, race.naturalFeatures),
        inventorySize: normalizeInventorySize(race.inventorySize),
        regeneration: normalizeRegeneration(race.regeneration),
        bleedingResistanceFormula: normalizeBleedingResistanceFormula(race.bleedingResistanceFormula),
        damageResistances: normalizeFormulaMap(race.damageResistances, damageTypes),
        needSettings: normalizeRaceNeedSettings(race.needSettings),
        progression: {
          skillPointsPerLevel: normalizeProgressionFormula(
            race.progression?.skillPointsPerLevel,
            DEFAULT_SKILL_POINTS_PER_LEVEL_FORMULA
          ),
          researchPointsPerLevel: normalizeProgressionFormula(
            race.progression?.researchPointsPerLevel,
            DEFAULT_RESEARCH_POINTS_PER_LEVEL_FORMULA
          ),
          proficiencyPointsPerLevel: normalizeProgressionFormula(
            race.progression?.proficiencyPointsPerLevel,
            DEFAULT_PROFICIENCY_POINTS_PER_LEVEL_FORMULA
          )
        }
      };
    });

  return normalized;
}

function normalizeBleedingResistanceFormula(value) {
  return String(value ?? DEFAULT_BLEEDING_RESISTANCE_FORMULA).trim() || DEFAULT_BLEEDING_RESISTANCE_FORMULA;
}

function normalizeRegeneration(value = {}) {
  return {
    formula: String(value?.formula ?? DEFAULT_REGENERATION_FORMULA).trim() || DEFAULT_REGENERATION_FORMULA
  };
}

function normalizeRaceCharacteristics(values = {}, characteristics = []) {
  return Object.fromEntries(characteristics.map(definition => [definition.key, toInteger(values?.[definition.key] ?? 1)]));
}

function normalizeRaceNeedSettings(settings) {
  const normalized = normalizeNeedSettings(settings);
  const byKey = new Map(normalized.map(need => [need.key, need]));
  for (const need of createDefaultNeedSettings()) {
    if (!byKey.has(need.key)) byKey.set(need.key, need);
  }
  return Array.from(byKey.values());
}

function normalizeRaceBaseParameters(values = {}) {
  const defaults = createDefaultRaceBaseParameters();
  return {
    characteristicDistributionPoints: toInteger(values?.characteristicDistributionPoints ?? defaults.characteristicDistributionPoints),
    signatureSkillPoints: toInteger(values?.signatureSkillPoints ?? defaults.signatureSkillPoints),
    traitPoints: toInteger(values?.traitPoints ?? defaults.traitPoints),
    proficiencyPoints: toInteger(values?.proficiencyPoints ?? defaults.proficiencyPoints),
    loadFormula: String(values?.loadFormula ?? defaults.loadFormula).trim() || defaults.loadFormula,
    loadLimitPercent: Math.max(0, toInteger(values?.loadLimitPercent ?? defaults.loadLimitPercent))
  };
}

function normalizeProgressionFormula(value, fallback) {
  return String(value ?? fallback).trim() || fallback;
}

function normalizeLimbs(limbs) {
  const defaults = createDefaultLimbs();
  const defaultsByKey = new Map(defaults.map(limb => [limb.key, limb]));
  const source = Array.isArray(limbs) && limbs.length ? limbs : defaults;
  const usedKeys = new Set();

  return source
    .map((limb, index) => {
      const fallback = defaults[index]?.key ?? `limb${index + 1}`;
      const key = normalizeConfigKey(limb?.key, fallback);
      if (!key || usedKeys.has(key)) return null;
      usedKeys.add(key);
      const defaultLimb = defaultsByKey.get(key);
      const critical = parseBoolean(limb?.critical, Boolean(defaultLimb?.critical));
      const rawStateMax = String(limb?.stateMax ?? defaultLimb?.stateMax ?? "100").trim() || "100";
      const stateMax = defaultLimb && rawStateMax === "100"
        ? String(defaultLimb.stateMax ?? rawStateMax)
        : rawStateMax;
      return {
        key,
        label: String(limb?.label ?? limb?.name ?? "").trim() || defaultLimb?.label || localize("FALLOUTMAW.Common.Untitled"),
        stateMax,
        damageMultiplier: toDecimal(limb?.damageMultiplier ?? defaultLimb?.damageMultiplier ?? 1, 1),
        aimedDifficultyPercent: toInteger(limb?.aimedDifficultyPercent ?? defaultLimb?.aimedDifficultyPercent ?? 0),
        implantLimit: Math.max(0, toInteger(limb?.implantLimit ?? defaultLimb?.implantLimit ?? 1)),
        critical,
        lossEffects: critical
          ? []
          : normalizeLimbLossEffects(limb?.lossEffects ?? defaultLimb?.lossEffects)
      };
    })
    .filter(Boolean);
}

function normalizeLimbLossEffects(value = []) {
  const effects = Array.isArray(value) ? value : Object.values(value ?? {});
  return effects
    .map(effect => ({
      key: String(effect?.key ?? "").trim(),
      type: ["add", "multiply", "override"].includes(String(effect?.type ?? "")) ? String(effect.type) : "add",
      value: String(effect?.value ?? "0"),
      phase: String(effect?.phase || "initial"),
      priority: effect?.priority === "" || effect?.priority === null || effect?.priority === undefined
        ? null
        : toInteger(effect.priority)
    }))
    .filter(effect => effect.key);
}

function cloneLimbLossEffects(value = []) {
  return normalizeLimbLossEffects(value).map(effect => ({ ...effect }));
}

function normalizeEquipmentSlots(slots) {
  const source = Array.isArray(slots) && slots.length ? slots : createDefaultEquipmentSlots();
  return source
    .map((slot, index) => ({
      key: normalizeConfigKey(slot?.key, `equipmentSlot${index + 1}`),
      label: String(slot?.label ?? slot?.name ?? "").trim() || localize("FALLOUTMAW.Common.Untitled")
    }))
    .filter(slot => slot.key);
}

function normalizeWeaponSets(sets, limbs = []) {
  const limbKeys = new Set(limbs.map(limb => limb.key));
  const fallbackLimbKey = limbs[0]?.key ?? "";
  const source = Array.isArray(sets) && sets.length ? sets : createDefaultWeaponSets();

  return source
    .map((set, index) => ({
      key: normalizeConfigKey(set?.key, `weaponSet${index + 1}`),
      label: String(set?.label ?? set?.name ?? "").trim() || localize("FALLOUTMAW.Common.Untitled"),
      slots: normalizeWeaponSlots(set?.slots, limbKeys, fallbackLimbKey)
    }))
    .filter(set => set.key);
}

function normalizeWeaponSlots(slots, limbKeys, fallbackLimbKey) {
  const source = Array.isArray(slots) && slots.length
    ? slots
    : [
      { key: "rightHand", limbKey: "rightArm" },
      { key: "leftHand", limbKey: "leftArm" }
    ];

  return source
    .map((slot, index) => {
      const preferredLimbKey = String(slot?.limbKey ?? "").trim();
      const limbKey = limbKeys.has(preferredLimbKey) ? preferredLimbKey : fallbackLimbKey;
      return {
        key: normalizeConfigKey(slot?.key, `weaponSlot${index + 1}`),
        limbKey
      };
    })
    .filter(slot => slot.key);
}

function normalizeInventorySize(size = {}) {
  const defaults = createDefaultInventorySize();
  return {
    columns: Math.max(1, toInteger(size?.columns ?? defaults.columns)),
    rows: Math.max(1, toInteger(size?.rows ?? defaults.rows))
  };
}

function normalizeConfigKey(value, fallback) {
  return String(value ?? fallback).trim().replace(/\s+/g, "");
}

function toDecimal(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (Array.isArray(value)) return value.some(entry => parseBoolean(entry, false));
  if (typeof value === "boolean") return value;
  return ["true", "1", "yes", "on"].includes(String(value).trim().toLowerCase());
}
