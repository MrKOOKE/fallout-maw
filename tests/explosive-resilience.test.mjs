import assert from "node:assert/strict";
import test from "node:test";

globalThis.foundry = {
  applications: {
    api: { DialogV2: class DialogV2 {} },
    ux: { FormDataExtended: class FormDataExtended {} },
    handlebars: { renderTemplate: async () => "" }
  },
  utils: {
    deepClone: value => structuredClone(value),
    randomID: () => "generated-id"
  }
};
globalThis.game = {
  user: { id: "gm", isGM: true },
  users: { activeGM: { id: "gm", isSelf: true } },
  time: { worldTime: 100 }
};

const { SYSTEM_ID } = await import("../src/constants.mjs");
const {
  ABILITY_FIXED_FUNCTION_KEYS,
  ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY
} = await import("../src/settings/abilities.mjs");
const {
  activateExplosiveResilience,
  buildExplosiveResilienceEffectChanges,
  getExplosiveResilienceProgressEntry,
  observeExplosiveResilienceDamage
} = await import("../src/abilities/explosive-resilience.mjs");

test("explosive resilience fills from pre-Resistance damage without opening a reaction", async () => {
  const actor = createActor();
  globalThis.fromUuid = async uuid => uuid === actor.uuid ? actor : null;

  const first = await observeExplosiveResilienceDamage({
    event: damageEvent(actor, {
      incoming: 500,
      beforeResistance: 199,
      preBarrierAmount: 3,
      healthLoss: 0
    })
  });
  assert.deepEqual(first, [{ progress: 199, ready: false }]);
  assert.deepEqual(progress(actor), { current: 199, required: 200 });

  const second = await observeExplosiveResilienceDamage({
    event: damageEvent(actor, {
      incoming: 500,
      beforeResistance: 1,
      preBarrierAmount: 0,
      healthLoss: 0
    })
  });
  assert.deepEqual(second, [{ progress: 200, ready: true }]);
  assert.deepEqual(progress(actor), { current: 200, required: 200 });

  const writesAtMaximum = actor.items[0].setFlagCalls;
  const capped = await observeExplosiveResilienceDamage({
    event: damageEvent(actor, { incoming: 100 })
  });
  assert.deepEqual(capped, [{ progress: 200, ready: true }]);
  assert.equal(actor.items[0].setFlagCalls, writesAtMaximum, "a full gauge causes no redundant writes");
});

test("manual activation chooses a package, resets progress, and blocks accumulation for 12 seconds", async () => {
  const actor = createActor();
  const abilityItem = actor.items[0];
  const abilityFunction = abilityItem.system.functions[0];
  globalThis.fromUuid = async uuid => uuid === actor.uuid ? actor : null;
  await observeExplosiveResilienceDamage({ event: damageEvent(actor, { incoming: 200 }) });

  let selectionCount = 0;
  const applied = await activateExplosiveResilience({
    actor,
    abilityItem,
    abilityFunction,
    selectPackage: async () => {
      selectionCount += 1;
      return "offense";
    }
  });

  assert.equal(applied, true);
  assert.equal(selectionCount, 1);
  assert.deepEqual(progress(actor), { current: 0, required: 200 });
  assert.equal(actor.effects.length, 1);
  assert.deepEqual(actor.effects[0].duration, {
    value: 12,
    units: "seconds",
    expiry: null,
    expired: false
  });
  assert.deepEqual(actor.effects[0].system.changes, [
    change("system.combat.damagePercent", "15"),
    change("system.combat.accuracy", "20"),
    change("system.resources.actionPoints.bonus", "1")
  ]);

  game.time.worldTime = 111;
  await observeExplosiveResilienceDamage({ event: damageEvent(actor, { incoming: 500 }) });
  assert.deepEqual(progress(actor), { current: 0, required: 200 });

  game.time.worldTime = 112;
  await observeExplosiveResilienceDamage({ event: damageEvent(actor, { incoming: 25 }) });
  assert.deepEqual(progress(actor), { current: 25, required: 200 });
});

