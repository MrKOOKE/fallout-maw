export const DEUS_EX_MACHINA_PROGRESS_OPTION = "falloutMawDeusExMachinaProgress";
export const DEUS_EX_MACHINA_PROGRESS_FLAG_ROOT = "flags.fallout-maw.abilityFixedFunctionState";

/**
 * Identify the narrow runtime-only Item update used to persist Deus Ex Machina
 * damage progress. The option alone is intentionally insufficient: if a future
 * caller mixes a mechanical Item change into the same operation, every normal
 * document consumer must still see it.
 */
export function isDeusExMachinaProgressItemUpdate(changes = {}, options = {}) {
  if (options?.[DEUS_EX_MACHINA_PROGRESS_OPTION] !== true) return false;
  const paths = getChangedPaths(changes);
  return paths.length > 0 && paths.every(path => (
    path === "_id"
    || path === DEUS_EX_MACHINA_PROGRESS_FLAG_ROOT
    || path.startsWith(`${DEUS_EX_MACHINA_PROGRESS_FLAG_ROOT}.`)
  ));
}

function getChangedPaths(changes = {}) {
  const flatten = globalThis.foundry?.utils?.flattenObject;
  const flattened = typeof flatten === "function"
    ? flatten(changes ?? {})
    : flattenObject(changes ?? {});
  return Object.keys(flattened)
    .map(path => String(path ?? "")
      .split(".")
      .map(segment => segment.startsWith("-=") ? segment.slice(2) : segment)
      .filter(Boolean)
      .join("."))
    .filter(Boolean);
}

function flattenObject(value, prefix = "", output = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (prefix) output[prefix] = value;
    return output;
  }
  const entries = Object.entries(value);
  if (!entries.length && prefix) output[prefix] = value;
  for (const [key, entry] of entries) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      flattenObject(entry, path, output);
    } else {
      output[path] = entry;
    }
  }
  return output;
}
