import { ABILITY_ACTIVE_APPLICATION_COST_PAYERS } from "../settings/abilities.mjs";

/**
 * Expand active-application cost rows into one vector per unique payer actor.
 * Source and target rows are merged when the source is also a selected target,
 * so formulas and overload surcharges are evaluated exactly once per actor use.
 */
export function buildActiveApplicationCostPlanEntries(sourceActor, activationCosts = [], targets = []) {
  const entriesByActor = new Map();
  const uniqueTargets = new Map();
  for (const target of targets ?? []) {
    const targetActor = target?.actor ?? null;
    const actorUuid = String(targetActor?.uuid ?? "").trim();
    if (actorUuid && !uniqueTargets.has(actorUuid)) uniqueTargets.set(actorUuid, targetActor);
  }
  for (const cost of activationCosts ?? []) {
    const payers = cost?.payer === ABILITY_ACTIVE_APPLICATION_COST_PAYERS.targets
      ? Array.from(uniqueTargets.values())
      : [sourceActor];
    for (const payer of payers) {
      const actorUuid = String(payer?.uuid ?? "").trim();
      if (!actorUuid) continue;
      const entry = entriesByActor.get(actorUuid) ?? { actor: payer, costRows: [] };
      entry.costRows.push({ ...cost });
      entriesByActor.set(actorUuid, entry);
    }
  }
  return Array.from(entriesByActor.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, entry]) => entry);
}
