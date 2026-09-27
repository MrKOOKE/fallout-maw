export function localize(key, fallback) {
  const translated = globalThis.game?.i18n?.localize?.(key);
  if (translated != null && translated !== key) return translated;
  return fallback ?? translated ?? key;
}

export function format(key, data = {}, fallback) {
  const translated = globalThis.game?.i18n?.format?.(key, data);
  if (translated != null && translated !== key) return translated;
  if (fallback != null) return String(fallback).replace(/\{([^{}]+)\}/g, (match, name) =>
    Object.hasOwn(data, name) ? String(data[name]) : match);
  return translated ?? `${key} ${JSON.stringify(data)}`;
}
