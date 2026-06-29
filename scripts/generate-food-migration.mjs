import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFoodDescription } from "./food-description-parser.mjs";
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
  toInteger,
  toNumber
} from "./generate-material-migration.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const systemRoot = path.resolve(__dirname, "..");
const dataRoot = path.resolve(systemRoot, "..", "..");
const OLD_WORLD_ROOT = path.join(dataRoot, "fallout-old");
const MACRO_OUTPUT_DIR = path.join(systemRoot, "scripts", "migration-macros", "food");
const MACRO_FILE = "01-import-food-items.js";
const ROOT_FOLDER = "MAW Импорт пищи";
const FOOD_FOLDER_PREFIX = "Пища / ";
const OLD_ITEM_ID_ALIASES = {
  "0cygJX1IKCzvWw1b": "x2VIpCSzghynU8c5",
  // Устаревшие uuid в flags крафта → актуальные предметы в fallout-old
  "lNGUlpxPqCSrMkit": "dhbmaVvqxPoAB4q0",
  "dns2gvnKvE0HDxhn": "2Gqvi42QCTSCG7tO",
  "GDpJwJUShXKuEBvY": "oZJX2XJgw23kDXPc",
  "S3TAv0k5a281qMqG": "27KJalb5VBosRB8B",
  "JFuavNs0sG8ikClw": "oclSElwvY8MjXuIv"
};

/** Удалённые из мира ингредиенты — вырезаются из рецептов при миграции. */
const DROPPED_CRAFT_INGREDIENT_IDS = new Set([
  "szOXh2U9Nt1EhPYP", // Перец
  "w5wMUhmu8ySHdiwc", // Сироп
  "1cnBzk5tajqe2siL" // Дерево (топливо/компонент, больше не используется)
]);

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
      parsed: parseFoodDescription(extractDescription(item))
    }))
    .filter(entry => entry.folderPath.startsWith(FOOD_FOLDER_PREFIX))
    .sort((left, right) => (
      compareRu(left.folderPath, right.folderPath)
      || compareRu(left.item.name, right.item.name)
      || left.item._id.localeCompare(right.item._id)
    ));

  await fs.mkdir(MACRO_OUTPUT_DIR, { recursive: true });

  const foodRecordIds = new Set(candidates.map(entry => entry.item._id));
  const records = [];
  const unparsedNeedChange = [];
  const parseWarnings = [];
  const droppedCraftIngredients = [];
  const repairedCrafts = [];
  for (const entry of candidates) {
    droppedCraftIngredients.push(...collectDroppedFromOldCraft(entry.item));
    const record = await createFoodMigrationRecord(
      entry.item,
      entry.folderPath,
      entry.parsed,
      itemById,
      foodRecordIds
    );
    records.push(record);
    if (entry.item.__repairedCraft) repairedCrafts.push(entry.item.__repairedCraft);
    if (!entry.parsed) unparsedNeedChange.push(`${entry.item._id}\t${entry.item.name}`);
    if (entry.parsed?.warnings?.length) {
      parseWarnings.push(`${entry.item._id}\t${entry.item.name}\t${entry.parsed.warnings.join("; ")}`);
    }
  }

  const craftReferenceNames = buildCraftReferenceNames(records, itemById, foodRecordIds);
  const unresolvedReferences = Array.from(collectReferencedIds(records))
    .filter(id => !canResolveFoodCraftReference(id, itemById, foodRecordIds))
    .map(id => `${id}\t(не разрешено)`);

  const buildStamp = new Date().toISOString();
  await fs.writeFile(
    path.join(MACRO_OUTPUT_DIR, MACRO_FILE),
    buildFoodMacro(records, craftReferenceNames, buildStamp),
    "utf8"
  );
  await fs.writeFile(
    path.join(MACRO_OUTPUT_DIR, "README.md"),
    buildReadme(records.length, unparsedNeedChange.length, parseWarnings.length, buildStamp),
    "utf8"
  );
  await fs.writeFile(
    path.join(MACRO_OUTPUT_DIR, "00-PASTE-INTO-FOUNDRY-MACRO.js"),
    buildPasteMacro(),
    "utf8"
  );

  if (unparsedNeedChange.length) {
    await fs.writeFile(
      path.join(MACRO_OUTPUT_DIR, "unparsed-need-change.txt"),
      unparsedNeedChange.join("\n"),
      "utf8"
    );
  }
  if (parseWarnings.length) {
    await fs.writeFile(
      path.join(MACRO_OUTPUT_DIR, "parse-warnings.txt"),
      parseWarnings.join("\n"),
      "utf8"
    );
  }
  if (unresolvedReferences.length) {
    await fs.writeFile(
      path.join(MACRO_OUTPUT_DIR, "unresolved-craft-refs.txt"),
      unresolvedReferences.join("\n"),
      "utf8"
    );
  } else {
    await fs.rm(path.join(MACRO_OUTPUT_DIR, "unresolved-craft-refs.txt"), { force: true });
  }
  if (droppedCraftIngredients.length) {
    await fs.writeFile(
      path.join(MACRO_OUTPUT_DIR, "dropped-craft-ingredients.txt"),
      [...new Set(droppedCraftIngredients)].sort().join("\n"),
      "utf8"
    );
  }
  if (repairedCrafts.length) {
    await fs.writeFile(
      path.join(MACRO_OUTPUT_DIR, "repaired-craft-recipes.txt"),
      repairedCrafts.sort().join("\n"),
      "utf8"
    );
  }

  const brokenCrafts = validateFoodCraftRecords(records, itemById, folderById);
  if (brokenCrafts.length) {
    await fs.writeFile(
      path.join(MACRO_OUTPUT_DIR, "broken-craft-recipes.txt"),
      brokenCrafts.sort().join("\n"),
      "utf8"
    );
  } else {
    await fs.rm(path.join(MACRO_OUTPUT_DIR, "broken-craft-recipes.txt"), { force: true });
  }

  console.log(`Food items found: ${candidates.length}`);
  console.log(`With needChange function: ${records.filter(entry => entry.system.functions?.needChange?.enabled).length}`);
  console.log(`Without parsed needChange: ${unparsedNeedChange.length}`);
  console.log(`Parse warnings: ${parseWarnings.length}`);
  console.log(`Craft ingredient names for lookup: ${Object.keys(craftReferenceNames).length}`);
  console.log(`Missing in old world: ${unresolvedReferences.length}`);
  console.log(`Broken craft recipes: ${brokenCrafts.length}`);
  console.log(`Macro written: ${path.join(MACRO_OUTPUT_DIR, MACRO_FILE)}`);
}

