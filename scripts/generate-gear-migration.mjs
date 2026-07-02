import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCraftData,
  collectReferencedIds,
  compareRu,
  convertPoundsToKilograms,
  extractCraftItemOldId,
  extractDescription,
  getFolderPath,
  getOldItemSection,
  migrateAssetPath,
  readLevelDocuments,
  toInteger,
  toNumber
} from "./generate-material-migration.mjs";
import {
  buildConditionFunction,
  buildRangedConditionLossByRarity,
  parseAmmoDamageSource,
  parseConstructPartMigration,
  parseEquipmentMigration,
  parseGearDescription,
  parseModuleMigration,
  parseWeaponMigration,
  resolveConstructPartFolderPath,
  resolveAmmoFolderPath,
  resolveEquipmentFolderPath,
  resolveModuleFolderPath,
  resolveWeaponFolderPath,
  stripGearHtml
} from "./gear-description-parser.mjs";
import { ENSURE_ITEM_CATEGORIES_MACRO } from "./migration-item-categories.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const systemRoot = path.resolve(__dirname, "..");
const dataRoot = path.resolve(systemRoot, "..", "..");
const OLD_WORLD_ROOT = path.join(dataRoot, "fallout-old");
const MACRO_ROOT = path.join(systemRoot, "scripts", "migration-macros");

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

/** Удалённые из мира ингредиенты — вырезаются из рецептов при миграции. */
const DROPPED_CRAFT_INGREDIENT_IDS = new Set([
  "1cnBzk5tajqe2siL",
  "7jWUyBXsYRS6zPi6",
  "tfAFi5t6QQDLixJ4",
  "wcmujnCWRoYptryv"
]);

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

const GEAR_CATEGORIES = {
  ammo: {
    folderPrefix: "Боеприпасы",
    rootFolder: "MAW Импорт боеприпасов",
    macroDir: "ammo",
    macroFile: "01-import-ammo-items.js",
    flagKey: "ammoMigration",
    importLabel: "боеприпасов",
    itemCategoryFallback: "Боеприпасы",
    resolveMaxStack: item => Math.max(1, toInteger(item.system?.quantity, 50))
  },
  weapon: {
    folderPrefix: "Оружие",
    rootFolder: "MAW Импорт оружия",
    macroDir: "weapons",
    macroFile: "01-import-weapon-items.js",
    flagKey: "weaponMigration",
    importLabel: "оружия",
    itemCategoryFallback: "Оружие",
    resolveMaxStack: () => 1
  },
  module: {
    folderPrefix: "Модули на оружие",
    rootFolder: "MAW Импорт модулей",
    macroDir: "modules",
    macroFile: "01-import-module-items.js",
    flagKey: "moduleMigration",
    importLabel: "модулей",
    itemCategoryFallback: "Модули на оружие",
    resolveMaxStack: () => 1
  },
  equipment: {
    folderPrefix: "Снаряжение",
    rootFolder: "MAW Импорт снаряжения",
    macroDir: "equipment",
    macroFile: "01-import-equipment-items.js",
    flagKey: "equipmentMigration",
    importLabel: "снаряжения",
    itemCategoryFallback: "Снаряжение",
    resolveMaxStack: () => 1
  },
  constructParts: {
    folderPrefix: "Детали роботов",
    rootFolder: "MAW Импорт деталей конструктов",
    macroDir: "construct-parts",
    macroFile: "01-import-construct-part-items.js",
    flagKey: "constructPartMigration",
    importLabel: "деталей конструктов",
    itemCategoryFallback: "Детали роботов",
    resolveMaxStack: () => 1
  }
};

