import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/combat/damage-hub.mjs", import.meta.url), "utf8");
function between(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}

function fixture(now, { healingPerTick = 0 } = {}) {
  const writes = [];
  const catchUps = [];
  globalThis.game = { user: { isActiveGM: true }, time: { worldTime: now } };
  const actor = {
    uuid: "Actor.patient",
    async createEmbeddedDocuments(type, data) {
      writes.push(...data);
      return data.map(record => ({
        id: "withdrawal", uuid: "Actor.patient.ActiveEffect.withdrawal", parent: actor,
        duration: { ...record.duration, remaining: record.duration.startTime + record.duration.seconds - now },
        getFlag: (scope, key) => record.flags[scope]?.[key]
      }));
    }
  };
  const payload = {
    itemName: "Бодрин", durationSeconds: 1500, intervalSeconds: 6, healingPerTick,
    changes: [{ key: "system.characteristics.strength", value: "-1" }],
    source: { kind: "firstAid", worldTime: 100 }
  };
  const effect = {
    parent: actor, start: { time: 100 }, duration: { seconds: 12 },
    getFlag: (scope, key) => key === "firstAidWithdrawal" ? payload : { startTime: 100, endTime: 112 }
  };
  const environment = {
    TRAUMA_FLAG_SCOPE: "fallout-maw", DAMAGE_EFFECT_FLAG_KEY: "damageEffect", FIRST_AID_WITHDRAWAL_PAYLOAD_FLAG_KEY: "firstAidWithdrawal",
    FIRST_AID_WITHDRAWAL_EFFECT_KIND: "firstAidWithdrawal", MANAGED_TIMED_DAMAGE_FLAG_KEY: "managedTimedDamage", MANAGED_TIMED_DAMAGE_EXPIRY: "managed", ACTIVE_EFFECT_SHOW_ICON_ALWAYS: 2,
    normalizeFirstAidWithdrawalRequest: request => ({ ...payload, ...request }),
    getDamageActiveEffectOperationOptions: () => ({ animate: false }),
    debugTemporaryEffects: () => {}, debugEffectState: () => ({}),
    runDamageHubOperation: operation => operation(),
    processActorTimedDamageEffects: async (...args) => catchUps.push(args),
    publishDamageSummaryMessage: async () => {}, notifyDamageApplied: async () => {},
    hasTimedEffectReachedEnd: (effect, data, clock) => clock >= data.endTime,
    getTimeMechanicsIgnored: () => false
  };
  const functions = between("async function createFirstAidWithdrawalEffect(", "function normalizeFirstAidEffectRequest(")
    + between("async function applyStoredFirstAidWithdrawalOnDelete(", "function normalizeNeedChangesRequest(");
  const { apply, create } = new Function(...Object.keys(environment), `${functions}; return { apply: applyStoredFirstAidWithdrawalOnDelete, create: createFirstAidWithdrawalEffect };`)(...Object.values(environment));
  return { apply, create, actor, effect, payload, writes, catchUps };
}

test("one large time advance does not create a withdrawal whose whole duration has passed", async () => {
  const { apply, effect, writes, catchUps } = fixture(3700);
  await apply(effect);
  assert.equal(writes.length, 0);
  assert.equal(catchUps.length, 0);
});

test("withdrawal begins when the main effect ends and keeps the remaining duration", async () => {
  const { apply, effect, payload, writes } = fixture(113);
  await apply(effect);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].duration.startTime, 112);
  assert.equal(writes[0].flags['fallout-maw'].damageEffect.endTime, 1612);
  assert.equal(payload.source.worldTime, 100);
});

test("early manual removal starts withdrawal at the current clock", async () => {
  const { apply, effect, writes } = fixture(106);
  await apply(effect);
  assert.equal(writes[0].duration.startTime, 106);
});

test("overdue periodic withdrawal is processed at the same clock without advancing time", async () => {
  const { apply, effect, actor, writes, catchUps } = fixture(3700, { healingPerTick: 2 });
  await apply(effect);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].duration.startTime, 112);
  assert.equal(catchUps.length, 1);
  assert.equal(catchUps[0][0], actor);
  assert.equal(catchUps[0][1], 3700);
  assert.equal(catchUps[0][2], 0);
  assert.equal(game.time.worldTime, 3700);
});

test("a still-active withdrawal is kept without a catch-up pass", async () => {
  const { apply, effect, writes, catchUps } = fixture(113, { healingPerTick: 2 });
  await apply(effect);
  assert.equal(writes.length, 1);
  assert.equal(catchUps.length, 0);
});

test("the native v14 start time is used if a legacy main effect has no stored end", async () => {
  const { apply, effect, writes } = fixture(113);
  const getFlag = effect.getFlag;
  effect.getFlag = (scope, key) => key === "damageEffect" ? {} : getFlag(scope, key);
  await apply(effect);
  assert.equal(writes[0].duration.startTime, 112);
});
