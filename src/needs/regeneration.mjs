import { SYSTEM_ID } from "../constants.mjs";
import { requestDamageApplication } from "../combat/damage-hub.mjs";
import { evaluateFormula, getSkillValues } from "../formulas/index.mjs";
import { createDiseaseImmunityEffect } from "./need-thresholds.mjs";
import {
  getCharacteristicSettings,
  getCreatureOptions,
  getSkillSettings,
  getTimeMechanicsIgnored
} from "../settings/accessors.mjs";
import { DEFAULT_REGENERATION_FORMULA } from "../settings/creature-options.mjs";
import { registerQueuedWorldTimeProcessor } from "../time/world-time-queue.mjs";
import { toInteger } from "../utils/numbers.mjs";

const REGENERATION_HOUR_SECONDS = 60 * 60;

export function registerRegenerationHooks() {
  registerQueuedWorldTimeProcessor(processRegenerationWorldTime, { priority: -10 });
}

async function processRegenerationWorldTime(worldTime, deltaTime) {
  if (!game.user?.isActiveGM) return;
  if (getTimeMechanicsIgnored()) return;

  const tickCount = countCrossedHourTicks(worldTime, deltaTime);
  if (tickCount <= 0) return;

  for (const actor of getLoadedActors()) {
    if (!actor?.isOwner) continue;
    await applyActorRegeneration(actor, tickCount);
  }
}

function countCrossedHourTicks(worldTime, deltaTime) {
  const end = Number(worldTime) || 0;
  const delta = Math.max(0, Number(deltaTime) || 0);
  if (delta <= 0) return 0;

  const start = end - delta;
  return Math.max(0, Math.floor(end / REGENERATION_HOUR_SECONDS) - Math.floor(start / REGENERATION_HOUR_SECONDS));
}

async function applyActorRegeneration(actor, tickCount) {
  const amountPerTick = evaluateActorRegeneration(actor);
  const totalAmount = Math.max(0, amountPerTick * Math.max(0, toInteger(tickCount)));
  if (totalAmount <= 0) return;

  let remaining = totalAmount;
  const treatmentTargets = getTreatmentTargets(actor);
  if (treatmentTargets.length) {
    remaining = await applyTreatmentRegeneration(actor, treatmentTargets, remaining);
  }

  if (remaining > 0) await applyLimbRegeneration(actor, remaining);
}

function evaluateActorRegeneration(actor) {
  const characteristicSettings = getCharacteristicSettings();
  const skillSettings = getSkillSettings();
  const race = getCreatureOptions(characteristicSettings).races.find(entry => entry.id === actor.system?.creature?.raceId);
  const formula = String(race?.regeneration?.formula ?? DEFAULT_REGENERATION_FORMULA).trim() || DEFAULT_REGENERATION_FORMULA;

  try {
    return Math.max(0, evaluateFormula(formula, {
      characteristicSettings,
      skillSettings,
      characteristics: actor.system?.characteristics ?? {},
      skills: getSkillValues(actor.system?.skills ?? {})
    }));
  } catch (error) {
    console.warn(`${SYSTEM_ID} | Regeneration formula failed for ${actor.name}: ${error.message}`);
    return 0;
  }
}

function getTreatmentTargets(actor) {
  return actor.items
    .filter(item => ["trauma", "disease"].includes(item.type))
    .map(item => {
      const max = Math.max(1, toInteger(item.system?.healingProgressMax));
      const current = Math.min(max, Math.max(0, toInteger(item.system?.healingProgress)));
      return {
        id: item.id,
        item,
        current,
        max,
        missing: Math.max(0, max - current)
      };
    })
    .filter(entry => entry.missing > 0);
}

async function applyTreatmentRegeneration(actor, targets, amount) {
  const result = distributeRegeneration(targets, amount);
  const updates = [];
  const completed = [];

  for (const target of targets) {
    const applied = toInteger(result.allocations.get(target.id));
    if (applied <= 0) continue;

    const nextProgress = Math.min(target.max, target.current + applied);
    if (nextProgress >= target.max) completed.push(target.item);
    else updates.push({ _id: target.id, "system.healingProgress": nextProgress });
  }

  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);

  for (const item of completed) {
    if (item.type === "disease") await createDiseaseImmunityEffect(actor, item);
  }
  if (completed.length) await actor.deleteEmbeddedDocuments("Item", completed.map(item => item.id));

  return result.remaining;
}

async function applyLimbRegeneration(actor, amount) {
  const healing = Math.max(0, toInteger(amount));
  if (healing <= 0) return;

  await requestDamageApplication({
    actor,
    amount: healing,
    mode: "healing",
    scope: "health",
    source: {
      regeneration: true
    }
  });
}

function distributeRegeneration(entries, amount) {
  const allocations = new Map(entries.map(entry => [entry.id, 0]));
  let remaining = Math.max(0, toInteger(amount));
  let active = entries
    .map(entry => ({ ...entry, missing: Math.max(0, toInteger(entry.missing)) }))
    .filter(entry => entry.missing > 0);

  while (remaining > 0 && active.length) {
    const share = Math.floor(remaining / active.length);
    const extra = remaining % active.length;
    let spent = 0;
    const nextActive = [];

    for (const [index, entry] of active.entries()) {
      const portion = share + (index < extra ? 1 : 0);
      const applied = Math.min(entry.missing, portion);
      if (applied > 0) {
        allocations.set(entry.id, toInteger(allocations.get(entry.id)) + applied);
        entry.missing -= applied;
        spent += applied;
      }
      if (entry.missing > 0) nextActive.push(entry);
    }

    if (spent <= 0) break;
    remaining -= spent;
    active = nextActive;
  }

  return { allocations, remaining };
}

function getLoadedActors() {
  const actors = new Map();
  for (const actor of game.actors ?? []) actors.set(actor.uuid, actor);
  for (const token of canvas?.tokens?.placeables ?? []) {
    if (token.actor) actors.set(token.actor.uuid, token.actor);
  }
  return Array.from(actors.values());
}
