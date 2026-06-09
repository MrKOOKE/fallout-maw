import { SYSTEM_ID } from "../constants.mjs";
import { registerQueuedWorldTimeProcessor } from "../time/world-time-queue.mjs";
import {
  ITEM_FUNCTIONS,
  getConditionFunction,
  getEnergyConsumerFunction,
  getEnergySourceFunction,
  getLightSourceFunction,
  hasItemFunction,
  isItemBrokenByCondition
} from "../utils/item-functions.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { resolveWorldItemSync } from "../utils/world-items.mjs";

const ACTIVE_LIGHT_SOURCES_FLAG = "activeLightSources";
const BASE_LIGHT_FLAG = "lightSourceBaseLight";
const RESOURCE_REMAINDERS_FLAG = "lightSourceResourceRemainders";
const ENERGY_SOURCE_PROTOTYPE_FLAG = "energySourcePrototypeUuid";
const EPSILON = 0.000001;

export function registerLightSourceHooks() {
  registerQueuedWorldTimeProcessor(processLightSourceWorldTime, { priority: -20 });
  Hooks.on("updateItem", item => {
    if (!item?.parent) return;
    void syncActorLightSourceTokens(item.parent);
  });
  Hooks.on("deleteItem", item => {
    if (!item?.parent) return;
    void syncActorLightSourceTokens(item.parent);
  });
  Hooks.on("canvasReady", () => {
    void syncSceneLightSources(canvas?.scene);
  });
}

export function getLightSourceDisplayName(item = null) {
  const light = getLightSourceFunction(item);
  return String(light?.name ?? "").trim() || item?.name || game.i18n.localize("FALLOUTMAW.Item.FunctionLightSource");
}

export function getEnergySourceDisplayName(item = null) {
  const source = getEnergySourceFunction(item);
  return String(source?.name ?? "").trim() || item?.name || game.i18n.localize("FALLOUTMAW.Item.FunctionEnergySource");
}

export function getEnergySourceReserveState(item = null) {
  const reserve = getEnergySourceFunction(item)?.reserve ?? {};
  const max = Math.max(0, Number(reserve.max) || 0);
  const value = Math.max(0, Math.min(max || Number.POSITIVE_INFINITY, Number(reserve.value) || 0));
  return { value, max };
}

export function getLightSourceResourceCosts(item = null) {
  const light = getLightSourceFunction(item);
  return (Array.isArray(light?.resourceCosts) ? light.resourceCosts : [])
    .map((cost, index) => ({
      index,
      type: String(cost?.type ?? "").trim(),
      amountPerHour: Math.max(0, Number(cost?.amountPerHour) || 0)
    }))
    .filter(cost => cost.type && cost.amountPerHour > 0);
}

export function lightSourceUsesEnergyConsumer(item = null) {
  return hasItemFunction(item, ITEM_FUNCTIONS.energyConsumer, { ignoreBroken: true })
    && getLightSourceResourceCosts(item).some(cost => cost.type === "energyConsumer");
}

export function canActivateLightSource(item = null) {
  if (!item || !hasItemFunction(item, ITEM_FUNCTIONS.lightSource) || isItemBrokenByCondition(item)) return false;
  for (const cost of getLightSourceResourceCosts(item)) {
    if (cost.type === "condition" && Math.max(0, toInteger(getConditionFunction(item).value)) <= 0) return false;
    if (cost.type === "energyConsumer") {
      const installed = getInstalledEnergySourceData(getEnergyConsumerFunction(item));
      if (!installed || getEnergySourceReserveState(installed).value <= 0) return false;
      if (!energySourceMatchesConsumer(installed, getEnergyConsumerFunction(item))) return false;
    }
  }
  return true;
}

export function isLightSourceActive(tokenOrDocument = null, item = null) {
  if (!item?.id) return false;
  return getActiveLightSourceEntries(getTokenDocument(tokenOrDocument))
    .some(entry => entry.itemId === item.id);
}

export async function toggleLightSource(tokenOrDocument = null, item = null) {
  return setLightSourceActive(tokenOrDocument, item, !isLightSourceActive(tokenOrDocument, item));
}

