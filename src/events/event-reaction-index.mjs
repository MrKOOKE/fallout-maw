import {
  getActorEventReactionSourceItems,
  isActiveEventReactionGearItem
} from "./event-reaction-scanner.mjs";
import {
  EVENT_REACTION_CONDITION_TYPE,
  getEventParticipantActorUuid
} from "./event-reaction-schema.mjs";
import { ABILITY_FUNCTION_TYPES } from "../settings/abilities.mjs";
import { isDeusExMachinaProgressItemUpdate } from "../abilities/deus-ex-machina-progress-runtime.mjs";
import { getActiveSceneWorldTimeActors } from "../time/world-time-actor-index.mjs";

export const VISION_EVENT_REACTION_KEYS = Object.freeze([
  "fallout-maw.vision.target.gained",
  "fallout-maw.vision.target.lost"
]);

export const MOVEMENT_GATE_EVENT_KEYS = Object.freeze([
  "fallout-maw.movement.token.before",
  "fallout-maw.movement.token.beforeStart"
]);

const DEFAULT_COALESCE_MS = 50;

/**
 * Runtime progress is stored on the source Item, but it cannot add, remove, or
 * retarget an Event Reaction subscription. Rebuilding the scene-wide
 * subscription index for that bookkeeping update only repeats an expensive
 * Actor/Item scan.
 */
export function itemUpdateInvalidatesEventReactionIndex(changes = {}, options = {}) {
  if (isDeusExMachinaProgressItemUpdate(changes, options)) return false;
  if (options?.falloutMawEventReactionProgress !== true) return true;
  const paths = getChangedPaths(changes);
  const progressRoot = "flags.fallout-maw.eventReactionProgress";
  return !paths.length || !paths.every(path => (
    path === "_id"
    || path === progressRoot
    || path.startsWith(`${progressRoot}.`)
  ));
}

export function actorUpdateInvalidatesEventReactionIndex(changes = {}) {
  const paths = getChangedPaths(changes);
  return paths.some(path => (
    path === `flags.fallout-maw.selectedHudWeaponItemId`
    || path === `flags.fallout-maw.selectedHudWeaponSetKey`
    || path === "system.creature.raceId"
    || path === "system.constructPartSlots"
    || path.startsWith("system.constructPartSlots.")
    || path === "flags.fallout-maw.actorContainer"
    || path.startsWith("flags.fallout-maw.actorContainer.passengers")
    || path === "flags.fallout-maw.travelGroup"
    || path.startsWith("flags.fallout-maw.travelGroup.units")
    || path.startsWith("flags.fallout-maw.travelGroup.memberActorUuids")
    || /^system\.limbs\.[^.]+\.(?:max|maxBonus|missing)$/.test(path)
  ));
}

export function tokenUpdateInvalidatesEventReactionIndex(changes = {}) {
  const paths = getChangedPaths(changes);
  return paths.some(path => (
    path === "actorId"
    || path === "actorLink"
  ));
}

export function activeEffectInvalidatesEventReactionIndex(effect = null, changes = null) {
  if (changes) {
    const paths = getChangedPaths(changes);
    const effectChangesUpdated = paths.some(path => (
      path === "system.changes"
      || path.startsWith("system.changes.")
      || path === "changes"
      || path.startsWith("changes.")
    ));
    // The Hook exposes the post-update document. A removed last relevant row
    // cannot be discovered there, so any change-list replacement must
    // conservatively invalidate the structural membership index.
    if (effectChangesUpdated) return true;
    if (!paths.some(path => (
      path === "disabled"
      || path === "duration"
      || path.startsWith("duration.")
    ))) return false;
  }
  return (effect?.system?.changes ?? effect?.changes ?? [])
    .some(change => isHudSourceMembershipEffectKey(change?.key));
}

/**
 * Lightweight key scrape — intentionally avoids normalizeAbilityFunctions so the index
 * stays cheap and Foundry-free for unit tests / ready-time rebuilds.
 */
export function collectEventReactionKeysFromItem(item = null) {
  const functions = item?.type === "ability"
    ? item.system?.functions ?? []
    : isActiveEventReactionGearItem(item)
      ? item.system?.functions?.freeSettings?.entries ?? []
      : [];
  const keys = [];
  for (const entry of functions ?? []) {
    if (String(entry?.type ?? "") !== ABILITY_FUNCTION_TYPES.effectChanges) continue;
    for (const condition of entry?.conditions ?? []) {
      if (String(condition?.type ?? "") !== EVENT_REACTION_CONDITION_TYPE) continue;
      const eventKey = String(condition?.eventKey ?? condition?.key ?? "").trim();
      if (eventKey) keys.push(eventKey);
    }
  }
  return keys;
}

