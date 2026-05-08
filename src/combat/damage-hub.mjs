import { SYSTEM_ID, TRAUMA_CREATE_OPTION } from "../constants.mjs";
import { getCreatureOptions, getDamageTypeSettings, getTimeMechanicsIgnored, getTraumaSettings } from "../settings/accessors.mjs";
import { getTraumaGroupForActor } from "../settings/traumas.mjs";
import { toInteger } from "../utils/numbers.mjs";

const DAMAGE_SOCKET = `system.${SYSTEM_ID}`;
const TRAUMA_FLAG_SCOPE = "fallout-maw";
const TRAUMA_FLAG_KEY = "trauma";
const DAMAGE_EFFECT_FLAG_KEY = "damageEffect";
const ACTIVE_EFFECT_SHOW_ICON_ALWAYS = 2;
const MODE_DAMAGE = "damage";
const MODE_HEALING = "healing";
const SCOPE_LIMB = "limb";
const SCOPE_HEALTH = "health";
const SCOPE_HEALTH_AND_LIMB = "healthAndLimb";
const ROUND_SECONDS = 6;
let damageTimeHooksRegistered = false;
const combatRoundWorldTimes = new Map();
const processingPeriodicEffectUuids = new Set();

export function registerDamageSocket() {
  game.socket.on(DAMAGE_SOCKET, handleDamageSocketMessage);
  registerDamageTimeHooks();
}

export async function requestDamageApplication({
  actor = null,
  actorUuid = "",
  limbKey = "",
  amount = 0,
  damageTypeKey = "",
  mode = MODE_DAMAGE,
  scope = SCOPE_HEALTH_AND_LIMB,
  applyMitigation = true,
  processDamageTypeSettings = true,
  source = {}
} = {}) {
  const resolvedActor = actor ?? await fromUuid(actorUuid);
  if (!resolvedActor) return undefined;

  const request = normalizeDamageRequest({
    actorUuid: resolvedActor.uuid,
    limbKey,
    amount,
    damageTypeKey,
    mode,
    scope,
    applyMitigation,
    processDamageTypeSettings,
    source,
    requesterUserId: game.user?.id ?? ""
  });

  if (canApplyDamageLocally(resolvedActor)) return applyDamageApplication(request);

  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("Нет активного GM для применения урона.");
    return undefined;
  }

  game.socket.emit(DAMAGE_SOCKET, {
    action: "applyDamage",
    gmUserId: gm.id,
    request
  });
  return undefined;
}

export async function applyDamageApplication(request = {}) {
  const data = normalizeDamageRequest(request);
  const actor = await fromUuid(data.actorUuid);
  if (!actor) return undefined;
  if (!game.user?.isGM && !actor.isOwner) return undefined;

  const mode = data.mode === MODE_HEALING ? MODE_HEALING : MODE_DAMAGE;
  const scope = normalizeScope(data.scope, data.limbKey);
  const damageType = getDamageTypeSettings().find(entry => entry.key === data.damageTypeKey);
  const mitigatedAmount = mode === MODE_DAMAGE && data.applyMitigation
    ? calculateEffectiveDamage(actor, data.amount, damageType?.key ?? "", data.limbKey)
    : data.amount;
  const effectiveAmount = mode === MODE_DAMAGE && data.processDamageTypeSettings
    ? applyLimbHealthMultiplier(actor, mitigatedAmount, damageType, data.limbKey)
    : mitigatedAmount;
  if (effectiveAmount <= 0) return { actor, amount: 0, healthDelta: 0, limbDelta: 0, mode, scope };

  const needIncrease = damageType?.settings?.needIncrease;
  if (mode === MODE_DAMAGE && data.processDamageTypeSettings && needIncrease?.enabled) {
    await applyNeedIncrease(actor, {
      amount: effectiveAmount,
      settings: needIncrease
    });
    if (needIncrease.preventHealthDamage) {
      return { actor, amount: 0, potentialAmount: effectiveAmount, healthDelta: 0, limbDelta: 0, mode, scope };
    }
  }

  const periodic = damageType?.settings?.periodic;
  if (mode === MODE_DAMAGE && data.processDamageTypeSettings && periodic?.enabled) {
    const immediateAmount = roundDamageAmount(effectiveAmount * (Number(periodic.immediatePercent) || 0) / 100);
    const delayedAmount = roundDamageAmount(effectiveAmount * (Number(periodic.delayedPercent) || 0) / 100);
    const immediateResult = immediateAmount > 0
      ? await applyDirectDamageApplication(actor, {
        ...data,
        amount: immediateAmount,
        damageTypeKey: damageType?.key ?? data.damageTypeKey,
        mode,
        scope
      }, damageType)
      : { actor, amount: 0, healthDelta: 0, limbDelta: 0, createdTraumas: [] };
    if (delayedAmount > 0) await createPeriodicDamageEffect(actor, {
      damageType,
      limbKey: data.limbKey,
      scope,
      amount: delayedAmount,
      settings: periodic,
      source: data.source
    });
    if (immediateResult.healthDelta > 0) {
      await createResourceLimitEffect(actor, {
        damageType,
        healthDelta: immediateResult.healthDelta,
        source: data.source
      });
    }
    return {
      ...immediateResult,
      amount: immediateAmount,
      delayedAmount
    };
  }

  const result = await applyDirectDamageApplication(actor, {
    ...data,
    amount: effectiveAmount,
    damageTypeKey: damageType?.key ?? data.damageTypeKey,
    mode,
    scope
  }, damageType);
  if (mode === MODE_DAMAGE && data.processDamageTypeSettings && result.healthDelta > 0) {
    await createResourceLimitEffect(actor, {
      damageType,
      healthDelta: result.healthDelta,
      source: data.source
    });
  }
  return result;
}

