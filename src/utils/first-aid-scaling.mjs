export function scaleFirstAidSignedValue(value = 0, multiplier = 1) {
  const number = Number(value) || 0;
  if (!number) return 0;
  const scaled = Math.floor(Math.abs(number) * Math.max(0, Number(multiplier) || 0));
  const finalValue = scaled < 1 ? 1 : scaled;
  return number < 0 ? -finalValue : finalValue;
}

export function getFirstAidEffectivenessMultiplier(percent = 0) {
  return Math.max(0, 1 + (toInteger(percent) / 100));
}

export function getFirstAidWithdrawalResistanceMultiplier(percent = 0) {
  return Math.max(0, 1 - (toInteger(percent) / 100));
}

export function calculateFirstAidScalingMultipliers({
  resultMultiplier = 1,
  outgoingEffectivenessPercent = 0,
  incomingEffectivenessPercent = 0,
  outgoingHealingPercent = 0,
  durationPercent = 0,
  withdrawalResistancePercent = 0
} = {}) {
  const effect = Math.max(0, Number(resultMultiplier) || 0)
    * getFirstAidEffectivenessMultiplier(outgoingEffectivenessPercent)
    * getFirstAidEffectivenessMultiplier(incomingEffectivenessPercent);
  const healing = effect * getFirstAidEffectivenessMultiplier(outgoingHealingPercent);
  const duration = getFirstAidEffectivenessMultiplier(durationPercent);
  const withdrawalResistance = getFirstAidWithdrawalResistanceMultiplier(withdrawalResistancePercent);
  return {
    effect,
    healing,
    duration,
    withdrawalEffect: effect * withdrawalResistance,
    withdrawalHealing: healing * withdrawalResistance,
    withdrawalDuration: withdrawalResistance
  };
}

export function scaleFirstAidDurationSeconds(value = 0, multiplier = 1) {
  const seconds = Math.max(0, toInteger(value));
  const factor = Math.max(0, Number(multiplier) || 0);
  if (!seconds || !factor) return 0;
  return Math.max(1, Math.floor(seconds * factor));
}

function toInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}
