import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { SYSTEM_ID } from "../src/constants.mjs";
import {
  ABILITY_FIXED_FUNCTION_KEYS,
  normalizeLivingSteelSettings
} from "../src/settings/abilities.mjs";
import {
  LIVING_STEEL_EFFECT_FLAG_KEY,
  LIVING_STEEL_EXPIRY_EVENT,
  LIVING_STEEL_RESILIENCE_EFFECT_FLAG_KEY,
  applyLivingSteelFinalHealthDamage,
  calculateLivingSteelResilienceBonus,
  calculateLivingSteelThreshold,
  findLivingSteelEffect,
  findLivingSteelResilienceEffect,
  getLivingSteelAbilityProgressEntry,
  getLivingSteelEffectTooltipRows,
  reconcileLivingSteelEffectsForAbilityItem,
  resolveLivingSteelFinalDamage
} from "../src/abilities/living-steel.mjs";
import {
  registerQueuedWorldTimeFinalizer,
  registerQueuedWorldTimeProcessor,
  waitForWorldTimeQueueIdle
} from "../src/time/world-time-queue.mjs";

function createActor({ resilience = 100, health = 100, maxHealth = 100 } = {}) {
  return {
    system: {
      skills: { resilience: { value: resilience } },
      resources: { health: { value: health, max: maxHealth } }
    }
  };
}

test("living steel defaults match the fixed ability design", () => {
  assert.equal(ABILITY_FIXED_FUNCTION_KEYS.livingSteel, "livingSteel");
  assert.equal(LIVING_STEEL_EXPIRY_EVENT, "fallout-maw.livingSteelInactivity");
  assert.deepEqual(normalizeLivingSteelSettings(), {
    annulledDamageLimit: 1000,
    normalMissingHealthStepPercent: 1,
    weakenedMissingHealthStepPercent: 4,
    resilienceBonusPerStep: 2,
    weakenedResilienceDivisor: 4,
    weakenedDurationSeconds: 18,
    resetAfterSeconds: 60
  });
});

test("living steel derives normal and weakened thresholds from missing health", () => {
  const actor = createActor({ resilience: 80, health: 74, maxHealth: 100 });

  assert.equal(calculateLivingSteelResilienceBonus({}, { health: actor.system.resources.health }), 52);
  assert.equal(calculateLivingSteelResilienceBonus({}, {
    weakened: true,
    health: actor.system.resources.health
  }), 12);
  assert.equal(calculateLivingSteelThreshold(actor), 132);
  assert.equal(calculateLivingSteelThreshold(actor, {}, { weakened: true }), 32);
});

test("an already applied resilience bonus is displayed once and never doubles the threshold", () => {
  const actor = createActor({ resilience: 132, health: 74, maxHealth: 100 });
  actor.system.skills.resilience = {
    base: 80,
    bonus: 52,
    developmentBonus: 0,
    abilityBonus: 0,
    bonusPercent: 0,
    pureValue: 80,
    developmentLimitPureOnly: true,
    min: 0,
    max: 100,
    valueBeforePercent: 132,
    value: 132
  };
  actor.effects = [{
    system: {
      changes: [{ key: "system.skills.resilience.bonus", type: "add", value: "52" }]
    },
    flags: { [SYSTEM_ID]: { [LIVING_STEEL_RESILIENCE_EFFECT_FLAG_KEY]: {
      abilityItemId: "living-steel-item",
      functionId: "living-steel-function"
    } } },
    getFlag(scope, key) {
      return this.flags?.[scope]?.[key];
    }
  }];

  assert.equal(calculateLivingSteelThreshold(actor), 132);
  assert.equal(calculateLivingSteelThreshold(actor, {}, { weakened: true }), 32);
});

test("living steel counts the exact 58 missing-health steps for 21 of 50 health", () => {
  const actor = createActor({ resilience: 80, health: 21, maxHealth: 50 });

  assert.equal(calculateLivingSteelThreshold(actor), 196);
  assert.equal(calculateLivingSteelThreshold(actor, {}, { weakened: true }), 48);
});

