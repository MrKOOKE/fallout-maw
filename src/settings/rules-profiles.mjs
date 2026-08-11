import { FALLOUT_MAW } from "../config/system-config.mjs";
import { SYSTEM_ID } from "../constants.mjs";

const profiles = new Map();

const STANDARD_RULES_PROFILE = Object.freeze({
  id: "",
  moduleId: "",
  healthFormulaSource: "formula",
  limbDamageFromLostHealthMultiplier: 0,
  optionalResourceKeys: Object.freeze([]),
  disableConsciousness: false,
  damageMitigationCalculation: "flat",
  skillCheckMode: "standard",
  skillAdvancementMode: "configured",
  fixedAbilityFunctionsEnabled: true,
  weaponProficienciesEnabled: true,
  tradeWeaponGrouping: "proficiency"
});

let activeProfileId = "";

const api = Object.freeze({
  register: registerRulesProfile,
  get: getRulesProfile,
  active: getActiveRulesProfile
});

export function registerRulesProfileTools() {
  profiles.clear();
  activeProfileId = "";
  for (const module of game.modules.values()) {
    const profile = module.flags?.[SYSTEM_ID]?.rulesProfile;
    if (module.active && profile) registerRulesProfile(module, profile);
  }
  FALLOUT_MAW.rules = api;
  if (globalThis.CONFIG?.FalloutMaW) CONFIG.FalloutMaW.rules = api;
  return api;
}

export function registerRulesProfile(module, rawProfile = {}) {
  const moduleId = String(module?.id ?? "").trim();
  if (!moduleId || module?.active !== true || game.modules?.get?.(moduleId) !== module) {
    throw new Error("A Fallout-MaW rules profile must be registered by its active Foundry module.");
  }

  const id = String(rawProfile?.id ?? moduleId).trim();
  if (!id || id !== moduleId) {
    throw new Error("A Fallout-MaW module rules profile id must match its module id.");
  }
  if (profiles.has(id)) throw new Error(`Fallout-MaW rules profile ${id} is already registered.`);

  const optionalResourceKeys = Array.from(new Set(
    (Array.isArray(rawProfile?.optionalResourceKeys) ? rawProfile.optionalResourceKeys : [])
      .map(key => String(key ?? "").trim())
      .filter(Boolean)
  ));
  const profile = Object.freeze({
    id,
    moduleId,
    healthFormulaSource: rawProfile?.healthFormulaSource === "race" ? "race" : "formula",
    limbDamageFromLostHealthMultiplier: Math.max(0, Number(rawProfile?.limbDamageFromLostHealthMultiplier) || 0),
    optionalResourceKeys: Object.freeze(optionalResourceKeys),
    disableConsciousness: rawProfile?.disableConsciousness === true,
    damageMitigationCalculation: rawProfile?.damageMitigationCalculation === "percentage"
      ? "percentage"
      : "flat",
    skillCheckMode: rawProfile?.skillCheckMode === "legacyVariableLowRoll"
      ? "legacyVariableLowRoll"
      : "standard",
    skillAdvancementMode: rawProfile?.skillAdvancementMode === "fixed" ? "fixed" : "configured",
    fixedAbilityFunctionsEnabled: rawProfile?.fixedAbilityFunctionsEnabled !== false,
    weaponProficienciesEnabled: rawProfile?.weaponProficienciesEnabled !== false,
    tradeWeaponGrouping: rawProfile?.tradeWeaponGrouping === "subcategory" ? "subcategory" : "proficiency"
  });
  profiles.set(id, profile);
  return profile;
}

export function getRulesProfile(id = "") {
  const profile = profiles.get(String(id ?? "").trim());
  if (!profile) return STANDARD_RULES_PROFILE;
  return game.modules?.get?.(profile.moduleId)?.active === true ? profile : STANDARD_RULES_PROFILE;
}

export function getActiveRulesProfile() {
  return getRulesProfile(activeProfileId);
}

export function syncActiveRulesProfile(state = {}) {
  const nextId = String(state?.activePresetId ?? "").trim();
  if (nextId === activeProfileId) return false;
  activeProfileId = nextId;
  return true;
}

export function isActiveRulesResourceRequired(key = "") {
  const resourceKey = String(key ?? "").trim();
  return !getActiveRulesProfile().optionalResourceKeys.includes(resourceKey);
}

export const RULES_PROFILE_TESTING = Object.freeze({
  clear: () => {
    profiles.clear();
    activeProfileId = "";
  },
  standard: STANDARD_RULES_PROFILE
});
