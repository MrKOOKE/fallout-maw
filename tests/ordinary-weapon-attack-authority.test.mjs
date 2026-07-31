import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

class ApplicationV2 {}
const HandlebarsApplicationMixin = Base => class extends Base {};

let randomId = 0;
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
    randomID: () => `ordinary-attack-${++randomId}`
  }
};
globalThis.CONFIG = { queries: {} };
globalThis.Actor = class Actor {};
globalThis.Item = class Item {};
globalThis.ActiveEffect = class ActiveEffect {};
globalThis.Application = ApplicationV2;
globalThis.Hooks = {
  callAll() {},
  off() {},
  on() {}
};

const warnings = [];
globalThis.ui = {
  notifications: {
    info() {},
    warn: message => warnings.push(message)
  }
};

const player = {
  id: "player",
  active: true,
  isGM: false,
  viewedLevel: "level",
  viewedScene: "scene",
  hasPermission: () => true
};
const gm = {
  id: "gm",
  active: true,
  isGM: true,
  viewedLevel: "level",
  viewedScene: "scene"
};
const emitted = [];
globalThis.game = {
  i18n: {
    format: key => key,
    localize: key => key
  },
  settings: {
    get: () => null
  },
  socket: {
    id: "player-socket",
    emit(_channel, payload) {
      emitted.push(payload);
    },
    on() {}
  },
  user: player,
  users: {
    activeGM: gm,
    contents: [player, gm],
    get: id => [player, gm].find(user => user.id === id)
  }
};

const {
  ORDINARY_WEAPON_ATTACK_TESTING,
  WeaponAttackController
} = await import("../src/combat/weapon-attack-controller.mjs");

test("a 100-projectile HUD attack uses one authenticated ticket and one authority operation", async () => {
  ORDINARY_WEAPON_ATTACK_TESTING.reset();
  emitted.length = 0;
  warnings.length = 0;
  const sourceDocument = createTokenDocument("source");
  const visibleDocument = createTokenDocument("visible");
  const irrelevantDocument = createTokenDocument("irrelevant");
  const sourceToken = createToken(sourceDocument, true);
  const visibleToken = createToken(visibleDocument, true);
  const irrelevantToken = createToken(irrelevantDocument, true);
  globalThis.canvas = {
    level: { id: "level" },
    scene: { id: "scene" },
    tokens: {
      placeables: [sourceToken, visibleToken, irrelevantToken]
    }
  };

  const queryCalls = [];
  gm.query = async (name, data, options) => {
    queryCalls.push({ name, data, options });
    return {
      ok: true,
      authoritySocketId: "gm-socket",
      operationId: data.selection.operationId,
      ticket: "authenticated-ticket"
    };
  };
  game.user = player;
  game.socket.id = "player-socket";
  const deliveryOptions = [];
  game.socket.emit = (_channel, payload, options) => {
    emitted.push(payload);
    deliveryOptions.push(options);
    if (payload.action !== "ordinaryAttackRequest") return;
    queueMicrotask(() => {
      assert.equal(ORDINARY_WEAPON_ATTACK_TESTING.settleResponse({
        action: "ordinaryAttackResult",
        authoritySocketId: "gm-socket",
        operationId: payload.operationId,
        senderUserId: gm.id,
        targetUserId: player.id,
        result: { ok: true, executed: true }
      }, player.id), false);
      ORDINARY_WEAPON_ATTACK_TESTING.settleResponse({
        action: "ordinaryAttackAccepted",
        authoritySocketId: "gm-socket",
        operationId: payload.operationId,
        senderUserId: gm.id,
        targetUserId: player.id
      }, gm.id);
      ORDINARY_WEAPON_ATTACK_TESTING.settleResponse({
        action: "ordinaryAttackResult",
        authoritySocketId: "gm-socket",
        operationId: payload.operationId,
        senderUserId: gm.id,
        targetUserId: player.id,
        result: {
          ok: true,
          executed: true,
          attackCheckCount: 100,
          canceledByReaction: false
        }
      }, gm.id);
    });
  };

  const controller = createAuthorityController({
    sourceToken,
    targets: [visibleToken],
    weapon: {
      uuid: "Actor.source.Item.weapon",
      system: {
        functions: [{
          id: "weapon",
          attack: {
            availableActions: {
              burst: true
            },
            pellets: 100
          }
        }]
      }
    }
  });
  let began = 0;
  let completed = 0;
  controller.beginProcessingCycle = function beginProcessingCycle() {
    began += 1;
    this.processing = true;
    return true;
  };
  controller.completeProcessingCycle = function completeProcessingCycle() {
    completed += 1;
    this.processing = false;
    return false;
  };

  assert.equal(await controller.executeOrdinaryAttackViaGm({ mode: "current" }), true);
  assert.equal(queryCalls.length, 1);
  assert.equal(queryCalls[0].name, ORDINARY_WEAPON_ATTACK_TESTING.queryName);
  assert.equal(queryCalls[0].options.timeout, 3000);
  assert.deepEqual(
    queryCalls[0].data.selection.visibleTokenUuids.sort(),
    [sourceDocument.uuid, visibleDocument.uuid, irrelevantDocument.uuid].sort()
  );
  assert.equal(emitted.filter(payload => payload.action === "ordinaryAttackRequest").length, 1);
  assert.deepEqual(deliveryOptions.find(Boolean), { recipients: [gm.id] });
  assert.equal(began, 1);
  assert.equal(completed, 1);
  assert.equal(controller.processing, false);
  assert.equal(controller.authorityExecutionSucceeded, true);
  assert.equal(controller.attackCheckCount, 100);
  assert.equal(warnings.length, 0);
});

