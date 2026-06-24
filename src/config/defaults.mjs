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

export const DEFAULT_SKILL_POINTS_PER_LEVEL_FORMULA = "10 + int";
export const DEFAULT_RESEARCH_POINTS_PER_LEVEL_FORMULA = "1000";
export const DEFAULT_LOAD_FORMULA = "20 + 10*str";
export const DEFAULT_LOAD_LIMIT_PERCENT = 150;

export const DEFAULT_CURRENCIES = Object.freeze([
  { key: "caps", label: "Крышки", img: "", value: 1, primaryTrade: true },
  { key: "denarii", label: "Динарии", img: "", value: 2, primaryTrade: false },
  { key: "ncrDollars", label: "Доллары НКР", img: "", value: 3, primaryTrade: false },
  { key: "brotherhoodChecks", label: "Чеки братства", img: "", value: 6, primaryTrade: false }
]);

export const DEFAULT_SKILLS = Object.freeze([
  { key: "rangedCombat", abbr: "ran", label: "Дальний бой", formula: "10 + dex + wis*3", img: "icons/weapons/guns/gun-pistol-flintlock.webp" },
  { key: "meleeCombat", abbr: "mel", label: "Ближний бой", formula: "10 + 2 * (str + dex)", img: "icons/svg/combat.svg" },
  { key: "athletics", abbr: "ath", label: "Атлетика", formula: "10 + (dex + str)*2", img: "icons/svg/jump.svg" },
  { key: "energy", abbr: "ene", label: "Энергия", formula: "4 * int", img: "icons/svg/lightning.svg" },
  { key: "resilience", abbr: "res", label: "Стойкость", formula: "10 + 4 * con", img: "icons/svg/holy-shield.svg" },
  { key: "throwing", abbr: "thr", label: "Метание", formula: "(dex + str)*2", img: "icons/weapons/thrown/throwing-knife-flat-steel.webp" },
  { key: "firstAid", abbr: "fir", label: "Первая помощь", formula: "(wis + int)*2", img: "icons/svg/heal.svg" },
  { key: "doctor", abbr: "doc", label: "Доктор", formula: "wis + int*3", img: "icons/svg/pill.svg" },
  { key: "naturalist", abbr: "nat", label: "Натуралист", formula: "4 * (wis)", img: "icons/svg/oak.svg" },
  { key: "stealth", abbr: "ste", label: "Скрытность", formula: "(3 * dex)", img: "icons/svg/invisible.svg" },
  { key: "lockpicking", abbr: "loc", label: "Взлом", formula: "wis + dex", img: "icons/svg/padlock.svg" },
  { key: "theft", abbr: "the", label: "Кража", formula: "dex + wis*2", img: "icons/svg/chest.svg" },
  { key: "traps", abbr: "tra", label: "Ловушки", formula: "(wis + dex)*2", img: "icons/svg/net.svg" },
  { key: "science", abbr: "sci", label: "Наука", formula: "4 * int", img: "icons/svg/book.svg" },
  { key: "repair", abbr: "rep", label: "Ремонт", formula: "int*3 + str", img: "icons/tools/smithing/tongs-steel-grey.webp" },
  { key: "speech", abbr: "spe", label: "Красноречие", formula: "5 * cha", img: "icons/svg/mystery-man.svg" },
  { key: "barter", abbr: "bar", label: "Бартер", formula: "cha*3 + int", img: "icons/svg/coins.svg" },
  { key: "gambling", abbr: "gam", label: "Азарт", formula: "6 * luc", img: "icons/sundries/gaming/gaming-set-dice.webp" }
]);

export const DEFAULT_SIGNATURE_SKILL_MULTIPLIER = 1.5;
export const DEFAULT_SIGNATURE_SKILL_FLAT_BONUS = 15;
export const DEFAULT_SKILL_DEVELOPMENT_LIMIT = 300;

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

export const DEFAULT_PROFICIENCY_INFLUENCE = Object.freeze({
  accuracy: Object.freeze({ min: 0, max: 50 }),
  damage: Object.freeze({ min: 0, max: 25 }),
  criticalChance: Object.freeze({ min: 0, max: 0 }),
  criticalDamage: Object.freeze({ min: 0, max: 0 })
});

const DEFAULT_MISSING_LIMB_PHYSICAL_EFFECTS = Object.freeze([
  Object.freeze({ key: "system.characteristics.strength", type: "multiply", value: "0.8", phase: "initial", priority: null }),
  Object.freeze({ key: "system.characteristics.dexterity", type: "multiply", value: "0.8", phase: "initial", priority: null })
]);

const DEFAULT_MISSING_LEG_EFFECTS = Object.freeze([
  ...DEFAULT_MISSING_LIMB_PHYSICAL_EFFECTS,
  Object.freeze({ key: "system.costs.movement", type: "add", value: "1", phase: "initial", priority: null })
]);

