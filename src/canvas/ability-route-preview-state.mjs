const previewBudgets = new Map();
const suppressedPlanStops = new WeakMap();
const routePlanCommitters = new WeakMap();

export const ABILITY_ROUTE_PREVIEW_MOVEMENT_OPTION = "falloutMawAbilityRoutePreview";

export const ABILITY_ROUTE_BUDGET_MODES = Object.freeze({
  movementCost: "movementCost",
  distance: "distance"
});

export function setAbilityRoutePreviewBudget(token, {
  mode = ABILITY_ROUTE_BUDGET_MODES.movementCost,
  total = Infinity,
  used = 0,
  resourceTotal = Infinity,
  resourceUsed = 0,
  invalid = false,
  searching = false,
  interactive = false,
  explicitPointKeys = [],
  userId = globalThis.game?.user?.id
} = {}) {
  const key = getPreviewBudgetKey(token, userId);
  if (!key) return;
  const tokenDocument = token?.document ?? token;
  const preview = {
    tokenUuid: String(tokenDocument?.uuid ?? "").trim(),
    mode: mode === ABILITY_ROUTE_BUDGET_MODES.distance
      ? ABILITY_ROUTE_BUDGET_MODES.distance
      : ABILITY_ROUTE_BUDGET_MODES.movementCost,
    total: normalizeBudget(total),
    used: normalizeUsage(used),
    resourceTotal: normalizeBudget(resourceTotal),
    resourceUsed: normalizeUsage(resourceUsed),
    invalid: Boolean(invalid),
    searching: Boolean(searching),
    interactive: Boolean(interactive),
    explicitPointKeys: new Set(Array.from(explicitPointKeys ?? [], value => String(value)))
  };
  previewBudgets.set(key, preview);
}

export function getAbilityRoutePreviewBudget(token, userId = globalThis.game?.user?.id) {
  const key = getPreviewBudgetKey(token, userId);
  return key ? (previewBudgets.get(key) ?? null) : null;
}

export function updateAbilityRoutePreviewBudget(token, changes = {}, userId = globalThis.game?.user?.id) {
  const current = getAbilityRoutePreviewBudget(token, userId);
  if (!current) return false;
  setAbilityRoutePreviewBudget(token, {
    ...current,
    ...changes,
    explicitPointKeys: changes.explicitPointKeys ?? current.explicitPointKeys,
    userId
  });
  return true;
}

export function isAbilityRoutePlanningInteractive(token, userId = globalThis.game?.user?.id) {
  return Boolean(getAbilityRoutePreviewBudget(token, userId)?.interactive);
}

export function clearAbilityRoutePreviewBudget(token, userId = globalThis.game?.user?.id) {
  const key = getPreviewBudgetKey(token, userId);
  if (!key) return;
  previewBudgets.delete(key);
}

/**
 * Attach the authority-backed commit callback used by the native drag drop.
 * The callback is deliberately local-only; authorization and persistence are
 * performed by the owner/GM query supplied by the ability action pipeline.
 */
export function setAbilityRoutePlanCommitter(token, callback) {
  const tokenObject = token?.object ?? token;
  if (!tokenObject || typeof callback !== "function") return false;
  routePlanCommitters.set(tokenObject, callback);
  return true;
}

export function getAbilityRoutePlanCommitter(token) {
  const tokenObject = token?.object ?? token;
  return tokenObject ? (routePlanCommitters.get(tokenObject) ?? null) : null;
}

export function clearAbilityRoutePlanCommitter(token, callback = null) {
  const tokenObject = token?.object ?? token;
  if (!tokenObject) return false;
  const current = routePlanCommitters.get(tokenObject);
  if (!current || (callback && current !== callback)) return false;
  routePlanCommitters.delete(tokenObject);
  return true;
}

/** Mark a public stopMovement call as disposal of an unstarted ability preview. */
export function markAbilityRoutePreviewStop(tokenDocument, movementId = "") {
  if (!tokenDocument || (typeof tokenDocument !== "object")) return false;
  const id = String(movementId ?? "").trim();
  if (!id) return false;
  const ids = suppressedPlanStops.get(tokenDocument) ?? new Set();
  ids.add(id);
  suppressedPlanStops.set(tokenDocument, ids);
  return true;
}

/** Consume the matching stop marker from the synchronous Foundry stopToken hook. */
export function consumeAbilityRoutePreviewStop(tokenDocument, movementId = "") {
  const ids = tokenDocument && suppressedPlanStops.get(tokenDocument);
  const id = String(movementId ?? "").trim();
  if (!ids?.has(id)) return false;
  ids.delete(id);
  if (!ids.size) suppressedPlanStops.delete(tokenDocument);
  return true;
}

export function clearAbilityRoutePreviewStop(tokenDocument, movementId = "") {
  const ids = tokenDocument && suppressedPlanStops.get(tokenDocument);
  const id = String(movementId ?? "").trim();
  if (!ids?.delete(id)) return false;
  if (!ids.size) suppressedPlanStops.delete(tokenDocument);
  return true;
}

function getPreviewBudgetKey(token, userId) {
  const tokenDocument = token?.document ?? token;
  const tokenUuid = String(tokenDocument?.uuid ?? "").trim();
  const normalizedUserId = String(userId ?? "").trim();
  return tokenUuid && normalizedUserId ? `${tokenUuid}\u0000${normalizedUserId}` : "";
}

function normalizeBudget(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : Infinity;
}

function normalizeUsage(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
