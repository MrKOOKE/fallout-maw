/** Preserve each physical projectile and damage type when it leaves a
 * compartment. The next target supplies identity and contextual geometry. */
export function carryConstructDamageRequests(requests = [], continuation, {
  penetrationStep = continuation?.penetrationStep ?? 0, targetTokenUuid = ""
} = {}) {
  if (!requests?.length || !continuation?.allowed) return [];
  const extraSteps = Math.max(0, Number(penetrationStep) - Number(continuation.penetrationStep));
  return (continuation.components ?? []).flatMap(component => {
    const amount = getComponentAmount(component, extraSteps);
    if (!amount) return [];
    const prototype = requests.find(request => request.damageTypeKey === component.damageTypeKey
      && request.source?.pelletImpactIndex === component.source?.pelletImpactIndex)
      ?? requests.find(request => request.damageTypeKey === component.damageTypeKey) ?? requests[0];
    const carried = component.source ?? {};
    const source = { ...carried, ...(prototype.source ?? {}),
      damagePacketId: carried.damagePacketId,
      conditionWearPacketId: carried.conditionWearPacketId || carried.damagePacketId,
      penetrationPower: carried.penetrationPower,
      penetrationStep: Math.max(0, Number(carried.penetrationStep) || 0) + extraSteps,
      constructInteriorBaseAmount: carried.constructInteriorBaseAmount,
      constructInteriorPacketIndex: carried.constructInteriorPacketIndex,
      ...(targetTokenUuid ? { targetTokenUuid } : {}) };
    delete source.constructInteriorTarget;
    return [{ ...prototype, amount, damageTypeKey: component.damageTypeKey,
      damageEventIndex: component.damageEventIndex ?? prototype.damageEventIndex, source }];
  });
}

export function getConstructContinuationDamageAmount(continuation, penetrationStep = continuation?.penetrationStep ?? 0) {
  if (!continuation?.allowed) return 0;
  const extraSteps = Math.max(0, Number(penetrationStep) - Number(continuation.penetrationStep));
  return (continuation.components ?? []).reduce((sum, component) => sum + getComponentAmount(component, extraSteps), 0);
}

function getComponentAmount(component, extraSteps) {
  const base = Math.max(0, Number(component.source?.constructInteriorBaseAmount ?? component.amount) || 0);
  return Math.max(0, Math.round((Number(component.amount) || 0) - base * .1 * extraSteps));
}
