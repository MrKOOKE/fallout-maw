import { SYSTEM_ID } from "../constants.mjs";
import { registerSystemEventObserver } from "../events/dispatcher.mjs";
import { getActorFactionRelation } from "../settings/factions.mjs";
import { getActiveRulesProfile } from "../settings/rules-profiles.mjs";
import { getReverseEffectKey } from "../utils/active-effect-keys.mjs";
import { toInteger } from "../utils/numbers.mjs";

export const TROPHY_COLLECTOR_FIXED_KEY = "trophyCollector";
export const TROPHY_COLLECTOR_MARK_FLAG_KEY = "trophyCollectorMark";
export const TROPHY_COLLECTOR_STUN_FLAG_KEY = "trophyCollectorStun";
export const TROPHY_COLLECTOR_DAMAGE_OBSERVER_ID = "fallout-maw.fixed.trophyCollector.damage";
export const TROPHY_COLLECTOR_ATTACK_OBSERVER_ID = "fallout-maw.fixed.trophyCollector.attack";
export const TROPHY_COLLECTOR_STATUS_OBSERVER_ID = "fallout-maw.fixed.trophyCollector.status";

const FIXED_FUNCTION_STATE_FLAG_KEY = "abilityFixedFunctionState";
const DAMAGE_EVENT_KEY = "fallout-maw.damage.resolved";
const ATTACK_EVENT_KEY = "fallout-maw.weapon.attack.resolved";
const STATUS_GAINED_EVENT_KEY = "fallout-maw.actor.status.gained";
const STATUS_LOST_EVENT_KEY = "fallout-maw.actor.status.lost";
const DEAD_STATUS_ID = "dead";
const ACTIVE_EFFECT_SHOW_ICON_ALWAYS = 2;
const DEFAULT_ICON = "icons/svg/target.svg";
const OCCURRENCE_CACHE_LIMIT = 4096;
const DAMAGE_PERCENT_EFFECT_KEY = "system.combat.damagePercent";
const ACCURACY_EFFECT_KEY = "system.combat.accuracy";
const CRITICAL_CHANCE_EFFECT_KEY = "system.combat.criticalChance";
const STUN_EFFECT_KEY = "system.combat.stun";

const damageOccurrences = new Map();
const processedDeathMarks = new Set();
const targetMutationQueues = new Map();
const itemMutationQueues = new Map();
let functionEntriesByActor = new WeakMap();
let runtimeRegistered = false;

export function normalizeTrophyCollectorSettings(value = {}) {
  return {
    markDurationSeconds: Math.max(1, toInteger(value?.markDurationSeconds ?? 3600)),
    maximumStrength: Math.max(1, toInteger(value?.maximumStrength ?? 5)),
    accuracyPerStack: toInteger(value?.accuracyPerStack ?? 10),
    incomingDamagePercentPerStack: toInteger(value?.incomingDamagePercentPerStack ?? 5),
    criticalChancePerStack: toInteger(value?.criticalChancePerStack ?? 1),
    resilienceSkillKey: String(value?.resilienceSkillKey ?? "resilience").trim() || "resilience",
    resilienceDifficultyFormula: String(value?.resilienceDifficultyFormula ?? "50+rangedCombat").trim() || "50+rangedCombat",
    stunPercent: Math.max(0, Math.min(100, toInteger(value?.stunPercent ?? 50))),
    stunDurationSeconds: Math.max(1, toInteger(value?.stunDurationSeconds ?? 12))
  };
}

/** Register event-driven mark/death processing. No timer or document polling is used. */
export function registerTrophyCollectorRuntime() {
  if (runtimeRegistered) return false;
  runtimeRegistered = true;
  registerSystemEventObserver({
    id: TROPHY_COLLECTOR_DAMAGE_OBSERVER_ID,
    eventKeys: [DAMAGE_EVENT_KEY],
    priority: 205,
    observe: observeTrophyCollectorDamage
  });
  registerSystemEventObserver({
    id: TROPHY_COLLECTOR_ATTACK_OBSERVER_ID,
    eventKeys: [ATTACK_EVENT_KEY],
    priority: 205,
    observe: observeTrophyCollectorAttack
  });
  registerSystemEventObserver({
    id: TROPHY_COLLECTOR_STATUS_OBSERVER_ID,
    eventKeys: [STATUS_GAINED_EVENT_KEY, STATUS_LOST_EVENT_KEY],
    priority: 205,
    observe: observeTrophyCollectorStatus
  });
  globalThis.Hooks?.on?.("createItem", invalidateTrophyCollectorFunctionEntryCache);
  globalThis.Hooks?.on?.("updateItem", invalidateTrophyCollectorFunctionEntryCache);
  globalThis.Hooks?.on?.("deleteItem", invalidateTrophyCollectorFunctionEntryCache);
  return true;
}

