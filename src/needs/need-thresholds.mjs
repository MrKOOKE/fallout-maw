import { DISEASE_CREATE_OPTION, SYSTEM_ID } from "../constants.mjs";
import {
  getActorNeedSettings,
  getDiseaseSettings,
  getTimeMechanicsIgnored,
  getTimeNeedsPlayersOnly
} from "../settings/accessors.mjs";
import { registerQueuedWorldTimeProcessor } from "../time/world-time-queue.mjs";
import {
  applyRestTimeMultiplier,
  getActorTimeSegments,
  isCampRestParticipant,
  isTimeMechanicsForced
} from "../time/rest-context.mjs";
import { toInteger } from "../utils/numbers.mjs";
const NEED_EFFECT_FLAG_KEY = "needEffect";
const NEED_ACCUMULATION_REMAINDER_FLAG_KEY = "needAccumulationRemainder";
const DISEASE_FLAG_KEY = "disease";
export const DISEASE_IMMUNITY_FLAG_KEY = "diseaseImmunity";
const DISEASE_WORSENING_PROGRESS_MAX = 100;
const DEFAULT_DISEASE_WORSENING_SECONDS = 24 * 60 * 60;
const DISEASE_IMMUNITY_SECONDS = 24 * 60 * 60;
const processingActors = new Set();

export function registerNeedThresholdHooks() {
  Hooks.on("updateActor", (actor, changes) => {
    if (!game.user?.isActiveGM) return;
    if (!foundry.utils.hasProperty(changes ?? {}, "system.needs")) return;
    void processActorNeedThresholds(actor);
  });
  registerQueuedWorldTimeProcessor(processDiseaseWorldTime);
  Hooks.on("preDeleteActiveEffect", preventIgnoredDiseaseImmunityDeletion);
}

export async function processActorNeedThresholds(actor) {
  if (!actor || !game.user?.isActiveGM) return;
  if (processingActors.has(actor.uuid)) return;
  processingActors.add(actor.uuid);
  try {
    const needSettings = getActorNeedSettings(actor);
    const activeNeedKeys = new Set(needSettings.map(need => need.key));
    for (const need of needSettings) {
      await processSingleNeed(actor, need);
    }
    await deleteStaleNeedThresholdEffects(actor, activeNeedKeys);
    await syncActorDiseaseWorseningMultipliers(actor);
  } finally {
    processingActors.delete(actor.uuid);
  }
}

async function processSingleNeed(actor, need) {
  const resource = actor.system?.needs?.[need.key];
  if (!resource) {
    await deleteNeedThresholdEffects(actor, need.key);
    return;
  }

  const percent = getNeedPercent(resource);
  const thresholds = [...(need.settings?.thresholds ?? [])].sort((left, right) => Number(left.percent) - Number(right.percent));
  const active = thresholds.filter(threshold => percent >= Number(threshold.percent)).at(-1) ?? null;
  await syncNeedPenaltyEffect(actor, need, active);
  if (active?.diseaseLevel > 0) await ensureDiseaseForNeedLevel(actor, need, active);
}

async function processDiseaseWorldTime(worldTime, deltaTime, options) {
  const dtIn = Number(deltaTime) || 0;
  if (!game.user?.isActiveGM || dtIn <= 0) return;
  if (getTimeMechanicsIgnored() && !isTimeMechanicsForced(options)) {
    await preserveDiseaseTimedEffects(dtIn);
    return;
  }
  const clock = Number(game.time?.worldTime) || 0;
  let wt = Number(worldTime) || 0;
  let dt = dtIn;
  if (clock > wt) {
    dt += clock - wt;
    wt = clock;
  }
  const now = wt;
  const elapsedSeconds = dt;
  for (const actor of getLoadedActors()) {
    if (!actor?.isOwner) continue;
    if (!getTimeNeedsPlayersOnly() || hasPlayerOwner(actor) || isCampRestParticipant(actor, options)) {
      for (const segment of getActorTimeSegments(actor, elapsedSeconds, options)) {
        await processActorNeedAccumulation(actor, segment.seconds, {
          restMode: segment.restMode,
          effects: segment.effects
        });
      }
    }
    await processActorDiseaseWorsening(actor, now);
    await processActorNeedThresholds(actor);
  }
}

