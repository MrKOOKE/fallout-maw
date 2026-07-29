import { SYSTEM_ID } from "../constants.mjs";
import { registerQueuedWorldTimeProcessor } from "../time/world-time-queue.mjs";
import { FALLBACK_ICON, escapeHTML, normalizeImagePath } from "../utils/actor-display-data.mjs";
import { getActorItemsWithActiveHudModules } from "../utils/hud-active-items.mjs";
import {
  ITEM_FUNCTIONS,
  getEnergyConsumerFunction,
  hasItemFunction,
  isItemBrokenByCondition,
  createActorItemOrInstalledModuleUpdate,
  resolveActorItemOrInstalledModule
} from "../utils/item-functions.mjs";
import {
  energySourceMatchesConsumer,
  extractEnergyConsumerSource,
  getActiveEnergySourceItem,
  getAvailableEnergySourceItems,
  getEnergySourceDisplayName,
  getEnergySourceReserveState,
  installEnergyConsumerSource
} from "./light-source.mjs";
import {
  getItemEnergyConsumptionConditions,
  isItemEnergyConsumptionConditionActive
} from "./item-interactions.mjs";
import { executeInventoryMutation } from "../inventory/mutation.mjs";
import { planContinuousResourceSpend } from "../inventory/resource-spend.mjs";

const { DialogV2 } = foundry.applications.api;
const EPSILON = 0.000001;
const RESERVE_PERSISTENCE_STEP = 0.01;
const energyConsumptionReserveCache = new Map();

export function registerEnergyConsumptionHooks() {
  registerQueuedWorldTimeProcessor(processEnergyConsumptionWorldTime, { priority: -15 });
  Hooks.on("updateActor", (_actor, changes) => {
    const paths = Object.keys(foundry.utils.flattenObject(changes ?? {}));
    if (paths.some(path => path === `flags.${SYSTEM_ID}.selectedHudWeaponSetKey` || path === `flags.${SYSTEM_ID}.selectedHudWeaponItemId`)) {
      Hooks.callAll("fallout-maw.energyConsumptionChanged", _actor);
    }
  });
}

export function getEnergyConsumptionConditions(item = null) {
  return getItemEnergyConsumptionConditions(item);
}

export function hasEnergyConsumptionConditions(item = null) {
  return getEnergyConsumptionConditions(item).length > 0;
}

export function getEnergyConsumptionDisplayName(item = null, condition = {}) {
  return String(condition?.name ?? "").trim()
    || item?.name
    || "Потребление энергии";
}

export function getEnergyConsumptionControlEntries(actor = null, options = {}) {
  const itemDocuments = Array.isArray(options.itemDocuments)
    ? options.itemDocuments
    : getActorItemsWithActiveHudModules(actor, options);
  const activeItemIds = options.activeItemIds instanceof Set
    ? options.activeItemIds
    : new Set(itemDocuments.map(item => String(item?.id ?? "")).filter(Boolean));
  return itemDocuments
    .filter(item => isActiveEnergyConsumptionCarrier(actor, item, { activeItemIds }))
    .flatMap(item => getEnergyConsumptionConditions(item).map(condition => {
      const active = isEnergyConsumptionActive(item, condition.id);
      return {
        id: `energyConsumption:${item.id}:${condition.id}`,
        itemId: item.id,
        conditionId: condition.id,
        name: getEnergyConsumptionDisplayName(item, condition),
        img: normalizeImagePath(item.img, FALLBACK_ICON),
        active,
        toggleable: true,
        toggled: active,
        disabled: false
      };
    }));
}

export function energyConsumptionConditionApplies(actor = null, condition = {}, context = {}) {
  const conditionId = String(condition?.id ?? "").trim();
  const itemId = String(context?.abilityItemId ?? "").trim();
  if (!actor || !conditionId || !itemId) return false;
  const item = resolveActorItemOrInstalledModule(actor, itemId);
  if (!isActiveEnergyConsumptionCarrier(actor, item)) return false;
  if (!getEnergyConsumptionConditions(item).some(entry => entry.id === conditionId)) return false;
  if (!isEnergyConsumptionActive(item, conditionId)) return false;
  return canActivateEnergyConsumption(actor, item, condition);
}

export function isEnergyConsumptionActive(item = null, conditionId = "") {
  return isItemEnergyConsumptionConditionActive(item, conditionId);
}

export async function toggleEnergyConsumption(actor = null, item = null, conditionId = "") {
  return setEnergyConsumptionActive(actor, item, conditionId, !isEnergyConsumptionActive(item, conditionId));
}

