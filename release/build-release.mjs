import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = 1;
const SIGNATURE_ALGORITHM = "ECDSA_P256_SHA256";
const RELEASE_METADATA_NAME = "_fallout-maw-release.json";
const PATCH_METADATA_NAME = "_fallout-maw-patch.json";
const PATCH_BASE_NAME = "_fallout-maw-base.json";
const PRIVATE_KEY_NAME = "private-key.pem";
const PUBLIC_KEY_NAME = "public-key.pem";
const KEY_INFO_NAME = "key-info.json";
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultSourceDirectory = path.resolve(scriptDirectory, "..");
const defaultDataDirectory = path.resolve(defaultSourceDirectory, "..", "..");
const defaultConfigPath = path.join(scriptDirectory, "release-config.json");
const publisherLocalPath = path.join(scriptDirectory, "publisher.local.json");
const defaultOutputDirectory = path.join(defaultDataDirectory, "outputs", "fallout-maw-release");
const defaultStatePath = path.join(defaultDataDirectory, "release-state", "fallout-maw", "stable.json");
const defaultKeyDirectory = path.join(defaultDataDirectory, "release-keys", "fallout-maw");

class ReleaseError extends Error {}

function fail(message) {
  throw new ReleaseError(message);
}

function usage() {
  return `Usage:
  node release/build-release.mjs keygen  [--source PATH] [--config PATH] [--key-dir PATH] [--force]
  node release/build-release.mjs snapshot [--source PATH] [--output PATH] [--state PATH] [--config PATH] [--key-dir PATH]
  node release/build-release.mjs patch    [--source PATH] [--output PATH] [--state PATH] [--config PATH] [--key-dir PATH]
  node release/build-release.mjs verify   [--output PATH] [--config PATH] [--key-dir PATH]

Paths default outside the system folder. Private signing keys and release state must not be stored in the source or public output tree.`;
}

