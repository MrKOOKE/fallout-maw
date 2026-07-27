import assert from "node:assert/strict";
import test from "node:test";

let generatedId = 0;
globalThis.foundry = {
  applications: {
    api: {
      DialogV2: class {}
    },
    ux: {
      FormDataExtended: class {}
    },
    handlebars: {
      renderTemplate: async () => ""
    }
  },
  utils: {
    randomID: () => `generated-${++generatedId}`,
    deepClone: value => structuredClone(value)
  }
};

const {
  applyAttackTrialOutcomeConsequences,
  buildAttackTrialOutcomeDeduplicationKey,
  resolveAttackTrialOutcomeCriticalDamage
} = await import("../src/combat/attack-trial-consequences.mjs");

function actor(uuid, limbs = {}) {
  return {
    uuid,
    system: {
      limbs,
      resources: {}
    }
  };
}

function damageConstruct(id, amountMode, formula, limbMode) {
  return {
    id,
    type: "damage",
    name: id,
    damage: { amountMode, formula, limbMode }
  };
}

function resolvedEntry(overrides = {}) {
  return {
    trialId: "trial-one",
    subject: "targets",
    sourceMode: "once",
    actor: actor("Actor.target", {
      arm: { value: 10, min: 0, critical: false, aimedDifficultyPercent: 0 },
      head: { value: 10, min: 0, critical: true, aimedDifficultyPercent: 0 }
    }),
    token: { uuid: "Scene.test.Token.target" },
    resultKey: "failure",
    outcome: {
      links: [{
        id: "damage-link",
        constructId: "damage",
        recipient: "subjects",
        mode: "perSubject"
      }]
    },
    laneKey: "target-lane",
    ...overrides
  };
}

async function collectDamage(options = {}) {
  const calls = [];
  const damageRequests = await applyAttackTrialOutcomeConsequences({
    entry: resolvedEntry(),
    constructs: [damageConstruct("damage", "base", "0", "random")],
    sourceActor: actor("Actor.source"),
    getBaseDamage: () => 12,
    buildDamageRequests: data => {
      calls.push(data);
      return [{ actor: data.recipient.actor, amount: data.amount, limbKey: data.limbKey, scope: data.scope }];
    },
    ...options
  });
  return { calls, damageRequests };
}

test("base damage uses the recipient base and random limb", async () => {
  const { calls, damageRequests } = await collectDamage();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].recipient.actor.uuid, "Actor.target");
  assert.equal(calls[0].amount, 12);
  assert.ok(["arm", "head"].includes(calls[0].limbKey));
  assert.equal(calls[0].scope, "healthAndLimb");
  assert.deepEqual(damageRequests.map(request => request.amount), [12]);
});

test("formula damage is evaluated against the source actor", async () => {
  const sourceActor = actor("Actor.source");
  let evaluatedActor = null;
  const { calls } = await collectDamage({
    sourceActor,
    constructs: [damageConstruct("damage", "formula", "50+energy/3", "healthOnly")],
    evaluateDamageFormula: (formula, evaluated) => {
      assert.equal(formula, "50+energy/3");
      evaluatedActor = evaluated;
      return 63;
    }
  });

  assert.equal(evaluatedActor, sourceActor);
  assert.equal(calls[0].amount, 63);
  assert.equal(calls[0].limbKey, "");
  assert.equal(calls[0].scope, "health");
});

test("percent damage evaluates a source formula and applies it to each recipient base", async () => {
  const targetOne = actor("Actor.one", {
    arm: { value: 10, min: 0, critical: false, aimedDifficultyPercent: 0 }
  });
  const targetTwo = actor("Actor.two", {
    leg: { value: 10, min: 0, critical: false, aimedDifficultyPercent: 0 }
  });
  const entry = resolvedEntry({
    outcome: {
      links: [{
        id: "all-targets",
        constructId: "damage",
        recipient: "targets",
        mode: "once"
      }]
    }
  });
  const bases = new Map([["Actor.one", 11], ["Actor.two", 8]]);
  const { calls } = await collectDamage({
    entry,
    targets: [
      { actor: targetOne, token: { uuid: "Token.one" } },
      { actor: targetTwo, token: { uuid: "Token.two" } }
    ],
    constructs: [damageConstruct("damage", "percent", "50", "random")],
    getBaseDamage: recipient => bases.get(recipient.actor.uuid),
    evaluateDamageFormula: (_formula, source) => {
      assert.equal(source.uuid, "Actor.source");
      return 50;
    }
  });

  assert.deepEqual(calls.map(call => call.amount), [5, 4]);
  assert.deepEqual(calls.map(call => call.recipient.actor.uuid), ["Actor.one", "Actor.two"]);
});

