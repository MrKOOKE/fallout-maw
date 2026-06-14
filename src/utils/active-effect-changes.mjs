import { SYSTEM_ID } from "../constants.mjs";
import { getSkillSettings } from "../settings/accessors.mjs";
import { prepareEffectChangeForApplication } from "./effect-change-values.mjs";
import { getConditionWeakeningData, isItemBrokenByCondition } from "./item-functions.mjs";

const ITEM_EFFECT_FLAG_KEY = "itemEffect";
export const ALL_SKILLS_BONUS_EFFECT_KEY = "system.skills.all.bonus";

export function expandActorEffectChangeKeys(actor, change = {}) {
  if (String(change?.key ?? "") !== ALL_SKILLS_BONUS_EFFECT_KEY) return [change];
  const skillKeys = new Set([
    ...getSkillSettings().map(skill => String(skill?.key ?? "").trim()),
    ...Object.keys(actor?.system?.skills ?? {})
  ]);
  return Array.from(skillKeys)
    .filter(key => key && key !== "all")
    .map(key => ({
      ...change,
      key: `system.skills.${key}.bonus`
    }));
}

export function prepareActorEffectChangeForApplication(actor, change = {}, options = {}) {
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

export function evaluateActorEffectChangeNumber(actor, change = {}, { fallback = Number.NaN, stage = "prepared" } = {}) {
  const prepared = prepareActorEffectChangeForApplication(actor, change, { stage });
  if (!prepared) return fallback;
  const value = Number(prepared.value);
  return Number.isFinite(value) ? value : fallback;
}

function getItemFreeSettingsEffectSourceItem(actor, effect = null) {
  const data = effect?.getFlag?.(SYSTEM_ID, ITEM_EFFECT_FLAG_KEY);
  const itemId = String(data?.itemId ?? "").trim();
  return itemId ? actor?.items?.get(itemId) ?? null : null;
}
