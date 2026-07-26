import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const MACRO_SOURCE = fs.readFileSync(new URL(
  "../scripts/ability-builders/03-adaptive-resistance.js",
  import.meta.url
), "utf8");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

test("adaptive resistance builder finds the catalog ability and installs its complete function", async () => {
  const unrelatedFunction = {
    id: "unrelated-function",
    type: "fixed",
    sort: 0
  };
  const catalog = catalogFixture({
    functions: [unrelatedFunction]
  });
  const runtime = await runBuilderMacro(catalog);

  assert.equal(runtime.errors.length, 0);
  assert.equal(runtime.savedCatalogs.length, 1);
  assert.equal(runtime.flushCount, 1);

  const savedAbility = runtime.savedCatalogs[0].categories[0].abilities[0];
  assert.equal(savedAbility.description, "preserve me");
  assert.equal(savedAbility.system.cost, 3000);
  assert.deepEqual(
    savedAbility.system.functions.map(entry => entry.id),
    ["unrelated-function", "adaptive-resistance-accumulator"]
  );

  const abilityFunction = savedAbility.system.functions[1];
  assert.equal(abilityFunction.type, "effectChanges");
  assert.equal(Object.hasOwn(abilityFunction, "effectApplication"), false);
  const accumulationCondition = abilityFunction.conditions
    .find(condition => condition.type === "accumulation");
  assert.deepEqual(accumulationCondition.accumulation, {
    name: "Адаптивное сопротивление",
    valueSource: "damageActualHealthLoss",
    percent: 10,
    groupBy: "damageType",
    totalCap: 50,
    bucketCap: 0,
    rounding: "floorTotal",
    durationPolicy: "fromFirst"
  });
  assert.deepEqual(abilityFunction.changes, [{
    id: "adaptive-resistance-change",
    key: "system.damageResistanceBonuses.all.{group}",
    type: "add",
    value: "1",
    phase: "initial",
    priority: 0,
    valueSource: "accumulation",
    accumulatorExchange: {
      conditionId: "adaptive-resistance-points",
      mode: "invested"
    }
  }]);

  const eventCondition = abilityFunction.conditions.find(condition => condition.type === "eventReaction");
  assert.equal(eventCondition.eventKey, "fallout-maw.damage.resolved");
  assert.equal(eventCondition.reactionMode, "isolatedAuto");
  assert.equal(eventCondition.allowUnconscious, true);
  assert.equal(eventCondition.allowDead, false);
  assert.deepEqual(eventCondition.trackingTargets, ["owner"]);

  const durationCondition = abilityFunction.conditions.find(condition => condition.type === "duration");
  assert.equal(durationCondition.durationSeconds, 86400);
});

test("adaptive resistance builder is idempotent and does not touch issued actor items", async () => {
  const firstRuntime = await runBuilderMacro(catalogFixture());
  const firstCatalog = firstRuntime.savedCatalogs[0];
  const actorItem = {
    name: "Адаптивное сопротивление",
    system: { functions: [] }
  };

  const secondRuntime = await runBuilderMacro(firstCatalog, {
    actorItems: [actorItem]
  });

  assert.equal(secondRuntime.savedCatalogs.length, 0);
  assert.equal(secondRuntime.infos.some(message => message.includes("уже настроено")), true);
  assert.deepEqual(actorItem.system.functions, []);
});

test("adaptive resistance builder refuses missing or ambiguous catalog matches", async () => {
  const missingRuntime = await runBuilderMacro({ categories: [] });
  assert.equal(missingRuntime.savedCatalogs.length, 0);
  assert.equal(missingRuntime.errors.some(message => message.includes("не найдена")), true);

  const ambiguousCatalog = catalogFixture();
  ambiguousCatalog.categories.push({
    id: "other",
    name: "Other",
    abilities: [{
      id: "duplicate",
      name: "  АДАПТИВНОЕ   СОПРОТИВЛЕНИЕ ",
      system: { functions: [] }
    }]
  });
  const ambiguousRuntime = await runBuilderMacro(ambiguousCatalog);
  assert.equal(ambiguousRuntime.savedCatalogs.length, 0);
  assert.equal(ambiguousRuntime.errors.some(message => message.includes("несколько")), true);
});

async function runBuilderMacro(catalog, { actorItems = [] } = {}) {
  const savedCatalogs = [];
  const infos = [];
  const errors = [];
  let flushCount = 0;

  globalThis.foundry = {
    utils: {
      deepClone: value => structuredClone(value)
    }
  };
  globalThis.game = {
    system: { id: "fallout-maw" },
    user: { isGM: true },
    actors: {
      contents: [{
        items: { contents: actorItems }
      }]
    },
    settings: {
      get: () => catalog,
      set: async (_systemId, _settingKey, value) => {
        savedCatalogs.push(structuredClone(value));
      }
    }
  };
  globalThis.ui = {
    notifications: {
      info: message => infos.push(String(message)),
      error: message => errors.push(String(message))
    }
  };
  globalThis.CONFIG = {
    FalloutMaW: {
      settingsPresets: {
        flush: async () => {
          flushCount += 1;
        }
      }
    }
  };

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const execute = new AsyncFunction(MACRO_SOURCE);
    await execute();
  } finally {
    console.error = originalConsoleError;
  }

  return {
    savedCatalogs,
    infos,
    errors,
    get flushCount() {
      return flushCount;
    }
  };
}

function catalogFixture({ functions = [] } = {}) {
  return {
    categories: [{
      id: "skill-resilience",
      name: "Стойкость",
      abilities: [{
        id: "LBlBhvSdFu9lQ4bL",
        name: "Адаптивное сопротивление",
        description: "preserve me",
        system: {
          cost: 3000,
          functions
        }
      }]
    }]
  };
}
