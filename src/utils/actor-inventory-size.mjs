import { createDefaultInventorySize } from "../settings/creature-options.mjs";
import { INFINITE_ROOT_INVENTORY_EMPTY_ROWS } from "./inventory-containers.mjs";
import { toInteger } from "./numbers.mjs";

export function getInventoryGridDimensions(race) {
  const inventorySize = race?.inventorySize ?? createDefaultInventorySize();
  return {
    columns: Math.max(0, toInteger(inventorySize.columns)),
    rows: Math.max(0, toInteger(inventorySize.rows))
  };
}

export function getActorInventoryGridDimensions(actor, race) {
  const inventory = actor?.system?.inventory;
  const columns = toInteger(inventory?.columns);
  const rows = toInteger(inventory?.rows);
  let dimensions;
  if (inventory?.columns != null && inventory?.rows != null
    && Number.isFinite(Number(inventory.columns)) && Number.isFinite(Number(inventory.rows))) {
    dimensions = { columns: Math.max(0, columns), rows: Math.max(0, rows) };
  } else {
    dimensions = actor?.type === "construct" ? { columns: 0, rows: 0 } : getInventoryGridDimensions(race);
  }
  if (actorHasInfiniteRootInventory(actor)) {
    dimensions.columns = Math.max(10, dimensions.columns);
    dimensions.rows = Math.max(1, dimensions.rows);
  }
  return dimensions;
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

