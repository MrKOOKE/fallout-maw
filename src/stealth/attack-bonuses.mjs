import { evaluateActorFormula } from "../utils/actor-formulas.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { DEFAULT_STEALTH_SETTINGS } from "./settings.mjs";
import { getRuntimeStealthSettings, isActorStealthed } from "./rules.mjs";

export function getStealthAttackModifiers(actor, settings = getRuntimeStealthSettings()) {
  const formulas = getStealthAttackBonusFormulas(settings);
  const active = isActorStealthed(actor);
  if (!active) {
    return {
      active,
      accuracyBonus: 0,
      criticalChanceBonus: 0,
      damageBonusPercent: 0,
      criticalDamageBonusPercent: 0,
      formulaValues: createZeroStealthAttackBonusValues(),
      effectValues: createZeroStealthAttackBonusValues(),
      ...formulas
    };
  }

  const formulaValues = {
    accuracy: evaluateStealthAttackBonusFormula(formulas.accuracyFormula, actor, "accuracy"),
    criticalChance: evaluateStealthAttackBonusFormula(formulas.criticalChanceFormula, actor, "critical chance"),
    damagePercent: evaluateStealthAttackBonusFormula(formulas.damagePercentFormula, actor, "damage percent"),
    criticalDamagePercent: evaluateStealthAttackBonusFormula(
      formulas.criticalDamagePercentFormula,
      actor,
      "critical damage percent"
    )
  };
  const effectValues = getPreparedStealthAttackBonusValues(actor);
  return {
    active,
    accuracyBonus: normalizeStealthAttackBonus(formulaValues.accuracy, effectValues.accuracy),
    criticalChanceBonus: normalizeStealthAttackBonus(formulaValues.criticalChance, effectValues.criticalChance),
    damageBonusPercent: normalizeStealthAttackBonus(formulaValues.damagePercent, effectValues.damagePercent),
    criticalDamageBonusPercent: normalizeStealthAttackBonus(
      formulaValues.criticalDamagePercent,
      effectValues.criticalDamagePercent
    ),
    formulaValues,
    effectValues,
    ...formulas
  };
}

export function calculateStealthDamageBonusAmount(baseAmount, bonusPercent, { shareCount = 1 } = {}) {
  const amount = Math.max(0, Math.round(Number(baseAmount) || 0));
  const percent = Math.max(0, toInteger(bonusPercent));
  const count = Math.max(1, toInteger(shareCount));
  if (count === 1) return Math.floor(amount * percent / 100);

  const smallerShare = Math.floor(amount / count);
  const largerShareCount = amount - (smallerShare * count);
  return (largerShareCount * Math.floor((smallerShare + 1) * percent / 100))
    + ((count - largerShareCount) * Math.floor(smallerShare * percent / 100));
}

function getStealthAttackBonusFormulas(settings = {}) {
  const configured = settings?.attackBonuses ?? {};
  const defaults = DEFAULT_STEALTH_SETTINGS.attackBonuses;
  return {
    accuracyFormula: normalizeAttackBonusFormula(configured.accuracyFormula, defaults.accuracyFormula),
    criticalChanceFormula: normalizeAttackBonusFormula(configured.criticalChanceFormula, defaults.criticalChanceFormula),
    damagePercentFormula: normalizeAttackBonusFormula(configured.damagePercentFormula, defaults.damagePercentFormula),
    criticalDamagePercentFormula: normalizeAttackBonusFormula(
      configured.criticalDamagePercentFormula,
      defaults.criticalDamagePercentFormula
    )
  };
}

function normalizeAttackBonusFormula(value, fallback = "0") {
  return String(value ?? "").trim() || String(fallback ?? "0").trim() || "0";
}

function evaluateStealthAttackBonusFormula(formula, actor, label) {
  return evaluateActorFormula(formula, actor, {
    fallback: 0,
    minimum: 0,
    context: `stealth attack ${label}`
  });
}

function getPreparedStealthAttackBonusValues(actor) {
  const values = actor?.system?.stealth?.attackBonuses ?? {};
  return {
    accuracy: toInteger(values.accuracy),
    criticalChance: toInteger(values.criticalChance),
    damagePercent: toInteger(values.damagePercent),
    criticalDamagePercent: toInteger(values.criticalDamagePercent)
  };
}

function createZeroStealthAttackBonusValues() {
  return {
    accuracy: 0,
    criticalChance: 0,
    damagePercent: 0,
    criticalDamagePercent: 0
  };
}

function normalizeStealthAttackBonus(formulaValue, effectValue) {
  return Math.max(0, toInteger(formulaValue) + toInteger(effectValue));
}
