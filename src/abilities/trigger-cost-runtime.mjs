import {
  ABILITY_CONDITION_TYPES,
  ABILITY_FUNCTION_TYPES,
  getAbilityFunctionTriggerCostRows,
  isAbilityFunctionTimedTriggerCost,
  normalizeAbilityFunctions
} from "../settings/abilities.mjs";
import { SYSTEM_ID } from "../constants.mjs";
import { getActorItemsWithActiveHudModules } from "../utils/hud-active-items.mjs";
import { evaluateEffectChangeNumber } from "../utils/effect-change-values.mjs";
import { abilityConditionsApply } from "./evaluation.mjs";
import { isAttackingWeaponAction } from "./runtime-state.mjs";
import { getAuraGeneratedEffectFlag } from "./aura-conditions.mjs";
import {
  applyAbilityFunctionOverloadCosts,
  withAbilityOverloadCostRows
} from "./overload.mjs";

const SKILL_CHANGE_SUFFIXES = Object.freeze(["bonus", "advantage", "disadvantage"]);
const EXCLUSIVE_TRIGGER_TYPES = new Set([
  ABILITY_CONDITION_TYPES.eventReaction,
  ABILITY_CONDITION_TYPES.itemUse
]);

let resourceCostRegistry = null;
let skillCheckInterceptorRegistered = false;

/** Share the same atomic resource-cost registry used by Event Reaction. */
export function configureAbilityTriggerCostRuntime({ costRegistry = null } = {}) {
  if (!costRegistry?.quote || !costRegistry?.execute) {
    throw new TypeError("Ability trigger costs require a resource-cost registry.");
  }
  resourceCostRegistry = costRegistry;
  return resourceCostRegistry;
}

/** Register the GM-authoritative commit gate for consumable skill modifiers. */
export function registerAbilityTriggerCostInterceptors({ registerInterceptor = null } = {}) {
  if (skillCheckInterceptorRegistered) return;
  if (typeof registerInterceptor !== "function") {
    throw new TypeError("Ability trigger costs require a system-event interceptor registrar.");
  }
  skillCheckInterceptorRegistered = true;
  registerInterceptor({
    id: "fallout-maw.abilityTriggerCost.skillCheck",
    eventKeys: ["fallout-maw.skill.check.beforeRoll"],
    // Event Reaction runs at 100. Payment happens only after that hub has
    // resolved and only if no earlier interceptor cancelled the check.
    priority: 200,
    intercept: interceptSkillCheckTriggerCost
  });
}

/**
 * Pay one effect-change function when its own runtime trigger is actually
 * committed (for example, immediately before an Item Use effect is created).
 */
export async function payAbilityFunctionTriggerCost({
  actor = null,
  sourceItem = null,
  abilityFunction = null,
  expectedFingerprint = "",
  context = {}
} = {}) {
  if (!actor || !sourceItem || !abilityFunction) return failedPayment("invalidTriggerSource");
  if (!hasTriggerCostCondition(abilityFunction)) return successfulPayment({ charged: false });

  const baseRows = getAbilityFunctionTriggerCostRows(abilityFunction);
  return payAbilityFunctionResourceCosts({
    actor,
    sourceItem,
    abilityFunction,
    costRows: baseRows,
    expectedFingerprint,
    context
  });
}

/** Quote one trigger-cost function without changing actor state. */
export async function quoteAbilityFunctionTriggerCost({
  actor = null,
  sourceItem = null,
  abilityFunction = null,
  context = {}
} = {}) {
  if (!actor || !sourceItem || !abilityFunction) return failedPayment("invalidTriggerSource");
  if (!hasTriggerCostCondition(abilityFunction)) return successfulPayment({ charged: false, fingerprint: "" });
  return quoteAbilityFunctionResourceCosts({
    actor,
    sourceItem,
    abilityFunction,
    costRows: getAbilityFunctionTriggerCostRows(abilityFunction),
    context
  });
}