async function processActorNeedAccumulation(actor, elapsedSeconds, { restMode = false, effects = [] } = {}) {
  const updateData = {};
  const remainders = foundry.utils.deepClone(actor.getFlag(SYSTEM_ID, NEED_ACCUMULATION_REMAINDER_FLAG_KEY) ?? {});
  const initialRemainders = JSON.stringify(remainders);
  const effectRates = collectNeedEffectRates(effects);
  for (const need of getActorNeedSettings(actor)) {
    const basePerHour = Math.max(0, Number(need.settings?.accumulation?.perHour) || 0);
    const perHour = applyRestTimeMultiplier(basePerHour, restMode)
      + (effectRates.get(need.key) ?? []).reduce((total, rate) => total + applyRestTimeMultiplier(rate, restMode), 0);
    if (!perHour) continue;
    const resource = actor.system?.needs?.[need.key];
    if (!resource) continue;

    const min = toInteger(resource.min);
    const max = Math.max(min, toInteger(resource.max));
    const current = Math.min(max, Math.max(min, toInteger(resource.value)));
    if ((perHour > 0 && current >= max) || (perHour < 0 && current <= min)) {
      remainders[need.key] = 0;
      continue;
    }

    const accumulated = (Number(remainders[need.key]) || 0) + ((perHour * elapsedSeconds) / 3600);
    const whole = accumulated >= 0 ? Math.floor(accumulated) : Math.ceil(accumulated);
    remainders[need.key] = accumulated - whole;
    if (!whole) continue;

    const next = Math.min(max, Math.max(min, current + whole));
    if ((whole > 0 && next >= max) || (whole < 0 && next <= min)) remainders[need.key] = 0;
    if (next !== current) updateData[`system.needs.${need.key}.value`] = next;
  }
  if (JSON.stringify(remainders) !== initialRemainders) {
    updateData[`flags.${SYSTEM_ID}.${NEED_ACCUMULATION_REMAINDER_FLAG_KEY}`] = remainders;
  }
  if (Object.keys(updateData).length) await actor.update(updateData);
}

function collectNeedEffectRates(effects = []) {
  const rates = new Map();
  for (const effect of effects) {
    const needKey = String(effect?.needKey ?? effect?.key ?? "").trim();
    if (!needKey) continue;
    const perHour = Number(effect?.perHour ?? effect?.value) || 0;
    if (!perHour) continue;
    if (!rates.has(needKey)) rates.set(needKey, []);
    rates.get(needKey).push(perHour);
  }
  return rates;
}

async function preserveDiseaseTimedEffects(deltaTime) {
  const elapsed = Math.max(0, Number(deltaTime) || 0);
  if (!elapsed) return;

  for (const actor of getLoadedActors()) {
    if (!actor?.isOwner) continue;
    for (const effect of Array.from(actor.effects ?? [])) {
      const data = effect.getFlag(SYSTEM_ID, DISEASE_IMMUNITY_FLAG_KEY);
      if (!data || effect.disabled) continue;
      const startTime = Number(effect.duration?.startTime);
      const untilTime = Number(data.untilTime);
      const updateData = {};
      if (Number.isFinite(startTime)) updateData["duration.startTime"] = startTime + elapsed;
      if (Number.isFinite(untilTime)) updateData[`flags.${SYSTEM_ID}.${DISEASE_IMMUNITY_FLAG_KEY}.untilTime`] = untilTime + elapsed;
      if (Object.keys(updateData).length) await effect.update(updateData);
    }
  }
}

