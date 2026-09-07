import { getPreviewActorContext } from "./token-clone-initialization.mjs";
import { COMBAT_MOVEMENT_RESOURCE_UPDATE_OPTION } from "../constants.mjs";

const scalarUpdates = new WeakMap();
const scalarCommits = new WeakMap();

/**
 * Foundry 14 first applies an ActorDelta update to its synthetic Actor, then
 * commits the delta through TokenDocument's ActorDeltaField. That field calls
 * updateSyntheticActor again, rebuilding the Actor and all of its Items even
 * when only an HP/AP counter changed. A regular scalar patch is already applied
 * and validated by the first update; only that redundant commit callback can be
 * omitted. System-field replacements and the complete system/flags snapshot
 * returned for a marked movement-resource update additionally verify that the
 * committed delta merged with the base equals the already updated Actor. Other
 * entry points still need the full base-Actor/delta merge.
 */
export class FalloutMaWActorDelta extends foundry.documents.ActorDelta {
  apply(context = {}) {
    return super.apply(getPreviewActorContext(this, context));
  }

  updateSource(changes = {}, options = {}) {
    const previous = scalarUpdates.get(this);
    const context = createScalarUpdateContext(this, changes, options);
    scalarUpdates.set(this, context);
    try {
      return super.updateSource(changes, options);
    } finally {
      restoreContext(scalarUpdates, this, previous);
    }
  }

  _updateCommit(copy, diff, options, state) {
    const previous = scalarCommits.get(this);
    const context = scalarUpdates.get(this);
    // Enter only after the native synthetic-Actor update and delta validation
    // succeeded. Recheck the cleaned diff because migrations can alter input.
    const patch = context?.movementResourceSnapshot
      ? inspectMovementResourceSnapshot(diff, this.id)
      : inspectNonEmbeddedPatch(diff, this.id);
    scalarCommits.set(this, context && patch ? {
      ...context,
      mergeCheckRoots: new Set([
        ...context.mergeCheckRoots,
        ...(patch.hasSystemReplacement ? ["system"] : []),
        ...(patch.snapshotRoots ?? [])
      ])
    } : null);
    try {
      return super._updateCommit(copy, diff, options, state);
    } finally {
      restoreContext(scalarCommits, this, previous);
    }
  }

  updateSyntheticActor() {
    const context = scalarCommits.get(this);
    const current = context && isCurrentContext(this, context);
    if (current && areEquivalentMergedRoots(this, context)) return;
    return super.updateSyntheticActor();
  }
}

function createScalarUpdateContext(delta, changes, options) {
  if (Number(globalThis.game?.release?.generation) !== 14) return null;
  if (options.recursive === false || options.dryRun || options.restoreDelta) return null;
  const movementResourceSnapshot = Boolean(options[COMBAT_MOVEMENT_RESOURCE_UPDATE_OPTION]);
  const patch = inspectNonEmbeddedPatch(changes, delta.id)
    ?? (movementResourceSnapshot ? inspectMovementResourceSnapshot(changes, delta.id, { requireComplete: true }) : null);
  if (!patch) return null;
  const context = {
    parent: delta.parent,
    actor: delta.syntheticActor,
    baseActor: delta.parent?.baseActor,
    movementResourceSnapshot: Boolean(patch.snapshotRoots),
    mergeCheckRoots: new Set([
      ...(patch.hasSystemReplacement ? ["system"] : []),
      ...(patch.snapshotRoots ?? [])
    ])
  };
  return isCurrentContext(delta, context) ? context : null;
}

function isCurrentContext(delta, { parent, actor, baseActor }) {
  return Boolean(
    parent && actor && baseActor && !parent.isLinked
    && delta.parent === parent
    && parent.delta === delta
    // A null or replaced delta must follow core's model materialization path.
    && parent._source?.delta === delta._source
    && delta.syntheticActor === actor
    && parent.baseActor === baseActor
    && actor.id === parent.actorId
  );
}

function inspectNonEmbeddedPatch(changes, id) {
  if (!isPlainRecord(changes)) return null;
  const result = { hasSystemReplacement: false };
  for (const [path, value] of Object.entries(changes)) {
    const [root, ...parts] = path.split(".");
    if (root === "_id") {
      if (parts.length || value !== id) return null;
      continue;
    }
    if (root === "name" || root === "img") {
      // null clears a delta override and restores the base Actor's value.
      if (parts.length || typeof value !== "string") return null;
      continue;
    }
    if (!["system", "flags", "ownership"].includes(root)) return null;
    if (!parts.length && !isPlainRecord(value)) return null;
    if (parts.some(isSpecialKey) || !isSupportedValue(value, root === "system" ? result : null)) return null;
  }
  return result;
}

function inspectMovementResourceSnapshot(changes, id, { requireComplete = false } = {}) {
  if (!isPlainRecord(changes)) return null;
  const roots = new Set();
  for (const [path, value] of Object.entries(changes)) {
    const [root, ...parts] = path.split(".");
    if (root === "_id") {
      if (parts.length || value !== id) return null;
      continue;
    }
    if (root !== "system" && root !== "flags") return null;
    if (parts.some(isSpecialKey) || !isSnapshotValue(value)) return null;
    roots.add(root);
  }
  if (!roots.size) return null;
  if (requireComplete && (!roots.has("system") || !roots.has("flags"))) return null;
  return { hasSystemReplacement: false, snapshotRoots: roots };
}

function isSnapshotValue(value) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isSnapshotValue);
  if (!isPlainRecord(value)) return false;
  return Object.entries(value).every(([key, entry]) => (
    !key.split(".").some(isSpecialKey) && isSnapshotValue(entry)
  ));
}

function isSupportedValue(value, result = null) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  const Replacement = globalThis.foundry?.data?.operators?.ForcedReplacement;
  if (result && Replacement && value instanceof Replacement && value.constructor === Replacement) {
    // Only native replacements of plain scalar-valued system data are supported.
    // Deletions, arrays, serialized operator lookalikes and embedded changes keep
    // the native path. Equivalence is checked after the delta actually commits.
    if (!isSupportedValue(Replacement.get(value))) return false;
    result.hasSystemReplacement = true;
    return true;
  }
  if (!isPlainRecord(value)) return false;
  return Object.entries(value).every(([key, entry]) => (
    !key.split(".").some(isSpecialKey) && isSupportedValue(entry, result)
  ));
}

function areEquivalentMergedRoots(delta, context) {
  if (!context.mergeCheckRoots.size) return true;
  const utils = globalThis.foundry?.utils;
  if (!utils?.deepClone || !utils?.mergeObject || !utils?.equals) return false;

  // BaseActorDelta.applyDelta merges these exact sources after handling Items
  // and effects. A replacement can remove delta keys that the base supplies;
  // in that case native reapplication restores them and must still run. Compare
  // only the non-embedded roots involved, avoiding inventory serialization or
  // reconstruction.
  for (const root of context.mergeCheckRoots) {
    const baseValue = context.baseActor?._source?.[root];
    const deltaValue = delta._source?.[root];
    const actorValue = context.actor?._source?.[root];
    if (!isPlainRecord(baseValue) || !isPlainRecord(deltaValue) || !isPlainRecord(actorValue)) return false;
    const merged = utils.mergeObject(utils.deepClone(baseValue), utils.deepClone(deltaValue));
    if (!utils.equals(merged, actorValue)) return false;
  }
  return true;
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSpecialKey(key) {
  return key.startsWith("-=") || key === "__$OPERATOR$__";
}

function restoreContext(contexts, delta, previous) {
  if (previous === undefined) contexts.delete(delta);
  else contexts.set(delta, previous);
}
