// Post-migration repair for imported Fallout-MaW gear.
// Paste into a Foundry Script macro and run as GM in a fallout-maw world.
//
// Repairs:
// - system.placement.width / height for imported equipment and weapons.
// - craft graph node sizes to match real item sizes and keep a 2-cell vertical pipe gap.

const SYSTEM_ID = "fallout-maw";
const FLAG_SCOPE = "fallout-maw";
const MIGRATION_FLAG_KEYS = [
  "materialMigration",
  "junkMigration",
  "firstAidMigration",
  "bookMigration",
  "foodMigration",
  "toolMigration",
  "ammoMigration",
  "weaponMigration",
  "moduleMigration",
  "equipmentMigration",
  "constructPartMigration"
];

const DRY_RUN = false;

if (game.system.id !== SYSTEM_ID) {
  ui.notifications.error("Этот макрос рассчитан на систему fallout-maw.");
} else if (!game.user.isGM) {
  ui.notifications.error("Макрос должен запускать GM.");
} else {
  await repairImportedInventorySizesAndCraftPipes();
}

async function repairImportedInventorySizesAndCraftPipes() {
  const updates = [];
  const stats = {
    scanned: 0,
    sizeUpdates: 0,
    craftUpdates: 0,
    equipment: 0,
    weapons: 0,
    skipped: 0
  };

  for (const item of game.items) {
    if (item.type !== "gear") continue;
    const migration = getMigrationData(item);
    if (!migration) continue;

    stats.scanned += 1;
    const update = { _id: item.id };
    let changed = false;

    const size = resolveInventorySize(item, migration);
    if (size) {
      const currentWidth = toInteger(item.system?.placement?.width, 1);
      const currentHeight = toInteger(item.system?.placement?.height, 1);
      if (currentWidth !== size.width || currentHeight !== size.height) {
        update["system.placement.width"] = size.width;
        update["system.placement.height"] = size.height;
        stats.sizeUpdates += 1;
        stats[size.kind] += 1;
        changed = true;
      }
    } else {
      stats.skipped += 1;
    }

    const normalizedCraft = normalizeCraftPipes(item.system?.craft, item);
    if (normalizedCraft.changed) {
      update["system.craft"] = normalizedCraft.craft;
      stats.craftUpdates += 1;
      changed = true;
    }

    if (changed) updates.push(update);
  }

  if (!DRY_RUN && updates.length) {
    for (let index = 0; index < updates.length; index += 50) {
      const chunk = updates.slice(index, index + 50);
      await Item.implementation.updateDocuments(chunk);
      ui.notifications.info(`Размеры/крафт: обновлено ${Math.min(index + chunk.length, updates.length)}/${updates.length}`);
    }
  }

  console.log("fallout-maw inventory size and craft pipe repair", { dryRun: DRY_RUN, stats, updates });
  ui.notifications.info(`Размеры/крафт: предметов к обновлению ${updates.length}. Размеры: ${stats.sizeUpdates}, крафты: ${stats.craftUpdates}.`);
}

function getMigrationData(item) {
  for (const key of MIGRATION_FLAG_KEYS) {
    const data = item.getFlag(FLAG_SCOPE, key);
    if (data?.oldId || data?.oldFolderPath) return { key, ...data };
  }
  return null;
}

function resolveInventorySize(item, migration) {
  const oldFolderPath = String(migration?.oldFolderPath ?? "");
  const root = normalizeRu(oldFolderPath.split(" / ")[0] ?? "");
  if (root === "снаряжение") return resolveEquipmentSize(item, oldFolderPath);
  if (root === "оружие") return resolveWeaponSize(item, oldFolderPath);
  return null;
}

