import { localize as auditLocalize, format as auditFormat } from "../utils/i18n.mjs";
import { createToolGroupKey } from "../utils/tool-selection-policy.mjs";

const TOOL_CLASS_RANK = Object.freeze({ D: 0, C: 1, B: 2, A: 3, S: 4 });
const TOOL_CLASSES_BY_RANK = Object.freeze(["D", "C", "B", "A", "S"]);

export const MEDICINE_TOOL_AVAILABILITY = Object.freeze({
  available: "available",
  noTargets: "noTargets",
  missingTool: "missingTool",
  selectedGroups: "selectedGroups",
  toolClass: "toolClass",
  depleted: "depleted",
  toolSkill: "toolSkill",
  treatmentSkill: "treatmentSkill"
});

/**
 * Describe whether at least one medical instrument can be used for at least
 * one treatment. The function receives plain snapshots so the same decision
 * can be exercised without a Foundry client.
 */
export function analyzeMedicineToolAvailability({
  instruments = [],
  treatments = [],
  toolKey = "medical",
  toolLabel = "",
  allowedToolGroupKeys = []
} = {}) {
  const normalizedTreatments = Array.isArray(treatments) ? treatments.filter(Boolean) : [];
  if (!normalizedTreatments.length) {
    return unavailable(
      MEDICINE_TOOL_AVAILABILITY.noTargets,
      auditLocalize("FALLOUTMAW.AuditApps.ThereAreNoTraumasOrDamagedBodyParts", "Нет травм или повреждённых частей тела для массового лечения.")
    );
  }

  const requiredToolKey = String(toolKey ?? "").trim();
  const normalizedInstruments = (Array.isArray(instruments) ? instruments : [])
    .filter(Boolean)
    .filter(instrument => (
      !requiredToolKey
      || String(instrument?.toolKey ?? "").trim() === requiredToolKey
    ));
  if (!normalizedInstruments.length) {
    const label = String(toolLabel ?? requiredToolKey ?? "").trim();
    return unavailable(
      MEDICINE_TOOL_AVAILABILITY.missingTool,
      auditFormat("FALLOUTMAW.AuditApps.NoMedicalTool", { v0: (label ? ` «${label}»` : "") }, "Нет медицинского инструмента{v0}.")
    );
  }

  const allowedGroups = new Set(
    (Array.isArray(allowedToolGroupKeys) ? allowedToolGroupKeys : [])
      .map(value => String(value ?? "").trim())
      .filter(Boolean)
  );
  const selectedInstruments = allowedGroups.size
    ? normalizedInstruments.filter(instrument => allowedGroups.has(
        createToolGroupKey(instrument?.toolKey, instrument?.toolClass)
      ))
    : normalizedInstruments;
  if (!selectedInstruments.length) {
    return unavailable(
      MEDICINE_TOOL_AVAILABILITY.selectedGroups,
      auditLocalize("FALLOUTMAW.AuditApps.TheSelectedGroupsOfMedicalToolsAreNo", "Выбранные группы медицинских инструментов больше недоступны.")
    );
  }

  const classMatches = createMatches(
    selectedInstruments,
    normalizedTreatments,
    ({ instrument, treatment }) => (
      toToolClassRank(instrument?.toolClass)
      >= Math.max(
        0,
        toToolClassRank(treatment?.healingToolClass)
          - Math.max(0, toInteger(treatment?.allowedToolClassDeficit))
      )
    )
  );
  if (!classMatches.length) {
    const closest = selectClosestClassMatch(selectedInstruments, normalizedTreatments);
    const originalRequiredClass = normalizeToolClass(closest?.treatment?.healingToolClass);
    const allowedDeficit = Math.max(0, toInteger(closest?.treatment?.allowedToolClassDeficit));
    const requiredClass = TOOL_CLASSES_BY_RANK[Math.max(
      0,
      toToolClassRank(originalRequiredClass) - allowedDeficit
    )];
    const availableClass = normalizeToolClass(closest?.instrument?.toolClass);
    return unavailable(
      MEDICINE_TOOL_AVAILABILITY.toolClass,
      auditFormat("FALLOUTMAW.AuditApps.TreatmentRequiresAMedicalToolOfClassOr", { v0: (requiredClass), v1: (availableClass) }, "Для лечения нужен медицинский инструмент класса {v0} или выше; доступен класс {v1}.")
    );
  }

  const suppliedMatches = classMatches.filter(({ instrument }) => (
    toFiniteNumber(instrument?.supplyValue) > 0
  ));
  if (!suppliedMatches.length) {
    const labels = joinLabels(classMatches.map(({ instrument }) => instrument?.name));
    return unavailable(
      MEDICINE_TOOL_AVAILABILITY.depleted,
      auditFormat("FALLOUTMAW.AuditApps.SuitableMedicalToolsHaveNoSupplies", { v0: (labels ? `: ${labels}` : ".") }, "У подходящих медицинских инструментов нет запаса{v0}")
    );
  }

  const toolSkillMatches = suppliedMatches.filter(({ instrument }) => (
    Boolean(instrument?.requirementMet)
  ));
  if (!toolSkillMatches.length) {
    const closest = selectClosestToolSkillMatch(suppliedMatches);
    const instrument = closest?.instrument ?? {};
    const skillLabel = String(instrument.skillLabel ?? "").trim() || auditLocalize("FALLOUTMAW.AuditApps.RequiredSkill", "требуемого навыка");
    return unavailable(
      MEDICINE_TOOL_AVAILABILITY.toolSkill,
      auditFormat("FALLOUTMAW.AuditApps.UsingRequiresCurrently", { v0: (String(instrument.name ?? auditLocalize("FALLOUTMAW.AuditApps.MedicalTool", "медицинского инструмента"))), v1: (toInteger(instrument.skillValue)), v2: (skillLabel), v3: (toInteger(instrument.actorSkillValue)) }, "Для использования «{v0}» нужно {v1} {v2} (сейчас {v3}).")
    );
  }

  const treatmentSkillMatches = toolSkillMatches.filter(({ treatment }) => (
    treatment?.skillThreshold?.met !== false
  ));
  if (!treatmentSkillMatches.length) {
    const closest = selectClosestTreatmentSkillMatch(toolSkillMatches);
    const treatment = closest?.treatment ?? {};
    const threshold = treatment.skillThreshold ?? {};
    const treatmentName = String(treatment.name ?? auditLocalize("FALLOUTMAW.AuditApps.Target_719", "цели")).trim();
    const skillLabel = String(threshold.skillLabel ?? "").trim() || auditLocalize("FALLOUTMAW.AuditApps.RequiredSkill", "требуемого навыка");
    return unavailable(
      MEDICINE_TOOL_AVAILABILITY.treatmentSkill,
      auditFormat("FALLOUTMAW.AuditApps.TreatingRequiresCurrently", { v0: (treatmentName), v1: (toInteger(threshold.difficulty)), v2: (skillLabel), v3: (toInteger(threshold.skillValue)) }, "Для лечения «{v0}» нужно {v1} {v2} (сейчас {v3}).")
    );
  }

  return {
    ok: true,
    code: MEDICINE_TOOL_AVAILABILITY.available,
    message: "",
    instruments: uniqueInstruments(treatmentSkillMatches.map(({ instrument }) => instrument))
  };
}

