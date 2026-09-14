import { createDefaultInventorySize } from "../settings/creature-options.mjs";
import { INFINITE_ROOT_INVENTORY_EMPTY_ROWS } from "./inventory-containers.mjs";
import { toInteger } from "./numbers.mjs";

export function getInventoryGridDimensions(race) {
  const inventorySize = race?.inventorySize ?? createDefaultInventorySize();
  return {
    columns: Math.max(1, toInteger(inventorySize.columns)),
    rows: Math.max(1, toInteger(inventorySize.rows))
  };
}

export function getActorInventoryGridDimensions(actor, race) {
  const inventory = actor?.system?.inventory;
  const columns = toInteger(inventory?.columns);
  const rows = toInteger(inventory?.rows);
  if (columns > 0 && rows > 0) return { columns, rows };
  return getInventoryGridDimensions(race);
}

export function actorHasInfiniteRootInventory(actor) {
  return Boolean(actor?.system?.trade?.infiniteInventory);
}

export function getActorRootInventoryGridOptions(actor, parentId = "") {
  return {
    allowOverflowRows: !parentId && actorHasInfiniteRootInventory(actor),
    extraRows: !parentId && actorHasInfiniteRootInventory(actor) ? INFINITE_ROOT_INVENTORY_EMPTY_ROWS : 0
  };
}

