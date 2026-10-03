import { intersectConvexPolygons } from "./token-hitbox.mjs";

const mix = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

// SmoothGraphics extrudes the outline at every vertex. Clipping can produce
// repeated or collinear vertices whose tiny turn creates an unbounded miter.
function cleanContour(points) {
  const result = points.filter((point, i) => Math.hypot(point.x - points[(i + points.length - 1) % points.length].x,
    point.y - points[(i + points.length - 1) % points.length].y) > 1e-5);
  for (let i = result.length - 1; i >= 0 && result.length > 2; i--) {
    const a = result[(i + result.length - 1) % result.length], b = result[i], c = result[(i + 1) % result.length];
    const ab = Math.hypot(b.x - a.x, b.y - a.y), bc = Math.hypot(c.x - b.x, c.y - b.y);
    if (Math.abs((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)) <= 1e-5 * (ab + bc)) result.splice(i, 1);
  }
  return result.length >= 3 ? result : [];
}

/** Select one complete lower edge by its horizontal projection. */
export function getFootprintBarEdge(geometry) {
  let edge = 0, span = -Infinity;
  for (let i = 0; i < geometry.points.length; i++) {
    const dx = geometry.points[i].x - geometry.points[(i + 1) % geometry.points.length].x;
    if (dx > span + 1e-6) { span = dx; edge = i; }
  }
  return edge;
}

/** An optional animated edge position sweeps through a corner, then finishes on one edge. */
export function getFootprintBarPath(geometry, rotation, { upper = false, edgePosition = getFootprintBarEdge(geometry) } = {}) {
  if (geometry.points.length !== 4) return null;
  const position = ((edgePosition + (upper ? 2 : 0)) % 4 + 4) % 4;
  const edge = Math.ceil(position), t = edge - position;
  const p = geometry.points, a = p[(edge + 1) % 4], b = p[edge % 4], c = p[(edge + 3) % 4];
  let points = [mix(a, b, t), b, mix(b, c, t)];
  if (upper) points.reverse();
  points = points.filter((point, i) => !i || Math.hypot(point.x - points[i - 1].x, point.y - points[i - 1].y) > 1e-6);
  const lengths = points.slice(1).map((point, i) => Math.hypot(point.x - points[i].x, point.y - points[i].y));
  return { points, lengths, length: lengths.reduce((sum, value) => sum + value, 0), upper };
}

/** Bend native bar rectangles along the perimeter; clip every fill inside the native shape. */
export function mapFootprintBarRect(geometry, path, rect, { width, height }) {
  if (!path?.length || !rect.width || !rect.height) return [];
  const start = Math.max(0, rect.x / width * path.length), end = Math.min(path.length, (rect.x + rect.width) / width * path.length);
  const stops = [start];
  let distance = 0;
  for (const length of path.lengths.slice(0, -1)) {
    distance += length;
    if (distance > start + 1e-6 && distance < end - 1e-6) stops.push(distance);
  }
  stops.push(end);
  const directions = path.lengths.map((length, i) => ({
    x: (path.points[i + 1].x - path.points[i].x) / length,
    y: (path.points[i + 1].y - path.points[i].y) / length
  }));
  const normals = directions.map(({ x, y }) => path.upper ? { x: -y, y: x } : { x: y, y: -x });
  const corner = path.points.length === 3 ? path.lengths[0] : null;
  if (corner === null || start >= corner || end <= corner) {
    const i = corner !== null && start >= corner ? 1 : 0, travelled = i ? corner : 0;
    const at = (offset, y) => {
      const point = mix(path.points[i], path.points[i + 1], (offset - travelled) / path.lengths[i]);
      const inset = path.upper ? y : height - y;
      return { x: point.x + normals[i].x * inset, y: point.y + normals[i].y * inset };
    };
    return cleanContour(intersectConvexPolygons([at(start, rect.y), at(end, rect.y),
      at(end, rect.y + rect.height), at(start, rect.y + rect.height)], geometry.points));
  }
  const at = (offset, y) => {
    const inset = path.upper ? y : height - y;
    if (corner !== null && inset > 0) {
      const b = path.points[1];
      if (Math.abs(offset - corner) < 1e-6) return {
        x: b.x + (normals[0].x + normals[1].x) * inset,
        y: b.y + (normals[0].y + normals[1].y) * inset
      };
      // As a leg disappears, slide its inner cap along the adjoining offset
      // edge. It converges to the next straight bar without a reversed stub.
      const remaining = corner - offset;
      if (remaining > 0 && remaining < inset) return {
        x: b.x + normals[1].x * inset + directions[1].x * remaining,
        y: b.y + normals[1].y * inset + directions[1].y * remaining
      };
      if (remaining < 0 && -remaining < inset) return {
        x: b.x + normals[0].x * inset + directions[0].x * remaining,
        y: b.y + normals[0].y * inset + directions[0].y * remaining
      };
    }
    let travelled = 0;
    for (let i = 0; i < path.lengths.length; i++) {
      const length = path.lengths[i];
      if (offset <= travelled + length + 1e-6 || i === path.lengths.length - 1) {
        const point = mix(path.points[i], path.points[i + 1], Math.max(0, Math.min(1, (offset - travelled) / length)));
        point.x += normals[i].x * inset;
        point.y += normals[i].y * inset;
        return point;
      }
      travelled += length;
    }
  };
  return cleanContour(intersectConvexPolygons([...stops.map(offset => at(offset, rect.y)),
    ...stops.toReversed().map(offset => at(offset, rect.y + rect.height))], geometry.points));
}
