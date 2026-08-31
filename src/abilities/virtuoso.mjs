import { toInteger } from "../utils/numbers.mjs";

/** Create the combat-scoped Cascade state granted at combat start. */
export function createVirtuosoCascadeState({
  combatUuid = "",
  worldTime = 0,
  cascadeMaxStacks = 4,
  cascadeIntervalSeconds = 6
} = {}) {
  const maxStacks = Math.max(1, toInteger(cascadeMaxStacks));
  const interval = Math.max(1, toInteger(cascadeIntervalSeconds));
  const now = finiteNumber(worldTime);
  return {
    combatUuid: String(combatUuid ?? "").trim(),
    stacks: Math.min(1, maxStacks),
    nextGainAt: now + interval
  };
}

/** Fold every elapsed six-second gain into one state transition. */
export function advanceVirtuosoCascadePeriodicState(
  state = {},
  worldTime = 0,
  { cascadeMaxStacks = 4, cascadeIntervalSeconds = 6 } = {}
) {
  const maxStacks = Math.max(1, toInteger(cascadeMaxStacks));
  const interval = Math.max(1, toInteger(cascadeIntervalSeconds));
  const now = finiteNumber(worldTime);
  const currentStacks = Math.max(0, Math.min(maxStacks, toInteger(state?.stacks)));
  let nextGainAt = finiteNumber(state?.nextGainAt, now + interval);
  if (nextGainAt > now) {
    return { stacks: currentStacks, nextGainAt, elapsedIntervals: 0, gainedStacks: 0 };
  }

  const elapsedIntervals = Math.floor((now - nextGainAt) / interval) + 1;
  nextGainAt += elapsedIntervals * interval;
  const stacks = Math.min(maxStacks, currentStacks + elapsedIntervals);
  return {
    stacks,
    nextGainAt,
    elapsedIntervals,
    gainedStacks: stacks - currentStacks
  };
}

/** Resolve one weapon action without mutating the stored ability state. */
export function resolveVirtuosoAttackTransition({
  state = {},
  weaponName = "",
  weaponIdentity = "",
  weaponAttackId = "",
  combatUuid = "",
  worldTime = 0,
  cascadeMaxStacks = 0,
  cascadeIntervalSeconds = 6
} = {}) {
  const normalizedWeaponName = String(weaponName ?? "").trim();
  const normalizedWeaponIdentity = String(weaponIdentity ?? "").trim();
  const maxStacks = Math.max(0, toInteger(cascadeMaxStacks));
  if (!normalizedWeaponName) return inactiveTransition(maxStacks > 0);

  if (maxStacks <= 0) {
    const previousWeaponName = String(state?.weaponName ?? "").trim();
    return {
      cascade: false,
      bonusMultiplier: previousWeaponName === normalizedWeaponName ? 0 : 1,
      nextState: previousWeaponName === normalizedWeaponName
        ? null
        : { weaponName: normalizedWeaponName },
      reset: false
    };
  }

  const normalizedCombatUuid = String(combatUuid ?? "").trim();
  if (!normalizedCombatUuid) return { ...inactiveTransition(true), reset: true };

  const normalizedAttackId = String(weaponAttackId ?? "").trim();
  const stateMatchesCombat = String(state?.combatUuid ?? "").trim() === normalizedCombatUuid;
  if (
    stateMatchesCombat
    && normalizedAttackId
    && String(state?.weaponAttackId ?? "").trim() === normalizedAttackId
  ) return inactiveTransition(true);

  const initialState = stateMatchesCombat
    ? state
    : createVirtuosoCascadeState({
      combatUuid: normalizedCombatUuid,
      worldTime,
      cascadeMaxStacks: maxStacks,
      cascadeIntervalSeconds
    });
  const periodic = advanceVirtuosoCascadePeriodicState(initialState, worldTime, {
    cascadeMaxStacks: maxStacks,
    cascadeIntervalSeconds
  });
  const storedWeaponIdentity = stateMatchesCombat ? String(state?.weaponIdentity ?? "").trim() : "";
  const currentWeaponIdentity = storedWeaponIdentity
    ? normalizedWeaponIdentity || normalizedWeaponName
    : normalizedWeaponName;
  const previousWeaponIdentity = storedWeaponIdentity
    || (stateMatchesCombat ? String(state?.weaponName ?? "").trim() : "");
  const repeatedWeapon = Boolean(previousWeaponIdentity) && previousWeaponIdentity === currentWeaponIdentity;
  const switchedWeapon = Boolean(previousWeaponIdentity) && previousWeaponIdentity !== currentWeaponIdentity;
  const stacks = repeatedWeapon
    ? 0
    : Math.min(maxStacks, periodic.stacks + (switchedWeapon ? 1 : 0));
  return {
    cascade: true,
    bonusMultiplier: repeatedWeapon ? 0 : stacks,
    nextState: {
      weaponName: normalizedWeaponName,
      weaponIdentity: normalizedWeaponIdentity || normalizedWeaponName,
      combatUuid: normalizedCombatUuid,
      stacks,
      nextGainAt: periodic.nextGainAt,
      ...(normalizedAttackId ? { weaponAttackId: normalizedAttackId } : {})
    },
    reset: false
  };
}

function inactiveTransition(cascade) {
  return {
    cascade,
    bonusMultiplier: 0,
    nextState: null,
    reset: false
  };
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number(fallback) || 0;
}
