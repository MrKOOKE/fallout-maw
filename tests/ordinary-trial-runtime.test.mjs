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
globalThis.game = {
  time: { worldTime: 100 },
  settings: { get: () => undefined }
};

const {
  executeAbilityTrials
} = await import("../src/abilities/trial-runtime.mjs");

function actor(uuid, skillValue = 50, limbs = {}) {
  return {
    uuid,
    effects: [],
    createdEffects: [],
    async createEmbeddedDocuments(type, data) {
      assert.equal(type, "ActiveEffect");
      this.createdEffects.push(...data);
      return data;
    },
    system: {
      skills: { resilience: { value: skillValue } },
      resources: {},
      limbs
    }
  };
}

function trial(id, branches, overrides = {}) {
  return {
    id,
    type: "trial",
    trialSubject: "targets",
    trialEntries: [{ id: `${id}-skill`, kind: "skill", key: "resilience" }],
    trialSelectionMode: "best",
    trialDifficultyFormula: "50",
    trialBranches: branches,
    ...overrides
  };
}

function branch(id, resultKeys, flow = "continue", links = []) {
  return { id, name: id, resultKeys, flow, links };
}

test("ordinary Trial stopSubject removes only matching targets from later trials", async () => {
  const source = actor("Actor.source");
  const first = actor("Actor.first");
  const second = actor("Actor.second");
  const checkedBatches = [];
  const consequenceCalls = [];
  const resultKeysByTrial = [
    new Map([["Actor.first", "failure"], ["Actor.second", "success"]]),
    new Map([["Actor.second", "success"]])
  ];

  const result = await executeAbilityTrials({
    abilityFunction: {
      conditions: [
        trial("one", [
          branch("failed", ["failure"], "stopSubject"),
          branch("passed", ["success"])
        ]),
        trial("two", [branch("second-pass", ["success"])])
      ]
    },
    sourceActor: source,
    targets: [{ actor: first }, { actor: second }],
    requestSkillCheckBatchFn: async ({ entries }) => {
      checkedBatches.push(entries.map(entry => entry.actor.uuid));
      const keys = resultKeysByTrial[checkedBatches.length - 1];
      return {
        outcomes: entries.map(entry => ({
          actor: entry.actor,
          result: { key: keys.get(entry.actor.uuid) }
        }))
      };
    },
    executeTrialLinksFn: async data => {
      consequenceCalls.push({
        trialId: data.trial.id,
        links: data.links,
        actors: data.matchedSubjects.map(subject => subject.actor.uuid)
      });
    }
  });

  assert.deepEqual(checkedBatches, [
    ["Actor.first", "Actor.second"],
    ["Actor.second"]
  ]);
  assert.deepEqual(consequenceCalls.map(call => [call.trialId, call.actors]), [
    ["one", ["Actor.first"]],
    ["one", ["Actor.second"]],
    ["two", ["Actor.second"]]
  ]);
  assert.deepEqual(result, { attempted: 3, matched: 3, stoppedAll: false });
});

test("ordinary Trial stopAll finishes the current batch before stopping later trials", async () => {
  const first = actor("Actor.first");
  const second = actor("Actor.second");
  let batchCount = 0;
  const branchCalls = [];
  const result = await executeAbilityTrials({
    abilityFunction: {
      conditions: [
        trial("one", [
          branch("failed", ["failure"], "stopAll"),
          branch("passed", ["success"])
        ]),
        trial("never", [branch("never", ["success"])])
      ]
    },
    sourceActor: actor("Actor.source"),
    targets: [{ actor: first }, { actor: second }],
    requestSkillCheckBatchFn: async ({ entries }) => {
      batchCount += 1;
      return {
        outcomes: entries.map((entry, index) => ({
          actor: entry.actor,
          result: { key: index === 0 ? "failure" : "success" }
        }))
      };
    },
    executeTrialLinksFn: async data => {
      branchCalls.push(data.matchedSubjects.map(subject => subject.actor.uuid));
    }
  });

  assert.equal(batchCount, 1);
  assert.deepEqual(branchCalls, [["Actor.first"], ["Actor.second"]]);
  assert.deepEqual(result, { attempted: 2, matched: 2, stoppedAll: true });
});

test("legacy accepted outcomes remain one grouped consequence execution", async () => {
  const first = actor("Actor.first");
  const second = actor("Actor.second");
  const calls = [];
  await executeAbilityTrials({
    abilityFunction: {
      conditions: [{
        id: "legacy",
        type: "trial",
        trialSubject: "targets",
        trialEntries: [{ id: "skill", kind: "skill", key: "resilience" }],
        trialSelectionMode: "best",
        trialDifficultyFormula: "50",
        trialResultKeys: ["criticalFailure", "failure"],
        trialLinks: [{
          id: "source-link",
          constructId: "reward",
          recipient: "source",
          mode: "once"
        }]
      }]
    },
    sourceActor: actor("Actor.source"),
    targets: [{ actor: first }, { actor: second }],
    requestSkillCheckBatchFn: async ({ entries }) => ({
      outcomes: entries.map((entry, index) => ({
        actor: entry.actor,
        result: { key: index === 0 ? "criticalFailure" : "failure" }
      }))
    }),
    executeTrialLinksFn: async data => calls.push({
      links: data.links,
      actors: data.matchedSubjects.map(subject => subject.actor.uuid)
    })
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].actors, ["Actor.first", "Actor.second"]);
  assert.equal(calls[0].links[0].id, "source-link");
});

