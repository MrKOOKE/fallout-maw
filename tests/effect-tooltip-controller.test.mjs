import assert from "node:assert/strict";
import test from "node:test";
import {
  EffectTooltipController,
  getHorizontalTooltipDirection
} from "../src/canvas/effect-tooltip-controller.mjs";

test("horizontal effect tooltip direction keeps content inside the viewport", () => {
  assert.equal(getHorizontalTooltipDirection({
    anchorRect: { left: 40, right: 60 },
    viewportWidth: 1200,
    tooltipWidth: 460,
    preferredDirection: "LEFT"
  }), "RIGHT");
  assert.equal(getHorizontalTooltipDirection({
    anchorRect: { left: 900, right: 920 },
    viewportWidth: 1200,
    tooltipWidth: 360,
    preferredDirection: "RIGHT"
  }), "LEFT");
  assert.equal(getHorizontalTooltipDirection({
    anchorRect: { left: 620, right: 640 },
    viewportWidth: 1000,
    tooltipWidth: 460,
    preferredDirection: "LEFT"
  }), "LEFT");
});

test("canvas effect tooltip shares callback functions and renders only after a sustained hover", async t => {
  const environment = installEnvironment();
  t.after(environment.restore);
  let renders = 0;
  const controller = new EffectTooltipController({
    activationDelay: 15,
    deactivationDelay: 0,
    renderHTML: effect => {
      renders += 1;
      return `<strong>${effect.name}</strong>`;
    }
  });
  const firstSource = createEventSource();
  const secondSource = createEventSource();
  const first = createIcon({ parent: firstSource });
  const second = createIcon({ x: 700, parent: firstSource });
  const third = createIcon({ x: 900, parent: secondSource });
  const token = { actor: { id: "actor" } };
  controller.bindCanvasIcon(first, { token, effect: { name: "First" } });
  controller.bindCanvasIcon(second, { token, effect: { name: "Second" } });
  controller.bindCanvasIcon(third, { token, effect: { name: "Third" } });

  assert.equal(first.eventMode, "static");
  assert.equal(firstSource.handlers.size, 0, "the passive effects container must not own listeners");
  assert.equal(secondSource.handlers.size, 0);
  assert.equal(first.handlers.size, 3);
  assert.equal(first.handlers.get("pointerover"), second.handlers.get("pointerover"));
  assert.equal(first.handlers.get("pointerout"), second.handlers.get("pointerout"));

  first.emit("pointerover");
  assert.equal(renders, 0);
  first.emit("pointerout");
  await wait(25);
  assert.equal(renders, 0, "an abandoned hover must not build tooltip HTML");
  assert.equal(environment.activations.length, 0);

  first.emit("pointerover");
  controller.deactivateForToken(token);
  await wait(25);
  assert.equal(renders, 0, "a token redraw must cancel pending tooltip work");

  first.emit("pointerover");
  await wait(25);
  assert.equal(renders, 1);
  assert.equal(environment.activations.length, 1);
  assert.equal(environment.activations[0].options.direction, "RIGHT");
  assert.equal(environment.appendCount, 1);

  first.emit("pointerout");
  await wait(5);
  first.emit("pointerover");
  await wait(25);
  assert.equal(environment.appendCount, 1, "the synthetic anchor must be reused");
});

test("canvas effect tooltip clears stale content when rendering the next icon fails", async t => {
  const environment = installEnvironment();
  t.after(environment.restore);
  const originalWarn = console.warn;
  console.warn = () => undefined;
  t.after(() => { console.warn = originalWarn; });
  const controller = new EffectTooltipController({
    activationDelay: 0,
    deactivationDelay: 0,
    renderHTML: effect => {
      if (effect.name === "Broken") throw new Error("render failure");
      return `<strong>${effect.name}</strong>`;
    }
  });
  const source = createEventSource();
  const first = createIcon({ parent: source });
  const broken = createIcon({ x: 700, parent: source });
  const token = { actor: { id: "actor" } };
  controller.bindCanvasIcon(first, { token, effect: { name: "First" } });
  controller.bindCanvasIcon(broken, { token, effect: { name: "Broken" } });

  first.emit("pointerover");
  await wait(5);
  assert.equal(environment.activations.length, 1);
  assert.notEqual(environment.manager.element, null);

  broken.emit("pointerover");
  assert.equal(environment.activations.length, 1, "failed content must not reuse the old activation");
  assert.equal(environment.manager.element, null, "the stale tooltip must be deactivated");
  assert.equal(environment.tooltip.active, false);
});

