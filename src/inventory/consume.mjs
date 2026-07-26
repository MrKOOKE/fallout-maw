import {
  createItemStackPartRemovalUpdate,
  getItemId,
  getItemQuantity,
  usesVirtualInventoryStacks
} from "../utils/inventory-containers.mjs";
import { toInteger } from "../utils/numbers.mjs";

/**
 * Build the Item portion of consuming one inventory use.
 *
 * An Item with one charge per unit spends up to `amount` quantity. An Item with
 * multiple charges spends across the current unit and as many following units
 * as needed. Virtual stacks retain their per-part placement data through the
 * canonical stack helper.
 */
export function planInventoryItemConsumption({
  item = null,
  amount = 1,
  charges = null,
  chargePath = "",
  stackIndex = 0
} = {}) {
  const itemId = getItemId(item);
  const quantity = getItemQuantity(item);
  const cost = Math.max(1, toInteger(amount));
  const normalizedCharges = normalizeConsumptionCharges(charges);
  const normalizedChargePath = String(chargePath ?? "").trim();
  if (!itemId || quantity <= 0) {
    return createEmptyConsumptionPlan({
      itemId,
      quantity,
      charges: normalizedCharges
    });
  }

  if (normalizedCharges.max > 1) {
    if (!normalizedChargePath) {
      throw new TypeError("A multi-charge inventory consumption requires chargePath.");
    }
    const totalCharges = normalizedCharges.value + ((quantity - 1) * normalizedCharges.max);
    const remainingTotalCharges = Math.max(0, totalCharges - cost);
    if (remainingTotalCharges <= 0) {
      return {
        itemId,
        updates: [],
        deletes: [itemId],
        consumedQuantity: quantity,
        remainingQuantity: 0,
        remainingCharges: 0,
        changed: true
      };
    }

    const remainingQuantity = Math.ceil(remainingTotalCharges / normalizedCharges.max);
    const remainingCharges = remainingTotalCharges - ((remainingQuantity - 1) * normalizedCharges.max);
    const consumedQuantity = Math.max(0, quantity - remainingQuantity);
    const quantityUpdate = consumedQuantity > 0
      ? createQuantityConsumptionUpdate(item, consumedQuantity, stackIndex)
      : { _id: itemId };
    quantityUpdate[normalizedChargePath] = remainingCharges;
    return {
      itemId,
      updates: [quantityUpdate],
      deletes: [],
      consumedQuantity,
      remainingQuantity,
      remainingCharges,
      changed: true
    };
  }

  const consumedQuantity = Math.min(quantity, cost);
  const quantityUpdate = createQuantityConsumptionUpdate(item, consumedQuantity, stackIndex);
  const remainingQuantity = Math.max(0, quantity - consumedQuantity);
  if (!quantityUpdate || remainingQuantity <= 0) {
    return {
      itemId,
      updates: [],
      deletes: [itemId],
      consumedQuantity,
      remainingQuantity: 0,
      remainingCharges: 0,
      changed: true
    };
  }

  return {
    itemId,
    updates: [quantityUpdate],
    deletes: [],
    consumedQuantity,
    remainingQuantity,
    remainingCharges: 0,
    changed: true
  };
}

/**
 * Commit a consumption plan through the shared atomic inventory executor.
 */
export async function commitInventoryItemConsumption({
  actor = null,
  item = null,
  amount = 1,
  charges = null,
  chargePath = "",
  stackIndex = 0,
  documentOptions = {},
  reason = "consume-item"
} = {}) {
  const owner = actor ?? item?.parent ?? item?.actor ?? null;
  if (!owner || owner.documentName !== "Actor") {
    throw new TypeError("An Actor-owned Item is required for inventory consumption.");
  }

  const plan = planInventoryItemConsumption({
    item,
    amount,
    charges,
    chargePath,
    stackIndex
  });
  if (!plan.changed) return null;

  const { executeInventoryMutation } = await import("./mutation.mjs");
  return executeInventoryMutation({
    actor: owner,
    updates: plan.updates,
    deletes: plan.deletes
  }, {
    reason,
    documentOptions
  });
}

function createQuantityConsumptionUpdate(item, amount, stackIndex) {
  if (usesVirtualInventoryStacks(item)) {
    return createItemStackPartRemovalUpdate(item, amount, stackIndex);
  }
  return {
    _id: getItemId(item),
    "system.quantity": Math.max(0, getItemQuantity(item) - amount)
  };
}

function normalizeConsumptionCharges(charges) {
  const max = Math.max(1, toInteger(charges?.max) || 1);
  const rawValue = charges?.value;
  const value = rawValue === undefined || rawValue === null || rawValue === ""
    ? max
    : Math.max(0, Math.min(max, toInteger(rawValue)));
  return { value, max };
}

function createEmptyConsumptionPlan({ itemId = "", quantity = 0, charges = null } = {}) {
  return {
    itemId,
    updates: [],
    deletes: [],
    consumedQuantity: 0,
    remainingQuantity: Math.max(0, toInteger(quantity)),
    remainingCharges: Math.max(0, toInteger(charges?.value)),
    changed: false
  };
}
