import { documentSourcesEqual } from "./document-source-equality.mjs";

const NativeTile = foundry.documents.TileDocument;
const certificates = new WeakMap();
const pending = new WeakMap();
const active = new WeakMap();
const nativeMethods = Object.fromEntries(
  ["_initialize", "prepareData", "prepareBaseData", "prepareEmbeddedDocuments", "prepareDerivedData"]
    .map(key => [key, NativeTile.prototype[key]])
);
const coordinateFields = new Set(["x", "y", "elevation", "rotation"]);
const movementFields = new Set([...coordinateFields, "_id", "_movementHistory", "regions"]);

/** Arm only the synchronous parent reset following a coordinate-only Token response. */
export function markMovementSceneReset(scene, parent, collection, changes) {
  pending.delete(scene);
  if (parent !== scene || collection !== "tokens" || !Array.isArray(changes) || !changes.length) return;
  if (!changes.every(change => change && typeof change._id === "string"
    && Object.keys(change).every(key => movementFields.has(key))
    && Object.keys(change).some(key => coordinateFields.has(key)))) return;
  const ticket = {};
  pending.set(scene, ticket);
  queueMicrotask(() => { if (pending.get(scene) === ticket) pending.delete(scene); });
}

/** Keep Scene's complete native reset; only unchanged native Tile data is reused. */
export function withMovementTileReuse(scene, reset) {
  const armed = pending.delete(scene);
  if (!armed || game.release?.version !== "14.361" || active.has(scene)
    || Object.entries(nativeMethods).some(([key, method]) => NativeTile.prototype[key] !== method)) return reset();
  const context = { reused: new WeakSet() };
  active.set(scene, context);
  try { return reset(); }
  finally { active.delete(scene); }
}

/** Native Tile preparation depends on its source and the Scene's dimensions. */
export class FalloutMaWTileDocument extends NativeTile {
  _initialize(options = {}) {
    const context = active.get(this.parent);
    const certificate = certificates.get(this);
    const dimensions = this.parent?.dimensions;
    if (options.sceneReset && context && certificate && this.constructor === FalloutMaWTileDocument
      && !this.invalid && dimensions?.width === certificate.width && dimensions?.height === certificate.height
      && documentSourcesEqual(this._source, certificate.source)) {
      context.reused.add(this);
      return;
    }
    context?.reused.delete(this);
    certificates.delete(this);
    return super._initialize(options);
  }

  prepareData() {
    if (active.get(this.parent)?.reused.has(this)) return;
    certificates.delete(this);
    super.prepareData();
    if (this.constructor !== FalloutMaWTileDocument || !this.parent?.dimensions || this.invalid) return;
    certificates.set(this, {
      source: foundry.utils.deepClone(this._source),
      width: this.parent.dimensions.width,
      height: this.parent.dimensions.height
    });
  }
}
