import { SYSTEM_ID } from "../constants.mjs";
import { createInventoryPlacementPlanner, getContainerInventoryGridOptions, getContextInventoryItems } from "../utils/inventory-containers.mjs";

const LEFT_ID = "mwtankGuns000001";
const RIGHT_ID = "mwtankGunR000001";
const RESERVE_ID = "mwtankAmmo000001";
const clone = value => structuredClone(value);
const source = item => item?._source ?? item;
const itemId = item => String(item?.id ?? item?._id ?? "");

/** Compare saved sources without treating schema-injected undefined as a user edit. */
export function equalTankSources(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const optionalDefault = (key, value) => ["muzzleAnchorId", "operatorPartSlotId"].includes(key) && value === ""
    || key === "requiresOperator" && value === false
    || ["specialProperties", "regionSpecialProperties"].includes(key) && Array.isArray(value) && value.length === 0;
  const keys = Object.keys(a).filter(key => a[key] !== undefined && !optionalDefault(key, a[key]));
  const other = Object.keys(b).filter(key => b[key] !== undefined && !optionalDefault(key, b[key]));
  return keys.length === other.length && keys.every(key => other.includes(key) && equalTankSources(a[key], b[key]));
}

/** Foundry persists enabled functions sparsely; disabled schema defaults have no active profile. */
export function getActiveTankFunctionProfiles(functions = {}) {
  return Object.fromEntries(Object.entries(functions).flatMap(([key, value]) => {
    if (key === "additionalWeapons") {
      const enabled = Object.fromEntries(Object.entries(value ?? {}).filter(([, fn]) => fn?.enabled === true));
      return Object.keys(enabled).length ? [[key, enabled]] : [];
    }
    return value?.enabled === true ? [[key, value]] : [];
  }));
}

