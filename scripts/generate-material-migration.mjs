import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const systemRoot = path.resolve(__dirname, "..");
const dataRoot = path.resolve(systemRoot, "..", "..");
const downloadsDataRoot = path.join(os.homedir(), "Downloads", "Data");
const { ClassicLevel } = require(path.join(
  dataRoot,
  "Foundary",
  "Foundry Virtual Tabletop",
  "resources",
  "app",
  "node_modules",
  "classic-level"
));

const OLD_WORLD_ROOT = path.join(dataRoot, "fallout-old");
const MACRO_OUTPUT_DIR = path.join(systemRoot, "scripts", "migration-macros", "materials");
const MODULE_ASSET_OUTPUT_DIR = path.join(systemRoot, "assets", "Materialy", "kctg-5e-fallout");
const SYSTEM_ASSET_PREFIX = "systems/fallout-maw";

const OLD_ITEM_ID_ALIASES = new Map([
  ["0cygJX1IKCzvWw1b", "x2VIpCSzghynU8c5"]
]);

const MACRO_GROUPS = [
  {
    key: "primary",
    file: "01-import-primary-materials.js",
    label: "01. Импорт первичных материалов",
    match: folderPath => folderPath.startsWith("Материалы / Первичные материалы /")
  },
  {
    key: "secondary",
    file: "02-import-secondary-materials.js",
    label: "02. Импорт вторичных материалов",
    match: folderPath => folderPath.startsWith("Материалы / Вторичные мсатериалы /")
  },
  {
    key: "components",
    file: "03-import-material-components.js",
    label: "03. Импорт компонентов материалов",
    match: folderPath => folderPath.startsWith("Материалы / Компоненты ")
  }
];

const OLD_SKILL_MAP = new Map([
  ["cra", "repair"],
  ["repair", "repair"],
  ["med", "doctor"],
  ["medicine", "doctor"],
  ["doctor", "doctor"],
  ["sur", "naturalist"],
  ["nat", "naturalist"],
  ["nature", "naturalist"],
  ["naturalist", "naturalist"],
  ["arc", "science"],
  ["his", "science"],
  ["inv", "science"],
  ["science", "science"]
]);

const CYRILLIC = new Map(Object.entries({
  А: "A", а: "a", Б: "B", б: "b", В: "V", в: "v", Г: "G", г: "g",
  Д: "D", д: "d", Е: "E", е: "e", Ё: "E", ё: "e", Ж: "Zh", ж: "zh",
  З: "Z", з: "z", И: "I", и: "i", Й: "J", й: "j", К: "K", к: "k",
  Л: "L", л: "l", М: "M", м: "m", Н: "N", н: "n", О: "O", о: "o",
  П: "P", п: "p", Р: "R", р: "r", С: "S", с: "s", Т: "T", т: "t",
  У: "U", у: "u", Ф: "F", ф: "f", Х: "H", х: "h", Ц: "C", ц: "c",
  Ч: "Ch", ч: "ch", Ш: "Sh", ш: "sh", Щ: "Shch", щ: "shch",
  Ъ: "", ъ: "", Ы: "Y", ы: "y", Ь: "", ь: "", Э: "E", э: "e",
  Ю: "Yu", ю: "yu", Я: "Ya", я: "ya"
}));

const TOP_LEVEL_SEGMENTS = new Map([
  ["Валюта", "Valyuta"],
  ["Звуки", "Zvuki"],
  ["Карты", "Karty"],
  ["Команды для управления токеном", "Komandy dlya upravleniya tokenom"],
  ["Музыка", "Muzyka"],
  ["Окружение", "Okruzhenie"],
  ["Оружие", "Oruzhie"],
  ["Персонажи", "Personazhi"],
  ["Предметы", "Predmety"],
  ["Снаряга", "Snaryaga"],
  ["Состояния", "Sostoyaniya"],
  ["Техника", "Tehnika"],
  ["Травмы", "Travmy"],
  ["Эффекты", "Effekty"],
  ["icons", "icons"],
  ["LOST", "LOST"]
]);

