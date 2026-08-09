import { SYSTEM_ID } from "../constants.mjs";

const OBSOLETE_ANIMATION_LIBRARY_SETTING = `${SYSTEM_ID}.animationLibraryIndex`;

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
  if (!document) return { removed: 0 };

  await document.delete({ render: false });
  console.info(`${SYSTEM_ID} | Removed obsolete world setting ${OBSOLETE_ANIMATION_LIBRARY_SETTING}.`);
  return { removed: 1 };
}

export const SETTINGS_MIGRATION_TESTING = Object.freeze({
  OBSOLETE_ANIMATION_LIBRARY_SETTING
});
