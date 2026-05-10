import { FALLOUT_MAW } from "../config/system-config.mjs";
import { MIGRATION_STATE_SETTING } from "../settings/constants.mjs";

const SETTING_MIGRATIONS = Object.freeze([
]);

export async function migrateSystemSettings() {
  if (!game.user?.isGM || !isPrimaryActiveGM()) return;

  const state = normalizeMigrationState(game.settings.get(FALLOUT_MAW.id, MIGRATION_STATE_SETTING));
  const completed = new Set(state.completed);
  let changed = false;

  for (const migration of SETTING_MIGRATIONS) {
    if (!migration?.id || completed.has(migration.id)) continue;
    await migration.migrate();
    completed.add(migration.id);
    changed = true;
  }

  if (changed) {
    await game.settings.set(FALLOUT_MAW.id, MIGRATION_STATE_SETTING, {
      completed: Array.from(completed)
    });
  }
}

function normalizeMigrationState(value = {}) {
  const completed = Array.isArray(value?.completed) ? value.completed : [];
  return {
    completed: completed.map(entry => String(entry ?? "")).filter(Boolean)
  };
}

function isPrimaryActiveGM() {
  const activeGMs = (game.users?.contents ?? [])
    .filter(user => user.active && user.isGM)
    .sort((left, right) => left.id.localeCompare(right.id));
  return activeGMs.at(0)?.id === game.user?.id;
}
