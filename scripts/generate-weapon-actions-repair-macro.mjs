import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractDescription,
  getFolderPath,
  readLevelDocuments
} from "./generate-material-migration.mjs";
import {
  buildRangedConditionLossByRarity,
  buildWeaponActionPatch,
  parseGearDescription,
  stripGearHtml
} from "./gear-description-parser.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const systemRoot = path.resolve(__dirname, "..");
const dataRoot = path.resolve(systemRoot, "..", "..");
const OLD_WORLD_ROOT = path.join(dataRoot, "fallout-old");
const outputPath = path.join(systemRoot, "scripts", "migration-macros", "gear", "00-repair-weapon-actions.js");

const [items, folders] = await Promise.all([
  readLevelDocuments(path.join(OLD_WORLD_ROOT, "data", "items")),
  readLevelDocuments(path.join(OLD_WORLD_ROOT, "data", "folders"))
]);
const folderById = new Map(folders.map(folder => [folder._id, folder]));

const rarityConditionLossByRarity = buildRangedConditionLossByRarity(
  items
    .filter(item => {
      const folderPath = getFolderPath(item.folder, folderById);
      return folderPath === "Оружие" || folderPath.startsWith("Оружие /");
    })
    .map(item => stripGearHtml(extractDescription(item)).replace(/\s+/g, " "))
);

const ammoByCaliber = new Map();
for (const item of items) {
  const folderPath = getFolderPath(item.folder, folderById);
  if (folderPath !== "Боеприпасы" && !folderPath.startsWith("Боеприпасы /")) continue;
  const parsed = parseGearDescription(extractDescription(item));
  const caliberKey = parsed?.caliberKey;
  if (!caliberKey) continue;
  if (!ammoByCaliber.has(caliberKey)) ammoByCaliber.set(caliberKey, []);
  ammoByCaliber.get(caliberKey).push(item._id);
}

const patches = {};
const patchesByName = {};

for (const item of items) {
  const folderPath = getFolderPath(item.folder, folderById);
  if (folderPath !== "Оружие" && !folderPath.startsWith("Оружие /")) continue;

  const description = extractDescription(item);
  const parsedGear = parseGearDescription(description);
  const magazineSourceOldIds = parsedGear?.caliberKey
    ? (ammoByCaliber.get(parsedGear.caliberKey) ?? [])
    : [];

  const patch = buildWeaponActionPatch(description, item.name, { magazineSourceOldIds, rarityConditionLossByRarity });
  patches[item._id] = patch;

  const prev = patchesByName[item.name];
  const prevScore = scoreWeaponPatch(prev);
  const nextScore = scoreWeaponPatch(patch);
  if (!prev || nextScore >= prevScore) {
    patchesByName[item.name] = { oldId: item._id, patch };
  }
}

function scoreWeaponPatch(entry) {
  if (!entry?.patch) return -1;
  const additional = entry.patch.additionalWeapons?.length ?? 0;
  const hasThrow = entry.patch.additionalWeapons?.some(weapon => weapon.skillKey === "throwing") ? 10 : 0;
  return additional + hasThrow;
}

const patchCount = Object.keys(patches).length;
const buildStamp = new Date().toISOString();

