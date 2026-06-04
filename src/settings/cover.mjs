import { FALLOUT_MAW } from "../config/system-config.mjs";

export const DEFAULT_COVER_EFFECT_KEY = "system.resources.dodge.bonus";

const DEFAULT_COVER_ICON_ROOT = `systems/${FALLOUT_MAW.id}/assets/HUD`;
const COVER_CHANGE_TYPES = new Set(["add", "multiply", "override", "upgrade", "downgrade", "custom"]);

export const COVER_CHANGE_TYPE_CHOICES = Object.freeze([
  { value: "add", label: "Добавить" },
  { value: "multiply", label: "Умножить" },
  { value: "override", label: "Переопределить" },
  { value: "upgrade", label: "Повысить" },
  { value: "downgrade", label: "Понизить" },
  { value: "custom", label: "Особый" }
]);

export function createDefaultCoverSettings() {
  return {
    entries: [
      createCoverEntry({
        key: "partial",
        label: "Частичное",
        img: `${DEFAULT_COVER_ICON_ROOT}/shield_low.svg`,
        overlapPercent: 25,
        change: { value: "25" }
      }),
      createCoverEntry({
        key: "half",
        label: "Половинчатое",
        img: `${DEFAULT_COVER_ICON_ROOT}/shield_half.svg`,
        overlapPercent: 50,
        change: { value: "50" }
      }),
      createCoverEntry({
        key: "full",
        label: "Полное",
        img: `${DEFAULT_COVER_ICON_ROOT}/shield_full.svg`,
        overlapPercent: 80,
        change: { value: "100" }
      })
    ]
  };
}

export function normalizeCoverSettings(value = {}) {
  const sourceEntries = Array.isArray(value)
    ? value
    : normalizeIndexedCollection(value?.entries);
  const entriesSource = sourceEntries.length ? sourceEntries : createDefaultCoverSettings().entries;
  const used = new Set();
  const entries = entriesSource
    .map((entry, index) => normalizeCoverEntry(entry, index, used))
    .filter(Boolean);
  return { entries: entries.length ? entries : createDefaultCoverSettings().entries };
}

export function normalizeCoverEntry(entry = {}, index = 0, used = new Set()) {
  const key = makeUniqueCoverKey(String(entry?.key ?? `cover${index + 1}`).trim(), used, index);
  if (!key) return null;
  const label = String(entry?.label ?? entry?.name ?? key).trim() || key;
  return createCoverEntry({
    key,
    label,
    img: String(entry?.img ?? "").trim() || "icons/svg/shield.svg",
    overlapPercent: clampInteger(entry?.overlapPercent ?? entry?.coveragePercent, 0, 0, 100),
    change: normalizeCoverChange(entry?.change ?? entry?.effect ?? entry)
  });
}

export function createBlankCoverEntry(index = 0) {
  return createCoverEntry({
    key: `cover${index + 1}`,
    label: "Укрытие",
    img: "icons/svg/shield.svg",
    overlapPercent: 0,
    change: { value: "0" }
  });
}

export function getCoverChangeTypeChoices(selected = "add") {
  const current = normalizeCoverChangeType(selected);
  return COVER_CHANGE_TYPE_CHOICES.map(choice => ({
    ...choice,
    selected: choice.value === current
  }));
}

function createCoverEntry({ key, label, img, overlapPercent = 0, change = {} } = {}) {
  return {
    key: String(key ?? "").trim(),
    label: String(label ?? "").trim(),
    img: String(img ?? "").trim(),
    overlapPercent: clampInteger(overlapPercent, 0, 0, 100),
    change: normalizeCoverChange(change)
  };
}

function normalizeCoverChange(change = {}) {
  return {
    key: normalizeCoverChangeKey(change?.key),
    type: normalizeCoverChangeType(change?.type),
    value: String(change?.value ?? "0").trim(),
    phase: String(change?.phase ?? "initial").trim() || "initial",
    priority: clampInteger(change?.priority, 0, -9999, 9999)
  };
}

function normalizeCoverChangeKey(value) {
  const key = String(value ?? DEFAULT_COVER_EFFECT_KEY).trim() || DEFAULT_COVER_EFFECT_KEY;
  return key.replace(/^system\.resources\.([^.]+)\.value$/u, "system.resources.$1.bonus");
}

function normalizeCoverChangeType(value) {
  const type = String(value ?? "add").trim();
  return COVER_CHANGE_TYPES.has(type) ? type : "add";
}

function normalizeIndexedCollection(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  return Object.entries(value)
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([_key, entry]) => entry);
}

function makeUniqueCoverKey(key, used, index) {
  const base = key || `cover${index + 1}`;
  let candidate = base.replace(/\s+/g, "-");
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function clampInteger(value, fallback = 0, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY) {
  const number = Number(value);
  const integer = Number.isFinite(number) ? Math.trunc(number) : fallback;
  return Math.min(max, Math.max(min, integer));
}
