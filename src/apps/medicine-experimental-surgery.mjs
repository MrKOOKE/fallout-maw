const EXPERIMENTAL_SURGERY_TREATMENT_TYPES = new Set(["trauma", "disease"]);
const TOOL_CLASS_RANK = Object.freeze({ D: 0, C: 1, B: 2, A: 3, S: 4 });
const TOOL_CLASSES_BY_RANK = Object.freeze(["D", "C", "B", "A", "S"]);

export function isExperimentalSurgeryTreatmentType(value = "") {
  return EXPERIMENTAL_SURGERY_TREATMENT_TYPES.has(String(value ?? "").trim());
}

export function getExperimentalSurgeryEffectiveToolClass(requiredClass = "D", allowedDeficit = 0) {
  const normalizedClass = String(requiredClass ?? "D").trim().toUpperCase();
  const requiredRank = TOOL_CLASS_RANK[normalizedClass] ?? 0;
  const effectiveRank = Math.max(0, requiredRank - Math.max(0, toInteger(allowedDeficit)));
  return TOOL_CLASSES_BY_RANK[effectiveRank];
}

export function rollExperimentalSurgeryChance(percent = 0, random = Math.random) {
  const chance = Math.max(0, Math.min(100, toFiniteNumber(percent)));
  if (chance <= 0) return false;
  if (chance >= 100) return true;
  return Math.max(0, Math.min(1, toFiniteNumber(random()))) < (chance / 100);
}

export function calculateExperimentalSurgerySupplyCost({
  normalSpent = 0,
  currentSupply = 0,
  multiplier = 1,
  triggered = false
} = {}) {
  const baseSpent = Math.max(0, toInteger(normalSpent));
  const available = Math.max(0, toInteger(currentSupply));
  const effectiveMultiplier = triggered ? Math.max(1, toInteger(multiplier)) : 1;
  const spent = Math.min(available, baseSpent * effectiveMultiplier);
  return {
    spent,
    remaining: Math.max(0, available - spent),
    extraSpent: Math.max(0, spent - Math.min(available, baseSpent)),
    multiplier: effectiveMultiplier,
    triggered: Boolean(triggered && effectiveMultiplier > 1)
  };
}

export function calculateExperimentalSurgeryPatientDamage(maxHealth = 0, percent = 0) {
  const maximum = Math.max(0, toFiniteNumber(maxHealth));
  const ratio = Math.max(0, Math.min(100, toFiniteNumber(percent))) / 100;
  return maximum > 0 && ratio > 0 ? Math.ceil(maximum * ratio) : 0;
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function toInteger(value) {
  return Math.trunc(toFiniteNumber(value));
}
