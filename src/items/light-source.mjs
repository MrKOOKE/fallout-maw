import { SYSTEM_ID } from "../constants.mjs";
import { registerQueuedWorldTimeProcessor } from "../time/world-time-queue.mjs";
import { FALLBACK_ICON, escapeHTML, normalizeImagePath } from "../utils/actor-display-data.mjs";
import {
  ITEM_FUNCTIONS,
  getActorItemsWithInstalledModules,
  getConditionFunction,
  getEnergyConsumerFunction,
  getEnergySourceFunction,
  getLightSourceFunction,
  hasItemFunction,
  isItemBrokenByCondition,
  resolveActorItemOrInstalledModule
} from "../utils/item-functions.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { resolveWorldItemSync } from "../utils/world-items.mjs";

const { DialogV2 } = foundry.applications.api;
const ACTIVE_LIGHT_SOURCES_FLAG = "activeLightSources";
const BASE_LIGHT_FLAG = "lightSourceBaseLight";
const RESOURCE_REMAINDERS_FLAG = "lightSourceResourceRemainders";
const ENERGY_SOURCE_PROTOTYPE_FLAG = "energySourcePrototypeUuid";
const EPSILON = 0.000001;
const RESERVE_PERSISTENCE_STEP = 0.01;
const lightSourceResourceRemainderCache = new Map();
const lightSourceEnergyReserveCache = new Map();

export function registerLightSourceHooks() {
  registerQueuedWorldTimeProcessor(processLightSourceWorldTime, { priority: -20 });
  Hooks.on("updateItem", (item, changes) => {
    if (!item?.parent) return;
    if (!isLightSourceItemUpdateRelevant(item, changes)) return;
    void syncActorLightSourceTokens(item.parent);
  });
  Hooks.on("deleteItem", item => {
    if (!item?.parent) return;
    if (!isLightSourceRelevantItem(item)) return;
    void syncActorLightSourceTokens(item.parent);
  });
  Hooks.on("canvasReady", () => {
    void syncSceneLightSources(canvas?.scene);
  });
}

function isLightSourceItemUpdateRelevant(item = null, changes = {}) {
  if (isLightSourceRelevantItem(item)) return true;
  return Object.keys(foundry.utils.flattenObject(changes ?? {})).some(path => (
    path.startsWith("system.functions.lightSource")
    || path.startsWith("system.functions.energyConsumer")
    || path.startsWith("system.functions.energySource")
  ));
}

