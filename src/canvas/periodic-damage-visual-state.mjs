export const PERIODIC_DAMAGE_NOISE_MAX_HEALTH_RATIO = 0.20;
export const PERIODIC_DAMAGE_NOISE_MIN_INTENSITY = 0.65;

const DAMAGE_CHANGE_PREFIX = "system.damageEffects.";
const parsedChanges = new WeakMap();

/** Forecast one stored tick, without rolling damage or running damage mutations. */
export function getPeriodicDamageVisualState(actor, { isLimbDestroyed = () => false } = {}) {
  const healthMax = Number(actor?.system?.resources?.health?.max);
  if (!Number.isFinite(healthMax) || healthMax <= 0) return null;

  let dominant = null;
  const destroyedLimbs = new Map();
  // The timed-damage executor processes Actor effects, not transferred Item effects.
  for (const effect of actor.effects ?? []) {
    if (effect.disabled || effect.isSuppressed) continue;
    const changes = effect.system?.changes ?? effect.changes;
    if (!Array.isArray(changes)) continue;
    const ticks = new Map();
    for (const change of changes) {
      const data = readDamageChange(change);
      if (!data || data.scope === "itemCondition") continue;
      const amount = getNextPeriodicDamageAmount(data);
      if (!amount) continue;
      if (data.limbKey) {
        if (!destroyedLimbs.has(data.limbKey)) {
          destroyedLimbs.set(data.limbKey, isLimbDestroyed(actor, data.limbKey));
        }
        if (destroyedLimbs.get(data.limbKey)) continue;
      }

      const damageTypeKey = String(data.damageTypeKey || (data.kind === "bleedingDamage" ? "bleeding" : "")).trim();
      if (!damageTypeKey) continue;
      // One ActiveEffect can store a separate generated sourceIdentity for each
      // damaged limb. Sum its same-color fragments due together; those packet
      // identities are for damage execution, not separate visual effects.
      const key = JSON.stringify([
        data.kind, damageTypeKey,
        data.nextTickTime ?? data.startTime ?? 0
      ]);
      const tick = ticks.get(key) ?? { amount: 0, damageTypeKey };
      tick.amount += amount;
      ticks.set(key, tick);
    }
    for (const tick of ticks.values()) {
      if (!dominant || tick.amount > dominant.amount) dominant = tick;
    }
  }
  if (!dominant) return null;
  const damageIntensity = Math.min(1, dominant.amount / (healthMax * PERIODIC_DAMAGE_NOISE_MAX_HEALTH_RATIO));
  return {
    ...dominant,
    healthMax,
    // Every damaging periodic effect stays clearly visible, including tiny
    // ticks on high-health actors. Full strength still starts at 20% max HP.
    intensity: PERIODIC_DAMAGE_NOISE_MIN_INTENSITY + ((1 - PERIODIC_DAMAGE_NOISE_MIN_INTENSITY) * damageIntensity)
  };
}

export function getNextPeriodicDamageAmount(data) {
  const remaining = nonNegativeInteger(data?.remainingTicks);
  if (!remaining) return 0;
  if (data.kind === "periodicDamage") return nonNegativeInteger(data.amountPerTick, Math.round);
  if (data.kind !== "bleedingDamage" || !Array.isArray(data.tickAmounts)) return 0;
  const total = Math.max(data.tickAmounts.length, nonNegativeInteger(data.totalTicks));
  return nonNegativeInteger(data.tickAmounts[Math.max(0, total - remaining)]);
}

function nonNegativeInteger(value, round = Math.trunc) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, round(number)) : 0;
}

function readDamageChange(change) {
  if (!String(change?.key ?? "").trim().startsWith(DAMAGE_CHANGE_PREFIX)) return null;
  const value = change.value;
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  const cached = parsedChanges.get(change);
  if (cached?.value === value) return cached.data;
  let data = null;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed;
  } catch (_error) { /* Ignore malformed and unrelated custom effects. */ }
  parsedChanges.set(change, { value, data });
  return data;
}
