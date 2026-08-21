import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

globalThis.foundry = {
  applications: {
    api: { DialogV2: {} },
    ux: { FormDataExtended: class FormDataExtended {} },
    handlebars: { renderTemplate: async () => "" }
  },
  utils: {
    deepClone: value => structuredClone(value),
    mergeObject: (target, source) => ({ ...target, ...source }),
    randomID: () => "test-id"
  }
};
globalThis.CONFIG = {
  specialStatusEffects: { INVISIBLE: "invisible", DEFEATED: "defeated" },
  Token: { movement: null }
};
globalThis.Hooks = { on: () => undefined };

const {
  collectStealthMovementInterruptions,
  commitStealthMovementCollection,
  evaluateAutoDetectionMovementThreshold,
  getMovementWaypointKey,
  getOriginalMovementWaypoints,
  normalizeMovementStateFlag,
  STEALTH_MOVEMENT_STATE_FLAG
} = await import("../src/stealth/movement.mjs");
const {
  configureStealthRuleSettingsProvider,
  invalidateStealthRuleCache
} = await import("../src/stealth/rules.mjs");

const SETTINGS = Object.freeze({
  autoDetection: Object.freeze({ enabled: true, movementThresholdFormula: "100" }),
  detection: Object.freeze({ skillKey: "naturalist", rangeFormula: "2" }),
  attenuationLevels: Object.freeze([{ threshold: 0, penaltyPercent: 0 }]),
  difficultyLevels: Object.freeze([{ threshold: 0, difficultyBonus: 0 }])
});

afterEach(() => {
  configureStealthRuleSettingsProvider();
  invalidateStealthRuleCache();
  delete globalThis.canvas;
});

test("movement accumulation threshold applies the actor percent after the configured base", () => {
  const actor = createActor("Actor.soft-step");
  actor.system.stealth = { movementThresholdPercent: 50 };
  assert.equal(evaluateAutoDetectionMovementThreshold(actor, {
    autoDetection: { movementThresholdFormula: "4" }
  }), 6);
});

test("one route sample aggregates simultaneous observer checks without mutating persistent state", () => {
  configureStealthRuleSettingsProvider(() => SETTINGS);
  const hiddenActor = createActor("Actor.hidden", { hidden: true });
  const observerActorA = createActor("Actor.observer-a");
  const observerActorB = createActor("Actor.observer-b");
  const hidden = createToken("hidden", hiddenActor, { x: 0, y: 0 });
  const observerA = createToken("observer-a", observerActorA, { x: 100, y: 0 });
  const observerB = createToken("observer-b", observerActorB, { x: 100, y: 0 });
  const scene = { id: "scene", uuid: "Scene.scene", grid: { size: 100, distance: 5 } };
  hidden.document.parent = scene;
  observerA.document.parent = scene;
  observerB.document.parent = scene;
  globalThis.canvas = {
    ready: true,
    scene,
    grid: { isGridless: true, size: 100, distance: 5 },
    tokens: {
      placeables: [hidden, observerA, observerB],
      get: id => [hidden, observerA, observerB].find(token => token.id === id)
    },
    environment: { darknessLevel: 0, globalLightSource: { active: false } },
    effects: {
      lightSources: new Map(),
      getDarknessLevel: () => 0,
      testInsideDarkness: () => false
    }
  };

  const destination = movementWaypoint({ x: 100, y: 0 });
  const collection = collectStealthMovementInterruptions({
    tokenDocument: hidden.document,
    movement: {
      id: "movement",
      origin: movementWaypoint({ x: 0, y: 0 }),
      destination,
      passed: { waypoints: [destination] },
      pending: { waypoints: [] }
    },
    options: {}
  });

  assert.equal(collection.events.length, 1);
  assert.equal(collection.events[0].checks.length, 2);
  assert.deepEqual(new Set(collection.events[0].checks.map(check => check.observerTokenUuid)), new Set([
    observerA.document.uuid,
    observerB.document.uuid
  ]));
  assert.equal(collection.stateUpdates.size, 2);
  assert.equal(hidden.document.updates.length, 0);
});

