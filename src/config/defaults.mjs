export const DEFAULT_CHARACTERISTICS = Object.freeze([
  { key: "strength", abbr: "str", label: "Сила" },
  { key: "dexterity", abbr: "dex", label: "Ловкость" },
  { key: "endurance", abbr: "con", label: "Выносливость" },
  { key: "perception", abbr: "wis", label: "Восприятие" },
  { key: "intelligence", abbr: "int", label: "Интеллект" },
  { key: "charisma", abbr: "cha", label: "Харизма" },
  { key: "luck", abbr: "luc", label: "Удача" }
]);

export const DEFAULT_BASE_PARAMETER_POOLS = Object.freeze({
  characteristicDistributionPoints: 33,
  signatureSkillPoints: 3,
  traitPoints: 2,
  proficiencyPoints: 500
});

export const DEFAULT_LOAD_FORMULA = "20 + 10*str";

export const DEFAULT_CURRENCIES = Object.freeze([
  { key: "caps", label: "Крышки", img: "", value: 1 },
  { key: "denarii", label: "Динарии", img: "", value: 2 },
  { key: "ncrDollars", label: "Доллары НКР", img: "", value: 3 },
  { key: "brotherhoodChecks", label: "Чеки братства", img: "", value: 6 }
]);

export const DEFAULT_SKILLS = Object.freeze([
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
]);

export const DEFAULT_SIGNATURE_SKILL_MULTIPLIER = 1.5;
export const DEFAULT_SIGNATURE_SKILL_FLAT_BONUS = 15;

export const DEFAULT_SKILL_ADVANCEMENT = Object.freeze({
  rangedCombat: Object.freeze({ base: 0.7, characteristics: Object.freeze({ dexterity: 0.02, perception: 0.06 }) }),
  meleeCombat: Object.freeze({ base: 0.7, characteristics: Object.freeze({ strength: 0.06, dexterity: 0.02 }) }),
  athletics: Object.freeze({ base: 0.7, characteristics: Object.freeze({ dexterity: 0.04, strength: 0.04 }) }),
  energy: Object.freeze({ base: 0.7, characteristics: Object.freeze({ intelligence: 0.08 }) }),
  resilience: Object.freeze({ base: 0.7, characteristics: Object.freeze({ endurance: 0.08 }) }),
  throwing: Object.freeze({ base: 0.7, characteristics: Object.freeze({ dexterity: 0.04, strength: 0.02 }) }),
  firstAid: Object.freeze({ base: 0.7, characteristics: Object.freeze({ perception: 0.06, intelligence: 0.03 }) }),
  doctor: Object.freeze({ base: 0.7, characteristics: Object.freeze({ perception: 0.02, intelligence: 0.06 }) }),
  naturalist: Object.freeze({ base: 0.7, characteristics: Object.freeze({ perception: 0.08 }) }),
  stealth: Object.freeze({ base: 0.7, characteristics: Object.freeze({ dexterity: 0.08 }) }),
  lockpicking: Object.freeze({ base: 0.7, characteristics: Object.freeze({ perception: 0.04, dexterity: 0.02 }) }),
  theft: Object.freeze({ base: 0.7, characteristics: Object.freeze({ dexterity: 0.06, perception: 0.02 }) }),
  traps: Object.freeze({ base: 0.7, characteristics: Object.freeze({ perception: 0.04, dexterity: 0.04 }) }),
  science: Object.freeze({ base: 0.7, characteristics: Object.freeze({ intelligence: 0.08 }) }),
  repair: Object.freeze({ base: 0.7, characteristics: Object.freeze({ intelligence: 0.08 }) }),
  speech: Object.freeze({ base: 0.7, characteristics: Object.freeze({ charisma: 0.08 }) }),
  barter: Object.freeze({ base: 0.7, characteristics: Object.freeze({ charisma: 0.06, intelligence: 0.02 }) }),
  gambling: Object.freeze({ base: 0.7, characteristics: Object.freeze({ luck: 0.08 }) })
});

