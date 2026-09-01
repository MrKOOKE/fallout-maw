import { toInteger } from "../utils/numbers.mjs";

export const KEEP_AWAY_KNOCKDOWN_DEFAULT_SETTINGS = Object.freeze({
  activationEnergyCost: 10,
  overloadEnergyCost: 10,
  overloadDurationSeconds: 6,
  baseDifficulty: 50,
  lostHealthPercentMultiplier: 10
});

export function normalizeKeepAwayKnockdownSettings(settings = {}) {
  return {
    activationEnergyCost: nonNegativeInteger(
      settings.activationEnergyCost,
      KEEP_AWAY_KNOCKDOWN_DEFAULT_SETTINGS.activationEnergyCost
    ),
    overloadEnergyCost: nonNegativeInteger(
      settings.overloadEnergyCost,
      KEEP_AWAY_KNOCKDOWN_DEFAULT_SETTINGS.overloadEnergyCost
    ),
    overloadDurationSeconds: nonNegativeInteger(
      settings.overloadDurationSeconds,
      KEEP_AWAY_KNOCKDOWN_DEFAULT_SETTINGS.overloadDurationSeconds
    ),
    baseDifficulty: nonNegativeInteger(
      settings.baseDifficulty,
      KEEP_AWAY_KNOCKDOWN_DEFAULT_SETTINGS.baseDifficulty
    ),
    lostHealthPercentMultiplier: nonNegativeNumber(
      settings.lostHealthPercentMultiplier,
      KEEP_AWAY_KNOCKDOWN_DEFAULT_SETTINGS.lostHealthPercentMultiplier
    )
  };
}

/** Current percentage of maximum Health that the target has already lost. */
export function getActorLostHealthPercent(actor = null) {
  const health = actor?.system?.resources?.health ?? {};
  const maximum = Math.max(0, Number(health.max) || 0);
  if (maximum <= 0) return 0;
  const value = Math.max(0, Math.min(maximum, Number(health.value) || 0));
  return Math.max(0, Math.min(100, ((maximum - value) / maximum) * 100));
}

export function getKeepAwayKnockdownDifficulty(healthDamagePercent = 0, settings = {}) {
  const normalized = normalizeKeepAwayKnockdownSettings(settings);
  const lostPercent = Math.max(0, Math.min(100, Number(healthDamagePercent) || 0));
  return Math.floor(normalized.baseDifficulty + (lostPercent * normalized.lostHealthPercentMultiplier));
}

export function didKeepAwayResistanceFail(knockbackResult = null) {
  return Math.max(0, toInteger(knockbackResult?.failedChecks)) > 0;
}

/** Apply prone after the same failed resistance that caused knockback. */
export async function applyKeepAwayKnockdown({
  targetActor = null,
  knockbackResult = null,
  setPosture = null
} = {}) {
  if (!targetActor || !didKeepAwayResistanceFail(knockbackResult) || typeof setPosture !== "function") {
    return false;
  }
  await setPosture(targetActor, "knocked");
  return true;
}

function nonNegativeInteger(value, fallback = 0) {
  const number = Number(value);
  return Math.max(0, toInteger(Number.isFinite(number) ? number : fallback));
}

function nonNegativeNumber(value, fallback = 0) {
  const number = Number(value);
  return Math.max(0, Number.isFinite(number) ? number : fallback);
}
