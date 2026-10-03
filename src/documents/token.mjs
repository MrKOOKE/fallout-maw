import { isPhantomEntity } from "../abilities/phantom-entity.mjs";
import { COMBAT_MOVEMENT_RESOURCE_UPDATE_OPTION } from "../constants.mjs";
import { cloneTokenPreview } from "./token-clone-initialization.mjs";
import { createTokenSourceSerializer } from "./token-source-serialization.mjs";
import { assertBatchPreflightIds } from "../utils/document-batch-integrity.mjs";
import { applyTokenMovementAutoRotateOverride } from "../utils/token-movement-auto-rotate.mjs";
import { getTokenHitboxGeometry, getTokenHitboxWorldBounds, getTokenHitboxTestPoints, getTokenHitboxGridCells } from "../utils/token-hitbox.mjs";
import { getFootprintTurnRotations, usesFootprintRouteRotation, prepareFootprintRoute } from "../utils/token-footprint-route.mjs";
import { purchaseConstructRotation, refundConstructRotation, getConstructRouteRotationCost, notifyConstructRotationSpent } from "../constructs/rotation-actions.mjs";

const serializeTokenSource = createTokenSourceSerializer(TokenDocument);

/**
 * Token document behavior owned by the system.
 *
 * Phantom entities are real TokenDocuments and still provide vision, but they
 * are deliberately absent from Region membership. Foundry dispatches Region
 * enter/exit behavior from that membership, including while a token is being
 * deleted. Letting a damage-destroyed phantom participate there would run
 * ordinary actor mechanics against a synthetic actor during its teardown.
 */
export class FalloutMaWTokenDocument extends TokenDocument {
  _couldRegionsChange(changes) {
    return super._couldRegionsChange(changes)
      || Boolean(getTokenHitboxGeometry(this, changes) && ("rotation" in changes || "lockRotation" in changes))
      || Object.keys(foundry.utils.flattenObject(changes)).some(key => /^flags\.fallout-maw\.(?:tokenHitbox|-=tokenHitbox)/.test(key));
  }

  testInsideRegion(region, data = {}) {
    const position = { ...this._source, ...data };
    const bodyBounds = getTokenHitboxWorldBounds(this, position);
    if (!bodyBounds && !getTokenHitboxGeometry(this)) return super.testInsideRegion(region, data);
    const size = this.getSize(position);
    const bounds = bodyBounds ?? { x: position.x, y: position.y, ...size };
    if (this.parent !== region.parent) throw new Error("The Token and the Region must be in the same Scene");
    if (!region.includedInLevel(position.level)) return false;
    const { bottom, top, topInclusive } = region.elevation;
    if (topInclusive ? position.elevation > top : position.elevation !== bottom && position.elevation >= top) return false;
    const head = position.elevation + position.depth * this.parent.grid.distance;
    if (position.depth ? head <= bottom : head < bottom) return false;
    if (!region.bounds.intersects(new PIXI.Rectangle(bounds.x, bounds.y, bounds.width, bounds.height))) return false;
    const points = bodyBounds ? this.getContainmentTestPoints(position) : super.getContainmentTestPoints(position);
    return points.some(point => region.polygonTree.testPoint(point, 0.75));
  }

  segmentizeRegionMovementPath(region, waypoints) {
    if (!getTokenHitboxGeometry(this, this._source)) return super.segmentizeRegionMovementPath(region, waypoints);
    if (this.parent !== region.parent) throw new Error("The Token and the Region must be in the same Scene");
    if (waypoints.length <= 1) return [];
    waypoints = prepareFootprintRoute(this, waypoints);
    const segments = [];
    let previous = { ...this._source, action: this.movementAction, ...waypoints[0] };
    for (const waypoint of waypoints.slice(1)) {
      const next = { ...previous, terrain: null, snapped: false, ...waypoint };
      next.x = Math.round(next.x); next.y = Math.round(next.y);
      const from = { x: previous.x, y: previous.y, elevation: previous.elevation };
      if (["width", "height", "shape"].some(key => next[key] !== previous[key])) {
        const center = this.getMovementOrigin(previous), pivot = this.getMovementOrigin({ ...next, x: 0, y: 0 });
        from.x = Math.round(center.x - pivot.x); from.y = Math.round(center.y - pivot.y);
      }
      if (region.includedInLevel(previous.level)) {
        const to = { x: next.x, y: next.y, elevation: next.elevation, teleport: CONFIG.Token.movement.actions[next.action].teleport };
        // Native Region segmentation handles the same path and teleport rules;
        // supply samples of the rotated native footprint.
        const samples = getTokenHitboxTestPoints(this, { ...next, rotation: next._footprintTravelRotation ?? next.rotation, x: 0, y: 0 });
        for (const segment of region.segmentizeMovementPath([from, to], samples)) {
          delete segment.teleport;
          Object.assign(segment, { action: next.action, terrain: next.terrain?.clone() ?? null, snapped: next.snapped });
          for (const key of ["width", "height", "depth", "shape"]) segment.from[key] = segment.to[key] = next[key];
          segment.from.level = segment.to.level = previous.level;
          segments.push(segment);
        }
      }
      previous = next;
    }
    return segments;
  }

