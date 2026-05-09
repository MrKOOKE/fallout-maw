import {
  DEFAULT_BASE_PARAMETER_POOLS,
  DEFAULT_EQUIPMENT_SLOTS,
  DEFAULT_INVENTORY_SIZE,
  DEFAULT_LIMBS,
  DEFAULT_LOAD_FORMULA,
  DEFAULT_WEAPON_SETS
} from "../config/defaults.mjs";
import { localize } from "../utils/i18n.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { createDefaultNeedSettings, normalizeFormulaMap, normalizeNeedSettings } from "../formulas/index.mjs";
import { normalizeLimbSilhouette } from "../utils/limb-silhouette.mjs";

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
    inventorySize: createDefaultInventorySize(),
    damageResistances: Object.fromEntries(damageTypes.map(entry => [entry.key, "0"])),
    needSettings: createDefaultNeedSettings(),
    progression: {
      skillPointsPerLevel: 0,
      researchPointsPerLevel: 0
    }
  };
}

export function createDefaultLimbs() {
  return DEFAULT_LIMBS.map(entry => ({ ...entry }));
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
        inventorySize: normalizeInventorySize(race.inventorySize),
        damageResistances: normalizeFormulaMap(race.damageResistances, damageTypes),
        needSettings: normalizeRaceNeedSettings(race.needSettings),
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
    loadFormula: String(values?.loadFormula ?? defaults.loadFormula).trim() || defaults.loadFormula
  };
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
      return {
        key,
        label: String(limb?.label ?? limb?.name ?? "").trim() || defaultLimb?.label || localize("FALLOUTMAW.Common.Untitled"),
        stateMax: Math.max(0, toInteger(limb?.stateMax ?? defaultLimb?.stateMax ?? 100)),
        damageMultiplier: toDecimal(limb?.damageMultiplier ?? defaultLimb?.damageMultiplier ?? 1, 1),
        aimedDifficultyPercent: toInteger(limb?.aimedDifficultyPercent ?? defaultLimb?.aimedDifficultyPercent ?? 0)
      };
    })
    .filter(Boolean);
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
