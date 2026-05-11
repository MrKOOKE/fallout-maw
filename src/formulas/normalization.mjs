import {
  DEFAULT_CHARACTERISTICS,
  DEFAULT_DAMAGE_TYPES,
  DEFAULT_NEEDS,
  DEFAULT_PROFICIENCIES,
  DEFAULT_PROFICIENCY_INFLUENCE,
  DEFAULT_RESOURCES,
  DEFAULT_SKILL_DEVELOPMENT_LIMIT,
  DEFAULT_SIGNATURE_SKILL_FLAT_BONUS,
  DEFAULT_SIGNATURE_SKILL_MULTIPLIER,
  DEFAULT_SKILL_ADVANCEMENT,
  DEFAULT_SKILLS
} from "../config/defaults.mjs";
import { toInteger } from "../utils/numbers.mjs";

const FALLBACK_ICON = "icons/svg/d20-grey.svg";

export const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_TRACK_COLOR = "#8f8456";
const DEFAULT_RESOURCE_COLORS = Object.freeze({
  health: "#c64b44",
  energy: "#4f9f61",
  dodge: "#4f97a5",
  actionPoints: "#74b84e",
  movementPoints: "#d7b14a"
});
const DEFAULT_RESOURCE_LIMIT_RESOURCES = Object.freeze([
  Object.freeze({ resourceKey: "actionPoints", percent: 100 }),
  Object.freeze({ resourceKey: "movementPoints", percent: 100 })
]);
const DEFAULT_EQUIPMENT_CONDITION_DAMAGE_FORMULA = "protected + thresholdBlocked * 0.5 + unconditional";
const DEFAULT_NEED_COLORS = Object.freeze({
  hunger: "#c9a24a",
  thirst: "#58a6d6",
  sleepiness: "#8f63c9",
  radcont: "#b620a7"
});
const ALL_CHARACTERISTIC_KEYS = Object.freeze(DEFAULT_CHARACTERISTICS.map(entry => entry.key));
const DEFAULT_NEED_BEHAVIOR = Object.freeze({
  accumulation: Object.freeze({ perHour: 10 }),
  thresholds: Object.freeze([]),
  diseases: Object.freeze([])
});
const DEFAULT_NEED_SETTINGS_BY_KEY = Object.freeze({
  hunger: Object.freeze({
    accumulation: Object.freeze({ perHour: 10 }),
    thresholds: Object.freeze([
      createNeedEffectThreshold(50, { strength: -2, dexterity: -2 }),
      createNeedEffectThreshold(75, { strength: -2, dexterity: -2, endurance: -2 }),
      createNeedEffectThreshold(100, { strength: -4, dexterity: -4, endurance: -3 })
    ])
  }),
  thirst: Object.freeze({
    accumulation: Object.freeze({ perHour: 10 }),
    thresholds: Object.freeze([
      createNeedEffectThreshold(50, { perception: -2, intelligence: -2 }),
      createNeedEffectThreshold(75, { perception: -2, intelligence: -2, charisma: -2 }),
      createNeedEffectThreshold(100, { perception: -4, intelligence: -4, charisma: -3 })
    ])
  }),
  sleepiness: Object.freeze({
    accumulation: Object.freeze({ perHour: 10 }),
    thresholds: Object.freeze([
      createNeedEffectThreshold(50, Object.fromEntries(ALL_CHARACTERISTIC_KEYS.map(key => [key, -1]))),
      createNeedEffectThreshold(75, Object.fromEntries(ALL_CHARACTERISTIC_KEYS.map(key => [key, -2]))),
      createNeedEffectThreshold(100, Object.fromEntries(ALL_CHARACTERISTIC_KEYS.map(key => [key, -3])))
    ])
  }),
  radcont: Object.freeze({
    accumulation: Object.freeze({ perHour: 0 }),
    thresholds: Object.freeze([
      createNeedDiseaseThreshold(25, 1)
    ])
  })
});
const DEFAULT_DAMAGE_TYPE_SETTINGS = Object.freeze({
  limbStateDamage: Object.freeze({ multiplier: 1 }),
  periodic: Object.freeze({
    enabled: false,
    effectName: "",
    img: "",
    immediatePercent: 100,
    delayedPercent: 0,
    tickCount: 0,
    intervalSeconds: 6
  }),
  needIncrease: Object.freeze({
    enabled: false,
    needKey: "",
    percent: 100,
    preventHealthDamage: false
  }),
  resourceLimit: Object.freeze({
    enabled: false,
    effectName: "",
    img: "",
    color: "#3f8cff",
    durationSeconds: 12,
    resources: Object.freeze([])
  }),
  equipmentConditionDamage: Object.freeze({
    enabled: true,
    formula: DEFAULT_EQUIPMENT_CONDITION_DAMAGE_FORMULA
  })
});
const DEFAULT_DAMAGE_TYPE_SETTINGS_BY_KEY = Object.freeze({
  bludgeoning: Object.freeze({ limbStateDamage: Object.freeze({ multiplier: 2 }) }),
  fire: Object.freeze({
    periodic: Object.freeze({
      enabled: true,
      effectName: "Горение",
      img: "icons/magic/fire/flame-burning-creature-skeleton.webp",
      immediatePercent: 50,
      delayedPercent: 50,
      tickCount: 1,
      intervalSeconds: 6
    })
  }),
  poison: Object.freeze({
    periodic: Object.freeze({
      enabled: true,
      effectName: "Яд",
      img: "icons/magic/death/skull-poison-green.webp",
      immediatePercent: 0,
      delayedPercent: 100,
      tickCount: 3,
      intervalSeconds: 6
    })
  }),
  acid: Object.freeze({
    equipmentConditionDamage: Object.freeze({
      enabled: true,
      formula: "(protected + thresholdBlocked * 0.5) * 3 + unconditional"
    })
  }),
  cryo: Object.freeze({
    resourceLimit: Object.freeze({
      enabled: true,
      effectName: "Крио-ограничение",
      img: "icons/magic/water/barrier-ice-crystal-wall-jagged-blue.webp",
      color: "#3f8cff",
      durationSeconds: 12,
      resources: DEFAULT_RESOURCE_LIMIT_RESOURCES
    })
  }),
  radiation: Object.freeze({
    needIncrease: Object.freeze({
      enabled: true,
      needKey: "radcont",
      percent: 100,
      preventHealthDamage: true
    })
  })
});

