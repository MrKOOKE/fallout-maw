import assert from "node:assert/strict";
import test from "node:test";

globalThis.foundry = {
  applications: {
    api: { DialogV2: {} },
    ux: { FormDataExtended: class {} },
    handlebars: { renderTemplate: async () => "" }
  },
  utils: {
    deepClone: value => structuredClone(value),
    randomID: () => "generated-id"
  }
};

const {
  ABILITY_FIXED_FUNCTION_KEYS,
  ABILITY_FUNCTION_TYPES,
  normalizeAnatomyStudySettings
} = await import("../src/settings/abilities.mjs");
const {
  ANATOMY_STUDY_BONUS_KEYS,
  buildAnatomyStudyKnowledgeUpdate,
  getActorAnatomyStudyBonus,
  getActorAnatomyStudyRaceBonuses,
  getAnatomyStudyAvailableBonusKeys,
  getAnatomyStudyFunctionState,
  getAnatomyStudyMemoryCapacity,
  getAnatomyStudyMemoryUsage,
  normalizeAnatomyStudyKnowledge
} = await import("../src/abilities/anatomy-study.mjs");

test("anatomy study settings preserve the requested defaults", () => {
  assert.deepEqual(normalizeAnatomyStudySettings(), {
    energyCost: 10,
    actionPointCost: 3,
    overloadEnergyCost: 100,
    overloadDurationSeconds: 6 * 60 * 60,
    memoryFormula: "10+doctor/10",
    damagePercentBonus: 10,
    accuracyBonus: 20,
    criticalChanceBonus: 3,
    criticalDamagePercentBonus: 20,
    drugEffectivenessPercentBonus: 15,
    treatmentEffectivenessPercentBonus: 15
  });
});

test("anatomy study knowledge is normalized, unique, and counts one slot per bonus", () => {
  const knowledge = normalizeAnatomyStudyKnowledge({
    races: {
      human: {
        bonuses: {
          damage: true,
          accuracy: true,
          unsupported: true
        }
      },
      empty: { bonuses: [] }
    }
  });

  assert.deepEqual(knowledge.races, [{ raceId: "human", bonuses: ["damage", "accuracy"] }]);
  assert.equal(getAnatomyStudyMemoryUsage(knowledge), 2);
  assert.equal(getAnatomyStudyAvailableBonusKeys(knowledge, "human").length, 4);
});

test("anatomy study updates enforce capacity and support forgetting knowledge", () => {
  const fixture = createAnatomyStudyFixture({ memoryFormula: "2" });
  assert.equal(getAnatomyStudyMemoryCapacity(fixture.actor, fixture.abilityFunction.fixedSettings), 2);

  const damage = applyKnowledgeUpdate(fixture, {
    raceId: "robot",
    bonusKey: ANATOMY_STUDY_BONUS_KEYS.damage
  });
  assert.equal(damage.ok, true);

  const accuracy = applyKnowledgeUpdate(fixture, {
    raceId: "robot",
    bonusKey: ANATOMY_STUDY_BONUS_KEYS.accuracy
  });
  assert.equal(accuracy.ok, true);
  assert.equal(getAnatomyStudyMemoryUsage(getAnatomyStudyFunctionState(fixture.abilityItem, fixture.abilityFunction)), 2);

  const duplicate = applyKnowledgeUpdate(fixture, {
    raceId: "robot",
    bonusKey: ANATOMY_STUDY_BONUS_KEYS.damage
  });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.reason, /уже изучено/iu);

  const overflow = applyKnowledgeUpdate(fixture, {
    raceId: "mutant",
    bonusKey: ANATOMY_STUDY_BONUS_KEYS.criticalChance
  });
  assert.equal(overflow.ok, false);
  assert.match(overflow.reason, /память заполнена/iu);

  const forgotten = applyKnowledgeUpdate(fixture, {
    raceId: "robot",
    bonusKey: ANATOMY_STUDY_BONUS_KEYS.damage,
    remove: true
  });
  assert.equal(forgotten.ok, true);

  const replacement = applyKnowledgeUpdate(fixture, {
    raceId: "mutant",
    bonusKey: ANATOMY_STUDY_BONUS_KEYS.criticalChance
  });
  assert.equal(replacement.ok, true);
});

test("anatomy study bonuses apply only to a target of the learned race", () => {
  const fixture = createAnatomyStudyFixture({ memoryFormula: "6" });
  applyKnowledgeUpdate(fixture, {
    raceId: "robot",
    bonusKey: ANATOMY_STUDY_BONUS_KEYS.accuracy
  });
  applyKnowledgeUpdate(fixture, {
    raceId: "robot",
    bonusKey: ANATOMY_STUDY_BONUS_KEYS.drugEffectiveness
  });

  const bonusesByRace = getActorAnatomyStudyRaceBonuses(fixture.actor);
  assert.equal(bonusesByRace.get("robot")?.accuracy, 20);
  assert.equal(bonusesByRace.get("robot")?.drugEffectiveness, 15);
  assert.equal(
    getActorAnatomyStudyBonus(
      fixture.actor,
      { system: { creature: { raceId: "robot" } } },
      ANATOMY_STUDY_BONUS_KEYS.accuracy
    ),
    20
  );
  assert.equal(
    getActorAnatomyStudyBonus(
      fixture.actor,
      { system: { creature: { raceId: "human" } } },
      ANATOMY_STUDY_BONUS_KEYS.accuracy
    ),
    0
  );
});

function createAnatomyStudyFixture(settings = {}) {
  const abilityFunction = {
    id: "anatomy-function",
    type: ABILITY_FUNCTION_TYPES.fixed,
    fixedKey: ABILITY_FIXED_FUNCTION_KEYS.anatomyStudy,
    fixedSettings: normalizeAnatomyStudySettings(settings),
    changes: [],
    conditions: [],
    penalties: []
  };
  let storedState = {};
  const actor = {
    uuid: "Actor.researcher",
    system: { creature: { raceId: "human" } },
    items: []
  };
  const abilityItem = {
    id: "anatomy-ability",
    type: "ability",
    parent: actor,
    system: { functions: [abilityFunction] },
    getFlag: () => storedState
  };
  actor.items.push(abilityItem);
  return {
    actor,
    abilityItem,
    abilityFunction,
    setStoredState: value => { storedState = value; }
  };
}

function applyKnowledgeUpdate(fixture, options = {}) {
  const result = buildAnatomyStudyKnowledgeUpdate({
    actor: fixture.actor,
    abilityItem: fixture.abilityItem,
    abilityFunction: fixture.abilityFunction,
    ...options
  });
  if (result.ok) fixture.setStoredState(result.state);
  return result;
}