async function main() {
  const requested = process.argv.slice(2).filter(Boolean);
  const categories = requested.length
    ? requested.map(key => {
      const config = GEAR_CATEGORIES[key];
      if (!config) throw new Error(`Unknown gear category "${key}". Use: ${Object.keys(GEAR_CATEGORIES).join(", ")}`);
      return [key, config];
    })
    : Object.entries(GEAR_CATEGORIES);

  const [items, folders] = await Promise.all([
    readLevelDocuments(path.join(OLD_WORLD_ROOT, "data", "items")),
    readLevelDocuments(path.join(OLD_WORLD_ROOT, "data", "folders"))
  ]);
  const folderById = new Map(folders.map(folder => [folder._id, folder]));
  const itemById = new Map(items.filter(item => item?._id).map(item => [item._id, item]));
  const ammoByCaliber = buildAmmoCaliberIndex(items, folderById);
  const rarityConditionLossByRarity = buildRangedConditionLossByRarity(
    items
      .filter(item => {
        const folderPath = getFolderPath(item.folder, folderById);
        return folderPath === "Оружие" || folderPath.startsWith("Оружие /");
      })
      .map(item => stripGearHtml(extractDescription(item)).replace(/\s+/g, " "))
  );

  for (const [key, config] of categories) {
    await generateCategoryMigration(key, config, items, folderById, itemById, ammoByCaliber, rarityConditionLossByRarity);
  }

  if (!requested.length || requested.length === Object.keys(GEAR_CATEGORIES).length) {
    await writeCombinedImportMacro();
  }
}

async function generateCategoryMigration(key, config, items, folderById, itemById, ammoByCaliber, rarityConditionLossByRarity) {
  const candidates = filterGearMigrationCandidates(key, items
    .map(item => ({
      item,
      folderPath: getFolderPath(item.folder, folderById)
    }))
    .filter(entry => matchesFolderPrefix(entry.folderPath, config.folderPrefix))
    .sort((left, right) => (
      compareRu(left.folderPath, right.folderPath)
      || compareRu(left.item.name, right.item.name)
      || left.item._id.localeCompare(right.item._id)
    )));

  const macroOutputDir = path.join(MACRO_ROOT, config.macroDir);
  await fs.mkdir(macroOutputDir, { recursive: true });

  const records = [];
  const parseWarnings = [];
  for (const entry of candidates) {
    const record = await createGearMigrationRecord(
      entry.item,
      entry.folderPath,
      key,
      config,
      itemById,
      ammoByCaliber,
      rarityConditionLossByRarity
    );
    records.push(record);
    if (record.parseWarnings?.length) {
      parseWarnings.push(`${record.id}\t${record.name}\t${record.parseWarnings.join("; ")}`);
    }
  }

  records.sort((left, right) => (
    compareRu(left.folderPath.join(" / "), right.folderPath.join(" / "))
    || compareRu(left.name, right.name)
    || left.id.localeCompare(right.id)
  ));

  const craftReferenceNames = buildCraftReferenceNames(records, itemById);
  const gearRecordIds = new Set(records.map(record => record.id));
  const unresolvedReferences = Array.from(collectReferencedIds(records))
    .filter(id => !canResolveGearCraftReference(id, itemById, gearRecordIds))
    .map(id => `${id}\t(не разрешено)`);

  const buildStamp = new Date().toISOString();
  await fs.writeFile(
    path.join(macroOutputDir, config.macroFile),
    buildGearMacro(config, records, craftReferenceNames, buildStamp),
    "utf8"
  );
  await fs.writeFile(
    path.join(macroOutputDir, "README.md"),
    buildReadme(config, records.length, buildStamp),
    "utf8"
  );
  await fs.writeFile(
    path.join(macroOutputDir, "00-PASTE-INTO-FOUNDRY-MACRO.js"),
    buildPasteMacro(config),
    "utf8"
  );

  if (unresolvedReferences.length) {
    await fs.writeFile(
      path.join(macroOutputDir, "unresolved-craft-refs.txt"),
      unresolvedReferences.join("\n"),
      "utf8"
    );
  } else {
    await fs.rm(path.join(macroOutputDir, "unresolved-craft-refs.txt"), { force: true });
  }

  if (parseWarnings.length) {
    await fs.writeFile(
      path.join(macroOutputDir, "parse-warnings.txt"),
      parseWarnings.join("\n"),
      "utf8"
    );
  } else {
    await fs.rm(path.join(macroOutputDir, "parse-warnings.txt"), { force: true });
  }

  console.log(`[${key}] items: ${records.length}`);
  console.log(`[${key}] parse warnings: ${parseWarnings.length}`);
  console.log(`[${key}] craft lookup names: ${Object.keys(craftReferenceNames).length}`);
  console.log(`[${key}] unresolved craft refs: ${unresolvedReferences.length}`);
  console.log(`[${key}] macro: ${path.join(macroOutputDir, config.macroFile)}`);
}

