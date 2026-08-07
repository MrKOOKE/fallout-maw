import { SYSTEM_ID } from "../constants.mjs";
import { evaluateFormula } from "../formulas/evaluation.mjs";
import { STEALTH_SETTINGS_SETTING } from "../settings/constants.mjs";
import { analyzeTokenLighting } from "./lighting.mjs";
import {
  createDefaultStealthSettings,
  normalizeStealthSettings
} from "./settings.mjs";

export const STEALTH_HIDDEN_OBSERVER_DIFFICULTY_MODIFIER = -50;

const STEALTH_RANGE_FORMULA_VARIABLES = Object.freeze(["skill", "навык"]);
const stealthRangeFormulaData = {
  variables: STEALTH_RANGE_FORMULA_VARIABLES,
  formulaVariables: { skill: 0, "навык": 0 }
};

let runtimeSettings = null;
let settingsProvider = readWorldStealthSettings;

/**
 * Return the normalized settings snapshot used by the live stealth runtime.
 * World settings only change through their registered onChange callback, which
 * calls invalidateStealthRuleCache. Keeping one snapshot avoids deep-cloning,
 * merging, and sorting the same data in every detection point test.
 */
export function getRuntimeStealthSettings() {
  if (runtimeSettings) return runtimeSettings;
  runtimeSettings = settingsProvider();
  return runtimeSettings;
}

export function configureStealthRuleSettingsProvider(provider = null) {
  settingsProvider = typeof provider === "function" ? provider : readWorldStealthSettings;
  runtimeSettings = null;
}

function readWorldStealthSettings() {
  try {
    return normalizeStealthSettings(game.settings.get(SYSTEM_ID, STEALTH_SETTINGS_SETTING));
  } catch (_error) {
    return createDefaultStealthSettings();
  }
}

export function invalidateStealthRuleCache() {
  runtimeSettings = null;
}

export function getStealthStatusId() {
  return globalThis.CONFIG?.specialStatusEffects?.INVISIBLE ?? "invisible";
}

export function isActorStealthed(actor) {
  return Boolean(actor?.statuses?.has(getStealthStatusId()));
}

export function computeStealthDifficulty(sourceToken, targetToken, settings = getRuntimeStealthSettings()) {
  const sourceActor = sourceToken?.actor;
  const targetActor = targetToken?.actor;
  if (!sourceActor || !targetActor) return null;

  const lighting = getTokenLightingAnalysis(sourceToken, settings);
  const modifiers = lighting.modifiers;
  const difficultySkillKey = String(settings.difficulty?.skillKey ?? "naturalist");
  const targetBase = Math.max(0, getActorSkillValue(targetActor, difficultySkillKey));
  const distance = measureTokenDistance(sourceToken, targetToken);
  const baseDifficulty = Math.round(targetBase);
  const hiddenObserver = isActorStealthed(targetActor);
  const hiddenObserverModifier = hiddenObserver ? STEALTH_HIDDEN_OBSERVER_DIFFICULTY_MODIFIER : 0;
  const difficulty = Math.round(baseDifficulty + modifiers.difficultyBonus + hiddenObserverModifier);

  return {
    difficulty,
    baseDifficulty,
    targetBase,
    difficultySkillKey,
    distance,
    hiddenObserver,
    hiddenObserverModifier,
    advantageCount: hiddenObserver ? 1 : 0,
    lighting: {
      ...lighting,
      modifiers
    }
  };
}

export function getTokenLightingAnalysis(token, settings = getRuntimeStealthSettings()) {
  const measured = analyzeTokenLighting(token);
  const effectiveDarkness = measured.effectiveDarkness;
  const modifiers = calculateLightingModifiers(effectiveDarkness, settings);
  return {
    ...measured,
    effectiveDarkness,
    darknessLabel: effectiveDarkness.toFixed(2),
    darknessPercent: Math.round(effectiveDarkness * 100),
    levelLabel: modifiers.levelLabel,
    condition: modifiers.condition,
    modifiers
  };
}

export function calculateLightingModifiers(effectiveDarkness, settings = getRuntimeStealthSettings()) {
  const entry = getStealthDifficultyLevel(effectiveDarkness, settings);
  return {
    difficultyBonus: Number(entry?.difficultyBonus) || 0,
    levelLabel: String(entry?.label ?? "").trim() || "Степень освещения",
    perceptionMultiplier: 1,
    radius: 0,
    threshold: Number(entry?.threshold) || 0,
    condition: `Темнота ${Number(entry?.threshold ?? 0).toFixed(2)}`
  };
}

