const DEFAULT_LEAF_SIZE = 12;
const QUERY_PADDING_ULPS = 64;

/**
 * Compile immutable segment bounds into a flat binary bounding-volume hierarchy.
 *
 * The returned index only stores AABBs. Query results are indexes into the
 * original `segments` array, so callers can perform their exact ray/segment
 * intersection math without wrapping or copying segment objects.
 *
 * @param {Array<object>} segments
 * @param {object} [options]
 * @param {number} [options.leafSize=12]
 * @returns {object}
 */
export function compileSmokeSegmentBvh(segments, { leafSize = DEFAULT_LEAF_SIZE } = {}) {
  if (!Array.isArray(segments)) throw new TypeError("Smoke BVH segments must be an array");
  leafSize = Number(leafSize);
  if (!Number.isInteger(leafSize) || leafSize < 1) {
    throw new RangeError("Smoke BVH leafSize must be a positive integer");
  }

  const segmentCount = segments.length;
  const segmentMinX = new Float64Array(segmentCount);
  const segmentMinY = new Float64Array(segmentCount);
  const segmentMaxX = new Float64Array(segmentCount);
  const segmentMaxY = new Float64Array(segmentCount);
  const segmentOrder = new Uint32Array(segmentCount);
  let coordinateScale = 1;

  for (let index = 0; index < segmentCount; index++) {
    const bounds = readSegmentBounds(segments[index], index);
    segmentMinX[index] = bounds.minX;
    segmentMinY[index] = bounds.minY;
    segmentMaxX[index] = bounds.maxX;
    segmentMaxY[index] = bounds.maxY;
    segmentOrder[index] = index;
    coordinateScale = Math.max(
      coordinateScale,
      Math.abs(bounds.minX),
      Math.abs(bounds.minY),
      Math.abs(bounds.maxX),
      Math.abs(bounds.maxY)
    );
  }

  if (!segmentCount) {
    return {
      root: -1,
      nodeCount: 0,
      segmentCount: 0,
      leafSize,
      coordinateScale,
      segmentOrder,
      segmentMinX,
      segmentMinY,
      segmentMaxX,
      segmentMaxY,
      nodeMinX: new Float64Array(0),
      nodeMinY: new Float64Array(0),
      nodeMaxX: new Float64Array(0),
      nodeMaxY: new Float64Array(0),
      nodeLeft: new Int32Array(0),
      nodeRight: new Int32Array(0),
      nodeStart: new Uint32Array(0),
      nodeSize: new Uint32Array(0)
    };
  }

  // A full binary tree with N leaves cannot require more than 2N - 1 nodes.
  const maximumNodeCount = (segmentCount * 2) - 1;
  const nodeMinX = new Float64Array(maximumNodeCount);
  const nodeMinY = new Float64Array(maximumNodeCount);
  const nodeMaxX = new Float64Array(maximumNodeCount);
  const nodeMaxY = new Float64Array(maximumNodeCount);
  const nodeLeft = new Int32Array(maximumNodeCount);
  const nodeRight = new Int32Array(maximumNodeCount);
  const nodeStart = new Uint32Array(maximumNodeCount);
  const nodeSize = new Uint32Array(maximumNodeCount);
  nodeLeft.fill(-1);
  nodeRight.fill(-1);
  let nodeCount = 0;

  const buildNode = (start, end) => {
    const node = nodeCount++;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let minimumCenterX = Infinity;
    let minimumCenterY = Infinity;
    let maximumCenterX = -Infinity;
    let maximumCenterY = -Infinity;
    for (let position = start; position < end; position++) {
      const segmentIndex = segmentOrder[position];
      const currentMinX = segmentMinX[segmentIndex];
      const currentMinY = segmentMinY[segmentIndex];
      const currentMaxX = segmentMaxX[segmentIndex];
      const currentMaxY = segmentMaxY[segmentIndex];
      const centerX = (currentMinX / 2) + (currentMaxX / 2);
      const centerY = (currentMinY / 2) + (currentMaxY / 2);
      minX = Math.min(minX, currentMinX);
      minY = Math.min(minY, currentMinY);
      maxX = Math.max(maxX, currentMaxX);
      maxY = Math.max(maxY, currentMaxY);
      minimumCenterX = Math.min(minimumCenterX, centerX);
      minimumCenterY = Math.min(minimumCenterY, centerY);
      maximumCenterX = Math.max(maximumCenterX, centerX);
      maximumCenterY = Math.max(maximumCenterY, centerY);
    }

    const size = end - start;
    nodeMinX[node] = minX;
    nodeMinY[node] = minY;
    nodeMaxX[node] = maxX;
    nodeMaxY[node] = maxY;
    nodeStart[node] = start;
    nodeSize[node] = size;
    if (size <= leafSize) return node;

    const splitOnX = (maximumCenterX - minimumCenterX) >= (maximumCenterY - minimumCenterY);
    segmentOrder.subarray(start, end).sort((left, right) => {
      const leftCenter = splitOnX
        ? (segmentMinX[left] / 2) + (segmentMaxX[left] / 2)
        : (segmentMinY[left] / 2) + (segmentMaxY[left] / 2);
      const rightCenter = splitOnX
        ? (segmentMinX[right] / 2) + (segmentMaxX[right] / 2)
        : (segmentMinY[right] / 2) + (segmentMaxY[right] / 2);
      return (leftCenter - rightCenter) || (left - right);
    });
    const middle = start + Math.floor(size / 2);
    nodeLeft[node] = buildNode(start, middle);
    nodeRight[node] = buildNode(middle, end);
    return node;
  };

  const root = buildNode(0, segmentCount);
  return {
    root,
    nodeCount,
    segmentCount,
    leafSize,
    coordinateScale,
    segmentOrder,
    segmentMinX,
    segmentMinY,
    segmentMaxX,
    segmentMaxY,
    nodeMinX,
    nodeMinY,
    nodeMaxX,
    nodeMaxY,
    nodeLeft,
    nodeRight,
    nodeStart,
    nodeSize
  };
}

