import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as levels from "../src/global-map/levels.mjs";

const ground = { id: "ground", name: "Поверхность", elevation: { base: 0 } };
const basement = { id: "basement", name: "Подвал", elevation: { base: -10 } };
const scene = { id: "scene", initialLevel: ground, levels: { contents: [ground, basement], get: id => [ground, basement].find(level => level.id === id) } };
const source = file => fs.readFileSync(new URL(`../src/global-map/${file}.mjs`, import.meta.url), "utf8");
function extract(file, name, deps, method = false) {
  const match = source(file).match(method ? new RegExp(`  ((?:async )?#${name}\\([^]*?\\n  \\})`) : new RegExp(`((?:async )?function ${name}\\([^]*?\\n\\})`));
  assert.ok(match, name);
  const code = match[1].replaceAll("#", "");
  return new Function(...Object.keys(deps), method ? `return ({${code}}).${name}` : `${code}; return ${name}`)(...Object.values(deps));
}

test("legacy zones belong to the initial level and never follow the viewed floor", () => {
  globalThis.canvas = { scene, level: basement };
  assert.equal(levels.getMapAreaLevelId(scene, {}), "ground");
  assert.equal(levels.isMapAreaOnLevel(scene, {}), false);
  assert.equal(levels.isMapAreaOnLevel(scene, { levelId: "basement" }), true);
  assert.equal(levels.getViewedMapLevelId(scene), "basement");
  assert.equal(levels.getViewedMapLevelId({ ...scene, id: "other" }), "ground");
  assert.equal(levels.isMapAreaOnLevel({}, {}), true);
});

test("linked zones use the destination floor independently of the source floor", () => {
  const area = { levelId: "ground", entryLevelId: "basement" };
  assert.equal(levels.isMapAreaOnLevel(scene, area, "basement", "entryLevelId"), true);
  assert.equal(levels.isMapAreaOnLevel(scene, area, "basement"), false);
  assert.deepEqual(levels.getMapAreaTokenPlacement(scene, area, "entryLevelId"), { level: "basement", elevation: -10 });
  assert.equal(levels.getMapLevelChoices(scene, area, "entryLevelId").find(level => level.selected).id, "basement");
});

test("token movement level takes precedence over the GM's viewed floor", () => {
  globalThis.canvas = { scene, level: ground };
  const token = { level: ground, _source: { level: "ground" } };
  assert.equal(levels.getMapTokenLevelId(scene, token, { level: "basement" }), "basement");
  assert.equal(levels.getMapTokenLevelId(scene, { _source: { level: "basement" } }), "basement");
});

function drawingFixture() {
  globalThis.canvas = { scene, level: basement };
  const drawings = [];
  const deps = { ...levels, canvas, game: { user: { isGM: true }, scenes: { contents: [] } },
    PIXI: { LegacyGraphics: class {} }, TransitionEditor: class {}, LocationExitEditor: class {}, TransitionEntryEditor: class {},
    normalizeActiveIds: value => new Set(Array.isArray(value) ? value : [value]),
    getSceneState: () => ({ fog: {} }), isControllingAnyToken: () => false,
    DEFAULT_LOCATION_EXIT: { color: "yellow" }, applyGlobalMapHiddenDisplay() {},
    parseCellKey: value => value, drawCellArea: (_graphic, cells) => drawings.push(cells) };
  const layer = { editor: null, mode: "select", container: { addChild() {} }, pendingAreaOverwrites: { transitions: new Map(), locationExitZones: new Map() } };
  return { deps, layer, drawings };
}

test("transition and exit overlays draw only the viewed floor, including for GM", () => {
  for (const name of ["drawTransitions", "drawLocationExitZones"]) {
    const { deps, layer, drawings } = drawingFixture();
    extract("layer", name, deps, true).call(layer, [
      { id: "old", cells: ["old"] }, { id: "ground", levelId: "ground", cells: ["surface"] },
      { id: "basement", levelId: "basement", cells: ["below"] }
    ], []);
    assert.deepEqual(drawings, [["below"]]);
    canvas.level = ground;
    drawings.length = 0;
    extract("layer", name, deps, true).call(layer, [{ id: "old", cells: ["old"] }], []);
    assert.deepEqual(drawings, [["old"]]);
  }
});

test("incoming transition overlays check entryLevelId instead of the source level", () => {
  const { deps, layer, drawings } = drawingFixture();
  deps.game.scenes.contents = [{ id: "origin" }];
  deps.getSceneState = () => ({ transitions: [
    { id: "visible", targetSceneId: scene.id, levelId: "ground", entryLevelId: "basement", entryCells: ["below"] },
    { id: "hiddenFloor", targetSceneId: scene.id, levelId: "basement", entryLevelId: "ground", entryCells: ["surface"] }
  ] });
  extract("layer", "drawIncomingTransitionZones", deps, true).call(layer);
  assert.deepEqual(drawings, [["below"]]);
});

