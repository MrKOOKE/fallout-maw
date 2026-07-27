import assert from "node:assert/strict";
import test from "node:test";

import {
  reconcileWeaponResourceCostReferences
} from "../src/combat/weapon-resource-cost-references.mjs";

test("renaming an actor resource migrates Attack Power and critical failure references", () => {
  const data = {
    resourceCosts: [{
      id: "cost-one",
      type: "actorResource",
      resourceKey: "consciousness",
      formula: "2"
    }],
    specialProperties: [{
      type: "attackPower",
      attackPower: {
        resourceCosts: [{
          type: "actorResource",
          resourceKey: "health",
          amount: 3
        }]
      }
    }],
    snapshot: {
      criticalFailureConsequences: [{
        id: "critical-one",
        resourceType: "actorResource",
        resourceKey: "health",
        amount: 2
      }]
    }
  };

  reconcileWeaponResourceCostReferences(data, [{
    id: "cost-one",
    type: "actorResource",
    resourceKey: "health",
    formula: "2"
  }]);

  assert.equal(data.specialProperties[0].attackPower.resourceCosts[0].resourceKey, "consciousness");
  assert.equal(data.snapshot.criticalFailureConsequences[0].resourceKey, "consciousness");
});

test("changing the final actor resource to an item cost removes invalid actor references", () => {
  const data = {
    resourceCosts: [{ id: "cost-one", type: "quantity", amount: 1 }],
    specialProperties: [{
      type: "attackPower",
      attackPower: {
        resourceCosts: [{
          type: "actorResource",
          resourceKey: "health",
          amount: 3
        }]
      }
    }],
    snapshot: {
      criticalFailureConsequences: [{
        id: "critical-one",
        resourceType: "actorResource",
        resourceKey: "health",
        amount: 2
      }]
    }
  };

  reconcileWeaponResourceCostReferences(data, [{
    id: "cost-one",
    type: "actorResource",
    resourceKey: "health",
    formula: "2"
  }]);

  assert.deepEqual(data.specialProperties[0].attackPower.resourceCosts, [{
    type: "quantity",
    amount: 3
  }]);
  assert.deepEqual(data.snapshot.criticalFailureConsequences, [{
    id: "critical-one",
    resourceType: "quantity",
    resourceKey: "",
    amount: 2
  }]);
});

test("references stay on an old identity while another base row still provides it", () => {
  const data = {
    resourceCosts: [
      { id: "cost-one", resourceKey: "consciousness", formula: "1" },
      { id: "cost-two", resourceKey: "health", formula: "1" }
    ],
    specialProperties: [{
      type: "attackPower",
      attackPower: {
        resourceCosts: [{
          type: "actorResource",
          resourceKey: "health",
          amount: 2
        }]
      }
    }],
    criticalFailureConsequences: [{
      id: "critical-one",
      resourceType: "actorResource",
      resourceKey: "health",
      amount: 1
    }]
  };

  reconcileWeaponResourceCostReferences(data, [
    { id: "cost-one", resourceKey: "health", formula: "1" },
    { id: "cost-two", resourceKey: "health", formula: "1" }
  ], { defaultType: "actorResource" });

  assert.equal(data.specialProperties[0].attackPower.resourceCosts[0].resourceKey, "health");
  assert.equal(data.criticalFailureConsequences[0].resourceKey, "health");
});

test("deleting the final base cost removes its Attack Power and critical references", () => {
  const data = {
    resourceCosts: [],
    specialProperties: [{
      type: "attackPower",
      attackPower: {
        resourceCosts: [{
          type: "actorResource",
          resourceKey: "health",
          amount: 3
        }]
      }
    }],
    snapshot: {
      criticalFailureConsequences: [{
        id: "critical-one",
        resourceType: "actorResource",
        resourceKey: "health",
        amount: 2
      }]
    }
  };

  reconcileWeaponResourceCostReferences(data, [{
    id: "cost-one",
    type: "actorResource",
    resourceKey: "health",
    formula: "2"
  }]);

  assert.deepEqual(data.specialProperties[0].attackPower.resourceCosts, []);
  assert.deepEqual(data.snapshot.criticalFailureConsequences, []);
});
