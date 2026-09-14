import assert from "node:assert/strict";
import test from "node:test";

globalThis.foundry = {
  applications: {
    apps: { FilePicker: { implementation: class {} } },
    sheets: { ActorSheetV2: class {}, ItemSheetV2: class {} },
    api: { ApplicationV2: class {}, DialogV2: {}, HandlebarsApplicationMixin: Base => class extends Base {} },
    ux: { FormDataExtended: class {}, TextEditor: { implementation: {} } },
    handlebars: { renderTemplate: async () => "" }
  },
  utils: {
    deepClone: value => structuredClone(value),
    mergeObject: (base, update) => mergeRecords(structuredClone(base), update)
  }
};

function mergeRecords(base, update) {
  for (const [key, value] of Object.entries(update ?? {})) {
    base[key] = value && typeof value === "object" && !Array.isArray(value)
      ? mergeRecords(base[key] && typeof base[key] === "object" ? base[key] : {}, value)
      : structuredClone(value);
  }
  return base;
}
let colorReads = 0;
let colors = [
  { key: "fire", label: "Fire", color: "#ff8000" },
  { key: "cutting", label: "Cutting", color: "#00ff00" },
  { key: "bleeding", label: "Bleeding", color: "#b82020" }
];
globalThis.game = { settings: { get: () => { colorReads++; return colors; } } };
let allocations = 0;
globalThis.PIXI = {
  MSAA_QUALITY: { NONE: 0 },
  Filter: class {
    constructor(_vertex, _fragment, uniforms) { this.uniforms = uniforms; allocations++; }
    destroy() { this.destroyed = true; }
  }
};

const {
  destroyTokenPeriodicDamageMask, refreshTokenPeriodicDamageMask,
  refreshTokenPeriodicDamageMaskVisibility, registerPeriodicDamageMaskHooks
} = await import("../src/canvas/periodic-damage-mask.mjs");

function token(amount = 10) {
  return {
    id: "token", document: { isSecret: false }, mesh: { filters: null },
    actor: {
      effects: [{ system: { changes: [{ key: "system.damageEffects.periodic.fire", value: {
        kind: "periodicDamage", damageTypeKey: "fire", amountPerTick: amount, remainingTicks: 2
      } }] } }],
      system: { resources: { health: { max: 100 } } }
    }
  };
}

test("one filter is reused as damage/health change, preserving other filters", () => {
  const target = token();
  target.actor.effects[0].system.changes[0].value.sourceDamageTypeKey = "cutting";
  const nativeFilter = { native: true };
  target.mesh.filters = [nativeFilter];
  refreshTokenPeriodicDamageMask(target);
  const filter = target.mesh.filters[0];
  assert.equal(target.mesh.filters[1], nativeFilter);
  assert.equal(filter.uniforms.intensity, 0.825);
  assert.equal(filter.uniforms.bleedingFlow, 0);
  assert.equal(filter.uniforms.damageColor[0], 1);
  assert.ok(Math.abs(filter.uniforms.damageColor[1] - (128 / 255)) < 1e-6);
  const before = allocations;
  const readsBefore = colorReads;
  target.actor.system.resources.health.max = 200;
  for (let index = 0; index < 25; index++) refreshTokenPeriodicDamageMask(target);
  assert.equal(filter.uniforms.intensity, 0.7375);
  assert.equal(allocations, before);
  assert.equal(colorReads, readsBefore);
  target.actor.effects = [];
  refreshTokenPeriodicDamageMask(target);
  assert.deepEqual(target.mesh.filters, [nativeFilter]);
  assert.equal(filter.destroyed, true);
  destroyTokenPeriodicDamageMask(target);
});

test("healthy tokens allocate nothing and a replacement mesh releases its old mask", () => {
  const target = token(0);
  const before = allocations;
  refreshTokenPeriodicDamageMask(target);
  assert.equal(allocations, before);
  target.actor.effects[0].system.changes[0].value.amountPerTick = 5;
  refreshTokenPeriodicDamageMask(target);
  const oldMesh = target.mesh;
  const oldFilter = oldMesh.filters[0];
  target.mesh = { filters: null };
  refreshTokenPeriodicDamageMask(target);
  assert.equal(oldMesh.filters, null);
  assert.equal(oldFilter.destroyed, true);
  assert.equal(target.mesh.filters.length, 1);
  const filter = target.mesh.filters[0];
  destroyTokenPeriodicDamageMask(target);
  assert.equal(target.mesh.filters, null);
  assert.equal(filter.destroyed, true);
});

