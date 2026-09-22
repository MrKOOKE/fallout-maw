import assert from "node:assert/strict";
import test from "node:test";
import { formatCraftYieldQuantity, layoutCraftEmbeddedItems } from "../src/utils/craft-embedded-layout.mjs";

const node = (id, x, y, extra = {}) => ({ id, x, y, width: 1, height: 1, ...extra });
const chip = (key, extra = {}) => ({ key, name: key, sourceUuid: `Item.${key}`, img: `${key}.png`, quantity: 1, requested: 1, ...extra });
const overlaps = (a, b) => Math.abs(a.x - b.x) < (a.width + b.width) / 2
  && Math.abs(a.y - b.y) < (a.height + b.height) / 2;

test("returned ammunition and modules join the existing result block without editing the recipe", () => {
  const nodes = [node("gun", 0, 0, { root: true, width: 6, height: 3 }),
    ...[-1, 0, 1].map((x, i) => node(`part${i}`, x, 5, { blockId: "results" }))];
  const links = [{ id: "disassemble", fromNodeId: "gun", toNodeId: "part0" }];
  const before = structuredClone({ nodes, links });
  const result = layoutCraftEmbeddedItems(nodes, links, [chip("ammo", { quantity: 90 }), chip("grip")], "disassembly");
  assert.deepEqual({ nodes, links }, before);
  assert.equal(result.nodes.length, 6);
  assert.deepEqual(result.nodes.slice(1).map(n => [n.x, n.y, n.blockId]), [-2, -1, 0, 1, 2].map(x => [x, 5, "results"]));
  assert.deepEqual(result.nodes.filter(n => n.embedded).map(n => [n.quantityLabel, n.embeddedOptional]), [["90×", false], ["1×", false]]);
  assert.deepEqual(result.links, links);
});

test("optional crafting inputs keep their resource identity, selected state and partial amount", () => {
  const nodes = [node("gun", 0, 3, { root: true }), node("part", 0, -2)];
  const result = layoutCraftEmbeddedItems(nodes, [], [chip("ammo", { quantity: 7, requested: 30 }), chip("grip", { enabled: false, quantity: 0 })]);
  assert.deepEqual(result.nodes.filter(n => n.embedded).map(n => [n.embeddedKey, n.quantityLabel, n.embeddedEnabled, n.embeddedOptional]),
    [["ammo", "7/30", true, true], ["grip", "0/1", false, true]]);
  assert.equal(result.nodes[1].blockId, result.nodes[2].blockId);
  assert.equal(result.nodes[2].tooltipUuid, "Item.ammo");
});

test("large embedded items wrap into rows without overlapping results or other recipe groups", () => {
  const nodes = [node("root", 0, 0, { root: true }), node("part", 0, 3, { blockId: "results" }),
    node("tool", 1, 5, { isToolRequirement: true })];
  const chips = Array.from({ length: 7 }, (_, i) => chip(`module${i}`, { data: { system: { placement: { width: 2, height: i % 2 + 1 } } } }));
  const result = layoutCraftEmbeddedItems(nodes, [], chips, "disassembly");
  for (let i = 0; i < result.nodes.length; i++) for (let j = i + 1; j < result.nodes.length; j++) {
    assert.equal(overlaps(result.nodes[i], result.nodes[j]), false, `${result.nodes[i].id}/${result.nodes[j].id}`);
  }
  const added = result.nodes.filter(n => n.embedded);
  assert.ok(new Set(added.map(n => n.y)).size > 1);
  assert.ok(added.every(n => n.y > 5));
  assert.equal(result.nodes.find(n => n.id === "tool").y, 5);
});

test("failure results and tools do not absorb embedded returns", () => {
  const nodes = [node("root", 0, 0, { root: true }), node("scrap", -2, 1, { blockId: "failure" }),
    node("scrap2", -3, 1, { blockId: "failure" }), node("tool", 3, 1, { isToolRequirement: true }), node("part", 0, 4, { blockId: "success" })];
  const links = [{ fromNodeId: "root", toNodeId: "scrap", failureResult: true }, { fromNodeId: "root", toNodeId: "part" }];
  const result = layoutCraftEmbeddedItems(nodes, links, [chip("ammo")], "disassembly");
  assert.equal(result.nodes.at(-1).blockId, "success");
  assert.deepEqual(result.nodes.slice(0, 4), nodes.slice(0, 4));
});

test("tool-only crafting gets a connected optional input block above the recipe", () => {
  const nodes = [node("root", 0, 0, { root: true }), node("tool", 0, -3, { isToolRequirement: true })];
  const result = layoutCraftEmbeddedItems(nodes, [], [chip("ammo")]);
  assert.ok(result.nodes.at(-1).y < -3);
  assert.equal(result.links.length, 1);
  assert.equal(result.links[0].noCheck, true);
  assert.equal(result.links[0].toNodeId, result.nodes.at(-1).id);
});

test("reduced output labels include the full yield even when nothing is recovered", () => {
  assert.equal(formatCraftYieldQuantity(0, 3), "0/3×");
  assert.equal(formatCraftYieldQuantity(2, 5), "2/5×");
  assert.equal(formatCraftYieldQuantity(3, 3), "3×");
  assert.equal(formatCraftYieldQuantity(90), "90×");
});