test("a reusable player selector gets a unique execution operation while staying on one GM socket", async () => {
  ORDINARY_WEAPON_ATTACK_TESTING.reset();
  const sourceDocument = createTokenDocument("reused-source");
  const sourceToken = createToken(sourceDocument, true);
  globalThis.canvas = {
    level: { id: "level" },
    scene: { id: "scene" },
    tokens: {
      placeables: [sourceToken]
    }
  };
  game.user = player;
  game.socket.id = "player-socket";
  const queries = [];
  gm.query = async (_name, data) => {
    queries.push(data);
    return {
      ok: true,
      authoritySocketId: "sticky-gm-socket",
      operationId: data.selection.operationId,
      ticket: `ticket-${queries.length}`
    };
  };
  game.socket.emit = (_channel, payload) => {
    if (payload.action !== "ordinaryAttackRequest") return;
    queueMicrotask(() => {
      ORDINARY_WEAPON_ATTACK_TESTING.settleResponse({
        action: "ordinaryAttackProgress",
        authoritySocketId: payload.authoritySocketId,
        operationId: payload.operationId,
        senderUserId: gm.id,
        targetUserId: player.id
      }, gm.id);
      ORDINARY_WEAPON_ATTACK_TESTING.settleResponse({
        action: "ordinaryAttackResult",
        authoritySocketId: payload.authoritySocketId,
        operationId: payload.operationId,
        senderUserId: gm.id,
        targetUserId: player.id,
        result: {
          ok: true,
          executed: true,
          attackCheckCount: 1,
          canceledByReaction: false
        }
      }, gm.id);
    });
  };

  const controller = createAuthorityController({
    sourceToken,
    weapon: { uuid: "Actor.reused-source.Item.weapon" }
  });
  controller.beginProcessingCycle = function beginProcessingCycle() {
    this.processing = true;
    return true;
  };
  controller.completeProcessingCycle = function completeProcessingCycle() {
    this.processing = false;
    return false;
  };

  assert.equal(await controller.executeOrdinaryAttackViaGm({ mode: "current" }), true);
  assert.equal(await controller.executeOrdinaryAttackViaGm({ mode: "current" }), true);
  assert.equal(queries.length, 2);
  assert.notEqual(queries[0].selection.operationId, queries[1].selection.operationId);
  assert.equal(queries[0].selection.previewAttackId, controller.attackId);
  assert.equal(queries[1].selection.previewAttackId, controller.attackId);
  assert.equal(queries[0].preferredAuthoritySocketId, "");
  assert.equal(queries[1].preferredAuthoritySocketId, "sticky-gm-socket");
});

test("a rejected authority handshake always releases local processing", async () => {
  ORDINARY_WEAPON_ATTACK_TESTING.reset();
  const sourceDocument = createTokenDocument("source-reject");
  const sourceToken = createToken(sourceDocument, true);
  globalThis.canvas = {
    level: { id: "level" },
    scene: { id: "scene" },
    tokens: {
      placeables: [sourceToken]
    }
  };
  gm.query = async () => {
    throw new Error("query disconnected");
  };
  game.user = player;
  const controller = createAuthorityController({
    sourceToken,
    weapon: { uuid: "Actor.source-reject.Item.weapon" }
  });
  let completed = 0;
  controller.beginProcessingCycle = function beginProcessingCycle() {
    this.processing = true;
    return true;
  };
  controller.completeProcessingCycle = function completeProcessingCycle() {
    completed += 1;
    this.processing = false;
    return false;
  };
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    assert.equal(await controller.executeOrdinaryAttackViaGm({ mode: "current" }), false);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(completed, 1);
  assert.equal(controller.processing, false);
  assert.equal(controller.authorityExecutionSucceeded, false);
});

