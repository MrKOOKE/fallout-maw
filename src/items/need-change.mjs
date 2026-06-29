import { requestDamageApplication, requestDamageApplications, requestFirstAidEffect, requestFirstAidNeedChanges } from "../combat/damage-hub.mjs";
import { addOrganismDevelopment } from "../races/organism-development.mjs";
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
  const damages = normalizeNeedChangeDamages(needChange.damages);
  const organismDevelopment = normalizeNeedChangeOrganismDevelopment(needChange.organismDevelopment);
  const healthRecovery = Math.max(0, toInteger(needChange.healthRecovery));
  const durationSeconds = Math.max(0, toInteger(needChange.durationSeconds));
  const intervalSeconds = Math.max(1, toInteger(needChange.intervalSeconds, 6));
  const changes = Array.isArray(needChange.changes) ? needChange.changes.filter(change => String(change?.key ?? "").trim()) : [];
  const hasTimedEffect = durationSeconds > 0 && changes.length;
  if (!needs.length && !damages.length && !organismDevelopment.length && healthRecovery <= 0 && !hasTimedEffect) return false;

  if (needs.length) {
    const results = await requestFirstAidNeedChanges({ actor: targetActor, needs });
    if (!results.length) return false;
  }

  if (damages.length) {
    await applyNeedChangeDamages(targetActor, damages, item);
  }

  if (organismDevelopment.length) {
    const values = Object.fromEntries(organismDevelopment.map(entry => [entry.characteristicKey, entry.value]));
    await addOrganismDevelopment(targetActor, values);
  }

  if (healthRecovery > 0) {
    await requestDamageApplication({
      actor: targetActor,
      amount: healthRecovery,
      mode: "healing",
      scope: "health",
      applyMitigation: false,
      processDamageTypeSettings: false,
      source: {
        type: "item",
        itemUuid: item?.uuid ?? "",
        itemName: item?.name ?? ""
      }
    });
  }

  if (hasTimedEffect) {
    await requestFirstAidEffect({
      actor: targetActor,
      itemName: item.name,
      itemImg: item.img,
      durationSeconds,
      intervalSeconds,
      changes,
      source: {
        type: "item",
        itemUuid: item?.uuid ?? "",
        itemName: item?.name ?? ""
      }
    });
  }

  const sourceActor = item.actor ?? targetActor;
  await spendNeedChangeItem(item, 1);
  Hooks.callAll("fallout-maw.itemUsed", {
    actor: sourceActor,
    targetActor,
    item,
    action: "needChange"
  });
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

export function normalizeNeedChangeDamages(damages = []) {
  const source = Array.isArray(damages)
    ? damages
    : Object.entries(damages ?? {}).map(([damageTypeKey, value]) => ({ damageTypeKey, value }));
  return source
    .map(entry => ({
      damageTypeKey: String(entry?.damageTypeKey ?? "").trim(),
      value: Math.max(0, toInteger(entry?.value))
    }))
    .filter(entry => entry.damageTypeKey && entry.value > 0);
}

export function normalizeNeedChangeOrganismDevelopment(entries = []) {
  const source = Array.isArray(entries) ? entries : [];
  return source
    .map(entry => ({
      characteristicKey: String(entry?.characteristicKey ?? "").trim(),
      value: Number(entry?.value)
    }))
    .filter(entry => entry.characteristicKey && Number.isFinite(entry.value) && entry.value > 0);
}

async function applyNeedChangeDamages(actor, damages = [], item = null) {
  const requests = damages.map(entry => ({
    actor,
    amount: entry.value,
    damageTypeKey: entry.damageTypeKey,
    source: {
      type: "item",
      itemUuid: item?.uuid ?? "",
      itemName: item?.name ?? ""
    }
  }));
  if (!requests.length) return [];
  return requestDamageApplications(requests);
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
