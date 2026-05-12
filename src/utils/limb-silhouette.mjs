import { toInteger } from "./numbers.mjs";

export const SILHOUETTE_UNASSIGNED_FILL = "rgba(240, 215, 135, 0.16)";
export const SILHOUETTE_AREA_TOLERANCE = 0.005;

const CLIPPER_SCALE = 1000;
const MIN_PATH_POINTS = 3;
const MIN_BOOLEAN_PATH_AREA = 1.5;
const BOOLEAN_CLEAN_DISTANCE = 0.25;
const MAX_SVG_DECIMALS = 2;
const DEFAULT_SMOOTHING_ITERATIONS = 3;
const DEFAULT_SIMPLIFY_TOLERANCE = 1.15;
const DEFAULT_FINAL_SIMPLIFY_TOLERANCE = 0.35;
const DEFAULT_MAX_SEGMENT_LENGTH = 4;

export function normalizeLimbSilhouette(silhouette, limbs = []) {
  if (!silhouette || typeof silhouette !== "object") return null;
  const width = Math.max(1, toInteger(silhouette.width));
  const height = Math.max(1, toInteger(silhouette.height));
  const outline = normalizePaths(silhouette.outline);
  if (!width || !height || !outline.length) return null;
  const image = String(silhouette.image ?? silhouette.img ?? "").trim();

  const limbKeys = new Set((limbs ?? []).map(limb => limb.key));
  const parts = Array.isArray(silhouette.parts)
    ? silhouette.parts
      .map(part => ({
        limbKey: String(part?.limbKey ?? "").trim(),
        paths: normalizePaths(part?.paths)
      }))
      .filter(part => part.limbKey && limbKeys.has(part.limbKey) && part.paths.length)
    : [];

  return { width, height, image, outline, parts };
}

export function normalizePaths(paths) {
  if (!Array.isArray(paths)) return [];
  return paths
    .map(path => normalizePath(path))
    .filter(path => path.length >= MIN_PATH_POINTS);
}

export function normalizePath(path) {
  if (!Array.isArray(path)) return [];
  const points = path
    .map(point => ({
      x: Number(point?.x),
      y: Number(point?.y)
    }))
    .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
  return removeDuplicateClosingPoint(removeConsecutiveDuplicatePoints(points));
}

export function buildSvgPathData(path) {
  const normalized = normalizePath(path);
  if (normalized.length < MIN_PATH_POINTS) return "";
  const [first, ...rest] = normalized;
  return [
    `M ${formatSvgNumber(first.x)} ${formatSvgNumber(first.y)}`,
    ...rest.map(point => `L ${formatSvgNumber(point.x)} ${formatSvgNumber(point.y)}`),
    "Z"
  ].join(" ");
}

export function buildSvgPoints(points) {
  return normalizePath(points)
    .map(point => `${formatSvgNumber(point.x)},${formatSvgNumber(point.y)}`)
    .join(" ");
}

export function pathsToSvgData(paths) {
  return normalizePaths(paths).map(path => ({
    d: buildSvgPathData(path)
  })).filter(path => path.d);
}

export function pathsToCompoundSvgData(paths) {
  const d = pathsToSvgData(paths).map(path => path.d).join(" ");
  return d ? { d } : null;
}

export function smoothSilhouettePaths(paths, {
  iterations = DEFAULT_SMOOTHING_ITERATIONS,
  simplifyTolerance = DEFAULT_SIMPLIFY_TOLERANCE,
  finalSimplifyTolerance = DEFAULT_FINAL_SIMPLIFY_TOLERANCE,
  maxSegmentLength = DEFAULT_MAX_SEGMENT_LENGTH
} = {}) {
  return normalizePaths(paths)
    .map(path => simplifyPathByDistance(path, simplifyTolerance))
    .map(path => smoothClosedPath(path, iterations))
    .map(path => simplifyPathByDistance(path, finalSimplifyTolerance))
    .map(path => densifyClosedPath(path, maxSegmentLength))
    .filter(path => path.length >= MIN_PATH_POINTS);
}

