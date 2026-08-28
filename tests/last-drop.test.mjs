import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

globalThis.foundry = {
  applications: {
    api: { DialogV2: class DialogV2 {} },
    ux: { FormDataExtended: class FormDataExtended {} },
    handlebars: { renderTemplate: async () => "" }
  },
  utils: {
    deepClone: value => structuredClone(value),
    randomID: () => "generated-id"
  }
};
globalThis.game = {
  user: { id: "gm", isGM: true },
  time: { worldTime: 100 }
};

const { SYSTEM_ID } = await import("../src/constants.mjs");
const {
  ABILITY_FIXED_FUNCTION_KEYS,
  ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY,
  normalizeLastDropSettings
} = await import("../src/settings/abilities.mjs");
const { ABILITY_OVERLOAD_EFFECT_FLAG_KEY } = await import("../src/abilities/overload.mjs");
const {
  LAST_DROP_EFFECT_FLAG_KEY,
  buildLastDropEffectChanges,
  buildLastDropRedistributionPlan,
  findLastDropEffect,
  getLastDropAbilityProgressEntry,
  isLastDropUnconsciousnessTriggerDisabled,
  preventLastDropLethalDamage,
  preventLastDropUnconsciousness,
  toggleLastDropUnconsciousnessTrigger
} = await import("../src/abilities/last-drop.mjs");

test("last drop defaults and configured characteristic/resistance effect keys match the ability", () => {
  assert.deepEqual(normalizeLastDropSettings(), {
    energyCost: 50,
    overloadEnergyCost: 200,
    overloadDurationSeconds: 43200,
    durationSeconds: 24,
    characteristicBonusFormula: "1+resilience/100",
    resistanceBonusFormula: "10+resilience/5",
    redistributionMinimumPercent: -50
  });
  assert.deepEqual(
    buildLastDropEffectChanges({}, {}, { characteristicKeys: ["strength", "agility", "strength"] }),
    [{
      key: "system.combat.unconsciousnessImmunity",
      type: "add",
      value: "1",
      phase: "initial",
      priority: null
    }, {
      key: "system.characteristics.strength",
      type: "add",
      value: "1+resilience/100",
      phase: "initial",
      priority: null
    }, {
      key: "system.characteristics.agility",
      type: "add",
      value: "1+resilience/100",
      phase: "initial",
      priority: null
    }, {
      key: "system.damageResistanceBonuses.all.all",
      type: "add",
      value: "10+resilience/5",
      phase: "initial",
      priority: null
    }]
  );
});

test("lethal damage is spread only across other existing limbs strictly above minus fifty percent", () => {
  const actor = createActor({
    limbs: {
      head: limb(10, { critical: true }),
      torso: limb(20, { critical: true }),
      leftArm: limb(80),
      rightArm: limb(-50),
      missingLeg: limb(80, { missing: true })
    }
  });
  const plan = buildLastDropRedistributionPlan({
    actor,
    requests: [{ limbKey: "head", amount: 160 }],
    estimate: {
      limbStates: new Map([["head", { nextValue: -100, min: -100 }]])
    },
    amount: 160,
    minimumPercent: -50
  });

  assert.equal(plan.complete, true);
  assert.equal(plan.capacity, 200);
  assert.equal(plan.limbs.reduce((total, entry) => total + entry.amount, 0), 160);
  assert.deepEqual(Object.keys(plan.updates).sort(), [
    "system.limbs.leftArm.value",
    "system.limbs.torso.value"
  ]);
  assert.ok(Object.values(plan.updates).every(value => value >= -50));
  assert.equal(Object.hasOwn(plan.updates, "system.limbs.head.value"), false);
  assert.equal(Object.hasOwn(plan.updates, "system.limbs.rightArm.value"), false);
});

test("insufficient eligible limb capacity never commits partial redistribution", () => {
  const actor = createActor({
    limbs: {
      head: limb(10, { critical: true }),
      arm: limb(-40)
    }
  });
  const plan = buildLastDropRedistributionPlan({
    actor,
    requests: [{ limbKey: "head", amount: 11 }],
    amount: 11,
    minimumPercent: -50
  });

  assert.equal(plan.complete, false);
  assert.equal(plan.capacity, 10);
  assert.deepEqual(plan.updates, {});
});

