import assert from "node:assert/strict";
import test from "node:test";

const OPERATOR_VALUE = Symbol("testForcedReplacementValue");

class TestForcedReplacement {
  constructor(value) {
    Object.defineProperty(this, OPERATOR_VALUE, {
      configurable: true,
      value,
      writable: true
    });
  }

  static create(value) {
    return new Proxy(new TestForcedReplacement(value), {
      get(target, property, receiver) {
        if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
        const inner = target[OPERATOR_VALUE];
        return inner && typeof inner === "object"
          ? Reflect.get(inner, property, receiver)
          : undefined;
      },
      ownKeys(target) {
        const inner = target[OPERATOR_VALUE];
        return inner && typeof inner === "object" ? Reflect.ownKeys(inner) : [];
      },
      getOwnPropertyDescriptor(target, property) {
        return Reflect.getOwnPropertyDescriptor(target[OPERATOR_VALUE], property);
      }
    });
  }

  static get(value) {
    return value instanceof TestForcedReplacement ? value[OPERATOR_VALUE] : value;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneValue(value) {
  if (value instanceof TestForcedReplacement) return value;
  if (Array.isArray(value)) return value.map(cloneValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)]));
}

function flattenObject(value, prefix = "", output = {}) {
  for (const [key, entry] of Object.entries(value ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(entry)) {
      if (!Object.keys(entry).length) output[path] = entry;
      flattenObject(entry, path, output);
    } else {
      output[path] = entry;
    }
  }
  return output;
}

function getProperty(object, path) {
  if (Object.hasOwn(object ?? {}, path)) return object[path];
  return String(path ?? "").split(".").reduce((value, key) => value?.[key], object);
}

function hasProperty(object, path) {
  if (Object.hasOwn(object ?? {}, path)) return true;
  const parts = String(path ?? "").split(".");
  let value = object;
  for (const part of parts) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) return false;
    value = value[part];
  }
  return true;
}

function setProperty(object, path, value) {
  if (Object.hasOwn(object ?? {}, path)) {
    object[path] = value;
    return true;
  }
  const parts = String(path ?? "").split(".");
  const last = parts.pop();
  let target = object;
  for (const part of parts) target = target[part] ??= {};
  target[last] = value;
  return true;
}

globalThis.foundry = {
  applications: {
    api: { DialogV2: class DialogV2 {} },
    ux: { FormDataExtended: class FormDataExtended {} },
    handlebars: { renderTemplate: async () => "" }
  },
  data: {
    operators: {
      ForcedReplacement: {
        create: TestForcedReplacement.create,
        get: TestForcedReplacement.get
      }
    }
  },
  documents: {
    modifyBatch: async () => []
  },
  utils: {
    deepClone: cloneValue,
    flattenObject,
    getProperty,
    hasProperty,
    randomID: () => "test-id",
    setProperty
  }
};

const {
  buildActorLimbHealthContext,
  clampActorLimbValuesToCurrentCaps,
  getLimbHealingCap,
  prepareTargetedLimbHealingActorUpdate
} = await import("../src/combat/damage-hub.mjs");
const { executeAtomicActorItemUpdates } = await import(
  "../src/utils/atomic-actor-item-updates.mjs"
);

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

function createActor({ gear = [], traumas = [], limbs = {}, consciousness = null } = {}) {
  let fallbackItemReads = 0;
  const actor = {
    id: "limb-health-test",
    documentName: "Actor",
    type: "character",
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
      get(itemId) {
        return [...gear, ...traumas].find(item => String(item.id ?? "") === String(itemId)) ?? null;
      },
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
      combat: {
        consciousnessRecoveryTarget: 0
      },
      limbs,
      resources: {
        health: { min: 0, value: 0, max: 0, spent: 0 },
        ...(consciousness ? { consciousness } : {})
      }
    }
  };
  for (const item of [...gear, ...traumas]) {
    item.documentName ??= "Item";
    item.parent ??= actor;
  }
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

