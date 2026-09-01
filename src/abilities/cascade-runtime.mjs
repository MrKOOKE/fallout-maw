import { SYSTEM_ID } from "../constants.mjs";
import { getActorActiveCombat } from "../combat/combat-membership.mjs";
import { registerSystemEventObserver } from "../events/dispatcher.mjs";
import {
  ABILITY_FIXED_FUNCTION_KEYS,
  ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY,
  normalizeAbilityFunctions
} from "../settings/abilities.mjs";
import {
  commitCascadeAttackSnapshot,
  createCascadeAttackSnapshot,
  createCascadeCombatState,
  normalizeCascadeSettings
} from "./cascade.mjs";

export const CASCADE_COMBAT_OBSERVER_ID = "fallout-maw.fixed.cascade.combatLifecycle";
export const CASCADE_ATTACK_OBSERVER_ID = "fallout-maw.fixed.cascade.attackResolved";

const CASCADE_RUNTIME_OPTION = "falloutMawCascadeRuntime";
const WEAPON_ATTACK_RESOLVED_EVENT_KEY = "fallout-maw.weapon.attack.resolved";
const COMBAT_EVENT_KEYS = Object.freeze([
  "fallout-maw.combat.started",
  "fallout-maw.combat.ended",
  "fallout-maw.combat.combatant.added",
  "fallout-maw.combat.combatant.removed"
]);
const ATTACK_SNAPSHOT_TTL_MS = 5 * 60 * 1000;
const MAX_ATTACK_SNAPSHOTS = 512;

let runtimeRegistered = false;
let indexInitialized = false;

/** Only items which currently expose a Cascade function are retained. */
const activeCascadeItems = new Map();
const attackSnapshots = new Map();
const mutationQueues = new Map();

export function registerCascadeRuntime() {
  if (runtimeRegistered) return false;
  runtimeRegistered = true;

  registerSystemEventObserver({
    id: CASCADE_COMBAT_OBSERVER_ID,
    eventKeys: COMBAT_EVENT_KEYS,
    priority: 150,
    observe: observeCascadeCombatLifecycle
  });
  registerSystemEventObserver({
    id: CASCADE_ATTACK_OBSERVER_ID,
    eventKeys: [WEAPON_ATTACK_RESOLVED_EVENT_KEY],
    priority: 150,
    observe: observeCascadeResolvedAttack
  });
  Hooks.on("createItem", item => {
    void reconcileCascadeAbilityItem(item);
  });
  Hooks.on("updateItem", (item, _changes = {}, options = {}) => {
    if (options?.[CASCADE_RUNTIME_OPTION]) return;
    void reconcileCascadeAbilityItem(item);
  });
  Hooks.on("deleteItem", item => {
    activeCascadeItems.delete(String(item?.uuid ?? ""));
    clearCascadeAttackSnapshots({ abilityItemUuid: item?.uuid });
  });
  Hooks.on("deleteActor", actor => {
    unindexCascadeActor(actor);
  });
  Hooks.on("deleteCombat", combat => {
    void cleanupCascadeCombat(String(combat?.uuid ?? ""));
  });

  const initialize = async () => {
    if (indexInitialized || !isCascadeLifecycleAuthority()) return;
    indexInitialized = true;
    await reconcileActiveCascadeCombats();
  };
  if (game.ready) void initialize();
  else Hooks.once("ready", () => void initialize());
  return true;
}

/**
 * Return the immutable snapshot for one ability function and attack cycle.
 * fixed-functions calls this while collecting weapon modifiers, so every
 * check in a multi-check attack receives the exact same multiplier.
 */
