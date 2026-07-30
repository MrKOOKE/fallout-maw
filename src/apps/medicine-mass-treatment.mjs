import { normalizeToolSelectionPolicy } from "../utils/tool-selection-policy.mjs";

const DEFAULT_MAX_MASS_TREATMENT_STEPS = 512;
const MAX_SUMMARY_REASONS = 8;

export function normalizeMassTreatmentOptions(options = {}) {
  const hasCategorySelection = Object.hasOwn(options, "includeTraumas")
    || Object.hasOwn(options, "includeLimbHealth");
  const toolSelection = normalizeToolSelectionPolicy(options);
  return {
    includeTraumas: hasCategorySelection ? Boolean(options.includeTraumas) : true,
    includeLimbHealth: hasCategorySelection ? Boolean(options.includeLimbHealth) : true,
    ...toolSelection
  };
}

export function getMassTreatmentTargetCounts(targetContext = null) {
  const targets = getMassTreatmentTargets(targetContext);
  return {
    traumas: targets.traumas.length,
    limbHealth: targets.limbHealth.length
  };
}

export function getMassTreatmentTargets(targetContext = null) {
  return {
    traumas: (targetContext?.traumas ?? []).filter(isIncompleteTreatment),
    limbHealth: (targetContext?.limbs ?? []).filter(limb => isPotentialLimbHealthTarget(
      limb,
      targetContext?.actorType
    ))
  };
}

