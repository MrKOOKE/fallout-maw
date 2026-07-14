import { dispatchSystemEvent, withSystemEventRoot } from "./dispatcher.mjs";

const NEED_SNAPSHOT_OPTION = "falloutMawNeedThresholdBefore";
const CAMP_SETTING_KEY = "fallout-maw.campState";

let hooksRegistered = false;
let cachedCampState = null;
let settingsAccessorsPromise = null;

/**
 * Register the post-commit adapters which need a before/after snapshot but do
 * not own the underlying gameplay workflow themselves.
 */
export function registerFoundryWorldSystemEventHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  const initialCamp = tryCloneJson(readCampState(), "initial camp state");
  cachedCampState = initialCamp.ok ? initialCamp.value : null;

  Hooks.on("preUpdateActor", captureNeedThresholdSnapshot);
  Hooks.on("updateActor", emitNeedThresholdTransitions);
  Hooks.on("updateSetting", emitCampStateTransitions);
}

/** Return every concrete need threshold boundary crossed by an Actor update. */
export function classifyNeedThresholdTransitions({ beforeNeeds = {}, afterNeeds = {}, needSettings = [] } = {}) {
  const events = [];
  for (const need of needSettings ?? []) {
    const needKey = String(need?.key ?? "").trim();
    if (!needKey || !Object.hasOwn(beforeNeeds ?? {}, needKey) || !Object.hasOwn(afterNeeds ?? {}, needKey)) continue;
    const beforePercent = getNeedPercent(beforeNeeds[needKey]);
    const afterPercent = getNeedPercent(afterNeeds[needKey]);
    const thresholds = Array.from(need?.settings?.thresholds ?? [])
      .map((threshold, index) => ({
        id: String(threshold?.id ?? `threshold-${index}`),
        percent: Number(threshold?.percent) || 0
      }))
      .sort((left, right) => left.percent - right.percent || left.id.localeCompare(right.id));
    for (const threshold of thresholds) {
      const wasActive = beforePercent >= threshold.percent;
      const active = afterPercent >= threshold.percent;
      if (wasActive === active) continue;
      events.push({
        key: active
          ? "fallout-maw.actor.need.thresholdEntered"
          : "fallout-maw.actor.need.thresholdLeft",
        needKey,
        thresholdId: threshold.id,
        thresholdPercent: threshold.percent,
        beforePercent,
        afterPercent
      });
    }
  }
  return events;
}

/** Classify the exact lifecycle changes represented by the persisted camp state. */
export function classifyCampStateTransitions(before = {}, after = {}) {
  const previous = normalizeCampStateSnapshot(before);
  const current = normalizeCampStateSnapshot(after);
  const events = [];
  const previousActors = new Set(previous.participants.map(entry => entry.actorUuid));
  const currentActors = new Set(current.participants.map(entry => entry.actorUuid));

  if (!previous.active && current.active) {
    events.push({ key: "fallout-maw.camp.started", campId: current.id, actorUuid: "" });
  }
  for (const participant of current.participants) {
    if (!previousActors.has(participant.actorUuid)) {
      events.push({
        key: "fallout-maw.camp.participantJoined",
        campId: current.id,
        actorUuid: participant.actorUuid
      });
    }
  }
  for (const participant of previous.participants) {
    if (!currentActors.has(participant.actorUuid)) {
      events.push({
        key: "fallout-maw.camp.participantLeft",
        campId: previous.id,
        actorUuid: participant.actorUuid
      });
    }
  }
  if (previous.active && !current.active) {
    events.push({ key: "fallout-maw.camp.closed", campId: previous.id, actorUuid: "" });
  }
  return events;
}

/** Build plain, target-atomic discovery descriptors after a committed map-state update. */
export function buildGlobalMapDiscoveryEvents({ scene = null, locations = [], transitions = [], exits = [] } = {}) {
  return [
    ...buildDiscoveryKind("location", locations),
    ...buildDiscoveryKind("transition", transitions),
    ...buildDiscoveryKind("exit", exits)
  ];

  function buildDiscoveryKind(kind, entries) {
    return Array.from(entries ?? []).map(entry => ({
      key: `fallout-maw.globalMap.${kind}.discovered`,
      data: {
        sceneUuid: String(scene?.uuid ?? ""),
        sceneId: String(scene?.id ?? ""),
        discoveryType: kind,
        entryId: String(entry?.id ?? entry ?? ""),
        entryName: String(entry?.name ?? "")
      }
    })).filter(event => event.data.entryId);
  }
}

