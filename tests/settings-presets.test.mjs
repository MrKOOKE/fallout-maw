import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";

import {
  MAIN_PRESET_ID,
  PRESET_FORMAT,
  PRESET_SCHEMA_VERSION,
  canonicalStringify,
  clonePresetFromMain,
  computePresetRevision,
  convertLegacyBaseline,
  createPresetDocument,
  createPresetSave,
  createPresetTombstone,
  normalizePresetDocument,
  reconcilePresetSources
} from "../src/settings/presets/schema.mjs";

const WORLD_SETTING = "fallout-maw.example";

const BUNDLED_PRESET_SETTING_IDS = Object.freeze([
  "fallout-maw.abilitiesCatalog",
  "fallout-maw.alignment",
  "fallout-maw.attributeColor",
  "fallout-maw.attributeColor2",
  "fallout-maw.attributeColorPortrait",
  "fallout-maw.attributeVisibility",
  "fallout-maw.attributes",
  "fallout-maw.barsPlacement",
  "fallout-maw.campSettings",
  "fallout-maw.carouselStyle",
  "fallout-maw.characteristics",
  "fallout-maw.combatSettings",
  "fallout-maw.coverSettings",
  "fallout-maw.creatureOptions",
  "fallout-maw.currencySettings",
  "fallout-maw.damageTypes",
  "fallout-maw.direction",
  "fallout-maw.diseaseSettings",
  "fallout-maw.displayDescriptions",
  "fallout-maw.displayName",
  "fallout-maw.factionMatrix",
  "fallout-maw.factionSettings",
  "fallout-maw.floatingSize",
  "fallout-maw.globalMapTravelImage",
  "fallout-maw.globalMapTravelSpeedFormula",
  "fallout-maw.hideConflictingUIs",
  "fallout-maw.hideDefeated",
  "fallout-maw.hideEnemyInitiative",
  "fallout-maw.hideFirstRound",
  "fallout-maw.itemCategories",
  "fallout-maw.levels",
  "fallout-maw.personalGeneratorPresets",
  "fallout-maw.personalNameRandomizer",
  "fallout-maw.playerPlayerPermission",
  "fallout-maw.portraitAspect",
  "fallout-maw.portraitImage",
  "fallout-maw.portraitImageBackground",
  "fallout-maw.portraitImageBorder",
  "fallout-maw.portraitResource",
  "fallout-maw.proficiencySettings",
  "fallout-maw.resource",
  "fallout-maw.resourceSettings",
  "fallout-maw.roundness",
  "fallout-maw.showDispositionColor",
  "fallout-maw.showInitiativeOnPortrait",
  "fallout-maw.showSystemIcons",
  "fallout-maw.skillCheckControl",
  "fallout-maw.skillDevelopmentCosts",
  "fallout-maw.skillSettings",
  "fallout-maw.stealthSettings",
  "fallout-maw.systemActionSettings",
  "fallout-maw.timeMechanicsIgnored",
  "fallout-maw.timeNeedsPlayersOnly",
  "fallout-maw.tokenActionHudDamageIcons",
  "fallout-maw.tokenHudEquipmentSlotsEnabled",
  "fallout-maw.tokenPrototypeDefaults",
  "fallout-maw.toolSettings",
  "fallout-maw.traumaSettings"
]);

function setting(id = WORLD_SETTING, value = { enabled: true }) {
  return { id, scope: "world", value };
}

function rawPreset(overrides = {}) {
  return {
    format: PRESET_FORMAT,
    schemaVersion: PRESET_SCHEMA_VERSION,
    systemId: "fallout-maw",
    id: "example-preset",
    name: "Example preset",
    systemVersion: "0.2.0",
    seedPending: false,
    deleted: false,
    settings: [setting()],
    ...overrides
  };
}

test("preset schema constants are stable", () => {
  assert.equal(PRESET_FORMAT, "fallout-maw-settings-preset");
  assert.equal(PRESET_SCHEMA_VERSION, 1);
  assert.equal(MAIN_PRESET_ID, "fallout-maw");
});

