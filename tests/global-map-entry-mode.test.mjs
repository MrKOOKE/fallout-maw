import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

globalThis.foundry = {
  applications: { api: { DialogV2: {} } },
  utils: {
    deepClone: value => value === undefined ? undefined : structuredClone(value),
    mergeObject: (original, other, { inplace = true } = {}) => {
      const target = inplace ? original : structuredClone(original);
      return mergeInto(target, other);
    }
  }
};
globalThis.CONST = { FOLDER_MAX_DEPTH: 4 };

const {
  DEFAULT_LOCATION,
  GLOBAL_MAP_FLAG,
  GLOBAL_MAP_ROLES,
  GLOBAL_MAP_VERSION,
  LOCATION_ENTRY_MODES
} = await import("../src/global-map/constants.mjs");
const {
  normalizeLocationEntryMode,
  normalizeSceneState
} = await import("../src/global-map/storage.mjs");
const {
  canCreateChildLocations,
  validateGlobalMapStructure
} = await import("../src/global-map/structure.mjs");

test("global-map v3 normalizes legacy and invalid location entry modes to deploy", () => {
  assert.equal(GLOBAL_MAP_VERSION, 3);
  assert.equal(DEFAULT_LOCATION.entryMode, LOCATION_ENTRY_MODES.DEPLOY);
  assert.equal(normalizeLocationEntryMode(LOCATION_ENTRY_MODES.CARRIER), LOCATION_ENTRY_MODES.CARRIER);
  assert.equal(normalizeLocationEntryMode("unknown"), LOCATION_ENTRY_MODES.DEPLOY);

  const source = {
    locations: [
      { id: "legacy", name: "Legacy", customValue: 7 },
      { id: "carrier", entryMode: LOCATION_ENTRY_MODES.CARRIER },
      { id: "invalid", entryMode: "automatic" }
    ]
  };
  const state = normalizeSceneState(source);

  assert.equal(state.version, 3);
  assert.equal(state.locations[0].entryMode, LOCATION_ENTRY_MODES.DEPLOY);
  assert.equal(state.locations[0].customValue, 7);
  assert.equal(state.locations[0].strokeWidth, DEFAULT_LOCATION.strokeWidth);
  assert.equal(state.locations[1].entryMode, LOCATION_ENTRY_MODES.CARRIER);
  assert.equal(state.locations[2].entryMode, LOCATION_ENTRY_MODES.DEPLOY);
  assert.equal(source.locations[0].entryMode, undefined, "normalization must not mutate stored source data");
});

test("location editor exposes an explicit carrier/deploy select", async () => {
  const template = await readFile(new URL("../templates/global-map/location-editor.hbs", import.meta.url), "utf8");
  const editor = await readFile(new URL("../src/global-map/editors.mjs", import.meta.url), "utf8");
  assert.match(template, /<select name="location\.entryMode">/);
  assert.match(template, /entryModeChoices/);
  assert.match(editor, /Подкарта путешествия/);
  assert.match(editor, /Конечная локация/);
});

test("child-location controls respect zone scenes and Foundry's maximum folder depth", () => {
  const world = buildValidationWorld();
  globalThis.game = world.game;
  assert.equal(canCreateChildLocations(world.rootScene), true);

  const deepestFolder = document("deepest-folder", "Deepest", managedFlag("map", GLOBAL_MAP_ROLES.LOCATION_FOLDER, {
    nodeId: "deepest-location"
  }), world.childFolder);
  const deepestScene = document("deepest-scene", "Deepest", managedFlag("map", GLOBAL_MAP_ROLES.LOCATION_SCENE, {
    nodeId: "deepest-location"
  }), deepestFolder);
  world.game.folders.push(deepestFolder);
  assert.equal(canCreateChildLocations(deepestScene), false);

  const zoneScene = document("zone-scene", "Zone", managedFlag("map", GLOBAL_MAP_ROLES.ZONE_SCENE), world.rootFolder);
  assert.equal(canCreateChildLocations(zoneScene), false);
});