async function applyDirectDamageApplication(actor, data = {}, damageType = null) {
  const mode = data.mode === MODE_HEALING ? MODE_HEALING : MODE_DAMAGE;
  const scope = normalizeScope(data.scope, data.limbKey);
  const effectiveAmount = Math.max(0, roundDamageAmount(data.amount));

  const updateData = {};
  const limb = data.limbKey ? actor.system?.limbs?.[data.limbKey] : null;
  const shouldUpdateHealth = scope === SCOPE_HEALTH || scope === SCOPE_HEALTH_AND_LIMB;
  const shouldUpdateLimb = Boolean(limb) && (scope === SCOPE_LIMB || scope === SCOPE_HEALTH_AND_LIMB);
  let actualHealthDelta = 0;
  let actualLimbDelta = 0;
  let previousLimbValue = limb ? toInteger(limb.value) : 0;
  let nextLimbValue = previousLimbValue;

  if (shouldUpdateHealth && actor.health) {
    const health = actor.health;
    const current = toInteger(health.value);
    const min = toInteger(health.min);
    const max = toInteger(health.max);
    const next = mode === MODE_DAMAGE
      ? Math.max(min, current - effectiveAmount)
      : Math.min(max, current + effectiveAmount);
    actualHealthDelta = Math.abs(next - current);
    updateData["system.resources.health.value"] = next;
  }

  if (shouldUpdateLimb) {
    const min = toInteger(limb.min);
    const max = toInteger(limb.max);
    if (mode === MODE_DAMAGE) {
      const limbDamage = calculateLimbStateDamage(actor, limb, {
        healthDelta: actualHealthDelta,
        amount: effectiveAmount,
        scope,
        damageType
      });
      nextLimbValue = Math.max(min, previousLimbValue - limbDamage);
      actualLimbDelta = Math.max(0, previousLimbValue - nextLimbValue);
    } else {
      const cap = getLimbHealingCap(actor, data.limbKey);
      nextLimbValue = Math.min(Math.min(max, cap), previousLimbValue + effectiveAmount);
      actualLimbDelta = Math.max(0, nextLimbValue - previousLimbValue);
    }
    updateData[`system.limbs.${data.limbKey}.value`] = nextLimbValue;
    Object.assign(updateData, buildAccumulationUpdate(actor, data.limbKey, data.damageTypeKey, actualLimbDelta, mode));
  }

  if (Object.keys(updateData).length) await actor.update(updateData);

  const createdTraumas = shouldUpdateLimb && mode === MODE_DAMAGE && actualLimbDelta > 0
    ? await createTriggeredTraumas(actor, {
      limbKey: data.limbKey,
      damageTypeKey: damageType?.key ?? data.damageTypeKey,
      previousValue: previousLimbValue,
      nextValue: nextLimbValue,
      latestDamage: actualLimbDelta
    })
    : [];

  return {
    actor,
    amount: effectiveAmount,
    healthDelta: actualHealthDelta,
    limbDelta: actualLimbDelta,
    mode,
    scope,
    limbKey: data.limbKey,
    damageTypeKey: damageType?.key ?? data.damageTypeKey,
    createdTraumas
  };
}

export function getActorTraumas(actor) {
  return actor?.items?.filter(item => item.type === "trauma") ?? [];
}

export function getLimbHealingCap(actor, limbKey = "") {
  const limb = actor?.system?.limbs?.[limbKey];
  if (!limb) return 0;
  const max = toInteger(limb.max);
  return getActorTraumas(actor)
    .filter(item => item.system?.limbKey === limbKey)
    .reduce((cap, item) => Math.min(cap, toInteger(item.system?.thresholdValue)), max);
}

export function getResourceLimitState(actor) {
  const resources = {};
  for (const effect of actor?.effects ?? []) {
    if (effect.disabled) continue;
    const data = effect.getFlag?.(TRAUMA_FLAG_SCOPE, DAMAGE_EFFECT_FLAG_KEY);
    if (data?.kind !== "resourceLimit" && data?.kind !== "resourceBlock") continue;
    const color = String(data.color ?? "#3f8cff");
    for (const [key, amount] of Object.entries(data.resources ?? {})) {
      const value = Math.max(0, toInteger(amount));
      if (!value) continue;
      resources[key] ??= { amount: 0, color };
      resources[key].amount += value;
      resources[key].color = color;
    }
  }
  return { resources };
}

export const getResourceBlockState = getResourceLimitState;

async function createPeriodicDamageEffect(actor, { damageType = {}, limbKey = "", scope = SCOPE_HEALTH, amount = 0, settings = {}, source = {} } = {}) {
  const tickCount = Math.max(0, toInteger(settings.tickCount));
  const tickAmount = tickCount > 0 ? roundDamageAmount(amount / tickCount) : 0;
  if (!tickCount || !tickAmount) return [];

  const intervalSeconds = Math.max(1, toInteger(settings.intervalSeconds || ROUND_SECONDS));
  const startTime = Number(game.time?.worldTime) || 0;
  const endTime = startTime + (intervalSeconds * tickCount);
  const effectName = String(settings.effectName || damageType.label || damageType.key || "Урон").trim();
  const effectData = {
    type: "base",
    name: effectName,
    img: String(settings.img || "icons/svg/hazard.svg"),
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    flags: {
      [TRAUMA_FLAG_SCOPE]: {
        kind: "active",
        [DAMAGE_EFFECT_FLAG_KEY]: {
          kind: "periodicDamage",
          damageTypeKey: damageType.key ?? "",
          limbKey,
          scope,
          amountPerTick: tickAmount,
          totalTicks: tickCount,
          remainingTicks: tickCount,
          intervalSeconds,
          startTime,
          endTime,
          nextTickTime: startTime + intervalSeconds,
          source
        }
      }
    },
    system: { changes: [] }
  };
  return actor.createEmbeddedDocuments("ActiveEffect", [effectData]);
}

