import assert from "node:assert/strict";
import test from "node:test";

let generatedId = 0;
globalThis.foundry = {
  utils: {
    randomID: () => `generated-${++generatedId}`
  }
};

const {
  ABILITY_FUNCTION_TYPES,
  createAbilityFunction,
  createAttackActionSettings,
  normalizeAbilityFunctions,
  normalizeAttackActionSettings
} = await import("../src/settings/abilities.mjs");

const {
  ATTACK_ACTION_TRIAL_FLOWS,
  ATTACK_ACTION_TRIAL_OUTCOME_KEYS,
  createAttackActionTrial,
  createAttackActionTrialEntry,
  createAttackActionTrialLink,
  createAttackActionTrialOutcome
} = await import("../src/abilities/attack-action-settings.mjs");
const {
  WEAPON_SPECIAL_PROPERTIES,
  createDefaultWeaponSpecialPropertyData
} = await import("../src/utils/item-functions.mjs");

test("attack action settings have constructor-safe defaults", () => {
  const settings = createAttackActionSettings();

  assert.equal(settings.damage, "0");
  assert.equal(settings.pellets, "1");
  assert.deepEqual(settings.damageTypes, [{ key: "firearm", percent: 100 }]);
  assert.deepEqual(settings.targeting, {
    mode: "cone",
    targetLimitFormula: "1",
    aimed: false,
    allowRepeatedTargets: true,
    attackConeDegrees: 3,
    directions: {
      thrust: {
        enabled: false,
        accuracyModifier: 0,
        criticalChanceModifier: 0,
        damagePercentModifier: 0
      },
      swing: {
        enabled: false,
        accuracyModifier: 0,
        criticalChanceModifier: 0,
        damagePercentModifier: 0
      }
    }
  });
  assert.deepEqual(settings.sequence, { count: 1, difficultyPerAttack: 0 });
  assert.equal(settings.area.damageRadius, "0");
  assert.deepEqual(settings.resourceCosts, []);
  assert.deepEqual(settings.hitResolution, { trials: [] });
});

test("attack action normalization preserves every inactive targeting branch", () => {
  const settings = normalizeAttackActionSettings({
    targeting: {
      mode: "selectedTargets",
      targetLimitFormula: "1 + @resources.power.value / 50",
      aimed: true,
      allowRepeatedTargets: false,
      attackConeDegrees: 17.5,
      directions: {
        thrust: {
          enabled: true,
          accuracyModifier: -5,
          criticalChanceModifier: 2,
          damagePercentModifier: 25
        },
        swing: {
          enabled: false,
          accuracyModifier: 4,
          criticalChanceModifier: -1,
          damagePercentModifier: -10
        }
      }
    },
    sequence: { count: 4, difficultyPerAttack: 12 },
    area: {
      damageRadius: "@skills.explosives.value / 2",
      regionRadius: "4",
      regionDamageEntries: [{ damageTypeKey: "fire", amount: "2d6" }],
      regionDurationSeconds: "18",
      regionDelaySeconds: "6",
      regionRadiusDeltaMeters: "-1",
      explosionAnimationKey: "blast",
      explosionSoundPath: "audio/blast.ogg"
    }
  });

  assert.equal(settings.targeting.mode, "selectedTargets");
  assert.equal(settings.targeting.targetLimitFormula, "1 + @resources.power.value / 50");
  assert.equal(settings.targeting.attackConeDegrees, 17.5);
  assert.equal(settings.targeting.directions.thrust.damagePercentModifier, 25);
  assert.equal(settings.targeting.directions.swing.accuracyModifier, 4);
  assert.deepEqual(settings.sequence, { count: 4, difficultyPerAttack: 12 });
  assert.equal(settings.area.damageRadius, "@skills.explosives.value / 2");
  assert.deepEqual(settings.area.regionDamageEntries, [{
    damageTypeKey: "fire",
    amount: "2d6"
  }]);
});

test("selected-target targeting keeps its persisted key and migrates the legacy alias", () => {
  assert.equal(
    normalizeAttackActionSettings({ targeting: { mode: "selectedTargets" } }).targeting.mode,
    "selectedTargets"
  );
  assert.equal(
    normalizeAttackActionSettings({ targeting: { mode: "targets" } }).targeting.mode,
    "selectedTargets"
  );
});

test("actor costs, attack power, and critical consequences keep composite resource identity", () => {
  const settings = normalizeAttackActionSettings({
    resourceCosts: [{
      id: "base-cost",
      resourceKey: "actionPoints",
      formula: "2 + @resources.actionPoints.value / 10",
      overloadAmount: 40,
      overloadDurationSeconds: 3600
    }],
    specialProperties: [{
      type: "attackPower",
      attackPower: {
        level: { value: 3, max: 5 },
        resourceCosts: [{
          type: "magazine",
          resourceKey: "energy",
          amount: 2
        }]
      }
    }],
    criticalFailureConsequences: [{
      id: "critical-cost",
      type: "ignored",
      resourceType: "magazine",
      resourceKey: "reactionPoints",
      amount: 4
    }]
  });

  assert.deepEqual(settings.resourceCosts, [{
    id: "base-cost",
    resourceKey: "actionPoints",
    formula: "2 + @resources.actionPoints.value / 10",
    overloadAmount: 40,
    overloadDurationSeconds: 3600
  }]);
  assert.deepEqual(settings.specialProperties[0].attackPower.resourceCosts, [{
    type: "actorResource",
    resourceKey: "energy",
    amount: 2
  }]);
  assert.deepEqual(settings.criticalFailureConsequences, [{
    id: "critical-cost",
    type: "extraResourceCost",
    resourceType: "actorResource",
    resourceKey: "reactionPoints",
    amount: 4
  }]);
});

