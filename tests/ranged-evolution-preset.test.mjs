import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const preset = JSON.parse(fs.readFileSync(
  path.join(ROOT, "storage/settings-presets/fallout-maw.json"),
  "utf8"
));
const catalog = preset.settings.find(entry => entry.id === "fallout-maw.abilitiesCatalog")?.value;
const abilities = catalog.categories.flatMap(category => category.abilities ?? []);

test("Quick Reload has two compact evolution branches without a timed free reload", () => {
  const ability = abilities.find(entry => entry.id === "6BRhRZ5jTvqm9pb9");
  assert.ok(ability);
  assert.equal(ability.system.cost, 1000);
  assert.equal(ability.system.acquisitionRequirements[0].value, 60);
  assert.equal(ability.system.evolution.nodes.length, 3);
  assert.equal(ability.system.evolution.links.length, 3);

  const nodes = new Map(ability.system.evolution.nodes.map(node => [node.id, node.ability]));
  const speed = nodes.get("qRldFast2OD00001");
  assert.equal(speed.system.cost, 1000);
  assert.equal(speed.system.acquisitionRequirements[0].value, 70);
  assert.equal(speed.system.functions[0].changes[0].value, "-2");
  assert.equal(speed.evolutionSummary, "<ul><li><p>Стоимость перезарядки -1 ОД</p></li></ul>");
  assert.doesNotMatch(speed.description, /6 секунд|0 ОД/);

  const arsenal = nodes.get("qRldArsenal20001");
  assert.deepEqual(arsenal.system.functions[0].changes.map(change => [change.key, change.value]), [
    ["system.costs.actions.reload", "-1"],
    ["system.costs.weaponSwitch", "-2"]
  ]);
  assert.equal(arsenal.evolutionSummary, "<ul><li><p>Стоимость смены оружия -1 ОД</p></li></ul>");
});
