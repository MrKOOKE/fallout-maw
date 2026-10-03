import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

// The native inventory module also imports a dialog class; this test exercises
// its pure placement validator without creating any Foundry application.
function mergeObject(target, source, { inplace = true } = {}) {
  const result = inplace ? target : structuredClone(target);
  for (const [key, value] of Object.entries(source)) result[key] = value && typeof value === "object" && !Array.isArray(value)
    ? mergeObject(result[key] && typeof result[key] === "object" ? result[key] : {}, value)
    : structuredClone(value);
  return result;
}
globalThis.foundry = { applications: { api: { DialogV2: class {} }, ux: { FormDataExtended: class {} },
  handlebars: { renderTemplate: () => "" } }, utils: { deepClone: structuredClone, mergeObject } };
const { createModularTankDemo, upgradeTankDemo } = await import("../src/apps/modular-tank-demo.mjs");
const { normalizeConstructVisual, resolveConstructVisualAnchors } = await import("../src/utils/construct-visual-model.mjs");
const { MODULAR_TANK_DEMO_RACE_ID, ensureModularTankDemoAnatomy, prepareModularTankDemoCharacter, repairEmptyModularTankDemoCharacter } = await import("../src/apps/modular-tank-demo-anatomy.mjs");
const { buildEquippedItemDamageMitigation } = await import("../src/items/damage-mitigation-preparation.mjs");
const { DEFAULT_DAMAGE_TYPES } = await import("../src/config/defaults.mjs");
const { createActorNonInventoryPlacementValidator } = await import("../src/inventory/repair.mjs");
const { planModularTankProductionUpgrade } = await import("../src/apps/modular-tank-production-upgrade.mjs");
const { decorateConstructResourceAvailability } = await import("../src/utils/construct-systems.mjs");

const blueprint = JSON.parse(await readFile(new URL("../assets/examples/modular-tank.json", import.meta.url), "utf8"));

function runtime({ failScene = false, creatureOptions = { types: [], races: [] } } = {}) {
  let index = 0;
  const collection = () => ({ contents: [], get(id) { return this.contents.find(doc => doc.id === id); },
    find(predicate) { return this.contents.find(predicate); }, [Symbol.iterator]() { return this.contents[Symbol.iterator](); } });
  const collections = { actors: collection(), items: collection(), scenes: collection(), folders: collection() };
  const applyChanges = (data, changes) => {
    for (const [path, value] of Object.entries(changes)) {
      const keys = path.split("."); let current = data;
      for (const key of keys.slice(0, -1)) current = current[key] ??= {};
      current[keys.at(-1)] = structuredClone(value);
    }
  };
  function document(source, kind, collection, parent = null) {
    const data = structuredClone(source);
    const id = parent && data._id ? data._id : `document-${++index}`;
    const doc = { ...data, id, uuid: parent ? `${parent.uuid}.${kind}.${id}` : `${kind}.${id}`, parent, _source: data,
      getFlag: (scope, key) => data.flags?.[scope]?.[key],
      async update(changes) { applyChanges(data, changes); for (const key of Object.keys(changes).map(path => path.split(".")[0])) doc[key] = data[key]; return doc; },
      async delete() { const i = collection.contents.indexOf(doc); if (i >= 0) collection.contents.splice(i, 1); }
    };
    collection.contents.push(doc);
    return doc;
  }
  const settings = new Map([["fallout-maw.creatureOptions", structuredClone(creatureOptions)]]);
  globalThis.game = { user: { isGM: true }, ...collections, settings: {
    get: (scope, key) => settings.get(`${scope}.${key}`),
    async set(scope, key, value) { settings.set(`${scope}.${key}`, structuredClone(value)); return value; }
  } };
  globalThis.Folder = { async create(source) { return document(source, "Folder", collections.folders); } };
  globalThis.Item = { async create(source) { return document(source, "Item", collections.items); } };
  globalThis.Actor = { async create(source, options) {
    const doc = document(source, "Actor", collections.actors);
    doc.creationOptions = options;
    doc.items = collection();
    for (const item of source.items ?? []) document(item, "Item", doc.items, doc);
    doc.createEmbeddedDocuments = async (_type, sources) => sources.map(row => document(row, "Item", doc.items, doc));
    doc.updateEmbeddedDocuments = async (_type, changes) => Promise.all(changes.map(({ _id, ...update }) => doc.items.get(_id).update(update)));
    doc.deleteEmbeddedDocuments = async (_type, ids) => Promise.all(ids.map(id => doc.items.get(id).delete()));
    doc.getTokenDocument = async token => ({ toObject: () => ({ ...structuredClone(doc.prototypeToken), ...structuredClone(token), actorId: doc.id }) });
    return doc;
  } };
  globalThis.Scene = { async create(source) {
    if (failScene) throw new Error("scene failure");
    const doc = document(source, "Scene", collections.scenes);
    doc.tokens = collection();
    doc.createEmbeddedDocuments = async (_type, sources) => sources.map(row => document(row, "Token", doc.tokens, doc));
    doc.updateEmbeddedDocuments = async (_type, changes) => Promise.all(changes.map(({ _id, ...update }) => doc.tokens.get(_id).update(update)));
    return doc;
  } };
  return collections;
}

