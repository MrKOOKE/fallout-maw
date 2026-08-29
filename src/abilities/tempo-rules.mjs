import { normalizeTempoSettings } from "../settings/abilities.mjs";
import { ATTACK_ACTION_POINT_MOVEMENT_LOSS_PERCENT_BONUS_EFFECT_KEY } from "../utils/active-effect-keys.mjs";
import { toInteger } from "../utils/numbers.mjs";

/** Clamp a signed change to the configured Tempo range. */
export function advanceTempo(tempo = 0, delta = 0, maximum = 5) {
  const maxTempo = Math.max(1, toInteger(maximum));
  return Math.max(0, Math.min(maxTempo, toInteger(tempo) + toInteger(delta)));
}

/** Resolve every elapsed automatic gain without per-interval document writes. */
export function advanceTempoPeriodicState(state = {}, worldTime = 0, settings = {}) {
  const normalized = normalizeTempoSettings(settings);
  const now = finiteNumber(worldTime);
  const interval = normalized.automaticIntervalSeconds;
  const currentTempo = advanceTempo(state.tempo, 0, normalized.maxTempo);
  let nextGainAt = finiteNumber(state.nextGainAt, now + interval);
  if (nextGainAt > now) {
    return { tempo: currentTempo, nextGainAt, elapsedIntervals: 0, gainedTempo: 0 };
  }

  const elapsedIntervals = Math.floor((now - nextGainAt) / interval) + 1;
  nextGainAt += elapsedIntervals * interval;
  const tempo = advanceTempo(
    currentTempo,
    elapsedIntervals * normalized.automaticGain,
    normalized.maxTempo
  );
  return {
    tempo,
    nextGainAt,
    elapsedIntervals,
    gainedTempo: tempo - currentTempo
  };
}

/** The same resolved attack changes attacker and exact defender in opposite directions. */
export function getTempoAttackDeltas(success = false, settings = {}) {
  const normalized = normalizeTempoSettings(settings);
  return {
    attacker: success ? normalized.successfulAttackGain : -normalized.missedAttackLoss,
    defender: success ? -normalized.incomingHitLoss : normalized.incomingMissGain
  };
}

/** Build the ordinary actor effect changes represented by the current Tempo. */
export function buildTempoEffectChanges(tempo = 0, settings = {}) {
  const normalized = normalizeTempoSettings(settings);
  const count = advanceTempo(tempo, 0, normalized.maxTempo);
  if (!count) return [];
  return [
    createAddChange("system.resources.actionPoints.bonus", count * normalized.actionPointsPerTempo),
    createAddChange("system.resources.movementPoints.bonus", count * normalized.movementPointsPerTempo),
    createAddChange("system.combat.accuracy", count * normalized.accuracyPerTempo),
    createAddChange("system.combat.damagePercent", count * normalized.damagePercentPerTempo),
    createAddChange(
      ATTACK_ACTION_POINT_MOVEMENT_LOSS_PERCENT_BONUS_EFFECT_KEY,
      -count * normalized.attackMovementLossReductionPercentPerTempo
    )
  ].filter(change => Number(change.value) !== 0);
}

function createAddChange(key, value) {
  return {
    key,
    type: "add",
    value: String(value),
    phase: "initial",
    priority: null
  };
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number(fallback) || 0;
}
