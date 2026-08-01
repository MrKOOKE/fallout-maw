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

test("search immediately requests a separate GM start card and closes through one summary request", () => {
  const opener = sliceBetween(
    "function openSearchInventoryWindowNow",
    "export async function requestTradeInventoryWindow"
  );
  const close = sliceBetween(
    "async _onClose(options)",
    "#getFullscreenPosition"
  );

  assert.match(opener, /requestSearchAuditStart\(\{/);
  assert.equal((opener.match(/requestSearchAuditStart\(/g) ?? []).length, 1);
  assert.doesNotMatch(opener, /ChatMessage\.create/);
  assert.match(close, /searchAuditSessionId:\s*this\.#searchAuditSessionId/);
  assert.match(close, /requestSearchAuditCompletion\(searchAuditPayload\)/);
  assert.equal((close.match(/requestSearchAuditCompletion\(/g) ?? []).length, 1);
});

test("every search operation carries one stable audit session id", () => {
  const fields = sliceBetween(
    "class SearchInventoryApplication",
    "static DEFAULT_OPTIONS"
  );
  const actors = sliceBetween(
    "setActors(searcherActor, searchedActor",
    "matchesTradeSession"
  );
  const payload = sliceBetween(
    "#prepareSearchOperationPayload",
    "#prepareTradeActorSelector"
  );

  assert.match(fields, /#searchAuditSessionId = ""/);
  assert.match(actors, /foundry\.utils\.randomID\(\)/);
  assert.match(payload, /searchAuditSessionId:\s*this\.#searchAuditSessionId/);
});

test("successful Item, stack, and currency moves accumulate instead of creating per-Item cards", () => {
  for (const [functionName, endText] of [
    ["performSearchInventoryTransfer", "async function performSearchInventorySplit"],
    ["performSearchInventoryStack", "async function performSearchCurrencyTransfer"],
    ["performSearchCurrencyTransfer", "async function performTradeComplete"]
  ]) {
    const implementation = sliceBetween(`async function ${functionName}`, endText);
    assert.match(implementation, /recordSearchAuditTransfer\(\{/);
    assert.doesNotMatch(implementation, /ChatMessage\.create|createGMSearchSummary/);
  }

  const itemTransfer = sliceBetween(
    "async function performSearchInventoryTransfer",
    "async function performSearchInventorySplit"
  );
  assert.match(itemTransfer, /const movedQuantity = Math\.max\(/);
  assert.match(itemTransfer, /quantity:\s*movedQuantity/);

  const currency = sliceBetween(
    "async function performSearchCurrencyTransfer",
    "async function performTradeComplete"
  );
  assert.match(currency, /quantity:\s*amount/);
});

test("audit separates living-target takes from deposits and merges matching rows", () => {
  const audit = sliceBetween(
    "function isLivingSearchTarget",
    "async function requestSearchAuditCompletion"
  );

  assert.match(audit, /!isDroppedItemsActor\(actor\)/);
  assert.match(audit, /!isActorDeadForButchering\(actor\)/);
  assert.match(audit, /isTradePayload\(payload\)/);
  assert.match(audit, /sourceActor\.uuid === searchedActor\.uuid/);
  assert.match(audit, /targetActor\.uuid === searcherActor\.uuid/);
  assert.match(audit, /sourceActor\.uuid === searcherActor\.uuid/);
  assert.match(audit, /targetActor\.uuid === searchedActor\.uuid/);
  assert.match(audit, /return isLivingSearchTarget\(searchedActor\) \? "taken" : ""/);
  assert.match(audit, /return "placed"/);
  assert.match(audit, /takenEntries:\s*new Map\(\)/);
  assert.match(audit, /placedEntries:\s*new Map\(\)/);
  assert.match(audit, /activeSearchInventoryAudits\.get\(auditKey\)/);
  assert.match(audit, /direction === "placed" \? audit\.placedEntries : audit\.takenEntries/);
  assert.match(audit, /entryMap\.set\(entryKey/);
  assert.match(audit, /current\?\.quantity/);
});

test("only a GM authors the immediate start card and the single close summary", () => {
  const startRequest = sliceBetween(
    "async function requestSearchAuditStart",
    "async function performSearchAuditStart"
  );
  const start = sliceBetween(
    "async function performSearchAuditStart",
    "async function requestSearchAuditCompletion"
  );
  const request = sliceBetween(
    "async function requestSearchAuditCompletion",
    "async function performSearchAuditCompletion"
  );
  const completion = sliceBetween(
    "async function performSearchAuditCompletion",
    "async function createGMSearchSummary"
  );
  const creator = sliceBetween(
    "async function createGMSearchNotification",
    "function renderGMSearchStartContent"
  );
  const socket = sliceBetween(
    "async function handleSearchInventorySocketMessage",
    "async function handleTradeInviteSocketMessage"
  );

  assert.match(startRequest, /requestSearchInventorySocket\("startSearchAudit"/);
  assert.match(start, /createGMSearchStart\(\{/);
  assert.match(request, /requestSearchInventorySocket\("completeSearchAudit"/);
  assert.match(completion, /createGMSearchSummary\(\{/);
  assert.equal((completion.match(/createGMSearchSummary\(/g) ?? []).length, 1);
  assert.match(creator, /if \(!game\.user\?\.isGM\) return null/);
  assert.match(creator, /ChatMessage\.getWhisperRecipients\("GM"\)/);
  assert.match(creator, /ChatMessage\.create\(\{/);
  assert.match(socket, /message\.action === "startSearchAudit"/);
  assert.match(socket, /message\.action === "completeSearchAudit"/);
});

test("start and summary layouts are narrow-chat friendly and show taken plus placed sections", () => {
  const renderer = sliceBetween(
    "function renderGMSearchStartContent",
    "function getSearchAuditKey"
  );
  const cardStart = styles.indexOf(".fallout-maw-chat-card.fallout-maw-search-notification-card {");
  assert.ok(cardStart >= 0);
  const cardStyles = styles.slice(cardStart);

  assert.match(renderer, /Обыск начат/);
  assert.match(renderer, /Итоги обыска/);
  assert.match(renderer, /Забрано у цели/);
  assert.match(renderer, /Положено цели/);
  assert.match(renderer, /fallout-maw-search-notification-loot-row/);
  assert.match(renderer, /Ничего не забрано/);
  assert.match(renderer, /Ничего не положено/);
  assert.match(cardStyles, /--fallout-maw-search-note-surface:\s*#f6efdf/);
  assert.match(cardStyles, /\.fallout-maw-search-notification-card\.is-start/);
  assert.match(cardStyles, /\.fallout-maw-search-notification-loot\.is-placed/);
  assert.match(cardStyles, /\.fallout-maw-search-notification-route[\s\S]*?display:\s*grid/);
  assert.match(cardStyles, /\.fallout-maw-search-notification-actor strong[\s\S]*?overflow-wrap:\s*anywhere/);
  assert.match(cardStyles, /\.fallout-maw-search-notification-loot-row[\s\S]*?grid-template-columns:\s*2rem minmax\(0, 1fr\) auto/);
  assert.doesNotMatch(cardStyles, /repeating-linear-gradient|search-notification-chip|white-space:\s*nowrap[\s\S]*search-notification-actor/);
});
