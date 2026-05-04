import {
  DEFAULT_CHARACTERISTICS,
  DEFAULT_DAMAGE_TYPES,
  DEFAULT_NEEDS,
  DEFAULT_PROFICIENCIES,
  DEFAULT_RESOURCES,
  DEFAULT_SKILLS
} from "../config/defaults.mjs";
import { toInteger } from "../utils/numbers.mjs";

export const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function createDefaultCharacteristicSettings() {
  return DEFAULT_CHARACTERISTICS.map(entry => ({ ...entry }));
}

export function createDefaultSkillSettings() {
  return DEFAULT_SKILLS.map(entry => ({ ...entry }));
}

export function createDefaultProficiencySettings() {
  return DEFAULT_PROFICIENCIES.map(entry => ({ ...entry }));
}

export function createDefaultResourceSettings() {
  return DEFAULT_RESOURCES.map(entry => ({ ...entry }));
}

export function createDefaultNeedSettings() {
  return DEFAULT_NEEDS.map(entry => ({ ...entry }));
}

export function createDefaultDamageTypeSettings() {
  return DEFAULT_DAMAGE_TYPES.map(entry => ({ ...entry }));
}

export function normalizeCharacteristicSettings(settings) {
  const source = normalizeCollectionInput(settings?.characteristics ?? settings, createDefaultCharacteristicSettings());
  return normalizeKeyedEntries(
    source,
    entry => {
      const key = String(entry?.key ?? "").trim();
      return {
        key,
        abbr: String(entry?.abbr ?? "").trim(),
        label: String(entry?.label ?? entry?.name ?? "").trim()
      };
    },
    "Характеристика"
  );
}

export function normalizeSkillSettings(settings) {
  const source = normalizeSkillSettingsInput(settings);
  return normalizeKeyedEntries(
    source,
    entry => {
      const key = String(entry?.key ?? "").trim();
      return {
        key,
        abbr: String(entry?.abbr ?? "").trim(),
        label: String(entry?.label ?? entry?.name ?? "").trim(),
        formula: String(entry?.formula ?? "0").trim() || "0"
      };
    },
    "Навык"
  );
}

export function normalizeProficiencySettings(settings) {
  const source = normalizeCollectionInput(settings, createDefaultProficiencySettings());
  return normalizeKeyedEntries(
    source,
    entry => {
      const key = String(entry?.key ?? "").trim();
      return {
        key,
        abbr: String(entry?.abbr ?? "").trim(),
        label: String(entry?.label ?? entry?.name ?? "").trim(),
        max: Math.max(0, toInteger(entry?.max))
      };
    },
    "Владение"
  );
}

export function normalizeResourceSettings(settings) {
  return normalizeFormulaSettings(settings, createDefaultResourceSettings(), "Ресурс");
}

export function normalizeNeedSettings(settings) {
  return normalizeFormulaSettings(settings, createDefaultNeedSettings(), "Потребность");
}

export function normalizeDamageTypeSettings(settings) {
  const source = normalizeCollectionInput(settings, createDefaultDamageTypeSettings());
  return normalizeKeyedEntries(
    source,
    entry => ({
      key: String(entry?.key ?? "").trim(),
      label: String(entry?.label ?? entry?.name ?? "").trim()
    }),
    "Тип урона"
  );
}

export function normalizeFormulaMap(values = {}, definitions = [], defaultFormula = "0") {
  return Object.fromEntries(
    definitions.map(definition => {
      const formula = String(values?.[definition.key] ?? defaultFormula).trim();
      return [definition.key, formula || defaultFormula];
    })
  );
}

export function normalizeNumberMap(values = {}, definitions = []) {
  return Object.fromEntries(definitions.map(definition => [definition.key, toInteger(values?.[definition.key])]));
}

export function getCharacteristicAliases(characteristics) {
  const normalized = normalizeCharacteristicSettings(characteristics);
  const aliases = {};
  for (const entry of normalized) addEntryAliases(aliases, entry);
  return aliases;
}

export function getSkillAliases(skills) {
  const normalized = normalizeSkillSettings(skills);
  const aliases = {};
  for (const entry of normalized) addEntryAliases(aliases, entry);
  return aliases;
}

function normalizeSkillSettingsInput(settings) {
  if (settings === undefined || settings === null) return createDefaultSkillSettings();
  if (Array.isArray(settings)) return settings;
  if (settings && typeof settings === "object" && Array.isArray(settings.entries)) return settings.entries;
  return createDefaultSkillSettings();
}

function normalizeFormulaSettings(settings, defaults, defaultLabel) {
  const source = normalizeCollectionInput(settings, defaults);
  return normalizeKeyedEntries(
    source,
    entry => {
      const key = String(entry?.key ?? "").trim();
      return {
        key,
        abbr: String(entry?.abbr ?? "").trim(),
        label: String(entry?.label ?? entry?.name ?? "").trim(),
        formula: String(entry?.formula ?? "0").trim() || "0"
      };
    },
    defaultLabel
  );
}

function normalizeCollectionInput(settings, defaults) {
  if (settings === undefined || settings === null) return defaults;
  if (Array.isArray(settings)) return settings;
  if (Array.isArray(settings?.entries)) return settings.entries;
  if (settings && typeof settings === "object") {
    return Object.entries(settings).map(([key, label]) => ({ key, label }));
  }
  return defaults;
}

function normalizeKeyedEntries(source, mapEntry, defaultLabel) {
  const used = new Set();
  const entries = [];

  for (const raw of source) {
    const entry = mapEntry(raw);
    if (!IDENTIFIER_PATTERN.test(entry.key) || used.has(entry.key)) continue;
    used.add(entry.key);
    entries.push({ ...entry, label: entry.label || `${defaultLabel} ${entries.length + 1}` });
  }

  return entries;
}

function addEntryAliases(aliases, entry) {
  aliases[entry.key.toLowerCase()] = entry.key;
  if (entry.abbr) aliases[entry.abbr.toLowerCase()] = entry.key;
}
