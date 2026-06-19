import { SYSTEM_ID } from "../constants.mjs";
import { ABILITY_CONDITION_TYPES, ABILITY_FUNCTION_TYPES, normalizeAbilityFunctions } from "../settings/abilities.mjs";
import { registerQueuedWorldTimeProcessor } from "../time/world-time-queue.mjs";
import { FALLBACK_ICON, escapeHTML, normalizeImagePath } from "../utils/actor-display-data.mjs";
import { getActorItemsWithActiveHudModules } from "../utils/hud-active-items.mjs";
import {
  ITEM_FUNCTIONS,
  getEnergyConsumerFunction,
  hasItemFunction,
  isItemBrokenByCondition,
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

const { DialogV2 } = foundry.applications.api;
const EPSILON = 0.000001;

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
  if (!item || !hasItemFunction(item, ITEM_FUNCTIONS.energyConsumer, { ignoreBroken: true })) return [];
  const seen = new Set();
  const conditions = [];
  for (const entry of normalizeAbilityFunctions(item.system?.functions?.freeSettings?.entries ?? [])) {
    if (entry.type !== ABILITY_FUNCTION_TYPES.effectChanges) continue;
    for (const condition of entry.conditions ?? []) {
      if (condition?.type !== ABILITY_CONDITION_TYPES.energyConsumption) continue;
      const id = String(condition?.id ?? "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      conditions.push(normalizeEnergyConsumptionCondition(condition, item));
    }
  }
  return conditions;
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
  return getActorItemsWithActiveHudModules(actor, options)
    .filter(item => isActiveEnergyConsumptionCarrier(actor, item, options))
    .flatMap(item => getEnergyConsumptionConditions(item).map(condition => {
      const active = isEnergyConsumptionActive(item, condition.id);
      return {
        id: `energyConsumption:${item.id}:${condition.id}`,
        itemId: item.id,
        conditionId: condition.id,
        name: getEnergyConsumptionDisplayName(item, condition),
        img: normalizeImagePath(item.img, FALLBACK_ICON),
        active,
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
  const key = String(conditionId ?? "").trim();
  if (!key) return false;
  return Boolean(getEnergyConsumerFunction(item)?.activeConditions?.[key]);
}

export async function toggleEnergyConsumption(actor = null, item = null, conditionId = "") {
  return setEnergyConsumptionActive(actor, item, conditionId, !isEnergyConsumptionActive(item, conditionId));
}

export async function setEnergyConsumptionActive(actor = null, item = null, conditionId = "", active = false) {
  const key = String(conditionId ?? "").trim();
  if (!actor || !item?.update || !key) return false;
  const condition = getEnergyConsumptionConditions(item).find(entry => entry.id === key);
  if (!condition) return false;
  if (active && !canActivateEnergyConsumption(actor, item, condition)) {
    ui.notifications?.warn?.("Нет подходящего источника энергии.");
    return false;
  }
  await item.update({ [`system.functions.energyConsumer.activeConditions.${key}`]: Boolean(active) });
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
    await application?.render({ force: true });
  };

  const extractSource = async dialog => {
    const freshItem = resolveActorItemOrInstalledModule(actor, item.id);
    if (!freshItem) return;
    const extracted = await extractEnergyConsumerSource(actor, freshItem);
    if (!extracted) ui.notifications?.warn?.("Нет установленного источника энергии.");
    await disableInvalidEnergyConsumption(actor, freshItem);
    refreshDialogContent(dialog);
    await application?.render({ force: true });
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
        await application?.render({ force: true });
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
    for (const condition of activeConditions) {
      const amount = Math.max(0, Number(condition.amountPerHour) || 0) * hours;
      if (amount <= 0) continue;
      const consumed = await consumeEnergyCondition(actor, item, condition, amount);
      changed = changed || consumed.changed;
    }
  }

  if (changed) {
    Hooks.callAll("fallout-maw.energyConsumptionChanged", actor);
  }
}

async function consumeEnergyCondition(actor = null, item = null, condition = {}, amount = 0) {
  if (!canActivateEnergyConsumption(actor, item, condition)) {
    await setEnergyConsumptionActive(actor, item, condition.id, false);
    return { changed: true };
  }
  const source = getActiveEnergySourceItem(actor, getEnergyConsumerFunction(item));
  const reserve = getEnergySourceReserveState(source);
  const spend = Math.min(reserve.value, amount);
  const next = Math.max(0, reserve.value - spend);
  await item.update({ "system.functions.energyConsumer.installedSource.reserve.value": next });
  if (reserve.value + EPSILON < amount || next <= EPSILON) {
    await setEnergyConsumptionActive(actor, item, condition.id, false);
  }
  return { changed: true };
}

async function disableInvalidEnergyConsumption(actor = null, item = null) {
  let changed = false;
  for (const condition of getEnergyConsumptionConditions(item)) {
    if (!isEnergyConsumptionActive(item, condition.id)) continue;
    if (canActivateEnergyConsumption(actor, item, condition)) continue;
    await setEnergyConsumptionActive(actor, item, condition.id, false);
    changed = true;
  }
  if (changed) Hooks.callAll("fallout-maw.energyConsumptionChanged", actor);
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

function normalizeEnergyConsumptionCondition(condition = {}, item = null) {
  return {
    id: String(condition?.id ?? "").trim(),
    name: String(condition?.name ?? "").trim() || item?.name || "Потребление энергии",
    amountPerHour: Math.max(0, Number(condition?.amountPerHour) || 0)
  };
}

function isActiveEnergyConsumptionCarrier(actor = null, item = null) {
  if (!actor || item?.type !== "gear") return false;
  if (!hasItemFunction(item, ITEM_FUNCTIONS.energyConsumer, { ignoreBroken: true })) return false;
  if (!hasItemFunction(item, ITEM_FUNCTIONS.freeSettings, { ignoreBroken: true })) return false;
  const mode = String(item.system?.placement?.mode ?? "");
  if (mode === "module") {
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
