import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractDescription,
  getFolderPath,
  readLevelDocuments
} from "./generate-material-migration.mjs";
import { buildWeaponMediaPatch } from "./gear-description-parser.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const systemRoot = path.resolve(__dirname, "..");
const dataRoot = path.resolve(systemRoot, "..", "..");
const OLD_WORLD_ROOT = path.join(dataRoot, "fallout-old");
const mapPath = path.join(__dirname, "generated", "jb2a-animation-map.json");
const outputPath = path.join(systemRoot, "scripts", "migration-macros", "gear", "00-repair-weapon-media.js");

const map = JSON.parse(await fs.readFile(mapPath, "utf8"));

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

  const patch = buildWeaponMediaPatch(extractDescription(item), item.name);
  patches[item._id] = patch;

  const prev = patchesByName[item.name];
  if (!prev) {
    patchesByName[item.name] = { oldId: item._id, patch };
  }
}

const patchCount = Object.keys(patches).length;
const buildStamp = new Date().toISOString();

const macro = `// Быстрая починка оружия: анимации, звуки, заполнение магазина.
// Берёт jb2a-пути из старого мира (по oldId) и ставит ключи Library-animation 1:1.
// Сгенерировано: ${buildStamp}
// Патчей: ${patchCount}

const SYSTEM_ID = "fallout-maw";
const FLAG_SCOPE = "fallout-maw";
const WEAPON_FLAG_KEY = "weaponMigration";

const JB2A_ANIMATION_MAP = ${JSON.stringify(map, null, 2)};
const WEAPON_MEDIA_PATCHES = ${JSON.stringify(patches)};
const WEAPON_MEDIA_PATCHES_BY_NAME = ${JSON.stringify(patchesByName)};

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

function resolveMediaPatch(item) {
  const migration = item.getFlag(FLAG_SCOPE, WEAPON_FLAG_KEY);
  const oldId = String(migration?.oldId ?? "").trim();
  if (oldId && WEAPON_MEDIA_PATCHES[oldId]) return WEAPON_MEDIA_PATCHES[oldId];
  const byName = WEAPON_MEDIA_PATCHES_BY_NAME[String(item.name ?? "").trim()];
  return byName?.patch ?? null;
}

async function tryRepairItem(item) {
  if (item.type !== "gear" || !hasWeaponFunctions(item)) return;

  try {
    const patch = resolveMediaPatch(item);
    const updates = buildWeaponMediaUpdates(item.system?.functions ?? {}, patch);
    if (!Object.keys(updates).length) {
      skipped += 1;
      return;
    }
    await item.update(updates);
    updated += 1;
  } catch (error) {
    errors += 1;
    console.error("weapon media repair failed", item.id, item.name, error);
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
  \`Починка медиа оружия: обновлено \${updated}, без изменений \${skipped}, ошибок \${errors}.\`
);
console.log("weapon media repair", { updated, skipped, errors });

function buildWeaponMediaUpdates(functions = {}, patch = null) {
  const updates = {};
  const weaponPatch = patch?.weapon
    ? mergeWeaponMediaPatch(functions.weapon ?? {}, patch.weapon)
    : patchWeaponMediaData(functions.weapon ?? {});
  if (weaponPatch) updates["system.functions.weapon"] = { ...functions.weapon, ...weaponPatch };

  const additionalWeapons = functions.additionalWeapons ?? {};
  const patchList = Array.isArray(patch?.additionalWeapons) ? patch.additionalWeapons : [];

  if (patchList.length) {
    for (const weaponPatchEntry of patchList) {
      const patchName = normalizeName(weaponPatchEntry.name);
      const match = Object.entries(additionalWeapons).find(([, weapon]) => normalizeName(weapon?.name) === patchName);
      if (!match) continue;
      const [weaponId, weaponData] = match;
      const merged = mergeWeaponMediaPatch(weaponData ?? {}, weaponPatchEntry);
      if (merged) updates[\`system.functions.additionalWeapons.\${weaponId}\`] = { ...weaponData, ...merged };
    }
  } else {
    for (const [weaponId, weaponData] of Object.entries(additionalWeapons)) {
      const merged = patchWeaponMediaData(weaponData ?? {});
      if (!merged) continue;
      updates[\`system.functions.additionalWeapons.\${weaponId}\`] = { ...weaponData, ...merged };
    }
  }

  return updates;
}

function mergeWeaponMediaPatch(current = {}, patch = {}) {
  const next = { ...current };
  let changed = false;

  if (patch.attackAnimationKey && patch.attackAnimationKey !== current.attackAnimationKey) {
    next.attackAnimationKey = patch.attackAnimationKey;
    changed = true;
  }
  if (patch.attackSoundPath !== undefined && patch.attackSoundPath !== current.attackSoundPath) {
    next.attackSoundPath = patch.attackSoundPath;
    changed = true;
  }
  if (patch.volley) {
    const volley = { ...(current.volley ?? {}) };
    let volleyChanged = false;
    if (patch.volley.explosionAnimationKey && patch.volley.explosionAnimationKey !== volley.explosionAnimationKey) {
      volley.explosionAnimationKey = patch.volley.explosionAnimationKey;
      volleyChanged = true;
    }
    if (patch.volley.explosionSoundPath !== undefined && patch.volley.explosionSoundPath !== volley.explosionSoundPath) {
      volley.explosionSoundPath = patch.volley.explosionSoundPath;
      volleyChanged = true;
    }
    if (volleyChanged) {
      next.volley = volley;
      changed = true;
    }
  }
  if (patch.magazine?.value != null) {
    const magazineMax = Math.max(0, Number(current.magazine?.max) || 0);
    if (magazineMax > 0 && Number(current.magazine?.value) !== patch.magazine.value) {
      next.magazine = { ...(current.magazine ?? {}), value: patch.magazine.value };
      changed = true;
    }
  }

  return changed ? next : null;
}

function migrateWeaponSoundPath(rawPath = "") {
  let pathValue = String(rawPath ?? "").trim();
  if (!pathValue || pathValue === "Путь") return "";

  pathValue = pathValue.replace(/Путь$/i, "");
  try {
    pathValue = decodeURIComponent(pathValue);
  } catch (_error) {
    // keep raw path
  }

  pathValue = pathValue
    .replace(/^systems\\/fallout-maw\\/icons\\/Weapon_Sounds/i, "systems/fallout-maw/audio/Weapon_Sounds")
    .replace(/^systems\\/fallout-maw\\/icons\\/WEAPON_SOUNDS/i, "systems/fallout-maw/audio/Weapon_Sounds");

  if (/^Weapon_Sounds\\//i.test(pathValue)) {
    pathValue = \`systems/fallout-maw/audio/\${pathValue}\`;
  }

  return pathValue;
}

function migrateWeaponAnimationKey(rawKey = "") {
  const key = String(rawKey ?? "").trim();
  if (!key || key === "Путь") return "";
  if (key.startsWith("fallout-maw.")) return key;
  if (key.startsWith("systems/")) return key;
  return JB2A_ANIMATION_MAP[key.toLowerCase()] ?? "";
}

function patchWeaponMediaData(weapon = {}) {
  if (!weapon || typeof weapon !== "object") return null;

  const updates = {};
  const nextAttackAnimation = migrateWeaponAnimationKey(weapon.attackAnimationKey);
  if (nextAttackAnimation && nextAttackAnimation !== weapon.attackAnimationKey) {
    updates.attackAnimationKey = nextAttackAnimation;
  }

  const nextAttackSound = migrateWeaponSoundPath(weapon.attackSoundPath);
  if (nextAttackSound !== String(weapon.attackSoundPath ?? "")) {
    updates.attackSoundPath = nextAttackSound;
  }

  const volley = weapon.volley ?? {};
  const volleyUpdates = {};
  const nextExplosionAnimation = migrateWeaponAnimationKey(volley.explosionAnimationKey);
  if (nextExplosionAnimation && nextExplosionAnimation !== volley.explosionAnimationKey) {
    volleyUpdates.explosionAnimationKey = nextExplosionAnimation;
  }
  const nextExplosionSound = migrateWeaponSoundPath(volley.explosionSoundPath);
  if (nextExplosionSound !== String(volley.explosionSoundPath ?? "")) {
    volleyUpdates.explosionSoundPath = nextExplosionSound;
  }
  if (Object.keys(volleyUpdates).length) {
    updates.volley = { ...volley, ...volleyUpdates };
  }

  const magazineMax = Math.max(0, Number(weapon.magazine?.max) || 0);
  if (magazineMax > 0 && Number(weapon.magazine?.value) !== magazineMax) {
    updates.magazine = { ...(weapon.magazine ?? {}), value: magazineMax };
  }

  return Object.keys(updates).length ? updates : null;
}

function normalizeName(value = "") {
  return String(value ?? "").trim().toLocaleLowerCase("ru-RU");
}
`;

await fs.writeFile(outputPath, macro, "utf8");
console.log(`repair macro: ${outputPath} (${patchCount} patches)`);
