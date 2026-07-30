import { createActorOperationLock } from "./actor-operation-lock.mjs";

const atomicUpdateLock = createActorOperationLock();
const PROTECTED_DOCUMENT_OPTIONS = Object.freeze([
  "action",
  "data",
  "deleteAll",
  "diff",
  "documentName",
  "dryRun",
  "ids",
  "keepId",
  "pack",
  "parent",
  "parentUuid",
  "render",
  "updates",
  "_result",
  "chainRef",
  "falloutMawSystemEventChainRef",
  "falloutMawAtomicLeafOperationId",
  "falloutMawAtomicLeafReason",
  "falloutMawAtomicLeafRecovery"
]);

/**
 * Atomically update exact source paths on existing Actor and embedded Item
 * Documents without projecting or validating an Actor's complete inventory.
 *
 * Each entry owns its Document options so internal Item bookkeeping can share
 * a batch with ordinary Actor or Item updates without leaking its hook flags.
 * Only dotted update paths are accepted. Creates, deletes, replacement of a
 * whole top-level branch and Foundry deletion operators are deliberately out
 * of scope.
 *
 * @param {object|object[]} input
 * @param {Actor|Item} input.document
 * @param {object} input.updates
 * @param {object} [input.documentOptions]
 * @param {object} [options]
 * @param {object} [options.documentOptions]
 * @param {object|null} [options.chainRef]
 * @param {boolean} [options.render]
 * @param {string} [options.reason]
 * @returns {Promise<object>}
 */
export async function executeAtomicActorItemUpdates(input, {
  documentOptions = {},
  chainRef = null,
  render = true,
  reason = "actor-item-update"
} = {}) {
  const resolvedChainRef = resolveChainRef(chainRef, documentOptions);
  const plans = prepareUpdatePlans(input, {
    documentOptions,
    chainRef: resolvedChainRef
  });
  if (!plans.length) return createEmptyResult(reason);

  const actors = collectActors(plans);
  return runWithActorLocks(actors, resolvedChainRef, async () => {
    assertPlansFresh(plans);
    return commitPreparedPlans(plans, {
      reason,
      render
    });
  });
}

function prepareUpdatePlans(input, { documentOptions, chainRef }) {
  const entries = asArray(input).filter(Boolean);
  const touchedPathsByDocument = new Map();
  const plans = [];

  for (const entry of entries) {
    if (!isPlainObject(entry)) {
      throw new TypeError("Atomic Actor/Item updates require update entry objects.");
    }
    const document = entry.document ?? entry.actor ?? entry.item ?? null;
    const documentName = getDocumentName(document);
    if (documentName !== "Actor" && documentName !== "Item") {
      throw new TypeError("Atomic Actor/Item updates only support Actor and Item Documents.");
    }

    const documentId = getDocumentId(document);
    if (!documentId) throw new TypeError(`Atomic ${documentName} updates require a Document ID.`);
    const actor = documentName === "Actor" ? document : document?.parent;
    if (getDocumentName(actor) !== "Actor" || !getActorKey(actor)) {
      throw new TypeError("Atomic Item updates require an Item embedded in a valid Actor.");
    }
    if (documentName === "Item" && resolveCurrentItem(actor, documentId) !== document) {
      throw createStaleError(`Item "${documentId}" is no longer embedded in its Actor.`);
    }

    const rawUpdates = entry.updates ?? entry.update ?? {};
    if (!isPlainObject(rawUpdates)) {
      throw new TypeError(`Atomic ${documentName} updates require a dotted update object.`);
    }
    const suppliedId = rawUpdates._id ?? rawUpdates.id;
    if (suppliedId !== undefined && String(suppliedId) !== documentId) {
      throw new TypeError(`Atomic ${documentName} update ID does not match its Document.`);
    }

    const source = getDocumentSource(document);
    const paths = [];
    const update = { _id: documentId };
    const knownPaths = touchedPathsByDocument.get(document) ?? [];
    for (const [rawPath, rawValue] of Object.entries(rawUpdates)) {
      if (rawPath === "_id" || rawPath === "id") continue;
      const path = normalizeDottedPath(rawPath);
      if (rawValue === undefined) {
        throw new TypeError(`Atomic update path "${path}" cannot be assigned undefined.`);
      }
      assertPathDoesNotOverlap(knownPaths, path, document);

      const before = readPath(source, path);
      const value = cloneValue(rawValue);
      knownPaths.push(path);
      if (before.exists && deepEqual(before.value, value)) continue;
      paths.push({
        path,
        before: cloneSnapshot(before),
        after: { exists: true, value: cloneValue(value) }
      });
      update[path] = value;
    }
    touchedPathsByDocument.set(document, knownPaths);
    if (!paths.length) continue;

    plans.push({
      actor,
      document,
      documentId,
      documentName,
      documentOptions: createDocumentOptions(
        documentOptions,
        entry.documentOptions,
        chainRef
      ),
      paths,
      update
    });
  }
  return plans;
}