  getGridSpacePolygon(data = {}) {
    return getTokenHitboxGeometry(this, data)?.points ?? super.getGridSpacePolygon(data);
  }

  getContainmentTestPoints(data = {}) {
    const points = getTokenHitboxTestPoints(this, data);
    if (!points) return super.getContainmentTestPoints(data);
    this._constrainTestPoints(points, data); return points;
  }

  getVisibilityTestPoints(data = {}) {
    if (!getTokenHitboxGeometry(this, data)) return super.getVisibilityTestPoints(data);
    const points = this.getContainmentTestPoints(data), elevation = this.getMovementOrigin(data).elevation;
    for (const point of points) point.elevation = elevation;
    return points;
  }

  getOcclusionTestPoints(data = {}) {
    return getTokenHitboxGeometry(this, data) ? this.getContainmentTestPoints(data) : super.getOcclusionTestPoints(data);
  }

  _constrainTestPoints(points, data = {}) {
    const bounds = getTokenHitboxWorldBounds(this, data);
    if (!bounds) return super._constrainTestPoints(points, data);
    const scene = this.parent, level = scene?.levels.get(data.level ?? this.level);
    if (!level) return;
    const origin = this.getMovementOrigin(data);
    if (origin.x < 0 || origin.x > scene.dimensions.width || origin.y < 0 || origin.y > scene.dimensions.height) {
      points.length = 0; return;
    }
    // Same native wall/surface constraints, with the rotated body's broad phase.
    const boundingBox = new PIXI.Rectangle(bounds.x, bounds.y, bounds.width, bounds.height);
    const polygon = foundry.canvas.geometry.ClockwiseSweepPolygon.create(origin, { type: "move", level, boundingBox });
    const options = { type: "move", mode: "any", level };
    for (let i = points.length - 1; i >= 0; i--) {
      const point = points[i];
      if (polygon.contains(point.x, point.y) && (point.elevation === undefined || !scene.testSurfaceCollision(origin, point, options))) continue;
      points[i] = points.at(-1); points.length--;
    }
    if (!points.length) {
      const center = getTokenHitboxGeometry(this, data).center;
      points.push({ x: (data.x ?? this.x) + center.x, y: (data.y ?? this.y) + center.y });
    }
  }

  getOccupiedGridSpaceOffsets(data = {}) {
    const geometry = getTokenHitboxGeometry(this, data), grid = this.parent?.grid;
    if (!geometry) return super.getOccupiedGridSpaceOffsets(data);
    const rotation = (data.lockRotation ?? this.lockRotation) ? 0 : (data.rotation ?? this.rotation);
    if (Number.isFinite(data._footprintTurnFrom)) {
      const { _footprintTurnFrom, ...position } = data;
      const offsets = new Map();
      for (const angle of getFootprintTurnRotations(_footprintTurnFrom, rotation))
        for (const offset of this.getOccupiedGridSpaceOffsets({ ...position, rotation: angle }))
          offsets.set(`${offset.i},${offset.j},${offset.k}`, offset);
      return [...offsets.values()];
    }
    if (grid?.isSquare && Math.abs(rotation / 90 - Math.round(rotation / 90)) < 1e-6) {
      // Cardinal orientations are ordinary native rectangles, including native
      // snapping, wall/surface tests and full-cell occupancy.
      const bounds = getTokenHitboxWorldBounds(this, data);
      return super.getOccupiedGridSpaceOffsets({ ...data, x: Math.round(bounds.x), y: Math.round(bounds.y),
        width: bounds.width / grid.sizeX, height: bounds.height / grid.sizeY });
    }
    const samples = getTokenHitboxGridCells(this, data);
    this._constrainTestPoints(samples, data);
    return samples.filter(point => point.offset).map(point => point.offset);
  }

