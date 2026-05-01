export const DEFAULT_CHARACTERISTICS = [
  { key: "strength", abbr: "str", label: "Сила" },
  { key: "dexterity", abbr: "dex", label: "Ловкость" },
  { key: "endurance", abbr: "con", label: "Выносливость" },
  { key: "perception", abbr: "wis", label: "Восприятие" },
  { key: "intelligence", abbr: "int", label: "Интеллект" },
  { key: "charisma", abbr: "cha", label: "Харизма" },
  { key: "luck", abbr: "luc", label: "Удача" }
];

export const DEFAULT_SKILLS = [
  { key: "rangedCombat", abbr: "ran", label: "Дальний бой", formula: "10 + dex + wis*3" },
  { key: "meleeCombat", abbr: "mel", label: "Ближний бой", formula: "10 + 2 * (str + dex)" },
  { key: "athletics", abbr: "ath", label: "Атлетика", formula: "10 + (dex + str)*2" },
  { key: "energy", abbr: "ene", label: "Энергия", formula: "4 * int" },
  { key: "resilience", abbr: "res", label: "Стойкость", formula: "10 + 4 * con" },
  { key: "throwing", abbr: "thr", label: "Метание", formula: "(dex + str)*2" },
  { key: "firstAid", abbr: "fir", label: "Первая помощь", formula: "(wis + int)*2" },
  { key: "doctor", abbr: "doc", label: "Доктор", formula: "wis + int*3" },
  { key: "naturalist", abbr: "nat", label: "Натуралист", formula: "4 * (wis)" },
  { key: "stealth", abbr: "ste", label: "Скрытность", formula: "(3 * dex)" },
  { key: "lockpicking", abbr: "loc", label: "Взлом", formula: "wis + dex" },
  { key: "theft", abbr: "the", label: "Кража", formula: "dex + wis*2" },
  { key: "traps", abbr: "tra", label: "Ловушки", formula: "(wis + dex)*2" },
  { key: "science", abbr: "sci", label: "Наука", formula: "4 * int" },
  { key: "repair", abbr: "rep", label: "Ремонт", formula: "int*3 + str" },
  { key: "speech", abbr: "spe", label: "Красноречие", formula: "5 * cha" },
  { key: "barter", abbr: "bar", label: "Бартер", formula: "cha*3 + int" },
  { key: "gambling", abbr: "gam", label: "Азарт", formula: "6 * luc" }
];

export const DEFAULT_DAMAGE_TYPES = [
  { key: "piercing", label: "Колющий" },
  { key: "slashing", label: "Режущий" },
  { key: "bludgeoning", label: "Дробящий" },
  { key: "firearm", label: "Огнестрельный" },
  { key: "energy", label: "Энергетический" },
  { key: "fire", label: "Огненный" },
  { key: "cryo", label: "Криогенный" },
  { key: "electric", label: "Электрический" },
  { key: "acid", label: "Кислотный" },
  { key: "poison", label: "Ядовитый" },
  { key: "radiation", label: "Радиационный" }
];

export const FALLOUT_MAW = {
  id: "fallout-maw",
  title: "Fallout-MaW",
  actorTypes: ["character", "npc", "vehicle", "hazard"],
  itemTypes: ["gear", "weapon", "armor", "ability", "effect"],
  characteristics: Object.fromEntries(DEFAULT_CHARACTERISTICS.map(entry => [entry.key, entry.label])),
  skills: Object.fromEntries(DEFAULT_SKILLS.map(entry => [entry.key, entry.label])),
  damageTypes: Object.fromEntries(DEFAULT_DAMAGE_TYPES.map(entry => [entry.key, entry.label]))
};
