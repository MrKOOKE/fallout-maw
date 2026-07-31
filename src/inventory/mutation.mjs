import { getCreatureOptions } from "../settings/accessors.mjs";
import {
  getActorInventoryGridDimensions,
  getActorRootInventoryGridOptions
} from "../utils/actor-display-data.mjs";
import { createActorOperationLock } from "../utils/actor-operation-lock.mjs";
import {
  getItemActorLoadWeight,
  getItemContainerParentId,
  getItemDeletionClosureIds,
  getItemId,
  validateInventoryTree
} from "../utils/inventory-containers.mjs";
import {
  INVENTORY_ATOMIC_OPTION,
  INVENTORY_EXPECTED_IDS_OPTION
} from "./constants.mjs";
import { validateActorNonInventoryPlacementState } from "./repair.mjs";

const inventoryActorLock = createActorOperationLock();

/**
 * Execute one logical inventory mutation through Foundry's V14 batch API.
 *
 * Every caller supplies domain data only. This function owns ID allocation,
 * container-delete expansion, final-state validation, pre-hook completeness
 * guards, serialization and post-commit verification.
 *
 * @param {object|object[]} input
 * @param {Actor} input.actor
 * @param {object[]} [input.updates]
 * @param {string[]} [input.deletes]
 * @param {object[]} [input.creates]
 * @param {object|object[]} [input.actorUpdates]
 * @param {object} [options]
 * @param {boolean} [options.validate]
 * @param {boolean} [options.render]
 * @param {string} [options.reason]
 * @param {object} [options.documentOptions]
 * @returns {Promise<object>}
 */
export async function executeInventoryMutation(input, {
  validate = true,
  validateLoad = true,
  render = true,
  reason = "inventory",
  documentOptions = {}
} = {}) {
  const plans = normalizeInventoryMutationPlans(input);
  if (!plans.length) return createEmptyMutationResult(reason);

  const actors = plans
    .map(plan => plan.actor)
    .sort((left, right) => getActorKey(left).localeCompare(getActorKey(right)));
  return runWithActorLocks(
    actors,
    () => executePreparedMutation(plans, {
      validate,
      validateLoad,
      render,
      reason,
      documentOptions
    })
  );
}

/**
 * Normalize and combine plans which target the same Actor. Exported so tests
 * can assert that every UI surface produces the same domain mutation.
 */
export function normalizeInventoryMutationPlans(input) {
  const rawPlans = Array.isArray(input) ? input : [input];
  const grouped = new Map();

  for (const rawPlan of rawPlans.filter(Boolean)) {
    const actor = resolveInventoryActor(rawPlan.actor);
    const actorKey = getActorKey(actor);
    if (!actor || actor?.documentName !== "Actor" || !actorKey) {
      throw new TypeError("An Actor-owned inventory mutation requires a valid Actor.");
    }

    const plan = grouped.get(actorKey) ?? {
      actor,
      updates: [],
      deletes: [],
      creates: [],
      actorUpdates: [],
      expectedItems: null
    };
    if (plan.actor !== actor && plan.actor?.uuid !== actor?.uuid) {
      throw new TypeError(`Inventory mutation Actor key collision: ${actorKey}.`);
    }
    plan.updates.push(...asArray(rawPlan.updates));
    plan.deletes.push(...asArray(rawPlan.deletes));
    plan.creates.push(...asArray(rawPlan.creates));
    plan.actorUpdates.push(...asArray(rawPlan.actorUpdates ?? rawPlan.actorUpdate));
    if (rawPlan.expectedItems !== undefined && rawPlan.expectedItems !== null) {
      if (plan.expectedItems !== null) {
        throw new TypeError("Only one expected Item snapshot may be supplied per Actor mutation.");
      }
      plan.expectedItems = asArray(rawPlan.expectedItems).map(toPlainObject);
    }
    grouped.set(actorKey, plan);
  }

  return Array.from(grouped.values()).map(prepareActorMutationPlan);
}

/**
 * Project an Actor's item collection without writing it.
 */
