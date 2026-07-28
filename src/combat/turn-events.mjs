const actorTurnEndHandlers = [];
const actorTurnStartPreparedHandlers = [];
const combatRoundStartHandlers = [];

export function registerActorTurnEndHandler(handler) {
  if (typeof handler !== "function" || actorTurnEndHandlers.includes(handler)) return;
  actorTurnEndHandlers.push(handler);
}

export function registerActorTurnStartPreparedHandler(handler) {
  if (typeof handler !== "function" || actorTurnStartPreparedHandlers.includes(handler)) return;
  actorTurnStartPreparedHandlers.push(handler);
}

export function registerCombatRoundStartHandler(handler) {
  if (typeof handler !== "function" || combatRoundStartHandlers.includes(handler)) return;
  combatRoundStartHandlers.push(handler);
}

export async function callActorTurnEndHandlers(context = {}) {
  for (const handler of actorTurnEndHandlers) await handler(context);
}

export async function callActorTurnStartPreparedHandlers(context = {}) {
  for (const handler of actorTurnStartPreparedHandlers) await handler(context);
}

export async function callCombatRoundStartHandlers(context = {}) {
  for (const handler of combatRoundStartHandlers) await handler(context);
}