export function clearTrophyCollectorRuntimeCaches() {
  damageOccurrences.clear();
  processedDeathMarks.clear();
  targetMutationQueues.clear();
  itemMutationQueues.clear();
  functionEntriesByActor = new WeakMap();
}

export async function observeTrophyCollectorDamage({ event } = {}) {
  return processTrophyCollectorDamageEvent(event);
}

export async function observeTrophyCollectorAttack({ event } = {}) {
  return processTrophyCollectorAttackEvent(event);
}

export async function observeTrophyCollectorStatus({ event } = {}) {
  return processTrophyCollectorStatusEvent(event);
}

/**
 * Apply one mark per hunter/function/target/attackId after real health loss.
 * The damage event is authoritative; blocked damage and limb-only damage do
 * not qualify.
 */
export async function processTrophyCollectorDamageEvent(event = null, {
  resolveActor = resolveUuidSync,
  isAuthority = isTrophyCollectorAuthority,
  isEligibleTarget = isTrophyCollectorEnemy,
  applyMark = applyTrophyCollectorMark
} = {}) {
  if (!isAuthority() || String(event?.key ?? "") !== DAMAGE_EVENT_KEY) return [];
  if (event?.outcome?.cancelled === true || event?.outcome?.success === false) return [];
  if (getActualHealthLoss(event) <= 0) return [];

  const sourceData = event?.data?.source ?? {};
  if (sourceData.weaponAttackDamage !== true) return [];
  const attackId = String(sourceData.attackId ?? event?.data?.attackId ?? "").trim();
  const sourceActorUuid = getParticipantActorUuid(event?.participants?.source)
    || String(sourceData.attackerActorUuid ?? sourceData.attackerUuid ?? "").trim();
  const targetActorUuid = getParticipantActorUuid(event?.participants?.target)
    || String(event?.data?.actorUuid ?? event?.data?.result?.actorUuid ?? "").trim();
  if (!attackId || !sourceActorUuid || !targetActorUuid || sourceActorUuid === targetActorUuid) return [];

  const sourceActor = resolveActor(sourceActorUuid);
  const targetActor = resolveActor(targetActorUuid);
  if (!sourceActor || !targetActor || !isEligibleTarget(sourceActor, targetActor)) return [];
  const raceId = getActorRaceId(targetActor);
  if (!raceId) return [];

  const applied = [];
  for (const entry of getTrophyCollectorFunctionEntries(sourceActor)) {
    const occurrenceKey = [sourceActorUuid, entry.abilityItem.id, entry.abilityFunction.id, attackId, targetActorUuid].join(":");
    if (!claimOccurrence(damageOccurrences, occurrenceKey)) continue;
    try {
      const result = await queueMutation(targetMutationQueues, targetActorUuid, () => applyMark({
        sourceActor,
        targetActor,
        abilityItem: entry.abilityItem,
        abilityFunction: entry.abilityFunction,
        settings: entry.settings,
        attackId,
        sourceToken: resolveActor(String(event?.participants?.source?.tokenUuid ?? "")),
        targetToken: resolveActor(String(event?.participants?.target?.tokenUuid ?? "")),
        chainRef: event?.chainRef ?? null
      }));
      if (result?.ok) applied.push(result);
    } catch (error) {
      damageOccurrences.delete(occurrenceKey);
      console.error(`${SYSTEM_ID} | Trophy Collector mark failed`, error);
    }
  }
  return applied;
}

/** Weapon-resolution fallback for attacks whose death status event was delayed. */
export async function processTrophyCollectorAttackEvent(event = null, {
  resolveActor = resolveUuidSync,
  isAuthority = isTrophyCollectorAuthority
} = {}) {
  if (!isAuthority() || String(event?.key ?? "") !== ATTACK_EVENT_KEY) return [];
  if (event?.data?.attackCycleAggregate !== true) return [];
  const killedTargetUuids = uniqueUuids(event?.data?.killedTargetUuids);
  if (!killedTargetUuids.length) return [];
  return processTrophyCollectorCarrierDeaths(
    killedTargetUuids.map(resolveActor).filter(Boolean),
    { resolveActor, isAuthority: () => true }
  );
}

/** Any gained Dead status advances marks, regardless of who or what caused it. */
export async function processTrophyCollectorStatusEvent(event = null, {
  resolveActor = resolveUuidSync,
  isAuthority = isTrophyCollectorAuthority
} = {}) {
  if (!isAuthority() || String(event?.data?.statusId ?? "") !== DEAD_STATUS_ID) return [];
  const actorUuid = getParticipantActorUuid(event?.participants?.target)
    || String(event?.data?.actorUuid ?? "").trim();
  if (!actorUuid) return [];
  if (String(event?.key ?? "") === STATUS_LOST_EVENT_KEY) {
    clearProcessedDeathMarks(actorUuid);
    return [];
  }
  if (String(event?.key ?? "") !== STATUS_GAINED_EVENT_KEY) return [];
  const actor = resolveActor(actorUuid);
  return actor
    ? processTrophyCollectorCarrierDeaths([actor], { resolveActor, isAuthority: () => true })
    : [];
}

