import assert from "node:assert/strict";
import test from "node:test";

let generatedId = 0;
let combatSettings = {};

globalThis.foundry = {
  applications: {
    api: { DialogV2: {} },
    ux: { FormDataExtended: class FormDataExtended {} },
    handlebars: { renderTemplate: async () => "" }
  },
  utils: {
    deepClone: value => structuredClone(value),
    randomID: () => `attack-mp-loss-${++generatedId}`,
    mergeObject(target, source, { inplace = false } = {}) {
      return mergePlainObjects(
        inplace ? target : structuredClone(target ?? {}),
        source ?? {}
      );
    },
    getProperty(source, path) {
      return String(path ?? "").split(".").reduce((value, key) => value?.[key], source);
    },
    setProperty(target, path, value) {
      const parts = String(path ?? "").split(".");
      let current = target;
      for (const key of parts.slice(0, -1)) current = current[key] ??= {};
      current[parts.at(-1)] = value;
      return true;
    }
  }
};
globalThis.CONFIG = { specialStatusEffects: {}, Token: { movement: null } };
globalThis.canvas = { tokens: { controlled: [], placeables: [] } };
globalThis.game = {
  combat: null,
  combats: [],
  settings: {
    get(_scope, key) {
      return key === "combatSettings" ? combatSettings : {};
    }
  },
  user: {}
};

const {
  ATTACK_ACTION_POINT_MOVEMENT_LOSS_MODES,
  DEFAULT_COMBAT_SETTINGS,
  normalizeCombatSettings
} = await import("../src/settings/combat.mjs");
const {
  applyAttackActionPointMovementLoss,
  calculateAttackActionPointMovementLoss
} = await import("../src/combat/attack-action-point-movement-loss.mjs");

test("attack AP-to-MP conversion defaults to an uncapped 100 percent mode", () => {
  assert.deepEqual(DEFAULT_COMBAT_SETTINGS.attackActionPointMovementLoss, {
    mode: ATTACK_ACTION_POINT_MOVEMENT_LOSS_MODES.percent,
    percent: 100
  });
  assert.deepEqual(normalizeCombatSettings({}).attackActionPointMovementLoss, {
    mode: ATTACK_ACTION_POINT_MOVEMENT_LOSS_MODES.percent,
    percent: 100
  });
  assert.deepEqual(normalizeCombatSettings({
    attackActionPointMovementLoss: {
      mode: ATTACK_ACTION_POINT_MOVEMENT_LOSS_MODES.percent,
      percent: 1_250
    }
  }).attackActionPointMovementLoss, {
    mode: ATTACK_ACTION_POINT_MOVEMENT_LOSS_MODES.percent,
    percent: 1_250
  });
});

test("attack AP-to-MP settings reject invalid modes and negative percentages", () => {
  assert.deepEqual(normalizeCombatSettings({
    attackActionPointMovementLoss: {
      mode: "unknown",
      percent: -50
    }
  }).attackActionPointMovementLoss, {
    mode: ATTACK_ACTION_POINT_MOVEMENT_LOSS_MODES.percent,
    percent: 0
  });
});

test("percentage conversion rounds a positive proportional loss up and clamps only to current MP", () => {
  assert.deepEqual(calculateAttackActionPointMovementLoss({
    spentActionPoints: 3,
    percent: 50,
    currentMovementPoints: 10
  }), {
    mode: ATTACK_ACTION_POINT_MOVEMENT_LOSS_MODES.percent,
    percent: 50,
    disabled: false,
    requested: 2,
    amount: 2
  });

  assert.deepEqual(calculateAttackActionPointMovementLoss({
    spentActionPoints: 4,
    percent: 250,
    currentMovementPoints: 3
  }), {
    mode: ATTACK_ACTION_POINT_MOVEMENT_LOSS_MODES.percent,
    percent: 250,
    disabled: false,
    requested: 10,
    amount: 3
  });
});

test("full-loss and disabled modes are independent of the configured percentage", () => {
  assert.equal(calculateAttackActionPointMovementLoss({
    mode: ATTACK_ACTION_POINT_MOVEMENT_LOSS_MODES.fullLoss,
    spentActionPoints: 1,
    percent: 0,
    currentMovementPoints: 7
  }).amount, 7);
  assert.equal(calculateAttackActionPointMovementLoss({
    mode: ATTACK_ACTION_POINT_MOVEMENT_LOSS_MODES.disabled,
    spentActionPoints: 10,
    percent: 500,
    currentMovementPoints: 7
  }).amount, 0);
});