export async function setLightSourceActive(tokenOrDocument = null, item = null, active = false) {
  const tokenDocument = getTokenDocument(tokenOrDocument);
  if (!tokenDocument || !item?.id || !hasItemFunction(item, ITEM_FUNCTIONS.lightSource)) return false;
  if (active && !canActivateLightSource(item)) {
    ui.notifications?.warn?.(game.i18n.localize("FALLOUTMAW.Item.LightSourceNoEnergySource"));
    return false;
  }
  let entries = getActiveLightSourceEntries(tokenDocument).filter(entry => entry.itemId !== item.id);
  if (active) {
    if (!entries.length && !tokenDocument.getFlag(SYSTEM_ID, BASE_LIGHT_FLAG)) {
      await tokenDocument.setFlag(SYSTEM_ID, BASE_LIGHT_FLAG, getTokenLightObject(tokenDocument));
    }
    entries.push({ itemId: item.id });
  }
  entries = normalizeActiveLightSourceEntries(entries);
  if (entries.length) await tokenDocument.setFlag(SYSTEM_ID, ACTIVE_LIGHT_SOURCES_FLAG, entries);
  else await tokenDocument.unsetFlag(SYSTEM_ID, ACTIVE_LIGHT_SOURCES_FLAG);
  await syncTokenLightSources(tokenDocument);
  return true;
}

export function getActiveEnergySourceItem(actor = null, consumerData = {}) {
  return getInstalledEnergySourceData(consumerData);
}

export function getAvailableEnergySourceItems(actor = null, consumerData = {}) {
  const sourceItems = Array.isArray(actor?.items?.contents)
    ? actor.items.contents
    : (typeof actor?.items?.values === "function" ? Array.from(actor.items.values()) : []);
  return sourceItems
    .filter(item => hasItemFunction(item, ITEM_FUNCTIONS.energySource, { ignoreBroken: true }))
    .filter(item => energySourceMatchesConsumer(item, consumerData))
    .sort((left, right) => getEnergySourceDisplayName(left).localeCompare(getEnergySourceDisplayName(right), game.i18n.lang));
}

export async function setEnergyConsumerActiveSource(consumerItem = null, sourceItem = null) {
  if (!consumerItem?.update || !hasItemFunction(consumerItem, ITEM_FUNCTIONS.energyConsumer, { ignoreBroken: true })) return false;
  await consumerItem.update({
    "system.functions.energyConsumer.installedSource": createInstalledEnergySourceData(sourceItem)
  });
  return true;
}

export async function installEnergyConsumerSource(actor = null, consumerItem = null, sourceItem = null) {
  if (!actor?.createEmbeddedDocuments || !consumerItem?.update || !sourceItem) return false;
  if (!hasItemFunction(consumerItem, ITEM_FUNCTIONS.energyConsumer, { ignoreBroken: true })) return false;
  if (!hasItemFunction(sourceItem, ITEM_FUNCTIONS.energySource, { ignoreBroken: true })) return false;
  const consumer = getEnergyConsumerFunction(consumerItem);
  if (!energySourceMatchesConsumer(sourceItem, consumer)) return false;

  const returnedData = createEnergySourceItemDataFromInstalled(consumer.installedSource);
  const deleteSourceId = sourceItem.parent === actor ? sourceItem.id : "";
  await consumerItem.update({
    "system.functions.energyConsumer.installedSource": createInstalledEnergySourceData(sourceItem)
  });
  if (deleteSourceId && actor.items?.get(deleteSourceId)) {
    await actor.deleteEmbeddedDocuments("Item", [deleteSourceId]);
  }
  if (returnedData) await actor.createEmbeddedDocuments("Item", [returnedData]);
  return true;
}

export async function extractEnergyConsumerSource(actor = null, consumerItem = null) {
  if (!actor?.createEmbeddedDocuments || !consumerItem?.update) return false;
  if (!hasItemFunction(consumerItem, ITEM_FUNCTIONS.energyConsumer, { ignoreBroken: true })) return false;
  const returnedData = createEnergySourceItemDataFromInstalled(getEnergyConsumerFunction(consumerItem).installedSource);
  if (!returnedData) return false;
  await consumerItem.update({
    "system.functions.energyConsumer.installedSource": createInstalledEnergySourceData(null)
  });
  await actor.createEmbeddedDocuments("Item", [returnedData]);
  return true;
}

