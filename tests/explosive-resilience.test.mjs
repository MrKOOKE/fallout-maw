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
  EXPLOSIVE_RESILIENCE_CHOICE_EVENT_KEY,
  EXPLOSIVE_RESILIENCE_EFFECT_FLAG_KEY,
  buildExplosiveResilienceEffectChanges,
  collectExplosiveResilienceOffers,
  executeExplosiveResilienceOffer,
  getExplosiveResilienceProgressEntry,
  observeExplosiveResilienceDamage
} = await import("../src/abilities/explosive-resilience.mjs");

test("explosive resilience counts damage after Defense and before Resistance", async () => {
  const actor = createActor();
  globalThis.fromUuid = async uuid => uuid === actor.uuid ? actor : null;
  const requests = [];
  const requestChoice = async (eventKey, context) => {
    requests.push({ eventKey, context: structuredClone(context) });
    return { status: "declined" };
  };

  await observeExplosiveResilienceDamage({
    event: damageEvent(actor, {
      eventId: "damage-1",
      rootId: "root-1",
      incoming: 500,
      beforeResistance: 199,
      preBarrierAmount: 3,
      healthLoss: 0
    })
  }, { requestChoice });

  assert.deepEqual(progress(actor), { current: 199, required: 200 });
  assert.equal(requests.length, 0);

  await observeExplosiveResilienceDamage({
    event: damageEvent(actor, {
      eventId: "damage-2",
      rootId: "root-2",
      incoming: 500,
      beforeResistance: 1,
      preBarrierAmount: 0,
      healthLoss: 0
    })
  }, { requestChoice });

  assert.deepEqual(progress(actor), { current: 200, required: 200 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].eventKey, EXPLOSIVE_RESILIENCE_CHOICE_EVENT_KEY);
  assert.equal(requests[0].context.falloutMawSemanticReactionAdapted, true);
  assert.equal(requests[0].context.actorUuid, actor.uuid);

  const offers = await collectExplosiveResilienceOffers({
    eventKey: requests[0].eventKey,
    context: requests[0].context
  });
  assert.equal(offers.length, 2);
  assert.deepEqual(offers.map(offer => offer.packageKey), ["offense", "defense"]);
  assert.ok(offers.every(offer => offer.actorUuid === actor.uuid));

  await observeExplosiveResilienceDamage({
    event: damageEvent(actor, {
      eventId: "damage-3",
      rootId: "root-2",
      incoming: 100,
      preBarrierAmount: 100,
      healthLoss: 100
    })
  }, { requestChoice });
  assert.equal(requests.length, 1, "one damage root never opens duplicate choices");
});

test("successful package application resets progress and blocks accumulation for exactly 12 seconds", async () => {
  const actor = createActor();
  globalThis.fromUuid = async uuid => uuid === actor.uuid ? actor : null;
  let choiceContext = null;

  await observeExplosiveResilienceDamage({
    event: damageEvent(actor, { incoming: 200, eventId: "ready", rootId: "ready-root" })
  }, {
    requestChoice: async (_eventKey, context) => {
      choiceContext = structuredClone(context);
      return { status: "declined" };
    }
  });
  const [offense] = await collectExplosiveResilienceOffers({
    eventKey: EXPLOSIVE_RESILIENCE_CHOICE_EVENT_KEY,
    context: choiceContext
  });
  const applied = await executeExplosiveResilienceOffer({ offer: offense });

  assert.equal(applied.handled, true);
  assert.equal(applied.status, "success");
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
  await observeExplosiveResilienceDamage({
    event: damageEvent(actor, { incoming: 500, eventId: "active", rootId: "active-root" })
  }, { requestChoice: async () => assert.fail("active bonus must suppress accumulation") });
  assert.deepEqual(progress(actor), { current: 0, required: 200 });

  game.time.worldTime = 112;
  await observeExplosiveResilienceDamage({
    event: damageEvent(actor, { incoming: 25, eventId: "expired", rootId: "expired-root" })
  }, { requestChoice: async () => assert.fail("25 damage is below the threshold") });
  assert.deepEqual(progress(actor), { current: 25, required: 200 });
});

test("failed application preserves progress and defense package uses the configured formula", async () => {
  const actor = createActor({ createEffects: false });
  globalThis.fromUuid = async uuid => uuid === actor.uuid ? actor : null;
  let choiceContext = null;
  await observeExplosiveResilienceDamage({
    event: damageEvent(actor, { incoming: 250, eventId: "failed", rootId: "failed-root" })
  }, {
    requestChoice: async (_eventKey, context) => {
      choiceContext = structuredClone(context);
      return { status: "declined" };
    }
  });
  const offers = await collectExplosiveResilienceOffers({
    eventKey: EXPLOSIVE_RESILIENCE_CHOICE_EVENT_KEY,
    context: choiceContext
  });
  const failed = await executeExplosiveResilienceOffer({ offer: offers[1] });

  assert.equal(failed.handled, false);
  assert.deepEqual(progress(actor), { current: 200, required: 200 });
  assert.deepEqual(buildExplosiveResilienceEffectChanges({}, "defense"), [
    change("system.damageResistanceBonuses.all.all", "10+resilience/10"),
    change("system.resources.dodge.bonus", "30"),
    change("system.resources.movementPoints.bonus", "4")
  ]);
});

test("cancelled damage never contributes", async () => {
  const actor = createActor();
  globalThis.fromUuid = async uuid => uuid === actor.uuid ? actor : null;
  const event = damageEvent(actor, { incoming: 999 });
  event.outcome = { success: false, cancelled: true };

  await observeExplosiveResilienceDamage({ event }, {
    requestChoice: async () => assert.fail("cancelled damage cannot trigger a choice")
  });
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
