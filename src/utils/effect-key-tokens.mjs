import { createEffectKeyToken } from "../apps/effect-key-autocomplete.mjs";
import { ATTACKING_WEAPON_ACTION_KEYS } from "../abilities/runtime-state.mjs";
import {
  DODGE_LOSS_MODIFIER_EFFECT_KEY,
  DODGE_ROUND_RECOVERY_MODIFIER_EFFECT_KEY
} from "../combat/dodge-effect-keys.mjs";
import { WEAPON_SWITCH_COST_KEY } from "../combat/weapon-switching.mjs";
import {
  ALL_SKILLS_ADVANTAGE_EFFECT_KEY,
  ALL_SKILLS_BONUS_EFFECT_KEY,
  ALL_SKILLS_DISADVANTAGE_EFFECT_KEY,
  ALL_COMBAT_ADVANTAGE_EFFECT_KEY,
  ALL_COMBAT_DISADVANTAGE_EFFECT_KEY,
  ALL_LIMB_MAX_BONUS_EFFECT_KEY,
  ALL_LIMB_IMPLANT_LIMIT_EFFECT_KEY,
  ABILITY_OVERLOAD_ENERGY_COST_EFFECT_KEY,
  getAbilityOverloadCostEffectKey,
  DISEASE_SUPPRESSION_ALL_EFFECT_KEY,
  DISEASE_SUPPRESSION_COUNT_EFFECT_KEY,
  INITIATIVE_ADVANTAGE_EFFECT_KEY,
  INITIATIVE_DISADVANTAGE_EFFECT_KEY,
  getReverseEffectKey,
  ONE_TIME_SKILL_MODIFIER_EFFECT_KEY,
  SMART_FUDGE_RESULT_EFFECT_KEYS,
  TRAUMA_SUPPRESSION_ALL_EFFECT_KEY,
  TRAUMA_SUPPRESSION_COUNT_EFFECT_KEY
} from "./active-effect-changes.mjs";
import { ORGANISM_DEVELOPMENT_LIMIT_EFFECT_KEY } from "../races/organism-development.mjs";
import {
  getCharacteristicSettings,
  getCoverSettings,
  getCreatureOptions,
  getDamageTypeSettings,
  getNeedSettings,
  getProficiencySettings,
  getResourceSettings,
  getSkillSettings
} from "../settings/accessors.mjs";
import { getCoverBonusPercentEffectKey } from "../settings/cover.mjs";

