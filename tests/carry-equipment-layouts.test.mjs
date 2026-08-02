import assert from "node:assert/strict";
import test from "node:test";
import { auditCarryEquipmentDefinitions } from "../scripts/rebalance/apply-carry-equipment.mjs";

function bounds(zone) {
  return [zone.left, zone.top, zone.right, zone.bottom];
}

test("carry equipment grids are aligned, connected, compact, and never overlap", () => {
  const rows = auditCarryEquipmentDefinitions();
  assert.equal(rows.length, 59);
  assert.equal(rows.filter(row => row.layout).length, 59);

  for (const row of rows.filter(entry => entry.layout)) {
    assert.equal(row.geometry.aligned, true, `${row.name}: fractional cell boundary`);
    assert.deepEqual(row.geometry.overlaps, [], `${row.name}: overlapping grid zones`);
    assert.equal(row.geometry.connected, true, `${row.name}: disconnected grid zones`);
    assert.ok(row.geometry.compactness >= 0.45, `${row.name}: sparse layout ${row.geometry.compactness}`);
  }
});

test("the D sack reproduces the agreed 4x1, 4x2, 2x2x1 layout without overlap", () => {
  const row = auditCarryEquipmentDefinitions().find(entry => (
    entry.kind === "backpack" && entry.class === "D" && entry.maxLoad === 18
  ));
  assert.ok(row);
  assert.equal(row.geometry.cells, 16);
  assert.deepEqual(
    row.zones.map(bounds).sort((left, right) => (left[1] - right[1]) || (left[0] - right[0])),
    [
      [0, -1, 1, 0],
      [1, -1, 2, 0],
      [2, -1, 3, 0],
      [3, -1, 4, 0],
      [0, 0, 4, 2],
      [0, 2, 2, 3],
      [2, 2, 4, 3]
    ]
  );
});

test("Atlas is a compact non-overlapping 76-cell carrier", () => {
  const row = auditCarryEquipmentDefinitions().find(entry => (
    entry.kind === "backpack" && entry.class === "S" && entry.maxLoad === 200
  ));
  assert.ok(row);
  assert.equal(row.geometry.cells, 76);
  assert.equal(row.geometry.width, 12);
  assert.equal(row.geometry.height, 7);
  assert.ok(row.geometry.compactness > 0.9);
});

test("rigs and all waist containers provide material load reduction across every class", () => {
  const rows = auditCarryEquipmentDefinitions();
  const rigs = rows.filter(row => row.kind === "rig");
  const pouches = rows.filter(row => row.kind === "pouch");
  const belts = rows.filter(row => row.kind === "belt");
  assert.equal(Math.min(...rigs.map(row => row.reduction)), 35);
  assert.equal(Math.max(...rigs.map(row => row.reduction)), 90);
  assert.equal(Math.min(...pouches.map(row => row.reduction)), 40);
  assert.equal(Math.max(...pouches.map(row => row.reduction)), 90);
  assert.equal(Math.min(...belts.map(row => row.reduction)), 40);
  assert.equal(Math.max(...belts.map(row => row.reduction)), 92);
});

test("every waist-slot item is both a container and a bonus source", () => {
  const rows = auditCarryEquipmentDefinitions().filter(row => ["pouch", "belt"].includes(row.kind));
  assert.equal(rows.length, 22);
  for (const row of rows) {
    assert.ok(row.layout, `${row.name}: missing container layout`);
    assert.ok(row.maxLoad > 0, `${row.name}: missing load limit`);
    assert.ok(row.reduction > 0, `${row.name}: missing load reduction`);
    assert.ok(Object.keys(row.effects).length > 0, `${row.name}: missing bonuses`);
  }
});
