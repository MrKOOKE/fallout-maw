import assert from "node:assert/strict";
import test from "node:test";

class ApplicationV2 {}
const HandlebarsApplicationMixin = Base => class extends Base {};

globalThis.foundry = {
  applications: {
    api: {
      ApplicationV2,
      DialogV2: {},
      HandlebarsApplicationMixin
    },
    apps: {
      FilePicker: {
        implementation: class FilePicker {}
      }
    },
    handlebars: {
      renderTemplate: async () => ""
    },
    sheets: {
      ActorSheetV2: class ActorSheetV2 {},
      ItemSheetV2: class ItemSheetV2 {}
    },
    ux: {
      FormDataExtended: class FormDataExtended {},
      TextEditor: {
        implementation: {}
      }
    }
  },
  canvas: {
    placeables: {
      Token: class Token {}
    }
  },
  utils: {
    deepClone: value => structuredClone(value),
    mergeObject: (target, source) => ({ ...target, ...source }),
    randomID: createIdFactory()
  }
};
globalThis.CONFIG = {};
globalThis.Actor = class Actor {};
globalThis.Item = class Item {};
globalThis.ActiveEffect = class ActiveEffect {};
globalThis.Application = ApplicationV2;

const hooks = createHookHarness();
globalThis.Hooks = hooks.api;
globalThis.game = {
  settings: {
    get() {
      return null;
    }
  },
  i18n: {
    format: key => key,
    localize: key => key
  },
  user: {}
};

const {
  WeaponAttackController
} = await import("../src/combat/weapon-attack-controller.mjs");
const {
  getActiveCanvasTargetSelectionSession,
  startCanvasTargetSelectionSession
} = await import("../src/canvas/target-selection-lifecycle.mjs");

test("a reusable weapon selector releases, resumes and reclaims one lifecycle owner", () => {
  const documentTarget = createEventTarget();
  const stage = createEmitter();
  const ticker = createEmitter();
  const baseContextMenu = () => undefined;
  const view = {
    oncontextmenu: baseContextMenu
  };
  globalThis.document = documentTarget;
  globalThis.canvas = {
    stage,
    app: {
      ticker,
      view
    }
  };

  const controller = Object.create(WeaponAttackController.prototype);
  Object.assign(controller, {
    actionKey: "shot",
    attackCanceledByReaction: false,
    attackModifier: null,
    destroyed: false,
    events: {
      cancel() {},
      itemUpdate() {},
      move() {},
      pointerDown() {},
      tick() {}
    },
    finishAfterAttack: false,
    finishRequested: false,
    interactiveHandlersAttached: false,
    nestedTargetSelectionSuspended: false,
    previewSuppressed: false,
    processing: false,
    targetSelectionOutcome: null,
    targetSelectionSession: null,
    token: {
      actor: {
        uuid: "Actor.attacker"
      }
    },
    weapon: {
      uuid: "Actor.attacker.Item.weapon"
    }
  });
  controller.attachPreview = () => undefined;
  controller.syncWeaponNoisePreview = () => true;
  controller.suppressPreview = function suppressPreview() {
    this.previewSuppressed = true;
  };
  controller.resumePreview = function resumePreview() {
    this.previewSuppressed = false;
  };
  controller.abortSkillCheckCollectors = async () => undefined;
  controller.canContinueAfterProcessing = () => true;
  controller.destroy = function destroy() {
    if (this.destroyed) return;
    this.finishTargetSelection();
    this.detachInteractiveHandlers();
    this.destroyed = true;
  };

  let replacement = null;
  try {
    assert.equal(controller.activate(), true);
    const initialSession = controller.targetSelectionSession;
    assert.equal(initialSession.active, true);
    assert.equal(controller.interactiveHandlersAttached, true);
    assert.equal(view.oncontextmenu, controller.events.cancel);

    assert.equal(controller.suspendForNestedTargetSelection(), true);
    assert.equal(initialSession.finished, true);
    assert.equal(initialSession.outcome.cancelled, false);
    assert.equal(initialSession.outcome.reason, "nestedSelectionSuspended");
    assert.equal(controller.destroyed, false);
    assert.equal(controller.interactiveHandlersAttached, false);
    assert.equal(view.oncontextmenu, baseContextMenu);

    const nested = startCanvasTargetSelectionSession({ kind: "nestedAttack" });
    assert.equal(controller.resumeFromNestedTargetSelection(), false);
    assert.equal(nested.active, true);
    assert.equal(controller.interactiveHandlersAttached, false);
    nested.finish();

    assert.equal(controller.resumeFromNestedTargetSelection(), true);
    const resumedSession = controller.targetSelectionSession;
    assert.notEqual(resumedSession, initialSession);
    assert.equal(resumedSession.active, true);
    assert.equal(controller.interactiveHandlersAttached, true);
    assert.equal(controller.previewSuppressed, false);

    // A reusable attack releases ownership while resolving a shot, then claims
    // a fresh session only when it becomes interactive again.
    controller.finishTargetSelection({ reason: "processing" });
    controller.processing = true;
    assert.equal(controller.completeProcessingCycle(), false);
    const postShotSession = controller.targetSelectionSession;
    assert.notEqual(postShotSession, resumedSession);
    assert.equal(postShotSession.active, true);

    // A reaction can nest while the original attack is still resolving. Its
    // canvas listeners stay detached until the original becomes interactive.
    controller.finishTargetSelection({ reason: "processing" });
    controller.processing = true;
    assert.equal(controller.suspendForNestedTargetSelection(), true);
    const nestedReaction = startCanvasTargetSelectionSession({ kind: "reactionAttack" });
    nestedReaction.finish();
    assert.equal(controller.resumeFromNestedTargetSelection(), true);
    assert.equal(controller.interactiveHandlersAttached, false);
    assert.equal(controller.completeProcessingCycle(), false);
    assert.equal(controller.interactiveHandlersAttached, true);
    assert.equal(controller.targetSelectionSession.active, true);

    replacement = startCanvasTargetSelectionSession({ kind: "repairTarget" });
    assert.equal(replacement.active, true);
    assert.equal(controller.destroyed, true);
    assert.equal(controller.interactiveHandlersAttached, false);
    assert.equal(getActiveCanvasTargetSelectionSession(), replacement);
  } finally {
    replacement?.finish();
    controller.destroy();
    delete globalThis.canvas;
    delete globalThis.document;
  }

  assert.equal(stage.listenerCount(), 0);
  assert.equal(ticker.listenerCount(), 0);
  assert.equal(documentTarget.listenerCount(), 0);
  assert.equal(hooks.listenerCount(), 0);
});

