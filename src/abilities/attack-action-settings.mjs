import { normalizeRegionSpecialProperties } from "../utils/region-special-properties.mjs";

const ATTACK_ACTION_TARGETING_MODES = new Set(["cone", "selectedTargets", "area"]);
const ATTACK_ACTION_SPECIAL_PROPERTY_TYPES = new Set([
  "pending",
  "hitAllConeTargets",
  "limbDamageMultipliers",
  "attackPower",
  "criticalDamage",
  "additionalProficiencies"
]);

export const ATTACK_ACTION_TRIAL_SUBJECTS = Object.freeze({
  source: "source",
  targets: "targets"
});

export const ATTACK_ACTION_TRIAL_SOURCE_MODES = Object.freeze({
  once: "once",
  perTarget: "perTarget"
});

export const ATTACK_ACTION_TRIAL_ENTRY_KINDS = Object.freeze({
  skill: "skill"
});

export const ATTACK_ACTION_TRIAL_SELECTION_MODES = Object.freeze({
  best: "best",
  worst: "worst"
});

export const ATTACK_ACTION_TRIAL_OUTCOME_KEYS = Object.freeze([
  "criticalFailure",
  "failure",
  "success",
  "criticalSuccess"
]);

export const ATTACK_ACTION_TRIAL_FLOWS = Object.freeze({
  continue: "continue",
  stopSubject: "stopSubject",
  stopAll: "stopAll"
});

export const ATTACK_ACTION_TRIAL_LINK_RECIPIENTS = Object.freeze({
  source: "source",
  subjects: "subjects",
  targets: "targets"
});

export const ATTACK_ACTION_TRIAL_LINK_MODES = Object.freeze({
  once: "once",
  perSubject: "perSubject"
});

/**
 * Create settings for one top-level ability attack function.
 *
 * The constructor deliberately normalizes every targeting branch. This keeps
 * values entered for an inactive mode intact when the author switches modes.
 */
export function createAttackActionSettings(source = {}) {
  return normalizeAttackActionSettings(source);
}

/**
 * Normalize the persisted settings of one top-level ability attack function.
 */
export function normalizeAttackActionSettings(value = {}) {
  const source = isRecord(value) ? value : {};
  return {
    name: normalizeText(source.name),
    damage: normalizeFormula(source.damage, "0"),
    pellets: normalizeFormula(source.pellets, "1"),
    damageTypeKey: normalizeText(source.damageTypeKey, "firearm"),
    damageTypes: normalizeDamageTypes(source.damageTypes, source.damageTypeKey),
    attackAnimationKey: normalizeText(source.attackAnimationKey),
    attackSoundPath: normalizeText(source.attackSoundPath),
    attackSoundVolume: clampNumber(source.attackSoundVolume, 0, 1, 1),
    attackAnimationDelayMs: clampInteger(source.attackAnimationDelayMs, 0, Infinity, 0),
    proficiencyKey: normalizeText(source.proficiencyKey, "pistol"),
    skillKey: normalizeText(source.skillKey, "rangedCombat"),
    accuracyBonus: normalizeFormula(source.accuracyBonus, "0"),
    criticalChanceModifier: normalizeFormula(source.criticalChanceModifier, "0"),
    criticalDamagePercent: normalizeFormula(source.criticalDamagePercent, "150"),
    maxRangeMeters: normalizeFormula(source.maxRangeMeters, "0"),
    effectiveRange: {
      value: normalizeFormula(source.effectiveRange?.value, "0"),
      max: normalizeFormula(source.effectiveRange?.max, "0")
    },
    penetration: normalizeFormula(source.penetration, "0"),
    noiseLevel: clampInteger(source.noiseLevel, 0, Infinity, 1),
    targeting: normalizeTargeting(source.targeting),
    sequence: normalizeSequence(source.sequence),
    area: normalizeArea(source.area),
    resourceCosts: normalizeAttackActionResourceCosts(source.resourceCosts),
    specialProperties: normalizeSpecialProperties(source.specialProperties),
    requirements: normalizeRequirements(source.requirements),
    hitResolution: normalizeAttackActionHitResolution(source.hitResolution),
    criticalFailureConsequences: normalizeCriticalFailureConsequences(
      source.criticalFailureConsequences
    )
  };
}

