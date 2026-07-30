/**
 * Collapse effect rows which are mechanically identical during trauma
 * escalation. Numeric additive and multiplicative changes are combined,
 * overrides keep the latest value, and repeated statuses become one row.
 *
 * Changes with a different phase, priority or operation remain independent.
 * Non-numeric additive/multiplicative expressions are also retained because
 * joining arbitrary formulas would change their evaluation semantics.
 */
export function mergeMatchingTraumaEffectChanges(effectChanges = []) {
  const merged = [];
  const mergeIndexByIdentity = new Map();

  for (const source of Array.isArray(effectChanges) ? effectChanges : []) {
    const change = cloneEffectChange(source);
    if (!change.key) continue;

    const identity = getMergeIdentity(change);
    const previousIndex = mergeIndexByIdentity.get(identity);
    if (previousIndex === undefined) {
      mergeIndexByIdentity.set(identity, merged.length);
      merged.push(change);
      continue;
    }

    const previous = merged[previousIndex];
    const combined = combineEffectChanges(previous, change);
    if (!combined) {
      merged.push(change);
      continue;
    }
    merged[previousIndex] = combined;
  }

  return merged;
}

function combineEffectChanges(previous, current) {
  if (current.key.startsWith("status.")) {
    return {
      ...previous,
      value: isTruthyEffectValue(previous.value) || isTruthyEffectValue(current.value)
        ? "1"
        : "0"
    };
  }

  if (current.type === "override") return current;
  if (!["add", "multiply"].includes(current.type)) return null;

  const previousValue = Number(previous.value);
  const currentValue = Number(current.value);
  if (!Number.isFinite(previousValue) || !Number.isFinite(currentValue)) return null;

  const value = current.type === "multiply"
    ? previousValue * currentValue
    : previousValue + currentValue;
  return {
    ...previous,
    value: formatEffectNumber(value)
  };
}

function getMergeIdentity(change) {
  const priority = change.priority === undefined || change.priority === null
    ? ""
    : String(change.priority);
  return JSON.stringify([
    change.key,
    change.type,
    change.phase,
    priority
  ]);
}

function cloneEffectChange(source = {}) {
  const change = {
    key: String(source?.key ?? "").trim(),
    type: String(source?.type || "add"),
    value: String(source?.value ?? "0"),
    phase: String(source?.phase || "initial")
  };
  if (source?.priority !== undefined && source?.priority !== null && source?.priority !== "") {
    const priority = Number(source.priority);
    if (Number.isFinite(priority)) change.priority = Math.trunc(priority);
  }
  return change;
}

function formatEffectNumber(value) {
  if (!Number.isFinite(value) || Object.is(value, -0)) return "0";
  return String(Number(value.toFixed(12)));
}

function isTruthyEffectValue(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return !["", "0", "false", "no", "off"].includes(text);
}
