const CHARACTERISTIC_VALUE_KEY_PATTERN = /^system\.characteristics\.([^.]+)$/;
const SKILL_BONUS_KEY_PATTERN = /^system\.skills\.([^.]+)\.bonus$/;

export function getAdvancementPureValueEffectTarget(key = "") {
  const normalizedKey = String(key ?? "").trim();
  const characteristicMatch = normalizedKey.match(CHARACTERISTIC_VALUE_KEY_PATTERN);
  if (characteristicMatch) {
    return {
      kind: "characteristic",
      key: characteristicMatch[1]
    };
  }

  const skillMatch = normalizedKey.match(SKILL_BONUS_KEY_PATTERN);
  if (skillMatch) {
    return {
      kind: "skill",
      key: skillMatch[1]
    };
  }

  return null;
}

export function isAdvancementPureValueEffectKey(key = "") {
  return Boolean(getAdvancementPureValueEffectTarget(key));
}

export function hasAdvancementPureValueFunctionChanges(entry = {}) {
  return [
    ...toArray(entry?.changes),
    ...toArray(entry?.penalties)
  ].some(change => isAdvancementPureValueEffectKey(change?.key));
}

function toArray(value) {
  return Array.isArray(value) ? value : Object.values(value ?? {});
}