/** Apply the delivered Pokoritel profile without resetting crew or unrelated resources. */
export function planModularTankGunUpgrade(tank, data, library, { changes: precedingChanges = {} } = {}) {
  const raw = source(tank);
  const items = tank.items?.contents ?? (Array.isArray(tank.items) ? tank.items : raw.items ?? []);
  const gun = items.find(item => itemId(item) === LEFT_ID);
  const right = items.find(item => itemId(item) === RIGHT_ID);
  const names = data.productionNames?.parts ?? {};
  const changes = { name: data.productionNames?.actor ?? data.tank.name,
    "prototypeToken.name": data.productionNames?.actor ?? data.tank.name,
    "prototypeToken.flags.fallout-maw.movementAutoRotate": "on",
    "system.description": data.tank.system.description };
  const itemUpdates = [];
  const deleteIds = [];
  const slots = clone(precedingChanges["system.constructPartSlots"] ?? raw.system?.constructPartSlots ?? []);
  let consolidatedGun = false;
  if (gun?.system?.placement?.mode === "constructPart" && ["cannons", "cannon-left"].includes(gun.system.placement.limbKey)) {
    const actual = source(gun);
    const combine = right?.system?.placement?.mode === "constructPart" && right.system.placement.limbKey === "cannon-right";
    const update = { _id: LEFT_ID, name: names.cannons,
      "system.description": data.tank.items.find(item => item._id === LEFT_ID).system.description,
      "system.placement.limbKey": "cannons", "system.placement.constructPartOrder": 4,
      "system.functions.weapon.requiresOperator": true,
      "system.functions.weapon.operatorPartSlotId": "turret", "system.functions.weapon.muzzleAnchorId": "muzzle-center",
      "system.functions.weapon.magazine.max": 2,
      "system.functions.weapon.magazine.value": Math.min(2, Math.max(0, Number(actual.system.functions.weapon.magazine?.value) || 0)
        + (combine ? Math.max(0, Number(right.system.functions.weapon.magazine?.value) || 0) : 0)),
      "system.functions.weapon.availableActions.burst": true,
      "system.functions.weapon.availableActions.volley": true,
      "system.functions.weapon.availableActions.reload": true,
      "system.functions.weapon.availableActions.snapshot": false,
      "system.functions.weapon.availableActions.aimedShot": false,
      "system.functions.weapon.burst.count": 2,
      "system.functions.weapon.burst.name": "Очередь", "system.functions.weapon.volley.name": "Залп" };
    if (library.parts?.get("cannons")?.uuid) update["flags.fallout-maw.sourceId"] = library.parts.get("cannons").uuid;
    if (combine) {
      for (const key of ["value", "max"]) update["system.functions.condition." + key]
        = Math.max(0, Number(actual.system.functions.condition[key]) || 0) + Math.max(0, Number(right.system.functions.condition[key]) || 0);
      deleteIds.push(RIGHT_ID); consolidatedGun = true;
    }
    itemUpdates.push(update);
  }
  for (const item of items) {
    const slotId = item.system?.placement?.limbKey;
    if (slotId === "cannons" || slotId === "cannon-left" || deleteIds.includes(itemId(item))) continue;
    if (item.system?.placement?.mode === "constructPart" && names[slotId]) {
      const update = { _id: itemId(item), name: names[slotId] };
      update["system.description"] = data.tank.items.find(row => row.system?.placement?.limbKey === slotId)?.system.description
        ?? item.system.description;
      itemUpdates.push(update);
    }
  }
  const finalSlots = slots.filter(slot => slot.id !== "cannon-right").map(slot => {
    if (slot.id === "cannon-left") slot.id = "cannons";
    if (names[slot.id] && slot.profile) slot.profile.name = names[slot.id];
    if (slot.id === "cannons" && slot.profile && gun) slot.profile.conditionMax
      = Math.max(0, Number(gun.system.functions.condition.max) || 0)
        + (deleteIds.length ? Math.max(0, Number(right.system.functions.condition.max) || 0) : 0);
    return slot;
  });
  changes["system.constructPartSlots"] = finalSlots;
  const visual = clone(precedingChanges["flags.fallout-maw.constructVisual"] ?? raw.flags?.[SYSTEM_ID]?.constructVisual);
  if (visual) {
    const template = data.tank.flags[SYSTEM_ID].constructVisual;
    const paired = template.parts.find(part => part.slotId === "cannons");
    visual.parts = (visual.parts ?? []).filter(part => part.slotId !== "cannon-right").map(part => {
      if (part.slotId === "cannon-left") return { ...part, ...clone(paired) };
      if (["turret", "cannons"].includes(part.slotId)) return { ...part, muzzleAnchorId: "muzzle-center" };
      return part;
    });
    const left = visual.anchors?.find(anchor => anchor.id === "muzzle-left");
    const rightAnchor = visual.anchors?.find(anchor => anchor.id === "muzzle-right");
    const center = left && rightAnchor ? { ...clone(left), id: "muzzle-center", name: "Между стволами",
      x: (left.x + rightAnchor.x) / 2, y: (left.y + rightAnchor.y) / 2 }
      : clone(template.anchors.find(anchor => anchor.id === "muzzle-center"));
    if (Math.abs(center.x) < 1e-12) center.x = 0;
    visual.anchors = (visual.anchors ?? []).filter(anchor => !["muzzle-left", "muzzle-right", "muzzle-center"].includes(anchor.id));
    visual.anchors.push(center);
    for (const anchor of visual.anchors) if (["cannon-left", "cannon-right"].includes(anchor.parentSlotId)) anchor.parentSlotId = "cannons";
    for (const seat of visual.seats ?? []) if (["cannon-left", "cannon-right"].includes(seat.partSlotId)) seat.partSlotId = "cannons";
    changes["flags.fallout-maw.constructVisual"] = visual;
  }
  const interior = clone(precedingChanges["flags.fallout-maw.constructInterior"] ?? raw.flags?.[SYSTEM_ID]?.constructInterior);
  if (interior) {
    const seen = new Set();
    interior.parts = (interior.parts ?? []).flatMap(row => {
      const mapped = { ...row, slotId: ["cannon-left", "cannon-right"].includes(row.slotId) ? "cannons" : row.slotId,
        parentSlotId: ["cannon-left", "cannon-right"].includes(row.parentSlotId) ? "cannons" : row.parentSlotId };
      if (seen.has(mapped.slotId)) return []; seen.add(mapped.slotId); return [mapped];
    });
    changes["flags.fallout-maw.constructInterior"] = interior;
  }
  const reserve = planTankReserveUpgrade(items, data, library);
  itemUpdates.push(...reserve.itemUpdates);
  return { changes, itemUpdates, itemCreates: reserve.itemCreates, deleteIds, consolidatedGun,
    splitGuns: false, retainedCustomGunVisuals: false,
    convertedReserve: reserve.convertedReserve, retainedReserveReason: reserve.retainedReserveReason };
}

