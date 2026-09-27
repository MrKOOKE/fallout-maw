import { planInventoryItemConsumption } from "./consume.mjs";
import { getFirstAidChargesData, getNeedChangeChargesData } from "../utils/item-functions.mjs";
import { getItemQuantity } from "../utils/inventory-containers.mjs";
import { CONSUMPTION_RECEIPT_OPTION, CONSUMPTION_RECEIPT_PATH, getInventoryConsumptionReceipt } from "./consumption-reservation.mjs";

const CHANNEL = "system.fallout-maw";
const SCOPE = "fallout-maw.consumptionReceipt";
const pending = new Map();
const queues = new Map();
const activeUses = new Set();
let registeredSocket = null;

export function registerConsumptionReceiptSocket() {
  if (!game.socket || registeredSocket === game.socket) return;
  registeredSocket = game.socket;
  game.socket.on(CHANNEL, handleConsumptionReceiptMessage);
}

/** A retry settles a recorded cost; it never repeats the effects or a check. */
export async function recoverInventoryConsumption(item) {
  const receipt = getInventoryConsumptionReceipt(item);
  if (!receipt) return { handled: false, result: false };
  if (activeUses.has(receipt.id)) {
    ui.notifications.warn("Предмет уже применяется. Дождитесь завершения действия.");
    return { handled: true, result: false };
  }
  if (receipt.phase === "completed") {
    assertReceiptSource(item, receipt);
    if (!isConsumptionCostPersisted(item, receipt)) {
      throw new Error("Сохранённый расход предмета не подтверждён. Ведущий должен проверить предмет.");
    }
    await acknowledgeCompletedConsumption(item, receipt.id);
    ui.notifications.info("Предыдущее применение уже оплачено. Повторного эффекта нет.");
    return { handled: true, result: true };
  }
  if (receipt.phase === "applied") {
    await requestReceiptAction(item, "finalize", { receiptId: receipt.id });
    await acknowledgeCompletedConsumption(item, receipt.id);
    ui.notifications.info("Предыдущее применение завершено. Повторного эффекта нет.");
    return { handled: true, result: true };
  }
  if (game.user?.isGM && foundry.applications?.api?.DialogV2?.wait) {
    const outcome = await foundry.applications.api.DialogV2.wait({
      window: { title: "Незавершённое применение предмета" },
      content: "<p>Предыдущее применение не завершено. Убедитесь, что выполнявший его игрок остановил действие, проверьте состояние цели и выберите результат. Эффекты повторно не применяются.</p>",
      buttons: [
        { action: "consumed", label: "Эффект применён — списать предмет", callback: () => "consumed" },
        { action: "cancelled", label: "Эффекта не было — освободить предмет", callback: () => "cancelled" },
        { action: "close", label: "Оставить до проверки", callback: () => null }
      ],
      rejectClose: false
    });
    if (outcome) {
      await resolveInventoryConsumptionReceipt(item, { outcome });
      return { handled: true, result: outcome === "consumed" };
    }
  } else {
    ui.notifications.warn("Предыдущее применение предмета не завершено. Ведущий должен проверить эффект и завершить списание либо освободить предмет.");
  }
  return { handled: true, result: false };
}

/** Explicit GM recovery for an interrupted/indeterminate target operation. */
export async function resolveInventoryConsumptionReceipt(item, { outcome } = {}) {
  if (!game.user?.isGM) throw new Error("Только ведущий может разрешить прерванное применение.");
  if (!["consumed", "cancelled"].includes(outcome)) throw new TypeError("Choose consumed or cancelled.");
  const receipt = getInventoryConsumptionReceipt(item);
  if (!receipt) return false;
  await requestReceiptAction(item, "resolve", { receiptId: receipt.id, outcome });
  if (outcome === "consumed") await acknowledgeCompletedConsumption(item, receipt.id);
  return true;
}

