import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PRIVATE_KEY_NAME = "private-key.pem";
const SIGNATURE_ALGORITHM = "ECDSA_P256_SHA256";
const DRIVE_FILE_ID_PATTERN = /^[A-Za-z0-9_-]{10,200}$/;
const WINDOWS_RESERVED_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

class RenderError extends Error {}

function fail(message) {
  throw new RenderError(message);
}

function usage() {
  return `Usage:
  node release/render-google-drive.mjs --output PATH --id-map FILE --key-dir PATH [--stage PATH]

The map must be a JSON object whose keys are paths relative to the built release output
and whose values are Google Drive file IDs. The source release is never modified.

Default staging path: a sibling named <output-directory>-google-drive.`;
}

function parseArguments(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    process.exit(0);
  }

  const values = new Map([
    ["--output", "outputDirectory"],
    ["--key-dir", "keyDirectory"],
    ["--id-map", "mapPath"],
    ["--stage", "stagingDirectory"]
  ]);
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const property = values.get(flag);
    if (!property) fail(`Unknown argument: ${flag}\n\n${usage()}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${flag} requires a path.`);
    if (options[property]) fail(`${flag} may only be specified once.`);
    options[property] = path.resolve(value);
    index += 1;
  }

  for (const [flag, property] of [["--output", "outputDirectory"], ["--id-map", "mapPath"], ["--key-dir", "keyDirectory"]]) {
    if (!options[property]) fail(`${flag} is required.\n\n${usage()}`);
  }
  if (!options.stagingDirectory) {
    options.stagingDirectory = path.join(
      path.dirname(options.outputDirectory),
      `${path.basename(options.outputDirectory)}-google-drive`
    );
  }
  return options;
}

function readJson(filePath, label) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    fail(`Cannot read ${label} at ${filePath}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`Invalid ${label} at ${filePath}: ${error.message}`);
  }
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isInside(parentPath, candidatePath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function ensureRealDirectory(directoryPath, label) {
  let stat;
  try {
    stat = fs.lstatSync(directoryPath);
  } catch (error) {
    fail(`Cannot inspect ${label} at ${directoryPath}: ${error.message}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`${label} must be a real directory: ${directoryPath}`);
}

