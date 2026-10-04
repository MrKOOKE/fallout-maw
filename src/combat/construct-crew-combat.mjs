import { getCombatActionPointState } from "./reaction-resources.mjs";
import { registerConstructRotationTurns } from "../constructs/rotation-actions.mjs";

let registered = false;
export function registerConstructCrewCombatHooks() {
  if (registered) return;
  registered = true;
  registerConstructRotationTurns({ ownTurn: actor => Boolean(getCombatActionPointState(actor)?.ownTurn) });
}
