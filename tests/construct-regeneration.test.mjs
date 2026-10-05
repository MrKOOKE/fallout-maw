import assert from "node:assert/strict";
import test from "node:test";

function mergeObject(target, source, { inplace = true } = {}) {
  const result = inplace ? target : structuredClone(target);
  for (const [key, value] of Object.entries(source ?? {})) {
    result[key] = value && typeof value === "object" && !Array.isArray(value)
      ? mergeObject(result[key] ?? {}, value) : structuredClone(value);
  }
  return result;
}
globalThis.foundry = { applications: { api: { ApplicationV2: class {}, DialogV2: class {} },
  ux: { FormDataExtended: class {} }, handlebars: { HandlebarsApplicationMixin: Base => Base } },
  utils: { deepClone: structuredClone, mergeObject } };
globalThis.game = { user: { isGM: true }, i18n: { localize: key => key, format: key => key }, settings: { get(_scope, key) {
  if (key === "resourceSettings") return [{ key: "health", abbr: "hp", formula: "100" },
    { key: "power", abbr: "energy", formula: "100" }];
  if (key === "creatureOptions") return { types: [{ id: "human" }], races: [{ id: "human", typeId: "human",
    regeneration: { formula: "13", energyFormula: "17" } }] };
} } };
const { getActorRegenerationRate } = await import("../src/needs/regeneration-rates.mjs");
const { actorMayNeedRegeneration } = await import("../src/needs/regeneration.mjs");
const { HEALTH_REGENERATION_EFFECT_KEY: healthKey, ENERGY_REGENERATION_EFFECT_KEY: energyKey } =
  await import("../src/needs/regeneration-effect-keys.mjs");
const { prepareActorEffectChangeForApplication } = await import("../src/utils/active-effect-changes.mjs");
const { buildEffectKeyTokens } = await import("../src/utils/effect-key-tokens.mjs");
const { buildConstructRegenerationUpdates } = await import("../src/needs/regeneration-allocation.mjs");

function actor(type = "construct", effects = []) {
  return { uuid: "Actor.regen", name: "Regeneration test", type, isOwner: true, effects,
    items: Object.assign([], { contents: [] }),
    system: { creature: { raceId: "human" }, characteristics: {}, skills: {}, resources: {
      health: { value: 50, max: 100 }, power: { value: 50, max: 100 }
    } } };
}
const effect = changes => ({ active: true, disabled: false, system: { changes } });
const change = (key, value, type = "add", priority = 0) => ({ key, value: String(value), type, priority });

test("constructs never inherit race or fallback regeneration and do not enter the time processor without an explicit grant", () => {
  const construct = actor();
  for (const raceId of ["human", "missing", ""]) {
    construct.system.creature.raceId = raceId;
    assert.equal(getActorRegenerationRate(construct), 0);
    assert.equal(getActorRegenerationRate(construct, { resource: "energy" }), 0);
    assert.equal(actorMayNeedRegeneration(construct), false);
  }
  construct.items.push({ type: "trauma", system: { healingProgress: 0, healingProgressMax: 100 } });
  assert.equal(actorMayNeedRegeneration(construct), false);
});

test("ordinary actors retain race regeneration and unknown races retain their biological fallback", () => {
  const character = actor("character");
  assert.equal(getActorRegenerationRate(character), 13);
  assert.equal(getActorRegenerationRate(character, { resource: "energy" }), 17);
  assert.equal(actorMayNeedRegeneration(character), true);
  character.system.creature.raceId = "missing";
  assert.ok(getActorRegenerationRate(character) > 0);
});

test("explicit health and energy grants work independently and disabling them removes a construct from regeneration", () => {
  const health = effect([change(healthKey, 7)]), energy = effect([change(energyKey, 3)]);
  const construct = actor("construct", [health, energy]);
  assert.equal(getActorRegenerationRate(construct), 7);
  assert.equal(getActorRegenerationRate(construct, { resource: "energy" }), 3);
  assert.equal(actorMayNeedRegeneration(construct), true);
  health.disabled = true;
  assert.equal(getActorRegenerationRate(construct), 0);
  assert.equal(getActorRegenerationRate(construct, { resource: "energy" }), 3);
  energy.active = false;
  assert.equal(actorMayNeedRegeneration(construct), false);
});

test("regeneration modifiers use effect priorities and arithmetic, including an explicit zero override of racial regeneration", () => {
  const construct = actor("construct", [effect([change(healthKey, 2, "multiply", 30), change(healthKey, 7, "add", 20)])]);
  assert.equal(getActorRegenerationRate(construct), 14);
  const character = actor("character", [effect([change(healthKey, 0, "override", 30), change(healthKey, 5, "add", 10)])]);
  assert.equal(getActorRegenerationRate(character), 0);
  character.effects[0].system.changes = [change(healthKey, -30)];
  assert.equal(getActorRegenerationRate(character), 0);
});

test("full constructs do not create hourly writes and regeneration keys are offered in the shared editor", () => {
  const construct = actor("construct", [effect([change(healthKey, 7), change(energyKey, 3)])]);
  construct.system.resources.health.value = 100;
  construct.system.resources.power.value = 100;
  assert.equal(actorMayNeedRegeneration(construct), false);
  const keys = buildEffectKeyTokens().map(token => token.path);
  assert.ok(keys.includes(healthKey));
  assert.ok(keys.includes(energyKey));
  assert.equal(prepareActorEffectChangeForApplication(construct, change(healthKey, 7)), null);
  assert.equal(prepareActorEffectChangeForApplication(construct, change(energyKey, 3)), null);
});

test("assigned health regeneration repairs installed part conditions once, caps healing, and leaves cargo and absent slots alone", () => {
  const part = (id, value, max, installed = true) => ({ id, type: "gear", system: {
    placement: { mode: installed ? "constructPart" : "root", limbKey: id },
    functions: { constructPart: { enabled: true }, condition: { enabled: true, value, max } }
  } });
  const construct = actor();
  construct.items = [part("small", 9, 10), part("large", 5, 20), part("broken", 0, 10), part("cargo", 1, 100, false)];
  construct.system.constructPartSlots = [{ id: "missing", profile: { conditionMax: 100 } }];
  const updates = buildConstructRegenerationUpdates(construct, 7);
  assert.deepEqual(updates, [{ _id: "small", "system.functions.condition.value": 10 },
    { _id: "large", "system.functions.condition.value": 8 }, { _id: "broken", "system.functions.condition.value": 3 }]);
  assert.equal(buildConstructRegenerationUpdates(construct, 0).length, 0);
  const capped = buildConstructRegenerationUpdates(construct, 1000);
  assert.deepEqual(capped.map(row => row["system.functions.condition.value"]), [10, 20, 10]);
  assert.equal(buildConstructRegenerationUpdates(actor("character"), 7).length, 0);
});
