/** Add the prepared Emergency Operations bonus to a tool's normal efficiency. */
export function applyEmergencyOperationsToolEfficiency(baseEfficiency = 0, bonusPercent = 0) {
  return Math.max(0, Number(baseEfficiency) || 0) + Math.max(0, Number(bonusPercent) || 0);
}
