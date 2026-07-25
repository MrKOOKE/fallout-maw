import { ensureConstructPartSlotSource } from "../utils/construct-parts.mjs";
import { FIXED_GEAR_FUNCTION_KEYS } from "../utils/item-functions.mjs";
import { CONSCIOUSNESS_RESOURCE_KEY } from "../combat/consciousness.mjs";

export const LEGACY_CONSCIOUSNESS_MIGRATION_PENDING_FLAG = "legacyConsciousnessMigrationPending";

const ACTOR_MIGRATIONS = Object.freeze([
  migrateLegacyShockUnconsciousness,
  migrateLegacyConstructPartSlots
]);

const ITEM_MIGRATIONS = Object.freeze([
  migrateLegacyWeaponAndArmorTypes,
  migrateDeprecatedThrowActions,
  migrateWeaponSpecialProperties,
  sparsifyGearItemFunctions
]);

export function migrateActorData(source = {}) {
  return runDocumentMigrations(source, ACTOR_MIGRATIONS);
}

export function migrateItemData(source = {}, options = {}) {
  return runDocumentMigrations(source, ITEM_MIGRATIONS, options);
}

export function sparsifyGearItemFunctions(source = {}, { partial = false } = {}) {
  if (partial) return source;
  if (source?.type !== "gear") return source;
  if (!source.system || typeof source.system !== "object" || Array.isArray(source.system)) source.system = {};
  const functions = source.system.functions;
  if (!functions || typeof functions !== "object" || Array.isArray(functions)) {
    source.system.functions = {};
    return source;
  }

  const sparse = {};
  for (const key of FIXED_GEAR_FUNCTION_KEYS) {
    const data = functions[key];
    const legacyContainer = key === "container" && String(source.system.itemFunction ?? "") === "container";
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      if (legacyContainer) sparse.container = { enabled: true };
      continue;
    }
    if (!legacyContainer && !isEnabledFunctionData(data)) continue;
    if (legacyContainer && !isEnabledFunctionData(data)) data.enabled = true;
    if (key === "module") {
      const additionalWeapons = collectEnabledFunctionEntries(data.additionalWeapons, { legacyPrefix: "legacy" });
      if (Object.keys(additionalWeapons).length) data.additionalWeapons = additionalWeapons;
      else delete data.additionalWeapons;
    }
    sparse[key] = data;
  }

  const additionalWeapons = collectEnabledFunctionEntries(functions.additionalWeapons, { legacyPrefix: "legacy" });
  if (Object.keys(additionalWeapons).length) sparse.additionalWeapons = additionalWeapons;

  const unifiedTool = functions.tool;
  const selectedToolKey = isEnabledFunctionData(unifiedTool) ? String(unifiedTool?.toolKey ?? "").trim() : "";
  const tools = collectEnabledFunctionEntries(functions.tools, { selectedKey: selectedToolKey });
  if (selectedToolKey && !tools[selectedToolKey]) {
    const legacyToolData = { ...unifiedTool };
    delete legacyToolData.toolKey;
    tools[selectedToolKey] = { ...legacyToolData, enabled: true };
  }
  if (Object.keys(tools).length) sparse.tools = tools;

  source.system.functions = sparse;
  return source;
}

function runDocumentMigrations(source, migrations, options = {}) {
  for (const migration of migrations) migration(source, options);
  return source;
}

function collectEnabledFunctionEntries(value, { legacyPrefix = "", selectedKey = "" } = {}) {
  if (!value || typeof value !== "object") return {};
  const entries = Array.isArray(value)
    ? value.map((data, index) => [String(data?.id || `${legacyPrefix}${index}`), data])
    : Object.entries(value);
  const enabled = {};
  for (const [entryKey, data] of entries) {
    const key = String(entryKey ?? "").trim();
    if (!key || !data || typeof data !== "object" || Array.isArray(data)) continue;
    if (!isEnabledFunctionData(data) && key !== selectedKey) continue;
    if (key === selectedKey && !isEnabledFunctionData(data)) data.enabled = true;
    enabled[key] = data;
  }
  return enabled;
}

function isEnabledFunctionData(data) {
  return data?.enabled === true || data?.enabled === 1 || data?.enabled === "true";
}

function migrateLegacyConstructPartSlots(source) {
  ensureConstructPartSlotSource(source);
}