export function createLimbSilhouetteHud(silhouette, limbs = {}) {
  const normalized = normalizeLimbSilhouette(silhouette, Object.entries(limbs ?? {}).map(([key, limb]) => ({
    key,
    label: limb?.label ?? key
  })));
  if (!normalized) return null;

  const parts = normalized.parts.flatMap(part => {
    const limb = limbs?.[part.limbKey];
    if (!limb) return [];
    const color = String(limb?.fill ?? "") || getLimbStateColor(limb);
    const label = String(limb.label ?? part.limbKey);
    const displayValue = limb?.displayValue ?? toInteger(limb.value);
    const displayMax = limb?.displayMax ?? toInteger(limb.max);
    const popoverRows = Array.isArray(limb?.popoverRows) ? limb.popoverRows : [];
    const title = displayMax === "" || displayMax === null || displayMax === undefined
      ? `${label}: ${displayValue}`
      : `${label}: ${displayValue} / ${displayMax}`;
    const path = pathsToCompoundSvgData(part.paths);
    if (!path) return [];
    return [{
      d: path.d,
      limbKey: part.limbKey,
      label,
      title,
      value: displayValue,
      max: displayMax,
      fill: color,
      popoverRowsJson: JSON.stringify(popoverRows)
    }];
  });

  const contentBounds = getPathsBounds(normalized.parts.flatMap(part => part.paths ?? [])) ?? getPathsBounds(normalized.outline);
  const viewBox = contentBounds
    ? buildPaddedViewBox(contentBounds, normalized.width, normalized.height)
    : `0 0 ${normalized.width} ${normalized.height}`;

  return {
    width: normalized.width,
    height: normalized.height,
    viewBox,
    outline: pathsToSvgData(normalized.outline),
    parts,
    visible: parts.length > 0
  };
}

export function getPathsBounds(paths = []) {
  const points = normalizePaths(paths).flat();
  if (!points.length) return null;
  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys)
  };
}

export function getLimbStateColor(limb) {
  const max = Math.max(1, toInteger(limb?.scaleMax ?? limb?.max));
  const value = Math.max(-max, Math.min(max, toInteger(limb?.value)));
  const ratio = value / max;
  if (ratio >= 0.5) return mixRgb([218, 199, 91], [61, 154, 70], (ratio - 0.5) / 0.5);
  if (ratio >= 0) return mixRgb([185, 48, 43], [218, 199, 91], ratio / 0.5);
  return mixRgb([185, 48, 43], [0, 0, 0], Math.abs(ratio));
}

export function getClipperLib() {
  const clipper = globalThis.ClipperLib;
  if (!clipper?.Clipper) throw new Error("Foundry ClipperLib is not available.");
  return clipper;
}

export function clipperUnion(paths = []) {
  const source = normalizePaths(paths);
  if (!source.length) return [];
  const ClipperLib = getClipperLib();
  const solution = new ClipperLib.Paths();
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(toClipperPaths(source), ClipperLib.PolyType.ptSubject, true);
  clipper.Execute(
    ClipperLib.ClipType.ctUnion,
    solution,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero
  );
  return fromClipperPaths(solution);
}

export function clipperIntersect(subject = [], clip = []) {
  return executeClipper(subject, clip, "ctIntersection");
}

export function clipperDifference(subject = [], clip = []) {
  return executeClipper(subject, clip, "ctDifference");
}

export function createRoundStrokePaths(points = [], radius = 1) {
  const centerline = simplifyPathByDistance(normalizePath(points), 0.6);
  if (centerline.length < 2) return [];
  const ClipperLib = getClipperLib();
  if (!ClipperLib.ClipperOffset || !("jtRound" in (ClipperLib.JoinType ?? {})) || !("etOpenRound" in (ClipperLib.EndType ?? {}))) return [];
  const solution = new ClipperLib.Paths();
  const offset = new ClipperLib.ClipperOffset(
    2,
    Math.max(0.05, Math.min(Number(radius) * 0.12, 0.8)) * CLIPPER_SCALE
  );
  offset.AddPath(
    toClipperPath(centerline),
    ClipperLib.JoinType.jtRound,
    ClipperLib.EndType.etOpenRound
  );
  offset.Execute(solution, Math.max(0.5, Number(radius) || 1) * CLIPPER_SCALE);
  return fromClipperPaths(solution);
}