/** Quote an explicit function-owned resource vector without spending it. */
export async function quoteAbilityFunctionResourceCosts({
  actor = null,
  sourceItem = null,
  abilityFunction = null,
  costRows: rows = [],
  context = {}
} = {}) {
  if (!actor || !sourceItem || !abilityFunction) return failedPayment("invalidTriggerSource");
  const prepared = prepareAbilityFunctionResourceCostRows(actor, sourceItem, abilityFunction, rows);
  if (!prepared.rawBaseRows.length) {
    return successfulPayment({
      charged: false,
      fingerprint: "",
      quote: null,
      entries: [{ sourceItem, abilityFunction, baseRows: prepared.effectiveBaseRows }]
    });
  }
  const registry = resourceCostRegistry;
  if (!registry?.quote) return failedPayment("costRegistryUnavailable");
  const quote = await registry.quote(actor, prepared.costRows, createExecutionContext(context, {
    sourceItem,
    abilityFunction
  }));
  if (!quote?.valid || !quote?.affordable) {
    return failedPayment(quote?.reason || "spendFailed", { quote, fingerprint: quote?.fingerprint ?? "" });
  }
  return successfulPayment({
    charged: quote.costs?.some(cost => Number(cost?.amount) > 0) === true,
    fingerprint: String(quote.fingerprint ?? ""),
    quote,
    entries: [{ sourceItem, abilityFunction, baseRows: prepared.effectiveBaseRows }]
  });
}

/** Pay an explicit function-owned resource vector through the shared registry. */
export async function payAbilityFunctionResourceCosts({
  actor = null,
  sourceItem = null,
  abilityFunction = null,
  costRows: rows = [],
  expectedFingerprint = "",
  context = {}
} = {}) {
  if (!actor || !sourceItem || !abilityFunction) return failedPayment("invalidTriggerSource");
  const prepared = prepareAbilityFunctionResourceCostRows(actor, sourceItem, abilityFunction, rows);
  if (!prepared.rawBaseRows.length) {
    return successfulPayment({
      charged: false,
      entries: [{ sourceItem, abilityFunction, baseRows: prepared.effectiveBaseRows }]
    });
  }
  const registry = resourceCostRegistry;
  if (!registry?.execute) return failedPayment("costRegistryUnavailable");
  const execution = await registry.execute(actor, prepared.costRows, {
    ...createExecutionContext(context, { sourceItem, abilityFunction }),
    expectedFingerprint: String(expectedFingerprint ?? "")
  });
  if (!execution?.ok) return failedPayment(execution?.reason || "spendFailed", { execution });

  await applyTriggerCostOverloadSafely(
    actor,
    sourceItem,
    abilityFunction,
    prepared.effectiveBaseRows,
    context?.chainRef
  );
  return successfulPayment({
    charged: execution.quote?.costs?.some(cost => Number(cost?.amount) > 0) === true,
    execution,
    entries: [{ sourceItem, abilityFunction, baseRows: prepared.effectiveBaseRows }]
  });
}

/**
 * Pay every consumable ability function which contributes to this concrete
 * skill check. All rows are executed in one actor-locked vector so a later
 * unaffordable function cannot leave an earlier function partially spent.
 */
export async function paySkillCheckTriggerCosts({
  actor = null,
  skillKey = "",
  context = {}
} = {}) {
  if (!actor) return failedPayment("invalidTriggerSource");
  const entries = collectSkillCheckTriggerCostEntries({ actor, skillKey, context });
  if (!entries.length) return successfulPayment({ charged: false, entries: [] });

  const preparedEntries = entries.map(entry => ({
    ...entry,
    ...prepareAbilityFunctionResourceCostRows(
      actor,
      entry.sourceItem,
      entry.abilityFunction,
      entry.baseRows,
      entry.identity
    )
  }));
  const costRows = preparedEntries.flatMap(entry => entry.costRows);
  if (!costRows.length) return successfulPayment({ charged: false, entries: preparedEntries });

  const registry = resourceCostRegistry;
  if (!registry?.execute) return failedPayment("costRegistryUnavailable", { entries: preparedEntries });
  const execution = await registry.execute(actor, costRows, createExecutionContext(context, {
    entries: preparedEntries
  }));
  if (!execution?.ok) {
    return failedPayment(execution?.reason || "spendFailed", { execution, entries: preparedEntries });
  }

  for (const entry of preparedEntries) {
    await applyTriggerCostOverloadSafely(
      actor,
      entry.sourceItem,
      entry.abilityFunction,
      entry.effectiveBaseRows,
      context?.chainRef
    );
  }
  return successfulPayment({
    charged: execution.quote?.costs?.some(cost => Number(cost?.amount) > 0) === true,
    execution,
    entries: preparedEntries
  });
}