/** Advance every live Trophy mark exactly once for the carrier's current death. */
export async function processTrophyCollectorCarrierDeaths(targetActors = [], {
  resolveActor = resolveUuidSync,
  isAuthority = isTrophyCollectorAuthority
} = {}) {
  if (!isAuthority()) return [];

  const updatesByItem = new Map();
  for (const targetActor of targetActors) {
    const targetUuid = String(targetActor?.uuid ?? "").trim();
    if (!targetUuid) continue;
    for (const mark of getActorEffects(targetActor)) {
      const markData = getTrophyCollectorMarkData(mark);
      if (!markData?.raceId || !isLiveEffect(mark, markData)) continue;
      const markIdentity = getDeathMarkIdentity(targetUuid, markData);
      if (!markIdentity || processedDeathMarks.has(markIdentity)) continue;
      const sourceActor = resolveActor(markData.sourceActorUuid);
      const entry = findTrophyCollectorFunctionEntryForMark(sourceActor, markData);
      if (!entry) continue;
      processedDeathMarks.add(markIdentity);
      const itemUpdate = updatesByItem.get(entry.abilityItem) ?? new Map();
      const stateKey = getFixedFunctionStateKey(entry.abilityFunction);
      const functionUpdate = itemUpdate.get(stateKey) ?? {
        abilityFunction: entry.abilityFunction,
        settings: entry.settings,
        races: new Map()
      };
      functionUpdate.races.set(markData.raceId, {
        count: (functionUpdate.races.get(markData.raceId)?.count ?? 0) + 1,
        raceName: markData.raceName
      });
      itemUpdate.set(stateKey, functionUpdate);
      updatesByItem.set(entry.abilityItem, itemUpdate);
    }
  }

  const results = [];
  for (const [abilityItem, updates] of updatesByItem) {
    try {
      const result = await queueMutation(itemMutationQueues, getDocumentIdentity(abilityItem), () => (
        commitTrophyCollectorDeathAdvances(abilityItem, updates)
      ));
      if (result?.changed) results.push(result);
    } catch (error) {
      console.error(`${SYSTEM_ID} | Trophy Collector ledger advance failed`, error);
    }
  }
  return results;
}

export async function applyTrophyCollectorMark({
  sourceActor = null,
  targetActor = null,
  abilityItem = null,
  abilityFunction = null,
  settings = abilityFunction?.fixedSettings ?? {},
  attackId = "",
  sourceToken = null,
  targetToken = null,
  chainRef = null,
  startTime = getWorldTime(),
  requestCheck = requestTrophyCollectorResilienceCheck,
  applyStun = applyTrophyCollectorStun
} = {}) {
  if (!sourceActor || !targetActor || !abilityItem || !abilityFunction) {
    return { ok: false, reason: "invalidDocuments", effect: null };
  }
  const raceId = getActorRaceId(targetActor);
  if (!raceId || !isTrophyCollectorEnemy(sourceActor, targetActor)) {
    return { ok: false, reason: "invalidTarget", effect: null };
  }

  const normalized = normalizeTrophyCollectorSettings(settings);
  const raceName = getActorRaceName(targetActor, raceId);
  const ledger = getTrophyCollectorFunctionState(abilityItem, abilityFunction, normalized);
  const strength = getTrophyCollectorRaceStrength(ledger, raceId, normalized.maximumStrength);
  const now = finiteNumber(startTime, getWorldTime());
  const effectData = buildTrophyCollectorMarkEffectData({
    sourceActor,
    targetActor,
    abilityItem,
    abilityFunction,
    settings: normalized,
    strength,
    raceId,
    raceName,
    attackId,
    startTime: now
  });
  const existing = findTrophyCollectorMark(targetActor, abilityItem, abilityFunction, {
    sourceActorUuid: sourceActor.uuid,
    liveOnly: false
  });
  const effect = existing
    ? await updateEmbeddedEffect(existing, effectData)
    : await createEmbeddedEffect(targetActor, effectData, { falloutMawTrophyCollectorRuntime: true });
  if (effect && !ledger.races.some(entry => entry.raceId === raceId)) {
    await ensureTrophyCollectorRaceKnown({
      abilityItem,
      abilityFunction,
      raceId,
      raceName,
      settings: normalized
    });
  }

  let stunned = false;
  let check = null;
  if (effect && strength >= normalized.maximumStrength && normalized.stunPercent > 0) {
    check = await requestCheck({
      sourceActor,
      targetActor,
      sourceToken,
      targetToken,
      abilityItem,
      abilityFunction,
      settings: normalized,
      attackId,
      chainRef
    });
    if (isFailedSkillCheck(check)) {
      stunned = Boolean(await applyStun({
        sourceActor,
        targetActor,
        abilityItem,
        abilityFunction,
        settings: normalized,
        attackId,
        startTime: now
      }));
    }
  }
  if (effect && targetActor.statuses?.has?.(DEAD_STATUS_ID)) {
    await processTrophyCollectorCarrierDeaths([targetActor]);
  }
  return { ok: Boolean(effect), reason: effect ? "" : "effectNotCreated", effect, strength, raceId, check, stunned };
}

