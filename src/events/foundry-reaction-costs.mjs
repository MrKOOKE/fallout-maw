import { evaluateFormula } from "../formulas/evaluation.mjs";
import { getResourceSettings } from "../settings/accessors.mjs";
import { buildActorFormulaData } from "../utils/actor-formulas.mjs";
import { getActorAvailableEnergy } from "../combat/energy-resource.mjs";
import {
  COMBAT_ONLY_RESOURCE_KEYS,
  isCombatOnlyResourceKey,
  isCombatResourceCostActive
} from "../combat/resource-cost-policy.mjs";
import { notifyCombatResourcesSpent } from "../combat/resource-spending.mjs";
import { getActorResourceLimitAmount } from "../combat/resource-limits.mjs";
import {
  ACTION_RESOURCE_KEY,
  getStrictActionPointState
} from "../combat/strict-action-points.mjs";
import {
  getCombatActionPointState,
  refundCombatActionPointReceipt,
  spendCombatActionPointsWithReceipt
} from "../combat/reaction-resources.mjs";
import {
  applyDamageRequestsInCurrentHubOperation,
  requestDamageApplication,
  restoreActorHealthCost
} from "../combat/damage-hub.mjs";
import {
  ACTION_OR_REACTION_POINTS_RESOURCE_KEY,
  HEALTH_RESOURCE_KEY,
  POWER_RESOURCE_KEY,
  REACTION_POINTS_RESOURCE_KEY,
  applyReactionHealthCost,
  spendActorResourceCostVector,
  createResourceCostRegistry
} from "./reaction-costs.mjs";

export function createFoundryReactionCostRegistry({
  resourceSettings = null,
  evaluateCostFormula = null,
  applyHealthCost = null,
  restoreHealthCost = restoreActorHealthCost,
  notifyResourceSpend = notifyCombatResourcesSpent,
  logger = console
} = {}) {
  const ordinaryAdapter = createActorResourceAdapter();
  const healthAdapter = createActorResourceAdapter();
  const powerAdapter = createPowerResourceAdapter();
  const reactionAdapter = createActorResourceAdapter();
  const actionPointAdapter = createStrictActionPointAdapter();
  const actionOrReactionPointAdapter = createActionOrReactionPointAdapter();
  const formulaEvaluator = evaluateCostFormula ?? ((formula, actor) => (
    evaluateFormula(formula, buildActorFormulaData(actor))
  ));

  return createResourceCostRegistry({
    getResourceDefinitions: () => buildReactionResourceDefinitions(resourceSettings),
    evaluateFormula: (formula, actor, context) => {
      // ОД, ОР, ОП and dodge are combat-only. A running combat elsewhere
      // must not make an unrelated actor pay any of them.
      if (!isCombatResourceCostActive(actor, context?.resourceKey)) return 0;
      return formulaEvaluator(formula, actor, context);
    },
    adapters: {
      [HEALTH_RESOURCE_KEY]: healthAdapter,
      [POWER_RESOURCE_KEY]: powerAdapter,
      [REACTION_POINTS_RESOURCE_KEY]: reactionAdapter,
      [ACTION_RESOURCE_KEY]: actionPointAdapter,
      [ACTION_OR_REACTION_POINTS_RESOURCE_KEY]: actionOrReactionPointAdapter
    },
    defaultAdapter: ordinaryAdapter,
    spendVector: (actor, costs, context) => spendFoundryReactionCostVector(actor, costs, {
      ...context,
      applyHealthCost,
      restoreHealthCost
    }),
    afterCommit: (actor, quote, context) => notifyFoundryCombatResourceCosts(
      actor,
      quote?.costs,
      context,
      notifyResourceSpend
    ),
    logger
  });
}

export function buildReactionResourceDefinitions(resourceSettings = null) {
  const settings = Array.isArray(resourceSettings) ? resourceSettings : getResourceSettings();
  const definitions = settings.map(entry => ({
    key: String(entry?.key ?? "").trim(),
    label: String(entry?.label ?? entry?.key ?? "").trim()
  })).filter(entry => entry.key);
  if (!definitions.some(entry => entry.key === REACTION_POINTS_RESOURCE_KEY)) {
    definitions.push({ key: REACTION_POINTS_RESOURCE_KEY, label: localizeReactionPoints() });
  }
  if (!definitions.some(entry => entry.key === ACTION_OR_REACTION_POINTS_RESOURCE_KEY)) {
    definitions.push({ key: ACTION_OR_REACTION_POINTS_RESOURCE_KEY, label: "ОД/ОР" });
  }
  return definitions;
}