export function projectActorInventoryState(actor, {
  updates = [],
  deletes = [],
  creates = []
} = {}) {
  const itemMap = new Map(getActorItems(actor).map(item => {
    const data = toPlainObject(item);
    return [getItemId(data), data];
  }));

  for (const update of mergeInventoryUpdates(updates)) {
    if (!update?._id || !itemMap.has(String(update._id))) continue;
    itemMap.set(String(update._id), applyDocumentUpdate(itemMap.get(String(update._id)), update));
  }
  for (const deleteId of new Set(asArray(deletes).map(String).filter(Boolean))) itemMap.delete(deleteId);
  for (const createData of creates) {
    const data = toPlainObject(createData);
    const itemId = getItemId(data);
    if (!itemId) throw new TypeError("Projected inventory create data requires an _id.");
    data._id = itemId;
    delete data.id;
    itemMap.set(itemId, data);
  }
  return Array.from(itemMap.values());
}

/**
 * Expand requested container deletions to a complete, cycle-safe subtree.
 */
export function expandInventoryDeleteIds(items, deleteIds = []) {
  const itemList = Array.from(items?.contents ?? items ?? []);
  return getItemDeletionClosureIds(
    asArray(deleteIds).map(String).filter(Boolean),
    itemList
  );
}

/**
 * Validate topology, placement, capacity and Actor carrying load for a
 * projected collection.
 */
export function validateActorInventoryState(actor, projectedItems, { validateLoad = true } = {}) {
  const raceId = String(actor?.system?.creature?.raceId ?? "");
  const race = getCreatureOptions().races.find(entry => String(entry.id) === raceId);
  const dimensions = getActorInventoryGridDimensions(actor, race);
  const treeValidation = validateInventoryTree(projectedItems, dimensions, {
    rootOptions: getActorRootInventoryGridOptions(actor, "")
  });
  if (!treeValidation.valid) throw createInventoryValidationError(treeValidation);
  const nonInventoryValidation = validateActorNonInventoryPlacementState(
    actor,
    projectedItems,
    race
  );
  if (!nonInventoryValidation.valid) {
    throw createInventoryValidationError(nonInventoryValidation);
  }

  if (!validateLoad) return true;
  const loadValidation = validateActorLoadLimit(actor, projectedItems);
  if (!loadValidation.valid) {
    const error = new Error(localize(
      "FALLOUTMAW.Messages.ActorLoadLimitExceeded",
      "Actor inventory exceeds its carrying limit."
    ));
    error.code = "actor-load-limit";
    error.validation = loadValidation;
    throw error;
  }
  return true;
}

async function executePreparedMutation(plans, {
  validate,
  validateLoad,
  render,
  reason,
  documentOptions
}) {
  const operationId = createOperationId();
  assertMutationPlansFresh(plans);
  if (validate) {
    for (const plan of plans) {
      validateActorInventoryState(plan.actor, plan.projectedItems, { validateLoad });
    }
  }

  const { operations, operationMeta } = createFoundryBatchOperations(plans, {
    operationId,
    reason,
    render,
    documentOptions
  });
  if (!operations.length) {
    return {
      ...createEmptyMutationResult(reason),
      operationId,
      plans
    };
  }

  let results;
  try {
    results = await foundry.documents.modifyBatch(operations);
    assertCompleteBatchResults(results, operationMeta, plans, { validateLoad });
  } catch (error) {
    const recoveryError = await recoverPartialInventoryMutation(plans, { operationId, reason });
    if (recoveryError) {
      console.error("Fallout MaW | Inventory mutation recovery failed.", recoveryError);
      const aggregate = new AggregateError(
        [error, recoveryError],
        "Inventory operation failed and its previous state could not be fully restored."
      );
      aggregate.cause = error;
      throw aggregate;
    }
    throw error;
  }

  return {
    operationId,
    reason,
    results,
    plans,
    createdDocuments: plans.flatMap(plan => (
      plan.creates
        .map(data => plan.actor.items?.get?.(data._id))
        .filter(Boolean)
    ))
  };
}

function assertMutationPlansFresh(plans) {
  for (const plan of plans) {
    const currentItems = getActorItems(plan.actor);
    const currentById = new Map(currentItems.map(item => [getItemId(item), item]));
    if (
      currentById.size !== plan.expectedSnapshotById.size
      || Array.from(plan.expectedSnapshotById).some(([itemId, snapshot]) => {
        const current = currentById.get(itemId);
        return !current || !inventorySnapshotsEqual(current, snapshot);
      })
      || hasActorUpdateDrift(plan)
    ) {
      throw createInventoryStaleError();
    }
  }
}

