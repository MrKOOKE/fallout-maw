import { DISEASE_CREATE_OPTION, SYSTEM_ID } from "../constants.mjs";
import { getDiseaseSettings, getNeedSettings } from "../settings/accessors.mjs";
import { toInteger } from "../utils/numbers.mjs";

const NEED_EFFECT_FLAG_KEY = "needEffect";
const DISEASE_FLAG_KEY = "disease";
const processingActors = new Set();

export function registerNeedThresholdHooks() {
  Hooks.on("updateActor", (actor, changes) => {
    if (!game.user?.isActiveGM) return;
    if (!foundry.utils.hasProperty(changes ?? {}, "system.needs")) return;
    void processActorNeedThresholds(actor);
  });
}

export async function processActorNeedThresholds(actor) {
  if (!actor || !game.user?.isActiveGM) return;
  if (processingActors.has(actor.uuid)) return;
  processingActors.add(actor.uuid);
  try {
    for (const need of getNeedSettings()) {
      await processSingleNeed(actor, need);
    }
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
  const level = Math.max(0, toInteger(threshold.diseaseLevel));
  if (!level) return;

  const diseaseSettings = getDiseaseSettings();
  const existingDiseases = actor.items.filter(item => item.type === "disease" && item.system?.needKey === need.key);
  const sameDisease = existingDiseases.find(item => findDiseaseStage(diseaseSettings, item.system?.diseaseId, level));
  if (sameDisease) {
    if (toInteger(sameDisease.system?.level) < level) {
      await updateDiseaseToLevel(actor, sameDisease, need, diseaseSettings, level, threshold);
    }
    return;
  }

  const candidates = (diseaseSettings.diseases ?? [])
    .map(disease => ({ disease, stage: findDiseaseStage(diseaseSettings, disease.id, level) }))
    .filter(entry => entry.stage);
  if (!candidates.length) return;

  const selected = candidates[Math.floor(Math.random() * candidates.length)];
  await actor.createEmbeddedDocuments("Item", [buildDiseaseItemData(actor, need, selected.disease, selected.stage, threshold)], {
    [DISEASE_CREATE_OPTION]: true
  });
}

async function updateDiseaseToLevel(actor, item, need, diseaseSettings, level, threshold) {
  const disease = (diseaseSettings.diseases ?? []).find(entry => entry.id === item.system?.diseaseId);
  const stage = findDiseaseStage(diseaseSettings, item.system?.diseaseId, level);
  if (!disease || !stage) return;
  const data = buildDiseaseItemData(actor, need, disease, stage, threshold);
  await item.update({
    name: data.name,
    img: data.img,
    system: data.system,
    flags: data.flags
  });
  const oldIds = item.effects.map(effect => effect.id);
  if (oldIds.length) await item.deleteEmbeddedDocuments("ActiveEffect", oldIds);
  if (data.effects?.length) await item.createEmbeddedDocuments("ActiveEffect", data.effects);
}

function findDiseaseStage(diseaseSettings, diseaseId, level) {
  const disease = (diseaseSettings.diseases ?? []).find(entry => entry.id === diseaseId);
  return disease?.stages?.find(stage => toInteger(stage.level) === toInteger(level)) ?? null;
}

function buildDiseaseItemData(actor, need, disease, stage, threshold) {
  const name = stage.name || disease.name || `${need.label}: болезнь ${stage.level}`;
  const img = stage.img || disease.img || "icons/svg/biohazard.svg";
  const effects = (stage.effects ?? []).map(prepareEffectChange).filter(change => change.key);
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
          thresholdPercent: toInteger(threshold.percent)
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