async function createResourceLimitEffect(actor, { damageType = {}, healthDelta = 0, source = {} } = {}) {
  const settings = damageType?.settings?.resourceLimit ?? damageType?.settings?.resourceBlock;
  if (!settings?.enabled) return [];
  const healthMax = Math.max(0, toInteger(actor.health?.max));
  if (!healthMax) return [];
  const percent = Math.max(0, Number(healthDelta) || 0) / healthMax;
  const resources = {};
  for (const rule of settings.resources ?? []) {
    const resourceKey = String(rule?.resourceKey ?? "").trim();
    const resource = actor.system?.resources?.[resourceKey];
    const resourceMax = Math.max(0, toInteger(resource?.max));
    if (!resourceKey || !resourceMax) continue;
    const rulePercent = Math.max(0, Number(rule?.percent) || 0) / 100;
    const amount = roundDamageAmount(percent * resourceMax * rulePercent);
    if (amount) resources[resourceKey] = (resources[resourceKey] ?? 0) + amount;
  }
  if (!Object.keys(resources).length) return [];

  const durationSeconds = Math.max(1, toInteger(settings.durationSeconds || 12));
  const startTime = Number(game.time?.worldTime) || 0;
  return actor.createEmbeddedDocuments("ActiveEffect", [{
    type: "base",
    name: String(settings.effectName || damageType.label || "Ограничение ресурсов"),
    img: String(settings.img || "icons/svg/frozen.svg"),
    disabled: false,
    tint: settings.color,
    duration: {
      seconds: durationSeconds,
      startTime
    },
    flags: {
      [TRAUMA_FLAG_SCOPE]: {
        kind: "temporary",
        [DAMAGE_EFFECT_FLAG_KEY]: {
          kind: "resourceLimit",
          damageTypeKey: damageType.key ?? "",
          resources,
          color: settings.color,
          source
        }
      }
    },
    system: { changes: [] }
  }]);
}

async function applyNeedIncrease(actor, { amount = 0, settings = {} } = {}) {
  const needKey = String(settings.needKey ?? "").trim();
  const need = actor.system?.needs?.[needKey];
  if (!need) return null;

  const delta = roundDamageAmount(Math.max(0, Number(amount) || 0) * (Math.max(0, Number(settings.percent) || 0) / 100));
  if (!delta) return null;

  const min = Math.max(0, toInteger(need.min));
  const max = Math.max(min, toInteger(need.max));
  const current = Math.min(Math.max(toInteger(need.value), min), max);
  const next = Math.min(max, current + delta);
  if (next === current) return null;

  await actor.update({ [`system.needs.${needKey}.value`]: next });
  return { needKey, delta: next - current, value: next };
}

async function handleDamageSocketMessage(payload = {}) {
  if (!payload || payload.action !== "applyDamage") return;
  if (!game.user?.isGM || payload.gmUserId !== game.user.id) return;
  await applyDamageApplication(payload.request);
}

function registerDamageTimeHooks() {
  if (damageTimeHooksRegistered) return;
  Hooks.on("combatStart", combat => {
    if (!game.user?.isActiveGM) return;
    combatRoundWorldTimes.set(combat.id, Number(game.time?.worldTime) || 0);
  });
  Hooks.on("deleteCombat", combat => combatRoundWorldTimes.delete(combat.id));
  Hooks.on("combatTurnChange", advanceWorldTimeForCombatRound);
  Hooks.on("updateWorldTime", processTimedDamageEffects);
  Hooks.on("preDeleteActiveEffect", preventIgnoredTimedDamageEffectDeletion);
  damageTimeHooksRegistered = true;
}

async function advanceWorldTimeForCombatRound(combat, previous, current) {
  if (!game.user?.isActiveGM || !combat?.started) return;
  const previousRound = toInteger(previous?.round);
  const currentRound = toInteger(current?.round);
  if (currentRound <= 1 || currentRound <= previousRound) return;

  const roundSeconds = getRoundSeconds();
  const previousWorldTime = combatRoundWorldTimes.get(combat.id) ?? (Number(game.time?.worldTime) || 0);
  const currentWorldTime = Number(game.time?.worldTime) || 0;
  const elapsed = Math.max(0, currentWorldTime - previousWorldTime);
  if (elapsed < roundSeconds) await game.time.advance(roundSeconds - elapsed);
  combatRoundWorldTimes.set(combat.id, Number(game.time?.worldTime) || currentWorldTime + roundSeconds);
}

function getRoundSeconds() {
  if (CONFIG.time) CONFIG.time.roundTime = ROUND_SECONDS;
  return ROUND_SECONDS;
}

async function processTimedDamageEffects(worldTime, deltaTime) {
  if (!game.user?.isActiveGM || Number(deltaTime) <= 0) return;
  if (getTimeMechanicsIgnored()) {
    await preserveTimedDamageEffects(Number(deltaTime) || 0);
    return;
  }
  const now = Number(worldTime) || Number(game.time?.worldTime) || 0;
  for (const actor of getLoadedActors()) {
    if (!actor?.isOwner) continue;
    const entries = [];
    const effectUpdates = [];
    const effectDeleteIds = new Set();
    const lockedEffectUuids = new Set();

    for (const effect of Array.from(actor.effects ?? [])) {
      const data = effect.getFlag?.(TRAUMA_FLAG_SCOPE, DAMAGE_EFFECT_FLAG_KEY);
      if (effect.disabled || data?.kind !== "periodicDamage") continue;
      if (!effect.uuid || processingPeriodicEffectUuids.has(effect.uuid)) continue;
      const tickResult = collectPeriodicDamageEffectTicks(effect, data, now);
      if (!tickResult.entries.length && !tickResult.update && !tickResult.deleteEffectId) continue;
      processingPeriodicEffectUuids.add(effect.uuid);
      lockedEffectUuids.add(effect.uuid);
      entries.push(...tickResult.entries);
      if (tickResult.update) effectUpdates.push(tickResult.update);
      if (tickResult.deleteEffectId) effectDeleteIds.add(tickResult.deleteEffectId);
    }

    try {
      if (entries.length) await applyPeriodicDamageBatch(actor, entries);
      for (const update of effectUpdates) {
        if (effectDeleteIds.has(update.effectId)) continue;
        const effect = actor.effects?.get(update.effectId);
        if (!effect) continue;
        await updatePeriodicEffect(effect, update.data);
      }
      await deletePeriodicEffects(actor, Array.from(effectDeleteIds));
    } finally {
      for (const uuid of lockedEffectUuids) processingPeriodicEffectUuids.delete(uuid);
    }
  }
}

