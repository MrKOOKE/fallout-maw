export const FIRST_AID_EFFECT_KEYS = Object.freeze({
  incomingEffectivenessPercent: "system.firstAid.incomingEffectivenessPercent",
  outgoingEffectivenessPercent: "system.firstAid.outgoingEffectivenessPercent",
  durationPercent: "system.firstAid.durationPercent",
  withdrawalResistancePercent: "system.firstAid.withdrawalResistancePercent"
});

export const FIRST_AID_ACTION_POINT_COST_EFFECT_KEY = "system.costs.actions.firstAid";

export const FIRST_AID_EFFECT_KEY_FIELDS = Object.freeze(
  Object.keys(FIRST_AID_EFFECT_KEYS)
);

export function getFirstAidEffectKey(field = "") {
  return FIRST_AID_EFFECT_KEYS[String(field ?? "").trim()] ?? "";
}