test("living steel annuls only final health damage strictly below its threshold", () => {
  const actor = createActor({ resilience: 80 });
  const below = { id: "below", healthDamage: 79 };
  const equal = { id: "equal", healthDamage: 80 };
  const zero = { id: "zero", healthDamage: 0 };
  const resolved = resolveLivingSteelFinalDamage({
    actor,
    applications: [below, equal, zero],
    worldTime: 100
  });

  assert.deepEqual(resolved.blockedApplications, [below]);
  assert.equal(resolved.touched, true);
  assert.equal(resolved.state.annulledDamage, 79);
  assert.equal(resolved.state.lastDamageAt, 100);
});

test("living steel accumulates the full post-mitigation packet before remaining health clamps it", () => {
  const actor = createActor({ resilience: 92, health: 1, maxHealth: 100 });
  const postMitigationPacket = { id: "overkill", healthDamage: 73 };
  const resolved = resolveLivingSteelFinalDamage({
    actor,
    applications: [postMitigationPacket],
    worldTime: 100
  });

  assert.deepEqual(resolved.blockedApplications, [postMitigationPacket]);
  assert.equal(resolved.state.annulledDamage, 73);
});

test("crossing 1000 annulled damage makes the next application use weakened strength", () => {
  const actor = createActor({ resilience: 100 });
  const crossing = { id: "crossing", healthDamage: 60 };
  const next = { id: "next", healthDamage: 60 };
  const resolved = resolveLivingSteelFinalDamage({
    actor,
    applications: [crossing, next],
    state: { annulledDamage: 950, lastDamageAt: 99 },
    worldTime: 100
  });

  assert.deepEqual(resolved.blockedApplications, [crossing]);
  assert.equal(resolved.state.annulledDamage, 1000);
  assert.equal(resolved.state.weakenedUntil, 118);
});

test("living steel returns to full strength and resets its cycle after 18 seconds", () => {
  const actor = createActor({ resilience: 100 });
  const hit = { healthDamage: 60 };
  const weakened = resolveLivingSteelFinalDamage({
    actor,
    applications: [hit],
    state: { annulledDamage: 1000, weakenedUntil: 118, lastDamageAt: 100 },
    worldTime: 117
  });
  const recovered = resolveLivingSteelFinalDamage({
    actor,
    applications: [hit],
    state: { annulledDamage: 1000, weakenedUntil: 118, lastDamageAt: 100 },
    worldTime: 118
  });

  assert.deepEqual(weakened.blockedApplications, []);
  assert.equal(weakened.state.annulledDamage, 1000);
  assert.deepEqual(recovered.blockedApplications, [hit]);
  assert.equal(recovered.state.annulledDamage, 60);
  assert.equal(recovered.state.weakenedUntil, 0);
});

test("60 seconds without final incoming health damage resets living steel before the next hit", () => {
  const actor = createActor({ resilience: 100 });
  const hit = { healthDamage: 60 };
  const resolved = resolveLivingSteelFinalDamage({
    actor,
    applications: [hit],
    state: { annulledDamage: 900, weakenedUntil: 150, lastDamageAt: 100 },
    worldTime: 160
  });

  assert.deepEqual(resolved.blockedApplications, [hit]);
  assert.equal(resolved.state.annulledDamage, 60);
  assert.equal(resolved.state.weakenedUntil, 0);
  assert.equal(resolved.state.lastDamageAt, 160);
});

test("each packet uses its own world time for inactivity and weakened-state transitions", () => {
  const actor = createActor({ resilience: 100 });
  const first = { healthDamage: 60, worldTime: 159 };
  const second = { healthDamage: 60, worldTime: 219 };
  const resolved = resolveLivingSteelFinalDamage({
    actor,
    applications: [first, second],
    state: { annulledDamage: 900, lastDamageAt: 100 },
    worldTime: 999
  });

  assert.deepEqual(resolved.blockedApplications, [first, second]);
  assert.equal(resolved.state.annulledDamage, 60);
  assert.equal(resolved.state.lastDamageAt, 219);
});

