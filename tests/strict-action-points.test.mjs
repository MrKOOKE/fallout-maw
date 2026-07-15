import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  canSpendStrictActionPoints,
  getActorActiveCombat,
  isActorInActiveCombat,
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
    system: { resources: { actionPoints: { value, max: 10 } } },
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

test("dodge spending ignores unrelated combat and uses the actor's hidden started combat", async () => {
  installFoundryImportGlobals();
  const { spendActorDodgeForAreaDamage } = await import("../src/combat/dodge-resource.mjs");
  const actor = {
    uuid: "Actor.Dodge",
    isOwner: true,
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
    /const currentRound = Math\.max\(0, toInteger\(getActorActiveCombat\(actor\)\?\.round\)\);/u
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
    /async function spendActorDodgeResourceNow\(actor, multiplier = 1\) \{[\s\S]*?if \(!isActorInActiveCombat\(actor\)\) return;/u
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
