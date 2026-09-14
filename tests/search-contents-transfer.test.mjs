import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

globalThis.foundry = {
  applications: { api: { DialogV2: class {} }, ux: { FormDataExtended: class {} }, handlebars: { renderTemplate: async () => "" } },
  utils: { deepClone: structuredClone, mergeObject: (a, b) => Object.assign(a, b) }
};

// Execute the application's real transfer options with its real import bindings.
// The rest of the Foundry window is replaced with the small host below.
const sourceUrl = new URL("../src/apps/search-inventory.mjs", import.meta.url);
const source = await readFile(sourceUrl, "utf8");
const inventoryImport = source.match(/import\s*\{[^}]+\}\s*from "\.\.\/utils\/inventory-containers\.mjs";/s)[0]
  .replace("../utils/inventory-containers.mjs", new URL("../utils/inventory-containers.mjs", sourceUrl).href);
const start = source.indexOf("\n  #getContentsTransferOptions(");
const end = source.indexOf("\n  #resolveSearchItemRotation(", start);
assert.ok(start >= 0 && end > start);
const factory = source.slice(start, end)
  .replace("#getContentsTransferOptions", "export function createOptions")
  .replaceAll("this.#", "this.");
const { createOptions } = await import(`data:text/javascript;base64,${Buffer.from(inventoryImport + factory).toString("base64")}`);

function context({ trade = false, interact = true } = {}) {
  const actors = [{ uuid: "Actor.a" }, { uuid: "Actor.b" }];
  const host = {
    rendered: true, bulkTransferInProgress: false, tradeOffers: { completed: false },
    canInteract: () => interact, getActorByUuid: uuid => actors.find(actor => actor.uuid === uuid),
    isTradeMode: () => trade, getTradeSideForActor: uuid => uuid,
    canManageTradeOfferSide: () => true
  };
  return { options: createOptions.call(host), actors, host };
}

test("search transfer uses the window mutation lock without revoking its own transfer permission", () => {
  const { options, actors, host } = context();
  let cancelled = 0, captured = 0, depth = 0;
  host.renderRefresh = { cancel: () => cancelled++ };
  host.captureScrollPositions = () => captured++;
  host.beginInventoryMutation = () => depth++;
  host.endInventoryMutation = () => depth--;
  assert.equal(options.application, host);
  options.beforeTransfer();
  assert.equal(depth, 1);
  assert.equal(captured, 1);
  assert.equal(options.canUse({ actor: actors[0], parentId: "" }), true);
  options.afterTransfer();
  assert.equal(depth, 0);
  assert.equal(cancelled, 2, "pending refresh callbacks are cancelled at both batch boundaries");
});

test("search enables inventory and container sources and destinations on both actors without throwing", () => {
  const { options, actors } = context();
  const zones = actors.flatMap(actor => ["", "backpack"].map(parentId => ({ actor, parentId, kind: "inventory" })));
  for (const source of zones) {
    assert.equal(options.canUse(source), true);
    for (const target of zones) assert.equal(options.canTransfer(source, target), true);
  }
  for (const parentId of ["__lockedStorage", "__butcheringStorage"]) {
    assert.equal(options.canUse({ actor: actors[0], parentId }), false);
  }
});

test("transfer options keep search permissions and trade side restrictions", () => {
  const denied = context({ interact: false });
  assert.equal(denied.options.canUse({ actor: denied.actors[0], parentId: "" }), false);
  const { options, actors } = context({ trade: true });
  const source = { actor: actors[0], parentId: "", kind: "inventory" };
  assert.equal(options.canTransfer(source, { ...source, kind: "offer" }), true);
  assert.equal(options.canTransfer(source, { ...source, actor: actors[1], kind: "offer" }), false);
});
