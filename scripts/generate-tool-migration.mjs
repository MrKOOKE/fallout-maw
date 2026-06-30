import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCraftData,
  collectReferencedIds,
  compareRu,
  convertPoundsToKilograms,
  extractDescription,
  getFolderPath,
  getOldItemSection,
  migrateAssetPath,
  readLevelDocuments,
  resolveOldItemId,
  toInteger,
  toNumber
} from "./generate-material-migration.mjs";
import { ENSURE_ITEM_CATEGORIES_MACRO } from "./migration-item-categories.mjs";
import {
  convertParsedToolToFunction,
  parseToolDescription
} from "./tool-description-parser.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const systemRoot = path.resolve(__dirname, "..");
const dataRoot = path.resolve(systemRoot, "..", "..");
const OLD_WORLD_ROOT = path.join(dataRoot, "fallout-old");
const MACRO_OUTPUT_DIR = path.join(systemRoot, "scripts", "migration-macros", "tools");
const MACRO_FILE = "01-import-tool-items.js";
const ROOT_FOLDER = "MAW Импорт инструментов";
const TOOL_FOLDER_PREFIX = "Инструменты / ";
const MEDICAL_FOLDER_PREFIX = "Препараты / Медицина";
const OLD_ITEM_ID_ALIASES = {
  "0cygJX1IKCzvWw1b": "x2VIpCSzghynU8c5"
};

async function main() {
  const [items, folders] = await Promise.all([
    readLevelDocuments(path.join(OLD_WORLD_ROOT, "data", "items")),
    readLevelDocuments(path.join(OLD_WORLD_ROOT, "data", "folders"))
  ]);
  const folderById = new Map(folders.map(folder => [folder._id, folder]));
  const itemById = new Map(items.filter(item => item?._id).map(item => [item._id, item]));

  const candidates = Array.from(itemById.values())
    .map(item => ({
      item,
      folderPath: getFolderPath(item.folder, folderById),
      parsed: parseToolDescription(extractDescription(item))
    }))
    .filter(entry => isToolMigrationCandidate(entry.folderPath))
    .sort((left, right) => (
      compareRu(left.folderPath, right.folderPath)
      || compareRu(left.item.name, right.item.name)
      || left.item._id.localeCompare(right.item._id)
    ));

  await fs.mkdir(MACRO_OUTPUT_DIR, { recursive: true });

  const records = [];
  const unparsed = [];
  for (const entry of candidates) {
    if (!entry.parsed) {
      unparsed.push(`${entry.item._id}\t${entry.item.name}\t${entry.folderPath}`);
      continue;
    }
    records.push(await createToolMigrationRecord(entry.item, entry.folderPath, entry.parsed, itemById));
  }

  const craftReferenceNames = buildCraftReferenceNames(records, itemById);
  const unresolvedReferences = Array.from(collectReferencedIds(records))
    .filter(id => !resolveOldItemId(itemById, id))
    .map(id => `${id}\t(нет в старом мире)`);

  const buildStamp = new Date().toISOString();
  await fs.writeFile(
    path.join(MACRO_OUTPUT_DIR, MACRO_FILE),
    buildToolMacro(records, craftReferenceNames, buildStamp),
    "utf8"
  );
  await fs.writeFile(
    path.join(MACRO_OUTPUT_DIR, "README.md"),
    buildReadme(records.length, candidates.length, buildStamp),
    "utf8"
  );
  await fs.writeFile(
    path.join(MACRO_OUTPUT_DIR, "00-PASTE-INTO-FOUNDRY-MACRO.js"),
    buildPasteMacro(),
    "utf8"
  );

  console.log(`Tool folder items found: ${candidates.length}`);
  console.log(`Parsed with tool function: ${records.length}`);
  console.log(`Unparsed descriptions: ${unparsed.length}`);
  if (unparsed.length) console.log(unparsed.join("\n"));
  console.log(`Craft ingredient names for lookup: ${Object.keys(craftReferenceNames).length}`);
  console.log(`Missing in old world (need manual link): ${unresolvedReferences.length}`);
  if (unresolvedReferences.length) console.log(unresolvedReferences.join("\n"));
  console.log(`Macro written: ${path.join(MACRO_OUTPUT_DIR, MACRO_FILE)}`);
}

