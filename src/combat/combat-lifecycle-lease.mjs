import { SYSTEM_ID } from "../constants.mjs";

export const COMBAT_LIFECYCLE_CONTEXT_OPTION = "falloutMawCombatLifecycleContextId";
export const COMBAT_LIFECYCLE_LEASE_OPTION = COMBAT_LIFECYCLE_CONTEXT_OPTION;
export const COMBAT_LIFECYCLE_SETTLEMENT_OPTION = "falloutMawCombatLifecycleSettlementPurpose";
export const COMBATANT_LIFECYCLE_OPERATION_OPTION = "falloutMawCombatantLifecycleOperationId";

const ACQUIRE_QUERY = `${SYSTEM_ID}.acquireCombatLifecycleLease`;
const RELEASE_QUERY = `${SYSTEM_ID}.releaseCombatLifecycleLease`;
const QUERY_TIMEOUT_MS = 60 * 1000;
const LEASE_TIMEOUT_MS = 2 * 60 * 1000;
const SNAPSHOT_WAIT_MS = 2 * 1000;
const activeLeases = new Map();
const pendingLeaseKeys = new Set();
let registered = false;

export function registerCombatLifecycleLeaseQueries() {
  if (registered) return;
  CONFIG.queries ??= {};
  CONFIG.queries[ACQUIRE_QUERY] = handleAcquireCombatLifecycleLease;
  CONFIG.queries[RELEASE_QUERY] = handleReleaseCombatLifecycleLease;
  registered = true;
}

export async function acquireCombatLifecycleLease(combat, {
  purpose = "",
  actorUuids = [],
  combatantIds = []
} = {}) {
  const authority = game.users?.activeGM;
  if (!combat?.id) throw new Error("Combat not found.");
  if (!authority?.id) throw new Error("No active GM is available to lock the combat lifecycle.");
  if (authority.isSelf) return null;
  registerCombatLifecycleLeaseQueries();
  const result = await authority.query(ACQUIRE_QUERY, {
    combatId: combat.id,
    purpose: String(purpose),
    actorUuids: normalizeIds(actorUuids),
    combatantIds: normalizeIds(combatantIds)
  }, { timeout: QUERY_TIMEOUT_MS });
  const leaseId = String(result?.leaseId ?? "");
  const authorityUserId = String(result?.authorityUserId ?? "");
  if (!leaseId || authorityUserId !== authority.id) {
    throw new Error("The active GM returned an invalid combat lifecycle lease.");
  }
  if (game.users?.activeGM?.id !== authorityUserId) {
    void releaseRemoteLease(authority, leaseId, { expectsSettlement: false });
    throw new Error("Combat authority changed while acquiring its lifecycle lock.");
  }
  await waitForCombatSnapshot(combat, result?.snapshot, authorityUserId);

  let released = false;
  return {
    leaseId,
    authorityUserId,
    async release({ expectsSettlement = false } = {}) {
      if (released) return;
      released = true;
      try {
        await releaseRemoteLease(authority, leaseId, { expectsSettlement });
      } catch (error) {
        console.error(`${SYSTEM_ID} | Failed to release remote combat lifecycle lease`, error);
      }
    }
  };
}

export function settleCombatLifecycleLease(leaseId = "", {
  combatId = "",
  purpose = "",
  requesterUserId = ""
} = {}) {
  const state = activeLeases.get(String(leaseId));
  if (!state) return false;
  if (game.user?.id !== state.authorityUserId) return false;
  if (
    (combatId && state.combatId !== String(combatId))
    || (purpose && state.purpose !== String(purpose))
    || (requesterUserId && state.requesterUserId !== String(requesterUserId))
  ) {
    return false;
  }
  state.documentSettled = true;
  releaseLeaseIfSettled(state);
  return true;
}

async function handleAcquireCombatLifecycleLease(data = {}, { user } = {}) {
  assertCurrentActiveGM();
  const combat = game.combats?.get?.(String(data.combatId ?? ""));
  if (!combat) throw new Error("Combat not found.");
  validateLeaseRequester(user, combat, data);

  const purpose = String(data.purpose ?? "");
  const requestKey = `${user.id}:${combat.id}`;
  if (pendingLeaseKeys.has(requestKey)) {
    throw new Error("This requester already has a pending combat lifecycle operation.");
  }
  pendingLeaseKeys.add(requestKey);

  const leaseId = foundry.utils.randomID();
  const acquired = createDeferred();
  const releaseGate = createDeferred();
  const state = {
    leaseId,
    requestKey,
    requesterUserId: user.id,
    authorityUserId: game.user.id,
    combatId: combat.id,
    purpose,
    requesterReleased: false,
    documentSettled: false,
    expectsSettlement: false,
    release: releaseGate.resolve,
    settled: createDeferred(),
    completed: createDeferred(),
    released: false,
    timeout: null
  };
  const queued = combat.runFalloutMawLifecycleOperation(
    `remote-lease:${leaseId}`,
    async () => {
      assertCurrentActiveGM();
      activeLeases.set(leaseId, state);
      acquired.resolve();
      await releaseGate.promise;
    },
    { contextId: leaseId }
  );
  void queued
    .catch(error => acquired.reject(error))
    .finally(() => {
      if (state.timeout !== null) globalThis.clearTimeout(state.timeout);
      activeLeases.delete(leaseId);
      pendingLeaseKeys.delete(requestKey);
      state.settled.resolve(false);
      state.completed.resolve();
    });

  await acquired.promise;
  state.timeout = globalThis.setTimeout(() => {
    console.error(
      `${SYSTEM_ID} | Combat lifecycle lease ${leaseId} timed out and was released`
    );
    forceReleaseLease(state);
  }, LEASE_TIMEOUT_MS);
  state.timeout?.unref?.();
  return {
    leaseId,
    authorityUserId: game.user.id,
    snapshot: createCombatLifecycleSnapshot(combat)
  };
}

