import assert from "node:assert/strict";
import test from "node:test";

const {
  buildAttackTrialFormulaData,
  createAttackTrialResolutionState,
  evaluateAttackTrialDifficulty,
  resolveAttackTrialResolution
} = await import("../src/combat/attack-trial-resolution.mjs");

function actor(uuid, {
  energy = 0,
  skills = {}
} = {}) {
  return {
    uuid,
    system: {
      resources: {
        power: { value: energy, max: 500 }
      },
      skills: Object.fromEntries(
        Object.entries(skills).map(([key, value]) => [key, { value }])
      )
    }
  };
}

function outcomeBranch(id, flow = "continue", links = []) {
  return { id, flow, links };
}

function trial({
  id,
  subject = "targets",
  sourceMode = "once",
  selectionMode = "best",
  difficultyFormula = "0",
  entries = [{ id: `${id}-skill`, kind: "skill", key: "endurance" }],
  outcomes = {}
}) {
  return {
    id,
    subject,
    sourceMode,
    selectionMode,
    difficultyFormula,
    entries,
    outcomes: {
      criticalFailure: outcomeBranch(`${id}-critical-failure`),
      failure: outcomeBranch(`${id}-failure`),
      success: outcomeBranch(`${id}-success`),
      criticalSuccess: outcomeBranch(`${id}-critical-success`),
      ...outcomes
    }
  };
}

function settings(...trials) {
  return { hitResolution: { trials } };
}

function formulaDependencies(extra = {}) {
  return {
    buildActorFormulaData: async sourceActor => ({
      formulaVariables: {},
      variables: [],
      skillSettings: [{ key: "energy", abbr: "ene", aliases: [] }],
      skills: { energy: sourceActor.system.skills.energy?.value ?? 0 }
    }),
    ...extra
  };
}

function batchResponder(resultForActor, calls = []) {
  return async request => {
    calls.push(request);
    return {
      outcomes: request.entries.map(entry => ({
        actor: entry.actor,
        check: {
          chanceOperationId: entry.data.chanceOperationId,
          difficulty: entry.data.difficulty
        },
        result: {
          key: resultForActor(entry.actor, entry)
        }
      }))
    };
  };
}

test("difficulty preserves source skill aliases and exposes resources through their real keys", async () => {
  const source = actor("Actor.source", { energy: 60, skills: { energy: 5 } });
  const target = actor("Actor.target", { energy: 15, skills: { energy: 90 } });

  const data = buildAttackTrialFormulaData({
    baseData: {
      formulaVariables: { ene: 5 },
      variables: [],
      skillSettings: [{ key: "energy", abbr: "ene", aliases: [] }],
      skills: { energy: 5 }
    },
    sourceActor: source,
    targetActor: target,
    subjectActor: target
  });
  assert.equal(data.formulaVariables.ene, 5);
  assert.equal(data.formulaVariables.power, 60);
  assert.equal(data.skillSettings.some(entry => entry.key === "energy"), true);
  assert.equal(data.formulaReferences["source.resources.power.value"], 60);
  assert.equal(data.formulaReferences["target.resources.power.value"], 15);
  assert.equal(data.formulaReferences["subject.resources.power.value"], 15);

  const difficulty = await evaluateAttackTrialDifficulty({
    formula: "50 + ene + energy + power + @source.resources.power.value + @target.resources.power.value + @subject.resources.power.value",
    sourceActor: source,
    targetActor: target,
    subjectActor: target
  }, formulaDependencies());
  assert.equal(difficulty, 210);
});

