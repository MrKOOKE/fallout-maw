/**
 * Atomically transfer Token documents between Scenes using Foundry V14's batch
 * document API. Destination IDs are allocated before the request so delete
 * operations can advertise replacement UUIDs to dependent documents such as
 * Combatants.
 *
 * @param {object} options
 * @param {Scene} options.originScene
 * @param {Scene} options.targetScene
 * @param {TokenDocument[]} options.tokenDocuments
 * @param {object[]|function(TokenDocument, number): object} [options.destinationUpdates]
 * @param {object[]} [options.actorUpdates]
 * @param {object} [options.operationOptions]
 * @returns {Promise<{
 *   tokenMap: Map<TokenDocument, TokenDocument>,
 *   transfers: object[],
 *   createdTokens: TokenDocument[],
 *   destinationUuids: Map<TokenDocument, string>,
 *   results: Document[][]
 * }>}
 */
export async function transferTokensBetweenScenes({
  originScene,
  targetScene,
  tokenDocuments,
  destinationUpdates = [],
  actorUpdates = [],
  operationOptions = {}
} = {}) {
  validateTransferScenes(originScene, targetScene);
  const tokens = normalizeSourceTokens(originScene, tokenDocuments);
  if (!tokens.length) return emptyTransferResult();

  const takenIds = collectTokenIds(targetScene);
  const plans = tokens.map((token, index) => {
    const destinationId = allocateDestinationId(token.id, targetScene, takenIds);
    takenIds.add(destinationId);
    const destinationUuid = buildDestinationTokenUuid(targetScene, destinationId);
    const updates = resolveDestinationUpdates(destinationUpdates, token, index);
    return {
      sourceToken: token,
      destinationId,
      destinationUuid,
      createData: createDestinationTokenData(token, destinationId, updates)
    };
  });

  const sharedOptions = normalizeOperationOptions(operationOptions);
  const operations = [];
  const createOperationIndex = operations.push(withOperationOptions(sharedOptions, {
    action: "create",
    documentName: "Token",
    parent: targetScene,
    data: plans.map(plan => plan.createData),
    keepId: true
  })) - 1;

  const normalizedActorUpdates = normalizeActorUpdates(actorUpdates);
  if (normalizedActorUpdates.length) {
    operations.push(withOperationOptions(sharedOptions, {
      action: "update",
      documentName: "Actor",
      updates: normalizedActorUpdates
    }));
  }

  operations.push(withOperationOptions(sharedOptions, {
    action: "delete",
    documentName: "Token",
    parent: originScene,
    ids: plans.map(plan => plan.sourceToken.id),
    replacements: Object.fromEntries(plans.map(plan => [plan.sourceToken.id, plan.destinationUuid]))
  }));

  const results = await foundry.documents.modifyBatch(operations);
  assertCompleteTransferResults(results, operations, {
    createCount: plans.length,
    actorUpdateCount: normalizedActorUpdates.length,
    deleteCount: plans.length
  });
  const createdResult = Array.isArray(results?.[createOperationIndex]) ? results[createOperationIndex] : [];
  const createdById = new Map(createdResult.filter(Boolean).map(token => [token.id, token]));
  const tokenMap = new Map();
  const destinationUuids = new Map();
  const transfers = plans.map(plan => {
    const destinationToken = resolveCreatedToken(targetScene, plan, createdById);
    destinationUuids.set(plan.sourceToken, plan.destinationUuid);
    if (destinationToken) tokenMap.set(plan.sourceToken, destinationToken);
    return {
      sourceToken: plan.sourceToken,
      destinationId: plan.destinationId,
      destinationUuid: plan.destinationUuid,
      destinationToken
    };
  });
  if (transfers.some(entry => !entry.destinationToken)) {
    throw new Error("Foundry did not resolve every destination Token in the transfer batch.");
  }
  const createdTokens = transfers.map(entry => entry.destinationToken).filter(Boolean);
  return { tokenMap, transfers, createdTokens, destinationUuids, results };
}