test("bundled main and migration seed preserve the managed settings contract", () => {
  const documents = [
    JSON.parse(fs.readFileSync(new URL("../storage/settings-presets/fallout-maw.json", import.meta.url), "utf8")),
    JSON.parse(fs.readFileSync(new URL("../storage/settings-presets/fallout-maw-migration-seed.json", import.meta.url), "utf8"))
  ];
  const expectedIds = [...BUNDLED_PRESET_SETTING_IDS].sort();
  const expectedShapeCounts = {
    object: 18,
    array: 9,
    string: 17,
    number: 4,
    boolean: 10
  };
  const documentIdSets = [];

  for (const document of documents) {
    assert.equal(document.settings.length, 58);

    const ids = document.settings.map(entry => entry.id);
    assert.equal(new Set(ids).size, 58);
    assert.deepEqual([...ids].sort(), expectedIds);
    documentIdSets.push([...ids].sort());

    const shapeCounts = Object.fromEntries(Object.keys(expectedShapeCounts).map(shape => [shape, 0]));
    for (const entry of document.settings) {
      const shape = Array.isArray(entry.value) ? "array" : typeof entry.value;
      assert.ok(Object.hasOwn(shapeCounts, shape), `${entry.id} has unsupported JSON shape ${shape}`);
      shapeCounts[shape] += 1;
    }
    assert.deepEqual(shapeCounts, expectedShapeCounts);

    const showSystemIcons = document.settings.find(entry => entry.id === "fallout-maw.showSystemIcons")?.value;
    assert.equal(typeof showSystemIcons, "number");
    assert.equal(Number.isFinite(showSystemIcons), true);
    assert.equal(Number.isInteger(showSystemIcons), true);
    assert.ok(showSystemIcons >= 0 && showSystemIcons <= 3);
  }

  assert.deepEqual(documentIdSets[0], documentIdSets[1]);
});

test("canonicalStringify recursively sorts object keys and preserves array order", () => {
  const first = {
    z: 3,
    a: [{ y: 2, x: 1 }, "text"],
    nested: { beta: false, alpha: null }
  };
  const second = {
    nested: { alpha: null, beta: false },
    a: [{ x: 1, y: 2 }, "text"],
    z: 3
  };

  const expected = "{\"a\":[{\"x\":1,\"y\":2},\"text\"],\"nested\":{\"alpha\":null,\"beta\":false},\"z\":3}";
  assert.equal(canonicalStringify(first), expected);
  assert.equal(canonicalStringify(second), expected);
});

test("canonicalStringify accepts repeated references but rejects non-JSON data", () => {
  const shared = { value: 1 };
  assert.equal(
    canonicalStringify({ left: shared, right: shared }),
    "{\"left\":{\"value\":1},\"right\":{\"value\":1}}"
  );

  const circular = {};
  circular.self = circular;
  const sparse = [];
  sparse.length = 1;

  for (const unsafe of [undefined, 1n, Number.NaN, Infinity, new Date(), sparse, circular]) {
    assert.throws(() => canonicalStringify(unsafe), /JSON|finite|plain object|sparse|circular/i);
  }
});

test("computePresetRevision matches Node SHA-256 and ignores only volatile top-level fields", async () => {
  const preset = createPresetDocument({
    id: "hash-test",
    name: "Hash test",
    systemVersion: "1.2.3",
    settings: [setting(WORLD_SETTING, { z: 2, a: [1, 3] })]
  });
  const { revision: _revision, updatedAt: _updatedAt, ...stable } = preset;
  const expected = crypto
    .createHash("sha256")
    .update(canonicalStringify(stable))
    .digest("hex");

  assert.equal(await computePresetRevision(preset), expected);
  assert.equal(preset.revision, expected);
  assert.equal(await computePresetRevision({ ...preset, revision: "ignored", updatedAt: "ignored" }), expected);

  const changed = structuredClone(preset);
  changed.settings[0].value.a.push(4);
  assert.notEqual(await computePresetRevision(changed), expected);
});

test("normalizePresetDocument accepts system alias and returns a sorted detached canonical document", () => {
  const rawValue = { z: 2, a: { b: true, a: false } };
  const normalized = normalizePresetDocument({
    format: PRESET_FORMAT,
    schemaVersion: 1,
    system: "fallout-maw",
    id: "User_123",
    name: "  Пользовательский  ",
    settings: [
      setting("fallout-maw.zSetting", rawValue),
      setting("fallout-maw.aSetting", 5)
    ]
  });

  assert.deepEqual(Object.keys(normalized), [
    "format",
    "schemaVersion",
    "systemId",
    "id",
    "name",
    "revision",
    "updatedAt",
    "systemVersion",
    "seedPending",
    "deleted",
    "settings"
  ]);
  assert.equal(normalized.systemId, "fallout-maw");
  assert.equal(normalized.name, "Пользовательский");
  assert.equal(normalized.updatedAt, null);
  assert.equal(normalized.systemVersion, null);
  assert.equal(normalized.seedPending, false);
  assert.equal(normalized.deleted, false);
  assert.match(normalized.revision, /^[a-f0-9]{64}$/);
  assert.deepEqual(normalized.settings.map(entry => entry.id), [
    "fallout-maw.aSetting",
    "fallout-maw.zSetting"
  ]);

  rawValue.a.a = true;
  assert.equal(normalized.settings[1].value.a.a, false);
});

