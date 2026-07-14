import { evaluateFormula } from "../formulas/evaluation.mjs";
import { getResourceSettings } from "../settings/accessors.mjs";
import { buildActorFormulaData } from "../utils/actor-formulas.mjs";
import { getActorAvailableEnergy } from "../combat/energy-resource.mjs";
import {
  applyDamageRequestsInCurrentHubOperation,
  requestDamageApplication
} from "../combat/damage-hub.mjs";
import {
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
  logger = console
} = {}) {
  const ordinaryAdapter = createActorResourceAdapter();
  const healthAdapter = createActorResourceAdapter();
  const powerAdapter = createPowerResourceAdapter();
  const reactionAdapter = createActorResourceAdapter();

  return createResourceCostRegistry({
    getResourceDefinitions: () => buildReactionResourceDefinitions(resourceSettings),
    evaluateFormula: evaluateCostFormula ?? ((formula, actor) => (
      evaluateFormula(formula, buildActorFormulaData(actor))
    )),
    adapters: {
      [HEALTH_RESOURCE_KEY]: healthAdapter,
      [POWER_RESOURCE_KEY]: powerAdapter,
      [REACTION_POINTS_RESOURCE_KEY]: reactionAdapter
    },
    defaultAdapter: ordinaryAdapter,
    spendVector: (actor, costs, context) => spendFoundryReactionCostVector(actor, costs, {
      ...context,
      applyHealthCost
    }),
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
  return definitions;
}

export async function spendFoundryReactionCostVector(actor, costs = [], context = {}) {
  return spendActorResourceCostVector(actor, costs, {
    context,
    updateOptions: { chainRef: context.chainRef },
    spendHealth: spendHealthCost
  });
}

async function spendHealthCost(actor, amount, context = {}) {
  const request = {
    actorUuid: actor.uuid,
    amount,
    mode: "damage",
    scope: "health",
    applyMitigation: false,
    processDamageTypeSettings: false,
    source: {
      kind: "eventReactionCost",
      unmitigated: true,
      rootId: String(context.rootId ?? ""),
      eventId: String(context.eventId ?? ""),
      sourceItemUuid: String(context.sourceItemUuid ?? ""),
      functionId: String(context.functionId ?? ""),
      chainRef: context.chainRef
    }
  };
  if (typeof context.applyHealthCost === "function") {
    return context.applyHealthCost(request, context);
  }
  return applyReactionHealthCost(request, context, {
    applyInCurrentOperation: applyDamageRequestsInCurrentHubOperation,
    requestApplication: requestDamageApplication
  });
}

function createActorResourceAdapter() {
  return {
    getAvailable(actor, definition) {
      const resource = actor?.system?.resources?.[definition?.key];
      if (!resource) throw new Error(`Missing resource '${definition?.key ?? ""}'.`);
      return Math.max(0, Math.trunc(Number(resource.value) || 0) - Math.trunc(Number(resource.min) || 0));
    },
    async spend() {
      // The Foundry integration spends ordinary resources in one Actor update via spendVector.
    }
  };
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

function localizeReactionPoints() {
  const key = "FALLOUTMAW.EventReaction.Resource.ReactionPoints";
  const localized = globalThis.game?.i18n?.localize?.(key);
  return localized && localized !== key ? localized : "Reaction Points";
}