export function buildTrophyCollectorMarkEffectData({
  sourceActor = null,
  targetActor = null,
  abilityItem = null,
  abilityFunction = null,
  settings = {},
  strength = 1,
  raceId = getActorRaceId(targetActor),
  raceName = getActorRaceName(targetActor, raceId),
  attackId = "",
  startTime = 0
} = {}) {
  const normalized = normalizeTrophyCollectorSettings(settings);
  const count = Math.max(1, Math.min(normalized.maximumStrength, toInteger(strength) || 1));
  const now = finiteNumber(startTime, 0);
  const abilityName = getAbilityName(abilityItem);
  return {
    type: "base",
    name: `${abilityName}: Метка ×${count}`,
    img: abilityItem?.img || DEFAULT_ICON,
    description: "",
    origin: String(abilityItem?.uuid ?? ""),
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    duration: { seconds: normalized.markDurationSeconds, startTime: now },
    system: { changes: buildTrophyCollectorMarkChanges(normalized, count) },
    flags: {
      [SYSTEM_ID]: {
        kind: "temporary",
        [TROPHY_COLLECTOR_MARK_FLAG_KEY]: {
          sourceActorUuid: String(sourceActor?.uuid ?? ""),
          markedActorUuid: String(targetActor?.uuid ?? ""),
          abilityItemId: String(abilityItem?.id ?? ""),
          abilityItemUuid: String(abilityItem?.uuid ?? ""),
          abilitySourceId: getAbilitySourceId(abilityItem),
          functionId: String(abilityFunction?.id ?? ""),
          fixedKey: String(abilityFunction?.fixedKey ?? TROPHY_COLLECTOR_FIXED_KEY),
          raceId: String(raceId ?? ""),
          raceName: String(raceName ?? raceId ?? ""),
          strength: count,
          attackId: String(attackId ?? ""),
          createdAt: now,
          expiresAt: now + normalized.markDurationSeconds,
          settings: normalized
        }
      }
    }
  };
}

/** Target-owned reverse keys intentionally benefit every attacker. */
export function buildTrophyCollectorMarkChanges(settings = {}, strength = 1) {
  const normalized = normalizeTrophyCollectorSettings(settings);
  const count = Math.max(1, Math.min(normalized.maximumStrength, toInteger(strength) || 1));
  return [
    createAddChange(getReverseEffectKey(ACCURACY_EFFECT_KEY), count * normalized.accuracyPerStack),
    createAddChange(getReverseEffectKey(DAMAGE_PERCENT_EFFECT_KEY), count * normalized.incomingDamagePercentPerStack),
    createAddChange(getReverseEffectKey(CRITICAL_CHANCE_EFFECT_KEY), count * normalized.criticalChancePerStack)
  ].filter(change => Number(change.value) !== 0);
}

export function getTrophyCollectorMarkData(effect = null) {
  const raw = readFlag(effect, TROPHY_COLLECTOR_MARK_FLAG_KEY);
  if (!raw?.sourceActorUuid || !raw?.markedActorUuid || !raw?.functionId || !raw?.raceId) return null;
  const settings = normalizeTrophyCollectorSettings(raw.settings);
  return {
    sourceActorUuid: String(raw.sourceActorUuid),
    markedActorUuid: String(raw.markedActorUuid),
    abilityItemId: String(raw.abilityItemId ?? ""),
    abilityItemUuid: String(raw.abilityItemUuid ?? ""),
    abilitySourceId: String(raw.abilitySourceId ?? ""),
    functionId: String(raw.functionId),
    fixedKey: String(raw.fixedKey ?? TROPHY_COLLECTOR_FIXED_KEY),
    raceId: String(raw.raceId),
    raceName: String(raw.raceName ?? raw.raceId),
    strength: Math.max(1, Math.min(settings.maximumStrength, toInteger(raw.strength) || 1)),
    attackId: String(raw.attackId ?? ""),
    createdAt: finiteNumber(raw.createdAt, 0),
    expiresAt: finiteNumber(raw.expiresAt, 0),
    settings
  };
}