export function systemEventParticipant({ actor = null, token = null, item = null } = {}) {
  const tokenDocument = token?.document ?? token;
  const participant = {
    actorUuid: String(actor?.uuid ?? tokenDocument?.actor?.uuid ?? ""),
    tokenUuid: String(tokenDocument?.uuid ?? actor?.token?.uuid ?? actor?.token?.document?.uuid ?? ""),
    itemUuid: String(item?.uuid ?? "")
  };
  return Object.values(participant).some(Boolean) ? participant : null;
}

export function isSystemEventCancelled(result = null) {
  return Boolean(result?.control?.current || result?.control?.remaining || result?.control?.root);
}

export { dispatchSystemEvent, withSystemEventRoot };

function captureNeedThresholdSnapshot(actor, changes = {}, options = {}) {
  const keys = getChangedNeedKeys(changes);
  if (!keys.length || !options || typeof options !== "object") return;
  const needs = cloneNeedResources(actor, keys, "need threshold before snapshot");
  if (!needs) return;
  options[NEED_SNAPSHOT_OPTION] = {
    actorUuid: String(actor?.uuid ?? ""),
    needs
  };
}

async function emitNeedThresholdTransitions(actor, changes = {}, options = {}, userId = "") {
  if (!isCurrentActiveGM()) return;
  const snapshot = options?.[NEED_SNAPSHOT_OPTION];
  const keys = getChangedNeedKeys(changes);
  if (!snapshot || snapshot.actorUuid !== actor?.uuid || !keys.length) return;
  const afterNeeds = cloneNeedResources(actor, keys, "need threshold after snapshot");
  if (!afterNeeds) return;
  const { getActorNeedSettings } = await getSettingsAccessors();
  const definitions = getActorNeedSettings(actor).filter(need => keys.includes(need.key));
  const events = classifyNeedThresholdTransitions({
    beforeNeeds: snapshot.needs,
    afterNeeds,
    needSettings: definitions
  });
  if (!events.length) return;

  const target = systemEventParticipant({ actor });
  const chainRef = options?.falloutMawSystemEventChainRef ?? options?.chainRef ?? null;
  void withSystemEventRoot({
    kind: "needThresholdTransition",
    operationId: `need-threshold:${actor.uuid}:${randomId()}`,
    sceneUuid: String(actor?.token?.parent?.uuid ?? canvas?.scene?.uuid ?? ""),
    combatUuid: String(game.combat?.uuid ?? ""),
    chainRef
  }, async scope => {
    for (const [index, event] of events.entries()) {
      await scope.emit(event.key, {
        data: {
          actorUuid: String(actor.uuid),
          needKey: event.needKey,
          thresholdId: event.thresholdId,
          thresholdPercent: event.thresholdPercent,
          beforePercent: event.beforePercent,
          afterPercent: event.afterPercent,
          requesterUserId: String(userId ?? "")
        },
        before: { percent: event.beforePercent },
        after: { percent: event.afterPercent },
        delta: { percent: event.afterPercent - event.beforePercent }
      }, {
        occurrenceKey: `need-threshold:${actor.uuid}:${event.needKey}:${event.thresholdId}:${event.key}:${index}`,
        participants: { source: target, target, related: [] }
      });
    }
  });
}

