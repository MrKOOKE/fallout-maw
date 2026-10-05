import assert from "node:assert/strict";
import test from "node:test";

function mergeObject(target, source, { inplace = true } = {}) {
  const result = inplace ? target : structuredClone(target);
  for (const [key, value] of Object.entries(source ?? {})) {
    result[key] = value && typeof value === "object" && !Array.isArray(value)
      ? mergeObject(result[key] ?? {}, value) : structuredClone(value);
  }
  return result;
}
globalThis.foundry = {
  applications: { api: { ApplicationV2: class {}, DialogV2: class {} },
    ux: { FormDataExtended: class {} }, handlebars: { HandlebarsApplicationMixin: Base => Base } },
  utils: { deepClone: structuredClone, mergeObject, randomID: () => "turn-test" }
};
const { prepareActorTurnStart, prepareActorTurnEnd, restoreActorReactionResource } = await import("../src/combat/reaction-resources.mjs");
const { initializeCombatDodgeResources } = await import("../src/combat/dodge-resource.mjs");
const { registerConstructRotationTurns } = await import("../src/constructs/rotation-actions.mjs");
registerConstructRotationTurns();
const { restoreCombatMovementResources } = await import("../src/combat/movement-resources.mjs");
const { cleanupDeletedCombatResources, initializeCreatedCombatantResources } = await import("../src/combat/resource-lifecycle.mjs");
const { getCombatantTurnActors, getCombatantResourceActors } = await import("../src/combat/crew-turns.mjs");
const { registerActorTurnStartPreparedHandler, registerActorTurnEndHandler } = await import("../src/combat/turn-events.mjs");
const { INVENTORY_RENDER_PARTS_OPTION } = await import("../src/inventory/constants.mjs");
const preparedActors = [];
const endedActors = [];
registerActorTurnStartPreparedHandler(({ actor }) => preparedActors.push(actor.uuid));
registerActorTurnEndHandler(({ actor }) => endedActors.push(actor.uuid));

function assignPath(object, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  for (const key of keys) object = object[key] ??= {};
  object[last] = structuredClone(value);
}

function fixture() {
  const makeActor = (id, type, resources) => ({ id, uuid: `Actor.${id}`, type, isOwner: true,
    flags: { "fallout-maw": {} }, system: { resources }, statuses: new Set(), effects: [],
    items: Object.assign([], { contents: [] }), updates: [],
    getFlag(scope, key) { return this.flags[scope]?.[key]; }, getActiveTokens: () => [],
    async update(changes, options = {}) {
      this.updates.push({ changes: structuredClone(changes), options });
      for (const [path, value] of Object.entries(changes)) assignPath(this, path, value);
    }
  });
  const resource = (max, spent = 0, once = 0) => ({ max, min: 0, value: max - spent, spent, once });
  const members = [makeActor("driver", "character", { actionPoints: resource(8, 5), movementPoints: resource(5, 3) }),
    makeActor("gunner", "character", { actionPoints: resource(8, 6), movementPoints: resource(5, 2) })];
  const actor = makeActor("tank", "construct", {
    movementPoints: resource(40, 12, 3), actionPoints: resource(0), power: resource(1000, 12)
  });
  actor.flags["fallout-maw"] = {
    constructVisual: { seats: members.map((_, i) => ({ id: `seat${i}`, role: i ? "gunner" : "driver", slotId: "seats", slotIndex: i })) },
    actorContainer: { passengers: members.map((member, i) => ({ id: `p${i}`, actorUuid: member.uuid, slotId: "seats", slotIndex: i })) },
    movementResourceSpending: [{ id: "old-move" }]
  };
  const combatant = { id: "tank-turn", actor, flags: { "fallout-maw": {} },
    getFlag(scope, key) { return this.flags[scope]?.[key]; } };
  const combat = { id: "combat", started: true, round: 2, turn: 0, combatants: [combatant], combatant,
    async updateEmbeddedDocuments(type, changes) {
      assert.equal(type, "Combatant");
      for (const row of changes) for (const [path, value] of Object.entries(row)) if (path !== "_id") assignPath(combatant, path, value);
    }
  };
  globalThis.game = { user: { isGM: true, isActiveGM: true }, combat, combats: [combat],
    settings: { get: () => undefined }, i18n: { localize: key => key } };
  globalThis.fromUuidSync = uuid => [actor, ...members].find(row => row.uuid === uuid);
  preparedActors.length = 0;
  endedActors.length = 0;
  return { actor, members, combatant, combat };
}

