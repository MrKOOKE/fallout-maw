import {
  applyWeaponMediaPatch,
  migrateWeaponAnimationKey,
  migrateWeaponSoundPath
} from "./weapon-media-migration.mjs";

function migrationRandomId() {
  return globalThis.crypto?.randomUUID?.().replace(/-/g, "").slice(0, 16)
    ?? `m${Math.random().toString(36).slice(2, 12)}`;
}

const FEET_TO_RANGE_METERS = 2.5;
const FEET_TO_RADIUS_METERS = 5;
const WEAPON_DAMAGE_MULTIPLIER = 2;
const WEAPON_PENETRATION_MULTIPLIER = 10;
const DEFAULT_EXPLOSION_PELLETS = 6;
const DEFAULT_SHOTGUN_PELLETS = 6;

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
  ["Ядовитый", "poison"],
  ["Радиоактивный", "radiation"],
  ["Радиационный", "radiation"]
]);

const DAMAGE_TYPE_ALIASES = new Map([
  ...DAMAGE_TYPE_LABELS,
  ["огнестрельный", "firearm"],
  ["энергетический", "energy"],
  ["огненный", "fire"],
  ["криогенный", "cryo"],
  ["электрический", "electric"],
  ["кислота", "acid"],
  ["ядовитый", "poison"],
  ["колющий", "piercing"],
  ["режущий", "slashing"],
  ["дробящий", "bludgeoning"],
  ["радиоактивный", "radiation"]
]);

const LIMB_LABELS = new Map([
  ["Голова", "head"],
  ["Глаза", "eyes"],
  ["Туловище", "torso"],
  ["Пах", "groin"],
  ["Левая рука", "leftArm"],
  ["Правая рука", "rightArm"],
  ["Левая нога", "leftLeg"],
  ["Правая нога", "rightLeg"]
]);

const SKILL_LABELS = new Map([
  ["Дальний бой", "rangedCombat"],
  ["Ближний бой", "meleeCombat"],
  ["Метание", "throwing"],
  ["Атлетика", "athletics"],
  ["Стойкость", "resilience"],
  ["Энергия", "energy"],
  ["Красноречие", "speech"],
  ["тяжёлое оружие", "rangedCombat"],
  ["тяжелое оружие", "rangedCombat"]
]);

const CHARACTERISTIC_LABELS = new Map([
  ["Сила", "strength"],
  ["Ловкость", "dexterity"],
  ["Выносливость", "endurance"],
  ["Восприятие", "perception"],
  ["Интеллект", "intelligence"],
  ["Харизма", "charisma"],
  ["Удача", "luck"]
]);