export async function runSequentialMassTreatment({
  initialContext = null,
  options = {},
  chooseInstrument,
  resolveTreatment,
  maxSteps = DEFAULT_MAX_MASS_TREATMENT_STEPS
} = {}) {
  if (typeof chooseInstrument !== "function" || typeof resolveTreatment !== "function") {
    throw new TypeError("Mass treatment requires instrument selection and treatment callbacks.");
  }

  const normalized = normalizeMassTreatmentOptions(options);
  if (!normalized.includeTraumas && !normalized.includeLimbHealth) {
    throw new Error("Выберите хотя бы один вид массового лечения.");
  }

  let targetContext = initialContext;
  const counts = getMassTreatmentTargetCounts(initialContext);
  const summary = {
    targetName: String(initialContext?.name ?? ""),
    requestedTraumas: normalized.includeTraumas ? counts.traumas : 0,
    requestedLimbHealth: normalized.includeLimbHealth ? counts.limbHealth : 0,
    attempted: 0,
    completedTraumas: 0,
    completedLimbs: 0,
    restoredTraumaProgress: 0,
    restoredLimbHealth: 0,
    charges: 0,
    skipped: 0,
    stopped: false,
    reasons: []
  };
  const state = {
    steps: 0,
    maxSteps: Math.max(1, Number.parseInt(maxSteps, 10) || DEFAULT_MAX_MASS_TREATMENT_STEPS)
  };

  const processTarget = async (treatmentType, treatmentId) => {
    while (!summary.stopped) {
      const treatment = findTreatment(targetContext, treatmentType, treatmentId);
      if (!treatment) return;
      if (treatment.treatable === false) {
        summary.skipped += 1;
        addSummaryReason(summary, treatment.unavailableReason || `Нельзя лечить: ${treatment.name ?? treatmentId}.`);
        return;
      }
      if (!isIncompleteTreatment(treatment)) return;
      if (state.steps >= state.maxSteps) {
        summary.stopped = true;
        addSummaryReason(summary, "Массовое лечение остановлено защитным пределом числа операций.");
        return;
      }

      const selection = await chooseInstrument({
        targetContext,
        treatment,
        treatmentType,
        options: normalized
      });
      const instrumentId = String(selection?.instrumentId ?? selection?.id ?? "").trim();
      if (!instrumentId) {
        summary.skipped += 1;
        addSummaryReason(summary, `Нет подходящего выбранного инструмента: ${treatment.name ?? treatmentId}.`);
        return;
      }

      state.steps += 1;
      summary.attempted += 1;
      const receipt = await resolveTreatment({
        targetContext,
        treatment,
        treatmentType,
        treatmentId,
        instrumentId,
        step: state.steps,
        options: normalized
      });
      if (receipt?.targetContext) targetContext = receipt.targetContext;
      summary.charges += Math.max(0, Number.parseInt(receipt?.spentCharges, 10) || 0);

      const initialProgress = Math.max(0, Number.parseInt(receipt?.initialProgress, 10) || 0);
      const finalProgress = Math.max(0, Number.parseInt(receipt?.finalProgress, 10) || 0);
      const progress = Math.max(0, finalProgress - initialProgress);
      if (treatmentType === "limb") summary.restoredLimbHealth += progress;
      else summary.restoredTraumaProgress += progress;

      const status = String(receipt?.status ?? "").trim();
      if (status === "alreadyComplete" || (status === "committed" && receipt?.completed)) {
        if (treatmentType === "limb") summary.completedLimbs += 1;
        else summary.completedTraumas += 1;
        return;
      }
      if (status === "committed" && receipt?.halted) {
        summary.skipped += 1;
        summary.stopped = true;
        addSummaryReason(summary, receipt?.reason || `Лечение остановлено: ${treatment.name ?? treatmentId}.`);
        return;
      }
      if (status !== "committed") {
        summary.skipped += 1;
        summary.stopped = true;
        addSummaryReason(summary, receipt?.reason || `Лечение не выполнено: ${treatment.name ?? treatmentId}.`);
        return;
      }
      if (progress <= 0) {
        summary.skipped += 1;
        addSummaryReason(summary, `Лечение не дало прогресса: ${treatment.name ?? treatmentId}.`);
        return;
      }
    }
  };

  if (normalized.includeTraumas) {
    const traumaIds = (targetContext?.traumas ?? [])
      .filter(isIncompleteTreatment)
      .map(trauma => String(trauma.id ?? ""))
      .filter(Boolean);
    for (const traumaId of traumaIds) {
      await processTarget("trauma", traumaId);
      if (summary.stopped) break;
    }
  }

  if (normalized.includeLimbHealth && !summary.stopped) {
    const limbIds = (targetContext?.limbs ?? [])
      .filter(limb => isPotentialLimbHealthTarget(limb, targetContext?.actorType))
      .map(limb => String(limb.id ?? limb.key ?? ""))
      .filter(Boolean);
    summary.requestedLimbHealth = limbIds.length;
    for (const limbId of limbIds) {
      await processTarget("limb", limbId);
      if (summary.stopped) break;
    }
  }

  return { targetContext, summary, options: normalized };
}

function findTreatment(targetContext, treatmentType, treatmentId) {
  const collection = treatmentType === "limb"
    ? targetContext?.limbs
    : targetContext?.traumas;
  return (collection ?? []).find(treatment => String(
    treatment?.id ?? treatment?.key ?? ""
  ) === String(treatmentId ?? "")) ?? null;
}

function isIncompleteTreatment(treatment) {
  const maximum = Math.max(1, Number.parseInt(treatment?.healingProgressMax, 10) || 0);
  const progress = Math.max(0, Number.parseInt(treatment?.healingProgress, 10) || 0);
  return progress < maximum;
}

function isPotentialLimbHealthTarget(limb, actorType = "") {
  if (String(actorType ?? "") === "construct") return false;
  if (limb?.missing || limb?.prosthesis) return false;
  const value = Number.parseInt(limb?.value, 10) || 0;
  const maximum = Math.max(0, Number.parseInt(limb?.max, 10) || 0);
  return value < maximum;
}

function addSummaryReason(summary, reason) {
  const normalized = String(reason ?? "").trim();
  if (!normalized || summary.reasons.includes(normalized)) return;
  if (summary.reasons.length < MAX_SUMMARY_REASONS) summary.reasons.push(normalized);
}