/**
 * O(1) demand index for Event Reaction subscriptions on the active scene.
 * Without this, every selectable system event scans all scene actors/items even when
 * no event-reaction functions exist (functionChecks: 0 in production logs).
 * Actor-local invalidations reuse the completed scans of other exact Documents.
 * Providers with cross-Actor dependencies must keep full refreshes (the default
 * for an injected getItems provider unless canReuseActorItems opts in).
 */
export function createEventReactionSubscriptionIndex({
  getReactors = () => getActiveSceneWorldTimeActors(),
  getItems = undefined,
  canReuseActorItems = () => getItems === undefined,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
  coalesceMs = DEFAULT_COALESCE_MS
} = {}) {
  let generation = 0;
  let keys = new Set();
  let actorsByKey = new Map();
  let recordsByActor = new WeakMap();
  let dirtyActors = new WeakSet();
  let fullRefresh = true;
  let totalSubscriptions = 0;
  let dirty = true;
  let timerId = null;
  let rebuildPromise = null;
  let invalidationRevision = 0;

  function markDirty(actor = null) {
    invalidationRevision += 1;
    dirty = true;
    if (actor && typeof actor === "object") dirtyActors.add(actor);
    else fullRefresh = true;
    // #region codex-runtime-debug H12 verify hook ownership in the actual client
    globalThis.__falloutMawGameplayProbe?.count(actor && typeof actor === "object"
      ? "events.indexInvalidationLocal" : "events.indexInvalidationFull", "H12");
    // #endregion codex-runtime-debug
    if (timerId !== null) return;
    timerId = setTimer(() => {
      timerId = null;
      void ensureFresh().catch(error => {
        globalThis.console?.warn?.("fallout-maw | Event Reaction subscription index rebuild failed.", error);
      });
    }, Math.max(0, Number(coalesceMs) || 0));
  }

  async function ensureFresh() {
    if (!dirty && rebuildPromise === null) return snapshot();
    if (rebuildPromise) return rebuildPromise;
    const rebuildRevision = invalidationRevision;
    let pendingRebuild;
    pendingRebuild = Promise.resolve().then(async () => {
      // codex-runtime-debug: time real scene-wide rebuilds, excluding warm lookups.
      const __codexFinish = globalThis.__falloutMawGameplayProbe?.span("events.rebuildIndex", "H2");
      try {
      const nextKeys = new Set();
      const nextActorsByKey = new Map();
      const nextRecordsByActor = new WeakMap();
      const reuseUnchanged = !fullRefresh && canReuseActorItems();
      let nextTotal = 0;
      let scannedActors = 0, reusedActors = 0; // codex-runtime-debug
      for (const actor of await getReactors() ?? []) {
        let record = reuseUnchanged && !dirtyActors.has(actor) ? recordsByActor.get(actor) : null;
        if (record) reusedActors += 1; // codex-runtime-debug
        if (!record) {
          scannedActors += 1; // codex-runtime-debug
          record = { keys: new Set(), total: 0 };
          for (const item of getActorEventReactionSourceItems(actor, getItems ? { getItems } : {})) {
            for (const eventKey of collectEventReactionKeysFromItem(item)) {
              record.keys.add(eventKey);
              record.total += 1;
            }
          }
        }
        nextTotal += record.total;
        for (const eventKey of record.keys) {
          nextKeys.add(eventKey);
          const actors = nextActorsByKey.get(eventKey) ?? [];
          actors.push(actor);
          nextActorsByKey.set(eventKey, actors);
        }
        // An empty scan also proves that this exact Document has no reactions.
        // Document identity matters: synthetic Actors can be replaced while
        // retaining their UUID, before the scene index has been invalidated.
        if (actor && typeof actor === "object") nextRecordsByActor.set(actor, record);
      }
      // #region codex-runtime-debug H12 measure inventory scans rather than rebuild count
      globalThis.__falloutMawGameplayProbe?.count("events.indexActorsScanned", "H12", scannedActors);
      globalThis.__falloutMawGameplayProbe?.count("events.indexActorsReused", "H12", reusedActors);
      // #endregion codex-runtime-debug
      if (invalidationRevision === rebuildRevision) {
        keys = nextKeys;
        actorsByKey = nextActorsByKey;
        recordsByActor = nextRecordsByActor;
        dirtyActors = new WeakSet();
        fullRefresh = false;
        totalSubscriptions = nextTotal;
        dirty = false;
        generation += 1;
      }
      return snapshot();
      } finally {
        __codexFinish?.(); // codex-runtime-debug
      }
    }).finally(() => {
      if (rebuildPromise === pendingRebuild) rebuildPromise = null;
    });
    rebuildPromise = pendingRebuild;
    return rebuildPromise;
  }

  function snapshot() {
    return {
      generation,
      totalSubscriptions,
      keys,
      actorsByKey,
      empty: totalSubscriptions === 0
    };
  }

  function hasEventKey(eventKey) {
    if (dirty) return null;
    const key = String(eventKey ?? "").trim();
    if (!key) return false;
    return keys.has(key);
  }

  function hasAnyOf(eventKeys = []) {
    if (dirty) return null;
    return (eventKeys ?? []).some(key => keys.has(String(key ?? "").trim()));
  }

  function getActorsForEventKey(eventKey) {
    if (dirty) return null;
    const key = String(eventKey ?? "").trim();
    if (!key) return [];
    return actorsByKey.get(key) ?? [];
  }

  function hasActorEventKey(actor, eventKey) {
    if (dirty) return null;
    const record = recordsByActor.get(actor);
    if (!record) return null;
    return record.keys.has(String(eventKey ?? "").trim());
  }

  function reset() {
    invalidationRevision += 1;
    if (timerId !== null) clearTimer(timerId);
    timerId = null;
    rebuildPromise = null;
    keys = new Set();
    actorsByKey = new Map();
    recordsByActor = new WeakMap();
    dirtyActors = new WeakSet();
    fullRefresh = true;
    totalSubscriptions = 0;
    dirty = true;
    generation += 1;
  }

  return Object.freeze({
    markDirty,
    ensureFresh,
    hasEventKey,
    hasAnyOf,
    getActorsForEventKey,
    hasActorEventKey,
    reset,
    snapshot,
    get empty() {
      return !dirty && totalSubscriptions === 0;
    },
    get isDirty() {
      return dirty;
    }
  });
}

