import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createToolResourceValueUpdate,
  getEnabledToolFunctions,
  getToolResourceState,
  normalizeToolResourceMode
} from "../src/utils/item-functions.mjs";

function itemSystem({ consumptionMode, supply = { value: 7, max: 10 }, condition = null } = {}) {
  const tool = {
    enabled: true,
    useAsItem: false,
    toolClass: "D",
    supply,
    skillKey: "",
    skillValue: 0
  };
  if (consumptionMode !== undefined) tool.consumptionMode = consumptionMode;
  return {
    functions: {
      tool: { enabled: true, toolKey: "butchery" },
      tools: { butchery: tool },
      ...(condition ? { condition } : {})
    }
  };
}

test("legacy tool functions keep spending their private supply", () => {
  const system = itemSystem();
  const resource = getToolResourceState(system, "butchery");

  assert.equal(normalizeToolResourceMode(undefined), "supply");
  assert.deepEqual(resource, {
    mode: "supply",
    toolKey: "butchery",
    value: 7,
    max: 10,
    configured: true,
    available: true,
    updatePath: "system.functions.tools.butchery.supply.value",
    deletesItemOnDepletion: true
  });
  assert.deepEqual(createToolResourceValueUpdate(system, "butchery", 4), {
    "system.functions.tools.butchery.supply.value": 4
  });
});

test("condition-mode tools expose item condition as their consumable resource", () => {
  const system = itemSystem({
    consumptionMode: "condition",
    supply: { value: 999, max: 999 },
    condition: { enabled: true, value: 320, max: 500 }
  });
  const resource = getToolResourceState(system, "butchery");

  assert.deepEqual(resource, {
    mode: "condition",
    toolKey: "butchery",
    value: 320,
    max: 500,
    configured: true,
    available: true,
    updatePath: "system.functions.condition.value",
    deletesItemOnDepletion: false
  });
  assert.deepEqual(createToolResourceValueUpdate(system, "butchery", 315), {
    "system.functions.condition.value": 315
  });

  const [tool] = getEnabledToolFunctions(system);
  assert.equal(tool.consumptionMode, "condition");
  assert.equal(tool.resource.value, 320);
});

test("condition mode cannot use a missing or disabled condition function", () => {
  const missing = getToolResourceState(itemSystem({ consumptionMode: "condition" }), "butchery");
  const disabled = getToolResourceState(itemSystem({
    consumptionMode: "condition",
    condition: { enabled: false, value: 50, max: 100 }
  }), "butchery");

  assert.equal(missing.configured, false);
  assert.equal(missing.available, false);
  assert.equal(disabled.value, 50);
  assert.equal(disabled.configured, false);
  assert.equal(disabled.available, false);
});

test("tool resource mode is wired into the editor and every consuming workflow", async () => {
  const files = await Promise.all([
    "../src/data/models/item-data-models.mjs",
    "../templates/item/item-sheet.hbs",
    "../src/sheets/item-sheet.mjs",
    "../src/apps/craft-window.mjs",
    "../src/apps/search-inventory.mjs",
    "../src/apps/medicine-dialog.mjs",
    "../src/apps/repair-dialog.mjs",
    "../src/apps/hacking-dialog.mjs"
  ].map(path => readFile(new URL(path, import.meta.url), "utf8")));
  const [schema, template, itemSheet, craft, butchering, medicine, repair, hacking] = files;

  assert.match(schema, /consumptionMode: new StringField[\s\S]*choices: \["supply", "condition"\][\s\S]*initial: "supply"/);
  assert.match(template, /name="system\.functions\.tools\.\{\{key\}\}\.consumptionMode"/);
  assert.match(itemSheet, /Запас инструмента/);
  assert.match(itemSheet, /Состояние предмета/);
  assert.match(craft, /update\[selected\.resourcePath\] = selected\.supplyValue/);
  assert.match(craft, /selected\.supplyValue <= 0 && selected\.deletesItemOnDepletion/);
  assert.match(butchering, /update\[selected\.resourcePath\] = remaining/);
  assert.match(butchering, /remaining <= 0 && selected\.deletesItemOnDepletion/);
  assert.match(medicine, /createToolResourceValueUpdate\(instrument, tool, remaining\)/);
  assert.match(repair, /createToolResourceValueUpdate\(instrument, liveTool, remainingSupply\)/);
  assert.match(hacking, /\[toolResource\.updatePath\]: remainingSupply/);
  assert.match(hacking, /\[state\.toolResourcePath\]: state\.previousSupply/);
});
