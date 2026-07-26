import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../src/apps/search-inventory.mjs", import.meta.url),
  "utf8"
);
const styles = await readFile(
  new URL("../styles/fallout-maw.css", import.meta.url),
  "utf8"
);

function sliceBetween(startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start + startText.length);
  assert.ok(start >= 0 && end > start, `Missing source range: ${startText}`);
  return source.slice(start, end);
}

test("personal trade approval keeps the initiating button pending for the awaited request", () => {
  const completion = sliceBetween(
    "async #completePersonalTradeOffers",
    "async #requestPersonalTradeApprovalWithFeedback"
  );
  const feedback = sliceBetween(
    "async #requestPersonalTradeApprovalWithFeedback",
    "#getActorByUuid"
  );
  const click = sliceBetween("async #onTradeReadyClick", "async #onTradeRestartClick");

  assert.match(completion, /#requestPersonalTradeApprovalWithFeedback\(approvalButton/);
  assert.match(click, /#completePersonalTradeOffers\(button\)/);
  assert.match(feedback, /classList\.add\("personal-trade-approval-pending"\)/);
  assert.match(feedback, /approved = await requestPersonalTradeApproval\(payload\)/);
  assert.match(feedback, /finally[\s\S]*?classList\.remove\("personal-trade-approval-pending"\)/);
});

test("a declined personal trade flashes red for one second and reports the outcome", () => {
  const feedback = sliceBetween(
    "async #requestPersonalTradeApprovalWithFeedback",
    "#getActorByUuid"
  );

  assert.match(source, /const PERSONAL_TRADE_REJECTION_FEEDBACK_MS = 1000;/);
  assert.match(feedback, /classList\.add\("personal-trade-approval-rejected"\)/);
  assert.match(feedback, /ui\.notifications\.warn\("Сделка не состоялась\."\)/);
  assert.match(
    feedback,
    /await new Promise\(resolve => window\.setTimeout\(resolve, PERSONAL_TRADE_REJECTION_FEEDBACK_MS\)\)[\s\S]*?classList\.remove\("personal-trade-approval-rejected"\)/
  );
});

test("personal trade approval states have dedicated yellow and red button styles", () => {
  assert.match(
    styles,
    /\.fallout-maw-trade-ready-button\.personal-trade-approval-pending[\s\S]*?rgba\(255, 224, 92/
  );
  assert.match(
    styles,
    /\.fallout-maw-trade-ready-button\.personal-trade-approval-rejected[\s\S]*?rgba\(236, 91, 76/
  );
});