export function createDefaultCharacteristicSettings() {
  return DEFAULT_CHARACTERISTICS.map(entry => ({ ...entry }));
}

export function createDefaultSkillSettings() {
  return DEFAULT_SKILLS.map(entry => ({ ...entry }));
}

export function createDefaultSkillAdvancementSettings(
  skillSettings = createDefaultSkillSettings(),
  characteristicSettings = createDefaultCharacteristicSettings()
) {
  const skills = normalizeSkillSettings(skillSettings);
  const characteristics = normalizeCharacteristicSettings(characteristicSettings);

  return {
    signatureMultiplier: DEFAULT_SIGNATURE_SKILL_MULTIPLIER,
    signatureFlatBonus: DEFAULT_SIGNATURE_SKILL_FLAT_BONUS,
    developmentLimit: DEFAULT_SKILL_DEVELOPMENT_LIMIT,
    entries: Object.fromEntries(
      skills.map(skill => {
        const defaults = DEFAULT_SKILL_ADVANCEMENT[skill.key] ?? {};
        return [skill.key, {
          base: toDecimal(defaults.base, 0),
          characteristics: Object.fromEntries(
            characteristics.map(characteristic => [
              characteristic.key,
              toDecimal(defaults.characteristics?.[characteristic.key], 0)
            ])
          )
        }];
      })
    )
  };
}

export function createDefaultProficiencySettings() {
  return DEFAULT_PROFICIENCIES.map(entry => ({ ...entry }));
}

export function createDefaultProficiencyInfluenceSettings() {
  return {
    accuracy: { ...DEFAULT_PROFICIENCY_INFLUENCE.accuracy },
    damage: { ...DEFAULT_PROFICIENCY_INFLUENCE.damage },
    criticalChance: { ...DEFAULT_PROFICIENCY_INFLUENCE.criticalChance },
    criticalDamage: { ...DEFAULT_PROFICIENCY_INFLUENCE.criticalDamage }
  };
}

export function createDefaultResourceSettings() {
  return DEFAULT_RESOURCES.map(entry => ({ ...entry }));
}

export function createDefaultNeedSettings() {
  return DEFAULT_NEEDS.map(entry => ({ ...entry, settings: getDefaultNeedBehavior(entry.key) }));
}

export function createDefaultDamageTypeSettings() {
  return DEFAULT_DAMAGE_TYPES.map(entry => ({ ...entry, settings: getDefaultDamageTypeSettings(entry.key) }));
}