function validateTransferScenes(originScene, targetScene) {
  if (!originScene || !targetScene) throw new TypeError("Both originScene and targetScene are required.");
  if (originScene === targetScene || (originScene.id && originScene.id === targetScene.id)) {
    throw new TypeError("Cross-scene token transfer requires two different Scenes.");
  }
}

function normalizeSourceTokens(originScene, tokenDocuments) {
  const tokens = Array.from(tokenDocuments ?? []).filter(Boolean);
  const seen = new Set();
  for (const token of tokens) {
    if (!token.id) throw new TypeError("Every source Token must have an id.");
    if (token.parent !== originScene && token.parent?.id !== originScene.id) {
      throw new TypeError(`Token ${token.id} does not belong to the origin Scene.`);
    }
    if (seen.has(token.id)) throw new TypeError(`Duplicate source Token id: ${token.id}.`);
    seen.add(token.id);
  }
  return tokens;
}

function collectTokenIds(scene) {
  if (scene.tokens?.keys) return new Set(scene.tokens.keys());
  return new Set((scene.tokens?.contents ?? []).map(token => token.id).filter(Boolean));
}

function allocateDestinationId(preferredId, targetScene, takenIds) {
  if (preferredId && !targetScene.tokens?.has?.(preferredId) && !takenIds.has(preferredId)) return preferredId;
  let destinationId;
  do destinationId = foundry.utils.randomID();
  while (!destinationId || takenIds.has(destinationId) || targetScene.tokens?.has?.(destinationId));
  return destinationId;
}

function buildDestinationTokenUuid(scene, id) {
  if (typeof foundry.utils.buildUuid === "function") {
    return foundry.utils.buildUuid({ id, documentName: "Token", parent: scene });
  }
  return `${scene.uuid}.Token.${id}`;
}

function resolveDestinationUpdates(destinationUpdates, token, index) {
  const value = typeof destinationUpdates === "function"
    ? destinationUpdates(token, index)
    : destinationUpdates?.[index];
  return value && typeof value === "object" ? value : {};
}

function createDestinationTokenData(token, destinationId, updates) {
  const source = token.toObject();
  const data = foundry.utils.mergeObject(source, foundry.utils.deepClone(updates), { inplace: false });
  delete data.id;
  data._id = destinationId;
  return data;
}

function normalizeActorUpdates(actorUpdates) {
  return Array.from(actorUpdates ?? []).filter(Boolean).map(entry => {
    if (entry.actor && entry.changes) {
      return { ...foundry.utils.deepClone(entry.changes), _id: entry.actor.id };
    }
    return foundry.utils.deepClone(entry);
  }).filter(update => update._id);
}

function normalizeOperationOptions(operationOptions) {
  return operationOptions && typeof operationOptions === "object" ? { ...operationOptions } : {};
}

function withOperationOptions(options, operation) {
  return { ...options, ...operation };
}

function resolveCreatedToken(targetScene, plan, createdById) {
  return createdById.get(plan.destinationId)
    ?? targetScene.tokens?.get?.(plan.destinationId)
    ?? foundry.utils.fromUuidSync?.(plan.destinationUuid)
    ?? null;
}

function emptyTransferResult() {
  return {
    tokenMap: new Map(),
    transfers: [],
    createdTokens: [],
    destinationUuids: new Map(),
    results: []
  };
}

function assertCompleteTransferResults(results, operations, {
  createCount,
  actorUpdateCount,
  deleteCount
}) {
  if (!Array.isArray(results) || results.length !== operations.length || results.some(result => !Array.isArray(result))) {
    throw new Error("Foundry returned an incomplete cross-scene transfer batch.");
  }
  let index = 0;
  if (results[index++].length !== createCount) {
    throw new Error("Foundry did not create every destination Token in the transfer batch.");
  }
  if (actorUpdateCount && results[index++].length !== actorUpdateCount) {
    throw new Error("Foundry did not update every travel-group Actor in the transfer batch.");
  }
  if (results[index].length !== deleteCount) {
    throw new Error("Foundry did not delete every source Token in the transfer batch.");
  }
}