test("secret-token and hover refreshes do not read effects or damage settings", () => {
  const target = token();
  refreshTokenPeriodicDamageMask(target);
  const filter = target.mesh.filters[0];
  Object.defineProperty(target.actor, "effects", { get() { throw Error("unexpected Actor scan"); } });
  const before = colorReads;
  target.document.isSecret = true;
  refreshTokenPeriodicDamageMaskVisibility(target);
  assert.equal(filter.enabled, false);
  target.document.isSecret = false;
  refreshTokenPeriodicDamageMaskVisibility(target);
  assert.equal(filter.enabled, true);
  assert.equal(colorReads, before);
  let passes = 0;
  filter.apply({ applyFilter: () => passes++ }, {}, {}, false);
  assert.equal(passes, 1);
  assert.equal(colorReads, before);
  destroyTokenPeriodicDamageMask(target);
});

test("bleeding uses the configured blood color instead of the wound's damage color", () => {
  const target = token();
  target.actor.effects[0].system.changes[0].value = {
    kind: "bleedingDamage", damageTypeKey: "bleeding", sourceDamageTypeKey: "cutting",
    tickAmounts: [12, 10, 10, 10], totalTicks: 4, remainingTicks: 4
  };
  refreshTokenPeriodicDamageMask(target);
  const filter = target.mesh.filters[0];
  assert.ok(Math.abs(filter.uniforms.damageColor[0] - (184 / 255)) < 1e-6);
  assert.ok(Math.abs(filter.uniforms.damageColor[1] - (32 / 255)) < 1e-6);
  assert.ok(Math.abs(filter.uniforms.damageColor[2] - (32 / 255)) < 1e-6);
  assert.equal(filter.uniforms.bleedingFlow, 1);
  destroyTokenPeriodicDamageMask(target);
});

test("dominant damage switches blood flow and grain without reallocating the filter", () => {
  const target = token(20);
  const burn = target.actor.effects[0];
  const bleed = { system: { changes: [{ key: "system.damageEffects.bleeding.torso", value: {
    kind: "bleedingDamage", damageTypeKey: "bleeding", tickAmounts: [12, 10], totalTicks: 2, remainingTicks: 2
  } }] } };
  target.actor.effects.push(bleed);
  refreshTokenPeriodicDamageMask(target);
  const filter = target.mesh.filters[0];
  const before = allocations;
  assert.equal(filter.uniforms.bleedingFlow, 0);
  burn.disabled = true;
  refreshTokenPeriodicDamageMask(target);
  assert.equal(target.mesh.filters[0], filter);
  assert.equal(filter.uniforms.bleedingFlow, 1);
  filter.apply({ applyFilter() {} }, {}, {}, false);
  assert.ok(filter.uniforms.flowTime > 0);
  burn.disabled = false;
  refreshTokenPeriodicDamageMask(target);
  assert.equal(filter.uniforms.bleedingFlow, 0);
  assert.equal(allocations, before);
  target.actor.effects = [];
  refreshTokenPeriodicDamageMask(target);
  assert.equal(target.mesh.filters, null);
  assert.equal(filter.destroyed, true);
});

test("settings refresh updates each damage type's own color and health while reusing the filter", () => {
  const target = token();
  target.actor.effects[0].system.changes[0].value.damageTypeKey = "cutting";
  refreshTokenPeriodicDamageMask(target);
  const filter = target.mesh.filters[0];
  assert.deepEqual([...filter.uniforms.damageColor], [0, 1, 0]);
  const hooks = new Map();
  globalThis.Hooks = { on: (event, callback) => { assert.equal(hooks.has(event), false); hooks.set(event, callback); } };
  globalThis.canvas = { ready: true, tokens: { placeables: [target] } };
  registerPeriodicDamageMaskHooks();
  registerPeriodicDamageMaskHooks();
  colors = [{ key: "cutting", label: "Cutting", color: "#0000ff" }];
  target.actor.system.resources.health.max = 50;
  hooks.get("fallout-maw.preparedActorsRefreshed")();
  assert.equal(target.mesh.filters[0], filter);
  assert.deepEqual([...filter.uniforms.damageColor], [0, 0, 1]);
  assert.equal(filter.uniforms.intensity, 1);
  destroyTokenPeriodicDamageMask(target);
});
