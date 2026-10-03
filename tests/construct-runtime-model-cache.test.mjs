import test from "node:test";
import assert from "node:assert/strict";
import {
  registerConstructVisualModelCache, getConstructVisualRuntimeConfig,
  getConstructVisualRuntimeRevision, getConstructVisualConfig,
  resolveConstructVisualAnchors, resolveConstructVisualLayers
} from "../src/utils/construct-visual-model.mjs";
import { configureConstructFiringPortTransforms, getConstructFiringPortWorldTransform }
  from "../src/canvas/construct-firing-ports.mjs";

const hooks = new Map();
globalThis.Hooks = { on(name, fn) { const callbacks = hooks.get(name) ?? []; callbacks.push(fn); hooks.set(name, callbacks); } };
const emit = (name, ...args) => hooks.get(name)?.forEach(fn => fn(...args));
registerConstructVisualModelCache();

function fixture() {
  const actor = { documentName: "Actor", type: "construct", system: { limbs: {} },
    flags: { "fallout-maw": { constructVisual: { enabled: true, anchors: [
      { id: "pivot", x: .5, y: .5 },
      { id: "window", parentSlotId: "turret", x: .2, y: -.1, rotation: 20 }
    ], parts: [{ id: "turret-image", slotId: "turret", anchorId: "pivot", img: "turret.webp", rotates: true }] } } },
    getFlag(scope, key) { return this.flags[scope]?.[key]; } };
  const item = { id: "turret-item", documentName: "Item", parent: actor, type: "gear", system: {
    placement: { mode: "constructPart", limbKey: "turret" },
    functions: { constructPart: { enabled: true }, condition: { enabled: true, max: 100, value: 100 } }
  } };
  actor.items = [item];
  return { actor, item };
}

test("cached local geometry follows equipment/config updates while a separate editor draft stays independent", () => {
  const { actor, item } = fixture();
  const options = { width: 200, height: 400, rotations: { turret: 40 } };
  const before = resolveConstructVisualAnchors(actor, options);
  assert.equal(resolveConstructVisualAnchors(actor, { ...options, rotations: { turret: 40 } }), before);
  actor.x = 600;
  actor.rotation = 120;
  assert.equal(resolveConstructVisualAnchors(actor, options), before);
  const draft = getConstructVisualConfig(actor);
  draft.anchors[0].x = .1;
  assert.equal(getConstructVisualRuntimeConfig(actor).anchors[0].x, .5);
  const rotated = resolveConstructVisualAnchors(actor, { ...options, rotations: { turret: 80 } });
  assert.notEqual(rotated, before);
  assert.notEqual(rotated.find(anchor => anchor.id === "window").x, before.find(anchor => anchor.id === "window").x);
  item.system.functions.condition.value = 0;
  emit("updateItem", item, { "system.functions.condition.value": 0 });
  assert.equal(resolveConstructVisualLayers(actor, options)[0].visible, false);
  assert.equal(resolveConstructVisualAnchors(actor, options).find(anchor => anchor.id === "window").parentVisible, false);
  item.system.functions.condition.value = 100;
  emit("updateItem", item, { "system.functions.condition.value": 100 });
  assert.equal(resolveConstructVisualLayers(actor, options)[0].visible, true);
  item.system.placement.mode = "inventory";
  emit("updateItem", item, { "system.placement.mode": "inventory" });
  assert.equal(resolveConstructVisualLayers(actor, options)[0].visible, false);
});

test("window origin and asymmetric limits follow the native fitted mirrored anchor and live parent yaw", () => {
  const { actor } = fixture();
  globalThis.canvas = { grid: { size: 100 } };
  const token = { actor, w: 200, h: 400, mesh: {
    position: { x: 700, y: 900 }, angle: 90, width: 300, height: 600,
    scale: { x: -1, y: 1 }, anchor: { x: .25, y: .75 }
  }, document: { actor, width: 2, height: 4, texture: {} } };
  const port = { enabled: true, anchorId: "window", minRotation: -10, maxRotation: 40 };
  configureConstructFiringPortTransforms({ getRotations: () => ({ turret: 0 }) });
  const first = getConstructFiringPortWorldTransform(token, port);
  // Local window (.7,.4): signed offset (-135,-210), rotated clockwise 90°.
  assert.ok(Math.abs(first.origin.x - 910) < 1e-8);
  assert.ok(Math.abs(first.origin.y - 765) < 1e-8);
  assert.ok(Math.abs(first.rotation - 70) < 1e-8);
  assert.equal(first.minRotation, -40);
  assert.equal(first.maxRotation, 10);
  configureConstructFiringPortTransforms({ getRotations: () => ({ turret: 90 }) });
  const turned = getConstructFiringPortWorldTransform(token, port);
  assert.notDeepEqual(turned.origin, first.origin);
  assert.ok(Math.abs(turned.rotation + 20) < 1e-8);
  const revision = getConstructVisualRuntimeRevision();
  emit("updateUser", { id: "player" });
  assert.equal(getConstructVisualRuntimeRevision(), revision + 1);
  const beforeEffect = resolveConstructVisualAnchors(actor);
  actor.system.limbs["constructPart:turret"] = { missing: true, value: 100 };
  emit("updateActiveEffect", { parent: { actor } });
  const afterEffect = resolveConstructVisualAnchors(actor);
  assert.notEqual(afterEffect, beforeEffect);
  assert.equal(afterEffect.find(anchor => anchor.id === "window").parentVisible, false);
});
