import { toInteger } from "../utils/numbers.mjs";
import { BLEEDING_DAMAGE_TYPE_KEY } from "../constants.mjs";

const DEFAULT_HEALING_DIFFICULTY = 60;
const DEFAULT_HEALING_TOOL_CLASS = "D";
const DEFAULT_HEALING_PROGRESS = 100;
const DEFAULT_HEALING_SKILL = "doctor";
const HEALING_TOOL_CLASSES = new Set(["D", "C", "B", "A", "S"]);
const DEFAULT_TRAUMA_THRESHOLDS = [60, 0];

export function createDefaultTraumaSettings() {
  return { groups: {} };
}

export function normalizeTraumaSettings(value = {}, creatureOptions = {}, damageTypes = []) {
  const sourceGroups = value && typeof value === "object" ? value.groups ?? {} : {};
  const normalizedGroups = {};
  const traumaDamageTypes = getTraumaDamageTypes(damageTypes);

  for (const limbSet of getUniqueLimbSets(creatureOptions)) {
    normalizedGroups[limbSet.id] = normalizeTraumaGroup(getTraumaGroupSource(sourceGroups, limbSet), limbSet, traumaDamageTypes);
  }

  return { groups: normalizedGroups };
}

export function getTraumaGroupForActor(actor, settings = null, creatureOptions = {}, damageTypes = []) {
  const race = creatureOptions.races.find(entry => entry.id === actor?.system?.creature?.raceId);
  const limbSetId = getLimbSetId(race?.limbs ?? []);
  const normalized = settings ?? normalizeTraumaSettings({}, creatureOptions, damageTypes);
  const traumaDamageTypes = getTraumaDamageTypes(damageTypes);
  return {
    id: limbSetId,
    race,
    config: normalized.groups?.[limbSetId] ?? normalizeTraumaGroup({}, { limbs: [] }, traumaDamageTypes)
  };
}

export function getTraumaDamageTypes(damageTypes = []) {
  return (Array.isArray(damageTypes) ? damageTypes : [])
    .filter(damageType => String(damageType?.key ?? "").trim() !== BLEEDING_DAMAGE_TYPE_KEY);
}

export function getUniqueLimbSets(creatureOptions = {}) {
  const groups = new Map();

  for (const race of creatureOptions?.races ?? []) {
    const limbs = normalizeLimbSetLimbs(race?.limbs ?? [], { sort: false });
    const id = getLimbSetId(limbs);
    if (!id) continue;

    const group = groups.get(id) ?? {
      id,
      limbs,
      legacyIds: [],
      races: [],
      raceNames: ""
    };
    const legacyId = getLegacyLimbSetId(limbs);
    if (legacyId && !group.legacyIds.includes(legacyId)) group.legacyIds.push(legacyId);
    group.races.push({ id: race.id, name: race.name || race.id });
    group.raceNames = group.races.map(entry => entry.name).join(", ");
    groups.set(id, group);
  }

  return Array.from(groups.values()).sort((left, right) => left.raceNames.localeCompare(right.raceNames));
}

export function getLimbSetId(limbs = []) {
  const normalized = normalizeLimbSetLimbs(limbs, { sort: true });
  if (!normalized.length) return "";
  return normalized
    .map(limb => limb.key)
    .join("|");
}

function getLegacyLimbSetId(limbs = []) {
  const normalized = normalizeLimbSetLimbs(limbs, { sort: true });
  if (!normalized.length) return "";
  return normalized
    .map(limb => `${limb.key}:${limb.label}:${limb.stateMax}:${limb.damageMultiplier}:${limb.aimedDifficultyPercent}`)
    .join("|");
}

function getTraumaGroupSource(sourceGroups = {}, limbSet = {}) {
  if (sourceGroups?.[limbSet.id]) return sourceGroups[limbSet.id];
  return mergeTraumaGroupSources((limbSet.legacyIds ?? []).map(id => sourceGroups?.[id]).filter(Boolean));
}

function mergeTraumaGroupSources(sources = []) {
  if (!sources.length) return {};
  if (sources.length === 1) return sources[0];

  const merged = { limbs: {} };
  for (const source of sources) {
    for (const [limbKey, limb] of Object.entries(source?.limbs ?? {})) {
      const existingStages = merged.limbs[limbKey]?.stages ?? [];
      const stages = Array.isArray(limb?.stages) ? limb.stages : [];
      if (existingStages.length && !stages.length) continue;
      merged.limbs[limbKey] = limb;
    }
  }
  return merged;
}