function prepareActorMutationPlan(rawPlan) {
  const actor = rawPlan.actor;
  const {
    update: actorUpdate,
    recoveryUpdate: actorRecoveryUpdate,
    paths: actorUpdatePaths,
    snapshotByPath: actorSnapshotByPath
  } = prepareActorUpdatePlan(actor, rawPlan.actorUpdates);
  const snapshots = getActorItems(actor).map(toPlainObject);
  const snapshotById = new Map(snapshots.map(item => [getItemId(item), item]));
  const expectedSnapshots = rawPlan.expectedItems ?? snapshots;
  const expectedSnapshotById = new Map(
    expectedSnapshots.map(item => [getItemId(item), toPlainObject(item)])
  );
  const updates = mergeInventoryUpdates(rawPlan.updates);
  const requestedDeleteIds = Array.from(new Set(
    asArray(rawPlan.deletes).map(String).filter(Boolean)
  ));
  const missingItemIds = [
    ...updates
      .map(update => String(update?._id ?? ""))
      .filter(itemId => itemId && !snapshotById.has(itemId)),
    ...requestedDeleteIds.filter(itemId => !snapshotById.has(itemId))
  ];
  if (missingItemIds.length) {
    throw createInventoryStaleError(
      `Inventory mutation refers to missing Items: ${Array.from(new Set(missingItemIds)).join(", ")}.`
    );
  }

  const updatedBeforeDelete = projectActorInventoryState(actor, { updates });
  const deletes = expandInventoryDeleteIds(updatedBeforeDelete, requestedDeleteIds);
  const deleteSet = new Set(deletes);
  const survivingUpdates = updates.filter(update => !deleteSet.has(String(update._id)));
  const {
    creates,
    createIdMap
  } = allocateInventoryCreateIds(actor, rawPlan.creates);
  const projectedItems = projectActorInventoryState(actor, {
    updates: survivingUpdates,
    deletes,
    creates
  });
  const touchedExistingIds = new Set([
    ...survivingUpdates.map(update => String(update._id)),
    ...deletes
  ]);

  return {
    actor,
    snapshots,
    snapshotById,
    expectedSnapshotById,
    updates: survivingUpdates,
    deletes,
    creates,
    createIdMap,
    projectedItems,
    touchedExistingIds,
    actorSnapshotByPath,
    actorUpdate,
    actorRecoveryUpdate,
    actorUpdatePaths
  };
}

function prepareActorUpdatePlan(actor, rawUpdates = []) {
  const flattened = {};
  for (const rawUpdate of asArray(rawUpdates).filter(Boolean)) {
    const update = toPlainObject(rawUpdate);
    delete update._id;
    for (const [path, value] of Object.entries(flattenUpdateObject(update))) {
      if (!path || path.split(".").some(part => part.startsWith("-="))) {
        throw new TypeError("Inventory Actor updates do not support deletion operators.");
      }
      flattened[path] = cloneValue(value);
    }
  }

  const update = { _id: String(actor.id ?? "") };
  const recoveryUpdate = { _id: String(actor.id ?? "") };
  const paths = [];
  const snapshotByPath = new Map();
  for (const [path, value] of Object.entries(flattened)) {
    const current = getProperty(getActorSource(actor), path);
    if (current.exists && deepEqual(current.value, value)) continue;
    update[path] = cloneValue(value);
    paths.push(path);
    snapshotByPath.set(path, {
      exists: current.exists,
      value: current.exists ? cloneValue(current.value) : undefined
    });
    if (current.exists) recoveryUpdate[path] = cloneValue(current.value);
    else recoveryUpdate[toDeletionUpdatePath(path)] = null;
  }
  return { update, recoveryUpdate, paths, snapshotByPath };
}

function allocateInventoryCreateIds(actor, rawCreates) {
  const creates = asArray(rawCreates).filter(Boolean).map(toPlainObject);
  const takenIds = new Set(getActorItems(actor).map(getItemId).filter(Boolean));
  const createIdMap = new Map();
  const sourceIds = new Set();

  for (const createData of creates) {
    const sourceId = getItemId(createData);
    if (sourceId && sourceIds.has(sourceId)) {
      throw new TypeError(`Inventory create data contains duplicate source Item ID "${sourceId}".`);
    }
    if (sourceId) sourceIds.add(sourceId);
    const destinationId = allocateItemId(takenIds);
    takenIds.add(destinationId);
    if (sourceId) createIdMap.set(sourceId, destinationId);
    createData._id = destinationId;
    delete createData.id;
  }

  for (const createData of creates) {
    const parentId = getItemContainerParentId(createData);
    if (!parentId || !createIdMap.has(parentId)) continue;
    setProperty(createData, "system.container.parentId", createIdMap.get(parentId));
  }
  return { creates, createIdMap };
}

