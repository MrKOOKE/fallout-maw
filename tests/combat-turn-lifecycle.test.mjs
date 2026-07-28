import assert from "node:assert/strict";
import test from "node:test";

function deepMerge(target, source) {
  const output = structuredClone(target ?? {});
  for (const [key, value] of Object.entries(source ?? {})) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      output[key] = deepMerge(output[key] ?? {}, value);
    } else {
      output[key] = structuredClone(value);
    }
  }
  return output;
}

class FakeCombatantCollection {
  constructor(combatants = []) {
    this.contents = combatants;
    this.index = new Map(combatants.map(combatant => [combatant.id, combatant]));
  }

  get(id) {
    return this.index.get(id);
  }

  map(callback) {
    return this.contents.map(callback);
  }

  [Symbol.iterator]() {
    return this.contents[Symbol.iterator]();
  }
}

class FakeCombat {
  static deleteResultIds = null;

  static async _onDeleteOperation() {}
  static async _onUpdateOperation() {}

  static async updateDocuments(updates = [], operation = {}) {
    if (operation.dryRun) return Array.from(updates);
    const documents = [];
    for (const changed of updates) {
      const combat = globalThis.game.combats.get(changed?._id);
      if (!combat) continue;
      await combat.updateBehavior?.(changed, operation, combat);
      const previous = combat._getCurrentState();
      if ("round" in changed) combat.round = changed.round;
      if ("turn" in changed) combat.turn = changed.turn;
      for (const [path, value] of Object.entries(changed)) {
        if (!path.startsWith("flags.")) continue;
        const [, scope, ...key] = path.split(".");
        combat.flags.set(`${scope}.${key.join(".")}`, value);
      }
      combat.previous = previous;
      combat.current = combat._getCurrentState();
      combat.updateCount += 1;
      combat._onUpdate(changed, operation, globalThis.game.user.id);
      documents.push(combat);
    }
    if (documents.length) {
      await this._onUpdateOperation(documents, {
        ...operation,
        updates
      }, globalThis.game.user);
    }
    return documents;
  }

  static async deleteDocuments(ids = [], operation = {}) {
    if (operation.dryRun) return Array.from(ids);
    const requestedIds = new Set(ids);
    const permittedIds = this.deleteResultIds === null
      ? requestedIds
      : new Set(this.deleteResultIds);
    const documents = globalThis.game.combats.contents.filter(combat => (
      requestedIds.has(combat.id) && permittedIds.has(combat.id)
    ));
    for (const document of documents) {
      document._onDelete(operation, globalThis.game.user.id);
    }
    globalThis.game.combats.contents = globalThis.game.combats.contents
      .filter(combat => !documents.includes(combat));
    if (documents.length) {
      await this._onDeleteOperation(documents, operation, globalThis.game.user);
    }
    return documents;
  }

  constructor({ id = "combat-test", combatants = [], round = 1, turn = 0 } = {}) {
    this.id = id;
    this.uuid = `Combat.${id}`;
    this.round = round;
    this.turn = turn;
    this.turns = combatants;
    this.combatants = new FakeCombatantCollection(combatants);
    this.settings = { skipDefeated: false };
    this.current = this._getCurrentState();
    this.previous = { ...this.current };
    this.updateCount = 0;
    this.flags = new Map();
    this.updateBehavior = null;
  }

  get started() {
    return this.round > 0;
  }

  get combatant() {
    return Number.isInteger(this.turn) ? this.turns[this.turn] ?? null : null;
  }

  _getCurrentState() {
    return {
      round: this.round,
      turn: this.turn,
      combatantId: this.combatant?.id ?? null
    };
  }

  getTimeDelta() {
    return 0;
  }

  getFlag(scope, key) {
    return this.flags.get(`${scope}.${key}`);
  }

  _playCombatSound() {}

  async startCombat() {
    globalThis.Hooks.callAll("combatStart", this, { round: 1, turn: 0 });
    await this.update({ round: 1, turn: 0 });
    return this;
  }

  async delete(options = {}) {
    const deleted = await this.constructor.deleteDocuments([this.id], options);
    return deleted.shift();
  }

  _onDelete() {
    globalThis.ActiveEffect.registry.refresh("combatEnd", { combat: this });
  }

  _onCreateDescendantDocuments(_parent, collection, documents) {
    if (collection !== "combatants" || !this.started) return;
    globalThis.ActiveEffect.registry.refresh("combatStart", {
      combat: this,
      actors: new Set(documents.map(document => document.actor).filter(Boolean))
    });
  }

  _onUpdateDescendantDocuments(_parent, collection, documents, changes, options) {
    if (collection !== "combatants") return;
    combatantParentOperationBehavior("update", documents, changes, options);
  }

  async nextTurn() {
    if (this.round === 0) return this.nextRound();
    const turn = this.turn ?? -1;
    let nextTurn = turn + 1;
    if (this.settings.skipDefeated) {
      nextTurn = this.turns.findIndex((combatant, index) => (
        index > turn && !combatant.isDefeated
      ));
    }
    if (nextTurn < 0 || nextTurn >= this.turns.length) return this.nextRound();
    await this.update({ round: this.round, turn: nextTurn });
    return this;
  }

  async previousTurn() {
    if (this.round === 0) return this;
    if (this.turn === 0 || this.turns.length === 0) return this.previousRound();
    await this.update({ round: this.round, turn: (this.turn ?? this.turns.length) - 1 });
    return this;
  }

  async nextRound() {
    const worldTime = this.round > 0
      ? globalThis.game.time.advance(6, {})
      : Promise.resolve();
    await this.update({
      round: this.round + 1,
      turn: this.turns.length ? 0 : null
    });
    await worldTime;
    return this;
  }

  async previousRound() {
    if (this.round === 0) return this;
    await this.update({
      round: this.round - 1,
      turn: this.round === 1 || !this.turns.length ? null : this.turns.length - 1
    });
    return this;
  }

  async update(changed, options = {}) {
    const [updated] = await this.constructor.updateDocuments([{
      _id: this.id,
      ...changed
    }], options);
    return updated;
  }

  _onUpdate(changed, options) {
    const stateChanged = (
      this.current.round !== this.previous.round
      || this.current.turn !== this.previous.turn
      || this.current.combatantId !== this.previous.combatantId
    );
    if (stateChanged && options.turnEvents !== false) this._manageTurnEvents();
  }

  async _manageTurnEvents() {
    if (!this.started) return;
    const previous = this.previous;
    const current = this.current;
    if (globalThis.game.user.isActiveGM) {
      const previousCombatant = this.combatants.get(previous.combatantId);
      const currentCombatant = this.combatants.get(current.combatantId);
      if (previousCombatant && previous.round > 0) {
        await this._onEndTurn(previousCombatant, {
          round: previous.round,
          turn: previous.turn,
          skipped: false
        });
      }
      if (previous.round !== current.round) {
        await this._onStartRound({ round: current.round, skipped: false });
      }
      if (currentCombatant) {
        await this._onStartTurn(currentCombatant, {
          round: current.round,
          turn: current.turn,
          skipped: false
        });
      }
    }
    globalThis.Hooks.callAll("combatTurnChange", this, previous, current);
  }

  async _onEndTurn() {}

  async _onEndRound() {}

  async _onStartRound() {}

  async _onStartTurn() {}

  async _clearMovementHistoryOnStartTurn() {}

  _onUpdateTurnMarkers() {}

  _updateTurnMarkers() {}
}

let combatantOperationEvents = [];
let combatantDocumentOperationBehavior = async () => {};
let combatantParentOperationBehavior = () => {};
let combatantAuthorityBroadcastBehavior = async () => {};
class FakeCombatant {
  static async updateDocuments(updates = [], operation = {}) {
    if (operation.dryRun) return Array.from(updates);
    const parent = operation.parent;
    const documents = updates
      .map(update => parent?.combatants?.get?.(update?._id))
      .filter(Boolean);
    const lockedOperation = { ...operation, updates };
    const allowed = await this._preUpdateOperation(documents, lockedOperation, globalThis.game.user);
    if (allowed === false || !documents.length) return [];
    await combatantDocumentOperationBehavior("update", documents, lockedOperation);
    for (const update of updates) {
      const combatant = parent.combatants.get(update?._id);
      if (!combatant) continue;
      if ("initiative" in update) combatant.initiative = update.initiative;
      if ("defeated" in update) {
        combatant.defeated = Boolean(update.defeated);
        combatant.isDefeated = Boolean(update.defeated);
      }
      for (const [path, value] of Object.entries(update)) {
        if (!path.startsWith("flags.")) continue;
        const [, scope, ...key] = path.split(".");
        const flagKey = `${scope}.${key.join(".")}`;
        if (value === globalThis._del) combatant.flags.delete(flagKey);
        else combatant.flags.set(flagKey, value);
      }
    }
    parent?._onUpdateDescendantDocuments(
      parent,
      "combatants",
      documents,
      updates,
      lockedOperation,
      globalThis.game.user.id
    );
    await this._onUpdateOperation(documents, { ...lockedOperation }, globalThis.game.user);
    await combatantAuthorityBroadcastBehavior(this, documents, lockedOperation, globalThis.game.user);
    return documents;
  }

