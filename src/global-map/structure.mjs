import { FALLOUT_MAW } from "../config/system-config.mjs";
import {
  createManagedFlag,
  GLOBAL_MAP_BYPASS_OPTION,
  GLOBAL_MAP_FLAG,
  GLOBAL_MAP_ROOT_SCENE_SETTING,
  GLOBAL_MAP_ROLES
} from "./constants.mjs";
import {
  findLocation,
  getGlobalMapFlag,
  getLocationFolder,
  getManagedSceneByNode,
  getRootFolder,
  getRootScene,
  getSceneState,
  isManagedGlobalMapDocument,
  updateSceneState
} from "./storage.mjs";

const { DialogV2 } = foundry.applications.api;

export function registerGlobalMapStructureHooks() {
  Hooks.on("preUpdateFolder", preventManagedFolderMove);
  Hooks.on("preUpdateScene", preventManagedSceneMove);
  Hooks.on("preDeleteFolder", interceptManagedFolderDelete);
  Hooks.on("preDeleteScene", interceptManagedSceneDelete);
}

export async function getOrCreateGlobalMap() {
  let rootScene = getRootScene();
  if (rootScene) {
    if (game.settings.get(FALLOUT_MAW.id, GLOBAL_MAP_ROOT_SCENE_SETTING) !== rootScene.id) {
      await game.settings.set(FALLOUT_MAW.id, GLOBAL_MAP_ROOT_SCENE_SETTING, rootScene.id);
    }
    return rootScene;
  }
  if (!game.user?.isGM) {
    ui.notifications.warn("Глобальная карта ещё не создана. Это может сделать GM.");
    return null;
  }

  const mapId = foundry.utils.randomID();
  const rootFolder = await Folder.create({
    name: "Глобальная карта",
    type: "Scene",
    color: "#4a90d9",
    flags: {
      [FALLOUT_MAW.id]: {
        [GLOBAL_MAP_FLAG]: createManagedFlag({
          mapId,
          role: GLOBAL_MAP_ROLES.ROOT_FOLDER
        })
      }
    }
  });
  rootScene = await Scene.create({
    name: "Глобальная карта",
    folder: rootFolder.id,
    width: 4000,
    height: 3000,
    padding: 0,
    backgroundColor: "#1a1a2e",
    grid: { type: CONST.GRID_TYPES.SQUARE, size: 100 },
    tokenVision: true,
    fogExploration: true,
    globalLight: true,
    flags: {
      [FALLOUT_MAW.id]: {
        [GLOBAL_MAP_FLAG]: createManagedFlag({
          mapId,
          role: GLOBAL_MAP_ROLES.ROOT_SCENE,
          nodeId: mapId,
          state: {}
        })
      }
    }
  });
  await game.settings.set(FALLOUT_MAW.id, GLOBAL_MAP_ROOT_SCENE_SETTING, rootScene.id);
  return rootScene;
}