function createMatches(instruments, treatments, predicate) {
  const matches = [];
  for (const treatment of treatments) {
    for (const instrument of instruments) {
      const match = { instrument, treatment };
      if (predicate(match)) matches.push(match);
    }
  }
  return matches;
}

function selectClosestClassMatch(instruments, treatments) {
  return createMatches(instruments, treatments, () => true)
    .sort((left, right) => (
      getClassDeficit(left) - getClassDeficit(right)
      || String(left.treatment?.name ?? "").localeCompare(String(right.treatment?.name ?? ""))
      || String(left.instrument?.name ?? "").localeCompare(String(right.instrument?.name ?? ""))
    ))
    .at(0) ?? null;
}

function selectClosestToolSkillMatch(matches) {
  return [...matches].sort((left, right) => (
    getToolSkillDeficit(left.instrument) - getToolSkillDeficit(right.instrument)
    || String(left.instrument?.name ?? "").localeCompare(String(right.instrument?.name ?? ""))
  )).at(0) ?? null;
}

function selectClosestTreatmentSkillMatch(matches) {
  return [...matches].sort((left, right) => (
    getTreatmentSkillDeficit(left.treatment) - getTreatmentSkillDeficit(right.treatment)
    || String(left.treatment?.name ?? "").localeCompare(String(right.treatment?.name ?? ""))
  )).at(0) ?? null;
}

function getClassDeficit({ instrument, treatment }) {
  return Math.max(
    0,
    toToolClassRank(treatment?.healingToolClass) - toToolClassRank(instrument?.toolClass)
  );
}

function getToolSkillDeficit(instrument) {
  return Math.max(
    0,
    toInteger(instrument?.skillValue) - toInteger(instrument?.actorSkillValue)
  );
}

function getTreatmentSkillDeficit(treatment) {
  const threshold = treatment?.skillThreshold ?? {};
  return Math.max(0, toInteger(threshold.difficulty) - toInteger(threshold.skillValue));
}

function uniqueInstruments(instruments) {
  const unique = new Map();
  for (const instrument of instruments) {
    const key = String(instrument?.id ?? "");
    if (!unique.has(key)) unique.set(key, instrument);
  }
  return Array.from(unique.values());
}

function joinLabels(values) {
  return Array.from(new Set(
    values
      .map(value => String(value ?? "").trim())
      .filter(Boolean)
  )).map(label => `«${label}»`).join(", ");
}

function normalizeToolClass(value) {
  const normalized = String(value ?? "D").trim().toUpperCase();
  return Object.hasOwn(TOOL_CLASS_RANK, normalized) ? normalized : "D";
}

function toToolClassRank(value) {
  return TOOL_CLASS_RANK[normalizeToolClass(value)];
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function toInteger(value) {
  return Math.trunc(toFiniteNumber(value));
}

function unavailable(code, message) {
  return {
    ok: false,
    code,
    message,
    instruments: []
  };
}