/**
 * Persist the immutable cost before the first side effect. A failed final save
 * leaves an applied receipt; a retry only settles that cost. Target mutations
 * are never rolled back from broad snapshots, which could overwrite reactions
 * or another user's edits.
 */
export async function runInventoryConsumption({ item, kind, amount = 1, targetActor = null, documentOptions = {} }, operation) {
  const receipt = await requestReceiptAction(item, "reserve", {
    kind, amount, targetActorUuid: String(targetActor?.uuid ?? ""),
    chainRef: documentOptions.falloutMawSystemEventChainRef ?? documentOptions.chainRef ?? null
  });
  activeUses.add(receipt.id);
  try {
    let effectsStarted = false;
    let result;
    try {
      result = await operation({ receipt, markEffectsStarted() { effectsStarted = true; } });
    } catch (error) {
      // Before dispatching any target operation a rejected roll/other preparation
      // cannot have changed the target through this use. Once dispatched, a socket
      // timeout may mean a remote write succeeded: retain the receipt for review.
      await requestReceiptAction(item, effectsStarted ? "uncertain" : "release", { receiptId: receipt.id })
        .catch(recoveryError => console.error("fallout-maw | Consumable receipt remains reserved", recoveryError));
      if (effectsStarted) ui.notifications.warn("Применение прервано. Предмет сохранён до проверки ведущим; повторного эффекта не будет.");
      throw error;
    }
    if (result === false) {
      await requestReceiptAction(item, effectsStarted ? "uncertain" : "release", { receiptId: receipt.id });
      return false;
    }
    // Persist this phase separately so failure of the subsequent inventory batch
    // is recoverable after reconnect. If this write itself fails, reserved stays
    // fail-closed and requires the GM to establish whether the effects occurred.
    await requestReceiptAction(item, "applied", { receiptId: receipt.id });
    await requestReceiptAction(item, "finalize", { receiptId: receipt.id });
    await acknowledgeCompletedConsumption(item, receipt.id);
    return result;
  } finally {
    activeUses.delete(receipt.id);
  }
}

async function acknowledgeCompletedConsumption(item, receiptId) {
  // Only clear the tombstone after the finalization reply reached this caller.
  // A lost reply must leave a completed receipt for a no-effect/no-cost retry.
  if (getInventoryConsumptionReceipt(item)?.phase !== "completed") return;
  await requestReceiptAction(item, "acknowledge", { receiptId }).catch(error => {
    console.warn("fallout-maw | Consumption completed; acknowledgement is pending", error);
  });
}

async function requestReceiptAction(item, action, data = {}) {
  registerConsumptionReceiptSocket();
  const authority = getAuthority(item);
  if (!authority) throw new Error("Нет подключённого владельца для завершения применения предмета.");
  const payload = { itemUuid: item.uuid, ...data };
  if (authority.id === game.user?.id) return executeReceiptAction(action, payload, game.user);
  const requestId = foundry.utils.randomID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error("Не получено подтверждение применения предмета. Не повторяйте эффект; проверьте состояние с ведущим."));
    }, 15000);
    pending.set(requestId, { resolve, reject, timer, authorityId: authority.id });
    game.socket.emit(CHANNEL, { scope: SCOPE, action: "request", operation: action, requestId,
      requesterUserId: game.user.id, targetUserId: authority.id, payload });
  });
}

async function handleConsumptionReceiptMessage(message = {}, senderUserId = "") {
  if (message.scope !== SCOPE || message.targetUserId !== game.user?.id) return;
  const sender = game.users?.get?.(String(senderUserId));
  if (!sender) return;
  if (message.action === "response") {
    const entry = pending.get(message.requestId);
    if (!entry || entry.authorityId !== sender.id) return;
    pending.delete(message.requestId);
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new Error(String(message.error || "Не удалось завершить применение предмета.")));
    return;
  }
  if (message.action !== "request" || sender.id !== message.requesterUserId) return;
  try {
    const result = await executeReceiptAction(message.operation, message.payload, sender);
    game.socket.emit(CHANNEL, { scope: SCOPE, action: "response", requestId: message.requestId,
      targetUserId: sender.id, ok: true, result });
  } catch (error) {
    game.socket.emit(CHANNEL, { scope: SCOPE, action: "response", requestId: message.requestId,
      targetUserId: sender.id, ok: false, error: error.message });
  }
}

