export const DEFAULT_COMBAT_SETTINGS = Object.freeze({
  weaponSwitch: Object.freeze({
    actionPointCost: 3
  }),
  knockback: Object.freeze({
    repeatDifficultyThreshold: 100,
    repeatDifficultyStep: 50
  }),
  areas: Object.freeze({
    movementDamageThresholdFormula: "(ОД + ОП) / 5"
  }),
  dodge: Object.freeze({
    enabled: true,
    attackCostPercent: 10,
    burstMultiplier: 2,
    volleyMultiplier: 1,
    areaDamageMultiplier: 1,
    roundRecoveryPercent: 20,
    restoreOnCombatStart: true,
    restoreOnCombatEnd: true
  }),
  unconsciousness: Object.freeze({
    normalDamageFormula: "damage * 0.5",
    negativeDamageFormula: "damage",
    criticalDamageFormula: "damage * 2",
    stateMultiplierFormula: "1 + missingStateRatio"
  }),
  weaponSkillDamage: Object.freeze({
    meleeCombat: "floor(str/3+dex/6)",
    rangedCombat: "floor(wis/3+dex/6)",
    throwing: "floor(dex/3+wis/6)"
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
    weaponSwitch: {
      actionPointCost: clampInteger(source.weaponSwitch?.actionPointCost, DEFAULT_COMBAT_SETTINGS.weaponSwitch.actionPointCost, 0, 100)
    },
    knockback: {
      repeatDifficultyThreshold: clampInteger(source.knockback?.repeatDifficultyThreshold, DEFAULT_COMBAT_SETTINGS.knockback.repeatDifficultyThreshold, 1, 10000),
      repeatDifficultyStep: clampInteger(source.knockback?.repeatDifficultyStep, DEFAULT_COMBAT_SETTINGS.knockback.repeatDifficultyStep, 1, 10000)
    },
    areas: {
      movementDamageThresholdFormula: normalizeFormula(
        source.areas?.movementDamageThresholdFormula,
        DEFAULT_COMBAT_SETTINGS.areas.movementDamageThresholdFormula
      )
    },
    dodge: {
      enabled: Boolean(source.dodge?.enabled),
      attackCostPercent: clampInteger(source.dodge?.attackCostPercent, DEFAULT_COMBAT_SETTINGS.dodge.attackCostPercent, 0, 100),
      burstMultiplier: clampNumber(source.dodge?.burstMultiplier, DEFAULT_COMBAT_SETTINGS.dodge.burstMultiplier, 0, 100),
      volleyMultiplier: clampNumber(source.dodge?.volleyMultiplier, DEFAULT_COMBAT_SETTINGS.dodge.volleyMultiplier, 0, 100),
      areaDamageMultiplier: clampNumber(source.dodge?.areaDamageMultiplier, DEFAULT_COMBAT_SETTINGS.dodge.areaDamageMultiplier, 0, 100),
      roundRecoveryPercent: clampInteger(source.dodge?.roundRecoveryPercent, DEFAULT_COMBAT_SETTINGS.dodge.roundRecoveryPercent, 0, 100),
      restoreOnCombatStart: Boolean(source.dodge?.restoreOnCombatStart),
      restoreOnCombatEnd: Boolean(source.dodge?.restoreOnCombatEnd)
    },
    unconsciousness: {
      normalDamageFormula: normalizeFormula(source.unconsciousness?.normalDamageFormula, DEFAULT_COMBAT_SETTINGS.unconsciousness.normalDamageFormula),
      negativeDamageFormula: normalizeFormula(source.unconsciousness?.negativeDamageFormula, DEFAULT_COMBAT_SETTINGS.unconsciousness.negativeDamageFormula),
      criticalDamageFormula: normalizeFormula(source.unconsciousness?.criticalDamageFormula, DEFAULT_COMBAT_SETTINGS.unconsciousness.criticalDamageFormula),
      stateMultiplierFormula: normalizeFormula(source.unconsciousness?.stateMultiplierFormula, DEFAULT_COMBAT_SETTINGS.unconsciousness.stateMultiplierFormula)
    },
    weaponSkillDamage: {
      meleeCombat: normalizeFormula(source.weaponSkillDamage?.meleeCombat, DEFAULT_COMBAT_SETTINGS.weaponSkillDamage.meleeCombat),
      rangedCombat: normalizeFormula(source.weaponSkillDamage?.rangedCombat, DEFAULT_COMBAT_SETTINGS.weaponSkillDamage.rangedCombat),
      throwing: normalizeFormula(source.weaponSkillDamage?.throwing, DEFAULT_COMBAT_SETTINGS.weaponSkillDamage.throwing)
    }
  };
}

function normalizeFormula(value, fallback) {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function clampInteger(value, fallback, min, max) {
  return Math.trunc(clampNumber(value, fallback, min, max));
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
