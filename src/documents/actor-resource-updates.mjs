import { toInteger } from "../utils/numbers.mjs";

/**
 * V14 fully cleans a newly materialized RecordField entry even in a partial
 * update. Its default value/max of zero must not reach the manual-value hooks
 * as if the caller had requested them. Seed only touched, absent entries from
 * the prepared Actor; never persist derived bonuses or unrelated records.
 */
export function prepareSparseActorResourceUpdate(data, options = {}, context = {}) {
  const actor = context.model;
  if (!options.partial || options.model === false || context.creation
    || !["character", "construct"].includes(actor?.type)) return data;
  if (!data?.system?.resources && !data?.system?.limbs
    && !Object.keys(data ?? {}).some(key => /^system\.(resources|limbs)(\.|$)/.test(key))) return data;
  const expanded = foundry.utils.expandObject(foundry.utils.deepClone(data));
  let changed = false;
  for (const group of ["resources", "limbs"]) {
    const records = expanded.system?.[group];
    if (!isPlainRecord(records)) continue;
    for (const [key, update] of Object.entries(records)) {
      if (key.startsWith("-=") || !isPlainRecord(update)) continue;
      if ((context.source ?? actor._source)?.system?.[group]?.[key] != null) continue;
      const current = actor.system?.[group]?.[key];
      if (!current) continue;
      const maximum = toInteger(update.max ?? current.max);
      const minimum = toInteger(update.min ?? current.min ?? (group === "limbs" ? -maximum : 0));
      const value = Object.hasOwn(update, "spent")
        ? Math.min(maximum, Math.max(minimum, maximum - Math.max(0, toInteger(update.spent))))
        : toInteger(current.value);
      records[key] = {
        min: minimum,
        max: maximum,
        value,
        spent: Math.max(0, toInteger(current.spent)),
        ...update
      };
      changed = true;
    }
  }
  return changed ? expanded : data;
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object") return false;
  if (Object.hasOwn(value, "__$OPERATOR$__")) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Keep the persisted spent mirror coherent for resources whose value is part
 * of this update. Unrelated Actor updates must not manufacture resource paths:
 * Foundry treats every added path as a real change and publishes/renders it.
 */
export function syncTrackedResourceValueUpdates(actor, changes) {
  for (const resourceKey of Object.keys(actor.system?.resources ?? {})) {
    if (resourceKey === "health") continue;
    const currentResource = actor.system?.resources?.[resourceKey];
    if (!currentResource) continue;

    const valuePath = `system.resources.${resourceKey}.value`;
    if (!hasUpdatePath(changes, valuePath)) continue;

    const min = Math.max(0, getUpdatedResourceBound(changes, actor, resourceKey, "min"));
    const max = Math.max(min, getUpdatedResourceBound(changes, actor, resourceKey, "max"));
    const nextValue = Math.min(
      Math.max(getUpdatedResourceBound(changes, actor, resourceKey, "value"), min),
      max
    );

    foundry.utils.setProperty(changes, `system.resources.${resourceKey}.spent`, Math.max(0, max - nextValue));
  }
}

function getUpdatedResourceBound(changes, actor, resourceKey, field) {
  const path = `system.resources.${resourceKey}.${field}`;
  const value = getUpdatePath(changes, path);
  return toInteger(value ?? actor.system?.resources?.[resourceKey]?.[field]);
}

function hasUpdatePath(object, path) {
  return foundry.utils.hasProperty(object, path) || Object.hasOwn(object, path);
}

function getUpdatePath(object, path) {
  if (foundry.utils.hasProperty(object, path)) return foundry.utils.getProperty(object, path);
  return object[path];
}
