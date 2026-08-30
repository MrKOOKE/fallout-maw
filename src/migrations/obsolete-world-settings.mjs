import { SYSTEM_ID } from "../constants.mjs";
import { ABILITIES_CATALOG_SETTING } from "../settings/constants.mjs";

const OBSOLETE_ANIMATION_LIBRARY_SETTING = `${SYSTEM_ID}.animationLibraryIndex`;
const REACTIVE_ABILITY_ID = "440oqDWdqC2Rha9Y";
const OBSOLETE_REACTIVE_EVOLUTION_IDS = new Set([
  "reactive-2ap-evolution",
  "ZE3wVZrKgRxUVkcw"
]);

/**
 * Remove the obsolete generated animation index from world Settings.
 *
 * The runtime has used the lazy generated/animation-database.mjs module since
 * the index stopped being registered. Foundry still vends unknown Setting
 * documents to every joining client, so retaining this legacy 13+ MB value
 * adds network transfer and JSON/Document initialization to every launch.
 */
export async function removeObsoleteWorldSettings() {
  if (!game.user?.isActiveGM) return { removed: 0 };
  const storage = game.settings?.storage?.get?.("world");
  const document = storage?.getSetting?.(OBSOLETE_ANIMATION_LIBRARY_SETTING, null);
  let removed = 0;
  if (document) {
    await document.delete({ render: false });
    console.info(`${SYSTEM_ID} | Removed obsolete world setting ${OBSOLETE_ANIMATION_LIBRARY_SETTING}.`);
    removed = 1;
  }

  const currentCatalog = game.settings.get?.(SYSTEM_ID, ABILITIES_CATALOG_SETTING);
  const migratedCatalog = removeObsoleteReactiveEvolutionExample(currentCatalog);
  if (migratedCatalog) {
    await game.settings.set(SYSTEM_ID, ABILITIES_CATALOG_SETTING, migratedCatalog);
    console.info(`${SYSTEM_ID} | Removed the obsolete Reactive evolution example.`);
  }
  return { removed };
}

/** Remove only the two known example nodes; later user-created copies have different IDs. */
export function removeObsoleteReactiveEvolutionExample(catalog = {}) {
  const reactive = findCatalogAbility(catalog, REACTIVE_ABILITY_ID);
  const removedIds = new Set((reactive?.system?.evolution?.nodes ?? [])
    .map(node => String(node?.id ?? node?.ability?.id ?? ""))
    .filter(id => OBSOLETE_REACTIVE_EVOLUTION_IDS.has(id)));
  if (!removedIds.size) return null;

  const migrated = structuredClone(catalog);
  const migratedReactive = findCatalogAbility(migrated, REACTIVE_ABILITY_ID);
  const evolution = migratedReactive.system.evolution;
  evolution.nodes = (evolution.nodes ?? []).filter(node => !removedIds.has(String(node?.id ?? node?.ability?.id ?? "")));
  evolution.links = (evolution.links ?? []).filter(link => (
    !removedIds.has(String(link?.fromId ?? "")) && !removedIds.has(String(link?.toId ?? ""))
  ));
  const fixedFunction = migratedReactive.system.functions
    ?.find(entry => entry?.fixedKey === "reactive");
  if (fixedFunction) {
    fixedFunction.enabled = true;
    fixedFunction.fixedSettings.actionPointsPerThreshold = 1;
  }
  if (!evolution.nodes.length) {
    evolution.layoutDirection = "top-down";
    evolution.viewport = { x: 0, y: 0, zoom: 1 };
  }
  return migrated;
}

function findCatalogAbility(catalog, abilityId) {
  for (const category of catalog?.categories ?? []) {
    const ability = (category?.abilities ?? []).find(entry => entry?.id === abilityId);
    if (ability) return ability;
  }
  return null;
}

export const SETTINGS_MIGRATION_TESTING = Object.freeze({
  OBSOLETE_ANIMATION_LIBRARY_SETTING
});
