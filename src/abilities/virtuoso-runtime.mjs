import { SYSTEM_ID } from "../constants.mjs";
import { getActorActiveCombat } from "../combat/combat-membership.mjs";
import { registerSystemEventObserver } from "../events/dispatcher.mjs";
import {
  ABILITY_FIXED_FUNCTION_KEYS,
  ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY,
  normalizeAbilityFunctions,
  normalizeVirtuosoSettings
} from "../settings/abilities.mjs";
import { registerQueuedWorldTimeProcessor } from "../time/world-time-queue.mjs";
import {
  advanceVirtuosoCascadePeriodicState,
  createVirtuosoCascadeState
} from "./virtuoso.mjs";

export const VIRTUOSO_CASCADE_COMBAT_OBSERVER_ID = "fallout-maw.fixed.virtuoso.combatLifecycle";

const COMBAT_EVENT_KEYS = Object.freeze([
  "fallout-maw.combat.started",
  "fallout-maw.combat.ended",
  "fallout-maw.combat.combatant.added",
  "fallout-maw.combat.combatant.removed"
]);
const VIRTUOSO_CASCADE_RUNTIME_OPTION = "falloutMawVirtuosoCascadeRuntime";
let runtimeRegistered = false;
let indexInitialized = false;

/** Only active Cascade ability items are visited when world time changes. */
const activeCascadeItems = new Map();

export function registerVirtuosoCascadeRuntime() {
  if (runtimeRegistered) return false;
  runtimeRegistered = true;

  registerQueuedWorldTimeProcessor(processVirtuosoCascadeWorldTime, { priority: 46 });
  registerSystemEventObserver({
    id: VIRTUOSO_CASCADE_COMBAT_OBSERVER_ID,
    eventKeys: COMBAT_EVENT_KEYS,
    priority: 150,
    observe: observeVirtuosoCascadeCombatLifecycle
  });

  Hooks.on("createItem", item => {
    void reconcileVirtuosoCascadeAbilityItem(item);
  });
  Hooks.on("updateItem", (item, _changes = {}, options = {}) => {
    if (options?.[VIRTUOSO_CASCADE_RUNTIME_OPTION]) return;
    void reconcileVirtuosoCascadeAbilityItem(item);
  });
  Hooks.on("deleteItem", item => {
    activeCascadeItems.delete(String(item?.uuid ?? ""));
  });
  Hooks.on("deleteActor", actor => {
    unindexVirtuosoCascadeActor(actor);
  });
  Hooks.on("deleteCombat", combat => {
    void cleanupVirtuosoCascadeCombat(String(combat?.uuid ?? ""));
  });

  const initialize = async () => {
    if (indexInitialized || !isVirtuosoCascadeAuthority()) return;
    indexInitialized = true;
    await reconcileActiveVirtuosoCascadeCombats();
  };
  if (game.ready) void initialize();
  else Hooks.once("ready", () => void initialize());
  return true;
}

async function observeVirtuosoCascadeCombatLifecycle({ event } = {}) {
  if (!isVirtuosoCascadeAuthority()) return;
  const key = String(event?.key ?? "");
  const combatUuid = String(event?.data?.combatUuid ?? "");
  if (key === "fallout-maw.combat.started") {
    const combat = resolveUuidSync(combatUuid);
    if (combat) await reconcileVirtuosoCascadeCombat(combat);
    return;
  }
  if (key === "fallout-maw.combat.combatant.added") {
    const combat = resolveUuidSync(combatUuid);
    const actor = resolveUuidSync(event?.participants?.target?.actorUuid);
    if (combat?.started && actor) await reconcileVirtuosoCascadeActor(actor, combat);
    return;
  }
  if (key === "fallout-maw.combat.combatant.removed") {
    const actor = resolveUuidSync(event?.participants?.target?.actorUuid);
    if (actor) await reconcileVirtuosoCascadeActor(actor, getActorActiveCombat(actor), { endedCombatUuid: combatUuid });
    return;
  }
  if (key === "fallout-maw.combat.ended") await cleanupVirtuosoCascadeCombat(combatUuid);
}

