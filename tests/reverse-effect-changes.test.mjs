import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const RU_MESSAGES = JSON.parse(readFileSync(new URL("../lang/ru.json", import.meta.url), "utf8"));

function getRuMessage(key) {
  return String(key ?? "").split(".").reduce((value, part) => value?.[part], RU_MESSAGES);
}

globalThis.foundry = {
  applications: {
    api: { DialogV2: class {} },
    ux: { FormDataExtended: class {} },
    handlebars: { renderTemplate: () => "" }
  },
  documents: {
    ActiveEffect: {
      implementation: {
        CHANGE_TYPES: {
          add: { defaultPriority: 20 },
          multiply: { defaultPriority: 10 },
          subtract: { defaultPriority: 20 },
          override: { defaultPriority: 30 },
          upgrade: { defaultPriority: 40 },
          downgrade: { defaultPriority: 40 }
        }
      }
    }
  },
  utils: {
    deepClone: value => structuredClone(value),
    getProperty: (object, path) => String(path ?? "").split(".").reduce((value, key) => value?.[key], object),
    mergeObject: (original, other) => ({ ...structuredClone(original), ...structuredClone(other) }),
    randomID: () => "generated"
  }
};
globalThis.game = {
  i18n: {
    localize(key) {
      return String(getRuMessage(key) ?? key);
    },
    format(key, data = {}) {
      return String(getRuMessage(key) ?? key).replace(/\{([^}]+)\}/g, (_match, name) => String(data[name] ?? ""));
    }
  },
  settings: {
    get() {
      throw new Error("settings are unavailable in this unit test");
    }
  }
};

const {
  collectActorReverseEffectChanges,
  getActorReverseEffectChangeValue,
  getOriginalEffectKeyFromReverse,
  getReverseEffectKey,
  isReverseEffectKey,
  prepareActorEffectChangeForApplication
} = await import("../src/utils/active-effect-changes.mjs");
const {
  applyPreparedSourceContextualAbilityChanges,
  getContextualAbilityChangeValue,
  getPreparedSourceContextualAbilityChanges,
  getSourceContextualAbilityChangeValue,
  getTargetReverseAbilityChangeValue,
  mergePreparedSourceContextualAbilityChanges
} = await import("../src/abilities/evaluation.mjs");
const {
  buildEffectKeyTokens,
  buildReverseInteractionEffectKeyTokens
} = await import("../src/utils/effect-key-tokens.mjs");

function createEffect(uuid, changes, { disabled = false, active = true } = {}) {
  return {
    uuid,
    disabled,
    active,
    parent: null,
    system: { changes }
  };
}

function createActor(effects = []) {
  return {
    uuid: "Actor.target",
    effects,
    items: [],
    allApplicableEffects() {
      return this.effects;
    }
  };
}

function createItemCollection(items = []) {
  return {
    contents: items,
    filter: callback => items.filter(callback),
    values: () => items.values(),
    [Symbol.iterator]: () => items.values()
  };
}

test("reverse autocomplete labels preserve the ordinary label and append only the direction suffix", () => {
  const reversePrefix = "fallout-maw.reverse.";
  const allPenetrationPath = `${reversePrefix}system.penetration.actions.all`;
  const ordinaryByPath = new Map(buildEffectKeyTokens()
    .filter(token => !token.path.startsWith(reversePrefix))
    .map(token => [token.path, token]));
  const reverseTokens = buildReverseInteractionEffectKeyTokens();

  assert.ok(reverseTokens.length > 0);
  for (const token of reverseTokens) {
    const ordinaryPath = token.path.slice(reversePrefix.length);
    const baseLabel = token.path === allPenetrationPath
      ? game.i18n.localize("FALLOUTMAW.Effects.CombatAllPenetration")
      : ordinaryByPath.get(ordinaryPath)?.label;
    assert.ok(baseLabel, `Missing ordinary autocomplete label for ${ordinaryPath}`);
    assert.equal(
      token.label,
      game.i18n.format("FALLOUTMAW.Effects.ReverseLabel", { label: baseLabel }),
      token.path
    );
  }

  const labelsByPath = new Map(reverseTokens.map(token => [token.path, token.label]));
  assert.equal(
    labelsByPath.get(`${reversePrefix}system.combat.all.disadvantage`),
    "Помеха: все атакующие действия (в мою сторону)"
  );
  assert.equal(
    labelsByPath.get(`${reversePrefix}system.combat.actions.aimedShot.disadvantage`),
    "Помеха: Прицельный выстрел (в мою сторону)"
  );
  assert.equal(reverseTokens.some(token => token.label.includes(": стоимость")), false);
});

