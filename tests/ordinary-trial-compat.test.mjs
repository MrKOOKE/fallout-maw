import assert from "node:assert/strict";
import test from "node:test";

let generatedId = 0;
globalThis.foundry = {
  applications: {
    api: { DialogV2: class {} },
    ux: { FormDataExtended: class {} },
    handlebars: { renderTemplate: async () => "" }
  },
  utils: {
    randomID: () => `generated-${++generatedId}`,
    deepClone: value => structuredClone(value)
  }
};

const {
  ABILITY_CONDITION_TYPES,
  normalizeAbilityCondition,
  normalizeAbilityConstruct,
  normalizeAbilityFunctions
} = await import("../src/settings/abilities.mjs");
const {
  migrateAbilityDamageConstructs,
  migrateAbilityTrialBranches,
  migrateItemData
} = await import("../src/migrations/documents.mjs");

test("Item source migration preserves additional weapon proficiencies", () => {
  const source = {
    type: "gear",
    system: {
      functions: {
        weapon: {
          enabled: true,
          specialProperties: [{
            type: "additionalProficiencies",
            proficiencyKeys: ["rifle", "pistol"]
          }]
        }
      }
    }
  };

  migrateItemData(source);

  assert.deepEqual(source.system.functions.weapon.specialProperties, [{
    type: "additionalProficiencies",
    proficiencyKeys: ["rifle", "pistol"]
  }]);
});

function legacyTrial(id = "trial") {
  return {
    id,
    type: "trial",
    trialResultKeys: ["criticalFailure", "failure"],
    trialLinks: [{
      id: "link",
      constructId: "construct",
      recipient: "source",
      mode: "once"
    }]
  };
}

test("Item source migration converts one legacy accepted set into one exact branch", () => {
  const source = {
    type: "ability",
    system: {
      functions: [{
        id: "function",
        conditions: [legacyTrial("legacy")]
      }]
    }
  };
  migrateAbilityTrialBranches(source);

  const migrated = source.system.functions[0].conditions[0];
  assert.deepEqual(migrated.trialBranches, [{
    id: "legacy-legacy-branch",
    name: "Подходящий результат",
    resultKeys: ["criticalFailure", "failure"],
    flow: "continue",
    links: [{
      id: "link",
      kind: "construct",
      constructId: "construct",
      percentFormula: "100",
      durationPercentFormula: "100",
      recipient: "source",
      mode: "once"
    }]
  }]);
  assert.equal(Object.hasOwn(migrated, "trialResultKeys"), false);
  assert.equal(Object.hasOwn(migrated, "trialLinks"), false);
});

test("Item source migration covers gear free-settings functions and ignores partial updates", () => {
  const source = {
    type: "gear",
    system: {
      functions: {
        freeSettings: {
          entries: [{
            conditions: [legacyTrial("gear-trial")]
          }]
        }
      }
    }
  };
  const untouched = structuredClone(source);
  migrateAbilityTrialBranches(untouched, { partial: true });
  assert.equal(Object.hasOwn(
    untouched.system.functions.freeSettings.entries[0].conditions[0],
    "trialBranches"
  ), false);

  migrateAbilityTrialBranches(source);
  assert.equal(
    source.system.functions.freeSettings.entries[0].conditions[0].trialBranches[0].id,
    "gear-trial-legacy-branch"
  );
});

test("an explicitly empty canonical branch list never resurrects stale legacy outcomes", () => {
  const condition = {
    ...legacyTrial("canonical"),
    trialBranches: []
  };
  const source = {
    type: "ability",
    system: { functions: [{ conditions: [condition] }] }
  };
  migrateAbilityTrialBranches(source);
  assert.deepEqual(condition.trialBranches, []);
  assert.equal(Object.hasOwn(condition, "trialResultKeys"), false);
  assert.equal(Object.hasOwn(condition, "trialLinks"), false);

  const normalized = normalizeAbilityCondition({
    ...legacyTrial("normalized"),
    trialBranches: []
  });
  assert.deepEqual(normalized.trialBranches, []);
});

