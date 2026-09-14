import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { readFileSync } from "node:fs";
import { buildEquippedItemDamageMitigation, prepareItemDamageMitigationCell } from "../src/items/damage-mitigation-preparation.mjs";
import { getDamageMitigationRequirements } from "../src/items/equipment-requirements.mjs";
import { createFullItemRestorationUpdate } from "../src/items/full-restoration.mjs";
import { getInstalledFunctionModuleItems, createActorItemOrInstalledModuleUpdate } from "../src/utils/item-functions.mjs";
import { isModuleItemCompatibleWithSlot, removeModuleOrSlot, applyWeaponModuleModifiers } from "../src/utils/weapon-modules.mjs";

function setProperty(object, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  for (const key of keys) object = object[key] ??= {};
  object[last] = value;
  return true;
}
function mergeObject(target, source, { inplace = true } = {}) {
  const result = inplace ? target : structuredClone(target);
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = mergeObject(result[key] ?? {}, value);
    } else result[key] = structuredClone(value);
  }
  return result;
}
globalThis.foundry = {
  applications: { api: { DialogV2: class {} }, ux: { FormDataExtended: class {} }, handlebars: { renderTemplate: async () => "" } },
  utils: {
    deepClone: structuredClone, mergeObject, setProperty,
    getProperty: (object, path) => path.split(".").reduce((value, key) => value?.[key], object),
    hasProperty: () => false,
    expandObject: object => {
      const result = {};
      for (const [key, value] of Object.entries(object)) setProperty(result, key, value);
      return result;
    },
    diffObject: (before, after) => isDeepStrictEqual(before, after) ? {} : structuredClone(after)
  }
};
const { calculateDamageMitigation, buildDamageMitigationEquipmentSnapshot, applyEquipmentConditionDamage } = await import("../src/combat/damage-hub.mjs");
const mitigation = (value, mode = "defense") => ({ enabled: true, mode, wearResistance: 0, entries: { torso: { physical: { value } } } });
const condition = (value = 100) => ({ enabled: true, value, max: 100 });
function moduleItem(value, { mode = "defense", state = 100, wearResistance = 0, requirements = [] } = {}) {
  return { name: "Protection module", type: "gear", system: { functions: {
    ...(state === null ? {} : { condition: condition(state) }),
    module: { enabled: true, name: "plate", targetFunction: "damageMitigation", damageMitigation: { ...mitigation(value, mode), wearResistance, requirements } }
  } } };
}
function armorWithModules(modules, { base = 10, state = 100 } = {}) {
  const armor = { id: "armor", uuid: "Actor.test.Item.armor", name: "Armor", type: "gear", system: {
    equipped: true, functions: { condition: condition(state), damageMitigation: {
      ...mitigation(base), moduleSlots: modules.map((itemData, index) => ({ id: `slot${index}`, moduleKey: "plate", itemUuid: `Item.source${index}`, itemData }))
    } }
  } };
  armor.toObject = () => structuredClone({ name: armor.name, type: armor.type, system: armor.system });
  armor.update = async changes => mergeObject(armor, foundry.utils.expandObject(changes));
  const actor = { items: new Map([[armor.id, armor]]), system: {}, effects: [], allApplicableEffects: () => [], updateEmbeddedDocuments: async (_type, updates) => {
    for (const { _id, ...changes } of updates) await actor.items.get(_id).update(changes);
  } };
  actor.items.contents = [armor];
  return { armor, actor };
}
function prepared(actor) {
  return buildEquippedItemDamageMitigation(actor.items.values(), { torso: {} }, [{ key: "physical" }], actor, { includeSources: true });
}
function hit(actor, amount, options = {}) {
  const values = prepared(actor);
  actor.getDamageDefense = () => values.defenses.torso.physical;
  actor.getDamageResistance = () => values.resistances.torso.physical;
  return calculateDamageMitigation(actor, amount, "physical", "torso", {}, {
    includeEquipmentConditionDamage: true,
    damageType: { settings: { equipmentConditionDamage: { enabled: true, formula: "blocked" } } }, ...options
  });
}

