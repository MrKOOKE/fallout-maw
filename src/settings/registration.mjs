import { FALLOUT_MAW } from "../config/system-config.mjs";
import {
  createDefaultCharacteristicSettings,
  createDefaultDamageTypeSettings,
  createDefaultProficiencyInfluenceSettings,
  createDefaultProficiencySettings,
  createDefaultResourceSettings,
  createDefaultSkillAdvancementSettings,
  createDefaultSkillSettings
} from "../formulas/index.mjs";
import { createDefaultCurrencySettings } from "./currency-settings.mjs";
import { localize } from "../utils/i18n.mjs";
import { AbilitySettingsConfig } from "../apps/ability-settings-config.mjs";
import { CampSettingsConfig } from "../apps/camp-settings-config.mjs";
import { CharacteristicsConfig } from "../apps/characteristics-config.mjs";
import { CombatSettingsConfig } from "../apps/combat-settings-config.mjs";
import { CoverSettingsConfig } from "../apps/cover-settings-config.mjs";
import { CreatureOptionsConfig } from "../apps/creature-options-config.mjs";
import { CurrencySettingsConfig } from "../apps/currency-settings-config.mjs";
import { DamageTypesConfig } from "../apps/damage-types-config.mjs";
import { DiseaseSettingsConfig } from "../apps/disease-settings-config.mjs";
import { FactionSettingsConfig } from "../apps/faction-settings-config.mjs";
import { ItemCategorySettingsConfig } from "../apps/item-category-settings-config.mjs";
import { LevelSettingsConfig } from "../apps/level-settings-config.mjs";
import { ProficiencySettingsConfig } from "../apps/proficiency-settings-config.mjs";
import { ResourceSettingsConfig } from "../apps/resource-settings-config.mjs";
import { SkillFormulasConfig } from "../apps/skill-formulas-config.mjs";
import { StealthSettingsConfig } from "../apps/stealth-settings-config.mjs";
import { SystemActionSettingsConfig } from "../apps/system-action-settings-config.mjs";
import { ToolSettingsConfig } from "../apps/tool-settings-config.mjs";
import { TokenActionHudSettings } from "../apps/token-action-hud-settings-config.mjs";
import {
  CharacterTokenPrototypeDefaultsConfig,
  ConstructTokenPrototypeDefaultsConfig,
  GroupTokenPrototypeDefaultsConfig
} from "../apps/token-prototype-defaults-config.mjs";
import { TraumaSettingsConfig } from "../apps/trauma-settings-config.mjs";
import { PersonalNameRandomizerConfig, registerPersonalGeneratorSettings } from "../apps/personal-generator.mjs";
import { SettingsPresetsConfig } from "../apps/settings-presets-config.mjs";
import { refreshPreparedActors, refreshPreparedActorsAfterConfig, syncSettingsIntoSystemConfig } from "./accessors.mjs";
import {
  createDefaultSettingsPresetState,
  getMainPresetDefault,
  registerSettingsPresetTools
} from "./presets/manager.mjs";
import {
  ABILITIES_CATALOG_SETTING,
  CAMP_SETTINGS_SETTING,
  CAMP_STATE_SETTING,
  CHARACTERISTICS_SETTING,
  COMBAT_CAROUSEL_ENABLED_SETTING,
  COMBAT_CAROUSEL_SIZE_SETTING,
  COMBAT_SETTINGS_SETTING,
  COVER_SETTINGS_SETTING,
  CREATURE_OPTIONS_SETTING,
  CURRENCY_SETTINGS_SETTING,
  DAMAGE_TYPES_SETTING,
  DISEASE_SETTINGS_SETTING,
  FACTION_MATRIX_SETTING,
  FACTION_SETTINGS_SETTING,
  ITEM_CATEGORIES_SETTING,
  LEVELS_SETTING,
  SETTINGS_PRESET_STATE_SETTING,
  PROFICIENCY_SETTINGS_SETTING,
  RESOURCE_SETTINGS_SETTING,
  SKILL_CHECK_CONTROL_SETTING,
  SKILL_DEVELOPMENT_COSTS_SETTING,
  SKILL_SETTINGS_SETTING,
  STEALTH_SETTINGS_SETTING,
  SYSTEM_ACTION_SETTINGS_SETTING,
  TIME_MECHANICS_IGNORED_SETTING,
  TIME_NEEDS_PLAYERS_ONLY_SETTING,
  TIME_REST_MODE_SETTING,
  TOOL_SETTINGS_SETTING,
  TRAUMA_SETTINGS_SETTING,
  TOKEN_ACTION_HUD_COLLAPSED_SECTIONS_SETTING,
  TOKEN_ACTION_HUD_DAMAGE_ICONS_SETTING,
  TOKEN_ACTION_HUD_ENABLED_SETTING,
  TOKEN_ACTION_HUD_SCALE_SETTING,
  TOKEN_HUD_EQUIPMENT_SLOTS_ENABLED_SETTING,
  TOKEN_PROTOTYPE_DEFAULTS_SETTING
} from "./constants.mjs";
import { createDefaultAbilityCatalog } from "./abilities.mjs";
import { createDefaultCampSettings, createEmptyCampState } from "./camp.mjs";
import { createDefaultCombatSettings } from "./combat.mjs";
import { createDefaultCoverSettings } from "./cover.mjs";
import { createEmptyCreatureOptions } from "./creature-options.mjs";
import { createDefaultDiseaseSettings } from "./diseases.mjs";
import { createDefaultFactionMatrix, createDefaultFactionSettings, registerFactionApi } from "./factions.mjs";
import { createDefaultItemCategorySettings } from "./item-categories.mjs";
import { createDefaultLevelSettings } from "./levels.mjs";
import { createDefaultSystemActionSettings, createDefaultToolSettings } from "./tools.mjs";
import { createDefaultStealthSettings } from "../stealth/settings.mjs";
import { createDefaultSkillDevelopmentCostSettings } from "./skill-development-costs.mjs";
import { createDefaultTokenPrototypeDefaults, registerTokenPrototypeDefaultsApi } from "./token-prototype-defaults.mjs";
import { createDefaultTraumaSettings } from "./traumas.mjs";
import {
  DEFAULT_SKILL_CHECK_CONTROL,
  DEFAULT_TOKEN_ACTION_HUD_ICONS,
  normalizeSkillCheckControl,
  normalizeTokenActionHudIcons
} from "./accessors.mjs";
import { syncLoadedActorNaturalRaceItems } from "../races/natural-items.mjs";

