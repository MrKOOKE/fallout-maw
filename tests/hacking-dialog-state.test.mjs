import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildHackingDialogState, getHackingCandidateBlockReason } from "../src/apps/hacking-dialog-state.mjs";
import { syncHackingDOM } from "../src/apps/hacking-dialog-dom.mjs";

const method = (id = "mechanical", changes = {}) => ({ id, toolKey: id, toolClass: "D", difficulty: 60, attempts: 3, attemptsRemaining: 3, toolCost: 1, ...changes });
const candidate = (id = "kit", changes = {}) => ({ candidateKey: `mechanical:${id}`, itemId: id, methodId: "mechanical", toolClass: "S", supplyValue: 599, supplyMax: 600, resourceMode: "supply", toolCost: 1, blockReason: "", ...changes });

test("initial selection chooses an available method; exhausted selection remains inspectable", () => {
  const methods = [method("electronic", { attemptsRemaining: 0 }), method()];
  const candidates = [candidate()];
  assert.equal(buildHackingDialogState({ methods, candidates }).selectedMethodId, "mechanical");
  const exhausted = buildHackingDialogState({ methods, candidates, selectedMethodId: "electronic" });
  assert.equal(exhausted.selectedMethodId, "electronic");
  assert.equal(exhausted.hackDisabled, true);
  assert.equal(exhausted.methods.length, 2);
  assert.match(exhausted.blockReason, /исчерпаны/);
});

test("lost tool falls back within the selected method, never to another method", () => {
  const args = { methods: [method(), method("electronic")], candidates: [candidate("replacement"), candidate("other", { methodId: "electronic" })], selectedMethodId: "mechanical", selectedCandidateKey: "mechanical:lost" };
  assert.equal(buildHackingDialogState(args).selectedCandidateKey, "mechanical:replacement");
  const empty = buildHackingDialogState({ ...args, candidates: [args.candidates[1]] });
  assert.equal(empty.selectedMethodId, "mechanical");
  assert.equal(empty.selectedTool, null);
  assert.equal(empty.hackDisabled, true);
});

test("availability explains class, resource configuration, supply and exhausted attempts", () => {
  const valid = { attemptsRemaining: 1, toolClass: "S", requiredClass: "D", resourceConfigured: true, supplyValue: 1, toolCost: 1 };
  assert.equal(getHackingCandidateBlockReason(valid), "");
  assert.match(getHackingCandidateBlockReason({ ...valid, toolClass: "D", requiredClass: "A" }), /класс A/);
  assert.match(getHackingCandidateBlockReason({ ...valid, resourceConfigured: false }), /не настроен/);
  assert.match(getHackingCandidateBlockReason({ ...valid, supplyValue: 0 }), /нужно 1, есть 0/);
  assert.match(getHackingCandidateBlockReason({ ...valid, attemptsRemaining: 0 }), /исчерпаны/);
});

test("resource preview uses effective cost, condition labels and a bounded meter", () => {
  const state = buildHackingDialogState({ methods: [method()], candidates: [candidate("kit", { resourceMode: "condition", toolCost: 4, supplyValue: 8, supplyMax: 10 })] });
  assert.equal(state.resourceLabel, "Прочность");
  assert.equal(state.remainingSupply, 4);
  assert.equal(state.tools[0].resourcePercent, 80);
  assert.equal(state.attemptMarkers.length, 3);
  const unbounded = buildHackingDialogState({ methods: [method("mechanical", { attempts: 10000 })], candidates: [candidate("kit", { supplyMax: 0 })] });
  assert.equal(unbounded.tools[0].hasMeter, false);
  assert.equal(unbounded.attemptMarkers.length, 0);
});

test("unavailable tools remain visible and cannot become the selected tool", () => {
  const state = buildHackingDialogState({ methods: [method()], candidates: [candidate("empty", { blockReason: "Недостаточно ресурса" }), candidate()], selectedCandidateKey: "mechanical:empty" });
  assert.equal(state.tools.length, 2);
  assert.equal(state.tools[0].disabled, true);
  assert.equal(state.selectedCandidateKey, "mechanical:kit");
});

test("global blockers and busy state prevent attempts, including an empty method list", () => {
  const base = { methods: [method()], candidates: [candidate()] };
  for (const constraint of [{ unlocked: true }, { isOwner: false }, { hasSkill: false }, { hasGM: false }, { targetAvailable: false }, { busy: "Проверка…" }]) {
    assert.equal(buildHackingDialogState({ ...base, ...constraint }).hackDisabled, true);
  }
  assert.match(buildHackingDialogState().blockReason, /не настроены/);
  assert.equal(buildHackingDialogState(base).hackDisabled, false);
});