test("canonical branch normalization keeps ids and assigns overlapping results first-wins", () => {
  const condition = normalizeAbilityCondition({
    id: "canonical",
    type: ABILITY_CONDITION_TYPES.trial,
    trialBranches: [{
      id: "first",
      name: "Первая",
      resultKeys: ["failure", "success"],
      flow: "stopSubject",
      links: []
    }, {
      id: "second",
      name: "Вторая",
      resultKeys: ["success", "criticalSuccess"],
      flow: "stopAll",
      links: []
    }]
  });

  assert.deepEqual(condition.trialBranches.map(branch => branch.id), ["first", "second"]);
  assert.deepEqual(condition.trialBranches[0].resultKeys, ["failure", "success"]);
  assert.deepEqual(condition.trialBranches[1].resultKeys, ["criticalSuccess"]);
  assert.deepEqual(condition.trialBranches.map(branch => branch.flow), ["stopSubject", "stopAll"]);
});

test("new ordinary Trials start with four independently editable result branches", () => {
  const condition = normalizeAbilityCondition({
    id: "new-trial",
    type: ABILITY_CONDITION_TYPES.trial
  });
  assert.deepEqual(
    condition.trialBranches.map(branch => branch.resultKeys),
    [["criticalFailure"], ["failure"], ["success"], ["criticalSuccess"]]
  );
  assert.equal(new Set(condition.trialBranches.map(branch => branch.id)).size, 4);
});

test("an old single empty failure branch is linked to primary changes exactly once", () => {
  const [abilityFunction] = normalizeAbilityFunctions([{
    id: "impulse",
    type: "activeApplication",
    changes: [{
      id: "dodge",
      key: "system.resources.dodge.bonus",
      type: "add",
      value: "-30"
    }],
    conditions: [{
      id: "impulse-trial",
      type: "trial",
      trialBranches: [{
        id: "failure",
        name: "Ветка 1",
        resultKeys: ["criticalFailure", "failure"],
        flow: "continue",
        links: []
      }]
    }]
  }]);
  const condition = abilityFunction.conditions[0];
  assert.equal(condition.trialRoutesPrimaryChanges, true);
  assert.equal(condition.trialBranches[0].links.length, 1);
  assert.equal(condition.trialBranches[0].links[0].kind, "primaryChanges");

  condition.trialBranches[0].links = [];
  const [renormalized] = normalizeAbilityFunctions([abilityFunction]);
  assert.equal(renormalized.conditions[0].trialRoutesPrimaryChanges, true);
  assert.deepEqual(renormalized.conditions[0].trialBranches[0].links, []);
});

test("an orphaned legacy consequence is repaired but a new pending selector remains pending", () => {
  const makeFunction = link => ({
    id: "impulse",
    type: "activeApplication",
    changes: [{
      id: "dodge",
      key: "system.resources.dodge.bonus",
      type: "add",
      value: "-30"
    }],
    conditions: [{
      id: "impulse-trial",
      type: "trial",
      trialRoutesPrimaryChanges: false,
      trialBranches: [{
        id: "failure",
        name: "Ветка 1",
        resultKeys: ["criticalFailure", "failure"],
        flow: "continue",
        links: [link]
      }]
    }]
  });

  const [repaired] = normalizeAbilityFunctions([makeFunction({
    id: "broken",
    kind: "construct",
    constructId: ""
  })]);
  assert.equal(repaired.conditions[0].trialRoutesPrimaryChanges, true);
  assert.equal(repaired.conditions[0].trialBranches[0].links[0].kind, "primaryChanges");

  const [pending] = normalizeAbilityFunctions([makeFunction({
    id: "pending",
    kind: "",
    constructId: ""
  })]);
  assert.equal(pending.conditions[0].trialBranches[0].links[0].kind, "");
});

test("legacy flat damage constructs retain formula, damage type and key-limb policy", () => {
  const source = {
    type: "ability",
    system: {
      constructs: [{
        id: "fire",
        type: "damage",
        damageFormula: "50+energy/3",
        damageTypeKey: "fire",
        damageLimbMode: "critical"
      }]
    }
  };
  migrateAbilityDamageConstructs(source);
  assert.deepEqual(source.system.constructs[0].damage, {
    amountMode: "formula",
    formula: "50+energy/3",
    damageTypeKey: "fire",
    limbMode: "randomCritical"
  });

  const normalized = normalizeAbilityConstruct({
    type: "damage",
    damageFormula: "25+energy/10",
    damageTypeKey: "fire",
    damageLimbMode: "critical"
  });
  assert.deepEqual(normalized.damage, {
    amountMode: "formula",
    formula: "25+energy/10",
    damageTypeKey: "fire",
    limbMode: "randomCritical"
  });
});