function preventIgnoredDiseaseImmunityDeletion(effect, _options, _userId) {
  if (!getTimeMechanicsIgnored()) return undefined;
  const data = effect.getFlag?.(SYSTEM_ID, DISEASE_IMMUNITY_FLAG_KEY);
  if (!data) return undefined;
  if (!Number(effect.duration?.seconds)) return undefined;
  const remaining = Number(effect.duration?.remaining);
  if (Number.isFinite(remaining) && remaining <= 0) return false;
  return undefined;
}

function getNeedPercent(resource) {
  const min = toInteger(resource.min);
  const max = Math.max(min, toInteger(resource.max));
  const value = Math.min(max, Math.max(min, toInteger(resource.value)));
  const range = Math.max(1, max - min);
  return ((value - min) / range) * 100;
}

async function syncNeedPenaltyEffect(actor, need, threshold) {
  const existing = actor.effects.filter(effect => effect.getFlag(SYSTEM_ID, NEED_EFFECT_FLAG_KEY)?.needKey === need.key);
  const changes = (threshold?.effects ?? []).map(prepareEffectChange).filter(change => change.key);
  if (!threshold || !changes.length) {
    if (existing.length) await actor.deleteEmbeddedDocuments("ActiveEffect", existing.map(effect => effect.id));
    return;
  }

  const signature = JSON.stringify({ thresholdId: threshold.id, changes });
  const current = existing.find(effect => effect.getFlag(SYSTEM_ID, NEED_EFFECT_FLAG_KEY)?.signature === signature);
  const obsolete = existing.filter(effect => effect.id !== current?.id);
  if (obsolete.length) await actor.deleteEmbeddedDocuments("ActiveEffect", obsolete.map(effect => effect.id));
  if (current) return;

  await actor.createEmbeddedDocuments("ActiveEffect", [{
    type: "base",
    name: `${need.label}: ${Math.trunc(Number(threshold.percent) || 0)}%`,
    img: "icons/svg/downgrade.svg",
    transfer: false,
    disabled: false,
    system: { changes },
    flags: {
      [SYSTEM_ID]: {
        kind: "active",
        [NEED_EFFECT_FLAG_KEY]: {
          needKey: need.key,
          thresholdId: threshold.id,
          signature
        }
      }
    }
  }]);
}

async function deleteNeedThresholdEffects(actor, needKey) {
  const ids = actor.effects
    .filter(effect => effect.getFlag(SYSTEM_ID, NEED_EFFECT_FLAG_KEY)?.needKey === needKey)
    .map(effect => effect.id);
  if (ids.length) await actor.deleteEmbeddedDocuments("ActiveEffect", ids);
}

async function deleteStaleNeedThresholdEffects(actor, activeNeedKeys) {
  const ids = actor.effects
    .filter(effect => {
      const needKey = effect.getFlag(SYSTEM_ID, NEED_EFFECT_FLAG_KEY)?.needKey;
      return needKey && !activeNeedKeys.has(needKey);
    })
    .map(effect => effect.id);
  if (ids.length) await actor.deleteEmbeddedDocuments("ActiveEffect", ids);
}

async function ensureDiseaseForNeedLevel(actor, need, threshold) {
  const configuredLevel = Math.max(0, toInteger(threshold.diseaseLevel));
  const level = need.key === "radcont" ? Math.min(configuredLevel, 1) : configuredLevel;
  if (!level) return;
  if (hasDiseaseImmunity(actor, level)) return;

  const diseaseSettings = getDiseaseSettings();
  const existingDiseases = actor.items.filter(item => item.type === "disease" && item.system?.needKey === need.key);
  if (existingDiseases.length) return;

  const candidates = (diseaseSettings.diseases ?? [])
    .map(disease => ({ disease, stage: findDiseaseStage(diseaseSettings, disease.id, level) }))
    .filter(entry => entry.stage);
  if (!candidates.length) return;

  const selected = candidates[Math.floor(Math.random() * candidates.length)];
  const diseaseThreshold = need.key === "radcont" ? { ...threshold, percent: 25, diseaseLevel: 1 } : threshold;
  await actor.createEmbeddedDocuments("Item", [buildDiseaseItemData(actor, need, selected.disease, selected.stage, diseaseThreshold)], {
    [DISEASE_CREATE_OPTION]: true
  });
}

