import { GLOBAL_MAP_BYPASS_OPTION } from "./constants.mjs";
import { cellKey, parseCellKey } from "./geometry.mjs";
import { getGlobalMapFlag, getSceneState, updateSceneState } from "./storage.mjs";

const SNAPSHOT_OPTION = "falloutMaWGlobalMapGridSnapshot";

export function registerGlobalMapGridHooks() {
  Hooks.on("preUpdateScene", captureGridSnapshot);
  Hooks.on("updateScene", reprojectGridData);
}

function captureGridSnapshot(scene, changes, options) {
  if (options?.[GLOBAL_MAP_BYPASS_OPTION] || !getGlobalMapFlag(scene) || !hasGridChange(changes)) return;
  const state = getSceneState(scene);
  options[SNAPSHOT_OPTION] = {
    locations: state.locations.map(location => ({
      id: location.id,
      point: { x: location.x, y: location.y }
    })),
    terrains: state.terrains.map(entry => ({
      id: entry.id,
      points: keysToPoints(scene.grid, entry.cells)
    })),
    transitions: state.transitions.map(entry => ({
      id: entry.id,
      points: keysToPoints(scene.grid, entry.cells)
    })),
    locationExitZones: state.locationExitZones.map(entry => ({
      id: entry.id,
      points: keysToPoints(scene.grid, entry.cells)
    })),
    incoming: Array.from(game.scenes ?? []).flatMap(sourceScene =>
      getSceneState(sourceScene).transitions
        .filter(entry => entry.targetSceneId === scene.id)
        .map(entry => ({
          sourceSceneId: sourceScene.id,
          transitionId: entry.id,
          entryPoints: keysToPoints(scene.grid, entry.entryCells)
        }))
    )
  };
}

async function reprojectGridData(scene, changes, options) {
  const snapshot = options?.[SNAPSHOT_OPTION];
  if (!snapshot || !getGlobalMapFlag(scene) || !hasGridChange(changes)) return;
  await updateSceneState(scene, state => {
    const locations = new Map(snapshot.locations.map(entry => [entry.id, entry]));
    state.locations = state.locations.map(location => {
      const source = locations.get(location.id);
      if (!source) return location;
      const cell = scene.grid.getOffset(source.point);
      const point = scene.grid.getCenterPoint(cell);
      return { ...location, x: point.x, y: point.y };
    });
    const terrains = new Map(snapshot.terrains.map(entry => [entry.id, entry]));
    state.terrains = state.terrains.map(entry => ({
      ...entry,
      cells: pointsToKeys(scene.grid, terrains.get(entry.id)?.points)
    }));
    const transitions = new Map(snapshot.transitions.map(entry => [entry.id, entry]));
    state.transitions = state.transitions.map(entry => ({
      ...entry,
      cells: pointsToKeys(scene.grid, transitions.get(entry.id)?.points)
    }));
    const locationExitZones = new Map((snapshot.locationExitZones ?? []).map(entry => [entry.id, entry]));
    state.locationExitZones = state.locationExitZones.map(entry => ({
      ...entry,
      cells: pointsToKeys(scene.grid, locationExitZones.get(entry.id)?.points)
    }));
    return state;
  }, { [GLOBAL_MAP_BYPASS_OPTION]: true });
  const incomingByScene = new Map();
  for (const entry of snapshot.incoming ?? []) {
    if (!incomingByScene.has(entry.sourceSceneId)) incomingByScene.set(entry.sourceSceneId, []);
    incomingByScene.get(entry.sourceSceneId).push(entry);
  }
  for (const [sourceSceneId, entries] of incomingByScene) {
    const sourceScene = game.scenes?.get(sourceSceneId);
    if (!sourceScene) continue;
    const pointsById = new Map(entries.map(entry => [entry.transitionId, entry.entryPoints]));
    await updateSceneState(sourceScene, state => {
      state.transitions = state.transitions.map(entry => pointsById.has(entry.id)
        ? { ...entry, entryCells: pointsToKeys(scene.grid, pointsById.get(entry.id)) }
        : entry);
      return state;
    }, { [GLOBAL_MAP_BYPASS_OPTION]: true });
  }
  if (scene.id === canvas.scene?.id) await canvas.falloutMaWGlobalMap?.refresh?.();
}

function keysToPoints(grid, keys = []) {
  return keys.map(parseCellKey).filter(Boolean).map(cell => grid.getCenterPoint(cell));
}

function pointsToKeys(grid, points = []) {
  return Array.from(new Set(points.map(point => cellKey(grid.getOffset(point)))));
}

function hasGridChange(changes) {
  return changes?.grid !== undefined
    || Object.keys(changes ?? {}).some(key => key.startsWith("grid."));
}
