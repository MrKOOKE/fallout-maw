import { normalizeConstructVisualRotation, clampConstructVisualRotation } from "./construct-visual-model.mjs";

/** Screen-up artwork: zero aims north, positive angles turn clockwise. */
export function calculateConstructAimRotation({ origin, point, bodyRotation = 0 } = {}) {
  if (![origin?.x, origin?.y, point?.x, point?.y].every(Number.isFinite)) return null;
  const dx = point.x - origin.x, dy = point.y - origin.y;
  if (Math.hypot(dx, dy) < 0.001) return null;
  return normalizeConstructVisualRotation(Math.atan2(dx, -dy) * 180 / Math.PI - bodyRotation);
}

export function constructLocalToWorld({ x, y }, { x: left = 0, y: top = 0, width, height, rotation = 0 } = {}) {
  const angle = rotation * Math.PI / 180;
  const dx = (x - 0.5) * width, dy = (y - 0.5) * height;
  return { x: left + width / 2 + dx * Math.cos(angle) - dy * Math.sin(angle),
    y: top + height / 2 + dx * Math.sin(angle) + dy * Math.cos(angle) };
}

export function isConstructAimWithinSector(rotation, part, anchorRotation = 0) {
  const relative = normalizeConstructVisualRotation(rotation - anchorRotation);
  const clamped = clampConstructVisualRotation(relative, part?.minRotation, part?.maxRotation);
  return Math.abs(normalizeConstructVisualRotation(relative - clamped)) < 0.001;
}

export function advanceConstructRotation(current, target, degreesPerSecond, seconds, sector = {}) {
  const anchor = Number(sector.anchorRotation) || 0;
  const bounded = Number.isFinite(sector.minRotation) && Number.isFinite(sector.maxRotation)
    && sector.maxRotation - sector.minRotation < 360;
  const relativeCurrent = bounded ? clampConstructVisualRotation(current - anchor, sector.minRotation, sector.maxRotation) : current;
  const relativeTarget = bounded ? clampConstructVisualRotation(target - anchor, sector.minRotation, sector.maxRotation) : target;
  // A limited turret must travel through its legal interval, never across the rear stop.
  const delta = bounded ? relativeTarget - relativeCurrent : normalizeConstructVisualRotation(target - current);
  const step = Math.max(0, Number(degreesPerSecond) || 0) * Math.max(0, Number(seconds) || 0);
  return normalizeConstructVisualRotation((bounded ? relativeCurrent + anchor : current) + Math.sign(delta) * Math.min(Math.abs(delta), step));
}
