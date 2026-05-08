import { FALLOUT_MAW, syncSystemConfig } from "../config/system-config.mjs";
import {
  createDefaultCharacteristicSettings,
  createDefaultDamageTypeSettings,
  createDefaultProficiencySettings,
  createDefaultResourceSettings,
  createDefaultSkillAdvancementSettings,
  createDefaultSkillSettings,
  normalizeCharacteristicSettings,
  normalizeDamageTypeSettings,
  normalizeNeedSettings,
  normalizeProficiencySettings,
  normalizeResourceSettings,
  normalizeSkillAdvancementSettings,
  normalizeSkillSettings
} from "../formulas/index.mjs";
import { createDefaultCurrencySettings, normalizeCurrencySettings } from "./currency-settings.mjs";
import {
  CHARACTERISTICS_SETTING,
  CREATURE_OPTIONS_SETTING,
  CURRENCY_SETTINGS_SETTING,
  DAMAGE_TYPES_SETTING,
  DISEASE_SETTINGS_SETTING,
  LEVELS_SETTING,
  PROFICIENCY_SETTINGS_SETTING,
  RESOURCE_SETTINGS_SETTING,
  SKILL_CHECK_CONTROL_SETTING,
  SKILL_SETTINGS_SETTING,
  SYSTEM_ACTION_SETTINGS_SETTING,
  TIME_MECHANICS_IGNORED_SETTING,
  TIME_NEEDS_PLAYERS_ONLY_SETTING,
  TOOL_SETTINGS_SETTING,
  TRAUMA_SETTINGS_SETTING
} from "./constants.mjs";
import { createEmptyCreatureOptions, normalizeCreatureOptions } from "./creature-options.mjs";
import { createDefaultDiseaseSettings, normalizeDiseaseSettings } from "./diseases.mjs";
import { createDefaultLevelSettings, normalizeLevelSettings } from "./levels.mjs";
import { createDefaultTraumaSettings, normalizeTraumaSettings } from "./traumas.mjs";
import {
  createDefaultSystemActionSettings,
  createDefaultToolSettings,
  normalizeSystemActionSettings,
  normalizeToolSettings
} from "./tools.mjs";

export const DEFAULT_SKILL_CHECK_CONTROL = Object.freeze({
  resultMode: "standard",
  skillModifier: 0,
  difficultyModifier: 0,
  criticalSuccessBonus: 0,
  criticalFailureBonus: 0,
  edgeMode: "none",
  resetResultAfterUse: false,
  resetModifiersAfterUse: false,
  resetEdgeModeAfterUse: false
});

const SKILL_CHECK_RESULT_MODES = new Set(["standard", "criticalSuccess", "success", "failure", "criticalFailure"]);
const SKILL_CHECK_EDGE_MODES = new Set(["none", "advantage", "disadvantage"]);

export function normalizeSkillCheckControl(value = {}) {
  const source = foundry.utils.mergeObject(
    foundry.utils.deepClone(DEFAULT_SKILL_CHECK_CONTROL),
    value && typeof value === "object" ? value : {},
    { inplace: false }
  );
  return {
    resultMode: SKILL_CHECK_RESULT_MODES.has(source.resultMode) ? source.resultMode : DEFAULT_SKILL_CHECK_CONTROL.resultMode,
    skillModifier: toInteger(source.skillModifier),
    difficultyModifier: toInteger(source.difficultyModifier),
    criticalSuccessBonus: toInteger(source.criticalSuccessBonus),
    criticalFailureBonus: toInteger(source.criticalFailureBonus),
    edgeMode: SKILL_CHECK_EDGE_MODES.has(source.edgeMode) ? source.edgeMode : DEFAULT_SKILL_CHECK_CONTROL.edgeMode,
    resetResultAfterUse: Boolean(source.resetResultAfterUse),
    resetModifiersAfterUse: Boolean(source.resetModifiersAfterUse),
    resetEdgeModeAfterUse: Boolean(source.resetEdgeModeAfterUse)
  };
}

function toInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
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
  await setCreatureOptions(getCreatureOptions(normalized), normalized, getDamageTypeSettings());
  return normalized;
}

export async function resetCharacteristicSettings() {
  return setCharacteristicSettings(createDefaultCharacteristicSettings());
}

export function getSkillSettings() {
  try {
    return normalizeSkillSettings(game.settings.get(FALLOUT_MAW.id, SKILL_SETTINGS_SETTING));
  } catch (_error) {
    return createDefaultSkillSettings();
  }
}

export function getSkillAdvancementSettings(characteristics = getCharacteristicSettings(), skills = getSkillSettings()) {
  try {
    return normalizeSkillAdvancementSettings(game.settings.get(FALLOUT_MAW.id, SKILL_SETTINGS_SETTING), skills, characteristics);
  } catch (_error) {
    return createDefaultSkillAdvancementSettings(skills, characteristics);
  }
}

export async function setSkillSettings(settings) {
  const skillEntries = normalizeSkillSettings(settings);
  const advancement = normalizeSkillAdvancementSettings(settings, skillEntries, getCharacteristicSettings());
  const normalized = { entries: skillEntries, advancement };
  await game.settings.set(FALLOUT_MAW.id, SKILL_SETTINGS_SETTING, normalized);
  return normalized;
}

export async function resetSkillSettings() {
  return setSkillSettings({
    entries: createDefaultSkillSettings(),
    advancement: createDefaultSkillAdvancementSettings()
  });
}

export function getProficiencySettings() {
  try {
    return normalizeProficiencySettings(game.settings.get(FALLOUT_MAW.id, PROFICIENCY_SETTINGS_SETTING));
  } catch (_error) {
    return createDefaultProficiencySettings();
  }
}

export async function setProficiencySettings(settings) {
  const normalized = normalizeProficiencySettings(settings);
  await game.settings.set(FALLOUT_MAW.id, PROFICIENCY_SETTINGS_SETTING, normalized);
  return normalized;
}

export async function resetProficiencySettings() {
  return setProficiencySettings(createDefaultProficiencySettings());
}

export function getDamageTypeSettings() {
  try {
    return normalizeDamageTypeSettings(game.settings.get(FALLOUT_MAW.id, DAMAGE_TYPES_SETTING));
  } catch (_error) {
    return createDefaultDamageTypeSettings();
  }
}

export async function setDamageTypeSettings(settings) {
  const normalized = normalizeDamageTypeSettings(settings);
  const characteristics = getCharacteristicSettings();
  await game.settings.set(FALLOUT_MAW.id, DAMAGE_TYPES_SETTING, normalized);
  await setCreatureOptions(getCreatureOptions(characteristics, normalized), characteristics, normalized);
  return normalized;
}

export async function resetDamageTypeSettings() {
  return setDamageTypeSettings(createDefaultDamageTypeSettings());
}

export function getCurrencySettings() {
  try {
    return normalizeCurrencySettings(game.settings.get(FALLOUT_MAW.id, CURRENCY_SETTINGS_SETTING));
  } catch (_error) {
    return createDefaultCurrencySettings();
  }
}

export async function setCurrencySettings(settings) {
  const normalized = normalizeCurrencySettings(settings);
  await game.settings.set(FALLOUT_MAW.id, CURRENCY_SETTINGS_SETTING, normalized);
  return normalized;
}

export async function resetCurrencySettings() {
  return setCurrencySettings(createDefaultCurrencySettings());
}

export function getCreatureOptions(characteristics = getCharacteristicSettings(), damageTypes = getDamageTypeSettings()) {
  try {
    return normalizeCreatureOptions(game.settings.get(FALLOUT_MAW.id, CREATURE_OPTIONS_SETTING), characteristics, damageTypes);
  } catch (_error) {
    return normalizeCreatureOptions(createEmptyCreatureOptions(), characteristics, damageTypes);
  }
}

