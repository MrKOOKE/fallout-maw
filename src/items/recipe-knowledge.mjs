import { SYSTEM_ID } from "../constants.mjs";
import { resolveWorldItemSync } from "../utils/world-items.mjs";

export const KNOWN_CRAFT_ITEMS_FLAG = "knownCraftItems";
export const DEFAULT_CRAFT_RECIPE_ID = "recipe1";

export function getKnownCraftItemUuids(actor = null) {
  const stored = actor?.getFlag?.(SYSTEM_ID, KNOWN_CRAFT_ITEMS_FLAG);
  return new Set((Array.isArray(stored) ? stored : [])
    .map(value => String(value ?? "").trim())
    .filter(Boolean));
}

export async function setKnownCraftItemUuids(actor = null, values = []) {
  if (!actor) return [];
  const normalized = Array.from(new Set(Array.from(values ?? [])
    .map(value => String(value ?? "").trim())
    .filter(Boolean)))
    .sort((left, right) => left.localeCompare(right));
  await actor.setFlag(SYSTEM_ID, KNOWN_CRAFT_ITEMS_FLAG, normalized);
  return normalized;
}

export function actorKnowsCraftItem(actor = null, itemOrUuid = null) {
  const uuid = getCraftKnowledgeItemUuid(itemOrUuid);
  return Boolean(uuid && getKnownCraftItemUuids(actor).has(uuid));
}

export async function grantCraftItemKnowledge(actor = null, itemUuids = []) {
  const known = getKnownCraftItemUuids(actor);
  const granted = [];
  for (const value of itemUuids ?? []) {
    const uuid = getCraftKnowledgeItemUuid(value);
    if (!uuid || known.has(uuid)) continue;
    known.add(uuid);
    granted.push(uuid);
  }
  if (granted.length) await setKnownCraftItemUuids(actor, known);
  return granted;
}

export function getCraftKnowledgeItemUuid(itemOrUuid = null) {
  if (typeof itemOrUuid === "string") {
    const resolved = resolveWorldItemSync(itemOrUuid);
    return resolved?.parent ? "" : String(resolved?.uuid ?? itemOrUuid).trim();
  }
  if (!itemOrUuid || itemOrUuid.documentName !== "Item") return "";
  if (!itemOrUuid.parent) return String(itemOrUuid.uuid ?? "").trim();

  const sourceIds = [
    itemOrUuid.getFlag?.("core", "sourceId"),
    itemOrUuid.getFlag?.(SYSTEM_ID, "sourceId"),
    foundry.utils.getProperty(itemOrUuid, "_source.flags.core.sourceId"),
    foundry.utils.getProperty(itemOrUuid, `_source.flags.${SYSTEM_ID}.sourceId`)
  ];
  for (const sourceId of sourceIds) {
    const source = resolveWorldItemSync(sourceId);
    if (source && !source.parent) return source.uuid;
  }
  return "";
}

export function resolveCraftKnowledgeItem(itemOrUuid = null) {
  const uuid = getCraftKnowledgeItemUuid(itemOrUuid);
  return uuid ? resolveWorldItemSync(uuid) : null;
}

export function hasCraftKnowledgeData(itemOrCraft = null) {
  return getCraftKnowledgeVariants(itemOrCraft).length > 0;
}

export function getCraftKnowledgeVariants(itemOrCraft = null) {
  const craft = itemOrCraft?.system?.craft ?? itemOrCraft ?? {};
  const legacy = {
    id: DEFAULT_CRAFT_RECIPE_ID,
    name: game.i18n.localize("FALLOUTMAW.Craft.DefaultRecipe"),
    nodes: Array.from(craft?.nodes ?? []),
    links: Array.from(craft?.links ?? []),
    viewport: craft?.viewport ?? {},
    disassembly: craft?.disassembly ?? {}
  };
  const source = Array.isArray(craft?.recipes) && craft.recipes.length ? craft.recipes : [legacy];
  const variants = source.map((entry, index) => {
    const isDefault = !entry?.id || entry.id === DEFAULT_CRAFT_RECIPE_ID;
    const fallback = (index === 0 || isDefault) ? legacy : {};
    const merged = { ...fallback, ...entry };
    return {
      id: String(merged.id ?? (index ? `recipe${index + 1}` : DEFAULT_CRAFT_RECIPE_ID)).trim() || DEFAULT_CRAFT_RECIPE_ID,
      name: String(merged.name ?? `${game.i18n.localize("FALLOUTMAW.Craft.Recipe")} ${index + 1}`).trim(),
      nodes: Array.from(merged.nodes ?? []),
      links: Array.from(merged.links ?? []),
      viewport: merged.viewport ?? {},
      disassembly: {
        nodes: Array.from(merged.disassembly?.nodes ?? []),
        links: Array.from(merged.disassembly?.links ?? []),
        viewport: merged.disassembly?.viewport ?? {}
      }
    };
  });

  if (!variants.some(entry => entry.id === DEFAULT_CRAFT_RECIPE_ID) && hasCraftVariantData(legacy)) {
    variants.unshift(legacy);
  }
  return variants.filter(hasCraftVariantData);
}

export function getWorldCraftKnowledgeItems() {
  return (game.items?.contents ?? [])
    .filter(item => !item.parent && hasCraftKnowledgeData(item))
    .sort((left, right) => left.name.localeCompare(right.name, game.i18n.lang));
}

export function hasCraftVariantData(variant = {}) {
  return hasCraftKnowledgeLayoutData(variant)
    || hasCraftKnowledgeLayoutData(variant?.disassembly);
}

export function hasCraftKnowledgeLayoutData(layout = {}) {
  const nodes = Array.from(layout?.nodes ?? []);
  const links = Array.from(layout?.links ?? []);
  return Boolean(links.length && nodes.some(node => !node?.root));
}