export function collectSkillCheckTriggerCostEntries({
  actor = null,
  skillKey = "",
  context = {}
} = {}) {
  const key = String(skillKey ?? "").trim();
  if (!actor || !key) return [];
  const acceptedChangeKeys = getSkillTriggerChangeKeys(key, context);
  const entries = [];
  const seenFunctions = new Set();

  for (const sourceItem of getActorItemsWithActiveHudModules(actor)) {
    for (const abilityFunction of getSourceEffectChangeFunctions(sourceItem)) {
      const identity = getFunctionIdentity(sourceItem, abilityFunction);
      if (!identity || seenFunctions.has(identity)) continue;
      if (!hasTriggerCostCondition(abilityFunction)) continue;
      if (isAbilityFunctionTimedTriggerCost(abilityFunction)) continue;
      if (hasExclusiveTriggerCondition(abilityFunction)) continue;
      if (!(abilityFunction.changes ?? []).some(change => {
        if (!acceptedChangeKeys.has(String(change?.key ?? "").trim())) return false;
        return isConsumableSkillChange(actor, change);
      })) continue;

      const remainingConditions = (abilityFunction.conditions ?? [])
        .filter(condition => condition?.type !== ABILITY_CONDITION_TYPES.triggerCost);
      if (!abilityConditionsApply(actor, remainingConditions, {
        ...context,
        abilityItemId: sourceItem.id ?? "",
        functionId: abilityFunction.id ?? "",
        allowContextual: true
      })) continue;

      seenFunctions.add(identity);
      entries.push({
        identity,
        sourceItem,
        abilityFunction,
        baseRows: getAbilityFunctionTriggerCostRows(abilityFunction)
      });
    }
  }
  collectAuraSkillTriggerCostEntries({
    actor,
    acceptedChangeKeys,
    entries,
    seenFunctions
  });
  return entries;
}

export function notifyAbilityTriggerCostFailure(result = {}) {
  if (result?.ok !== false) return;
  const reason = String(result?.reason ?? "spendFailed").trim() || "spendFailed";
  const suffix = reason.charAt(0).toUpperCase() + reason.slice(1);
  const key = `FALLOUTMAW.Ability.TriggerCost.CostErrors.${suffix}`;
  const localized = globalThis.game?.i18n?.localize?.(key);
  const fallbackKey = "FALLOUTMAW.Ability.TriggerCost.CostUnavailable";
  const fallback = globalThis.game?.i18n?.localize?.(fallbackKey);
  const baseMessage = localized && localized !== key
    ? localized
    : fallback && fallback !== fallbackKey
      ? fallback
      : "Trigger cost could not be spent.";
  const quote = result?.quote ?? result?.execution?.quote ?? null;
  const shortages = (quote?.costs ?? [])
    .filter(cost => Number(cost?.amount) > Number(cost?.available))
    .map(cost => `${String(cost?.label ?? cost?.resourceKey ?? "").trim()}: ${cost.amount} > ${cost.available}`)
    .filter(Boolean);
  globalThis.ui?.notifications?.warn?.(
    shortages.length ? `${baseMessage} ${shortages.join("; ")}` : baseMessage
  );
}

async function interceptSkillCheckTriggerCost({ event = null, control = null, scope = null } = {}) {
  if (control?.current || control?.remaining || control?.root) return undefined;
  const actorUuid = String(event?.source?.actorUuid ?? "").trim();
  const skillKey = String(event?.data?.skill?.key ?? event?.data?.skillKey ?? "").trim();
  if (!actorUuid || !skillKey) return cancelSkillCheckForTriggerCost("invalidTriggerSource");

  const [actor, actorToken, targetActor, targetToken] = await Promise.all([
    resolveUuid(actorUuid),
    resolveUuid(event?.source?.tokenUuid),
    resolveUuid(event?.target?.actorUuid),
    resolveUuid(event?.target?.tokenUuid)
  ]);
  if (!actor) return cancelSkillCheckForTriggerCost("invalidTriggerSource");
  const requesterUserId = String(event?.requesterUserId ?? "").trim();
  const requesterUser = game.users?.get?.(requesterUserId)
    ?? Array.from(game.users ?? []).find(user => String(user?.id ?? "") === requesterUserId)
    ?? null;
  if (!requesterUser || actor.testUserPermission?.(requesterUser, "OWNER") !== true) {
    return cancelSkillCheckForTriggerCost("invalidTriggerSource");
  }

  const request = event?.data?.request ?? {};
  let payment;
  try {
    payment = await paySkillCheckTriggerCosts({
      actor,
      skillKey,
      context: {
        actorToken: actorToken?.object ?? actorToken ?? null,
        targetToken: targetToken?.object ?? targetToken ?? null,
        targetActor: targetActor ?? targetToken?.actor ?? null,
        weaponData: request?.weaponData && typeof request.weaponData === "object"
          ? request.weaponData
          : null,
        requester: String(request?.requester ?? "").trim(),
        weaponActionKey: String(request?.weaponActionKey ?? "").trim(),
        rootId: event?.rootId ?? scope?.rootId ?? "",
        eventId: event?.eventId ?? scope?.eventId ?? "",
        occurrenceId: event?.occurrenceKey ?? "",
        chainRef: scope?.chainRef ?? null,
        inDamageHubOperation: Boolean(request?.damageHubOperationRef),
        damageHubOperation: request?.damageHubOperationRef ? "current" : null,
        logicalWorldTime: Number(event?.occurredAt?.worldTime) || null
      }
    });
  } catch (error) {
    console.error("fallout-maw | Skill trigger-cost interceptor failed.", error);
    return cancelSkillCheckForTriggerCost("spendFailed");
  }
  return payment.ok ? undefined : cancelSkillCheckForTriggerCost(payment.reason);
}