export async function setCreatureOptions(options, characteristics = getCharacteristicSettings(), damageTypes = getDamageTypeSettings()) {
  return game.settings.set(FALLOUT_MAW.id, CREATURE_OPTIONS_SETTING, normalizeCreatureOptions(options, characteristics, damageTypes));
}

export function getResourceSettings() {
  try {
    return normalizeResourceSettings(game.settings.get(FALLOUT_MAW.id, RESOURCE_SETTINGS_SETTING));
  } catch (_error) {
    return createDefaultResourceSettings();
  }
}

export async function setResourceSettings(settings) {
  const normalized = normalizeResourceSettings(settings);
  await game.settings.set(FALLOUT_MAW.id, RESOURCE_SETTINGS_SETTING, normalized);
  return normalized;
}

export async function resetResourceSettings() {
  return setResourceSettings(createDefaultResourceSettings());
}

export function getNeedSettings() {
  return getAllRaceNeedSettings();
}

export function getActorNeedSettings(actor) {
  const raceId = actor?.system?.creature?.raceId ?? actor?.creature?.raceId ?? "";
  if (!raceId) return [];
  const race = getCreatureOptions().races.find(entry => entry.id === raceId);
  return normalizeNeedSettings(race?.needSettings ?? []);
}

export function getRaceNeedSettings(race) {
  return normalizeNeedSettings(race?.needSettings ?? []);
}

export function getAllRaceNeedSettings() {
  const entries = [];
  const used = new Set();
  for (const race of getCreatureOptions().races) {
    for (const need of normalizeNeedSettings(race.needSettings ?? [])) {
      if (used.has(need.key)) continue;
      used.add(need.key);
      entries.push(need);
    }
  }
  return entries;
}

export function getTimeMechanicsIgnored() {
  return Boolean(game.settings.get(FALLOUT_MAW.id, TIME_MECHANICS_IGNORED_SETTING));
}

export async function setTimeMechanicsIgnored(value) {
  await game.settings.set(FALLOUT_MAW.id, TIME_MECHANICS_IGNORED_SETTING, Boolean(value));
  return Boolean(value);
}

export function getTimeNeedsPlayersOnly() {
  return Boolean(game.settings.get(FALLOUT_MAW.id, TIME_NEEDS_PLAYERS_ONLY_SETTING));
}

export async function setTimeNeedsPlayersOnly(value) {
  await game.settings.set(FALLOUT_MAW.id, TIME_NEEDS_PLAYERS_ONLY_SETTING, Boolean(value));
  return Boolean(value);
}

export function getDiseaseSettings() {
  try {
    return normalizeDiseaseSettings(game.settings.get(FALLOUT_MAW.id, DISEASE_SETTINGS_SETTING));
  } catch (_error) {
    return createDefaultDiseaseSettings();
  }
}

export async function setDiseaseSettings(settings) {
  const normalized = normalizeDiseaseSettings(settings);
  await game.settings.set(FALLOUT_MAW.id, DISEASE_SETTINGS_SETTING, normalized);
  return normalized;
}

export async function resetDiseaseSettings() {
  return setDiseaseSettings(createDefaultDiseaseSettings());
}

export function getLevelSettings() {
  try {
    return normalizeLevelSettings(game.settings.get(FALLOUT_MAW.id, LEVELS_SETTING));
  } catch (_error) {
    return createDefaultLevelSettings();
  }
}

export async function setLevelSettings(settings) {
  const normalized = normalizeLevelSettings(settings);
  await game.settings.set(FALLOUT_MAW.id, LEVELS_SETTING, normalized);
  return normalized;
}

export async function resetLevelSettings() {
  return setLevelSettings(createDefaultLevelSettings());
}

export function getTraumaSettings(creatureOptions = getCreatureOptions(), damageTypes = getDamageTypeSettings()) {
  try {
    return normalizeTraumaSettings(game.settings.get(FALLOUT_MAW.id, TRAUMA_SETTINGS_SETTING), creatureOptions, damageTypes);
  } catch (_error) {
    return normalizeTraumaSettings(createDefaultTraumaSettings(), creatureOptions, damageTypes);
  }
}

