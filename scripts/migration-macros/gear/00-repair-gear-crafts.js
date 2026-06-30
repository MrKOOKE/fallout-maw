// Восстановление крафтов оружия и снаряжения после неполного импорта.
// Запускайте от GM после импорта материалов. Не пересоздаёт предметы — только system.craft.

const SYSTEM_ID = "fallout-maw";
const BASE_PATH = "systems/fallout-maw/scripts/migration-macros";
const FLAG_SCOPE = "fallout-maw";
const STEPS = [
  { dir: "weapons", file: "01-import-weapon-items.js", constName: "WEAPON_ITEMS", label: "оружие" },
  { dir: "equipment", file: "01-import-equipment-items.js", constName: "EQUIPMENT_ITEMS", label: "снаряжение" }
];

const OLD_ITEM_ID_ALIASES = {
  "0cygJX1IKCzvWw1b": "x2VIpCSzghynU8c5",
  "lNGUlpxPqCSrMkit": "dhbmaVvqxPoAB4q0",
  "dns2gvnKvE0HDxhn": "2Gqvi42QCTSCG7tO",
  "GDpJwJUShXKuEBvY": "oZJX2XJgw23kDXPc",
  "S3TAv0k5a281qMqG": "27KJalb5VBosRB8B",
  "JFuavNs0sG8ikClw": "oclSElwvY8MjXuIv",
  "zlTJ8whZtCY2abor": "NSAiD9LVesJTicxy",
  "O49Op2BxTVJzBrSj": "O8tcA1MvPpSgET9R",
  "IBupLj0xLa4eKncN": "vByBBvvQ2lPbrxjE"
};

const ALL_MIGRATION_FLAG_KEYS = [
  "materialMigration",
  "junkMigration",
  "firstAidMigration",
  "bookMigration",
  "foodMigration",
  "toolMigration",
  "ammoMigration",
  "weaponMigration",
  "equipmentMigration"
];

const EMPTY_CRAFT = {
  mode: "craft",
  nodes: [],
  links: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  disassembly: { nodes: [], links: [], viewport: { x: 0, y: 0, zoom: 1 } },
  recipes: []
};

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const missingReferences = new Set();

if (game.system.id !== SYSTEM_ID) {
  ui.notifications.error("Этот макрос рассчитан только на систему fallout-maw.");
  return;
}

let totalUpdated = 0;
let totalSkipped = 0;
let totalErrors = 0;
let totalWithIngredients = 0;

for (const step of STEPS) {
  ui.notifications.info(`Восстановление крафтов (${step.label}): загрузка данных…`);
  const url = `${BASE_PATH}/${step.dir}/${step.file}`;
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) {
    ui.notifications.error(`Не удалось загрузить ${url}: HTTP ${response.status}`);
    continue;
  }
  const code = await response.text();
  const entries = await new AsyncFunction(`${code}\nreturn ${step.constName};`)();
  const stats = await repairCraftsForEntries(entries, step.label);
  totalUpdated += stats.updated;
  totalSkipped += stats.skipped;
  totalErrors += stats.errors;
  totalWithIngredients += stats.withIngredients;
}

if (missingReferences.size) {
  ui.notifications.warn(
    `Крафты восстановлены: ${totalUpdated} предметов (${totalWithIngredients} с ингредиентами). `
    + `Пропущено ${totalSkipped}, ошибок ${totalErrors}. `
    + `Неразрешённых ссылок: ${missingReferences.size}.`
  );
  console.warn("repair-gear-crafts unresolved references", Array.from(missingReferences));
} else {
  ui.notifications.info(
    `Крафты восстановлены: ${totalUpdated} предметов (${totalWithIngredients} с ингредиентами). `
    + `Пропущено ${totalSkipped}, ошибок ${totalErrors}.`
  );
}

console.log("repair-gear-crafts", {
  updated: totalUpdated,
  withIngredients: totalWithIngredients,
  skipped: totalSkipped,
  errors: totalErrors,
  missingReferences: Array.from(missingReferences)
});