function executeReceiptAction(action, payload = {}, requester) {
  const key = String(payload.itemUuid ?? "");
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const item = await fromUuid(key);
    if (!item || item.documentName !== "Item" || item.parent?.documentName !== "Actor") {
      throw new Error("Предмет больше не находится в инвентаре.");
    }
    if (getAuthority(item)?.id !== game.user?.id) throw new Error("Применение должен завершить ответственный ведущий или владелец.");
    if (!canOwn(item.parent, requester)) throw new Error("Нет доступа к исходному предмету.");
    let receipt = getInventoryConsumptionReceipt(item);
    if (action === "reserve") {
      if (receipt) throw new Error("Предыдущее применение этого предмета ещё не завершено.");
      const kind = String(payload.kind ?? "");
      if (!["needChange", "firstAid"].includes(kind)) throw new TypeError("Unknown consumable kind.");
      const amount = Math.max(1, Math.trunc(Number(payload.amount) || 1));
      const charges = kind === "firstAid" ? getFirstAidChargesData(item) : getNeedChangeChargesData(item);
      if (charges.value < amount) throw new Error("Недостаточно зарядов предмета.");
      const quote = planInventoryItemConsumption({ item, amount, charges,
        chargePath: `system.functions.${kind}.charges.value` });
      if (!quote.changed) throw new Error("Предмет израсходован.");
      receipt = { id: foundry.utils.randomID(), phase: "reserved", kind, amount,
        userId: game.user.id, requesterUserId: requester.id, sourceActorUuid: item.parent.uuid,
        itemUuid: item.uuid, targetActorUuid: String(payload.targetActorUuid ?? ""),
        createdAt: Date.now(), quote: { updates: quote.updates, deletes: quote.deletes,
          remainingQuantity: quote.remainingQuantity, remainingCharges: quote.remainingCharges,
          chargeMax: charges.max, chargePath: `system.functions.${kind}.charges.value` },
        source: documentFingerprint(item, true), chainRef: payload.chainRef ?? null };
      await writeReceipt(item, receipt);
      return receipt;
    }
    if (!receipt || receipt.id !== payload.receiptId) throw new Error("Запись предыдущего применения отсутствует или изменилась.");
    if (!requester.isGM && (receipt.requesterUserId ?? receipt.userId) !== requester.id) throw new Error("Применение принадлежит другому пользователю.");
    if (action === "resolve") {
      if (!requester.isGM) throw new Error("Только ведущий может разрешить прерванное применение.");
      if (payload.outcome === "cancelled") return writeReceipt(item, null, receipt.id);
      if (payload.outcome !== "consumed") throw new TypeError("Unknown recovery outcome.");
    }
    assertReceiptSource(item, receipt);
    if (action === "resolve") {
      if (receipt.phase === "completed") action = "acknowledge";
      else {
        receipt = { ...receipt, phase: "applied" };
        await writeReceipt(item, receipt);
        action = "finalize";
      }
    }
    if (action === "acknowledge") {
      if (receipt.phase !== "completed") throw new Error("Расход предмета ещё не завершён.");
      if (!isConsumptionCostPersisted(item, receipt)) {
        throw new Error("Сохранённый расход предмета не подтверждён. Ведущий должен проверить предмет.");
      }
      return writeReceipt(item, null, receipt.id);
    }
    if (action === "release") {
      if (receipt.phase !== "reserved") throw new Error("Применённый эффект должен быть завершён списанием.");
      return writeReceipt(item, null, receipt.id);
    }
    if (action === "applied" || action === "uncertain") {
      if (receipt.phase !== "reserved") throw new Error("Состояние применения уже изменилось.");
      return writeReceipt(item, { ...receipt, phase: action });
    }
    if (action !== "finalize" || receipt.phase !== "applied") throw new Error("Результат применения требует проверки ведущим.");
    if (documentFingerprint(item, true) !== receipt.source) throw new Error("Зарезервированный предмет изменился. Ведущий должен проверить расход.");
    const { executeInventoryMutation } = await import("./mutation.mjs");
    const updates = receipt.quote.updates.map(update => ({ ...update,
      [CONSUMPTION_RECEIPT_PATH]: { ...receipt, phase: "completed" } }));
    await executeInventoryMutation({ actor: item.parent, updates, deletes: receipt.quote.deletes }, {
      reason: `${receipt.kind}-consume`,
      documentOptions: { [CONSUMPTION_RECEIPT_OPTION]: receipt.id,
        ...(receipt.chainRef ? { chainRef: receipt.chainRef, falloutMawSystemEventChainRef: receipt.chainRef } : {}) }
    });
    return true;
  }).finally(() => { if (queues.get(key) === next) queues.delete(key); });
  queues.set(key, next);
  return next;
}

