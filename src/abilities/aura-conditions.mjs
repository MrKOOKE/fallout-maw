import { SYSTEM_ID } from "../constants.mjs";
import { getActorFactionBelongs, getActorPrimaryFaction, getRelationTo, DEFAULT_FACTION_NAME } from "../settings/factions.mjs";
import {
  ABILITY_AURA_MODES,
  ABILITY_AURA_TARGET_GROUPS,
  ABILITY_CONDITION_TYPES
} from "../settings/abilities.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { evaluateActorFormula } from "../utils/actor-formulas.mjs";

export const AURA_GENERATED_EFFECT_FLAG_KEY = "auraGenerated";

export function isAuraCondition(condition = {}) {
  return condition?.type === ABILITY_CONDITION_TYPES.aura;
}

export function isAuraDistributionCondition(condition = {}) {
  if (!isAuraCondition(condition)) return false;
  return condition.auraMode === ABILITY_AURA_MODES.applyToTargets;
}

export function findAuraDistributionConditions(conditions = []) {
  return (conditions ?? []).filter(isAuraDistributionCondition);
}

export function abilityAuraConditionApplies(actor, condition = {}, context = {}) {
  if (String(context?.satisfiedAuraConditionId ?? "") === String(condition?.id ?? "")) return true;
  if (isAuraDistributionCondition(condition)) return false;
  const state = resolveAbilityAuraState(actor, condition, context);
  return Boolean(state.sourceToken && state.primarySatisfied);
}

export function resolveAbilityAuraState(actor, condition = {}, context = {}) {
  const sourceToken = resolveActorToken(actor, context);
  const requiredCount = evaluateAuraFormula(condition?.requiredCount, actor, {
    fallback: 1,
    minimum: 1,
    context: "aura required count"
  });
  if (!sourceToken || !actor || !canvas?.tokens) {
    return {
      sourceToken: null,
      primaryTargets: [],
      requiredCount,
      primarySatisfied: false
    };
  }

  if (!auraSourceAllowed(actor, sourceToken, condition)) {
    return {
      sourceToken,
      primaryTargets: [],
      requiredCount,
      primarySatisfied: false
    };
  }

  const excludeSelfForPresence = condition.auraMode !== ABILITY_AURA_MODES.applyToTargets;
  const primaryTargets = collectAuraTargets(sourceToken, condition, {
    targetGroups: condition.auraTargetGroups,
    includeSelf: !excludeSelfForPresence && condition.auraIncludeSelf !== false
  });

  return {
    sourceToken,
    primaryTargets,
    requiredCount,
    primarySatisfied: primaryTargets.length >= requiredCount
  };
}

export function getAuraGeneratedTargetTokens(actor, condition = {}, context = {}) {
  const state = resolveAbilityAuraState(actor, condition, context);
  if (!state.sourceToken) return [];
  if (condition.auraMode === ABILITY_AURA_MODES.applyToTargets) {
    return state.primarySatisfied ? state.primaryTargets : [];
  }
  return [];
}

export function getAuraGeneratedEffectFlag(effect = null) {
  return effect?.getFlag?.(SYSTEM_ID, AURA_GENERATED_EFFECT_FLAG_KEY)
    ?? effect?.flags?.[SYSTEM_ID]?.[AURA_GENERATED_EFFECT_FLAG_KEY]
    ?? null;
}

function collectAuraTargets(sourceToken, condition = {}, { targetGroups = [], includeSelf = true } = {}) {
  const targets = [];
  for (const targetToken of canvas?.tokens?.placeables ?? []) {
    if (!targetToken?.actor) continue;
    if (!includeSelf && targetToken.id === sourceToken.id) continue;
    if (!auraTargetAllowed(sourceToken, targetToken, condition)) continue;
    if (!auraTargetRelationMatches(sourceToken.actor, targetToken.actor, targetGroups)) continue;
    targets.push(targetToken);
  }
  return targets;
}

function auraSourceAllowed(actor, sourceToken, condition = {}) {
  if (condition.auraCombatOnly && !activeCombatForScene(getTokenScene(sourceToken))) return false;
  if (condition.auraIgnoreIncapacitated !== false && isActorIncapacitated(actor)) return false;
  if (condition.auraIgnoreHidden !== false && sourceToken.document?.hidden) return false;
  return true;
}

