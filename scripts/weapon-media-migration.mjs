import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_ID = "fallout-maw";
const MAP_PATH = path.join(__dirname, "generated", "jb2a-animation-map.json");

export const JB2A_MANUAL_OVERRIDES = {
  "jb2a.bolt.physical.white02": "fallout-maw.generic.weapon_attacks.ranged.bolt01_01_regular_white_physical",
  "jb2a.chain_lightning": "fallout-maw.6th_level.chain_lightning.chain_lightning_01_regular_blue_primary",
  "jb2a.explosion.01": "fallout-maw.3rd_level.fireball.fireball_explosion_01_blue",
  "jb2a.explosion.07.bluewhite": "fallout-maw.generic.explosion.explosion_07_blue_white",
  "jb2a.hammer.melee": "fallout-maw.generic.weapon_attacks.melee.hammer01_01_regular_white",
  "jb2a.hammer.throw": "fallout-maw.generic.weapon_attacks.ranged.hammer01_01_regular_white",
  "jb2a.handaxe.throw.01": "fallout-maw.generic.weapon_attacks.ranged.handaxe01_01_regular_white",
  "jb2a.impact.005.orange": "fallout-maw.generic.impact.impact_05_regular_orange",
  "jb2a.impact.010.orange": "fallout-maw.generic.impact.impact_05_regular_orange",
  "jb2a.lasershot.green": "fallout-maw.generic.weapon_attacks.ranged.laser_shot_01_regular_green"
};

let cachedMap = null;

export function loadJb2aAnimationMap() {
  if (cachedMap) return cachedMap;
  if (fs.existsSync(MAP_PATH)) {
    cachedMap = { ...JB2A_MANUAL_OVERRIDES, ...JSON.parse(fs.readFileSync(MAP_PATH, "utf8")) };
    return cachedMap;
  }
  cachedMap = { ...JB2A_MANUAL_OVERRIDES };
  return cachedMap;
}

export function migrateWeaponSoundPath(rawPath = "") {
  let pathValue = String(rawPath ?? "").trim();
  if (!pathValue || pathValue === "Путь") return "";

  pathValue = pathValue.replace(/Путь$/i, "");
  try {
    pathValue = decodeURIComponent(pathValue);
  } catch {
    // keep raw path
  }

  pathValue = pathValue
    .replace(/^systems\/fallout-maw\/icons\/Weapon_Sounds/i, "systems/fallout-maw/audio/Weapon_Sounds")
    .replace(/^systems\/fallout-maw\/icons\/WEAPON_SOUNDS/i, "systems/fallout-maw/audio/Weapon_Sounds");

  if (/^Weapon_Sounds\//i.test(pathValue)) {
    pathValue = `systems/fallout-maw/audio/${pathValue}`;
  }

  return pathValue;
}

export function migrateWeaponAnimationKey(rawKey, map = loadJb2aAnimationMap()) {
  const key = String(rawKey ?? "").trim();
  if (!key || key === "Путь") return "";
  if (key.startsWith(`${SYSTEM_ID}.`)) return key;
  if (key.startsWith("systems/")) return key;

  const lower = key.toLowerCase();
  return map[lower] ?? JB2A_MANUAL_OVERRIDES[lower] ?? "";
}

export function patchWeaponMediaData(weapon = {}, map = loadJb2aAnimationMap()) {
  if (!weapon || typeof weapon !== "object") return null;

  const updates = {};
  const nextAttackAnimation = migrateWeaponAnimationKey(weapon.attackAnimationKey, map);
  if (nextAttackAnimation && nextAttackAnimation !== weapon.attackAnimationKey) {
    updates.attackAnimationKey = nextAttackAnimation;
  }

  const nextAttackSound = migrateWeaponSoundPath(weapon.attackSoundPath);
  if (nextAttackSound !== String(weapon.attackSoundPath ?? "")) {
    updates.attackSoundPath = nextAttackSound;
  }

  const volley = weapon.volley ?? {};
  const volleyUpdates = {};
  const nextExplosionAnimation = migrateWeaponAnimationKey(volley.explosionAnimationKey, map);
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

export function applyWeaponMediaPatch(weapon = {}, map = loadJb2aAnimationMap()) {
  const patch = patchWeaponMediaData(weapon, map);
  return patch ? { ...weapon, ...patch } : weapon;
}
