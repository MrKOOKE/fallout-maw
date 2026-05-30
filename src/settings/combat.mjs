export const DEFAULT_COMBAT_SETTINGS = Object.freeze({
  dodge: Object.freeze({
    enabled: true,
    attackCostPercent: 10,
    burstMultiplier: 2,
    volleyMultiplier: 1,
    areaDamageMultiplier: 1,
    roundRecoveryPercent: 20,
    restoreOnCombatStart: true,
    restoreOnCombatEnd: true
  })
});

export function createDefaultCombatSettings() {
  return foundry.utils.deepClone(DEFAULT_COMBAT_SETTINGS);
}

export function normalizeCombatSettings(value = {}) {
  const source = foundry.utils.mergeObject(
    createDefaultCombatSettings(),
    value && typeof value === "object" ? value : {},
    { inplace: false }
  );

  return {
    dodge: {
      enabled: Boolean(source.dodge?.enabled),
      attackCostPercent: clampInteger(source.dodge?.attackCostPercent, DEFAULT_COMBAT_SETTINGS.dodge.attackCostPercent, 0, 100),
      burstMultiplier: clampNumber(source.dodge?.burstMultiplier, DEFAULT_COMBAT_SETTINGS.dodge.burstMultiplier, 0, 100),
      volleyMultiplier: clampNumber(source.dodge?.volleyMultiplier, DEFAULT_COMBAT_SETTINGS.dodge.volleyMultiplier, 0, 100),
      areaDamageMultiplier: clampNumber(source.dodge?.areaDamageMultiplier, DEFAULT_COMBAT_SETTINGS.dodge.areaDamageMultiplier, 0, 100),
      roundRecoveryPercent: clampInteger(source.dodge?.roundRecoveryPercent, DEFAULT_COMBAT_SETTINGS.dodge.roundRecoveryPercent, 0, 100),
      restoreOnCombatStart: Boolean(source.dodge?.restoreOnCombatStart),
      restoreOnCombatEnd: Boolean(source.dodge?.restoreOnCombatEnd)
    }
  };
}

function clampInteger(value, fallback, min, max) {
  return Math.trunc(clampNumber(value, fallback, min, max));
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
