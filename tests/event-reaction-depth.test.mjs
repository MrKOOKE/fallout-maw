import assert from "node:assert/strict";
import test from "node:test";

import {
  eventReactionDepthFiltersMatch,
  eventReactionExpectedResultsMatch,
  eventReactionSubscriptionMatches,
  getEventReactionDepthProfile
} from "../src/events/event-reaction-schema.mjs";

test("completed checks combine skill and any of four expected results", () => {
  const envelope = {
    key: "fallout-maw.skill.check.resolved",
    data: { skillKey: "athletics", resultKey: "criticalSuccess" }
  };

  assert.equal(eventReactionExpectedResultsMatch({ eventKey: envelope.key, expectedResultKeys: [] }, envelope), true);
  assert.equal(eventReactionExpectedResultsMatch({ eventKey: envelope.key, expectedResultKeys: ["success", "criticalSuccess"] }, envelope), true);
  assert.equal(eventReactionExpectedResultsMatch({ eventKey: envelope.key, expectedResultKeys: ["failure"] }, envelope), false);
  assert.equal(eventReactionExpectedResultsMatch({ eventKey: envelope.key, expectedResultKeys: ["failure"] }, {
    key: envelope.key,
    data: { skillKey: "athletics", resultKey: "" },
    outcome: { cancelled: true, status: "cancelled" }
  }), false);
  assert.equal(eventReactionExpectedResultsMatch({ eventKey: "fallout-maw.skill.check.beforeRoll", expectedResultKeys: ["criticalSuccess"] }, {
    key: "fallout-maw.skill.check.beforeRoll",
    data: { skill: { key: "athletics" } }
  }), true);

  assert.equal(eventReactionSubscriptionMatches(
    {
      eventKey: envelope.key,
      skillKeys: ["athletics"],
      expectedResultKeys: ["criticalSuccess"],
      trackingTargets: []
    },
    envelope,
    "Actor.A",
    { reactorActor: { uuid: "Actor.A" }, sourceActor: { uuid: "Actor.A" }, targetActor: null }
  ), true);
});

test("depth profiles match only details backed by real emitted payloads", () => {
  const skillProfile = getEventReactionDepthProfile("fallout-maw.skill.check.resolved");
  assert.equal(skillProfile.skillKeys, true);
  assert.equal(skillProfile.expectedResultKeys, true);
  assert.ok(skillProfile.filters.some(filter => filter.storageKey === "weaponActionKeys"));

  const damagePreparedProfile = getEventReactionDepthProfile("fallout-maw.weapon.attack.damagePrepared");
  assert.ok(damagePreparedProfile.filters.some(filter => filter.storageKey === "damageTypeKeys"));
  assert.ok(damagePreparedProfile.filters.some(filter => filter.storageKey === "limbKeys"));
  assert.equal(damagePreparedProfile.filters.some(filter => filter.storageKey === "damageScopeKeys"), false);

  const unknownLegacyProfile = getEventReactionDepthProfile("fallout-maw.skill.check.removedLegacy");
  assert.equal(unknownLegacyProfile.skillKeys, false);
  assert.equal(unknownLegacyProfile.expectedResultKeys, false);
  assert.deepEqual(unknownLegacyProfile.filters, []);

  assert.equal(eventReactionDepthFiltersMatch({
    eventKey: "fallout-maw.skill.check.resolved",
    eventFilters: { weaponActionKeys: ["burst"] }
  }, {
    key: "fallout-maw.skill.check.resolved",
    data: { weaponActionKey: "burst" }
  }), true);
  assert.equal(eventReactionDepthFiltersMatch({
    eventKey: "fallout-maw.skill.check.resolved",
    eventFilters: { weaponActionKeys: ["aimedShot"] }
  }, {
    key: "fallout-maw.skill.check.resolved",
    data: { weaponActionKey: "burst" }
  }), false);

  assert.equal(eventReactionDepthFiltersMatch({
    eventKey: "fallout-maw.damage.resolved",
    eventFilters: {
      damageTypeKeys: ["fire"],
      damageScopeKeys: ["limb"],
      limbKeys: ["leftArm"]
    }
  }, {
    key: "fallout-maw.damage.resolved",
    data: { damageTypeKey: "fire", scope: "limb", limbKey: "leftArm" }
  }), true);

  assert.equal(eventReactionDepthFiltersMatch({
    eventKey: "fallout-maw.combat.resource.spent",
    eventFilters: { resourceKeys: ["actionPoints"] }
  }, {
    key: "fallout-maw.combat.resource.spent",
    data: { resources: { actionPoints: 3, movementPoints: 0 } }
  }), true);

  assert.equal(eventReactionDepthFiltersMatch({
    eventKey: "fallout-maw.trap.detection.resolved",
    eventFilters: { trapDetectedValues: ["true"] }
  }, {
    key: "fallout-maw.trap.detection.resolved",
    data: { detected: true, skillKey: "perception" }
  }), true);
  assert.equal(eventReactionDepthFiltersMatch({
    eventKey: "fallout-maw.trap.detection.resolved",
    eventFilters: { trapDetectedValues: ["false"] }
  }, {
    key: "fallout-maw.trap.detection.resolved",
    data: { detected: true, skillKey: "perception" }
  }), false);
});
