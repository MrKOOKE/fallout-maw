import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { SYSTEM_ID } from "../src/constants.mjs";
import {
  ABILITY_FIXED_FUNCTION_KEYS,
  normalizeAbilityFunctions,
  normalizePainLordSettings
} from "../src/settings/abilities.mjs";
import { getReverseEffectKey } from "../src/utils/active-effect-keys.mjs";
import {
  PAIN_LORD_MARK_EFFECT_FLAG_KEY,
  PAIN_LORD_OVERFLOW_EFFECT_FLAG_KEY,
  calculatePainLordAccumulation,
  reconcilePainLordEffectsForAbilityItem,
  getPainLordAbilityProgressEntry,
  processPainLordDamageResults
} from "../src/abilities/pain-lord.mjs";

test("pain lord defaults and fixed passive immunities match the design", async () => {
  assert.equal(ABILITY_FIXED_FUNCTION_KEYS.painLord, "painLord");
  assert.deepEqual(normalizePainLordSettings(), {
    useIncomingDamageBeforeResistance: true,
    energyPerDamage: 1,
    offenderDamagePerPercent: 5,
    offenderMaxPercent: 100,
    overflowEnergyPerPercent: 5,
    overflowMaxPercent: 100,
    overflowDurationSeconds: 12
  });

  await withFoundryFixture(async () => {
    const [abilityFunction] = normalizeAbilityFunctions([{
      id: "pain-lord-function",
      type: "fixed",
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.painLord,
      fixedSettings: {},
      changes: []
    }]);
    assert.deepEqual(abilityFunction.changes, [
      {
        id: "pain-lord-unconsciousness-immunity",
        key: "system.combat.unconsciousnessImmunity",
        type: "add",
        value: "1",
        phase: "initial",
        priority: null
      },
      {
        id: "pain-lord-stun-immunity",
        key: "system.combat.stunImmunity",
        type: "add",
        value: "1",
        phase: "initial",
        priority: null
      }
    ]);
  });
});

test("pain lord retains 5:1 remainder and clamps exactly at 100 percent", () => {
  assert.deepEqual(calculatePainLordAccumulation(2, 5, 100), {
    raw: 2,
    maximumRaw: 500,
    percent: 0
  });
  assert.deepEqual(calculatePainLordAccumulation(5, 5, 100), {
    raw: 5,
    maximumRaw: 500,
    percent: 1
  });
  assert.deepEqual(calculatePainLordAccumulation(999, 5, 100), {
    raw: 500,
    maximumRaw: 500,
    percent: 100
  });
});

test("pain lord normalizes discrete Energy and duration settings to whole values", () => {
  const normalized = normalizePainLordSettings({
    energyPerDamage: "2.9",
    overflowDurationSeconds: "12.9"
  });

  assert.equal(normalized.energyPerDamage, 2);
  assert.equal(normalized.overflowDurationSeconds, 12);
});

test("pain lord uses damage after Defense and before Resistance and can restore actual-loss mode", async () => {
  await withFoundryFixture(async ({ actors }) => {
    const incomingVictim = createActor({ id: "incoming-victim", painLord: true });
    const actualVictim = createActor({
      id: "actual-victim",
      painLord: true,
      painLordSettings: { useIncomingDamageBeforeResistance: false }
    });
    const incomingOffender = createActor({ id: "incoming-offender" });
    const actualOffender = createActor({ id: "actual-offender" });
    for (const actor of [incomingVictim, actualVictim, incomingOffender, actualOffender]) {
      actors.set(actor.uuid, actor);
    }

    await processPainLordDamageResults([{
      actor: incomingVictim,
      mode: "damage",
      healthDelta: 20,
      incomingAmount: 100,
      amountBeforeResistance: 60,
      damageApplications: [{
        incomingAmount: 100,
        amountBeforeResistance: 60,
        source: { attackerActorUuid: incomingOffender.uuid }
      }],
      sourceDamageEntries: [{ damage: 20, source: { attackerActorUuid: incomingOffender.uuid } }]
    }, {
      actor: actualVictim,
      mode: "damage",
      healthDelta: 20,
      incomingAmount: 100,
      amountBeforeResistance: 60,
      damageApplications: [{
        incomingAmount: 100,
        amountBeforeResistance: 60,
        source: { attackerActorUuid: actualOffender.uuid }
      }],
      sourceDamageEntries: [{ damage: 20, source: { attackerActorUuid: actualOffender.uuid } }]
    }]);

    assert.equal(incomingVictim.system.resources.power.value, 60);
    assert.equal(actualVictim.system.resources.power.value, 20);
    assert.equal(incomingOffender.effects[0].system.changes[0].value, "12");
    assert.equal(actualOffender.effects[0].system.changes[0].value, "4");
  });
});

