import { createEffectKeyToken } from "../apps/effect-key-autocomplete.mjs";
import {
  getCharacteristicSettings,
  getCreatureOptions,
  getDamageTypeSettings,
  getNeedSettings,
  getProficiencySettings,
  getResourceSettings,
  getSkillSettings
} from "../settings/accessors.mjs";

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
    ...getResourceSettings().map(entry => createEffectKeyToken({
      code: entry.abbr || entry.key,
      key: entry.key,
      label: entry.label,
      path: `system.resources.${entry.key}.bonus`,
      group: game.i18n.localize("FALLOUTMAW.Common.Resources")
    })),
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
    ...buildDamageMitigationEffectKeyTokens(),
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
    })
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

function getDamageMitigationTokenGroups() {
  return [
    {
      rootPath: "damageDefenses",
      groupLabel: localizeOrFallback("FALLOUTMAW.Common.DamageDefenses", "Защита от урона")
    },
    {
      rootPath: "damageResistances",
      groupLabel: localizeOrFallback("FALLOUTMAW.Common.DamageResistances", "Сопротивления урону")
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
