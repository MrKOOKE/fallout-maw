export function localize(key) {
  return globalThis.game?.i18n?.localize?.(key) ?? key;
}

export function format(key, data = {}) {
  return globalThis.game?.i18n?.format?.(key, data) ?? `${key} ${JSON.stringify(data)}`;
}