test("fully resisted damage still powers pain lord and marks its attacker once", async () => {
  await withFoundryFixture(async ({ actors }) => {
    const victim = createActor({
      id: "resisted-victim",
      energy: { value: 0, max: 100, spent: 100 },
      painLord: true
    });
    const offender = createActor({ id: "resisted-offender" });
    actors.set(victim.uuid, victim);
    actors.set(offender.uuid, offender);

    await processPainLordDamageResults([{
      actor: victim,
      mode: "damage",
      incomingAmount: 35,
      amountBeforeResistance: 35,
      mitigationBlocked: 35,
      healthDelta: 0,
      source: { attackerActorUuid: offender.uuid }
    }]);

    assert.equal(victim.system.resources.power.value, 35);
    assert.equal(victim.actorUpdates.length, 1);
    assert.equal(offender.effectCreates.length, 1);
    assert.equal(offender.effects[0].system.changes[0].value, "7");
  });
});

test("blocked multi-source batches preserve attacker shares and convert only aggregate overflow", async () => {
  await withFoundryFixture(async ({ actors }) => {
    const victim = createActor({
      id: "blocked-batch-victim",
      energy: { value: 45, max: 50, spent: 5 },
      painLord: true
    });
    const firstOffender = createActor({ id: "first-blocked-offender" });
    const secondOffender = createActor({ id: "second-blocked-offender" });
    for (const actor of [victim, firstOffender, secondOffender]) actors.set(actor.uuid, actor);

    await processPainLordDamageResults([{
      actor: victim,
      mode: "damage",
      incomingAmount: 45,
      amountBeforeResistance: 45,
      mitigationBlocked: 45,
      healthDelta: 0,
      damageApplications: [{
        incomingAmount: 17,
        amountBeforeResistance: 17,
        source: { attackerActorUuid: firstOffender.uuid }
      }, {
        incomingAmount: 28,
        amountBeforeResistance: 28,
        source: { attackerActorUuid: secondOffender.uuid }
      }],
      sourceDamageEntries: []
    }]);

    assert.equal(victim.system.resources.power.value, 50);
    assert.equal(victim.actorUpdates.length, 1);
    assert.equal(victim.effects[0].system.changes[0].value, "8");
    assert.equal(firstOffender.effects[0].system.changes[0].value, "3");
    assert.equal(secondOffender.effects[0].system.changes[0].value, "5");
  });
});

test("disabled pre-resistance mode ignores damage fully blocked before health", async () => {
  await withFoundryFixture(async ({ actors }) => {
    const victim = createActor({
      id: "disabled-resisted-victim",
      painLord: true,
      painLordSettings: { useIncomingDamageBeforeResistance: false }
    });
    const offender = createActor({ id: "disabled-resisted-offender" });
    actors.set(victim.uuid, victim);
    actors.set(offender.uuid, offender);

    await processPainLordDamageResults([{
      actor: victim,
      mode: "damage",
      incomingAmount: 35,
      mitigationBlocked: 35,
      healthDelta: 0,
      source: { attackerActorUuid: offender.uuid }
    }]);

    assert.equal(victim.system.resources.power.value, 0);
    assert.equal(victim.actorUpdates.length, 0);
    assert.equal(victim.effects.length, 0);
    assert.equal(offender.effects.length, 0);
  });
});