test("structure validation warns when a deploy destination contains a passable child location", () => {
  const world = buildValidationWorld();
  globalThis.game = world.game;

  let result = validateGlobalMapStructure();
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(issue => issue.includes("проходимые вложенные локации")));

  world.rootLocation.entryMode = LOCATION_ENTRY_MODES.CARRIER;
  result = validateGlobalMapStructure();
  assert.deepEqual(result, { valid: true, issues: [] });

  world.rootLocation.entryMode = LOCATION_ENTRY_MODES.DEPLOY;
  world.childLocation.linkedSceneId = "missing-scene";
  result = validateGlobalMapStructure();
  assert.ok(result.issues.some(issue => issue.includes("не найдена")));
  assert.ok(!result.issues.some(issue => issue.includes("проходимые вложенные локации")));
});

function buildValidationWorld() {
  const mapId = "map";
  const rootFolder = document("root-folder", "Global Map", managedFlag(mapId, GLOBAL_MAP_ROLES.ROOT_FOLDER));
  const regionalFolder = document("regional-folder", "Regional", managedFlag(mapId, GLOBAL_MAP_ROLES.LOCATION_FOLDER, {
    nodeId: "regional-location",
    parentNodeId: mapId,
    parentSceneId: "root-scene"
  }), rootFolder);
  const childFolder = document("child-folder", "Child", managedFlag(mapId, GLOBAL_MAP_ROLES.LOCATION_FOLDER, {
    nodeId: "child-location",
    parentNodeId: "regional-location",
    parentSceneId: "regional-scene"
  }), regionalFolder);

  const childLocation = {
    id: "child-location",
    name: "Child",
    linkedSceneId: "child-scene",
    entryMode: LOCATION_ENTRY_MODES.CARRIER
  };
  const rootLocation = {
    id: "regional-location",
    name: "Regional",
    linkedSceneId: "regional-scene",
    entryMode: LOCATION_ENTRY_MODES.DEPLOY
  };
  const rootScene = document("root-scene", "Global Map", managedFlag(mapId, GLOBAL_MAP_ROLES.ROOT_SCENE, {
    nodeId: mapId,
    state: { locations: [rootLocation] }
  }), rootFolder);
  const regionalScene = document("regional-scene", "Regional", managedFlag(mapId, GLOBAL_MAP_ROLES.LOCATION_SCENE, {
    nodeId: rootLocation.id,
    parentNodeId: mapId,
    parentSceneId: rootScene.id,
    state: {
      locations: [childLocation],
      locationExitZones: [{ id: "regional-exit", cells: ["0,0"] }]
    }
  }), regionalFolder);
  const childScene = document("child-scene", "Child", managedFlag(mapId, GLOBAL_MAP_ROLES.LOCATION_SCENE, {
    nodeId: childLocation.id,
    parentNodeId: rootLocation.id,
    parentSceneId: regionalScene.id,
    state: { locationExitZones: [{ id: "child-exit", cells: ["0,0"] }] }
  }), childFolder);

  const scenes = collection([rootScene, regionalScene, childScene]);
  const folders = collection([rootFolder, regionalFolder, childFolder]);
  return {
    childFolder,
    childLocation,
    rootFolder,
    rootLocation,
    rootScene,
    game: {
      scenes,
      folders,
      settings: { get: () => rootScene.id }
    }
  };
}

function managedFlag(mapId, role, additions = {}) {
  return { version: GLOBAL_MAP_VERSION, mapId, role, ...additions };
}

function document(id, name, flag, folder = null) {
  return {
    id,
    name,
    folder,
    getFlag: (namespace, key) => namespace === "fallout-maw" && key === GLOBAL_MAP_FLAG ? flag : null
  };
}

function collection(entries) {
  const values = [...entries];
  values.contents = values;
  values.get = id => values.find(entry => entry.id === id) ?? null;
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
