import { toInteger } from "../utils/numbers.mjs";

const DEFAULT_TRAUMA_ICON = "icons/svg/blood.svg";
const DEFAULT_HEALING_DIFFICULTY = 60;
const DEFAULT_HEALING_TOOL_CLASS = "D";
const DEFAULT_HEALING_PROGRESS = 100;
const DEFAULT_HEALING_SKILL = "doctor";
const HEALING_TOOL_CLASSES = new Set(["D", "C", "B", "A", "S"]);

export function createDefaultTraumaSettings() {
  return { groups: {} };
}

export function normalizeTraumaSettings(value = {}, creatureOptions = {}, damageTypes = []) {
  const sourceGroups = value && typeof value === "object" ? value.groups ?? {} : {};
  const normalizedGroups = {};

  for (const limbSet of getUniqueLimbSets(creatureOptions)) {
    normalizedGroups[limbSet.id] = normalizeTraumaGroup(sourceGroups[limbSet.id], limbSet, damageTypes);
  }

  return { groups: normalizedGroups };
}

export function getTraumaGroupForActor(actor, settings = null, creatureOptions = {}, damageTypes = []) {
  const race = creatureOptions.races.find(entry => entry.id === actor?.system?.creature?.raceId);
  const limbSetId = getLimbSetId(race?.limbs ?? []);
  const normalized = settings ?? normalizeTraumaSettings({}, creatureOptions, damageTypes);
  return {
    id: limbSetId,
    race,
    config: normalized.groups?.[limbSetId] ?? normalizeTraumaGroup({}, { limbs: [] }, damageTypes)
  };
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
      races: [],
      raceNames: ""
    };
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
    .map(limb => `${limb.key}:${limb.label}:${limb.stateMax}:${limb.damageMultiplier}:${limb.aimedDifficultyPercent}`)
    .join("|");
}

export function normalizeTraumaGroup(value = {}, limbSet = { limbs: [] }, damageTypes = []) {
  const sourceLimbs = value && typeof value === "object" ? value.limbs ?? {} : {};
  const legacyStages = Array.isArray(value?.stages) ? value.stages : [];
  return {
    races: Array.isArray(value?.races) ? value.races : [],
    limbs: Object.fromEntries(
      (limbSet?.limbs ?? []).map(limb => [
        limb.key,
        normalizeTraumaLimb(sourceLimbs?.[limb.key], limb, damageTypes, legacyStages)
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
    name: `Травма ${damageType.label ?? damageType.key ?? ""}`.trim(),
    img: DEFAULT_TRAUMA_ICON,
    healingDifficulty: DEFAULT_HEALING_DIFFICULTY,
    healingToolClass: DEFAULT_HEALING_TOOL_CLASS,
    healingProgress: DEFAULT_HEALING_PROGRESS,
    healingSkillKey: DEFAULT_HEALING_SKILL,
    effects: [],
    thresholdPercent
  };
}

function normalizeTraumaLimb(value = {}, limb = {}, damageTypes = [], legacyStages = []) {
  const stagesSource = Array.isArray(value?.stages) && value.stages.length
    ? value.stages
    : legacyStages;

  return {
    label: String(limb?.label ?? limb?.name ?? limb?.key ?? ""),
    stateMax: String(limb?.stateMax ?? "0").trim() || "0",
    stages: normalizeTraumaStages(stagesSource, damageTypes)
  };
}

function normalizeTraumaStages(stages = [], damageTypes = []) {
  const seenIds = new Set();
  return stages
    .map((stage, index) => normalizeTraumaStage(stage, index, damageTypes))
    .filter(stage => {
      if (seenIds.has(stage.id)) return false;
      seenIds.add(stage.id);
      return true;
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
  return {
    name: String(hasContent ? value.name ?? "" : "").trim(),
    img: String(hasContent ? value.img ?? "" : "").trim(),
    healingDifficulty: Math.max(0, toInteger(hasContent ? value.healingDifficulty ?? DEFAULT_HEALING_DIFFICULTY : DEFAULT_HEALING_DIFFICULTY)),
    healingToolClass: normalizeHealingToolClass(hasContent ? value.healingToolClass : DEFAULT_HEALING_TOOL_CLASS),
    healingProgress: Math.max(0, toInteger(hasContent ? value.healingProgress ?? DEFAULT_HEALING_PROGRESS : DEFAULT_HEALING_PROGRESS)),
    healingSkillKey: String(hasContent ? value.healingSkillKey ?? DEFAULT_HEALING_SKILL : DEFAULT_HEALING_SKILL).trim() || DEFAULT_HEALING_SKILL,
    effects: normalizeTraumaEffects(hasContent ? value.effects : []),
    thresholdPercent
  };
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
