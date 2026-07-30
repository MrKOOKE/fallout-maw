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
  getWeaponFunction,
  hasItemFunction,
  isItemBrokenByCondition,
  createActorItemOrInstalledModuleUpdate,
  resolveActorItemOrInstalledModule
} from "../utils/item-functions.mjs";
import { changedDataIntersectsPaths } from "../utils/document-change-paths.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { getWeaponModuleSlotItemData } from "../utils/weapon-modules.mjs";
import { resolveWorldItemSync } from "../utils/world-items.mjs";
import { planActorInventoryGrant } from "../utils/inventory-grants.mjs";
import {
  createItemStackPartRemovalUpdate,
  getItemQuantity,
  usesVirtualInventoryStacks
} from "../utils/inventory-containers.mjs";
import { withSystemEventRoot } from "../events/dispatcher.mjs";
import { runTerminalSystemEventWorkflow } from "../utils/system-event-workflow.mjs";
import { executeInventoryMutation } from "../inventory/mutation.mjs";
import {
  planContinuousResourceSpend,
  planIntegerResourceSpend
} from "../inventory/resource-spend.mjs";

const ACTIVE_LIGHT_SOURCES_FLAG = "activeLightSources";
const BASE_LIGHT_FLAG = "lightSourceBaseLight";
const RESOURCE_REMAINDERS_FLAG = "lightSourceResourceRemainders";
const ENERGY_SOURCE_PROTOTYPE_FLAG = "energySourcePrototypeUuid";
const EPSILON = 0.000001;
const RESERVE_PERSISTENCE_STEP = 0.01;
const LIGHT_SOURCE_BEFORE_SIGNATURES_OPTION = "falloutMawLightSourceBeforeSignatures";
const LIGHT_SOURCE_ITEM_RUNTIME_PATHS = Object.freeze([
  "system.functions.lightSource",
  "system.functions.energyConsumer",
  "system.functions.condition.enabled",
  "system.functions.condition.value",
  "system.functions.condition.max",
  "system.functions.weapon.moduleSlots",
  "system.functions.weapon.enabled",
  "system.equipped",
  "system.placement",
  "system.occupiedSlots"
]);
const LIGHT_SOURCE_CARRIER_REMOVAL_PATHS = Object.freeze([
  "system.functions.lightSource",
  "system.functions.weapon.moduleSlots"
]);
const lightSourceResourceRemainderCache = new Map();
const lightSourceEnergyReserveCache = new Map();
const tokenLightSourceOperationTails = new Map();
const actorLightSourceSyncQueue = createActorLightSourceSyncQueue();

export function registerLightSourceHooks() {
  registerQueuedWorldTimeProcessor(processLightSourceWorldTime, { priority: -20 });
  Hooks.on("preUpdateItem", (item, changes, options = {}) => {
    if (!item?.parent || !lightSourceItemChangesRuntimeState(changes)) return;
    captureLightSourceItemBeforeSignature(item, options);
  });
  Hooks.on("createItem", item => {
    if (!item?.parent || !isLightSourceCarrierItem(item)) return;
    scheduleActorLightSourceTokenSync(item.parent);
  });
  Hooks.on("updateItem", (item, changes, options = {}) => {
    if (!item?.parent) return;
    if (!isLightSourceItemUpdateRelevant(item, changes, options)) return;
    invalidateChangedLightSourceCaches(item, changes);
    scheduleActorLightSourceTokenSync(item.parent);
  });
  Hooks.on("deleteItem", item => {
    if (!item?.parent) return;
    clearLightSourceCachesForItem(item, { includeInstalledModules: true });
    if (!isLightSourceCarrierItem(item)) return;
    scheduleActorLightSourceTokenSync(item.parent);
  });
  Hooks.on("deleteActor", actor => {
    clearLightSourceCachesForActor(actor);
  });
  Hooks.on("canvasReady", () => {
    if (!isAutomaticLightSourceSyncAuthority()) return;
    void syncSceneLightSources(canvas?.scene).catch(error => {
      console.error("Fallout MaW | Scene light source reconciliation failed", error);
    });
  });
}

export function isLightSourceItemUpdateRelevant(item = null, changes = {}, options = {}) {
  if (!lightSourceItemChangesRuntimeState(changes)) return false;
  const after = createLightSourceItemRuntimeSignature(item);
  const before = getLightSourceItemBeforeSignature(item, options);
  if (before !== undefined) return before !== after;
  if (after) return true;
  return changedDataIntersectsPaths(changes, LIGHT_SOURCE_CARRIER_REMOVAL_PATHS);
}

function lightSourceItemChangesRuntimeState(changes = {}) {
  return changedDataIntersectsPaths(changes, LIGHT_SOURCE_ITEM_RUNTIME_PATHS);
}