  static async _preCreateOperation(_documents, operation) {
    combatantOperationEvents.push(`super-create:${operation.parent?.turn}`);
    return true;
  }

  static async _onCreateOperation() {}

  static async _preUpdateOperation(_documents, operation) {
    combatantOperationEvents.push(`super-update:${operation.parent?.turn}`);
    return true;
  }

  static async _onUpdateOperation() {}

  static async _preDeleteOperation(_documents, operation) {
    combatantOperationEvents.push(`super-delete:${operation.parent?.turn}`);
    return true;
  }

  static async _onDeleteOperation() {}
}

globalThis.foundry = {
  applications: {
    api: { DialogV2: class {} },
    ux: { FormDataExtended: class {} },
    handlebars: { renderTemplate: async () => "" }
  },
  documents: {
    ActiveEffect: { implementation: class {} },
    ChatMessage: {
      implementation: {
        getSpeaker: () => ({}),
        create: async () => []
      }
    }
  },
  dice: {
    Roll: { _mapLegacyRollMode: value => value }
  },
  utils: {
    deepClone: value => structuredClone(value),
    mergeObject: (target, source) => deepMerge(target, source),
    getProperty: (object, path) => String(path).split(".").reduce((value, key) => value?.[key], object),
    hasProperty: (object, path) => (
      String(path).split(".").reduce((value, key) => value?.[key], object) !== undefined
    ),
    randomID: () => Math.random().toString(36).slice(2),
    escapeHTML: value => String(value),
    logCompatibilityWarning: () => {}
  }
};
globalThis.Combat = FakeCombat;
globalThis.Combatant = FakeCombatant;
globalThis.CONFIG = {
  ActiveEffect: {
    expiryAction: "delete",
    documentClass: {
      createDocuments: async () => []
    }
  },
  Combat: { initiative: { formula: "1d20" } },
  ChatMessage: { modes: {} },
  queries: {},
  time: { roundTime: 6, turnTime: 0 },
  debug: { combat: false }
};
globalThis.CONST = {
  ACTIVE_EFFECT_MODES: { ADD: 2 },
  REGION_EVENTS: {
    TOKEN_TURN_END: "tokenTurnEnd",
    TOKEN_ROUND_END: "tokenRoundEnd",
    TOKEN_ROUND_START: "tokenRoundStart",
    TOKEN_TURN_START: "tokenTurnStart"
  }
};
globalThis.canvas = {
  ready: false,
  scene: null,
  tokens: {
    controlled: [],
    placeables: [],
    turnMarkers: []
  }
};
globalThis.ui = {
  notifications: {
    warn: () => {},
    error: () => {}
  }
};
const hookCallbacks = new Map();
const socketCallbacks = new Map();
let socketMessages = [];
globalThis.Hooks = {
  on(name, callback) {
    const callbacks = hookCallbacks.get(name) ?? [];
    callbacks.push(callback);
    hookCallbacks.set(name, callbacks);
    return callbacks.length;
  },
  callAll(name, ...args) {
    for (const callback of hookCallbacks.get(name) ?? []) callback(...args);
  }
};
let activeEffectRefreshBehavior = async () => {};
const activeEffectRegistryPrototype = {
  refresh: (...args) => activeEffectRefreshBehavior(...args)
};
globalThis.ActiveEffect = {
  registry: Object.create(activeEffectRegistryPrototype)
};
let turnOrderScheme = "normal";
globalThis.game = {
  user: {
    id: "gm",
    isGM: true,
    isActiveGM: true
  },
  users: {
    activeGM: { id: "gm", isSelf: true },
    contents: [],
    get: id => globalThis.game.users.contents.find(user => user.id === id) ?? null
  },
  socket: {
    on(channel, callback) {
      const callbacks = socketCallbacks.get(channel) ?? [];
      callbacks.push(callback);
      socketCallbacks.set(channel, callbacks);
    },
    emit(channel, message) {
      socketMessages.push({ channel, message });
    }
  },
  settings: {
    get: (_scope, key) => (
      key === "combatSettings"
        ? {
          turnOrder: { scheme: turnOrderScheme },
          dodge: {
            restoreOnCombatStart: true,
            restoreOnCombatEnd: true,
            roundRecoveryPercent: 0
          }
        }
        : {}
    )
  },
  time: {
    worldTime: 0,
    advance: async (amount, options = {}) => {
      globalThis.game.time.worldTime += amount;
      globalThis.Hooks.callAll(
        "updateWorldTime",
        globalThis.game.time.worldTime,
        amount,
        options,
        "gm"
      );
    }
  },
  combats: {
    contents: [],
    get(id) {
      return this.contents.find(combat => combat.id === id) ?? null;
    },
    [Symbol.iterator]() {
      return this.contents[Symbol.iterator]();
    }
  },
  combat: null,
  system: { initiative: "1d20" }
};
globalThis.fromUuidSync = () => null;
globalThis.fromUuid = async () => null;
globalThis._del = Symbol("delete");

const {
  FalloutMaWCombat
} = await import("../src/documents/combat.mjs");
const {
  FalloutMaWCombatant
} = await import("../src/documents/combatant.mjs");
const {
  COMBAT_DELETION_SETTLED_HOOK
} = await import("../src/constants.mjs");
const {
  TURN_CONVERSION_MODES,
  prepareActorTurnEnd,
  prepareActorTurnStart,
  registerReactionResourceHooks,
  syncActorDefeatedCombatants
} = await import("../src/combat/reaction-resources.mjs");
const {
  BLOCK_TURN_ACTOR_OPTION,
  getActiveBlockProgress,
  isActiveBlockComplete
} = await import("../src/combat/turn-order-blocks.mjs");
const {
  registerActorTurnEndHandler,
  registerActorTurnStartPreparedHandler,
  registerCombatRoundStartHandler
} = await import("../src/combat/turn-events.mjs");
const {
  hasActorCombatMovementInCurrentTurn
} = await import("../src/combat/movement-resources.mjs");
const {
  registerQueuedWorldTimeProcessor
} = await import("../src/time/world-time-queue.mjs");
const {
  COMBAT_TURN_SOCKET_SCOPE,
  performCombatTurnNavigationRequest
} = await import("../src/combat/turn-navigation-socket.mjs");
const {
  registerSystemEventObserver
} = await import("../src/events/dispatcher.mjs");
const {
  cleanupDeletedCombatantResources,
  cleanupDeletedCombatResources,
  initializeCreatedCombatantResources
} = await import("../src/combat/resource-lifecycle.mjs");
const {
  COMBAT_LIFECYCLE_CONTEXT_OPTION
} = await import("../src/combat/combat-lifecycle-lease.mjs");

let turnEvents = [];
let turnEndContexts = [];
let turnEndBehavior = async () => {};
let turnStartBehavior = async () => {};
let roundStartBehavior = async () => {};
let worldTimeProcessorBehavior = async () => {};
let worldTimeEventBehavior = async () => {};
let combatTurnChangeBehavior = () => {};
let combatDeletionSettledBehavior = () => {};
registerReactionResourceHooks();
registerActorTurnEndHandler(async context => {
  turnEvents.push(`end:${context.actor.uuid}:${context.conversionMode}`);
  turnEndContexts.push(context);
  await turnEndBehavior(context);
});
registerActorTurnStartPreparedHandler(async context => {
  turnEvents.push(`start:${context.actor.uuid}`);
  await turnStartBehavior(context);
});
registerCombatRoundStartHandler(context => roundStartBehavior(context));
registerQueuedWorldTimeProcessor((...args) => worldTimeProcessorBehavior(...args));
registerSystemEventObserver({
  id: "combat-turn-lifecycle-world-time",
  eventKeys: ["fallout-maw.world.time.advanced"],
  observe: context => worldTimeEventBehavior(context)
});
Hooks.on("combatTurnChange", (...args) => combatTurnChangeBehavior(...args));
Hooks.on(COMBAT_DELETION_SETTLED_HOOK, (...args) => combatDeletionSettledBehavior(...args));

function createActor(id) {
  return {
    id,
    uuid: `Actor.${id}`,
    name: id,
    isOwner: true,
    statuses: new Set(),
    effects: [],
    items: [],
    system: { resources: {} },
    getFlag: (_scope, key) => key === "factionBelongs" ? ["test-faction"] : null,
    testUserPermission: user => Boolean(user?.ownsActors),
    update: async () => {},
    createEmbeddedDocuments: async () => [],
    deleteEmbeddedDocuments: async () => []
  };
}

function createCombatant(id) {
  const actor = createActor(id);
  const combatant = {
    id,
    actor,
    initiative: null,
    isOwner: true,
    isDefeated: false,
    defeated: false,
    flags: new Map(),
    getFlag: (scope, key) => combatant.flags.get(`${scope}.${key}`),
    async update(changes, options = {}) {
      const [updated] = await FalloutMaWCombatant.updateDocuments([{
        _id: id,
        ...changes
      }], {
        ...options,
        parent: combatant.combat
      });
      return updated;
    }
  };
  return combatant;
}

