import assert from "node:assert/strict";
import test from "node:test";

installFoundryGlobals();

const {
  registerCombatDodgeHooks,
  registerCombatDodgeSocket,
  spendActorDodgeForAreaDamage
} = await import("../src/combat/dodge-resource.mjs");

test("player dodge spending is acknowledged by Foundry's active-GM query", async () => {
  const actor = createDodgeActor();
  const runtime = createRuntime(actor);
  const queries = [];
  runtime.gm.query = async (name, payload, options) => {
    queries.push({ name, payload, options });
    const previousUser = game.user;
    game.user = runtime.gm;
    try {
      return await CONFIG.queries[name](payload, { user: runtime.player, ...options });
    } finally {
      game.user = previousUser;
    }
  };

  registerCombatDodgeHooks();
  registerCombatDodgeSocket();
  await spendActorDodgeForAreaDamage(actor);

  assert.equal(actor.system.resources.dodge.value, 9);
  assert.equal(actor.updates.length, 1);
  assert.equal(queries.length, 1);
  assert.match(queries[0].name, /^fallout-maw\./u);
  assert.equal(queries[0].payload.action, "spendDodgeResource");
  assert.equal(queries[0].payload.actorUuid, actor.uuid);
  assert.equal(queries[0].options.timeout, 2000);
  assert.equal(runtime.socketRegistrations.length, 0);
});

test("active-GM dodge query always settles false for no-op and invalid requests", async () => {
  const actor = createDodgeActor();
  const runtime = createRuntime(actor);
  game.user = runtime.gm;
  registerCombatDodgeHooks();
  const [queryName, handler] = Object.entries(CONFIG.queries)
    .find(([name]) => name.endsWith(".dodgeResourceMutation"));

  assert.match(queryName, /^fallout-maw\./u);
  const context = { user: runtime.player, timeout: 2000 };
  const noOp = await handler({
    action: "spendDodgeResource",
    actorUuid: actor.uuid,
    value: actor.system.resources.dodge.value
  }, context);
  const unknownAction = await handler({
    action: "notADodgeMutation",
    actorUuid: actor.uuid,
    value: 0
  }, context);
  const missingActorUuid = await handler({
    action: "spendDodgeResource",
    actorUuid: "",
    value: 0
  }, context);
  const reversedSpend = await handler({
    action: "spendDodgeResource",
    actorUuid: actor.uuid,
    value: actor.system.resources.dodge.value + 1
  }, context);
  const playerRestore = await handler({
    action: "restoreDodgeResource",
    actorUuid: actor.uuid,
    value: actor.system.resources.dodge.value + 1
  }, context);
  const unauthorizedSpend = await handler({
    action: "spendDodgeResource",
    actorUuid: actor.uuid,
    value: actor.system.resources.dodge.value - 1
  }, {
    user: { ...runtime.player, id: "other-player" },
    timeout: 2000
  });

  const originalFromUuid = globalThis.fromUuid;
  const originalConsoleError = console.error;
  globalThis.fromUuid = async () => {
    throw new Error("stale synthetic Actor UUID");
  };
  console.error = () => undefined;
  let rejectedActor;
  try {
    rejectedActor = await handler({
      action: "spendDodgeResource",
      actorUuid: "Scene.stale.Token.missing.Actor.missing",
      value: 0
    }, context);
  } finally {
    globalThis.fromUuid = originalFromUuid;
    console.error = originalConsoleError;
  }

  assert.equal(noOp, false);
  assert.equal(unknownAction, false);
  assert.equal(missingActorUuid, false);
  assert.equal(reversedSpend, false);
  assert.equal(playerRestore, false);
  assert.equal(unauthorizedSpend, false);
  assert.equal(rejectedActor, false);
  assert.equal(actor.updates.length, 0);
});