const EQUIPMENT_SLOT_TOKEN_MAP = new Map([
  ["шлем", "Шлем"],
  ["очки", "Очки"],
  ["маска", "Маска"],
  ["одежда", "Одежда"],
  ["броня", "Броня"],
  ["жилет", "Броня"],
  ["накидка", "Накидка"],
  ["разгрузка", "Разгрузка"],
  ["пояс", "Пояс"],
  ["рюкзак", "Рюкзак"]
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

const DEFAULT_ATTACK_ANIMATION_DELAY_MS = 200;

const BINDING_KEY_TO_ACTION_KEY = Object.freeze({
  "single-shot": "snapshot",
  "aimed-shot": "aimedShot",
  "non-aimed-attack": "meleeAttack",
  "precise-attack": "aimedMeleeAttack",
  burst: "burst",
  volley: "volley",
  reload: "reload",
  push: "push"
});

const ACTION_LABEL_TO_BINDING_KEY = [
  { bindingKey: "non-aimed-attack", pattern: /^неприцельн(?:ый|ая)\s+атака/i },
  { bindingKey: "precise-attack", pattern: /^прицельн(?:ый|ая)\s+атака/i },
  { bindingKey: "aimed-shot", pattern: /^прицельн(?:ый|ая)\s+выстрел|^прицельно\s+метнуть/i },
  { bindingKey: "single-shot", pattern: /^(?:одиночн(?:ый|ая)\s+выстрел|выстрел\s+на\s+вскидку|неприцельн(?:ый|ая)\s+выстрел|метнуть)/i },
  { bindingKey: "non-aimed-attack", pattern: /^удар\s+рукояткой/i },
  { bindingKey: "burst", pattern: /^очеред/i },
  { bindingKey: "volley", pattern: /^залп/i },
  { bindingKey: "reload", pattern: /^перезаряд/i },
  { bindingKey: "push", pattern: /^толчок/i }
];

const ACTION_PATTERNS = [
  { key: "meleeAttack", pattern: /^неприцельн(?:ый|ая)\s+атака|^удар\s+рукояткой/i, settingKey: "meleeAttack" },
  { key: "aimedMeleeAttack", pattern: /^прицельн(?:ый|ая)\s+атака/i, settingKey: "aimedMeleeAttack" },
  { key: "aimedShot", pattern: /^прицельн(?:ый|ая)\s+выстрел|^прицельно\s+метнуть/i, settingKey: "aimedShot" },
  { key: "snapshot", pattern: /^(?:одиночн(?:ый|ая)\s+выстрел|выстрел\s+на\s+вскидку|неприцельн(?:ый|ая)\s+выстрел|метнуть)/i, settingKey: "snapshot" },
  { key: "burst", pattern: /^очеред/i, settingKey: "burst" },
  { key: "volley", pattern: /^залп/i, settingKey: "volley" },
  { key: "push", pattern: /^толчок/i, settingKey: "push" },
  { key: "reload", pattern: /^перезаряд/i, settingKey: "reload" }
];

const DEFAULT_THROW_ACTIONS = Object.freeze([
  { bindingKey: "single-shot", label: "Метнуть", actionPointCost: 5 },
  { bindingKey: "aimed-shot", label: "Прицельно метнуть", actionPointCost: 6 }
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
    rarity: parseRarityLabel(flatText),
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
  const pelletsRaw = parseSignedNumber(matchField(flatText, /Дробь:\s*(?:=)?\s*([+-]?\d+)/i));
  const pellets = pelletsRaw > 1 ? DEFAULT_SHOTGUN_PELLETS : Math.max(1, pelletsRaw || 1);
  const damageTypes = parseDamageDistribution(flatText);
  const primaryType = damageTypes[0]?.key ?? "firearm";

  return stripDamageSourceMigrationFields({
    enabled: true,
    name: buildDamageSourceName(caliber, caliberKey, ammoType, itemName),
    damage: "0",
    pellets: String(pellets),
    damageTypeKey: primaryType,
    damageTypes: damageTypes.length ? damageTypes : [{ key: "firearm", percent: 100 }],
    attackAnimationKey: "",
    attackSoundPath: "",
    attackAnimationDelayMs: 0,
    accuracyBonus: formatSignedPercent(matchField(flatText, /Точность:\s*([+-]?\d+(?:[.,]\d+)?%?)/i)),
    criticalChanceModifier: formatSignedPercent(matchField(flatText, /Шанс\s+на\s+крит:\s*([+-]?\d+(?:[.,]\d+)?%?)/i)),
    criticalDamagePercent: formatSignedPercent(matchField(flatText, /Крит\s+урон:\s*([+-]?\d+(?:[.,]\d+)?%?)/i)),
    maxRangeMeters: formatSignedNumber(convertFeetToRangeMeters(matchField(flatText, /Максимальная\s+дистанция:\s*([+-]?\d+(?:[.,]\d+)?)/i))),
    effectiveRange: convertEffectiveRangeFeetToMeters(parseEffectiveRange(flatText, { convertFeet: false })),
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

export function parseEquipmentMigration(description = "") {
  const html = String(description ?? "");
  const flatText = stripGearHtml(html).replace(/\s+/g, " ").trim();
  const mitigation = parseArmorMitigationTable(html, flatText);
  const bonuses = parseEquipmentStatBonuses(flatText);
  const freeSettings = buildFreeSettingsFunction(bonuses);

  const slotData = parseOccupiedEquipmentSlots(flatText);

  return {
    parsedGear: parseGearDescription(description),
    damageMitigation: mitigation,
    freeSettings,
    occupiedSlots: slotData.occupiedSlots,
    occupiedSlotMode: slotData.occupiedSlotMode
  };
}

export function parseWeaponMigration(description = "", itemName = "", {
  magazineSourceOldIds = [],
  rarityConditionLossByRarity = null
} = {}) {
  const html = String(description ?? "");
  const warnings = [];
  const parsedGear = parseGearDescription(description);
  const sections = splitWeaponSections(html);
  const primarySection = sections[0] ?? { text: stripGearHtml(html).replace(/\s+/g, " ").trim(), name: itemName };
  let primary = parseWeaponSectionText(primarySection.text, {
    itemName,
    sectionName: primarySection.name || itemName,
    magazineSourceOldIds,
    html,
    parsedGear
  });
  const weaponSlotRequirement = parseWeaponHandRequirement(primarySection.text, itemName);
  const resourceCostContext = {
    flatText: primarySection.text,
    parsedGear,
    rarity: parseRarityLabel(primarySection.text) || String(parsedGear?.rarity ?? "").trim(),
    rarityConditionLossByRarity
  };

  const additionalWeapons = [];
  for (const section of sections.slice(1)) {
    additionalWeapons.push(parseWeaponSectionText(section.text, {
      itemName: section.name || `${itemName} · доп.`,
      sectionName: section.name || `${itemName} · доп.`,
      magazineSourceOldIds: [],
      html: section.html ?? html,
      named: true
    }));
  }

  const skillModes = parseSkillModeVariants(html, primarySection.text);
  if (skillModes.length > 1) {
    const built = buildWeaponsFromSkillModeBundle(primary, primarySection.text, skillModes, resourceCostContext);
    primary = built.primary;
    additionalWeapons.length = 0;
    additionalWeapons.push(...built.additionalWeapons);
  } else if (skillModes.length === 1) {
    primary = applySkillModeFields(primary, skillModes[0]);
    primary = applySimpleWeaponActionFixes(primary, primarySection.text);
    applyWeaponResourceCosts(primary, resourceCostContext, skillModes[0]?.fields ?? null);
  } else {
    primary = applySimpleWeaponActionFixes(primary, primarySection.text);
    applyWeaponResourceCosts(primary, resourceCostContext);
  }

  for (const additionalWeapon of additionalWeapons) {
    if (skillModes.length <= 1) {
      applyWeaponResourceCosts(additionalWeapon, {
        ...resourceCostContext,
        flatText: stripGearHtml(additionalWeapon.name ? primarySection.text : primarySection.text).replace(/\s+/g, " ").trim()
      });
    }
  }

  applyWeaponProficiencies(primary, primarySection.text, weaponSlotRequirement);
  for (const additionalWeapon of additionalWeapons) {
    applyWeaponProficiencies(additionalWeapon, primarySection.text, weaponSlotRequirement);
  }

  if (!primary?.damage || primary.damage === "0") warnings.push("не удалось распарсить урон");
  if (!parsedGear?.repairDifficulty) warnings.push("нет сложности ремонта");

  return {
    parsedGear,
    primary,
    additionalWeapons,
    warnings,
    weaponSlotRequirement
  };
}

export function parseArmorMitigationTable(html = "", flatText = "") {
  const section = String(html ?? "").match(/Защита:[\s\S]*?(?=Сопротивление:|Примечание:|Занимает:|ТРЕБОВАНИЯ:|$)/i)?.[0] ?? "";
  const rows = [...section.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map(match => [...match[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell => cell[1].replace(/<[^>]+>/g, "").trim()))
    .filter(row => row.length > 1);

  if (rows.length < 2) {
    return { enabled: false, mode: "defense", limbSetIds: [], entries: {} };
  }

  const header = rows[0];
  const limbKeys = header.slice(1).map(label => LIMB_LABELS.get(label) ?? null);
  const entries = {};

  for (const row of rows.slice(1)) {
    const damageTypeKey = DAMAGE_TYPE_LABELS.get(row[0]);
    if (!damageTypeKey) continue;
    row.slice(1).forEach((cell, index) => {
      const limbKey = limbKeys[index];
      if (!limbKey) return;
      const value = parseMitigationCellValue(cell);
      if (value <= 0) return;
      entries[limbKey] ??= {};
      entries[limbKey][damageTypeKey] = { value };
    });
  }

  applyTotalReductionBonus(entries, parseTotalDamageReduction(flatText || stripGearHtml(html)));

  const hasEntries = Object.keys(entries).length > 0;
  return {
    enabled: hasEntries,
    mode: "defense",
    limbSetIds: [],
    entries
  };
}

function parseTotalDamageReduction(flatText = "") {
  return Math.max(0, parseInteger(matchField(String(flatText ?? ""), /Итоговое\s+снижение\s+урона:\s*(\d+)/i)));
}

function applyTotalReductionBonus(entries = {}, totalReduction = 0) {
  const bonus = Math.max(0, parseInteger(totalReduction)) * 2;
  if (!bonus) return entries;

  for (const limbKey of Object.keys(entries)) {
    for (const damageTypeKey of Object.keys(entries[limbKey] ?? {})) {
      const current = parseInteger(entries[limbKey][damageTypeKey]?.value);
      if (current >= 1) {
        entries[limbKey][damageTypeKey].value = current + bonus;
      }
    }
  }
  return entries;
}

export function parseEquipmentStatBonuses(flatText = "") {
  const skills = parseBonusPairs(matchSection(flatText, /НАВЫКИ:\s*([^]+?)(?=ХАРАКТЕРИСТИКИ:|Примечание:|Защита:|$)/i), SKILL_LABELS);
  const characteristics = parseBonusPairs(matchSection(flatText, /ХАРАКТЕРИСТИКИ:\s*([^]+?)(?=Примечание:|Защита:|НАВЫКИ:|$)/i), CHARACTERISTIC_LABELS);
  return { skills, characteristics };
}

export function buildFreeSettingsFunction({ skills = [], characteristics = [] } = {}) {
  const changes = [];
  for (const entry of characteristics) {
    changes.push(createEffectChange(`system.characteristics.${entry.key}`, entry.value));
  }
  for (const entry of skills) {
    changes.push(createEffectChange(`system.skills.${entry.key}.bonus`, entry.value));
  }
  if (!changes.length) {
    return { enabled: false, useConditionWeakening: false, entries: [] };
  }
  return {
    enabled: true,
    useConditionWeakening: false,
    entries: [{
      id: migrationRandomId(),
      type: "effectChanges",
      changes,
      conditions: [],
      penalties: []
    }]
  };
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

  return {
    enabled: true,
    damageMode: "manual",
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
  return resolveGearFolderParts(folderPath, "Оружие", parsed?.rarity);
}

export function resolveEquipmentFolderPath(folderPath, parsed = null) {
  return resolveGearFolderParts(folderPath, "Снаряжение", parsed?.rarity);
}

export function resolveAmmoFolderPath(folderPath, parsed = null) {
  return resolveGearFolderParts(folderPath, "Боеприпасы", parsed?.rarity);
}

function resolveGearFolderParts(folderPath, rootPrefix, parsedRarity = "") {
  const parts = String(folderPath ?? "").split(" / ").filter(Boolean);
  if (parts[0] !== rootPrefix) {
    return [String(parsedRarity || "Прочее").trim() || "Прочее"];
  }
  const rarity = String(parsedRarity || parts[1] || "Прочее").trim() || "Прочее";
  const subcategory = String(parts[2] ?? "").trim();
  return subcategory ? [rarity, subcategory] : [rarity];
}

function parseRarityLabel(flatText = "") {
  return String(matchField(flatText, /Редкость:\s*([^]+?)(?=Мин\.|Сложность|Состояние:|Потеря|Максимальная|Занимает:|ТРЕБОВАНИЯ:|Калибр:|Тип|$)/i) ?? "").trim();
}

function parseWeaponSectionText(flatText = "", {
  itemName = "",
  sectionName = "",
  magazineSourceOldIds = [],
  html = "",
  named = false,
  parsedGear = null
} = {}) {
  const gearMeta = parsedGear ?? parseGearDescription(flatText);
  const sourceIds = Array.from(new Set((magazineSourceOldIds ?? []).filter(Boolean)));
  const damageInfo = parseWeaponDamageLine(flatText);
  const skillKey = resolveSkillKey(matchField(flatText, /Задействованный\s+навык:\s*([^]+?)(?=Максимальная|Эффективная|Точность|Урон|ДОСТУПНЫЕ|$)/i));
  const actions = parseWeaponActions(flatText, { skillKey });
  const maxRangeFeet = parseNumber(matchField(flatText, /Максимальная\s+дистанция:\s*([+-]?\d+(?:[.,]\d+)?)/i));
  const effectiveRange = convertEffectiveRangeFeetToMeters(parseEffectiveRange(flatText, { convertFeet: false }));
  const penetration = scalePenetration(parseNumber(matchField(flatText, /Пробивная\s+сила:\s*([+-]?\d+(?:[.,]\d+)?)/i)));
  const pellets = resolveWeaponPellets(flatText, damageInfo, actions);
  const damageRadiusFeet = parseNumber(matchField(flatText, /Радиус\s+поражения:\s*([+-]?\d+(?:[.,]\d+)?)/i));
  const burstCount = Math.max(1, parseInteger(matchField(flatText, /Патронов\s+за\s+очередь:\s*(\d+)/i)) || 3);
  const media = parseWeaponMediaPaths(flatText, html);
  const requirements = parseWeaponRequirements(flatText);

  const weapon = {
    enabled: true,
    damageMode: "manual",
    damage: String(scaleWeaponDamage(damageInfo.damage)),
    pellets: String(pellets),
    damageTypeKey: damageInfo.primaryType,
    damageTypes: damageInfo.damageTypes,
    attackAnimationKey: migrateWeaponAnimationKey(media.attackAnimationKey),
    attackSoundPath: migrateWeaponSoundPath(media.attackSoundPath),
    attackAnimationDelayMs: parseAttackAnimationDelayMs(flatText),
    proficiencyKey: inferProficiencyKey(flatText, skillKey),
    skillKey,
    accuracyBonus: formatStatNumber(matchField(flatText, /Точность:\s*([+-]?\d+(?:[.,]\d+)?%?)/i)),
    criticalChanceModifier: formatStatNumber(matchField(flatText, /Шанс\s+на\s+крит:\s*([+-]?\d+(?:[.,]\d+)?%?)/i)),
    criticalDamagePercent: formatStatNumber(matchField(flatText, /Крит\s+урон:\s*([+-]?\d+(?:[.,]\d+)?%?)/i)) || "150",
    attackConeDegrees: 30,
    maxRangeMeters: String(convertFeetToRangeMeters(maxRangeFeet)),
    effectiveRange,
    penetration: String(penetration),
    magazine: {
      value: 0,
      max: Math.max(0, parseInteger(gearMeta?.magazineMax)),
      sourceItemUuid: sourceIds[0] ? `Item.${sourceIds[0]}` : "",
      sourceItemUuids: sourceIds.map(id => `Item.${id}`)
    },
    resourceCosts: buildWeaponResourceCosts(flatText, {
      skillKey,
      caliberKey: gearMeta?.caliberKey,
      magazineMax: gearMeta?.magazineMax
    }),
    moduleSlots: [],
    specialProperties: [],
    requirements,
    availableActions: actions.availableActions,
    aimedShot: withActionCost({}, actions.costs.aimedShot),
    snapshot: withActionCost({}, actions.costs.snapshot),
    burst: {
      ...withActionCost({}, actions.costs.burst),
      attackConeDegrees: 30,
      count: burstCount,
      difficultyPerShot: 10,
      criticalFailureConsequences: []
    },
    volley: {
      ...withActionCost({}, actions.costs.volley),
      damageRadius: String(convertFeetToRadiusMeters(damageRadiusFeet)),
      regionRadius: String(convertFeetToRadiusMeters(damageRadiusFeet)),
      regionDamageEntries: [],
      regionDurationSeconds: "0",
      regionDelaySeconds: "0",
      regionRadiusDeltaMeters: "0",
      explosionAnimationKey: migrateWeaponAnimationKey(media.explosionAnimationKey),
      explosionSoundPath: migrateWeaponSoundPath(media.explosionSoundPath),
      criticalFailureConsequences: []
    },
    meleeAttack: withActionCost({}, actions.costs.meleeAttack),
    aimedMeleeAttack: withActionCost({}, actions.costs.aimedMeleeAttack),
    push: withActionCost({}, actions.costs.push),
    reload: withActionCost({ actionPointCost: 3 }, actions.costs.reload)
  };

  if (named) {
    weapon.id = migrationRandomId();
    weapon.name = String(sectionName || itemName).trim() || itemName;
  }

  return sanitizeMigratedWeaponActions(applyWeaponMediaPatch(weapon));
}

function splitWeaponSections(html = "") {
  const source = String(html ?? "");
  const chunks = source.split(/(?:ДОП\.?\s*РАЗДЕЛ\s*МОДУЛЯ:|module-additional-section)/i).filter(Boolean);
  if (chunks.length <= 1) {
    const text = stripGearHtml(source).replace(/\s+/g, " ").trim();
    return [{ text, name: "", html: source }];
  }

  return chunks.map((chunk, index) => {
    const text = stripGearHtml(chunk).replace(/\s+/g, " ").trim();
    const nameMatch = text.match(/"([^"]+)"/) ?? text.match(/(?:Модуль|Гранатомет)\s+([^]+?)\s+(?:Калибр:|Тип\s+боеприпаса:|Редкость:)/i);
    return {
      text,
      name: index === 0 ? "" : String(nameMatch?.[1] ?? "").trim(),
      html: chunk
    };
  }).filter(entry => entry.text);
}

function parseSkillModeBundle(html = "", flatText = "") {
  const fieldsJson = extractHiddenJson(html, "bu-skill-fields") ?? findInlineJsonBlob(flatText, "fields");
  if (!fieldsJson?.fields || !Object.keys(fieldsJson.fields).length) return null;

  const assetsJson = extractHiddenJson(html, "bu-skill-assets") ?? findInlineJsonBlob(flatText, "assets");
  const damageJson = extractHiddenJson(html, "bu-skill-damage") ?? findInlineJsonBlob(flatText, "damageSets");
  const bindingsJson = extractHiddenJson(html, "bu-skill-bindings")
    ?? findInlineJsonBlob(flatText, "bindings")
    ?? extractInlineJsonBlobs(flatText).find(blob => Array.isArray(blob?.modes));

  const fields = fieldsJson.fields;
  const assets = assetsJson?.assets ?? {};
  const damageSets = damageJson?.damageSets ?? {};
  const modes = Array.isArray(bindingsJson?.modes) && bindingsJson.modes.length
    ? bindingsJson.modes
    : Object.keys(fields).map((id, index) => ({
      id,
      label: String(fields[id]?.weaponType ?? `Режим ${index + 1}`).trim()
    }));
  const bindings = bindingsJson?.bindings ?? {};
  const selected = bindingsJson?.selected ?? modes[0]?.id ?? Object.keys(fields)[0];

  return { modes, bindings, selected, fields, assets, damageSets };
}

function parseSkillModeVariants(html = "", flatText = "") {
  const bundle = parseSkillModeBundle(html, flatText);
  if (!bundle) return [];

  return bundle.modes.map((mode, index) => ({
    id: mode.id,
    index,
    label: String(mode.label ?? "").trim(),
    fields: bundle.fields[mode.id] ?? {},
    assets: bundle.assets[mode.id] ?? {},
    damageSets: bundle.damageSets[mode.id] ?? [],
    bundle
  }));
}

function buildWeaponsFromSkillModeBundle(baseWeapon, flatText, skillModes, resourceCostContext = null) {
  const bundle = skillModes[0]?.bundle;
  if (!bundle) return { primary: baseWeapon, additionalWeapons: [] };

  const actionCatalog = parseWeaponActionCatalog(flatText, { skillKey: baseWeapon.skillKey });
  const bindingToMode = resolveBindingToModeMap(bundle, actionCatalog);
  const duplicateMeleeModes = countModeLabel(bundle.modes, "Ближний бой") > 1;

  const throwModeMeta = bundle.modes.find(mode => normalizeModeLabel(mode.label) === "метание") ?? null;
  const meleeModes = bundle.modes.filter(mode => normalizeModeLabel(mode.label) !== "метание");
  const selectedMeleeId = bundle.selected && meleeModes.some(mode => mode.id === bundle.selected)
    ? bundle.selected
    : meleeModes[0]?.id;
  const primaryModeMeta = meleeModes.find(mode => mode.id === selectedMeleeId) ?? meleeModes[0] ?? bundle.modes[0];
  const primaryMode = skillModes.find(entry => entry.id === primaryModeMeta.id) ?? skillModes[0];

  let primary = buildWeaponForSkillMode({
    baseWeapon,
    mode: primaryMode,
    modeMeta: primaryModeMeta,
    bundle,
    bindingToMode,
    actionCatalog,
    duplicateMeleeModes,
    resourceCostContext
  });
  delete primary.name;

  const additionalWeapons = [];

  if (throwModeMeta) {
    const throwMode = skillModes.find(entry => entry.id === throwModeMeta.id);
    if (throwMode) {
      additionalWeapons.push(buildWeaponForSkillMode({
        baseWeapon,
        mode: throwMode,
        modeMeta: throwModeMeta,
        bundle,
        bindingToMode,
        actionCatalog,
        duplicateMeleeModes,
        fixedName: String(throwModeMeta.label ?? "Метание").trim() || "Метание",
        asAdditional: true,
        resourceCostContext
      }));
    }
  }

  for (const modeMeta of meleeModes) {
    if (modeMeta.id === primaryModeMeta.id) continue;
    const mode = skillModes.find(entry => entry.id === modeMeta.id);
    if (!mode) continue;
    additionalWeapons.push(buildWeaponForSkillMode({
      baseWeapon,
      mode,
      modeMeta,
      bundle,
      bindingToMode,
      actionCatalog,
      duplicateMeleeModes,
      fixedName: String(modeMeta.label ?? mode.fields?.weaponType ?? "Режим").trim() || "Режим",
      asAdditional: true,
      resourceCostContext
    }));
  }

  return { primary, additionalWeapons };
}

function buildWeaponForSkillMode({
  baseWeapon,
  mode,
  modeMeta,
  bundle,
  bindingToMode,
  actionCatalog,
  duplicateMeleeModes,
  fixedName = "",
  asAdditional = false,
  resourceCostContext = null
}) {
  let weapon = structuredClone(baseWeapon);
  if (asAdditional) delete weapon.id;

  weapon = applySkillModeFields(weapon, mode);
  weapon = resetWeaponActionSettings(weapon);
  weapon.skillKey = resolveModeSkillKey(modeMeta, mode, weapon);
  weapon = applyActionCatalogToWeapon(weapon, selectModeActionCatalog({
    catalog: actionCatalog,
    modeId: modeMeta.id,
    bundle,
    bindingToMode,
    duplicateMeleeModes
  }));
  weapon.enabled = true;

  if (resourceCostContext) {
    applyWeaponResourceCosts(weapon, resourceCostContext, mode?.fields ?? null);
  }

  if (asAdditional) {
    weapon.id = migrationRandomId();
    weapon.name = fixedName;
  }

  return sanitizeMigratedWeaponActions(applyWeaponMediaPatch(weapon));
}

function selectModeActionCatalog({ catalog, modeId, bundle, bindingToMode, duplicateMeleeModes }) {
  if (duplicateMeleeModes) {
    return catalog.filter(action => action.bindingKey);
  }

  const assigned = catalog.filter(action => bindingToMode[action.bindingKey] === modeId);
  if (assigned.length) return assigned;

  const mode = bundle.modes.find(entry => entry.id === modeId);
  const label = normalizeModeLabel(mode?.label);
  if (label === "метание" && looksLikeThrowModeAssets(bundle.assets[modeId])) {
    return [...DEFAULT_THROW_ACTIONS];
  }

  return assigned;
}

function resolveBindingToModeMap(bundle, actionCatalog) {
  const map = { ...(bundle.bindings ?? {}) };
  if (Object.keys(map).length) return map;

  const modesByLabel = new Map(bundle.modes.map(mode => [normalizeModeLabel(mode.label), mode.id]));
  const meleeModeId = modesByLabel.get("ближний бой") ?? bundle.modes[0]?.id;
  const throwModeId = modesByLabel.get("метание");
  const rangedModeId = modesByLabel.get("дальний бой") ?? throwModeId ?? meleeModeId;
  const duplicateMeleeModes = countModeLabel(bundle.modes, "Ближний бой") > 1;

  if (duplicateMeleeModes) return map;

  const defaultModeByBinding = {
    "non-aimed-attack": meleeModeId,
    "precise-attack": meleeModeId,
    push: meleeModeId,
    "single-shot": throwModeId ?? rangedModeId,
    "aimed-shot": throwModeId ?? rangedModeId,
    burst: rangedModeId,
    volley: rangedModeId,
    reload: rangedModeId ?? meleeModeId
  };

  for (const action of actionCatalog) {
    if (!action.bindingKey || map[action.bindingKey]) continue;
    map[action.bindingKey] = defaultModeByBinding[action.bindingKey] ?? meleeModeId;
  }

  return map;
}

function applySimpleWeaponActionFixes(weapon, flatText = "") {
  const catalog = parseWeaponActionCatalog(flatText, { skillKey: weapon.skillKey });
  const next = applyActionCatalogToWeapon({ ...weapon }, catalog);
  next.attackAnimationDelayMs = parseAttackAnimationDelayMs(flatText);
  return sanitizeMigratedWeaponActions(applyWeaponMediaPatch(next));
}

function shouldImportWeaponAction(actionLabel = "", skillKey = "") {
  if (/^удар\s+прикладом/i.test(actionLabel)) return false;
  if (/^удар\s+рукояткой/i.test(actionLabel) && skillKey === "rangedCombat") return false;
  return true;
}

function sanitizeMigratedWeaponActions(weapon = {}) {
  const next = { ...weapon };
  const meleeName = String(next.meleeAttack?.name ?? "").trim();
  if (!/^удар\s+прикладом/i.test(meleeName)) return next;

  next.availableActions = { ...(next.availableActions ?? createEmptyAvailableActions()), meleeAttack: false };
  next.meleeAttack = withActionCost({ name: "" }, 0);
  return next;
}

function applyActionCatalogToWeapon(weapon, catalog = []) {
  const next = resetWeaponActionSettings({ ...weapon });
  const availableActions = createEmptyAvailableActions();
  const NAMED_ACTION_KEYS = new Set(["snapshot", "aimedShot", "meleeAttack", "aimedMeleeAttack", "burst", "volley", "push", "reload"]);

  for (const action of catalog) {
    if (action.bindingKey === "butt-strike") continue;
    const actionKey = BINDING_KEY_TO_ACTION_KEY[action.bindingKey];
    if (!actionKey) continue;
    availableActions[actionKey] = true;
    const actionSettings = withActionCost(next[actionKey] ?? {}, action.actionPointCost);
    next[actionKey] = NAMED_ACTION_KEYS.has(actionKey) && action.label
      ? { ...actionSettings, name: action.label }
      : actionSettings;
  }

  next.availableActions = availableActions;
  return next;
}

function resetWeaponActionSettings(weapon = {}) {
  const next = {
    ...weapon,
    availableActions: createEmptyAvailableActions(),
    aimedShot: withActionCost({}, 0),
    snapshot: withActionCost({}, 0),
    meleeAttack: withActionCost({}, 0),
    aimedMeleeAttack: withActionCost({}, 0),
    push: withActionCost({}, 0),
    reload: withActionCost({ actionPointCost: 3 }, 0),
    burst: {
      ...withActionCost({}, 0),
      attackConeDegrees: weapon.burst?.attackConeDegrees ?? 30,
      count: weapon.burst?.count ?? 3,
      difficultyPerShot: weapon.burst?.difficultyPerShot ?? 10,
      criticalFailureConsequences: weapon.burst?.criticalFailureConsequences ?? []
    },
    volley: {
      ...withActionCost({}, 0),
      damageRadius: weapon.volley?.damageRadius ?? "0",
      regionRadius: weapon.volley?.regionRadius ?? "0",
      regionDamageEntries: weapon.volley?.regionDamageEntries ?? [],
      regionDurationSeconds: weapon.volley?.regionDurationSeconds ?? "0",
      regionDelaySeconds: weapon.volley?.regionDelaySeconds ?? "0",
      regionRadiusDeltaMeters: weapon.volley?.regionRadiusDeltaMeters ?? "0",
      explosionAnimationKey: weapon.volley?.explosionAnimationKey ?? "",
      explosionSoundPath: weapon.volley?.explosionSoundPath ?? "",
      criticalFailureConsequences: weapon.volley?.criticalFailureConsequences ?? []
    }
  };
  return next;
}

function createEmptyAvailableActions() {
  return {
    aimedShot: false,
    snapshot: false,
    burst: false,
    volley: false,
    meleeAttack: false,
    aimedMeleeAttack: false,
    push: false,
    reload: false
  };
}

function parseWeaponActionCatalog(flatText = "", { skillKey = "" } = {}) {
  const section = matchSection(flatText, /ДОСТУПНЫЕ\s+ДЕЙСТВИЯ:\s*([^]+?)(?=МОДУЛИ:|ДОП\.|ТРЕБОВАНИЯ:|ПРИМЕЧАНИЕ:|ОСОБЕННОСТИ:|ПУТИ|$)/i);
  const catalog = [];

  for (const chunk of section.split(/\)\s*/).filter(Boolean)) {
    const label = chunk.replace(/^\s*\(/, "").trim();
    if (!label) continue;
    const costMatch = label.match(/(.+?)\s*\(\s*(\d+)\s*ОД\s*$/i) ?? label.match(/(.+?)\s*\(\s*(\d+)\s*ОД/i);
    const actionLabel = String(costMatch?.[1] ?? label).trim();
    if (!shouldImportWeaponAction(actionLabel, skillKey)) continue;
    const actionPointCost = parseInteger(costMatch?.[2]);
    const bindingKey = resolveActionBindingKey(actionLabel);
    if (!bindingKey) continue;
    catalog.push({ label: actionLabel, bindingKey, actionPointCost });
  }

  return catalog;
}

function resolveActionBindingKey(actionLabel = "") {
  for (const entry of ACTION_LABEL_TO_BINDING_KEY) {
    if (entry.pattern.test(actionLabel)) return entry.bindingKey;
  }
  return "";
}

function parseAttackAnimationDelayMs(flatText = "") {
  const match = String(flatText ?? "").match(/Путь\s+звука\s+(?:выстрела|атаки(?:\s+модуля)?)\s*\((\d+)\)\s*:/i);
  if (match) return Math.max(0, parseInteger(match[1]));
  return DEFAULT_ATTACK_ANIMATION_DELAY_MS;
}

function resolveModeSkillKey(modeMeta, mode, weapon) {
  const label = String(modeMeta?.label ?? "").trim();
  if (SKILL_LABELS.has(label)) return SKILL_LABELS.get(label);
  if (/метан/i.test(label)) return "throwing";
  if (/ближн/i.test(label)) return "meleeCombat";
  if (/дальн/i.test(label)) return "rangedCombat";
  return weapon.skillKey ?? "meleeCombat";
}

function normalizeModeLabel(label = "") {
  return String(label ?? "").trim().toLocaleLowerCase("ru-RU");
}

function countModeLabel(modes = [], label = "") {
  const normalized = normalizeModeLabel(label);
  return modes.filter(mode => normalizeModeLabel(mode.label) === normalized).length;
}

function looksLikeThrowModeAssets(assets = {}) {
  const animationPath = String(assets?.animationPath ?? "").toLowerCase();
  return animationPath.includes("throw") || animationPath.includes("metanut");
}

function extractInlineJsonBlobs(flatText = "") {
  const blobs = [];
  for (const match of String(flatText ?? "").matchAll(/\{"version":1,[\s\S]+?\}(?=\s*\{|\s*Путь|\s*ТРЕБОВАНИЯ|$)/g)) {
    try {
      blobs.push(JSON.parse(match[0]));
    } catch {
      // ignore malformed inline json
    }
  }
  return blobs;
}

function findInlineJsonBlob(flatText = "", key = "") {
  return extractInlineJsonBlobs(flatText).find(blob => blob?.[key] != null) ?? null;
}

export function buildWeaponActionPatch(description = "", itemName = "", options = {}) {
  const parsed = parseWeaponMigration(description, itemName, options);
  return {
    weapon: pickWeaponActionPatchFields(parsed.primary),
    additionalWeapons: parsed.additionalWeapons.map(pickWeaponActionPatchFields)
  };
}

export function buildWeaponMediaPatch(description = "", itemName = "", options = {}) {
  const parsed = parseWeaponMigration(description, itemName, options);
  return {
    weapon: pickWeaponMediaPatchFields(parsed.primary),
    additionalWeapons: parsed.additionalWeapons.map(pickWeaponMediaPatchFields)
  };
}

function pickWeaponMediaPatchFields(weapon = {}) {
  const magazineMax = Math.max(0, Number(weapon.magazine?.max) || 0);
  const patch = {
    name: String(weapon.name ?? "").trim(),
    attackAnimationKey: String(weapon.attackAnimationKey ?? ""),
    attackSoundPath: String(weapon.attackSoundPath ?? "")
  };
  const volley = weapon.volley ?? {};
  if (volley.explosionAnimationKey || volley.explosionSoundPath) {
    patch.volley = {
      explosionAnimationKey: String(volley.explosionAnimationKey ?? ""),
      explosionSoundPath: String(volley.explosionSoundPath ?? "")
    };
  }
  if (magazineMax > 0) patch.magazine = { value: magazineMax };
  return patch;
}

function pickWeaponActionPatchFields(weapon = {}) {
  return {
    name: String(weapon.name ?? "").trim(),
    proficiencyKey: weapon.proficiencyKey,
    attackAnimationDelayMs: weapon.attackAnimationDelayMs,
    availableActions: weapon.availableActions,
    skillKey: weapon.skillKey,
    damage: weapon.damage,
    pellets: weapon.pellets,
    damageTypeKey: weapon.damageTypeKey,
    damageTypes: weapon.damageTypes,
    attackAnimationKey: weapon.attackAnimationKey,
    attackSoundPath: weapon.attackSoundPath,
    accuracyBonus: weapon.accuracyBonus,
    criticalChanceModifier: weapon.criticalChanceModifier,
    criticalDamagePercent: weapon.criticalDamagePercent,
    maxRangeMeters: weapon.maxRangeMeters,
    effectiveRange: weapon.effectiveRange,
    penetration: weapon.penetration,
    resourceCosts: weapon.resourceCosts,
    aimedShot: weapon.aimedShot,
    snapshot: weapon.snapshot,
    burst: weapon.burst,
    volley: weapon.volley,
    meleeAttack: weapon.meleeAttack,
    aimedMeleeAttack: weapon.aimedMeleeAttack,
    push: weapon.push,
    reload: weapon.reload
  };
}

function applySkillModeFields(weapon, mode) {
  const fields = mode?.fields ?? {};
  const next = { ...weapon };
  if (fields.damageBase != null) next.damage = String(scaleWeaponDamage(fields.damageBase));
  if (fields.rangeMax != null) next.maxRangeMeters = String(convertFeetToRangeMeters(fields.rangeMax));
  if (fields.rangeEffective) {
    next.effectiveRange = convertEffectiveRangeFeetToMeters({
      value: String(fields.rangeEffective.min ?? 0),
      max: String(fields.rangeEffective.max ?? fields.rangeEffective.min ?? 0)
    });
  }
  if (fields.accuracy != null) next.accuracyBonus = formatStatNumber(fields.accuracy);
  if (fields.critChance != null) next.criticalChanceModifier = formatStatNumber(fields.critChance);
  if (fields.critDamage != null) next.criticalDamagePercent = formatStatNumber(fields.critDamage);
  if (fields.penetrationPower != null) next.penetration = String(scalePenetration(fields.penetrationPower));
  if (fields.shotgunScatter != null || fields.ammoPerBurst != null) {
    next.pellets = String(DEFAULT_SHOTGUN_PELLETS);
  }
  if (fields.damageRadius != null) {
    next.availableActions = { ...next.availableActions, volley: true };
    next.volley = {
      ...next.volley,
      damageRadius: String(convertFeetToRadiusMeters(fields.damageRadius)),
      regionRadius: String(convertFeetToRadiusMeters(fields.damageRadius))
    };
    next.pellets = String(DEFAULT_EXPLOSION_PELLETS);
  }
  if (mode.assets?.animationPath) next.attackAnimationKey = migrateWeaponAnimationKey(mode.assets.animationPath);
  if (mode.assets?.soundPath) next.attackSoundPath = migrateWeaponSoundPath(mode.assets.soundPath);
  if (mode.assets?.explosionAnimationPath) next.volley.explosionAnimationKey = migrateWeaponAnimationKey(mode.assets.explosionAnimationPath);
  if (mode.assets?.explosionSoundPath) next.volley.explosionSoundPath = migrateWeaponSoundPath(mode.assets.explosionSoundPath);
  if (Array.isArray(mode.damageSets?.[0]) && mode.damageSets[0].length) {
    const damageTypes = mode.damageSets[0]
      .map(entry => ({
        key: resolveDamageTypeKey(entry.type),
        percent: Math.max(0, Math.round(parseNumber(entry.percent)))
      }))
      .filter(entry => entry.percent > 0);
    if (damageTypes.length) {
      next.damageTypes = damageTypes;
      next.damageTypeKey = damageTypes[0].key;
    }
  }
  return next;
}

function parseWeaponDamageLine(flatText = "") {
  const match = flatText.match(/Урон:\s*(\d+)\s*-\s*([\s\S]+?)(?=ДОСТУПНЫЕ|МОДУЛИ:|ТРЕБОВАНИЯ:|ПРИМЕЧАНИЕ:|ПУТИ|$)/i);
  if (!match) {
    return { damage: 0, primaryType: "firearm", damageTypes: [{ key: "firearm", percent: 100 }] };
  }

  const damage = parseInteger(match[1]);
  const tail = match[2];
  const damageTypes = [];
  for (const part of tail.split(/\s*-\s*/)) {
    const piece = part.trim().match(/(\d+(?:[.,]\d+)?)%?\s*([A-Za-zА-Яа-яЁё-]+)/);
    if (!piece) continue;
    const key = resolveDamageTypeKey(piece[2]);
    damageTypes.push({ key, percent: Math.max(0, Math.round(parseNumber(piece[1]))) });
  }

  if (!damageTypes.length) {
    const fallback = tail.match(/(\d+(?:[.,]\d+)?)%?\s*([A-Za-zА-Яа-яЁё-]+)/);
    if (fallback) {
      damageTypes.push({
        key: resolveDamageTypeKey(fallback[2]),
        percent: Math.max(0, Math.round(parseNumber(fallback[1]))) || 100
      });
    }
  }

  if (!damageTypes.length) damageTypes.push({ key: "firearm", percent: 100 });
  return {
    damage,
    primaryType: damageTypes[0].key,
    damageTypes
  };
}

function parseWeaponActions(flatText = "", { skillKey = "" } = {}) {
  const catalog = parseWeaponActionCatalog(flatText, { skillKey });
  const availableActions = createEmptyAvailableActions();
  const costs = {};

  for (const action of catalog) {
    const actionKey = BINDING_KEY_TO_ACTION_KEY[action.bindingKey];
    if (!actionKey) continue;
    availableActions[actionKey] = true;
    if (action.actionPointCost > 0) costs[actionKey] = action.actionPointCost;
  }

  return { availableActions, costs };
}

function parseWeaponRequirements(flatText = "") {
  const section = matchSection(flatText, /ТРЕБОВАНИЯ:\s*([^]+?)(?=ЗАНИМАЕТ:|ПРИМЕЧАНИЕ:|ПУТИ|$)/i);
  const requirements = [];
  for (const [label, key] of SKILL_LABELS) {
    const match = section.match(new RegExp(`${label}:\\s*(\\d+)`, "i"));
    if (!match) continue;
    requirements.push({ type: "skill", key, value: parseInteger(match[1]) });
  }
  for (const [label, key] of CHARACTERISTIC_LABELS) {
    const match = section.match(new RegExp(`${label}:\\s*(\\d+)`, "i"));
    if (!match) continue;
    requirements.push({ type: "characteristic", key, value: parseInteger(match[1]) });
  }
  return requirements;
}

function parseWeaponMediaPaths(flatText = "", html = "") {
  const pick = (pattern) => String(flatText.match(pattern)?.[1] ?? "").trim();
  return {
    attackAnimationKey: pick(/Путь\s+анимации\s+(?:выстрела|атаки(?:\s+модуля)?):\s*([^\s]+)/i),
    attackSoundPath: pick(/Путь\s+звука\s+(?:выстрела|атаки(?:\s+модуля)?)\s*(?:\(\d+\))?\s*:\s*([^\s]+)/i),
    explosionAnimationKey: pick(/Путь\s+анимации\s+взрыва(?:\s+модуля)?:\s*([^\s]+)/i),
    explosionSoundPath: pick(/Путь\s+звука\s+взрыва(?:\s+модуля)?:\s*([^\s]+)/i),
    buttAnimationKey: pick(/Путь\s+анимации\s+приклада:\s*([^\s]+)/i),
    buttSoundPath: pick(/Путь\s+звука\s+приклада:\s*([^\s]+)/i)
  };
}

function resolveWeaponPellets(flatText, damageInfo, actions) {
  const scatter = parseInteger(matchField(flatText, /Дробь:\s*(\d+)/i));
  if (scatter > 1) return DEFAULT_SHOTGUN_PELLETS;
  if (actions.availableActions.volley || parseNumber(matchField(flatText, /Радиус\s+поражения:/i)) > 0) {
    return DEFAULT_EXPLOSION_PELLETS;
  }
  return 1;
}

function parseBonusPairs(section = "", labelMap = new Map()) {
  const entries = [];
  for (const chunk of String(section ?? "").split("|")) {
    const match = chunk.trim().match(/^([^:+]+):\s*([+-]?\d+(?:[.,]\d+)?)/);
    if (!match) continue;
    const key = labelMap.get(match[1].trim());
    const value = parseNumber(match[2]);
    if (!key || !value) continue;
    entries.push({ key, value });
  }
  return entries;
}

function createEffectChange(key, value) {
  return {
    id: migrationRandomId(),
    key,
    type: "add",
    value: String(value),
    phase: "initial",
    priority: null
  };
}

function parseMitigationCellValue(cell = "") {
  return Math.max(0, parseInteger(String(cell ?? "").replace(/[^\d+-]/g, "")));
}

function extractHiddenJson(html = "", elementId = "") {
  const match = String(html ?? "").match(new RegExp(`id="${elementId}"[^>]*>([^<]+)`, "i"));
  if (!match?.[1]) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
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

function parseConditionFields(flatText) {
  const conditionMatch = flatText.match(/Состояние:\s*(\d+)\s*\/\s*(\d+)/i);
  const magazineMatch = flatText.match(/Магазин:\s*(\d+)\s*\/\s*(\d+)/i);

  return {
    repairDifficulty: parseInteger(matchField(flatText, /Сложность\s+ремонта:\s*(\d+)/i)),
    partClass: normalizeToolClass(matchField(flatText, /Мин\.?\s*класс\s+деталей:\s*([A-D]|S\+?)/i)),
    conditionValue: conditionMatch?.[1] ?? 0,
    conditionMax: conditionMatch?.[2] ?? 0,
    weakeningThreshold: parseInteger(matchField(flatText, /Порог\s+ослабления:\s*(\d+)/i)),
    magazineMax: magazineMatch?.[2] ?? 0,
    conditionLossPerShot: parseInteger(matchField(flatText, /Потеря\s+прочности\s+за\s+выстрел:\s*(\d+)/i))
  };
}

function hashSelectionKey(normalized) {
  let hash = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    hash = ((hash << 5) - hash) + normalized.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function getEquipmentSlotSelectionKey(label) {
  const normalized = String(label ?? "").trim().toLocaleLowerCase();
  return `slot${hashSelectionKey(normalized)}`;
}

function getWeaponSlotSelectionKey(slot = {}) {
  const limbKey = String(slot?.limbKey ?? "").trim();
  if (limbKey) return `limb:${limbKey}`;
  const label = String(slot?.label ?? slot?.key ?? "").trim().toLocaleLowerCase();
  return `weapon:${hashSelectionKey(label)}`;
}

function parseOccupiedSectionText(flatText = "") {
  return String(matchField(flatText, /(?:З[Аа]НИМАЕТ|Занимает):\s*([^]+?)(?=ТРЕБОВАНИЯ|ПРИМЕЧАНИЯ|ПРИМЕЧАНИЕ|Защита|ДОСТУПНЫЕ|Калибр:|Тип|НАВЫКИ:|ХАРАКТЕРИСТИКИ:|$)/i) ?? "").trim();
}

function parseOccupiedEquipmentSlots(flatText = "") {
  const section = parseOccupiedSectionText(flatText);
  if (!section || /^(?:одн[уа]|одной|две|обе)\s+рук/i.test(section)) {
    return { occupiedSlots: {}, occupiedSlotMode: "all" };
  }

  const occupiedSlots = {};
  const matchedLabels = new Set();
  for (const [token, label] of EQUIPMENT_SLOT_TOKEN_MAP) {
    const pattern = new RegExp(`(?:^|\\s)${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`, "i");
    if (!pattern.test(section) || matchedLabels.has(label)) continue;
    matchedLabels.add(label);
    occupiedSlots[getEquipmentSlotSelectionKey(label)] = true;
  }

  return {
    occupiedSlots,
    occupiedSlotMode: "all"
  };
}

function parseWeaponHandRequirement(flatText = "", itemName = "") {
  const section = parseOccupiedSectionText(flatText);
  const context = `${section} ${itemName} ${flatText}`;
  const rightKey = getWeaponSlotSelectionKey({ limbKey: "rightArm" });
  const leftKey = getWeaponSlotSelectionKey({ limbKey: "leftArm" });
  const slots = { [rightKey]: true, [leftKey]: true };

  if (/две\s+руки|обе\s+руки/i.test(section)) {
    return { mode: "all", slots };
  }
  if (/одн[уа]\s+рук|одной\s+рук/i.test(section)) {
    return { mode: "oneOf", slots };
  }
  if (/винтов|дробов|автомат|пулем[её]т|миниган|ракет|гранатом|тяжел|тяжё/i.test(context)) {
    return { mode: "all", slots };
  }
  if (/пистолет|револьвер|нож|кинжал|меч|дубин|топор|кастет|кирка|лом/i.test(context)) {
    return { mode: "oneOf", slots };
  }
  return { mode: "oneOf", slots };
}

export function buildRangedConditionLossByRarity(weaponFlatTexts = []) {
  const buckets = new Map();
  for (const flatText of weaponFlatTexts) {
    const rarity = parseRarityLabel(flatText);
    const loss = parseInteger(matchField(flatText, /Потеря\s+прочности\s+за\s+выстрел:\s*(\d+)/i));
    if (!rarity || loss <= 0) continue;
    if (!buckets.has(rarity)) buckets.set(rarity, []);
    buckets.get(rarity).push(loss);
  }

  const result = new Map();
  for (const [rarity, losses] of buckets) {
    losses.sort((left, right) => left - right);
    result.set(rarity, losses[Math.floor(losses.length / 2)]);
  }
  return result;
}

function resolveRarityConditionFallback(rarity = "", rarityConditionLossByRarity = null) {
  const key = String(rarity ?? "").trim();
  if (!key || !rarityConditionLossByRarity) return 0;
  if (rarityConditionLossByRarity instanceof Map) return Math.max(0, parseInteger(rarityConditionLossByRarity.get(key)));
  return Math.max(0, parseInteger(rarityConditionLossByRarity[key]));
}

function applyWeaponResourceCosts(weapon = {}, resourceCostContext = {}, modeFields = null) {
  weapon.resourceCosts = buildWeaponResourceCosts(resourceCostContext.flatText ?? "", {
    skillKey: weapon.skillKey,
    caliberKey: resourceCostContext.parsedGear?.caliberKey,
    magazineMax: weapon.magazine?.max ?? resourceCostContext.parsedGear?.magazineMax,
    modeFields,
    rarity: resourceCostContext.rarity,
    rarityConditionLossByRarity: resourceCostContext.rarityConditionLossByRarity
  });
  return weapon;
}

function buildWeaponResourceCosts(flatText = "", {
  skillKey = "",
  caliberKey = "",
  magazineMax = 0,
  modeFields = null,
  rarity = "",
  rarityConditionLossByRarity = null
} = {}) {
  const costs = [];
  const isThrow = skillKey === "throwing";
  const isRanged = skillKey === "rangedCombat"
    || Boolean(String(caliberKey ?? "").trim())
    || parseInteger(magazineMax) > 0
    || /калибр:|магазин:/i.test(flatText);

  let conditionLoss = 0;

  if (isRanged) {
    conditionLoss = parseInteger(matchField(flatText, /Потеря\s+прочности\s+за\s+выстрел:\s*(\d+)/i));
  } else if (isThrow) {
    conditionLoss = parseInteger(modeFields?.durabilityLoss);
    costs.push({ type: "quantity", amount: 1 });
  } else {
    conditionLoss = resolveRarityConditionFallback(rarity, rarityConditionLossByRarity);
  }

  if (conditionLoss > 0) {
    costs.push({ type: "condition", amount: conditionLoss });
  }

  if (isRanged) {
    costs.push({ type: "magazine", amount: 1 });
  }

  return costs;
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

function parseEffectiveRange(flatText, { convertFeet = true } = {}) {
  const rangeText = matchField(flatText, /Эффективная\s+дистанция:\s*([^]+?)(?=Точность:|Шанс|Крит|Пробивная|Распределение|Урон|ДОСТУПНЫЕ|$)/i);
  if (!rangeText) return { value: "0", max: "0" };

  const pair = rangeText.match(/([+-]?\d+(?:[.,]\d+)?)\s*\/\s*([+-]?\d+(?:[.,]\d+)?)/);
  if (pair) {
    return convertEffectiveRangeFeetToMeters({
      value: formatStatNumber(pair[1]),
      max: formatStatNumber(pair[2])
    }, { convertFeet });
  }

  const dash = rangeText.match(/(\d+(?:[.,]\d+)?)\s*-\s*(\d+(?:[.,]\d+)?)/);
  if (dash) {
    return convertEffectiveRangeFeetToMeters({
      value: formatStatNumber(dash[1]),
      max: formatStatNumber(dash[2])
    }, { convertFeet });
  }

  return convertEffectiveRangeFeetToMeters({ value: "0", max: formatStatNumber(rangeText) }, { convertFeet });
}

function convertEffectiveRangeFeetToMeters(range = {}, { convertFeet = true } = {}) {
  if (!convertFeet) return range;
  return {
    value: String(convertFeetToRangeMeters(parseNumber(range.value))),
    max: String(convertFeetToRangeMeters(parseNumber(range.max)))
  };
}

function convertFeetToRangeMeters(value) {
  const feet = parseNumber(value);
  if (!feet) return 0;
  return Math.round(feet / FEET_TO_RANGE_METERS);
}

function convertFeetToRadiusMeters(value) {
  const feet = parseNumber(value);
  if (!feet) return 0;
  return Math.round(feet / FEET_TO_RADIUS_METERS);
}

function scaleWeaponDamage(value) {
  return Math.max(0, Math.round(parseNumber(value) * WEAPON_DAMAGE_MULTIPLIER));
}

function scalePenetration(value) {
  return Math.max(0, Math.round(parseNumber(value) * WEAPON_PENETRATION_MULTIPLIER));
}

function resolveDamageTypeKey(label = "") {
  const normalized = String(label ?? "").trim();
  return DAMAGE_TYPE_ALIASES.get(normalized)
    ?? DAMAGE_TYPE_ALIASES.get(normalized.toLowerCase())
    ?? DAMAGE_TYPE_ALIASES.get(normalized.charAt(0).toUpperCase() + normalized.slice(1).toLowerCase())
    ?? "firearm";
}

function resolveSkillKey(label = "") {
  const normalized = String(label ?? "").trim();
  return SKILL_LABELS.get(normalized)
    ?? SKILL_LABELS.get(normalized.toLowerCase())
    ?? "rangedCombat";
}

function applyWeaponProficiencies(weapon, flatText, weaponSlotRequirement) {
  weapon.proficiencyKey = inferProficiencyKey(flatText, weapon.skillKey, weapon, weaponSlotRequirement);
  return weapon;
}

function resolvePhysicalDamageCategory(damageTypes = [], damageTypeKey = "") {
  const types = Array.isArray(damageTypes) && damageTypes.length
    ? damageTypes
    : [{ key: damageTypeKey || "slashing", percent: 100 }];

  for (const category of ["piercing", "slashing", "bludgeoning"]) {
    if (types.some(entry => entry?.key === category && Number(entry.percent) > 0)) return category;
  }

  return "slashing";
}

function inferMeleeProficiencyKey(weapon = {}, weaponSlotRequirement = {}) {
  const twoHanded = String(weaponSlotRequirement?.mode ?? "") === "all";
  const category = resolvePhysicalDamageCategory(weapon.damageTypes, weapon.damageTypeKey);
  const handedPrefix = twoHanded ? "twoHanded" : "oneHanded";
  const categorySuffix = category.charAt(0).toUpperCase() + category.slice(1);
  return `${handedPrefix}${categorySuffix}`;
}

function inferProficiencyKey(flatText, skillKey, weapon = {}, weaponSlotRequirement = {}) {
  if (skillKey === "meleeCombat" || skillKey === "throwing") {
    return inferMeleeProficiencyKey(weapon, weaponSlotRequirement);
  }

  if (/пистолет|револьвер/i.test(flatText)) return "pistol";
  if (/дробов|shotgun|12\s*кал/i.test(flatText)) return "shotgun";
  if (/пулем[её]т|миниган/i.test(flatText)) return "machineGun";
  if (/гранатом[её]т/i.test(flatText)) return "grenadeLauncher";
  if (/огнем[её]т/i.test(flatText)) return "flamethrower";
  if (/автомат|штурм|смг|пп\b/i.test(flatText)) return "automatic";
  if (/винтов/i.test(flatText)) return "rifle";
  if (/гранат|ракет|взрыв/i.test(flatText)) return "grenadeLauncher";
  return "rifle";
}

function withActionCost(base, actionPointCost) {
  return actionPointCost > 0
    ? { ...base, actionPointCost }
    : base;
}

function matchSection(text, pattern) {
  return String(text ?? "").match(pattern)?.[1]?.trim() ?? "";
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

function formatStatNumber(value) {
  const parsed = parseNumber(value);
  if (!Number.isFinite(parsed)) return "0";
  return trimNumber(parsed);
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
