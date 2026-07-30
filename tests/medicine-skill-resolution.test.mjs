import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateMedicineSkillResolution,
  resolveMedicineSkillAction
} from "../src/apps/medicine-skill-resolution.mjs";

test("ordinary medicine mode requests a roll without pre-rejecting a low skill", () => {
  const result = evaluateMedicineSkillResolution(createActor(45), {
    skillKey: "doctor",
    difficulty: 60,
    thresholdMode: false
  });

  assert.equal(result.requiresCheck, true);
  assert.equal(result.usesThreshold, false);
  assert.equal(result.met, true);
});

test("medicine threshold mode succeeds without a roll when the skill reaches difficulty", () => {
  const result = evaluateMedicineSkillResolution(createActor(60), {
    skillKey: "doctor",
    difficulty: 60,
    thresholdMode: true
  });

  assert.equal(result.requiresCheck, false);
  assert.equal(result.usesThreshold, true);
  assert.equal(result.met, true);
  assert.equal(result.resultKey, "success");
  assert.equal(result.resultLabel, "навык соответствует порогу");
});

test("medicine threshold mode reports an unmet skill without inventing a roll", () => {
  const result = evaluateMedicineSkillResolution(createActor(59), {
    skillKey: "doctor",
    difficulty: 60,
    thresholdMode: true
  });

  assert.equal(result.requiresCheck, false);
  assert.equal(result.usesThreshold, true);
  assert.equal(result.met, false);
  assert.equal(result.resultKey, "failure");
  assert.equal(result.skillValue, 59);
  assert.equal(result.difficulty, 60);
});

test("a medical action without a configured skill remains an automatic success", () => {
  const result = evaluateMedicineSkillResolution(createActor(0), {
    skillKey: "",
    difficulty: 200,
    thresholdMode: true
  });

  assert.equal(result.requiresCheck, false);
  assert.equal(result.usesThreshold, false);
  assert.equal(result.met, true);
  assert.equal(result.resultKey, "success");
});

test("threshold resolution performs zero rolls and returns a synthetic success", async () => {
  let checks = 0;
  const result = await resolveMedicineSkillAction(createActor(80), {
    skillKey: "doctor",
    difficulty: 60,
    thresholdMode: true
  }, {
    requestCheck: async () => {
      checks += 1;
      return { result: { key: "criticalFailure" } };
    }
  });

  assert.equal(checks, 0);
  assert.equal(result.checkPerformed, false);
  assert.deepEqual(result.outcome, { result: { key: "success" } });
});

test("ordinary resolution performs exactly one supplied skill check", async () => {
  let checks = 0;
  const expectedOutcome = { result: { key: "criticalSuccess" } };
  const result = await resolveMedicineSkillAction(createActor(80), {
    skillKey: "doctor",
    difficulty: 60,
    thresholdMode: false
  }, {
    requestCheck: async () => {
      checks += 1;
      return expectedOutcome;
    }
  });

  assert.equal(checks, 1);
  assert.equal(result.checkPerformed, true);
  assert.equal(result.outcome, expectedOutcome);
});

test("an unmet threshold performs zero rolls and returns no outcome", async () => {
  let checks = 0;
  const result = await resolveMedicineSkillAction(createActor(20), {
    skillKey: "doctor",
    difficulty: 60,
    thresholdMode: true
  }, {
    requestCheck: async () => {
      checks += 1;
      return { result: { key: "success" } };
    }
  });

  assert.equal(checks, 0);
  assert.equal(result.met, false);
  assert.equal(result.outcome, null);
});

function createActor(doctor) {
  return {
    system: {
      skills: {
        doctor: { value: doctor }
      }
    }
  };
}