export function buildEffectKeyTokens({ includeFirstAidHealing = false } = {}) {
  const tokens = [
    ...getCharacteristicSettings().map(entry => createEffectKeyToken({
      code: entry.abbr || entry.key,
      key: entry.key,
      label: entry.label,
      path: `system.characteristics.${entry.key}`,
      group: game.i18n.localize("FALLOUTMAW.Common.Characteristics")
    })),
    ...getSkillSettings().map(entry => createEffectKeyToken({
      code: entry.abbr || entry.key,
      key: entry.key,
      label: entry.label,
      path: `system.skills.${entry.key}.bonus`,
      group: game.i18n.localize("FALLOUTMAW.Common.Skills")
    })),
    ...buildSkillAdvantageEffectKeyTokens(),
    ...buildSkillDisadvantageEffectKeyTokens(),
    buildAllSkillsEffectKeyToken(),
    buildAllSkillsAdvantageEffectKeyToken(),
    buildAllSkillsDisadvantageEffectKeyToken(),
    ...buildResourceBonusEffectKeyTokens(),
    buildInitiativeBonusEffectKeyToken(),
    buildInitiativeAdvantageEffectKeyToken(),
    buildInitiativeDisadvantageEffectKeyToken(),
    createEffectKeyToken({
      code: "rea",
      key: "reactionPoints",
      label: "Очки реакции",
      path: "system.resources.reactionPoints.bonus",
      group: game.i18n.localize("FALLOUTMAW.Common.Resources")
    }),
    ...getNeedSettings().map(entry => createEffectKeyToken({
      code: entry.abbr || entry.key,
      key: entry.key,
      label: entry.label,
      path: `system.needs.${entry.key}.bonus`,
      group: game.i18n.localize("FALLOUTMAW.Common.Needs")
    })),
    ...getProficiencySettings().map(entry => createEffectKeyToken({
      code: entry.abbr || entry.key,
      key: entry.key,
      label: entry.label,
      path: `system.proficiencies.${entry.key}.bonus`,
      group: game.i18n.localize("FALLOUTMAW.Common.Proficiencies")
    })),
    createEffectKeyToken({
      code: "load",
      key: "load",
      label: game.i18n.localize("FALLOUTMAW.Common.Load"),
      path: "system.load.bonus",
      group: game.i18n.localize("FALLOUTMAW.Common.Load")
    }),
    createEffectKeyToken({
      code: "inventoryWidth",
      key: "inventoryWidth",
      label: "Инвентарь: ширина",
      path: "system.inventory.columnsBonus",
      group: game.i18n.localize("FALLOUTMAW.Common.Inventory")
    }),
    createEffectKeyToken({
      code: "inventoryHeight",
      key: "inventoryHeight",
      label: "Инвентарь: высота",
      path: "system.inventory.rowsBonus",
      group: game.i18n.localize("FALLOUTMAW.Common.Inventory")
    }),
    ...buildDamageMitigationEffectKeyTokens(),
    ...buildLimbMaxBonusEffectKeyTokens(),
    ...buildImplantLimitEffectKeyTokens(),
    createEffectKeyToken({
      code: "organismDevelopmentLimit",
      key: "organismDevelopmentLimit",
      label: game.i18n.localize("FALLOUTMAW.Settings.CreatureOptions.OrganismDevelopmentLimit"),
      path: ORGANISM_DEVELOPMENT_LIMIT_EFFECT_KEY,
      group: game.i18n.localize("FALLOUTMAW.OrganismDevelopment.Title")
    }),
    createEffectKeyToken({
      code: "blind",
      key: "blind",
      label: "Слепота",
      path: "status.blind",
      group: "Статусы"
    }),
    createEffectKeyToken({
      code: "moveCost",
      key: "movement",
      label: "Стоимость перемещения",
      path: "system.costs.movement",
      group: "Стоимость"
    }),
    createEffectKeyToken({
      code: "actionCost",
      key: "action",
      label: "Стоимость действий",
      path: "system.costs.action",
      group: "Стоимость"
    }),
    buildWeaponSwitchCostEffectKeyToken(),
    ...buildActionCostEffectKeyTokens(),
    ...buildPostureEffectKeyTokens(),
    ...buildActionBlockEffectKeyTokens(),
    ...buildActionPenetrationEffectKeyTokens(),
    ...buildAbilityRuntimeEffectKeyTokens(),
    ...buildCoverBonusPercentEffectKeyTokens(),
    ...buildDodgeResourceEffectKeyTokens(),
    ...buildSuppressionEffectKeyTokens(),
    ...buildCombatEffectKeyTokens(),
    ...buildReverseInteractionEffectKeyTokens()
  ];

  if (includeFirstAidHealing) {
    tokens.push(createEffectKeyToken({
      code: "heal",
      key: "healing",
      label: game.i18n.localize("FALLOUTMAW.Item.FirstAidHealingPerTick"),
      path: "fallout-maw.healing",
      group: game.i18n.localize("FALLOUTMAW.Item.FirstAidEffectChanges")
    }));
  }

  return tokens.filter(Boolean);
}

export function buildCoverBonusPercentEffectKeyTokens() {
  return getCoverSettings().entries.map(entry => createEffectKeyToken({
    code: `cover:${entry.key}`,
    key: entry.key,
    label: `Укрытие: ${entry.label || entry.key}, изменение базы, %`,
    path: getCoverBonusPercentEffectKey(entry.key),
    group: "Укрытия"
  })).filter(Boolean);
}

export function buildDodgeResourceEffectKeyTokens() {
  return [
    createEffectKeyToken({
      code: "dodgeLoss",
      key: "dodgeLoss",
      label: "Уклонение: изменение процента потери",
      path: DODGE_LOSS_MODIFIER_EFFECT_KEY,
      group: "Уклонение"
    }),
    createEffectKeyToken({
      code: "dodgeRoundRecovery",
      key: "dodgeRoundRecovery",
      label: "Уклонение: изменение процента восстановления за раунд",
      path: DODGE_ROUND_RECOVERY_MODIFIER_EFFECT_KEY,
      group: "Уклонение"
    })
  ];
}

export function buildAllSkillsEffectKeyToken() {
  return createEffectKeyToken({
    code: "allSkills",
    key: "allSkills",
    label: game.i18n.localize("FALLOUTMAW.Effects.AllSkills"),
    path: ALL_SKILLS_BONUS_EFFECT_KEY,
    group: game.i18n.localize("FALLOUTMAW.Common.Skills")
  });
}

