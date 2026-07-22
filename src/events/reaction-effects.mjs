import { SYSTEM_ID } from "../constants.mjs";
import {
  getAbilityFunctionEffectDurationSeconds,
  getAbilitySourceId
} from "../settings/abilities.mjs";
import { getAbilityEffectOriginUuid } from "../utils/ability-effect-origin.mjs";
import {
  EFFECT_LIFECYCLE_FLAG_KEY,
  EFFECT_LIFECYCLE_KINDS,
  buildEffectFunctionSnapshot
} from "../abilities/effect-lifecycle.mjs";
import {
  LIMITED_EFFECT_COPY_FLAG_KEY,
  buildLimitedEffectCopyFlag,
  isLimitedEffectCopyReservationFor,
  releaseLimitedEffectCopyReservation,
  reserveLimitedEffectCopySlot
} from "../abilities/limited-effect-copies.mjs";

export const EVENT_REACTION_EFFECT_FLAG_KEY = "eventReaction";
export const EVENT_REACTION_EFFECT_KIND = "eventReaction";

export function createEventReactionEffectManager({
  resolveActor = defaultResolveActor,
  listActors = defaultListActors,
  getEffects = actor => Array.from(actor?.effects ?? []),
  createEffects = (actor, data, options) => actor.createEmbeddedDocuments("ActiveEffect", data, options),
  updateEffect = (effect, data, options) => effect.update(data, options),
  deleteEffects = (actor, ids, options) => actor.deleteEmbeddedDocuments("ActiveEffect", ids, options),
  prepareChanges = (_actor, changes) => changes,
  evaluateEffectCopyLimit = undefined,
  worldTime = () => Number(globalThis.game?.time?.worldTime) || 0,
  logger = console
} = {}) {
  const trackedRoots = new Map();

  async function apply({
    actor = null,
    actorUuid = "",
    sourceItem = null,
    sourceItemUuid = "",
    abilityFunction = {},
    functionId = "",
    envelope = {},
    chainRef = null,
    copyReservation = null,
    durationSeconds = null,
    changes = null
  } = {}) {
    const reactor = actor ?? await resolveActor(actorUuid);
    if (!reactor) throw new Error("Event Reaction reactor Actor is unavailable.");
    const reactorActorUuid = String(reactor.uuid ?? actorUuid ?? "").trim();
    const itemUuid = String(sourceItem?.uuid ?? sourceItemUuid ?? "").trim();
    const id = String(abilityFunction?.id ?? functionId ?? "").trim();
    const rootId = String(envelope?.rootId ?? envelope?.eventId ?? "").trim();
    if (!reactorActorUuid || !itemUuid || !id || !rootId) {
      throw new Error("Event Reaction effect provenance is incomplete.");
    }
    const seconds = Math.max(0, Math.trunc(Number(
      durationSeconds ?? getAbilityFunctionEffectDurationSeconds(abilityFunction)
    ) || 0));
    const preparedChanges = normalizeManagedChanges(await prepareChanges(
      reactor,
      changes ?? abilityFunction?.changes ?? []
    ));
    const scope = seconds > 0 ? "timed" : "root";
    const identity = { reactorActorUuid, sourceItemUuid: itemUuid, functionId: id, rootId, scope };
    const existing = getEffects(reactor).find(effect => managedEffectMatches(effect, identity));
    const effectCopyContext = {
      recipientActor: reactor,
      sourceActor: reactor,
      sourceItem: sourceItem ?? { uuid: itemUuid },
      abilityFunction
    };
    const effectCopyOptions = evaluateEffectCopyLimit ? { evaluateLimit: evaluateEffectCopyLimit } : {};
    let reservation = null;
    if (!existing) {
      reservation = isLimitedEffectCopyReservationFor(copyReservation, effectCopyContext)
        ? copyReservation
        : reserveLimitedEffectCopySlot(effectCopyContext, effectCopyOptions);
      if (!reservation.allowed) return null;
    }
    const effectCopyFlag = buildLimitedEffectCopyFlag(effectCopyContext, effectCopyOptions);
    const effectData = buildEventReactionEffectData({
      reactor,
      sourceItem,
      itemUuid,
      originUuid: getAbilityEffectOriginUuid(reactor, sourceItem, itemUuid),
      abilityFunction,
      functionId: id,
      envelope,
      durationSeconds: seconds,
      changes: preparedChanges,
      worldTime: worldTime(),
      effectCopyFlag
    });

    let effect;
    const operationOptions = {
      animate: false,
      falloutMawEventReactionEffect: true,
      ...(chainRef ? { chainRef } : {})
    };
    try {
      if (existing) {
        effect = await updateEffect(existing, buildEventReactionEffectUpdate(effectData), operationOptions);
        effect ??= existing;
      } else {
        const created = await createEffects(reactor, [effectData], operationOptions);
        effect = Array.isArray(created) ? created[0] : created;
      }
      if (!effect) throw new Error("Event Reaction ActiveEffect was not created.");
      if (scope === "root") trackRootEffect(rootId, reactorActorUuid, effect);
      return effect;
    } finally {
      releaseLimitedEffectCopyReservation(reservation);
    }
  }

  async function cleanupRoot(rootId = "") {
    const id = String(rootId ?? "").trim();
    if (!id) return 0;
    const tracked = trackedRoots.get(id) ?? new Map();
    const actors = new Map();
    for (const actor of await listActors()) {
      if (actor?.uuid) actors.set(actor.uuid, actor);
    }
    for (const actorUuid of tracked.keys()) {
      if (!actors.has(actorUuid)) {
        const actor = await resolveActor(actorUuid);
        if (actor) actors.set(actorUuid, actor);
      }
    }

    let deleted = 0;
    for (const actor of actors.values()) {
      const ids = getEffects(actor)
        .filter(effect => {
          const flag = getEventReactionEffectFlag(effect);
          return flag?.scope === "root" && flag.rootId === id;
        })
        .map(effect => String(effect?.id ?? effect?._id ?? ""))
        .filter(Boolean);
      if (!ids.length) continue;
      try {
        await deleteEffects(actor, ids, { animate: false, falloutMawEventReactionCleanup: true });
        deleted += ids.length;
      } catch (error) {
        logger?.error?.(`fallout-maw | Failed to clean Event Reaction root '${id}'.`, error);
      }
    }
    trackedRoots.delete(id);
    return deleted;
  }

  async function cleanupOrphans(activeRootIds = []) {
    const active = new Set(Array.from(activeRootIds ?? []).map(value => String(value ?? "").trim()).filter(Boolean));
    const orphanRoots = new Set();
    for (const actor of await listActors()) {
      for (const effect of getEffects(actor)) {
        const flag = getEventReactionEffectFlag(effect);
        if (flag?.scope === "root" && flag.rootId && !active.has(flag.rootId)) orphanRoots.add(flag.rootId);
      }
    }
    let deleted = 0;
    for (const rootId of orphanRoots) deleted += await cleanupRoot(rootId);
    return deleted;
  }

  function trackRootEffect(rootId, actorUuid, effect) {
    const actors = trackedRoots.get(rootId) ?? new Map();
    const ids = actors.get(actorUuid) ?? new Set();
    const effectId = String(effect?.id ?? effect?._id ?? "").trim();
    if (effectId) ids.add(effectId);
    actors.set(actorUuid, ids);
    trackedRoots.set(rootId, actors);
  }

  return Object.freeze({
    apply,
    cleanupRoot,
    cleanupOrphans,
    getTrackedRootIds: () => Array.from(trackedRoots.keys())
  });
}