async function preserveTimedDamageEffects(deltaTime) {
  const elapsed = Math.max(0, Number(deltaTime) || 0);
  if (!elapsed) return;

  for (const actor of getLoadedActors()) {
    if (!actor?.isOwner) continue;
    for (const effect of Array.from(actor.effects ?? [])) {
      const data = effect.getFlag?.(TRAUMA_FLAG_SCOPE, DAMAGE_EFFECT_FLAG_KEY);
      if (!data || effect.disabled) continue;
      const updateData = buildIgnoredTimedDamageEffectUpdate(effect, data, elapsed);
      if (!Object.keys(updateData).length) continue;
      await updatePeriodicEffect(effect, updateData);
    }
  }
}

function buildIgnoredTimedDamageEffectUpdate(effect, data, elapsed) {
  if (data.kind === "periodicDamage") {
    const updateData = {};
    const startTime = Number(data.startTime);
    const endTime = Number(data.endTime);
    const nextTickTime = Number(data.nextTickTime);
    if (Number.isFinite(startTime)) updateData[`flags.${TRAUMA_FLAG_SCOPE}.${DAMAGE_EFFECT_FLAG_KEY}.startTime`] = startTime + elapsed;
    if (Number.isFinite(endTime)) updateData[`flags.${TRAUMA_FLAG_SCOPE}.${DAMAGE_EFFECT_FLAG_KEY}.endTime`] = endTime + elapsed;
    if (Number.isFinite(nextTickTime)) updateData[`flags.${TRAUMA_FLAG_SCOPE}.${DAMAGE_EFFECT_FLAG_KEY}.nextTickTime`] = nextTickTime + elapsed;
    return updateData;
  }

  if (data.kind === "resourceLimit" || data.kind === "resourceBlock") {
    const startTime = Number(effect.duration?.startTime);
    if (Number.isFinite(startTime)) return { "duration.startTime": startTime + elapsed };
  }

  return {};
}

function preventIgnoredTimedDamageEffectDeletion(effect, _options, _userId) {
  if (!getTimeMechanicsIgnored()) return undefined;
  const data = effect.getFlag?.(TRAUMA_FLAG_SCOPE, DAMAGE_EFFECT_FLAG_KEY);
  if (data?.kind !== "resourceLimit" && data?.kind !== "resourceBlock") return undefined;
  if (!Number(effect.duration?.seconds)) return undefined;
  const remaining = Number(effect.duration?.remaining);
  if (Number.isFinite(remaining) && remaining <= 0) return false;
  return undefined;
}

function collectPeriodicDamageEffectTicks(effect, data, now) {
  const intervalSeconds = Math.max(1, toInteger(data.intervalSeconds || ROUND_SECONDS));
  let remainingTicks = Math.max(0, toInteger(data.remainingTicks));
  let nextTickTime = Number(data.nextTickTime) || ((Number(data.startTime) || 0) + intervalSeconds);
  let dueTicks = 0;

  while (remainingTicks > 0 && now >= nextTickTime) {
    dueTicks += 1;
    remainingTicks -= 1;
    nextTickTime += intervalSeconds;
  }

  const entries = dueTicks > 0
    ? [{
      limbKey: data.limbKey,
      amount: roundDamageAmount((Number(data.amountPerTick) || 0) * dueTicks),
      damageTypeKey: data.damageTypeKey,
      scope: data.scope,
      source: {
        ...(data.source ?? {}),
        periodicDamageEffectUuid: effect.uuid,
        dueTicks
      }
    }]
    : [];
  const shouldDelete = remainingTicks <= 0 || (Number(data.endTime) && now >= Number(data.endTime) && dueTicks === 0);
  return {
    entries: entries.filter(entry => entry.amount > 0),
    update: !shouldDelete && dueTicks > 0
      ? {
        effectId: effect.id,
        data: {
          [`flags.${TRAUMA_FLAG_SCOPE}.${DAMAGE_EFFECT_FLAG_KEY}.remainingTicks`]: remainingTicks,
          [`flags.${TRAUMA_FLAG_SCOPE}.${DAMAGE_EFFECT_FLAG_KEY}.nextTickTime`]: nextTickTime
        }
      }
      : null,
    deleteEffectId: shouldDelete ? effect.id : ""
  };
}

async function updatePeriodicEffect(effect, updateData = {}) {
  try {
    if (!effect?.parent?.effects?.has(effect.id)) return;
    await effect.update(updateData);
  } catch (error) {
    if (!isMissingDocumentError(error)) throw error;
  }
}

async function deletePeriodicEffects(actor, effectIds = []) {
  const ids = Array.from(new Set(effectIds)).filter(id => actor.effects?.has(id));
  if (!ids.length) return;
  try {
    await actor.deleteEmbeddedDocuments("ActiveEffect", ids.filter(id => actor.effects?.has(id)));
  } catch (error) {
    if (!isMissingDocumentError(error)) throw error;
  }
}

