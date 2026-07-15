import {
  getCreatureOptions,
  getCurrencySettings,
  getDamageTypeSettings,
  getNeedSettings,
  getResourceSettings
} from "../settings/accessors.mjs";
import {
  getEventReactionDepthProfile,
  normalizeEventReactionDepthFilterMap,
  normalizeEventReactionDepthFilterValues
} from "./event-reaction-schema.mjs";

const WEAPON_ACTIONS = Object.freeze([
  ["aimedShot", "FALLOUTMAW.Item.WeaponActionAimedShot", "Aimed shot"],
  ["snapshot", "FALLOUTMAW.Item.WeaponActionSnapshot", "Snapshot"],
  ["burst", "FALLOUTMAW.Item.WeaponActionBurst", "Burst"],
  ["volley", "FALLOUTMAW.Item.WeaponActionVolley", "Volley"],
  ["meleeAttack", "FALLOUTMAW.Item.WeaponActionMeleeAttack", "Unaimed attack"],
  ["aimedMeleeAttack", "FALLOUTMAW.Item.WeaponActionAimedMeleeAttack", "Aimed attack"],
  ["push", "FALLOUTMAW.Item.WeaponActionPush", "Push"]
]);

const DAMAGE_SCOPES = Object.freeze([
  ["limb", "Limb"],
  ["health", "Health"],
  ["healthAndLimb", "Health and limb"],
  ["itemCondition", "Item condition"]
]);

const COMBAT_RESOURCES = Object.freeze([
  ["movementPoints", "Movement points"],
  ["actionPoints", "Action points"],
  ["reactionPoints", "Reaction points"]
]);

export function buildEventReactionDepthFilterGroups(condition = {}, eventKey = "", {
  inputNamePrefix = "",
  localize = defaultLocalize
} = {}) {
  const profile = getEventReactionDepthProfile(eventKey);
  const filters = normalizeEventReactionDepthFilterMap(condition?.eventFilters);
  return profile.filters.map(definition => {
    const selected = filters[definition.storageKey] ?? [];
    const available = getEventReactionDepthFilterChoices(definition.choiceSource, { localize });
    const rows = selected.map((value, index) => ({
      index,
      value,
      inputName: inputNamePrefix ? `${inputNamePrefix}.${definition.storageKey}.${index}` : "",
      choices: buildSelectedChoices(value, selected, available)
    }));
    return {
      ...definition,
      label: localize(`FALLOUTMAW.Events.Reaction.DepthFilters.${definition.id}.Label`, definition.id),
      emptyLabel: localize(`FALLOUTMAW.Events.Reaction.DepthFilters.${definition.id}.Any`, "Any (no filter)."),
      rows,
      canAdd: Boolean(available.find(choice => !selected.includes(choice.value)))
    };
  });
}

export function buildHiddenEventReactionDepthFilterRows(condition = {}, eventKey = "", {
  inputNamePrefix = ""
} = {}) {
  const activeStorageKeys = new Set(
    getEventReactionDepthProfile(eventKey).filters.map(definition => definition.storageKey)
  );
  const filters = normalizeEventReactionDepthFilterMap(condition?.eventFilters);
  return Object.entries(filters)
    .filter(([storageKey]) => !activeStorageKeys.has(storageKey))
    .flatMap(([storageKey, values]) => values.map((value, index) => ({
      storageKey,
      index,
      value,
      inputName: inputNamePrefix ? `${inputNamePrefix}.${storageKey}.${index}` : ""
    })));
}

export function getFirstUnusedEventReactionDepthFilterValue(condition = {}, eventKey = "", storageKey = "", {
  localize = defaultLocalize
} = {}) {
  const definition = getEventReactionDepthProfile(eventKey).filters
    .find(entry => entry.storageKey === String(storageKey ?? "").trim());
  if (!definition) return "";
  const filters = normalizeEventReactionDepthFilterMap(condition?.eventFilters);
  const selected = filters[definition.storageKey] ?? [];
  return getEventReactionDepthFilterChoices(definition.choiceSource, { localize })
    .find(choice => !selected.includes(choice.value))?.value ?? "";
}

export function setEventReactionDepthFilterValues(condition = {}, storageKey = "", values = []) {
  const key = String(storageKey ?? "").trim();
  if (!key) return condition;
  const filters = normalizeEventReactionDepthFilterMap(condition?.eventFilters);
  filters[key] = normalizeEventReactionDepthFilterValues(values);
  condition.eventFilters = filters;
  return condition;
}