const KNOWN_SEGMENTS = new Map([
  ["Барахло", "Barahlo"],
  ["Броня", "Bronya"],
  ["Детали роботов", "Detali robotov"],
  ["Импланты", "Implanty"],
  ["Литература", "Literatura"],
  ["Медицина", "Medicina"],
  ["Обычное", "Obychnoe"],
  ["Необычный", "Neobychnoe"],
  ["Необычное", "Neobychnoe"],
  ["Редкий", "Redkoe"],
  ["Редкое", "Redkoe"],
  ["Уникальные", "Unikalnye"],
  ["Уникальное", "Unikalnoe"],
  ["Эпический", "Epicheskij"],
  ["Эпическое", "Epicheskoe"],
  ["Пища", "Pisha"],
  ["ХЗ", "HZ"]
]);

const copiedAssets = [];
const missingAssets = [];
const reusedAssets = [];

async function main() {
  const [items, folders] = await Promise.all([
    readLevelDocuments(path.join(OLD_WORLD_ROOT, "data", "items")),
    readLevelDocuments(path.join(OLD_WORLD_ROOT, "data", "folders"))
  ]);
  const folderById = new Map(folders.map(folder => [folder._id, folder]));
  const itemById = new Map();
  for (const item of items) if (item?._id) itemById.set(item._id, item);

  const materials = Array.from(itemById.values())
    .map(item => ({ item, folderPath: getFolderPath(item.folder, folderById) }))
    .filter(entry => entry.folderPath.startsWith("Материалы / "))
    .sort((left, right) => (
      compareRu(left.folderPath, right.folderPath)
      || compareRu(left.item.name, right.item.name)
      || left.item._id.localeCompare(right.item._id)
    ));

  await fs.mkdir(MACRO_OUTPUT_DIR, { recursive: true });
  await fs.mkdir(MODULE_ASSET_OUTPUT_DIR, { recursive: true });

  const recordsByGroup = new Map();
  const includedIds = new Set();
  for (const group of MACRO_GROUPS) {
    const records = [];
    for (const { item, folderPath } of materials.filter(entry => group.match(entry.folderPath))) {
      records.push(await createMigrationRecord(item, folderPath, itemById, {
        maxStack: getMaxStackForGroup(group.key)
      }));
    }
    recordsByGroup.set(group.key, records);
    for (const record of records) includedIds.add(record.id);
  }

  for (const group of MACRO_GROUPS) {
    const records = recordsByGroup.get(group.key);
    const missingReferences = Array.from(collectReferencedIds(records))
      .filter(id => !includedIds.has(id));
    for (const id of missingReferences) {
      const item = itemById.get(id);
      if (!item) continue;
      const folderPath = getFolderPath(item.folder, folderById);
      records.unshift(await createMigrationRecord(item, folderPath, itemById, {
        outputFolderPath: `Внешние зависимости / ${folderPath}`
      }));
      includedIds.add(id);
    }
  }

  let addedDependency = true;
  while (addedDependency) {
    addedDependency = false;
    const missingReferences = Array.from(collectReferencedIds(Array.from(recordsByGroup.values()).flat()))
      .filter(id => !includedIds.has(id));
    for (const id of missingReferences) {
      const item = itemById.get(id);
      if (!item) continue;
      const folderPath = getFolderPath(item.folder, folderById);
      const matchedGroup = MACRO_GROUPS.find(group => group.match(folderPath));
      const group = matchedGroup ?? MACRO_GROUPS.find(entry => entry.key === "secondary") ?? MACRO_GROUPS[0];
      recordsByGroup.get(group.key).unshift(await createMigrationRecord(item, folderPath, itemById, {
        outputFolderPath: matchedGroup ? folderPath : `Внешние зависимости / ${folderPath}`,
        maxStack: getMaxStackForGroup(group.key)
      }));
      includedIds.add(id);
      addedDependency = true;
    }
  }

  for (const group of MACRO_GROUPS) {
    const records = recordsByGroup.get(group.key);
    await fs.writeFile(
      path.join(MACRO_OUTPUT_DIR, group.file),
      buildFoundryMacro(group.label, records),
      "utf8"
    );
  }
  await fs.writeFile(
    path.join(MACRO_OUTPUT_DIR, "00-import-all-materials.js"),
    buildFoundryMacro("00. Import all materials", Array.from(recordsByGroup.values()).flat()),
    "utf8"
  );

  const oneClickMacro = buildOneClickMacro();
  await fs.writeFile(path.join(MACRO_OUTPUT_DIR, "00-ONE-MACRO-IMPORT-ALL-MATERIALS.js"), oneClickMacro, "utf8");
  await fs.writeFile(path.join(MACRO_OUTPUT_DIR, "00-PASTE-INTO-FOUNDRY-MACRO.js"), oneClickMacro, "utf8");

  const loaderMacro = buildLoaderMacro();
  await fs.writeFile(path.join(MACRO_OUTPUT_DIR, "00-run-material-import-menu.js"), loaderMacro, "utf8");
  await fs.writeFile(path.join(MACRO_OUTPUT_DIR, "README.md"), buildReadmeV2(recordsByGroup), "utf8");

  const referencedIds = collectReferencedIds(Array.from(recordsByGroup.values()).flat());
  const selectedIds = new Set(Array.from(recordsByGroup.values()).flat().map(record => record.id));
  const unresolvedReferences = Array.from(referencedIds)
    .filter(id => !selectedIds.has(id))
    .map(id => itemById.get(id))
    .filter(Boolean)
    .map(item => `${item._id}\t${item.name}\t${getFolderPath(item.folder, folderById)}`);

  console.log(`Materials found: ${materials.length}`);
  for (const group of MACRO_GROUPS) console.log(`${group.label}: ${recordsByGroup.get(group.key).length}`);
  console.log(`Copied assets: ${copiedAssets.length}`);
  console.log(`Reused existing system assets: ${reusedAssets.length}`);
  console.log(`Missing assets: ${missingAssets.length}`);
  if (missingAssets.length) console.log(missingAssets.map(entry => `MISSING\t${entry.oldPath}\t${entry.sourcePath}`).join("\n"));
  console.log(`External craft references: ${unresolvedReferences.length}`);
  if (unresolvedReferences.length) console.log(unresolvedReferences.join("\n"));
}