export function findTrophyCollectorMark(targetActor = null, abilityItem = null, abilityFunction = null, {
  sourceActorUuid = String(abilityItem?.parent?.uuid ?? ""),
  liveOnly = true
} = {}) {
  const itemId = String(abilityItem?.id ?? "");
  const sourceId = getAbilitySourceId(abilityItem);
  const functionId = String(abilityFunction?.id ?? "");
  return getActorEffects(targetActor).find(effect => {
    const data = getTrophyCollectorMarkData(effect);
    if (!data || (liveOnly && !isLiveEffect(effect, data))) return false;
    if (sourceActorUuid && data.sourceActorUuid !== String(sourceActorUuid)) return false;
    if (functionId && data.functionId !== functionId) return false;
    if (itemId && data.abilityItemId === itemId) return true;
    return Boolean(sourceId && data.abilitySourceId === sourceId);
  }) ?? null;
}

export function normalizeTrophyCollectorLedger(value = {}, maximumStrength = 5) {
  const max = Math.max(1, toInteger(maximumStrength) || 5);
  const source = Array.isArray(value?.races)
    ? value.races
    : Object.entries(value?.races ?? {}).map(([raceId, entry]) => ({ raceId, ...(entry ?? {}) }));
  const races = [];
  const seen = new Set();
  for (const entry of source) {
    const raceId = String(entry?.raceId ?? "").trim();
    if (!raceId || seen.has(raceId)) continue;
    seen.add(raceId);
    races.push({
      raceId,
      raceName: String(entry?.raceName ?? raceId).trim() || raceId,
      strength: Math.max(1, Math.min(max, toInteger(entry?.strength) || 1))
    });
  }
  return { fixedKey: TROPHY_COLLECTOR_FIXED_KEY, races };
}

export function getTrophyCollectorFunctionState(abilityItem = null, abilityFunction = {}, settings = {}) {
  const normalized = normalizeTrophyCollectorSettings(settings || abilityFunction?.fixedSettings);
  const root = getFixedAbilityState(abilityItem);
  return normalizeTrophyCollectorLedger(root[getFixedFunctionStateKey(abilityFunction)], normalized.maximumStrength);
}

export function getTrophyCollectorRaceStrength(ledger = {}, raceId = "", maximumStrength = 5) {
  const key = String(raceId ?? "").trim();
  if (!key) return 0;
  return normalizeTrophyCollectorLedger(ledger, maximumStrength).races
    .find(entry => entry.raceId === key)?.strength ?? 1;
}

export function getTrophyCollectorLedgerRows(abilityItem = null, abilityFunction = {}, settings = {}) {
  const normalized = normalizeTrophyCollectorSettings(settings || abilityFunction?.fixedSettings);
  return getTrophyCollectorFunctionState(abilityItem, abilityFunction, normalized).races
    .map(entry => ({
      raceId: entry.raceId,
      raceName: getConfiguredRaceName(entry.raceId) || entry.raceName || entry.raceId,
      strength: entry.strength,
      maximumStrength: normalized.maximumStrength
    }))
    .sort((left, right) => left.raceName.localeCompare(right.raceName, "ru"));
}

/** Activation has no mutation or cost; it opens the permanent ledger for its owner. */
export async function showTrophyCollectorLedger({
  actor = null,
  abilityItem = null,
  abilityFunction = null,
  settings = abilityFunction?.fixedSettings ?? {},
  openDialog = options => globalThis.foundry?.applications?.api?.DialogV2?.wait?.(options)
} = {}) {
  if (!actor || !abilityItem || !abilityFunction || typeof openDialog !== "function") return false;
  const rows = getTrophyCollectorLedgerRows(abilityItem, abilityFunction, settings);
  const content = rows.length
    ? `<div class="fallout-maw-trophy-collector-ledger scrollable">
        ${rows.map(row => `
          <div class="fallout-maw-trophy-collector-ledger-row">
            <strong>${escapeHtml(row.raceName)}</strong>
            <span>${row.strength} / ${row.maximumStrength}</span>
          </div>
        `).join("")}
      </div>`
    : "<p class=\"hint\">Трофеи ещё не собраны.</p>";
  await openDialog({
    window: { title: getAbilityName(abilityItem), icon: "fa-solid fa-crosshairs" },
    classes: ["fallout-maw", "fallout-maw-trophy-collector-dialog"],
    content,
    buttons: [{
      action: "close",
      label: "Закрыть",
      icon: "fa-solid fa-check",
      default: true,
      callback: () => true
    }],
    rejectClose: false,
    modal: true,
    position: { width: 440, height: "auto" }
  });
  return true;
}

