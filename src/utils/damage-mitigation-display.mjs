import { getUniqueLimbSets } from "../settings/traumas.mjs";
import { getDamageMitigationFunction } from "./item-functions.mjs";

const FALLBACK_DAMAGE_TYPE_ICON = "icons/svg/d20-grey.svg";

export function buildDamageMitigationLimbSetChoices(itemOrSystem, creatureOptions = {}) {
  const limbSets = getUniqueLimbSets(creatureOptions);
  const selectedIds = new Set(getSelectedDamageMitigationLimbSetIds(itemOrSystem, limbSets));
  let selectedIndex = 0;

  return limbSets.map(group => {
    const selected = selectedIds.has(group.id);
    return {
      ...group,
      selected,
      selectedIndex: selected ? selectedIndex++ : null,
      limbsShortLabel: group.limbs.map(limb => getLimbShortLabel(limb.label || limb.key)).join(", ")
    };
  });
}

export function buildDamageMitigationTables(itemOrSystem, creatureOptions = {}, damageTypeSettings = [], { actorRaceId = "" } = {}) {
  const limbSets = getUniqueLimbSets(creatureOptions);
  const entries = getDamageMitigationFunction(itemOrSystem)?.entries ?? {};
  if (!limbSets.length) return [];

  const selectedIds = new Set(getSelectedDamageMitigationLimbSetIds(itemOrSystem, limbSets));
  const actorGroup = actorRaceId
    ? limbSets.find(group => group.races.some(race => race.id === actorRaceId))
    : null;
  const groups = actorGroup && selectedIds.has(actorGroup.id)
    ? [actorGroup]
    : limbSets.filter(group => selectedIds.has(group.id));

  return groups.map(group => buildDamageMitigationTableForGroup(group, entries, damageTypeSettings));
}

export function getSelectedDamageMitigationLimbSetIds(itemOrSystem, limbSets = []) {
  const mitigation = getDamageMitigationFunction(itemOrSystem);
  const validIds = new Set(limbSets.map(group => group.id));
  const source = Array.isArray(mitigation?.limbSetIds) ? mitigation.limbSetIds : [];
  const selected = source
    .map(id => String(id ?? "").trim())
    .filter(id => id && validIds.has(id));
  return selected.length ? selected : limbSets.map(group => group.id);
}

export function getLimbShortLabel(label = "") {
  const words = String(label ?? "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  if (words.length === 1) return takeChars(words[0], 3);
  return `${takeChars(words[0], 2)}${words.slice(1).map(word => takeChars(word, 1).toLocaleUpperCase()).join("")}`;
}

function buildDamageMitigationTableForGroup(group, entries = {}, damageTypeSettings = []) {
  const limbs = group.limbs.map(limb => ({
    key: limb.key,
    label: String(limb.label ?? limb.name ?? limb.key),
    shortLabel: getLimbShortLabel(limb.label ?? limb.name ?? limb.key)
  }));

  return {
    id: group.id,
    raceNames: group.raceNames,
    limbs,
    columns: Math.max(1, limbs.length),
    rows: damageTypeSettings.map((damageType, rowIndex) => ({
      damageTypeKey: damageType.key,
      damageTypeLabel: damageType.label || damageType.key,
      damageTypeImg: String(damageType.img ?? "").trim() || FALLBACK_DAMAGE_TYPE_ICON,
      damageTypeColor: String(damageType.color ?? "").trim() || "#f0d48a",
      cells: limbs.map((limb, columnIndex) => {
        const value = Number(entries?.[limb.key]?.[damageType.key]?.value) || 0;
        return {
          limbKey: limb.key,
          damageTypeKey: damageType.key,
          rowIndex,
          columnIndex,
          value,
          valueClass: getMitigationValueClass(value)
        };
      })
    }))
  };
}

function getMitigationValueClass(value = 0) {
  const numeric = Number(value) || 0;
  if (numeric > 0) return "positive";
  if (numeric < 0) return "negative";
  return "neutral";
}

function takeChars(value = "", count = 0) {
  return Array.from(String(value ?? "")).slice(0, count).join("");
}
