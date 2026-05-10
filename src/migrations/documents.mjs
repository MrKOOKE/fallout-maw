const ACTOR_MIGRATIONS = Object.freeze([
]);

const ITEM_MIGRATIONS = Object.freeze([
  migrateLegacyWeaponAndArmorTypes,
  migrateDeprecatedThrowActions,
  migrateWeaponSpecialProperties
]);

export function migrateActorData(source = {}) {
  return runDocumentMigrations(source, ACTOR_MIGRATIONS);
}

export function migrateItemData(source = {}) {
  return runDocumentMigrations(source, ITEM_MIGRATIONS);
}

function runDocumentMigrations(source, migrations) {
  for (const migration of migrations) migration(source);
  return source;
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
  if (!weaponData || Array.isArray(weaponData.specialProperties)) return;
  weaponData.specialProperties = [];
}
