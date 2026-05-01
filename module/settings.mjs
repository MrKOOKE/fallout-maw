import { FALLOUT_MAW } from "./config.mjs";
import { ActionMovementFormulasConfig } from "./apps/action-movement-formulas-config.mjs";
import { CharacteristicsConfig } from "./apps/characteristics-config.mjs";
import { CreatureOptionsConfig } from "./apps/creature-options-config.mjs";
import { SkillFormulasConfig } from "./apps/skill-formulas-config.mjs";
import {
  createDefaultActionMovementFormulas,
  createDefaultCharacteristicSettings,
  createDefaultSkillFormulas,
  createDefaultSkillSettings,
  normalizeActionMovementFormulas,
  normalizeCharacteristicSettings,
  normalizeNumberMap,
  normalizeSkillFormulas,
  normalizeSkillSettings
} from "./formulas.mjs";

export const CREATURE_OPTIONS_SETTING = "creatureOptions";
export const CHARACTERISTICS_SETTING = "characteristics";
export const SKILL_SETTINGS_SETTING = "skillSettings";
export const LEGACY_SKILL_FORMULAS_SETTING = "skillFormulas";
export const ACTION_MOVEMENT_FORMULAS_SETTING = "actionMovementFormulas";

export function createEmptyCreatureOptions() {
  return {
    types: [],
    races: []
  };
}

export function createRaceDefaults(characteristics = getCharacteristicSettings()) {
  return {
    characteristics: Object.fromEntries(characteristics.map(entry => [entry.key, 0])),
    progression: {
      skillPointsPerLevel: 0,
      researchPointsPerLevel: 0
    }
  };
}

export function normalizeCreatureOptions(options = {}, characteristics = getCharacteristicSettings()) {
  const defaults = createEmptyCreatureOptions();
  const normalized = {
    types: Array.isArray(options.types) ? options.types : defaults.types,
    races: Array.isArray(options.races) ? options.races : defaults.races
  };

  normalized.types = normalized.types
    .filter(type => type?.id)
    .map(type => ({
      id: String(type.id),
      name: String(type.name || "Без названия")
    }));

  const typeIds = new Set(normalized.types.map(type => type.id));
  normalized.races = normalized.races
    .filter(race => race?.id)
    .map(race => {
      const typeId = typeIds.has(race.typeId) ? race.typeId : normalized.types[0]?.id || "";
      return {
        id: String(race.id),
        typeId,
        name: String(race.name || "Без названия"),
        characteristics: normalizeNumberMap(race.characteristics, characteristics),
        progression: {
          skillPointsPerLevel: toInteger(race.progression?.skillPointsPerLevel),
          researchPointsPerLevel: toInteger(race.progression?.researchPointsPerLevel)
        }
      };
    });

  return normalized;
}

export function getCharacteristicSettings() {
  try {
    return normalizeCharacteristicSettings(game.settings.get(FALLOUT_MAW.id, CHARACTERISTICS_SETTING));
  } catch (_error) {
    return createDefaultCharacteristicSettings();
  }
}

export async function setCharacteristicSettings(settings) {
  const normalized = normalizeCharacteristicSettings(settings);
  await game.settings.set(FALLOUT_MAW.id, CHARACTERISTICS_SETTING, normalized);
  await setCreatureOptions(getCreatureOptions(normalized), normalized);
  return normalized;
}

export async function resetCharacteristicSettings() {
  return setCharacteristicSettings(createDefaultCharacteristicSettings());
}

export function getSkillSettings() {
  try {
    const configured = game.settings.get(FALLOUT_MAW.id, SKILL_SETTINGS_SETTING);
    return normalizeSkillSettings(configured);
  } catch (_error) {
    return getLegacySkillSettings();
  }
}

export async function setSkillSettings(settings) {
  const normalized = normalizeSkillSettings(settings);
  return game.settings.set(FALLOUT_MAW.id, SKILL_SETTINGS_SETTING, normalized);
}

export async function resetSkillSettings() {
  return setSkillSettings(createDefaultSkillSettings());
}

export function getSkillFormulas() {
  return Object.fromEntries(getSkillSettings().map(skill => [skill.key, skill.formula]));
}

export async function setSkillFormulas(formulas) {
  return setSkillSettings(normalizeSkillFormulas(formulas));
}

export async function resetSkillFormulas() {
  return resetSkillSettings();
}

export function getCreatureOptions(characteristics = getCharacteristicSettings()) {
  return normalizeCreatureOptions(game.settings.get(FALLOUT_MAW.id, CREATURE_OPTIONS_SETTING), characteristics);
}

export async function setCreatureOptions(options, characteristics = getCharacteristicSettings()) {
  return game.settings.set(FALLOUT_MAW.id, CREATURE_OPTIONS_SETTING, normalizeCreatureOptions(options, characteristics));
}

export function getActionMovementFormulas() {
  return normalizeActionMovementFormulas(game.settings.get(FALLOUT_MAW.id, ACTION_MOVEMENT_FORMULAS_SETTING));
}

export async function setActionMovementFormulas(formulas) {
  return game.settings.set(
    FALLOUT_MAW.id,
    ACTION_MOVEMENT_FORMULAS_SETTING,
    normalizeActionMovementFormulas(formulas)
  );
}