export function getPathsArea(paths = []) {
  const ClipperLib = getClipperLib();
  return normalizePaths(paths).reduce((total, path) => {
    const clipperPath = toClipperPath(path);
    return total + Math.abs(ClipperLib.Clipper.Area(clipperPath) / (CLIPPER_SCALE * CLIPPER_SCALE));
  }, 0);
}

function executeClipper(subject = [], clip = [], operation) {
  const normalizedSubject = normalizePaths(subject);
  const normalizedClip = normalizePaths(clip);
  if (!normalizedSubject.length || !normalizedClip.length) return [];
  const ClipperLib = getClipperLib();
  const solution = new ClipperLib.Paths();
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(toClipperPaths(normalizedSubject), ClipperLib.PolyType.ptSubject, true);
  clipper.AddPaths(toClipperPaths(normalizedClip), ClipperLib.PolyType.ptClip, true);
  clipper.Execute(
    ClipperLib.ClipType[operation],
    solution,
    ClipperLib.PolyFillType.pftEvenOdd,
    ClipperLib.PolyFillType.pftEvenOdd
  );
  return fromClipperPaths(solution);
}

function toClipperPaths(paths) {
  return paths.map(path => toClipperPath(path));
}

function toClipperPath(path) {
  return normalizePath(path).map(point => ({
    X: Math.round(point.x * CLIPPER_SCALE),
    Y: Math.round(point.y * CLIPPER_SCALE)
  }));
}

function fromClipperPaths(paths) {
  const ClipperLib = getClipperLib();
  const source = typeof ClipperLib.Clipper.CleanPolygons === "function"
    ? ClipperLib.Clipper.CleanPolygons(paths ?? [], BOOLEAN_CLEAN_DISTANCE * CLIPPER_SCALE)
    : paths;
  return Array.from(source ?? []).map(path => ({
    area: Math.abs(ClipperLib.Clipper.Area(path) / (CLIPPER_SCALE * CLIPPER_SCALE)),
    path: simplifyPath(path.map(point => ({
      x: point.X / CLIPPER_SCALE,
      y: point.Y / CLIPPER_SCALE
    })))
  }))
    .filter(entry => entry.area >= MIN_BOOLEAN_PATH_AREA && entry.path.length >= MIN_PATH_POINTS)
    .map(entry => entry.path);
}

function simplifyPath(path) {
  return removeCollinearPoints(removeDuplicateClosingPoint(removeConsecutiveDuplicatePoints(path)));
}

function densifyClosedPath(path, maxSegmentLength = DEFAULT_MAX_SEGMENT_LENGTH) {
  const normalized = normalizePath(path);
  const limit = Math.max(1, Number(maxSegmentLength) || DEFAULT_MAX_SEGMENT_LENGTH);
  if (normalized.length < MIN_PATH_POINTS) return normalized;

  const result = [];
  for (let index = 0; index < normalized.length; index += 1) {
    const current = normalized[index];
    const next = normalized[(index + 1) % normalized.length];
    result.push(current);
    const distance = Math.hypot(next.x - current.x, next.y - current.y);
    const steps = Math.floor(distance / limit);
    for (let step = 1; step <= steps; step += 1) {
      const ratio = step / (steps + 1);
      result.push({
        x: current.x + ((next.x - current.x) * ratio),
        y: current.y + ((next.y - current.y) * ratio)
      });
    }
  }
  return result;
}

function smoothClosedPath(path, iterations = DEFAULT_SMOOTHING_ITERATIONS) {
  let result = normalizePath(path);
  const count = Math.max(0, Math.trunc(iterations));
  for (let iteration = 0; iteration < count; iteration += 1) {
    if (result.length < MIN_PATH_POINTS) return result;
    const next = [];
    for (let index = 0; index < result.length; index += 1) {
      const current = result[index];
      const following = result[(index + 1) % result.length];
      next.push({
        x: (current.x * 0.75) + (following.x * 0.25),
        y: (current.y * 0.75) + (following.y * 0.25)
      });
      next.push({
        x: (current.x * 0.25) + (following.x * 0.75),
        y: (current.y * 0.25) + (following.y * 0.75)
      });
    }
    result = next;
  }
  return result;
}

