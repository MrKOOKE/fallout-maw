export function parseToolDescription(description = "") {
  const cleanText = stripHtml(description);
  if (!cleanText) return null;

  const repair = parseRepairToolDescription(cleanText);
  if (repair) return repair;

  const medical = parseMedicalToolDescription(cleanText);
  if (medical) return medical;

  const hack = parseHackToolDescription(cleanText);
  if (hack) return hack;

  return null;
}

export function convertParsedToolToFunction(parsed = null) {
  if (!parsed?.toolKey) return null;

  return {
    tool: {
      enabled: true,
      toolKey: parsed.toolKey
    },
    tools: {
      [parsed.toolKey]: {
        enabled: true,
        useAsItem: false,
        toolClass: normalizeToolClass(parsed.toolClass),
        supply: {
          value: Math.max(0, parseInteger(parsed.supply?.value)),
          max: Math.max(0, parseInteger(parsed.supply?.max))
        },
        skillValue: Math.max(0, parseInteger(parsed.skillValue)),
        skillKey: String(parsed.skillKey ?? "")
      }
    }
  };
}

function parseRepairToolDescription(cleanText) {
  const classMatch = cleanText.match(/Ремонтные детали:\s*([A-D]|S\+?)\s*класса/i);
  if (!classMatch) return null;

  const supply = parseSupply(cleanText);
  if (!supply) return null;

  return {
    kind: "repair",
    toolKey: "repair",
    toolClass: normalizeToolClass(classMatch[1]),
    supply,
    skillValue: parseSkillRequirement(cleanText),
    skillKey: "repair",
    usageCategories: parseRepairUsageCategories(cleanText)
  };
}

function parseMedicalToolDescription(cleanText) {
  const classMatch = cleanText.match(/(?:Медицинский набор|Детоксин)\s*\(([A-D]|S)\)\s*класса/i);
  if (!classMatch) return null;

  const supply = parseSupply(cleanText);
  if (!supply) return null;

  return {
    kind: "medical",
    toolKey: "medical",
    toolClass: normalizeToolClass(classMatch[1]),
    supply,
    skillValue: parseSkillRequirement(cleanText),
    skillKey: "doctor"
  };
}

function parseHackToolDescription(cleanText) {
  const classMatch = cleanText.match(/Инструмент взлома:\s*([A-D]|S\+?)\s*класса/i);
  if (!classMatch) return null;

  const supply = parseSupply(cleanText);
  if (!supply) return null;

  const lockTypeMatch = cleanText.match(/Тип\s+замка:\s*(Электронный|Механический)/i);
  const lockType = lockTypeMatch?.[1]?.toLowerCase() ?? "";
  const toolKey = lockType.startsWith("элект") ? "electronicHacking" : "mechanicalHacking";

  return {
    kind: "hack",
    toolKey,
    toolClass: normalizeToolClass(classMatch[1]),
    supply,
    skillValue: parseSkillRequirement(cleanText),
    skillKey: "lockpicking",
    lockType: lockTypeMatch?.[1] ?? ""
  };
}

function parseSupply(text) {
  const match = text.match(/Запас:\s*(\d+)\s*\/\s*(\d+)/i);
  if (!match) return null;
  return {
    value: parseInteger(match[1]),
    max: parseInteger(match[2])
  };
}

function parseSkillRequirement(text) {
  const match = text.match(/Значение навыка для использования:\s*(\d+)/i);
  return match ? parseInteger(match[1]) : 0;
}

function parseRepairUsageCategories(text) {
  const match = text.match(/Используется для:\s*([^\.]+)/i);
  if (!match) return [];
  return match[1]
    .split(/[,;]|\s+и\s+/i)
    .map(part => part.trim())
    .filter(Boolean);
}

function normalizeToolClass(value) {
  const normalized = String(value ?? "D").trim().toUpperCase().replace("+", "");
  if (normalized === "S") return "S";
  if (/^[A-D]$/.test(normalized)) return normalized;
  return "D";
}

function stripHtml(value = "") {
  return String(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function parseInteger(value) {
  return Math.trunc(Number(value) || 0);
}
