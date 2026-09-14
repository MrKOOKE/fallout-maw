import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sources = Object.fromEntries(await Promise.all(
  [
    ["index", "../src/time/world-time-actor-index.mjs"],
    ["scope", "../src/time/world-time-actor-scope.mjs"],
    ["damage", "../src/combat/damage-hub.mjs"],
    ["needs", "../src/needs/need-thresholds.mjs"],
    ["regeneration", "../src/needs/regeneration.mjs"],
    ["energy", "../src/items/energy-consumption.mjs"],
    ["light", "../src/items/light-source.mjs"],
    ["effects", "../src/abilities/effects.mjs"],
    ["regions", "../src/canvas/periodic-damage-regions.mjs"],
    ["eventIndex", "../src/events/event-reaction-index.mjs"]
  ].map(async ([key, path]) => [key, await readFile(new URL(path, import.meta.url), "utf8")])
));

function functionBody(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} must exist before ${end}`);
  return source.slice(from, to);
}

test("world-time mechanics consume maintained candidate indexes instead of rescanning the Actor directory", () => {
  assert.doesNotMatch(sources.index, /game\.actors/);
  assert.doesNotMatch(sources.scope, /game\.actors\?\.contents|game\.actors\s*\?\?/);
  assert.match(sources.scope, /scene\?\.tokens\?\.contents/);
  assert.match(sources.scope, /resolveActorContainerPassengerActor/);
  assert.match(sources.scope, /resolveTravelGroupParticipants/);
  const valuesBody = functionBody(sources.index, "values() {", "function registerIndexHooks");
  assert.match(valuesBody, /await ensureActiveSceneScope\(\)/);
  assert.match(valuesBody, /refreshDirtyIndex\(index\)/);
  assert.doesNotMatch(sources.index, /Hooks\.on\("updateToken", invalidateActiveSceneTokenScope\)/);

  assert.match(sources.damage, /for \(const actor of await timedDamageActorIndex\.values\(\)\)/);
  assert.doesNotMatch(sources.damage, /function getLoadedActors\(\)/);
  assert.match(sources.needs, /for \(const actor of await collectNeedAccumulationActors\(\)\)/);
  assert.match(sources.needs, /for \(const actor of await diseaseActorIndex\.values\(\)\)/);
  assert.match(sources.regeneration, /for \(const actor of await regenerationActorIndex\.values\(\)\)/);
  assert.match(sources.energy, /for \(const actor of await energyConsumptionActorIndex\.values\(\)\)/);
});

test("world-time side paths retain the same active-Scene boundary", () => {
  const lightBody = functionBody(
    sources.light,
    "async function processLightSourceWorldTime",
    "async function processSceneLightSourceWorldTime"
  );
  assert.match(lightBody, /globalThis\.canvas\?\.scene/);
  assert.doesNotMatch(lightBody, /game\.scenes/);

  const regionDamageBody = functionBody(
    sources.damage,
    "async function processRegionPeriodicDamage",
    "async function collectRegionPeriodicDamageBehavior"
  );
  assert.match(regionDamageBody, /globalThis\.canvas\?\.scene/);
  assert.doesNotMatch(regionDamageBody, /game\.scenes/);

  const regionSyncBody = functionBody(
    sources.regions,
    "function onPeriodicDamageWorldTimeUpdate",
    "function onPeriodicDamageUserConnection"
  );
  assert.match(regionSyncBody, /globalThis\.canvas\?\.scene/);
  assert.doesNotMatch(regionSyncBody, /getPeriodicDamageScenes/);

  assert.match(sources.effects, /registerQueuedWorldTimeProcessor\(syncTimeOfDayConditionEffects/);
  assert.match(sources.effects, /await getActiveSceneWorldTimeActors\(\)/);
  assert.match(sources.eventIndex, /getReactors = \(\) => getActiveSceneWorldTimeActors\(\)/);
});

test("region damage ticks touch only the active Scene and preserve the damage batch", async () => {
  const body = functionBody(sources.damage,
    "async function processRegionPeriodicDamage", "async function collectRegionPeriodicDamageBehavior");
  const calls = [];
  const request = { actor: { uuid: "Actor.active" }, amount: 5 };
  const behavior = {
    type: "periodic",
    async setFlag(scope, key, state) { calls.push(["clock", state.nextTickTime]); }
  };
  const region = { behaviors: { contents: [behavior, { type: "unrelated" }, { ...behavior, disabled: true }] } };
  const scene = { regions: { contents: [region, { ...region, hidden: true }] } };
  const runtime = { canvas: { scene } };
  const environment = {
    globalThis: runtime,
    REGION_DAMAGE_BEHAVIOR_TYPE: "periodic",
    SYSTEM_ID: "fallout-maw", REGION_DAMAGE_FLAG_KEY: "periodicDamage",
    getPeriodicDamageScenes() { throw new Error("world-time ticks must not scan other Scenes"); },
    async collectRegionPeriodicDamageBehavior(actualRegion, actualBehavior, now, previousTime) {
      assert.equal(actualRegion, region);
      assert.equal(actualBehavior, behavior);
      assert.deepEqual([now, previousTime], [30, 24]);
      calls.push(["collect"]);
      return { region, behavior, system: {}, state: {}, dueTicks: 1, nextTickTime: 36, requests: [request] };
    },
    async updateRegionPeriodicDamageRadius() { calls.push(["radius"]); },
    async expireRegionPeriodicDamage() { throw new Error("this region has not expired"); },
    async spendDodgeForAreaDamageRequests(requests) {
      assert.deepEqual(requests, [request]);
      calls.push(["dodge"]);
    },
    async applyDamageCycleNow(requests) {
      assert.deepEqual(requests, [request]);
      calls.push(["damage"]);
    }
  };
  const run = new Function(...Object.keys(environment), `${body}; return processRegionPeriodicDamage;`)(...Object.values(environment));
  await run(30, 6);
  assert.deepEqual(calls, [["collect"], ["radius"], ["clock", 36], ["dodge"], ["damage"]]);
  runtime.canvas.scene = null;
  calls.length = 0;
  await run(36, 6);
  assert.deepEqual(calls, [], "no active Scene means no periodic region work");
});

test("empty time work exits before allocating per-Actor and per-Token operation queues", () => {
  const damageEntryBody = functionBody(
    sources.damage,
    "async function processTimedDamageEffects(worldTime",
    "async function processTimedDamageEffectsNow"
  );
  assert.ok(
    damageEntryBody.indexOf("if (!await hasTimedDamageWorldTimeWork()) return")
      < damageEntryBody.indexOf("runDamageHubOperation")
  );

  const damageBody = functionBody(
    sources.damage,
    "async function processTimedDamageEffectsNow",
    "async function processRegionPeriodicDamage"
  );
  assert.ok(
    damageBody.indexOf("timedDamageActorIndex.values()")
      < damageBody.indexOf("queueActorDamageMutation")
  );

  const lightBody = functionBody(
    sources.light,
    "async function processSceneLightSourceWorldTime",
    "async function processTokenLightSourceWorldTime"
  );
  assert.ok(
    lightBody.indexOf("getActiveLightSourceEntries(tokenDocument)")
      < lightBody.indexOf("runTokenLightSourceOperation")
  );
});
