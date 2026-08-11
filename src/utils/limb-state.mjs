import {
  getActorGearItems,
  getConstructPartSlotForLimb,
  getInstalledConstructPartForLimb
} from "./construct-parts.mjs";
import {
  ITEM_FUNCTIONS,
  getConditionFunction,
  hasItemFunction,
  isInstalledProsthesis
} from "./item-functions.mjs";
import { toInteger } from "./numbers.mjs";

export function isLimbPhysicallyMissing(actor, limbKey = "") {
  return Boolean(actor?.system?.limbs?.[limbKey]?.missing);
}

export function isLimbDestroyed(actor, limbKey = "") {
  const limb = actor?.system?.limbs?.[limbKey];
  if (!limb) return false;
  if (actor?.type !== "construct" && !limb.missing) return false;

  const constructSlot = getConstructPartSlotForLimb(actor, limbKey);
  const constructPart = getInstalledConstructPartForLimb(actor, limbKey);
  if (constructSlot && !constructPart) return true;
  if (constructPart) return isConstructPartDestroyed(constructPart);
  if (hasInstalledProsthesis(actor, limbKey)) return false;
  return Boolean(limb.missing);
}

export function isConstructPartDestroyed(item) {
  if (!item || !hasItemFunction(item, ITEM_FUNCTIONS.condition)) return false;
  const condition = getConditionFunction(item);
  const max = Math.max(0, toInteger(condition.max));
  if (max <= 0) return false;
  return Math.max(0, Math.min(max, toInteger(condition.value))) <= 0;
}

function hasInstalledProsthesis(actor, limbKey = "") {
  return getActorGearItems(actor).some(item => (
    item.system?.equipped
    && isInstalledProsthesis(item, limbKey)
  ));
}
