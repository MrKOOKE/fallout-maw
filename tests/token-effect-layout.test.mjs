import test from "node:test";
import assert from "node:assert/strict";
import { buildHexEffectLayout, getHexEffectPolygonPoints } from "../src/canvas/token-effect-layout.mjs";

const EPSILON = 1e-7;

test("flat-top effects fill a one-cell hex in 3-4-5-4-3 column order", () => {
  const height = 100;
  const width = (2 * height) / Math.sqrt(3);
  const contains = createHexContains(width, height, true);
  const layout = buildHexEffectLayout({
    width,
    height,
    shortDiameter: 20,
    count: 19,
    columns: true,
    contains
  });

  assert.equal(layout.slots.length, 19);
  assert.deepEqual(countByCoordinate(layout.slots, "x"), [3, 4, 5, 4, 3]);
  assertColumnMajor(layout.slots);
  assertSlotsInside(layout, contains, true);
});

test("pointy-top layout is the transposed contained honeycomb", () => {
  const width = 100;
  const height = (2 * width) / Math.sqrt(3);
  const contains = createHexContains(width, height, false);
  const layout = buildHexEffectLayout({
    width,
    height,
    shortDiameter: 20,
    count: 19,
    columns: false,
    contains
  });

  assert.equal(layout.slots.length, 19);
  assert.deepEqual(countByCoordinate([...layout.slots].sort((a, b) => (a.y - b.y) || (a.x - b.x)), "y"), [3, 4, 5, 4, 3]);
  assertColumnMajor(layout.slots);
  assertSlotsInside(layout, contains, false);
});

test("partial flat-top layouts keep Foundry's top-down then rightward order", () => {
  const height = 100;
  const width = (2 * height) / Math.sqrt(3);
  const layout = buildHexEffectLayout({
    width,
    height,
    shortDiameter: 20,
    count: 5,
    columns: true,
    contains: createHexContains(width, height, true)
  });

  assert.deepEqual(layout.slots.map(slot => [
    round(slot.x / width),
    round(slot.y / height)
  ]), [
    [0.2, 0.3],
    [0.2, 0.5],
    [0.2, 0.7],
    [0.35, 0.2],
    [0.35, 0.4]
  ]);
});

test("effect cells shrink only when the native-size honeycomb is full", () => {
  const height = 100;
  const width = (2 * height) / Math.sqrt(3);
  const contains = createHexContains(width, height, true);
  const nativeLayout = buildHexEffectLayout({
    width,
    height,
    shortDiameter: 20,
    count: 19,
    columns: true,
    contains
  });
  const overflowLayout = buildHexEffectLayout({
    width,
    height,
    shortDiameter: 20,
    count: 20,
    columns: true,
    contains
  });

  assert.equal(nativeLayout.cellHeight, 20);
  assert.ok(overflowLayout.cellHeight < 20);
  assert.ok(overflowLayout.slots.length >= 20);
  assertSlotsInside(overflowLayout, contains, true);
});

test("large tokens stop scanning after the requested slots are found", () => {
  const height = 10000;
  const width = (2 * height) / Math.sqrt(3);
  const baseContains = createHexContains(width, height, true);
  let containmentChecks = 0;
  const layout = buildHexEffectLayout({
    width,
    height,
    shortDiameter: 20,
    count: 1,
    columns: true,
    contains: (x, y) => {
      containmentChecks += 1;
      return baseContains(x, y);
    }
  });

  assert.equal(layout.slots.length, 1);
  assert.ok(containmentChecks < 5000);
});

function createHexContains(width, height, columns) {
  const polygon = columns
    ? [0, height / 2, width / 4, 0, (3 * width) / 4, 0, width, height / 2,
        (3 * width) / 4, height, width / 4, height]
    : [width / 2, 0, width, height / 4, width, (3 * height) / 4, width / 2, height,
        0, (3 * height) / 4, 0, height / 4];
  return (x, y) => isInsideConvexPolygon(x, y, polygon);
}

function isInsideConvexPolygon(x, y, points) {
  let winding = 0;
  for (let index = 0; index < points.length; index += 2) {
    const next = (index + 2) % points.length;
    const ax = points[index];
    const ay = points[index + 1];
    const bx = points[next];
    const by = points[next + 1];
    const cross = ((bx - ax) * (y - ay)) - ((by - ay) * (x - ax));
    if (Math.abs(cross) <= EPSILON) continue;
    const direction = Math.sign(cross);
    if (winding && (direction !== winding)) return false;
    winding = direction;
  }
  return true;
}

function countByCoordinate(slots, key) {
  const groups = [];
  for (const slot of slots) {
    const previous = groups.at(-1);
    if (!previous || (Math.abs(previous.value - slot[key]) > EPSILON)) {
      groups.push({ value: slot[key], count: 1 });
    } else {
      previous.count += 1;
    }
  }
  return groups.map(group => group.count);
}

function assertColumnMajor(slots) {
  for (let index = 1; index < slots.length; index += 1) {
    const previous = slots[index - 1];
    const current = slots[index];
    const advancesColumn = current.x > (previous.x + EPSILON);
    const advancesDownColumn = (Math.abs(current.x - previous.x) <= EPSILON)
      && (current.y >= (previous.y - EPSILON));
    assert.ok(advancesColumn || advancesDownColumn);
  }
}

function assertSlotsInside(layout, contains, columns) {
  for (const slot of layout.slots) {
    const points = getHexEffectPolygonPoints(
      slot.x,
      slot.y,
      layout.iconWidth,
      layout.iconHeight,
      columns
    );
    for (let index = 0; index < points.length; index += 2) {
      assert.equal(contains(points[index], points[index + 1]), true);
    }
  }
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