export function buildEventReactionEffectData({
  reactor = null,
  sourceItem = null,
  itemUuid = "",
  originUuid = "",
  abilityFunction = {},
  functionId = "",
  envelope = {},
  durationSeconds = 0,
  changes = [],
  worldTime = 0,
  effectCopyFlag = null
} = {}) {
  const seconds = Math.max(0, Math.trunc(Number(durationSeconds) || 0));
  const rootId = String(envelope?.rootId ?? envelope?.eventId ?? "").trim();
  const sourceItemUuid = String(sourceItem?.uuid ?? itemUuid ?? "").trim();
  const effectOriginUuid = String(originUuid || getAbilityEffectOriginUuid(reactor, sourceItem, sourceItemUuid));
  const id = String(abilityFunction?.id ?? functionId ?? "").trim();
  const functionData = buildEffectFunctionSnapshot({ ...abilityFunction, id });
  const flag = {
    rootId,
    eventId: String(envelope?.eventId ?? ""),
    eventKey: String(envelope?.key ?? ""),
    sourceItemUuid,
    abilitySourceId: getAbilitySourceId(sourceItem),
    functionId: id,
    functionData,
    reactorActorUuid: String(reactor?.uuid ?? ""),
    scope: seconds > 0 ? "timed" : "root",
    durationSeconds: seconds
  };
  const data = {
    type: "base",
    name: String(sourceItem?.name ?? "Event Reaction"),
    img: String(sourceItem?.img ?? "icons/svg/aura.svg"),
    origin: effectOriginUuid,
    transfer: false,
    disabled: false,
    showIcon: 2,
    system: { changes: normalizeManagedChanges(changes) },
    flags: {
      [SYSTEM_ID]: {
        kind: "active",
        [EFFECT_LIFECYCLE_FLAG_KEY]: {
          kind: EFFECT_LIFECYCLE_KINDS.disposableInstance
        },
        [EVENT_REACTION_EFFECT_FLAG_KEY]: flag,
        ...(effectCopyFlag ? {
          [LIMITED_EFFECT_COPY_FLAG_KEY]: effectCopyFlag
        } : {})
      }
    }
  };
  if (seconds > 0) {
    data.start = { time: Math.trunc(Number(worldTime) || 0) };
    data.duration = { value: seconds, units: "seconds", expiry: null, expired: false };
  } else {
    data.duration = { value: null, units: "seconds", expiry: null, expired: false };
  }
  return data;
}