export function normalizeCharacteristicSettings(settings) {
  const source = normalizeCollectionInput(settings?.characteristics ?? settings, createDefaultCharacteristicSettings());
  return normalizeKeyedEntries(
    source,
    entry => {
      const key = String(entry?.key ?? "").trim();
      return {
        key,
        abbr: String(entry?.abbr ?? "").trim(),
        label: String(entry?.label ?? entry?.name ?? "").trim()
      };
    },
    "Характеристика"
  );
}

export function normalizeSkillSettings(settings) {
  const source = normalizeSkillSettingsInput(settings);
  return normalizeKeyedEntries(
    source,
    entry => {
      const key = String(entry?.key ?? "").trim();
      return {
        key,
        abbr: String(entry?.abbr ?? "").trim(),
        label: String(entry?.label ?? entry?.name ?? "").trim(),
        formula: String(entry?.formula ?? "0").trim() || "0",
        img: normalizeImagePath(entry?.img)
      };
    },
    "Навык"
  );
}

export function normalizeSkillAdvancementSettings(
  settings,
  skillSettings = createDefaultSkillSettings(),
  characteristicSettings = createDefaultCharacteristicSettings()
) {
  const skills = normalizeSkillSettings(skillSettings);
  const characteristics = normalizeCharacteristicSettings(characteristicSettings);
  const defaults = createDefaultSkillAdvancementSettings(skills, characteristics);
  const source = settings?.advancement ?? settings ?? {};

  return {
    signatureMultiplier: toDecimal(source?.signatureMultiplier ?? source?.signature?.multiplier, defaults.signatureMultiplier),
    signatureFlatBonus: toDecimal(source?.signatureFlatBonus ?? source?.signature?.flatBonus, defaults.signatureFlatBonus),
    developmentLimit: Math.max(0, toInteger(source?.developmentLimit ?? source?.limit ?? defaults.developmentLimit)),
    entries: Object.fromEntries(
      skills.map(skill => {
        const sourceEntry = source?.entries?.[skill.key] ?? source?.skills?.[skill.key] ?? source?.[skill.key] ?? {};
        const defaultEntry = defaults.entries[skill.key];
        return [skill.key, {
          base: toDecimal(sourceEntry?.base ?? sourceEntry?.baseMultiplier, defaultEntry.base),
          characteristics: Object.fromEntries(
            characteristics.map(characteristic => [
              characteristic.key,
              toDecimal(
                sourceEntry?.characteristics?.[characteristic.key] ?? sourceEntry?.[characteristic.key],
                defaultEntry.characteristics[characteristic.key]
              )
            ])
          )
        }];
      })
    )
  };
}

export function normalizeProficiencySettings(settings) {
  const source = normalizeCollectionInput(settings, createDefaultProficiencySettings());
  return normalizeKeyedEntries(
    source,
    entry => {
      const key = String(entry?.key ?? "").trim();
      return {
        key,
        abbr: String(entry?.abbr ?? "").trim(),
        label: String(entry?.label ?? entry?.name ?? "").trim(),
        max: Math.max(0, toInteger(entry?.max))
      };
    },
    "Владение"
  );
}

export function normalizeProficiencyInfluenceSettings(settings = {}) {
  const defaults = createDefaultProficiencyInfluenceSettings();
  const source = settings?.influence ?? settings ?? {};
  return {
    accuracy: normalizeProficiencyInfluenceRange(source.accuracy, defaults.accuracy),
    damage: normalizeProficiencyInfluenceRange(source.damage, defaults.damage),
    criticalChance: normalizeProficiencyInfluenceRange(source.criticalChance, defaults.criticalChance),
    criticalDamage: normalizeProficiencyInfluenceRange(source.criticalDamage, defaults.criticalDamage)
  };
}

function normalizeProficiencyInfluenceRange(range = {}, defaults = { min: 0, max: 0 }) {
  return {
    min: toInteger(range?.min ?? defaults.min),
    max: toInteger(range?.max ?? defaults.max)
  };
}

export function normalizeResourceSettings(settings) {
  return normalizeFormulaSettings(settings, createDefaultResourceSettings(), "Ресурс");
}

export function normalizeNeedSettings(settings) {
  const source = normalizeCollectionInput(settings, createDefaultNeedSettings());
  return normalizeKeyedEntries(
    source,
    entry => {
      const key = String(entry?.key ?? "").trim();
      return {
        key,
        abbr: String(entry?.abbr ?? "").trim(),
        label: String(entry?.label ?? entry?.name ?? "").trim(),
        formula: String(entry?.formula ?? "0").trim() || "0",
        color: normalizeHexColor(entry?.color, getDefaultColorForKey(key)),
        settings: normalizeNeedBehavior(entry?.settings, key)
      };
    },
    "Потребность"
  );
}

