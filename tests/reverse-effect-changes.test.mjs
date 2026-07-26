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
  expandActorEffectChangeKeys,
  getActorReverseEffectChangeValue,
  getOriginalEffectKeyFromReverse,
  getReverseEffectKey,
  isReverseEffectKey,
  prepareActorEffectChangeForApplication
} = await import("../src/utils/active-effect-changes.mjs");
const {
  abilityConditionApplies,
  applyPreparedSourceContextualAbilityChanges,
  getConditionalFunctionChanges,
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
const {
  getSkillCheckActiveUseKeys,
  getWeaponActionActiveUseKeys,
  isActiveUseEffectKey
} = await import("../src/abilities/active-use-keys.mjs");
const {
  getSkillCheckActionEffectKeys,
  SKILL_CHECK_ACTIONS
} = await import("../src/rolls/skill-check-action-effects.mjs");

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

test("periodic healing is a standard ability autocomplete key but never applies as an actor data path", () => {
  assert.equal(buildEffectKeyTokens().some(entry => entry.path === "fallout-maw.healing"), false);
  const token = buildEffectKeyTokens({ includePeriodicHealing: true })
    .find(entry => entry.path === "fallout-maw.healing");
  assert.equal(token?.code, "heal");
  assert.equal(token?.key, "healing");
  assert.equal(prepareActorEffectChangeForApplication(null, {
    key: "fallout-maw.healing",
    type: "add",
    value: "40"
  }), null);
});

test("condition loss multiplier is registered and participates only when an attack spends condition", () => {
  const key = "system.combat.conditionLossMultiplier";
  const token = buildEffectKeyTokens().find(entry => entry.path === key);
  assert.equal(token?.label, "Множитель потери прочности");
  assert.equal(applyPreparedSourceContextualAbilityChanges(10, [
    { type: "multiply", value: 3, priority: 10, order: 0 }
  ]), 30);

  const actionContext = {
    actionKey: "aimedShot",
    activeUseStages: { action: true, check: false, damage: false }
  };
  assert.equal(getWeaponActionActiveUseKeys({
    ...actionContext,
    weaponData: { resourceCosts: [{ type: "condition", amount: 10 }] }
  }).has(key), true);
  assert.equal(getWeaponActionActiveUseKeys({
    ...actionContext,
    weaponData: { resourceCosts: [] }
  }).has(key), false);
});

test("critical damage modifier is registered as a reversible weapon-damage key", () => {
  const key = "system.combat.criticalDamagePercent";
  const token = buildEffectKeyTokens().find(entry => entry.path === key);
  const reverseToken = buildReverseInteractionEffectKeyTokens()
    .find(entry => entry.path === getReverseEffectKey(key));

  assert.equal(token?.label, "Изменение критического урона, %");
  assert.equal(reverseToken?.label, "Изменение критического урона, % (в мою сторону)");
  assert.equal(getWeaponActionActiveUseKeys({
    actionKey: "aimedShot",
    activeUseStages: { damage: true }
  }).has(key), false);
  assert.equal(getWeaponActionActiveUseKeys({
    actionKey: "aimedShot",
    criticalSuccess: true,
    activeUseStages: { damage: true }
  }).has(key), true);
  assert.equal(isActiveUseEffectKey(key), true);
  assert.equal(applyPreparedSourceContextualAbilityChanges(150, [
    { type: "add", value: 25, priority: 20, order: 0 }
  ]), 175);
});

test("all-skills bonus changes expand to the concrete prepared bonus paths", () => {
  const actor = {
    system: {
      skills: {
        gambling: {},
        medicine: {}
      }
    }
  };
  const changes = expandActorEffectChangeKeys(actor, {
    key: "system.skills.all.bonus",
    type: "add",
    value: "5"
  });
  const keys = new Set(changes.map(change => change.key));

  assert.equal(keys.has("system.skills.gambling.bonus"), true);
  assert.equal(keys.has("system.skills.medicine.bonus"), true);
  assert.equal(keys.has("system.skills.all.bonus"), false);
  assert.equal(changes.every(change => change.type === "add" && change.value === "5"), true);

  for (const field of ["criticalSuccessChance", "criticalFailureChance"]) {
    const criticalChanges = expandActorEffectChangeKeys(actor, {
      key: `system.skills.all.${field}`,
      type: "add",
      value: "7"
    });
    const criticalKeys = new Set(criticalChanges.map(change => change.key));
    assert.equal(criticalKeys.has(`system.skills.gambling.${field}`), true);
    assert.equal(criticalKeys.has(`system.skills.medicine.${field}`), true);
    assert.equal(criticalKeys.has(`system.skills.all.${field}`), false);
  }
});

function createItemCollection(items = []) {
  return {
    contents: items,
    filter: callback => items.filter(callback),
    values: () => items.values(),
    [Symbol.iterator]: () => items.values()
  };
}

test("trigger chance keeps one decision for the whole active-use operation", () => {
  const key = "system.skills.stealth.bonus";
  const condition = {
    id: "chance",
    groupId: "",
    type: "triggerChance",
    chanceFormula: "100"
  };
  const source = createActor();
  source.uuid = "Actor.source";
  source.system = { creature: {}, limbs: {}, skills: { stealth: { bonus: 0 } } };
  source.items = createItemCollection([{
    id: "ability",
    uuid: "Actor.source.Item.ability",
    type: "ability",
    system: {
      functions: [{
        id: "chance-function",
        type: "effectChanges",
        changes: [{ key, type: "add", value: "5" }],
        penalties: [],
        conditions: [condition]
      }]
    }
  }]);

  assert.equal(getContextualAbilityChangeValue(source, key, {
    baseValue: 10,
    chanceOperationId: "operation-one"
  }), 15);

  condition.chanceFormula = "0";
  assert.equal(getContextualAbilityChangeValue(source, key, {
    baseValue: 10,
    chanceOperationId: "operation-one"
  }), 15);
  assert.equal(getContextualAbilityChangeValue(source, key, {
    baseValue: 10,
    chanceOperationId: "operation-two"
  }), 10);
});

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

test("action-specific skill-check keys are registered, reversible, and active only for their requester", () => {
  const ordinaryTokens = buildEffectKeyTokens()
    .filter(token => token.path.startsWith("system.skillCheck.actions."));
  const reverseTokens = buildReverseInteractionEffectKeyTokens()
    .filter(token => token.path.startsWith("fallout-maw.reverse.system.skillCheck.actions."));

  assert.equal(ordinaryTokens.length, SKILL_CHECK_ACTIONS.length * 3);
  assert.equal(reverseTokens.length, SKILL_CHECK_ACTIONS.length * 3);

  const researchKeys = new Set(getSkillCheckActionEffectKeys("research"));
  const activeKeys = getSkillCheckActiveUseKeys("speech", { requester: "research" });
  assert.equal(researchKeys.size, 3);
  assert.equal(Array.from(researchKeys).every(key => activeKeys.has(key)), true);
  assert.equal(getSkillCheckActionEffectKeys("repair").some(key => activeKeys.has(key)), false);
  assert.equal(Array.from(researchKeys).every(key => isActiveUseEffectKey(key)), true);
  assert.equal(Array.from(researchKeys).every(key => isActiveUseEffectKey(getReverseEffectKey(key))), true);
});

test("engaged-skill condition is contextual and matches the skill actually used by the check", () => {
  const condition = {
    id: "engaged-skill",
    groupId: "",
    type: "engagedSkill",
    skillKeys: ["speech", "naturalist"]
  };
  assert.equal(abilityConditionApplies({}, condition, { skillKey: "speech" }), true);
  assert.equal(abilityConditionApplies({}, condition, { skill: { key: "naturalist" } }), true);
  assert.equal(abilityConditionApplies({}, condition, { skillKey: "repair" }), false);
  assert.equal(abilityConditionApplies({}, condition, {}), false);

  const changes = [{ key: "system.skills.all.bonus", type: "add", value: "20" }];
  const penalties = [{ key: "system.skills.all.bonus", type: "add", value: "-20" }];
  const abilityFunction = { id: "contextual", conditions: [condition], changes, penalties };
  assert.deepEqual(getConditionalFunctionChanges({}, abilityFunction, {}), []);
  assert.deepEqual(getConditionalFunctionChanges({}, abilityFunction, {
    allowContextual: true,
    skillKey: "speech"
  }), changes);
  assert.deepEqual(getConditionalFunctionChanges({}, abilityFunction, {
    allowContextual: true,
    skillKey: "repair"
  }), penalties);
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