export async function requestTrophyCollectorResilienceCheck({
  sourceActor = null,
  targetActor = null,
  sourceToken = null,
  targetToken = null,
  abilityItem = null,
  settings = {},
  attackId = "",
  chainRef = null
} = {}) {
  const normalized = normalizeTrophyCollectorSettings(settings);
  const { evaluateActorFormula } = await import("../utils/actor-formulas.mjs");
  const difficulty = Math.max(0, Math.floor(evaluateActorFormula(
    normalized.resilienceDifficultyFormula,
    sourceActor,
    { fallback: 50, minimum: 0, context: "trophy collector resilience difficulty" }
  )));
  const { requestSkillCheck } = await import("../rolls/skill-check.mjs");
  return requestSkillCheck({
    actor: targetActor,
    skillKey: normalized.resilienceSkillKey,
    animate: false,
    prompt: false,
    requester: "trophyCollector",
    chainRef,
    data: {
      difficulty,
      actorToken: targetToken?.object ?? targetToken,
      targetActor: sourceActor,
      targetToken: sourceToken?.object ?? sourceToken,
      allowImplicitTarget: false,
      weaponAttackId: String(attackId ?? "")
    },
    source: {
      abilityItemUuid: String(abilityItem?.uuid ?? ""),
      weaponAttackId: String(attackId ?? "")
    },
    messageData: { flavor: `${getAbilityName(abilityItem)}: проверка Стойкости` }
  });
}

export async function applyTrophyCollectorStun({
  sourceActor = null,
  targetActor = null,
  abilityItem = null,
  abilityFunction = null,
  settings = {},
  attackId = "",
  startTime = getWorldTime()
} = {}) {
  if (!targetActor || !abilityItem || !abilityFunction) return null;
  const normalized = normalizeTrophyCollectorSettings(settings);
  const now = finiteNumber(startTime, getWorldTime());
  const flag = {
    sourceActorUuid: String(sourceActor?.uuid ?? ""),
    targetActorUuid: String(targetActor?.uuid ?? ""),
    abilityItemId: String(abilityItem?.id ?? ""),
    abilityItemUuid: String(abilityItem?.uuid ?? ""),
    abilitySourceId: getAbilitySourceId(abilityItem),
    functionId: String(abilityFunction?.id ?? ""),
    attackId: String(attackId ?? ""),
    createdAt: now,
    expiresAt: now + normalized.stunDurationSeconds,
    stunPercent: normalized.stunPercent
  };
  const data = {
    type: "base",
    name: `${getAbilityName(abilityItem)}: Оглушение ${normalized.stunPercent}%`,
    img: abilityItem?.img || DEFAULT_ICON,
    description: `Оглушение ${normalized.stunPercent}% на ${normalized.stunDurationSeconds} секунд.`,
    origin: String(abilityItem?.uuid ?? ""),
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    duration: { seconds: normalized.stunDurationSeconds, startTime: now },
    system: { changes: [createAddChange(STUN_EFFECT_KEY, normalized.stunPercent)] },
    flags: { [SYSTEM_ID]: { kind: "temporary", [TROPHY_COLLECTOR_STUN_FLAG_KEY]: flag } }
  };
  const existing = getActorEffects(targetActor).find(effect => {
    const current = readFlag(effect, TROPHY_COLLECTOR_STUN_FLAG_KEY);
    return current
      && String(current.sourceActorUuid ?? "") === flag.sourceActorUuid
      && sameAbilityIdentity(current, flag)
      && String(current.functionId ?? "") === flag.functionId;
  });
  return existing
    ? updateEmbeddedEffect(existing, data)
    : createEmbeddedEffect(targetActor, data, { falloutMawTrophyCollectorRuntime: true });
}

export function getTrophyCollectorFunctionEntries(actor = null) {
  if (!actor || (typeof actor !== "object" && typeof actor !== "function")) return [];
  if (getActiveRulesProfile().fixedAbilityFunctionsEnabled === false) return [];
  const cached = functionEntriesByActor.get(actor);
  if (cached) return cached;
  const entries = [];
  for (const abilityItem of Array.from(actor?.items?.contents ?? actor?.items ?? [])) {
    if (abilityItem?.type !== "ability") continue;
    for (const abilityFunction of abilityItem.system?.functions ?? []) {
      if (
        abilityFunction?.type !== "fixed"
        || abilityFunction?.enabled === false
        || String(abilityFunction?.fixedKey ?? "") !== TROPHY_COLLECTOR_FIXED_KEY
      ) continue;
      entries.push({
        abilityItem,
        abilityFunction,
        settings: normalizeTrophyCollectorSettings(abilityFunction.fixedSettings)
      });
    }
  }
  const result = Object.freeze(entries);
  functionEntriesByActor.set(actor, result);
  return result;
}