export function getOrCreateCascadeAttackSnapshot({
  actor = null,
  abilityItem = null,
  abilityFunction = null,
  state = {},
  weaponIdentity = "",
  attackId = "",
  combatUuid = "",
  worldTime = getWorldTime(),
  settings = null
} = {}) {
  const normalizedAttackId = String(attackId ?? "").trim();
  const normalizedCombatUuid = String(
    combatUuid || getActorActiveCombat(actor ?? abilityItem?.parent)?.uuid || ""
  ).trim();
  const stateKey = getFixedFunctionStateKey(abilityFunction);
  const cacheKey = buildAttackSnapshotKey({
    attackId: normalizedAttackId,
    abilityItemUuid: abilityItem?.uuid,
    stateKey
  });
  pruneAttackSnapshots();
  const cached = cacheKey ? attackSnapshots.get(cacheKey) : null;
  if (
    cached
    && cached.snapshot.combatUuid === normalizedCombatUuid
    && cached.snapshot.weaponIdentity === String(weaponIdentity ?? "").trim()
  ) return cached.snapshot;

  const normalizedSettings = settings ?? normalizeCascadeSettings(abilityFunction?.fixedSettings);
  const snapshot = createCascadeAttackSnapshot({
    state,
    weaponIdentity,
    attackId: normalizedAttackId,
    combatUuid: normalizedCombatUuid,
    worldTime,
    settings: normalizedSettings
  });
  if (cacheKey && snapshot.active) {
    attackSnapshots.set(cacheKey, {
      abilityItemUuid: String(abilityItem?.uuid ?? ""),
      actorUuid: String((actor ?? abilityItem?.parent)?.uuid ?? ""),
      combatUuid: normalizedCombatUuid,
      attackId: normalizedAttackId,
      stateKey,
      createdAt: Date.now(),
      snapshot
    });
    pruneAttackSnapshots();
  }
  return snapshot;
}

/** Commit every Cascade function once when the whole attack cycle resolves. */
export async function commitCascadeResolvedAttack(context = {}) {
  if (context?.attackCheckAggregate !== true) return false;
  if (Math.max(0, Number(context?.attackCheckCount) || 0) <= 0) return false;
  const attackId = String(context?.attackId ?? context?.weaponAttackId ?? "").trim();
  const actorUuid = String(context?.attackerUuid ?? context?.actorUuid ?? context?.actor?.uuid ?? "").trim();
  const actor = context?.actor ?? (actorUuid ? resolveUuidSync(actorUuid) : null);
  const weaponUuid = String(context?.weaponUuid ?? context?.weapon?.uuid ?? "").trim();
  const weapon = context?.weapon ?? resolveUuidSync(weaponUuid);
  const weaponIdentity = String(context?.weaponName ?? weapon?.name ?? "").trim();
  if (!actor?.uuid || !weaponIdentity || !canCommitCascadeActor(actor)) {
    clearCascadeAttackSnapshots({ attackId });
    return false;
  }

  const combat = getActorActiveCombat(actor);
  if (!combat?.started) {
    clearCascadeAttackSnapshots({ attackId });
    return false;
  }
  const itemUuids = getCascadeItemUuidsForActor(actor);
  const results = await Promise.all(itemUuids.map(itemUuid => queueCascadeMutation(itemUuid, async () => {
    const abilityItem = resolveUuidSync(itemUuid)
      ?? actor.items?.find?.(item => String(item?.uuid ?? "") === itemUuid)
      ?? null;
    if (abilityItem?.type !== "ability") return false;
    const functions = getCascadeFunctions(abilityItem);
    if (!functions.length) return false;
    const state = cloneFixedAbilityState(abilityItem);
    let changed = false;
    for (const abilityFunction of functions) {
      const stateKey = getFixedFunctionStateKey(abilityFunction);
      const cacheKey = buildAttackSnapshotKey({ attackId, abilityItemUuid: itemUuid, stateKey });
      const cachedCandidate = cacheKey ? attackSnapshots.get(cacheKey)?.snapshot : null;
      const cached = (
        cachedCandidate?.combatUuid === String(combat.uuid ?? "")
        && cachedCandidate?.weaponIdentity === weaponIdentity
      ) ? cachedCandidate : null;
      const snapshot = cached ?? getOrCreateCascadeAttackSnapshot({
        actor,
        abilityItem,
        abilityFunction,
        state: state[stateKey],
        weaponIdentity,
        attackId,
        combatUuid: combat.uuid,
        worldTime: getWorldTime()
      });
      const transition = commitCascadeAttackSnapshot(state[stateKey], snapshot);
      if (!transition.changed) continue;
      state[stateKey] = {
        fixedKey: ABILITY_FIXED_FUNCTION_KEYS.cascade,
        ...transition.nextState
      };
      changed = true;
    }
    if (changed) await writeFixedAbilityState(abilityItem, state);
    return changed;
  })));
  clearCascadeAttackSnapshots({ attackId });
  return results.some(Boolean);
}

