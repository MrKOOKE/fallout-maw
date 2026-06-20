import { FALLOUT_MAW } from "../config/system-config.mjs";
import {
  GLOBAL_MAP_LAYER,
  GLOBAL_MAP_ROOT_SCENE_SETTING
} from "./constants.mjs";
import { FalloutMaWGlobalMapLayer } from "./layer.mjs";
import { registerGlobalMapStructureHooks, getOrCreateGlobalMap, validateGlobalMapStructure } from "./structure.mjs";
import { getRootScene } from "./storage.mjs";
import { registerGlobalMapTravelHooks, registerGlobalMapTravelSocket, requestDirectTravel, requestTransitionTravel, travelToLocation } from "./travel.mjs";
import { registerGlobalMapFogHooks, registerGlobalMapFogSocket } from "./fog.mjs";
import { registerGlobalMapGridHooks } from "./grid-reprojection.mjs";
import { GlobalMapManager } from "./editors.mjs";

export function registerGlobalMapSystem() {
  game.settings.register(FALLOUT_MAW.id, GLOBAL_MAP_ROOT_SCENE_SETTING, {
    name: "Global Map Root Scene ID",
    scope: "world",
    config: false,
    type: String,
    default: ""
  });
  game.settings.registerMenu(FALLOUT_MAW.id, "globalMapManager", {
    name: "Глобальная карта",
    label: "Открыть управление",
    hint: "Создание, открытие и проверка структуры глобальной карты.",
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
  registerGlobalMapFogHooks();
  registerGlobalMapGridHooks();
  registerGlobalMapKeybinding();
  Hooks.on("canvasReady", refreshGlobalMapUi);
  Hooks.on("updateScene", scene => {
    if (scene.id === canvas.scene?.id) canvas[GLOBAL_MAP_LAYER]?.refresh?.();
  });
}

export function initializeGlobalMapRuntime() {
  registerGlobalMapTravelSocket();
  registerGlobalMapFogSocket();
  game.falloutMaW ??= {};
  game.falloutMaW.globalMap = {
    open: openGlobalMap,
    getRootScene,
    getOrCreate: getOrCreateGlobalMap,
    validateStructure: validateGlobalMapStructure,
    requestTransitionTravel,
    requestDirectTravel,
    travelToLocation
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