test("sequential packets use reduced health only from earlier allowed packets", () => {
  const actor = createActor({ resilience: 50, health: 1000, maxHealth: 1000 });
  const seenPriorHealthDamage = [];
  const first = {
    id: "allowed-first",
    resolveSequentialEstimate(sequence) {
      seenPriorHealthDamage.push(sequence.healthDamage);
      return {
        healthDamage: 600,
        health: { value: 1000, max: 1000 },
        nextSequence: { requests: [this], healthDamage: 600 }
      };
    }
  };
  const second = {
    id: "blocked-second",
    resolveSequentialEstimate(sequence) {
      seenPriorHealthDamage.push(sequence.healthDamage);
      return {
        healthDamage: 100,
        health: { value: 400, max: 1000 },
        nextSequence: { requests: [...sequence.requests, this], healthDamage: 700 }
      };
    }
  };
  const third = {
    id: "allowed-third",
    resolveSequentialEstimate(sequence) {
      seenPriorHealthDamage.push(sequence.healthDamage);
      return {
        healthDamage: 180,
        health: { value: 400, max: 1000 },
        nextSequence: { requests: [...sequence.requests, this], healthDamage: 780 }
      };
    }
  };

  const resolved = resolveLivingSteelFinalDamage({
    actor,
    applications: [first, second, third],
    worldTime: 100
  });

  assert.equal(calculateLivingSteelThreshold(actor, {}, {
    health: { value: 400, max: 1000 }
  }), 170);
  assert.deepEqual(seenPriorHealthDamage, [0, 600, 600]);
  assert.deepEqual(resolved.blockedApplications, [second]);
  assert.equal(resolved.state.annulledDamage, 100);
});

test("living steel creates one tracker and one persistent resilience effect, then updates the tracker", async () => {
  const actor = createLivingSteelActorFixture();
  const abilityItem = actor.items[0];
  const abilityFunction = abilityItem.system.functions[0];
  const zeroPacket = { id: "zero", healthDamage: 0 };

  const untouched = await applyLivingSteelFinalHealthDamage({
    actor,
    applications: [zeroPacket],
    worldTime: 90
  });
  assert.equal(untouched.touched, false);
  assert.equal(actor.effectWrites.creates.length, 0);
  assert.equal(actor.effectWrites.updates.length, 0);
  assert.equal(actor.effects.length, 0);

  const firstPacket = { id: "first", healthDamage: 40 };
  const first = await applyLivingSteelFinalHealthDamage({
    actor,
    applications: [firstPacket],
    worldTime: 100
  });
  assert.deepEqual(first.blockedApplications, [firstPacket]);
  assert.equal(actor.effectWrites.creates.length, 2);
  assert.equal(actor.effectWrites.updates.length, 0);
  assert.equal(actor.effects.length, 2);

  const created = findLivingSteelEffect(actor);
  const resilienceEffect = findLivingSteelResilienceEffect(actor);
  const createdState = created.flags[SYSTEM_ID][LIVING_STEEL_EFFECT_FLAG_KEY];
  assert.equal(created.name, "Живая сталь");
  assert.equal(created.showIcon, 2);
  assert.deepEqual(created.start, { time: 100 });
  assert.deepEqual(created.duration, {
    value: 60,
    units: "seconds",
    expiry: LIVING_STEEL_EXPIRY_EVENT,
    expired: false
  });
  assert.deepEqual(created.system, { changes: [] });
  assert.equal(createdState.annulledDamage, 40);
  assert.equal(createdState.lastDamageAt, 100);
  assert.equal(createdState.abilityItemId, "living-steel-item");
  assert.equal(createdState.functionId, "living-steel-function");
  assert.equal(resilienceEffect.name, "Живая сталь: Стойкость");
  assert.equal(resilienceEffect.showIcon, 0);
  assert.equal(resilienceEffect.start, null);
  assert.deepEqual(resilienceEffect.duration, {
    value: null,
    units: "seconds",
    expiry: null,
    expired: false
  });
  assert.deepEqual(resilienceEffect.system, { changes: [] });

  const secondPacket = { id: "second", healthDamage: 30 };
  const second = await applyLivingSteelFinalHealthDamage({
    actor,
    applications: [secondPacket],
    worldTime: 110
  });
  assert.deepEqual(second.blockedApplications, [secondPacket]);
  assert.equal(actor.effectWrites.creates.length, 2);
  assert.equal(actor.effectWrites.updates.length, 1);
  assert.equal(actor.effects.length, 2);
  assert.equal(findLivingSteelEffect(actor).flags[SYSTEM_ID][LIVING_STEEL_EFFECT_FLAG_KEY].annulledDamage, 70);
  assert.equal(findLivingSteelEffect(actor).flags[SYSTEM_ID][LIVING_STEEL_EFFECT_FLAG_KEY].lastDamageAt, 110);

  const writesBeforeTrailingZero = {
    creates: actor.effectWrites.creates.length,
    updates: actor.effectWrites.updates.length
  };
  await applyLivingSteelFinalHealthDamage({
    actor,
    applications: [zeroPacket],
    worldTime: 115
  });
  assert.deepEqual({
    creates: actor.effectWrites.creates.length,
    updates: actor.effectWrites.updates.length
  }, writesBeforeTrailingZero);

  assert.deepEqual(
    getLivingSteelAbilityProgressEntry(abilityItem, abilityFunction, { worldTime: 110 }),
    {
      key: "living-steel-function:livingSteel",
      label: "Аннулировано",
      value: "70 / 1000 · порог: урон < 100 · полная сила"
    }
  );
  assert.deepEqual(getLivingSteelEffectTooltipRows(findLivingSteelEffect(actor), actor, { worldTime: 110 }), [
    { label: "Аннулировано", value: "70 / 1000" },
    { label: "Порог", value: "урон < 100" },
    { label: "Режим", value: "полная сила" }
  ]);
});

