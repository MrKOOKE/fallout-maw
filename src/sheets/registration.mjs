import { FALLOUT_MAW } from "../config/system-config.mjs";
import { FalloutMaWActiveEffectSheet } from "./active-effect-sheet.mjs";
import { FalloutMaWActorSheet } from "./actor-sheet.mjs";
import { FalloutMaWItemSheet, registerItemSheetSourceSyncHooks } from "./item-sheet.mjs";
import { PeriodicDamageRegionBehaviorConfig } from "./periodic-damage-region-behavior-config.mjs";
import { AmbientLightConfig } from "../canvas/light-networks.mjs";

export function registerSystemSheets() {
  const sheetConfig = foundry.applications.apps.DocumentSheetConfig;
  registerItemSheetSourceSyncHooks();

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

  sheetConfig.registerSheet(ActiveEffect, FALLOUT_MAW.id, FalloutMaWActiveEffectSheet, {
    label: "Fallout-MaW V2",
    makeDefault: true
  });

  sheetConfig.registerSheet(CONFIG.AmbientLight.documentClass, "core", AmbientLightConfig, {
    label: "Fallout-MaW V2",
    makeDefault: true
  });

  sheetConfig.registerSheet(RegionBehavior, FALLOUT_MAW.id, PeriodicDamageRegionBehaviorConfig, {
    label: "Fallout-MaW V2",
    types: ["fallout-maw.periodicDamage"],
    makeDefault: true
  });
}
