import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeMedicineToolAvailability,
  MEDICINE_TOOL_AVAILABILITY
} from "../src/apps/medicine-tool-availability.mjs";
import { createToolGroupKey } from "../src/utils/tool-selection-policy.mjs";

test("mass medicine reports an absent configured medical instrument", () => {
  const result = analyzeMedicineToolAvailability({
    instruments: [],
    treatments: [createTreatment()],
    toolKey: "medical",
    toolLabel: "Медицина"
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, MEDICINE_TOOL_AVAILABILITY.missingTool);
  assert.match(result.message, /Нет медицинского инструмента/);
  assert.match(result.message, /Медицина/);
});

test("mass medicine distinguishes an insufficient instrument class", () => {
  const result = analyzeMedicineToolAvailability({
    instruments: [createInstrument({ toolClass: "D" })],
    treatments: [createTreatment({ healingToolClass: "B" })]
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, MEDICINE_TOOL_AVAILABILITY.toolClass);
  assert.match(result.message, /класса B или выше/);
  assert.match(result.message, /доступен класс D/);
});

test("mass medicine distinguishes a depleted compatible instrument", () => {
  const result = analyzeMedicineToolAvailability({
    instruments: [createInstrument({ name: "Пустая аптечка", supplyValue: 0 })],
    treatments: [createTreatment()]
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, MEDICINE_TOOL_AVAILABILITY.depleted);
  assert.match(result.message, /нет запаса/);
  assert.match(result.message, /Пустая аптечка/);
});

test("mass medicine reports the closest unmet skill required by an instrument", () => {
  const result = analyzeMedicineToolAvailability({
    instruments: [
      createInstrument({
        name: "Сложный набор",
        requirementMet: false,
        skillValue: 120,
        actorSkillValue: 70
      }),
      createInstrument({
        id: "closest",
        name: "Ближайший набор",
        requirementMet: false,
        skillValue: 100,
        actorSkillValue: 85
      })
    ],
    treatments: [createTreatment()]
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, MEDICINE_TOOL_AVAILABILITY.toolSkill);
  assert.match(result.message, /Ближайший набор/);
  assert.match(result.message, /100 Доктор/);
  assert.match(result.message, /сейчас 85/);
});

test("mass medicine reports an unmet no-roll treatment threshold", () => {
  const result = analyzeMedicineToolAvailability({
    instruments: [createInstrument()],
    treatments: [createTreatment({
      name: "Голова",
      skillThreshold: {
        met: false,
        difficulty: 80,
        skillValue: 65,
        skillLabel: "Доктор"
      }
    })]
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, MEDICINE_TOOL_AVAILABILITY.treatmentSkill);
  assert.match(result.message, /Голова/);
  assert.match(result.message, /80 Доктор/);
  assert.match(result.message, /сейчас 65/);
});

test("mass medicine returns only instruments usable for at least one treatment", () => {
  const usable = createInstrument({ id: "usable", toolClass: "B" });
  const tooWeak = createInstrument({ id: "weak", toolClass: "D" });
  const result = analyzeMedicineToolAvailability({
    instruments: [tooWeak, usable, { ...usable }],
    treatments: [createTreatment({ healingToolClass: "B" })]
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, MEDICINE_TOOL_AVAILABILITY.available);
  assert.deepEqual(result.instruments.map(instrument => instrument.id), ["usable"]);
});

test("mass medicine respects selected tool groups during revalidation", () => {
  const selected = createInstrument({ id: "selected", toolClass: "B" });
  const result = analyzeMedicineToolAvailability({
    instruments: [selected],
    treatments: [createTreatment()],
    allowedToolGroupKeys: [createToolGroupKey("medical", "A")]
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, MEDICINE_TOOL_AVAILABILITY.selectedGroups);
  assert.match(result.message, /Выбранные группы/);
});

test("mass medicine reports an empty target set independently from tools", () => {
  const result = analyzeMedicineToolAvailability({
    instruments: [createInstrument()],
    treatments: []
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, MEDICINE_TOOL_AVAILABILITY.noTargets);
  assert.match(result.message, /Нет травм или повреждённых частей тела/);
});

function createInstrument(overrides = {}) {
  return {
    id: "medical-tool",
    name: "Медицинский набор",
    toolKey: "medical",
    toolLabel: "Медицина",
    toolClass: "B",
    supplyValue: 20,
    supplyMax: 20,
    skillValue: 20,
    actorSkillValue: 100,
    skillLabel: "Доктор",
    requirementMet: true,
    ...overrides
  };
}

function createTreatment(overrides = {}) {
  return {
    id: "target",
    name: "Травма",
    healingToolClass: "B",
    skillThreshold: {
      met: true,
      difficulty: 60,
      skillValue: 100,
      skillLabel: "Доктор"
    },
    ...overrides
  };
}