test("the persistent effect applies the missing-health bonus independently of the tracker", async () => {
  const actor = createLivingSteelActorFixture({ resilience: 92, health: 10, maxHealth: 100 });
  await applyLivingSteelFinalHealthDamage({
    actor,
    applications: [{ healthDamage: 25 }],
    worldTime: 100
  });
  assert.deepEqual(findLivingSteelEffect(actor).system.changes, []);
  assert.deepEqual(findLivingSteelResilienceEffect(actor).system.changes, [{
    key: "system.skills.resilience.bonus",
    type: "add",
    value: "180",
    phase: "initial",
    priority: null
  }]);

  const weakenedActor = createLivingSteelActorFixture({ resilience: 92, health: 10, maxHealth: 100 });
  await applyLivingSteelFinalHealthDamage({
    actor: weakenedActor,
    applications: Array.from({ length: 4 }, () => ({ healthDamage: 250 })),
    worldTime: 100
  });
  assert.equal(
    findLivingSteelResilienceEffect(weakenedActor).system.changes[0].value,
    "44",
    "the displayed bonus switches to one +2 step per four missing-health percent while weakened"
  );
});

test("the resilience effect exists before any damage accumulation and has no expiry", async () => {
  const actor = createLivingSteelActorFixture({ resilience: 92, health: 10, maxHealth: 100 });
  const abilityItem = actor.items[0];

  await reconcileLivingSteelEffectsForAbilityItem(abilityItem);

  assert.equal(findLivingSteelEffect(actor), null);
  const resilienceEffect = findLivingSteelResilienceEffect(actor);
  assert.ok(resilienceEffect);
  assert.equal(resilienceEffect.showIcon, 0);
  assert.equal(resilienceEffect.duration.value, null);
  assert.equal(resilienceEffect.duration.expiry, null);
  assert.equal(resilienceEffect.system.changes[0].value, "180");
});

test("editing living steel settings reconciles only tracker metadata without overwriting progress", async () => {
  const actor = createLivingSteelActorFixture();
  const abilityItem = actor.items[0];
  await applyLivingSteelFinalHealthDamage({
    actor,
    applications: [{ healthDamage: 40 }],
    worldTime: 100
  });
  abilityItem.system.functions[0].fixedSettings = { resetAfterSeconds: 120 };
  await reconcileLivingSteelEffectsForAbilityItem(abilityItem);

  const update = actor.effectWrites.updates.at(-1);
  assert.equal(update["duration.value"], 120);
  assert.equal(update["duration.units"], "seconds");
  assert.equal(update["duration.expiry"], LIVING_STEEL_EXPIRY_EVENT);
  assert.equal(update["duration.expired"], false);
  assert.deepEqual(
    update[`flags.${SYSTEM_ID}.${LIVING_STEEL_EFFECT_FLAG_KEY}.settings`],
    normalizeLivingSteelSettings({ resetAfterSeconds: 120 })
  );
  assert.equal(Object.hasOwn(update, `flags.${SYSTEM_ID}.${LIVING_STEEL_EFFECT_FLAG_KEY}.annulledDamage`), false);
  assert.equal(Object.hasOwn(update, "start"), false);
});