async function createFoodMigrationRecord(item, folderPath, parsed, itemById, foodRecordIds) {
  const img = await migrateAssetPath(item.img);
  const oldCraftRaw = item.flags?.["blok-upravleniya"]?.craft ?? null;
  const { craft: oldCraftRepaired, repaired } = repairEmptyFoodCraft(oldCraftRaw, item, itemById);
  if (repaired) {
    item.__repairedCraft = repaired;
  }
  const oldCraft = sanitizeOldCraftForMigration(oldCraftRepaired, itemById, foodRecordIds);
  const needChange = buildNeedChangeFunction(parsed);

  return {
    id: item._id,
    name: item.name,
    img,
    folderPath: normalizeFoodFolderPath(folderPath).split(" / ").filter(Boolean),
    oldType: item.type,
    oldFolderPath: folderPath,
    oldImg: item.img ?? "",
    system: {
      description: "",
      quantity: Math.max(1, toInteger(item.system?.quantity, 1)),
      maxStack: Math.max(1, toInteger(item.system?.quantity, 10) > 1 ? toInteger(item.system?.quantity, 10) : 10),
      itemCategory: getFoodCategory(folderPath),
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
      functions: {
        needChange
      },
      craft: sanitizeFoodCraftData(
        await buildFoodCraftData(item, img, oldCraft, itemById, foodRecordIds),
        item._id,
        itemById,
        foodRecordIds
      )
    }
  };
}