test("remote push and aimed lifecycle metadata is applied to the reusable player shell", async () => {
  ORDINARY_WEAPON_ATTACK_TESTING.reset();
  const sourceDocument = createTokenDocument("lifecycle-source");
  const sourceToken = createToken(sourceDocument, true);
  globalThis.canvas = {
    level: { id: "level" },
    scene: { id: "scene" },
    tokens: {
      placeables: [sourceToken]
    }
  };
  game.user = player;
  gm.query = async (_name, data) => ({
    ok: true,
    authoritySocketId: "lifecycle-gm-socket",
    operationId: data.selection.operationId,
    ticket: "lifecycle-ticket"
  });
  game.socket.emit = (_channel, payload) => {
    if (payload.action !== "ordinaryAttackRequest") return;
    queueMicrotask(() => {
      ORDINARY_WEAPON_ATTACK_TESTING.settleResponse({
        action: "ordinaryAttackAccepted",
        authoritySocketId: payload.authoritySocketId,
        operationId: payload.operationId,
        senderUserId: gm.id,
        targetUserId: player.id
      }, gm.id);
      ORDINARY_WEAPON_ATTACK_TESTING.settleResponse({
        action: "ordinaryAttackResult",
        authoritySocketId: payload.authoritySocketId,
        operationId: payload.operationId,
        senderUserId: gm.id,
        targetUserId: player.id,
        result: {
          ok: true,
          executed: true,
          attackCheckCount: 1,
          canceledByReaction: false,
          selectionCommitted: true,
          shouldFinish: true
        }
      }, gm.id);
    });
  };

  const controller = createAuthorityController({
    sourceToken,
    weapon: { uuid: "Actor.lifecycle-source.Item.weapon" }
  });
  controller.pushStrengthMaximum = 4;
  controller.finishRequested = false;
  let menuRemovals = 0;
  controller.removeLimbMenu = () => {
    menuRemovals += 1;
  };
  controller.beginProcessingCycle = function beginProcessingCycle() {
    this.processing = true;
    return true;
  };
  controller.completeProcessingCycle = function completeProcessingCycle() {
    this.processing = false;
    return false;
  };

  assert.equal(await controller.executeOrdinaryAttackViaGm({
    mode: "push",
    selectedStrength: 4
  }), true);
  assert.equal(controller.pushStrengthMaximum, 0);
  assert.equal(menuRemovals, 1);
  assert.equal(controller.finishRequested, true);
});

test("authenticated sender ownership cannot be forged in the authority payload", async () => {
  const sourceDocument = createTokenDocument("authority-source");
  const sourceActor = {
    uuid: "Actor.authority-source",
    testUserPermission: () => false
  };
  sourceDocument.actor = sourceActor;
  sourceDocument.object.actor = sourceActor;
  const weapon = {
    uuid: `${sourceActor.uuid}.Item.weapon`,
    parent: sourceActor
  };
  const documents = new Map([
    [sourceDocument.uuid, sourceDocument],
    [weapon.uuid, weapon]
  ]);
  globalThis.fromUuid = async uuid => documents.get(uuid) ?? null;
  globalThis.canvas = {
    level: { id: "level" },
    scene: { id: "scene" },
    tokens: {
      placeables: [sourceDocument.object]
    }
  };
  game.user = gm;
  game.users.activeGM = gm;

  const result = await ORDINARY_WEAPON_ATTACK_TESTING.executeSelection({
    requesterUserId: gm.id,
    operationId: "forged-request",
    previewAttackId: "preview-forged",
    tokenUuid: sourceDocument.uuid,
    weaponUuid: weapon.uuid,
    actionKey: "snapshot",
    weaponFunctionId: "weapon",
    pointer: { x: 300, y: 100, elevation: 0 },
    geometry: createGeometry(),
    visibleTokenUuids: [sourceDocument.uuid],
    mode: "current"
  }, player);

  assert.equal(result.ok, false);
  assert.equal(result.reason, "notOwner");
});