export async function ensureLocationStructure(parentScene, location, {
  existingSceneId = null,
  createScene = false
} = {}) {
  const parentFlag = getGlobalMapFlag(parentScene);
  if (!parentFlag?.mapId || !location?.id) throw new Error("Invalid global-map parent or location.");

  const parentFolder = parentFlag.role === GLOBAL_MAP_ROLES.ROOT_SCENE
    ? getRootFolder(parentFlag.mapId)
    : getLocationFolder(parentFlag.nodeId);
  if (!parentFolder) throw new Error("Global-map parent folder was not found.");

  let folder = getLocationFolder(location.id);
  if (!folder) {
    folder = await Folder.create({
      name: location.name || "Локация",
      type: "Scene",
      folder: parentFolder.id,
      color: "#6a9ad9",
      flags: {
        [FALLOUT_MAW.id]: {
          [GLOBAL_MAP_FLAG]: createManagedFlag({
            mapId: parentFlag.mapId,
            role: GLOBAL_MAP_ROLES.LOCATION_FOLDER,
            nodeId: location.id,
            parentNodeId: parentFlag.nodeId,
            parentSceneId: parentScene.id
          })
        }
      }
    });
  } else if (location.name && folder.name !== location.name) {
    await folder.update({ name: location.name }, { [GLOBAL_MAP_BYPASS_OPTION]: true });
  }

  let linkedScene = existingSceneId ? game.scenes?.get(existingSceneId) : getManagedSceneByNode(location.id, [
    GLOBAL_MAP_ROLES.LOCATION_SCENE
  ]);
  if (existingSceneId && !linkedScene) throw new Error("Selected Scene was not found.");
  if (existingSceneId && getGlobalMapFlag(linkedScene)) throw new Error("Selected Scene is already managed by the global map.");
  if (linkedScene) {
    const oldFlag = getGlobalMapFlag(linkedScene);
    const originalFolderId = oldFlag?.originalFolderId ?? documentFolderId(linkedScene);
    await linkedScene.update({
      folder: folder.id,
      [`flags.${FALLOUT_MAW.id}.${GLOBAL_MAP_FLAG}`]: createManagedFlag({
        mapId: parentFlag.mapId,
        role: GLOBAL_MAP_ROLES.LOCATION_SCENE,
        nodeId: location.id,
        parentNodeId: parentFlag.nodeId,
        parentSceneId: parentScene.id,
        owned: oldFlag?.owned ?? !existingSceneId,
        originalFolderId,
        state: oldFlag?.state ?? {}
      })
    }, { [GLOBAL_MAP_BYPASS_OPTION]: true });
  } else if (createScene) {
    linkedScene = await Scene.create({
      name: location.name || "Локация",
      folder: folder.id,
      width: 4000,
      height: 3000,
      background: { src: location.mapImage || "" },
      backgroundColor: "#1a1a2e",
      grid: {
        type: parentScene.grid?.type ?? CONST.GRID_TYPES.SQUARE,
        size: parentScene.grid?.size ?? 100
      },
      tokenVision: true,
      fogExploration: true,
      flags: {
        [FALLOUT_MAW.id]: {
          [GLOBAL_MAP_FLAG]: createManagedFlag({
            mapId: parentFlag.mapId,
            role: GLOBAL_MAP_ROLES.LOCATION_SCENE,
            nodeId: location.id,
            parentNodeId: parentFlag.nodeId,
            parentSceneId: parentScene.id,
            owned: true,
            state: {}
          })
        }
      }
    });
  }
  return { folder, scene: linkedScene };
}

export async function createZoneScene(parentScene, transition) {
  const parentFlag = getGlobalMapFlag(parentScene);
  const folder = parentFlag?.role === GLOBAL_MAP_ROLES.ROOT_SCENE
    ? getRootFolder(parentFlag.mapId)
    : getLocationFolder(parentFlag.nodeId);
  if (!parentFlag?.mapId || !folder) throw new Error("Global-map parent folder was not found.");
  return Scene.create({
    name: transition.name || "Зона перехода",
    folder: folder.id,
    width: 4000,
    height: 3000,
    background: { src: transition.mapImage || "" },
    backgroundColor: "#1a1a2e",
    grid: {
      type: parentScene.grid?.type ?? CONST.GRID_TYPES.SQUARE,
      size: parentScene.grid?.size ?? 100
    },
    tokenVision: true,
    fogExploration: true,
    flags: {
      [FALLOUT_MAW.id]: {
        [GLOBAL_MAP_FLAG]: createManagedFlag({
          mapId: parentFlag.mapId,
          role: GLOBAL_MAP_ROLES.ZONE_SCENE,
          nodeId: transition.id,
          parentNodeId: parentFlag.nodeId,
          parentSceneId: parentScene.id,
          owned: true,
          state: {}
        })
      }
    }
  });
}

