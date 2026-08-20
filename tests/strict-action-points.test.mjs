import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  canSpendStrictActionPoints,
  getActorActiveCombat,
  isActorInActiveCombat,
  refundStrictActionPointReceipt,
  spendStrictActionPointsWithReceipt,
  spendStrictActionPoints
} from "../src/combat/strict-action-points.mjs";
import {
  COMBAT_ONLY_RESOURCE_KEYS,
  isCombatResourceCostActive
} from "../src/combat/resource-cost-policy.mjs";

function createActor(uuid = "Actor.A", value = 10) {
  const actor = {
    uuid,
    name: "Актёр",
    isOwner: true,
    system: {
      combat: { stun: 0 },
      resources: { actionPoints: { value, max: 10 } }
    },
    updates: [],
    async update(changes) {
      this.updates.push(changes);
      if (changes["system.resources.actionPoints.value"] !== undefined) {
        this.system.resources.actionPoints.value = changes["system.resources.actionPoints.value"];
      }
    }
  };
  return actor;
}

test("strict ОД are free outside combat and for actors outside somebody else's combat", async () => {
  const actor = createActor();
  globalThis.game = { combat: null };
  assert.equal(isActorInActiveCombat(actor), false);
  assert.equal(canSpendStrictActionPoints(actor, 99), true);
  await spendStrictActionPoints(actor, 5);
  assert.equal(actor.system.resources.actionPoints.value, 10);
  assert.equal(actor.updates.length, 0);

  globalThis.game = {
    combat: { started: true, combatants: [{ actor: { uuid: "Actor.B" } }] }
  };
  assert.equal(isActorInActiveCombat(actor), false);
  await spendStrictActionPoints(actor, 5);
  assert.equal(actor.system.resources.actionPoints.value, 10);
  assert.equal(actor.updates.length, 0);
});

test("strict ОД are checked and spent for an active combat participant", async () => {
  const actor = createActor("Actor.A", 7);
  const warnings = [];
  globalThis.ui = { notifications: { warn: message => warnings.push(message) } };
  globalThis.game = {
    combat: { started: true, combatants: [{ actor }] }
  };
  assert.equal(isActorInActiveCombat(actor), true);
  assert.equal(canSpendStrictActionPoints(actor, 8), false);
  assert.equal(warnings.length, 1);
  assert.equal(canSpendStrictActionPoints(actor, 5), true);
  await spendStrictActionPoints(actor, 5, { suppressResourceNotification: true });
  assert.equal(actor.system.resources.actionPoints.value, 2);
  assert.equal(actor.updates.length, 1);
});

test("strict action-point receipts refund only their own delta", async () => {
  const actor = createActor("Actor.Receipt", 10);
  globalThis.game = { combat: { started: true, combatants: [{ actor }] } };
  const transaction = await spendStrictActionPointsWithReceipt(actor, 3, {
    suppressResourceNotification: true
  });
  assert.equal(transaction.spent, 3);
  assert.equal(transaction.receipt.amount, 3);
  assert.equal(actor.system.resources.actionPoints.value, 7);

  // A later legitimate change must survive refunding the route's own spend.
  actor.system.resources.actionPoints.value = 5;
  const restored = await refundStrictActionPointReceipt(actor, transaction.receipt);
  assert.equal(restored, 3);
  assert.equal(actor.system.resources.actionPoints.value, 8);
});

test("cancelled strict AP update does not create a spend receipt", async () => {
  const actor = createActor("Actor.Cancelled", 10);
  actor.update = async changes => {
    actor.updates.push(changes);
  };
  globalThis.game = { combat: { started: true, combatants: [{ actor }] } };

  const transaction = await spendStrictActionPointsWithReceipt(actor, 3, {
    suppressResourceNotification: true
  });

  assert.equal(transaction.spent, 0);
  assert.equal(transaction.receipt, null);
  assert.deepEqual(transaction.events, []);
  assert.equal(actor.system.resources.actionPoints.value, 10);
});

test("cancelled strict AP refund reports that nothing was restored", async () => {
  const actor = createActor("Actor.CancelledRefund", 10);
  globalThis.game = { combat: { started: true, combatants: [{ actor }] } };
  const transaction = await spendStrictActionPointsWithReceipt(actor, 3, {
    suppressResourceNotification: true
  });
  assert.equal(actor.system.resources.actionPoints.value, 7);

  actor.update = async changes => actor.updates.push(changes);
  const restored = await refundStrictActionPointReceipt(actor, transaction.receipt);

  assert.equal(restored, 0);
  assert.equal(actor.system.resources.actionPoints.value, 7);
});

