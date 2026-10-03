import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeConstructInterior, getConstructInteriorConfig, getConstructPartParentSlotId,
  getConstructPartContainmentPath, getConstructExteriorSlotIds, getConstructCompartmentContents
} from "../src/utils/construct-interior.mjs";
import { normalizeConstructInteriorTarget, resolveConstructInteriorTarget } from "../src/utils/construct-interior-targets.mjs";
import { normalizeConstructVisual, normalizeConstructPersonalWeapons } from "../src/utils/construct-visual-model.mjs";
import { normalizeConstructPersonalWeapons as normalizeFiringPort } from "../src/utils/construct-firing-port-model.mjs";

function fixture() {
  const rows = [
    { slotId: "hull", parentSlotId: "" }, { slotId: "cabin", parentSlotId: "hull" },
    { slotId: "engine", parentSlotId: "cabin" }, { slotId: "track", parentSlotId: "" }
  ];
  const actor = { type: "construct", id: "carrier", uuid: "Actor.carrier", system: {
    constructPartSlots: rows.map((row, order) => ({ id: row.slotId, order })), limbs: {}
  }, flags: { "fallout-maw": { constructInterior: { version: 1, parts: rows }, actorContainer: { passengers: [] } } },
    getFlag(scope, key) { return this.flags[scope]?.[key]; } };
  const items = rows.map(({ slotId }) => ({ id: `${slotId}-item`, type: "gear", name: slotId, system: {
    placement: { mode: "constructPart", limbKey: slotId }, functions: {
      constructPart: { enabled: true }, condition: { enabled: true, value: 100, max: 100 },
      ...(["hull", "cabin"].includes(slotId) ? { actorContainer: { enabled: true, slots: [
        { id: "seats", width: 2, height: 2, quantity: slotId === "hull" ? 2 : 1 }
      ] } } : {})
    }
  } }));
  actor.items = { contents: items, get(id) { return this.contents.find(item => item.id === id); } };
  for (const row of rows) actor.system.limbs[`constructPart:${row.slotId}`] = { min: 0, max: 100, value: 100 };
  const people = new Map();
  globalThis.game = { actors: people };
  globalThis.fromUuidSync = uuid => people.get(uuid) ?? null;
  const addPassenger = (id, slotId, index = 0, { missing = false, parked = false } = {}) => {
    const person = { type: "character", id, uuid: `Actor.${id}`, system: { limbs: { torso: { max: 100, value: 100, missing } } } };
    people.set(parked ? id : person.uuid, person);
    const passenger = { id: `occupant-${id}`, actorUuid: parked ? `Scene.old.Token.${id}.Actor` : person.uuid,
      ...(parked ? { parkedActorId: id } : {}), slotId: `${slotId}-item:seats`, slotIndex: index };
    actor.flags["fallout-maw"].actorContainer.passengers.push(passenger);
    return { person, passenger };
  };
  return { actor, items, rows, addPassenger };
}

test("containment normalization detaches cycles and unknown refs without editing source", () => {
  const raw = { parts: [
    { slotId: "constructPart:a", parentSlotId: "b" }, { slotId: "b", parentSlotId: "a" },
    { slotId: "self", parentSlotId: "self" }, { slotId: "orphan", parentSlotId: "missing" },
    { slotId: "b", parentSlotId: "orphan" }, { slotId: "unknown", parentSlotId: "a" }
  ] };
  const original = structuredClone(raw);
  const normalized = normalizeConstructInterior(raw, { slotIds: ["a", "b", "self", "orphan", "new-slot"] });
  assert.deepEqual(raw, original);
  assert.equal(normalized.parts.length, 5);
  assert.equal(getConstructPartParentSlotId(normalized, "self"), "");
  assert.equal(getConstructPartParentSlotId(normalized, "orphan"), "");
  assert.equal(getConstructPartParentSlotId(normalized, "new-slot"), "");
  for (const part of normalized.parts) {
    const path = getConstructPartContainmentPath(normalized, part.slotId);
    assert.equal(path.at(-1), part.slotId);
    assert.equal(new Set(path).size, path.length);
  }
  assert.deepEqual(getConstructPartContainmentPath(normalized, "missing"), []);
});