test("lethal activation spends energy once, creates the standard overload, and redirects without nested damage", async () => {
  const actor = createActor({
    id: "lethal",
    energy: 150,
    limbs: {
      head: limb(10, { critical: true }),
      torso: limb(60, { critical: true }),
      arm: limb(70)
    }
  });
  const result = await preventLastDropLethalDamage({
    actor,
    requests: [{ limbKey: "head", amount: 100 }],
    estimate: { limbStates: new Map([["head", { nextValue: -100, min: -100 }]]) },
    amount: 100
  });

  assert.equal(result.handled, true);
  assert.equal(result.prevented, true);
  assert.equal(result.redirectedAmount, 100);
  assert.equal(actor.system.resources.power.value, 100);
  assert.equal(actor.system.limbs.head.value, 10);
  assert.equal((60 - actor.system.limbs.torso.value) + (70 - actor.system.limbs.arm.value), 100);

  const effect = findLastDropEffect(actor);
  const overload = actor.effects.find(candidate => candidate.flags?.[SYSTEM_ID]?.[ABILITY_OVERLOAD_EFFECT_FLAG_KEY]);
  assert.ok(effect);
  assert.equal(effect.duration.seconds, 24);
  assert.ok(overload);
  assert.equal(overload.duration.seconds, 43200);
  assert.equal(overload.system.changes[0].value, "200");

  const repeated = await preventLastDropLethalDamage({
    actor,
    requests: [{ limbKey: "head", amount: 10 }],
    estimate: { limbStates: new Map([["head", { nextValue: -100, min: -100 }]]) },
    amount: 10
  });
  assert.equal(repeated.prevented, true);
  assert.equal(actor.system.resources.power.value, 100);
  assert.equal(actor.effects.length, 2);
});

test("automatic unconsciousness trigger defaults on and the HUD toggle disables only that trigger", async () => {
  const actor = createActor({ id: "toggle", energy: 100 });
  const abilityItem = actor.items[0];
  const abilityFunction = abilityItem.system.functions[0];

  assert.equal(isLastDropUnconsciousnessTriggerDisabled(abilityItem, abilityFunction), false);
  assert.equal(getLastDropAbilityProgressEntry(abilityItem, abilityFunction).value, "активирует");

  await toggleLastDropUnconsciousnessTrigger(abilityItem, abilityFunction);
  assert.equal(isLastDropUnconsciousnessTriggerDisabled(abilityItem, abilityFunction), true);
  assert.equal(
    abilityItem.getFlag(SYSTEM_ID, ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY)?.["last-drop-fixed:lastDrop"]?.active,
    true
  );
  assert.equal(getLastDropAbilityProgressEntry(abilityItem, abilityFunction).value, "не активирует");
  assert.deepEqual(await preventLastDropUnconsciousness({ actor }), {
    handled: false,
    prevented: false
  });
  assert.equal(actor.system.resources.power.value, 100);

  const lethal = await preventLastDropLethalDamage({
    actor,
    requests: [{ limbKey: "head", amount: 20 }],
    estimate: { limbStates: new Map([["head", { nextValue: -100, min: -100 }]]) },
    amount: 20
  });
  assert.equal(lethal.prevented, true);
  assert.equal(actor.system.resources.power.value, 50);
});

test("unconsciousness activates before incapacitation and concurrent triggers do not duplicate effects", async () => {
  const actor = createActor({ id: "unconscious", energy: 100 });
  const results = await Promise.all([
    preventLastDropUnconsciousness({ actor }),
    preventLastDropUnconsciousness({ actor })
  ]);

  assert.deepEqual(results, [
    { handled: true, prevented: true },
    { handled: true, prevented: true }
  ]);
  assert.equal(actor.system.resources.power.value, 50);
  assert.equal(actor.effects.length, 2);
  assert.equal(actor.system.combat.unconsciousnessImmunity, 1);

  const damageHub = await readFile(new URL("../src/combat/damage-hub.mjs", import.meta.url), "utf8");
  const start = damageHub.indexOf("async function synchronizeActorVitalStatuses");
  const end = damageHub.indexOf("async function knockdownActorForIncapacitation", start);
  const synchronization = damageHub.slice(start, end);
  assert.match(damageHub, /export function registerUnconsciousnessPreventionHandler/);
  assert.ok(synchronization.indexOf("await handler({ actor })") >= 0);
  assert.ok(
    synchronization.indexOf("await handler({ actor })")
      < synchronization.indexOf("await knockdownActorForIncapacitation(actor, STATUS_EFFECTS.unconscious)")
  );
});

