/** Distance from the actual attack origin; only legacy body attacks grant a size allowance. */
export function getAttackOriginDistanceMeters(origin, point, { pixelsPerMeter = 1, rangeBonusMeters = 0 } = {}) {
  if (![origin?.x, origin?.y, point?.x, point?.y].every(Number.isFinite)) return Infinity;
  const scale = Math.max(0.0001, Number(pixelsPerMeter) || 1);
  return Math.max(0, Math.hypot(point.x - origin.x, point.y - origin.y) / scale - Math.max(0, Number(rangeBonusMeters) || 0));
}

/** A barrel cannot choose an impact point at or behind its muzzle plane. */
export function isPointForwardOfAttackOrigin(point, geometry, epsilon = 0.001) {
  if (!point || !geometry?.origin) return false;
  const angle = Number(geometry.angle) || 0;
  return ((point.x - geometry.origin.x) * Math.cos(angle))
    + ((point.y - geometry.origin.y) * Math.sin(angle)) > epsilon;
}

/** Keep the barrel ray facing forward even if a stale target point crosses behind the muzzle. */
export function getAttackTrajectoryAngleThroughPoint(geometry, point) {
  if (geometry.forwardOnly && !isPointForwardOfAttackOrigin(point, geometry)) return Number(geometry.angle) || 0;
  return Math.atan2(point.y - geometry.origin.y, point.x - geometry.origin.x);
}
