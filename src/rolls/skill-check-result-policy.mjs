const RESULT_KEYS = Object.freeze([
  "criticalFailure",
  "failure",
  "success",
  "criticalSuccess"
]);

function normalizeResultKey(value = "") {
  const key = String(value ?? "").trim();
  return RESULT_KEYS.includes(key) ? key : "";
}

function normalizeThreshold(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
}

export function normalizeSkillCheckResultPolicy(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const disabledResults = Object.fromEntries(RESULT_KEYS.map(key => [
    key,
    Number(source.disabledResults?.[key]) > 0 || source.disabledResults?.[key] === true
  ]));
  const disabledResultsWhenSuccessChanceAbove = Object.fromEntries(RESULT_KEYS.map(key => [
    key,
    Number(source.disabledResultsWhenSuccessChanceAbove?.[key]) > 0
      || source.disabledResultsWhenSuccessChanceAbove?.[key] === true
  ]));
  const sharedThreshold = normalizeThreshold(source.successChanceThreshold);
  const disabledResultSuccessChanceThresholds = Object.fromEntries(RESULT_KEYS.map(key => [
    key,
    disabledResultsWhenSuccessChanceAbove[key]
      ? normalizeThreshold(source.disabledResultSuccessChanceThresholds?.[key]) ?? sharedThreshold
      : null
  ]));
  return {
    disabledResults,
    disabledResultsWhenSuccessChanceAbove,
    disabledResultSuccessChanceThresholds,
    forcedResult: normalizeResultKey(source.forcedResult),
    forcedResultWhenSuccessChanceAbove: normalizeResultKey(source.forcedResultWhenSuccessChanceAbove),
    successChanceThreshold: normalizeThreshold(
      source.forcedResultSuccessChanceThreshold ?? source.successChanceThreshold
    )
  };
}

export function mergeSkillCheckResultPolicies(...values) {
  const policies = values
    .filter(value => value && typeof value === "object")
    .map(normalizeSkillCheckResultPolicy);
  const merged = normalizeSkillCheckResultPolicy();
  for (const policy of policies) {
    for (const key of RESULT_KEYS) {
      merged.disabledResults[key] ||= policy.disabledResults[key];
      const threshold = policy.disabledResultSuccessChanceThresholds[key];
      const currentThreshold = merged.disabledResultSuccessChanceThresholds[key];
      if (threshold !== null && (currentThreshold === null || threshold < currentThreshold)) {
        merged.disabledResultsWhenSuccessChanceAbove[key] = true;
        merged.disabledResultSuccessChanceThresholds[key] = threshold;
      }
    }
    if (policy.forcedResult) merged.forcedResult = policy.forcedResult;
    if (policy.forcedResultWhenSuccessChanceAbove && policy.successChanceThreshold !== null) {
      const currentThreshold = merged.successChanceThreshold;
      if (currentThreshold === null || policy.successChanceThreshold < currentThreshold) {
        merged.forcedResultWhenSuccessChanceAbove = policy.forcedResultWhenSuccessChanceAbove;
        merged.successChanceThreshold = policy.successChanceThreshold;
      }
    }
  }
  return merged;
}

export function resolveSkillCheckResultPolicy(value = {}, successChance = 0) {
  const policy = normalizeSkillCheckResultPolicy(value);
  const disabledResults = { ...policy.disabledResults };
  for (const key of RESULT_KEYS) {
    const threshold = policy.disabledResultSuccessChanceThresholds[key];
    if (threshold !== null && Number(successChance) > threshold) disabledResults[key] = true;
  }
  const thresholdResult = policy.forcedResultWhenSuccessChanceAbove
    && policy.successChanceThreshold !== null
    && Number(successChance) > policy.successChanceThreshold
    ? policy.forcedResultWhenSuccessChanceAbove
    : "";
  return {
    disabledResults,
    forcedResult: policy.forcedResult || thresholdResult
  };
}
