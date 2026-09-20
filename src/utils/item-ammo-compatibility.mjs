import { SYSTEM_ID } from "../constants.mjs";
import { getDamageSourceFunction, hasItemFunction, ITEM_FUNCTIONS } from "./item-functions.mjs";
import { toInteger } from "./numbers.mjs";
import { resolveWorldItemSync } from "./world-items.mjs";

const DAMAGE_SOURCE_PROTOTYPE_FLAG = "damageSourcePrototypeUuid";

export function canShowSuitableAmmo(item = null) {
  return Boolean(
    getItemMagazineSourceUuids(item).length
    || hasItemFunction(item, ITEM_FUNCTIONS.damageSource, { ignoreBroken: true })
  );
}

export function isAmmoCompatibleItem(sourceItem = null, candidate = null) {
  if (!sourceItem || !candidate || (sourceItem === candidate || (sourceItem.uuid && sourceItem.uuid === candidate.uuid))) return false;
  const sourceMagazineUuids = getItemMagazineSourceUuids(sourceItem);
  if (sourceMagazineUuids.length) {
    return hasItemFunction(candidate, ITEM_FUNCTIONS.damageSource, { ignoreBroken: true })
      && sourceMagazineUuids.some(uuid => damageSourceMatchesPrototype(candidate, uuid));
  }
  if (!hasItemFunction(sourceItem, ITEM_FUNCTIONS.damageSource, { ignoreBroken: true })) return false;
  const candidateMagazineUuids = getItemMagazineSourceUuids(candidate);
  return candidateMagazineUuids.some(uuid => damageSourceMatchesPrototype(sourceItem, uuid));
}

export function getItemMagazineSourceUuids(item = null) {
  return Array.from(new Set(getItemWeaponDataList(item)
    .flatMap(weaponData => [
      ...(Array.isArray(weaponData?.magazine?.sourceItemUuids) ? weaponData.magazine.sourceItemUuids : []),
      String(weaponData?.magazine?.sourceItemUuid ?? "")
    ])
    .map(value => String(value ?? "").trim())
    .filter(Boolean)));
}

function getItemWeaponDataList(item = null) {
  const functions = item?.system?.functions ?? {};
  const entries = [];
  if (functions.weapon?.enabled) entries.push(functions.weapon);
  const additional = functions.additionalWeapons;
  if (additional && typeof additional === "object") {
    entries.push(...Object.values(additional).filter(data => data?.enabled));
  }
  return entries;
}

function damageSourceMatchesPrototype(item = null, prototypeUuid = "") {
  const uuid = String(prototypeUuid ?? "").trim();
  if (!item || !uuid || !hasItemFunction(item, ITEM_FUNCTIONS.damageSource, { ignoreBroken: true })) return false;
  if (item.uuid === uuid || item.id === uuid) return true;
  const flagUuid = String(item.getFlag?.(SYSTEM_ID, DAMAGE_SOURCE_PROTOTYPE_FLAG) ?? item.getFlag?.("core", "sourceId") ?? "").trim();
  if (flagUuid === uuid) return true;
  const prototype = resolveWorldItemSync(uuid);
  if (!prototype || !hasItemFunction(prototype, ITEM_FUNCTIONS.damageSource, { ignoreBroken: true })) return false;
  if (item.name !== prototype.name) return false;
  return areDamageSourcesEqual(getDamageSourceFunction(item), getDamageSourceFunction(prototype));
}

function areDamageSourcesEqual(left = {}, right = {}) {
  if (String(left?.name ?? "") !== String(right?.name ?? "")) return false;
  if (String(left?.damage ?? "0") !== String(right?.damage ?? "0")) return false;
  if (String(left?.pellets ?? "1") !== String(right?.pellets ?? "1")) return false;
  if (String(left?.damageTypeKey ?? "") !== String(right?.damageTypeKey ?? "")) return false;
  if (String(left?.attackAnimationKey ?? "") !== String(right?.attackAnimationKey ?? "")) return false;
  if (String(left?.accuracyBonus ?? "0") !== String(right?.accuracyBonus ?? "0")) return false;
  if (String(left?.criticalChanceModifier ?? "0") !== String(right?.criticalChanceModifier ?? "0")) return false;
  if (String(left?.criticalDamagePercent ?? "0") !== String(right?.criticalDamagePercent ?? "0")) return false;
  if (String(left?.maxRangeMeters ?? "0") !== String(right?.maxRangeMeters ?? "0")) return false;
  if (String(left?.effectiveRange?.value ?? "0") !== String(right?.effectiveRange?.value ?? "0")) return false;
  if (String(left?.effectiveRange?.max ?? "0") !== String(right?.effectiveRange?.max ?? "0")) return false;
  if (String(left?.penetration ?? "0") !== String(right?.penetration ?? "0")) return false;
  if (toInteger(left?.noiseLevel) !== toInteger(right?.noiseLevel)) return false;
  if (normalizeDamageSourceTypes(left?.damageTypes) !== normalizeDamageSourceTypes(right?.damageTypes)) return false;
  return normalizeDamageSourceVolley(left?.volley) === normalizeDamageSourceVolley(right?.volley);
}

function normalizeDamageSourceTypes(entries = []) {
  return (Array.isArray(entries) ? entries : [])
    .map(entry => `${String(entry?.key ?? "")}:${toInteger(entry?.percent)}`)
    .sort()
    .join("|");
}

function normalizeDamageSourceVolley(volley = {}) {
  const regionDamage = (Array.isArray(volley?.regionDamageEntries) ? volley.regionDamageEntries : [])
    .map(entry => `${String(entry?.damageTypeKey ?? "")}:${String(entry?.amount ?? "0")}`)
    .sort()
    .join("|");
  return [
    String(volley?.damageRadius ?? "0"),
    String(volley?.regionRadius ?? "0"),
    regionDamage,
    normalizeRegionSpecialPropertySignature(volley?.regionSpecialProperties),
    String(volley?.regionDurationSeconds ?? "0"),
    String(volley?.regionDelaySeconds ?? "0"),
    String(volley?.regionRadiusDeltaMeters ?? "0"),
    String(volley?.explosionAnimationKey ?? "")
  ].join(";");
}

function normalizeRegionSpecialPropertySignature(entries = []) {
  return (Array.isArray(entries) ? entries : Object.values(entries ?? {}))
    .filter(entry => String(entry?.type ?? "").trim() === "smoke")
    .map(entry => `smoke:${String(entry?.smoke?.thickness ?? "1")}:${String(entry?.smoke?.densityPercent ?? "50")}`)
    .at(0) ?? "";
}
