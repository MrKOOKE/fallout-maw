import test from "node:test";
import assert from "node:assert/strict";
import { getWeaponResourcePayer, groupWeaponActorResourceCosts, payWeaponActorResourceGroups } from "../src/combat/weapon-resource-payers.mjs";

const owner = { uuid: "Actor.tank", resources: { energy: 10, actionPoints: 99 } };
const gunner = { uuid: "Actor.gunner", resources: { actionPoints: 8, energy: 2 } };

test("weapon fuel stays with the construct while every action resource uses its occupant", () => {
  const groups = groupWeaponActorResourceCosts(owner, gunner, [
    { resourceKey: "energy", amount: 3 }, { resourceKey: "actionPoints", amount: 2 },
    { resourceKey: "reactionPoints", amount: 1 }, { resourceKey: "movementPoints", amount: 4 }
  ]);
  assert.equal(groups[0].actor, owner);
  assert.deepEqual(groups[0].costRows.map(row => row.resourceKey), ["energy", "movementPoints"]);
  assert.equal(groups[1].actor, gunner);
  assert.deepEqual(groups[1].costRows.map(row => row.resourceKey), ["actionPoints", "reactionPoints"]);
  assert.equal(getWeaponResourcePayer(owner, null, "actionPoints"), owner);
  assert.equal(groupWeaponActorResourceCosts(owner, owner, [{ resourceKey: "energy" }, { resourceKey: "actionPoints" }]).length, 1);
});

function adapter() {
  const actors = [{ uuid: "tank", resources: { energy: 10 } }, { uuid: "gunner", resources: { actionPoints: 8 } }];
  const groups = groupWeaponActorResourceCosts(actors[0], actors[1], [{ resourceKey: "energy", amount: 3 }, { resourceKey: "actionPoints", amount: 2 }]);
  const quote = async () => ({ ok: true, fingerprint: "same" });
  const pay = async ({ actor, costRows, context }) => {
    const before = { ...actor.resources };
    for (const row of costRows) actor.resources[row.resourceKey] -= row.amount;
    try {
      await context.afterVectorSpend();
      return { ok: true, execution: { spendReceipt: { costs: costRows } } };
    } catch (error) {
      actor.resources = before;
      return { ok: false, reason: "spendFailed", error };
    }
  };
  return { actors, groups, quote, pay, context: {} };
}

test("mixed owner/occupant resource payment commits the weapon once", async () => {
  const state = adapter();
  let itemCommits = 0;
  const result = await payWeaponActorResourceGroups({ ...state, commit: async () => { itemCommits++; return true; } });
  assert.equal(result.ok, true);
  assert.equal(itemCommits, 1);
  assert.equal(state.actors[0].resources.energy, 7);
  assert.equal(state.actors[1].resources.actionPoints, 6);
  assert.equal(result.actorCosts.length, 2);
});

test("failed weapon persistence refunds both tank fuel and occupant AP", async () => {
  const state = adapter();
  const result = await payWeaponActorResourceGroups({ ...state, commit: async () => { throw Error("Item update rejected"); } });
  assert.equal(result.ok, false);
  assert.equal(state.actors[0].resources.energy, 10);
  assert.equal(state.actors[1].resources.actionPoints, 8);
  assert.deepEqual(result.actorCosts, []);
});

test("unaffordable occupant quote leaves tank fuel and Item untouched", async () => {
  const state = adapter();
  let itemCommits = 0;
  const result = await payWeaponActorResourceGroups({ ...state,
    quote: async ({ actor }) => ({ ok: actor.uuid !== "gunner", reason: "insufficientResource" }),
    commit: async () => { itemCommits++; return true; } });
  assert.equal(result.ok, false);
  assert.equal(itemCommits, 0);
  assert.equal(state.actors[0].resources.energy, 10);
});