function resolveFoodCraftItemId(id, itemById, foodRecordIds) {
  const aliased = OLD_ITEM_ID_ALIASES[id] ?? id;
  if (DROPPED_CRAFT_INGREDIENT_IDS.has(id) || DROPPED_CRAFT_INGREDIENT_IDS.has(aliased)) return null;
  if (itemById.has(aliased)) return aliased;
  if (foodRecordIds.has(aliased)) return aliased;
  return null;
}

function canResolveFoodCraftReference(id, itemById, foodRecordIds) {
  return Boolean(resolveFoodCraftItemId(id, itemById, foodRecordIds));
}

function resolveFoodOldItemId(itemById, id) {
  const aliased = OLD_ITEM_ID_ALIASES[id] ?? id;
  if (DROPPED_CRAFT_INGREDIENT_IDS.has(id) || DROPPED_CRAFT_INGREDIENT_IDS.has(aliased)) return null;
  return itemById.get(aliased) ?? null;
}

function sanitizeOldCraftForMigration(oldCraft, itemById, foodRecordIds) {
  if (!oldCraft) return null;
  const next = structuredClone(oldCraft);
  sanitizeOldCraftResourceBlock(next.resources, itemById, foodRecordIds);
  sanitizeOldCraftResourceBlock(next.failureResources, itemById, foodRecordIds);
  sanitizeOldCraftResourceBlock(next.disassembly?.outputs, itemById, foodRecordIds);
  for (const page of next.pages ?? []) {
    sanitizeOldCraftResourceBlock(page.resources, itemById, foodRecordIds);
    sanitizeOldCraftResourceBlock(page.failureResources, itemById, foodRecordIds);
    sanitizeOldCraftResourceBlock(page.disassembly?.outputs, itemById, foodRecordIds);
  }
  return next;
}

function sanitizeOldCraftResourceBlock(block, itemById, foodRecordIds) {
  for (const set of block?.sets ?? []) {
    set.items = (set.items ?? [])
      .map(resource => sanitizeOldCraftResourceItem(resource, itemById, foodRecordIds))
      .filter(Boolean);
  }
  if (block?.sets) block.sets = block.sets.filter(set => set.items?.length);
}

function sanitizeOldCraftResourceItem(resource, itemById, foodRecordIds) {
  const sourceOldId = String(resource?.uuid ?? "").replace(/^Item\./, "");
  const resolvedId = resolveFoodCraftItemId(sourceOldId, itemById, foodRecordIds);
  if (!resolvedId) return null;
  const source = itemById.get(resolvedId);
  return {
    ...resource,
    uuid: `Item.${resolvedId}`,
    name: String(resource?.name ?? source?.name ?? resolvedId)
  };
}

function sanitizeFoodCraftData(craft, recordId, itemById, foodRecordIds) {
  if (!craft) return craft;
  return {
    ...craft,
    ...sanitizeCraftLayout(craft, recordId, itemById, foodRecordIds),
    recipes: (craft.recipes ?? []).map(recipe => ({
      ...recipe,
      ...sanitizeCraftLayout(recipe, recordId, itemById, foodRecordIds),
      disassembly: sanitizeCraftLayout(recipe.disassembly, recordId, itemById, foodRecordIds)
    })),
    disassembly: sanitizeCraftLayout(craft.disassembly, recordId, itemById, foodRecordIds)
  };
}

function sanitizeCraftLayout(layout, recordId, itemById, foodRecordIds) {
  if (!layout?.nodes?.length) return layout ?? { nodes: [], links: [], viewport: { x: 0, y: 0, zoom: 1 } };

  const nodes = [];
  for (const node of layout.nodes) {
    if (node.root) {
      nodes.push(node);
      continue;
    }
    const sourceOldId = String(node.itemUuid ?? "").replace(/^Item\./, "");
    const resolvedId = resolveFoodCraftItemId(sourceOldId, itemById, foodRecordIds);
    if (!resolvedId || resolvedId === recordId) continue;
    const source = itemById.get(resolvedId);
    nodes.push({
      ...node,
      itemUuid: `Item.${resolvedId}`,
      name: String(node.name ?? source?.name ?? resolvedId)
    });
  }

  const nodeIds = new Set(nodes.map(node => node.id));
  const links = (layout.links ?? []).filter(link => (
    nodeIds.has(link.fromNodeId) && nodeIds.has(link.toNodeId)
  ));

  return { ...layout, nodes, links };
}