test("protection modules add their own mode and keep separate source attribution", () => {
  const { actor } = armorWithModules([moduleItem(5), moduleItem(8, { mode: "resistance" })]);
  const data = prepared(actor);
  assert.equal(data.defenses.torso.physical, 15);
  assert.equal(data.resistances.torso.physical, 8);
  assert.equal(data.defenseSources.torso.physical.length, 2);
  assert.equal(data.defenseSources.torso.physical[1].name, "Protection module");
  assert.deepEqual(buildDamageMitigationEquipmentSnapshot(actor, "physical", "torso").totals, { defense: 15, resistance: 8 });
  actor.items.get("armor").system.equipped = false;
  assert.equal(prepared(actor).defenses.torso.physical, 0);
});

test("damage is charged to each module and armor only for their respective shares", async () => {
  const modules = [moduleItem(10), moduleItem(10)];
  const { actor, armor } = armorWithModules(modules);
  const result = hit(actor, 60);
  assert.equal(result.amount, 30);
  assert.deepEqual(result.equipmentConditionDamage.map(entry => entry.amount), [10, 10, 10]);
  assert.equal(new Set(result.equipmentConditionDamage.map(entry => entry.itemId)).size, 3);
  await applyEquipmentConditionDamage(actor, result.equipmentConditionDamage);
  assert.equal(armor.system.functions.condition.value, 90);
  for (const slot of armor.system.functions.damageMitigation.moduleSlots) assert.equal(slot.itemData.system.functions.condition.value, 90);
  assert.equal(modules[0].system.functions.condition.value, 100, "source item is never damaged");
});

test("module wear resistance applies to its own blocked damage", async () => {
  const { actor, armor } = armorWithModules([moduleItem(10, { wearResistance: 4 }), moduleItem(5, { mode: "resistance" })]);
  const result = hit(actor, 60);
  assert.deepEqual(result.equipmentConditionDamage.map(entry => entry.amount), [10, 6, 5]);
  await applyEquipmentConditionDamage(actor, result.equipmentConditionDamage);
  assert.equal(armor.system.functions.damageMitigation.moduleSlots[0].itemData.system.functions.condition.value, 94);
});

test("a module without condition protects without transferring its wear to armor", () => {
  const { actor } = armorWithModules([moduleItem(20, { state: null })]);
  const result = hit(actor, 60);
  assert.equal(result.amount, 30);
  assert.deepEqual(result.equipmentConditionDamage, [{ itemId: "armor", amount: 10 }]);
});

test("weakening belongs to each source and a broken module stops protecting", async () => {
  const { actor, armor } = armorWithModules([moduleItem(20, { state: 20 })]);
  assert.equal(prepared(actor).defenses.torso.physical, 22);
  const module = getInstalledFunctionModuleItems(armor, "damageMitigation", { actor })[0];
  await applyEquipmentConditionDamage(actor, [{ itemId: module.id, amount: 100 }]);
  assert.equal(prepared(actor).defenses.torso.physical, 10);
  assert.equal(armor.system.functions.condition.value, 100);
  assert.equal(prepared(actor).defenseSources.torso.physical[1].value, 0);
  const update = createFullItemRestorationUpdate(armor);
  assert.equal(update.system.functions.damageMitigation.moduleSlots[0].itemData.system.functions.condition.value, 100);
});

test("percentage mitigation shares only the damage actually blocked", () => {
  const { actor } = armorWithModules([moduleItem(10)]);
  const result = hit(actor, 50, { damageMitigationCalculation: "percentage" });
  assert.equal(result.amount, 40);
  assert.deepEqual(result.equipmentConditionDamage.map(entry => entry.amount), [5, 5]);
});

