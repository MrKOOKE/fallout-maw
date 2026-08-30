import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { removeObsoleteReactiveEvolutionExample } from "../src/migrations/obsolete-world-settings.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Fallout preset keeps Reactive enabled without the obsolete generated example", () => {
  const preset = JSON.parse(fs.readFileSync(
    path.join(ROOT, "storage/settings-presets/fallout-maw.json"),
    "utf8"
  ));
  const catalog = preset.settings.find(entry => entry.id === "fallout-maw.abilitiesCatalog")?.value;
  const abilities = catalog.categories.flatMap(category => category.abilities ?? []);
  const reactive = abilities.find(ability => ability.id === "440oqDWdqC2Rha9Y");
  assert.ok(reactive);

  const baseFunction = reactive.system.functions.find(entry => entry.fixedKey === "reactive");
  assert.equal(baseFunction.enabled, true);
  assert.equal(baseFunction.fixedSettings.actionPointsPerThreshold, 1);
  const nodeIds = new Set(reactive.system.evolution.nodes.map(node => node.id));
  assert.equal(nodeIds.has("reactive-2ap-evolution"), false);
  assert.equal(nodeIds.has("ZE3wVZrKgRxUVkcw"), false);
});

test("the one-time catalog migration removes only the bundled Reactive example", () => {
  const catalog = {
    categories: [{
      abilities: [{
        id: "440oqDWdqC2Rha9Y",
        system: {
          functions: [{
            enabled: false,
            fixedKey: "reactive",
            fixedSettings: { actionPointsPerThreshold: 1 }
          }],
          evolution: {
            nodes: [
              { id: "ZE3wVZrKgRxUVkcw", ability: { id: "ZE3wVZrKgRxUVkcw" } },
              { id: "user-copy", ability: { id: "user-copy" } }
            ],
            links: [
              { fromId: "440oqDWdqC2Rha9Y", toId: "ZE3wVZrKgRxUVkcw" },
              { fromId: "440oqDWdqC2Rha9Y", toId: "user-copy" }
            ],
            viewport: { x: 10, y: 20, zoom: 1 }
          }
        }
      }]
    }]
  };

  const migrated = removeObsoleteReactiveEvolutionExample(catalog);
  const reactive = migrated.categories[0].abilities[0];
  assert.deepEqual(reactive.system.evolution.nodes.map(node => node.id), ["user-copy"]);
  assert.deepEqual(reactive.system.evolution.links.map(link => link.toId), ["user-copy"]);
  assert.equal(reactive.system.functions[0].enabled, true);
  assert.equal(catalog.categories[0].abilities[0].system.evolution.nodes.length, 2);
  assert.equal(removeObsoleteReactiveEvolutionExample(migrated), null);
});
