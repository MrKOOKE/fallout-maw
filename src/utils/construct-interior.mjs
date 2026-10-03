import { getConstructPartSlots, getInstalledConstructPartForSlot } from "./construct-parts.mjs";

export const CONSTRUCT_INTERIOR_FLAG = "constructInterior";

/** Physical containment is independent of artwork and visual anchor parenting.
 * All operations are read-only; removed slot references survive reinstallation. */
export function normalizeConstructInterior(raw = {}, { slotIds = null } = {}) {
  const known = slotIds === null ? null : new Set(Array.from(slotIds, canonicalSlotId).filter(Boolean));
  const parts = [], byId = new Map();
  for (const row of Array.isArray(raw?.parts) ? raw.parts.slice(0, 1024) : []) {
    const slotId = canonicalSlotId(row?.slotId);
    if (!slotId || byId.has(slotId) || known && !known.has(slotId)) continue;
    const part = { slotId, parentSlotId: canonicalSlotId(row?.parentSlotId) };
    parts.push(part);
    byId.set(slotId, part);
  }
  // An Actor supplies every physical slot, including exterior defaults. A
  // standalone config can only refer to slots actually present in its rows.
  const ids = known ?? new Set(parts.map(row => row.slotId));
  for (const slotId of ids) if (!byId.has(slotId)) {
    const part = { slotId, parentSlotId: "" };
    parts.push(part);
    byId.set(slotId, part);
  }
  for (const row of parts) if (row.parentSlotId === row.slotId || !byId.has(row.parentSlotId)) row.parentSlotId = "";
  const visiting = new Set(), resolved = new Set();
  const resolve = slotId => {
    if (resolved.has(slotId)) return;
    visiting.add(slotId);
    const row = byId.get(slotId);
    if (row?.parentSlotId) {
      if (visiting.has(row.parentSlotId)) row.parentSlotId = "";
      else resolve(row.parentSlotId);
    }
    visiting.delete(slotId);
    resolved.add(slotId);
  };
  for (const row of parts) resolve(row.slotId);
  return { version: 1, parts };
}

export function getConstructInteriorConfig(actorOrConfig = null) {
  const actor = isActor(actorOrConfig);
  const raw = actorOrConfig?.getFlag?.("fallout-maw", CONSTRUCT_INTERIOR_FLAG)
    ?? actorOrConfig?.flags?.["fallout-maw"]?.[CONSTRUCT_INTERIOR_FLAG]
    ?? actorOrConfig?._source?.flags?.["fallout-maw"]?.[CONSTRUCT_INTERIOR_FLAG]
    ?? (actor ? {} : actorOrConfig);
  return normalizeConstructInterior(raw, actor ? { slotIds: getConstructPartSlots(actorOrConfig).map(slot => slot.id) } : {});
}

export function getConstructPartParentSlotId(actorOrConfig, slotId) {
  return getConstructInteriorConfig(actorOrConfig).parts.find(row => row.slotId === canonicalSlotId(slotId))?.parentSlotId ?? "";
}

/** Outer compartment first, target last. Missing physical slots are invalid;
 * known but uninstalled slots remain in the path so damage can skip their armor. */
export function getConstructPartContainmentPath(actorOrConfig, slotId) {
  const config = getConstructInteriorConfig(actorOrConfig);
  const byId = new Map(config.parts.map(row => [row.slotId, row]));
  const path = [], seen = new Set();
  let current = canonicalSlotId(slotId);
  while (current && byId.has(current) && !seen.has(current)) {
    path.unshift(current);
    seen.add(current);
    current = byId.get(current).parentSlotId;
  }
  return path;
}

/** Only physically present parts are targetable outside. Removing an outer
 * shell exposes its remaining contents without deleting their saved placement. */
export function getConstructExteriorSlotIds(actor) {
  const config = getConstructInteriorConfig(actor);
  const installed = new Set(config.parts.filter(row => getInstalledConstructPartForSlot(actor, row.slotId)).map(row => row.slotId));
  return config.parts.filter(row => installed.has(row.slotId)
    && !getConstructPartContainmentPath(config, row.slotId).slice(0, -1).some(id => installed.has(id))).map(row => row.slotId);
}

/** Direct children include removed intermediate shells (item:null), allowing
 * callers to traverse through them to still-installed nested contents. */
export function getConstructCompartmentContents(actor, slotId) {
  const id = canonicalSlotId(slotId);
  const config = getConstructInteriorConfig(actor);
  if (!id || !config.parts.some(row => row.slotId === id)) return { parts: [], passengers: [] };
  const parts = config.parts.filter(row => row.parentSlotId === id).map(row => ({ ...row,
    item: getInstalledConstructPartForSlot(actor, row.slotId) }));
  const container = getInstalledConstructPartForSlot(actor, id);
  const fn = container?.system?.functions?.actorContainer;
  const seats = fn?.enabled && Array.isArray(fn.slots) ? fn.slots : [];
  const physical = new Map(seats.filter(seat => seat?.id && Number(seat.quantity) > 0)
    .map(seat => [`${container.id}:${seat.id}`, Math.max(0, Math.trunc(Number(seat.quantity)))]));
  const rawPassengers = actor?.getFlag?.("fallout-maw", "actorContainer")?.passengers
    ?? actor?.flags?.["fallout-maw"]?.actorContainer?.passengers
    ?? actor?._source?.flags?.["fallout-maw"]?.actorContainer?.passengers ?? [];
  const passengers = (Array.isArray(rawPassengers) ? rawPassengers : []).filter(passenger => passenger?.actorUuid
    && physical.has(String(passenger.slotId)) && Number(passenger.slotIndex ?? 0) >= 0
    && Number(passenger.slotIndex ?? 0) < physical.get(String(passenger.slotId)));
  return { parts, passengers };
}

function canonicalSlotId(value) { return String(value ?? "").trim().replace(/^constructPart[:.]/, "").slice(0, 1000); }
function isActor(value) { return Boolean(value?.documentName === "Actor" || value?.type === "construct" || value?._source?.type === "construct" || value?.items && value?.system); }