export async function spendFoundryReactionCostVector(actor, costs = [], context = {}) {
  const staleCombatCost = (costs ?? []).find(cost => (
    isCombatOnlyResourceKey(cost?.resourceKey)
    && Number(cost?.amount) > 0
    && !isCombatResourceCostActive(actor, cost?.resourceKey)
  ));
  if (staleCombatCost) {
    const error = new Error(`Combat resource '${staleCombatCost.resourceKey}' is no longer active for this actor.`);
    error.reason = "staleQuote";
    throw error;
  }
  const dynamicCost = (costs ?? []).find(cost => (
    cost?.resourceKey === ACTION_OR_REACTION_POINTS_RESOURCE_KEY
  ));
  const dynamicAmount = Math.max(0, Math.trunc(Number(dynamicCost?.amount) || 0));
  const ordinaryCosts = (costs ?? []).filter(cost => (
    cost?.resourceKey !== ACTION_OR_REACTION_POINTS_RESOURCE_KEY
  ));
  let combatActionPointReceipt = null;
  if (dynamicAmount > 0) {
    const transaction = await spendCombatActionPointsWithReceipt(actor, dynamicAmount, {
      suppressResourceNotification: true,
      chainRef: context.chainRef
    });
    if (transaction.spent !== dynamicAmount || !transaction.receipt) {
      const error = new Error(`Dynamic combat-point cost was not applied exactly (${transaction.spent} != ${dynamicAmount}).`);
      error.reason = "spendFailed";
      throw error;
    }
    combatActionPointReceipt = transaction.receipt;
  }

  try {
    const receipt = await spendActorResourceCostVector(actor, ordinaryCosts, {
      context,
      updateOptions: { chainRef: context.chainRef },
      spendHealth: spendHealthCost,
      restoreHealth: (targetActor, amount, rollbackContext = {}) => (
        typeof rollbackContext.restoreHealthCost === "function"
          ? rollbackContext.restoreHealthCost(targetActor, amount, rollbackContext)
          : restoreActorHealthCost(targetActor, amount, rollbackContext)
      ),
      afterSpend: context.afterVectorSpend
    });
    return {
      ...receipt,
      costs: [
        ...(receipt?.costs ?? []),
        ...(dynamicAmount > 0 ? [{
          resourceKey: ACTION_OR_REACTION_POINTS_RESOURCE_KEY,
          amount: dynamicAmount
        }] : [])
      ],
      combatActionPointReceipt
    };
  } catch (error) {
    if (combatActionPointReceipt) {
      try {
        await refundCombatActionPointReceipt(actor, combatActionPointReceipt, {
          suppressResourceNotification: true,
          chainRef: context.chainRef
        });
      } catch (rollbackError) {
        error.rollbackError ??= rollbackError;
      }
    }
    throw error;
  }
}

async function spendHealthCost(actor, amount, context = {}) {
  const request = {
    actorUuid: actor.uuid,
    amount,
    mode: "damage",
    scope: "health",
    applyMitigation: false,
    processDamageTypeSettings: false,
    bypassBarrier: true,
    source: {
      kind: "abilityTriggerCost",
      unmitigated: true,
      rootId: String(context.rootId ?? ""),
      eventId: String(context.eventId ?? ""),
      sourceItemUuid: String(context.sourceItemUuid ?? ""),
      functionId: String(context.functionId ?? ""),
      chainRef: context.chainRef
    }
  };
  const result = typeof context.applyHealthCost === "function"
    ? await context.applyHealthCost(request, context)
    : await applyReactionHealthCost(request, context, {
      applyInCurrentOperation: applyDamageRequestsInCurrentHubOperation,
      requestApplication: requestDamageApplication
    });
  const applied = getAppliedHealthCost(result, actor?.uuid);
  if (applied !== amount) {
    const error = new Error(`Health cost was not applied exactly (${applied} != ${amount}).`);
    if (applied > 0) {
      try {
        const rollback = typeof context.restoreHealthCost === "function"
          ? await context.restoreHealthCost(actor, applied, context)
          : await restoreActorHealthCost(actor, applied, context);
        const restored = Math.max(0, Math.trunc(Number(rollback?.healthDelta) || 0));
        if (restored !== applied) {
          error.rollbackError = new Error(`Health-cost rollback was incomplete (${restored} != ${applied}).`);
        }
      } catch (rollbackError) {
        error.rollbackError = rollbackError;
      }
    }
    throw error;
  }
  return { amount, applied, result };
}

