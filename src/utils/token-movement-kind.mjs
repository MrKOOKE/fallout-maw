/** Foundry also emits movement operations for resizing; only travel spends drive resources. */
export function isTokenMovementTravel(movement = {}) {
  const waypoints = [movement.origin, ...(movement.passed?.waypoints ?? []),
    ...(movement.pending?.waypoints ?? []), movement.destination].filter(Boolean);
  let previous = waypoints[0];
  for (const waypoint of waypoints.slice(1)) {
    const next = { ...previous, ...waypoint };
    if (["x", "y", "elevation", "level"].some(key => next[key] !== previous[key])) return true;
    previous = next;
  }
  return false;
}
