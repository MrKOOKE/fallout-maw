const HEALING_SCALE = 4;

const ABILITY_LABELS = new Map([
  ["Сила", "strength"],
  ["Ловкость", "dexterity"],
  ["Выносливость", "endurance"],
  ["Интеллект", "intelligence"],
  ["Восприятие", "perception"],
  ["Харизма", "charisma"],
  ["Удача", "luck"]
]);

const SKILL_LABELS = new Map([
  ["Стойкость", "resilience"],
  ["Дальний бой", "rangedCombat"],
  ["Атлетика", "athletics"],
  ["Энергия", "energy"],
  ["Азарт", "gambling"],
  ["Ближний бой", "meleeCombat"],
  ["Взлом", "lockpicking"],
  ["Кража", "theft"],
  ["Красноречие", "speech"],
  ["Ловушки", "traps"],
  ["Доктор", "doctor"],
  ["Метание", "throwing"],
  ["Натуралист", "naturalist"],
  ["Наука", "science"],
  ["Бартер", "barter"],
  ["Первая помощь", "firstAid"],
  ["Ремонт", "repair"],
  ["Скрытность", "stealth"]
]);

const NEED_LABELS = new Map([
  ["Голод", "hunger"],
  ["Жажда", "thirst"],
  ["Сонливость", "sleepiness"],
  ["Радиация", "radcont"],
  ["Радиационное заражение", "radcont"]
]);

const STOP_DOT_MAP = new Map([
  ["кровотеч", "bleeding"],
  ["обильн", "bleeding"],
  ["отравл", "poison"],
  ["горен", "fire"],
  ["горит", "fire"],
  ["охлажд", "cryo"],
  ["замор", "cryo"]
]);

export function parseFirstAidDescription(description = "") {
  if (!description) return null;

  const fullCleanText = stripHtml(description);
  if (!fullCleanText.includes("Предмет первой помощи") && !fullCleanText.includes("Ремнабор.")) return null;

  let cleanText = fullCleanText;
  let recoilText = "";
  if (fullCleanText.includes("———")) {
    const parts = fullCleanText.split("———");
    cleanText = parts[0].trim();
    recoilText = parts.slice(1).join("———").trim();
  }

  const durationPositions = parseDurationPositions(cleanText);
  const parsed = {
    maxDistance: parseNumberMatch(cleanText, /Максимальная дистанция:\s*(\d+(?:\.\d+)?)/i),
    difficulty: parseNumberMatch(cleanText, /Сложность применения:\s*([+-]?\d+(?:\.\d+)?)/i),
    actionPointCost: parseIntegerMatch(cleanText, /Стоимость применения:\s*(\d+(?:\.\d+)?)/i),
    healing: 0,
    healingIsPercentage: false,
    limbSelection: null,
    needs: [],
    removeEffects: [],
    durationSeconds: durationToSeconds(durationPositions[0]?.duration ?? 0, durationPositions[0]?.unit ?? "hours"),
    changes: [],
    withdrawalDurationSeconds: 0,
    withdrawal: []
  };

  const healthMatch = cleanText.match(/Здоровье:\s*([+-]\d+)(%?)/i);
  if (healthMatch) {
    parsed.healing = scaleGeneralHealing(parseInteger(healthMatch[1]));
    parsed.healingIsPercentage = healthMatch[2] === "%";
  }

  const bodyPartsSelectionMatch = cleanText.match(/Состояние частей тела:\s*(\d+)\s*на выбор:\s*([+-]\d+)/i);
  if (bodyPartsSelectionMatch) {
    parsed.limbSelection = {
      count: parseInteger(bodyPartsSelectionMatch[1]),
      value: parseInteger(bodyPartsSelectionMatch[2])
    };
  }

  for (const [label, needKey] of NEED_LABELS.entries()) {
    const match = cleanText.match(new RegExp(`${label}:\\s*([+-]\\d+)`, "i"));
    if (!match) continue;
    parsed.needs.push({ needKey, value: parseInteger(match[1]) });
  }

  const stopMatch = cleanText.match(/Останавливает:\s*([^\.]+)/i);
  if (stopMatch) {
    const parts = stopMatch[1]
      .replace(/[.]/g, " ")
      .replace(/\s+и\s+/gi, ",")
      .split(",")
      .map(part => part.trim().toLowerCase())
      .filter(Boolean);
    const keys = new Set();
    for (const entry of parts) {
      for (const [prefix, damageTypeKey] of STOP_DOT_MAP.entries()) {
        if (entry.startsWith(prefix)) keys.add(damageTypeKey);
      }
    }
    parsed.removeEffects = Array.from(keys).map(damageTypeKey => ({ damageTypeKey }));
  }

  appendTimedChanges(parsed.changes, cleanText, durationPositions, {
    includeHealingPerTick: true,
    scaleHealing: true
  });

  if (recoilText) {
    const recoilDurationMatch = recoilText.match(/Длительность(?:\s+отдачи)?:\s*(\d+(?:\.\d+)?)\s*(ч(?:ас)?(?:а|ов)?|м(?:ин)?(?:ут)?(?:а|ы)?|с(?:ек)?(?:унд)?(?:а|ы)?)/i);
    if (recoilDurationMatch) {
      parsed.withdrawalDurationSeconds = durationToSeconds(
        parseFloat(recoilDurationMatch[1]) || 0,
        parseDurationUnit(recoilDurationMatch[2])
      );
    }
    appendTimedChanges(parsed.withdrawal, recoilText, [{
      position: 0,
      duration: 1,
      unit: "seconds"
    }], {
      includeHealingPerTick: false,
      scaleHealing: false,
      allowWithoutDuration: true
    });
  }

  return parsed;
}