export async function setEnergyConsumptionActive(actor = null, item = null, conditionId = "", active = false) {
  const key = String(conditionId ?? "").trim();
  if (!actor || !item || !key) return false;
  const condition = getEnergyConsumptionConditions(item).find(entry => entry.id === key);
  if (!condition) return false;
  if (active && !canActivateEnergyConsumption(actor, item, condition)) {
    ui.notifications?.warn?.("Нет подходящего источника энергии.");
    return false;
  }
  const updated = await updateEnergyConsumptionCarrier(actor, item, {
    [`system.functions.energyConsumer.activeConditions.${key}`]: Boolean(active)
  }, "energy-consumption-toggle");
  if (!updated) return false;
  Hooks.callAll("fallout-maw.energyConsumptionChanged", actor);
  return true;
}

export function canActivateEnergyConsumption(actor = null, item = null, condition = {}) {
  if (!isActiveEnergyConsumptionCarrier(actor, item)) return false;
  if (isItemBrokenByCondition(item)) return false;
  const amount = Math.max(0, Number(condition?.amountPerHour) || 0);
  const consumer = getEnergyConsumerFunction(item);
  const source = getActiveEnergySourceItem(actor, consumer);
  if (!source || !hasItemFunction(source, ITEM_FUNCTIONS.energySource, { ignoreBroken: true })) return false;
  if (!energySourceMatchesConsumer(source, consumer)) return false;
  return amount <= 0 || getEnergySourceReserveState(source).value > 0;
}

export async function openEnergyConsumptionDialog({ actor = null, item = null, conditionId = "", application = null } = {}) {
  if (!actor?.isOwner || !item || !hasEnergyConsumptionConditions(item)) return undefined;
  let selectedSourceUuid = "";
  let selectedConditionId = String(conditionId ?? "").trim() || getEnergyConsumptionConditions(item).at(0)?.id || "";
  const renderContent = () => renderEnergyConsumptionDialogContent({
    actor,
    item: resolveActorItemOrInstalledModule(actor, item.id) ?? item,
    selectedConditionId,
    selectedSourceUuid
  });
  const refreshDialogContent = dialog => {
    const freshItem = resolveActorItemOrInstalledModule(actor, item.id);
    if (!getEnergyConsumptionConditions(freshItem).some(condition => condition.id === selectedConditionId)) {
      selectedConditionId = getEnergyConsumptionConditions(freshItem).at(0)?.id || "";
    }
    if (selectedSourceUuid) {
      const source = getAvailableEnergySourceItems(actor, getEnergyConsumerFunction(freshItem))
        .find(candidate => candidate.uuid === selectedSourceUuid);
      if (!source) selectedSourceUuid = "";
    }
    const root = dialog.element?.querySelector?.("[data-energy-consumption-dialog-root]");
    if (root) root.outerHTML = renderContent();
  };

  const switchSource = async dialog => {
    const freshItem = resolveActorItemOrInstalledModule(actor, item.id);
    const source = getAvailableEnergySourceItems(actor, getEnergyConsumerFunction(freshItem))
      .find(candidate => candidate.uuid === selectedSourceUuid);
    if (!freshItem || !source) {
      ui.notifications?.warn?.("Нет подходящего источника энергии.");
      return;
    }
    await installEnergyConsumerSource(actor, freshItem, source);
    selectedSourceUuid = "";
    Hooks.callAll("fallout-maw.energyConsumptionChanged", actor);
    refreshDialogContent(dialog);
  };

  const extractSource = async dialog => {
    const freshItem = resolveActorItemOrInstalledModule(actor, item.id);
    if (!freshItem) return;
    const extracted = await extractEnergyConsumerSource(actor, freshItem);
    if (!extracted) ui.notifications?.warn?.("Нет установленного источника энергии.");
    await disableInvalidEnergyConsumption(actor, freshItem);
    refreshDialogContent(dialog);
  };

  const dialog = new DialogV2({
    window: { title: item.name || "Потребление энергии" },
    content: `<form class="fallout-maw-reload-dialog-form">${renderContent()}</form>`,
    form: { closeOnSubmit: false },
    buttons: [
      {
        action: "extract",
        label: "Извлечь",
        type: "button",
        callback: (_event, _button, dlg) => extractSource(dlg)
      },
      {
        action: "install",
        label: "Установить",
        type: "button",
        default: true,
        callback: (_event, _button, dlg) => switchSource(dlg)
      },
      {
        action: "close",
        label: game.i18n.localize("FALLOUTMAW.Item.WeaponReloadFinish"),
        type: "button",
        callback: (_event, _button, dlg) => dlg.close()
      }
    ],
    position: { width: 560 }
  });

  dialog.addEventListener("render", () => {
    const element = dialog.element;
    if (!element || element.dataset.energyConsumptionDialogWatcher) return;
    element.dataset.energyConsumptionDialogWatcher = "1";
    element.addEventListener("click", async event => {
      const toggle = event.target?.closest?.("[data-energy-consumption-toggle]");
      if (toggle) {
        event.preventDefault();
        const freshItem = resolveActorItemOrInstalledModule(actor, item.id);
        await toggleEnergyConsumption(actor, freshItem, toggle.dataset.energyConsumptionToggle);
        refreshDialogContent(dialog);
        return;
      }
      const condition = event.target?.closest?.("[data-energy-consumption-condition]");
      if (condition) {
        event.preventDefault();
        selectedConditionId = String(condition.dataset.energyConsumptionCondition ?? "");
        refreshDialogContent(dialog);
        return;
      }
      const card = event.target?.closest?.("[data-energy-consumption-source-card]");
      if (!card) return;
      event.preventDefault();
      selectedSourceUuid = String(card.dataset.energyConsumptionSourceUuid ?? "");
      refreshDialogContent(dialog);
    });
  }, { once: true });

  await dialog.render({ force: true });
  return undefined;
}