function createIdFactory() {
  let id = 0;
  return () => `weapon-selection-${++id}`;
}

function createEventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, callback) {
      const entries = listeners.get(type) ?? new Set();
      entries.add(callback);
      listeners.set(type, entries);
    },
    removeEventListener(type, callback) {
      listeners.get(type)?.delete(callback);
      if (!listeners.get(type)?.size) listeners.delete(type);
    },
    listenerCount() {
      let count = 0;
      for (const entries of listeners.values()) count += entries.size;
      return count;
    }
  };
}

function createEmitter() {
  const listeners = new Map();
  return {
    add(callback) {
      listeners.set(callback, callback);
    },
    remove(callback) {
      listeners.delete(callback);
    },
    on(event, callback) {
      listeners.set(`${event}:${listeners.size}`, callback);
    },
    off(event, callback) {
      for (const [key, entry] of listeners) {
        if (key.startsWith(`${event}:`) && entry === callback) listeners.delete(key);
      }
    },
    listenerCount() {
      return listeners.size;
    }
  };
}

function createHookHarness() {
  let nextId = 0;
  const listeners = new Map();
  const api = {
    on(hook, callback) {
      const id = ++nextId;
      const entries = listeners.get(hook) ?? new Map();
      entries.set(id, callback);
      listeners.set(hook, entries);
      return id;
    },
    off(hook, callbackOrId) {
      const entries = listeners.get(hook);
      if (!entries) return;
      if (typeof callbackOrId === "function") {
        for (const [id, callback] of entries) {
          if (callback === callbackOrId) entries.delete(id);
        }
      } else {
        entries.delete(callbackOrId);
      }
      if (!entries.size) listeners.delete(hook);
    },
    callAll(hook, ...args) {
      for (const callback of listeners.get(hook)?.values() ?? []) callback(...args);
    }
  };
  return {
    api,
    listenerCount() {
      let count = 0;
      for (const entries of listeners.values()) count += entries.size;
      return count;
    }
  };
}
