import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  advanceVirtuosoCascadePeriodicState,
  createVirtuosoCascadeState,
  resolveVirtuosoAttackTransition
} from "../src/abilities/virtuoso.mjs";
import { normalizeVirtuosoSettings } from "../src/settings/abilities.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME = fs.readFileSync(path.join(ROOT, "src/abilities/virtuoso-runtime.mjs"), "utf8");

test("Virtuoso keeps the ordinary single weapon-change bonus by default", () => {
  assert.deepEqual(normalizeVirtuosoSettings({ accuracyBonus: 10, damagePercentBonus: 15 }), {
    accuracyBonus: 10,
    damagePercentBonus: 15,
    cascadeMaxStacks: 0,
    cascadeIntervalSeconds: 6
  });
  assert.equal(resolveVirtuosoAttackTransition({
    state: { weaponName: "Винтовка" },
    weaponName: "Пистолет"
  }).bonusMultiplier, 1);
  assert.equal(resolveVirtuosoAttackTransition({
    state: { weaponName: "Винтовка" },
    weaponName: "Винтовка"
  }).bonusMultiplier, 0);
});

test("Cascade starts at one and gains once for each elapsed six-second interval", () => {
  const start = createVirtuosoCascadeState({
    combatUuid: "Combat.1",
    worldTime: 100,
    cascadeMaxStacks: 4,
    cascadeIntervalSeconds: 6
  });
  assert.deepEqual(start, { combatUuid: "Combat.1", stacks: 1, nextGainAt: 106 });

  assert.deepEqual(advanceVirtuosoCascadePeriodicState(start, 105, {
    cascadeMaxStacks: 4,
    cascadeIntervalSeconds: 6
  }), { stacks: 1, nextGainAt: 106, elapsedIntervals: 0, gainedStacks: 0 });
  assert.deepEqual(advanceVirtuosoCascadePeriodicState(start, 118, {
    cascadeMaxStacks: 4,
    cascadeIntervalSeconds: 6
  }), { stacks: 4, nextGainAt: 124, elapsedIntervals: 3, gainedStacks: 3 });
});

test("Cascade first attack uses the starting stack and later weapon switches add stacks", () => {
  const combatState = createVirtuosoCascadeState({ combatUuid: "Combat.1", worldTime: 100 });
  const first = resolveVirtuosoAttackTransition({
    state: combatState,
    weaponName: "Пистолет",
    weaponAttackId: "Attack.1",
    combatUuid: "Combat.1",
    worldTime: 100,
    cascadeMaxStacks: 4
  });
  assert.equal(first.bonusMultiplier, 1);
  assert.equal(first.nextState.stacks, 1);

  const second = resolveVirtuosoAttackTransition({
    state: first.nextState,
    weaponName: "Винтовка",
    weaponAttackId: "Attack.2",
    combatUuid: "Combat.1",
    worldTime: 101,
    cascadeMaxStacks: 4
  });
  assert.equal(second.bonusMultiplier, 2);
  assert.equal(second.nextState.stacks, 2);

  const periodicAndSwitch = resolveVirtuosoAttackTransition({
    state: second.nextState,
    weaponName: "Дробовик",
    weaponAttackId: "Attack.3",
    combatUuid: "Combat.1",
    worldTime: 106,
    cascadeMaxStacks: 4
  });
  assert.equal(periodicAndSwitch.bonusMultiplier, 4);
  assert.equal(periodicAndSwitch.nextState.stacks, 4);
});

test("Cascade distinguishes actual weapon items instead of relying on their names", () => {
  const first = resolveVirtuosoAttackTransition({
    state: createVirtuosoCascadeState({ combatUuid: "Combat.1", worldTime: 100 }),
    weaponName: "Пистолет",
    weaponIdentity: "Item.1",
    combatUuid: "Combat.1",
    worldTime: 100,
    cascadeMaxStacks: 4
  });
  const second = resolveVirtuosoAttackTransition({
    state: first.nextState,
    weaponName: "Пистолет",
    weaponIdentity: "Item.2",
    combatUuid: "Combat.1",
    worldTime: 101,
    cascadeMaxStacks: 4
  });
  assert.equal(second.nextState.stacks, 2);

  const repeated = resolveVirtuosoAttackTransition({
    state: second.nextState,
    weaponName: "Переименованный пистолет",
    weaponIdentity: "Item.2",
    combatUuid: "Combat.1",
    worldTime: 102,
    cascadeMaxStacks: 4
  });
  assert.equal(repeated.nextState.stacks, 0);
});

test("Cascade resets on a repeated weapon and advances its fixed combat schedule", () => {
  const state = {
    weaponName: "Винтовка",
    weaponAttackId: "Attack.1",
    combatUuid: "Combat.1",
    stacks: 4,
    nextGainAt: 106
  };
  const sameAction = resolveVirtuosoAttackTransition({
    state,
    weaponName: "Винтовка",
    weaponAttackId: "Attack.1",
    combatUuid: "Combat.1",
    worldTime: 120,
    cascadeMaxStacks: 4
  });
  assert.equal(sameAction.nextState, null);

  const nextAction = resolveVirtuosoAttackTransition({
    state,
    weaponName: "Винтовка",
    weaponAttackId: "Attack.2",
    combatUuid: "Combat.1",
    worldTime: 120,
    cascadeMaxStacks: 4
  });
  assert.equal(nextAction.bonusMultiplier, 0);
  assert.equal(nextAction.nextState.stacks, 0);
  assert.equal(nextAction.nextState.nextGainAt, 124);
  assert.equal(advanceVirtuosoCascadePeriodicState(nextAction.nextState, 123).stacks, 0);
  assert.equal(advanceVirtuosoCascadePeriodicState(nextAction.nextState, 124).stacks, 1);
});

test("Cascade is inactive outside combat and another combat starts at one", () => {
  const state = { weaponName: "Винтовка", combatUuid: "Combat.1", stacks: 4, nextGainAt: 106 };
  const outsideCombat = resolveVirtuosoAttackTransition({
    state,
    weaponName: "Пистолет",
    cascadeMaxStacks: 4
  });
  assert.equal(outsideCombat.bonusMultiplier, 0);
  assert.equal(outsideCombat.reset, true);

  const nextCombat = resolveVirtuosoAttackTransition({
    state,
    weaponName: "Пистолет",
    combatUuid: "Combat.2",
    worldTime: 200,
    cascadeMaxStacks: 4
  });
  assert.equal(nextCombat.bonusMultiplier, 1);
  assert.equal(nextCombat.nextState.stacks, 1);
  assert.equal(nextCombat.nextState.combatUuid, "Combat.2");
  assert.equal(nextCombat.nextState.nextGainAt, 206);
});

test("Cascade runtime uses the shared world-time queue and combat lifecycle events", () => {
  assert.match(RUNTIME, /registerQueuedWorldTimeProcessor\(processVirtuosoCascadeWorldTime/);
  assert.match(RUNTIME, /fallout-maw\.combat\.started/);
  assert.match(RUNTIME, /fallout-maw\.combat\.ended/);
  assert.doesNotMatch(RUNTIME, /setInterval\s*\(/);
});
