import assert from "node:assert/strict";
import test from "node:test";

globalThis.foundry = {
  applications: {
    api: { DialogV2: class DialogV2 {} },
    ux: { FormDataExtended: class FormDataExtended {} },
    handlebars: { renderTemplate: async () => "" }
  },
  utils: {
    deepClone: structuredClone,
    getProperty: () => undefined,
    hasProperty: () => false,
    randomID: () => "test-id",
    setProperty: () => true
  }
};

const {
  buildActorLimbHealthContext,
  clampActorLimbValuesToCurrentCaps,
  getLimbHealingCap
} = await import("../src/combat/damage-hub.mjs");

function createProsthesis(id, limbKey) {
  return {
    id,
    type: "gear",
    system: {
      equipped: true,
      placement: { mode: "prosthesis", limbKey },
      functions: {
        prosthesis: { enabled: true, integrationPercent: 50 }
      }
    }
  };
}

function createActor({ gear = [], traumas = [], limbs = {} } = {}) {
  let fallbackItemReads = 0;
  const actor = {
    uuid: "Actor.limb-health-test",
    itemTypes: {
      ability: [],
      disease: [],
      gear,
      trauma: traumas
    },
    get fallbackItemReads() {
      return fallbackItemReads;
    },
    items: {
      filter() {
        fallbackItemReads += 1;
        throw new Error("official itemTypes index should satisfy typed item reads");
      },
      *[Symbol.iterator]() {
        fallbackItemReads += 1;
        throw new Error("full Item collection should not be scanned");
      }
    },
    allApplicableEffects() {
      return [];
    },
    system: {
      limbs,
      resources: {
        health: { min: 0, value: 0, max: 0, spent: 0 }
      }
    }
  };
  return actor;
}

test("limb health context indexes typed Items once and preserves first prosthesis wins", () => {
  const first = createProsthesis("first", "arm");
  const duplicate = createProsthesis("duplicate", "arm");
  const malformed = createProsthesis("malformed", " leg ");
  const actor = createActor({
    gear: [first, duplicate, malformed],
    limbs: {
      arm: { min: -100, value: 100, max: 100, missing: false },
      leg: { min: -100, value: 100, max: 100, missing: false }
    }
  });

  const context = buildActorLimbHealthContext(actor);

  assert.equal(context.prosthesesByLimb.get("arm"), first);
  assert.equal(context.prosthesesByLimb.get(" leg "), malformed);
  assert.equal(context.prosthesesByLimb.has("leg"), false);
  assert.equal(actor.fallbackItemReads, 0);
});

test("one context reuses unsuppressed trauma caps across every limb", () => {
  const actor = createActor({
    traumas: [
      { id: "arm-80", type: "trauma", system: { limbKey: "arm", thresholdPercent: 80 } },
      { id: "arm-50", type: "trauma", system: { limbKey: "arm", thresholdPercent: 50 } },
      { id: "leg-70", type: "trauma", system: { limbKey: "leg", thresholdPercent: 70 } }
    ],
    limbs: {
      arm: { min: -100, value: 90, max: 100, missing: false },
      leg: { min: -200, value: 180, max: 200, missing: false }
    }
  });

  const context = buildActorLimbHealthContext(actor);

  assert.equal(getLimbHealingCap(actor, "arm", context), 50);
  assert.equal(getLimbHealingCap(actor, "leg", context), 140);
  assert.equal(actor.fallbackItemReads, 0);
});

test("clamp reuses the context and keeps limb spent plus aggregate health coherent", () => {
  const actor = createActor({
    traumas: [
      { id: "arm-50", type: "trauma", system: { limbKey: "arm", thresholdPercent: 50 } }
    ],
    limbs: {
      arm: { min: -100, value: 90, max: 100, spent: 10, missing: false },
      leg: { min: -100, value: 80, max: 100, spent: 20, missing: false }
    }
  });
  const context = buildActorLimbHealthContext(actor);

  assert.equal(clampActorLimbValuesToCurrentCaps(actor, context), true);
  assert.deepEqual(actor.system.limbs.arm, {
    min: -100,
    value: 50,
    max: 100,
    spent: 50,
    missing: false
  });
  assert.deepEqual(actor.system.resources.health, {
    min: 0,
    value: 130,
    max: 200,
    spent: 70
  });
  assert.equal(actor.fallbackItemReads, 0);
});
