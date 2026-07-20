const IDENTIFIER_PATTERN = /@?[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*/gu;
const OPERATOR_PATTERN = /\s*([+\-*/])\s*/g;

/**
 * Replace formula keys and abbreviations with their configured labels.
 * When values are provided, each resolved key also shows the value used by
 * the calculation so a tooltip never exposes an unexplained raw identifier.
 */
export function formatFormulaForDisplay(formula = "0", {
  characteristics = [],
  skills = [],
  variables = [],
  references = [],
  characteristicValues = {},
  skillValues = {},
  variableValues = {},
  referenceValues = {},
  includeValues = true,
  formatValue = defaultFormatValue
} = {}) {
  const aliases = new Map();
  addFormulaAliases(aliases, characteristics, characteristicValues);
  addFormulaAliases(aliases, skills, skillValues);
  addFormulaAliases(aliases, variables, variableValues, { overwrite: false });
  addFormulaAliases(aliases, references, referenceValues, { overwrite: false, references: true });

  // Format operators only in the original formula fragments. Applying this
  // after label replacement would corrupt configured labels containing a
  // hyphen or slash (for example, "Научно-технический").
  const source = String(formula ?? "0");
  let result = "";
  let cursor = 0;
  for (const match of source.matchAll(IDENTIFIER_PATTERN)) {
    result += formatFormulaFragment(source.slice(cursor, match.index));
    const identifier = match[0];
    const entry = aliases.get(normalizeAlias(identifier));
    if (!entry) result += identifier;
    else {
      const label = String(entry.label || entry.key || identifier);
      result += includeValues ? `${label} (${formatValue(entry.value)})` : label;
    }
    cursor = match.index + identifier.length;
  }
  result += formatFormulaFragment(source.slice(cursor));
  return result.replace(/\s+/g, " ").trim();
}

function formatFormulaFragment(value = "") {
  return String(value).replace(OPERATOR_PATTERN, " $1 ");
}

function addFormulaAliases(target, entries = [], values = {}, { overwrite = true, references = false } = {}) {
  for (const entry of entries ?? []) {
    const key = String(entry?.key ?? "").trim();
    if (!key) continue;
    const resolved = {
      key,
      label: String(entry?.label ?? key),
      value: Number(values?.[key]) || 0
    };
    setAlias(target, key, resolved, overwrite, references);
    const abbr = String(entry?.abbr ?? "").trim();
    if (abbr) setAlias(target, abbr, resolved, overwrite, references);
    for (const alias of entry?.aliases ?? []) {
      setAlias(target, alias, resolved, overwrite, references);
    }
  }
}

function setAlias(target, alias, resolved, overwrite, reference) {
  const normalized = reference ? normalizeAlias(alias) : String(alias ?? "").toLowerCase();
  if (!normalized || (!overwrite && target.has(normalized))) return;
  target.set(normalized, resolved);
}

function normalizeAlias(value) {
  return String(value ?? "").trim().replace(/^@/, "").toLowerCase();
}

function defaultFormatValue(value = 0) {
  const numeric = Number(value) || 0;
  if (Number.isInteger(numeric)) return String(numeric);
  return numeric.toFixed(2).replace(/\.?0+$/, "");
}