function filterGearMigrationCandidates(categoryKey, candidates) {
  if (categoryKey !== "constructParts") return candidates;

  const embeddedWeaponFolder = "Детали роботов / ВСТРОЕННОЕ ОРУЖИЕ";
  const referencedWeaponIds = new Set();
  for (const { item, folderPath } of candidates) {
    if (folderPath === embeddedWeaponFolder) continue;
    const weaponId = String(extractDescription(item) ?? "").match(/@UUID\[Item\.([A-Za-z0-9]+)\]/i)?.[1] ?? "";
    if (weaponId) referencedWeaponIds.add(weaponId);
  }

  return candidates.filter(({ item, folderPath }) => (
    folderPath !== embeddedWeaponFolder || !referencedWeaponIds.has(item._id)
  ));
}

function normalizeConstructPartWeaponSetLabel(name = "") {
  return String(name ?? "").trim().replace(/^Атака\s*-\s*/i, "");
}

async function createGearMigrationRecord(item, folderPath, categoryKey, config, itemById, ammoByCaliber, rarityConditionLossByRarity) {
  const img = await migrateAssetPath(item.img);
  const description = extractDescription(item);
  const parsedGear = parseGearDescription(description);
  const parseWarnings = [];
  const oldCraftRaw = item.flags?.["blok-upravleniya"]?.craft ?? null;
  const oldCraft = sanitizeOldCraftForGearMigration(oldCraftRaw, itemById);

  let folderParts = [];
  let functions = {};
  let occupiedSlots = {};
  let occupiedSlotMode = "all";
  let weaponSlotRequirement = { mode: "oneOf", slots: {} };

  if (categoryKey === "ammo") {
    const damageSource = parseAmmoDamageSource(description, item.name);
    if (!damageSource) parseWarnings.push("не удалось распарсить источник урона");
    folderParts = resolveAmmoFolderPath(folderPath, parsedGear);
    functions = {
      damageSource: damageSource ?? { enabled: true, name: item.name }
    };
  } else if (categoryKey === "weapon") {
    const magazineSourceOldIds = parsedGear?.caliberKey
      ? (ammoByCaliber.get(parsedGear.caliberKey) ?? [])
      : [];
    if (parsedGear?.caliberKey && !magazineSourceOldIds.length) {
      parseWarnings.push(`нет патронов для калибра ${parsedGear.caliberKey}`);
    }
    const weaponData = parseWeaponMigration(description, item.name, { magazineSourceOldIds, rarityConditionLossByRarity });
    parseWarnings.push(...weaponData.warnings);
    folderParts = resolveWeaponFolderPath(folderPath, weaponData.parsedGear ?? parsedGear);
    const additionalWeapons = Object.fromEntries(
      weaponData.additionalWeapons.map(entry => [entry.id, entry])
    );
    if (weaponData.primary?.moduleSlots?.length) {
      for (const slot of weaponData.primary.moduleSlots) {
        if (slot?.itemData && !slot.itemData.img) slot.itemData.img = img;
      }
    }
    functions = {
      weapon: weaponData.primary,
      additionalWeapons,
      condition: buildConditionFunction(weaponData.parsedGear ?? parsedGear)
    };
    occupiedSlots = {};
    occupiedSlotMode = "all";
    weaponSlotRequirement = weaponData.weaponSlotRequirement ?? { mode: "oneOf", slots: {} };
  } else if (categoryKey === "module") {
    const blockGear = parseGearDescription(description.split(/———+/)[1] ?? description);
    const caliberKey = blockGear?.caliberKey ?? parsedGear?.caliberKey;
    const magazineSourceOldIds = caliberKey ? (ammoByCaliber.get(caliberKey) ?? []) : [];
    const moduleData = parseModuleMigration(description, item.name, { magazineSourceOldIds });
    parseWarnings.push(...moduleData.warnings);
    folderParts = resolveModuleFolderPath(folderPath, moduleData.parsedGear ?? parsedGear);
    functions = {
      module: moduleData.module,
      condition: moduleData.condition?.enabled === false ? undefined : moduleData.condition
    };
    if (moduleData.lightSource) functions.lightSource = moduleData.lightSource;
    if (!functions.condition) delete functions.condition;
    occupiedSlots = {};
    occupiedSlotMode = "all";
    weaponSlotRequirement = { mode: "oneOf", slots: {} };
  } else if (categoryKey === "constructParts") {
    const constructData = parseConstructPartMigration(description, item.name);
    if (item.type === "weapon") {
      constructData.damageMitigation = { enabled: false, mode: "resistance", limbSetIds: [], entries: {} };
      constructData.freeSettings = { enabled: false, useConditionWeakening: false, entries: [] };
    }
    if (!constructData.parsedGear?.repairDifficulty) parseWarnings.push("нет сложности ремонта");
    if (!constructData.parsedGear?.partClass) parseWarnings.push("нет класса деталей");
    folderParts = resolveConstructPartFolderPath(folderPath);
    functions = {
      condition: buildConditionFunction(constructData.parsedGear ?? parsedGear),
      constructPart: constructData.constructPart,
      damageMitigation: constructData.damageMitigation,
      freeSettings: constructData.freeSettings
    };

    const weaponItem = constructData.weaponOldId ? itemById.get(constructData.weaponOldId) : null;
    if (constructData.weaponOldId && !weaponItem) {
      parseWarnings.push(`не найдено встроенное оружие ${constructData.weaponOldId}`);
    }
    const weaponSourceItem = weaponItem ?? (item.type === "weapon" ? item : null);
    if (weaponSourceItem) {
      const weaponDescription = extractDescription(weaponSourceItem);
      const weaponParsedGear = parseGearDescription(weaponDescription);
      const magazineSourceOldIds = weaponParsedGear?.caliberKey
        ? (ammoByCaliber.get(weaponParsedGear.caliberKey) ?? [])
        : [];
      if (weaponParsedGear?.caliberKey && !magazineSourceOldIds.length) {
        parseWarnings.push(`нет патронов для калибра ${weaponParsedGear.caliberKey}`);
      }
      const weaponData = parseWeaponMigration(weaponDescription, weaponSourceItem.name, {
        magazineSourceOldIds,
        rarityConditionLossByRarity
      });
      parseWarnings.push(...weaponData.warnings.map(warning => `оружие: ${warning}`));
      if (weaponData.primary?.moduleSlots?.length) {
        for (const slot of weaponData.primary.moduleSlots) {
          if (slot?.itemData && !slot.itemData.img) slot.itemData.img = img;
        }
      }
      functions.weapon = weaponData.primary;
      functions.additionalWeapons = Object.fromEntries(
        weaponData.additionalWeapons.map(entry => [entry.id, entry])
      );
      functions.constructPart.weaponSets = [{
        id: `weapon-${weaponSourceItem._id}`,
        label: normalizeConstructPartWeaponSetLabel(weaponSourceItem.name),
        quantity: 1
      }];
      weaponSlotRequirement = weaponData.weaponSlotRequirement ?? { mode: "oneOf", slots: {} };
    }

    if (!functions.damageMitigation?.enabled) delete functions.damageMitigation;
    if (!functions.freeSettings?.enabled) delete functions.freeSettings;
    occupiedSlots = {};
    occupiedSlotMode = "all";
  } else {
    const equipmentData = parseEquipmentMigration(description);
    if (!equipmentData.parsedGear?.repairDifficulty) parseWarnings.push("нет сложности ремонта");
    if (!equipmentData.parsedGear?.partClass) parseWarnings.push("нет класса деталей");
    folderParts = resolveEquipmentFolderPath(folderPath, equipmentData.parsedGear ?? parsedGear);
    functions = {
      condition: buildConditionFunction(equipmentData.parsedGear ?? parsedGear),
      damageMitigation: equipmentData.damageMitigation,
      freeSettings: equipmentData.freeSettings
    };
    if (!functions.damageMitigation?.enabled) delete functions.damageMitigation;
    if (!functions.freeSettings?.enabled) delete functions.freeSettings;
    occupiedSlots = equipmentData.occupiedSlots ?? {};
    occupiedSlotMode = equipmentData.occupiedSlotMode ?? "all";
    weaponSlotRequirement = { mode: "oneOf", slots: {} };
  }

  return {
    id: item._id,
    name: item.name,
    img,
    folderPath: folderParts.filter(Boolean),
    oldType: item.type,
    oldFolderPath: folderPath,
    oldImg: item.img ?? "",
    parseWarnings,
    system: {
      description: "",
      quantity: Math.max(1, toInteger(item.system?.quantity, 1)),
      maxStack: config.resolveMaxStack(item),
      itemCategory: getOldItemSection(item) || config.itemCategoryFallback,
      weight: convertPoundsToKilograms(item.system?.weight?.value ?? item.system?.weight),
      price: Math.max(0, toNumber(item.system?.price?.value ?? item.system?.price, 0)),
      equipped: false,
      locked: false,
      occupiedSlots,
      occupiedSlotMode,
      weaponSlotRequirement,
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
      functions,
      craft: buildCraftData(item, img, oldCraft, itemById)
    }
  };
}

