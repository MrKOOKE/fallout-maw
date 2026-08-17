import assert from "node:assert/strict";
import test from "node:test";

const callbacks = new Map();
globalThis.Hooks = {
  on(name, callback) {
    const entries = callbacks.get(name) ?? [];
    entries.push(callback);
    callbacks.set(name, entries);
    return callback;
  }
};

globalThis.foundry = {
  applications: {
    api: { DialogV2: class {} },
    ux: { FormDataExtended: class {} }
  },
  utils: {
    deepClone: value => structuredClone(value),
    fromUuid: uuid => globalThis.fromUuid(uuid),
    randomID: () => "random"
  }
};

function createActor(id, relevant = false, { isToken = false, flags = {} } = {}) {
  return {
    id,
    uuid: isToken ? `Scene.scene.Token.${id}.Actor.${id}` : `Actor.${id}`,
    documentName: "Actor",
    isToken,
    relevant,
    flags,
    getFlag(scope, key) {
      return this.flags?.[scope]?.[key];
    }
  };
}

function passenger(actor, id) {
  return {
    id,
    actorUuid: actor.uuid,
    actorName: actor.id,
    slotId: "seat",
    slotIndex: 0
  };
}

const directoryOnlyActor = createActor("directory-only", true);
const tokenActor = createActor("token", true);
const syntheticActor = createActor("synthetic", true, { isToken: true });
const nestedPassenger = createActor("nested", true);
const passengerActor = createActor("passenger", true, {
  flags: {
    "fallout-maw": {
      actorContainer: { passengers: [passenger(nestedPassenger, "nested-seat")] }
    }
  }
});
const containerActor = createActor("container", false, {
  flags: {
    "fallout-maw": {
      actorContainer: { passengers: [passenger(passengerActor, "passenger-seat")] }
    }
  }
});
const travelUnitActor = createActor("travel-unit", true);
const carrierActor = createActor("carrier", false, {
  flags: {
    "fallout-maw": {
      travelGroup: {
        groupId: "group",
        units: [{ id: "unit", actorUuid: travelUnitActor.uuid }]
      }
    }
  }
});

const actorById = new Map([
  directoryOnlyActor,
  tokenActor,
  passengerActor,
  nestedPassenger,
  containerActor,
  travelUnitActor,
  carrierActor
].map(actor => [actor.id, actor]));
const actorByUuid = new Map(Array.from(actorById.values(), actor => [actor.uuid, actor]));
globalThis.fromUuid = async uuid => actorByUuid.get(uuid) ?? null;

globalThis.game = {
  actors: {
    contents: Array.from(actorById.values()),
    get: id => actorById.get(id) ?? null
  }
};
const activeSceneTokens = [
  { actor: tokenActor },
  { actor: syntheticActor },
  { actor: containerActor },
  { actor: carrierActor }
];
globalThis.canvas = {
  scene: { id: "scene", tokens: { contents: activeSceneTokens } },
  tokens: { placeables: activeSceneTokens }
};

const { registerWorldTimeActorCandidateIndex } = await import(
  "../src/time/world-time-actor-index.mjs"
);

test("world-time Actor candidates are limited to the active Scene and its recursive proxy Actors", async () => {
  let predicateCalls = 0;
  const index = registerWorldTimeActorCandidateIndex(actor => {
    predicateCalls += 1;
    return actor.relevant;
  });

  assert.deepEqual(
    Array.from(await index.values(), actor => actor.uuid),
    [
      tokenActor.uuid,
      syntheticActor.uuid,
      passengerActor.uuid,
      travelUnitActor.uuid,
      nestedPassenger.uuid
    ]
  );
  assert.equal(predicateCalls, 7, "only four token Actors plus their three represented Actors are tested");

  Array.from(await index.values());
  assert.equal(predicateCalls, 7, "reading candidates reuses the active-Scene scope cache");

  callbacks.get("updateToken")[0](activeSceneTokens[0], { x: 120, y: 240 });
  Array.from(await index.values());
  assert.equal(predicateCalls, 7, "ordinary Token movement neither invalidates scope nor predicates");

  directoryOnlyActor.relevant = true;
  callbacks.get("updateActor")[0](directoryOnlyActor, { system: { health: { value: 1 } } });
  assert.equal(predicateCalls, 7, "a directory-only Actor is ignored even when it changes");

  tokenActor.relevant = false;
  callbacks.get("updateItem")[0]({ parent: tokenActor });
  assert.ok(!Array.from(await index.values()).includes(tokenActor));
  assert.equal(predicateCalls, 8, "document changes stay lazy until world-time candidates are requested");

  containerActor.flags["fallout-maw"].actorContainer.passengers = [];
  callbacks.get("updateActor")[0](containerActor, {
    flags: { "fallout-maw": { actorContainer: { passengers: [] } } }
  });
  assert.deepEqual(
    Array.from(await index.values(), actor => actor.uuid),
    [syntheticActor.uuid, travelUnitActor.uuid]
  );

  canvas.scene.tokens.contents = [];
  canvas.tokens.placeables = [];
  callbacks.get("canvasReady")[0]();
  assert.deepEqual(Array.from(await index.values()), []);
});