test("sheet effect tooltip resolves and renders only after Foundry activates its singleton", t => {
  const environment = installEnvironment();
  t.after(environment.restore);
  const actor = { uuid: "Actor.Test", effects: new Map(), items: new Map() };
  const effect = { uuid: "Actor.Test.ActiveEffect.Boost", target: actor, name: "Boost" };
  globalThis.fromUuidSync = uuid => ({
    "Actor.Test": actor,
    "Actor.Test.ActiveEffect.Boost": effect
  })[uuid] ?? null;
  let renders = 0;
  const controller = new EffectTooltipController({
    renderHTML: document => {
      renders += 1;
      return `<article>${document.name}</article>`;
    }
  });
  controller.observe();
  assert.equal(renders, 0);
  assert.equal(environment.observeOptions.attributeOldValue, true);

  const row = {
    dataset: {
      effectId: "Boost",
      effectUuid: effect.uuid,
      effectTooltipActorUuid: actor.uuid,
      effectParentItemId: ""
    }
  };
  const anchor = {
    dataset: {
      effectTooltip: "",
      effectTooltipFallback: effect.name,
      tooltipDirection: "LEFT"
    },
    closest: selector => selector === "[data-effect-id]" ? row : null,
    getBoundingClientRect: () => ({ left: 50, right: 70 })
  };
  environment.manager.element = anchor;
  environment.tooltip.active = true;
  environment.observer.trigger([{ type: "attributes", attributeName: "class", oldValue: "" }]);

  assert.equal(renders, 1);
  assert.equal(environment.tooltip.innerHTML, "clean:<article>Boost</article>");
  assert.equal(environment.positions.at(-1), "RIGHT");

  environment.observer.trigger([{
    type: "attributes",
    attributeName: "class",
    oldValue: "active fallout-maw-effect-tooltip text-left"
  }]);
  assert.equal(renders, 1, "Foundry positioning classes must not restart tooltip rendering");
});

function createIcon({ x = 40, y = 80, width = 20, height = 20, parent = createEventSource() } = {}) {
  const handlers = new Map();
  return {
    handlers,
    parent,
    on(type, handler) {
      handlers.set(type, handler);
      return this;
    },
    emit(type) {
      handlers.get(type)?.({
        currentTarget: this,
        target: this,
        nativeEvent: { clientX: x + 1, clientY: y + 1 }
      });
    },
    getBounds: () => ({ x, y, width, height })
  };
}

function createEventSource() {
  const handlers = new Map();
  return {
    handlers,
    on(type, handler) {
      handlers.set(type, handler);
      return this;
    }
  };
}

function installEnvironment() {
  const previous = Object.fromEntries([
    "canvas",
    "document",
    "foundry",
    "fromUuidSync",
    "game",
    "window"
  ].map(key => [key, globalThis[key]]));
  const activations = [];
  const positions = [];
  let appended = 0;

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      environment.observer = this;
    }

    observe(_target, options) { environment.observeOptions = options; }
    disconnect() {}
    trigger(records) { this.callback(records); }
  }

  const window = {
    innerWidth: 1200,
    innerHeight: 800,
    MutationObserver: FakeMutationObserver,
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame(callback) { callback(); }
  };
  const connected = new Set();
  const body = {
    append(element) {
      connected.add(element);
      appended += 1;
    },
    contains: element => connected.has(element)
  };
  const document = {
    body,
    defaultView: window,
    createElement() {
      return {
        ownerDocument: document,
        style: {},
        setAttribute() {},
        remove() { connected.delete(this); }
      };
    }
  };
  const view = {
    ownerDocument: document,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 })
  };
  document.elementFromPoint = () => view;
  const tooltip = {
    active: false,
    innerHTML: "",
    offsetWidth: 360,
    ownerDocument: document,
    classList: { contains: className => className === "active" && tooltip.active }
  };
  const manager = {
    element: null,
    tooltip,
    activate(element, options) {
      this.element = element;
      tooltip.active = true;
      activations.push({ element, options });
    },
    deactivate() {
      this.element = null;
      tooltip.active = false;
    },
    _setAnchor(direction) { positions.push(direction); }
  };
  const environment = {
    activations,
    manager,
    observeOptions: null,
    observer: null,
    positions,
    tooltip,
    get appendCount() { return appended; },
    restore() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    }
  };

  globalThis.window = window;
  globalThis.document = document;
  globalThis.canvas = { app: { view, renderer: { screen: { x: 0, y: 0, width: 1200, height: 800 } } } };
  globalThis.game = { tooltip: manager };
  globalThis.foundry = { utils: { cleanHTML: html => `clean:${html}` } };
  return environment;
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