test("reverse keys round-trip without becoming ordinary actor overrides", () => {
  const original = "system.combat.actions.aimedShot.disadvantage";
  const reverse = getReverseEffectKey(original);

  assert.equal(reverse, `fallout-maw.reverse.${original}`);
  assert.equal(getOriginalEffectKeyFromReverse(reverse), original);
  assert.equal(isReverseEffectKey(reverse), true);
  assert.equal(isReverseEffectKey(original), false);
  assert.equal(prepareActorEffectChangeForApplication(null, {
    key: reverse,
    type: "add",
    value: "1"
  }), null);
});

test("target reverse effects combine general and specific keys in Foundry priority order", () => {
  const allKey = "system.combat.all.disadvantage";
  const actionKey = "system.combat.actions.aimedShot.disadvantage";
  const actor = createActor([
    createEffect("ActiveEffect.combined", [
      {
        key: getReverseEffectKey(allKey),
        type: "add",
        value: "5",
        priority: null
      },
      {
        key: getReverseEffectKey(actionKey),
        type: "multiply",
        value: "2",
        priority: null
      }
    ]),
    createEffect("ActiveEffect.disabled", [{
      key: getReverseEffectKey(actionKey),
      type: "add",
      value: "100"
    }], { disabled: true }),
    createEffect("ActiveEffect.inactive", [{
      key: getReverseEffectKey(actionKey),
      type: "add",
      value: "100"
    }], { active: false })
  ]);

  assert.equal(getActorReverseEffectChangeValue(actor, new Set([actionKey, allKey]), {
    baseValue: 10
  }), 25);

  const collected = collectActorReverseEffectChanges(actor, [actionKey, allKey]);
  assert.deepEqual(collected.map(change => ({
    key: change.key,
    value: change.value,
    effectUuid: change.effectUuid
  })), [
    { key: actionKey, value: 2, effectUuid: "ActiveEffect.combined" },
    { key: allKey, value: 5, effectUuid: "ActiveEffect.combined" }
  ]);
});

test("reverse changes on a system-suppressed trauma are ignored", () => {
  const key = "system.skills.stealth.disadvantage";
  const trauma = { id: "trauma-1", type: "trauma" };
  const traumaEffect = createEffect("ActiveEffect.trauma", [{
    key: getReverseEffectKey(key),
    type: "add",
    value: "1"
  }]);
  traumaEffect.parent = trauma;
  const actor = createActor([
    createEffect("ActiveEffect.suppression", [{
      key: "fallout-maw.suppression.traumas.all",
      type: "add",
      value: "1"
    }]),
    traumaEffect
  ]);
  actor.items = [trauma];

  assert.equal(getActorReverseEffectChangeValue(actor, key, { baseValue: 0 }), 0);
});

test("contextual reverse ability changes use the same modes without mutating either actor", () => {
  const key = "system.skills.stealth.bonus";
  const target = createActor();
  const source = { system: { skills: { stealth: { bonus: 12 } } } };
  const sourceSnapshot = structuredClone(source);
  const targetSnapshot = JSON.stringify({ uuid: target.uuid, effects: target.effects, items: target.items });

  const result = getActorReverseEffectChangeValue(target, key, {
    baseValue: 12,
    additionalChanges: [
      { key: getReverseEffectKey(key), type: "add", value: "3", priority: 10 },
      { key: getReverseEffectKey(key), type: "upgrade", value: "20", priority: 20 },
      { key: getReverseEffectKey(key), type: "subtract", value: "2", priority: 30 },
      { key: getReverseEffectKey("system.skills.all.bonus"), type: "add", value: "99", priority: 30 }
    ]
  });

  assert.equal(result, 18);
  assert.deepEqual(source, sourceSnapshot);
  assert.equal(JSON.stringify({ uuid: target.uuid, effects: target.effects, items: target.items }), targetSnapshot);
});

