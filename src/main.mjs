import { FALLOUT_MAW, syncSystemConfig } from "./config/system-config.mjs";
import { registerDataModels, registerTrackableAttributes } from "./data/index.mjs";
import { FalloutMaWActor, FalloutMaWItem } from "./documents/index.mjs";
import { registerSystemSettings, finalizeSystemSettings } from "./settings/index.mjs";
import { registerSystemSheets } from "./sheets/index.mjs";
import { FalloutMaWDragDrop } from "./utils/drag-drop.mjs";

Hooks.once("init", () => {
  console.log(`${FALLOUT_MAW.title} | Initializing system`);

  CONFIG.FalloutMaW = syncSystemConfig();
  CONFIG.Actor.documentClass = FalloutMaWActor;
  CONFIG.Item.documentClass = FalloutMaWItem;
  CONFIG.ux.DragDrop = FalloutMaWDragDrop;

  registerSystemSettings();
  registerSystemSheets();
  registerDataModels();
  registerTrackableAttributes();
});

Hooks.once("ready", async () => {
  await finalizeSystemSettings();
});