test("split damage types are compared as one final-health weapon packet", async () => {
  const [damageHub, weaponController] = await Promise.all([
    readFile(new URL("../src/combat/damage-hub.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/combat/weapon-attack-controller.mjs", import.meta.url), "utf8")
  ]);

  const actor = createActor({ resilience: 100 });
  const groupedPacket = { packetId: "hit", healthDamage: 120, requests: [{}, {}] };
  assert.deepEqual(resolveLivingSteelFinalDamage({
    actor,
    applications: [groupedPacket],
    worldTime: 1
  }).blockedApplications, []);

  assert.match(damageHub, /function buildFinalHealthDamageApplications\(actor, requests = \[\]\)/);
  assert.match(damageHub, /source\.damagePacketId[\s\S]*?const packetId = explicitPacketId[\s\S]*?group\.requests\.push\(request\)/);
  assert.match(damageHub, /function createDamageBatchEstimateLedger\(actor\)[\s\S]*?function cloneDamageBatchEstimateLedger\(ledger\)[\s\S]*?function applyDamageEntriesToEstimateLedger\(actor, ledger, entries = \[\]\)/);
  assert.match(damageHub, /const finalHealthDamageApplications = buildFinalHealthDamageApplications\(actor, batchRequests\)/);
  assert.match(damageHub, /healthDamage: calculateFinalHealthDamageInterceptionAmount\(group\.requests, estimate\?\.healthDelta\)/);
  assert.match(damageHub, /application\.resolveSequentialEstimate = \(sequence = \{\}\) =>/);
  assert.match(damageHub, /const candidate = cloneDamageBatchEstimateLedger\(ledger\)[\s\S]*?applyDamageEntriesToEstimateLedger\(actor, candidate, group\.requests\)[\s\S]*?calculateFinalHealthDamageInterceptionAmount\(group\.requests, actualHealthDamage\)[\s\S]*?nextSequence: \{ ledger: candidate \}/);
  assert.match(damageHub, /health: getDamageBatchEstimateHealthSnapshot\(actor, ledger\)/);
  assert.match(damageHub, /!ledger\.brokenProsthesisLimbKeys\.has\(entry\.limbKey\)[\s\S]*?applyProsthesisDamageToEstimateLedger/);
  assert.match(damageHub, /!hasItemFunction\(prosthesis, ITEM_FUNCTIONS\.condition\)[\s\S]*?incrementalHealthDelta: 0/);
  assert.match(damageHub, /estimate\.next < estimate\.current && estimate\.next <= 0/);
  assert.match(damageHub, /function estimateEvenLimbDamageWithLedger\(actor, ledger[\s\S]*?target\.capacity - \(ledger\.prosthesisHealthDamage\.get\(target\.itemId\) \?\? 0\)/);
  assert.match(weaponController, /const damagePacketId = String\(source\.damagePacketId \?\? ""\)\.trim\(\)[\s\S]*?String\(source\.conditionWearPacketId \?\? ""\)\.trim\(\)[\s\S]*?foundry\.utils\.randomID\(\)/);
  assert.match(weaponController, /const requestSource = \{[\s\S]*?damagePacketId,[\s\S]*?conditionWearPacketId: String\(source\.conditionWearPacketId \?\? ""\)\.trim\(\) \|\| damagePacketId/);
  assert.match(weaponController, /source: requestSource/);
  assert.match(weaponController, /damagePacketId: conditionWearPacketId,[\s\S]*?conditionWearPacketId/);
});

test("region damage packets and post-interception batch metadata stay coherent", async () => {
  const damageHub = await readFile(new URL("../src/combat/damage-hub.mjs", import.meta.url), "utf8");
  const periodicStart = damageHub.indexOf("export async function requestRegionPeriodicDamage");
  const movementStart = damageHub.indexOf("export async function requestRegionMovementDamageBatch", periodicStart);
  const movementEnd = damageHub.indexOf("export async function requestFirstAidEffect", movementStart);
  const periodic = damageHub.slice(periodicStart, movementStart);
  const movement = damageHub.slice(movementStart, movementEnd);

  assert.ok(periodicStart >= 0 && movementStart > periodicStart && movementEnd > movementStart);
  assert.match(periodic, /const damagePacketId = String\(source\?\.damagePacketId \?\? ""\)\.trim\(\) \|\| foundry\.utils\.randomID\(\)/);
  assert.match(periodic, /source: \{ \.\.\.source, damagePacketId \}/);
  assert.match(movement, /for \(let triggerIndex = 0; triggerIndex < triggerCount; triggerIndex \+= 1\)/);
  assert.match(movement, /const damagePacketId = sourcePacketId[\s\S]*?`\$\{sourcePacketId\}:\$\{triggerIndex\}`[\s\S]*?foundry\.utils\.randomID\(\)/);
  assert.match(movement, /source: \{[\s\S]*?kind: "regionMovementDamage",[\s\S]*?damagePacketId,[\s\S]*?triggerIndex/);

  const batchStart = damageHub.indexOf("const initialBatchSource = selectBatchFinishingBlowSource(batchRequests)");
  const batchEnd = damageHub.indexOf("const applicationDeltaIndex = buildDamageApplicationDeltaIndex", batchStart);
  const batch = damageHub.slice(batchStart, batchEnd);
  const filter = batch.indexOf("batchRequests = batchRequests.filter(entry => allowedRequests.has(entry))");
  const sourceRecompute = batch.indexOf("batchSource = selectBatchFinishingBlowSource(batchRequests)?.source ?? initialBatchSource");
  const lethalPrevention = batch.indexOf("preventLethalDamageIfApplicable(actor, batchEstimate");

  assert.ok(batchStart >= 0 && batchEnd > batchStart);
  assert.ok(filter >= 0 && sourceRecompute > filter && lethalPrevention > sourceRecompute);
  assert.match(damageHub, /batchResult\.preventedAmount = Math\.max\(0, Number\(batchResult\.preventedAmount\) \|\| 0\)[\s\S]*?\+ finalHealthDamageInterception\.preventedHealthDamage/);
  assert.match(damageHub, /batchResult\.finalHealthDamagePrevented = finalHealthDamageInterception\.preventedHealthDamage/);
  assert.match(damageHub, /batchResult\.finalHealthDamagePreventions = finalHealthDamageInterception\.preventions/);
});

test("catch-up periodic damage preserves each logical tick as its own packet", async () => {
  const damageHub = await readFile(new URL("../src/combat/damage-hub.mjs", import.meta.url), "utf8");
  const periodicStart = damageHub.indexOf("function collectPeriodicDamageEffectTicks");
  const healingStart = damageHub.indexOf("function collectPeriodicHealingEffectTicks", periodicStart);
  const timedDamage = damageHub.slice(periodicStart, healingStart);

  assert.ok(periodicStart >= 0 && healingStart > periodicStart);
  assert.match(timedDamage, /tickTimes\.push\(nextTickTime\)/);
  assert.match(timedDamage, /tickTimes\.map\(\(worldTime, tickIndex\) =>/);
  assert.match(timedDamage, /amount: roundDamageAmount\(Number\(data\.amountPerTick\) \|\| 0\)/);
  assert.match(timedDamage, /damagePacketId: getTimedDamageTickPacketId\(effect, worldTime\)/);
  assert.match(timedDamage, /buildBleedingDamageTickRequests\(effect, data, startIndex, tickTimes\)/);
  assert.match(damageHub, /function combinePeriodicDamageEntries[\s\S]*?entry\.source\?\.damagePacketId[\s\S]*?entry\.source\?\.worldTime/);
});

test("living steel intercepts only after mitigation and immediately before health mutation", async () => {
  const damageHub = await readFile(new URL("../src/combat/damage-hub.mjs", import.meta.url), "utf8");
  const barrier = damageHub.indexOf("const effectiveAmount = barrierApplication.remaining");
  const estimate = damageHub.indexOf("estimateDirectDamageApplication(actor, finalRequest, damageType)", barrier);
  const intercept = damageHub.indexOf("applyFinalHealthDamageInterceptors(actor, [finalApplication]", estimate);
  const mutation = damageHub.indexOf("applyDirectDamageApplication(actor", intercept);

  assert.ok(barrier >= 0, "the post-barrier amount must exist");
  assert.ok(estimate > barrier, "final health loss must be estimated after barriers");
  assert.ok(intercept > estimate, "interception must use the estimated health loss");
  assert.ok(mutation > intercept, "interception must run before actor health mutation");
  assert.match(damageHub, /export function calculateFinalHealthDamageInterceptionAmount\(requests = \[\], actualHealthDamage = 0\)[\s\S]*?if \(actual <= 0\) return 0;[\s\S]*?request\?\.amount[\s\S]*?return Math\.max\(actual, incoming\)/);
  assert.match(damageHub, /healthDamage: calculateFinalHealthDamageInterceptionAmount\(\[finalRequest\], estimate\.healthDelta\)/);
});

test("living steel uses the native v14 ActiveEffect shape and standard token tooltip", async () => {
  const [livingSteel, token] = await Promise.all([
    readFile(new URL("../src/abilities/living-steel.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/canvas/token.mjs", import.meta.url), "utf8")
  ]);

  assert.match(livingSteel, /type: "base"/);
  assert.match(livingSteel, /showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS/);
  assert.match(livingSteel, /start: \{ time: worldTime \}/);
  assert.match(livingSteel, /const duration = \{[\s\S]*?value: context\.settings\.resetAfterSeconds,[\s\S]*?units: "seconds",[\s\S]*?expiry: LIVING_STEEL_EXPIRY_EVENT,[\s\S]*?expired: false[\s\S]*?\};/);
  assert.match(livingSteel, /CONFIG\.ActiveEffect\.expiryEvents\[LIVING_STEEL_EXPIRY_EVENT\]/);
  assert.match(livingSteel, /registerQueuedWorldTimeFinalizer\(expireInactiveLivingSteelEffects\)/);
  assert.match(livingSteel, /start: \{ time: worldTime \},[\s\S]*?duration,[\s\S]*?system: \{ changes: \[\] \}/);
  assert.match(livingSteel, /LIVING_STEEL_RESILIENCE_BONUS_KEY = "system\.skills\.resilience\.bonus"/);
  assert.match(livingSteel, /LIVING_STEEL_RESILIENCE_EFFECT_FLAG_KEY = "livingSteelResilience"/);
  assert.match(livingSteel, /const duration = \{[\s\S]*?value: null,[\s\S]*?expiry: null,[\s\S]*?\};/);
  assert.match(livingSteel, /name: LIVING_STEEL_RESILIENCE_EFFECT_NAME[\s\S]*?showIcon: ACTIVE_EFFECT_SHOW_ICON_NEVER,[\s\S]*?start: null,[\s\S]*?duration,/);
  assert.match(livingSteel, /actor\.createEmbeddedDocuments\("ActiveEffect", \[effectData\]/);
  assert.match(livingSteel, /effect\.update\(updateData/);
  assert.match(token, /getLivingSteelEffectTooltipRows\(effect, actor\)/);
  assert.match(token, /\.\.\.livingSteelRows/);
});

test("world-time finalizers always run after every queued processor", async () => {
  const previousHooks = globalThis.Hooks;
  const previousGame = globalThis.game;
  let updateWorldTimeHook = null;
  const order = [];
  const unregister = [];

  globalThis.Hooks = {
    on(event, handler) {
      if (event === "updateWorldTime") updateWorldTimeHook = handler;
    }
  };
  globalThis.game = {
    time: { worldTime: 250 },
    user: { id: "gm" },
    users: { activeGM: { id: "gm" } }
  };

  try {
    unregister.push(registerQueuedWorldTimeProcessor(async () => {
      order.push("high:start");
      await Promise.resolve();
      order.push("high:end");
    }, { priority: 100 }));
    unregister.push(registerQueuedWorldTimeFinalizer(async () => {
      order.push("finalizer");
    }));
    unregister.push(registerQueuedWorldTimeProcessor(async () => {
      order.push("late-low:start");
      await Promise.resolve();
      order.push("late-low:end");
    }, { priority: -100 }));

    assert.equal(typeof updateWorldTimeHook, "function");
    updateWorldTimeHook(250, 50, { falloutMawSystemTimeAdvance: true }, "gm");
    await waitForWorldTimeQueueIdle();

    assert.deepEqual(order, [
      "high:start",
      "high:end",
      "late-low:start",
      "late-low:end",
      "finalizer"
    ]);
  } finally {
    for (const release of unregister.reverse()) release();
    if (previousHooks === undefined) delete globalThis.Hooks;
    else globalThis.Hooks = previousHooks;
    if (previousGame === undefined) delete globalThis.game;
    else globalThis.game = previousGame;
  }
});

test("living steel progress and all settings are integrated into both ability editors", async () => {
  const [fixed, itemSheet, catalogEditor, itemTemplate, catalogTemplate] = await Promise.all([
    readFile(new URL("../src/abilities/fixed-functions.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/sheets/item-sheet.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/apps/ability-catalog-item-editor.mjs", import.meta.url), "utf8"),
    readFile(new URL("../templates/item/item-sheet.hbs", import.meta.url), "utf8"),
    readFile(new URL("../templates/settings/ability-catalog-item-editor.hbs", import.meta.url), "utf8")
  ]);

  assert.match(fixed, /key:\s*ABILITY_FIXED_FUNCTION_KEYS\.livingSteel[\s\S]*?label:\s*"Живая сталь"[\s\S]*?passive:\s*true/);
  assert.match(fixed, /getLivingSteelAbilityProgressEntry\(abilityItem, entry\)/);
  assert.match(itemSheet, /fixedLivingSteelSettings/);
  assert.match(catalogEditor, /fixedLivingSteelSettings/);

  const fields = [
    "annulledDamageLimit",
    "normalMissingHealthStepPercent",
    "weakenedMissingHealthStepPercent",
    "resilienceBonusPerStep",
    "weakenedResilienceDivisor",
    "weakenedDurationSeconds",
    "resetAfterSeconds"
  ];
  for (const source of [itemTemplate, catalogTemplate]) {
    assert.match(source, /fixedLivingSteelSettings/);
    for (const field of fields) assert.match(source, new RegExp(field));
  }
});

function createLivingSteelActorFixture(actorData = {}) {
  const actor = createActor({ resilience: 100, ...actorData });
  const effectWrites = { creates: [], updates: [] };
  let nextEffectId = 1;
  const abilityItem = {
    id: "living-steel-item",
    uuid: "Actor.test.Item.living-steel-item",
    type: "ability",
    name: "Живая сталь",
    img: "living-steel.webp",
    system: {
      functions: [{
        id: "living-steel-function",
        type: "fixed",
        fixedKey: ABILITY_FIXED_FUNCTION_KEYS.livingSteel,
        fixedSettings: {}
      }]
    },
    parent: actor
  };
  actor.uuid = "Actor.test";
  actor.img = "actor.webp";
  actor.items = [abilityItem];
  actor.effects = [];
  actor.effectWrites = effectWrites;
  actor.createEmbeddedDocuments = async (documentName, entries, options) => {
    assert.equal(documentName, "ActiveEffect");
    assert.deepEqual(options, { animate: false });
    const created = entries.map(entry => {
      effectWrites.creates.push(structuredClone(entry));
      return {
        id: `effect-${nextEffectId++}`,
        parent: actor,
        ...structuredClone(entry),
        getFlag(scope, key) {
          return this.flags?.[scope]?.[key];
        },
        async update(changes, updateOptions) {
          assert.deepEqual(updateOptions, { animate: false });
          effectWrites.updates.push(structuredClone(changes));
          Object.assign(this, structuredClone(changes));
          return this;
        }
      };
    });
    actor.effects.push(...created);
    return created;
  };
  actor.deleteEmbeddedDocuments = async (documentName, ids, options) => {
    assert.equal(documentName, "ActiveEffect");
    assert.deepEqual(options, { animate: false });
    const removed = actor.effects.filter(effect => ids.includes(effect.id));
    actor.effects = actor.effects.filter(effect => !ids.includes(effect.id));
    return removed;
  };
  return actor;
}
