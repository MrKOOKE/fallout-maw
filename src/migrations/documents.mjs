import { ensureConstructPartSlotSource } from "../utils/construct-parts.mjs";
import { FIXED_GEAR_FUNCTION_KEYS } from "../utils/item-functions.mjs";
import { CONSCIOUSNESS_RESOURCE_KEY } from "../combat/consciousness.mjs";

export const LEGACY_CONSCIOUSNESS_MIGRATION_PENDING_FLAG = "legacyConsciousnessMigrationPending";

const ACTOR_MIGRATIONS = Object.freeze([
  migrateLegacyShockUnconsciousness,
  migrateLegacyConstructPartSlots
]);

const ITEM_MIGRATIONS = Object.freeze([
  migrateAbilityTrialBranches,
  migrateAbilityDamageConstructs,
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

/**
 * Preserve the old ordinary-Trial batching contract before Foundry cleans the
 * item source. A legacy accepted-result set becomes exactly one branch, so a
 * source/targets consequence still executes once for the whole matched group.
 */
export function migrateAbilityTrialBranches(source = {}, { partial = false } = {}) {
  if (partial) return source;
  const functionCollections = [];
  if (Array.isArray(source?.system?.functions)) {
    functionCollections.push(source.system.functions);
  }
  const freeSettingsEntries = source?.system?.functions?.freeSettings?.entries;
  if (Array.isArray(freeSettingsEntries)) functionCollections.push(freeSettingsEntries);
  else if (freeSettingsEntries && typeof freeSettingsEntries === "object") {
    functionCollections.push(Object.values(freeSettingsEntries));
  }

  for (const functions of functionCollections) {
    for (const abilityFunction of functions ?? []) {
      const changes = Array.isArray(abilityFunction?.changes)
        ? abilityFunction.changes
        : Object.values(abilityFunction?.changes ?? {});
      const hasPrimaryChanges = changes.some(change => (
        String(change?.key ?? "").trim() && String(change?.value ?? "") !== ""
      ));
      const conditions = Array.isArray(abilityFunction?.conditions)
        ? abilityFunction.conditions
        : Object.values(abilityFunction?.conditions ?? {});
      for (const condition of conditions) {
        migrateAbilityTrialConditionBranches(condition, { hasPrimaryChanges });
      }
    }
  }
  return source;
}

function migrateAbilityTrialConditionBranches(condition, { hasPrimaryChanges = false } = {}) {
  if (!condition || condition.type !== "trial") return;
  const hadRoutingMarker = Object.prototype.hasOwnProperty.call(
    condition,
    "trialRoutesPrimaryChanges"
  );
  const hasCanonical = Object.prototype.hasOwnProperty.call(condition, "trialBranches");
  if (hasCanonical) {
    condition.trialBranches = Array.isArray(condition.trialBranches)
      ? condition.trialBranches
      : Object.values(condition.trialBranches ?? {});
    delete condition.trialResultKeys;
    delete condition.trialLinks;
  } else {
    const hasLegacy = Object.prototype.hasOwnProperty.call(condition, "trialResultKeys")
      || Object.prototype.hasOwnProperty.call(condition, "trialLinks");
    if (!hasLegacy) return;
    const validResultKeys = new Set([
      "criticalFailure",
      "failure",
      "success",
      "criticalSuccess"
    ]);
    const resultKeys = (Array.isArray(condition.trialResultKeys)
      ? condition.trialResultKeys
      : Object.values(condition.trialResultKeys ?? {}))
      .map(value => String(value ?? "").trim())
      .filter(value => validResultKeys.has(value));
    const links = Array.isArray(condition.trialLinks)
      ? condition.trialLinks
      : Object.values(condition.trialLinks ?? {});
    const conditionId = String(condition.id ?? "").trim() || "trial";
    condition.trialBranches = [{
      id: `${conditionId}-legacy-branch`,
      name: "Подходящий результат",
      resultKeys: resultKeys.length ? resultKeys : ["criticalFailure", "failure"],
      flow: "continue",
      links
    }];
    delete condition.trialResultKeys;
    delete condition.trialLinks;
  }

  for (const branch of condition.trialBranches) {
    branch.links = (Array.isArray(branch?.links)
      ? branch.links
      : Object.values(branch?.links ?? {}))
      .map(link => migrateAbilityTrialLink(link));
  }
  const hasPrimaryLink = condition.trialBranches.some(branch => (
    branch.links.some(link => ["primaryChanges", "primaryChangesPercent"].includes(link.kind))
  ));
  const shouldMigrateEmptyBranch = !hadRoutingMarker
    && hasPrimaryChanges
    && condition.trialBranches.length === 1
    && !condition.trialBranches[0].links.length;
  const shouldRepairOrphanedLink = hasPrimaryChanges
    && condition.trialBranches.length === 1
    && condition.trialBranches[0].links.length === 1
    && condition.trialBranches[0].links[0]?.kind === "construct"
    && !String(condition.trialBranches[0].links[0]?.constructId ?? "").trim();
  if (shouldMigrateEmptyBranch || shouldRepairOrphanedLink) {
    const conditionId = String(condition.id ?? "").trim() || "trial";
    condition.trialBranches[0].links = [{
      id: `${conditionId}-primary-changes`,
      kind: "primaryChanges",
      constructId: "",
      percentFormula: "100",
      durationPercentFormula: "100",
      recipient: "subjects",
      mode: "perSubject"
    }];
  }
  condition.trialRoutesPrimaryChanges = condition.trialRoutesPrimaryChanges === true
    || hasPrimaryLink
    || shouldMigrateEmptyBranch
    || shouldRepairOrphanedLink;
}

function migrateAbilityTrialLink(link = {}) {
  const constructId = String(link?.constructId ?? "");
  const rawKind = String(link?.kind ?? "");
  const kind = ["", "construct", "primaryChanges", "primaryChangesPercent"].includes(rawKind)
    ? (rawKind || (constructId ? "construct" : ""))
    : (constructId ? "construct" : "");
  return {
    ...link,
    kind,
    constructId: kind === "construct" ? constructId : "",
    percentFormula: String(link?.percentFormula ?? "100"),
    durationPercentFormula: String(link?.durationPercentFormula ?? "100")
  };
}

/**
 * Older ability-builder macros stored damage construct settings as flat
 * damageFormula/damageTypeKey fields. Move them into the current nested shape
 * before SchemaField pruning can discard them.
 */
export function migrateAbilityDamageConstructs(source = {}, { partial = false } = {}) {
  if (partial) return source;
  const constructs = source?.system?.constructs;
  const entries = Array.isArray(constructs) ? constructs : Object.values(constructs ?? {});
  for (const construct of entries) {
    if (!construct || construct.type !== "damage") continue;
    if (construct.damage && typeof construct.damage === "object") continue;
    const legacyLimbMode = String(construct.damageLimbMode ?? "").trim();
    construct.damage = {
      amountMode: construct.damageFormula !== undefined ? "formula" : "base",
      formula: String(construct.damageFormula ?? "0"),
      damageTypeKey: String(construct.damageTypeKey ?? ""),
      limbMode: legacyLimbMode === "critical"
        ? "randomCritical"
        : (["random", "randomCritical", "selected", "healthOnly"].includes(legacyLimbMode)
          ? legacyLimbMode
          : "random")
    };
    delete construct.damageFormula;
    delete construct.damageTypeKey;
    delete construct.damageFormulaEvaluation;
    delete construct.damageLimbMode;
    delete construct.damageLimbKey;
    delete construct.damageScope;
    delete construct.damageApplyMitigation;
    delete construct.damageProcessTypeSettings;
    delete construct.damageBypassBarrier;
  }
  return source;
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
  if (["attackPower", "criticalDamage", "additionalProficiencies", "impactConditionWear", "limbDamageMultipliers"].includes(type)) {
    return { ...property, type };
  }
  return { type };
}

function migrateWeaponSpecialPropertyType(type) {
  const key = String(type ?? "").trim();
  if (key === "hitAllConeTargets") return key;
  if (key === "concentratedPelletImpact") return key;
  if (key === "impactConditionWear") return key;
  if (key === "limbDamageMultipliers") return key;
  if (key === "attackPower") return key;
  if (key === "criticalDamage") return key;
  if (key === "additionalProficiencies") return key;
  return "pending";
}
