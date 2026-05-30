import { toInteger } from "./numbers.mjs";

const RANDOM_LIMB_BASE_EXPONENT = 4.5;
const RANDOM_LIMB_DIFFICULTY_EXPONENT_STEP = 40;

export function selectRandomWeightedLimbKey(actor, { includeDestroyed = false } = {}) {
  const entries = Object.entries(actor?.system?.limbs ?? {})
    .filter(([_key, limb]) => limb && typeof limb === "object")
    .filter(([_key, limb]) => includeDestroyed || !isLimbDestroyed(limb))
    .map(([key, limb]) => ({
      key,
      weight: getRandomLimbWeight(limb)
    }))
    .filter(entry => entry.key && entry.weight > 0);

  const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0);
  if (totalWeight <= 0) return "";

  let roll = Math.random() * totalWeight;
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

function isLimbDestroyed(limb = {}) {
  return toInteger(limb?.value) <= toInteger(limb?.min);
}
