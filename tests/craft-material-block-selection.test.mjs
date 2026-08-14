import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(ROOT, "src", "apps", "craft-window.mjs"), "utf8");

test("creation material blocks select actor-owned alternatives before validation", () => {
  assert.match(source, /function getCraftMaterialBlockLimitedNodes\([\s\S]*selectAvailableCraftMaterialBlockNodes/u);
  assert.match(source, /function selectAvailableCraftMaterialBlockNodes\([\s\S]*available:\s*owned\s*>=\s*quantity/u);
  assert.match(source, /getCraftMaterialRequirementNodes\(nodes, links, mode, \{[\s\S]*actor,[\s\S]*index,[\s\S]*randomize:/u);
  assert.match(source, /getCraftMaterialRequirementNodes\(nodes, links, mode, \{ actor, index \}\)/u);
});

test("material block choice keeps block limits and deterministic source order", () => {
  assert.match(source, /const count = Math\.min\(nodes\.length, Math\.max\(1, toInteger\(limit\) \|\| 1\)\)/u);
  assert.match(source, /right\.available - left\.available[\s\S]*right\.batches - left\.batches[\s\S]*left\.order - right\.order/u);
});