function createFoundryBatchOperations(plans, {
  operationId,
  reason,
  render,
  documentOptions
}) {
  const operations = [];
  const operationMeta = [];
  const forwardedOptions = sanitizeInventoryDocumentOptions(documentOptions);

  for (const plan of plans) {
    const planOperations = [];
    // Foundry applies and handles modifyBatch results in request order. Every
    // embedded create/delete resets the parent Actor, so commit Item updates
    // after collection-shape changes and leave their source as the final state.
    if (plan.deletes.length) {
      planOperations.push({
        action: "delete",
        documentName: "Item",
        parent: plan.actor,
        ids: [...plan.deletes],
        expectedIds: [...plan.deletes]
      });
    }
    if (plan.creates.length) {
      planOperations.push({
        action: "create",
        documentName: "Item",
        parent: plan.actor,
        data: cloneValue(plan.creates),
        keepId: true,
        expectedIds: plan.creates.map(data => String(data._id))
      });
    }
    if (plan.updates.length) {
      planOperations.push({
        action: "update",
        documentName: "Item",
        parent: plan.actor,
        updates: cloneValue(plan.updates),
        expectedIds: plan.updates.map(update => String(update._id))
      });
    }
    if (plan.actorUpdatePaths.length) {
      planOperations.push({
        action: "update",
        documentName: "Actor",
        ...(plan.actor.parent ? { parent: plan.actor.parent } : {}),
        updates: [cloneValue(plan.actorUpdate)],
        expectedIds: [String(plan.actor.id ?? "")],
        strictIds: false
      });
    }

    for (let index = 0; index < planOperations.length; index += 1) {
      const operation = planOperations[index];
      const expectedIds = operation.expectedIds;
      const strictIds = operation.strictIds !== false;
      delete operation.expectedIds;
      delete operation.strictIds;
      Object.assign(operation, {
        ...cloneValue(forwardedOptions),
        render: Boolean(render && index === (planOperations.length - 1)),
        falloutMawInventoryOperationId: operationId,
        falloutMawInventoryReason: reason
      });
      if (operation.action === "update") operation.diff = false;
      if (operation.documentName === "Item") {
        operation[INVENTORY_ATOMIC_OPTION] = true;
        operation[INVENTORY_EXPECTED_IDS_OPTION] = expectedIds;
      }
      operations.push(operation);
      operationMeta.push({
        action: operation.action,
        documentName: operation.documentName,
        actor: plan.actor,
        expectedIds,
        strictIds
      });
    }
  }
  return { operations, operationMeta };
}

function sanitizeInventoryDocumentOptions(options = {}) {
  const forwarded = isPlainObject(options) ? cloneValue(options) : {};
  const protectedKeys = [
    "action",
    "documentName",
    "parent",
    "parentUuid",
    "updates",
    "ids",
    "data",
    "deleteAll",
    "keepId",
    "diff",
    "render",
    INVENTORY_ATOMIC_OPTION,
    INVENTORY_EXPECTED_IDS_OPTION,
    "falloutMawInventoryOperationId",
    "falloutMawInventoryReason",
    "falloutMawInventoryRecovery"
  ];
  for (const key of protectedKeys) delete forwarded[key];
  return forwarded;
}

