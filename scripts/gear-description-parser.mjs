const DAMAGE_TYPE_LABELS = new Map([
  ["Колющий", "piercing"],
  ["Режущий", "slashing"],
  ["Дробящий", "bludgeoning"],
  ["Огнестрельный", "firearm"],
  ["Энергетический", "energy"],
  ["Огненный", "fire"],
  ["Криогенный", "cryo"],
  ["Электрический", "electric"],
  ["Кислота", "acid"],
  ["Ядовитый", "poison"]
]);

const CALIBER_ALIASES = new Map([
  ["20", "20-мм"],
  ["20 кал", "20-мм"],
  ["20 кал.", "20-мм"],
  ["12", "12 кал."],
  ["12 кал", "12 кал."],
  ["308", ".308"],
  ["45-70", "45-70"],
  ["9", "9-мм"],
  ["9-11", "9-11"],
  ["10", "10-мм"],
  ["14", "14-мм"],
  ["223", "0.223"],
  ["0.223", "0.223"],
  ["357", ".357"],
  ["410", ".410"],
  ["32", ".32"],
  ["44", ".44"],
  ["45", ".45"],
  ["50", ".50"],
  ["762", "7.62-мм"],
  ["556", "5.56-мм"],
  ["47", "4.7-мм"],
  ["127", "12.7-мм"],
  ["22-lr", "22-LR"],
  ["22 lr", "22-LR"]
]);

export function stripGearHtml(value = "") {
  return String(value ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\r/g, "")
    .trim();
}

export function parseGearDescription(description = "") {
  const cleanText = stripGearHtml(description);
  if (!cleanText) return null;

  const flatText = cleanText.replace(/\s+/g, " ").trim();
  const condition = parseConditionFields(flatText);
  const caliber = parseCaliber(flatText);

  return {
    caliber,
    caliberKey: normalizeCaliberKey(caliber),
    ...condition
  };
}

export function parseAmmoDamageSource(description = "", itemName = "") {
  const cleanText = stripGearHtml(description);
  if (!cleanText) return null;

  const flatText = cleanText.replace(/\s+/g, " ").trim();
  if (!/патрон/i.test(flatText) && !/калибр:/i.test(flatText)) return null;

  const caliber = parseCaliber(flatText);
  const caliberKey = normalizeCaliberKey(caliber);
  const ammoType = matchField(flatText, /Тип\s+боеприпаса:\s*([^]+?)(?=Дробь:|Потеря|Максимальная|Распределение|$)/i);
  const pellets = parseSignedNumber(matchField(flatText, /Дробь:\s*(?:=)?\s*([+-]?\d+)/i));
  const damageTypes = parseDamageDistribution(flatText);
  const primaryType = damageTypes[0]?.key ?? "firearm";

  return stripDamageSourceMigrationFields({
    enabled: true,
    name: buildDamageSourceName(caliber, caliberKey, ammoType, itemName),
    damage: "0",
    pellets: String(Math.max(1, pellets || 1)),
    damageTypeKey: primaryType,
    damageTypes: damageTypes.length ? damageTypes : [{ key: "firearm", percent: 100 }],
    attackAnimationKey: "",
    attackSoundPath: "",
    attackAnimationDelayMs: 0,
    accuracyBonus: formatSignedPercent(matchField(flatText, /Точность:\s*([+-]?\d+(?:[.,]\d+)?%?)/i)),
    criticalChanceModifier: formatSignedPercent(matchField(flatText, /Шанс\s+на\s+крит:\s*([+-]?\d+(?:[.,]\d+)?%?)/i)),
    criticalDamagePercent: formatSignedPercent(matchField(flatText, /Крит\s+урон:\s*([+-]?\d+(?:[.,]\d+)?%?)/i)),
    maxRangeMeters: formatSignedNumber(matchField(flatText, /Максимальная\s+дистанция:\s*([+-]?\d+(?:[.,]\d+)?)/i)),
    effectiveRange: parseEffectiveRange(flatText),
    penetration: formatSignedNumber(matchField(flatText, /Пробивная\s+сила:\s*([+-]?\d+(?:[.,]\d+)?)/i)),
    volley: {
      damageRadius: "0",
      regionRadius: "0",
      regionDamageEntries: [],
      regionDurationSeconds: "0",
      regionDelaySeconds: "0",
      regionRadiusDeltaMeters: "0",
      explosionAnimationKey: "",
      explosionSoundPath: ""
    },
    caliber,
    caliberKey,
    ammoType: String(ammoType ?? "").trim()
  });
}