export function buildAllSkillsAdvantageEffectKeyToken() {
  return createEffectKeyToken({
    code: "allSkillsAdvantage",
    key: "allSkillsAdvantage",
    label: game.i18n.localize("FALLOUTMAW.Effects.AllSkillsAdvantage"),
    path: ALL_SKILLS_ADVANTAGE_EFFECT_KEY,
    group: game.i18n.localize("FALLOUTMAW.Common.Skills")
  });
}

export function buildAllSkillsDisadvantageEffectKeyToken() {
  return createEffectKeyToken({
    code: "allSkillsDisadvantage",
    key: "allSkillsDisadvantage",
    label: game.i18n.localize("FALLOUTMAW.Effects.AllSkillsDisadvantage"),
    path: ALL_SKILLS_DISADVANTAGE_EFFECT_KEY,
    group: game.i18n.localize("FALLOUTMAW.Common.Skills")
  });
}

export function buildSkillAdvantageEffectKeyTokens() {
  return getSkillSettings().map(entry => createEffectKeyToken({
    code: `${entry.abbr || entry.key}:adv`,
    key: `${entry.key}.advantage`,
    label: `${game.i18n.localize("FALLOUTMAW.Effects.CombatAdvantage")}: ${entry.label || entry.key}`,
    path: `system.skills.${entry.key}.advantage`,
    group: game.i18n.localize("FALLOUTMAW.Common.Skills")
  })).filter(Boolean);
}

export function buildSkillDisadvantageEffectKeyTokens() {
  return getSkillSettings().map(entry => createEffectKeyToken({
    code: `${entry.abbr || entry.key}:dis`,
    key: `${entry.key}.disadvantage`,
    label: `${game.i18n.localize("FALLOUTMAW.Effects.CombatDisadvantage")}: ${entry.label || entry.key}`,
    path: `system.skills.${entry.key}.disadvantage`,
    group: game.i18n.localize("FALLOUTMAW.Common.Skills")
  })).filter(Boolean);
}

export function buildResourceBonusEffectKeyTokens(group = game.i18n.localize("FALLOUTMAW.Common.Resources")) {
  return getResourceSettings()
    .filter(entry => String(entry?.key ?? "").trim() !== "health")
    .map(entry => createEffectKeyToken({
      code: entry.abbr || entry.key,
      key: entry.key,
      label: entry.label,
      path: `system.resources.${entry.key}.bonus`,
      group
    }))
    .filter(Boolean);
}

export function buildInitiativeBonusEffectKeyToken() {
  const label = localizeOrFallback("FALLOUTMAW.Actor.Initiative", "Initiative");
  return createEffectKeyToken({
    code: "init",
    key: "initiative",
    label,
    path: "system.attributes.initiativeBonus",
    group: label
  });
}

export function buildInitiativeAdvantageEffectKeyToken() {
  const label = localizeOrFallback("FALLOUTMAW.Actor.Initiative", "Initiative");
  return createEffectKeyToken({
    code: "init:adv",
    key: "initiative.advantage",
    label: `${label}: преимущество`,
    path: INITIATIVE_ADVANTAGE_EFFECT_KEY,
    group: label
  });
}

export function buildInitiativeDisadvantageEffectKeyToken() {
  const label = localizeOrFallback("FALLOUTMAW.Actor.Initiative", "Initiative");
  return createEffectKeyToken({
    code: "init:dis",
    key: "initiative.disadvantage",
    label: `${label}: помеха`,
    path: INITIATIVE_DISADVANTAGE_EFFECT_KEY,
    group: label
  });
}

export function buildAllCombatAdvantageEffectKeyToken() {
  return createEffectKeyToken({
    code: "allCombatAdvantage",
    key: "allCombatAdvantage",
    label: game.i18n.localize("FALLOUTMAW.Effects.CombatAllAdvantage"),
    path: ALL_COMBAT_ADVANTAGE_EFFECT_KEY,
    group: game.i18n.localize("FALLOUTMAW.Effects.CombatGroup")
  });
}

export function buildAllCombatDisadvantageEffectKeyToken() {
  return createEffectKeyToken({
    code: "allCombatDisadvantage",
    key: "allCombatDisadvantage",
    label: game.i18n.localize("FALLOUTMAW.Effects.CombatAllDisadvantage"),
    path: ALL_COMBAT_DISADVANTAGE_EFFECT_KEY,
    group: game.i18n.localize("FALLOUTMAW.Effects.CombatGroup")
  });
}

