import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { jb2aKeyToMawKey, loadJb2aDatabase } from "./jb2a-key-resolver.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_ID = "fallout-maw";
const MAP_PATH = path.join(__dirname, "generated", "jb2a-animation-map.json");

let cachedMap = null;
let cachedDatabase = null;

export async function ensureJb2aAnimationMap() {
  if (cachedMap) return cachedMap;
  if (fs.existsSync(MAP_PATH)) {
    cachedMap = JSON.parse(fs.readFileSync(MAP_PATH, "utf8"));
    return cachedMap;
  }
  cachedDatabase ??= await loadJb2aDatabase();
  cachedMap = {};
  return cachedMap;
}

export function loadJb2aAnimationMap() {
  if (cachedMap) return cachedMap;
  if (fs.existsSync(MAP_PATH)) {
    cachedMap = JSON.parse(fs.readFileSync(MAP_PATH, "utf8"));
    return cachedMap;
  }
  cachedMap = {};
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

export function migrateWeaponAnimationKey(rawKey, map = loadJb2aAnimationMap(), database = cachedDatabase) {
  const key = String(rawKey ?? "").trim();
  if (!key || key === "Путь") return "";
  if (key.startsWith(`${SYSTEM_ID}.`)) return key;
  if (key.startsWith("systems/")) return key;

  const lower = key.toLowerCase();
  if (map[lower]) return map[lower];

  if (lower.startsWith("jb2a.")) {
    const resolved = jb2aKeyToMawKey(lower, database);
    if (resolved) return resolved;
  }

  return "";
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