async function createToolMigrationRecord(item, folderPath, parsed, itemById) {
  const img = await migrateAssetPath(item.img);
  const oldCraft = item.flags?.["blok-upravleniya"]?.craft ?? null;
  const toolFunctions = convertParsedToolToFunction(parsed);

  return {
    id: item._id,
    name: item.name,
    img,
    folderPath: normalizeToolFolderPath(folderPath).split(" / ").filter(Boolean),
    oldType: item.type,
    oldFolderPath: folderPath,
    oldImg: item.img ?? "",
    system: {
      description: "",
      quantity: Math.max(1, toInteger(item.system?.quantity, 1)),
      maxStack: 1,
      itemCategory: getOldItemSection(item) || "Инструменты",
      weight: convertPoundsToKilograms(item.system?.weight?.value ?? item.system?.weight),
      price: Math.max(0, toNumber(item.system?.price?.value ?? item.system?.price, 0)),
      equipped: false,
      locked: false,
      placement: {
        mode: "inventory",
        equipmentSlot: "",
        weaponSet: "",
        weaponSlot: "",
        limbKey: "",
        constructPartOrder: 0,
        x: 1,
        y: 1,
        width: 1,
        height: 1,
        rotated: false
      },
      functions: toolFunctions,
      craft: buildCraftData(item, img, oldCraft, itemById)
    }
  };
}

function isToolMigrationCandidate(folderPath) {
  return folderPath.startsWith(TOOL_FOLDER_PREFIX)
    || folderPath === MEDICAL_FOLDER_PREFIX
    || folderPath.startsWith(`${MEDICAL_FOLDER_PREFIX} / `);
}

function normalizeToolFolderPath(folderPath) {
  if (folderPath.startsWith(TOOL_FOLDER_PREFIX)) {
    return String(folderPath).slice(TOOL_FOLDER_PREFIX.length);
  }
  if (folderPath === MEDICAL_FOLDER_PREFIX || folderPath.startsWith(`${MEDICAL_FOLDER_PREFIX} / `)) {
    return folderPath === MEDICAL_FOLDER_PREFIX
      ? "Медицина"
      : `Медицина / ${folderPath.slice(MEDICAL_FOLDER_PREFIX.length + 3)}`;
  }
  return String(folderPath ?? "");
}

function buildCraftReferenceNames(records, itemById) {
  const names = {};
  for (const oldId of collectReferencedIds(records)) {
    const item = resolveOldItemId(itemById, oldId);
    if (item?.name) names[oldId] = item.name;
  }
  return names;
}