function getSourceEffectChangeFunctions(sourceItem = null) {
  const functions = sourceItem?.type === "ability"
    ? sourceItem.system?.functions ?? []
    : isActiveFreeSettingsGear(sourceItem)
      ? sourceItem.system?.functions?.freeSettings?.entries ?? []
      : [];
  return normalizeAbilityFunctions(functions)
    .filter(entry => entry?.type === ABILITY_FUNCTION_TYPES.effectChanges);
}

function isActiveFreeSettingsGear(item = null) {
  if (item?.type !== "gear" || !item.system?.functions?.freeSettings?.enabled) return false;
  return Boolean(item.system?.equipped)
    || ["equipment", "weapon", "constructPart"].includes(item.system?.placement?.mode);
}

function collectAuraSkillTriggerCostEntries({
  actor = null,
  acceptedChangeKeys = new Set(),
  entries = [],
  seenFunctions = new Set()
} = {}) {
  for (const effect of actor?.effects ?? []) {
    if (effect?.disabled || effect?.active === false) continue;
    const auraFlag = getAuraGeneratedEffectFlag(effect);
    const triggerCost = auraFlag?.triggerCost;
    if (!triggerCost || typeof triggerCost !== "object") continue;
    const sourceIdentity = String(triggerCost?.sourceIdentity ?? "").trim();
    if (!sourceIdentity) continue;
    const changes = Array.from(effect?.system?.changes ?? []);
    if (!changes.some(change => (
      acceptedChangeKeys.has(String(change?.key ?? "").trim())
      && isConsumableSkillChange(actor, change)
    ))) continue;

    const identity = `aura:${String(actor?.uuid ?? actor?.id ?? "")}:${String(
      auraFlag?.key ?? effect?.uuid ?? effect?.id ?? ""
    )}`;
    if (!identity || seenFunctions.has(identity)) continue;
    const sourceItem = {
      id: String(triggerCost?.sourceItemId ?? auraFlag?.itemId ?? ""),
      uuid: String(triggerCost?.sourceItemUuid ?? effect?.origin ?? ""),
      name: String(triggerCost?.sourceItemName ?? effect?.name ?? ""),
      img: String(triggerCost?.sourceItemImg ?? effect?.img ?? ""),
      flags: {
        [SYSTEM_ID]: {
          abilitySource: { id: `aura:${sourceIdentity}` }
        }
      },
      system: {}
    };
    const abilityFunction = {
      id: String(triggerCost?.functionId ?? auraFlag?.functionId ?? ""),
      type: ABILITY_FUNCTION_TYPES.effectChanges,
      changes,
      conditions: [{
        id: `aura-trigger-cost:${String(effect?.id ?? "")}`,
        groupId: "",
        type: ABILITY_CONDITION_TYPES.triggerCost,
        costs: Array.isArray(triggerCost?.costs)
          ? triggerCost.costs
          : Object.values(triggerCost?.costs ?? {})
      }]
    };
    seenFunctions.add(identity);
    entries.push({
      identity,
      sourceItem,
      abilityFunction,
      baseRows: getAbilityFunctionTriggerCostRows(abilityFunction)
    });
  }
}

function hasTriggerCostCondition(abilityFunction = {}) {
  return (abilityFunction.conditions ?? [])
    .some(condition => condition?.type === ABILITY_CONDITION_TYPES.triggerCost);
}

function hasExclusiveTriggerCondition(abilityFunction = {}) {
  return (abilityFunction.conditions ?? [])
    .some(condition => EXCLUSIVE_TRIGGER_TYPES.has(condition?.type));
}

function getSkillTriggerChangeKeys(skillKey = "", context = {}) {
  const keys = new Set();
  for (const suffix of SKILL_CHANGE_SUFFIXES) {
    keys.add(`system.skills.${skillKey}.${suffix}`);
    keys.add(`system.skills.all.${suffix}`);
  }
  const actionKey = String(context?.weaponActionKey ?? "").trim();
  if (String(context?.requester ?? "") === "weaponAttack" && isAttackingWeaponAction(actionKey)) {
    keys.add("system.combat.all.advantage");
    keys.add("system.combat.all.disadvantage");
    keys.add(`system.combat.actions.${actionKey}.advantage`);
    keys.add(`system.combat.actions.${actionKey}.disadvantage`);
  }
  return keys;
}

