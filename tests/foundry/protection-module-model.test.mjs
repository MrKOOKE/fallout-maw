import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";

const core = process.env.FALLOUT_MAW_FOUNDRY_CORE;

test("native gear schema preserves protective modules, their slots and condition", { skip: !core }, async () => {
  await import(pathToFileURL(path.join(core, "common/server.mjs")));
  foundry.applications = { api: { DialogV2: class {} }, ux: { FormDataExtended: class {} }, handlebars: { renderTemplate: async () => "" } };
  globalThis.game = {
    release: { version: "14.361" }, settings: { get: () => ({}) }, i18n: { localize: key => key, format: key => key },
    system: { id: "fallout-maw", version: "0.2.1", documentTypes: { Item: { gear: {} } } },
    model: { Item: { gear: {} }, ActiveEffect: { base: {} } }
  };
  const { GearDataModel } = await import("../../src/data/models/item-data-models.mjs");
  globalThis.CONFIG = { Item: { documentClass: foundry.documents.BaseItem, dataModels: { gear: GearDataModel } }, ActiveEffect: { dataModels: {} }, Folder: {} };
  const create = functions => new foundry.documents.BaseItem({ name: "Test gear", type: "gear", system: { functions } });
  const module = create({
    condition: { enabled: true, value: 75, max: 100 },
    module: { enabled: true, name: "plate", targetFunction: "damageMitigation", damageMitigation: {
      mode: "resistance", wearResistance: 3,
      requirements: [{ type: "characteristic", key: "strength", value: 4 }],
      limbSetIds: ["human"], entries: { torso: { physical: { value: 12 } } }
    } }
  });
  assert.equal(module.system.functions.module.targetFunction, "damageMitigation");
  assert.equal(module.system.functions.module.damageMitigation.entries.torso.physical.value, 12);
  const armor = create({ damageMitigation: { enabled: true, moduleSlots: [
    { id: "plate", moduleKey: "plate", itemData: module.toObject() }
  ] } });
  const roundTrip = create(armor.toObject().system.functions);
  const slots = roundTrip.system.functions.damageMitigation.moduleSlots;
  assert.equal(slots.length, 1);
  assert.equal(slots[0].itemData.system.functions.condition.value, 75);
  assert.equal(slots[0].itemData.system.functions.module.damageMitigation.wearResistance, 3);
  assert.equal(slots[0].itemData.system.functions.module.damageMitigation.requirements[0].value, 4);
  const legacy = create({ module: { enabled: true, weapon: { damage: 5 } } });
  assert.equal(legacy.system.functions.module.targetFunction, "weapon");
  assert.equal(legacy.system.functions.module.weapon.damage, 5);
  const newArmor = create({ damageMitigation: { enabled: true } });
  assert.deepEqual(newArmor.system.functions.damageMitigation.moduleSlots, []);
});
