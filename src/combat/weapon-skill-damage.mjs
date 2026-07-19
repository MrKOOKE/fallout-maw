import { evaluateActorFormula, isFormulaTextConfigured } from "../utils/actor-formulas.mjs";
import { getCombatSettings } from "../settings/accessors.mjs";

export function getWeaponSkillDamageBonuses(actor, skillKey = "") {
  const key = String(skillKey ?? "").trim();
  if (!key || !actor) return { flat: 0, percent: 0, flatFormula: "", percentFormula: "", skillKey: key };

  const entry = getCombatSettings()?.weaponSkillDamage?.[key];
  const flatFormula = typeof entry === "string" ? entry : entry?.flat;
  const percentFormula = typeof entry === "string" ? "" : entry?.percent;

  return {
    flat: evaluateWeaponSkillDamageFormula(flatFormula, actor, key, "flat"),
    percent: evaluateWeaponSkillDamageFormula(percentFormula, actor, key, "percent"),
    flatFormula: String(flatFormula ?? "").trim(),
    percentFormula: String(percentFormula ?? "").trim(),
    skillKey: key
  };
}

function evaluateWeaponSkillDamageFormula(formula, actor, skillKey, kind) {
  if (!isFormulaTextConfigured(formula)) return 0;
  return evaluateActorFormula(formula, actor, {
    minimum: 0,
    context: `weapon skill damage ${kind} (${skillKey})`
  });
}
