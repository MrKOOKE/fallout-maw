import { SYSTEM_ID } from "../constants.mjs";
import {
  ABILITY_CONDITION_TYPES,
  getAbilitySourceId
} from "../settings/abilities.mjs";
import { getEffectSourceFunctionContext } from "./effect-lifecycle.mjs";

export const LIMITED_EFFECT_COPY_FLAG_KEY = "limitedEffectCopy";

const MANAGED_EFFECT_PROVENANCE_KEYS = Object.freeze([
  // Source projections are already reconciled to one document per source
  // item. Copy limits govern paths that can produce independent instances.
  "activeApplication",
  "abilityItemUseEffect",
  "eventReaction",
  "abilityTimedTriggerEffect",
  "auraGenerated"
]);

// Reservations exist only while an effect document is being committed. They
// close the async gap between the last capacity check and ActiveEffect creation
// without adding hooks or persistent counters to every effect update.
const pendingReservationsByKey = new Map();
const activeReservations = new WeakSet();

export function getLimitedEffectCopyConditions(conditions = []) {
  return (Array.isArray(conditions) ? conditions : Object.values(conditions ?? {}))
    .filter(condition => condition?.type === ABILITY_CONDITION_TYPES.limitedEffectCopies);
}

export function isLimitedEffectCopyRefresh(abilityFunction = null) {
  return getLimitedEffectCopyConditions(abilityFunction?.conditions ?? [])
    .some(condition => condition?.refresh === true);
}

export function findLimitedEffectCopyToRefresh(recipientActor = null, sourceItem = null, abilityFunction = null) {
  const identity = buildSourceFunctionIdentity(sourceItem, abilityFunction);
  if (!identity || !recipientActor) return null;
  return Array.from(recipientActor?.effects ?? []).find(effect => {
    if (!effectCountsAsCopy(effect)) return false;
    const effectIdentity = getManagedEffectSourceFunctionIdentity(effect, recipientActor);
    return sourceFunctionIdentitiesMatch(identity, effectIdentity);
  }) ?? null;
}

export function resolveLimitedEffectCopyLimit(conditions = [], actor = null, {
  evaluateLimit = formula => {
    const direct = Number(String(formula ?? "").trim());
    return Number.isFinite(direct) ? direct : 1;
  }
} = {}) {
  const configured = getLimitedEffectCopyConditions(conditions);
  if (!configured.length) return null;
  return Math.min(...configured.map(condition => {
    const fallback = Math.max(1, toInteger(condition?.limit ?? 1));
    const formula = String(condition?.limitFormula ?? fallback).trim() || String(fallback);
    return Math.max(1, toInteger(evaluateLimit(formula, actor)));
  }));
}

export function getLimitedEffectCopyDescriptor({
  sourceActor = null,
  sourceItem = null,
  abilityFunction = null
} = {}, options = {}) {
  const limit = resolveLimitedEffectCopyLimit(abilityFunction?.conditions ?? [], sourceActor, options);
  if (limit === null) return null;
  const identity = buildSourceFunctionIdentity(sourceItem, abilityFunction);
  return { identity, limit };
}

export function buildLimitedEffectCopyFlag(context = {}, options = {}) {
  const descriptor = getLimitedEffectCopyDescriptor(context, options);
  if (!descriptor?.identity) return null;
  return {
    sourceKey: descriptor.identity.sourceKey,
    abilitySourceId: getAbilitySourceId(context?.sourceItem).trim(),
    sourceItemUuid: String(context?.sourceItem?.uuid ?? context?.sourceItem?.id ?? "").trim(),
    functionId: descriptor.identity.functionId,
    limit: descriptor.limit
  };
}