test("actual health damage restores Energy, marks the offender, and converts only overflow", async () => {
  await withFoundryFixture(async ({ actors, game }) => {
    const victim = createActor({
      id: "victim",
      energy: { value: 90, max: 100, spent: 10 },
      painLord: true
    });
    const offender = createActor({ id: "offender" });
    actors.set(victim.uuid, victim);
    actors.set(offender.uuid, offender);

    await processPainLordDamageResults([{
      mode: "damage",
      actor: victim,
      healthDelta: 30,
      sourceDamageEntries: [
        { damage: 12, source: { attackerActorUuid: offender.uuid } },
        { damage: 18, source: { attackerActorUuid: offender.uuid } }
      ]
    }]);

    assert.equal(victim.system.resources.power.value, 100);
    assert.equal(victim.system.resources.power.spent, 0);
    assert.equal(victim.actorUpdates.length, 1);

    const overflow = victim.effects.find(effect => effect.flags?.[SYSTEM_ID]?.[PAIN_LORD_OVERFLOW_EFFECT_FLAG_KEY]);
    assert.ok(overflow);
    assert.equal(overflow.name, "Владыка боли: Избыток энергии");
    assert.equal(overflow.description, "Накоплено избытка Энергии: 20 / 500.");
    assert.deepEqual(overflow.start, { time: 100 });
    assert.deepEqual(overflow.duration, {
      value: 12,
      units: "seconds",
      expiry: null,
      expired: false
    });
    assert.deepEqual(overflow.system.changes, [{
      key: "system.combat.damagePercent",
      type: "add",
      value: "4",
      phase: "initial",
      priority: null
    }]);
    assert.equal(overflow.flags[SYSTEM_ID][PAIN_LORD_OVERFLOW_EFFECT_FLAG_KEY].accumulatedOverflow, 20);

    const mark = offender.effects.find(effect => effect.flags?.[SYSTEM_ID]?.[PAIN_LORD_MARK_EFFECT_FLAG_KEY]);
    assert.ok(mark);
    assert.equal(mark.name, "Владыка боли");
    assert.equal(mark.description, "");
    assert.deepEqual(mark.system.changes, [{
      key: getReverseEffectKey("system.combat.damagePercent"),
      type: "add",
      value: "6",
      phase: "initial",
      priority: null
    }]);
    assert.equal(mark.flags[SYSTEM_ID][PAIN_LORD_MARK_EFFECT_FLAG_KEY].contributors[0].accumulatedDamage, 30);

    assert.deepEqual(getPainLordAbilityProgressEntry(
      victim.items[0],
      victim.items[0].system.functions[0]
    ), {
      key: "pain-lord-function:painLord",
      label: "Избыток Энергии",
      value: "20 / 500 · урон +4%"
    });

    game.time.worldTime = 110;
    await processPainLordDamageResults([{
      actor: victim,
      healthDelta: 5,
      source: { attackerActorUuid: offender.uuid }
    }]);

    assert.equal(victim.effects.length, 1, "overflow refreshes one canonical effect");
    assert.deepEqual(overflow.start, { time: 110 });
    assert.equal(overflow.flags[SYSTEM_ID][PAIN_LORD_OVERFLOW_EFFECT_FLAG_KEY].accumulatedOverflow, 25);
    assert.equal(overflow.system.changes[0].value, "5");
    assert.equal(offender.effects.length, 1, "the offender mark is updated, not duplicated");
    assert.equal(mark.flags[SYSTEM_ID][PAIN_LORD_MARK_EFFECT_FLAG_KEY].contributors[0].accumulatedDamage, 35);
    assert.equal(mark.system.changes[0].value, "7");

    game.time.worldTime = 123;
    await processPainLordDamageResults([{
      actor: victim,
      healthDelta: 5,
      source: { attackerActorUuid: offender.uuid }
    }]);
    assert.deepEqual(overflow.start, { time: 123 });
    assert.equal(
      overflow.flags[SYSTEM_ID][PAIN_LORD_OVERFLOW_EFFECT_FLAG_KEY].accumulatedOverflow,
      5,
      "an expired 12-second pool starts from zero"
    );
    assert.equal(overflow.system.changes[0].value, "1");
  });
});

