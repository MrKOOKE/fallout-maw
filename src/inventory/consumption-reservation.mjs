export const CONSUMPTION_RECEIPT_PATH = "flags.fallout-maw.consumptionReceipt";
export const CONSUMPTION_RECEIPT_OPTION = "falloutMawConsumptionReceiptId";

export function getInventoryConsumptionReceipt(item) {
  const receipt = item?.flags?.["fallout-maw"]?.consumptionReceipt
    ?? item?._source?.flags?.["fallout-maw"]?.consumptionReceipt;
  return receipt && typeof receipt === "object" && receipt.id ? receipt : null;
}

/** Pending uses own their source until the recorded consumption is resolved. */
export function assertInventoryConsumptionReservation(item, options = {}) {
  const receipt = getInventoryConsumptionReceipt(item);
  if (!receipt) return;
  const user = globalThis.game?.user;
  if (String(options?.[CONSUMPTION_RECEIPT_OPTION] ?? "") === String(receipt.id)
    && (user?.isGM || String(user?.id ?? "") === String(receipt.userId ?? ""))) return;
  const error = new Error("Этот предмет ожидает завершения предыдущего применения. Используйте его ещё раз для завершения или обратитесь к ведущему.");
  error.code = "inventory-consumption-reserved";
  throw error;
}
