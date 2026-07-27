/**
 * Keep Attack Power and critical-failure references aligned when an author
 * changes the type or actor-resource key of a base weapon cost.
 *
 * Rows are matched by their stable id. A reference follows a renamed row only
 * when its old composite identity is no longer provided by another base row.
 * References without any remaining base identity are removed.
 */
export function reconcileWeaponResourceCostReferences(
  data = {},
  previousResourceCosts = [],
  { defaultType = "" } = {}
) {
  if (!data || typeof data !== "object" || !Object.hasOwn(data, "resourceCosts")) return data;
  const currentCosts = toRows(data.resourceCosts);
  const previousCosts = toRows(previousResourceCosts);
  const currentIdentities = new Set(
    currentCosts.map(cost => getWeaponResourceCostReferenceIdentity(cost, { defaultType })).filter(Boolean)
  );
  if (String(data.damageMode ?? "") === "source") currentIdentities.add("magazine");

  const previousById = new Map(previousCosts
    .map(cost => [String(cost?.id ?? "").trim(), cost])
    .filter(([id]) => id));
  const replacements = new Map();
  for (const cost of currentCosts) {
    const id = String(cost?.id ?? "").trim();
    const previous = previousById.get(id);
    if (!previous) continue;
    const from = getWeaponResourceCostReferenceIdentity(previous, { defaultType });
    const to = getWeaponResourceCostReferenceIdentity(cost, { defaultType });
    if (from && to && from !== to && !currentIdentities.has(from)) replacements.set(from, to);
  }

  data.specialProperties = toRows(data.specialProperties).map(property => {
    if (!property || typeof property !== "object" || !property.attackPower) return property;
    return {
      ...property,
      attackPower: {
        ...property.attackPower,
        resourceCosts: reconcileAttackPowerResourceCostReferences(
          property.attackPower.resourceCosts,
          currentIdentities,
          replacements
        )
      }
    };
  });

  if (Array.isArray(data.criticalFailureConsequences)) {
    data.criticalFailureConsequences = reconcileCriticalFailureResourceCostReferences(
      data.criticalFailureConsequences,
      currentIdentities,
      replacements
    );
  }
  for (const value of Object.values(data)) {
    if (!value || typeof value !== "object" || !Array.isArray(value.criticalFailureConsequences)) continue;
    value.criticalFailureConsequences = reconcileCriticalFailureResourceCostReferences(
      value.criticalFailureConsequences,
      currentIdentities,
      replacements
    );
  }
  return data;
}

export function getWeaponResourceCostReferenceIdentity(cost = {}, { defaultType = "" } = {}) {
  const type = String(cost?.type ?? cost?.resourceType ?? defaultType).trim();
  if (!type) return "";
  if (type !== "actorResource") return type;
  const resourceKey = String(cost?.resourceKey ?? "").trim();
  return resourceKey ? `${type}:${resourceKey}` : "";
}

function reconcileAttackPowerResourceCostReferences(costs = [], currentIdentities, replacements) {
  const totals = new Map();
  for (const cost of toRows(costs)) {
    const identity = resolveReferenceIdentity(
      getWeaponResourceCostReferenceIdentity(cost),
      currentIdentities,
      replacements
    );
    if (!identity) continue;
    const { type, resourceKey } = splitResourceCostIdentity(identity);
    const current = totals.get(identity) ?? { type, resourceKey, amount: 0 };
    current.amount += toInteger(cost?.amount);
    totals.set(identity, current);
  }
  return Array.from(totals.values()).map(cost => ({
    type: cost.type,
    ...(cost.type === "actorResource" ? { resourceKey: cost.resourceKey } : {}),
    amount: cost.amount
  }));
}

function reconcileCriticalFailureResourceCostReferences(consequences = [], currentIdentities, replacements) {
  return toRows(consequences).flatMap(consequence => {
    const identity = resolveReferenceIdentity(
      getWeaponResourceCostReferenceIdentity({
        type: consequence?.resourceType,
        resourceKey: consequence?.resourceKey
      }),
      currentIdentities,
      replacements
    );
    if (!identity) return [];
    const { type, resourceKey } = splitResourceCostIdentity(identity);
    return [{
      ...consequence,
      resourceType: type,
      resourceKey: type === "actorResource" ? resourceKey : ""
    }];
  });
}

function resolveReferenceIdentity(identity = "", currentIdentities, replacements) {
  if (!identity) return "";
  if (currentIdentities.has(identity)) return identity;
  const replacement = replacements.get(identity);
  return replacement && currentIdentities.has(replacement) ? replacement : "";
}

function splitResourceCostIdentity(identity = "") {
  const separator = identity.indexOf(":");
  if (separator < 0) return { type: identity, resourceKey: "" };
  return {
    type: identity.slice(0, separator),
    resourceKey: identity.slice(separator + 1)
  };
}

function toRows(value) {
  if (Array.isArray(value)) return value;
  return value && typeof value === "object" ? Object.values(value) : [];
}

function toInteger(value) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) ? number : 0;
}
