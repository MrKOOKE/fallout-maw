export const EQUIPMENT_REQUIREMENT_PERCENT_EFFECT_KEY = "system.requirements.equipmentPercent";
export const WEAPON_REQUIREMENT_PERCENT_EFFECT_KEY = "system.requirements.weaponPercent";

export const REQUIREMENT_MODIFIER_KINDS = Object.freeze({
  equipment: "equipment",
  weapon: "weapon"
});

/** Build ordinary ActiveEffect changes which can be reused by any ability. */
export function buildRequirementPercentModifierChanges({
  equipmentPercent = 0,
  weaponPercent = 0
} = {}) {
  return [
    {
      id: "equipment-requirement-percent",
      key: EQUIPMENT_REQUIREMENT_PERCENT_EFFECT_KEY,
      type: "add",
      value: String(toFiniteNumber(equipmentPercent)),
      phase: "initial",
      priority: null
    },
    {
      id: "weapon-requirement-percent",
      key: WEAPON_REQUIREMENT_PERCENT_EFFECT_KEY,
      type: "add",
      value: String(toFiniteNumber(weaponPercent)),
      phase: "initial",
      priority: null
    }
  ].filter(change => Number(change.value) !== 0);
}

export function getActorRequirementPercentModifier(actor = null, kind = "") {
  const key = kind === REQUIREMENT_MODIFIER_KINDS.equipment ? "equipmentPercent" : "weaponPercent";
  return Math.max(-100, toFiniteNumber(actor?.system?.requirements?.[key]));
}

export function getAdjustedEquipmentRequirement(actor = null, requirement = {}) {
  return getAdjustedRequirement(actor, requirement, REQUIREMENT_MODIFIER_KINDS.equipment);
}

export function getAdjustedWeaponRequirement(actor = null, requirement = {}) {
  return getAdjustedRequirement(actor, requirement, REQUIREMENT_MODIFIER_KINDS.weapon);
}

export function getAdjustedRequirement(actor = null, requirement = {}, kind = "") {
  const type = String(requirement?.type ?? "") === "skill" ? "skill" : "characteristic";
  const key = String(requirement?.key ?? "").trim();
  const baseRequired = Math.max(0, toInteger(requirement?.required ?? requirement?.value));
  const modifierPercent = getActorRequirementPercentModifier(actor, kind);
  const required = modifierPercent
    ? Math.max(0, Math.ceil(baseRequired * (100 + modifierPercent) / 100))
    : baseRequired;
  return { type, key, baseRequired, required, modifierPercent };
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function toInteger(value) {
  return Math.trunc(toFiniteNumber(value));
}