test("physical placement includes nonvisual parts and is independent of visual anchor parenting", () => {
  const { actor } = fixture();
  actor.flags["fallout-maw"].constructVisual = { enabled: true, anchors: [{ id: "frame" }],
    parts: [{ slotId: "hull", anchorId: "frame", img: "hull.webp" }] };
  assert.equal(getConstructInteriorConfig(actor).parts.length, 4);
  assert.deepEqual(getConstructPartContainmentPath(actor, "constructPart.engine"), ["hull", "cabin", "engine"]);
  assert.equal(getConstructPartParentSlotId(actor, "engine"), "cabin");
  assert.deepEqual(getConstructExteriorSlotIds(actor), ["hull", "track"]);
});

test("removed intermediate shells remain traversable and removing the outer shell exposes installed contents", () => {
  const { actor, items } = fixture();
  const saved = structuredClone(actor.flags["fallout-maw"].constructInterior);
  items[1].system.placement.mode = "inventory";
  const contents = getConstructCompartmentContents(actor, "hull");
  assert.deepEqual(contents.parts.map(row => [row.slotId, row.parentSlotId, row.item]), [["cabin", "hull", null]]);
  assert.deepEqual(getConstructPartContainmentPath(actor, "engine"), ["hull", "cabin", "engine"]);
  assert.deepEqual(getConstructExteriorSlotIds(actor), ["hull", "track"]);
  const throughRemoved = resolveConstructInteriorTarget(actor, { kind: "part", shellSlotId: "hull", slotId: "engine" });
  assert.deepEqual(throughRemoved.path, ["hull", "cabin", "engine"]);
  items[0].system.placement.mode = "inventory";
  assert.deepEqual(getConstructExteriorSlotIds(actor), ["engine", "track"]);
  assert.deepEqual(actor.flags["fallout-maw"].constructInterior, saved);
});

test("compartment passengers come from real enabled physical seats, including a broken installed cabin", () => {
  const { actor, items, addPassenger } = fixture();
  const hull = addPassenger("outside-crew", "hull");
  const cabin = addPassenger("inside-crew", "cabin");
  addPassenger("bad-index", "hull", 2);
  addPassenger("bad-negative", "hull", -1);
  addPassenger("wrong-container", "engine");
  items[1].system.functions.condition.value = 0;
  assert.deepEqual(getConstructCompartmentContents(actor, "hull").passengers, [hull.passenger]);
  assert.deepEqual(getConstructCompartmentContents(actor, "cabin").passengers, [cabin.passenger]);
  items[1].system.placement.mode = "inventory";
  assert.deepEqual(getConstructCompartmentContents(actor, "cabin").passengers, []);
  assert.deepEqual(getConstructCompartmentContents(actor, "absent"), { parts: [], passengers: [] });
});

test("part descriptors discard forged paths and are revalidated after live hardware or containment changes", () => {
  const { actor, items, rows } = fixture();
  const raw = { kind: "part", shellSlotId: " hull ", slotId: " engine ", path: ["track"], armorIgnored: true };
  const normalized = normalizeConstructInteriorTarget(raw);
  assert.deepEqual(normalized, { kind: "part", shellSlotId: "hull", slotId: "engine" });
  assert.equal(resolveConstructInteriorTarget(actor, normalized).item, items[2]);
  assert.equal(resolveConstructInteriorTarget(actor, { ...normalized, shellSlotId: "track" }), null);
  assert.equal(resolveConstructInteriorTarget(actor, { ...normalized, slotId: "hull" }), null);
  assert.equal(resolveConstructInteriorTarget(actor, { ...normalized, slotId: "unknown" }), null);
  rows[2].parentSlotId = "track";
  assert.equal(resolveConstructInteriorTarget(actor, normalized), null);
  rows[2].parentSlotId = "cabin";
  items[2].system.placement.mode = "inventory";
  assert.equal(resolveConstructInteriorTarget(actor, normalized), null);
});

