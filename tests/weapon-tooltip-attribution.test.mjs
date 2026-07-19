import assert from "node:assert/strict";
import test from "node:test";

globalThis.foundry = {
  applications: {
    api: {
      ApplicationV2: class {},
      DialogV2: class {},
      HandlebarsApplicationMixin: Base => Base
    },
    handlebars: { renderTemplate: () => "" },
    ux: { FormDataExtended: class {} }
  },
  documents: {
    ActiveEffect: { implementation: { CHANGE_TYPES: {} } }
  },
  utils: {
    deepClone: value => structuredClone(value),
    getProperty: (object, path) => String(path ?? "").split(".").reduce((value, key) => value?.[key], object),
    hasProperty: (object, path) => String(path ?? "").split(".").every(key => {
      if (object === null || object === undefined || !(key in Object(object))) return false;
      object = object[key];
      return true;
    }),
    mergeObject: (original, other) => ({ ...structuredClone(original), ...structuredClone(other) }),
    randomID: () => "generated",
    setProperty(object, path, value) {
      const parts = String(path ?? "").split(".");
      const key = parts.pop();
      const target = parts.reduce((entry, part) => (entry[part] ??= {}), object);
      target[key] = value;
      return true;
    }
  }
};

globalThis.game = {
  i18n: {
    has: () => false,
    localize: key => String(key)
  },
  settings: { get: () => null }
};

const { getWeaponActionPointCostAttribution } = await import("../src/utils/weapon-tooltip-attribution.mjs");

function createActor(effects = [], { items = [] } = {}) {
  return {
    effects,
    items,
    allApplicableEffects() {
      return effects;
    }
  };
}

function createAtRandomAbility(reduction) {
  return {
    id: "at-random",
    type: "ability",
    name: "At Random",
    img: "icons/at-random.svg",
    system: {
      functions: [{
        id: "at-random-function",
        type: "fixed",
        fixedKey: "atRandom",
        fixedSettings: { actionPointCostReduction: reduction }
      }]
    }
  };
}

function createEffect(id, name, changes, { postureAction = "" } = {}) {
  return {
    id,
    uuid: `Actor.test.ActiveEffect.${id}`,
    name,
    img: `icons/${id}.svg`,
    disabled: false,
    system: { changes },
    getFlag(scope, key) {
      if (scope === "fallout-maw" && key === "postureMovement" && postureAction) {
        return { action: postureAction };
      }
      return null;
    }
  };
}

function assertContinuousTrace(result) {
  let running = result.baseCost;
  for (const source of result.sources) {
    for (const step of source.steps) {
      assert.equal(step.before, running, `trace gap before ${source.name}`);
      running = step.after;
    }
  }
  assert.equal(running, result.cost);
}

test("weapon action cost attribution preserves module and effect sources", () => {
  const effect = {
    id: "quick-shot",
    uuid: "Actor.test.ActiveEffect.quick-shot",
    name: "Quick Shot",
    img: "icons/svg/clockwork.svg",
    disabled: false,
    system: {
      changes: [{ key: "system.costs.action", type: "add", value: -1 }]
    }
  };
  const moduleItemData = {
    _id: "light-frame",
    name: "Light Frame",
    img: "icons/svg/item-bag.svg",
    system: {
      functions: {
        module: {
          weapon: { actionPointCosts: { aimedShot: -2 } }
        }
      }
    }
  };

  const result = getWeaponActionPointCostAttribution(
    createActor([effect]),
    { aimedShot: { actionPointCost: 3 } },
    "aimedShot",
    { aimedShot: { actionPointCost: 5 } },
    { moduleSlots: [{ id: "frame", itemData: moduleItemData }] }
  );

  assert.equal(result.baseCost, 5);
  assert.equal(result.configuredCost, 3);
  assert.equal(result.cost, 2);
  assert.equal(result.tone, "cheaper");
  assert.deepEqual(result.sources.map(source => ({
    name: source.name,
    delta: source.delta,
    operation: source.operation,
    before: source.before,
    after: source.after,
    kind: source.kind
  })), [
    { name: "Light Frame", delta: -2, operation: "add", before: 5, after: 3, kind: "module" },
    { name: "Quick Shot", delta: -1, operation: "add", before: 3, after: 2, kind: "effect" }
  ]);
  assert.deepEqual(result.sources[1].steps, [{
    operation: "add",
    before: 3,
    after: 2,
    value: -1,
    changeKey: "system.costs.action"
  }]);
  assertContinuousTrace(result);
});

