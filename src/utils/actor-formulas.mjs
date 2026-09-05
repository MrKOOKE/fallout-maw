import { calculateSkillDevelopmentBonuses } from "../advancement/calculations.mjs";
import {
  ACTOR_LEVEL_FORMULA_VARIABLE,
  buildActorFormulaAutocompleteEntries,
  buildActorFormulaReferenceData
} from "../formulas/actor-references.mjs";
import { evaluateFormula, evaluateSkillFormulas, getSkillValues } from "../formulas/evaluation.mjs";
import { getCharacteristicAliases, getSkillAliases } from "../formulas/normalization.mjs";
import { DEFAULT_NEEDS } from "../config/defaults.mjs";
import {
  getActorNeedSettings,
  getCreatureOptions,
  getNeedSettings,
  getPreparedRuntimeSettings
} from "../settings/accessors.mjs";
import { toInteger } from "./numbers.mjs";
import { formatFormulaForDisplay } from "./formula-display.mjs";
import { composePreparedSkillValue } from "./skill-value.mjs";
import {
  isReverseEffectKey,
  isSkillBonusPercentEffectKey
} from "./active-effect-keys.mjs";

const FORMULA_IDENTIFIER_PATTERN = /@?[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*/gu;
const PREPARED_REFERENCE_PATH_PATTERN = /@?(?:system\.)?(?:skills|resources|needs|proficiencies|limbs|load)\.[\p{L}_]/iu;
const INITIAL_ACTOR_FORMULA_VARIABLE_ALIASES = new Set([
  ACTOR_LEVEL_FORMULA_VARIABLE.key,
  ACTOR_LEVEL_FORMULA_VARIABLE.abbr,
  ...(ACTOR_LEVEL_FORMULA_VARIABLE.aliases ?? [])
].map(alias => String(alias ?? "").toLowerCase()));
let actorFormulaDataCache = new WeakMap();
let sharedFormulaSettingsCache = null;

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

  // #region codex-runtime-debug H9a temporary formula context count
  globalThis.__falloutMawGameplayProbe?.count?.("actor.formulaData.rebuild", "H9a");
  // #endregion

  const {
    characteristicSettings,
    skillSettings,
    skillAdvancementSettings,
    resourceSettings,
    needSettings: globalNeedSettings,
    proficiencySettings,
    creatureOptions
  } = getSharedFormulaSettings();
  const needSettings = getFormulaNeedSettings(actor, {
    includeGlobal: true,
    globalSettings: globalNeedSettings,
    creatureOptions
  });
  const characteristics = buildActorFormulaCharacteristics(actor, characteristicSettings, {
    includeDevelopment: normalizedStage === "initial-active-effect"
  });
  const skills = normalizedStage === "initial-active-effect"
    ? buildInitialActiveEffectSkillValues(actor, characteristicSettings, skillSettings, characteristics, skillAdvancementSettings)
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
  // This field participates in derived skill composition, so applying it in
  // Foundry's post-derived "final" phase would update the accumulator without
  // recalculating the skill value.
  if (isSkillBonusPercentEffectKey(change?.key) && !isReverseEffectKey(change?.key)) return "initial";
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
  const characteristicAliases = getFormulaDefinitionAliasSet(
    data,
    "characteristicSettings",
    "_formulaCharacteristicAliases",
    getCharacteristicAliases
  );
  const skillAliases = getFormulaDefinitionAliasSet(
    data,
    "skillSettings",
    "_formulaSkillAliases",
    getSkillAliases
  );
  const variableAliases = getFormulaAliasSet(data, "formulaVariables", "_formulaVariableAliases");
  const referenceAliases = getFormulaAliasSet(data, "formulaReferences", "_formulaReferenceAliases");
  for (const match of source.matchAll(FORMULA_IDENTIFIER_PATTERN)) {
    const token = String(match[0] ?? "");
    const explicitReference = token.startsWith("@");
    const identifier = token.replace(/^@/, "");
    if (!identifier) continue;
    const normalized = identifier.toLowerCase();
    // Match the evaluator's identifier precedence. A bare characteristic or
    // skill alias wins over an equally named prepared indicator variable.
    // In particular, `con` is Endurance even when a consciousness resource
    // also exposes `con` as an indicator alias.
    if (!explicitReference && (
      characteristicAliases.has(normalized)
      || skillAliases.has(normalized)
      || INITIAL_ACTOR_FORMULA_VARIABLE_ALIASES.has(normalized)
    )) continue;
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
      globalSettings: settings.needSettings,
      creatureOptions: settings.creatureOptions
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

function getFormulaNeedSettings(actor = null, { includeGlobal = false, globalSettings = null, creatureOptions = null } = {}) {
  const globals = includeGlobal || !actor
    ? (Array.isArray(globalSettings) ? globalSettings : safeGetNeedSettings())
    : [];
  if (!actor) return globals;
  let actorSettings = [];
  try {
    actorSettings = getActorNeedSettings(actor, creatureOptions);
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
  const runtimeSettings = getPreparedRuntimeSettings();
  if (sharedFormulaSettingsCache?.runtimeSettings === runtimeSettings) return sharedFormulaSettingsCache;
  // Settings invalidation changes the snapshot identity before Actors reset.
  // Actor values and construct-owned needs are still rebuilt per preparation.
  const snapshot = {
    runtimeSettings,
    characteristicSettings: runtimeSettings.characteristicSettings,
    skillSettings: runtimeSettings.skillSettings,
    skillAdvancementSettings: runtimeSettings.skillAdvancementSettings,
    resourceSettings: runtimeSettings.resourceSettings,
    needSettings: runtimeSettings.needSettings.length ? runtimeSettings.needSettings : getFallbackNeedSettings(),
    proficiencySettings: runtimeSettings.proficiencySettings,
    creatureOptions: runtimeSettings.creatureOptions
  };
  sharedFormulaSettingsCache = snapshot;
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

function getFormulaDefinitionAliasSet(data, sourceKey, cacheKey, buildAliases) {
  if (data?.[cacheKey] instanceof Set) return data[cacheKey];
  const aliases = new Set(Object.keys(buildAliases(data?.[sourceKey])).map(key => key.toLowerCase()));
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

function buildInitialActiveEffectSkillValues(actor, characteristicSettings, skillSettings, characteristics, skillAdvancementSettings) {
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
      const prepared = composePreparedSkillValue({
        base: toInteger(skillBases?.[skill.key]),
        bonus,
        developmentBonus: toInteger(skillBonuses?.[skill.key]),
        bonusPercent: toInteger(current?.bonusPercent),
        developmentLimitPureOnly: skillAdvancementSettings?.developmentLimitPureOnly !== false,
        min,
        max
      });
      return [skill.key, prepared.value];
    })
  );
}