export function getLimitedEffectCopyCapacity({
  recipientActor = null,
  sourceActor = null,
  sourceItem = null,
  abilityFunction = null
} = {}, options = {}) {
  const descriptor = getLimitedEffectCopyDescriptor({ sourceActor, sourceItem, abilityFunction }, options);
  if (!descriptor) return { limited: false, allowed: true, count: 0, limit: null };

  const { identity } = descriptor;
  if (!identity) {
    return { limited: true, allowed: true, count: 0, limit: descriptor.limit, identity: null };
  }

  let effectCount = 0;
  const configuredLimits = [descriptor.limit];
  for (const effect of Array.from(recipientActor?.effects ?? [])) {
    if (!effectCountsAsCopy(effect)) continue;
    const effectIdentity = getManagedEffectSourceFunctionIdentity(effect, recipientActor);
    if (!sourceFunctionIdentitiesMatch(identity, effectIdentity)) continue;
    effectCount += 1;
    const storedLimit = getManagedEffectCopyLimit(effect);
    if (storedLimit !== null) configuredLimits.push(storedLimit);
  }

  const reservationKey = buildReservationKey(recipientActor, identity);
  const reservations = reservationKey ? pendingReservationsByKey.get(reservationKey) : null;
  for (const reservation of reservations ?? []) configuredLimits.push(reservation.limit);
  const pendingCount = reservations?.size ?? 0;
  const limit = Math.min(...configuredLimits);
  const count = effectCount + pendingCount;
  return { limited: true, allowed: count < limit, count, limit, identity };
}

export function hasLimitedEffectCopyCapacity(context = {}, options = {}) {
  return getLimitedEffectCopyCapacity(context, options).allowed;
}

export function getPendingLimitedEffectCopyState(recipientActor = null, identity = null) {
  const key = buildReservationKey(recipientActor, identity);
  const reservations = key ? pendingReservationsByKey.get(key) : null;
  return {
    count: reservations?.size ?? 0,
    limits: Array.from(reservations ?? []).map(reservation => reservation.limit)
  };
}

export function reserveLimitedEffectCopySlot(context = {}, options = {}) {
  const capacity = getLimitedEffectCopyCapacity(context, options);
  if (!capacity.limited || !capacity.identity) {
    return createNoopReservation(capacity.allowed);
  }
  if (!capacity.allowed) return createNoopReservation(false);

  const key = buildReservationKey(context?.recipientActor, capacity.identity);
  if (!key) return createNoopReservation(true);
  const reservation = {
    allowed: true,
    limited: true,
    key,
    actorKey: getActorKey(context?.recipientActor),
    sourceKey: capacity.identity.sourceKey,
    functionId: capacity.identity.functionId,
    limit: capacity.limit,
    released: false
  };
  const pending = pendingReservationsByKey.get(key) ?? new Set();
  pending.add(reservation);
  pendingReservationsByKey.set(key, pending);
  activeReservations.add(reservation);
  return reservation;
}

export function releaseLimitedEffectCopyReservation(reservation = null) {
  if (!reservation || reservation.released) return;
  reservation.released = true;
  if (!activeReservations.has(reservation)) return;
  activeReservations.delete(reservation);
  const pending = pendingReservationsByKey.get(reservation.key);
  pending?.delete(reservation);
  if (pending && !pending.size) pendingReservationsByKey.delete(reservation.key);
}

export function isLimitedEffectCopyReservationFor(reservation = null, context = {}) {
  if (!reservation || reservation.released || !activeReservations.has(reservation)) return false;
  const identity = buildSourceFunctionIdentity(context?.sourceItem, context?.abilityFunction);
  return Boolean(
    identity
    && reservation.actorKey === getActorKey(context?.recipientActor)
    && reservation.sourceKey === identity.sourceKey
    && reservation.functionId === identity.functionId
  );
}

export function buildSourceFunctionIdentity(sourceItem = null, abilityFunction = null) {
  const functionId = String(abilityFunction?.id ?? "").trim();
  if (!functionId) return null;
  const abilitySourceId = getAbilitySourceId(sourceItem).trim();
  if (abilitySourceId) return { sourceKey: `ability:${abilitySourceId}`, functionId };
  const sourceItemUuid = String(sourceItem?.uuid ?? sourceItem?.id ?? "").trim();
  return sourceItemUuid ? { sourceKey: `item:${sourceItemUuid}`, functionId } : null;
}