test("weapon action cost attribution keeps legacy default action costs", () => {
  const actor = createActor();
  assert.equal(getWeaponActionPointCostAttribution(actor, {}, "snapshot").cost, 5);
  assert.equal(getWeaponActionPointCostAttribution(actor, {}, "reload").cost, 2);
});

test("action effects apply multipliers before additions regardless of document order", () => {
  const actor = createActor([
    createEffect("add-first", "Add First", [
      { key: "system.costs.action", type: "add", value: 2 }
    ]),
    createEffect("multiply-second", "Multiply Second", [
      { key: "system.costs.action", type: "multiply", value: 2 }
    ])
  ]);

  const result = getWeaponActionPointCostAttribution(
    actor,
    { aimedShot: { actionPointCost: 5 } },
    "aimedShot"
  );

  assert.equal(result.cost, 12);
  assert.deepEqual(result.sources.map(source => source.name), ["Multiply Second", "Add First"]);
  assert.deepEqual(result.sources.map(source => source.steps[0]).map(step => ({
    operation: step.operation,
    before: step.before,
    after: step.after,
    value: step.value
  })), [
    { operation: "multiply", before: 5, after: 10, value: 2 },
    { operation: "add", before: 10, after: 12, value: 2 }
  ]);
  assertContinuousTrace(result);
});

test("specific action override wins over the general override", () => {
  const actor = createActor([
    createEffect("general-override", "General Override", [
      { key: "system.costs.action", type: "override", value: 4 }
    ]),
    createEffect("general-multiply", "General Multiply", [
      { key: "system.costs.action", type: "multiply", value: 2 }
    ]),
    createEffect("specific-override", "Specific Override", [
      { key: "system.costs.actions.aimedShot", type: "override", value: 7 }
    ]),
    createEffect("specific-add", "Specific Add", [
      { key: "system.costs.actions.aimedShot", type: "add", value: 1 }
    ])
  ]);

  const result = getWeaponActionPointCostAttribution(
    actor,
    { aimedShot: { actionPointCost: 5 } },
    "aimedShot"
  );

  assert.equal(result.cost, 15);
  assert.deepEqual(result.sources.map(source => source.name), [
    "Specific Override",
    "General Multiply",
    "Specific Add"
  ]);
  assert.equal(result.sources.some(source => source.name === "General Override"), false);
  assertContinuousTrace(result);
});

test("posture override and multiplier are evaluated from a zero bonus", () => {
  const postureKey = "system.postures.crawl.weaponActionCost";
  const actor = createActor([
    createEffect("posture", "Crawl", [
      { key: postureKey, type: "multiply", value: 3 },
      { key: postureKey, type: "override", value: 2 }
    ], { postureAction: "crawl" })
  ]);

  const result = getWeaponActionPointCostAttribution(
    actor,
    { aimedShot: { actionPointCost: 5 } },
    "aimedShot"
  );

  assert.equal(result.cost, 11);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].name, "Crawl");
  assert.deepEqual(result.sources[0].steps.map(step => ({
    operation: step.operation,
    before: step.before,
    after: step.after,
    scope: step.scope,
    scopeBefore: step.scopeBefore,
    scopeAfter: step.scopeAfter
  })), [
    { operation: "override", before: 5, after: 7, scope: "postureBonus", scopeBefore: 0, scopeAfter: 2 },
    { operation: "multiply", before: 7, after: 11, scope: "postureBonus", scopeBefore: 2, scopeAfter: 6 }
  ]);
  assertContinuousTrace(result);
});

test("posture is added before at-random and final rounding clamps the result", () => {
  const postureKey = "system.postures.crawl.weaponActionCost";
  const actor = createActor([
    createEffect("posture-add", "Crawl Bonus", [
      { key: postureKey, type: "add", value: 1.5 }
    ], { postureAction: "crawl" })
  ], { items: [createAtRandomAbility(10)] });

  const result = getWeaponActionPointCostAttribution(
    actor,
    { aimedShot: { actionPointCost: 5 } },
    "aimedShot"
  );

  assert.equal(result.cost, 0);
  assert.deepEqual(result.sources.map(source => source.kind), ["posture", "ability", "calculation"]);
  assert.deepEqual(result.sources.flatMap(source => source.steps).map(step => [step.before, step.after]), [
    [5, 6.5],
    [6.5, -3.5],
    [-3.5, 0]
  ]);
  assertContinuousTrace(result);
});
