import { getIndicatorValueState } from "../utils/indicator-values.mjs";

const IDENTIFIER_PATTERN = /^[\p{L}_][\p{L}\p{N}_]*$/u;
const REACTION_RESOURCE = Object.freeze({
  key: "reactionPoints",
  abbr: "rea",
  label: "Очки реакции"
});
const LOAD_INDICATOR = Object.freeze({
  key: "load",
  abbr: "load",
  label: "Нагрузка"
});

const COMMON_FIELDS = Object.freeze([
  Object.freeze({ field: "value", suffix: "Value", label: "текущее значение" }),
  Object.freeze({ field: "max", suffix: "Max", label: "максимум" }),
  Object.freeze({ field: "min", suffix: "Min", label: "минимум" }),
  Object.freeze({ field: "bonus", suffix: "Bonus", label: "бонус" }),
  Object.freeze({ field: "spent", suffix: "Spent", label: "потрачено" })
]);
const SKILL_FIELDS = Object.freeze([
  Object.freeze({ field: "base", suffix: "Base", label: "база" }),
  Object.freeze({ field: "advantage", suffix: "Advantage", label: "преимущество" }),
  Object.freeze({ field: "disadvantage", suffix: "Disadvantage", label: "помеха" }),
  Object.freeze({ field: "developmentBonus", suffix: "DevelopmentBonus", label: "бонус развития" }),
  Object.freeze({ field: "abilityBonus", suffix: "AbilityBonus", label: "бонус способностей" })
]);
const LIMB_FIELDS = Object.freeze([
  Object.freeze({ field: "maxBonus", suffix: "MaxBonus", label: "бонус максимума" }),
  Object.freeze({ field: "aimedDifficultyPercent", suffix: "AimedDifficultyPercent", label: "сложность прицеливания, %" }),
  Object.freeze({ field: "aimedDifficultyBonus", suffix: "AimedDifficultyBonus", label: "бонус сложности прицеливания" }),
  Object.freeze({ field: "implantLimit", suffix: "ImplantLimit", label: "лимит имплантов" }),
  Object.freeze({ field: "implantLimitBase", suffix: "ImplantLimitBase", label: "базовый лимит имплантов" }),
  Object.freeze({ field: "implantLimitBonus", suffix: "ImplantLimitBonus", label: "бонус лимита имплантов" }),
  Object.freeze({ field: "damageMultiplier", suffix: "DamageMultiplier", label: "множитель урона" })
]);
const LOAD_FIELDS = Object.freeze([
  Object.freeze({ field: "limit", suffix: "Limit", label: "предел перегруза" }),
  Object.freeze({ field: "limitPercent", suffix: "LimitPercent", label: "предел перегруза, %" })
]);

/**
 * Build the actor-only aliases and explicit data references accepted by the
 * formula evaluator. This data is supplied only by actor-context formulas;
 * resource-setting formulas therefore cannot accidentally depend on their
 * own calculated values.
 */
export function buildActorFormulaReferenceData({
  system = {},
  characteristicSettings = [],
  skillSettings = [],
  resourceSettings = [],
  needSettings = [],
  proficiencySettings = [],
  limbSettings = [],
  characteristicValues = system?.characteristics ?? {},
  skillValues = {}
} = {}) {
  const state = createReferenceState();

  addScalarReferenceGroup(state, {
    root: "characteristics",
    definitions: characteristicSettings,
    values: characteristicValues
  });
  addIndicatorReferenceGroup(state, {
    root: "skills",
    definitions: skillSettings,
    values: mergeIndicatorValues(system?.skills, skillValues),
    extraFields: SKILL_FIELDS,
    includeBareValueAliases: false
  });
  addIndicatorReferenceGroup(state, {
    root: "resources",
    definitions: mergeDefinitions(resourceSettings, [REACTION_RESOURCE]),
    values: system?.resources,
    includeMissingPercent: true
  });
  addIndicatorReferenceGroup(state, {
    root: "needs",
    definitions: needSettings,
    values: system?.needs
  });
  addIndicatorReferenceGroup(state, {
    root: "proficiencies",
    definitions: proficiencySettings,
    values: system?.proficiencies
  });
  addIndicatorReferenceGroup(state, {
    root: "limbs",
    definitions: limbSettings,
    values: system?.limbs,
    extraFields: LIMB_FIELDS
  });
  if (system?.load && typeof system.load === "object") {
    addIndicatorReferenceGroup(state, {
      root: "load",
      definitions: [LOAD_INDICATOR],
      values: { load: system.load },
      extraFields: LOAD_FIELDS,
      rootIsEntry: true
    });
  }

  return {
    formulaVariables: state.formulaVariables,
    variables: Object.keys(state.formulaVariables),
    formulaVariableSettings: state.formulaVariableSettings,
    formulaReferences: state.formulaReferences,
    references: Object.keys(state.formulaReferences),
    formulaReferenceSettings: state.formulaReferenceSettings
  };
}