function buildAmmoCaliberIndex(items, folderById) {
  const index = new Map();
  for (const item of items) {
    const folderPath = getFolderPath(item.folder, folderById);
    if (folderPath !== "Боеприпасы" && !folderPath.startsWith("Боеприпасы /")) continue;
    const parsed = parseGearDescription(extractDescription(item));
    const caliberKey = parsed?.caliberKey;
    if (!caliberKey) continue;
    if (!index.has(caliberKey)) index.set(caliberKey, []);
    index.get(caliberKey).push(item._id);
  }
  return index;
}

function matchesFolderPrefix(folderPath, prefix) {
  return folderPath === prefix || folderPath.startsWith(`${prefix} / `);
}

function normalizeGearFolderPath(folderPath, prefix) {
  if (folderPath === prefix) return "";
  const marker = `${prefix} / `;
  return folderPath.startsWith(marker) ? folderPath.slice(marker.length) : folderPath;
}

function buildCraftReferenceNames(records, itemById) {
  const names = {};
  for (const oldId of collectReferencedIds(records)) {
    const resolvedId = resolveGearCraftItemId(oldId);
    const item = itemById.get(resolvedId);
    if (item?.name) names[oldId] = item.name;
  }
  return names;
}

function resolveGearCraftItemId(id) {
  const sourceOldId = extractCraftItemOldId(id);
  const aliased = OLD_ITEM_ID_ALIASES[sourceOldId] ?? sourceOldId;
  if (DROPPED_CRAFT_INGREDIENT_IDS.has(sourceOldId) || DROPPED_CRAFT_INGREDIENT_IDS.has(aliased)) return null;
  return aliased;
}

