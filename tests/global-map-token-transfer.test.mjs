import assert from "node:assert/strict";
import test from "node:test";

import { transferTokensBetweenScenes } from "../src/global-map/token-transfer.mjs";

function installFoundryMock({ randomIds = [], modifyBatch } = {}) {
  const ids = [...randomIds];
  globalThis.foundry = {
    documents: { modifyBatch },
    utils: {
      buildUuid: ({ id, documentName, parent }) => `${parent.uuid}.${documentName}.${id}`,
      deepClone: value => structuredClone(value),
      fromUuidSync: () => null,
      mergeObject: (source, updates, { inplace = true } = {}) => {
        const target = inplace ? source : structuredClone(source);
        return merge(target, updates);
      },
      randomID: () => ids.shift() ?? "random-id"
    }
  };
}

function merge(target, source) {
  for (const [key, value] of Object.entries(source ?? {})) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      target[key] = merge(target[key] && typeof target[key] === "object" ? target[key] : {}, value);
    } else target[key] = value;
  }
  return target;
}

function makeScene(id, tokens = []) {
  const collection = new Map(tokens.map(token => [token.id, token]));
  return { id, uuid: `Scene.${id}`, tokens: collection };
}

function makeToken(id, parent, data = {}) {
  return {
    id,
    parent,
    toObject: () => structuredClone({
      _id: id,
      name: `Token ${id}`,
      x: 10,
      y: 20,
      texture: { src: "token.webp", scaleX: 1 },
      ...data
    })
  };
}

test("cross-scene transfer preserves an available Token id and batches route flags atomically", async () => {
  const originScene = makeScene("origin");
  const targetScene = makeScene("target");
  const sourceToken = makeToken("token-a", originScene);
  originScene.tokens.set(sourceToken.id, sourceToken);
  const actorUpdate = { _id: "actor-a", "flags.fallout-maw.travelGroup.currentSceneId": targetScene.id };
  const chainRef = { rootId: "chain-a" };
  let captured;
  const createdToken = { id: sourceToken.id, parent: targetScene };
  installFoundryMock({
    modifyBatch: async operations => {
      captured = operations;
      return [[createdToken], [{ id: "actor-a" }], [sourceToken]];
    }
  });

  const result = await transferTokensBetweenScenes({
    originScene,
    targetScene,
    tokenDocuments: [sourceToken],
    destinationUpdates: [{ x: 300, y: 400, texture: { scaleX: -1 } }],
    actorUpdates: [actorUpdate],
    operationOptions: {
      falloutMawTravelGroupBypass: true,
      falloutMawSystemEventChainRef: chainRef,
      chainRef
    }
  });

  assert.equal(captured.length, 3);
  assert.deepEqual(captured.map(operation => operation.action), ["create", "update", "delete"]);
  assert.equal(captured[0].keepId, true);
  assert.equal(captured[0].data[0]._id, sourceToken.id);
  assert.equal(captured[0].data[0].x, 300);
  assert.equal(captured[0].data[0].y, 400);
  assert.equal(captured[0].data[0].texture.src, "token.webp");
  assert.equal(captured[0].data[0].texture.scaleX, -1);
  assert.deepEqual(captured[1].updates, [actorUpdate]);
  assert.deepEqual(captured[2].replacements, {
    [sourceToken.id]: `Scene.target.Token.${sourceToken.id}`
  });
  for (const operation of captured) {
    assert.equal(operation.falloutMawTravelGroupBypass, true);
    assert.equal(operation.chainRef, chainRef);
    assert.equal(operation.falloutMawSystemEventChainRef, chainRef);
  }
  assert.equal(result.tokenMap.get(sourceToken), createdToken);
  assert.equal(result.createdTokens[0], createdToken);
  assert.equal(result.destinationUuids.get(sourceToken), `Scene.target.Token.${sourceToken.id}`);
});

test("cross-scene transfer allocates a fresh id on collision and resolves created Token from its Scene", async () => {
  const originScene = makeScene("origin");
  const collidingToken = { id: "token-a" };
  const alsoTaken = { id: "random-taken" };
  const targetScene = makeScene("target", [collidingToken, alsoTaken]);
  const sourceToken = makeToken("token-a", originScene);
  originScene.tokens.set(sourceToken.id, sourceToken);
  let captured;
  installFoundryMock({
    randomIds: ["random-taken", "token-b"],
    modifyBatch: async operations => {
      captured = operations;
      const created = { id: operations[0].data[0]._id, parent: targetScene };
      targetScene.tokens.set(created.id, created);
      return [[created], [sourceToken]];
    }
  });

  const result = await transferTokensBetweenScenes({
    originScene,
    targetScene,
    tokenDocuments: [sourceToken],
    destinationUpdates: () => ({ x: 42, y: 84 })
  });

  assert.equal(captured[0].data[0]._id, "token-b");
  assert.deepEqual(captured[1].replacements, { "token-a": "Scene.target.Token.token-b" });
  assert.equal(result.transfers[0].destinationId, "token-b");
  assert.equal(result.transfers[0].destinationToken, targetScene.tokens.get("token-b"));
});

test("cross-scene transfer rejects invalid sources before writing", async () => {
  const originScene = makeScene("origin");
  const targetScene = makeScene("target");
  const foreignScene = makeScene("foreign");
  const foreignToken = makeToken("token-a", foreignScene);
  let calls = 0;
  installFoundryMock({ modifyBatch: async () => { calls += 1; return []; } });

  await assert.rejects(
    transferTokensBetweenScenes({ originScene, targetScene, tokenDocuments: [foreignToken] }),
    /does not belong to the origin Scene/
  );
  await assert.rejects(
    transferTokensBetweenScenes({ originScene, targetScene: originScene, tokenDocuments: [] }),
    /requires two different Scenes/
  );
  assert.equal(calls, 0);
});

test("cross-scene transfer rejects a resolved but incomplete Foundry batch", async () => {
  const originScene = makeScene("origin");
  const targetScene = makeScene("target");
  const sourceToken = makeToken("token-a", originScene);
  originScene.tokens.set(sourceToken.id, sourceToken);
  installFoundryMock({ modifyBatch: async () => [[{ id: sourceToken.id }]] });

  await assert.rejects(
    transferTokensBetweenScenes({ originScene, targetScene, tokenDocuments: [sourceToken] }),
    /incomplete cross-scene transfer batch/
  );

  installFoundryMock({ modifyBatch: async () => [[null], [sourceToken]] });
  await assert.rejects(
    transferTokensBetweenScenes({ originScene, targetScene, tokenDocuments: [sourceToken] }),
    /did not resolve every destination Token/
  );
});