async function readLevelDocuments(location) {
  const db = new ClassicLevel(location, { valueEncoding: "json", createIfMissing: false });
  await db.open();
  const documents = [];
  try {
    for await (const [, value] of db.iterator()) documents.push(value);
  } finally {
    await db.close();
  }
  return documents;
}

function getFolderPath(folderId, folderById) {
  const parts = [];
  const seen = new Set();
  let folder = folderById.get(folderId);
  while (folder && !seen.has(folder._id)) {
    seen.add(folder._id);
    parts.unshift(folder.name);
    folder = folderById.get(folder.folder);
  }
  return parts.join(" / ");
}

async function createMigrationRecord(item, folderPath, itemById, { outputFolderPath = folderPath, maxStack = 5 } = {}) {
  const img = await migrateAssetPath(item.img);
  const oldCraft = item.flags?.["blok-upravleniya"]?.craft ?? null;
  const craft = buildCraftData(item, img, oldCraft, itemById);
  const system = {
    description: extractDescription(item),
    quantity: Math.max(1, toInteger(item.system?.quantity, 1)),
    maxStack,
    itemCategory: getOldItemSection(item),
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
    craft
  };

  return {
    id: item._id,
    name: item.name,
    img,
    folderPath: normalizeMaterialFolderPath(outputFolderPath).split(" / "),
    oldType: item.type,
    oldFolderPath: folderPath,
    oldImg: item.img ?? "",
    system
  };
}

