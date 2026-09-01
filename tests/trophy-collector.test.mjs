import test from "node:test";
import assert from "node:assert/strict";

import {
  TROPHY_COLLECTOR_MARK_FLAG_KEY,
  applyTrophyCollectorMark,
  buildTrophyCollectorMarkChanges,
  buildTrophyCollectorMarkEffectData,
  clearTrophyCollectorRuntimeCaches,
  getTrophyCollectorFunctionState,
  normalizeTrophyCollectorLedger,
  processTrophyCollectorAttackEvent,
  processTrophyCollectorDamageEvent,
  processTrophyCollectorStatusEvent,
  showTrophyCollectorLedger
} from "../src/abilities/trophy-collector.mjs";

const SYSTEM_ID = "fallout-maw";
const STATE_FLAG = "abilityFixedFunctionState";

test.beforeEach(() => {
  clearTrophyCollectorRuntimeCaches();
  globalThis.game = {
    time: { worldTime: 100 },
    user: { id: "gm", isActiveGM: true },
    users: { activeGM: { id: "gm" } },
    settings: { get: (_scope, key) => key === "factionMatrix" ? {} : [] }
  };
});

test.afterEach(() => {
  delete globalThis.game;
  delete globalThis.fromUuidSync;
});

test("Trophy ledger clamps and de-duplicates stable race identifiers", () => {
  assert.deepEqual(normalizeTrophyCollectorLedger({ races: [
    { raceId: "ghoul", raceName: "Гуль", strength: 9 },
    { raceId: "ghoul", raceName: "Дубликат", strength: 2 },
    { raceId: "mutant", strength: 0 }
  ] }, 5), {
    fixedKey: "trophyCollector",
    races: [
      { raceId: "ghoul", raceName: "Гуль", strength: 5 },
      { raceId: "mutant", raceName: "mutant", strength: 1 }
    ]
  });
});

test("Trophy marks expose all three bonuses as target-owned reverse keys", () => {
  assert.deepEqual(buildTrophyCollectorMarkChanges({}, 3), [
    change("fallout-maw.reverse.system.combat.accuracy", 30),
    change("fallout-maw.reverse.system.combat.damagePercent", 15),
    change("fallout-maw.reverse.system.combat.criticalChance", 3)
  ]);
});

test("Trophy mark tooltip relies on change rows without a duplicate description", () => {
  const source = makeActor("Actor.hunter", "human", "A");
  const target = makeActor("Actor.target", "ghoul", "B");
  const item = makeAbility(source);
  const data = buildTrophyCollectorMarkEffectData({
    sourceActor: source,
    targetActor: target,
    abilityItem: item,
    abilityFunction: item.system.functions[0],
    strength: 3
  });

  assert.equal(data.description, "");
  assert.deepEqual(data.system.changes, buildTrophyCollectorMarkChanges({}, 3));
});

test("Trophy ledger opens a system dialog instead of publishing a chat card", async () => {
  const actor = makeActor("Actor.hunter", "human", "A");
  const item = makeAbility(actor);
  const abilityFunction = item.system.functions[0];
  item.flags[SYSTEM_ID][STATE_FLAG] = {
    "trophy-function:trophyCollector": {
      fixedKey: "trophyCollector",
      races: [{ raceId: "human", raceName: "Человек", strength: 3 }]
    }
  };
  let dialogOptions = null;

  const shown = await showTrophyCollectorLedger({
    actor,
    abilityItem: item,
    abilityFunction,
    openDialog: async options => {
      dialogOptions = options;
      return true;
    }
  });

  assert.equal(shown, true);
  assert.equal(dialogOptions.window.title, "Собиратель трофеев");
  assert.match(dialogOptions.content, /Человек/);
  assert.match(dialogOptions.content, /3\s*\/\s*5/);
  assert.equal(dialogOptions.modal, true);
  assert.deepEqual(dialogOptions.buttons.map(button => button.action), ["close"]);
});