export function getEventReactionDepthFilterValues(condition = {}, storageKey = "") {
  const key = String(storageKey ?? "").trim();
  return normalizeEventReactionDepthFilterMap(condition?.eventFilters)[key] ?? [];
}

function getEventReactionDepthFilterChoices(source = "", { localize }) {
  switch (source) {
    case "weaponActions":
      return WEAPON_ACTIONS.map(([value, labelKey, fallback]) => ({ value, label: localize(labelKey, fallback) }));
    case "damageTypes":
      return uniqueChoices(getDamageTypeSettings().map(entry => ({
        value: String(entry?.key ?? "").trim(),
        label: String(entry?.label ?? entry?.name ?? entry?.key ?? "").trim()
      })));
    case "damageScopes":
      return DAMAGE_SCOPES.map(([value, fallback]) => ({
        value,
        label: localize(`FALLOUTMAW.Events.Reaction.DepthFilters.damageScope.Options.${value}`, fallback)
      }));
    case "limbs":
      return uniqueChoices((getCreatureOptions().races ?? []).flatMap(race => (race?.limbs ?? []).map(limb => ({
        value: String(limb?.key ?? "").trim(),
        label: String(limb?.label ?? limb?.name ?? limb?.key ?? "").trim()
      }))));
    case "resources":
      return uniqueChoices([
        ...getResourceSettings().map(entry => ({
          value: String(entry?.key ?? "").trim(),
          label: String(entry?.label ?? entry?.name ?? entry?.key ?? "").trim()
        })),
        ...COMBAT_RESOURCES.map(([value, fallback]) => ({
          value,
          label: localize(`FALLOUTMAW.Events.Reaction.DepthFilters.resource.Options.${value}`, fallback)
        }))
      ]);
    case "needs":
      return uniqueChoices(getNeedSettings().map(entry => ({
        value: String(entry?.key ?? "").trim(),
        label: String(entry?.label ?? entry?.name ?? entry?.key ?? "").trim()
      })));
    case "currencies":
      return uniqueChoices(getCurrencySettings().map(entry => ({
        value: String(entry?.key ?? "").trim(),
        label: String(entry?.label ?? entry?.name ?? entry?.key ?? "").trim()
      })));
    case "statuses":
      return uniqueChoices(Array.from(globalThis.CONFIG?.statusEffects ?? []).map(entry => ({
        value: String(entry?.id ?? "").trim(),
        label: localize(String(entry?.name ?? entry?.label ?? entry?.id ?? ""), String(entry?.id ?? ""))
      })));
    case "itemTypes":
      return uniqueChoices(Object.keys(globalThis.CONFIG?.Item?.dataModels ?? {}).map(value => ({
        value,
        label: localize(String(globalThis.CONFIG?.Item?.typeLabels?.[value] ?? ""), value)
      })));
    case "trapDetected":
      return [
        { value: "true", label: localize("FALLOUTMAW.Events.Reaction.DepthFilters.trapDetected.Options.true", "Detected") },
        { value: "false", label: localize("FALLOUTMAW.Events.Reaction.DepthFilters.trapDetected.Options.false", "Not detected") }
      ];
    default:
      return [];
  }
}

function buildSelectedChoices(selectedValue = "", selectedValues = [], available = []) {
  const selected = String(selectedValue ?? "").trim();
  const taken = new Set(normalizeEventReactionDepthFilterValues(selectedValues));
  const choices = available.map(choice => ({
    ...choice,
    selected: choice.value === selected,
    disabled: choice.value !== selected && taken.has(choice.value)
  }));
  if (selected && !choices.some(choice => choice.value === selected)) {
    choices.push({ value: selected, label: selected, selected: true, disabled: false });
  }
  return choices;
}

function uniqueChoices(entries = []) {
  const choices = new Map();
  for (const entry of entries) {
    const value = String(entry?.value ?? "").trim();
    if (!value || choices.has(value)) continue;
    choices.set(value, { value, label: String(entry?.label ?? value).trim() || value });
  }
  return Array.from(choices.values());
}

function defaultLocalize(key = "", fallback = "") {
  const normalized = String(key ?? "").trim();
  if (!normalized) return String(fallback ?? "");
  const localized = globalThis.game?.i18n?.localize?.(normalized);
  return localized && localized !== normalized ? localized : (String(fallback ?? "") || normalized);
}