let index = null;
let hooksRegistered = false;
let configuredItemProvider = null;
let configuredItemProviderIsLocal = false;

export function configureEventReactionSubscriptionItems(getItems = null, { actorLocal = false } = {}) {
  configuredItemProvider = typeof getItems === "function" ? getItems : null;
  configuredItemProviderIsLocal = actorLocal === true;
  index?.markDirty();
}

export function getEventReactionSubscriptionIndex() {
  if (!index) {
    index = createEventReactionSubscriptionIndex({
      getItems: actor => configuredItemProvider?.(actor) ?? getActorItemDocuments(actor),
      canReuseActorItems: () => !configuredItemProvider || configuredItemProviderIsLocal
    });
  }
  return index;
}

export function registerEventReactionSubscriptionIndexHooks({
  hooks = globalThis.Hooks,
  getIndex = getEventReactionSubscriptionIndex
} = {}) {
  if (hooksRegistered || !hooks?.on) return () => undefined;
  hooksRegistered = true;
  const current = getIndex();
  const bump = () => current.markDirty();
  const bumpOwner = document => {
    let actor = document;
    while (actor && actor.documentName !== "Actor") actor = actor.parent;
    // A world Actor may also supply data to many synthetic Actors. Only an
    // unlinked token's own Actor has a locally bounded dependency here.
    if (actor?.isToken === true && actor.token?.actorLink === false) current.markDirty(actor);
    else bump();
  };

  const registrations = [
    ["canvasReady", bump],
    ["canvasTearDown", () => current.reset()],
    ["createSetting", bump],
    ["updateSetting", bump],
    ["deleteSetting", bump],
    ["createToken", bump],
    ["deleteToken", bump],
    ["createItem", bumpOwner],
    ["updateItem", (item, changes = {}, options = {}) => {
      if (itemUpdateInvalidatesEventReactionIndex(changes, options)) bumpOwner(item);
    }],
    ["deleteItem", bumpOwner],
    ["createActor", bump],
    ["deleteActor", bump],
    ["updateActor", (actor, changes = {}) => {
      if (actorUpdateInvalidatesEventReactionIndex(changes)) {
        if (getChangedPaths(changes).some(path => path.startsWith("flags.fallout-maw.actorContainer")
          || path.startsWith("flags.fallout-maw.travelGroup"))) bump();
        else bumpOwner(actor);
      }
    }],
    ["updateToken", (_token, changes = {}) => {
      if (tokenUpdateInvalidatesEventReactionIndex(changes)) bump();
    }],
    ["createActiveEffect", effect => {
      if (activeEffectInvalidatesEventReactionIndex(effect)) bumpOwner(effect);
    }],
    ["updateActiveEffect", (effect, changes = {}) => {
      if (activeEffectInvalidatesEventReactionIndex(effect, changes)) bumpOwner(effect);
    }],
    ["deleteActiveEffect", effect => {
      if (activeEffectInvalidatesEventReactionIndex(effect)) bumpOwner(effect);
    }]
  ].map(([name, callback]) => ({ name, id: hooks.on(name, callback) }));

  hooks.once?.("ready", () => {
    bump();
    void current.ensureFresh().catch(error => {
      globalThis.console?.warn?.("fallout-maw | Initial Event Reaction index rebuild failed.", error);
    });
  });

  return () => {
    for (const entry of registrations) hooks.off?.(entry.name, entry.id);
    hooksRegistered = false;
  };
}

