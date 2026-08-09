import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const report = JSON.parse(await fs.readFile(
  path.join(here, "..", "docs", "rebalance", "vision-equipment-implementation.json"),
  "utf8"
));

const rank = { D: 1, C: 2, B: 3, A: 4, S: 5 };
const expectedSources = { D: 5, C: 4, B: 3, A: 2, S: 1 };

test("vision equipment catalog has the intended class coverage", () => {
  assert.equal(report.summary.batteries, 5);
  assert.equal(report.summary.flashlights, 5);
  assert.equal(report.summary.nightVisionDevices, 5);
  assert.equal(report.summary.thermalDevices, 3);
  assert.equal(report.summary.protectiveFacewear, 4);
  assert.equal(report.summary.integratedHelmets, 4);
  assert.equal(report.summary.validationIssues, 0);
  assert.equal(report.summary.readbackIssues, 0);

  const night = report.optics.filter(item => item.kind === "night");
  const thermal = report.optics.filter(item => item.kind === "thermal");
  assert.deepEqual(night.map(item => item.class), ["D", "C", "B", "A", "S"]);
  assert.ok(night.every(item => item.vision >= 6));
  assert.deepEqual(thermal.map(item => item.class), ["B", "A", "S"]);
  assert.ok(thermal.every(item => rank[item.class] >= rank.B));
});

test("every powered vision bonus is conditional and has compatible energy sources", () => {
  for (const item of [...report.optics, ...report.integratedHelmets]) {
    assert.ok(item.visionAudit.visionEntries > 0, `${item.name}: no vision entry`);
    assert.equal(
      item.visionAudit.conditionalVisionEntries,
      item.visionAudit.visionEntries,
      `${item.name}: passive vision entry`
    );
    assert.equal(item.visionAudit.energyConsumer, true, `${item.name}: no energy consumer`);
    assert.equal(item.sourceItemUuids.length, expectedSources[item.class], `${item.name}: wrong source ladder`);
  }
});

test("portable energy and lighting progress monotonically by class", () => {
  const batteries = [...report.batteries].sort((a, b) => rank[a.class] - rank[b.class]);
  const flashlights = [...report.flashlights].sort((a, b) => rank[a.class] - rank[b.class]);
  for (let index = 1; index < batteries.length; index += 1) {
    assert.ok(batteries[index].energyReserve > batteries[index - 1].energyReserve);
    assert.ok(batteries[index].price > batteries[index - 1].price);
  }
  for (let index = 1; index < flashlights.length; index += 1) {
    assert.ok(flashlights[index].bright > flashlights[index - 1].bright);
    assert.ok(flashlights[index].dim > flashlights[index - 1].dim);
    assert.equal(flashlights[index].sourceItemUuids.length, expectedSources[flashlights[index].class]);
  }
  assert.ok(flashlights.every(item => item.angle === 360));
});

test("helmet normalization remains visible on idempotent reruns", () => {
  assert.ok(report.summary.normalizedHelmets >= 200);
  assert.equal(report.normalizedHelmets.length, report.summary.normalizedHelmets);
  assert.ok(report.normalizedHelmets.every(item => [0.4, 0.55, 0.7, 0.85].includes(item.eyeProtectionRatio)));
});
