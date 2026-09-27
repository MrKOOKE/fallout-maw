export const RELEASE_ABILITY_DEFINITIONS = Object.freeze({
  onslaught: { label: "Натиск", passive: true },
  liberation: { label: "Освобождение", active: true },
  secondWind: { label: "Второе дыхание", active: true },
  equipmentLimit: { label: "На пределе", active: true },
  watcher: { label: "Смотритель", active: true },
  bloodbath: { label: "Кровавая баня", passive: true },
  unexpectedImpulse: { label: "Неожиданный порыв", passive: true }
});

export function advanceOnslaught(state, now, gain) {
  const nextGainAt = Number(state.nextGainAt ?? now + 6);
  const periods = Math.max(0, Math.floor((now - nextGainAt) / 6) + 1);
  return { ...state, damage: Math.min(200, Math.max(0, Number(state.damage) || 0) + periods * gain), nextGainAt: nextGainAt + periods * 6 };
}

export function bloodbathMissingHealthBonus(health) {
  const capacity = Math.max(0, Number(health?.max) - Number(health?.min ?? 0));
  return capacity ? Math.floor(Math.min(100, Math.max(0, (Number(health.max) - Number(health.value)) / capacity * 100)) / 2) : 0;
}

export function secondWindResourceRecovery(resource) {
  const max = Math.max(0, Number(resource?.max) || 0);
  const current = Math.max(0, Math.min(max, Number(resource?.value) || 0));
  return { value: max, once: Math.max(0, Number(resource?.once) || 0) + Math.floor(current / 2) };
}

export function isInitiativeBelowThreshold(value, others) {
  const rolled = others.filter(entry => entry !== null && entry !== undefined && Number.isFinite(Number(entry)));
  return rolled.length > 0 && rolled.filter(entry => Number(entry) > value).length / rolled.length >= 0.7;
}

/** Condition is still damaged normally; only its functional penalty is suspended. */
export function hasEquipmentLimitProtection(itemOrSystem) {
  const item = itemOrSystem?.system ? itemOrSystem : itemOrSystem?.parent;
  const actor = item?.actor ?? (item?.parent?.documentName === "Actor" ? item.parent : null);
  if (!actor || !item?.id) return false;
  const now = Number(globalThis.game?.time?.worldTime) || 0;
  return Array.from(actor.effects ?? []).some(effect => {
    const data = effect.flags?.["fallout-maw"]?.equipmentLimit;
    return !effect.disabled && !effect.isExpired && data?.expiresAt > now && data.itemIds?.includes(item.id);
  });
}
