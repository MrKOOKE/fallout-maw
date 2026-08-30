import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rendererPath = path.join(projectDirectory, "release", "render-google-drive.mjs");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeFile(filePath, value = "fixture\n") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

function listFiles(directoryPath, relativePath = "") {
  const files = [];
  for (const entry of fs.readdirSync(path.join(directoryPath, relativePath), { withFileTypes: true })) {
    const child = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...listFiles(directoryPath, child));
    else files.push(child);
  }
  return files.sort();
}

function driveUrl(id) {
  return `https://drive.google.com/uc?export=download&confirm=t&id=${id}`;
}

function makeFixture(temporaryRoot) {
  const output = path.join(temporaryRoot, "built-output");
  const keys = path.join(temporaryRoot, "private-keys");
  const staging = path.join(temporaryRoot, "drive-staging");
  const mapPath = path.join(temporaryRoot, "drive-files.json");
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  const publicDer = crypto.createPublicKey(publicKey).export({ type: "spki", format: "der" });
  const keyId = `p256-${crypto.createHash("sha256").update(publicDer).digest("hex").slice(0, 24)}`;

  writeFile(path.join(keys, "private-key.pem"), privateKey);
  writeFile(path.join(keys, "public-key.pem"), publicKey);
  const fullPath = "releases/1.0.0/fallout-maw-1.0.0-full.zip";
  const patchPath = "patches/1.0.0-to-1.1.0/fallout-maw-1.0.0-to-1.1.0-patch.zip";
  const stable = {
    schemaVersion: 1,
    productId: "fallout-maw",
    channel: "stable",
    sequence: 7,
    publishedAt: "2026-08-30T12:34:56.000Z",
    signature: {
      algorithm: "ECDSA_P256_SHA256",
      keyId,
      url: "stable.json.sig"
    },
    system: {
      version: "1.1.0",
      minimumLauncherVersion: "1.0.0",
      foundryCompatibility: { minimum: "14", verified: "14.361" },
      foundryManifestUrl: "../foundry/system.json",
      releaseNotes: "Fixture notes",
      full: { version: "1.0.0", url: `../${fullPath}`, size: 12, sha256: "a".repeat(64) },
      patches: [{
        from: "1.0.0",
        to: "1.1.0",
        url: `../${patchPath}`,
        size: 8,
        sha256: "b".repeat(64)
      }]
    }
  };
  const foundry = {
    id: "fallout-maw",
    title: "Fixture",
    version: "1.0.0",
    url: "https://example.invalid/project",
    manifest: "https://old.invalid/system.json",
    download: "https://old.invalid/full.zip",
    compatibility: { minimum: "14", verified: "14.361" }
  };

  writeJson(path.join(output, "channels", "stable.json"), stable);
  writeFile(path.join(output, "channels", "stable.json.sig"), Buffer.from("old signature"));
  writeJson(path.join(output, "foundry", "system.json"), foundry);
  writeFile(path.join(output, ...fullPath.split("/")), "full archive");
  writeFile(path.join(output, ...patchPath.split("/")), "patch zip");

  const ids = {
    stable: "StableJsonFileId_1234567890",
    signature: "StableSignatureId_1234567890",
    foundry: "FoundryManifestId_1234567890",
    full: "FullArchiveFileId_1234567890",
    patch: "PatchArchiveFileId_1234567890"
  };
  writeJson(mapPath, {
    "channels/stable.json": ids.stable,
    "channels/stable.json.sig": ids.signature,
    "foundry/system.json": ids.foundry,
    [fullPath]: ids.full,
    [patchPath]: ids.patch
  });

  return { output, keys, staging, mapPath, publicKey, stable, foundry, ids };
}

