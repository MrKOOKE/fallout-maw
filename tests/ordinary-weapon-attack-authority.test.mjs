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
  ATTACK_TARGETING_TESTING,
  ORDINARY_WEAPON_ATTACK_TESTING,
  WEAPON_CONDITION_WEAR_TESTING,
  WeaponAttackController
} = await import("../src/combat/weapon-attack-controller.mjs");

test("impact condition wear uses one hit base plus total armor-blocked damage", () => {
  const summary = WEAPON_CONDITION_WEAR_TESTING.summarizeDamageResults([{
    mode: "damage",
    amount: 25,
    mitigationBlocked: 20
  }, {
    mode: "damage",
    amount: 0,
    mitigationBlocked: 2.4
  }, {
    mode: "damage",
    amount: 1,
    mitigationBlocked: 0.6
  }, {
    mode: "healing",
    amount: 10,
    mitigationBlocked: 100
  }]);

  assert.deepEqual(summary, {
    hit: true,
    blockedDamage: 23,
    multiplier: 0,
    conditionLoss: 0
  });
  assert.equal(WEAPON_CONDITION_WEAR_TESTING.calculateConditionLoss(100, summary.blockedDamage, 2), 50);
  assert.equal(WEAPON_CONDITION_WEAR_TESTING.calculateConditionLoss(30, summary.blockedDamage, 2), 30);
});

test("ordinary impact condition wear derives its multiplier from the configured condition cost", async () => {
  const weaponData = {
    resourceCosts: [{ type: "condition", amount: 6 }],
    specialProperties: [{ type: "impactConditionWear" }]
  };
  const actor = {
    documentName: "Actor",
    uuid: "Actor.impact-wear",
    items: new Map()
  };
  const weapon = {
    id: "impact-wear-weapon",
    parent: actor,
    system: {
      functions: {
        condition: { enabled: true, value: 100 },
        weapon: weaponData
      }
    },
    async update(changes) {
      this.system.functions.condition.value = changes["system.functions.condition.value"];
    }
  };
  actor.items.set(weapon.id, weapon);

  const result = await WEAPON_CONDITION_WEAR_TESTING.applyImpactConditionWear(
    weapon,
    "weapon",
    [{ mode: "damage", amount: 10 }],
    { weaponData }
  );

  assert.equal(result.multiplier, 6);
  assert.equal(result.conditionLoss, 12);
  assert.equal(weapon.system.functions.condition.value, 88);
});

test("pellets share one base impact wear and preserve their combined blocked damage", () => {
  const pellets = Array.from({ length: 8 }, () => ({
    mode: "damage",
    amount: 20,
    mitigationBlocked: 2.5
  }));
  const summary = WEAPON_CONDITION_WEAR_TESTING.summarizeDamageResults(pellets);

  assert.equal(summary.blockedDamage, 20);
  assert.equal(WEAPON_CONDITION_WEAR_TESTING.calculateConditionLoss(1000, summary.blockedDamage, 6), 132);
});

test("fully mitigated weapon damage still counts as a hit", () => {
  assert.deepEqual(WEAPON_CONDITION_WEAR_TESTING.summarizeDamageResults([{
    mode: "damage",
    amount: 0,
    mitigationBlocked: 20
  }]), {
    hit: true,
    blockedDamage: 20,
    multiplier: 0,
    conditionLoss: 0
  });
  assert.equal(WEAPON_CONDITION_WEAR_TESTING.calculateConditionLoss(100, 20, 2), 44);
});

test("fully delayed periodic damage still counts as a weapon hit", async () => {
  assert.equal(WEAPON_CONDITION_WEAR_TESTING.summarizeDamageResults([{
    mode: "damage",
    amount: 0,
    delayedAmount: 20
  }]).hit, true);

  const source = await readFile(new URL("../src/combat/damage-hub.mjs", import.meta.url), "utf8");
  assert.match(source, /delayedAmount:\s*roundDamageAmount\(result\.delayedAmount\)/u);
});

