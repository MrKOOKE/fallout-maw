import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  getCombatVisualizationLayer,
  registerAttackAnimationSocket
} from "../src/combat/attack-animations.mjs";

const source = await readFile(
  new URL("../src/combat/weapon-attack-controller.mjs", import.meta.url),
  "utf8"
);
const animationSource = await readFile(
  new URL("../src/combat/attack-animations.mjs", import.meta.url),
  "utf8"
);

function sliceBetween(startText, endText, fromIndex = 0) {
  const start = source.indexOf(startText, fromIndex);
  assert.notEqual(start, -1, `Missing start marker: ${startText}`);
  const end = source.indexOf(endText, start + startText.length);
  assert.notEqual(end, -1, `Missing end marker: ${endText}`);
  return source.slice(start, end);
}

function sliceSection(value, startText, endText, fromIndex = 0) {
  const start = value.indexOf(startText, fromIndex);
  assert.notEqual(start, -1, `Missing section start: ${startText}`);
  const end = value.indexOf(endText, start + startText.length);
  assert.notEqual(end, -1, `Missing section end: ${endText}`);
  return value.slice(start, end);
}

test("combat rays use one lifecycle-owned interface layer above tokens and below controls", () => {
  const previousCanvas = globalThis.canvas;
  const previousPIXI = globalThis.PIXI;
  const previousGame = globalThis.game;
  const previousHooks = globalThis.Hooks;
  const hookCallbacks = new Map();
  class FakeContainer {
    constructor() {
      this.children = [];
      this.parent = null;
      this.destroyed = false;
    }

    addChild(child) {
      child.parent = this;
      this.children.push(child);
      return child;
    }

    destroy({ children = false } = {}) {
      if (children) {
        for (const child of [...this.children]) child.destroy?.({ children: true });
      }
      if (this.parent) {
        this.parent.children = this.parent.children.filter(child => child !== this);
      }
      this.children = [];
      this.destroyed = true;
      this.parent = null;
    }
  }
  const interfaceLayer = new FakeContainer();
  const controls = { getZIndex: () => 1000 };
  globalThis.PIXI = { ...(previousPIXI ?? {}), Container: FakeContainer };
  globalThis.canvas = {
    ready: true,
    controls,
    interface: interfaceLayer,
    scene: { id: "scene-a" },
    level: { id: "level-a" }
  };
  globalThis.game = { socket: { on: () => undefined } };
  globalThis.Hooks = {
    on: (hook, callback) => hookCallbacks.set(hook, callback)
  };

  try {
    registerAttackAnimationSocket();
    const layer = getCombatVisualizationLayer();
    assert.equal(layer.parent, interfaceLayer);
    assert.equal(layer.zIndex, 999);
    assert.equal(layer.eventMode, "none");
    assert.equal(layer.interactive, false);
    assert.equal(layer.interactiveChildren, false);
    assert.equal(layer.sortableChildren, false);
    assert.equal(getCombatVisualizationLayer(), layer);
    assert.equal(interfaceLayer.children.length, 1);
    hookCallbacks.get("canvasTearDown")?.();
    layer.destroy({ children: true });
    const replacement = getCombatVisualizationLayer();
    assert.notEqual(replacement, layer);
    assert.equal(replacement.parent, interfaceLayer);
    assert.equal(interfaceLayer.children.length, 1);
    replacement.destroy({ children: true });
  } finally {
    if (previousCanvas === undefined) delete globalThis.canvas;
    else globalThis.canvas = previousCanvas;
    if (previousPIXI === undefined) delete globalThis.PIXI;
    else globalThis.PIXI = previousPIXI;
    if (previousGame === undefined) delete globalThis.game;
    else globalThis.game = previousGame;
    if (previousHooks === undefined) delete globalThis.Hooks;
    else globalThis.Hooks = previousHooks;
  }

  assert.equal((source.match(/getCombatVisualizationLayer\(\)\.addChild/g) ?? []).length, 4);
  assert.equal((source.match(/getLocalPosition\(getCombatVisualizationLayer\(\)\)/g) ?? []).length, 2);
  assert.equal((animationSource.match(/const layer = getCombatVisualizationLayer\(\)/g) ?? []).length, 2);
  assert.doesNotMatch(source, /function getAttackPreviewLayer/);
  assert.doesNotMatch(animationSource, /_rulerPaths/);
  assert.match(animationSource, /Hooks\.on\("canvasTearDown", releaseCombatVisualizationLayer\)/);
  assert.match(source, /Hooks\.on\("canvasTearDown", clearWeaponAttackCanvasState\)/);
  assert.match(
    source,
    /completeProcessingCycle\([^)]*\) \{\s*if \(this\.destroyed\) \{\s*this\.flushPendingTerminalAttackOutcomes\(\);\s*return true;\s*\}/
  );
  assert.match(source, /suppressAttackPreviewBroadcast:\s*Boolean\(authorityContext\)/);
  assert.match(source, /headlessExecution:\s*Boolean\(authorityContext\)/);
  assert.match(source, /levelId:\s*canvas\.level\?\.id \?\? ""/);
  assert.match(source, /String\(payload\.levelId \?\? ""\) !== String\(canvas\.level\?\.id \?\? ""\)/);
  assert.match(animationSource, /const activeCombatVisuals = new Set\(\)/);
  assert.match(animationSource, /destroyOwnedAnimationBaseTexture\(texture, ownsBaseTexture\)/);
  assert.match(animationSource, /window\.clearTimeout\(timeoutId\)/);
  assert.match(animationSource, /payload\.senderUserId !== authenticatedSenderUserId/);
  assert.match(animationSource, /String\(levelId \?\? ""\) === current\.levelId/);
});

