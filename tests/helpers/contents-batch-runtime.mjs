import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

// Run the production transfer functions without constructing a Foundry window.
export async function createContentsBatchRuntime(overrides = {}) {
  const url = new URL("../../src/apps/search-inventory.mjs", import.meta.url);
  const source = readFileSync(url, "utf8");
  const bindings = { ...overrides };
  for (const path of ["../utils/inventory-containers.mjs", "../utils/actor-display-data.mjs",
    "../settings/accessors.mjs", "../utils/numbers.mjs", "../utils/item-functions.mjs",
    "../utils/construct-parts.mjs", "../races/natural-items.mjs", "../utils/craft-item-source.mjs",
    "../inventory/stacking.mjs", "../inventory/mutation.mjs", "../inventory/contents-batch.mjs",
    "../inventory/contents-transfer.mjs", "../items/dropped-items.mjs", "../constants.mjs"]) {
    Object.assign(bindings, await import(new URL(path, url)));
  }
  Object.assign(bindings, overrides);
  const implementations = [...source.matchAll(/^(?:export )?((?:async )?function (\w+)\([^]*?\n\}(?=\r?\n|$))/gm)];
  for (const [, , name] of implementations) delete bindings[name];
  for (const name of ["transferItemBetweenActors", "requestInventoryContentsTransfer", "performInventoryContentsTransfer", "addContentsToTradeOffer"]) {
    assert.ok(implementations.some(entry => entry[2] === name), `Missing production function ${name}`);
  }
  return new Function(...Object.keys(bindings), `
    const TRADE_OFFER_SIDES = ["searcher", "searched"], TRADE_OFFER_DEFAULT_COLUMNS = 14;
    const SEARCH_INVENTORY_MODE_TRADE = "trade", SEARCH_INVENTORY_MODE_SEARCH = "search";
    const SEARCH_INVENTORY_TRADE_KIND_PERSONAL = "personal", SEARCH_INVENTORY_TRADE_KIND_REGULAR = "regular";
    const SEARCH_INVENTORY_SOCKET = "system.fallout-maw", SEARCH_INVENTORY_SOCKET_SCOPE = "fallout-maw.searchInventory";
    const SEARCH_INVENTORY_SOCKET_TIMEOUT = 10000;
    const SEARCH_AUDIT_MAX_AGE_MS = 30 * 60 * 1000, SEARCH_NOTIFICATION_FALLBACK_ICON = "bag.svg";
    const searchInventoryOperationQueues = new Map(), pendingSearchInventorySocketRequests = new Map();
    const activeSearchInventoryTradeSessions = new Map(), activeSearchInventoryAudits = new Map();
    ${implementations.map(entry => entry[1]).join("\n")}
    return { transferItemBetweenActors, requestInventoryContentsTransfer, performInventoryContentsTransfer,
      addContentsToTradeOffer, performTradeSessionAction, handleSearchInventorySocketMessage,
      activeSearchInventoryTradeSessions, pendingSearchInventorySocketRequests };
  `)(...Object.values(bindings));
}
