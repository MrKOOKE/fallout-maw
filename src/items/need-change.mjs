import { requestDamageApplication, requestDamageApplications, requestFirstAidEffect, requestNeedChanges } from "../combat/damage-hub.mjs";
import { recoverInventoryConsumption, runInventoryConsumption } from "../inventory/consumption-receipt.mjs";
import { addOrganismDevelopment } from "../races/organism-development.mjs";
import { getNeedChangeChargesData, getNeedChangeFunction, hasItemFunction, ITEM_FUNCTIONS } from "../utils/item-functions.mjs";
import { getItemQuantity } from "../utils/inventory-containers.mjs";
import { toInteger } from "../utils/numbers.mjs";

export async function useNeedChangeItem({
  targetActor = null,
  item = null,
  source = {},
  chainRef = null,
  options = {}
} = {}) {
  if (item) {
    const recovery = await recoverInventoryConsumption(item);
    if (recovery.handled) return recovery.result;
  }
  if (!targetActor || !item || !hasItemFunction(item, ITEM_FUNCTIONS.needChange)) return false;

  const inheritedChainRef = chainRef
    ?? options?.falloutMawSystemEventChainRef
    ?? options?.chainRef
    ?? source?.chainRef
    ?? null;
  const eventSource = {
    type: "item",
    itemUuid: item?.uuid ?? "",
    itemName: item?.name ?? "",
    ...(inheritedChainRef ? { chainRef: inheritedChainRef } : {})
  };

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

  return runInventoryConsumption({ item, kind: "needChange", amount: 1, targetActor,
    documentOptions: createNeedChangeDocumentOptions(inheritedChainRef)
  }, async ({ markEffectsStarted }) => {
    if (needs.length) {
      markEffectsStarted();
      const results = await requestNeedChanges({
        actor: targetActor,
        needs,
        source: eventSource,
        context: {
          kind: "needChangeItem",
          itemUuid: item.uuid
        }
      });
      if (!results.length) return false;
    }

    if (damages.length) {
      markEffectsStarted();
      const results = await applyNeedChangeDamages(targetActor, damages, eventSource);
      if (!results?.length || results.some(result => !result || result.cancelled || result.failed || result.status === "cancelled" || result.status === "error")) return false;
    }

    if (organismDevelopment.length) {
      markEffectsStarted();
      const values = Object.fromEntries(organismDevelopment.map(entry => [entry.characteristicKey, entry.value]));
      await addOrganismDevelopment(targetActor, values);
    }

    if (healthRecovery > 0) {
      markEffectsStarted();
      const result = await requestDamageApplication({
        actor: targetActor,
        amount: healthRecovery,
        mode: "healing",
        scope: "health",
        applyMitigation: false,
        processDamageTypeSettings: false,
        source: eventSource
      });
      if (!result || result.cancelled || result.failed || result.status === "cancelled" || result.status === "error") return false;
    }

    if (hasTimedEffect) {
      markEffectsStarted();
      const effects = await requestFirstAidEffect({
        actor: targetActor,
        itemName: item.name,
        itemImg: item.img,
        durationSeconds,
        intervalSeconds,
        changes,
        source: eventSource
      });
      if (!effects?.length) return false;
    }

    return true;
  });
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

async function applyNeedChangeDamages(actor, damages = [], source = {}) {
  const damagePacketId = String(source?.damagePacketId ?? "").trim() || foundry.utils.randomID();
  const requests = damages.map(entry => ({
    actor,
    amount: entry.value,
    damageTypeKey: entry.damageTypeKey,
    source: { ...source, damagePacketId }
  }));
  if (!requests.length) return [];
  return requestDamageApplications(requests);
}

function createNeedChangeDocumentOptions(chainRef = null) {
  return chainRef
    ? { chainRef, falloutMawSystemEventChainRef: chainRef }
    : {};
}
