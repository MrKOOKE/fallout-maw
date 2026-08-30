import { SYSTEM_ID } from "../constants.mjs";
import {
  removeCoverContour,
  replaceCoverContours,
  upsertCoverContour
} from "./cover-contours.mjs";
import { getTileHitboxWorldPoints, registerTileHitboxHooks } from "./tile-hitbox.mjs";

export const TILE_SPECIAL_PROPERTIES_FLAG = "tileSpecialProperties";
export const TILE_SPECIAL_PROPERTY_COVER = "cover";
export const TILE_SPECIAL_PROPERTY_PENDING = "pending";

const TILE_CONTOUR_NAMESPACE = `${SYSTEM_ID}.tile-hitboxes`;
const hydratedScenes = new WeakSet();
let hooksRegistered = false;

/**
 * Register the Tile-to-contour adapter. Runtime mechanics never receive Tile documents;
 * this boundary copies only prepared green geometry and its configured cover key.
 */
export function registerTileCoverContourHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  registerTileHitboxHooks();
  Hooks.on("canvasReady", canvasObject => hydrateTileCoverContours(canvasObject?.scene ?? globalThis.canvas?.scene));
  Hooks.on("createTile", syncTileCoverContour);
  Hooks.on("updateTile", (tile, changes) => {
    if (tileUpdateAffectsCoverContour(changes)) syncTileCoverContour(tile);
  });
  Hooks.on("deleteTile", removeTileCoverContour);
}

/** Atomically snapshot the effective green contours for one ready Scene. */
export function hydrateTileCoverContours(scene) {
  if (!scene || typeof scene !== "object") return;
  const entries = [];
  for (const tile of getSceneTiles(scene)) {
    const entry = createTileCoverContourEntry(tile);
    if (entry) entries.push(entry);
  }
  replaceCoverContours(scene, TILE_CONTOUR_NAMESPACE, entries);
  hydratedScenes.add(scene);
}

/** Normalize persisted rows, retaining at most one selectable Tile property. */
export function normalizeTileSpecialProperties(value = []) {
  const rows = Array.isArray(value) ? value : Object.values(value ?? {});
  const cover = rows.find(row => String(row?.type ?? "").trim() === TILE_SPECIAL_PROPERTY_COVER);
  const selected = cover ?? rows.find(row => row && typeof row === "object");
  if (!selected) return [];
  return [createDefaultTileSpecialPropertyData(
    cover ? TILE_SPECIAL_PROPERTY_COVER : TILE_SPECIAL_PROPERTY_PENDING,
    selected
  )];
}

/** Create a complete UI row when a special property is added or changed. */
export function createDefaultTileSpecialPropertyData(type = TILE_SPECIAL_PROPERTY_PENDING, source = {}) {
  return {
    type: type === TILE_SPECIAL_PROPERTY_COVER
      ? TILE_SPECIAL_PROPERTY_COVER
      : TILE_SPECIAL_PROPERTY_PENDING,
    coverKey: String(source?.coverKey ?? source?.cover?.key ?? "").trim()
  };
}

/** Resolve a configured cover row, excluding incomplete placeholder rows. */
export function getTileCoverSpecialProperty(value = []) {
  const property = normalizeTileSpecialProperties(value)
    .find(row => row.type === TILE_SPECIAL_PROPERTY_COVER);
  return property?.coverKey ? property : null;
}

function syncTileCoverContour(tile) {
  const scene = getTileScene(tile);
  if (!scene || !hydratedScenes.has(scene)) return;
  const sourceId = getTileSourceId(tile);
  if (!sourceId) return;
  upsertCoverContour(scene, TILE_CONTOUR_NAMESPACE, sourceId, createTileCoverContourEntry(tile));
}

function removeTileCoverContour(tile) {
  const scene = getTileScene(tile);
  if (!scene || !hydratedScenes.has(scene)) return;
  removeCoverContour(scene, TILE_CONTOUR_NAMESPACE, getTileSourceId(tile));
}

function createTileCoverContourEntry(tile) {
  const sourceId = getTileSourceId(tile);
  const property = getTileCoverSpecialProperty(getTileSpecialProperties(tile));
  if (!sourceId || !property) return null;

  const points = getTileHitboxWorldPoints(tile);
  if (points.length < 3) return null;
  return {
    sourceId,
    coverKey: property.coverKey,
    levelIds: getTileLevels(tile),
    points
  };
}

function getSceneTiles(scene) {
  const collection = scene?.tiles?.contents ?? scene?.tiles;
  if (Array.isArray(collection)) return collection;
  if (collection?.[Symbol.iterator]) return Array.from(collection);
  return [];
}

function getTileSpecialProperties(tile) {
  return tile?.getFlag?.(SYSTEM_ID, TILE_SPECIAL_PROPERTIES_FLAG)
    ?? tile?.flags?.[SYSTEM_ID]?.[TILE_SPECIAL_PROPERTIES_FLAG]
    ?? tile?._source?.flags?.[SYSTEM_ID]?.[TILE_SPECIAL_PROPERTIES_FLAG]
    ?? [];
}

function getTileLevels(tile) {
  const value = tile?.levels ?? tile?._source?.levels ?? [];
  if (!value?.[Symbol.iterator] || typeof value === "string") return [];
  return Array.from(value, id => String(id ?? "").trim()).filter(Boolean);
}

function getTileScene(tile) {
  return tile?.parent ?? tile?.document?.parent ?? null;
}

function getTileSourceId(tile) {
  return String(tile?.uuid ?? tile?.document?.uuid ?? tile?.id ?? tile?._id ?? tile?._source?._id ?? "").trim();
}

function tileUpdateAffectsCoverContour(changes) {
  if (!changes || typeof changes !== "object") return true;
  if (["x", "y", "width", "height", "rotation", "levels"].some(key => Object.hasOwn(changes, key))) return true;
  const texture = changes.texture;
  if (texture && typeof texture === "object"
    && ["anchorX", "anchorY"].some(key => Object.hasOwn(texture, key))) return true;
  return changedFlagScope(changes, SYSTEM_ID) || changedFlagScope(changes, "rimworld-map-bridge");
}

function changedFlagScope(changes, scope) {
  const flags = changes?.flags;
  if (flags && typeof flags === "object"
    && (Object.hasOwn(flags, scope) || Object.hasOwn(flags, `-=${scope}`))) return true;
  return Object.keys(changes ?? {}).some(key => key === `flags.${scope}`
    || key.startsWith(`flags.${scope}.`) || key.startsWith(`flags.-=${scope}`));
}
