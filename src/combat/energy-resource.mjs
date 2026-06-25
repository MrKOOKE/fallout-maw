import { toInteger } from "../utils/numbers.mjs";

export const ENERGY_RESOURCE_KEY = "power";
const RESOURCE_BLOCK_FLAG_SCOPE = "fallout-maw";
const RESOURCE_BLOCK_FLAG_KEY = "damageEffect";
const RESOURCE_BLOCK_KINDS = new Set(["resourceLimit", "resourceBlock"]);

export function getActorEnergy(actor) {
  return Math.max(0, toInteger(actor?.system?.resources?.[ENERGY_RESOURCE_KEY]?.value));
}

export function getActorAvailableEnergy(actor) {
  const resource = actor?.system?.resources?.[ENERGY_RESOURCE_KEY];
  const min = Math.max(0, toInteger(resource?.min));
  return Math.max(min, getActorEnergy(actor) - getActorBlockedEnergy(actor));
}

export function canActorSpendEnergy(actor, cost = 0) {
  const resource = actor?.system?.resources?.[ENERGY_RESOURCE_KEY];
  return getActorAvailableEnergy(actor) - Math.max(0, toInteger(cost)) >= Math.max(0, toInteger(resource?.min));
}

function getActorBlockedEnergy(actor) {
  let total = 0;
  for (const effect of actor?.effects ?? []) {
    if (effect?.disabled) continue;
    const data = effect.getFlag?.(RESOURCE_BLOCK_FLAG_SCOPE, RESOURCE_BLOCK_FLAG_KEY);
    if (!RESOURCE_BLOCK_KINDS.has(String(data?.kind ?? ""))) continue;
    total += Math.max(0, toInteger(data?.resources?.[ENERGY_RESOURCE_KEY]));
  }
  return total;
}
