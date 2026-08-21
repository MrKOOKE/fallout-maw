import { buildRequirementPercentModifierChanges } from "../items/requirement-modifiers.mjs";
import {
  MAINTAINED_TARGET_EFFECT_SYNC_OPTION,
  createMaintainedTargetEffectApi
} from "./maintained-target-effects.mjs";

export const PERFECT_FIT_HOLD_FLAG_KEY = "perfectFitHold";
export const PERFECT_FIT_GRANT_FLAG_KEY = "perfectFitGrant";
export const PERFECT_FIT_EFFECT_SYNC_OPTION = MAINTAINED_TARGET_EFFECT_SYNC_OPTION;

export const PERFECT_FIT_MAINTAINED_EFFECTS = createMaintainedTargetEffectApi({
  holdFlagKey: PERFECT_FIT_HOLD_FLAG_KEY,
  grantFlagKey: PERFECT_FIT_GRANT_FLAG_KEY,
  color: "#8fd3ff"
});

export const getPerfectFitHoldData = PERFECT_FIT_MAINTAINED_EFFECTS.getHoldData;
export const getPerfectFitGrantData = PERFECT_FIT_MAINTAINED_EFFECTS.getGrantData;
export const getPerfectFitHolds = PERFECT_FIT_MAINTAINED_EFFECTS.getHolds;
export const findPerfectFitGrant = PERFECT_FIT_MAINTAINED_EFFECTS.findGrant;

export function buildPerfectFitGrantEffectData({
  equipmentRequirementPercent = -50,
  weaponRequirementPercent = -50,
  ...context
} = {}) {
  const equipmentPercent = normalizeRequirementPercent(equipmentRequirementPercent);
  const weaponPercent = normalizeRequirementPercent(weaponRequirementPercent);
  return PERFECT_FIT_MAINTAINED_EFFECTS.buildGrantEffectData({
    ...context,
    fallbackName: "Идеальная подгонка",
    changes: buildRequirementPercentModifierChanges({ equipmentPercent, weaponPercent }),
    metadata: {
      equipmentRequirementPercent: equipmentPercent,
      weaponRequirementPercent: weaponPercent
    }
  });
}

export function buildPerfectFitHoldEffectData({
  equipmentRequirementPercent = -50,
  weaponRequirementPercent = -50,
  ...context
} = {}) {
  const equipmentPercent = normalizeRequirementPercent(equipmentRequirementPercent);
  const weaponPercent = normalizeRequirementPercent(weaponRequirementPercent);
  return PERFECT_FIT_MAINTAINED_EFFECTS.buildHoldEffectData({
    ...context,
    fallbackName: "Идеальная подгонка",
    metadata: {
      equipmentRequirementPercent: equipmentPercent,
      weaponRequirementPercent: weaponPercent
    }
  });
}

function normalizeRequirementPercent(value) {
  const number = Number(value);
  return Math.max(-100, Number.isFinite(number) ? number : 0);
}