function captureLightSourceItemBeforeSignature(item = null, options = {}) {
  if (!item || !options || typeof options !== "object") return;
  const signatures = options[LIGHT_SOURCE_BEFORE_SIGNATURES_OPTION] ?? {};
  signatures[getDocumentCacheKey(item)] = createLightSourceItemRuntimeSignature(item);
  options[LIGHT_SOURCE_BEFORE_SIGNATURES_OPTION] = signatures;
}

function getLightSourceItemBeforeSignature(item = null, options = {}) {
  const signatures = options?.[LIGHT_SOURCE_BEFORE_SIGNATURES_OPTION];
  if (!signatures || typeof signatures !== "object") return undefined;
  const key = getDocumentCacheKey(item);
  return Object.hasOwn(signatures, key) ? signatures[key] : undefined;
}

function isLightSourceCarrierItem(item = null) {
  return Boolean(createLightSourceItemRuntimeSignature(item));
}

export function createLightSourceItemRuntimeSignature(item = null) {
  if (!item?.system) return "";
  const carriers = [];
  const direct = createLightSourceCarrierRuntimeState(item, {
    identity: `item:${String(item.id ?? item._id ?? "")}`,
    available: true
  });
  if (direct) carriers.push(direct);

  const hostAvailable = isRuntimeInstalledModuleHost(item);
  const slots = Array.isArray(getWeaponFunction(item)?.moduleSlots)
    ? getWeaponFunction(item).moduleSlots
    : [];
  slots.forEach((slot, index) => {
    const moduleData = getWeaponModuleSlotItemData(slot);
    if (!moduleData?.system) return;
    const slotId = String(slot?.id ?? "") || `slot-${index + 1}`;
    const state = createLightSourceCarrierRuntimeState(moduleData, {
      identity: `module:${slotId}`,
      available: hostAvailable && hasItemFunction(moduleData, ITEM_FUNCTIONS.module)
    });
    if (state) carriers.push(state);
  });
  if (!carriers.length) return "";
  carriers.sort((left, right) => left.identity.localeCompare(right.identity));
  return JSON.stringify(carriers);
}

function createLightSourceCarrierRuntimeState(itemOrData = null, { identity = "", available = true } = {}) {
  if (!hasItemFunction(itemOrData, ITEM_FUNCTIONS.lightSource, { ignoreBroken: true })) return null;
  const light = getLightSourceFunction(itemOrData);
  const activatable = Boolean(available && canActivateLightSource(itemOrData));
  return {
    identity,
    available: activatable,
    light: activatable ? {
      enabled: light?.enabled === true,
      dim: Math.max(0, Number(light?.dim) || 0),
      bright: Math.max(0, Number(light?.bright) || 0),
      angle: Math.max(0, Math.min(360, Number(light?.angle) || 360)),
      color: String(light?.color ?? "").trim() || null
    } : null
  };
}

function isRuntimeInstalledModuleHost(item = null) {
  if (!hasItemFunction(item, ITEM_FUNCTIONS.weapon)) return false;
  const mode = String(item.system?.placement?.mode ?? "").trim();
  return Boolean(item.system?.equipped)
    || ["equipment", "weapon", "constructPart"].includes(mode)
    || Object.values(item.system?.occupiedSlots ?? {}).some(Boolean);
}

export function createActorLightSourceSyncQueue({
  syncActor = syncActorLightSourceTokens,
  resolveActor = resolveCurrentLightSourceActor,
  onError = error => console.error("Fallout MaW | Actor light source reconciliation failed", error)
} = {}) {
  const states = new Map();
  return {
    enqueue(actor = null, eventOptions = {}) {
      const key = getDocumentCacheKey(actor);
      if (!key) return Promise.resolve(false);
      const pending = states.get(key);
      if (pending) {
        pending.actor = actor;
        pending.eventOptions = { ...pending.eventOptions, ...eventOptions };
        pending.dirty = true;
        return pending.promise;
      }

      const state = {
        actor,
        eventOptions: { ...eventOptions },
        dirty: true,
        promise: null
      };
      states.set(key, state);
      state.promise = Promise.resolve()
        .then(async () => {
          while (state.dirty) {
            state.dirty = false;
            const freshActor = resolveActor(state.actor);
            if (!freshActor) continue;
            state.actor = freshActor;
            await syncActor(freshActor, state.eventOptions);
          }
          return true;
        })
        .catch(error => {
          try {
            onError?.(error);
          } catch {
            // Error reporting must not poison later reconciliations.
          }
          return false;
        })
        .finally(() => {
          if (states.get(key) === state) states.delete(key);
        });
      return state.promise;
    },
    get pendingCount() {
      return states.size;
    }
  };
}