function validatePathSegment(segment, label) {
  if (!segment || segment === "." || segment === "..") fail(`Unsafe ${label}: ${segment || "<empty>"}`);
  if (/[\u0000-\u001f\u007f<>:"|?*]/.test(segment) || /[. ]$/.test(segment)) fail(`Unsafe ${label}: ${segment}`);
  if (WINDOWS_RESERVED_NAME_PATTERN.test(segment)) fail(`Reserved Windows name in ${label}: ${segment}`);
}

function validateMapPath(value) {
  if (typeof value !== "string" || !value || value !== value.trim()) fail("Drive map paths must be non-empty trimmed strings.");
  if (value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.includes("//")) {
    fail(`Drive map path must be a normalized relative POSIX path: ${value}`);
  }
  const segments = value.split("/");
  for (const segment of segments) validatePathSegment(segment, "Drive map path");
  return segments.join("/");
}

function normalizeOutputPath(outputDirectory, filePath, label) {
  const absolutePath = path.resolve(filePath);
  if (!isInside(outputDirectory, absolutePath) || absolutePath === path.resolve(outputDirectory)) {
    fail(`${label} resolves outside the built output directory.`);
  }
  const relative = path.relative(outputDirectory, absolutePath).split(path.sep).join("/");
  return validateMapPath(relative);
}

function resolveRelativeArtifactUrl(outputDirectory, baseFilePath, value, label) {
  if (typeof value !== "string" || !value || value !== value.trim()) fail(`${label} must be a non-empty relative URL.`);
  if (
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("%") ||
    value.startsWith("/") ||
    value.startsWith("//") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
  ) {
    fail(`${label} must be an unescaped relative artifact URL: ${value}`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === ".")) fail(`Unsafe ${label}: ${value}`);
  for (const segment of segments) {
    if (segment !== "..") validatePathSegment(segment, label);
  }
  const resolved = path.resolve(path.dirname(baseFilePath), ...segments);
  return normalizeOutputPath(outputDirectory, resolved, label);
}

function loadDriveMap(mapPath, outputDirectory) {
  const raw = readJson(mapPath, "Google Drive file map");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("Google Drive file map must be a JSON object.");
  const entries = Object.entries(raw);
  if (entries.length === 0) fail("Google Drive file map must not be empty.");

  const result = new Map();
  const caseFoldedPaths = new Set();
  const usedIds = new Set();
  for (const [rawPath, rawId] of entries) {
    const relativePath = validateMapPath(rawPath);
    const foldedPath = relativePath.toLocaleLowerCase("en-US");
    if (caseFoldedPaths.has(foldedPath)) fail(`Case-colliding path in Google Drive file map: ${relativePath}`);
    caseFoldedPaths.add(foldedPath);
    if (typeof rawId !== "string" || !DRIVE_FILE_ID_PATTERN.test(rawId)) {
      fail(`Invalid Google Drive file ID for ${relativePath}.`);
    }
    if (usedIds.has(rawId)) fail(`Google Drive file ID is assigned to more than one output path: ${rawId}`);
    usedIds.add(rawId);

    const absolutePath = path.join(outputDirectory, ...relativePath.split("/"));
    let stat;
    try {
      stat = fs.lstatSync(absolutePath);
    } catch (error) {
      fail(`Mapped output file does not exist: ${relativePath} (${error.message})`);
    }
    if (stat.isSymbolicLink() || !stat.isFile()) fail(`Mapped output path must be a real file: ${relativePath}`);
    result.set(relativePath, rawId);
  }
  return result;
}

function driveUrl(fileId) {
  return `https://drive.google.com/uc?export=download&confirm=t&id=${fileId}`;
}

function requireDriveUrl(driveMap, relativePath, label) {
  const fileId = driveMap.get(relativePath);
  if (!fileId) fail(`Google Drive file map is missing ${label}: ${relativePath}`);
  return driveUrl(fileId);
}

function loadPrivateKey(keyDirectory, expectedKeyId) {
  const privateKeyPath = path.join(keyDirectory, PRIVATE_KEY_NAME);
  let privateKeyPem;
  try {
    privateKeyPem = fs.readFileSync(privateKeyPath, "utf8");
  } catch (error) {
    fail(`Cannot read private signing key at ${privateKeyPath}: ${error.message}`);
  }

  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(privateKeyPem);
  } catch (error) {
    fail(`Cannot parse ${PRIVATE_KEY_NAME}: ${error.message}`);
  }
  if (privateKey.asymmetricKeyType !== "ec") fail(`${PRIVATE_KEY_NAME} must be an EC private key.`);
  const namedCurve = privateKey.asymmetricKeyDetails?.namedCurve;
  if (namedCurve && !new Set(["prime256v1", "P-256"]).has(namedCurve)) {
    fail(`${PRIVATE_KEY_NAME} must use the P-256 curve.`);
  }
  const publicDer = crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const keyId = `p256-${crypto.createHash("sha256").update(publicDer).digest("hex").slice(0, 24)}`;
  if (expectedKeyId !== keyId) fail("stable.json keyId does not match the supplied private signing key.");
  return { privateKey, keyId };
}

function assertStableShape(stable) {
  if (!stable || typeof stable !== "object" || Array.isArray(stable)) fail("stable.json must be an object.");
  if (!stable.signature || typeof stable.signature !== "object" || Array.isArray(stable.signature)) {
    fail("stable.json signature descriptor is missing.");
  }
  if (stable.signature.algorithm !== SIGNATURE_ALGORITHM || typeof stable.signature.keyId !== "string") {
    fail("stable.json signature descriptor is invalid.");
  }
  if (!stable.system || typeof stable.system !== "object" || Array.isArray(stable.system)) {
    fail("stable.json system section is missing.");
  }
  if (!stable.system.full || typeof stable.system.full !== "object" || Array.isArray(stable.system.full)) {
    fail("stable.json full artifact is missing.");
  }
  if (typeof stable.system.full.version !== "string" || !stable.system.full.version) {
    fail("stable.json baseline version is missing.");
  }
  if (!Array.isArray(stable.system.patches)) fail("stable.json patches must be an array.");
  for (const [index, patchRecord] of stable.system.patches.entries()) {
    if (!patchRecord || typeof patchRecord !== "object" || Array.isArray(patchRecord)) {
      fail(`stable.json patch ${index} is invalid.`);
    }
  }
}

function writeStagingDirectory(stagingDirectory, stableBytes, signatureBytes, foundryBytes) {
  if (fs.existsSync(stagingDirectory)) fail(`Staging directory already exists; choose a new empty path: ${stagingDirectory}`);
  fs.mkdirSync(path.dirname(stagingDirectory), { recursive: true });
  const temporaryDirectory = path.join(
    path.dirname(stagingDirectory),
    `.${path.basename(stagingDirectory)}.${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`
  );
  try {
    fs.mkdirSync(path.join(temporaryDirectory, "channels"), { recursive: true });
    fs.mkdirSync(path.join(temporaryDirectory, "foundry"), { recursive: true });
    fs.writeFileSync(path.join(temporaryDirectory, "channels", "stable.json"), stableBytes, { flag: "wx" });
    fs.writeFileSync(path.join(temporaryDirectory, "channels", "stable.json.sig"), signatureBytes, { flag: "wx" });
    fs.writeFileSync(path.join(temporaryDirectory, "foundry", "system.json"), foundryBytes, { flag: "wx" });
    fs.renameSync(temporaryDirectory, stagingDirectory);
  } finally {
    if (fs.existsSync(temporaryDirectory)) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function render(options) {
  ensureRealDirectory(options.outputDirectory, "built release output");
  ensureRealDirectory(options.keyDirectory, "private signing key directory");
  if (
    isInside(options.outputDirectory, options.stagingDirectory) ||
    isInside(options.stagingDirectory, options.outputDirectory)
  ) {
    fail("Staging and built output directories must not overlap.");
  }
  if (
    isInside(options.keyDirectory, options.stagingDirectory) ||
    isInside(options.stagingDirectory, options.keyDirectory)
  ) {
    fail("Staging and private signing key directories must not overlap.");
  }

  const stablePath = path.join(options.outputDirectory, "channels", "stable.json");
  const stable = readJson(stablePath, "stable channel");
  assertStableShape(stable);

  const signatureRelativePath = resolveRelativeArtifactUrl(
    options.outputDirectory,
    stablePath,
    stable.signature.url,
    "stable.json signature URL"
  );
  const foundryRelativePath = resolveRelativeArtifactUrl(
    options.outputDirectory,
    stablePath,
    stable.system.foundryManifestUrl,
    "Foundry manifest URL"
  );
  const fullRelativePath = resolveRelativeArtifactUrl(
    options.outputDirectory,
    stablePath,
    stable.system.full.url,
    "full artifact URL"
  );
  const patchRelativePaths = stable.system.patches.map((record, index) => resolveRelativeArtifactUrl(
    options.outputDirectory,
    stablePath,
    record.url,
    `patch ${index} URL`
  ));

  const foundryPath = path.join(options.outputDirectory, ...foundryRelativePath.split("/"));
  const foundryManifest = readJson(foundryPath, "Foundry manifest");
  if (!foundryManifest || typeof foundryManifest !== "object" || Array.isArray(foundryManifest)) {
    fail("Foundry manifest must be an object.");
  }
  if (foundryManifest.version !== stable.system.full.version) {
    fail("Foundry manifest must describe the immutable baseline version.");
  }

  const driveMap = loadDriveMap(options.mapPath, options.outputDirectory);
  stable.signature.url = requireDriveUrl(driveMap, signatureRelativePath, "stable signature");
  stable.system.foundryManifestUrl = requireDriveUrl(driveMap, foundryRelativePath, "Foundry manifest");
  stable.system.full.url = requireDriveUrl(driveMap, fullRelativePath, "full artifact");
  for (let index = 0; index < stable.system.patches.length; index += 1) {
    stable.system.patches[index].url = requireDriveUrl(driveMap, patchRelativePaths[index], `patch ${index}`);
  }

  foundryManifest.manifest = requireDriveUrl(driveMap, foundryRelativePath, "Foundry manifest");
  foundryManifest.download = requireDriveUrl(driveMap, fullRelativePath, "full artifact");

  const { privateKey, keyId } = loadPrivateKey(options.keyDirectory, stable.signature.keyId);
  const stableBytes = jsonBytes(stable);
  const signatureBytes = crypto.sign("sha256", stableBytes, privateKey);
  const publicKey = crypto.createPublicKey(privateKey);
  if (!crypto.verify("sha256", stableBytes, publicKey, signatureBytes)) fail("Internal signature verification failed.");

  writeStagingDirectory(options.stagingDirectory, stableBytes, signatureBytes, jsonBytes(foundryManifest));
  console.log(`Staged Google Drive metadata for ${stable.productId ?? "release"} ${stable.system.version ?? ""}.`.trim());
  console.log(`Signature key: ${keyId}`);
  console.log(`Staging directory: ${options.stagingDirectory}`);
}

try {
  render(parseArguments(process.argv.slice(2)));
} catch (error) {
  if (error instanceof RenderError) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