test("damage without an offender still restores Energy but never creates a mark", async () => {
  await withFoundryFixture(async ({ actors }) => {
    const victim = createActor({
      id: "environment-victim",
      energy: { value: 10, max: 100, spent: 90 },
      painLord: true
    });
    actors.set(victim.uuid, victim);

    await processPainLordDamageResults([{ actor: victim, healthDelta: 25 }]);

    assert.equal(victim.system.resources.power.value, 35);
    assert.equal(victim.effects.length, 0);
  });
});

test("missing Energy never turns received damage into fake overflow", async () => {
  await withFoundryFixture(async ({ actors }) => {
    const victim = createActor({ id: "no-energy", painLord: true, energy: null });
    const offender = createActor({ id: "offender" });
    actors.set(victim.uuid, victim);
    actors.set(offender.uuid, offender);

    await processPainLordDamageResults([{
      actor: victim,
      healthDelta: 25,
      source: { attackerActorUuid: offender.uuid }
    }]);

    assert.equal(victim.effects.length, 0);
    assert.equal(offender.effects[0].system.changes[0].value, "5");
  });
});

test("several pain lords share one offender icon and one global 100 percent cap", async () => {
  await withFoundryFixture(async ({ actors }) => {
    const first = createActor({ id: "first", painLord: true });
    const second = createActor({ id: "second", painLord: true });
    const offender = createActor({ id: "shared-offender" });
    for (const actor of [first, second, offender]) actors.set(actor.uuid, actor);

    await processPainLordDamageResults([
      { actor: first, healthDelta: 400, source: { attackerActorUuid: offender.uuid } },
      { actor: second, healthDelta: 400, source: { attackerActorUuid: offender.uuid } }
    ]);

    assert.equal(offender.effects.length, 1);
    const mark = offender.effects[0];
    assert.equal(mark.flags[SYSTEM_ID][PAIN_LORD_MARK_EFFECT_FLAG_KEY].contributors.length, 2);
    assert.equal(mark.system.changes[0].value, "100");
  });
});

test("reconciling a removed pain lord function deletes only its own accumulated effects", async () => {
  await withFoundryFixture(async ({ actors, game }) => {
    const first = createActor({
      id: "cleanup-first",
      energy: { value: 100, max: 100, spent: 0 },
      painLord: true
    });
    const second = createActor({ id: "cleanup-second", painLord: true });
    const offender = createActor({ id: "cleanup-offender" });
    for (const actor of [first, second, offender]) {
      actors.set(actor.uuid, actor);
      game.actors.contents.push(actor);
    }

    await processPainLordDamageResults([
      { actor: first, healthDelta: 25, source: { attackerActorUuid: offender.uuid } },
      { actor: second, healthDelta: 25, source: { attackerActorUuid: offender.uuid } }
    ]);

    assert.ok(first.effects.some(effect => (
      effect.flags?.[SYSTEM_ID]?.[PAIN_LORD_OVERFLOW_EFFECT_FLAG_KEY]
    )));
    assert.equal(
      offender.effects[0].flags[SYSTEM_ID][PAIN_LORD_MARK_EFFECT_FLAG_KEY].contributors.length,
      2
    );

    first.items[0].system.functions = [];
    await reconcilePainLordEffectsForAbilityItem(first.items[0]);

    assert.equal(first.effects.length, 0, "the removed function's overflow is deleted");
    assert.equal(offender.effects.length, 1, "the shared mark remains for the other pain lord");
    const mark = offender.effects[0];
    const contributors = mark.flags[SYSTEM_ID][PAIN_LORD_MARK_EFFECT_FLAG_KEY].contributors;
    assert.equal(contributors.length, 1);
    assert.equal(contributors[0].sourceActorUuid, second.uuid);
    assert.equal(mark.origin, second.items[0].uuid);
    assert.equal(mark.system.changes[0].value, "5");
  });
});

