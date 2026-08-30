import assert from "node:assert/strict";
import test from "node:test";

installFoundryImportGlobals();

const {
  REACTIVE_EFFECT_FLAG_KEY,
  calculateReactiveActionPointReward,
  useReactiveAbility
} = await import("../src/abilities/reactive.mjs");

test("Reactive keeps the legacy one-AP reward when the multiplier flag is absent", () => {
  assert.deepEqual(calculateReactiveActionPointReward({
    movementPointProgress: 3,
    movementSpent: 5,
    movementPointsPerActionPoint: 4
  }), {
    movementPointTotal: 8,
    gainedActionPoints: 2,
    movementPointProgress: 0
  });
});

test("Reactive multiplies each completed movement threshold and keeps the remainder", () => {
  assert.deepEqual(calculateReactiveActionPointReward({
    movementPointProgress: 1,
    movementSpent: 8,
    movementPointsPerActionPoint: 4,
    actionPointsPerThreshold: 2
  }), {
    movementPointTotal: 9,
    gainedActionPoints: 4,
    movementPointProgress: 1
  });
});

test("Reactive snapshots the configured AP reward into its timed effect", async () => {
  const created = [];
  const actor = {
    uuid: "Actor.Reactive",
    isOwner: true,
    effects: [],
    system: {
      resources: {
        power: { value: 100, min: 0, max: 100, spent: 0 }
      }
    },
    async update(changes) {
      if (changes["system.resources.power.value"] !== undefined) {
        this.system.resources.power.value = changes["system.resources.power.value"];
      }
      if (changes["system.resources.power.spent"] !== undefined) {
        this.system.resources.power.spent = changes["system.resources.power.spent"];
      }
      return this;
    },
    async createEmbeddedDocuments(type, entries) {
      assert.equal(type, "ActiveEffect");
      created.push(...structuredClone(entries));
      return entries.map((entry, index) => ({ id: `Effect.${created.length + index}`, ...entry }));
    },
    async deleteEmbeddedDocuments() {}
  };
  const abilityItem = {
    id: "Reactive",
    uuid: "Actor.Reactive.Item.Reactive",
    name: "Реактивный",
    img: "icons/svg/upgrade.svg"
  };
  const abilityFunction = {
    id: "reactive-runtime",
    fixedSettings: {
      energyCost: 0,
      overloadEnergyCost: 0,
      overloadDurationSeconds: 0,
      durationSeconds: 6,
      movementPointsPerActionPoint: 4,
      actionPointsPerThreshold: 2
    }
  };
  globalThis.game = {
    user: { id: "User.GM", isGM: true },
    time: { worldTime: 100 }
  };
  globalThis.ui = { notifications: { warn() {}, error() {} } };

  assert.equal(await useReactiveAbility(actor, abilityItem, abilityFunction), true);
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].flags["fallout-maw"][REACTIVE_EFFECT_FLAG_KEY], {
    sourceItemUuid: abilityItem.uuid,
    abilityFunctionId: abilityFunction.id,
    movementPointsPerActionPoint: 4,
    actionPointsPerThreshold: 2,
    movementPointProgress: 0,
    expiresAt: 106
  });
});

function installFoundryImportGlobals() {
  globalThis.foundry = {
    applications: {
      api: { DialogV2: class DialogV2 {} },
      ux: { FormDataExtended: class FormDataExtended {} },
      handlebars: { renderTemplate: async () => "" }
    },
    utils: {
      flattenObject: value => value ?? {}
    }
  };
  globalThis.CONFIG = { specialStatusEffects: {} };
}