function canResolveGearCraftReference(id, itemById, gearRecordIds) {
  const resolvedId = resolveGearCraftItemId(id);
  if (!resolvedId) return false;
  if (itemById.has(resolvedId)) return true;
  if (gearRecordIds.has(resolvedId)) return true;
  return false;
}

function sanitizeOldCraftForGearMigration(oldCraft, itemById) {
  if (!oldCraft) return null;
  const next = structuredClone(oldCraft);
  sanitizeOldCraftResourceBlock(next.resources, itemById);
  sanitizeOldCraftResourceBlock(next.failureResources, itemById);
  sanitizeOldCraftResourceBlock(next.disassembly?.outputs, itemById);
  for (const page of next.pages ?? []) {
    sanitizeOldCraftResourceBlock(page.resources, itemById);
    sanitizeOldCraftResourceBlock(page.failureResources, itemById);
    sanitizeOldCraftResourceBlock(page.disassembly?.outputs, itemById);
  }
  return next;
}

function sanitizeOldCraftResourceBlock(block, itemById) {
  for (const set of block?.sets ?? []) {
    set.items = (set.items ?? [])
      .map(resource => sanitizeOldCraftResourceItem(resource, itemById))
      .filter(Boolean);
  }
  if (block?.sets) block.sets = block.sets.filter(set => set.items?.length);
}

function sanitizeOldCraftResourceItem(resource, itemById) {
  const sourceOldId = extractCraftItemOldId(resource?.uuid);
  const resolvedId = resolveGearCraftItemId(sourceOldId);
  if (!resolvedId) return null;
  const source = itemById.get(resolvedId);
  return {
    ...resource,
    uuid: `Item.${resolvedId}`,
    name: String(resource?.name ?? source?.name ?? resolvedId)
  };
}

