import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_ID = "fallout-maw";
const DEFAULT_JB2A_SEQUENCER = path.resolve(__dirname, "..", "..", "..", "jb2a_patreon", "scripts", "jb2a_sequencer.js");
const LIBRARY_MARKER = "/Library/";
const DISTANCE_SUFFIX_PATTERN = /\.(\d{1,3}(?:ft|m))$/i;
const DISTANCE_STEM_PATTERN = /(?:^|[_\-\s])(\d{1,3})(ft|m)(?=$|[_\-\s.])/i;
const DIMENSION_PATTERN = /[_\-\s]\d{2,5}x\d{2,5}$/i;
const THUMB_PATTERN = /(?:^|[_\-\s])thumb(?:$|[_\-\s])/i;

const PREFERRED_LEAF_KEYS = ["blue", "01", "primary"];

let cachedDatabase = null;
let cachedFlatPaths = null;

export async function loadJb2aDatabase(sequencerPath = DEFAULT_JB2A_SEQUENCER) {
  if (cachedDatabase) return cachedDatabase;
  const module = await import(pathToFileUrl(sequencerPath));
  await module.jb2aPatreonDatabase("");
  cachedDatabase = module.patreonDatabase;
  return cachedDatabase;
}

export function resolveJb2aFilePath(rawKey, database) {
  let key = String(rawKey ?? "").trim().toLowerCase();
  if (!key || key === "путь") return "";

  if (key.startsWith("jb2a.")) key = key.slice(5);
  key = key.replace(/\./g, "/");

  let distanceSuffix = "";
  const distanceMatch = key.match(DISTANCE_SUFFIX_PATTERN);
  if (distanceMatch) {
    distanceSuffix = distanceMatch[0];
    key = key.slice(0, -distanceSuffix.length);
  }

  const parts = key.split("/").filter(Boolean);
  if (!parts.length) return "";

  const filePath = walkJb2aTree(database, parts);
  if (!filePath) return "";

  if (distanceSuffix) {
    const distanceLabel = distanceMatch[1].toLowerCase();
    const withDistance = substituteDistanceVariant(filePath, distanceLabel);
    return withDistance ?? filePath;
  }
  return filePath;
}

export function libraryRelativePathToMawKey(relativePath) {
  const normalized = String(relativePath ?? "").replace(/\\/g, "/").replace(/^[/\\]+/, "");
  if (!normalized) return "";

  const segments = normalized.split("/");
  const filename = segments.pop() ?? "";
  const stem = filename.replace(/\.[^.]+$/, "");
  const cleanedStem = cleanAnimationStem(stem);

  return [
    SYSTEM_ID,
    ...segments.map(normalizeKeySegment),
    normalizeKeySegment(cleanedStem)
  ].filter(Boolean).join(".");
}

export function jb2aKeyToMawKey(rawKey, database) {
  const filePath = resolveJb2aFilePath(rawKey, database);
  if (!filePath) return "";

  const libraryRelative = extractLibraryRelativePath(filePath);
  if (!libraryRelative) return "";

  let mawKey = libraryRelativePathToMawKey(libraryRelative);

  const distanceMatch = String(rawKey ?? "").trim().toLowerCase().match(DISTANCE_SUFFIX_PATTERN);
  if (distanceMatch && mawKey) {
    mawKey += `.${distanceMatch[1].toLowerCase()}`;
  }
  return mawKey;
}

export async function buildJb2aAnimationMap({ sequencerPath = DEFAULT_JB2A_SEQUENCER, jb2aKeys = [] } = {}) {
  const database = await loadJb2aDatabase(sequencerPath);
  const map = {};

  const keys = jb2aKeys.length ? jb2aKeys : flattenJb2aKeys(database);
  for (const jb2aKey of keys) {
    const normalized = String(jb2aKey ?? "").trim().toLowerCase();
    if (!normalized.startsWith("jb2a.")) continue;
    const mawKey = jb2aKeyToMawKey(normalized, database);
    if (mawKey) map[normalized] = mawKey;
  }

  return map;
}

export function flattenJb2aKeys(database, prefixParts = [], result = new Set()) {
  if (typeof database === "string") {
    if (prefixParts.length) result.add(`jb2a.${prefixParts.join(".")}`);
    return result;
  }
  if (Array.isArray(database)) {
    if (prefixParts.length && database.some(entry => typeof entry === "string")) {
      result.add(`jb2a.${prefixParts.join(".")}`);
    }
    return result;
  }
  if (!database || typeof database !== "object") return result;

  for (const [key, value] of Object.entries(database)) {
    if (key.startsWith("_")) continue;
    flattenJb2aKeys(value, [...prefixParts, key], result);
  }
  return result;
}

function walkJb2aTree(node, parts) {
  if (!parts.length) return resolveLeaf(node);

  const [head, ...tail] = parts;
  if (!node || typeof node !== "object") return null;

  const next = node[head] ?? node[head.replace(/-/g, "_")];
  if (next === undefined) return resolveLeaf(node);
  return walkJb2aTree(next, tail);
}

function resolveLeaf(node) {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) {
    const file = node.find(entry => typeof entry === "string");
    return file ?? "";
  }
  if (!node || typeof node !== "object") return "";

  const childKeys = Object.keys(node).filter(key => !key.startsWith("_"));
  if (!childKeys.length) return "";

  for (const preferred of PREFERRED_LEAF_KEYS) {
    if (childKeys.includes(preferred)) {
      const resolved = resolveLeaf(node[preferred]);
      if (resolved) return resolved;
    }
  }

  for (const key of childKeys.sort()) {
    const resolved = resolveLeaf(node[key]);
    if (resolved) return resolved;
  }
  return "";
}

function extractLibraryRelativePath(filePath) {
  const normalized = String(filePath ?? "").replace(/\\/g, "/");
  const markerIndex = normalized.indexOf(LIBRARY_MARKER);
  if (markerIndex === -1) return "";
  return normalized.slice(markerIndex + LIBRARY_MARKER.length);
}

function substituteDistanceVariant(filePath, distanceLabel) {
  const normalized = String(filePath ?? "").replace(/\\/g, "/");
  const filename = normalized.split("/").pop() ?? "";
  if (!filename || !DISTANCE_STEM_PATTERN.test(filename.replace(/\.[^.]+$/, ""))) return null;

  const nextFilename = filename.replace(DISTANCE_STEM_PATTERN, (match, value, unit) => {
    const numeric = String(distanceLabel.match(/\d+/)?.[0] ?? value).padStart(2, "0");
    const nextUnit = String(distanceLabel.match(/[a-z]+/i)?.[0] ?? unit).toLowerCase();
    return match.replace(`${value}${unit}`, `${numeric}${nextUnit}`);
  });

  return normalized.slice(0, -filename.length) + nextFilename;
}

function cleanAnimationStem(stem) {
  return String(stem ?? "")
    .replace(THUMB_PATTERN, "_")
    .replace(DISTANCE_STEM_PATTERN, "_")
    .replace(DIMENSION_PATTERN, "")
    .replace(/[_\-\s]+$/g, "")
    .replace(/^[_\-\s]+/g, "");
}

function normalizeKeySegment(segment) {
  return String(segment ?? "")
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function pathToFileUrl(absolutePath) {
  const resolved = path.resolve(absolutePath);
  return `file:///${resolved.replace(/\\/g, "/")}`;
}
