import { getInstalledConstructPartsBySlot } from "../utils/construct-parts.mjs";
import { getConditionFunction, hasItemFunction, ITEM_FUNCTIONS } from "../utils/item-functions.mjs";
import { toInteger } from "../utils/numbers.mjs";

/** Repair the installed parts which define a construct's health; absent slots and cargo receive nothing. */
export function buildConstructRegenerationUpdates(actor, amount) {
  if (actor?.type !== "construct") return [];
  const targets = Array.from(getInstalledConstructPartsBySlot(actor).values()).flatMap(item => {
    if (!hasItemFunction(item, ITEM_FUNCTIONS.condition, { ignoreBroken: true })) return [];
    const condition = getConditionFunction(item);
    const max = Math.max(0, toInteger(condition.max));
    const current = Math.min(max, Math.max(0, toInteger(condition.value)));
    return current < max ? [{ id: item.id, current, missing: max - current }] : [];
  });
  const { allocations } = distributeRegeneration(targets, amount);
  return targets.flatMap(target => {
    const healed = allocations.get(target.id) ?? 0;
    return healed > 0 ? [{ _id: target.id, "system.functions.condition.value": target.current + healed }] : [];
  });
}

export function distributeRegeneration(entries, amount) {
  const allocations = new Map(entries.map(entry => [entry.id, 0]));
  let remaining = Math.max(0, toInteger(amount));
  let active = entries
    .map(entry => ({ ...entry, missing: Math.max(0, toInteger(entry.missing)) }))
    .filter(entry => entry.missing > 0);
  while (remaining > 0 && active.length) {
    const share = Math.floor(remaining / active.length);
    const extra = remaining % active.length;
    let spent = 0;
    const nextActive = [];
    for (const [index, entry] of active.entries()) {
      const portion = share + (index < extra ? 1 : 0);
      const applied = Math.min(entry.missing, portion);
      if (applied > 0) {
        allocations.set(entry.id, toInteger(allocations.get(entry.id)) + applied);
        entry.missing -= applied;
        spent += applied;
      }
      if (entry.missing > 0) nextActive.push(entry);
    }
    if (spent <= 0) break;
    remaining -= spent;
    active = nextActive;
  }
  return { allocations, remaining };
}
