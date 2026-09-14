import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  reconcileActiveEffectRegistry,
  refreshActorEffectExpiration,
  unregisterDeletedActiveEffect
} from "../src/effects/registry.mjs";

class EffectCollection extends Map {
  [Symbol.iterator]() { return this.values(); }
}

// Foundry drops expired references before validating the grouped database deletion.
class ExpiryRegistry extends Set {
  batches = [];
  failure = null;

  add(effect) {
    if (effect.trackable !== false) super.add(effect);
    else this.delete(effect);
    return this;
  }

  addFromParent(parent) {
    for (const effect of parent.effects.values()) this.add(effect);
    for (const item of parent.items?.values() ?? []) this.addFromParent(item);
  }

  async refresh(event, { actors }) {
    const batch = [];
    for (const effect of this) {
      if (!actors.has(effect.actor) || effect.expiry !== event || effect.remaining > 0) continue;
      this.delete(effect);
      batch.push(effect);
    }
    this.batches.push(batch.map(effect => effect.id));
    if (this.failure) {
      const error = this.failure;
      this.failure = null;
      throw error;
    }
    for (const effect of batch) {
      if (!effect.parent.effects.has(effect.id)) throw new Error(`Missing effect ${effect.id}`);
    }
    for (const effect of batch) effect.parent.effects.delete(effect.id);
  }
}

function setup() {
  const registry = new ExpiryRegistry();
  globalThis.foundry = { documents: { ActiveEffect: { implementation: { registry } } } };
  const actor = { documentName: "Actor", uuid: "Actor.first", effects: new EffectCollection(), items: new Map(), isOwner: true };
  return { registry, actor };
}

function createEffect(actor, id, overrides = {}) {
  const effect = { id, uuid: `${actor.uuid}.ActiveEffect.${id}`, parent: actor, actor, remaining: 0, expiry: "managed", ...overrides };
  effect.getFlag = () => ({ kind: "temporary" });
  effect.parent.effects.set(id, effect);
  return effect;
}

test("deletion immediately unregisters an effect without waiting for garbage collection", () => {
  const { registry, actor } = setup();
  const effect = createEffect(actor, "burning");
  registry.add(effect);
  actor.effects.delete(effect.id);
  unregisterDeletedActiveEffect(effect);
  assert.equal(registry.has(effect), false);
});

test("a stale burning reference cannot poison a live expired medicine batch", async () => {
  const { registry, actor } = setup();
  const burning = createEffect(actor, "burning");
  const medicine = createEffect(actor, "bodrin");
  registry.add(burning).add(medicine);
  actor.effects.delete(burning.id);
  await refreshActorEffectExpiration("managed", { actors: new Set([actor]) });
  assert.deepEqual(registry.batches, [["bodrin"]]);
  assert.equal(actor.effects.size, 0);
  assert.equal(registry.has(burning), false);
});

test("replaced document instances with the same ID are removed before expiry", async () => {
  const { registry, actor } = setup();
  const obsolete = createEffect(actor, "same-id");
  registry.add(obsolete);
  const current = createEffect(actor, "same-id");
  await refreshActorEffectExpiration("managed", { actors: new Set([actor]) });
  assert.deepEqual(registry.batches, [[current.id]]);
  assert.equal(registry.has(obsolete), false);
  assert.equal(actor.effects.size, 0);
});

test("failed expiry remains registered and succeeds on the next update", async () => {
  const { registry, actor } = setup();
  const medicine = createEffect(actor, "withdrawal");
  registry.add(medicine);
  const failure = new Error("Database unavailable");
  registry.failure = failure;
  await assert.rejects(refreshActorEffectExpiration("managed", { actors: new Set([actor]) }), error => error === failure);
  assert.equal(actor.effects.get(medicine.id), medicine);
  assert.equal(registry.has(medicine), true);
  await refreshActorEffectExpiration("managed", { actors: new Set([actor]) });
  assert.equal(actor.effects.size, 0);
});