test("ordinary Trial formula damage is committed through Damage Hub with its type and key limb", async () => {
  const target = actor("Actor.target", 50, {
    head: { value: 20, min: 0, max: 20, critical: true, aimedDifficultyPercent: 0 },
    arm: { value: 20, min: 0, max: 20, critical: false, aimedDifficultyPercent: 0 }
  });
  const source = actor("Actor.source");
  source.system.resources.power = { value: 60, max: 100 };
  source.system.skills.energy = { value: 999 };
  const damageBatches = [];
  await executeAbilityTrials({
    abilityFunction: {
      conditions: [trial("damage-trial", [branch("failed", ["failure"], "continue", [{
        id: "damage-link",
        constructId: "fire",
        recipient: "subjects",
        mode: "perSubject"
      }])])]
    },
    constructs: [{
      id: "fire",
      type: "damage",
      name: "Огонь",
      damage: {
        amountMode: "formula",
        formula: "50+energy/3",
        damageTypeKey: "fire",
        limbMode: "randomCritical"
      }
    }],
    sourceActor: source,
    targets: [{ actor: target }],
    requestSkillCheckBatchFn: async ({ entries }) => ({
      outcomes: [{ actor: entries[0].actor, result: { key: "failure" } }]
    }),
    requestDamageApplicationsFn: async requests => damageBatches.push(requests)
  });

  assert.equal(damageBatches.length, 1);
  assert.equal(damageBatches[0].length, 1);
  assert.equal(damageBatches[0][0].actor, target);
  assert.equal(damageBatches[0][0].amount, 70);
  assert.equal(damageBatches[0][0].damageTypeKey, "fire");
  assert.equal(damageBatches[0][0].limbKey, "head");
  assert.equal(damageBatches[0][0].scope, "healthAndLimb");
});

test("a failed ordinary Trial applies the primary -30 change for the function duration", async () => {
  const source = actor("Actor.source");
  const failed = actor("Actor.failed");
  const passed = actor("Actor.passed");
  await executeAbilityTrials({
    abilityFunction: {
      id: "impulse",
      type: "activeApplication",
      activeSettings: { changeEvaluation: "target" },
      changes: [{
        id: "dodge",
        key: "system.resources.dodge.bonus",
        type: "add",
        value: "-30",
        phase: "initial",
        priority: null
      }],
      conditions: [{
        id: "duration",
        type: "duration",
        durationSeconds: 12
      }, trial("impulse-trial", [branch("failure", ["failure"], "continue", [{
        id: "primary",
        kind: "primaryChanges",
        recipient: "subjects",
        mode: "perSubject"
      }])])]
    },
    sourceActor: source,
    targets: [{ actor: failed }, { actor: passed }],
    sourceItemUuid: "Item.impulse",
    title: "Импульс",
    requestSkillCheckBatchFn: async ({ entries }) => ({
      outcomes: entries.map((entry, index) => ({
        actor: entry.actor,
        result: { key: index === 0 ? "failure" : "success" }
      }))
    })
  });

  assert.equal(failed.createdEffects.length, 1);
  assert.equal(passed.createdEffects.length, 0);
  assert.equal(failed.createdEffects[0].name, "Импульс");
  assert.equal(failed.createdEffects[0].duration.value, 12);
  assert.equal(failed.createdEffects[0].duration.units, "seconds");
  assert.deepEqual(failed.createdEffects[0].system.changes.map(change => ({
    key: change.key,
    type: change.type,
    value: change.value
  })), [{
    key: "system.resources.dodge.bonus",
    type: "add",
    value: -30
  }]);
});

test("a percentage primary consequence scales additive and multiplicative changes", async () => {
  const target = actor("Actor.target");
  await executeAbilityTrials({
    abilityFunction: {
      id: "scaled",
      type: "activeApplication",
      activeSettings: { changeEvaluation: "target" },
      changes: [{
        id: "dodge",
        key: "system.resources.dodge.bonus",
        type: "add",
        value: "-30"
      }, {
        id: "speed",
        key: "system.resources.movementPoints.multiplier",
        type: "multiply",
        value: "0.8"
      }],
      conditions: [{
        id: "duration",
        type: "duration",
        durationSeconds: 12
      }, trial("scaled-trial", [branch("failure", ["failure"], "continue", [{
        id: "half",
        kind: "primaryChangesPercent",
        percentFormula: "50",
        recipient: "subjects",
        mode: "perSubject"
      }])])]
    },
    sourceActor: actor("Actor.source"),
    targets: [{ actor: target }],
    requestSkillCheckBatchFn: async ({ entries }) => ({
      outcomes: [{ actor: entries[0].actor, result: { key: "failure" } }]
    })
  });

  assert.equal(target.createdEffects.length, 1);
  assert.deepEqual(
    target.createdEffects[0].system.changes.map(change => change.value),
    [-15, 0.9]
  );
});
