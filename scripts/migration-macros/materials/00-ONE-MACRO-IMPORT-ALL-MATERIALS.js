// Fallout-MaW material migration: one Foundry macro.
// Paste this whole script into a single Foundry script macro and run it once.
// The large importer files stay in the system folder and are loaded by this macro.

const SYSTEM_ID = "fallout-maw";
const BASE_PATH = "systems/fallout-maw/scripts/migration-macros/materials";
const MATERIAL_IMPORT_FILES = [
  "00-import-all-materials.js"
];

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

if (game.system.id !== SYSTEM_ID) {
  ui.notifications.error("This migration macro is only for the fallout-maw system.");
  return;
}

ui.notifications.info("Fallout-MaW material import started.");

for (const file of MATERIAL_IMPORT_FILES) {
  const url = `${BASE_PATH}/${file}`;
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`Could not load ${url}: HTTP ${response.status}`);
  const code = await response.text();
  await new AsyncFunction(code)();
}

ui.notifications.info("Fallout-MaW material import finished.");
