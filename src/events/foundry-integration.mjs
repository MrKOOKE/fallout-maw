import { SYSTEM_ID } from "../constants.mjs";
import {
  registerReactionEventSemanticAdapter,
  registerReactionExecutionGuard,
  registerReactionProvider,
  requestReactionEvent
} from "../combat/reaction-hub.mjs";
import {
  SYSTEM_EVENT_CATALOG,
  SYSTEM_EVENT_GROUPS,
  SYSTEM_EVENT_PHASES,
  SYSTEM_EVENT_ROLES,
  SYSTEM_EVENT_SUBJECTS,
  getSystemEventDescriptor
} from "./catalog.mjs";
import {
  getSelectableSystemEvents,
  registerSystemEventInterceptor,
  registerSystemEventObserver,
  registerSystemEventRootFinalizer,
  withSystemEventRoot
} from "./dispatcher.mjs";
import { createFoundryEventReactionRuntime } from "./foundry-event-reactions.mjs";
import { serializeLegacyReactionContext } from "./legacy-reaction-context.mjs";
import {
  eventReactionIndexHasKey,
  registerEventReactionSubscriptionIndexHooks
} from "./event-reaction-index.mjs";
import {
  collectAbilityWeaponAttackOptions,
  executeAbilityWeaponAttackOption,
  pickRandomAbilityFreeAttackTarget,
  registerAbilityActionQueries,
  resolveAbilityActionTriggerTarget,
  selectAbilityWeaponAttackOption
} from "../abilities/ability-actions.mjs";

const LEGACY_REACTION_EVENT_MAP = Object.freeze({
  weaponAttackTargeted: "fallout-maw.weapon.attack.targeted",
  weaponAttackCommitted: "fallout-maw.weapon.attack.committed",
  aimedAttackLimbSelected: "fallout-maw.weapon.attack.aimedLimbSelected",
  weaponAttackResolved: "fallout-maw.weapon.attack.resolved",
  tokenLeavingAdjacency: "fallout-maw.movement.token.leavingAdjacency",
  oversightThreshold: "fallout-maw.combat.resource.spent"
});

const managedReactionResults = new Map();
const reactionBudgetConsumers = new Map();
let eventRuntime = null;
let registered = false;
let activeGmId = "";

/** Register the generic Event Reaction provider and the semantic compatibility bridge. */
export function registerFoundrySystemEventIntegration() {
  if (registered) return eventRuntime;
  registered = true;
  registerAbilityActionQueries();

  eventRuntime = createFoundryEventReactionRuntime({
    registerRootFinalizer: registerSystemEventRootFinalizer,
    canReactToEvent: envelope => envelope?.data?.suppressGenericEventReactions !== true,
    actionRuntime: {
      collectOptions: collectAbilityWeaponAttackOptions,
      selectOption: selectAbilityWeaponAttackOption,
      execute: executeAbilityWeaponAttackOption,
      resolveTriggerTarget: resolveAbilityActionTriggerTarget,
      pickRandomFreeTarget: pickRandomAbilityFreeAttackTarget
    },
    warn: warning => console.warn(`${SYSTEM_ID} | Event Reaction condition ignored`, warning)
  });
  registerReactionProvider(eventRuntime.provider);
  registerReactionExecutionGuard(consumeReactionExecutionBudget);
  registerReactionEventSemanticAdapter(adaptLegacyReactionEvent);
  registerEventReactionSubscriptionIndexHooks();
  registerSystemEventInterceptor({
    id: "fallout-maw.eventReaction.hub",
    eventKeys: ["*"],
    priority: 100,
    guardRecursion: false,
    intercept: interceptEventReactions
  });
  return eventRuntime;
}

/** Publish the intentionally dispatch-free public event API. */
export function publishFoundrySystemEventApi() {
  const api = Object.freeze({
    catalogVersion: 1,
    catalog: createPublicCatalogSnapshot(SYSTEM_EVENT_CATALOG),
    groups: createPublicRegistrySnapshot(SYSTEM_EVENT_GROUPS),
    phases: createPublicRegistrySnapshot(SYSTEM_EVENT_PHASES),
    roles: createPublicRegistrySnapshot(SYSTEM_EVENT_ROLES),
    subjects: createPublicRegistrySnapshot(SYSTEM_EVENT_SUBJECTS),
    getSelectable: () => createPublicCatalogSnapshot(getSelectableSystemEvents()),
    registerObserver: registration => registerSystemEventObserver(registration),
    registerInterceptor: registration => registerSystemEventInterceptor(registration)
  });
  game.system.api = foundry.utils.mergeObject(game.system.api ?? {}, { events: api }, { inplace: false });
  return api;
}

