import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("open travel HUD scopes and debounces Actor-driven refreshes", async () => {
  const source = await readFile(new URL("../src/apps/travel-group-hud.mjs", import.meta.url), "utf8");
  const scheduleStart = source.indexOf("function scheduleOpenTravelGroupHudRender");
  const scheduleEnd = source.indexOf("function closeTravelGroupHud", scheduleStart);
  const scheduleSource = source.slice(scheduleStart, scheduleEnd);
  const contextStart = source.indexOf("  async _prepareContext(options)");
  const contextEnd = source.indexOf("  _attachFrameListeners()", contextStart);
  const contextSource = source.slice(contextStart, contextEnd);

  assert.match(scheduleSource, /travelGroupHud\.tracksActor\(actor\)/);
  assert.match(scheduleSource, /refreshHud\?\.\(\)/);
  assert.doesNotMatch(scheduleSource, /\.render\(/);
  assert.match(source, /#trackedActorUuids = new Set\(\)/);
  assert.match(contextSource, /trackedActorUuids\.add/);
  assert.match(contextSource, /this\.#trackedActorUuids = trackedActorUuids/);
});
