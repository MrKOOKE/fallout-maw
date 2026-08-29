import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  HUNTING_GROUNDS_DETECTION_MODE_ID,
  advanceHuntingGroundsMarks,
  buildPreyEffectChanges,
  createHuntingGroundsSquareRegionData,
  movementPathEntersHuntingGroundsRegion
} from "../src/abilities/hunting-grounds.mjs";
import { ATTACK_CRITICAL_FAILURE_DISABLED_EFFECT_KEY } from "../src/utils/active-effect-keys.mjs";

test("Hunting Grounds accumulates AP and MP independently and caps Target at four", () => {
  const first = advanceHuntingGroundsMarks({
    marks: 1,
    maxMarks: 4,
    actionPointThreshold: 4,
    movementPointThreshold: 6,
    actionPointProgress: 3,
    movementPointProgress: 5
  }, {
    actionPoints: 1,
    movementPoints: 1
  });
  assert.deepEqual(first, {
    marks: 3,
    maxMarks: 4,
    actionPointThreshold: 4,
    movementPointThreshold: 6,
    actionPointProgress: 0,
    movementPointProgress: 0,
    gainedMarks: 2,
    completedThresholds: 2
  });

  const capped = advanceHuntingGroundsMarks(first, { actionPoints: 40, movementPoints: 60 });
  assert.equal(capped.marks, 4);
  assert.equal(capped.gainedMarks, 1);
});

test("each Hunting Grounds Target mark is represented by ordinary effect changes", () => {
  const changes = buildPreyEffectChanges(2, 20, 40);
  assert.deepEqual(changes, [
    {
      key: "fallout-maw.reverse.system.combat.damagePercent",
      type: "add",
      value: "40",
      phase: "initial",
      priority: null
    },
    {
      key: "system.combat.accuracy",
      type: "add",
      value: "80",
      phase: "initial",
      priority: null
    },
    {
      key: ATTACK_CRITICAL_FAILURE_DISABLED_EFFECT_KEY,
      type: "add",
      value: "1",
      phase: "initial",
      priority: null
    }
  ]);
  assert.deepEqual(buildPreyEffectChanges(0, 20, 40), []);
});

test("Hunting Grounds builds a native grid-based 20x20x20m volume", () => {
  globalThis.CONST = { REGION_VISIBILITY: { ALWAYS: 2 } };
  globalThis.game = { time: { worldTime: 100 } };
  const levelDocuments = [
    { id: "level-a", elevation: { bottom: 0, top: 100 } },
    { id: "level-open", elevation: { bottom: null, top: null } }
  ];
  const data = createHuntingGroundsSquareRegionData({
    scene: {
      grid: { size: 100, distance: 2 },
      levels: {
        contents: levelDocuments,
        has: id => levelDocuments.some(level => level.id === id)
      }
    },
    center: { x: 600, y: 800, levelId: "level-a", elevationCenter: 50 },
    abilityItem: { id: "ability", name: "Охотничьи угодья" },
    runtime: {
      zoneSizeMeters: 20,
      checkIntervalSeconds: 6,
      durationSeconds: 30
    },
    identifiers: {
      sessionId: "session",
      sourceActorUuid: "Actor.hunter",
      createdAt: 100,
      expiresAt: 130
    }
  });
  assert.deepEqual(data.shapes, [{
    type: "rectangle",
    x: 600,
    y: 800,
    width: 1000,
    height: 1000,
    anchorX: 0.5,
    anchorY: 0.5,
    rotation: 0,
    gridBased: true
  }]);
  assert.deepEqual(data.levels, ["level-a", "level-open"]);
  assert.deepEqual(data.elevation, { bottom: 40, top: 60, topInclusive: true });
  assert.equal(data.flags["fallout-maw"].huntingGroundsRegion.nextCheckAt, 106);
});

test("Hunting Grounds detects real cross-level entry without false native segments", () => {
  globalThis.CONST = {
    ...globalThis.CONST,
    REGION_MOVEMENT_SEGMENTS: { ENTER: 1 }
  };
  const segmentCalls = [];
  const token = {
    _source: { level: "level-a" },
    testInsideRegion: (_region, waypoint) => Boolean(waypoint.inside),
    segmentizeRegionMovementPath: (_region, pair) => {
      segmentCalls.push(pair);
      return pair[1].crosses ? [{ type: 1 }] : [];
    }
  };
  const region = {};

  assert.equal(movementPathEntersHuntingGroundsRegion(token, region, [
    { level: "level-outside", inside: false },
    { level: "level-a", inside: true }
  ]), true);
  assert.equal(segmentCalls.length, 0, "native segmentization must not rewrite a cross-level pair");

  assert.equal(movementPathEntersHuntingGroundsRegion(token, region, [
    { level: "level-a", inside: true },
    { level: "level-outside", inside: false, crosses: true }
  ]), false);
  assert.equal(segmentCalls.length, 0, "leaving for another level must not create a false ENTER");

  assert.equal(movementPathEntersHuntingGroundsRegion(token, region, [
    { level: "level-a", inside: false },
    { level: "level-a", inside: false, crosses: true }
  ]), true);
  assert.equal(segmentCalls.length, 1, "same-level pass-through must use native Region segmentation");
});

test("Hunting Grounds runtime is event-indexed and uses V14 perception and Region APIs", async () => {
  const source = await readFile(new URL("../src/abilities/hunting-grounds.mjs", import.meta.url), "utf8");
  assert.equal(HUNTING_GROUNDS_DETECTION_MODE_ID, "huntingGrounds");
  assert.match(source, /registerQueuedWorldTimeProcessor\(processHuntingGroundsWorldTime/);
  assert.match(source, /const RESOURCE_EVENT_KEY = "fallout-maw\.combat\.resource\.spent"/);
  assert.match(source, /registerSystemEventObserver\(\{[\s\S]*eventKeys: \[RESOURCE_EVENT_KEY\]/);
  assert.match(source, /movementPathEntersHuntingGroundsRegion\(tokenDocument, region, path\)/);
  assert.match(source, /fromLevel === toLevel[\s\S]*segmentizeRegionMovementPath\(region, \[/);
  assert.match(source, /class HuntingGroundsDetectionMode extends DetectionModeAll/);
  assert.match(source, /walls: false,[\s\S]*angle: false/);
  assert.match(source, /detectableHuntersByTargetToken\.get\(targetUuid\)\?\.get\(sourceUuid\)/);
  assert.match(source, /getActorFactionRelation\(sourceActor, targetActor\) === "ally"/);
  assert.doesNotMatch(source, /getActorFactionRelation\(sourceActor, targetActor\) !== "enemy"/);
  assert.match(source, /getReverseEffectKey\("system\.combat\.damagePercent"\)/);
  assert.match(source, /data\.marks >= data\.maxMarks/);
  assert.match(source, /queuePreyEffectMutation/);
  assert.doesNotMatch(source, /setInterval\s*\(/);
});
