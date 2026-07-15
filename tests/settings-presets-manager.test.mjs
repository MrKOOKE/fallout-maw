import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  SETTINGS_PRESET_TESTING,
  createSettingsPreset,
  createDefaultSettingsPresetState,
  getSettingsPreset,
  importSettingsPreset,
  isPresetManagedSetting,
  listSettingsPresets,
  removeSettingsPreset,
  removeSettingsPresetVersion,
  renameSettingsPreset,
  restoreSettingsPresetVersion,
  saveSettingsPresetVersion
} from "../src/settings/presets/manager.mjs";
import { createPresetDocument, createPresetSave, normalizePresetDocument } from "../src/settings/presets/schema.mjs";

const STATE_ID = "fallout-maw.settingsPresetState";
const ORIGINAL_FILE = globalThis.File;
const ORIGINAL_FETCH = globalThis.fetch;

function makePreset(id, name, settings) {
  return createPresetDocument({ id, name, settings, systemVersion: "0.2.0" });
}

function entry(id, value) {
  return { id, scope: "world", value };
}

function installFoundryMock({ storedIds = [], values = {}, modifyBatch } = {}) {
  const configs = new Map([
    ["fallout-maw.alpha", {
      id: "fallout-maw.alpha", namespace: "fallout-maw", key: "alpha", scope: "world", preset: true,
      type: Boolean, default: false
    }],
    ["fallout-maw.beta", {
      id: "fallout-maw.beta", namespace: "fallout-maw", key: "beta", scope: "world", preset: true,
      type: Object, default: { code: "default" }
    }],
    ["fallout-maw.clientOnly", {
      id: "fallout-maw.clientOnly", namespace: "fallout-maw", key: "clientOnly", scope: "client", preset: true,
      type: Boolean, default: false
    }],
    ["fallout-maw.runtime", {
      id: "fallout-maw.runtime", namespace: "fallout-maw", key: "runtime", scope: "world", preset: false,
      type: Object, default: {}
    }],
    [STATE_ID, {
      id: STATE_ID, namespace: "fallout-maw", key: "settingsPresetState", scope: "world", preset: false,
      type: Object, default: createDefaultSettingsPresetState()
    }]
  ]);
  const documents = new Map(storedIds.map(id => [id, { id: `doc-${id}`, _id: `doc-${id}`, key: id }]));
  const state = createDefaultSettingsPresetState();

  const user = { id: "gm", isGM: true, active: true };
  globalThis.game = {
    system: { id: "fallout-maw", version: "0.2.0" },
    world: { id: "test-world", title: "Test World" },
    user,
    users: {
      activeGM: user,
      contents: [user],
      get: id => id === user.id ? user : null
    },
    socket: { emit: () => undefined },
    i18n: { lang: "en" },
    settings: {
      settings: configs,
      storage: new Map([["world", { getSetting: id => documents.get(id) ?? null }]]),
      get: (_namespace, key) => {
        if (key === "settingsPresetState") return state;
        const id = `fallout-maw.${key}`;
        return Object.hasOwn(values, id) ? values[id] : configs.get(id)?.default;
      },
      set: async (_namespace, key, value) => {
        if (key === "settingsPresetState") Object.assign(state, value);
        return value;
      }
    }
  };
  globalThis.foundry = {
    abstract: { DataModel: class DataModel {} },
    applications: {
      apps: {
        FilePicker: {
          get implementation() {
            return globalThis.CONFIG?.ux?.FilePicker;
          }
        }
      }
    },
    data: { fields: { DataField: class DataField {} } },
    documents: {
      modifyBatch: modifyBatch ?? (async operations => operations.map(operation => (
        (operation.data ?? operation.updates ?? []).map(() => ({}))
      )))
    },
    utils: {
      deepClone: value => structuredClone(value),
      isSubclass: () => false
    }
  };
  globalThis.Hooks = { callAll: () => undefined };
  globalThis.ui = { settings: { render: () => undefined } };
  return { configs, documents, state };
}

function installPresetFileMock() {
  const uploads = [];
  globalThis.File = class File {
    constructor(parts, name, options) {
      this.parts = parts;
      this.name = name;
      this.type = options?.type;
    }
  };
  const record = (destination, path, file) => {
    uploads.push({
      destination,
      path,
      name: file.name,
      document: JSON.parse(file.parts.join(""))
    });
    return { path: `${path}/${file.name}` };
  };
  globalThis.CONFIG = {
    ux: {
      FilePicker: {
        browse: async () => ({ files: [] }),
        createDirectory: async () => ({}),
        upload: async (_source, path, file) => record("world", path, file),
        uploadPersistent: async (_id, path, file) => record("system", path, file)
      }
    }
  };
  return uploads;
}

function addCompatibilityConfigs(configs) {
  const add = (key, type, defaultValue, extra = {}) => configs.set(`fallout-maw.${key}`, {
    id: `fallout-maw.${key}`,
    namespace: "fallout-maw",
    key,
    scope: "world",
    preset: true,
    type,
    default: defaultValue,
    ...extra
  });
  configs.get("fallout-maw.alpha").default = true;
  configs.get("fallout-maw.beta").default = { source: "default" };
  add("list", Array, ["default"]);
  add("number", Number, 1, { choices: { 0: "None", 1: "One", 2: "Two", 3: "Three" } });
  add("text", String, "default");

  const mainSettings = [
    entry("fallout-maw.alpha", false),
    entry("fallout-maw.beta", { source: "main" }),
    entry("fallout-maw.list", ["main"]),
    entry("fallout-maw.number", 3),
    entry("fallout-maw.text", "main")
  ];
  const incompatibleSettings = [
    entry("fallout-maw.alpha", { old: true }),
    entry("fallout-maw.beta", "old"),
    entry("fallout-maw.list", { old: true }),
    entry("fallout-maw.number", 4),
    entry("fallout-maw.text", { old: true })
  ];
  return { mainSettings, incompatibleSettings };
}

test.afterEach(() => {
  SETTINGS_PRESET_TESTING.reset();
  delete globalThis.game;
  delete globalThis.foundry;
  delete globalThis.Hooks;
  delete globalThis.ui;
  delete globalThis.CONFIG;
  if (ORIGINAL_FILE === undefined) delete globalThis.File;
  else globalThis.File = ORIGINAL_FILE;
  if (ORIGINAL_FETCH === undefined) delete globalThis.fetch;
  else globalThis.fetch = ORIGINAL_FETCH;
});

