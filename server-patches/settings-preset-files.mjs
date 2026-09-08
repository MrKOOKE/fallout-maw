import fs from "node:fs/promises";
import path from "node:path";

const SYSTEM_ID = "fallout-maw";
const MAIN_PRESET_ID = "fallout-maw";
const PRESET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DIRECTORY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Permanently remove both writable copies of one Fallout-MaW settings preset.
 * Every path segment except the validated preset and active-world ids is fixed.
 */
export async function deleteSettingsPresetFiles(socket, request = {}) {
  if (!globalThis.game?.active || !globalThis.game?.world) {
    throw new Error("A running Foundry world is required to delete a settings preset.");
  }
  if (!socket?.user?.hasRole?.("GAMEMASTER")) {
    throw new Error("Only a Gamemaster may delete Fallout-MaW settings preset files.");
  }
  if (globalThis.game.world.system?.id !== SYSTEM_ID) {
    throw new Error("Fallout-MaW settings presets can only be deleted from a Fallout-MaW world.");
  }
  if (request.storage !== "data" || request.systemId !== SYSTEM_ID) {
    throw new Error("Invalid Fallout-MaW settings preset deletion request.");
  }

  const presetId = normalizePresetId(request.presetId);
  if (presetId === MAIN_PRESET_ID) {
    throw new Error(`Protected settings preset ${presetId} cannot be deleted.`);
  }
  const worldId = normalizeDirectoryId(globalThis.game.world.id, "World id");
  const dataRoot = path.resolve(globalThis.paths?.data ?? "");
  if (!globalThis.paths?.data || dataRoot === path.parse(dataRoot).root) {
    throw new Error("Foundry user data path is unavailable or unsafe.");
  }

  const relativePaths = [
    path.posix.join("systems", SYSTEM_ID, "storage", "settings-presets", `${presetId}.json`),
    path.posix.join("worlds", worldId, "settings-presets", `${presetId}.json`)
  ];
  const records = (await Promise.all(relativePaths.map(relativePath => readExistingFile(dataRoot, relativePath))))
    .filter(Boolean);
  const removed = [];
  try {
    for (const record of records) {
      await fs.unlink(record.absolutePath);
      removed.push(record);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const record of removed.reverse()) {
      try {
        await fs.writeFile(record.absolutePath, record.contents, { flag: "wx", mode: record.mode });
      } catch (rollbackError) {
        rollbackErrors.push(`${record.relativePath}: ${rollbackError.message}`);
      }
    }
    const rollback = rollbackErrors.length ? ` Rollback failed: ${rollbackErrors.join("; ")}` : "";
    throw new Error(`Could not delete settings preset ${presetId}: ${error.message}.${rollback}`, { cause: error });
  }

  const deleted = records.map(record => record.relativePath);
  return {
    status: "success",
    presetId,
    deleted,
    missing: relativePaths.filter(relativePath => !deleted.includes(relativePath))
  };
}

/** Foundry's manageFiles socket listener uses callbacks rather than promises. */
export function handleSettingsPresetFileDeletion(socket, request, callback) {
  void deleteSettingsPresetFiles(socket, request)
    .then(result => callback(result))
    .catch(error => callback({ error: error?.message || String(error) }));
}

async function readExistingFile(dataRoot, relativePath) {
  const absolutePath = resolveContainedPath(dataRoot, relativePath);
  let stat;
  try {
    stat = await fs.lstat(absolutePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Refusing to delete non-file preset path ${relativePath}.`);
  }
  return {
    absolutePath,
    relativePath,
    mode: stat.mode,
    contents: await fs.readFile(absolutePath)
  };
}

function resolveContainedPath(root, relativePath) {
  const absolutePath = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(root, absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Unsafe Fallout-MaW settings preset path ${relativePath}.`);
  }
  return absolutePath;
}

function normalizePresetId(value) {
  if (typeof value !== "string" || !PRESET_ID_PATTERN.test(value)) {
    throw new Error("Preset id must be a safe non-empty file id.");
  }
  return value;
}

function normalizeDirectoryId(value, label) {
  if (typeof value !== "string"
      || !DIRECTORY_ID_PATTERN.test(value)
      || value === "."
      || value === "..") {
    throw new Error(`${label} is not a safe directory id.`);
  }
  return value;
}
