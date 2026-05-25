import { DEFAULT_CURRENCIES } from "../config/defaults.mjs";

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function createDefaultCurrencySettings() {
  return DEFAULT_CURRENCIES.map(entry => ({ ...entry }));
}

export function normalizeCurrencySettings(settings) {
  const source = normalizeCollectionInput(settings, createDefaultCurrencySettings());
  const used = new Set();
  const currencies = [];
  let primaryTradeAssigned = false;

  for (const raw of source) {
    const key = String(raw?.key ?? "").trim();
    if (!IDENTIFIER_PATTERN.test(key) || used.has(key)) continue;

    const primaryTrade = Boolean(raw?.primaryTrade) && !primaryTradeAssigned;
    if (primaryTrade) primaryTradeAssigned = true;
    used.add(key);
    currencies.push({
      key,
      label: String(raw?.label ?? raw?.name ?? "").trim() || `Валюта ${currencies.length + 1}`,
      img: String(raw?.img ?? raw?.image ?? "").trim(),
      value: normalizeCurrencyValue(raw?.value),
      primaryTrade
    });
  }

  if (currencies.length && !primaryTradeAssigned) currencies[0].primaryTrade = true;
  return currencies;
}

function normalizeCollectionInput(settings, defaults) {
  if (settings === undefined || settings === null) return defaults;
  if (Array.isArray(settings)) return settings;
  if (Array.isArray(settings?.entries)) return settings.entries;
  if (settings && typeof settings === "object") return Object.values(settings);
  return defaults;
}

function normalizeCurrencyValue(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
}
