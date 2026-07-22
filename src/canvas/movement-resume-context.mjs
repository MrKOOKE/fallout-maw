const contextsByToken = new Map();

export const INTERNAL_SYSTEM_MOVEMENT_RESUME_OPTION = "falloutMawInternalMovementResume";

/**
 * Keep private resume metadata alive for the whole native Token#move Promise.
 * Foundry deliberately copies only documented update options into checkpoint
 * continuations; the native movement.chain is therefore the causal link for
 * recognizing later chunks of the same logical move.
 */
export async function withMovementResumeContext(
  tokenDocument,
  marker,
  data,
  operation
) {
  if (typeof operation !== "function") throw new TypeError("A movement resume operation is required.");
  const normalizedMarker = String(marker ?? "").trim();
  const tokenKey = getMovementResumeTokenKey(tokenDocument);
  if (!normalizedMarker || !tokenKey) return operation(null);

  const contexts = contextsByToken.get(tokenKey) ?? [];
  const context = { marker: normalizedMarker, data, movementIds: new Set() };
  contexts.push(context);
  contextsByToken.set(tokenKey, contexts);
  try {
    return await operation(context);
  } finally {
    const index = contexts.lastIndexOf(context);
    if (index >= 0) contexts.splice(index, 1);
    if (!contexts.length && contextsByToken.get(tokenKey) === contexts) contextsByToken.delete(tokenKey);
  }
}

export function getMovementResumeContext(tokenDocument, movement = {}, options = {}, marker = "") {
  const normalizedMarker = String(marker ?? "").trim();
  const contexts = contextsByToken.get(getMovementResumeTokenKey(tokenDocument)) ?? [];
  if (!normalizedMarker || !contexts.length) return null;

  const direct = Object.hasOwn(options ?? {}, normalizedMarker);
  const chain = Array.isArray(movement?.chain) ? movement.chain.map(String) : [];
  for (let index = contexts.length - 1; index >= 0; index -= 1) {
    const context = contexts[index];
    if (context.marker !== normalizedMarker) continue;
    const chained = chain.some(movementId => context.movementIds.has(movementId));
    if (!direct && !chained) continue;
    if (movement?.id) context.movementIds.add(String(movement.id));
    return context;
  }
  return null;
}

export function clearMovementResumeContexts(tokenDocument = null) {
  if (!tokenDocument) contextsByToken.clear();
  else contextsByToken.delete(getMovementResumeTokenKey(tokenDocument));
}

function getMovementResumeTokenKey(tokenDocument) {
  return String(tokenDocument?.uuid ?? tokenDocument?.id ?? "").trim();
}