test("a timed-out dodge query releases the actor queue without a 30-second wait", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const actor = createDodgeActor();
  const runtime = createRuntime(actor);
  const queryTimeouts = [];
  runtime.gm.query = (_name, _payload, options) => {
    queryTimeouts.push(options.timeout);
    return new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error("User query timed out")), options.timeout);
    });
  };

  registerCombatDodgeHooks();
  const originalConsoleWarn = console.warn;
  console.warn = () => undefined;
  try {
    const firstSpend = spendActorDodgeForAreaDamage(actor);
    await waitForMicrotasks(() => queryTimeouts.length === 1);
    context.mock.timers.tick(queryTimeouts[0]);
    assert.equal(await firstSpend, undefined);

    const secondSpend = spendActorDodgeForAreaDamage(actor);
    await waitForMicrotasks(() => queryTimeouts.length === 2);
    context.mock.timers.tick(queryTimeouts[1]);
    assert.equal(await secondSpend, undefined);
  } finally {
    console.warn = originalConsoleWarn;
  }

  assert.deepEqual(queryTimeouts, [2000, 2000]);
  assert.ok(queryTimeouts.every(timeout => timeout < 30000));
  assert.equal(actor.updates.length, 0);
});

function createDodgeActor() {
  return {
    uuid: "Actor.DodgeAuthority",
    items: { contents: [] },
    effects: [],
    updates: [],
    system: { resources: { dodge: { value: 10, max: 10 } } },
    testUserPermission(user, level) {
      return user?.id === "player" && level === "OWNER";
    },
    get isOwner() {
      return Boolean(globalThis.game?.user?.isActiveGM);
    },
    async update(changes) {
      this.updates.push(changes);
      if (changes["system.resources.dodge.value"] !== undefined) {
        this.system.resources.dodge.value = changes["system.resources.dodge.value"];
      }
    }
  };
}

function createRuntime(actor) {
  globalThis.CONFIG = {
    queries: {},
    specialStatusEffects: {},
    Token: { movement: null }
  };
  const player = {
    id: "player",
    active: true,
    isGM: false,
    isActiveGM: false,
    hasPermission: permission => permission === "QUERY_USER"
  };
  const gm = {
    id: "gm",
    active: true,
    isGM: true,
    isActiveGM: true,
    query: async () => false
  };
  const combat = {
    started: true,
    combatants: [{ actor }],
    getCombatantsByActor(candidate) {
      return candidate?.uuid === actor.uuid ? this.combatants : [];
    }
  };
  const socketRegistrations = [];
  globalThis.game = {
    user: player,
    users: {
      activeGM: gm,
      find: predicate => [gm, player].find(predicate)
    },
    combat,
    combats: [combat],
    settings: {
      get() {
        return {
          dodge: {
            enabled: true,
            attackCostPercent: 10,
            areaDamageMultiplier: 1,
            burstMultiplier: 1,
            volleyMultiplier: 1
          }
        };
      }
    },
    socket: {
      on(...args) {
        socketRegistrations.push(args);
      }
    }
  };
  globalThis.fromUuid = async uuid => uuid === actor.uuid ? actor : null;
  return { player, gm, combat, socketRegistrations };
}

async function waitForMicrotasks(predicate, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail("Expected asynchronous dodge query was not reached");
}

function installFoundryGlobals() {
  globalThis.foundry = {
    applications: {
      api: { DialogV2: {} },
      ux: { FormDataExtended: class FormDataExtended {} },
      handlebars: { renderTemplate: async () => "" }
    },
    utils: {
      deepClone: value => structuredClone(value),
      randomID: () => "test-id",
      mergeObject: (target, source, { inplace = false } = {}) => {
        const result = inplace ? target : structuredClone(target ?? {});
        return mergePlainObjects(result, source ?? {});
      }
    }
  };
}

function mergePlainObjects(target, source) {
  for (const [key, value] of Object.entries(source ?? {})) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const child = target[key] && typeof target[key] === "object" && !Array.isArray(target[key])
        ? target[key]
        : {};
      target[key] = child;
      mergePlainObjects(child, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}
