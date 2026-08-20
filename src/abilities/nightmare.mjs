import { normalizeNightmareSettings } from "../settings/abilities.mjs";
import { getReverseEffectKey } from "../utils/active-effect-keys.mjs";
import { toInteger } from "../utils/numbers.mjs";

const NIGHTMARE_FEAR_CHANGE_KEYS = Object.freeze([
  getReverseEffectKey("system.combat.damagePercent"),
  "system.combat.damagePercent",
  "system.resources.actionPoints.bonus",
  "system.resources.movementPoints.bonus",
  "system.skills.all.bonusPercent"
]);

export function buildNightmareFearChanges(settings = {}) {
  const normalized = normalizeNightmareSettings(settings);
  return [
    createChange(getReverseEffectKey("system.combat.damagePercent"), normalized.incomingDamagePercent),
    createChange("system.combat.damagePercent", -normalized.outgoingDamagePercentPenalty),
    createChange("system.resources.actionPoints.bonus", -normalized.actionPointPenalty),
    createChange("system.resources.movementPoints.bonus", -normalized.movementPointPenalty),
    createChange("system.skills.all.bonusPercent", -normalized.allSkillsPercentPenalty)
  ];
}

export function selectNightmareWitnessSkill(actor = null) {
  const science = toInteger(actor?.system?.skills?.science?.value);
  const resilience = toInteger(actor?.system?.skills?.resilience?.value);
  return resilience > science ? "resilience" : "science";
}

export function hasMaximumNightmareFearDuration(actor = null, maximumDurationSeconds = 0, worldTime = 0) {
  const maximum = Math.max(0, Number(maximumDurationSeconds) || 0);
  if (!maximum) return false;
  return Array.from(actor?.effects ?? []).some(effect => {
    if (effect?.disabled || effect?.isSuppressed || effect?.suppressed) return false;
    const keys = new Set((effect?.system?.changes ?? []).map(change => String(change?.key ?? "").trim()));
    if (!NIGHTMARE_FEAR_CHANGE_KEYS.every(key => keys.has(key))) return false;
    const remaining = getNightmareFearRemainingSeconds(effect, worldTime);
    return remaining === Infinity || remaining >= maximum - 0.001;
  });
}

export function getNightmareFearRemainingSeconds(effect = null, worldTime = 0) {
  const preparedRemaining = Number(effect?.duration?.remaining);
  if (preparedRemaining === Infinity) return Infinity;
  if (Number.isFinite(preparedRemaining)) return Math.max(0, preparedRemaining);

  const durationSeconds = Number(effect?.duration?.seconds ?? effect?._source?.duration?.seconds);
  if (!Number.isFinite(durationSeconds)) return Infinity;
  const startTime = Number(
    effect?.start?.time
      ?? effect?.duration?.startTime
      ?? effect?._source?.duration?.startTime
  );
  if (!Number.isFinite(startTime)) return Math.max(0, durationSeconds);
  return Math.max(0, startTime + durationSeconds - (Number(worldTime) || 0));
}

function createChange(key, value) {
  return {
    key,
    type: "add",
    value: String(value),
    phase: "initial",
    priority: null
  };
}