test("portable tank blueprint contains four native seats, one chassis and a turret-mounted cannon muzzle", () => {
  const tank = blueprint.tank;
  const parts = tank.items.filter(item => item.system.functions.constructPart?.enabled);
  assert.equal(parts.length, 5);
  assert.equal(parts.filter(item => item.system.placement.limbKey === "chassis").length, 1);
  const visual = normalizeConstructVisual(tank.flags["fallout-maw"].constructVisual);
  assert.deepEqual(visual.seats.map(seat => seat.role), ["driver", "gunner", "passenger", "passenger"]);
  assert.deepEqual(visual.seats[1].functions, ["aim", "fire", "reload"]);
  assert.equal(visual.parts.find(part => part.slotId === "turret").rotationSpeed, 90);
  assert.deepEqual(visual.parts.find(part => part.slotId === "turret").rotationCost, { points: 2, degrees: 30 });
  const cannon = tank.items.find(item => item.system.placement.limbKey === "cannons");
  assert.equal(cannon.system.functions.weapon.requiresOperator, true);
  assert.equal(cannon.system.functions.weapon.operatorPartSlotId, "turret");
  assert.equal(cannon.system.functions.weapon.magazine.value, 2);
  assert.equal(cannon.system.functions.weapon.magazine.max, 2);
  assert.equal(cannon.system.functions.weapon.burst.count, 2);
  assert.equal(cannon.system.functions.weapon.availableActions.burst, true);
  assert.deepEqual(cannon.system.functions.weapon.effectiveRange, { value: "0", max: "60" });
  assert.equal(cannon.system.functions.weapon.maxRangeMeters, "100");
  assert.equal(blueprint.scene.environment.darknessLevel, 0);
  assert.equal(blueprint.scene.environment.darknessLock, true);
  assert.equal(blueprint.scene.environment.cycle, false);
  const muzzle = resolveConstructVisualAnchors(visual, { width: 4, height: 7 }).find(anchor => anchor.id === "muzzle-center");
  assert.ok(Math.abs(muzzle.x - .52204724) < 1e-8);
  assert.ok(Math.abs(muzzle.y - .05468130) < 1e-8);
});

test("sample creation resolves ammunition references, preserves physical seat IDs and leaves boarding to gameplay", async () => {
  const collections = runtime();
  const original = JSON.stringify(blueprint);
  const result = await createModularTankDemo({ blueprint, populateCrew: true, createTarget: true, createScene: true });
  assert.equal(result.crew.length, 4);
  assert.equal(result.tokens.length, 6);
  assert.equal(result.tank.creationOptions.keepEmbeddedIds, true);
  assert.equal(result.tank.items.find(item => item.system.placement.limbKey === "cannons").system.functions.weapon.magazine.sourceItemUuid, result.shell.uuid);
  assert.equal(result.tank.items.find(item => item.id === "mwtankAmmo000001").flags["fallout-maw"].damageSourcePrototypeUuid, result.shell.uuid);
  assert.deepEqual(result.tank.flags["fallout-maw"].actorContainer.passengers, []);
  assert.equal(collections.actors.contents.length, 6);
  assert.equal(JSON.stringify(blueprint), original);
});

test("sample anatomy works without world races and adds its race without editing existing settings", async () => {
  const existing = { id: "worldRace", typeId: "worldType", name: "Existing race", limbs: [{ key: "body", stateMax: "777" }] };
  runtime({ creatureOptions: { types: [{ id: "worldType", name: "Existing type" }], races: [existing] } });
  const result = await createModularTankDemo({ blueprint, populateCrew: true });
  const options = game.settings.get("fallout-maw", "creatureOptions");
  assert.deepEqual(options.races[0], existing);
  const race = options.races.find(row => row.id === MODULAR_TANK_DEMO_RACE_ID);
  assert.equal(race.limbs.length, 8);
  assert.ok(race.limbs.filter(limb => limb.critical).length > 0);
  assert.ok(race.limbs.every(limb => limb.stateMax === "100 + 0"));
  for (const actor of result.crew) {
    assert.equal(actor.system.creature.raceId, race.id);
    assert.deepEqual(Object.keys(actor.system.limbs), race.limbs.map(limb => limb.key));
    assert.ok(Object.values(actor.system.limbs).every(limb => limb.spent === 0 && !limb.missing));
    assert.equal(actor.system.resources.consciousness.spent, 0);
    assert.equal(actor.system.development.initialized, true);
  }
  await createModularTankDemo({ blueprint, populateCrew: true });
  assert.equal(game.settings.get("fallout-maw", "creatureOptions").races.length, 2);
});