function createCombat(ids, options = {}) {
  const combatants = ids.map(createCombatant);
  const combat = new FalloutMaWCombat({ combatants, ...options });
  for (const combatant of combatants) combatant.combat = combat;
  globalThis.game.combat = combat;
  globalThis.game.combats.contents = [combat];
  return combat;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function resetBehaviors() {
  FakeCombat.deleteResultIds = null;
  combatantOperationEvents = [];
  combatantDocumentOperationBehavior = async () => {};
  combatantParentOperationBehavior = () => {};
  combatantAuthorityBroadcastBehavior = async () => {};
  turnOrderScheme = "normal";
  turnEvents = [];
  turnEndContexts = [];
  turnEndBehavior = async () => {};
  turnStartBehavior = async () => {};
  roundStartBehavior = async () => {};
  worldTimeProcessorBehavior = async () => {};
  worldTimeEventBehavior = async () => {};
  combatTurnChangeBehavior = () => {};
  combatDeletionSettledBehavior = () => {};
  activeEffectRefreshBehavior = async () => {};
  socketMessages = [];
  globalThis.game.user.id = "gm";
  globalThis.game.user.isGM = true;
  globalThis.game.user.isActiveGM = true;
  globalThis.game.users.activeGM = { id: "gm", isSelf: true };
  globalThis.game.users.contents = [];
  globalThis.game.combats.contents = [];
}

function deliverSocketMessage(channel, message) {
  for (const callback of socketCallbacks.get(channel) ?? []) callback(message);
}

test("simultaneous identical nextTurn requests coalesce the whole lifecycle", async () => {
  resetBehaviors();
  const combat = createCombat(["a", "b"]);
  const first = combat.nextTurn({ falloutMawConversionMode: TURN_CONVERSION_MODES.none });
  const second = combat.nextTurn({ falloutMawConversionMode: TURN_CONVERSION_MODES.none });

  assert.strictEqual(second, first);
  await first;
  assert.equal(combat.updateCount, 1);
  assert.equal(combat.turn, 1);
  assert.deepEqual(turnEvents, [
    "end:Actor.a:none",
    "start:Actor.b"
  ]);
});

test("different intents captured from one state cannot advance two turns", async () => {
  resetBehaviors();
  const combat = createCombat(["a", "b", "c"]);
  const first = combat.nextTurn({ falloutMawConversionMode: TURN_CONVERSION_MODES.none });
  const conflicting = combat.nextTurn({ falloutMawConversionMode: TURN_CONVERSION_MODES.reaction });

  await first;
  await assert.rejects(conflicting, /turn changed/i);
  assert.equal(combat.updateCount, 1);
  assert.equal(combat.turn, 1);
});

test("the next queued state waits for end and start lifecycle completion", async () => {
  resetBehaviors();
  const gate = deferred();
  turnEndBehavior = context => context.actor.uuid === "Actor.a" ? gate.promise : undefined;
  const combat = createCombat(["a", "b", "c"]);
  const first = combat.nextTurn();
  await Promise.resolve();
  await Promise.resolve();
  const second = combat.nextTurn();

  assert.equal(combat.updateCount, 1);
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(combat.updateCount, 2);
  assert.deepEqual(turnEvents.map(event => event.split(":").slice(0, 2).join(":")), [
    "end:Actor.a",
    "start:Actor.b",
    "end:Actor.b",
    "start:Actor.c"
  ]);
});

test("a direct state-bearing Combat update cannot overlap a pending turn lifecycle", async () => {
  resetBehaviors();
  const gate = deferred();
  turnEndBehavior = context => context.actor.uuid === "Actor.a" ? gate.promise : undefined;
  const combat = createCombat(["a", "b", "c"]);

  const turn = combat.nextTurn();
  await Promise.resolve();
  await Promise.resolve();
  const directUpdate = combat.update({ round: 1, turn: 2 });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(combat.updateCount, 1);
  assert.equal(combat.turn, 1);
  gate.resolve();
  await Promise.all([turn, directUpdate]);
  assert.equal(combat.updateCount, 2);
  assert.equal(combat.turn, 2);
  assert.deepEqual(turnEvents.map(event => event.split(":").slice(0, 2).join(":")), [
    "end:Actor.a",
    "start:Actor.b",
    "end:Actor.b",
    "start:Actor.c"
  ]);
});

test("an initiative commit waits for the pending turn lifecycle", async () => {
  resetBehaviors();
  const gate = deferred();
  turnEndBehavior = context => context.actor.uuid === "Actor.a" ? gate.promise : undefined;
  const combat = createCombat(["a", "b"]);
  let initiativeCommitStarted = false;
  combatantDocumentOperationBehavior = async () => {
    initiativeCommitStarted = true;
  };

  const turn = combat.nextTurn();
  await Promise.resolve();
  await Promise.resolve();
  const initiative = FalloutMaWCombatant.updateDocuments([{
    _id: "a",
    initiative: 14
  }], { parent: combat });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(initiativeCommitStarted, false);

  gate.resolve();
  await Promise.all([turn, initiative]);
  assert.equal(initiativeCommitStarted, true);
  assert.equal(combat.combatants.get("a").initiative, 14);
});

test("a Combatant mutation waits for the parent lifecycle it creates", async () => {
  resetBehaviors();
  const combat = createCombat(["a", "b"]);
  const gate = deferred();
  turnEndBehavior = context => context.actor.uuid === "Actor.a" ? gate.promise : undefined;
  combatantParentOperationBehavior = () => {
    combat.previous = combat._getCurrentState();
    combat.turn = 1;
    combat.current = combat._getCurrentState();
    void combat._manageTurnEvents();
  };

  let settled = false;
  const update = FalloutMaWCombatant.updateDocuments([{
    _id: "a",
    initiative: 14
  }], { parent: combat }).then(result => {
    settled = true;
    return result;
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false);

  gate.resolve();
  await update;
  assert.equal(settled, true);
  assert.equal(combat.turn, 1);
});

test("lifecycle-bearing modifyDocumentBatch preflights fail closed", async () => {
  resetBehaviors();
  const combat = createCombat(["a"]);

  await assert.rejects(FalloutMaWCombat.updateDocuments([{
    _id: combat.id,
    turn: 0
  }], {
    dryRun: true,
    action: "update",
    documentName: "Combat"
  }), /modifyDocumentBatch/i);

  await assert.rejects(FalloutMaWCombatant.updateDocuments([{
    _id: "a",
    initiative: 12
  }], {
    parent: combat,
    dryRun: true,
    action: "update",
    documentName: "Combatant"
  }), /modifyDocumentBatch/i);
});

test("only the exact lifecycle context is reentrant for Combatant mutations", async () => {
  resetBehaviors();
  const combat = createCombat(["a", "b"]);
  const outerEntered = deferred();
  const outerGate = deferred();
  let contextId = "";
  let updateRuns = 0;
  combatantDocumentOperationBehavior = async () => {
    updateRuns += 1;
  };

  const outer = combat.runFalloutMawLifecycleOperation(
    "outer-test",
    async context => {
      contextId = context.contextId;
      outerEntered.resolve();
      await outerGate.promise;
    }
  );
  await outerEntered.promise;

  const matching = FalloutMaWCombatant.updateDocuments([{
    _id: "a",
    initiative: 10
  }], {
    parent: combat,
    [COMBAT_LIFECYCLE_CONTEXT_OPTION]: contextId
  });
  await matching;
  assert.equal(updateRuns, 1);

  const forged = FalloutMaWCombatant.updateDocuments([{
    _id: "b",
    initiative: 20
  }], {
    parent: combat,
    [COMBAT_LIFECYCLE_CONTEXT_OPTION]: "not-the-active-context"
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(updateRuns, 1);

  outerGate.resolve();
  await Promise.all([outer, forged]);
  assert.equal(updateRuns, 2);
});

test("a remote Combatant mutation keeps requester identity while the active GM holds its lifecycle lease", async () => {
  resetBehaviors();
  const combat = createCombat(["a"]);
  const requester = {
    id: "player",
    isGM: false,
    isActiveGM: false,
    ownsActors: true
  };
  const activeClient = {
    id: "authority",
    isGM: true,
    isActiveGM: true
  };
  const authority = {
    id: "authority",
    isSelf: false,
    async query(name, data) {
      const caller = globalThis.game.user;
      globalThis.game.user = activeClient;
      this.isSelf = true;
      try {
        return await globalThis.CONFIG.queries[name](data, { user: caller });
      } finally {
        this.isSelf = false;
        globalThis.game.user = caller;
      }
    }
  };
  globalThis.game.user = requester;
  globalThis.game.users.activeGM = authority;
  globalThis.game.users.contents = [requester, activeClient];

  const operationUsers = [];
  combatantDocumentOperationBehavior = async () => {
    operationUsers.push(globalThis.game.user.id);
  };
  combatantAuthorityBroadcastBehavior = async (documentClass, documents, operation, user) => {
    const localUser = globalThis.game.user;
    globalThis.game.user = activeClient;
    authority.isSelf = true;
    try {
      await documentClass._onUpdateOperation(documents, operation, user);
    } finally {
      authority.isSelf = false;
      globalThis.game.user = localUser;
    }
  };

  const updated = await FalloutMaWCombatant.updateDocuments([{
    _id: "a",
    initiative: 17
  }], { parent: combat });

  assert.equal(updated.length, 1);
  assert.equal(combat.combatants.get("a").initiative, 17);
  assert.deepEqual(operationUsers, ["player"]);
  assert.equal(combat.falloutMawLifecycleContextId, "");
});

test("created-resource defeated sync reuses its exact context without self-deadlocking", async () => {
  resetBehaviors();
  const combat = createCombat(["a", "b"]);
  combat.settings.skipDefeated = true;
  const defeatedCombatant = combat.combatants.get("a");
  defeatedCombatant.actor.statuses.add("dead");

  await combat.runFalloutMawLifecycleOperation(
    "created-resource-sync",
    ({ contextId }) => initializeCreatedCombatantResources(
      [defeatedCombatant],
      combat,
      { lifecycleContextId: contextId }
    )
  );

  assert.equal(defeatedCombatant.isDefeated, true);
  assert.equal(combat.turn, 1);
  assert.equal(combat.falloutMawLifecycleContextId, "");
});

test("last-turn and round-zero virtual delegation do not deadlock or double-process", async () => {
  resetBehaviors();
  const lastTurnCombat = createCombat(["a"], { round: 1, turn: 0 });
  await lastTurnCombat.nextTurn({ falloutMawConversionMode: TURN_CONVERSION_MODES.none });
  assert.equal(lastTurnCombat.round, 2);
  assert.equal(lastTurnCombat.updateCount, 1);
  assert.deepEqual(turnEvents, [
    "end:Actor.a:none",
    "start:Actor.a"
  ]);

  resetBehaviors();
  const unstartedCombat = createCombat(["a"], { round: 0, turn: null });
  await unstartedCombat.nextTurn();
  assert.equal(unstartedCombat.round, 1);
  assert.equal(unstartedCombat.updateCount, 1);
  assert.deepEqual(turnEvents, ["start:Actor.a"]);
});

test("a lifecycle rejection reaches its caller and does not poison the queue", async () => {
  resetBehaviors();
  let fail = true;
  turnEndBehavior = async () => {
    if (!fail) return;
    fail = false;
    throw new Error("turn lifecycle failed");
  };
  const combat = createCombat(["a", "b", "c"]);

  await assert.rejects(combat.nextTurn(), /turn lifecycle failed/);
  assert.equal(combat.updateCount, 1);
  await combat.nextTurn();
  assert.equal(combat.updateCount, 2);
  assert.equal(combat.turn, 2);
});

test("a rejected rewind does not mutate actors and a retry runs end-refresh-start-hook in order", async () => {
  resetBehaviors();
  const combat = createCombat(["a", "b"], { round: 2, turn: 1 });
  combat.updateBehavior = async changed => {
    if ("turn" in changed) throw new Error("combat update rejected");
  };

  await assert.rejects(combat.previousTurn(), /update rejected/);
  assert.equal(combat.turn, 1);
  assert.deepEqual(turnEvents, []);

  combat.updateBehavior = null;
  activeEffectRefreshBehavior = async reason => {
    turnEvents.push(`refresh:${reason}`);
  };
  combatTurnChangeBehavior = () => {
    turnEvents.push("hook:combatTurnChange");
  };
  await combat.previousTurn({ falloutMawConversionMode: TURN_CONVERSION_MODES.none });

  assert.equal(combat.turn, 0);
  assert.deepEqual(turnEvents, [
    "end:Actor.b:none",
    "refresh:combatRewind",
    "start:Actor.a",
    "hook:combatTurnChange"
  ]);
  assert.equal(turnEndContexts.at(-1)?.turnContext?.round, 2);
});

test("rewinding round one to zero ends the prior actor once without preparing a nonexistent turn", async () => {
  resetBehaviors();
  const combat = createCombat(["a"], { round: 1, turn: 0 });
  await combat.previousTurn({ falloutMawConversionMode: TURN_CONVERSION_MODES.none });

  assert.equal(combat.round, 0);
  assert.equal(combat.turn, null);
  assert.deepEqual(turnEvents, ["end:Actor.a:none"]);
  assert.equal(turnEndContexts[0]?.turnContext?.round, 1);
});

test("rewinding to round zero settles combat resources and combat-end effects", async () => {
  resetBehaviors();
  const combat = createCombat(["a"], { round: 1, turn: 0 });
  const actor = combat.combatant.actor;
  actor.system.resources = {
    actionPoints: { value: 1, spent: 3, max: 4 },
    movementPoints: { value: 1, spent: 3, max: 4 },
    reactionPoints: { value: 2, spent: 0, max: 2 },
    dodge: { value: 1, spent: 0, max: 10 }
  };
  actor.effects = [{
    id: "round-zero-combat-end",
    duration: { expiry: "combatEnd" },
    getFlag: () => null
  }];
  actor.update = async updates => {
    for (const [path, value] of Object.entries(updates)) {
      const match = /^system\.resources\.([^.]+)\.(value|spent)$/.exec(path);
      if (match) actor.system.resources[match[1]][match[2]] = value;
    }
    return actor;
  };
  actor.deleteEmbeddedDocuments = async (_documentName, ids) => {
    actor.effects = actor.effects.filter(effect => !ids.includes(effect.id));
    return [];
  };

  await combat.previousRound({
    falloutMawConversionMode: TURN_CONVERSION_MODES.none
  });

  assert.equal(combat.round, 0);
  assert.equal(actor.system.resources.actionPoints.value, 4);
  assert.equal(actor.system.resources.movementPoints.value, 4);
  assert.equal(actor.system.resources.reactionPoints.value, 0);
  assert.deepEqual(actor.effects, []);
});

test("different actors in one block serialize, while duplicate and stale actor requests cannot spill over", async () => {
  resetBehaviors();
  turnOrderScheme = "block";
  const combat = createCombat(["a", "b"]);
  const actorA = {
    [BLOCK_TURN_ACTOR_OPTION]: "Actor.a",
    falloutMawConversionMode: TURN_CONVERSION_MODES.none
  };
  const actorB = {
    [BLOCK_TURN_ACTOR_OPTION]: "Actor.b",
    falloutMawConversionMode: TURN_CONVERSION_MODES.none
  };

  const firstA = combat.nextTurn(actorA);
  const duplicateA = combat.nextTurn(actorA);
  const pendingB = combat.nextTurn(actorB);
  assert.strictEqual(duplicateA, firstA);
  await firstA;

  const staleA = combat.nextTurn(actorA);
  await assert.rejects(staleA, /turn changed/i);
  await pendingB;

  assert.equal(combat.round, 2);
  assert.deepEqual(
    turnEvents.filter(event => event.startsWith("end:")),
    ["end:Actor.a:none", "end:Actor.b:none"]
  );
});

test("block turn start can synchronize an incapacitated combatant inside its own lifecycle", async () => {
  resetBehaviors();
  turnOrderScheme = "block";
  const combat = createCombat(["a", "b"]);
  combat.settings.skipDefeated = true;
  const actorB = combat.combatants.get("b").actor;
  actorB.statuses.add("dead");

  const transition = combat.nextTurn({
    [BLOCK_TURN_ACTOR_OPTION]: "Actor.a",
    falloutMawConversionMode: TURN_CONVERSION_MODES.none
  });
  await Promise.race([
    transition,
    new Promise((_, reject) => globalThis.setTimeout(
      () => reject(new Error("block turn lifecycle did not settle")),
      250
    ))
  ]);

  assert.equal(combat.round, 2);
  assert.equal(combat.combatants.get("b").isDefeated, true);
  assert.equal(combat.falloutMawTurnTransitionPending, false);
});

test("an auto-completed block actor never consumes another actor's turn", async () => {
  resetBehaviors();
  turnOrderScheme = "block";
  const combat = createCombat(["a", "b"]);
  combat.settings.skipDefeated = true;
  const actorA = combat.combatants.get("a").actor;
  actorA.statuses.add("unconscious");

  await syncActorDefeatedCombatants(actorA, {
    combat,
    advanceCurrent: true
  });

  assert.equal(combat.round, 1);
  assert.equal(combat.turn, 0);
  assert.deepEqual(
    turnEvents.filter(event => event.startsWith("end:")),
    []
  );
  assert.deepEqual(
    getActiveBlockProgress(combat).state.completedActorUuids,
    ["Actor.a"]
  );
});

test("the last non-representative block actor becoming unconscious advances the block", async () => {
  resetBehaviors();
  turnOrderScheme = "block";
  const combat = createCombat(["a", "b", "next"]);
  combat.settings.skipDefeated = true;
  for (const id of ["a", "b"]) {
    combat.combatants.get(id).actor.getFlag = (_scope, key) => (
      key === "factionBelongs" ? ["active-block"] : null
    );
  }
  combat.combatants.get("next").actor.getFlag = (_scope, key) => (
    key === "factionBelongs" ? ["next-block"] : null
  );

  await combat.nextTurn({
    [BLOCK_TURN_ACTOR_OPTION]: "Actor.a",
    falloutMawConversionMode: TURN_CONVERSION_MODES.none
  });
  assert.equal(combat.turn, 0);

  const actorB = combat.combatants.get("b").actor;
  actorB.statuses.add("unconscious");
  Hooks.callAll("createActiveEffect", {
    parent: actorB,
    statuses: new Set(["unconscious"])
  });
  await new Promise(resolve => globalThis.setTimeout(resolve, 0));
  await combat.waitForFalloutMawTurnTransition();

  assert.equal(combat.combatants.get("b").isDefeated, true);
  assert.equal(combat.turn, 2);
  assert.equal(combat.falloutMawTurnTransitionPending, false);
});

test("removing the last incapacitating status by effect update clears defeated", async () => {
  resetBehaviors();
  const combat = createCombat(["a"]);
  combat.settings.skipDefeated = true;
  const combatant = combat.combatants.get("a");
  const actor = combatant.actor;
  actor.statuses.add("unconscious");
  await syncActorDefeatedCombatants(actor, { combat, advanceCurrent: false });
  assert.equal(combatant.isDefeated, true);

  actor.statuses.clear();
  Hooks.callAll("updateActiveEffect", {
    parent: actor,
    statuses: new Set()
  }, {
    statuses: []
  });
  await new Promise(resolve => globalThis.setTimeout(resolve, 0));
  await combat.waitForFalloutMawTurnTransition();

  assert.equal(combatant.isDefeated, false);
});

test("deleting the active block representative still starts the replacement block", async () => {
  resetBehaviors();
  turnOrderScheme = "block";
  const combat = createCombat(["a", "b"]);
  combat.combatants.get("a").actor.getFlag = (_scope, key) => (
    key === "factionBelongs" ? ["old-block"] : null
  );
  combat.combatants.get("b").actor.getFlag = (_scope, key) => (
    key === "factionBelongs" ? ["new-block"] : null
  );
  const previous = combat._getCurrentState();
  const removed = combat.combatants.get("a");
  combat.turns = [combat.combatants.get("b")];
  combat.combatants.contents = [combat.combatants.get("b")];
  combat.combatants.index.delete(removed.id);
  combat.turn = 0;
  combat.previous = previous;
  combat.current = combat._getCurrentState();

  const refreshEvents = [];
  activeEffectRefreshBehavior = async event => refreshEvents.push(event);
  await combat._manageTurnEvents();

  assert.deepEqual(
    refreshEvents.filter(event => event === "turnStart"),
    ["turnStart"]
  );
  assert.deepEqual(turnEvents, ["start:Actor.b"]);
});

test("block lifecycle work is constant across block sizes and targets every block token once", async () => {
  for (const blockSize of [1, 3, 20]) {
    resetBehaviors();
    turnOrderScheme = "block";
    const oldIds = Array.from({ length: blockSize }, (_, index) => `old-${index}`);
    const combat = createCombat([...oldIds, "next"]);
    for (const id of oldIds) {
      const actor = combat.combatants.get(id).actor;
      actor.getFlag = (_scope, key) => key === "factionBelongs" ? ["old-faction"] : null;
    }
    combat.combatants.get("next").actor.getFlag = (_scope, key) => (
      key === "factionBelongs" ? ["next-faction"] : null
    );

    const refreshEvents = [];
    activeEffectRefreshBehavior = async event => {
      if (event === "turnEnd" || event === "turnStart") refreshEvents.push(event);
    };
    let movementClears = 0;
    combat._clearMovementHistoryOnStartTurn = async () => {
      movementClears += 1;
    };
    let turnChangeHooks = 0;
    combatTurnChangeBehavior = () => {
      turnChangeHooks += 1;
    };
    const regionEvents = [];
    for (const combatant of combat.turns) {
      combatant.token = {
        regions: [{
          _triggerEvent: async event => {
            regionEvents.push(`${combatant.id}:${event}`);
          }
        }]
      };
    }

    for (const id of oldIds) {
      await combat.nextTurn({
        [BLOCK_TURN_ACTOR_OPTION]: `Actor.${id}`,
        falloutMawConversionMode: TURN_CONVERSION_MODES.none
      });
    }

    assert.equal(combat.turn, blockSize);
    assert.deepEqual(refreshEvents, ["turnEnd", "turnStart"]);
    assert.equal(movementClears, 1);
    assert.equal(turnChangeHooks, 1);
    assert.deepEqual(
      regionEvents.filter(event => event.endsWith(":tokenTurnEnd")).sort(),
      oldIds.map(id => `${id}:tokenTurnEnd`).sort()
    );
    assert.deepEqual(
      regionEvents.filter(event => event.endsWith(":tokenTurnStart")),
      ["next:tokenTurnStart"]
    );
  }
});

test("changing the representative index inside one block emits no duplicate lifecycle", async () => {
  resetBehaviors();
  turnOrderScheme = "block";
  const combat = createCombat(["a", "b", "c"]);
  const refreshEvents = [];
  activeEffectRefreshBehavior = async event => refreshEvents.push(event);
  let movementClears = 0;
  combat._clearMovementHistoryOnStartTurn = async () => {
    movementClears += 1;
  };
  let turnChangeHooks = 0;
  combatTurnChangeBehavior = () => {
    turnChangeHooks += 1;
  };

  await combat.setTurn(1);

  assert.equal(combat.turn, 1);
  assert.deepEqual(refreshEvents, []);
  assert.equal(movementClears, 0);
  assert.equal(turnChangeHooks, 1);
});

test("block combat start preserves Foundry round-zero end events", async () => {
  resetBehaviors();
  turnOrderScheme = "block";
  const combat = createCombat(["a"], { round: 0, turn: null });
  const regionEvents = [];
  combat.combatants.get("a").token = {
    regions: [{
      _triggerEvent: async event => {
        regionEvents.push(event);
      }
    }]
  };
  const refreshEvents = [];
  activeEffectRefreshBehavior = async event => refreshEvents.push(event);

  await combat.startCombat();

  assert.deepEqual(refreshEvents, [
    "roundEnd",
    "roundStart",
    "turnStart",
    "combatStart"
  ]);
  assert.equal(regionEvents.filter(event => event === "tokenRoundEnd").length, 1);
});

test("block round boundary preserves the Foundry lifecycle order once", async () => {
  resetBehaviors();
  turnOrderScheme = "block";
  const combat = createCombat(["a"]);
  const order = [];
  const originalEndTurn = combat._onEndTurn.bind(combat);
  const originalStartRound = combat._onStartRound.bind(combat);
  const originalStartTurn = combat._onStartTurn.bind(combat);
  combat._onEndTurn = async (...args) => {
    order.push("turnEnd");
    return originalEndTurn(...args);
  };
  combat._onEndRound = async () => {
    order.push("roundEnd");
  };
  combat._onStartRound = async (...args) => {
    order.push("roundStart");
    return originalStartRound(...args);
  };
  combat._onStartTurn = async (...args) => {
    order.push("turnStart");
    return originalStartTurn(...args);
  };
  combat._clearMovementHistoryOnStartTurn = async () => {
    order.push("movement");
  };
  activeEffectRefreshBehavior = async event => {
    if (["turnEnd", "roundEnd", "roundStart", "turnStart"].includes(event)) {
      order.push(`effect:${event}`);
    }
  };

  await combat.nextTurn({
    [BLOCK_TURN_ACTOR_OPTION]: "Actor.a",
    falloutMawConversionMode: TURN_CONVERSION_MODES.none
  });

  assert.equal(combat.round, 2);
  assert.deepEqual(order, [
    "turnEnd",
    "effect:turnEnd",
    "roundEnd",
    "effect:roundEnd",
    "roundStart",
    "effect:roundStart",
    "turnStart",
    "movement",
    "effect:turnStart"
  ]);
});

test("block marker refresh preserves meshes for actors who remain active", () => {
  resetBehaviors();
  turnOrderScheme = "block";
  const combat = createCombat(["a", "b"]);
  combat.isView = true;
  const refreshed = [];
  const tokens = combat.turns.map((combatant, index) => {
    const token = {
      turnMarker: {},
      renderFlags: {
        set: () => refreshed.push(combatant.id)
      }
    };
    combatant.token = { _object: token };
    combatant.tokenId = `token-${index}`;
    return token;
  });
  const stale = {
    turnMarker: {},
    renderFlags: {
      set: () => refreshed.push("stale")
    }
  };

  globalThis.canvas.ready = true;
  globalThis.canvas.tokens.turnMarkers = new Set([...tokens, stale]);
  try {
    combat._updateTurnMarkers();
    assert.deepEqual(refreshed, ["stale"]);

    refreshed.length = 0;
    globalThis.canvas.tokens.turnMarkers.delete(stale);
    globalThis.canvas.tokens.turnMarkers.delete(tokens[1]);
    tokens[1].turnMarker = null;
    combat._updateTurnMarkers();
    assert.deepEqual(refreshed, ["b"]);
  } finally {
    globalThis.canvas.ready = false;
    globalThis.canvas.tokens.turnMarkers = [];
  }
});

test("a rejected block-state write performs no actor end mutations", async () => {
  resetBehaviors();
  turnOrderScheme = "block";
  const combat = createCombat(["a", "b"]);
  let rejectFlagUpdate = true;
  combat.updateBehavior = async changed => {
    if (!rejectFlagUpdate || !Object.keys(changed).some(key => key.startsWith("flags."))) return;
    rejectFlagUpdate = false;
    throw new Error("block state rejected");
  };
  const actorA = {
    [BLOCK_TURN_ACTOR_OPTION]: "Actor.a",
    falloutMawConversionMode: TURN_CONVERSION_MODES.none
  };

  await assert.rejects(combat.nextTurn(actorA), /block state rejected/);
  assert.deepEqual(turnEvents, []);
  assert.deepEqual(getActiveBlockProgress(combat).state.completedActorUuids, []);

  await combat.nextTurn(actorA);
  assert.deepEqual(
    turnEvents.filter(event => event.startsWith("end:")),
    ["end:Actor.a:none"]
  );
});

test("a fully completed block can retry a failed round advance without ending actors twice", async () => {
  resetBehaviors();
  turnOrderScheme = "block";
  const combat = createCombat(["a", "b"]);
  await combat.nextTurn({
    [BLOCK_TURN_ACTOR_OPTION]: "Actor.a",
    falloutMawConversionMode: TURN_CONVERSION_MODES.none
  });
  let rejectRoundAdvance = true;
  combat.updateBehavior = async changed => {
    if (!rejectRoundAdvance || !Object.hasOwn(changed, "round")) return;
    rejectRoundAdvance = false;
    throw new Error("round advance rejected");
  };

  await assert.rejects(combat.nextTurn({
    [BLOCK_TURN_ACTOR_OPTION]: "Actor.b",
    falloutMawConversionMode: TURN_CONVERSION_MODES.none
  }), /round advance rejected/);
  assert.equal(combat.round, 1);
  assert.equal(isActiveBlockComplete(combat), true);
  assert.deepEqual(
    turnEvents.filter(event => event.startsWith("end:")),
    ["end:Actor.a:none", "end:Actor.b:none"]
  );

  await combat.nextTurn();
  assert.equal(combat.round, 2);
  assert.deepEqual(
    turnEvents.filter(event => event.startsWith("end:")),
    ["end:Actor.a:none", "end:Actor.b:none"]
  );
});

test("startCombat awaits actor preparation before the Foundry combatStart refresh", async () => {
  resetBehaviors();
  const combat = createCombat(["a"], { round: 0, turn: null });
  activeEffectRefreshBehavior = async reason => {
    turnEvents.push(`refresh:${reason}`);
  };

  await combat.startCombat();

  assert.equal(combat.round, 1);
  assert.deepEqual(turnEvents, [
    "start:Actor.a",
    "refresh:combatStart"
  ]);
});

test("the initial turn removes a stale in-turn reaction AP effect", async () => {
  resetBehaviors();
  const combat = createCombat(["a"], { round: 0, turn: null });
  const actor = combat.turns[0].actor;
  const createEffect = (id, source) => ({
    id,
    getFlag: (_scope, key) => (
      key === "oneTimeActionPoints" ? { source } : null
    )
  });
  actor.effects = [
    createEffect("stale-in-turn-reaction", "inTurnReaction"),
    createEffect("unrelated-one-time-ap", "abilityGrant")
  ];
  const deletedEffectIds = [];
  actor.deleteEmbeddedDocuments = async (_documentName, ids) => {
    deletedEffectIds.push(...ids);
    actor.effects = actor.effects.filter(effect => !ids.includes(effect.id));
    return [];
  };

  await combat.startCombat();

  assert.deepEqual(deletedEffectIds, ["stale-in-turn-reaction"]);
  assert.deepEqual(actor.effects.map(effect => effect.id), ["unrelated-one-time-ap"]);
});

test("turn start batches temporary effect deletion and resource restoration", async () => {
  resetBehaviors();
  const actor = createActor("batched-start");
  actor.system.resources = {
    actionPoints: { value: 1, spent: 3, max: 4 },
    movementPoints: { value: 2, spent: 2, max: 4 },
    reactionPoints: { value: 2, spent: 0, max: 2 }
  };
  const flags = {
    once: ["oneTimeActionPoints", { source: "inTurnReaction" }],
    dodge: ["reactionDodgeConversion", true],
    reaction: ["reactionPointsConversion", true]
  };
  actor.effects = Object.entries(flags).map(([id, [flagKey, value]]) => ({
    id,
    getFlag: (_scope, key) => key === flagKey ? value : null
  }));
  const deleteCalls = [];
  actor.deleteEmbeddedDocuments = async (_documentName, ids) => {
    deleteCalls.push(Array.from(ids));
    actor.effects = actor.effects.filter(effect => !ids.includes(effect.id));
    return [];
  };
  const updateCalls = [];
  actor.update = async (updates, options) => {
    updateCalls.push({ updates, options });
  };

  await prepareActorTurnStart(actor, { combat: null });

  assert.deepEqual(deleteCalls, [["once", "dodge", "reaction"]]);
  assert.equal(updateCalls.length, 1);
  assert.deepEqual(updateCalls[0].updates, {
    "system.resources.actionPoints.value": 4,
    "system.resources.actionPoints.spent": 0,
    "system.resources.movementPoints.value": 4,
    "system.resources.movementPoints.spent": 0,
    "system.resources.reactionPoints.value": 0,
    "system.resources.reactionPoints.spent": 2
  });
  assert.equal(updateCalls[0].options.falloutMawReactionResourceUpdate, true);
});

test("turn resource lifecycle skips already-correct Actor updates", async () => {
  resetBehaviors();
  const actor = createActor("no-op-resources");
  actor.system.resources = {
    actionPoints: { value: 4, spent: 0, max: 4 },
    movementPoints: { value: 4, spent: 0, max: 4 },
    reactionPoints: { value: 0, spent: 2, max: 2 }
  };
  let updateCalls = 0;
  actor.update = async () => {
    updateCalls += 1;
  };

  await prepareActorTurnStart(actor, { combat: null });

  assert.equal(updateCalls, 0);
});

test("turn start clears a corrupt stored movement-spending stack", async () => {
  resetBehaviors();
  const actor = createActor("corrupt-movement-stack");
  actor.system.resources = {
    actionPoints: { value: 4, spent: 0, max: 4 },
    movementPoints: { value: 4, spent: 0, max: 4 },
    reactionPoints: { value: 0, spent: 2, max: 2 }
  };
  actor.getFlag = (_scope, key) => (
    key === "movementResourceSpending" ? { invalid: true } : null
  );
  const updates = [];
  actor.update = async update => {
    updates.push(update);
  };

  await prepareActorTurnStart(actor, { combat: null });

  assert.deepEqual(updates, [{
    "flags.fallout-maw.movementResourceSpending": []
  }]);
});

test("turn end closes movement, action, and reaction resources in one Actor update", async () => {
  resetBehaviors();
  const actor = createActor("batched-end");
  actor.system.resources = {
    actionPoints: { value: 2, spent: 2, max: 4 },
    movementPoints: { value: 1, spent: 3, max: 4 },
    reactionPoints: { value: 0, spent: 2, max: 2 }
  };
  const updateCalls = [];
  actor.update = async (updates, options) => {
    updateCalls.push({ updates, options });
  };

  await prepareActorTurnEnd(actor, {
    conversionMode: TURN_CONVERSION_MODES.none,
    combat: null
  });

  assert.equal(updateCalls.length, 1);
  assert.deepEqual(updateCalls[0].updates, {
    "system.resources.actionPoints.value": 0,
    "system.resources.actionPoints.spent": 4,
    "system.resources.movementPoints.value": 0,
    "system.resources.movementPoints.spent": 4,
    "system.resources.reactionPoints.value": 2,
    "system.resources.reactionPoints.spent": 0
  });
  assert.equal(updateCalls[0].options.falloutMawReactionResourceUpdate, true);
});

test("a failed combat-start resource initialization cannot poison later turns", async () => {
  resetBehaviors();
  const combat = createCombat(["a", "b"], { round: 0, turn: null });
  const nextActor = combat.turns[1].actor;
  nextActor.system.resources.reactionPoints = { value: 0, spent: 2, max: 2 };
  let rejectInitialization = true;
  nextActor.update = async () => {
    if (rejectInitialization) {
      rejectInitialization = false;
      throw new Error("initialization failed");
    }
  };

  await combat.startCombat();
  await combat.nextTurn({
    falloutMawConversionMode: TURN_CONVERSION_MODES.none
  });

  assert.equal(combat.turn, 1);
  assert.equal(turnEvents.includes("start:Actor.b"), true);
});

test("round transition waits for queued world-time work before preparing the new turn", async () => {
  resetBehaviors();
  const processorStarted = deferred();
  const releaseProcessor = deferred();
  worldTimeProcessorBehavior = async () => {
    processorStarted.resolve();
    await releaseProcessor.promise;
  };
  const combat = createCombat(["a"], { round: 1, turn: 0 });
  const transition = combat.nextTurn({
    falloutMawConversionMode: TURN_CONVERSION_MODES.none
  });

  await processorStarted.promise;
  await Promise.resolve();
  assert.equal(turnEvents.some(event => event.startsWith("start:")), false);

  releaseProcessor.resolve();
  await transition;
  assert.deepEqual(turnEvents, [
    "end:Actor.a:none",
    "start:Actor.a"
  ]);
});

test("round transition also awaits the external world-time system event", async () => {
  resetBehaviors();
  const eventStarted = deferred();
  const releaseEvent = deferred();
  worldTimeEventBehavior = async () => {
    eventStarted.resolve();
    await releaseEvent.promise;
  };
  const combat = createCombat(["a"], { round: 1, turn: 0 });
  const transition = combat.nextTurn({
    falloutMawConversionMode: TURN_CONVERSION_MODES.none
  });

  await eventStarted.promise;
  await Promise.resolve();
  assert.equal(turnEvents.some(event => event.startsWith("start:")), false);

  releaseEvent.resolve();
  await transition;
  assert.deepEqual(turnEvents, [
    "end:Actor.a:none",
    "start:Actor.a"
  ]);
});

test("non-active clients route standard tracker navigation to the active GM", async () => {
  resetBehaviors();
  const combat = createCombat(["a", "b"]);
  globalThis.game.user.isActiveGM = false;
  globalThis.game.users.activeGM = { id: "other-gm", isSelf: false };

  const routed = combat.nextTurn();
  const request = socketMessages.find(entry => (
    entry.message?.scope === COMBAT_TURN_SOCKET_SCOPE
    && entry.message?.type === "request"
  ));
  assert.ok(request);
  assert.equal(request.message.targetUserId, "other-gm");
  assert.equal(request.message.method, "nextTurn");
  assert.equal(combat.turn, 0);
  assert.equal(combat.updateCount, 0);
  assert.deepEqual(turnEvents, []);

  let routedSettled = false;
  void routed.then(() => {
    routedSettled = true;
  });
  deliverSocketMessage(request.channel, {
    scope: COMBAT_TURN_SOCKET_SCOPE,
    type: "response",
    requestId: request.message.requestId,
    targetUserId: "gm",
    authorityUserId: "forged-gm",
    ok: true
  });
  await Promise.resolve();
  assert.equal(routedSettled, false);

  deliverSocketMessage(request.channel, {
    scope: COMBAT_TURN_SOCKET_SCOPE,
    type: "response",
    requestId: request.message.requestId,
    targetUserId: "gm",
    authorityUserId: "other-gm",
    ok: true
  });
  await routed;
  assert.equal(combat.turn, 0);
});

test("an old authority response rejects immediately after active-GM failover", async () => {
  resetBehaviors();
  const combat = createCombat(["a", "b"]);
  globalThis.game.user.isActiveGM = false;
  globalThis.game.users.activeGM = { id: "old-gm", isSelf: false };

  const routed = combat.nextTurn();
  const request = socketMessages.find(entry => (
    entry.message?.scope === COMBAT_TURN_SOCKET_SCOPE
    && entry.message?.type === "request"
  ));
  assert.ok(request);
  globalThis.game.users.activeGM = { id: "new-gm", isSelf: false };
  deliverSocketMessage(request.channel, {
    scope: COMBAT_TURN_SOCKET_SCOPE,
    type: "response",
    requestId: request.message.requestId,
    targetUserId: "gm",
    authorityUserId: "old-gm",
    ok: true
  });

  await assert.rejects(routed, /authority changed/i);
  assert.equal(combat.turn, 0);
});

test("active-GM socket execution enforces ownership before using the combat queue", async () => {
  resetBehaviors();
  const combat = createCombat(["a", "b"]);
  combat.canUserModify = () => true;
  const player = { id: "player", isGM: false, ownsActors: true };
  globalThis.game.users.contents = [player];
  globalThis.game.user.id = "active-gm";
  globalThis.game.user.isGM = true;
  globalThis.game.user.isActiveGM = true;
  globalThis.game.users.activeGM = { id: "active-gm", isSelf: true };

  await performCombatTurnNavigationRequest({
    requesterUserId: player.id,
    combatId: combat.id,
    method: "nextTurn",
    options: { falloutMawConversionMode: TURN_CONVERSION_MODES.none }
  });
  assert.equal(combat.turn, 1);

  const unauthorized = { id: "spectator", isGM: false, ownsActors: false };
  globalThis.game.users.contents.push(unauthorized);
  await assert.rejects(performCombatTurnNavigationRequest({
    requesterUserId: unauthorized.id,
    combatId: combat.id,
    method: "previousTurn"
  }), /does not own/i);
  assert.equal(combat.turn, 1);
});

test("movement detection accepts the ending round instead of reading the already advanced combat", () => {
  resetBehaviors();
  const actor = createActor("moving");
  actor.getFlag = () => [{
    actorUuid: actor.uuid,
    round: 3,
    resources: { movementPoints: 1 }
  }];

  assert.equal(hasActorCombatMovementInCurrentTurn(actor, { round: 3 }), true);
  assert.equal(hasActorCombatMovementInCurrentTurn(actor, { round: 2 }), false);
});

test("Combatant pre-operations calculate Foundry turn data only after the parent lifecycle settles", async () => {
  resetBehaviors();
  for (const [method, label] of [
    ["_preCreateOperation", "create"],
    ["_preDeleteOperation", "delete"]
  ]) {
    const gate = deferred();
    const parent = {
      turn: 0,
      async waitForFalloutMawTurnTransition() {
        combatantOperationEvents.push(`wait-${label}:start`);
        await gate.promise;
        combatantOperationEvents.push(`wait-${label}:end`);
      }
    };
    const operation = { parent };
    const pending = FalloutMaWCombatant[method]([], operation, globalThis.game.user);

    await Promise.resolve();
    assert.deepEqual(combatantOperationEvents, [`wait-${label}:start`]);
    parent.turn = 1;
    gate.resolve();
    await pending;
    assert.deepEqual(combatantOperationEvents, [
      `wait-${label}:start`,
      `wait-${label}:end`,
      `super-${label}:1`
    ]);
    combatantOperationEvents = [];
  }
});

test("Combatant creation awaits the single core combatStart refresh", async () => {
  resetBehaviors();
  const combat = createCombat(["a"]);
  const created = createCombatant("b");
  created.combat = combat;
  const refreshStarted = deferred();
  const releaseRefresh = deferred();
  let refreshCalls = 0;
  activeEffectRefreshBehavior = reason => {
    if (reason !== "combatStart") return Promise.resolve();
    refreshCalls += 1;
    refreshStarted.resolve();
    return releaseRefresh.promise;
  };

  combat._onCreateDescendantDocuments(
    combat,
    "combatants",
    [created],
    [],
    {},
    globalThis.game.user.id
  );
  const operation = FalloutMaWCombatant._onCreateOperation(
    [created],
    { parent: combat },
    globalThis.game.user
  );
  let settled = false;
  void operation.then(() => {
    settled = true;
  });

  await refreshStarted.promise;
  await Promise.resolve();
  assert.equal(refreshCalls, 1);
  assert.equal(settled, false);
  assert.equal(Object.hasOwn(globalThis.ActiveEffect.registry, "refresh"), false);

  releaseRefresh.resolve();
  await operation;
  assert.equal(settled, true);
});

test("awaited Combat deletion cleanup starts only after the turn queue settles", async () => {
  resetBehaviors();
  const endStarted = deferred();
  const releaseEnd = deferred();
  turnEndBehavior = async () => {
    endStarted.resolve();
    await releaseEnd.promise;
  };
  let deletionSettled = false;
  combatDeletionSettledBehavior = () => {
    deletionSettled = true;
  };
  const combat = createCombat(["a", "b"]);
  const transition = combat.nextTurn();
  await endStarted.promise;
  globalThis.game.combats.contents = [];
  const deletion = FalloutMaWCombat._onDeleteOperation([combat], {}, globalThis.game.user);

  await Promise.resolve();
  assert.equal(deletionSettled, false);
  releaseEnd.resolve();
  await Promise.all([transition, deletion]);
  assert.equal(deletionSettled, true);
});

test("duplicate delete calls share one awaited deletion lifecycle", async () => {
  resetBehaviors();
  let settledCount = 0;
  combatDeletionSettledBehavior = () => {
    settledCount += 1;
  };
  const combat = createCombat(["a"]);

  const first = combat.delete();
  const second = combat.delete();
  assert.strictEqual(second, first);
  await first;
  assert.equal(settledCount, 1);
});

test("a cancelled instance deletion releases the turn lifecycle guard", async () => {
  resetBehaviors();
  const combat = createCombat(["a", "b"]);
  FakeCombat.deleteResultIds = [];

  const deleted = await combat.delete();
  assert.equal(deleted, undefined);
  assert.deepEqual(globalThis.game.combats.contents, [combat]);

  await combat.nextTurn();
  assert.equal(combat.turn, 1);
});

test("a remotely cancelled deletion releases the requesting client's guard", async () => {
  resetBehaviors();
  const combat = createCombat(["a", "b"]);
  globalThis.game.user.isActiveGM = false;
  globalThis.game.users.activeGM = { id: "other-gm", isSelf: false };

  const deletion = combat.delete();
  let request;
  for (let index = 0; index < 10 && !request; index += 1) {
    await Promise.resolve();
    request = socketMessages.find(entry => (
      entry.message?.scope === COMBAT_TURN_SOCKET_SCOPE
      && entry.message?.type === "request"
      && entry.message?.method === "delete"
    ));
  }
  assert.ok(request);
  deliverSocketMessage(request.channel, {
    scope: COMBAT_TURN_SOCKET_SCOPE,
    type: "response",
    requestId: request.message.requestId,
    targetUserId: "gm",
    authorityUserId: "other-gm",
    ok: false,
    error: "Combat deletion was cancelled."
  });
  await assert.rejects(deletion, /cancelled/i);

  globalThis.game.user.isActiveGM = true;
  globalThis.game.users.activeGM = { id: "gm", isSelf: true };
  await combat.nextTurn();
  assert.equal(combat.turn, 1);
});

test("an inactive GM dry-run never routes or deletes a Combat", async () => {
  resetBehaviors();
  const combat = createCombat(["a"]);
  globalThis.game.user.isActiveGM = false;
  globalThis.game.users.activeGM = { id: "other-gm", isSelf: false };

  const result = await FalloutMaWCombat.deleteDocuments([combat.id], { dryRun: true });

  assert.deepEqual(result, [combat.id]);
  assert.deepEqual(globalThis.game.combats.contents, [combat]);
  assert.equal(socketMessages.some(entry => entry.message?.method === "delete"), false);
});

test("instance dry-run preserves the Combat and never poisons its lifecycle guard", async () => {
  for (const active of [true, false]) {
    resetBehaviors();
    const combat = createCombat(["a", "b"]);
    globalThis.game.user.isActiveGM = active;
    globalThis.game.users.activeGM = active
      ? { id: "gm", isSelf: true }
      : { id: "other-gm", isSelf: false };

    const result = await combat.delete({ dryRun: true });

    assert.equal(result, combat.id);
    assert.deepEqual(globalThis.game.combats.contents, [combat]);
    assert.equal(socketMessages.some(entry => entry.message?.method === "delete"), false);
    globalThis.game.user.isActiveGM = true;
    globalThis.game.users.activeGM = { id: "gm", isSelf: true };
    await combat.nextTurn();
    assert.equal(combat.turn, 1);
  }
});

test("a partial static batch deletion releases guards on surviving combats", async () => {
  resetBehaviors();
  const first = createCombat(["a"], { id: "combat-one" });
  const second = createCombat(["b", "c"], { id: "combat-two" });
  globalThis.game.combats.contents = [first, second];
  globalThis.game.combat = second;
  FakeCombat.deleteResultIds = [first.id];

  const deleted = await FalloutMaWCombat.deleteDocuments([first.id, second.id]);

  assert.deepEqual(deleted, [first]);
  assert.deepEqual(globalThis.game.combats.contents, [second]);
  await second.nextTurn();
  assert.equal(second.turn, 1);
});

test("combat deletion waits for the single captured core combatEnd refresh", async () => {
  resetBehaviors();
  assert.equal(Object.hasOwn(globalThis.ActiveEffect.registry, "refresh"), false);
  const refreshStarted = deferred();
  const releaseRefresh = deferred();
  let combatEndRefreshCalls = 0;
  activeEffectRefreshBehavior = reason => {
    if (reason !== "combatEnd") return Promise.resolve();
    combatEndRefreshCalls += 1;
    if (combatEndRefreshCalls === 1) {
      refreshStarted.resolve();
      return releaseRefresh.promise;
    }
    return Promise.resolve();
  };
  let deletionSettled = false;
  combatDeletionSettledBehavior = () => {
    deletionSettled = true;
  };
  const combat = createCombat(["a"]);
  const deletion = combat.delete();

  await refreshStarted.promise;
  await Promise.resolve();
  assert.equal(combatEndRefreshCalls, 1);
  assert.equal(deletionSettled, false);

  releaseRefresh.resolve();
  await deletion;
  assert.equal(deletionSettled, true);
  assert.equal(Object.hasOwn(globalThis.ActiveEffect.registry, "refresh"), false);
});

test("a rejected combatEnd refresh is reported but cannot strand deletion cleanup", async () => {
  resetBehaviors();
  let firstRefresh = true;
  activeEffectRefreshBehavior = reason => {
    if (reason === "combatEnd" && firstRefresh) {
      firstRefresh = false;
      return Promise.reject(new Error("refresh failed"));
    }
    return Promise.resolve();
  };
  let deletionSettled = false;
  combatDeletionSettledBehavior = () => {
    deletionSettled = true;
  };
  const combat = createCombat(["a"]);

  await combat.delete();
  assert.equal(deletionSettled, true);
});

test("end-combat cleanup deduplicates combatants, ignores scene actors, and skips another active combat", async () => {
  resetBehaviors();
  const createResourceActor = id => {
    const actor = createActor(id);
    actor.system.resources = {
      movementPoints: { value: 0, spent: 5, max: 5 },
      actionPoints: { value: 0, spent: 4, max: 4 },
      reactionPoints: { value: 2, spent: 0, max: 2 },
      dodge: { value: 1, spent: 0, max: 10 }
    };
    actor.updateCount = 0;
    actor.deletedEffectIds = [];
    actor.update = async updates => {
      actor.updateCount += 1;
      for (const [path, value] of Object.entries(updates)) {
        if (!path.startsWith("system.resources.")) continue;
        const [, , key, field] = path.split(".");
        actor.system.resources[key][field] = value;
      }
    };
    actor.deleteEmbeddedDocuments = async (_type, ids) => {
      actor.deletedEffectIds.push(...ids);
      actor.effects = actor.effects.filter(effect => !ids.includes(effect.id));
      return [];
    };
    return actor;
  };
  const actorA = createResourceActor("cleanup-a");
  const actorB = createResourceActor("cleanup-b");
  const outsider = createResourceActor("outsider");
  actorA.effects.push({
    id: "stale-in-turn-reaction",
    getFlag: (_scope, key) => (
      key === "oneTimeActionPoints"
        ? { source: "inTurnReaction" }
        : null
    )
  });
  const deletedCombat = {
    combatants: [
      { actor: actorA },
      { actor: actorA },
      { actor: actorB }
    ],
    scene: {
      tokens: { contents: [{ actor: outsider }] }
    }
  };
  globalThis.game.combats.contents = [];

  const cleaned = await cleanupDeletedCombatResources(deletedCombat);
  assert.deepEqual(cleaned.cleanedActorUuids, [actorA.uuid, actorB.uuid]);
  assert.equal(actorA.updateCount, actorB.updateCount);
  assert.ok(actorA.updateCount > 0);
  assert.deepEqual(actorA.deletedEffectIds, ["stale-in-turn-reaction"]);
  assert.equal(outsider.updateCount, 0);

  actorB.updateCount = 0;
  globalThis.game.combats.contents = [{
    started: true,
    combatants: [{ actor: actorB }]
  }];
  const skipped = await cleanupDeletedCombatResources({
    combatants: [{ actor: actorB }]
  });
  assert.deepEqual(skipped.skippedActorUuids, [actorB.uuid]);
  assert.equal(actorB.updateCount, 0);
});

test("removing the last combatant expires combat-end effects only for a started combat", async () => {
  resetBehaviors();
  const actor = createActor("detached-combatant");
  actor.system.resources.reactionPoints = { value: 2, spent: 0, max: 2 };
  actor.updateCount = 0;
  actor.update = async () => {
    actor.updateCount += 1;
  };
  actor.effects = [{
    id: "combat-end-effect",
    duration: { expiry: "combatEnd" },
    getFlag: () => null
  }, {
    id: "persistent-effect",
    duration: { expiry: null },
    getFlag: () => null
  }];
  const deletedEffectIds = [];
  actor.deleteEmbeddedDocuments = async (_documentName, ids) => {
    deletedEffectIds.push(...ids);
    actor.effects = actor.effects.filter(effect => !ids.includes(effect.id));
    return [];
  };
  globalThis.game.combats.contents = [];

  await cleanupDeletedCombatantResources(
    [{ actor }, { actor }],
    { started: true }
  );

  assert.deepEqual(deletedEffectIds, ["combat-end-effect"]);
  assert.deepEqual(actor.effects.map(effect => effect.id), ["persistent-effect"]);

  actor.effects.unshift({
    id: "unstarted-combat-end-effect",
    duration: { expiry: "combatEnd" },
    getFlag: (_scope, key) => (
      key === "oneTimeActionPoints" ? { source: "inTurnReaction" } : null
    )
  });
  actor.updateCount = 0;
  await cleanupDeletedCombatantResources([{ actor }], { started: false });
  assert.deepEqual(deletedEffectIds, ["combat-end-effect"]);
  assert.equal(actor.updateCount, 0);
  assert.equal(actor.effects.some(effect => effect.id === "unstarted-combat-end-effect"), true);

  const otherCombat = {
    started: true,
    combatants: [{ actor }]
  };
  globalThis.game.combats.contents = [otherCombat];
  const skipped = await cleanupDeletedCombatantResources([{ actor }], { started: true });
  assert.deepEqual(skipped.skippedActorUuids, [actor.uuid]);
  assert.deepEqual(deletedEffectIds, ["combat-end-effect"]);
});
