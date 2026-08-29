import { SYSTEM_ID } from "../constants.mjs";
import { getActorActiveCombat } from "../combat/combat-membership.mjs";
import { registerSystemEventObserver } from "../events/dispatcher.mjs";
import { registerQueuedWorldTimeProcessor } from "../time/world-time-queue.mjs";
import { toInteger } from "../utils/numbers.mjs";
import {
  ABILITY_FIXED_FUNCTION_KEYS,
  normalizeTempoSettings
} from "../settings/abilities.mjs";
import { getActorFixedAbilityFunctionEntry } from "./runtime-state.mjs";
import {
  advanceTempo,
  advanceTempoPeriodicState,
  buildTempoEffectChanges,
  getTempoAttackDeltas
} from "./tempo-rules.mjs";
export {
  advanceTempo,
  advanceTempoPeriodicState,
  buildTempoEffectChanges,
  getTempoAttackDeltas
} from "./tempo-rules.mjs";

export const TEMPO_EFFECT_FLAG_KEY = "tempo";
export const TEMPO_ATTACK_OBSERVER_ID = "fallout-maw.fixed.tempo.attackResolved";
export const TEMPO_COMBAT_OBSERVER_ID = "fallout-maw.fixed.tempo.combatLifecycle";

const ACTIVE_EFFECT_SHOW_ICON_ALWAYS = 2;
const DEFAULT_ICON = "icons/svg/clockwork.svg";
const ATTACK_EVENT_KEY = "fallout-maw.weapon.attack.resolved";
const COMBAT_EVENT_KEYS = Object.freeze([
  "fallout-maw.combat.started",
  "fallout-maw.combat.ended",
  "fallout-maw.combat.combatant.added",
  "fallout-maw.combat.combatant.removed"
]);
let runtimeRegistered = false;
let indexesInitialized = false;

/** One effect per Actor UUID. Attack processing never scans unrelated actors. */
const effectsByActorUuid = new Map();
const mutationQueues = new Map();

/** Register the event-driven Tempo runtime once. */
export function registerTempoRuntime() {
  if (runtimeRegistered) return false;
  runtimeRegistered = true;

  registerQueuedWorldTimeProcessor(processTempoWorldTime, { priority: 45 });
  registerSystemEventObserver({
    id: TEMPO_ATTACK_OBSERVER_ID,
    eventKeys: [ATTACK_EVENT_KEY],
    priority: 145,
    observe: observeTempoResolvedAttack
  });
  registerSystemEventObserver({
    id: TEMPO_COMBAT_OBSERVER_ID,
    eventKeys: COMBAT_EVENT_KEYS,
    priority: 145,
    observe: observeTempoCombatLifecycle
  });

  Hooks.on("createActiveEffect", indexTempoEffect);
  Hooks.on("updateActiveEffect", indexTempoEffect);
  Hooks.on("deleteActiveEffect", unindexTempoEffect);
  Hooks.on("createItem", (item, options = {}, userId = "") => {
    void onCreateOrUpdateTempoAbilityItem(item, {}, options, userId);
  });
  Hooks.on("updateItem", (item, changes = {}, options = {}, userId = "") => {
    void onCreateOrUpdateTempoAbilityItem(item, changes, options, userId);
  });
  Hooks.on("deleteItem", (item, options = {}, userId = "") => {
    void onDeleteTempoAbilityItem(item, options, userId);
  });

  const initialize = () => {
    if (!indexesInitialized) rebuildTempoIndex();
    if (isTempoAuthority()) void reconcileActiveTempoCombats();
  };
  if (game.ready) initialize();
  else Hooks.once("ready", initialize);
  return true;
}

