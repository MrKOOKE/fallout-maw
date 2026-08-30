import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createAbilityCatalogCopy,
  getAbilityCopyName
} from "../src/utils/ability-catalog-copy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("ability catalog copy receives a new identity and does not share nested data", () => {
  const original = {
    id: "ability-original",
    name: "Меткий выстрел",
    description: "Описание",
    system: {
      functions: [{
        id: "function-one",
        conditions: [{ id: "condition-one", type: "toggleable" }]
      }]
    }
  };
  const copy = createAbilityCatalogCopy(original, {
    id: "ability-copy",
    existingNames: [original.name]
  });

  assert.equal(copy.id, "ability-copy");
  assert.equal(copy.name, "Меткий выстрел Копия");
  assert.deepEqual(copy.system, original.system);
  assert.notStrictEqual(copy.system, original.system);
  assert.notStrictEqual(copy.system.functions, original.system.functions);

  copy.system.functions[0].conditions[0].type = "duration";
  assert.equal(original.system.functions[0].conditions[0].type, "toggleable");
});

test("ability copy names stay readable and unique across repeated copies", () => {
  assert.equal(
    getAbilityCopyName("Меткий выстрел", ["Меткий выстрел", "Меткий выстрел Копия"]),
    "Меткий выстрел Копия 2"
  );
  assert.equal(
    getAbilityCopyName("Меткий выстрел Копия 2", [
      "Меткий выстрел Копия",
      "Меткий выстрел Копия 2"
    ]),
    "Меткий выстрел Копия 3"
  );
});

test("ability copy remaps every evolution source and internal graph reference", () => {
  let sequence = 0;
  const original = {
    id: "root-old",
    name: "Реактивный",
    system: {
      acquisitionRequirements: [],
      evolution: {
        nodes: [{
          id: "node-old",
          x: 200,
          y: 0,
          ability: {
            id: "node-old",
            name: "Реактивный II",
            system: {
              acquisitionRequirements: [{ abilityIds: ["root-old", "external"] }],
              evolution: { nodes: [], links: [] }
            }
          }
        }],
        links: [{ id: "link-old", fromId: "root-old", toId: "node-old" }]
      }
    }
  };
  const copy = createAbilityCatalogCopy(original, {
    id: "root-new",
    idFactory: () => `generated-${++sequence}`
  });

  const [node] = copy.system.evolution.nodes;
  const [link] = copy.system.evolution.links;
  assert.equal(node.id, "generated-1");
  assert.equal(node.ability.id, node.id);
  assert.notEqual(link.id, "link-old");
  assert.equal(link.fromId, "root-new");
  assert.equal(link.toId, node.id);
  assert.deepEqual(node.ability.system.acquisitionRequirements[0].abilityIds, ["root-new", "external"]);
});

test("ability settings list exposes and handles the copy action", () => {
  const appSource = fs.readFileSync(path.join(ROOT, "src/apps/ability-settings-config.mjs"), "utf8");
  const stylesheetSource = fs.readFileSync(path.join(ROOT, "styles/fallout-maw.css"), "utf8");
  const templateSource = fs.readFileSync(path.join(ROOT, "templates/settings/ability-settings-config.hbs"), "utf8");

  assert.match(appSource, /copyAbility:\s*this\.#onCopyAbility/);
  assert.match(
    appSource,
    /this\.catalog\s*=\s*foundry\.utils\.deepClone\(getAbilityCatalog\(\)\)/,
    "the editor must not mutate the shared normalized runtime cache"
  );
  assert.match(appSource, /createAbilityCatalogCopy\(ability/);
  assert.match(appSource, /new AbilityCatalogItemEditor\(this,\s*categoryId,\s*copy\.id\)\.render\(true\)/);
  assert.match(templateSource, /data-action="copyAbility"/);
  assert.match(templateSource, /fa-solid fa-copy/);
  assert.match(
    stylesheetSource,
    /\.ability-settings-config \.fallout-maw-ability-compact-row\s*\{[\s\S]*?grid-template-columns:\s*2\.5rem minmax\(180px, 1fr\) repeat\(5, 2\.25rem\);/
  );
});

test("ability settings confirms before mutating the catalog on deletion", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/apps/ability-settings-config.mjs"), "utf8");
  const methodStart = source.indexOf("static async #onDeleteAbility");
  const methodEnd = source.indexOf("\n  }\n\n}", methodStart);
  const method = source.slice(methodStart, methodEnd);

  assert.ok(methodStart >= 0, "delete handler must be asynchronous");
  assert.match(method, /await DialogV2\.confirm\(/);
  assert.match(method, /if \(!confirmed\) return undefined;/);
  assert.ok(
    method.indexOf("if (!confirmed)") < method.indexOf(".splice(abilityIndex, 1)"),
    "catalog mutation must happen only after confirmation"
  );
});

test("ability editor saves its draft only while closing", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/apps/ability-catalog-item-editor.mjs"), "utf8");
  const closeStart = source.indexOf("  close(options = {})");
  const closeEnd = source.indexOf("static #onSelectTab", closeStart);
  const close = source.slice(closeStart, closeEnd);

  assert.equal(source.match(/catalogApp\.saveAbility\(/g)?.length, 1);
  assert.match(close, /this\.#closeSavePromise \?\?= this\.#saveAndClose\(options\)/);
  assert.match(close, /this\.syncAbilityDraft\(\);[\s\S]*?await this\.#closeChildEditors\(\);/);
  assert.match(close, /const saved = await this\.catalogApp\.saveAbility\(this\.categoryId, this\.ability\);/);
  assert.match(close, /this\.catalogApp\.releaseChildEditor\?\.\(this\)/);
  assert.doesNotMatch(source, /autosave|#queueAutosave|#flushAutosave/i);
});