test("target trials choose best or worst skill and route fixed result branches", async () => {
  const source = actor("Actor.source", { energy: 400, skills: { energy: 40 } });
  const first = actor("Actor.first", {
    energy: 5,
    skills: { endurance: 30, athletics: 70 }
  });
  const second = actor("Actor.second", {
    energy: 10,
    skills: { endurance: 80, athletics: 20 }
  });
  const calls = [];
  const requestSkillCheckBatch = batchResponder(
    checked => checked.uuid === first.uuid ? "failure" : "success",
    calls
  );

  const result = await resolveAttackTrialResolution({
    attackSettings: settings(
      trial({
        id: "best",
        selectionMode: "best",
        difficultyFormula: "50 + energy + @subject.resources.power.value",
        entries: [
          { id: "endurance", kind: "skill", key: "endurance" },
          { id: "athletics", kind: "skill", key: "athletics" }
        ],
        outcomes: {
          failure: outcomeBranch("failed", "continue", [{
            id: "damage-link",
            constructId: "damage-fire",
            recipient: "subjects",
            mode: "perSubject"
          }])
        }
      }),
      trial({
        id: "worst",
        selectionMode: "worst",
        entries: [
          { id: "endurance", kind: "skill", key: "endurance" },
          { id: "athletics", kind: "skill", key: "athletics" }
        ]
      })
    ),
    sourceActor: source,
    targets: [
      { actor: first, token: { uuid: "Token.first" } },
      { actor: second, token: { uuid: "Token.second" } }
    ],
    operationId: "attack-1"
  }, formulaDependencies({ requestSkillCheckBatch }));

  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls[0].entries.map(entry => [entry.actor.uuid, entry.skillKey, entry.data.difficulty]),
    [
      ["Actor.first", "athletics", 95],
      ["Actor.second", "endurance", 100]
    ]
  );
  assert.deepEqual(
    calls[1].entries.map(entry => [entry.actor.uuid, entry.skillKey]),
    [
      ["Actor.first", "endurance"],
      ["Actor.second", "athletics"]
    ]
  );
  assert.equal(result.attempted, 4);
  assert.equal(result.resolved, 4);
  assert.equal(result.targetOutcomes[0].outcomes[0].resultKey, "failure");
  assert.equal(result.targetOutcomes[0].outcomes[0].outcomeId, "failed");
  assert.equal(result.targetOutcomes[0].outcomes[0].links[0].constructId, "damage-fire");
  assert.equal(result.targetOutcomes[1].outcomes[0].resultKey, "success");
});

test("stopSubject isolates a target lane while stopAll halts every later trial", async () => {
  const source = actor("Actor.source", { skills: { endurance: 50 } });
  const first = actor("Actor.first", { skills: { endurance: 40 } });
  const second = actor("Actor.second", { skills: { endurance: 60 } });
  const calls = [];
  const requestSkillCheckBatch = batchResponder((checked, entry) => {
    const checkId = entry.data.chanceOperationId;
    if (checkId.includes(":gate:") && checked.uuid === first.uuid) return "failure";
    if (checkId.includes(":finish:")) return "criticalSuccess";
    return "success";
  }, calls);

  const result = await resolveAttackTrialResolution({
    attackSettings: settings(
      trial({
        id: "gate",
        outcomes: {
          failure: outcomeBranch("stop-first", "stopSubject")
        }
      }),
      trial({ id: "finish" }),
      trial({
        id: "global",
        outcomes: {
          success: outcomeBranch("stop-everything", "stopAll")
        }
      }),
      trial({ id: "never" })
    ),
    sourceActor: source,
    targets: [
      { actor: first, token: { uuid: "Token.first" } },
      { actor: second, token: { uuid: "Token.second" } }
    ],
    operationId: "attack-flow"
  }, formulaDependencies({ requestSkillCheckBatch }));

  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(call => call.entries.map(entry => entry.actor.uuid)), [
    ["Actor.first", "Actor.second"],
    ["Actor.second"],
    ["Actor.second"]
  ]);
  assert.equal(result.stoppedAll, true);
  assert.equal(result.targetOutcomes[0].stopped, true);
  assert.equal(result.targetOutcomes[0].outcomes.length, 1);
  assert.equal(result.targetOutcomes[1].outcomes.length, 3);
});

test("source-once stopSubject is promoted to stopAll", async () => {
  const source = actor("Actor.source", {
    skills: { endurance: 50, athletics: 80 }
  });
  const target = actor("Actor.target", { skills: { endurance: 30 } });
  const calls = [];
  const requestSkillCheckBatch = batchResponder(() => "failure", calls);

  const result = await resolveAttackTrialResolution({
    attackSettings: settings(
      trial({
        id: "source-gate",
        subject: "source",
        sourceMode: "once",
        entries: [
          { id: "endurance", kind: "skill", key: "endurance" },
          { id: "athletics", kind: "skill", key: "athletics" }
        ],
        outcomes: {
          failure: outcomeBranch("source-stops", "stopSubject")
        }
      }),
      trial({ id: "target-never" })
    ),
    sourceActor: source,
    targets: [{ actor: target, token: { uuid: "Token.target" } }]
  }, formulaDependencies({ requestSkillCheckBatch }));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].entries[0].skillKey, "athletics");
  assert.equal(result.sourceOutcomes[0].configuredFlow, "stopSubject");
  assert.equal(result.sourceOutcomes[0].flow, "stopAll");
  assert.equal(result.stoppedAll, true);
  assert.equal(result.targetOutcomes[0].outcomes.length, 0);
});

