import { toInteger } from "../utils/numbers.mjs";

export const CASCADE_DEFAULT_SETTINGS = Object.freeze({
  accuracyPerStack: 25,
  damagePercentPerStack: 15,
  maxStacks: 4,
  initialStacks: 1,
  periodicGain: 1,
  periodicIntervalSeconds: 6,
  weaponSwitchGain: 1,
  resetOnRepeatedWeapon: true
});

export function normalizeCascadeSettings(settings = {}) {
  return {
    accuracyPerStack: toInteger(
      settings?.accuracyPerStack
      ?? settings?.accuracyBonus
      ?? CASCADE_DEFAULT_SETTINGS.accuracyPerStack
    ),
    damagePercentPerStack: toInteger(
      settings?.damagePercentPerStack
      ?? settings?.damagePercentBonus
      ?? CASCADE_DEFAULT_SETTINGS.damagePercentPerStack
    ),
    maxStacks: Math.max(1, toInteger(
      settings?.maxStacks
      ?? settings?.cascadeMaxStacks
      ?? CASCADE_DEFAULT_SETTINGS.maxStacks
    )),
    initialStacks: Math.max(0, toInteger(
      settings?.initialStacks ?? CASCADE_DEFAULT_SETTINGS.initialStacks
    )),
    periodicGain: Math.max(0, toInteger(
      settings?.periodicGain ?? CASCADE_DEFAULT_SETTINGS.periodicGain
    )),
    periodicIntervalSeconds: Math.max(1, toInteger(
      settings?.periodicIntervalSeconds
      ?? settings?.cascadeIntervalSeconds
      ?? settings?.intervalSeconds
      ?? CASCADE_DEFAULT_SETTINGS.periodicIntervalSeconds
    )),
    weaponSwitchGain: Math.max(0, toInteger(
      settings?.weaponSwitchGain ?? CASCADE_DEFAULT_SETTINGS.weaponSwitchGain
    )),
    resetOnRepeatedWeapon: settings?.resetOnRepeatedWeapon !== false
  };
}

/** Create the combat-scoped state. Combat start itself grants one stack. */
export function createCascadeCombatState(options = {}) {
  const settings = normalizeRuleSettings(options);
  const now = finiteNumber(options.worldTime);
  return {
    combatUuid: String(options.combatUuid ?? "").trim(),
    stacks: Math.min(settings.initialStacks, settings.maxStacks),
    nextGainAt: now + settings.periodicIntervalSeconds
  };
}

/**
 * Read all elapsed periodic gains without mutating or writing the source
 * state. Keeping nextGainAt on a fixed schedule prevents capped stacks from
 * banking elapsed intervals for a later reset.
 */
export function advanceCascadePeriodicState(state = {}, worldTime = 0, options = {}) {
  const settings = normalizeRuleSettings(options);
  const now = finiteNumber(worldTime);
  const currentStacks = clampStacks(state?.stacks, settings.maxStacks);
  let nextGainAt = finiteNumber(state?.nextGainAt, now + settings.periodicIntervalSeconds);
  if (nextGainAt > now) {
    return { stacks: currentStacks, nextGainAt, elapsedIntervals: 0, gainedStacks: 0 };
  }

  const elapsedIntervals = Math.floor((now - nextGainAt) / settings.periodicIntervalSeconds) + 1;
  nextGainAt += elapsedIntervals * settings.periodicIntervalSeconds;
  const stacks = Math.min(settings.maxStacks, currentStacks + (elapsedIntervals * settings.periodicGain));
  return {
    stacks,
    nextGainAt,
    elapsedIntervals,
    gainedStacks: stacks - currentStacks
  };
}

/**
 * Snapshot Cascade once at the beginning of an attack cycle. The returned
 * bonus is safe to reuse for every hit check and every damage request in that
 * cycle; nextState must only be committed by the aggregate resolved event.
 */
export function createCascadeAttackSnapshot({
  state = {},
  weaponIdentity = "",
  attackId = "",
  combatUuid = "",
  worldTime = 0,
  settings = {}
} = {}) {
  const normalizedWeaponIdentity = String(weaponIdentity ?? "").trim();
  const normalizedAttackId = String(attackId ?? "").trim();
  const normalizedCombatUuid = String(combatUuid ?? "").trim();
  if (!normalizedWeaponIdentity || !normalizedCombatUuid) return inactiveSnapshot();

  const rules = normalizeRuleSettings(settings);
  const stateMatchesCombat = String(state?.combatUuid ?? "").trim() === normalizedCombatUuid;
  const initialState = stateMatchesCombat
    ? state
    : createCascadeCombatState({
      combatUuid: normalizedCombatUuid,
      worldTime,
      ...rules
    });
  const periodic = advanceCascadePeriodicState(initialState, worldTime, rules);
  const previousWeaponIdentity = stateMatchesCombat
    ? String(state?.weaponIdentity ?? "").trim()
    : "";
  const sameWeapon = Boolean(previousWeaponIdentity)
    && previousWeaponIdentity === normalizedWeaponIdentity;
  const repeatedWeapon = sameWeapon && rules.resetOnRepeatedWeapon;
  const switchedWeapon = Boolean(previousWeaponIdentity)
    && previousWeaponIdentity !== normalizedWeaponIdentity;
  const stacks = repeatedWeapon
    ? 0
    : Math.min(
      rules.maxStacks,
      periodic.stacks + (switchedWeapon ? rules.weaponSwitchGain : 0)
    );
  const nextState = {
    combatUuid: normalizedCombatUuid,
    weaponIdentity: normalizedWeaponIdentity,
    stacks,
    nextGainAt: periodic.nextGainAt,
    ...(normalizedAttackId ? { lastAttackId: normalizedAttackId } : {})
  };

  return {
    active: true,
    attackId: normalizedAttackId,
    combatUuid: normalizedCombatUuid,
    weaponIdentity: normalizedWeaponIdentity,
    bonusMultiplier: repeatedWeapon ? 0 : stacks,
    repeatedWeapon,
    switchedWeapon,
    stacks,
    nextState
  };
}

/** Commit a previously captured cycle snapshot exactly once. */
export function commitCascadeAttackSnapshot(state = {}, snapshot = {}) {
  if (snapshot?.active !== true || !snapshot?.nextState) {
    return { changed: false, nextState: state };
  }
  const attackId = String(snapshot.attackId ?? "").trim();
  if (attackId && String(state?.lastAttackId ?? "").trim() === attackId) {
    return { changed: false, nextState: state };
  }
  return {
    changed: true,
    nextState: { ...snapshot.nextState }
  };
}

function inactiveSnapshot() {
  return {
    active: false,
    attackId: "",
    combatUuid: "",
    weaponIdentity: "",
    bonusMultiplier: 0,
    repeatedWeapon: false,
    switchedWeapon: false,
    stacks: 0,
    nextState: null
  };
}

function normalizeRuleSettings(value = {}) {
  const settings = normalizeCascadeSettings(value);
  return {
    maxStacks: settings.maxStacks,
    initialStacks: Math.min(settings.initialStacks, settings.maxStacks),
    periodicGain: settings.periodicGain,
    periodicIntervalSeconds: settings.periodicIntervalSeconds,
    weaponSwitchGain: settings.weaponSwitchGain,
    resetOnRepeatedWeapon: settings.resetOnRepeatedWeapon
  };
}

function clampStacks(value, maxStacks) {
  return Math.max(0, Math.min(maxStacks, toInteger(value)));
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number(fallback) || 0;
}
