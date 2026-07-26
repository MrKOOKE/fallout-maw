import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const MACRO_SOURCE = fs.readFileSync(new URL(
  "../scripts/ability-builders/04-blockade.js",
  import.meta.url
), "utf8");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

test("blockade builder installs a direct active-effect aura with a Trial and reusable constructs", async () => {
  const catalog = catalogFixture([{
    id: "keep-me",
    type: "fixed",
    sort: 0
  }], [{
    id: "keep-construct",
    type: "resourceChange",
    name: "preserve construct",
    resources: []
  }]);
  const runtime = await runBuilderMacro(catalog);

  assert.equal(runtime.errors.length, 0);
  assert.equal(runtime.savedCatalogs.length, 1);
  assert.equal(runtime.flushCount, 1);

  const ability = runtime.savedCatalogs[0].categories[0].abilities[0];
  assert.equal(ability.description, "preserve me");
  assert.deepEqual(ability.system.functions.map(entry => entry.id), [
    "keep-me",
    "blockade-active-aura"
  ]);

  const abilityFunction = ability.system.functions[1];
  assert.equal(abilityFunction.type, "activeApplication");
  assert.deepEqual(abilityFunction.activeSettings.costs, [{
    id: "blockade-cost-power",
    resourceKey: "power",
    formula: "50",
    overloadAmount: 100,
    overloadDurationSeconds: 21600,
    payer: "source"
  }]);
  assert.deepEqual(
    abilityFunction.changes.map(change => [change.key, change.value]),
    [
      ["system.damageResistanceBonuses.all.all", "10+resilience/5"],
      ["system.resources.movementPoints.bonus", "-20"]
    ]
  );

  const aura = abilityFunction.conditions.find(condition => condition.type === "aura");
  assert.equal(aura.auraMode, "triggerConditions");
  assert.deepEqual(aura.auraTargetGroups, ["enemy", "neutral"]);
  assert.equal(aura.auraRadiusMeters, "4+resilience/20");
  assert.equal(aura.auraTriggerOnCreate, true);
  assert.equal(aura.auraTriggerOnEnter, true);
  assert.equal(aura.auraRepeatSeconds, 6);
  assert.equal(aura.auraAllowUnconscious, true);
  assert.equal(aura.auraAllowDead, false);

  assert.deepEqual(abilityFunction.actions, []);
  const trial = abilityFunction.conditions.find(condition => condition.type === "trial");
  assert.equal(trial.trialSubject, "targets");
  assert.deepEqual(
    trial.trialEntries.map(entry => [entry.kind, entry.key]),
    [["skill", "science"], ["skill", "resilience"]]
  );
  assert.equal(trial.trialSelectionMode, "best");
  assert.equal(trial.trialDifficultyFormula, "50+resilience");
  assert.deepEqual(trial.trialResultKeys, ["criticalFailure", "failure"]);
  assert.deepEqual(
    trial.trialLinks.map(link => [link.constructId, link.recipient, link.mode]),
    [
      ["blockade-failed-trial-penalty", "subjects", "perSubject"],
      ["blockade-reaction-points-reward", "source", "perSubject"]
    ]
  );

  assert.deepEqual(ability.system.constructs.map(entry => entry.id), [
    "keep-construct",
    "blockade-failed-trial-penalty",
    "blockade-reaction-points-reward"
  ]);
  assert.equal(ability.system.constructs[0].name, "preserve construct");
  const penalty = ability.system.constructs[1];
  assert.equal(penalty.type, "temporaryEffect");
  assert.equal(penalty.durationSeconds, 6);
  assert.deepEqual(
    penalty.changes.map(change => [change.key, change.value]),
    [
      ["system.resources.actionPoints.bonus", "-5"],
      ["system.resources.movementPoints.bonus", "-5"]
    ]
  );
  const reward = ability.system.constructs[2];
  assert.equal(reward.type, "resourceChange");
  assert.deepEqual(
    reward.resources.map(row => [row.resourceKey, row.formula]),
    [["reactionPoints", "5"]]
  );
  assert.equal(
    abilityFunction.conditions.find(condition => condition.type === "duration")?.durationSeconds,
    18
  );
});

