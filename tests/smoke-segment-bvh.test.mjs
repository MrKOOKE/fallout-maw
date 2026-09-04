import assert from "node:assert/strict";
import test from "node:test";

import {
  compileSmokeSegmentBvh,
  querySmokeSegmentBvh
} from "../src/canvas/smoke-segment-bvh.mjs";

test("smoke segment BVH handles empty, axis-aligned, reversed, and zero-length queries", () => {
  const empty = compileSmokeSegmentBvh([]);
  const output = [99];
  const stack = [88];
  assert.equal(querySmokeSegmentBvh(empty, 0, 0, 0, 0, output, stack), output);
  assert.deepEqual(output, []);
  assert.deepEqual(stack, []);

  const segments = [
    segment(-10, -5, -2, -5),
    segment(4, -8, 4, 6),
    segment(-3, 7, -3, 7),
    segment(20, 20, 30, 30)
  ];
  const index = compileSmokeSegmentBvh(segments, { leafSize: 1 });
  assert.ok(index.segmentOrder instanceof Uint32Array);
  assert.ok(index.nodeMinX instanceof Float64Array);

  assertQueryContainsExactly(index, segments, -20, -5, 10, -5);
  assertQueryContainsExactly(index, segments, 4, 20, 4, -20);
  assertQueryContainsExactly(index, segments, 10, 10, -20, -20);
  assertQueryContainsExactly(index, segments, -3, 7, -3, 7);
  assertQueryContainsExactly(index, segments, 25, 25, 25, 25);
});

test("smoke segment BVH accepts explicit bounds and conservatively unions them with endpoints", () => {
  const segments = [
    { minX: -8, minY: -4, maxX: -2, maxY: 3 },
    {
      a: { x: 10, y: 10 },
      b: { x: 12, y: 12 },
      minX: 11,
      minY: 11,
      maxX: 11,
      maxY: 11
    }
  ];
  const index = compileSmokeSegmentBvh(segments, { leafSize: 1 });
  assert.deepEqual(sorted(querySmokeSegmentBvh(index, -9, 0, 0, 0)), [0]);
  assert.deepEqual(sorted(querySmokeSegmentBvh(index, 10, 10, 10, 10)), [1]);
});

test("smoke segment BVH is a conservative randomized differential of brute-force segment/AABB tests", () => {
  const random = mulberry32(0x51A0B7);
  const reusableOutput = [];
  const reusableStack = [];

  for (let fixture = 0; fixture < 48; fixture++) {
    const segmentCount = 1 + Math.floor(random() * 240);
    const segments = [];
    for (let index = 0; index < segmentCount; index++) {
      let ax = randomCoordinate(random);
      let ay = randomCoordinate(random);
      let bx = randomCoordinate(random);
      let by = randomCoordinate(random);
      const kind = index % 11;
      if (kind === 0) bx = ax;
      else if (kind === 1) by = ay;
      else if (kind === 2) {
        bx = ax;
        by = ay;
      }
      segments.push(segment(ax, ay, bx, by));
    }
    const index = compileSmokeSegmentBvh(segments, { leafSize: 1 + (fixture % 19) });

    for (let query = 0; query < 96; query++) {
      let fromX = randomCoordinate(random);
      let fromY = randomCoordinate(random);
      let toX = randomCoordinate(random);
      let toY = randomCoordinate(random);
      const kind = query % 13;
      if (kind === 0) toX = fromX;
      else if (kind === 1) toY = fromY;
      else if (kind === 2) {
        toX = fromX;
        toY = fromY;
      } else if (kind === 3) {
        // Exercise exact AABB boundary contact rather than only generic random crossings.
        const target = segments[query % segments.length];
        fromX = target.minX;
        fromY = target.minY - 20;
        toX = target.minX;
        toY = target.maxY + 20;
      }

      const actual = querySmokeSegmentBvh(
        index,
        fromX,
        fromY,
        toX,
        toY,
        reusableOutput,
        reusableStack
      );
      assert.equal(actual, reusableOutput);
      assert.equal(reusableStack.length, 0);
      assert.equal(new Set(actual).size, actual.length, "a segment index is emitted at most once");
      const actualSet = new Set(actual);
      for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
        const candidate = segments[segmentIndex];
        if (!bruteSegmentIntersectsAabb(fromX, fromY, toX, toY, candidate)) continue;
        assert.equal(
          actualSet.has(segmentIndex),
          true,
          `missing fixture=${fixture} query=${query} segment=${segmentIndex}`
        );
      }
    }
  }
});

test("smoke segment BVH rejects malformed compilation and query inputs", () => {
  assert.throws(() => compileSmokeSegmentBvh(null), TypeError);
  assert.throws(() => compileSmokeSegmentBvh([{}]), TypeError);
  assert.throws(() => compileSmokeSegmentBvh([], { leafSize: 0 }), RangeError);
  const index = compileSmokeSegmentBvh([segment(0, 0, 1, 1)]);
  assert.throws(() => querySmokeSegmentBvh(index, NaN, 0, 1, 1), TypeError);
  const shared = [];
  assert.throws(() => querySmokeSegmentBvh(index, 0, 0, 1, 1, shared, shared), TypeError);
});

function segment(ax, ay, bx, by) {
  return {
    a: { x: ax, y: ay },
    b: { x: bx, y: by },
    minX: Math.min(ax, bx),
    minY: Math.min(ay, by),
    maxX: Math.max(ax, bx),
    maxY: Math.max(ay, by)
  };
}

function assertQueryContainsExactly(index, segments, fromX, fromY, toX, toY) {
  const expected = segments
    .map((candidate, segmentIndex) => ({ candidate, segmentIndex }))
    .filter(({ candidate }) => bruteSegmentIntersectsAabb(fromX, fromY, toX, toY, candidate))
    .map(({ segmentIndex }) => segmentIndex);
  const actual = sorted(querySmokeSegmentBvh(index, fromX, fromY, toX, toY));
  assert.deepEqual(actual, expected);
}

function bruteSegmentIntersectsAabb(fromX, fromY, toX, toY, bounds) {
  const dx = toX - fromX;
  const dy = toY - fromY;
  let entry = 0;
  let exit = 1;
  for (const [origin, delta, minimum, maximum] of [
    [fromX, dx, bounds.minX, bounds.maxX],
    [fromY, dy, bounds.minY, bounds.maxY]
  ]) {
    if (delta === 0) {
      if (origin < minimum || origin > maximum) return false;
      continue;
    }
    let near = (minimum - origin) / delta;
    let far = (maximum - origin) / delta;
    if (near > far) [near, far] = [far, near];
    entry = Math.max(entry, near);
    exit = Math.min(exit, far);
    if (entry > exit) return false;
  }
  return true;
}

function sorted(values) {
  return [...values].sort((left, right) => left - right);
}

function randomCoordinate(random) {
  return Math.round(((random() * 4_000) - 2_000) * 8) / 8;
}

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