test("pain lord is registered through the awaited damage handler and both editors expose every setting", async () => {
  const [fixed, itemSheet, catalogEditor, itemTemplate, catalogTemplate] = await Promise.all([
    readFile(new URL("../src/abilities/fixed-functions.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/sheets/item-sheet.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/apps/ability-catalog-item-editor.mjs", import.meta.url), "utf8"),
    readFile(new URL("../templates/item/item-sheet.hbs", import.meta.url), "utf8"),
    readFile(new URL("../templates/settings/ability-catalog-item-editor.hbs", import.meta.url), "utf8")
  ]);

  assert.match(fixed, /key:\s*ABILITY_FIXED_FUNCTION_KEYS\.painLord[\s\S]*?label:\s*"Владыка боли"[\s\S]*?passive:\s*true/);
  assert.match(fixed, /registerDamageAppliedHandler\([\s\S]*?PAIN_LORD_DAMAGE_HANDLER_ID[\s\S]*?processPainLordDamageResults/);
  assert.match(fixed, /getPainLordAbilityProgressEntry\(abilityItem, entry\)/);
  assert.match(itemSheet, /fixedPainLordSettings/);
  assert.match(catalogEditor, /fixedPainLordSettings/);

  const fields = [
    "useIncomingDamageBeforeResistance",
    "energyPerDamage",
    "offenderDamagePerPercent",
    "offenderMaxPercent",
    "overflowEnergyPerPercent",
    "overflowMaxPercent",
    "overflowDurationSeconds"
  ];
  for (const source of [itemTemplate, catalogTemplate]) {
    assert.match(source, /fixedPainLordSettings/);
    for (const field of fields) assert.match(source, new RegExp(field));
  }
});

test("active-effect damage notifies once and source attribution uses actual health loss", async () => {
  const damageHub = await readFile(new URL("../src/combat/damage-hub.mjs", import.meta.url), "utf8");
  const timedStart = damageHub.indexOf("async function processTimedDamageEffectsNow");
  const timedEnd = damageHub.indexOf("async function processRegionPeriodicDamage", timedStart);
  const timedSource = damageHub.slice(timedStart, timedEnd);
  const periodicStart = damageHub.indexOf("async function applyPeriodicDamageBatch");
  const periodicEnd = damageHub.indexOf("async function distributeManualHealthValueUpdate", periodicStart);
  const periodicSource = damageHub.slice(periodicStart, periodicEnd);
  const attributionStart = damageHub.indexOf("function buildBatchSourceDamageEntries");
  const attributionEnd = damageHub.indexOf("function buildBatchBleedingEntries", attributionStart);
  const attributionSource = damageHub.slice(attributionStart, attributionEnd);

  assert.ok(timedStart >= 0 && timedEnd > timedStart);
  assert.equal((timedSource.match(/await notifyDamageApplied\(damageResults\)/g) ?? []).length, 1);
  assert.ok(
    timedSource.indexOf("await publishDamageSummaryMessage(damageResults)")
      < timedSource.indexOf("await notifyDamageApplied(damageResults)")
  );
  assert.match(periodicSource, /applyDamageApplicationsNow\([^]*?\{ createSummary: false \}\)/);
  assert.doesNotMatch(periodicSource, /notifyDamageApplied/);
  assert.ok(attributionStart >= 0 && attributionEnd > attributionStart);
  assert.match(attributionSource, /damage: roundDamageAmount\(entry\?\.actualHealthDelta\)/);
  assert.doesNotMatch(attributionSource, /damageRatio|requestedDamage|entry\.amount/);
});

test("fully delayed periodic damage is counted only when its ticks are applied", async () => {
  const damageHub = await readFile(new URL("../src/combat/damage-hub.mjs", import.meta.url), "utf8");
  const preparationStart = damageHub.indexOf("function prepareDamageBatchEntry");
  const preparationEnd = damageHub.indexOf("async function applyDirectDamageApplication", preparationStart);
  const preparationSource = damageHub.slice(preparationStart, preparationEnd);

  assert.ok(preparationStart >= 0 && preparationEnd > preparationStart);
  assert.match(preparationSource, /if\s*\(!immediateAmount\)\s*\{\s*return\s*\{[^}]*incomingAmount:\s*0/);
});

async function withFoundryFixture(run) {
  const previous = {
    game: globalThis.game,
    fromUuidSync: globalThis.fromUuidSync,
    foundry: globalThis.foundry
  };
  const actors = new Map();
  const game = {
    user: { isGM: true },
    time: { worldTime: 100 },
    actors: { contents: [] },
    scenes: { contents: [] }
  };
  globalThis.game = game;
  globalThis.fromUuidSync = uuid => actors.get(String(uuid ?? "")) ?? null;
  let nextId = 1;
  globalThis.foundry = {
    utils: {
      randomID: () => `generated-${nextId++}`,
      flattenObject(value) {
        return value ?? {};
      }
    }
  };
  try {
    await run({ actors, game });
  } finally {
    restoreGlobal("game", previous.game);
    restoreGlobal("fromUuidSync", previous.fromUuidSync);
    restoreGlobal("foundry", previous.foundry);
  }
}

function createActor({
  id,
  energy = { value: 0, max: 100, spent: 100 },
  painLord = false,
  painLordSettings = {}
} = {}) {
  const actor = {
    id,
    uuid: `Actor.${id}`,
    documentName: "Actor",
    name: id,
    img: `${id}.webp`,
    isOwner: true,
    system: {
      resources: energy ? { power: { min: 0, ...energy } } : {},
      combat: {}
    },
    items: [],
    effects: [],
    actorUpdates: [],
    effectCreates: [],
    effectUpdates: [],
    async update(changes, options = {}) {
      this.actorUpdates.push({ changes: structuredClone(changes), options: structuredClone(options) });
      if (Object.hasOwn(changes, "system.resources.power.value")) {
        this.system.resources.power.value = changes["system.resources.power.value"];
      }
      if (Object.hasOwn(changes, "system.resources.power.spent")) {
        this.system.resources.power.spent = changes["system.resources.power.spent"];
      }
      return this;
    },
    async createEmbeddedDocuments(documentName, entries, options) {
      assert.equal(documentName, "ActiveEffect");
      assert.deepEqual(options, { animate: false });
      const created = entries.map((entry, index) => createEffect(
        this,
        `effect-${this.effects.length + index + 1}`,
        entry
      ));
      this.effectCreates.push(...entries.map(entry => structuredClone(entry)));
      this.effects.push(...created);
      return created;
    },
    async deleteEmbeddedDocuments(documentName, ids, options) {
      assert.equal(documentName, "ActiveEffect");
      assert.deepEqual(options, { animate: false });
      const removed = this.effects.filter(effect => ids.includes(effect.id));
      this.effects = this.effects.filter(effect => !ids.includes(effect.id));
      return removed;
    }
  };
  if (painLord) {
    const abilityItem = {
      id: "pain-lord-item",
      uuid: `${actor.uuid}.Item.pain-lord-item`,
      type: "ability",
      name: "Владыка боли",
      img: "pain-lord.webp",
      parent: actor,
      system: {
        functions: [{
          id: "pain-lord-function",
          type: "fixed",
          fixedKey: ABILITY_FIXED_FUNCTION_KEYS.painLord,
          fixedSettings: painLordSettings
        }]
      }
    };
    actor.items.push(abilityItem);
  }
  return actor;
}

function createEffect(actor, id, data) {
  return {
    id,
    parent: actor,
    active: true,
    ...structuredClone(data),
    getFlag(scope, key) {
      return this.flags?.[scope]?.[key];
    },
    async update(changes, options) {
      assert.deepEqual(options, { animate: false });
      actor.effectUpdates.push(structuredClone(changes));
      Object.assign(this, structuredClone(changes));
      this.active = true;
      return this;
    }
  };
}

function restoreGlobal(key, value) {
  if (value === undefined) delete globalThis[key];
  else globalThis[key] = value;
}