function buildToolMacro(records, craftReferenceNames, buildStamp) {
  return `// Generated by systems/fallout-maw/scripts/generate-tool-migration.mjs
// ${buildStamp}

const TOOL_ITEMS = ${JSON.stringify(records, null, 2)};

const SYSTEM_ID = "fallout-maw";
const ROOT_FOLDER = ${JSON.stringify(ROOT_FOLDER)};
const FLAG_SCOPE = "fallout-maw";
const FLAG_KEY = "toolMigration";
const MATERIAL_FLAG_KEY = "materialMigration";
const JUNK_FLAG_KEY = "junkMigration";
const FIRST_AID_FLAG_KEY = "firstAidMigration";
const OLD_ITEM_ID_ALIASES = ${JSON.stringify(OLD_ITEM_ID_ALIASES)};
const CRAFT_REFERENCE_NAMES = ${JSON.stringify(craftReferenceNames, null, 2)};

const EMPTY_CRAFT = {
  mode: "craft",
  nodes: [],
  links: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  disassembly: { nodes: [], links: [], viewport: { x: 0, y: 0, zoom: 1 } },
  recipes: []
};

const missingReferences = new Set();
await runToolImport();

async function runToolImport() {
  if (game.system.id !== SYSTEM_ID) {
    ui.notifications.error("Этот макрос рассчитан на систему fallout-maw.");
    return;
  }

  await ensureItemCategories(Array.from(new Set(TOOL_ITEMS
    .map(entry => String(entry.system?.itemCategory ?? "").trim())
    .filter(Boolean))));

  const touched = [];
  const idMap = new Map();
  for (const entry of TOOL_ITEMS) {
    const folderId = await ensureFolderPath([ROOT_FOLDER, ...entry.folderPath]);
    const existing = findExistingMigrationItem(entry);
    const data = buildItemData(entry, folderId, { craft: EMPTY_CRAFT });
    let item = existing;
    if (item) {
      const updateData = foundry.utils.deepClone(data);
      delete updateData._id;
      await item.update(updateData);
    } else {
      item = await createItemWithPreferredId(data);
    }
    idMap.set(entry.id, item.id);
    touched.push({ entry, item, folderId });
  }

  for (const { entry, item, folderId } of touched) {
    const craft = rewriteCraftReferences(entry.system.craft, idMap, item.id);
    const data = buildItemData(entry, folderId, { craft });
    delete data._id;
    await item.update(data);
  }

  if (missingReferences.size) {
    ui.notifications.warn(\`Импорт инструментов: обработано \${touched.length}. Не удалось разрешить \${missingReferences.size} ссылок крафта.\`);
    console.warn("Tool import unresolved craft references", Array.from(missingReferences));
  } else {
    ui.notifications.info(\`Импорт инструментов: обработано \${touched.length}. Все ссылки крафта разрешены.\`);
  }
  console.log("Tool import", { touched: touched.length, missingReferences: Array.from(missingReferences) });
}

async function createItemWithPreferredId(data) {
  try {
    return await Item.create(data);
  } catch (error) {
    console.warn("Не удалось создать предмет с исходным id, создаю с новым id.", data._id, error);
    const fallback = foundry.utils.deepClone(data);
    delete fallback._id;
    return Item.create(fallback);
  }
}

function buildItemData(entry, folderId, { craft }) {
  const system = foundry.utils.deepClone(entry.system);
  system.craft = foundry.utils.deepClone(craft ?? EMPTY_CRAFT);
  system.functions = foundry.utils.deepClone(entry.system.functions ?? {});
  const toolKey = String(system.functions?.tool?.toolKey ?? "").trim();
  if (toolKey && system.functions.tools?.[toolKey]) {
    system.functions.tool = { enabled: true, toolKey };
    system.functions.tools[toolKey].enabled = true;
  }
  return {
    _id: entry.id,
    name: entry.name,
    type: "gear",
    img: entry.img,
    folder: folderId,
    system,
    flags: {
      [FLAG_SCOPE]: {
        [FLAG_KEY]: {
          oldId: entry.id,
          oldType: entry.oldType,
          oldFolderPath: entry.oldFolderPath,
          oldImg: entry.oldImg,
          sourceWorld: "fallout-old"
        }
      }
    }
  };
}

function findExistingMigrationItem(entry) {
  const byFlag = game.items.find(item => item.getFlag(FLAG_SCOPE, FLAG_KEY)?.oldId === entry.id);
  if (byFlag) return byFlag;
  const byMaterialFlag = game.items.find(item => item.getFlag(FLAG_SCOPE, MATERIAL_FLAG_KEY)?.oldId === entry.id);
  if (byMaterialFlag) return byMaterialFlag;
  const byJunkFlag = game.items.find(item => item.getFlag(FLAG_SCOPE, JUNK_FLAG_KEY)?.oldId === entry.id);
  if (byJunkFlag) return byJunkFlag;
  const byFirstAidFlag = game.items.find(item => item.getFlag(FLAG_SCOPE, FIRST_AID_FLAG_KEY)?.oldId === entry.id);
  if (byFirstAidFlag) return byFirstAidFlag;
  const byId = game.items.get(entry.id);
  if (byId?.name === entry.name) return byId;
  return null;
}

function resolveAlias(oldId) {
  return OLD_ITEM_ID_ALIASES[oldId] ?? oldId;
}

function findItemByName(name) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return null;
  const matches = game.items.filter(item => item.name === trimmed);
  if (!matches.length) return null;
  if (matches.length === 1) return matches[0];
  return matches.find(item => item.getFlag(FLAG_SCOPE, MATERIAL_FLAG_KEY))
    ?? matches.find(item => item.getFlag(FLAG_SCOPE, FLAG_KEY))
    ?? matches.find(item => item.getFlag(FLAG_SCOPE, JUNK_FLAG_KEY))
    ?? matches.find(item => item.getFlag(FLAG_SCOPE, FIRST_AID_FLAG_KEY))
    ?? matches[0];
}

function resolveImportedItemId(oldId, idMap, hintName) {
  const resolvedOldId = resolveAlias(oldId);
  if (idMap.has(resolvedOldId)) return idMap.get(resolvedOldId);
  if (idMap.has(oldId)) return idMap.get(oldId);

  const byToolFlag = game.items.find(item => item.getFlag(FLAG_SCOPE, FLAG_KEY)?.oldId === resolvedOldId)
    ?? game.items.find(item => item.getFlag(FLAG_SCOPE, FLAG_KEY)?.oldId === oldId);
  if (byToolFlag) return byToolFlag.id;

  const byMaterialFlag = game.items.find(item => item.getFlag(FLAG_SCOPE, MATERIAL_FLAG_KEY)?.oldId === resolvedOldId)
    ?? game.items.find(item => item.getFlag(FLAG_SCOPE, MATERIAL_FLAG_KEY)?.oldId === oldId);
  if (byMaterialFlag) return byMaterialFlag.id;

  const byJunkFlag = game.items.find(item => item.getFlag(FLAG_SCOPE, JUNK_FLAG_KEY)?.oldId === resolvedOldId)
    ?? game.items.find(item => item.getFlag(FLAG_SCOPE, JUNK_FLAG_KEY)?.oldId === oldId);
  if (byJunkFlag) return byJunkFlag.id;

  const byFirstAidFlag = game.items.find(item => item.getFlag(FLAG_SCOPE, FIRST_AID_FLAG_KEY)?.oldId === resolvedOldId)
    ?? game.items.find(item => item.getFlag(FLAG_SCOPE, FIRST_AID_FLAG_KEY)?.oldId === oldId);
  if (byFirstAidFlag) return byFirstAidFlag.id;

  const byId = game.items.get(resolvedOldId) ?? game.items.get(oldId);
  if (byId) return byId.id;

  const lookupName = hintName || CRAFT_REFERENCE_NAMES[oldId] || CRAFT_REFERENCE_NAMES[resolvedOldId];
  const byName = findItemByName(lookupName);
  if (byName) return byName.id;

  missingReferences.add(oldId);
  return oldId;
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
    const oldId = String(node.itemUuid ?? "").replace(/^Item\\./, "");
    if (!oldId) continue;
    node.itemUuid = \`Item.\${node.root ? selfId : resolveImportedItemId(oldId, idMap, node.name)}\`;
  }
}

async function ensureFolderPath(parts) {
  let parentId = null;
  for (const name of parts) {
    let folder = game.folders.find(candidate => (
      candidate.type === "Item"
      && candidate.name === name
      && getFolderParentId(candidate) === parentId
    ));
    if (!folder) folder = await Folder.create({ name, type: "Item", folder: parentId });
    parentId = folder.id;
  }
  return parentId;
}

function getFolderParentId(folder) {
  return folder.folder?.id ?? folder.folder ?? null;
}

${ENSURE_ITEM_CATEGORIES_MACRO}
`;
}

