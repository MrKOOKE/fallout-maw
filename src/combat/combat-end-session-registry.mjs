const MINIMUM_LIMIT = 1;

export const COMBAT_END_SESSION_REGISTRY_DEFAULTS = Object.freeze({
  sessionTtlMs: 6 * 60 * 60 * 1000,
  dismissalTtlMs: 24 * 60 * 60 * 1000,
  terminalTtlMs: 24 * 60 * 60 * 1000,
  maxSessions: 32,
  maxDismissals: 128,
  maxTerminals: 128
});

/**
 * Create the client-local replica of combat-end sessions.
 *
 * Connected clients may keep authoritative session snapshots they receive.
 * Dismissal is a separate local concern, while terminal empty states are
 * authoritative revisioned tombstones. A live session has one immutable local
 * expiry deadline: repeated socket delivery must never keep old combat work
 * alive forever.
 */
export function createCombatEndSessionRegistry(options = {}) {
  return new CombatEndSessionRegistry(options);
}

export class CombatEndSessionRegistry {
  #clock;
  #sessionTtlMs;
  #dismissalTtlMs;
  #terminalTtlMs;
  #maxSessions;
  #maxDismissals;
  #maxTerminals;
  #sessions = new Map();
  #sessionIdsByActorUuid = new Map();
  #dismissals = new Map();
  #terminals = new Map();
  #counters = {
    sessionUpserts: 0,
    emptySessionStates: 0,
    dismissalUpserts: 0,
    terminalUpserts: 0,
    sessionRemovals: {
      empty: 0,
      expired: 0,
      capacity: 0,
      explicit: 0,
      clear: 0
    },
    dismissalRemovals: {
      expired: 0,
      capacity: 0,
      explicit: 0,
      terminal: 0,
      clear: 0
    },
    terminalRemovals: {
      expired: 0,
      capacity: 0,
      superseded: 0,
      clear: 0
    }
  };

  constructor({
    clock = Date.now,
    sessionTtlMs = COMBAT_END_SESSION_REGISTRY_DEFAULTS.sessionTtlMs,
    dismissalTtlMs = COMBAT_END_SESSION_REGISTRY_DEFAULTS.dismissalTtlMs,
    terminalTtlMs = COMBAT_END_SESSION_REGISTRY_DEFAULTS.terminalTtlMs,
    maxSessions = COMBAT_END_SESSION_REGISTRY_DEFAULTS.maxSessions,
    maxDismissals = COMBAT_END_SESSION_REGISTRY_DEFAULTS.maxDismissals,
    maxTerminals = COMBAT_END_SESSION_REGISTRY_DEFAULTS.maxTerminals
  } = {}) {
    if (typeof clock !== "function") throw new TypeError("clock must be a function");
    this.#clock = clock;
    this.#sessionTtlMs = requirePositiveInteger(sessionTtlMs, "sessionTtlMs");
    this.#dismissalTtlMs = requirePositiveInteger(dismissalTtlMs, "dismissalTtlMs");
    this.#terminalTtlMs = requirePositiveInteger(terminalTtlMs, "terminalTtlMs");
    this.#maxSessions = requirePositiveInteger(maxSessions, "maxSessions");
    this.#maxDismissals = requirePositiveInteger(maxDismissals, "maxDismissals");
    this.#maxTerminals = requirePositiveInteger(maxTerminals, "maxTerminals");
  }

  get size() {
    return this.#sessions.size;
  }

  get dismissalSize() {
    return this.#dismissals.size;
  }

  get terminalSize() {
    return this.#terminals.size;
  }

  /**
   * Store an authoritative replicated state.
   *
   * A state without entries is a terminal deletion, not an empty object which
   * remains in the registry. A terminal revision wins ties and rejects any later
   * non-empty state with an equal or older revision. Capacity eviction uses
   * replicated timestamps plus the session id, so replicas converge independently
   * of message insertion order when they have received the same set of states.
   */
  upsert(session, options = {}) {
    const at = this.#resolveTime(options.at);
    const changes = this.#pruneAt(at);
    const id = normalizeId(session?.id);
    if (!id) {
      return {
        accepted: false,
        stored: false,
        reason: "invalid",
        ...changes
      };
    }

    this.#counters.sessionUpserts += 1;
    const revision = getSessionRevision(session);
    if (revision === null) {
      return {
        accepted: false,
        stored: false,
        reason: "invalid-revision",
        ...changes
      };
    }

    if (!Array.isArray(session?.entries) || session.entries.length === 0) {
      this.#counters.emptySessionStates += 1;
      return this.#acceptTerminalState(session, id, revision, at, changes);
    }

    const terminal = this.#terminals.get(id);
    if (terminal && revision <= terminal.revision) {
      return {
        accepted: false,
        stored: false,
        reason: "stale-terminal",
        terminalRevision: terminal.revision,
        ...changes
      };
    }
    if (terminal) this.#removeTerminal(id, "superseded", changes);

    const previous = this.#sessions.get(id);
    if (previous && revision <= previous.revision) {
      return {
        accepted: false,
        stored: true,
        reason: revision === previous.revision ? "duplicate" : "stale",
        revision: previous.revision,
        ...changes
      };
    }

    const expiresAt = previous?.expiresAt ?? getSessionExpiryAt(
      session,
      at,
      this.#sessionTtlMs
    );
    if (!previous && expiresAt <= at) {
      return {
        accepted: false,
        stored: false,
        reason: "expired",
        revision,
        ...changes
      };
    }
    session.expiresAt = expiresAt;

    if (previous) this.#removeSessionFromActorIndex(id, previous.actorUuids);
    const actorUuids = collectSessionActorUuids(session);
    this.#sessions.set(id, {
      session,
      lastSeenAt: Math.max(previous?.lastSeenAt ?? at, at),
      expiresAt,
      orderAt: getReplicatedSessionTimestamp(session),
      actorUuids,
      pinCount: previous?.pinCount ?? 0,
      revision
    });
    this.#addSessionToActorIndex(id, actorUuids);
    this.#enforceSessionCapacity(changes);

    const stored = this.#sessions.has(id);
    return {
      accepted: true,
      stored,
      reason: stored ? "stored" : "capacity",
      revision,
      ...changes
    };
  }

  get(sessionId) {
    return this.#sessions.get(normalizeId(sessionId))?.session;
  }

  has(sessionId) {
    return this.get(sessionId) !== undefined;
  }

  getTerminalRevision(sessionId) {
    return this.#terminals.get(normalizeId(sessionId))?.revision;
  }

  hasTerminal(sessionId) {
    return this.getTerminalRevision(sessionId) !== undefined;
  }

  delete(sessionId) {
    const id = normalizeId(sessionId);
    if (!id) return false;
    const changes = createChanges();
    return this.#removeSession(id, "explicit", changes);
  }

  *values() {
    for (const record of this.#sessions.values()) yield record.session;
  }

  *entries() {
    for (const [id, record] of this.#sessions) yield [id, record.session];
  }

  *terminalEntries() {
    for (const [id, record] of this.#terminals) yield [id, record.revision];
  }

  [Symbol.iterator]() {
    return this.entries();
  }

  sessionIdsForActor(actorUuid) {
    const uuid = normalizeId(actorUuid);
    if (!uuid) return [];
    return Array.from(this.#sessionIdsByActorUuid.get(uuid) ?? []).sort(compareIds);
  }

  sessionsForActor(actorUuid) {
    return this.sessionIdsForActor(actorUuid)
      .map(sessionId => this.#sessions.get(sessionId)?.session)
      .filter(Boolean);
  }

  /**
   * Protect a session while an authority operation is queued or in flight.
   */
  pin(sessionId) {
    const record = this.#sessions.get(normalizeId(sessionId));
    if (!record) return 0;
    record.pinCount += 1;
    return record.pinCount;
  }

  /**
   * Release one operation pin and immediately enforce deferred TTL/capacity.
   */
  unpin(sessionId, options = {}) {
    const at = this.#resolveTime(options.at);
    const changes = createChanges();
    const id = normalizeId(sessionId);
    const record = this.#sessions.get(id);
    if (!record || record.pinCount <= 0) {
      return {
        unpinned: false,
        pinCount: record?.pinCount ?? 0,
        ...changes
      };
    }

    record.pinCount -= 1;
    if (record.pinCount === 0 && record.expiresAt <= at) {
      this.#removeSession(id, "expired", changes);
    }
    this.#enforceSessionCapacity(changes);
    return {
      unpinned: true,
      pinCount: this.#sessions.get(id)?.pinCount ?? 0,
      ...changes
    };
  }

  /**
   * Hide a session only on this client while retaining its replicated state.
   */
  dismiss(sessionId, options = {}) {
    const at = this.#resolveTime(options.at);
    const changes = this.#pruneAt(at);
    const id = normalizeId(sessionId);
    if (!id) {
      return {
        dismissed: false,
        reason: "invalid",
        ...changes
      };
    }

    this.#counters.dismissalUpserts += 1;
    const previous = this.#dismissals.get(id);
    this.#dismissals.set(id, {
      dismissedAt: Math.max(previous?.dismissedAt ?? at, at)
    });
    this.#enforceDismissalCapacity(changes);
    const dismissed = this.#dismissals.has(id);
    return {
      dismissed,
      reason: dismissed ? "dismissed" : "capacity",
      ...changes
    };
  }

  undismiss(sessionId) {
    const id = normalizeId(sessionId);
    if (!id || !this.#dismissals.delete(id)) return false;
    this.#counters.dismissalRemovals.explicit += 1;
    return true;
  }

  isDismissed(sessionId) {
    return this.#dismissals.has(normalizeId(sessionId));
  }

  /**
   * Remove empty/expired state and return ids whose UI may need closing.
   */
  prune(options = {}) {
    return this.#pruneAt(this.#resolveTime(options.at));
  }

  clear({ dismissals = true, terminals = true } = {}) {
    const changes = createChanges();
    for (const id of Array.from(this.#sessions.keys()).sort(compareIds)) {
      this.#removeSession(id, "clear", changes);
    }
    if (dismissals) {
      for (const id of Array.from(this.#dismissals.keys()).sort(compareIds)) {
        this.#removeDismissal(id, "clear", changes);
      }
    }
    if (terminals) {
      for (const id of Array.from(this.#terminals.keys()).sort(compareIds)) {
        this.#removeTerminal(id, "clear", changes);
      }
    }
    return changes;
  }

  getStats() {
    return {
      sessions: {
        count: this.#sessions.size,
        limit: this.#maxSessions,
        ttlMs: this.#sessionTtlMs,
        indexedActors: this.#sessionIdsByActorUuid.size,
        actorLinks: Array.from(this.#sessions.values())
          .reduce((total, record) => total + record.actorUuids.size, 0),
        pinned: Array.from(this.#sessions.values())
          .filter(record => record.pinCount > 0).length,
        pinCount: Array.from(this.#sessions.values())
          .reduce((total, record) => total + record.pinCount, 0),
        overCapacity: Math.max(0, this.#sessions.size - this.#maxSessions),
        upserts: this.#counters.sessionUpserts,
        emptyStates: this.#counters.emptySessionStates,
        removals: { ...this.#counters.sessionRemovals }
      },
      dismissals: {
        count: this.#dismissals.size,
        limit: this.#maxDismissals,
        ttlMs: this.#dismissalTtlMs,
        upserts: this.#counters.dismissalUpserts,
        removals: { ...this.#counters.dismissalRemovals }
      },
      terminals: {
        count: this.#terminals.size,
        limit: this.#maxTerminals,
        ttlMs: this.#terminalTtlMs,
        upserts: this.#counters.terminalUpserts,
        removals: { ...this.#counters.terminalRemovals }
      }
    };
  }

  #resolveTime(value) {
    const time = value === undefined ? Number(this.#clock()) : Number(value);
    if (!Number.isFinite(time)) throw new TypeError("registry time must be finite");
    return time;
  }

  #pruneAt(at) {
    const changes = createChanges();

    const emptyIds = [];
    const expiredSessions = [];
    for (const [id, record] of this.#sessions) {
      if (!Array.isArray(record.session?.entries) || record.session.entries.length === 0) {
        emptyIds.push(id);
      } else if (!isSessionLocallyPinned(record) && record.expiresAt <= at) {
        expiredSessions.push({ id, expiresAt: record.expiresAt });
      }
    }
    emptyIds.sort(compareIds);
    expiredSessions.sort((left, right) => (
      compareNumbers(left.expiresAt, right.expiresAt)
      || compareIds(left.id, right.id)
    ));

    for (const id of emptyIds) {
      const record = this.#sessions.get(id);
      if (record) this.#acceptTerminalState(
        record.session,
        id,
        record.revision,
        at,
        changes
      );
    }
    for (const { id } of expiredSessions) this.#removeSession(id, "expired", changes);

    const expiredDismissals = [];
    for (const [id, record] of this.#dismissals) {
      if ((record.dismissedAt + this.#dismissalTtlMs) <= at) {
        expiredDismissals.push({ id, dismissedAt: record.dismissedAt });
      }
    }
    expiredDismissals.sort((left, right) => (
      compareNumbers(left.dismissedAt, right.dismissedAt)
      || compareIds(left.id, right.id)
    ));
    for (const { id } of expiredDismissals) this.#removeDismissal(id, "expired", changes);

    const expiredTerminals = [];
    for (const [id, record] of this.#terminals) {
      if ((record.lastSeenAt + this.#terminalTtlMs) <= at) {
        expiredTerminals.push({ id, lastSeenAt: record.lastSeenAt });
      }
    }
    expiredTerminals.sort((left, right) => (
      compareNumbers(left.lastSeenAt, right.lastSeenAt)
      || compareIds(left.id, right.id)
    ));
    for (const { id } of expiredTerminals) this.#removeTerminal(id, "expired", changes);

    return changes;
  }

  #enforceSessionCapacity(changes) {
    let excess = this.#sessions.size - this.#maxSessions;
    if (excess <= 0) return;
    const candidates = Array.from(this.#sessions, ([id, record]) => ({
      id,
      orderAt: record.orderAt
    }))
      .filter(({ id }) => !isSessionOperationProtected(this.#sessions.get(id)))
      .sort((left, right) => (
      compareNumbers(left.orderAt, right.orderAt)
      || compareIds(left.id, right.id)
      ));
    for (const { id } of candidates.slice(0, excess)) {
      this.#removeSession(id, "capacity", changes);
    }

    excess = this.#sessions.size - this.#maxSessions;
    if (excess <= 0) return;

    // Replicated operationPending is useful failover state, but it must not be
    // able to grow a client registry without limit. Only a local pin represents
    // work actually executing on this client and is therefore non-evictable.
    const replicatedPending = Array.from(this.#sessions, ([id, record]) => ({
      id,
      orderAt: record.orderAt
    }))
      .filter(({ id }) => {
        const record = this.#sessions.get(id);
        return !isSessionLocallyPinned(record) && Boolean(record?.session?.operationPending);
      })
      .sort((left, right) => (
        compareNumbers(left.orderAt, right.orderAt)
        || compareIds(left.id, right.id)
      ));
    for (const { id } of replicatedPending.slice(0, excess)) {
      this.#removeSession(id, "capacity", changes);
    }
  }

  #enforceDismissalCapacity(changes) {
    const excess = this.#dismissals.size - this.#maxDismissals;
    if (excess <= 0) return;
    const candidates = Array.from(this.#dismissals, ([id, record]) => ({
      id,
      dismissedAt: record.dismissedAt
    })).sort((left, right) => (
      compareNumbers(left.dismissedAt, right.dismissedAt)
      || compareIds(left.id, right.id)
    ));
    for (const { id } of candidates.slice(0, excess)) {
      this.#removeDismissal(id, "capacity", changes);
    }
  }

  #enforceTerminalCapacity(changes) {
    const excess = this.#terminals.size - this.#maxTerminals;
    if (excess <= 0) return;
    const candidates = Array.from(this.#terminals, ([id, record]) => ({
      id,
      orderAt: record.orderAt,
      revision: record.revision
    })).sort((left, right) => (
      compareNumbers(left.orderAt, right.orderAt)
      || compareNumbers(left.revision, right.revision)
      || compareIds(left.id, right.id)
    ));
    for (const { id } of candidates.slice(0, excess)) {
      this.#removeTerminal(id, "capacity", changes);
    }
  }

  #acceptTerminalState(session, id, revision, at, changes) {
    const active = this.#sessions.get(id);
    const previousTerminal = this.#terminals.get(id);
    const newestRevision = Math.max(
      active?.revision ?? -1,
      previousTerminal?.revision ?? -1
    );
    if (revision < newestRevision) {
      return {
        accepted: false,
        stored: Boolean(active),
        reason: "stale",
        revision: newestRevision,
        ...changes
      };
    }

    this.#counters.terminalUpserts += 1;
    if (active) this.#removeSession(id, "empty", changes);
    this.#removeDismissal(id, "terminal", changes);

    this.#terminals.set(id, {
      revision,
      lastSeenAt: Math.max(previousTerminal?.lastSeenAt ?? at, at),
      orderAt: getReplicatedSessionTimestamp(session)
    });
    this.#enforceTerminalCapacity(changes);
    const terminalStored = this.#terminals.has(id);
    return {
      accepted: true,
      stored: false,
      terminalStored,
      reason: terminalStored ? "empty" : "terminal-capacity",
      revision,
      ...changes
    };
  }

  #removeSession(id, reason, changes) {
    const record = this.#sessions.get(id);
    if (!record || !this.#sessions.delete(id)) return false;
    this.#removeSessionFromActorIndex(id, record.actorUuids);
    this.#counters.sessionRemovals[reason] += 1;
    changes.removedSessions.push({
      id,
      reason,
      revision: record.revision
    });
    return true;
  }

  #addSessionToActorIndex(sessionId, actorUuids) {
    for (const actorUuid of actorUuids) {
      const sessionIds = this.#sessionIdsByActorUuid.get(actorUuid) ?? new Set();
      sessionIds.add(sessionId);
      this.#sessionIdsByActorUuid.set(actorUuid, sessionIds);
    }
  }

  #removeSessionFromActorIndex(sessionId, actorUuids) {
    for (const actorUuid of actorUuids) {
      const sessionIds = this.#sessionIdsByActorUuid.get(actorUuid);
      if (!sessionIds) continue;
      sessionIds.delete(sessionId);
      if (sessionIds.size === 0) this.#sessionIdsByActorUuid.delete(actorUuid);
    }
  }

  #removeDismissal(id, reason, changes) {
    if (!this.#dismissals.delete(id)) return false;
    this.#counters.dismissalRemovals[reason] += 1;
    changes.removedDismissals.push({ id, reason });
    return true;
  }

  #removeTerminal(id, reason, changes) {
    if (!this.#terminals.delete(id)) return false;
    this.#counters.terminalRemovals[reason] += 1;
    changes.removedTerminals.push({ id, reason });
    return true;
  }
}