async function handleReleaseCombatLifecycleLease(data = {}, { user } = {}) {
  const leaseId = String(data.leaseId ?? "");
  const state = activeLeases.get(leaseId);
  if (!state) return false;
  if (state.requesterUserId !== user?.id && !user?.isGM) {
    throw new Error("Only the lease requester may release this combat lifecycle lock.");
  }
  state.requesterReleased = true;
  state.expectsSettlement = Boolean(data.expectsSettlement);
  if (!state.expectsSettlement) state.documentSettled = true;
  releaseLeaseIfSettled(state);
  const settled = await state.settled.promise;
  await state.completed.promise;
  return settled;
}

function releaseLeaseIfSettled(state) {
  if (!state.requesterReleased || !state.documentSettled || state.released) return;
  state.released = true;
  state.settled.resolve(true);
  state.release();
}

function forceReleaseLease(state) {
  if (state.released) return;
  state.released = true;
  state.settled.resolve(false);
  state.release();
}

async function releaseRemoteLease(authority, leaseId, { expectsSettlement }) {
  return authority.query(RELEASE_QUERY, {
    leaseId,
    expectsSettlement: Boolean(expectsSettlement)
  }, { timeout: QUERY_TIMEOUT_MS });
}

function validateLeaseRequester(user, combat, data) {
  if (!user) throw new Error("Combat lifecycle requester not found.");
  const purpose = String(data.purpose ?? "");
  if (!["create", "update", "delete", "combat-update"].includes(purpose)) {
    throw new Error("Unsupported combat lifecycle operation.");
  }
  if (user.isGM) return;
  if (purpose === "combat-update") {
    if (!combat.testUserPermission?.(user, "OWNER")) {
      throw new Error("The requester may not modify this Combat.");
    }
    return;
  }
  if (purpose === "create") {
    const actors = normalizeIds(data.actorUuids)
      .map(uuid => resolveActor(uuid))
      .filter(Boolean);
    if (!actors.length || actors.some(actor => !actor.testUserPermission?.(user, "OWNER"))) {
      throw new Error("The requester does not own every Actor being added to combat.");
    }
    return;
  }
  const combatants = normalizeIds(data.combatantIds)
    .map(id => combat.combatants?.get?.(id))
    .filter(Boolean);
  if (!combatants.length || combatants.some(combatant => (
    !combatant.testUserPermission?.(user, "OWNER")
    && !combatant.actor?.testUserPermission?.(user, "OWNER")
  ))) {
    throw new Error("The requester does not own every Combatant being modified.");
  }
}

function resolveActor(uuid) {
  const document = typeof fromUuidSync === "function" ? fromUuidSync(uuid) : null;
  if (document?.documentName === "Actor" || document?.uuid === uuid) return document;
  const actorId = String(uuid).match(/^Actor\.([^.]+)$/)?.[1];
  return actorId ? game.actors?.get?.(actorId) ?? null : null;
}

function normalizeIds(values = []) {
  return Array.from(new Set(Array.from(values ?? [], value => String(value ?? "").trim()).filter(Boolean)));
}

function createCombatLifecycleSnapshot(combat) {
  const combatants = Array.from(combat?.combatants?.contents ?? combat?.combatants ?? [])
    .map(combatant => ({
      id: String(combatant?.id ?? ""),
      actorId: String(combatant?.actorId ?? combatant?.actor?.id ?? ""),
      sceneId: String(combatant?.sceneId ?? ""),
      tokenId: String(combatant?.tokenId ?? ""),
      initiative: (
        combatant?.initiative !== null
        && combatant?.initiative !== undefined
        && Number.isFinite(Number(combatant.initiative))
      ) ? Number(combatant.initiative) : null,
      defeated: Boolean(combatant?.defeated ?? combatant?.isDefeated)
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    round: Number(combat?.round) || 0,
    turn: Number.isInteger(combat?.turn) ? combat.turn : null,
    combatantId: String(combat?.combatant?.id ?? combat?.current?.combatantId ?? ""),
    turnOrder: Array.from(combat?.turns ?? [], combatant => String(combatant?.id ?? "")),
    combatants
  };
}

async function waitForCombatSnapshot(combat, expected, authorityUserId) {
  if (!expected || snapshotsMatch(createCombatLifecycleSnapshot(combat), expected)) return;
  const deadline = Date.now() + SNAPSHOT_WAIT_MS;
  while (Date.now() < deadline) {
    if (game.users?.activeGM?.id !== authorityUserId) {
      throw new Error("Combat authority changed while synchronizing its lifecycle lock.");
    }
    await new Promise(resolve => globalThis.setTimeout(resolve, 25));
    if (snapshotsMatch(createCombatLifecycleSnapshot(combat), expected)) return;
  }
  throw new Error("The local Combat state did not synchronize with the active GM.");
}

function snapshotsMatch(current, expected) {
  return JSON.stringify(current) === JSON.stringify(expected);
}

function assertCurrentActiveGM() {
  if (!game.user?.isActiveGM || game.users?.activeGM?.id !== game.user.id) {
    throw new Error("Combat authority changed.");
  }
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
