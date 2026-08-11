import { normalizeActorDevelopment } from "./storage.mjs";
import { evaluateSkillFormulas } from "../formulas/index.mjs";
import { isSkillAdvancementMultiplierTargetApplicable } from "./skill-multiplier-effects.mjs";

export const FIXED_SIGNATURE_SKILL_MULTIPLIER = 2;

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
  if (advancementSettings?.mode === "fixed") {
    return {
      value: 1,
      parts: [{ kind: "base", label: "База", operation: "add", amount: 1 }]
    };
  }
  const effectiveSignature = Boolean(signature) && multiplierChanges?.signatureSkillsDisabled !== true;
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
    if (!isSkillAdvancementMultiplierTargetApplicable(change?.target, skillKey, { signature: effectiveSignature })) continue;
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
  const signature = Boolean(developmentSkill?.signature) && multiplierChanges?.signatureSkillsDisabled !== true;
  const investedValue = points * calculateSkillPointMultiplier(
    skillKey,
    characteristics,
    advancementSettings,
    multiplierChanges,
    { signature }
  );
  if (!signature) return investedValue;
  if (advancementSettings?.mode === "fixed") return investedValue * FIXED_SIGNATURE_SKILL_MULTIPLIER;

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

export function resolveSkillAdvancementMultiplierChanges(
  skillSettings = [],
  characteristics = {},
  advancementSettings = {},
  development = {},
  skillBases = {},
  multiplierChanges = {}
) {
  const normalized = normalizeActorDevelopment(development, [], skillSettings);
  const fixed = advancementSettings?.mode === "fixed";
  if (fixed) {
    const fixedState = {
      ...multiplierChanges,
      changes: [],
      versatileDevelopmentRules: [],
      signatureSkillsDisabled: false
    };
    const developmentBonuses = {};
    const pureValues = {};
    for (const skill of skillSettings) {
      const skillKey = String(skill?.key ?? "").trim();
      if (!skillKey) continue;
      const developmentBonus = calculateSkillDevelopmentBonus(
        skillKey,
        characteristics,
        advancementSettings,
        normalized.skills?.[skillKey],
        fixedState
      );
      developmentBonuses[skillKey] = developmentBonus;
      pureValues[skillKey] = getPureSkillValue(skillBases?.[skillKey], developmentBonus);
    }
    return {
      ...fixedState,
      versatileDevelopment: {
        active: false,
        highestPureValue: Math.max(0, ...Object.values(pureValues)),
        baselinePureValues: pureValues,
        statesBySkill: {}
      },
      developmentBonuses,
      pureValues
    };
  }

  const sourceChanges = Array.isArray(multiplierChanges?.changes) ? multiplierChanges.changes : [];
  const baseChanges = sourceChanges
    .filter(change => !String(change?.key ?? "").startsWith("fallout-maw.fixed.versatileDevelopment."));
  const baseState = {
    ...multiplierChanges,
    changes: baseChanges,
    versatileDevelopmentRules: [],
    signatureSkillsDisabled: multiplierChanges?.signatureSkillsDisabled === true
  };
  const rules = Array.isArray(multiplierChanges?.versatileDevelopmentRules)
    ? multiplierChanges.versatileDevelopmentRules.filter(rule => Number(rule?.developmentMultiplierBonus) > 0)
    : [];
  const baselineDevelopmentBonuses = {};
  const baselinePureValues = {};

  for (const skill of skillSettings) {
    const skillKey = String(skill?.key ?? "").trim();
    if (!skillKey) continue;
    const developmentBonus = calculateSkillDevelopmentBonus(
      skillKey,
      characteristics,
      advancementSettings,
      normalized.skills?.[skillKey],
      baseState
    );
    baselineDevelopmentBonuses[skillKey] = developmentBonus;
    baselinePureValues[skillKey] = getPureSkillValue(skillBases?.[skillKey], developmentBonus);
  }

  const highestPureValue = Math.max(0, ...Object.values(baselinePureValues));
  const changes = [...baseChanges];
  const statesBySkill = {};

  for (const skill of skillSettings) {
    const skillKey = String(skill?.key ?? "").trim();
    if (!skillKey) continue;
    const pureValue = Number(baselinePureValues[skillKey]) || 0;
    const gapPercent = highestPureValue > 0
      ? ((highestPureValue - pureValue) / highestPureValue) * 100
      : 0;
    const sources = [];

    for (const rule of rules) {
      const minimumGap = Math.max(0, Math.min(100, Number(rule?.minimumPureValueGapPercent) || 0));
      const bonus = Math.max(0, Number(rule?.developmentMultiplierBonus) || 0);
      const eligible = qualifiesForVersatileDevelopment(pureValue, highestPureValue, minimumGap);
      sources.push({
        id: String(rule?.id ?? ""),
        sourceName: String(rule?.sourceName ?? ""),
        sourceUuid: String(rule?.sourceUuid ?? ""),
        minimumPureValueGapPercent: minimumGap,
        developmentMultiplierBonus: bonus,
        eligible
      });
      if (!eligible || !(bonus > 0)) continue;

      changes.push({
        key: `fallout-maw.fixed.versatileDevelopment.${String(rule?.id ?? "source")}.${skillKey}`,
        target: skillKey,
        type: "add",
        value: bonus,
        priority: Number.MAX_SAFE_INTEGER,
        order: changes.length,
        sourceName: String(rule?.sourceName ?? "").trim() || "Всестороннее развитие",
        sourceImg: String(rule?.sourceImg ?? "").trim(),
        sourceUuid: String(rule?.sourceUuid ?? "").trim() || `fixed:${String(rule?.id ?? "versatileDevelopment")}`,
        fixedFunctionId: String(rule?.functionId ?? "")
      });
    }

    const eligible = sources.some(source => source.eligible);
    let nextPureValue = pureValue;
    let nextHighestPureValue = highestPureValue;
    let nextGapPercent = gapPercent;
    let eligibleAfterNextIncrease = false;
    if (eligible) {
      const currentDevelopment = normalized.skills?.[skillKey] ?? {};
      const nextDevelopmentBonus = calculateSkillDevelopmentBonus(
        skillKey,
        characteristics,
        advancementSettings,
        { ...currentDevelopment, points: Math.max(0, Number(currentDevelopment.points) || 0) + 1 },
        baseState
      );
      nextPureValue = getPureSkillValue(skillBases?.[skillKey], nextDevelopmentBonus);
      nextHighestPureValue = Math.max(highestPureValue, nextPureValue);
      nextGapPercent = nextHighestPureValue > 0
        ? ((nextHighestPureValue - nextPureValue) / nextHighestPureValue) * 100
        : 0;
      for (const source of sources) {
        source.nextEligible = qualifiesForVersatileDevelopment(
          nextPureValue,
          nextHighestPureValue,
          source.minimumPureValueGapPercent
        );
        source.willLoseBonusOnNextIncrease = source.eligible && !source.nextEligible;
      }
      eligibleAfterNextIncrease = sources.some(source => source.nextEligible);
    }

    statesBySkill[skillKey] = {
      pureValue,
      highestPureValue,
      gapPercent,
      nextPureValue,
      nextHighestPureValue,
      nextGapPercent,
      eligible,
      eligibleAfterNextIncrease,
      willLoseBonusOnNextIncrease: eligible && !eligibleAfterNextIncrease,
      sources
    };
  }

  const resolvedState = {
    ...multiplierChanges,
    changes,
    versatileDevelopmentRules: rules,
    signatureSkillsDisabled: multiplierChanges?.signatureSkillsDisabled === true,
    versatileDevelopment: {
      active: rules.length > 0,
      highestPureValue,
      baselinePureValues,
      statesBySkill
    }
  };
  const developmentBonuses = calculateSkillDevelopmentBonuses(
    skillSettings,
    characteristics,
    advancementSettings,
    normalized,
    resolvedState
  );
  const pureValues = Object.fromEntries(skillSettings.map(skill => {
    const skillKey = String(skill?.key ?? "").trim();
    return [skillKey, getPureSkillValue(skillBases?.[skillKey], developmentBonuses?.[skillKey])];
  }));

  return { ...resolvedState, developmentBonuses, pureValues };
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
  if (Object.hasOwn(multiplierChanges?.pureValues ?? {}, skillKey)) {
    return Math.max(0, Math.trunc(Number(multiplierChanges.pureValues[skillKey]) || 0));
  }
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

function getPureSkillValue(baseValue = 0, developmentBonus = 0) {
  return Math.max(0, Math.trunc((Number(baseValue) || 0) + (Number(developmentBonus) || 0)));
}

function qualifiesForVersatileDevelopment(pureValue = 0, highestPureValue = 0, minimumGapPercent = 0) {
  const pure = Number(pureValue) || 0;
  const highest = Number(highestPureValue) || 0;
  const minimumGap = Math.max(0, Math.min(100, Number(minimumGapPercent) || 0));
  return highest > 0
    && pure < highest
    && ((highest - pure) * 100) >= (highest * minimumGap);
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
