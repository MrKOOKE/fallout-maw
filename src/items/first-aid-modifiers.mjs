import { getContextualAbilityChangeValues } from "../abilities/evaluation.mjs";
import { toInteger } from "../utils/numbers.mjs";
import {
  FIRST_AID_EFFECT_KEY_FIELDS,
  FIRST_AID_EFFECT_KEYS
} from "./first-aid-effect-keys.mjs";
import {
  ANATOMY_STUDY_BONUS_KEYS,
  getActorAnatomyStudyBonus
} from "../abilities/anatomy-study.mjs";

export function getActorFirstAidModifiers(actor = null, context = {}) {
  if (!actor) return createEmptyFirstAidModifiers();
  const values = getContextualAbilityChangeValues(
    actor,
    FIRST_AID_EFFECT_KEY_FIELDS.map(field => ({
      id: field,
      key: FIRST_AID_EFFECT_KEYS[field],
      baseValue: toInteger(actor?.system?.firstAid?.[field])
    })),
    context
  );
  const modifiers = Object.fromEntries(
    FIRST_AID_EFFECT_KEY_FIELDS.map(field => [field, toInteger(values[field])])
  );
  modifiers.outgoingEffectivenessPercent += getActorAnatomyStudyBonus(
    actor,
    context?.targetActor ?? context?.targetToken?.actor ?? null,
    ANATOMY_STUDY_BONUS_KEYS.drugEffectiveness
  );
  return modifiers;
}

export function getActorFirstAidModifierPercent(actor = null, field = "", context = {}) {
  const key = String(field ?? "").trim();
  if (!FIRST_AID_EFFECT_KEYS[key]) return 0;
  return getActorFirstAidModifiers(actor, context)[key];
}

export function createEmptyFirstAidModifiers() {
  return Object.fromEntries(FIRST_AID_EFFECT_KEY_FIELDS.map(field => [field, 0]));
}