function findDiseaseStage(diseaseSettings, diseaseId, level) {
  const disease = (diseaseSettings.diseases ?? []).find(entry => entry.id === diseaseId);
  return disease?.stages?.find(stage => toInteger(stage.level) === toInteger(level)) ?? null;
}

function getNextDiseaseStage(disease, currentLevel) {
  return [...(disease?.stages ?? [])]
    .filter(stage => toInteger(stage.level) > toInteger(currentLevel))
    .sort((left, right) => toInteger(left.level) - toInteger(right.level))
    .at(0) ?? null;
}

function buildDiseaseItemData(actor, need, disease, stage, threshold) {
  const name = stage.name || disease.name || `${need.label}: болезнь ${stage.level}`;
  const img = stage.img || disease.img || "icons/svg/biohazard.svg";
  const effects = (stage.effects ?? []).map(prepareEffectChange).filter(change => change.key);
  const now = Number(game.time?.worldTime) || 0;
  const worseningMultiplier = calculateDiseaseWorseningMultiplier(actor, need.key);
  return {
    type: "disease",
    name,
    img,
    system: {
      description: "",
      needKey: need.key,
      needLabel: need.label,
      diseaseId: disease.id,
      stageId: stage.id,
      level: toInteger(stage.level),
      thresholdPercent: toInteger(threshold.percent),
      worseningProgress: 0,
      worseningProgressMax: DISEASE_WORSENING_PROGRESS_MAX,
      worseningBaseSeconds: getStageWorseningSeconds(stage),
      lastWorseningTime: now,
      worseningMultiplier,
      healingDifficulty: toInteger(stage.healingDifficulty ?? 60),
      healingToolClass: String(stage.healingToolClass ?? "D").trim().toUpperCase() || "D",
      healingProgress: 0,
      healingProgressMax: toInteger(stage.healingProgress ?? 100),
      healingSkillKey: String(stage.healingSkillKey ?? "doctor").trim() || "doctor",
      generated: true,
      effects
    },
    flags: {
      [SYSTEM_ID]: {
        generatedDisease: true,
        [DISEASE_FLAG_KEY]: {
          actorUuid: actor.uuid,
          needKey: need.key,
          diseaseId: disease.id,
          stageId: stage.id,
          level: toInteger(stage.level),
          thresholdPercent: toInteger(threshold.percent),
          lastWorseningTime: now
        }
      }
    },
    effects: [{
      type: "base",
      name,
      img,
      transfer: true,
      disabled: false,
      system: { changes: effects },
      flags: {
        [SYSTEM_ID]: {
          kind: "active",
          diseaseItem: true
        }
      }
    }]
  };
}

async function processActorDiseaseWorsening(actor, now) {
  const diseaseSettings = getDiseaseSettings();
  for (const item of Array.from(actor.items?.filter(entry => entry.type === "disease") ?? [])) {
    await processSingleDiseaseWorsening(actor, item, diseaseSettings, now);
  }
}