async function processEnergyConsumptionWorldTime(_worldTime, deltaSeconds) {
  if (!game.user?.isGM) return;
  const seconds = Number(deltaSeconds) || 0;
  if (seconds <= 0) return;
  const actors = collectEnergyConsumptionActors();
  for (const actor of actors) await processActorEnergyConsumptionWorldTime(actor, seconds);
}

async function processActorEnergyConsumptionWorldTime(actor = null, deltaSeconds = 0) {
  let changed = false;
  const hours = Math.max(0, Number(deltaSeconds) || 0) / 3600;
  if (!actor || hours <= 0) return;

  for (const item of getActorItemsWithActiveHudModules(actor)) {
    if (!isActiveEnergyConsumptionCarrier(actor, item)) continue;
    const activeConditions = getEnergyConsumptionConditions(item).filter(condition => isEnergyConsumptionActive(item, condition.id));
    if (!activeConditions.length) continue;
    const consumed = await consumeEnergyConditions(actor, item, activeConditions, hours);
    changed = changed || consumed.changed;
  }

  if (changed) {
    Hooks.callAll("fallout-maw.energyConsumptionChanged", actor);
  }
}

async function consumeEnergyConditions(actor = null, item = null, conditions = [], hours = 0) {
  const activeConditions = Array.isArray(conditions) ? conditions : [];
  const changes = {};
  const validConditions = [];
  for (const condition of activeConditions) {
    if (canActivateEnergyConsumption(actor, item, condition)) {
      validConditions.push(condition);
    } else {
      changes[`system.functions.energyConsumer.activeConditions.${condition.id}`] = false;
    }
  }

  const costs = validConditions
    .map(condition => ({
      condition,
      amount: Math.max(0, Number(condition.amountPerHour) || 0) * Math.max(0, Number(hours) || 0)
    }))
    .filter(entry => entry.amount > 0);
  if (!costs.length) {
    const changed = Object.keys(changes).length > 0;
    if (changed) {
      const updated = await updateEnergyConsumptionCarrier(
        actor,
        item,
        changes,
        "energy-consumption-disable-invalid"
      );
      return { changed: updated };
    }
    return { changed };
  }

  const source = getActiveEnergySourceItem(actor, getEnergyConsumerFunction(item));
  const reserve = getEnergySourceReserveState(source);
  const cachedValue = getCachedEnergyConsumptionReserveValue(item, source, reserve.value);
  const plan = planContinuousResourceSpend({
    current: cachedValue,
    costs,
    allowPartial: true
  });
  const persistedNext = roundReserveValueForUpdate(plan.remaining);
  if (
    plan.remaining <= EPSILON
    || persistedNext !== roundReserveValueForUpdate(reserve.value)
  ) {
    changes["system.functions.energyConsumer.installedSource.reserve.value"] = persistedNext;
  }
  if (!plan.available || plan.remaining <= EPSILON) {
    for (const condition of activeConditions) {
      changes[`system.functions.energyConsumer.activeConditions.${condition.id}`] = false;
    }
  }

  const changed = Object.keys(changes).length > 0;
  if (changed) {
    const updated = await updateEnergyConsumptionCarrier(
      actor,
      item,
      changes,
      "energy-consumption-world-time"
    );
    if (!updated) return { changed: false };
  }
  rememberEnergyConsumptionReserveValue(item, source, plan.remaining);
  return { changed };
}

