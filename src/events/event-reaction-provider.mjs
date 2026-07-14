import {
  collectActiveSceneReactorActors,
  collectEventReactionCandidates,
  eventReactionFunctionMatches,
  findEventReactionFunction,
  getActorEventReactionSourceItems
} from "./event-reaction-scanner.mjs";
import { eventReactionIndexHasKey } from "./event-reaction-index.mjs";
import {
  applyAbilityFunctionOverloadCosts,
  withAbilityOverloadEnergyCostRows
} from "../abilities/overload.mjs";
import { ENERGY_RESOURCE_KEY } from "../combat/energy-resource.mjs";
import { getAbilityFunctionEffectDurationSeconds } from "../settings/abilities.mjs";

export const GENERIC_EVENT_REACTION_PROVIDER_ID = "fallout-maw.genericEventReaction";
const REACTION_SUCCESS = "success";
const REACTION_FAILED = "failed";

export function createGenericEventReactionProvider({
  id = GENERIC_EVENT_REACTION_PROVIDER_ID,
  getReactorActors = () => collectActiveSceneReactorActors(),
  resolveUuid = uuid => globalThis.fromUuid?.(uuid) ?? null,
  getItems = undefined,
  normalizeFunctions = undefined,
  conditionEvaluator = undefined,
  canOfferToActor = defaultCanOfferToActor,
  costRegistry,
  effectManager,
  registerRootCleanup = null,
  canReactToEvent = () => true,
  hasEventKey = eventReactionIndexHasKey,
  warn = undefined,
  logger = console
} = {}) {
  if (!costRegistry?.quote || !costRegistry?.execute || !costRegistry?.withActorLock) {
    throw new Error("Generic Event Reaction provider requires a resource cost registry.");
  }
  if (!effectManager?.apply || !effectManager?.cleanupRoot) {
    throw new Error("Generic Event Reaction provider requires an effect manager.");
  }
  const consumedChances = new Set();
  const registeredRootCleanups = new Set();
  const itemLookupOptions = getItems ? { getItems } : {};
  const functionLookupOptions = normalizeFunctions ? { normalizeFunctions } : {};

  function resolveOfferSource(actor, sourceItemUuid = "") {
    const uuid = String(sourceItemUuid ?? "").trim();
    return getActorEventReactionSourceItems(actor, itemLookupOptions)
      .find(item => String(item?.uuid ?? "") === uuid)
      ?? null;
  }

  async function collect({ eventKey = "", context = {}, semanticEvent = null } = {}) {
    const envelope = getReactionEnvelope(eventKey, { ...context, semanticEvent: semanticEvent ?? context?.semanticEvent });
    if (!envelope.key || !envelope.rootId || !canReactToEvent(envelope)) return [];
    if (!(await hasEventKey(envelope.key))) return [];
    const reactors = await getReactorActors(envelope);
    const candidates = await collectEventReactionCandidates({
      envelope,
      reactors,
      resolveUuid,
      ...itemLookupOptions,
      ...functionLookupOptions,
      ...(conditionEvaluator ? { conditionEvaluator } : {}),
      warn
    });
    const offers = [];
    for (const candidate of candidates) {
      if (consumedChances.has(candidate.chanceKey)) {
        continue;
      }
      const actor = await safeResolve(candidate.actorUuid, resolveUuid);
      if (!actor || !canOfferToActor(actor, envelope)) continue;
      const sourceItem = resolveOfferSource(actor, candidate.sourceItemUuid);
      const abilityFunction = sourceItem
        ? findEventReactionFunction(sourceItem, candidate.functionId, functionLookupOptions)
        : null;
      const baseRows = candidate.reactionSettings?.costs ?? [];
      const quoteContext = {
        rootId: candidate.rootId,
        eventId: candidate.eventId,
        sourceItemUuid: candidate.sourceItemUuid,
        functionId: candidate.functionId,
        chainRef: context?.chainRef
      };
      const baseQuote = await costRegistry.quote(actor, baseRows, quoteContext);
      if (!baseQuote.valid || !baseQuote.affordable) continue;
      const costRows = withAbilityOverloadEnergyCostRows(
        actor,
        sourceItem,
        abilityFunction ?? { id: candidate.functionId },
        baseRows
      );
      const quote = await costRegistry.quote(actor, costRows, quoteContext);
      if (!quote.valid || !quote.affordable) continue;
      consumedChances.add(candidate.chanceKey);
      ensureRootCleanup(candidate.rootId);
      offers.push({
        ...candidate,
        energyCost: 0,
        costFingerprint: quote.fingerprint,
        costLines: buildEventReactionCostLines(baseQuote, quote),
        eventReaction: {
          rootId: candidate.rootId,
          eventId: candidate.eventId,
          sourceItemUuid: candidate.sourceItemUuid,
          functionId: candidate.functionId,
          chanceKey: candidate.chanceKey,
          costFingerprint: quote.fingerprint
        }
      });
    }
    return offers;
  }

  async function execute({ eventKey = "", context = {}, semanticEvent = null, offer = {} } = {}) {
    const envelope = getReactionEnvelope(eventKey, { ...context, semanticEvent: semanticEvent ?? context?.semanticEvent });
    const actor = await safeResolve(offer.actorUuid, resolveUuid);
    if (!actor || !canOfferToActor(actor, envelope) || !canReactToEvent(envelope)) return failedResult("invalidReactor");
    return costRegistry.withActorLock(actor, async actorLockToken => {
      const sourceItem = resolveOfferSource(actor, offer.sourceItemUuid);
      if (!sourceItem) {
        return failedResult("invalidSourceItem");
      }
      const abilityFunction = findEventReactionFunction(sourceItem, offer.functionId, functionLookupOptions);
      if (!abilityFunction) return failedResult("invalidFunction");
      const matches = await eventReactionFunctionMatches({
        reactor: actor,
        item: sourceItem,
        abilityFunction,
        envelope,
        resolveUuid,
        ...(conditionEvaluator ? { conditionEvaluator } : {}),
        warn
      });
      if (!matches) return failedResult("conditionsChanged");

      const baseRows = abilityFunction.reactionSettings?.costs ?? [];
      const costRows = withAbilityOverloadEnergyCostRows(
        actor,
        sourceItem,
        abilityFunction,
        baseRows
      );
      const execution = await costRegistry.execute(actor, costRows, {
        expectedFingerprint: String(offer.costFingerprint ?? offer.eventReaction?.costFingerprint ?? ""),
        actorLockToken,
        rootId: envelope.rootId,
        eventId: envelope.eventId,
        sourceItemUuid: sourceItem.uuid,
        functionId: abilityFunction.id,
        chainRef: context?.chainRef,
        inDamageHubOperation: Boolean(context?.inDamageHubOperation),
        damageHubOperation: context?.damageHubOperation,
        logicalWorldTime: context?.logicalWorldTime,
        afterSpend: async (_quote, executionContext) => {
          const effect = await effectManager.apply({
            actor,
            sourceItem,
            abilityFunction,
            envelope,
            chainRef: context?.chainRef
          });
          await applyAbilityFunctionOverloadCosts(actor, sourceItem, abilityFunction, {
            chainRef: context?.chainRef
          });
          if (getAbilityFunctionEffectDurationSeconds(abilityFunction) === 0) ensureRootCleanup(envelope.rootId);
          return { effect, executionContext };
        }
      });
      if (!execution.ok) return failedResult(execution.reason);
      return {
        handled: true,
        status: REACTION_SUCCESS,
        cancelCurrent: false,
        cancelRemaining: false,
        difficultyBonus: 0,
        reason: "eventReactionApplied"
      };
    }, null, envelope.rootId);
  }

  async function cleanupRoot(rootId = "") {
    const normalized = String(rootId ?? "").trim();
    if (!normalized) return 0;
    for (const chance of Array.from(consumedChances)) {
      // Root-scoped keys start with rootId|; attack-scoped keys keep until session end (ids are unique).
      if (chance.startsWith(`${normalized}|`)) consumedChances.delete(chance);
    }
    registeredRootCleanups.delete(normalized);
    return effectManager.cleanupRoot(normalized);
  }

  function ensureRootCleanup(rootId) {
    const normalized = String(rootId ?? "").trim();
    if (!normalized || registeredRootCleanups.has(normalized) || typeof registerRootCleanup !== "function") return;
    registeredRootCleanups.add(normalized);
    registerRootCleanup(normalized, () => cleanupRoot(normalized));
  }

  return Object.freeze({
    id: String(id ?? GENERIC_EVENT_REACTION_PROVIDER_ID),
    collect,
    execute,
    cleanupRoot,
    cleanupOrphans: activeRootIds => effectManager.cleanupOrphans(activeRootIds),
    hasConsumedChance: chanceKey => consumedChances.has(String(chanceKey ?? ""))
  });
}

