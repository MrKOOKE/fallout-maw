/**
 * Pure runtime helpers for a function that offers a limited subset of its
 * changes.  Keeping the selection contract independent from DialogV2 makes
 * it usable by active applications, item-use triggers and acquisition flows
 * without coupling those paths to a particular UI.
 */

export const ABILITY_CHANGE_SELECTION_MODES = Object.freeze({
  exact: "exact",
  upTo: "upTo"
});

export function normalizeAbilityChangeSelectionMode(value = "") {
  return value === ABILITY_CHANGE_SELECTION_MODES.upTo
    ? ABILITY_CHANGE_SELECTION_MODES.upTo
    : ABILITY_CHANGE_SELECTION_MODES.exact;
}

export function getSelectableAbilityChanges(changes = []) {
  const source = Array.isArray(changes) ? changes : Object.values(changes ?? {});
  return source
    .map((change, index) => ({
      change,
      index,
      id: getChangeSelectionId(change, index)
    }))
    .filter(entry => String(entry.change?.key ?? "").trim() && String(entry.change?.value ?? "") !== "");
}

export function getLimitedChangeConditions(conditions = []) {
  return (Array.isArray(conditions) ? conditions : Object.values(conditions ?? {}))
    .filter(condition => (
      condition?.type === "limitedChanges" || condition?.type === "selectedChanges"
    ));
}

export function resolveLimitedChangeLimit(conditions = [], actor = null, {
  evaluateLimit = defaultEvaluateLimit
} = {}) {
  const limited = getLimitedChangeConditions(conditions);
  if (!limited.length) return null;
  const values = limited.map(condition => {
    const formula = String(condition?.limitFormula ?? condition?.formula ?? condition?.limit ?? 1).trim() || "1";
    const evaluated = Number(evaluateLimit(formula, actor, condition));
    return Math.max(1, Number.isFinite(evaluated) ? Math.trunc(evaluated) : 1);
  });
  return Math.max(1, Math.min(...values));
}

/**
 * Multiple limit rows remain conservative: every participating row must opt
 * into `upTo`; legacy or mixed rows retain the historical exact-count rule.
 */
export function resolveLimitedChangeSelectionMode(conditions = []) {
  const limited = getLimitedChangeConditions(conditions);
  return limited.length > 0 && limited.every(condition => (
    normalizeAbilityChangeSelectionMode(condition?.selectionMode)
      === ABILITY_CHANGE_SELECTION_MODES.upTo
  ))
    ? ABILITY_CHANGE_SELECTION_MODES.upTo
    : ABILITY_CHANGE_SELECTION_MODES.exact;
}

export function isLimitedChangeSelectionCountValid(count, limit, {
  selectionMode = ABILITY_CHANGE_SELECTION_MODES.exact,
  minimum = 1
} = {}) {
  const maximum = Math.max(1, toPositiveInteger(limit, 1));
  const normalizedMinimum = Math.max(1, Math.min(maximum, toPositiveInteger(minimum, 1)));
  const selected = Math.max(0, toNonNegativeInteger(count));
  return normalizeAbilityChangeSelectionMode(selectionMode) === ABILITY_CHANGE_SELECTION_MODES.upTo
    ? selected >= normalizedMinimum && selected <= maximum
    : selected === maximum;
}

/**
 * Resolve the selected change rows.  `choose` receives the already filtered
 * rows and must return their ids, or null/undefined when the user cancels.
 */
