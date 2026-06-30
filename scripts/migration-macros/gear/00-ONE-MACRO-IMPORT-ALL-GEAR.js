// Fallout-MaW gear migration: ammo → weapons → equipment
// Вставьте весь этот скрипт в один макрос Foundry (Script) и запустите от GM.

const SYSTEM_ID = "fallout-maw";
const BASE_PATH = "systems/fallout-maw/scripts/migration-macros";
const STEPS = [
  {
    "dir": "ammo",
    "file": "01-import-ammo-items.js",
    "label": "боеприпасы"
  },
  {
    "dir": "weapons",
    "file": "01-import-weapon-items.js",
    "label": "оружие"
  },
  {
    "dir": "equipment",
    "file": "01-import-equipment-items.js",
    "label": "снаряжение"
  }
];

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

if (game.system.id !== SYSTEM_ID) {
  ui.notifications.error("Этот макрос рассчитан только на систему fallout-maw.");
  return;
}

for (const step of STEPS) {
  ui.notifications.info(`Импорт ${step.label}: старт…`);
  const url = `${BASE_PATH}/${step.dir}/${step.file}`;
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`Не удалось загрузить ${url}: HTTP ${response.status}`);
  const code = await response.text();
  await new AsyncFunction(code)();
  ui.notifications.info(`Импорт ${step.label}: завершён.`);
}