test("managed ability changes are not counted again as contextual reverse changes", () => {
  const key = "system.combat.damageFlat";
  const reverseKey = getReverseEffectKey(key);
  const target = createActor([
    createEffect("ActiveEffect.managedAbility", [{
      key: reverseKey,
      type: "add",
      value: "3",
      priority: 10
    }])
  ]);
  target.system = { creature: {}, limbs: {} };
  target.items = createItemCollection([{
    id: "ability",
    type: "ability",
    system: {
      functions: [
        {
          id: "unconditional",
          type: "effectChanges",
          changes: [{ key: reverseKey, type: "add", value: "3", priority: 10 }],
          conditions: []
        },
        {
          id: "weapon-context",
          type: "effectChanges",
          changes: [{ key: reverseKey, type: "add", value: "4", priority: 20 }],
          conditions: [{
            id: "aimed-shot",
            groupId: "",
            type: "weaponAction",
            weaponActionKeys: ["aimedShot"]
          }]
        }
      ]
    }
  }]);
  const source = {
    uuid: "Actor.source",
    system: { creature: {}, limbs: {} },
    items: createItemCollection(),
    effects: [],
    allApplicableEffects() {
      return this.effects;
    }
  };

  assert.equal(getContextualAbilityChangeValue(source, key, {
    baseValue: 10,
    targetActor: target,
    weaponActionKey: "aimedShot"
  }), 17);
});

test("source contextual and target reverse folds can be snapshotted independently", () => {
  const key = "system.combat.damagePercent";
  const target = createActor([createEffect("ActiveEffect.reverse", [{
    key: getReverseEffectKey(key),
    type: "multiply",
    value: "2"
  }])]);
  target.system = { creature: {}, limbs: {} };
  target.items = createItemCollection();
  const source = createActor();
  source.uuid = "Actor.source";
  source.system = { creature: {}, limbs: {} };
  source.items = createItemCollection([{
    id: "ability",
    type: "ability",
    system: {
      functions: [{
        id: "targeted",
        type: "effectChanges",
        changes: [{ key, type: "add", value: "5" }],
        conditions: [{
          id: "aimed-shot",
          groupId: "",
          type: "weaponAction",
          weaponActionKeys: ["aimedShot"]
        }]
      }]
    }
  }]);
  const context = { targetActor: target, weaponActionKey: "aimedShot" };

  assert.equal(getSourceContextualAbilityChangeValue(source, key, { ...context, baseValue: 10 }), 15);
  assert.equal(getSourceContextualAbilityChangeValue(source, key, {
    ...context,
    baseValue: 10,
    targetContextOnly: true
  }), 10);
  assert.equal(getTargetReverseAbilityChangeValue(source, key, { ...context, baseValue: 15 }), 30);
  assert.equal(getContextualAbilityChangeValue(source, key, { ...context, baseValue: 10 }), 30);
});

test("delayed source snapshots preserve priority across targetless and target-dependent changes", () => {
  const key = "system.combat.damageFlat";
  const target = createActor();
  target.system = { creature: { typeId: "mutant" }, limbs: {} };
  target.items = createItemCollection();
  const source = createActor();
  source.uuid = "Actor.source";
  source.system = { creature: {}, limbs: {} };
  source.items = createItemCollection([{
    id: "ability",
    type: "ability",
    system: {
      functions: [
        {
          id: "target-first",
          type: "effectChanges",
          changes: [{ key, type: "add", value: "5", priority: 10 }],
          conditions: [{
            id: "mutant-target",
            groupId: "",
            type: "targetType",
            targetTypeId: "mutant"
          }]
        },
        {
          id: "weapon-last",
          type: "effectChanges",
          changes: [{ key, type: "override", value: "10", priority: 20 }],
          conditions: [{
            id: "volley-action",
            groupId: "",
            type: "weaponAction",
            weaponActionKeys: ["volley"]
          }]
        }
      ]
    }
  }]);
  const targetlessChanges = getPreparedSourceContextualAbilityChanges(source, key, {
    weaponActionKey: "volley"
  });
  const targetChanges = getPreparedSourceContextualAbilityChanges(source, key, {
    targetActor: target,
    targetContextOnly: true,
    weaponActionKey: "volley"
  });

  assert.equal(applyPreparedSourceContextualAbilityChanges(0, [
    ...targetlessChanges,
    ...targetChanges
  ]), 10);
  assert.equal(getSourceContextualAbilityChangeValue(source, key, {
    baseValue: 0,
    targetActor: target,
    weaponActionKey: "volley"
  }), 10);
});

