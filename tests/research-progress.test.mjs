import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { calculateResearchProgressGain } from "../src/research/progress.mjs";
import {
  clampResearchProgress, formatResearchValue, getResearchById,
  prepareResearchForStorage, roundSignedResearchValue
} from "../src/research/storage.mjs";
import { toInteger } from "../src/utils/numbers.mjs";

test("fixed research progress uses the editable reward, independent of skill", () => {
  for (const skill of [0, 40, 200]) {
    assert.equal(calculateResearchProgressGain(skill, { key: "success" }), 1);
    assert.equal(calculateResearchProgressGain(skill, { key: "criticalSuccess" }), 2);
    assert.equal(calculateResearchProgressGain(skill, { key: "success" }, { progressPerSuccess: 3.5 }), 3.5);
    assert.equal(calculateResearchProgressGain(skill, { key: "criticalSuccess" }, { progressPerSuccess: 3.5 }), 7);
    assert.equal(calculateResearchProgressGain(skill, { key: "failure" }, { progressPerSuccess: 3.5 }), 0);
    assert.equal(calculateResearchProgressGain(skill, { key: "criticalFailure" }), -1);
    assert.equal(calculateResearchProgressGain(skill, { key: "criticalFailure" }, { progressPerSuccess: 3.5 }), -3.5);
  }
  assert.equal(calculateResearchProgressGain(100, { key: "success" }, { progressPerSuccess: 0 }), 0);
});

test("legacy mode retains skill rewards and automatic failure gives no progress", () => {
  const options = { legacy: true, progressPerSuccess: 8 };
  for (const [key, gain] of [["success", 80], ["criticalSuccess", 120], ["failure", 24], ["criticalFailure", 0]]) {
    assert.equal(calculateResearchProgressGain(80, { key }, options), gain);
  }
  for (const legacy of [true, false]) {
    assert.equal(calculateResearchProgressGain(80, { key: "failure", autoFailure: true }, { legacy }), 0);
  }
});

test("stored research defaults to one and retains zero and fractional rewards", () => {
  assert.equal(prepareResearchForStorage({}, { generateId: false }).progressPerSuccess, 1);
  for (const value of [0, 2.5, 10]) {
    const stored = prepareResearchForStorage({ progressPerSuccess: value }, { generateId: false });
    assert.equal(prepareResearchForStorage(stored, { generateId: false }).progressPerSuccess, value);
  }
});

test("research time applies custom rewards, legacy selection, and the target cap", async () => {
  const source = readFileSync(new URL("../src/research/research.mjs", import.meta.url), "utf8");
  const readFunction = name => {
    const match = source.match(new RegExp(`(?:export )?(?:async )?function ${name}\\([^]*?\\n\\}`));
    assert.ok(match, name);
    return match[0].replace(/^export /, "");
  };
  let legacy = false;
  let committed;
  let results = ["success", "criticalSuccess", "failure", "criticalFailure"];
  const actor = {
    uuid: "Actor.researcher",
    system: { researches: [{ id: "study", progress: 0, target: 20, progressPerSuccess: 3, skillKey: "science" }] },
    updateResearch: async (_id, changes, options) => { committed = { changes, options }; }
  };
  const dependencies = {
    getResearchById, toInteger, roundSignedResearchValue, clampResearchProgress, formatResearchValue,
    calculateResearchProgressGain, isLegacyResearchProgress: () => legacy,
    withSystemEventRoot: async (_options, run) => run({ chainRef: {} }),
    resolveResearchChainRef: () => ({}), canvas: {}, game: {},
    requestSkillCheckBatch: async () => ({ outcomes: results.map(key => ({
      skill: { value: 80 }, result: { key }
    })) })
  };
  const apply = new Function(...Object.keys(dependencies), `
    ${readFunction("getResearchCheckCount")}
    ${readFunction("createResearchResultCounters")}
    ${readFunction("applyResearchTime")}
    return applyResearchTime;
  `)(...Object.values(dependencies));
  const modern = await apply(actor, "study", { hours: 2 }, { occurrenceId: "modern" });
  assert.equal(modern.totalGain, 6);
  assert.equal(modern.gainLabel, "+6");
  assert.equal(committed.changes.progress, 6);
  assert.equal(committed.options.checkSummary.totalGain, 6);
  legacy = true;
  const old = await apply(actor, "study", { hours: 2 }, { occurrenceId: "legacy" });
  assert.equal(old.totalGain, 224);
  assert.equal(committed.changes.progress, 20);
  legacy = false;
  results = ["criticalFailure"];
  actor.system.researches[0].progress = 5;
  actor.system.researches[0].progressPerSuccess = 3.5;
  const loss = await apply(actor, "study", { halfHour: true }, { occurrenceId: "loss" });
  assert.equal(loss.totalGain, -3.5);
  assert.equal(loss.gainLabel, "-3.5");
  assert.equal(committed.changes.progress, 1.5);
  assert.equal(committed.options.checkSummary.totalGain, -3.5);
  actor.system.researches[0].progress = 1;
  await apply(actor, "study", { halfHour: true }, { occurrenceId: "floor" });
  assert.equal(committed.changes.progress, 0);
});