test("ordinary and commanded mouse movement queue one latest-frame refresh", () => {
  const commanded = sliceBetween(
    "class CommandedWeaponAttackController",
    "function serializeCommandedAttackSelection"
  );
  const ordinary = sliceBetween(
    "class WeaponAttackController",
    "function normalizeAttackOriginOverride"
  );

  for (const controller of [commanded, ordinary]) {
    const onMove = sliceSection(
      controller,
      "\n  onMove(event) {",
      "\n  onPointerDown(event) {"
    );
    assert.match(onMove, /previewFrameScheduler\.request\(\)/);
    assert.doesNotMatch(onMove, /this\.refresh\(/);
    assert.match(controller, /previewFrameScheduler\.destroy\(\)/);
  }
});

test("commanded and remote marker previews avoid redundant text rebuilds", () => {
  const commanded = sliceBetween(
    "class CommandedWeaponAttackController",
    "function serializeCommandedAttackSelection"
  );
  const remote = sliceBetween(
    "function updateRemoteAttackPreview",
    "function removeRemoteAttackPreview"
  );

  assert.match(commanded, /lastTargetMarkerRenderState:\s*null/);
  assert.match(commanded, /isSameTargetMarkerRenderState\(markerState, entry\.lastTargetMarkerRenderState\)/);
  assert.match(commanded, /entry\.lastTargetMarkerRenderState = null/);
  assert.doesNotMatch(remote, /clearTargetMarkerLayer\(preview\.targetMarkers\)/);
});

test("pointer confirmation flushes the newest frame before attack resolution", () => {
  const ordinary = sliceBetween(
    "class WeaponAttackController",
    "function normalizeAttackOriginOverride"
  );
  const updatePointer = sliceSection(
    ordinary,
    "\n  updatePointerFromClientEvent(event) {",
    "\n  unlockAimedTarget() {"
  );

  assert.match(updatePointer, /previewFrameScheduler\.request\(\)/);
  assert.match(updatePointer, /previewFrameScheduler\.flush\(\)/);
});

test("both interactive burst previews explicitly use the bounded preview policy", () => {
  const previewCalls = [...source.matchAll(
    /buildBurstTargetRanges\([\s\S]*?\{\s*purpose:\s*"preview"\s*\}\s*\)/g
  )];
  assert.ok(previewCalls.length >= 2);
});

test("burst resolution computes one exact distribution and reuses it", () => {
  const burst = sliceBetween(
    "async performBurstAttack",
    "onAimedConfirm"
  );

  assert.match(
    burst,
    /const exactDistribution = getBurstTargetHitDistribution\([\s\S]*?purpose:\s*"resolution"/
  );
  assert.match(
    burst,
    /buildBurstTargetRanges\([\s\S]*?distribution:\s*exactDistribution/
  );
  assert.match(
    burst,
    /buildBurstPrimaryShotsForRanges\([\s\S]*?distribution:\s*exactDistribution/
  );
  assert.equal(
    (burst.match(/getBurstTargetHitDistribution\(/g) ?? []).length,
    1
  );
});