export function buildCombatAttackAdvantageEffectKeyTokens() {
  const group = game.i18n.localize("FALLOUTMAW.Effects.CombatGroup");
  return getAttackingWeaponActionEntries().map(entry => {
    const actionLabel = entry.actionLabel ?? String(entry.label || entry.key).replace(/:\s*[^:]+$/, "");
    return createEffectKeyToken({
      code: `${entry.key}:adv`,
      key: `${entry.key}.advantage`,
      label: `${game.i18n.localize("FALLOUTMAW.Effects.CombatAdvantage")}: ${actionLabel}`,
      path: `system.combat.actions.${entry.key}.advantage`,
      group
    });
  }).filter(Boolean);
}

export function buildCombatAttackDisadvantageEffectKeyTokens() {
  const group = game.i18n.localize("FALLOUTMAW.Effects.CombatGroup");
  return getAttackingWeaponActionEntries().map(entry => {
    const actionLabel = entry.actionLabel ?? String(entry.label || entry.key).replace(/:\s*[^:]+$/, "");
    return createEffectKeyToken({
      code: `${entry.key}:dis`,
      key: `${entry.key}.disadvantage`,
      label: `${game.i18n.localize("FALLOUTMAW.Effects.CombatDisadvantage")}: ${actionLabel}`,
      path: `system.combat.actions.${entry.key}.disadvantage`,
      group
    });
  }).filter(Boolean);
}

export function buildActionCostEffectKeyTokens() {
  return getWeaponActionCostEntries().map(entry => createEffectKeyToken({
    code: entry.code,
    key: entry.key,
    label: entry.label,
    path: `system.costs.actions.${entry.key}`,
    group: "Стоимость"
  })).filter(Boolean);
}

export function buildWeaponSwitchCostEffectKeyToken() {
  return createEffectKeyToken({
    code: "weaponSwitchCost",
    key: "weaponSwitch",
    label: "Смена оружия: стоимость",
    path: WEAPON_SWITCH_COST_KEY,
    group: "Стоимость"
  });
}

export function buildPostureEffectKeyTokens() {
  const group = "Положения";
  return getPostureEffectKeyEntries().flatMap(posture => [
    createEffectKeyToken({
      code: `${posture.code}MoveMultiplier`,
      key: `${posture.key}.movementMultiplier`,
      label: `${posture.label}: множитель передвижения`,
      path: `system.postures.${posture.key}.movementMultiplier`,
      group
    }),
    createEffectKeyToken({
      code: `${posture.code}WeaponActionCost`,
      key: `${posture.key}.weaponActionCost`,
      label: `${posture.label}: стоимость оружейных действий`,
      path: `system.postures.${posture.key}.weaponActionCost`,
      group
    })
  ]).filter(Boolean);
}

export function buildActionBlockEffectKeyTokens() {
  return getWeaponActionCostEntries().map(entry => {
    const actionLabel = entry.actionLabel ?? String(entry.label || entry.key).replace(/:\s*[^:]+$/, "");
    return createEffectKeyToken({
      code: `${entry.key}Block`,
      key: entry.key,
      label: `${actionLabel}: Блокировка`,
      path: `system.blocks.actions.${entry.key}`,
      group: "Блокировки"
    });
  }).filter(Boolean);
}

export function buildActionPenetrationEffectKeyTokens() {
  const penetrationLabel = game.i18n.localize("FALLOUTMAW.Effects.CombatPenetration");
  return getWeaponActionCostEntries().map(entry => {
    const actionLabel = entry.actionLabel ?? String(entry.label || entry.key).replace(/:\s*[^:]+$/, "");
    return createEffectKeyToken({
      code: `${entry.key}Penetration`,
      key: entry.key,
      label: `${actionLabel}: ${penetrationLabel.toLocaleLowerCase()}`,
      path: `system.penetration.actions.${entry.key}`,
      group: penetrationLabel
    });
  }).filter(Boolean);
}