export function getReactionEnvelope(eventKey = "", context = {}) {
  const source = context?.envelope
    ?? context?.semanticEvent
    ?? context?.eventEnvelope
    ?? context?.event
    ?? context;
  return {
    ...(source && typeof source === "object" ? source : {}),
    key: String(source?.key ?? eventKey ?? "").trim(),
    rootId: String(source?.rootId ?? context?.rootId ?? source?.eventId ?? "").trim(),
    eventId: String(source?.eventId ?? context?.eventId ?? "").trim()
  };
}

function failedResult(reason) {
  return {
    handled: false,
    status: REACTION_FAILED,
    cancelCurrent: false,
    cancelRemaining: false,
    difficultyBonus: 0,
    reason: String(reason ?? "eventReactionFailed")
  };
}

/** Same display pattern as fixed-function reactions: "Энергия: X базовая / Y итоговая". */
export function buildEventReactionCostLines(baseQuote = {}, totalQuote = {}) {
  const baseByKey = new Map((baseQuote?.costs ?? []).map(cost => [
    String(cost?.resourceKey ?? ""),
    cost
  ]));
  return (totalQuote?.costs ?? [])
    .filter(cost => Math.max(0, Math.trunc(Number(cost?.amount) || 0)) > 0)
    .map(cost => {
      const resourceKey = String(cost?.resourceKey ?? "");
      const label = String(cost?.label ?? resourceKey);
      const totalAmount = Math.max(0, Math.trunc(Number(cost?.amount) || 0));
      const baseAmount = Math.max(0, Math.trunc(Number(baseByKey.get(resourceKey)?.amount) || 0));
      if (resourceKey === ENERGY_RESOURCE_KEY || baseAmount !== totalAmount) {
        return `${label}: ${baseAmount} базовая / ${totalAmount} итоговая`;
      }
      return `${label}: ${totalAmount}`;
    });
}

async function safeResolve(uuid, resolveUuid) {
  const normalized = String(uuid ?? "").trim();
  if (!normalized) return null;
  try {
    return await resolveUuid(normalized);
  } catch (error) {
    return null;
  }
}

function defaultCanOfferToActor(actor) {
  if (!actor) return false;
  const defeated = globalThis.CONFIG?.specialStatusEffects?.DEFEATED;
  return !["dead", "unconscious", "stunned", defeated]
    .filter(Boolean)
    .some(status => actor.statuses?.has?.(status));
}