test("source per-target flow and session cache are isolated by target laneKey", async () => {
  const source = actor("Actor.source", { skills: { endurance: 50 } });
  const first = actor("Actor.first", { skills: { endurance: 30 } });
  const second = actor("Actor.second", { skills: { endurance: 40 } });
  const state = createAttackTrialResolutionState();
  const calls = [];
  const requestSkillCheckBatch = async request => {
    calls.push(request);
    return {
      outcomes: request.entries
        .map(entry => ({
          actor: entry.actor,
          check: { chanceOperationId: entry.data.chanceOperationId },
          result: {
            key: entry.data.chanceOperationId.endsWith("lane-first")
              ? "failure"
              : "success"
          }
        }))
        .reverse()
    };
  };
  const attackSettings = settings(
    trial({
      id: "source-per-target",
      subject: "source",
      sourceMode: "perTarget",
      outcomes: {
        failure: outcomeBranch("stop-lane", "stopSubject")
      }
    }),
    trial({ id: "target-check" })
  );

  const firstPass = await resolveAttackTrialResolution({
    attackSettings,
    sourceActor: source,
    targets: [
      { actor: first, token: { uuid: "Token.shared" }, laneKey: "lane-first" },
      { actor: second, token: { uuid: "Token.second" }, laneKey: "lane-second" }
    ],
    state,
    operationId: "attack-cache"
  }, formulaDependencies({ requestSkillCheckBatch }));

  assert.equal(firstPass.sourceOutcomes.length, 2);
  assert.equal(firstPass.targetOutcomes[0].sourceOutcomes[0].resultKey, "failure");
  assert.equal(firstPass.targetOutcomes[0].stopped, true);
  assert.equal(firstPass.targetOutcomes[0].outcomes.length, 0);
  assert.equal(firstPass.targetOutcomes[1].outcomes.length, 1);

  const repeated = await resolveAttackTrialResolution({
    attackSettings,
    sourceActor: source,
    targets: [
      { actor: second, token: { uuid: "Token.second" }, laneKey: "lane-second" }
    ],
    state,
    operationId: "attack-cache"
  }, formulaDependencies({ requestSkillCheckBatch }));

  assert.equal(repeated.attempted, 0);
  assert.equal(repeated.resolved, 0);
  assert.equal(repeated.reused, 2);
  assert.equal(repeated.sourceOutcomes[0].cached, true);
  assert.equal(repeated.targetOutcomes[0].outcomes[0].cached, true);
  assert.equal(calls.length, 2);

  const separateSequence = await resolveAttackTrialResolution({
    attackSettings,
    sourceActor: source,
    targets: [
      { actor: second, token: { uuid: "Token.second" }, laneKey: "lane-second-sequence-2" }
    ],
    state,
    operationId: "attack-cache-sequence-2"
  }, formulaDependencies({ requestSkillCheckBatch }));

  assert.equal(separateSequence.attempted, 2);
  assert.equal(separateSequence.resolved, 2);
  assert.equal(calls.length, 4);
});

test("source-once outcome is cached across target-by-target controller calls", async () => {
  const source = actor("Actor.source", { skills: { endurance: 50 } });
  const first = actor("Actor.first", { skills: { endurance: 30 } });
  const second = actor("Actor.second", { skills: { endurance: 40 } });
  const state = createAttackTrialResolutionState();
  const calls = [];
  const requestSkillCheckBatch = batchResponder(() => "success", calls);
  const attackSettings = settings(
    trial({ id: "source-once", subject: "source", sourceMode: "once" }),
    trial({ id: "target" })
  );

  const firstPass = await resolveAttackTrialResolution({
    attackSettings,
    sourceActor: source,
    targets: [{ actor: first, token: { uuid: "Token.first" } }],
    state
  }, formulaDependencies({ requestSkillCheckBatch }));
  const secondPass = await resolveAttackTrialResolution({
    attackSettings,
    sourceActor: source,
    targets: [{ actor: second, token: { uuid: "Token.second" } }],
    state
  }, formulaDependencies({ requestSkillCheckBatch }));

  assert.equal(firstPass.sourceOutcomes[0].cached, false);
  assert.equal(secondPass.sourceOutcomes[0].cached, true);
  assert.equal(secondPass.reused, 1);
  assert.equal(calls.filter(call => call.entries[0].actor.uuid === source.uuid).length, 1);
  assert.equal(calls.filter(call => call.entries[0].actor.uuid !== source.uuid).length, 2);
});
