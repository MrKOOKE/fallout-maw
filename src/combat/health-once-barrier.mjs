import { toInteger } from "../utils/numbers.mjs";
import { runOneTimeResourceMutation } from "./one-time-resources.mjs";

const HEALTH_ONCE_PATH = "system.resources.health.once";

export function createHealthOnceBarrierState(actor) {
  const initial = getPersistedHealthOnce(actor);
  return { initial, remaining: initial, committed: false, failed: false };
}

/** A single mutable state is shared by every damage entry in a packet. */
export function absorbHealthOnceBarrier(state, { amount = 0, bypassBarrier = false } = {}) {
  const incoming = Math.max(0, toInteger(amount));
  const absorbed = state && !bypassBarrier ? Math.min(incoming, state.remaining) : 0;
  if (state) state.remaining -= absorbed;
  return { absorbed, remaining: incoming - absorbed };
}

export function hasPendingHealthOnceBarrier(state) {
  return Boolean(state && !state.committed && state.remaining < state.initial);
}

/** Save the remaining barrier in the SAME Actor write as ordinary limb/HP loss. */
export async function commitHealthOnceBarrier(actor, state, updates = {}, options = {}) {
  if (!hasPendingHealthOnceBarrier(state)) {
    return Object.keys(updates).length ? actor.update(updates, options) : null;
  }
  return runOneTimeResourceMutation(actor, async () => {
    try {
      if (state.failed || getPersistedHealthOnce(actor) !== state.initial) {
        throw new Error("The health one-time barrier changed while damage was being prepared.");
      }
      const result = await actor.update({ ...updates, [HEALTH_ONCE_PATH]: state.remaining }, options);
      if (!result || getPersistedHealthOnce(actor) !== state.remaining) {
        throw new Error("The health one-time barrier and damage update was canceled or changed.");
      }
      state.committed = true;
      return result;
    } catch (error) {
      state.failed = true;
      throw error;
    }
  });
}

function getPersistedHealthOnce(actor) {
  return Math.max(0, toInteger(actor?._source?.system?.resources?.health?.once
    ?? actor?.system?.resources?.health?.once));
}