function getAppliedHealthCost(result, actorUuid = "") {
  return [result].flat(Infinity).filter(Boolean)
    .filter(entry => {
      if (!actorUuid) return true;
      const entryActorUuid = String(entry?.actor?.uuid ?? entry?.actorUuid ?? "");
      return entryActorUuid === String(actorUuid);
    })
    .reduce((total, entry) => {
      const resourceDelta = Math.max(0, Math.trunc(Number(entry?.resourceHealthDelta) || 0));
      const healthDelta = Math.max(0, Math.trunc(Number(entry?.healthDelta) || 0));
      return total + (Object.hasOwn(entry, "resourceHealthDelta") ? resourceDelta : healthDelta);
    }, 0);
}

function createActorResourceAdapter() {
  return {
    getAvailable(actor, definition) {
      if (!isCombatResourceCostActive(actor, definition?.key)) return 0;
      const resource = actor?.system?.resources?.[definition?.key];
      if (!resource) throw new Error(`Missing resource '${definition?.key ?? ""}'.`);
      return Math.max(
        0,
        Math.trunc(Number(resource.value) || 0)
          - Math.trunc(Number(resource.min) || 0)
          - getActorResourceLimitAmount(actor, definition.key)
      );
    },
    async spend() {
      // The Foundry integration spends ordinary resources in one Actor update via spendVector.
    }
  };
}

function notifyFoundryCombatResourceCosts(actor, costs = [], context = {}, notifyResourceSpend = null) {
  if (typeof notifyResourceSpend !== "function") return [];
  const resources = Object.fromEntries(COMBAT_ONLY_RESOURCE_KEYS
    .filter(resourceKey => resourceKey !== ACTION_OR_REACTION_POINTS_RESOURCE_KEY)
    .map(resourceKey => [
      resourceKey,
      Math.max(0, Math.trunc(Number(
        (costs ?? []).find(cost => cost?.resourceKey === resourceKey)?.amount
      ) || 0))
    ])
    .filter(([, amount]) => amount > 0));
  const dynamicAmount = Math.max(0, Math.trunc(Number(
    (costs ?? []).find(cost => cost?.resourceKey === ACTION_OR_REACTION_POINTS_RESOURCE_KEY)?.amount
  ) || 0));
  const paidResourceKey = String(context?.spendReceipt?.combatActionPointReceipt?.resourceKey ?? "").trim();
  if (dynamicAmount > 0 && paidResourceKey) {
    resources[paidResourceKey] = (resources[paidResourceKey] ?? 0) + dynamicAmount;
  }
  if (!Object.keys(resources).length) return [];
  return notifyResourceSpend(actor, resources, context);
}

function createPowerResourceAdapter() {
  return {
    getAvailable(actor) {
      const resource = actor?.system?.resources?.[POWER_RESOURCE_KEY];
      if (!resource) throw new Error(`Missing resource '${POWER_RESOURCE_KEY}'.`);
      return Math.max(0, getActorAvailableEnergy(actor) - Math.trunc(Number(resource.min) || 0));
    },
    async spend() {
      // The Foundry integration spends power together with other ordinary resources.
    }
  };
}

function createStrictActionPointAdapter() {
  return {
    getAvailable(actor) {
      if (!isCombatResourceCostActive(actor, ACTION_RESOURCE_KEY)) return 0;
      const state = getStrictActionPointState(actor);
      if (!state) throw new Error(`Missing resource '${ACTION_RESOURCE_KEY}'.`);
      return state.value;
    },
    async spend() {
      // The Foundry integration commits strict ОД together with the other
      // ordinary actor resources in spendFoundryReactionCostVector.
    }
  };
}

function createActionOrReactionPointAdapter() {
  return {
    getAvailable(actor) {
      if (!isCombatResourceCostActive(actor, ACTION_OR_REACTION_POINTS_RESOURCE_KEY)) return 0;
      const state = getCombatActionPointState(actor);
      if (!state) throw new Error(`Missing dynamic combat-point resource '${ACTION_OR_REACTION_POINTS_RESOURCE_KEY}'.`);
      return state.value;
    },
    async spend() {
      // The Foundry vector adapter commits the dynamic resource atomically
      // with the remaining ability costs and retains a refundable receipt.
    }
  };
}

function localizeReactionPoints() {
  const key = "FALLOUTMAW.EventReaction.Resource.ReactionPoints";
  const localized = globalThis.game?.i18n?.localize?.(key);
  return localized && localized !== key ? localized : "Reaction Points";
}
