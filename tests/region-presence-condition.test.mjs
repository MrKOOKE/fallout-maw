import assert from "node:assert/strict";
import test from "node:test";

const {
  PERIODIC_DAMAGE_REGION_BEHAVIOR_TYPE,
  tokenMatchesRegionPresenceCondition
} = await import("../src/abilities/region-presence-condition.mjs");

test("region presence matches selected damage and smoke types from TokenDocument.regions", () => {
  const smokeBehavior = createBehavior({
    damageEntries: [{ damageTypeKey: "fire" }],
    regionSpecialProperties: [{ type: "smoke" }]
  });
  const token = { regions: new Set([{ hidden: false, behaviors: [smokeBehavior] }]) };

  assert.equal(tokenMatchesRegionPresenceCondition(token, {
    damageTypeKeys: ["fire"]
  }, { worldTime: 100 }), true);
  assert.equal(tokenMatchesRegionPresenceCondition(token, {
    regionSpecialPropertyTypes: ["smoke"]
  }, { worldTime: 100 }), true);
  assert.equal(tokenMatchesRegionPresenceCondition(token, {
    damageTypeKeys: ["cold"]
  }, { worldTime: 100 }), false);
});

test("region presence ignores hidden, disabled, delayed and expired behaviors", () => {
  const condition = { regionSpecialPropertyTypes: ["smoke"] };
  const system = { regionSpecialProperties: [{ type: "smoke" }] };
  const tokenFor = (region, behavior) => ({ regions: new Set([{ behaviors: [behavior], ...region }]) });

  assert.equal(tokenMatchesRegionPresenceCondition(
    tokenFor({ hidden: true }, createBehavior(system)), condition, { worldTime: 100 }
  ), false);
  assert.equal(tokenMatchesRegionPresenceCondition(
    tokenFor({}, createBehavior(system, { disabled: true })), condition, { worldTime: 100 }
  ), false);
  assert.equal(tokenMatchesRegionPresenceCondition(
    tokenFor({}, createBehavior({ ...system, delaySeconds: 10 }, { activateAt: 110 })),
    condition,
    { worldTime: 100 }
  ), false);
  assert.equal(tokenMatchesRegionPresenceCondition(
    tokenFor({}, createBehavior(system, { expiresAt: 100 })), condition, { worldTime: 100 }
  ), false);
});

function createBehavior(system = {}, flags = {}) {
  return {
    type: PERIODIC_DAMAGE_REGION_BEHAVIOR_TYPE,
    disabled: Boolean(flags.disabled),
    system,
    getFlag: () => ({
      activateAt: flags.activateAt,
      expiresAt: flags.expiresAt
    })
  };
}
