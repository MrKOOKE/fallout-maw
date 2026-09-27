import { localize as auditLocalize } from "../utils/i18n.mjs";
import {
  BUTCHERING_STORAGE_PARENT_ID, LOCKED_STORAGE_PARENT_ID,
  getContainerInventoryGridOptions, getContextInventoryItems, getItemFootprint,
  getItemStackParts, usesVirtualInventoryStacks
} from "../utils/inventory-containers.mjs";
import { getActorInventoryGridDimensions, getActorRootInventoryGridOptions } from "../utils/actor-inventory-size.mjs";
import { getCreatureOptions, getItemCategorySettings } from "../settings/accessors.mjs";
import { planSortedContentsLayout } from "./contents-sort-layout.mjs";

export const INVENTORY_SORT_CHOICES = Object.freeze([
  { key: "nameAsc", get label() { return auditLocalize("FALLOUTMAW.AuditRuntime.R1099", "А–Я"); } },
  { key: "nameDesc", get label() { return auditLocalize("FALLOUTMAW.AuditRuntime.R1100", "Я–А"); } },
  { key: "category", get label() { return auditLocalize("FALLOUTMAW.AuditRuntime.R1101", "Категории"); } },
  { key: "sizeAsc", get label() { return auditLocalize("FALLOUTMAW.AuditRuntime.R1102", "Размер ↑"); } },
  { key: "sizeDesc", get label() { return auditLocalize("FALLOUTMAW.AuditRuntime.R1103", "Размер ↓"); } }
]);

function createContentsSubcategoryResolver() {
  const orders = new Map(getItemCategorySettings().map(category => [String(category.label).trim(),
    new Map((category.subcategories ?? []).map((entry, index) => [String(entry.label).trim(), index]))
  ]));
  return item => {
    const label = String(item.system?.itemSubcategory ?? "").trim();
    return { order: orders.get(String(item.system?.itemCategory ?? "").trim())?.get(label) ?? Infinity, label };
  };
}

export function getSortedContentsEntries(actor, parentId, mode) {
  const collator = new Intl.Collator(globalThis.game?.i18n?.lang || "en", { numeric: true, sensitivity: "base" });
  if (!INVENTORY_SORT_CHOICES.some(choice => choice.key === mode)) throw new Error(auditLocalize("FALLOUTMAW.AuditRuntime.R1104", "Неизвестный порядок сортировки."));
  const subcategoryOf = mode === "category" ? createContentsSubcategoryResolver() : null;
  const entries = getContextInventoryItems(parentId, actor.items).flatMap(item => {
    const parts = usesVirtualInventoryStacks(item) ? getItemStackParts(item) : [null];
    const data = { id: item.id, type: item.type, system: {
      ...item.system, placement: { ...item.system?.placement, rotated: false }
    } };
    const footprint = getItemFootprint(data, actor.items);
    const subcategory = subcategoryOf?.(item);
    return parts.map((part, index) => {
      // Sorting resets historical manual/automatic turns. The same item must
      // have the same preferred footprint regardless of its previous cell.
      const rotated = false;
      return { item, part, index, rotated, ...footprint, subcategory };
    });
  });
  const byName = (a, b) => collator.compare(a.item.name || "", b.item.name || "");
  return entries.sort((a, b) => {
    let result = 0;
    if (mode === "category") {
      result = collator.compare(a.item.system?.itemCategory || "", b.item.system?.itemCategory || "")
        || (a.subcategory.order === b.subcategory.order ? 0 : a.subcategory.order < b.subcategory.order ? -1 : 1)
        || collator.compare(a.subcategory.label, b.subcategory.label);
    }
    if (mode === "sizeAsc" || mode === "sizeDesc") result = (a.width * a.height - b.width * b.height) * (mode === "sizeDesc" ? -1 : 1);
    return result || byName(a, b) * (mode === "nameDesc" ? -1 : 1)
      || collator.compare(a.item.id, b.item.id) || a.index - b.index;
  });
}

/** Plan the complete layout before changing documents; preserve stacks and nested contents. */
export function planInventoryContentsSort(actor, parentId, mode, grid) {
  const entries = getSortedContentsEntries(actor, parentId, mode);
  const { placements } = planSortedContentsLayout(entries, mode, grid, actor.items);
  const updates = new Map();
  const stackParts = new Map();
  for (const entry of placements) {
    const { item, placement } = entry;
    if (entry.part) {
      if (!stackParts.has(item.id)) stackParts.set(item.id, getItemStackParts(item).map(part => ({ ...part })));
      stackParts.get(item.id)[entry.index] = { ...entry.part, x: placement.x, y: placement.y, rotated: entry.rotated };
    } else {
      updates.set(item.id, { _id: item.id, "system.placement.x": placement.x, "system.placement.y": placement.y,
        "system.placement.rotated": entry.rotated });
    }
  }
  for (const [id, parts] of stackParts) {
    updates.set(id, { _id: id, "system.stackParts": parts,
      "system.placement.x": parts[0].x, "system.placement.y": parts[0].y, "system.placement.rotated": Boolean(parts[0].rotated) });
  }
  return [...updates.values()];
}

export async function sortInventoryContents({ actor, parentId = "", mode }) {
  if (!actor?.isOwner) throw new Error(auditLocalize("FALLOUTMAW.AuditRuntime.R1105", "Нет прав на сортировку содержимого."));
  if (parentId === BUTCHERING_STORAGE_PARENT_ID) throw new Error(auditLocalize("FALLOUTMAW.AuditRuntime.R1106", "Это хранилище нельзя сортировать."));
  const locked = parentId === LOCKED_STORAGE_PARENT_ID;
  let grid;
  if (parentId && !locked) {
    const container = actor.items.get(parentId);
    if (!container?.system?.functions?.container?.enabled) throw new Error(auditLocalize("FALLOUTMAW.AuditRuntime.R1107", "Контейнер не найден."));
    grid = getContainerInventoryGridOptions(container);
  } else {
    const race = getCreatureOptions().races.find(r => r.id === actor.system?.creature?.raceId);
    grid = { ...getActorInventoryGridDimensions(actor, race), ...getActorRootInventoryGridOptions(actor) };
    if (locked) grid.allowOverflowRows = true;
  }
  const updates = planInventoryContentsSort(actor, parentId, mode, grid);
  if (!updates.length) return { sorted: 0 };
  const { executeInventoryMutation } = await import("./mutation.mjs");
  await executeInventoryMutation({ actor, updates }, { reason: "contents-sort" });
  return { sorted: updates.length };
}