/** Create one normalized hit-resolution container. */
export function createAttackActionHitResolution(source = {}) {
  return normalizeAttackActionHitResolution(source);
}

/** Normalize all custom trials which resolve an attack. */
export function normalizeAttackActionHitResolution(value = {}) {
  const source = isRecord(value) ? value : {};
  return {
    trials: toRows(source.trials).map(trial => normalizeAttackActionTrial(trial))
  };
}

/** Create one normalized attack-resolution trial. */
export function createAttackActionTrial(source = {}) {
  return normalizeAttackActionTrial(source);
}

/** Create one normalized skill entry for an attack-resolution trial. */
export function createAttackActionTrialEntry(source = {}) {
  return normalizeAttackActionTrialEntry(source);
}

/** Normalize one source or target trial and all four result branches. */
export function normalizeAttackActionTrial(value = {}) {
  const source = isRecord(value) ? value : {};
  const subject = normalizeText(source.subject);
  const sourceMode = normalizeText(source.sourceMode);
  const selectionMode = normalizeText(source.selectionMode);
  return {
    id: normalizeId(source.id),
    subject: Object.values(ATTACK_ACTION_TRIAL_SUBJECTS).includes(subject)
      ? subject
      : ATTACK_ACTION_TRIAL_SUBJECTS.targets,
    sourceMode: Object.values(ATTACK_ACTION_TRIAL_SOURCE_MODES).includes(sourceMode)
      ? sourceMode
      : ATTACK_ACTION_TRIAL_SOURCE_MODES.once,
    entries: toRows(source.entries).map(entry => normalizeAttackActionTrialEntry(entry)),
    selectionMode: Object.values(ATTACK_ACTION_TRIAL_SELECTION_MODES).includes(selectionMode)
      ? selectionMode
      : ATTACK_ACTION_TRIAL_SELECTION_MODES.best,
    difficultyFormula: normalizeFormula(source.difficultyFormula, "0"),
    outcomes: normalizeAttackActionTrialOutcomes(source.outcomes)
  };
}

/** Create one normalized result branch for an attack-resolution trial. */
export function createAttackActionTrialOutcome(source = {}) {
  return normalizeAttackActionTrialOutcome(source);
}

/** Create one normalized construct link for a trial result branch. */
export function createAttackActionTrialLink(source = {}) {
  return normalizeAttackActionTrialLink(source);
}

function normalizeTargeting(value = {}) {
  const source = isRecord(value) ? value : {};
  const rawMode = normalizeText(source.mode);
  const mode = rawMode === "targets" ? "selectedTargets" : rawMode;
  return {
    mode: ATTACK_ACTION_TARGETING_MODES.has(mode) ? mode : "cone",
    targetLimitFormula: normalizeFormula(source.targetLimitFormula, "1"),
    aimed: normalizeBoolean(source.aimed, false),
    allowRepeatedTargets: normalizeBoolean(source.allowRepeatedTargets, true),
    attackConeDegrees: clampNumber(source.attackConeDegrees, 0, Infinity, 3),
    directions: {
      thrust: normalizeDirection(source.directions?.thrust),
      swing: normalizeDirection(source.directions?.swing)
    }
  };
}

function normalizeDirection(value = {}) {
  const source = isRecord(value) ? value : {};
  return {
    enabled: normalizeBoolean(source.enabled, false),
    accuracyModifier: normalizeInteger(source.accuracyModifier, 0),
    criticalChanceModifier: normalizeInteger(source.criticalChanceModifier, 0),
    damagePercentModifier: normalizeInteger(source.damagePercentModifier, 0)
  };
}

function normalizeSequence(value = {}) {
  const source = isRecord(value) ? value : {};
  return {
    count: clampInteger(source.count, 1, Infinity, 1),
    difficultyPerAttack: clampInteger(source.difficultyPerAttack, 0, Infinity, 0)
  };
}

function normalizeArea(value = {}) {
  const source = isRecord(value) ? value : {};
  return {
    damageRadius: normalizeFormula(source.damageRadius, "0"),
    regionRadius: normalizeFormula(source.regionRadius, "0"),
    regionDamageEntries: toRows(source.regionDamageEntries).map(entry => ({
      damageTypeKey: normalizeText(entry?.damageTypeKey, "firearm"),
      amount: normalizeFormula(entry?.amount, "0")
    })),
    regionSpecialProperties: normalizeRegionSpecialProperties(source.regionSpecialProperties),
    regionDurationSeconds: normalizeFormula(source.regionDurationSeconds, "0"),
    regionDelaySeconds: normalizeFormula(source.regionDelaySeconds, "0"),
    regionRadiusDeltaMeters: normalizeFormula(source.regionRadiusDeltaMeters, "0"),
    explosionAnimationKey: normalizeText(source.explosionAnimationKey),
    explosionSoundPath: normalizeText(source.explosionSoundPath)
  };
}

