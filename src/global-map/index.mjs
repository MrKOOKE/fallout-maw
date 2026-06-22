import { FALLOUT_MAW } from "../config/system-config.mjs";
import {
  GLOBAL_MAP_BYPASS_OPTION,
  GLOBAL_MAP_FLAG,
  GLOBAL_MAP_LAYER,
  GLOBAL_MAP_ROOT_SCENE_SETTING,
  GLOBAL_MAP_TRAVEL_IMAGE_SETTING,
  GLOBAL_MAP_TRAVEL_SPEED_FORMULA_DEFAULT,
  GLOBAL_MAP_TRAVEL_SPEED_FORMULA_SETTING,
  GLOBAL_MAP_VERSION,
  TRAVEL_GROUP_IMAGE_DEFAULT
} from "./constants.mjs";
import { FalloutMaWGlobalMapLayer } from "./layer.mjs";
import { registerGlobalMapStructureHooks, getOrCreateGlobalMap, validateGlobalMapStructure } from "./structure.mjs";
import { getGlobalMapFlag, getRootScene, updateSceneState } from "./storage.mjs";
import { registerGlobalMapTravelHooks, registerGlobalMapTravelSocket, requestTransitionTravel } from "./travel.mjs";
import { registerGlobalMapFogHooks, registerGlobalMapFogSocket } from "./fog.mjs";
import { registerGlobalMapGridHooks } from "./grid-reprojection.mjs";
import { GlobalMapManager } from "./editors.mjs";
import { GlobalMapTravelSettings } from "./travel-settings.mjs";
import {
  cancelTravelAssembly,
  openTravelAssembly,
  registerTravelGroupHooks,
  registerTravelGroupSocket,
  requestLocationEntry,
  requestLocationExit,
  selectArrivalZone,
  travelToLocation
} from "./travel-groups.mjs";

let globalMapRuntimeInitialized = false;

export function registerGlobalMapSystem() {
  game.settings.register(FALLOUT_MAW.id, GLOBAL_MAP_ROOT_SCENE_SETTING, {
    name: "Global Map Root Scene ID",
    scope: "world",
    config: false,
    type: String,
    default: ""
  });
  game.settings.register(FALLOUT_MAW.id, GLOBAL_MAP_TRAVEL_IMAGE_SETTING, {
    name: "Изображение путешествующей группы",
    scope: "world",
    config: false,
    type: String,
    default: TRAVEL_GROUP_IMAGE_DEFAULT
  });
  game.settings.register(FALLOUT_MAW.id, GLOBAL_MAP_TRAVEL_SPEED_FORMULA_SETTING, {
    name: "Формула скорости путешествия",
    scope: "world",
    config: false,
    type: String,
    default: GLOBAL_MAP_TRAVEL_SPEED_FORMULA_DEFAULT
  });
  game.settings.registerMenu(FALLOUT_MAW.id, "globalMapTravel", {
    name: "Путешествие",
    label: "Настроить путешествие",
    icon: "fa-solid fa-people-group",
    type: GlobalMapTravelSettings,
    restricted: true
  });
  game.settings.registerMenu(FALLOUT_MAW.id, "globalMapManager", {
    name: "Глобальная карта",
    label: "Открыть управление",
    icon: "fa-solid fa-map-location-dot",
    type: GlobalMapManager,
    restricted: true
  });
  CONFIG.Canvas.layers[GLOBAL_MAP_LAYER] = {
    layerClass: FalloutMaWGlobalMapLayer,
    group: "primary"
  };
  registerGlobalMapStructureHooks();
  registerGlobalMapTravelHooks();
  registerTravelGroupHooks();
  registerGlobalMapFogHooks();
  registerGlobalMapGridHooks();
  registerGlobalMapKeybinding();
  Hooks.on("canvasReady", refreshGlobalMapUi);
  Hooks.once("ready", () => void migrateGlobalMapVersion());
  Hooks.on("updateScene", scene => {
    if (scene.id === canvas.scene?.id) canvas[GLOBAL_MAP_LAYER]?.refresh?.();
  });
}

async function migrateGlobalMapVersion() {
  if (game.users?.activeGM?.id !== game.user?.id) return;
  for (const scene of game.scenes?.contents ?? []) {
    const flag = getGlobalMapFlag(scene);
    if (!flag?.mapId || Number(flag.version) >= GLOBAL_MAP_VERSION) continue;
    await updateSceneState(scene, state => state, { [GLOBAL_MAP_BYPASS_OPTION]: true });
  }
  for (const folder of game.folders?.contents ?? []) {
    const flag = getGlobalMapFlag(folder);
    if (!flag?.mapId || Number(flag.version) >= GLOBAL_MAP_VERSION) continue;
    await folder.update({
      [`flags.${FALLOUT_MAW.id}.${GLOBAL_MAP_FLAG}`]: { ...flag, version: GLOBAL_MAP_VERSION }
    }, { [GLOBAL_MAP_BYPASS_OPTION]: true });
  }
}

export function initializeGlobalMapRuntime() {
  if (globalMapRuntimeInitialized) return;
  globalMapRuntimeInitialized = true;
  registerGlobalMapTravelSocket();
  registerTravelGroupSocket();
  registerGlobalMapFogSocket();
  game.falloutMaW ??= {};
  game.falloutMaW.globalMap = {
    open: openGlobalMap,
    getRootScene,
    getOrCreate: getOrCreateGlobalMap,
    validateStructure: validateGlobalMapStructure,
    requestTransitionTravel,
    travelToLocation,
    requestLocationEntry,
    requestLocationExit,
    openTravelAssembly,
    cancelTravelAssembly,
    selectArrivalZone
  };
}

async function openGlobalMap() {
  const root = getRootScene() ?? await getOrCreateGlobalMap();
  if (root && canvas.scene?.id !== root.id) await root.view();
  return root;
}

function registerGlobalMapKeybinding() {
  game.keybindings.register(FALLOUT_MAW.id, "openGlobalMap", {
    name: "Открыть глобальную карту",
    hint: "Открыть назначенную корневую сцену глобальной карты.",
    editable: [{ key: "KeyN" }],
    onDown: () => {
      void openGlobalMap();
      return true;
    },
    restricted: false,
    precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL
  });
}

function refreshGlobalMapUi() {
  canvas[GLOBAL_MAP_LAYER]?.refresh?.();
  ui.controls?.render?.({ force: true });
}