export async function resolveLimitedChangeSet({
  changes = [],
  conditions = [],
  actor = null,
  evaluateLimit = defaultEvaluateLimit,
  choose = null
} = {}) {
  const available = getSelectableAbilityChanges(changes);
  const selectionMode = resolveLimitedChangeSelectionMode(conditions);
  const minimum = 1;
  if (!available.length) {
    return { changes: [], ids: [], limit: 0, minimum, selectionMode, cancelled: false, available };
  }

  const configuredLimit = resolveLimitedChangeLimit(conditions, actor, { evaluateLimit });
  const limit = configuredLimit === null
    ? available.length
    : Math.min(available.length, configuredLimit);
  if (
    selectionMode === ABILITY_CHANGE_SELECTION_MODES.exact
    && limit >= available.length
  ) {
    return {
      changes: available.map(entry => entry.change),
      ids: available.map(entry => entry.id),
      limit,
      minimum,
      selectionMode,
      cancelled: false,
      available
    };
  }
  if (typeof choose !== "function") {
    return { changes: [], ids: [], limit, minimum, selectionMode, cancelled: true, available };
  }

  const selectedIds = await choose({
    changes: available.map(entry => entry.change),
    selectionIds: available.map(entry => entry.id),
    limit,
    minimum,
    selectionMode,
    actor
  });
  if (!selectedIds) {
    return { changes: [], ids: [], limit, minimum, selectionMode, cancelled: true, available };
  }

  const selected = new Set((Array.isArray(selectedIds) ? selectedIds : [])
    .map(id => String(id ?? "").trim())
    .filter(Boolean));
  const selectedEntries = available.filter(entry => selected.has(entry.id));
  if (!isLimitedChangeSelectionCountValid(selectedEntries.length, limit, { selectionMode, minimum })) {
    return { changes: [], ids: [], limit, minimum, selectionMode, cancelled: true, available };
  }
  return {
    changes: selectedEntries.map(entry => entry.change),
    ids: selectedEntries.map(entry => entry.id),
    limit,
    minimum,
    selectionMode,
    cancelled: false,
    available
  };
}

export function getChangeSelectionId(change = {}, index = 0) {
  return String(change?.id ?? "").trim() || `change-${index}`;
}

/**
 * Format a change value for the limited-selection picker. Evaluated values
 * are supplied by the runtime so this helper remains independent from Actor
 * documents and can also represent target-dependent ranges.
 */
export function formatLimitedChangeDisplayValue(change = {}, evaluatedValues = []) {
  const rawValue = String(change?.value ?? "").trim();
  if (!rawValue) return "";

  const resolved = (Array.isArray(evaluatedValues) ? evaluatedValues : [evaluatedValues])
    .map(value => Number(value))
    .filter(Number.isFinite);
  const uniqueValues = [...new Set(resolved.map(value => Object.is(value, -0) ? 0 : value))]
    .sort((left, right) => left - right);
  const type = String(change?.type ?? "add");

  if (uniqueValues.length > 1) {
    const first = formatLimitedChangeNumber(uniqueValues[0]);
    const last = formatLimitedChangeNumber(uniqueValues.at(-1));
    if (type === "add") return `${formatSignedLimitedChangeNumber(uniqueValues[0])}…${formatSignedLimitedChangeNumber(uniqueValues.at(-1))}`;
    if (type === "override") return `= ${first}…${last}`;
    if (type === "multiply") return `× ${first}…${last}`;
    if (type === "upgrade") return `≥ ${first}…${last}`;
    if (type === "downgrade") return `≤ ${first}…${last}`;
    return `${first}…${last}`;
  }

  const displayValue = uniqueValues.length
    ? formatLimitedChangeNumber(uniqueValues[0])
    : rawValue;
  if (type === "add") {
    const number = Number(displayValue);
    if (Number.isFinite(number)) return number >= 0 ? `+${displayValue}` : displayValue;
    return displayValue.startsWith("-") ? displayValue : `+${displayValue}`;
  }
  if (type === "override") return `= ${displayValue}`;
  if (type === "multiply") return `× ${displayValue}`;
  if (type === "upgrade") return `≥ ${displayValue}`;
  if (type === "downgrade") return `≤ ${displayValue}`;
  return displayValue;
}

function formatSignedLimitedChangeNumber(value) {
  const normalized = Object.is(Number(value), -0) ? 0 : Number(value);
  const formatted = formatLimitedChangeNumber(normalized);
  return normalized >= 0 ? `+${formatted}` : formatted;
}

function formatLimitedChangeNumber(value) {
  const number = Object.is(Number(value), -0) ? 0 : Number(value);
  if (!Number.isFinite(number)) return "0";
  if (Number.isInteger(number)) return String(number);
  return number.toFixed(2).replace(/\.?0+$/, "");
}

function defaultEvaluateLimit(formula) {
  const value = Number(formula);
  return Number.isFinite(value) ? value : 1;
}

function toPositiveInteger(value, fallback = 1) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : fallback;
}

function toNonNegativeInteger(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}