test("one weapon attack can mark the same wounded target only once", async () => {
  const source = makeActor("Actor.hunter", "human", "A");
  const target = makeActor("Actor.target", "ghoul", "B");
  const item = makeAbility(source);
  source.items = [item];
  const documents = new Map([[source.uuid, source], [target.uuid, target]]);
  let applications = 0;
  const event = makeDamageEvent(source, target, "attack-1", -7);
  const options = {
    resolveActor: uuid => documents.get(uuid) ?? null,
    isAuthority: () => true,
    isEligibleTarget: () => true,
    applyMark: async () => {
      applications += 1;
      return { ok: true };
    }
  };

  await processTrophyCollectorDamageEvent(event, options);
  await processTrophyCollectorDamageEvent(event, options);
  assert.equal(applications, 1);

  const secondPacket = makeDamageEvent(source, target, "attack-1", -2);
  await processTrophyCollectorDamageEvent(secondPacket, options);
  assert.equal(applications, 1);

  await processTrophyCollectorDamageEvent(makeDamageEvent(source, target, "attack-2", 0), options);
  assert.equal(applications, 1, "limb-only or fully blocked packets do not mark");
});

test("a maximum-strength mark tests Resilience and applies 50% Stun on failure", async () => {
  const source = makeActor("Actor.hunter", "human", "A");
  const target = makeActor("Actor.target", "ghoul", "B");
  const item = makeAbility(source);
  source.items = [item];
  const functionStateKey = "trophy-function:trophyCollector";
  item.flags[SYSTEM_ID][STATE_FLAG] = {
    [functionStateKey]: {
      fixedKey: "trophyCollector",
      races: [{ raceId: "ghoul", raceName: "Гуль", strength: 5 }]
    }
  };
  let checkCount = 0;
  let stunCount = 0;

  const result = await applyTrophyCollectorMark({
    sourceActor: source,
    targetActor: target,
    abilityItem: item,
    abilityFunction: item.system.functions[0],
    attackId: "attack-max",
    requestCheck: async () => {
      checkCount += 1;
      return { result: { key: "failure" } };
    },
    applyStun: async () => {
      stunCount += 1;
      return { id: "stun" };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.strength, 5);
  assert.equal(result.stunned, true);
  assert.equal(checkCount, 1);
  assert.equal(stunCount, 1);
  const mark = target.effects[0];
  assert.equal(mark.flags[SYSTEM_ID][TROPHY_COLLECTOR_MARK_FLAG_KEY].strength, 5);
  assert.deepEqual(mark.system.changes, buildTrophyCollectorMarkChanges({}, 5));
});

test("each marked carrier death advances its owner even when another actor gets the kill", async () => {
  const source = makeActor("Actor.hunter", "human", "A");
  const killer = makeActor("Actor.killer", "human", "C");
  const target = makeActor("Actor.target", "ghoul", "B");
  const item = makeAbility(source);
  source.items = [item];
  const abilityFunction = item.system.functions[0];
  const markData = buildTrophyCollectorMarkEffectData({
    sourceActor: source,
    targetActor: target,
    abilityItem: item,
    abilityFunction,
    strength: 1,
    raceId: "ghoul",
    raceName: "Гуль",
    attackId: "attack-kill",
    startTime: 100
  });
  target.effects.push(makeEffect(target, "mark", markData));
  const documents = new Map([[source.uuid, source], [killer.uuid, killer], [target.uuid, target]]);
  const event = {
    key: "fallout-maw.weapon.attack.resolved",
    participants: { source: { actorUuid: killer.uuid } },
    data: {
      actorUuid: killer.uuid,
      attackId: "attack-kill",
      attackCycleAggregate: true,
      killedTargetUuids: [target.uuid, target.uuid]
    }
  };
  const options = { resolveActor: uuid => documents.get(uuid) ?? null, isAuthority: () => true };

  await processTrophyCollectorAttackEvent(event, options);
  assert.equal(getTrophyCollectorFunctionState(item, abilityFunction).races[0].strength, 2);
  assert.equal(item.setFlagCalls, 1);

  await processTrophyCollectorAttackEvent(event, options);
  assert.equal(getTrophyCollectorFunctionState(item, abilityFunction).races[0].strength, 2);
  assert.equal(item.setFlagCalls, 1, "duplicate aggregate does not mutate the item again");
});

test("a marked carrier advances on the Dead status regardless of damage source", async () => {
  const source = makeActor("Actor.hunter", "human", "A");
  const target = makeActor("Actor.target", "ghoul", "B");
  const item = makeAbility(source);
  source.items = [item];
  const abilityFunction = item.system.functions[0];
  target.effects.push(makeEffect(target, "mark", buildTrophyCollectorMarkEffectData({
    sourceActor: source,
    targetActor: target,
    abilityItem: item,
    abilityFunction,
    strength: 1,
    raceId: "ghoul",
    raceName: "Гуль",
    attackId: "old-attack",
    startTime: 100
  })));
  const documents = new Map([[source.uuid, source], [target.uuid, target]]);
  const options = { resolveActor: uuid => documents.get(uuid) ?? null, isAuthority: () => true };
  const statusEvent = key => ({
    key,
    participants: { target: { actorUuid: target.uuid } },
    data: { actorUuid: target.uuid, statusId: "dead" }
  });

  await processTrophyCollectorStatusEvent(statusEvent("fallout-maw.actor.status.gained"), options);
  assert.equal(getTrophyCollectorFunctionState(item, abilityFunction).races[0].strength, 2);

  await processTrophyCollectorStatusEvent(statusEvent("fallout-maw.actor.status.gained"), options);
  assert.equal(getTrophyCollectorFunctionState(item, abilityFunction).races[0].strength, 2);

  await processTrophyCollectorStatusEvent(statusEvent("fallout-maw.actor.status.lost"), options);
  await processTrophyCollectorStatusEvent(statusEvent("fallout-maw.actor.status.gained"), options);
  assert.equal(getTrophyCollectorFunctionState(item, abilityFunction).races[0].strength, 3);
});

function makeDamageEvent(source, target, attackId, healthDelta) {
  return {
    key: "fallout-maw.damage.resolved",
    participants: {
      source: { actorUuid: source.uuid },
      target: { actorUuid: target.uuid }
    },
    data: {
      actorUuid: target.uuid,
      source: {
        attackId,
        attackerActorUuid: source.uuid,
        weaponAttackDamage: true
      },
      result: { actorUuid: target.uuid, healthDelta: Math.abs(healthDelta) }
    },
    delta: { health: healthDelta, limb: healthDelta ? 0 : -10 },
    outcome: { success: true, cancelled: false }
  };
}

function makeActor(uuid, raceId, faction) {
  const actor = {
    uuid,
    system: { creature: { raceId }, combat: {}, skills: {} },
    effects: [],
    items: [],
    getFlag(scope, key) {
      if (scope !== SYSTEM_ID) return null;
      if (key === "factionBelongs") return [faction];
      if (key === "factionRelations") return {};
      return null;
    },
    async createEmbeddedDocuments(_type, entries) {
      const created = entries.map((entry, index) => makeEffect(actor, `effect-${this.effects.length + index}`, entry));
      this.effects.push(...created);
      return created;
    }
  };
  return actor;
}

function makeAbility(actor) {
  const item = {
    id: "trophy-item",
    uuid: `${actor.uuid}.Item.trophy-item`,
    name: "Собиратель трофеев",
    img: "icons/svg/target.svg",
    type: "ability",
    parent: actor,
    flags: { core: { sourceId: "Compendium.test.trophy" }, [SYSTEM_ID]: {} },
    setFlagCalls: 0,
    system: {
      functions: [{
        id: "trophy-function",
        type: "fixed",
        enabled: true,
        fixedKey: "trophyCollector",
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
      return this;
    }
  };
  return item;
}

function makeEffect(actor, id, data) {
  const effect = {
    id,
    uuid: `${actor.uuid}.ActiveEffect.${id}`,
    parent: actor,
    ...structuredClone(data),
    getFlag(scope, key) {
      return this.flags?.[scope]?.[key];
    },
    async update(update) {
      Object.assign(this, structuredClone(update));
      return this;
    }
  };
  return effect;
}

function change(key, value) {
  return { key, type: "add", value: String(value), phase: "initial", priority: null };
}
