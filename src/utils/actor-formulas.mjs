import { calculateSkillDevelopmentBonuses } from "../advancement/calculations.mjs";
import {
  buildActorFormulaAutocompleteEntries,
  buildActorFormulaReferenceData
} from "../formulas/actor-references.mjs";
import { evaluateFormula, evaluateSkillFormulas, getSkillValues } from "../formulas/evaluation.mjs";
import { DEFAULT_NEEDS } from "../config/defaults.mjs";
import {
  getActorNeedSettings,
  getCharacteristicSettings,
  getCreatureOptions,
  getNeedSettings,
  getProficiencySettings,
  getResourceSettings,
  getSkillAdvancementSettings,
  getSkillSettings
} from "../settings/accessors.mjs";
import { toInteger } from "./numbers.mjs";
import { formatFormulaForDisplay } from "./formula-display.mjs";

const FORMULA_IDENTIFIER_PATTERN = /@?[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*/gu;
const PREPARED_REFERENCE_PATH_PATTERN = /@?(?:system\.)?(?:skills|resources|needs|proficiencies|limbs|load)\.[\p{L}_]/iu;
let actorFormulaDataCache = new WeakMap();
let sharedFormulaSettingsCache = null;
let sharedFormulaSettingsCacheScheduled = false;

export function evaluateActorFormula(formula, actor = null, { fallback = 0, minimum = 0, context = "" } = {}) {
  const text = String(formula ?? "").trim();
  if (!text) return Math.max(minimum, toInteger(fallback));
  const direct = Number(text);
  if (Number.isFinite(direct)) return Math.max(minimum, Math.trunc(direct));
  try {
    const value = evaluateFormula(text, buildActorFormulaData(actor));
    return Math.max(minimum, value);
  } catch (error) {
    const label = context ? ` (${context})` : "";
    console.warn(`Fallout MaW | Formula evaluation failed${label}: ${error.message}`);
    return Math.max(minimum, toInteger(fallback));
  }
}

export function buildActorFormulaData(actor = null, { stage = "prepared", cache = true } = {}) {
  const normalizedStage = String(stage ?? "prepared") || "prepared";
  const cached = cache ? getCachedActorFormulaData(actor, normalizedStage) : null;
  if (cached) return cached;

  const {
    characteristicSettings,
    skillSettings,
    resourceSettings,
    needSettings: globalNeedSettings,
    proficiencySettings
  } = getSharedFormulaSettings();
  const needSettings = getFormulaNeedSettings(actor, {
    includeGlobal: true,
    globalSettings: globalNeedSettings
  });
  const characteristics = buildActorFormulaCharacteristics(actor, characteristicSettings, {
    includeDevelopment: normalizedStage === "initial-active-effect"
  });
  const skills = normalizedStage === "initial-active-effect"
    ? buildInitialActiveEffectSkillValues(actor, characteristicSettings, skillSettings, characteristics)
    : getSkillValues(actor?.system?.skills ?? {});
  const formulaReferences = buildActorFormulaReferenceData({
    system: actor?.system ?? {},
    characteristicSettings,
    skillSettings,
    resourceSettings,
    needSettings,
    proficiencySettings,
    limbSettings: getActorLimbSettings(actor),
    characteristicValues: characteristics,
    skillValues: skills
  });

  const data = {
    characteristicSettings,
    skillSettings,
    resourceSettings,
    needSettings,
    proficiencySettings,
    characteristics,
    skills,
    ...formulaReferences
  };
  if (cache) setCachedActorFormulaData(actor, normalizedStage, data);
  return data;
}

export function invalidateActorFormulaData(actor = null) {
  if (actor && (typeof actor === "object" || typeof actor === "function")) {
    actorFormulaDataCache.delete(actor);
    return;
  }
  actorFormulaDataCache = new WeakMap();
}

/**
 * Actor indicators are prepared after the initial Active Effect phase. A
 * change which reads one of them must therefore be applied in the final phase
 * so the runtime value and every later attribution use the same snapshot.
 */
export function getActorFormulaApplicationPhase(change = {}, actor = null, { formulaData = null } = {}) {
  const configured = String(change?.phase ?? "initial").trim() || "initial";
  if (configured !== "initial") return configured;

  const value = change?.value;
  if (typeof value === "number") return configured;
  if (typeof value !== "string") return configured;
  if (Number.isFinite(Number(value.trim()))) return configured;
  if (PREPARED_REFERENCE_PATH_PATTERN.test(value)) return "final";
  const data = resolveFormulaDataOption(formulaData)
    ?? getCachedActorFormulaData(actor, "prepared")
    ?? getCachedActorFormulaData(actor, "initial-active-effect")
    ?? buildActorFormulaData(actor, { stage: "initial-active-effect" });
  return formulaUsesPreparedActorReferences(value, data) ? "final" : configured;
}

export function formulaUsesPreparedActorReferences(formula = "", data = {}) {
  const source = String(formula ?? "");
  if (!source) return false;
  const variableAliases = getFormulaAliasSet(data, "formulaVariables", "_formulaVariableAliases");
  const referenceAliases = getFormulaAliasSet(data, "formulaReferences", "_formulaReferenceAliases");
  for (const match of source.matchAll(FORMULA_IDENTIFIER_PATTERN)) {
    const identifier = String(match[0] ?? "").replace(/^@/, "");
    if (!identifier) continue;
    const normalized = identifier.toLowerCase();
    if (variableAliases.has(normalized)) return true;
    if (
      !normalized.startsWith("characteristics.")
      && !normalized.startsWith("system.characteristics.")
      && referenceAliases.has(normalized)
    ) return true;
  }
  return false;
}

export function getActorFormulaAutocompleteEntries(subject = null) {
  const actor = resolveFormulaActor(subject);
  const settings = getSharedFormulaSettings();
  return buildActorFormulaAutocompleteEntries({
    skills: settings.skillSettings,
    resources: settings.resourceSettings,
    needs: getFormulaNeedSettings(actor, {
      includeGlobal: true,
      globalSettings: settings.needSettings
    }),
    proficiencies: settings.proficiencySettings,
    limbs: getFormulaLimbSettings(actor),
    includeLoad: true
  });
}

export function isFormulaTextConfigured(value) {
  const text = String(value ?? "").trim();
  return Boolean(text) && text !== "0";
}

export function formatActorFormulaForDisplay(formula = "0", actor = null, { includeValues = Boolean(actor) } = {}) {
  const data = buildActorFormulaData(actor);
  return formatFormulaForDisplay(formula, {
    characteristics: data.characteristicSettings,
    skills: data.skillSettings,
    characteristicValues: data.characteristics,
    skillValues: data.skills,
    variables: data.formulaVariableSettings,
    variableValues: data.formulaVariables,
    references: data.formulaReferenceSettings,
    referenceValues: data.formulaReferences,
    includeValues
  });
}

function getFormulaNeedSettings(actor = null, { includeGlobal = false, globalSettings = null } = {}) {
  const globals = includeGlobal || !actor
    ? (Array.isArray(globalSettings) ? globalSettings : safeGetNeedSettings())
    : [];
  if (!actor) return globals;
  let actorSettings = [];
  try {
    actorSettings = getActorNeedSettings(actor);
  } catch (_error) {
    actorSettings = [];
  }
  return mergeFormulaSettings(globals, actorSettings);
}

function safeGetNeedSettings() {
  try {
    const settings = getNeedSettings();
    return settings.length ? settings : getFallbackNeedSettings();
  } catch (_error) {
    return getFallbackNeedSettings();
  }
}

function getFallbackNeedSettings() {
  return DEFAULT_NEEDS.map(entry => ({ ...entry }));
}

function getActorLimbSettings(actor = null) {
  return Object.entries(actor?.system?.limbs ?? {}).map(([key, limb]) => ({
    key,
    label: String(limb?.label ?? key)
  }));
}

function getFormulaLimbSettings(actor = null) {
  const configured = [];
  try {
    for (const race of getCreatureOptions()?.races ?? []) {
      configured.push(...(race?.limbs ?? []));
    }
  } catch (_error) {
    // Actor-owned limb definitions below remain available without settings.
  }
  return mergeFormulaSettings(configured, getActorLimbSettings(actor));
}

function mergeFormulaSettings(...collections) {
  const byKey = new Map();
  for (const entry of collections.flat()) {
    const key = String(entry?.key ?? "").trim();
    if (!key) continue;
    byKey.set(key, { ...byKey.get(key), ...entry, key });
  }
  return Array.from(byKey.values());
}

function resolveFormulaActor(subject = null) {
  if (!subject) return null;
  if (subject.documentName === "Actor") return subject;
  if (subject.actor?.documentName === "Actor") return subject.actor;
  if (subject.parent?.documentName === "Actor") return subject.parent;
  if (subject.parent?.actor?.documentName === "Actor") return subject.parent.actor;
  if (subject.system?.resources || subject.system?.characteristics) return subject;
  return null;
}

function getSharedFormulaSettings() {
  if (sharedFormulaSettingsCache) return sharedFormulaSettingsCache;
  const snapshot = {
    characteristicSettings: getCharacteristicSettings(),
    skillSettings: getSkillSettings(),
    resourceSettings: getResourceSettings(),
    needSettings: safeGetNeedSettings(),
    proficiencySettings: getProficiencySettings()
  };
  sharedFormulaSettingsCache = snapshot;
  if (!sharedFormulaSettingsCacheScheduled) {
    sharedFormulaSettingsCacheScheduled = true;
    queueMicrotask(() => {
      if (sharedFormulaSettingsCache === snapshot) sharedFormulaSettingsCache = null;
      sharedFormulaSettingsCacheScheduled = false;
    });
  }
  return snapshot;
}

function getCachedActorFormulaData(actor, stage) {
  if (!actor || (typeof actor !== "object" && typeof actor !== "function")) return null;
  return actorFormulaDataCache.get(actor)?.get(stage) ?? null;
}

function setCachedActorFormulaData(actor, stage, data) {
  if (!actor || (typeof actor !== "object" && typeof actor !== "function")) return;
  let cache = actorFormulaDataCache.get(actor);
  if (!cache) {
    cache = new Map();
    actorFormulaDataCache.set(actor, cache);
    if (actor?.documentName !== "Actor") {
      queueMicrotask(() => {
        if (actorFormulaDataCache.get(actor) === cache) actorFormulaDataCache.delete(actor);
      });
    }
  }
  cache.set(stage, data);
}

function resolveFormulaDataOption(value) {
  return typeof value === "function" ? value() : value;
}

function getFormulaAliasSet(data, sourceKey, cacheKey) {
  if (data?.[cacheKey] instanceof Set) return data[cacheKey];
  const aliases = new Set(Object.keys(data?.[sourceKey] ?? {}).map(key => key.toLowerCase()));
  if (data && typeof data === "object") {
    Object.defineProperty(data, cacheKey, {
      configurable: true,
      enumerable: false,
      value: aliases
    });
  }
  return aliases;
}

function buildActorFormulaCharacteristics(actor = null, characteristicSettings = [], { includeDevelopment = false } = {}) {
  const characteristics = actor?.system?.characteristics ?? {};
  const development = includeDevelopment ? actor?.system?.development?.characteristics ?? {} : {};
  return Object.fromEntries(
    characteristicSettings.map(characteristic => [
      characteristic.key,
      toInteger(characteristics?.[characteristic.key]) + toInteger(development?.[characteristic.key])
    ])
  );
}

function buildInitialActiveEffectSkillValues(actor = null, characteristicSettings = [], skillSettings = [], characteristics = {}) {
  const skillAdvancementSettings = getSkillAdvancementSettings(characteristicSettings, skillSettings);
  const skillBases = evaluateSkillFormulas(skillSettings, characteristicSettings, characteristics);
  const skillBonuses = calculateSkillDevelopmentBonuses(
    skillSettings,
    characteristics,
    skillAdvancementSettings,
    actor?.system?.development,
    {}
  );
  const max = Math.max(0, toInteger(skillAdvancementSettings?.developmentLimit));

  return Object.fromEntries(
    skillSettings.map(skill => {
      const current = actor?.system?.skills?.[skill.key] ?? {};
      const min = Math.max(0, toInteger(current?.min));
      const bonus = toInteger(current?.bonus);
      const value = Math.min(
        Math.max(toInteger(skillBases?.[skill.key]) + bonus + toInteger(skillBonuses?.[skill.key]), min),
        max
      );
      return [skill.key, value];
    })
  );
}