export function getEventReactionEffectFlag(effect = null) {
  return effect?.getFlag?.(SYSTEM_ID, EVENT_REACTION_EFFECT_FLAG_KEY)
    ?? effect?.flags?.[SYSTEM_ID]?.[EVENT_REACTION_EFFECT_FLAG_KEY]
    ?? null;
}

export function hasEventReactionEffectInstance({
  actor = null,
  sourceItem = null,
  abilityFunction = null,
  envelope = {}
} = {}) {
  const durationSeconds = Math.max(0, Math.trunc(Number(
    getAbilityFunctionEffectDurationSeconds(abilityFunction)
  ) || 0));
  const identity = {
    reactorActorUuid: String(actor?.uuid ?? "").trim(),
    sourceItemUuid: String(sourceItem?.uuid ?? "").trim(),
    functionId: String(abilityFunction?.id ?? "").trim(),
    rootId: String(envelope?.rootId ?? envelope?.eventId ?? "").trim(),
    scope: durationSeconds > 0 ? "timed" : "root"
  };
  if (Object.values(identity).some(value => !value)) return false;
  return Array.from(actor?.effects ?? []).some(effect => managedEffectMatches(effect, identity));
}

export function isEventReactionManagedEffect(effect = null) {
  return Boolean(getEventReactionEffectFlag(effect));
}

function managedEffectMatches(effect, identity) {
  const flag = getEventReactionEffectFlag(effect);
  if (!flag || flag.scope !== identity.scope) return false;
  if (flag.reactorActorUuid !== identity.reactorActorUuid) return false;
  if (flag.sourceItemUuid !== identity.sourceItemUuid || flag.functionId !== identity.functionId) return false;
  return flag.rootId === identity.rootId;
}

function buildEventReactionEffectUpdate(data) {
  return {
    name: data.name,
    img: data.img,
    origin: data.origin,
    transfer: false,
    disabled: false,
    showIcon: data.showIcon,
    system: data.system,
    flags: data.flags,
    ...(data.start ? { start: data.start } : {}),
    duration: data.duration
  };
}

function normalizeManagedChanges(changes = []) {
  return (Array.isArray(changes) ? changes : Object.values(changes ?? {}))
    .filter(change => String(change?.key ?? "").trim() && String(change?.value ?? "") !== "")
    .map(change => ({ ...change }));
}

function defaultResolveActor(uuid) {
  return globalThis.fromUuid?.(uuid) ?? null;
}

function defaultListActors() {
  const actors = new Map();
  for (const actor of globalThis.game?.actors ?? []) {
    if (actor?.uuid) actors.set(actor.uuid, actor);
  }
  for (const scene of globalThis.game?.scenes ?? []) {
    for (const token of scene?.tokens?.contents ?? scene?.tokens ?? []) {
      if (token?.actor?.uuid) actors.set(token.actor.uuid, token.actor);
    }
  }
  for (const token of globalThis.canvas?.tokens?.placeables ?? []) {
    if (token?.actor?.uuid) actors.set(token.actor.uuid, token.actor);
  }
  return Array.from(actors.values());
}