/**
 * Return indexes of segment AABBs touched by a finite query segment.
 *
 * `output` and `stack` are cleared before use and can be retained by a hot-path
 * caller. The test is deliberately inclusive and padded by a few floating-point
 * ULPs: a boundary-near edge may be returned as a false positive, but an edge
 * whose AABB is intersected must never be omitted.
 *
 * @param {object} index
 * @param {number} fromX
 * @param {number} fromY
 * @param {number} toX
 * @param {number} toY
 * @param {number[]} [output=[]]
 * @param {number[]} [stack=[]]
 * @returns {number[]}
 */
export function querySmokeSegmentBvh(
  index,
  fromX,
  fromY,
  toX,
  toY,
  output = [],
  stack = []
) {
  assertFiniteCoordinate(fromX, "fromX");
  assertFiniteCoordinate(fromY, "fromY");
  assertFiniteCoordinate(toX, "toX");
  assertFiniteCoordinate(toY, "toY");
  if (!index || typeof index !== "object") throw new TypeError("Smoke BVH index is required");
  if (!Array.isArray(output) || !Array.isArray(stack) || output === stack) {
    throw new TypeError("Smoke BVH output and stack must be distinct arrays");
  }

  output.length = 0;
  stack.length = 0;
  if (index.root < 0 || !index.segmentCount) return output;

  const dx = toX - fromX;
  const dy = toY - fromY;
  const queryMinX = Math.min(fromX, toX);
  const queryMinY = Math.min(fromY, toY);
  const queryMaxX = Math.max(fromX, toX);
  const queryMaxY = Math.max(fromY, toY);
  const coordinateScale = Math.max(
    1,
    Number(index.coordinateScale) || 1,
    Math.abs(fromX),
    Math.abs(fromY),
    Math.abs(toX),
    Math.abs(toY)
  );
  const padding = Number.EPSILON * QUERY_PADDING_ULPS * coordinateScale;

  stack.push(index.root);
  while (stack.length) {
    const node = stack.pop();
    if (!querySegmentIntersectsBounds(
      fromX,
      fromY,
      dx,
      dy,
      queryMinX,
      queryMinY,
      queryMaxX,
      queryMaxY,
      index.nodeMinX[node],
      index.nodeMinY[node],
      index.nodeMaxX[node],
      index.nodeMaxY[node],
      padding
    )) continue;

    const left = index.nodeLeft[node];
    if (left >= 0) {
      // Push right first so traversal remains deterministic and visits left first.
      stack.push(index.nodeRight[node], left);
      continue;
    }

    const end = index.nodeStart[node] + index.nodeSize[node];
    for (let position = index.nodeStart[node]; position < end; position++) {
      const segmentIndex = index.segmentOrder[position];
      if (querySegmentIntersectsBounds(
        fromX,
        fromY,
        dx,
        dy,
        queryMinX,
        queryMinY,
        queryMaxX,
        queryMaxY,
        index.segmentMinX[segmentIndex],
        index.segmentMinY[segmentIndex],
        index.segmentMaxX[segmentIndex],
        index.segmentMaxY[segmentIndex],
        padding
      )) output.push(segmentIndex);
    }
  }
  return output;
}

