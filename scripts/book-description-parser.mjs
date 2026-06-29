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
  ["Скрытность", "stealth"],
  ["Пилот", "athletics"],
  ["Запугивание", "speech"],
  ["Холодное оружие", "meleeCombat"]
]);

export function parseBookDescription(description = "") {
  const cleanText = stripHtml(description);
  if (!/журнал/i.test(cleanText)) return null;

  const changes = [];
  for (const rawLine of cleanText.split("\n")) {
    const line = rawLine.trim();
    const match = line.match(/^(.+?)\s*[:：]\s*([+-]?\d+(?:\.\d+)?)\s*$/u);
    if (!match) continue;

    const label = match[1].trim();
    if (/^журнал$/iu.test(label)) continue;

    const key = resolveBookEffectKey(label);
    if (!key) continue;

    changes.push({
      key,
      type: "add",
      value: formatSignedValue(match[2]),
      phase: "initial",
      priority: null
    });
  }

  return changes.length ? { changes } : null;
}

function resolveBookEffectKey(label = "") {
  const normalized = String(label ?? "").trim();
  if (!normalized) return "";

  const skillKey = SKILL_LABELS.get(normalized);
  if (skillKey) return `system.skills.${skillKey}.bonus`;

  const characteristicKey = ABILITY_LABELS.get(normalized);
  if (characteristicKey) return `system.characteristics.${characteristicKey}`;

  return "";
}

function formatSignedValue(value = "") {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "0";
  if (/^[+-]/.test(normalized)) return normalized;
  return `+${normalized}`;
}

function stripHtml(value = "") {
  return String(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
