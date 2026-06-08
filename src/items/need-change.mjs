import { requestFirstAidNeedChanges } from "../combat/damage-hub.mjs";
import { getNeedChangeChargesData, getNeedChangeFunction, hasItemFunction, ITEM_FUNCTIONS } from "../utils/item-functions.mjs";
import { getItemQuantity } from "../utils/inventory-containers.mjs";
import { toInteger } from "../utils/numbers.mjs";

export async function useNeedChangeItem({ targetActor = null, item = null } = {}) {
  if (!targetActor || !item || !hasItemFunction(item, ITEM_FUNCTIONS.needChange)) return false;

  const needChange = getNeedChangeFunction(item);
  const charges = getNeedChangeChargesData(item);
  if (getItemQuantity(item) <= 0 || charges.value <= 0) {
    ui.notifications.warn(`${item.name}: item is depleted.`);
    return false;
  }

  const needs = normalizeNeedChangeNeeds(needChange.needs);
  if (!needs.length) return false;

  const results = await requestFirstAidNeedChanges({ actor: targetActor, needs });
  if (!results.length) return false;
  await spendNeedChangeItem(item, 1);
  return true;
}

function normalizeNeedChangeNeeds(needs = []) {
  const source = Array.isArray(needs)
    ? needs
    : Object.entries(needs ?? {}).map(([needKey, value]) => ({ needKey, value }));
  return source
    .map(entry => ({
      key: String(entry?.needKey ?? "").trim(),
      value: toInteger(entry?.value)
    }))
    .filter(entry => entry.key && entry.value);
}

async function spendNeedChangeItem(item, amount = 1) {
  const quantity = getItemQuantity(item);
  const charges = getNeedChangeChargesData(item);
  const cost = Math.max(1, toInteger(amount));
  if (charges.max <= 1) {
    const next = Math.max(0, quantity - 1);
    if (next <= 0) return item.delete();
    return item.update({ "system.quantity": next });
  }

  const remainingCharges = Math.max(0, charges.value - cost);
  if (remainingCharges > 0) {
    return item.update({ "system.functions.needChange.charges.value": remainingCharges });
  }

  const nextQuantity = Math.max(0, quantity - 1);
  if (nextQuantity <= 0) return item.delete();
  return item.update({
    "system.quantity": nextQuantity,
    "system.functions.needChange.charges.value": charges.max
  });
}