/**
 * Entries used by formula-value autocomplete. Explicit `Value` codes avoid
 * collisions with existing characteristic and skill abbreviations, while the
 * evaluator still accepts the short unsuffixed resource aliases as well.
 */
export function buildActorFormulaAutocompleteEntries({
  skills = [],
  resources = [],
  needs = [],
  proficiencies = [],
  limbs = [],
  includeLoad = true
} = {}) {
  const entries = [];
  addIndicatorAutocompleteEntries(entries, skills, "skill-indicator");
  addIndicatorAutocompleteEntries(entries, mergeDefinitions(resources, [REACTION_RESOURCE]), "resource", {
    includeMissingPercent: true
  });
  addIndicatorAutocompleteEntries(entries, needs, "need");
  addIndicatorAutocompleteEntries(entries, proficiencies, "proficiency");
  addIndicatorAutocompleteEntries(entries, limbs, "limb");
  if (includeLoad) addIndicatorAutocompleteEntries(entries, [LOAD_INDICATOR], "load");
  return deduplicateEntries(entries);
}

function createReferenceState() {
  return {
    formulaVariables: {},
    formulaVariableSettings: [],
    formulaReferences: {},
    formulaReferenceSettings: []
  };
}

function addScalarReferenceGroup(state, { root = "", definitions = [], values = {} } = {}) {
  for (const definition of collectDefinitions(definitions, values)) {
    const value = toFiniteNumber(values?.[definition.key]);
    addExplicitReference(state, `${root}.${definition.key}`, value, definition.label);
  }
}

function addIndicatorReferenceGroup(state, {
  root = "",
  definitions = [],
  values = {},
  extraFields = [],
  includeBareValueAliases = true,
  includeMissingPercent = false,
  rootIsEntry = false
} = {}) {
  for (const definition of collectDefinitions(definitions, values)) {
    const raw = normalizeIndicatorData(values?.[definition.key]);
    const indicator = getIndicatorValueState(raw, { integer: root !== "load" });
    const fields = [...COMMON_FIELDS, ...extraFields];

    for (const descriptor of fields) {
      const value = descriptor.field === "value"
        ? indicator.value
        : descriptor.field === "max"
          ? indicator.max
          : descriptor.field === "min"
            ? indicator.min
            : toFiniteNumber(raw?.[descriptor.field]);
      addIndicatorVariable(state, definition, descriptor.suffix, value, descriptor.label, {
        aliases: descriptor.field === "value" && includeBareValueAliases
          ? [definition.key, definition.abbr]
          : []
      });
      addIndicatorReference(state, root, definition, descriptor.field, value, descriptor.label, { rootIsEntry });
    }

    addIndicatorVariable(state, definition, "Percent", indicator.percent, "текущий процент");
    addIndicatorReference(state, root, definition, "percent", indicator.percent, "текущий процент", { rootIsEntry });

    if (includeMissingPercent) {
      const missingPercent = Math.max(0, Math.min(100, 100 - indicator.percent));
      addIndicatorVariable(state, definition, "MissingPercent", missingPercent, "недостающий процент");
      addIndicatorReference(state, root, definition, "missingPercent", missingPercent, "недостающий процент", { rootIsEntry });
    }
  }
}

function addIndicatorVariable(state, definition, suffix, value, detail, { aliases = [] } = {}) {
  const key = `${definition.key}${suffix}`;
  const abbr = definition.abbr ? `${definition.abbr}${suffix}` : "";
  const acceptedAliases = [key, abbr, ...aliases].filter(isValidIdentifier);
  if (!acceptedAliases.length) return;

  for (const alias of acceptedAliases) {
    if (!Object.hasOwn(state.formulaVariables, alias)) state.formulaVariables[alias] = value;
  }
  state.formulaVariableSettings.push({
    key,
    abbr,
    aliases: acceptedAliases.filter(alias => alias !== key && alias !== abbr),
    label: `${definition.label}: ${detail}`
  });
}

