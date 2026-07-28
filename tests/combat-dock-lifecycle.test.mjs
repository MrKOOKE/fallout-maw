import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { addManagedEventListener } from "../src/apps/combat-carousel/managed-event-listener.mjs";

const combatDockSource = await readFile(
    new URL("../src/apps/combat-carousel/combat-dock.mjs", import.meta.url),
    "utf8"
);

class TrackedEventTarget {
    listeners = new Map();
    added = [];
    removed = [];

    addEventListener(type, listener, options) {
        this.added.push({ type, listener, options });
        this.listeners.set(type, listener);
    }

    removeEventListener(type, listener, options) {
        this.removed.push({ type, listener, options });
        if (this.listeners.get(type) === listener) this.listeners.delete(type);
    }

    dispatch(type) {
        this.listeners.get(type)?.();
    }
}

test("managed event listener removes the exact registered callback only once", () => {
    const target = new TrackedEventTarget();
    let resizeCalls = 0;
    const onResize = () => resizeCalls++;
    const cleanup = addManagedEventListener(target, "resize", onResize);

    assert.equal(target.added.length, 1);
    target.dispatch("resize");
    assert.equal(resizeCalls, 1);

    assert.equal(cleanup(), true);
    assert.equal(cleanup(), false);
    assert.equal(target.removed.length, 1);
    assert.strictEqual(target.removed[0].listener, target.added[0].listener);

    target.dispatch("resize");
    assert.equal(resizeCalls, 1);
});

test("managed event listener preserves the registration options for cleanup", () => {
    const target = new TrackedEventTarget();
    const listener = { handleEvent() {} };
    const options = { capture: true, passive: true };
    const cleanup = addManagedEventListener(target, "resize", listener, options);

    cleanup();

    assert.strictEqual(target.removed[0].options, options);
});

test("CombatDock owns and releases its global resize registration", () => {
    assert.match(
        combatDockSource,
        /this\._onWindowResize = this\.autosize\.bind\(this\);\s*this\._removeWindowResizeListener = addManagedEventListener\(window, "resize", this\._onWindowResize\);/
    );
    assert.match(
        combatDockSource,
        /this\._removeWindowResizeListener\?\.\(\);\s*this\._removeWindowResizeListener = null;\s*this\._onWindowResize = null;/
    );
    assert.doesNotMatch(combatDockSource, /removeEventListener\("resize", this\.autosize\.bind\(this\)\)/);
});
