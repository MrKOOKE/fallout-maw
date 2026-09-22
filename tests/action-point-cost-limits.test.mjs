import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

globalThis.foundry = { applications: {
  api: { DialogV2: class {} },
  ux: { FormDataExtended: class {} },
  handlebars: { renderTemplate: async () => "" }
}, utils: {
  deepClone: structuredClone,
  mergeObject: (base, value) => ({ ...base, ...value })
} };
let settings = {};
globalThis.game = { settings: { get: () => settings } };

const { normalizeCombatSettings } = await import("../src/settings/combat.mjs");
const { finalizeAttackActionPointCost, finalizeActiveItemActionPointCost } = await import("../src/utils/action-point-cost-limits.mjs");

test("existing worlds default both cost floors to one and invalid settings are normalized", () => {
  const defaults = normalizeCombatSettings({});
  assert.equal(defaults.minimumAttackActionPointCost, 1);
  assert.equal(defaults.minimumActiveItemActionPointCost, 1);
  const normalized = normalizeCombatSettings({ minimumAttackActionPointCost: -9, minimumActiveItemActionPointCost: "invalid" });
  assert.equal(normalized.minimumAttackActionPointCost, 0);
  assert.equal(normalized.minimumActiveItemActionPointCost, 1);
});

test("attack and active-item floors are independent and retain final rounding", () => {
  settings = { minimumAttackActionPointCost: 3, minimumActiveItemActionPointCost: 2 };
  for (const action of ["aimedShot", "snapshot", "burst", "volley", "meleeAttack", "aimedMeleeAttack", "push"]) {
    assert.equal(finalizeAttackActionPointCost(-10, action), 3);
    assert.equal(finalizeAttackActionPointCost(3.2, action), 4);
  }
  assert.equal(finalizeActiveItemActionPointCost(-10), 2);
  assert.equal(finalizeAttackActionPointCost(0, "reload"), 0);
  settings = { minimumAttackActionPointCost: 0, minimumActiveItemActionPointCost: 0 };
  assert.equal(finalizeAttackActionPointCost(-5, "burst"), 0);
  assert.equal(finalizeActiveItemActionPointCost(-5), 0);
});

function readFunction(file, name) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const match = source.match(new RegExp(`(?:export )?function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, name);
  return match[0].replace(/^export /, "");
}

test("weapon runtime applies its minimum after contextual bonuses, posture and ability reductions", () => {
  settings = { minimumAttackActionPointCost: 2 };
  const calculate = new Function("finalizeAttackActionPointCost", `
    const DEFAULT_WEAPON_ACTION_POINT_COST = 5;
    const getWeaponAttackData = () => ({ burst: { actionPointCost: 3 } });
    const evaluateActorFormula = value => value;
    const applyDamageCostModifier = () => 1;
    const getDamageCostModifierState = () => ({ action: {} });
    const getActorPostureAction = () => "crawl";
    const getActorPostureWeaponActionPointCostBonus = () => 1;
    const getContextualAbilityChangeValues = () => ({ actionCost: -5, postureCost: -2 });
    const getActorAtRandomActionPointCostReduction = () => 10;
    ${readFunction("../src/combat/weapon-attack-controller.mjs", "getWeaponActionPointCost")}
    return getWeaponActionPointCost;
  `)(finalizeAttackActionPointCost);
  assert.equal(calculate({}, {}, "burst"), 2);
});

test("first aid applies its minimum after both ordinary and contextual bonuses", () => {
  settings = { minimumActiveItemActionPointCost: 3 };
  const calculate = new Function("finalizeActiveItemActionPointCost", `
    const toInteger = value => Math.trunc(Number(value) || 0);
    const applyDamageCostModifier = () => 0;
    const getActionCostModifierState = () => ({});
    const getContextualAbilityChangeValue = () => -10;
    const FIRST_AID_ACTION_POINT_COST_EFFECT_KEY = "system.costs.actions.firstAid";
    const GENERAL_ACTION_POINT_COST_EFFECT_KEY = "system.costs.action";
    ${readFunction("../src/items/first-aid-action-cost.mjs", "getFirstAidActionPointCost")}
    return getFirstAidActionPointCost;
  `)(finalizeActiveItemActionPointCost);
  assert.equal(calculate({}, { actionPointCost: 5 }), 3);
  assert.equal(calculate({}, { actionPointCost: 5 }, { targetActor: {} }), 3);
});

test("percentage discounts for ability-triggered attacks cannot undercut the minimum", () => {
  settings = { minimumAttackActionPointCost: 2 };
  const calculate = new Function("finalizeAttackActionPointCost", `
    const isActorInActiveCombat = actor => actor.inCombat;
    const normalizeAbilityAction = action => action;
    const ABILITY_ACTION_POINT_COST_MODES = { none: "none", fixed: "fixed", actual: "actual" };
    const getWeaponActionPointCost = () => 5;
    ${readFunction("../src/abilities/ability-actions.mjs", "getConfiguredActionPointCost")}
    return getConfiguredActionPointCost;
  `)(finalizeAttackActionPointCost);
  assert.equal(calculate({ inCombat: true }, {}, "burst", "", { actionPointCostMode: "actual", actualActionPointCostPercent: 1 }), 2);
  assert.equal(calculate({ inCombat: true }, {}, "burst", "", { actionPointCostMode: "fixed", fixedActionPointCost: 0 }), 2);
  assert.equal(calculate({ inCombat: false }, {}, "burst", "", { actionPointCostMode: "fixed", fixedActionPointCost: 0 }), 0);
});
