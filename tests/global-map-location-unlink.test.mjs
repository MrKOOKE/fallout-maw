import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

globalThis.foundry = {
  applications: { api: { DialogV2: { confirm: async () => false } } },
  utils: {
    deepClone: value => value === undefined ? undefined : structuredClone(value),
    mergeObject: (original, other, { inplace = true } = {}) => {
      const target = inplace ? original : structuredClone(original);
      return mergeInto(target, other);
    }
  }
};
globalThis.CONST = { FOLDER_MAX_DEPTH: 4 };
globalThis.ui = { notifications: { warn() {}, info() {}, error() {} } };

const { GLOBAL_MAP_FLAG, GLOBAL_MAP_ROLES, GLOBAL_MAP_VERSION } = await import("../src/global-map/constants.mjs");
const { detachLocationScenes } = await import("../src/global-map/structure.mjs");
const { getSceneState } = await import("../src/global-map/storage.mjs");

test("detaching a location scene keeps every scene and returns it to its own folder", async () => {
  const world = buildWorld();
  globalThis.game = world.game;

  const result = await detachLocationScenes(world.rootScene, "loc-1");

  assert.deepEqual(result.locationIds.sort(), ["loc-1", "loc-2", "loc-4"]);
  assert.deepEqual(result.scenes.map(scene => scene.name).sort(), ["Child", "Owned location", "User location"]);
  assert.deepEqual(world.deleted, [], "no scene is deleted");
  assert.deepEqual(world.moved.sort(), ["scene-child", "scene-owned", "scene-user"]);
  assert.equal(world.userScene.getFlag("fallout-maw", GLOBAL_MAP_FLAG), null, "the managed flag is removed");
  assert.equal(world.userScene.folder, "user-folder", "user scene returns to its original folder");
  assert.equal(world.ownedScene.folder, null, "system-owned scene is released without a folder");
});

test("detaching a location scene clears the link on every affected location", async () => {
  const world = buildWorld();
  globalThis.game = world.game;

  await detachLocationScenes(world.rootScene, "loc-1");

  const state = getSceneState(world.rootScene);
  assert.deepEqual(state.locations.map(location => location.linkedSceneId), [null, null, null]);
  assert.deepEqual(state.locations.map(location => location.linkedSceneOwned), [false, false, false]);
  assert.deepEqual(state.discoveredLocationIds, ["loc-3"], "only the detached locations leave the discovered list");
});

test("detaching a location without a connected scene is a no-op", async () => {
  const world = buildWorld();
  globalThis.game = world.game;

  const result = await detachLocationScenes(world.rootScene, "loc-3");

  assert.deepEqual(result, { scenes: [], locationIds: [] });
  assert.deepEqual(world.moved, []);
  assert.equal(getSceneState(world.rootScene).locations[2].linkedSceneId, null);
});

