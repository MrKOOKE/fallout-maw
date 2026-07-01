// Fallout-MaW модулей migration: one Foundry macro.
// Вставьте весь этот скрипт в один макрос Foundry (Script) и запустите от GM.

const SYSTEM_ID = "fallout-maw";
const BASE_PATH = "systems/fallout-maw/scripts/migration-macros/modules";
const IMPORT_FILE = "01-import-module-items.js";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

if (game.system.id !== SYSTEM_ID) {
  ui.notifications.error("Этот макрос рассчитан только на систему fallout-maw.");
  return;
}

ui.notifications.info("Импорт модулей: старт…");

const url = `${BASE_PATH}/${IMPORT_FILE}`;
const response = await fetch(url, { cache: "no-cache" });
if (!response.ok) throw new Error(`Не удалось загрузить ${url}: HTTP ${response.status}`);
const code = await response.text();
await new AsyncFunction(code)();

ui.notifications.info("Импорт модулей: завершён.");
