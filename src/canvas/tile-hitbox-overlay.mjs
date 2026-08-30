import { SYSTEM_ID } from "../constants.mjs";
import {
  getTileHitboxWorldPoints,
  RIMWORLD_BRIDGE_ID,
  RIMWORLD_TILE_HITBOX_FLAG,
  TILE_HITBOX_FLAG
} from "./tile-hitbox.mjs";

const HITBOX_GREEN = 0x39ff88;
const HITBOX_OUTLINE = 0x071d0d;
const OVERLAY_LABEL = "fallout-maw.tile-hitbox-overlay";

const overlayStates = new WeakMap();
const managedTiles = new Set();
let hooksRegistered = false;

/**
 * Register an event-driven diagnostic outline for Tile hitboxes.
 * The overlay never participates in pointer interaction and has no ticker callback.
 */
export function registerTileHitboxOverlayHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;

  Hooks.on("drawTile", tile => syncTileHitboxOverlay(tile, { redraw: true }));
  Hooks.on("refreshTile", (tile, flags) => {
    if (refreshAffectsGeometry(flags)) syncTileHitboxOverlay(tile, { redraw: true });
    else refreshTileHitboxOverlayVisibility(tile);
  });
  Hooks.on("updateTile", (document, changes) => {
    if (tileUpdateAffectsOverlay(changes)) syncTileHitboxOverlay(document?.object, { redraw: true });
  });
  Hooks.on("controlTile", tile => syncTileHitboxOverlay(tile, { redraw: false }));
  Hooks.on("hoverTile", tile => syncTileHitboxOverlay(tile, { redraw: false }));
  Hooks.on("destroyTile", removeTileHitboxOverlay);
  Hooks.on("deleteTile", document => removeTileHitboxOverlay(document?.object));
  Hooks.on("canvasTearDown", clearTileHitboxOverlays);
}

/** Draw or refresh one Tile's green hitbox outline. */
export function syncTileHitboxOverlay(tile, { redraw = true } = {}) {
  if (!tile?.document || tile.destroyed) return;

  let state = overlayStates.get(tile);
  if (!state && !shouldShowOverlay(tile)) return;
  if (state?.graphics && !state.graphics.destroyed && state.graphics.parent === tile && !redraw) {
    state.graphics.visible = shouldShowOverlay(tile);
    return;
  }

  const points = getTileHitboxWorldPoints(tile.document);
  if (!state?.graphics || state.graphics.destroyed || state.graphics.parent !== tile) {
    if (state) removeTileHitboxOverlay(tile);
    if (points.length < 3) return;
    const Graphics = globalThis.PIXI?.Graphics;
    if (!Graphics || typeof tile.addChild !== "function") return;
    const graphics = new Graphics();
    graphics.label = OVERLAY_LABEL;
    graphics.eventMode = "none";
    graphics.interactive = false;
    graphics.interactiveChildren = false;
    graphics.cursor = null;
    tile.addChild(graphics);
    state = { graphics };
    overlayStates.set(tile, state);
    managedTiles.add(tile);
    redraw = true;
  }

  const graphics = state.graphics;
  const hasHitbox = points.length >= 3;
  graphics.visible = hasHitbox && shouldShowOverlay(tile);
  if (!hasHitbox) {
    removeTileHitboxOverlay(tile);
    return;
  }
  if (!redraw) return;

  const width = getOverlayLineWidth();
  const foregroundWidth = width * 1.35;
  const flatPoints = flattenPoints(points);
  graphics.clear();
  graphics.lineStyle(foregroundWidth + 2, HITBOX_OUTLINE, 0.95);
  graphics.drawPolygon(flatPoints);
  graphics.lineStyle(foregroundWidth, HITBOX_GREEN, 1);
  graphics.drawPolygon(flatPoints);
}

/** Destroy every system-owned overlay without touching core Tile graphics. */
export function clearTileHitboxOverlays() {
  for (const tile of [...managedTiles]) removeTileHitboxOverlay(tile);
}

function refreshTileHitboxOverlayVisibility(tile) {
  const graphics = overlayStates.get(tile)?.graphics;
  if (graphics && !graphics.destroyed) graphics.visible = shouldShowOverlay(tile);
}

function removeTileHitboxOverlay(tile) {
  if (!tile) return;
  const state = overlayStates.get(tile);
  const graphics = state?.graphics;
  if (graphics && !graphics.destroyed) {
    if (graphics.parent === tile) tile.removeChild(graphics);
    graphics.destroy({ children: true });
  }
  overlayStates.delete(tile);
  managedTiles.delete(tile);
}

function shouldShowOverlay(tile) {
  // Tile.draw temporarily sets the container's `visible` to false before the draw hook.
  // Use Foundry's logical visibility there so the overlay is ready when the container is restored.
  if (tile.isVisible === false || (tile.isVisible === undefined && tile.visible === false)) return false;
  return !!(tile.hover || tile.controlled);
}

function refreshAffectsGeometry(flags) {
  if (!flags || typeof flags !== "object") return false;
  return ["redraw", "refresh", "refreshTransform", "refreshPosition", "refreshRotation", "refreshSize"]
    .some(flag => !!flags[flag]);
}

function tileUpdateAffectsOverlay(changes) {
  if (!changes || typeof changes !== "object") return true;
  if (["x", "y", "width", "height", "rotation", "hidden"].some(key => Object.hasOwn(changes, key))) return true;
  const texture = changes.texture;
  if (texture && typeof texture === "object"
    && ["anchorX", "anchorY"].some(key => Object.hasOwn(texture, key))) return true;
  return changedFlag(changes, SYSTEM_ID, TILE_HITBOX_FLAG)
    || changedFlag(changes, RIMWORLD_BRIDGE_ID, RIMWORLD_TILE_HITBOX_FLAG);
}

function changedFlag(changes, scope, key) {
  const flags = changes?.flags;
  if (flags && typeof flags === "object") {
    if (Object.hasOwn(flags, `-=${scope}`)) return true;
    if (Object.hasOwn(flags, scope)) {
      const scoped = flags[scope];
      if (!scoped || typeof scoped !== "object") return true;
      return Object.hasOwn(scoped, key) || Object.hasOwn(scoped, `-=${key}`);
    }
  }
  return Object.keys(changes ?? {}).some(changeKey => changeKey === `flags.${scope}`
    || changeKey === `flags.${scope}.${key}` || changeKey.startsWith(`flags.${scope}.${key}.`)
    || changeKey === `flags.${scope}.-=${key}`
    || changeKey === `flags.-=${scope}`);
}

function getOverlayLineWidth() {
  const gridSize = Number(globalThis.canvas?.dimensions?.size) || 100;
  return Math.max(2, Math.min(5, gridSize * 0.035));
}

function flattenPoints(points) {
  const flattened = new Array(points.length * 2);
  for (let index = 0; index < points.length; index += 1) {
    flattened[index * 2] = points[index].x;
    flattened[(index * 2) + 1] = points[index].y;
  }
  return flattened;
}