test("targeted limb-healing plan applies the trauma cap and preserves all coupled actor state", () => {
  const actor = createActor({
    traumas: [
      { id: "arm-50", type: "trauma", system: { limbKey: "arm", thresholdPercent: 50 } }
    ],
    limbs: {
      arm: {
        min: -100,
        value: 20,
        max: 100,
        spent: 80,
        missing: false,
        damageAccumulation: { ballistic: 30, fire: 10 }
      }
    },
    consciousness: {
      min: 0,
      value: 10,
      max: 100,
      spent: 90,
      recoveryTarget: 0
    }
  });

  const result = prepareTargetedLimbHealingActorUpdate(actor, "arm", 100);

  assert.equal(result.previousValue, 20);
  assert.equal(result.finalValue, 50);
  assert.equal(result.appliedHealing, 30);
  assert.equal(result.healthDelta, 30);
  assert.equal(result.healingCap, 50);
  assert.equal(getProperty(result.updateData, "system.limbs.arm.value"), 50);
  assert.equal(getProperty(result.updateData, "system.limbs.arm.spent"), 50);
  assert.equal(getProperty(result.updateData, "system.resources.consciousness.value"), 40);
  assert.equal(getProperty(result.updateData, "system.resources.consciousness.spent"), 60);
  assert.equal(
    Object.hasOwn(result.updateData, "system"),
    false,
    "the public healing plan must expose exact dotted paths, never a whole system branch"
  );
  assert.deepEqual(Object.keys(result.updateData).sort(), [
    "system.combat.consciousnessRecoveryTarget",
    "system.limbs.arm.damageAccumulation",
    "system.limbs.arm.spent",
    "system.limbs.arm.value",
    "system.resources.consciousness.spent",
    "system.resources.consciousness.value"
  ]);

  const accumulation = getProperty(result.updateData, "system.limbs.arm.damageAccumulation");
  assert.equal(
    Object.values(accumulation).reduce((sum, value) => sum + value, 0),
    10,
    "healing must dilute, rather than discard, the remaining damage attribution"
  );
  assert.equal(actor.system.limbs.arm.value, 20, "planning must not mutate the Actor");
});

test("targeted healing reports aggregate health separately while a limb crosses zero", () => {
  const actor = createActor({
    limbs: {
      arm: {
        min: -100,
        value: -10,
        max: 100,
        spent: 110,
        missing: false,
        damageAccumulation: { ballistic: 20 }
      }
    }
  });

  const result = prepareTargetedLimbHealingActorUpdate(actor, "arm", 20);

  assert.equal(result.previousValue, -10);
  assert.equal(result.finalValue, 10);
  assert.equal(result.appliedHealing, 20);
  assert.equal(result.healthDelta, 10);
});

test("the real targeted-healing plan and medical supply commit through the strict atomic executor", async () => {
  const tool = {
    id: "doctor-bag",
    type: "gear",
    system: {
      functions: {
        tools: {
          medical: {
            supply: { value: 12, max: 20 }
          }
        }
      }
    }
  };
  const actor = createActor({
    gear: [tool],
    limbs: {
      arm: {
        min: -100,
        value: 20,
        max: 100,
        spent: 80,
        missing: false,
        damageAccumulation: { ballistic: 30, fire: 10 }
      }
    },
    consciousness: {
      min: 0,
      value: 10,
      max: 100,
      spent: 90,
      recoveryTarget: 0
    }
  });
  const healing = prepareTargetedLimbHealingActorUpdate(actor, "arm", 30);
  let batchCalls = 0;

  foundry.documents.modifyBatch = async operations => {
    batchCalls += 1;
    assert.deepEqual(operations.map(operation => operation.documentName), ["Actor", "Item"]);
    return operations.map(operation => (
      operation.updates.map(update => {
        const document = operation.documentName === "Actor"
          ? actor
          : operation.parent.items.get(update._id);
        assert.ok(document, `missing ${operation.documentName} ${update._id}`);
        for (const [path, rawValue] of Object.entries(update)) {
          if (path === "_id") continue;
          setProperty(document, path, cloneValue(TestForcedReplacement.get(rawValue)));
        }
        return document;
      })
    ));
  };

  await executeAtomicActorItemUpdates([
    {
      document: actor,
      updates: healing.updateData,
      documentOptions: {
        falloutMawSkipDamageStatusSync: true,
        falloutMawLimbCapSync: true
      }
    },
    {
      document: tool,
      updates: {
        "system.functions.tools.medical.supply.value": 7
      }
    }
  ], {
    reason: "medicine-limb-treatment-with-tool"
  });

  assert.equal(actor.system.limbs.arm.value, 50);
  assert.equal(actor.system.limbs.arm.spent, 50);
  assert.equal(actor.system.resources.consciousness.value, 40);
  assert.equal(actor.system.resources.consciousness.spent, 60);
  assert.equal(tool.system.functions.tools.medical.supply.value, 7);
  assert.equal(batchCalls, 1);
});
