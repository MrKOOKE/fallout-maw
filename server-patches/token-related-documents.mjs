import { isDeepStrictEqual } from "node:util";

const certificates = new WeakMap();
const actorViews = new WeakMap();
export const SERVER_TOKEN_RUNTIME_REVISION = 2;

/**
 * Foundry 14.361 server adapter. Keep native collection maintenance, construction,
 * validation and permission methods. Reuse certified unchanged delta documents
 * and materialize the separate synthetic Actor only if a consumer requests it.
 * The installer restricts this adapter to an audited native implementation.
 */
export async function loadTokenRelatedDocuments(token, nativeLoad) {
  if (globalThis.release?.version !== "14.361" || globalThis.game?.system?.id !== "fallout-maw") {
    return nativeLoad();
  }
  const previous = actorViews.get(token);
  const descriptor = Object.getOwnPropertyDescriptor(token, "actor");
  if (descriptor && (!descriptor.configurable || descriptor.get && descriptor.get !== previous?.get)) {
    return nativeLoad();
  }

  token.baseActor = await db.Actor.get(token.actorId);
  if (token.actorLink) {
    actorViews.delete(token);
    token.actor = token.baseActor;
    return;
  }
  const delta = token.delta;
  const itemSnapshots = new Map();
  for (const collection of Object.values(delta?.collections ?? {})) initializeDeltaCollection(collection, itemSnapshots);
  if (!delta || !token.baseActor) {
    actorViews.delete(token);
    token.actor = delta ? null : undefined;
    return;
  }

  // Snapshot at the same point as native applyDelta. A later read must see that
  // version even if another operation modifies the token before actor is read.
  const baseSource = token.baseActor.toObject();
  const deltaSource = snapshotDeltaSource(delta, itemSnapshots);
  if (previous && descriptor && (descriptor.get === previous.get || descriptor.value === previous.actor)
    && previous.deltaClass === delta.constructor
    && (!previous.actor || previous.actor.constructor === getDocumentClass("Actor")
      && isDeepStrictEqual(previous.actor._source, previous.actorSource))
    && isDeepStrictEqual(previous.baseSource, baseSource) && isDeepStrictEqual(previous.deltaSource, deltaSource)) {
    previous.actor?.reset();
    return;
  }
  const view = { baseSource, deltaSource, actor: undefined, actorSource: null, deltaClass: delta.constructor, get: null };
  const DeltaClass = delta.constructor;
  const deltaParent = delta.parent;
  view.get = function () {
    const snapshotDelta = {parent: deltaParent, toObject: () => foundry.utils.deepClone(deltaSource)};
    const snapshotBase = {toObject: () => foundry.utils.deepClone(baseSource)};
    const actor = DeltaClass.applyDelta(snapshotDelta, snapshotBase, {strict: false});
    view.actor = actor;
    view.actorSource = actor ? foundry.utils.deepClone(actor._source) : null;
    Object.defineProperty(this, "actor", {value: actor, writable: true, configurable: true, enumerable: true});
    return actor;
  };
  Object.defineProperty(token, "actor", {
    configurable: true, enumerable: true, get: view.get,
    set(value) {
      actorViews.delete(this);
      Object.defineProperty(this, "actor", {value, writable: true, configurable: true, enumerable: true});
    }
  });
  actorViews.set(token, view);
}

function initializeDeltaCollection(collection, itemSnapshots) {
  const sources = new Map(collection._source.map(source => [source._id, source]));
  const verified = new Set();
  const base = collection.baseCollection;
  for (const [id, document] of collection.entries()) {
    const managed = sources.get(id);
    const source = managed ?? base?.get(id)?._source;
    const certificate = certificates.get(document);
    // Managed documents must retain their source alias; inherited documents may
    // reference an earlier, equal base snapshot. Changed documents are rebuilt
    // through the native initializer, including in-place source changes.
    const reusable = !source?._tombstone && source && !document.invalid && certificate
      && certificate.constructor === document.constructor
      && (!managed || document._source === source)
      && isDeepStrictEqual(document._source, certificate.source)
      && isDeepStrictEqual(document._source, source);
    if (!reusable) Map.prototype.delete.call(collection, id);
    else if (managed && hasNativeItemInitialization(document)) verified.add(document);
  }
  // Native initialization owns managed IDs, tombstones, inherited additions,
  // removal, document reset and validation of every new or changed document.
  collection.initialize({full: false});
  // A full native initialization inserts managed records before inherited ones.
  // Preserve that iteration order even when a changed record was recreated.
  const order = [];
  for (const source of collection._source) {
    const document = collection.get(source._id);
    if (!source._tombstone && document) order.push(document);
  }
  for (const document of base?.values() ?? []) {
    if (!sources.has(document.id) && collection.has(document.id)) order.push(collection.get(document.id));
  }
  const currentOrder = Array.from(collection.values());
  if (order.some((document, i) => document !== currentOrder[i])) {
    Map.prototype.clear.call(collection);
    for (const document of order) Map.prototype.set.call(collection, document.id, document);
  }
  for (const document of collection.values()) {
    if (!document.invalid && !certificates.has(document)) {
      certificates.set(document, {constructor: document.constructor, source: foundry.utils.deepClone(document._source)});
      // New certificates are taken after native initialization completes.
      if (document.documentName === "Item") verified.add(document);
    }
    const managed = sources.get(document.id);
    if (managed && document._source === managed && verified.has(document)) {
      itemSnapshots.set(managed, certificates.get(document).source);
    }
  }
}

/**
 * The audited server Item initializer only resets prepared values from source.
 * An unchanged, valid Item without embedded effects cannot change its source
 * during this reset. Custom initializers and effect-bearing Items use a fresh
 * snapshot instead. This optimization does not apply to client documents.
 */
function hasNativeItemInitialization(document) {
  const Model = foundry.abstract.DataModel;
  // Managed server Items use Foundry's anonymous delta subclass of db.Item.
  if (!(document instanceof db.Item && document._initialize === foundry.documents.BaseItem.prototype._initialize
    && document._initializationOrder === foundry.abstract.Document.prototype._initializationOrder
    && document.reset === Model.prototype.reset && !document._source.effects?.length)) return false;
  // Server system data is a plain record. A custom model or field initializer
  // may write back to source while resetting, so it cannot use this checkpoint.
  if (document.system && Object.getPrototypeOf(document.system) !== Object.prototype) return false;
  for (const field of document.schema.values()) {
    if (field.initialize !== field.constructor.prototype.initialize
      || foundry.data.fields[field.constructor.name] !== field.constructor) return false;
  }
  return true;
}

/**
 * Keep the native ActorDelta source projection, but reuse private, independently
 * copied Item certificates just verified by collection initialization. These
 * snapshots never escape: applyDelta receives deep copies. Snapshot sharing
 * avoids copying the inventory again and comparing two newly allocated copies
 * on the next load, while preserving the state at this particular load.
 */
function snapshotDeltaSource(delta, itemSnapshots) {
  if (delta.toObject !== foundry.documents.BaseActorDelta.prototype.toObject) return delta.toObject();
  const data = {};
  for (const [name, field] of delta.schema.entries()) {
    const value = delta._source[name];
    if (!field.required && (value === undefined || value === null)) continue;
    data[name] = name === "items" && Array.isArray(value)
      ? value.map(source => itemSnapshots.get(source) ?? foundry.utils.deepClone(source))
      : foundry.utils.deepClone(value);
  }
  return data;
}