export function registerSystemSettings() {
  registerPersonalGeneratorSettings();

  game.settings.register(FALLOUT_MAW.id, SETTINGS_PRESET_STATE_SETTING, {
    name: "Settings Preset State",
    scope: "world",
    config: false,
    type: Object,
    default: createDefaultSettingsPresetState()
  });

  game.settings.register(FALLOUT_MAW.id, CREATURE_OPTIONS_SETTING, {
    name: localize("FALLOUTMAW.Settings.CreatureOptions.Title"),
    scope: "world",
    preset: true,
    config: false,
    type: Object,
    default: getMainPresetDefault(CREATURE_OPTIONS_SETTING, createEmptyCreatureOptions()),
    presetEffect: "creatures",
    onChange: onCreatureOptionsChanged
  });

  game.settings.register(FALLOUT_MAW.id, CHARACTERISTICS_SETTING, {
    name: localize("FALLOUTMAW.Settings.Characteristics.Title"),
    scope: "world",
    preset: true,
    config: false,
    type: Object,
    default: getMainPresetDefault(CHARACTERISTICS_SETTING, createDefaultCharacteristicSettings()),
    presetEffect: "actors",
    onChange: refreshPreparedActors
  });

  game.settings.register(FALLOUT_MAW.id, SKILL_SETTINGS_SETTING, {
    name: localize("FALLOUTMAW.Settings.Skills.Title"),
    scope: "world",
    preset: true,
    config: false,
    type: Object,
    default: getMainPresetDefault(SKILL_SETTINGS_SETTING, {
      entries: createDefaultSkillSettings(),
      advancement: createDefaultSkillAdvancementSettings()
    }),
    presetEffect: "actors",
    onChange: refreshPreparedActors
  });

  game.settings.register(FALLOUT_MAW.id, SKILL_DEVELOPMENT_COSTS_SETTING, {
    name: "Стоимость развития навыков",
    scope: "world",
    config: false,
    type: Object,
    preset: true,
    default: getMainPresetDefault(SKILL_DEVELOPMENT_COSTS_SETTING, createDefaultSkillDevelopmentCostSettings())
  });

  game.settings.register(FALLOUT_MAW.id, LEVELS_SETTING, {
    name: localize("FALLOUTMAW.Settings.Levels.Title"),
    scope: "world",
    config: false,
    type: Object,
    preset: true,
    default: getMainPresetDefault(LEVELS_SETTING, createDefaultLevelSettings()),
    presetEffect: "actors",
    onChange: refreshPreparedActors
  });

  game.settings.register(FALLOUT_MAW.id, DAMAGE_TYPES_SETTING, {
    name: localize("FALLOUTMAW.Settings.DamageTypes.Title"),
    scope: "world",
    config: false,
    type: Object,
    preset: true,
    default: getMainPresetDefault(DAMAGE_TYPES_SETTING, createDefaultDamageTypeSettings()),
    presetEffect: "actors",
    onChange: refreshPreparedActors
  });

  game.settings.register(FALLOUT_MAW.id, CURRENCY_SETTINGS_SETTING, {
    name: localize("FALLOUTMAW.Settings.Currencies.Title"),
    scope: "world",
    config: false,
    type: Object,
    preset: true,
    default: getMainPresetDefault(CURRENCY_SETTINGS_SETTING, createDefaultCurrencySettings()),
    presetEffect: "actors",
    onChange: refreshPreparedActors
  });

  game.settings.register(FALLOUT_MAW.id, ITEM_CATEGORIES_SETTING, {
    name: "Категории предметов",
    scope: "world",
    config: false,
    type: Object,
    preset: true,
    default: getMainPresetDefault(ITEM_CATEGORIES_SETTING, createDefaultItemCategorySettings()),
    presetEffect: "actors",
    onChange: refreshPreparedActors
  });

  game.settings.register(FALLOUT_MAW.id, RESOURCE_SETTINGS_SETTING, {
    name: localize("FALLOUTMAW.Settings.Resources.Title"),
    scope: "world",
    config: false,
    type: Object,
    preset: true,
    default: getMainPresetDefault(RESOURCE_SETTINGS_SETTING, createDefaultResourceSettings()),
    presetEffect: "actors",
    onChange: refreshPreparedActors
  });

  game.settings.register(FALLOUT_MAW.id, PROFICIENCY_SETTINGS_SETTING, {
    name: localize("FALLOUTMAW.Settings.Proficiencies.Title"),
    scope: "world",
    preset: true,
    config: false,
    type: Object,
    default: getMainPresetDefault(PROFICIENCY_SETTINGS_SETTING, {
      entries: createDefaultProficiencySettings(),
      influence: createDefaultProficiencyInfluenceSettings()
    }),
    presetEffect: "actors",
    onChange: refreshPreparedActors
  });

  game.settings.register(FALLOUT_MAW.id, ABILITIES_CATALOG_SETTING, {
    name: "Способности/Особенности",
    scope: "world",
    config: false,
    type: Object,
    preset: true,
    default: getMainPresetDefault(ABILITIES_CATALOG_SETTING, createDefaultAbilityCatalog(createDefaultSkillSettings())),
    onChange: () => Hooks.callAll(`${FALLOUT_MAW.id}.abilityCatalogChanged`)
  });

  game.settings.register(FALLOUT_MAW.id, SKILL_CHECK_CONTROL_SETTING, {
    name: localize("FALLOUTMAW.SkillCheckControl.Title"),
    scope: "world",
    config: false,
    type: Object,
    preset: true,
    default: getMainPresetDefault(SKILL_CHECK_CONTROL_SETTING, normalizeSkillCheckControl(DEFAULT_SKILL_CHECK_CONTROL))
  });

  game.settings.register(FALLOUT_MAW.id, DISEASE_SETTINGS_SETTING, {
    name: "Настройка болезней",
    scope: "world",
    config: false,
    type: Object,
    preset: true,
    default: getMainPresetDefault(DISEASE_SETTINGS_SETTING, createDefaultDiseaseSettings()),
    presetEffect: "actors",
    onChange: refreshPreparedActors
  });

  game.settings.register(FALLOUT_MAW.id, TRAUMA_SETTINGS_SETTING, {
    name: "Настройка травм",
    scope: "world",
    config: false,
    type: Object,
    preset: true,
    default: getMainPresetDefault(TRAUMA_SETTINGS_SETTING, createDefaultTraumaSettings()),
    presetEffect: "actors",
    onChange: refreshPreparedActors
  });

  game.settings.register(FALLOUT_MAW.id, TOOL_SETTINGS_SETTING, {
    name: "Настройка инструментов",
    scope: "world",
    config: false,
    type: Object,
    preset: true,
    default: getMainPresetDefault(TOOL_SETTINGS_SETTING, createDefaultToolSettings()),
    presetEffect: "actors",
    onChange: refreshPreparedActors
  });

  game.settings.register(FALLOUT_MAW.id, SYSTEM_ACTION_SETTINGS_SETTING, {
    name: "Настройка действий",
    scope: "world",
    config: false,
    type: Object,
    preset: true,
    default: getMainPresetDefault(SYSTEM_ACTION_SETTINGS_SETTING, createDefaultSystemActionSettings()),
    presetEffect: "actors",
    onChange: refreshPreparedActors
  });

  game.settings.register(FALLOUT_MAW.id, STEALTH_SETTINGS_SETTING, {
    name: "Настройка скрытности",
    scope: "world",
    config: false,
    type: Object,
    preset: true,
    default: getMainPresetDefault(STEALTH_SETTINGS_SETTING, createDefaultStealthSettings()),
    onChange: () => Hooks.callAll(`${FALLOUT_MAW.id}.stealthSettingsChanged`)
  });

  game.settings.register(FALLOUT_MAW.id, COMBAT_SETTINGS_SETTING, {
    name: localize("FALLOUTMAW.Settings.Combat.Title"),
    scope: "world",
    config: false,
    type: Object,
    preset: true,
    default: getMainPresetDefault(COMBAT_SETTINGS_SETTING, createDefaultCombatSettings()),
    onChange: refreshCombatUi
  });

  game.settings.register(FALLOUT_MAW.id, COVER_SETTINGS_SETTING, {
    name: "Укрытия",
    scope: "world",
    config: false,
    type: Object,
    preset: true,
    default: getMainPresetDefault(COVER_SETTINGS_SETTING, createDefaultCoverSettings())
  });

  game.settings.register(FALLOUT_MAW.id, CAMP_SETTINGS_SETTING, {
    name: "Лагерь",
    scope: "world",
    config: false,
    type: Object,
    preset: true,
    default: getMainPresetDefault(CAMP_SETTINGS_SETTING, createDefaultCampSettings())
  });

  game.settings.register(FALLOUT_MAW.id, CAMP_STATE_SETTING, {
    name: "Camp State",
    scope: "world",
    config: false,
    type: Object,
    default: createEmptyCampState()
  });

  game.settings.register(FALLOUT_MAW.id, FACTION_SETTINGS_SETTING, {
    name: localize("FALLOUTMAW.Factions.SettingsTitle"),
    scope: "world",
    config: false,
    type: Object,
    preset: true,
    default: getMainPresetDefault(FACTION_SETTINGS_SETTING, createDefaultFactionSettings()),
    onChange: refreshCombatUi
  });

  game.settings.register(FALLOUT_MAW.id, FACTION_MATRIX_SETTING, {
    name: localize("FALLOUTMAW.Factions.MatrixTitle"),
    scope: "world",
    config: false,
    type: Object,
    preset: true,
    default: getMainPresetDefault(FACTION_MATRIX_SETTING, createDefaultFactionMatrix()),
    onChange: refreshCombatUi
  });

  game.settings.register(FALLOUT_MAW.id, TIME_MECHANICS_IGNORED_SETTING, {
    name: "Игнорировать механики времени",
    scope: "world",
    config: false,
    type: Boolean,
    preset: true,
    default: getMainPresetDefault(TIME_MECHANICS_IGNORED_SETTING, false)
  });

  game.settings.register(FALLOUT_MAW.id, TIME_NEEDS_PLAYERS_ONLY_SETTING, {
    name: "Рост потребностей только у игроков",
    scope: "world",
    config: false,
    type: Boolean,
    preset: true,
    default: getMainPresetDefault(TIME_NEEDS_PLAYERS_ONLY_SETTING, true)
  });

  game.settings.register(FALLOUT_MAW.id, TIME_REST_MODE_SETTING, {
    name: "Отдых",
    scope: "world",
    config: false,
    type: Boolean,
    default: getMainPresetDefault(TIME_REST_MODE_SETTING, false)
  });

  game.settings.register(FALLOUT_MAW.id, TOKEN_ACTION_HUD_ENABLED_SETTING, {
    name: "Token Action HUD",
    scope: "client",
    config: false,
    type: Boolean,
    default: getMainPresetDefault(TOKEN_ACTION_HUD_ENABLED_SETTING, true)
  });

  game.settings.register(FALLOUT_MAW.id, TOKEN_ACTION_HUD_SCALE_SETTING, {
    name: "Token Action HUD Scale",
    scope: "client",
    config: false,
    type: Number,
    default: getMainPresetDefault(TOKEN_ACTION_HUD_SCALE_SETTING, 50)
  });

  game.settings.register(FALLOUT_MAW.id, TOKEN_ACTION_HUD_COLLAPSED_SECTIONS_SETTING, {
    name: "Token Action HUD Collapsed Sections",
    scope: "client",
    config: false,
    type: Object,
    default: getMainPresetDefault(TOKEN_ACTION_HUD_COLLAPSED_SECTIONS_SETTING, {})
  });

  game.settings.register(FALLOUT_MAW.id, TOKEN_ACTION_HUD_DAMAGE_ICONS_SETTING, {
    name: "Token Action HUD Icons",
    scope: "world",
    config: false,
    type: Object,
    preset: true,
    default: getMainPresetDefault(TOKEN_ACTION_HUD_DAMAGE_ICONS_SETTING, normalizeTokenActionHudIcons(DEFAULT_TOKEN_ACTION_HUD_ICONS))
  });

  game.settings.register(FALLOUT_MAW.id, TOKEN_HUD_EQUIPMENT_SLOTS_ENABLED_SETTING, {
    name: "Token HUD Equipment Slots",
    scope: "world",
    config: true,
    type: Boolean,
    preset: true,
    default: getMainPresetDefault(TOKEN_HUD_EQUIPMENT_SLOTS_ENABLED_SETTING, true)
  });

  game.settings.register(FALLOUT_MAW.id, TOKEN_PROTOTYPE_DEFAULTS_SETTING, {
    name: "Token Prototype Defaults",
    scope: "world",
    config: false,
    type: Object,
    preset: true,
    default: getMainPresetDefault(TOKEN_PROTOTYPE_DEFAULTS_SETTING, createDefaultTokenPrototypeDefaults())
  });

  registerTokenPrototypeDefaultsApi();

  game.settings.register(FALLOUT_MAW.id, COMBAT_CAROUSEL_ENABLED_SETTING, {
    name: "Combat Carousel",
    scope: "client",
    config: false,
    type: Boolean,
    default: getMainPresetDefault(COMBAT_CAROUSEL_ENABLED_SETTING, true)
  });

  game.settings.register(FALLOUT_MAW.id, COMBAT_CAROUSEL_SIZE_SETTING, {
    name: "Combat Carousel Size",
    scope: "client",
    config: false,
    type: Number,
    default: getMainPresetDefault(COMBAT_CAROUSEL_SIZE_SETTING, 82)
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

  game.settings.registerMenu(FALLOUT_MAW.id, "levelSettingsMenu", {
    name: localize("FALLOUTMAW.Settings.Levels.Title"),
    label: localize("FALLOUTMAW.Settings.Open"),
    icon: "fa-solid fa-arrow-trend-up",
    type: LevelSettingsConfig,
    restricted: true
  });

  game.settings.registerMenu(FALLOUT_MAW.id, "proficiencySettingsMenu", {
    name: localize("FALLOUTMAW.Settings.Proficiencies.Title"),
    label: localize("FALLOUTMAW.Settings.Open"),
    icon: "fa-solid fa-crosshairs",
    type: ProficiencySettingsConfig,
    restricted: true
  });

  game.settings.registerMenu(FALLOUT_MAW.id, "damageTypesMenu", {
    name: localize("FALLOUTMAW.Settings.DamageTypes.Title"),
    label: localize("FALLOUTMAW.Settings.Open"),
    icon: "fa-solid fa-shield-halved",
    type: DamageTypesConfig,
    restricted: true
  });

  game.settings.registerMenu(FALLOUT_MAW.id, "abilitySettingsMenu", {
    name: "Способности/Особенности",
    label: localize("FALLOUTMAW.Settings.Open"),
    icon: "fa-solid fa-wand-sparkles",
    type: AbilitySettingsConfig,
    restricted: true
  });

  game.settings.registerMenu(FALLOUT_MAW.id, "traumaSettingsMenu", {
    name: "Настройка травм",
    label: localize("FALLOUTMAW.Settings.Open"),
    icon: "fa-solid fa-bone",
    type: TraumaSettingsConfig,
    restricted: true
  });

  game.settings.registerMenu(FALLOUT_MAW.id, "diseaseSettingsMenu", {
    name: "Настройка болезней",
    label: localize("FALLOUTMAW.Settings.Open"),
    icon: "fa-solid fa-virus",
    type: DiseaseSettingsConfig,
    restricted: true
  });

  game.settings.registerMenu(FALLOUT_MAW.id, "toolSettingsMenu", {
    name: "Настройка инструментов",
    label: localize("FALLOUTMAW.Settings.Open"),
    icon: "fa-solid fa-screwdriver-wrench",
    type: ToolSettingsConfig,
    restricted: true
  });

  game.settings.registerMenu(FALLOUT_MAW.id, "systemActionSettingsMenu", {
    name: "Настройка действий",
    label: localize("FALLOUTMAW.Settings.Open"),
    icon: "fa-solid fa-hand-sparkles",
    type: SystemActionSettingsConfig,
    restricted: true
  });

  game.settings.registerMenu(FALLOUT_MAW.id, "stealthSettingsMenu", {
    name: "Настройка скрытности",
    label: localize("FALLOUTMAW.Settings.Open"),
    icon: "fa-solid fa-user-ninja",
    type: StealthSettingsConfig,
    restricted: true
  });

  game.settings.registerMenu(FALLOUT_MAW.id, "combatSettingsMenu", {
    name: localize("FALLOUTMAW.Settings.Combat.Title"),
    label: localize("FALLOUTMAW.Settings.Open"),
    icon: "fa-solid fa-hand-fist",
    type: CombatSettingsConfig,
    restricted: true
  });

  game.settings.registerMenu(FALLOUT_MAW.id, "coverSettingsMenu", {
    name: "Укрытия",
    label: localize("FALLOUTMAW.Settings.Open"),
    icon: "fa-solid fa-shield-halved",
    type: CoverSettingsConfig,
    restricted: true
  });

  game.settings.registerMenu(FALLOUT_MAW.id, "campSettingsMenu", {
    name: "Лагерь",
    label: localize("FALLOUTMAW.Settings.Open"),
    icon: "fa-solid fa-campground",
    type: CampSettingsConfig,
    restricted: true
  });

  game.settings.registerMenu(FALLOUT_MAW.id, "factionSettingsMenu", {
    name: localize("FALLOUTMAW.Factions.SettingsTitle"),
    label: localize("FALLOUTMAW.Settings.Open"),
    icon: "fa-solid fa-flag",
    type: FactionSettingsConfig,
    restricted: true
  });

  game.settings.registerMenu(FALLOUT_MAW.id, "personalNameRandomizerMenu", {
    name: "Настройки персонального генератора",
    label: localize("FALLOUTMAW.Settings.Open"),
    icon: "fa-solid fa-user-gear",
    type: PersonalNameRandomizerConfig,
    restricted: true
  });

  game.settings.registerMenu(FALLOUT_MAW.id, "currencySettingsMenu", {
    name: localize("FALLOUTMAW.Settings.Currencies.Title"),
    label: localize("FALLOUTMAW.Settings.Open"),
    icon: "fa-solid fa-coins",
    type: CurrencySettingsConfig,
    restricted: true
  });

  game.settings.registerMenu(FALLOUT_MAW.id, "itemCategorySettingsMenu", {
    name: "Категории предметов",
    label: localize("FALLOUTMAW.Settings.Open"),
    icon: "fa-solid fa-tags",
    type: ItemCategorySettingsConfig,
    restricted: true
  });

  game.settings.registerMenu(FALLOUT_MAW.id, "resourceSettingsMenu", {
    name: localize("FALLOUTMAW.Settings.Resources.Title"),
    label: localize("FALLOUTMAW.Settings.Open"),
    icon: "fa-solid fa-heart-pulse",
    type: ResourceSettingsConfig,
    restricted: true
  });

  game.settings.registerMenu(FALLOUT_MAW.id, "tokenActionHudSettingsMenu", {
    name: localize("FALLOUTMAW.Settings.HUD.Title"),
    label: localize("FALLOUTMAW.Settings.Open"),
    icon: "fa-solid fa-table-cells-large",
    type: TokenActionHudSettings,
    restricted: true
  });

  game.settings.registerMenu(FALLOUT_MAW.id, "characterTokenPrototypeDefaultsMenu", {
    name: "Базовый прототип токена: Персонаж",
    label: localize("FALLOUTMAW.Settings.Open"),
    icon: "fa-solid fa-circle-user",
    type: CharacterTokenPrototypeDefaultsConfig,
    restricted: true
  });

  game.settings.registerMenu(FALLOUT_MAW.id, "constructTokenPrototypeDefaultsMenu", {
    name: "Базовый прототип токена: Конструкт",
    label: localize("FALLOUTMAW.Settings.Open"),
    icon: "fa-solid fa-robot",
    type: ConstructTokenPrototypeDefaultsConfig,
    restricted: true
  });

  game.settings.registerMenu(FALLOUT_MAW.id, "groupTokenPrototypeDefaultsMenu", {
    name: "Базовый прототип токена: Группа",
    label: localize("FALLOUTMAW.Settings.Open"),
    icon: "fa-solid fa-people-group",
    type: GroupTokenPrototypeDefaultsConfig,
    restricted: true
  });

  game.settings.registerMenu(FALLOUT_MAW.id, "settingsPresetsMenu", {
    name: localize("FALLOUTMAW.Settings.Presets.Title"),
    label: localize("FALLOUTMAW.Settings.Open"),
    icon: "fa-solid fa-sliders",
    type: SettingsPresetsConfig,
    restricted: true
  });

  registerSettingsPresetTools();
}

export async function finalizeSystemSettings() {
  syncSettingsIntoSystemConfig();
  registerFactionApi();
  // Startup only needs world actors; token actors re-prepare when used.
  refreshPreparedActorsAfterConfig({ worldOnly: true });
}

function onCreatureOptionsChanged() {
  refreshPreparedActors();
  if (game.ready) void syncLoadedActorNaturalRaceItems();
}

function refreshCombatUi() {
  ui.combat?.render?.(false);
  ui.combatDock?.refresh?.();
  game.combat?._updateTurnMarkers?.();
}
