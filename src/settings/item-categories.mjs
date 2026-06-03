export function createDefaultItemCategorySettings() {
  return {
    categories: []
  };
}

export function normalizeItemCategorySettings(settings) {
  const source = normalizeCategoryInput(settings);
  const used = new Set();
  const categories = [];

  for (const raw of source) {
    const label = String(raw?.label ?? raw?.name ?? raw ?? "").trim();
    if (!label || used.has(label)) continue;
    used.add(label);
    categories.push({ label });
  }

  return { categories };
}

function normalizeCategoryInput(settings) {
  if (settings === undefined || settings === null) return createDefaultItemCategorySettings().categories;
  if (Array.isArray(settings)) return settings;
  if (Array.isArray(settings?.categories)) return settings.categories;
  if (Array.isArray(settings?.entries)) return settings.entries;
  if (settings && typeof settings === "object") return Object.values(settings);
  return createDefaultItemCategorySettings().categories;
}