export async function syncTokenLightSources(tokenOrDocument = null) {
  const tokenDocument = getTokenDocument(tokenOrDocument);
  const actor = tokenDocument?.actor;
  if (!tokenDocument || !actor) return;

  const entries = getActiveLightSourceEntries(tokenDocument);
  const activeSources = [];
  for (const entry of entries) {
    const item = actor.items?.get(entry.itemId);
    if (!item || !hasItemFunction(item, ITEM_FUNCTIONS.lightSource) || isItemBrokenByCondition(item)) continue;
    if (!canActivateLightSource(item)) continue;
    activeSources.push({ item, light: getLightSourceFunction(item) });
  }

  const normalizedEntries = activeSources.map(source => ({ itemId: source.item.id }));
  if (normalizedEntries.length !== entries.length) {
    if (normalizedEntries.length) await tokenDocument.setFlag(SYSTEM_ID, ACTIVE_LIGHT_SOURCES_FLAG, normalizedEntries);
    else await tokenDocument.unsetFlag(SYSTEM_ID, ACTIVE_LIGHT_SOURCES_FLAG);
  }

  const selected = activeSources.sort(compareLightSourcesForToken).at(0) ?? null;
  if (selected) {
    await tokenDocument.update(createTokenLightUpdate(selected.light), { falloutMawLightSourceSync: true });
    return;
  }

  const base = tokenDocument.getFlag(SYSTEM_ID, BASE_LIGHT_FLAG);
  await tokenDocument.update(createTokenLightUpdate(base ?? { dim: 0, bright: 0, angle: 360, color: null }), { falloutMawLightSourceSync: true });
  await tokenDocument.unsetFlag(SYSTEM_ID, BASE_LIGHT_FLAG);
}

export async function syncActorLightSourceTokens(actor = null) {
  if (!actor) return;
  for (const scene of game.scenes?.contents ?? []) {
    for (const tokenDocument of scene.tokens?.contents ?? []) {
      const tokenActor = tokenDocument.actor;
      if (!tokenActor) continue;
      if (tokenActor.uuid !== actor.uuid && tokenActor.id !== actor.id) continue;
      await syncTokenLightSources(tokenDocument);
    }
  }
}

async function processLightSourceWorldTime(_worldTime, deltaSeconds) {
  if (!game.user?.isGM) return;
  const seconds = Number(deltaSeconds) || 0;
  if (seconds <= 0) return;
  for (const scene of game.scenes?.contents ?? []) {
    await processSceneLightSourceWorldTime(scene, seconds);
  }
}

async function processSceneLightSourceWorldTime(scene = null, deltaSeconds = 0) {
  for (const tokenDocument of scene?.tokens?.contents ?? []) {
    const actor = tokenDocument.actor;
    if (!actor) continue;
    const entries = getActiveLightSourceEntries(tokenDocument);
    if (!entries.length) continue;
    const remaining = [];
    let changed = false;
    for (const entry of entries) {
      const item = actor.items?.get(entry.itemId);
      if (!item || !hasItemFunction(item, ITEM_FUNCTIONS.lightSource) || isItemBrokenByCondition(item)) {
        changed = true;
        continue;
      }
      const consumed = await consumeLightSourceResources(actor, item, deltaSeconds);
      if (consumed) remaining.push(entry);
      else changed = true;
    }
    if (changed) {
      if (remaining.length) await tokenDocument.setFlag(SYSTEM_ID, ACTIVE_LIGHT_SOURCES_FLAG, remaining);
      else await tokenDocument.unsetFlag(SYSTEM_ID, ACTIVE_LIGHT_SOURCES_FLAG);
    }
    await syncTokenLightSources(tokenDocument);
  }
}

async function consumeLightSourceResources(actor = null, item = null, deltaSeconds = 0) {
  const costs = getLightSourceResourceCosts(item);
  if (!costs.length) return true;
  const hours = Math.max(0, Number(deltaSeconds) || 0) / 3600;
  if (hours <= 0) return true;

  const checks = [];
  for (const cost of costs) {
    const amount = cost.amountPerHour * hours;
    if (amount <= 0) continue;
    if (cost.type === "condition") {
      checks.push(await prepareConditionConsumption(item, cost, amount));
    } else if (cost.type === "energyConsumer") {
      checks.push(prepareEnergyConsumption(actor, item, amount));
    }
  }

  if (checks.some(check => !check.available)) return false;
  for (const check of checks) await check.spend?.();
  return true;
}