export async function deleteLocationTree(parentScene, locationId, { deleteMarker = true } = {}) {
  const folder = getLocationFolder(locationId);
  if (folder) {
    const childFolders = (game.folders ?? []).filter(candidate => {
      const flag = getGlobalMapFlag(candidate);
      return documentFolderId(candidate) === folder.id && flag?.role === GLOBAL_MAP_ROLES.LOCATION_FOLDER;
    });
    for (const child of childFolders) {
      const childFlag = getGlobalMapFlag(child);
      const childParent = game.scenes?.get(childFlag?.parentSceneId);
      if (childParent) await deleteLocationTree(childParent, childFlag.nodeId);
    }
    for (const scene of [...(folder.contents ?? [])]) {
      const flag = getGlobalMapFlag(scene);
      if (!flag) continue;
      if (flag.owned) await scene.delete({ [GLOBAL_MAP_BYPASS_OPTION]: true });
      else await detachManagedScene(scene);
    }
    await folder.delete({ [GLOBAL_MAP_BYPASS_OPTION]: true });
  }
  if (deleteMarker && parentScene) {
    await updateSceneState(parentScene, state => {
      state.locations = state.locations.filter(location => location.id !== locationId);
      state.discoveredLocationIds = state.discoveredLocationIds.filter(id => id !== locationId);
      return state;
    });
  }
}

export async function deleteWholeGlobalMap() {
  const rootScene = getRootScene();
  const rootFlag = getGlobalMapFlag(rootScene);
  if (!rootFlag) return;
  const rootFolder = getRootFolder(rootFlag.mapId);
  for (const folder of [...(game.folders ?? [])]) {
    const flag = getGlobalMapFlag(folder);
    if (flag?.mapId !== rootFlag.mapId || flag.role !== GLOBAL_MAP_ROLES.LOCATION_FOLDER) continue;
    const parentScene = game.scenes?.get(flag.parentSceneId);
    if (parentScene) await deleteLocationTree(parentScene, flag.nodeId, { deleteMarker: false });
  }
  for (const scene of [...(game.scenes ?? [])]) {
    const flag = getGlobalMapFlag(scene);
    if (flag?.mapId !== rootFlag.mapId) continue;
    if (flag.owned) await scene.delete({ [GLOBAL_MAP_BYPASS_OPTION]: true });
    else await detachManagedScene(scene);
  }
  if (rootFolder) await rootFolder.delete({ [GLOBAL_MAP_BYPASS_OPTION]: true });
  await game.settings.set(FALLOUT_MAW.id, GLOBAL_MAP_ROOT_SCENE_SETTING, "");
}

export function validateGlobalMapStructure() {
  const issues = [];
  const rootScene = getRootScene();
  const rootFlag = getGlobalMapFlag(rootScene);
  const rootFolder = getRootFolder(rootFlag?.mapId);
  if (!rootScene) issues.push("Не найдена корневая сцена.");
  if (!rootFolder) issues.push("Не найдена корневая папка.");
  if (rootScene && rootFolder && documentFolderId(rootScene) !== rootFolder.id) {
    issues.push("Корневая сцена находится вне корневой папки.");
  }
  for (const folder of game.folders ?? []) {
    const flag = getGlobalMapFlag(folder);
    if (flag?.role !== GLOBAL_MAP_ROLES.LOCATION_FOLDER) continue;
    const expected = flag.parentNodeId === rootFlag?.nodeId
      ? rootFolder
      : getLocationFolder(flag.parentNodeId);
    if (!expected || documentFolderId(folder) !== expected.id) issues.push(`Нарушено положение папки ${folder.name}.`);
  }
  return { valid: issues.length === 0, issues };
}

