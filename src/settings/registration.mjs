import { FALLOUT_MAW } from "../config/system-config.mjs";
import {
  createDefaultActionMovementFormulas,
  createDefaultCharacteristicSettings,
  createDefaultDamageTypeSettings,
  createDefaultSkillSettings
} from "../formulas/index.mjs";
import { localize } from "../utils/i18n.mjs";
import { ActionMovementFormulasConfig } from "../apps/action-movement-formulas-config.mjs";
import { CharacteristicsConfig } from "../apps/characteristics-config.mjs";
import { CreatureOptionsConfig } from "../apps/creature-options-config.mjs";
import { DamageTypesConfig } from "../apps/damage-types-config.mjs";
import { SkillFormulasConfig } from "../apps/skill-formulas-config.mjs";
import { refreshPreparedActors, syncSettingsIntoSystemConfig } from "./accessors.mjs";
import {
  ACTION_MOVEMENT_FORMULAS_SETTING,
  CHARACTERISTICS_SETTING,
  CREATURE_OPTIONS_SETTING,
  DAMAGE_TYPES_SETTING,
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

  game.settings.register(FALLOUT_MAW.id, ACTION_MOVEMENT_FORMULAS_SETTING, {
    name: localize("FALLOUTMAW.Settings.ActionMovement.Title"),
    scope: "world",
    config: false,
    type: Object,
    default: createDefaultActionMovementFormulas(),
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

  game.settings.registerMenu(FALLOUT_MAW.id, "actionMovementFormulasMenu", {
    name: localize("FALLOUTMAW.Settings.ActionMovement.Title"),
    label: localize("FALLOUTMAW.Settings.Open"),
    icon: "fa-solid fa-person-running",
    type: ActionMovementFormulasConfig,
    restricted: true
  });
}

export async function finalizeSystemSettings() {
  syncSettingsIntoSystemConfig();
  refreshPreparedActors();
}
