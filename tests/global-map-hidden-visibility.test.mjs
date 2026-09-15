import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

globalThis.foundry = {
  utils: {
    deepClone: value => value === undefined ? undefined : structuredClone(value),
    mergeObject: (original, other, { inplace = true } = {}) => {
      const target = inplace ? original : structuredClone(original);
      return mergeInto(target, other);
    }
  }
};

const { DEFAULT_LOCATION, DEFAULT_LOCATION_EXIT, GLOBAL_MAP_HIDDEN_ALPHA, applyGlobalMapHiddenDisplay } = await import("../src/global-map/constants.mjs");
const { normalizeLocation, normalizeLocationExit, normalizeSceneState } = await import("../src/global-map/storage.mjs");

test("global-map locations and exit zones default to visible and revealed", () => {
  assert.equal(DEFAULT_LOCATION.hidden, false);
  assert.equal(DEFAULT_LOCATION_EXIT.hidden, false);
  assert.equal(normalizeLocation({ id: "legacy" }).hidden, false);
  assert.equal(normalizeLocationExit({ id: "legacy", cells: ["0,0"] }).hidden, false);
  assert.equal(normalizeLocation({ id: "hidden", hidden: true }).hidden, true);
  assert.equal(normalizeLocationExit({ id: "hidden", hidden: true }).hidden, true);
});

test("global-map state normalization preserves the hidden visibility flag", () => {
  const state = normalizeSceneState({
    locations: [
      { id: "plain" },
      { id: "hidden", hidden: true, alwaysDiscovered: true },
      { id: "revealed", alwaysDiscovered: true }
    ],
    locationExitZones: [
      { id: "exit-hidden", hidden: true },
      { id: "exit-plain" }
    ]
  });

  assert.equal(state.locations[0].hidden, false);
  assert.equal(state.locations[1].hidden, true);
  assert.equal(state.locations[1].alwaysDiscovered, true);
  assert.equal(state.locations[2].hidden, false);
  assert.equal(state.locationExitZones[0].hidden, true);
  assert.equal(state.locationExitZones[1].hidden, false);
});

test("location and exit editors expose mutually exclusive revealed/hidden checkboxes", async () => {
  const locationTemplate = await readFile(new URL("../templates/global-map/location-editor.hbs", import.meta.url), "utf8");
  const exitTemplate = await readFile(new URL("../templates/global-map/location-exit-editor.hbs", import.meta.url), "utf8");
  const editor = await readFile(new URL("../src/global-map/editors.mjs", import.meta.url), "utf8");

  for (const [template, discoveredName, hiddenName] of [
    [locationTemplate, "location.alwaysDiscovered", "location.hidden"],
    [exitTemplate, "exit.alwaysDiscovered", "exit.hidden"]
  ]) {
    assert.match(template, new RegExp(`<input type="checkbox" name="${discoveredName.replace(".", "\\.")}"`));
    assert.match(template, new RegExp(`<input type="checkbox" name="${hiddenName.replace(".", "\\.")}"`));
    assert.match(template, /<span>Раскрыта<\/span>/);
    assert.match(template, /<span>Скрыта<\/span>/);
    assert.match(template, /class="fallout-maw-global-map-visibility"/);
    assert.doesNotMatch(template, /<label>Раскрыта<\/label>/);
    assert.doesNotMatch(template, /<label>Скрыта<\/label>/);
    assert.doesNotMatch(template, /Всегда обнаружена/);
    // The long explanations moved into tooltips so the row stays compact.
    assert.doesNotMatch(template, /<p class="hint">Локация/);
    assert.doesNotMatch(template, /<p class="hint">Зона выхода/);
    assert.match(template, /title="[^"]+"/);

    // The row is self-contained: an inlined flex row with a caption-then-box pair per state.
    const rowBlock = template.match(/<div class="fallout-maw-global-map-visibility"[^>]*>[\s\S]*?<\/div>/)?.[0] ?? "";
    assert.ok(rowBlock, "expected the visibility row block");
    assert.match(rowBlock, /style="[^"]*display: flex/, "the row must carry its own inline flex layout");
    assert.doesNotMatch(rowBlock, /form-fields/, "the row must not depend on Foundry's form-fields layout");

    const pairs = Array.from(rowBlock.matchAll(/<label class="checkbox">([\s\S]*?)<\/label>/g), match => match[1]);
    assert.equal(pairs.length, 2, "both visibility checkboxes share one row");
    for (const pair of pairs) {
      assert.ok(pair.indexOf("<span>") < pair.indexOf("<input"), "each caption sits directly left of its checkbox");
    }
    assert.doesNotMatch(template, /<span class="hint">Взаимоисключающе/);
    assert.doesNotMatch(template, /visibility-options/);
    assert.doesNotMatch(template, /<label>Видимость на карте<\/label>/);
  }

  assert.match(editor, /VISIBILITY_CHECKBOX_PAIRS/);
  assert.match(editor, /\["location\.alwaysDiscovered", "location\.hidden"\]/);
  assert.match(editor, /\["exit\.alwaysDiscovered", "exit\.hidden"\]/);
  assert.match(editor, /hidden: readCheckboxValue\(values\.hidden\)/);
  assert.match(editor, /hidden: readCheckboxValue\(location\.hidden\)/);
  assert.match(editor, /hidden: readCheckboxValue\(exit\.hidden\)/);
});