function planTankReserveUpgrade(items, data, library) {
  const empty = reason => ({ itemUpdates: [], itemCreates: [], convertedReserve: false, retainedReserveReason: reason });
  const reserve = source(items.find(item => itemId(item) === RESERVE_ID));
  if (!reserve) return empty("missing");
  const old = data.legacyDefaults?.stockReserveBeforeRevision5;
  const knownUuids = [data.legacyDefaults?.stockReservePrototypeUuid, library.legacyShell?.uuid].filter(Boolean);
  if (!old || reserve.system?.placement?.mode !== "inventory"
    || ![old.name, data.legacyDefaults?.shellName].includes(reserve.name)
    || !knownUuids.includes(reserve.flags?.[SYSTEM_ID]?.damageSourcePrototypeUuid)
    || !equalTankSources(getActiveTankFunctionProfiles(reserve.system.functions), getActiveTankFunctionProfiles(old.system.functions))
    || !equalTankSources(reserve.effects ?? [], old.effects ?? [])
    || ["weight", "price", "maxStack", "itemCategory", "craft"].some(key => !equalTankSources(reserve.system[key], old.system[key]))) return empty("custom");
  const parentId = reserve.system.container?.parentId ?? "";
  const parent = items.find(item => itemId(item) === parentId);
  if (!parent) return empty("missing-container");
  const grid = getContainerInventoryGridOptions(parent);
  const others = items.filter(item => itemId(item) !== RESERVE_ID);
  const planner = createInventoryPlacementPlanner(getContextInventoryItems(parentId, others), grid.columns, grid.rows, others, [], grid);
  if (!planner) return empty("no-space");
  const quantity = Math.max(0, Math.trunc(Number(reserve.system.quantity) || 0));
  if (!quantity) return empty("empty");
  const maxStack = Math.max(1, Math.trunc(Number(data.shell.system.maxStack) || 1));
  const count = Math.ceil(quantity / maxStack);
  const candidates = [];
  for (let index = 0, remaining = quantity; index < count; index++) {
    const id = index ? `mwtankAmmo${String(index + 1).padStart(6, "0")}` : RESERVE_ID;
    if (index && items.some(item => itemId(item) === id)) return empty("id-collision");
    const candidate = clone(data.shell);
    candidate._id = id;
    for (const key of ["id", "_stats", "folder", "ownership", "sort"]) delete candidate[key];
    candidate.system.quantity = Math.min(maxStack, remaining); remaining -= candidate.system.quantity;
    candidate.system.stackParts = [];
    candidate.system.container.parentId = parentId;
    candidate.system.locked = reserve.system.locked;
    candidate.flags = { ...clone(reserve.flags ?? {}), ...clone(candidate.flags ?? {}) };
    candidate.flags[SYSTEM_ID] = { ...clone(reserve.flags?.[SYSTEM_ID] ?? {}), ...clone(candidate.flags?.[SYSTEM_ID] ?? {}),
      damageSourcePrototypeUuid: library.shell.uuid };
    if (!index) {
      const placement = { ...candidate.system.placement, x: reserve.system.placement.x, y: reserve.system.placement.y,
        rotated: reserve.system.placement.rotated };
      if (!planner.reserve(placement)) return empty("no-space");
      candidate.system.placement = placement;
    } else {
      const placement = planner.findAndReserve(candidate, [...others, ...candidates]);
      if (!placement) return empty("no-space");
      candidate.system.placement = { ...candidate.system.placement, ...placement };
    }
    candidates.push(candidate);
  }
  const first = candidates.shift();
  return { convertedReserve: true, retainedReserveReason: "", itemCreates: candidates,
    itemUpdates: [{ _id: RESERVE_ID, name: first.name, img: first.img, "system": first.system, "flags": first.flags }] };
}
