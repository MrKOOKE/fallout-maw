import assert from "node:assert/strict";
import test from "node:test";

import {
  captureDocumentSnapshot,
  classifyActiveEffectCreate,
  classifyActiveEffectDelete,
  classifyActiveEffectUpdate,
  classifyActorUpdate,
  classifyCombatDelete,
  classifyCombatUpdate,
  classifyCombatantUpdate,
  classifyItemCreate,
  classifyItemDelete,
  classifyItemUpdate,
  flattenDocumentChanges,
  registerFoundryDocumentSystemEventHooks
} from "../src/events/foundry-document-events.mjs";

function createActor(source = {}) {
  const actor = {
    id: "actor-1",
    uuid: "Actor.actor-1",
    documentName: "Actor",
    type: "character",
    statuses: new Set(),
    items: [],
    _source: source,
    toObject() {
      return structuredClone(this._source);
    }
  };
  return actor;
}

function createItem(actor, type = "gear", source = {}) {
  return {
    id: "item-1",
    uuid: `${actor?.uuid ?? "Item"}.Item.item-1`,
    documentName: "Item",
    type,
    actor,
    parent: actor,
    _source: { type, ...source },
    toObject() {
      return structuredClone(this._source);
    }
  };
}

function eventKeys(events) {
  return events.map(event => event.key);
}

test("Actor classifier emits only exact specialized events and ignores unclassified paths", () => {
  const actor = createActor({
    system: {
      resources: { health: { value: 9 }, actionPoints: { value: 4 } },
      needs: { hunger: { value: 1 } },
      currencies: { caps: 5 },
      development: { experience: 2 },
      attributes: { level: 1 },
      limbs: { arm: { missing: false, value: 5 } },
      creature: { raceId: "human" }
    }
  });
  const before = captureDocumentSnapshot(actor);
  actor._source.system.resources.health.value = 7;
  actor._source.system.resources.actionPoints.value = 3;
  actor._source.system.needs.hunger.value = 2;
  actor._source.system.currencies.caps = 7;
  actor._source.system.development.experience = 3;
  actor._source.system.attributes.level = 2;
  actor._source.system.limbs.arm.missing = true;
  actor._source.system.creature.raceId = "ghoul";

  const events = classifyActorUpdate(actor, {
    "system.resources.health.value": 7,
    system: {
      resources: { actionPoints: { value: 3 } },
      needs: { hunger: { value: 2 } },
      currencies: { caps: 7 },
      development: { experience: 3 },
      attributes: { level: 2 },
      limbs: { arm: { missing: true } },
      creature: { raceId: "ghoul" }
    }
  }, { before, after: captureDocumentSnapshot(actor) });

  assert.deepEqual(eventKeys(events), [
    "fallout-maw.actor.health.changed",
    "fallout-maw.actor.resource.changed",
    "fallout-maw.actor.need.changed",
    "fallout-maw.actor.currency.changed",
    "fallout-maw.actor.experience.changed",
    "fallout-maw.actor.level.changed",
    "fallout-maw.actor.limb.changed",
    "fallout-maw.actor.limb.destroyed"
  ]);
  assert.deepEqual(events[0].data.changedPaths, ["system.resources.health.value"]);
  assert.equal(events.some(event => event.data.changedPaths.includes("system.creature.raceId")), false);
  assert.equal(events[0].before["system.resources.health.value"], 9);
  assert.equal(events[0].after["system.resources.health.value"], 7);
  assert.equal(events[0].delta["system.resources.health.value"], 7);
  assert.equal(events.every(event => event.target.actorUuid === actor.uuid), true);
});

test("flattened and expanded Foundry changes produce the same canonical paths", () => {
  assert.deepEqual(flattenDocumentChanges({
    "system.resources.health.value": 4,
    system: { currencies: { caps: 10 }, traits: { "-=old": null } },
    _id: "ignored"
  }), {
    "system.resources.health.value": 4,
    "system.currencies.caps": 10,
    "system.traits.old": null
  });
});