export function parseTimedBonusChanges(description = "") {
  const cleanText = stripHtml(description);
  if (!/Длительность бонуса:/i.test(cleanText)) {
    return { durationSeconds: 0, changes: [] };
  }
  const durationPositions = parseDurationPositions(cleanText);
  const changes = [];
  appendTimedChanges(changes, cleanText, durationPositions, {
    includeHealingPerTick: false,
    scaleHealing: false
  });
  return {
    durationSeconds: durationToSeconds(durationPositions[0]?.duration ?? 0, durationPositions[0]?.unit ?? "hours"),
    changes
  };
}

export function convertParsedFirstAidToFunction(parsed = null) {
  if (!parsed) return null;

  return {
    enabled: true,
    healing: Math.max(0, parseInteger(parsed.healing)),
    healingIsPercentage: Boolean(parsed.healingIsPercentage),
    durationSeconds: Math.max(0, parseInteger(parsed.durationSeconds)),
    intervalSeconds: 6,
    actionPointCost: Math.max(0, parseInteger(parsed.actionPointCost)),
    maxDistance: scaleFeetDistance(parsed.maxDistance),
    difficulty: Math.max(0, parseInteger(parsed.difficulty)),
    criticalSuccessHealingBonus: 20,
    criticalFailureDamageMin: 1,
    criticalFailureDamageMax: 10,
    charges: { value: 1, max: 1 },
    needs: Array.isArray(parsed.needs) ? parsed.needs : [],
    limbSelection: parsed.limbSelection
      ? {
        count: Math.max(0, parseInteger(parsed.limbSelection.count)),
        value: parseInteger(parsed.limbSelection.value)
      }
      : { count: 0, value: 0 },
    removeEffects: Array.isArray(parsed.removeEffects) ? parsed.removeEffects : [],
    changes: Array.isArray(parsed.changes) ? parsed.changes : [],
    withdrawalDurationSeconds: Math.max(0, parseInteger(parsed.withdrawalDurationSeconds)),
    withdrawalIntervalSeconds: 6,
    withdrawal: Array.isArray(parsed.withdrawal) ? parsed.withdrawal : []
  };
}