test("renders Google Drive URLs into staged metadata and signs the exact final channel bytes", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fallout-maw-drive-render-test-"));
  try {
    const fixture = makeFixture(temporaryRoot);
    const sourceStableBytes = fs.readFileSync(path.join(fixture.output, "channels", "stable.json"));
    const sourceSignatureBytes = fs.readFileSync(path.join(fixture.output, "channels", "stable.json.sig"));
    const sourceFoundryBytes = fs.readFileSync(path.join(fixture.output, "foundry", "system.json"));

    const result = spawnSync(process.execPath, [
      rendererPath,
      "--output", fixture.output,
      "--key-dir", fixture.keys,
      "--id-map", fixture.mapPath,
      "--stage", fixture.staging
    ], { cwd: projectDirectory, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    assert.deepEqual(listFiles(fixture.staging), [
      "channels/stable.json",
      "channels/stable.json.sig",
      "foundry/system.json"
    ]);
    assert.deepEqual(fs.readFileSync(path.join(fixture.output, "channels", "stable.json")), sourceStableBytes);
    assert.deepEqual(fs.readFileSync(path.join(fixture.output, "channels", "stable.json.sig")), sourceSignatureBytes);
    assert.deepEqual(fs.readFileSync(path.join(fixture.output, "foundry", "system.json")), sourceFoundryBytes);

    const stagedStablePath = path.join(fixture.staging, "channels", "stable.json");
    const stagedStableBytes = fs.readFileSync(stagedStablePath);
    const stagedStable = JSON.parse(stagedStableBytes);
    const expectedStable = structuredClone(fixture.stable);
    expectedStable.signature.url = driveUrl(fixture.ids.signature);
    expectedStable.system.foundryManifestUrl = driveUrl(fixture.ids.foundry);
    expectedStable.system.full.url = driveUrl(fixture.ids.full);
    expectedStable.system.patches[0].url = driveUrl(fixture.ids.patch);
    assert.deepEqual(stagedStable, expectedStable, "all non-URL channel fields must be preserved");
    assert.equal(
      crypto.verify(
        "sha256",
        stagedStableBytes,
        fixture.publicKey,
        fs.readFileSync(path.join(fixture.staging, "channels", "stable.json.sig"))
      ),
      true,
      "detached signature must cover the exact staged stable.json bytes"
    );

    const stagedFoundry = JSON.parse(fs.readFileSync(path.join(fixture.staging, "foundry", "system.json"), "utf8"));
    assert.deepEqual(stagedFoundry, {
      ...fixture.foundry,
      manifest: driveUrl(fixture.ids.foundry),
      download: driveUrl(fixture.ids.full)
    });
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("rejects unsafe or incomplete Drive maps without creating staging output", async (context) => {
  await context.test("path traversal", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fallout-maw-drive-map-path-test-"));
    try {
      const fixture = makeFixture(temporaryRoot);
      writeJson(fixture.mapPath, { "../outside.zip": "OutsideFileId_1234567890" });
      const result = spawnSync(process.execPath, [
        rendererPath, "--output", fixture.output, "--key-dir", fixture.keys,
        "--id-map", fixture.mapPath, "--stage", fixture.staging
      ], { cwd: projectDirectory, encoding: "utf8", windowsHide: true });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /unsafe|relative POSIX/i);
      assert.equal(fs.existsSync(fixture.staging), false);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  await context.test("missing artifact ID", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fallout-maw-drive-map-missing-test-"));
    try {
      const fixture = makeFixture(temporaryRoot);
      const map = JSON.parse(fs.readFileSync(fixture.mapPath, "utf8"));
      delete map["channels/stable.json.sig"];
      writeJson(fixture.mapPath, map);
      const result = spawnSync(process.execPath, [
        rendererPath, "--output", fixture.output, "--key-dir", fixture.keys,
        "--id-map", fixture.mapPath, "--stage", fixture.staging
      ], { cwd: projectDirectory, encoding: "utf8", windowsHide: true });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /missing stable signature/i);
      assert.equal(fs.existsSync(fixture.staging), false);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