async function commitPreparedPlans(plans, { reason, render }) {
  const operationId = createOperationId();
  const operations = createUpdateOperations(plans, {
    operationId,
    reason,
    render,
    recovery: false
  });

  let results;
  try {
    results = await foundry.documents.modifyBatch(operations);
    assertBatchResults(results, plans);
    assertPlansAtTarget(plans);
  } catch (error) {
    const recoveryError = await recoverPartialUpdate(plans, {
      operationId,
      reason,
      render
    });
    if (recoveryError) {
      const aggregate = new AggregateError(
        [error, recoveryError],
        "Atomic Actor/Item update failed and its touched paths could not be fully restored."
      );
      aggregate.code = "atomic-leaf-recovery-failed";
      aggregate.cause = error;
      throw aggregate;
    }
    throw error;
  }

  return {
    operationId,
    reason,
    results,
    plans
  };
}

function createUpdateOperation(plan, {
  operationId,
  reason,
  render,
  recovery
}) {
  return {
    ...cloneValue(plan.documentOptions),
    action: "update",
    documentName: plan.documentName,
    ...(plan.documentName === "Item" || plan.document?.parent
      ? { parent: plan.documentName === "Item" ? plan.actor : plan.document.parent }
      : {}),
    updates: [cloneValue(plan.update)],
    diff: false,
    render: Boolean(render),
    falloutMawAtomicLeafOperationId: operationId,
    falloutMawAtomicLeafReason: String(reason ?? "actor-item-update"),
    ...(recovery ? { falloutMawAtomicLeafRecovery: true } : {})
  };
}

function assertPlansFresh(plans) {
  for (const plan of plans) {
    const current = resolveCurrentDocument(plan);
    if (!current) throw createStaleError(`${plan.documentName} "${plan.documentId}" no longer exists.`);
    const source = getDocumentSource(current);
    for (const pathState of plan.paths) {
      const actual = readPath(source, pathState.path);
      if (!snapshotsEqual(actual, pathState.before)) {
        throw createStaleError(
          `${plan.documentName} "${plan.documentId}" path "${pathState.path}" changed while the update was waiting.`
        );
      }
    }
  }
}

function assertPlansAtTarget(plans) {
  for (const plan of plans) {
    const current = resolveCurrentDocument(plan);
    if (!current) {
      throw createPartialBatchError(`${plan.documentName} "${plan.documentId}" no longer exists.`);
    }
    const source = getDocumentSource(current);
    for (const pathState of plan.paths) {
      const actual = readPath(source, pathState.path);
      if (!snapshotsEqual(actual, pathState.after)) {
        throw createPartialBatchError(
          `Foundry did not persist ${plan.documentName} "${plan.documentId}" path "${pathState.path}".`
        );
      }
    }
  }
}

function assertBatchResults(results, plans) {
  if (
    !Array.isArray(results)
    || results.length > plans.length
    || results.some(result => !Array.isArray(result) || result.length > 1)
  ) {
    throw createPartialBatchError("Foundry returned an invalid Actor/Item update batch response.");
  }

  if (results.length === plans.length) {
    for (let index = 0; index < results.length; index += 1) {
      const [document] = results[index];
      if (document && !resultMatchesPlan(document, plans[index])) {
        throw createPartialBatchError("Foundry returned an unexpected Document for an Actor/Item update.");
      }
    }
    return;
  }

  const unmatched = [...plans];
  for (const result of results) {
    const [document] = result;
    if (!document) continue;
    const index = unmatched.findIndex(plan => resultMatchesPlan(document, plan));
    if (index < 0) {
      throw createPartialBatchError("Foundry returned an unexpected Document for an Actor/Item update.");
    }
    unmatched.splice(index, 1);
  }
}