test("legacy empty sample anatomy is repaired while viable wounded sample actors stay untouched", async () => {
  runtime();
  await createModularTankDemo({ blueprint, populateCrew: true });
  const race = game.settings.get("fallout-maw", "creatureOptions").races.find(row => row.id === MODULAR_TANK_DEMO_RACE_ID);
  const empty = { system: { creature: { raceId: "" }, limbs: {}, resources: { health: { max: 0 } } },
    async update(changes) { this.changes = changes; } };
  assert.equal(await repairEmptyModularTankDemoCharacter(empty, race), true);
  assert.equal(empty.changes["system.creature"].raceId, race.id);
  assert.equal(Object.keys(empty.changes["system.limbs"]).length, 8);
  const wounded = { system: prepareModularTankDemoCharacter(blueprint.target, race).system,
    async update() { assert.fail("A viable damaged sample must not be reset"); } };
  wounded.system.resources.health.max = 800;
  wounded.system.limbs.torso.spent = 45;
  assert.equal(await repairEmptyModularTankDemoCharacter(wounded, race), false);
  assert.equal(wounded.system.limbs.torso.spent, 45);
});

test("repeated installation reuses its sample documents and preserves user edits", async () => {
  const collections = runtime();
  const first = await createModularTankDemo({ blueprint, populateCrew: true, createTarget: true, createScene: true });
  first.tank.name = "Edited sample";
  const second = await createModularTankDemo({ blueprint, populateCrew: true, createTarget: true, createScene: true });
  assert.equal(second.tank, first.tank);
  assert.equal(second.tank.name, "Edited sample");
  assert.deepEqual(second.created, []);
  assert.equal(collections.items.contents.length, 9);
  assert.equal(collections.scenes.contents.length, 1);
  assert.equal(first.scene.tokens.contents.length, 6);
});

test("reinstalling while crew is aboard does not duplicate parked crew tokens", async () => {
  runtime();
  const first = await createModularTankDemo({ blueprint, populateCrew: true, createTarget: true, createScene: true });
  first.tank.flags["fallout-maw"].actorContainer.passengers = first.crew.map((actor, index) => ({
    id: `passenger-${index}`, actorUuid: actor.uuid, slotId: "cabin:crew", slotIndex: index
  }));
  for (const token of [...first.scene.tokens.contents]) {
    if (first.crew.some(actor => actor.id === token.actorId)) await token.delete();
  }
  assert.equal(first.scene.tokens.contents.length, 2);
  const second = await createModularTankDemo({ blueprint, populateCrew: true, createTarget: true, createScene: true });
  assert.deepEqual(second.created, []);
  assert.equal(second.tokens.length, 2);
  assert.equal(first.scene.tokens.contents.length, 2);
  assert.equal(second.crew.length, 4);
});

test("failed installation rolls back only newly created sample documents", async () => {
  const collections = runtime({ failScene: true });
  const untouched = { id: "original", name: "Original actor", getFlag: () => null };
  collections.actors.contents.push(untouched);
  await assert.rejects(createModularTankDemo({ blueprint, createScene: true }), /scene failure/);
  assert.deepEqual(collections.actors.contents, [untouched]);
  assert.deepEqual(collections.items.contents, []);
  assert.deepEqual(collections.folders.contents, []);
});

test("default delivery creates ready actors without creating or modifying a scene", async () => {
  const collections = runtime();
  const unrelated = await Scene.create({ name: "Existing campaign map", flags: {} });
  const result = await createModularTankDemo({ blueprint, populateCrew: true, scene: unrelated });
  assert.equal(result.scene, null);
  assert.deepEqual(result.tokens, []);
  assert.deepEqual(collections.scenes.contents, [unrelated]);
  assert.equal(unrelated.tokens.contents.length, 0);
  assert.equal(result.crew.length, 4);
  const race = game.settings.get("fallout-maw", "creatureOptions").races.find(row => row.id === MODULAR_TANK_DEMO_RACE_ID);
  const prototype = collections.items.contents.find(item => item.getFlag("fallout-maw", "modularTankDemo").kind === "personal-ammo");
  for (const passenger of result.crew.slice(2)) {
    const pistol = passenger.items.find(item => item.system.functions.weapon?.enabled);
    const reserve = passenger.items.find(item => item.system.functions.damageSource?.enabled);
    const validate = createActorNonInventoryPlacementValidator(passenger, race);
    assert.equal(validate(pistol), true, "The sample must pass the same slot validator that recovered the malformed pistol in Foundry");
    const malformed = structuredClone(pistol.system);
    malformed.weaponSlotRequirement.slots = {};
    assert.equal(createActorNonInventoryPlacementValidator(passenger, race)({ ...pistol, system: malformed }), false);
    assert.equal(pistol.system.functions.weapon.requiresOperator, false);
    assert.equal(pistol.system.functions.weapon.magazine.value, 8);
    assert.equal(pistol.system.functions.weapon.magazine.sourceItemUuid, prototype.uuid);
    assert.equal(pistol.system.functions.condition.value, 100);
    assert.equal(reserve.system.quantity, 24);
    assert.equal(reserve.flags["fallout-maw"].damageSourcePrototypeUuid, prototype.uuid);
  }
  const visual = result.tank.flags["fallout-maw"].constructVisual;
  assert.deepEqual(visual.seats.slice(2).map(seat => seat.personalWeapons.coverPercent), [70, 70]);
  assert.deepEqual(visual.seats.slice(2).map(seat => seat.personalWeapons.maxRangeMeters), [null, null]);
  assert.deepEqual(visual.anchors.filter(anchor => anchor.id.startsWith("window-")).map(anchor => anchor.parentSlotId), ["hull", "hull"]);
});