test("managed-setting filtering is opt-in and strictly world-scoped", () => {
  assert.equal(isPresetManagedSetting({ namespace: "fallout-maw", scope: "world", preset: true }), true);
  assert.equal(isPresetManagedSetting({ namespace: "fallout-maw", scope: "client", preset: true }), false);
  assert.equal(isPresetManagedSetting({ namespace: "fallout-maw", scope: "user", preset: true }), false);
  assert.equal(isPresetManagedSetting({ namespace: "fallout-maw", scope: "world", preset: false }), false);
  assert.equal(isPresetManagedSetting({ namespace: "other", scope: "world", preset: true }), false);
});

test("both bundled seeds are valid and initially carry the same portable snapshot", () => {
  const seed = normalizePresetDocument(JSON.parse(
    fs.readFileSync(new URL("../storage/settings-presets/fallout-maw.json", import.meta.url), "utf8")
  ));
  const migrationSeed = normalizePresetDocument(JSON.parse(
    fs.readFileSync(new URL("../storage/settings-presets/fallout-maw-migration-seed.json", import.meta.url), "utf8")
  ));
  const ids = new Set(seed.settings.map(setting => setting.id));
  assert.equal(seed.settings.length, 58);
  assert.equal(migrationSeed.id, "fallout-maw-migration-seed");
  assert.equal(migrationSeed.seedPending, false);
  assert.deepEqual(
    migrationSeed.settings.map(setting => setting.id),
    seed.settings.map(setting => setting.id)
  );
  if (seed.seedPending) assert.deepEqual(migrationSeed.settings, seed.settings);
  assert.ok(seed.settings.every(setting => setting.scope === "world"));
  assert.ok(migrationSeed.settings.every(setting => setting.scope === "world"));
  for (const id of [
    "fallout-maw.migrationState",
    "fallout-maw.campState",
    "fallout-maw.timeRestMode",
    "fallout-maw.globalMapRootSceneId",
    "fallout-maw.events",
    "fallout-maw.combat-dock-position",
    "fallout-maw.tokenActionHudEnabled",
    "fallout-maw.tokenActionHudScale",
    "fallout-maw.tokenActionHudCollapsedSections",
    "fallout-maw.combatCarouselEnabled",
    "fallout-maw.combatCarouselSize",
    "fallout-maw.portraitSize",
    "fallout-maw.lessButtons",
    "fallout-maw.overflowStyle"
  ]) assert.equal(ids.has(id), false, `${id} must not be portable`);
});

test("legacy-world capture overlays stored documents onto the main preset", () => {
  installFoundryMock({
    storedIds: ["fallout-maw.alpha", "fallout-maw.beta"],
    values: { "fallout-maw.alpha": true, "fallout-maw.beta": "invalid-legacy-object" }
  });
  const main = makePreset("fallout-maw", "Fallout-MaW", [
    entry("fallout-maw.alpha", false),
    entry("fallout-maw.beta", { code: "seed" })
  ]);
  const snapshot = SETTINGS_PRESET_TESTING.captureCurrentSettings({ useStoredOnly: true, fallbackPreset: main });
  assert.deepEqual(snapshot, [
    entry("fallout-maw.alpha", true),
    entry("fallout-maw.beta", { code: "seed" })
  ]);
});