function addIndicatorReference(state, root, definition, field, value, detail, { rootIsEntry = false } = {}) {
  const path = rootIsEntry
    ? `${root}.${field}`
    : `${root}.${definition.key}.${field}`;
  addExplicitReference(state, path, value, `${definition.label}: ${detail}`);
}

function addExplicitReference(state, path, value, label) {
  const normalized = String(path ?? "").trim();
  if (!normalized) return;
  const systemPath = normalized.startsWith("system.") ? normalized : `system.${normalized}`;
  if (!Object.hasOwn(state.formulaReferences, normalized)) state.formulaReferences[normalized] = value;
  if (!Object.hasOwn(state.formulaReferences, systemPath)) state.formulaReferences[systemPath] = value;
  state.formulaReferenceSettings.push({
    key: normalized,
    aliases: systemPath === normalized ? [] : [systemPath],
    label: String(label ?? normalized)
  });
}

function addIndicatorAutocompleteEntries(target, definitions, type, { includeMissingPercent = false } = {}) {
  for (const definition of collectDefinitions(definitions)) {
    target.push(createAutocompleteEntry(definition, "Value", "текущее значение", type));
    target.push(createAutocompleteEntry(definition, "Max", "максимум", type));
    target.push(createAutocompleteEntry(definition, "Percent", "текущий процент", type));
    if (includeMissingPercent) {
      target.push(createAutocompleteEntry(definition, "MissingPercent", "недостающий процент", type));
    }
  }
}

function createAutocompleteEntry(definition, suffix, detail, type) {
  return {
    key: `${definition.key}${suffix}`,
    abbr: `${definition.abbr || definition.key}${suffix}`,
    label: `${definition.label}: ${detail}`,
    type
  };
}

function collectDefinitions(definitions = [], values = {}) {
  const result = [];
  const used = new Set();
  for (const raw of definitions ?? []) {
    const definition = normalizeDefinition(raw);
    if (!definition || used.has(definition.key)) continue;
    used.add(definition.key);
    result.push(definition);
  }
  for (const [key, value] of Object.entries(values ?? {})) {
    if (used.has(key) || !isValidIdentifier(key)) continue;
    used.add(key);
    result.push({
      key,
      abbr: "",
      label: String(value?.label ?? value?.name ?? key).trim() || key
    });
  }
  return result;
}

function mergeDefinitions(...collections) {
  return collectDefinitions(collections.flat());
}

function normalizeDefinition(entry = {}) {
  const key = String(entry?.key ?? "").trim();
  if (!isValidIdentifier(key)) return null;
  const abbr = isValidIdentifier(entry?.abbr) ? String(entry.abbr).trim() : "";
  return {
    key,
    abbr,
    label: String(entry?.label ?? entry?.name ?? key).trim() || key
  };
}

function normalizeIndicatorData(value) {
  if (value && typeof value === "object") {
    const max = Number.isFinite(Number(value.max)) ? value.max : value.value;
    return {
      ...value,
      min: Number.isFinite(Number(value.min)) ? value.min : 0,
      max: Number.isFinite(Number(max)) ? max : 0,
      value: Number.isFinite(Number(value.value))
        ? value.value
        : Number(max) - Math.max(0, Number(value.spent) || 0)
    };
  }
  const number = toFiniteNumber(value);
  return { min: 0, value: number, max: number };
}

function mergeIndicatorValues(values = {}, valueOverrides = {}) {
  const keys = new Set([...Object.keys(values ?? {}), ...Object.keys(valueOverrides ?? {})]);
  return Object.fromEntries(Array.from(keys).map(key => {
    const current = values?.[key];
    const base = current && typeof current === "object" ? current : {};
    const override = Number(valueOverrides?.[key]);
    return [key, {
      ...base,
      value: Number.isFinite(override) ? override : (current?.value ?? current ?? 0)
    }];
  }));
}

function deduplicateEntries(entries = []) {
  const used = new Set();
  return entries.filter(entry => {
    const code = String(entry?.abbr || entry?.key || "").toLocaleLowerCase();
    if (!code || used.has(code)) return false;
    used.add(code);
    return true;
  });
}

function isValidIdentifier(value) {
  return IDENTIFIER_PATTERN.test(String(value ?? "").trim());
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