test("previously lost registrations recover without touching another actor's live effect", async () => {
  const { registry, actor } = setup();
  const other = { ...actor, uuid: "Actor.other", effects: new EffectCollection() };
  const otherEffect = createEffect(other, "other");
  registry.add(otherEffect);
  createEffect(actor, "bodrin");
  await refreshActorEffectExpiration("managed", { actors: new Set([actor]) });
  assert.equal(actor.effects.size, 0);
  assert.equal(other.effects.get(otherEffect.id), otherEffect);
  assert.equal(registry.has(otherEffect), true);
});

test("item effects recover and effects from a removed item are discarded", () => {
  const { registry, actor } = setup();
  const item = { id: "item", documentName: "Item", parent: actor, effects: new Map() };
  actor.items.set(item.id, item);
  const effect = createEffect(actor, "item-effect", { parent: item });
  const disabled = createEffect(actor, "disabled", { trackable: false });
  reconcileActiveEffectRegistry(registry, new Set([actor]));
  assert.equal(registry.has(effect), true);
  assert.equal(registry.has(disabled), false);
  actor.items.delete(item.id);
  assert.equal(reconcileActiveEffectRegistry(registry, new Set([actor])), 1);
  assert.equal(registry.has(effect), false);
});

test("reconciliation preserves a current standalone Item effect outside the actor scope", () => {
  const { registry, actor } = setup();
  const item = { id: "world-item", documentName: "Item", effects: new Map() };
  const effect = createEffect(actor, "standalone", { parent: item, actor: null });
  registry.add(effect);
  reconcileActiveEffectRegistry(registry, new Set([actor]));
  assert.equal(registry.has(effect), true);
  assert.equal(item.effects.get(effect.id), effect);
});

const effectSource = await readFile(new URL("../src/documents/active-effect.mjs", import.meta.url), "utf8");
const deleteHook = effectSource.slice(effectSource.indexOf("  _onDelete("), effectSource.indexOf("  /** Execute the action"));

test("the document deletion lifecycle unregisters before delegating to Foundry", () => {
  const { registry, actor } = setup();
  const effect = createEffect(actor, "manual");
  registry.add(effect);
  let delegated = false;
  const BaseEffect = class {
    _onDelete() {
      delegated = true;
      assert.equal(registry.has(this), false);
    }
  };
  globalThis.game = { user: { isActiveGM: false } };
  const Implementation = new Function("ActiveEffect", "unregisterDeletedActiveEffect", `return class extends ActiveEffect { ${deleteHook} };`)(BaseEffect, unregisterDeletedActiveEffect);
  Object.setPrototypeOf(effect, Implementation.prototype);
  effect._onDelete({}, "gm");
  assert.equal(delegated, true);
});

const damageSource = await readFile(new URL("../src/combat/damage-hub.mjs", import.meta.url), "utf8");
const processor = damageSource.slice(damageSource.indexOf("async function processTimedDamageEffectsNow("), damageSource.indexOf("async function processRegionPeriodicDamage("));

function loadProcessor(actors, overrides = {}) {
  const locks = new Set();
  const errors = [];
  const healings = [];
  const environment = {
    SYSTEM_ID: "fallout-maw", MODE_HEALING: "healing", TRAUMA_FLAG_SCOPE: "fallout-maw", DAMAGE_EFFECT_FLAG_KEY: "damageEffect",
    getTimeMechanicsIgnored: () => false,
    processRegionPeriodicDamage: async () => {},
    timedDamageActorIndex: { values: async () => actors.values() },
    queueActorDamageMutation: (uuid, operation) => Promise.resolve().then(() => operation(actors.find(actor => actor.uuid === uuid))),
    processingPeriodicEffectUuids: locks,
    getDamageEffectChanges: () => [],
    isDamageHubManagedTimedEffect: () => true,
    getPeriodicHealingEffectChanges: () => [],
    isFlagManagedTimedEffect: () => true,
    isManagedTimedDamageEffect: () => false,
    collectFlagManagedTimedEffectTicks: effect => ({ entries: [], deleteEffectId: effect.id, refreshExpiry: true }),
    deletePeriodicEffects: async (actor, ids) => {
      for (const id of ids) {
        unregisterDeletedActiveEffect(actor.effects.get(id));
        actor.effects.delete(id);
      }
    },
    refreshManagedTimedEffectExpiration: actor => refreshActorEffectExpiration("managed", { actors: new Set([actor]) }),
    HEALING_DAMAGE_TYPE_KEY: "healing", SCOPE_HEALTH: "health",
    executeDamageSystemEventWorkflow: async (requests, apply) => apply(requests),
    applyDamageApplicationsNow: async ({ requests }) => healings.push(...requests),
    publishDamageSummaryMessage: async () => {}, notifyDamageApplied: async () => {},
    debugTemporaryEffects: () => {},
    console: { error: (...args) => errors.push(args) },
    ...overrides
  };
  const { run, runActor } = new Function(...Object.keys(environment), `${processor}; return { run: processTimedDamageEffectsNow, runActor: processActorTimedDamageEffects };`)(...Object.values(environment));
  return { run, runActor, locks, errors, healings };
}