export function normalizeDamageTypeSettings(settings) {
  const source = normalizeCollectionInput(settings, createDefaultDamageTypeSettings());
  return normalizeKeyedEntries(
    source,
    entry => normalizeDamageTypeEntry(entry),
    "Тип урона"
  );
}

export function normalizeFormulaMap(values = {}, definitions = [], defaultFormula = "0") {
  return Object.fromEntries(
    definitions.map(definition => {
      const formula = String(values?.[definition.key] ?? defaultFormula).trim();
      return [definition.key, formula || defaultFormula];
    })
  );
}

export function normalizeNumberMap(values = {}, definitions = []) {
  return Object.fromEntries(definitions.map(definition => [definition.key, toInteger(values?.[definition.key])]));
}

export function getCharacteristicAliases(characteristics) {
  const normalized = normalizeCharacteristicSettings(characteristics);
  const aliases = {};
  for (const entry of normalized) addEntryAliases(aliases, entry);
  return aliases;
}

export function getSkillAliases(skills) {
  const normalized = normalizeSkillSettings(skills);
  const aliases = {};
  for (const entry of normalized) addEntryAliases(aliases, entry);
  return aliases;
}

function normalizeSkillSettingsInput(settings) {
  if (settings === undefined || settings === null) return createDefaultSkillSettings();
  if (Array.isArray(settings)) return settings;
  if (settings && typeof settings === "object" && Array.isArray(settings.entries)) return settings.entries;
  return createDefaultSkillSettings();
}

function normalizeFormulaSettings(settings, defaults, defaultLabel) {
  const source = normalizeCollectionInput(settings, defaults);
  return normalizeKeyedEntries(
    source,
    entry => {
      const key = String(entry?.key ?? "").trim();
      return {
        key,
        abbr: String(entry?.abbr ?? "").trim(),
        label: String(entry?.label ?? entry?.name ?? "").trim(),
        formula: String(entry?.formula ?? "0").trim() || "0",
        color: normalizeHexColor(entry?.color, getDefaultColorForKey(key))
      };
    },
    defaultLabel
  );
}

function normalizeCollectionInput(settings, defaults) {
  if (settings === undefined || settings === null) return defaults;
  if (Array.isArray(settings)) return settings;
  if (Array.isArray(settings?.entries)) return settings.entries;
  if (settings && typeof settings === "object") {
    return Object.entries(settings).map(([key, label]) => ({ key, label }));
  }
  return defaults;
}

function normalizeKeyedEntries(source, mapEntry, defaultLabel) {
  const used = new Set();
  const entries = [];

  for (const raw of source) {
    const entry = mapEntry(raw);
    if (!IDENTIFIER_PATTERN.test(entry.key) || used.has(entry.key)) continue;
    used.add(entry.key);
    entries.push({ ...entry, label: entry.label || `${defaultLabel} ${entries.length + 1}` });
  }

  return entries;
}

function addEntryAliases(aliases, entry) {
  aliases[entry.key.toLowerCase()] = entry.key;
  if (entry.abbr) aliases[entry.abbr.toLowerCase()] = entry.key;
}

function getDefaultColorForKey(key = "") {
  return normalizeHexColor(
    DEFAULT_RESOURCE_COLORS[key]
    ?? DEFAULT_NEED_COLORS[key]
    ?? DEFAULT_TRACK_COLOR,
    DEFAULT_TRACK_COLOR
  );
}

function normalizeHexColor(value, fallback = DEFAULT_TRACK_COLOR) {
  const normalized = normalizeHexColorString(value);
  if (normalized) return normalized;
  return normalizeHexColorString(fallback) ?? DEFAULT_TRACK_COLOR;
}

function normalizeHexColorString(value) {
  const trimmed = String(value ?? "").trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{6}$/.test(trimmed)) return `#${trimmed}`;
  if (/^[0-9a-f]{3}$/.test(trimmed)) return `#${trimmed.split("").map(char => `${char}${char}`).join("")}`;
  return null;
}

function normalizeDamageTypeEntry(entry = {}) {
  const key = String(entry?.key ?? "").trim();
  return {
    key,
    label: String(entry?.label ?? entry?.name ?? "").trim(),
    color: normalizeHexColor(entry?.color, getDefaultDamageTypeColor(key)),
    settings: normalizeDamageTypeBehavior(entry?.settings, key)
  };
}

