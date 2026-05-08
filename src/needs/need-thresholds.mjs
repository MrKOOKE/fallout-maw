import { DISEASE_CREATE_OPTION, SYSTEM_ID } from "../constants.mjs";
import { getDiseaseSettings, getNeedSettings } from "../settings/accessors.mjs";
import { toInteger } from "../utils/numbers.mjs";

const NEED_EFFECT_FLAG_KEY = "needEffect";
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
  Hooks.on("updateWorldTime", processDiseaseWorldTime);
}

export async function processActorNeedThresholds(actor) {
  if (!actor || !game.user?.isActiveGM) return;
  if (processingActors.has(actor.uuid)) return;
  processingActors.add(actor.uuid);
  try {
    for (const need of getNeedSettings()) {
      await processSingleNeed(actor, need);
    }
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

async function processDiseaseWorldTime(worldTime, deltaTime) {
  if (!game.user?.isActiveGM || Number(deltaTime) <= 0) return;
  const now = Number(worldTime) || Number(game.time?.worldTime) || 0;
  for (const actor of getLoadedActors()) {
    if (!actor?.isOwner) continue;
    await processActorDiseaseWorsening(actor, now);
    await processActorNeedThresholds(actor);
  }
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

async function ensureDiseaseForNeedLevel(actor, need, threshold) {
  const configuredLevel = Math.max(0, toInteger(threshold.diseaseLevel));
  const level = need.key === "radcont" ? Math.min(configuredLevel, 1) : configuredLevel;
  if (!level) return;
  if (hasDiseaseImmunity(actor, need.key)) return;

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
  const needKey = String(disease?.system?.needKey ?? "");
  if (!needKey) return [];
  const diseaseId = String(disease?.system?.diseaseId ?? "");
  const existingIds = actor.effects
    .filter(effect => {
      const data = effect.getFlag(SYSTEM_ID, DISEASE_IMMUNITY_FLAG_KEY);
      return data?.needKey === needKey && (!diseaseId || data?.diseaseId === diseaseId);
    })
    .map(effect => effect.id);
  if (existingIds.length) await actor.deleteEmbeddedDocuments("ActiveEffect", existingIds);

  const startTime = Number(game.time?.worldTime) || 0;
  return actor.createEmbeddedDocuments("ActiveEffect", [{
    type: "base",
    name: `Иммунитет: ${disease.name}`,
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
          needKey,
          diseaseId,
          untilTime: startTime + DISEASE_IMMUNITY_SECONDS
        }
      }
    }
  }]);
}

function hasDiseaseImmunity(actor, needKey) {
  const now = Number(game.time?.worldTime) || 0;
  return Array.from(actor.effects ?? []).some(effect => {
    if (effect.disabled) return false;
    const data = effect.getFlag(SYSTEM_ID, DISEASE_IMMUNITY_FLAG_KEY);
    if (data?.needKey !== needKey) return false;
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