export const DEFAULT_PROFICIENCIES = Object.freeze([
  { key: "pistol", abbr: "pis", label: "Пистолет", max: 1000 },
  { key: "automatic", abbr: "aut", label: "Автомат", max: 1000 },
  { key: "rifle", abbr: "rif", label: "Винтовка", max: 1000 },
  { key: "machineGun", abbr: "mac", label: "Пулемёт", max: 1000 },
  { key: "shotgun", abbr: "sho", label: "Дробовик", max: 1000 },
  { key: "grenadeLauncher", abbr: "gla", label: "Гранатомет", max: 1000 },
  { key: "flamethrower", abbr: "fla", label: "Огнемет", max: 1000 },
  { key: "grenade", abbr: "grn", label: "Граната", max: 1000 },
  { key: "oneHandedSlashing", abbr: "ohs", label: "Одноручное режущее", max: 1000 },
  { key: "twoHandedSlashing", abbr: "ths", label: "Двуручное режущее", max: 1000 },
  { key: "oneHandedPiercing", abbr: "ohp", label: "Одноручное колющее", max: 1000 },
  { key: "twoHandedPiercing", abbr: "thp", label: "Двуручное колющее", max: 1000 },
  { key: "oneHandedBludgeoning", abbr: "ohb", label: "Одноручное дробящее", max: 1000 },
  { key: "twoHandedBludgeoning", abbr: "thb", label: "Двуручное дробящее", max: 1000 }
]);

export const DEFAULT_LIMBS = Object.freeze([
  { key: "head", label: "Голова", stateMax: 100 },
  { key: "eyes", label: "Глаза", stateMax: 100 },
  { key: "torso", label: "Туловище", stateMax: 100 },
  { key: "groin", label: "Пах", stateMax: 100 },
  { key: "leftArm", label: "Левая рука", stateMax: 100 },
  { key: "rightArm", label: "Правая рука", stateMax: 100 },
  { key: "leftLeg", label: "Левая нога", stateMax: 100 },
  { key: "rightLeg", label: "Правая нога", stateMax: 100 }
]);

export const DEFAULT_EQUIPMENT_SLOTS = Object.freeze([
  { key: "helmet", label: "Шлем" },
  { key: "glasses", label: "Очки" },
  { key: "mask", label: "Маска" },
  { key: "clothing", label: "Одежда" },
  { key: "armor", label: "Броня" },
  { key: "cloak", label: "Накидка" },
  { key: "rig", label: "Разгрузка" },
  { key: "belt", label: "Пояс" },
  { key: "backpack", label: "Рюкзак" }
]);

export const DEFAULT_WEAPON_SETS = Object.freeze([
  {
    key: "weaponSet1",
    label: "Набор 1",
    slots: [
      { key: "rightHand", limbKey: "rightArm" },
      { key: "leftHand", limbKey: "leftArm" }
    ]
  },
  {
    key: "weaponSet2",
    label: "Набор 2",
    slots: [
      { key: "rightHand", limbKey: "rightArm" },
      { key: "leftHand", limbKey: "leftArm" }
    ]
  }
]);

export const DEFAULT_INVENTORY_SIZE = Object.freeze({
  columns: 10,
  rows: 2
});

export const DEFAULT_RESOURCES = Object.freeze([
  { key: "health", abbr: "hea", label: "Здоровье", formula: "10 + str + con*2" },
  { key: "energy", abbr: "ene", label: "Энергия", formula: "100 + ene" },
  { key: "dodge", abbr: "dod", label: "Уклонение", formula: "60 + ath/3" },
  { key: "actionPoints", abbr: "act", label: "Очки действия", formula: "5 + (dex/3 + str/5)" },
  { key: "movementPoints", abbr: "mov", label: "Очки передвижения", formula: "2 + ath/50" }
]);

export const DEFAULT_NEEDS = Object.freeze([
  { key: "hunger", abbr: "hun", label: "Голод", formula: "1000" },
  { key: "thirst", abbr: "thi", label: "Жажда", formula: "1000" },
  { key: "sleepiness", abbr: "sle", label: "Сонливость", formula: "1000" }
]);

export const DEFAULT_DAMAGE_TYPES = Object.freeze([
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
]);
