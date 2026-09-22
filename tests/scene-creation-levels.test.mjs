import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { captureSceneCreationPoint, getSceneCreationLevelId, getSceneCreationLevels } from "../src/canvas/creation-levels.mjs";
import { getMapTokenLevelId, getMapAreaTokenPlacement } from "../src/global-map/levels.mjs";

// Execute the production entry points with Foundry document boundaries mocked.
function implementation(file, name, dependencies = {}) {
  const source = readFileSync(new URL(`../src/${file}.mjs`, import.meta.url), "utf8");
  const body = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}(?=\\r?\\n|$)`))?.[0];
  assert.ok(body, name);
  const deps = { captureSceneCreationPoint, getSceneCreationLevelId, getSceneCreationLevels, ...dependencies };
  return new Function(...Object.keys(deps), `${body}; return ${name};`)(...Object.values(deps));
}

function fixture() {
  const writes = [];
  const scene = {
    id: "scene", initialLevel: { id: "surface" },
    levels: new Map([["surface", { elevation: { base: 0 } }], ["basement", { elevation: { base: -4 } }]]),
    tokens: new Map(), regions: { contents: [] }, tiles: { contents: [] },
    async createEmbeddedDocuments(type, data) {
      writes.push({ type, data: structuredClone(data) });
      return data.map((entry, index) => ({ ...entry, id: `created-${index}` }));
    }
  };
  globalThis.canvas = { scene, level: { id: "surface" } };
  const deps = {
    game: { user: { isGM: true }, scenes: new Map([[scene.id, scene]]), i18n: { localize: key => key } },
    foundry: { utils: { deepClone: structuredClone, randomID: () => "operation" } },
    CONST: { REGION_VISIBILITY: { LAYER: 1, ALWAYS: 2 } },
    SYSTEM_ID: "fallout-maw", TRAP_FLAG: "trap", THROWN_ITEM_FLAG: "thrownItem",
    DROPPED_ITEMS_FLAG: "droppedItems", DROPPED_ITEMS_FALLBACK_ICON: "item.svg",
    DEFAULT_TILE_IMAGE: "item.svg", PERIODIC_DAMAGE_REGION_BEHAVIOR_TYPE: "damage",
    DEFAULT_REGION_DAMAGE_INTERVAL_SECONDS: 6, DELAYED_THROWN_ITEM_REGION_FLAG: "delayed",
    toInteger: Number, metersToPixels: Number, normalizeRegionSpecialProperties: value => value,
    isFormulaTextConfigured: () => true,
    getSphericalRegionElevation: elevation => ({ bottom: elevation - 1, top: elevation + 1 }),
    getSphericalRegionFlags: () => ({}), getNextTileSort: () => 1,
    normalizeImagePath: value => value, normalizeDroppedItemData: value => value,
    getDroppedItemTileDimensions: async () => ({ width: 40, height: 40 }),
    assertThrownItemRequestPermission: async () => {}, rememberThrownItemOperationOwner: () => {},
    isThrownItemOperationCancelled: () => false, findThrownItemTileByOperation: () => null
  };
  return { scene, writes, deps };
}

test("source token level and elevation override the viewed floor and prototype defaults", () => {
  const { scene } = fixture();
  const token = { document: { level: "surface", _source: { level: "basement" }, elevation: -3 } };
  assert.deepEqual(captureSceneCreationPoint(scene, { x: 12, y: 24 }, token), {
    x: 12, y: 24, level: "basement", elevation: -3
  });
  assert.equal(captureSceneCreationPoint(scene, { level: "surface", elevation: 0 }, token).elevation, 0);
  assert.equal(getSceneCreationLevelId(scene, token), "basement");
});

test("manual placement captures the client's floor; receiving GM view is never a fallback", () => {
  const { scene } = fixture();
  canvas.level.id = "basement";
  const point = captureSceneCreationPoint(scene, { x: 12, y: 24 });
  assert.equal(point.elevation, -4);
  canvas.level.id = "surface";
  assert.deepEqual(getSceneCreationLevels(scene, point), ["basement"]);
  canvas.level.id = "basement";
  assert.equal(getSceneCreationLevelId(scene), "surface");
  assert.deepEqual(getSceneCreationLevels(scene, { levels: new Set(["surface", "basement"]) }), ["surface", "basement"]);
  assert.deepEqual(getSceneCreationLevels(scene, { levels: [] }), []);
});

for (const file of ["canvas/traps", "canvas/thrown-items", "combat/weapon-attack-controller"]) {
  test(`${file} preserves floor through JSON point serialization`, () => {
    const { scene } = fixture();
    canvas.level.id = "basement";
    const point = captureSceneCreationPoint(scene, { x: 12, y: 24 });
    const serialize = implementation(file, "serializePoint");
    canvas.level.id = "surface";
    assert.deepEqual(JSON.parse(JSON.stringify(serialize(point))), point);
    if (file.startsWith("combat/")) {
      assert.deepEqual(implementation(file, "deserializePoint")(serialize(point)), point);
    }
  });
}

test("thrown item creation on the receiving GM keeps the transmitted floor and height", async () => {
  const { scene, writes, deps } = fixture();
  await implementation("canvas/thrown-items", "createThrownItemTileDocument", deps)({
    sceneId: scene.id, itemData: { name: "Grenade", img: "grenade.svg" },
    point: { x: 12, y: 24, level: "basement", elevation: -4 }
  });
  assert.deepEqual(writes[0].data[0].levels, ["basement"]);
  assert.equal(writes[0].data[0].elevation, -4);
});

test("trap placement preserves the floor before the skill roll and socket handoff", () => {
  const { scene } = fixture();
  canvas.level.id = "basement";
  const rectangle = implementation("canvas/traps", "getTrapPlacementRectFromPoint", {
    getTrapPlacementDimensions: () => ({ width: 20, height: 20 }),
    getSnappedTrapCenter: point => point
  })( { x: 20, y: 20 }, {}, scene);
  canvas.level.id = "surface";
  assert.equal(rectangle.level, "basement");
  assert.equal(rectangle.elevation, -4);
});

test("trap creation and rearming place both detection and activation regions on the tile's levels", async () => {
  const { scene, writes, deps } = fixture();
  const tile = { id: "trap", name: "Trap", levels: new Set(["basement"]), update: async () => {} };
  await implementation("canvas/traps", "createTrapActivationDocuments", {
    ...deps, normalizeTrapData: value => value, normalizeTrapPlacementRect: value => value
  })(scene, tile, { detection: { radiusMeters: 10 } }, { x: 0, y: 0, width: 20, height: 20 }, {
    polygons: [{ points: [0, 0, 20, 0, 20, 20] }]
  });
  assert.equal(writes[0].data.length, 2);
  for (const region of writes[0].data) assert.deepEqual(region.levels, ["basement"]);
});

test("trap Tile creation preserves the player's level on the GM", async () => {
  const { scene, writes, deps } = fixture();
  const create = implementation("canvas/traps", "createTrapDocumentsInRoot", {
    ...deps, serializePoint: implementation("canvas/traps", "serializePoint"), normalizeTrapData: value => value,
    normalizeTrapRotation: () => 0, createTrapFactionState: () => ({}), normalizeTrapPlacementRect: value => value,
    getTrapPlacementClippedArea: () => ({ polygons: [{}] }), trapSourceParticipant: () => ({}),
    isSystemEventCancelled: () => false, getTileDocumentDimensionsForVisualRect: rect => rect,
    normalizeTrapLinkedAction: () => null, trapDocumentOptions: () => ({}), DEFAULT_TRAP_IMAGE: "trap.svg",
    createTrapActivationDocuments: async (_scene, tile) => assert.deepEqual(tile.levels, ["basement"])
  });
  await create({ point: { x: 10, y: 20, elevation: -4, level: "basement" },
    placementRect: { x: 0, y: 0, width: 20, height: 20 }, trapData: { trigger: {}, disarm: {} }
  }, scene, { emit: async () => ({}) });
  assert.deepEqual(writes[0].data[0].levels, ["basement"]);
  assert.equal(writes[0].data[0].elevation, -4);
});

test("trap residual damage region inherits the trap instead of the GM's viewed floor", async () => {
  const { scene, writes, deps } = fixture();
  await implementation("canvas/traps", "createTrapEffectRegion", deps)(scene, {
    name: "Trap", levels: new Set(["basement"])
  }, { effect: { regionRadius: 10, regionDurationSeconds: 12 } }, { x: 12, y: 24, elevation: -4 });
  assert.deepEqual(writes[0].data[0].levels, ["basement"]);
});

test("inventory drop carries token floor and height into the created ground tile", async () => {
  const { scene, writes, deps } = fixture();
  const position = implementation("items/dropped-items", "getActorDropPosition", {
    getSceneGridSize: () => 100
  })({}, { scene, token: { x: 0, y: 0, width: 1, height: 1, level: "basement", elevation: -4 } });
  await implementation("items/dropped-items", "createDroppedItemsTile", {
    ...deps, getSceneGridSize: () => 100, getDroppedTileName: () => "Loot"
  })(scene, position, [{ itemData: { img: "item.svg" } }]);
  assert.deepEqual(writes[0].data[0].levels, ["basement"]);
  assert.equal(writes[0].data[0].elevation, -4);
});

test("coincident loot on other floors or elevations cannot absorb a new drop", () => {
  const { scene } = fixture();
  const underground = { levels: ["basement"], elevation: -4 };
  scene.tiles.contents = [{ levels: ["surface"], elevation: -4 }, { levels: ["basement"], elevation: 0 }, underground];
  const nearest = implementation("items/dropped-items", "findNearbyDroppedItemsTile", {
    DROPPED_ITEMS_RADIUS_METERS: 1, getPixelsForMeters: () => 100,
    getDroppedItemsFlag: () => ({ items: [{}] }), getTileCenter: () => ({ x: 0, y: 0 }), getPointDistance: () => 0
  });
  assert.equal(nearest(scene, { level: "basement", elevation: -4 }), underground);
  scene.tiles.contents.pop();
  assert.equal(nearest(scene, { level: "basement", elevation: -4 }), null);
});

test("immediate and delayed combat regions keep the transmitted impact level", async () => {
  const { scene, writes, deps } = fixture();
  deps.serializePoint = implementation("combat/weapon-attack-controller", "serializePoint");
  const center = { x: 12, y: 24, level: "basement", elevation: -4 };
  await implementation("combat/weapon-attack-controller", "createVolleyDamageRegionNow", deps)({
    sceneId: scene.id, center, radiusPixels: 10, durationSeconds: 12
  });
  await implementation("combat/weapon-attack-controller", "createDelayedVolleyExplosionRegionNow", {
    ...deps, registerDelayedThrownItemWorldOperation: () => {}, isDelayedThrownItemWorldOperationCancelled: () => false
  })({ sceneId: scene.id, delayedThrownItemId: "grenade", explodeAtWorldTime: 20, explosions: [{ center, radiusPixels: 10 }] });
  for (const write of writes) assert.deepEqual(write.data[0].levels, ["basement"]);
});

test("attached delayed region follows the attachment token's current floor", async () => {
  const { scene, writes, deps } = fixture();
  scene.tokens.set("target", { level: "basement" });
  await implementation("combat/weapon-attack-controller", "createDelayedVolleyExplosionRegionNow", {
    ...deps, registerDelayedThrownItemWorldOperation: () => {}, isDelayedThrownItemWorldOperationCancelled: () => false
  })({ sceneId: scene.id, attachmentTokenId: "target", delayedThrownItemId: "grenade", explodeAtWorldTime: 20,
    explosions: [{ center: { x: 0, y: 0, level: "surface" }, radiusPixels: 10 }] });
  assert.deepEqual(writes[0].data[0].levels, ["basement"]);
});

test("passenger exit replaces the boarding snapshot floor with the selected destination", async () => {
  const { scene, writes, deps } = fixture();
  const passenger = { id: "passenger", tokenData: { level: "surface", elevation: 0 } };
  await implementation("canvas/actor-containers", "performExitPassenger", {
    ...deps, fromUuid: async () => ({}), getActorContainerFlag: () => ({ passengers: [passenger] }),
    getTemporaryOwnershipCleanupUpdate: () => ({}), updateActorContainerActor: async () => {}, ACTOR_CONTAINER_FLAG: "container"
  })({ sceneId: scene.id, passengerId: passenger.id, placement: { x: 12, y: 24, level: "basement", elevation: -4 } });
  assert.equal(writes[0].data[0].level, "basement");
  assert.equal(writes[0].data[0].elevation, -4);
  assert.equal(passenger.tokenData.level, "surface");
});

test("passenger exit selection captures the destination floor before the GM request", () => {
  fixture();
  canvas.level.id = "basement";
  const placement = implementation("canvas/actor-containers", "getTokenPlacementAtPoint", {
    getTokenPixelSize: () => ({ width: 20, height: 20 }), getSnappedTokenPosition: (_token, point) => point
  })({ level: "surface", elevation: 0 }, { x: 20, y: 20 });
  assert.deepEqual(placement, { x: 10, y: 10, level: "basement", elevation: -4 });
});

test("light-network switch Tile is created on the selected floor", async () => {
  const { writes, deps } = fixture();
  canvas.level.id = "basement";
  canvas.canvasCoordinatesFromClient = () => ({ x: 10, y: 20 });
  await implementation("canvas/light-networks", "finishLightNetworkInteractionPlacement", {
    ...deps, activePlacement: { onImage: "on.svg", networkName: "lights" }, getSceneGridSize: () => 100,
    getSnappedTileCenter: point => point, isLightNetworkEnabled: () => true,
    cancelLightNetworkInteractionPlacement: () => {}, getNetworkDisplayName: value => value,
    LIGHT_NETWORK_INTERACTION_FLAG: "interaction", LIGHT_NETWORK_VISUAL_FLAG: "visual"
  })({ clientX: 0, clientY: 0 });
  assert.deepEqual(writes[0].data[0].levels, ["basement"]);
  assert.equal(writes[0].data[0].elevation, -4);
});

test("travel arrival preflight uses the destination zone floor, not the saved passenger floor", () => {
  const { scene } = fixture();
  scene.levels.set("basement", { id: "basement", elevation: { base: -4 } });
  const canPlace = implementation("global-map/travel-groups", "canPlaceTravelPassengers", {
    getMapAreaTokenPlacement, findFreePlacement: (_scene, data) => {
      assert.equal(data.level, "basement"); assert.equal(data.elevation, -4);
      return { x: 0, y: 0 };
    }, tokenRect: () => ({})
  });
  assert.equal(canPlace(scene, { levelId: "basement", cells: [] }, [{ tokenData: { level: "surface", elevation: 0 } }]), true);
});

test("travel placement ignores occupied cells on another floor", () => {
  const { scene, deps } = fixture();
  scene.grid = { getCenterPoint: () => ({ x: 50, y: 50 }) };
  scene.tokens.contents = [{ level: "surface", x: 0, y: 0 }];
  const findPlacement = implementation("global-map/travel-groups", "findFreePlacement", {
    ...deps, getMapTokenLevelId, getPlacementBounds: () => ({}), cellKey: () => "0,0",
    isCellCenterInsidePlacementBounds: () => true, rectInsidePlacementBounds: () => true,
    rectanglesOverlap: () => true, tokenRect: () => ({}),
    CONFIG: { Token: { documentClass: class {
      constructor(data) { Object.assign(this, data); }
      getCenterPoint() { return { x: 50, y: 50 }; }
      getSize() { return { width: 100, height: 100 }; }
      getSnappedPosition(point) { return { x: point.x, y: point.y }; }
      getOccupiedGridSpaceOffsets() { return [{ i: 0, j: 0 }]; }
    } } }
  });
  assert.deepEqual(findPlacement(scene, { level: "basement" }, [{ i: 0, j: 0 }], [], { strictPreferredCells: true }), { x: 0, y: 0 });
  scene.tokens.contents[0].level = "basement";
  assert.throws(() => findPlacement(scene, { level: "basement" }, [{ i: 0, j: 0 }], [], { strictPreferredCells: true }), /нет свободного места/);
});

test("removing a travel passenger uses the vehicle's current floor instead of the boarding snapshot", async () => {
  const { scene, writes, deps } = fixture();
  const passenger = { id: "passenger", tokenData: { level: "surface", elevation: 0 } };
  scene.tokens.set("vehicle", { id: "vehicle", level: "basement", elevation: -4, actor: { update: async () => {} } });
  await implementation("global-map/travel-groups", "removePassengerFromAssembly", {
    ...deps, pointToCell: () => ({}), tokenCenter: () => ({}), getCellCluster: () => [],
    findFreePlacement: (_scene, data) => {
      assert.equal(data.level, "basement"); return { x: 0, y: 0 };
    }, getActorContainerFlag: () => ({ passengers: [passenger] }), getPassengerRemovalOwnership: () => ({}),
    FALLOUT_MAW: { id: "fallout-maw" }, ACTOR_CONTAINER_FLAG: "container", TRAVEL_BYPASS_OPTION: "travel",
    tokenMemberId: id => id, storeAssembly: async () => {}, broadcastAssemblyChanged: () => {}
  })(scene, {}, { readyMemberIds: new Set(), leaderMemberId: "leader" }, {
    id: "passenger", sourceVehicleTokenId: "vehicle", sourcePassenger: passenger
  });
  assert.equal(writes[0].data[0].level, "basement");
  assert.equal(writes[0].data[0].elevation, -4);
});
