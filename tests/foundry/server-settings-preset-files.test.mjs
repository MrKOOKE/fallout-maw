import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  deleteSettingsPresetFiles,
  handleSettingsPresetFileDeletion
} from "../../server-patches/settings-preset-files.mjs";
import { buildPresetFileServerPatch } from "../../server-patches/install.mjs";

const WORLD_ID = "test-world";
const REQUEST = {
  action: "deleteFalloutMaWSettingsPreset",
  storage: "data",
  systemId: "fallout-maw",
  presetId: "preset-delete-me"
};

test("server helper physically deletes the system and active-world preset copies", async t => {
  const root = await installServerFixture(t);
  const targets = await writePresetCopies(root, REQUEST.presetId);
  const unrelated = path.join(root, "worlds", WORLD_ID, "settings-presets", "unrelated.json");
  await fs.writeFile(unrelated, "keep", "utf8");

  const result = await deleteSettingsPresetFiles(gmSocket(), REQUEST);

  assert.equal(result.status, "success");
  assert.equal(result.presetId, REQUEST.presetId);
  assert.equal(result.deleted.length, 2);
  await Promise.all(targets.map(target => assert.rejects(fs.access(target), { code: "ENOENT" })));
  assert.equal(await fs.readFile(unrelated, "utf8"), "keep");
});

test("server helper is idempotent when one or both copies are already absent", async t => {
  const root = await installServerFixture(t);
  const [systemTarget] = await writePresetCopies(root, REQUEST.presetId);
  await fs.unlink(systemTarget);

  const first = await deleteSettingsPresetFiles(gmSocket(), REQUEST);
  const second = await deleteSettingsPresetFiles(gmSocket(), REQUEST);

  assert.equal(first.deleted.length, 1);
  assert.equal(first.missing.length, 1);
  assert.equal(second.deleted.length, 0);
  assert.equal(second.missing.length, 2);
});

test("server helper rejects non-GMs, protected ids, and unsafe ids without touching files", async t => {
  const root = await installServerFixture(t);
  const targets = await writePresetCopies(root, REQUEST.presetId);

  await assert.rejects(
    deleteSettingsPresetFiles({ user: { hasRole: () => false } }, REQUEST),
    /only a Gamemaster/i
  );
  await assert.rejects(
    deleteSettingsPresetFiles(gmSocket(), { ...REQUEST, presetId: "fallout-maw" }),
    /protected settings preset/i
  );
  await assert.rejects(
    deleteSettingsPresetFiles(gmSocket(), { ...REQUEST, presetId: "../outside" }),
    /safe non-empty file id/i
  );
  await Promise.all(targets.map(target => fs.access(target)));
});

test("manageFiles callback wrapper returns deletion errors through the Foundry callback", async t => {
  await installServerFixture(t);
  const result = await new Promise(resolve => {
    handleSettingsPresetFileDeletion(
      { user: { hasRole: () => false } },
      REQUEST,
      resolve
    );
  });
  assert.match(result.error, /only a Gamemaster/i);
});

test("Foundry 14.361 file socket patch adds exactly the narrow Fallout-MaW action", () => {
  const socketSwitch = 'switch(e.action){case"browseFiles":Files.#a(o,e,s,r);break;case"createDirectory":Files.#i(o,e,s,r);break;case"configurePath":Files.#o(o,e,s,r)}';
  const patched = buildPresetFileServerPatch(`before;${socketSwitch};after`);

  assert.match(patched, /^import\{handleSettingsPresetFileDeletion as mawDeletePresetFiles\}/);
  assert.match(patched, /case"deleteFalloutMaWSettingsPreset":mawDeletePresetFiles\(t,e,r\)/);
  assert.equal((patched.match(/deleteFalloutMaWSettingsPreset/g) ?? []).length, 1);
  assert.throws(() => buildPresetFileServerPatch(patched), /does not match the audited implementation/i);
});

async function installServerFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fallout-maw-preset-delete-"));
  const previousGame = globalThis.game;
  const previousPaths = globalThis.paths;
  globalThis.game = {
    active: true,
    world: { id: WORLD_ID, system: { id: "fallout-maw" } }
  };
  globalThis.paths = { data: root };
  t.after(async () => {
    globalThis.game = previousGame;
    globalThis.paths = previousPaths;
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

async function writePresetCopies(root, presetId) {
  const targets = [
    path.join(root, "systems", "fallout-maw", "storage", "settings-presets", `${presetId}.json`),
    path.join(root, "worlds", WORLD_ID, "settings-presets", `${presetId}.json`)
  ];
  for (const target of targets) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify({ id: presetId }), "utf8");
  }
  return targets;
}

function gmSocket() {
  return { user: { hasRole: role => role === "GAMEMASTER" } };
}