test("disable key starts at one: zero does not disable and one does", () => {
  const enabled = calculateAttackActionPointMovementLoss({
    spentActionPoints: 2,
    percent: 100,
    currentMovementPoints: 5,
    disabledValue: 0
  });
  const disabled = calculateAttackActionPointMovementLoss({
    spentActionPoints: 2,
    percent: 100,
    currentMovementPoints: 5,
    disabledValue: 1
  });

  assert.equal(enabled.disabled, false);
  assert.equal(enabled.amount, 2);
  assert.equal(disabled.disabled, true);
  assert.equal(disabled.amount, 0);
});

test("runtime removes no more than remaining MP and never requires an MP balance", async () => {
  combatSettings = {
    attackActionPointMovementLoss: {
      mode: ATTACK_ACTION_POINT_MOVEMENT_LOSS_MODES.percent,
      percent: 250
    }
  };
  const actor = createActor({ movementPoints: 2 });

  const result = await applyAttackActionPointMovementLoss(actor, 4, {
    attackId: "attack-clamped"
  });

  assert.equal(result.requested, 10);
  assert.equal(result.amount, 2);
  assert.equal(actor.system.resources.movementPoints.value, 0);
  assert.equal(actor.updates.length, 1);

  const emptyActor = createActor({ movementPoints: 0 });
  const emptyResult = await applyAttackActionPointMovementLoss(emptyActor, 4, {
    attackId: "attack-no-mp"
  });
  assert.equal(emptyResult.amount, 0);
  assert.equal(emptyActor.updates.length, 0);
});

test("runtime reads the percentage and disable Active Effect fields from prepared actor data", async () => {
  combatSettings = {
    attackActionPointMovementLoss: {
      mode: ATTACK_ACTION_POINT_MOVEMENT_LOSS_MODES.percent,
      percent: 100
    }
  };
  const boosted = createActor({
    movementPoints: 10,
    percentBonus: 50
  });
  const boostedResult = await applyAttackActionPointMovementLoss(boosted, 2, {
    attackId: "attack-boosted"
  });
  assert.equal(boostedResult.percent, 150);
  assert.equal(boostedResult.amount, 3);
  assert.equal(boosted.system.resources.movementPoints.value, 7);

  const ignored = createActor({
    movementPoints: 10,
    disabledValue: 1
  });
  const ignoredResult = await applyAttackActionPointMovementLoss(ignored, 2, {
    attackId: "attack-ignored"
  });
  assert.equal(ignoredResult.disabled, true);
  assert.equal(ignoredResult.amount, 0);
  assert.equal(ignored.system.resources.movementPoints.value, 10);
  assert.equal(ignored.updates.length, 0);
});

test("a cancelled MP update cannot fail or make the already-paid attack retryable", async () => {
  combatSettings = {
    attackActionPointMovementLoss: {
      mode: ATTACK_ACTION_POINT_MOVEMENT_LOSS_MODES.percent,
      percent: 100
    }
  };
  const actor = createActor({ movementPoints: 5, applyUpdates: false });

  const result = await applyAttackActionPointMovementLoss(actor, 2, {
    attackId: "attack-cancelled-update"
  });

  assert.equal(result.amount, 0);
  assert.equal(actor.system.resources.movementPoints.value, 5);
  assert.equal(actor.updates.length, 1);
});

function createActor({
  movementPoints = 10,
  percentBonus = 0,
  disabledValue = 0,
  applyUpdates = true
} = {}) {
  const actor = {
    uuid: `Actor.AttackMpLoss.${generatedId + 1}`,
    type: "character",
    isOwner: true,
    items: { contents: [] },
    effects: [],
    system: {
      combat: {
        attackActionPointMovementLossPercentBonus: percentBonus,
        attackActionPointMovementLossDisabled: disabledValue
      },
      resources: {
        movementPoints: {
          value: movementPoints,
          max: 10,
          spent: Math.max(0, 10 - movementPoints)
        }
      }
    },
    updates: [],
    async update(changes) {
      this.updates.push(changes);
      if (!applyUpdates) return this;
      for (const [path, value] of Object.entries(changes)) {
        const match = /^system\.resources\.movementPoints\.(value|spent)$/.exec(path);
        if (match) this.system.resources.movementPoints[match[1]] = value;
      }
      return this;
    }
  };
  return actor;
}

function mergePlainObjects(target, source) {
  for (const [key, value] of Object.entries(source ?? {})) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const child = target[key] && typeof target[key] === "object" && !Array.isArray(target[key])
        ? target[key]
        : {};
      target[key] = mergePlainObjects(child, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}