function getMaxStackForGroup(groupKey) {
  return groupKey === "components" ? 3 : 5;
}

function getOldItemSection(item) {
  return String(item.flags?.["custom-item-sections"]?.section ?? "").trim();
}

function convertPoundsToKilograms(value) {
  const pounds = Math.max(0, toNumber(value, 0));
  return roundNumber(pounds * 0.45359237, 3);
}

function extractDescription(item) {
  const description = item.system?.description;
  if (typeof description === "string") return description;
  return String(description?.value ?? "");
}

function normalizeMaterialFolderPath(folderPath) {
  return String(folderPath ?? "").replace("Вторичные мсатериалы", "Вторичные материалы");
}

function buildCraftData(item, migratedImg, oldCraft, itemById) {
  const empty = emptyCraftData();
  const resourceSets = (oldCraft?.resources?.sets ?? [])
    .map(set => ({
      mode: String(set?.mode ?? "ALL"),
      items: (set?.items ?? [])
        .map(resource => normalizeResource(resource, itemById))
        .filter(Boolean)
    }))
    .filter(set => set.items.length);

  if (!resourceSets.length) return empty;

  const recipeVariants = resourceSets.map((set, index) => {
    const recipe = buildRecipeVariant(item, migratedImg, oldCraft, set, index);
    return {
      id: `recipe${index + 1}`,
      name: `Рецепт ${index + 1}`,
      ...recipe,
      disassembly: emptyCraftLayout()
    };
  });

  const first = recipeVariants[0] ?? { nodes: [], links: [], viewport: defaultViewport() };
  return {
    mode: "craft",
    nodes: first.nodes,
    links: first.links,
    viewport: first.viewport,
    disassembly: emptyCraftLayout(),
    recipes: recipeVariants
  };
}

function normalizeResource(resource, itemById) {
  const sourceOldId = String(resource?.uuid ?? "").replace(/^Item\./, "");
  const oldId = OLD_ITEM_ID_ALIASES.get(sourceOldId) ?? sourceOldId;
  if (!oldId) return null;
  const source = itemById.get(oldId);
  return {
    oldId,
    name: String(resource?.name ?? source?.name ?? oldId),
    img: source?.img ? assetPathPreview(source.img) : assetPathPreview(resource?.img ?? ""),
    quantity: Math.max(1, toInteger(resource?.qty ?? resource?.quantity, 1))
  };
}

function buildRecipeVariant(item, migratedImg, oldCraft, set, index) {
  const resources = set.items;
  const blockId = resources.length > 1 ? `block-${index + 1}-resources` : "";
  const blockLimit = set.mode === "ONE_OF" ? 1 : null;
  const nodes = [
    {
      id: "root",
      itemUuid: `Item.${item._id}`,
      name: item.name,
      img: migratedImg,
      type: "gear",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      quantity: Math.max(1, toInteger(oldCraft?.resultQty ?? item.system?.quantity, 1)),
      blockId: "",
      blockLimit: null,
      root: true
    },
    ...layoutResourceNodes(resources, blockId, blockLimit)
  ];

  const check = chooseCraftCheck(oldCraft);
  const firstResourceNode = nodes.find(node => !node.root);
  const links = firstResourceNode
    ? [{
      id: `link-recipe${index + 1}-resources-root`,
      fromNodeId: firstResourceNode.id,
      toNodeId: "root",
      skillKey: check.skillKey,
      difficulty: check.difficulty,
      noCheck: check.noCheck,
      bendX: null,
      bendY: null,
      fromAnchorSide: "bottom",
      fromAnchorOffset: 0.5,
      toAnchorSide: "top",
      toAnchorOffset: 0.5
    }]
    : [];

  return {
    nodes,
    links,
    viewport: defaultViewport()
  };
}

