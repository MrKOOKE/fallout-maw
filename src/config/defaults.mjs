import { localize as auditLocalize, format as auditFormat } from "../utils/i18n.mjs";
export const DEFAULT_CHARACTERISTICS = Object.freeze([
  { key: "strength", abbr: "str", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text088", "Сила"); } },
  { key: "dexterity", abbr: "dex", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text089", "Ловкость"); } },
  { key: "endurance", abbr: "con", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text090", "Выносливость"); } },
  { key: "perception", abbr: "wis", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text091", "Восприятие"); } },
  { key: "intelligence", abbr: "int", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text092", "Интеллект"); } },
  { key: "charisma", abbr: "cha", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text093", "Харизма"); } },
  { key: "luck", abbr: "luc", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text094", "Удача"); } }
]);

export const DEFAULT_BASE_PARAMETER_POOLS = Object.freeze({
  characteristicDistributionPoints: 33,
  signatureSkillPoints: 3,
  traitPoints: 2,
  proficiencyPoints: 500
});

export const DEFAULT_LEVEL_ONE_CHARACTERISTIC_MAXIMUM = 10;
export const DEFAULT_SKILL_POINTS_PER_LEVEL_FORMULA = "10 + int";
export const DEFAULT_RESEARCH_POINTS_PER_LEVEL_FORMULA = "1000";
export const DEFAULT_PROFICIENCY_POINTS_PER_LEVEL_FORMULA = "50";
export const DEFAULT_LOAD_FORMULA = "20 + 10*str";
export const DEFAULT_LOAD_LIMIT_PERCENT = 150;

export const DEFAULT_CURRENCIES = Object.freeze([
  { key: "caps", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text095", "Крышки"); }, img: "", value: 1, primaryTrade: true },
  { key: "denarii", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text096", "Динарии"); }, img: "", value: 2, primaryTrade: false },
  { key: "ncrDollars", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text097", "Доллары НКР"); }, img: "", value: 3, primaryTrade: false },
  { key: "brotherhoodChecks", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text098", "Чеки братства"); }, img: "", value: 6, primaryTrade: false }
]);

export const DEFAULT_SKILLS = Object.freeze([
  { key: "rangedCombat", abbr: "ran", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text099", "Дальний бой"); }, formula: "10 + dex + wis*3", img: "icons/weapons/guns/gun-pistol-flintlock.webp" },
  { key: "meleeCombat", abbr: "mel", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text100", "Ближний бой"); }, formula: "10 + 2 * (str + dex)", img: "systems/fallout-maw/assets/System/TokenActionHud/hud-weapon-and-natural-attack.webp" },
  { key: "athletics", abbr: "ath", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text101", "Атлетика"); }, formula: "10 + (dex + str)*2", img: "icons/svg/jump.svg" },
  { key: "energy", abbr: "ene", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text102", "Энергия"); }, formula: "4 * int", img: "icons/svg/lightning.svg" },
  { key: "resilience", abbr: "res", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text103", "Стойкость"); }, formula: "10 + 4 * con", img: "icons/svg/holy-shield.svg" },
  { key: "throwing", abbr: "thr", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text104", "Метание"); }, formula: "(dex + str)*2", img: "icons/weapons/thrown/throwing-knife-flat-steel.webp" },
  { key: "firstAid", abbr: "fir", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text105", "Первая помощь"); }, formula: "(wis + int)*2", img: "icons/svg/heal.svg" },
  { key: "doctor", abbr: "doc", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text106", "Доктор"); }, formula: "wis + int*3", img: "icons/svg/pill.svg" },
  { key: "naturalist", abbr: "nat", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text107", "Натуралист"); }, formula: "4 * (wis)", img: "icons/svg/oak.svg" },
  { key: "stealth", abbr: "ste", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text084", "Скрытность"); }, formula: "(3 * dex)", img: "icons/svg/invisible.svg" },
  { key: "lockpicking", abbr: "loc", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text108", "Взлом"); }, formula: "wis + dex", img: "icons/svg/padlock.svg" },
  { key: "theft", abbr: "the", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text109", "Кража"); }, formula: "dex + wis*2", img: "icons/svg/chest.svg" },
  { key: "traps", abbr: "tra", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text085", "Ловушки"); }, formula: "(wis + dex)*2", img: "icons/svg/net.svg" },
  { key: "science", abbr: "sci", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text110", "Наука"); }, formula: "4 * int", img: "icons/svg/book.svg" },
  { key: "repair", abbr: "rep", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text080", "Ремонт"); }, formula: "int*3 + str", img: "icons/tools/smithing/tongs-steel-grey.webp" },
  { key: "speech", abbr: "spe", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text111", "Красноречие"); }, formula: "5 * cha", img: "systems/fallout-maw/assets/System/TokenDefaults/default-character-and-transport.webp" },
  { key: "barter", abbr: "bar", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text112", "Бартер"); }, formula: "cha*3 + int", img: "icons/svg/coins.svg" },
  { key: "gambling", abbr: "gam", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text113", "Азарт"); }, formula: "6 * luc", img: "icons/sundries/gaming/gaming-set-dice.webp" }
]);

export const DEFAULT_SIGNATURE_SKILL_MULTIPLIER = 1.5;
export const DEFAULT_SIGNATURE_SKILL_FLAT_BONUS = 15;
export const DEFAULT_SKILL_DEVELOPMENT_LIMIT = 300;
export const DEFAULT_SKILL_DEVELOPMENT_LIMIT_PURE_ONLY = true;

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
  { key: "pistol", abbr: "pis", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text114", "Пистолет"); }, max: 1000 },
  { key: "automatic", abbr: "aut", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text115", "Автомат"); }, max: 1000 },
  { key: "rifle", abbr: "rif", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text116", "Винтовка"); }, max: 1000 },
  { key: "heavyRanged", abbr: "hvy", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text117", "Тяжелое стрелковое"); }, max: 1000 },
  { key: "shotgun", abbr: "sho", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text118", "Дробовик"); }, max: 1000 },
  { key: "grenade", abbr: "grn", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text119", "Граната"); }, max: 1000 },
  { key: "oneHandedMelee", abbr: "ohm", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text120", "Одноручное холодное"); }, max: 1000 },
  { key: "twoHandedMelee", abbr: "thm", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text121", "Двуручное холодное"); }, max: 1000 },
  { key: "natural", abbr: "nat", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text122", "Природное"); }, max: 1000 }
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
  { key: "head", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text123", "Голова"); }, stateMax: "100 + con * 5", damageMultiplier: 1.3, aimedDifficultyPercent: 30, implantLimit: 1, critical: true, lossEffects: [] },
  { key: "eyes", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text124", "Глаза"); }, stateMax: "100 + con * 5", damageMultiplier: 1.4, aimedDifficultyPercent: 50, implantLimit: 1, critical: false, lossEffects: Object.freeze([
    Object.freeze({ key: "status.blind", type: "add", value: "1", phase: "initial", priority: null })
  ]) },
  { key: "torso", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text125", "Туловище"); }, stateMax: "100 + con * 5", damageMultiplier: 1, aimedDifficultyPercent: 0, implantLimit: 1, critical: true, lossEffects: [] },
  { key: "groin", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text126", "Пах"); }, stateMax: "100 + con * 5", damageMultiplier: 1.2, aimedDifficultyPercent: 20, implantLimit: 1, critical: false, lossEffects: [] },
  { key: "leftArm", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text127", "Левая рука"); }, stateMax: "100 + con * 5", damageMultiplier: 0.8, aimedDifficultyPercent: 20, implantLimit: 1, critical: false, lossEffects: DEFAULT_MISSING_LIMB_PHYSICAL_EFFECTS },
  { key: "rightArm", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text128", "Правая рука"); }, stateMax: "100 + con * 5", damageMultiplier: 0.8, aimedDifficultyPercent: 20, implantLimit: 1, critical: false, lossEffects: DEFAULT_MISSING_LIMB_PHYSICAL_EFFECTS },
  { key: "leftLeg", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text129", "Левая нога"); }, stateMax: "100 + con * 5", damageMultiplier: 0.8, aimedDifficultyPercent: 20, implantLimit: 1, critical: false, lossEffects: DEFAULT_MISSING_LEG_EFFECTS },
  { key: "rightLeg", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text130", "Правая нога"); }, stateMax: "100 + con * 5", damageMultiplier: 0.8, aimedDifficultyPercent: 20, implantLimit: 1, critical: false, lossEffects: DEFAULT_MISSING_LEG_EFFECTS }
]);

export const DEFAULT_EQUIPMENT_SLOTS = Object.freeze([
  { key: "helmet", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text131", "Шлем"); } },
  { key: "glasses", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text132", "Очки"); } },
  { key: "mask", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text133", "Маска"); } },
  { key: "clothing", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text134", "Одежда"); } },
  { key: "armor", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text135", "Броня"); } },
  { key: "cloak", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text136", "Накидка"); } },
  { key: "rig", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text137", "Разгрузка"); } },
  { key: "belt", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text138", "Пояс"); } },
  { key: "backpack", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text139", "Рюкзак"); } }
]);

export const DEFAULT_WEAPON_SETS = Object.freeze([
  {
    key: "weaponSet1",
    get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text140", "Набор 1"); },
    slots: [
      { key: "rightHand", limbKey: "rightArm" },
      { key: "leftHand", limbKey: "leftArm" }
    ]
  },
  {
    key: "weaponSet2",
    get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text141", "Набор 2"); },
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

export const FIXED_RESOURCE_KEYS = Object.freeze([
  "health",
  "consciousness",
  "dodge",
  "actionPoints",
  "movementPoints"
]);

export const DEFAULT_HEALTH_PER_LEVEL_FORMULA = "1 + con / 3";

export const DEFAULT_RESOURCES = Object.freeze([
  { key: "health", abbr: "hea", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text142", "Здоровье"); }, formula: "limbs" },
  { key: "consciousness", abbr: "con", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text143", "Сознание"); }, formula: "criticalLimbs" },
  { key: "dodge", abbr: "dod", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text144", "Уклонение"); }, formula: "60 + ath/3" },
  { key: "actionPoints", abbr: "act", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text145", "Очки действия"); }, formula: "5 + (dex/3 + str/5)" },
  { key: "movementPoints", abbr: "mov", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text146", "Очки передвижения"); }, formula: "2 + ath/50" }
]);

export const DEFAULT_NEEDS = Object.freeze([
  { key: "hunger", abbr: "hun", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text147", "Голод"); }, formula: "1000" },
  { key: "thirst", abbr: "thi", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text148", "Жажда"); }, formula: "1000" },
  { key: "sleepiness", abbr: "sle", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text149", "Сонливость"); }, formula: "1000" },
  { key: "radcont", abbr: "rad", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text150", "Рад. Заражение"); }, formula: "1000" }
]);

export const DEFAULT_DAMAGE_TYPES = Object.freeze([
  { key: "piercing", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text151", "Колющий"); }, color: "#d9d0bd", img: "systems/fallout-maw/assets/System/DamageTypes/damage-piercing.svg" },
  { key: "slashing", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text152", "Режущий"); }, color: "#d95c5c", img: "systems/fallout-maw/assets/System/DamageTypes/damage-slashing.svg" },
  { key: "bludgeoning", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text153", "Дробящий"); }, color: "#c49a6c", img: "systems/fallout-maw/assets/System/DamageTypes/damage-bludgeoning.svg" },
  { key: "firearm", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text154", "Огнестрельный"); }, color: "#f0d48a", img: "systems/fallout-maw/assets/System/DamageTypes/damage-firearm.svg" },
  { key: "energy", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text155", "Энергетический"); }, color: "#78f0ff", img: "systems/fallout-maw/assets/System/DamageTypes/damage-energy.svg" },
  { key: "fire", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text156", "Огненный"); }, color: "#ff6a2a", img: "systems/fallout-maw/assets/System/DamageTypes/damage-fire.svg" },
  { key: "cryo", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text157", "Криогенный"); }, color: "#6da8ff", img: "systems/fallout-maw/assets/System/DamageTypes/damage-cryo.svg" },
  { key: "electric", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text158", "Электрический"); }, color: "#f6f05a", img: "systems/fallout-maw/assets/System/DamageTypes/damage-electric.svg" },
  { key: "acid", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text159", "Кислотный"); }, color: "#7be36d", img: "systems/fallout-maw/assets/System/DamageTypes/damage-acid.svg" },
  { key: "poison", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text160", "Ядовитый"); }, color: "#b56dff", img: "systems/fallout-maw/assets/System/DamageTypes/damage-poison.svg" },
  { key: "radiation", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text161", "Радиационный"); }, color: "#c6ff4d", img: "systems/fallout-maw/assets/System/DamageTypes/damage-radiation.svg" }
]);