test("blockade builder is idempotent and prefers the immutable ability id", async () => {
  const first = await runBuilderMacro(catalogFixture());
  const second = await runBuilderMacro(first.savedCatalogs[0]);
  assert.equal(second.savedCatalogs.length, 0);
  assert.equal(second.infos.some(message => message.includes("уже настроена")), true);

  const renamed = catalogFixture();
  renamed.categories[0].abilities[0].name = "Переименованная блокада";
  const renamedRuntime = await runBuilderMacro(renamed);
  assert.equal(renamedRuntime.savedCatalogs.length, 1);
});

test("blockade runtime executes Trial conditions and editors keep outcomes inside Trial", () => {
  const auraRuntime = fs.readFileSync(new URL("../src/abilities/active-effect-auras.mjs", import.meta.url), "utf8");
  const trialRuntime = fs.readFileSync(new URL("../src/abilities/trial-runtime.mjs", import.meta.url), "utf8");
  const effectCreator = fs.readFileSync(new URL("../src/abilities/fixed-functions.mjs", import.meta.url), "utf8");
  const abilityEvaluation = fs.readFileSync(new URL("../src/abilities/evaluation.mjs", import.meta.url), "utf8");
  const catalogEditor = fs.readFileSync(new URL("../src/apps/ability-catalog-item-editor.mjs", import.meta.url), "utf8");
  const itemSheet = fs.readFileSync(new URL("../src/sheets/item-sheet.mjs", import.meta.url), "utf8");
  const itemModels = fs.readFileSync(new URL("../src/data/models/item-data-models.mjs", import.meta.url), "utf8");
  const catalogTemplate = fs.readFileSync(new URL("../templates/settings/ability-catalog-item-editor.hbs", import.meta.url), "utf8");
  const itemTemplate = fs.readFileSync(new URL("../templates/item/item-sheet.hbs", import.meta.url), "utf8");

  assert.match(auraRuntime, /const indexedAuras = new Map\(\)/);
  assert.match(auraRuntime, /Hooks\.on\("updateWorldTime"/);
  assert.match(auraRuntime, /state\.nextAllowedAt <= worldTime/);
  assert.match(auraRuntime, /if \(state\.nextAllowedAt > worldTime\) continue/);
  assert.match(auraRuntime, /executeAbilityTrials\(\{/);
  assert.match(auraRuntime, /constructs: entry\.constructs/);
  assert.match(trialRuntime, /requestSkillCheckBatch\(\{/);
  assert.match(trialRuntime, /right\.value - left\.value \|\| left\.order - right\.order/);
  assert.match(trialRuntime, /grantActorReactionPoints\(actor, reactionAmount\)/);
  assert.match(trialRuntime, /await actor\.update\(update, \{ falloutMawTrialRuntime: true \}\)/);
  assert.match(trialRuntime, /TRIAL_CONSTRUCT_EFFECT_FLAG_KEY/);
  assert.match(auraRuntime, /collectAuraFormulaIdentifiers/);
  assert.match(auraRuntime, /formulaIdentifiersMatchActorPath/);
  assert.match(effectCreator, /targetTokenUuid/);
  assert.match(effectCreator, /constructData: foundry\.utils\.deepClone/);
  assert.match(effectCreator, /executeAbilityTrials\(\{/);
  assert.match(abilityEvaluation, /condition\.type === ABILITY_CONDITION_TYPES\.trial/);
  assert.doesNotMatch(auraRuntime, /game\.actors/);
  assert.match(catalogEditor, /ordinaryActions: preparedActions/);
  assert.match(catalogEditor, /constructs: abilityConstructs\.map/);
  assert.match(itemSheet, /ordinaryActions: preparedActions/);
  assert.match(itemSheet, /abilityConstructs:/);
  assert.match(catalogEditor, /label: "Испытание"/);
  assert.match(itemSheet, /label: "Испытание"/);
  assert.match(catalogTemplate, /trialDifficultyFormula/);
  assert.match(itemTemplate, /trialDifficultyFormula/);
  assert.match(catalogTemplate, /Последствия при подходящем результате/);
  assert.match(itemTemplate, /Последствия при подходящем результате/);
  assert.doesNotMatch(catalogTemplate, /<h2>Конструкты способности<\/h2>/);
  assert.doesNotMatch(itemTemplate, /<h2>Конструкты способности<\/h2>/);
  assert.match(catalogTemplate, /fallout-maw-trauma-effect-row/);
  assert.doesNotMatch(catalogTemplate, /<legend>Воздействие ауры<\/legend>/);
  assert.doesNotMatch(itemTemplate, /<legend>Воздействие ауры<\/legend>/);
  assert.doesNotMatch(catalogTemplate, /sourceResourceKey|targetChangeKey/);
  assert.doesNotMatch(itemTemplate, /sourceResourceKey|targetChangeKey/);
  assert.doesNotMatch(catalogEditor, /ABILITY_ACTION_TYPES\.skillCheck/);
  assert.doesNotMatch(itemSheet, /ABILITY_ACTION_TYPES\.skillCheck/);
  assert.doesNotMatch(itemModels, /"movementRoute", "skillCheck"/);
});

test("blockade builder flushes and refreshes an open catalog editor instead of being overwritten", async () => {
  const runtime = await runBuilderMacro(catalogFixture(), { openEditors: true });

  assert.equal(runtime.errors.length, 0);
  assert.equal(runtime.editorFlushCount, 1);
  assert.equal(runtime.editorRenderCount, 1);
  assert.equal(runtime.catalogSaveCount, 1);
  assert.equal(runtime.savedCatalogs.length, 1);
  assert.equal(
    runtime.savedCatalogs[0].categories[0].abilities[0].system.functions
      .some(entry => entry.id === "blockade-active-aura"),
    true
  );
});

async function runBuilderMacro(catalog, { openEditors = false } = {}) {
  const savedCatalogs = [];
  const infos = [];
  const errors = [];
  let flushCount = 0;
  let editorFlushCount = 0;
  let editorRenderCount = 0;
  let catalogSaveCount = 0;
  let currentCatalog = structuredClone(catalog);

  const settings = {
    get: () => currentCatalog,
    set: async (_systemId, _settingKey, value) => {
      currentCatalog = structuredClone(value);
      savedCatalogs.push(structuredClone(value));
      return currentCatalog;
    }
  };

  const applications = new Map();
  if (openEditors) {
    const catalogApp = {
      catalog: structuredClone(currentCatalog),
      async saveAbility(categoryId, ability) {
        catalogSaveCount += 1;
        const category = this.catalog.categories.find(entry => entry.id === categoryId);
        const index = category.abilities.findIndex(entry => entry.id === ability.id);
        category.abilities[index] = structuredClone(ability);
        await settings.set("fallout-maw", "abilitiesCatalog", this.catalog);
        return structuredClone(ability);
      }
    };
    const editorApp = {
      abilityId: "Yk0zPbkMsK3CrTTB",
      ability: structuredClone(currentCatalog.categories[0].abilities[0]),
      form: {},
      async _processFormData() {
        editorFlushCount += 1;
      },
      async render() {
        editorRenderCount += 1;
      }
    };
    applications.set("fallout-maw-ability-settings", catalogApp);
    applications.set("fallout-maw-ability-catalog-item-editor", editorApp);
  }

  globalThis.foundry = {
    applications: { instances: applications },
    utils: {
      deepClone: value => structuredClone(value)
    }
  };
  globalThis.game = {
    system: { id: "fallout-maw" },
    user: { isGM: true },
    settings
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

  const execute = new AsyncFunction(MACRO_SOURCE);
  await execute();
  return {
    savedCatalogs,
    infos,
    errors,
    editorFlushCount,
    editorRenderCount,
    catalogSaveCount,
    get flushCount() {
      return flushCount;
    }
  };
}

function catalogFixture(functions = [], constructs = []) {
  return {
    categories: [{
      id: "skill-resilience",
      name: "Стойкость",
      abilities: [{
        id: "Yk0zPbkMsK3CrTTB",
        name: "Блокада",
        description: "preserve me",
        system: {
          cost: 6000,
          functions,
          constructs
        }
      }]
    }]
  };
}