test("the armor tooltip combines modules into one cell using each source's condition and rounding", () => {
  const { actor, armor } = armorWithModules([moduleItem(50), moduleItem(20, { state: 20 }), moduleItem(8, { mode: "resistance" })], { base: 36 });
  actor.system.equipmentEffectiveness = { protectionPercent: 15 };
  const cell = prepareItemDamageMitigationCell(armor, actor, "torso", "physical");
  assert.equal(cell.defense.value, Math.floor(36 * 1.15) + Math.floor(50 * 1.15) + Math.floor(12 * 1.15));
  assert.equal(cell.defense.value, prepared(actor).defenses.torso.physical);
  assert.equal(cell.resistance.value, prepared(actor).resistances.torso.physical);
  assert.equal(cell.defense.sources.length, 3);
  armor.system.functions.damageMitigation.moduleSlots[0].itemData.system.functions.condition.value = 0;
  assert.equal(prepareItemDamageMitigationCell(armor, actor, "torso", "physical").defense.value, 54);
});

test("compatible slots accept the proper function and removal preserves an occupied slot", () => {
  const module = moduleItem(5);
  const slot = { id: "slot", moduleKey: "plate", itemUuid: "Item.source", itemData: module };
  assert.equal(isModuleItemCompatibleWithSlot(module, slot, "damageMitigation"), true);
  assert.equal(isModuleItemCompatibleWithSlot(module, slot), false);
  assert.equal(isModuleItemCompatibleWithSlot(module, { moduleKey: "other" }, "damageMitigation"), false);
  const removed = removeModuleOrSlot([slot], 0);
  assert.deepEqual(removed, [{ id: "slot", moduleKey: "plate", itemUuid: "", itemData: {} }]);
  assert.deepEqual(removeModuleOrSlot(removed, 0), []);
  assert.equal(slot.itemData, module);
  assert.deepEqual(removeModuleOrSlot([{ id: "legacy", itemUuid: "Item.source" }], 0), [{ id: "legacy", itemUuid: "", itemData: {} }]);
});

test("module requirements and virtual updates use the protection slot", () => {
  const requirements = [{ type: "characteristic", key: "strength", value: 3 }];
  const { actor, armor } = armorWithModules([moduleItem(5, { requirements })]);
  assert.deepEqual(getDamageMitigationRequirements(armor), requirements);
  const module = getInstalledFunctionModuleItems(armor, "damageMitigation", { actor })[0];
  const update = createActorItemOrInstalledModuleUpdate(actor, module, { "system.functions.condition.value": 25 });
  assert.equal(update._id, "armor");
  assert.equal(update["system.functions.damageMitigation.moduleSlots"][0].itemData.system.functions.condition.value, 25);
  assert.equal(update["system.functions.weapon.moduleSlots"], undefined);
});

test("weapon slots keep their modifiers and also empty before removal", () => {
  const weapon = { damage: 10, moduleSlots: [{ id: "weaponSlot", itemData: { system: { functions: {
    module: { enabled: true, targetFunction: "weapon", weapon: { damage: 5 } }
  } } } }] };
  assert.equal(applyWeaponModuleModifiers(weapon).damage, 15);
  const removed = removeModuleOrSlot(weapon.moduleSlots, 0);
  assert.equal(removed.length, 1);
  assert.equal(applyWeaponModuleModifiers({ ...weapon, moduleSlots: removed }).damage, 10);
});

test("both item editors share mitigation controls and removal dispatches to the correct function", () => {
  const source = readFileSync(new URL("../src/sheets/item-sheet.mjs", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf("  #onDeleteWeaponModuleSlot(event)"), source.indexOf("  #onWeaponModuleSlotDragOver(event)"));
  const body = handler.slice(handler.indexOf("{") + 1, handler.lastIndexOf("}"));
  const remove = new Function("getModuleSlotFunctionPath", "getWeaponModuleSlots", "removeModuleOrSlot", `return function(event) { ${body} }`)(
    element => element.path, data => data.moduleSlots, removeModuleOrSlot
  );
  for (const target of ["weapon", "damageMitigation"]) {
    const path = `system.functions.${target}`;
    let changes;
    const item = { system: { functions: { [target]: { moduleSlots: [{ id: "s", itemData: moduleItem(5) }] } } }, update: data => changes = data };
    remove.call({ item }, { preventDefault() {}, currentTarget: { path, dataset: { deleteWeaponModuleSlot: "0" } } });
    assert.equal(changes[`${path}.moduleSlots`].length, 1);
    assert.deepEqual(changes[`${path}.moduleSlots`][0].itemData, {});
  }
});