function assertCompleteBatchResults(results, operationMeta, plans, { validateLoad = true } = {}) {
  if (
    !Array.isArray(results)
    || results.length > operationMeta.length
    || results.some(result => !Array.isArray(result))
  ) {
    throw new Error("Foundry returned an incomplete inventory operation batch.");
  }

  let shortResponse = results.length < operationMeta.length;
  if (!shortResponse) {
    for (let index = 0; index < operationMeta.length; index += 1) {
      const result = results[index];
      const meta = operationMeta[index];
      if (result.length > meta.expectedIds.length) {
        throw new Error(
          `Foundry ${meta.action} ${meta.documentName} inventory operation returned ${result.length}`
          + ` of ${meta.expectedIds.length} requested Documents.`
        );
      }
      if (meta.strictIds) {
        const expectedIds = new Set(meta.expectedIds);
        const resultIds = result.map(getItemId).filter(Boolean);
        const uniqueResultIds = new Set(resultIds);
        if (
          uniqueResultIds.size !== resultIds.length
          || resultIds.some(itemId => !expectedIds.has(itemId))
          || (result.length === meta.expectedIds.length
            && meta.expectedIds.some(itemId => !uniqueResultIds.has(itemId)))
        ) {
          throw new Error(`Foundry ${meta.action} inventory operation returned unexpected Item IDs.`);
        }
      }
      if (result.length < meta.expectedIds.length) shortResponse = true;
    }
  }

  try {
    assertCommittedInventoryState(plans, {
      validateLoad,
      // A complete modifyBatch result is the server acknowledgement for each
      // Item write. Its client-side Document can contain a normalized version
      // of an ObjectField, so only compare exact requested values when Foundry
      // omitted a result and live state is our fallback commit evidence.
      verifyItemUpdateFields: shortResponse
    });
  } catch (error) {
    if (!shortResponse) throw error;
    const incompleteError = new Error(
      "Foundry returned an incomplete inventory operation batch and did not fully persist the requested state:"
      + ` ${error.message}`
    );
    incompleteError.code = "inventory-partial-batch";
    incompleteError.cause = error;
    throw incompleteError;
  }
}

function assertCommittedInventoryState(plans, {
  validateLoad = true,
  verifyItemUpdateFields = true
} = {}) {
  for (const plan of plans) {
    const currentItems = getActorItems(plan.actor);
    const currentById = new Map(currentItems.map(item => [getItemId(item), item]));
    const currentIds = new Set(currentById.keys());
    if (plan.deletes.some(itemId => currentIds.has(itemId))) {
      throw new Error("Foundry left deleted Items in the source inventory.");
    }
    if (plan.creates.some(data => !currentIds.has(String(data._id)))) {
      throw new Error("Foundry did not persist every created inventory Item.");
    }
    if (plan.updates.some(update => !currentIds.has(String(update._id)))) {
      throw new Error("Foundry removed an Item which should only have been updated.");
    }
    if (verifyItemUpdateFields) assertCommittedItemUpdates(plan, currentById);
    assertCommittedActorUpdate(plan);
    validateActorInventoryState(plan.actor, currentItems, { validateLoad });
  }
}

function assertCommittedItemUpdates(plan, currentById) {
  const projectedById = new Map(
    plan.projectedItems.map(item => [getItemId(item), item])
  );
  for (const update of plan.updates) {
    const itemId = String(update._id);
    const current = toPlainObject(currentById.get(itemId));
    const projected = projectedById.get(itemId);
    for (const [path] of Object.entries(flattenUpdateObject(update))) {
      if (path === "_id") continue;
      const committedPath = parseDeletionPath(path) || path;
      const actual = getProperty(current, committedPath);
      const expected = getProperty(projected, committedPath);
      if (
        actual.exists !== expected.exists
        || (actual.exists && !deepEqual(actual.value, expected.value))
      ) {
        throw new Error(
          `Foundry did not persist Item "${itemId}" inventory field "${committedPath}".`
        );
      }
    }
  }
}

function assertCommittedActorUpdate(plan) {
  for (const path of plan.actorUpdatePaths) {
    const actual = getProperty(getActorSource(plan.actor), path);
    const expected = plan.actorUpdate[path];
    if (!actual.exists || !deepEqual(actual.value, expected)) {
      throw new Error(`Foundry did not persist Actor inventory field "${path}".`);
    }
  }
}