test("native sample armor protects only its installed hull and windows keep their own percentage", async () => {
  runtime();
  const { tank } = await createModularTankDemo({ blueprint, createTarget: false });
  const limbs = { "constructPart:hull": {}, "constructPart:engine": {} };
  const protection = buildEquippedItemDamageMitigation(tank.items, limbs, DEFAULT_DAMAGE_TYPES,
    { ...tank, system: { ...tank.system, equipmentEffectiveness: { protectionPercent: 0 } } });
  for (const type of DEFAULT_DAMAGE_TYPES) {
    assert.equal(protection.defenses["constructPart:hull"][type.key], 20);
    assert.equal(protection.defenses["constructPart:engine"][type.key], 0);
  }
});

async function legacySample() {
  const result = await createModularTankDemo({ blueprint, populateCrew: true, createTarget: false });
  const oldVisual = structuredClone(blueprint.tank.flags["fallout-maw"].constructVisual);
  oldVisual.anchors = oldVisual.anchors.filter(anchor => !anchor.id.startsWith("window-"));
  for (const seat of oldVisual.seats) delete seat.personalWeapons;
  await result.tank.update({ "flags.fallout-maw.constructVisual": oldVisual,
    "flags.fallout-maw.constructInterior": { version: 1, parts: [] },
    "flags.fallout-maw.modularTankDemo.revision": 1 });
  await result.tank.items.get("mwtankHull000001").update({ "system.functions.damageMitigation": { enabled: false, entries: {} } });
  for (const passenger of result.crew.slice(2)) {
    for (const item of [...passenger.items.contents]) await item.delete();
    await passenger.update({ "flags.fallout-maw.modularTankDemo.revision": 1 });
  }
  return result;
}

test("legacy upgrade adds missing windows, interior armor and crew loadout once while preserving live resources", async () => {
  const collections = runtime();
  const { tank, crew } = await legacySample();
  const cannon = tank.items.get("mwtankGuns000001");
  await cannon.update({ "system.functions.weapon.magazine.value": 1, "system.functions.condition.value": 233 });
  await tank.update({ name: "Campaign tank", "flags.other-system.note": "kept",
    "flags.fallout-maw.actorContainer.passengers": [{ id: "occupant", actorUuid: crew[0].uuid, slotId: "mwtankHull000001:crew", slotIndex: 0 }] });
  const occupants = structuredClone(tank.flags["fallout-maw"].actorContainer.passengers);
  const first = await upgradeTankDemo({ actor: tank.id, blueprint, populateCrew: true });
  assert.equal(first.updated, true);
  assert.equal(first.created.length, 4);
  assert.equal(tank.name, blueprint.tank.name);
  assert.equal(tank.flags["other-system"].note, "kept");
  assert.deepEqual(tank.flags["fallout-maw"].actorContainer.passengers, occupants);
  assert.equal(cannon.system.functions.weapon.magazine.value, 1);
  assert.equal(cannon.system.functions.condition.value, 233);
  assert.deepEqual(tank.flags["fallout-maw"].constructInterior.parts, [{ slotId: "engine", parentSlotId: "hull" }]);
  assert.equal(tank.items.get("mwtankHull000001").system.functions.damageMitigation.entries.constructPart.bludgeoning.value, 20);
  const second = await upgradeTankDemo({ actor: `Actor.${tank.id}`, blueprint, populateCrew: true });
  assert.equal(second.updated, false);
  assert.deepEqual(second.created, []);
  assert.equal(collections.actors.contents.length, 5);
  assert.equal(collections.items.contents.length, 9);
  assert.equal(collections.scenes.contents.length, 0);
  for (const passenger of crew.slice(2)) assert.equal(passenger.items.contents.length, 2);
});

