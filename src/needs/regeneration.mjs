import { ENERGY_RESOURCE_KEY } from "../combat/energy-resource.mjs";
import { deleteHealedTraumas, requestDamageApplication } from "../combat/damage-hub.mjs";
import { createDiseaseImmunityEffect } from "./need-thresholds.mjs";
import { getTimeMechanicsIgnored } from "../settings/accessors.mjs";
import { getActorRegenerationRate } from "./regeneration-rates.mjs";
import { buildConstructRegenerationUpdates, distributeRegeneration } from "./regeneration-allocation.mjs";
import { executeInventoryMutation } from "../inventory/mutation.mjs";
import {
  getActorTimeSegments,
  isTimeMechanicsForced
} from "../time/rest-context.mjs";
import { registerWorldTimeActorCandidateIndex } from "../time/world-time-actor-index.mjs";
import { registerQueuedWorldTimeProcessor } from "../time/world-time-queue.mjs";
import { toInteger } from "../utils/numbers.mjs";

const REGENERATION_HOUR_SECONDS = 60 * 60;
let regenerationActorIndex = null;

export function registerRegenerationHooks() {
  regenerationActorIndex ??= registerWorldTimeActorCandidateIndex(actorMayNeedRegeneration);
  registerQueuedWorldTimeProcessor(processRegenerationWorldTime, { priority: -10 });
}

async function processRegenerationWorldTime(worldTime, deltaTime, options) {
  if (!game.user?.isActiveGM) return;
  if (getTimeMechanicsIgnored() && !isTimeMechanicsForced(options)) return;

  const tickCount = countCrossedHourTicks(worldTime, deltaTime);
  if (tickCount <= 0) return;

  for (const actor of await regenerationActorIndex.values()) {
    if (!actor?.isOwner) continue;
    const actorTickCount = getActorRegenerationTickCount(actor, worldTime, deltaTime, options, tickCount);
    if (actorTickCount > 0) await applyActorRegeneration(actor, actorTickCount);
  }
}

function countCrossedHourTicks(worldTime, deltaTime) {
  const end = Number(worldTime) || 0;
  const delta = Math.max(0, Number(deltaTime) || 0);
  if (delta <= 0) return 0;

  const start = end - delta;
  return Math.max(0, Math.floor(end / REGENERATION_HOUR_SECONDS) - Math.floor(start / REGENERATION_HOUR_SECONDS));
}

function getActorRegenerationTickCount(actor, worldTime, deltaTime, options, defaultTickCount) {
  const segments = getActorTimeSegments(actor, deltaTime, options);
  if (segments.length === 1 && !segments[0]?.effects?.length) {
    return Math.max(0, toInteger(defaultTickCount)) * (segments[0].restMode ? 2 : 1);
  }
  return segments.reduce((total, segment) => {
    const ticks = countWholeHourTicks(segment.seconds);
    return total + (segment.restMode ? ticks * 2 : ticks);
  }, 0);
}

function countWholeHourTicks(seconds) {
  return Math.max(0, Math.floor((Number(seconds) || 0) / REGENERATION_HOUR_SECONDS));
}

async function applyActorRegeneration(actor, tickCount) {
  const ticks = Math.max(0, toInteger(tickCount));
  const healthAmount = actorNeedsHealthRegeneration(actor)
    ? Math.max(0, getActorRegenerationRate(actor) * ticks) : 0;
  const energyAmount = resourceIsBelowMaximum(actor.system?.resources?.[ENERGY_RESOURCE_KEY])
    ? Math.max(0, getActorRegenerationRate(actor, { resource: "energy" }) * ticks)
    : 0;
  if (healthAmount <= 0 && energyAmount <= 0) return;

  if (healthAmount > 0) {
    let remaining = healthAmount;
    const treatmentTargets = getTreatmentTargets(actor);
    if (treatmentTargets.length) {
      remaining = await applyTreatmentRegeneration(actor, treatmentTargets, remaining);
    }

    if (remaining > 0) await applyLimbRegeneration(actor, remaining);
  }
  if (energyAmount > 0) await applyEnergyRegeneration(actor, energyAmount);
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

  const completedDiseases = completed.filter(item => item.type === "disease");
  const completedTraumas = completed.filter(item => item.type === "trauma");
  for (const item of completedDiseases) await createDiseaseImmunityEffect(actor, item);
  if (completedDiseases.length) {
    await actor.deleteEmbeddedDocuments("Item", completedDiseases.map(item => item.id));
  }
  if (completedTraumas.length) {
    await deleteHealedTraumas(actor, completedTraumas.map(item => item.id));
  }

  return result.remaining;
}

async function applyLimbRegeneration(actor, amount) {
  const healing = Math.max(0, toInteger(amount));
  if (healing <= 0) return;

  if (actor.type === "construct") {
    const updates = buildConstructRegenerationUpdates(actor, healing);
    if (updates.length) await executeInventoryMutation({ actor, updates }, { reason: "construct-regeneration" });
    return;
  }

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

async function applyEnergyRegeneration(actor, amount) {
  const resource = actor.system?.resources?.[ENERGY_RESOURCE_KEY];
  if (!resource) return;

  const minimum = Math.max(0, toInteger(resource.min));
  const maximum = Math.max(minimum, toInteger(resource.max));
  const current = Math.min(maximum, Math.max(minimum, toInteger(resource.value)));
  const next = Math.min(maximum, current + Math.max(0, toInteger(amount)));
  if (next <= current) return;

  const update = {
    [`system.resources.${ENERGY_RESOURCE_KEY}.value`]: next
  };
  if (Object.hasOwn(resource, "spent")) {
    update[`system.resources.${ENERGY_RESOURCE_KEY}.spent`] = Math.max(0, maximum - next);
  }
  await actor.update(update);
}

export function actorMayNeedRegeneration(actor) {
  return (actorNeedsHealthRegeneration(actor) && getActorRegenerationRate(actor) > 0)
    || (resourceIsBelowMaximum(actor?.system?.resources?.[ENERGY_RESOURCE_KEY])
      && getActorRegenerationRate(actor, { resource: "energy" }) > 0);
}

function actorNeedsHealthRegeneration(actor) {
  if (!actor) return false;
  if (actor.items?.some(item => {
    if (item?.type !== "trauma" && item?.type !== "disease") return false;
    const maximum = Math.max(1, toInteger(item.system?.healingProgressMax));
    return toInteger(item.system?.healingProgress) < maximum;
  })) return true;

  const health = actor.system?.resources?.health;
  if (resourceIsBelowMaximum(health)) return true;
  if (Object.values(actor.system?.limbs ?? {}).some(resourceIsBelowMaximum)) return true;
  return false;
}

function resourceIsBelowMaximum(resource) {
  if (!resource || typeof resource !== "object") return false;
  const maximum = Number(resource.max);
  const value = Number(resource.value);
  return Number.isFinite(maximum) && Number.isFinite(value) && maximum > value;
}
