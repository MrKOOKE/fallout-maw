// Восстановление категорий предметов после миграции (merge, без перезаписи).
// Запустите от GM в мире fallout-maw.

const SYSTEM_ID = "fallout-maw";
const LABELS = [
  "Оружие",
  "Снаряжение",
  "Пища",
  "Алкоголь",
  "Материалы",
  "Хлам",
  "Инструменты",
  "Журналы",
  "Первая помощь",
  "Боеприпасы",
  "Испорченная",
  "Компоненты готовки",
  "Напитки",
  "Приготовленная",
  "Сырая"
];

function normalizeMigrationItemCategories(settings) {
  if (settings === undefined || settings === null) return [];
  if (Array.isArray(settings)) {
    return settings
      .map(entry => ({ label: String(entry?.label ?? entry?.key ?? entry ?? "").trim() }))
      .filter(entry => entry.label);
  }
  if (Array.isArray(settings?.categories)) {
    return settings.categories
      .map(entry => ({ label: String(entry?.label ?? entry ?? "").trim() }))
      .filter(entry => entry.label);
  }
  if (Array.isArray(settings?.entries)) {
    return settings.entries
      .map(entry => ({ label: String(entry?.label ?? entry ?? "").trim() }))
      .filter(entry => entry.label);
  }
  return [];
}

async function ensureItemCategories(labels) {
  try {
    const labelsToAdd = Array.from(new Set((labels ?? [])
      .map(label => String(label ?? "").trim())
      .filter(Boolean)));
    if (!labelsToAdd.length) return;

    const raw = game.settings.get(SYSTEM_ID, "itemCategories");
    const categories = normalizeMigrationItemCategories(raw);
    const existing = new Set(categories.map(entry => entry.label));

    let changed = false;
    for (const label of labelsToAdd) {
      if (existing.has(label)) continue;
      categories.push({ label });
      existing.add(label);
      changed = true;
    }

    if (changed) {
      await game.settings.set(SYSTEM_ID, "itemCategories", { categories });
    }
  } catch (error) {
    console.warn("Не удалось обновить категории предметов.", error);
  }
}

if (game.system.id !== SYSTEM_ID) {
  ui.notifications.error("Этот макрос рассчитан на систему fallout-maw.");
} else {
  const before = normalizeMigrationItemCategories(game.settings.get(SYSTEM_ID, "itemCategories"));
  await ensureItemCategories(LABELS);
  const after = normalizeMigrationItemCategories(game.settings.get(SYSTEM_ID, "itemCategories"));
  ui.notifications.info(`Категории предметов: было ${before.length}, стало ${after.length}.`);
  console.log("Item categories restore", { before, after });
}
