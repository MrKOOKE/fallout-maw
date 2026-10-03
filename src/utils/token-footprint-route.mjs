import { getTokenMovementAutoRotateOverride } from "./token-movement-auto-rotate.mjs";
import { getTokenHitboxProfile } from "./token-hitbox.mjs";

export function usesFootprintRouteRotation(document) {
  return Boolean(getTokenHitboxProfile(document) && !document.lockRotation
    && (getTokenMovementAutoRotateOverride(document) ?? globalThis.game?.settings?.get("core", "tokenAutoRotate")));
}

/** Annotate copies of native waypoints. Intermediate grid steps keep their segment's heading. */
export function prepareFootprintRoute(document, path) {
  if (!usesFootprintRouteRotation(document)) return path;
  const result = path.map(point => ({ ...point }));
  // Passed waypoints include the path currently being animated, not just the
  // distance already travelled. Their headings must not follow today's hull
  // angle. Older history does not store an initial angle: infer its first leg.
  let start = 0, rotation = result[0]?.stage === "passed" ? undefined : document.rotation;
  while (start < result.length - 1) {
    let end = start + 1;
    while (end < result.length - 1 && result[end].intermediate) end++;
    const from = document.getCenterPoint(result[start]), to = document.getCenterPoint(result[end]);
    if (!globalThis.CONFIG?.Token?.movement?.actions?.[result[end].action]?.teleport
      && Math.hypot(to.x - from.x, to.y - from.y) > 1e-6) {
      const next = ((Math.atan2(to.y - from.y, to.x - from.x) * 180 / Math.PI - 90) % 360 + 360) % 360;
      for (let i = start; i <= end; i++) {
        if (i === start && Number.isFinite(rotation) && Math.abs(((next - rotation + 540) % 360) - 180) > 1e-6)
          result[i]._footprintTurnFrom = rotation;
        result[i].rotation = next;
        if (i > start) result[i]._footprintTravelRotation = next;
      }
      rotation = next;
    }
    start = end;
  }
  return result;
}

/** Native grid cells swept during a turn are highlighted at the native waypoint. */
export function getFootprintTurnRotations(from, to) {
  const delta = ((to - from + 540) % 360) - 180;
  const steps = Math.max(1, Math.ceil(Math.abs(delta) / 15));
  return Array.from({ length: steps + 1 }, (_, i) => from + delta * i / steps);
}
