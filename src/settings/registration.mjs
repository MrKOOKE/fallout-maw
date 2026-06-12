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
  ConstructTokenPrototypeDefaultsConfig
} from "../apps/token-prototype-defaults-config.mjs";
import { TraumaSettingsConfig } from "../apps/trauma-settings-config.mjs";
import { PersonalNameRandomizerConfig, registerPersonalGeneratorSettings } from "../apps/personal-generator.mjs";
import { refreshPreparedActors, syncSettingsIntoSystemConfig } from "./accessors.mjs";
import {
  getBaselineDefault,
  registerSettingsBaselineTools,
  SettingsBaselineConfig
} from "./baseline.mjs";
import {
  ABILITIES_CATALOG_SETTING,
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
  MIGRATION_STATE_SETTING,
  PROFICIENCY_SETTINGS_SETTING,
  RESOURCE_SETTINGS_SETTING,
  SKILL_CHECK_CONTROL_SETTING,
  SKILL_DEVELOPMENT_COSTS_SETTING,
  SKILL_SETTINGS_SETTING,
  STEALTH_SETTINGS_SETTING,
  SYSTEM_ACTION_SETTINGS_SETTING,
  TIME_MECHANICS_IGNORED_SETTING,
  TIME_NEEDS_PLAYERS_ONLY_SETTING,
  TOOL_SETTINGS_SETTING,
  TRAUMA_SETTINGS_SETTING,
  TOKEN_ACTION_HUD_COLLAPSED_SECTIONS_SETTING,
  TOKEN_ACTION_HUD_DAMAGE_ICONS_SETTING,
  TOKEN_ACTION_HUD_ENABLED_SETTING,
  TOKEN_ACTION_HUD_SCALE_SETTING,
  TOKEN_PROTOTYPE_DEFAULTS_SETTING
} from "./constants.mjs";
import { createDefaultAbilityCatalog } from "./abilities.mjs";
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
import { migrateSystemSettings } from "../migrations/settings.mjs";