async function processSingleDiseaseWorsening(actor, item, diseaseSettings, now) {
  const disease = (diseaseSettings.diseases ?? []).find(entry => entry.id === item.system?.diseaseId);
  if (!disease) return;

  let stage = findDiseaseStage(diseaseSettings, item.system?.diseaseId, item.system?.level)
    ?? disease.stages?.find(entry => entry.id === item.system?.stageId)
    ?? null;
  if (!stage) return;

  const needKey = String(item.system?.needKey ?? "");
  const multiplier = calculateDiseaseWorseningMultiplier(actor, needKey);
  const lastTime = Number(item.system?.lastWorseningTime) || now;
  let remainingSeconds = Math.max(0, now - lastTime);
  let progress = Math.max(0, Math.min(DISEASE_WORSENING_PROGRESS_MAX, Number(item.system?.worseningProgress) || 0));
  let stageChanged = false;

  while (remainingSeconds > 0) {
    const baseSeconds = getStageWorseningSeconds(stage, item.system?.worseningBaseSeconds);
    const percentPerSecond = (DISEASE_WORSENING_PROGRESS_MAX * multiplier) / baseSeconds;
    const nextStage = getNextDiseaseStage(disease, stage.level);
    if (!nextStage) {
      progress = Math.min(DISEASE_WORSENING_PROGRESS_MAX, progress + (remainingSeconds * percentPerSecond));
      remainingSeconds = 0;
      break;
    }

    const secondsToNext = (DISEASE_WORSENING_PROGRESS_MAX - progress) / percentPerSecond;
    if (remainingSeconds < secondsToNext) {
      progress += remainingSeconds * percentPerSecond;
      remainingSeconds = 0;
      break;
    }

    remainingSeconds -= secondsToNext;
    stage = nextStage;
    progress = 0;
    stageChanged = true;
  }

  const updateData = {
    "system.worseningProgress": normalizeProgress(progress),
    "system.worseningProgressMax": DISEASE_WORSENING_PROGRESS_MAX,
    "system.worseningBaseSeconds": getStageWorseningSeconds(stage, item.system?.worseningBaseSeconds),
    "system.lastWorseningTime": now,
    "system.worseningMultiplier": multiplier
  };

  if (!stageChanged) {
    await item.update(updateData);
    return;
  }

  const stageData = buildDiseaseStageUpdateData(actor, item, disease, stage, updateData);
  await item.update(stageData.update);
  const oldIds = item.effects.map(effect => effect.id);
  if (oldIds.length) await item.deleteEmbeddedDocuments("ActiveEffect", oldIds);
  if (stageData.effects.length) await item.createEmbeddedDocuments("ActiveEffect", stageData.effects);
}

function buildDiseaseStageUpdateData(actor, item, disease, stage, baseUpdate = {}) {
  const name = stage.name || disease.name || item.name;
  const img = stage.img || disease.img || item.img || "icons/svg/biohazard.svg";
  const effects = (stage.effects ?? []).map(prepareEffectChange).filter(change => change.key);
  return {
    update: {
      name,
      img,
      ...baseUpdate,
      "system.stageId": stage.id,
      "system.level": toInteger(stage.level),
      "system.healingDifficulty": toInteger(stage.healingDifficulty ?? 60),
      "system.healingToolClass": String(stage.healingToolClass ?? "D").trim().toUpperCase() || "D",
      "system.healingProgress": 0,
      "system.healingProgressMax": toInteger(stage.healingProgress ?? 100),
      "system.healingSkillKey": String(stage.healingSkillKey ?? "doctor").trim() || "doctor",
      "system.effects": effects,
      [`flags.${SYSTEM_ID}.${DISEASE_FLAG_KEY}.stageId`]: stage.id,
      [`flags.${SYSTEM_ID}.${DISEASE_FLAG_KEY}.level`]: toInteger(stage.level),
      [`flags.${SYSTEM_ID}.${DISEASE_FLAG_KEY}.lastWorseningTime`]: baseUpdate["system.lastWorseningTime"]
    },
    effects: [{
      type: "base",
      name,
      img,
      transfer: true,
      disabled: false,
      system: { changes: effects },
      flags: {
        [SYSTEM_ID]: {
          kind: "active",
          diseaseItem: true
        }
      }
    }]
  };
}

function getStageWorseningSeconds(stage, fallback = DEFAULT_DISEASE_WORSENING_SECONDS) {
  const hours = Math.max(0, Number(stage?.worseningHours) || 0);
  if (hours > 0) return Math.max(1, Math.trunc(hours * 60 * 60));
  return Math.max(1, toInteger(fallback) || DEFAULT_DISEASE_WORSENING_SECONDS);
}