test("failed manual application preserves progress and defense uses the configured formula", async () => {
  const actor = createActor({ createEffects: false });
  const abilityItem = actor.items[0];
  const abilityFunction = abilityItem.system.functions[0];
  globalThis.fromUuid = async uuid => uuid === actor.uuid ? actor : null;
  await observeExplosiveResilienceDamage({ event: damageEvent(actor, { incoming: 250 }) });

  const applied = await activateExplosiveResilience({
    actor,
    abilityItem,
    abilityFunction,
    selectPackage: async () => "defense"
  });

  assert.equal(applied, false);
  assert.deepEqual(progress(actor), { current: 200, required: 200 });
  assert.deepEqual(buildExplosiveResilienceEffectChanges({}, "defense"), [
    change("system.damageResistanceBonuses.all.all", "10+resilience/10"),
    change("system.resources.dodge.bonus", "30"),
    change("system.resources.movementPoints.bonus", "4")
  ]);
});

test("manual activation below the threshold does not open package selection", async () => {
  const actor = createActor();
  const abilityItem = actor.items[0];
  const abilityFunction = abilityItem.system.functions[0];
  let selected = false;

  const applied = await activateExplosiveResilience({
    actor,
    abilityItem,
    abilityFunction,
    selectPackage: async () => {
      selected = true;
      return "offense";
    }
  });

  assert.equal(applied, false);
  assert.equal(selected, false);
});

test("cancelled damage never contributes", async () => {
  const actor = createActor();
  globalThis.fromUuid = async uuid => uuid === actor.uuid ? actor : null;
  const event = damageEvent(actor, { incoming: 999 });
  event.outcome = { success: false, cancelled: true };

  await observeExplosiveResilienceDamage({ event });
  assert.deepEqual(progress(actor), { current: 0, required: 200 });
});

function createActor({ createEffects = true } = {}) {
  const actor = {
    id: "explosive-actor",
    uuid: "Actor.explosive",
    name: "Испытатель",
    img: "actor.webp",
    flags: {},
    effects: [],
    items: [],
    async createEmbeddedDocuments(documentName, entries, options) {
      assert.equal(documentName, "ActiveEffect");
      assert.deepEqual(options, { animate: false });
      if (!createEffects) return [];
      const created = entries.map((data, index) => createEffect(`effect-${index + 1}`, data));
      this.effects.push(...created);
      return created;
    },
    async deleteEmbeddedDocuments(documentName, ids, options) {
      assert.equal(documentName, "ActiveEffect");
      assert.deepEqual(options, { animate: false });
      this.effects = this.effects.filter(effect => !ids.includes(effect.id));
      return [];
    }
  };
  const abilityItem = {
    id: "explosive-item",
    uuid: `${actor.uuid}.Item.explosive-item`,
    type: "ability",
    name: "Взрывная стойкость",
    img: "ability.webp",
    parent: actor,
    flags: {},
    setFlagCalls: 0,
    system: {
      functions: [{
        id: "explosive-function",
        type: "fixed",
        fixedKey: ABILITY_FIXED_FUNCTION_KEYS.explosiveResilience,
        fixedSettings: {}
      }]
    },
    getFlag(scope, key) {
      return this.flags?.[scope]?.[key];
    },
    async setFlag(scope, key, value) {
      this.setFlagCalls += 1;
      this.flags[scope] ??= {};
      this.flags[scope][key] = structuredClone(value);
      return value;
    }
  };
  actor.items.push(abilityItem);
  actor.itemTypes = { ability: [abilityItem] };
  return actor;
}

function createEffect(id, data) {
  return {
    id,
    active: true,
    ...structuredClone(data),
    getFlag(scope, key) {
      return this.flags?.[scope]?.[key];
    }
  };
}

function damageEvent(actor, {
  incoming = 0,
  beforeResistance = incoming,
  preBarrierAmount = incoming,
  healthLoss = incoming,
  eventId = "damage-event",
  rootId = "damage-root"
} = {}) {
  return {
    key: "fallout-maw.damage.resolved",
    eventId,
    rootId,
    target: { actorUuid: actor.uuid },
    data: {
      amount: incoming,
      result: {
        amountBeforeResistance: beforeResistance,
        preBarrierAmount,
        healthDelta: healthLoss
      }
    },
    delta: { health: -healthLoss },
    outcome: { success: true, cancelled: false }
  };
}

function progress(actor) {
  const item = actor.items[0];
  const abilityFunction = item.system.functions[0];
  const entry = getExplosiveResilienceProgressEntry(item, abilityFunction);
  return { current: entry.current, required: entry.required };
}

function change(key, value) {
  return { key, type: "add", value, phase: "initial", priority: null };
}

test.after(() => {
  delete globalThis.fromUuid;
  delete globalThis.game;
  delete globalThis.foundry;
});
