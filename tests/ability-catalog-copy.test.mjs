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

test("ability settings list exposes and handles the copy action", () => {
  const appSource = fs.readFileSync(path.join(ROOT, "src/apps/ability-settings-config.mjs"), "utf8");
  const templateSource = fs.readFileSync(path.join(ROOT, "templates/settings/ability-settings-config.hbs"), "utf8");

  assert.match(appSource, /copyAbility:\s*this\.#onCopyAbility/);
  assert.match(appSource, /createAbilityCatalogCopy\(ability/);
  assert.match(appSource, /new AbilityCatalogItemEditor\(this,\s*categoryId,\s*copy\.id\)\.render\(true\)/);
  assert.match(templateSource, /data-action="copyAbility"/);
  assert.match(templateSource, /fa-solid fa-copy/);
});
