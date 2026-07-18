import { FALLOUT_MAW } from "../config/system-config.mjs";
import {
  createManagedFlag,
  GLOBAL_MAP_BYPASS_OPTION,
  GLOBAL_MAP_FLAG,
  GLOBAL_MAP_ROOT_SCENE_SETTING,
  GLOBAL_MAP_ROLES,
  GLOBAL_MAP_TRANSITIONS_FOLDER_NAME,
  LOCATION_ENTRY_MODES
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
    fog: { mode: CONST.FOG_EXPLORATION_MODES.INDIVIDUAL },
    globalLight: true,
    flags: {
      [FALLOUT_MAW.id]: {
        [GLOBAL_MAP_FLAG]: createManagedFlag({
          mapId,
          role: GLOBAL_MAP_ROLES.ROOT_SCENE,
          nodeId: mapId,
          state: {
            fog: {
              mode: "cells",
              cellRadius: 2,
              nativeMode: CONST.FOG_EXPLORATION_MODES.INDIVIDUAL,
              exploredCellKeys: []
            }
          }
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
      fog: { mode: CONST.FOG_EXPLORATION_MODES.INDIVIDUAL },
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
  const folder = await ensureTransitionsFolder(parentScene);
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
    fog: { mode: CONST.FOG_EXPLORATION_MODES.INDIVIDUAL },
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

export async function ensureTransitionTargetStructure(parentScene, transition) {
  const parentFlag = getGlobalMapFlag(parentScene);
  const targetScene = transition?.targetSceneId ? game.scenes?.get(transition.targetSceneId) : null;
  if (!parentFlag?.mapId || !targetScene || !transition?.id) return targetScene;

  const targetFlag = getGlobalMapFlag(targetScene);
  if (targetFlag?.role && targetFlag.role !== GLOBAL_MAP_ROLES.ZONE_SCENE) return targetScene;
  if (targetFlag?.nodeId && targetFlag.nodeId !== transition.id) return targetScene;

  const folder = await ensureTransitionsFolder(parentScene);
  if (!folder) throw new Error("Global-map transitions folder was not found.");

  const originalFolderId = targetFlag?.originalFolderId ?? documentFolderId(targetScene);
  await targetScene.update({
    folder: folder.id,
    [`flags.${FALLOUT_MAW.id}.${GLOBAL_MAP_FLAG}`]: createManagedFlag({
      mapId: parentFlag.mapId,
      role: GLOBAL_MAP_ROLES.ZONE_SCENE,
      nodeId: transition.id,
      parentNodeId: parentFlag.nodeId,
      parentSceneId: parentScene.id,
      owned: targetFlag?.owned ?? Boolean(transition.targetOwned),
      originalFolderId,
      state: targetFlag?.state ?? {}
    })
  }, { [GLOBAL_MAP_BYPASS_OPTION]: true });
  return targetScene;
}

export async function deleteTransitionTargetStructure(transition) {
  const targetScene = transition?.targetSceneId ? game.scenes?.get(transition.targetSceneId) : null;
  const targetFlag = getGlobalMapFlag(targetScene);
  if (targetFlag?.role !== GLOBAL_MAP_ROLES.ZONE_SCENE || targetFlag.nodeId !== transition?.id) return;
  if (targetFlag.owned) await targetScene.delete({ [GLOBAL_MAP_BYPASS_OPTION]: true });
  else await detachManagedScene(targetScene);
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
    for (const child of getTransitionFoldersForParent(folder.id)) {
      await deleteTransitionFolder(child);
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
  for (const folder of getManagedFoldersByRole(rootFlag.mapId, GLOBAL_MAP_ROLES.TRANSITIONS_FOLDER).sort(sortFoldersDeepestFirst)) {
    await folder.delete({ [GLOBAL_MAP_BYPASS_OPTION]: true });
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
  for (const folder of game.folders ?? []) {
    const flag = getGlobalMapFlag(folder);
    if (flag?.role !== GLOBAL_MAP_ROLES.TRANSITIONS_FOLDER) continue;
    const parentScene = game.scenes?.get(flag.parentSceneId);
    const expected = getGlobalMapParentFolder(parentScene);
    if (!expected || documentFolderId(folder) !== expected.id) issues.push(`Нарушено положение папки ${folder.name}.`);
  }
  for (const scene of game.scenes ?? []) {
    const sceneFlag = getGlobalMapFlag(scene);
    if (!rootFlag?.mapId || sceneFlag?.mapId !== rootFlag.mapId) continue;
    for (const location of getSceneState(scene).locations) {
      validateLocationLink(scene, location, issues);
    }
  }
  return { valid: issues.length === 0, issues };
}

export function canCreateChildLocations(scene) {
  const flag = getGlobalMapFlag(scene);
  if (!flag?.mapId || ![GLOBAL_MAP_ROLES.ROOT_SCENE, GLOBAL_MAP_ROLES.LOCATION_SCENE].includes(flag.role)) {
    return false;
  }
  const parentFolder = flag.role === GLOBAL_MAP_ROLES.ROOT_SCENE
    ? getRootFolder(flag.mapId)
    : getLocationFolder(flag.nodeId);
  if (!parentFolder) return false;
  const maxDepth = Number(CONST.FOLDER_MAX_DEPTH) || 4;
  return (parentFolder.ancestors?.length ?? countFolderAncestors(parentFolder)) + 1 < maxDepth;
}

function validateLocationLink(parentScene, location, issues) {
  const locationName = String(location?.name || location?.id || "без названия");
  const linkedSceneId = String(location?.linkedSceneId ?? "").trim();
  if (!linkedSceneId) {
    issues.push(`У локации «${locationName}» не указана связанная сцена.`);
    return;
  }
  const targetScene = game.scenes?.get(linkedSceneId);
  if (!targetScene) {
    issues.push(`Связанная сцена локации «${locationName}» не найдена.`);
    return;
  }
  const parentFlag = getGlobalMapFlag(parentScene);
  const targetFlag = getGlobalMapFlag(targetScene);
  const validManagedLink = targetFlag?.mapId === parentFlag?.mapId
    && targetFlag.role === GLOBAL_MAP_ROLES.LOCATION_SCENE
    && targetFlag.nodeId === location.id
    && targetFlag.parentSceneId === parentScene.id;
  if (!validManagedLink) issues.push(`Связь локации «${locationName}» со сценой ${targetScene.name} повреждена.`);

  const targetState = getSceneState(targetScene);
  if (!hasPassableExitZone(targetState)) {
    issues.push(`На связанной сцене локации «${locationName}» отсутствуют зоны входа и выхода.`);
  }
  if (location.entryMode !== LOCATION_ENTRY_MODES.DEPLOY) return;
  const passableChildren = targetState.locations.filter(child => {
    const childTarget = child.linkedSceneId ? game.scenes?.get(child.linkedSceneId) : null;
    return childTarget && hasPassableExitZone(getSceneState(childTarget));
  });
  if (!passableChildren.length) return;
  const childNames = passableChildren.map(child => `«${child.name || child.id}»`).join(", ");
  issues.push(`Конечная локация «${locationName}» содержит проходимые вложенные локации: ${childNames}.`);
}

function hasPassableExitZone(state) {
  return state.locationExitZones.some(zone => Array.isArray(zone.cells) && zone.cells.length > 0);
}

function countFolderAncestors(folder) {
  let count = 0;
  let current = folder?.folder ?? null;
  const visited = new Set();
  while (current && !visited.has(current.id ?? current)) {
    visited.add(current.id ?? current);
    count += 1;
    current = current.folder ?? null;
  }
  return count;
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
    else if (flag.role === GLOBAL_MAP_ROLES.TRANSITIONS_FOLDER) await deleteTransitionFolder(folder);
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

async function ensureTransitionsFolder(parentScene) {
  const parentFlag = getGlobalMapFlag(parentScene);
  const currentFolder = parentScene?.folder ?? null;
  if (parentFlag?.role === GLOBAL_MAP_ROLES.ZONE_SCENE
    && getGlobalMapFlag(currentFolder)?.role === GLOBAL_MAP_ROLES.TRANSITIONS_FOLDER) {
    return currentFolder;
  }

  const parentFolder = getGlobalMapParentFolder(parentScene);
  if (!parentFlag?.mapId || !parentFolder) return null;

  let folder = getTransitionFoldersForParent(parentFolder.id)
    .find(candidate => getGlobalMapFlag(candidate)?.parentSceneId === parentScene.id);
  if (folder) {
    if (folder.name !== GLOBAL_MAP_TRANSITIONS_FOLDER_NAME) {
      await folder.update({ name: GLOBAL_MAP_TRANSITIONS_FOLDER_NAME }, { [GLOBAL_MAP_BYPASS_OPTION]: true });
    }
    return folder;
  }

  folder = await Folder.create({
    name: GLOBAL_MAP_TRANSITIONS_FOLDER_NAME,
    type: "Scene",
    folder: parentFolder.id,
    color: "#7c4dff",
    flags: {
      [FALLOUT_MAW.id]: {
        [GLOBAL_MAP_FLAG]: createManagedFlag({
          mapId: parentFlag.mapId,
          role: GLOBAL_MAP_ROLES.TRANSITIONS_FOLDER,
          nodeId: parentFlag.nodeId,
          parentNodeId: parentFlag.parentNodeId,
          parentSceneId: parentScene.id,
          owned: true
        })
      }
    }
  });
  return folder;
}

function getGlobalMapParentFolder(scene) {
  const flag = getGlobalMapFlag(scene);
  if (!flag?.mapId) return null;
  return flag.role === GLOBAL_MAP_ROLES.ROOT_SCENE
    ? getRootFolder(flag.mapId)
    : getLocationFolder(flag.nodeId);
}

function getTransitionFoldersForParent(parentFolderId) {
  return (game.folders ?? []).filter(candidate => {
    const flag = getGlobalMapFlag(candidate);
    return flag?.role === GLOBAL_MAP_ROLES.TRANSITIONS_FOLDER
      && documentFolderId(candidate) === parentFolderId;
  });
}

function getManagedFoldersByRole(mapId, role) {
  return (game.folders ?? []).filter(folder => {
    const flag = getGlobalMapFlag(folder);
    return flag?.mapId === mapId && flag.role === role;
  });
}

async function deleteTransitionFolder(folder) {
  for (const scene of [...(folder?.contents ?? [])]) {
    const flag = getGlobalMapFlag(scene);
    if (!flag) continue;
    if (flag.owned) await scene.delete({ [GLOBAL_MAP_BYPASS_OPTION]: true });
    else await detachManagedScene(scene);
  }
  await folder?.delete?.({ [GLOBAL_MAP_BYPASS_OPTION]: true });
}

function sortFoldersDeepestFirst(left, right) {
  return getFolderDepth(right) - getFolderDepth(left);
}

function getFolderDepth(folder) {
  let depth = 0;
  let current = folder;
  while (current) {
    depth += 1;
    current = current.folder ?? null;
  }
  return depth;
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
