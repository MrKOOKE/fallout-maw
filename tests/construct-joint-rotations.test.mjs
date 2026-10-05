import test from "node:test";
import assert from "node:assert/strict";
import { resolveConstructJointRotations, prepareConstructJointRotationState } from "../src/utils/construct-joint-rotations.mjs";
import { resolveConstructVisualAnchors, resolveConstructVisualLayers } from "../src/utils/construct-visual-model.mjs";

const config = { enabled: true, anchors: [
  { id: "turret-pivot", x: 0.5, y: 0.5 },
  { id: "mg-pivot", parentSlotId: "turret", x: 0.1, y: -0.1 },
  { id: "mg-muzzle", parentSlotId: "mg", x: 0, y: -0.2 }
], parts: [
  { id: "turret", slotId: "turret", anchorId: "turret-pivot", rotates: true, img: "turret.webp" },
  { id: "mg", slotId: "mg", anchorId: "mg-pivot", muzzleAnchorId: "mg-muzzle", rotates: true, img: "mg.webp" }
] };

test("a previously aimed machine gun retains its local yaw while a turret preview carries its pivot, barrel and muzzle", () => {
  const state = { rotations: { turret: 70, mg: 20 } };
  assert.deepEqual(resolveConstructJointRotations(config, state), state.rotations, "legacy pose must not jump on load");
  const rotations = resolveConstructJointRotations(config, state, { turret: 100 });
  assert.deepEqual(rotations, { turret: 100, mg: 50 });
  const before = resolveConstructVisualAnchors(config, { rotations: state.rotations });
  const after = resolveConstructVisualAnchors(config, { rotations });
  assert.equal(after.find(a => a.id === "mg-pivot").rotation, 100);
  assert.equal(after.find(a => a.id === "mg-muzzle").rotation, 50);
  assert.notEqual(after.find(a => a.id === "mg-pivot").x, before.find(a => a.id === "mg-pivot").x);
  assert.deepEqual(state, { rotations: { turret: 70, mg: 20 } }, "rendering cannot mutate token state");
});

test("turret handoff persists a mount reference, survives reload, and repeated turns never compound compensation", () => {
  let state = { rotations: { turret: 70, mg: 20 } };
  const current = resolveConstructJointRotations(config, state, { turret: 100 });
  state = prepareConstructJointRotationState(config, state, "turret", 100, current);
  assert.equal(state.rotationAnchors.mg, 70);
  assert.deepEqual(resolveConstructJointRotations(config, structuredClone(state)), { turret: 100, mg: 50 });
  state = prepareConstructJointRotationState(config, state, "turret", -140,
    resolveConstructJointRotations(config, state, { turret: -140 }));
  assert.deepEqual(resolveConstructJointRotations(config, state), { turret: -140, mg: 170 });
  state = prepareConstructJointRotationState(config, state, "turret", 70,
    resolveConstructJointRotations(config, state, { turret: 70 }));
  assert.deepEqual(resolveConstructJointRotations(config, state), { turret: 70, mg: 20 });
});

test("active machine-gun aiming remains independent, then stopping preserves its new yaw relative to the mount", () => {
  let state = { rotations: { turret: 70, mg: 20 } };
  const aimed = resolveConstructJointRotations(config, state, { turret: 100, mg: 10 });
  assert.deepEqual(aimed, { turret: 100, mg: 10 });
  state = prepareConstructJointRotationState(config, state, "turret", 100, aimed);
  state = prepareConstructJointRotationState(config, state, "mg", 10, aimed);
  assert.equal(state.rotationAnchors.mg, 100);
  assert.deepEqual(resolveConstructJointRotations(config, state, { turret: 130 }), { turret: 130, mg: 40 });
});

test("unconfigured children inherit normally and joint travel limits stay relative to a moving parent", () => {
  const bounded = structuredClone(config);
  bounded.parts[1].minRotation = -45; bounded.parts[1].maxRotation = 45;
  assert.equal(resolveConstructVisualLayers(bounded, { rotations: resolveConstructJointRotations(bounded,
    { rotations: { turret: 0 } }, { turret: 90 }) })[1].rotation, 90);
  assert.deepEqual(resolveConstructJointRotations(bounded, { rotations: { turret: 0, mg: 30 } }, { turret: 90 }),
    { turret: 90, mg: 120 });
});