test("ordinary autosave capture recovers invalid runtime values from the active preset", () => {
  const { state } = installFoundryMock({
    storedIds: ["fallout-maw.alpha", "fallout-maw.beta"],
    values: {
      "fallout-maw.alpha": "true",
      "fallout-maw.beta": "invalid-runtime-object"
    }
  });
  const main = makePreset("fallout-maw", "Fallout-MaW", [
    entry("fallout-maw.alpha", false),
    entry("fallout-maw.beta", { code: "main" })
  ]);
  const active = makePreset("capture-active", "Capture active", [
    entry("fallout-maw.alpha", false),
    entry("fallout-maw.beta", { code: "active" })
  ]);
  SETTINGS_PRESET_TESTING.installPresets([main, active]);
  state.activePresetId = active.id;

  const originalWarn = console.warn;
  console.warn = () => undefined;
  let snapshot;
  try {
    snapshot = SETTINGS_PRESET_TESTING.captureCurrentSettings();
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(snapshot, [
    entry("fallout-maw.alpha", true),
    entry("fallout-maw.beta", { code: "active" })
  ]);
});

test("snapshot refresh preserves unknown future keys but replaces all known keys", () => {
  installFoundryMock();
  const current = makePreset("personal-one", "Personal", [
    entry("fallout-maw.alpha", false),
    entry("fallout-maw.future", { retained: true })
  ]);
  const merged = SETTINGS_PRESET_TESTING.mergeKnownSnapshotWithUnknown(current, [
    entry("fallout-maw.alpha", true),
    entry("fallout-maw.beta", { code: "new" })
  ]);
  assert.deepEqual(merged, [
    entry("fallout-maw.alpha", true),
    entry("fallout-maw.beta", { code: "new" }),
    entry("fallout-maw.future", { retained: true })
  ]);
});

test("known runtime and client registrations are removed while future keys survive", () => {
  installFoundryMock();
  const current = makePreset("filter-known", "Filter known", [
    entry("fallout-maw.alpha", false),
    entry("fallout-maw.clientOnly", true),
    entry("fallout-maw.future", { retained: true }),
    entry("fallout-maw.runtime", { transient: true })
  ]);

  const sanitized = SETTINGS_PRESET_TESTING.sanitizePresetSettings(current);
  assert.deepEqual(sanitized.settings, [
    entry("fallout-maw.alpha", false),
    entry("fallout-maw.future", { retained: true })
  ]);

  const merged = SETTINGS_PRESET_TESTING.mergeKnownSnapshotWithUnknown(current, [
    entry("fallout-maw.alpha", true),
    entry("fallout-maw.beta", { code: "new" })
  ]);
  assert.deepEqual(merged, [
    entry("fallout-maw.alpha", true),
    entry("fallout-maw.beta", { code: "new" }),
    entry("fallout-maw.future", { retained: true })
  ]);
});

test("invalid known setting types are rejected before preset persistence", async () => {
  let batchCalls = 0;
  let uploadCalls = 0;
  installFoundryMock({
    modifyBatch: async () => {
      batchCalls += 1;
      return [];
    }
  });
  globalThis.CONFIG = {
    ux: {
      FilePicker: {
        upload: async () => { uploadCalls += 1; return { path: "unexpected" }; },
        uploadPersistent: async () => { uploadCalls += 1; return { path: "unexpected" }; }
      }
    }
  };
  const main = makePreset("fallout-maw", "Fallout-MaW", [
    entry("fallout-maw.alpha", false),
    entry("fallout-maw.beta", { code: "main" })
  ]);
  const invalid = makePreset("invalid-type", "Invalid type", [
    entry("fallout-maw.alpha", "not-a-boolean"),
    entry("fallout-maw.beta", "not-an-object")
  ]);
  SETTINGS_PRESET_TESTING.installPresets([main]);

  await assert.rejects(
    importSettingsPreset(invalid, { activate: false }),
    error => {
      assert.match(error.message, /2 incompatible managed setting/i);
      assert.match(error.message, /fallout-maw\.alpha.*must be a boolean/i);
      assert.match(error.message, /fallout-maw\.beta.*must be an object or array/i);
      return true;
    }
  );
  assert.equal(uploadCalls, 0);
  assert.equal(batchCalls, 0);
});

test("public CRUD clones main, preserves identity, and removes presets only from the local world", async () => {
  const { state } = installFoundryMock();
  const uploads = installPresetFileMock();
  const main = makePreset("fallout-maw", "Fallout-MaW", [
    entry("fallout-maw.alpha", false),
    entry("fallout-maw.beta", { nested: { code: "main" } })
  ]);
  SETTINGS_PRESET_TESTING.installPresets([main]);

  const created = await createSettingsPreset({ name: "World copy" });
  assert.notEqual(created.id, main.id);
  assert.equal(created.name, "World copy");
  assert.deepEqual(created.settings, main.settings);

  created.settings[1].value.nested.code = "detached";
  assert.equal((await getSettingsPreset(main.id)).settings[1].value.nested.code, "main");

  const beforeRenameSettings = (await getSettingsPreset(created.id)).settings;
  const renamed = await renameSettingsPreset(created.id, "Renamed copy");
  assert.equal(renamed.id, created.id);
  assert.equal(renamed.name, "Renamed copy");
  assert.deepEqual(renamed.settings, beforeRenameSettings);
  assert.notEqual(renamed.revision, created.revision);

  await assert.rejects(removeSettingsPreset(main.id), /cannot be deleted/i);
  const removed = await removeSettingsPreset(created.id);
  assert.deepEqual(removed, { id: created.id, name: "Renamed copy", removed: true });
  assert.equal(await getSettingsPreset(created.id), null);
  const listed = (await listSettingsPresets()).find(preset => preset.id === created.id);
  assert.equal(listed, undefined);
  assert.deepEqual(state.removedPresetIds, [created.id]);
  assert.equal(uploads.length, 4);
  assert.equal(uploads.some(upload => upload.document.deleted), false);
});

test("a named nested save persists with its preset without becoming a separate preset", async () => {
  installFoundryMock();
  const uploads = installPresetFileMock();
  const main = makePreset("fallout-maw", "Fallout-MaW", [
    entry("fallout-maw.alpha", false),
    entry("fallout-maw.beta", { code: "main" })
  ]);
  const personal = makePreset("personal-history", "Personal", [
    entry("fallout-maw.alpha", true),
    entry("fallout-maw.beta", { code: "personal" })
  ]);
  SETTINGS_PRESET_TESTING.installPresets([main, personal]);

  const save = await saveSettingsPresetVersion(personal.id, "Before experiment");
  const stored = await getSettingsPreset(personal.id);
  assert.equal(stored.saves.length, 1);
  assert.equal(stored.saves[0].id, save.id);
  assert.equal(stored.saves[0].name, "Before experiment");
  assert.deepEqual(stored.saves[0].settings, personal.settings);
  assert.equal((await listSettingsPresets()).filter(entry => entry.id === personal.id)[0].saveCount, 1);
  assert.equal(uploads.length, 2);
  assert.equal(uploads.every(upload => upload.document.saves?.length === 1), true);

  const removed = await removeSettingsPresetVersion(personal.id, save.id);
  assert.deepEqual(removed, { id: save.id, removed: true });
  assert.equal(((await getSettingsPreset(personal.id)).saves ?? []).length, 0);
  assert.equal((await listSettingsPresets()).find(entry => entry.id === personal.id).saveCount, 0);
  assert.equal(uploads.length, 4);
  assert.equal(uploads.slice(-2).every(upload => (upload.document.saves ?? []).length === 0), true);
});

test("restoring a nested save keeps its history and atomically activates that preset", async () => {
  let state;
  ({ state } = installFoundryMock({
    storedIds: ["fallout-maw.alpha", "fallout-maw.beta", STATE_ID],
    values: {
      "fallout-maw.alpha": false,
      "fallout-maw.beta": { code: "main" }
    },
    modifyBatch: async operations => operations.map(operation => (operation.updates ?? []).map(update => {
      if (update._id === `doc-${STATE_ID}`) Object.assign(state, JSON.parse(update.value));
      return {};
    }))
  }));
  installPresetFileMock();
  const main = makePreset("fallout-maw", "Fallout-MaW", [
    entry("fallout-maw.alpha", false),
    entry("fallout-maw.beta", { code: "main" })
  ]);
  const save = createPresetSave({
    id: "save-restore",
    name: "Known good",
    createdAt: "2026-07-14T12:00:00.000Z",
    settings: [
      entry("fallout-maw.alpha", true),
      entry("fallout-maw.beta", { code: "restored" })
    ]
  });
  const personal = createPresetDocument({
    id: "personal-restore",
    name: "Personal",
    settings: [
      entry("fallout-maw.alpha", false),
      entry("fallout-maw.beta", { code: "current" })
    ],
    saves: [save]
  });
  Object.assign(state, { activePresetId: main.id, appliedRevision: main.revision });
  SETTINGS_PRESET_TESTING.installPresets([main, personal]);

  const restored = await restoreSettingsPresetVersion(personal.id, save.id);
  assert.equal(state.activePresetId, personal.id);
  assert.deepEqual(restored.settings, save.settings);
  assert.equal(restored.saves.length, 1);
  assert.equal(restored.saves[0].id, save.id);
});

test("importing a matching active id applies its new revision even with activate false", async () => {
  let operations;
  const { state } = installFoundryMock({
    storedIds: ["fallout-maw.alpha", "fallout-maw.beta", STATE_ID],
    values: {
      "fallout-maw.alpha": true,
      "fallout-maw.beta": { code: "old" }
    },
    modifyBatch: async batch => {
      operations = batch;
      return batch.map(operation => (operation.updates ?? operation.data ?? []).map(() => ({})));
    }
  });
  const uploads = installPresetFileMock();
  const main = makePreset("fallout-maw", "Fallout-MaW", [
    entry("fallout-maw.alpha", false),
    entry("fallout-maw.beta", { code: "main" })
  ]);
  const active = makePreset("active-import", "Active import", [
    entry("fallout-maw.alpha", true),
    entry("fallout-maw.beta", { code: "old" })
  ]);
  const imported = makePreset(active.id, active.name, [
    entry("fallout-maw.alpha", false),
    entry("fallout-maw.beta", { code: "imported" })
  ]);
  SETTINGS_PRESET_TESTING.installPresets([main, active]);
  Object.assign(state, {
    activePresetId: active.id,
    appliedRevision: active.revision,
    appliedManagedSignature: SETTINGS_PRESET_TESTING.getManagedPresetSignature(),
    migrationVersion: 1
  });

  const result = await importSettingsPreset(imported, { activate: false });
  assert.equal(result.revision, imported.revision);
  assert.equal(uploads.length, 2);
  assert.equal(operations.length, 1);
  assert.equal(operations[0].falloutMaWSettingsPresetApply, true);
  const byId = new Map(operations[0].updates.map(update => [update._id, JSON.parse(update.value)]));
  assert.equal(byId.get("doc-fallout-maw.alpha"), false);
  assert.deepEqual(byId.get("doc-fallout-maw.beta"), { code: "imported" });
  assert.equal(byId.get(`doc-${STATE_ID}`).appliedRevision, imported.revision);
  assert.equal((await getSettingsPreset(active.id)).revision, imported.revision);
});

test("a partial import is completed before its first write so pending and applied revisions cannot diverge", async () => {
  const attempts = [];
  let state;
  const installed = installFoundryMock({
    storedIds: ["fallout-maw.alpha", "fallout-maw.beta", STATE_ID],
    modifyBatch: async batch => {
      const stateUpdate = batch.flatMap(operation => operation.updates ?? [])
        .find(update => update._id === `doc-${STATE_ID}`);
      if (stateUpdate) Object.assign(state, JSON.parse(stateUpdate.value));
      return batch.map(operation => (operation.data ?? operation.updates ?? []).map(() => ({})));
    }
  });
  state = installed.state;
  globalThis.File = class File {
    constructor(parts, name, options) { this.parts = parts; this.name = name; this.type = options?.type; }
  };
  const record = (destination, path, file) => {
    const document = JSON.parse(file.parts.join(""));
    attempts.push({ destination, document });
    return { path: `${path}/${file.name}` };
  };
  globalThis.CONFIG = {
    ux: {
      FilePicker: {
        browse: async () => ({ files: [] }),
        createDirectory: async () => ({}),
        uploadPersistent: async (_id, path, file) => {
          record("system", path, file);
          return false;
        },
        upload: async (_source, path, file) => record("world", path, file)
      }
    }
  };
  const main = makePreset("fallout-maw", "Fallout-MaW", [
    entry("fallout-maw.alpha", false),
    entry("fallout-maw.beta", { code: "main" })
  ]);
  const partial = makePreset("partial-import", "Partial import", [
    entry("fallout-maw.alpha", true)
  ]);
  SETTINGS_PRESET_TESTING.installPresets([main]);

  const originalError = console.error;
  console.error = () => undefined;
  let imported;
  try {
    imported = await importSettingsPreset(partial, { activate: true });
  } finally {
    console.error = originalError;
  }

  assert.notEqual(imported.revision, partial.revision);
  assert.deepEqual(imported.settings, [
    entry("fallout-maw.alpha", true),
    entry("fallout-maw.beta", { code: "main" })
  ]);
  assert.equal(attempts.length, 2);
  assert.ok(attempts.every(attempt => attempt.document.revision === imported.revision));
  assert.ok(attempts.every(attempt => attempt.document.settings.length === 2));
  assert.equal(state.appliedRevision, imported.revision);
  assert.equal(state.pendingRevision, imported.revision);
  assert.deepEqual(state.pendingDocument, imported);
});

test("world migration classifier separates empty and existing worlds", () => {
  const { documents } = installFoundryMock();
  assert.equal(SETTINGS_PRESET_TESTING.isExistingWorldForPresetMigration(), false);

  game.world.playtime = 1;
  assert.equal(SETTINGS_PRESET_TESTING.isExistingWorldForPresetMigration(), true);

  game.world.playtime = 0;
  documents.set("fallout-maw.alpha", {
    id: "doc-fallout-maw.alpha",
    _id: "doc-fallout-maw.alpha",
    key: "fallout-maw.alpha"
  });
  assert.equal(SETTINGS_PRESET_TESTING.isExistingWorldForPresetMigration(), true);
});

test("atomic application fills missing keys from main and excludes client/runtime settings", async () => {
  let operations;
  installFoundryMock({
    storedIds: ["fallout-maw.alpha", "fallout-maw.beta", STATE_ID],
    modifyBatch: async batch => {
      operations = batch;
      return batch.map(operation => (operation.data ?? operation.updates ?? []).map(() => ({})));
    }
  });
  const main = makePreset("fallout-maw", "Fallout-MaW", [
    entry("fallout-maw.alpha", false),
    entry("fallout-maw.beta", { code: "main" })
  ]);
  const personal = makePreset("personal-two", "Personal", [entry("fallout-maw.alpha", true)]);
  SETTINGS_PRESET_TESTING.installPresets([main, personal]);

  await SETTINGS_PRESET_TESTING.applyPresetAtomically(personal, {
    statePatch: { activePresetId: personal.id, appliedRevision: personal.revision }
  });
  const updates = operations.flatMap(operation => operation.updates ?? []);
  const byId = new Map(updates.map(update => [update._id, JSON.parse(update.value)]));
  assert.equal(byId.get("doc-fallout-maw.alpha"), true);
  assert.deepEqual(byId.get("doc-fallout-maw.beta"), { code: "main" });
  assert.equal(byId.has("doc-fallout-maw.clientOnly"), false);
  assert.equal(byId.has("doc-fallout-maw.runtime"), false);
  assert.equal(byId.get(`doc-${STATE_ID}`).activePresetId, personal.id);
  assert.ok(operations.every(operation => operation.falloutMaWSettingsPresetApply === true));
  assert.ok(operations.every(operation => operation.noHook === true));
  assert.ok(operations.every(operation => operation.falloutMaWSettingsPresetBatchSize === 3));
  assert.equal(new Set(operations.map(operation => operation.falloutMaWSettingsPresetBatchId)).size, 1);
});

test("Foundry Object settings preserve JSON arrays during atomic application", async () => {
  let operations;
  installFoundryMock({
    storedIds: ["fallout-maw.alpha", "fallout-maw.beta", STATE_ID],
    modifyBatch: async batch => {
      operations = batch;
      return batch.map(operation => (operation.data ?? operation.updates ?? []).map(() => ({})));
    }
  });
  const characteristics = [{ key: "strength", label: "Strength" }];
  const main = makePreset("fallout-maw", "Fallout-MaW", [
    entry("fallout-maw.alpha", false),
    entry("fallout-maw.beta", characteristics)
  ]);
  SETTINGS_PRESET_TESTING.installPresets([main]);

  await SETTINGS_PRESET_TESTING.applyPresetAtomically(main, {
    statePatch: { activePresetId: main.id, appliedRevision: main.revision }
  });

  const updates = operations.flatMap(operation => operation.updates ?? []);
  const beta = updates.find(update => update._id === "doc-fallout-maw.beta");
  assert.deepEqual(JSON.parse(beta.value), characteristics);
});

test("atomic application coerces legacy scalar values without weakening imports", async () => {
  let operations;
  const { configs } = installFoundryMock({
    storedIds: ["fallout-maw.alpha", "fallout-maw.beta", "fallout-maw.text", STATE_ID],
    modifyBatch: async batch => {
      operations = batch;
      return batch.map(operation => (operation.data ?? operation.updates ?? []).map(() => ({})));
    }
  });
  const uploads = installPresetFileMock();
  const numeric = configs.get("fallout-maw.beta");
  numeric.type = Number;
  numeric.default = 0;
  numeric.choices = { 0: "None", 1: "One", 2: "Two", 3: "Three" };
  configs.set("fallout-maw.text", {
    id: "fallout-maw.text", namespace: "fallout-maw", key: "text", scope: "world", preset: true,
    type: String, default: "default"
  });
  const legacy = makePreset("fallout-maw", "Fallout-MaW", [
    entry("fallout-maw.alpha", "false"),
    entry("fallout-maw.beta", "3"),
    entry("fallout-maw.text", true)
  ]);
  SETTINGS_PRESET_TESTING.installPresets([legacy]);

  await SETTINGS_PRESET_TESTING.applyPresetAtomically(legacy, {
    statePatch: { activePresetId: legacy.id, appliedRevision: legacy.revision }
  });

  const updates = operations.flatMap(operation => operation.updates ?? []);
  const alpha = updates.find(update => update._id === "doc-fallout-maw.alpha");
  const beta = updates.find(update => update._id === "doc-fallout-maw.beta");
  const text = updates.find(update => update._id === "doc-fallout-maw.text");
  assert.equal(JSON.parse(alpha.value), false);
  assert.equal(JSON.parse(beta.value), 3);
  assert.equal(JSON.parse(text.value), "true");
  assert.equal(uploads.length, 2);
  await assert.rejects(importSettingsPreset(
    makePreset("strict-import", "Strict import", [
      entry("fallout-maw.alpha", "false"),
      entry("fallout-maw.beta", "3"),
      entry("fallout-maw.text", true)
    ]),
    { activate: false }
  ), error => {
    assert.match(error.message, /3 incompatible managed setting/i);
    for (const id of ["fallout-maw.alpha", "fallout-maw.beta", "fallout-maw.text"]) {
      assert.ok(error.message.includes(id));
    }
    return true;
  });
  assert.equal(uploads.length, 2);
});

test("one atomic pass recovers every incompatible managed JSON type and heals both files", async () => {
  const managedIds = [
    "fallout-maw.alpha",
    "fallout-maw.beta",
    "fallout-maw.list",
    "fallout-maw.number",
    "fallout-maw.text"
  ];
  const operations = [];
  let state;
  const installed = installFoundryMock({
    storedIds: [...managedIds, STATE_ID],
    modifyBatch: async batch => {
      operations.push(...batch);
      const stateUpdate = batch.flatMap(operation => operation.updates ?? [])
        .find(update => update._id === `doc-${STATE_ID}`);
      if (stateUpdate) Object.assign(state, JSON.parse(stateUpdate.value));
      return batch.map(operation => (operation.data ?? operation.updates ?? []).map(() => ({})));
    }
  });
  state = installed.state;
  const { mainSettings, incompatibleSettings } = addCompatibilityConfigs(installed.configs);
  const uploads = installPresetFileMock();
  const main = makePreset("fallout-maw", "Fallout-MaW", mainSettings);
  const personal = makePreset("legacy-all-types", "Legacy all types", [
    ...incompatibleSettings,
    entry("fallout-maw.future", { retained: true })
  ]);
  SETTINGS_PRESET_TESTING.installPresets([main, personal]);

  const originalWarn = console.warn;
  console.warn = () => undefined;
  let healed;
  try {
    healed = await SETTINGS_PRESET_TESTING.applyPresetAtomically(personal, {
      statePatch: { activePresetId: personal.id, appliedRevision: personal.revision }
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.notEqual(healed.revision, personal.revision);
  const applied = operations.find(operation => operation.falloutMaWSettingsPresetApply === true);
  assert.ok(applied);
  assert.equal(applied.updates.length, managedIds.length + 1);
  const byId = new Map(applied.updates.map(update => [update._id, JSON.parse(update.value)]));
  const expected = new Map(mainSettings.map(setting => [`doc-${setting.id}`, setting.value]));
  for (const [documentId, value] of expected) assert.deepEqual(byId.get(documentId), value);
  assert.equal(byId.get(`doc-${STATE_ID}`).appliedRevision, healed.revision);
  assert.equal(state.appliedRevision, healed.revision);
  assert.deepEqual(
    healed.settings.find(setting => setting.id === "fallout-maw.future")?.value,
    { retained: true }
  );

  assert.equal(uploads.length, 2);
  assert.deepEqual(uploads.map(upload => upload.destination), ["system", "world"]);
  assert.ok(uploads.every(upload => upload.document.revision === healed.revision));
  assert.deepEqual((await getSettingsPreset(personal.id)).settings, healed.settings);

  const writesAfterHealing = uploads.length;
  await SETTINGS_PRESET_TESTING.applyPresetAtomically(healed, {
    statePatch: { activePresetId: healed.id, appliedRevision: healed.revision }
  });
  assert.equal(uploads.length, writesAfterHealing);
});

test("recovery falls through an invalid main preset to each registered default", async () => {
  const managedIds = [
    "fallout-maw.alpha",
    "fallout-maw.beta",
    "fallout-maw.list",
    "fallout-maw.number",
    "fallout-maw.text"
  ];
  let operations;
  const { configs } = installFoundryMock({
    storedIds: [...managedIds, STATE_ID],
    modifyBatch: async batch => {
      operations = batch;
      return batch.map(operation => (operation.data ?? operation.updates ?? []).map(() => ({})));
    }
  });
  const { incompatibleSettings } = addCompatibilityConfigs(configs);
  installPresetFileMock();
  const invalidMain = makePreset("fallout-maw", "Fallout-MaW", incompatibleSettings);
  const personal = makePreset("invalid-main-fallback", "Invalid main fallback", incompatibleSettings);
  SETTINGS_PRESET_TESTING.installPresets([invalidMain, personal]);

  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    await SETTINGS_PRESET_TESTING.applyPresetAtomically(personal, {
      statePatch: { activePresetId: personal.id, appliedRevision: personal.revision }
    });
  } finally {
    console.warn = originalWarn;
  }

  const applied = operations.find(operation => operation.falloutMaWSettingsPresetApply === true);
  const byId = new Map(applied.updates.map(update => [update._id, JSON.parse(update.value)]));
  assert.equal(byId.get("doc-fallout-maw.alpha"), true);
  assert.deepEqual(byId.get("doc-fallout-maw.beta"), { source: "default" });
  assert.deepEqual(byId.get("doc-fallout-maw.list"), ["default"]);
  assert.equal(byId.get("doc-fallout-maw.number"), 1);
  assert.equal(byId.get("doc-fallout-maw.text"), "default");
});

test("strict import reports every incompatible managed JSON type before any write", async () => {
  let batchCalls = 0;
  const { configs } = installFoundryMock({
    modifyBatch: async () => {
      batchCalls += 1;
      return [];
    }
  });
  const { mainSettings, incompatibleSettings } = addCompatibilityConfigs(configs);
  const uploads = installPresetFileMock();
  SETTINGS_PRESET_TESTING.installPresets([
    makePreset("fallout-maw", "Fallout-MaW", mainSettings)
  ]);

  await assert.rejects(
    importSettingsPreset(
      makePreset("strict-all-types", "Strict all types", incompatibleSettings),
      { activate: false }
    ),
    error => {
      assert.match(error.message, /5 incompatible managed setting/i);
      for (const setting of incompatibleSettings) assert.ok(error.message.includes(setting.id));
      return true;
    }
  );
  assert.equal(batchCalls, 0);
  assert.equal(uploads.length, 0);
});

test("an atomic batch failure rejects without issuing fallback writes", async () => {
  let calls = 0;
  installFoundryMock({
    storedIds: ["fallout-maw.alpha", "fallout-maw.beta", STATE_ID],
    modifyBatch: async () => { calls += 1; throw new Error("batch rejected"); }
  });
  const main = makePreset("fallout-maw", "Fallout-MaW", [
    entry("fallout-maw.alpha", false),
    entry("fallout-maw.beta", { code: "main" })
  ]);
  SETTINGS_PRESET_TESTING.installPresets([main]);
  await assert.rejects(
    SETTINGS_PRESET_TESTING.applyPresetAtomically(main, { statePatch: { activePresetId: main.id } }),
    /not applied atomically.*batch rejected/
  );
  assert.equal(calls, 1);
});

test("a resolved but incomplete Foundry batch is still treated as atomic failure", async () => {
  installFoundryMock({
    storedIds: ["fallout-maw.alpha", "fallout-maw.beta", STATE_ID],
    modifyBatch: async () => []
  });
  const main = makePreset("fallout-maw", "Fallout-MaW", [
    entry("fallout-maw.alpha", false),
    entry("fallout-maw.beta", { code: "main" })
  ]);
  SETTINGS_PRESET_TESTING.installPresets([main]);
  await assert.rejects(
    SETTINGS_PRESET_TESTING.applyPresetAtomically(main, { statePatch: { activePresetId: main.id } }),
    /rejected one or more operations/
  );
});

test("batch-marked onChange callbacks are suppressed and coalesced by function identity", async () => {
  const { configs } = installFoundryMock();
  let calls = 0;
  const shared = () => { calls += 1; };
  configs.get("fallout-maw.alpha").onChange = shared;
  configs.get("fallout-maw.beta").onChange = shared;
  SETTINGS_PRESET_TESTING.wrapManagedSettingOnChanges();

  const options = { falloutMaWSettingsPresetApply: true };
  configs.get("fallout-maw.alpha").onChange(true, options, "gm");
  configs.get("fallout-maw.beta").onChange({ code: "new" }, options, "gm");
  assert.equal(calls, 0);
  await SETTINGS_PRESET_TESTING.drainPresetApplyCallbacks();
  assert.equal(calls, 1);
});

test("a failed system write is recovered from the world backup", async () => {
  const { state } = installFoundryMock();
  globalThis.File = class File {
    constructor(parts, name, options) { this.parts = parts; this.name = name; this.type = options?.type; }
  };
  let systemShouldFail = true;
  let preset;
  let observedWriteAhead = false;
  globalThis.CONFIG = {
    ux: {
      FilePicker: {
        browse: async () => ({ files: [] }),
        createDirectory: async () => ({}),
        upload: async (_source, path, file) => ({ path: `${path}/${file.name}` }),
        uploadPersistent: async (_id, path, file) => {
          if (systemShouldFail) {
            observedWriteAhead = state.pendingPresetId === preset.id
              && state.pendingRevision === preset.revision
              && state.pendingDocument?.revision === preset.revision;
            return false;
          }
          return { path: `${path}/${file.name}` };
        }
      }
    }
  };
  preset = makePreset("recoverable", "Recoverable", [entry("fallout-maw.alpha", true)]);
  SETTINGS_PRESET_TESTING.installPresets([preset]);
  const originalError = console.error;
  console.error = () => undefined;
  try {
    await SETTINGS_PRESET_TESTING.savePresetCopies(preset);
  } finally {
    console.error = originalError;
  }
  assert.equal(observedWriteAhead, true);
  assert.equal(state.pendingPresetId, preset.id);
  assert.equal(state.pendingRevision, preset.revision);
  assert.equal(state.pendingTarget, "system");
  assert.deepEqual(state.pendingDocument, preset);

  SETTINGS_PRESET_TESTING.reset();
  SETTINGS_PRESET_TESTING.installSources({ world: [preset] });
  systemShouldFail = false;
  assert.equal(await SETTINGS_PRESET_TESTING.reconcilePendingWrite(), true);
  assert.equal(state.pendingPresetId, "");
  assert.equal(state.pendingRevision, "");
  assert.equal(state.pendingTarget, "");
});

test("when both files fail the full pending document survives a simulated restart", async () => {
  const { state } = installFoundryMock();
  globalThis.File = class File {
    constructor(parts, name, options) { this.parts = parts; this.name = name; this.type = options?.type; }
  };
  let writesFail = true;
  globalThis.CONFIG = {
    ux: {
      FilePicker: {
        browse: async () => ({ files: [] }),
        createDirectory: async () => ({}),
        upload: async (_source, path, file) => writesFail ? false : ({ path: `${path}/${file.name}` }),
        uploadPersistent: async (_id, path, file) => writesFail ? false : ({ path: `${path}/${file.name}` })
      }
    }
  };
  const preset = makePreset("durable-pending", "Durable pending", [entry("fallout-maw.alpha", true)]);
  const originalError = console.error;
  console.error = () => undefined;
  try {
    await assert.rejects(SETTINGS_PRESET_TESTING.savePresetCopies(preset), /system:.*world:/);
  } finally {
    console.error = originalError;
  }
  assert.equal(state.pendingTarget, "both");
  assert.deepEqual(state.pendingDocument, preset);

  SETTINGS_PRESET_TESTING.reset();
  writesFail = false;
  assert.equal(await SETTINGS_PRESET_TESTING.reconcilePendingWrite(), true);
  assert.equal(state.pendingPresetId, "");
  assert.equal(state.pendingDocument, null);
});

test("an unresolved pending preset cannot be overwritten by a later save", async () => {
  const { state } = installFoundryMock();
  const attemptedIds = [];
  globalThis.File = class File {
    constructor(parts, name, options) { this.parts = parts; this.name = name; this.type = options?.type; }
  };
  const fail = async (_source, _path, file) => {
    attemptedIds.push(JSON.parse(file.parts.join("")).id);
    return false;
  };
  globalThis.CONFIG = {
    ux: {
      FilePicker: {
        browse: async () => ({ files: [] }),
        createDirectory: async () => ({}),
        upload: fail,
        uploadPersistent: fail
      }
    }
  };
  const first = makePreset("pending-first", "Pending first", [entry("fallout-maw.alpha", true)]);
  const second = makePreset("pending-second", "Pending second", [entry("fallout-maw.alpha", false)]);
  const originalError = console.error;
  console.error = () => undefined;
  try {
    await assert.rejects(SETTINGS_PRESET_TESTING.savePresetCopies(first));
    await assert.rejects(
      SETTINGS_PRESET_TESTING.savePresetCopies(second),
      /pending-first still has an unresolved file write/i
    );
  } finally {
    console.error = originalError;
  }

  assert.equal(state.pendingPresetId, first.id);
  assert.equal(state.pendingRevision, first.revision);
  assert.deepEqual(state.pendingDocument, first);
  assert.ok(attemptedIds.length >= 3);
  assert.ok(attemptedIds.every(id => id === first.id));
});

test("a queued retry cannot overwrite a newer revision of the same preset", async () => {
  const { state } = installFoundryMock();
  const uploads = installPresetFileMock();
  const stale = makePreset("retry-race", "Retry race", [entry("fallout-maw.alpha", false)]);
  const current = makePreset("retry-race", "Retry race", [entry("fallout-maw.alpha", true)]);
  Object.assign(state, {
    pendingPresetId: current.id,
    pendingRevision: current.revision,
    pendingTarget: "both",
    pendingDocument: current
  });

  assert.equal(await SETTINGS_PRESET_TESTING.retryPendingPresetWrite(stale), false);
  assert.equal(uploads.length, 0);
  assert.equal(state.pendingRevision, current.revision);
  assert.deepEqual(state.pendingDocument, current);
});

test("a corrupt pending file is ignored and rebuilt from the durable world-state document", async () => {
  const { state } = installFoundryMock();
  const pending = makePreset("fallout-maw", "Fallout-MaW", [
    entry("fallout-maw.alpha", false),
    entry("fallout-maw.beta", { code: "pending" })
  ]);
  Object.assign(state, {
    migrationVersion: 1,
    activePresetId: pending.id,
    appliedRevision: pending.revision,
    pendingPresetId: pending.id,
    pendingRevision: pending.revision,
    pendingTarget: "both",
    pendingDocument: pending
  });
  globalThis.File = class File {
    constructor(parts, name, options) { this.parts = parts; this.name = name; this.type = options?.type; }
  };
  const uploads = [];
  globalThis.CONFIG = {
    ux: {
      FilePicker: {
        browse: async (_source, path) => ({
          files: path === "systems/fallout-maw/storage/settings-presets"
            ? ["systems/fallout-maw/storage/settings-presets/fallout-maw.json"]
            : []
        }),
        createDirectory: async () => ({}),
        uploadPersistent: async (_id, path, file) => {
          uploads.push({ destination: "system", id: JSON.parse(file.parts.join("")).id });
          return { path: `${path}/${file.name}` };
        },
        upload: async (_source, path, file) => {
          uploads.push({ destination: "world", id: JSON.parse(file.parts.join("")).id });
          return { path: `${path}/${file.name}` };
        }
      }
    }
  };
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => { throw new SyntaxError("truncated JSON"); }
  });

  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    await SETTINGS_PRESET_TESTING.loadPresetSources();
  } finally {
    console.warn = originalWarn;
  }
  assert.equal((await getSettingsPreset(pending.id)).revision, pending.revision);
  assert.equal(await SETTINGS_PRESET_TESTING.reconcilePendingWrite(), true);
  assert.deepEqual(uploads, [
    { destination: "system", id: pending.id },
    { destination: "world", id: pending.id }
  ]);
  assert.equal(state.pendingPresetId, "");
  assert.equal(state.pendingDocument, null);
});