test("painting ownership on another floor cannot block or overwrite the same cells", () => {
  globalThis.canvas = { scene, level: basement };
  const deps = { ...levels, canvas, normalizeActiveIds: value => new Set(value), getSceneState: () => ({ transitions: [
    { id: "below", levelId: "basement", cells: ["0,0"] }, { id: "above", levelId: "ground", cells: ["0,0"] }
  ] }) };
  const find = extract("layer", "findAreaOwner", deps, true);
  const layer = { pendingAreaOverwrites: {} };
  assert.equal(find.call(layer, "transitions", "0,0").id, "below");
  assert.equal(find.call(layer, "transitions", "0,0", new Set(["below"])), null);
});

test("travel candidates on matching coordinates ignore transitions and exits on another floor", () => {
  globalThis.canvas = { scene, level: ground };
  const deps = { ...levels, cellKey: () => "0,0", pointToCell: () => ({}), tokenCenter: value => value,
    getLocationCells: () => [], findLinkedTransitionEntries: (_scene, _key, levelId) => { assert.equal(levelId, "basement"); return []; },
    getSceneState: () => ({ locations: [], transitions: [
      { id: "above", levelId: "ground", cells: ["0,0"] }, { id: "below", levelId: "basement", cells: ["0,0"] }
    ], locationExitZones: [{ id: "exitAbove", cells: ["0,0"] }, { id: "exitBelow", levelId: "basement", cells: ["0,0"] }] }) };
  const candidates = extract("travel", "getCandidatesAtToken", deps)(scene, { level: "basement" });
  assert.deepEqual(candidates.map(entry => entry.key), ["transition:below", "locationExit:exitBelow"]);
});

test("terrain penalties and impassable cells are isolated by token level", () => {
  const deps = { ...levels, getSceneState: () => ({ terrains: [
    { id: "ground", levelId: "ground", cells: ["0,0"], difficulty: 100 },
    { id: "below", levelId: "basement", cells: ["0,0"], difficulty: 0 }
  ] }) };
  const build = extract("travel-movement", "buildTerrainCellMap", deps);
  assert.equal(build(scene, "basement").get("0,0").difficulty, 0);
  assert.equal(build(scene, "ground").get("0,0").difficulty, 100);
});

test("arrival switches the viewed floor even when the destination scene is already open", async () => {
  for (const [file, name] of [["travel", "completeTravelForCurrentViewer"], ["travel-groups", "completeTravelNotificationForCurrentViewer"]]) {
    const views = [];
    globalThis.canvas = { scene, level: ground, ready: true, loading: false };
    const destination = { ...scene, view: async options => { views.push(options); canvas.level = basement; } };
    const deps = { canvas, game: { scenes: { get: () => destination } }, clearTravelViewRetry() {} };
    const complete = extract(file, name, deps);
    assert.equal(await complete({ targetSceneId: scene.id, targetLevelId: "basement" }), true);
    assert.deepEqual(views, [{ level: "basement" }]);
    await complete({ targetSceneId: scene.id, targetLevelId: "basement" });
    assert.equal(views.length, 1);
  }
});

test("saving the arrival editor preserves source level and stores the destination level", async () => {
  const stored = { id: "transition", levelId: "ground", targetSceneId: scene.id, cells: ["1,1"] };
  let saved;
  const deps = { getExpandedFormData: value => value, getSceneState: () => ({ transitions: [stored] }),
    saveCollectionEntry: async (_scene, _collection, entry) => { saved = entry; },
    canvas: {}, DEFAULT_LOCATION_EXIT: { color: "yellow" } };
  const body = source("editors").split("export class TransitionEntryEditor")[1]
    .match(/  (async _processFormData\([^]*?\n  \})/)[1];
  const save = new Function(...Object.keys(deps), `return ({${body}})._processFormData`)(...Object.values(deps));
  const editor = { scene, data: { ...stored, entryLevelId: "ground", entryCells: ["2,2"] } };
  await save.call(editor, null, null, { entry: { levelId: "basement" } });
  assert.equal(saved.levelId, "ground");
  assert.equal(saved.entryLevelId, "basement");
  assert.deepEqual(saved.cells, ["1,1"]);
  assert.deepEqual(saved.entryCells, ["2,2"]);
});

test("discovery requires an owned token on the zone's floor", () => {
  const token = { level: "ground", actor: { testUserPermission: () => true } };
  const deps = { ...levels, CONST: { DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3 } },
    pointToCell: () => ({}), tokenCenter: value => value, getCellCluster: () => [{}], cellKey: () => "0,0" };
  const discover = extract("fog", "userHasNearbyOwnedToken", deps);
  const area = { levelId: "basement", cells: ["0,0"] };
  const state = { fog: { mode: "cells", cellRadius: 1 } };
  const withTokens = { ...scene, tokens: { contents: [token] } };
  assert.equal(discover({}, withTokens, state, area, "exit"), false);
  token.level = "basement";
  assert.equal(discover({}, withTokens, state, area, "exit"), true);
});
