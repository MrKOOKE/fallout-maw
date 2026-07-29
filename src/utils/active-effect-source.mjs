/**
 * Convert ActiveEffect change rows to the source shape used by Foundry's
 * ActiveEffect type data model.
 *
 * Foundry v14 migrates JSON-encoded legacy values before preparing a document
 * ("60" becomes 60, "true" becomes true, while a formula remains a string).
 * System-owned effects must use the same boundary representation or every
 * comparison after a reload reports a false change.
 */
export function canonicalizeActiveEffectChanges(changes = []) {
  return (Array.isArray(changes) ? changes : []).map(change => {
    const sourceValue = Object.hasOwn(change ?? {}, "value") ? change.value : "";
    const rawPriority = change?.priority;
    const priority = rawPriority === "" || rawPriority === null || rawPriority === undefined
      ? null
      : Number(rawPriority);
    return {
      key: String(change?.key ?? "").trim(),
      type: String(change?.type ?? "add").trim() || "add",
      value: canonicalizeActiveEffectChangeValue(sourceValue),
      phase: String(change?.phase ?? "initial").trim() || "initial",
      priority: Number.isNaN(priority) ? null : priority
    };
  });
}

/**
 * Mirror BaseActiveEffect's recursive legacy value migration.
 */
export function canonicalizeActiveEffectChangeValue(value) {
  if (typeof value !== "string") return cloneSerializableValue(value);
  const normalized = value.trim();
  if (normalized === "") return normalized;
  try {
    return canonicalizeActiveEffectChangeValue(JSON.parse(normalized));
  } catch {
    return normalized;
  }
}

export function activeEffectChangesEqual(left = [], right = []) {
  return sourceValuesEqual(
    canonicalizeActiveEffectChanges(left),
    canonicalizeActiveEffectChanges(right)
  );
}

function cloneSerializableValue(value) {
  if (Array.isArray(value)) return value.map(cloneSerializableValue);
  if (!value || typeof value !== "object") {
    return [Infinity, -Infinity].includes(value) ? null : value;
  }
  const cloned = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) cloned[key] = cloneSerializableValue(entry);
  }
  return cloned;
}

function sourceValuesEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sourceValuesEqual(value, right[index]));
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every(key => Object.hasOwn(right, key) && sourceValuesEqual(left[key], right[key]));
}