function buildReadme(recordCount, folderCount, buildStamp) {
  return `# Макросы миграции инструментов

Сгенерировано: \`${buildStamp}\`

## Быстрый запуск

1. Сначала импортируйте **материалы**.
2. Откройте мир на системе \`fallout-maw\`.
3. Создайте макрос типа **Script**.
4. Вставьте содержимое **\`00-PASTE-INTO-FOUNDRY-MACRO.js\`**.
5. Запустите макрос от GM.

## Файлы

- \`00-PASTE-INTO-FOUNDRY-MACRO.js\` — вставляйте это в макрос Foundry
- \`${MACRO_FILE}\` — ${recordCount} инструментов (ремнаборы, отмычки, медицинские наборы)

Описание из старого мира конвертируется в функцию **Инструмент** (\`repair\`, \`medical\`, \`mechanicalHacking\`, \`electronicHacking\`).
`;
}

function buildPasteMacro() {
  return `// Fallout-MaW tool migration: one Foundry macro.
// Вставьте весь этот скрипт в один макрос Foundry (Script) и запустите от GM.

const SYSTEM_ID = "fallout-maw";
const BASE_PATH = "systems/fallout-maw/scripts/migration-macros/tools";
const TOOL_IMPORT_FILE = "${MACRO_FILE}";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

if (game.system.id !== SYSTEM_ID) {
  ui.notifications.error("Этот макрос рассчитан только на систему fallout-maw.");
  return;
}

ui.notifications.info("Импорт инструментов: старт…");

const url = \`\${BASE_PATH}/\${TOOL_IMPORT_FILE}\`;
const response = await fetch(url, { cache: "no-cache" });
if (!response.ok) throw new Error(\`Не удалось загрузить \${url}: HTTP \${response.status}\`);
const code = await response.text();
await new AsyncFunction(code)();

ui.notifications.info("Импорт инструментов: завершён.");
`;
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