function buildDamageSourceName(caliber, caliberKey, ammoType, itemName) {
  const caliberLabel = String(caliber ?? "").trim() || String(caliberKey ?? "").trim();
  if (!caliberLabel) return String(itemName ?? "").trim() || "Источник урона";

  const typeLabel = String(ammoType ?? "").trim();
  if (typeLabel && !/^стандарт/i.test(typeLabel)) {
    return `${caliberLabel} · ${typeLabel}`;
  }
  return caliberLabel;
}

export function stripDamageSourceMigrationFields(damageSource = {}) {
  const next = { ...damageSource };
  delete next.caliber;
  delete next.caliberKey;
  delete next.ammoType;
  return next;
}

export function buildConditionFunction(parsed = null) {
  if (!parsed) {
    return { enabled: true };
  }

  const repairDifficulty = Math.max(0, parseInteger(parsed.repairDifficulty));
  const toolClass = normalizeToolClass(parsed.partClass);
  const value = Math.max(0, parseInteger(parsed.conditionValue));
  const max = Math.max(value, parseInteger(parsed.conditionMax));
  const weakeningThreshold = Math.max(1, parseInteger(parsed.weakeningThreshold) || 20);
  const recoveryMethods = [];

  if (repairDifficulty > 0 || toolClass) {
    recoveryMethods.push({
      type: "tools",
      toolKey: "repair",
      toolClass: toolClass || "D",
      difficulty: repairDifficulty
    });
  }

  return {
    enabled: true,
    value,
    max,
    weakeningThreshold,
    recoveryMethods
  };
}

export function buildWeaponFunction(parsed = null, { magazineSourceOldIds = [] } = {}) {
  const sourceIds = Array.from(new Set((magazineSourceOldIds ?? []).filter(Boolean)));
  const hasSources = sourceIds.length > 0;

  return {
    enabled: true,
    damageMode: hasSources ? "source" : "manual",
    magazine: {
      value: 0,
      max: Math.max(0, parseInteger(parsed?.magazineMax)),
      sourceItemUuid: sourceIds[0] ? `Item.${sourceIds[0]}` : "",
      sourceItemUuids: sourceIds.map(id => `Item.${id}`)
    }
  };
}