export function findTrophyCollectorFunctionEntryForMark(actor = null, markData = null) {
  if (!actor || !markData) return null;
  return getTrophyCollectorFunctionEntries(actor).find(entry => {
    if (String(entry.abilityFunction?.id ?? "") !== String(markData.functionId ?? "")) return false;
    if (
      markData.abilityItemId
      && String(entry.abilityItem?.id ?? "") === String(markData.abilityItemId)
    ) return true;
    return Boolean(
      markData.abilitySourceId
      && getAbilitySourceId(entry.abilityItem) === String(markData.abilitySourceId)
    );
  }) ?? null;
}

async function ensureTrophyCollectorRaceKnown({
  abilityItem,
  abilityFunction,
  raceId,
  raceName,
  settings
}) {
  return queueMutation(itemMutationQueues, getDocumentIdentity(abilityItem), async () => {
    const normalized = normalizeTrophyCollectorSettings(settings);
    const root = cloneValue(getFixedAbilityState(abilityItem));
    const stateKey = getFixedFunctionStateKey(abilityFunction);
    const ledger = normalizeTrophyCollectorLedger(root[stateKey], normalized.maximumStrength);
    if (ledger.races.some(entry => entry.raceId === raceId)) return ledger;
    ledger.races.push({ raceId, raceName: String(raceName ?? raceId), strength: 1 });
    root[stateKey] = ledger;
    await abilityItem.setFlag(SYSTEM_ID, FIXED_FUNCTION_STATE_FLAG_KEY, root);
    return ledger;
  });
}

async function commitTrophyCollectorDeathAdvances(abilityItem, updatesByStateKey = new Map()) {
  const root = cloneValue(getFixedAbilityState(abilityItem));
  const updated = [];
  let changed = false;
  for (const [stateKey, update] of updatesByStateKey) {
    const max = update.settings.maximumStrength;
    const ledger = normalizeTrophyCollectorLedger(root[stateKey], max);
    for (const [raceId, raceUpdate] of update.races) {
      let race = ledger.races.find(entry => entry.raceId === raceId);
      if (!race) {
        race = { raceId, raceName: raceUpdate.raceName || raceId, strength: 1 };
        ledger.races.push(race);
      }
      const previous = race.strength;
      race.strength = Math.min(max, previous + Math.max(0, toInteger(raceUpdate.count)));
      if (race.strength !== previous) changed = true;
      updated.push({ raceId, previous, strength: race.strength, deaths: raceUpdate.count });
    }
    root[stateKey] = ledger;
  }
  if (changed) await abilityItem.setFlag(SYSTEM_ID, FIXED_FUNCTION_STATE_FLAG_KEY, root);
  return { changed, abilityItem, updated };
}

function isTrophyCollectorEnemy(sourceActor = null, targetActor = null) {
  return Boolean(sourceActor && targetActor && getActorFactionRelation(sourceActor, targetActor) !== "ally");
}

function invalidateTrophyCollectorFunctionEntryCache(item = null) {
  const actor = item?.parent;
  if (actor) functionEntriesByActor.delete(actor);
}

function isFailedSkillCheck(outcome = null) {
  return ["failure", "criticalFailure"].includes(String(outcome?.result?.key ?? outcome?.resultKey ?? ""));
}

function isTrophyCollectorAuthority() {
  return Boolean(
    globalThis.game?.user?.isActiveGM
    || (globalThis.game?.user?.id && globalThis.game?.users?.activeGM?.id === globalThis.game.user.id)
  );
}