async function observeCascadeResolvedAttack({ event } = {}) {
  if (String(event?.key ?? "") !== WEAPON_ATTACK_RESOLVED_EVENT_KEY) return false;
  // Cascade is committed when the projectile is launched. The later area
  // impact belongs to that same attack and must not advance/reset it again.
  if (event?.data?.deferredImpactResolution === true) return false;
  return commitCascadeResolvedAttack({
    attackCheckAggregate: event?.data?.attackCycleAggregate === true,
    attackCheckCount: event?.data?.attackCheckCount,
    attackId: event?.data?.attackId,
    actorUuid: event?.participants?.source?.actorUuid ?? event?.data?.actorUuid,
    attackerUuid: event?.participants?.source?.actorUuid ?? event?.data?.actorUuid,
    weaponUuid: event?.data?.weaponUuid,
    weaponName: event?.data?.weaponName
  });
}

export function clearCascadeAttackSnapshots({
  attackId = "",
  abilityItemUuid = "",
  actorUuid = "",
  combatUuid = ""
} = {}) {
  const normalized = {
    attackId: String(attackId ?? ""),
    abilityItemUuid: String(abilityItemUuid ?? ""),
    actorUuid: String(actorUuid ?? ""),
    combatUuid: String(combatUuid ?? "")
  };
  let deleted = 0;
  for (const [key, entry] of attackSnapshots) {
    if (normalized.attackId && entry.attackId !== normalized.attackId) continue;
    if (normalized.abilityItemUuid && entry.abilityItemUuid !== normalized.abilityItemUuid) continue;
    if (normalized.actorUuid && entry.actorUuid !== normalized.actorUuid) continue;
    if (normalized.combatUuid && entry.combatUuid !== normalized.combatUuid) continue;
    attackSnapshots.delete(key);
    deleted += 1;
  }
  return deleted;
}

async function observeCascadeCombatLifecycle({ event } = {}) {
  if (!isCascadeLifecycleAuthority()) return;
  const key = String(event?.key ?? "");
  const combatUuid = String(event?.data?.combatUuid ?? "");
  if (key === "fallout-maw.combat.started") {
    const combat = resolveUuidSync(combatUuid);
    if (combat) await reconcileCascadeCombat(combat);
    return;
  }
  if (key === "fallout-maw.combat.combatant.added") {
    const combat = resolveUuidSync(combatUuid);
    const actor = resolveUuidSync(event?.participants?.target?.actorUuid);
    if (combat?.started && actor) await reconcileCascadeActor(actor, combat);
    return;
  }
  if (key === "fallout-maw.combat.combatant.removed") {
    const actor = resolveUuidSync(event?.participants?.target?.actorUuid);
    if (actor) await reconcileCascadeActor(actor, getActorActiveCombat(actor), { endedCombatUuid: combatUuid });
    return;
  }
  if (key === "fallout-maw.combat.ended") await cleanupCascadeCombat(combatUuid);
}

async function reconcileActiveCascadeCombats() {
  activeCascadeItems.clear();
  for (const combat of game.combats ?? []) {
    if (combat?.started) await reconcileCascadeCombat(combat);
  }
}

async function reconcileCascadeCombat(combat) {
  if (!combat?.started) return;
  const seen = new Set();
  for (const combatant of combat.combatants ?? []) {
    const actor = combatant?.actor;
    if (!actor?.uuid || seen.has(actor.uuid)) continue;
    seen.add(actor.uuid);
    await reconcileCascadeActor(actor, combat);
  }
}

async function reconcileCascadeActor(actor, combat = getActorActiveCombat(actor), { endedCombatUuid = "" } = {}) {
  if (!isCascadeLifecycleAuthority() || !actor?.uuid) return;
  const liveItemUuids = new Set();
  for (const abilityItem of actor.items?.filter(item => item.type === "ability") ?? []) {
    if (await reconcileCascadeAbilityItem(abilityItem, combat, { endedCombatUuid })) {
      liveItemUuids.add(String(abilityItem.uuid ?? ""));
    }
  }
  for (const [itemUuid, item] of Array.from(activeCascadeItems)) {
    if (item?.parent?.uuid === actor.uuid && !liveItemUuids.has(itemUuid)) activeCascadeItems.delete(itemUuid);
  }
  clearCascadeAttackSnapshots({ actorUuid: actor.uuid, combatUuid: endedCombatUuid });
}