function parseArguments(argv) {
  const command = argv[0];
  if (!command || command === "--help" || command === "-h") {
    console.log(usage());
    process.exit(0);
  }
  if (!new Set(["keygen", "snapshot", "patch", "verify"]).has(command)) {
    fail(`Unknown command: ${command}\n\n${usage()}`);
  }

  const options = {
    command,
    sourceDirectory: defaultSourceDirectory,
    outputDirectory: defaultOutputDirectory,
    statePath: defaultStatePath,
    configPath: defaultConfigPath,
    keyDirectory: defaultKeyDirectory,
    force: false
  };
  const valueFlags = new Map([
    ["--source", "sourceDirectory"],
    ["--output", "outputDirectory"],
    ["--state", "statePath"],
    ["--config", "configPath"],
    ["--key-dir", "keyDirectory"]
  ]);

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--force") {
      options.force = true;
      continue;
    }
    const property = valueFlags.get(argument);
    if (!property) fail(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${argument} requires a path.`);
    options[property] = path.resolve(value);
    index += 1;
  }

  for (const property of ["sourceDirectory", "outputDirectory", "statePath", "configPath", "keyDirectory"]) {
    options[property] = path.resolve(options[property]);
  }
  return options;
}

function readJson(filePath, label = "JSON file") {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`Cannot read ${label} at ${filePath}: ${error.message}`);
  }
}

function readEffectiveConfig(configPath) {
  const config = readJson(configPath, "release config");
  if (path.resolve(configPath) !== path.resolve(defaultConfigPath) || !fs.existsSync(publisherLocalPath)) return config;
  const publisher = readJson(publisherLocalPath, "local publisher config");
  if (publisher.foundry && (typeof publisher.foundry !== "object" || Array.isArray(publisher.foundry))) {
    fail("publisher.local.json foundry override must be an object.");
  }
  return {
    ...config,
    foundry: {
      ...(config.foundry ?? {}),
      ...(publisher.foundry ?? {})
    }
  };
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function randomSuffix() {
  return `${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
}

function writeAtomic(filePath, bytes, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomSuffix()}.tmp`);
  try {
    fs.writeFileSync(temporaryPath, bytes, mode ? { mode } : undefined);
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
  }
}

function writeJsonAtomic(filePath, value) {
  writeAtomic(filePath, jsonBytes(value));
}

function writeImmutableJson(filePath, value) {
  const bytes = jsonBytes(value);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath);
    if (!existing.equals(bytes)) fail(`Immutable artifact already exists with different content: ${filePath}`);
    return;
  }
  fs.writeFileSync(filePath, bytes, { flag: "wx" });
}

function isInside(parentPath, candidatePath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function ensureOperationalPaths(options) {
  if (isInside(options.sourceDirectory, options.outputDirectory)) {
    fail("Release output must be outside the source directory.");
  }
  if (isInside(options.outputDirectory, options.statePath)) {
    fail("Release state must be outside the public output directory.");
  }
  if (isInside(options.sourceDirectory, options.statePath)) {
    fail("Release state must be outside the source directory.");
  }
  if (isInside(options.sourceDirectory, options.keyDirectory)) {
    fail("Private signing keys must be outside the source directory.");
  }
}

function validateArchivePath(value, label = "archive path") {
  if (typeof value !== "string" || !value) fail(`${label} must be a non-empty string.`);
  if (value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    fail(`Unsafe ${label}: ${value}`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) fail(`Unsafe control character in ${label}: ${value}`);
  const withoutTrailingSlash = value.endsWith("/") ? value.slice(0, -1) : value;
  const segments = withoutTrailingSlash.split("/");
  if (!withoutTrailingSlash || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    fail(`Unsafe ${label}: ${value}`);
  }
  if (segments[0].startsWith("-")) fail(`Unsafe option-like ${label}: ${value}`);
  return withoutTrailingSlash;
}

function normalizePreservePrefix(value) {
  return `${validateArchivePath(value, "preserve prefix")}/`;
}

function isPreserved(relativePath, preservePrefixes) {
  return preservePrefixes.some((prefix) => relativePath === prefix.slice(0, -1) || relativePath.startsWith(prefix));
}

function normalizeExcludePath(value) {
  const rawValue = String(value ?? "");
  const normalized = validateArchivePath(rawValue, "exclude path");
  return rawValue.endsWith("/") ? `${normalized}/` : normalized;
}

function isExcluded(relativePath, excludePaths) {
  return excludePaths.some((excludedPath) => excludedPath.endsWith("/")
    ? relativePath === excludedPath.slice(0, -1) || relativePath.startsWith(excludedPath)
    : relativePath === excludedPath);
}

function validateConfig(rawConfig) {
  if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) fail("Release config must be an object.");
  if (rawConfig.schemaVersion !== SCHEMA_VERSION) fail(`Unsupported release config schema: ${rawConfig.schemaVersion}`);
  const productId = String(rawConfig.productId ?? "");
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(productId)) fail("productId must be safe for paths and URLs.");
  const channel = String(rawConfig.channel ?? "");
  if (channel !== "stable") fail('This pipeline currently requires channel "stable".');
  if (typeof rawConfig.minimumLauncherVersion !== "string" || !SEMVER_PATTERN.test(rawConfig.minimumLauncherVersion)) {
    fail("minimumLauncherVersion must be a semantic version.");
  }
  if (!Array.isArray(rawConfig.allowlist) || rawConfig.allowlist.length === 0) fail("allowlist must not be empty.");
  const allowlist = rawConfig.allowlist.map((entry) => {
    const normalized = validateArchivePath(entry, "allowlist entry");
    if (normalized.includes("/")) fail(`Allowlist entries must be top-level paths: ${entry}`);
    return normalized;
  });
  if (new Set(allowlist).size !== allowlist.length) fail("allowlist contains duplicates.");
  if (rawConfig.exclude !== undefined && !Array.isArray(rawConfig.exclude)) fail("exclude must be an array.");
  const exclude = (rawConfig.exclude ?? []).map(normalizeExcludePath);
  if (new Set(exclude).size !== exclude.length) fail("exclude contains duplicates.");
  for (const excludedPath of exclude) {
    const root = excludedPath.split("/")[0];
    if (!allowlist.includes(root)) fail(`Excluded path is outside the allowlist: ${excludedPath}`);
    if (excludedPath === "system.json") fail("system.json cannot be excluded from a release.");
  }
  const preserve = (rawConfig.preserve ?? []).map(normalizePreservePrefix);
  if (new Set(preserve).size !== preserve.length) fail("preserve contains duplicates.");
  for (const prefix of preserve) {
    const root = prefix.split("/")[0];
    if (!allowlist.includes(root)) fail(`Preserved path is outside the allowlist: ${prefix}`);
  }
  const hashConcurrency = Number(rawConfig.hashConcurrency ?? 4);
  if (!Number.isInteger(hashConcurrency) || hashConcurrency < 1 || hashConcurrency > 32) {
    fail("hashConcurrency must be an integer from 1 through 32.");
  }
  return {
    ...rawConfig,
    productId,
    channel,
    allowlist,
    exclude,
    preserve,
    hashConcurrency
  };
}

function releaseNotesFor(config, version) {
  if (typeof config.releaseNotes === "string") return config.releaseNotes;
  if (config.releaseNotes && typeof config.releaseNotes === "object") {
    const versionNote = config.releaseNotes.versions?.[version];
    if (typeof versionNote === "string") return versionNote;
    if (typeof config.releaseNotes.default === "string") return config.releaseNotes.default;
  }
  return "";
}

function parseSemver(version, label = "version") {
  const match = SEMVER_PATTERN.exec(String(version ?? ""));
  if (!match) fail(`${label} must be a semantic version: ${version}`);
  return {
    raw: String(version),
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : []
  };
}

function compareSemver(leftVersion, rightVersion) {
  const left = parseSemver(leftVersion);
  const right = parseSemver(rightVersion);
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) < Number(rightPart) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function versionForPath(version) {
  parseSemver(version);
  return version.replaceAll("+", "_");
}

function loadSourceManifest(sourceDirectory, config) {
  const sourceStat = fs.lstatSync(sourceDirectory);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) fail(`Source must be a real directory: ${sourceDirectory}`);
  const packageManifest = readJson(path.join(sourceDirectory, "package.json"), "package manifest");
  const systemManifest = readJson(path.join(sourceDirectory, "system.json"), "Foundry system manifest");
  if (packageManifest.version !== systemManifest.version) {
    fail(`Version mismatch: package.json=${packageManifest.version}, system.json=${systemManifest.version}`);
  }
  parseSemver(systemManifest.version, "system version");
  if (systemManifest.id !== config.productId) {
    fail(`system.json id ${systemManifest.id} does not match productId ${config.productId}.`);
  }
  const compatibility = systemManifest.compatibility;
  if (!compatibility || typeof compatibility.minimum !== "string" || typeof compatibility.verified !== "string") {
    fail("system.json compatibility.minimum and compatibility.verified are required.");
  }
  const releaseSystemManifest = foundryManifestFor(systemManifest, config);
  const runtimeOverrides = new Map([["system.json", jsonBytes(releaseSystemManifest)]]);
  return { packageManifest, systemManifest, releaseSystemManifest, runtimeOverrides, version: systemManifest.version };
}

function collectRuntimeFiles(sourceDirectory, config) {
  const allFiles = [];
  const presentRoots = [];

  function visit(relativePath) {
    const safePath = validateArchivePath(relativePath, "source path");
    if (isExcluded(safePath, config.exclude)) return;
    const absolutePath = path.join(sourceDirectory, ...safePath.split("/"));
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) fail(`Symbolic links are not allowed in releases: ${safePath}`);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(absolutePath).sort((left, right) => left.localeCompare(right, "en"));
      for (const entry of entries) visit(`${safePath}/${entry}`);
      return;
    }
    if (!stat.isFile()) fail(`Unsupported filesystem entry in release: ${safePath}`);
    allFiles.push(safePath);
  }

  for (const root of config.allowlist) {
    const absoluteRoot = path.join(sourceDirectory, root);
    if (!fs.existsSync(absoluteRoot)) continue;
    presentRoots.push(root);
    visit(root);
  }
  if (!presentRoots.includes("system.json")) fail("system.json must be present in the release allowlist and source.");
  if (!allFiles.includes("system.json")) fail("system.json must be present in the release file set.");
  allFiles.sort((left, right) => left.localeCompare(right, "en"));
  const managedFiles = allFiles.filter((relativePath) => !isPreserved(relativePath, config.preserve));
  return { allFiles, managedFiles, presentRoots };
}

function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, () => worker()));
  return results;
}

async function buildReceipt(sourceDirectory, sourceManifest, runtimeFiles, config, runtimeOverrides = new Map()) {
  const records = await mapWithConcurrency(runtimeFiles.managedFiles, config.hashConcurrency, async (relativePath) => {
    const overriddenBytes = runtimeOverrides.get(relativePath);
    if (overriddenBytes) {
      return {
        path: relativePath,
        size: overriddenBytes.length,
        sha256: sha256Bytes(overriddenBytes)
      };
    }
    const absolutePath = path.join(sourceDirectory, ...relativePath.split("/"));
    const stat = fs.statSync(absolutePath);
    return {
      path: relativePath,
      size: stat.size,
      sha256: await hashFile(absolutePath)
    };
  });
  records.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const files = {};
  for (const record of records) files[record.path] = { size: record.size, sha256: record.sha256 };
  const fingerprint = sha256Bytes(Buffer.from(JSON.stringify(files), "utf8"));
  return {
    schemaVersion: SCHEMA_VERSION,
    productId: config.productId,
    version: sourceManifest.version,
    fingerprint,
    preserve: [...config.preserve],
    files
  };
}

function keyIdForPublicKey(publicKeyPem) {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return `p256-${sha256Bytes(der).slice(0, 24)}`;
}

function loadPublicKey(keyDirectory) {
  const publicKeyPath = path.join(keyDirectory, PUBLIC_KEY_NAME);
  let publicKeyPem;
  try {
    publicKeyPem = fs.readFileSync(publicKeyPath, "utf8");
  } catch (error) {
    fail(`Cannot read public signing key at ${publicKeyPath}: ${error.message}`);
  }
  return { publicKeyPem, keyId: keyIdForPublicKey(publicKeyPem) };
}

function loadSigningKeys(keyDirectory) {
  const { publicKeyPem, keyId } = loadPublicKey(keyDirectory);
  const privateKeyPath = path.join(keyDirectory, PRIVATE_KEY_NAME);
  let privateKeyPem;
  try {
    privateKeyPem = fs.readFileSync(privateKeyPath, "utf8");
  } catch (error) {
    fail(`Cannot read private signing key at ${privateKeyPath}: ${error.message}`);
  }
  const derivedPublicPem = crypto.createPublicKey(privateKeyPem).export({ type: "spki", format: "pem" });
  if (keyIdForPublicKey(derivedPublicPem) !== keyId) fail("Private and public signing keys do not match.");
  return { privateKeyPem, publicKeyPem, keyId };
}

function generateSigningKeys(options, config) {
  if (isInside(options.sourceDirectory, options.keyDirectory)) fail("Private signing keys must be outside the source directory.");
  fs.mkdirSync(options.keyDirectory, { recursive: true });
  const privateKeyPath = path.join(options.keyDirectory, PRIVATE_KEY_NAME);
  const publicKeyPath = path.join(options.keyDirectory, PUBLIC_KEY_NAME);
  const keyInfoPath = path.join(options.keyDirectory, KEY_INFO_NAME);
  const existing = [privateKeyPath, publicKeyPath, keyInfoPath].filter((filePath) => fs.existsSync(filePath));
  if (existing.length && !options.force) {
    fail(`Signing key files already exist. Use --force only when intentionally rotating keys: ${options.keyDirectory}`);
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  const keyId = keyIdForPublicKey(publicKey);
  writeAtomic(privateKeyPath, Buffer.from(privateKey, "utf8"), 0o600);
  writeAtomic(publicKeyPath, Buffer.from(publicKey, "utf8"));
  writeJsonAtomic(keyInfoPath, {
    schemaVersion: SCHEMA_VERSION,
    productId: config.productId,
    algorithm: SIGNATURE_ALGORITHM,
    keyId,
    publicKeyFile: PUBLIC_KEY_NAME
  });
  console.log(`Generated ${SIGNATURE_ALGORITHM} signing key ${keyId}`);
  console.log(`Private key: ${privateKeyPath}`);
  console.log(`Public key:  ${publicKeyPath}`);
}

function runTar(args, label, options = {}) {
  const result = spawnSync("tar", args, {
    encoding: options.encoding ?? "utf8",
    maxBuffer: options.maxBuffer ?? 256 * 1024 * 1024,
    windowsHide: true,
    stdio: options.stdio ?? "pipe"
  });
  if (result.error) fail(`Could not start tar while ${label}: ${result.error.message}`);
  if (result.status !== 0) {
    const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    fail(`tar failed while ${label} with exit code ${result.status}${details ? `:\n${details}` : "."}`);
  }
  return result;
}

function temporaryArchivePath(finalPath) {
  return path.join(path.dirname(finalPath), `.${path.basename(finalPath, ".zip")}.${randomSuffix()}.zip`);
}

function createFullArchive(archivePath, sourceDirectory, runtimeFilePaths, receipt, runtimeOverrides = new Map()) {
  if (fs.existsSync(archivePath)) fail(`Immutable full archive already exists: ${archivePath}`);
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  const stagingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "fallout-maw-full-staging-"));
  const temporaryArchive = temporaryArchivePath(archivePath);
  try {
    fs.writeFileSync(path.join(stagingDirectory, RELEASE_METADATA_NAME), jsonBytes(receipt));
    const overridePaths = new Set();
    for (const [relativePath, bytes] of runtimeOverrides) {
      validateArchivePath(relativePath, "runtime override path");
      if (relativePath.includes("/")) fail(`Runtime overrides must be top-level files: ${relativePath}`);
      const destinationPath = path.join(stagingDirectory, relativePath);
      fs.writeFileSync(destinationPath, bytes);
      overridePaths.add(relativePath);
    }

    for (const relativePath of runtimeFilePaths) {
      if (overridePaths.has(relativePath)) continue;
      const pathParts = relativePath.split("/");
      linkOrCopy(path.join(sourceDirectory, ...pathParts), path.join(stagingDirectory, ...pathParts));
    }

    const archiveRoots = fs.readdirSync(stagingDirectory).sort((left, right) => left.localeCompare(right, "en"));
    runTar(["-a", "-cf", temporaryArchive, "-C", stagingDirectory, ...archiveRoots], "creating the full ZIP64 archive");
    fs.renameSync(temporaryArchive, archivePath);
  } finally {
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
    if (fs.existsSync(temporaryArchive)) fs.rmSync(temporaryArchive, { force: true });
  }
}

function linkOrCopy(sourcePath, destinationPath) {
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  try {
    fs.linkSync(sourcePath, destinationPath);
  } catch (error) {
    if (!new Set(["EXDEV", "EPERM", "EACCES", "EINVAL", "ENOTSUP"]).has(error.code)) throw error;
    fs.copyFileSync(sourcePath, destinationPath);
  }
}

function createPatchArchive(archivePath, sourceDirectory, patchMetadata, baseReceipt, targetReceipt, runtimeOverrides = new Map()) {
  if (fs.existsSync(archivePath)) fail(`Immutable patch archive already exists: ${archivePath}`);
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  const stagingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "fallout-maw-patch-"));
  const temporaryArchive = temporaryArchivePath(archivePath);
  try {
    fs.writeFileSync(path.join(stagingDirectory, PATCH_METADATA_NAME), jsonBytes(patchMetadata));
    fs.writeFileSync(path.join(stagingDirectory, PATCH_BASE_NAME), jsonBytes(baseReceipt));
    fs.writeFileSync(path.join(stagingDirectory, RELEASE_METADATA_NAME), jsonBytes(targetReceipt));
    fs.mkdirSync(path.join(stagingDirectory, "payload"), { recursive: true });
    for (const write of patchMetadata.writes) {
      const destinationPath = path.join(stagingDirectory, "payload", ...write.path.split("/"));
      const overriddenBytes = runtimeOverrides.get(write.path);
      if (overriddenBytes) {
        fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
        fs.writeFileSync(destinationPath, overriddenBytes);
      } else {
        const sourcePath = path.join(sourceDirectory, ...write.path.split("/"));
        linkOrCopy(sourcePath, destinationPath);
      }
    }
    runTar([
      "-a", "-cf", temporaryArchive,
      "-C", stagingDirectory,
      PATCH_METADATA_NAME,
      PATCH_BASE_NAME,
      RELEASE_METADATA_NAME,
      "payload"
    ], "creating the patch ZIP64 archive");
    fs.renameSync(temporaryArchive, archivePath);
  } finally {
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
    if (fs.existsSync(temporaryArchive)) fs.rmSync(temporaryArchive, { force: true });
  }
}

function relativeArtifactUrl(stablePath, artifactPath) {
  const relative = path.relative(path.dirname(stablePath), artifactPath).split(path.sep).join("/");
  if (!relative || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(relative) || relative.startsWith("//")) {
    fail(`Artifact URL must be relative: ${artifactPath}`);
  }
  return relative;
}

async function artifactDescriptor(stablePath, artifactPath) {
  const stat = fs.statSync(artifactPath);
  return {
    url: relativeArtifactUrl(stablePath, artifactPath),
    size: stat.size,
    sha256: await hashFile(artifactPath)
  };
}

function artifactPaths(options, config, version) {
  const safeVersion = versionForPath(version);
  const stablePath = path.join(options.outputDirectory, "channels", "stable.json");
  const releaseDirectory = path.join(options.outputDirectory, "releases", safeVersion);
  return {
    stablePath,
    signaturePath: path.join(options.outputDirectory, "channels", "stable.json.sig"),
    foundryManifestPath: path.join(options.outputDirectory, "foundry", "system.json"),
    fullArchivePath: path.join(releaseDirectory, `${config.productId}-${safeVersion}-full.zip`),
    receiptPath: path.join(releaseDirectory, `${config.productId}-${safeVersion}-receipt.json`)
  };
}

function patchArtifactPath(options, config, fromVersion, toVersion) {
  const safeFrom = versionForPath(fromVersion);
  const safeTo = versionForPath(toVersion);
  return path.join(
    options.outputDirectory,
    "patches",
    `${safeFrom}-to-${safeTo}`,
    `${config.productId}-${safeFrom}-to-${safeTo}-patch.zip`
  );
}

function foundryManifestFor(systemManifest, config) {
  const manifest = structuredClone(systemManifest);
  const foundryOverrides = config.foundry ?? {};
  for (const [overrideName, manifestName] of [
    ["packageUrl", "url"],
    ["manifestUrl", "manifest"],
    ["downloadUrl", "download"]
  ]) {
    if (!Object.hasOwn(foundryOverrides, overrideName)) continue;
    const value = foundryOverrides[overrideName];
    if (value === null) delete manifest[manifestName];
    else if (typeof value === "string" && value) manifest[manifestName] = value;
    else fail(`foundry.${overrideName} must be a non-empty URL string or null.`);
  }
  return manifest;
}

function writeFoundryManifest(filePath, systemManifest, config) {
  writeJsonAtomic(filePath, foundryManifestFor(systemManifest, config));
}

function validateReceipt(receipt, expectedProductId, label = "release receipt") {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) fail(`${label} must be an object.`);
  if (receipt.schemaVersion !== SCHEMA_VERSION) fail(`${label} has unsupported schemaVersion.`);
  if (receipt.productId !== expectedProductId) fail(`${label} has the wrong productId.`);
  parseSemver(receipt.version, `${label} version`);
  if (!Array.isArray(receipt.preserve)) fail(`${label}.preserve must be an array.`);
  const preserve = receipt.preserve.map(normalizePreservePrefix);
  if (!receipt.files || typeof receipt.files !== "object" || Array.isArray(receipt.files)) fail(`${label}.files must be an object.`);
  const sortedPaths = Object.keys(receipt.files).sort((left, right) => left.localeCompare(right, "en"));
  const canonicalFiles = {};
  for (const filePath of sortedPaths) {
    validateArchivePath(filePath, `${label} file path`);
    if (isPreserved(filePath, preserve)) fail(`${label} must not fingerprint preserved file: ${filePath}`);
    const record = receipt.files[filePath];
    if (!record || !Number.isInteger(record.size) || record.size < 0 || !HASH_PATTERN.test(record.sha256)) {
      fail(`${label} has invalid metadata for ${filePath}.`);
    }
    canonicalFiles[filePath] = { size: record.size, sha256: record.sha256 };
  }
  const expectedFingerprint = sha256Bytes(Buffer.from(JSON.stringify(canonicalFiles), "utf8"));
  if (receipt.fingerprint !== expectedFingerprint) fail(`${label} fingerprint does not match its files.`);
  return { ...receipt, preserve, files: canonicalFiles };
}

function loadState(options, config, required) {
  if (!fs.existsSync(options.statePath)) {
    if (required) fail(`Release state is missing: ${options.statePath}. Run snapshot first.`);
    return null;
  }
  const state = readJson(options.statePath, "release state");
  if (state.schemaVersion !== SCHEMA_VERSION || state.productId !== config.productId || state.channel !== config.channel) {
    fail("Release state does not match the configured product/channel/schema.");
  }
  if (!Number.isInteger(state.sequence) || state.sequence < 1) fail("Release state sequence must be a positive integer.");
  state.currentReceipt = validateReceipt(state.currentReceipt, config.productId, "state currentReceipt");
  if (!state.full) fail("Release state full artifact is invalid.");
  validateArtifactRecord(state.full, "state full artifact", true);
  if (compareSemver(state.full.version, state.currentReceipt.version) > 0) fail("Release state baseline is newer than the current version.");
  if (!Array.isArray(state.patches)) fail("Release state patches must be an array.");
  state.patches.forEach((record, index) => validatePatchRecord(record, `state patch ${index}`));
  validatePatchChain(state.patches, state.currentReceipt.version, state.full.version);
  return state;
}

function validateArtifactRecord(record, label, allowVersion = false) {
  if (!record || typeof record !== "object" || Array.isArray(record)) fail(`${label} must be an object.`);
  if (typeof record.url !== "string" || !record.url) fail(`${label}.url is required.`);
  if (!Number.isInteger(record.size) || record.size < 0 || !HASH_PATTERN.test(record.sha256)) {
    fail(`${label} has invalid size or sha256.`);
  }
  if (allowVersion) parseSemver(record.version, `${label} version`);
}

function validatePatchRecord(record, label) {
  validateArtifactRecord(record, label);
  parseSemver(record.from, `${label} from`);
  parseSemver(record.to, `${label} to`);
  if (compareSemver(record.from, record.to) >= 0) fail(`${label} must advance the version.`);
}

function validatePatchChain(patches, targetVersion, baselineVersion = null) {
  if (baselineVersion && patches.length === 0 && baselineVersion !== targetVersion) {
    fail("Patch history is empty but the baseline is not the current version.");
  }
  if (baselineVersion && patches.length && patches[0].from !== baselineVersion) {
    fail("Patch history does not start at the baseline version.");
  }
  for (let index = 1; index < patches.length; index += 1) {
    if (patches[index - 1].to !== patches[index].from) fail("Patch history is not a continuous chain.");
  }
  if (patches.length && patches.at(-1).to !== targetVersion) fail("Patch history does not end at the current version.");
}

function buildStableDocument({ config, sourceManifest, sequence, keyId, stablePath, full, patches, publishedAt }) {
  const foundryManifestPath = path.join(path.dirname(path.dirname(stablePath)), "foundry", "system.json");
  return {
    schemaVersion: SCHEMA_VERSION,
    productId: config.productId,
    channel: config.channel,
    sequence,
    publishedAt,
    signature: {
      algorithm: SIGNATURE_ALGORITHM,
      keyId,
      url: "stable.json.sig"
    },
    system: {
      version: sourceManifest.version,
      minimumLauncherVersion: config.minimumLauncherVersion,
      foundryCompatibility: {
        minimum: sourceManifest.compatibility.minimum,
        verified: sourceManifest.compatibility.verified
      },
      foundryManifestUrl: relativeArtifactUrl(stablePath, foundryManifestPath),
      releaseNotes: releaseNotesFor(config, sourceManifest.version),
      full: { version: full.version, url: full.url, size: full.size, sha256: full.sha256 },
      patches: patches.map((patchRecord) => ({
        from: patchRecord.from,
        to: patchRecord.to,
        url: patchRecord.url,
        size: patchRecord.size,
        sha256: patchRecord.sha256
      }))
    }
  };
}

function publishStable(stablePath, stableDocument, privateKeyPem) {
  const bytes = jsonBytes(stableDocument);
  const signature = crypto.sign("sha256", bytes, privateKeyPem);
  const signaturePath = path.join(path.dirname(stablePath), stableDocument.signature.url);
  writeAtomic(signaturePath, signature);
  writeAtomic(stablePath, bytes);
}

function changedFiles(baseReceipt, targetReceipt) {
  const writes = [];
  const deletes = [];
  for (const [filePath, targetRecord] of Object.entries(targetReceipt.files)) {
    const baseRecord = baseReceipt.files[filePath];
    if (!baseRecord || baseRecord.size !== targetRecord.size || baseRecord.sha256 !== targetRecord.sha256) {
      writes.push({ path: filePath, size: targetRecord.size, sha256: targetRecord.sha256 });
    }
  }
  for (const filePath of Object.keys(baseReceipt.files)) {
    if (!targetReceipt.files[filePath]) deletes.push(filePath);
  }
  writes.sort((left, right) => left.path.localeCompare(right.path, "en"));
  deletes.sort((left, right) => left.localeCompare(right, "en"));
  return { writes, deletes };
}

async function buildFullRelease(options, config, sourceInfo, runtimeFiles, receipt) {
  const paths = artifactPaths(options, config, sourceInfo.version);
  createFullArchive(paths.fullArchivePath, options.sourceDirectory, runtimeFiles.allFiles, receipt, sourceInfo.runtimeOverrides);
  writeImmutableJson(paths.receiptPath, receipt);
  const descriptor = await artifactDescriptor(paths.stablePath, paths.fullArchivePath);
  return { ...descriptor, version: sourceInfo.version, paths };
}

async function republishCurrent(options, config, state, sourceInfo, receipt, keys) {
  if (receipt.fingerprint !== state.currentReceipt.fingerprint) {
    fail(`Managed files changed without a version bump (${sourceInfo.version}).`);
  }
  const paths = artifactPaths(options, config, sourceInfo.version);
  const fullPath = resolveArtifactPath(options.outputDirectory, paths.stablePath, state.full.url);
  if (!fs.existsSync(fullPath) || fs.statSync(fullPath).size !== state.full.size) {
    fail("Current immutable full artifact is missing or has the wrong size; run verify or restore it.");
  }
  if (!fs.existsSync(paths.foundryManifestPath)) {
    fail("Baseline Foundry manifest is missing; restore the snapshot output before republishing.");
  }
  const publishedAt = new Date().toISOString();
  const stableDocument = buildStableDocument({
    config,
    sourceManifest: sourceInfo.systemManifest,
    sequence: state.sequence,
    keyId: keys.keyId,
    stablePath: paths.stablePath,
    full: state.full,
    patches: state.patches,
    publishedAt
  });
  publishStable(paths.stablePath, stableDocument, keys.privateKeyPem);
  console.log(`Republished ${config.channel} ${sourceInfo.version} with unchanged sequence ${state.sequence}.`);
}

async function createSnapshot(options, config) {
  ensureOperationalPaths(options);
  const keys = loadSigningKeys(options.keyDirectory);
  const sourceInfo = loadSourceManifest(options.sourceDirectory, config);
  const runtimeFiles = collectRuntimeFiles(options.sourceDirectory, config);
  const receipt = await buildReceipt(options.sourceDirectory, sourceInfo.releaseSystemManifest, runtimeFiles, config, sourceInfo.runtimeOverrides);
  const existingState = loadState(options, config, false);
  if (existingState) {
    if (existingState.currentReceipt.version !== sourceInfo.version) {
      fail(`State already contains ${existingState.currentReceipt.version}; use patch to publish ${sourceInfo.version}.`);
    }
    await republishCurrent(options, config, existingState, sourceInfo, receipt, keys);
    return;
  }

  const full = await buildFullRelease(options, config, sourceInfo, runtimeFiles, receipt);
  writeFoundryManifest(full.paths.foundryManifestPath, sourceInfo.systemManifest, config);
  const sequence = 1;
  const publishedAt = new Date().toISOString();
  const state = {
    schemaVersion: SCHEMA_VERSION,
    productId: config.productId,
    channel: config.channel,
    sequence,
    currentReceipt: receipt,
    full: { version: full.version, url: full.url, size: full.size, sha256: full.sha256 },
    patches: [],
    updatedAt: publishedAt
  };
  writeJsonAtomic(options.statePath, state);
  const stableDocument = buildStableDocument({
    config,
    sourceManifest: sourceInfo.systemManifest,
    sequence,
    keyId: keys.keyId,
    stablePath: full.paths.stablePath,
    full: state.full,
    patches: [],
    publishedAt
  });
  publishStable(full.paths.stablePath, stableDocument, keys.privateKeyPem);
  console.log(`Snapshot ${sourceInfo.version} created with sequence ${sequence}.`);
  console.log(`Full archive: ${full.paths.fullArchivePath}`);
  console.log(`Stable channel: ${full.paths.stablePath}`);
}

async function createPatch(options, config) {
  ensureOperationalPaths(options);
  const keys = loadSigningKeys(options.keyDirectory);
  const state = loadState(options, config, true);
  const sourceInfo = loadSourceManifest(options.sourceDirectory, config);
  const runtimeFiles = collectRuntimeFiles(options.sourceDirectory, config);
  const targetReceipt = await buildReceipt(options.sourceDirectory, sourceInfo.releaseSystemManifest, runtimeFiles, config, sourceInfo.runtimeOverrides);
  const versionOrder = compareSemver(sourceInfo.version, state.currentReceipt.version);
  if (versionOrder < 0) fail(`Refusing version rollback from ${state.currentReceipt.version} to ${sourceInfo.version}.`);
  if (versionOrder === 0) {
    await republishCurrent(options, config, state, sourceInfo, targetReceipt, keys);
    return;
  }

  const paths = artifactPaths(options, config, sourceInfo.version);
  const diff = changedFiles(state.currentReceipt, targetReceipt);
  const patchMetadata = {
    schemaVersion: SCHEMA_VERSION,
    productId: config.productId,
    from: state.currentReceipt.version,
    to: sourceInfo.version,
    fromFingerprint: state.currentReceipt.fingerprint,
    toFingerprint: targetReceipt.fingerprint,
    writes: diff.writes,
    deletes: diff.deletes,
    preserve: [...config.preserve]
  };
  const patchPath = patchArtifactPath(options, config, patchMetadata.from, patchMetadata.to);
  createPatchArchive(patchPath, options.sourceDirectory, patchMetadata, state.currentReceipt, targetReceipt, sourceInfo.runtimeOverrides);
  const patchDescriptor = await artifactDescriptor(paths.stablePath, patchPath);
  const patchRecord = {
    from: patchMetadata.from,
    to: patchMetadata.to,
    ...patchDescriptor
  };
  const patches = [...state.patches, patchRecord];
  validatePatchChain(patches, sourceInfo.version, state.full.version);
  if (!fs.existsSync(paths.foundryManifestPath)) {
    fail("Baseline Foundry manifest is missing; restore the snapshot output before creating a patch.");
  }
  const sequence = state.sequence + 1;
  const publishedAt = new Date().toISOString();
  const nextState = {
    schemaVersion: SCHEMA_VERSION,
    productId: config.productId,
    channel: config.channel,
    sequence,
    currentReceipt: targetReceipt,
    full: state.full,
    patches,
    updatedAt: publishedAt
  };
  writeJsonAtomic(options.statePath, nextState);
  const stableDocument = buildStableDocument({
    config,
    sourceManifest: sourceInfo.systemManifest,
    sequence,
    keyId: keys.keyId,
    stablePath: paths.stablePath,
    full: nextState.full,
    patches,
    publishedAt
  });
  publishStable(paths.stablePath, stableDocument, keys.privateKeyPem);
  console.log(`Patch ${patchMetadata.from} -> ${patchMetadata.to} created with sequence ${sequence}.`);
  console.log(`Writes: ${diff.writes.length}; deletes: ${diff.deletes.length}`);
  console.log(`Patch archive: ${patchPath}`);
  console.log(`Baseline full archive remains ${state.full.version}; no duplicate full package was created.`);
}

function resolveArtifactPath(outputDirectory, stablePath, relativeUrl) {
  if (typeof relativeUrl !== "string" || !relativeUrl || relativeUrl.includes("\\") || relativeUrl.includes("?") || relativeUrl.includes("#")) {
    fail(`Unsafe relative artifact URL: ${relativeUrl}`);
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(relativeUrl) || relativeUrl.startsWith("//") || relativeUrl.startsWith("/")) {
    fail(`Artifact URL must be relative: ${relativeUrl}`);
  }
  let decoded;
  try {
    decoded = decodeURIComponent(relativeUrl);
  } catch {
    fail(`Artifact URL contains invalid encoding: ${relativeUrl}`);
  }
  if (decoded.includes("\\") || decoded.includes("\0")) fail(`Unsafe relative artifact URL: ${relativeUrl}`);
  const resolved = path.resolve(path.dirname(stablePath), ...decoded.split("/"));
  if (!isInside(outputDirectory, resolved)) fail(`Artifact URL escapes the output directory: ${relativeUrl}`);
  return resolved;
}

async function verifyArtifactFile(filePath, record, label) {
  validateArtifactRecord(record, label);
  if (!fs.existsSync(filePath)) fail(`${label} is missing: ${filePath}`);
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size !== record.size) fail(`${label} size mismatch.`);
  const digest = await hashFile(filePath);
  if (digest !== record.sha256) fail(`${label} SHA-256 mismatch.`);
}

function decodeTarEntryName(rawName) {
  return rawName.replace(/(?:\\[0-7]{3})+/g, (escapedBytes) => {
    const bytes = [...escapedBytes.matchAll(/\\([0-7]{3})/g)]
      .map((match) => Number.parseInt(match[1], 8));
    return new TextDecoder("windows-1251").decode(Uint8Array.from(bytes));
  });
}

function archiveEntries(archivePath) {
  const namesResult = runTar(["-tf", archivePath], `listing ${archivePath}`);
  const names = namesResult.stdout.split(/\r?\n/).filter(Boolean);
  const verboseResult = runTar(["-tvf", archivePath], `inspecting entry types in ${archivePath}`);
  for (const line of verboseResult.stdout.split(/\r?\n/).filter(Boolean)) {
    const type = line.trimStart()[0];
    if (type !== "-" && type !== "d") fail(`Archive contains a link or special entry: ${line}`);
  }
  const entries = [];
  const seen = new Set();
  for (const rawName of names) {
    const isDirectory = rawName.endsWith("/");
    const name = validateArchivePath(decodeTarEntryName(rawName), "archive entry");
    if (seen.has(name)) fail(`Archive contains a duplicate entry: ${name}`);
    seen.add(name);
    entries.push({ name, isDirectory });
  }
  return entries;
}

function readArchiveJson(archivePath, entryName) {
  const result = runTar(["-xOf", archivePath, entryName], `reading ${entryName} from ${archivePath}`, {
    maxBuffer: 64 * 1024 * 1024
  });
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    fail(`Invalid ${entryName} in ${archivePath}: ${error.message}`);
  }
}

function verifyFullArchive(archivePath, stable, config) {
  const entries = archiveEntries(archivePath);
  const files = new Set(entries.filter((entry) => !entry.isDirectory).map((entry) => entry.name));
  if (!files.has(RELEASE_METADATA_NAME)) fail(`Full archive is missing ${RELEASE_METADATA_NAME}.`);
  const receipt = validateReceipt(readArchiveJson(archivePath, RELEASE_METADATA_NAME), config.productId, "full archive receipt");
  if (receipt.version !== stable.system.full.version) fail("Full archive receipt version does not match the baseline in stable.json.");
  if (JSON.stringify(receipt.preserve) !== JSON.stringify(config.preserve)) fail("Full archive preserve policy does not match config.");
  for (const entry of entries) {
    if (entry.name === RELEASE_METADATA_NAME) continue;
    const root = entry.name.split("/")[0];
    if (!config.allowlist.includes(root)) fail(`Full archive contains a path outside the allowlist: ${entry.name}`);
    if (isExcluded(entry.name, config.exclude)) fail(`Full archive contains an excluded path: ${entry.name}`);
    if (!entry.isDirectory && !isPreserved(entry.name, config.preserve) && !receipt.files[entry.name]) {
      fail(`Full archive managed file is missing from its receipt: ${entry.name}`);
    }
  }
  for (const filePath of Object.keys(receipt.files)) {
    if (!files.has(filePath)) fail(`Receipt references a missing full archive file: ${filePath}`);
  }
  return receipt;
}

function verifyPatchArchive(archivePath, patchRecord, config) {
  const entries = archiveEntries(archivePath);
  const files = new Set(entries.filter((entry) => !entry.isDirectory).map((entry) => entry.name));
  for (const requiredName of [PATCH_METADATA_NAME, PATCH_BASE_NAME, RELEASE_METADATA_NAME]) {
    if (!files.has(requiredName)) fail(`Patch archive is missing ${requiredName}.`);
  }
  const metadata = readArchiveJson(archivePath, PATCH_METADATA_NAME);
  const baseReceipt = validateReceipt(readArchiveJson(archivePath, PATCH_BASE_NAME), config.productId, "patch base receipt");
  const targetReceipt = validateReceipt(readArchiveJson(archivePath, RELEASE_METADATA_NAME), config.productId, "patch target receipt");
  if (metadata.schemaVersion !== SCHEMA_VERSION || metadata.productId !== config.productId) fail("Patch metadata schema/product mismatch.");
  if (metadata.from !== patchRecord.from || metadata.to !== patchRecord.to) fail("Patch metadata versions do not match stable.json.");
  if (baseReceipt.version !== metadata.from || targetReceipt.version !== metadata.to) fail("Patch receipts have the wrong versions.");
  if (metadata.fromFingerprint !== baseReceipt.fingerprint || metadata.toFingerprint !== targetReceipt.fingerprint) {
    fail("Patch metadata fingerprints do not match its receipts.");
  }
  if (JSON.stringify(metadata.preserve) !== JSON.stringify(config.preserve)) fail("Patch preserve policy does not match config.");
  if (!Array.isArray(metadata.writes) || !Array.isArray(metadata.deletes)) fail("Patch writes/deletes must be arrays.");
  const expectedPayload = new Set();
  const writePaths = new Set();
  for (const write of metadata.writes) {
    const filePath = validateArchivePath(write.path, "patch write path");
    if (writePaths.has(filePath)) fail(`Duplicate patch write: ${filePath}`);
    writePaths.add(filePath);
    if (isPreserved(filePath, config.preserve)) fail(`Patch attempts to overwrite preserved file: ${filePath}`);
    const targetRecord = targetReceipt.files[filePath];
    if (!targetRecord || write.size !== targetRecord.size || write.sha256 !== targetRecord.sha256) {
      fail(`Patch write metadata does not match target receipt: ${filePath}`);
    }
    expectedPayload.add(`payload/${filePath}`);
  }
  const deletePaths = new Set();
  for (const rawPath of metadata.deletes) {
    const filePath = validateArchivePath(rawPath, "patch delete path");
    if (deletePaths.has(filePath)) fail(`Duplicate patch delete: ${filePath}`);
    deletePaths.add(filePath);
    if (isPreserved(filePath, config.preserve)) fail(`Patch attempts to delete preserved file: ${filePath}`);
    if (!baseReceipt.files[filePath] || targetReceipt.files[filePath]) fail(`Invalid patch delete: ${filePath}`);
  }
  for (const payloadPath of expectedPayload) {
    if (!files.has(payloadPath)) fail(`Patch payload is missing: ${payloadPath}`);
  }
  for (const filePath of files) {
    if (new Set([PATCH_METADATA_NAME, PATCH_BASE_NAME, RELEASE_METADATA_NAME]).has(filePath)) continue;
    if (!expectedPayload.has(filePath)) fail(`Unexpected file in patch archive: ${filePath}`);
  }
  return { metadata, baseReceipt, targetReceipt };
}

function validateStableDocument(stable, config) {
  if (!stable || typeof stable !== "object" || Array.isArray(stable)) fail("stable.json must be an object.");
  if (stable.schemaVersion !== SCHEMA_VERSION || stable.productId !== config.productId || stable.channel !== config.channel) {
    fail("stable.json schema/product/channel mismatch.");
  }
  if (!Number.isInteger(stable.sequence) || stable.sequence < 1) fail("stable.json sequence must be a positive integer.");
  if (!stable.signature || stable.signature.algorithm !== SIGNATURE_ALGORITHM || typeof stable.signature.keyId !== "string") {
    fail("stable.json signature descriptor is invalid.");
  }
  if (!stable.system || typeof stable.system !== "object") fail("stable.json system section is missing.");
  parseSemver(stable.system.version, "stable system version");
  parseSemver(stable.system.minimumLauncherVersion, "minimum launcher version");
  validateArtifactRecord(stable.system.full, "stable full artifact", true);
  if (compareSemver(stable.system.full.version, stable.system.version) > 0) fail("Stable baseline is newer than the current version.");
  if (!Array.isArray(stable.system.patches)) fail("stable system patches must be an array.");
  stable.system.patches.forEach((record, index) => validatePatchRecord(record, `stable patch ${index}`));
  validatePatchChain(stable.system.patches, stable.system.version, stable.system.full.version);
}

async function verifyRelease(options, config) {
  const stablePath = path.join(options.outputDirectory, "channels", "stable.json");
  if (!fs.existsSync(stablePath)) fail(`Stable channel is missing: ${stablePath}`);
  const stableBytes = fs.readFileSync(stablePath);
  let stable;
  try {
    stable = JSON.parse(stableBytes);
  } catch (error) {
    fail(`Invalid stable.json: ${error.message}`);
  }
  validateStableDocument(stable, config);
  const { publicKeyPem, keyId } = loadPublicKey(options.keyDirectory);
  if (stable.signature.keyId !== keyId) fail("stable.json keyId does not match the trusted public key.");
  const signaturePath = resolveArtifactPath(options.outputDirectory, stablePath, stable.signature.url);
  const signature = fs.readFileSync(signaturePath);
  if (!crypto.verify("sha256", stableBytes, publicKeyPem, signature)) fail("stable.json detached signature is invalid.");

  const foundryManifestPath = resolveArtifactPath(options.outputDirectory, stablePath, stable.system.foundryManifestUrl);
  const foundryManifest = readJson(foundryManifestPath, "published Foundry manifest");
  if (foundryManifest.id !== config.productId || foundryManifest.version !== stable.system.full.version) {
    fail("Published Foundry manifest does not match stable.json.");
  }

  const fullPath = resolveArtifactPath(options.outputDirectory, stablePath, stable.system.full.url);
  await verifyArtifactFile(fullPath, stable.system.full, "full artifact");
  const fullReceipt = verifyFullArchive(fullPath, stable, config);

  let expectedReceipt = fullReceipt;
  for (let index = 0; index < stable.system.patches.length; index += 1) {
    const patchRecord = stable.system.patches[index];
    const patchPath = resolveArtifactPath(options.outputDirectory, stablePath, patchRecord.url);
    await verifyArtifactFile(patchPath, patchRecord, `patch artifact ${patchRecord.from} -> ${patchRecord.to}`);
    const verifiedPatch = verifyPatchArchive(patchPath, patchRecord, config);
    if (verifiedPatch.baseReceipt.version !== expectedReceipt.version
        || verifiedPatch.baseReceipt.fingerprint !== expectedReceipt.fingerprint) {
      fail(`Patch ${patchRecord.from} -> ${patchRecord.to} does not continue the previous receipt.`);
    }
    expectedReceipt = verifiedPatch.targetReceipt;
  }
  if (expectedReceipt.version !== stable.system.version) {
    fail("Baseline and patch chain do not reach the current stable version.");
  }
  console.log(`Verified ${config.productId} ${stable.system.version}, sequence ${stable.sequence}.`);
  console.log(`Signature key: ${keyId}`);
  console.log(`Full artifact and ${stable.system.patches.length} patch artifact(s) are valid.`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const config = validateConfig(readEffectiveConfig(options.configPath));
  if (options.command === "keygen") {
    generateSigningKeys(options, config);
    return;
  }
  if (options.command === "snapshot") {
    await createSnapshot(options, config);
    return;
  }
  if (options.command === "patch") {
    await createPatch(options, config);
    return;
  }
  await verifyRelease(options, config);
}

try {
  await main();
} catch (error) {
  if (error instanceof ReleaseError) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