export function registerSystemSettings() {
  registerPersonalGeneratorSettings();

  game.settings.register(FALLOUT_MAW.id, MIGRATION_STATE_SETTING, {
    name: "Migration State",
    scope: "world",
    config: false,
    type: Object,
    default: {
      completed: []
    }
  });

  game.settings.register(FALLOUT_MAW.id, CREATURE_OPTIONS_SETTING, {
    name: localize("FALLOUTMAW.Settings.CreatureOptions.Title"),
    scope: "world",
    config: false,
    type: Object,
    default: getBaselineDefault(CREATURE_OPTIONS_SETTING, createEmptyCreatureOptions()),
    onChange: refreshPreparedActors
  });

  game.settings.register(FALLOUT_MAW.id, CHARACTERISTICS_SETTING, {
    name: localize("FALLOUTMAW.Settings.Characteristics.Title"),
    scope: "world",
    config: false,
    type: Object,
    default: getBaselineDefault(CHARACTERISTICS_SETTING, createDefaultCharacteristicSettings()),
    onChange: refreshPreparedActors
  });

  game.settings.register(FALLOUT_MAW.id, SKILL_SETTINGS_SETTING, {
    name: localize("FALLOUTMAW.Settings.Skills.Title"),
    scope: "world",
    config: false,
    type: Object,
    default: getBaselineDefault(SKILL_SETTINGS_SETTING, {
      entries: createDefaultSkillSettings(),
      advancement: createDefaultSkillAdvancementSettings()
    }),
    onChange: refreshPreparedActors
  });

  game.settings.register(FALLOUT_MAW.id, SKILL_DEVELOPMENT_COSTS_SETTING, {
    name: "Стоимость развития навыков",
    scope: "world",
    config: false,
    type: Object,
    default: getBaselineDefault(SKILL_DEVELOPMENT_COSTS_SETTING, createDefaultSkillDevelopmentCostSettings())
  });

  game.settings.register(FALLOUT_MAW.id, LEVELS_SETTING, {
    name: localize("FALLOUTMAW.Settings.Levels.Title"),
    scope: "world",
    config: false,
    type: Object,
    default: getBaselineDefault(LEVELS_SETTING, createDefaultLevelSettings()),
    onChange: refreshPreparedActors
  });

  game.settings.register(FALLOUT_MAW.id, DAMAGE_TYPES_SETTING, {
    name: localize("FALLOUTMAW.Settings.DamageTypes.Title"),
    scope: "world",
    config: false,
    type: Object,
    default: getBaselineDefault(DAMAGE_TYPES_SETTING, createDefaultDamageTypeSettings()),
    onChange: refreshPreparedActors
  });

  game.settings.register(FALLOUT_MAW.id, CURRENCY_SETTINGS_SETTING, {
    name: localize("FALLOUTMAW.Settings.Currencies.Title"),
    scope: "world",
    config: false,
    type: Object,
    default: getBaselineDefault(CURRENCY_SETTINGS_SETTING, createDefaultCurrencySettings()),
    onChange: refreshPreparedActors
  });

  game.settings.register(FALLOUT_MAW.id, ITEM_CATEGORIES_SETTING, {
    name: "Категории предметов",
    scope: "world",
    config: false,
    type: Object,
    default: getBaselineDefault(ITEM_CATEGORIES_SETTING, createDefaultItemCategorySettings()),
    onChange: refreshPreparedActors
  });

  game.settings.register(FALLOUT_MAW.id, RESOURCE_SETTINGS_SETTING, {
    name: localize("FALLOUTMAW.Settings.Resources.Title"),
    scope: "world",
    config: false,
    type: Object,
    default: getBaselineDefault(RESOURCE_SETTINGS_SETTING, createDefaultResourceSettings()),
    onChange: refreshPreparedActors
  });

  game.settings.register(FALLOUT_MAW.id, PROFICIENCY_SETTINGS_SETTING, {
    name: localize("FALLOUTMAW.Settings.Proficiencies.Title"),
    scope: "world",
    config: false,
    type: Object,
    default: getBaselineDefault(PROFICIENCY_SETTINGS_SETTING, {
      entries: createDefaultProficiencySettings(),
      influence: createDefaultProficiencyInfluenceSettings()
    }),
    onChange: refreshPreparedActors
  });

  game.settings.register(FALLOUT_MAW.id, ABILITIES_CATALOG_SETTING, {
    name: "Способности/Особенности",
    scope: "world",
    config: false,
    type: Object,
    default: getBaselineDefault(ABILITIES_CATALOG_SETTING, createDefaultAbilityCatalog(createDefaultSkillSettings())),
    onChange: refreshPreparedActors
  });

  game.settings.register(FALLOUT_MAW.id, SKILL_CHECK_CONTROL_SETTING, {
    name: localize("FALLOUTMAW.SkillCheckControl.Title"),
    scope: "world",
    config: false,
    type: Object,
    default: getBaselineDefault(SKILL_CHECK_CONTROL_SETTING, normalizeSkillCheckControl(DEFAULT_SKILL_CHECK_CONTROL))
  });

  game.settings.register(FALLOUT_MAW.id, DISEASE_SETTINGS_SETTING, {
    name: "Настройка болезней",
    scope: "world",
    config: false,
    type: Object,
    default: getBaselineDefault(DISEASE_SETTINGS_SETTING, createDefaultDiseaseSettings()),
    onChange: refreshPreparedActors
  });

  game.settings.register(FALLOUT_MAW.id, TRAUMA_SETTINGS_SETTING, {
    name: "Настройка травм",
    scope: "world",
    config: false,
    type: Object,
    default: getBaselineDefault(TRAUMA_SETTINGS_SETTING, createDefaultTraumaSettings()),
    onChange: refreshPreparedActors
  });

  game.settings.register(FALLOUT_MAW.id, TOOL_SETTINGS_SETTING, {
    name: "Настройка инструментов",
    scope: "world",
    config: false,
    type: Object,
    default: getBaselineDefault(TOOL_SETTINGS_SETTING, createDefaultToolSettings()),
    onChange: refreshPreparedActors
  });

  game.settings.register(FALLOUT_MAW.id, SYSTEM_ACTION_SETTINGS_SETTING, {
    name: "Настройка действий",
    scope: "world",
    config: false,
    type: Object,
    default: getBaselineDefault(SYSTEM_ACTION_SETTINGS_SETTING, createDefaultSystemActionSettings()),
    onChange: refreshPreparedActors
  });

  game.settings.register(FALLOUT_MAW.id, STEALTH_SETTINGS_SETTING, {
    name: "Настройка скрытности",
    scope: "world",
    config: false,
    type: Object,
    default: getBaselineDefault(STEALTH_SETTINGS_SETTING, createDefaultStealthSettings())
  });

  game.settings.register(FALLOUT_MAW.id, COMBAT_SETTINGS_SETTING, {
    name: localize("FALLOUTMAW.Settings.Combat.Title"),
    scope: "world",
    config: false,
    type: Object,
    default: getBaselineDefault(COMBAT_SETTINGS_SETTING, createDefaultCombatSettings())
  });

  game.settings.register(FALLOUT_MAW.id, COVER_SETTINGS_SETTING, {
    name: "Укрытия",
    scope: "world",
    config: false,
    type: Object,
    default: getBaselineDefault(COVER_SETTINGS_SETTING, createDefaultCoverSettings())
  });

  game.settings.register(FALLOUT_MAW.id, FACTION_SETTINGS_SETTING, {
    name: localize("FALLOUTMAW.Factions.SettingsTitle"),
    scope: "world",
    config: false,
    type: Object,
    default: getBaselineDefault(FACTION_SETTINGS_SETTING, createDefaultFactionSettings())
  });

  game.settings.register(FALLOUT_MAW.id, FACTION_MATRIX_SETTING, {
    name: localize("FALLOUTMAW.Factions.MatrixTitle"),
    scope: "world",
    config: false,
    type: Object,
    default: getBaselineDefault(FACTION_MATRIX_SETTING, createDefaultFactionMatrix())
  });

  game.settings.register(FALLOUT_MAW.id, TIME_MECHANICS_IGNORED_SETTING, {
    name: "Игнорировать механики времени",
    scope: "world",
    config: false,
    type: Boolean,
    default: getBaselineDefault(TIME_MECHANICS_IGNORED_SETTING, false)
  });

  game.settings.register(FALLOUT_MAW.id, TIME_NEEDS_PLAYERS_ONLY_SETTING, {
    name: "Рост потребностей только у игроков",
    scope: "world",
    config: false,
    type: Boolean,
    default: getBaselineDefault(TIME_NEEDS_PLAYERS_ONLY_SETTING, true)
  });

  game.settings.register(FALLOUT_MAW.id, TOKEN_ACTION_HUD_ENABLED_SETTING, {
    name: "Token Action HUD",
    scope: "client",
    config: false,
    type: Boolean,
    default: getBaselineDefault(TOKEN_ACTION_HUD_ENABLED_SETTING, true)
  });

  game.settings.register(FALLOUT_MAW.id, TOKEN_ACTION_HUD_SCALE_SETTING, {
    name: "Token Action HUD Scale",
    scope: "client",
    config: false,
    type: Number,
    default: getBaselineDefault(TOKEN_ACTION_HUD_SCALE_SETTING, 50)
  });

  game.settings.register(FALLOUT_MAW.id, TOKEN_ACTION_HUD_COLLAPSED_SECTIONS_SETTING, {
    name: "Token Action HUD Collapsed Sections",
    scope: "client",
    config: false,
    type: Object,
    default: getBaselineDefault(TOKEN_ACTION_HUD_COLLAPSED_SECTIONS_SETTING, {})
  });

  game.settings.register(FALLOUT_MAW.id, TOKEN_ACTION_HUD_DAMAGE_ICONS_SETTING, {
    name: "Token Action HUD Icons",
    scope: "world",
    config: false,
    type: Object,
    default: getBaselineDefault(TOKEN_ACTION_HUD_DAMAGE_ICONS_SETTING, normalizeTokenActionHudIcons(DEFAULT_TOKEN_ACTION_HUD_ICONS))
  });

  game.settings.register(FALLOUT_MAW.id, TOKEN_PROTOTYPE_DEFAULTS_SETTING, {
    name: "Token Prototype Defaults",
    scope: "world",
    config: false,
    type: Object,
    default: getBaselineDefault(TOKEN_PROTOTYPE_DEFAULTS_SETTING, createDefaultTokenPrototypeDefaults())
  });

  registerTokenPrototypeDefaultsApi();

  game.settings.register(FALLOUT_MAW.id, COMBAT_CAROUSEL_ENABLED_SETTING, {
    name: "Combat Carousel",
    scope: "client",
    config: false,
    type: Boolean,
    default: getBaselineDefault(COMBAT_CAROUSEL_ENABLED_SETTING, true)
  });

  game.settings.register(FALLOUT_MAW.id, COMBAT_CAROUSEL_SIZE_SETTING, {
    name: "Combat Carousel Size",
    scope: "client",
    config: false,
    type: Number,
    default: getBaselineDefault(COMBAT_CAROUSEL_SIZE_SETTING, 82)
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

  game.settings.registerMenu(FALLOUT_MAW.id, "settingsBaselineMenu", {
    name: "Settings Baseline",
    label: localize("FALLOUTMAW.Settings.Open"),
    icon: "fa-solid fa-file-export",
    type: SettingsBaselineConfig,
    restricted: true
  });

  registerSettingsBaselineTools();
}

export async function finalizeSystemSettings() {
  await migrateSystemSettings();
  syncSettingsIntoSystemConfig();
  registerFactionApi();
  refreshPreparedActors();
}
