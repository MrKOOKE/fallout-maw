import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SYSTEM_EVENT_CATALOG,
  SYSTEM_EVENT_CATALOG_BY_KEY,
  SYSTEM_EVENT_CATALOG_VERSION,
  SYSTEM_EVENT_GROUPS,
  SYSTEM_EVENT_PHASES,
  SYSTEM_EVENT_ROLES,
  SYSTEM_EVENT_SUBJECTS,
  getSelectableSystemEvents,
  getSystemEventDescriptor,
  serializeSystemEventPayload
} from "../src/events/catalog.mjs";

const EXPECTED_EVENT_COUNT = 206;
const EVENT_KEY_PATTERN = /^fallout-maw\.[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/;
const REACTION_UI_PATHS = Object.freeze([
  "ConditionLabel",
  "Settings",
  "DurationSeconds",
  "Costs",
  "AddCost",
  "Resource",
  "Formula",
  "NoCosts",
  "Event",
  "SelectEvent",
  "ReactorRole",
  "EventSubject",
  "Phase",
  "Roles",
  "Unsupported",
  "UnsupportedGroup",
  "UnsupportedCondition",
  "UnsupportedEvent",
  "UnsupportedPenalties",
  "Unknown",
  "UnknownEventDescription",
  "Title",
  "Opportunity",
  "MovementLocked",
  "Accept",
  "Decline",
  "DeclineAll",
  "CostSummary",
  "CostUnavailable",
  "ReactorRoles.Source",
  "ReactorRoles.Target",
  "ReactorRoles.Observer",
  "ReactorRoles.Any",
  "EventSubjects.Reactor",
  "EventSubjects.EventSource",
  "EventSubjects.EventTarget",
  "Resources.ReactionPoints",
  "CostErrors.InvalidFormula",
  "CostErrors.MissingResourceKey",
  "CostErrors.UnknownResourceKey",
  "CostErrors.MissingResource",
  "CostErrors.InsufficientResource",
  "CostErrors.StaleQuote",
  "CostErrors.SpendFailed"
]);

async function loadLocalization(language) {
  const url = new URL(`../lang/${language}.json`, import.meta.url);
  return JSON.parse(await readFile(url, "utf8"));
}

function getLocalizationValue(localization, key) {
  return key.split(".").reduce((value, segment) => value?.[segment], localization);
}

function assertNonemptyLocalization(localization, key, language) {
  const value = getLocalizationValue(localization, key);
  assert.equal(typeof value, "string", `${language} localization is missing ${key}`);
  assert.notEqual(value.trim(), "", `${language} localization is empty for ${key}`);
}

test("v1 catalog has unique immutable descriptors and stable lookup", () => {
  assert.equal(SYSTEM_EVENT_CATALOG_VERSION, 1);
  assert.equal(SYSTEM_EVENT_CATALOG.length, EXPECTED_EVENT_COUNT);
  assert.ok(Object.isFrozen(SYSTEM_EVENT_CATALOG));
  assert.ok(Object.isFrozen(SYSTEM_EVENT_CATALOG_BY_KEY));

  const keys = SYSTEM_EVENT_CATALOG.map(event => event.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(Object.keys(SYSTEM_EVENT_CATALOG_BY_KEY), keys);

  for (const event of SYSTEM_EVENT_CATALOG) {
    assert.match(event.key, EVENT_KEY_PATTERN);
    assert.equal(event.catalogVersion, SYSTEM_EVENT_CATALOG_VERSION);
    assert.ok(Object.isFrozen(event));
    assert.ok(Object.isFrozen(event.capabilities));
    assert.ok(Object.isFrozen(event.allowedPatchPaths));
    assert.ok(Object.isFrozen(event.roles));
    assert.deepEqual(event.capabilities, SYSTEM_EVENT_PHASES[event.phase].capabilities);
    assert.equal(typeof event.serialize, "function");
    assert.equal(event.groupLabelKey, SYSTEM_EVENT_GROUPS[event.group].labelKey);
    assert.ok(SYSTEM_EVENT_GROUPS[event.group]);
    assert.ok(SYSTEM_EVENT_SUBJECTS[event.subject]);
    assert.ok(event.roles.length > 0);
    for (const role of event.roles) assert.ok(SYSTEM_EVENT_ROLES[role]);
    assert.equal(getSystemEventDescriptor(event.key), event);
  }

  assert.equal(getSystemEventDescriptor("fallout-maw.unknown.event"), null);
  assert.equal(getSystemEventDescriptor(null), null);
  assert.equal(
    getSystemEventDescriptor("  fallout-maw.actor.health.changed  ")?.key,
    "fallout-maw.actor.health.changed"
  );
});

test("v1 phases expose the exact synchronous and awaited capability contract", () => {
  const contract = Object.fromEntries(Object.entries(SYSTEM_EVENT_PHASES).map(([phase, descriptor]) => [phase, {
    capabilities: [...descriptor.capabilities],
    selectable: descriptor.selectable,
    awaitable: descriptor.awaitable
  }]));
  assert.deepEqual(contract, {
    pre: {
      capabilities: ["observe", "react", "patch", "cancelCurrent", "cancelRemaining"],
      selectable: true,
      awaitable: true
    },
    gate: {
      capabilities: ["observe", "react", "cancelCurrent", "cancelRemaining"],
      selectable: true,
      awaitable: true
    },
    query: {
      capabilities: ["observe", "patch"],
      selectable: false,
      awaitable: false
    },
    enginePre: {
      capabilities: ["observe", "cancelCurrent"],
      selectable: false,
      awaitable: false
    },
    committed: {
      capabilities: ["observe", "react"],
      selectable: true,
      awaitable: false
    },
    transition: {
      capabilities: ["observe", "react"],
      selectable: true,
      awaitable: false
    }
  });

  assert.equal(getSystemEventDescriptor("fallout-maw.weapon.attack.damagePrepared")?.phase, "gate");
  assert.equal(getSystemEventDescriptor("fallout-maw.movement.token.before")?.phase, "enginePre");
  for (const key of [
    "fallout-maw.weapon.action.modifiers",
    "fallout-maw.weapon.attack.duplicateRequested",
    "fallout-maw.damage.mitigation.calculated",
    "fallout-maw.combat.grapple.modifiers"
  ]) {
    const descriptor = getSystemEventDescriptor(key);
    assert.equal(descriptor?.phase, "query");
    assert.deepEqual(descriptor?.allowedPatchPaths, ["/data/*"]);
  }
});

test("catalog serializer rejects non-JSON runtime objects instead of silently coercing them", () => {
  class FakeFoundryDocument {
    toJSON() {
      return { uuid: "Actor.fake" };
    }
  }
  class FakeRoll {
    toJSON() {
      return { total: 10 };
    }
  }
  const cyclic = { value: 1 };
  cyclic.self = cyclic;

  const forbidden = [
    new FakeFoundryDocument(),
    new FakeRoll(),
    new Map([["value", 1]]),
    new Set([1]),
    () => 1,
    cyclic,
    { nested: undefined }
  ];
  for (const value of forbidden) {
    assert.throws(() => serializeSystemEventPayload({ value }), /forbidden/i);
  }

  const source = { nested: { values: [1, "two", false, null] } };
  const serialized = serializeSystemEventPayload(source);
  assert.deepEqual(serialized, source);
  assert.notEqual(serialized, source);
  assert.notEqual(serialized.nested, source.nested);
});

test("reaction-selectable catalog excludes synchronous engine and calculation phases", () => {
  const selectable = getSelectableSystemEvents();
  assert.ok(Object.isFrozen(selectable));
  assert.equal(getSelectableSystemEvents(), selectable);
  assert.deepEqual(selectable, SYSTEM_EVENT_CATALOG.filter(event => event.selectable));

  const selectableKeys = new Set(selectable.map(event => event.key));
  assert.ok(selectableKeys.has("fallout-maw.skill.check.beforeRoll"));
  assert.ok(!selectableKeys.has("fallout-maw.combat.reaction.requested"));
  assert.ok(!selectableKeys.has("fallout-maw.combat.reaction.resolved"));
  assert.ok(!selectableKeys.has("fallout-maw.movement.token.interruptionRequested"));
  assert.ok(selectableKeys.has("fallout-maw.vision.target.gained"));
  assert.ok(selectableKeys.has("fallout-maw.movement.token.completed"));

  assert.ok(!selectableKeys.has("fallout-maw.movement.token.before"));
  assert.ok(!selectableKeys.has("fallout-maw.weapon.action.modifiers"));
  assert.ok(!selectableKeys.has("fallout-maw.weapon.attack.duplicateRequested"));
  assert.ok(!selectableKeys.has("fallout-maw.damage.mitigation.calculated"));

  for (const event of selectable) {
    assert.ok(["pre", "gate", "committed", "transition"].includes(event.phase));
  }
});

test("catalog covers every approved gameplay domain", () => {
  const requiredKeys = [
    "fallout-maw.actor.health.changed",
    "fallout-maw.skill.check.resolved",
    "fallout-maw.ability.application.before",
    "fallout-maw.research.completed",
    "fallout-maw.organismDevelopment.upgraded",
    "fallout-maw.combat.turn.beforeStart",
    "fallout-maw.combat.grapple.modifiers",
    "fallout-maw.weapon.attack.resolved",
    "fallout-maw.damage.resolved",
    "fallout-maw.inventory.item.transfer.transferred",
    "fallout-maw.inventory.currency.transfer.transferred",
    "fallout-maw.craft.create.resolved",
    "fallout-maw.repair.resolved",
    "fallout-maw.medicine.treatment.resolved",
    "fallout-maw.hacking.resolved",
    "fallout-maw.butchering.resolved",
    "fallout-maw.movement.token.completed",
    "fallout-maw.movement.token.beforeStart",
    "fallout-maw.movement.token.leavingAdjacency",
    "fallout-maw.region.token.entered",
    "fallout-maw.stealth.enter.entered",
    "fallout-maw.stealth.reveal.revealed",
    "fallout-maw.vision.target.gained",
    "fallout-maw.environment.lightNetwork.changed",
    "fallout-maw.trap.trigger.triggered",
    "fallout-maw.globalMap.location.discovered",
    "fallout-maw.world.time.advanced",
    "fallout-maw.camp.rest.completed",
    "fallout-maw.travel.arrival.completed"
  ];

  for (const key of requiredKeys) {
    assert.ok(getSystemEventDescriptor(key), `catalog is missing ${key}`);
  }

  for (const obsoleteKey of [
    "fallout-maw.inventory.item.transferred",
    "fallout-maw.inventory.currency.transferred",
    "fallout-maw.stealth.entered",
    "fallout-maw.stealth.revealed",
    "fallout-maw.trap.triggered"
  ]) {
    assert.equal(getSystemEventDescriptor(obsoleteKey), null, `obsolete shortened key remains: ${obsoleteKey}`);
  }

  for (const aggregateKey of [
    "fallout-maw.skill.batch.resolved",
    "fallout-maw.damage.batch.resolved",
    "fallout-maw.repair.batch.resolved"
  ]) {
    assert.equal(getSystemEventDescriptor(aggregateKey)?.targetAtomic, false);
  }

  assert.deepEqual(
    new Set(SYSTEM_EVENT_CATALOG.map(event => event.group)),
    new Set(Object.keys(SYSTEM_EVENT_GROUPS))
  );
});

test("English and Russian provide every catalog UI localization", async () => {
  const [english, russian] = await Promise.all([
    loadLocalization("en"),
    loadLocalization("ru")
  ]);

  for (const [language, localization] of [["en", english], ["ru", russian]]) {
    for (const descriptor of Object.values(SYSTEM_EVENT_GROUPS)) {
      assertNonemptyLocalization(localization, descriptor.labelKey, language);
    }
    for (const descriptor of Object.values(SYSTEM_EVENT_PHASES)) {
      assertNonemptyLocalization(localization, descriptor.labelKey, language);
      assertNonemptyLocalization(localization, descriptor.descriptionKey, language);
    }
    for (const descriptor of Object.values(SYSTEM_EVENT_ROLES)) {
      assertNonemptyLocalization(localization, descriptor.labelKey, language);
    }
    for (const descriptor of Object.values(SYSTEM_EVENT_SUBJECTS)) {
      assertNonemptyLocalization(localization, descriptor.labelKey, language);
    }
    for (const event of SYSTEM_EVENT_CATALOG) {
      assertNonemptyLocalization(localization, event.labelKey, language);
      assertNonemptyLocalization(localization, event.descriptionKey, language);
    }
    for (const path of REACTION_UI_PATHS) {
      assertNonemptyLocalization(localization, `FALLOUTMAW.Events.Reaction.${path}`, language);
    }
  }

  const englishEvents = english.FALLOUTMAW.Events;
  const russianEvents = russian.FALLOUTMAW.Events;
  for (const section of ["Groups", "Phases", "Roles", "Subjects", "Entries"]) {
    assert.deepEqual(
      Object.keys(englishEvents[section]).sort(),
      Object.keys(russianEvents[section]).sort(),
      `${section} localization keys differ between en and ru`
    );
  }

  const usedEntryKeys = new Set(SYSTEM_EVENT_CATALOG.map(event => event.labelKey.split(".").at(-2)));
  assert.deepEqual(new Set(Object.keys(englishEvents.Entries)), usedEntryKeys);
  assert.deepEqual(new Set(Object.keys(russianEvents.Entries)), usedEntryKeys);
});