test("resumed routes preserve Foundry pending checkpoints, loops and fractional elevations", () => {
  const first = movementWaypoint({ x: 100, elevation: 1.25 });
  const loop = movementWaypoint({ x: 0, elevation: 1.375 });
  const second = movementWaypoint({ x: 200, elevation: 1.5 });
  assert.deepEqual(getOriginalMovementWaypoints({
    destination: first,
    passed: { waypoints: [first, loop] },
    pending: { waypoints: [second, loop] }
  }), [first, loop, second, loop]);
  assert.notEqual(getMovementWaypointKey(first), getMovementWaypointKey({ ...first, elevation: 1.4 }));
});

test("another interruption persists only the physically reached stealth-state prefix", async () => {
  const first = movementWaypoint({ x: 100 });
  const second = movementWaypoint({ x: 200 });
  const routeKey = "scene:hidden:route-observer";
  const hidden = createToken("hidden-prefix", createActor("Actor.hidden-prefix", { hidden: true }), { x: 0, y: 0 });
  const observer = createToken("observer-prefix", createActor("Actor.observer-prefix"), { x: 100, y: 0 });
  await commitStealthMovementCollection({
    tokenDocument: hidden.document,
    collection: {
      stateUpdates: new Map([[routeKey, 9]]),
      stateBaselines: new Map([[routeKey, {
        revision: 4,
        value: 0,
        pair: { hiddenToken: hidden, observerToken: observer }
      }]]),
      stateTransitions: [
        { routeOrder: 1, waypointKey: getMovementWaypointKey(first), key: routeKey, value: 2 },
        { routeOrder: 2, waypointKey: getMovementWaypointKey(second), key: routeKey, value: 9 }
      ]
    },
    selectedEvent: { providerId: "traps", routeOrder: 1, waypoint: first }
  });

  assert.equal(hidden.document.updates.length, 1);
  assert.ok(Object.keys(hidden.document.updates[0]).some(path => path.includes(".entries.k_")));
  assert.equal(hidden.document.updates[0][`flags.fallout-maw.${STEALTH_MOVEMENT_STATE_FLAG}`], undefined);
  const flag = normalizeMovementStateFlag(hidden.document.flags["fallout-maw"][STEALTH_MOVEMENT_STATE_FLAG]);
  assert.equal(flag.entries.length, 1);
  assert.equal(flag.entries[0].key, routeKey);
  assert.equal(flag.entries[0].value, 2);
  assert.equal(flag.entries[0].revision, 5);
});

test("a different moving token reads the authoritative pair state from its counterpart", () => {
  configureStealthRuleSettingsProvider(() => ({
    ...SETTINGS,
    detection: { skillKey: "naturalist", rangeFormula: "20" }
  }));
  const hidden = createToken("hidden-shared", createActor("Actor.hidden-shared", { hidden: true }), { x: 0, y: 0 });
  const observer = createToken("observer-shared", createActor("Actor.observer-shared"), { x: 0, y: 0 });
  const scene = { id: "scene", uuid: "Scene.scene", grid: { size: 100, distance: 5 } };
  hidden.document.parent = scene;
  observer.document.parent = scene;
  const key = "scene:hidden-shared:observer-shared:stealth-session";
  hidden.document.flags = {
    "fallout-maw": {
      [STEALTH_MOVEMENT_STATE_FLAG]: {
        version: 1,
        entries: [{
          key,
          value: 4,
          revision: 3,
          writerTokenUuid: hidden.document.uuid
        }]
      }
    }
  };
  globalThis.canvas = {
    ready: true,
    scene,
    grid: { isGridless: true, size: 100, distance: 5 },
    tokens: { placeables: [hidden, observer] },
    environment: { darknessLevel: 0, globalLightSource: { active: false } },
    effects: {
      lightSources: new Map(),
      getDarknessLevel: () => 0,
      testInsideDarkness: () => false
    }
  };

  const destination = movementWaypoint({ x: 10 });
  const collection = collectStealthMovementInterruptions({
    tokenDocument: observer.document,
    movement: {
      id: "observer-movement",
      origin: movementWaypoint({ x: 0 }),
      destination,
      passed: { waypoints: [destination] },
      pending: { waypoints: [] }
    }
  });

  assert.equal(collection.stateBaselines.get(key).revision, 3);
  assert.ok(collection.stateUpdates.get(key) > 4);
});

