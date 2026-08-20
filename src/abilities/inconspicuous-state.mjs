import { SYSTEM_ID } from "../constants.mjs";
import {
  ABILITY_FIXED_FUNCTION_KEYS,
  ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY
} from "../settings/abilities.mjs";
import { toInteger } from "../utils/numbers.mjs";

export function getInconspicuousStateKey(abilityFunction = {}) {
  return [
    String(abilityFunction?.id ?? "").trim(),
    ABILITY_FIXED_FUNCTION_KEYS.inconspicuous
  ].filter(Boolean).join(":");
}

export function getInconspicuousRoundState(abilityItem = null, abilityFunction = {}) {
  const stateKey = getInconspicuousStateKey(abilityFunction);
  const allState = abilityItem?.getFlag?.(SYSTEM_ID, ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY)
    ?? abilityItem?.flags?.[SYSTEM_ID]?.[ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY]
    ?? {};
  const state = allState?.[stateKey];
  return {
    stateKey,
    combatUuid: String(state?.combatUuid ?? "").trim(),
    round: Math.max(0, toInteger(state?.round)),
    attacked: state?.attacked === true
  };
}

export function isInconspicuousRoundStateCurrent(state = {}, combat = null, round = combat?.round) {
  const combatUuid = String(combat?.uuid ?? combat?.id ?? "").trim();
  const currentRound = Math.max(0, toInteger(round));
  return Boolean(combatUuid)
    && currentRound > 0
    && String(state?.combatUuid ?? "") === combatUuid
    && Math.max(0, toInteger(state?.round)) === currentRound;
}

export function buildInconspicuousRoundStateUpdate(abilityFunction = {}, {
  combat = null,
  round = combat?.round,
  attacked = false
} = {}) {
  const stateKey = getInconspicuousStateKey(abilityFunction);
  if (!stateKey) return {};
  const root = `flags.${SYSTEM_ID}.${ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY}.${stateKey}`;
  return {
    [`${root}.fixedKey`]: ABILITY_FIXED_FUNCTION_KEYS.inconspicuous,
    [`${root}.combatUuid`]: String(combat?.uuid ?? combat?.id ?? "").trim(),
    [`${root}.round`]: Math.max(0, toInteger(round)),
    [`${root}.attacked`]: attacked === true
  };
}
