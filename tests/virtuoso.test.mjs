import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveVirtuosoAttackTransition } from "../src/abilities/virtuoso.mjs";
import { normalizeVirtuosoSettings } from "../src/settings/abilities.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RULES_SOURCE = fs.readFileSync(path.join(ROOT, "src/abilities/virtuoso.mjs"), "utf8");
const RUNTIME_SOURCE = fs.readFileSync(path.join(ROOT, "src/abilities/virtuoso-runtime.mjs"), "utf8");

test("Virtuoso grants one bonus when the weapon display name changes", () => {
  const settings = normalizeVirtuosoSettings({ accuracyBonus: 10, damagePercentBonus: 15 });
  assert.equal(settings.accuracyBonus, 10);
  assert.equal(settings.damagePercentBonus, 15);
  assert.deepEqual(resolveVirtuosoAttackTransition({
    state: { weaponName: "Винтовка" },
    weaponName: "Пистолет"
  }), {
    bonusMultiplier: 1,
    nextState: { weaponName: "Пистолет" },
    reset: false
  });
});

test("Virtuoso does not grant a bonus for the same name", () => {
  assert.deepEqual(resolveVirtuosoAttackTransition({
    state: { weaponName: "Винтовка" },
    weaponName: "Винтовка"
  }), {
    bonusMultiplier: 0,
    nextState: null,
    reset: false
  });
});

test("Virtuoso no longer owns Cascade state or combat runtime", () => {
  assert.doesNotMatch(RULES_SOURCE, /cascadeMaxStacks|nextGainAt|combatUuid|weaponIdentity/);
  assert.doesNotMatch(RUNTIME_SOURCE, /registerQueuedWorldTimeProcessor|combat\.started|combat\.ended/);
  assert.match(RUNTIME_SOURCE, /registerVirtuosoRuntime/);
});