  measureMovementPath(waypoints, { cost, aggregator = CONFIG.Token.movement.costAggregator } = {}) {
    const grid = this.parent?.grid;
    const autoRotate = usesFootprintRouteRotation(this);
    if (!getTokenHitboxGeometry(this) || !grid?.isSquare || typeof cost !== "function"
      || !autoRotate && Math.abs(this.rotation / 180 - Math.round(this.rotation / 180)) < 1e-6
      || waypoints.some(point => point.cost !== undefined)
      || this.width <= 1 && this.height <= 1 && this.depth <= 1)
      return super.measureMovementPath(waypoints, { cost, aggregator });
    // The native path, diagonal rules, snapping and resize segments stay in
    // Foundry. Its public aggregator samples this footprint instead of the
    // unrotated rectangle. Its native cost aggregator remains unchanged.
    const segmentRotations = new WeakMap(), headings = new Map();
    const offsetKey = (offset, data) => `${offset.i},${offset.j},${offset.k}:${data.width ?? this.width},${data.height ?? this.height},${data.shape ?? this.shape}:${data.action ?? this.movementAction}`;
    if (autoRotate) for (const point of prepareFootprintRoute(this, waypoints).slice(1)) {
      const key = offsetKey(this._positionToGridOffset(point), point);
      const queue = headings.get(key) ?? []; queue.push(point._footprintTravelRotation ?? this.rotation); headings.set(key, queue);
    }
    return super.measureMovementPath(waypoints, { cost: () => 0, aggregator: (samples, distance, segment) => {
      const from = samples[0].from, to = samples[0].to;
      const position = this._gridOffsetToPosition(from, segment);
      if (!segmentRotations.has(segment)) segmentRotations.set(segment,
        headings.get(offsetKey(grid.getOffset(segment), segment))?.shift() ?? this.rotation);
      const rotation = segmentRotations.get(segment);
      const cells = getTokenHitboxGridCells(this, { ...segment, ...position, rotation });
      const results = cells.map(({ offset }) => {
        const destination = { i: offset.i + to.i - from.i, j: offset.j + to.j - from.j, k: offset.k + to.k - from.k };
        return { from: offset, to: destination, cost: cost(offset, destination, distance, segment) };
      });
      return results.length ? aggregator(results, distance, segment) : cost(from, to, distance, segment);
    } });
  }

  async _preUpdate(changes, options, user) {
    applyTokenMovementAutoRotateOverride(this, options);
    const allowed = await super._preUpdate(changes, options, user);
    if (allowed === false) return false;
    const bypass = options.isUndo || !options.falloutMawConstructCrewMovement && user?.isGM && game.keyboard?.downKeys?.has("AltLeft");
    const movement = options._movement?.[this.id];
    const route = movement?.autoRotate ? movement.passed.waypoints : null;
    const routeTurns = route ? getConstructRouteRotationCost(this, route, { autoRotate: true }) : 0;
    if (this.actor?.type === "construct" && !bypass && !options.dryRun && !movement?.planned && (routeTurns > 0 || Object.hasOwn(changes, "rotation")
      && Math.abs(((changes.rotation - this._source.rotation + 540) % 360) - 180) > 1e-6)) {
      try {
        const plan = await purchaseConstructRotation(this, "hull", Number(changes.rotation ?? this._source.rotation), { path: route, notify: false });
        if (!plan.reached) {
          if (route || Math.abs(((plan.rotation - this._source.rotation + 540) % 360) - 180) < 1e-6) {
            await refundConstructRotation(plan.receipt); ui.notifications.warn("Не хватает ОП для поворота корпуса."); return false;
          }
          changes.rotation = ((plan.rotation % 360) + 360) % 360;
          ui.notifications.warn("Поворот ограничен оплаченным сектором.");
        }
        if (plan.receipt) (options.falloutMawRotationReceipts ??= []).push(plan.receipt);
      } catch (error) { ui.notifications.warn(error.message); return false; }
    }
    return allowed;
  }

  static async updateDocuments(updates = [], operation = {}) {
    operation.falloutMawRotationReceipts ??= [];
    let documents = [];
    try { documents = await super.updateDocuments(updates, operation); return documents; }
    finally {
      for (const receipt of operation.falloutMawRotationReceipts ?? []) {
        const doc = documents.find(doc => doc.uuid === receipt.tokenUuid);
        if (doc) await notifyConstructRotationSpent(doc.actor, receipt);
        else await refundConstructRotation(receipt);
      }
    }
  }

