// Repair current-world food craft graphs only.
// Paste into a Foundry Script macro and run as GM in a fallout-maw world.
//
// This macro does not import food, create items, move folders, rename items, or
// touch item data other than system.craft. It loads the generated food migration
// file only as a canonical craft-graph data source.

const SYSTEM_ID = "fallout-maw";
const BASE_PATH = "systems/fallout-maw/scripts/migration-macros/food";
const SOURCE_FILE = "01-import-food-items.js";
const FLAG_SCOPE = "fallout-maw";
const FOOD_FLAG_KEY = "foodMigration";
const ALL_MIGRATION_FLAG_KEYS = [
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
const REPAIR_ACTOR_EMBEDDED_ITEMS = false;

const EMPTY_CRAFT = {
  mode: "craft",
  nodes: [],
  links: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  disassembly: { nodes: [], links: [], viewport: { x: 0, y: 0, zoom: 1 } },
  recipes: []
};

const missingReferences = new Set();
const ambiguousTargets = [];
const unresolvedTargets = [];

if (game.system.id !== SYSTEM_ID) {
  ui.notifications.error("This macro is only for the fallout-maw system.");
  return;
}

if (!game.user.isGM) {
  ui.notifications.error("Run this macro as GM.");
  return;
}

const source = await loadFoodCraftSource();
const result = await repairFoodCrafts(source);

const summary = [
  `Food craft repair: updated ${result.updated}`,
  `unchanged ${result.unchanged}`,
  `missing targets ${result.missingTargets}`,
  `errors ${result.errors}`,
  `missing refs ${missingReferences.size}`
].join(", ");

if (result.errors || result.missingTargets || missingReferences.size || ambiguousTargets.length) {
  ui.notifications.warn(summary);
} else {
  ui.notifications.info(summary);
}

console.log("fallout-maw food craft repair", {
  dryRun: DRY_RUN,
  repairActorEmbeddedItems: REPAIR_ACTOR_EMBEDDED_ITEMS,
  ...result,
  missingReferences: Array.from(missingReferences),
  unresolvedTargets,
  ambiguousTargets
});

async function loadFoodCraftSource() {
  const url = `${BASE_PATH}/${SOURCE_FILE}`;
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`Failed to load ${url}: HTTP ${response.status}`);

  const code = await response.text();
  const cutoff = code.indexOf("\nconst EMPTY_CRAFT");
  if (cutoff < 0) throw new Error(`Could not find source cutoff in ${url}.`);

  const sourceCode = code.slice(0, cutoff);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  return new AsyncFunction(`${sourceCode}
return {
  FOOD_ITEMS,
  OLD_ITEM_ID_ALIASES: typeof OLD_ITEM_ID_ALIASES === "undefined" ? {} : OLD_ITEM_ID_ALIASES,
  CRAFT_REFERENCE_NAMES: typeof CRAFT_REFERENCE_NAMES === "undefined" ? {} : CRAFT_REFERENCE_NAMES
};`)();
}

async function repairFoodCrafts(source) {
  const foodItems = Array.isArray(source?.FOOD_ITEMS) ? source.FOOD_ITEMS : [];
  const idMap = buildCurrentFoodIdMap(foodItems);
  const targets = [];

  for (const entry of foodItems) {
    const target = findCurrentFoodItem(entry);
    if (!target) {
      unresolvedTargets.push({ oldId: entry.id, name: entry.name });
      continue;
    }
    targets.push({ entry, item: target });
  }

  const stats = {
    sourceEntries: foodItems.length,
    targets: targets.length,
    updated: 0,
    unchanged: 0,
    missingTargets: unresolvedTargets.length,
    errors: 0,
    actorEmbeddedUpdated: 0,
    actorEmbeddedUnchanged: 0
  };

  for (let index = 0; index < targets.length; index += 1) {
    const { entry, item } = targets[index];
    try {
      const craft = rewriteCraftReferences(entry.system?.craft, idMap, item.id, source);
      if (!craftChanged(item.system?.craft, craft)) {
        stats.unchanged += 1;
      } else {
        if (!DRY_RUN) await item.update({ "system.craft": craft });
        stats.updated += 1;
      }

      if (REPAIR_ACTOR_EMBEDDED_ITEMS) {
        const embeddedStats = await repairActorEmbeddedCopies(entry, craft);
        stats.actorEmbeddedUpdated += embeddedStats.updated;
        stats.actorEmbeddedUnchanged += embeddedStats.unchanged;
      }
    } catch (error) {
      stats.errors += 1;
      console.error("Food craft repair failed", entry.id, entry.name, item.uuid, error);
    }

    if ((index + 1) % 50 === 0) {
      ui.notifications.info(`Food craft repair: ${index + 1}/${targets.length}`);
    }
  }

  return stats;
}

function buildCurrentFoodIdMap(entries) {
  const idMap = new Map();
  for (const entry of entries) {
    const item = findCurrentFoodItem(entry, { collectAmbiguous: false });
    if (item) idMap.set(entry.id, item.id);
  }
  return idMap;
}

