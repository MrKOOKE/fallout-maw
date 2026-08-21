import { SYSTEM_ID } from "../constants.mjs";
import {
  ITEM_FUNCTIONS,
  isInstalledImplant,
  isInstalledProsthesis,
  resolveActorItemOrInstalledModule
} from "../utils/item-functions.mjs";

const ITEM_EFFECT_FLAG_KEY = "itemEffect";

export const PROTECTION_EFFECTIVENESS_PERCENT_EFFECT_KEY = "system.equipmentEffectiveness.protectionPercent";
export const EQUIPMENT_BONUS_EFFECTIVENESS_PERCENT_EFFECT_KEY = "system.equipmentEffectiveness.bonusPercent";

export function getActorProtectionEffectivenessMultiplier(actor = null) {
  return getPercentMultiplier(actor?.system?.equipmentEffectiveness?.protectionPercent);
}

export function scaleEquipmentProtectionValue(actor = null, value = 0) {
  const numeric = toFiniteNumber(value);
  if (numeric <= 0) return numeric;
  return Math.floor(numeric * getActorProtectionEffectivenessMultiplier(actor));
}

/** Scale only positive bonuses supplied by equipped gear, prostheses or implants. */
export function scaleEquippedItemEffectChange(actor = null, change = {}) {
  const item = getEquippedBonusSourceItem(actor, change?.effect);
  if (!item) return change;
  const percent = toFiniteNumber(actor?.system?.equipmentEffectiveness?.bonusPercent);
  if (!percent) return change;
  const value = toFiniteNumber(change?.value, Number.NaN);
  if (!Number.isFinite(value)) return change;

  if (change.type === "multiply") {
    if (value <= 1) return change;
    return { ...change, value: 1 + ((value - 1) * getPercentMultiplier(percent)) };
  }
  if (change.type !== "add" || value <= 0) return change;
  return { ...change, value: Math.round(value * getPercentMultiplier(percent)) };
}

export function buildEquipmentEffectivenessChanges({
  protectionPercent = 0,
  bonusPercent = 0
} = {}) {
  const changes = [];
  addChange(changes, "protection-effectiveness-percent", PROTECTION_EFFECTIVENESS_PERCENT_EFFECT_KEY, protectionPercent);
  addChange(changes, "equipment-bonus-effectiveness-percent", EQUIPMENT_BONUS_EFFECTIVENESS_PERCENT_EFFECT_KEY, bonusPercent);
  return changes;
}

function getEquippedBonusSourceItem(actor, effect) {
  const projected = effect?.getFlag?.(SYSTEM_ID, ITEM_EFFECT_FLAG_KEY);
  const projectedItemId = String(projected?.itemId ?? "").trim();
  const item = projectedItemId
    ? resolveActorItemOrInstalledModule(actor, projectedItemId)
    : effect?.parent?.documentName === "Item" ? effect.parent : null;
  if (!item || item.system?.equipped !== true) return null;

  const mode = String(item.system?.placement?.mode ?? "");
  if (mode === "equipment") return item;
  if (mode === ITEM_FUNCTIONS.prosthesis && isInstalledProsthesis(item)) return item;
  if (mode === ITEM_FUNCTIONS.implant && isInstalledImplant(item)) return item;
  return null;
}

function addChange(changes, id, key, value) {
  const numeric = toFiniteNumber(value);
  if (!numeric) return;
  changes.push({
    id,
    key,
    type: "add",
    value: String(numeric),
    phase: "initial",
    priority: -100
  });
}

function getPercentMultiplier(value) {
  return Math.max(0, 1 + (toFiniteNumber(value) / 100));
}

function toFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
