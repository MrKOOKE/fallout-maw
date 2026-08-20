import {
  ABILITY_ACTION_TYPES,
  normalizeAbilityAction,
  normalizeTreatmentClassShift
} from "../settings/abilities.mjs";

const TREATMENT_CLASSES = Object.freeze(["D", "C", "B", "A", "S"]);

export function hasActiveApplicationItemMutations(abilityFunction = {}) {
  return getTreatmentClassShifts(abilityFunction).length > 0;
}

export function buildTreatmentClassShiftUpdates(actor = null, value = {}) {
  const shift = normalizeTreatmentClassShift(value);
  if (!actor || shift.steps === 0 || !shift.itemTypes.length) return [];
  const acceptedTypes = new Set(shift.itemTypes);
  const updates = [];
  for (const item of actor.items ?? []) {
    if (!acceptedTypes.has(String(item?.type ?? ""))) continue;
    const currentClass = normalizeTreatmentClass(item.system?.healingToolClass);
    const currentIndex = TREATMENT_CLASSES.indexOf(currentClass);
    const nextClass = TREATMENT_CLASSES[Math.max(0, Math.min(
      TREATMENT_CLASSES.length - 1,
      currentIndex + shift.steps
    ))];
    if (nextClass === currentClass) continue;
    updates.push({
      _id: String(item.id),
      "system.healingToolClass": nextClass
    });
  }
  return updates;
}

export function buildActiveApplicationItemMutationUpdates(actor = null, abilityFunction = {}) {
  const shifts = getTreatmentClassShifts(abilityFunction);
  if (!actor || !shifts.length) return [];
  const updates = [];
  for (const item of actor.items ?? []) {
    const itemType = String(item?.type ?? "");
    const currentClass = normalizeTreatmentClass(item.system?.healingToolClass);
    let nextIndex = TREATMENT_CLASSES.indexOf(currentClass);
    for (const shift of shifts) {
      if (!shift.itemTypes.includes(itemType)) continue;
      nextIndex = Math.max(0, Math.min(TREATMENT_CLASSES.length - 1, nextIndex + shift.steps));
    }
    const nextClass = TREATMENT_CLASSES[nextIndex];
    if (nextClass === currentClass) continue;
    updates.push({ _id: String(item.id), "system.healingToolClass": nextClass });
  }
  return updates;
}

export async function applyActiveApplicationItemMutations(actor = null, abilityFunction = {}, updateOptions = {}) {
  const updates = buildActiveApplicationItemMutationUpdates(actor, abilityFunction);
  if (!updates.length) return { actor, changed: 0, rollbackUpdates: [] };
  const rollbackUpdates = updates.map(update => ({
    _id: update._id,
    "system.healingToolClass": normalizeTreatmentClass(
      actor.items?.get?.(update._id)?.system?.healingToolClass
    )
  }));
  await actor.updateEmbeddedDocuments("Item", updates, updateOptions);
  return { actor, changed: updates.length, rollbackUpdates, updateOptions };
}

function getTreatmentClassShifts(abilityFunction = {}) {
  const shifts = (abilityFunction?.actions ?? [])
    .map(action => normalizeAbilityAction(action))
    .filter(action => action.type === ABILITY_ACTION_TYPES.treatmentClassShift)
    .map(action => normalizeTreatmentClassShift(action.treatmentClassShift))
    .filter(shift => shift.steps !== 0 && shift.itemTypes.length > 0);
  if (shifts.length) return shifts;

  // Read compatibility for documents which have not yet been re-saved through
  // the normalizer that migrates this setting into an action.
  const legacy = normalizeTreatmentClassShift(
    abilityFunction?.activeSettings?.treatmentClassShift ?? abilityFunction?.treatmentClassShift
  );
  return legacy.steps !== 0 && legacy.itemTypes.length > 0 ? [legacy] : [];
}

export async function rollbackActiveApplicationItemMutations(results = []) {
  for (const result of [...results].reverse()) {
    if (!result?.actor || !result.rollbackUpdates?.length) continue;
    try {
      await result.actor.updateEmbeddedDocuments("Item", result.rollbackUpdates, result.updateOptions ?? {});
    } catch (error) {
      console.error("Fallout MaW | Failed to roll back active application item mutations", error);
    }
  }
}

function normalizeTreatmentClass(value) {
  const normalized = String(value ?? "D").trim().toUpperCase();
  return TREATMENT_CLASSES.includes(normalized) ? normalized : "D";
}
