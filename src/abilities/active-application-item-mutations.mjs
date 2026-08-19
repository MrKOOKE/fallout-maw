import { normalizeTreatmentClassShift } from "../settings/abilities.mjs";

const TREATMENT_CLASSES = Object.freeze(["D", "C", "B", "A", "S"]);

export function hasActiveApplicationItemMutations(settings = {}) {
  const shift = normalizeTreatmentClassShift(settings?.treatmentClassShift);
  return shift.steps !== 0 && shift.itemTypes.length > 0;
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

export async function applyActiveApplicationItemMutations(actor = null, settings = {}, updateOptions = {}) {
  const updates = buildTreatmentClassShiftUpdates(actor, settings?.treatmentClassShift);
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