test("last drop does not activate without the complete energy cost", async () => {
  for (const energy of [0, 49]) {
    const actor = createActor({ id: `insufficient-${energy}`, energy });
    assert.deepEqual(await preventLastDropUnconsciousness({ actor }), {
      handled: false,
      prevented: false
    });
    assert.equal(actor.system.resources.power.value, energy);
    assert.equal(actor.effects.length, 0);
  }
});

test("fixed runtime gates registration, prioritizes last drop, and integrates its HUD toggle/progress", async () => {
  const fixed = await readFile(new URL("../src/abilities/fixed-functions.mjs", import.meta.url), "utf8");
  const start = fixed.indexOf("function registerFixedAbilityRuntimeHooks()");
  const lastDrop = fixed.indexOf("registerLastDropRuntime();", start);
  const lastChance = fixed.indexOf(
    "registerLethalDamagePreventionHandler(runFixedAbilityRuntimeHandler(context => processLastChanceLethalDamage(context)))",
    start
  );
  const registration = fixed.slice(start, lastDrop);

  assert.ok(start >= 0);
  assert.match(registration, /if\s*\(fixedAbilityRuntimeHooksRegistered\s*\|\|\s*!areFixedAbilityFunctionsEnabled\(\)\)\s*return/);
  assert.ok(lastDrop > start && lastChance > lastDrop);
  assert.match(fixed, /return getLastDropAbilityProgressEntry\(abilityItem, entry\)/);
  assert.match(fixed, /await toggleLastDropUnconsciousnessTrigger\(item, abilityFunction\)/);
});

function createActor({
  id = "last-drop",
  energy = 100,
  limbs = {
    head: limb(10, { critical: true }),
    torso: limb(60, { critical: true }),
    arm: limb(70)
  }
} = {}) {
  const actor = {
    id,
    uuid: `Actor.${id}`,
    documentName: "Actor",
    type: "character",
    isOwner: true,
    statuses: new Set(),
    effects: [],
    items: [],
    flags: {},
    system: {
      limbs: structuredClone(limbs),
      characteristics: { strength: 5, agility: 6 },
      combat: { unconsciousnessImmunity: 0 },
      resources: {
        power: { value: energy, min: 0, max: 300, spent: 300 - energy },
        consciousness: { value: 0, min: 0, max: 100 }
      }
    },
    async update(changes) {
      for (const [path, value] of Object.entries(changes)) {
        const segments = path.split(".");
        let current = this;
        for (const segment of segments.slice(0, -1)) current = current[segment];
        current[segments.at(-1)] = value;
      }
      return this;
    },
    async createEmbeddedDocuments(documentName, entries) {
      assert.equal(documentName, "ActiveEffect");
      const effects = entries.map(data => {
        const effect = {
          id: `effect-${this.effects.length + 1}`,
          parent: this,
          ...structuredClone(data),
          getFlag(scope, key) {
            return this.flags?.[scope]?.[key];
          }
        };
        this.effects.push(effect);
        for (const change of effect.system?.changes ?? []) {
          if (change.key === "system.combat.unconsciousnessImmunity") {
            this.system.combat.unconsciousnessImmunity += Number(change.value) || 0;
          }
        }
        return effect;
      });
      return effects;
    },
    async deleteEmbeddedDocuments(documentName, ids) {
      assert.equal(documentName, "ActiveEffect");
      this.effects = this.effects.filter(effect => !ids.includes(effect.id));
      return [];
    }
  };
  const abilityItem = {
    id: "last-drop-item",
    uuid: `${actor.uuid}.Item.last-drop-item`,
    type: "ability",
    name: "До последней капли",
    img: "last-drop.webp",
    parent: actor,
    flags: {},
    system: {
      functions: [{
        id: "last-drop-fixed",
        type: "fixed",
        fixedKey: ABILITY_FIXED_FUNCTION_KEYS.lastDrop,
        fixedSettings: {}
      }]
    },
    getFlag(scope, key) {
      return this.flags?.[scope]?.[key];
    },
    async setFlag(scope, key, value) {
      this.flags[scope] ??= {};
      this.flags[scope][key] = structuredClone(value);
      return this;
    }
  };
  actor.items.push(abilityItem);
  return actor;
}

function limb(value, { critical = false, missing = false } = {}) {
  return { value, min: -100, max: 100, critical, missing };
}