test("stun makes ОД unavailable without spending them", async () => {
  const actor = createActor("Actor.Stunned", 10);
  actor.system.combat.stun = 60;
  globalThis.ui = { notifications: { warn() {} } };
  globalThis.game = { combat: { started: true, combatants: [{ actor }] } };

  assert.equal(canSpendStrictActionPoints(actor, 5), false);
  assert.equal(canSpendStrictActionPoints(actor, 4), true);
  await spendStrictActionPoints(actor, 4, { suppressResourceNotification: true });
  assert.equal(actor.system.resources.actionPoints.value, 6);
  assert.equal(canSpendStrictActionPoints(actor, 1), false);
});

test("stun makes ОР and ОП unavailable through their normal spending states", async () => {
  installFoundryImportGlobals();
  const {
    canSpendCombatActionPoints,
    getCombatActionPointState,
    spendCombatActionPoints
  } = await import("../src/combat/reaction-resources.mjs");
  const { getCombatMovementResourceState } = await import("../src/combat/movement-resources.mjs");
  const actor = createActor("Actor.StunnedResources", 10);
  actor.effects = [];
  actor.system.combat.stun = 50;
  actor.system.resources.reactionPoints = { value: 8, min: 0, max: 10 };
  actor.system.resources.movementPoints = { value: 10, min: 0, max: 10 };
  actor.update = async changes => {
    actor.updates.push(changes);
    for (const [path, value] of Object.entries(changes)) {
      const match = /^system\.resources\.([^.]+)\.(value|spent)$/.exec(path);
      if (match) actor.system.resources[match[1]][match[2]] = value;
    }
  };

  const other = createActor("Actor.Other", 10);
  const combat = {
    started: true,
    combatants: [{ actor }, { actor: other }],
    combatant: { actor: other }
  };
  globalThis.game = {
    combat,
    combats: [combat],
    settings: { get: () => ({ turnOrder: { scheme: "normal" } }) }
  };
  globalThis.ui = { notifications: { warn() {} } };

  assert.equal(getCombatActionPointState(actor).value, 3);
  assert.equal(canSpendCombatActionPoints(actor, 4), false);
  await spendCombatActionPoints(actor, 3, { suppressResourceNotification: true });
  assert.equal(actor.system.resources.reactionPoints.value, 5);

  combat.combatant = { actor };
  const movement = getCombatMovementResourceState(actor);
  assert.equal(movement.movement.current, 10);
  assert.equal(movement.movement.value, 5);
  assert.equal(movement.action.current, 10);
  assert.equal(movement.action.value, 5);
});

test("cancelled dynamic AP update does not create a spend receipt", async () => {
  installFoundryImportGlobals();
  const { spendCombatActionPointsWithReceipt } = await import("../src/combat/reaction-resources.mjs");
  const actor = createActor("Actor.DynamicCancelled", 7);
  actor.effects = [];
  actor.update = async changes => {
    actor.updates.push(changes);
  };
  const combat = {
    started: true,
    combatants: [{ actor }],
    combatant: { actor }
  };
  globalThis.game = {
    combat,
    combats: [combat],
    settings: { get: () => ({ turnOrder: { scheme: "normal" } }) }
  };

  const transaction = await spendCombatActionPointsWithReceipt(actor, 3, {
    suppressResourceNotification: true
  });

  assert.equal(transaction.spent, 0);
  assert.equal(transaction.receipt, null);
  assert.equal(actor.system.resources.actionPoints.value, 7);
});