export function normalizeTraumaGroup(value = {}, limbSet = { limbs: [] }, damageTypes = []) {
  const sourceLimbs = value && typeof value === "object" ? value.limbs ?? {} : {};
  const legacyStages = Array.isArray(value?.stages) ? value.stages : [];
  const thresholds = normalizeTraumaThresholds(value, sourceLimbs, legacyStages);
  return {
    races: Array.isArray(value?.races) ? value.races : [],
    thresholds,
    limbs: Object.fromEntries(
      (limbSet?.limbs ?? []).map(limb => [
        limb.key,
        normalizeTraumaLimb(sourceLimbs?.[limb.key], limb, damageTypes, legacyStages, thresholds)
      ])
    )
  };
}

export function createDefaultTraumaStage(index = 0, damageTypes = []) {
  const thresholdPercent = index === 0 ? 60 : 0;
  return normalizeTraumaStage({
    id: foundry.utils.randomID(),
    thresholdPercent,
    profiles: Object.fromEntries(damageTypes.map(damageType => [
      damageType.key,
      createDefaultTraumaProfile(damageType, thresholdPercent)
    ]))
  }, index, damageTypes);
}

export function createDefaultTraumaProfile(damageType = {}, thresholdPercent = 0) {
  return {
    name: getDefaultTraumaProfileName(damageType),
    img: "",
    healingDifficulty: DEFAULT_HEALING_DIFFICULTY,
    healingToolClass: DEFAULT_HEALING_TOOL_CLASS,
    healingProgress: DEFAULT_HEALING_PROGRESS,
    healingSkillKey: DEFAULT_HEALING_SKILL,
    effects: [],
    thresholdPercent
  };
}

export function getDefaultTraumaProfileName(damageType = {}) {
  const label = String(damageType?.label ?? damageType?.key ?? "").trim();
  return label ? `Травма ${label}` : "Травма";
}

function normalizeTraumaLimb(value = {}, limb = {}, damageTypes = [], legacyStages = [], thresholds = []) {
  const stagesSource = Array.isArray(value?.stages) && value.stages.length
    ? value.stages
    : legacyStages;

  return {
    label: String(limb?.label ?? limb?.name ?? limb?.key ?? ""),
    stateMax: String(limb?.stateMax ?? "0").trim() || "0",
    stages: normalizeTraumaStages(stagesSource, damageTypes, thresholds)
  };
}

function normalizeTraumaStages(stages = [], damageTypes = [], thresholds = []) {
  const merged = new Map();
  for (const [index, sourceStage] of stages.entries()) {
    const stage = normalizeTraumaStage(sourceStage, index, damageTypes);
    const key = String(stage.thresholdPercent);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, stage);
      continue;
    }

    for (const damageType of damageTypes) {
      const profile = stage.profiles?.[damageType.key];
      if (isConfiguredTraumaProfile(profile, damageType)) existing.profiles[damageType.key] = profile;
    }
  }

  const sourceStages = Array.from(merged.values());
  const normalizedThresholds = Array.isArray(thresholds) ? thresholds : [];
  if (!normalizedThresholds.length) return [];

  return normalizedThresholds
    .map((threshold, index) => {
      const source = sourceStages.find(stage => stage.id === threshold.id)
        ?? sourceStages.find(stage => stage.thresholdPercent === threshold.thresholdPercent)
        ?? {};
      return normalizeTraumaStage({
        ...source,
        id: threshold.id,
        thresholdPercent: threshold.thresholdPercent
      }, index, damageTypes);
    })
    .sort((left, right) => right.thresholdPercent - left.thresholdPercent);
}

function normalizeTraumaStage(value = {}, index = 0, damageTypes = []) {
  const thresholdPercent = Math.max(0, Math.min(100, toInteger(value?.thresholdPercent ?? value?.threshold ?? (index === 0 ? 60 : 0))));
  return {
    id: String(value?.id || foundry.utils.randomID()),
    thresholdPercent,
    profiles: normalizeTraumaProfiles(value?.profiles, damageTypes, thresholdPercent)
  };
}

function normalizeTraumaProfiles(value = {}, damageTypes = [], thresholdPercent = 0) {
  return Object.fromEntries(damageTypes.map(damageType => [
    damageType.key,
    normalizeTraumaProfile(value?.[damageType.key], damageType, thresholdPercent)
  ]));
}

