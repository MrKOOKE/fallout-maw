import { toInteger } from "../utils/numbers.mjs";

export const GRAPPLE_MODIFIER_HOOK = "fallout-maw.modifyGrapple";
export const GRAPPLE_MODIFIER_KINDS = Object.freeze({
  resistance: "resistance",
  escape: "escape",
  effect: "effect"
});
export const DEFAULT_GRAPPLED_ATTACK_DISADVANTAGE_AMOUNT = 1;

export function createGrappleModifierState({
  grapplerActor = null,
  targetActor = null,
  grapplerDocument = null,
  targetDocument = null,
  kind = ""
} = {}) {
  return {
    grapplerActor,
    targetActor,
    grapplerDocument,
    targetDocument,
    kind: String(kind ?? "").trim(),
    checkDifficultyBonus: 0,
    targetAttackDisadvantageBonus: 0
  };
}

export function requestGrappleModifiers(state = {}) {
  Hooks.callAll(GRAPPLE_MODIFIER_HOOK, state);
  return state;
}

export function getGrappleCheckDifficultyBonus({
  grapplerActor = null,
  targetActor = null,
  grapplerDocument = null,
  targetDocument = null,
  kind = ""
} = {}) {
  const resolved = requestGrappleModifiers(createGrappleModifierState({
    grapplerActor,
    targetActor,
    grapplerDocument,
    targetDocument,
    kind
  }));
  return Math.max(0, toInteger(resolved.checkDifficultyBonus));
}

export function getGrappleTargetAttackDisadvantageAmount({
  grapplerActor = null,
  targetActor = null,
  grapplerDocument = null,
  targetDocument = null,
  baseAmount = DEFAULT_GRAPPLED_ATTACK_DISADVANTAGE_AMOUNT
} = {}) {
  const resolved = requestGrappleModifiers(createGrappleModifierState({
    grapplerActor,
    targetActor,
    grapplerDocument,
    targetDocument,
    kind: GRAPPLE_MODIFIER_KINDS.effect
  }));
  return Math.max(0, toInteger(baseAmount)) + Math.max(0, toInteger(resolved.targetAttackDisadvantageBonus));
}
