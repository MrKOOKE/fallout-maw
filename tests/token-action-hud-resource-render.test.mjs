import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [source, rootTemplate, resourceTemplate, movementSource] = await Promise.all([
  readFile(new URL("../src/apps/token-action-hud.mjs", import.meta.url), "utf8"),
  readFile(new URL("../templates/actor/token-action-hud.hbs", import.meta.url), "utf8"),
  readFile(new URL("../templates/actor/parts/token-action-hud-resources.hbs", import.meta.url), "utf8"),
  readFile(new URL("../src/combat/movement-resources.mjs", import.meta.url), "utf8")
]);

test("combat movement uses the native HUD resource part without delaying resource writes", () => {
  const actorUpdateHook = source.slice(
    source.indexOf("function scheduleTokenActionHudRefreshForActor"),
    source.indexOf("function scheduleTokenActionHudRefreshForItem")
  );

  assert.match(source, /resources:\s*\{\s*template:\s*TEMPLATES\.tokenActionHudResources/);
  assert.match(actorUpdateHook, /options\?\.\[COMBAT_MOVEMENT_RESOURCE_UPDATE_OPTION\]/);
  assert.match(actorUpdateHook, /tokenActionHud\.render\(\{ parts: \["resources"\] \}\)/);
  assert.match(actorUpdateHook, /return;\s*\}\s*scheduleTokenActionHudRefresh\(\)/);
  assert.match(rootTemplate, /data-application-part="resources"/);
  assert.match(resourceTemplate, /data-token-hud-meter-section="resources"/);
  assert.match(movementSource, /prepareDirectCombatActionPointSpend\(actor, actionSpend\)/);
  assert.match(movementSource, /Object\.assign\(updates, directActionSpend\.updates\)/);
  assert.match(movementSource, /actionSpend && !directActionSpend/);
  assert.doesNotMatch(movementSource, /setTimeout|movementResourceSpendingBatches|waitForMovementBatchCompletion/);
});

test("resource-only HUD renders skip full weapon and inventory context preparation", () => {
  const prepareContext = source.slice(
    source.indexOf("  async _prepareContext(options) {"),
    source.indexOf("  async _onRender(context, options) {")
  );
  const partialReturn = prepareContext.indexOf('options.parts?.length === 1 && options.parts[0] === "resources"');
  const requestIndex = prepareContext.indexOf("createTokenActionHudRequestIndex(actor");

  assert.ok(partialReturn >= 0);
  assert.ok(requestIndex > partialReturn);
  assert.match(prepareContext.slice(partialReturn, requestIndex), /resources: prepareResourceEntries\(actor\)/);
});