async function recoverPartialInventoryMutation(plans, { operationId, reason }) {
  if (!plans.some(hasInventoryPlanDrift)) return null;

  try {
    const recoveryOperations = [];
    for (const plan of plans) {
      const currentById = new Map(getActorItems(plan.actor).map(item => [getItemId(item), item]));
      const createdIds = plan.creates
        .map(data => String(data._id))
        .filter(itemId => currentById.has(itemId));
      const restoreCreates = [];
      const restoreUpdates = [];

      for (const itemId of plan.touchedExistingIds) {
        const snapshot = plan.snapshotById.get(itemId);
        if (!snapshot) continue;
        if (currentById.has(itemId)) restoreUpdates.push({ ...cloneValue(snapshot), _id: itemId });
        else restoreCreates.push({ ...cloneValue(snapshot), _id: itemId });
      }

      appendRecoveryOperation(recoveryOperations, plan.actor, "delete", createdIds, {
        ids: createdIds
      }, { operationId, reason });
      appendRecoveryOperation(recoveryOperations, plan.actor, "update", restoreUpdates.map(data => data._id), {
        updates: restoreUpdates
      }, { operationId, reason });
      appendRecoveryOperation(recoveryOperations, plan.actor, "create", restoreCreates.map(data => data._id), {
        data: restoreCreates,
        keepId: true
      }, { operationId, reason });
      appendActorRecoveryOperation(recoveryOperations, plan, { operationId, reason });
    }
    if (recoveryOperations.length) await foundry.documents.modifyBatch(recoveryOperations);
    for (const plan of plans) {
      if (hasInventoryPlanDriftFromSnapshot(plan)) {
        throw new Error(`Actor ${getActorKey(plan.actor)} inventory recovery is incomplete.`);
      }
    }
    return null;
  } catch (error) {
    return error;
  }
}

function appendActorRecoveryOperation(operations, plan, { operationId, reason }) {
  if (!plan.actorUpdatePaths.length || !hasActorUpdateDrift(plan)) return;
  operations.push({
    action: "update",
    documentName: "Actor",
    ...(plan.actor.parent ? { parent: plan.actor.parent } : {}),
    updates: [cloneValue(plan.actorRecoveryUpdate)],
    diff: false,
    render: true,
    falloutMawInventoryRecovery: true,
    falloutMawInventoryOperationId: operationId,
    falloutMawInventoryReason: reason
  });
}

function appendRecoveryOperation(operations, actor, action, expectedIds, data, { operationId, reason }) {
  if (!expectedIds.length) return;
  operations.push({
    action,
    documentName: "Item",
    parent: actor,
    render: true,
    ...data,
    ...(action === "update" ? { diff: false } : {}),
    [INVENTORY_ATOMIC_OPTION]: true,
    [INVENTORY_EXPECTED_IDS_OPTION]: expectedIds,
    falloutMawInventoryRecovery: true,
    falloutMawInventoryOperationId: operationId,
    falloutMawInventoryReason: reason
  });
}

function hasInventoryPlanDrift(plan) {
  const currentById = new Map(getActorItems(plan.actor).map(item => [getItemId(item), item]));
  if (plan.creates.some(data => currentById.has(String(data._id)))) return true;
  if (Array.from(plan.touchedExistingIds).some(itemId => {
    const snapshot = plan.snapshotById.get(itemId);
    const current = currentById.get(itemId);
    return !snapshot || !current || !inventorySnapshotsEqual(current, snapshot);
  })) return true;
  return hasActorUpdateDrift(plan);
}

function hasInventoryPlanDriftFromSnapshot(plan) {
  const currentById = new Map(getActorItems(plan.actor).map(item => [getItemId(item), item]));
  if (plan.creates.some(data => currentById.has(String(data._id)))) return true;
  if (Array.from(plan.touchedExistingIds).some(itemId => {
    const snapshot = plan.snapshotById.get(itemId);
    const current = currentById.get(itemId);
    return !snapshot || !current || !inventorySnapshotsEqual(current, snapshot);
  })) return true;
  return hasActorSnapshotDrift(plan);
}

function hasActorUpdateDrift(plan) {
  return plan.actorUpdatePaths.some(path => {
    const actual = getProperty(getActorSource(plan.actor), path);
    const original = plan.actorSnapshotByPath.get(path) ?? { exists: false, value: undefined };
    return actual.exists !== original.exists
      || (actual.exists && !deepEqual(actual.value, original.value));
  });
}

function hasActorSnapshotDrift(plan) {
  return hasActorUpdateDrift(plan);
}

function inventorySnapshotsEqual(left, right) {
  const leftData = toPlainObject(left);
  const rightData = toPlainObject(right);
  delete leftData._stats;
  delete rightData._stats;
  return deepEqual(leftData, rightData);
}

function deepEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => deepEqual(value, right[index]))
    );
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length
    && leftKeys.every(key => Object.hasOwn(right, key) && deepEqual(left[key], right[key]))
  );
}

function mergeInventoryUpdates(updates) {
  const merged = new Map();
  for (const rawUpdate of asArray(updates).filter(Boolean)) {
    const update = toPlainObject(rawUpdate);
    const itemId = String(update._id ?? "");
    if (!itemId) throw new TypeError("Inventory updates require an _id.");
    const current = merged.get(itemId) ?? { _id: itemId };
    merged.set(itemId, mergeUpdateObjects(current, update));
  }
  return Array.from(merged.values());
}

function mergeUpdateObjects(left, right) {
  const merged = cloneValue(left);
  for (const [key, value] of Object.entries(right ?? {})) {
    if (key === "_id") {
      merged._id = String(value);
      continue;
    }
    if (!key.includes(".") && isPlainObject(value) && isPlainObject(merged[key])) {
      merged[key] = mergeUpdateObjects(merged[key], value);
    } else {
      merged[key] = cloneValue(value);
    }
  }
  return merged;
}

function applyDocumentUpdate(source, update) {
  const result = cloneValue(source);
  for (const [path, value] of Object.entries(update ?? {})) {
    if (path === "_id") continue;
    const deletion = parseDeletionPath(path);
    if (deletion) {
      deleteProperty(result, deletion);
      continue;
    }
    if (path.includes(".")) setProperty(result, path, cloneValue(value));
    else if (isPlainObject(value) && isPlainObject(result[path])) {
      result[path] = deepMerge(result[path], value);
    } else result[path] = cloneValue(value);
  }
  return result;
}

function flattenUpdateObject(value, prefix = "", output = {}) {
  for (const [key, entry] of Object.entries(value ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (key.includes(".") || !isPlainObject(entry) || !Object.keys(entry).length) {
      output[path] = cloneValue(entry);
      continue;
    }
    flattenUpdateObject(entry, path, output);
  }
  return output;
}

function getProperty(target, path) {
  const parts = String(path).split(".").filter(Boolean);
  let current = target;
  for (const part of parts) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, part)) {
      return { exists: false, value: undefined };
    }
    current = current[part];
  }
  return { exists: true, value: current };
}

function getActorSource(actor) {
  return actor?._source ?? actor;
}

function toDeletionUpdatePath(path) {
  const parts = String(path).split(".").filter(Boolean);
  const key = parts.pop();
  return [...parts, `-=${key}`].join(".");
}

function parseDeletionPath(path) {
  const parts = String(path).split(".");
  const deletionIndex = parts.findIndex(part => part.startsWith("-="));
  if (deletionIndex < 0) return "";
  const deletedKey = parts[deletionIndex].slice(2);
  return [...parts.slice(0, deletionIndex), deletedKey].filter(Boolean).join(".");
}

function validateActorLoadLimit(actor, projectedItems) {
  if (actor?.system?.trade?.infiniteInventory) return { valid: true };
  const max = Number(actor?.system?.load?.max) || 0;
  const percent = Math.max(0, Number(actor?.system?.load?.limitPercent) || 0);
  const limit = max > 0 && percent > 0
    ? (max * percent) / 100
    : Number(actor?.system?.load?.limit) || 0;
  if (limit <= 0) return { valid: true };

  const currentLoad = Number(actor?.system?.load?.value)
    || calculateActorLoad(getActorItems(actor));
  const projectedLoad = calculateActorLoad(projectedItems);
  if (projectedLoad <= (limit + 0.0001) || projectedLoad <= (currentLoad + 0.0001)) {
    return { valid: true, value: projectedLoad, limit };
  }
  return { valid: false, reason: "actor-load-limit", value: projectedLoad, limit };
}

function calculateActorLoad(items) {
  const itemList = Array.from(items?.contents ?? items ?? []);
  return Number(itemList.reduce((total, item) => (
    getItemContainerParentId(item)
      ? total
      : total + (Number(getItemActorLoadWeight(item, itemList)) || 0)
  ), 0).toFixed(1));
}

