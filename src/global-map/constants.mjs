import { FALLOUT_MAW } from "../config/system-config.mjs";

export const GLOBAL_MAP_FLAG = "globalMap";
export const GLOBAL_MAP_VERSION = 1;
export const GLOBAL_MAP_ROOT_SCENE_SETTING = "globalMapRootSceneId";
export const GLOBAL_MAP_LAYER = "falloutMaWGlobalMap";
export const GLOBAL_MAP_SOCKET = `system.${FALLOUT_MAW.id}`;
export const GLOBAL_MAP_BYPASS_OPTION = "falloutMaWGlobalMapBypass";

export const GLOBAL_MAP_ROLES = Object.freeze({
  ROOT_FOLDER: "rootFolder",
  ROOT_SCENE: "rootScene",
  LOCATION_FOLDER: "locationFolder",
  LOCATION_SCENE: "locationScene",
  ZONE_SCENE: "zoneScene"
});

export const DEFAULT_LOCATION = Object.freeze({
  name: "Новая локация",
  size: 1,
  strokeColor: "#ffffff",
  strokeWidth: 3,
  textColor: "#ffffff",
  fontSize: 28,
  image: "",
  mapImage: "",
  alwaysDiscovered: false,
  linkedSceneId: null,
  linkedSceneOwned: false
});

export const DEFAULT_TERRAIN = Object.freeze({
  name: "Новая местность",
  color: "#4a90d9",
  difficulty: 0,
  cellAreaKm: 5,
  brushRadius: 1
});

export const DEFAULT_TRANSITION = Object.freeze({
  name: "Новая зона перехода",
  color: "#7c4dff",
  hidden: false,
  brushRadius: 1,
  mapImage: "",
  targetSceneId: null,
  targetOwned: false,
  entryCells: []
});

export const DEFAULT_SCENE_STATE = Object.freeze({
  version: GLOBAL_MAP_VERSION,
  locations: [],
  terrains: [],
  transitions: [],
  discoveredLocationIds: [],
  discoveredTransitionIds: [],
  fog: {
    mode: "native",
    cellRadius: 2
  }
});

export function createManagedFlag({
  mapId,
  role,
  nodeId = null,
  parentNodeId = null,
  parentSceneId = null,
  owned = true,
  originalFolderId = null,
  state = null
} = {}) {
  return {
    version: GLOBAL_MAP_VERSION,
    mapId,
    role,
    nodeId,
    parentNodeId,
    parentSceneId,
    owned: Boolean(owned),
    originalFolderId,
    ...(state ? { state } : {})
  };
}