test("the location editor exposes a confirmed detach button for the connected scene", async () => {
  const template = await readFile(new URL("../templates/global-map/location-editor.hbs", import.meta.url), "utf8");
  const editor = await readFile(new URL("../src/global-map/editors.mjs", import.meta.url), "utf8");

  assert.match(template, /data-action="deleteLinkedScene"/);
  assert.match(template, /<button type="button" data-action="deleteLinkedScene" class="danger"/);
  assert.match(template, /\{\{linkedSceneName\}\}/);
  assert.match(editor, /deleteLinkedScene: LocationEditor\.#deleteLinkedScene/);
  assert.match(editor, /detachLocationScenes\(this\.scene, this\.data\.id\)/);
  assert.match(editor, /linkedSceneId: null/);

  // Confirmation only, and the scene must survive the operation.
  const handler = editor.match(/static async #deleteLinkedScene\(\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
  assert.ok(handler, "expected the detach handler");
  assert.match(handler, /DialogV2\.confirm\(/);
  assert.doesNotMatch(handler, /\.delete\(/, "the handler must never delete a scene");
  assert.doesNotMatch(handler, /удал/i, "the confirmation must talk about detaching, not deleting");
});

function buildWorld() {
  const userScene = sceneDocument("scene-user", "User location", {
    folder: "location-folder",
    flag: managedFlag("map", GLOBAL_MAP_ROLES.LOCATION_SCENE, {
      nodeId: "loc-1",
      parentNodeId: "root",
      parentSceneId: "root-scene",
      owned: false,
      originalFolderId: "user-folder"
    })
  });
  const ownedScene = sceneDocument("scene-owned", "Owned location", {
    folder: "location-folder",
    flag: managedFlag("map", GLOBAL_MAP_ROLES.LOCATION_SCENE, {
      nodeId: "loc-2",
      parentNodeId: "root",
      parentSceneId: "root-scene",
      owned: true
    })
  });
  const childScene = sceneDocument("scene-child", "Child", {
    folder: "child-folder",
    flag: managedFlag("map", GLOBAL_MAP_ROLES.LOCATION_SCENE, {
      nodeId: "loc-4",
      parentNodeId: "loc-2",
      parentSceneId: "scene-owned",
      owned: true
    })
  });

  const rootScene = sceneDocument("root-scene", "Global map", {
    folder: "root-folder",
    flag: managedFlag("map", GLOBAL_MAP_ROLES.ROOT_SCENE, {
      nodeId: "map",
      state: {
        locations: [
          { id: "loc-1", name: "First", linkedSceneId: "scene-user", linkedSceneOwned: false },
          { id: "loc-2", name: "Second", linkedSceneId: "scene-owned", linkedSceneOwned: true },
          { id: "loc-3", name: "Third", linkedSceneId: null, linkedSceneOwned: false }
        ],
        discoveredLocationIds: ["loc-1", "loc-2", "loc-3"]
      }
    })
  });

  const folders = collection([
    folderDocument("root-folder", "Global map", managedFlag("map", GLOBAL_MAP_ROLES.ROOT_FOLDER)),
    folderDocument("user-folder", "My scenes", null),
    folderDocument("location-folder", "First", managedFlag("map", GLOBAL_MAP_ROLES.LOCATION_FOLDER, { nodeId: "loc-1", parentNodeId: "map" }), [userScene, ownedScene]),
    folderDocument("child-folder", "Second", managedFlag("map", GLOBAL_MAP_ROLES.LOCATION_FOLDER, { nodeId: "loc-2", parentNodeId: "loc-1" }), [childScene])
  ]);
  folders.get = id => folders.find(entry => entry.id === id) ?? null;

  const scenes = collection([rootScene, userScene, ownedScene, childScene]);
  scenes.get = id => scenes.find(entry => entry.id === id) ?? null;

  const world = {
    deleted: [],
    moved: [],
    userScene,
    ownedScene,
    folders,
    rootScene,
    game: null
  };
  latestWorld = world;
  for (const scene of [userScene, ownedScene, childScene]) {
    scene.delete = async () => { world.deleted.push(scene.id); };
    scene.unsetFlag = async () => { scene.flag = null; };
  }

  world.game = {
    scenes,
    folders,
    users: { activeGM: null, contents: [] },
    user: { isGM: true }
  };
  return world;
}

function sceneDocument(id, name, { folder, flag }) {
  const scene = {
    id,
    name,
    documentName: "Scene",
    folder,
    flag,
    getFlag: (namespace, key) => namespace === "fallout-maw" && key === GLOBAL_MAP_FLAG ? scene.flag : null,
    setFlag: async (namespace, key, value) => {
      if (namespace === "fallout-maw" && key === GLOBAL_MAP_FLAG) scene.flag = value;
    },
    update: async changes => {
      if (changes && Object.hasOwn(changes, "folder")) {
        scene.folder = changes.folder;
        latestWorld?.moved.push(id);
      }
      const flagPath = `flags.fallout-maw.${GLOBAL_MAP_FLAG}`;
      if (changes && Object.hasOwn(changes, flagPath)) scene.flag = changes[flagPath];
    }
  };
  return scene;
}

let latestWorld = null;

function folderDocument(id, name, flag, contents = []) {
  return {
    id,
    name,
    documentName: "Folder",
    folder: null,
    contents: collection(contents),
    getFlag: (namespace, key) => namespace === "fallout-maw" && key === GLOBAL_MAP_FLAG ? flag : null
  };
}

function managedFlag(mapId, role, additions = {}) {
  return { version: GLOBAL_MAP_VERSION, mapId, role, ...additions };
}

function collection(entries) {
  const values = [...entries];
  values.contents = values;
  return values;
}

function mergeInto(target, source) {
  if (!source || typeof source !== "object") return target;
  for (const [key, value] of Object.entries(source)) {
    if (Array.isArray(value)) target[key] = structuredClone(value);
    else if (value && typeof value === "object") {
      const base = target[key] && typeof target[key] === "object" && !Array.isArray(target[key]) ? target[key] : {};
      target[key] = mergeInto(base, value);
    } else target[key] = value;
  }
  return target;
}
