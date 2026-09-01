import test from "node:test";
import assert from "node:assert/strict";

import {
  HUNTER_RACE_EFFECT_FLAG_KEY,
  addHunterRaceWeaponModifiers,
  buildHunterRaceEffectData,
  getHunterRaceEffectData,
  getHunterRaceTargetRejectionReason,
  getHunterRaceWeaponModifiers,
  normalizeHunterRaceSettings
} from "../src/abilities/hunter-race.mjs";

const SYSTEM_ID = "fallout-maw";

test.beforeEach(() => {
  globalThis.game = {
    time: { worldTime: 100 },
    settings: { get: (_scope, key) => key === "factionMatrix" ? {} : [] }
  };
});

test.afterEach(() => {
  delete globalThis.game;
});

test("Hunter normalizes both evolution profiles without hidden modes", () => {
  assert.deepEqual(normalizeHunterRaceSettings({}), {
    energyCost: 20,
    overloadEnergyCost: 40,
    overloadDurationSeconds: 60,
    durationSeconds: 60,
    accuracyBonus: 10,
    damagePercentBonus: 5,
    criticalChanceBonus: 2
  });
  assert.deepEqual(normalizeHunterRaceSettings({
    accuracyBonus: 20,
    damagePercentBonus: 10,
    criticalChanceBonus: 4
  }), {
    energyCost: 20,
    overloadEnergyCost: 40,
    overloadDurationSeconds: 60,
    durationSeconds: 60,
    accuracyBonus: 20,
    damagePercentBonus: 10,
    criticalChanceBonus: 4
  });
});

test("Hunter effect stores stable source, function and race identity", () => {
  const actor = makeActor("Actor.hunter", "human", "A");
  const target = makeActor("Actor.target", "ghoul", "B");
  target.system.creature.raceName = "Гуль";
  const item = makeAbility(actor, "hunter-item", "hunter-function");
  const effectData = buildHunterRaceEffectData({
    actor,
    targetActor: target,
    abilityItem: item,
    abilityFunction: item.system.functions[0],
    settings: { accuracyBonus: 20, damagePercentBonus: 10, criticalChanceBonus: 4 },
    startTime: 500
  });

  const data = getHunterRaceEffectData(effectData);
  assert.equal(data.sourceActorUuid, actor.uuid);
  assert.equal(data.abilityItemId, item.id);
  assert.equal(data.functionId, "hunter-function");
  assert.equal(data.raceId, "ghoul");
  assert.equal(data.expiresAt, 560);
  assert.deepEqual(data.settings, normalizeHunterRaceSettings({
    accuracyBonus: 20,
    damagePercentBonus: 10,
    criticalChanceBonus: 4
  }));
});

test("Hunter applies bonuses only against the selected stable race", () => {
  const actor = makeActor("Actor.hunter", "human", "A");
  const ghoul = makeActor("Actor.ghoul", "ghoul", "B");
  const mutant = makeActor("Actor.mutant", "mutant", "B");
  const item = makeAbility(actor, "hunter-item", "hunter-function");
  const effectData = buildHunterRaceEffectData({
    actor,
    targetActor: ghoul,
    abilityItem: item,
    abilityFunction: item.system.functions[0],
    settings: { accuracyBonus: 20, damagePercentBonus: 10, criticalChanceBonus: 4 },
    startTime: 90
  });
  actor.effects = [makeEffect("hunter-effect", effectData)];

  assert.deepEqual(getHunterRaceWeaponModifiers(actor, ghoul), {
    accuracy: 20,
    damagePercent: 10,
    criticalChance: 4,
    sources: [{
      key: "hunter-race:hunter-effect:hunter-function",
      name: effectData.name,
      img: effectData.img,
      accuracy: 20,
      damagePercent: 10,
      criticalChance: 4
    }]
  });
  assert.deepEqual(getHunterRaceWeaponModifiers(actor, mutant), {
    accuracy: 0,
    damagePercent: 0,
    criticalChance: 0,
    sources: []
  });
});

test("Hunter registers target-dependent modifier resolvers before a target exists", () => {
  const actor = makeActor("Actor.hunter", "human", "A");
  const ghoul = makeActor("Actor.ghoul", "ghoul", "B");
  const item = makeAbility(actor, "hunter-item", "hunter-function");
  actor.effects = [makeEffect("hunter-effect", buildHunterRaceEffectData({
    actor,
    targetActor: ghoul,
    abilityItem: item,
    abilityFunction: item.system.functions[0],
    settings: { accuracyBonus: 20, damagePercentBonus: 10, criticalChanceBonus: 4 },
    startTime: 90
  }))];
  const resolvers = new Map();
  const modifierState = {
    addCombatValue(key, resolver) {
      resolvers.set(key, resolver);
    }
  };

  assert.equal(addHunterRaceWeaponModifiers(modifierState, actor), true);
  assert.equal(resolvers.get("accuracy")({ targetActor: ghoul }), 20);
  assert.equal(resolvers.get("damagePercent")({ targetActor: ghoul }), 10);
  assert.equal(resolvers.get("criticalChance")({ targetActor: ghoul }), 4);
});

test("Hunter target contract excludes allies and actors without a race", () => {
  const actor = makeActor("Actor.hunter", "human", "A");
  assert.match(getHunterRaceTargetRejectionReason(actor, actor), /Союзники/);
  const target = makeActor("Actor.target", "", "B");
  assert.match(getHunterRaceTargetRejectionReason(actor, target), /раса/);
  target.system.creature.raceId = "ghoul";
  assert.equal(getHunterRaceTargetRejectionReason(actor, target), "");
});

function makeActor(uuid, raceId, faction) {
  return {
    uuid,
    system: { creature: { raceId }, combat: {} },
    effects: [],
    getFlag(scope, key) {
      if (scope !== SYSTEM_ID) return null;
      if (key === "factionBelongs") return [faction];
      if (key === "factionRelations") return {};
      return null;
    }
  };
}

function makeAbility(actor, id, functionId) {
  return {
    id,
    uuid: `${actor.uuid}.Item.${id}`,
    name: "Охотник II",
    img: "icons/svg/target.svg",
    type: "ability",
    parent: actor,
    flags: { core: { sourceId: "Compendium.test.hunter" } },
    system: {
      functions: [{
        id: functionId,
        type: "fixed",
        fixedKey: "hunterRace",
        fixedSettings: {}
      }]
    }
  };
}

function makeEffect(id, data) {
  return {
    id,
    uuid: `Actor.hunter.ActiveEffect.${id}`,
    ...structuredClone(data),
    getFlag(scope, key) {
      return this.flags?.[scope]?.[key];
    }
  };
}
