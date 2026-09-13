import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import test from "node:test";
import { documentSourcesEqual } from "../src/documents/document-source-equality.mjs";

globalThis.foundry = { utils: { equals: isDeepStrictEqual } };

test("equal independently copied document sources match, including arrays and nested flags", () => {
  const source = { _id: "tile", x: 40, texture: { anchorX: 0.5 }, levels: ["one", "two"], flags: { system: { rows: [{ key: "cover", points: [[0, 1], [2, 3]] }] } } };
  assert.equal(documentSourcesEqual(source, structuredClone(source)), true);
});

test("source edits, inserted and deleted keys invalidate equality even with undefined values", () => {
  const source = { x: 40, optional: undefined, flags: { nested: { value: 2 } } };
  for (const mutate of [
    copy => { copy.x = 41; },
    copy => { copy.flags.nested.value = 3; },
    copy => { copy.extra = undefined; },
    copy => { delete copy.optional; },
    copy => { delete copy.optional; copy.other = undefined; }
  ]) {
    const copy = structuredClone(source);
    mutate(copy);
    assert.equal(documentSourcesEqual(source, copy), false);
    assert.equal(documentSourcesEqual(copy, source), false);
  }
});

test("array lengths, order and element types must match", () => {
  for (const [a, b] of [ [[1], [1, 2]], [[1, 2], [2, 1]], [[1], ["1"]], [[1], { 0: 1 }], [null, {}], [false, 0] ]) {
    assert.equal(documentSourcesEqual(a, b), false);
  }
});

test("plain null-prototype records match and inherited properties do not count", () => {
  const record = Object.assign(Object.create(null), { x: 2, flags: {} });
  assert.equal(documentSourcesEqual(record, { x: 2, flags: {} }), true);
});

test("non-plain values use Foundry equality rather than treating empty objects as equal", () => {
  assert.equal(documentSourcesEqual(new Date(1), new Date(2)), false);
  assert.equal(documentSourcesEqual(new Date(1), new Date(1)), true);
  assert.equal(documentSourcesEqual(new Map([[1, 2]]), new Map([[1, 3]])), false);
});
