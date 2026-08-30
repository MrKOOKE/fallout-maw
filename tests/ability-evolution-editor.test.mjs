import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  clampGraphViewportToVisibleNode,
  createGraphSegmentViewport,
  readGraphViewportMetrics
} from "../src/utils/graph-viewport.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("catalog editor exposes evolution descriptions only for explicit evolution nodes", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/apps/ability-catalog-item-editor.mjs"), "utf8");
  const template = fs.readFileSync(path.join(ROOT, "templates/settings/ability-catalog-item-editor.hbs"), "utf8");
  assert.match(source, /openEvolutionEditor:\s*this\.#onOpenEvolutionEditor/);
  assert.match(source, /const \{ isEvolutionNode = false, \.\.\.applicationOptions \} = options/);
  assert.match(source, /const showEvolutionSummary = isDetailsTab && this\.#isEvolutionNode/);
  assert.match(source, /data-field='evolutionSummary'/);
  assert.match(source, /data-field='functionEnabled'/);
  assert.match(source, /fixed\.reactive\.actionPointsPerThreshold/);
  assert.match(template, /data-action="openEvolutionEditor"/);
  assert.match(template, /\{\{#if showEvolutionSummary\}\}[\s\S]*?data-field="evolutionSummary"[\s\S]*?\{\{\/if\}\}/);
  assert.match(template, /data-field="functionEnabled"/);
  assert.match(template, /data-field="fixed\.reactive\.actionPointsPerThreshold"/);
});

test("evolution editor opens nested abilities with vertical defaults and directional links", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/apps/ability-evolution-editor.mjs"), "utf8");
  const template = fs.readFileSync(path.join(ROOT, "templates/settings/ability-evolution-editor.hbs"), "utf8");
  assert.match(source, /isEvolutionNode:\s*true/);
  assert.match(source, /x:\s*snapToGrid\(parentNode\.x \+ getSiblingXOffset\(siblings\.length\)\)/);
  assert.match(source, /y:\s*snapToGrid\(parentNode\.y \+ CHILD_Y_GAP\)/);
  assert.match(source, /const startX = Number\(source\.x\) \+ \(NODE_WIDTH \/ 2\)/);
  assert.match(source, /const startY = Number\(source\.y\) \+ NODE_HEIGHT/);
  assert.match(source, /const endX = Number\(target\.x\) \+ \(NODE_WIDTH \/ 2\)/);
  assert.match(source, /const endY = Number\(target\.y\)/);
  const nodeMarkup = template.slice(template.indexOf("{{#each nodes}}"), template.indexOf("{{/each}}", template.indexOf("{{#each nodes}}")));
  assert.doesNotMatch(nodeMarkup, /\btitle=/);
});

test("new evolution nodes clone their selected parent without its descendant graph", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/apps/ability-evolution-editor.mjs"), "utf8");
  const template = fs.readFileSync(path.join(ROOT, "templates/settings/ability-evolution-editor.hbs"), "utf8");
  assert.match(source, /createAbilityCatalogCopy\(\{/);
  assert.match(source, /\.\.\.parentNode\.ability/);
  assert.match(source, /evolution:\s*createDefaultAbilityEvolution\(\)/);
  assert.doesNotMatch(source, /name:\s*"Новая эволюция"/);
  assert.doesNotMatch(template, /fallout-maw-evolution-selection/);
  assert.doesNotMatch(source, /summaryText:\s*stripMarkup/);
});

test("graph movement stays draft-only and persistence happens on close", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/apps/ability-evolution-editor.mjs"), "utf8");
  const template = fs.readFileSync(path.join(ROOT, "templates/settings/ability-evolution-editor.hbs"), "utf8");
  const pointerStart = source.indexOf("#onPointerMove(event)");
  const pointerEnd = source.indexOf("#onPointerUp(event)", pointerStart);
  const pointerMove = source.slice(pointerStart, pointerEnd);
  assert.doesNotMatch(pointerMove, /saveAbility|game\.settings\.set|\.render\(/);
  assert.match(source, /close\(options = \{\}\)[\s\S]*?this\.#closing = true;[\s\S]*?this\.#closeSavePromise = this\.#saveAndClose\(options\)/);
  assert.match(source, /await this\.#closeChildEditors\(\);[\s\S]*?this\.host\.syncAbilityDraft\?\.\(\)/);
  assert.match(source, /const hostRoot = this\.host\.getAbility[\s\S]*?evolution: this\.rootAbility\.system\.evolution/);
  assert.match(source, /const saved = await this\.host\.saveAbility\(this\.categoryId, this\.rootAbility\)/);
  assert.match(source, /this\.host\.releaseChildEditor\?\.\(this\)/);
  assert.match(template, /data-action="editEvolutionNode" \{\{#unless canEditSelected\}\}disabled/);
  assert.doesNotMatch(pointerMove, /requestAnimationFrame|setTimeout/);
});

test("evolution editor keeps clicks selectable and draws a node with its incident links synchronously", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/apps/ability-evolution-editor.mjs"), "utf8");
  const template = fs.readFileSync(path.join(ROOT, "templates/settings/ability-evolution-editor.hbs"), "utf8");
  const stylesheet = fs.readFileSync(path.join(ROOT, "styles/fallout-maw.css"), "utf8");
  assert.match(source, /const panCamera = event\.button === 2/);
  assert.match(source, /const captureElement = dragNode \? nodeElement : viewport/);
  assert.match(source, /state\.captureElement\?\.releasePointerCapture/);
  assert.match(source, /getCoalescedEvents/);
  assert.match(source, /#drawNode\(node\.id\)/);
  assert.match(source, /this\.#nodeElements\.get\(nodeId\)/);
  assert.match(source, /this\.#linkElements\.get\(link\.id\)/);
  assert.match(source, /this\.#linksByNodeId\.get\(nodeId\)/);
  assert.match(source, /if \(node\.x === nextX && node\.y === nextY\) return/);
  assert.match(source, /const nextX = pointer\.shiftKey \? x : snapToGrid\(x\)/);
  assert.match(source, /const nextY = pointer\.shiftKey \? y : snapToGrid\(y\)/);
  assert.match(source, /const dx = screenDx \/ state\.screenScaleX/);
  assert.match(source, /const dy = screenDy \/ state\.screenScaleY/);
  assert.match(source, /if \(event\.type === "pointerup"\) this\.#onPointerMove\(event\)/);
  assert.match(source, /#suppressSelectClick/);
  assert.doesNotMatch(source, /#scheduleNodeDraw|#drawFrame/);
  assert.match(source, /backgroundPosition/);
  assert.match(source, /backgroundSize/);
  assert.match(source, /clampGraphViewportToVisibleNode/);
  assert.match(source, /ResizeObserver/);
  assert.match(template, /ПКМ — камера/);
  assert.match(template, /Shift — свободно/);
  assert.match(stylesheet, /\.fallout-maw-evolution-node\s*\{[^}]*transition:\s*none;/s);
});

test("graph viewport metrics separate Foundry window scale from local graph pixels", () => {
  const metrics = readGraphViewportMetrics({
    clientHeight: 300,
    clientLeft: 2,
    clientTop: 2,
    clientWidth: 500,
    offsetHeight: 304,
    offsetWidth: 504,
    getBoundingClientRect: () => ({ height: 243.2, left: 100, top: 50, width: 403.2 })
  });
  assert.equal(metrics.height, 300);
  assert.equal(metrics.left, 101.6);
  assert.ok(Math.abs(metrics.scaleX - 0.8) < Number.EPSILON);
  assert.ok(Math.abs(metrics.scaleY - 0.8) < Number.EPSILON);
  assert.equal(metrics.top, 51.6);
  assert.equal(metrics.width, 500);
});

test("graph viewport protection keeps one complete node visible and centers the active segment", () => {
  const clamped = clampGraphViewportToVisibleNode({ x: -1000, y: -1000, zoom: 1 }, {
    height: 300,
    nodeHeight: 80,
    nodeWidth: 190,
    nodes: [{ id: "root", x: 0, y: 0 }, { id: "next", x: 0, y: 150 }],
    originX: 250,
    originY: 150,
    width: 500
  });
  assert.deepEqual(clamped, { x: -250, y: -300, zoom: 1 });

  const focused = createGraphSegmentViewport({
    focusNodeIds: ["current"],
    height: 400,
    links: [
      { fromId: "root", toId: "current" },
      { fromId: "current", toId: "next" },
      { fromId: "next", toId: "later" }
    ],
    maxZoom: 1,
    minZoom: 0.25,
    nodeHeight: 80,
    nodeWidth: 190,
    nodes: [
      { id: "root", x: 0, y: 0 },
      { id: "current", x: 0, y: 150 },
      { id: "next", x: 0, y: 300 },
      { id: "later", x: 0, y: 450 }
    ],
    padding: 20,
    width: 500
  });
  assert.equal(focused.zoom, 1);
  assert.deepEqual(focused, { x: 155, y: -65, zoom: 1 });
});

test("personal generator reuses the lineage-aware catalog snapshot path", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/apps/personal-generator.mjs"), "utf8");
  assert.match(source, /prepareCatalogAbilityItemData\(catalogEntry\)/);
  assert.doesNotMatch(source, /prepareAbilityItemData\(/);
});