test("normalizePresetDocument verifies supplied revisions and survives a JSON round trip", async () => {
  const created = createPresetDocument({
    id: "round-trip",
    name: "Round trip",
    settings: [setting(WORLD_SETTING, { nested: [true, null, "текст"] })],
    systemVersion: "0.2.0",
    seedPending: true
  });
  const parsed = JSON.parse(JSON.stringify(created));
  const normalized = normalizePresetDocument(parsed);

  assert.deepEqual(normalized, created);
  assert.equal(await computePresetRevision(normalized), normalized.revision);
  assert.throws(
    () => normalizePresetDocument({ ...parsed, name: "Tampered" }),
    /invalid revision/i
  );
});

test("normalizePresetDocument rejects invalid document metadata", () => {
  const cases = [
    [null, /plain object/i],
    [rawPreset({ format: "other" }), /format/i],
    [rawPreset({ schemaVersion: 2 }), /schemaVersion/i],
    [rawPreset({ schemaVersion: undefined }), /schemaVersion/i],
    [rawPreset({ systemId: "dnd5e" }), /systemId/i],
    [rawPreset({ system: "dnd5e" }), /must match/i],
    [rawPreset({ id: "../escape" }), /safe non-empty file id/i],
    [rawPreset({ id: "" }), /safe non-empty file id/i],
    [rawPreset({ name: "   " }), /printable/i],
    [rawPreset({ name: "bad\nname" }), /printable/i],
    [rawPreset({ systemVersion: 2 }), /systemVersion/i],
    [rawPreset({ seedPending: "yes" }), /seedPending/i],
    [rawPreset({ deleted: 1 }), /deleted/i],
    [rawPreset({ updatedAt: "not-a-date" }), /updatedAt/i],
    [rawPreset({ revision: "ABC" }), /revision/i],
    [{ ...rawPreset(), unexpected: true }, /unsupported key unexpected/i]
  ];

  for (const [raw, pattern] of cases) {
    assert.throws(() => normalizePresetDocument(raw), pattern);
  }
});

test("normalizePresetDocument strictly validates setting records and JSON-safe values", () => {
  const duplicate = [setting(), setting(WORLD_SETTING, false)];
  const noValue = { id: WORLD_SETTING, scope: "world" };
  const circular = {};
  circular.self = circular;
  const sparse = [];
  sparse.length = 1;

  const cases = [
    [rawPreset({ settings: {} }), /array/i],
    [rawPreset({ settings: duplicate }), /duplicate/i],
    [rawPreset({ settings: [setting("dnd5e.example")] }), /fallout-maw setting id/i],
    [rawPreset({ settings: [{ ...setting(), scope: "client" }] }), /world scope/i],
    [rawPreset({ settings: [noValue] }), /contain a value/i],
    [rawPreset({ settings: [{ ...setting(), extra: true }] }), /unsupported key extra/i],
    [rawPreset({ settings: [{ id: WORLD_SETTING, scope: "world", value: undefined }] }), /JSON-safe/i],
    [rawPreset({ settings: [setting(WORLD_SETTING, Number.NaN)] }), /JSON-safe/i],
    [rawPreset({ settings: [setting(WORLD_SETTING, new Map())] }), /JSON-safe/i],
    [rawPreset({ settings: [setting(WORLD_SETTING, sparse)] }), /JSON-safe/i],
    [rawPreset({ settings: [setting(WORLD_SETTING, circular)] }), /JSON-safe/i]
  ];

  for (const [raw, pattern] of cases) {
    assert.throws(() => normalizePresetDocument(raw), pattern);
  }
});

