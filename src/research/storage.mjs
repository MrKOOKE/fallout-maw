import { localize } from "../utils/i18n.mjs";
import { clampNumber, toInteger } from "../utils/numbers.mjs";

export const RESEARCH_DEFAULT_DIFFICULTY = 60;

export function prepareResearchForStorage(research = {}, { generateId = true } = {}) {
  const target = Math.max(1, Number(research.target) || 1);
  const id = String(research.id ?? "").trim();

  return {
    id: id || (generateId ? foundry.utils.randomID() : ""),
    name: String(research.name ?? "").trim() || localize("FALLOUTMAW.Common.Untitled"),
    skillKey: String(research.skillKey ?? "").trim(),
    progress: clampResearchProgress(research.progress, target),
    target,
    difficulty: Math.max(0, toInteger(research.difficulty ?? RESEARCH_DEFAULT_DIFFICULTY))
  };
}

export function normalizeResearchCollection(researches = []) {
  return (Array.isArray(researches) ? researches : []).map(research => prepareResearchForStorage(research));
}

export function getResearchById(researches = [], researchId = "") {
  return (Array.isArray(researches) ? researches : []).find(research => research.id === researchId) ?? null;
}

export function prepareResearchesForDisplay(researches = [], skillSettings = [], actorSkills = {}) {
  const skillLabels = new Map(skillSettings.map(skill => [skill.key, skill.label]));

  return normalizeResearchCollection(researches).map(research => {
    const progress = clampResearchProgress(research.progress, research.target);
    const completion = research.target > 0 ? Math.min(progress / research.target, 1) : 0;

    return {
      ...research,
      progress,
      progressLabel: formatResearchValue(progress),
      targetLabel: formatResearchValue(research.target),
      difficulty: Math.max(0, toInteger(research.difficulty)),
      skillLabel: skillLabels.get(research.skillKey) || localize("FALLOUTMAW.Research.UnassignedSkill"),
      skillValue: Math.max(0, toInteger(actorSkills?.[research.skillKey]?.value)),
      completed: progress >= research.target,
      progressPercent: roundResearchValue(completion * 100),
      progressStyle: `width: ${roundResearchValue(completion * 100)}%;`
    };
  });
}

export function clampResearchProgress(value, target) {
  return roundResearchValue(clampNumber(value, 0, Math.max(1, Number(target) || 1)));
}

export function roundResearchValue(value) {
  return Math.round((Math.max(0, Number(value) || 0) + Number.EPSILON) * 100) / 100;
}

export function formatResearchValue(value) {
  const numeric = roundResearchValue(value);
  if (Number.isInteger(numeric)) return String(numeric);
  return numeric.toFixed(2).replace(/\.?0+$/, "");
}
