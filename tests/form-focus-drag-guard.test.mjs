import assert from "node:assert/strict";
import test from "node:test";

let moduleSequence = 0;

test("form focus drag guard preserves native clicks and blocks only the cross-field release", async t => {
  await t.test("an ordinary click does not cancel the event or move the caret", async () => {
    const harness = await createHarness();
    const input = harness.createInput("ordinary", "0123456789");
    harness.document.activeElement = input;
    input.setSelectionRange(6, 6);

    const down = harness.fire("pointerdown", input, {
      button: 0,
      pointerId: 1,
      clientX: 10,
      clientY: 10
    });

    // Model the browser's native caret placement after the press. The guard
    // must leave this position alone for the rest of an ordinary click.
    input.setSelectionRange(3, 3);
    const up = harness.fire("pointerup", input, {
      button: 0,
      pointerId: 1,
      clientX: 10,
      clientY: 10
    });
    const click = harness.fire("click", input, {
      button: 0,
      clientX: 10,
      clientY: 10
    });

    assert.equal(down.defaultPrevented, false);
    assert.equal(up.defaultPrevented, false);
    assert.equal(click.defaultPrevented, false);
    assert.equal(click.immediatePropagationStopped, false);
    assert.equal(harness.document.activeElement, input);
    assert.deepEqual(input.selection, {
      start: 3,
      end: 3,
      direction: "none"
    });
    assert.equal(input.focusCalls.length, 0);
  });

  await t.test("releasing a text-selection drag over another field does not activate it", async () => {
    const harness = await createHarness();
    const source = harness.createInput("source", "source text");
    const target = harness.createInput("target", "target text");
    harness.document.activeElement = source;
    source.setSelectionRange(2, 8, "forward");

    harness.fire("pointerdown", source, {
      button: 0,
      pointerId: 2,
      clientX: 10,
      clientY: 10
    });
    harness.fire("pointermove", source, {
      button: 0,
      pointerId: 2,
      clientX: 40,
      clientY: 10
    });
    harness.document.pointedElement = target;
    const up = harness.fire("pointerup", source, {
      button: 0,
      pointerId: 2,
      clientX: 40,
      clientY: 10
    });
    const click = harness.fire("click", target, {
      button: 0,
      clientX: 40,
      clientY: 10
    });

    assert.equal(up.defaultPrevented, true);
    assert.equal(click.defaultPrevented, true);
    assert.equal(click.immediatePropagationStopped, true);
    assert.equal(harness.document.activeElement, source);
    assert.deepEqual(source.selection, {
      start: 2,
      end: 8,
      direction: "forward"
    });
    assert.equal(target.focusCalls.length, 0);
  });

  await t.test("a fresh press is not swallowed by stale suppression from an earlier drag", async () => {
    const harness = await createHarness();
    const source = harness.createInput("source", "source text");
    const target = harness.createInput("target", "target text");
    harness.document.activeElement = source;
    source.setSelectionRange(1, 7, "forward");

    harness.fire("pointerdown", source, {
      button: 0,
      pointerId: 3,
      clientX: 10,
      clientY: 10
    });
    harness.fire("pointermove", source, {
      button: 0,
      pointerId: 3,
      clientX: 40,
      clientY: 10
    });
    harness.document.pointedElement = target;
    const dragRelease = harness.fire("pointerup", source, {
      button: 0,
      pointerId: 3,
      clientX: 40,
      clientY: 10
    });
    assert.equal(dragRelease.defaultPrevented, true);

    // A cross-element press/release does not have to produce a click. Before
    // the guard's short suppression timeout expires, begin a genuinely new
    // click on the target field.
    const freshDown = harness.fire("pointerdown", target, {
      button: 0,
      pointerId: 4,
      clientX: 40,
      clientY: 10
    });
    harness.document.activeElement = target;
    target.setSelectionRange(6, 6);
    const freshUp = harness.fire("pointerup", target, {
      button: 0,
      pointerId: 4,
      clientX: 40,
      clientY: 10
    });
    const freshClick = harness.fire("click", target, {
      button: 0,
      clientX: 40,
      clientY: 10
    });

    assert.equal(freshDown.defaultPrevented, false);
    assert.equal(freshUp.defaultPrevented, false);
    assert.equal(freshClick.defaultPrevented, false);
    assert.equal(freshClick.immediatePropagationStopped, false);
    assert.equal(harness.document.activeElement, target);
    assert.deepEqual(target.selection, {
      start: 6,
      end: 6,
      direction: "none"
    });
    assert.equal(source.focusCalls.length, 0);
  });

  await t.test("an unmatched release cannot suppress a later activation", async () => {
    const harness = await createHarness();
    const source = harness.createInput("source", "source text");
    const target = harness.createInput("target", "target text");
    harness.document.activeElement = source;

    harness.fire("pointerdown", source, {
      button: 0,
      pointerId: 5,
      clientX: 10,
      clientY: 10
    });
    harness.fire("pointermove", source, {
      button: 0,
      pointerId: 5,
      clientX: 40,
      clientY: 10
    });
    harness.document.pointedElement = target;
    harness.fire("pointerup", source, {
      button: 0,
      pointerId: 5,
      clientX: 40,
      clientY: 10
    });

    harness.flushTimeouts();
    const laterClick = harness.fire("click", target, {
      button: 0,
      clientX: 40,
      clientY: 10
    });

    assert.equal(laterClick.defaultPrevented, false);
    assert.equal(laterClick.immediatePropagationStopped, false);
  });
});

