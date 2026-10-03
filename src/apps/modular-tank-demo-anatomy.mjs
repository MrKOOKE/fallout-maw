import { SYSTEM_ID } from "../constants.mjs";
import { DEFAULT_CHARACTERISTICS, DEFAULT_EQUIPMENT_SLOTS, DEFAULT_LIMBS, DEFAULT_WEAPON_SETS } from "../config/defaults.mjs";
import { CREATURE_OPTIONS_SETTING } from "../settings/constants.mjs";

export const MODULAR_TANK_DEMO_TYPE_ID = "modularTankDemoType";
export const MODULAR_TANK_DEMO_RACE_ID = "modularTankDemoHuman";

/** The sample has its own additive anatomy, so it also works in worlds without races.
 * Fixed formulas make the damage target independent of custom characteristic names.
 */
export async function ensureModularTankDemoAnatomy() {
  const options = structuredClone(game.settings.get(SYSTEM_ID, CREATURE_OPTIONS_SETTING) ?? {});
  options.types = Array.isArray(options.types) ? options.types : [];
  options.races = Array.isArray(options.races) ? options.races : [];
  const human = options.races.find(race => race.id !== MODULAR_TANK_DEMO_RACE_ID
    && /^(человек|human)$/i.test(String(race.name ?? "").trim())
    && race.limbs?.length && race.weaponSets?.some(set => set.slots?.length));
  if (human) return human;
  const existing = options.races.find(race => race.id === MODULAR_TANK_DEMO_RACE_ID);
  if (existing) {
    let renamed = false;
    if (existing.name === "Человек — полигон модульного танка") { existing.name = "Человек"; renamed = true; }
    const type = options.types.find(row => row.id === MODULAR_TANK_DEMO_TYPE_ID);
    if (type?.name === "Полигон модульного танка") { type.name = "Гуманоиды"; renamed = true; }
    if (renamed) await game.settings.set(SYSTEM_ID, CREATURE_OPTIONS_SETTING, options);
    return existing;
  }
  if (!options.types.some(type => type.id === MODULAR_TANK_DEMO_TYPE_ID)) {
    options.types.push({ id: MODULAR_TANK_DEMO_TYPE_ID, name: "Гуманоиды" });
  }
  const limbs = DEFAULT_LIMBS.map(limb => ({ ...limb, stateMax: "100 + 0",
    lossEffects: structuredClone(limb.lossEffects ?? []) }));
  const race = {
    id: MODULAR_TANK_DEMO_RACE_ID,
    typeId: MODULAR_TANK_DEMO_TYPE_ID,
    name: "Человек",
    characteristics: Object.fromEntries(DEFAULT_CHARACTERISTICS.map(entry => [entry.key, 10])),
    baseParameters: { healthFormula: String(limbs.length * 100), loadFormula: "100", loadLimitPercent: 100,
      characteristicDistributionPoints: 0, signatureSkillPoints: 0, proficiencyPoints: 0, traitPoints: 0 },
    limbs,
    equipmentSlots: DEFAULT_EQUIPMENT_SLOTS.map(slot => ({ ...slot })),
    weaponSets: DEFAULT_WEAPON_SETS.map(set => ({ ...set, slots: set.slots.map(slot => ({ ...slot })) })),
    inventorySize: { columns: 10, rows: 2 },
    naturalItemSets: [],
    regeneration: { formula: "0", energyFormula: "0" },
    bleedingResistanceFormula: "0",
    damageResistances: {},
    progression: { healthPerLevel: "0", skillPointsPerLevel: "0", researchPointsPerLevel: "0", proficiencyPointsPerLevel: "0" },
    organismDevelopment: { threshold: 1, limit: 50 }
  };
  options.races.push(race);
  await game.settings.set(SYSTEM_ID, CREATURE_OPTIONS_SETTING, options);
  return race;
}

export function prepareModularTankDemoCharacter(source, race) {
  const data = structuredClone(source);
  data.system ??= {};
  data.system.creature = { typeId: race.typeId, raceId: race.id, subtypeId: "" };
  data.system.limbs = Object.fromEntries(race.limbs.map(limb => [limb.key,
    { spent: 0, missing: false, maxBonus: 0, damageAccumulation: {} }]));
  data.system.development = { ...(data.system.development ?? {}), initialized: true, healthInitialized: true, health: 0 };
  data.system.resources ??= {};
  for (const key of ["health", "consciousness"]) {
    data.system.resources[key] = { ...(data.system.resources[key] ?? {}), spent: 0 };
  }
  data.system.combat = { ...(data.system.combat ?? {}), consciousnessRecoveryTarget: 0 };
  return data;
}

/** Repair only the original empty-anatomy sample; later player edits and damage stay intact. */
export async function repairEmptyModularTankDemoCharacter(actor, race) {
  const source = actor?._source?.system ?? actor?.system ?? {};
  if (!actor || source.creature?.raceId || Number(actor.system?.resources?.health?.max) > 0
    || Object.values(actor.system?.limbs ?? {}).some(limb => Number(limb.max) > 0)) return false;
  const prepared = prepareModularTankDemoCharacter({ system: source }, race).system;
  await actor.update({ "system.creature": prepared.creature, "system.limbs": prepared.limbs,
    "system.development": prepared.development,
    "system.resources.health.spent": 0, "system.resources.consciousness.spent": 0,
    "system.combat.consciousnessRecoveryTarget": 0 });
  return true;
}