export function normalizeCaliberKey(caliber = "") {
  const raw = String(caliber ?? "").trim();
  if (!raw) return "";

  let normalized = raw
    .replace(/,/g, ".")
    .replace(/[«»"]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  normalized = normalized
    .replace(/(\d)\s*мм/g, "$1-мм")
    .replace(/(\d)\s*кал\.?/g, "$1 кал.")
    .replace(/^\.(\d)/, ".$1");

  if (CALIBER_ALIASES.has(normalized)) {
    return CALIBER_ALIASES.get(normalized);
  }

  const bareNumber = normalized.match(/^(\d+(?:\.\d+)?)$/);
  if (bareNumber && CALIBER_ALIASES.has(bareNumber[1])) {
    return CALIBER_ALIASES.get(bareNumber[1]);
  }

  return normalized;
}

export function resolveWeaponFolderPath(folderPath, parsed = null) {
  const parts = String(folderPath ?? "").split(" / ").filter(Boolean);
  if (parts[0] !== "Оружие") return parts.slice(1);

  const caliberLabel = parsed?.caliber || parsed?.caliberKey;
  if (caliberLabel) return [caliberLabel];

  const fallback = parts.slice(2).join(" / ") || parts[1] || "Прочее";
  return [fallback];
}

export function resolveEquipmentFolderPath(folderPath) {
  const parts = String(folderPath ?? "").split(" / ").filter(Boolean);
  if (parts[0] !== "Снаряжение") return parts.slice(1);
  return [parts[2] || parts[1] || "Прочее"];
}

export function resolveAmmoFolderPath(parsed = null) {
  const label = parsed?.caliber || parsed?.caliberKey;
  return label ? [label] : ["Прочее"];
}

function parseConditionFields(flatText) {
  const conditionMatch = flatText.match(/Состояние:\s*(\d+)\s*\/\s*(\d+)/i);
  const magazineMatch = flatText.match(/Магазин:\s*(\d+)\s*\/\s*(\d+)/i);

  return {
    repairDifficulty: parseInteger(matchField(flatText, /Сложность\s+ремонта:\s*(\d+)/i)),
    partClass: normalizeToolClass(matchField(flatText, /Мин\.?\s*класс\s+деталей:\s*([A-D]|S\+?)/i)),
    conditionValue: conditionMatch?.[1] ?? 0,
    conditionMax: conditionMatch?.[2] ?? 0,
    weakeningThreshold: parseInteger(matchField(flatText, /Порог\s+ослабления:\s*(\d+)/i)),
    magazineMax: magazineMatch?.[2] ?? 0
  };
}

function parseCaliber(flatText) {
  return String(matchField(flatText, /Калибр:\s*([^]+?)(?=Тип\s+боеприпаса:|Редкость:|Мин\.|Сложность|Состояние:|Потеря|Максимальная|$)/i) ?? "").trim();
}

function parseDamageDistribution(flatText) {
  const section = flatText.match(/Распределение\s+урона\.?\s*(.+)$/i)?.[1] ?? flatText;
  const entries = [];

  for (const [label, key] of DAMAGE_TYPE_LABELS) {
    const match = section.match(new RegExp(`${label}:\\s*([+-]?\\d+(?:[.,]\\d+)?)%?`, "i"));
    if (!match) continue;
    const percent = Math.max(0, Math.round(parseNumber(match[1])));
    if (percent <= 0) continue;
    entries.push({ key, percent });
  }

  if (!entries.length) {
    const fallback = section.match(/([A-Za-zА-Яа-яЁё-]+):\s*([+-]?\d+(?:[.,]\d+)?)%?/);
    if (fallback) {
      const key = DAMAGE_TYPE_LABELS.get(fallback[1]) ?? "firearm";
      entries.push({ key, percent: Math.max(0, Math.round(parseNumber(fallback[2]))) || 100 });
    }
  }

  if (!entries.length) return [{ key: "firearm", percent: 100 }];

  const total = entries.reduce((sum, entry) => sum + entry.percent, 0);
  if (total <= 0) return [{ key: entries[0].key, percent: 100 }];
  if (total === 100) return entries;

  return entries.map(entry => ({
    key: entry.key,
    percent: Math.max(0, Math.round((entry.percent / total) * 100))
  }));
}

function parseEffectiveRange(flatText) {
  const rangeText = matchField(flatText, /Эффективная\s+дистанция:\s*([^]+?)(?=Точность:|Шанс|Крит|Пробивная|Распределение|$)/i);
  if (!rangeText) return { value: "0", max: "0" };

  const pair = rangeText.match(/([+-]?\d+(?:[.,]\d+)?)\s*\/\s*([+-]?\d+(?:[.,]\d+)?)/);
  if (pair) {
    return {
      value: formatSignedNumber(pair[1]),
      max: formatSignedNumber(pair[2])
    };
  }

  const dash = rangeText.match(/(\d+(?:[.,]\d+)?)\s*-\s*(\d+(?:[.,]\d+)?)/);
  if (dash) {
    return {
      value: formatSignedNumber(dash[1]),
      max: formatSignedNumber(dash[2])
    };
  }

  return { value: "0", max: formatSignedNumber(rangeText) };
}

function matchField(text, pattern) {
  return text.match(pattern)?.[1] ?? "";
}

function parseInteger(value) {
  const parsed = Number.parseInt(String(value ?? "").replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseNumber(value) {
  const parsed = Number.parseFloat(String(value ?? "").replace(",", ".").replace(/[^\d.+-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseSignedNumber(value) {
  return parseInteger(value);
}

function formatSignedNumber(value) {
  const parsed = parseNumber(value);
  if (!Number.isFinite(parsed)) return "0";
  if (parsed > 0) return `+${trimNumber(parsed)}`;
  return trimNumber(parsed);
}

function formatSignedPercent(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "0";
  if (raw.includes("%")) return formatSignedNumber(raw);
  const parsed = parseNumber(raw);
  if (parsed > 0) return `+${trimNumber(parsed)}`;
  return trimNumber(parsed);
}

function trimNumber(value) {
  const rounded = Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

function normalizeToolClass(value = "") {
  const token = String(value ?? "").trim().toUpperCase();
  if (!token) return "D";
  if (token.startsWith("S")) return "S";
  if (/^[A-D]$/.test(token)) return token;
  return "D";
}
