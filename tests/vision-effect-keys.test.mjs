import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const RU_MESSAGES = JSON.parse(readFileSync(new URL("../lang/ru.json", import.meta.url), "utf8"));

function getRuMessage(key) {
  return String(key ?? "").split(".").reduce((value, part) => value?.[part], RU_MESSAGES);
}

globalThis.foundry = {
  applications: {
    api: { DialogV2: class {} },
    ux: { FormDataExtended: class {} },
    handlebars: { renderTemplate: () => "" }
  },
  documents: {
    ActiveEffect: {
      implementation: {
        CHANGE_TYPES: {
          add: { defaultPriority: 20 },
          multiply: { defaultPriority: 10 },
          subtract: { defaultPriority: 20 },
          override: { defaultPriority: 30 },
          upgrade: { defaultPriority: 40 },
          downgrade: { defaultPriority: 40 }
        }
      }
    }
  },
  utils: {
    deepClone: value => structuredClone(value),
    getProperty: (object, path) => String(path ?? "").split(".").reduce((value, key) => value?.[key], object),
    mergeObject: (original, other) => ({ ...structuredClone(original), ...structuredClone(other) }),
    randomID: () => "generated"
  }
};
globalThis.game = {
  i18n: {
    localize(key) {
      return String(getRuMessage(key) ?? key);
    },
    format(key, data = {}) {
      return String(getRuMessage(key) ?? key).replace(/\{([^}]+)\}/g, (_match, name) => String(data[name] ?? ""));
    }
  },
  settings: {
    get() {
      throw new Error("settings are unavailable in this unit test");
    }
  }
};
globalThis.CONFIG = {
  Canvas: {
    detectionModes: {
      basicSight: { id: "basicSight", label: "Ночное зрение" },
      customSense: { id: "customSense", label: "Эхолокация" },
      invalid: { id: "invalid.mode", label: "Invalid" }
    }
  }
};

const {
  DETECTION_MODE_RANGE_TOKEN_CHANGE_MARKER,
  expandDetectionModeRangeEffectChange,
  getDetectionModeIdFromRangeEffectKey,
  getDetectionModeRangeEffectKey,
  getDetectionModeRangeEffectKeyDescriptors
} = await import("../src/canvas/vision-effect-keys.mjs");
const {
  buildDetectionModeRangeEffectKeyTokens,
  buildEffectKeyTokens
} = await import("../src/utils/effect-key-tokens.mjs");

test("registered Foundry detection modes become stable localized effect keys", () => {
  assert.equal(
    getDetectionModeRangeEffectKey("basicSight"),
    "fallout-maw.vision.detectionModes.basicSight.range"
  );
  assert.equal(
    getDetectionModeIdFromRangeEffectKey("fallout-maw.vision.detectionModes.basicSight.range"),
    "basicSight"
  );
  assert.deepEqual(
    getDetectionModeRangeEffectKeyDescriptors().map(entry => entry.id),
    ["basicSight", "customSense"]
  );

  const tokens = buildDetectionModeRangeEffectKeyTokens();
  assert.deepEqual(tokens.map(token => token.path), [
    "fallout-maw.vision.detectionModes.basicSight.range",
    "fallout-maw.vision.detectionModes.customSense.range"
  ]);
  assert.equal(tokens[0].label, "Ночное зрение");
  assert.equal(tokens.every(token => token.group === "Зрение и обнаружение"), true);
  assert.equal(buildEffectKeyTokens().some(token => token.path === tokens[0].path), true);
});

test("Night Vision updates both Foundry sight geometry and basic detection range", () => {
  const source = {
    key: "fallout-maw.vision.detectionModes.basicSight.range",
    type: "add",
    value: 5,
    phase: "initial",
    priority: 20
  };
  const expanded = expandDetectionModeRangeEffectChange(source);

  assert.deepEqual(expanded, [
    { ...source, key: "sight.enabled", type: "add", value: true },
    { ...source, key: "detectionModes.basicSight.enabled", type: "add", value: true },
    { ...source, key: "sight.range" },
    {
      ...source,
      key: "detectionModes.basicSight.range",
      [DETECTION_MODE_RANGE_TOKEN_CHANGE_MARKER]: "basicSight"
    }
  ]);
  assert.deepEqual(source, {
    key: "fallout-maw.vision.detectionModes.basicSight.range",
    type: "add",
    value: 5,
    phase: "initial",
    priority: 20
  });
  assert.equal(expandDetectionModeRangeEffectChange({ key: "system.unrelated" }), null);
});

test("special detection senses seed a finite zero base without enlarging ordinary sight", () => {
  const source = {
    key: "fallout-maw.vision.detectionModes.customSense.range",
    type: "override",
    value: 12
  };

  assert.deepEqual(expandDetectionModeRangeEffectChange(source), [
    { ...source, key: "sight.enabled", type: "add", value: true },
    { ...source, key: "detectionModes.customSense.enabled", type: "add", value: true },
    {
      ...source,
      key: "detectionModes.customSense.range",
      [DETECTION_MODE_RANGE_TOKEN_CHANGE_MARKER]: "customSense"
    }
  ]);
});

test("See All range changes are marked for source-aware Token application", () => {
  const expanded = expandDetectionModeRangeEffectChange({
    key: "fallout-maw.vision.detectionModes.seeAll.range",
    type: "add",
    value: "5"
  });
  const rangeChange = expanded.find(change => change.key === "detectionModes.seeAll.range");

  assert.equal(rangeChange[DETECTION_MODE_RANGE_TOKEN_CHANGE_MARKER], "seeAll");
});
