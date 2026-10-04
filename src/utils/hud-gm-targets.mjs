import { getConstructCrewContexts } from "./construct-crew-context.mjs";

/** Administrative actions include parked crew, even when they cannot act. */
export function collectHudGmTargets(tokens = [], { user = globalThis.game?.user, fallbackActor = null } = {}) {
  const targets = [], seen = new Set();
  const add = (actor, detail = "") => {
    if (!actor?.uuid || !actor.testUserPermission?.(user, "OWNER") || seen.has(actor.uuid)) return;
    seen.add(actor.uuid);
    targets.push({ actor, detail, field: `hudTarget${targets.length}` });
  };
  const carriers = tokens.map(token => token?.actor).filter(Boolean);
  if (!carriers.length && fallbackActor) carriers.push(fallbackActor);
  for (const actor of carriers) {
    if (!actor.testUserPermission?.(user, "OWNER")) continue;
    add(actor);
    for (const crew of getConstructCrewContexts(actor, user)) {
      add(crew.actor, `${crew.seat.name} — ${actor.name}`);
    }
  }
  return targets;
}

/** Unchecked or omitted fields never fall back to all candidates. */
export function selectHudGmActors(targets, formData = {}) {
  return targets.filter(target => [true, "true", "on"].includes(formData[target.field])).map(target => target.actor);
}
