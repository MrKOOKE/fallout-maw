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
  const visibleDamageTypes = damageTypeSettings.filter(damageType => !damageType?.locked && !damageType?.system);
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
    rows: visibleDamageTypes.map((damageType, rowIndex) => ({
      damageTypeKey: damageType.key,
      damageTypeLabel: damageType.label || damageType.key,
      damageTypeImg: String(damageType.img ?? "").trim() || FALLBACK_DAMAGE_TYPE_ICON,
      damageTypeColor: String(damageType.color ?? "").trim() || "#f0d48a",
      damageTypeIconStyle: buildDamageTypeIconStyle(damageType),
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

export function buildDamageTypeIconStyle(damageType = {}) {
  const color = String(damageType.color ?? damageType.damageTypeColor ?? "").trim() || "#f0d48a";
  const img = getCssUrlPath(String(damageType.img ?? damageType.damageTypeImg ?? "").trim() || FALLBACK_DAMAGE_TYPE_ICON);
  return `--fallout-maw-damage-type-color: ${color}; --fallout-maw-damage-type-image: url("${escapeCssUrl(img)}");`;
}

function getCssUrlPath(value = "") {
  const path = String(value ?? "").trim().replace(/\\/g, "/");
  if (!path) return `/${FALLBACK_DAMAGE_TYPE_ICON}`;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(path)) return path;
  return `/${path.replace(/^\.\//, "")}`;
}

function escapeCssUrl(value = "") {
  return String(value ?? "")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, "");
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