test("legacy upgrade preserves customized anchors, disabled personal fire, containment and armor", async () => {
  runtime();
  const { tank } = await legacySample();
  const visual = tank.flags["fallout-maw"].constructVisual;
  visual.anchors.push({ id: "window-left", name: "User opening", x: .123, y: .321, rotation: 28 });
  visual.seats[2].name = "My combined station";
  visual.seats[2].personalWeapons = { enabled: false, coverPercent: 33, maxRangeMeters: 12 };
  await tank.update({ "flags.fallout-maw.constructVisual": visual,
    "flags.fallout-maw.constructInterior": { version: 1, parts: [{ slotId: "engine", parentSlotId: "turret" }] } });
  const armor = { enabled: false, mode: "resistance", entries: { constructPart: { fire: { value: 42 } } } };
  await tank.items.get("mwtankHull000001").update({ "system.functions.damageMitigation": armor });
  await upgradeTankDemo({ actor: tank, blueprint, populateCrew: false });
  const upgraded = tank.flags["fallout-maw"].constructVisual;
  assert.deepEqual(upgraded.anchors.find(anchor => anchor.id === "window-left"), visual.anchors.at(-1));
  assert.equal(upgraded.seats[2].name, "My combined station");
  assert.equal(upgraded.seats[2].personalWeapons.enabled, false);
  assert.equal(upgraded.seats[2].personalWeapons.coverPercent, 33);
  assert.equal(upgraded.seats[2].personalWeapons.maxRangeMeters, 12);
  assert.equal(upgraded.seats[2].personalWeapons.anchorId, "window-left");
  assert.equal(tank.flags["fallout-maw"].constructInterior.parts[0].parentSlotId, "turret");
  assert.deepEqual(tank.items.get("mwtankHull000001").system.functions.damageMitigation, armor);
});

test("existing personal weapons and intentionally removed upgraded features are preserved", async () => {
  runtime();
  const { tank, crew } = await legacySample();
  const customized = structuredClone(blueprint.crew[2].source.items[0]);
  customized._id = "usersOwnPistol001"; customized.name = "User sidearm"; customized.flags = {};
  customized.system.functions.weapon.magazine.value = 2;
  await crew[2].createEmbeddedDocuments("Item", [customized]);
  await upgradeTankDemo({ actor: tank, blueprint, populateCrew: true });
  assert.deepEqual(crew[2].items.contents.map(item => item.name), ["User sidearm"]);
  assert.equal(crew[2].items.get(customized._id).system.functions.weapon.magazine.value, 2);
  await crew[3].items.get("mwcrewPist000001").delete();
  const visual = structuredClone(tank.flags["fallout-maw"].constructVisual);
  visual.anchors = visual.anchors.filter(anchor => anchor.id !== "window-left");
  await tank.update({ "flags.fallout-maw.constructVisual": visual, "flags.fallout-maw.constructInterior": { version: 1, parts: [] } });
  const next = await upgradeTankDemo({ actor: tank, blueprint, populateCrew: true });
  assert.equal(next.updated, false);
  assert.deepEqual(next.created, []);
  assert.equal(crew[3].items.contents.length, 1);
  assert.equal(tank.flags["fallout-maw"].constructVisual.anchors.some(anchor => anchor.id === "window-left"), false);
  assert.deepEqual(tank.flags["fallout-maw"].constructInterior.parts, []);
});