async function reconcileCascadeAbilityItem(
  abilityItem,
  combat = getActorActiveCombat(abilityItem?.parent),
  { endedCombatUuid = "" } = {}
) {
  if (!isCascadeLifecycleAuthority() || abilityItem?.type !== "ability" || !abilityItem?.parent) return false;
  const itemUuid = String(abilityItem.uuid ?? "");
  const functions = getCascadeFunctions(abilityItem);
  const validStateKeys = new Set(functions.map(getFixedFunctionStateKey));
  const combatUuid = String(combat?.started ? combat.uuid ?? "" : "");
  const state = cloneFixedAbilityState(abilityItem);
  let changed = false;

  for (const [stateKey, functionState] of Object.entries(state)) {
    const isStoredCascade = functionState?.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.cascade;
    const belongsToEndedCombat = endedCombatUuid
      && String(functionState?.combatUuid ?? "") === endedCombatUuid;
    if (isStoredCascade && (!combatUuid || !validStateKeys.has(stateKey) || belongsToEndedCombat)) {
      delete state[stateKey];
      changed = true;
    }
  }

  if (!combatUuid || !functions.length) {
    activeCascadeItems.delete(itemUuid);
    clearCascadeAttackSnapshots({ abilityItemUuid: itemUuid });
    if (changed) await writeFixedAbilityState(abilityItem, state);
    return false;
  }

  for (const abilityFunction of functions) {
    const stateKey = getFixedFunctionStateKey(abilityFunction);
    const settings = normalizeCascadeSettings(abilityFunction.fixedSettings);
    const functionState = state[stateKey];
    if (String(functionState?.combatUuid ?? "") !== combatUuid) {
      state[stateKey] = buildInitialCascadeFunctionState(abilityFunction, combat, settings, getWorldTime());
      changed = true;
      continue;
    }
    const maxStacks = getCascadeMaxStacks(settings);
    const stacks = Math.max(0, Math.min(maxStacks, Number(functionState.stacks) || 0));
    const nextGainAt = finiteNumber(
      functionState.nextGainAt,
      getWorldTime() + getCascadeIntervalSeconds(settings)
    );
    if (
      stacks !== Number(functionState.stacks)
      || nextGainAt !== Number(functionState.nextGainAt)
      || functionState.fixedKey !== ABILITY_FIXED_FUNCTION_KEYS.cascade
    ) {
      state[stateKey] = {
        ...functionState,
        fixedKey: ABILITY_FIXED_FUNCTION_KEYS.cascade,
        stacks,
        nextGainAt
      };
      changed = true;
    }
  }
  activeCascadeItems.set(itemUuid, abilityItem);
  if (changed) await writeFixedAbilityState(abilityItem, state);
  return true;
}

async function cleanupCascadeCombat(combatUuid = "") {
  if (!isCascadeLifecycleAuthority()) return;
  clearCascadeAttackSnapshots({ combatUuid });
  for (const [itemUuid] of Array.from(activeCascadeItems)) {
    const abilityItem = resolveUuidSync(itemUuid);
    if (abilityItem?.type !== "ability") {
      activeCascadeItems.delete(itemUuid);
      continue;
    }
    const state = cloneFixedAbilityState(abilityItem);
    let changed = false;
    for (const [stateKey, functionState] of Object.entries(state)) {
      if (
        functionState?.fixedKey !== ABILITY_FIXED_FUNCTION_KEYS.cascade
        || !functionState?.combatUuid
        || (combatUuid && String(functionState.combatUuid) !== combatUuid)
      ) continue;
      delete state[stateKey];
      changed = true;
    }
    activeCascadeItems.delete(itemUuid);
    if (changed) await writeFixedAbilityState(abilityItem, state);
    const remainingCombat = getActorActiveCombat(abilityItem.parent);
    if (remainingCombat?.started && String(remainingCombat.uuid ?? "") !== combatUuid) {
      await reconcileCascadeAbilityItem(abilityItem, remainingCombat);
    }
  }
}

function buildInitialCascadeFunctionState(abilityFunction, combat, settings, worldTime) {
  return {
    fixedKey: ABILITY_FIXED_FUNCTION_KEYS.cascade,
    ...createCascadeCombatState({
      combatUuid: combat?.uuid,
      worldTime,
      ...normalizeCascadeSettings(settings)
    })
  };
}