async function observeTempoResolvedAttack({ event } = {}) {
  if (!isTempoAuthority()) return;
  if (event?.data?.attackCycleAggregate !== true) return;
  const attackCheckCount = Math.max(0, toInteger(event?.data?.attackCheckCount));
  if (attackCheckCount <= 0) return;
  const attackerSuccess = event?.data?.successfulAttack === true || event?.outcome?.success === true;
  const attackerUuid = String(event?.participants?.source?.actorUuid ?? event?.data?.actorUuid ?? "");
  const successfulDefenderUuids = new Set(uniqueUuids(event?.data?.successfulAttackTargetActorUuids));
  const defenderUuids = uniqueUuids([
    ...(Array.isArray(event?.data?.attackCheckTargetActorUuids) ? event.data.attackCheckTargetActorUuids : []),
    ...(Array.isArray(event?.data?.targetActorUuids) ? event.data.targetActorUuids : [])
  ]);
  const actorRoles = new Map();
  if (attackerUuid) actorRoles.set(attackerUuid, { attackerSuccess, defenderSuccess: null });
  for (const defenderUuid of defenderUuids) {
    const roles = actorRoles.get(defenderUuid) ?? { attackerSuccess: null, defenderSuccess: null };
    roles.defenderSuccess = successfulDefenderUuids.has(defenderUuid);
    actorRoles.set(defenderUuid, roles);
  }

  await Promise.all(Array.from(actorRoles, async ([actorUuid, roles]) => {
    const actor = resolveUuidSync(actorUuid);
    const combat = getActorActiveCombat(actor);
    if (!actor || !combat) return;
    await queueTempoMutation(actor, async current => {
      const effect = current ?? await reconcileTempoActor(actor, { combat, initialize: true });
      const data = getTempoEffectData(effect);
      if (!effect || !data) return null;
      const attackerDelta = roles.attackerSuccess === null
        ? 0
        : getTempoAttackDeltas(roles.attackerSuccess, data.settings).attacker;
      const defenderDelta = roles.defenderSuccess === null
        ? 0
        : getTempoAttackDeltas(roles.defenderSuccess, data.settings).defender;
      const delta = attackerDelta + defenderDelta;
      return delta ? updateTempoEffect(effect, delta) : effect;
    });
  }));
}

async function observeTempoCombatLifecycle({ event } = {}) {
  if (!isTempoAuthority()) return;
  const key = String(event?.key ?? "");
  const combatUuid = String(event?.data?.combatUuid ?? "");
  if (key === "fallout-maw.combat.started") {
    const combat = resolveCombat(combatUuid);
    if (combat) await reconcileTempoCombat(combat, { initialize: true });
    return;
  }
  if (key === "fallout-maw.combat.combatant.added") {
    const combat = resolveCombat(combatUuid);
    const actor = resolveUuidSync(event?.participants?.target?.actorUuid);
    if (combat?.started && actor) {
      await queueTempoMutation(actor, () => reconcileTempoActor(actor, { combat, initialize: true }));
    }
    return;
  }
  if (key === "fallout-maw.combat.combatant.removed") {
    const actor = resolveUuidSync(event?.participants?.target?.actorUuid);
    if (actor) {
      await queueTempoMutation(actor, () => reconcileTempoActor(actor, {
        combat: getActorActiveCombat(actor),
        initialize: false
      }));
    }
    return;
  }
  if (key === "fallout-maw.combat.ended") await cleanupEndedTempoCombat(combatUuid);
}

async function processTempoWorldTime(worldTime) {
  if (!isTempoAuthority()) return;
  const now = finiteNumber(worldTime, getWorldTime());
  for (const [actorUuid, cachedEffect] of Array.from(effectsByActorUuid)) {
    const effect = resolveCurrentEffect(cachedEffect);
    const data = getTempoEffectData(effect);
    const actor = effect?.parent ?? resolveUuidSync(actorUuid);
    if (!effect || !data || !actor) {
      effectsByActorUuid.delete(actorUuid);
      continue;
    }
    if (!getActorActiveCombat(actor)) {
      await queueTempoMutation(actor, current => deleteTempoEffect(current));
      continue;
    }
    // At the cap no write is needed. The elapsed schedule is folded into the
    // next real mutation, so missed intervals can never be banked.
    if (data.tempo >= data.settings.maxTempo) continue;
    const periodic = advanceTempoPeriodicState(data, now, data.settings);
    if (periodic.elapsedIntervals > 0) {
      await queueTempoMutation(actor, current => updateTempoEffect(current, 0, { now }));
    }
  }
}

async function reconcileActiveTempoCombats() {
  const activeCombats = Array.from(game.combats ?? []).filter(combat => combat?.started);
  const activeActorUuids = new Set();
  for (const combat of activeCombats) {
    for (const combatant of combat.combatants ?? []) {
      if (combatant?.actor?.uuid) activeActorUuids.add(combatant.actor.uuid);
    }
    await reconcileTempoCombat(combat, { initialize: true });
  }
  for (const [actorUuid, effect] of Array.from(effectsByActorUuid)) {
    if (!activeActorUuids.has(actorUuid)) {
      const actor = resolveCurrentEffect(effect)?.parent ?? resolveUuidSync(actorUuid);
      if (actor) await queueTempoMutation(actor, current => deleteTempoEffect(current));
    }
  }
}