async function recoverPartialUpdate(plans, {
  operationId,
  reason,
  render
}) {
  let recoveryCallError = null;
  try {
    const recoveryPlans = buildRecoveryPlans(plans);
    if (recoveryPlans.length) {
      const operations = createUpdateOperations(recoveryPlans, {
        operationId,
        reason,
        render,
        recovery: true
      });
      await foundry.documents.modifyBatch(operations);
    }
  } catch (error) {
    recoveryCallError = error;
  }

  try {
    assertPlansAtSnapshots(plans);
    return null;
  } catch (stateError) {
    if (!recoveryCallError) return stateError;
    const aggregate = new AggregateError(
      [recoveryCallError, stateError],
      "Targeted Actor/Item update recovery did not restore every touched path."
    );
    aggregate.cause = recoveryCallError;
    return aggregate;
  }
}

function createUpdateOperations(plans, options) {
  const lastPlanByActor = new Map();
  plans.forEach((plan, index) => lastPlanByActor.set(getActorKey(plan.actor), index));
  return plans.map((plan, index) => createUpdateOperation(plan, {
    ...options,
    render: Boolean(options.render && lastPlanByActor.get(getActorKey(plan.actor)) === index)
  }));
}

function buildRecoveryPlans(plans) {
  const recoveryPlans = [];
  for (const plan of plans) {
    const current = resolveCurrentDocument(plan);
    if (!current) continue;
    const source = getDocumentSource(current);
    const update = { _id: plan.documentId };
    const paths = [];

    for (const pathState of plan.paths) {
      const actual = readPath(source, pathState.path);
      if (snapshotsEqual(actual, pathState.before)) continue;
      // Never overwrite a same-leaf value which is neither our intended write
      // nor the original snapshot. It may belong to a concurrent operation.
      if (!snapshotsEqual(actual, pathState.after)) continue;

      if (pathState.before.exists) {
        update[pathState.path] = cloneValue(pathState.before.value);
      } else {
        update[toDeletionUpdatePath(pathState.path)] = null;
      }
      paths.push({
        path: pathState.path,
        before: cloneSnapshot(pathState.after),
        after: cloneSnapshot(pathState.before)
      });
    }
    if (!paths.length) continue;
    recoveryPlans.push({ ...plan, paths, update });
  }
  return recoveryPlans;
}

function assertPlansAtSnapshots(plans) {
  for (const plan of plans) {
    const current = resolveCurrentDocument(plan);
    if (!current) {
      throw new Error(`${plan.documentName} "${plan.documentId}" disappeared during recovery.`);
    }
    const source = getDocumentSource(current);
    for (const pathState of plan.paths) {
      const actual = readPath(source, pathState.path);
      if (!snapshotsEqual(actual, pathState.before)) {
        throw new Error(
          `Recovery did not restore ${plan.documentName} "${plan.documentId}" path "${pathState.path}".`
        );
      }
    }
  }
}

function collectActors(plans) {
  const byKey = new Map();
  for (const plan of plans) {
    const key = getActorKey(plan.actor);
    const known = byKey.get(key);
    if (known && known !== plan.actor) {
      throw new TypeError(`Atomic Actor/Item update Actor key collision: ${key}.`);
    }
    byKey.set(key, plan.actor);
  }
  return Array.from(byKey.values())
    .sort((left, right) => getActorKey(left).localeCompare(getActorKey(right)));
}

function runWithActorLocks(actors, chainRef, operation, index = 0) {
  if (index >= actors.length) return operation();
  return atomicUpdateLock.run(
    actors[index],
    chainRef,
    () => runWithActorLocks(actors, chainRef, operation, index + 1)
  );
}

function createDocumentOptions(globalOptions, localOptions, chainRef) {
  const options = {
    ...sanitizeDocumentOptions(globalOptions),
    ...sanitizeDocumentOptions(localOptions)
  };
  if (chainRef) {
    options.chainRef = cloneValue(chainRef);
    options.falloutMawSystemEventChainRef = cloneValue(chainRef);
  }
  return options;
}

