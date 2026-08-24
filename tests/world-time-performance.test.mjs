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