function auraTargetAllowed(sourceToken, targetToken, condition = {}) {
  if (condition.auraIgnoreHidden !== false && targetToken.document?.hidden) return false;
  if (condition.auraIgnoreIncapacitated !== false && isActorIncapacitated(targetToken.actor)) return false;
  if (condition.auraCombatantsOnly && !isTokenCombatant(targetToken)) return false;
  if (!isTokenInAuraRadius(sourceToken, targetToken, condition)) return false;
  if (condition.auraWallsBlock !== false && !hasAuraLineOfSight(sourceToken, targetToken)) return false;
  return true;
}

function isTokenInAuraRadius(sourceToken, targetToken, condition = {}) {
  if (sourceToken.id === targetToken.id) return true;
  const radiusMeters = evaluateAuraFormula(condition?.auraRadiusMeters, sourceToken.actor, {
    fallback: 0,
    minimum: 0,
    context: "aura radius"
  });
  if (radiusMeters <= 0) return false;
  return measureTokenDistanceMeters(sourceToken, targetToken) <= radiusMeters;
}

function evaluateAuraFormula(formula, actor = null, { fallback = 0, minimum = 0, context = "" } = {}) {
  return Math.max(minimum, toInteger(evaluateActorFormula(formula, actor, { fallback, minimum, context })));
}

export function hasAuraLineOfSight(sourceToken, targetToken) {
  if (!sourceToken?.checkCollision) return false;
  const origin = getTokenCenter(sourceToken);
  const destination = getTokenCenter(targetToken);
  return !sourceToken.checkCollision(destination, { origin, type: "sight", mode: "any" });
}

export function measureTokenDistanceMeters(sourceToken, targetToken) {
  const origin = getTokenCenter(sourceToken);
  const destination = getTokenCenter(targetToken);
  const measured = canvas?.grid?.measurePath?.([origin, destination])?.distance;
  if (Number.isFinite(Number(measured))) return Math.max(0, Number(measured));

  const distancePixels = Math.hypot(destination.x - origin.x, destination.y - origin.y);
  const gridDistance = Math.max(0.0001, Number(canvas?.scene?.grid?.distance ?? canvas?.grid?.distance) || 1);
  const gridSize = Math.max(1, Number(canvas?.grid?.size) || 100);
  return (distancePixels / gridSize) * gridDistance;
}

export function getTokenCenter(token) {
  return token?.center ?? {
    x: Number(token?.document?.x ?? 0) + Math.max(1, Number(token?.w) || Number(canvas?.grid?.size) || 100) / 2,
    y: Number(token?.document?.y ?? 0) + Math.max(1, Number(token?.h) || Number(canvas?.grid?.size) || 100) / 2
  };
}

function auraTargetRelationMatches(sourceActor, targetActor, targetGroups = []) {
  if (!sourceActor || !targetActor) return false;
  const relation = getAuraRelation(sourceActor, targetActor);
  const accepted = new Set((targetGroups ?? []).filter(group => ABILITY_AURA_TARGET_GROUPS.includes(group)));
  if (!accepted.size) return false;
  return accepted.has(relation);
}

export function getAuraRelation(sourceActor, targetActor) {
  const sourcePrimary = getActorPrimaryFaction(sourceActor);
  const targetFactions = getActorFactionBelongs(targetActor);
  const factions = targetFactions.length ? targetFactions : [DEFAULT_FACTION_NAME];
  const relations = factions.map(faction => faction === sourcePrimary ? "ally" : getRelationTo(sourceActor, faction));
  if (relations.includes("ally")) return "ally";
  if (relations.includes("enemy")) return "enemy";
  return "neutral";
}

function resolveActorToken(actor, context = {}) {
  const contextToken = context?.actorToken?.object ?? context?.actorToken ?? null;
  if (contextToken?.actor?.uuid === actor?.uuid) return contextToken;

  const sceneTokens = canvas?.tokens?.placeables ?? [];
  return sceneTokens.find(token => token?.actor?.uuid === actor?.uuid) ?? null;
}

function activeCombatForScene(scene) {
  const combat = game.combat ?? game.combats?.active ?? null;
  if (!combat?.started) return null;
  if (scene?.id && combat.scene?.id && combat.scene.id !== scene.id) return null;
  return combat;
}

function isTokenCombatant(token) {
  const combat = activeCombatForScene(getTokenScene(token));
  if (!combat) return false;
  return combat.combatants?.some(combatant => {
    if (combatant.tokenId && combatant.tokenId === token.id) return true;
    return combatant.actor?.uuid && combatant.actor.uuid === token.actor?.uuid;
  }) ?? false;
}

function isActorIncapacitated(actor) {
  return Boolean(actor?.statuses?.has?.("dead") || actor?.statuses?.has?.("unconscious"));
}

function getTokenScene(token) {
  return token?.document?.parent ?? token?.scene ?? canvas?.scene ?? null;
}