function normalizeTraumaProfile(value = {}, damageType = {}, thresholdPercent = 0) {
  const hasContent = value && typeof value === "object";
  const name = String(hasContent ? value.name ?? "" : "").trim() || getDefaultTraumaProfileName(damageType);
  return {
    name,
    img: String(hasContent ? value.img ?? "" : "").trim(),
    healingDifficulty: Math.max(0, toInteger(hasContent ? value.healingDifficulty ?? DEFAULT_HEALING_DIFFICULTY : DEFAULT_HEALING_DIFFICULTY)),
    healingToolClass: normalizeHealingToolClass(hasContent ? value.healingToolClass : DEFAULT_HEALING_TOOL_CLASS),
    healingProgress: Math.max(0, toInteger(hasContent ? value.healingProgress ?? DEFAULT_HEALING_PROGRESS : DEFAULT_HEALING_PROGRESS)),
    healingSkillKey: String(hasContent ? value.healingSkillKey ?? DEFAULT_HEALING_SKILL : DEFAULT_HEALING_SKILL).trim() || DEFAULT_HEALING_SKILL,
    effects: normalizeTraumaEffects(hasContent ? value.effects : []),
    thresholdPercent
  };
}

function normalizeTraumaThresholds(value = {}, sourceLimbs = {}, legacyStages = []) {
  if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "thresholds")) {
    return normalizeTraumaThresholdList(value.thresholds);
  }

  const sourceStages = [
    ...(Array.isArray(legacyStages) ? legacyStages : []),
    ...Object.values(sourceLimbs ?? {}).flatMap(limb => Array.isArray(limb?.stages) ? limb.stages : [])
  ];
  const thresholds = normalizeTraumaThresholdList(sourceStages);
  return thresholds.length ? thresholds : createDefaultTraumaThresholds();
}

function createDefaultTraumaThresholds() {
  return DEFAULT_TRAUMA_THRESHOLDS.map(percent => ({
    id: `threshold-${percent}`,
    thresholdPercent: percent
  }));
}

function normalizeTraumaThresholdList(value = []) {
  const entries = Array.isArray(value) ? value : Object.values(value ?? {});
  const merged = new Map();

  for (const [index, entry] of entries.entries()) {
    const thresholdPercent = Math.max(0, Math.min(100, toInteger(entry?.thresholdPercent ?? entry?.percent ?? entry?.threshold ?? (index === 0 ? 60 : 0))));
    const key = String(thresholdPercent);
    if (merged.has(key)) continue;
    merged.set(key, {
      id: String(entry?.id || `threshold-${thresholdPercent}`),
      thresholdPercent
    });
  }

  return Array.from(merged.values())
    .sort((left, right) => right.thresholdPercent - left.thresholdPercent);
}

function isConfiguredTraumaProfile(profile, damageType = {}) {
  if (!profile) return false;
  const name = String(profile.name ?? "").trim();
  const defaultName = getDefaultTraumaProfileName(damageType);
  return Boolean(
    (name && name !== defaultName)
    || String(profile.img ?? "").trim()
    || (profile.effects ?? []).length
  );
}

function normalizeHealingToolClass(value) {
  const normalized = String(value ?? DEFAULT_HEALING_TOOL_CLASS).trim().toUpperCase();
  return HEALING_TOOL_CLASSES.has(normalized) ? normalized : DEFAULT_HEALING_TOOL_CLASS;
}

function normalizeTraumaEffects(value = []) {
  const effects = Array.isArray(value) ? value : Object.values(value ?? {});
  return effects
    .map(effect => ({
      key: String(effect?.key ?? "").trim(),
      type: ["add", "multiply", "override"].includes(String(effect?.type ?? "")) ? String(effect.type) : "add",
      value: String(effect?.value ?? "0"),
      phase: String(effect?.phase || "initial"),
      priority: effect?.priority === "" || effect?.priority === null || effect?.priority === undefined
        ? null
        : toInteger(effect.priority)
    }))
    .filter(effect => effect.key);
}

function normalizeLimbSetLimbs(limbs = [], { sort = true } = {}) {
  const normalized = Array.from(limbs ?? [])
    .map(limb => ({
      key: String(limb?.key ?? "").trim(),
      label: String(limb?.label ?? limb?.name ?? limb?.key ?? "").trim(),
      stateMax: String(limb?.stateMax ?? "0").trim() || "0",
      damageMultiplier: toDecimal(limb?.damageMultiplier, 1),
      aimedDifficultyPercent: toInteger(limb?.aimedDifficultyPercent)
    }))
    .filter(limb => limb.key);
  return sort
    ? normalized.sort((left, right) => left.key.localeCompare(right.key))
    : normalized;
}

function toDecimal(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
