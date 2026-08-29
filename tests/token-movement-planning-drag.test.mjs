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
    randomID: () => "test-id",
    deepClone: value => structuredClone(value),
    mergeObject: (original, other) => ({ ...structuredClone(original), ...structuredClone(other) }),
    escapeHTML: value => String(value),
    cleanHTML: value => String(value)
  }
};

globalThis.game = {
  user: { id: "test-user" },
  i18n: {
    has: () => false,
    localize: key => String(key),
    format: (key, data = {}) => `${key}:${JSON.stringify(data)}`
  }
};

const {
  clearAbilityRoutePreviewBudget,
  setAbilityRoutePreviewBudget
} = await import("../src/canvas/ability-route-preview-state.mjs");
const {
  FalloutMaWToken,
  buildEffectTooltipHTML
} = await import("../src/canvas/token.mjs");

test("effect tooltip displays universal barrier points without treating them as an actor bonus", () => {
  const html = buildEffectTooltipHTML({
    name: "Каменная кожа",
    img: "icons/svg/aura.svg",
    flags: {},
    system: {
      changes: [{
        key: "system.damageBarriers.all",
        type: "add",
        value: "58"
      }]
    }
  });

  assert.match(html, /Барьер: От всех видов урона/);
  assert.match(html, /<span>58<\/span>/);
  assert.doesNotMatch(html, /<span>\+58<\/span>/);
});

test("effect tooltip renders attack critical-failure disabling as a state instead of +1", () => {
  const previousLocalize = game.i18n.localize;
  game.i18n.localize = key => ({
    "FALLOUTMAW.Effects.AttackCriticalFailureDisabled": "Критический провал на атаки (в мою сторону)",
    "FALLOUTMAW.Effects.DisabledChangeValue": "Отключение"
  })[key] ?? String(key);
  try {
    const html = buildEffectTooltipHTML({
      name: "Охотничьи угодья: Добыча · Мишень ×2",
      img: "icons/svg/target.svg",
      flags: {},
      system: {
        changes: [{
          key: "system.combat.attackCriticalFailureDisabled",
          type: "add",
          value: "1",
          phase: "initial"
        }]
      }
    });

    assert.match(html, /Критический провал на атаки \(в мою сторону\):/);
    assert.match(html, /<span>Отключение<\/span>/);
    assert.doesNotMatch(html, /<span>\+1<\/span>/);
  } finally {
    game.i18n.localize = previousLocalize;
  }
});

test("effect tooltip displays trauma and disease suppression changes", () => {
  const html = buildEffectTooltipHTML({
    name: "Просто царапины",
    img: "icons/svg/aura.svg",
    system: {
      changes: [{
        key: "fallout-maw.suppression.traumas.count",
        type: "add",
        value: "2.8"
      }, {
        key: "fallout-maw.suppression.diseases.all",
        type: "add",
        value: "1"
      }]
    },
    flags: {}
  });

  assert.match(html, /Травмы: подавить случайные/);
  assert.match(html, /Болезни: подавить все/);
  assert.match(html, /<span>\+2<\/span>/);
  assert.match(html, /<span>\+1<\/span>/);
});

test("effect tooltip marks an actually suppressed trauma", () => {
  const trauma = { id: "trauma-1", type: "trauma" };
  const traumaEffect = {
    id: "trauma-effect",
    name: "Огнестрельное ранение туловища",
    img: "icons/svg/blood.svg",
    parent: trauma,
    system: { changes: [] },
    flags: {}
  };
  const suppressionEffect = {
    id: "suppression-effect",
    uuid: "Actor.Target.ActiveEffect.Suppression",
    parent: { type: "actor" },
    system: {
      changes: [{
        key: "fallout-maw.suppression.traumas.count",
        type: "add",
        value: "1"
      }]
    }
  };
  const actor = {
    id: "target",
    uuid: "Actor.Target",
    itemTypes: { trauma: [trauma], disease: [] },
    effects: [suppressionEffect]
  };
  const previousLocalize = game.i18n.localize;
  game.i18n.localize = key => key === "FALLOUTMAW.Effects.Suppressed"
    ? "Подавлено"
    : previousLocalize(key);
  try {
    const html = buildEffectTooltipHTML(traumaEffect, actor);
    assert.match(html, /Огнестрельное ранение туловища \(Подавлено\)/);
  } finally {
    game.i18n.localize = previousLocalize;
  }
});

test("effect tooltip exposes a condition-triggering aura stored by the Active Effect", () => {
  const html = buildEffectTooltipHTML({
    name: "Блокада",
    img: "icons/svg/aura.svg",
    duration: { label: "18 с" },
    system: { changes: [] },
    flags: {
      "fallout-maw": {
        activeApplication: {
          functionData: {
            type: "activeApplication",
            conditions: [{
              type: "aura",
              auraMode: "triggerConditions",
              auraTargetGroups: ["enemy", "neutral"],
              auraRadiusMeters: "4+resilience/20",
              auraRepeatSeconds: 6
            }]
          }
        }
      }
    }
  });

  assert.match(html, /Аура/);
  assert.match(html, /враги, нейтралы/);
  assert.match(html, /не чаще раза в 6 с/);
});

test("active application tooltip shows the source ability damage progress", () => {
  const previousFromUuidSync = globalThis.fromUuidSync;
  globalThis.fromUuidSync = uuid => uuid === "Actor.Doctor.Item.Care" ? {
    documentName: "Item",
    type: "ability",
    system: {
      functions: [{
        id: "patient-reward",
        type: "effectChanges",
        changes: [],
        conditions: [{
          id: "patient-damage",
          type: "eventReaction",
          eventKey: "fallout-maw.damage.resolved",
          progressRequired: 200,
          trackingTargets: ["activeApplicationTarget"]
        }, {
          id: "unrelated-progress",
          type: "eventReaction",
          eventKey: "fallout-maw.research.progressed",
          progressRequired: 50,
          trackingTargets: ["owner"]
        }]
      }]
    },
    flags: {
      "fallout-maw": {
        eventReactionProgress: {
          "patient-reward_patient-damage": { current: 85 },
          "patient-reward_unrelated-progress": { current: 15 }
        }
      }
    }
  } : null;
  try {
    const html = buildEffectTooltipHTML({
      name: "Опекаемый пациент",
      img: "icons/svg/aura.svg",
      system: { changes: [] },
      flags: {
        "fallout-maw": {
          activeApplication: {
            sourceItemUuid: "Actor.Doctor.Item.Care",
            functionId: "patient-mark",
            functionData: { id: "patient-mark", type: "activeApplication" }
          }
        }
      }
    });

    assert.match(html, /Damage received/);
    assert.match(html, /85 \/ 200/);
    assert.doesNotMatch(html, /Research progress/);
    assert.doesNotMatch(html, /15 \/ 50/);

    const rewardHTML = buildEffectTooltipHTML({
      name: "Опекаемый пациент",
      img: "icons/svg/aura.svg",
      origin: "Actor.Doctor.Item.Care",
      duration: { label: "6 с" },
      system: { changes: [] },
      flags: {
        "fallout-maw": {
          eventReaction: {
            sourceItemUuid: "Actor.Doctor.Item.Care",
            functionId: "patient-reward"
          }
        }
      }
    });
    assert.doesNotMatch(rewardHTML, /Damage received/);
    assert.doesNotMatch(rewardHTML, /85 \/ 200/);
  } finally {
    globalThis.fromUuidSync = previousFromUuidSync;
  }
});

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
  assert.equal(manager.interactionData.released, true);
  assert.equal(manager.state, dragStates.DRAG);
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
