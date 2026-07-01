import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractDescription,
  getFolderPath,
  readLevelDocuments
} from "./generate-material-migration.mjs";
import { parseWeaponMigration } from "./gear-description-parser.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const systemRoot = path.resolve(__dirname, "..");
const dataRoot = path.resolve(systemRoot, "..", "..");
const OLD_WORLD_ROOT = path.join(dataRoot, "fallout-old");
const outputPath = path.join(systemRoot, "scripts", "migration-macros", "gear", "00-repair-weapon-modules.js");

const [items, folders] = await Promise.all([
  readLevelDocuments(path.join(OLD_WORLD_ROOT, "data", "items")),
  readLevelDocuments(path.join(OLD_WORLD_ROOT, "data", "folders"))
]);
const folderById = new Map(folders.map(folder => [folder._id, folder]));

const patches = {};
const patchesByName = {};

for (const item of items) {
  const folderPath = getFolderPath(item.folder, folderById);
  if (folderPath !== "Оружие" && !folderPath.startsWith("Оружие /")) continue;

  const description = extractDescription(item);
  if (!/ДОП\.?\s*РАЗДЕЛ\s*МОДУЛЯ|module-additional-section/i.test(description)) continue;

  const parsed = parseWeaponMigration(description, item.name);
  const patch = {
    moduleSlots: parsed.primary?.moduleSlots ?? [],
    additionalWeapons: Object.fromEntries(
      (parsed.additionalWeapons ?? []).map(entry => [entry.id, entry])
    )
  };
  patches[item._id] = patch;
  patchesByName[item.name] = { oldId: item._id, patch };
}

const patchCount = Object.keys(patches).length;
const buildStamp = new Date().toISOString();

const macro = `// Починка встроенных модулей оружия: moduleSlots + очистка ошибочных additionalWeapons.
// Сгенерировано: ${buildStamp}
// Патчей: ${patchCount}

const SYSTEM_ID = "fallout-maw";
const FLAG_SCOPE = "fallout-maw";
const WEAPON_FLAG_KEY = "weaponMigration";

const WEAPON_MODULE_PATCHES = ${JSON.stringify(patches)};
const WEAPON_MODULE_PATCHES_BY_NAME = ${JSON.stringify(patchesByName)};

if (game.system.id !== SYSTEM_ID) {
  ui.notifications.error("Этот макрос рассчитан только на систему fallout-maw.");
  return;
}

let updated = 0;
let skipped = 0;
let errors = 0;

function hasWeaponFunctions(item) {
  const functions = item.system?.functions ?? {};
  return Boolean(functions.weapon?.enabled) || Object.keys(functions.additionalWeapons ?? {}).length > 0;
}

function resolvePatch(item) {
  const migration = item.getFlag(FLAG_SCOPE, WEAPON_FLAG_KEY);
  const oldId = String(migration?.oldId ?? "").trim();
  if (oldId && WEAPON_MODULE_PATCHES[oldId]) return WEAPON_MODULE_PATCHES[oldId];
  return WEAPON_MODULE_PATCHES_BY_NAME[String(item.name ?? "").trim()]?.patch ?? null;
}

async function tryRepairItem(item) {
  if (item.type !== "gear" || !hasWeaponFunctions(item)) return;
  const patch = resolvePatch(item);
  if (!patch) {
    skipped += 1;
    return;
  }

  try {
    const functions = item.system?.functions ?? {};
    const updates = buildModuleUpdates(functions, patch);
    if (!Object.keys(updates).length) {
      skipped += 1;
      return;
    }
    await item.update(updates);
    updated += 1;
  } catch (error) {
    errors += 1;
    console.error("weapon module repair failed", item.id, item.name, error);
  }
}

for (const item of game.items.contents) {
  await tryRepairItem(item);
}

for (const actor of game.actors.contents) {
  for (const item of actor.items.contents) {
    await tryRepairItem(item);
  }
}

ui.notifications.info(
  \`Починка модулей оружия: обновлено \${updated}, без изменений \${skipped}, ошибок \${errors}.\`
);
console.log("weapon module repair", { updated, skipped, errors });

function buildModuleUpdates(functions = {}, patch = {}) {
  const updates = {};
  const currentWeapon = functions.weapon ?? {};
  const nextSlots = Array.isArray(patch.moduleSlots) ? patch.moduleSlots : [];
  if (JSON.stringify(currentWeapon.moduleSlots ?? []) !== JSON.stringify(nextSlots)) {
    updates["system.functions.weapon"] = { ...currentWeapon, moduleSlots: nextSlots };
  }

  const currentAdditional = functions.additionalWeapons ?? {};
  const nextAdditional = { ...(patch.additionalWeapons ?? {}) };
  if (JSON.stringify(currentAdditional) !== JSON.stringify(nextAdditional)) {
    updates["system.functions.additionalWeapons"] = nextAdditional;
    for (const staleId of Object.keys(currentAdditional)) {
      if (!nextAdditional[staleId]) {
        updates[\`system.functions.additionalWeapons.-=\${staleId}\`] = null;
      }
    }
  }

  return updates;
}
`;

await fs.writeFile(outputPath, macro, "utf8");
console.log(`repair macro: ${outputPath} (${patchCount} patches)`);
