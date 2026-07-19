import { SYSTEM_ID } from "../constants.mjs";
import { ENERGY_RESOURCE_KEY } from "../combat/energy-resource.mjs";
import { getAbilitySourceId } from "../settings/abilities.mjs";
import {
  getAbilityOverloadCostEffectKey,
  getResourceKeyFromOverloadEffectKey,
  evaluateActorEffectChangeNumber
} from "../utils/active-effect-changes.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { getAbilityEffectOriginUuid } from "../utils/ability-effect-origin.mjs";
import { isAbilityResourceCostActive } from "./resource-cost-policy.mjs";

export const ABILITY_OVERLOAD_EFFECT_FLAG_KEY = "abilityOverload";
/** @deprecated Prefer getAbilityOverloadReactionCostId(resourceKey); kept for energy/power rows. */
export const ABILITY_OVERLOAD_REACTION_COST_ID = "ability-overload-power";
export const ABILITY_OVERLOAD_REACTION_COST_ID_PREFIX = "ability-overload-";
const LEGACY_ABILITY_OVERLOAD_REACTION_COST_ID = "ability-overload-energy";
const ACTIVE_EFFECT_SHOW_ICON_ALWAYS = 2;

export function getAbilityOverloadName(item = null) {
  const name = String(item?.name ?? "").trim() || "Способность";
  return `Перегрузка: ${name}`;
}

export function getAbilityOverloadReactionCostId(resourceKey = ENERGY_RESOURCE_KEY) {
  const key = String(resourceKey ?? "").trim() || ENERGY_RESOURCE_KEY;
  return `${ABILITY_OVERLOAD_REACTION_COST_ID_PREFIX}${key}`;
}

export function isAbilityOverloadReactionCostId(id = "") {
  const value = String(id ?? "").trim();
  return value === LEGACY_ABILITY_OVERLOAD_REACTION_COST_ID
    || value.startsWith(ABILITY_OVERLOAD_REACTION_COST_ID_PREFIX);
}

/** Total overload surcharge for energy/power (legacy fixed-ability path). */
export function getAbilityOverloadEnergyCost(actor, abilityItem, abilityFunction = null) {
  return getAbilityOverloadResourceCost(actor, abilityItem, ENERGY_RESOURCE_KEY, abilityFunction);
}

export function getAbilityOverloadResourceCost(actor, abilityItem, resourceKey = ENERGY_RESOURCE_KEY, abilityFunction = null) {
  const key = String(resourceKey ?? "").trim() || ENERGY_RESOURCE_KEY;
  return getAbilityOverloadCostsByResource(actor, abilityItem, abilityFunction).get(key) ?? 0;
}

export function getAbilityOverloadResourceCostSources(actor, abilityItem, resourceKey = ENERGY_RESOURCE_KEY) {
  const key = String(resourceKey ?? "").trim() || ENERGY_RESOURCE_KEY;
  const sources = [];
  if (!actor || !abilityItem) return sources;
  const abilityItemId = String(abilityItem.id ?? "").trim();
  const abilitySourceId = getAbilitySourceId(abilityItem);
  for (const effect of actor.allApplicableEffects?.() ?? actor.effects ?? []) {
    if (effect?.disabled) continue;
    const overload = effect.getFlag?.(SYSTEM_ID, ABILITY_OVERLOAD_EFFECT_FLAG_KEY)
      ?? effect?.flags?.[SYSTEM_ID]?.[ABILITY_OVERLOAD_EFFECT_FLAG_KEY];
    if (!abilityOverloadApplies(overload, { abilityItemId, abilitySourceId })) continue;
    const flagResourceKey = String(overload?.resourceKey ?? "").trim();
    for (const change of effect.system?.changes ?? []) {
      const changeResourceKey = getResourceKeyFromOverloadEffectKey(change?.key);
      if (!changeResourceKey || changeResourceKey !== key) continue;
      if (flagResourceKey && flagResourceKey !== key) continue;
      const amount = Math.max(0, evaluateActorEffectChangeNumber(actor, { ...change, effect }, { fallback: 0 }));
      if (amount <= 0) continue;
      const parent = effect?.parent?.documentName === "Item" ? effect.parent : effect;
      sources.push({
        name: String(parent?.name ?? effect?.name ?? getAbilityOverloadName(abilityItem)),
        img: String(parent?.img ?? effect?.img ?? abilityItem.img ?? ""),
        effectUuid: String(effect?.uuid ?? ""),
        operation: "add",
        value: amount
      });
    }
  }
  return sources;
}