test("delayed source snapshots replace mixed target-context branches instead of counting them twice", () => {
  const key = "system.combat.damageFlat";
  const target = createActor();
  target.system = { creature: { typeId: "mutant" }, limbs: {} };
  target.items = createItemCollection();
  const source = createActor();
  source.uuid = "Actor.source";
  source.system = { creature: {}, limbs: {} };
  source.items = createItemCollection([{
    id: "ability",
    type: "ability",
    system: {
      functions: [{
        id: "mixed-or",
        type: "effectChanges",
        changes: [{ key, type: "add", value: "5", priority: 10 }],
        penalties: [{ key, type: "add", value: "-3", priority: 10 }],
        conditions: [
          {
            id: "volley-action",
            groupId: "either",
            type: "weaponAction",
            weaponActionKeys: ["volley"]
          },
          {
            id: "mutant-target",
            groupId: "either",
            type: "targetType",
            targetTypeId: "mutant"
          }
        ]
      }]
    }
  }]);
  const getChanges = (weaponActionKey, options = {}) => getPreparedSourceContextualAbilityChanges(source, key, {
    weaponActionKey,
    ...options
  });
  const targetChanges = getChanges("volley", { targetActor: target, targetContextOnly: true });
  const alreadyAppliedSnapshot = getChanges("volley");
  const penaltySnapshot = getChanges("snapshot");

  assert.equal(alreadyAppliedSnapshot[0]?.targetContext, true);
  assert.equal(penaltySnapshot[0]?.value, -3);
  assert.equal(applyPreparedSourceContextualAbilityChanges(0,
    mergePreparedSourceContextualAbilityChanges(alreadyAppliedSnapshot, targetChanges)), 5);
  assert.equal(applyPreparedSourceContextualAbilityChanges(0,
    mergePreparedSourceContextualAbilityChanges(penaltySnapshot, targetChanges)), 5);
});

test("exact target token reverse changes win, stack with an all key, and never reflect on self", () => {
  const exactKey = "system.penetration.actions.aimedShot";
  const allKey = "system.penetration.actions.all";
  const worldTarget = createActor([createEffect("ActiveEffect.world", [{
    key: getReverseEffectKey(exactKey),
    type: "add",
    value: "100"
  }])]);
  worldTarget.uuid = "Actor.world-target";
  const syntheticTarget = createActor([createEffect("ActiveEffect.synthetic", [
    { key: getReverseEffectKey(allKey), type: "add", value: "2" },
    { key: getReverseEffectKey(exactKey), type: "add", value: "3" }
  ])]);
  syntheticTarget.uuid = "Scene.scene.Token.target.Actor.synthetic";
  const source = createActor();
  source.uuid = "Actor.source";
  for (const actor of [worldTarget, syntheticTarget, source]) {
    actor.system = { creature: {}, limbs: {} };
    actor.items = createItemCollection();
  }

  assert.equal(getContextualAbilityChangeValue(source, exactKey, {
    alternateKeys: [allKey],
    baseValue: 1,
    targetActor: worldTarget,
    targetToken: { actor: syntheticTarget }
  }), 6);

  assert.equal(getContextualAbilityChangeValue(source, exactKey, {
    alternateKeys: [allKey],
    baseValue: 1,
    targetActor: source,
    targetToken: { actor: source }
  }), 1);
});