test("Item classifiers cover ability, trauma, disease and non-overlapping inventory transitions", () => {
  const actor = createActor();
  assert.deepEqual(eventKeys(classifyItemCreate(createItem(actor, "ability"))), ["fallout-maw.ability.acquired"]);
  assert.deepEqual(eventKeys(classifyItemDelete(createItem(actor, "ability"))), ["fallout-maw.ability.removed"]);
  assert.deepEqual(eventKeys(classifyItemCreate(createItem(actor, "trauma"))), ["fallout-maw.actor.trauma.acquired"]);
  assert.deepEqual(eventKeys(classifyItemDelete(createItem(actor, "trauma"))), ["fallout-maw.actor.trauma.recovered"]);
  assert.deepEqual(eventKeys(classifyItemCreate(createItem(actor, "disease"))), ["fallout-maw.actor.disease.acquired"]);
  assert.deepEqual(eventKeys(classifyItemDelete(createItem(actor, "disease"))), ["fallout-maw.actor.disease.recovered"]);

  const ability = createItem(actor, "ability", {
    flags: { "fallout-maw": { abilityFixedFunctionState: { toggle: { active: true } } } }
  });
  assert.deepEqual(eventKeys(classifyItemUpdate(ability, {
    "flags.fallout-maw.abilityFixedFunctionState.toggle.active": true
  }, {
    before: { flags: { "fallout-maw": { abilityFixedFunctionState: { toggle: { active: false } } } } },
    after: ability._source
  })), ["fallout-maw.ability.toggle.changed"]);

  const disease = createItem(actor, "disease", { system: { stageId: "one", level: 1, healingProgress: 0 } });
  disease._source.system.stageId = "two";
  disease._source.system.level = 2;
  assert.deepEqual(eventKeys(classifyItemUpdate(disease, {
    "system.stageId": "two",
    "system.level": 2,
    "system.healingProgress": 1
  }, { before: { system: { stageId: "one", level: 1, healingProgress: 0 } }, after: disease._source })), [
    "fallout-maw.actor.disease.stageChanged"
  ]);

  const gear = createItem(actor, "gear", {
    system: { quantity: 1, equipped: false, placement: { mode: "inventory" }, customState: 0 }
  });
  const before = captureDocumentSnapshot(gear);
  gear._source.system.quantity = 2;
  gear._source.system.equipped = true;
  gear._source.system.placement.mode = "equipment";
  gear._source.system.customState = 1;
  const events = classifyItemUpdate(gear, {
    system: {
      quantity: 2,
      equipped: true,
      placement: { mode: "equipment" },
      customState: 1
    }
  }, { before, after: captureDocumentSnapshot(gear) });
  assert.deepEqual(eventKeys(events), [
    "fallout-maw.inventory.item.quantityChanged",
    "fallout-maw.inventory.item.placementChanged",
    "fallout-maw.inventory.item.equipped"
  ]);
  const claimedPaths = events.flatMap(event => event.data.changedPaths);
  assert.equal(claimedPaths.filter(path => path === "system.quantity").length, 1);
  assert.equal(claimedPaths.includes("system.customState"), false);
  assert.deepEqual(eventKeys(classifyItemCreate(createItem(null, "gear"))), []);
});

test("ActiveEffect classifier mirrors status transitions but ignores managed Event Reaction effects", () => {
  const actor = createActor();
  const effect = {
    id: "effect-1",
    uuid: `${actor.uuid}.ActiveEffect.effect-1`,
    documentName: "ActiveEffect",
    parent: actor,
    statuses: new Set(["stunned"]),
    origin: `${actor.uuid}.Item.item-1`,
    _source: { statuses: ["stunned"], disabled: false, origin: `${actor.uuid}.Item.item-1` },
    toObject() { return structuredClone(this._source); }
  };
  assert.deepEqual(eventKeys(classifyActiveEffectCreate(effect)), [
    "fallout-maw.actor.effect.applied",
    "fallout-maw.actor.status.gained"
  ]);
  assert.deepEqual(classifyActiveEffectCreate(effect, { falloutMawEventReactionEffect: true }), []);

  const before = captureDocumentSnapshot(effect);
  effect.statuses = new Set(["dead"]);
  effect._source.statuses = ["dead"];
  const events = classifyActiveEffectUpdate(effect, { statuses: ["dead"] }, {
    before,
    after: captureDocumentSnapshot(effect)
  });
  assert.deepEqual(eventKeys(events), [
    "fallout-maw.actor.effect.changed",
    "fallout-maw.actor.status.gained",
    "fallout-maw.actor.status.lost"
  ]);
  assert.equal(events[1].data.statusId, "dead");
  assert.equal(events[2].data.statusId, "stunned");
  assert.deepEqual(eventKeys(classifyActiveEffectDelete(effect)), [
    "fallout-maw.actor.effect.removed",
    "fallout-maw.actor.status.lost"
  ]);
});

