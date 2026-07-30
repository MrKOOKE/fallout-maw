const TOOL_CLASS_RANK = Object.freeze({ D: 0, C: 1, B: 2, A: 3, S: 4 });

export function createToolGroupKey(toolKey = "", toolClass = "D") {
  return `${encodeURIComponent(String(toolKey ?? "").trim())}:${normalizeToolClass(toolClass)}`;
}

export function normalizeToolSelectionPolicy(options = {}) {
  const allowedToolGroupKeys = Array.from(new Set(
    (Array.isArray(options.allowedToolGroupKeys) ? options.allowedToolGroupKeys : [])
      .map(value => String(value ?? "").trim())
      .filter(Boolean)
  ));
  return {
    qualityMode: String(options.qualityMode ?? options.mode ?? "matched") === "best"
      || String(options.mode ?? "") === "max"
      ? "best"
      : "matched",
    supplyMode: String(options.supplyMode ?? "depleted") === "balanced"
      ? "balanced"
      : "depleted",
    allowedToolGroupKeys
  };
}

export function groupToolSelectionOptions(instruments = []) {
  const groups = new Map();
  for (const instrument of instruments) {
    const toolKey = String(instrument?.toolKey ?? "").trim();
    const toolClass = normalizeToolClass(instrument?.toolClass);
    const key = createToolGroupKey(toolKey, toolClass);
    const current = groups.get(key) ?? {
      key,
      toolKey,
      toolLabel: String(instrument?.toolLabel ?? toolKey),
      toolClass,
      count: 0,
      supplyValue: 0,
      supplyMax: 0
    };
    current.count += 1;
    current.supplyValue += Math.max(0, toFiniteNumber(instrument?.supplyValue));
    current.supplyMax += Math.max(0, toFiniteNumber(instrument?.supplyMax));
    groups.set(key, current);
  }
  return Array.from(groups.values()).sort((left, right) => (
    String(left.toolLabel).localeCompare(String(right.toolLabel))
    || toToolClassRank(left.toolClass) - toToolClassRank(right.toolClass)
  ));
}

export function selectToolByPolicy(instruments = [], {
  requiredToolKey = "",
  requiredToolClass = "D"
} = {}, options = {}) {
  const policy = normalizeToolSelectionPolicy(options);
  const allowedGroups = new Set(policy.allowedToolGroupKeys);
  const requiredKey = String(requiredToolKey ?? "").trim();
  const requiredRank = toToolClassRank(requiredToolClass);
  const choices = instruments
    .filter(instrument => !requiredKey || String(instrument?.toolKey ?? "").trim() === requiredKey)
    .filter(instrument => Boolean(instrument?.requirementMet))
    .filter(instrument => toFiniteNumber(instrument?.supplyValue) > 0)
    .filter(instrument => toToolClassRank(instrument?.toolClass) >= requiredRank)
    .filter(instrument => (
      !allowedGroups.size
      || allowedGroups.has(createToolGroupKey(instrument?.toolKey, instrument?.toolClass))
    ))
    .map(instrument => ({
      instrument,
      rank: toToolClassRank(instrument?.toolClass),
      classSurplus: toToolClassRank(instrument?.toolClass) - requiredRank,
      supplyRatio: getSupplyRatio(instrument)
    }));

  choices.sort((left, right) => {
    const qualityOrder = policy.qualityMode === "best"
      ? right.classSurplus - left.classSurplus || right.rank - left.rank
      : left.classSurplus - right.classSurplus || left.rank - right.rank;
    if (qualityOrder) return qualityOrder;

    const supplyOrder = policy.supplyMode === "balanced"
      ? right.supplyRatio - left.supplyRatio
        || toFiniteNumber(right.instrument?.supplyValue) - toFiniteNumber(left.instrument?.supplyValue)
      : left.supplyRatio - right.supplyRatio
        || toFiniteNumber(left.instrument?.supplyValue) - toFiniteNumber(right.instrument?.supplyValue);
    if (supplyOrder) return supplyOrder;
    return String(left.instrument?.name ?? "").localeCompare(String(right.instrument?.name ?? ""))
      || String(left.instrument?.id ?? "").localeCompare(String(right.instrument?.id ?? ""));
  });
  return choices.at(0)?.instrument ?? null;
}

function getSupplyRatio(instrument) {
  const value = Math.max(0, toFiniteNumber(instrument?.supplyValue));
  const maximum = Math.max(0, toFiniteNumber(instrument?.supplyMax));
  return maximum > 0 ? value / maximum : value;
}

function normalizeToolClass(value) {
  const normalized = String(value ?? "D").trim().toUpperCase();
  return Object.hasOwn(TOOL_CLASS_RANK, normalized) ? normalized : "D";
}

function toToolClassRank(value) {
  return TOOL_CLASS_RANK[normalizeToolClass(value)];
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