async function productionLegacyFixture({ nativeUndefined = false } = {}) {
  const collections = runtime();
  const shellSource = structuredClone(blueprint.shell);
  shellSource.name = blueprint.legacyDefaults.shellName;
  shellSource.system.functions.damageSource.name = shellSource.name;
  shellSource.system.description = blueprint.legacyDefaults.shellDescription;
  shellSource.system.craft = structuredClone(blueprint.legacyDefaults.shellCraft);
  shellSource.flags = { "fallout-maw": { modularTankDemo: { packageId: blueprint.packageId, kind: "shell" } } };
  const shell = await Item.create(shellSource);
  const source = structuredClone(blueprint.tank);
  source.name = blueprint.legacyDefaults.tankName;
  source.img = blueprint.legacyDefaults.tankImg;
  source.prototypeToken.name = source.name;
  source.system.description = blueprint.legacyDefaults.tankDescriptions[0];
  source.system.constructPartSlots = structuredClone(blueprint.legacyDefaults.slots);
  source.items = structuredClone(blueprint.legacyDefaults.parts);
  for (const part of source.flags["fallout-maw"].constructVisual.parts) {
    if (part.id.startsWith("track-")) part.slotId = part.id.replace(/-image$/, "");
  }
  source.flags["fallout-maw"].modularTankDemo = { packageId: blueprint.packageId, kind: "tank", revision: 2 };
  source.flags["other-system"] = { note: "custom flag" };
  source.ownership = { default: 0, crewPlayer: 3 };
  for (const [key, value] of Object.entries({ power: 7, movementPoints: 19, actionPoints: 3, health: 17 })) source.system.resources[key].spent = value;
  const tank = await Actor.create(source, { keepEmbeddedIds: true });
  const passengers = Array.from({ length: 4 }, (_, slotIndex) => ({
    id: `real-passenger-${slotIndex}`, actorUuid: `Actor.nkr-${slotIndex}`, parkedActorId: `nkr-${slotIndex}`,
    slotId: "mwtankHull000001:crew", slotIndex, x: 1, y: 1, width: 1, height: 1,
    tokenData: { _id: `parked-${slotIndex}`, actorLink: false, width: 1, height: 1, x: 70, y: 130, rotation: 54,
      flags: { "user-module": { custom: true } }, delta: { system: { resources: { actionPoints: { spent: 9 } } } } }
  }));
  await tank.update({ "flags.fallout-maw.actorContainer.passengers": passengers });
  await tank.items.get("mwtankGuns000001").update({ "system.functions.weapon.magazine.value": 1, "system.functions.condition.value": 233 });
  const trackIds = ["mwtankFLft000001", "mwtankFRgt000001", "mwtankALft000001", "mwtankARgt000001"];
  for (const [index, id] of trackIds.entries()) {
    const item = tank.items.get(id);
    await item.update({ "system.functions.condition.value": [300, 150, 0, 300][index] });
    if (nativeUndefined) {
      item._source.system.functions.actorContainer = undefined;
      item._source.system.functions.freeSettings.entries[0].attackSettings = undefined;
    }
  }
  const scene = await Scene.create({ name: "Campaign", flags: { other: { keep: true } } });
  const [token, customizedToken] = await scene.createEmbeddedDocuments("Token", [{ actorId: tank.id, name: source.name,
    x: 570, y: 650, width: 4, height: 7, rotation: 133, flags: { "fallout-maw": { constructVisualState: { rotations: { turret: 44 } } } } },
    { actorId: tank.id, name: "Player's vehicle", x: 44, y: 88, width: 4, height: 7, rotation: 19, flags: {} }]);
  return { tank, shell, collections, scene, token, customizedToken, passengers, trackIds };
}

test("production migration preserves real crew, one-based positions and resources while joining damaged native tracks", async () => {
  const { tank, shell, collections, scene, token, customizedToken, passengers, trackIds } = await productionLegacyFixture({ nativeUndefined: true });
  const originalResources = structuredClone(tank._source.system.resources);
  const ownership = structuredClone(tank.ownership);
  const tokenState = structuredClone(token._source);
  const customTokenState = structuredClone(customizedToken._source);
  const armor = structuredClone(tank.items.get("mwtankHull000001").system.functions.damageMitigation);
  const shotState = structuredClone(tank.items.get("mwtankGuns000001").system.functions);
  const result = await upgradeTankDemo({ actor: tank, blueprint });
  assert.equal(result.updated, true);
  assert.deepEqual(result.retainedLegacyParts, []);
  assert.equal(tank.items.contents.filter(item => item.system.functions.constructPart?.enabled).length, 5);
  assert.deepEqual(tank.system.constructPartSlots.map(row => row.id), ["hull", "engine", "chassis", "turret", "cannons"]);
  assert.deepEqual(tank.system.constructPartSlots.map(row => row.order), [0, 1, 2, 3, 4]);
  const chassis = tank.items.get(trackIds[0]);
  assert.equal(chassis.system.placement.limbKey, "chassis");
  assert.equal(chassis.system.functions.condition.value, 188, "Remaining state is proportional, not reset to full");
  assert.equal(chassis.system.functions.condition.max, 300);
  assert.equal(chassis.flags["fallout-maw"].modularTankDemo.mergedTracks.length, 4);
  assert.deepEqual(chassis.system.functions.constructPart.systems,
    [{ systemId: "drive", capacity: 0, movementPoints: 40, activationProvider: false }]);
  assert.equal(chassis.system.functions.freeSettings.entries.length, 0);
  for (const id of trackIds.slice(1)) assert.equal(tank.items.get(id), undefined);
  assert.deepEqual(tank.items.get("mwtankHull000001").system.functions.actorContainer.slots, [{ id: "crew", width: 1, height: 1, quantity: 4 }]);
  assert.deepEqual(tank.flags["fallout-maw"].actorContainer.passengers, passengers);
  for (const [key, max] of [["power", 1000], ["movementPoints", 40]]) {
    originalResources[key].max = max;
    originalResources[key].value = max - originalResources[key].spent;
  }
  assert.deepEqual(tank._source.system.resources, originalResources);
  assert.deepEqual(tank.ownership, ownership);
  assert.equal(tank.flags["other-system"].note, "custom flag");
  assert.deepEqual(tank.items.get("mwtankHull000001").system.functions.damageMitigation, armor);
  shotState.weapon.magazine.max = 2;
  shotState.weapon.muzzleAnchorId = "muzzle-center";
  Object.assign(shotState.weapon.availableActions, { burst: true, volley: true, snapshot: false, aimedShot: false });
  Object.assign(shotState.weapon.burst, { count: 2, name: "Очередь" });
  shotState.weapon.volley.name = "Залп";
  assert.deepEqual(tank.items.get("mwtankGuns000001").system.functions, shotState);
  assert.equal(tank.name, blueprint.tank.name);
  assert.equal(tank.system.description, blueprint.tank.system.description);
  tokenState.name = blueprint.tank.name;
  Object.assign(tokenState, { x: 500, y: 700, width: 3, height: 5, texture: { scaleX: -1.4, scaleY: -1.4, anchorY: 0.5 + 1 / 7 } });
  tokenState.flags["fallout-maw"].movementAutoRotate = "on";
  tokenState.flags["fallout-maw"].rotationSpeedMultiplier = 1 / 3;
  tokenState.flags["fallout-maw"].tokenHitbox = structuredClone(blueprint.tank.prototypeToken.flags["fallout-maw"].tokenHitbox);
  customTokenState.name = blueprint.tank.name;
  Object.assign(customTokenState, { x: 100, y: 300, width: 3, height: 5, texture: { scaleX: -1.4, scaleY: -1.4, anchorY: 0.5 + 1 / 7 } });
  customTokenState.flags["fallout-maw"] = { movementAutoRotate: "on", rotationSpeedMultiplier: 1 / 3,
    tokenHitbox: structuredClone(blueprint.tank.prototypeToken.flags["fallout-maw"].tokenHitbox) };
  assert.deepEqual(token._source, tokenState);
  assert.deepEqual(customizedToken._source, customTokenState);
  assert.equal(scene.tokens.contents.length, 2);
  assert.equal(collections.scenes.contents.length, 1);
  assert.equal(collections.actors.contents.length, 1, "Actual campaign crew does not trigger creation or reassignment of sample actors");
  assert.equal(shell.name, blueprint.legacyDefaults.shellName, "The existing 40-mm prototype retains its ammunition identity");
  assert.deepEqual(shell.system.craft, {}, "The unchanged alien-cell recipe must not remain attached to a tank round");
});