test("authority rejects a hidden target injected into the visibility snapshot", async () => {
  const sourceDocument = createTokenDocument("visibility-source");
  const hiddenDocument = createTokenDocument("hidden", { hidden: true });
  const sourceActor = {
    uuid: "Actor.visibility-source",
    testUserPermission: () => true
  };
  sourceDocument.actor = sourceActor;
  sourceDocument.object.actor = sourceActor;
  const weapon = {
    uuid: `${sourceActor.uuid}.Item.weapon`,
    parent: sourceActor
  };
  const documents = new Map([
    [sourceDocument.uuid, sourceDocument],
    [hiddenDocument.uuid, hiddenDocument],
    [weapon.uuid, weapon]
  ]);
  globalThis.fromUuid = async uuid => documents.get(uuid) ?? null;
  globalThis.canvas = {
    level: { id: "level" },
    scene: { id: "scene" },
    tokens: {
      placeables: [sourceDocument.object, hiddenDocument.object]
    }
  };
  game.user = gm;
  game.users.activeGM = gm;

  const result = await ORDINARY_WEAPON_ATTACK_TESTING.executeSelection({
    operationId: "hidden-injection",
    previewAttackId: "preview-hidden",
    tokenUuid: sourceDocument.uuid,
    weaponUuid: weapon.uuid,
    actionKey: "snapshot",
    weaponFunctionId: "weapon",
    pointer: { x: 300, y: 100, elevation: 0 },
    geometry: createGeometry(),
    visibleTokenUuids: [sourceDocument.uuid, hiddenDocument.uuid],
    mode: "current"
  }, player);

  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalidVisibility");
});

test("ticket selects one GM socket and repeated operationId reuses the cached result", async () => {
  ORDINARY_WEAPON_ATTACK_TESTING.reset();
  emitted.length = 0;
  const sourceDocument = createTokenDocument("ticket-source");
  const sourceActor = {
    uuid: "Actor.ticket-source",
    testUserPermission: () => false
  };
  sourceDocument.actor = sourceActor;
  sourceDocument.object.actor = sourceActor;
  const weapon = {
    uuid: `${sourceActor.uuid}.Item.weapon`,
    parent: sourceActor
  };
  let weaponResolutions = 0;
  globalThis.fromUuid = async uuid => {
    if (uuid === sourceDocument.uuid) return sourceDocument;
    if (uuid === weapon.uuid) {
      weaponResolutions += 1;
      return weapon;
    }
    return null;
  };
  globalThis.canvas = {
    level: { id: "level" },
    scene: { id: "scene" },
    tokens: {
      placeables: [sourceDocument.object]
    }
  };
  game.user = gm;
  game.users.activeGM = gm;
  game.socket.emit = (_channel, payload) => emitted.push(payload);
  const selection = {
    operationId: "same-operation",
    previewAttackId: "same-preview",
    tokenUuid: sourceDocument.uuid,
    weaponUuid: weapon.uuid,
    actionKey: "snapshot",
    weaponFunctionId: "weapon",
    pointer: { x: 300, y: 100, elevation: 0 },
    geometry: createGeometry(),
    visibleTokenUuids: [sourceDocument.uuid],
    mode: "current"
  };

  game.socket.id = "gm-tab-a";
  const firstTicket = await ORDINARY_WEAPON_ATTACK_TESTING.handleTicketQuery(
    { selection },
    { user: player, timeout: 50 }
  );
  assert.equal(firstTicket.ok, true);

  game.socket.id = "gm-tab-b";
  assert.equal(await ORDINARY_WEAPON_ATTACK_TESTING.handleSocketRequest({
    action: "ordinaryAttackRequest",
    authoritySocketId: firstTicket.authoritySocketId,
    gmUserId: gm.id,
    operationId: selection.operationId,
    senderUserId: player.id,
    ticket: firstTicket.ticket
  }, player.id), false);
  assert.equal(weaponResolutions, 0);

  game.socket.id = "gm-tab-a";
  assert.equal(await ORDINARY_WEAPON_ATTACK_TESTING.handleSocketRequest({
    action: "ordinaryAttackRequest",
    authoritySocketId: firstTicket.authoritySocketId,
    gmUserId: gm.id,
    operationId: selection.operationId,
    senderUserId: player.id,
    ticket: firstTicket.ticket
  }, player.id), true);
  assert.equal(weaponResolutions, 1);

  const secondTicket = await ORDINARY_WEAPON_ATTACK_TESTING.handleTicketQuery(
    { selection },
    { user: player, timeout: 50 }
  );
  assert.equal(await ORDINARY_WEAPON_ATTACK_TESTING.handleSocketRequest({
    action: "ordinaryAttackRequest",
    authoritySocketId: secondTicket.authoritySocketId,
    gmUserId: gm.id,
    operationId: selection.operationId,
    senderUserId: player.id,
    ticket: secondTicket.ticket
  }, player.id), true);
  assert.equal(weaponResolutions, 1);
  assert.equal(emitted.filter(payload => payload.action === "ordinaryAttackResult").length, 2);
});

