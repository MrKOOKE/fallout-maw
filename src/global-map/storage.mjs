import { FALLOUT_MAW } from "../config/system-config.mjs";
import {
  DEFAULT_SCENE_STATE,
  GLOBAL_MAP_FLAG,
  GLOBAL_MAP_ROOT_SCENE_SETTING,
  GLOBAL_MAP_VERSION,
  GLOBAL_MAP_ROLES
} from "./constants.mjs";

export function getGlobalMapFlag(document) {
  return document?.getFlag?.(FALLOUT_MAW.id, GLOBAL_MAP_FLAG) ?? null;
}

export function isManagedGlobalMapDocument(document) {
  const flag = getGlobalMapFlag(document);
  return Boolean(flag?.mapId && flag?.role);
}

export function isGlobalMapScene(scene) {
  return isManagedGlobalMapDocument(scene);
}

export function getSceneState(scene = canvas?.scene) {
  const flag = getGlobalMapFlag(scene);
  return normalizeSceneState(flag?.state);
}

export async function updateSceneState(scene, updater, options = {}) {
  if (!scene) return null;
  const current = getSceneState(scene);
  const next = typeof updater === "function"
    ? (await updater(foundry.utils.deepClone(current)))
    : foundry.utils.mergeObject(current, updater ?? {}, { inplace: false, recursive: true });
  const flag = {
    ...(getGlobalMapFlag(scene) ?? {}),
    version: GLOBAL_MAP_VERSION,
    state: normalizeSceneState(next)
  };
  if (options && Object.keys(options).length) {
    await scene.update({ [`flags.${FALLOUT_MAW.id}.${GLOBAL_MAP_FLAG}`]: flag }, options);
  } else {
    await scene.setFlag(FALLOUT_MAW.id, GLOBAL_MAP_FLAG, flag);
  }
  return flag.state;
}

export function normalizeSceneState(value) {
  const source = foundry.utils.deepClone(value ?? {});
  const state = foundry.utils.mergeObject(foundry.utils.deepClone(DEFAULT_SCENE_STATE), source, {
    inplace: false,
    recursive: true
  });
  state.locations = Array.isArray(state.locations) ? state.locations : [];
  state.terrains = Array.isArray(state.terrains) ? state.terrains : [];
  state.transitions = Array.isArray(state.transitions) ? state.transitions : [];
  state.locationExitZones = Array.isArray(state.locationExitZones) ? state.locationExitZones : [];
  state.travelAssemblies = Array.isArray(state.travelAssemblies) ? state.travelAssemblies : [];
  state.version = GLOBAL_MAP_VERSION;
  state.discoveredLocationIds = uniqueStrings(state.discoveredLocationIds);
  state.discoveredTransitionIds = uniqueStrings(state.discoveredTransitionIds);
  state.discoveredExitZoneIds = uniqueStrings(state.discoveredExitZoneIds);
  state.fog.mode = state.fog?.mode === "cells" ? "cells" : "native";
  state.fog.cellRadius = Math.max(1, Math.round(Number(state.fog?.cellRadius) || 2));
  state.fog.nativeMode = Number.isInteger(state.fog?.nativeMode) ? state.fog.nativeMode : null;
  state.fog.exploredCellKeys = uniqueStrings(state.fog?.exploredCellKeys);
  return state;
}

export function getRootScene() {
  const storedId = game.settings.get(FALLOUT_MAW.id, GLOBAL_MAP_ROOT_SCENE_SETTING);
  const stored = storedId ? game.scenes?.get(storedId) : null;
  if (getGlobalMapFlag(stored)?.role === GLOBAL_MAP_ROLES.ROOT_SCENE) return stored;
  return game.scenes?.find(scene => getGlobalMapFlag(scene)?.role === GLOBAL_MAP_ROLES.ROOT_SCENE) ?? null;
}

export function getRootFolder(mapId = null) {
  return game.folders?.find(folder => {
    const flag = getGlobalMapFlag(folder);
    return flag?.role === GLOBAL_MAP_ROLES.ROOT_FOLDER && (!mapId || flag.mapId === mapId);
  }) ?? null;
}

export function getLocationFolder(nodeId) {
  return game.folders?.find(folder => {
    const flag = getGlobalMapFlag(folder);
    return flag?.role === GLOBAL_MAP_ROLES.LOCATION_FOLDER && flag.nodeId === nodeId;
  }) ?? null;
}

export function getManagedSceneByNode(nodeId, roles = []) {
  return game.scenes?.find(scene => {
    const flag = getGlobalMapFlag(scene);
    return flag?.nodeId === nodeId && (!roles.length || roles.includes(flag.role));
  }) ?? null;
}

export function findLocation(locationId) {
  for (const scene of game.scenes ?? []) {
    const location = getSceneState(scene).locations.find(entry => entry.id === locationId);
    if (location) return { scene, location };
  }
  return null;
}

export async function saveCollectionEntry(scene, collection, entry) {
  return updateSceneState(scene, state => {
    const entries = Array.isArray(state[collection]) ? [...state[collection]] : [];
    const index = entries.findIndex(candidate => candidate.id === entry.id);
    if (index >= 0) entries[index] = foundry.utils.deepClone(entry);
    else entries.push(foundry.utils.deepClone(entry));
    state[collection] = entries;
    return state;
  });
}

export async function deleteCollectionEntry(scene, collection, id) {
  return updateSceneState(scene, state => {
    state[collection] = (state[collection] ?? []).filter(entry => entry.id !== id);
    return state;
  });
}

export async function setDiscovered(scene, type, id, discovered = true) {
  const key = type === "transition"
    ? "discoveredTransitionIds"
    : type === "exit"
      ? "discoveredExitZoneIds"
      : "discoveredLocationIds";
  return updateSceneState(scene, state => {
    const values = new Set(state[key] ?? []);
    if (discovered) values.add(String(id));
    else values.delete(String(id));
    state[key] = Array.from(values);
    return state;
  });
}

function uniqueStrings(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean)));
}
