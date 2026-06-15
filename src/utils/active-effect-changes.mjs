import { SYSTEM_ID } from "../constants.mjs";
import { getSkillSettings } from "../settings/accessors.mjs";
import {
  getCoverBonusPercentEffectKey,
  getCoverKeyFromBonusPercentEffectKey
} from "../settings/cover.mjs";
import { toInteger } from "./numbers.mjs";
import { prepareEffectChangeForApplication } from "./effect-change-values.mjs";
import { getConditionWeakeningData, isItemBrokenByCondition } from "./item-functions.mjs";

const ITEM_EFFECT_FLAG_KEY = "itemEffect";
export const ALL_SKILLS_BONUS_EFFECT_KEY = "system.skills.all.bonus";
export const ALL_SKILLS_ADVANTAGE_EFFECT_KEY = "system.skills.all.advantage";
export const ALL_SKILLS_DISADVANTAGE_EFFECT_KEY = "system.skills.all.disadvantage";
export const ABILITY_OVERLOAD_ENERGY_COST_EFFECT_KEY = "fallout-maw.ability.overload.energyCost";
export const ONE_TIME_SKILL_MODIFIER_EFFECT_KEY = "fallout-maw.skillCheck.nextSkillModifier";
export const SMART_FUDGE_RESULT_EFFECT_KEYS = Object.freeze({
  criticalSuccess: "fallout-maw.skillCheck.smartFudge.criticalSuccess",
  success: "fallout-maw.skillCheck.smartFudge.success",
  failure: "fallout-maw.skillCheck.smartFudge.failure",
  criticalFailure: "fallout-maw.skillCheck.smartFudge.criticalFailure"
});
export const SMART_FUDGE_RESULT_ORDER = Object.freeze(["criticalSuccess", "success", "failure", "criticalFailure"]);

const ALL_SKILLS_EFFECT_FIELDS = Object.freeze({
  [ALL_SKILLS_BONUS_EFFECT_KEY]: "bonus",
  [ALL_SKILLS_ADVANTAGE_EFFECT_KEY]: "advantage",
  [ALL_SKILLS_DISADVANTAGE_EFFECT_KEY]: "disadvantage"
});

export function expandActorEffectChangeKeys(actor, change = {}) {
  const field = ALL_SKILLS_EFFECT_FIELDS[String(change?.key ?? "")];
  if (!field) return [change];
  const skillKeys = new Set([
    ...getSkillSettings().map(skill => String(skill?.key ?? "").trim()),
    ...Object.keys(actor?.system?.skills ?? {})
  ]);
  return Array.from(skillKeys)
    .filter(key => key && key !== "all")
    .map(key => ({
      ...change,
      key: `system.skills.${key}.${field}`
    }));
}

export function prepareActorEffectChangeForApplication(actor, change = {}, options = {}) {
  const prepared = prepareActorEffectChangeValue(actor, change, options);
  if (!prepared) return null;
  if (getCoverKeyFromBonusPercentEffectKey(prepared.key)) return null;

  const coverKey = getEffectCoverKey(change?.effect);
  if (!coverKey) return prepared;
  const value = Number(prepared.value);
  if (!Number.isFinite(value)) return prepared;

  const percent = getActorCoverBonusPercent(actor, coverKey, options);
  return {
    ...prepared,
    value: Math.round(value * (1 + (percent / 100)))
  };
}

function prepareActorEffectChangeValue(actor, change = {}, options = {}) {
  const item = getItemFreeSettingsEffectSourceItem(actor, change?.effect);
  if (!item) return prepareEffectChangeForApplication(actor, change, options);
  if (isItemBrokenByCondition(item)) return null;

  const prepared = prepareEffectChangeForApplication(actor, change, options);
  if (!item.system?.functions?.freeSettings?.useConditionWeakening) return prepared;

  const weakening = getConditionWeakeningData(item);
  if (!weakening.active || weakening.ratio >= 1) return prepared;

  const value = Number(prepared?.value);
  if (!Number.isFinite(value)) return prepared;

  const ratio = Math.max(0, Math.min(1, Number(weakening.ratio) || 0));
  return {
    ...prepared,
    value: Math.trunc(value * ratio)
  };
}

function getActorCoverBonusPercent(actor, coverKey, options = {}) {
  const effectKey = getCoverBonusPercentEffectKey(coverKey);
  if (!effectKey) return 0;

  const changes = [];
  for (const effect of actor?.allApplicableEffects?.() ?? actor?.effects ?? []) {
    if (effect?.disabled || effect?.active === false) continue;
    for (const change of effect?.system?.changes ?? []) {
      if (String(change?.key ?? "").trim() !== effectKey) continue;
      changes.push({ ...change, effect });
    }
  }

  changes.sort((left, right) => toInteger(left?.priority) - toInteger(right?.priority));
  let percent = 0;
  for (const change of changes) {
    const prepared = prepareActorEffectChangeValue(actor, change, options);
    const amount = Number(prepared?.value);
    if (!Number.isFinite(amount)) continue;
    if (change.type === "multiply") percent *= amount;
    else if (change.type === "override") percent = amount;
    else if (change.type === "upgrade") percent = Math.max(percent, amount);
    else if (change.type === "downgrade") percent = Math.min(percent, amount);
    else percent += amount;
  }
  return percent;
}

