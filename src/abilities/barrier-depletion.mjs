import { SYSTEM_ID } from "../constants.mjs";

export const DAMAGE_BARRIER_DEPLETIONS_FLAG_KEY = "damageBarrierDepletions";

export function getManagedBarrierProjectionIdentity(effect = null) {
  const flags = effect?.flags?.[SYSTEM_ID] ?? {};
  const ability = flags.abilityEffect;
  if (ability?.abilityItemId && ability?.signature) {
    return {
      key: `ability:${ability.abilityItemId}`,
      kind: "ability",
      sourceId: String(ability.abilityItemId),
      signature: String(ability.signature)
    };
  }

  const item = flags.itemEffect;
  if (item?.itemId && item?.signature) {
    return {
      key: `item:${item.itemId}`,
      kind: "item",
      sourceId: String(item.itemId),
      signature: String(item.signature)
    };
  }

  const aura = flags.auraGenerated;
  if (aura?.key && aura?.signature) {
    return {
      key: `aura:${aura.key}`,
      kind: "aura",
      sourceId: String(aura.key),
      signature: String(aura.signature)
    };
  }
  return null;
}

export function getActorBarrierDepletions(actor = null) {
  const source = actor?.flags?.[SYSTEM_ID]?.[DAMAGE_BARRIER_DEPLETIONS_FLAG_KEY];
  return source && typeof source === "object" && !Array.isArray(source)
    ? { ...source }
    : {};
}

export function isManagedBarrierProjectionDepleted(actor, key = "", signature = "") {
  const identity = String(key ?? "").trim();
  const expected = String(signature ?? "");
  if (!identity || !expected) return false;
  return String(getActorBarrierDepletions(actor)[identity]?.signature ?? "") === expected;
}

export async function recordManagedBarrierProjectionDepletions(actor, effects = []) {
  const next = getActorBarrierDepletions(actor);
  let changed = false;
  for (const effect of effects) {
    const identity = getManagedBarrierProjectionIdentity(effect);
    if (!identity) continue;
    if (String(next[identity.key]?.signature ?? "") === identity.signature) continue;
    next[identity.key] = {
      kind: identity.kind,
      sourceId: identity.sourceId,
      signature: identity.signature
    };
    changed = true;
  }
  if (!changed) return false;
  await updateActorBarrierDepletions(actor, next);
  return true;
}

export async function clearManagedBarrierProjectionDepletion(actor, key = "") {
  const identity = String(key ?? "").trim();
  if (!identity) return false;
  const next = getActorBarrierDepletions(actor);
  if (!Object.hasOwn(next, identity)) return false;
  delete next[identity];
  await updateActorBarrierDepletions(actor, next);
  return true;
}

export async function pruneManagedBarrierProjectionDepletions(actor, predicate = () => true) {
  const next = getActorBarrierDepletions(actor);
  let changed = false;
  for (const [key, record] of Object.entries(next)) {
    if (!predicate(record, key)) continue;
    delete next[key];
    changed = true;
  }
  if (!changed) return false;
  await updateActorBarrierDepletions(actor, next);
  return true;
}

function updateActorBarrierDepletions(actor, value) {
  return actor.update({
    [`flags.${SYSTEM_ID}.${DAMAGE_BARRIER_DEPLETIONS_FLAG_KEY}`]: value
  }, {
    falloutMawDamageBarrierDepletion: true,
    falloutMawSkipDamageStatusSync: true
  });
}
