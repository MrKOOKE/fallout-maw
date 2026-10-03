import { calculateConstructAimRotation, isConstructAimWithinSector } from "./construct-aim-geometry.mjs";
import { clampConstructVisualRotation } from "./construct-visual-model.mjs";

/** A seat's cone is local to its chosen anchor, not a scripted vehicle side. */
export function normalizeConstructPersonalWeapons(raw = {}) {
  raw = raw && typeof raw === "object" ? raw : {};
  const min = finite(raw.minRotation, -180, -180, 180);
  const max = finite(raw.maxRotation, 180, -180, 180);
  return {
    enabled: raw.enabled === true,
    anchorId: String(raw.anchorId ?? "").trim(),
    minRotation: Math.min(min, max), maxRotation: Math.max(min, max),
    maxRangeMeters: raw.maxRangeMeters === null || raw.maxRangeMeters === undefined || raw.maxRangeMeters === ""
      ? null : finite(raw.maxRangeMeters, null, 0, 100000),
    coverPercent: finite(raw.coverPercent, raw.exposed === true ? 0 : 100, 0, 100)
  };
}

export function isConstructFiringPortPointInSector(port, point) {
  if (!port?.origin || !point) return false;
  const rotation = calculateConstructAimRotation({ origin: port.origin, point, bodyRotation: port.rotation });
  return rotation !== null && isConstructAimWithinSector(rotation, port, 0);
}

/** The cursor can move beyond the opening, while the weapon stays at its stop. */
export function constrainConstructFiringPortAimPoint(port, point) {
  if (!port?.origin || !point) return null;
  const relative = calculateConstructAimRotation({ origin: port.origin, point, bodyRotation: port.rotation });
  if (relative === null) return null;
  if (isConstructAimWithinSector(relative, port)) return point;
  const rotation = clampConstructVisualRotation(relative, port.minRotation, port.maxRotation);
  const angle = (port.rotation + rotation) * Math.PI / 180;
  const distance = Math.hypot(point.x - port.origin.x, point.y - port.origin.y);
  return { x: port.origin.x + Math.sin(angle) * distance, y: port.origin.y - Math.cos(angle) * distance };
}

export function constrainConstructFiringPortRangeProfile(profile, port) {
  if (!port || port.maxRangeMeters === null || port.maxRangeMeters === undefined) return profile;
  const cap = Math.max(0, Number(port.maxRangeMeters) || 0);
  return { ...profile, maxRangeUnlimited: false,
    maxRangeMeters: profile.maxRangeUnlimited ? cap : Math.min(Math.max(0, Number(profile.maxRangeMeters) || 0), cap) };
}

function finite(value, fallback, min, max) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