function getEffectCoverKey(effect = null) {
  return String(
    effect?.getFlag?.(SYSTEM_ID, "forcedCover")?.key
    ?? effect?.getFlag?.(SYSTEM_ID, "autoCover")?.key
    ?? effect?.flags?.[SYSTEM_ID]?.forcedCover?.key
    ?? effect?.flags?.[SYSTEM_ID]?.autoCover?.key
    ?? ""
  ).trim();
}

export function evaluateActorEffectChangeNumber(actor, change = {}, { fallback = Number.NaN, stage = "prepared" } = {}) {
  const prepared = prepareActorEffectChangeForApplication(actor, change, { stage });
  if (!prepared) return fallback;
  const value = Number(prepared.value);
  return Number.isFinite(value) ? value : fallback;
}

export function getActorSmartFudgeResult(actor, { requester = "", check = null } = {}) {
  if (!actor || String(requester ?? "") !== "weaponAttack") return "";
  const resultValues = Object.fromEntries(SMART_FUDGE_RESULT_ORDER.map(result => [result, 0]));
  for (const effect of actor.allApplicableEffects?.() ?? actor.effects ?? []) {
    if (effect?.disabled) continue;
    const allOrNothing = effect.getFlag?.(SYSTEM_ID, "allOrNothing");
    if (allOrNothing?.pending && !isAllOrNothingSmartFudgeApplicable(allOrNothing, check, effect)) continue;
    for (const change of effect.system?.changes ?? []) {
      const result = getSmartFudgeResultForEffectKey(change?.key);
      if (!result) continue;
      const value = evaluateActorEffectChangeNumber(actor, { ...change, effect }, { fallback: 0 });
      if (value <= 0) continue;
      resultValues[result] += value;
    }
  }
  for (const result of SMART_FUDGE_RESULT_ORDER) {
    if (resultValues[result] > 0) return result;
  }
  return "";
}

export function getSmartFudgeResultForEffectKey(key = "") {
  const path = String(key ?? "").trim();
  return SMART_FUDGE_RESULT_ORDER.find(result => SMART_FUDGE_RESULT_EFFECT_KEYS[result] === path) ?? "";
}

function isAllOrNothingSmartFudgeApplicable(data = {}, check = null, effect = null) {
  const mode = String(check?.allOrNothingAttackMode ?? "").trim();
  if (mode !== "pellet" && mode !== "burst") return true;
  const percent = mode === "burst"
    ? Math.max(0, Math.min(100, toInteger(data.burstCoveragePercent ?? 50)))
    : Math.max(0, Math.min(100, toInteger(data.pelletCoveragePercent ?? 50)));
  return isIndexedSmartFudgeCheckIncluded({
    percent,
    index: check?.allOrNothingAttackIndex,
    count: check?.allOrNothingAttackCount,
    seed: [
      effect?.id ?? "",
      data.createdAt ?? "",
      data.abilityItemId ?? "",
      data.result ?? "",
      check?.weaponAttackId ?? "",
      mode
    ].join(":")
  });
}

function isIndexedSmartFudgeCheckIncluded({ percent = 100, index = 0, count = 1, seed = "" } = {}) {
  const normalizedCount = Math.max(1, toInteger(count));
  const normalizedIndex = Math.max(0, Math.min(normalizedCount - 1, toInteger(index)));
  const selectedCount = Math.max(0, Math.min(normalizedCount, Math.round((normalizedCount * Math.max(0, Math.min(100, toInteger(percent)))) / 100)));
  if (selectedCount <= 0) return false;
  if (selectedCount >= normalizedCount) return true;
  const ranked = Array.from({ length: normalizedCount }, (_entry, entryIndex) => ({
    index: entryIndex,
    score: stableHash(`${seed}:${normalizedCount}:${entryIndex}`)
  })).sort((left, right) => left.score - right.score || left.index - right.index);
  return ranked.slice(0, selectedCount).some(entry => entry.index === normalizedIndex);
}

function stableHash(value = "") {
  const text = String(value ?? "");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function getItemFreeSettingsEffectSourceItem(actor, effect = null) {
  const data = effect?.getFlag?.(SYSTEM_ID, ITEM_EFFECT_FLAG_KEY);
  const itemId = String(data?.itemId ?? "").trim();
  return itemId ? actor?.items?.get(itemId) ?? null : null;
}
