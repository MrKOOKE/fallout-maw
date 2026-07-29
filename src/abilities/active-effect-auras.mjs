import { SYSTEM_ID } from "../constants.mjs";
import {
  ABILITY_CONDITION_TYPES,
  normalizeAbilityConstructs
} from "../settings/abilities.mjs";
import {
  auraTriggerTargetMatches,
  getAuraGeneratedTargetTokens
} from "./aura-conditions.mjs";
import {
  ACTIVE_APPLICATION_EFFECT_FLAG_KEY,
  getActiveApplicationEffectAuraDescriptor,
  getActiveApplicationEffectFlag
} from "./active-application-effects.mjs";
import {
  activeEffectUpdateNeedsAuraStateSync
} from "./active-effect-update-delta.mjs";
import {
  isBulkOperationActive,
  registerBulkOperationFlusher
} from "../utils/bulk-operation.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { executeAbilityTrials, TRIAL_CONSTRUCT_EFFECT_FLAG_KEY } from "./trial-runtime.mjs";

export { ACTIVE_APPLICATION_EFFECT_FLAG_KEY };

const ABILITY_EFFECT_SYNC_OPERATION_OPTION = "falloutMawAbilityEffectSync";
const indexedAuras = new Map();
const indexedAurasBySourceActorUuid = new Map();
const indexedAurasByEffectUuid = new Map();
const deferredAuraEntryEvaluations = new Map();
const deferredAuraActorChanges = new Map();
let runtimeQueue = Promise.resolve();
let deferredAuraOperationSequence = 0;
const FORMULA_IDENTIFIER_PATTERN = /@?[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*/gu;
const GENERIC_ACTOR_PATH_SEGMENTS = new Set([
  "system",
  "skills",
  "characteristics",
  "resources",
  "needs",
  "proficiencies",
  "limbs",
  "load",
  "value",
  "max",
  "spent",
  "bonus",
  "base"
]);

export function registerActiveEffectAuraHooks() {
  registerBulkOperationFlusher(flushDeferredActiveAuraRuntime);
  Hooks.on("createActiveEffect", (effect, options = {}) => {
    if (
      !game.user?.isActiveGM
      || options?.[ABILITY_EFFECT_SYNC_OPERATION_OPTION] === true
      || options?.falloutMawActiveAuraRuntime === true
      || options?.falloutMawTrialRuntime === true
      || effect?.getFlag?.(SYSTEM_ID, TRIAL_CONSTRUCT_EFFECT_FLAG_KEY)
    ) return;
    const entries = indexActiveApplicationAuraEffect(effect);
    for (const entry of entries) queueAuraEntryEvaluation(entry, "create");
    if (!entries.length) queueActorAuraChange(effect?.parent);
  });
  Hooks.on("updateActiveEffect", (effect, changes = {}, options = {}) => {
    if (
      !game.user?.isActiveGM
      || options?.[ABILITY_EFFECT_SYNC_OPERATION_OPTION] === true
      || options?.falloutMawActiveAuraRuntime === true
      || options?.falloutMawTrialRuntime === true
      || effect?.getFlag?.(SYSTEM_ID, TRIAL_CONSTRUCT_EFFECT_FLAG_KEY)
    ) return;
    if (!activeEffectUpdateNeedsAuraStateSync(effect, changes)) return;
    const preservedStates = removeIndexedEffect(effect, { preserveStates: true });
    const entries = indexActiveApplicationAuraEffect(effect);
    for (const entry of entries) {
      entry.states = cloneAuraStates(preservedStates.get(String(entry.condition?.id ?? "")));
      queueAuraEntryEvaluation(entry, "refresh");
    }
    if (!entries.length) queueActorAuraChange(effect?.parent);
  });
  Hooks.on("deleteActiveEffect", (effect, options = {}) => {
    if (
      !game.user?.isActiveGM
      || options?.[ABILITY_EFFECT_SYNC_OPERATION_OPTION] === true
      || options?.falloutMawActiveAuraRuntime === true
      || options?.falloutMawTrialRuntime === true
      || effect?.getFlag?.(SYSTEM_ID, TRIAL_CONSTRUCT_EFFECT_FLAG_KEY)
    ) return;
    removeIndexedEffect(effect);
    queueActorAuraChange(effect?.parent);
  });
  Hooks.on("canvasReady", () => enqueueAuraRuntime(() => rebuildActiveAuraIndex()));
  Hooks.on("updateWorldTime", worldTime => {
    if (!indexedAuras.size) return;
    enqueueAuraRuntime(() => processDueAuras(Number(worldTime) || 0));
  });
  Hooks.on(`${SYSTEM_ID}.factionSettingsChanged`, () => {
    if (!indexedAuras.size) return;
    enqueueAuraRuntime(() => evaluateAllIndexedAuras("relations"));
  });
  Hooks.on("createToken", tokenDocument => {
    if (!indexedAuras.size) return;
    globalThis.setTimeout(() => {
      if (!indexedAuras.size) return;
      enqueueAuraRuntime(() => processTokenAuraChange(tokenDocument, { sourceMayHaveChanged: true }));
    }, 0);
  });
  Hooks.on("deleteToken", tokenDocument => {
    if (!indexedAuras.size) return;
    enqueueAuraRuntime(() => processTokenAuraChange(tokenDocument, { sourceMayHaveChanged: true }));
  });
  Hooks.on("updateToken", (tokenDocument, changes = {}) => {
    if (!indexedAuras.size || !isAuraTokenUpdateRelevant(changes)) return;
    const movement = tokenDocument?.object?.movementAnimationPromise;
    void Promise.resolve(movement)
      .catch(() => undefined)
      .then(() => {
        if (!indexedAuras.size) return;
        enqueueAuraRuntime(() => processTokenAuraChange(tokenDocument, {
          sourceMayHaveChanged: isAuraTokenPositionUpdate(changes)
        }));
      });
  });
  Hooks.on("updateActor", (actor, changes = {}, options = {}) => {
    if (
      !game.user?.isActiveGM
      || options?.falloutMawActiveAuraRuntime === true
      || options?.falloutMawTrialRuntime === true
      || !indexedAuras.size
    ) return;
    if (
      !isAuraTargetActorUpdateRelevant(changes)
      && !isIndexedAuraSourceUpdateRelevant(actor, changes)
    ) return;
    queueActorAuraChange(actor);
  });
}

async function processActorAuraChange(actor = null) {
  if (!indexedAuras.size) return;
  const actorUuid = String(actor?.uuid ?? "");
  if (!actorUuid) return;
  const token = (canvas?.tokens?.placeables ?? []).find(candidate => candidate?.actor?.uuid === actorUuid);
  if (!token) return;
  await processTokenAuraChange(token.document ?? token, { sourceMayHaveChanged: true });
}

export async function initializeActiveEffectAuras() {
  if (!game.user?.isActiveGM) return;
  await enqueueAuraRuntime(() => rebuildActiveAuraIndex());
}

function enqueueAuraRuntime(operation) {
  runtimeQueue = runtimeQueue
    .catch(error => console.error("Fallout MaW | Active aura runtime failed", error))
    .then(operation);
  return runtimeQueue;
}

function queueAuraEntryEvaluation(entry, reason = "refresh") {
  if (isBulkOperationActive()) {
    const key = String(entry?.key ?? "");
    if (key) {
      deferredAuraEntryEvaluations.set(key, {
        entry,
        reason,
        sequence: ++deferredAuraOperationSequence
      });
    }
    return;
  }
  enqueueAuraRuntime(() => evaluateAuraEntry(entry, {
    reason,
    worldTime: getWorldTime()
  }));
}

function queueActorAuraChange(actor = null) {
  if (!indexedAuras.size) return;
  const actorUuid = String(actor?.uuid ?? "");
  if (!actorUuid) return;
  if (isBulkOperationActive()) {
    deferredAuraActorChanges.set(actorUuid, {
      actor,
      sequence: ++deferredAuraOperationSequence
    });
    return;
  }
  enqueueAuraRuntime(() => processActorAuraChange(actor));
}

function flushDeferredActiveAuraRuntime() {
  if (!deferredAuraEntryEvaluations.size && !deferredAuraActorChanges.size) return;
  const operations = [
    ...Array.from(deferredAuraEntryEvaluations.values(), entry => ({
      type: "entry",
      ...entry
    })),
    ...Array.from(deferredAuraActorChanges.values(), entry => ({
      type: "actor",
      ...entry
    }))
  ].sort((left, right) => left.sequence - right.sequence);
  deferredAuraEntryEvaluations.clear();
  deferredAuraActorChanges.clear();
  if (!indexedAuras.size) return;

  // Hooks.callAll does not await hook callbacks. Keep the aura runtime outside
  // the damage batch lock as well: the bulk flusher publishes one detached,
  // ordered pass instead of awaiting nested Trial/damage work.
  void enqueueAuraRuntime(async () => {
    if (isBulkOperationActive()) {
      for (const operation of operations) {
        if (operation.type === "entry") queueAuraEntryEvaluation(operation.entry, operation.reason);
        else queueActorAuraChange(operation.actor);
      }
      return;
    }
    for (const operation of operations) {
      if (operation.type === "entry") {
        await evaluateAuraEntry(operation.entry, {
          reason: operation.reason,
          worldTime: getWorldTime()
        });
      } else {
        await processActorAuraChange(operation.actor);
      }
    }
  });
}

async function rebuildActiveAuraIndex() {
  indexedAuras.clear();
  indexedAurasBySourceActorUuid.clear();
  indexedAurasByEffectUuid.clear();
  const actors = new Map();
  for (const token of canvas?.tokens?.placeables ?? []) {
    if (token?.actor?.uuid) actors.set(token.actor.uuid, token.actor);
  }
  for (const actor of actors.values()) {
    for (const effect of actor.effects ?? []) indexActiveApplicationAuraEffect(effect, { rebuilding: true });
  }
  const now = getWorldTime();
  for (const entry of indexedAuras.values()) {
    await evaluateAuraEntry(entry, { reason: "rebuild", worldTime: now });
  }
}

function indexActiveApplicationAuraEffect(effect = null, { rebuilding = false } = {}) {
  if (!isUsableActiveEffect(effect)) return [];
  const descriptor = getActiveApplicationEffectAuraDescriptor(effect);
  const flag = descriptor?.flag;
  const abilityFunction = descriptor?.abilityFunction;
  const conditions = descriptor?.triggerConditions ?? [];
  const hasTrials = abilityFunction?.conditions?.some(condition => condition?.type === ABILITY_CONDITION_TYPES.trial);
  if (!conditions.length || !hasTrials) {
    return [];
  }
  const constructs = normalizeAbilityConstructs(flag?.constructData);

  const entries = [];
  for (const condition of conditions) {
    const key = `${effect.uuid}:${condition.id}`;
    const entry = {
      key,
      effect,
      effectUuid: String(effect?.uuid ?? ""),
      sourceActorUuid: String(effect?.parent?.uuid ?? ""),
      flag,
      abilityFunction,
      constructs,
      condition,
      formulaIdentifiers: collectAuraFormulaIdentifiers(condition),
      states: new Map(),
      rebuilding
    };
    addIndexedAuraEntry(entry);
    entries.push(entry);
  }
  return entries;
}

function addIndexedAuraEntry(entry = null) {
  const key = String(entry?.key ?? "");
  if (!key) return;
  const previous = indexedAuras.get(key);
  if (previous && previous !== entry) removeIndexedAuraEntry(previous);
  indexedAuras.set(key, entry);
  const sourceActorUuid = String(entry?.sourceActorUuid ?? "");
  if (!sourceActorUuid) return;
  const sourceEntries = indexedAurasBySourceActorUuid.get(sourceActorUuid) ?? new Set();
  sourceEntries.add(entry);
  indexedAurasBySourceActorUuid.set(sourceActorUuid, sourceEntries);
  const effectUuid = String(entry?.effectUuid ?? "");
  if (!effectUuid) return;
  const effectEntries = indexedAurasByEffectUuid.get(effectUuid) ?? new Set();
  effectEntries.add(entry);
  indexedAurasByEffectUuid.set(effectUuid, effectEntries);
}

function removeIndexedAuraEntry(entry = null) {
  if (!entry) return;
  const key = String(entry.key ?? "");
  if (indexedAuras.get(key) === entry) indexedAuras.delete(key);
  const sourceActorUuid = String(entry.sourceActorUuid ?? "");
  const sourceEntries = indexedAurasBySourceActorUuid.get(sourceActorUuid);
  if (sourceEntries) {
    sourceEntries.delete(entry);
    if (!sourceEntries.size) indexedAurasBySourceActorUuid.delete(sourceActorUuid);
  }
  const effectUuid = String(entry.effectUuid ?? "");
  const effectEntries = indexedAurasByEffectUuid.get(effectUuid);
  if (!effectEntries) return;
  effectEntries.delete(entry);
  if (!effectEntries.size) indexedAurasByEffectUuid.delete(effectUuid);
}

function removeIndexedEffect(effect = null, { preserveStates = false } = {}) {
  const effectUuid = String(effect?.uuid ?? "");
  const states = new Map();
  if (!effectUuid) return states;
  const entries = Array.from(indexedAurasByEffectUuid.get(effectUuid) ?? []);
  for (const entry of entries) {
    if (preserveStates) {
      states.set(String(entry.condition?.id ?? ""), entry.states);
    }
    removeIndexedAuraEntry(entry);
  }
  return states;
}

function cloneAuraStates(states = null) {
  return new Map(
    [...(states?.entries?.() ?? [])]
      .map(([actorUuid, state]) => [actorUuid, { ...state }])
  );
}

async function processDueAuras(worldTime = getWorldTime()) {
  if (!game.user?.isActiveGM || !indexedAuras.size) return;
  for (const entry of Array.from(indexedAuras.values())) {
    if (!isAuraEntryLive(entry, worldTime)) {
      removeIndexedAuraEntry(entry);
      continue;
    }
    if (![...entry.states.values()].some(state => state.inside && state.nextAllowedAt <= worldTime)) continue;
    await evaluateAuraEntry(entry, { reason: "time", worldTime });
  }
}

async function evaluateAllIndexedAuras(reason = "refresh") {
  if (!game.user?.isActiveGM || !indexedAuras.size) return;
  const now = getWorldTime();
  for (const entry of Array.from(indexedAuras.values())) {
    if (!isAuraEntryLive(entry, now)) {
      removeIndexedAuraEntry(entry);
      continue;
    }
    await evaluateAuraEntry(entry, { reason, worldTime: now });
  }
}

async function processTokenAuraChange(tokenDocument = null, { sourceMayHaveChanged = false } = {}) {
  if (!game.user?.isActiveGM || !indexedAuras.size) return;
  const token = tokenDocument?.object ?? tokenDocument;
  const tokenUuid = String((tokenDocument?.document ?? tokenDocument)?.uuid ?? "");
  const actorUuid = String(token?.actor?.uuid ?? tokenDocument?.actor?.uuid ?? "");
  const now = getWorldTime();
  for (const entry of Array.from(indexedAuras.values())) {
    if (!isAuraEntryLive(entry, now)) {
      removeIndexedAuraEntry(entry);
      continue;
    }
    const sourceToken = resolveAuraSourceToken(entry);
    const isSource = Boolean(
      tokenUuid && tokenUuid === String((sourceToken?.document ?? sourceToken)?.uuid ?? "")
    ) || Boolean(actorUuid && actorUuid === String(entry.effect?.parent?.uuid ?? ""));
    if (!isSource && !actorUuid) continue;
    if (!isSource && !entry.states.has(actorUuid)) {
      if (!token?.actor || !auraTriggerTargetMatches(entry.effect.parent, entry.condition, token, {
        actorToken: sourceToken
      })) continue;
    }
    await evaluateAuraEntry(entry, {
      reason: isSource && sourceMayHaveChanged ? "sourceMove" : "movement",
      worldTime: now
    });
  }
}

async function evaluateAuraEntry(entry, { reason = "time", worldTime = getWorldTime() } = {}) {
  if (!isAuraEntryLive(entry, worldTime)) return;
  const sourceActor = entry.effect.parent;
  const sourceToken = resolveAuraSourceToken(entry);
  if (!sourceActor || !sourceToken) return;

  const currentTargets = uniqueActorTargets(getAuraGeneratedTargetTokens(sourceActor, entry.condition, {
    actorToken: sourceToken
  }));
  const previouslyInside = new Map(
    [...entry.states.entries()].map(([actorUuid, state]) => [actorUuid, state.inside === true])
  );
  for (const state of entry.states.values()) state.inside = false;

  const dueTargets = [];
  for (const target of currentTargets) {
    const actorUuid = String(target.actor?.uuid ?? "");
    if (!actorUuid) continue;
    let state = entry.states.get(actorUuid);
    const entering = previouslyInside.get(actorUuid) !== true;
    if (!state) {
      state = {
        actorUuid,
        tokenUuid: String((target.token?.document ?? target.token)?.uuid ?? ""),
        inside: true,
        nextAllowedAt: resolveRebuildNextAllowedAt(entry, worldTime)
      };
      entry.states.set(actorUuid, state);
    } else {
      state.inside = true;
      state.tokenUuid = String((target.token?.document ?? target.token)?.uuid ?? state.tokenUuid);
    }

    const createTrigger = reason === "create" && entry.condition.auraTriggerOnCreate !== false;
    const enterTrigger = entering
      && !["create", "rebuild"].includes(reason)
      && entry.condition.auraTriggerOnEnter !== false;
    const repeatTrigger = reason === "time" && state.nextAllowedAt <= worldTime;
    if (state.nextAllowedAt > worldTime) continue;
    if (!createTrigger && !enterTrigger && !repeatTrigger) continue;

    const repeatSeconds = Math.max(1, toInteger(entry.condition.auraRepeatSeconds ?? 6));
    state.nextAllowedAt = worldTime + repeatSeconds;
    dueTargets.push(target);
  }

  entry.rebuilding = false;
  if (dueTargets.length) {
    await executeAbilityTrials({
      abilityFunction: entry.abilityFunction,
      constructs: entry.constructs,
      sourceActor,
      sourceToken,
      targets: dueTargets,
      sourceEffect: entry.effect,
      sourceItemUuid: String(entry.flag?.sourceItemUuid ?? entry.effect.origin ?? ""),
      title: entry.effect.name,
      worldTime,
      operationId: `ability-aura:${String(entry.effect?.uuid ?? entry.effect?.id ?? "")}:${worldTime}`
    });
  }
}

function uniqueActorTargets(tokens = []) {
  const unique = new Map();
  for (const token of tokens) {
    const actorUuid = String(token?.actor?.uuid ?? "");
    if (actorUuid && !unique.has(actorUuid)) unique.set(actorUuid, { actor: token.actor, token });
  }
  return Array.from(unique.values());
}

export function resolveAuraSourceToken(entry) {
  const preferredUuid = String(entry.flag?.targetTokenUuid ?? "").trim();
  const parentActorUuid = String(entry.effect?.parent?.uuid ?? "");
  const tokens = canvas?.tokens?.placeables ?? [];
  if (preferredUuid) {
    return tokens.find(token => (
      String((token?.document ?? token)?.uuid ?? "") === preferredUuid
    )) ?? null;
  }
  return tokens.find(token => String(token?.actor?.uuid ?? "") === parentActorUuid) ?? null;
}

function resolveRebuildNextAllowedAt(entry, worldTime) {
  if (!entry.rebuilding) return worldTime;
  const repeatSeconds = Math.max(1, toInteger(entry.condition.auraRepeatSeconds ?? 6));
  const startedAt = Number(entry.effect?.startTime ?? entry.effect?.start?.time ?? entry.flag?.createdAt) || worldTime;
  const elapsed = Math.max(0, worldTime - startedAt);
  return startedAt + (Math.floor(elapsed / repeatSeconds) + 1) * repeatSeconds;
}

function isAuraEntryLive(entry, worldTime = getWorldTime()) {
  if (indexedAuras.get(String(entry?.key ?? "")) !== entry) return false;
  if (!isUsableActiveEffect(entry?.effect)) return false;
  const duration = Math.max(0, Number(entry.effect?.duration?.value) || 0);
  const startedAt = Number(entry.effect?.startTime ?? entry.effect?.start?.time ?? entry.flag?.createdAt);
  if (duration > 0 && Number.isFinite(startedAt) && worldTime >= startedAt + duration) return false;
  return true;
}

export function isUsableActiveEffect(effect = null) {
  return Boolean(
    effect?.parent
    && !effect.disabled
    && effect.active !== false
    && effect.duration?.expired !== true
    && getActiveApplicationEffectFlag(effect)
  );
}

function getWorldTime() {
  return Number(game.time?.worldTime) || 0;
}

function isAuraTokenPositionUpdate(changes = {}) {
  return ["x", "y", "elevation", "width", "height"].some(key => Object.hasOwn(changes ?? {}, key));
}

function isAuraTokenUpdateRelevant(changes = {}) {
  return isAuraTokenPositionUpdate(changes)
    || ["hidden", "disposition", "movementAction"].some(key => Object.hasOwn(changes ?? {}, key));
}

function isIndexedAuraSourceUpdateRelevant(actor = null, changes = {}) {
  const actorUuid = String(actor?.uuid ?? "");
  if (!actorUuid) return false;
  const sourceEntries = indexedAurasBySourceActorUuid.get(actorUuid);
  if (!sourceEntries?.size) return false;

  const changedPaths = collectChangedActorPaths(changes);
  if (!changedPaths.length) return false;
  for (const entry of sourceEntries) {
    const identifiers = entry.formulaIdentifiers;
    if (
      identifiers?.size > 0
      && changedPaths.some(path => formulaIdentifiersMatchActorPath(identifiers, path))
    ) return true;
  }
  return false;
}

function isAuraTargetActorUpdateRelevant(changes = {}) {
  const systemFlags = changes?.flags?.[SYSTEM_ID];
  return Object.hasOwn(changes ?? {}, `flags.${SYSTEM_ID}.factionBelongs`)
    || Object.hasOwn(changes ?? {}, `flags.${SYSTEM_ID}.factionRelations`)
    || Object.hasOwn(systemFlags ?? {}, "factionBelongs")
    || Object.hasOwn(systemFlags ?? {}, "factionRelations");
}

function collectAuraFormulaIdentifiers(condition = {}) {
  const identifiers = new Set();
  for (const formula of [condition?.auraRadiusMeters, condition?.requiredCount]) {
    for (const match of String(formula ?? "").matchAll(FORMULA_IDENTIFIER_PATTERN)) {
      const identifier = String(match[0] ?? "").replace(/^@/, "").toLowerCase();
      if (identifier) identifiers.add(identifier);
    }
  }
  return identifiers;
}

function collectChangedActorPaths(value = {}, prefix = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return prefix ? [prefix] : [];
  const paths = [];
  for (const [rawKey, child] of Object.entries(value)) {
    const key = String(rawKey ?? "").trim();
    if (!key) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object" && !Array.isArray(child)) {
      const nested = collectChangedActorPaths(child, path);
      if (nested.length) paths.push(...nested);
      else paths.push(path);
    } else {
      paths.push(path);
    }
  }
  return paths.map(path => path.toLowerCase());
}

function formulaIdentifiersMatchActorPath(identifiers, path = "") {
  const normalizedPath = String(path ?? "").toLowerCase();
  if (!normalizedPath) return false;
  if (
    normalizedPath.includes(".skills.")
    || normalizedPath.startsWith("system.skills")
    || normalizedPath.includes(".characteristics.")
    || normalizedPath.startsWith("system.characteristics")
  ) return true;
  const segments = normalizedPath.split(".").filter(Boolean);
  const aliases = new Set(
    segments.filter(segment => !GENERIC_ACTOR_PATH_SEGMENTS.has(segment))
  );
  for (const identifier of identifiers) {
    if (
      normalizedPath === identifier
      || normalizedPath.startsWith(`${identifier}.`)
      || normalizedPath.endsWith(`.${identifier}`)
      || aliases.has(identifier)
    ) return true;
    const identifierSegments = identifier.split(".").filter(Boolean);
    if (identifierSegments.some(segment => aliases.has(segment))) return true;
  }
  return false;
}