export function queueActorLightSourceTokenSync(actor = null, eventOptions = {}) {
  return actorLightSourceSyncQueue.enqueue(actor, eventOptions);
}

function scheduleActorLightSourceTokenSync(actor = null, eventOptions = {}) {
  if (!actor || !isAutomaticLightSourceSyncAuthority()) return;
  void queueActorLightSourceTokenSync(actor, eventOptions);
}

function resolveCurrentLightSourceActor(actor = null) {
  const uuid = String(actor?.uuid ?? "").trim();
  if (!uuid || typeof globalThis.fromUuidSync !== "function") return actor;
  return globalThis.fromUuidSync(uuid);
}

function runTokenLightSourceOperation(tokenOrDocument = null, operation) {
  const tokenDocument = getTokenDocument(tokenOrDocument);
  if (!tokenDocument || typeof operation !== "function") return Promise.resolve(false);
  const key = getDocumentCacheKey(tokenDocument)
    || `${getDocumentCacheKey(tokenDocument.parent)}.Token.${String(tokenDocument.id ?? "")}`;
  const previous = tokenLightSourceOperationTails.get(key) ?? Promise.resolve();
  const result = previous
    .catch(() => undefined)
    .then(() => operation(resolveCurrentLightSourceToken(tokenDocument)));
  const tail = result
    .catch(() => undefined)
    .finally(() => {
      if (tokenLightSourceOperationTails.get(key) === tail) {
        tokenLightSourceOperationTails.delete(key);
      }
    });
  tokenLightSourceOperationTails.set(key, tail);
  return result;
}

function resolveCurrentLightSourceToken(tokenDocument = null) {
  const uuid = String(tokenDocument?.uuid ?? "").trim();
  if (!uuid || typeof globalThis.fromUuidSync !== "function") return tokenDocument;
  return globalThis.fromUuidSync(uuid);
}

function isAutomaticLightSourceSyncAuthority() {
  const activeGMId = String(globalThis.game?.users?.activeGM?.id ?? "").trim();
  const currentUserId = String(globalThis.game?.user?.id ?? "").trim();
  if (activeGMId) return activeGMId === currentUserId;
  return Boolean(globalThis.game?.user?.isActiveGM || globalThis.game?.user?.isGM);
}

function invalidateChangedLightSourceCaches(item = null, changes = {}) {
  if (changedDataIntersectsPaths(changes, ["system.functions.weapon.moduleSlots"])) {
    clearCacheEntriesWithPrefix(lightSourceResourceRemainderCache, `${getDocumentCacheKey(item)}.Module.`);
    clearCacheEntriesWithPrefix(lightSourceEnergyReserveCache, `${getDocumentCacheKey(item)}.Module.`);
  }
  if (changedDataIntersectsPaths(changes, [
    "system.functions.energyConsumer.installedSource.sourceItemUuid"
  ])) {
    clearCacheEntriesWithPrefix(lightSourceEnergyReserveCache, `${getDocumentCacheKey(item)}:`);
  }
}

function clearLightSourceCachesForItem(item = null, { includeInstalledModules = false } = {}) {
  const key = getDocumentCacheKey(item);
  if (!key) return;
  lightSourceResourceRemainderCache.delete(key);
  clearCacheEntriesWithPrefix(lightSourceEnergyReserveCache, `${key}:`);
  if (!includeInstalledModules) return;
  clearCacheEntriesWithPrefix(lightSourceResourceRemainderCache, `${key}.Module.`);
  clearCacheEntriesWithPrefix(lightSourceEnergyReserveCache, `${key}.Module.`);
}

function clearLightSourceCachesForActor(actor = null) {
  const key = getDocumentCacheKey(actor);
  if (!key) return;
  clearCacheEntriesWithPrefix(lightSourceResourceRemainderCache, `${key}.`);
  clearCacheEntriesWithPrefix(lightSourceEnergyReserveCache, `${key}.`);
}

