import { isActorInActiveCombat } from "./combat-membership.mjs";
import { clearOneTimeResourcePoints } from "./one-time-resources.mjs";
import { registerQueuedWorldTimeProcessor } from "../time/world-time-queue.mjs";
import { getActiveSceneWorldTimeActors } from "../time/world-time-actor-index.mjs";

const ROUND_SECONDS = 6;
let registered = false;

export function registerOneTimeResourceLifecycle() {
  if (registered) return;
  registered = true;
  // Clear the preceding interval before other time mechanics grant new points.
  registerQueuedWorldTimeProcessor(resetOutsideCombatOneTimeResources, { priority: 1000 });
}

export async function resetOutsideCombatOneTimeResources(worldTime, deltaTime, _options = {}, _userId = "", actors = null) {
  if (!globalThis.game?.user?.isActiveGM) return;
  const now = Number(worldTime);
  const delta = Number(deltaTime);
  if (!Number.isFinite(now) || !Number.isFinite(delta) || delta <= 0
    || Math.floor(now / ROUND_SECONDS) <= Math.floor((now - delta) / ROUND_SECONDS)) return;
  const candidates = actors ?? await collectOneTimeResourceActors();
  const unique = new Map(Array.from(candidates, actor => [actor?.uuid, actor]));
  for (const actor of unique.values()) {
    if (!actor?.uuid || isActorInActiveCombat(actor)) continue;
    await clearOneTimeResourcePoints(actor, { falloutMawOneTimeResourceExpiry: true });
  }
}

async function collectOneTimeResourceActors() {
  const actors = [...(game.actors?.contents ?? [])];
  for (const scene of game.scenes?.contents ?? []) {
    for (const token of scene.tokens ?? []) {
      if (!token.actorLink && token.actor) actors.push(token.actor);
    }
  }
  // Includes preserved passengers and travel-group participants.
  actors.push(...await getActiveSceneWorldTimeActors());
  return actors;
}