function emitCampStateTransitions(setting, changes = {}, options = {}, userId = "") {
  if (setting?.key !== CAMP_SETTING_KEY) return;
  const nextSnapshot = tryCloneJson(readSettingValue(setting), "updated camp state");
  if (!nextSnapshot.ok) return;
  const next = nextSnapshot.value ?? emptyCampState();
  const previous = cachedCampState;
  cachedCampState = next;
  if (!previous) return;
  if (!isCurrentActiveGM()) return;
  const events = classifyCampStateTransitions(previous, next);
  if (!events.length) return;
  const chainRef = options?.falloutMawSystemEventChainRef ?? options?.chainRef ?? null;
  void withSystemEventRoot({
    kind: "campStateTransition",
    operationId: `camp-state:${next.id || previous.id || "closed"}:${randomId()}`,
    sceneUuid: String(canvas?.scene?.uuid ?? ""),
    combatUuid: String(game.combat?.uuid ?? ""),
    chainRef
  }, async scope => {
    const related = Array.from(new Set([
      ...normalizeCampStateSnapshot(previous).participants.map(entry => entry.actorUuid),
      ...normalizeCampStateSnapshot(next).participants.map(entry => entry.actorUuid)
    ])).map(actorUuid => ({ actorUuid }));
    for (const [index, event] of events.entries()) {
      const participant = event.actorUuid ? { actorUuid: event.actorUuid } : null;
      await scope.emit(event.key, {
        data: {
          campId: event.campId,
          actorUuid: event.actorUuid,
          requesterUserId: String(userId ?? "")
        },
        before: cloneJson(previous),
        after: cloneJson(next)
      }, {
        occurrenceKey: `camp-state:${event.campId}:${event.key}:${event.actorUuid || "camp"}:${index}`,
        participants: {
          source: event.key === "fallout-maw.camp.participantLeft" ? participant : null,
          target: event.key === "fallout-maw.camp.participantJoined" ? participant : null,
          related
        }
      });
    }
  });
}

function getChangedNeedKeys(changes = {}) {
  const result = new Set();
  walk(changes, "");
  return Array.from(result).sort();

  function walk(value, prefix) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (key === "_id") continue;
        const next = prefix ? `${prefix}.${key}` : key;
        walk(child, next);
      }
      return;
    }
    const match = String(prefix).match(/^system\.needs\.([^.]+)(?:\.|$)/u);
    if (match?.[1]) result.add(match[1]);
  }
}

function getNeedPercent(resource = {}) {
  const min = Math.trunc(Number(resource?.min) || 0);
  const max = Math.max(min, Math.trunc(Number(resource?.max) || 0));
  const value = Math.min(max, Math.max(min, Math.trunc(Number(resource?.value) || 0)));
  return ((value - min) / Math.max(1, max - min)) * 100;
}

function cloneNeedResources(actor, keys, label) {
  const result = {};
  for (const key of keys) {
    const snapshot = tryCloneJson(actor?.system?.needs?.[key] ?? null, `${label} '${key}'`);
    if (!snapshot.ok) return null;
    result[key] = snapshot.value;
  }
  return result;
}

function normalizeCampStateSnapshot(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const participants = Array.from(source.participants ?? [])
    .map(entry => ({ actorUuid: String(entry?.actorUuid ?? "").trim() }))
    .filter(entry => entry.actorUuid);
  return {
    active: Boolean(source.active && String(source.id ?? "").trim()),
    id: String(source.id ?? "").trim(),
    participants
  };
}

function readSettingValue(setting) {
  try {
    return game.settings.get("fallout-maw", "campState");
  } catch (_error) {
    return setting?.value;
  }
}

function readCampState() {
  try {
    return game.settings.get("fallout-maw", "campState");
  } catch (_error) {
    return emptyCampState();
  }
}

function getSettingsAccessors() {
  settingsAccessorsPromise ??= import("../settings/accessors.mjs");
  return settingsAccessorsPromise;
}

function emptyCampState() {
  return { active: false, id: "", participants: [] };
}

function isCurrentActiveGM() {
  return Boolean(game.users?.activeGM?.id && game.users.activeGM.id === game.user?.id);
}

function randomId() {
  return String(foundry.utils.randomID?.() ?? crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite numbers are not valid JSON.");
    return value;
  }
  if (Array.isArray(value)) return value.map(entry => cloneJson(entry));
  if (typeof value !== "object") throw new TypeError(`Unsupported JSON value type '${typeof value}'.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`Unsupported non-plain JSON object '${value.constructor?.name ?? "Object"}'.`);
  }
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    result[key] = cloneJson(entry);
  }
  return result;
}

function tryCloneJson(value, label) {
  try {
    return { ok: true, value: cloneJson(value) };
  } catch (error) {
    console.warn(`fallout-maw | Refused non-JSON ${label}; semantic event was skipped.`, error);
    return { ok: false, value: null };
  }
}