test("dynamic AP receipts spend one-time points first and restore their exact split", async () => {
  installFoundryImportGlobals();
  const {
    ONE_TIME_ACTION_POINTS_KEY,
    getOneTimeActionPointTotal,
    refundCombatActionPointReceipt,
    spendCombatActionPoints,
    spendCombatActionPointsWithReceipt
  } = await import("../src/combat/reaction-resources.mjs");
  const actor = createActor("Actor.DynamicReceipt", 2);
  actor.effects = [];
  actor.update = async changes => {
    actor.updates.push(changes);
    if (changes["system.resources.actionPoints.value"] !== undefined) {
      actor.system.resources.actionPoints.value = changes["system.resources.actionPoints.value"];
    }
    if (changes["system.resources.actionPoints.spent"] !== undefined) {
      actor.system.resources.actionPoints.spent = changes["system.resources.actionPoints.spent"];
    }
    return actor;
  };
  const createEffect = (data, id = `Effect.${actor.effects.length + 1}`) => {
    const effect = {
      id,
      system: { changes: structuredClone(data.system?.changes ?? []) },
      flags: structuredClone(data.flags ?? {}),
      getFlag(scope, key) {
        return this.flags?.[scope]?.[key];
      },
      async update(changes) {
        if (changes["system.changes"]) this.system.changes = structuredClone(changes["system.changes"]);
        return this;
      },
      async delete() {
        actor.effects = actor.effects.filter(entry => entry !== this);
        return this;
      }
    };
    return effect;
  };
  actor.effects.push(createEffect({
    system: {
      changes: [{
        key: ONE_TIME_ACTION_POINTS_KEY,
        type: "add",
        value: "4"
      }]
    },
    flags: { "fallout-maw": { oneTimeActionPoints: { source: "test" } } }
  }, "Effect.Once"));
  actor.createEmbeddedDocuments = async (_type, entries) => {
    const created = entries.map(entry => createEffect(entry));
    actor.effects.push(...created);
    return created;
  };
  const combat = {
    started: true,
    combatants: [{ actor }],
    combatant: { actor }
  };
  globalThis.game = {
    combat,
    combats: [combat],
    settings: { get: () => ({ turnOrder: { scheme: "normal" } }) }
  };

  const transaction = await spendCombatActionPointsWithReceipt(actor, 4, {
    suppressResourceNotification: true
  });
  assert.equal(transaction.spent, 4);
  assert.equal(transaction.receipt.normalSpent, 0);
  assert.equal(transaction.receipt.onceSpent, 4);
  assert.equal(actor.system.resources.actionPoints.value, 2);
  assert.equal(getOneTimeActionPointTotal(actor), 0);

  const restored = await refundCombatActionPointReceipt(actor, transaction.receipt);
  assert.equal(restored, 4);
  assert.equal(actor.system.resources.actionPoints.value, 2);
  assert.equal(getOneTimeActionPointTotal(actor), 4);

  await spendCombatActionPoints(actor, 5, { suppressResourceNotification: true });
  assert.equal(actor.system.resources.actionPoints.value, 1);
  assert.equal(getOneTimeActionPointTotal(actor), 0);
});

test("only ОД, ОР, ОП and dodge are combat-only resources", () => {
  assert.deepEqual(COMBAT_ONLY_RESOURCE_KEYS, [
    "actionPoints",
    "reactionPoints",
    "movementPoints",
    "dodge"
  ]);
  const actor = createActor();
  globalThis.game = { combat: null };
  for (const key of COMBAT_ONLY_RESOURCE_KEYS) {
    assert.equal(isCombatResourceCostActive(actor, key), false, key);
  }
  for (const key of ["health", "power", "newResource", ""]) {
    assert.equal(isCombatResourceCostActive(actor, key), true, key);
  }

  globalThis.game = { combat: { started: true, combatants: [{ actor }] } };
  for (const key of COMBAT_ONLY_RESOURCE_KEYS) {
    assert.equal(isCombatResourceCostActive(actor, key), true, key);
  }
});

test("combat membership does not depend on the tracker currently viewed by this client", () => {
  const actor = createActor();
  const unrelated = {
    id: "Combat.Unrelated",
    started: true,
    combatants: [{ actor: { uuid: "Actor.B" } }]
  };
  const actual = {
    id: "Combat.Actual",
    started: true,
    combatants: [{ actor }],
    getCombatantsByActor(candidate) {
      return candidate.uuid === actor.uuid ? this.combatants : [];
    }
  };
  globalThis.game = { combat: unrelated, combats: [unrelated, actual] };
  assert.equal(getActorActiveCombat(actor), actual);
  assert.equal(isActorInActiveCombat(actor), true);
});

