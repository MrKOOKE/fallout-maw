export const SMOKE_PERCEPTION_PERCENT_EFFECT_KEY = "fallout-maw.smoke.perceptionPercent";

let actorSmokePerceptionCache = new WeakMap();
let smokePerceptionFormulaEvaluator = null;

export function configureSmokePerceptionFormulaEvaluator(evaluator = null) {
  smokePerceptionFormulaEvaluator = typeof evaluator === "function" ? evaluator : null;
  invalidateActorSmokePerception();
}

/**
 * Resolve the signed percentage-point adjustment to smoke density perceived
 * by this actor. Thus 70% smoke with -30 is perceived as 40%, while -170
 * produces -100% perceived density and doubles visibility through that smoke.
 * This value is observer-local and is never used by lights.
 */
export function getActorSmokePerceptionPercent(actor) {
  if (!actor) return 0;
  const cached = actorSmokePerceptionCache.get(actor);
  if (cached !== undefined) return cached;
  const entries = [];
  for (const effect of getActorApplicableEffects(actor)) {
    if (effect?.disabled || effect?.active === false) continue;
    for (const change of effect?.system?.changes ?? effect?.changes ?? []) {
      if (String(change?.key ?? "").trim() !== SMOKE_PERCEPTION_PERCENT_EFFECT_KEY) continue;
      entries.push({ effect, change });
    }
  }
  entries
    .sort((left, right) => getChangePriority(left.change) - getChangePriority(right.change));
  let percent = 0;
  for (const { change } of entries) {
    const amount = evaluateChangeNumber(actor, change?.value);
    if (!Number.isFinite(amount)) continue;
    switch (String(change?.type ?? "add")) {
      case "multiply": percent *= amount; break;
      case "override": percent = amount; break;
      case "upgrade": percent = Math.max(percent, amount); break;
      case "downgrade": percent = Math.min(percent, amount); break;
      case "subtract": percent -= amount; break;
      default: percent += amount;
    }
  }
  actorSmokePerceptionCache.set(actor, percent);
  return percent;
}

export function getActorSmokeDensityAdjustment(actor) {
  return getActorSmokePerceptionPercent(actor) / 100;
}

export function effectHasSmokePerceptionChange(effect) {
  return (effect?.system?.changes ?? effect?.changes ?? [])
    .some(change => String(change?.key ?? "").trim() === SMOKE_PERCEPTION_PERCENT_EFFECT_KEY);
}

export function actorHasSmokePerceptionChange(actor) {
  if (!actor) return false;
  for (const effect of getActorApplicableEffects(actor)) {
    if (effect?.disabled || effect?.active === false) continue;
    if (effectHasSmokePerceptionChange(effect)) return true;
  }
  return false;
}

export function invalidateActorSmokePerception(actor = null) {
  if (actor) actorSmokePerceptionCache.delete(actor);
  else actorSmokePerceptionCache = new WeakMap();
}

function getChangePriority(change) {
  const explicit = Number(change?.priority);
  if (Number.isFinite(explicit)) return explicit;
  return Number(globalThis.ActiveEffect?.CHANGE_TYPES?.[change?.type]?.defaultPriority) || 0;
}

function getActorApplicableEffects(actor) {
  if (typeof actor?.allApplicableEffects === "function") return actor.allApplicableEffects();
  return actor?.effects ?? [];
}

function evaluateChangeNumber(actor, value) {
  const direct = Number(value);
  if (Number.isFinite(direct)) return direct;
  if (!smokePerceptionFormulaEvaluator) return Number.NaN;
  return smokePerceptionFormulaEvaluator(actor, value, {
    fallback: Number.NaN,
    stage: "prepared"
  });
}