async function processVirtuosoCascadeWorldTime(worldTime) {
  if (!isVirtuosoCascadeAuthority()) return;
  const now = finiteNumber(worldTime, getWorldTime());
  for (const [itemUuid] of Array.from(activeCascadeItems)) {
    const abilityItem = resolveUuidSync(itemUuid);
    if (abilityItem?.type !== "ability") {
      activeCascadeItems.delete(itemUuid);
      continue;
    }
    const combat = getActorActiveCombat(abilityItem.parent);
    if (!combat?.started) {
      await reconcileVirtuosoCascadeAbilityItem(abilityItem, null);
      continue;
    }

    const functions = getCascadeFunctions(abilityItem);
    if (!functions.length) {
      await reconcileVirtuosoCascadeAbilityItem(abilityItem, combat);
      continue;
    }
    const state = cloneFixedAbilityState(abilityItem);
    let changed = false;
    for (const abilityFunction of functions) {
      const stateKey = getFixedFunctionStateKey(abilityFunction);
      const functionState = state[stateKey];
      const settings = normalizeVirtuosoSettings(abilityFunction.fixedSettings);
      if (String(functionState?.combatUuid ?? "") !== String(combat.uuid ?? "")) {
        state[stateKey] = buildInitialCascadeFunctionState(abilityFunction, combat, settings, now);
        changed = true;
        continue;
      }
      // At the cap no write is needed. Elapsed intervals are folded into the
      // next attack, so missed gains cannot be banked after a reset.
      if (Number(functionState.stacks) >= settings.cascadeMaxStacks) continue;
      const periodic = advanceVirtuosoCascadePeriodicState(functionState, now, settings);
      if (periodic.gainedStacks <= 0) continue;
      state[stateKey] = {
        ...functionState,
        fixedKey: abilityFunction.fixedKey,
        stacks: periodic.stacks,
        nextGainAt: periodic.nextGainAt
      };
      changed = true;
    }
    if (changed) await writeFixedAbilityState(abilityItem, state);
  }
}

async function reconcileActiveVirtuosoCascadeCombats() {
  activeCascadeItems.clear();
  for (const combat of game.combats ?? []) {
    if (combat?.started) await reconcileVirtuosoCascadeCombat(combat);
  }
}

async function reconcileVirtuosoCascadeCombat(combat) {
  if (!combat?.started) return;
  const seen = new Set();
  for (const combatant of combat.combatants ?? []) {
    const actor = combatant?.actor;
    if (!actor?.uuid || seen.has(actor.uuid)) continue;
    seen.add(actor.uuid);
    await reconcileVirtuosoCascadeActor(actor, combat);
  }
}

async function reconcileVirtuosoCascadeActor(actor, combat = getActorActiveCombat(actor), { endedCombatUuid = "" } = {}) {
  if (!isVirtuosoCascadeAuthority() || !actor?.uuid) return;
  const liveItemUuids = new Set();
  for (const abilityItem of actor.items?.filter(item => item.type === "ability") ?? []) {
    if (await reconcileVirtuosoCascadeAbilityItem(abilityItem, combat, { endedCombatUuid })) {
      liveItemUuids.add(String(abilityItem.uuid ?? ""));
    }
  }
  for (const [itemUuid, item] of Array.from(activeCascadeItems)) {
    if (item?.parent?.uuid === actor.uuid && !liveItemUuids.has(itemUuid)) activeCascadeItems.delete(itemUuid);
  }
}

