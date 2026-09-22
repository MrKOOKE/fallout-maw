import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ITEM_FUNCTIONS } from "../src/utils/item-functions.mjs";
import {
  createWeaponModuleSlotItemData, findFreeFunctionModuleSlot,
  getModuleSlotFunctionEntries, isFunctionModuleItem
} from "../src/utils/weapon-modules.mjs";
import { getCraftCompatibilityActions, filterCompatibleCraftRecipes } from "../src/utils/craft-recipe-compatibility.mjs";

globalThis.foundry = { utils: { deepClone: structuredClone } };
const gear = (id, functions) => ({ id, uuid: `Item.${id}`, type: "gear", system: { quantity: 2, functions } });
const moduleItem = targetFunction => gear("module", { module: { enabled: true, name: "plate", targetFunction } });
const armor = () => gear("armor", { damageMitigation: { enabled: true, moduleSlots: [{ id: "slot", moduleKey: "plate" }] } });
const source = readFileSync(new URL("../src/utils/weapon-module-drop.mjs", import.meta.url), "utf8");
function readFunction(name) {
  return source.match(new RegExp(`(?:export )?(?:async )?function ${name}\\([^]*?\\n\\}`))[0].replace(/^export /, "");
}

test("protection drag targets and craft results respect function, slot name and occupancy", () => {
  const target = armor();
  const module = moduleItem("damageMitigation");
  const isDrop = new Function("getModuleSlotFunctionEntries", "isFunctionModuleItem", `${readFunction("isWeaponModuleDrop")}; return isWeaponModuleDrop;`)(getModuleSlotFunctionEntries, isFunctionModuleItem);
  assert.equal(isDrop(module, target), true);
  assert.equal(isDrop(moduleItem("weapon"), target), false);
  assert.equal(findFreeFunctionModuleSlot(target, module).entry.targetFunction, "damageMitigation");
  assert.equal(findFreeFunctionModuleSlot(target, moduleItem("weapon")), null);
  assert.equal(findFreeFunctionModuleSlot(module, module), null);
  assert.ok(getCraftCompatibilityActions(target).some(action => action.kind === "modules"));
  const recipes = [{ itemUuid: module.uuid }];
  assert.equal(filterCompatibleCraftRecipes(target, "modules", recipes, () => module).length, 1);
  const slot = target.system.functions.damageMitigation.moduleSlots[0];
  slot.moduleKey = "other";
  assert.equal(findFreeFunctionModuleSlot(target, module), null);
  slot.moduleKey = "plate";
  slot.itemUuid = "Item.missing";
  assert.equal(findFreeFunctionModuleSlot(target, module), null);
  slot.itemUuid = "";
  slot.itemData = { system: {} };
  assert.equal(findFreeFunctionModuleSlot(target, module), null);
  assert.equal(filterCompatibleCraftRecipes(target, "modules", recipes, () => module).length, 0);
});

test("hybrid gear selects the function improved by the module, including broken equipment", () => {
  const target = armor();
  target.system.functions.weapon = { enabled: true, moduleSlots: [{ id: "weapon", moduleKey: "plate" }] };
  target.system.functions.condition = { enabled: true, value: 0, max: 100 };
  assert.equal(findFreeFunctionModuleSlot(target, moduleItem("damageMitigation")).entry.id, "damageMitigation");
  assert.equal(findFreeFunctionModuleSlot(target, moduleItem("weapon")).entry.id, "weapon");
});

test("dropping a protection module installs and consumes together without changing the magazine", async () => {
  const target = armor();
  const data = moduleItem("damageMitigation");
  const actor = { isOwner: true, documentName: "Actor", items: new Map([[target.id, target]]) };
  const sourceActor = { isOwner: true, documentName: "Actor", items: new Map() };
  const module = { ...data, parent: sourceActor, toObject: () => structuredClone(data) };
  sourceActor.items.set(module.id, module);
  let applied;
  const dependencies = {
    ITEM_FUNCTIONS, findFreeFunctionModuleSlot, createWeaponModuleSlotItemData,
    getItemQuantity: item => item.system.quantity,
    getWeaponFunctionUpdatePath: () => { throw new Error("Unexpected weapon path"); },
    planWeaponMagazineCapacityTransition: () => { throw new Error("Unexpected magazine mutation"); },
    planInventoryItemConsumption: ({ item, amount, stackIndex }) => {
      assert.equal(item, module);
      assert.equal(amount, 1);
      assert.equal(stackIndex, 1);
      return { changed: true, updates: [{ _id: item.id, "system.quantity": 1 }], deletes: [] };
    },
    executeInventoryMutation: async plans => { applied = plans; },
    game: { user: { isGM: false }, i18n: { localize: key => key } },
    ui: { notifications: { warn: message => assert.fail(message) } }
  };
  const install = new Function(...Object.keys(dependencies), `${readFunction("canInstallModule")}\n${readFunction("installDroppedWeaponModule")}; return installDroppedWeaponModule;`)(...Object.values(dependencies));
  assert.equal(await install({ actor, weapon: target, moduleItem: module, sourceStackIndex: 1 }), target);
  const update = applied[0].updates[0];
  assert.equal(update["system.functions.damageMitigation.moduleSlots"][0].itemData.system.quantity, 1);
  assert.equal(update["system.functions.weapon.moduleSlots"], undefined);
  assert.equal(applied[1].actor, sourceActor);
  assert.equal(applied[1].updates[0]["system.quantity"], 1);
  sourceActor.isOwner = false;
  applied = null;
  assert.equal(await install({ actor, weapon: target, moduleItem: module }), null);
  assert.equal(applied, null);
});
