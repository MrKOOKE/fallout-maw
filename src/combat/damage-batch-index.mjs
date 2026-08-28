/**
 * Convert the public damage-event identifier using the same coercion that the
 * damage hub historically used for per-entry comparisons.
 *
 * NaN never matched under strict equality, so malformed identifiers are
 * deliberately left out of the indexes.
 */
function normalizeDamageEventIndex(value) {
  const index = Number(value);
  return Number.isNaN(index) ? null : index;
}

function toNonNegativeNumber(value) {
  return Math.max(0, Number(value) || 0);
}

/**
 * Index applied health/limb deltas once for a completed damage batch.
 */
export function buildDamageApplicationDeltaIndex(applicationDeltas = []) {
  const index = new Map();
  for (const delta of applicationDeltas ?? []) {
    const eventIndex = normalizeDamageEventIndex(delta?.damageEventIndex);
    if (eventIndex === null) continue;
    const totals = index.get(eventIndex) ?? { healthDelta: 0, limbDelta: 0 };
    totals.healthDelta += toNonNegativeNumber(delta?.healthDelta);
    totals.limbDelta += toNonNegativeNumber(delta?.limbDelta);
    index.set(eventIndex, totals);
  }
  return index;
}

/**
 * Index the per-request barrier/result breakdown once before resolved system
 * events are emitted for a completed damage batch.
 */
export function buildDamageApplicationBreakdownIndex(applications = []) {
  const index = new Map();
  for (const application of applications ?? []) {
    const eventIndex = normalizeDamageEventIndex(application?.damageEventIndex);
    if (eventIndex === null) continue;
    const totals = index.get(eventIndex) ?? {
      incomingAmount: 0,
      amountBeforeResistance: 0,
      mitigationBlocked: 0,
      preBarrierAmount: 0,
      barrierAbsorbed: 0,
      amountAfterBarrier: 0,
      actualHealthDelta: 0,
      actualLimbDelta: 0,
      depleted: []
    };
    totals.incomingAmount += toNonNegativeNumber(application?.incomingAmount);
    totals.amountBeforeResistance += toNonNegativeNumber(application?.amountBeforeResistance);
    totals.mitigationBlocked += toNonNegativeNumber(application?.mitigationBlocked);
    totals.preBarrierAmount += toNonNegativeNumber(application?.preBarrierAmount);
    totals.barrierAbsorbed += toNonNegativeNumber(application?.barrierAbsorbed);
    totals.amountAfterBarrier += toNonNegativeNumber(
      application?.amountAfterBarrier ?? application?.amount
    );
    totals.actualHealthDelta += toNonNegativeNumber(application?.actualHealthDelta);
    totals.actualLimbDelta += toNonNegativeNumber(application?.actualLimbDelta);
    const depleted = application?.barrierDepleted ?? [];
    if (Array.isArray(depleted)) totals.depleted.push(...depleted);
    else totals.depleted.push(depleted);
    index.set(eventIndex, totals);
  }
  return index;
}

export function getDamageEventIndexEntry(index, eventIndex) {
  const normalized = normalizeDamageEventIndex(eventIndex);
  return normalized === null ? null : index?.get(normalized) ?? null;
}
