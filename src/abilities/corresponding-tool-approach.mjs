import {
  ABILITY_FIXED_FUNCTION_KEYS,
  ABILITY_FUNCTION_TYPES,
  normalizeCorrespondingToolApproachSettings
} from "../settings/abilities.mjs";
import { isToolWorkflowClassExact } from "../utils/tool-workflow-modifiers.mjs";

const FIXED_KEY = ABILITY_FIXED_FUNCTION_KEYS.correspondingToolApproach;

/**
 * Compile owned copies of "Всему свой подход" into a cheap contextual resolver.
 */
export function createCorrespondingToolApproachResolver(actor) {
  const sources = collectCorrespondingToolApproachSources(actor);
  if (!sources.length) return null;

  return context => {
    if (!isToolWorkflowClassExact(context.toolContext)) return null;
    if (
      (context.requester === "hacking" && context.skillKey === "lockpicking")
      || (context.requester === "trapDisarm" && context.skillKey === "traps")
    ) {
      return sources.map(source => ({
        source: source.id,
        label: source.label,
        skillBonus: source.settings.skillBonus
      }));
    }
    if (context.requester === "repair") {
      return sources.map(source => ({
        source: source.id,
        label: source.label,
        efficiencyPercentBonus: source.settings.repairEfficiencyPercentBonus
      }));
    }
    return null;
  };
}

export function collectCorrespondingToolApproachSources(actor) {
  const items = getActorItems(actor);
  const sources = [];
  for (const item of items) {
    if (item?.type !== "ability") continue;
    const functions = Array.isArray(item.system?.functions) ? item.system.functions : [];
    for (const abilityFunction of functions) {
      if (
        abilityFunction?.type !== ABILITY_FUNCTION_TYPES.fixed
        || abilityFunction.fixedKey !== FIXED_KEY
      ) continue;
      sources.push({
        id: [FIXED_KEY, item.id, abilityFunction.id].filter(Boolean).join(":"),
        label: String(item.name ?? "").trim() || "Всему свой подход",
        settings: normalizeCorrespondingToolApproachSettings(abilityFunction.fixedSettings)
      });
    }
  }
  return sources;
}

function getActorItems(actor) {
  if (Array.isArray(actor?.items?.contents)) return actor.items.contents;
  if (Array.isArray(actor?.items)) return actor.items;
  return actor?.items ? Array.from(actor.items) : [];
}
