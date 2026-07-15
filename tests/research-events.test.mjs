import assert from "node:assert/strict";
import test from "node:test";

import {
  buildResearchEventPayload,
  createResearchProgressSnapshot,
  normalizeResearchCheckSummary
} from "../src/research/events.mjs";

test("research progress payload carries actual progress, target, gain, completion and check context", () => {
  const payload = buildResearchEventPayload({
    actorUuid: "Actor.researcher",
    beforeResearch: {
      id: "research-1",
      name: "Power armour",
      skillKey: "science",
      type: "ability",
      sourceId: "ability-power-armour",
      sourceCategoryId: "technology",
      progress: 70,
      target: 100
    },
    afterResearch: {
      id: "research-1",
      name: "Power armour",
      skillKey: "science",
      type: "ability",
      sourceId: "ability-power-armour",
      sourceCategoryId: "technology",
      progress: 100,
      target: 100
    },
    gain: 45,
    progressSource: "researchTime",
    checkSummary: {
      checks: 2,
      resolved: 2,
      counts: { success: 1, criticalSuccess: 1 },
      totalGain: 45
    }
  });

  assert.deepEqual(payload.before, {
    progress: 70,
    target: 100,
    completionPercent: 70,
    completed: false
  });
  assert.deepEqual(payload.after, {
    progress: 100,
    target: 100,
    completionPercent: 100,
    completed: true
  });
  assert.deepEqual(payload.delta, { progress: 30, target: 0, gain: 45 });
  assert.equal(payload.data.actorUuid, "Actor.researcher");
  assert.equal(payload.data.researchId, "research-1");
  assert.equal(payload.data.skillKey, "science");
  assert.equal(payload.data.researchType, "ability");
  assert.equal(payload.data.sourceId, "ability-power-armour");
  assert.equal(payload.data.sourceCategoryId, "technology");
  assert.equal(payload.data.beforeProgress, 70);
  assert.equal(payload.data.afterProgress, 100);
  assert.equal(payload.data.beforeTarget, 100);
  assert.equal(payload.data.afterTarget, 100);
  assert.equal(payload.data.progress, 100);
  assert.equal(payload.data.target, 100);
  assert.equal(payload.data.gain, 45);
  assert.equal(payload.data.progressDelta, 30);
  assert.equal(payload.data.completionPercent, 100);
  assert.equal(payload.data.completed, true);
  assert.equal(payload.data.completionReached, true);
  assert.deepEqual(payload.data.checkSummary.counts, {
    criticalFailure: 0,
    failure: 0,
    success: 1,
    criticalSuccess: 1,
    autoFailure: 0
  });
});

test("research snapshots and check summaries are bounded JSON values", () => {
  assert.deepEqual(createResearchProgressSnapshot({ progress: 140, target: 120 }), {
    progress: 120,
    target: 120,
    completionPercent: 100,
    completed: true
  });
  assert.deepEqual(normalizeResearchCheckSummary({
    checks: "3",
    counts: { failure: 2, success: 1 },
    totalGain: "12.345"
  }), {
    checks: 3,
    resolved: 3,
    counts: {
      criticalFailure: 0,
      failure: 2,
      success: 1,
      criticalSuccess: 0,
      autoFailure: 0
    },
    totalGain: 12.35
  });
});