function getCachedEnergyConsumptionReserveValue(item = null, source = null, fallback = 0) {
  const key = getEnergyConsumptionReserveCacheKey(item, source);
  const persisted = Math.max(0, Number(fallback) || 0);
  if (!key || !energyConsumptionReserveCache.has(key)) return persisted;
  const cached = Math.max(0, Number(energyConsumptionReserveCache.get(key)) || 0);
  if (Math.abs(roundReserveValueForUpdate(cached) - roundReserveValueForUpdate(persisted)) > RESERVE_PERSISTENCE_STEP) return persisted;
  return cached;
}

function rememberEnergyConsumptionReserveValue(item = null, source = null, value = 0) {
  const key = getEnergyConsumptionReserveCacheKey(item, source);
  if (!key) return;
  energyConsumptionReserveCache.set(key, Math.max(0, Number(value) || 0));
}

function getEnergyConsumptionReserveCacheKey(item = null, source = null) {
  const itemKey = String(item?.uuid ?? item?.id ?? "").trim();
  const sourceKey = String(source?.uuid ?? source?.id ?? "").trim();
  return itemKey && sourceKey ? `${itemKey}:${sourceKey}:installedReserve` : "";
}

function roundReserveValueForUpdate(value = 0) {
  return Math.max(0, Math.round((Number(value) || 0) * 100) / 100);
}

async function disableInvalidEnergyConsumption(actor = null, item = null) {
  const changes = {};
  for (const condition of getEnergyConsumptionConditions(item)) {
    if (!isEnergyConsumptionActive(item, condition.id)) continue;
    if (canActivateEnergyConsumption(actor, item, condition)) continue;
    changes[`system.functions.energyConsumer.activeConditions.${condition.id}`] = false;
  }
  let changed = Object.keys(changes).length > 0;
  if (changed) {
    changed = await updateEnergyConsumptionCarrier(
      actor,
      item,
      changes,
      "energy-consumption-disable-invalid"
    );
  }
  if (changed) Hooks.callAll("fallout-maw.energyConsumptionChanged", actor);
}

async function updateEnergyConsumptionCarrier(actor = null, item = null, changes = {}, reason = "") {
  const update = createActorItemOrInstalledModuleUpdate(actor, item, changes);
  if (!update) return false;
  await executeInventoryMutation({
    actor,
    updates: [update]
  }, { reason });
  return true;
}