function resolveEquipmentSize(item, oldFolderPath) {
  const path = normalizeRu(oldFolderPath);
  const subcategory = normalizeRu(String(oldFolderPath).split(" / ").at(-1) ?? "");

  if (subcategory.includes("силов") && subcategory.includes("шлем")) return size(3, 3, "equipment");
  if (subcategory.includes("голов") || subcategory.includes("шлем")) return size(2, 2, "equipment");
  if (subcategory.includes("очки")) return size(1, 1, "equipment");
  if (subcategory.includes("маск")) return hasOccupiedEquipmentSlot(item, "Очки")
    ? size(2, 2, "equipment")
    : size(1, 1, "equipment");

  if (path.includes("силовая броня")) return size(7, 7, "equipment");
  if (path.includes("тяжелая броня")) return size(5, 5, "equipment");
  if (path.includes("средняя броня")) return size(4, 4, "equipment");
  if (path.includes("легкая броня") || subcategory === "одежда") return size(3, 3, "equipment");

  return null;
}

function resolveWeaponSize(item, oldFolderPath) {
  const name = normalizeRu(item.name);
  const path = normalizeRu(oldFolderPath);
  const proficiency = String(item.system?.functions?.weapon?.proficiencyKey ?? "");

  if (path.includes("метательное") && /гранат|шашк|молотов|динамит/.test(name)) return size(1, 1, "weapons");

  if (proficiency === "pistol") return size(2, 1, "weapons");
  if (["automatic", "rifle", "shotgun", "grenadeLauncher"].includes(proficiency)) return size(4, 2, "weapons");
  if (["machineGun", "flamethrower"].includes(proficiency)) return size(6, 3, "weapons");
  if (proficiency.startsWith("oneHanded")) return size(2, 1, "weapons");
  if (proficiency.startsWith("twoHanded")) return size(4, 2, "weapons");

  return null;
}

function size(width, height, kind) {
  return { width, height, kind };
}

function normalizeCraftPipes(craft, ownerItem) {
  if (!craft || typeof craft !== "object") return { craft, changed: false };
  const next = foundry.utils.deepClone(craft);
  let changed = false;

  changed = normalizeCraftLayout(next, ownerItem) || changed;
  changed = normalizeCraftLayout(next.disassembly, ownerItem) || changed;

  if (Array.isArray(next.recipes)) {
    for (const recipe of next.recipes) {
      changed = normalizeCraftLayout(recipe, ownerItem) || changed;
      changed = normalizeCraftLayout(recipe.disassembly, ownerItem) || changed;
    }
  }

  return { craft: next, changed };
}

function normalizeCraftLayout(layout, ownerItem) {
  if (!layout || typeof layout !== "object") return false;
  let changed = false;

  if (Array.isArray(layout.nodes)) {
    for (const node of layout.nodes) {
      const size = resolveCraftNodeSize(node, ownerItem);
      if (!size) continue;
      if (toInteger(node.width, 1) !== size.width) {
        node.width = size.width;
        changed = true;
      }
      if (toInteger(node.height, 1) !== size.height) {
        node.height = size.height;
        changed = true;
      }
      const snappedX = snapCraftGridCoordinate(node.x, size.width);
      const snappedY = snapCraftGridCoordinate(node.y, size.height);
      if (Number(node.x) !== snappedX) {
        node.x = snappedX;
        changed = true;
      }
      if (Number(node.y) !== snappedY) {
        node.y = snappedY;
        changed = true;
      }
    }
  }

  changed = preserveCraftVerticalPipeGap(layout) || changed;

  if (Array.isArray(layout.links)) {
    for (const link of layout.links) {
      const wanted = {
        fromAnchorSide: "bottom",
        fromAnchorOffset: 0.5,
        toAnchorSide: "top",
        toAnchorOffset: 0.5
      };
      for (const [key, value] of Object.entries(wanted)) {
        if (link[key] !== "" && link[key] !== null && link[key] !== undefined) continue;
        if (link[key] === value) continue;
        link[key] = value;
        changed = true;
      }
    }
  }

  return changed;
}

function resolveCraftNodeSize(node, ownerItem) {
  const item = node?.root ? ownerItem : resolveItemFromUuid(node?.itemUuid);
  return resolveItemNodeSize(item);
}

