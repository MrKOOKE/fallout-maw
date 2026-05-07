export function createDefaultDiseaseSettings() {
  return { diseases: [] };
}

export function normalizeDiseaseSettings(settings = {}) {
  const source = Array.isArray(settings) ? settings : Array.isArray(settings?.diseases) ? settings.diseases : [];
  return {
    diseases: source.map((entry, index) => ({
      id: String(entry?.id ?? `disease-${index + 1}`).trim() || `disease-${index + 1}`,
      name: String(entry?.name ?? "").trim() || `Болезнь ${index + 1}`,
      img: String(entry?.img ?? "").trim(),
      stages: normalizeDiseaseStages(entry?.stages)
    })).filter(entry => entry.stages.length)
  };
}

function normalizeDiseaseStages(stages) {
  const source = Array.isArray(stages) ? stages : [];
  return source.map((entry, index) => ({
    id: String(entry?.id ?? `stage-${index + 1}`).trim() || `stage-${index + 1}`,
    level: Math.max(0, toInteger(entry?.level)),
    name: String(entry?.name ?? "").trim(),
    img: String(entry?.img ?? "").trim(),
    healingDifficulty: Math.max(0, toInteger(entry?.healingDifficulty ?? 60)),
    healingToolClass: normalizeToolClass(entry?.healingToolClass),
    healingProgress: Math.max(1, toInteger(entry?.healingProgress ?? entry?.healingProgressMax ?? 100)),
    healingSkillKey: String(entry?.healingSkillKey ?? "doctor").trim() || "doctor",
    effects: normalizeEffects(entry?.effects)
  })).filter(entry => entry.level > 0);
}

function normalizeEffects(effects) {
  const source = Array.isArray(effects) ? effects : [];
  return source.map(entry => {
    const priority = Number(entry?.priority);
    const result = {
      key: String(entry?.key ?? "").trim(),
      type: String(entry?.type ?? "add").trim() || "add",
      value: String(entry?.value ?? "0"),
      phase: String(entry?.phase ?? "initial").trim() || "initial"
    };
    if (Number.isFinite(priority)) result.priority = Math.trunc(priority);
    return result;
  }).filter(entry => entry.key);
}

function normalizeToolClass(value) {
  const normalized = String(value ?? "D").trim().toUpperCase();
  return ["D", "C", "B", "A", "S"].includes(normalized) ? normalized : "D";
}

function toInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}
