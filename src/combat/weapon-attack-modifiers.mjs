import { toInteger } from "../utils/numbers.mjs";

export const WEAPON_ATTACK_MODIFIER_KEYS = Object.freeze({
  whirlwind: "whirlwind",
  lunge: "lunge"
});

const WEAPON_ATTACK_MODIFIER_DEFINITIONS = Object.freeze({
  [WEAPON_ATTACK_MODIFIER_KEYS.whirlwind]: Object.freeze({
    key: WEAPON_ATTACK_MODIFIER_KEYS.whirlwind,
    label: "Вихрь",
    targetedAction: false,
    requiresLimbSelection: false,
    requiresDirectionSelection: false,
    circularGeometry: true,
    customExecution: true,
    accuracyModifier: -30
  }),
  [WEAPON_ATTACK_MODIFIER_KEYS.lunge]: Object.freeze({
    key: WEAPON_ATTACK_MODIFIER_KEYS.lunge,
    label: "Выпад",
    finishAfterAttack: true
  })
});

export function createWhirlwindAttackModifier({
  accuracyModifier = -30,
  label = "Вихрь",
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
  label = "Выпад",
  onDestroy = null
} = {}) {
  return normalizeWeaponAttackModifier({
    key: WEAPON_ATTACK_MODIFIER_KEYS.lunge,
    label,
    onDestroy,
    finishAfterAttack: true
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
