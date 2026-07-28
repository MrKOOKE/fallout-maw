import {
  cleanupDeletedCombatantResources,
  initializeCreatedCombatantResources
} from "../combat/resource-lifecycle.mjs";
import { waitForCombatantCreateActiveEffectRefresh } from "../combat/active-effect-lifecycle.mjs";
import { SYSTEM_ID } from "../constants.mjs";
import {
  COMBATANT_LIFECYCLE_OPERATION_OPTION,
  COMBAT_LIFECYCLE_CONTEXT_OPTION,
  COMBAT_LIFECYCLE_SETTLEMENT_OPTION,
  acquireCombatLifecycleLease,
  settleCombatLifecycleLease
} from "../combat/combat-lifecycle-lease.mjs";

export class FalloutMaWCombatant extends Combatant {
  static createDocuments(data = [], operation = {}) {
    return runCombatantDocumentOperation({
      purpose: "create",
      operation,
      actorUuids: collectCreateActorUuids(data, operation.parent),
      invoke: lockedOperation => super.createDocuments(data, lockedOperation)
    });
  }

  static updateDocuments(updates = [], operation = {}) {
    if (!hasCombatantLifecycleUpdate(updates)) {
      return super.updateDocuments(updates, operation);
    }
    return runCombatantDocumentOperation({
      purpose: "update",
      operation,
      combatantIds: collectDocumentIds(updates),
      invoke: lockedOperation => super.updateDocuments(updates, lockedOperation)
    });
  }

  static deleteDocuments(ids = [], operation = {}) {
    return runCombatantDocumentOperation({
      purpose: "delete",
      operation,
      combatantIds: collectDocumentIds(ids),
      invoke: lockedOperation => super.deleteDocuments(ids, lockedOperation)
    });
  }

  static async _preCreateOperation(documents, operation, user) {
    await waitForParentCombatLifecycleBeforeOperation(operation, "create");
    const allowed = await super._preCreateOperation(documents, operation, user);
    if (allowed === false) return false;
    return allowed;
  }

  static async _onCreateOperation(documents, operation, user) {
    try {
      await super._onCreateOperation(documents, operation, user);
      try {
        await waitForCombatantCreateActiveEffectRefresh(documents);
      } catch (error) {
        console.error(`${SYSTEM_ID} | Combatant combat-start Active Effect refresh failed`, error);
      }
      await waitForParentCombatLifecycleAfterOperation(operation, "create");
      await initializeCreatedCombatantResources(documents, operation.parent, {
        lifecycleContextId: String(operation?.[COMBAT_LIFECYCLE_CONTEXT_OPTION] ?? "")
      });
    } finally {
      settleOperationLease(operation, user, "create");
    }
  }

  static async _preUpdateOperation(documents, operation, user) {
    await waitForParentCombatLifecycleBeforeOperation(operation, "update");
    return super._preUpdateOperation(documents, operation, user);
  }

  static async _onUpdateOperation(documents, operation, user) {
    try {
      await super._onUpdateOperation(documents, operation, user);
      await waitForParentCombatLifecycleAfterOperation(operation, "update");
    } finally {
      settleOperationLease(operation, user, "update");
    }
  }

  static async _preDeleteOperation(documents, operation, user) {
    await waitForParentCombatLifecycleBeforeOperation(operation, "delete");
    const allowed = await super._preDeleteOperation(documents, operation, user);
    if (allowed === false) return false;
    return allowed;
  }

  static async _onDeleteOperation(documents, operation, user) {
    try {
      await super._onDeleteOperation(documents, operation, user);
      await waitForParentCombatLifecycleAfterOperation(operation, "delete");
      await cleanupDeletedCombatantResources(documents, operation.parent);
    } finally {
      settleOperationLease(operation, user, "delete");
    }
  }
}

async function runCombatantDocumentOperation({
  purpose,
  operation,
  actorUuids = [],
  combatantIds = [],
  invoke
}) {
  const combat = operation?.parent;
  const contextId = String(operation?.[COMBAT_LIFECYCLE_CONTEXT_OPTION] ?? "");
  const operationId = foundry.utils.randomID();
  const taggedOperation = {
    ...operation,
    [COMBATANT_LIFECYCLE_OPERATION_OPTION]: operationId
  };
  if (
    !combat?.runFalloutMawLifecycleOperation
    || operation.pack
    || operation.dryRun
  ) {
    if (isUnsupportedCombatantBatchPreflight(operation)) {
      throw new Error(
        "Combatant lifecycle changes are not supported inside modifyDocumentBatch."
      );
    }
    return invoke(taggedOperation);
  }
  if (contextId && combat.isFalloutMawLifecycleContext?.(contextId)) {
    return invoke(taggedOperation);
  }

  if (game.user?.isActiveGM) {
    return combat.runFalloutMawLifecycleOperation(
      `combatant-${purpose}:${operationId}`,
      ({ contextId: lockedContextId }) => invoke({
        ...taggedOperation,
        [COMBAT_LIFECYCLE_CONTEXT_OPTION]: lockedContextId
      })
    );
  }

  await combat.waitForFalloutMawTurnTransition();
  const lease = await acquireCombatLifecycleLease(combat, {
    purpose,
    actorUuids,
    combatantIds
  });
  if (!lease) throw new Error("No active GM is available to lock the combat lifecycle.");
  let expectsSettlement = false;
  try {
    if (game.users?.activeGM?.id !== lease.authorityUserId) {
      throw new Error("Combat authority changed before the document operation started.");
    }
    const result = await invoke({
      ...taggedOperation,
      [COMBAT_LIFECYCLE_CONTEXT_OPTION]: lease.leaseId,
      [COMBAT_LIFECYCLE_SETTLEMENT_OPTION]: purpose
    });
    expectsSettlement = Array.isArray(result) && result.length > 0;
    return result;
  } finally {
    await lease.release({ expectsSettlement });
  }
}