function isMissingDocumentError(error) {
  return /does not exist/i.test(String(error?.message ?? error ?? ""));
}

async function applyPeriodicDamageBatch(actor, entries = []) {
  const damageTypes = getDamageTypeSettings();
  const normalizedEntries = combinePeriodicDamageEntries(entries)
    .map(entry => ({
      ...entry,
      amount: roundDamageAmount(entry.amount),
      scope: normalizeScope(entry.scope, entry.limbKey),
      damageType: damageTypes.find(damageType => damageType.key === entry.damageTypeKey) ?? null
    }))
    .filter(entry => entry.amount > 0);
  if (!normalizedEntries.length) return { actor, amount: 0, healthDelta: 0, limbDelta: 0, createdTraumas: [] };

  const updateData = {};
  const health = actor.health;
  const healthEntries = normalizedEntries.filter(entry => entry.scope === SCOPE_HEALTH || entry.scope === SCOPE_HEALTH_AND_LIMB);
  const requestedHealthDamage = healthEntries.reduce((sum, entry) => sum + entry.amount, 0);
  let actualHealthDelta = 0;
  if (health && requestedHealthDamage > 0) {
    const current = toInteger(health.value);
    const min = toInteger(health.min);
    const next = Math.max(min, current - requestedHealthDamage);
    actualHealthDelta = Math.max(0, current - next);
    updateData["system.resources.health.value"] = next;
  }

  const healthRatio = requestedHealthDamage > 0 ? actualHealthDelta / requestedHealthDamage : 0;
  const limbStates = new Map();
  const damageAccumulation = new Map();

  for (const entry of normalizedEntries) {
    const limb = entry.limbKey ? actor.system?.limbs?.[entry.limbKey] : null;
    if (!limb || (entry.scope !== SCOPE_LIMB && entry.scope !== SCOPE_HEALTH_AND_LIMB)) continue;

    const state = getBatchLimbState(limbStates, entry.limbKey, limb);
    const entryHealthDelta = entry.scope === SCOPE_HEALTH_AND_LIMB ? entry.amount * healthRatio : 0;
    const limbDamage = calculateLimbStateDamage(actor, limb, {
      healthDelta: entryHealthDelta,
      amount: entry.amount,
      scope: entry.scope,
      damageType: entry.damageType
    });
    if (!limbDamage) continue;

    const previousRunningValue = state.nextValue;
    state.nextValue = Math.max(state.min, state.nextValue - limbDamage);
    const actualLimbDelta = Math.max(0, previousRunningValue - state.nextValue);
    if (!actualLimbDelta) continue;

    state.totalDelta += actualLimbDelta;
    state.damageByType[entry.damageTypeKey || "untyped"] = (state.damageByType[entry.damageTypeKey || "untyped"] ?? 0) + actualLimbDelta;
    addBatchDamageAccumulation(damageAccumulation, actor, entry.limbKey, entry.damageTypeKey, actualLimbDelta);
  }

  for (const [limbKey, state] of limbStates) {
    if (!state.totalDelta) continue;
    updateData[`system.limbs.${limbKey}.value`] = state.nextValue;
  }
  for (const [limbKey, accumulation] of damageAccumulation) {
    updateData[`system.limbs.${limbKey}.damageAccumulation`] = normalizeDamageAccumulation(accumulation);
  }

  if (Object.keys(updateData).length) await actor.update(updateData);

  const createdTraumas = [];
  for (const [limbKey, state] of limbStates) {
    if (!state.totalDelta) continue;
    const [damageTypeKey, latestDamage] = Object.entries(state.damageByType)
      .sort((left, right) => right[1] - left[1])
      .at(0) ?? ["untyped", state.totalDelta];
    createdTraumas.push(...await createTriggeredTraumas(actor, {
      limbKey,
      damageTypeKey,
      previousValue: state.previousValue,
      nextValue: state.nextValue,
      latestDamage
    }));
  }

  return {
    actor,
    amount: normalizedEntries.reduce((sum, entry) => sum + entry.amount, 0),
    healthDelta: actualHealthDelta,
    limbDelta: Array.from(limbStates.values()).reduce((sum, state) => sum + state.totalDelta, 0),
    mode: MODE_DAMAGE,
    scope: SCOPE_HEALTH_AND_LIMB,
    createdTraumas
  };
}

function combinePeriodicDamageEntries(entries = []) {
  const combined = new Map();
  for (const entry of entries) {
    const key = [
      String(entry.limbKey ?? ""),
      String(entry.damageTypeKey ?? ""),
      String(entry.scope ?? SCOPE_HEALTH)
    ].join("\u0000");
    const current = combined.get(key);
    if (current) current.amount += Math.max(0, Number(entry.amount) || 0);
    else combined.set(key, {
      limbKey: String(entry.limbKey ?? ""),
      damageTypeKey: String(entry.damageTypeKey ?? ""),
      scope: String(entry.scope ?? SCOPE_HEALTH),
      amount: Math.max(0, Number(entry.amount) || 0)
    });
  }
  return Array.from(combined.values());
}

function getBatchLimbState(limbStates, limbKey, limb) {
  let state = limbStates.get(limbKey);
  if (state) return state;
  const previousValue = toInteger(limb.value);
  state = {
    previousValue,
    nextValue: previousValue,
    min: toInteger(limb.min),
    totalDelta: 0,
    damageByType: {}
  };
  limbStates.set(limbKey, state);
  return state;
}