function layoutResourceNodes(resources, blockId, blockLimit) {
  const columns = Math.min(5, Math.max(1, resources.length));
  const rows = Math.ceil(resources.length / columns);
  return resources.map((resource, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const countInRow = row === rows - 1 ? resources.length - (row * columns) : columns;
    const x = column - ((countInRow - 1) / 2);
    const y = -3 - (rows - 1 - row);
    return {
      id: `node-${resource.oldId}-${index + 1}`,
      itemUuid: `Item.${resource.oldId}`,
      name: resource.name,
      img: resource.img,
      type: "gear",
      x,
      y,
      width: 1,
      height: 1,
      quantity: resource.quantity,
      blockId,
      blockLimit,
      root: false
    };
  });
}

function chooseCraftCheck(oldCraft) {
  for (const set of oldCraft?.difficultySets?.sets ?? []) {
    for (const skill of set?.skills ?? []) {
      const skillKey = mapOldSkill(skill?.id, skill?.name);
      if (!skillKey) continue;
      return {
        skillKey,
        difficulty: Math.max(0, toInteger(skill?.dc ?? set?.dc, 60)),
        noCheck: false
      };
    }
  }
  return {
    skillKey: "repair",
    difficulty: 0,
    noCheck: true
  };
}

function mapOldSkill(id, name) {
  const mapped = OLD_SKILL_MAP.get(String(id ?? "").trim());
  if (mapped) return mapped;
  const text = String(name ?? "").toLocaleLowerCase("ru");
  if (text.includes("ремонт") || text.includes("крафт")) return "repair";
  if (text.includes("доктор") || text.includes("мед")) return "doctor";
  if (text.includes("натуралист") || text.includes("выжив")) return "naturalist";
  if (text.includes("наука") || text.includes("техника")) return "science";
  return "repair";
}

function emptyCraftData() {
  return {
    mode: "craft",
    nodes: [],
    links: [],
    viewport: defaultViewport(),
    disassembly: emptyCraftLayout(),
    recipes: []
  };
}

function emptyCraftLayout() {
  return {
    nodes: [],
    links: [],
    viewport: defaultViewport()
  };
}

function defaultViewport() {
  return { x: 0, y: 0, zoom: 1 };
}

async function migrateAssetPath(rawPath) {
  const oldPath = String(rawPath ?? "").trim();
  if (!oldPath) return "icons/svg/item-bag.svg";
  const decoded = decodePath(oldPath);
  if (decoded.startsWith("icons/") || decoded.startsWith("systems/")) return encodeFoundryPath(decoded);
  if (decoded.startsWith("modules/kctg-5e-fallout/images/")) {
    const fileName = decoded.slice("modules/kctg-5e-fallout/images/".length);
    const sourcePath = path.join(downloadsDataRoot, "modules", "kctg-5e-fallout", "images", fileName);
    const destinationPath = path.join(MODULE_ASSET_OUTPUT_DIR, fileName);
    await copyAssetIfNeeded(sourcePath, destinationPath, oldPath);
    return encodeFoundryPath(`${SYSTEM_ASSET_PREFIX}/assets/Materialy/kctg-5e-fallout/${fileName}`);
  }

  if (decoded.startsWith("Своё/")) {
    const sourceSegments = decoded.split("/");
    const migratedSegments = sourceSegments.slice(1).map((segment, index) => migrateSystemAssetSegment(segment, index));
    const destinationPath = path.join(systemRoot, "assets", ...migratedSegments);
    if (fsSync.existsSync(destinationPath)) {
      reusedAssets.push({ oldPath, destinationPath });
      return encodeFoundryPath(`${SYSTEM_ASSET_PREFIX}/assets/${migratedSegments.join("/")}`);
    }

    const sourcePath = path.join(downloadsDataRoot, ...sourceSegments);
    await copyAssetIfNeeded(sourcePath, destinationPath, oldPath);
    return encodeFoundryPath(`${SYSTEM_ASSET_PREFIX}/assets/${migratedSegments.join("/")}`);
  }

  return encodeFoundryPath(decoded);
}