test("passenger targeting checks actual identity, ancestry and an own living body limb", () => {
  const { actor, addPassenger } = fixture();
  const { passenger, person } = addPassenger("crew", "cabin");
  const descriptor = { kind: "passenger", shellSlotId: "hull", passengerId: passenger.id,
    actorUuid: person.uuid, limbKey: "torso", suppliedPath: ["engine"] };
  const resolved = resolveConstructInteriorTarget(actor, descriptor);
  assert.equal(resolved.actor, person);
  assert.deepEqual(resolved.path, ["hull", "cabin"]);
  assert.equal(Object.hasOwn(resolved.descriptor, "suppliedPath"), false);
  for (const override of [
    { actorUuid: "Actor.somebodyElse" }, { passengerId: "somebodyElse" }, { shellSlotId: "track" },
    { limbKey: "not-a-limb" }, { limbKey: "toString" }, { limbKey: "__proto__" }
  ]) assert.equal(resolveConstructInteriorTarget(actor, { ...descriptor, ...override }), null);
  person.system.limbs.torso.missing = true;
  assert.equal(resolveConstructInteriorTarget(actor, descriptor), null);
  person.system.limbs.torso.missing = false;
  actor.flags["fallout-maw"].actorContainer.passengers = [];
  assert.equal(resolveConstructInteriorTarget(actor, descriptor), null);
});

test("parked passengers resolve their real actor after the original token document disappears", () => {
  const { actor, addPassenger } = fixture();
  const { person, passenger } = addPassenger("parked", "hull", 0, { parked: true });
  const descriptor = { kind: "passenger", shellSlotId: "hull", passengerId: passenger.id, actorUuid: person.uuid, limbKey: "torso" };
  assert.equal(resolveConstructInteriorTarget(actor, descriptor).actor, person);
  assert.equal(resolveConstructInteriorTarget(actor, { ...descriptor, actorUuid: passenger.actorUuid }), null);
});

test("a destroyed installed shell still provides a valid route to a living interior target", () => {
  const { actor, items } = fixture();
  items[0].system.functions.condition.value = 0;
  actor.system.limbs["constructPart:hull"].value = 0;
  const target = { kind: "part", shellSlotId: "hull", slotId: "engine" };
  assert.equal(resolveConstructInteriorTarget(actor, target).limbKey, "constructPart:engine");
  items[2].system.functions.condition.value = 0;
  assert.equal(resolveConstructInteriorTarget(actor, target), null);
});

test("visual seats share strict personal-fire normalization and invalid anchors do not enable a firing origin", () => {
  assert.equal(normalizeConstructPersonalWeapons, normalizeFiringPort);
  assert.deepEqual(normalizeConstructPersonalWeapons(null), {
    enabled: false, anchorId: "", minRotation: -180, maxRotation: 180, maxRangeMeters: null, coverPercent: 100
  });
  const config = normalizeConstructVisual({ anchors: [{ id: "window", rotation: 90 }], seats: [
    { id: "first", personalWeapons: { enabled: "false", anchorId: "window", minRotation: 90, maxRotation: -90,
      maxRangeMeters: 99999999, coverPercent: -10 } },
    { id: "second", personalWeapons: { enabled: true, anchorId: "missing", exposed: true } }
  ] });
  assert.deepEqual(config.seats[0].personalWeapons, { enabled: false, anchorId: "window", minRotation: -90,
    maxRotation: 90, maxRangeMeters: 100000, coverPercent: 0 });
  assert.equal(config.seats[1].personalWeapons.anchorId, "");
  assert.equal(config.seats[1].personalWeapons.coverPercent, 0);
});