function buildGearMacro(config, records, craftReferenceNames, buildStamp) {
  const itemsConst = config.macroDir === "ammo"
    ? "AMMO_ITEMS"
    : config.macroDir === "weapons"
      ? "WEAPON_ITEMS"
      : config.macroDir === "construct-parts"
        ? "CONSTRUCT_PART_ITEMS"
        : "EQUIPMENT_ITEMS";
  const runFn = config.macroDir === "ammo"
    ? "runAmmoImport"
    : config.macroDir === "weapons"
      ? "runWeaponImport"
      : config.macroDir === "construct-parts"
        ? "runConstructPartImport"
        : "runEquipmentImport";

  return `// Generated by systems/fallout-maw/scripts/generate-gear-migration.mjs
// ${buildStamp}

const ${itemsConst} = ${JSON.stringify(records, null, 2)};

const SYSTEM_ID = "fallout-maw";
const ROOT_FOLDER = ${JSON.stringify(config.rootFolder)};
const FLAG_SCOPE = "fallout-maw";
const FLAG_KEY = ${JSON.stringify(config.flagKey)};
const OLD_ITEM_ID_ALIASES = ${JSON.stringify(OLD_ITEM_ID_ALIASES)};

function extractCraftItemOldId(uuid) {
  const raw = String(uuid ?? "").trim();
  if (!raw) return "";
  const itemMatch = raw.match(/(?:^|\\.)(Item\\.([A-Za-z0-9]+))$/);
  if (itemMatch) return itemMatch[2];
  return raw.replace(/^Item\\./, "");
}
const CRAFT_REFERENCE_NAMES = ${JSON.stringify(craftReferenceNames, null, 2)};
const ALL_MIGRATION_FLAG_KEYS = ${JSON.stringify(ALL_MIGRATION_FLAG_KEYS)};

const EMPTY_CRAFT = {
  mode: "craft",
  nodes: [],
  links: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  disassembly: { nodes: [], links: [], viewport: { x: 0, y: 0, zoom: 1 } },
  recipes: []
};

const missingReferences = new Set();
await ${runFn}();

async function ${runFn}() {
  if (game.system.id !== SYSTEM_ID) {
    ui.notifications.error("Этот макрос рассчитан на систему fallout-maw.");
    return;
  }

  await ensureItemCategories(Array.from(new Set(${itemsConst}
    .map(entry => String(entry.system?.itemCategory ?? "").trim())
    .filter(Boolean))));

  const touched = [];
  const idMap = new Map();
  for (const entry of ${itemsConst}) {
    const folderId = await ensureFolderPath([ROOT_FOLDER, ...entry.folderPath]);
    const existing = findExistingMigrationItem(entry);
    const previewCraft = rewriteCraftReferences(entry.system.craft, idMap, entry.id);
    const previewSystem = rewriteGearFunctionReferences(entry.system, idMap);
    previewSystem.craft = previewCraft;
    const data = buildItemData(entry, folderId, { system: previewSystem });
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

  let craftErrors = 0;
  for (let craftIndex = 0; craftIndex < touched.length; craftIndex += 1) {
    const { entry, item } = touched[craftIndex];
    try {
      const craft = rewriteCraftReferences(entry.system.craft, idMap, item.id);
      const system = rewriteGearFunctionReferences(entry.system, idMap);
      const updates = { "system.craft": craft };
      if (system.functions?.weapon) updates["system.functions.weapon"] = system.functions.weapon;
      if (system.functions?.additionalWeapons) updates["system.functions.additionalWeapons"] = system.functions.additionalWeapons;
      await item.update(updates);
    } catch (error) {
      craftErrors += 1;
      console.error("${config.flagKey} craft update failed", entry.id, entry.name, error);
    }
    if ((craftIndex + 1) % 50 === 0) {
      ui.notifications.info(\`Импорт ${config.importLabel}: крафты \${craftIndex + 1}/\${touched.length}\`);
    }
  }

  if (missingReferences.size || craftErrors) {
    ui.notifications.warn(\`Импорт ${config.importLabel}: \${touched.length} предметов. Ошибок крафта: \${craftErrors}. Неразрешённых ссылок: \${missingReferences.size}.\`);
    console.warn("${config.flagKey} import", { touched: touched.length, craftErrors, missingReferences: Array.from(missingReferences) });
  } else {
    ui.notifications.info(\`Импорт ${config.importLabel}: \${touched.length} предметов. Крафты применены.\`);
  }
  console.log("${config.flagKey} import", { touched: touched.length, craftErrors, missingReferences: Array.from(missingReferences) });
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

function buildItemData(entry, folderId, { craft, system: systemOverride } = {}) {
  const system = foundry.utils.deepClone(systemOverride ?? entry.system);
  system.craft = foundry.utils.deepClone(craft ?? system.craft ?? EMPTY_CRAFT);
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
  for (const flagKey of ALL_MIGRATION_FLAG_KEYS) {
    const byFlag = game.items.find(item => item.getFlag(FLAG_SCOPE, flagKey)?.oldId === entry.id);
    if (byFlag) return byFlag;
  }
  const byId = game.items.get(entry.id);
  if (byId?.name === entry.name) return byId;
  return null;
}

function resolveAlias(oldId) {
  const sourceOldId = extractCraftItemOldId(oldId);
  return OLD_ITEM_ID_ALIASES[sourceOldId] ?? OLD_ITEM_ID_ALIASES[oldId] ?? sourceOldId;
}

function findItemByName(name) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return null;
  const matches = game.items.filter(item => item.name === trimmed);
  if (!matches.length) return null;
  if (matches.length === 1) return matches[0];
  for (const flagKey of ALL_MIGRATION_FLAG_KEYS) {
    const preferred = matches.find(item => item.getFlag(FLAG_SCOPE, flagKey));
    if (preferred) return preferred;
  }
  return matches[0];
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

function resolveImportedItemId(oldId, idMap, hintName) {
  const sourceOldId = extractCraftItemOldId(oldId);
  const resolvedOldId = resolveAlias(sourceOldId);
  if (idMap.has(resolvedOldId)) return idMap.get(resolvedOldId);
  if (idMap.has(sourceOldId)) return idMap.get(sourceOldId);

  const byMigration = findItemByMigrationOldId(sourceOldId);
  if (byMigration) return byMigration.id;

  const lookupName = hintName || CRAFT_REFERENCE_NAMES[sourceOldId] || CRAFT_REFERENCE_NAMES[oldId] || CRAFT_REFERENCE_NAMES[resolvedOldId];
  const byName = findItemByName(lookupName);
  if (byName) return byName.id;

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
    node.itemUuid = \`Item.\${node.root ? selfId : resolveImportedItemId(oldId, idMap, node.name)}\`;
  }
}

function rewriteGearFunctionReferences(system, idMap) {
  const next = foundry.utils.deepClone(system ?? {});
  rewriteWeaponMagazineSources(next.functions?.weapon, idMap);
  for (const additionalWeapon of Object.values(next.functions?.additionalWeapons ?? {})) {
    rewriteWeaponMagazineSources(additionalWeapon, idMap);
  }
  return next;
}

function rewriteWeaponMagazineSources(weapon, idMap) {
  if (!weapon?.magazine) return;
  const sourceUuids = (weapon.magazine.sourceItemUuids ?? [])
    .map(uuid => {
      const oldId = extractCraftItemOldId(uuid);
      if (!oldId) return uuid;
      return \`Item.\${resolveImportedItemId(oldId, idMap, "")}\`;
    })
    .filter(Boolean);
  weapon.magazine.sourceItemUuids = sourceUuids;
  weapon.magazine.sourceItemUuid = sourceUuids[0] ?? "";
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

function buildReadme(config, itemCount, buildStamp) {
  return `# Макросы миграции: ${config.importLabel}

Сгенерировано: \`${buildStamp}\`

## Быстрый запуск

1. Сначала импортируйте **материалы** (и при необходимости хлам/инструменты).
2. Для оружия и снаряжения рекомендуемый порядок: **боеприпасы → модули → оружие → снаряжение**.
3. Откройте мир на системе \`fallout-maw\`.
4. Создайте макрос типа **Script**.
5. Вставьте содержимое **\`00-PASTE-INTO-FOUNDRY-MACRO.js\`**.
6. Запустите макрос от GM.

## Что импортируется

- ${itemCount} предметов из \`${config.folderPrefix} / …\` старого мира
- Описания не переносятся — характеристики извлекаются парсером
- Включены функции: ${describeFunctions(config)}
${config.flagKey === "moduleMigration" ? "- Модули группируются по **редкости** из старого мира" : "- Оружие группируется по **калибру**, снаряжение — по **типу** (без сортировки по редкости)"}
- Крафты и разборы переносятся из \`flags["blok-upravleniya"].craft\`

## Файлы

- \`00-PASTE-INTO-FOUNDRY-MACRO.js\` — вставляйте это в макрос Foundry
- \`${config.macroFile}\` — данные импорта
`;
}

