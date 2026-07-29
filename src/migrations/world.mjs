import { SYSTEM_ID } from "../constants.mjs";
import {
  CONSCIOUSNESS_RESOURCE_KEY,
  CONSCIOUSNESS_RECOVERY_TARGET_PATH,
  buildConsciousnessUpdateData
} from "../combat/consciousness.mjs";
import {
  LEGACY_CONSCIOUSNESS_MIGRATION_PENDING_FLAG
} from "./documents.mjs";
import { DOCUMENT_MIGRATION_VERSION_SETTING } from "../settings/constants.mjs";

const CONSCIOUSNESS_DOCUMENT_MIGRATION_VERSION = 1;
const UNCONSCIOUS_STATUS_ID = "unconscious";
const LEGACY_SHOCK_FLAG = "shockUnconscious";
let consciousnessMigrationHooksRegistered = false;

export async function migrateWorldConsciousnessData() {
  registerConsciousnessMigrationHooks();
  if (!game.user?.isActiveGM) return { migrated: 0, failed: 0 };

  const storedVersion = Math.max(
    0,
    Math.trunc(Number(game.settings.get(SYSTEM_ID, DOCUMENT_MIGRATION_VERSION_SETTING)) || 0)
  );
  const auditAllDocuments = storedVersion < CONSCIOUSNESS_DOCUMENT_MIGRATION_VERSION;
  let migrated = 0;
  let failed = 0;

  for (const actor of game.actors?.contents ?? []) {
    if (!auditAllDocuments && !actorMayNeedConsciousnessMigration(actor)) continue;
    const result = await migrateConsciousnessActor(actor, {
      label: actor?.uuid ?? actor?.name ?? "Actor"
    });
    migrated += result.migrated;
    failed += result.failed;
  }

  for (const scene of game.scenes?.contents ?? []) {
    for (const token of scene.tokens ?? []) {
      if (token.actorLink) continue;
      if (!auditAllDocuments && !tokenMayNeedConsciousnessMigration(token)) continue;
      const actor = token.actor;
      if (!actor) continue;
      const result = await migrateConsciousnessActor(actor, {
        label: actor?.uuid ?? `${scene.name}:${token.name}`
      });
      migrated += result.migrated;
      failed += result.failed;
    }
  }

  if (
    failed === 0
    && storedVersion < CONSCIOUSNESS_DOCUMENT_MIGRATION_VERSION
  ) {
    await game.settings.set(
      SYSTEM_ID,
      DOCUMENT_MIGRATION_VERSION_SETTING,
      CONSCIOUSNESS_DOCUMENT_MIGRATION_VERSION
    );
  }

  if (migrated > 0) {
    console.info(`${SYSTEM_ID} | Persisted consciousness data for ${migrated} actor document(s).`);
  }
  return { migrated, failed };
}

function actorMayNeedConsciousnessMigration(actor) {
  if (getPendingLegacyConsciousnessMigration(actor)) return true;
  if (hasStoredConsciousness(actor)) return false;
  const health = actor?.system?.resources?.health;
  return Boolean(
    actor?.statuses?.has?.(UNCONSCIOUS_STATUS_ID)
    && health
    && Number(health.value) <= Number(health.min)
  );
}

function tokenMayNeedConsciousnessMigration(token) {
  const source = token?.delta?._source ?? token?._source?.delta ?? null;
  if (!source) return true;
  const flags = source.flags?.[SYSTEM_ID] ?? {};
  if (
    flags[LEGACY_CONSCIOUSNESS_MIGRATION_PENDING_FLAG]
    || flags[LEGACY_SHOCK_FLAG]
  ) return true;
  const resources = source.system?.resources;
  return !(resources && Object.hasOwn(resources, CONSCIOUSNESS_RESOURCE_KEY));
}

