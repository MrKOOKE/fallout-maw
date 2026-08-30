import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(testDirectory, "..");
const builderPath = path.join(projectDirectory, "release", "build-release.mjs");
const setVersionPath = path.join(projectDirectory, "release", "set-version.mjs");
const defaultConfigPath = path.join(projectDirectory, "release", "release-config.json");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
}

function runCommand(command, paths, extraArguments = []) {
  const result = spawnSync(process.execPath, [
    builderPath,
    command,
    "--source", paths.source,
    "--output", paths.output,
    "--state", paths.state,
    "--config", paths.config,
    "--key-dir", paths.keys,
    ...extraArguments
  ], {
    cwd: projectDirectory,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true
  });
  assert.equal(result.status, 0, `${command} failed:\n${result.stdout}\n${result.stderr}`);
  return result;
}

function resolveRelative(baseFile, relativeUrl) {
  return path.resolve(path.dirname(baseFile), ...relativeUrl.split("/"));
}

function tarList(archivePath) {
  const result = spawnSync("tar", ["-tf", archivePath], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

function tarJson(archivePath, entryName) {
  const result = spawnSync("tar", ["-xOf", archivePath, entryName], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function fileRecord(filePath) {
  return fileRecordFromBytes(fs.readFileSync(filePath));
}

function fileRecordFromBytes(bytes) {
  return { size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
}

function systemManifest(version) {
  return {
    id: "fallout-maw",
    type: "system",
    title: "Fixture Fallout-MaW",
    version,
    compatibility: { minimum: "14", verified: "14.361" },
    esmodules: ["src/main.mjs"],
    styles: [],
    languages: [],
    documentTypes: {},
    url: "https://example.invalid/fallout-maw",
    manifest: "https://example.invalid/foundry/system.json",
    download: "https://example.invalid/fallout-maw.zip"
  };
}

test("release builder signs a snapshot and a storage-preserving patch chain", { timeout: 60_000 }, () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fallout-maw-release-test-"));
  const paths = {
    source: path.join(temporaryRoot, "source"),
    output: path.join(temporaryRoot, "public-output"),
    state: path.join(temporaryRoot, "private-state", "stable.json"),
    config: path.join(temporaryRoot, "fixture-release-config.json"),
    keys: path.join(temporaryRoot, "private-keys")
  };

  try {
    const config = JSON.parse(fs.readFileSync(defaultConfigPath, "utf8"));
    config.releaseNotes = { default: "Fixture release" };
    config.hashConcurrency = 2;
    config.foundry = {
      packageUrl: "https://example.invalid/package",
      manifestUrl: "https://downloads.example.invalid/foundry/system.json",
      downloadUrl: "https://downloads.example.invalid/releases/current/full.zip"
    };
    writeJson(paths.config, config);

    writeJson(path.join(paths.source, "package.json"), { name: "fallout-maw-fixture", version: "1.0.0", type: "module" });
    writeJson(path.join(paths.source, "system.json"), systemManifest("1.0.0"));
    writeText(path.join(paths.source, "README.md"), "Fixture release\n");
    writeText(path.join(paths.source, "src", "main.mjs"), "export const fixture = 1;\n");
    writeText(path.join(paths.source, "assets", "keep.txt"), "keep\n");
    writeText(path.join(paths.source, "assets", "delete.txt"), "delete me\n");
    writeText(path.join(paths.source, "assets", "magazine-№1.webp"), "unicode path\n");
    writeText(path.join(paths.source, "assets", "LOST", "unused-source.txt"), "must not ship\n");
    writeJson(path.join(paths.source, "storage", "user-state.json"), { value: 1 });
    writeText(path.join(paths.source, "templates", "fixture.hbs"), "<p>fixture</p>\n");

    runCommand("keygen", paths);
    runCommand("snapshot", paths);

    const stablePath = path.join(paths.output, "channels", "stable.json");
    const firstStableBytes = fs.readFileSync(stablePath);
    const firstStable = JSON.parse(firstStableBytes);
    assert.equal(firstStable.schemaVersion, 1);
    assert.equal(firstStable.sequence, 1);
    assert.equal(firstStable.system.version, "1.0.0");
    assert.equal(firstStable.system.full.version, "1.0.0");
    assert.deepEqual(firstStable.system.patches, []);
    assert.equal(firstStable.system.foundryManifestUrl, "../foundry/system.json");
    assert.ok(!/^[a-z]+:/i.test(firstStable.system.full.url), "full artifact URL must be relative");

    const firstFullPath = resolveRelative(stablePath, firstStable.system.full.url);
    assert.equal(fs.statSync(firstFullPath).size, firstStable.system.full.size);
    assert.equal(sha256(firstFullPath), firstStable.system.full.sha256);
    const firstFullEntries = tarList(firstFullPath);
    assert.ok(firstFullEntries.includes("_fallout-maw-release.json"));
    assert.ok(firstFullEntries.includes("storage/user-state.json"), "full install must contain the storage seed");
    assert.ok(!firstFullEntries.some((entry) => entry.startsWith("assets/LOST/")), "excluded source files must not enter the full archive");
    const firstReceipt = tarJson(firstFullPath, "_fallout-maw-release.json");
    const installedManifest = tarJson(firstFullPath, "system.json");
    assert.equal(installedManifest.url, config.foundry.packageUrl);
    assert.equal(installedManifest.manifest, config.foundry.manifestUrl);
    assert.equal(installedManifest.download, config.foundry.downloadUrl);
    assert.equal(firstReceipt.version, "1.0.0");
    assert.deepEqual(firstReceipt.preserve, ["storage/"]);
    assert.equal(firstReceipt.files["storage/user-state.json"], undefined, "storage must not be fingerprinted");
    assert.equal(firstReceipt.files["assets/LOST/unused-source.txt"], undefined, "excluded files must not be fingerprinted");
    assert.ok(firstReceipt.files["assets/magazine-№1.webp"]?.sha256, "Unicode runtime paths must be fingerprinted");
    assert.ok(firstReceipt.files["src/main.mjs"]?.sha256);
    assert.deepEqual(firstReceipt.files["system.json"], fileRecordFromBytes(Buffer.from(`${JSON.stringify(installedManifest, null, 2)}\n`)));

    writeJson(path.join(paths.source, "package.json"), { name: "fallout-maw-fixture", version: "1.1.0", type: "module" });
    writeJson(path.join(paths.source, "system.json"), systemManifest("1.1.0"));
    writeText(path.join(paths.source, "src", "main.mjs"), "export const fixture = 2;\n");
    writeText(path.join(paths.source, "assets", "new.txt"), "new file\n");
    fs.rmSync(path.join(paths.source, "assets", "delete.txt"));
    writeJson(path.join(paths.source, "storage", "user-state.json"), { value: 999 });
    writeJson(path.join(paths.source, "storage", "new-user-state.json"), { local: true });

    runCommand("patch", paths);

    const stableBytes = fs.readFileSync(stablePath);
    const stable = JSON.parse(stableBytes);
    assert.equal(stable.sequence, 2);
    assert.equal(stable.system.version, "1.1.0");
    assert.equal(stable.system.full.version, "1.0.0");
    assert.deepEqual(stable.system.full, firstStable.system.full, "the immutable baseline must be reused");
    assert.equal(stable.system.patches.length, 1);
    assert.equal(fs.existsSync(path.join(paths.output, "releases", "1.1.0")), false, "ordinary updates must not duplicate the full baseline");
    assert.equal(JSON.parse(fs.readFileSync(path.join(paths.output, "foundry", "system.json"), "utf8")).version, "1.0.0");
    assert.deepEqual(
      { from: stable.system.patches[0].from, to: stable.system.patches[0].to },
      { from: "1.0.0", to: "1.1.0" }
    );
    assert.ok(!/^[a-z]+:/i.test(stable.system.patches[0].url), "patch URL must be relative");

    const signaturePath = resolveRelative(stablePath, stable.signature.url);
    const publicKey = fs.readFileSync(path.join(paths.keys, "public-key.pem"), "utf8");
    assert.equal(
      crypto.verify("sha256", stableBytes, publicKey, fs.readFileSync(signaturePath)),
      true,
      "stable.json must have a valid detached signature"
    );

    const patchPath = resolveRelative(stablePath, stable.system.patches[0].url);
    assert.equal(fs.statSync(patchPath).size, stable.system.patches[0].size);
    assert.equal(sha256(patchPath), stable.system.patches[0].sha256);
    const patchEntries = tarList(patchPath);
    for (const requiredEntry of ["_fallout-maw-patch.json", "_fallout-maw-base.json", "_fallout-maw-release.json"]) {
      assert.ok(patchEntries.includes(requiredEntry), `patch is missing ${requiredEntry}`);
    }
    assert.ok(patchEntries.includes("payload/src/main.mjs"));
    assert.ok(patchEntries.includes("payload/system.json"));
    assert.ok(patchEntries.includes("payload/assets/new.txt"));
    assert.ok(!patchEntries.some((entry) => entry.startsWith("payload/storage/")), "storage must never enter patch payload");

    const patchMetadata = tarJson(patchPath, "_fallout-maw-patch.json");
    const patchedInstalledManifest = tarJson(patchPath, "payload/system.json");
    assert.equal(patchedInstalledManifest.manifest, config.foundry.manifestUrl);
    assert.equal(patchedInstalledManifest.download, config.foundry.downloadUrl);
    assert.equal(patchMetadata.from, "1.0.0");
    assert.equal(patchMetadata.to, "1.1.0");
    assert.ok(patchMetadata.writes.some((entry) => entry.path === "src/main.mjs"));
    assert.ok(patchMetadata.writes.some((entry) => entry.path === "assets/new.txt"));
    assert.ok(!patchMetadata.writes.some((entry) => entry.path.startsWith("storage/")));
    assert.deepEqual(patchMetadata.deletes, ["assets/delete.txt"]);
    assert.deepEqual(patchMetadata.preserve, ["storage/"]);

    const baseReceipt = tarJson(patchPath, "_fallout-maw-base.json");
    const targetReceipt = tarJson(patchPath, "_fallout-maw-release.json");
    assert.equal(baseReceipt.version, "1.0.0");
    assert.equal(targetReceipt.version, "1.1.0");
    assert.equal(targetReceipt.files["storage/user-state.json"], undefined);
    assert.equal(patchMetadata.fromFingerprint, baseReceipt.fingerprint);
    assert.equal(patchMetadata.toFingerprint, targetReceipt.fingerprint);

    runCommand("verify", paths);
    runCommand("patch", paths);
    assert.equal(JSON.parse(fs.readFileSync(stablePath, "utf8")).sequence, 2, "same-version republish must keep sequence");
    runCommand("verify", paths);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("set-version advances both manifests and rejects a downgrade", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fallout-maw-version-test-"));

  try {
    writeJson(path.join(temporaryRoot, "package.json"), { name: "fallout-maw-fixture", version: "3.4.5" });
    writeJson(path.join(temporaryRoot, "system.json"), systemManifest("3.4.5"));

    const advance = spawnSync(process.execPath, [setVersionPath, "3.5.0", "--root", temporaryRoot], {
      cwd: projectDirectory,
      encoding: "utf8",
      windowsHide: true
    });
    assert.equal(advance.status, 0, `${advance.stdout}\n${advance.stderr}`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(temporaryRoot, "package.json"), "utf8")).version, "3.5.0");
    assert.equal(JSON.parse(fs.readFileSync(path.join(temporaryRoot, "system.json"), "utf8")).version, "3.5.0");

    const downgrade = spawnSync(process.execPath, [setVersionPath, "3.4.9", "--root", temporaryRoot], {
      cwd: projectDirectory,
      encoding: "utf8",
      windowsHide: true
    });
    assert.notEqual(downgrade.status, 0);
    assert.match(downgrade.stderr, /must advance/i);
    assert.equal(JSON.parse(fs.readFileSync(path.join(temporaryRoot, "package.json"), "utf8")).version, "3.5.0");
    assert.equal(JSON.parse(fs.readFileSync(path.join(temporaryRoot, "system.json"), "utf8")).version, "3.5.0");
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