  static async createDocuments(data = [], operation = {}) {
    const documents = await super.createDocuments(data, operation);
    assertBatchPreflightIds(operation, "create");
    return documents;
  }

  static async deleteDocuments(ids = [], operation = {}) {
    const documents = await super.deleteDocuments(ids, operation);
    assertBatchPreflightIds(operation, "delete");
    return documents;
  }

  _onRelatedUpdate(update = {}, operation = {}) {
    if (!operation?.[COMBAT_MOVEMENT_RESOURCE_UPDATE_OPTION]) {
      return super._onRelatedUpdate(update, operation);
    }
    refreshCombatMovementTokenState(this, update, operation);
  }

  toObject(source = true) {
    if (this.constructor !== FalloutMaWTokenDocument) return super.toObject(source);
    return serializeTokenSource(this, source, () => super.toObject(source));
  }

  clone(data = {}, context = {}) {
    return cloneTokenPreview(this, data, context, options => super.clone(data, options));
  }

  prepareBaseData() {
    super.prepareBaseData();
    if (!isPhantomEntity(this) || !this.regions?.size) return;
    for (const region of this.regions) region.tokens?.delete?.(this);
    this.regions.clear();
  }

  _identifyRegions(changes = {}) {
    if (isPhantomEntity(this)) return [];
    return super._identifyRegions(changes);
  }
}

/**
 * Foundry's default related-Actor refresh redraws token effects, animates both
 * bars, and renders the whole Combat Tracker after every ActorDelta update.
 * A movement-resource transaction changes none of those unless a token bar or
 * the tracked combat resource is explicitly bound to ОП/ОД/ОР.
 */
function refreshCombatMovementTokenState(tokenDocument, update, operation) {
  const changedPaths = getActorUpdatePaths(update);
  const changedBars = getChangedTokenBars(tokenDocument, changedPaths);
  if (changedBars.length) refreshChangedTokenBars(tokenDocument, changedBars);

  const combatant = tokenDocument.combatant;
  const trackedResource = String(game.combat?.settings?.resource ?? "").trim();
  const isActorUpdate = [tokenDocument, null, undefined].includes(operation.parent);
  if (
    combatant
    && isActorUpdate
    && trackedResource
    && actorUpdateTouchesPath(changedPaths, normalizeActorSystemPath(trackedResource))
  ) {
    combatant.updateResource();
    ui.combat.render();
  }
}

function getActorUpdatePaths(update) {
  const updates = Array.isArray(update) ? update : [update];
  const paths = new Set();
  for (const entry of updates) {
    if (!entry || typeof entry !== "object") continue;
    for (const path of Object.keys(foundry.utils.flattenObject(entry))) paths.add(path);
  }
  return paths;
}

function getChangedTokenBars(tokenDocument, changedPaths) {
  const changed = [];
  for (const key of ["bar1", "bar2"]) {
    const attribute = String(tokenDocument[key]?.attribute ?? "").trim();
    if (attribute && actorUpdateTouchesPath(changedPaths, normalizeActorSystemPath(attribute))) changed.push(key);
  }
  return changed;
}

function refreshChangedTokenBars(tokenDocument, changedBars) {
  tokenDocument._prepareBars();
  if (!tokenDocument.parent?.isView || !tokenDocument.object) return;

  if (tokenDocument.object.hasActiveHUD) canvas.tokens.hud.render();
  const attributes = Object.fromEntries(changedBars.map(key => [key, tokenDocument[key]]));
  const name = `${tokenDocument.object.objectId}.animateBars`;
  const easing = foundry.canvas.animation.CanvasAnimation.easeInOutCosine;
  tokenDocument.object.animate(attributes, { name, easing });

  for (const app of foundry.applications.sheets.TokenConfig.instances()) {
    app._preview?.updateSource({ delta: tokenDocument.toObject().delta }, { diff: false, recursive: false });
    app._preview?.object?.renderFlags.set({ refreshBars: true });
  }
}

function normalizeActorSystemPath(path) {
  const normalized = String(path ?? "").trim();
  return normalized.startsWith("system.") ? normalized : `system.${normalized}`;
}

function actorUpdateTouchesPath(changedPaths, targetPath) {
  if (!targetPath || targetPath === "system.") return false;
  for (const changedPath of changedPaths) {
    if (
      changedPath === targetPath
      || changedPath.startsWith(`${targetPath}.`)
      || targetPath.startsWith(`${changedPath}.`)
    ) return true;
  }
  return false;
}