function normalizeDamageTypes(value = [], fallbackKey = "") {
  const rows = toRows(value).map(entry => ({
    key: normalizeText(entry?.key, "firearm"),
    percent: clampInteger(entry?.percent, 0, 100, 100)
  }));
  if (rows.length) return rows;
  return [{
    key: normalizeText(fallbackKey, "firearm"),
    percent: 100
  }];
}

function normalizeAttackActionResourceCosts(value = []) {
  return toRows(value).map(entry => ({
    id: normalizeId(entry?.id),
    resourceKey: normalizeText(entry?.resourceKey),
    formula: normalizeFormula(entry?.formula ?? entry?.amount, "0"),
    overloadAmount: clampInteger(entry?.overloadAmount, 0, Infinity, 0),
    overloadDurationSeconds: clampInteger(entry?.overloadDurationSeconds, 0, Infinity, 0)
  }));
}

function normalizeAttackActionTrialEntry(value = {}) {
  const source = isRecord(value) ? value : {};
  return {
    id: normalizeId(source.id),
    kind: ATTACK_ACTION_TRIAL_ENTRY_KINDS.skill,
    key: normalizeText(source.key)
  };
}

function normalizeAttackActionTrialOutcomes(value = {}) {
  const source = isRecord(value) ? value : {};
  return Object.fromEntries(
    ATTACK_ACTION_TRIAL_OUTCOME_KEYS.map(key => [
      key,
      normalizeAttackActionTrialOutcome(source[key])
    ])
  );
}

function normalizeAttackActionTrialOutcome(value = {}) {
  const source = isRecord(value) ? value : {};
  const flow = normalizeText(source.flow);
  return {
    id: normalizeId(source.id),
    flow: Object.values(ATTACK_ACTION_TRIAL_FLOWS).includes(flow)
      ? flow
      : ATTACK_ACTION_TRIAL_FLOWS.continue,
    links: toRows(source.links).map(link => normalizeAttackActionTrialLink(link))
  };
}

function normalizeAttackActionTrialLink(value = {}) {
  const source = isRecord(value) ? value : {};
  const recipient = normalizeText(source.recipient);
  const normalizedRecipient = Object.values(ATTACK_ACTION_TRIAL_LINK_RECIPIENTS).includes(recipient)
    ? recipient
    : ATTACK_ACTION_TRIAL_LINK_RECIPIENTS.subjects;
  const mode = normalizeText(source.mode);
  return {
    id: normalizeId(source.id),
    constructId: normalizeText(source.constructId),
    recipient: normalizedRecipient,
    mode: Object.values(ATTACK_ACTION_TRIAL_LINK_MODES).includes(mode)
      ? mode
      : normalizedRecipient === ATTACK_ACTION_TRIAL_LINK_RECIPIENTS.source
        ? ATTACK_ACTION_TRIAL_LINK_MODES.once
        : ATTACK_ACTION_TRIAL_LINK_MODES.perSubject
  };
}

function normalizeSpecialProperties(value = []) {
  return toRows(value).map(entry => normalizeSpecialProperty(entry));
}

function normalizeSpecialProperty(value = {}) {
  const source = typeof value === "string"
    ? { type: value }
    : (isRecord(value) ? value : {});
  const rawType = normalizeText(source.type ?? source.property ?? source.key);
  const type = ATTACK_ACTION_SPECIAL_PROPERTY_TYPES.has(rawType) ? rawType : "pending";
  if (type === "criticalDamage") {
    return {
      type,
      criticalDamage: normalizeCriticalDamage(source.criticalDamage ?? source.critical)
    };
  }
  if (type === "additionalProficiencies") {
    return {
      type,
      proficiencyKeys: normalizeUniqueTextList(
        source.proficiencyKeys ?? source.proficiencies
      )
    };
  }
  if (type === "limbDamageMultipliers") {
    return {
      type,
      limbDamageMultipliers: normalizeLimbDamageMultipliers(
        source.limbDamageMultipliers ?? source.limbMultipliers
      )
    };
  }
  if (type !== "attackPower") return { type };
  return {
    type,
    attackPower: normalizeAttackPower(source.attackPower ?? source.power)
  };
}

