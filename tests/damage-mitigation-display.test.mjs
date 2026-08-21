import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDamageMitigationLimbSetChoices,
  buildDamageMitigationTables,
  resolveDamageMitigationEditorLimbSetId
} from "../src/utils/damage-mitigation-display.mjs";

const CREATURE_OPTIONS = {
  races: [
    {
      id: "human",
      name: "Human",
      equipmentSlots: [
        { key: "armor", label: "Armor" },
        { key: "helmet", label: "Helmet" }
      ],
      limbs: [
        { key: "head", label: "Head" },
        { key: "torso", label: "Torso" },
        { key: "arm", label: "Arm" }
      ]
    },
    {
      id: "robot",
      name: "Robot",
      equipmentSlots: [
        { key: "chassis", label: "Chassis" }
      ],
      limbs: [
        { key: "head", label: "Head" },
        { key: "torso", label: "Torso" },
        { key: "sensor", label: "Sensor" }
      ]
    }
  ]
};

const DAMAGE_TYPES = [
  { key: "fire", label: "Fire" }
];

function selectionKey(label) {
  const normalized = String(label).trim().toLocaleLowerCase();
  let hash = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    hash = ((hash << 5) - hash) + normalized.charCodeAt(index);
    hash |= 0;
  }
  return `slot${Math.abs(hash).toString(36)}`;
}

function createMitigationItem(limbSetIds = [], occupiedSlotLabels = [], occupiedSlotMode = "all") {
  return {
    system: {
      occupiedSlotMode,
      occupiedSlots: Object.fromEntries(occupiedSlotLabels.map(label => [selectionKey(label), true])),
      functions: {
        damageMitigation: {
          enabled: true,
          limbSetIds,
          entries: {
            head: { fire: { value: 7 } },
            torso: { fire: { value: 5 } },
            arm: { fire: { value: 3 } },
            sensor: { fire: { value: 2 } }
          }
        }
      }
    }
  };
}

test("the mitigation editor resolves one active limb set", () => {
  const item = createMitigationItem();
  const choices = buildDamageMitigationLimbSetChoices(item, CREATURE_OPTIONS);
  const activeId = resolveDamageMitigationEditorLimbSetId("", choices);

  assert.equal(choices.length, 2);
  assert.ok(activeId);
  assert.equal(choices.find(choice => choice.id === activeId)?.selected, true);

  const tables = buildDamageMitigationTables(item, CREATURE_OPTIONS, DAMAGE_TYPES, {
    limbSetId: activeId
  });
  assert.equal(tables.length, 1);
  assert.equal(tables[0].id, activeId);
  assert.equal(tables[0].limbSetLabel, "Hea, Tor, Arm");
  assert.equal(tables[0].rows[0].cells.find(cell => cell.limbKey === "head")?.value, 7);
});

test("the mitigation editor only offers anatomies compatible with occupied equipment slots", () => {
  const armor = createMitigationItem([], ["Armor"]);
  const armorChoices = buildDamageMitigationLimbSetChoices(armor, CREATURE_OPTIONS);
  assert.deepEqual(armorChoices.flatMap(choice => choice.races.map(race => race.id)), ["human"]);

  const chassis = createMitigationItem([], ["Chassis"]);
  const chassisChoices = buildDamageMitigationLimbSetChoices(chassis, CREATURE_OPTIONS);
  assert.deepEqual(chassisChoices.flatMap(choice => choice.races.map(race => race.id)), ["robot"]);
});

test("race-specific occupied slots remain alternatives in both slot modes", () => {
  const allSlots = createMitigationItem([], ["Armor", "Chassis"], "all");
  assert.equal(buildDamageMitigationLimbSetChoices(allSlots, CREATURE_OPTIONS).length, 2);

  const oneOfSlots = createMitigationItem([], ["Armor", "Chassis"], "oneOf");
  assert.equal(buildDamageMitigationLimbSetChoices(oneOfSlots, CREATURE_OPTIONS).length, 2);
});

test("the mitigation editor can open any racial limb set without changing applicability", () => {
  const allChoices = buildDamageMitigationLimbSetChoices(createMitigationItem(), CREATURE_OPTIONS);
  const humanId = allChoices.find(choice => choice.races.some(race => race.id === "human")).id;
  const robotId = allChoices.find(choice => choice.races.some(race => race.id === "robot")).id;
  const item = createMitigationItem([humanId]);
  const choices = buildDamageMitigationLimbSetChoices(item, CREATURE_OPTIONS);

  assert.equal(resolveDamageMitigationEditorLimbSetId(robotId, choices), robotId);
  const tables = buildDamageMitigationTables(item, CREATURE_OPTIONS, DAMAGE_TYPES, {
    limbSetId: robotId
  });
  assert.deepEqual(tables.map(table => table.id), [robotId]);
});

test("actor-facing mitigation still chooses among every enabled set by actor race", () => {
  const choices = buildDamageMitigationLimbSetChoices(createMitigationItem(), CREATURE_OPTIONS);
  const humanId = choices.find(choice => choice.races.some(race => race.id === "human")).id;
  const robotId = choices.find(choice => choice.races.some(race => race.id === "robot")).id;
  const item = createMitigationItem([humanId, robotId]);

  const humanTables = buildDamageMitigationTables(item, CREATURE_OPTIONS, DAMAGE_TYPES, {
    actorRaceId: "human",
    limbSetId: robotId
  });
  const robotTables = buildDamageMitigationTables(item, CREATURE_OPTIONS, DAMAGE_TYPES, {
    actorRaceId: "robot",
    limbSetId: humanId
  });

  assert.deepEqual(humanTables.map(table => table.id), [humanId]);
  assert.deepEqual(robotTables.map(table => table.id), [robotId]);
});

test("actor-facing mitigation may prepare contextual cells without changing editor values", () => {
  const choices = buildDamageMitigationLimbSetChoices(createMitigationItem(), CREATURE_OPTIONS);
  const humanId = choices.find(choice => choice.races.some(race => race.id === "human")).id;
  const item = createMitigationItem([humanId]);
  const preparedTables = buildDamageMitigationTables(item, CREATURE_OPTIONS, DAMAGE_TYPES, {
    actorRaceId: "human",
    prepareCell: cell => ({ baseValue: cell.value, value: cell.value * 2, tooltipHTML: "breakdown" })
  });
  const preparedHead = preparedTables[0].rows[0].cells.find(cell => cell.limbKey === "head");
  assert.equal(preparedHead.baseValue, 7);
  assert.equal(preparedHead.value, 14);
  assert.equal(preparedHead.tooltipHTML, "breakdown");

  const editorTables = buildDamageMitigationTables(item, CREATURE_OPTIONS, DAMAGE_TYPES, { limbSetId: humanId });
  assert.equal(editorTables[0].rows[0].cells.find(cell => cell.limbKey === "head")?.value, 7);
});
