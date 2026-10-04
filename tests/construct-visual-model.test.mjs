import test from "node:test";
import assert from "node:assert/strict";
import {
  getConstructVisualConfig, normalizeConstructVisual, resolveConstructVisualAnchors,
  resolveConstructVisualLayers, rotateConstructVisualOffset
} from "../src/utils/construct-visual-model.mjs";

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} ≠ ${expected}`);

test("multiple reload assignments survive visual editor normalization and preserve removed references", () => {
  const raw = { enabled: true, seats: [{ id: "loader", role: "loader", slotId: "cabin:crew",
    reloadPartSlotIds: ["turret", "remote-mg", "remote-mg", "", "removed-mount"] }] };
  const model = normalizeConstructVisual(raw);
  assert.deepEqual(model.seats[0].reloadPartSlotIds, ["turret", "remote-mg", "removed-mount"]);
  assert.deepEqual(normalizeConstructVisual(model), model);
});

function tank() {
  return {
    enabled: true,
    anchors: [
      { id: "turret", x: 0.5, y: 0.6 },
      { id: "gun", parentSlotId: "turret-slot", x: 0, y: -0.2 },
      { id: "muzzle", parentId: "gun", x: 0, y: -0.1 }
    ],
    parts: [
      { id: "turret-art", slotId: "turret-slot", anchorId: "turret", img: "turret.webp", rotates: true },
      { id: "gun-art", slotId: "gun-slot", anchorId: "gun", img: "gun.webp", damagedImg: "gun-broken.webp" }
    ]
  };
}

test("a turret carries attached gun and muzzle anchors through a 90 degree aim", () => {
  const options = { rotations: { "turret-slot": 90 }, installedSlots: ["turret-slot", "gun-slot"] };
  const anchors = new Map(resolveConstructVisualAnchors(tank(), options).map(anchor => [anchor.id, anchor]));
  near(anchors.get("gun").x, 0.7);
  near(anchors.get("gun").y, 0.6);
  near(anchors.get("muzzle").x, 0.8);
  near(anchors.get("muzzle").y, 0.6);
  const gun = resolveConstructVisualLayers(tank(), options).find(part => part.slotId === "gun-slot");
  assert.equal(gun.rotation, 90);
  assert.equal(gun.visible, true);
});

test("normalized child offsets rotate correctly on a non-square token", () => {
  const options = { width: 1024, height: 1792, rotations: { "turret-slot": 90 } };
  const anchors = new Map(resolveConstructVisualAnchors(tank(), options).map(anchor => [anchor.id, anchor]));
  near(anchors.get("gun").x, 0.85); // 0.2 * 1792 / 1024
  near(anchors.get("gun").y, 0.6);
  const forward = rotateConstructVisualOffset(0.12, -0.32, 123, options);
  const inverse = rotateConstructVisualOffset(forward.x, forward.y, -123, options);
  near(inverse.x, 0.12);
  near(inverse.y, -0.32);
});

test("runtime part rotation is relative to body and overrides the anchor angle", () => {
  const config = tank();
  config.anchors[0].rotation = 35;
  config.parts[0].rotation = 10;
  const staticPart = resolveConstructVisualLayers(config)[0];
  assert.equal(staticPart.rotation, 45);
  const dynamicPart = resolveConstructVisualLayers(config, { rotations: { "turret-slot": 80 } })[0];
  assert.equal(dynamicPart.rotation, 80);
});

test("removed and broken parts affect visibility and their dependent anchors", () => {
  const removed = resolveConstructVisualLayers(tank(), { installedSlots: ["gun-slot"] });
  assert.equal(removed[0].visible, false);
  assert.equal(removed[1].visible, false); // gun cannot float above a removed turret
  const damaged = resolveConstructVisualLayers(tank(), { installedSlots: ["turret-slot", "gun-slot"], brokenSlots: ["gun-slot"] });
  assert.equal(damaged[1].img, "gun-broken.webp");
  assert.equal(damaged[1].visible, true);
  const brokenTurret = resolveConstructVisualLayers(tank(), { installedSlots: ["turret-slot", "gun-slot"], brokenSlots: ["turret-slot"] });
  assert.equal(brokenTurret[0].visible, false);
  assert.equal(brokenTurret[1].visible, false);
});

test("missing refs and dependency cycles are detached without losing editable entries", () => {
  const config = normalizeConstructVisual({ enabled: true, anchors: [
    { id: "a", parentId: "b", x: 0.4 },
    { id: "b", parentId: "a", x: 0.2 },
    { id: "c", parentId: "missing" },
    { id: "d", parentSlotId: "self-part" }
  ], parts: [{ slotId: "self-part", anchorId: "d", img: "self.webp" }, { slotId: "absent-anchor", anchorId: "missing", img: "other.webp" }] });
  assert.equal(config.anchors.length, 4);
  assert.equal(config.anchors[0].parentId, "");
  assert.equal(config.anchors[2].parentId, "");
  assert.equal(config.anchors[3].parentSlotId, "");
  assert.equal(config.parts[1].anchorId, "");
  assert.ok(resolveConstructVisualAnchors(config).every(anchor => Number.isFinite(anchor.x) && Number.isFinite(anchor.y)));
});

test("traverse bounds limit aim and static nonrotating parts ignore runtime rotation", () => {
  const config = tank();
  config.parts[0].minRotation = -40;
  config.parts[0].maxRotation = 40;
  const layers = resolveConstructVisualLayers(config, { rotations: { "turret-slot": 100, "gun-slot": -100 } });
  assert.equal(layers[0].rotation, 40);
  assert.equal(layers[1].rotation, 40);
});

test("actor adapter keys installed art by physical part slots and detects damage", () => {
  const actor = { type: "construct", flags: { "fallout-maw": { constructVisual: tank() } },
    system: { limbs: {} }, items: [
      { id: "turret-item", type: "gear", system: { placement: { mode: "constructPart", limbKey: "constructPart:turret-slot" }, functions: { constructPart: { enabled: true } } } },
      { id: "gun-item", type: "gear", system: { placement: { mode: "constructPart", limbKey: "gun-slot" }, functions: { constructPart: { enabled: true }, condition: { enabled: true, max: 10, value: 0 } } } }
    ] };
  assert.equal(getConstructVisualConfig(actor).enabled, true);
  const layers = resolveConstructVisualLayers(actor);
  assert.equal(layers[0].installed, true);
  assert.equal(layers[1].broken, true);
  assert.equal(layers[1].img, "gun-broken.webp");
  actor.items[1].system.placement.mode = "inventory";
  assert.equal(resolveConstructVisualLayers(actor)[1].visible, false);
});

test("crew normalization permits combined roles and independent reload assignment", () => {
  const normalized = normalizeConstructVisual({ seats: [
    { id: "driver", role: "driver", slotId: "physical:a", slotIndex: 0 },
    { id: "gunner", role: "gunner", slotId: "physical:a", slotIndex: 1 },
    { id: "loader", role: "loader", slotId: "physical:a", slotIndex: 2 },
    { id: "custom", role: "custom", functions: ["move", "aim", "reload", "invalid", "aim"], slotId: "physical:a", slotIndex: 3 },
    { id: "duplicate", role: "passenger", slotId: "physical:a", slotIndex: 3 }
  ] });
  assert.deepEqual(normalized.seats[0].functions, ["move", "rotate"]);
  assert.deepEqual(normalized.seats[1].functions, ["aim", "fire", "reload"]);
  assert.deepEqual(normalized.seats[2].functions, ["reload"]);
  assert.deepEqual(normalized.seats[3].functions, ["move", "aim", "reload"]);
  assert.equal(normalized.seats.length, 4);
});

test("turret speed remains bounded and muzzle refs survive normalization", () => {
  const config = tank();
  config.parts[0].muzzleAnchorId = "muzzle";
  config.parts[0].rotationSpeed = 2000;
  config.parts[1].rotationSpeed = -3;
  const normalized = normalizeConstructVisual(config);
  assert.equal(normalized.parts[0].rotationSpeed, 720);
  assert.equal(normalized.parts[1].rotationSpeed, 0.1);
  assert.equal(normalized.parts[0].muzzleAnchorId, "muzzle");
  delete config.parts[0].rotationSpeed;
  config.parts[0].muzzleAnchorId = "missing";
  assert.equal(normalizeConstructVisual(config).parts[0].rotationSpeed, 90);
  assert.equal(normalizeConstructVisual(config).parts[0].muzzleAnchorId, "");
});