test("critical damage properties preserve their stable outcome id and percent formula", () => {
  const settings = normalizeAttackActionSettings({
    specialProperties: [{
      type: WEAPON_SPECIAL_PROPERTIES.criticalDamage,
      criticalDamage: {
        outcomeId: "trial-2-success",
        percentFormula: "150 + @resources.energy.value / 2"
      }
    }]
  });

  assert.deepEqual(settings.specialProperties, [{
    type: WEAPON_SPECIAL_PROPERTIES.criticalDamage,
    criticalDamage: {
      outcomeId: "trial-2-success",
      percentFormula: "150 + @resources.energy.value / 2"
    }
  }]);
  assert.deepEqual(
    createDefaultWeaponSpecialPropertyData(WEAPON_SPECIAL_PROPERTIES.criticalDamage),
    {
      type: WEAPON_SPECIAL_PROPERTIES.criticalDamage,
      criticalDamage: {
        outcomeId: "",
        percentFormula: "150"
      }
    }
  );
});

test("additional proficiencies survive attack action normalization", () => {
  const settings = normalizeAttackActionSettings({
    specialProperties: [{
      type: WEAPON_SPECIAL_PROPERTIES.additionalProficiencies,
      proficiencyKeys: [" rifle ", "pistol", "rifle", ""]
    }]
  });

  assert.deepEqual(settings.specialProperties, [{
    type: WEAPON_SPECIAL_PROPERTIES.additionalProficiencies,
    proficiencyKeys: ["rifle", "pistol"]
  }]);
});

test("adding a critical damage property preserves the complete attack settings block", () => {
  const before = normalizeAttackActionSettings({
    name: "Плазменная перегрузка",
    damage: "50 + energy / 3",
    pellets: "2",
    criticalDamagePercent: "175",
    maxRangeMeters: "10 + energy / 10",
    effectiveRange: { value: "4", max: "9" },
    penetration: "energy / 5",
    targeting: {
      mode: "selectedTargets",
      targetLimitFormula: "1 + energy / 50",
      aimed: true,
      allowRepeatedTargets: false,
      attackConeDegrees: 7
    },
    sequence: { count: 3, difficultyPerAttack: 8 },
    area: {
      damageRadius: "6",
      regionRadius: "3",
      regionDamageEntries: [{ damageTypeKey: "fire", amount: "12" }]
    },
    resourceCosts: [{
      id: "energy-cost",
      resourceKey: "energy",
      formula: "60",
      overloadAmount: 40,
      overloadDurationSeconds: 3600
    }],
    hitResolution: {
      trials: [{
        id: "trial",
        entries: [{ id: "entry", key: "fortitude" }],
        outcomes: {
          success: { id: "success-outcome", links: [] }
        }
      }]
    },
    specialProperties: [{
      type: "attackPower",
      attackPower: {
        level: { value: 2, max: 4 },
        perLevel: { criticalDamagePercent: 25 }
      }
    }]
  });
  const added = normalizeAttackActionSettings({
    ...before,
    specialProperties: [
      ...before.specialProperties,
      {
        type: WEAPON_SPECIAL_PROPERTIES.criticalDamage,
        criticalDamage: {
          outcomeId: before.hitResolution.trials[0].outcomes.success.id,
          percentFormula: "225"
        }
      }
    ]
  });
  const { specialProperties: beforeProperties, ...beforeRest } = before;
  const { specialProperties: addedProperties, ...addedRest } = added;

  assert.deepEqual(addedRest, beforeRest);
  assert.deepEqual(addedProperties[0], beforeProperties[0]);
  assert.equal(addedProperties[1].criticalDamage.outcomeId, "success-outcome");
  assert.equal(addedProperties[1].criticalDamage.percentFormula, "225");
});

test("only top-level attack functions retain attackSettings", () => {
  const attackFunction = createAbilityFunction(ABILITY_FUNCTION_TYPES.attackAction, {
    attackSettings: {
      name: "Плазменный импульс",
      targeting: { mode: "area" }
    }
  });
  assert.equal(attackFunction.type, "attackAction");
  assert.equal(attackFunction.attackSettings.name, "Плазменный импульс");
  assert.equal(attackFunction.attackSettings.targeting.mode, "area");

  const [passive] = normalizeAbilityFunctions([{
    id: "passive",
    type: ABILITY_FUNCTION_TYPES.effectChanges,
    attackSettings: { name: "must be removed" }
  }]);
  assert.equal(Object.hasOwn(passive, "attackSettings"), false);
});

