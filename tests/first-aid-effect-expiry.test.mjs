import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const damageHubSource = fs.readFileSync(
  new URL("../src/combat/damage-hub.mjs", import.meta.url),
  "utf8"
);
const mainSource = fs.readFileSync(
  new URL("../src/main.mjs", import.meta.url),
  "utf8"
);

function sourceBetween(start, end) {
  const startIndex = damageHubSource.indexOf(start);
  const endIndex = damageHubSource.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `Missing source marker: ${end}`);
  return damageHubSource.slice(startIndex, endIndex);
}

test("new first-aid and withdrawal effects use Foundry's custom expiry event", () => {
  for (const block of [
    sourceBetween("async function createFirstAidEffect", "async function createFirstAidWithdrawalEffect"),
    sourceBetween("async function createFirstAidWithdrawalEffect", "function normalizeFirstAidEffectRequest")
  ]) {
    assert.match(block, /\[MANAGED_TIMED_DAMAGE_FLAG_KEY\]: true/);
    assert.match(block, /expiry: MANAGED_TIMED_DAMAGE_EXPIRY/);
  }
});

test("an expiring healing effect is never updated after reaching its end", () => {
  const collector = sourceBetween(
    "function collectPeriodicHealingEffectTicks",
    "function collectFirstAidTemporaryEffectTicks"
  );
  assert.match(collector, /update: !reachedEnd && dueTicks > 0/);
  assert.match(collector, /refreshExpiry: reachedEnd && usesManagedExpiry/);
});

test("final first-aid work completes before Foundry's registry performs deletion", () => {
  const processor = sourceBetween(
    "async function processTimedDamageEffectsNow",
    "async function processRegionPeriodicDamage"
  );
  const healingIndex = processor.indexOf("await executeDamageSystemEventWorkflow");
  const expiryIndex = processor.indexOf("await refreshManagedTimedEffectExpiration");
  assert.ok(healingIndex >= 0);
  assert.ok(expiryIndex > healingIndex);

  const refresh = sourceBetween(
    "async function refreshManagedTimedEffectExpiration",
    "async function updatePeriodicEffect"
  );
  assert.match(refresh, /ActiveEffectClass\.registry\.refresh\(MANAGED_TIMED_DAMAGE_EXPIRY/);
});

test("first-aid expiry does not install a ready-time actor migration", () => {
  assert.doesNotMatch(damageHubSource, /migrateWorldFirstAidTimedEffects/);
  assert.doesNotMatch(mainSource, /migrateWorldFirstAidTimedEffects/);
});
