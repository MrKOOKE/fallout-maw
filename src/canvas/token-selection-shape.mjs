import { getTokenHitboxGeometry } from "../utils/token-hitbox.mjs";

/** Use the same local polygon as the native token, including its rotating footprint. */
export function getTokenSelectionShape(token) {
  const object = token?.object ?? token;
  const document = object?.document ?? token?.document ?? token;
  let points = document?.getGridSpacePolygon?.() ?? getTokenHitboxGeometry(document)?.points;
  if (!points) {
    const gridSize = globalThis.canvas?.grid?.size ?? 100;
    const size = document?.getSize?.() ?? {
      width: Math.max(0.5, Number(document?.width) || 1) * gridSize,
      height: Math.max(0.5, Number(document?.height) || 1) * gridSize
    };
    points = [{ x: 0, y: 0 }, { x: size.width, y: 0 },
      { x: size.width, y: size.height }, { x: 0, y: size.height }];
  }
  return { x: Number(document?.x ?? object?.x) || 0, y: Number(document?.y ?? object?.y) || 0,
    points, signature: points.map(p => `${p.x},${p.y}`).join(":") };
}

/** Test the polygon itself, not the empty corners of its axis-aligned bounds. */
export function isPointInTokenSelectionShape(point, token) {
  if (!point) return false;
  const shape = getTokenSelectionShape(token), x = point.x - shape.x, y = point.y - shape.y;
  let inside = false;
  for (let i = 0, j = shape.points.length - 1; i < shape.points.length; j = i++) {
    const a = shape.points[j], b = shape.points[i];
    const cross = (x - a.x) * (b.y - a.y) - (y - a.y) * (b.x - a.x);
    if (Math.abs(cross) < 1e-6 && x >= Math.min(a.x, b.x) - 1e-6 && x <= Math.max(a.x, b.x) + 1e-6
      && y >= Math.min(a.y, b.y) - 1e-6 && y <= Math.max(a.y, b.y) + 1e-6) return true;
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