test("concurrent monotonic pair-state increments are causally merged", () => {
  configureStealthRuleSettingsProvider(() => ({
    ...SETTINGS,
    detection: { skillKey: "naturalist", rangeFormula: "20" }
  }));
  const hidden = createToken("hidden-race", createActor("Actor.hidden-race", { hidden: true }), { x: 0, y: 0 });
  const observer = createToken("observer-race", createActor("Actor.observer-race"), { x: 0, y: 0 });
  const scene = { id: "scene", uuid: "Scene.scene", grid: { size: 100, distance: 5 } };
  hidden.document.parent = scene;
  observer.document.parent = scene;
  const key = "scene:hidden-race:observer-race:stealth-session";
  const createSibling = (value, writerTokenUuid) => ({
    key,
    value,
    revision: 1,
    baseRevision: 0,
    baseValue: 0,
    writerTokenUuid
  });
  hidden.document.flags = {
    "fallout-maw": {
      [STEALTH_MOVEMENT_STATE_FLAG]: { version: 1, entries: [createSibling(3, hidden.document.uuid)] }
    }
  };
  observer.document.flags = {
    "fallout-maw": {
      [STEALTH_MOVEMENT_STATE_FLAG]: { version: 1, entries: [createSibling(4, observer.document.uuid)] }
    }
  };
  globalThis.canvas = {
    ready: true,
    scene,
    grid: { isGridless: true, size: 100, distance: 5 },
    tokens: { placeables: [hidden, observer] },
    environment: { darknessLevel: 0, globalLightSource: { active: false } },
    effects: {
      lightSources: new Map(),
      getDarknessLevel: () => 0,
      testInsideDarkness: () => false
    }
  };

  const destination = movementWaypoint({ x: 10 });
  const collection = collectStealthMovementInterruptions({
    tokenDocument: observer.document,
    movement: {
      id: "observer-race-movement",
      origin: movementWaypoint({ x: 0 }),
      destination,
      passed: { waypoints: [destination] },
      pending: { waypoints: [] }
    }
  });

  assert.equal(collection.stateBaselines.get(key).revision, 1);
  assert.equal(collection.stateBaselines.get(key).value, 7);
  assert.ok(collection.stateUpdates.get(key) > 7);
});

function createActor(uuid, { hidden = false } = {}) {
  return {
    uuid,
    statuses: new Set(hidden ? ["invisible"] : []),
    effects: hidden ? [{ id: "stealth-session", statuses: new Set(["invisible"]) }] : [],
    system: {
      skills: { naturalist: { value: 0 } },
      resources: {
        actionPoints: { max: 10 },
        movementPoints: { max: 10 }
      }
    },
    items: { contents: [] },
    getFlag: () => []
  };
}

function createToken(id, actor, { x, y }) {
  const document = {
    id,
    uuid: `Scene.scene.Token.${id}`,
    actor,
    object: null,
    x,
    y,
    elevation: 0,
    width: 1,
    height: 1,
    depth: 0,
    shape: 0,
    level: ""
  };
  document._source = {
    x,
    y,
    elevation: 0,
    width: 1,
    height: 1,
    depth: 0,
    shape: 0,
    level: "",
    flags: {}
  };
  document.flags = {};
  document.updates = [];
  document.getFlag = (scope, key) => document.flags?.[scope]?.[key];
  document.update = async data => {
    document.updates.push(data);
    for (const [path, value] of Object.entries(data)) setPropertyPath(document, path, value);
    return document;
  };
  const token = {
    id,
    uuid: document.uuid,
    actor,
    document,
    center: { x: x + 50, y: y + 50, elevation: 0 },
    hasSight: true,
    checkCollision: () => false
  };
  document.object = token;
  document.sight = { enabled: true, range: 0 };
  document.detectionModes = {
    basicSight: { enabled: true, range: 0 },
    lightPerception: { enabled: true, range: null }
  };
  return token;
}

function setPropertyPath(target, path, value) {
  const parts = path.split(".");
  let current = target;
  for (const part of parts.slice(0, -1)) current = current[part] ??= {};
  current[parts.at(-1)] = value;
}

function movementWaypoint(overrides = {}) {
  return {
    x: 0,
    y: 0,
    elevation: 0,
    width: 1,
    height: 1,
    depth: 0,
    shape: 0,
    level: "",
    action: "walk",
    ...overrides
  };
}