async function createHarness() {
  globalThis.Node = { ELEMENT_NODE: 1 };

  const document = new FakeDocument();
  const scheduledTimeouts = new Map();
  let timeoutSequence = 0;
  globalThis.document = document;
  globalThis.window = {
    setTimeout(callback) {
      timeoutSequence += 1;
      scheduledTimeouts.set(timeoutSequence, callback);
      return timeoutSequence;
    },
    clearTimeout(id) {
      scheduledTimeouts.delete(id);
    }
  };
  document.defaultView = globalThis.window;

  moduleSequence += 1;
  const module = await import(`../src/utils/form-focus-drag-guard.mjs?test=${moduleSequence}`);
  module.registerFormFocusDragGuard(document);

  return {
    document,
    createInput(name, value) {
      const input = new FakeElement({
        document,
        parent: document.scope,
        tagName: "INPUT",
        type: "text",
        name,
        value
      });
      document.controls.push(input);
      return input;
    },
    fire(type, target, overrides = {}) {
      return document.fire(type, target, overrides);
    },
    flushTimeouts() {
      const callbacks = Array.from(scheduledTimeouts.values());
      scheduledTimeouts.clear();
      for (const callback of callbacks) callback();
    }
  };
}

class FakeDocument {
  constructor() {
    this.listeners = new Map();
    this.documentElement = {
      dataset: {}
    };
    this.scope = new FakeElement({
      document: this,
      className: "fallout-maw"
    });
    this.controls = [];
    this.activeElement = null;
    this.pointedElement = null;
    this.defaultView = null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  elementFromPoint() {
    return this.pointedElement;
  }

  fire(type, target, overrides = {}) {
    const event = {
      type,
      target,
      currentTarget: this,
      button: 0,
      pointerId: 1,
      clientX: Number.NaN,
      clientY: Number.NaN,
      defaultPrevented: false,
      immediatePropagationStopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopImmediatePropagation() {
        this.immediatePropagationStopped = true;
      },
      ...overrides
    };
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
      if (event.immediatePropagationStopped) break;
    }
    return event;
  }
}

class FakeElement {
  constructor({
    document,
    parent = null,
    tagName = "DIV",
    className = "",
    type = "",
    name = "",
    value = ""
  }) {
    this.nodeType = 1;
    this.ownerDocument = document;
    this.parentElement = parent;
    this.tagName = tagName;
    this.className = className;
    this.type = type;
    this.name = name;
    this.value = value;
    this.disabled = false;
    this.readOnly = false;
    this.isConnected = true;
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.selectionDirection = "none";
    this.focusCalls = [];
  }

  closest(selector) {
    for (let current = this; current; current = current.parentElement) {
      if (current.matches(selector)) return current;
    }
    return null;
  }

  matches(selector) {
    if (selector === ".fallout-maw, [class*='fallout-maw-']") {
      return String(this.className).split(/\s+/).includes("fallout-maw")
        || String(this.className).includes("fallout-maw-");
    }
    if (this.tagName === "INPUT" && selector.includes("input:not([type='hidden'])")) {
      if (this.type === "hidden") return false;
      const excludedTypes = Array.from(
        selector.matchAll(/:not\(\[type='([^']+)'\]\)/g),
        match => match[1]
      );
      return !excludedTypes.includes(this.type);
    }
    return this.tagName === "TEXTAREA" && selector.includes("textarea");
  }

  contains(other) {
    for (let current = other; current; current = current.parentElement) {
      if (current === this) return true;
    }
    return false;
  }

  focus(options) {
    this.focusCalls.push(options);
    this.ownerDocument.activeElement = this;
  }

  setSelectionRange(start, end, direction = "none") {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction;
  }

  get selection() {
    return {
      start: this.selectionStart,
      end: this.selectionEnd,
      direction: this.selectionDirection
    };
  }
}