async function reconcileVirtuosoCascadeAbilityItem(
  abilityItem,
  combat = getActorActiveCombat(abilityItem?.parent),
  { endedCombatUuid = "" } = {}
) {
  if (!isVirtuosoCascadeAuthority() || abilityItem?.type !== "ability" || !abilityItem?.parent) return false;
  const itemUuid = String(abilityItem.uuid ?? "");
  const functions = getCascadeFunctions(abilityItem);
  const validStateKeys = new Set(functions.map(getFixedFunctionStateKey));
  const combatUuid = String(combat?.started ? combat.uuid ?? "" : "");
  const now = getWorldTime();
  const state = cloneFixedAbilityState(abilityItem);
  let changed = false;

  for (const [stateKey, functionState] of Object.entries(state)) {
    const isStoredCascade = functionState?.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.virtuoso
      && Boolean(String(functionState?.combatUuid ?? ""));
    const belongsToEndedCombat = endedCombatUuid
      && String(functionState?.combatUuid ?? "") === endedCombatUuid;
    if (isStoredCascade && (!combatUuid || !validStateKeys.has(stateKey) || belongsToEndedCombat)) {
      delete state[stateKey];
      changed = true;
    }
  }

  if (!combatUuid || !functions.length) {
    activeCascadeItems.delete(itemUuid);
    if (changed) await writeFixedAbilityState(abilityItem, state);
    return false;
  }

  for (const abilityFunction of functions) {
    const stateKey = getFixedFunctionStateKey(abilityFunction);
    const settings = normalizeVirtuosoSettings(abilityFunction.fixedSettings);
    const functionState = state[stateKey];
    if (String(functionState?.combatUuid ?? "") !== combatUuid) {
      state[stateKey] = buildInitialCascadeFunctionState(abilityFunction, combat, settings, now);
      changed = true;
      continue;
    }
    const periodic = advanceVirtuosoCascadePeriodicState(functionState, now, settings);
    if (
      periodic.stacks !== Number(functionState.stacks)
      || periodic.nextGainAt !== Number(functionState.nextGainAt)
      || functionState.fixedKey !== abilityFunction.fixedKey
    ) {
      state[stateKey] = {
        ...functionState,
        fixedKey: abilityFunction.fixedKey,
        stacks: periodic.stacks,
        nextGainAt: periodic.nextGainAt
      };
      changed = true;
    }
  }
  activeCascadeItems.set(itemUuid, abilityItem);
  if (changed) await writeFixedAbilityState(abilityItem, state);
  return true;
}

async function cleanupVirtuosoCascadeCombat(combatUuid = "") {
  if (!isVirtuosoCascadeAuthority()) return;
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
        functionState?.fixedKey !== ABILITY_FIXED_FUNCTION_KEYS.virtuoso
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
      await reconcileVirtuosoCascadeAbilityItem(abilityItem, remainingCombat);
    }
  }
}

function buildInitialCascadeFunctionState(abilityFunction, combat, settings, worldTime) {
  return {
    fixedKey: abilityFunction.fixedKey,
    ...createVirtuosoCascadeState({
      combatUuid: combat?.uuid,
      worldTime,
      cascadeMaxStacks: settings.cascadeMaxStacks,
      cascadeIntervalSeconds: settings.cascadeIntervalSeconds
    })
  };
}

function getCascadeFunctions(abilityItem) {
  return normalizeAbilityFunctions(abilityItem?.system?.functions ?? [])
    .filter(entry => entry.enabled !== false)
    .filter(entry => (
      entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.virtuoso
      && normalizeVirtuosoSettings(entry.fixedSettings).cascadeMaxStacks > 0
    ));
}

function cloneFixedAbilityState(abilityItem) {
  const stored = abilityItem?.getFlag?.(SYSTEM_ID, ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY)
    ?? abilityItem?.flags?.[SYSTEM_ID]?.[ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY];
  return foundry.utils.deepClone(stored && typeof stored === "object" ? stored : {});
}

async function writeFixedAbilityState(abilityItem, state) {
  await abilityItem.update({
    flags: {
      [SYSTEM_ID]: {
        [ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY]: Object.keys(state).length ? state : null
      }
    }
  }, { [VIRTUOSO_CASCADE_RUNTIME_OPTION]: true });
}

function getFixedFunctionStateKey(abilityFunction = {}) {
  return [String(abilityFunction.id ?? ""), String(abilityFunction.fixedKey ?? "")].filter(Boolean).join(":");
}

function unindexVirtuosoCascadeActor(actor) {
  for (const [itemUuid, item] of Array.from(activeCascadeItems)) {
    if (item?.parent?.uuid === actor?.uuid) activeCascadeItems.delete(itemUuid);
  }
}

function resolveUuidSync(uuid = "") {
  if (!uuid || typeof fromUuidSync !== "function") return null;
  try {
    return fromUuidSync(String(uuid)) ?? null;
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

function isVirtuosoCascadeAuthority() {
  return Boolean(game.user?.isActiveGM);
}
