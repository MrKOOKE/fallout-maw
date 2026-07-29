import { createEffectKeyToken } from "../apps/effect-key-autocomplete.mjs";
import {
  getNeedGrowthResistanceEffectKey,
  getNeedSatisfactionEffectivenessEffectKey
} from "./need-change-effect-keys.mjs";

export function buildNeedChangeModifierEffectKeyTokens(needs = [], { group = "" } = {}) {
  const resolvedGroup = String(group || localize("FALLOUTMAW.Common.Needs", "Потребности"));
  return (Array.isArray(needs) ? needs : [])
    .flatMap(need => {
      const needKey = String(need?.key ?? "").trim();
      if (!needKey) return [];
      const needLabel = String(need?.label ?? needKey).trim() || needKey;
      const code = String(need?.abbr ?? needKey).trim() || needKey;
      return [
        createEffectKeyToken({
          code: `${code}GrowthResistance`,
          key: `${needKey}GrowthResistance`,
          label: format(
            "FALLOUTMAW.Effects.NeedGrowthResistance",
            { need: needLabel },
            `Сопротивление росту (${needLabel})`
          ),
          path: getNeedGrowthResistanceEffectKey(needKey),
          group: resolvedGroup
        }),
        createEffectKeyToken({
          code: `${code}SatisfactionEffectiveness`,
          key: `${needKey}SatisfactionEffectiveness`,
          label: format(
            "FALLOUTMAW.Effects.NeedSatisfactionEffectiveness",
            { need: needLabel },
            `Эффективность утоления (${needLabel})`
          ),
          path: getNeedSatisfactionEffectivenessEffectKey(needKey),
          group: resolvedGroup
        })
      ];
    })
    .filter(Boolean);
}

function localize(key, fallback) {
  return globalThis.game?.i18n?.localize?.(key) ?? fallback;
}

function format(key, data, fallback) {
  return globalThis.game?.i18n?.format?.(key, data) ?? fallback;
}