function claimOccurrence(cache, key = "") {
  const normalized = String(key ?? "").trim();
  if (!normalized || cache.has(normalized)) return false;
  cache.set(normalized, true);
  while (cache.size > OCCURRENCE_CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return true;
}

function getDeathMarkIdentity(targetActorUuid = "", markData = null) {
  const parts = [
    targetActorUuid,
    markData?.sourceActorUuid,
    markData?.abilityItemId || markData?.abilitySourceId,
    markData?.functionId
  ].map(value => String(value ?? "").trim());
  return parts.every(Boolean) ? parts.join("|") : "";
}

function clearProcessedDeathMarks(actorUuid = "") {
  const prefix = `${String(actorUuid ?? "").trim()}|`;
  if (prefix === "|") return;
  for (const identity of processedDeathMarks) {
    if (identity.startsWith(prefix)) processedDeathMarks.delete(identity);
  }
}

function queueMutation(queues, key = "", operation) {
  const normalized = String(key ?? "").trim();
  const previous = queues.get(normalized) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(operation)
    .finally(() => {
      if (queues.get(normalized) === current) queues.delete(normalized);
    });
  queues.set(normalized, current);
  return current;
}

function getFixedAbilityState(abilityItem = null) {
  const state = abilityItem?.getFlag?.(SYSTEM_ID, FIXED_FUNCTION_STATE_FLAG_KEY)
    ?? abilityItem?.flags?.[SYSTEM_ID]?.[FIXED_FUNCTION_STATE_FLAG_KEY];
  return state && typeof state === "object" ? state : {};
}

function getFixedFunctionStateKey(abilityFunction = {}) {
  return [String(abilityFunction?.id ?? ""), String(abilityFunction?.fixedKey ?? TROPHY_COLLECTOR_FIXED_KEY)]
    .filter(Boolean)
    .join(":");
}

function getParticipantActorUuid(participant = null) {
  return String(participant?.actorUuid ?? participant?.actor?.uuid ?? "").trim();
}

function getActualHealthLoss(event = null) {
  if (Object.hasOwn(event?.delta ?? {}, "health")) {
    return Math.max(0, -finiteNumber(event.delta.health, 0));
  }
  return Math.max(0, finiteNumber(event?.data?.result?.healthDelta, 0));
}

function getActorRaceId(actor = null) {
  return String(actor?.system?.creature?.raceId ?? "").trim();
}

function getActorRaceName(actor = null, fallback = "") {
  const raceId = getActorRaceId(actor) || fallback;
  return String(
    actor?.system?.creature?.raceName
    ?? actor?.system?.creature?.race?.name
    ?? getConfiguredRaceName(raceId)
    ?? fallback
  ).trim() || fallback;
}

function getConfiguredRaceName(raceId = "") {
  const key = String(raceId ?? "").trim();
  if (!key) return "";
  try {
    const configured = globalThis.game?.settings?.get?.(SYSTEM_ID, "creatureOptions");
    const races = Array.isArray(configured?.races) ? configured.races : Object.values(configured?.races ?? {});
    const race = races.find(entry => String(entry?.id ?? "") === key);
    return String(race?.name ?? "").trim();
  } catch (_error) {
    return "";
  }
}

function getAbilityName(item = null) {
  return String(item?.name ?? "").trim() || "Собиратель трофеев";
}

function getAbilitySourceId(item = null) {
  return String(item?.getFlag?.("core", "sourceId") ?? item?.flags?.core?.sourceId ?? "");
}

function getDocumentIdentity(document = null) {
  return String(document?.uuid ?? document?.id ?? "").trim();
}

function getActorEffects(actor = null) {
  return Array.from(actor?.effects?.contents ?? actor?.effects ?? []);
}

function isLiveEffect(effect, data = null, now = getWorldTime()) {
  if (!effect || !data || effect.disabled || effect.active === false || effect.duration?.expired === true) return false;
  return !(data.expiresAt > 0 && now >= data.expiresAt);
}

function sameAbilityIdentity(left = {}, right = {}) {
  if (String(left.abilityItemId ?? "") && String(left.abilityItemId) === String(right.abilityItemId ?? "")) return true;
  return Boolean(left.abilitySourceId && String(left.abilitySourceId) === String(right.abilitySourceId ?? ""));
}

function readFlag(document = null, key = "") {
  return document?.getFlag?.(SYSTEM_ID, key)
    ?? document?.flags?.[SYSTEM_ID]?.[key]
    ?? document?._source?.flags?.[SYSTEM_ID]?.[key]
    ?? null;
}

function createAddChange(key, value) {
  return { key, type: "add", value: String(value), phase: "initial", priority: null };
}

async function updateEmbeddedEffect(effect, data) {
  await effect.update(data, { animate: false, falloutMawTrophyCollectorRuntime: true });
  return resolveUuidSync(effect?.uuid) ?? effect;
}

async function createEmbeddedEffect(actor, data, options = {}) {
  const [created] = await actor.createEmbeddedDocuments("ActiveEffect", [data], { animate: false, ...options });
  return created ?? null;
}

function resolveUuidSync(uuid = "") {
  const normalized = String(uuid ?? "").trim();
  if (!normalized) return null;
  return globalThis.fromUuidSync?.(normalized)
    ?? globalThis.foundry?.utils?.fromUuidSync?.(normalized)
    ?? null;
}

function uniqueUuids(values = []) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map(value => String(value ?? "").trim())
    .filter(Boolean)));
}

function cloneValue(value) {
  if (globalThis.foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
  return structuredClone(value);
}

function escapeHtml(value = "") {
  const text = String(value ?? "");
  if (globalThis.foundry?.utils?.escapeHTML) return foundry.utils.escapeHTML(text);
  return text.replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[character]);
}

function getWorldTime() {
  return finiteNumber(globalThis.game?.time?.worldTime, 0);
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