async function reconcileTempoCombat(combat, { initialize = false } = {}) {
  if (!combat?.started) return;
  const seen = new Set();
  for (const combatant of combat.combatants ?? []) {
    const actor = combatant?.actor;
    if (!actor?.uuid || seen.has(actor.uuid)) continue;
    seen.add(actor.uuid);
    await queueTempoMutation(actor, () => reconcileTempoActor(actor, { combat, initialize }));
  }
}

async function reconcileTempoActor(actor, { combat = getActorActiveCombat(actor), initialize = false } = {}) {
  if (!actor?.uuid) return null;
  const entry = getActorFixedAbilityFunctionEntry(actor, ABILITY_FIXED_FUNCTION_KEYS.tempo);
  const existing = getTempoEffectForActor(actor);
  if (!combat?.started || !entry) {
    if (existing) await deleteTempoEffect(existing);
    return null;
  }

  const settings = normalizeTempoSettings(entry.abilityFunction.fixedSettings);
  if (!existing) {
    if (!initialize) return null;
    const now = getWorldTime();
    const tempo = advanceTempo(0, settings.automaticGain, settings.maxTempo);
    const [created] = await actor.createEmbeddedDocuments("ActiveEffect", [buildTempoEffectData({
      actor,
      combat,
      entry,
      settings,
      tempo,
      nextGainAt: now + settings.automaticIntervalSeconds,
      createdAt: now
    })], { animate: false });
    if (created) indexTempoEffect(created);
    return created ?? null;
  }

  const data = getTempoEffectData(existing);
  if (!data) return null;
  const tempo = advanceTempo(data.tempo, 0, settings.maxTempo);
  const nextGainAt = finiteNumber(data.nextGainAt, getWorldTime() + settings.automaticIntervalSeconds);
  const update = buildTempoEffectUpdate({
    effect: existing,
    combat,
    entry,
    settings,
    tempo,
    nextGainAt,
    createdAt: data.createdAt
  });
  if (tempo !== data.tempo || !tempoEffectConfigurationMatches(existing, data, entry, settings, combat)) {
    await existing.update(update, { falloutMawTempoRuntime: true });
  }
  return resolveCurrentEffect(existing);
}

async function updateTempoEffect(effect, delta = 0, { now = getWorldTime() } = {}) {
  const current = resolveCurrentEffect(effect);
  const data = getTempoEffectData(current);
  const actor = current?.parent;
  const combat = getActorActiveCombat(actor);
  if (!current || !data || !actor || !combat) {
    if (current) await deleteTempoEffect(current);
    return null;
  }
  const periodic = advanceTempoPeriodicState(data, now, data.settings);
  const tempo = advanceTempo(periodic.tempo, delta, data.settings.maxTempo);
  if (
    tempo === data.tempo
    && periodic.nextGainAt === data.nextGainAt
  ) return current;
  await current.update({
    name: buildTempoEffectName(data.abilityName, tempo),
    "system.changes": buildTempoEffectChanges(tempo, data.settings),
    [`flags.${SYSTEM_ID}.${TEMPO_EFFECT_FLAG_KEY}.tempo`]: tempo,
    [`flags.${SYSTEM_ID}.${TEMPO_EFFECT_FLAG_KEY}.nextGainAt`]: periodic.nextGainAt,
    [`flags.${SYSTEM_ID}.${TEMPO_EFFECT_FLAG_KEY}.combatUuid`]: String(combat.uuid ?? "")
  }, { falloutMawTempoRuntime: true });
  return resolveCurrentEffect(current);
}

async function cleanupEndedTempoCombat(combatUuid = "") {
  for (const [actorUuid, cachedEffect] of Array.from(effectsByActorUuid)) {
    const effect = resolveCurrentEffect(cachedEffect);
    const data = getTempoEffectData(effect);
    if (!effect || !data) {
      effectsByActorUuid.delete(actorUuid);
      continue;
    }
    if (combatUuid && data.combatUuid !== combatUuid) continue;
    const actor = effect.parent;
    const remainingCombat = getActorActiveCombat(actor);
    await queueTempoMutation(actor, current => remainingCombat
      ? reconcileTempoActor(actor, { combat: remainingCombat, initialize: false })
      : deleteTempoEffect(current));
  }
}

