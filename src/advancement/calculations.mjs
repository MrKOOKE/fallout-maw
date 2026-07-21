import { normalizeActorDevelopment } from "./storage.mjs";
import { evaluateSkillFormulas } from "../formulas/index.mjs";
import { isSkillAdvancementMultiplierTargetApplicable } from "./skill-multiplier-effects.mjs";

export function calculateRemainingDevelopmentPoints(development = {}) {
  const points = development?.points ?? {};
  return {
    characteristics: Math.max(0, Number(points.characteristics) || 0),
    signatureSkills: Math.max(0, Number(points.signatureSkills) || 0),
    traits: Math.max(0, Number(points.traits) || 0),
    proficiencies: Math.max(0, Number(points.proficiencies) || 0),
    skills: Math.max(0, Number(points.skills) || 0),
    researches: Math.max(0, Number(points.researches) || 0)
  };
}

export function calculateSkillPointMultiplier(
  skillKey,
  characteristics = {},
  advancementSettings = {},
  multiplierChanges = {},
  { signature = false } = {}
) {
  return getSkillPointMultiplierBreakdown(
    skillKey,
    characteristics,
    advancementSettings,
    multiplierChanges,
    { signature }
  ).value;
}

export function getSkillPointMultiplierBreakdown(
  skillKey,
  characteristics = {},
  advancementSettings = {},
  multiplierChanges = {},
  { signature = false } = {}
) {
  const entry = advancementSettings?.entries?.[skillKey] ?? {};
  const base = Number(entry?.base) || 0;
  let value = base;
  const parts = [{ kind: "base", label: "База", operation: "add", amount: base }];

  for (const [characteristicKey, coefficient] of Object.entries(entry?.characteristics ?? {})) {
    const amount = (Number(characteristics?.[characteristicKey]) || 0) * (Number(coefficient) || 0);
    value += amount;
    if (amount) parts.push({
      kind: "characteristic",
      characteristicKey,
      operation: "add",
      amount
    });
  }

  for (const change of multiplierChanges?.changes ?? []) {
    if (!isSkillAdvancementMultiplierTargetApplicable(change?.target, skillKey, { signature })) continue;
    const amount = Number(change?.value);
    if (!Number.isFinite(amount)) continue;
    const before = value;
    value = applyMultiplierChange(value, change?.type, amount);
    parts.push({
      kind: "effect",
      label: String(change?.sourceName ?? "").trim() || "Изменение эффекта",
      operation: normalizeMultiplierChangeType(change?.type),
      amount,
      before,
      after: value,
      sourceImg: String(change?.sourceImg ?? ""),
      sourceUuid: String(change?.sourceUuid ?? ""),
      key: String(change?.key ?? "")
    });
  }

  return { value, parts };
}

export function calculateSkillDevelopmentBonus(skillKey, characteristics = {}, advancementSettings = {}, developmentSkill = {}, multiplierChanges = {}) {
  const points = Math.max(0, Number(developmentSkill?.points) || 0);
  const signature = Boolean(developmentSkill?.signature);
  const investedValue = points * calculateSkillPointMultiplier(
    skillKey,
    characteristics,
    advancementSettings,
    multiplierChanges,
    { signature }
  );
  if (!signature) return investedValue;

  const signatureMultiplier = Number(advancementSettings?.signatureMultiplier) || 0;
  const signatureFlatBonus = Number(advancementSettings?.signatureFlatBonus) || 0;
  return (investedValue * signatureMultiplier) + signatureFlatBonus;
}

export function calculateSkillDevelopmentBonuses(
  skillSettings = [],
  characteristics = {},
  advancementSettings = {},
  development = {},
  multiplierChanges = {}
) {
  const normalized = normalizeActorDevelopment(development, [], skillSettings);
  return Object.fromEntries(
    skillSettings.map(skill => [
      skill.key,
      calculateSkillDevelopmentBonus(skill.key, characteristics, advancementSettings, normalized.skills?.[skill.key], multiplierChanges)
    ])
  );
}

export function calculatePureSkillDevelopmentValue(
  skillKey,
  skillSettings = [],
  characteristicSettings = [],
  characteristics = {},
  advancementSettings = {},
  development = {},
  multiplierChanges = {}
) {
  const skillBases = evaluateSkillFormulas(skillSettings, characteristicSettings, characteristics);
  const normalized = normalizeActorDevelopment(development, [], skillSettings);
  const developmentBonus = calculateSkillDevelopmentBonus(
    skillKey,
    characteristics,
    advancementSettings,
    normalized.skills?.[skillKey],
    multiplierChanges
  );
  return Math.max(0, Math.trunc((Number(skillBases?.[skillKey]) || 0) + (Number(developmentBonus) || 0)));
}

function applyMultiplierChange(value, type = "add", amount = 0) {
  const operation = normalizeMultiplierChangeType(type);
  if (operation === "multiply") return value * amount;
  if (operation === "subtract") return value - amount;
  if (operation === "override") return amount;
  if (operation === "upgrade") return Math.max(value, amount);
  if (operation === "downgrade") return Math.min(value, amount);
  return value + amount;
}

function normalizeMultiplierChangeType(type = "add") {
  const normalized = String(type ?? "add").trim();
  return ["multiply", "subtract", "override", "upgrade", "downgrade"].includes(normalized)
    ? normalized
    : "add";
}
