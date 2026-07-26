import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const searchInventorySource = await readFile(
  new URL("../src/apps/search-inventory.mjs", import.meta.url),
  "utf8"
);

test("cross-actor inventory insertion removes the selected virtual stack part", () => {
  const start = searchInventorySource.indexOf("async function insertExternalItemIntoActorInventory");
  const end = searchInventorySource.indexOf("async function transferContainerTree", start);
  assert.ok(start >= 0 && end > start, "insertExternalItemIntoActorInventory source was not found");

  const implementation = searchInventorySource.slice(start, end);
  assert.match(
    implementation,
    /createTransferredItemRemovalPlan\(\s*sourceItem,\s*getItemQuantity\(itemData\),\s*\{\s*stackIndex:\s*sourceStackIndex\s*\}\s*\)/
  );
});

test("regular trade atomically consumes both offers but keeps received entries in Purchased", () => {
  const completeStart = searchInventorySource.indexOf("async function completeTradeSession");
  const completeEnd = searchInventorySource.indexOf("\nasync function reclaimCompletedTradeSessionRemainders", completeStart);
  assert.ok(completeStart >= 0 && completeEnd > completeStart);
  const completion = searchInventorySource.slice(completeStart, completeEnd);
  assert.match(completion, /executeTradeOfferSettlement\(\{/);
  assert.match(completion, /sides:\s*\[/);
  assert.doesNotMatch(completion, /currencyDeliveries|deliverTradeOfferItemsToActor|LOCKED_STORAGE_PARENT_ID/);
  assert.match(completion, /searcher:\s*searcherReceived/);
  assert.match(completion, /searched:\s*searchedReceived/);

  const legacyStart = searchInventorySource.indexOf("async function performTradeComplete");
  const legacyEnd = searchInventorySource.indexOf("\nasync function performPersonalTradeComplete", legacyStart);
  const legacyCompletion = searchInventorySource.slice(legacyStart, legacyEnd);
  assert.match(legacyCompletion, /getActiveTradeSession/);
  assert.match(legacyCompletion, /await completeTradeSession\(session/);
  assert.doesNotMatch(legacyCompletion, /payload\.offers|executeTradeOfferSettlement/);
});

test("personal trade uses normal inventory placement and floor fallback, never locked delivery", () => {
  const start = searchInventorySource.indexOf("async function performPersonalTradeComplete");
  const end = searchInventorySource.indexOf("\nfunction normalizePersonalTradeOperationId", start);
  assert.ok(start >= 0 && end > start);
  const implementation = searchInventorySource.slice(start, end);
  assert.match(implementation, /executeTradeOfferSettlement\(\{/);
  assert.match(implementation, /sides:\s*\[/);
  assert.match(implementation, /currencyDeliveries:\s*\[/);
  assert.match(implementation, /ensureTradeOfferSideCanBeDelivered/);
  assert.match(implementation, /deliverTradeOfferItemsToActor/);
  assert.match(implementation, /getCompletedTradeClaimTarget/);
  assert.match(implementation, /dropItemDataForActor/);
  assert.doesNotMatch(implementation, /LOCKED_STORAGE_PARENT_ID|lockedStorage/);
});

test("trade settlement planner only moves currency and has no Item delivery escape hatch", () => {
  const planStart = searchInventorySource.indexOf("function planTradeOfferSettlement");
  const executeStart = searchInventorySource.indexOf("async function executeTradeOfferSettlement", planStart);
  const executeEnd = searchInventorySource.indexOf("async function executeTradeOfferItemConsumption", executeStart);
  assert.ok(planStart >= 0 && executeStart > planStart && executeEnd > executeStart);

  const planner = searchInventorySource.slice(planStart, executeStart);
  const executor = searchInventorySource.slice(executeStart, executeEnd);
  assert.match(planner, /currencyDeliveries/);
  assert.doesNotMatch(planner, /planTradeOfferLockedStorageDelivery|offer\?\.items|system\.locked/);
  assert.doesNotMatch(searchInventorySource, /function planTradeOfferLockedStorageDelivery/);
  assert.match(executor, /executeInventoryMutation\(plans/);
  assert.match(executor, /validateLoad:\s*false/);
  assert.equal((executor.match(/executeInventoryMutation\(/g) ?? []).length, 1);
});

test("personal trade retry is idempotent and its ledger marker shares the settlement batch", () => {
  const start = searchInventorySource.indexOf("async function performPersonalTradeComplete");
  const end = searchInventorySource.indexOf("\nfunction normalizePersonalTradeOperationId", start);
  assert.ok(start >= 0 && end > start);
  const implementation = searchInventorySource.slice(start, end);
  assert.match(implementation, /getPersonalTradeSettlementRecord/);
  assert.match(implementation, /idempotent:\s*true/);
  assert.match(implementation, /actorMutations:\s*\[\{/);
  assert.match(implementation, /createPersonalTradeSettlementLedgerUpdate/);
});

test("completed trade claims and deposits require a live session", () => {
  for (const [functionName, message] of [
    ["performCompletedTradeEntryClaim", "claims require an active server trade session"],
    ["performCompletedTradeBatchClaim", "claims require an active server trade session"],
    ["performCompletedTradeHubDeposit", "deposits require an active server trade session"]
  ]) {
    const start = searchInventorySource.indexOf(`async function ${functionName}`);
    const nextFunction = searchInventorySource.indexOf("\nasync function ", start + 1);
    assert.ok(start >= 0 && nextFunction > start, `${functionName} source was not found`);
    const implementation = searchInventorySource.slice(start, nextFunction);
    assert.match(implementation, new RegExp(message));
    assert.doesNotMatch(implementation, /session\?\.offers \?\? payload\.offers/);
  }
  const depositStart = searchInventorySource.indexOf("async function performCompletedTradeHubDeposit");
  const depositEnd = searchInventorySource.indexOf("\nfunction validateTradeOfferSide", depositStart);
  const deposit = searchInventorySource.slice(depositStart, depositEnd);
  assert.match(deposit, /consumeTradeOfferSides/);
  assert.match(deposit, /offers\[side\]\.items\.push\(depositedEntry\)/);
});

test("unclaimed Purchased remainders go to ordinary inventory or the floor", () => {
  const start = searchInventorySource.indexOf("async function reclaimCompletedTradeSessionRemainders");
  const end = searchInventorySource.indexOf("\nfunction getCompletedTradeRemainderReturnActor", start);
  assert.ok(start >= 0 && end > start);
  const implementation = searchInventorySource.slice(start, end);
  assert.match(implementation, /ensureTradeOfferSideCanBeDelivered/);
  assert.match(implementation, /deliverTradeOfferItemsToActor/);
  assert.match(implementation, /reduceTradeOfferEntryQuantity/);
  assert.doesNotMatch(implementation, /LOCKED_STORAGE_PARENT_ID|executeTradeOfferSettlement/);
});

test("claim-all asks the server for a fresh placement after every claimed Item", () => {
  const start = searchInventorySource.indexOf("async #claimCompletedTradeOfferSide");
  const end = searchInventorySource.indexOf("\n  async #onTradeCurrencyClick", start);
  assert.ok(start >= 0 && end > start);
  const implementation = searchInventorySource.slice(start, end);
  assert.match(implementation, /autoTargetParent:\s*entry\.kind === "item"/);
  assert.doesNotMatch(implementation, /getCompletedTradeClaimTarget/);
});

test("trade consumption batches Item and currency changes through the shared executor", () => {
  const planStart = searchInventorySource.indexOf("function planTradeOfferItemConsumption");
  const consumeStart = searchInventorySource.indexOf("async function consumeTradeOfferSides", planStart);
  const consumeEnd = searchInventorySource.indexOf("async function consumeTradeOfferSide", consumeStart + 1);
  assert.ok(planStart >= 0 && consumeStart > planStart && consumeEnd > consumeStart);

  const planner = searchInventorySource.slice(planStart, consumeStart);
  const consumer = searchInventorySource.slice(consumeStart, consumeEnd);
  assert.doesNotMatch(planner, /sequentialOps|removeTransferredVirtualStackQuantity\(/);
  assert.match(planner, /requestedByStackIndex/);
  assert.match(consumer, /plan\.actorUpdates\.push\(updateData\)/);
  assert.match(consumer, /executeTradeOfferItemConsumption\(Array\.from\(plansByActor\.values\(\)\)/);
});

test("aggregate virtual trade removal projects stack parts instead of quantity alone", () => {
  const start = searchInventorySource.indexOf("function planTradeOfferItemConsumption");
  const end = searchInventorySource.indexOf("function assertTradeItemGroupsDoNotOverlap", start);
  assert.ok(start >= 0 && end > start, "trade consumption planner source was not found");

  const implementation = searchInventorySource.slice(start, end);
  const aggregateStart = implementation.indexOf("if (aggregateRequested > 0)");
  const aggregateEnd = implementation.indexOf("const remainingQuantity", aggregateStart);
  assert.ok(aggregateStart >= 0 && aggregateEnd > aggregateStart, "aggregate virtual removal branch was not found");

  const aggregateBranch = implementation.slice(aggregateStart, aggregateEnd);
  assert.match(
    aggregateBranch,
    /createTransferredItemRemovalPlan\(\s*projectedItem,\s*aggregateRequested,\s*\{\s*stackIndex:\s*0,\s*virtual:\s*true\s*\}\s*\)/
  );
  assert.doesNotMatch(aggregateBranch, /virtual:\s*false/);
});

test("paid transfer and stacking include currency updates in the Item mutation", () => {
  for (const functionName of [
    "performSearchInventoryTransfer",
    "performSearchInventoryStack"
  ]) {
    const start = searchInventorySource.indexOf(`async function ${functionName}`);
    const nextFunction = searchInventorySource.indexOf("\nasync function ", start + 1);
    assert.ok(start >= 0 && nextFunction > start, `${functionName} source was not found`);
    const implementation = searchInventorySource.slice(start, nextFunction);
    assert.match(implementation, /createTradeItemPaymentMutationPlans\(tradePayment\)/);
    assert.match(implementation, /mutationPlans:\s*tradeMutationPlans/);
    assert.doesNotMatch(implementation, /applyTradeItemPayment\(tradePayment\)/);
  }

  const transferStart = searchInventorySource.indexOf("export async function transferItemBetweenActors");
  const transferEnd = searchInventorySource.indexOf("async function moveOwnedItemToActorPlacement", transferStart);
  const transferImplementation = searchInventorySource.slice(transferStart, transferEnd);
  assert.match(transferImplementation, /mutationPlans = \[\]/);
  assert.match(transferImplementation, /insertExternalItemIntoActorInventory[\s\S]*?mutationPlans/);

  const stackStart = searchInventorySource.indexOf("export async function stackActorInventoryItem");
  const stackEnd = searchInventorySource.indexOf("export function canStackItems", stackStart);
  const stackImplementation = searchInventorySource.slice(stackStart, stackEnd);
  assert.match(stackImplementation, /mutationPlans = \[\]/);
  assert.match(stackImplementation, /\.\.\.mutationPlans/);
});

test("currency-only transfers use the recoverable inventory transaction", () => {
  const start = searchInventorySource.indexOf("async function performSearchCurrencyTransfer");
  const end = searchInventorySource.indexOf("async function performTradeComplete", start);
  assert.ok(start >= 0 && end > start);
  const implementation = searchInventorySource.slice(start, end);
  assert.match(implementation, /executeInventoryMutation\(\[/);
  assert.match(implementation, /actorUpdate:/);
  assert.doesNotMatch(implementation, /sourceActor\.update\(|targetActor\.update\(/);
});