function getCascadeFunctions(abilityItem) {
  return normalizeAbilityFunctions(abilityItem?.system?.functions ?? [])
    .filter(entry => entry.enabled !== false)
    .filter(entry => entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.cascade);
}

function getCascadeItemUuidsForActor(actor) {
  const indexed = [];
  for (const [itemUuid, item] of activeCascadeItems) {
    if (item?.parent?.uuid === actor?.uuid) indexed.push(itemUuid);
  }
  if (indexed.length) return indexed;
  return (actor?.items?.filter(item => item.type === "ability" && getCascadeFunctions(item).length) ?? [])
    .map(item => String(item.uuid ?? ""))
    .filter(Boolean);
}

function cloneFixedAbilityState(abilityItem) {
  const stored = abilityItem?.getFlag?.(SYSTEM_ID, ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY)
    ?? abilityItem?.flags?.[SYSTEM_ID]?.[ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY];
  const value = stored && typeof stored === "object" ? stored : {};
  return globalThis.foundry?.utils?.deepClone?.(value)
    ?? JSON.parse(JSON.stringify(value));
}

async function writeFixedAbilityState(abilityItem, state) {
  await abilityItem.update({
    flags: {
      [SYSTEM_ID]: {
        [ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY]: Object.keys(state).length ? state : null
      }
    }
  }, { [CASCADE_RUNTIME_OPTION]: true });
}

function getFixedFunctionStateKey(abilityFunction = {}) {
  return [String(abilityFunction?.id ?? ""), String(abilityFunction?.fixedKey ?? "")]
    .filter(Boolean)
    .join(":");
}

function buildAttackSnapshotKey({ attackId = "", abilityItemUuid = "", stateKey = "" } = {}) {
  const parts = [attackId, abilityItemUuid, stateKey].map(value => String(value ?? "").trim());
  return parts.every(Boolean) ? parts.join("|") : "";
}

function pruneAttackSnapshots() {
  const cutoff = Date.now() - ATTACK_SNAPSHOT_TTL_MS;
  for (const [key, entry] of attackSnapshots) {
    if (entry.createdAt < cutoff) attackSnapshots.delete(key);
  }
  while (attackSnapshots.size > MAX_ATTACK_SNAPSHOTS) {
    const oldestKey = attackSnapshots.keys().next().value;
    if (!oldestKey) break;
    attackSnapshots.delete(oldestKey);
  }
}

function queueCascadeMutation(itemUuid, operation) {
  const key = String(itemUuid ?? "");
  if (!key || typeof operation !== "function") return Promise.resolve(false);
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  const queued = previous.catch(() => undefined).then(operation);
  mutationQueues.set(key, queued);
  void queued.then(() => {
    if (mutationQueues.get(key) === queued) mutationQueues.delete(key);
  }, () => {
    if (mutationQueues.get(key) === queued) mutationQueues.delete(key);
  });
  return queued;
}

function unindexCascadeActor(actor) {
  for (const [itemUuid, item] of Array.from(activeCascadeItems)) {
    if (item?.parent?.uuid === actor?.uuid) activeCascadeItems.delete(itemUuid);
  }
  clearCascadeAttackSnapshots({ actorUuid: actor?.uuid });
}

function getCascadeMaxStacks(settings = {}) {
  return Math.max(1, Number(settings?.maxStacks ?? settings?.cascadeMaxStacks) || 4);
}

function getCascadeIntervalSeconds(settings = {}) {
  return Math.max(1, Number(
    settings?.periodicIntervalSeconds
    ?? settings?.intervalSeconds
    ?? settings?.cascadeIntervalSeconds
  ) || 6);
}

function resolveUuidSync(uuid = "") {
  const value = String(uuid ?? "").trim();
  if (!value) return null;
  try {
    return globalThis.fromUuidSync?.(value) ?? null;
  } catch (_error) {
    return null;
  }
}

function getWorldTime() {
  return finiteNumber(game.time?.worldTime);
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number(fallback) || 0;
}

function canCommitCascadeActor(actor) {
  return Boolean(game.user?.isGM || actor?.isOwner);
}

function isCascadeLifecycleAuthority() {
  return Boolean(game.user?.isActiveGM);
}
