import { toInteger } from "../utils/numbers.mjs";

export const ENERGY_RESOURCE_KEY = "power";

export function getActorEnergy(actor) {
  return Math.max(0, toInteger(actor?.system?.resources?.[ENERGY_RESOURCE_KEY]?.value));
}

export function canActorSpendEnergy(actor, cost = 0) {
  const resource = actor?.system?.resources?.[ENERGY_RESOURCE_KEY];
  return getActorEnergy(actor) - Math.max(0, toInteger(cost)) >= Math.max(0, toInteger(resource?.min));
}