test("perception preview and physical impact use independent target policies", () => {
  const perceived = {
    actor: {},
    visible: true,
    document: { hidden: false, uuid: "Scene.scene.Token.perceived" }
  };
  const smokeHidden = {
    actor: {},
    visible: false,
    document: { hidden: false, uuid: "Scene.scene.Token.smoke-hidden" }
  };
  const administrativelyHidden = {
    actor: {},
    visible: false,
    document: { hidden: true, uuid: "Scene.scene.Token.admin-hidden" }
  };
  const secret = {
    actor: {},
    visible: true,
    document: {
      hidden: false,
      disposition: -2,
      uuid: "Scene.scene.Token.secret"
    }
  };

  assert.equal(ATTACK_TARGETING_TESTING.isAttackTargetVisible(perceived), true);
  assert.equal(ATTACK_TARGETING_TESTING.isAttackTargetVisible(smokeHidden), false);
  assert.equal(ATTACK_TARGETING_TESTING.isAttackImpactTarget(smokeHidden), true);
  assert.equal(ATTACK_TARGETING_TESTING.isAttackImpactTarget(administrativelyHidden), false);
  assert.deepEqual(ATTACK_TARGETING_TESTING.getUnseenAttackEdgeModifiers(smokeHidden), {
    disadvantage: true,
    disadvantageCount: 3
  });
  assert.deepEqual(ATTACK_TARGETING_TESTING.getUnseenAttackEdgeModifiers(perceived), {});

  const playerVisibility = new Set([perceived.document.uuid]);
  assert.equal(ATTACK_TARGETING_TESTING.isAttackTargetVisible(smokeHidden, playerVisibility), false);
  assert.equal(ATTACK_TARGETING_TESTING.getUnseenAttackEdgeModifiers(
    smokeHidden,
    playerVisibility
  ).disadvantageCount, 3);

  const previousConst = globalThis.CONST;
  globalThis.CONST = {
    ...(previousConst ?? {}),
    TOKEN_DISPOSITIONS: {
      ...(previousConst?.TOKEN_DISPOSITIONS ?? {}),
      SECRET: -2
    }
  };
  try {
    assert.equal(ATTACK_TARGETING_TESTING.isAttackImpactTarget(secret), false);
    assert.equal(ATTACK_TARGETING_TESTING.isAttackTargetVisible(secret), false);
    assert.equal(ATTACK_TARGETING_TESTING.isAttackTargetVisible(
      secret,
      new Set([secret.document.uuid])
    ), false);
  } finally {
    globalThis.CONST = previousConst;
  }
});

test("attacker-specific perception overrides global token visibility without removing physical impact", () => {
  const previousCanvas = globalThis.canvas;
  const previousPIXI = globalThis.PIXI;
  const previousIntersection = foundry.utils.lineSegmentIntersection;
  const previousCanvasConfig = CONFIG.Canvas;

  class Polygon {
    constructor(points = []) {
      this.points = points;
    }

    contains(x, y) {
      let inside = false;
      for (let index = 0, previous = (this.points.length / 2) - 1; index < this.points.length / 2; previous = index++) {
        const xi = this.points[index * 2];
        const yi = this.points[(index * 2) + 1];
        const xj = this.points[previous * 2];
        const yj = this.points[(previous * 2) + 1];
        if (((yi > y) !== (yj > y)) && (x < (((xj - xi) * (y - yi)) / (yj - yi)) + xi)) inside = !inside;
      }
      return inside;
    }
  }

  class Rectangle {
    constructor(x, y, width, height) {
      Object.assign(this, { x, y, width, height });
    }

    normalize() {
      return this;
    }

    toPolygon() {
      return new Polygon([
        this.x, this.y,
        this.x + this.width, this.y,
        this.x + this.width, this.y + this.height,
        this.x, this.y + this.height
      ]);
    }
  }

  foundry.utils.lineSegmentIntersection = (a, b, c, d) => {
    const denominator = ((a.x - b.x) * (c.y - d.y)) - ((a.y - b.y) * (c.x - d.x));
    if (Math.abs(denominator) < 1e-9) return null;
    const left = (a.x * b.y) - (a.y * b.x);
    const right = (c.x * d.y) - (c.y * d.x);
    const x = ((left * (c.x - d.x)) - ((a.x - b.x) * right)) / denominator;
    const y = ((left * (c.y - d.y)) - ((a.y - b.y) * right)) / denominator;
    const within = (value, first, second) => value >= Math.min(first, second) - 1e-9
      && value <= Math.max(first, second) + 1e-9;
    return within(x, a.x, b.x) && within(y, a.y, b.y)
      && within(x, c.x, d.x) && within(y, c.y, d.y)
      ? { x, y }
      : null;
  };
  globalThis.PIXI = {
    Polygon,
    Rectangle,
    Circle: class Circle {},
    Ellipse: class Ellipse {}
  };

  const attackerVision = {
    active: true,
    isBlinded: false,
    object: {
      document: {
        detectionModes: {
          basicSight: { id: "basicSight", enabled: true, range: 100 }
        }
      }
    }
  };
  const attacker = {
    actor: {},
    checkCollision: () => false,
    document: { hidden: false, uuid: "Scene.scene.Token.attacker" },
    vision: attackerVision
  };
  const target = {
    actor: {},
    document: {
      _source: { depth: 1, elevation: 0 },
      getVisibilityTestPoints: () => [{ x: 50, y: 5, elevation: 0 }],
      hidden: false,
      uuid: "Scene.scene.Token.unseen"
    },
    position: { x: 50, y: 0 },
    shape: new Rectangle(0, 0, 10, 10),
    // Another controlled source can make Foundry's aggregate Token.visible true.
    visible: true
  };
  globalThis.canvas = {
    dimensions: { distance: 1 },
    scene: { grid: { distance: 1 } },
    tokens: { placeables: [attacker, target] },
    visibility: {
      tokenVision: true,
      _createVisibilityTestConfig: (points, options) => ({ points, object: options.object })
    }
  };
  CONFIG.Canvas = {
    detectionModes: {
      basicSight: {
        testVisibility: source => source !== attackerVision
      }
    }
  };
  const trajectory = {
    distance: 100,
    end: { x: 100, y: 5, elevation: 0 },
    origin: { x: 0, y: 5, elevation: 0 }
  };

  try {
    assert.equal(ATTACK_TARGETING_TESTING.isAttackTargetVisible(target, null, attacker), false);
    assert.deepEqual(ATTACK_TARGETING_TESTING.getUnseenAttackEdgeModifiers(target, null, attacker), {
      disadvantage: true,
      disadvantageCount: 3
    });
    assert.deepEqual(ATTACK_TARGETING_TESTING.getTrajectoryTargetEntries(attacker, trajectory), []);
    const impacts = ATTACK_TARGETING_TESTING.getTrajectoryTargetEntries(
      attacker,
      trajectory,
      null,
      { purpose: "impact" }
    );
    assert.equal(impacts.length, 1);
    assert.equal(impacts[0].target, target);
    assert.equal(impacts[0].hit.distance, 50);

    target.document.hidden = true;
    assert.deepEqual(ATTACK_TARGETING_TESTING.getTrajectoryTargetEntries(
      attacker,
      trajectory,
      null,
      { purpose: "impact" }
    ), []);
  } finally {
    foundry.utils.lineSegmentIntersection = previousIntersection;
    globalThis.canvas = previousCanvas;
    if (previousCanvasConfig === undefined) delete CONFIG.Canvas;
    else CONFIG.Canvas = previousCanvasConfig;
    if (previousPIXI === undefined) delete globalThis.PIXI;
    else globalThis.PIXI = previousPIXI;
  }
});

