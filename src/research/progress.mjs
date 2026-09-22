import { normalizeResearchProgressPerSuccess, roundResearchValue } from "./storage.mjs";

export function calculateResearchProgressGain(skillValue, result = {}, { progressPerSuccess = 1, legacy = false } = {}) {
  if (result.autoFailure) return 0;
  if (!legacy) {
    const gain = normalizeResearchProgressPerSuccess(progressPerSuccess);
    if (result.key === "criticalSuccess") return roundResearchValue(gain * 2);
    if (result.key === "criticalFailure") return gain ? -gain : 0;
    return result.key === "success" ? gain : 0;
  }

  const baseSkill = Math.max(0, Number(skillValue) || 0);
  if (result.key === "criticalSuccess") return roundResearchValue(baseSkill * 1.5);
  if (result.key === "success") return roundResearchValue(baseSkill);
  if (result.key === "failure") return roundResearchValue(baseSkill * 0.3);
  return 0;
}
