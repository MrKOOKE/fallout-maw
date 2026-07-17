import assert from "node:assert/strict";
import test from "node:test";

const dragStates = Object.freeze({
  NONE: 0,
  HOVER: 1,
  CLICKED: 2,
  GRABBED: 3,
  DRAG: 4
});

let initializeSnapshot = null;

class FoundryTokenStub {
  constructor(document = {}) {
    this.document = document;
  }

  /** Model the relevant PlaceableObject and Token initialization semantics. */
  _initializeDragLeft(event) {
    initializeSnapshot = {
      controllableObjects: this.layer.options.controllableObjects,
      controlled: [...this.layer.controlled]
    };
    const objects = this.layer.options.controllableObjects ? this.layer.controlled : [this];
    const clones = objects.map(original => ({ _original: original }));
    event.interactionData.clones = clones;
    event.interactionData.contexts = Object.fromEntries(clones.map(clone => [
      clone._original.document.id,
      { token: clone._original }
    ]));
  }
}

let emulateMoveEvent = () => {};

globalThis.foundry = {
  applications: {
    apps: {
      FilePicker: { implementation: class FilePicker {} }
    },
    sheets: {
      ActorSheetV2: class ActorSheetV2 {},
      ItemSheetV2: class ItemSheetV2 {}
    },
    api: {
      ApplicationV2: class ApplicationV2 {},
      DialogV2: {},
      HandlebarsApplicationMixin: Base => class extends Base {}
    },
    ux: {
      FormDataExtended: class FormDataExtended {},
      TextEditor: { implementation: {} }
    },
    handlebars: { renderTemplate: async () => "" }
  },
  canvas: {
    interaction: {
      MouseInteractionManager: {
        emulateMoveEvent: () => emulateMoveEvent()
      }
    },
    placeables: {
      Token: FoundryTokenStub
    }
  },
  utils: {
    randomID: () => "test-id"
  }
};

globalThis.game = {
  user: { id: "test-user" }
};

const {
  clearAbilityRoutePreviewBudget,
  setAbilityRoutePreviewBudget
} = await import("../src/canvas/ability-route-preview-state.mjs");
const { FalloutMaWToken } = await import("../src/canvas/token.mjs");

function createToken(id = "executor") {
  const document = {
    id,
    uuid: `Scene.test.Token.${id}`
  };
  const token = new FalloutMaWToken(document);
  const controlled = new FoundryTokenStub({
    id: "activator",
    uuid: "Scene.test.Token.activator"
  });
  token.layer = {
    controlled: [controlled],
    options: { controllableObjects: true }
  };
  token.mouseInteractionManager = createMouseManager();
  setAbilityRoutePreviewBudget(token, { interactive: true });
  return { token, controlled };
}

function createMouseManager() {
  return {
    state: dragStates.NONE,
    states: dragStates,
    options: { dragResistance: 10 },
    interactionData: {
      screenOrigin: { x: 100, y: 100 }
    },
    lcTime: 0,
    cancelCalls: 0,
    cancel() {
      this.cancelCalls += 1;
      this.state = dragStates.NONE;
    },
    handleEvent(event) {
      if (event.type === "pointerover") this.state = dragStates.HOVER;
      else if (event.type === "pointerdown") this.state = dragStates.GRABBED;
    }
  };
}

function installCanvas() {
  const boundary = {
    createPointerEvent(_pointer, type, target) {
      return {
        type,
        target,
        path: null,
        nativeEvent: null,
        button: 0,
        buttons: 0,
        defaultPrevented: false
      };
    },
    freeEvent() {}
  };
  globalThis.canvas = {
    app: {
      renderer: {
        events: {
          pointer: {},
          rootBoundary: boundary
        }
      }
    }
  };
}

test("ability movement drag forces the executor singleton at delayed native initialization", () => {
  const { token, controlled } = createToken();
  const event = { interactionData: {} };
  initializeSnapshot = null;

  token._initializeDragLeft(event);

  assert.equal(initializeSnapshot.controllableObjects, false);
  assert.deepEqual(initializeSnapshot.controlled, [controlled]);
  assert.equal(event.interactionData.clones.length, 1);
  assert.equal(event.interactionData.clones[0]._original, token);
  assert.equal(event.interactionData.contexts[token.document.id].token, token);
  assert.equal(token.layer.options.controllableObjects, true);
  clearAbilityRoutePreviewBudget(token);
});

test("startMovementPlanningDrag waits for throttled native DRAG and accepts only its executor clone", async () => {
  installCanvas();
  const { token, controlled } = createToken();
  const manager = token.mouseInteractionManager;
  initializeSnapshot = null;
  let nativeInitializationFinished = false;

  emulateMoveEvent = () => {
    setTimeout(() => {
      token._initializeDragLeft({ interactionData: manager.interactionData });
      manager.state = dragStates.DRAG;
      nativeInitializationFinished = true;
    }, 20);
  };

  const pending = token.startMovementPlanningDrag();
  let settled = false;
  void pending.then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(settled, false);
  assert.equal(manager.state, dragStates.GRABBED);
  assert.equal(await pending, true);
  assert.equal(nativeInitializationFinished, true);
  assert.equal(initializeSnapshot.controllableObjects, false);
  assert.equal(manager.interactionData.clones.length, 1);
  assert.equal(manager.interactionData.clones[0]._original, token);
  assert.notEqual(manager.interactionData.clones[0]._original, controlled);
  assert.equal(manager.interactionData.contexts[token.document.id].token, token);
  assert.equal(token.layer.options.controllableObjects, true);
  assert.equal(manager.cancelCalls, 0);
  clearAbilityRoutePreviewBudget(token);
});

test("startMovementPlanningDrag rejects a DRAG initialized for another token", async () => {
  installCanvas();
  const { token, controlled } = createToken();
  const manager = token.mouseInteractionManager;

  emulateMoveEvent = () => {
    setTimeout(() => {
      manager.interactionData.clones = [{ _original: controlled }];
      manager.interactionData.contexts = {
        [token.document.id]: { token }
      };
      manager.state = dragStates.DRAG;
    }, 10);
  };

  assert.equal(await token.startMovementPlanningDrag(), false);
  assert.equal(manager.cancelCalls, 1);
  assert.equal(manager.state, dragStates.NONE);
  assert.equal(manager.interactionData.cancelled, true);
  clearAbilityRoutePreviewBudget(token);
});