test("vehicle turn restores its movement pool and crew AP without regenerating power or adding a personal hull turn", async () => {
  const { actor, members, combatant, combat } = fixture();
  assert.deepEqual(getCombatantTurnActors(combatant), members);
  assert.deepEqual(getCombatantResourceActors(combatant), [actor, ...members]);
  await prepareActorTurnStart(actor, { combat });
  assert.equal(actor.system.resources.movementPoints.value, 40);
  assert.equal(actor.system.resources.movementPoints.spent, 0);
  assert.equal(actor.system.resources.movementPoints.once, 0);
  assert.equal(actor.system.resources.power.value, 988);
  assert.equal(actor.system.resources.actionPoints.value, 0);
  assert.deepEqual(actor.getFlag("fallout-maw", "movementResourceSpending"), []);
  assert.equal(actor.getFlag("fallout-maw", "constructRotationBudget").turnId, "combat:2:0");
  assert.deepEqual(members.map(member => member.system.resources.actionPoints.value), [8, 8]);
  assert.deepEqual(preparedActors, [actor, ...members].map(member => member.uuid));
  const restore = actor.updates.find(row => row.changes["system.resources.movementPoints.spent"] === 0);
  assert.deepEqual(restore.options[INVENTORY_RENDER_PARTS_OPTION], ["indicators"]);
});

test("a crew-controlled carrier follows the same start/end resource rules and handlers as an ordinary actor", async () => {
  const { actor, members, combat } = fixture();
  actor.system.resources.actionPoints = { max: 6, min: 0, value: 2, spent: 4, once: 2 };
  actor.system.resources.reactionPoints = { max: 4, min: 0, value: 3, spent: 1, once: 2 };
  actor.system.resources.dodge = { max: 100, min: 0, value: 10, spent: 90, once: 5 };
  actor.system.resources.health = { max: 100, min: 0, value: 50, spent: 50 };
  await prepareActorTurnStart(actor, { combat });
  assert.equal(actor.system.resources.actionPoints.value, 6);
  assert.equal(actor.system.resources.actionPoints.once, 0);
  assert.equal(actor.system.resources.reactionPoints.value, 0);
  assert.equal(actor.system.resources.reactionPoints.spent, 4);
  assert.equal(actor.system.resources.reactionPoints.once, 0);
  assert.equal(actor.system.resources.dodge.value, 30);
  assert.equal(actor.system.resources.dodge.once, 0);
  assert.equal(actor.system.resources.health.value, 50);
  assert.equal(actor.system.resources.power.value, 988);
  assert.deepEqual(preparedActors, [actor, ...members].map(row => row.uuid));
  await prepareActorTurnEnd(actor, { combat, conversionMode: "none" });
  assert.equal(actor.system.resources.actionPoints.value, 0);
  assert.equal(actor.system.resources.movementPoints.value, 0);
  assert.equal(actor.system.resources.reactionPoints.value, 4);
  assert.equal(actor.system.resources.reactionPoints.spent, 0);
  assert.deepEqual(endedActors, [...members, actor].map(row => row.uuid));
  actor.system.resources.reactionPoints.value = 1;
  actor.system.resources.reactionPoints.spent = 3;
  await restoreActorReactionResource(actor);
  assert.equal(actor.system.resources.reactionPoints.value, 4);
});

test("combat start restores the carrier's own dodge using the shared configured recovery", async () => {
  const { actor, combat } = fixture();
  actor.system.resources.dodge = { max: 100, min: 0, value: 10, spent: 90 };
  await initializeCombatDodgeResources(combat);
  assert.equal(actor.system.resources.dodge.value, 100);
  assert.equal(actor.system.resources.dodge.spent, 0);
});

test("combat initialization restores both carrier and crew, with exclusions covering a prepared carrier", async () => {
  const { actor, members, combat } = fixture();
  await restoreCombatMovementResources(combat, { includeSceneTokenActors: false, excludeActorUuids: [actor.uuid] });
  assert.equal(actor.system.resources.movementPoints.value, 28);
  assert.deepEqual(members.map(member => member.system.resources.actionPoints.value), [8, 8]);
  await restoreCombatMovementResources(combat, { includeSceneTokenActors: false });
  assert.equal(actor.system.resources.movementPoints.value, 40);
  assert.equal(actor.system.resources.power.value, 988);
});

test("adding a vehicle during combat initializes its own movement bank as well as its crew", async () => {
  const { actor, members, combatant, combat } = fixture();
  combat.combatant = null;
  const result = await initializeCreatedCombatantResources([combatant], combat);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.initializedActorUuids, [actor, ...members].map(row => row.uuid));
  assert.equal(actor.system.resources.movementPoints.value, 40);
  assert.equal(actor.system.resources.power.value, 988);
});

test("deleted combat restores carrier movement, but a surviving combat protects carrier and crew", async () => {
  const { actor, members, combat } = fixture();
  const stillParticipating = await cleanupDeletedCombatResources(combat);
  assert.deepEqual(stillParticipating.skippedActorUuids, [actor, ...members].map(row => row.uuid));
  assert.equal(actor.system.resources.movementPoints.value, 28);
  game.combats = [];
  const result = await cleanupDeletedCombatResources(combat);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.cleanedActorUuids, [actor, ...members].map(row => row.uuid));
  assert.equal(actor.system.resources.movementPoints.value, 40);
  assert.equal(actor.system.resources.power.value, 988);
});