test("Combat classifiers emit lifecycle, turn, round, initiative and defeat transitions", () => {
  const oldParticipant = { actorUuid: "Actor.old", tokenUuid: "Scene.s.Token.old" };
  const nextActor = createActor();
  nextActor.uuid = "Actor.next";
  const combat = {
    id: "combat-1",
    uuid: "Combat.combat-1",
    documentName: "Combat",
    started: true,
    round: 2,
    turn: 0,
    combatant: { actor: nextActor, tokenUuid: "next" },
    _source: { round: 2, turn: 0 },
    toObject() { return structuredClone(this._source); }
  };
  const before = {
    source: { round: 1, turn: 3 },
    meta: { started: true, currentCombatant: oldParticipant }
  };
  const after = captureDocumentSnapshot(combat);
  const events = classifyCombatUpdate(combat, { round: 2, turn: 0 }, { before, after });
  assert.deepEqual(eventKeys(events), [
    "fallout-maw.combat.turn.ended",
    "fallout-maw.combat.round.changed",
    "fallout-maw.combat.turn.started"
  ]);
  assert.equal(events[0].target.actorUuid, "Actor.old");
  assert.equal(events[2].target.actorUuid, "Actor.next");
  assert.deepEqual(eventKeys(classifyCombatDelete(combat)), ["fallout-maw.combat.ended"]);

  const combatant = {
    id: "c1",
    uuid: "Combat.combat-1.Combatant.c1",
    documentName: "Combatant",
    combat,
    parent: combat,
    actor: nextActor,
    tokenUuid: "next",
    _source: { initiative: 12, defeated: true },
    toObject() { return structuredClone(this._source); }
  };
  assert.deepEqual(eventKeys(classifyCombatantUpdate(combatant, { initiative: 12, defeated: true }, {
    before: { initiative: null, defeated: false },
    after: combatant._source
  })), [
    "fallout-maw.combat.initiative.rolled",
    "fallout-maw.combat.combatant.defeated"
  ]);
});

test("Foundry hook adapter captures pre-state and dispatches post-commit only on active GM", async () => {
  const callbacks = new Map();
  let hookId = 0;
  const hooks = {
    on(name, callback) {
      callbacks.set(name, callback);
      hookId += 1;
      return hookId;
    }
  };
  const calls = [];
  const roots = [];
  let active = true;
  const registrations = registerFoundryDocumentSystemEventHooks({
    hooks,
    isActiveGM: () => active,
    randomId: () => "operation-1",
    withRoot: async (meta, operation) => {
      roots.push(meta);
      return operation({ emit: async (...args) => calls.push(args) });
    }
  });
  assert.ok(registrations.length >= 20);

  const actor = createActor({ system: { resources: { health: { value: 10 } } } });
  const options = { falloutMawSystemEventChainRef: { version: 1, rootId: "root-1" } };
  callbacks.get("preUpdateActor")(actor, { "system.resources.health.value": 8 }, options, "player-1");
  actor._source.system.resources.health.value = 8;
  callbacks.get("updateActor")(actor, { "system.resources.health.value": 8 }, options, "player-1");
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(calls.length, 1);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].operationId, "document:operation-1");
  assert.deepEqual(roots[0].chainRef, options.falloutMawSystemEventChainRef);
  const [key, payload, dispatchOptions] = calls[0];
  assert.equal(key, "fallout-maw.actor.health.changed");
  assert.equal(payload.actorUuid, actor.uuid);
  assert.match(dispatchOptions.occurrenceKey, /^operation-1:actor\.health\.changed:/u);
  assert.equal(dispatchOptions.participants.target.actorUuid, actor.uuid);
  assert.equal(dispatchOptions.before["system.resources.health.value"], 10);
  assert.equal(dispatchOptions.after["system.resources.health.value"], 8);
  assert.equal(dispatchOptions.delta["system.resources.health.value"], 8);

  active = false;
  callbacks.get("updateActor")(actor, { "system.resources.health.value": 7 }, {}, "player-1");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
});

test("one committed document operation emits every descriptor inside one event root", async () => {
  const callbacks = new Map();
  const hooks = { on(name, callback) { callbacks.set(name, callback); return callbacks.size; } };
  const roots = [];
  const calls = [];
  registerFoundryDocumentSystemEventHooks({
    hooks,
    isActiveGM: () => true,
    randomId: () => "operation-many",
    withRoot: async (meta, operation) => {
      roots.push(meta);
      return operation({ emit: async (...args) => calls.push(args) });
    }
  });

  const actor = createActor({
    system: { resources: { health: { value: 10 }, actionPoints: { value: 4 } } }
  });
  const options = {};
  callbacks.get("preUpdateActor")(actor, {}, options);
  actor._source.system.resources.health.value = 8;
  actor._source.system.resources.actionPoints.value = 3;
  callbacks.get("updateActor")(actor, {
    "system.resources.health.value": 8,
    "system.resources.actionPoints.value": 3
  }, options, "player-1");
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(roots.length, 1);
  assert.deepEqual(calls.map(call => call[0]), [
    "fallout-maw.actor.health.changed",
    "fallout-maw.actor.resource.changed"
  ]);
});