export function getManagedEffectSourceFunctionIdentity(effect = null, recipientActor = null) {
  const systemFlags = effect?.flags?.[SYSTEM_ID] ?? {};
  const copyFlag = systemFlags?.[LIMITED_EFFECT_COPY_FLAG_KEY];
  const storedSourceKey = String(copyFlag?.sourceKey ?? "").trim();
  const storedFunctionId = String(copyFlag?.functionId ?? "").trim();
  if (storedSourceKey && storedFunctionId) {
    return { sourceKey: storedSourceKey, functionId: storedFunctionId };
  }

  const provenance = MANAGED_EFFECT_PROVENANCE_KEYS
    .map(key => systemFlags?.[key])
    .find(data => data && typeof data === "object" && String(data?.functionId ?? "").trim());
  if (!provenance) return null;

  const functionId = String(provenance.functionId ?? "").trim();
  const storedAbilitySourceId = String(provenance.abilitySourceId ?? "").trim();
  if (storedAbilitySourceId) return { sourceKey: `ability:${storedAbilitySourceId}`, functionId };

  // A module's synthetic UUID is authoritative provenance. Its ActiveEffect
  // origin intentionally points to the real host item and must not replace it.
  const storedSourceItemUuid = String(provenance.sourceItemUuid ?? "").trim();
  if (storedSourceItemUuid) return { sourceKey: `item:${storedSourceItemUuid}`, functionId };

  const sourceActorUuid = String(provenance?.sourceActorUuid ?? provenance?.reactorActorUuid ?? "").trim();
  const sourceItemId = String(
    provenance?.abilityItemId
    ?? provenance?.sourceItemId
    ?? provenance?.itemId
    ?? ""
  ).trim();
  if (sourceActorUuid && sourceItemId) {
    return { sourceKey: `item:${sourceActorUuid}.Item.${sourceItemId}`, functionId };
  }

  // Legacy effects without complete provenance take the slower document
  // resolution path once; newly generated effects always use the O(1) paths.
  const sourceContext = getEffectSourceFunctionContext(effect, recipientActor);
  const resolvedAbilitySourceId = getAbilitySourceId(sourceContext?.sourceItem).trim();
  if (resolvedAbilitySourceId) return { sourceKey: `ability:${resolvedAbilitySourceId}`, functionId };
  const sourceItemUuid = String(sourceContext?.sourceItem?.uuid ?? effect?.origin ?? "").trim();
  return sourceItemUuid ? { sourceKey: `item:${sourceItemUuid}`, functionId } : null;
}

export function getManagedEffectCopyLimit(effect = null) {
  const systemFlags = effect?.flags?.[SYSTEM_ID] ?? {};
  const direct = normalizeStoredLimit(systemFlags?.[LIMITED_EFFECT_COPY_FLAG_KEY]?.limit);
  if (direct !== null) return direct;
  for (const key of MANAGED_EFFECT_PROVENANCE_KEYS) {
    const legacy = normalizeStoredLimit(systemFlags?.[key]?.effectCopyLimit);
    if (legacy !== null) return legacy;
  }
  return null;
}

export function sourceFunctionIdentitiesMatch(left = null, right = null) {
  return Boolean(
    left
    && right
    && left.sourceKey === right.sourceKey
    && left.functionId === right.functionId
  );
}

export function effectCountsAsCopy(effect = null) {
  return Boolean(effect) && effect?.duration?.expired !== true;
}

function buildReservationKey(actor = null, identity = null) {
  const actorKey = getActorKey(actor);
  if (!actorKey || !identity?.sourceKey || !identity?.functionId) return "";
  return `${actorKey}|${identity.sourceKey}|${identity.functionId}`;
}

function getActorKey(actor = null) {
  return String(actor?.uuid ?? actor?.id ?? "").trim();
}

function createNoopReservation(allowed) {
  return { allowed: Boolean(allowed), limited: false, released: false };
}

function normalizeStoredLimit(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 1 ? Math.trunc(numeric) : null;
}

function toInteger(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}