function describeFunctions(config) {
  if (config.flagKey === "ammoMigration") return "источник урона (из описания)";
  if (config.flagKey === "weaponMigration") return "состояние + оружие с источниками урона по калибру и слотами модулей";
  if (config.flagKey === "moduleMigration") return "модуль оружия (модификаторы, доп. функции, источник света)";
  if (config.flagKey === "constructPartMigration") return "состояние + деталь конструкта + встроенное оружие + сопротивления + бонусы";
  return "состояние + защита";
}

function buildPasteMacro(config) {
  return `// Fallout-MaW ${config.importLabel} migration: one Foundry macro.
// Вставьте весь этот скрипт в один макрос Foundry (Script) и запустите от GM.

const SYSTEM_ID = "fallout-maw";
const BASE_PATH = "systems/fallout-maw/scripts/migration-macros/${config.macroDir}";
const IMPORT_FILE = "${config.macroFile}";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

if (game.system.id !== SYSTEM_ID) {
  ui.notifications.error("Этот макрос рассчитан только на систему fallout-maw.");
  return;
}

ui.notifications.info("Импорт ${config.importLabel}: старт…");

const url = \`\${BASE_PATH}/\${IMPORT_FILE}\`;
const response = await fetch(url, { cache: "no-cache" });
if (!response.ok) throw new Error(\`Не удалось загрузить \${url}: HTTP \${response.status}\`);
const code = await response.text();
await new AsyncFunction(code)();

ui.notifications.info("Импорт ${config.importLabel}: завершён.");
`;
}