/** Map of resourceKey → overload surcharge amount for the given ability. */
export function getAbilityOverloadCostsByResource(actor, abilityItem, _abilityFunction = null) {
  const totals = new Map();
  if (!actor || !abilityItem) return totals;
  const abilityItemId = String(abilityItem.id ?? "").trim();
  const abilitySourceId = getAbilitySourceId(abilityItem);
  for (const effect of actor.allApplicableEffects?.() ?? actor.effects ?? []) {
    if (effect?.disabled) continue;
    const overload = effect.getFlag?.(SYSTEM_ID, ABILITY_OVERLOAD_EFFECT_FLAG_KEY)
      ?? effect?.flags?.[SYSTEM_ID]?.[ABILITY_OVERLOAD_EFFECT_FLAG_KEY];
    if (!abilityOverloadApplies(overload, { abilityItemId, abilitySourceId })) continue;
    const flagResourceKey = String(overload?.resourceKey ?? "").trim();
    for (const change of effect.system?.changes ?? []) {
      const changeKey = String(change?.key ?? "");
      const keyResource = getResourceKeyFromOverloadEffectKey(changeKey);
      if (!keyResource) continue;
      if (flagResourceKey && flagResourceKey !== keyResource) continue;
      const resourceKey = flagResourceKey || keyResource;
      const amount = Math.max(0, evaluateActorEffectChangeNumber(actor, { ...change, effect }, { fallback: 0 }));
      if (amount <= 0) continue;
      totals.set(resourceKey, (totals.get(resourceKey) ?? 0) + amount);
    }
  }
  for (const [resourceKey, total] of totals) {
    totals.set(resourceKey, Math.max(0, Math.trunc(total)));
  }
  return totals;
}

export function abilityOverloadApplies(overload = {}, { abilityItemId = "", abilitySourceId = "" } = {}) {
  if (!overload || typeof overload !== "object") return false;
  const overloadSourceId = String(overload.abilitySourceId ?? "").trim();
  if (overloadSourceId && abilitySourceId) return overloadSourceId === abilitySourceId;
  return String(overload.abilityItemId ?? "").trim() === abilityItemId;
}

/** Appends current ability overload as cost rows for each overloaded resource. */
export function withAbilityOverloadCostRows(actor, abilityItem, abilityFunction, costs = []) {
  const rows = (Array.isArray(costs) ? costs : Object.values(costs ?? {}))
    .filter(row => !isAbilityOverloadReactionCostId(row?.id))
    .map(row => ({ ...row }));
  const overloads = getAbilityOverloadCostsByResource(actor, abilityItem, abilityFunction);
  for (const [resourceKey, amount] of Array.from(overloads.entries()).sort(([left], [right]) => left.localeCompare(right))) {
    if (amount <= 0) continue;
    rows.push({
      id: getAbilityOverloadReactionCostId(resourceKey),
      resourceKey,
      formula: String(amount),
      overloadAmount: 0,
      overloadDurationSeconds: 0
    });
  }
  return rows;
}

/** @deprecated Use withAbilityOverloadCostRows — kept for call sites and tests. */
export function withAbilityOverloadEnergyCostRows(actor, abilityItem, abilityFunction, costs = []) {
  return withAbilityOverloadCostRows(actor, abilityItem, abilityFunction, costs);
}

export async function applyAbilityOverloadEffect(actor, abilityItem, abilityFunction, {
  name = "Перегрузка",
  energyCost = 0,
  cost = null,
  resourceKey = ENERGY_RESOURCE_KEY,
  durationSeconds = 0,
  chainRef = null
} = {}) {
  if (!actor || (!game.user?.isGM && !actor.isOwner)) return false;
  const amount = Math.max(0, toInteger(cost ?? energyCost));
  const seconds = Math.max(0, toInteger(durationSeconds));
  const resolvedResourceKey = String(resourceKey ?? "").trim() || ENERGY_RESOURCE_KEY;
  if (amount <= 0 || seconds <= 0) return false;
  const startTime = Number(game.time?.worldTime) || 0;
  const effectKey = getAbilityOverloadCostEffectKey(resolvedResourceKey);
  await actor.createEmbeddedDocuments("ActiveEffect", [{
    type: "base",
    name,
    img: abilityItem?.img || "icons/svg/aura.svg",
    origin: getAbilityEffectOriginUuid(actor, abilityItem),
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    duration: {
      seconds,
      startTime
    },
    system: {
      changes: [{
        key: effectKey,
        type: "add",
        value: String(amount),
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
          resourceKey: resolvedResourceKey,
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
  costs = [],
  chainRef = null
} = {}) {
  const rows = Array.isArray(costs) ? costs : Object.values(costs ?? {});
  let applied = 0;
  for (const row of rows) {
    const resourceKey = String(row?.resourceKey ?? "").trim();
    if (!isAbilityResourceCostActive(actor, resourceKey)) continue;
    const overloadAmount = Math.max(0, toInteger(row?.overloadAmount ?? row?.overload ?? 0));
    const durationSeconds = Math.max(0, toInteger(row?.overloadDurationSeconds ?? 0));
    if (!resourceKey || overloadAmount <= 0 || durationSeconds <= 0) continue;
    const ok = await applyAbilityOverloadEffect(actor, abilityItem, abilityFunction, {
      name: getAbilityOverloadName(abilityItem),
      cost: overloadAmount,
      resourceKey,
      durationSeconds,
      chainRef
    });
    if (ok) applied += 1;
  }
  return applied;
}