export function calculateStealthRadius(_effectiveDarkness, settings = getRuntimeStealthSettings(), actor = null) {
  return evaluateStealthDetectionRange(actor, settings);
}

export function getDetectionRangeFactor(effectiveDarkness, settings = getRuntimeStealthSettings()) {
  const levels = Array.isArray(settings.attenuationLevels) ? settings.attenuationLevels : [];
  const level = levels.find(entry => effectiveDarkness >= Number(entry.threshold));
  const penalty = clampNumber(level?.penaltyPercent ?? 0, 0, 100);
  return Math.max(0.01, 1 - (penalty / 100));
}

export function getStealthDifficultyLevel(effectiveDarkness, settings = getRuntimeStealthSettings()) {
  const levels = Array.isArray(settings.difficultyLevels) ? settings.difficultyLevels : [];
  return levels.find(entry => effectiveDarkness >= Number(entry.threshold))
    ?? levels.at(-1)
    ?? { threshold: 0, difficultyBonus: 0 };
}

export function evaluateStealthDetectionRange(actor, settings = getRuntimeStealthSettings()) {
  const skillKey = String(settings.detection?.skillKey ?? "naturalist");
  const skill = getActorSkillValue(actor, skillKey);
  stealthRangeFormulaData.formulaVariables.skill = skill;
  stealthRangeFormulaData.formulaVariables["навык"] = skill;
  try {
    return Math.max(0, evaluateFormula(settings.detection?.rangeFormula ?? "0", stealthRangeFormulaData));
  } catch (error) {
    console.warn(`${SYSTEM_ID} | Stealth detection range formula failed: ${error.message}`);
    return 0;
  }
}

export function sceneDistanceToPixels(distance) {
  const activeCanvas = globalThis.canvas;
  const gridDistance = Math.max(0.0001, Number(activeCanvas?.scene?.grid?.distance ?? activeCanvas?.grid?.distance) || 1);
  const gridSize = Math.max(1, Number(activeCanvas?.grid?.size) || 100);
  return Math.max(0, Number(distance) || 0) * (gridSize / gridDistance);
}

export function pixelsToSceneDistance(pixels) {
  const activeCanvas = globalThis.canvas;
  const gridDistance = Math.max(0.0001, Number(activeCanvas?.scene?.grid?.distance ?? activeCanvas?.grid?.distance) || 1);
  const gridSize = Math.max(1, Number(activeCanvas?.grid?.size) || 100);
  return Math.max(0, Number(pixels) || 0) * (gridDistance / gridSize);
}

export function measureTokenDistance(left, right) {
  const leftCenter = getTokenCenter(left);
  const rightCenter = getTokenCenter(right);
  const horizontal = pixelsToSceneDistance(Math.hypot(rightCenter.x - leftCenter.x, rightCenter.y - leftCenter.y));
  const vertical = Math.abs(rightCenter.elevation - leftCenter.elevation);
  return Math.hypot(horizontal, vertical);
}

export function getTokenCenter(token) {
  const center = token?.document?.getCenterPoint?.() ?? token?.center ?? {
    x: Number(token?.document?.x) || 0,
    y: Number(token?.document?.y) || 0
  };
  return {
    x: Number(center?.x) || 0,
    y: Number(center?.y) || 0,
    elevation: Number(center?.elevation ?? token?.document?.elevation) || 0
  };
}

export function normalizePoint(point, elevation = 0) {
  return {
    x: Number(point?.x) || 0,
    y: Number(point?.y) || 0,
    elevation: Number(point?.elevation ?? elevation) || 0
  };
}

export function getActorSkillValue(actor, key) {
  return Math.max(0, Number(actor?.system?.skills?.[key]?.value) || 0);
}

export function getActorCharacteristicValue(actor, key) {
  return Number(actor?.system?.characteristics?.[key]) || 0;
}

export function canControlStealth(actor) {
  return Boolean(globalThis.game?.user?.isGM || actor?.testUserPermission?.(game.user, "OWNER"));
}

export function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}