test("hand-edited tracks and hardware containment are preserved instead of destructively consolidated", async () => {
  const { tank, trackIds } = await productionLegacyFixture();
  const track = tank.items.get(trackIds[1]);
  await track.update({ "system.functions.freeSettings.entries": [{ id: "user-upgrade", type: "effectChanges", changes: [{ key: "system.resources.movementPoints.bonus", value: "29" }] }] });
  const tracksBefore = trackIds.map(id => structuredClone(tank.items.get(id)._source));
  const result = await upgradeTankDemo({ actor: tank, blueprint });
  assert.deepEqual(result.retainedLegacyParts, trackIds);
  for (const [index, id] of trackIds.entries()) assert.deepEqual(tank.items.get(id)._source, tracksBefore[index]);
  assert.equal(tank.system.constructPartSlots.filter(row => row.id.startsWith("track-")).length, 4);
  const reference = await productionLegacyFixture();
  await reference.tank.update({ "flags.fallout-maw.constructInterior": { version: 1, parts: [{ slotId: "engine", parentSlotId: "track-fore-left" }] } });
  const plan = planModularTankProductionUpgrade(reference.tank, blueprint);
  assert.equal(plan.mergedTracks, false);
  assert.deepEqual(plan.deleteIds, []);
});

test("larger actual passengers prevent shrinking their native physical seats", async () => {
  const { tank } = await productionLegacyFixture();
  const passengers = structuredClone(tank.flags["fallout-maw"].actorContainer.passengers);
  passengers[0].width = 2; passengers[0].tokenData.width = 2;
  await tank.update({ "flags.fallout-maw.actorContainer.passengers": passengers });
  await upgradeTankDemo({ actor: tank, blueprint });
  assert.equal(tank.items.get("mwtankHull000001").system.functions.actorContainer.slots[0].width, 2);
  assert.deepEqual(tank.flags["fallout-maw"].actorContainer.passengers, passengers);
});

