import { SYSTEM_ID } from "../constants.mjs";
import { resolveWorldItemSync } from "./world-items.mjs";

/** A catalog document is its own recipe/material identity, even when duplicated. */
export function getCraftItemSourceUuid(item = null, fallbackUuid = "") {
  if (typeof item === "string") {
    fallbackUuid = item;
    item = resolveWorldItemSync(item);
  }
  const ownUuid = normalizeWorldUuid(item?.uuid) || normalizeWorldUuid(fallbackUuid);
  if (ownUuid) return ownUuid;

  // Explicit provenance survives transfers and overrides inherited template metadata.
  for (const source of [
    item?.flags?.[SYSTEM_ID]?.sourceId,
    item?._source?.flags?.[SYSTEM_ID]?.sourceId,
    item?.getFlag?.(SYSTEM_ID, "sourceId"),
    item?.flags?.core?.sourceId,
    item?._source?.flags?.core?.sourceId,
    item?.getFlag?.("core", "sourceId")
  ]) {
    const uuid = normalizeWorldUuid(source);
    if (uuid) return uuid;
  }

  // Older inventory copies inherited a template's duplicateSource. Their own
  // recipe can still identify the actual catalog entry without rewriting saves.
  const recipeSource = getLegacyRecipeSourceUuid(item);
  if (recipeSource) return recipeSource;
  return normalizeWorldUuid(item?._stats?.duplicateSource)
    || normalizeWorldUuid(item?._source?._stats?.duplicateSource);
}

export function getCraftItemSourceKeys(item = null, fallbackUuid = "") {
  const uuid = getCraftItemSourceUuid(item, fallbackUuid);
  return new Set(uuid ? [uuid] : []);
}

/** Record the actual document being copied before its ID is discarded. */
export function createSourcedInventoryItemData(item) {
  const data = item.toObject();
  const uuid = getCraftItemSourceUuid(item);
  if (uuid) {
    data.flags ??= {};
    data.flags[SYSTEM_ID] ??= {};
    data.flags[SYSTEM_ID].sourceId = uuid;
  }
  return data;
}

function normalizeWorldUuid(value) {
  const uuid = String(value ?? "").trim();
  return /^Item\.[^.]+$/.test(uuid) ? uuid : "";
}

function getLegacyRecipeSourceUuid(item) {
  const craft = item?.system?.craft ?? item?._source?.system?.craft;
  if (!craft) return "";
  const layouts = [craft, craft.disassembly, ...(craft.recipes ?? []).flatMap(recipe => [recipe, recipe.disassembly])];
  const roots = new Set(layouts.flatMap(layout => (layout?.nodes ?? [])
    .filter(node => node.root).map(node => normalizeWorldUuid(node.itemUuid))).filter(Boolean));
  if (roots.size !== 1) return "";
  const [uuid] = roots;
  const source = resolveWorldItemSync(uuid);
  return source && source.type === item.type && source.name === item.name && source.img === item.img
    ? uuid
    : "";
}