/** Remove root-scoped effects left by a prior session or a previous authoritative GM. */
export async function recoverFoundrySystemEventEffects() {
  const gm = game.users?.activeGM ?? null;
  activeGmId = String(gm?.id ?? "");
  if (!gm?.isSelf || !eventRuntime?.provider?.cleanupOrphans) return 0;
  return eventRuntime.provider.cleanupOrphans([]);
}

export function registerFoundrySystemEventAuthorityHooks() {
  Hooks.on("updateUser", () => {
    const nextActiveGmId = String(game.users?.activeGM?.id ?? "");
    if (nextActiveGmId === activeGmId) return;
    activeGmId = nextActiveGmId;
    globalThis.setTimeout(() => void recoverFoundrySystemEventEffects(), 0);
  });
}

async function interceptEventReactions({ event, scope } = {}) {
  const descriptor = getSystemEventDescriptor(event?.key);
  if (!descriptor?.selectable || !descriptor.capabilities.includes("react")) return undefined;

  // Demand-driven: skip hub/scan when no scene ability subscribes to this event key.
  const managed = event?.data?.reactionHubManaged === true;
  const indexed = managed ? true : await eventReactionIndexHasKey(event.key);
  if (!managed && !indexed) {
    return undefined;
  }

  const legacyEventKey = managed ? String(event.data.legacyReactionKey ?? "").trim() : "";
  const baseContext = managed && event.data.legacyContext && typeof event.data.legacyContext === "object"
    ? event.data.legacyContext
    : {};
  const damageHubOperationRef = String(
    event?.data?.damageHubOperationRef
    ?? event?.data?.request?.damageHubOperationRef
    ?? baseContext?.damageHubOperationRef
    ?? ""
  ).trim();
  const context = {
    ...baseContext,
    envelope: event,
    semanticEvent: event,
    chainRef: scope?.chainRef ?? null,
    inDamageHubOperation: Boolean(event?.data?.inDamageHubOperation || damageHubOperationRef),
    damageHubOperation: event?.data?.inDamageHubOperation || damageHubOperationRef ? "current" : "",
    damageHubOperationRef,
    logicalWorldTime: Number(event?.occurredAt?.worldTime) || null,
    falloutMawSemanticReactionAdapted: true
  };

  pushReactionBudgetConsumer(event.rootId, scope?.consumeReactionBudget);
  let result;
  try {
    result = await requestReactionEvent(legacyEventKey || event.key, context);
  } finally {
    popReactionBudgetConsumer(event.rootId, scope?.consumeReactionBudget);
  }
  if (managed) managedReactionResults.set(event.eventId, result);
  return reactionResultDirective(result, descriptor.capabilities);
}

async function adaptLegacyReactionEvent(eventKey, context = {}) {
  const semanticKey = LEGACY_REACTION_EVENT_MAP[eventKey];
  if (!semanticKey) return undefined;
  const occurrences = await buildLegacyReactionOccurrences(eventKey, semanticKey, context);
  if (!occurrences.length) return undefined;
  const normalizedContext = occurrences[0].context;

  const operationId = String(
    normalizedContext.attackId
    ?? normalizedContext.movementId
    ?? normalizedContext.activationId
    ?? normalizedContext.eventId
    ?? foundry.utils.randomID()
  );
  const occurrenceScope = occurrences.map(occurrence => occurrence.occurrenceKey).join("|");
  return withSystemEventRoot({
    kind: `legacyReaction:${eventKey}`,
    operationId: `reaction:${eventKey}:${operationId}:${occurrenceScope}`,
    sceneUuid: getContextSceneUuid(normalizedContext),
    combatUuid: String(game.combat?.uuid ?? ""),
    chainRef: normalizedContext.chainRef ?? null
  }, async scope => {
    let aggregate = createReactionResult();
    for (const occurrence of occurrences) {
      const outcome = await scope.emit(semanticKey, {
        data: {
          ...occurrence.data,
          reactionHubManaged: true,
          legacyReactionKey: eventKey,
          legacyContext: occurrence.context
        }
      }, {
        occurrenceKey: occurrence.occurrenceKey,
        participants: occurrence.participants
      });
      const result = outcome?.event?.eventId
        ? managedReactionResults.get(outcome.event.eventId)
        : null;
      if (outcome?.event?.eventId) managedReactionResults.delete(outcome.event.eventId);
      aggregate = mergeReactionResults(aggregate, result ?? controlToReactionResult(outcome?.control));
      if (aggregate.cancelRemaining) break;
    }
    return aggregate;
  });
}

