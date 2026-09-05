// #region codex-runtime-debug H21 bounded request fan-out, no document payloads
const LABELS = new Set([
  "weapon.explosionDamageRequests",
  "weapon.volleyDamageRequests",
  "weapon.damagePreparedRequests",
  "damage.normalizedRequests"
]);
// Fixed diagnostic memory limit, independent of Actor inventory or game behavior.
export const DAMAGE_REQUEST_PROBE_DISTINCT_CAPACITY = 4096;

export function captureDamageRequestProbe() {
  try {
    const probe = globalThis.__falloutMawGameplayProbe;
    const runId = probe?.activeRunId?.();
    return runId && typeof probe.event === "function" ? { probe, runId } : null;
  } catch (_error) {
    return null;
  }
}

export function recordDamageRequestProbe(capture, label, requests, dimensions = {}) {
  if (!capture || !LABELS.has(label)) return false;
  try {
    if (capture.probe.activeRunId?.() !== capture.runId) return false;
    const summary = summarizeDamageRequests(requests);
    for (const key of ["attackCycles", "configuredPellets", "configuredDamageTypes"]) {
      const value = dimensions[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        summary[key] = Math.trunc(value);
      }
    }
    // A run change during diagnostic access must not stamp old work into a new run.
    if (capture.probe.activeRunId?.() !== capture.runId) return false;
    capture.probe.event(label, "H21", summary);
    return true;
  } catch (_error) {
    // Diagnostics must never change the mechanical result or request objects.
    return false;
  }
}

export function summarizeDamageRequests(requests) {
  const actors = new Map(), damageTypes = new Map(), limbs = new Map(), packets = new Map();
  const pellets = new Set();
  const capacity = { truncated: false };
  let requestCount = 0, withPelletIndex = 0, withPacketId = 0, inheritedChainRefs = 0;
  for (const request of Array.isArray(requests) ? requests : []) {
    if (!request || typeof request !== "object") continue;
    requestCount += 1;
    const source = request.source;
    const actor = request.actorUuid || request.actor;
    increment(actors, actor, capacity);
    increment(damageTypes, request.damageTypeKey, capacity);
    increment(limbs, request.limbKey, capacity);
    const packet = source?.damagePacketId || source?.conditionWearPacketId;
    if (packet) { increment(packets, packet, capacity); withPacketId += 1; }
    const pellet = source?.pelletIndex ?? source?.pelletImpactIndex;
    if (typeof pellet === "number" && Number.isFinite(pellet)) {
      if (pellets.has(pellet) || pellets.size < DAMAGE_REQUEST_PROBE_DISTINCT_CAPACITY) pellets.add(pellet);
      else capacity.truncated = true;
      withPelletIndex += 1;
    }
    if (source?.chainRef) inheritedChainRefs += 1;
  }
  const perActor = range(actors), perDamageType = range(damageTypes), perPacket = range(packets);
  return {
    requestCount,
    // When set, composition cardinalities/min/max describe retained groups only.
    // requestCount and requestsWith* counters still cover the complete collection.
    compositionTruncated: capacity.truncated ? 1 : 0,
    distinctActorCount: actors.size,
    minRequestsPerActor: perActor.min,
    maxRequestsPerActor: perActor.max,
    distinctDamageTypeCount: damageTypes.size,
    minRequestsPerDamageType: perDamageType.min,
    maxRequestsPerDamageType: perDamageType.max,
    distinctLimbCount: limbs.size,
    distinctPacketCount: packets.size,
    minRequestsPerPacket: perPacket.min,
    maxRequestsPerPacket: perPacket.max,
    requestsWithPacketId: withPacketId,
    distinctPelletIndexCount: pellets.size,
    requestsWithPelletIndex: withPelletIndex,
    requestsWithInheritedChain: inheritedChainRefs
  };
}

function increment(counts, key, capacity) {
  if (key === undefined || key === null || key === "") return;
  const count = counts.get(key);
  if (count !== undefined) counts.set(key, count + 1);
  else if (counts.size < DAMAGE_REQUEST_PROBE_DISTINCT_CAPACITY) counts.set(key, 1);
  else capacity.truncated = true;
}

function range(counts) {
  let min = Infinity, max = 0;
  for (const count of counts.values()) { min = Math.min(min, count); max = Math.max(max, count); }
  return { min: Number.isFinite(min) ? min : 0, max };
}
// #endregion codex-runtime-debug