async function waitForParentCombatLifecycleBeforeOperation(operation = {}, purpose = "") {
  const combat = operation.parent;
  if (!combat) return;
  if (purpose === "update" && !hasCombatantLifecycleUpdate(operation.updates)) return;
  const contextId = String(operation[COMBAT_LIFECYCLE_CONTEXT_OPTION] ?? "");
  if (contextId && combat.isFalloutMawLifecycleContext?.(contextId)) return;
  if (contextId) {
    await combat.waitForFalloutMawTurnLifecycle?.();
  } else {
    await combat.waitForFalloutMawTurnTransition?.();
  }
}

async function waitForParentCombatLifecycleAfterOperation(operation = {}, purpose = "") {
  const combat = operation.parent;
  if (!combat) return;
  if (purpose === "update" && !hasCombatantLifecycleUpdate(operation.updates)) return;
  const operationId = String(operation[COMBATANT_LIFECYCLE_OPERATION_OPTION] ?? "");
  if (operationId && combat.waitForFalloutMawCombatantOperationLifecycle) {
    const tracked = await combat.waitForFalloutMawCombatantOperationLifecycle(operationId);
    if (tracked) return;
  }
  const contextId = String(operation[COMBAT_LIFECYCLE_CONTEXT_OPTION] ?? "");
  if (contextId && combat.isFalloutMawLifecycleContext?.(contextId)) return;
  if (contextId) {
    await combat.waitForFalloutMawTurnLifecycle?.();
  } else {
    await combat.waitForFalloutMawTurnTransition?.();
  }
}

function collectCreateActorUuids(data = [], combat = null) {
  const actorUuids = [];
  for (const entry of data ?? []) {
    const actorId = String(entry?.actorId ?? "");
    const sceneId = String(entry?.sceneId ?? "");
    const tokenId = String(entry?.tokenId ?? "");
    const tokenActor = sceneId && tokenId
      ? game.scenes?.get?.(sceneId)?.tokens?.get?.(tokenId)?.actor
      : null;
    const actor = tokenActor ?? (actorId ? game.actors?.get?.(actorId) : null);
    if (actor?.uuid) actorUuids.push(actor.uuid);
  }
  return Array.from(new Set(actorUuids));
}

function collectDocumentIds(entries = []) {
  return Array.from(new Set(Array.from(entries ?? [], entry => (
    String(entry?._id ?? entry?.id ?? entry ?? "").trim()
  )).filter(Boolean)));
}

function hasCombatantLifecycleUpdate(updates = []) {
  for (const update of updates ?? []) {
    for (const key of Object.keys(update ?? {})) {
      if (
        key === "initiative"
        || key === "defeated"
        || key === "actorId"
        || key === "sceneId"
        || key === "tokenId"
        || key === "group"
        || key.startsWith("initiative.")
        || key.startsWith("defeated.")
        || key.startsWith("actorId.")
        || key.startsWith("sceneId.")
        || key.startsWith("tokenId.")
        || key.startsWith("group.")
      ) return true;
    }
  }
  return false;
}

function isUnsupportedCombatantBatchPreflight(operation = {}) {
  return Boolean(
    operation.dryRun
    && operation.action
    && operation.documentName === "Combatant"
    && operation.parent
  );
}

function settleOperationLease(operation, user, purpose) {
  operation?.parent?.clearFalloutMawCombatantOperationLifecycle?.(
    operation?.[COMBATANT_LIFECYCLE_OPERATION_OPTION]
  );
  const contextId = String(operation?.[COMBAT_LIFECYCLE_CONTEXT_OPTION] ?? "");
  if (
    !contextId
    || operation?.[COMBAT_LIFECYCLE_SETTLEMENT_OPTION] !== purpose
  ) return false;
  return settleCombatLifecycleLease(contextId, {
    combatId: operation?.parent?.id,
    purpose,
    requesterUserId: user?.id
  });
}
