import { buildEquipmentEffectivenessChanges } from "../items/equipment-effectiveness.mjs";
import { createMaintainedTargetEffectApi } from "./maintained-target-effects.mjs";

export const QUALITY_SERVICE_HOLD_FLAG_KEY = "qualityServiceHold";
export const QUALITY_SERVICE_GRANT_FLAG_KEY = "qualityServiceGrant";

const DEFAULT_TIERS = Object.freeze([
  Object.freeze({
    id: "10",
    holdEnergy: 10,
    damagePercent: 5,
    criticalChance: 0,
    criticalDamagePercent: 0,
    accuracy: 10,
    protectionPercent: 5,
    equipmentBonusPercent: 0
  }),
  Object.freeze({
    id: "20",
    holdEnergy: 20,
    damagePercent: 10,
    criticalChance: 3,
    criticalDamagePercent: 0,
    accuracy: 20,
    protectionPercent: 10,
    equipmentBonusPercent: 0
  }),
  Object.freeze({
    id: "40",
    holdEnergy: 40,
    damagePercent: 15,
    criticalChance: 5,
    criticalDamagePercent: 20,
    accuracy: 30,
    protectionPercent: 15,
    equipmentBonusPercent: 15
  })
]);

export const QUALITY_SERVICE_MAINTAINED_EFFECTS = createMaintainedTargetEffectApi({
  holdFlagKey: QUALITY_SERVICE_HOLD_FLAG_KEY,
  grantFlagKey: QUALITY_SERVICE_GRANT_FLAG_KEY
});

export const getQualityServiceHoldData = QUALITY_SERVICE_MAINTAINED_EFFECTS.getHoldData;
export const getQualityServiceGrantData = QUALITY_SERVICE_MAINTAINED_EFFECTS.getGrantData;
export const getQualityServiceHolds = QUALITY_SERVICE_MAINTAINED_EFFECTS.getHolds;
export const findQualityServiceGrant = QUALITY_SERVICE_MAINTAINED_EFFECTS.findGrant;

export function normalizeQualityServiceSettings(value = {}) {
  const inputById = new Map((Array.isArray(value?.tiers) ? value.tiers : [])
    .map(entry => [String(entry?.id ?? ""), entry]));
  return {
    tiers: DEFAULT_TIERS.map(defaults => normalizeTier(inputById.get(defaults.id), defaults))
  };
}

export function getQualityServiceTiers(value = {}) {
  return normalizeQualityServiceSettings(value).tiers.map(tier => ({
    ...tier,
    label: `${tier.holdEnergy} энергии`,
    summary: formatQualityServiceTierSummary(tier)
  }));
}

export function getQualityServiceTier(value = {}, tierId = "") {
  const tiers = getQualityServiceTiers(value);
  const requestedId = String(tierId ?? "").trim();
  return tiers.find(tier => tier.id === requestedId) ?? tiers[0] ?? null;
}

export function buildQualityServiceChanges(tier = {}) {
  const changes = [];
  addCombatChange(changes, "damage-percent", "system.combat.damagePercent", tier.damagePercent);
  addCombatChange(changes, "critical-chance", "system.combat.criticalChance", tier.criticalChance);
  addCombatChange(changes, "critical-damage-percent", "system.combat.criticalDamagePercent", tier.criticalDamagePercent);
  addCombatChange(changes, "accuracy", "system.combat.accuracy", tier.accuracy);
  changes.push(...buildEquipmentEffectivenessChanges({
    protectionPercent: tier.protectionPercent,
    bonusPercent: tier.equipmentBonusPercent
  }));
  return changes;
}

export function buildQualityServiceGrantEffectData({ tier = null, ...context } = {}) {
  const profile = tier ?? getQualityServiceTier();
  return QUALITY_SERVICE_MAINTAINED_EFFECTS.buildGrantEffectData({
    ...context,
    fallbackName: "Качественное обслуживание",
    changes: buildQualityServiceChanges(profile),
    metadata: buildTierMetadata(profile)
  });
}

export function buildQualityServiceHoldEffectData({ tier = null, ...context } = {}) {
  const profile = tier ?? getQualityServiceTier();
  return QUALITY_SERVICE_MAINTAINED_EFFECTS.buildHoldEffectData({
    ...context,
    holdEnergy: profile.holdEnergy,
    fallbackName: "Качественное обслуживание",
    metadata: buildTierMetadata(profile)
  });
}

export function formatQualityServiceTierSummary(tier = {}) {
  const parts = [
    `урон +${toNumber(tier.damagePercent)}%`,
    `точность +${toNumber(tier.accuracy)}`,
    `защита +${toNumber(tier.protectionPercent)}%`
  ];
  if (toNumber(tier.criticalChance)) parts.splice(1, 0, `крит +${toNumber(tier.criticalChance)}%`);
  if (toNumber(tier.criticalDamagePercent)) parts.splice(2, 0, `крит. урон +${toNumber(tier.criticalDamagePercent)}%`);
  if (toNumber(tier.equipmentBonusPercent)) parts.push(`предметные бонусы +${toNumber(tier.equipmentBonusPercent)}%`);
  return parts.join(" · ");
}

function normalizeTier(value, defaults) {
  const source = value && typeof value === "object" ? value : {};
  return {
    id: defaults.id,
    holdEnergy: Math.max(0, toInteger(source.holdEnergy ?? defaults.holdEnergy)),
    damagePercent: toNumber(source.damagePercent ?? defaults.damagePercent),
    criticalChance: toNumber(source.criticalChance ?? defaults.criticalChance),
    criticalDamagePercent: toNumber(source.criticalDamagePercent ?? defaults.criticalDamagePercent),
    accuracy: toNumber(source.accuracy ?? defaults.accuracy),
    protectionPercent: toNumber(source.protectionPercent ?? defaults.protectionPercent),
    equipmentBonusPercent: toNumber(source.equipmentBonusPercent ?? defaults.equipmentBonusPercent)
  };
}

function buildTierMetadata(tier) {
  return {
    tierId: String(tier?.id ?? ""),
    tierLabel: String(tier?.label ?? `${toInteger(tier?.holdEnergy)} энергии`),
    tierSummary: String(tier?.summary ?? formatQualityServiceTierSummary(tier)),
    damagePercent: toNumber(tier?.damagePercent),
    criticalChance: toNumber(tier?.criticalChance),
    criticalDamagePercent: toNumber(tier?.criticalDamagePercent),
    accuracy: toNumber(tier?.accuracy),
    protectionPercent: toNumber(tier?.protectionPercent),
    equipmentBonusPercent: toNumber(tier?.equipmentBonusPercent)
  };
}

function addCombatChange(changes, id, key, value) {
  const numeric = toNumber(value);
  if (!numeric) return;
  changes.push({ id, key, type: "add", value: String(numeric), phase: "initial", priority: null });
}

function toInteger(value) {
  return Math.trunc(toNumber(value));
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
