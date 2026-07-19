import assert from "node:assert/strict";
import test from "node:test";

import { buildAbilityTooltipCostGroups } from "../src/utils/ability-tooltip-costs.mjs";

test("ability tooltip cost groups aggregate formulas and runtime overload once per resource", () => {
  const powerA = { id: "power-a", resourceKey: "power", formula: "2" };
  const powerB = { id: "power-b", resourceKey: "power", formula: "3" };
  const health = { id: "health", resourceKey: "health", formula: "1" };
  const groups = buildAbilityTooltipCostGroups(
    [powerA, powerB, health],
    [
      powerA,
      powerB,
      health,
      { id: "ability-overload-power", resourceKey: "power", formula: "4" },
      { id: "ability-overload-actionPoints", resourceKey: "actionPoints", formula: "2" }
    ]
  );

  assert.deepEqual(groups.map(group => ({
    resourceKey: group.resourceKey,
    base: group.base,
    total: group.total
  })), [
    { resourceKey: "power", base: 5, total: 9 },
    { resourceKey: "health", base: 1, total: 1 },
    { resourceKey: "actionPoints", base: 0, total: 2 }
  ]);
});

test("ability tooltip cost groups use the preview actor evaluator for every row", () => {
  const activeResources = new Set(["power"]);
  const evaluateRow = row => activeResources.has(row.resourceKey) ? Number(row.formula) * 2 : 0;
  const groups = buildAbilityTooltipCostGroups(
    [
      { resourceKey: "power", formula: "3" },
      { resourceKey: "reactionPoints", formula: "2" }
    ],
    [
      { resourceKey: "power", formula: "3" },
      { resourceKey: "reactionPoints", formula: "2" }
    ],
    { evaluateRow }
  );

  assert.deepEqual(groups.map(group => [group.resourceKey, group.base, group.total]), [
    ["power", 6, 6],
    ["reactionPoints", 0, 0]
  ]);
});