function addBatchDamageAccumulation(accumulations, actor, limbKey, damageTypeKey, amount) {
  if (!amount) return;
  let accumulation = accumulations.get(limbKey);
  if (!accumulation) {
    accumulation = { ...(actor.system?.limbs?.[limbKey]?.damageAccumulation ?? {}) };
    accumulations.set(limbKey, accumulation);
  }
  const key = damageTypeKey || "untyped";
  accumulation[key] = Math.max(0, Number(accumulation[key]) || 0) + amount;
}

function normalizeDamageAccumulation(value = {}) {
  return Object.fromEntries(
    Object.entries(value ?? {})
      .map(([key, amount]) => [key, Math.max(0, Number(amount) || 0)])
      .filter(([_key, amount]) => amount > 0)
  );
}

function getLoadedActors() {
  const actors = new Map();
  for (const actor of game.actors?.contents ?? []) {
    if (actor?.uuid) actors.set(actor.uuid, actor);
  }
  for (const token of globalThis.canvas?.tokens?.placeables ?? []) {
    if (token.actor?.uuid && !actors.has(token.actor.uuid)) actors.set(token.actor.uuid, token.actor);
  }
  return actors.values();
}

function normalizeDamageRequest(request = {}) {
  const amount = Math.max(0, Math.floor(Number(request.amount) || 0));
  const limbKey = String(request.limbKey ?? "").trim();
  return {
    actorUuid: String(request.actorUuid ?? request.actor?.uuid ?? "").trim(),
    limbKey,
    amount,
    damageTypeKey: String(request.damageTypeKey ?? "").trim(),
    mode: request.mode === MODE_HEALING || request.mode === "heal" ? MODE_HEALING : MODE_DAMAGE,
    scope: normalizeScope(request.scope, limbKey),
    applyMitigation: request.applyMitigation !== false,
    processDamageTypeSettings: request.processDamageTypeSettings !== false,
    source: request.source && typeof request.source === "object" ? request.source : {},
    requesterUserId: String(request.requesterUserId ?? "")
  };
}

function normalizeScope(scope, limbKey = "") {
  if (scope === SCOPE_HEALTH) return SCOPE_HEALTH;
  if (scope === SCOPE_LIMB) return limbKey ? SCOPE_LIMB : SCOPE_HEALTH;
  return limbKey ? SCOPE_HEALTH_AND_LIMB : SCOPE_HEALTH;
}

function canApplyDamageLocally(actor) {
  return Boolean(game.user?.isGM || actor?.isOwner);
}

function getResponsibleGM() {
  return (game.users?.contents ?? [])
    .filter(user => user.active && user.isGM)
    .sort((left, right) => left.id.localeCompare(right.id))
    .at(0) ?? null;
}

function calculateEffectiveDamage(actor, amount, damageTypeKey = "", limbKey = "") {
  const incomingDamage = Math.max(0, Math.floor(Number(amount) || 0));
  if (!incomingDamage) return 0;
  if (!damageTypeKey) return incomingDamage;

  const resistance = actor.getDamageResistance?.(damageTypeKey, limbKey) ?? 0;
  const defense = Math.min(100, actor.getDamageDefense?.(damageTypeKey, limbKey) ?? 0);
  const reduction = actor.getDamageReduction?.(damageTypeKey, limbKey) ?? 0;
  const defendedDamage = Math.floor(incomingDamage * (1 - (defense / 100)));
  return Math.max(0, defendedDamage - resistance - reduction);
}

function applyLimbHealthMultiplier(actor, amount, damageType = null, limbKey = "") {
  const incomingDamage = Math.max(0, Number(amount) || 0);
  if (!incomingDamage || !limbKey) {
    return roundDamageAmount(incomingDamage);
  }
  const multiplier = Math.max(0, Number(actor.system?.limbs?.[limbKey]?.damageMultiplier) || 1);
  return roundDamageAmount(incomingDamage * multiplier);
}

function calculateLimbStateDamage(actor, limb, { healthDelta = 0, amount = 0, scope = SCOPE_LIMB, damageType = null } = {}) {
  const multiplier = Math.max(0, Number(damageType?.settings?.limbStateDamage?.multiplier) || 1);
  const health = actor.health;
  const healthMax = Math.max(0, toInteger(health?.max));
  const limbMax = Math.max(0, toInteger(limb?.max));
  const baseDamage = scope === SCOPE_HEALTH_AND_LIMB && healthMax > 0
    ? (Math.max(0, Number(healthDelta) || 0) / healthMax) * limbMax
    : Math.max(0, Number(amount) || 0);
  return roundDamageAmount(baseDamage * multiplier);
}

function roundDamageAmount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function buildAccumulationUpdate(actor, limbKey, damageTypeKey, amount, mode) {
  const limb = actor.system?.limbs?.[limbKey];
  const current = { ...(limb?.damageAccumulation ?? {}) };
  const update = {};
  if (!amount) return update;

  if (mode === MODE_DAMAGE) {
    const key = damageTypeKey || "untyped";
    current[key] = Math.max(0, Number(current[key]) || 0) + amount;
  } else {
    diluteDamageAccumulation(current, amount);
  }

  const normalized = Object.fromEntries(
    Object.entries(current)
      .map(([key, value]) => [key, Math.max(0, Number(value) || 0)])
      .filter(([_key, value]) => value > 0.0001)
  );

  update[`system.limbs.${limbKey}.damageAccumulation`] = normalized;
  return update;
}

function diluteDamageAccumulation(accumulation, healingAmount) {
  const total = Object.values(accumulation).reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
  if (total <= 0) return;
  const reduction = Math.min(total, Math.max(0, Number(healingAmount) || 0));
  for (const [key, value] of Object.entries(accumulation)) {
    const share = Math.max(0, Number(value) || 0) / total;
    accumulation[key] = Math.max(0, value - (reduction * share));
  }
}