function appendTimedChanges(target, text, durationPositions, {
  includeHealingPerTick = false,
  scaleHealing = false,
  allowWithoutDuration = false
} = {}) {
  const push = (entry) => pushChange(target, { ...entry, durationPositions, allowWithoutDuration });

  for (const [label, key] of ABILITY_LABELS.entries()) {
    for (const match of text.matchAll(new RegExp(`${label}:\\s*([+-]\\d+)`, "gi"))) {
      push({
        key: `system.characteristics.${key}`,
        value: String(parseInteger(match[1])),
        position: match.index ?? 0
      });
    }
  }

  for (const [label, key] of SKILL_LABELS.entries()) {
    for (const match of text.matchAll(new RegExp(`${label}:\\s*([+-]\\d+)`, "gi"))) {
      push({
        key: `system.skills.${key}.bonus`,
        value: String(parseInteger(match[1])),
        position: match.index ?? 0
      });
    }
  }

  for (const match of text.matchAll(/Очки\s+действия:\s*([+-]\d+)/gi)) {
    push({
      key: "system.resources.actionPoints.bonus",
      value: String(parseInteger(match[1])),
      position: match.index ?? 0
    });
  }

  for (const match of text.matchAll(/Очки\s+передвижения:\s*([+-]\d+)/gi)) {
    push({
      key: "system.resources.movementPoints.bonus",
      value: String(parseInteger(match[1])),
      position: match.index ?? 0
    });
  }

  for (const match of text.matchAll(/Точность:\s*([+-]\d+)\s*%/gi)) {
    push({
      key: "system.combat.accuracy",
      value: String(parseInteger(match[1])),
      position: match.index ?? 0
    });
  }

  for (const match of text.matchAll(/Урон:\s*([+-]\d+)\s*%/gi)) {
    push({
      key: "system.combat.damagePercent",
      value: String(parseInteger(match[1])),
      position: match.index ?? 0
    });
  }

  for (const match of text.matchAll(/Реакция:\s*([+-]?\d+)/gi)) {
    push({
      key: "system.attributes.initiativeBonus",
      value: String(parseInteger(match[1])),
      position: match.index ?? 0
    });
  }

  if (includeHealingPerTick) {
    for (const match of text.matchAll(/заживление:\s*([+-]\d+)/gi)) {
      const value = scaleHealing ? scaleGeneralHealing(parseInteger(match[1])) : parseInteger(match[1]);
      push({
        key: "fallout-maw.healing",
        value: String(value),
        position: match.index ?? 0
      });
    }
  }
}

function pushChange(target, { key, value, position, durationPositions, allowWithoutDuration = false }) {
  if (!value) return;
  const group = pickDurationGroup(position, durationPositions);
  if (!allowWithoutDuration && group.duration <= 0) return;
  target.push({
    key,
    type: "add",
    value: String(value),
    phase: "initial",
    priority: null
  });
}

function pickDurationGroup(position, durationPositions = []) {
  let targetGroup = durationPositions[0] ?? { duration: 0, unit: "hours" };
  for (let index = 1; index < durationPositions.length; index += 1) {
    if (position >= durationPositions[index].position) targetGroup = durationPositions[index];
    else break;
  }
  return targetGroup;
}

function parseDurationPositions(text) {
  const matches = [...text.matchAll(/Длительность бонуса:\s*(\d+(?:\.\d+)?)\s*(ч(?:ас)?(?:а|ов)?|м(?:ин)?(?:ут)?(?:а|ы)?|с(?:ек)?(?:унд)?(?:а|ы)?)/gi)];
  if (!matches.length) {
    return [{ position: 0, duration: 0, unit: "hours" }];
  }
  return matches.map(match => ({
    position: match.index ?? 0,
    duration: parseFloat(match[1]) || 0,
    unit: parseDurationUnit(match[2])
  }));
}

function parseDurationUnit(unitText = "") {
  const normalized = String(unitText).toLowerCase();
  if (normalized.startsWith("с") || normalized.includes("сек")) return "seconds";
  if (normalized.startsWith("м") || normalized.includes("мин")) return "minutes";
  return "hours";
}

function durationToSeconds(duration, unit) {
  const value = Number(duration) || 0;
  if (unit === "seconds") return Math.floor(value);
  if (unit === "minutes") return Math.floor(value * 60);
  return Math.floor(value * 3600);
}

function stripHtml(value = "") {
  return String(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function parseNumberMatch(text, pattern) {
  const match = text.match(pattern);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function parseIntegerMatch(text, pattern) {
  const value = parseNumberMatch(text, pattern);
  return value === null ? null : Math.floor(value);
}

function parseInteger(value) {
  return Math.trunc(Number(value) || 0);
}

function scaleGeneralHealing(value) {
  const number = parseInteger(value);
  if (!number) return 0;
  const scaled = Math.abs(number) * HEALING_SCALE;
  return number < 0 ? -scaled : scaled;
}

function scaleFeetDistance(feet) {
  const value = Number(feet) || 0;
  if (value <= 0) return 0;
  return Math.max(1, Math.floor(value / 5));
}