function getDefaultDamageTypeColor(key = "") {
  return DEFAULT_DAMAGE_TYPES.find(entry => entry.key === key)?.color ?? DEFAULT_TRACK_COLOR;
}

function normalizeDamageTypeBehavior(settings = {}, key = "") {
  const defaults = getDefaultDamageTypeSettings(key);
  const source = settings && typeof settings === "object" ? settings : {};
  const resourceLimitSource = source.resourceLimit ?? source.resourceBlock ?? {};
  const resourceLimitDefaults = source.resourceLimit
    ? defaults.resourceLimit
    : {
      ...defaults.resourceLimit,
      resources: source.resourceBlock ? DEFAULT_RESOURCE_LIMIT_RESOURCES : defaults.resourceLimit.resources
    };
  return {
    limbStateDamage: {
      multiplier: Math.max(0, toDecimal(source.limbStateDamage?.multiplier, defaults.limbStateDamage.multiplier))
    },
    periodic: {
      enabled: Boolean(source.periodic?.enabled ?? defaults.periodic.enabled),
      effectName: String(source.periodic?.effectName ?? defaults.periodic.effectName ?? "").trim(),
      img: String(source.periodic?.img ?? defaults.periodic.img ?? "").trim(),
      immediatePercent: clampPercent(toDecimal(source.periodic?.immediatePercent, defaults.periodic.immediatePercent)),
      delayedPercent: clampPercent(toDecimal(source.periodic?.delayedPercent, defaults.periodic.delayedPercent)),
      tickCount: Math.max(0, toInteger(source.periodic?.tickCount ?? defaults.periodic.tickCount)),
      intervalSeconds: Math.max(1, toInteger(source.periodic?.intervalSeconds ?? defaults.periodic.intervalSeconds))
    },
    needIncrease: {
      enabled: Boolean(source.needIncrease?.enabled ?? defaults.needIncrease.enabled),
      needKey: String(source.needIncrease?.needKey ?? defaults.needIncrease.needKey ?? "").trim(),
      percent: Math.max(0, toDecimal(source.needIncrease?.percent, defaults.needIncrease.percent)),
      preventHealthDamage: Boolean(source.needIncrease?.preventHealthDamage ?? defaults.needIncrease.preventHealthDamage)
    },
    resourceLimit: {
      enabled: Boolean(resourceLimitSource.enabled ?? resourceLimitDefaults.enabled),
      effectName: String(resourceLimitSource.effectName ?? resourceLimitDefaults.effectName ?? "").trim(),
      img: String(resourceLimitSource.img ?? resourceLimitDefaults.img ?? "").trim(),
      color: normalizeHexColor(resourceLimitSource.color, resourceLimitDefaults.color),
      durationSeconds: Math.max(1, toInteger(resourceLimitSource.durationSeconds ?? resourceLimitDefaults.durationSeconds)),
      resources: normalizeResourceLimitEntries(resourceLimitSource.resources, resourceLimitDefaults.resources)
    },
    equipmentConditionDamage: {
      enabled: Boolean(source.equipmentConditionDamage?.enabled ?? defaults.equipmentConditionDamage.enabled),
      formula: String(source.equipmentConditionDamage?.formula ?? defaults.equipmentConditionDamage.formula ?? DEFAULT_EQUIPMENT_CONDITION_DAMAGE_FORMULA).trim()
        || DEFAULT_EQUIPMENT_CONDITION_DAMAGE_FORMULA
    }
  };
}

function normalizeResourceLimitEntries(entries, defaults = []) {
  const source = Array.isArray(entries) ? entries : defaults;
  return source
    .map(entry => ({
      resourceKey: String(entry?.resourceKey ?? entry?.key ?? "").trim(),
      percent: Math.max(0, toDecimal(entry?.percent, 100))
    }))
    .filter(entry => IDENTIFIER_PATTERN.test(entry.resourceKey));
}

function normalizeNeedBehavior(settings = {}, key = "") {
  const defaults = getDefaultNeedBehavior(key);
  const source = settings && typeof settings === "object" ? settings : {};
  return {
    accumulation: normalizeNeedAccumulation(source.accumulation, defaults.accumulation),
    thresholds: normalizeNeedThresholds(source.thresholds, defaults.thresholds),
    diseases: normalizeNeedDiseases(source.diseases, defaults.diseases)
  };
}

