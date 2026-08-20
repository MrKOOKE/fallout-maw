import { getActorFactionRelation } from "../settings/factions.mjs";

export const REGION_TARGET_RELATIONS = Object.freeze(["ally", "neutral", "enemy"]);

export function normalizeRegionTargetRelations(value = REGION_TARGET_RELATIONS) {
  const entries = Array.isArray(value) ? value : Object.values(value ?? {});
  const accepted = new Set(entries.map(entry => String(entry ?? "").trim()));
  const normalized = REGION_TARGET_RELATIONS.filter(relation => accepted.has(relation));
  return normalized.length ? normalized : [...REGION_TARGET_RELATIONS];
}

export function getRegionSourceActor(region = null, behavior = null) {
  const explicitUuid = String(behavior?.system?.sourceActorUuid ?? "").trim();
  if (explicitUuid) {
    const explicit = globalThis.fromUuidSync?.(explicitUuid) ?? null;
    if (explicit?.documentName === "Actor") return explicit;
    if (explicit?.actor?.documentName === "Actor") return explicit.actor;
  }

  const tokenId = String(region?.attachment?.token ?? region?._source?.attachment?.token ?? "").trim();
  return tokenId ? region?.parent?.tokens?.get?.(tokenId)?.actor ?? null : null;
}

export function regionBehaviorTargetsActor(region = null, behavior = null, targetActor = null) {
  if (!targetActor) return false;
  const accepted = normalizeRegionTargetRelations(behavior?.system?.targetRelations);
  if (accepted.length === REGION_TARGET_RELATIONS.length) return true;

  const sourceActor = getRegionSourceActor(region, behavior);
  if (!sourceActor) return accepted.includes("neutral");
  if (sourceActor.uuid === targetActor.uuid) return accepted.includes("ally");
  return accepted.includes(getActorFactionRelation(sourceActor, targetActor));
}