test("library delivery is idempotent and keeps reusable prototypes independent of actor-specific control slots", async () => {
  const { tank, shell, collections } = await productionLegacyFixture();
  const untouchedDamage = { ...structuredClone(shell.system.functions.damageSource), damage: "777", penetration: "99" };
  await shell.update({ "system.functions.damageSource": untouchedDamage });
  const first = await upgradeTankDemo({ actor: tank, blueprint });
  assert.equal(first.library.length, 9);
  assert.equal(first.library.filter(item => item.system.functions.constructPart?.enabled).length, 5);
  const weapon = first.library.find(item => item.getFlag("fallout-maw", "modularTankDemo").kind === "part:cannons");
  assert.equal(weapon.system.functions.weapon.operatorPartSlotId, "turret");
  assert.equal(weapon.system.functions.weapon.magazine.sourceItemUuid,
    first.library.find(item => item.getFlag("fallout-maw", "modularTankDemo").kind === "cannon-ammo").uuid);
  assert.equal(tank.items.get("mwtankGuns000001").system.functions.weapon.operatorPartSlotId, "turret");
  assert.ok(first.library.every(item => item.system.placement.mode === "inventory" && !item.system.equipped));
  assert.equal(shell.system.functions.damageSource.damage, "777");
  assert.equal(shell.system.functions.damageSource.penetration, "99");
  const folderPath = item => {
    const names = []; let folder = collections.folders.get(item.folder);
    while (folder) { names.unshift(folder.name); folder = collections.folders.get(folder.folder); }
    return names.join("/");
  };
  assert.equal(folderPath(weapon), "Военный транспорт/C");
  assert.equal(folderPath(shell), "", "The unused legacy prototype is not moved");
  const before = { items: collections.items.contents.length, folders: collections.folders.contents.length, actors: collections.actors.contents.length };
  await tank.items.get("mwtankGuns000001").update({ "system.functions.weapon.magazine.value": 0 });
  await shell.update({ name: "User's tank round" });
  const second = await upgradeTankDemo({ actor: tank, blueprint });
  assert.equal(second.updated, false);
  assert.deepEqual(second.created, []);
  assert.deepEqual({ items: collections.items.contents.length, folders: collections.folders.contents.length, actors: collections.actors.contents.length }, before);
  assert.equal(tank.items.get("mwtankGuns000001").system.functions.weapon.magazine.value, 0);
  assert.equal(shell.name, "User's tank round");
});

test("new optional crew use a real human anatomy when the world already supplies one", async () => {
  const human = { id: "native-human", typeId: "organic", name: "Человек", limbs: [{ key: "rightArm", stateMax: "80" }],
    weaponSets: [{ key: "native-set", slots: [{ key: "native-hand", limbKey: "rightArm" }] }] };
  runtime({ creatureOptions: { types: [{ id: "organic", name: "Люди" }], races: [human] } });
  assert.deepEqual(await ensureModularTankDemoAnatomy(), human);
  assert.deepEqual(game.settings.get("fallout-maw", "creatureOptions").races, [human]);
});


test("the normal factory creates one campaign-ready tank and a full world library without a test crew or scene", async () => {
  const collections = runtime();
  const result = await createModularTankDemo({ blueprint });
  assert.equal(collections.actors.contents.length, 1);
  assert.equal(result.tank.name, blueprint.tank.name);
  assert.equal(result.target, null);
  assert.deepEqual(result.crew, []);
  assert.equal(result.scene, null);
  assert.deepEqual(result.tokens, []);
  assert.equal(collections.scenes.contents.length, 0);
  assert.equal(result.library.length, 9);
  const fuel = result.library.find(item => item.getFlag("fallout-maw", "modularTankDemo")?.kind === "fuel");
  assert.equal(result.tank.system.constructSystems[0].recoveryMethods[0].resources[0].uuid, fuel.uuid);
  assert.equal(result.tank.items.get("mwtankFuel000001").flags["fallout-maw"].sourceId, fuel.uuid);
  assert.equal(result.tank.system.constructSystems[0].active, false);
  assert.equal(result.tank.system.resources.power.max, 1000);
  const energyDisplay = decorateConstructResourceAvailability(result.tank,
    { key: "power", value: 1000, max: 1000, maxLabel: "1000", valueLabel: "1000" });
  assert.equal(energyDisplay.valueLabel, 0);
  assert.equal(energyDisplay.maxLabel, "1000");
  assert.equal(energyDisplay.value, 1000, "Shutdown retains the stored reserve");
  assert.deepEqual(result.tank.items.get("mwtankEngn000001").system.functions.constructPart.systems,
    [{ systemId: "drive", capacity: 1000, movementPoints: 0, activationProvider: true }]);
  assert.deepEqual(game.settings.get("fallout-maw", "creatureOptions"), { types: [], races: [] });
  const deliveredIds = result.library.map(item => item.id);
  const again = await createModularTankDemo({ blueprint });
  assert.deepEqual(again.created, []);
  assert.deepEqual(again.library.map(item => item.id), deliveredIds);
  assert.equal(again.tank, result.tank);
});

test("an intentionally removed legacy block is not resurrected or compensated by a new intact chassis", async () => {
  const { tank, trackIds } = await productionLegacyFixture();
  await tank.items.get(trackIds[2]).delete();
  const remaining = trackIds.filter(id => id !== trackIds[2]);
  const before = remaining.map(id => structuredClone(tank.items.get(id)._source));
  const result = await upgradeTankDemo({ actor: tank, blueprint });
  assert.deepEqual(result.retainedLegacyParts, remaining);
  assert.equal(tank.items.get(trackIds[2]), undefined);
  assert.equal(tank.items.contents.some(item => item.system.placement.limbKey === "chassis"), false);
  for (const [index, id] of remaining.entries()) assert.deepEqual(tank.items.get(id)._source, before[index]);
});
