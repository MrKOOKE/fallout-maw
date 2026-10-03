import { registerActorTurnStartPreparedHandler } from "./turn-events.mjs";
import { prepareActorTurnStart, getCombatActionPointState } from "./reaction-resources.mjs";
import { getActorCombatSubject } from "./combat-membership.mjs";
import { getConstructCrewSeats, getConstructCrewSeatState } from "../utils/construct-crew.mjs";
import { registerConstructRotationTurns } from "../constructs/rotation-actions.mjs";

let registered = false;
export function registerConstructCrewCombatHooks() {
  if (registered) return;
  registered = true;
  registerConstructRotationTurns({ ownTurn: actor => Boolean(getCombatActionPointState(actor)?.ownTurn) });
  registerActorTurnStartPreparedHandler(async ({ actor, combat }) => {
    if (!game.user?.isGM || actor?.type !== "construct") return;
    const prepared = new Set();
    for (const seat of getConstructCrewSeats(actor)) {
      const occupant = getConstructCrewSeatState(actor, seat).occupant;
      const operator = occupant?.actorUuid ? await fromUuid(occupant.actorUuid) : null;
      if (!operator || prepared.has(operator.uuid) || getActorCombatSubject(operator, combat)?.uuid !== actor.uuid) continue;
      prepared.add(operator.uuid);
      await prepareActorTurnStart(operator, { combat });
    }
  });
}
