import { SYSTEM_ID } from "../constants.mjs";
import { ENERGY_RESOURCE_KEY } from "../combat/energy-resource.mjs";
import { getAbilitySourceId } from "../settings/abilities.mjs";
import {
  ABILITY_OVERLOAD_ENERGY_COST_EFFECT_KEY,
  evaluateActorEffectChangeNumber
} from "../utils/active-effect-changes.mjs";
import { toInteger } from "../utils/numbers.mjs";

export const ABILITY_OVERLOAD_EFFECT_FLAG_KEY = "abilityOverload";
export const ABILITY_OVERLOAD_REACTION_COST_ID = "ability-overload-energy";
const ACTIVE_EFFECT_SHOW_ICON_ALWAYS = 2;

export function getAbilityOverloadName(item = null) {
  const name = String(item?.name ?? "").trim() || "Способность";
  return `Перегрузка: ${name}`;
}

export function getAbilityOverloadEnergyCost(actor, abilityItem, _abilityFunction = null) {
  if (!actor || !abilityItem) return 0;
  const abilityItemId = String(abilityItem.id ?? "").trim();
  const abilitySourceId = getAbilitySourceId(abilityItem);
  let total = 0;
  for (const effect of actor.allApplicableEffects?.() ?? actor.effects ?? []) {
    if (effect?.disabled) continue;
    const overload = effect.getFlag?.(SYSTEM_ID, ABILITY_OVERLOAD_EFFECT_FLAG_KEY)
      ?? effect?.flags?.[SYSTEM_ID]?.[ABILITY_OVERLOAD_EFFECT_FLAG_KEY];
    if (!abilityOverloadApplies(overload, { abilityItemId, abilitySourceId })) continue;
    for (const change of effect.system?.changes ?? []) {
      if (String(change?.key ?? "") !== ABILITY_OVERLOAD_ENERGY_COST_EFFECT_KEY) continue;
      total += Math.max(0, evaluateActorEffectChangeNumber(actor, { ...change, effect }, { fallback: 0 }));
    }
  }
  return Math.max(0, Math.trunc(total));
}

export function abilityOverloadApplies(overload = {}, { abilityItemId = "", abilitySourceId = "" } = {}) {
  if (!overload || typeof overload !== "object") return false;
  const overloadSourceId = String(overload.abilitySourceId ?? "").trim();
  if (overloadSourceId && abilitySourceId) return overloadSourceId === abilitySourceId;
  return String(overload.abilityItemId ?? "").trim() === abilityItemId;
}

/** Appends current ability overload as an energy (power) cost row for any use path. */
export function withAbilityOverloadEnergyCostRows(actor, abilityItem, abilityFunction, costs = []) {
  const rows = (Array.isArray(costs) ? costs : Object.values(costs ?? {}))
    .filter(row => String(row?.id ?? "").trim() !== ABILITY_OVERLOAD_REACTION_COST_ID)
    .map(row => ({ ...row }));
  const overload = getAbilityOverloadEnergyCost(actor, abilityItem, abilityFunction);
  if (overload <= 0) return rows;
  rows.push({
    id: ABILITY_OVERLOAD_REACTION_COST_ID,
    resourceKey: ENERGY_RESOURCE_KEY,
    formula: String(overload),
    overloadAmount: 0,
    overloadDurationSeconds: 0
  });
  return rows;
}

export async function applyAbilityOverloadEffect(actor, abilityItem, abilityFunction, {
  name = "Перегрузка",
  energyCost = 0,
  durationSeconds = 0,
  chainRef = null
} = {}) {
  if (!actor || (!game.user?.isGM && !actor.isOwner)) return false;
  const cost = Math.max(0, toInteger(energyCost));
  const seconds = Math.max(0, toInteger(durationSeconds));
  if (cost <= 0 || seconds <= 0) return false;
  const startTime = Number(game.time?.worldTime) || 0;
  await actor.createEmbeddedDocuments("ActiveEffect", [{
    type: "base",
    name,
    img: abilityItem?.img || "icons/svg/aura.svg",
    origin: abilityItem?.uuid ?? "",
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    duration: {
      seconds,
      startTime
    },
    system: {
      changes: [{
        key: ABILITY_OVERLOAD_ENERGY_COST_EFFECT_KEY,
        type: "add",
        value: String(cost),
        phase: "initial",
        priority: null
      }]
    },
    flags: {
      [SYSTEM_ID]: {
        kind: "temporary",
        [ABILITY_OVERLOAD_EFFECT_FLAG_KEY]: {
          abilityItemId: abilityItem?.id ?? "",
          abilitySourceId: getAbilitySourceId(abilityItem),
          functionId: abilityFunction?.id ?? "",
          fixedKey: abilityFunction?.fixedKey ?? "",
          createdAt: startTime
        }
      }
    }
  }], {
    animate: false,
    ...(chainRef ? { chainRef, falloutMawSystemEventChainRef: chainRef } : {})
  });
  return true;
}

export async function applyAbilityFunctionOverloadCosts(actor, abilityItem, abilityFunction, {
  costs = null,
  chainRef = null
} = {}) {
  const rows = Array.isArray(costs)
    ? costs
    : (abilityFunction?.reactionSettings?.costs ?? []);
  let applied = 0;
  for (const row of rows) {
    const energyCost = Math.max(0, toInteger(row?.overloadAmount ?? row?.overload ?? 0));
    const durationSeconds = Math.max(0, toInteger(row?.overloadDurationSeconds ?? 0));
    if (energyCost <= 0 || durationSeconds <= 0) continue;
    const ok = await applyAbilityOverloadEffect(actor, abilityItem, abilityFunction, {
      name: getAbilityOverloadName(abilityItem),
      energyCost,
      durationSeconds,
      chainRef
    });
    if (ok) applied += 1;
  }
  return applied;
}
