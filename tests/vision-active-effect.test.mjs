import assert from "node:assert/strict";
import test from "node:test";

function getProperty(object, path) {
  return String(path ?? "").split(".").reduce((value, key) => value?.[key], object);
}

function setProperty(object, path, value) {
  const parts = String(path ?? "").split(".");
  const final = parts.pop();
  let target = object;
  for (const part of parts) target = target[part] ??= {};
  target[final] = value;
}

globalThis.foundry = { utils: { getProperty, setProperty } };
globalThis.ActiveEffect = class ActiveEffect {
  static applyChange(target, change) {
    const current = getProperty(target, change.key);
    const delta = Number(change.value) || 0;
    let update;
    if (typeof current === "boolean") update = current || Boolean(change.value);
    else {
      switch (change.type) {
        case "override": update = delta; break;
        case "multiply": update = current * delta; break;
        default: update = current + delta;
      }
    }
    setProperty(target, change.key, update);
    return { [change.key]: update };
  }
};

const { FalloutMaWActiveEffect } = await import("../src/documents/active-effect.mjs");
const {
  expandDetectionModeRangeEffectChange
} = await import("../src/canvas/vision-effect-keys.mjs");

function createToken({ sightRange = 2, modeId = "seeAll", enabled = false, range = null } = {}) {
  return {
    documentName: "Token",
    _source: {
      sight: { enabled: true, range: sightRange },
      detectionModes: { [modeId]: { enabled, range } }
    },
    sight: { enabled: true, range: sightRange },
    detectionModes: {
      [modeId]: { enabled, range: range ?? Infinity }
    }
  };
}

function applySemanticChange(token, modeId, value, type = "add") {
  const changes = expandDetectionModeRangeEffectChange({
    key: `fallout-maw.vision.detectionModes.${modeId}.range`,
    type,
    value
  });
  for (const change of changes) FalloutMaWActiveEffect.applyChange(token, change);
}

test("disabled null See All starts at zero instead of Foundry's prepared Infinity", () => {
  const token = createToken();
  applySemanticChange(token, "seeAll", "5");
  assert.equal(token.detectionModes.seeAll.enabled, true);
  assert.equal(token.detectionModes.seeAll.range, 5);

  applySemanticChange(token, "seeAll", "3");
  assert.equal(token.detectionModes.seeAll.range, 8);
});

test("zero See All stays finite zero and explicit unlimited See All remains unlimited", () => {
  const disabled = createToken();
  applySemanticChange(disabled, "seeAll", "0");
  assert.equal(disabled.detectionModes.seeAll.range, 0);

  const unlimited = createToken({ enabled: true, range: null });
  applySemanticChange(unlimited, "seeAll", "5");
  assert.equal(unlimited.detectionModes.seeAll.range, Infinity);
});

test("Night Vision mirrors the effective native sight range", () => {
  const token = createToken({ modeId: "basicSight" });
  applySemanticChange(token, "basicSight", "5");
  assert.equal(token.sight.range, 7);
  assert.equal(token.detectionModes.basicSight.range, 7);
});
