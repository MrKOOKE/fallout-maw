import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createTokenActionHudRequestIndex } from "../src/apps/token-action-hud-request-index.mjs";

function ownedItem(id, type = "gear") {
  return { id, type, system: {} };
}

function installedModule(id, parentItemId) {
  return {
    id,
    type: "gear",
    system: {
      placement: {
        mode: "module",
        parentItemId
      }
    }
  };
}

test("one HUD request materializes each provider exactly once", () => {
  const gear = ownedItem("gear");
  const ability = ownedItem("ability", "ability");
  let contentsReads = 0;
  let weaponSetReads = 0;
  let installedModuleReads = 0;
  let activeSetResolutions = 0;
  const actor = {
    items: {
      get contents() {
        contentsReads += 1;
        return [gear, ability];
      }
    }
  };
  const weaponSets = [{
    key: "set",
    slots: [{ item: { id: "gear" }, phantom: false, useDisabled: false }]
  }];

  const index = createTokenActionHudRequestIndex(actor, {
    getWeaponSets: () => {
      weaponSetReads += 1;
      return weaponSets;
    },
    getInstalledModuleItems: () => {
      installedModuleReads += 1;
      return [];
    },
    resolveActiveWeaponSetKey: (_actor, sets) => {
      activeSetResolutions += 1;
      assert.deepEqual(sets, weaponSets);
      return "set";
    }
  });

  assert.equal(contentsReads, 1);
  assert.equal(weaponSetReads, 1);
  assert.equal(installedModuleReads, 1);
  assert.equal(activeSetResolutions, 1);
  assert.deepEqual(index.actorItemsByType.get("gear"), [gear]);
  assert.deepEqual(index.actorItemsByType.get("ability"), [ability]);
  assert.equal(index.actorItemById.get("gear"), gear);
  assert.equal(index.hudWeaponSetByKey.get("set"), weaponSets[0]);

  // Repeated consumers only read the already materialized request data.
  assert.equal(index.actorItemById.get("gear"), gear);
  assert.deepEqual(index.actorItemsByType.get("gear"), [gear]);
  assert.equal(index.hudWeaponSetByKey.get("set"), weaponSets[0]);
  assert.equal(contentsReads, 1);
  assert.equal(weaponSetReads, 1);
  assert.equal(installedModuleReads, 1);
});

test("a HUD request without a weapon host does not materialize irrelevant modules", () => {
  let installedModuleReads = 0;
  const index = createTokenActionHudRequestIndex({
    items: {
      contents: [ownedItem("ability", "ability")]
    }
  }, {
    getWeaponSets: () => [{ key: "empty", slots: [] }],
    getInstalledModuleItems: () => {
      installedModuleReads += 1;
      return [installedModule("unused", "unused-host")];
    },
    resolveActiveWeaponSetKey: () => "empty"
  });

  assert.equal(installedModuleReads, 0);
  assert.deepEqual(index.installedModuleItems, []);
  assert.deepEqual(index.activeHudInstalledModuleItems, []);
});

test("active HUD module selection preserves the legacy order and membership rules", () => {
  const owned = [
    ownedItem("host-a"),
    ownedItem("host-b"),
    ownedItem("host-disabled"),
    ownedItem("host-phantom")
  ];
  const modules = [
    installedModule("module-b-1", "host-b"),
    installedModule("module-a-1", "host-a"),
    installedModule("module-disabled", "host-disabled"),
    installedModule("module-phantom", "host-phantom"),
    installedModule("module-b-2", "host-b")
  ];
  const weaponSets = [{
    key: "inactive",
    slots: [{ item: { id: "host-a" }, phantom: false, useDisabled: false }]
  }, {
    key: "active",
    slots: [
      { item: { id: "host-b" }, phantom: false, useDisabled: false },
      { item: { id: "host-disabled" }, phantom: false, useDisabled: true },
      { item: { id: "host-phantom" }, phantom: true, useDisabled: false }
    ]
  }];

  const index = createTokenActionHudRequestIndex({ items: { contents: owned } }, {
    getWeaponSets: () => weaponSets,
    getInstalledModuleItems: () => modules,
    resolveActiveWeaponSetKey: () => "active"
  });
  const legacyActiveHostIds = new Set(weaponSets[1].slots
    .filter(slot => slot.item?.id && !slot.phantom && !slot.useDisabled)
    .map(slot => String(slot.item.id)));
  const legacyActiveModules = modules
    .filter(item => legacyActiveHostIds.has(String(item.system.placement.parentItemId)));

  assert.deepEqual(index.activeHudInstalledModuleItems, legacyActiveModules);
  assert.deepEqual(index.itemsWithActiveHudModules, [...owned, ...legacyActiveModules]);
  assert.deepEqual(index.activeHudInstalledModulesByParentItemId.get("host-b"), [
    modules[0],
    modules[4]
  ]);

  // Attached weapon actions historically consider all installed modules,
  // including a disabled host; keep that separate from active-HUD consumers.
  assert.deepEqual(index.installedModulesByParentItemId.get("host-disabled"), [modules[2]]);
});

test("HUD context wires one request index and decorates weapon sets only once", async () => {
  const source = await readFile(new URL("../src/apps/token-action-hud.mjs", import.meta.url), "utf8");
  const start = source.indexOf("  async _prepareContext(options) {");
  const end = source.indexOf("  async _onRender(context, options) {", start);
  assert.ok(start >= 0 && end > start);
  const prepareContext = source.slice(start, end);

  assert.equal((prepareContext.match(/createTokenActionHudRequestIndex\(/g) ?? []).length, 1);
  assert.equal((prepareContext.match(/prepareHudWeaponSets\(/g) ?? []).length, 1);
  assert.equal((prepareContext.match(/prepareHudWeaponSet\(/g) ?? []).length, 0);
  assert.match(prepareContext, /getWeaponSets:\s*getHudWeaponSetsForActor/);
  assert.match(prepareContext, /getInstalledModuleItems:\s*getActorInstalledModuleItems/);
  assert.match(source, /itemDocuments:\s*requestIndex\?\.itemsWithActiveHudModules/);
});

test("weapon-set cache identity includes dynamic construct-part slots", async () => {
  const source = await readFile(new URL("../src/utils/hud-active-items.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function getHudWeaponSetsCacheSignature");
  const end = source.indexOf("function stableSignatureValue", start);
  assert.ok(start >= 0 && end > start);
  const signatureSource = source.slice(start, end);

  assert.match(signatureSource, /actor\.system\?\.constructPartSlots/);
  assert.match(signatureSource, /stableSignatureValue\(slot\)/);
});
