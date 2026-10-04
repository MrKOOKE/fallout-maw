import assert from "node:assert/strict";
import test from "node:test";
import { packInventoryBlockRows, getInventorySummaryColumnWidths } from "../src/utils/inventory-block-layout.mjs";

test("whole inventory blocks fill earlier rows without changing their widths", () => {
  assert.deepEqual(packInventoryBlockRows([400, 700, 200], 1000, 10), [
    { row: 0, width: 400 }, { row: 1, width: 700 }, { row: 0, width: 200 }
  ]);
});

test("summary may follow an equipment divider only when both panels retain room", () => {
  assert.deepEqual(getInventorySummaryColumnWidths(600, 1100, 20, 384), [600, 480]);
  assert.equal(getInventorySummaryColumnWidths(150, 1100, 20, 384), null);
  assert.equal(getInventorySummaryColumnWidths(900, 1100, 20, 384), null);
});

test("absent equipment and narrow sheets retain the independent summary layout", () => {
  assert.equal(getInventorySummaryColumnWidths(0, 1100, 20, 384), null);
  assert.equal(getInventorySummaryColumnWidths(300, 600, 20, 384), null);
  assert.equal(getInventorySummaryColumnWidths(undefined, 1100, 20, 384), null);
});
