import assert from "node:assert/strict";
import test from "node:test";

import { scaleFirstAidSignedValue } from "../src/utils/first-aid-scaling.mjs";

test("first aid scaling preserves runtime floor, sign, and minimum magnitude", () => {
  assert.equal(scaleFirstAidSignedValue(5, 1.1), 5);
  assert.equal(scaleFirstAidSignedValue(5, 1.2), 6);
  assert.equal(scaleFirstAidSignedValue(-5, 0.5), -2);
  assert.equal(scaleFirstAidSignedValue(1, 0), 1);
  assert.equal(scaleFirstAidSignedValue(0, 2), 0);
});