async function migrateConsciousnessActor(actor, { label = "" } = {}) {
  if (!actor || !["character", "construct"].includes(actor.type)) return { migrated: 0, failed: 0 };

  try {
    const pendingLegacyMigration = getPendingLegacyConsciousnessMigration(actor);
    if (pendingLegacyMigration) {
      const resource = actor.system?.resources?.[CONSCIOUSNESS_RESOURCE_KEY]
        ?? actor._source?.system?.resources?.[CONSCIOUSNESS_RESOURCE_KEY];
      const valueData = buildConsciousnessUpdateData(
        resource,
        pendingLegacyMigration.progress
      );
      if (!valueData) return { migrated: 0, failed: 0 };
      await actor.update({
        [`flags.${SYSTEM_ID}.-=${LEGACY_SHOCK_FLAG}`]: null,
        [`flags.${SYSTEM_ID}.-=${LEGACY_CONSCIOUSNESS_MIGRATION_PENDING_FLAG}`]: null,
        [`system.resources.${CONSCIOUSNESS_RESOURCE_KEY}.min`]: 0,
        [`system.resources.${CONSCIOUSNESS_RESOURCE_KEY}.value`]: valueData.value,
        [`system.resources.${CONSCIOUSNESS_RESOURCE_KEY}.spent`]: valueData.spent,
        [CONSCIOUSNESS_RECOVERY_TARGET_PATH]: valueData.recoveryTarget
      }, createPersistentMigrationOptions());
      return { migrated: 1, failed: 0 };
    }

    if (hasStoredConsciousness(actor)) {
      return { migrated: 0, failed: 0 };
    }
    const health = actor.system?.resources?.health;
    if (
      !actor.statuses?.has?.(UNCONSCIOUS_STATUS_ID)
      || !health
      || Number(health.value) > Number(health.min)
    ) return { migrated: 0, failed: 0 };

    const resource = actor.system?.resources?.[CONSCIOUSNESS_RESOURCE_KEY];
    const valueData = buildConsciousnessUpdateData(resource, 0);
    if (!valueData) return { migrated: 0, failed: 0 };
    await actor.update({
      [`system.resources.${CONSCIOUSNESS_RESOURCE_KEY}.min`]: 0,
      [`system.resources.${CONSCIOUSNESS_RESOURCE_KEY}.value`]: valueData.value,
      [`system.resources.${CONSCIOUSNESS_RESOURCE_KEY}.spent`]: valueData.spent,
      [CONSCIOUSNESS_RECOVERY_TARGET_PATH]: valueData.recoveryTarget
    }, createPersistentMigrationOptions());
    return { migrated: 1, failed: 0 };
  } catch (error) {
    console.error(`${SYSTEM_ID} | Consciousness migration failed for ${label}`, error);
    return { migrated: 0, failed: 1 };
  }
}

function getPendingLegacyConsciousnessMigration(actor) {
  const pending = actor?._source?.flags?.[SYSTEM_ID]?.[LEGACY_CONSCIOUSNESS_MIGRATION_PENDING_FLAG];
  if (pending === true) return { progress: 0 };
  if (!pending || typeof pending !== "object") return null;
  return {
    progress: Math.max(0, Math.trunc(Number(pending.progress) || 0))
  };
}

function hasStoredConsciousness(actor) {
  const resources = actor?._source?.system?.resources;
  return Boolean(resources && Object.hasOwn(resources, CONSCIOUSNESS_RESOURCE_KEY));
}

function createPersistentMigrationOptions(overrides = {}) {
  return {
    enforceTypes: false,
    diff: false,
    recursive: true,
    render: false,
    falloutMawSkipDamageStatusSync: true,
    falloutMawSkipConsciousnessRecovery: true,
    falloutMawLimbCapSync: true,
    falloutMawDocumentMigration: true,
    ...overrides
  };
}

function registerConsciousnessMigrationHooks() {
  if (consciousnessMigrationHooksRegistered || !globalThis.Hooks?.on) return;
  consciousnessMigrationHooksRegistered = true;

  const migrateCreatedActor = actor => {
    const migration = game.user?.isActiveGM
      ? migrateConsciousnessActor(actor, {
          label: actor?.uuid ?? actor?.name ?? "Actor"
        })
      : Promise.resolve({ migrated: 0, failed: 0 });
    void migration
      .then(result => {
        if (result.failed === 0) {
          globalThis.Hooks?.callAll?.(`${SYSTEM_ID}.consciousnessDocumentMigrated`, actor);
        }
      });
  };

  Hooks.on("createActor", migrateCreatedActor);
  Hooks.on("createToken", tokenDocument => {
    if (!tokenDocument?.actorLink) migrateCreatedActor(tokenDocument?.actor);
  });
}
