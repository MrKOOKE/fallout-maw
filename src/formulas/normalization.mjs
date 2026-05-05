import {
  DEFAULT_CHARACTERISTICS,
  DEFAULT_DAMAGE_TYPES,
  DEFAULT_NEEDS,
  DEFAULT_PROFICIENCIES,
  DEFAULT_RESOURCES,
  DEFAULT_SKILL_DEVELOPMENT_LIMIT,
  DEFAULT_SIGNATURE_SKILL_FLAT_BONUS,
  DEFAULT_SIGNATURE_SKILL_MULTIPLIER,
  DEFAULT_SKILL_ADVANCEMENT,
  DEFAULT_SKILLS
} from "../config/defaults.mjs";
import { toInteger } from "../utils/numbers.mjs";

export const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_TRACK_COLOR = "#8f8456";
const DEFAULT_RESOURCE_COLORS = Object.freeze({
  health: "#c64b44",
  energy: "#4f9f61",
  dodge: "#4f97a5",
  actionPoints: "#74b84e",
  movementPoints: "#d7b14a"
});
const DEFAULT_NEED_COLORS = Object.freeze({
  hunger: "#c9a24a",
  thirst: "#58a6d6",
  sleepiness: "#8f63c9"
});

export function createDefaultCharacteristicSettings() {
  return DEFAULT_CHARACTERISTICS.map(entry => ({ ...entry }));
}

export function createDefaultSkillSettings() {
  return DEFAULT_SKILLS.map(entry => ({ ...entry }));
}

export function createDefaultSkillAdvancementSettings(
  skillSettings = createDefaultSkillSettings(),
  characteristicSettings = createDefaultCharacteristicSettings()
) {
  const skills = normalizeSkillSettings(skillSettings);
  const characteristics = normalizeCharacteristicSettings(characteristicSettings);

  return {
    signatureMultiplier: DEFAULT_SIGNATURE_SKILL_MULTIPLIER,
    signatureFlatBonus: DEFAULT_SIGNATURE_SKILL_FLAT_BONUS,
    developmentLimit: DEFAULT_SKILL_DEVELOPMENT_LIMIT,
    entries: Object.fromEntries(
      skills.map(skill => {
        const defaults = DEFAULT_SKILL_ADVANCEMENT[skill.key] ?? {};
        return [skill.key, {
          base: toDecimal(defaults.base, 0),
          characteristics: Object.fromEntries(
            characteristics.map(characteristic => [
              characteristic.key,
              toDecimal(defaults.characteristics?.[characteristic.key], 0)
            ])
          )
        }];
      })
    )
  };
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

export function normalizeSkillAdvancementSettings(
  settings,
  skillSettings = createDefaultSkillSettings(),
  characteristicSettings = createDefaultCharacteristicSettings()
) {
  const skills = normalizeSkillSettings(skillSettings);
  const characteristics = normalizeCharacteristicSettings(characteristicSettings);
  const defaults = createDefaultSkillAdvancementSettings(skills, characteristics);
  const source = settings?.advancement ?? settings ?? {};

  return {
    signatureMultiplier: toDecimal(source?.signatureMultiplier ?? source?.signature?.multiplier, defaults.signatureMultiplier),
    signatureFlatBonus: toDecimal(source?.signatureFlatBonus ?? source?.signature?.flatBonus, defaults.signatureFlatBonus),
    developmentLimit: Math.max(0, toInteger(source?.developmentLimit ?? source?.limit ?? defaults.developmentLimit)),
    entries: Object.fromEntries(
      skills.map(skill => {
        const sourceEntry = source?.entries?.[skill.key] ?? source?.skills?.[skill.key] ?? source?.[skill.key] ?? {};
        const defaultEntry = defaults.entries[skill.key];
        return [skill.key, {
          base: toDecimal(sourceEntry?.base ?? sourceEntry?.baseMultiplier, defaultEntry.base),
          characteristics: Object.fromEntries(
            characteristics.map(characteristic => [
              characteristic.key,
              toDecimal(
                sourceEntry?.characteristics?.[characteristic.key] ?? sourceEntry?.[characteristic.key],
                defaultEntry.characteristics[characteristic.key]
              )
            ])
          )
        }];
      })
    )
  };
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
        formula: String(entry?.formula ?? "0").trim() || "0",
        color: normalizeHexColor(entry?.color, getDefaultColorForKey(key))
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

function getDefaultColorForKey(key = "") {
  return normalizeHexColor(
    DEFAULT_RESOURCE_COLORS[key]
    ?? DEFAULT_NEED_COLORS[key]
    ?? DEFAULT_TRACK_COLOR,
    DEFAULT_TRACK_COLOR
  );
}

function normalizeHexColor(value, fallback = DEFAULT_TRACK_COLOR) {
  const normalized = normalizeHexColorString(value);
  if (normalized) return normalized;
  return normalizeHexColorString(fallback) ?? DEFAULT_TRACK_COLOR;
}

function normalizeHexColorString(value) {
  const trimmed = String(value ?? "").trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{6}$/.test(trimmed)) return `#${trimmed}`;
  if (/^[0-9a-f]{3}$/.test(trimmed)) return `#${trimmed.split("").map(char => `${char}${char}`).join("")}`;
  return null;
}

function toDecimal(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
