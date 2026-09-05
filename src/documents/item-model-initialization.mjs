import { isInitializingValidatedPreviewItem } from "./token-clone-initialization.mjs";

const actorCommitScopes = new WeakMap();
const validatedItemSources = new WeakMap();

/**
 * A committed Actor system-only update cannot alter embedded Item sources.
 * Keep that fact local to the synchronous commit, including nested commits.
 */
export function withUnchangedActorItemSources(actor, diff, operation) {
  const previous = actorCommitScopes.get(actor);
  actorCommitScopes.set(actor, isActorSystemOnlyDiff(diff));
  try {
    return operation();
  } finally {
    if (previous === undefined) actorCommitScopes.delete(actor);
    else actorCommitScopes.set(actor, previous);
  }
}

/**
 * Foundry's TypeDataField constructs and validates a new model on every parent
 * reset, even when the Item source has not changed. Resetting the existing
 * system model restores the same prepared fields without validating the same
 * source again. Item and ActiveEffect initialization/preparation still run.
 *
 * A snapshot made after native initialization certifies the source that was
 * validated. Parent collection resets may reuse it only while every source
 * value still matches, including when a caller changed the source in place.
 * Direct Item initialization and changed or unsupported models stay native.
 */
export function getUnchangedItemSystemField(item, field, supportedModels) {
  const modelClass = globalThis.CONFIG?.Item?.dataModels?.[item._source?.type];
  if (!supportedModels.has(modelClass) || !isNativeSystemField(field)) {
    validatedItemSources.delete(item);
    return field;
  }

  // DataModel#_initialize consumes only these field properties for a persisted
  // writable value. Do not copy or mutate the shared Item schema field.
  return {
    persisted: true,
    readonly: field.readonly,
    initialize(value, document, options) {
      const model = item.system;
      const cached = validatedItemSources.get(item);
      const reason = document !== item ? "changed-document"
        : value !== item._source?.system ? "changed-source-reference"
          : !isNativeSystemField(field) ? "custom-system-field"
            : item.parent?.items?._initialized !== false ? "outside-item-collection-initialization"
              : getModelMismatch(item, model, modelClass)
                || (!cached || cached.model !== model ? "no-validated-snapshot"
                  : !compareValidatedSource(value, cached.source, item) ? "changed-snapshot-source" : null);
      if (!reason) {
        try {
          model.reset();
          return model;
        } catch (error) {
          validatedItemSources.delete(item);
          throw error;
        }
      }

      // Invalidate first: a failed native initialization must not leave an old
      // certificate available if another caller later repairs the source.
      validatedItemSources.delete(item);
      const initialized = field.initialize(value, document, options);
      if (
        document === item && value === item._source?.system
        && isNativeSystemField(field) && !getModelMismatch(item, initialized, modelClass)
        && !isInitializingValidatedPreviewItem(item)
      ) {
        try {
          // Strict cloning rejects unsupported objects instead of retaining
          // their references. Non-data values also fail source comparison.
          const source = foundry.utils.deepClone(value, { strict: true });
          validatedItemSources.set(item, { model: initialized, source });
        } catch {
        }
      }
      // A transient visual preview doesn't need a second source copy solely to
      // accelerate a future reset. If it is later reset, the missing certificate
      // takes the native path, validates then caches the source normally.
      // #region codex-runtime-debug H6a verify preview snapshot deferral
      if (isInitializingValidatedPreviewItem(item)) globalThis.__falloutMawGameplayProbe?.count("preview.item.snapshotDeferred", "H6a");
      // #endregion codex-runtime-debug
      return initialized;
    }
  };
}

function isNativeSystemField(field) {
  const FieldClass = globalThis.foundry?.data?.fields?.TypeDataField;
  return Boolean(FieldClass
    && field.constructor === FieldClass
    && field.initialize === FieldClass.prototype.initialize
    && field.getModelForType === FieldClass.prototype.getModelForType
    && field.persisted === true);
}

// #region codex-runtime-debug H6b source comparison within remaining Item reset cost
function compareValidatedSource(value, snapshot, item) {
  const finish = globalThis.__falloutMawGameplayProbe?.sampledSync?.("item.sourceComparisonSample", "H6b", item.parent);
  try { return sameSourceData(value, snapshot); }
  finally { finish?.(); }
}
// #endregion codex-runtime-debug

function getModelMismatch(item, model, modelClass) {
  return !model ? "missing-model"
    : model.invalid !== false ? "invalid-model"
      : model.constructor !== modelClass
        || globalThis.CONFIG?.Item?.dataModels?.[item._source?.type] !== modelClass ? "changed-model-class"
        : model.schema !== modelClass.schema ? "changed-model-schema"
          : model._source !== item._source?.system ? "changed-source-reference"
            : model.parent !== item ? "changed-model-parent" : null;
}

// Compare keys as well as values: missing keys and keys holding undefined are
// distinct. Only plain source records and arrays can pass this comparison.
function sameSourceData(value, snapshot) {
  // Foundry's clone helper passes functions through even in strict mode.
  // They may have mutable properties and cannot certify unchanged data.
  if (Object.is(value, snapshot)) return typeof value !== "function";
  const array = Array.isArray(value);
  if (array !== Array.isArray(snapshot)) return false;
  if (array) {
    if (value.length !== snapshot.length) return false;
  } else if (!isPlainObject(value) || !isPlainObject(snapshot)) return false;
  const keys = Object.keys(value);
  if (keys.length !== Object.keys(snapshot).length) return false;
  return keys.every(key => Object.hasOwn(snapshot, key) && sameSourceData(value[key], snapshot[key]));
}

function isActorSystemOnlyDiff(diff) {
  if (!isPlainObject(diff)) return false;
  // Incoming database commits also carry Foundry's modification metadata.
  // It cannot modify embedded Item sources, unlike items/effects/type roots.
  if (Object.keys(diff).some(key => key !== "system" && key !== "_stats")) return false;
  // Native operators and arrays nested under system still cannot touch Item
  // sources. Every reused Item is additionally checked against its snapshot.
  return Object.hasOwn(diff, "system");
}

function isPlainObject(value) {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
