import { FALLOUT_MAW } from "../config/system-config.mjs";
import { ABILITIES_CATALOG_SETTING, MIGRATION_STATE_SETTING } from "../settings/constants.mjs";
import { getSkillSettings } from "../settings/accessors.mjs";
import { migrateEncouragingSpeechCatalog } from "../settings/abilities.mjs";

const SETTING_MIGRATIONS = Object.freeze([
  Object.freeze({
    id: "encouraging-speech-constructor-v1",
    migrate: migrateEncouragingSpeechSetting
  })
]);

export async function migrateSystemSettings() {
  if (!game.user?.isGM || !isPrimaryActiveGM()) return;

  const state = normalizeMigrationState(game.settings.get(FALLOUT_MAW.id, MIGRATION_STATE_SETTING));
  const completed = new Set(state.completed);
  let changed = false;

  for (const migration of SETTING_MIGRATIONS) {
    if (!migration?.id || completed.has(migration.id)) continue;
    const completedSuccessfully = await migration.migrate();
    if (completedSuccessfully === false) continue;
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

async function migrateEncouragingSpeechSetting() {
  const current = game.settings.get(FALLOUT_MAW.id, ABILITIES_CATALOG_SETTING);
  const result = migrateEncouragingSpeechCatalog(current, getSkillSettings());
  if (result.matchCount > 1) {
    console.warn("Fallout MaW | Encouraging Speech migration skipped: duplicate source ids.");
    return false;
  }
  if (result.changed) {
    await game.settings.set(FALLOUT_MAW.id, ABILITIES_CATALOG_SETTING, result.catalog);
  }
  return true;
}