test("an updated unrelated preset never reapplies the active personal preset", async () => {
  let batchCalls = 0;
  const { state } = installFoundryMock({
    storedIds: ["fallout-maw.alpha", "fallout-maw.beta", STATE_ID],
    modifyBatch: async operations => {
      batchCalls += 1;
      return operations.map(operation => (operation.data ?? operation.updates ?? []).map(() => ({})));
    }
  });
  const main = makePreset("fallout-maw", "Fallout-MaW", [
    entry("fallout-maw.alpha", false),
    entry("fallout-maw.beta", { code: "main" })
  ]);
  const active = makePreset("personal-active", "Active", [entry("fallout-maw.alpha", true)]);
  const unrelated = makePreset("unrelated", "Patched elsewhere", [entry("fallout-maw.alpha", false)]);
  SETTINGS_PRESET_TESTING.installPresets([main, active, unrelated]);
  Object.assign(state, {
    activePresetId: active.id,
    appliedRevision: active.revision,
    appliedManagedSignature: SETTINGS_PRESET_TESTING.getManagedPresetSignature(),
    migrationVersion: 1
  });

  assert.equal(await SETTINGS_PRESET_TESTING.applyActiveRevisionIfNeeded(), false);
  assert.equal(batchCalls, 0);
});

test("a registration contract change forces startup validation even when ids and revision match", async () => {
  let batchCalls = 0;
  const { configs, state } = installFoundryMock({
    storedIds: ["fallout-maw.alpha", "fallout-maw.beta", STATE_ID],
    modifyBatch: async operations => {
      batchCalls += 1;
      return operations.map(operation => (operation.data ?? operation.updates ?? []).map(() => ({})));
    }
  });
  const numeric = configs.get("fallout-maw.beta");
  numeric.type = Number;
  numeric.default = 0;
  const main = makePreset("fallout-maw", "Fallout-MaW", [
    entry("fallout-maw.alpha", false),
    entry("fallout-maw.beta", 0)
  ]);
  SETTINGS_PRESET_TESTING.installPresets([main]);
  Object.assign(state, {
    activePresetId: main.id,
    appliedRevision: main.revision,
    appliedManagedSignature: SETTINGS_PRESET_TESTING.getManagedPresetSignature(),
    migrationVersion: 1
  });

  numeric.choices = { 0: "None", 1: "One", 2: "Two", 3: "Three" };
  assert.equal(await SETTINGS_PRESET_TESTING.applyActiveRevisionIfNeeded(), true);
  assert.equal(batchCalls, 1);
});