function simplifyPathByDistance(path, tolerance = 0) {
  const normalized = normalizePath(path);
  if (normalized.length <= MIN_PATH_POINTS || tolerance <= 0) return normalized;
  const openPath = [...normalized, normalized[0]];
  const simplified = ramerDouglasPeucker(openPath, tolerance).slice(0, -1);
  return simplified.length >= MIN_PATH_POINTS ? simplified : normalized;
}

function ramerDouglasPeucker(points, tolerance) {
  if (points.length <= 2) return points;
  let maxDistance = 0;
  let splitIndex = 0;
  const first = points[0];
  const last = points.at(-1);
  for (let index = 1; index < points.length - 1; index += 1) {
    const distance = getPerpendicularDistance(points[index], first, last);
    if (distance <= maxDistance) continue;
    maxDistance = distance;
    splitIndex = index;
  }

  if (maxDistance <= tolerance) return [first, last];
  const left = ramerDouglasPeucker(points.slice(0, splitIndex + 1), tolerance);
  const right = ramerDouglasPeucker(points.slice(splitIndex), tolerance);
  return [...left.slice(0, -1), ...right];
}

function getPerpendicularDistance(point, lineStart, lineEnd) {
  const dx = lineEnd.x - lineStart.x;
  const dy = lineEnd.y - lineStart.y;
  if (Math.abs(dx) < 0.0001 && Math.abs(dy) < 0.0001) {
    return Math.hypot(point.x - lineStart.x, point.y - lineStart.y);
  }

  return Math.abs((dy * point.x) - (dx * point.y) + (lineEnd.x * lineStart.y) - (lineEnd.y * lineStart.x))
    / Math.hypot(dx, dy);
}

function removeConsecutiveDuplicatePoints(points) {
  const result = [];
  for (const point of points) {
    const previous = result.at(-1);
    if (previous && Math.abs(previous.x - point.x) < 0.001 && Math.abs(previous.y - point.y) < 0.001) continue;
    result.push(point);
  }
  return result;
}

function removeDuplicateClosingPoint(points) {
  if (points.length < 2) return points;
  const first = points[0];
  const last = points.at(-1);
  if (Math.abs(first.x - last.x) < 0.001 && Math.abs(first.y - last.y) < 0.001) return points.slice(0, -1);
  return points;
}

function removeCollinearPoints(points) {
  if (points.length <= MIN_PATH_POINTS) return points;
  const result = [];
  for (let index = 0; index < points.length; index += 1) {
    const previous = points[(index - 1 + points.length) % points.length];
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const cross = ((current.x - previous.x) * (next.y - current.y)) - ((current.y - previous.y) * (next.x - current.x));
    if (Math.abs(cross) < 0.001) continue;
    result.push(current);
  }
  return result.length >= MIN_PATH_POINTS ? result : points;
}

function mixRgb(from, to, ratio) {
  const amount = Math.max(0, Math.min(1, Number(ratio) || 0));
  const channels = from.map((channel, index) => Math.round(channel + ((to[index] - channel) * amount)));
  return `rgb(${channels[0]}, ${channels[1]}, ${channels[2]})`;
}

function formatSvgNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return Number(number.toFixed(MAX_SVG_DECIMALS)).toString();
}

function buildPaddedViewBox(bounds, fullWidth, fullHeight) {
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const padding = Math.max(4, Math.min(width, height) * 0.04);
  const x = Math.max(0, bounds.minX - padding);
  const y = Math.max(0, bounds.minY - padding);
  const right = Math.min(fullWidth, bounds.maxX + padding);
  const bottom = Math.min(fullHeight, bounds.maxY + padding);
  return `${formatSvgNumber(x)} ${formatSvgNumber(y)} ${formatSvgNumber(right - x)} ${formatSvgNumber(bottom - y)}`;
}
