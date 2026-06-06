import { SYSTEM_ID } from "../constants.mjs";
import { prepareEffectChangeForApplication } from "./effect-change-values.mjs";
import { getConditionWeakeningData, isItemBrokenByCondition } from "./item-functions.mjs";

const ITEM_EFFECT_FLAG_KEY = "itemEffect";

export function prepareActorEffectChangeForApplication(actor, change = {}) {
  const item = getItemFreeSettingsEffectSourceItem(actor, change?.effect);
  if (!item) return prepareEffectChangeForApplication(actor, change);
  if (isItemBrokenByCondition(item)) return null;

  const prepared = prepareEffectChangeForApplication(actor, change);
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

export function evaluateActorEffectChangeNumber(actor, change = {}, { fallback = Number.NaN } = {}) {
  const prepared = prepareActorEffectChangeForApplication(actor, change);
  if (!prepared) return fallback;
  const value = Number(prepared.value);
  return Number.isFinite(value) ? value : fallback;
}

function getItemFreeSettingsEffectSourceItem(actor, effect = null) {
  const data = effect?.getFlag?.(SYSTEM_ID, ITEM_EFFECT_FLAG_KEY);
  const itemId = String(data?.itemId ?? "").trim();
  return itemId ? actor?.items?.get(itemId) ?? null : null;
}