test("a collection failure releases earlier locks and does not skip later actors", async () => {
  const { actor } = setup();
  const other = { ...actor, uuid: "Actor.second", effects: new EffectCollection() };
  const first = createEffect(actor, "first");
  createEffect(actor, "broken");
  createEffect(other, "later");
  const { run, locks, errors } = loadProcessor([actor, other], {
    collectFlagManagedTimedEffectTicks: effect => {
      if (effect.id === "broken") throw new Error("Malformed effect");
      return { entries: [], deleteEffectId: effect.id };
    }
  });
  await run(10, 6);
  assert.equal(errors.length, 1);
  assert.match(errors[0][0], /Actor.first/);
  assert.equal(locks.size, 0);
  assert.equal(actor.effects.get(first.id), first);
  assert.equal(other.effects.size, 0);
});

test("a periodic deletion and medicine expiry complete for every candidate actor", async () => {
  const { registry, actor } = setup();
  const other = { ...actor, uuid: "Actor.second", effects: new EffectCollection() };
  for (const target of [actor, other]) {
    registry.add(createEffect(target, "burning"));
    registry.add(createEffect(target, "medicine"));
  }
  const { run, errors } = loadProcessor([actor, other], {
    collectFlagManagedTimedEffectTicks: effect => ({ entries: [], deleteEffectId: effect.id === "burning" ? effect.id : "", refreshExpiry: true })
  });
  await run(10, 6);
  assert.equal(errors.length, 0);
  assert.equal(actor.effects.size, 0);
  assert.equal(other.effects.size, 0);
  assert.deepEqual(registry.batches, [["medicine"], ["medicine"]]);
});

test("same-clock catch-up heals every due withdrawal tick once before deleting it", async () => {
  const { registry, actor } = setup();
  const data = { startTime: 100, endTime: 112, remainingTicks: 2, nextTickTime: 106, intervalSeconds: 6, amountPerTick: 3 };
  const effect = createEffect(actor, "healing-withdrawal", { duration: { seconds: 12, expiry: "managed", remaining: -3600 } });
  effect.getFlag = () => data;
  registry.add(effect);
  const collectorSource = damageSource.slice(damageSource.indexOf("function collectPeriodicHealingEffectTicks("), damageSource.indexOf("function collectFirstAidTemporaryEffectTicks("));
  const collector = new Function("toInteger", "roundDamageAmount", "hasTimedEffectReachedEnd", "MODE_HEALING", "HEALING_DAMAGE_TYPE_KEY", "SCOPE_HEALTH", "MANAGED_TIMED_DAMAGE_EXPIRY", "TRAUMA_FLAG_SCOPE", "DAMAGE_EFFECT_FLAG_KEY", `${collectorSource}; return collectPeriodicHealingEffectTicks;`)(Math.trunc, Number, (effect, data, now) => now >= data.endTime, "healing", "healing", "health", "managed", "fallout-maw", "damageEffect");
  const { runActor, healings, errors, locks } = loadProcessor([actor], { collectFlagManagedTimedEffectTicks: collector });
  await runActor(actor, 3700, 0, []);
  assert.equal(errors.length, 0);
  assert.deepEqual(healings.map(request => request.amount), [6]);
  assert.equal(actor.effects.size, 0);
  assert.equal(locks.size, 0);
  await runActor(actor, 3700, 0, []);
  assert.deepEqual(healings.map(request => request.amount), [6]);
});