async function prepareConditionConsumption(item = null, cost = {}, amount = 0) {
  const condition = getConditionFunction(item);
  const current = Math.max(0, toInteger(condition.value));
  const remainders = foundry.utils.deepClone(item.getFlag(SYSTEM_ID, RESOURCE_REMAINDERS_FLAG) ?? {});
  const key = `condition.${cost.index}`;
  const total = Math.max(0, Number(remainders[key]) || 0) + amount;
  const spend = Math.floor(total + EPSILON);
  const remainder = total - spend;
  if (current <= 0 && total > 0) return { available: false };
  if (spend > current) return { available: false };
  return {
    available: true,
    spend: async () => {
      remainders[key] = remainder > EPSILON ? remainder : 0;
      await item.update({ "system.functions.condition.value": Math.max(0, current - spend) });
      await item.setFlag(SYSTEM_ID, RESOURCE_REMAINDERS_FLAG, remainders);
    }
  };
}

function prepareEnergyConsumption(actor = null, item = null, amount = 0) {
  const consumer = getEnergyConsumerFunction(item);
  const source = getInstalledEnergySourceData(consumer);
  if (!source || !hasItemFunction(source, ITEM_FUNCTIONS.energySource, { ignoreBroken: true })) return { available: false };
  if (!energySourceMatchesConsumer(source, consumer)) return { available: false };
  const reserve = getEnergySourceReserveState(source);
  if (reserve.value + EPSILON < amount) return { available: false };
  return {
    available: true,
    spend: () => item.update({
      "system.functions.energyConsumer.installedSource.reserve.value": Math.max(0, reserve.value - amount)
    })
  };
}

async function syncSceneLightSources(scene = null) {
  for (const tokenDocument of scene?.tokens?.contents ?? []) {
    await syncTokenLightSources(tokenDocument);
  }
}

function getTokenDocument(tokenOrDocument = null) {
  return tokenOrDocument?.document ?? tokenOrDocument ?? null;
}

function getActiveLightSourceEntries(tokenDocument = null) {
  return normalizeActiveLightSourceEntries(tokenDocument?.getFlag?.(SYSTEM_ID, ACTIVE_LIGHT_SOURCES_FLAG) ?? []);
}

function normalizeActiveLightSourceEntries(entries = []) {
  const seen = new Set();
  const normalized = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const itemId = String(entry?.itemId ?? entry ?? "").trim();
    if (!itemId || seen.has(itemId)) continue;
    seen.add(itemId);
    normalized.push({ itemId });
  }
  return normalized;
}

function compareLightSourcesForToken(left, right) {
  const leftBright = Math.max(0, Number(left?.light?.bright) || 0);
  const rightBright = Math.max(0, Number(right?.light?.bright) || 0);
  if (leftBright !== rightBright) return rightBright - leftBright;
  const leftDim = Math.max(0, Number(left?.light?.dim) || 0);
  const rightDim = Math.max(0, Number(right?.light?.dim) || 0);
  return rightDim - leftDim;
}

function createTokenLightUpdate(light = {}) {
  const dim = Math.max(0, Number(light?.dim) || 0);
  const bright = Math.max(0, Number(light?.bright) || 0);
  const angle = Math.max(0, Math.min(360, Number(light?.angle) || 360));
  const color = String(light?.color ?? "").trim();
  return {
    "light.dim": dim,
    "light.bright": bright,
    "light.angle": angle,
    "light.color": color || null
  };
}

function getTokenLightObject(tokenDocument = null) {
  return tokenDocument?.light?.toObject?.() ?? foundry.utils.deepClone(tokenDocument?.light ?? {});
}

function getInstalledEnergySourceData(consumerData = {}) {
  const installed = normalizeInstalledEnergySourceData(consumerData?.installedSource);
  if (!installed.sourceItemUuid) return null;
  return {
    uuid: installed.sourceItemUuid,
    name: installed.name,
    img: installed.img,
    system: {
      functions: {
        energySource: {
          enabled: true,
          name: installed.name,
          class: installed.class,
          reserve: installed.reserve
        }
      }
    }
  };
}

