const OPERATOR_RESOURCE_KEYS = new Set(["actionPoints", "actionOrReactionPoints", "reactionPoints"]);

/** Crew pay action resources; the real weapon owner pays fuel and other resources. */
export function getWeaponResourcePayer(ownerActor, operatorActor, resourceKey) {
  return operatorActor && OPERATOR_RESOURCE_KEYS.has(String(resourceKey ?? "").trim()) ? operatorActor : ownerActor;
}

export function groupWeaponActorResourceCosts(ownerActor, operatorActor, rows = []) {
  const groups = new Map();
  for (const row of rows) {
    const actor = getWeaponResourcePayer(ownerActor, operatorActor, row.resourceKey);
    const key = actor?.uuid || actor?.id || actor;
    const group = groups.get(key) ?? { actor, costRows: [] };
    group.costRows.push({ ...row });
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * Nest compensatable resource vectors around the single Item commit. An inner
 * payment/Item failure throws through every outer afterVectorSpend callback,
 * so each payer is refunded by the existing cost registry before returning.
 */
export async function payWeaponActorResourceGroups({ groups, context, quote, pay, commit }) {
  if (!groups.length) return { ok: Boolean(await commit()), actorCosts: [] };
  const quotes = [];
  for (const group of groups) {
    const result = await quote({ actor: group.actor, costRows: group.costRows, context });
    if (!result?.ok) return { ok: false, failure: result, actorCosts: [] };
    quotes.push(result);
  }
  const actorCosts = [];
  let failure = null;
  const spend = async index => {
    if (index >= groups.length) {
      if (await commit() === false) throw new Error("Weapon Item costs did not commit.");
      return true;
    }
    const group = groups[index];
    const payment = await pay({ actor: group.actor, costRows: group.costRows,
      expectedFingerprint: quotes[index].fingerprint,
      context: { ...context, afterVectorSpend: () => spend(index + 1) } });
    if (!payment?.ok) {
      failure ??= payment;
      throw new Error("Weapon resource payer could not commit its cost vector.");
    }
    actorCosts.push(...(payment.execution?.spendReceipt?.costs ?? []).map(cost => ({ ...cost, actorUuid: group.actor?.uuid ?? "" })));
    return true;
  };
  try {
    await spend(0);
    return { ok: true, actorCosts };
  } catch (error) {
    return { ok: false, failure: failure ?? { ok: false, reason: "spendFailed", error }, actorCosts: [] };
  }
}
