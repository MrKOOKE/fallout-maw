import { resolveWorldItemReference } from "./document-references.mjs";

export function isCompendiumUuid(value = "") {
  return String(value ?? "").trim().startsWith("Compendium.");
}

export function getWorldItemUuid(item = null) {
  return item?.uuid ?? "";
}

export function resolveWorldItemSync(value = "") {
  const uuid = String(value ?? "").trim();
  if (!uuid || isCompendiumUuid(uuid)) return null;

  const itemId = getWorldItemIdFromUuid(uuid);
  if (itemId) {
    const direct = game.items?.get?.(itemId) ?? null;
    if (direct) return direct;
  }

  return resolveWorldItemReference(uuid)
    ?? (game.items?.contents ?? []).find(item => item.uuid === uuid || item.id === uuid)
    ?? null;
}

function getWorldItemIdFromUuid(uuid = "") {
  if (!uuid) return "";
  if (uuid.startsWith("Item.")) return uuid.slice("Item.".length);
  if (!uuid.includes(".")) return uuid;
  return "";
}