test("a same-shape registered default change invalidates the managed signature", async () => {
  let applied;
  const { configs, state } = installFoundryMock({
    storedIds: ["fallout-maw.alpha", "fallout-maw.beta", STATE_ID],
    modifyBatch: async operations => {
      applied = operations.find(operation => operation.falloutMaWSettingsPresetApply === true) ?? applied;
      return operations.map(operation => (operation.data ?? operation.updates ?? []).map(() => ({})));
    }
  });
  installPresetFileMock();
  const numeric = configs.get("fallout-maw.beta");
  numeric.type = Number;
  numeric.default = 0;
  const main = makePreset("fallout-maw", "Fallout-MaW", [
    entry("fallout-maw.alpha", false)
  ]);
  SETTINGS_PRESET_TESTING.installPresets([main]);
  Object.assign(state, {
    activePresetId: main.id,
    appliedRevision: main.revision,
    appliedManagedSignature: SETTINGS_PRESET_TESTING.getManagedPresetSignature(),
    migrationVersion: 1
  });

  numeric.default = 1;
  assert.equal(await SETTINGS_PRESET_TESTING.applyActiveRevisionIfNeeded(), true);
  const beta = applied.updates.find(update => update._id === "doc-fallout-maw.beta");
  assert.equal(JSON.parse(beta.value), 1);
});