function clearCacheEntriesWithPrefix(cache, prefix = "") {
  if (!prefix) return;
  for (const key of cache.keys()) {
    if (String(key).startsWith(prefix)) cache.delete(key);
  }
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

export function itemManagesEnergySources(item = null) {
  return hasItemFunction(item, ITEM_FUNCTIONS.energyConsumer, { ignoreBroken: true });
}

export async function openLightSourceEnergyDialog(options = {}) {
  return openEnergyConsumerSourceDialog(options);
}

export async function openEnergyConsumerSourceDialog({ actor = null, token = null, item = null, application = null, showToggle = false } = {}) {
  if (!actor?.isOwner || !item) return undefined;
  const { DialogV2 } = foundry.applications.api;
  const hasLight = hasItemFunction(item, ITEM_FUNCTIONS.lightSource, { ignoreBroken: true });
  const managesEnergy = itemManagesEnergySources(item);
  if (!hasLight && !managesEnergy) return undefined;
  const canShowToggle = Boolean(showToggle) && hasLight;
  const consumer = getEnergyConsumerFunction(item);
  const sourceItems = managesEnergy ? getAvailableEnergySourceItems(actor, consumer) : [];
  let selectedSourceUuid = "";
  const renderContent = () => renderLightSourceEnergyDialogContent({
    actor,
    token,
    item: resolveActorItemOrInstalledModule(actor, item.id) ?? item,
    showToggle: canShowToggle,
    managesEnergy,
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
    if (hasLight) await syncTokenLightSources(token?.document ?? token);
    refreshDialogContent(dialog);
  };
  const extractSource = async dialog => {
    const freshItem = resolveActorItemOrInstalledModule(actor, item.id);
    if (!freshItem) return;
    const extracted = await extractEnergyConsumerSource(actor, freshItem);
    if (!extracted) ui.notifications?.warn?.(game.i18n.localize("FALLOUTMAW.Item.LightSourceNoEnergySource"));
    if (hasLight) await syncTokenLightSources(token?.document ?? token);
    refreshDialogContent(dialog);
  };
  const toggleFromDialog = async dialog => {
    const freshItem = resolveActorItemOrInstalledModule(actor, item.id);
    if (!freshItem || !hasLight) return;
    await toggleLightSource(token?.document ?? token, freshItem);
    refreshDialogContent(dialog);
  };

  if (managesEnergy && !sourceItems.length && !getActiveEnergySourceItem(actor, consumer)) {
    ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Item.LightSourceNoAvailableEnergySources"));
  }

  const dialog = new DialogV2({
    window: {
      title: hasLight ? getLightSourceDisplayName(item) : (item.name || game.i18n.localize("FALLOUTMAW.Item.FunctionEnergyConsumer"))
    },
    content: `<form class="fallout-maw-reload-dialog-form">${renderContent()}</form>`,
    form: {
      closeOnSubmit: false
    },
    buttons: managesEnergy ? [
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

export async function toggleLightSource(tokenOrDocument = null, item = null, eventOptions = {}) {
  const tokenDocument = getTokenDocument(tokenOrDocument);
  if (!tokenDocument) return false;
  return runTokenLightSourceOperation(tokenDocument, freshToken => {
    const freshItem = resolveActorItemOrInstalledModule(freshToken?.actor, item?.id);
    if (!freshItem) return false;
    return setLightSourceActiveOperation(
      freshToken,
      freshItem,
      !isLightSourceActive(freshToken, freshItem),
      eventOptions
    );
  });
}

export async function setLightSourceActive(tokenOrDocument = null, item = null, active = false, eventOptions = {}) {
  const tokenDocument = getTokenDocument(tokenOrDocument);
  if (!tokenDocument) return false;
  return runTokenLightSourceOperation(tokenDocument, freshToken => {
    const freshItem = resolveActorItemOrInstalledModule(freshToken?.actor, item?.id);
    if (!freshItem) return false;
    return setLightSourceActiveOperation(freshToken, freshItem, active, eventOptions);
  });
}

async function setLightSourceActiveOperation(tokenDocument = null, item = null, active = false, eventOptions = {}) {
  if (!tokenDocument || !item?.id || !hasItemFunction(item, ITEM_FUNCTIONS.lightSource)) return false;
  if (active && !canActivateLightSource(item)) {
    ui.notifications?.warn?.(game.i18n.localize("FALLOUTMAW.Item.LightSourceNoEnergySource"));
    return false;
  }
  const actor = tokenDocument.actor ?? item.actor ?? null;
  const chainRef = eventOptions?.falloutMawSystemEventChainRef
    ?? eventOptions?.chainRef
    ?? eventOptions?.source?.chainRef
    ?? null;
  const operationId = String(eventOptions?.operationId ?? "").trim() || foundry.utils.randomID();
  const occurrenceId = String(eventOptions?.occurrenceId ?? "").trim() || foundry.utils.randomID();
  const participants = {
    source: createLightSourceParticipant(actor, tokenDocument, item),
    target: createLightSourceParticipant(actor, tokenDocument),
    related: []
  };

  return withSystemEventRoot({
    kind: "lightSourceUse",
    operationId: `light-source:${operationId}`,
    sceneUuid: String(tokenDocument.parent?.uuid ?? canvas?.scene?.uuid ?? ""),
    combatUuid: String(game.combat?.uuid ?? ""),
    chainRef
  }, async scope => {
    const beforeActive = isLightSourceActive(tokenDocument, item);
    const occurrenceBase = `item-use:${scope.rootId}:${occurrenceId}:${item.uuid ?? item.id}:lightSource`;
    const workflow = await runTerminalSystemEventWorkflow({
      scope,
      beforeEventKey: "fallout-maw.item.use.before",
      resolvedEventKey: "fallout-maw.item.use.resolved",
      occurrenceBase,
      participants,
      beforeData: buildLightSourceUseEventData(actor, item, beforeActive, active),
      resolvedData: ({ status }) => ({
        ...buildLightSourceUseEventData(actor, item, beforeActive, active),
        status
      }),
      operation: async () => {
        await setLightSourceActiveNow(tokenDocument, item, active, scope.chainRef);
        await scope.emit("fallout-maw.item.lightSource.changed", {
          data: buildLightSourceUseEventData(actor, item, beforeActive, active),
          before: { active: beforeActive },
          after: { active: Boolean(active) },
          delta: { active: Number(Boolean(active)) - Number(beforeActive) },
          outcome: { success: true },
          reason: "changed"
        }, {
          occurrenceKey: `${occurrenceBase}:light-source:changed`,
          participants
        });
        return true;
      }
    });
    if (!workflow.success) return false;
    if (active) {
      Hooks.callAll("fallout-maw.itemUsed", {
        actor,
        token: tokenDocument,
        targetActor: actor,
        targetToken: tokenDocument,
        item,
        action: "lightSource",
        active: true,
        chainRef: scope.chainRef,
        source: { chainRef: scope.chainRef },
        falloutMawSemanticMirror: true
      });
    }
    return true;
  });
}

async function setLightSourceActiveNow(tokenDocument, item, active = false, chainRef = null) {
  let entries = getActiveLightSourceEntries(tokenDocument).filter(entry => entry.itemId !== item.id);
  let baseLight;
  if (active) {
    if (!entries.length && !tokenDocument.getFlag(SYSTEM_ID, BASE_LIGHT_FLAG)) {
      baseLight = getTokenLightObject(tokenDocument);
    }
    entries.push({ itemId: item.id });
  }
  entries = normalizeActiveLightSourceEntries(entries);
  await syncTokenLightSourcesNow(
    tokenDocument,
    createLightSourceDocumentOptions(chainRef),
    {
      entries,
      ...(baseLight ? { baseLight } : {})
    }
  );
  tokenDocument.actor?.render(false, {
    renderContext: "fallout-maw.lightSourceState",
    renderData: { itemId: item.id, active: Boolean(active), tokenId: tokenDocument.id }
  });
  return true;
}

function buildLightSourceUseEventData(actor, item, beforeActive, active) {
  return {
    action: "lightSource",
    sourceActorUuid: String(actor?.uuid ?? ""),
    targetActorUuid: String(actor?.uuid ?? ""),
    active: Boolean(active),
    previousActive: Boolean(beforeActive),
    item: {
      uuid: String(item?.uuid ?? ""),
      id: String(item?.id ?? ""),
      name: String(item?.name ?? ""),
      type: String(item?.type ?? ""),
      itemCategory: String(item?.system?.itemCategory ?? "")
    }
  };
}

function createLightSourceParticipant(actor = null, token = null, item = null) {
  const tokenDocument = token?.document ?? token;
  const participant = {
    actorUuid: String(actor?.uuid ?? tokenDocument?.actor?.uuid ?? "").trim(),
    tokenUuid: String(tokenDocument?.uuid ?? "").trim(),
    itemUuid: String(item?.uuid ?? "").trim()
  };
  return Object.values(participant).some(Boolean) ? participant : null;
}

function createLightSourceDocumentOptions(chainRef = null) {
  return chainRef
    ? { chainRef, falloutMawSystemEventChainRef: chainRef }
    : {};
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

function renderLightSourceEnergyDialogContent({ actor = null, token = null, item = null, showToggle = false, managesEnergy = false, selectedSourceUuid = "" } = {}) {
  const tokenDocument = token?.document ?? token ?? null;
  const active = isLightSourceActive(tokenDocument, item);
  const toggleDisabled = !tokenDocument || (!active && !canActivateLightSource(item));
  const consumer = getEnergyConsumerFunction(item);
  const sourceItems = managesEnergy ? getAvailableEnergySourceItems(actor, consumer) : [];
  const activeSource = managesEnergy ? getActiveEnergySourceItem(actor, consumer) : null;
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
        ${managesEnergy ? `
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
  const changes = {
    "system.functions.energyConsumer.installedSource": createInstalledEnergySourceData(sourceItem)
  };
  const actor = consumerItem.actor
    ?? (consumerItem.parent?.documentName === "Actor" ? consumerItem.parent : null);
  const update = createActorItemOrInstalledModuleUpdate(actor, consumerItem, changes);
  if (actor && update) {
    await executeInventoryMutation({
      actor,
      updates: [update]
    }, { reason: "energy-source-select" });
  } else {
    await consumerItem.update(changes);
  }
  return true;
}

export async function installEnergyConsumerSource(actor = null, consumerItem = null, sourceItem = null) {
  if (!actor?.createEmbeddedDocuments || !consumerItem?.update || !sourceItem) return false;
  if (!hasItemFunction(consumerItem, ITEM_FUNCTIONS.energyConsumer, { ignoreBroken: true })) return false;
  if (!hasItemFunction(sourceItem, ITEM_FUNCTIONS.energySource, { ignoreBroken: true })) return false;
  const consumer = getEnergyConsumerFunction(consumerItem);
  if (!energySourceMatchesConsumer(sourceItem, consumer)) return false;
  if (sourceItem.parent === actor && sourceItem.id === consumerItem.id) return false;

  const returnedData = createEnergySourceItemDataFromInstalled(consumer.installedSource);
  const deleteSourceId = sourceItem.parent === actor ? sourceItem.id : "";
  const returnPlan = returnedData
    ? planActorInventoryGrant(actor, returnedData, { quantity: 1, merge: false })
    : { updates: [], creates: [] };
  const consumerUpdate = createActorItemOrInstalledModuleUpdate(actor, consumerItem, {
    "system.functions.energyConsumer.installedSource": createInstalledEnergySourceData(sourceItem)
  });
  if (!consumerUpdate) return false;

  const updates = [...returnPlan.updates, consumerUpdate];
  const deletes = [];
  if (deleteSourceId && actor.items?.get(deleteSourceId)) {
    const sourceQuantity = getItemQuantity(sourceItem);
    if (sourceQuantity <= 1) deletes.push(deleteSourceId);
    else if (usesVirtualInventoryStacks(sourceItem)) {
      const update = createItemStackPartRemovalUpdate(sourceItem, 1, 0);
      if (!update || (update["system.quantity"] ?? 0) <= 0) deletes.push(deleteSourceId);
      else updates.push(update);
    } else {
      updates.push({ _id: deleteSourceId, "system.quantity": sourceQuantity - 1 });
    }
  }
  await executeInventoryMutation({
    actor,
    updates,
    deletes,
    creates: returnPlan.creates
  }, { reason: "energy-source-install" });
  return true;
}

export async function extractEnergyConsumerSource(actor = null, consumerItem = null) {
  if (!actor?.createEmbeddedDocuments || !consumerItem?.update) return false;
  if (!hasItemFunction(consumerItem, ITEM_FUNCTIONS.energyConsumer, { ignoreBroken: true })) return false;
  const returnedData = createEnergySourceItemDataFromInstalled(getEnergyConsumerFunction(consumerItem).installedSource);
  if (!returnedData) return false;
  const returnPlan = planActorInventoryGrant(actor, returnedData, { quantity: 1 });
  const consumerUpdate = createActorItemOrInstalledModuleUpdate(actor, consumerItem, {
    "system.functions.energyConsumer.installedSource": createInstalledEnergySourceData(null)
  });
  if (!consumerUpdate) return false;
  await executeInventoryMutation({
    actor,
    updates: [...returnPlan.updates, consumerUpdate],
    creates: returnPlan.creates
  }, { reason: "energy-source-extract" });
  return true;
}

export async function syncTokenLightSources(tokenOrDocument = null, eventOptions = {}) {
  const tokenDocument = getTokenDocument(tokenOrDocument);
  if (!tokenDocument) return false;
  return runTokenLightSourceOperation(
    tokenDocument,
    freshToken => syncTokenLightSourcesNow(freshToken, eventOptions)
  );
}

async function syncTokenLightSourcesNow(tokenOrDocument = null, eventOptions = {}, state = {}) {
  const tokenDocument = getTokenDocument(tokenOrDocument);
  const actor = tokenDocument?.actor;
  if (!tokenDocument || !actor) return false;

  const existingEntries = getActiveLightSourceEntries(tokenDocument);
  const entries = Object.hasOwn(state, "entries")
    ? normalizeActiveLightSourceEntries(state.entries)
    : existingEntries;
  const storedBase = tokenDocument.getFlag(SYSTEM_ID, BASE_LIGHT_FLAG);
  const hasStoredBase = storedBase !== undefined && storedBase !== null;
  const hasBaseOverride = Object.hasOwn(state, "baseLight");
  const base = hasBaseOverride ? state.baseLight : storedBase;
  // A Token which has never participated in this runtime has no light state
  // for us to reconcile. Besides avoiding a needless Document update, this
  // preserves manually configured Token light instead of zeroing it.
  if (!entries.length && !hasStoredBase && !hasBaseOverride) return false;

  const actorItems = resolveActiveLightSourceItems(actor, entries);
  const activeSources = [];
  for (const entry of entries) {
    const item = actorItems.get(entry.itemId);
    if (!item || !hasItemFunction(item, ITEM_FUNCTIONS.lightSource) || isItemBrokenByCondition(item)) continue;
    if (!canActivateLightSource(item)) continue;
    activeSources.push({ item, light: getLightSourceFunction(item) });
  }

  const normalizedEntries = activeSources.map(source => ({ itemId: String(source.item.id) }));
  const update = {};
  if (!activeLightSourceEntriesEqual(existingEntries, normalizedEntries)) {
    update[`flags.${SYSTEM_ID}.${ACTIVE_LIGHT_SOURCES_FLAG}`] = normalizedEntries.length
      ? normalizedEntries
      : globalThis._del;
  }

  const selected = [...activeSources].sort(compareLightSourcesForToken).at(0) ?? null;
  if (selected) {
    if (hasBaseOverride && !hasStoredBase) {
      update[`flags.${SYSTEM_ID}.${BASE_LIGHT_FLAG}`] = foundry.utils.deepClone(base ?? {});
    }
    Object.assign(update, createTokenLightDelta(tokenDocument, selected.light));
  } else {
    Object.assign(
      update,
      createTokenLightDelta(tokenDocument, base ?? { dim: 0, bright: 0, angle: 360, color: null })
    );
    if (hasStoredBase) update[`flags.${SYSTEM_ID}.${BASE_LIGHT_FLAG}`] = globalThis._del;
  }

  if (!Object.keys(update).length) return false;
  await tokenDocument.update(update, {
    ...eventOptions,
    falloutMawLightSourceSync: true
  });
  return true;
}

export function getActorLightSourceTokenDocuments(actor = null) {
  if (!actor) return [];
  let tokenDocuments = [];
  if (typeof actor.getDependentTokens === "function") {
    tokenDocuments = actor.getDependentTokens() ?? [];
  } else if (actor.token) {
    tokenDocuments = [actor.token];
  }
  const seenKeys = new Set();
  const seenDocuments = new Set();
  return Array.from(tokenDocuments)
    .map(getTokenDocument)
    .filter(tokenDocument => {
      if (!tokenDocument || seenDocuments.has(tokenDocument)) return false;
      seenDocuments.add(tokenDocument);
      const key = getDocumentCacheKey(tokenDocument)
        || `${getDocumentCacheKey(tokenDocument.parent)}.Token.${String(tokenDocument.id ?? "")}`;
      if (!key || seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    });
}

export async function syncActorLightSourceTokens(actor = null, eventOptions = {}) {
  if (!actor) return 0;
  let updates = 0;
  for (const tokenDocument of getActorLightSourceTokenDocuments(actor)) {
    if (await syncTokenLightSources(tokenDocument, eventOptions)) updates += 1;
  }
  return updates;
}

async function processLightSourceWorldTime(_worldTime, deltaSeconds) {
  if (!isAutomaticLightSourceSyncAuthority()) return;
  const seconds = Number(deltaSeconds) || 0;
  if (seconds <= 0) return;
  const consumedSources = new Map();
  for (const scene of game.scenes?.contents ?? []) {
    await processSceneLightSourceWorldTime(scene, seconds, consumedSources);
  }
}

async function processSceneLightSourceWorldTime(scene = null, deltaSeconds = 0, consumedSources = new Map()) {
  for (const tokenDocument of scene?.tokens?.contents ?? []) {
    await runTokenLightSourceOperation(tokenDocument, freshToken => (
      processTokenLightSourceWorldTime(freshToken, deltaSeconds, consumedSources)
    ));
  }
}

async function processTokenLightSourceWorldTime(tokenDocument = null, deltaSeconds = 0, consumedSources = new Map()) {
  const actor = tokenDocument?.actor;
  if (!actor) return false;
  const entries = getActiveLightSourceEntries(tokenDocument);
  if (!entries.length) return false;
  const actorItems = resolveActiveLightSourceItems(actor, entries);
  const remaining = [];
  for (const entry of entries) {
    const item = actorItems.get(entry.itemId);
    if (!item || !hasItemFunction(item, ITEM_FUNCTIONS.lightSource) || isItemBrokenByCondition(item)) continue;
    const key = `${getDocumentCacheKey(actor)}:${String(item.id)}`;
    let consumed = consumedSources.get(key);
    if (!consumed) {
      consumed = consumeLightSourceResources(actor, item, deltaSeconds);
      consumedSources.set(key, consumed);
    }
    if (await consumed) remaining.push(entry);
  }
  return syncTokenLightSourcesNow(tokenDocument, {}, { entries: remaining });
}

async function consumeLightSourceResources(actor = null, item = null, deltaSeconds = 0) {
  const costs = getLightSourceResourceCosts(item);
  if (!costs.length) return true;
  const hours = Math.max(0, Number(deltaSeconds) || 0) / 3600;
  if (hours <= 0) return true;

  const conditionCosts = costs
    .filter(cost => cost.type === "condition")
    .map(cost => ({
      key: `condition.${cost.index}`,
      amount: cost.amountPerHour * hours
    }));
  const conditionPlan = conditionCosts.length
    ? planIntegerResourceSpend({
      current: getConditionFunction(item).value,
      costs: conditionCosts,
      remainders: getCachedLightSourceResourceRemainders(item)
    })
    : null;
  if (conditionPlan && !conditionPlan.available) return false;

  const energyCosts = costs
    .filter(cost => cost.type === "energyConsumer")
    .map(cost => ({ amount: cost.amountPerHour * hours }));
  const consumer = getEnergyConsumerFunction(item);
  const source = energyCosts.length ? getInstalledEnergySourceData(consumer) : null;
  if (energyCosts.length && (
    !source
    || !hasItemFunction(source, ITEM_FUNCTIONS.energySource, { ignoreBroken: true })
    || !energySourceMatchesConsumer(source, consumer)
  )) {
    return false;
  }
  const reserve = source ? getEnergySourceReserveState(source) : null;
  const cachedReserve = reserve
    ? getCachedLightSourceReserveValue(item, consumer, reserve.value)
    : 0;
  const energyPlan = energyCosts.length
    ? planContinuousResourceSpend({ current: cachedReserve, costs: energyCosts })
    : null;
  if (energyPlan && !energyPlan.available) return false;

  const changes = {};
  if (conditionPlan?.spent > 0) {
    changes["system.functions.condition.value"] = conditionPlan.remaining;
    changes[`flags.${SYSTEM_ID}.${RESOURCE_REMAINDERS_FLAG}`] = conditionPlan.remainders;
  }
  if (energyPlan) {
    const persistedNext = roundReserveValueForUpdate(energyPlan.remaining);
    if (
      energyPlan.remaining <= EPSILON
      || persistedNext !== roundReserveValueForUpdate(reserve.value)
    ) {
      changes["system.functions.energyConsumer.installedSource.reserve.value"] = persistedNext;
    }
  }

  if (Object.keys(changes).length) {
    const update = createActorItemOrInstalledModuleUpdate(actor, item, changes);
    if (!update) return false;
    await executeInventoryMutation({
      actor,
      updates: [update]
    }, { reason: "light-source-resource-consumption" });
  }
  if (conditionPlan) {
    rememberLightSourceResourceRemainders(item, conditionPlan.remainders);
  }
  if (energyPlan) {
    rememberLightSourceReserveValue(item, consumer, energyPlan.remaining);
  }
  return true;
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

function resolveActiveLightSourceItems(actor = null, entries = []) {
  const resolved = new Map();
  const unresolved = new Set();
  for (const entry of normalizeActiveLightSourceEntries(entries)) {
    const ownedItem = actor?.items?.get?.(entry.itemId);
    if (ownedItem) resolved.set(entry.itemId, ownedItem);
    else unresolved.add(entry.itemId);
  }
  if (!unresolved.size) return resolved;
  for (const item of getActorItemsWithInstalledModules(actor)) {
    const id = String(item?.id ?? "");
    if (!unresolved.has(id)) continue;
    resolved.set(id, item);
    unresolved.delete(id);
    if (!unresolved.size) break;
  }
  return resolved;
}

function activeLightSourceEntriesEqual(left = [], right = []) {
  const normalizedLeft = normalizeActiveLightSourceEntries(left);
  const normalizedRight = normalizeActiveLightSourceEntries(right);
  if (normalizedLeft.length !== normalizedRight.length) return false;
  return normalizedLeft.every((entry, index) => entry.itemId === normalizedRight[index]?.itemId);
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

function createTokenLightDelta(tokenDocument = null, light = {}) {
  const desired = createTokenLightUpdate(light);
  const update = {};
  for (const [path, value] of Object.entries(desired)) {
    const field = path.slice("light.".length);
    const current = normalizeTokenLightField(field, tokenDocument?.light?.[field]);
    const next = normalizeTokenLightField(field, value);
    if (current !== next) update[path] = value;
  }
  return update;
}

function normalizeTokenLightField(field = "", value = null) {
  if (field === "color") return String(value ?? "").trim() || null;
  if (field === "angle") return Math.max(0, Math.min(360, Number(value) || 360));
  return Math.max(0, Number(value) || 0);
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
  data.system.quantity = 1;
  data.system.stackParts = [];
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
