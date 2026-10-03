import { getActorGearItems, isInstalledConstructPartItem, getConstructPartSlotId } from "./construct-parts.mjs";
import { isItemBrokenByCondition } from "./item-functions.mjs";

export function getConstructSystems(actor) {
  return actor?.type === "construct" ? Array.from(actor.system?.constructSystems ?? []).filter(row => row?.id) : [];
}

export function getConstructSystemContributions(actor, systemId) {
  return getActorGearItems(actor).filter(isInstalledConstructPartItem).flatMap(item =>
    Array.from(item.system?.functions?.constructPart?.systems ?? []).filter(row => row.systemId === systemId)
      .map(row => ({ ...row, item, slotId: getConstructPartSlotId(item), broken: isItemBrokenByCondition(item) })));
}

export function getConstructSystemState(actor, systemOrId) {
  const system = typeof systemOrId === "string" ? getConstructSystems(actor).find(row => row.id === systemOrId) : systemOrId;
  if (!system) return null;
  const contributions = getConstructSystemContributions(actor, system.id);
  const providers = contributions.filter(row => row.activationProvider);
  const capacity = contributions.reduce((sum, row) => sum + Math.max(0, Number(row.capacity) || 0), 0);
  const movementPoints = contributions.filter(row => !row.broken).reduce((sum, row) => sum + Math.max(0, Number(row.movementPoints) || 0), 0);
  const functional = capacity > 0 && contributions.some(row => row.capacity > 0 && !row.broken)
    && (!system.requiresActivation || providers.some(row => !row.broken));
  const operational = system.enabled && functional && (!system.requiresActivation || system.active);
  const resource = actor.system?.resources?.[system.resourceKey] ?? {};
  const stored = Math.max(0, Number(resource.value) || 0);
  return { system, contributions, providers, capacity, movementPoints, functional, operational, stored,
    available: operational ? Math.max(0, stored - (Number(resource.min) || 0)) + Math.max(0, Number(resource.once) || 0) : 0 };
}

/** Contributions enter the same base-data phase as native construct effects. The bank survives a shutdown. */
export function prepareConstructSystemBaseData(actor) {
  for (const system of getConstructSystems(actor)) {
    if (!system.enabled) continue;
    const rows = getConstructSystemContributions(actor, system.id);
    const resource = actor.system.resources?.[system.resourceKey];
    if (resource) resource.bonus += rows.reduce((sum, row) => sum + (Number(row.capacity) || 0), 0);
    const movement = actor.system.resources?.movementPoints;
    if (movement && system.movement) movement.bonus += rows.filter(row => !row.broken).reduce((sum, row) => sum + (Number(row.movementPoints) || 0), 0);
  }
}

/** Each configured drive system must supply the cost; overlapping systems cannot bypass one another. */
export function getConstructMovementEnergyState(actor, { resourceLimits = {} } = {}) {
  const systems = getConstructSystems(actor).filter(row => row.movement);
  if (!systems.length) return null;
  const costs = new Map();
  let operational = true;
  for (const system of systems) {
    const state = getConstructSystemState(actor, system);
    operational &&= Boolean(state?.operational && state.movementPoints > 0);
    costs.set(system.resourceKey, (costs.get(system.resourceKey) ?? 0) + Math.max(1, Number(system.energyPerMovementPoint) || 1));
  }
  let budget = operational ? Infinity : 0;
  for (const [key, rate] of costs) {
    const resource = actor.system.resources?.[key];
    const available = Math.max(0, (Number(resource?.value) || 0) - (Number(resource?.min) || 0)
      + (Number(resource?.once) || 0) - (Number(resourceLimits[key]?.amount) || 0));
    budget = Math.min(budget, Math.floor(available / rate));
  }
  return { operational, budget, costs };
}

export function getConstructResourceSupplyLimit(actor, key) {
  const systems = getConstructSystems(actor).filter(row => row.resourceKey === key);
  if (!systems.length || systems.some(row => getConstructSystemState(actor, row)?.operational)) return 0;
  const resource = actor.system.resources?.[key];
  return Math.max(0, Number(resource?.value) || 0) + Math.max(0, Number(resource?.once) || 0);
}

/** Display delivered energy separately from the retained bank; editing still addresses the stored reserve. */
export function decorateConstructResourceAvailability(actor, entry) {
  const systems = getConstructSystems(actor).filter(system => system.resourceKey === entry.key);
  if (!systems.length || systems.some(system => getConstructSystemState(actor, system)?.operational)) return entry;
  return { ...entry, valueLabel: 0, meterValue: 0, blockedAmount: 0, blockedStyle: "",
    fillStyle: `${entry.fillStyle ?? ""}; width: 0%`, oneTimeFillStyle: "width: 0%",
    availabilityNote: `Питание выключено. Сохранённый запас: ${entry.value} / ${entry.max}.` };
}