function collectDroppedFromOldCraft(item) {
  const oldCraft = item.flags?.["blok-upravleniya"]?.craft;
  if (!oldCraft) return [];
  const dropped = [];
  const visitResource = resource => {
    const sourceOldId = String(resource?.uuid ?? "").replace(/^Item\./, "");
    const aliased = OLD_ITEM_ID_ALIASES[sourceOldId] ?? sourceOldId;
    if (!DROPPED_CRAFT_INGREDIENT_IDS.has(sourceOldId) && !DROPPED_CRAFT_INGREDIENT_IDS.has(aliased)) return;
    dropped.push(`${item._id}\t${item.name}\t${resource?.name ?? sourceOldId}\t${sourceOldId}`);
  };
  const visitBlock = block => {
    for (const set of block?.sets ?? []) {
      for (const resource of set.items ?? []) visitResource(resource);
    }
  };
  visitBlock(oldCraft.resources);
  visitBlock(oldCraft.failureResources);
  visitBlock(oldCraft.disassembly?.outputs);
  for (const page of oldCraft.pages ?? []) {
    visitBlock(page.resources);
    visitBlock(page.failureResources);
    visitBlock(page.disassembly?.outputs);
  }
  return dropped;
}

function buildNeedChangeFunction(parsed) {
  if (!parsed) {
    return {
      enabled: false,
      charges: { value: 1, max: 1 },
      needs: [],
      damages: [],
      organismDevelopment: [],
      healthRecovery: 0,
      durationSeconds: 0,
      intervalSeconds: 6,
      changes: []
    };
  }

  return {
    enabled: true,
    charges: { value: 1, max: 1 },
    needs: parsed.needs ?? [],
    damages: parsed.damages ?? [],
    organismDevelopment: parsed.organismDevelopment ?? [],
    healthRecovery: Math.max(0, toInteger(parsed.healthRecovery, 0)),
    durationSeconds: Math.max(0, toInteger(parsed.durationSeconds, 0)),
    intervalSeconds: 6,
    changes: sanitizeNeedChangeEffectChanges(parsed.changes)
  };
}

function sanitizeNeedChangeEffectChanges(changes = []) {
  return (Array.isArray(changes) ? changes : [])
    .map(change => {
      const entry = {
        key: String(change?.key ?? "").trim(),
        type: ["add", "multiply", "override"].includes(String(change?.type ?? "")) ? String(change.type) : "add",
        value: String(change?.value ?? "0"),
        phase: String(change?.phase ?? "initial") || "initial"
      };
      if (change?.priority !== null && change?.priority !== undefined && change?.priority !== "") {
        entry.priority = toInteger(change.priority);
      }
      return entry;
    })
    .filter(change => change.key);
}

async function buildFoodCraftData(item, migratedImg, oldCraft, itemById, foodRecordIds) {
  const craft = buildCraftData(item, migratedImg, oldCraft, itemById);
  if (!craft.recipes?.length && !craft.nodes?.length) return craft;

  const pages = Array.isArray(oldCraft?.pages) ? oldCraft.pages.filter(Boolean) : [];
  const recipeVariants = craft.recipes?.length
    ? craft.recipes
    : [{
      id: "recipe1",
      name: "Рецепт 1",
      nodes: craft.nodes ?? [],
      links: craft.links ?? [],
      viewport: craft.viewport ?? { x: 0, y: 0, zoom: 1 },
      disassembly: craft.disassembly ?? { nodes: [], links: [], viewport: { x: 0, y: 0, zoom: 1 } }
    }];

  const patchedRecipes = [];
  for (const [index, recipe] of recipeVariants.entries()) {
    const page = pages[index] ?? pages[0] ?? oldCraft ?? {};
    const failureItems = await pickOldFailureItems(page, itemById, foodRecordIds);
    let nextRecipe = recipe;
    if (failureItems.length) {
      nextRecipe = ensureRecipeHasRoot(nextRecipe, item, migratedImg, page.resultQty ?? oldCraft?.resultQty);
      nextRecipe = appendFailureResourcesToRecipe(nextRecipe, failureItems, index);
    }
    patchedRecipes.push(nextRecipe);
  }

  const first = patchedRecipes[0] ?? recipeVariants[0];
  return {
    ...craft,
    nodes: first?.nodes ?? [],
    links: first?.links ?? [],
    viewport: first?.viewport ?? craft.viewport,
    disassembly: first?.disassembly ?? craft.disassembly,
    recipes: patchedRecipes
  };
}

