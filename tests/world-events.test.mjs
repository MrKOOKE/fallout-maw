import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGlobalMapDiscoveryEvents,
  classifyCampStateTransitions,
  classifyNeedThresholdTransitions
} from "../src/events/foundry-world-events.mjs";

test("need threshold classifier reports every exact entered and left boundary", () => {
  const settings = [{
    key: "hunger",
    settings: {
      thresholds: [
        { id: "warning", percent: 25 },
        { id: "danger", percent: 75 }
      ]
    }
  }];

  const entered = classifyNeedThresholdTransitions({
    beforeNeeds: { hunger: { min: 0, max: 100, value: 10 } },
    afterNeeds: { hunger: { min: 0, max: 100, value: 90 } },
    needSettings: settings
  });
  assert.deepEqual(entered.map(event => [event.key, event.thresholdId]), [
    ["fallout-maw.actor.need.thresholdEntered", "warning"],
    ["fallout-maw.actor.need.thresholdEntered", "danger"]
  ]);

  const left = classifyNeedThresholdTransitions({
    beforeNeeds: { hunger: { min: 0, max: 100, value: 90 } },
    afterNeeds: { hunger: { min: 0, max: 100, value: 10 } },
    needSettings: settings
  });
  assert.deepEqual(left.map(event => [event.key, event.thresholdId]), [
    ["fallout-maw.actor.need.thresholdLeft", "warning"],
    ["fallout-maw.actor.need.thresholdLeft", "danger"]
  ]);
});

test("camp state classifier emits only concrete lifecycle transitions", () => {
  const started = classifyCampStateTransitions(
    { active: false, id: "", participants: [] },
    { active: true, id: "camp-1", participants: [{ actorUuid: "Actor.A" }, { actorUuid: "Actor.B" }] }
  );
  assert.deepEqual(started.map(event => [event.key, event.actorUuid]), [
    ["fallout-maw.camp.started", ""],
    ["fallout-maw.camp.participantJoined", "Actor.A"],
    ["fallout-maw.camp.participantJoined", "Actor.B"]
  ]);

  const changed = classifyCampStateTransitions(
    { active: true, id: "camp-1", participants: [{ actorUuid: "Actor.A" }, { actorUuid: "Actor.B" }] },
    { active: true, id: "camp-1", participants: [{ actorUuid: "Actor.B" }, { actorUuid: "Actor.C" }] }
  );
  assert.deepEqual(changed.map(event => [event.key, event.actorUuid]), [
    ["fallout-maw.camp.participantJoined", "Actor.C"],
    ["fallout-maw.camp.participantLeft", "Actor.A"]
  ]);

  const closed = classifyCampStateTransitions(
    { active: true, id: "camp-1", participants: [{ actorUuid: "Actor.B" }] },
    { active: false, id: "", participants: [] }
  );
  assert.deepEqual(closed.map(event => event.key), [
    "fallout-maw.camp.participantLeft",
    "fallout-maw.camp.closed"
  ]);
});

test("global-map discovery builder keeps kinds separate and never invents a target", () => {
  const events = buildGlobalMapDiscoveryEvents({
    scene: { id: "scene", uuid: "Scene.scene" },
    locations: [{ id: "loc", name: "Vault" }],
    transitions: [{ id: "transition", name: "Road" }],
    exits: [{ id: "exit", name: "Gate" }]
  });
  assert.deepEqual(events.map(event => event.key), [
    "fallout-maw.globalMap.location.discovered",
    "fallout-maw.globalMap.transition.discovered",
    "fallout-maw.globalMap.exit.discovered"
  ]);
  assert.ok(events.every(event => !Object.hasOwn(event, "target")));
});
