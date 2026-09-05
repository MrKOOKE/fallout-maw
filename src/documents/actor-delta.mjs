import { getPreviewActorContext } from "./token-clone-initialization.mjs";

const scalarUpdates = new WeakMap();
const scalarCommits = new WeakMap();

/**
 * Foundry 14 first applies an ActorDelta update to its synthetic Actor, then
 * commits the delta through TokenDocument's ActorDeltaField. That field calls
 * updateSyntheticActor again, rebuilding the Actor and all of its Items even
 * when only an HP/AP counter changed. A regular scalar patch is already applied
 * and validated by the first update; only that redundant commit callback can be
 * omitted. System-field replacements additionally verify that merging the
 * committed delta with the base produces the already updated system source.
 * Other entry points still need the full base-Actor/delta merge.
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
    const patch = inspectNonEmbeddedPatch(diff, this.id);
    scalarCommits.set(this, context && patch ? {
      ...context,
      requiresSystemMergeCheck: context.requiresSystemMergeCheck || patch.hasSystemReplacement
    } : null);
    // #region codex-runtime-debug H1 ActorDelta scalar eligibility
    globalThis.__falloutMawGameplayProbe?.count(
      scalarCommits.get(this) ? "actor-delta.scalar.commit.eligible"
        : context ? "actor-delta.scalar.commit.ineligible-cleaned-diff" : "actor-delta.scalar.commit.no-update-context",
      "H1"
    );
    // #endregion codex-runtime-debug
    try {
      return super._updateCommit(copy, diff, options, state);
    } finally {
      restoreContext(scalarCommits, this, previous);
    }
  }

  updateSyntheticActor() {
    const context = scalarCommits.get(this);
    const current = context && isCurrentContext(this, context);
    if (current && isEquivalentSystemMerge(this, context)) {
      // #region codex-runtime-debug H1 ActorDelta scalar eligibility
      globalThis.__falloutMawGameplayProbe?.count("actor-delta.scalar.skip-redundant-rebuild", "H1");
      // #endregion codex-runtime-debug
      return;
    }
    // #region codex-runtime-debug H1 ActorDelta scalar eligibility
    globalThis.__falloutMawGameplayProbe?.count(
      context ? current ? "actor-delta.scalar.rebuild.system-merge-mismatch" : "actor-delta.scalar.rebuild.stale-context"
        : "actor-delta.scalar.rebuild.no-scalar-commit",
      "H1"
    );
    // #endregion codex-runtime-debug
    return super.updateSyntheticActor();
  }
}

function createScalarUpdateContext(delta, changes, options) {
  if (Number(globalThis.game?.release?.generation) !== 14) {
    // #region codex-runtime-debug H1 ActorDelta scalar eligibility
    globalThis.__falloutMawGameplayProbe?.count("actor-delta.scalar.input.unsupported-generation", "H1");
    // #endregion codex-runtime-debug
    return null;
  }
  if (options.recursive === false || options.dryRun || options.restoreDelta) {
    // #region codex-runtime-debug H1 ActorDelta scalar eligibility
    globalThis.__falloutMawGameplayProbe?.count(
      options.recursive === false ? "actor-delta.scalar.input.nonrecursive"
        : options.dryRun ? "actor-delta.scalar.input.dry-run" : "actor-delta.scalar.input.restore-delta",
      "H1"
    );
    // #endregion codex-runtime-debug
    return null;
  }
  const patch = inspectNonEmbeddedPatch(changes, delta.id);
  if (!patch) {
    // #region codex-runtime-debug H1 ActorDelta scalar eligibility
    globalThis.__falloutMawGameplayProbe?.count("actor-delta.scalar.input.ineligible-patch", "H1");
    // #endregion codex-runtime-debug
    return null;
  }
  const context = {
    parent: delta.parent,
    actor: delta.syntheticActor,
    baseActor: delta.parent?.baseActor,
    requiresSystemMergeCheck: patch.hasSystemReplacement
  };
  const current = isCurrentContext(delta, context);
  // #region codex-runtime-debug H1 ActorDelta scalar eligibility
  globalThis.__falloutMawGameplayProbe?.count(
    current ? "actor-delta.scalar.input.eligible" : "actor-delta.scalar.input.unmaterialized-or-replaced-context",
    "H1"
  );
  // #endregion codex-runtime-debug
  return current ? context : null;
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

function isEquivalentSystemMerge(delta, context) {
  if (!context.requiresSystemMergeCheck) return true;
  const utils = globalThis.foundry?.utils;
  const baseSystem = context.baseActor?._source?.system;
  const deltaSystem = delta._source?.system;
  const actorSystem = context.actor?._source?.system;
  if (!utils?.deepClone || !utils?.mergeObject || !utils?.equals
    || !isPlainRecord(baseSystem) || !isPlainRecord(deltaSystem) || !isPlainRecord(actorSystem)) return false;

  // BaseActorDelta.applyDelta merges these exact sources after handling Items
  // and effects. A replacement can remove delta keys that the base supplies;
  // in that case native reapplication restores them and must still run. Compare
  // only the system data, avoiding inventory serialization or reconstruction.
  const merged = utils.mergeObject(utils.deepClone(baseSystem), utils.deepClone(deltaSystem));
  const equivalent = utils.equals(merged, actorSystem);
  // #region codex-runtime-debug H1 committed replacement equivalence
  globalThis.__falloutMawGameplayProbe?.count(
    equivalent ? "actor-delta.system-replacement.merge-equivalent" : "actor-delta.system-replacement.requires-native-merge",
    "H1"
  );
  // #endregion codex-runtime-debug
  return equivalent;
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
