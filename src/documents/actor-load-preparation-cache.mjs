import { SYSTEM_ID } from "../constants.mjs";
import { NATURAL_RACE_ITEM_FLAG } from "../races/natural-item-identity.mjs";

const actorLoadPreparationCache = new WeakMap();

const ACTOR_LOAD_ITEM_PATHS = Object.freeze([
  "type",
  "system.quantity",
  "system.weight",
  "system.container.parentId",
  "system.placement.mode",
  "system.equipped",
  "system.itemFunction",
  "system.functions.container",
  `flags.${SYSTEM_ID}.${NATURAL_RACE_ITEM_FLAG}`
]);

/**
 * Read a load result prepared from the same Actor values and normalized
 * settings snapshot.
 *
 * Item inputs are invalidated by Foundry descendant-document lifecycle
 * callbacks before their parent Actor is reset, so a cache hit is O(1) with
 * respect to inventory size.
 */
export function getCachedActorLoadPreparation(actor, signature, runtimeSettings) {
  const cached = actorLoadPreparationCache.get(actor);
  if (
    !cached
    || cached.signature !== signature
    || cached.runtimeSettings !== runtimeSettings
  ) return null;
  return cached.load;
}

export function setCachedActorLoadPreparation(actor, signature, runtimeSettings, load) {
  if (!actor || !load) return;
  actorLoadPreparationCache.set(actor, {
    signature,
    runtimeSettings,
    load: { ...load }
  });
}

export function invalidateActorLoadPreparation(actor) {
  if (actor) actorLoadPreparationCache.delete(actor);
}

/**
 * Determine whether an Item update can affect carried load.
 *
 * Both nested updates and Foundry's flattened dotted updates are accepted.
 * Deletion operators such as "-=container" are normalized to the field they
 * remove.
 */
export function itemUpdateAffectsActorLoad(changes = {}) {
  return collectChangedPaths(changes).some(path => (
    ACTOR_LOAD_ITEM_PATHS.some(dependency => pathsOverlap(path, dependency))
  ));
}

function collectChangedPaths(value, prefix = "", paths = []) {
  if (!isPlainObject(value)) {
    if (prefix) paths.push(normalizeUpdatePath(prefix));
    return paths;
  }

  const entries = Object.entries(value);
  if (!entries.length) {
    if (prefix) paths.push(normalizeUpdatePath(prefix));
    return paths;
  }

  for (const [key, entry] of entries) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(entry)) collectChangedPaths(entry, path, paths);
    else paths.push(normalizeUpdatePath(path));
  }
  return paths;
}

function normalizeUpdatePath(path) {
  return String(path ?? "")
    .split(".")
    .map(segment => segment.startsWith("-=") ? segment.slice(2) : segment)
    .filter(Boolean)
    .join(".");
}

function pathsOverlap(changedPath, dependencyPath) {
  return changedPath === dependencyPath
    || changedPath.startsWith(`${dependencyPath}.`)
    || dependencyPath.startsWith(`${changedPath}.`);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
