import { toInteger } from "../utils/numbers.mjs";

export const WEAPON_ATTACK_MODIFIER_KEYS = Object.freeze({
  whirlwind: "whirlwind",
  lunge: "lunge",
  counterSniper: "counterSniper",
  forced: "forced",
  attackActionTargeted: "attackActionTargeted",
  attackActionDirection: "attackActionDirection"
});

const WEAPON_ATTACK_MODIFIER_DEFINITIONS = Object.freeze({
  [WEAPON_ATTACK_MODIFIER_KEYS.whirlwind]: Object.freeze({
    key: WEAPON_ATTACK_MODIFIER_KEYS.whirlwind,
    label: "Способность",
    targetedAction: false,
    requiresLimbSelection: false,
    requiresDirectionSelection: false,
    circularGeometry: true,
    customExecution: true,
    accuracyModifier: -30
  }),
  [WEAPON_ATTACK_MODIFIER_KEYS.lunge]: Object.freeze({
    key: WEAPON_ATTACK_MODIFIER_KEYS.lunge,
    label: "Способность",
    finishAfterAttack: true
  }),
  [WEAPON_ATTACK_MODIFIER_KEYS.counterSniper]: Object.freeze({
    key: WEAPON_ATTACK_MODIFIER_KEYS.counterSniper,
    label: "Контр-снайпер",
    finishAfterAttack: true,
    preventCancel: true,
    suppressCounterSniperReaction: true
  }),
  [WEAPON_ATTACK_MODIFIER_KEYS.forced]: Object.freeze({
    key: WEAPON_ATTACK_MODIFIER_KEYS.forced,
    label: "Реакция",
    finishAfterAttack: true,
    preventCancel: true
  }),
  [WEAPON_ATTACK_MODIFIER_KEYS.attackActionTargeted]: Object.freeze({
    key: WEAPON_ATTACK_MODIFIER_KEYS.attackActionTargeted,
    label: "Атакующее действие",
    targetedAction: true,
    requiresLimbSelection: false,
    requiresDirectionSelection: false,
    finishAfterAttack: true,
    difficultyBonus: 0,
    accuracyModifier: 0,
    criticalChanceModifier: 0,
    damagePercentModifier: 0
  }),
  [WEAPON_ATTACK_MODIFIER_KEYS.attackActionDirection]: Object.freeze({
    key: WEAPON_ATTACK_MODIFIER_KEYS.attackActionDirection,
    label: "Атакующее действие",
    targetedAction: false,
    requiresLimbSelection: false,
    requiresDirectionSelection: false,
    finishAfterAttack: true,
    difficultyBonus: 0,
    accuracyModifier: 0,
    criticalChanceModifier: 0,
    damagePercentModifier: 0
  })
});

export function createWhirlwindAttackModifier({
  accuracyModifier = -30,
  label = "Способность",
  onBeforeAttack = null
} = {}) {
  return normalizeWeaponAttackModifier({
    key: WEAPON_ATTACK_MODIFIER_KEYS.whirlwind,
    label,
    accuracyModifier,
    onBeforeAttack
  });
}

export function createLungeAttackModifier({
  label = "Способность",
  onDestroy = null
} = {}) {
  return normalizeWeaponAttackModifier({
    key: WEAPON_ATTACK_MODIFIER_KEYS.lunge,
    label,
    onDestroy,
    finishAfterAttack: true
  });
}

export function createCounterSniperAttackModifier({ onDestroy = null, label = "Контр-снайпер" } = {}) {
  return normalizeWeaponAttackModifier({
    key: WEAPON_ATTACK_MODIFIER_KEYS.counterSniper,
    label,
    onDestroy
  });
}

export function createForcedAttackModifier({ onDestroy = null, label = "Реакция" } = {}) {
  return normalizeWeaponAttackModifier({
    key: WEAPON_ATTACK_MODIFIER_KEYS.forced,
    label,
    onDestroy
  });
}

export function createAttackActionTargetedModifier({
  aimed = false,
  label = "Атакующее действие",
  difficultyBonus = 0
} = {}) {
  return normalizeWeaponAttackModifier({
    key: WEAPON_ATTACK_MODIFIER_KEYS.attackActionTargeted,
    label,
    targetedAction: true,
    requiresLimbSelection: Boolean(aimed),
    requiresDirectionSelection: false,
    difficultyBonus
  });
}

export function createAttackActionDirectionModifier({
  label = "Атакующее действие",
  accuracyModifier = 0,
  criticalChanceModifier = 0,
  damagePercentModifier = 0
} = {}) {
  return normalizeWeaponAttackModifier({
    key: WEAPON_ATTACK_MODIFIER_KEYS.attackActionDirection,
    label,
    accuracyModifier,
    criticalChanceModifier,
    damagePercentModifier
  });
}

export function normalizeWeaponAttackModifier(value = null) {
  if (!value) return null;
  const key = String(typeof value === "string" ? value : value.key ?? "").trim();
  const definition = WEAPON_ATTACK_MODIFIER_DEFINITIONS[key];
  if (!definition) return null;
  return {
    ...definition,
    ...(typeof value === "object" ? value : {}),
    key,
    difficultyBonus: Math.max(0, toInteger(
      typeof value === "object"
        ? value.difficultyBonus ?? definition.difficultyBonus
        : definition.difficultyBonus
    )),
    accuracyModifier: toInteger(typeof value === "object" ? value.accuracyModifier ?? definition.accuracyModifier : definition.accuracyModifier),
    criticalChanceModifier: toInteger(
      typeof value === "object"
        ? value.criticalChanceModifier ?? definition.criticalChanceModifier
        : definition.criticalChanceModifier
    ),
    damagePercentModifier: toInteger(
      typeof value === "object"
        ? value.damagePercentModifier ?? definition.damagePercentModifier
        : definition.damagePercentModifier
    )
  };
}

export function isWhirlwindAttackModifier(attackModifier = null) {
  return String(attackModifier?.key ?? "") === WEAPON_ATTACK_MODIFIER_KEYS.whirlwind;
}

export function getWeaponAttackModifierAccuracyModifier(attackModifier = null) {
  return toInteger(attackModifier?.accuracyModifier);
}

export function getWeaponAttackModifierDifficultyBonus(attackModifier = null) {
  return Math.max(0, toInteger(attackModifier?.difficultyBonus));
}

export function getWeaponAttackModifierCriticalChanceModifier(attackModifier = null) {
  return toInteger(attackModifier?.criticalChanceModifier);
}

export function getWeaponAttackModifierDamagePercentModifier(attackModifier = null) {
  return toInteger(attackModifier?.damagePercentModifier);
}
