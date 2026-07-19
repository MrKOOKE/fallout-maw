const IDENTIFIER_PATTERN = /[\p{L}_][\p{L}\p{N}_]*/gu;
const OPERATOR_PATTERN = /\s*([+\-*/])\s*/g;

/**
 * Replace formula keys and abbreviations with their configured labels.
 * When values are provided, each resolved key also shows the value used by
 * the calculation so a tooltip never exposes an unexplained raw identifier.
 */
export function formatFormulaForDisplay(formula = "0", {
  characteristics = [],
  skills = [],
  characteristicValues = {},
  skillValues = {},
  includeValues = true,
  formatValue = defaultFormatValue
} = {}) {
  const aliases = new Map();
  addFormulaAliases(aliases, characteristics, characteristicValues);
  addFormulaAliases(aliases, skills, skillValues);

  // Format operators only in the original formula fragments. Applying this
  // after label replacement would corrupt configured labels containing a
  // hyphen or slash (for example, "Научно-технический").
  const source = String(formula ?? "0");
  let result = "";
  let cursor = 0;
  for (const match of source.matchAll(IDENTIFIER_PATTERN)) {
    result += formatFormulaFragment(source.slice(cursor, match.index));
    const identifier = match[0];
    const entry = aliases.get(identifier.toLowerCase());
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

function addFormulaAliases(target, entries = [], values = {}) {
  for (const entry of entries ?? []) {
    const key = String(entry?.key ?? "").trim();
    if (!key) continue;
    const resolved = {
      key,
      label: String(entry?.label ?? key),
      value: Number(values?.[key]) || 0
    };
    target.set(key.toLowerCase(), resolved);
    const abbr = String(entry?.abbr ?? "").trim();
    if (abbr) target.set(abbr.toLowerCase(), resolved);
  }
}

function defaultFormatValue(value = 0) {
  const numeric = Number(value) || 0;
  if (Number.isInteger(numeric)) return String(numeric);
  return numeric.toFixed(2).replace(/\.?0+$/, "");
}
