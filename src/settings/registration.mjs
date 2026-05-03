import { FALLOUT_MAW } from "../config/system-config.mjs";
import {
  createDefaultCharacteristicSettings,
  createDefaultDamageTypeSettings,
  createDefaultNeedSettings,
  createDefaultResourceSettings,
  createDefaultSkillSettings
} from "../formulas/index.mjs";
import { createDefaultCurrencySettings } from "./currency-settings.mjs";
import { localize } from "../utils/i18n.mjs";
import { CharacteristicsConfig } from "../apps/characteristics-config.mjs";
import { CreatureOptionsConfig } from "../apps/creature-options-config.mjs";
import { CurrencySettingsConfig } from "../apps/currency-settings-config.mjs";
import { DamageTypesConfig } from "../apps/damage-types-config.mjs";
import { NeedSettingsConfig } from "../apps/need-settings-config.mjs";
import { ResourceSettingsConfig } from "../apps/resource-settings-config.mjs";
import { SkillFormulasConfig } from "../apps/skill-formulas-config.mjs";
import { refreshPreparedActors, syncSettingsIntoSystemConfig } from "./accessors.mjs";
import {
  CHARACTERISTICS_SETTING,
  CREATURE_OPTIONS_SETTING,
  CURRENCY_SETTINGS_SETTING,
  DAMAGE_TYPES_SETTING,
  NEED_SETTINGS_SETTING,
  RESOURCE_SETTINGS_SETTING,
  SKILL_SETTINGS_SETTING
} from "./constants.mjs";
import { createEmptyCreatureOptions } from "./creature-options.mjs";

export function registerSystemSettings() {
  game.settings.register(FALLOUT_MAW.id, CREATURE_OPTIONS_SETTING, {
    name: localize("FALLOUTMAW.Settings.CreatureOptions.Title"),
    scope: "world",
    config: false,
    type: Object,
    default: createEmptyCreatureOptions(),
    onChange: refreshPreparedActors
  });

  game.settings.register(FALLOUT_MAW.id, CHARACTERISTICS_SETTING, {
    name: localize("FALLOUTMAW.Settings.Characteristics.Title"),
    scope: "world",
    config: false,
    type: Object,
    default: createDefaultCharacteristicSettings(),
    onChange: refreshPreparedActors
  });

  game.settings.register(FALLOUT_MAW.id, SKILL_SETTINGS_SETTING, {
    name: localize("FALLOUTMAW.Settings.Skills.Title"),
    scope: "world",
    config: false,
    type: Object,
    default: createDefaultSkillSettings(),
    onChange: refreshPreparedActors
  });

  game.settings.register(FALLOUT_MAW.id, DAMAGE_TYPES_SETTING, {
    name: localize("FALLOUTMAW.Settings.DamageTypes.Title"),
    scope: "world",
    config: false,
    type: Object,
    default: createDefaultDamageTypeSettings(),
    onChange: refreshPreparedActors
  });

  game.settings.register(FALLOUT_MAW.id, CURRENCY_SETTINGS_SETTING, {
    name: localize("FALLOUTMAW.Settings.Currencies.Title"),
    scope: "world",
    config: false,
    type: Object,
    default: createDefaultCurrencySettings(),
    onChange: refreshPreparedActors
  });

  game.settings.register(FALLOUT_MAW.id, RESOURCE_SETTINGS_SETTING, {
    name: localize("FALLOUTMAW.Settings.Resources.Title"),
    scope: "world",
    config: false,
    type: Object,
    default: createDefaultResourceSettings(),
    onChange: refreshPreparedActors
  });

  game.settings.register(FALLOUT_MAW.id, NEED_SETTINGS_SETTING, {
    name: localize("FALLOUTMAW.Settings.Needs.Title"),
    scope: "world",
    config: false,
    type: Object,
    default: createDefaultNeedSettings(),
    onChange: refreshPreparedActors
  });

  game.settings.registerMenu(FALLOUT_MAW.id, "creatureOptionsMenu", {
    name: localize("FALLOUTMAW.Settings.CreatureOptions.Title"),
    label: localize("FALLOUTMAW.Settings.Open"),
    icon: "fa-solid fa-users-gear",
    type: CreatureOptionsConfig,
    restricted: true
  });

  game.settings.registerMenu(FALLOUT_MAW.id, "characteristicsMenu", {
    name: localize("FALLOUTMAW.Settings.Characteristics.Title"),
    label: localize("FALLOUTMAW.Settings.Open"),
    icon: "fa-solid fa-list-check",
    type: CharacteristicsConfig,
    restricted: true
  });

  game.settings.registerMenu(FALLOUT_MAW.id, "skillSettingsMenu", {
    name: localize("FALLOUTMAW.Settings.Skills.Title"),
    label: localize("FALLOUTMAW.Settings.Open"),
    icon: "fa-solid fa-square-root-variable",
    type: SkillFormulasConfig,
    restricted: true
  });

  game.settings.registerMenu(FALLOUT_MAW.id, "damageTypesMenu", {
    name: localize("FALLOUTMAW.Settings.DamageTypes.Title"),
    label: localize("FALLOUTMAW.Settings.Open"),
    icon: "fa-solid fa-shield-halved",
    type: DamageTypesConfig,
    restricted: true
  });

  game.settings.registerMenu(FALLOUT_MAW.id, "currencySettingsMenu", {
    name: localize("FALLOUTMAW.Settings.Currencies.Title"),
    label: localize("FALLOUTMAW.Settings.Open"),
    icon: "fa-solid fa-coins",
    type: CurrencySettingsConfig,
    restricted: true
  });

  game.settings.registerMenu(FALLOUT_MAW.id, "resourceSettingsMenu", {
    name: localize("FALLOUTMAW.Settings.Resources.Title"),
    label: localize("FALLOUTMAW.Settings.Open"),
    icon: "fa-solid fa-heart-pulse",
    type: ResourceSettingsConfig,
    restricted: true
  });

  game.settings.registerMenu(FALLOUT_MAW.id, "needSettingsMenu", {
    name: localize("FALLOUTMAW.Settings.Needs.Title"),
    label: localize("FALLOUTMAW.Settings.Open"),
    icon: "fa-solid fa-battery-half",
    type: NeedSettingsConfig,
    restricted: true
  });
}

export async function finalizeSystemSettings() {
  syncSettingsIntoSystemConfig();
  refreshPreparedActors();
}