function migrateLegacyShockUnconsciousness(source) {
  const systemFlags = source?.flags?.["fallout-maw"];
  const legacyState = systemFlags?.shockUnconscious;
  if (!legacyState || typeof legacyState !== "object") return;
  const legacyProgress = Math.max(
    0,
    Math.trunc(Number(legacyState.progress) || 0)
  );

  source.system ??= {};
  source.system.resources ??= {};
  const current = source.system.resources[CONSCIOUSNESS_RESOURCE_KEY];
  source.system.resources[CONSCIOUSNESS_RESOURCE_KEY] = {
    ...(current && typeof current === "object" ? current : {}),
    min: 0,
    value: 0,
    // The derived maximum is unavailable during source migration. Preparation
    // safely clamps this sentinel to the actor's real consciousness capacity.
    spent: Number.MAX_SAFE_INTEGER
  };

  delete systemFlags.shockUnconscious;
  // Runtime source migration alone does not remove the old flag from the
  // database. A primary-GM ready migration persists only documents carrying
  // this transient marker, then removes the marker in the same replacement.
  systemFlags[LEGACY_CONSCIOUSNESS_MIGRATION_PENDING_FLAG] = {
    progress: legacyProgress
  };
}

function migrateLegacyWeaponAndArmorTypes(source) {
  if (["weapon", "armor"].includes(source?.type)) source.type = "gear";
}

function migrateDeprecatedThrowActions(source) {
  const functions = source?.system?.functions;
  migrateWeaponFunctionThrowActions(functions?.weapon);

  const additionalWeapons = functions?.additionalWeapons;
  if (Array.isArray(additionalWeapons)) {
    additionalWeapons.forEach(weaponData => migrateWeaponFunctionThrowActions(weaponData));
    return;
  }
  Object.values(additionalWeapons ?? {}).forEach(weaponData => migrateWeaponFunctionThrowActions(weaponData));
}

function migrateWeaponFunctionThrowActions(weaponData) {
  if (!weaponData?.availableActions) return;
  migrateDeprecatedThrowAction(weaponData, "throwItem", "snapshot");
  migrateDeprecatedThrowAction(weaponData, "aimedThrowItem", "aimedShot");
  delete weaponData.availableActions.throwItem;
  delete weaponData.availableActions.aimedThrowItem;
  delete weaponData.throwItem;
  delete weaponData.aimedThrowItem;
}

function migrateDeprecatedThrowAction(weaponData, deprecatedKey, targetKey) {
  if (!weaponData?.availableActions?.[deprecatedKey]) return;
  const targetWasAvailable = Boolean(weaponData.availableActions[targetKey]);
  weaponData.availableActions[targetKey] ||= true;
  if (weaponData[deprecatedKey] && !targetWasAvailable) {
    weaponData[targetKey] = foundry.utils.deepClone(weaponData[deprecatedKey]);
  }
}

function migrateWeaponSpecialProperties(source) {
  const functions = source?.system?.functions;
  migrateWeaponFunctionSpecialProperties(functions?.weapon);

  const additionalWeapons = functions?.additionalWeapons;
  if (Array.isArray(additionalWeapons)) {
    additionalWeapons.forEach(weaponData => migrateWeaponFunctionSpecialProperties(weaponData));
    return;
  }
  Object.values(additionalWeapons ?? {}).forEach(weaponData => migrateWeaponFunctionSpecialProperties(weaponData));
}

function migrateWeaponFunctionSpecialProperties(weaponData) {
  if (!weaponData) return;
  if (Array.isArray(weaponData.specialProperties)) {
    weaponData.specialProperties = weaponData.specialProperties.map(property => migrateWeaponSpecialProperty(property));
    return;
  }
  if (weaponData.specialProperties && typeof weaponData.specialProperties === "object") {
    weaponData.specialProperties = Object.values(weaponData.specialProperties)
      .map(property => migrateWeaponSpecialProperty(property));
    return;
  }
  if (weaponData.specialProperties !== undefined) {
    weaponData.specialProperties = [];
  }
}

function migrateWeaponSpecialProperty(property) {
  if (typeof property === "string") return { type: migrateWeaponSpecialPropertyType(property) };
  if (!property || typeof property !== "object") return { type: "pending" };
  const type = migrateWeaponSpecialPropertyType(property.type ?? property.property ?? property.key);
  if (type === "attackPower") return { ...property, type };
  return { type };
}

function migrateWeaponSpecialPropertyType(type) {
  const key = String(type ?? "").trim();
  if (key === "hitAllConeTargets") return key;
  if (key === "attackPower") return key;
  return "pending";
}
