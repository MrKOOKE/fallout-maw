import { SYSTEM_ID } from "../constants.mjs";

export const ANIMATION_LIBRARY_ROOT = `systems/${SYSTEM_ID}/Library-animation`;

const ANIMATION_DATABASE_MODULE = "../generated/animation-database.mjs";
const MEDIA_EXTENSIONS = new Set(["webm", "mp4", "m4v", "webp", "png", "jpg", "jpeg", "gif", "ogg", "mp3", "wav"]);
const VIDEO_EXTENSIONS = new Set(["webm", "mp4", "m4v"]);
const IMAGE_EXTENSIONS = new Set(["webp", "png", "jpg", "jpeg", "gif"]);
const AUDIO_EXTENSIONS = new Set(["ogg", "mp3", "wav"]);
const DISTANCE_PATTERN = /(?:^|[_\-\s])(\d{1,3})(ft|m)(?=$|[_\-\s])/i;
const DIMENSION_PATTERN = /[_\-\s]\d{2,5}x\d{2,5}$/i;
const THUMB_PATTERN = /(?:^|[_\-\s])thumb(?:$|[_\-\s])/i;
const KEY_DISTANCE_PATTERN = /\.([0-9]{1,3}(?:ft|m))$/i;

let cachedIndex = null;

export async function getAnimationLibraryIndex({ refresh = false } = {}) {
  if (cachedIndex && !refresh) return cachedIndex;
  const modulePath = refresh
    ? `${ANIMATION_DATABASE_MODULE}?refresh=${Date.now()}`
    : ANIMATION_DATABASE_MODULE;
  const module = await import(modulePath);
  cachedIndex = normalizeAnimationLibraryIndex(module.ANIMATION_DATABASE);
  return cachedIndex;
}

export async function resolveAnimationLibraryFile(key, { distance = 0, mediaType = "video" } = {}) {
  let normalizedKey = normalizeAnimationKey(key);
  if (!normalizedKey) return "";

  if (isMediaPath(normalizedKey)) return normalizedKey;

  const distanceMatch = normalizedKey.match(KEY_DISTANCE_PATTERN);
  if (distanceMatch) {
    normalizedKey = normalizedKey.slice(0, -distanceMatch[0].length);
    distance = Number(distanceMatch[1].match(/\d+/)?.[0]) || distance;
  }

  const index = await getAnimationLibraryIndex();
  const directEntry = index.entries.find(entry => entry.fileKey === normalizedKey);
  if (directEntry) return directEntry.path;

  const group = index.groups.find(entry => entry.key === normalizedKey);
  if (!group) return "";

  const typedEntries = group.entries.filter(entry => entry.mediaType === mediaType);
  const entries = typedEntries.length ? typedEntries : group.entries;
  return selectEntryByDistance(entries, distance)?.path ?? "";
}

export function normalizeAnimationKey(key) {
  return String(key ?? "").trim();
}

function normalizeAnimationLibraryIndex(index) {
  if (!index || typeof index !== "object") return createEmptyAnimationLibraryIndex();
  const entries = (Array.isArray(index.files) ? index.files : [])
    .map(relativePath => buildAnimationEntry(String(relativePath ?? ""), String(index.root || ANIMATION_LIBRARY_ROOT)))
    .filter(Boolean)
    .sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true }));
  const groups = buildAnimationGroups(entries);
  return {
    root: String(index.root || ANIMATION_LIBRARY_ROOT),
    entries,
    groups,
    updatedAt: Number(index.updatedAt) || 0
  };
}

function buildAnimationGroups(entries = []) {
  const groupMap = new Map();
  for (const entry of entries) {
    if (!groupMap.has(entry.key)) {
      groupMap.set(entry.key, {
        key: entry.key,
        label: entry.label,
        folder: entry.folder,
        entries: [],
        distances: [],
        mediaTypes: new Set()
      });
    }
    const group = groupMap.get(entry.key);
    group.entries.push(entry);
    group.mediaTypes.add(entry.mediaType);
    if (entry.distanceLabel && !group.distances.includes(entry.distanceLabel)) group.distances.push(entry.distanceLabel);
  }

  return Array.from(groupMap.values()).map(group => ({
    ...group,
    mediaTypes: Array.from(group.mediaTypes).sort(),
    distances: group.distances.sort(compareDistanceLabels),
    representativePath: selectRepresentativeEntry(group.entries)?.path ?? ""
  }));
}