test("authority path falls back to the original local execution without QUERY_USER", () => {
  game.user = { ...player, hasPermission: () => false };
  const controller = Object.create(WeaponAttackController.prototype);
  Object.assign(controller, {
    abilityTrialSession: null,
    attackModifier: null,
    captureOnly: false,
    chainRef: null,
    onBeforeExecute: null,
    skipActionPointCost: false,
    skipBaseWeaponResourceCosts: false,
    useGmAuthority: true,
    volleyAction: false
  });
  assert.equal(controller.shouldUseOrdinaryGmAuthority(), false);
  game.user = player;
});

test("authority target policy overrides the GM viewport and keeps one headless controller", async () => {
  const controller = Object.create(WeaponAttackController.prototype);
  controller.targetTokenUuidAllowlist = new Set(["Scene.scene.Token.allowed"]);
  const allowed = { actor: {}, visible: false, document: { uuid: "Scene.scene.Token.allowed" } };
  const denied = { actor: {}, visible: true, document: { uuid: "Scene.scene.Token.denied" } };
  assert.deepEqual(controller.filterTargetTokens([allowed, denied]), [allowed]);

  const source = await readFile(new URL("../src/combat/weapon-attack-controller.mjs", import.meta.url), "utf8");
  assert.match(source, /isAttackTargetVisible\(target,\s*allowlist\)/u);
  assert.match(source, /controller:\s*suppliedController/u);
  assert.match(source, /headlessExecution:\s*true/u);
  assert.match(source, /attackId:\s*selection\.operationId/u);
  assert.match(source, /chanceOperationId:\s*selection\.previewAttackId/u);
  assert.match(source, /chatMessageAuthorId:\s*sender\.id/u);
  assert.match(source, /enqueueOrdinaryAttackActorOperation\(ticket\.actorUuid/u);
  assert.match(source, /\{ recipients: \[pending\.authorityUserId\] \}/u);
  assert.match(source, /handleWeaponAttackSocketMessage\(payload = \{\}, socketSenderUserId = ""\)/u);
  assert.match(source, /skipActionPointCost:\s*false,\s*\n\s*skipBaseWeaponResourceCosts:\s*false,/u);
});

function createAuthorityController({ sourceToken, targets = [], weapon }) {
  const controller = Object.create(WeaponAttackController.prototype);
  Object.assign(controller, {
    abilityTrialSession: null,
    actionKey: "burst",
    attackCheckCount: 0,
    attackId: "preview-attack",
    attackModifier: null,
    captureOnly: false,
    chainRef: null,
    geometry: createGeometry(),
    lockedGeometry: null,
    onBeforeExecute: null,
    pointer: { x: 300, y: 100, elevation: 0 },
    processing: false,
    selectedLimbKey: "",
    selectedTarget: null,
    skipActionPointCost: false,
    skipBaseWeaponResourceCosts: false,
    targets,
    token: sourceToken,
    useGmAuthority: true,
    volleyAction: false,
    weapon,
    weaponFunctionId: "weapon"
  });
  return controller;
}

function createTokenDocument(id, { hidden = false } = {}) {
  const document = {
    hidden,
    id,
    parent: {
      id: "scene",
      uuid: "Scene.scene"
    },
    uuid: `Scene.scene.Token.${id}`,
    includedInLevel(levelId) {
      return levelId === "level";
    }
  };
  document.actor = {
    uuid: `Actor.${id}`
  };
  document.object = createToken(document, true);
  return document;
}

function createToken(document, visible) {
  return {
    actor: document.actor,
    document,
    id: document.id,
    visible
  };
}

function createGeometry() {
  return {
    angle: 0,
    distance: 200,
    end: { x: 300, y: 100, elevation: 0 },
    halfAngle: 0.1,
    origin: { x: 100, y: 100, elevation: 0 },
    radiusPixels: 0,
    rangeBonusMeters: 0,
    shapePoints: [],
    type: "cone"
  };
}