async function onCreateOrUpdateTempoAbilityItem(item, _changes = {}, _options = {}, _userId = "") {
  if (!isTempoAuthority() || item?.type !== "ability" || !item?.parent?.uuid) return;
  const actor = item.parent;
  const combat = getActorActiveCombat(actor);
  await queueTempoMutation(actor, () => reconcileTempoActor(actor, {
    combat,
    initialize: Boolean(combat)
  }));
}

async function onDeleteTempoAbilityItem(item, _options = {}, _userId = "") {
  if (!isTempoAuthority() || item?.type !== "ability" || !item?.parent?.uuid) return;
  queueMicrotask(() => {
    const actor = item.parent;
    void queueTempoMutation(actor, () => reconcileTempoActor(actor, {
      combat: getActorActiveCombat(actor),
      initialize: false
    }));
  });
}

function buildTempoEffectData({ actor, combat, entry, settings, tempo, nextGainAt, createdAt }) {
  const data = buildTempoFlagData({ actor, combat, entry, settings, tempo, nextGainAt, createdAt });
  return {
    type: "base",
    name: buildTempoEffectName(data.abilityName, tempo),
    img: entry.abilityItem.img || DEFAULT_ICON,
    origin: entry.abilityItem.uuid ?? actor.uuid,
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    system: { changes: buildTempoEffectChanges(tempo, settings) },
    flags: {
      [SYSTEM_ID]: {
        kind: "temporary",
        [TEMPO_EFFECT_FLAG_KEY]: data
      }
    }
  };
}

function buildTempoEffectUpdate({ effect, combat, entry, settings, tempo, nextGainAt, createdAt }) {
  const data = buildTempoFlagData({
    actor: effect.parent,
    combat,
    entry,
    settings,
    tempo,
    nextGainAt,
    createdAt
  });
  return {
    name: buildTempoEffectName(data.abilityName, tempo),
    img: entry.abilityItem.img || DEFAULT_ICON,
    origin: entry.abilityItem.uuid ?? effect.parent?.uuid ?? "",
    "system.changes": buildTempoEffectChanges(tempo, settings),
    [`flags.${SYSTEM_ID}.${TEMPO_EFFECT_FLAG_KEY}`]: data
  };
}

function buildTempoFlagData({ actor, combat, entry, settings, tempo, nextGainAt, createdAt }) {
  return {
    actorUuid: String(actor?.uuid ?? ""),
    combatUuid: String(combat?.uuid ?? ""),
    abilityItemId: String(entry.abilityItem.id ?? ""),
    abilityItemUuid: String(entry.abilityItem.uuid ?? ""),
    abilityName: String(entry.abilityItem.name ?? "Темп"),
    functionId: String(entry.abilityFunction.id ?? ""),
    fixedKey: ABILITY_FIXED_FUNCTION_KEYS.tempo,
    createdAt: finiteNumber(createdAt, getWorldTime()),
    nextGainAt: finiteNumber(nextGainAt),
    tempo: advanceTempo(tempo, 0, settings.maxTempo),
    settings: normalizeTempoSettings(settings)
  };
}

export function getTempoEffectData(effect = null) {
  const raw = effect?.getFlag?.(SYSTEM_ID, TEMPO_EFFECT_FLAG_KEY)
    ?? effect?.flags?.[SYSTEM_ID]?.[TEMPO_EFFECT_FLAG_KEY];
  if (raw?.fixedKey !== ABILITY_FIXED_FUNCTION_KEYS.tempo || !raw?.actorUuid) return null;
  const settings = normalizeTempoSettings(raw.settings);
  return {
    ...cloneData(raw),
    actorUuid: String(raw.actorUuid),
    combatUuid: String(raw.combatUuid ?? ""),
    abilityItemId: String(raw.abilityItemId ?? ""),
    abilityItemUuid: String(raw.abilityItemUuid ?? ""),
    abilityName: String(raw.abilityName ?? "Темп"),
    functionId: String(raw.functionId ?? ""),
    fixedKey: ABILITY_FIXED_FUNCTION_KEYS.tempo,
    createdAt: finiteNumber(raw.createdAt),
    nextGainAt: finiteNumber(raw.nextGainAt),
    tempo: advanceTempo(raw.tempo, 0, settings.maxTempo),
    settings
  };
}