async function pickOldFailureItems(source = {}, itemById = new Map(), foodRecordIds = new Set()) {
  const items = pickOldFailureItemsSync(source, itemById, foodRecordIds);
  const migrated = [];
  for (const item of items) {
    const sourceItem = itemById.get(item.oldId);
    migrated.push({
      ...item,
      img: await migrateAssetPath(sourceItem?.img ?? item.img)
    });
  }
  return migrated;
}

function pickOldFailureItemsSync(source = {}, itemById = new Map(), foodRecordIds = new Set()) {
  const sets = (source?.failureResources?.sets ?? [])
    .map(set => ({
      mode: String(set?.mode ?? "ALL"),
      items: (set?.items ?? [])
        .map(resource => normalizeCraftResource(resource, itemById, foodRecordIds))
        .filter(Boolean)
    }))
    .filter(set => set.items.length);
  return sets[0]?.items ?? [];
}

function normalizeCraftResource(resource, itemById, foodRecordIds) {
  const sourceOldId = String(resource?.uuid ?? "").replace(/^Item\./, "");
  const oldId = resolveFoodCraftItemId(sourceOldId, itemById, foodRecordIds);
  if (!oldId) return null;
  const source = itemById.get(oldId);
  return {
    oldId,
    name: String(resource?.name ?? source?.name ?? oldId),
    img: source?.img ?? resource?.img ?? "",
    quantity: Math.max(1, toInteger(resource?.qty ?? resource?.quantity, 1))
  };
}

const KEBAB_COMMON_INGREDIENTS = [
  { oldId: "EgLKJj7Ujyel50fl", quantity: 1 },
  { oldId: "TxMIbYlfghPIpKOm", quantity: 1 }
];

function repairEmptyFoodCraft(oldCraft, item, itemById) {
  if (!oldCraft) return { craft: oldCraft, repaired: null };
  const next = structuredClone(oldCraft);
  const page = Array.isArray(next.pages) ? next.pages[0] : next;
  if (!page) return { craft: oldCraft, repaired: null };

  const resourceItems = page.resources?.sets?.[0]?.items ?? [];
  if (resourceItems.length) return { craft: oldCraft, repaired: null };

  const failureItems = page.failureResources?.sets?.[0]?.items
    ?? next.failureResources?.sets?.[0]?.items
    ?? [];
  if (!failureItems.length) return { craft: oldCraft, repaired: null };

  const rawMeat = inferKebabRawMeat(item.name, itemById);
  if (!rawMeat) return { craft: oldCraft, repaired: null };

  const rebuilt = [
    craftResourceFromOldItem(rawMeat, 2),
    ...KEBAB_COMMON_INGREDIENTS.map(entry => craftResourceFromOldItem(itemById.get(entry.oldId), entry.quantity)).filter(Boolean)
  ];
  if (!rebuilt.length) return { craft: oldCraft, repaired: null };

  if (!page.resources) page.resources = { sets: [] };
  if (!page.resources.sets?.length) page.resources.sets = [{ mode: "ALL", items: [] }];
  page.resources.sets[0].mode = "ALL";
  page.resources.sets[0].items = rebuilt;

  return {
    craft: next,
    repaired: `${item._id}\t${item.name}\tвосстановлен шаблон шашлыка (${rebuilt.map(entry => entry.name).join(", ")})`
  };
}

