import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseLimbPopoverRows } from "../src/utils/limb-popover.mjs";

const [actorSheetSource, hudSource, indicatorsTemplate] = await Promise.all([
  readFile(new URL("../src/sheets/actor-sheet.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/apps/token-action-hud.mjs", import.meta.url), "utf8"),
  readFile(new URL("../templates/actor/parts/indicators-tab.hbs", import.meta.url), "utf8")
]);

test("limb popover rows support both HUD objects and actor-sheet tuples", () => {
  assert.deepEqual(parseLimbPopoverRows({
    dataset: {
      popoverRows: JSON.stringify([
        { label: "Состояние", value: "25 / 50" },
        ["Протез", "Бионическая рука"]
      ])
    }
  }), [
    { label: "Состояние", value: "25 / 50" },
    { label: "Протез", value: "Бионическая рука" }
  ]);

  assert.deepEqual(parseLimbPopoverRows({
    dataset: { popoverRows: "{not-json" }
  }), []);
});

test("actor limb left click immediately rerenders mitigation for the selected limb", () => {
  const clickHandler = actorSheetSource.slice(
    actorSheetSource.indexOf("  #onLimbControlClick(event) {"),
    actorSheetSource.indexOf("  #onLimbControlContextMenu(event) {")
  );

  assert.match(clickHandler, /const changed = limbKey !== this\.\#activeLimbKey;/);
  assert.match(clickHandler, /this\.\#activeLimbKey = limbKey;/);
  assert.match(clickHandler, /if \(changed\) void this\.render\(\{ parts: \["indicators"\] \}\);/);
  assert.doesNotMatch(clickHandler, /openLimbDamageDialog/);
  assert.doesNotMatch(clickHandler, /game\.user\?\.isGM/);

  assert.match(actorSheetSource, /actor\.system\.damageResistances\?\.\[activeLimbKey\]/);
  assert.match(actorSheetSource, /actor\.system\.damageDefenses\?\.\[activeLimbKey\]/);
});

test("actor limb right click opens management for the GM only", () => {
  const contextMenuHandler = actorSheetSource.slice(
    actorSheetSource.indexOf("  #onLimbControlContextMenu(event) {"),
    actorSheetSource.indexOf("  static #onCreateResearch", actorSheetSource.indexOf("  #onLimbControlContextMenu(event) {"))
  );

  assert.match(actorSheetSource, /addEventListener\("contextmenu", event => this\.\#onLimbControlContextMenu\(event\), \{ capture: true \}\)/);
  assert.match(contextMenuHandler, /if \(!game\.user\?\.isGM\) return;/);
  assert.match(contextMenuHandler, /void openLimbDamageDialog\(this\.actor, limbKey\);/);
  assert.doesNotMatch(contextMenuHandler, /this\.\#activeLimbKey = limbKey/);
});

test("actor sheet and HUD share the same limb hover popover contract", () => {
  assert.match(actorSheetSource, /new LimbPopoverController\(\)/);
  assert.match(hudSource, /new LimbPopoverController\(\)/);
  assert.match(indicatorsTemplate, /data-limb-popover-root/);
  assert.match(indicatorsTemplate, /data-limb-popover/);
  assert.match(indicatorsTemplate, /data-popover-rows="\{\{popoverRowsJson\}\}"/);
  assert.match(indicatorsTemplate, /fallout-maw-actor-limb-silhouette-part\{\{#if active\}\} active/);
});
