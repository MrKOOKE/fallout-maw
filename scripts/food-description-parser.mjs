import { parseTimedBonusChanges } from "./first-aid-description-parser.mjs";

const CHARACTERISTIC_LABELS = new Map([
  ["Сила", "strength"],
  ["Ловкость", "dexterity"],
  ["Выносливость", "endurance"],
  ["Интеллект", "intelligence"],
  ["Восприятие", "perception"],
  ["Харизма", "charisma"],
  ["Удача", "luck"]
]);

const NEED_LABELS = new Map([
  ["Голод", "hunger"],
  ["Жажда", "thirst"],
  ["Сонливость", "sleepiness"],
  ["Радиация", "radcont"]
]);

const VALID_NEED_KEYS = new Set(["hunger", "thirst", "sleepiness", "radcont"]);

export function parseFoodDescription(description = "") {
  const cleanText = stripHtml(description);
  if (!/пища|алкоголь/i.test(cleanText)) return null;

  const flatText = cleanText.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
  let organismDevText = "";
  let parsedText = flatText;
  const organismDevMatch = flatText.match(/Развитие\s+организма:\s*(.*?)(?=Сопротивление:|Потенциальная:|———|$)/is);
  if (organismDevMatch) {
    organismDevText = organismDevMatch[0];
    parsedText = flatText.replace(/Развитие\s+организма:\s*.*?(?=Сопротивление:|Потенциальная:|———|$)/is, "").trim();
  }

  const needs = [];
  const damages = [];
  const organismDevelopment = [];
  const warnings = [];
  let healthRecovery = 0;
  const { durationSeconds, changes } = parseTimedBonusChanges(flatText);

  for (const [label, needKey] of NEED_LABELS) {
    const match = parsedText.match(new RegExp(`${label}:\\s*([+-]\\d+)`, "i"));
    if (!match) continue;
    const value = Number.parseInt(match[1], 10);
    if (!Number.isFinite(value) || value === 0) continue;
    if (!VALID_NEED_KEYS.has(needKey)) {
      warnings.push(`Потребность не поддерживается: ${label}`);
      continue;
    }
    needs.push({ needKey, value });
  }

  const poisonMatch = parsedText.match(/Отравление:\s*([+-]\d+)/i);
  if (poisonMatch) {
    const value = Math.max(0, Number.parseInt(poisonMatch[1], 10) || 0);
    if (value > 0) damages.push({ damageTypeKey: "poison", value });
  }

  const healthMatch = parsedText.match(/Здоровье:\s*([+-]\d+)/i);
  if (healthMatch) {
    healthRecovery = Math.max(0, Number.parseInt(healthMatch[1], 10) || 0);
  }

  if (organismDevText) {
    const devBodyMatch = organismDevText.match(/Развитие\s+организма:\s*(.*?)(?:Сопротивление:|Потенциальная:|———|$)/is);
    const devText = devBodyMatch?.[1] ?? "";
    for (const [label, characteristicKey] of CHARACTERISTIC_LABELS) {
      const match = devText.match(new RegExp(`${label}:\\s*([+-]?\\d+(?:\\.\\d+)?)`, "i"));
      if (!match) continue;
      const value = Number.parseFloat(match[1]);
      if (!Number.isFinite(value) || value <= 0) continue;
      organismDevelopment.push({ characteristicKey, value: roundFoodValue(value) });
    }
  }

  if (/Заживление:/i.test(flatText)) warnings.push("Заживление не переносится");
  if (/Потенциальная:/i.test(flatText)) warnings.push("Механика зависимости не переносится");

  if (!needs.length && !damages.length && !organismDevelopment.length && healthRecovery <= 0 && !changes.length) {
    return null;
  }

  return {
    needs,
    damages,
    organismDevelopment,
    healthRecovery,
    durationSeconds,
    changes,
    warnings
  };
}

function roundFoodValue(value) {
  return Math.round((Math.max(0, Number(value) || 0) + Number.EPSILON) * 100) / 100;
}

function stripHtml(value = "") {
  return String(value ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}