const source = await readFile(new URL("../src/apps/hacking-dialog.mjs", import.meta.url), "utf8");

function harness({ roll = async () => ({ result: { key: "failure" } }), apply = null } = {}) {
  let hookId = 0;
  const hooks = new Map();
  const actor = { uuid: "Actor.hacker", name: "Взломщик", isOwner: true, system: { skills: { repair: {} } }, items: { contents: [{ id: "kit", uuid: "Actor.hacker.Item.kit", name: "Набор", functions: [{ toolKey: "mechanical", toolClass: "S", resource: { configured: true, available: true, value: 599, max: 600, mode: "supply" } }] }] } };
  const target = { uuid: "Actor.container", documentName: "Actor", name: "Контейнер", system: { hacking: { enabled: true, methods: [method()] } } };
  const classes = new Set();
  const title = { textContent: "" };
  const root = { offsetHeight: 520, contains: () => false, querySelectorAll: () => [], querySelector: selector => selector === ".window-title" ? title : null,
    classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } } };
  class Application {
    element = root;
    contexts = [];
    renderOptions = [];
    positions = [];
    _configureRenderOptions(options) {
      options.position = { height: "auto", ...options.position };
    }
    setPosition(position) { this.positions.push(position); }
    async _prepareContext() { return {}; }
    async _preRender() {}
    async _onRender() {}
    async render(options = {}) {
      options.isFirstRender = !this.contexts.length;
      this._configureRenderOptions(options);
      this.renderOptions.push(options);
      this.context = await this._prepareContext(options);
      this.contexts.push(this.context);
      await this._preRender(this.context, options);
      await this._onRender(this.context, options);
      return this;
    }
    async close() { this.closed = true; }
  }
  const sandbox = vm.createContext({
    buildHackingDialogState, getHackingCandidateBlockReason, syncHackingDOM,
    SYSTEM_ID: "fallout-maw", TEMPLATES: {}, setTimeout, clearTimeout,
    console: { error() {} }, document: { activeElement: null, createElement: () => ({ textContent: "", get innerHTML() { return this.textContent.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); } }) },
    CONST: { WALL_DOOR_STATES: { LOCKED: 2 } },
    foundry: { applications: { api: { ApplicationV2: Application, DialogV2: {}, HandlebarsApplicationMixin: base => base } }, utils: {
      randomID: () => "random",
      getProperty: (object, path) => path.split(".").reduce((value, key) => value?.[key], object),
      setProperty(object, path, value) { const keys = path.split("."); const leaf = keys.pop(); for (const key of keys) object = object[key] ??= {}; object[leaf] = value; },
      deleteProperty(object, path) { const keys = path.split("."); const leaf = keys.pop(); for (const key of keys) object = object[key]; delete object[leaf]; }
    } },
    Hooks: { on(name, fn) { const id = ++hookId; hooks.set(id, { name, fn }); return id; }, off(_name, id) { hooks.delete(id); } },
    game: { user: { isGM: true }, users: {} },
    ui: { notifications: { warn() {} } },
    getHackingSettings: () => ({ skillKey: "repair" }),
    getSkillSettings: () => [{ key: "repair", label: "Ремесло" }],
    getToolSettings: () => [{ key: "mechanical", label: "Механический взлом" }],
    getEnabledToolFunctions: item => item.functions,
    getActorToolSupplyCost: (_actor, _toolKey, cost) => cost,
    toInteger: value => Math.trunc(Number(value) || 0),
    createActorOperationLock: () => ({}),
    requestSkillCheck: roll,
    testApply: apply ?? (async () => ({ unlocked: false, methods: [method("mechanical", { attemptsRemaining: 2 })] }))
  });
  vm.runInContext(source.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "")
    + "\nrequestApplyHackingResult = testApply; globalThis.TestDialog = HackingDialog; globalThis.testCandidates = getHackingToolCandidates; globalThis.normalizeMethods = normalizeHackingMethods; globalThis.buildMethodRow = buildHackingMethodRow; globalThis.prepareWallUpdate = prepareWallHackingUpdate;", sandbox);
  const dialog = new sandbox.TestDialog({ hackerActor: actor, target });
  const action = (name, dataset = {}) => sandbox.TestDialog.DEFAULT_OPTIONS.actions[name].call(dialog, { preventDefault() {} }, { dataset });
  return { sandbox, dialog, action, actor, target, hooks, classes, title, root };
}