test("unaimed melee randomizes only among explicitly enabled directions", () => {
  const swingOnly = ATTACK_TARGETING_TESTING.getEnabledMeleeDirectionsFromSettings({
    thrust: { enabled: false },
    swing: { enabled: true }
  });
  assert.deepEqual(swingOnly.map(direction => direction.key), ["rightToLeft", "leftToRight"]);
  assert.equal(ATTACK_TARGETING_TESTING.selectRandomMeleeDirection(swingOnly, () => 0).key, "rightToLeft");
  assert.equal(ATTACK_TARGETING_TESTING.selectRandomMeleeDirection(swingOnly, () => 0.999).key, "leftToRight");
  assert.deepEqual(ATTACK_TARGETING_TESTING.getEnabledMeleeDirectionsFromSettings({
    thrust: { enabled: false },
    swing: { enabled: false }
  }), []);
});

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
  assert.equal(Object.hasOwn(queryCalls[0].data.selection, "visibleTokenUuids"), false);
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

test("authority derives perception from the attacker and ignores a forged globally-visible target", async () => {
  const previousCanvas = globalThis.canvas;
  const previousCanvasConfig = CONFIG.Canvas;
  const previousFromUuid = globalThis.fromUuid;
  const previousUser = game.user;
  const previousActiveGM = game.users.activeGM;
  const sourceDocument = createTokenDocument("observer-source");
  const targetDocument = createTokenDocument("globally-visible-target");
  const sourceActor = {
    effects: [],
    items: [],
    system: {},
    uuid: "Actor.observer-source",
    testUserPermission: () => true
  };
  sourceDocument.actor = sourceActor;
  sourceDocument.object.actor = sourceActor;
  sourceDocument.detectionModes = {
    basicSight: { id: "basicSight", enabled: true, range: 100 }
  };
  Object.assign(sourceDocument.object, {
    center: { x: 0, y: 0 },
    hasSight: true,
    _getVisionBlindedStates: () => ({}),
    _getVisionSourceData: () => ({ x: 0, y: 0, elevation: 0, radius: 100 })
  });
  Object.assign(targetDocument.object, {
    center: { x: 100, y: 0 },
    // Aggregate visibility may come from a different controlled Token.
    visible: true
  });
  const weapon = {
    type: "weapon",
    uuid: `${sourceActor.uuid}.Item.weapon`,
    parent: sourceActor,
    system: {
      functions: {
        weapon: {
          enabled: true,
          availableActions: { aimedShot: true },
          aimedShot: { enabled: true }
        }
      }
    }
  };
  const documents = new Map([
    [sourceDocument.uuid, sourceDocument],
    [targetDocument.uuid, targetDocument],
    [weapon.uuid, weapon]
  ]);

  class ObserverVisionSource {
    constructor({ object }) {
      this.object = object;
      this.blinded = {};
      this.isBlinded = false;
    }

    initialize(data) {
      this.data = data;
    }

    destroy() {}
  }

  globalThis.fromUuid = async uuid => documents.get(uuid) ?? null;
  globalThis.canvas = {
    ready: true,
    level: { id: "level" },
    scene: { id: "scene" },
    tokens: { placeables: [sourceDocument.object, targetDocument.object] },
    visibility: {
      tokenVision: true,
      _createVisibilityTestConfig: (points, options) => ({ points, object: options.object })
    }
  };
  CONFIG.Canvas = {
    visionSourceClass: ObserverVisionSource,
    detectionModes: {
      basicSight: { testVisibility: () => false }
    }
  };
  game.user = gm;
  game.users.activeGM = gm;

  try {
    const result = await ORDINARY_WEAPON_ATTACK_TESTING.executeSelection({
      operationId: "forged-global-visibility",
      previewAttackId: "preview-global-visibility",
      tokenUuid: sourceDocument.uuid,
      weaponUuid: weapon.uuid,
      actionKey: "aimedShot",
      weaponFunctionId: "weapon",
      pointer: { x: 300, y: 100, elevation: 0 },
      geometry: createGeometry(),
      targetUuid: targetDocument.uuid,
      selectedLimbKey: "torso",
      visibleTokenUuids: [sourceDocument.uuid, targetDocument.uuid],
      mode: "aimed"
    }, player);

    assert.equal(targetDocument.object.visible, true);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalidTarget");
  } finally {
    globalThis.canvas = previousCanvas;
    globalThis.fromUuid = previousFromUuid;
    game.user = previousUser;
    game.users.activeGM = previousActiveGM;
    if (previousCanvasConfig === undefined) delete CONFIG.Canvas;
    else CONFIG.Canvas = previousCanvasConfig;
  }
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
  assert.match(source, /const targetTokenUuidAllowlist = getAuthoritativeAttackPerceptionUuids\(token\)/u);
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

test("unaimed attacks keep preview private while authority resolves physical impacts", async () => {
  const source = await readFile(new URL("../src/combat/weapon-attack-controller.mjs", import.meta.url), "utf8");
  const resolutionTargets = source.slice(
    source.indexOf("getAttackResolutionTargets("),
    source.indexOf("async executeOrdinaryAttackViaGm", source.indexOf("getAttackResolutionTargets("))
  );
  const trajectoryResolution = source.slice(
    source.indexOf("async resolveAttackTrajectory("),
    source.indexOf("async resolveAttackAgainstTarget", source.indexOf("async resolveAttackTrajectory("))
  );
  const preview = source.slice(
    source.indexOf("function getPotentialTargets("),
    source.indexOf("function getVolleyTrajectoryAimTarget", source.indexOf("function getPotentialTargets("))
  );
  const pelletResolution = source.slice(
    source.indexOf("async resolveAttackPellets("),
    source.indexOf("async resolveAttackTrajectory(", source.indexOf("async resolveAttackPellets("))
  );
  const burstResolution = source.slice(
    source.indexOf("async performBurstAttack("),
    source.indexOf("onAimedConfirm()", source.indexOf("async performBurstAttack("))
  );
  const volleyResolution = source.slice(
    source.indexOf("async performVolleyAttack("),
    source.indexOf("async resolveVolleyBlastPoint", source.indexOf("async performVolleyAttack("))
  );

  assert.match(resolutionTargets, /purpose:\s*"impact"/u);
  assert.match(trajectoryResolution, /purpose:\s*"impact"/u);
  assert.doesNotMatch(trajectoryResolution, /!this\.targets\.length/u);
  assert.match(trajectoryResolution, /buildAttackTrajectory\(this\.token, this\.geometry, this\.targets\)/u);
  assert.match(pelletResolution, /buildAttackTrajectories\([\s\S]*?this\.targets,/u);
  assert.doesNotMatch(pelletResolution, /buildAttackTrajectories\([\s\S]*?getAttackResolutionTargets/u);
  assert.match(burstResolution, /getBurstTargetHitDistribution\([\s\S]*?this\.targets,/u);
  assert.match(volleyResolution, /purpose:\s*"impact"/u);
  assert.match(preview, /purpose\s*=\s*"preview"/u);
  assert.match(source, /hasTargets:\s*this\.targets\.length > 0/u);
  assert.match(source, /mode:\s*UNAIMED_ATTACK_MODE/u);
  assert.match(source, /selectRandomMeleeDirection\(/u);
  assert.match(source, /canvas\.tokens\?\.quadtree/u);
  assert.match(source, /disadvantageCount:\s*UNAIMED_ATTACK_DISADVANTAGE_COUNT/u);
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