async function detachManagedScene(scene) {
  const storedFolderId = getGlobalMapFlag(scene)?.originalFolderId ?? null;
  const originalFolderId = storedFolderId && game.folders?.get(storedFolderId) ? storedFolderId : null;
  await scene.unsetFlag(FALLOUT_MAW.id, GLOBAL_MAP_FLAG, { [GLOBAL_MAP_BYPASS_OPTION]: true });
  await scene.update({ folder: originalFolderId }, { [GLOBAL_MAP_BYPASS_OPTION]: true });
}

function preventManagedFolderMove(folder, changes, options) {
  if (options?.[GLOBAL_MAP_BYPASS_OPTION] || changes.folder === undefined) return;
  if (!isManagedGlobalMapDocument(folder)) return;
  if (normalizeFolderId(changes.folder) === documentFolderId(folder)) return;
  ui.notifications.warn("Эта папка встроена в глобальную карту и не может быть перемещена.");
  return false;
}

function preventManagedSceneMove(scene, changes, options) {
  if (options?.[GLOBAL_MAP_BYPASS_OPTION] || changes.folder === undefined) return;
  if (!isManagedGlobalMapDocument(scene)) return;
  if (normalizeFolderId(changes.folder) === documentFolderId(scene)) return;
  ui.notifications.warn("Эта сцена встроена в глобальную карту и не может быть перемещена.");
  return false;
}

function interceptManagedFolderDelete(folder, options) {
  if (options?.[GLOBAL_MAP_BYPASS_OPTION]) return;
  const flag = getGlobalMapFlag(folder);
  if (!flag) return;
  void confirmManagedDelete(flag.role === GLOBAL_MAP_ROLES.ROOT_FOLDER).then(async confirmed => {
    if (!confirmed) return;
    if (flag.role === GLOBAL_MAP_ROLES.ROOT_FOLDER) await deleteWholeGlobalMap();
    else {
      const parentScene = game.scenes?.get(flag.parentSceneId);
      await deleteLocationTree(parentScene, flag.nodeId);
    }
  });
  return false;
}

function interceptManagedSceneDelete(scene, options) {
  if (options?.[GLOBAL_MAP_BYPASS_OPTION]) return;
  const flag = getGlobalMapFlag(scene);
  if (!flag) return;
  const isRoot = flag.role === GLOBAL_MAP_ROLES.ROOT_SCENE;
  void confirmManagedDelete(isRoot).then(async confirmed => {
    if (!confirmed) return;
    if (isRoot) await deleteWholeGlobalMap();
    else if (flag.role === GLOBAL_MAP_ROLES.LOCATION_SCENE) {
      const found = findLocation(flag.nodeId);
      if (found) await deleteLocationTree(found.scene, flag.nodeId);
      else if (flag.owned) await scene.delete({ [GLOBAL_MAP_BYPASS_OPTION]: true });
      else await detachManagedScene(scene);
    } else {
      const parent = game.scenes?.get(flag.parentSceneId);
      if (parent) {
        await updateSceneState(parent, state => {
          state.transitions = state.transitions.filter(entry => entry.id !== flag.nodeId);
          return state;
        });
      }
      if (flag.owned) await scene.delete({ [GLOBAL_MAP_BYPASS_OPTION]: true });
      else await detachManagedScene(scene);
    }
  });
  return false;
}

function confirmManagedDelete(root) {
  return DialogV2.confirm({
    window: { title: root ? "Удалить глобальную карту?" : "Удалить элемент глобальной карты?" },
    content: root
      ? "<p>Будет удалено всё управляемое дерево глобальной карты. Подключённые пользовательские сцены сохранятся.</p>"
      : "<p>Будут удалены связанные системные документы. Подключённые пользовательские сцены сохранятся.</p>",
    yes: { label: "Удалить" },
    no: { label: "Отмена" }
  });
}

function documentFolderId(document) {
  return typeof document?.folder === "string" ? document.folder : document?.folder?.id ?? null;
}

function normalizeFolderId(folder) {
  if (!folder) return null;
  return typeof folder === "string" ? folder : folder.id ?? null;
}