test("a missing newly managed Setting document forces a full startup apply", async () => {
  const operations = [];
  const { documents, state } = installFoundryMock({
    storedIds: ["fallout-maw.alpha", STATE_ID]
  });
  foundry.documents.modifyBatch = async batch => {
    operations.push(...batch);
    return batch.map(operation => {
      if (operation.action !== "create") return (operation.updates ?? []).map(() => ({}));
      return (operation.data ?? []).map(data => {
        const document = { id: `doc-${data.key}`, _id: `doc-${data.key}`, key: data.key };
        documents.set(data.key, document);
        return document;
      });
    });
  };
  const main = makePreset("fallout-maw", "Fallout-MaW", [
    entry("fallout-maw.alpha", false),
    entry("fallout-maw.beta", { code: "main" })
  ]);
  SETTINGS_PRESET_TESTING.installPresets([main]);
  Object.assign(state, {
    activePresetId: main.id,
    appliedRevision: main.revision,
    appliedManagedSignature: SETTINGS_PRESET_TESTING.getManagedPresetSignature(),
    migrationVersion: 1
  });

  assert.equal(await SETTINGS_PRESET_TESTING.applyActiveRevisionIfNeeded(), true);
  const materialize = operations.filter(operation => operation.falloutMaWSettingsPresetMaterialize === true);
  const applied = operations.filter(operation => operation.falloutMaWSettingsPresetApply === true);
  assert.equal(materialize.length, 1);
  assert.ok(materialize.flatMap(operation => operation.data ?? [])
    .some(document => document.key === "fallout-maw.beta"));
  assert.ok(materialize.every(operation => operation.noHook === true));
  assert.equal(applied.length, 1);
  assert.ok(applied[0].updates.some(update => update._id === "doc-fallout-maw.beta"));
  assert.ok(applied.every(operation => operation.noHook === true));
  assert.ok(applied.every(operation => operation.falloutMaWSettingsPresetBatchSize === 3));
  assert.equal(new Set(applied.map(operation => operation.falloutMaWSettingsPresetBatchId)).size, 1);
});

test("a changed revision of the active preset is fully reapplied", async () => {
  let batchCalls = 0;
  const { state } = installFoundryMock({
    storedIds: ["fallout-maw.alpha", "fallout-maw.beta", STATE_ID],
    modifyBatch: async operations => {
      batchCalls += 1;
      return operations.map(operation => (operation.data ?? operation.updates ?? []).map(() => ({})));
    }
  });
  const main = makePreset("fallout-maw", "Fallout-MaW", [
    entry("fallout-maw.alpha", false),
    entry("fallout-maw.beta", { code: "main" })
  ]);
  const oldActive = makePreset("personal-updated", "Active", [entry("fallout-maw.alpha", false)]);
  const newActive = makePreset("personal-updated", "Active", [entry("fallout-maw.alpha", true)]);
  SETTINGS_PRESET_TESTING.installPresets([main, newActive]);
  Object.assign(state, { activePresetId: newActive.id, appliedRevision: oldActive.revision, migrationVersion: 1 });

  assert.equal(await SETTINGS_PRESET_TESTING.applyActiveRevisionIfNeeded(), true);
  assert.equal(batchCalls, 1);
});