async function buildLegacyReactionOccurrences(eventKey, semanticKey, rawContext) {
  const context = serializeLegacyReactionContext(eventKey, rawContext ?? {});
  const source = await resolveSourceParticipant(context);
  const targetCandidates = await resolveTargetParticipants(eventKey, context);
  const descriptor = getSystemEventDescriptor(semanticKey);
  const targets = descriptor?.targetAtomic
    ? targetCandidates.filter(Boolean)
    : [targetCandidates[0] ?? null];
  const normalizedTargets = targets.length ? targets : [null];
  return normalizedTargets.map((target, index) => {
    const narrowedContext = narrowLegacyContextToTarget(eventKey, context, target);
    return {
      context: narrowedContext,
      data: narrowedContext,
      participants: { source, target, related: [] },
      occurrenceKey: buildLegacyOccurrenceKey(eventKey, narrowedContext, target, index)
    };
  });
}

async function resolveSourceParticipant(context) {
  const actorUuid = firstUuid(
    context.attackerActorUuid,
    context.sourceActorUuid,
    context.moverActorUuid,
    context.actorUuid
  );
  const tokenUuid = firstUuid(
    context.attackerTokenUuid,
    context.sourceTokenUuid,
    context.moverTokenUuid,
    context.tokenUuid
  );
  const resolvedActorUuid = actorUuid || await actorUuidFromToken(tokenUuid);
  return normalizeParticipant({
    actorUuid: resolvedActorUuid,
    tokenUuid,
    itemUuid: firstUuid(context.weaponUuid, context.sourceItemUuid, context.itemUuid)
  });
}

async function resolveTargetParticipants(eventKey, context) {
  if (eventKey === "tokenLeavingAdjacency") {
    const values = [];
    for (const tokenUuid of uniqueUuids(context.reactorTokenUuids)) {
      values.push(normalizeParticipant({ tokenUuid, actorUuid: await actorUuidFromToken(tokenUuid) }));
    }
    return values;
  }
  const tokenUuids = uniqueUuids([
    context.targetTokenUuid,
    ...(Array.isArray(context.targetTokenUuids) ? context.targetTokenUuids : [])
  ]);
  const actorUuids = uniqueUuids([
    context.targetActorUuid,
    ...(Array.isArray(context.targetActorUuids) ? context.targetActorUuids : [])
  ]);
  const count = Math.max(tokenUuids.length, actorUuids.length, 1);
  const values = [];
  for (let index = 0; index < count; index += 1) {
    const tokenUuid = tokenUuids[index] ?? "";
    const actorUuid = actorUuids[index] ?? await actorUuidFromToken(tokenUuid);
    const participant = normalizeParticipant({ actorUuid, tokenUuid });
    if (participant) values.push(participant);
  }
  return values;
}

function narrowLegacyContextToTarget(eventKey, context, target) {
  if (!target) return { ...context };
  const narrowed = { ...context };
  if (eventKey === "tokenLeavingAdjacency") {
    narrowed.reactorTokenUuids = target.tokenUuid ? [target.tokenUuid] : [];
  } else {
    if (target.actorUuid) narrowed.targetActorUuid = target.actorUuid;
    if (target.tokenUuid) narrowed.targetTokenUuid = target.tokenUuid;
    if (Array.isArray(narrowed.targetActorUuids)) narrowed.targetActorUuids = target.actorUuid ? [target.actorUuid] : [];
    if (Array.isArray(narrowed.targetTokenUuids)) narrowed.targetTokenUuids = target.tokenUuid ? [target.tokenUuid] : [];
  }
  return narrowed;
}

function consumeReactionExecutionBudget({ context = {}, semanticEvent = null } = {}) {
  const envelope = semanticEvent ?? context.semanticEvent ?? context.envelope ?? null;
  const consumers = reactionBudgetConsumers.get(String(envelope?.rootId ?? ""));
  const consume = consumers?.at(-1);
  const ok = typeof consume !== "function" || consume(1);
  return ok;
}

function pushReactionBudgetConsumer(rootId, consume) {
  const id = String(rootId ?? "").trim();
  if (!id || typeof consume !== "function") return;
  const consumers = reactionBudgetConsumers.get(id) ?? [];
  consumers.push(consume);
  reactionBudgetConsumers.set(id, consumers);
}

function popReactionBudgetConsumer(rootId, consume) {
  const id = String(rootId ?? "").trim();
  const consumers = reactionBudgetConsumers.get(id);
  if (!consumers) return;
  const index = consumers.lastIndexOf(consume);
  if (index >= 0) consumers.splice(index, 1);
  if (consumers.length) reactionBudgetConsumers.set(id, consumers);
  else reactionBudgetConsumers.delete(id);
}