test("critical-random and selected limb modes resolve their intended locations", async () => {
  const critical = await collectDamage({
    constructs: [damageConstruct("damage", "base", "0", "randomCritical")]
  });
  assert.equal(critical.calls[0].limbKey, "head");

  let selectedRecipient = null;
  const selected = await collectDamage({
    constructs: [damageConstruct("damage", "base", "0", "selected")],
    getSelectedLimbKey: recipient => {
      selectedRecipient = recipient;
      return "head";
    }
  });
  assert.equal(selectedRecipient.actor.uuid, "Actor.target");
  assert.equal(selected.calls[0].limbKey, "head");
  assert.equal(selected.calls[0].scope, "healthAndLimb");
});

test("source, subject, and all-target recipients are delegated through shared trial links", async () => {
  const sourceActor = actor("Actor.source", {
    head: { value: 10, min: 0, critical: true, aimedDifficultyPercent: 0 }
  });
  const targetActor = actor("Actor.other", {
    torso: { value: 10, min: 0, critical: false, aimedDifficultyPercent: 0 }
  });
  const entry = resolvedEntry({
    links: [
      { id: "source", constructId: "damage", recipient: "source", mode: "once" },
      { id: "subject", constructId: "damage", recipient: "subjects", mode: "perSubject" },
      { id: "targets", constructId: "damage", recipient: "targets", mode: "once" }
    ]
  });
  const { calls } = await collectDamage({
    entry,
    sourceActor,
    sourceToken: { uuid: "Scene.test.Token.source" },
    targets: [{ actor: targetActor, token: { uuid: "Scene.test.Token.other" } }]
  });

  assert.deepEqual(calls.map(call => call.recipient.actor.uuid), [
    "Actor.source",
    "Actor.target",
    "Actor.other"
  ]);
  assert.equal(calls[0].recipient.token.uuid, "Scene.test.Token.source");
});

test("a supplied Set prevents pellet visits from applying the same outcome twice", async () => {
  const deduplicationSet = new Set();
  const entry = resolvedEntry();
  let applications = 0;
  const options = {
    entry,
    constructs: [damageConstruct("damage", "base", "0", "random")],
    sourceActor: actor("Actor.source"),
    deduplicationSet,
    getBaseDamage: () => 10,
    buildDamageRequests: data => {
      applications += 1;
      return [{ amount: data.amount }];
    }
  };

  const first = await applyAttackTrialOutcomeConsequences(options);
  const second = await applyAttackTrialOutcomeConsequences(options);

  assert.equal(applications, 1);
  assert.equal(first.length, 1);
  assert.deepEqual(second, []);
  assert.equal(deduplicationSet.size, 1);
});

test("derived keys distinguish semantic lanes and an explicit key can override them", async () => {
  const first = resolvedEntry({ laneKey: "lane-one" });
  const second = resolvedEntry({ laneKey: "lane-two" });
  assert.notEqual(
    buildAttackTrialOutcomeDeduplicationKey(first),
    buildAttackTrialOutcomeDeduplicationKey(second)
  );

  const deduplicationSet = new Set();
  let applications = 0;
  const common = {
    constructs: [damageConstruct("damage", "base", "0", "random")],
    sourceActor: actor("Actor.source"),
    deduplicationSet,
    deduplicationKey: "explicit-lane",
    getBaseDamage: () => 1,
    buildDamageRequests: data => {
      applications += 1;
      return [{ amount: data.amount }];
    }
  };
  await applyAttackTrialOutcomeConsequences({ ...common, entry: first });
  await applyAttackTrialOutcomeConsequences({ ...common, entry: second });
  assert.equal(applications, 1);
});

