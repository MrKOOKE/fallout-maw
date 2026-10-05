import test from "node:test";
import assert from "node:assert/strict";
globalThis.foundry = { utils: { deepClone: structuredClone, randomID: () => "test-id" } };
const { createConstructHubDraftActor, reconcileConstructHubReferences } = await import("../src/apps/construct-hub-draft.mjs");
const { getConstructPartSlots, getInstalledConstructPartForSlot } = await import("../src/utils/construct-parts.mjs");
const { getConstructCrewSeatOptions } = await import("../src/utils/construct-crew.mjs");
const { getConstructSystemState } = await import("../src/utils/construct-systems.mjs");

function part(id, systemId = "drive") {
  return { id, _id: id, name: id, type: "gear", img: "tank.webp", system: {
    placement: { mode: "constructPart", limbKey: id }, functions: {
      constructPart: { enabled: true, partType: id, systems: [{ systemId, capacity: 100, movementPoints: 5, activationProvider: true }] },
      condition: { enabled: true, value: 10, max: 10 },
      actorContainer: { enabled: true, slots: [{ id: "crew", width: 1, height: 1, quantity: 2 }] }
    }
  } };
}
function fixture() {
  const hull = part("hull"), engine = part("engine");
  const actor = { type: "construct", name: "Танк", flags: {}, system: { constructPartSlots: [], resources: { power: { value: 80 } } },
    items: { contents: [hull,engine] } };
  const entries = [hull,engine].map(item => ({ slot: { id: item.id, profile: {} }, itemId: item.id, item,
    installed: true, draftItemId: item.id }));
  const systems = [{ id: "drive", enabled: true, active: true, requiresActivation: true, resourceKey: "power" }];
  return { actor, entries, systems };
}
test("one assembly projection shares unsaved contributions with system totals without touching the actor", () => {
  const {actor,entries,systems} = fixture(), before=structuredClone(actor);
  const engine = structuredClone(actor.items.contents[1]);
  engine.system.functions.constructPart.systems[0].capacity = 240;
  const draft = createConstructHubDraftActor(actor, entries, systems, new Map([[engine.id, engine]]));
  assert.equal(getConstructSystemState(draft, "drive").capacity, 340);
  assert.equal(getInstalledConstructPartForSlot(draft, "engine").system.functions.constructPart.systems[0].capacity, 240);
  assert.deepEqual(actor, before);
});
test("removal and reorder apply to physical slots, preview and system contributions together", () => {
  const {actor,entries,systems} = fixture();
  const draft = createConstructHubDraftActor(actor, [entries[1]], systems);
  assert.deepEqual(getConstructPartSlots(draft).map(slot => slot.id), ["engine"]);
  assert.equal(getInstalledConstructPartForSlot(draft, "hull"), null);
  assert.equal(getConstructSystemState(draft, "drive").capacity, 100);
  assert.equal(actor.items.contents[0].system.placement.mode, "constructPart");
});
test("a newly dropped compartment exposes physical crew seats with its future saved Item identity", () => {
  const {actor,entries,systems} = fixture(), incoming=part("source-id");
  entries.push({ slot: { id: "new-slot", profile: {} }, itemData: incoming, itemId: "", draftItemId: "new-item", installed: true });
  const draft = createConstructHubDraftActor(actor, entries, systems);
  assert.equal(getInstalledConstructPartForSlot(draft, "new-slot").id, "new-item");
  assert.equal(getConstructCrewSeatOptions(draft).filter(row => row.itemId === "new-item").length, 2);
  assert.equal(getConstructCrewSeatOptions(draft).find(row => row.itemId === "new-item").slotId, "new-item:crew");
  assert.equal(incoming.id, "source-id");
});
test("removed records clear only their references and retain unrelated roles, permissions and mount points", () => {
  const config={ parts:[{id:"a",slotId:"hull",rotationSystemIds:["drive","gone"]},{id:"b",slotId:"removed"}],
    anchors:[{id:"pivot",parentSlotId:"removed"},{id:"valid",parentSlotId:"hull"}],
    seats:[{id:"loader",slotId:"seat",partSlotId:"removed",functions:["reload"],reloadPartSlotIds:["hull","removed"],systemIds:["drive","gone"]}] };
  reconcileConstructHubReferences(config,["hull"],["drive"]);
  assert.equal(config.parts.length,1); assert.deepEqual(config.parts[0].rotationSystemIds,["drive"]);
  assert.equal(config.anchors[0].parentSlotId,""); assert.equal(config.anchors[1].parentSlotId,"hull");
  assert.deepEqual(config.seats[0],{id:"loader",slotId:"seat",partSlotId:"",functions:["reload"],reloadPartSlotIds:["hull"],systemIds:["drive"]});
});
