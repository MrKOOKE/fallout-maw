import { toInteger } from "../utils/numbers.mjs";

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