function assetPathPreview(rawPath) {
  const decoded = decodePath(String(rawPath ?? ""));
  if (decoded.startsWith("modules/kctg-5e-fallout/images/")) {
    const fileName = decoded.slice("modules/kctg-5e-fallout/images/".length);
    return encodeFoundryPath(`${SYSTEM_ASSET_PREFIX}/assets/Materialy/kctg-5e-fallout/${fileName}`);
  }
  if (decoded.startsWith("Своё/")) {
    const segments = decoded.split("/").slice(1).map((segment, index) => migrateSystemAssetSegment(segment, index));
    return encodeFoundryPath(`${SYSTEM_ASSET_PREFIX}/assets/${segments.join("/")}`);
  }
  return encodeFoundryPath(decoded || "icons/svg/item-bag.svg");
}

async function copyAssetIfNeeded(sourcePath, destinationPath, oldPath) {
  if (fsSync.existsSync(destinationPath)) {
    reusedAssets.push({ oldPath, destinationPath });
    return;
  }
  if (!fsSync.existsSync(sourcePath)) {
    missingAssets.push({ oldPath, sourcePath });
    return;
  }
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.copyFile(sourcePath, destinationPath);
  copiedAssets.push({ oldPath, sourcePath, destinationPath });
}

function migrateSystemAssetSegment(segment, index) {
  if (index === 0 && TOP_LEVEL_SEGMENTS.has(segment)) return TOP_LEVEL_SEGMENTS.get(segment);
  if (KNOWN_SEGMENTS.has(segment)) return KNOWN_SEGMENTS.get(segment);
  return transliterateSegment(segment);
}