test("direct ability action-point paths use actor combat membership instead of the viewed tracker", async () => {
  const actionSource = await readFile(new URL("../src/abilities/ability-actions.mjs", import.meta.url), "utf8");
  const configuredStart = actionSource.indexOf("export function getConfiguredActionPointCost");
  const configuredEnd = actionSource.indexOf("export function buildAbilityActionPointCostLine", configuredStart);
  assert.match(actionSource.slice(configuredStart, configuredEnd), /isActorInActiveCombat\(actor\)/);
  const affordabilityStart = actionSource.indexOf("function canAffordConfiguredActionPointCost");
  const affordabilityEnd = actionSource.indexOf("async function handleAbilityActionAttackQuery", affordabilityStart);
  assert.match(actionSource.slice(affordabilityStart, affordabilityEnd), /isActorInActiveCombat\(actor\)/);

  const fixedSource = await readFile(new URL("../src/abilities/fixed-functions.mjs", import.meta.url), "utf8");
  const lookStart = fixedSource.indexOf("async function spendActorActionAndMovement");
  const lookEnd = fixedSource.indexOf("async function requestCommandBasicsDodgeOperation", lookStart);
  assert.match(fixedSource.slice(lookStart, lookEnd), /isActorInActiveCombat\(actor\)/);
  const reaperStart = fixedSource.indexOf("async function restoreReaperActionPoints");
  const reaperEnd = fixedSource.indexOf("function applyFourLeafCloverCriticalBonus", reaperStart);
  assert.match(fixedSource.slice(reaperStart, reaperEnd), /isActorInActiveCombat\(actor\)/);

  const weaponSource = await readFile(new URL("../src/combat/weapon-attack-controller.mjs", import.meta.url), "utf8");
  assert.match(
    weaponSource,
    /export function isCombatActionPointSpendingActive\(actor = null\) \{\s*return isActorInActiveCombat\(actor\);\s*\}/u
  );
  assert.doesNotMatch(weaponSource, /isCombatActionPointSpendingActive\(\)/u);
});

test("movement tracking follows the actor's started combat instead of the viewed tracker", async () => {
  installFoundryImportGlobals();
  const { isCombatMovementTracked } = await import("../src/combat/movement-resources.mjs");
  const actor = createActor();
  const tokenDocument = { actor };
  const unrelated = {
    started: true,
    combatants: [{ actor: { uuid: "Actor.B" } }]
  };
  const actual = {
    started: true,
    combatants: [{ actor }],
    getCombatantsByActor(candidate) {
      return candidate.uuid === actor.uuid ? this.combatants : [];
    }
  };

  globalThis.game = { combat: unrelated, combats: [unrelated] };
  assert.equal(isCombatMovementTracked(tokenDocument), false);

  globalThis.game = { combat: unrelated, combats: [unrelated, actual] };
  assert.equal(isCombatMovementTracked(tokenDocument), true);

  actual.started = false;
  assert.equal(isCombatMovementTracked(tokenDocument), false);
});

test("split movement preserves fractional cost and starts a new tranche when its profile changes", async () => {
  installFoundryImportGlobals();
  const { calculateCombatMovementCostTrancheDelta } = await import("../src/combat/movement-resources.mjs");
  const ordinary = { postureMultiplier: 1, perUnitCost: 1 };
  let priorRawCost = 0;
  let priorAdjustedCost = 0;
  const deltas = [];
  for (const rawCost of [0.4, 0.4, 0.4]) {
    const delta = calculateCombatMovementCostTrancheDelta(
      ordinary,
      priorRawCost,
      priorAdjustedCost,
      rawCost
    );
    deltas.push(delta);
    priorRawCost += rawCost;
    priorAdjustedCost += delta;
  }
  assert.deepEqual(deltas, [1, 0, 1]);
  assert.equal(priorAdjustedCost, 2);

  const doubled = { postureMultiplier: 1, perUnitCost: 2 };
  assert.equal(calculateCombatMovementCostTrancheDelta(doubled, 0, 0, 2), 4);
  assert.equal(calculateCombatMovementCostTrancheDelta(doubled, 2, 4, 2), 4);
});

test("dodge spending ignores unrelated combat and uses the actor's hidden started combat", async () => {
  installFoundryImportGlobals();
  const { spendActorDodgeForAreaDamage } = await import("../src/combat/dodge-resource.mjs");
  const actor = {
    uuid: "Actor.Dodge",
    isOwner: true,
    items: { contents: [] },
    effects: [],
    system: { resources: { dodge: { value: 10, max: 10 } } },
    updates: [],
    async update(changes) {
      this.updates.push(changes);
      if (changes["system.resources.dodge.value"] !== undefined) {
        this.system.resources.dodge.value = changes["system.resources.dodge.value"];
      }
    }
  };
  const unrelated = {
    started: true,
    combatants: [{ actor: { uuid: "Actor.B" } }]
  };
  const actual = {
    started: true,
    combatants: [{ actor }],
    getCombatantsByActor(candidate) {
      return candidate.uuid === actor.uuid ? this.combatants : [];
    }
  };
  const settings = {
    get() {
      return {
        dodge: {
          enabled: true,
          attackCostPercent: 10,
          areaDamageMultiplier: 1
        }
      };
    }
  };

  globalThis.game = {
    combat: unrelated,
    combats: [unrelated],
    settings,
    user: { isActiveGM: false }
  };
  await spendActorDodgeForAreaDamage(actor);
  assert.equal(actor.system.resources.dodge.value, 10);
  assert.equal(actor.updates.length, 0);

  globalThis.game = {
    combat: unrelated,
    combats: [unrelated, actual],
    settings,
    user: { isActiveGM: false }
  };
  await spendActorDodgeForAreaDamage(actor);
  assert.equal(actor.system.resources.dodge.value, 9);
  assert.equal(actor.updates.length, 1);
});

