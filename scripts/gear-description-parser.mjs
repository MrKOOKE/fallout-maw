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

const ACTION_PATTERNS = [
  { key: "aimedShot", pattern: /прицельн(?:ый|ая)\s+(?:выстрел|атака)/i, settingKey: "aimedShot" },
  { key: "snapshot", pattern: /(?:одиночн(?:ый|ая)\s+выстрел|выстрел\s+на\s+вскидку|неприцельн(?:ый|ая)\s+выстрел)/i, settingKey: "snapshot" },
  { key: "burst", pattern: /очеред/i, settingKey: "burst" },
  { key: "volley", pattern: /залп/i, settingKey: "volley" },
  { key: "aimedMeleeAttack", pattern: /прицельн(?:ый|ая)\s+атака/i, settingKey: "aimedMeleeAttack" },
  { key: "meleeAttack", pattern: /(?:неприцельн(?:ый|ая)\s+атака|удар\s+прикладом)/i, settingKey: "meleeAttack" },
  { key: "push", pattern: /толчок/i, settingKey: "push" },
  { key: "reload", pattern: /перезаряд/i, settingKey: "reload" }
];

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

export function parseWeaponMigration(description = "", itemName = "", { magazineSourceOldIds = [] } = {}) {
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

  const skillModes = parseSkillModeVariants(html);
  if (skillModes.length === 1) {
    primary = applySkillModeFields(primary, skillModes[0]);
  } else if (skillModes.length > 1) {
    primary = applySkillModeFields(primary, skillModes[0]);
    for (let index = 1; index < skillModes.length; index += 1) {
      const mode = skillModes[index];
      additionalWeapons.push(buildAdditionalWeaponFromSkillMode(primary, mode, {
        itemName,
        index
      }));
    }
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
  const actions = parseWeaponActions(flatText);
  const skillKey = resolveSkillKey(matchField(flatText, /Задействованный\s+навык:\s*([^]+?)(?=Максимальная|Эффективная|Точность|Урон|ДОСТУПНЫЕ|$)/i));
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
    attackAnimationDelayMs: 0,
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

  return applyWeaponMediaPatch(weapon);
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

function parseSkillModeVariants(html = "") {
  const raw = extractHiddenJson(html, "bu-skill-fields");
  if (!raw?.fields) return [];
  const assets = extractHiddenJson(html, "bu-skill-assets")?.assets ?? {};
  const damageSets = extractHiddenJson(html, "bu-skill-damage")?.damageSets ?? {};

  return Object.entries(raw.fields).map(([modeId, fields], index) => ({
    id: modeId,
    index,
    fields,
    assets: assets[modeId] ?? {},
    damageSets: damageSets[modeId] ?? []
  }));
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

function buildAdditionalWeaponFromSkillMode(primary, mode, { itemName, index }) {
  const clone = structuredClone(primary);
  delete clone.id;
  const applied = applySkillModeFields(clone, mode);
  applied.id = migrationRandomId();
  applied.name = String(mode.fields?.weaponType ?? `${itemName} · режим ${index + 1}`).trim();
  applied.enabled = true;
  return applied;
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

function parseWeaponActions(flatText = "") {
  const section = matchSection(flatText, /ДОСТУПНЫЕ\s+ДЕЙСТВИЯ:\s*([^]+?)(?=МОДУЛИ:|ДОП\.|ТРЕБОВАНИЯ:|ПРИМЕЧАНИЕ:|ПУТИ|$)/i);
  const availableActions = {
    aimedShot: false,
    snapshot: false,
    burst: false,
    volley: false,
    meleeAttack: false,
    aimedMeleeAttack: false,
    push: false,
    reload: false
  };
  const costs = {};

  for (const chunk of section.split(/\)\s*/).filter(Boolean)) {
    const label = chunk.replace(/^\s*\(/, "").trim();
    if (!label) continue;
    const costMatch = label.match(/(.+?)\s*\(\s*(\d+)\s*ОД\s*$/i) ?? label.match(/(.+?)\s*\(\s*(\d+)\s*ОД/i);
    const actionLabel = String(costMatch?.[1] ?? label).trim();
    const actionPointCost = parseInteger(costMatch?.[2]);
    for (const entry of ACTION_PATTERNS) {
      if (!entry.pattern.test(actionLabel)) continue;
      availableActions[entry.key] = true;
      if (actionPointCost > 0) costs[entry.settingKey] = actionPointCost;
    }
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
    attackSoundPath: pick(/Путь\s+звука\s+(?:выстрела|атаки(?:\s+модуля)?):\s*([^\s]+)/i),
    explosionAnimationKey: pick(/Путь\s+анимации\s+взрыва(?:\s+модуля)?:\s*([^\s]+)/i),
    explosionSoundPath: pick(/Путь\s+звука\s+взрыва(?:\s+модуля)?:\s*([^\s]+)/i)
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

function buildWeaponResourceCosts(flatText = "", { skillKey = "", caliberKey = "", magazineMax = 0 } = {}) {
  const costs = [];
  const conditionLoss = parseInteger(matchField(flatText, /Потеря\s+прочности\s+за\s+выстрел:\s*(\d+)/i));
  if (conditionLoss > 0) {
    costs.push({ type: "condition", amount: conditionLoss });
  }

  const isRanged = skillKey === "rangedCombat"
    || Boolean(String(caliberKey ?? "").trim())
    || parseInteger(magazineMax) > 0
    || /калибр:|магазин:/i.test(flatText);
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

function inferProficiencyKey(flatText, skillKey) {
  if (/пистолет|револьвер/i.test(flatText)) return "pistol";
  if (/дробов|shotgun|12\s*кал/i.test(flatText)) return "shotgun";
  if (/автомат|штурм|пулем/i.test(flatText)) return "rifle";
  if (/винтов/i.test(flatText)) return "rifle";
  if (/гранат|ракет|взрыв/i.test(flatText)) return "heavy";
  if (skillKey === "meleeCombat" || skillKey === "throwing") return "melee";
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
