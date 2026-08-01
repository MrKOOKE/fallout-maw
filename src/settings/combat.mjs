export const LIMB_DESTRUCTION_MODES = Object.freeze({
  standard: "standard",
  nonCriticalOnly: "nonCriticalOnly",
  disabled: "disabled"
});

export const ATTACK_ACTION_POINT_MOVEMENT_LOSS_MODES = Object.freeze({
  percent: "percent",
  disabled: "disabled",
  fullLoss: "fullLoss"
});

const LIMB_DESTRUCTION_MODE_VALUES = new Set(Object.values(LIMB_DESTRUCTION_MODES));
const ATTACK_ACTION_POINT_MOVEMENT_LOSS_MODE_VALUES = new Set(
  Object.values(ATTACK_ACTION_POINT_MOVEMENT_LOSS_MODES)
);

export const DEFAULT_COMBAT_SETTINGS = Object.freeze({
  turnOrder: Object.freeze({
    scheme: "block"
  }),
  weaponSwitch: Object.freeze({
    actionPointCost: 3
  }),
  reactions: Object.freeze({
    timeoutSeconds: 20
  }),
  attackActionPointMovementLoss: Object.freeze({
    mode: ATTACK_ACTION_POINT_MOVEMENT_LOSS_MODES.percent,
    percent: 100
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
  limbDestruction: Object.freeze({
    nonPlayerMode: LIMB_DESTRUCTION_MODES.standard,
    playerOwnedMode: LIMB_DESTRUCTION_MODES.standard
  }),
  weaponSkillDamage: Object.freeze({
    meleeCombat: Object.freeze({
      flat: "str+dex/2",
      percent: "str+dex/2"
    }),
    rangedCombat: Object.freeze({
      flat: "wis+dex/2",
      percent: "wis+dex/2"
    }),
    throwing: Object.freeze({
      flat: "dex+wis/2",
      percent: "dex+wis/2"
    })
  })
});

const WEAPON_SKILL_DAMAGE_KEYS = Object.freeze(["meleeCombat", "rangedCombat", "throwing"]);
const TURN_ORDER_SCHEMES = new Set(["normal", "block"]);

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
    turnOrder: {
      scheme: TURN_ORDER_SCHEMES.has(source.turnOrder?.scheme)
        ? source.turnOrder.scheme
        : DEFAULT_COMBAT_SETTINGS.turnOrder.scheme
    },
    weaponSwitch: {
      actionPointCost: clampInteger(source.weaponSwitch?.actionPointCost, DEFAULT_COMBAT_SETTINGS.weaponSwitch.actionPointCost, 0, 100)
    },
    reactions: {
      timeoutSeconds: clampInteger(source.reactions?.timeoutSeconds, DEFAULT_COMBAT_SETTINGS.reactions.timeoutSeconds, 1, 600)
    },
    attackActionPointMovementLoss: {
      mode: normalizeAttackActionPointMovementLossMode(
        source.attackActionPointMovementLoss?.mode,
        DEFAULT_COMBAT_SETTINGS.attackActionPointMovementLoss.mode
      ),
      percent: normalizeNonNegativeInteger(
        source.attackActionPointMovementLoss?.percent,
        DEFAULT_COMBAT_SETTINGS.attackActionPointMovementLoss.percent
      )
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
    limbDestruction: {
      nonPlayerMode: normalizeLimbDestructionMode(
        source.limbDestruction?.nonPlayerMode,
        DEFAULT_COMBAT_SETTINGS.limbDestruction.nonPlayerMode
      ),
      playerOwnedMode: normalizeLimbDestructionMode(
        source.limbDestruction?.playerOwnedMode,
        DEFAULT_COMBAT_SETTINGS.limbDestruction.playerOwnedMode
      )
    },
    weaponSkillDamage: Object.fromEntries(
      WEAPON_SKILL_DAMAGE_KEYS.map(key => [
        key,
        normalizeWeaponSkillDamageEntry(source.weaponSkillDamage?.[key], DEFAULT_COMBAT_SETTINGS.weaponSkillDamage[key])
      ])
    )
  };
}

export function getActorLimbDestructionMode(actor = null, settings = DEFAULT_COMBAT_SETTINGS) {
  const configured = actor?.hasPlayerOwner
    ? settings?.limbDestruction?.playerOwnedMode
    : settings?.limbDestruction?.nonPlayerMode;
  return normalizeLimbDestructionMode(configured, LIMB_DESTRUCTION_MODES.standard);
}

export function canActorLimbBeAutomaticallyDestroyed(
  actor = null,
  { critical = false, mode = null } = {},
  settings = DEFAULT_COMBAT_SETTINGS
) {
  const resolvedMode = mode === null
    ? getActorLimbDestructionMode(actor, settings)
    : normalizeLimbDestructionMode(mode, LIMB_DESTRUCTION_MODES.standard);
  return resolvedMode === LIMB_DESTRUCTION_MODES.standard
    || (resolvedMode === LIMB_DESTRUCTION_MODES.nonCriticalOnly && !critical);
}

function normalizeWeaponSkillDamageEntry(source, defaults = {}) {
  if (typeof source === "string") {
    return {
      flat: normalizeFormula(source, defaults.flat),
      percent: normalizeFormula(defaults.percent, defaults.percent)
    };
  }

  return {
    flat: normalizeFormula(source?.flat, defaults.flat),
    percent: normalizeFormula(source?.percent, defaults.percent)
  };
}

function normalizeFormula(value, fallback) {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function normalizeLimbDestructionMode(value, fallback) {
  const mode = String(value ?? "").trim();
  return LIMB_DESTRUCTION_MODE_VALUES.has(mode) ? mode : fallback;
}

function normalizeAttackActionPointMovementLossMode(value, fallback) {
  const mode = String(value ?? "").trim();
  return ATTACK_ACTION_POINT_MOVEMENT_LOSS_MODE_VALUES.has(mode) ? mode : fallback;
}

function normalizeNonNegativeInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.trunc(number));
}

function clampInteger(value, fallback, min, max) {
  return Math.trunc(clampNumber(value, fallback, min, max));
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