async function repairCraftsForEntries(entries, label) {
  const idMap = new Map();
  const touched = [];

  for (const entry of entries) {
    const item = findExistingMigrationItem(entry);
    if (!item) continue;
    idMap.set(entry.id, item.id);
    touched.push({ entry, item });
  }

  let updated = 0;
  let skipped = 0;
  let errors = 0;
  let withIngredients = 0;

  for (let index = 0; index < touched.length; index += 1) {
    const { entry, item } = touched[index];
    const sourceCraft = entry.system?.craft;
    if (!hasCraftPayload(sourceCraft)) {
      skipped += 1;
      continue;
    }

    const craft = rewriteCraftReferences(sourceCraft, idMap, item.id);
    const ingredientCount = countCraftIngredients(craft);
    try {
      await item.update({ "system.craft": craft });
      updated += 1;
      if (ingredientCount > 0) withIngredients += 1;
    } catch (error) {
      errors += 1;
      console.error("repair-gear-crafts failed", entry.id, entry.name, error);
    }

    if ((index + 1) % 50 === 0) {
      ui.notifications.info(`Восстановление крафтов (${label}): ${index + 1}/${touched.length}`);
    }
  }

  return { updated, skipped, errors, withIngredients };
}

function hasCraftPayload(craft) {
  if (!craft) return false;
  if ((craft.nodes ?? []).length || (craft.links ?? []).length) return true;
  if ((craft.recipes ?? []).some(recipe => hasCraftRecipeEntryData(recipe))) return true;
  return hasCraftRecipeEntryData(craft.disassembly);
}

function hasCraftRecipeEntryData(recipe = {}) {
  return Boolean(
    (recipe?.nodes ?? []).length
    || (recipe?.links ?? []).length
    || (recipe?.disassembly?.nodes ?? []).length
    || (recipe?.disassembly?.links ?? []).length
  );
}

function countCraftIngredients(craft) {
  let max = (craft?.nodes ?? []).filter(node => !node.root).length;
  for (const recipe of craft?.recipes ?? []) {
    max = Math.max(max, (recipe?.nodes ?? []).filter(node => !node.root).length);
  }
  return max;
}

function findExistingMigrationItem(entry) {
  for (const flagKey of ALL_MIGRATION_FLAG_KEYS) {
    const byFlag = game.items.find(item => item.getFlag(FLAG_SCOPE, flagKey)?.oldId === entry.id);
    if (byFlag) return byFlag;
  }
  const byId = game.items.get(entry.id);
  if (byId?.name === entry.name) return byId;
  return null;
}

function extractCraftItemOldId(uuid) {
  const raw = String(uuid ?? "").trim();
  if (!raw) return "";
  const itemMatch = raw.match(/(?:^|\.)(Item\.([A-Za-z0-9]+))$/);
  if (itemMatch) return itemMatch[2];
  return raw.replace(/^Item\./, "");
}

function resolveAlias(oldId) {
  const sourceOldId = extractCraftItemOldId(oldId);
  return OLD_ITEM_ID_ALIASES[sourceOldId] ?? OLD_ITEM_ID_ALIASES[oldId] ?? sourceOldId;
}

function findItemByMigrationOldId(oldId) {
  const resolvedOldId = resolveAlias(oldId);
  for (const flagKey of ALL_MIGRATION_FLAG_KEYS) {
    const byFlag = game.items.find(item => item.getFlag(FLAG_SCOPE, flagKey)?.oldId === resolvedOldId)
      ?? game.items.find(item => item.getFlag(FLAG_SCOPE, flagKey)?.oldId === oldId);
    if (byFlag) return byFlag;
  }
  return game.items.get(resolvedOldId) ?? game.items.get(oldId) ?? null;
}

function resolveImportedItemId(oldId, idMap) {
  const sourceOldId = extractCraftItemOldId(oldId);
  const resolvedOldId = resolveAlias(sourceOldId);
  if (idMap.has(resolvedOldId)) return idMap.get(resolvedOldId);
  if (idMap.has(sourceOldId)) return idMap.get(sourceOldId);

  const byMigration = findItemByMigrationOldId(sourceOldId);
  if (byMigration) return byMigration.id;

  missingReferences.add(sourceOldId);
  return sourceOldId;
}

function rewriteCraftReferences(craft, idMap, selfId) {
  const next = foundry.utils.deepClone(craft ?? EMPTY_CRAFT);
  rewriteNodeList(next.nodes, idMap, selfId);
  rewriteNodeList(next.disassembly?.nodes, idMap, selfId);
  for (const recipe of next.recipes ?? []) {
    rewriteNodeList(recipe.nodes, idMap, selfId);
    rewriteNodeList(recipe.disassembly?.nodes, idMap, selfId);
  }
  return next;
}

function rewriteNodeList(nodes, idMap, selfId) {
  if (!Array.isArray(nodes)) return;
  for (const node of nodes) {
    const oldId = extractCraftItemOldId(node.itemUuid);
    if (!oldId) continue;
    node.itemUuid = `Item.${node.root ? selfId : resolveImportedItemId(oldId, idMap)}`;
  }
}