async function createTriggeredTraumas(actor, { limbKey, damageTypeKey, previousValue, nextValue, latestDamage } = {}) {
  const limb = actor.system?.limbs?.[limbKey];
  if (!limb || toInteger(limb.max) <= 0) return [];

  const creatureOptions = getCreatureOptions();
  const damageTypes = getDamageTypeSettings();
  const traumaSettings = getTraumaSettings(creatureOptions, damageTypes);
  const traumaGroup = getTraumaGroupForActor(actor, traumaSettings, creatureOptions, damageTypes);
  const stages = traumaGroup.config?.limbs?.[limbKey]?.stages ?? [];
  if (!stages.length) return [];

  const max = toInteger(limb.max);
  const previousPercent = (previousValue / max) * 100;
  const nextPercent = (nextValue / max) * 100;
  const existingLimbTraumas = getActorTraumas(actor)
    .filter(item => item.system?.limbKey === limbKey);
  const triggeredStages = stages.filter(stage => (
    previousPercent > Number(stage.thresholdPercent)
    && nextPercent <= Number(stage.thresholdPercent)
    && !existingLimbTraumas.some(item => item.system?.stageId === stage.id)
  )).sort((left, right) => Number(right.thresholdPercent) - Number(left.thresholdPercent));
  if (!triggeredStages.length) return [];

  const snapshot = {
    ...(actor.system?.limbs?.[limbKey]?.damageAccumulation ?? {})
  };

  const progressionData = triggeredStages
    .map(stage => buildTraumaItemData(actor, {
      limb,
      limbKey,
      limbSetId: traumaGroup.id,
      stage,
      damageTypes,
      damageTypeKey,
      latestDamage,
      snapshot,
      nextValue
    }))
    .filter(Boolean);

  if (!progressionData.length) return [];
  const finalTraumaData = mergeEscalatedTraumaData({
    finalTraumaData: progressionData.at(-1),
    previousTraumas: existingLimbTraumas,
    intermediateTraumaData: progressionData.slice(0, -1),
    damageTypes
  });

  const created = await actor.createEmbeddedDocuments("Item", [finalTraumaData], {
    [TRAUMA_CREATE_OPTION]: true
  });
  if (existingLimbTraumas.length) {
    await actor.deleteEmbeddedDocuments("Item", existingLimbTraumas.map(item => item.id));
  }
  return created;
}

function buildTraumaItemData(actor, { limb, limbKey, limbSetId, stage, damageTypes, damageTypeKey, latestDamage, snapshot, nextValue }) {
  const profileEntry = selectTraumaProfile(stage, snapshot, damageTypeKey, latestDamage);
  if (!profileEntry) return null;

  const damageType = damageTypes.find(entry => entry.key === profileEntry.damageTypeKey);
  const thresholdPercent = toInteger(stage.thresholdPercent);
  const thresholdValue = Math.floor((toInteger(limb.max) * thresholdPercent) / 100);
  const limbLabel = String(limb.label ?? limbKey);
  const name = profileEntry.profile.name || `${limbLabel}: ${damageType?.label ?? profileEntry.damageTypeKey}`;
  const img = profileEntry.profile.img || "icons/svg/blood.svg";
  const effectChanges = (profileEntry.profile.effects ?? [])
    .map(prepareEffectChange)
    .filter(change => change.key);

  return {
    type: "trauma",
    name,
    img,
    system: {
      description: "",
      limbSetId,
      limbKey,
      limbLabel,
      stageId: stage.id,
      damageTypeKey: profileEntry.damageTypeKey,
      damageTypeLabel: damageType?.label ?? profileEntry.damageTypeKey,
      thresholdPercent,
      thresholdValue,
      triggeredAtValue: nextValue,
      healingDifficulty: toInteger(profileEntry.profile.healingDifficulty ?? 60),
      healingToolClass: String(profileEntry.profile.healingToolClass ?? "D").trim().toUpperCase() || "D",
      healingProgress: 0,
      healingProgressMax: toInteger(profileEntry.profile.healingProgress ?? 100),
      healingSkillKey: String(profileEntry.profile.healingSkillKey ?? "doctor").trim() || "doctor",
      damageSnapshot: snapshot,
      sources: [{
        limbKey,
        limbLabel,
        damageTypeKey: profileEntry.damageTypeKey,
        damageTypeLabel: damageType?.label ?? profileEntry.damageTypeKey,
        thresholdPercent
      }],
      generated: true,
      effects: effectChanges
    },
    flags: {
      [TRAUMA_FLAG_SCOPE]: {
        generatedTrauma: true,
        [TRAUMA_FLAG_KEY]: {
          actorUuid: actor.uuid,
          limbKey,
          stageId: stage.id
        }
      }
    },
    effects: [{
      type: "base",
      name,
      img,
      transfer: true,
      disabled: false,
      system: {
        changes: effectChanges
      },
      flags: {
        [TRAUMA_FLAG_SCOPE]: {
          kind: "active",
          traumaItem: true
        }
      }
    }]
  };
}

function prepareEffectChange(effect = {}) {
  const change = {
    key: String(effect.key ?? "").trim(),
    type: effect.type || "add",
    value: String(effect.value ?? "0"),
    phase: effect.phase || "initial"
  };
  const priority = Number(effect.priority);
  if (Number.isFinite(priority)) change.priority = Math.trunc(priority);
  return change;
}

