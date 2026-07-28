import { SYSTEM_ID } from "../constants.mjs";
import {
  cleanupActorDodgeResource,
  initializeActorDodgeResource
} from "./dodge-resource.mjs";
import { restoreActorMovementResources } from "./movement-resources.mjs";
import {
  resetActorReactionResources,
  syncActorDefeatedCombatants
} from "./reaction-resources.mjs";
import { waitForCombatResourceSpending } from "./resource-spending.mjs";

const actorResourceLifecycleQueues = new Map();

export async function initializeCreatedCombatantResources(combatants = [], combat = null, {
  lifecycleContextId = ""
} = {}) {
  const result = {
    initializedActorUuids: [],
    skippedActorUuids: [],
    errors: []
  };
  if (!game.user?.isActiveGM || !combat?.started) return result;

  const createdCombatantIds = new Set(Array.from(combatants ?? [], combatant => combatant?.id));
  const actors = collectActors(collectCombatantActors(combatants));
  for (const actor of actors.values()) {
    await runActorResourceLifecycle(actor, async () => {
      await settleActorResourceSpending(actor, result);
      if (!combat?.started || !isActorInCombat(actor, combat)) {
        result.skippedActorUuids.push(actor.uuid);
        return;
      }
      const alreadyParticipating = Array.from(combat.combatants ?? []).some(combatant => (
        combatant?.actor?.uuid === actor.uuid
        && !createdCombatantIds.has(combatant.id)
      ));
      if (alreadyParticipating) {
        result.skippedActorUuids.push(actor.uuid);
        return;
      }

      const isCurrentActor = combat.combatant?.actor?.uuid === actor.uuid;
      for (const [stage, operation] of [
        ["dodge", () => initializeActorDodgeResource(actor)],
        ["movement", () => restoreActorMovementResources(actor)],
        ["reaction", () => resetActorReactionResources(actor, { restore: !isCurrentActor })],
        ["defeated", () => syncActorDefeatedCombatants(actor, {
          combat,
          advanceCurrent: isCurrentActor,
          lifecycleContextId
        })]
      ]) {
        try {
          await operation();
        } catch (error) {
          recordLifecycleError(result, actor, stage, error);
        }
      }
      result.initializedActorUuids.push(actor.uuid);
    });
  }
  return result;
}

/**
 * Restore combat-only resources after a Combat document has been deleted.
 *
 * The deleted Combat is already absent from game.combats when Foundry invokes
 * the document operation hook. This deliberately considers combatants only:
 * unrelated token actors on the same scene never receive an Actor update.
 */
export async function cleanupDeletedCombatResources(combat) {
  return cleanupDetachedCombatActors(collectCombatantActors(combat?.combatants), {
    expireCombatEndEffects: Boolean(combat?.started)
  });
}

export async function cleanupStoppedCombatResources(combat) {
  return cleanupDetachedCombatActors(collectCombatantActors(combat?.combatants), {
    expireCombatEndEffects: true
  });
}

/**
 * Restore an Actor removed as an individual Combatant, unless another
 * combatant still keeps that Actor in a started combat.
 */
export async function cleanupDeletedCombatantResources(combatants = [], combat = null) {
  if (!combat?.started) return cleanupDetachedCombatActors([]);
  return cleanupDetachedCombatActors(collectCombatantActors(combatants), {
    expireCombatEndEffects: true
  });
}

export async function cleanupDetachedCombatActors(actors = [], {
  expireCombatEndEffects = false
} = {}) {
  const result = {
    cleanedActorUuids: [],
    skippedActorUuids: [],
    errors: []
  };
  if (!game.user?.isActiveGM) return result;

  const uniqueActors = collectActors(actors);
  for (const actor of uniqueActors.values()) {
    await runActorResourceLifecycle(actor, async () => {
      if (isActorInAnyStartedCombat(actor)) {
        result.skippedActorUuids.push(actor.uuid);
        return;
      }
      await settleActorResourceSpending(actor, result);
      if (isActorInAnyStartedCombat(actor)) {
        result.skippedActorUuids.push(actor.uuid);
        return;
      }

      for (const [stage, operation] of [
        ...(expireCombatEndEffects
          ? [["combatEndEffects", () => deleteActorCombatEndEffects(actor)]]
          : []),
        ["movement", () => restoreActorMovementResources(actor)],
        ["reaction", () => resetActorReactionResources(actor)],
        ["dodge", () => cleanupActorDodgeResource(actor)]
      ]) {
        try {
          await operation();
        } catch (error) {
          recordLifecycleError(result, actor, stage, error);
        }
      }
      result.cleanedActorUuids.push(actor.uuid);
    });
  }
  return result;
}

async function settleActorResourceSpending(actor, result) {
  try {
    await waitForCombatResourceSpending(actor);
  } catch (error) {
    recordLifecycleError(result, actor, "resourceSpending", error);
  }
}

async function runActorResourceLifecycle(actor, operation) {
  const actorKey = String(actor?.uuid ?? actor?.id ?? "");
  if (!actorKey) return operation();
  const previous = actorResourceLifecycleQueues.get(actorKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  actorResourceLifecycleQueues.set(actorKey, current);
  try {
    return await current;
  } finally {
    if (actorResourceLifecycleQueues.get(actorKey) === current) {
      actorResourceLifecycleQueues.delete(actorKey);
    }
  }
}

async function deleteActorCombatEndEffects(actor) {
  const effectIds = Array.from(actor?.effects ?? [])
    .filter(effect => String(effect?.duration?.expiry ?? "") === "combatEnd")
    .map(effect => effect.id)
    .filter(Boolean);
  if (effectIds.length) {
    await actor.deleteEmbeddedDocuments("ActiveEffect", effectIds, { animate: false });
  }
}

function recordLifecycleError(result, actor, stage, error) {
  result.errors.push({
    actorUuid: actor.uuid,
    stage,
    error
  });
  console.error(
    `${SYSTEM_ID} | Combat resource lifecycle failed for ${actor.uuid} (${stage})`,
    error
  );
}

function collectCombatantActors(combatants = []) {
  return Array.from(combatants ?? [], combatant => combatant?.actor).filter(Boolean);
}

function collectActors(actors = []) {
  const unique = new Map();
  for (const actor of actors ?? []) {
    if (!actor?.uuid || unique.has(actor.uuid)) continue;
    unique.set(actor.uuid, actor);
  }
  return unique;
}

function isActorInAnyStartedCombat(actor) {
  for (const combat of getWorldCombats()) {
    if (!combat?.started) continue;
    if (isActorInCombat(actor, combat)) return true;
  }
  return false;
}

function isActorInCombat(actor, combat) {
  return Array.from(combat?.combatants ?? [])
    .some(combatant => combatant?.actor?.uuid === actor?.uuid);
}

function getWorldCombats() {
  const combats = game.combats;
  if (Array.isArray(combats?.contents)) return combats.contents;
  if (combats?.[Symbol.iterator]) return Array.from(combats);
  return [];
}