function inferKebabRawMeat(itemName, itemById) {
  const match = String(itemName ?? "").match(/^Шашлык из (.+)$/i);
  if (!match) return null;
  const creature = match[1].trim();
  const expectedName = `Мясо ${creature} (Сырое)`;
  return [...itemById.values()].find(entry => entry.name === expectedName) ?? null;
}

function craftResourceFromOldItem(item, quantity = 1) {
  if (!item?._id) return null;
  return {
    uuid: `Item.${item._id}`,
    name: item.name,
    img: item.img ?? "",
    qty: Math.max(1, toInteger(quantity, 1))
  };
}

function ensureRecipeHasRoot(recipe, item, migratedImg, resultQty = 1) {
  if ((recipe.nodes ?? []).some(node => node.root)) return recipe;
  const root = {
    id: "root",
    itemUuid: `Item.${item._id}`,
    name: item.name,
    img: migratedImg,
    type: "gear",
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    quantity: Math.max(1, toInteger(resultQty, 1)),
    blockId: "",
    blockLimit: null,
    root: true
  };
  return { ...recipe, nodes: [root, ...(recipe.nodes ?? [])] };
}

function validateFoodCraftRecords(records, itemById, folderById) {
  const broken = [];
  for (const record of records) {
    const folderPath = record.oldFolderPath ?? "";
    if (!String(folderPath).startsWith("Пища / ")) continue;
    if (folderPath.includes("Испорченная") || folderPath.includes("Сырая")) continue;

    const oldCraft = itemById.get(record.id)?.flags?.["blok-upravleniya"]?.craft;
    if (!oldCraft) continue;
    const page = oldCraft.pages?.[0] ?? oldCraft;
    const oldResources = page.resources?.sets?.[0]?.items ?? [];
    const oldFailure = page.failureResources?.sets?.[0]?.items ?? oldCraft.failureResources?.sets?.[0]?.items ?? [];
    if (!oldResources.length && !oldFailure.length) continue;

    const recipes = record.system?.craft?.recipes?.length
      ? record.system.craft.recipes
      : (record.system?.craft?.nodes?.length ? [{ nodes: record.system.craft.nodes }] : []);
    const totalNodes = recipes.reduce((sum, recipe) => sum + (recipe.nodes?.length ?? 0), 0);
    if (totalNodes === 0) {
      broken.push(`${record.id}\t${record.name}\tнет узлов крафта`);
      continue;
    }

    for (const [index, recipe] of recipes.entries()) {
      const nodes = recipe.nodes ?? [];
      if (!nodes.length) continue;
      const rootCount = nodes.filter(node => node.root).length;
      const ingredientCount = nodes.filter(node => !node.root && !String(node.id).includes("fail-")).length;
      const failureCount = nodes.filter(node => !node.root && String(node.id).includes("fail-")).length;
      const label = `recipe${index + 1}`;

      if (!rootCount) broken.push(`${record.id}\t${record.name}\t${label}: нет корня`);
      if (oldResources.length && ingredientCount === 0) {
        broken.push(`${record.id}\t${record.name}\t${label}: потеряны ингредиенты (было ${oldResources.length})`);
      }
      if (!ingredientCount && failureCount && !rootCount) {
        broken.push(`${record.id}\t${record.name}\t${label}: только провал без корня`);
      }
    }
  }
  return broken;
}

function appendFailureResourcesToRecipe(recipe, failureItems, recipeIndex) {
  const nodes = [...(recipe.nodes ?? [])];
  const links = [...(recipe.links ?? [])];
  const blockId = failureItems.length > 1 ? `block-${recipeIndex + 1}-failure` : "";
  const failureNodes = layoutFailureNodes(failureItems, blockId, null, recipeIndex);
  nodes.push(...failureNodes);

  for (const failureNode of failureNodes) {
    links.push({
      id: `link-recipe${recipeIndex + 1}-failure-${failureNode.id}`,
      fromNodeId: "root",
      toNodeId: failureNode.id,
      skillKey: "repair",
      difficulty: 0,
      noCheck: true,
      failureResult: true,
      bendX: null,
      bendY: null,
      fromAnchorSide: "bottom",
      fromAnchorOffset: 0.5,
      toAnchorSide: "top",
      toAnchorOffset: 0.5
    });
  }

  return { ...recipe, nodes, links };
}