function isConsumableSkillChange(actor, change = {}) {
  if (String(change?.value ?? "") === "") return false;
  const amount = evaluateEffectChangeNumber(actor, change.value, { fallback: Number.NaN });
  if (!Number.isFinite(amount)) return false;
  switch (String(change?.type ?? "add")) {
    case "multiply": return amount !== 1;
    case "override":
    case "upgrade":
    case "downgrade": return true;
    default: return amount !== 0;
  }
}

function getFunctionIdentity(sourceItem = null, abilityFunction = null) {
  const itemIdentity = String(
    sourceItem?.uuid
    ?? `${sourceItem?.parent?.uuid ?? sourceItem?.actor?.uuid ?? ""}.Item.${sourceItem?.id ?? ""}`
  ).trim();
  const functionId = String(abilityFunction?.id ?? "").trim();
  return itemIdentity && functionId ? `${itemIdentity}:${functionId}` : "";
}

function prepareAbilityFunctionResourceCostRows(
  actor,
  sourceItem,
  abilityFunction,
  rows = [],
  identity = getFunctionIdentity(sourceItem, abilityFunction)
) {
  const rawBaseRows = (Array.isArray(rows) ? rows : Object.values(rows ?? {})).map(row => ({ ...row }));
  // Keep combat-only rows until the registry quotes under its actor lock.
  // The Foundry adapter turns them into zero-cost rows outside combat. Filtering
  // here would let an actor enter combat while queued and commit an obsolete free vector.
  const effectiveBaseRows = rawBaseRows.map(row => ({ ...row }));
  const overloadedRows = withAbilityOverloadCostRows(
    actor,
    sourceItem,
    abilityFunction,
    effectiveBaseRows
  );
  const costRows = namespaceCostRows(
    overloadedRows,
    identity
  );
  return { rawBaseRows, effectiveBaseRows, costRows };
}

function namespaceCostRows(rows = [], identity = "") {
  return (rows ?? []).map((row, index) => ({
    ...row,
    id: `${identity || "ability-function"}:${String(row?.id ?? index)}`
  }));
}

function createExecutionContext(context = {}, {
  sourceItem = null,
  abilityFunction = null,
  entries = []
} = {}) {
  const onlyEntry = entries.length === 1 ? entries[0] : null;
  const resolvedSourceItem = sourceItem ?? onlyEntry?.sourceItem ?? null;
  const resolvedFunction = abilityFunction ?? onlyEntry?.abilityFunction ?? null;
  return {
    ...context,
    rootId: String(context?.rootId ?? "").trim(),
    eventId: String(context?.eventId ?? context?.occurrenceId ?? "").trim(),
    sourceItemUuid: String(resolvedSourceItem?.uuid ?? "").trim(),
    functionId: String(resolvedFunction?.id ?? (entries.length > 1 ? "multiple" : "")).trim(),
    actorLockScope: String(
      context?.actorLockScope
      ?? context?.rootId
      ?? context?.occurrenceId
      ?? ""
    ).trim()
  };
}

function successfulPayment(details = {}) {
  return { ok: true, reason: "", ...details };
}

function failedPayment(reason = "spendFailed", details = {}) {
  return { ok: false, reason: String(reason ?? "spendFailed"), ...details };
}

async function applyTriggerCostOverloadSafely(actor, sourceItem, abilityFunction, baseRows, chainRef) {
  try {
    return await applyAbilityFunctionOverloadCosts(actor, sourceItem, abilityFunction, {
      costs: baseRows,
      chainRef: chainRef ?? null
    });
  } catch (error) {
    // The resource vector is already committed. A secondary overload effect
    // must not cancel the paid action or make the same trigger payable twice.
    console.error("fallout-maw | Trigger-cost overload application failed.", error);
    return 0;
  }
}

function cancelSkillCheckForTriggerCost(reason = "spendFailed") {
  return {
    cancel: {
      scope: "current",
      reason: `triggerCost:${String(reason ?? "spendFailed")}`
    }
  };
}

async function resolveUuid(uuid = "") {
  const value = String(uuid ?? "").trim();
  if (!value || typeof globalThis.fromUuid !== "function") return null;
  try {
    return await globalThis.fromUuid(value);
  } catch (_error) {
    return null;
  }
}
