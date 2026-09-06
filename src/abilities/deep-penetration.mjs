/** Expand a damage-hub batch back into the original per-impact rows. */
export function extractDeepPenetrationDamageRows(results = []) {
  const rows = [];
  for (const result of (Array.isArray(results) ? results : [results]).flat(Infinity).filter(Boolean)) {
    const applications = Array.isArray(result?.damageApplications) && result.damageApplications.length
      ? result.damageApplications
      : [result];
    for (const application of applications) {
      const source = application?.source && typeof application.source === "object"
        ? application.source
        : result?.source && typeof result.source === "object" ? result.source : {};
      rows.push({
        actorUuid: String(application?.actor?.uuid ?? application?.actorUuid ?? result?.actor?.uuid ?? result?.actorUuid ?? ""),
        targetTokenUuid: String(source.targetTokenUuid ?? application?.targetTokenUuid ?? result?.targetTokenUuid ?? ""),
        limbKey: String(application?.limbKey ?? result?.limbKey ?? ""),
        damageTypeKey: String(application?.damageTypeKey ?? result?.damageTypeKey ?? ""),
        incomingAmount: Math.max(0, finiteNumber(application?.incomingAmount)),
        mitigationBlocked: Math.max(0, finiteNumber(
          application?.mitigationBlocked
          ?? application?.damageMitigationDisplay?.blocked
        )),
        penetrationPower: Math.max(0, finiteNumber(source.penetrationPower)),
        pelletImpactCount: Math.max(1, Math.trunc(finiteNumber(source.pelletImpactCount)) || 1),
        pelletImpactIndex: Math.max(0, Math.trunc(finiteNumber(source.pelletImpactIndex)))
      });
    }
  }
  return rows;
}

/**
 * Convert every positive blocked packet, limiting the converted total to the
 * configured percentage of the target's incoming attack damage. Integer damage
 * is distributed proportionally so mixed damage types and pellet packets retain
 * their original structure without exceeding the aggregate cap.
 */
export function getConvertibleDeepPenetrationDamageRows(results = [], conversionLimitPercent = 0) {
  if (!Array.isArray(results) || !results.length) return [];
  const rows = [];
  let incomingTotal = 0;
  let blockedTotal = 0;
  for (const result of results) {
    const actorUuid = String(result?.actorUuid ?? "").trim();
    const damageTypeKey = String(result?.damageTypeKey ?? "").trim();
    const incomingAmount = Math.max(0, finiteNumber(result?.incomingAmount));
    if (!actorUuid || !damageTypeKey || incomingAmount <= 0) continue;
    const mitigationBlocked = Math.max(0, finiteNumber(result?.mitigationBlocked));
    incomingTotal += incomingAmount;
    if (mitigationBlocked <= 0) continue;
    blockedTotal += mitigationBlocked;
    rows.push({
      actorUuid,
      targetTokenUuid: String(result?.targetTokenUuid ?? "").trim(),
      limbKey: String(result?.limbKey ?? "").trim(),
      damageTypeKey,
      incomingAmount,
      mitigationBlocked,
      penetrationPower: Math.max(0, finiteNumber(result?.penetrationPower)),
      pelletImpactCount: Math.max(1, Math.trunc(finiteNumber(result?.pelletImpactCount)) || 1),
      pelletImpactIndex: Math.max(0, Math.trunc(finiteNumber(result?.pelletImpactIndex)))
    });
  }
  if (!rows.length || incomingTotal <= 0 || blockedTotal <= 0) return [];

  const limit = Math.max(0, Math.min(100, finiteNumber(conversionLimitPercent)));
  const convertedTotal = Math.min(blockedTotal, incomingTotal * limit / 100);
  const integerTotal = Math.max(0, Math.round(convertedTotal));
  if (integerTotal <= 0) return [];

  const scale = convertedTotal / blockedTotal;
  const allocations = rows.map((row, index) => {
    const exact = row.mitigationBlocked * scale;
    return { index, amount: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let remaining = integerTotal - allocations.reduce((sum, entry) => sum + entry.amount, 0);
  for (const entry of [...allocations].sort((left, right) => (
    right.remainder - left.remainder || left.index - right.index
  ))) {
    if (remaining <= 0) break;
    entry.amount += 1;
    remaining -= 1;
  }
  return rows
    .map((row, index) => ({ ...row, convertedAmount: allocations[index].amount }))
    .filter(row => row.convertedAmount > 0);
}

/** Select one living target, preferring the originally selected attack target. */
export function selectDeepPenetrationTargetRows(results = [], conversionLimitPercent = 0, {
  primaryActorUuid = "",
  primaryTokenUuid = "",
  targetTokenUuids = [],
  killedActorUuids = []
} = {}) {
  const groups = new Map();
  for (const row of Array.isArray(results) ? results : []) {
    const actorUuid = String(row?.actorUuid ?? "").trim();
    const tokenUuid = String(row?.targetTokenUuid ?? "").trim();
    if (!actorUuid) continue;
    const key = tokenUuid ? `token:${tokenUuid}` : `actor:${actorUuid}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const killed = new Set((killedActorUuids ?? []).map(value => String(value ?? "").trim()).filter(Boolean));
  const orderedKeys = [];
  const addKey = key => {
    if (key && groups.has(key) && !orderedKeys.includes(key)) orderedKeys.push(key);
  };
  addKey(primaryTokenUuid ? `token:${String(primaryTokenUuid).trim()}` : "");
  const normalizedPrimaryActorUuid = String(primaryActorUuid ?? "").trim();
  if (normalizedPrimaryActorUuid) {
    for (const [key, rows] of groups) {
      if (rows.some(row => row.actorUuid === normalizedPrimaryActorUuid)) addKey(key);
    }
  }
  for (const tokenUuid of targetTokenUuids ?? []) addKey(`token:${String(tokenUuid ?? "").trim()}`);
  for (const key of groups.keys()) addKey(key);

  for (const key of orderedKeys) {
    const rows = groups.get(key) ?? [];
    if (!rows.length || killed.has(String(rows[0]?.actorUuid ?? ""))) continue;
    const converted = getConvertibleDeepPenetrationDamageRows(rows, conversionLimitPercent);
    if (converted.length) return converted;
  }
  return [];
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