test("the visibility row only styles its own checkbox widgets", async () => {
  const css = await readFile(new URL("../styles/fallout-maw.css", import.meta.url), "utf8");

  // No rule may reflow the row container itself: its layout is inlined in the template.
  assert.doesNotMatch(css, /\.fallout-maw-global-map-visibility \{/, "the row container must not be styled from CSS");
  assert.doesNotMatch(css, /\.form-fields:has\(/, "no :has() hacks on the field row");

  const label = css.match(/\.fallout-maw-global-map-visibility label\.checkbox \{([\s\S]*?)\}/)?.[1] ?? "";
  assert.ok(label, "expected the checkbox widget rule");
  assert.match(label, /display: flex/);
  assert.match(label, /flex: none/);
  assert.match(label, /white-space: nowrap/);
  assert.doesNotMatch(label, /flex:\s*1\b/, "labels must keep their natural width");

  const input = css.match(/\.fallout-maw-global-map-visibility label\.checkbox > input\[type="checkbox"\] \{([\s\S]*?)\}/)?.[1] ?? "";
  assert.ok(input, "expected the checkbox input rule");
  assert.match(input, /flex: 0 0 auto/);
  assert.match(input, /width: auto/);
});

test("the visibility row fits the default dialog width", async () => {
  const templates = await Promise.all([
    readFile(new URL("../templates/global-map/location-editor.hbs", import.meta.url), "utf8"),
    readFile(new URL("../templates/global-map/location-exit-editor.hbs", import.meta.url), "utf8")
  ]);
  const editor = await readFile(new URL("../src/global-map/editors.mjs", import.meta.url), "utf8");
  const dialogWidth = Number(editor.match(/position: \{ width: (\d+), height: "auto" \}/)?.[1] ?? 0);
  assert.ok(dialogWidth >= 400, "the editor dialog width is known");

  for (const template of templates) {
    const labels = Array.from(template.matchAll(/<span>(Раскрыта|Скрыта)<\/span>/g), match => match[1]);
    assert.deepEqual(labels, ["Раскрыта", "Скрыта"]);
    // 14px captions + 20px boxes + the inline 12px gaps must fit inside the dialog.
    const estimatedWidth = labels.reduce((total, label) => total + 20 + label.length * 8.5 + 12, 0);
    assert.ok(estimatedWidth < dialogWidth - 16, `label row (~${Math.round(estimatedWidth)}px) must fit ${dialogWidth}px`);
  }
});

test("the GM playing a token never sees undiscovered locations", async () => {
  const layer = await readFile(new URL("../src/global-map/layer.mjs", import.meta.url), "utf8");
  const visibility = layer.match(/#isLocationVisible\(location, discovered\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
  assert.ok(visibility, "expected a single shared visibility predicate");

  // One predicate for the layer and the overlay, so they cannot drift apart.
  assert.equal(layer.split("#isLocationVisible(location, discovered)").length - 1, 3, "defined once, used twice");
  const drawLocations = layer.match(/#drawLocations\(locations, discoveredIds, refreshCycle\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
  assert.ok(drawLocations, "expected the location draw loop");
  assert.doesNotMatch(drawLocations, /gmPlayView|game\.user\.isGM/, "the draw loop keeps no GM-only branch of its own");

  // Playing a token: revealed or discovered, never hidden.
  assert.match(visibility, /const gmOverview = game\.user\.isGM && !isControllingAnyToken\(\);/);
  assert.match(visibility, /return known && !location\.hidden;/);
  assert.match(visibility, /const known = location\.alwaysDiscovered \|\| discovered\.has\(location\.id\);/);

  // Overview keeps hidden markers only while the setting allows it.
  assert.match(visibility, /if \(!location\.hidden\) return true;/);
  assert.match(visibility, /return getSceneState\(canvas\.scene\)\.fog\.hiddenLocationsInPlay !== false;/);
  // The edit tool still shows everything.
  assert.match(visibility, /if \(editLocations\) return true;/);
});

test("hidden global-map entries are dimmed and desaturated for the GM", async () => {
  assert.ok(GLOBAL_MAP_HIDDEN_ALPHA > 0 && GLOBAL_MAP_HIDDEN_ALPHA < 1);

  const target = { alpha: 1, filters: [] };
  assert.equal(applyGlobalMapHiddenDisplay(target), target);
  assert.equal(target.alpha, GLOBAL_MAP_HIDDEN_ALPHA);
  assert.deepEqual(target.filters, [], "without PIXI the alpha alone still dims the entry");

  const layer = await readFile(new URL("../src/global-map/layer.mjs", import.meta.url), "utf8");
  assert.match(layer, /location\.hidden \? applyGlobalMapHiddenDisplay\(new PIXI\.Container\(\)\)/);
  assert.match(layer, /if \(exit\.hidden\) applyGlobalMapHiddenDisplay\(graphic\);/);
});

test("the GM sees hidden entries only while no token is under control", async () => {
  const layer = await readFile(new URL("../src/global-map/layer.mjs", import.meta.url), "utf8");
  const index = await readFile(new URL("../src/global-map/index.mjs", import.meta.url), "utf8");

  // Hidden entries follow the controlled token: playing an actor means seeing the map
  // the way that actor does.
  assert.match(layer, /function isControllingAnyToken\(\)/);
  assert.match(layer, /canvas\?\.tokens\?\.controlled\?\.length/);
  assert.match(index, /Hooks\.on\("controlToken", \(\) => canvas\[GLOBAL_MAP_LAYER\]\?\.refresh\?\.\(\)\)/);

  const drawLocations = layer.match(/#drawLocations\(locations, discoveredIds, refreshCycle\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
  assert.ok(drawLocations, "expected the location draw loop");
  assert.match(drawLocations, /if \(!this\.#isLocationVisible\(location, discovered\)\) continue;/,
    "the draw loop must use the shared predicate for everyone, the GM included");

  const drawExits = layer.match(/#drawLocationExitZones\(exits, discoveredIds\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
  assert.ok(drawExits, "expected the exit-zone draw loop");
  assert.match(drawExits, /if \(!gmPlayView && !\["locationExitDraw", "locationExitEdit"\]\.includes\(this\.mode\)\) continue;/);
  assert.match(drawExits, /const gmPlayView = game\.user\.isGM[\s\S]*?!isControllingAnyToken\(\)/);
  const exitHiddenGuard = drawExits.indexOf("} else if (exit.hidden) {");
  const exitGmBranch = drawExits.indexOf("!game.user.isGM");
  assert.ok(exitHiddenGuard >= 0 && exitHiddenGuard < exitGmBranch, "the exit-zone guard must run for the GM too");
});

test("the overview mode can be disabled from the map settings", async () => {
  const template = await readFile(new URL("../templates/global-map/scene-settings.hbs", import.meta.url), "utf8");
  const editor = await readFile(new URL("../src/global-map/editors.mjs", import.meta.url), "utf8");
  const constants = await import("../src/global-map/constants.mjs");
  const { normalizeSceneState } = await import("../src/global-map/storage.mjs");

  assert.match(template, /name="fog\.hiddenLocationsInPlay"/);
  assert.match(editor, /hiddenLocationsInPlay: this\.data\.hiddenLocationsInPlay !== false/);
  assert.match(editor, /hiddenLocationsInPlay: readCheckboxValue\(values\.hiddenLocationsInPlay\)/);

  assert.equal(constants.DEFAULT_SCENE_STATE.fog.hiddenLocationsInPlay, true, "enabled by default");
  assert.equal(normalizeSceneState({}).fog.hiddenLocationsInPlay, true);
  assert.equal(normalizeSceneState({ fog: { hiddenLocationsInPlay: false } }).fog.hiddenLocationsInPlay, false);
  assert.equal(normalizeSceneState({ fog: { hiddenLocationsInPlay: true } }).fog.hiddenLocationsInPlay, true);
});

test("hidden global-map entries stay out of discovery, rendering and travel triggers", async () => {
  const fog = await readFile(new URL("../src/global-map/fog.mjs", import.meta.url), "utf8");
  const layer = await readFile(new URL("../src/global-map/layer.mjs", import.meta.url), "utf8");
  const travel = await readFile(new URL("../src/global-map/travel.mjs", import.meta.url), "utf8");
  const travelGroups = await readFile(new URL("../src/global-map/travel-groups.mjs", import.meta.url), "utf8");

  assert.match(fog, /location => !location\.hidden && \(location\.alwaysDiscovered \|\| isLocationVisible/);
  assert.match(fog, /exit => !exit\.hidden && \(exit\.alwaysDiscovered \|\| isCellsVisible/);
  assert.match(fog, /async function pruneHiddenDiscoveries/);
  assert.match(fog, /entry => entry\.alwaysDiscovered && !entry\.hidden/);

  assert.match(layer, /return known && !location\.hidden;/);
  assert.match(layer, /!game\.user\.isGM && \(!exit\.alwaysDiscovered && !discovered\.has/);

  assert.match(travel, /if \(exit\.hidden \|\| !exit\.cells\?\.includes\(key\)\) continue;/);
  assert.match(travel, /if \(location\.hidden \|\| !location\.linkedSceneId/);
  assert.match(travelGroups, /filter\(zone => !zone\.hidden && zone\.cells\?\.length\)/);
  assert.match(travelGroups, /if \(found\.location\.hidden\) throw new Error/);
  assert.match(travelGroups, /if \(zone\?\.hidden\) throw new Error/);
});

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