function findCurrentFoodItem(entry, { collectAmbiguous = true } = {}) {
  const oldId = String(entry?.id ?? "").trim();
  const name = String(entry?.name ?? "").trim();
  if (!oldId && !name) return null;

  const byFoodFlag = game.items.find(item => item.getFlag(FLAG_SCOPE, FOOD_FLAG_KEY)?.oldId === oldId);
  if (byFoodFlag) return byFoodFlag;

  const byAnyMigrationFlag = game.items.find(item => (
    ALL_MIGRATION_FLAG_KEYS.some(key => item.getFlag(FLAG_SCOPE, key)?.oldId === oldId)
  ));
  if (byAnyMigrationFlag) return byAnyMigrationFlag;

  const byId = game.items.get(oldId);
  if (byId && (!name || byId.name === name)) return byId;

  const byName = game.items.filter(item => item.name === name);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    const flagged = byName.find(item => item.getFlag(FLAG_SCOPE, FOOD_FLAG_KEY))
      ?? byName.find(item => ALL_MIGRATION_FLAG_KEYS.some(key => item.getFlag(FLAG_SCOPE, key)));
    if (flagged) return flagged;
    if (collectAmbiguous) ambiguousTargets.push({ oldId, name, matches: byName.map(item => item.uuid) });
  }

  return null;
}

async function repairActorEmbeddedCopies(entry, worldCraft) {
  let updated = 0;
  let unchanged = 0;

  for (const actor of game.actors ?? []) {
    for (const item of actor.items ?? []) {
      if (!isEmbeddedCopyOfEntry(item, entry)) continue;
      const craft = foundry.utils.deepClone(worldCraft ?? EMPTY_CRAFT);
      rewriteRootNodesToSelf(craft, item.uuid);
      if (!craftChanged(item.system?.craft, craft)) {
        unchanged += 1;
        continue;
      }
      if (!DRY_RUN) await item.update({ "system.craft": craft });
      updated += 1;
    }
  }

  return { updated, unchanged };
}

function isEmbeddedCopyOfEntry(item, entry) {
  const oldId = String(entry?.id ?? "").trim();
  const name = String(entry?.name ?? "").trim();
  if (!item || !oldId) return false;
  if (item.getFlag(FLAG_SCOPE, FOOD_FLAG_KEY)?.oldId === oldId) return true;
  if (ALL_MIGRATION_FLAG_KEYS.some(key => item.getFlag(FLAG_SCOPE, key)?.oldId === oldId)) return true;
  return Boolean(name && item.name === name);
}

function rewriteCraftReferences(craft, idMap, selfId, source) {
  const next = foundry.utils.deepClone(craft ?? EMPTY_CRAFT);
  rewriteNodeList(next.nodes, idMap, selfId, source);
  rewriteNodeList(next.disassembly?.nodes, idMap, selfId, source);
  for (const recipe of next.recipes ?? []) {
    rewriteNodeList(recipe.nodes, idMap, selfId, source);
    rewriteNodeList(recipe.disassembly?.nodes, idMap, selfId, source);
  }
  return next;
}

function rewriteNodeList(nodes, idMap, selfId, source) {
  if (!Array.isArray(nodes)) return;
  for (const node of nodes) {
    const oldId = extractItemId(node.itemUuid);
    if (!oldId) continue;
    node.itemUuid = node.root ? `Item.${selfId}` : `Item.${resolveCurrentItemId(oldId, idMap, source)}`;
  }
}

function rewriteRootNodesToSelf(craft, selfUuid) {
  rewriteRootNodeList(craft?.nodes, selfUuid);
  rewriteRootNodeList(craft?.disassembly?.nodes, selfUuid);
  for (const recipe of craft?.recipes ?? []) {
    rewriteRootNodeList(recipe.nodes, selfUuid);
    rewriteRootNodeList(recipe.disassembly?.nodes, selfUuid);
  }
}

function rewriteRootNodeList(nodes, selfUuid) {
  if (!Array.isArray(nodes)) return;
  for (const node of nodes) {
    if (node.root) node.itemUuid = selfUuid;
  }
}

function resolveCurrentItemId(oldId, idMap, source) {
  const sourceOldId = extractItemId(oldId);
  const resolvedOldId = resolveAlias(sourceOldId, source);
  if (idMap.has(resolvedOldId)) return idMap.get(resolvedOldId);
  if (idMap.has(sourceOldId)) return idMap.get(sourceOldId);

  const byMigration = findItemByMigrationOldId(resolvedOldId) ?? findItemByMigrationOldId(sourceOldId);
  if (byMigration) return byMigration.id;

  const referenceName = source?.CRAFT_REFERENCE_NAMES?.[resolvedOldId] ?? source?.CRAFT_REFERENCE_NAMES?.[sourceOldId] ?? "";
  const byName = referenceName ? findItemByExactName(referenceName) : null;
  if (byName) return byName.id;

  const byId = game.items.get(resolvedOldId) ?? game.items.get(sourceOldId);
  if (byId) return byId.id;

  missingReferences.add(sourceOldId);
  return resolvedOldId || sourceOldId;
}

function findItemByMigrationOldId(oldId) {
  const id = String(oldId ?? "").trim();
  if (!id) return null;
  for (const key of ALL_MIGRATION_FLAG_KEYS) {
    const item = game.items.find(candidate => candidate.getFlag(FLAG_SCOPE, key)?.oldId === id);
    if (item) return item;
  }
  return null;
}

function findItemByExactName(name) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return null;
  const matches = game.items.filter(item => item.name === trimmed);
  if (!matches.length) return null;
  if (matches.length === 1) return matches[0];
  return matches.find(item => ALL_MIGRATION_FLAG_KEYS.some(key => item.getFlag(FLAG_SCOPE, key))) ?? matches[0];
}

function resolveAlias(oldId, source) {
  const id = extractItemId(oldId);
  return source?.OLD_ITEM_ID_ALIASES?.[id] ?? id;
}

function extractItemId(uuid) {
  const raw = String(uuid ?? "").trim();
  if (!raw) return "";
  return raw.match(/(?:^|\.)Item\.([A-Za-z0-9]+)/)?.[1] ?? raw.replace(/^Item\./, "");
}

function craftChanged(current, next) {
  return JSON.stringify(current ?? null) !== JSON.stringify(next ?? null);
}