function mergeEscalatedTraumaData({ finalTraumaData, previousTraumas = [], intermediateTraumaData = [], damageTypes = [] } = {}) {
  const effectChanges = [
    ...previousTraumas.flatMap(item => item.system?.effects ?? []),
    ...intermediateTraumaData.flatMap(data => data.system?.effects ?? []),
    ...(finalTraumaData.system?.effects ?? [])
  ].map(prepareEffectChange).filter(change => change.key);
  const damageTypeEntries = [
    ...previousTraumas.flatMap(item => getTraumaDamageTypeEntries(item, damageTypes)),
    ...intermediateTraumaData.map(data => ({
      key: data.system?.damageTypeKey ?? "",
      label: data.system?.damageTypeLabel ?? ""
    })),
    {
      key: finalTraumaData.system?.damageTypeKey ?? "",
      label: finalTraumaData.system?.damageTypeLabel ?? ""
    }
  ];
  const sources = [
    ...previousTraumas.flatMap(item => getTraumaSourceEntries(item, damageTypes)),
    ...intermediateTraumaData.flatMap(data => data.system?.sources?.length ? data.system.sources : [getTraumaSourceEntryFromData(data, damageTypes)]),
    ...(finalTraumaData.system?.sources?.length ? finalTraumaData.system.sources : [getTraumaSourceEntryFromData(finalTraumaData, damageTypes)])
  ].filter(source => source.limbLabel || source.damageTypeLabel);
  const combinedDamageTypes = combineDamageTypeEntries(damageTypeEntries, damageTypes);

  foundry.utils.setProperty(finalTraumaData, "system.effects", effectChanges);
  foundry.utils.setProperty(finalTraumaData, "system.damageTypeLabel", combinedDamageTypes.label);
  foundry.utils.setProperty(finalTraumaData, "system.sources", sources);
  if (combinedDamageTypes.key) foundry.utils.setProperty(finalTraumaData, "system.damageTypeKey", combinedDamageTypes.key);

  for (const effect of finalTraumaData.effects ?? []) {
    foundry.utils.setProperty(effect, "system.changes", effectChanges);
  }
  return finalTraumaData;
}

function getTraumaSourceEntries(item, damageTypes = []) {
  const sources = item.system?.sources;
  if (Array.isArray(sources) && sources.length) {
    return sources.map(source => normalizeTraumaSource(source, damageTypes));
  }
  return [normalizeTraumaSource({
    limbKey: item.system?.limbKey,
    limbLabel: item.system?.limbLabel,
    damageTypeKey: item.system?.damageTypeKey,
    damageTypeLabel: item.system?.damageTypeLabel,
    thresholdPercent: item.system?.thresholdPercent
  }, damageTypes)];
}

function getTraumaSourceEntryFromData(data, damageTypes = []) {
  return normalizeTraumaSource({
    limbKey: data.system?.limbKey,
    limbLabel: data.system?.limbLabel,
    damageTypeKey: data.system?.damageTypeKey,
    damageTypeLabel: data.system?.damageTypeLabel,
    thresholdPercent: data.system?.thresholdPercent
  }, damageTypes);
}

function normalizeTraumaSource(source = {}, damageTypes = []) {
  const damageTypeKey = String(source.damageTypeKey ?? "").trim();
  return {
    limbKey: String(source.limbKey ?? "").trim(),
    limbLabel: String(source.limbLabel ?? source.limbKey ?? "").trim(),
    damageTypeKey,
    damageTypeLabel: String(source.damageTypeLabel ?? "").trim() || damageTypes.find(type => type.key === damageTypeKey)?.label || damageTypeKey,
    thresholdPercent: Math.max(0, Math.min(100, toInteger(source.thresholdPercent)))
  };
}

function getTraumaDamageTypeEntries(item, damageTypes = []) {
  const keyParts = splitCombinedDamageTypeValue(item.system?.damageTypeKey);
  const labelParts = splitCombinedDamageTypeValue(item.system?.damageTypeLabel);
  const entries = [];
  const maxLength = Math.max(keyParts.length, labelParts.length, 1);

  for (let index = 0; index < maxLength; index += 1) {
    const key = keyParts[index] ?? "";
    const label = labelParts[index]
      ?? damageTypes.find(type => type.key === key)?.label
      ?? key;
    if (key || label) entries.push({ key, label });
  }
  return entries;
}

function splitCombinedDamageTypeValue(value) {
  return String(value ?? "")
    .split(/\s*(?:\/|\+|,)\s*|\s+\u0438\s+/iu)
    .map(part => part.trim())
    .filter(Boolean);
}

function combineDamageTypeEntries(entries = [], damageTypes = []) {
  const combined = [];
  const seen = new Set();
  for (const entry of entries) {
    const key = String(entry.key ?? "").trim();
    const label = String(entry.label ?? "").trim() || damageTypes.find(type => type.key === key)?.label || key;
    const uniqueKey = key || label.toLocaleLowerCase();
    if (!uniqueKey || seen.has(uniqueKey)) continue;
    seen.add(uniqueKey);
    combined.push({ key, label });
  }

  return {
    key: combined.map(entry => entry.key).filter(Boolean).join("/"),
    label: combined.map(entry => entry.label).filter(Boolean).join(" / ")
  };
}

function selectTraumaProfile(stage, snapshot = {}, latestDamageTypeKey = "", latestDamage = 0) {
  const weighted = Object.entries(snapshot ?? {})
    .map(([key, value]) => [key, Math.max(0, Number(value) || 0) + (key === latestDamageTypeKey ? Math.max(0, Number(latestDamage) || 0) : 0)])
    .sort((left, right) => right[1] - left[1]);
  if (latestDamageTypeKey && !weighted.some(([key]) => key === latestDamageTypeKey)) {
    weighted.push([latestDamageTypeKey, Math.max(0, Number(latestDamage) || 0)]);
  }

  for (const [damageTypeKey] of weighted) {
    const profile = stage.profiles?.[damageTypeKey];
    if (isConfiguredProfile(profile)) return { damageTypeKey, profile };
  }
  return null;
}

function isConfiguredProfile(profile) {
  if (!profile) return false;
  return Boolean(String(profile.name ?? "").trim() || String(profile.img ?? "").trim() || profile.effects?.length);
}