function calculateDiseaseWorseningMultiplier(actor, needKey) {
  const need = actor?.system?.needs?.[needKey];
  if (!need) return 1;
  const percent = getNeedPercent(need);
  return Math.max(1, Math.floor(percent / 10) * 2);
}

function hasPlayerOwner(actor) {
  return Array.from(game.users ?? []).some(user => !user.isGM && actor.testUserPermission(user, "OWNER"));
}

async function syncActorDiseaseWorseningMultipliers(actor) {
  const updates = [];
  for (const item of actor.items?.filter(entry => entry.type === "disease") ?? []) {
    const multiplier = calculateDiseaseWorseningMultiplier(actor, String(item.system?.needKey ?? ""));
    if (Number(item.system?.worseningMultiplier) === multiplier) continue;
    updates.push({ _id: item.id, "system.worseningMultiplier": multiplier });
  }
  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
}

function normalizeProgress(value) {
  const number = Math.max(0, Math.min(DISEASE_WORSENING_PROGRESS_MAX, Number(value) || 0));
  return Math.round(number * 100) / 100;
}

export async function createDiseaseImmunityEffect(actor, disease) {
  if (!actor) return [];
  const activeLevel = Math.max(1, toInteger(disease?.system?.level));
  const existingLevels = [];
  const existingIds = actor.effects
    .filter(effect => {
      const data = effect.getFlag(SYSTEM_ID, DISEASE_IMMUNITY_FLAG_KEY);
      const maxLevel = toInteger(data?.maxLevel);
      if (maxLevel <= 0) return false;
      existingLevels.push(maxLevel);
      return true;
    })
    .map(effect => effect.id);
  if (existingIds.length) await actor.deleteEmbeddedDocuments("ActiveEffect", existingIds);

  const maxLevel = Math.max(activeLevel, ...existingLevels);
  const startTime = Number(game.time?.worldTime) || 0;
  return actor.createEmbeddedDocuments("ActiveEffect", [{
    type: "base",
    name: game.i18n.format("FALLOUTMAW.Disease.ImmunityName", { level: maxLevel }),
    img: "icons/magic/life/crosses-trio-red.webp",
    transfer: false,
    disabled: false,
    duration: {
      seconds: DISEASE_IMMUNITY_SECONDS,
      startTime
    },
    system: { changes: [] },
    flags: {
      [SYSTEM_ID]: {
        kind: "temporary",
        [DISEASE_IMMUNITY_FLAG_KEY]: {
          maxLevel,
          untilTime: startTime + DISEASE_IMMUNITY_SECONDS
        }
      }
    }
  }]);
}

function hasDiseaseImmunity(actor, diseaseLevel) {
  const level = Math.max(1, toInteger(diseaseLevel));
  const now = Number(game.time?.worldTime) || 0;
  return Array.from(actor.effects ?? []).some(effect => {
    if (effect.disabled) return false;
    const data = effect.getFlag(SYSTEM_ID, DISEASE_IMMUNITY_FLAG_KEY);
    if (toInteger(data?.maxLevel) < level) return false;
    const untilTime = Number(data.untilTime) || 0;
    return !untilTime || untilTime > now;
  });
}

function getLoadedActors() {
  const actors = new Map();
  for (const actor of game.actors ?? []) actors.set(actor.uuid, actor);
  for (const token of canvas?.tokens?.placeables ?? []) {
    if (token.actor) actors.set(token.actor.uuid, token.actor);
  }
  return Array.from(actors.values());
}

function prepareEffectChange(effect = {}) {
  const change = {
    key: String(effect.key ?? "").trim(),
    type: String(effect.type ?? "add").trim() || "add",
    value: String(effect.value ?? "0"),
    phase: String(effect.phase ?? "initial").trim() || "initial"
  };
  const priority = Number(effect.priority);
  if (Number.isFinite(priority)) change.priority = Math.trunc(priority);
  return change;
}