export async function eventReactionIndexHasKey(eventKey) {
  const current = getEventReactionSubscriptionIndex();
  const known = current.hasEventKey(eventKey);
  if (known !== null) return known;
  await ensureIndexFresh(current);
  return Boolean(current.hasEventKey(eventKey));
}

export async function eventReactionIndexHasAny(eventKeys = []) {
  const current = getEventReactionSubscriptionIndex();
  const known = current.hasAnyOf(eventKeys);
  if (known !== null) return known;
  await ensureIndexFresh(current);
  return Boolean(current.hasAnyOf(eventKeys));
}

export async function eventReactionIndexGetActors(eventKey) {
  const current = getEventReactionSubscriptionIndex();
  const known = current.getActorsForEventKey(eventKey);
  if (known !== null) return known;
  await ensureIndexFresh(current);
  return current.getActorsForEventKey(eventKey) ?? [];
}

/** Scan participants only when the fresh scene index has not covered their Document. */
export async function eventParticipantHasReactionKey(envelope = {}, {
  resolveUuid = uuid => globalThis.fromUuid?.(uuid) ?? null,
  getIndex = getEventReactionSubscriptionIndex,
  getItems = actor => configuredItemProvider?.(actor) ?? getActorItemDocuments(actor)
} = {}) {
  const eventKey = String(envelope?.key ?? "").trim();
  const actorUuids = new Set([
    envelope?.source?.actorUuid,
    envelope?.target?.actorUuid
  ].map(value => String(value ?? "").trim()).filter(Boolean));
  for (const actorUuid of actorUuids) {
    const actor = await resolveUuid(actorUuid);
    if (!actor) continue;
    const known = getIndex().hasActorEventKey(actor, eventKey);
    if (known !== null) {
      if (known) return true;
      continue;
    }
    for (const item of getActorEventReactionSourceItems(actor, { getItems })) {
      if (collectEventReactionKeysFromItem(item).includes(eventKey)) return true;
    }
  }
  return false;
}

export async function collectIndexedEventReactionReactorActors(envelope = {}, {
  resolveUuid = uuid => globalThis.fromUuid?.(uuid) ?? null,
  getIndexedActors = eventReactionIndexGetActors
} = {}) {
  const sourceActorUuid = getEventParticipantActorUuid(envelope?.source);
  const targetActorUuid = getEventParticipantActorUuid(envelope?.target);
  const [sourceActor, targetActor, indexedActors] = await Promise.all([
    safeResolveActor(sourceActorUuid, resolveUuid),
    safeResolveActor(targetActorUuid, resolveUuid),
    getIndexedActors(String(envelope?.key ?? ""))
  ]);
  const actors = new Map();
  for (const actor of [sourceActor, targetActor, ...(indexedActors ?? [])]) {
    const actorUuid = String(actor?.uuid ?? "").trim();
    if (actorUuid && !actors.has(actorUuid)) actors.set(actorUuid, actor);
  }
  return Array.from(actors.values());
}

export async function eventReactionIndexIsEmpty() {
  const current = getEventReactionSubscriptionIndex();
  if (!current.isDirty) return current.empty;
  await ensureIndexFresh(current);
  return current.empty;
}

async function ensureIndexFresh(current) {
  while (current?.isDirty) await current.ensureFresh();
}

function getChangedPaths(changes = {}) {
  const flattened = globalThis.foundry?.utils?.flattenObject?.(changes ?? {}) ?? changes ?? {};
  return Object.keys(flattened)
    .map(path => String(path ?? "")
      .split(".")
      .map(segment => segment.startsWith("-=") ? segment.slice(2) : segment)
      .filter(Boolean)
      .join("."))
    .filter(Boolean);
}

function isHudSourceMembershipEffectKey(key = "") {
  const normalized = String(key ?? "").trim();
  if (/^system\.limbs\.(?:all|[^.]+)\.(?:max|maxBonus)$/.test(normalized)) return true;
  return [
    "fallout-maw.suppression.traumas.all",
    "fallout-maw.suppression.traumas.count",
    "fallout-maw.suppression.diseases.all",
    "fallout-maw.suppression.diseases.count"
  ].includes(normalized);
}

async function safeResolveActor(uuid, resolveUuid) {
  if (!uuid) return null;
  try {
    return await resolveUuid(uuid);
  } catch (_error) {
    return null;
  }
}

function getActorItemDocuments(actor = null) {
  if (Array.isArray(actor?.items?.contents)) return actor.items.contents;
  if (typeof actor?.items?.values === "function") return Array.from(actor.items.values());
  return Array.from(actor?.items ?? []);
}
