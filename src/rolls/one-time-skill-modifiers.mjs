import { SYSTEM_ID } from "../constants.mjs";
import {
  ONE_TIME_SKILL_MODIFIER_EFFECT_KEY,
  evaluateActorEffectChangeNumber
} from "../utils/active-effect-changes.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { WEAPON_ATTACK_RESOLVED_HOOK } from "../combat/weapon-attack-controller.mjs";

export const ONE_TIME_SKILL_MODIFIER_FLAG_KEY = "oneTimeSkillModifier";

const effectClaims = new Map();

export function registerOneTimeSkillModifierHooks() {
  Hooks.on("fallout-maw.modifySkillCheck", applyOneTimeSkillModifiers);
  Hooks.on("fallout-maw.skillCheckResolved", outcome => {
    void consumeOneTimeSkillModifiers(outcome);
  });
  Hooks.on(WEAPON_ATTACK_RESOLVED_HOOK, context => {
    void consumeOneTimeSkillModifiersForAttack(context);
  });
}

export function getPendingOneTimeSkillModifierEffects(actor, predicate = null) {
  return Array.from(actor?.effects ?? []).filter(effect => {
    if (effect?.disabled || effectClaims.has(effect.id)) return false;
    const data = effect.getFlag?.(SYSTEM_ID, ONE_TIME_SKILL_MODIFIER_FLAG_KEY);
    if (getOneTimeSkillModifierRemainingUses(data) <= 0) return false;
    return typeof predicate !== "function" || predicate(data, effect);
  });
}

function applyOneTimeSkillModifiers(check = {}) {
  const actor = check.actor;
  const skillKey = String(check.skill?.key ?? "").trim();
  if (!actor || !skillKey) return;

  const weaponAttackId = String(check.weaponAttackId ?? "").trim();
  const effects = Array.from(actor.effects ?? []).filter(effect => {
    if (effect?.disabled) return false;
    const data = effect.getFlag?.(SYSTEM_ID, ONE_TIME_SKILL_MODIFIER_FLAG_KEY);
    if (getOneTimeSkillModifierRemainingUses(data) <= 0 || String(data?.skillKey ?? "") !== skillKey) return false;
    const claim = effectClaims.get(effect.id);
    if (!claim) return true;
    return Boolean(weaponAttackId) && claim.weaponAttackId === weaponAttackId;
  });
  if (!effects.length) return;

  let modifier = 0;
  const effectIds = [];
  for (const effect of effects) {
    const change = (effect.system?.changes ?? [])
      .find(entry => String(entry?.key ?? "") === ONE_TIME_SKILL_MODIFIER_EFFECT_KEY);
    if (change) {
      const value = toInteger(evaluateActorEffectChangeNumber(actor, { ...change, effect }, { fallback: 0 }));
      modifier += value;
    }
    effectIds.push(effect.id);
    if (!effectClaims.has(effect.id)) {
      effectClaims.set(effect.id, {
        actorUuid: String(actor.uuid ?? ""),
        weaponAttackId
      });
    }
  }
  if (!effectIds.length) return;

  if (modifier) check.situationalModifier = toInteger(check.situationalModifier) + modifier;
  check.oneTimeSkillModifierEffectIds = effectIds;
  if (modifier) check.modifiers?.push?.({
    key: ONE_TIME_SKILL_MODIFIER_EFFECT_KEY,
    label: "Одноразовый модификатор",
    value: modifier
  });
}

async function consumeOneTimeSkillModifiers(outcome = {}) {
  const actor = outcome.actor;
  if (String(outcome.check?.weaponAttackId ?? "").trim()) return;
  const effectIds = Array.from(new Set(outcome.check?.oneTimeSkillModifierEffectIds ?? []))
    .map(id => String(id ?? "").trim())
    .filter(Boolean);
  if (!actor || !effectIds.length) return;

  try {
    await consumeOneTimeSkillModifierEffectIds(actor, effectIds);
  } catch (error) {
    console.error("Fallout MaW | Failed to consume one-time skill modifiers", error);
  } finally {
    for (const effectId of effectIds) effectClaims.delete(effectId);
  }
}

async function consumeOneTimeSkillModifiersForAttack(context = {}) {
  const weaponAttackId = String(context.attackId ?? "").trim();
  const actorUuid = String(context.attackerUuid ?? context.actorUuid ?? "").trim();
  if (!weaponAttackId || !actorUuid) return;

  const actor = fromUuidSync(actorUuid);
  if (!actor || (!game.user?.isGM && !actor.isOwner)) return;
  const claimedEffectIds = Array.from(effectClaims.entries())
    .filter(([_effectId, claim]) => (
      claim.weaponAttackId === weaponAttackId
      && claim.actorUuid === actorUuid
    ))
    .map(([effectId]) => effectId);
  if (!claimedEffectIds.length) return;
  const existingEffectIds = claimedEffectIds.filter(effectId => actor.effects?.get?.(effectId));

  try {
    if (existingEffectIds.length) await consumeOneTimeSkillModifierEffectIds(actor, existingEffectIds);
  } catch (error) {
    console.error("Fallout MaW | Failed to consume attack-scoped skill modifiers", error);
  } finally {
    for (const effectId of claimedEffectIds) effectClaims.delete(effectId);
  }
}

async function consumeOneTimeSkillModifierEffectIds(actor, effectIds = []) {
  const deleteIds = [];
  for (const effectId of Array.from(new Set(effectIds))) {
    const effect = actor.effects?.get?.(effectId);
    const data = effect?.getFlag?.(SYSTEM_ID, ONE_TIME_SKILL_MODIFIER_FLAG_KEY);
    if (!effect || getOneTimeSkillModifierRemainingUses(data) <= 0) continue;

    const remainingUses = getOneTimeSkillModifierRemainingUses(data) - 1;
    if (remainingUses <= 0) {
      deleteIds.push(effect.id);
    } else {
      await effect.setFlag(SYSTEM_ID, ONE_TIME_SKILL_MODIFIER_FLAG_KEY, {
        ...data,
        remainingUses
      });
    }
  }
  if (deleteIds.length) await actor.deleteEmbeddedDocuments("ActiveEffect", deleteIds);
}

function getOneTimeSkillModifierRemainingUses(data = {}) {
  if (!data || typeof data !== "object") return 0;
  const remainingUses = toInteger(data.remainingUses ?? data.uses);
  if (remainingUses > 0) return remainingUses;
  return data.pending ? 1 : 0;
}
