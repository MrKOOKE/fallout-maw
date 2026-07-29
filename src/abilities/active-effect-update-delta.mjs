const ACTIVE_EFFECT_PRESENTATION_UPDATE_ROOTS = Object.freeze([
  "_id",
  "_stats",
  "name",
  "img",
  "description",
  "tint",
  "showIcon",
  "folder",
  "sort"
]);

export function getChangedActiveEffectPaths(changes = {}) {
  const flattened = globalThis.foundry?.utils?.flattenObject?.(changes ?? {})
    ?? flattenActiveEffectDelta(changes ?? {});
  return Object.keys(flattened)
    .map(normalizeChangedActiveEffectPath)
    .filter(Boolean);
}

function flattenActiveEffectDelta(value, prefix = "", output = {}) {
  for (const [key, entry] of Object.entries(value ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (
      entry
      && typeof entry === "object"
      && !Array.isArray(entry)
      && Object.keys(entry).length
    ) flattenActiveEffectDelta(entry, path, output);
    else output[path] = entry;
  }
  return output;
}

/**
 * Foundry calls updateActiveEffect after preparing the parent document. Only
 * guaranteed presentation fields may therefore skip downstream mechanics.
 * Unknown fields deliberately remain mechanical for forward compatibility.
 */
export function activeEffectUpdateNeedsAuraStateSync(
  effect,
  changes = {},
  paths = getChangedActiveEffectPaths(changes)
) {
  if (!paths.length) return true;
  const actorEmbedded = getActiveEffectOwningActor(effect) === effect?.parent;
  return paths.some(path => {
    if (ACTIVE_EFFECT_PRESENTATION_UPDATE_ROOTS.some(root => (
      path === root || path.startsWith(`${root}.`)
    ))) return false;
    if (path === "transfer" && actorEmbedded) return false;
    return true;
  });
}

export function getActiveEffectOwningActor(effect = null) {
  const parent = effect?.parent ?? null;
  if (!parent) return null;
  if (
    parent.documentName === "Actor"
    || ["character", "construct"].includes(String(parent.type ?? ""))
  ) return parent;
  const owner = parent.parent ?? null;
  if (
    owner?.documentName === "Actor"
    || ["character", "construct"].includes(String(owner?.type ?? ""))
  ) return owner;
  return null;
}

function normalizeChangedActiveEffectPath(path = "") {
  return String(path ?? "")
    .split(".")
    .map(segment => segment.startsWith("-=") ? segment.slice(2) : segment)
    .filter(Boolean)
    .join(".");
}
