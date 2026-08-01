import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { addManagedEventListener } from "../src/apps/combat-carousel/managed-event-listener.mjs";

const combatDockSource = await readFile(
    new URL("../src/apps/combat-carousel/combat-dock.mjs", import.meta.url),
    "utf8"
);
const combatCarouselSource = await readFile(
    new URL("../src/apps/combat-carousel.mjs", import.meta.url),
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

test("CombatDock awaits and deduplicates end-combat operations", () => {
    assert.match(
        combatDockSource,
        /case "end-combat":\s*await this\._runTurnNavigation\(\(\) => this\.combat\?\.endCombat\(\)\)/
    );
    assert.match(combatDockSource, /'\[data-action="end-combat"\]'/);
});

test("CombatDock cancels delayed work and animations when it is replaced", () => {
    assert.match(combatDockSource, /for \(const timeoutId of this\._timeouts\) globalThis\.clearTimeout\(timeoutId\)/);
    assert.match(combatDockSource, /for \(const animation of this\._animations\) animation\.cancel\?\.\(\)/);
    assert.equal(
        combatDockSource.match(/globalThis\.setTimeout\(/gu)?.length,
        1,
        "all dock timers must use the lifecycle-owned scheduler"
    );
});

test("canvas transitions retain at most one pending tracker hook and one dock", () => {
    assert.match(combatCarouselSource, /clearPendingCombatTrackerRenderHook\(\)/);
    assert.match(combatCarouselSource, /Hooks\.off\("renderCombatTracker", pendingCombatTrackerRenderHookId\)/);
    assert.match(combatCarouselSource, /Hooks\.on\("canvasTearDown"/);
    assert.match(combatCarouselSource, /current\?\.combat === combat && !current\._closed/);
});

test("CombatDock ignores combat and combatant hooks owned by another combat", () => {
    assert.match(
        combatCarouselSource,
        /if \(combat !== ui\.combatDock\?\.combat && combat !== getCurrentCombat\(\)\) return;/
    );
    assert.match(combatDockSource, /_onCombatTurn\(combat, updates, update\) \{\s*if \(combat !== this\.combat\) return;/);
    assert.match(combatDockSource, /_onCombatStart\(combat\) \{\s*if \(combat !== this\.combat\) return;/);
    assert.match(combatDockSource, /_onDeleteCombat\(combat\) \{\s*if \(combat !== this\.combat\) return;/);
    assert.match(combatDockSource, /_onRenderCombatTracker\(combatTracker\) \{\s*if \(combatTracker\?\.viewed && combatTracker\.viewed !== this\.combat\) return;/);
    assert.match(combatDockSource, /updateCombatant\(combatant, updates = \{\}\) \{\s*if \(combatant\?\.parent !== this\.combat\) return;/);
    assert.match(combatDockSource, /_onCreateCombatant\(combatant\) \{\s*if \(combatant\?\.parent !== this\.combat\) return;/);
    assert.match(combatDockSource, /_onDeleteCombatant\(combatant\) \{\s*if \(combatant\?\.parent !== this\.combat\) return;/);
    assert.match(combatDockSource, /hook: "createCombatant",\s*fn: this\._onCreateCombatant\.bind\(this\)/);
    assert.match(combatDockSource, /hook: "deleteCombatant",\s*fn: this\._onDeleteCombatant\.bind\(this\)/);
    assert.doesNotMatch(combatDockSource, /fn: this\.setupCombatants\.bind\(this\)/);
});

test("an old asynchronous close preserves the rendered replacement Application registration", () => {
    assert.match(
        combatDockSource,
        /finally \{\s*this\._restoreReplacementApplicationRegistration\(\);/
    );
    assert.match(
        combatDockSource,
        /replacement\?\.id !== this\.id[\s\S]*replacement\?\._closed[\s\S]*!replacement\?\.rendered/
    );
    assert.match(
        combatDockSource,
        /if \(instances\.get\(this\.id\) !== replacement\) instances\.set\(this\.id, replacement\);/
    );
});