function sanitizeDocumentOptions(options = {}) {
  if (options === undefined || options === null) return {};
  if (!isPlainObject(options)) throw new TypeError("Atomic update documentOptions must be an object.");
  const sanitized = cloneValue(options);
  for (const key of PROTECTED_DOCUMENT_OPTIONS) delete sanitized[key];
  return sanitized;
}

function resolveChainRef(chainRef, documentOptions) {
  return chainRef
    ?? documentOptions?.falloutMawSystemEventChainRef
    ?? documentOptions?.chainRef
    ?? null;
}

function normalizeDottedPath(rawPath) {
  const path = String(rawPath ?? "").trim();
  const parts = path.split(".");
  if (
    parts.length < 2
    || parts.some(part => !part || part.startsWith("-=") || ["__proto__", "prototype", "constructor"].includes(part))
  ) {
    throw new TypeError(`Atomic Actor/Item updates require a safe dotted path; received "${path}".`);
  }
  return path;
}

function assertPathDoesNotOverlap(paths, candidate, document) {
  const overlap = paths.find(path => (
    path === candidate
    || path.startsWith(`${candidate}.`)
    || candidate.startsWith(`${path}.`)
  ));
  if (!overlap) return;
  throw new TypeError(
    `Atomic ${getDocumentName(document)} update paths "${overlap}" and "${candidate}" overlap.`
  );
}

function resolveCurrentDocument(plan) {
  if (plan.documentName === "Actor") return plan.document;
  return resolveCurrentItem(plan.actor, plan.documentId);
}

function resolveCurrentItem(actor, itemId) {
  if (typeof actor?.items?.get === "function") return actor.items.get(itemId) ?? null;
  return Array.from(actor?.items?.contents ?? actor?.items ?? [])
    .find(item => getDocumentId(item) === String(itemId)) ?? null;
}

function resultMatchesPlan(document, plan) {
  const name = getDocumentName(document);
  return getDocumentId(document) === plan.documentId
    && (!name || name === plan.documentName);
}

function getDocumentName(document) {
  return String(document?.documentName ?? document?.constructor?.documentName ?? "");
}

function getDocumentId(document) {
  return String(document?.id ?? document?._id ?? "").trim();
}

function getActorKey(actor) {
  return String(actor?.uuid ?? actor?.id ?? actor?._id ?? "").trim();
}

function getDocumentSource(document) {
  return document?._source ?? document;
}

function readPath(target, path) {
  const parts = String(path).split(".");
  let current = target;
  for (const part of parts) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, part)) {
      return { exists: false, value: undefined };
    }
    current = current[part];
  }
  return { exists: true, value: current };
}

function cloneSnapshot(snapshot) {
  return {
    exists: Boolean(snapshot?.exists),
    value: snapshot?.exists ? cloneValue(snapshot.value) : undefined
  };
}

function snapshotsEqual(left, right) {
  return Boolean(left?.exists) === Boolean(right?.exists)
    && (!left?.exists || deepEqual(left.value, right.value));
}

function toDeletionUpdatePath(path) {
  const parts = String(path).split(".");
  const key = parts.pop();
  return [...parts, `-=${key}`].join(".");
}

function createOperationId() {
  const suffix = typeof globalThis.foundry?.utils?.randomID === "function"
    ? foundry.utils.randomID()
    : createFallbackId();
  return `atomic-leaf-${suffix}`;
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

function createStaleError(detail) {
  const error = new Error(detail || "Actor or Item changed while the atomic update was waiting.");
  error.code = "atomic-leaf-stale";
  return error;
}

function createPartialBatchError(detail) {
  const error = new Error(detail || "Foundry did not fully persist the atomic Actor/Item update.");
  error.code = "atomic-leaf-partial-batch";
  return error;
}

function createEmptyResult(reason) {
  return {
    operationId: "",
    reason,
    results: [],
    plans: []
  };
}

function cloneValue(value) {
  if (typeof globalThis.foundry?.utils?.deepClone === "function") {
    return foundry.utils.deepClone(value);
  }
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function deepEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => deepEqual(value, right[index]));
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every(key => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}