export function getWeaponActionCostEntries() {
  return [
    { key: "aimedShot", code: "aimedShotCost", label: `${localizeOrFallback("FALLOUTMAW.Item.WeaponActionAimedShot", "Прицельный выстрел")}: стоимость`, actionLabel: localizeOrFallback("FALLOUTMAW.Item.WeaponActionAimedShot", "Прицельный выстрел") },
    { key: "snapshot", code: "snapshotCost", label: `${localizeOrFallback("FALLOUTMAW.Item.WeaponActionSnapshot", "Выстрел на вскидку")}: стоимость`, actionLabel: localizeOrFallback("FALLOUTMAW.Item.WeaponActionSnapshot", "Выстрел на вскидку") },
    { key: "burst", code: "burstCost", label: `${localizeOrFallback("FALLOUTMAW.Item.WeaponActionBurst", "Очередь")}: стоимость`, actionLabel: localizeOrFallback("FALLOUTMAW.Item.WeaponActionBurst", "Очередь") },
    { key: "volley", code: "volleyCost", label: `${localizeOrFallback("FALLOUTMAW.Item.WeaponActionVolley", "Залп")}: стоимость`, actionLabel: localizeOrFallback("FALLOUTMAW.Item.WeaponActionVolley", "Залп") },
    { key: "meleeAttack", code: "meleeAttackCost", label: `${localizeOrFallback("FALLOUTMAW.Item.WeaponActionMeleeAttack", "Неприцельная атака")}: стоимость`, actionLabel: localizeOrFallback("FALLOUTMAW.Item.WeaponActionMeleeAttack", "Неприцельная атака") },
    { key: "aimedMeleeAttack", code: "aimedMeleeAttackCost", label: `${localizeOrFallback("FALLOUTMAW.Item.WeaponActionAimedMeleeAttack", "Прицельная атака")}: стоимость`, actionLabel: localizeOrFallback("FALLOUTMAW.Item.WeaponActionAimedMeleeAttack", "Прицельная атака") },
    { key: "push", code: "pushCost", label: `${localizeOrFallback("FALLOUTMAW.Item.WeaponActionPush", "Толчок")}: стоимость`, actionLabel: localizeOrFallback("FALLOUTMAW.Item.WeaponActionPush", "Толчок") },
    { key: "reload", code: "reloadCost", label: `${localizeOrFallback("FALLOUTMAW.Item.WeaponActionReload", "Перезарядка")}: стоимость`, actionLabel: localizeOrFallback("FALLOUTMAW.Item.WeaponActionReload", "Перезарядка") }
  ];
}

function getAttackingWeaponActionEntries() {
  const attackingKeys = new Set(ATTACKING_WEAPON_ACTION_KEYS);
  return getWeaponActionCostEntries().filter(entry => attackingKeys.has(entry.key));
}

function getPostureEffectKeyEntries() {
  return [
    { key: "walk", code: "walkPosture", label: localizeOrFallback("FALLOUTMAW.Movement.Walk", "Ходьба") },
    { key: "crawl", code: "crouchPosture", label: localizeOrFallback("FALLOUTMAW.Movement.Crouch", "Присед") },
    { key: "burrow", code: "pronePosture", label: localizeOrFallback("FALLOUTMAW.Movement.Prone", "Лежа") },
    { key: "knocked", code: "knockedPosture", label: localizeOrFallback("FALLOUTMAW.Movement.Knocked", "Опрокинутый") }
  ];
}

function buildAbilityRuntimeEffectKeyTokens() {
  const abilityGroup = "Способности";
  const overloadTokens = [
    createEffectKeyToken({
      code: "abilityOverloadEnergy",
      key: "abilityOverloadEnergy",
      label: "Расход энергии на способность",
      path: ABILITY_OVERLOAD_ENERGY_COST_EFFECT_KEY,
      group: abilityGroup
    }),
    ...getResourceSettings()
      .map(entry => {
        const resourceKey = String(entry?.key ?? "").trim();
        if (!resourceKey || resourceKey === "power") return null;
        const label = String(entry?.label ?? resourceKey).trim() || resourceKey;
        return createEffectKeyToken({
          code: `abilityOverload_${resourceKey}`,
          key: `abilityOverload_${resourceKey}`,
          label: `Расход ${label.toLocaleLowerCase()} на способность`,
          path: getAbilityOverloadCostEffectKey(resourceKey),
          group: abilityGroup
        });
      })
      .filter(Boolean),
    ...(getResourceSettings().some(entry => String(entry?.key ?? "").trim() === "reactionPoints")
      ? []
      : [createEffectKeyToken({
        code: "abilityOverload_reactionPoints",
        key: "abilityOverload_reactionPoints",
        label: "Расход очков реакции на способность",
        path: getAbilityOverloadCostEffectKey("reactionPoints"),
        group: abilityGroup
      })])
  ];
  return [
    ...overloadTokens,
    createEffectKeyToken({
      code: "nextSkillModifier",
      key: "nextSkillModifier",
      label: "Следующая проверка выбранного навыка",
      path: ONE_TIME_SKILL_MODIFIER_EFFECT_KEY,
      group: "Навыки"
    }),
    createEffectKeyToken({
      code: "smartCriticalSuccess",
      key: "smartCriticalSuccess",
      label: "Подтасовка: критический успех",
      path: SMART_FUDGE_RESULT_EFFECT_KEYS.criticalSuccess,
      group: "Подтасовка"
    }),
    createEffectKeyToken({
      code: "smartSuccess",
      key: "smartSuccess",
      label: "Подтасовка: успех",
      path: SMART_FUDGE_RESULT_EFFECT_KEYS.success,
      group: "Подтасовка"
    }),
    createEffectKeyToken({
      code: "smartFailure",
      key: "smartFailure",
      label: "Подтасовка: провал",
      path: SMART_FUDGE_RESULT_EFFECT_KEYS.failure,
      group: "Подтасовка"
    }),
    createEffectKeyToken({
      code: "smartCriticalFailure",
      key: "smartCriticalFailure",
      label: "Подтасовка: критический провал",
      path: SMART_FUDGE_RESULT_EFFECT_KEYS.criticalFailure,
      group: "Подтасовка"
    })
  ];
}