function getReplicatedSessionTimestamp(session) {
  const updatedAt = Number(session?.updatedAt);
  if (Number.isFinite(updatedAt)) return updatedAt;
  const createdAt = Number(session?.createdAt);
  return Number.isFinite(createdAt) ? createdAt : 0;
}

function getSessionExpiryAt(session, receivedAt, ttlMs) {
  const replicatedExpiry = Number(session?.expiresAt);
  const localDeadline = receivedAt + ttlMs;
  if (Number.isFinite(replicatedExpiry) && replicatedExpiry > 0) {
    return Math.min(replicatedExpiry, localDeadline);
  }
  return localDeadline;
}

function collectSessionActorUuids(session) {
  return new Set((session?.entries ?? [])
    .map(entry => normalizeId(entry?.actorUuid))
    .filter(Boolean));
}

function isSessionOperationProtected(record) {
  return Boolean(isSessionLocallyPinned(record) || record?.session?.operationPending);
}

function isSessionLocallyPinned(record) {
  return Boolean(record?.pinCount > 0);
}

function getSessionRevision(session) {
  if (session?.revision === undefined || session?.revision === null || session.revision === "") {
    return 0;
  }
  const revision = Number(session.revision);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

function normalizeId(value) {
  return String(value ?? "").trim();
}

function compareNumbers(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareIds(left, right) {
  const leftId = String(left);
  const rightId = String(right);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function createChanges() {
  return {
    removedSessions: [],
    removedDismissals: [],
    removedTerminals: []
  };
}

function requirePositiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < MINIMUM_LIMIT) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return number;
}
