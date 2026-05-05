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
      meterStyle: buildResearchMeterStyle(),
      fillStyle: buildResearchFillStyle(roundResearchValue(completion * 100))
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

function buildResearchMeterStyle() {
  const baseColor = "#8cb264";
  return [
    "--meter-sections: 12",
    `--meter-color: ${baseColor}`,
    `--meter-color-strong: ${mixHexColor(baseColor, "#ffffff", 0.2)}`,
    `--meter-color-dark: ${mixHexColor(baseColor, "#000000", 0.28)}`,
    `--meter-color-soft: ${hexToRgba(baseColor, 0.2)}`,
    `--meter-color-glow: ${hexToRgba(baseColor, 0.34)}`
  ].join("; ");
}

function buildResearchFillStyle(percent) {
  const baseColor = "#8cb264";
  const strongColor = mixHexColor(baseColor, "#ffffff", 0.2);
  const darkColor = mixHexColor(baseColor, "#000000", 0.28);
  return [
    `width: ${roundResearchValue(percent)}%`,
    `background: linear-gradient(180deg, ${strongColor}, ${darkColor})`,
    `box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.22), 0 0 14px ${hexToRgba(baseColor, 0.34)}`
  ].join("; ");
}

function normalizeIndicatorColor(color) {
  const normalized = String(color ?? "").trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{6}$/.test(normalized)) return `#${normalized}`;
  if (/^[0-9a-f]{3}$/.test(normalized)) return `#${normalized.split("").map(char => `${char}${char}`).join("")}`;
  return "#8f8456";
}

function mixHexColor(hexColor, mixWith, amount = 0.5) {
  const base = hexToRgb(normalizeIndicatorColor(hexColor));
  const mix = hexToRgb(normalizeIndicatorColor(mixWith));
  const ratio = Math.max(0, Math.min(1, Number(amount) || 0));
  const channels = [base.r, base.g, base.b].map((channel, index) => {
    const target = [mix.r, mix.g, mix.b][index];
    return Math.round(channel + ((target - channel) * ratio));
  });
  return `#${channels.map(channel => channel.toString(16).padStart(2, "0")).join("")}`;
}

function hexToRgba(hexColor, alpha = 1) {
  const { r, g, b } = hexToRgb(normalizeIndicatorColor(hexColor));
  const normalizedAlpha = Math.max(0, Math.min(1, Number(alpha) || 0));
  return `rgba(${r}, ${g}, ${b}, ${normalizedAlpha})`;
}

function hexToRgb(hexColor) {
  const normalized = normalizeIndicatorColor(hexColor).slice(1);
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16)
  };
}
