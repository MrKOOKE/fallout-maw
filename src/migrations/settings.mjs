import { FALLOUT_MAW } from "../config/system-config.mjs";
import { ABILITIES_CATALOG_SETTING, MIGRATION_STATE_SETTING } from "../settings/constants.mjs";
import { getSkillSettings } from "../settings/accessors.mjs";
import {
  ABILITY_FIXED_FUNCTION_KEYS,
  createFullControlAbilityCatalogEntry,
  createTwoHandsAbilityCatalogEntry,
  normalizeAbilityCatalog
} from "../settings/abilities.mjs";

const SETTING_MIGRATIONS = Object.freeze([
  {
    id: "2026-06-19-add-two-hands-ability",
    migrate: migrateTwoHandsAbilityCatalog
  },
  {
    id: "2026-06-23-add-full-control-ability",
    migrate: migrateFullControlAbilityCatalog
  }
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

async function migrateTwoHandsAbilityCatalog() {
  const catalog = normalizeAbilityCatalog(
    game.settings.get(FALLOUT_MAW.id, ABILITIES_CATALOG_SETTING),
    getSkillSettings()
  );
  if (catalogHasFixedAbilityFunction(catalog, ABILITY_FIXED_FUNCTION_KEYS.twoHands)) return;

  const categories = foundry.utils.deepClone(catalog.categories ?? []);
  const features = categories.find(category => category.id === "features") ?? categories[0];
  if (!features) return;
  features.abilities = [createTwoHandsAbilityCatalogEntry(), ...(features.abilities ?? [])];

  await game.settings.set(FALLOUT_MAW.id, ABILITIES_CATALOG_SETTING, {
    ...catalog,
    categories
  });
}

async function migrateFullControlAbilityCatalog() {
  const catalog = normalizeAbilityCatalog(
    game.settings.get(FALLOUT_MAW.id, ABILITIES_CATALOG_SETTING),
    getSkillSettings()
  );
  if (catalogHasFixedAbilityFunction(catalog, ABILITY_FIXED_FUNCTION_KEYS.fullControl)) return;

  const categories = foundry.utils.deepClone(catalog.categories ?? []);
  const features = categories.find(category => category.id === "features") ?? categories[0];
  if (!features) return;
  features.abilities = [createFullControlAbilityCatalogEntry(), ...(features.abilities ?? [])];

  await game.settings.set(FALLOUT_MAW.id, ABILITIES_CATALOG_SETTING, {
    ...catalog,
    categories
  });
}

function catalogHasFixedAbilityFunction(catalog = {}, fixedKey = "") {
  return (catalog.categories ?? []).some(category => (category.abilities ?? []).some(ability => (
    ability?.system?.functions ?? []
  ).some(abilityFunction => abilityFunction?.fixedKey === fixedKey)));
}

function isPrimaryActiveGM() {
  const activeGMs = (game.users?.contents ?? [])
    .filter(user => user.active && user.isGM)
    .sort((left, right) => left.id.localeCompare(right.id));
  return activeGMs.at(0)?.id === game.user?.id;
}
