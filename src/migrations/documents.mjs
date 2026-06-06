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
