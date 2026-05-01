export const DEFAULT_CHARACTERISTICS = [
  { key: "strength", label: "Сила" },
  { key: "agility", label: "Ловкость" },
  { key: "endurance", label: "Выносливость" },
  { key: "perception", label: "Восприятие" },
  { key: "intelligence", label: "Интеллект" },
  { key: "charisma", label: "Харизма" },
  { key: "luck", label: "Удача" }
];

export const DEFAULT_SKILLS = [
  { key: "rangedCombat", label: "Дальний бой", formula: "5 + dex + wis*3" },
  { key: "meleeCombat", label: "Ближний бой", formula: "5 + 2 * (str + dex)" },
  { key: "athletics", label: "Атлетика", formula: "10 + (dex + str)*2" },
  { key: "energy", label: "Энергия", formula: "4 * int" },
  { key: "resilience", label: "Стойкость", formula: "10 + 4 * con" },
  { key: "throwing", label: "Метание", formula: "10 + (dex + str)*2" },
  { key: "firstAid", label: "Первая помощь", formula: "(wis + int)*2" },
  { key: "doctor", label: "Доктор", formula: "wis + int*3" },
  { key: "naturalist", label: "Натуралист", formula: "4 * (wis)" },
  { key: "stealth", label: "Скрытность", formula: "5 + (3 * dex)" },
  { key: "lockpicking", label: "Взлом", formula: "10 + wis + dex" },
  { key: "theft", label: "Кража", formula: "dex + wis*2" },
  { key: "traps", label: "Ловушки", formula: "(wis + dex)*2" },
  { key: "science", label: "Наука", formula: "4 * int" },
  { key: "repair", label: "Ремонт", formula: "int*3 + str" },
  { key: "speech", label: "Красноречие", formula: "5 * cha" },
  { key: "barter", label: "Бартер", formula: "cha*3 + int" },
  { key: "gambling", label: "Азарт", formula: "6 * luc" }
];

export const FALLOUT_MAW = {
  id: "fallout-maw",
  title: "Fallout-MaW",
  actorTypes: ["character", "npc", "vehicle", "hazard"],
  itemTypes: ["gear", "weapon", "armor", "ability", "effect"],
  characteristics: Object.fromEntries(DEFAULT_CHARACTERISTICS.map(entry => [entry.key, entry.label])),
  skills: Object.fromEntries(DEFAULT_SKILLS.map(entry => [entry.key, entry.label]))
};