function normalizeLimbDamageMultipliers(value = {}) {
  if (!isRecord(value)) return {};
  const result = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = normalizeText(rawKey);
    const multiplier = Number(rawValue);
    if (key && Number.isFinite(multiplier)) result[key] = Math.max(0, multiplier);
  }
  return result;
}

function normalizeCriticalDamage(value = {}) {
  const source = isRecord(value) ? value : {};
  return {
    outcomeId: normalizeText(source.outcomeId),
    percentFormula: normalizeFormula(
      source.percentFormula ?? source.formula ?? source.percent,
      "150"
    )
  };
}

function normalizeAttackPower(value = {}) {
  const source = isRecord(value) ? value : {};
  const max = clampInteger(source.level?.max ?? source.max, 1, 999, 1);
  const current = clampInteger(source.level?.value ?? source.value, 1, max, 1);
  const perLevel = isRecord(source.perLevel) ? source.perLevel : source;
  return {
    level: { value: current, max },
    perLevel: {
      damagePercent: normalizeInteger(perLevel.damagePercent, 0),
      accuracyBonus: normalizeInteger(perLevel.accuracyBonus, 0),
      criticalChanceModifier: normalizeInteger(perLevel.criticalChanceModifier, 0),
      criticalDamagePercent: normalizeInteger(perLevel.criticalDamagePercent, 0),
      attackConeDegrees: normalizeNumber(perLevel.attackConeDegrees, 0),
      maxRangeMeters: normalizeNumber(perLevel.maxRangeMeters, 0),
      effectiveRange: {
        value: normalizeNumber(perLevel.effectiveRange?.value, 0),
        max: normalizeNumber(perLevel.effectiveRange?.max, 0)
      },
      penetration: normalizeInteger(perLevel.penetration, 0)
    },
    resourceCosts: toRows(source.resourceCosts).map(entry => ({
      type: "actorResource",
      resourceKey: normalizeText(entry?.resourceKey),
      amount: normalizeInteger(entry?.amount, 0)
    }))
  };
}

function normalizeRequirements(value = []) {
  return toRows(value).map(entry => ({
    type: entry?.type === "skill" ? "skill" : "characteristic",
    key: normalizeText(entry?.key),
    value: clampInteger(entry?.value, 0, Infinity, 0)
  }));
}

function normalizeCriticalFailureConsequences(value = []) {
  return toRows(value).map(entry => ({
    id: normalizeId(entry?.id),
    type: "extraResourceCost",
    resourceType: "actorResource",
    resourceKey: normalizeText(entry?.resourceKey),
    amount: clampInteger(entry?.amount, 0, Infinity, 0)
  }));
}

function normalizeId(value = "") {
  return normalizeText(value) || globalThis.foundry?.utils?.randomID?.() || globalThis.crypto?.randomUUID?.() || "";
}

function normalizeFormula(value, fallback = "0") {
  return normalizeText(value, fallback);
}

function normalizeText(value, fallback = "") {
  return String(value ?? "").trim() || fallback;
}

function normalizeUniqueTextList(value = []) {
  const seen = new Set();
  return toRows(value)
    .map(entry => normalizeText(entry))
    .filter(entry => entry && !seen.has(entry) && seen.add(entry));
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return Boolean(fallback);
  if (Array.isArray(value)) {
    const selected = value.findLast(entry => entry !== undefined && entry !== null && entry !== "");
    return normalizeBoolean(selected, fallback);
  }
  if (typeof value === "string") return value === "true";
  return Boolean(value);
}

function normalizeInteger(value, fallback = 0) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) ? number : fallback;
}

function normalizeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampInteger(value, min, max, fallback = min) {
  return Math.max(min, Math.min(max, normalizeInteger(value, fallback)));
}

function clampNumber(value, min, max, fallback = min) {
  return Math.max(min, Math.min(max, normalizeNumber(value, fallback)));
}

function toRows(value) {
  if (Array.isArray(value)) return value;
  return isRecord(value) ? Object.values(value) : [];
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