export async function setTraumaSettings(settings, creatureOptions = getCreatureOptions(), damageTypes = getDamageTypeSettings()) {
  const normalized = normalizeTraumaSettings(settings, creatureOptions, damageTypes);
  await game.settings.set(FALLOUT_MAW.id, TRAUMA_SETTINGS_SETTING, normalized);
  return normalized;
}

export async function resetTraumaSettings() {
  return setTraumaSettings(createDefaultTraumaSettings());
}

export function getToolSettings() {
  try {
    return normalizeToolSettings(game.settings.get(FALLOUT_MAW.id, TOOL_SETTINGS_SETTING));
  } catch (_error) {
    return createDefaultToolSettings();
  }
}

export async function setToolSettings(settings) {
  const normalized = normalizeToolSettings(settings);
  await game.settings.set(FALLOUT_MAW.id, TOOL_SETTINGS_SETTING, normalized);
  return normalized;
}

export async function resetToolSettings() {
  return setToolSettings(createDefaultToolSettings());
}

export function getSystemActionSettings() {
  try {
    return normalizeSystemActionSettings(game.settings.get(FALLOUT_MAW.id, SYSTEM_ACTION_SETTINGS_SETTING));
  } catch (_error) {
    return createDefaultSystemActionSettings();
  }
}

export async function setSystemActionSettings(settings) {
  const normalized = normalizeSystemActionSettings(settings);
  await game.settings.set(FALLOUT_MAW.id, SYSTEM_ACTION_SETTINGS_SETTING, normalized);
  return normalized;
}

export async function resetSystemActionSettings() {
  return setSystemActionSettings(createDefaultSystemActionSettings());
}

export function getSkillCheckControl() {
  try {
    return normalizeSkillCheckControl(game.settings.get(FALLOUT_MAW.id, SKILL_CHECK_CONTROL_SETTING));
  } catch (_error) {
    return normalizeSkillCheckControl();
  }
}

export async function setSkillCheckControl(value) {
  const normalized = normalizeSkillCheckControl(value);
  await game.settings.set(FALLOUT_MAW.id, SKILL_CHECK_CONTROL_SETTING, normalized);
  return normalized;
}

export function syncSettingsIntoSystemConfig() {
  return syncSystemConfig({
    characteristics: getCharacteristicSettings(),
    currencies: getCurrencySettings(),
    skills: getSkillSettings(),
    proficiencies: getProficiencySettings(),
    resources: getResourceSettings(),
    needs: getNeedSettings(),
    damageTypes: getDamageTypeSettings()
  });
}

export function refreshPreparedActors() {
  syncSettingsIntoSystemConfig();
  syncActorTrackableAttributes();
  for (const actor of getLoadedActors()) {
    actor.reset();
    actor.sheet?.render(false);
  }
}

export function syncActorTrackableAttributes() {
  if (!globalThis.CONFIG?.Actor?.trackableAttributes) return;

  const bar = [
    ...getResourceSettings().map(resource => `resources.${resource.key}`),
    ...getNeedSettings().map(need => `needs.${need.key}`),
    ...getSkillSettings().map(skill => `skills.${skill.key}`),
    ...getProficiencySettings().map(proficiency => `proficiencies.${proficiency.key}`)
  ];
  const value = ["attributes.level"];

  CONFIG.Actor.trackableAttributes = Object.fromEntries(
    FALLOUT_MAW.actorTypes.map(type => [
      type,
      {
        bar: [...bar],
        value: [...value]
      }
    ])
  );
}

function getLoadedActors() {
  const actors = new Set(game.actors?.contents ?? []);
  for (const token of globalThis.canvas?.tokens?.placeables ?? []) {
    if (token.actor) actors.add(token.actor);
  }
  return actors;
}