export function buildCombatEffectKeyTokens() {
  return [
    buildAllCombatAdvantageEffectKeyToken(),
    buildAllCombatDisadvantageEffectKeyToken(),
    ...buildCombatAttackAdvantageEffectKeyTokens(),
    ...buildCombatAttackDisadvantageEffectKeyTokens(),
    createEffectKeyToken({
      code: "accuracy",
      key: "accuracy",
      label: game.i18n.localize("FALLOUTMAW.Effects.CombatAccuracy"),
      path: "system.combat.accuracy",
      group: game.i18n.localize("FALLOUTMAW.Effects.CombatGroup")
    }),
    createEffectKeyToken({
      code: "criticalChance",
      key: "criticalChance",
      label: game.i18n.localize("FALLOUTMAW.Effects.CombatCriticalChance"),
      path: "system.combat.criticalChance",
      group: game.i18n.localize("FALLOUTMAW.Effects.CombatGroup")
    }),
    createEffectKeyToken({
      code: "damageFlat",
      key: "damageFlat",
      label: game.i18n.localize("FALLOUTMAW.Effects.CombatDamageFlat"),
      path: "system.combat.damageFlat",
      group: game.i18n.localize("FALLOUTMAW.Effects.CombatGroup")
    }),
    createEffectKeyToken({
      code: "damagePercent",
      key: "damagePercent",
      label: game.i18n.localize("FALLOUTMAW.Effects.CombatDamagePercent"),
      path: "system.combat.damagePercent",
      group: game.i18n.localize("FALLOUTMAW.Effects.CombatGroup")
    }),
    createEffectKeyToken({
      code: "burstStability",
      key: "burstStability",
      label: game.i18n.localize("FALLOUTMAW.Effects.CombatBurstStability"),
      path: "system.combat.burstStability",
      group: game.i18n.localize("FALLOUTMAW.Effects.CombatGroup")
    }),
    createEffectKeyToken({
      code: "finishingBlow",
      key: "finishingBlow",
      label: game.i18n.localize("FALLOUTMAW.Effects.CombatFinishingBlow"),
      path: "system.combat.finishingBlow",
      group: game.i18n.localize("FALLOUTMAW.Effects.CombatGroup")
    }),
    createEffectKeyToken({
      code: "finishingBlowChance",
      key: "finishingBlowChance",
      label: game.i18n.localize("FALLOUTMAW.Effects.CombatFinishingBlowChance"),
      path: "system.combat.finishingBlowChance",
      group: game.i18n.localize("FALLOUTMAW.Effects.CombatGroup")
    }),
    createEffectKeyToken({
      code: "unconsciousnessResistance",
      key: "unconsciousnessResistance",
      label: "Сопротивление к потере сознания",
      path: "system.combat.unconsciousnessResistance",
      group: "Бой"
    }),
    createEffectKeyToken({
      code: "incomingHealing",
      key: "incomingHealing",
      label: "Входящее лечение, %",
      path: "system.healing.incomingPercent",
      group: "Лечение"
    }),
    createEffectKeyToken({
      code: "outgoingHealing",
      key: "outgoingHealing",
      label: "Исходящее лечение, %",
      path: "system.healing.outgoingPercent",
      group: "Лечение"
    })
  ].filter(Boolean);
}

