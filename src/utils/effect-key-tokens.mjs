import { createEffectKeyToken } from "../apps/effect-key-autocomplete.mjs";
import {
  getCharacteristicSettings,
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
