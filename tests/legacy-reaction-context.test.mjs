import assert from "node:assert/strict";
import test from "node:test";

import { serializeLegacyReactionContext } from "../src/events/legacy-reaction-context.mjs";

test("legacy reaction bridge keeps only its explicit primitive/UUID/chainRef contract", () => {
  class FakeDocument {}
  const context = serializeLegacyReactionContext("weaponAttackResolved", {
    attackId: "attack-1",
    attackerActorUuid: "Actor.attacker",
    attackerTokenUuid: "Scene.scene.Token.attacker",
    targetTokenUuids: ["Scene.scene.Token.target"],
    title: "Counterattack",
    chainRef: {
      version: 1,
      rootId: "root-1",
      leaseId: "lease-1",
      parentEventId: null,
      executionToken: ""
    },
    reactionCoordinator: { run: () => undefined },
    document: new FakeDocument(),
    arbitraryNestedData: { unsafe: true }
  });

  assert.deepEqual(context, {
    title: "Counterattack",
    attackId: "attack-1",
    attackerActorUuid: "Actor.attacker",
    attackerTokenUuid: "Scene.scene.Token.attacker",
    targetTokenUuids: ["Scene.scene.Token.target"],
    chainRef: {
      version: 1,
      rootId: "root-1",
      leaseId: "lease-1",
      parentEventId: null,
      executionToken: ""
    }
  });
  assert.equal(Object.hasOwn(context, "reactionCoordinator"), false);
  assert.equal(Object.hasOwn(context, "document"), false);
  assert.equal(Object.hasOwn(context, "arbitraryNestedData"), false);
});

test("legacy reaction bridge rejects invalid values on allow-listed fields without coercion", () => {
  assert.throws(
    () => serializeLegacyReactionContext("weaponAttackTargeted", { attackerActorUuid: { uuid: "Actor.A" } }),
    /JSON primitive/i
  );
  assert.throws(
    () => serializeLegacyReactionContext("weaponAttackResolved", { targetTokenUuids: new Set(["Token.A"]) }),
    /array of strings/i
  );
  assert.throws(
    () => serializeLegacyReactionContext("tokenLeavingAdjacency", {
      movementId: "move",
      chainRef: { version: 1, rootId: "", leaseId: "lease" }
    }),
    /rootId is required/i
  );
  assert.throws(() => serializeLegacyReactionContext("unknownLegacyEvent", {}), /Unsupported legacy reaction event/i);
});
