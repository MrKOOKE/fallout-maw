import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JB2A_MANUAL_OVERRIDES } from "./weapon-media-migration.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const systemRoot = path.resolve(__dirname, "..");
const mapPath = path.join(__dirname, "generated", "jb2a-animation-map.json");
const outputPath = path.join(systemRoot, "scripts", "migration-macros", "gear", "00-repair-weapon-media.js");

const map = {
  ...JB2A_MANUAL_OVERRIDES,
  ...JSON.parse(await fs.readFile(mapPath, "utf8"))
};

const buildStamp = new Date().toISOString();

const macro = `// Быстрая починка оружия: анимации, звуки, заполнение магазина.
// Не трогает крафты и не пересоздаёт предметы.
// Сгенерировано: ${buildStamp}

const SYSTEM_ID = "fallout-maw";
const FLAG_SCOPE = "fallout-maw";
const WEAPON_FLAG_KEY = "weaponMigration";

const JB2A_ANIMATION_MAP = ${JSON.stringify(map, null, 2)};

if (game.system.id !== SYSTEM_ID) {
  ui.notifications.error("Этот макрос рассчитан только на систему fallout-maw.");
  return;
}

let updated = 0;
let skipped = 0;
let errors = 0;

for (const item of game.items.contents) {
  if (item.type !== "gear") continue;
  const weaponFn = item.system?.functions?.weapon;
  const additionalWeapons = item.system?.functions?.additionalWeapons ?? {};
  const isMigratedWeapon = Boolean(item.getFlag(FLAG_SCOPE, WEAPON_FLAG_KEY));
  const hasWeaponData = Boolean(weaponFn?.enabled) || Object.keys(additionalWeapons).length > 0;
  if (!isMigratedWeapon && !hasWeaponData) continue;

  try {
    const updates = buildWeaponMediaUpdates(item.system?.functions ?? {});
    if (!Object.keys(updates).length) {
      skipped += 1;
      continue;
    }
    await item.update(updates);
    updated += 1;
  } catch (error) {
    errors += 1;
    console.error("weapon media repair failed", item.id, item.name, error);
  }
}

ui.notifications.info(
  \`Починка медиа оружия: обновлено \${updated}, без изменений \${skipped}, ошибок \${errors}.\`
);
console.log("weapon media repair", { updated, skipped, errors });

function buildWeaponMediaUpdates(functions = {}) {
  const updates = {};
  const weaponPatch = patchWeaponMediaData(functions.weapon ?? {});
  if (weaponPatch) updates["system.functions.weapon"] = { ...functions.weapon, ...weaponPatch };

  const additionalWeapons = functions.additionalWeapons ?? {};
  for (const [weaponId, weaponData] of Object.entries(additionalWeapons)) {
    const patch = patchWeaponMediaData(weaponData ?? {});
    if (!patch) continue;
    updates[\`system.functions.additionalWeapons.\${weaponId}\`] = { ...weaponData, ...patch };
  }
  return updates;
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
`;

await fs.writeFile(outputPath, macro, "utf8");
console.log(`repair macro: ${outputPath}`);