function createInstalledEnergySourceData(item = null) {
  if (!item) return normalizeInstalledEnergySourceData();
  const source = getEnergySourceFunction(item);
  const max = Math.max(0, Number(source?.reserve?.max) || 0);
  const value = Math.max(0, Number(source?.reserve?.value) || max);
  const itemData = typeof item.toObject === "function" ? item.toObject() : {};
  delete itemData._id;
  return normalizeInstalledEnergySourceData({
    sourceItemUuid: item.uuid,
    name: String(source?.name ?? "").trim() || item.name || "",
    class: String(source?.class ?? "").trim(),
    img: String(item.img ?? "").trim(),
    itemData,
    reserve: {
      value,
      max
    }
  });
}

function normalizeInstalledEnergySourceData(source = {}) {
  const max = Math.max(0, Number(source?.reserve?.max) || 0);
  const value = Math.max(0, Math.min(max || Number.POSITIVE_INFINITY, Number(source?.reserve?.value) || 0));
  return {
    sourceItemUuid: String(source?.sourceItemUuid ?? "").trim(),
    name: String(source?.name ?? "").trim(),
    class: String(source?.class ?? "").trim(),
    img: String(source?.img ?? "").trim(),
    itemData: source?.itemData && typeof source.itemData === "object" ? foundry.utils.deepClone(source.itemData) : {},
    reserve: {
      value,
      max
    }
  };
}

function createEnergySourceItemDataFromInstalled(source = {}) {
  const installed = normalizeInstalledEnergySourceData(source);
  if (!installed.sourceItemUuid) return null;
  const data = foundry.utils.deepClone(installed.itemData ?? {});
  delete data._id;
  data.type ||= "gear";
  data.name = installed.name || data.name || game.i18n.localize("FALLOUTMAW.Item.FunctionEnergySource");
  data.img = installed.img || data.img || "icons/svg/battery.svg";
  data.system ??= {};
  data.system.functions ??= {};
  data.system.functions.energySource = {
    ...(data.system.functions.energySource ?? {}),
    enabled: true,
    name: installed.name || data.system.functions.energySource?.name || data.name,
    class: installed.class || data.system.functions.energySource?.class || "D",
    reserve: {
      value: installed.reserve.value,
      max: installed.reserve.max
    }
  };
  return data;
}

function energySourceMatchesConsumer(sourceItem = null, consumerData = {}) {
  const accepted = getAcceptedEnergySourceUuids(consumerData);
  if (!accepted.size) return true;
  if (accepted.has(sourceItem?.uuid) || accepted.has(sourceItem?.id)) return true;
  const prototypeUuid = String(sourceItem?.getFlag?.(SYSTEM_ID, ENERGY_SOURCE_PROTOTYPE_FLAG) ?? sourceItem?.getFlag?.("core", "sourceId") ?? "").trim();
  if (prototypeUuid && accepted.has(prototypeUuid)) return true;
  const sourceData = getEnergySourceFunction(sourceItem);
  const sourceName = String(sourceData?.name ?? "").trim() || sourceItem?.name || "";
  const sourceClass = String(sourceData?.class ?? "").trim();
  for (const uuid of accepted) {
    const prototype = resolveWorldItemSync(uuid);
    if (!prototype || !hasItemFunction(prototype, ITEM_FUNCTIONS.energySource, { ignoreBroken: true })) continue;
    const prototypeData = getEnergySourceFunction(prototype);
    const prototypeName = String(prototypeData?.name ?? "").trim() || prototype.name || "";
    const prototypeClass = String(prototypeData?.class ?? "").trim();
    if (sourceName === prototypeName && sourceClass === prototypeClass) return true;
  }
  return false;
}

function getAcceptedEnergySourceUuids(consumerData = {}) {
  return new Set([
    ...(Array.isArray(consumerData?.sourceItemUuids) ? consumerData.sourceItemUuids : []),
    String(consumerData?.sourceItemUuid ?? "")
  ].map(value => String(value ?? "").trim()).filter(Boolean));
}
