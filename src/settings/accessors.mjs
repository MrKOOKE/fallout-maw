import { FALLOUT_MAW, syncSystemConfig } from "../config/system-config.mjs";
import {
  createDefaultActionMovementFormulas,
  createDefaultCharacteristicSettings,
  createDefaultDamageTypeSettings,
  createDefaultSkillSettings,
  normalizeActionMovementFormulas,
  normalizeCharacteristicSettings,
  normalizeDamageTypeSettings,
  normalizeSkillSettings
} from "../formulas/index.mjs";
import {
  ACTION_MOVEMENT_FORMULAS_SETTING,
  CHARACTERISTICS_SETTING,
  CREATURE_OPTIONS_SETTING,
  DAMAGE_TYPES_SETTING,
  SKILL_SETTINGS_SETTING
} from "./constants.mjs";
import { createEmptyCreatureOptions, normalizeCreatureOptions } from "./creature-options.mjs";

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

export async function setSkillSettings(settings) {
  const normalized = normalizeSkillSettings(settings);
  await game.settings.set(FALLOUT_MAW.id, SKILL_SETTINGS_SETTING, normalized);
  return normalized;
}

export async function resetSkillSettings() {
  return setSkillSettings(createDefaultSkillSettings());
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

export function getActionMovementFormulas() {
  try {
    return normalizeActionMovementFormulas(game.settings.get(FALLOUT_MAW.id, ACTION_MOVEMENT_FORMULAS_SETTING));
  } catch (_error) {
    return createDefaultActionMovementFormulas();
  }
}

export async function setActionMovementFormulas(formulas) {
  const normalized = normalizeActionMovementFormulas(formulas);
  await game.settings.set(FALLOUT_MAW.id, ACTION_MOVEMENT_FORMULAS_SETTING, normalized);
  return normalized;
}

export async function resetActionMovementFormulas() {
  return setActionMovementFormulas(createDefaultActionMovementFormulas());
}

export function syncSettingsIntoSystemConfig() {
  return syncSystemConfig({
    characteristics: getCharacteristicSettings(),
    skills: getSkillSettings(),
    damageTypes: getDamageTypeSettings()
  });
}

export function refreshPreparedActors() {
  syncSettingsIntoSystemConfig();
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