function renderEnergyConsumptionDialogContent({ actor = null, item = null, selectedConditionId = "", selectedSourceUuid = "" } = {}) {
  const consumer = getEnergyConsumerFunction(item);
  const sourceItems = getAvailableEnergySourceItems(actor, consumer);
  const activeSource = getActiveEnergySourceItem(actor, consumer);
  const conditions = getEnergyConsumptionConditions(item);
  return `
    <div class="fallout-maw-reload-dialog" data-energy-consumption-dialog-root>
      <div class="fallout-maw-reload-main">
        <div class="fallout-maw-reload-source-pane">
          <span>Потребление энергии</span>
          ${conditions.map(condition => renderEnergyConsumptionConditionCard(actor, item, condition, condition.id === selectedConditionId)).join("")}
        </div>
        <div class="fallout-maw-reload-source-pane">
          <span>${escapeHTML(game.i18n.localize("FALLOUTMAW.Item.LightSourceCurrentEnergySource"))}</span>
          ${renderInstalledEnergySourceCard(activeSource)}
        </div>
        <div class="fallout-maw-reload-source-pane">
          <span>${escapeHTML(game.i18n.localize("FALLOUTMAW.Item.LightSourceAvailableEnergySources"))}</span>
          <div class="fallout-maw-reload-source-list" data-energy-consumption-source-list>
            ${renderEnergySourceCards(sourceItems, selectedSourceUuid)}
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderEnergyConsumptionConditionCard(actor = null, item = null, condition = {}, selected = false) {
  const active = isEnergyConsumptionActive(item, condition.id);
  const disabled = !active && !canActivateEnergyConsumption(actor, item, condition);
  const label = active ? "Выключить" : "Включить";
  return `
    <button type="button" class="fallout-maw-reload-source-card ${selected ? "active" : ""}" data-energy-consumption-condition="${escapeAttribute(condition.id)}">
      <img src="${escapeAttribute(normalizeImagePath(item?.img, FALLBACK_ICON))}" alt="">
      <span>${escapeHTML(getEnergyConsumptionDisplayName(item, condition))}</span>
      <strong>${escapeHTML(formatNumberForDisplay(condition.amountPerHour))}/ч</strong>
    </button>
    <button type="button" class="fallout-maw-reload-source-card ${active ? "active" : ""}" data-energy-consumption-toggle="${escapeAttribute(condition.id)}" ${disabled ? "disabled" : ""}>
      <img src="${escapeAttribute(normalizeImagePath("icons/svg/light.svg", FALLBACK_ICON))}" alt="">
      <span>${escapeHTML(label)}</span>
    </button>
  `;
}

function renderInstalledEnergySourceCard(activeSource = null) {
  if (!activeSource) return `<div class="fallout-maw-token-hud-empty">Нет установленного источника энергии</div>`;
  const reserve = getEnergySourceReserveState(activeSource);
  const reserveLabel = reserve.max > 0 ? `${formatNumberForDisplay(reserve.value)} / ${formatNumberForDisplay(reserve.max)}` : formatNumberForDisplay(reserve.value);
  return `
    <div class="fallout-maw-reload-source-card fallout-maw-light-energy-card" data-energy-consumption-installed-source>
      <img src="${escapeAttribute(normalizeImagePath(activeSource.img, FALLBACK_ICON))}" alt="">
      <span>${escapeHTML(getEnergySourceDisplayName(activeSource))}</span>
      <strong>${escapeHTML(reserveLabel)}</strong>
    </div>
  `;
}

function renderEnergySourceCards(sourceItems = [], selectedSourceUuid = "") {
  if (!sourceItems.length) return `<div class="fallout-maw-token-hud-empty">Нет доступных источников энергии</div>`;
  return sourceItems.map(item => {
    const reserve = getEnergySourceReserveState(item);
    const reserveLabel = reserve.max > 0 ? `${formatNumberForDisplay(reserve.value)} / ${formatNumberForDisplay(reserve.max)}` : formatNumberForDisplay(reserve.value);
    const selected = item.uuid === selectedSourceUuid;
    return `
      <div
        class="fallout-maw-reload-source-card fallout-maw-light-energy-card ${selected ? "active" : ""}"
        data-energy-consumption-source-card
        data-energy-consumption-source-uuid="${escapeAttribute(item.uuid)}"
        title="${escapeAttribute(getEnergySourceDisplayName(item))}">
        <img src="${escapeAttribute(normalizeImagePath(item.img, FALLBACK_ICON))}" alt="">
        <span>${escapeHTML(getEnergySourceDisplayName(item))}</span>
        <strong>${escapeHTML(reserveLabel)}</strong>
      </div>
    `;
  }).join("");
}

function isActiveEnergyConsumptionCarrier(actor = null, item = null, { activeItemIds = null } = {}) {
  if (!actor || item?.type !== "gear") return false;
  if (!hasItemFunction(item, ITEM_FUNCTIONS.energyConsumer, { ignoreBroken: true })) return false;
  if (!hasItemFunction(item, ITEM_FUNCTIONS.freeSettings, { ignoreBroken: true })) return false;
  const mode = String(item.system?.placement?.mode ?? "");
  if (mode === "module") {
    if (activeItemIds instanceof Set) return activeItemIds.has(String(item.id ?? ""));
    return getActorItemsWithActiveHudModules(actor).some(candidate => candidate.id === item.id);
  }
  return Boolean(item.system?.equipped) || ["equipment", "weapon", "constructPart"].includes(mode);
}

function collectEnergyConsumptionActors() {
  const actors = new Map();
  for (const actor of game.actors ?? []) {
    if (["character", "construct"].includes(actor?.type)) actors.set(actor.uuid, actor);
  }
  for (const token of canvas?.tokens?.placeables ?? []) {
    const actor = token?.actor;
    if (["character", "construct"].includes(actor?.type)) actors.set(actor.uuid, actor);
  }
  return Array.from(actors.values());
}

function formatNumberForDisplay(value) {
  const number = Number(value) || 0;
  return Number.isInteger(number) ? String(number) : number.toFixed(2).replace(/\.?0+$/, "");
}

function escapeAttribute(value) {
  return escapeHTML(value).replace(/`/g, "&#096;");
}
