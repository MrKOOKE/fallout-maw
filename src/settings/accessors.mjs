import { FALLOUT_MAW, syncSystemConfig } from "../config/system-config.mjs";
import {
  createDefaultCharacteristicSettings,
  createDefaultDamageTypeSettings,
  createDefaultNeedSettings,
  createDefaultResourceSettings,
  createDefaultSkillSettings,
  normalizeCharacteristicSettings,
  normalizeDamageTypeSettings,
  normalizeNeedSettings,
  normalizeResourceSettings,
  normalizeSkillSettings
} from "../formulas/index.mjs";
import { createDefaultCurrencySettings, normalizeCurrencySettings } from "./currency-settings.mjs";
import {
  CHARACTERISTICS_SETTING,
  CREATURE_OPTIONS_SETTING,
  CURRENCY_SETTINGS_SETTING,
  DAMAGE_TYPES_SETTING,
  NEED_SETTINGS_SETTING,
  RESOURCE_SETTINGS_SETTING,
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
  try {
    return normalizeNeedSettings(game.settings.get(FALLOUT_MAW.id, NEED_SETTINGS_SETTING));
  } catch (_error) {
    return createDefaultNeedSettings();
  }
}

export async function setNeedSettings(settings) {
  const normalized = normalizeNeedSettings(settings);
  await game.settings.set(FALLOUT_MAW.id, NEED_SETTINGS_SETTING, normalized);
  return normalized;
}

export async function resetNeedSettings() {
  return setNeedSettings(createDefaultNeedSettings());
}

export function syncSettingsIntoSystemConfig() {
  return syncSystemConfig({
    characteristics: getCharacteristicSettings(),
    currencies: getCurrencySettings(),
    skills: getSkillSettings(),
    resources: getResourceSettings(),
    needs: getNeedSettings(),
    damageTypes: getDamageTypeSettings()
  });
}

export function refreshPreparedActors() {
  syncSettingsIntoSystemConfig();
  syncActorTrackableAttributes();
  for (const actor of getLoadedActors()) {
    actor.prepareData();
    actor.sheet?.render(false);
  }
}

export function syncActorTrackableAttributes() {
  if (!globalThis.CONFIG?.Actor?.trackableAttributes) return;

  const bar = [
    ...getResourceSettings().map(resource => `resources.${resource.key}`),
    ...getNeedSettings().map(need => `needs.${need.key}`)
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
