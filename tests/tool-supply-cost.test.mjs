import assert from "node:assert/strict";
import test from "node:test";

globalThis.foundry = {
  applications: {
    api: { DialogV2: class {} },
    ux: { FormDataExtended: class {} },
    handlebars: { renderTemplate: async () => "" }
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
    deepClone: structuredClone,
    getProperty: (object, path) => String(path ?? "").split(".").reduce((value, key) => value?.[key], object),
    hasProperty: () => false,
    mergeObject: (original, other) => ({ ...structuredClone(original), ...structuredClone(other) }),
    randomID: () => "generated",
    setProperty: () => true
  }
};

const configuredTools = [
  { key: "medical", label: "Инструменты медицины" },
  { key: "repair", label: "Инструменты ремонта" },
  { key: "worldCustom", label: "Мастерский инструмент" }
];
globalThis.game = {
  i18n: {
    localize: key => ({
      "FALLOUTMAW.Effects.ToolsGroup": "Инструменты",
      "FALLOUTMAW.Effects.AllToolSupplyCostPercent": "Все инструменты"
    })[key] ?? key,
    format: (_key, data = {}) => `Расход: ${data.tool}, %`
  },
  settings: { get: () => configuredTools }
};

const {
  ALL_TOOL_SUPPLY_COST_EFFECT_KEY,
  getToolSupplyCostEffectKey,
  isToolSupplyCostEffectKey
} = await import("../src/utils/tool-supply-effect-keys.mjs");
const {
  applyToolSupplyCostPercent,
  getActorToolSupplyCost,
  getActorToolSupplyCostPercent
} = await import("../src/utils/tool-supply-cost.mjs");
const { buildToolSupplyCostEffectKeyTokens } = await import("../src/utils/effect-key-tokens.mjs");
const { isActiveUseEffectKey } = await import("../src/abilities/active-use-keys.mjs");
const { prepareActorEffectChangeForApplication } = await import("../src/utils/active-effect-changes.mjs");

test("tool supply keys include one common key and every world tool", () => {
  const tokens = buildToolSupplyCostEffectKeyTokens();
  assert.deepEqual(tokens.map(token => token.path), [
    ALL_TOOL_SUPPLY_COST_EFFECT_KEY,
    ...configuredTools.map(tool => getToolSupplyCostEffectKey(tool.key))
  ]);
  assert.match(tokens.at(-1).label, /Мастерский инструмент/);
});

test("tool supply percentages use signed percent values and integer rounding", () => {
  assert.equal(applyToolSupplyCostPercent(100, -15), 85);
  assert.equal(applyToolSupplyCostPercent(10, 25), 13);
  assert.equal(applyToolSupplyCostPercent(1, -99), 1);
  assert.equal(applyToolSupplyCostPercent(0, -15), 0);
});

test("common and specific tool effects combine before supply is spent", () => {
  let effectReads = 0;
  const actor = {
    effects: [],
    items: { contents: [] },
    system: {},
    *allApplicableEffects() {
      effectReads += 1;
      yield {
        disabled: false,
        changes: [
          { key: ALL_TOOL_SUPPLY_COST_EFFECT_KEY, type: "add", value: "-5", priority: 10 },
          { key: getToolSupplyCostEffectKey("repair"), type: "add", value: "-10", priority: 20 }
        ]
      };
    }
  };

  assert.equal(getActorToolSupplyCostPercent(actor, "repair"), -15);
  assert.equal(getActorToolSupplyCost(actor, "repair", 100), 85);
  assert.equal(effectReads, 2);
});

test("dynamic tool supply keys are eligible for active-use functions", () => {
  assert.equal(isToolSupplyCostEffectKey(ALL_TOOL_SUPPLY_COST_EFFECT_KEY), true);
  assert.equal(isActiveUseEffectKey(ALL_TOOL_SUPPLY_COST_EFFECT_KEY), true);
  assert.equal(isActiveUseEffectKey(getToolSupplyCostEffectKey("worldCustom")), true);
});

test("tool supply keys stay runtime-only instead of creating unknown Actor fields", () => {
  assert.equal(prepareActorEffectChangeForApplication({}, {
    key: getToolSupplyCostEffectKey("repair"),
    type: "add",
    value: "-15"
  }), null);
});