test("attempt updates preserve frame height and never force foreground or maximize", async () => {
  const h = harness();
  await h.dialog.render({ force: true });
  assert.equal(h.dialog.renderOptions[0].position.height, "auto");
  await h.action("attemptHack");
  assert.equal(h.dialog.renderOptions.length, 4);
  for (const options of h.dialog.renderOptions.slice(1)) {
    assert.equal(options.position.height, 520);
    assert.notEqual(options.force, true);
  }
  // Respect a user resize on the next update instead of the opening dimensions.
  h.root.offsetHeight = 640;
  await h.dialog.render();
  assert.equal(h.dialog.renderOptions.at(-1).position.height, 640);
  await h.dialog.render({ position: { height: 700 } });
  assert.equal(h.dialog.renderOptions.at(-1).position.height, 700);
  h.dialog.minimized = true;
  const positions = h.dialog.positions.length;
  await h.dialog.render();
  assert.equal(h.dialog.renderOptions.at(-1).position, undefined);
  assert.equal(h.dialog.positions.length, positions);
  await h.dialog.close();
});

test("selecting the current tool is a no-op and busy button labels stay compact", async () => {
  const h = harness();
  await h.dialog.render();
  await h.action("selectTool", { hackingCandidate: h.dialog.context.selectedCandidateKey });
  assert.equal(h.dialog.contexts.length, 1);
  const state = buildHackingDialogState({ methods: [method()], candidates: [candidate()], busy: "Применение результата…" });
  assert.equal(state.buttonLabel, "Выполняется…");
  assert.equal(state.actionLabel, "Применение результата…");
  await h.dialog.close();
});

test("legacy and invalid interface values default to terminal; mechanical is preserved by normalization", () => {
  const h = harness();
  const result = h.sandbox.normalizeMethods([method(), method("other", { interfaceType: "mechanical" }), method("invalid", { interfaceType: "invalid" })]);
  assert.deepEqual(Array.from(result, entry => entry.interfaceType), ["terminal", "mechanical", "terminal"]);
  const html = h.sandbox.buildMethodRow(result[1], 2, "flags.fallout-maw.hacking.methods");
  assert.match(html, /name="flags\.fallout-maw\.hacking\.methods\.2\.interfaceType"/);
  assert.match(html, /value="mechanical" selected/);
  assert.ok(html.indexOf(".toolKey") < html.indexOf(".interfaceType"));
  assert.ok(html.indexOf(".interfaceType") < html.indexOf(".toolClass"));
});

test("wall method submission and relocking retain the chosen interface", () => {
  const h = harness();
  const methods = [method("mechanical", { interfaceType: "mechanical", attemptsRemaining: 0 })];
  const wall = { documentName: "Wall", ds: 0, getFlag: () => ({ methods }) };
  const changes = { ds: 2 };
  h.sandbox.prepareWallUpdate(wall, changes);
  assert.equal(changes.flags["fallout-maw"].hacking.methods[0].interfaceType, "mechanical");
  assert.equal(changes.flags["fallout-maw"].hacking.methods[0].attemptsRemaining, 3);
  const submitted = { flags: { "fallout-maw": { hacking: { editorSubmitted: true, methods: { 0: methods[0] } } } } };
  h.sandbox.prepareWallUpdate(wall, submitted);
  assert.equal(submitted.flags["fallout-maw"].hacking.methods[0].interfaceType, "mechanical");
  assert.equal(submitted.flags["fallout-maw"].hacking.methods[0].attemptsRemaining, 0);
});

test("switching methods updates layout, window title and action without coupling to the tool type", async () => {
  const h = harness();
  h.target.system.hacking.methods.push(method("physical", { interfaceType: "mechanical" }));
  await h.dialog.render();
  assert.equal(h.dialog.context.isMechanical, false);
  assert.match(h.title.textContent, /Терминал/);
  await h.action("selectMethod", { hackingMethod: "physical" });
  assert.equal(h.dialog.context.isMechanical, true);
  assert.equal(h.classes.has("is-mechanical"), true);
  assert.equal(h.dialog.context.actionLabel, "Вскрыть замок");
  assert.match(h.title.textContent, /Механика/);
  await h.action("selectMethod", { hackingMethod: "mechanical" });
  assert.equal(h.classes.has("is-mechanical"), false);
  assert.match(h.title.textContent, /Терминал/);
  await h.dialog.close();
});

test("a failed attempt retains the mechanical interface from the confirmed methods", async () => {
  const h = harness({ apply: async () => ({ unlocked: false, methods: [method("mechanical", { interfaceType: "mechanical", attemptsRemaining: 2 })] }) });
  h.target.system.hacking.methods[0].interfaceType = "mechanical";
  await h.dialog.render();
  await h.action("attemptHack");
  assert.equal(h.dialog.context.isMechanical, true);
  assert.equal(h.dialog.context.attemptsRemaining, 2);
  assert.equal(h.dialog.context.actionLabel, "Вскрыть замок");
  await h.dialog.close();
});

