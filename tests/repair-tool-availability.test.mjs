import assert from "node:assert/strict";
import test from "node:test";

import {
  REPAIR_TOOL_AVAILABILITY,
  analyzeMassRepairToolAvailability
} from "../src/utils/repair-tool-availability.mjs";

test("mass repair availability distinguishes an absent tool type", () => {
  const result = analyzeMassRepairToolAvailability({
    instruments: [createInstrument({ toolKey: "medical", toolLabel: "Медицина" })],
    requirements: [createRequirement({ toolKey: "repair", toolLabel: "Ремонт" })]
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, REPAIR_TOOL_AVAILABILITY.missingToolType);
  assert.match(result.message, /Нет инструмента требуемого типа/);
  assert.match(result.message, /Ремонт/);
});

test("mass repair availability distinguishes depleted compatible tools", () => {
  const result = analyzeMassRepairToolAvailability({
    instruments: [createInstrument({ name: "Пустой набор", supplyValue: 0 })],
    requirements: [createRequirement()]
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, REPAIR_TOOL_AVAILABILITY.depleted);
  assert.match(result.message, /нет запаса/);
  assert.match(result.message, /Пустой набор/);
});

test("mass repair availability reports the closest unmet tool skill", () => {
  const result = analyzeMassRepairToolAvailability({
    instruments: [
      createInstrument({
        name: "Сложный набор",
        requirementMet: false,
        skillValue: 120,
        actorSkillValue: 70,
        skillLabel: "Наука"
      }),
      createInstrument({
        name: "Ближайший набор",
        requirementMet: false,
        skillValue: 100,
        actorSkillValue: 85,
        skillLabel: "Ремонт"
      })
    ],
    requirements: [createRequirement()]
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, REPAIR_TOOL_AVAILABILITY.toolSkill);
  assert.match(result.message, /Ближайший набор/);
  assert.match(result.message, /100 Ремонт/);
  assert.match(result.message, /сейчас 85/);
});

test("mass repair availability distinguishes an insufficient tool class", () => {
  const result = analyzeMassRepairToolAvailability({
    instruments: [createInstrument({ toolClass: "D" })],
    requirements: [createRequirement({ toolClass: "B" })]
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, REPAIR_TOOL_AVAILABILITY.toolClass);
  assert.match(result.message, /класса B или выше/);
  assert.match(result.message, /доступен класс D/);
});

test("mass repair availability reports an unmet no-roll repair threshold", () => {
  const result = analyzeMassRepairToolAvailability({
    instruments: [createInstrument()],
    requirements: [createRequirement({
      itemName: "Силовая броня",
      skillThreshold: {
        met: false,
        difficulty: 140,
        skillValue: 95,
        skillLabel: "Ремонт"
      }
    })]
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, REPAIR_TOOL_AVAILABILITY.skillThreshold);
  assert.match(result.message, /Силовая броня/);
  assert.match(result.message, /140 Ремонт/);
  assert.match(result.message, /сейчас 95/);
});

test("mass repair availability returns only instruments usable by at least one target", () => {
  const valid = createInstrument({ id: "valid", uid: "valid:repair" });
  const wrongType = createInstrument({
    id: "medical",
    uid: "medical:medical",
    toolKey: "medical"
  });
  const duplicateMatch = { ...valid };
  const result = analyzeMassRepairToolAvailability({
    instruments: [wrongType, valid, duplicateMatch],
    requirements: [createRequirement()]
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, REPAIR_TOOL_AVAILABILITY.available);
  assert.deepEqual(result.instruments.map(instrument => instrument.id), ["valid"]);
});

test("mass repair remains available when one of several target types is still repairable", () => {
  const result = analyzeMassRepairToolAvailability({
    instruments: [createInstrument()],
    requirements: [
      createRequirement({
        itemId: "too-hard",
        itemName: "Сложная броня",
        skillThreshold: {
          met: false,
          difficulty: 140,
          skillValue: 95,
          skillLabel: "Ремонт"
        }
      }),
      createRequirement({
        itemId: "repairable",
        itemName: "Обычная броня"
      })
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, REPAIR_TOOL_AVAILABILITY.available);
  assert.deepEqual(result.instruments.map(instrument => instrument.id), ["tool"]);
});

test("mass repair availability reports an empty target collection independently of tools", () => {
  const result = analyzeMassRepairToolAvailability({
    instruments: [createInstrument()],
    requirements: []
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, REPAIR_TOOL_AVAILABILITY.noTargets);
  assert.match(result.message, /Нет предметов/);
});

function createInstrument(overrides = {}) {
  return {
    id: "tool",
    uid: "tool:repair",
    name: "Набор ремонта",
    toolKey: "repair",
    toolLabel: "Ремонт",
    toolClass: "B",
    supplyValue: 10,
    supplyMax: 10,
    skillValue: 0,
    actorSkillValue: 0,
    skillLabel: "",
    requirementMet: true,
    ...overrides
  };
}

function createRequirement(overrides = {}) {
  return {
    itemId: "target",
    itemName: "Броня",
    methodIndex: 0,
    toolKey: "repair",
    toolLabel: "Ремонт",
    toolClass: "B",
    skillThreshold: {
      met: true,
      difficulty: 60,
      skillValue: 100,
      skillLabel: "Ремонт"
    },
    ...overrides
  };
}