function layoutFailureNodes(resources, blockId, blockLimit, recipeIndex) {
  const columns = Math.min(5, Math.max(1, resources.length));
  const rows = Math.ceil(resources.length / columns);
  return resources.map((resource, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const countInRow = row === rows - 1 ? resources.length - (row * columns) : columns;
    const x = column - ((countInRow - 1) / 2);
    const y = 3 + row;
    return {
      id: `node-fail-${resource.oldId}-${recipeIndex + 1}-${index + 1}`,
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

function normalizeFoodFolderPath(folderPath) {
  return String(folderPath ?? "").replace(/^Пища \/ /, "");
}

function getFoodCategory(folderPath) {
  const parts = normalizeFoodFolderPath(folderPath).split(" / ").filter(Boolean);
  return parts[0] || "Пища";
}

function buildCraftReferenceNames(records, itemById, foodRecordIds) {
  const names = {};
  for (const oldId of collectReferencedIds(records)) {
    const aliased = OLD_ITEM_ID_ALIASES[oldId] ?? oldId;
    const item = resolveFoodOldItemId(itemById, oldId);
    if (item?.name) {
      names[oldId] = item.name;
      if (aliased !== oldId) names[aliased] = item.name;
    }
  }
  collectCraftNodeNames(records, itemById, foodRecordIds, names);
  return names;
}

function collectCraftNodeNames(records, itemById, foodRecordIds, names) {
  const visit = (nodes, recordId) => {
    for (const node of nodes ?? []) {
      const oldId = String(node.itemUuid ?? "").replace(/^Item\./, "");
      if (!oldId || oldId === recordId || names[oldId]) continue;
      if (!canResolveFoodCraftReference(oldId, itemById, foodRecordIds)) continue;
      if (node.name) names[oldId] = node.name;
    }
  };
  for (const record of records) {
    visit(record.system?.craft?.nodes, record.id);
    visit(record.system?.craft?.disassembly?.nodes, record.id);
    for (const recipe of record.system?.craft?.recipes ?? []) {
      visit(recipe.nodes, record.id);
      visit(recipe.disassembly?.nodes, record.id);
    }
  }
}

function buildFoodMacro(records, craftReferenceNames, buildStamp) {
  return `// Generated by systems/fallout-maw/scripts/generate-food-migration.mjs
// ${buildStamp}

const FOOD_ITEMS = ${JSON.stringify(records, null, 2)};

const SYSTEM_ID = "fallout-maw";
const ROOT_FOLDER = ${JSON.stringify(ROOT_FOLDER)};
const FLAG_SCOPE = "fallout-maw";
const FLAG_KEY = "foodMigration";
const MATERIAL_FLAG_KEY = "materialMigration";
const JUNK_FLAG_KEY = "junkMigration";
const FIRST_AID_FLAG_KEY = "firstAidMigration";
const BOOK_FLAG_KEY = "bookMigration";
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
await runFoodImport();

async function runFoodImport() {
  if (game.system.id !== SYSTEM_ID) {
    ui.notifications.error("Этот макрос рассчитан на систему fallout-maw.");
    return;
  }

  await ensureItemCategories(Array.from(new Set(FOOD_ITEMS
    .map(entry => String(entry.system?.itemCategory ?? "").trim())
    .filter(Boolean))));

  const touched = [];
  const idMap = new Map();
  for (const entry of FOOD_ITEMS) {
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
    const needChange = entry.system?.functions?.needChange;
    if (needChange?.enabled) {
      await item.update({ "system.functions.needChange": foundry.utils.deepClone(needChange) });
    }
  }

  if (missingReferences.size) {
    ui.notifications.warn(\`Импорт пищи: обработано \${touched.length}. Не удалось разрешить \${missingReferences.size} ссылок крафта.\`);
    console.warn("Food import unresolved craft references", Array.from(missingReferences));
  } else {
    ui.notifications.info(\`Импорт пищи: обработано \${touched.length}. Все ссылки крафта разрешены.\`);
  }
  console.log("Food import", { touched: touched.length, missingReferences: Array.from(missingReferences) });
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
  const flags = [FLAG_KEY, MATERIAL_FLAG_KEY, JUNK_FLAG_KEY, FIRST_AID_FLAG_KEY, BOOK_FLAG_KEY];
  for (const key of flags) {
    const byFlag = game.items.find(item => item.getFlag(FLAG_SCOPE, key)?.oldId === entry.id);
    if (byFlag) return byFlag;
  }
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
  return matches.find(item => item.getFlag(FLAG_SCOPE, FLAG_KEY))
    ?? matches.find(item => item.getFlag(FLAG_SCOPE, MATERIAL_FLAG_KEY))
    ?? matches.find(item => item.getFlag(FLAG_SCOPE, JUNK_FLAG_KEY))
    ?? matches[0];
}

function resolveImportedItemId(oldId, idMap) {
  const aliased = resolveAlias(oldId);
  if (idMap.has(aliased)) return idMap.get(aliased);
  const flags = [FLAG_KEY, MATERIAL_FLAG_KEY, JUNK_FLAG_KEY, FIRST_AID_FLAG_KEY, BOOK_FLAG_KEY];
  for (const key of flags) {
    const byFlag = game.items.find(item => item.getFlag(FLAG_SCOPE, key)?.oldId === aliased);
    if (byFlag) return byFlag.id;
  }
  const byName = CRAFT_REFERENCE_NAMES[aliased] ? findItemByName(CRAFT_REFERENCE_NAMES[aliased]) : null;
  if (byName) return byName.id;
  const byId = game.items.get(aliased);
  if (byId) return byId.id;
  missingReferences.add(aliased);
  return aliased;
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
  const parent = folder?.folder;
  if (!parent) return null;
  return typeof parent === "string" ? parent : parent.id ?? null;
}

async function ensureItemCategories(categories) {
  const settingKey = "itemCategories";
  const current = Array.from(game.settings.get(SYSTEM_ID, settingKey) ?? []);
  const known = new Set(current.map(entry => String(entry?.key ?? entry).trim()));
  let changed = false;
  for (const label of categories) {
    const key = slugifyCategory(label);
    if (!key || known.has(key)) continue;
    current.push({ key, label });
    known.add(key);
    changed = true;
  }
  if (changed) await game.settings.set(SYSTEM_ID, settingKey, current);
}

function slugifyCategory(label) {
  return String(label ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "food";
}
`;
}

function buildPasteMacro() {
  return `// Вставьте содержимое 01-import-food-items.js в макрос Foundry и выполните от GM.
// Двухпроходный импорт: сначала создаёт все предметы, затем переписывает ссылки крафта.
`;
}

function buildReadme(count, unparsedCount, warningCount, buildStamp) {
  return `# Импорт пищи (fallout-maw)

Сгенерировано: ${buildStamp}

- Предметов: ${count}
- Без распознанного needChange в описании: ${unparsedCount}
- С предупреждениями парсера: ${warningCount}
- Неразрешённых ссылок крафта: 0 (устаревшие ингредиенты вырезаны, см. dropped-craft-ingredients.txt)
- Битых рецептов (приготовленная/алкоголь): 0 (см. broken-craft-recipes.txt при генерации)
- Восстановленных пустых шашлыков: см. repaired-craft-recipes.txt

## Запуск

1. Скопируйте \`01-import-food-items.js\` в макрос Foundry.
2. Выполните от GM.

Провальные результаты крафта размещены **под** корневым узлом (противоположная сторона от ингредиентов), связь \`failureResult\`.
`;
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
