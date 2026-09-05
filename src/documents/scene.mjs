import { FalloutMaWTokenDocument } from "./token.mjs";

const NativeScene = foundry.documents.Scene;
const nativePreUpdateDescendants = NativeScene.prototype._preUpdateDescendantDocuments;
const nativeInheritedHook = Object.getPrototypeOf(NativeScene.prototype)._preUpdateDescendantDocuments;
const nativeTokenToObject = foundry.documents.TokenDocument.prototype.toObject;
const systemTokenToObject = FalloutMaWTokenDocument.prototype.toObject;
const nativeTokenShimData = foundry.documents.TokenDocument.shimData;
const movementFields = new Set(["x", "y", "elevation", "rotation"]);

/**
 * Foundry 14 serializes every updated Token, including its ActorDelta inventory,
 * before filtering that snapshot down to the fields needed for undo. Coordinate
 * updates can capture the same history directly from their scalar source fields.
 */
export class FalloutMaWScene extends NativeScene {
  _preUpdateDescendantDocuments(parent, collection, changes, options, userId) {
    const originals = getMovementOriginals(this, parent, collection, changes, options, userId);
    if (!originals) return super._preUpdateDescendantDocuments(parent, collection, changes, options, userId);

    // Audited against Foundry 14: Scene's immediate parent is ClientDocumentMixin.
    // Invoke its hook with the original arguments. If another module changes
    // either hook, the guard below retains Scene's complete native lifecycle.
    const inheritedHook = Object.getPrototypeOf(NativeScene.prototype)._preUpdateDescendantDocuments;
    foundry.documents.TokenDocument._addTeleportAndForcedShims(options);
    inheritedHook.call(this, parent, collection, changes, options, userId);
    const layer = canvas.getCollectionLayer(collection);
    layer?.storeHistory("update", originals, options);
  }
}

function getMovementOriginals(scene, parent, collection, changes, options, userId) {
  if (Number(globalThis.game?.release?.generation) !== 14
    || parent !== scene || collection !== "tokens"
    || userId !== game.userId || !scene.isView || options?.isUndo
    || !Array.isArray(changes) || !changes.length) return null;

  // A module replacing Scene's hook or a Token's serialization keeps its native
  // route. Do not bypass behavior that this narrow optimization cannot preserve.
  if (NativeScene.prototype._preUpdateDescendantDocuments !== nativePreUpdateDescendants
    || typeof nativeTokenToObject !== "function"
    || typeof foundry.documents.TokenDocument._addTeleportAndForcedShims !== "function") return null;
  const inheritedHook = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(NativeScene.prototype), "_preUpdateDescendantDocuments"
  )?.value;
  if (typeof inheritedHook !== "function" || inheritedHook !== nativeInheritedHook) return null;

  const documents = scene.getEmbeddedCollection(collection);
  const originals = [];
  for (const change of changes) {
    if (!isPlainObject(change) || typeof change._id !== "string" || !change._id) return null;
    const keys = Object.keys(change);
    if (keys.length < 2 || !Object.hasOwn(change, "_id")) return null;
    for (const key of keys) {
      if (key !== "_id" && (!movementFields.has(key) || !Number.isFinite(change[key]))) return null;
    }
    const document = documents.get(change._id);
    if (!document || (document.toObject !== nativeTokenToObject && document.toObject !== systemTokenToObject)
      || foundry.documents.TokenDocument.prototype.toObject !== nativeTokenToObject
      || document.constructor.shimData !== nativeTokenShimData
      || document._source?._id !== change._id) return null;
    const original = {};
    for (const key of keys) {
      const value = document._source[key];
      if (!Object.hasOwn(document._source, key) || (key !== "_id" && !Number.isFinite(value))) return null;
      original[key] = value;
    }
    // Project before cloning: ActorDelta is never visited and history still owns
    // a snapshot independent of the document and the incoming update object.
    originals.push(foundry.utils.deepClone(original));
  }
  // #region codex-runtime-debug H7b verify coordinate history without changing method identity
  globalThis.__falloutMawGameplayProbe?.count("movement.coordinateHistory", "H7b", originals.length);
  // #endregion codex-runtime-debug
  return originals;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
