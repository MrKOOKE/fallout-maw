import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { AimActivationGate } from "../src/utils/aim-activation-gate.mjs";
import { AimActivationPreview, notifyAimActivationRequired } from "../src/canvas/aim-activation-preview.mjs";

const source = await readFile(new URL("../src/combat/weapon-attack-controller.mjs", import.meta.url), "utf8");
// Run the production input/preview methods without loading the Foundry app or world.
const classStart = source.indexOf("export class WeaponAttackController {");
const methods = ["activate", "attachPreview", "onMove", "onTick", "onConfirm", "refresh", "setAimPointer",
  "updatePointerFromClientEvent", "syncWeaponNoisePreview"].map(name => {
  const expression = new RegExp(`\\n  (?:async )?${name}\\(`, "g");
  expression.lastIndex = classStart;
  const match = expression.exec(source);
  assert.ok(match, `Missing production method ${name}`);
  return source.slice(match.index, source.indexOf("\n  }", match.index) + 4);
}).join("\n");
const point = angle => ({ x: Math.sin(angle * Math.PI / 180) * 50, y: -Math.cos(angle * Math.PI / 180) * 50 });

test("production attack input stays passive until the cursor enters the painted half cone, then resumes normally", async t => {
  const globals = { PIXI: globalThis.PIXI, ui: globalThis.ui };
  t.after(() => { for (const [key, value] of Object.entries(globals)) {
    if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  } });
  class Container {
    children = [];
    addChild(child) { this.children.push(child); child.parent = this; }
    addChildAt(child, index) { this.children.splice(index, 0, child); child.parent = this; }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parent = null; }
  }
  class Graphics {
    clears = 0; visible = true;
    clear() { this.clears++; }
    lineStyle(...args) { this.style = args; }
    beginFill(...args) { this.fill = args; }
    drawPolygon(points) { this.points = points; }
    endFill() {}
    destroy() { this.destroyed = true; }
  }
  globalThis.PIXI = { Graphics };
  const notices = [];
  globalThis.ui = { notifications: { info: text => notices.push(text) } };
  const counts = { aim: 0, noise: 0, attack: 0, scans: 0, passiveDraw: 0 };
  const root = new Container();
  const Controller = vm.runInNewContext(`(class { ${methods} })`, {
    notifyAimActivationRequired, performance,
    isWhirlwindAttackModifier: () => false, isActorUnableToAct: () => false,
    getCombatVisualizationLayer: () => root,
    updateConstructWeaponAimPreview: () => counts.aim++,
    getWeaponAttackData: () => ({}), getWeaponNoiseLevel: () => 1,
    setWeaponNoisePreview: () => counts.noise++, drawAttackShape: () => counts.passiveDraw++,
    canvas: { canvasCoordinatesFromClient: value => value },
  });
  const sector = { origin: { x: 0, y: 0 }, rotation: -40, minRotation: -15, maxRotation: 15, radius: 100, seedDistance: 120 };
  const controller = Object.assign(new Controller(), {
    aimActivation: new AimActivationGate(() => sector), aimActivationPreview: new AimActivationPreview(),
    container: new Container(), shape: new Graphics(), meleeDirectionPreview: new Graphics(),
    constructAimLimits: { attach() {}, update: () => false },
    startTargetSelectionLifecycle: () => true, attachInteractiveHandlers() {}, isInteractionLocked: () => false,
    updateRightClickCancelCandidate() {}, clearTargetMarkers() {}, removeLimbMenu() {}, removeChanceMenu() {},
    getAttackOrigin: () => sector.origin, getAttackGeometry: () => ({ origin: sector.origin, end: controller.pointer }),
    rebuildGeometryAndTargets: () => { counts.scans++; return false; },
    drawFocusedTargetMarkerForPreview() {}, runInteractiveAttackOperation: operation => operation(),
    performCurrentAttack: () => { counts.attack++; return true; },
  });
  controller.previewFrameScheduler = { request() {}, flush: () => controller.refresh() };
  const move = angle => controller.onMove({ stopPropagation() {}, data: { getLocalPosition: () => point(angle) } });
  const click = angle => { const { x, y } = point(angle); return controller.onConfirm({ button: 0, clientX: x, clientY: y }); };

  assert.equal(controller.activate(), true);
  assert.equal(notices.length, 1);
  assert.equal(notices[0], "Наведите курсор на зеленую область для разблокировки прицеливания");
  const graphic = controller.aimActivationPreview.graphics, initial = { ...controller.pointer }, redraws = graphic.clears;
  assert.equal(graphic.eventMode, "none");
  assert.equal(graphic.fill[0], 0x68ed8a);
  const heading = (x, y) => Math.atan2(x, -y) * 180 / Math.PI;
  assert.ok(Math.abs(heading(...graphic.points.slice(2, 4)) + 47.5) < 1e-7);
  assert.ok(Math.abs(heading(...graphic.points.slice(-2)) + 32.5) < 1e-7);
  for (let i = 0; i < 100; i++) { move(140); controller.onTick(); }
  move(-30); // Inside the original cone, outside its safe central half.
  assert.equal(await click(-30), false);
  assert.deepEqual(controller.pointer, initial);
  assert.equal(counts.aim, 0); assert.equal(counts.noise, 0); assert.equal(counts.attack, 0); assert.equal(counts.scans, 0);
  assert.equal(graphic.clears, redraws, "idle green area does not redraw every frame");
  assert.equal(notices.length, 1);

  sector.rotation += 90; // Driver turns the hull before aiming is unlocked.
  controller.onTick();
  assert.equal(graphic.visible, true);
  assert.ok(Math.abs(heading(...graphic.points.slice(2, 4)) - 42.5) < 1e-7);
  assert.ok(Math.abs(heading(...graphic.points.slice(-2)) - 57.5) < 1e-7);
  move(-35);
  assert.equal(controller.aimActivation.waiting, true, "the old world direction cannot unlock the rotated area");
  assert.equal(counts.aim, 0);
  move(55);
  assert.equal(controller.aimActivation.waiting, false);
  assert.equal(graphic.visible, false);
  assert.equal(counts.aim, 1); assert.equal(counts.noise, 1);
  assert.deepEqual(sector.minRotation, -15); assert.deepEqual(sector.maxRotation, 15);
  move(140);
  assert.equal(counts.aim, 2);
  assert.equal(await click(140), true);
  assert.equal(counts.attack, 1);
  controller.aimActivationPreview.destroy();
  assert.equal(graphic.destroyed, true);
  assert.equal(controller.container.children.includes(graphic), false);
});
