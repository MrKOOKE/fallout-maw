import {
  getActorEventReactionSourceItems,
  collectActiveSceneReactorActors,
  isActiveEventReactionGearItem
} from "./event-reaction-scanner.mjs";
import { EVENT_REACTION_CONDITION_TYPE } from "./event-reaction-schema.mjs";
import { ABILITY_FUNCTION_TYPES } from "../settings/abilities.mjs";

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
 */
export function createEventReactionSubscriptionIndex({
  getReactors = () => collectActiveSceneReactorActors(),
  getItems = undefined,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
  coalesceMs = DEFAULT_COALESCE_MS
} = {}) {
  let generation = 0;
  let keys = new Set();
  let totalSubscriptions = 0;
  let dirty = true;
  let timerId = null;
  let rebuildPromise = null;

  function markDirty() {
    dirty = true;
    if (timerId !== null) return;
    timerId = setTimer(() => {
      timerId = null;
      void ensureFresh();
    }, Math.max(0, Number(coalesceMs) || 0));
  }

  async function ensureFresh() {
    if (!dirty && rebuildPromise === null) return snapshot();
    if (rebuildPromise) return rebuildPromise;
    rebuildPromise = Promise.resolve().then(() => {
      const nextKeys = new Set();
      let nextTotal = 0;
      for (const actor of getReactors() ?? []) {
        for (const item of getActorEventReactionSourceItems(actor, getItems ? { getItems } : {})) {
          for (const eventKey of collectEventReactionKeysFromItem(item)) {
            nextKeys.add(eventKey);
            nextTotal += 1;
          }
        }
      }
      keys = nextKeys;
      totalSubscriptions = nextTotal;
      dirty = false;
      generation += 1;
      rebuildPromise = null;
      return snapshot();
    });
    return rebuildPromise;
  }

  function snapshot() {
    return {
      generation,
      totalSubscriptions,
      keys,
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

  function reset() {
    if (timerId !== null) clearTimer(timerId);
    timerId = null;
    rebuildPromise = null;
    keys = new Set();
    totalSubscriptions = 0;
    dirty = true;
    generation += 1;
  }

  return Object.freeze({
    markDirty,
    ensureFresh,
    hasEventKey,
    hasAnyOf,
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

export function getEventReactionSubscriptionIndex() {
  if (!index) index = createEventReactionSubscriptionIndex();
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

  const registrations = [
    ["canvasReady", bump],
    ["canvasTearDown", () => current.reset()],
    ["createToken", bump],
    ["deleteToken", bump],
    ["createItem", bump],
    ["updateItem", bump],
    ["deleteItem", bump],
    ["createActor", bump],
    ["deleteActor", bump]
  ].map(([name, callback]) => ({ name, id: hooks.on(name, callback) }));

  hooks.once?.("ready", () => {
    bump();
    void current.ensureFresh();
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
  await current.ensureFresh();
  return Boolean(current.hasEventKey(eventKey));
}

export async function eventReactionIndexHasAny(eventKeys = []) {
  const current = getEventReactionSubscriptionIndex();
  const known = current.hasAnyOf(eventKeys);
  if (known !== null) return known;
  await current.ensureFresh();
  return Boolean(current.hasAnyOf(eventKeys));
}

export async function eventReactionIndexIsEmpty() {
  const current = getEventReactionSubscriptionIndex();
  if (!current.isDirty) return current.empty;
  await current.ensureFresh();
  return current.empty;
}