const macro = `// Быстрая починка оружия: задержка атаки, доступные действия, режимы (ближний/метание).
// Не трогает крафты и не пересоздаёт предметы.
// Сгенерировано: ${buildStamp}
// Патчей: ${patchCount}

const SYSTEM_ID = "fallout-maw";
const FLAG_SCOPE = "fallout-maw";
const WEAPON_FLAG_KEY = "weaponMigration";

const WEAPON_ACTION_PATCHES = ${JSON.stringify(patches)};
const WEAPON_PATCHES_BY_NAME = ${JSON.stringify(patchesByName)};

if (game.system.id !== SYSTEM_ID) {
  ui.notifications.error("Этот макрос рассчитан только на систему fallout-maw.");
  return;
}

let updated = 0;
let skipped = 0;
let errors = 0;
let removedStale = 0;

function hasWeaponFunctions(item) {
  const functions = item.system?.functions ?? {};
  return Boolean(functions.weapon?.enabled) || Object.keys(functions.additionalWeapons ?? {}).length > 0;
}

function resolveWeaponPatch(item) {
  const migration = item.getFlag(FLAG_SCOPE, WEAPON_FLAG_KEY);
  const oldId = String(migration?.oldId ?? "").trim();
  if (oldId && WEAPON_ACTION_PATCHES[oldId]) return WEAPON_ACTION_PATCHES[oldId];
  const byName = WEAPON_PATCHES_BY_NAME[String(item.name ?? "").trim()];
  return byName?.patch ?? null;
}

async function tryRepairItem(item) {
  if (item.type !== "gear" || !hasWeaponFunctions(item)) return;
  const patch = resolveWeaponPatch(item);
  if (!patch) {
    skipped += 1;
    return;
  }

  try {
    const functions = item.system?.functions ?? {};
    const updates = buildWeaponActionUpdates(functions, patch);
    if (!Object.keys(updates).length) {
      skipped += 1;
      return;
    }
    removedStale += countStaleRemovals(functions.additionalWeapons ?? {}, updates);
    await item.update(updates);
    updated += 1;
  } catch (error) {
    errors += 1;
    console.error("weapon actions repair failed", item.id, item.name, error);
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
  \`Починка действий оружия: обновлено \${updated}, без изменений \${skipped}, удалено лишних функций \${removedStale}, ошибок \${errors}.\`
);
console.log("weapon actions repair", { updated, skipped, removedStale, errors });

function buildWeaponActionUpdates(functions = {}, patch = {}) {
  const updates = {};
  const currentAdditional = functions.additionalWeapons ?? {};

  if (patch.weapon) {
    const nextWeapon = mergeWeaponPatch(functions.weapon ?? {}, patch.weapon);
    if (nextWeapon) updates["system.functions.weapon"] = nextWeapon;
  }

  if (!Array.isArray(patch.additionalWeapons)) return updates;

  const nextAdditional = buildAdditionalWeaponsObject(currentAdditional, patch.additionalWeapons);
  updates["system.functions.additionalWeapons"] = nextAdditional;

  // Foundry мержит объекты: без -= старые «Древковое» и прочий мусор остаются.
  for (const staleId of Object.keys(currentAdditional)) {
    if (!nextAdditional[staleId]) {
      updates[\`system.functions.additionalWeapons.-=\${staleId}\`] = null;
    }
  }

  return updates;
}

function countStaleRemovals(currentAdditional = {}, updates = {}) {
  let count = 0;
  for (const key of Object.keys(updates)) {
    if (key.startsWith("system.functions.additionalWeapons.-=")) count += 1;
  }
  return count;
}

function mergeWeaponPatch(current = {}, patch = {}) {
  const next = stripButtStrike({ ...current, ...patch });
  return shallowChanged(current, next) ? next : null;
}

function buildAdditionalWeaponsObject(current = {}, patchList = []) {
  const result = {};
  const existingEntries = Object.entries(current);

  for (const patch of patchList) {
    const patchName = normalizeName(patch.name);
    const match = existingEntries.find(([id, weapon]) => normalizeName(weapon?.name) === patchName);
    const weaponId = match?.[0] ?? foundry.utils.randomID(16);
    result[weaponId] = stripButtStrike({ ...(match?.[1] ?? {}), ...patch, id: weaponId, enabled: true });
  }

  return result;
}

function stripButtStrike(weapon = {}) {
  const next = { ...weapon };
  const meleeName = String(next.meleeAttack?.name ?? "").trim();
  if (!/^удар\\s+прикладом/i.test(meleeName)) return next;
  next.availableActions = { ...(next.availableActions ?? {}), meleeAttack: false };
  next.meleeAttack = { ...(next.meleeAttack ?? {}), actionPointCost: 0, name: "" };
  return next;
}

function normalizeName(value = "") {
  return String(value ?? "").trim().toLocaleLowerCase("ru-RU");
}

function shallowChanged(left = {}, right = {}) {
  return JSON.stringify(left) !== JSON.stringify(right);
}
`;

await fs.writeFile(outputPath, macro, "utf8");
console.log(`repair macro: ${outputPath} (${patchCount} patches)`);
