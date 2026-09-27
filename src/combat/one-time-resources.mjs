import { toInteger } from "../utils/numbers.mjs";

const mutations = new Map();

/** Serialize local counter writes; callers must publish reactive events after this resolves. */
export function runOneTimeResourceMutation(actor, operation) {
  const key = actor?.uuid || actor;
  const previous = mutations.get(key) ?? Promise.resolve();
  const pending = previous.catch(() => undefined).then(operation);
  mutations.set(key, pending);
  return pending.finally(() => {
    if (mutations.get(key) === pending) mutations.delete(key);
  });
}

/** One-time resources are editable Actor balances, never Active Effect changes. */
export function getOneTimeResourceValue(actor, key) {
  if (key === "consciousness") return 0;
  return Math.max(0, toInteger(actor?.system?.resources?.[key]?.once));
}

/** Build an atomic once-first payment without changing the Actor. */
export function prepareActorResourceSpend(actor, resourceKey, amount, { available } = {}) {
  const resource = actor?.system?.resources?.[resourceKey];
  if (!resource || !isActorResourceKey(actor, resourceKey, { allowConsciousness: true })) return null;
  const cost = Math.max(0, toInteger(amount));
  const current = toInteger(resource.value);
  const minimum = toInteger(resource.min);
  const maximum = toInteger(resource.max);
  const onceBefore = getOneTimeResourceValue(actor, resourceKey);
  const total = Math.max(0, current - minimum) + onceBefore;
  const allowed = available === undefined ? total : Math.min(total, Math.max(0, toInteger(available)));
  if (cost > allowed) return null;
  const onceSpent = Math.min(cost, onceBefore);
  const normalSpent = cost - onceSpent;
  const next = current - normalSpent;
  const nextSpent = Math.max(0, maximum - next);
  const updates = {};
  if (normalSpent) {
    updates[`system.resources.${resourceKey}.value`] = next;
    updates[`system.resources.${resourceKey}.spent`] = nextSpent;
  }
  if (onceSpent) updates[`system.resources.${resourceKey}.once`] = onceBefore - onceSpent;
  return { resourceKey, amount: cost, current, minimum, maximum, onceBefore, onceSpent, normalSpent, next, nextSpent, updates };
}

export async function setOneTimeResourceValue(actor, key, value, options = {}) {
  return runOneTimeResourceMutation(actor, () => setOneTimeResourceValueNow(actor, key, value, options));
}

async function setOneTimeResourceValueNow(actor, key, value, options = {}) {
  if (!actor?.isOwner || !isActorResourceKey(actor, key)) return getOneTimeResourceValue(actor, key);
  const next = Math.max(0, toInteger(value));
  if (getOneTimeResourceValue(actor, key) !== next) {
    await actor.update({ [`system.resources.${key}.once`]: next }, options);
  }
  return getOneTimeResourceValue(actor, key);
}

/** Return the delta actually persisted, including native update cancellation. */
export async function addOneTimeResourcePoints(actor, key, amount, options = {}) {
  return runOneTimeResourceMutation(actor, async () => {
    const granted = Math.max(0, toInteger(amount));
    if (!granted) return 0;
    const before = getOneTimeResourceValue(actor, key);
    const after = await setOneTimeResourceValueNow(actor, key, before + granted, options);
    return Math.min(granted, Math.max(0, after - before));
  });
}

/** Expire every existing positive one-time balance in one verified Actor write. */
export function clearOneTimeResourcePoints(actor, options = {}) {
  return runOneTimeResourceMutation(actor, async () => {
    if (!actor?.isOwner) return 0;
    const entries = Object.keys(actor.system?.resources ?? {})
      .map(key => [key, getOneTimeResourceValue(actor, key)])
      .filter(([, value]) => value > 0);
    if (!entries.length) return 0;
    await actor.update(Object.fromEntries(entries.map(([key]) => [`system.resources.${key}.once`, 0])), options);
    if (entries.some(([key]) => getOneTimeResourceValue(actor, key) !== 0)) {
      throw new Error("One-time resource expiration was cancelled or altered.");
    }
    return entries.reduce((total, [, value]) => total + value, 0);
  });
}

function isActorResourceKey(actor, key, { allowConsciousness = false } = {}) {
  return typeof key === "string" && key.trim().length > 0 && !key.includes(".")
    && !["__proto__", "prototype", "constructor"].includes(key)
    && (allowConsciousness || key !== "consciousness")
    && Object.hasOwn(actor?.system?.resources ?? {}, key);
}