function isLightSourceRelevantItem(item = null) {
  return Boolean(
    hasItemFunction(item, ITEM_FUNCTIONS.lightSource, { ignoreBroken: true })
    || hasItemFunction(item, ITEM_FUNCTIONS.energyConsumer, { ignoreBroken: true })
    || hasItemFunction(item, ITEM_FUNCTIONS.energySource, { ignoreBroken: true })
  );
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

export async function openLightSourceEnergyDialog({ actor = null, token = null, item = null, application = null, showToggle = false } = {}) {
  if (!actor?.isOwner || !item || !hasItemFunction(item, ITEM_FUNCTIONS.lightSource, { ignoreBroken: true })) return undefined;
  const consumer = getEnergyConsumerFunction(item);
  const usesEnergy = lightSourceUsesEnergyConsumer(item);
  const sourceItems = usesEnergy ? getAvailableEnergySourceItems(actor, consumer) : [];
  let selectedSourceUuid = "";
  const renderContent = () => renderLightSourceEnergyDialogContent({
    actor,
    token,
    item: resolveActorItemOrInstalledModule(actor, item.id) ?? item,
    showToggle,
    usesEnergy,
    selectedSourceUuid
  });
  const refreshDialogContent = dialog => {
    if (selectedSourceUuid) {
      const freshItem = resolveActorItemOrInstalledModule(actor, item.id);
      const source = getAvailableEnergySourceItems(actor, getEnergyConsumerFunction(freshItem))
        .find(candidate => candidate.uuid === selectedSourceUuid);
      if (!source) selectedSourceUuid = "";
    }
    const root = dialog.element?.querySelector?.("[data-light-source-dialog-root]");
    if (root) root.outerHTML = renderContent();
  };
  const switchSource = async (dialog, sourceUuid) => {
    const freshItem = resolveActorItemOrInstalledModule(actor, item.id);
    const source = getAvailableEnergySourceItems(actor, getEnergyConsumerFunction(freshItem))
      .find(candidate => candidate.uuid === sourceUuid);
    if (!freshItem || !source) {
      ui.notifications?.warn?.(game.i18n.localize("FALLOUTMAW.Item.LightSourceNoEnergySource"));
      return;
    }
    await installEnergyConsumerSource(actor, freshItem, source);
    selectedSourceUuid = "";
    await syncTokenLightSources(token?.document ?? token);
    refreshDialogContent(dialog);
  };
  const extractSource = async dialog => {
    const freshItem = resolveActorItemOrInstalledModule(actor, item.id);
    if (!freshItem) return;
    const extracted = await extractEnergyConsumerSource(actor, freshItem);
    if (!extracted) ui.notifications?.warn?.(game.i18n.localize("FALLOUTMAW.Item.LightSourceNoEnergySource"));
    await syncTokenLightSources(token?.document ?? token);
    refreshDialogContent(dialog);
  };
  const toggleFromDialog = async dialog => {
    const freshItem = resolveActorItemOrInstalledModule(actor, item.id);
    if (!freshItem) return;
    await toggleLightSource(token?.document ?? token, freshItem);
    refreshDialogContent(dialog);
  };

  if (usesEnergy && !sourceItems.length) {
    ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Item.LightSourceNoAvailableEnergySources"));
  }

  const dialog = new DialogV2({
    window: {
      title: getLightSourceDisplayName(item)
    },
    content: `<form class="fallout-maw-reload-dialog-form">${renderContent()}</form>`,
    form: {
      closeOnSubmit: false
    },
    buttons: usesEnergy ? [
      {
        action: "extract",
        label: game.i18n.localize("FALLOUTMAW.Item.LightSourceExtract"),
        type: "button",
        callback: (event, button, dlg) => extractSource(dlg)
      },
      {
        action: "install",
        label: game.i18n.localize("FALLOUTMAW.Item.LightSourceInstall"),
        type: "button",
        default: true,
        callback: (event, button, dlg) => switchSource(dlg, selectedSourceUuid)
      },
      {
        action: "close",
        label: game.i18n.localize("FALLOUTMAW.Item.WeaponReloadFinish"),
        type: "button",
        callback: (event, button, dlg) => dlg.close()
      }
    ] : [
      {
        action: "close",
        label: game.i18n.localize("FALLOUTMAW.Item.WeaponReloadFinish"),
        type: "button",
        callback: (event, button, dlg) => dlg.close()
      }
    ],
    position: {
      width: 520
    }
  });

  dialog.addEventListener("render", () => {
    const element = dialog.element;
    if (!element || element.dataset.lightSourceDialogWatcher) return;
    element.dataset.lightSourceDialogWatcher = "1";
    element.addEventListener("click", async event => {
      const toggle = event.target?.closest?.("[data-light-source-dialog-toggle]");
      if (toggle) {
        event.preventDefault();
        await toggleFromDialog(dialog);
        return;
      }
      const card = event.target?.closest?.("[data-light-energy-source-card]");
      if (!card) return;
      event.preventDefault();
      selectedSourceUuid = String(card.dataset.lightEnergySourceUuid ?? "");
      refreshDialogContent(dialog);
    });
  }, { once: true });

  await dialog.render({ force: true });
  return undefined;
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
  tokenDocument.actor?.render(false, {
    renderContext: "fallout-maw.lightSourceState",
    renderData: { itemId: item.id, active: Boolean(active), tokenId: tokenDocument.id }
  });
  if (active) {
    Hooks.callAll("fallout-maw.itemUsed", {
      actor: tokenDocument.actor,
      token: tokenDocument,
      item,
      action: "lightSource"
    });
  }
  return true;
}

export function getActiveEnergySourceItem(actor = null, consumerData = {}) {
  return getInstalledEnergySourceData(consumerData);
}

export function getAvailableEnergySourceItems(actor = null, consumerData = {}) {
  const sourceItems = getActorItemsWithInstalledModules(actor);
  return sourceItems
    .filter(item => hasItemFunction(item, ITEM_FUNCTIONS.energySource, { ignoreBroken: true }))
    .filter(item => energySourceMatchesConsumer(item, consumerData))
    .sort((left, right) => getEnergySourceDisplayName(left).localeCompare(getEnergySourceDisplayName(right), game.i18n.lang));
}

function renderLightSourceEnergyDialogContent({ actor = null, token = null, item = null, showToggle = false, usesEnergy = false, selectedSourceUuid = "" } = {}) {
  const tokenDocument = token?.document ?? token ?? null;
  const active = isLightSourceActive(tokenDocument, item);
  const toggleDisabled = !tokenDocument || (!active && !canActivateLightSource(item));
  const consumer = getEnergyConsumerFunction(item);
  const sourceItems = usesEnergy ? getAvailableEnergySourceItems(actor, consumer) : [];
  const activeSource = usesEnergy ? getActiveEnergySourceItem(actor, consumer) : null;
  return `
    <div class="fallout-maw-reload-dialog" data-light-source-dialog-root>
      <div class="fallout-maw-reload-main">
        ${showToggle ? `
        <div class="fallout-maw-reload-source-pane">
          <span>${escapeHTML(getLightSourceDisplayName(item))}</span>
          <button type="button" class="fallout-maw-reload-source-card active" data-light-source-dialog-toggle ${toggleDisabled ? "disabled" : ""}>
            <img src="${escapeAttribute(normalizeImagePath("icons/svg/light.svg", FALLBACK_ICON))}" alt="">
            <span>${escapeHTML(game.i18n.localize(active ? "FALLOUTMAW.Item.LightSourceToggleOff" : "FALLOUTMAW.Item.LightSourceToggleOn"))}</span>
          </button>
        </div>
        ` : ""}
        ${usesEnergy ? `
        <div class="fallout-maw-reload-source-pane">
          <span>${escapeHTML(game.i18n.localize("FALLOUTMAW.Item.LightSourceCurrentEnergySource"))}</span>
          ${renderInstalledLightEnergySourceCard(activeSource)}
        </div>
        <div class="fallout-maw-reload-source-pane">
          <span>${escapeHTML(game.i18n.localize("FALLOUTMAW.Item.LightSourceAvailableEnergySources"))}</span>
          <div class="fallout-maw-reload-source-list" data-light-energy-source-list>
            ${renderLightEnergySourceCards(sourceItems, selectedSourceUuid)}
          </div>
        </div>
        ` : `
        <p>${escapeHTML(game.i18n.localize("FALLOUTMAW.Item.LightSourceNoEnergySource"))}</p>
        `}
      </div>
    </div>
  `;
}

function renderInstalledLightEnergySourceCard(activeSource = null) {
  if (!activeSource) {
    return `
      <div class="fallout-maw-token-hud-empty">
        ${escapeHTML(game.i18n.localize("FALLOUTMAW.Item.LightSourceNoEnergySource"))}
      </div>
    `;
  }
  const reserve = getEnergySourceReserveState(activeSource);
  const reserveLabel = reserve.max > 0 ? `${formatNumberForDisplay(reserve.value)} / ${formatNumberForDisplay(reserve.max)}` : formatNumberForDisplay(reserve.value);
  return `
    <div class="fallout-maw-reload-source-card fallout-maw-light-energy-card" data-light-energy-installed-source>
      <img src="${escapeAttribute(normalizeImagePath(activeSource.img, FALLBACK_ICON))}" alt="">
      <span>${escapeHTML(getEnergySourceDisplayName(activeSource))}</span>
      <strong>${escapeHTML(reserveLabel)}</strong>
    </div>
  `;
}

function renderLightEnergySourceCards(sourceItems = [], selectedSourceUuid = "") {
  if (!sourceItems.length) return `<div class="fallout-maw-token-hud-empty">${escapeHTML(game.i18n.localize("FALLOUTMAW.Item.LightSourceNoAvailableEnergySources"))}</div>`;
  return sourceItems.map(item => {
    const reserve = getEnergySourceReserveState(item);
    const reserveLabel = reserve.max > 0 ? `${formatNumberForDisplay(reserve.value)} / ${formatNumberForDisplay(reserve.max)}` : formatNumberForDisplay(reserve.value);
    const selected = item.uuid === selectedSourceUuid;
    return `
      <div
        class="fallout-maw-reload-source-card fallout-maw-light-energy-card ${selected ? "active" : ""}"
        data-light-energy-source-card
        data-light-energy-source-uuid="${escapeAttribute(item.uuid)}"
        title="${escapeAttribute(getEnergySourceDisplayName(item))}">
        <img src="${escapeAttribute(normalizeImagePath(item.img, FALLBACK_ICON))}" alt="">
        <span>${escapeHTML(getEnergySourceDisplayName(item))}</span>
        <strong>${escapeHTML(reserveLabel)}</strong>
      </div>
    `;
  }).join("");
}

function formatNumberForDisplay(value) {
  const number = Number(value) || 0;
  return Number.isInteger(number) ? String(number) : number.toFixed(2).replace(/\.?0+$/, "");
}

function escapeAttribute(value) {
  return escapeHTML(value).replace(/`/g, "&#096;");
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
    const item = resolveActorItemOrInstalledModule(actor, entry.itemId);
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
      const item = resolveActorItemOrInstalledModule(actor, entry.itemId);
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
  const remainders = getCachedLightSourceResourceRemainders(item);
  const key = `condition.${cost.index}`;
  const total = Math.max(0, Number(remainders[key]) || 0) + amount;
  const spend = Math.floor(total + EPSILON);
  const remainder = total - spend;
  if (current <= 0 && total > 0) return { available: false };
  if (spend > current) return { available: false };
  remainders[key] = remainder > EPSILON ? remainder : 0;
  return {
    available: true,
    spend: async () => {
      rememberLightSourceResourceRemainders(item, remainders);
      if (spend <= 0) return;
      await item.update({
        "system.functions.condition.value": Math.max(0, current - spend),
        [`flags.${SYSTEM_ID}.${RESOURCE_REMAINDERS_FLAG}`]: remainders
      });
    }
  };
}

function prepareEnergyConsumption(actor = null, item = null, amount = 0) {
  const consumer = getEnergyConsumerFunction(item);
  const source = getInstalledEnergySourceData(consumer);
  if (!source || !hasItemFunction(source, ITEM_FUNCTIONS.energySource, { ignoreBroken: true })) return { available: false };
  if (!energySourceMatchesConsumer(source, consumer)) return { available: false };
  const reserve = getEnergySourceReserveState(source);
  const cachedValue = getCachedLightSourceReserveValue(item, consumer, reserve.value);
  if (cachedValue + EPSILON < amount) return { available: false };
  const next = Math.max(0, cachedValue - amount);
  return {
    available: true,
    spend: async () => {
      rememberLightSourceReserveValue(item, consumer, next);
      const persistedNext = roundReserveValueForUpdate(next);
      if (next > EPSILON && persistedNext === roundReserveValueForUpdate(reserve.value)) return;
      await item.update({ "system.functions.energyConsumer.installedSource.reserve.value": persistedNext });
    }
  };
}

function getCachedLightSourceResourceRemainders(item = null) {
  const key = getDocumentCacheKey(item);
  if (key && lightSourceResourceRemainderCache.has(key)) {
    return foundry.utils.deepClone(lightSourceResourceRemainderCache.get(key));
  }
  return normalizeLightSourceResourceRemainders(item?.getFlag?.(SYSTEM_ID, RESOURCE_REMAINDERS_FLAG) ?? {});
}

function rememberLightSourceResourceRemainders(item = null, remainders = {}) {
  const key = getDocumentCacheKey(item);
  if (!key) return;
  lightSourceResourceRemainderCache.set(key, normalizeLightSourceResourceRemainders(remainders));
}

function normalizeLightSourceResourceRemainders(remainders = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(remainders ?? {})) {
    const number = Number(value) || 0;
    normalized[key] = Math.abs(number) > EPSILON ? number : 0;
  }
  return normalized;
}

function getCachedLightSourceReserveValue(item = null, consumer = {}, fallback = 0) {
  const key = getInstalledReserveCacheKey(item, consumer);
  const persisted = Math.max(0, Number(fallback) || 0);
  if (!key || !lightSourceEnergyReserveCache.has(key)) return persisted;
  const cached = Math.max(0, Number(lightSourceEnergyReserveCache.get(key)) || 0);
  if (Math.abs(roundReserveValueForUpdate(cached) - roundReserveValueForUpdate(persisted)) > RESERVE_PERSISTENCE_STEP) return persisted;
  return cached;
}

function rememberLightSourceReserveValue(item = null, consumer = {}, value = 0) {
  const key = getInstalledReserveCacheKey(item, consumer);
  if (!key) return;
  lightSourceEnergyReserveCache.set(key, Math.max(0, Number(value) || 0));
}

function getInstalledReserveCacheKey(item = null, consumer = {}) {
  const itemKey = getDocumentCacheKey(item);
  const sourceKey = String(consumer?.installedSource?.sourceItemUuid ?? "").trim();
  return itemKey && sourceKey ? `${itemKey}:${sourceKey}:installedReserve` : "";
}

function getDocumentCacheKey(document = null) {
  return String(document?.uuid ?? document?.id ?? "").trim();
}

function roundReserveValueForUpdate(value = 0) {
  return Math.max(0, Math.round((Number(value) || 0) * 100) / 100);
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

export function energySourceMatchesConsumer(sourceItem = null, consumerData = {}) {
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
