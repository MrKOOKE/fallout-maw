/**
 * Group the configured and runtime-prepared ability cost vectors by resource.
 * The caller supplies the same row evaluator used for the preview actor, while
 * this helper keeps aggregation deterministic and independently testable.
 */
export function buildAbilityTooltipCostGroups(baseRows = [], preparedRows = [], {
  evaluateRow = defaultEvaluateRow
} = {}) {
  const groups = new Map();
  const ensureGroup = resourceKey => {
    const key = String(resourceKey ?? "").trim();
    if (!key) return null;
    const group = groups.get(key) ?? {
      resourceKey: key,
      baseRows: [],
      preparedRows: []
    };
    groups.set(key, group);
    return group;
  };

  for (const row of baseRows ?? []) ensureGroup(row?.resourceKey)?.baseRows.push(row);
  for (const row of preparedRows ?? []) ensureGroup(row?.resourceKey)?.preparedRows.push(row);

  return Array.from(groups.values()).map(group => ({
    ...group,
    base: sumEvaluatedRows(group.baseRows, evaluateRow),
    total: sumEvaluatedRows(group.preparedRows, evaluateRow)
  }));
}

function sumEvaluatedRows(rows = [], evaluateRow = defaultEvaluateRow) {
  return rows.reduce((total, row) => {
    const value = Number(evaluateRow(row));
    return total + (Number.isFinite(value) ? value : 0);
  }, 0);
}

function defaultEvaluateRow(row = {}) {
  const value = Number(row?.formula);
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