function resolveItemNodeSize(item) {
  if (!item) return null;
  const migration = getMigrationData(item);
  const migrationSize = migration ? resolveInventorySize(item, migration) : null;
  if (migrationSize) return { width: migrationSize.width, height: migrationSize.height };

  const width = toInteger(item.system?.placement?.width, 0);
  const height = toInteger(item.system?.placement?.height, 0);
  if (width > 0 && height > 0) return { width, height };
  return null;
}

function resolveItemFromUuid(uuid) {
  const raw = String(uuid ?? "").trim();
  if (!raw) return null;
  const itemId = raw.match(/(?:^|\.)Item\.([A-Za-z0-9]+)/)?.[1] ?? raw.replace(/^Item\./, "");
  return game.items.get(itemId) ?? null;
}

function preserveCraftVerticalPipeGap(layout) {
  const nodes = Array.isArray(layout?.nodes) ? layout.nodes : [];
  const roots = nodes.filter(node => node.root);
  const details = nodes.filter(node => !node.root);
  if (!roots.length || !details.length) return false;

  const rootBounds = getCraftNodesBounds(roots);
  const detailBounds = getCraftNodesBounds(details);
  if (!rootBounds || !detailBounds) return false;

  const gap = 2;
  let changed = false;
  if (detailBounds.y <= rootBounds.y) {
    const targetRootY = detailBounds.bottom + gap + (rootBounds.height / 2);
    const dy = snapDelta(targetRootY - rootBounds.y);
    if (dy) {
      for (const node of roots) node.y = snapCraftGridCoordinate((Number(node.y) || 0) + dy, node.height);
      changed = true;
    }
  } else {
    const targetDetailY = rootBounds.bottom + gap + (detailBounds.height / 2);
    const dy = snapDelta(targetDetailY - detailBounds.y);
    if (dy) {
      for (const node of details) node.y = snapCraftGridCoordinate((Number(node.y) || 0) + dy, node.height);
      changed = true;
    }
  }

  return changed;
}

function getCraftNodesBounds(nodes = []) {
  const bounds = nodes.map(craftNodeToBounds);
  if (!bounds.length) return null;
  const left = Math.min(...bounds.map(bound => bound.left));
  const right = Math.max(...bounds.map(bound => bound.right));
  const top = Math.min(...bounds.map(bound => bound.top));
  const bottom = Math.max(...bounds.map(bound => bound.bottom));
  return {
    left,
    right,
    top,
    bottom,
    x: (left + right) / 2,
    y: (top + bottom) / 2,
    width: right - left,
    height: bottom - top
  };
}

function craftNodeToBounds(node = {}) {
  const width = Math.max(1, toInteger(node.width, 1));
  const height = Math.max(1, toInteger(node.height, 1));
  const x = Number(node.x) || 0;
  const y = Number(node.y) || 0;
  return {
    left: x - (width / 2),
    right: x + (width / 2),
    top: y - (height / 2),
    bottom: y + (height / 2),
    x,
    y,
    width,
    height
  };
}

function snapCraftGridCoordinate(value, size = 1) {
  const numericSize = Math.max(1, toInteger(size, 1));
  const offset = numericSize % 2 === 0 ? 0.5 : 0;
  const number = Number(value);
  return (Number.isFinite(number) ? Math.round(number - offset) : 0) + offset;
}

function snapDelta(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.abs(number) < 0.000001 ? 0 : number;
}

function hasOccupiedEquipmentSlot(item, label) {
  const slots = item.system?.occupiedSlots ?? {};
  const key = getEquipmentSlotSelectionKey(label);
  return Boolean(slots?.[key]);
}

function getEquipmentSlotSelectionKey(label) {
  const normalized = String(label ?? "").trim().toLocaleLowerCase();
  return `slot${hashSelectionKey(normalized)}`;
}

function hashSelectionKey(normalized) {
  let hash = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    hash = ((hash << 5) - hash) + normalized.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function normalizeRu(value) {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase("ru")
    .replaceAll("ё", "е")
    .replace(/\s+/g, " ");
}

function toInteger(value, fallback = 0) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? number : fallback;
}
