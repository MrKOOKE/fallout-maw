import { SYSTEM_ID } from "../constants.mjs";
import { planTankTokenFootprint } from "./modular-tank-token-footprint.mjs";

export function stripLegacyTankResourceContribution(item, slotId) {
  const free = structuredClone(item?.system?.functions?.freeSettings ?? { enabled: false, entries: [] });
  const key = slotId === "engine" ? "system.resources.power.bonus" : "system.resources.movementPoints.bonus";
  const old = slotId === "engine" ? 120 : 100;
  for (const entry of free.entries ?? []) entry.changes = (entry.changes ?? []).filter(row => !(row.key === key && Number(row.value) === old));
  free.entries = (free.entries ?? []).filter(row => row.changes?.length || row.actions?.length || row.type !== "effectChanges");
  if (!free.entries.length) free.enabled = false;
  return free;
}

/** A distinct construct system replaces only the package's old stat contributions. */
export function planModularTankSystemUpgrade(tank, data, library, changes = {}, pendingUpdates = []) {
  const raw = tank._source ?? tank, items = tank.items?.contents ?? tank.items ?? [];
  const itemUpdates = [], itemCreates = [];
  const sourceSystems = structuredClone(data.tank.system.constructSystems);
  for (const system of sourceSystems) for (const method of system.recoveryMethods) for (const row of method.resources)
    if (row.uuid === data.fuelUuidPlaceholder) row.uuid = library.fuel.uuid;
  const current = structuredClone(raw.system.constructSystems ?? []);
  for (const system of sourceSystems) if (!current.some(row => row.id === system.id)) current.push(system);
  changes["system.constructSystems"] = current;
  if (raw.prototypeToken?.flags?.[SYSTEM_ID]?.rotationSpeedMultiplier === undefined)
    changes[`prototypeToken.flags.${SYSTEM_ID}.rotationSpeedMultiplier`] = data.tank.prototypeToken.flags[SYSTEM_ID].rotationSpeedMultiplier ?? 1 / 3;
  if (raw.prototypeToken?.flags?.[SYSTEM_ID]?.tokenHitbox === undefined)
    changes[`prototypeToken.flags.${SYSTEM_ID}.tokenHitbox`] = structuredClone(data.tank.prototypeToken.flags[SYSTEM_ID].tokenHitbox);
  if (Number(data.revision) >= 9) for (const [key, value] of Object.entries(planTankTokenFootprint(raw.prototypeToken)))
    changes[`prototypeToken.${key}`] = value;
  changes["prototypeToken.texture.scaleX"] = -Math.abs(changes["prototypeToken.texture.scaleX"] ?? raw.prototypeToken.texture.scaleX);
  changes["prototypeToken.texture.scaleY"] = -Math.abs(changes["prototypeToken.texture.scaleY"] ?? raw.prototypeToken.texture.scaleY);
  const slots = structuredClone(changes["system.constructPartSlots"] ?? raw.system.constructPartSlots);
  for (const slotId of ["engine", "chassis"]) {
    const item = items.find(row => {
      const pending = pendingUpdates.find(update => update._id === (row.id ?? row._id));
      const placement = row.system?.placement;
      return (pending?.["system.placement.mode"] ?? placement?.mode) === "constructPart"
        && (pending?.["system.placement.limbKey"] ?? placement?.limbKey) === slotId;
    });
    const template = data.tank.items.find(row => row.system?.placement?.limbKey === slotId);
    if (!item || !template) continue;
    const contribution = structuredClone(template.system.functions.constructPart.systems);
    const pending = pendingUpdates.find(update => update._id === (item.id ?? item._id));
    const staged = pending?.["system.functions.freeSettings"]
      ? { system: { functions: { freeSettings: pending["system.functions.freeSettings"] } } } : item;
    itemUpdates.push({ _id: item.id ?? item._id, "system.functions.constructPart.systems": contribution,
      "system.functions.freeSettings": stripLegacyTankResourceContribution(staged, slotId) });
    const slot = slots.find(row => row.id === slotId); if (slot) slot.profile.constructPart.systems = contribution;
  }
  changes["system.constructPartSlots"] = slots;
  const visual = structuredClone(changes[`flags.${SYSTEM_ID}.constructVisual`] ?? raw.flags[SYSTEM_ID].constructVisual);
  for (const seat of visual.seats) if (seat.role === "driver") {
    seat.functions = Array.from(new Set([...seat.functions, "activate"]));
    seat.systemIds = Array.from(new Set([...(seat.systemIds ?? []), "drive"]));
  }
  changes[`flags.${SYSTEM_ID}.constructVisual`] = visual;
  for (const [key, max] of [["power", 1000], ["movementPoints", 40]]) {
    changes[`system.resources.${key}.max`] = max;
    changes[`system.resources.${key}.value`] = Math.max(0, max - Number(raw.system.resources[key].spent || 0));
  }
  const sourceFuel = data.tank.items.find(row => row._id === "mwtankFuel000001");
  if (sourceFuel && !items.some(row => (row.id ?? row._id) === sourceFuel._id)) {
    const fuel = structuredClone(sourceFuel); fuel.flags[SYSTEM_ID].sourceId = library.fuel.uuid;
    itemCreates.push(fuel);
  }
  return { changes, itemUpdates, itemCreates };
}
