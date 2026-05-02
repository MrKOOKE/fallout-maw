import { FALLOUT_MAW } from "../config/system-config.mjs";
import { FalloutMaWActorSheet } from "./actor-sheet.mjs";
import { FalloutMaWItemSheet } from "./item-sheet.mjs";

export function registerSystemSheets() {
  const sheetConfig = foundry.applications.apps.DocumentSheetConfig;

  sheetConfig.registerSheet(Actor, FALLOUT_MAW.id, FalloutMaWActorSheet, {
    label: "Fallout-MaW V2",
    types: FALLOUT_MAW.actorTypes,
    makeDefault: true
  });

  sheetConfig.registerSheet(Item, FALLOUT_MAW.id, FalloutMaWItemSheet, {
    label: "Fallout-MaW V2",
    types: FALLOUT_MAW.itemTypes,
    makeDefault: true
  });
}