function normalizeNeedAccumulation(accumulation = {}, defaults = DEFAULT_NEED_BEHAVIOR.accumulation) {
  const source = accumulation && typeof accumulation === "object" ? accumulation : {};
  return {
    perHour: Math.max(0, toDecimal(source.perHour, defaults?.perHour ?? 10))
  };
}

function normalizeNeedThresholds(thresholds, defaults = []) {
  const source = Array.isArray(thresholds) ? thresholds : defaults;
  return source.map((entry, index) => ({
    id: String(entry?.id ?? `threshold-${index + 1}`).trim() || `threshold-${index + 1}`,
    percent: clampPercent(toDecimal(entry?.percent, 0)),
    diseaseLevel: Math.max(0, toInteger(entry?.diseaseLevel)),
    effects: normalizeNeedEffects(entry?.effects)
  })).sort((left, right) => left.percent - right.percent);
}

function normalizeNeedDiseases(diseases, defaults = []) {
  const source = Array.isArray(diseases) ? diseases : defaults;
  return source.map((entry, index) => ({
    id: String(entry?.id ?? `disease-${index + 1}`).trim() || `disease-${index + 1}`,
    name: String(entry?.name ?? "").trim() || `Болезнь ${index + 1}`,
    img: String(entry?.img ?? "").trim(),
    stages: normalizeNeedDiseaseStages(entry?.stages)
  })).filter(entry => entry.stages.length);
}

function normalizeNeedDiseaseStages(stages) {
  const source = Array.isArray(stages) ? stages : [];
  return source.map((entry, index) => ({
    id: String(entry?.id ?? `stage-${index + 1}`).trim() || `stage-${index + 1}`,
    level: Math.max(0, toInteger(entry?.level)),
    name: String(entry?.name ?? "").trim(),
    img: String(entry?.img ?? "").trim(),
    worseningHours: Math.max(1, toInteger(entry?.worseningHours ?? 24)),
    healingDifficulty: Math.max(0, toInteger(entry?.healingDifficulty ?? 60)),
    healingToolClass: normalizeToolClass(entry?.healingToolClass),
    healingProgress: Math.max(1, toInteger(entry?.healingProgress ?? entry?.healingProgressMax ?? 100)),
    healingSkillKey: String(entry?.healingSkillKey ?? "doctor").trim() || "doctor",
    effects: normalizeNeedEffects(entry?.effects)
  })).filter(entry => entry.level > 0);
}

function normalizeNeedEffects(effects) {
  const source = Array.isArray(effects) ? effects : [];
  return source.map(entry => {
    const priority = Number(entry?.priority);
    const result = {
      key: String(entry?.key ?? "").trim(),
      type: String(entry?.type ?? "add").trim() || "add",
      value: String(entry?.value ?? "0"),
      phase: String(entry?.phase ?? "initial").trim() || "initial"
    };
    if (Number.isFinite(priority)) result.priority = Math.trunc(priority);
    return result;
  }).filter(entry => entry.key);
}

function getDefaultNeedBehavior(key = "") {
  return foundry.utils.mergeObject(
    foundry.utils.deepClone(DEFAULT_NEED_BEHAVIOR),
    foundry.utils.deepClone(DEFAULT_NEED_SETTINGS_BY_KEY[key] ?? {}),
    { inplace: false }
  );
}

function createNeedEffectThreshold(percent, penalties = {}) {
  return Object.freeze({
    id: `at-${percent}`,
    percent,
    diseaseLevel: 0,
    effects: Object.freeze(Object.entries(penalties).map(([key, value]) => Object.freeze({
      key: `system.characteristics.${key}`,
      type: "add",
      value: String(value),
      phase: "initial",
      priority: null
    })))
  });
}

function createNeedDiseaseThreshold(percent, diseaseLevel) {
  return Object.freeze({
    id: `at-${percent}`,
    percent,
    diseaseLevel,
    effects: Object.freeze([])
  });
}

function normalizeToolClass(value) {
  const normalized = String(value ?? "D").trim().toUpperCase();
  return ["D", "C", "B", "A", "S"].includes(normalized) ? normalized : "D";
}

function getDefaultDamageTypeSettings(key = "") {
  return foundry.utils.mergeObject(
    foundry.utils.deepClone(DEFAULT_DAMAGE_TYPE_SETTINGS),
    foundry.utils.deepClone(DEFAULT_DAMAGE_TYPE_SETTINGS_BY_KEY[key] ?? {}),
    { inplace: false }
  );
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function normalizeImagePath(value) {
  return String(value ?? "").trim() || FALLBACK_ICON;
}

function toDecimal(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