function buildAnimationEntry(relativePath, root = ANIMATION_LIBRARY_ROOT) {
  const normalizedRelativePath = String(relativePath ?? "").replace(/\\/g, "/").replace(/^[/\\]+/, "");
  const path = `${root}/${normalizedRelativePath}`;
  const extension = getExtension(path);
  if (!MEDIA_EXTENSIONS.has(extension)) return null;

  const segments = normalizedRelativePath.split("/");
  const filename = segments.pop() ?? "";
  const stem = filename.replace(/\.[^.]+$/, "");
  const mediaType = getMediaType(extension);
  const distanceMatch = stem.match(DISTANCE_PATTERN);
  const distanceValue = distanceMatch ? Number(distanceMatch[1]) || 0 : 0;
  const distanceUnit = distanceMatch ? String(distanceMatch[2]).toLowerCase() : "";
  const cleanedStem = cleanAnimationStem(stem);
  const key = [
    SYSTEM_ID,
    ...segments.map(normalizeKeySegment),
    normalizeKeySegment(cleanedStem)
  ].filter(Boolean).join(".");
  const fileKey = [
    key,
    normalizeKeySegment(stem)
  ].filter(Boolean).join(".");

  return {
    key,
    fileKey,
    path,
    relativePath: normalizedRelativePath,
    folder: segments.join("/"),
    label: cleanedStem || stem,
    filename,
    extension,
    mediaType,
    isThumb: THUMB_PATTERN.test(stem),
    distanceValue,
    distanceUnit,
    distanceLabel: distanceMatch ? `${String(distanceValue).padStart(2, "0")}${distanceUnit}` : ""
  };
}

function cleanAnimationStem(stem) {
  return String(stem ?? "")
    .replace(THUMB_PATTERN, "_")
    .replace(DISTANCE_PATTERN, "_")
    .replace(DIMENSION_PATTERN, "")
    .replace(/[_\-\s]+$/g, "")
    .replace(/^[_\-\s]+/g, "");
}

function createEmptyAnimationLibraryIndex() {
  return {
    root: ANIMATION_LIBRARY_ROOT,
    entries: [],
    groups: [],
    updatedAt: 0
  };
}

function selectEntryByDistance(entries = [], distance = 0) {
  const visibleEntries = entries.filter(entry => !entry.isThumb);
  const candidates = visibleEntries.length ? visibleEntries : entries;
  if (!candidates.length) return null;

  const ranged = candidates
    .map(entry => ({ entry, threshold: getSequencerDistanceThreshold(entry) }))
    .filter(range => Number.isFinite(range.threshold))
    .sort((left, right) => left.threshold - right.threshold || left.entry.path.localeCompare(right.entry.path));
  if (!ranged.length) return candidates[0];

  const targetDistance = Math.max(0, Number(distance) || 0);
  let selectedThreshold = ranged.at(-1).threshold;
  for (let index = 0; index < ranged.length; index += 1) {
    const current = ranged[index];
    const next = ranged[index + 1];
    if (targetDistance >= current.threshold && (!next || targetDistance < next.threshold)) {
      selectedThreshold = current.threshold;
      break;
    }
  }

  const sameDistance = ranged.filter(range => range.threshold === selectedThreshold).map(range => range.entry);
  return sameDistance[Math.floor(Math.random() * sameDistance.length)];
}

function selectRepresentativeEntry(entries = []) {
  const visibleEntries = entries.filter(entry => !entry.isThumb);
  const videos = visibleEntries.filter(entry => entry.mediaType === "video");
  return selectEntryByDistance(videos.length ? videos : visibleEntries, getGridSize() * 5);
}

function getSequencerDistanceThreshold(entry) {
  if (entry.distanceUnit === "ft") {
    const gridSize = getGridSize();
    if (entry.distanceValue === 5) return 0;
    if (entry.distanceValue === 15) return gridSize * 2;
    if (entry.distanceValue === 30) return gridSize * 5;
    if (entry.distanceValue === 60) return gridSize * 9;
    if (entry.distanceValue === 90) return gridSize * 15;
  }
  if (entry.distanceUnit === "m") {
    const gridDistance = Math.max(0.0001, Number(canvas.scene?.grid?.distance ?? canvas.grid?.distance) || 1);
    return entry.distanceValue * (getGridSize() / gridDistance);
  }
  return Number.NaN;
}

function getGridSize() {
  return Math.max(1, Number(canvas.grid?.size) || 100);
}

function compareDistanceLabels(left, right) {
  return parseDistanceLabel(left) - parseDistanceLabel(right) || String(left).localeCompare(String(right));
}

function parseDistanceLabel(label) {
  return Number(String(label ?? "").match(/\d+/)?.[0]) || 0;
}

function getMediaType(extension) {
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  return "file";
}

function getExtension(path) {
  return String(path ?? "").split(".").pop()?.toLowerCase() ?? "";
}

function isMediaPath(path) {
  return MEDIA_EXTENSIONS.has(getExtension(path));
}

function normalizeKeySegment(segment) {
  return String(segment ?? "")
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}