test("createPresetDocument produces a complete current document without retaining caller data", async () => {
  const value = { object: { enabled: true } };
  const preset = createPresetDocument({
    id: "created-preset",
    name: "Created preset",
    settings: [setting(WORLD_SETTING, value)],
    systemVersion: " 0.3.0 ",
    seedPending: true
  });

  assert.equal(preset.format, PRESET_FORMAT);
  assert.equal(preset.schemaVersion, 1);
  assert.equal(preset.systemId, "fallout-maw");
  assert.equal(preset.systemVersion, "0.3.0");
  assert.equal(preset.seedPending, true);
  assert.equal(preset.deleted, false);
  assert.match(preset.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(await computePresetRevision(preset), preset.revision);

  value.object.enabled = false;
  assert.equal(preset.settings[0].value.object.enabled, true);
});

test("createPresetTombstone retains identity, removes settings, and protects the main preset", async () => {
  const source = createPresetDocument({
    id: "delete-me",
    name: "Delete me",
    settings: [setting()],
    systemVersion: "0.2.0",
    seedPending: true
  });
  const tombstone = createPresetTombstone(source);

  assert.equal(tombstone.id, source.id);
  assert.equal(tombstone.name, source.name);
  assert.equal(tombstone.deleted, true);
  assert.equal(tombstone.seedPending, false);
  assert.deepEqual(tombstone.settings, []);
  assert.equal(await computePresetRevision(tombstone), tombstone.revision);

  const main = createPresetDocument({
    id: MAIN_PRESET_ID,
    name: "Fallout-MaW",
    settings: [setting()]
  });
  assert.throws(() => createPresetTombstone(main), /cannot be deleted/i);
  assert.throws(
    () => normalizePresetDocument(rawPreset({ id: MAIN_PRESET_ID, deleted: true, settings: [] })),
    /cannot be a tombstone/i
  );
  assert.throws(
    () => normalizePresetDocument(rawPreset({ deleted: true, settings: [setting()] })),
    /cannot contain settings/i
  );
  assert.throws(
    () => normalizePresetDocument(rawPreset({ deleted: true, seedPending: true, settings: [] })),
    /pending seed/i
  );
});

test("clonePresetFromMain creates an independent live preset from the main settings", () => {
  const main = createPresetDocument({
    id: MAIN_PRESET_ID,
    name: "Renamed main",
    settings: [setting(WORLD_SETTING, { nested: { count: 2 } })],
    systemVersion: "0.2.0",
    seedPending: true
  });
  const clone = clonePresetFromMain(main, { id: "world-copy", name: "World copy" });

  assert.equal(clone.id, "world-copy");
  assert.equal(clone.name, "World copy");
  assert.equal(clone.systemVersion, main.systemVersion);
  assert.equal(clone.seedPending, false);
  assert.equal(clone.deleted, false);
  assert.deepEqual(clone.settings, main.settings);

  clone.settings[0].value.nested.count = 9;
  assert.equal(main.settings[0].value.nested.count, 2);

  const notMain = createPresetDocument({ id: "other", name: "Other", settings: [] });
  assert.throws(
    () => clonePresetFromMain(notMain, { id: "new", name: "New" }),
    /only the live main/i
  );
  assert.throws(
    () => clonePresetFromMain(main, { id: MAIN_PRESET_ID, name: "Duplicate" }),
    /new id/i
  );
});

test("nested preset saves survive JSON round trips and are not copied into new presets", () => {
  const save = createPresetSave({
    id: "save-one",
    name: "Before changes",
    createdAt: "2026-07-14T12:00:00.000Z",
    systemVersion: "0.2.1",
    settings: [setting(WORLD_SETTING, { nested: { count: 1 } })]
  });
  const main = createPresetDocument({
    id: MAIN_PRESET_ID,
    name: "Fallout-MaW",
    settings: [setting(WORLD_SETTING, { nested: { count: 2 } })],
    saves: [save]
  });
  const normalized = normalizePresetDocument(JSON.parse(JSON.stringify(main)));

  assert.equal(normalized.saves.length, 1);
  assert.equal(normalized.saves[0].revision, save.revision);
  assert.deepEqual(normalized.saves[0].settings, save.settings);
  assert.throws(() => normalizePresetDocument({
    ...JSON.parse(JSON.stringify(main)),
    saves: [{ ...save, name: "Changed without revision" }]
  }), /invalid revision/i);

  const clone = clonePresetFromMain(main, { id: "clean-copy", name: "Clean copy" });
  assert.equal(clone.saves, undefined);
});

test("reconcilePresetSources makes system copies and tombstones authoritative", () => {
  const main = createPresetDocument({ id: MAIN_PRESET_ID, name: "Main", settings: [] });
  const systemShared = createPresetDocument({
    id: "shared",
    name: "System shared",
    settings: [setting(WORLD_SETTING, "system")]
  });
  const worldShared = createPresetDocument({
    id: "shared",
    name: "World shared",
    settings: [setting(WORLD_SETTING, "world")]
  });
  const liveGone = createPresetDocument({ id: "gone", name: "Gone", settings: [] });
  const systemTombstone = createPresetTombstone(liveGone);
  const worldOnly = createPresetDocument({
    id: "world-only",
    name: "World only",
    settings: [setting(WORLD_SETTING, 42)]
  });

  const reconciled = reconcilePresetSources({
    systemPresets: [systemShared, systemTombstone, main],
    worldPresets: [worldOnly, worldShared, liveGone]
  });

  assert.deepEqual(
    reconciled.presets.map(entry => entry.preset.id),
    [MAIN_PRESET_ID, "gone", "shared", "world-only"]
  );
  const shared = reconciled.presets.find(entry => entry.preset.id === "shared");
  assert.equal(shared.source, "system");
  assert.equal(shared.restoreToSystem, false);
  assert.equal(shared.preset.revision, systemShared.revision);

  const gone = reconciled.presets.find(entry => entry.preset.id === "gone");
  assert.equal(gone.preset.deleted, true);
  assert.equal(gone.source, "system");

  const restored = reconciled.presets.find(entry => entry.preset.id === "world-only");
  assert.equal(restored.source, "world");
  assert.equal(restored.restoreToSystem, true);
  assert.deepEqual(reconciled.restoreToSystem.map(preset => preset.id), ["world-only"]);
});

test("reconcilePresetSources rejects ambiguous duplicate files and invalid collections", () => {
  const duplicate = createPresetDocument({ id: "duplicate", name: "Duplicate", settings: [] });
  assert.throws(
    () => reconcilePresetSources({ systemPresets: [duplicate, duplicate] }),
    /duplicate preset id/i
  );
  assert.throws(
    () => reconcilePresetSources({ worldPresets: {} }),
    /worldPresets must be an array/i
  );
});

test("convertLegacyBaseline keeps only Fallout-MaW world settings", async () => {
  const legacy = {
    version: 1,
    system: "fallout-maw",
    systemVersion: "0.1.9",
    createdAt: "2026-07-01T00:00:00.000Z",
    sourceWorld: "fallout",
    settings: {
      "fallout-maw.worldObject": { scope: "world", value: { b: 2, a: 1 } },
      "fallout-maw.worldPrimitive": { scope: "world", value: false },
      "fallout-maw.clientState": { scope: "client", value: { x: 1 } },
      "fallout-maw.missingValue": { scope: "world" },
      "dnd5e.foreign": { scope: "world", value: true }
    }
  };

  const converted = convertLegacyBaseline(legacy, { id: "legacy-import", name: "Legacy import" });
  assert.equal(converted.id, "legacy-import");
  assert.equal(converted.name, "Legacy import");
  assert.equal(converted.systemVersion, "0.1.9");
  assert.deepEqual(converted.settings.map(entry => entry.id), [
    "fallout-maw.worldObject",
    "fallout-maw.worldPrimitive"
  ]);
  assert.equal(await computePresetRevision(converted), converted.revision);

  assert.throws(
    () => convertLegacyBaseline({ ...legacy, system: "dnd5e" }, { id: "x", name: "X" }),
    /systemId/i
  );
  assert.throws(
    () => convertLegacyBaseline({ system: "fallout-maw", settings: [] }, { id: "x", name: "X" }),
    /plain object/i
  );
});

test("normalizePresetDocument gates legacy baseline conversion behind allowLegacy", () => {
  const legacy = {
    version: 1,
    system: "fallout-maw",
    settings: {
      [WORLD_SETTING]: { scope: "world", value: { enabled: true } },
      "fallout-maw.clientOnly": { scope: "client", value: true }
    }
  };

  assert.throws(() => normalizePresetDocument(legacy), /unsupported key|format/i);

  const converted = normalizePresetDocument(legacy, {
    allowLegacy: true,
    name: "Imported baseline"
  });
  assert.equal(converted.id, MAIN_PRESET_ID);
  assert.equal(converted.name, "Imported baseline");
  assert.deepEqual(converted.settings, [setting()]);
});

test("legacy conversion rejects unsafe retained world values", () => {
  const legacy = {
    system: "fallout-maw",
    settings: {
      [WORLD_SETTING]: { scope: "world", value: undefined }
    }
  };
  assert.throws(
    () => convertLegacyBaseline(legacy, { id: "legacy", name: "Legacy" }),
    /JSON-safe/i
  );
});
