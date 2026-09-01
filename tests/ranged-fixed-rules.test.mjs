import assert from "node:assert/strict";
import test from "node:test";

const {
  buildBullseyeStatePresentation,
  getBullseyeApplicableStacks,
  getBullseyePenetrationFormula,
  normalizeBullseyeSettings,
  resolveBullseyeAttackCycle
} = await import("../src/abilities/bullseye.mjs");
const {
  applyKeepAwayKnockdown,
  getActorLostHealthPercent,
  getKeepAwayKnockdownDifficulty,
  normalizeKeepAwayKnockdownSettings
} = await import("../src/abilities/keep-away-knockdown.mjs");
const {
  buildRicochetMasteryModifier,
  consumeRicochetMasteryAttack,
  getRicochetMasteryBonuses,
  getRicochetMasteryMaximumHalfAngleRadians
} = await import("../src/abilities/ricochet-mastery.mjs");
const {
  clearCorpseAfterCorpseOverload,
  findCorpseAfterCorpseOverloadEffectIds,
  normalizeCorpseAfterCorpseSettings,
  resolveCorpseAfterCorpseKill
} = await import("../src/abilities/corpse-after-corpse.mjs");
const {
  applyHawkEyeMitigationIgnore,
  applyHawkEyePiercingMitigation,
  buildHawkEyePiercingModifier
} = await import("../src/abilities/hawk-eye-piercing.mjs");
const { SYSTEM_ID } = await import("../src/constants.mjs");

test("Bullseye defaults match the final evolution contract", () => {
  assert.deepEqual(normalizeBullseyeSettings(), {
    energyCost: 10,
    innateDifficultyIgnorePercent: 100,
    penetrationBonusFormula: "10+rangedCombat/20",
    maxStacks: 3
  });
  assert.equal(getBullseyePenetrationFormula(2), "(10+rangedCombat/20)*2");
});

