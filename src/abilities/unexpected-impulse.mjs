import { getActorFixedAbilityFunctionEntry } from "./runtime-state.mjs";
import { evaluateActorFormula } from "../utils/actor-formulas.mjs";
import { isInitiativeBelowThreshold } from "./release-ability-rules.mjs";

export async function rerollUnexpectedInitiative(combat, updates, rolls) {
  for (const update of updates) {
    const combatant = combat.combatants.get(update._id), actor = combatant?.actor;
    if (!getActorFixedAbilityFunctionEntry(actor, "unexpectedImpulse")) continue;
    const others = Array.from(combat.combatants ?? []).filter(c => c.id !== update._id)
      .map(c => updates.find(u => u._id === c.id)?.initiative ?? c.initiative);
    const record = rolls.get(update._id);
    if (!record) continue;
    const chance = Math.min(100, evaluateActorFormula("50+gambling/10", actor));
    let attempts = 0;
    while (isInitiativeBelowThreshold(update.initiative, others) && Math.random() * 100 < chance) {
      const roll = combatant.getInitiativeRoll(record.roll.formula);
      await roll.evaluate();
      update.initiative = roll.total;
      record.roll = roll;
      attempts += 1;
      if (attempts >= 100) { ui.notifications.warn(`${actor.name}: 100 перебросов инициативы; дальнейшие перебросы остановлены.`); break; }
    }
    record.rerolls = attempts;
  }
}
