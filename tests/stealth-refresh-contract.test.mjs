import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const controllerSource = await readFile(new URL("../src/stealth/controller.mjs", import.meta.url), "utf8");
const facadeSource = await readFile(new URL("../src/stealth/index.mjs", import.meta.url), "utf8");

test("render-frame perception hooks are guarded by a logical V14 signature", () => {
  assert.match(controllerSource, /Hooks\.on\(["']sightRefresh["'],\s*onRuntimePerceptionRefresh\)/);
  assert.match(controllerSource, /Hooks\.on\(["']lightingRefresh["'],\s*onRuntimePerceptionRefresh\)/);
  assert.match(controllerSource, /source\.updateId/);
  assert.match(controllerSource, /scene\.getSurfaces\(\{ type \}\)/);
  assert.match(controllerSource, /darknessLevelMeshes/);
  assert.match(controllerSource, /RUNTIME_PERCEPTION_UI_SETTLE_MS/);
});

test("document hooks remain the immediate path for static scene geometry", () => {
  for (const hook of [
    "createRegion",
    "updateRegion",
    "deleteRegion",
    "createRegionBehavior",
    "updateRegionBehavior",
    "deleteRegionBehavior"
  ]) {
    assert.match(controllerSource, new RegExp(`Hooks\\.on\\(["']${hook}["'],\\s*onSceneGeometryChanged\\)`));
  }
});

test("moving lights get a final cache invalidation and repeated targeting clicks are absorbed", () => {
  assert.match(controllerSource, /function onTokenCreated[\s\S]*?const emitsLight = tokenEmitsLight[\s\S]*?invalidateLightingAnalysisCache\(\);/);
  assert.match(controllerSource, /function onTokenDeleted[\s\S]*?allWindows: emittedLight/);
  assert.match(controllerSource, /runAfterTokenAnimation\(token, \(\) => \{[\s\S]*?invalidateStealthDetectionCache\(\);[\s\S]*?invalidateLightingAnalysisCache\(\);/);
  assert.match(controllerSource, /const mode = targetMode;[\s\S]*?event\.preventDefault\(\);[\s\S]*?event\.stopImmediatePropagation[\s\S]*?if \(mode\.checking\) return;/);
});

test("public stealth entrypoint stays a small dependency facade", () => {
  assert.doesNotMatch(facadeSource, /weapon-attack-controller|reaction-hub|ApplicationV2|Hooks\.on/);
  assert.ok(facadeSource.trimEnd().split(/\r?\n/).length <= 20);
});