function reactionResultDirective(result, capabilities = []) {
  if (result?.cancelRemaining && capabilities.includes("cancelRemaining")) {
    return { cancel: { scope: "remaining", reason: result.reason || "reaction" } };
  }
  if (result?.cancelCurrent && capabilities.includes("cancelCurrent")) {
    return { cancel: { scope: "current", reason: result.reason || "reaction" } };
  }
  return undefined;
}

function controlToReactionResult(control = {}) {
  return createReactionResult({
    handled: Boolean(control?.current || control?.remaining || control?.root),
    cancelCurrent: Boolean(control?.current),
    cancelRemaining: Boolean(control?.remaining || control?.root),
    reason: String(control?.reasons?.at?.(-1)?.reason ?? "")
  });
}

function createReactionResult(data = {}) {
  return {
    handled: Boolean(data.handled),
    status: String(data.status ?? "declined"),
    cancelCurrent: Boolean(data.cancelCurrent),
    cancelRemaining: Boolean(data.cancelRemaining),
    difficultyBonus: Number.isFinite(Number(data.difficultyBonus)) ? Math.trunc(Number(data.difficultyBonus)) : 0,
    reason: String(data.reason ?? "")
  };
}

function mergeReactionResults(left, right) {
  const current = createReactionResult(left);
  const next = createReactionResult(right);
  const priority = { declined: 0, failed: 1, success: 2 };
  return createReactionResult({
    handled: current.handled || next.handled,
    status: (priority[next.status] ?? 0) > (priority[current.status] ?? 0) ? next.status : current.status,
    cancelCurrent: current.cancelCurrent || next.cancelCurrent,
    cancelRemaining: current.cancelRemaining || next.cancelRemaining,
    difficultyBonus: current.difficultyBonus + next.difficultyBonus,
    reason: next.reason || current.reason
  });
}

function createPublicCatalogSnapshot(catalog) {
  return Object.freeze(Array.from(catalog ?? []).map(event => Object.freeze({
    key: event.key,
    catalogVersion: event.catalogVersion,
    group: event.group,
    groupLabelKey: event.groupLabelKey,
    phase: event.phase,
    capabilities: Object.freeze([...event.capabilities]),
    allowedPatchPaths: Object.freeze([...event.allowedPatchPaths]),
    selectable: Boolean(event.selectable),
    targetAtomic: Boolean(event.targetAtomic),
    subject: event.subject,
    roles: Object.freeze([...event.roles]),
    labelKey: event.labelKey,
    descriptionKey: event.descriptionKey
  })));
}

function createPublicRegistrySnapshot(registry) {
  return Object.freeze(Object.fromEntries(Object.entries(registry ?? {}).map(([key, value]) => [key, Object.freeze({
    ...value,
    ...(Array.isArray(value.capabilities) ? { capabilities: Object.freeze([...value.capabilities]) } : {})
  })])));
}

async function actorUuidFromToken(tokenUuid) {
  if (!tokenUuid) return "";
  try {
    return String((await fromUuid(tokenUuid))?.actor?.uuid ?? "");
  } catch (_error) {
    return "";
  }
}

function normalizeParticipant(participant) {
  const normalized = {
    actorUuid: String(participant?.actorUuid ?? "").trim(),
    tokenUuid: String(participant?.tokenUuid ?? "").trim(),
    itemUuid: String(participant?.itemUuid ?? "").trim()
  };
  return Object.values(normalized).some(Boolean) ? normalized : null;
}

function firstUuid(...values) {
  return values.map(value => String(value ?? "").trim()).find(Boolean) ?? "";
}

function uniqueUuids(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [values])
    .map(value => String(value ?? "").trim())
    .filter(Boolean)));
}

function buildLegacyOccurrenceKey(eventKey, context, target, index) {
  const operationId = firstUuid(context.attackId, context.movementId, context.activationId, context.eventId, "legacy");
  const targetId = firstUuid(target?.tokenUuid, target?.actorUuid, String(index));
  return `${eventKey}:${operationId}:${targetId}`;
}

function getContextSceneUuid(context) {
  const tokenUuid = firstUuid(context.attackerTokenUuid, context.sourceTokenUuid, context.moverTokenUuid, context.targetTokenUuid);
  const match = tokenUuid.match(/^(Scene\.[^.]+)/);
  return match?.[1] ?? String(canvas?.scene?.uuid ?? "");
}