export const DEFAULT_LIMBS = Object.freeze([
  { key: "head", label: "Голова", stateMax: "100 + con * 5", damageMultiplier: 1.3, aimedDifficultyPercent: 30, implantLimit: 1, critical: true, lossEffects: [] },
  { key: "eyes", label: "Глаза", stateMax: "100 + con * 5", damageMultiplier: 1.4, aimedDifficultyPercent: 50, implantLimit: 1, critical: false, lossEffects: Object.freeze([
    Object.freeze({ key: "status.blind", type: "add", value: "1", phase: "initial", priority: null })
  ]) },
  { key: "torso", label: "Туловище", stateMax: "100 + con * 5", damageMultiplier: 1, aimedDifficultyPercent: 0, implantLimit: 1, critical: true, lossEffects: [] },
  { key: "groin", label: "Пах", stateMax: "100 + con * 5", damageMultiplier: 1.2, aimedDifficultyPercent: 20, implantLimit: 1, critical: false, lossEffects: [] },
  { key: "leftArm", label: "Левая рука", stateMax: "100 + con * 5", damageMultiplier: 0.8, aimedDifficultyPercent: 20, implantLimit: 1, critical: false, lossEffects: DEFAULT_MISSING_LIMB_PHYSICAL_EFFECTS },
  { key: "rightArm", label: "Правая рука", stateMax: "100 + con * 5", damageMultiplier: 0.8, aimedDifficultyPercent: 20, implantLimit: 1, critical: false, lossEffects: DEFAULT_MISSING_LIMB_PHYSICAL_EFFECTS },
  { key: "leftLeg", label: "Левая нога", stateMax: "100 + con * 5", damageMultiplier: 0.8, aimedDifficultyPercent: 20, implantLimit: 1, critical: false, lossEffects: DEFAULT_MISSING_LEG_EFFECTS },
  { key: "rightLeg", label: "Правая нога", stateMax: "100 + con * 5", damageMultiplier: 0.8, aimedDifficultyPercent: 20, implantLimit: 1, critical: false, lossEffects: DEFAULT_MISSING_LEG_EFFECTS }
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

export const FIXED_RESOURCE_KEYS = Object.freeze(["health", "dodge", "actionPoints", "movementPoints"]);

export const DEFAULT_RESOURCES = Object.freeze([
  { key: "health", abbr: "hea", label: "Здоровье", formula: "limbs" },
  { key: "dodge", abbr: "dod", label: "Уклонение", formula: "60 + ath/3" },
  { key: "actionPoints", abbr: "act", label: "Очки действия", formula: "5 + (dex/3 + str/5)" },
  { key: "movementPoints", abbr: "mov", label: "Очки передвижения", formula: "2 + ath/50" }
]);

export const DEFAULT_NEEDS = Object.freeze([
  { key: "hunger", abbr: "hun", label: "Голод", formula: "1000" },
  { key: "thirst", abbr: "thi", label: "Жажда", formula: "1000" },
  { key: "sleepiness", abbr: "sle", label: "Сонливость", formula: "1000" },
  { key: "radcont", abbr: "rad", label: "Рад. Заражение", formula: "1000" }
]);

export const DEFAULT_DAMAGE_TYPES = Object.freeze([
  { key: "piercing", label: "Колющий", color: "#d9d0bd", img: "icons/weapons/daggers/dagger-straight-thin-black.webp" },
  { key: "slashing", label: "Режущий", color: "#d95c5c", img: "icons/skills/melee/strike-slashes-red.webp" },
  { key: "bludgeoning", label: "Дробящий", color: "#c49a6c", img: "icons/skills/melee/strike-hammer-destructive-orange.webp" },
  { key: "firearm", label: "Огнестрельный", color: "#f0d48a", img: "icons/skills/ranged/bullets-triple-ball-orange.webp" },
  { key: "energy", label: "Энергетический", color: "#78f0ff", img: "icons/skills/ranged/energy-weapon-fire-blue.webp" },
  { key: "fire", label: "Огненный", color: "#ff6a2a", img: "icons/magic/fire/flame-burning-embers-orange.webp" },
  { key: "cryo", label: "Криогенный", color: "#6da8ff", img: "icons/magic/water/snowflake-ice-blue.webp" },
  { key: "electric", label: "Электрический", color: "#f6f05a", img: "icons/magic/lightning/bolt-strike-sparks-yellow.webp" },
  { key: "acid", label: "Кислотный", color: "#7be36d", img: "icons/svg/acid.svg" },
  { key: "poison", label: "Ядовитый", color: "#b56dff", img: "icons/svg/poison.svg" },
  { key: "radiation", label: "Радиационный", color: "#c6ff4d", img: "icons/svg/radiation.svg" }
]);