export function buildReverseInteractionEffectKeyTokens() {
  const reversePenetrationActionKeys = new Set([
    "aimedShot",
    "snapshot",
    "burst",
    "volley",
    "meleeAttack",
    "aimedMeleeAttack"
  ]);
  const attackingPenetrationPaths = new Set(Array.from(reversePenetrationActionKeys)
    .map(actionKey => `system.penetration.actions.${actionKey}`));
  const sourceTokens = [
    ...getSkillSettings().map(entry => createEffectKeyToken({
      code: entry.abbr || entry.key,
      key: entry.key,
      label: entry.label,
      path: `system.skills.${entry.key}.bonus`,
      group: game.i18n.localize("FALLOUTMAW.Common.Skills")
    })),
    ...buildSkillAdvantageEffectKeyTokens(),
    ...buildSkillDisadvantageEffectKeyTokens(),
    buildAllSkillsEffectKeyToken(),
    buildAllSkillsAdvantageEffectKeyToken(),
    buildAllSkillsDisadvantageEffectKeyToken(),
    buildAllCombatAdvantageEffectKeyToken(),
    buildAllCombatDisadvantageEffectKeyToken(),
    ...buildCombatAttackAdvantageEffectKeyTokens().filter(token => !token.path.includes(".volley.")),
    ...buildCombatAttackDisadvantageEffectKeyTokens().filter(token => !token.path.includes(".volley.")),
    createEffectKeyToken({
      code: "allAttackPenetration",
      key: "allAttackPenetration",
      label: game.i18n.localize("FALLOUTMAW.Effects.CombatAllPenetration"),
      path: "system.penetration.actions.all",
      group: game.i18n.localize("FALLOUTMAW.Effects.ReverseGroup")
    }),
    ...buildActionPenetrationEffectKeyTokens().filter(token => attackingPenetrationPaths.has(token?.path)),
    ...buildCombatEffectKeyTokens().filter(token => [
      "system.combat.accuracy",
      "system.combat.criticalChance",
      "system.combat.damageFlat",
      "system.combat.damagePercent",
      "system.combat.burstStability",
      "system.combat.finishingBlow",
      "system.combat.finishingBlowChance"
    ].includes(token?.path))
  ].filter(Boolean);
  const group = game.i18n.localize("FALLOUTMAW.Effects.ReverseGroup");
  return sourceTokens.map(token => createEffectKeyToken({
    code: `${token.code}:reverse`,
    key: `reverse.${token.key}`,
    label: game.i18n.format("FALLOUTMAW.Effects.ReverseLabel", {
      label: String(token.label ?? token.path)
    }),
    path: getReverseEffectKey(token.path),
    group
  })).filter(Boolean);
}

export function buildSuppressionEffectKeyTokens() {
  const group = "Подавление";
  return [
    createEffectKeyToken({
      code: "suppressTraumas",
      key: "suppressTraumas",
      label: "Травмы: подавить случайные",
      path: TRAUMA_SUPPRESSION_COUNT_EFFECT_KEY,
      group
    }),
    createEffectKeyToken({
      code: "suppressDiseases",
      key: "suppressDiseases",
      label: "Болезни: подавить случайные",
      path: DISEASE_SUPPRESSION_COUNT_EFFECT_KEY,
      group
    }),
    createEffectKeyToken({
      code: "suppressAllTraumas",
      key: "suppressAllTraumas",
      label: "Травмы: подавить все",
      path: TRAUMA_SUPPRESSION_ALL_EFFECT_KEY,
      group
    }),
    createEffectKeyToken({
      code: "suppressAllDiseases",
      key: "suppressAllDiseases",
      label: "Болезни: подавить все",
      path: DISEASE_SUPPRESSION_ALL_EFFECT_KEY,
      group
    })
  ];
}