function getTempoEffectForActor(actor = null) {
  if (!actor?.uuid) return null;
  const cached = resolveCurrentEffect(effectsByActorUuid.get(actor.uuid));
  if (
    cached
    && cached.parent?.effects?.has?.(cached.id) !== false
    && getTempoEffectData(cached)
  ) return cached;
  const effect = Array.from(actor.effects ?? []).find(candidate => Boolean(getTempoEffectData(candidate))) ?? null;
  if (effect) indexTempoEffect(effect);
  else effectsByActorUuid.delete(actor.uuid);
  return effect;
}

function indexTempoEffect(effect = null) {
  const data = getTempoEffectData(effect);
  if (!effect?.uuid || !data) return false;
  effectsByActorUuid.set(data.actorUuid, effect);
  return true;
}

function unindexTempoEffect(effect = null) {
  const data = getTempoEffectData(effect);
  if (!data) return false;
  const cached = effectsByActorUuid.get(data.actorUuid);
  if (!cached || cached.uuid === effect.uuid) effectsByActorUuid.delete(data.actorUuid);
  return true;
}

function rebuildTempoIndex() {
  effectsByActorUuid.clear();
  const actors = new Map();
  for (const actor of game.actors ?? []) if (actor?.uuid) actors.set(actor.uuid, actor);
  for (const combat of game.combats ?? []) {
    for (const combatant of combat?.combatants ?? []) {
      if (combatant?.actor?.uuid) actors.set(combatant.actor.uuid, combatant.actor);
    }
  }
  for (const actor of actors.values()) {
    for (const effect of actor.effects ?? []) indexTempoEffect(effect);
  }
  indexesInitialized = true;
}

function queueTempoMutation(actor, operation) {
  const actorUuid = String(actor?.uuid ?? "");
  if (!actorUuid || typeof operation !== "function") return Promise.resolve(null);
  const previous = mutationQueues.get(actorUuid) ?? Promise.resolve();
  const queued = previous
    .catch(() => undefined)
    .then(() => operation(getTempoEffectForActor(actor)));
  mutationQueues.set(actorUuid, queued);
  void queued.then(() => {
    if (mutationQueues.get(actorUuid) === queued) mutationQueues.delete(actorUuid);
  }, () => {
    if (mutationQueues.get(actorUuid) === queued) mutationQueues.delete(actorUuid);
  });
  return queued;
}

async function deleteTempoEffect(effect = null) {
  const current = resolveCurrentEffect(effect);
  if (!current) return false;
  unindexTempoEffect(current);
  if (current.parent?.effects?.has?.(current.id) === false) return false;
  await current.delete({ falloutMawTempoRuntime: true }).catch(error => {
    console.error(`${SYSTEM_ID} | Failed to delete Tempo effect`, error);
  });
  return true;
}

function tempoEffectConfigurationMatches(effect, data, entry, settings, combat) {
  return data.combatUuid === String(combat?.uuid ?? "")
    && data.abilityItemId === String(entry.abilityItem.id ?? "")
    && data.functionId === String(entry.abilityFunction.id ?? "")
    && data.abilityName === String(entry.abilityItem.name ?? "Темп")
    && String(effect.img ?? "") === String(entry.abilityItem.img || DEFAULT_ICON)
    && JSON.stringify(data.settings) === JSON.stringify(settings);
}

function buildTempoEffectName(abilityName = "Темп", tempo = 0) {
  return `${String(abilityName || "Темп")} ×${Math.max(0, toInteger(tempo))}`;
}

function resolveCombat(uuid = "") {
  const combatUuid = String(uuid ?? "");
  return resolveUuidSync(combatUuid)
    ?? Array.from(game.combats ?? []).find(combat => combat?.uuid === combatUuid)
    ?? null;
}

function resolveCurrentEffect(effect = null) {
  if (!effect?.uuid) return null;
  return resolveUuidSync(effect.uuid) ?? effect;
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

function uniqueUuids(values = []) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map(value => String(value ?? "").trim())
    .filter(Boolean)));
}

function cloneData(value) {
  return globalThis.foundry?.utils?.deepClone?.(value)
    ?? JSON.parse(JSON.stringify(value ?? {}));
}

function isTempoAuthority() {
  return Boolean(
    game.user?.isActiveGM
    || (game.user?.id && game.users?.activeGM?.id === game.user.id)
  );
}
