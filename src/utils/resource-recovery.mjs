import { planInventoryItemConsumption } from "../inventory/consume.mjs";
import { resolveWorldItemSync } from "./world-items.mjs";
import { canStackInventoryItems } from "../inventory/stacking.mjs";
import { getItemQuantity, isContainerItem, isItemLocked } from "./inventory-containers.mjs";

/** Plan a whole recipe against actual inventory stacks. Alternative recipes never consume each other's stock. */
export function planResourceRecovery(sourceActor, method, { current = 0, max = 0, resourceIndex = null } = {}) {
  const amount = method?.recoveryMode === "amount" ? Number(method.recovery) : Number(max) * Number(method?.recovery) / 100;
  const restored = Math.min(Math.max(0, Number(max) - Number(current)), Math.max(0, Math.floor(amount || 0)));
  if (!restored) return { ok: false, reason: "Запас уже полон или восстановление равно нулю." };
  const rows = Array.from(method?.resources ?? []).filter(row => row.uuid && Number(row.quantity) > 0);
  if (!rows.length) return { ok: false, reason: "Не заданы расходуемые ресурсы." };
  const items = Array.from(sourceActor?.items?.contents ?? sourceActor?.items ?? []).filter(item =>
    item.type === "gear" && String(item.system?.placement?.mode ?? "inventory") === "inventory"
      && !isContainerItem(item) && !isItemLocked(item));
  const tryRows = selected => {
    const remaining = new Map(items.map(item => [item.id ?? item._id, getItemQuantity(item)]));
    const spent = new Map();
    for (const row of selected) {
      const prototype = resolveWorldItemSync(row.uuid);
      if (!prototype) return null;
      let need = Math.max(1, Math.trunc(Number(row.quantity) || 1));
      for (const item of items) {
        if (!canStackInventoryItems(prototype, item)) continue;
        const id = item.id ?? item._id;
        const take = Math.min(need, remaining.get(id));
        remaining.set(id, remaining.get(id) - take);
        spent.set(id, (spent.get(id) ?? 0) + take);
        need -= take;
        if (!need) break;
      }
      if (need) return null;
    }
    const updates = [], deletes = [];
    for (const [id, count] of spent) {
      if (!count) continue;
      const consumption = planInventoryItemConsumption({ item: items.find(item => (item.id ?? item._id) === id), amount: count });
      updates.push(...consumption.updates); deletes.push(...consumption.deletes);
    }
    return { ok: true, restored, updates, deletes, selected, spent: Object.fromEntries(spent) };
  };
  if (method.mode === "all") return tryRows(rows) ?? { ok: false, reason: "Не хватает ресурсов для всего набора." };
  if (resourceIndex !== null) {
    const selected = method.resources?.[Number(resourceIndex)];
    return selected && tryRows([selected]) || { ok: false, reason: "Выбранного ресурса недостаточно." };
  }
  for (const row of rows) { const plan = tryRows([row]); if (plan) return plan; }
  return { ok: false, reason: "Нет подходящего ресурса в инвентаре." };
}