test("custom hit resolution preserves source and target trial branches", () => {
  const settings = normalizeAttackActionSettings({
    hitResolution: {
      trials: [{
        id: "endurance-trial",
        subject: "targets",
        sourceMode: "perTarget",
        entries: [{
          id: "endurance-entry",
          kind: "ignored",
          key: "endurance"
        }],
        selectionMode: "worst",
        difficultyFormula: "50 + @resources.power.value",
        outcomes: {
          failure: {
            id: "failure-outcome",
            flow: "stopSubject",
            links: [{
              id: "failure-damage",
              constructId: "full-fire-damage",
              recipient: "subjects",
              mode: "perSubject"
            }]
          },
          success: {
            id: "success-outcome",
            flow: "stopAll",
            links: [{
              id: "success-damage",
              constructId: "reduced-fire-damage",
              recipient: "targets",
              mode: "once"
            }]
          }
        }
      }]
    }
  });

  const [trial] = settings.hitResolution.trials;
  assert.deepEqual({
    id: trial.id,
    subject: trial.subject,
    sourceMode: trial.sourceMode,
    entries: trial.entries,
    selectionMode: trial.selectionMode,
    difficultyFormula: trial.difficultyFormula
  }, {
    id: "endurance-trial",
    subject: "targets",
    sourceMode: "perTarget",
    entries: [{
      id: "endurance-entry",
      kind: "skill",
      key: "endurance"
    }],
    selectionMode: "worst",
    difficultyFormula: "50 + @resources.power.value"
  });
  assert.deepEqual(trial.outcomes.failure, {
    id: "failure-outcome",
    flow: "stopSubject",
    links: [{
      id: "failure-damage",
      constructId: "full-fire-damage",
      recipient: "subjects",
      mode: "perSubject"
    }]
  });
  assert.deepEqual(trial.outcomes.success, {
    id: "success-outcome",
    flow: "stopAll",
    links: [{
      id: "success-damage",
      constructId: "reduced-fire-damage",
      recipient: "targets",
      mode: "once"
    }]
  });
  assert.equal(trial.outcomes.criticalFailure.flow, "continue");
  assert.deepEqual(trial.outcomes.criticalFailure.links, []);
  assert.match(trial.outcomes.criticalFailure.id, /^generated-\d+$/);
  assert.equal(trial.outcomes.criticalSuccess.flow, "continue");
});

test("custom hit resolution repairs invalid enums and accepts form object rows", () => {
  const settings = normalizeAttackActionSettings({
    resourceCosts: {
      first: {
        resourceKey: "power",
        formula: "60",
        overloadAmount: -5,
        overloadDurationSeconds: -10
      }
    },
    hitResolution: {
      trials: {
        first: {
          subject: "invalid",
          sourceMode: "invalid",
          entries: {
            first: { key: "fortitude" }
          },
          selectionMode: "invalid",
          outcomes: {
            criticalSuccess: {
              flow: "invalid",
              links: {
                first: {
                  constructId: "buff",
                  recipient: "source",
                  mode: "invalid"
                }
              }
            }
          }
        }
      }
    }
  });

  assert.deepEqual(settings.resourceCosts.map(cost => ({
    resourceKey: cost.resourceKey,
    formula: cost.formula,
    overloadAmount: cost.overloadAmount,
    overloadDurationSeconds: cost.overloadDurationSeconds
  })), [{
    resourceKey: "power",
    formula: "60",
    overloadAmount: 0,
    overloadDurationSeconds: 0
  }]);
  const [trial] = settings.hitResolution.trials;
  assert.equal(trial.subject, "targets");
  assert.equal(trial.sourceMode, "once");
  assert.equal(trial.selectionMode, "best");
  assert.equal(trial.difficultyFormula, "0");
  assert.equal(trial.entries[0].kind, "skill");
  assert.equal(trial.outcomes.criticalSuccess.flow, "continue");
  assert.deepEqual(trial.outcomes.criticalSuccess.links[0], {
    id: trial.outcomes.criticalSuccess.links[0].id,
    constructId: "buff",
    recipient: "source",
    mode: "once"
  });
});

test("exported trial helpers create complete UI-safe rows", () => {
  const entry = createAttackActionTrialEntry({ key: "fortitude" });
  const link = createAttackActionTrialLink({
    constructId: "damage",
    recipient: "targets"
  });
  const outcome = createAttackActionTrialOutcome({
    flow: ATTACK_ACTION_TRIAL_FLOWS.stopAll,
    links: [link]
  });
  const trial = createAttackActionTrial({
    subject: "source",
    entries: [entry],
    outcomes: { failure: outcome }
  });

  assert.deepEqual(Object.keys(trial.outcomes), ATTACK_ACTION_TRIAL_OUTCOME_KEYS);
  assert.equal(trial.entries[0].key, "fortitude");
  assert.equal(trial.outcomes.failure.flow, "stopAll");
  assert.equal(trial.outcomes.failure.links[0].constructId, "damage");
  assert.equal(trial.outcomes.failure.links[0].recipient, "targets");
  assert.equal(trial.outcomes.failure.links[0].mode, "perSubject");
});
