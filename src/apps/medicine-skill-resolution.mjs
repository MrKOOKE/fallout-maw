import { toInteger } from "../utils/numbers.mjs";

/**
 * Resolve whether a medical action needs a roll or can use the configured
 * skill-threshold mode. This helper intentionally deals only with the action's
 * own skill and difficulty; requirements of the selected tool remain a
 * separate authoritative gate.
 */
export function evaluateMedicineSkillResolution(actor, {
  skillKey = "",
  difficulty = 0,
  thresholdMode = false
} = {}) {
  const normalizedSkillKey = String(skillKey ?? "").trim();
  const normalizedDifficulty = Math.max(0, toInteger(difficulty));
  const skillValue = normalizedSkillKey
    ? toInteger(actor?.system?.skills?.[normalizedSkillKey]?.value)
    : 0;
  const usesThreshold = Boolean(thresholdMode && normalizedSkillKey);

  return {
    skillKey: normalizedSkillKey,
    skillValue,
    difficulty: normalizedDifficulty,
    usesThreshold,
    requiresCheck: Boolean(normalizedSkillKey && !usesThreshold),
    met: !usesThreshold || skillValue >= normalizedDifficulty,
    resultKey: usesThreshold && skillValue < normalizedDifficulty ? "failure" : "success",
    resultLabel: usesThreshold ? "навык соответствует порогу" : "успех"
  };
}

/**
 * Resolve one medical skill action without coupling this module to the Foundry
 * roll UI. Callers provide the real requestSkillCheck invocation; tests can
 * supply a spy and verify that threshold mode never invokes it.
 */
export async function resolveMedicineSkillAction(
  actor,
  skillOptions = {},
  { requestCheck } = {}
) {
  const resolution = evaluateMedicineSkillResolution(actor, skillOptions);
  if (!resolution.met) {
    return {
      ...resolution,
      checkPerformed: false,
      outcome: null
    };
  }
  if (!resolution.requiresCheck) {
    return {
      ...resolution,
      checkPerformed: false,
      outcome: { result: { key: "success" } }
    };
  }
  if (typeof requestCheck !== "function") {
    throw new TypeError("Medicine skill-check mode requires a requestCheck callback.");
  }
  return {
    ...resolution,
    checkPerformed: true,
    outcome: await requestCheck()
  };
}
