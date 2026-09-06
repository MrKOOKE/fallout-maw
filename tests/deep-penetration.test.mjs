import assert from "node:assert/strict";
import test from "node:test";

import {
  extractDeepPenetrationDamageRows,
  getConvertibleDeepPenetrationDamageRows,
  selectDeepPenetrationTargetRows
} from "../src/abilities/deep-penetration.mjs";

test("Deep Penetration extracts per-impact facts from a damage-hub batch result", () => {
  const rows = extractDeepPenetrationDamageRows([{
    actor: { uuid: "Actor.target" },
    incomingAmount: 119,
    mitigationBlocked: 53,
    damageApplications: [{
      damageEventIndex: 0,
      limbKey: "leftArm",
      damageTypeKey: "fractional",
      incomingAmount: 119,
      damageMitigationDisplay: { blocked: 53 },
      source: {
        targetTokenUuid: "Scene.scene.Token.target",
        penetrationPower: 7,
        pelletImpactCount: 4,
        pelletImpactIndex: 0
      }
    }]
  }]);

  assert.deepEqual(rows, [{
    actorUuid: "Actor.target",
    targetTokenUuid: "Scene.scene.Token.target",
    limbKey: "leftArm",
    damageTypeKey: "fractional",
    incomingAmount: 119,
    mitigationBlocked: 53,
    penetrationPower: 7,
    pelletImpactCount: 4,
    pelletImpactIndex: 0
  }]);
  assert.equal(getConvertibleDeepPenetrationDamageRows(rows, 70)[0].convertedAmount, 53);
});

test("Deep Penetration accepts every positive blocked percentage and applies the conversion cap", () => {
  const source = { actorUuid: "Actor.target", damageTypeKey: "slashing", incomingAmount: 100 };

  assert.deepEqual(getConvertibleDeepPenetrationDamageRows([{ ...source, mitigationBlocked: 0 }], 40), []);
  assert.equal(getConvertibleDeepPenetrationDamageRows([{ ...source, mitigationBlocked: 1 }], 40)[0].convertedAmount, 1);
  assert.equal(getConvertibleDeepPenetrationDamageRows([{ ...source, mitigationBlocked: 40 }], 40)[0].convertedAmount, 40);
  assert.equal(getConvertibleDeepPenetrationDamageRows([{ ...source, mitigationBlocked: 41 }], 40)[0].convertedAmount, 40);
  assert.equal(getConvertibleDeepPenetrationDamageRows([{ ...source, mitigationBlocked: 100 }], 40)[0].convertedAmount, 40);
});

test("Deep Penetration distributes one aggregate cap across damage types and pellets", () => {
  const rows = getConvertibleDeepPenetrationDamageRows([
    {
      actorUuid: "Actor.target",
      targetTokenUuid: "Scene.scene.Token.target",
      limbKey: "leftArm",
      damageTypeKey: "slashing",
      incomingAmount: 50,
      mitigationBlocked: 25,
      penetrationPower: 12,
      pelletImpactCount: 4,
      pelletImpactIndex: 0
    },
    {
      actorUuid: "Actor.target",
      targetTokenUuid: "Scene.scene.Token.target",
      limbKey: "torso",
      damageTypeKey: "bludgeoning",
      incomingAmount: 50,
      mitigationBlocked: 20,
      penetrationPower: 4,
      pelletImpactCount: 4,
      pelletImpactIndex: 1
    }
  ], 40);

  assert.equal(rows.reduce((sum, row) => sum + row.convertedAmount, 0), 40);
  assert.deepEqual(rows.map(row => row.convertedAmount), [22, 18]);
  assert.deepEqual(rows.map(row => [row.pelletImpactCount, row.pelletImpactIndex]), [[4, 0], [4, 1]]);
});

test("Deep Penetration uses only the original target when it has blocked damage", () => {
  const rows = [
    { actorUuid: "Actor.primary", targetTokenUuid: "Token.primary", damageTypeKey: "slashing", incomingAmount: 100, mitigationBlocked: 50 },
    { actorUuid: "Actor.secondary", targetTokenUuid: "Token.secondary", damageTypeKey: "slashing", incomingAmount: 100, mitigationBlocked: 30 }
  ];
  const selected = selectDeepPenetrationTargetRows(rows, 40, {
    primaryActorUuid: "Actor.primary",
    primaryTokenUuid: "Token.primary",
    targetTokenUuids: ["Token.primary", "Token.secondary"]
  });

  assert.deepEqual(selected.map(row => row.actorUuid), ["Actor.primary"]);
  assert.equal(selected[0].convertedAmount, 40);
});

test("Deep Penetration falls back to one living secondary target", () => {
  const rows = [
    { actorUuid: "Actor.primary", targetTokenUuid: "Token.primary", damageTypeKey: "slashing", incomingAmount: 100, mitigationBlocked: 0 },
    { actorUuid: "Actor.dead", targetTokenUuid: "Token.dead", damageTypeKey: "slashing", incomingAmount: 100, mitigationBlocked: 50 },
    { actorUuid: "Actor.secondary", targetTokenUuid: "Token.secondary", damageTypeKey: "slashing", incomingAmount: 100, mitigationBlocked: 30 },
    { actorUuid: "Actor.other", targetTokenUuid: "Token.other", damageTypeKey: "slashing", incomingAmount: 100, mitigationBlocked: 20 }
  ];
  const selected = selectDeepPenetrationTargetRows(rows, 40, {
    primaryActorUuid: "Actor.primary",
    primaryTokenUuid: "Token.primary",
    targetTokenUuids: ["Token.primary", "Token.dead", "Token.secondary", "Token.other"],
    killedActorUuids: ["Actor.dead"]
  });

  assert.deepEqual(selected.map(row => row.actorUuid), ["Actor.secondary"]);
  assert.equal(selected[0].convertedAmount, 30);
});