function readSegmentBounds(segment, index) {
  const ax = Number(segment?.a?.x);
  const ay = Number(segment?.a?.y);
  const bx = Number(segment?.b?.x);
  const by = Number(segment?.b?.y);
  const hasEndpoints = [ax, ay, bx, by].every(Number.isFinite);
  const explicitMinX = Number(segment?.minX);
  const explicitMinY = Number(segment?.minY);
  const explicitMaxX = Number(segment?.maxX);
  const explicitMaxY = Number(segment?.maxY);
  const hasExplicitBounds = [explicitMinX, explicitMinY, explicitMaxX, explicitMaxY].every(Number.isFinite);
  if (!hasEndpoints && !hasExplicitBounds) {
    throw new TypeError(`Smoke BVH segment ${index} has no finite endpoints or bounds`);
  }

  let minX = hasEndpoints ? Math.min(ax, bx) : Infinity;
  let minY = hasEndpoints ? Math.min(ay, by) : Infinity;
  let maxX = hasEndpoints ? Math.max(ax, bx) : -Infinity;
  let maxY = hasEndpoints ? Math.max(ay, by) : -Infinity;
  if (hasExplicitBounds) {
    // Union the supplied AABB with endpoint-derived bounds. A stale or rounded
    // caller-provided bound can only increase candidates, never hide an edge.
    minX = Math.min(minX, explicitMinX, explicitMaxX);
    minY = Math.min(minY, explicitMinY, explicitMaxY);
    maxX = Math.max(maxX, explicitMinX, explicitMaxX);
    maxY = Math.max(maxY, explicitMinY, explicitMaxY);
  }
  return { minX, minY, maxX, maxY };
}

function assertFiniteCoordinate(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`Smoke BVH ${name} must be finite`);
}

/** Liang-Barsky segment/AABB test with inclusive, conservatively padded bounds. */
function querySegmentIntersectsBounds(
  fromX,
  fromY,
  dx,
  dy,
  queryMinX,
  queryMinY,
  queryMaxX,
  queryMaxY,
  rawMinX,
  rawMinY,
  rawMaxX,
  rawMaxY,
  padding
) {
  const minX = rawMinX - padding;
  const minY = rawMinY - padding;
  const maxX = rawMaxX + padding;
  const maxY = rawMaxY + padding;
  if (queryMaxX < minX || queryMinX > maxX || queryMaxY < minY || queryMinY > maxY) return false;

  let entry = 0;
  let exit = 1;
  if (dx === 0) {
    if (fromX < minX || fromX > maxX) return false;
  } else {
    let near = (minX - fromX) / dx;
    let far = (maxX - fromX) / dx;
    if (near > far) {
      const swap = near;
      near = far;
      far = swap;
    }
    entry = Math.max(entry, near);
    exit = Math.min(exit, far);
    if (entry > exit) return false;
  }

  if (dy === 0) return fromY >= minY && fromY <= maxY;
  let near = (minY - fromY) / dy;
  let far = (maxY - fromY) / dy;
  if (near > far) {
    const swap = near;
    near = far;
    far = swap;
  }
  entry = Math.max(entry, near);
  exit = Math.min(exit, far);
  return entry <= exit;
}
