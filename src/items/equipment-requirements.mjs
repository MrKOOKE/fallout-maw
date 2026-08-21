import { getAdjustedEquipmentRequirement } from "./requirement-modifiers.mjs";

export const EQUIPMENT_REQUIREMENT_MOVEMENT_POINT_RESOURCE_KEY = "movementPoints";
export const EQUIPMENT_REQUIREMENT_SKILL_POINTS_PER_MOVEMENT_POINT = 5;

export function getDamageMitigationRequirements(itemOrSystem = null) {
  const system = itemOrSystem?.system ?? itemOrSystem ?? {};
  const mitigation = system?.functions?.damageMitigation;
  if (!mitigation?.enabled) return [];
  return Array.isArray(mitigation.requirements) ? mitigation.requirements : [];
}

export function hasDamageMitigationRequirements(itemOrSystem = null) {
  return getDamageMitigationRequirements(itemOrSystem)
    .some(requirement => getEquipmentRequirementTarget(requirement));
}

export function isActiveDamageMitigationRequirementItem(item = null) {
  if (item?.type !== "gear" || !hasDamageMitigationRequirements(item)) return false;
  const mode = String(item.system?.placement?.mode ?? "");
  return Boolean(item.system?.equipped)
    || mode === "equipment"
    || mode === "constructPart";
}

export function calculateEquipmentRequirementMovementPointPenalty(actor = null, itemOrSystem = null) {
  return getDamageMitigationRequirements(itemOrSystem).reduce((total, requirement) => {
    const target = getEquipmentRequirementTarget(requirement, actor);
    if (!target) return total;
    const current = getActorEquipmentRequirementValue(actor, target);
    const deficit = Math.max(0, target.required - current);
    if (!deficit) return total;
    const penalty = target.type === "skill"
      ? Math.floor(deficit / EQUIPMENT_REQUIREMENT_SKILL_POINTS_PER_MOVEMENT_POINT)
      : deficit;
    return total + penalty;
  }, 0);
}

export function buildEquipmentRequirementMovementPointChange(actor = null, itemOrSystem = null) {
  const penalty = calculateEquipmentRequirementMovementPointPenalty(actor, itemOrSystem);
  if (!penalty) return null;
  return {
    key: `system.resources.${EQUIPMENT_REQUIREMENT_MOVEMENT_POINT_RESOURCE_KEY}.bonus`,
    type: "add",
    value: String(-penalty),
    phase: "initial",
    priority: null
  };
}

function getEquipmentRequirementTarget(requirement = {}, actor = null) {
  const type = String(requirement?.type ?? "") === "skill" ? "skill" : "characteristic";
  const key = String(requirement?.key ?? "").trim();
  const { required } = getAdjustedEquipmentRequirement(actor, { ...requirement, type, key });
  return key && required ? { type, key, required } : null;
}

function getActorEquipmentRequirementValue(actor = null, requirement = {}) {
  const key = String(requirement?.key ?? "").trim();
  if (!key) return 0;
  if (requirement.type === "skill") {
    const skill = actor?.system?.skills?.[key];
    return Math.max(0, toInteger(skill && typeof skill === "object" ? skill.value : skill));
  }
  return Math.max(0, toInteger(actor?.system?.characteristics?.[key]));
}

function toInteger(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}
