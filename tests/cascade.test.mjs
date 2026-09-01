import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  advanceCascadePeriodicState,
  commitCascadeAttackSnapshot,
  createCascadeAttackSnapshot,
  createCascadeCombatState,
  normalizeCascadeSettings
} from "../src/abilities/cascade.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME_SOURCE = fs.readFileSync(path.join(ROOT, "src/abilities/cascade-runtime.mjs"), "utf8");

test("Cascade settings normalize legacy Virtuoso field names", () => {
  assert.deepEqual(normalizeCascadeSettings({
    accuracyBonus: 25,
    damagePercentBonus: 15,
    cascadeMaxStacks: 4,
    cascadeIntervalSeconds: 6
  }), {
    accuracyPerStack: 25,
    damagePercentPerStack: 15,
    maxStacks: 4,
    initialStacks: 1,
    periodicGain: 1,
    periodicIntervalSeconds: 6,
    weaponSwitchGain: 1,
    resetOnRepeatedWeapon: true
  });
});

test("Cascade starts at one and folds elapsed six-second gains lazily", () => {
  const start = createCascadeCombatState({
    combatUuid: "Combat.1",
    worldTime: 100,
    maxStacks: 4,
    intervalSeconds: 6
  });
  assert.deepEqual(start, { combatUuid: "Combat.1", stacks: 1, nextGainAt: 106 });
  assert.deepEqual(advanceCascadePeriodicState(start, 105, {
    maxStacks: 4,
    intervalSeconds: 6
  }), { stacks: 1, nextGainAt: 106, elapsedIntervals: 0, gainedStacks: 0 });
  assert.deepEqual(advanceCascadePeriodicState(start, 118, {
    maxStacks: 4,
    intervalSeconds: 6
  }), { stacks: 4, nextGainAt: 124, elapsedIntervals: 3, gainedStacks: 3 });
});

test("Cascade switches by displayed weapon name and snapshots the entire attack cycle", () => {
  const start = createCascadeCombatState({ combatUuid: "Combat.1", worldTime: 100 });
  const first = createCascadeAttackSnapshot({
    state: start,
    weaponIdentity: "10-мм пистолет",
    attackId: "Attack.1",
    combatUuid: "Combat.1",
    worldTime: 100
  });
  assert.equal(first.bonusMultiplier, 1);
  assert.equal(first.nextState.stacks, 1);

  const firstCommit = commitCascadeAttackSnapshot(start, first);
  assert.equal(firstCommit.changed, true);
  const switched = createCascadeAttackSnapshot({
    state: firstCommit.nextState,
    weaponIdentity: "Лазерный пистолет",
    attackId: "Attack.2",
    combatUuid: "Combat.1",
    worldTime: 101
  });
  assert.equal(switched.switchedWeapon, true);
  assert.equal(switched.bonusMultiplier, 2);
  assert.equal(switched.nextState.stacks, 2);

  // The authored rule treats equal displayed names as the same weapon.
  assert.notEqual(first.weaponIdentity, switched.weaponIdentity);
});

test("Cascade repeat resets only when the aggregate snapshot is committed", () => {
  const stored = {
    combatUuid: "Combat.1",
    weaponIdentity: "Охотничья винтовка",
    lastAttackId: "Attack.1",
    stacks: 4,
    nextGainAt: 106
  };
  const snapshot = createCascadeAttackSnapshot({
    state: stored,
    weaponIdentity: "Охотничья винтовка",
    attackId: "Attack.2",
    combatUuid: "Combat.1",
    worldTime: 120
  });
  assert.equal(snapshot.bonusMultiplier, 0);
  assert.equal(snapshot.nextState.stacks, 0);
  assert.equal(snapshot.nextState.nextGainAt, 124);
  assert.equal(stored.stacks, 4);

  const committed = commitCascadeAttackSnapshot(stored, snapshot);
  assert.equal(committed.changed, true);
  assert.equal(committed.nextState.stacks, 0);
  assert.equal(advanceCascadePeriodicState(committed.nextState, 123).stacks, 0);
  assert.equal(advanceCascadePeriodicState(committed.nextState, 124).stacks, 1);
});

test("Cascade aggregate commit is idempotent by attack id", () => {
  const stored = createCascadeCombatState({ combatUuid: "Combat.1", worldTime: 100 });
  const snapshot = createCascadeAttackSnapshot({
    state: stored,
    weaponIdentity: "Охотничья винтовка",
    attackId: "Attack.1",
    combatUuid: "Combat.1",
    worldTime: 100
  });
  const first = commitCascadeAttackSnapshot(stored, snapshot);
  assert.equal(first.changed, true);
  const duplicate = commitCascadeAttackSnapshot(first.nextState, snapshot);
  assert.equal(duplicate.changed, false);
  assert.equal(duplicate.nextState, first.nextState);
});

test("Cascade is inactive outside combat and a new combat starts at one", () => {
  const state = {
    combatUuid: "Combat.1",
    weaponIdentity: "Охотничья винтовка",
    stacks: 4,
    nextGainAt: 106
  };
  const outsideCombat = createCascadeAttackSnapshot({
    state,
    weaponIdentity: "10-мм пистолет"
  });
  assert.equal(outsideCombat.active, false);
  assert.equal(outsideCombat.bonusMultiplier, 0);

  const nextCombat = createCascadeAttackSnapshot({
    state,
    weaponIdentity: "10-мм пистолет",
    attackId: "Attack.2",
    combatUuid: "Combat.2",
    worldTime: 200
  });
  assert.equal(nextCombat.bonusMultiplier, 1);
  assert.equal(nextCombat.nextState.stacks, 1);
  assert.equal(nextCombat.nextState.combatUuid, "Combat.2");
  assert.equal(nextCombat.nextState.nextGainAt, 206);
  const committed = commitCascadeAttackSnapshot(state, nextCombat);
  assert.equal(committed.changed, true);
  assert.equal(committed.nextState.combatUuid, "Combat.2");
});

test("Cascade runtime has no periodic document-write path", () => {
  assert.match(RUNTIME_SOURCE, /fallout-maw\.combat\.started/);
  assert.match(RUNTIME_SOURCE, /fallout-maw\.combat\.ended/);
  assert.match(RUNTIME_SOURCE, /attackCheckAggregate/);
  assert.match(RUNTIME_SOURCE, /getOrCreateCascadeAttackSnapshot/);
  assert.doesNotMatch(RUNTIME_SOURCE, /registerQueuedWorldTimeProcessor|setInterval\s*\(/);
  assert.doesNotMatch(RUNTIME_SOURCE, /weaponAttackCheckResolved/);
});
