export const TANK_GRID_HITBOX = { enabled: true };

function rotationFlagPatch(raw) {
  const profile = raw.flags?.["fallout-maw"]?.tokenHitbox;
  return { ...TANK_GRID_HITBOX, ...Object.fromEntries(["rotate", "x", "y", "width", "height"]
    .filter(key => profile?.[key] !== undefined).map(key => [`-=${key}`, null])) };
}

/** Correct the sample's former artwork-sized frame using native token fields. */
export function planTankTokenFootprint(document, { sceneToken = false } = {}) {
  const raw = document._source ?? document;
  if (raw.width !== 4 || raw.height !== 7) {
    const profile = raw.flags?.["fallout-maw"]?.tokenHitbox;
    // If the owner has already corrected the native size, retain their texture
    // scale, anchor and position; only remove the former crop settings.
    return raw.width === 3 && raw.height === 5 && profile?.enabled && "x" in profile
      ? { "flags.fallout-maw.tokenHitbox": rotationFlagPatch(raw) } : {};
  }
  const texture = raw.texture ?? {};
  const changes = { width: 3, height: 5,
    "texture.scaleX": (texture.scaleX ?? 1) * 1.4, "texture.scaleY": (texture.scaleY ?? 1) * 1.4,
    "texture.anchorY": Math.min(1, (texture.anchorY ?? 0.5) + 1 / 7),
    "flags.fallout-maw.tokenHitbox": rotationFlagPatch(raw) };
  if (sceneToken) {
    const grid = document.parent?.grid;
    const size = document.getSize?.() ?? { width: 4 * (grid?.sizeX ?? 100), height: 7 * (grid?.sizeY ?? 100) };
    const angle = (raw.lockRotation ? 0 : raw.rotation ?? 0) * Math.PI / 180;
    const delta = size.height / 7;
    const position = { x: (raw.x ?? 0) + size.width / 8 - delta * Math.sin(angle),
      y: (raw.y ?? 0) + delta + delta * Math.cos(angle), width: 3, height: 5 };
    const snapped = document.getSnappedPosition?.(position) ?? {
      x: Math.round(position.x / (grid?.sizeX ?? 100)) * (grid?.sizeX ?? 100),
      y: Math.round(position.y / (grid?.sizeY ?? 100)) * (grid?.sizeY ?? 100) };
    changes.x = snapped.x; changes.y = snapped.y;
  }
  return changes;
}