async function writeReceipt(item, receipt, id = receipt?.id) {
  const result = await item.update({ [CONSUMPTION_RECEIPT_PATH]: receipt }, { [CONSUMPTION_RECEIPT_OPTION]: id });
  const current = getInventoryConsumptionReceipt(item);
  if (!result || (receipt ? current?.id !== receipt.id || current.phase !== receipt.phase : current)) {
    throw new Error("Не удалось сохранить состояние применения предмета.");
  }
  return receipt;
}

function getAuthority(item) {
  const users = Array.from(game.users?.contents ?? game.users?.values?.() ?? []);
  const gms = users.filter(user => user.active && user.isGM).sort((a, b) => a.id.localeCompare(b.id));
  if (game.users?.activeGM?.active) return game.users.activeGM;
  if (gms.length) return gms[0];
  return users.filter(user => user.active && canOwn(item.parent, user)).sort((a, b) => a.id.localeCompare(b.id))[0]
    ?? (game.user?.isGM ? game.user : null);
}

function canOwn(actor, user) {
  return Boolean(user?.isGM || actor?.testUserPermission?.(user, "OWNER"));
}

function documentFingerprint(document, omitReceipt = false) {
  const data = foundry.utils.deepClone(document?.toObject?.() ?? document?._source ?? {});
  delete data._stats;
  if (omitReceipt) {
    if (data.flags?.["fallout-maw"]) {
      delete data.flags["fallout-maw"].consumptionReceipt;
      if (!Object.keys(data.flags["fallout-maw"]).length) delete data.flags["fallout-maw"];
    }
    if (data.flags && !Object.keys(data.flags).length) delete data.flags;
  }
  return stableFingerprint(data);
}

function isConsumptionCostPersisted(item, receipt) {
  // Native Item pre-update normalizes related stack/placement fields. Verify
  // the quoted cost instead of comparing its entire predicted source object.
  const quote = receipt.quote;
  if (getItemQuantity(item) !== quote.remainingQuantity) return false;
  return quote.chargeMax <= 1
    || Number(foundry.utils.getProperty(item._source ?? item, quote.chargePath)) === quote.remainingCharges;
}

function assertReceiptSource(item, receipt) {
  if (receipt.itemUuid === item.uuid && receipt.sourceActorUuid === item.parent?.uuid) return;
  const error = new Error("Источник прерванного применения перемещён или скопирован. Ведущий должен проверить исходный предмет.");
  error.code = "inventory-consumption-source-changed";
  throw error;
}

function stableFingerprint(data) {
  const sort = value => Array.isArray(value) ? value.map(sort) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;
  return JSON.stringify(sort(data));
}
