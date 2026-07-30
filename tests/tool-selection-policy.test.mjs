import assert from "node:assert/strict";
import test from "node:test";

import {
  createToolGroupKey,
  groupToolSelectionOptions,
  selectToolByPolicy
} from "../src/utils/tool-selection-policy.mjs";

test("matched quality chooses the closest valid class while best chooses the highest class", () => {
  const instruments = [
    createInstrument("class-b", { toolClass: "B", supplyValue: 5 }),
    createInstrument("class-c", { toolClass: "C", supplyValue: 5 }),
    createInstrument("class-s", { toolClass: "S", supplyValue: 5 }),
    createInstrument("class-d", { toolClass: "D", supplyValue: 9 })
  ];
  const requirement = { requiredToolKey: "medical", requiredToolClass: "B" };

  assert.equal(
    selectToolByPolicy(instruments, requirement, { qualityMode: "matched" })?.id,
    "class-b"
  );
  assert.equal(
    selectToolByPolicy(instruments, requirement, { qualityMode: "best" })?.id,
    "class-s"
  );
});

test("depleted drains the most-used matching tool while balanced uses the fullest one", () => {
  const instruments = [
    createInstrument("nearly-empty", { supplyValue: 2, supplyMax: 10 }),
    createInstrument("half-full", { supplyValue: 5, supplyMax: 10 }),
    createInstrument("nearly-full", { supplyValue: 8, supplyMax: 10 })
  ];
  const requirement = { requiredToolKey: "medical", requiredToolClass: "B" };

  assert.equal(
    selectToolByPolicy(instruments, requirement, { supplyMode: "depleted" })?.id,
    "nearly-empty"
  );
  assert.equal(
    selectToolByPolicy(instruments, requirement, { supplyMode: "balanced" })?.id,
    "nearly-full"
  );
});

test("allowed tool groups filter by the exact tool type and class", () => {
  const instruments = [
    createInstrument("medical-b", { toolClass: "B", supplyValue: 4 }),
    createInstrument("medical-a", { toolClass: "A", supplyValue: 9 }),
    createInstrument("repair-a", {
      toolKey: "repair",
      toolClass: "A",
      supplyValue: 10
    })
  ];
  const requirement = { requiredToolKey: "medical", requiredToolClass: "B" };
  const medicalA = createToolGroupKey("medical", "A");
  const repairA = createToolGroupKey("repair", "A");

  assert.equal(
    selectToolByPolicy(instruments, requirement, {
      qualityMode: "matched",
      allowedToolGroupKeys: [medicalA]
    })?.id,
    "medical-a"
  );
  assert.equal(
    selectToolByPolicy(instruments, requirement, {
      allowedToolGroupKeys: [repairA]
    }),
    null
  );
});

test("selection ignores depleted, unmet, wrong-key, and under-class instruments", () => {
  const instruments = [
    createInstrument("depleted", { supplyValue: 0 }),
    createInstrument("unmet", { requirementMet: false, supplyValue: 10 }),
    createInstrument("wrong-key", { toolKey: "repair", supplyValue: 10 }),
    createInstrument("under-class", { toolClass: "D", supplyValue: 10 }),
    createInstrument("valid", { toolClass: "B", supplyValue: 1 })
  ];

  assert.equal(selectToolByPolicy(instruments, {
    requiredToolKey: "medical",
    requiredToolClass: "B"
  })?.id, "valid");
});

test("tool groups expose aggregate count and charges for policy checkboxes", () => {
  const groups = groupToolSelectionOptions([
    createInstrument("kit-1", {
      name: "First",
      toolLabel: "Doctor kit",
      toolClass: "B",
      supplyValue: 2,
      supplyMax: 10
    }),
    createInstrument("kit-2", {
      name: "Second",
      toolLabel: "Doctor kit",
      toolClass: "B",
      supplyValue: 7,
      supplyMax: 10
    }),
    createInstrument("kit-c", {
      toolLabel: "Doctor kit",
      toolClass: "C",
      supplyValue: 3,
      supplyMax: 5
    })
  ]);

  assert.deepEqual(groups.map(group => ({
    key: group.key,
    count: group.count,
    supplyValue: group.supplyValue,
    supplyMax: group.supplyMax
  })), [
    {
      key: createToolGroupKey("medical", "C"),
      count: 1,
      supplyValue: 3,
      supplyMax: 5
    },
    {
      key: createToolGroupKey("medical", "B"),
      count: 2,
      supplyValue: 9,
      supplyMax: 20
    }
  ]);
});

function createInstrument(id, overrides = {}) {
  return {
    id,
    name: id,
    toolKey: "medical",
    toolLabel: "Medical",
    toolClass: "B",
    requirementMet: true,
    supplyValue: 5,
    supplyMax: 10,
    ...overrides
  };
}