test("critical damage is outcome-bound, first-wins, and never inferred from the result name", async () => {
  const sourceActor = actor("Actor.source");
  const targetActor = actor("Actor.target");
  const subjectActor = actor("Actor.subject");
  const specialProperties = [{
    type: "criticalDamage",
    criticalDamage: {
      outcomeId: "burning-failure",
      percentFormula: "125 + ene + @target.energy + @subject.energy"
    }
  }, {
    type: "criticalDamage",
    criticalDamage: {
      outcomeId: "burning-failure",
      percentFormula: "999"
    }
  }];
  let evaluation = null;

  const matching = await resolveAttackTrialOutcomeCriticalDamage({
    amount: 20,
    specialProperties,
    entry: {
      outcomeId: "burning-failure",
      resultKey: "failure",
      actor: subjectActor
    },
    recipient: { actor: targetActor },
    sourceActor,
    evaluateFormula: (formula, evaluatedActor, options) => {
      evaluation = { formula, evaluatedActor, options };
      return 175;
    }
  });

  assert.deepEqual(matching, {
    amount: 35,
    applied: true,
    percent: 175,
    outcomeId: "burning-failure"
  });
  assert.equal(evaluation.formula, "125 + ene + @target.energy + @subject.energy");
  assert.equal(evaluation.evaluatedActor, sourceActor);
  assert.equal(evaluation.options.targetActor, targetActor);
  assert.equal(evaluation.options.subjectActor, subjectActor);

  let mismatchEvaluated = false;
  const mismatchingCriticalSuccess = await resolveAttackTrialOutcomeCriticalDamage({
    amount: 20,
    specialProperties,
    entry: {
      outcomeId: "clean-critical-success",
      resultKey: "criticalSuccess",
      actor: subjectActor
    },
    recipient: { actor: targetActor },
    sourceActor,
    evaluateFormula: () => {
      mismatchEvaluated = true;
      return 999;
    }
  });

  assert.deepEqual(mismatchingCriticalSuccess, {
    amount: 20,
    applied: false,
    percent: 100,
    outcomeId: "clean-critical-success"
  });
  assert.equal(mismatchEvaluated, false);
});

test("one matching branch multiplies every damage consequence without leaking to adjacent outcomes", async () => {
  const sourceActor = actor("Actor.source");
  const targetActor = actor("Actor.target");
  const specialProperties = [{
    type: "criticalDamage",
    criticalDamage: {
      outcomeId: "trial-one-failure",
      percentFormula: "200"
    }
  }];
  const constructs = [
    damageConstruct("damage", "base", "0", "healthOnly"),
    damageConstruct("damage-one", "base", "0", "healthOnly"),
    damageConstruct("damage-two", "base", "0", "healthOnly")
  ];

  const resolveBranch = async entry => applyAttackTrialOutcomeConsequences({
    entry,
    constructs,
    sourceActor,
    getBaseDamage: () => 7,
    buildDamageRequests: async data => {
      const critical = await resolveAttackTrialOutcomeCriticalDamage({
        amount: data.amount,
        specialProperties,
        entry: data.entry,
        recipient: data.recipient,
        sourceActor,
        evaluateFormula: () => 200
      });
      return [{
        constructId: data.construct.id,
        amount: critical.amount,
        criticalDamageUsed: critical.applied
      }];
    }
  });

  const matching = await resolveBranch(resolvedEntry({
    outcomeId: "trial-one-failure",
    resultKey: "failure",
    outcome: {
      links: [
        {
          id: "first-damage",
          constructId: "damage-one",
          recipient: "subjects",
          mode: "perSubject"
        },
        {
          id: "second-damage",
          constructId: "damage-two",
          recipient: "subjects",
          mode: "perSubject"
        }
      ]
    }
  }));
  assert.deepEqual(matching, [
    { constructId: "damage-one", amount: 14, criticalDamageUsed: true },
    { constructId: "damage-two", amount: 14, criticalDamageUsed: true }
  ]);

  const adjacentBranch = await resolveBranch(resolvedEntry({
    outcomeId: "trial-one-success",
    resultKey: "success"
  }));
  assert.deepEqual(adjacentBranch, [{
    constructId: "damage",
    amount: 7,
    criticalDamageUsed: false
  }]);

  const sameResultInAnotherTrial = await resolveBranch(resolvedEntry({
    trialId: "trial-two",
    outcomeId: "trial-two-failure",
    resultKey: "failure"
  }));
  assert.deepEqual(sameResultInAnotherTrial, [{
    constructId: "damage",
    amount: 7,
    criticalDamageUsed: false
  }]);
});
