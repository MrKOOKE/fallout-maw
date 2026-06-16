const actorTurnEndHandlers = [];
const actorTurnStartPreparedHandlers = [];

export function registerActorTurnEndHandler(handler) {
  if (typeof handler !== "function" || actorTurnEndHandlers.includes(handler)) return;
  actorTurnEndHandlers.push(handler);
}

export function registerActorTurnStartPreparedHandler(handler) {
  if (typeof handler !== "function" || actorTurnStartPreparedHandlers.includes(handler)) return;
  actorTurnStartPreparedHandlers.push(handler);
}

export async function callActorTurnEndHandlers(context = {}) {
  for (const handler of actorTurnEndHandlers) await handler(context);
}

export async function callActorTurnStartPreparedHandlers(context = {}) {
  for (const handler of actorTurnStartPreparedHandlers) await handler(context);
}