test("Bullseye advances once for a multi-check attack cycle and deduplicates its attack id", () => {
  const first = resolveBullseyeAttackCycle({
    attackId: "attack-1",
    actionKey: "aimedShot",
    targetActorUuid: "Actor.target",
    limbKey: "head",
    attackCheckCount: 5,
    successfulAttack: true
  });
  assert.equal(first.nextState.stacks, 1);
  assert.equal(getBullseyeApplicableStacks({
    state: first.nextState,
    actionKey: "aimedShot",
    targetActorUuid: "Actor.target",
    limbKey: "head"
  }), 1);

  const duplicate = resolveBullseyeAttackCycle({
    state: first.nextState,
    attackId: "attack-1",
    actionKey: "aimedShot",
    targetActorUuid: "Actor.target",
    limbKey: "head",
    attackCheckCount: 5,
    successfulAttack: true
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.nextState.stacks, 1);

  const second = resolveBullseyeAttackCycle({
    state: first.nextState,
    attackId: "attack-2",
    actionKey: "aimedShot",
    targetActorUuid: "Actor.target",
    limbKey: "head",
    attackCheckCount: 3,
    successfulAttack: true
  });
  assert.equal(second.nextState.stacks, 2);
});

test("Bullseye shooter indicator explains the current lane and exact next penetration", () => {
  assert.deepEqual(buildBullseyeStatePresentation({ settings: { maxStacks: 3 } }), {
    name: "В яблочко: серия 0/3",
    description: "Серия не начата. Попадание Прицельным выстрелом начнёт накапливать пробивание; промах сбросит серию."
  });
  assert.deepEqual(buildBullseyeStatePresentation({
    abilityName: "В яблочко",
    targetName: "Супермутант",
    limbName: "Голова",
    penetrationBonus: 400,
    state: { targetActorUuid: "Actor.target", limbKey: "head", stacks: 2 },
    settings: { maxStacks: 3 }
  }), {
    name: "В яблочко: серия 2/3 · пробивание +400",
    description: "Цель: Супермутант. Часть тела: Голова. Следующий Прицельный выстрел в эту же часть тела получает пробивание +400; промах сбросит серию."
  });
});

test("Bullseye caps at three and a miss or lane change starts a new consecutive chain", () => {
  let state = {};
  for (let index = 1; index <= 5; index += 1) {
    state = resolveBullseyeAttackCycle({
      state,
      attackId: `hit-${index}`,
      actionKey: "aimedShot",
      targetActorUuid: "Actor.target",
      limbKey: "head",
      attackCheckCount: 2,
      successfulAttack: true
    }).nextState;
  }
  assert.equal(state.stacks, 3);

  state = resolveBullseyeAttackCycle({
    state,
    attackId: "miss",
    actionKey: "aimedShot",
    targetActorUuid: "Actor.target",
    limbKey: "head",
    attackCheckCount: 2,
    successfulAttack: false
  }).nextState;
  assert.equal(state.stacks, 0);

  state = resolveBullseyeAttackCycle({
    state,
    attackId: "other-limb",
    actionKey: "aimedShot",
    targetActorUuid: "Actor.target",
    limbKey: "torso",
    attackCheckCount: 1,
    successfulAttack: true
  }).nextState;
  assert.deepEqual([state.limbKey, state.stacks], ["torso", 1]);
});

test("Keep Away II uses total missing Health and knocks prone only after failed resistance", async () => {
  assert.deepEqual(normalizeKeepAwayKnockdownSettings(), {
    activationEnergyCost: 10,
    overloadEnergyCost: 10,
    overloadDurationSeconds: 6,
    baseDifficulty: 50,
    lostHealthPercentMultiplier: 10
  });
  const actor = { system: { resources: { health: { value: 75, max: 100 } } } };
  assert.equal(getActorLostHealthPercent(actor), 25);
  assert.equal(getKeepAwayKnockdownDifficulty(getActorLostHealthPercent(actor)), 300);

  const calls = [];
  assert.equal(await applyKeepAwayKnockdown({
    targetActor: actor,
    knockbackResult: { failedChecks: 1, moved: false },
    setPosture: async (...args) => calls.push(args)
  }), true);
  assert.deepEqual(calls, [[actor, "knocked"]]);
  assert.equal(await applyKeepAwayKnockdown({
    targetActor: actor,
    knockbackResult: { failedChecks: 0 },
    setPosture: async (...args) => calls.push(args)
  }), false);
  assert.equal(calls.length, 1);
});

test("Ricochet II exposes the final trajectory profile and reflection-scaled bonuses", () => {
  assert.deepEqual(buildRicochetMasteryModifier(), {
    activationEnergyCost: 10,
    overloadEnergyCost: 20,
    overloadDurationSeconds: 12,
    maxReflections: 4,
    maximumConeDegrees: 3,
    accuracyBonusPerReflection: 20,
    damagePercentBonusPerReflection: 10,
    penetrationBonusPerReflection: 10
  });
  assert.deepEqual(getRicochetMasteryBonuses(3), {
    reflections: 3,
    accuracy: 60,
    damagePercent: 30,
    penetration: 30
  });
  assert.equal(getRicochetMasteryBonuses(99).reflections, 4);
  assert.equal(getRicochetMasteryMaximumHalfAngleRadians(), 1.5 * Math.PI / 180);
});

test("Ricochet II consumes only a committed Snapshot and deduplicates the cycle", () => {
  assert.equal(consumeRicochetMasteryAttack({ pending: true }, {
    attackId: "aimed",
    actionKey: "aimedShot",
    committed: true
  }).consumed, false);
  const consumed = consumeRicochetMasteryAttack({ pending: true }, {
    attackId: "snapshot-1",
    actionKey: "snapshot",
    committed: true
  });
  assert.equal(consumed.consumed, true);
  assert.deepEqual(consumed.nextState, { pending: false, consumedAttackId: "snapshot-1" });
  const duplicate = consumeRicochetMasteryAttack(consumed.nextState, {
    attackId: "snapshot-1",
    actionKey: "snapshot",
    committed: true
  });
  assert.equal(duplicate.duplicate, true);
});

test("Corpse after Corpse defaults and kill transition are attack-cycle idempotent", () => {
  assert.deepEqual(normalizeCorpseAfterCorpseSettings(), {
    activationEnergyCost: 30,
    overloadEnergyCost: 100,
    overloadDurationSeconds: 3600,
    damagePercentBonus: 200,
    attackWaitDurationSeconds: 12
  });
  const first = resolveCorpseAfterCorpseKill({}, {
    attackId: "kill-1",
    killedTargetUuids: ["Actor.dead", "Actor.dead"]
  });
  assert.equal(first.shouldClear, true);
  assert.deepEqual(first.killedTargetUuids, ["Actor.dead"]);
  const duplicate = resolveCorpseAfterCorpseKill(first.nextState, {
    attackId: "kill-1",
    killedTargetUuids: ["Actor.dead"]
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.shouldClear, false);
});

test("Corpse after Corpse removes only overload owned by its exact function", async () => {
  const identity = {
    abilityItemId: "ability",
    abilitySourceId: "Compendium.ability",
    functionId: "corpse-function",
    fixedKey: "corpseAfterCorpse"
  };
  const effects = [
    overloadEffect("own", identity),
    overloadEffect("same-item-other-function", { ...identity, functionId: "other" }),
    overloadEffect("same-function-other-source", { ...identity, abilitySourceId: "Compendium.other" }),
    overloadEffect("same-source-other-key", { ...identity, fixedKey: "lethalShot" }),
    { id: "ordinary", flags: {} }
  ];
  const actor = {
    effects,
    async deleteEmbeddedDocuments(documentName, ids) {
      assert.equal(documentName, "ActiveEffect");
      this.deletedIds = ids;
    }
  };
  assert.deepEqual(findCorpseAfterCorpseOverloadEffectIds(actor, identity), ["own"]);
  assert.deepEqual(await clearCorpseAfterCorpseOverload(actor, identity), ["own"]);
  assert.deepEqual(actor.deletedIds, ["own"]);
});

test("Hawk Eye II applies only to aimed shots and independently ignores 25 percent of both layers", () => {
  assert.equal(buildHawkEyePiercingModifier("snapshot"), null);
  assert.deepEqual(buildHawkEyePiercingModifier("aimedShot"), {
    ignoreAimedObstructions: true,
    defenseIgnorePercent: 25,
    resistanceIgnorePercent: 25
  });
  assert.equal(applyHawkEyeMitigationIgnore(80, 25), 60);
  assert.equal(applyHawkEyeMitigationIgnore(-20, 25), -20);
  assert.deepEqual(applyHawkEyePiercingMitigation({ defense: 80, resistance: 40 }), {
    defense: 60,
    resistance: 30
  });
});

function overloadEffect(id, data) {
  return {
    id,
    disabled: false,
    flags: {
      [SYSTEM_ID]: {
        abilityOverload: { ...data }
      }
    }
  };
}