async function writeCombinedImportMacro() {
  const combinedDir = path.join(MACRO_ROOT, "gear");
  await fs.mkdir(combinedDir, { recursive: true });

  const steps = [
    { dir: "ammo", file: GEAR_CATEGORIES.ammo.macroFile, label: "боеприпасы" },
    { dir: "modules", file: GEAR_CATEGORIES.module.macroFile, label: "модули" },
    { dir: "weapons", file: GEAR_CATEGORIES.weapon.macroFile, label: "оружие" },
    { dir: "equipment", file: GEAR_CATEGORIES.equipment.macroFile, label: "снаряжение" },
    { dir: "construct-parts", file: GEAR_CATEGORIES.constructParts.macroFile, label: "детали конструктов" }
  ];

  const combinedMacro = `// Fallout-MaW gear migration: ammo → modules → weapons → equipment → construct parts
// Вставьте весь этот скрипт в один макрос Foundry (Script) и запустите от GM.

const SYSTEM_ID = "fallout-maw";
const BASE_PATH = "systems/fallout-maw/scripts/migration-macros";
const STEPS = ${JSON.stringify(steps, null, 2)};

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

if (game.system.id !== SYSTEM_ID) {
  ui.notifications.error("Этот макрос рассчитан только на систему fallout-maw.");
  return;
}

for (const step of STEPS) {
  ui.notifications.info(\`Импорт \${step.label}: старт…\`);
  const url = \`\${BASE_PATH}/\${step.dir}/\${step.file}\`;
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(\`Не удалось загрузить \${url}: HTTP \${response.status}\`);
  const code = await response.text();
  await new AsyncFunction(code)();
  ui.notifications.info(\`Импорт \${step.label}: завершён.\`);
}
`;

  await fs.writeFile(path.join(combinedDir, "00-ONE-MACRO-IMPORT-ALL-GEAR.js"), combinedMacro, "utf8");
  await fs.writeFile(
    path.join(combinedDir, "README.md"),
    `# Миграция оружия, модулей, боеприпасов и снаряжения

Запускайте импорт в порядке: **боеприпасы → модули → оружие → снаряжение**.

- \`00-ONE-MACRO-IMPORT-ALL-GEAR.js\` — один макрос на всё
- или по отдельности из папок \`ammo/\`, \`modules/\`, \`weapons/\`, \`equipment/\`
`,
    "utf8"
  );
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

export {
  GEAR_CATEGORIES,
  generateCategoryMigration,
  createGearMigrationRecord,
  matchesFolderPrefix,
  normalizeGearFolderPath
};
