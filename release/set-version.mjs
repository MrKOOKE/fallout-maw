import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseVersion(value) {
  const match = semverPattern.exec(value ?? "");
  if (!match) fail(`Invalid SemVer: ${value ?? ""}`);
  return {
    text: value,
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ?? null
  };
}

function compareIdentifiers(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left.localeCompare(right, "en");
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left.numbers[index] !== right.numbers[index]) return left.numbers[index] - right.numbers[index];
  }
  if (left.prerelease === null || right.prerelease === null) {
    if (left.prerelease === right.prerelease) return 0;
    return left.prerelease === null ? 1 : -1;
  }
  const leftParts = left.prerelease.split(".");
  const rightParts = right.prerelease.split(".");
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    if (index >= leftParts.length) return -1;
    if (index >= rightParts.length) return 1;
    const comparison = compareIdentifiers(leftParts[index], rightParts[index]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

const argumentsList = process.argv.slice(2);
const nextVersionText = argumentsList[0];
if (!nextVersionText || nextVersionText === "--help") {
  console.log("Usage: node release/set-version.mjs <new-semver> [--root PATH]");
  process.exit(nextVersionText === "--help" ? 0 : 1);
}
let root = path.resolve(scriptDirectory, "..");
for (let index = 1; index < argumentsList.length; index += 1) {
  if (argumentsList[index] !== "--root" || !argumentsList[index + 1]) fail(`Unknown argument: ${argumentsList[index]}`);
  root = path.resolve(argumentsList[index + 1]);
  index += 1;
}

const packagePath = path.join(root, "package.json");
const systemPath = path.join(root, "system.json");
const packageBytes = fs.readFileSync(packagePath);
const systemBytes = fs.readFileSync(systemPath);
const packageManifest = JSON.parse(packageBytes.toString("utf8"));
const systemManifest = JSON.parse(systemBytes.toString("utf8"));
if (packageManifest.version !== systemManifest.version) {
  fail(`Current versions differ: package.json=${packageManifest.version}, system.json=${systemManifest.version}`);
}

const currentVersion = parseVersion(packageManifest.version);
const nextVersion = parseVersion(nextVersionText);
if (compareVersions(nextVersion, currentVersion) <= 0) {
  fail(`New version must advance ${currentVersion.text}; received ${nextVersion.text}.`);
}

packageManifest.version = nextVersion.text;
systemManifest.version = nextVersion.text;
const packageOutput = Buffer.from(`${JSON.stringify(packageManifest, null, 2)}\n`, "utf8");
const systemOutput = Buffer.from(`${JSON.stringify(systemManifest, null, 2)}\n`, "utf8");
const packageTemporary = `${packagePath}.version-${process.pid}.tmp`;
const systemTemporary = `${systemPath}.version-${process.pid}.tmp`;
try {
  fs.writeFileSync(packageTemporary, packageOutput, { flag: "wx" });
  fs.writeFileSync(systemTemporary, systemOutput, { flag: "wx" });
  fs.renameSync(packageTemporary, packagePath);
  try {
    fs.renameSync(systemTemporary, systemPath);
  } catch (error) {
    fs.writeFileSync(packagePath, packageBytes);
    throw error;
  }
} finally {
  if (fs.existsSync(packageTemporary)) fs.rmSync(packageTemporary, { force: true });
  if (fs.existsSync(systemTemporary)) fs.rmSync(systemTemporary, { force: true });
}

console.log(`Fallout-MaW version advanced: ${currentVersion.text} -> ${nextVersion.text}`);
