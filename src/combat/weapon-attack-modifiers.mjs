import { toInteger } from "../utils/numbers.mjs";

export const WEAPON_ATTACK_MODIFIER_KEYS = Object.freeze({
  whirlwind: "whirlwind",
  lunge: "lunge",
  counterSniper: "counterSniper",
  forced: "forced"
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

export function normalizeWeaponAttackModifier(value = null) {
  if (!value) return null;
  const key = String(typeof value === "string" ? value : value.key ?? "").trim();
  const definition = WEAPON_ATTACK_MODIFIER_DEFINITIONS[key];
  if (!definition) return null;
  return {
    ...definition,
    ...(typeof value === "object" ? value : {}),
    key,
    accuracyModifier: toInteger(typeof value === "object" ? value.accuracyModifier ?? definition.accuracyModifier : definition.accuracyModifier)
  };
}

export function isWhirlwindAttackModifier(attackModifier = null) {
  return String(attackModifier?.key ?? "") === WEAPON_ATTACK_MODIFIER_KEYS.whirlwind;
}

export function getWeaponAttackModifierAccuracyModifier(attackModifier = null) {
  return toInteger(attackModifier?.accuracyModifier);
}