export function buildDamageMitigationEffectKeyTokens() {
  const allLabel = localizeOrFallback("FALLOUTMAW.Common.All", "Все");
  const allLimbsLabel = `${allLabel} ${localizeOrFallback("FALLOUTMAW.Common.Limbs", "части тела").toLocaleLowerCase()}`;
  const allDamageTypesLabel = `${allLabel} ${localizeOrFallback("FALLOUTMAW.Common.DamageTypes", "типы урона").toLocaleLowerCase()}`;
  const damageTypes = getDamageTypeSettings();
  const limbs = getEffectKeyLimbs();
  const tokens = [];

  for (const { rootPath, groupLabel } of getDamageMitigationTokenGroups()) {
    tokens.push(createEffectKeyToken({
      code: `${groupLabel}: ${allLimbsLabel} / ${allDamageTypesLabel}`,
      key: `${rootPath}.all.all`,
      label: `${groupLabel}: ${allLimbsLabel}, ${allDamageTypesLabel}`,
      path: `system.${rootPath}.all.all`,
      group: groupLabel
    }));

    for (const damageType of damageTypes) {
      const damageTypeLabel = damageType.label || damageType.key;
      tokens.push(createEffectKeyToken({
        code: `${allLimbsLabel} / ${damageTypeLabel}`,
        key: `${rootPath}.all.${damageType.key}`,
        label: `${groupLabel}: ${allLimbsLabel}, ${damageTypeLabel}`,
        path: `system.${rootPath}.all.${damageType.key}`,
        group: groupLabel
      }));
    }

    for (const limb of limbs) {
      tokens.push(createEffectKeyToken({
        code: `${limb.label} / ${allDamageTypesLabel}`,
        key: `${rootPath}.${limb.key}.all`,
        label: `${groupLabel}: ${limb.label}, ${allDamageTypesLabel}`,
        path: `system.${rootPath}.${limb.key}.all`,
        group: groupLabel
      }));

      for (const damageType of damageTypes) {
        const damageTypeLabel = damageType.label || damageType.key;
        tokens.push(createEffectKeyToken({
          code: `${limb.label} / ${damageTypeLabel}`,
          key: `${rootPath}.${limb.key}.${damageType.key}`,
          label: `${groupLabel}: ${limb.label}, ${damageTypeLabel}`,
          path: `system.${rootPath}.${limb.key}.${damageType.key}`,
          group: groupLabel
        }));
      }
    }
  }

  return tokens.filter(Boolean);
}

export function buildLimbMaxBonusEffectKeyTokens() {
  const group = "Максимальное ОЗ частей тела";
  const allLimbsLabel = "Все части тела";
  const tokens = [
    createEffectKeyToken({
      code: "limbMax:all",
      key: "all",
      label: `${group}: ${allLimbsLabel}`,
      path: ALL_LIMB_MAX_BONUS_EFFECT_KEY,
      group
    })
  ];

  for (const limb of getEffectKeyLimbs()) {
    tokens.push(createEffectKeyToken({
      code: `limbMax:${limb.key}`,
      key: limb.key,
      label: `${group}: ${limb.label}`,
      path: `system.limbs.${limb.key}.maxBonus`,
      group
    }));
  }

  return tokens.filter(Boolean);
}

export function buildImplantLimitEffectKeyTokens() {
  const group = "Изменение доступных имплантов";
  const allLimbsLabel = "Все части тела";
  const tokens = [
    createEffectKeyToken({
      code: "implantLimit:all",
      key: "all",
      label: `${group}: ${allLimbsLabel}`,
      path: ALL_LIMB_IMPLANT_LIMIT_EFFECT_KEY,
      group
    })
  ];

  for (const limb of getEffectKeyLimbs()) {
    tokens.push(createEffectKeyToken({
      code: `implantLimit:${limb.key}`,
      key: limb.key,
      label: `${group}: ${limb.label}`,
      path: `system.limbs.${limb.key}.implantLimitBonus`,
      group
    }));
  }

  return tokens.filter(Boolean);
}

function getDamageMitigationTokenGroups() {
  return [
    {
      rootPath: "damageDefenseBonuses",
      groupLabel: localizeOrFallback("FALLOUTMAW.Effects.DamageDefenseBonuses", "Бонус защиты от урона")
    },
    {
      rootPath: "damageResistanceBonuses",
      groupLabel: localizeOrFallback("FALLOUTMAW.Effects.DamageResistanceBonuses", "Бонус сопротивлений урону")
    }
  ];
}

function getEffectKeyLimbs() {
  const byKey = new Map();
  for (const race of getCreatureOptions().races ?? []) {
    for (const limb of race?.limbs ?? []) {
      const key = String(limb?.key ?? "").trim();
      if (!key || byKey.has(key)) continue;
      byKey.set(key, {
        key,
        label: String(limb?.label ?? limb?.name ?? key).trim() || key
      });
    }
  }
  return Array.from(byKey.values()).sort((left, right) => left.label.localeCompare(right.label));
}

function localizeOrFallback(key, fallback) {
  const value = game.i18n.localize(key);
  return value === key ? fallback : value;
}
