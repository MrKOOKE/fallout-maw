export const SKILL_ADVANCEMENT_MULTIPLIER_EFFECT_KEY_PREFIX = "system.skillAdvancementBase.";
export const ALL_SKILL_ADVANCEMENT_MULTIPLIERS_TARGET = "all";
export const SIGNATURE_SKILL_ADVANCEMENT_MULTIPLIERS_TARGET = "signature";

export function getSkillAdvancementMultiplierEffectKey(target = "") {
  const normalized = String(target ?? "").trim();
  return normalized ? `${SKILL_ADVANCEMENT_MULTIPLIER_EFFECT_KEY_PREFIX}${normalized}` : "";
}

export function getSkillAdvancementMultiplierEffectTarget(key = "") {
  const normalized = String(key ?? "").trim();
  if (normalized.startsWith(SKILL_ADVANCEMENT_MULTIPLIER_EFFECT_KEY_PREFIX)) {
    return normalized.slice(SKILL_ADVANCEMENT_MULTIPLIER_EFFECT_KEY_PREFIX.length).trim();
  }
  return "";
}

export function isSkillAdvancementMultiplierEffectKey(key = "") {
  return Boolean(getSkillAdvancementMultiplierEffectTarget(key));
}

export function isSkillAdvancementMultiplierTargetApplicable(target = "", skillKey = "", { signature = false } = {}) {
  const normalizedTarget = String(target ?? "").trim();
  if (!normalizedTarget) return false;
  if (normalizedTarget === ALL_SKILL_ADVANCEMENT_MULTIPLIERS_TARGET) return true;
  if (normalizedTarget === SIGNATURE_SKILL_ADVANCEMENT_MULTIPLIERS_TARGET) return Boolean(signature);
  return normalizedTarget === String(skillKey ?? "").trim();
}
