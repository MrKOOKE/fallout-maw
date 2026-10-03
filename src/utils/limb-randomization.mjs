import { toInteger } from "./numbers.mjs";
import { isLimbDestroyed } from "./limb-state.mjs";
import { getConstructExteriorSlotIds } from "./construct-interior.mjs";
import { getConstructPartSlotIdFromLimbKey } from "./construct-parts.mjs";

const RANDOM_LIMB_BASE_EXPONENT = 2.4;
const RANDOM_LIMB_DIFFICULTY_EXPONENT_STEP = 50;

export function selectRandomWeightedLimbKey(actor, {
  includeDestroyed = false,
  criticalOnly = false,
  random = Math.random
} = {}) {
  const exterior = actor?.type === "construct" ? new Set(getConstructExteriorSlotIds(actor)) : null;
  const entries = Object.entries(actor?.system?.limbs ?? {})
    .filter(([_key, limb]) => limb && typeof limb === "object")
    // A broken installed shell is still a contact point for its compartment;
    // the damage hub skips its protection and reaches the surviving contents.
    .filter(([key]) => includeDestroyed || exterior || !isLimbDestroyed(actor, key))
    .filter(([key]) => !exterior || exterior.has(getConstructPartSlotIdFromLimbKey(key)))
    .filter(([_key, limb]) => !criticalOnly || limb?.critical === true)
    .map(([key, limb]) => ({
      key,
      weight: getRandomLimbWeight(limb)
    }))
    .filter(entry => entry.key && entry.weight > 0);

  const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0);
  if (totalWeight <= 0) return "";

  let roll = random() * totalWeight;
  for (const entry of entries) {
    roll -= entry.weight;
    if (roll <= 0) return entry.key;
  }
  return entries.at(-1)?.key ?? "";
}

export function getRandomLimbWeight(limb = {}) {
  const difficulty = Math.max(0, toInteger(limb?.aimedDifficultyPercent));
  const exponent = RANDOM_LIMB_BASE_EXPONENT + (difficulty / RANDOM_LIMB_DIFFICULTY_EXPONENT_STEP);
  return Math.pow(100 / (100 + difficulty), exponent);
}