function transliterateSegment(segment) {
  return String(segment ?? "")
    .split("")
    .map(character => CYRILLIC.get(character) ?? character)
    .join("")
    .replace(/[«»“”„]/g, "")
    .replace(/[']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function encodeFoundryPath(foundryPath) {
  return String(foundryPath ?? "")
    .split("/")
    .map(segment => encodeURIComponent(segment).replace(/%5B/g, "[").replace(/%5D/g, "]"))
    .join("/");
}

function decodePath(value) {
  try {
    return decodeURIComponent(String(value ?? ""));
  } catch (_error) {
    return String(value ?? "");
  }
}

function collectReferencedIds(records) {
  const ids = new Set();
  for (const record of records) {
    for (const recipe of record.system?.craft?.recipes ?? []) {
      for (const node of recipe.nodes ?? []) {
        const oldId = String(node.itemUuid ?? "").replace(/^Item\./, "");
        if (oldId && oldId !== record.id) ids.add(oldId);
      }
    }
  }
  return ids;
}

function buildFoundryMacro(label, records) {
  return `// Generated by systems/fallout-maw/scripts/generate-material-migration.mjs
// ${label}

const MATERIALS = ${JSON.stringify(records, null, 2)};

const SYSTEM_ID = "fallout-maw";
const ROOT_FOLDER = "MAW Импорт материалов";
const FLAG_SCOPE = "fallout-maw";
const FLAG_KEY = "materialMigration";
const CATEGORY_LABELS = Array.from(new Set(MATERIALS
  .map(entry => String(entry.system?.itemCategory ?? "").trim())
  .filter(Boolean)));

const EMPTY_CRAFT = {
  mode: "craft",
  nodes: [],
  links: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  disassembly: { nodes: [], links: [], viewport: { x: 0, y: 0, zoom: 1 } },
  recipes: []
};

const missingReferences = new Set();

await runMaterialImport();

async function runMaterialImport() {
  if (game.system.id !== SYSTEM_ID) {
    ui.notifications.error("Этот макрос рассчитан на систему fallout-maw.");
    return;
  }

  await ensureItemCategories(CATEGORY_LABELS);

  const touched = [];
  const idMap = new Map();
  for (const entry of MATERIALS) {
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

  const suffix = missingReferences.size
    ? \` Есть отсутствующие ссылки крафта: \${Array.from(missingReferences).join(", ")}.\`
    : "";
  ui.notifications.info(\`${label}: обработано \${touched.length}.\${suffix}\`);
  console.log("${label}", { touched: touched.length, missingReferences: Array.from(missingReferences) });
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
  const byId = game.items.get(entry.id);
  if (byId?.name === entry.name) return byId;
  return null;
}

function resolveImportedItemId(oldId, idMap) {
  if (idMap.has(oldId)) return idMap.get(oldId);
  const byFlag = game.items.find(item => item.getFlag(FLAG_SCOPE, FLAG_KEY)?.oldId === oldId);
  if (byFlag) return byFlag.id;
  const byId = game.items.get(oldId);
  if (byId) return byId.id;
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
    node.itemUuid = \`Item.\${node.root ? selfId : resolveImportedItemId(oldId, idMap)}\`;
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

async function ensureItemCategories(labels) {
  try {
    const settings = foundry.utils.deepClone(game.settings.get(SYSTEM_ID, "itemCategories") ?? { categories: [] });
    settings.categories ??= [];
    const existing = new Set(settings.categories.map(category => String(category.label ?? "")));
    for (const label of labels) {
      if (!label || existing.has(label)) continue;
      settings.categories.push({ label });
      existing.add(label);
    }
    await game.settings.set(SYSTEM_ID, "itemCategories", settings);
  } catch (error) {
    console.warn("Не удалось обновить категории предметов.", error);
  }
}
`;
}

function buildReadme(recordsByGroup) {
  const counts = Object.fromEntries(MACRO_GROUPS.map(group => [group.file, recordsByGroup.get(group.key)?.length ?? 0]));
  const dependencyCounts = Object.fromEntries(MACRO_GROUPS.map(group => [
    group.file,
    (recordsByGroup.get(group.key) ?? []).filter(record => record.folderPath?.[0] === "Внешние зависимости").length
  ]));
  return `# Макросы миграции материалов

Запускать внутри мира \`fallout\` на системе \`fallout-maw\`, по порядку.

В окно редактирования макроса Foundry нужно вставлять не имя файла, а содержимое файла \`00-PASTE-INTO-FOUNDRY-MACRO.js\`. Это короткий макрос-меню: он показывает кнопки и сам подгружает большие файлы из системы.

1. \`01-import-primary-materials.js\` - первичные материалы (${counts["01-import-primary-materials.js"]}).
2. \`02-import-secondary-materials.js\` - вторичные материалы (${counts["02-import-secondary-materials.js"] - dependencyCounts["02-import-secondary-materials.js"]}) и внешние зависимости (${dependencyCounts["02-import-secondary-materials.js"]}).
3. \`03-import-material-components.js\` - компоненты материалов (${counts["03-import-material-components.js"]}).

Макросы создают/обновляют мировые предметы \`gear\`, сохраняют старый id в флаге \`fallout-maw.materialMigration.oldId\`, добавляют категорию \`Материалы\` и строят крафтовые графы с выходным предметом в центре и блоком требований над ним.
`;
}

function buildReadmeV2(recordsByGroup) {
  const counts = Object.fromEntries(MACRO_GROUPS.map(group => [group.file, recordsByGroup.get(group.key)?.length ?? 0]));
  const dependencyCounts = Object.fromEntries(MACRO_GROUPS.map(group => [
    group.file,
    (recordsByGroup.get(group.key) ?? []).filter(record => record.folderPath?.[0] !== String(record.oldFolderPath ?? "").split(" / ")[0]).length
  ]));
  return `# Fallout-MaW material migration

Use one Foundry script macro: \`00-PASTE-INTO-FOUNDRY-MACRO.js\`.

That macro loads \`00-import-all-materials.js\`, so all item ids are known before craft links are rewritten.

Import contents:

1. \`01-import-primary-materials.js\` - primary materials (${counts["01-import-primary-materials.js"]}).
2. \`02-import-secondary-materials.js\` - secondary materials (${counts["02-import-secondary-materials.js"] - dependencyCounts["02-import-secondary-materials.js"]}) and external dependencies (${dependencyCounts["02-import-secondary-materials.js"]}).
3. \`03-import-material-components.js\` - material components (${counts["03-import-material-components.js"]}).

The macro creates or updates world \`gear\` items, keeps the old id in \`fallout-maw.materialMigration.oldId\`, adds the material category, and rebuilds craft graphs with the output item in the center and the requirement block above it.

\`00-run-material-import-menu.js\` is only a debug launcher.
`;
}

function buildOneClickMacro() {
  return `// Fallout-MaW material migration: one Foundry macro.
// Paste this whole script into a single Foundry script macro and run it once.
// The large importer files stay in the system folder and are loaded by this macro.

const SYSTEM_ID = "fallout-maw";
const BASE_PATH = "systems/fallout-maw/scripts/migration-macros/materials";
const MATERIAL_IMPORT_FILES = [
  "00-import-all-materials.js"
];

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

if (game.system.id !== SYSTEM_ID) {
  ui.notifications.error("This migration macro is only for the fallout-maw system.");
  return;
}

ui.notifications.info("Fallout-MaW material import started.");

for (const file of MATERIAL_IMPORT_FILES) {
  const url = \`\${BASE_PATH}/\${file}\`;
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(\`Could not load \${url}: HTTP \${response.status}\`);
  const code = await response.text();
  await new AsyncFunction(code)();
}

ui.notifications.info("Fallout-MaW material import finished.");
`;
}

function buildLoaderMacro() {
  return `// Small launcher for the generated material migration macros.
// It fetches the large generated scripts from the fallout-maw system folder.

const MATERIAL_IMPORT_STEPS = [
  {
    action: "primary",
    label: "01. Первичные материалы",
    file: "01-import-primary-materials.js"
  },
  {
    action: "secondary",
    label: "02. Вторичные материалы",
    file: "02-import-secondary-materials.js"
  },
  {
    action: "components",
    label: "03. Компоненты материалов",
    file: "03-import-material-components.js"
  }
];

const BASE_PATH = "systems/fallout-maw/scripts/migration-macros/materials";
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const DialogV2 = foundry.applications.api.DialogV2;

const action = await DialogV2.wait({
  window: { title: "Импорт материалов Fallout-MaW" },
  content: "<p>Запускай шаги по порядку. Повторный запуск обновляет уже созданные предметы по флагу миграции.</p>",
  buttons: MATERIAL_IMPORT_STEPS.map((step, index) => ({
    action: step.action,
    label: step.label,
    icon: index === 0 ? "fa-solid fa-seedling" : index === 1 ? "fa-solid fa-cubes-stacked" : "fa-solid fa-gears",
    default: index === 0
  })),
  rejectClose: false,
  position: { width: 420 }
});

const step = MATERIAL_IMPORT_STEPS.find(entry => entry.action === action);
if (step) await runMaterialImportStep(step);

async function runMaterialImportStep(step) {
  const url = \`\${BASE_PATH}/\${step.file}\`;
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(\`Не удалось загрузить \${url}: HTTP \${response.status}\`);
  const code = await response.text();
  await new AsyncFunction(code)();
}
`;
}

function toInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundNumber(value, digits = 3) {
  const factor = 10 ** Math.max(0, toInteger(digits, 0));
  return Math.round((Number(value) || 0) * factor) / factor;
}

function compareRu(left, right) {
  return String(left ?? "").localeCompare(String(right ?? ""), "ru");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