export async function resetActionMovementFormulas() {
  return setActionMovementFormulas(createDefaultActionMovementFormulas());
}

export function registerSystemSettings() {
  game.settings.register(FALLOUT_MAW.id, CREATURE_OPTIONS_SETTING, {
    name: "Типы и расы существ",
    hint: "Список типов существ и рас с базовыми характеристиками и приростами.",
    scope: "world",
    config: false,
    type: Object,
    default: createEmptyCreatureOptions()
  });

  game.settings.register(FALLOUT_MAW.id, CHARACTERISTICS_SETTING, {
    name: "Настройка характеристик",
    hint: "Список характеристик системы: ключи и отображаемые названия.",
    scope: "world",
    config: false,
    type: Object,
    default: createDefaultCharacteristicSettings(),
    onChange: refreshPreparedActors
  });

  game.settings.register(FALLOUT_MAW.id, SKILL_SETTINGS_SETTING, {
    name: "Настройки навыков",
    hint: "Список навыков системы: ключи, отображаемые названия и формулы.",
    scope: "world",
    config: false,
    type: Object,
    default: createDefaultSkillSettings(),
    onChange: refreshPreparedActors
  });

  game.settings.register(FALLOUT_MAW.id, LEGACY_SKILL_FORMULAS_SETTING, {
    name: "Базовые формулы навыков",
    hint: "Старая скрытая настройка для миграции формул в настройки навыков.",
    scope: "world",
    config: false,
    type: Object,
    default: createDefaultSkillFormulas(),
    onChange: refreshPreparedActors
  });

  game.settings.register(FALLOUT_MAW.id, ACTION_MOVEMENT_FORMULAS_SETTING, {
    name: "Базовые формулы ОД/ОП",
    hint: "Формулы для вычисления базовых очков действия и очков перемещения.",
    scope: "world",
    config: false,
    type: Object,
    default: createDefaultActionMovementFormulas(),
    onChange: refreshPreparedActors
  });

  game.settings.registerMenu(FALLOUT_MAW.id, "creatureOptionsMenu", {
    name: "Типы и расы существ",
    label: "Открыть",
    hint: "Настроить типы существ, расы и базовые значения для новых персонажей.",
    icon: "fa-solid fa-users-gear",
    type: CreatureOptionsConfig,
    restricted: true
  });

  game.settings.registerMenu(FALLOUT_MAW.id, "characteristicsMenu", {
    name: "Настройка характеристик",
    label: "Открыть",
    hint: "Настроить ключи и названия характеристик.",
    icon: "fa-solid fa-list-check",
    type: CharacteristicsConfig,
    restricted: true
  });

  game.settings.registerMenu(FALLOUT_MAW.id, "skillSettingsMenu", {
    name: "Настройки навыков",
    label: "Открыть",
    hint: "Настроить ключи, названия и формулы навыков. Доступны числа, скобки, +, -, *, / и ключи характеристик.",
    icon: "fa-solid fa-square-root-variable",
    type: SkillFormulasConfig,
    restricted: true
  });

  game.settings.registerMenu(FALLOUT_MAW.id, "actionMovementFormulasMenu", {
    name: "Базовые формулы ОД/ОП",
    label: "Открыть",
    hint: "Настроить формулы базовых очков действия и очков перемещения.",
    icon: "fa-solid fa-person-running",
    type: ActionMovementFormulasConfig,
    restricted: true
  });
}

export async function finalizeSystemSettings() {
  if (!hasWorldSetting(SKILL_SETTINGS_SETTING) && hasWorldSetting(LEGACY_SKILL_FORMULAS_SETTING)) {
    await game.settings.set(FALLOUT_MAW.id, SKILL_SETTINGS_SETTING, getLegacySkillSettings());
  }
  syncSystemConfig();
  refreshPreparedActors();
}

export function syncSystemConfig() {
  const characteristics = getCharacteristicSettings();
  const skills = getSkillSettings();
  FALLOUT_MAW.characteristics = Object.fromEntries(characteristics.map(entry => [entry.key, entry.label]));
  FALLOUT_MAW.skills = Object.fromEntries(skills.map(entry => [entry.key, entry.label]));
  if (CONFIG.FalloutMaW) CONFIG.FalloutMaW = FALLOUT_MAW;
}

function getLegacySkillSettings() {
  try {
    return normalizeSkillFormulas(game.settings.get(FALLOUT_MAW.id, LEGACY_SKILL_FORMULAS_SETTING));
  } catch (_error) {
    return createDefaultSkillSettings();
  }
}

function hasWorldSetting(key) {
  return game.settings.storage?.get("world")?.has(`${FALLOUT_MAW.id}.${key}`) === true;
}

export function refreshPreparedActors() {
  syncSystemConfig();
  for (const actor of getLoadedActors()) {
    actor.prepareData();
    actor.sheet?.render(false);
  }
}

function getLoadedActors() {
  const actors = new Set(game.actors?.contents ?? []);
  for (const token of globalThis.canvas?.tokens?.placeables ?? []) {
    if (token.actor) actors.add(token.actor);
  }
  return actors;
}

function toInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}