test("controller uses the same eligibility for display and authoritative candidates", () => {
  const h = harness();
  const methods = [method("mechanical", { attemptsRemaining: 0 })];
  assert.equal(h.sandbox.testCandidates(h.actor, methods).length, 0);
  assert.equal(h.sandbox.testCandidates(h.actor, methods, h.target, { includeUnavailable: true }).length, 1);
  h.actor.items.contents[0].functions[0].toolClass = "D";
  assert.equal(h.sandbox.testCandidates(h.actor, [method("mechanical", { toolClass: "S" })]).length, 0);
});

test("terminal method menu replaces the tool view and returns after a selection", async () => {
  const h = harness();
  await h.dialog.render();
  assert.equal(h.dialog.context.choosingMethod, false);
  assert.equal(h.dialog.context.canChooseMethod, false);
  h.target.system.hacking.methods.push(method("alternative"));
  await h.action("chooseMethod");
  assert.equal(h.dialog.context.choosingMethod, true);
  assert.equal(h.dialog.context.canChooseMethod, true);
  await h.action("selectMethod", { hackingMethod: "alternative" });
  assert.equal(h.dialog.context.choosingMethod, false);
  assert.equal(h.dialog.context.selectedMethodId, "alternative");
  await h.action("chooseMethod");
  await h.action("showTools");
  assert.equal(h.dialog.context.choosingMethod, false);
  assert.equal(h.dialog.context.selectedMethodId, "alternative");
  await h.dialog.close();
});

test("double click rolls once, displays busy states, and confirmed failure keeps remaining attempts", async () => {
  let finishRoll;
  let rolls = 0;
  const pending = new Promise(resolve => { finishRoll = resolve; });
  const h = harness({ roll: () => { rolls++; return pending; } });
  await h.dialog.render();
  const first = h.action("attemptHack");
  await h.action("attemptHack");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rolls, 1);
  assert.equal(h.dialog.context.hackDisabled, true);
  finishRoll({ result: { key: "failure" } });
  await first;
  assert.equal(h.dialog.context.attemptsRemaining, 2);
  assert.equal(h.dialog.context.feedback.title, "Замок не поддался");
  assert.equal(h.dialog.context.hackDisabled, false);
  assert.ok(h.dialog.contexts.some(context => context.actionLabel === "Применение результата…"));
  await h.dialog.close();
});

test("cancelled roll and failed confirmation always clear busy state without retrying", async () => {
  const cancelled = harness({ roll: async () => null });
  await cancelled.dialog.render();
  await cancelled.action("attemptHack");
  assert.equal(cancelled.dialog.context.busy, false);
  assert.equal(cancelled.dialog.context.attemptsRemaining, 3);
  assert.equal(cancelled.dialog.context.feedback.title, "Проверка отменена");
  await cancelled.dialog.close();
  let applies = 0;
  const failed = harness({ apply: async () => { applies++; throw new Error("Нет ответа"); } });
  await failed.dialog.render();
  await failed.action("attemptHack");
  assert.equal(applies, 1);
  assert.equal(failed.dialog.context.busy, false);
  assert.equal(failed.dialog.context.feedback.text, "Нет ответа");
  await failed.dialog.close();
});

test("closing during a pending attempt removes hooks and never reopens the dialog", async () => {
  let finishRoll;
  let applies = 0;
  const pending = new Promise(resolve => { finishRoll = resolve; });
  const h = harness({ roll: () => pending, apply: async () => { applies++; return { unlocked: false, methods: [method()] }; } });
  await h.dialog.render();
  const operation = h.action("attemptHack");
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(h.hooks.size > 0);
  await h.dialog.close();
  const renders = h.dialog.contexts.length;
  finishRoll({ result: { key: "failure" } });
  await operation;
  assert.equal(applies, 1);
  assert.equal(h.hooks.size, 0);
  assert.equal(h.dialog.contexts.length, renders);
});

test("success closes the window; relevant inventory updates refresh but unrelated updates do not", async () => {
  const h = harness({ apply: async () => ({ unlocked: true, methods: [method()] }) });
  await h.dialog.render();
  const renders = h.dialog.contexts.length;
  const updateItem = Array.from(h.hooks.values()).find(hook => hook.name === "updateItem").fn;
  updateItem({ parent: { uuid: "Actor.other" } });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(h.dialog.contexts.length, renders);
  h.actor.items.contents[0].functions[0].resource.value = 20;
  updateItem({ parent: h.actor });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(h.dialog.context.selectedTool.supplyValue, 20);
  await h.action("attemptHack");
  assert.equal(h.dialog.closed, true);
  assert.equal(h.hooks.size, 0);
});