function createInventoryValidationError(validation) {
  const messages = {
    recursive: [
      "FALLOUTMAW.Messages.ContainerRecursiveError",
      "A container cannot contain itself or one of its ancestors."
    ],
    "invalid-parent": [
      "FALLOUTMAW.Messages.ContainerInvalidParent",
      "An inventory Item refers to a missing or invalid container."
    ],
    "invalid-placement": [
      "FALLOUTMAW.Messages.ContainerInvalidPlacement",
      "A contained Item has an invalid placement mode."
    ],
    "max-load": [
      "FALLOUTMAW.Messages.ContainerMaxLoadExceeded",
      "A container is overloaded."
    ],
    "no-space": [
      "FALLOUTMAW.Messages.InventoryNoSpace",
      "There is not enough inventory space."
    ]
  };
  const [key, fallback] = messages[validation.reason] ?? [
    "FALLOUTMAW.Messages.InventoryInvalid",
    "The resulting inventory state is invalid."
  ];
  const error = new Error(localize(key, fallback));
  error.code = validation.reason ?? "inventory-invalid";
  error.validation = validation;
  return error;
}

function createInventoryStaleError(detail = "") {
  const error = new Error(detail || localize(
    "FALLOUTMAW.Messages.InventoryChanged",
    "The inventory changed while this operation was waiting. Please try again."
  ));
  error.code = "inventory-stale";
  return error;
}

function runWithActorLocks(actors, operation, index = 0) {
  if (index >= actors.length) return operation();
  return inventoryActorLock.run(
    actors[index],
    null,
    () => runWithActorLocks(actors, operation, index + 1)
  );
}

function getActorItems(actor) {
  return Array.from(actor?.items?.contents ?? actor?.items ?? []);
}

function getActorKey(actor) {
  return String(actor?.uuid ?? actor?.id ?? "").trim();
}

function resolveInventoryActor(actor) {
  const actorUuid = String(actor?.uuid ?? "").trim();
  if (!actorUuid || typeof globalThis.fromUuidSync !== "function") return actor;
  try {
    const resolved = globalThis.fromUuidSync(actorUuid);
    return resolved?.documentName === "Actor" ? resolved : actor;
  } catch (_error) {
    return actor;
  }
}

function allocateItemId(takenIds) {
  let itemId;
  do {
    itemId = typeof globalThis.foundry?.utils?.randomID === "function"
      ? foundry.utils.randomID()
      : createFallbackId();
  } while (!itemId || takenIds.has(itemId));
  return itemId;
}

function createOperationId() {
  return `inventory-${allocateItemId(new Set())}`;
}

function createFallbackId() {
  const bytes = new Uint8Array(12);
  globalThis.crypto?.getRandomValues?.(bytes);
  if (!bytes.some(Boolean)) {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function toPlainObject(value) {
  if (typeof value?.toObject === "function") return cloneValue(value.toObject());
  return cloneValue(value ?? {});
}

function cloneValue(value) {
  if (typeof globalThis.foundry?.utils?.deepClone === "function") {
    return foundry.utils.deepClone(value);
  }
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function deepMerge(target, source) {
  const result = cloneValue(target ?? {});
  for (const [key, value] of Object.entries(source ?? {})) {
    if (isPlainObject(value) && isPlainObject(result[key])) result[key] = deepMerge(result[key], value);
    else result[key] = cloneValue(value);
  }
  return result;
}

function setProperty(target, path, value) {
  if (typeof globalThis.foundry?.utils?.setProperty === "function") {
    foundry.utils.setProperty(target, path, value);
    return target;
  }
  const parts = String(path).split(".").filter(Boolean);
  let current = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (!isPlainObject(current[part]) && !Array.isArray(current[part])) current[part] = {};
    current = current[part];
  }
  if (parts.length) current[parts.at(-1)] = value;
  return target;
}

function deleteProperty(target, path) {
  if (typeof globalThis.foundry?.utils?.unsetProperty === "function") {
    foundry.utils.unsetProperty(target, path);
    return;
  }
  const parts = String(path).split(".").filter(Boolean);
  const key = parts.pop();
  let current = target;
  for (const part of parts) {
    current = current?.[part];
    if (!current || typeof current !== "object") return;
  }
  if (key) delete current[key];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function localize(key, fallback) {
  const localized = globalThis.game?.i18n?.localize?.(key);
  return localized && localized !== key ? localized : fallback;
}

function createEmptyMutationResult(reason) {
  return {
    operationId: "",
    reason,
    results: [],
    plans: [],
    createdDocuments: []
  };
}