test("every direct movement, posture, active-action and dodge spend path rechecks actor combat membership", async () => {
  const [movement, posture, activeActions, dodge] = await Promise.all([
    readFile(new URL("../src/combat/movement-resources.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/canvas/posture-movement.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/combat/active-actions.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/combat/dodge-resource.mjs", import.meta.url), "utf8")
  ]);

  assert.match(
    movement,
    /export function isCombatMovementTracked\(tokenDocument\) \{\s*return isActorInActiveCombat\(tokenDocument\?\.actor\);\s*\}/u
  );
  assert.match(
    movement,
    /await waitForMovementAnimation\(movement\);\s*if \(!isCombatMovementTracked\(tokenDocument\)\) return;/u
  );
  assert.match(movement, /round: getActorActiveCombat\(actor\)\?\.round \?\? 0/u);
  assert.match(
    movement,
    /function getCurrentMovementSpendingTranche[\s\S]*?costProfileKey[\s\S]*?entry\?\.costProfileKey[\s\S]*?break;/u
  );
  assert.match(
    movement,
    /createMovementResourceSpendingEntry[\s\S]*?costProfileKey:[\s\S]*?costProfile\.key/u
  );
  assert.doesNotMatch(movement, /const cost = getCombatMovementSpendDelta[\s\S]{0,120}if \(cost <= 0\) return;/u);
  assert.match(
    movement,
    /const movementRootId = String\(lastEntry\?\.movementRootId[\s\S]*?const restoredEntries = stack\.filter[\s\S]*?restoredResources/u
  );
  assert.match(
    movement,
    /export function hasActorCombatMovementInCurrentTurn\(actor, \{ round = null \} = \{\}\)[\s\S]*?const requestedRound = Math\.max\(0, toInteger\(round\)\);[\s\S]*?const currentRound = requestedRound \|\| Math\.max\(0, toInteger\(getActorActiveCombat\(actor\)\?\.round\)\);/u
  );
  assert.match(
    posture,
    /function getPostureChangeResourceCost[\s\S]*?if \(!isActorInActiveCombat\(tokenDocument\?\.actor\)\) return 0;[\s\S]*?function canSpendPostureChangeResources/u
  );
  assert.match(
    posture,
    /async function spendPostureChangeResources\(tokenDocument, amount, pending = \{\}\) \{\s*const actor = tokenDocument\?\.actor;\s*if \(!isActorInActiveCombat\(actor\)\) return;/u
  );
  assert.match(posture, /round: getActorActiveCombat\(actor\)\?\.round \?\? 0/u);
  assert.match(
    activeActions,
    /function canSpendMovementThenAction\(actor, amount = 0\) \{\s*if \(!isActorInActiveCombat\(actor\)\) return true;/u
  );
  assert.match(
    activeActions,
    /async function spendMovementThenAction\(actor, amount = 0\) \{\s*if \(!isActorInActiveCombat\(actor\)\) return;/u
  );
  assert.match(
    dodge,
    /async function spendActorDodgeResourceNow\(actor, multiplier = 1, conditionContext = \{\}\) \{[\s\S]*?if \(!isActorInActiveCombat\(actor\)\) return;/u
  );
  assert.match(
    dodge,
    /payload\.action !== DODGE_SOCKET_ACTION_SPEND \|\| isActorInActiveCombat\(actor\)/u
  );
});

function installFoundryImportGlobals() {
  globalThis.foundry = {
    applications: {
      api: { DialogV2: {} },
      ux: { FormDataExtended: class FormDataExtended {} },
      handlebars: { renderTemplate: async () => "" }
    },
    utils: {
      deepClone: value => structuredClone(value),
      randomID: () => "test-id",
      mergeObject: (target, source, { inplace = false } = {}) => {
        const result = inplace ? target : structuredClone(target ?? {});
        mergePlainObjects(result, source ?? {});
        return result;
      }
    }
  };
  globalThis.CONFIG = { specialStatusEffects: {}, Token: { movement: null } };
}

function mergePlainObjects(target, source) {
  for (const [key, value] of Object.entries(source ?? {})) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const child = target[key] && typeof target[key] === "object" && !Array.isArray(target[key])
        ? target[key]
        : {};
      target[key] = child;
      mergePlainObjects(child, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}
