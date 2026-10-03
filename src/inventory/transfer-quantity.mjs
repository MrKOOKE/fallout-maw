import {
  getItemMaxStack,
  getItemQuantity,
  getItemStackParts,
  usesVirtualInventoryStacks
} from "../utils/inventory-containers.mjs";
import { toInteger } from "../utils/numbers.mjs";

/** Limit a transfer to the stack part the user actually selected. */
export function getSelectedItemTransferQuantity(item, quantity = 0, stackIndex = 0) {
  const available = usesVirtualInventoryStacks(item)
    ? getItemStackParts(item)[toInteger(stackIndex)]?.quantity ?? 0
    : getItemQuantity(item);
  const numericQuantity = Number(quantity);
  if (!Number.isFinite(numericQuantity) || numericQuantity < 0) return 0;
  const requested = Math.trunc(numericQuantity);
  return Math.max(0, Math.min(available, requested > 0 ? requested : available));
}

/** The amount moved into one existing target stack, including its remaining room. */
export function getStackTransferQuantity(sourceItem, targetItem, quantity = 0, sourceStackIndex = 0, targetStackIndex = null) {
  const sourceAvailable = getSelectedItemTransferQuantity(sourceItem, quantity || 1, sourceStackIndex);
  const targetQuantity = usesVirtualInventoryStacks(targetItem)
    ? getItemStackParts(targetItem)[toInteger(targetStackIndex)]?.quantity
    : getItemQuantity(targetItem);
  if (targetQuantity === undefined) return 0;
  const targetAvailable = Math.max(0, getItemMaxStack(targetItem) - targetQuantity);
  return Math.min(sourceAvailable, targetAvailable);
}
