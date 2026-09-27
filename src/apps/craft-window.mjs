import { localize as auditLocalize, format as auditFormat } from "../utils/i18n.mjs";
import { SYSTEM_ID, TEMPLATES } from "../constants.mjs";
import { readCraftWindowState, writeCraftWindowState } from "../utils/craft-window-state.mjs";
import { filterCompatibleCraftRecipes, getCraftCompatibilityActions } from "../utils/craft-recipe-compatibility.mjs";
import { InventoryTransferMode } from "../utils/inventory-transfer-mode.mjs";
import { canTransferOwnedContents } from "../inventory/contents-transfer.mjs";
import {
  getCraftingSettings,
  getCreatureOptions,
  getItemCategorySettings,
  getSkillSettings,
  getToolSettings
} from "../settings/accessors.mjs";
import { isDeusExMachinaProgressItemUpdate } from "../abilities/deus-ex-machina-progress-runtime.mjs";
import {
  calculateCraftConsumedQuantity,
  getCraftFailureRefundPercent,
  isSkillThresholdMode
} from "../settings/crafting.mjs";
import { createSkillCheckBatchCollector, requestSkillCheck } from "../rolls/skill-check.mjs";
import {
  canUseWeaponSlotForItem,
  getRaceEquipmentSlotsForItem,
  getValidSelectedEquipmentSlotKeysForOptions,
  getValidSelectedWeaponSlotKeys,
  getValidSelectedWeaponSlotKeysForOptions,
  getWeaponSlotRequirement
} from "../utils/equipment-slots.mjs";
import {
  canStackItems,
  copyActorInventoryItem,
  getDropZoneParentId,
  getDropZonePlacementRequest,
  getFirstAvailableActorInventoryPlacement,
  getSearchDropPlacementForPointer,
  getSearchInventoryGridPointerPosition,
  prepareSearchActorContext,
  promptSearchItemStackQuantity,
  resolveActorPlacement,
  splitActorInventoryItem,
  stackActorInventoryItem,
  transferItemBetweenActors
} from "./search-inventory.mjs";
import {
  FALLBACK_ICON,
  getActorInventoryGridDimensions,
  getActorRootInventoryGridOptions,
  normalizeImagePath
} from "../utils/actor-display-data.mjs";
import { renderInventoryItemTooltipHTML } from "../sheets/actor-sheet.mjs";
import { FalloutMaWContainerSheet } from "../sheets/container-sheet.mjs";
import { isNaturalRaceItem } from "../races/natural-items.mjs";
import {
  ROOT_CONTAINER_ID,
  INFINITE_ROOT_INVENTORY_EMPTY_ROWS,
  LOCKED_STORAGE_PARENT_ID,
  LOCKED_STORAGE_PLACEMENT_MODE,
  createAnchoredItemStackPartsForQuantity,
  createItemStackPartAdditionUpdate,
  createItemStackPartRemovalUpdate,
  createItemStackPartSplitUpdate,
  createItemStackPartsForQuantity,
  createStoredPlacement,
  findFirstAvailableResolvedInventoryPlacement,
  getContainerContentsWeight,
  getContainerInventoryGridOptions,
  getContainerMaxLoad,
  getContextInventoryItems,
  getItemContainerParentId,
  getItemId,
  getItemMaxStack,
  getItemQuantity,
  getItemStackParts,
  getItemStackAdditionOverflowQuantity,
  getItemStackPartQuantity,
  getItemTotalWeight,
  isContainerItem,
  isItemLocked,
  isItemInButcheringStorage,
  normalizeInventoryPlacement,
  placementContainsInventoryCell,
  resetInventoryHoverCheckerCache,
  usesVirtualInventoryStacks
} from "../utils/inventory-containers.mjs";
import {
  applyInventoryDragRotation,
  canShowInventoryRotateAction,
  createInventoryRotationUpdate,
  getInventoryRotationUnavailableLabel,
  resolveInventoryItemRotation
} from "../utils/inventory-rotation.mjs";
import {
  clearInventoryPlacementPreviews,
  clearInventoryVirtualCells,
  renderInventoryPlacementPreview,
  syncInventoryVirtualCell
} from "../utils/inventory-grid-dom.mjs";
import { toInteger } from "../utils/numbers.mjs";
import {
  applyToolSupplyCostPercent,
  getActorToolSupplyCostPercent
} from "../utils/tool-supply-cost.mjs";
import { activateInventoryTooltipTab } from "../utils/inventory-tooltip-tabs.mjs";
import { getOverlayBaseZIndex, reserveOverlayZIndex } from "../utils/overlay-layer.mjs";
import { getEnabledToolFunctions, getToolResourceState } from "../utils/item-functions.mjs";
import {
  getConstructPartSlots,
  getInstalledConstructPartForSlot,
  isConstructPartCompatibleWithSlot,
  isInstalledConstructPartItem
} from "../utils/construct-parts.mjs";
import { isCompendiumUuid, resolveWorldItemSync } from "../utils/world-items.mjs";
import { createSourcedInventoryItemData, getCraftItemSourceKeys } from "../utils/craft-item-source.mjs";
import { formatCraftYieldQuantity, layoutCraftEmbeddedItems } from "../utils/craft-embedded-layout.mjs";
import {
  getCraftEmbeddedReturns,
  planCraftEmbeddedCreation,
  scaleCraftDisassemblyOutputs
} from "../utils/craft-item-resources.mjs";
import {
  craftCategoryExpansionKey,
  craftClassFolderExpansionKey,
  craftSubcategoryExpansionKey,
  createCraftRecipeGrouping,
  getCraftClassLabel,
  getCraftItemClass,
  getCraftRecipeGrouping
} from "../utils/craft-recipe-groups.mjs";
import { actorKnowsCraftItem, getKnownCraftItemUuids, hasCraftKnowledgeLayoutData } from "../items/recipe-knowledge.mjs";
import { canUseActiveItem, useActiveItem } from "../items/active-item-use.mjs";
import { openItemInteractionDialog } from "../items/item-interaction-dialogs.mjs";
import { getItemInteractionState } from "../items/item-interactions.mjs";
import { executeInventoryMutation, validateActorInventoryState } from "../inventory/mutation.mjs";
import { commitInventoryWithDroppedItems } from "../items/dropped-items.mjs";
import {
  createInventoryStackCandidateIndex,
  getInventoryStackCandidates
} from "../inventory/stacking.mjs";
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const CRAFT_WINDOW_REFERENCE_WIDTH = 2560;
const CRAFT_WINDOW_REFERENCE_HEIGHT = 1440;
const CRAFT_WINDOW_FALLBACK_VIEWPORT_WIDTH = 1280;
const CRAFT_WINDOW_FALLBACK_VIEWPORT_HEIGHT = 720;
const CRAFT_ROOT_NODE_ID = "root";
const CRAFT_GRID_FALLBACK_STEP = 56;
const CRAFT_MIN_ZOOM = 0.45;
const CRAFT_MAX_ZOOM = 2.5;
const CRAFT_SOCKET_DEPTH_PX = 9;
const CRAFT_SOCKET_HALF_WIDTH_PX = 8;
const CRAFT_FLOW_DURATION_MS = 1000;
const CRAFT_BATCH_SUMMARY_DURATION_MS = 3000;
const CRAFT_BATCH_SUMMARY_CLOSE_MS = 180;
const CRAFT_FLOW_SOCKET_PHASE_FRACTION = 0.14;
const CRAFT_FLOW_FAILURE_BLEND_FRACTION = 0.16;
const CRAFT_FLOW_GOLD = { r: 255, g: 203, b: 77 };
const CRAFT_FLOW_RED = { r: 228, g: 42, b: 42 };
const CRAFT_FLOW_SOCKET_GOLD_FILL = { r: 255, g: 203, b: 77, a: 0.92 };
const CRAFT_FLOW_SOCKET_RED_FILL = { r: 228, g: 42, b: 42, a: 0.9 };
const CRAFT_FLOW_SOCKET_GOLD_STROKE = { r: 255, g: 242, b: 171, a: 0.86 };
const CRAFT_FLOW_SOCKET_RED_STROKE = { r: 255, g: 196, b: 184, a: 0.82 };
const CRAFT_MODE_CREATE = "craft";
const CRAFT_MODE_DISASSEMBLY = "disassembly";
const CRAFT_LEGACY_BEND_PIXEL_THRESHOLD = 80;
const DEFAULT_CRAFT_RECIPE_ID = "recipe1";
const DEFAULT_CRAFT_RECIPE_NAME = () => auditLocalize("FALLOUTMAW.AuditApps.Recipe1", "Рецепт_1");
const CRAFT_RECIPE_SELECTION_SEPARATOR = "::recipe:";
const DEFAULT_CRAFT_TAB_NAME = () => auditLocalize("FALLOUTMAW.AuditApps.Tab", "Вкладка");
const TOOL_CLASS_RANK = Object.freeze({ D: 0, C: 1, B: 2, A: 3, S: 4 });

let craftWindow = null;
let craftRecipeCatalog = null;
let craftRecipeEntryCache = new WeakMap();
let craftRecipeMissingCache = new Map();
let craftRecipeMissingCacheKey = "";
let craftAvailabilityCache = { actorUuid: "", index: null };
const craftSourceProfileCache = new Map();
const worldRecipeLayoutCache = new Map();

function invalidateCraftRecipeAvailabilityCaches() {
  craftRecipeMissingCache = new Map();
  craftRecipeMissingCacheKey = "";
  craftAvailabilityCache = { actorUuid: "", index: null };
}

function invalidateWorldRecipeLayoutCache() {
  craftRecipeCatalog = null;
  craftRecipeEntryCache = new WeakMap();
  worldRecipeLayoutCache.clear();
  craftSourceProfileCache.clear();
}

function getCraftItemSourceProfile(sourceUuid = "") {
  const uuid = String(sourceUuid ?? "").trim();
  if (!uuid) return { sourceKeys: new Set() };
  if (craftSourceProfileCache.has(uuid)) return craftSourceProfileCache.get(uuid);
  const source = resolveWorldItemSync(uuid);
  const profile = {
    sourceKeys: getCraftItemSourceKeys(source, uuid)
  };
  craftSourceProfileCache.set(uuid, profile);
  return profile;
}

function getCraftItemMatchProfile(item = null) {
  return { sourceKeys: getCraftItemSourceKeys(item) };
}

function resolveCraftAcquisitionTargetItem(uuid = "") {
  const text = String(uuid ?? "").trim();
  if (!text) return null;
  let direct = null;
  try {
    direct = globalThis.fromUuidSync?.(text) ?? foundry.utils.fromUuidSync?.(text) ?? null;
  } catch {
    direct = null;
  }
  if (direct?.documentName === "Item" || direct?.constructor?.documentName === "Item") return direct;
  return resolveWorldItemSync(text);
}

function craftOutputMatchesItem(item = null, output = null, itemProfile = null) {
  if (!item || !output?.sourceUuid) return false;
  return craftItemMatchesRecipeSource(item, { itemUuid: output.sourceUuid }, itemProfile);
}

function addRecipeToCraftSourceIndexBucket(map, key, recipe) {
  const normalized = String(key ?? "").trim();
  if (!normalized) return;
  let bucket = map.get(normalized);
  if (!bucket) {
    bucket = new Set();
    map.set(normalized, bucket);
  }
  bucket.add(recipe);
}

function findAcquisitionRecipesForItem(targetItem) {
  const targetProfile = getCraftItemMatchProfile(targetItem);
  const candidates = new Set();
  collectCraftCatalogCandidates(craftRecipeCatalog?.byOutputUuid, targetItem, targetProfile, candidates);
  const recipes = Array.from(candidates).filter(recipe => recipeProducesTargetItem(recipe, targetItem, targetProfile));
  return { recipes, targetProfile };
}

function findUsageRecipesForItem(targetItem) {
  const targetProfile = getCraftItemMatchProfile(targetItem);
  const candidates = new Set();
  collectCraftCatalogCandidates(craftRecipeCatalog?.byUsageUuid, targetItem, targetProfile, candidates);
  const recipes = Array.from(candidates).filter(recipe => recipeUsesTargetItem(recipe, targetItem, targetProfile));
  return { recipes, targetProfile };
}

function hasAcquisitionWaysForItem(targetItem) {
  if (!targetItem) return false;
  return findAcquisitionRecipesForItem(targetItem).recipes.length > 0;
}

function recipeProducesTargetItem(recipe, targetItem, targetProfile = null) {
  if (!recipe || !targetItem || !hasCraftRecipeDataForMode(recipe.system?.craft, CRAFT_MODE_DISASSEMBLY)) return false;
  targetProfile ??= getCraftItemMatchProfile(targetItem);
  const layout = ensureWorldRecipeLayout(recipe.uuid, recipe)?.[CRAFT_MODE_DISASSEMBLY];
  const nodes = layout?.nodes ?? getCraftNodesWithRoot(recipe, CRAFT_MODE_DISASSEMBLY, recipe.recipeId);
  const links = getCraftLinksLite(recipe, CRAFT_MODE_DISASSEMBLY, recipe.recipeId, nodes);
  return getCraftOutputs(nodes, { links }).some(output => craftOutputMatchesItem(targetItem, output, targetProfile));
}

function recipeUsesTargetItem(recipe, targetItem, targetProfile = null) {
  if (!recipe || !targetItem || !hasCraftRecipeDataForMode(recipe.system?.craft, CRAFT_MODE_CREATE)) return false;
  targetProfile ??= getCraftItemMatchProfile(targetItem);
  const requirements = getCraftUsageRequirements(recipe);
  return requirements.some(requirement => craftRequirementMatchesItem(targetItem, requirement, targetProfile));
}

function getCraftUsageRequirements(recipe) {
  if (!recipe || !hasCraftRecipeDataForMode(recipe.system?.craft, CRAFT_MODE_CREATE)) return [];
  const recipeId = recipe?.recipeId ?? DEFAULT_CRAFT_RECIPE_ID;
  const layout = ensureWorldRecipeLayout(recipe.uuid, recipe)?.[CRAFT_MODE_CREATE];
  const nodes = layout?.nodes ?? getCraftNodesWithRootLite(recipe, CRAFT_MODE_CREATE, recipeId);
  const links = getCraftLinksLite(recipe, CRAFT_MODE_CREATE, recipeId, nodes);
  const failureNodeIds = getCraftFailureOutputNodeIds(nodes, links, CRAFT_MODE_CREATE);
  return getCraftRequirementsFromNodes(nodes.filter(node => !failureNodeIds.has(node.id)));
}

function craftRequirementMatchesItem(item = null, requirement = {}, itemProfile = null) {
  if (!item) return false;
  itemProfile ??= getCraftItemMatchProfile(item);
  const requirementKeys = new Set(Array.from(requirement.sourceKeys ?? []).map(key => String(key ?? "").trim()).filter(Boolean));
  const itemKeys = itemProfile.sourceKeys ?? new Set();
  return Boolean(requirementKeys.size && itemKeys.size && setsIntersect(requirementKeys, itemKeys));
}

function buildAcquisitionWayEntries(targetItem, targetProfile, candidateRecipes = [], actor = null, availability = null) {
  const entries = [];
  for (const recipe of candidateRecipes) {
    if (!hasCraftRecipeDataForMode(recipe.system?.craft, CRAFT_MODE_DISASSEMBLY)) continue;
    const layout = ensureWorldRecipeLayout(recipe.uuid, recipe)?.[CRAFT_MODE_DISASSEMBLY] ?? null;
    const nodes = layout?.nodes ?? getCraftNodesWithRoot(recipe, CRAFT_MODE_DISASSEMBLY, recipe.recipeId);
    const links = getCraftLinksLite(recipe, CRAFT_MODE_DISASSEMBLY, recipe.recipeId, nodes);
    const outputs = getCraftOutputs(nodes, { links });
    if (!outputs.length) continue;

    let targetQuantity = 0;
    const outputChips = outputs.map(output => {
      const source = resolveWorldItemSync(output.sourceUuid);
      const quantity = Math.max(1, toInteger(output.quantity) || 1);
      const target = craftOutputMatchesItem(targetItem, output, targetProfile);
      if (target) targetQuantity += quantity;
      return {
        uuid: source?.uuid ?? output.sourceUuid,
        name: String(source?.name ?? auditLocalize("FALLOUTMAW.AuditApps.UnknownItem", "Неизвестный предмет")),
        img: normalizeImagePath(source?.img, FALLBACK_ICON),
        quantityLabel: `x${quantity}`,
        target
      };
    });

    if (targetQuantity < 1) continue;
    const missing = recipe.known !== false && actor ? isCraftRecipeMissing(recipe, actor, CRAFT_MODE_DISASSEMBLY, availability) : false;
    entries.push({
      unknown: recipe.known === false,
      recipeSelectionUuid: recipe.uuid,
      tooltipUuid: recipe.itemUuid,
      mode: CRAFT_MODE_DISASSEMBLY,
      name: getCraftRecipeDisplayName(recipe),
      recipeName: String(recipe.recipeName ?? ""),
      category: getCraftRecipeCategory(recipe),
      img: normalizeImagePath(recipe.img, FALLBACK_ICON),
      targetQuantityLabel: `x${targetQuantity}`,
      available: !missing,
      statusLabel: missing ? auditLocalize("FALLOUTMAW.AuditApps.UnavailableMissingItemOrTool", "Недоступно: нет предмета или инструмента") : auditLocalize("FALLOUTMAW.AuditApps.AvailableCanBeDismantled", "Доступно: можно разобрать"),
      statusClass: missing ? "missing" : "ready",
      outputs: outputChips
    });
  }
  return entries.map(prepareCraftRecipeDisplay);
}

function buildUsageCraftEntries(targetItem, targetProfile, candidateRecipes = [], actor = null, availability = null) {
  const entries = [];
  for (const recipe of candidateRecipes) {
    if (!hasCraftRecipeDataForMode(recipe.system?.craft, CRAFT_MODE_CREATE)) continue;
    const requirements = getCraftUsageRequirements(recipe);
    const matchingRequirements = requirements.filter(requirement => craftRequirementMatchesItem(targetItem, requirement, targetProfile));
    if (!matchingRequirements.length) continue;

    const missing = recipe.known !== false && actor ? isCraftRecipeMissing(recipe, actor, CRAFT_MODE_CREATE, availability) : false;
    entries.push({
      unknown: recipe.known === false,
      recipeSelectionUuid: recipe.uuid,
      tooltipUuid: recipe.itemUuid,
      mode: CRAFT_MODE_CREATE,
      name: getCraftRecipeDisplayName(recipe),
      recipeName: String(recipe.recipeName ?? ""),
      category: getCraftRecipeCategory(recipe),
      img: normalizeImagePath(recipe.img, FALLBACK_ICON),
      targetQuantityLabel: `x${matchingRequirements.reduce((total, requirement) => total + Math.max(1, toInteger(requirement.quantity) || 1), 0)}`,
      available: !missing,
      statusLabel: missing ? auditLocalize("FALLOUTMAW.AuditApps.UnavailableMissingComponentsOrTool", "Недоступно: нет компонентов или инструмента") : auditLocalize("FALLOUTMAW.AuditApps.AvailableCanBeCrafted", "Доступно: можно создать"),
      statusClass: missing ? "missing" : "ready",
      outputs: []
    });
  }
  return entries.map(prepareCraftRecipeDisplay);
}

function buildCompatibleCraftEntries(targetItem, kind, candidateRecipes = [], actor = null, availability = null) {
  return filterCompatibleCraftRecipes(targetItem, kind, candidateRecipes)
    .filter(recipe => hasCraftRecipeDataForMode(recipe.system?.craft, CRAFT_MODE_CREATE))
    .map(recipe => {
      const missing = recipe.known !== false && actor ? isCraftRecipeMissing(recipe, actor, CRAFT_MODE_CREATE, availability) : false;
      return {
        unknown: recipe.known === false,
        recipeSelectionUuid: recipe.uuid,
        tooltipUuid: recipe.itemUuid,
        mode: CRAFT_MODE_CREATE,
        name: getCraftRecipeDisplayName(recipe),
        recipeName: String(recipe.recipeName ?? ""),
        category: getCraftRecipeCategory(recipe),
        img: normalizeImagePath(recipe.img, FALLBACK_ICON),
        available: !missing,
        statusLabel: missing ? auditLocalize("FALLOUTMAW.AuditApps.UnavailableMissingComponentsOrTool", "Недоступно: нет компонентов или инструмента") : auditLocalize("FALLOUTMAW.AuditApps.AvailableCanBeCrafted", "Доступно: можно создать"),
        statusClass: missing ? "missing" : "ready"
      };
    }).map(prepareCraftRecipeDisplay);
}

function prepareCraftRecipeDisplay(entry) {
  if (!entry.unknown) return entry;
  return {
    ...entry,
    uuid: "", itemUuid: "", tooltipUuid: "", recipeSelectionUuid: "",
    name: auditLocalize("FALLOUTMAW.AuditApps.UnknownRecipe", "Неизвестный рецепт"), displayName: auditLocalize("FALLOUTMAW.AuditApps.UnknownRecipe", "Неизвестный рецепт"),
    recipeName: "", category: "", targetQuantityLabel: "", outputs: [],
    img: FALLBACK_ICON,
    available: false, missing: false, selected: false,
    statusClass: "unknown", statusLabel: ""
  };
}

function compareCraftRecipeAvailability(left, right) {
  const rank = entry => entry.unknown ? 2 : (entry.missing || entry.available === false ? 1 : 0);
  return rank(left) - rank(right)
    || String(left.displayName ?? left.name ?? "").localeCompare(String(right.displayName ?? right.name ?? ""), game.i18n.lang);
}

function getCraftRecipeMissingCacheKey(mode, recipeUuid = "") {
  return `${normalizeCraftMode(mode)}:${String(recipeUuid ?? "")}`;
}

function findCraftRecipesForItem(item) {
  if (!craftRecipeCatalog) return [];
  const itemProfile = getCraftItemMatchProfile(item);
  const candidates = new Set();
  collectCraftCatalogCandidates(craftRecipeCatalog.bySourceUuid, item, itemProfile, candidates);
  return Array.from(candidates).filter(recipe => craftItemMatchesRecipeSource(item, recipe, itemProfile));
}

function collectCraftCatalogCandidates(map, item, itemProfile, candidates) {
  if (!map || !item) return;
  const keys = new Set([String(item.uuid ?? "").trim(), ...(itemProfile?.sourceKeys ?? [])]);
  for (const key of keys) {
    const bucket = map.get(key);
    if (!bucket) continue;
    for (const recipe of bucket) candidates.add(recipe);
  }
}

function getCraftNodesLite(item, mode = CRAFT_MODE_CREATE, recipeId = DEFAULT_CRAFT_RECIPE_ID) {
  return Array.from(getCraftRecipeData(item, mode, recipeId)?.nodes ?? [])
    .map(normalizeCraftNode)
    .filter(node => node.id);
}

function getCraftNodesWithRootLite(item, mode = CRAFT_MODE_CREATE, recipeId = DEFAULT_CRAFT_RECIPE_ID) {
  const nodes = getCraftNodesLite(item, mode, recipeId);
  const rootIndex = nodes.findIndex(node => node.root);
  const root = createCraftRootNode(item, rootIndex >= 0 ? nodes[rootIndex] : {});
  if (rootIndex >= 0) {
    nodes[rootIndex] = root;
    return nodes;
  }
  return [root, ...nodes];
}

function getCraftLinksLite(item, mode = CRAFT_MODE_CREATE, recipeId = DEFAULT_CRAFT_RECIPE_ID, nodes = getCraftNodesWithRootLite(item, mode, recipeId)) {
  return normalizeCraftLinksForNodes(Array.from(getCraftRecipeData(item, mode, recipeId)?.links ?? []), nodes);
}

function getCraftMaterialRequirementNodes(nodes = [], links = [], mode = CRAFT_MODE_CREATE, {
  actor = null,
  index = null,
  randomize = false
} = {}) {
  if (normalizeCraftMode(mode) === CRAFT_MODE_DISASSEMBLY) return nodes.filter(node => node.root);
  return getCraftMaterialBlockLimitedNodes(nodes, {
    actor,
    index,
    randomize,
    excludeNodeIds: getCraftFailureOutputNodeIds(nodes, links, mode)
  });
}

function getCraftRequirementsFromNodes(nodes = [], { includeRoot = false } = {}) {
  const requirements = [];
  for (const node of nodes) {
    if (node.root && !includeRoot) continue;
    if (isCraftNodeToolRequirement(node)) continue;
    const sourceUuid = getCraftNodeSourceUuid(node);
    const quantity = Math.max(1, toInteger(node.quantity) || 1);
    const profile = getCraftItemSourceProfile(sourceUuid);
    const key = getCraftRequirementKey({
      sourceKeys: profile.sourceKeys,
      sourceUuid
    });
    const existing = requirements.find(requirement => requirement.key === key);
    if (existing) {
      existing.quantity += quantity;
      existing.nodeIds.push(node.id);
      continue;
    }
    requirements.push({
      key,
      sourceUuid,
      sourceKeys: Array.from(profile.sourceKeys),
      quantity,
      nodeIds: [node.id]
    });
  }
  return requirements;
}

function buildWorldRecipeLayoutCacheEntry(summary) {
  const recipeId = summary?.recipeId ?? DEFAULT_CRAFT_RECIPE_ID;
  const entry = {};
  for (const mode of [CRAFT_MODE_CREATE, CRAFT_MODE_DISASSEMBLY]) {
    if (!hasCraftRecipeDataForMode(summary?.system?.craft, mode)) continue;
    const nodes = getCraftNodesWithRootLite(summary, mode, recipeId);
    const links = getCraftLinksLite(summary, mode, recipeId, nodes);
    entry[mode] = {
      nodes,
      materialRequirements: mode === CRAFT_MODE_DISASSEMBLY
        ? getCraftRequirementsFromNodes(getCraftMaterialRequirementNodes(nodes, links, mode), { includeRoot: true })
        : getCraftRequirementsFromNodes(getCraftMaterialRequirementNodes(nodes, links, mode))
    };
  }
  return entry;
}

function ensureWorldRecipeLayout(recipeUuid = "", summary = null) {
  const key = String(recipeUuid ?? "");
  if (!key) return null;
  if (worldRecipeLayoutCache.has(key)) return worldRecipeLayoutCache.get(key);
  summary ??= craftRecipeCatalog?.byUuid.get(key) ?? null;
  if (!summary) return null;
  const entry = buildWorldRecipeLayoutCacheEntry(summary);
  worldRecipeLayoutCache.set(key, entry);
  return entry;
}

function getCraftAvailabilityIndex(actor = null) {
  const actorUuid = actor?.uuid ?? "";
  if (craftAvailabilityCache.actorUuid === actorUuid && craftAvailabilityCache.index) {
    return craftAvailabilityCache.index;
  }
  const index = createCraftAvailabilityIndex(actor);
  craftAvailabilityCache = { actorUuid, index };
  return index;
}

function isCraftRecipeMissing(recipe, actor, mode = CRAFT_MODE_CREATE, availability = null) {
  if (!actor || !recipe) return false;
  mode = normalizeCraftMode(mode);
  const cacheKey = `${actor.uuid}:${mode}`;
  if (craftRecipeMissingCacheKey !== cacheKey) {
    craftRecipeMissingCache = new Map();
    craftRecipeMissingCacheKey = cacheKey;
  }
  const recipeKey = getCraftRecipeMissingCacheKey(mode, recipe.uuid);
  if (craftRecipeMissingCache.has(recipeKey)) return craftRecipeMissingCache.get(recipeKey);
  const missing = getCraftRecipeMissingCount(recipe, actor, mode, availability ?? getCraftAvailabilityIndex(actor)) > 0;
  craftRecipeMissingCache.set(recipeKey, missing);
  return missing;
}

export function openCraftWindow({ actor, selection = null } = {}) {
  if (!actor) return undefined;
  craftWindow ??= new CraftWindowApplication();
  craftWindow.setActor(actor);
  if (selection) craftWindow.openSelection(selection);
  return craftWindow.render({ force: true });
}

export async function getCraftWindowOpenOptionsForItem(item, actor = item?.parent?.documentName === "Actor" ? item.parent : null) {
  if (!item || item.type !== "gear") return [];
  await getCraftRecipeSummaries(actor);
  const matchingRecipes = findCraftRecipesForItem(item);
  const createOptions = buildCraftOpenOptionsForMode(matchingRecipes.filter(recipe => recipe.known !== false), CRAFT_MODE_CREATE);
  const disassemblyOptions = buildCraftOpenOptionsForMode(matchingRecipes.filter(recipe => recipe.known !== false || (actor && item.parent === actor && !recipe.system?.craft?.disassemblyRequiresRecipe)), CRAFT_MODE_DISASSEMBLY);
  return [...createOptions, ...disassemblyOptions.map(option => ({ ...option, sourceItemId: item.parent === actor ? item.id : "" }))];
}

const quickDisassemblyActors = new Set();

export async function getQuickDisassemblyItems(actor, skillActor = actor) {
  await getCraftRecipeSummaries(skillActor);
  const items = actor?.items?.contents ?? [];
  const byId = new Map(items.map(item => [item.id, item]));
  const containers = new Set(items.map(getItemContainerParentId));
  return items.filter(item => {
    if (item.type !== "gear" || !getItemQuantity(item) || isNaturalRaceItem(item) || containers.has(item.id)) return false;
    const visited = new Set();
    for (let current = item; current; current = byId.get(getItemContainerParentId(current))) {
      if (visited.has(current.id) || isItemLocked(current) || isItemInButcheringStorage(current)
        || current.system?.placement?.mode === LOCKED_STORAGE_PLACEMENT_MODE) return false;
      visited.add(current.id);
    }
    const recipes = findCraftRecipesForItem(item);
    return !recipes.some(recipe => hasCraftRecipeDataForMode(recipe.system?.craft, CRAFT_MODE_CREATE))
      && recipes.some(recipe => hasCraftRecipeDataForMode(recipe.system?.craft, CRAFT_MODE_DISASSEMBLY)
        && (!recipe.system?.craft?.disassemblyRequiresRecipe || actorKnowsCraftItem(skillActor, resolveCraftRecipeSelection(recipe.uuid).item)));
  });
}

export function notifyQuickDisassemblyResult(result) {
  if (!result) return;
  if (result.dropped) ui.notifications.warn(auditLocalize("FALLOUTMAW.AuditApps.ThereWasNotEnoughInventorySpaceExcessItems", "В инвентаре не хватило места, лишние предметы выброшены на землю."));
  ui.notifications.info(auditFormat("FALLOUTMAW.AuditApps.QuickDismantlingCompleted", { v0: (result.completed), v1: (result.skipped?.length ? auditFormat("FALLOUTMAW.AuditApps.Skipped", { v0: (result.skipped.length) }, ", пропущено {v0}") : "") }, "Быстрый разбор: выполнено {v0}{v1}"));
  if (result.skipped?.length) ui.notifications.warn(result.skipped.map(entry => `${entry.name}: ${entry.reason}`).join("; "));
}

export async function quickDisassembleItems({ actor, skillActor = actor, itemIds = null } = {}) {
  if (!actor?.isOwner || !skillActor?.isOwner) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.YouDoNotHavePermissionToDismantle", "Нет прав на разбор."));
  const ids = [...new Set([actor.uuid, skillActor.uuid])];
  if (ids.some(id => quickDisassemblyActors.has(id))) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.DismantlingIsAlreadyInProgress", "Разбор уже выполняется."));
  ids.forEach(id => quickDisassemblyActors.add(id));
  try {
    return await CraftWindowApplication.runQuickDisassembly({ actor, skillActor, itemIds });
  } finally { ids.forEach(id => quickDisassemblyActors.delete(id)); }
}

class CraftWindowApplication extends HandlebarsApplicationMixin(ApplicationV2) {
  #contentsTransfer = new InventoryTransferMode();
  #actorUuid = "";
  #actor = null;
  #renderedActorUuid = "";
  #selectedRecipeUuid = "";
  #selectedRecipeId = DEFAULT_CRAFT_RECIPE_ID;
  #selectedRecipe = null;
  #craftResourceOptions = {};
  #acquisitionTargetUuid = "";
  #usageTargetUuid = "";
  #usageKind = "usage";
  #craftMode = CRAFT_MODE_CREATE;
  #craftToolPickerNodeId = "";
  #craftToolSelections = new Map();
  #craftRepeatCount = 0;
  #craftBatchSummaryClose = null;
  #craftBatchSummaryTimer = null;
  #bulkEntries = new Map();
  #bulkRunPending = false;
  #busy = false;
  #pendingOperation = null;
  #startedOperationId = "";
  #animatingOperationId = "";
  #dragDrop = null;
  #draggedItemData = null;
  #draggedItemId = "";
  #craftPanDrag = null;
  #craftViewportOverride = null;
  #craftGridStep = CRAFT_GRID_FALLBACK_STEP;
  #craftLinkData = { nodes: [], links: [] };
  #craftTabs = [];
  #activeCraftTabId = "";
  #expandedRecipeNodes = new Set();
  #hoverPreviewInputKey = "";
  #hoverPreviewKey = "";
  #tooltipAnchorElement = null;
  #tooltipActorUuid = "";
  #tooltipCloseTimer = null;
  #tooltipCompareMode = false;
  #tooltipDocumentKeyHandler = null;
  #tooltipDocumentPointerDownHandler = null;
  #tooltipDocumentUuid = "";
  #tooltipElement = null;
  #tooltipItemId = "";
  #tooltipPinned = false;
  #tooltipTimer = null;
  #tooltipWeaponTabIndex = 0;
  #hookIds = [];
  #linkRenderFrame = 0;
  #renderRefresh = null;
  #recipeSearch = "";
  #recipeListRenderFrame = 0;
  #recipeListRenderVersion = 0;
  #resizeObserver = null;
  #scrollPositions = new Map();
  #viewportResizeHandler = null;
  #pageHideHandler = null;
  #uiScale = 1;

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-craft-window",
    classes: ["fallout-maw", "fallout-maw-sheet", "fallout-maw-actor-sheet", "fallout-maw-search-inventory", "fallout-maw-craft-window", "sheet", "actor"],
    position: {
      width: CRAFT_WINDOW_REFERENCE_WIDTH,
      height: CRAFT_WINDOW_REFERENCE_HEIGHT
    },
    window: {
      resizable: false
    }
  };

  static PARTS = {
    body: {
      template: TEMPLATES.craftWindow,
      templates: [TEMPLATES.craftWindowPanel, TEMPLATES.craftWindowRecipeList]
    }
  };

  get title() {
    return auditLocalize("FALLOUTMAW.AuditApps.Crafting", "Крафт");
  }

  openSelection(selection = {}) {
    this.#ensureCraftTabs();
    this.#saveActiveCraftTabState();
    const activeTab = this.#getActiveCraftTab();
    const useActiveTab = !this.#selectedRecipeUuid && !this.#acquisitionTargetUuid && !this.#usageTargetUuid && activeTab && !activeTab.bulk;
    const tab = useActiveTab ? activeTab : this.#createCraftTab();
    if (!useActiveTab) {
      this.#craftTabs.push(tab);
      this.#activeCraftTabId = tab.id;
    }
    this.#loadCraftTabState(tab);
    this.#craftMode = normalizeCraftMode(selection.mode);
    this.#craftResourceOptions = { sourceItemId: String(selection.sourceItemId ?? ""), selections: {} };
    this.#selectedRecipeUuid = String(selection.recipeSelectionUuid ?? selection.recipeUuid ?? "");
    this.#selectedRecipeId = parseCraftRecipeSelectionUuid(this.#selectedRecipeUuid).recipeId;
    this.#selectedRecipe = null;
    this.#acquisitionTargetUuid = "";
    this.#usageTargetUuid = "";
    this.#recipeSearch = "";
    this.#expandedRecipeNodes = new Set();
    this.#craftViewportOverride = null;
    this.#craftToolPickerNodeId = "";
    this.#craftRepeatCount = 0;
    this.#updateActiveCraftTabTitle();
    this.#saveActiveCraftTabState();
  }

  setActor(actor) {
    invalidateCraftRecipeAvailabilityCaches();
    const actorUuid = String(actor?.uuid ?? "");
    if (actorUuid !== this.#actorUuid) {
      this.#captureScrollPositions();
      this.#rememberActorWorkspace();
      this.#selectedRecipe = null;
      this.#craftViewportOverride = null;
      this.#craftToolPickerNodeId = "";
      this.#pendingOperation = null;
      this.#startedOperationId = "";
      this.#animatingOperationId = "";
      this.#bulkEntries.clear();
      this.#craftToolSelections.clear();
      this.#scrollPositions.clear();
      this.#actorUuid = actorUuid;
      this.#actor = actor ?? null;
      const remembered = readCraftWindowState(actorUuid);
      if (remembered) {
        this.#craftTabs = remembered.tabs.map(tab => this.#createCraftTab(tab));
        this.#craftToolSelections = new Map(remembered.craftToolSelections);
        this.#bulkEntries = new Map(remembered.bulkEntries);
        this.#scrollPositions = new Map(remembered.scrollPositions);
        this.#loadCraftTabState(this.#craftTabs.find(tab => tab.id === remembered.activeCraftTabId) ?? this.#craftTabs[0]);
      } else this.#resetCraftTabs();
    } else if (actorUuid === this.#actorUuid) {
      this.#selectedRecipe = null;
    }
    this.#actorUuid = actorUuid;
    this.#actor = actor ?? null;
    this.#ensureCraftTabs();
  }

  #rememberActorWorkspace() {
    if (!this.#actorUuid || !this.#craftTabs.length) return;
    this.#saveActiveCraftTabState();
    writeCraftWindowState(this.#actorUuid, {
      tabs: this.#craftTabs,
      activeCraftTabId: this.#activeCraftTabId,
      craftToolSelections: Array.from(this.#craftToolSelections),
      bulkEntries: Array.from(this.#bulkEntries),
      scrollPositions: Array.from(this.#scrollPositions)
    });
  }

  static async runQuickDisassembly({ actor, skillActor, itemIds }) {
    const app = new CraftWindowApplication();
    app.#craftMode = CRAFT_MODE_DISASSEMBLY;
    const eligible = await getQuickDisassemblyItems(actor, skillActor);
    const selected = itemIds ? eligible.filter(item => itemIds.includes(item.id)) : eligible;
    if (!selected.length) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.ThereAreNoItemsForQuickDismantling", "Нет предметов для быстрого разбора."));
    const expectedItems = actor.items.contents.map(item => item.toObject());
    const expectedToolItems = skillActor === actor ? expectedItems : skillActor.items.contents.map(item => item.toObject());
    const collector = createSkillCheckBatchCollector({ requester: auditLocalize("FALLOUTMAW.Craft.Disassembly", "Разбор"), title: auditLocalize("FALLOUTMAW.AuditApps.QuickDismantling", "Быстрый разбор") });
    const operations = [], skipped = [], reservedTools = [], toolSelections = {};
    let completed = 0;
    try {
      for (const item of selected) {
        const candidates = findCraftRecipesForItem(item).filter(recipe => hasCraftRecipeDataForMode(recipe.system?.craft, CRAFT_MODE_DISASSEMBLY));
        let chosen = null, problem = auditLocalize("FALLOUTMAW.AuditApps.NoDismantlingAvailable", "Нет доступного разбора");
        for (const candidate of candidates) {
          const { item: recipe, recipeId } = resolveCraftRecipeSelection(candidate.uuid);
          const validation = await validateCraftRequest(actor, recipe, CRAFT_MODE_DISASSEMBLY, {}, recipeId, { sourceItemId: item.id, skillActor });
          if (!validation.valid) { problem = validation.message; continue; }
          const quantity = validation.requirements.reduce((sum, req) => sum + req.quantity, 0);
          const repeats = Math.floor(getItemQuantity(item) / quantity);
          if (!repeats) continue;
          const tools = validation.toolRequirements.map(tool => ({ ...tool, key: `${item.id}:${tool.key}`, quantity: tool.quantity * repeats }));
          const choices = Object.fromEntries(Object.entries(validation.toolSelections).map(([key, id]) => [`${item.id}:${key}`, id]));
          const plan = createCraftToolRequirementSpendPlan(skillActor, [...reservedTools, ...tools], { ...toolSelections, ...choices });
          if (!plan.valid) { problem = plan.message; continue; }
          if (actor === skillActor && Object.values(choices).some(id => selected.some(entry => entry.id === id))) {
            problem = auditLocalize("FALLOUTMAW.AuditApps.TheToolIsAlsoSelectedForDismantling", "Инструмент также выбран для разбора"); continue;
          }
          reservedTools.push(...tools); Object.assign(toolSelections, choices);
          chosen = { recipe, recipeId, validation, repeats }; break;
        }
        if (!chosen) { skipped.push({ name: item.name, reason: problem }); continue; }
        const { recipe, recipeId, validation, repeats } = chosen;
        const randomOutputs = getCraftNodesWithRootLite(recipe, CRAFT_MODE_DISASSEMBLY, recipeId).some(node => !node.root && Number(node.blockLimit) > 0);
        const repetitions = isSkillThresholdMode(getCraftingSettings().craft.mode) && !randomOutputs ? repeats : 1;
        for (let attempt = 0; attempt < repeats; attempt += repetitions) {
          const current = attempt === 0 ? validation : await validateCraftRequest(actor, recipe, CRAFT_MODE_DISASSEMBLY, validation.toolSelections, recipeId, { sourceItemId: item.id, skillActor });
          if (!current.valid) throw new Error(current.message);
          const results = await app.#resolveCraftLinkResults(skillActor, current.links, { createMessages: false, collector, mode: CRAFT_MODE_DISASSEMBLY });
          if (!results) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.DismantlingCheckCanceled", "Проверка разбора отменена"));
          const operation = { ...app.#buildCraftOperation(actor, recipe, current, results), recipeId, repetitions };
          if (repetitions > 1) for (const key of ["requirements", "toolRequirements", "outputs", "failureOutputs"]) {
            operation[key] = (operation[key] ?? []).map(entry => ({ ...entry, quantity: entry.quantity * repetitions }));
          }
          operations.push(operation);
        }
        completed += repeats;
      }
      if (!operations.length) throw new Error(skipped[0]?.reason || auditLocalize("FALLOUTMAW.AuditApps.NoDismantlingAvailable_307", "Нет доступного разбора."));
      const result = await applyBulkCraftOperations(actor, operations, expectedItems, { skillActor, expectedToolItems });
      invalidateCraftRecipeAvailabilityCaches();
      if (collector.size) {
        try { await collector.publish({ forceBatch: true }); }
        catch (error) { console.error(`${SYSTEM_ID} | Quick disassembly chat failed`, error); }
      }
      return { completed, skipped, dropped: Boolean(result?.dropped) };
    } finally { await collector.abort(); }
  }

  async #openBulk() {
    if (this.#busy) return;
    const tab = this.#craftTabs.find(entry => entry.bulk);
    if (tab) { this.#selectCraftTab(tab.id); return; }
    await this.#addCraftTab({ bulk: true, mode: CRAFT_MODE_DISASSEMBLY });
  }

  async #addBulkItem(item, event = {}, stack = {}) {
    if (!this._canDragDrop() || item.parent?.uuid !== this.#actorUuid) return;
    const existing = this.#bulkEntries.get(item.id);
    const available = Math.max(0, getItemQuantity(item) - (existing?.quantity ?? 0));
    const stackQuantity = Math.max(1, Number(stack.stackQuantity) || (usesVirtualInventoryStacks(item)
      ? getItemStackPartQuantity(item, Math.max(0, toInteger(stack.stackIndex))) : getItemQuantity(item)));
    const maximum = Math.min(available, stackQuantity);
    if (!maximum) return;
    const quantity = event.ctrlKey ? await promptSearchItemStackQuantity({
      item, title: auditLocalize("FALLOUTMAW.AuditApps.BulkDismantling", "Массовый разбор"), actionLabel: auditLocalize("FALLOUTMAW.Item.ConditionAddRecoveryMethod", "Добавить"), max: maximum, value: maximum
    }) : maximum;
    if (!quantity || this.#busy) return;
    this.#bulkEntries.set(item.id, { ...existing, stackOrder: [...new Set([...(existing?.stackOrder ?? []), Math.max(0, toInteger(stack.stackIndex))])], itemId: item.id, name: item.name, img: item.img,
      quantity: Math.min(getItemQuantity(item), (existing?.quantity ?? 0) + quantity) });
    this.#clearInventoryTooltip({ force: true });
    await this.#openBulk();
    await this.#renderPreservingWindowStack();
  }

  async #autoFillBulk() {
    if (!this._canDragDrop() || this.#busy) return;
    await getCraftRecipeSummaries(this.#actor);
    if (this.#busy) return;
    for (const item of this.#actor?.items.contents ?? []) {
      const quantity = getItemQuantity(item);
      if (!quantity) continue;
      const recipes = findCraftRecipesForItem(item);
      if (!recipes.some(recipe => hasCraftRecipeDataForMode(recipe.system?.craft, CRAFT_MODE_DISASSEMBLY))
        || recipes.some(recipe => hasCraftRecipeDataForMode(recipe.system?.craft, CRAFT_MODE_CREATE))) continue;
      const existing = this.#bulkEntries.get(item.id);
      this.#bulkEntries.set(item.id, { ...existing, itemId: item.id, name: item.name, img: item.img, quantity });
    }
    this.#clearInventoryTooltip({ force: true });
    await this.#updateCraftPanel();
  }

  async #prepareBulkContext() {
    await getCraftRecipeSummaries(this.#actor);
    const rows = [], outputTotals = new Map(), tools = [], toolSelections = {}, requirements = [];
    let difficulty = 0, randomOutputs = false;
    for (const entry of this.#bulkEntries.values()) {
      const item = this.#actor?.items.get(entry.itemId);
      const row = { ...entry, error: "", options: [], repeats: 0 };
      rows.push(row);
      if (!item) { row.error = auditLocalize("FALLOUTMAW.AuditApps.TheItemIsNoLongerInTheInventory", "Предмета больше нет в инвентаре"); continue; }
      const candidates = findCraftRecipesForItem(item).filter(recipe => hasCraftRecipeDataForMode(recipe.system?.craft, CRAFT_MODE_DISASSEMBLY));
      const selected = candidates.find(recipe => recipe.uuid === entry.selectionUuid) ?? candidates[0];
      row.hasVariants = candidates.length > 1;
      row.options = candidates.map(recipe => ({ value: recipe.uuid, name: recipe.recipeName, selected: recipe === selected }));
      if (!selected) { row.error = auditLocalize("FALLOUTMAW.AuditApps.NoDismantlingRecipe", "Нет разбора"); continue; }
      entry.selectionUuid = selected.uuid;
      const { item: recipe, recipeId } = resolveCraftRecipeSelection(selected.uuid);
      row.recipe = recipe; row.recipeId = recipeId;
      if (!actorKnowsCraftItem(this.#actor, recipe) && recipe.system?.craft?.disassemblyRequiresRecipe) {
        row.error = auditLocalize("FALLOUTMAW.AuditApps.RecipeKnowledgeRequired", "Необходимо знание рецепта"); continue;
      }
      if (isNaturalRaceItem(item) || item.system?.locked) { row.error = auditLocalize("FALLOUTMAW.AuditApps.TheItemCannotBeDismantled", "Предмет недоступен для разбора"); continue; }
      if ((this.#actor.items.contents ?? []).some(child => getItemContainerParentId(child) === item.id)) {
        row.error = auditLocalize("FALLOUTMAW.AuditApps.EmptyTheContainerFirst", "Сначала освободите контейнер"); continue;
      }
      const craft = getCraftRenderData(recipe, this.#actor, CRAFT_MODE_DISASSEMBLY, { recipeId });
      const links = prepareCraftOperationLinks(craft.links, craft.nodes);
      for (const link of links) if (!link.noCheck) difficulty = Math.max(difficulty, link.difficulty);
      const sourceRequirements = craft.requirements.filter(req => craftItemMatchesRequirement(item, req));
      const perAttempt = sourceRequirements.reduce((sum, req) => sum + req.quantity, 0);
      row.perAttempt = perAttempt;
      if (!perAttempt || !links.length || !craft.outputs.length) { row.error = auditLocalize("FALLOUTMAW.AuditApps.InvalidDismantlingDiagram", "Некорректная схема разбора"); continue; }
      if (entry.quantity > getItemQuantity(item)) { row.error = auditLocalize("FALLOUTMAW.AuditApps.NotEnoughItems", "Не хватает предметов"); continue; }
      if (entry.quantity < perAttempt || entry.quantity % perAttempt) {
        row.error = auditFormat("FALLOUTMAW.AuditApps.DismantlingRequiresAQuantityDivisibleBy", { v0: (perAttempt) }, "Для разбора нужно количество, кратное {v0}"); continue;
      }
      row.repeats = entry.quantity / perAttempt;
      const unmet = getUnmetCraftSkillThreshold(this.#actor, links);
      if (unmet) { row.error = getCraftSkillThresholdMessage(unmet, CRAFT_MODE_DISASSEMBLY); continue; }
      row.requirements = craft.requirements.map(req => ({ ...req, ...(sourceRequirements.includes(req) ? { itemId: item.id, stackOrder: entry.stackOrder } : {}) }));
      try { createCraftRequirementSpendPlan(this.#actor, row.requirements.map(req => ({ ...req, quantity: req.quantity * row.repeats }))); }
      catch (error) { row.error = error.message; continue; }
      const toolPlan = createCraftToolRequirementSpendPlan(this.#actor, craft.toolRequirements);
      if (!toolPlan.valid) { row.error = toolPlan.message; continue; }
      row.toolSelections = Object.fromEntries([...toolPlan.selectedByRequirement].map(([key, tool]) => [key, tool.id]));
      for (const req of craft.toolRequirements) {
        const key = `${item.id}:${req.key}`;
        tools.push({ ...req, key, quantity: req.quantity * row.repeats });
        toolSelections[key] = row.toolSelections[req.key];
      }
      requirements.push(...row.requirements.map(req => ({ ...req, quantity: req.quantity * row.repeats })));
      const resources = prepareCraftDisassemblyResources(this.#actor, row.requirements, craft.outputs);
      row.outputs = [...resources.outputs, ...resources.embedded];
      if (resources.embedded.some(output => !output.data)) row.error = auditLocalize("FALLOUTMAW.AuditApps.EmbeddedItemNotFound", "Не найден встроенный предмет");
      row.randomOutputs = craft.nodes.some(node => !node.root && Number(node.blockLimit) > 0);
      randomOutputs ||= row.randomOutputs;
    }
    const fullToolPlan = createCraftToolRequirementSpendPlan(this.#actor, tools, toolSelections);
    if (!fullToolPlan.valid) for (const row of rows) if (!row.error && Object.keys(row.toolSelections ?? {}).length) row.error = fullToolPlan.message;
    const selectedIds = new Set(rows.map(row => row.itemId));
    for (const row of rows) if (!row.error && Object.values(row.toolSelections ?? {}).some(id => selectedIds.has(id))) row.error = auditLocalize("FALLOUTMAW.AuditApps.TheToolIsAlsoSelectedForDismantling", "Инструмент также выбран для разбора");
    try { createCraftRequirementSpendPlan(this.#actor, requirements); }
    catch (error) { for (const row of rows) if (!row.error) row.error = error.message; }
    for (const row of rows) {
      if (row.error) continue;
      for (const output of row.outputs ?? []) {
        if (output.quantity <= 0 && !(output.fullQuantity > 0)) continue;
        const item = output.data ?? resolveWorldItemSync(output.sourceUuid);
        if (!item) { row.error = auditLocalize("FALLOUTMAW.AuditApps.DismantlingResultNotFound", "Не найден результат разбора"); continue; }
        const key = output.data ? `${output.sourceUuid}:${getCraftItemFingerprint(output.data)}` : output.sourceUuid;
        const current = outputTotals.get(key) ?? { uuid: output.sourceUuid, name: item.name, img: item.img, quantity: 0, fullQuantity: 0, embedded: Boolean(output.embedded) };
        current.quantity += output.quantity * row.repeats;
        current.fullQuantity += (output.fullQuantity ?? output.quantity) * row.repeats;
        current.quantityLabel = formatCraftYieldQuantity(current.quantity, current.fullQuantity);
        outputTotals.set(key, current);
      }
    }
    return { rows, outputs: [...outputTotals.values()], difficulty, randomOutputs,
      canRun: Boolean(rows.length && rows.every(row => !row.error) && !this.#busy && this.#actor?.isOwner),
      busy: this.#busy, checks: !isSkillThresholdMode(getCraftingSettings().craft.mode) };
  }

  #syncBulkInventorySelection() {
    const groups = new Map();
    for (const element of this.element?.querySelectorAll(".fallout-maw-craft-window-inventory [data-item-id][data-search-actor-uuid]") ?? []) {
      element.querySelector(":scope > .fallout-maw-bulk-shade")?.remove();
      const id = element.dataset.itemId;
      const group = groups.get(id) ?? []; group.push(element); groups.set(id, group);
    }
    for (const [id, elements] of groups) {
      const entry = this.#bulkEntries.get(id);
      if (!entry?.quantity) continue;
      const order = entry.stackOrder ?? [];
      const priority = el => { const index = order.indexOf(Number(el.dataset.stackIndex) || 0); return index < 0 ? order.length + (Number(el.dataset.stackIndex) || 0) : index; };
      const allocations = new Map();
      let remaining = entry.quantity;
      for (const element of elements.sort((a,b) => priority(a)-priority(b))) {
        const stackIndex = Number(element.dataset.stackIndex) || 0;
        const total = Number(element.dataset.stackQuantity) || getItemQuantity(this.#actor?.items.get(id));
        if (!allocations.has(stackIndex)) { allocations.set(stackIndex, Math.min(remaining, total)); remaining = Math.max(0, remaining-total); }
        const selected = allocations.get(stackIndex);
        if (!selected) continue;
        const shade = element.ownerDocument.createElement("span");
        shade.className = `fallout-maw-bulk-shade${selected < total ? " partial" : ""}`;
        shade.setAttribute("aria-hidden", "true"); element.append(shade);
      }
    }
  }

  #bindBulkControls() {
    this.#syncBulkInventorySelection();
    for (const button of this.element?.querySelectorAll("[data-bulk-open]") ?? []) {
      button.textContent = this.#getActiveCraftTab()?.bulk ? auditLocalize("FALLOUTMAW.AuditApps.AutomaticFilling", "Автоматическое заполнение") : auditLocalize("FALLOUTMAW.AuditApps.BulkDismantling", "Массовый разбор");
      button.disabled = this.#busy;
    }
    const bind = (selector, callback, type = "click") => {
      for (const element of this.element?.querySelectorAll(selector) ?? []) {
        if (element.dataset.bulkBound) continue;
        element.dataset.bulkBound = "true";
        element.addEventListener(type, event => { event.preventDefault(); event.stopPropagation(); if (!this.#busy) void callback(event, element); });
      }
    };
    bind("[data-bulk-open]", () => this.#getActiveCraftTab()?.bulk ? this.#autoFillBulk() : this.#openBulk());
    bind("[data-bulk-remove]", async (_event, element) => { this.#bulkEntries.delete(element.dataset.bulkRemove); await this.#updateCraftPanel(); });
    bind("[data-bulk-clear]", async () => { this.#bulkEntries.clear(); await this.#updateCraftPanel(); });
    bind("[data-bulk-recipe]", async (_event, element) => { const entry = this.#bulkEntries.get(element.dataset.bulkRecipe); if (entry) entry.selectionUuid = element.value; await this.#updateCraftPanel(); }, "change");
    bind("[data-bulk-quantity]", async (_event, element) => {
      const entry = this.#bulkEntries.get(element.dataset.bulkQuantity), item = this.#actor?.items.get(entry?.itemId);
      if (!item) return;
      const quantity = await promptSearchItemStackQuantity({ item, title: auditLocalize("FALLOUTMAW.AuditApps.BulkDismantling", "Массовый разбор"), actionLabel: auditLocalize("FALLOUTMAW.Common.Edit", "Изменить"), max: getItemQuantity(item), value: entry.quantity });
      if (quantity) { entry.quantity = quantity; await this.#updateCraftPanel(); }
    });
    bind("[data-bulk-run]", () => this.#runBulk());
  }

  async #runBulk() {
    if (this.#busy || this.#bulkRunPending) return;
    this.#bulkRunPending = true;
    let preview;
    try { preview = await this.#prepareBulkContext(); }
    finally { this.#bulkRunPending = false; }
    if (!preview.canRun) { await this.#updateCraftPanel(); return; }
    this.#busy = true;
    await this.#updateCraftPanel();
    const collector = createSkillCheckBatchCollector({ requester: auditLocalize("FALLOUTMAW.Craft.Disassembly", "Разбор"), title: auditLocalize("FALLOUTMAW.AuditApps.BulkDismantling", "Массовый разбор") });
    let completed = 0, dropped = false;
    try {
      const expectedItems = this.#actor.items.contents.map(item => item.toObject());
      const operations = [];
      for (const row of preview.rows) {
        const repetitions = !preview.checks && !row.randomOutputs ? row.repeats : 1;
        for (let attempt = 0; attempt < row.repeats; attempt += repetitions) {
          const validation = await validateCraftRequest(this.#actor, row.recipe, CRAFT_MODE_DISASSEMBLY, row.toolSelections, row.recipeId, { sourceItemId: row.itemId });
          if (!validation.valid) throw new Error(validation.message);
          const item = this.#actor.items.get(row.itemId);
          if (!item) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.TheItemIsNoLongerInTheInventory", "Предмета больше нет в инвентаре"));
          if (item.system?.locked || (this.#actor.items.contents ?? []).some(child => getItemContainerParentId(child) === item.id)) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.TheItemIsLockedOrContainsOtherItems", "Предмет заблокирован или содержит другие предметы"));
          validation.requirements = validation.requirements.map(req => ({ ...req, ...(craftItemMatchesRequirement(item, req) ? { itemId: row.itemId, stackOrder: row.stackOrder } : {}) }));
          createCraftRequirementSpendPlan(this.#actor, validation.requirements);
          const linkResults = await this.#resolveCraftLinkResults(this.#actor, validation.links, { createMessages: false, collector, mode: CRAFT_MODE_DISASSEMBLY });
          if (!linkResults) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.DismantlingCheckCanceled", "Проверка разбора отменена"));
          const operation = { ...this.#buildCraftOperation(this.#actor, row.recipe, validation, linkResults),
            mode: CRAFT_MODE_DISASSEMBLY, recipeId: row.recipeId, repetitions, suppressOverflowNotification: true };
          if (repetitions > 1) {
            for (const key of ["requirements", "toolRequirements", "outputs"]) {
              operation[key] = (operation[key] ?? []).map(entry => ({ ...entry, quantity: entry.quantity * repetitions }));
            }
          }
          operations.push(operation);
        }
      }
      const result = await applyBulkCraftOperations(this.#actor, operations, expectedItems);
      dropped = Boolean(result?.dropped);
      completed = preview.rows.reduce((sum, row) => sum + row.repeats, 0);
      invalidateCraftRecipeAvailabilityCaches();
      for (const row of preview.rows) {
        const entry = this.#bulkEntries.get(row.itemId);
        if (entry) { entry.quantity -= row.perAttempt * row.repeats; if (entry.quantity <= 0) this.#bulkEntries.delete(row.itemId); }
      }
    } catch (error) { console.error(`${SYSTEM_ID} | Bulk disassembly`, error); ui.notifications.warn(error.message || auditLocalize("FALLOUTMAW.AuditApps.DismantlingStopped", "Разбор остановлен")); }
    finally {
      try { if (collector.size) await collector.publish({ forceBatch: true }); }
      finally { await Promise.allSettled([collector.abort()]); this.#busy = false; await this.#renderPreservingWindowStack(); }
      if (dropped) ui.notifications.warn(auditLocalize("FALLOUTMAW.AuditApps.ThereWasNotEnoughInventorySpaceExcessItems", "В инвентаре не хватило места, лишние предметы выброшены на землю."));
      else if (completed) ui.notifications.info(auditFormat("FALLOUTMAW.AuditApps.BulkDismantlingCompleted", { v0: (completed) }, "Массовый разбор: выполнено {v0}"));
    }
  }

  #resetCraftTabs() {
    this.#selectedRecipeUuid = "";
    this.#selectedRecipeId = DEFAULT_CRAFT_RECIPE_ID;
    this.#selectedRecipe = null;
    this.#acquisitionTargetUuid = "";
    this.#usageTargetUuid = "";
    this.#craftMode = CRAFT_MODE_CREATE;
    this.#craftToolPickerNodeId = "";
    this.#craftViewportOverride = null;
    this.#expandedRecipeNodes = new Set();
    this.#recipeSearch = "";
    this.#craftTabs = [];
    const tab = this.#createCraftTab();
    this.#craftTabs = [tab];
    this.#activeCraftTabId = tab.id;
    this.#loadCraftTabState(tab);
  }

  #ensureCraftTabs() {
    if (this.#craftTabs.length && this.#craftTabs.some(tab => tab.id === this.#activeCraftTabId)) return;
    const tab = this.#createCraftTab();
    this.#craftTabs = [tab];
    this.#activeCraftTabId = tab.id;
    this.#loadCraftTabState(tab);
  }

  #createCraftTab(data = {}) {
    const index = this.#craftTabs.length + 1;
    const id = String(data.id ?? foundry.utils.randomID());
    return {
      id,
      bulk: Boolean(data.bulk),
      returnTabId: String(data.returnTabId ?? ""),
      name: String(data.name ?? `${DEFAULT_CRAFT_TAB_NAME()} ${index}`),
      mode: normalizeCraftMode(data.mode),
      selectedRecipeUuid: String(data.selectedRecipeUuid ?? ""),
      selectedRecipeId: String(data.selectedRecipeId ?? DEFAULT_CRAFT_RECIPE_ID) || DEFAULT_CRAFT_RECIPE_ID,
      craftResourceOptions: foundry.utils.deepClone(data.craftResourceOptions ?? {}),
      acquisitionTargetUuid: String(data.acquisitionTargetUuid ?? ""),
      usageTargetUuid: String(data.usageTargetUuid ?? ""),
      usageKind: String(data.usageKind ?? "usage"),
      recipeSearch: String(data.recipeSearch ?? ""),
      expandedRecipeCategories: Array.from(data.expandedRecipeNodes ?? data.expandedRecipeCategories ?? []),
      craftViewportOverride: data.craftViewportOverride ? foundry.utils.deepClone(data.craftViewportOverride) : null,
      craftToolPickerNodeId: String(data.craftToolPickerNodeId ?? ""),
      craftRepeatCount: Math.max(0, toInteger(data.craftRepeatCount))
    };
  }

  #getActiveCraftTab() {
    this.#ensureCraftTabs();
    return this.#craftTabs.find(tab => tab.id === this.#activeCraftTabId) ?? this.#craftTabs[0] ?? null;
  }

  #saveActiveCraftTabState() {
    const tab = this.#craftTabs.find(entry => entry.id === this.#activeCraftTabId);
    if (!tab) return;
    tab.mode = this.#craftMode;
    tab.selectedRecipeUuid = this.#selectedRecipeUuid;
    tab.selectedRecipeId = this.#selectedRecipeId;
    tab.craftResourceOptions = foundry.utils.deepClone(this.#craftResourceOptions);
    tab.acquisitionTargetUuid = this.#acquisitionTargetUuid;
    tab.usageTargetUuid = this.#usageTargetUuid;
    tab.usageKind = this.#usageKind;
    tab.recipeSearch = this.#recipeSearch;
    tab.expandedRecipeNodes = Array.from(this.#expandedRecipeNodes);
    tab.craftViewportOverride = this.#craftViewportOverride ? foundry.utils.deepClone(this.#craftViewportOverride) : null;
    tab.craftToolPickerNodeId = this.#craftToolPickerNodeId;
    tab.craftRepeatCount = this.#craftRepeatCount;
    this.#updateCraftTabTitle(tab);
  }

  #loadCraftTabState(tab = this.#getActiveCraftTab()) {
    if (!tab) return;
    this.#activeCraftTabId = tab.id;
    this.#craftMode = normalizeCraftMode(tab.mode);
    this.#selectedRecipeUuid = String(tab.selectedRecipeUuid ?? "");
    this.#selectedRecipeId = String(tab.selectedRecipeId ?? DEFAULT_CRAFT_RECIPE_ID) || DEFAULT_CRAFT_RECIPE_ID;
    this.#craftResourceOptions = foundry.utils.deepClone(tab.craftResourceOptions ?? {});
    this.#selectedRecipe = null;
    this.#acquisitionTargetUuid = String(tab.acquisitionTargetUuid ?? "");
    this.#usageTargetUuid = String(tab.usageTargetUuid ?? "");
    this.#usageKind = String(tab.usageKind ?? "usage");
    this.#recipeSearch = String(tab.recipeSearch ?? "");
    this.#expandedRecipeNodes = new Set(Array.from(tab.expandedRecipeNodes ?? tab.expandedRecipeCategories ?? []));
    this.#craftViewportOverride = tab.craftViewportOverride ? foundry.utils.deepClone(tab.craftViewportOverride) : null;
    this.#craftToolPickerNodeId = String(tab.craftToolPickerNodeId ?? "");
    this.#craftRepeatCount = Math.max(0, toInteger(tab.craftRepeatCount));
  }

  #updateActiveCraftTabTitle(recipe = this.#selectedRecipe) {
    this.#updateCraftTabTitle(this.#getActiveCraftTab(), recipe);
  }

  #updateCraftTabTitle(tab = null, recipe = null) {
    if (!tab) return;
    if (tab.bulk) { tab.name = auditLocalize("FALLOUTMAW.AuditApps.BulkDismantling", "Массовый разбор"); return; }
    const acquisitionTarget = tab.acquisitionTargetUuid ? resolveCraftAcquisitionTargetItem(tab.acquisitionTargetUuid) : null;
    if (acquisitionTarget) {
      tab.name = auditFormat("FALLOUTMAW.AuditApps.Methods", { v0: (String(acquisitionTarget.name ?? "").trim() || auditLocalize("FALLOUTMAW.AuditApps.Item", "предмет")) }, "Способы: {v0}");
      return;
    }
    const usageTarget = tab.usageTargetUuid ? resolveCraftAcquisitionTargetItem(tab.usageTargetUuid) : null;
    if (usageTarget) {
      const prefix = tab.usageKind === "ammo" ? auditLocalize("FALLOUTMAW.AuditApps.Ammunition", "Боеприпасы") : tab.usageKind === "modules" ? auditLocalize("FALLOUTMAW.AuditApps.Modules", "Модули") : auditLocalize("FALLOUTMAW.AuditApps.UsedIn", "Участвует");
      tab.name = `${prefix}: ${String(usageTarget.name ?? "").trim() || auditLocalize("FALLOUTMAW.AuditApps.Item", "предмет")}`;
      return;
    }
    const selection = tab.selectedRecipeUuid ? resolveCraftRecipeSelection(tab.selectedRecipeUuid) : null;
    const source = recipe ?? selection?.item ?? null;
    if (!source) {
      tab.name = `${DEFAULT_CRAFT_TAB_NAME()} ${Math.max(1, this.#craftTabs.indexOf(tab) + 1)}`;
      return;
    }
    const summary = craftRecipeCatalog?.byUuid.get(tab.selectedRecipeUuid) ?? source;
    tab.name = getCraftRecipeDisplayName(summary);
  }

  #getCraftTabsContext() {
    this.#ensureCraftTabs();
    return this.#craftTabs.map((tab, index) => ({
      id: tab.id,
      name: tab.name || `${DEFAULT_CRAFT_TAB_NAME()} ${index + 1}`,
      active: tab.id === this.#activeCraftTabId,
      mode: normalizeCraftMode(tab.mode),
      icon: normalizeCraftMode(tab.mode) === CRAFT_MODE_DISASSEMBLY ? "fa-screwdriver-wrench" : "fa-hammer",
      canClose: this.#craftTabs.length > 1
    }));
  }

  #syncCraftTabsDom() {
    const tabs = this.#getCraftTabsContext();
    for (const tabElement of this.element?.querySelectorAll("[data-craft-tab-id]") ?? []) {
      const tab = tabs.find(entry => entry.id === tabElement.dataset.craftTabId);
      if (!tab) continue;
      const shell = tabElement.closest("[data-craft-tab-shell]");
      tabElement.classList.toggle("active", tab.active);
      tabElement.setAttribute("aria-selected", tab.active ? "true" : "false");
      shell?.classList.toggle("active", tab.active);
      const name = tabElement.querySelector("[data-craft-tab-name]");
      if (name) {
        name.textContent = tab.name;
        name.setAttribute("title", tab.name);
      }
      const icon = tabElement.querySelector("i");
      if (icon) {
        icon.classList.toggle("fa-hammer", tab.icon === "fa-hammer");
        icon.classList.toggle("fa-screwdriver-wrench", tab.icon === "fa-screwdriver-wrench");
      }
    }
  }

  #activateCraftTabs() {
    this.element?.querySelectorAll("[data-craft-tab-id]").forEach(button => {
      button.addEventListener("click", event => {
        if (event.target?.closest?.("[data-craft-tab-close]")) return;
        event.preventDefault();
        if (this.#busy) return;
        this.#selectCraftTab(String(button.dataset.craftTabId ?? ""));
      });
    });
    this.element?.querySelectorAll("[data-craft-tab-close]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        if (this.#busy || button.classList.contains("disabled")) return;
        this.#closeCraftTab(String(button.dataset.craftTabClose ?? ""));
      });
    });
    this.element?.querySelector("[data-craft-tab-add]")?.addEventListener("click", event => {
      event.preventDefault();
      if (this.#busy) return;
      this.#addCraftTab();
    });
  }

  #selectCraftTab(tabId = "") {
    const tab = this.#craftTabs.find(entry => entry.id === tabId);
    if (!tab || tab.id === this.#activeCraftTabId) return;
    this.#saveActiveCraftTabState();
    this.#loadCraftTabState(tab);
    this.#clearInventoryTooltip({ force: true });
    void this.#renderPreservingWindowStack();
  }

  #addCraftTab(data = {}) {
    this.#ensureCraftTabs();
    this.#saveActiveCraftTabState();
    const tab = this.#createCraftTab(data);
    this.#craftTabs.push(tab);
    this.#loadCraftTabState(tab);
    this.#updateActiveCraftTabTitle();
    this.#clearInventoryTooltip({ force: true });
    return this.#renderPreservingWindowStack();
  }

  #getCraftReturnTab() {
    const active = this.#getActiveCraftTab();
    return this.#craftTabs.find(tab => tab.id === active?.returnTabId && tab.id !== active.id) ?? null;
  }

  #returnFromCraftTab() {
    if (this.#busy) return;
    const target = this.#getCraftReturnTab();
    if (!target) return;
    const closingId = this.#activeCraftTabId;
    this.#craftTabs = this.#craftTabs.filter(tab => tab.id !== closingId);
    this.#loadCraftTabState(target);
    this.#clearCraftContextOverlays();
    return this.#renderPreservingWindowStack();
  }

  #closeCraftTab(tabId = "") {
    if (this.#craftTabs.length <= 1) return;
    const index = this.#craftTabs.findIndex(tab => tab.id === tabId);
    if (index < 0) return;
    const closingActive = this.#activeCraftTabId === tabId;
    this.#craftTabs.splice(index, 1);
    if (closingActive) {
      const next = this.#craftTabs[Math.min(index, this.#craftTabs.length - 1)] ?? this.#craftTabs[0];
      this.#loadCraftTabState(next);
    }
    this.#clearInventoryTooltip({ force: true });
    void this.#renderPreservingWindowStack();
  }

  get _dragDrop() {
    return this.#dragDrop ??= new foundry.applications.ux.DragDrop.implementation({
      dragSelector: ".draggable",
      dropSelector: "[data-search-root]",
      permissions: {
        dragstart: this._canDragStart.bind(this),
        drop: this._canDragDrop.bind(this)
      },
      callbacks: {
        dragstart: this._onDragStart.bind(this),
        dragover: this._onDragOver.bind(this),
        dragleave: this._onDragLeave.bind(this),
        drop: this._onDrop.bind(this),
        dragend: this._onDragEnd.bind(this)
      }
    });
  }

  setPosition(position = {}) {
    const fullscreenPosition = this.#getFullscreenPosition(position);
    const result = super.setPosition(fullscreenPosition);
    this.#applyUiScale(fullscreenPosition.scale);
    return result;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    this.#ensureCraftTabs();
    this.#actor = await resolveActor(this.#actorUuid);
    const recipes = await getCraftRecipeSummaries(this.#actor);
    const modeRecipes = recipes.filter(recipe => (recipe.known !== false || (this.#craftMode === CRAFT_MODE_DISASSEMBLY && canUseOwnedDisassembly(this.#actor, resolveWorldItemSync(recipe.itemUuid)))) && hasCraftRecipeDataForMode(recipe.system?.craft, this.#craftMode));
    if (this.#selectedRecipeUuid && !modeRecipes.some(recipe => recipe.uuid === this.#selectedRecipeUuid)) {
      this.#selectedRecipeUuid = "";
      this.#selectedRecipe = null;
    }
    let acquisitionTarget = this.#acquisitionTargetUuid ? resolveCraftAcquisitionTargetItem(this.#acquisitionTargetUuid) : null;
    if (this.#acquisitionTargetUuid && !acquisitionTarget) {
      this.#acquisitionTargetUuid = "";
      acquisitionTarget = null;
    }
    let usageTarget = this.#usageTargetUuid ? resolveCraftAcquisitionTargetItem(this.#usageTargetUuid) : null;
    if (this.#usageTargetUuid && !usageTarget) {
      this.#usageTargetUuid = "";
      usageTarget = null;
    }

    const selectedSelection = this.#selectedRecipeUuid ? resolveCraftRecipeSelection(this.#selectedRecipeUuid) : null;
    const selectedRecipe = selectedSelection?.item ?? null;
    this.#selectedRecipeId = selectedSelection?.recipeId ?? DEFAULT_CRAFT_RECIPE_ID;
    this.#selectedRecipe = selectedRecipe;
    const actorContext = prepareSearchActorContext(this.#actor, {
      side: "searcher",
      roleLabel: "",
      canInteract: Boolean(this.#actor?.isOwner && !this.#busy),
      mode: "search",
      showLockedItems: true
    }) ?? createEmptyActorContext(this.#actor);
    const craft = selectedRecipe
      ? prepareCraftContext(selectedRecipe, this.#actor, {
        busy: this.#busy,
        mode: this.#craftMode,
        recipeId: this.#selectedRecipeId,
        resourceOptions: this.#craftResourceOptions,
        toolPickerNodeId: this.#craftToolPickerNodeId,
        toolSelections: this.#getCraftToolSelections(this.#selectedRecipeUuid, this.#craftMode)
      })
      : createEmptyCraftContext(this.#busy);
    const acquisition = acquisitionTarget ? await this.#prepareAcquisitionWaysContext(acquisitionTarget) : null;
    const usage = usageTarget ? await this.#prepareUsageCraftsContext(usageTarget) : null;
    craft.canReturn = !this.#busy && Boolean(this.#getCraftReturnTab());
    if (acquisition) {
      craft.acquisition = acquisition;
      craft.canShowAcquisitionWays = false;
      craft.summary = auditFormat("FALLOUTMAW.AuditApps.AcquisitionMethods", { v0: (acquisition.entries.length) }, "{v0} способов получения");
      this.#craftLinkData = { nodes: [], links: [] };
    } else if (usage) {
      craft.usage = usage;
      craft.canShowAcquisitionWays = false;
      craft.summary = usage.summary;
      this.#craftLinkData = { nodes: [], links: [] };
    } else {
      const hasWays = selectedRecipe ? hasAcquisitionWaysForItem(selectedRecipe) : false;
      craft.canShowAcquisitionWays = hasWays;
      this.#craftLinkData = selectedRecipe ? { nodes: craft.nodes ?? [], links: craft.links ?? [] } : { nodes: [], links: [] };
    }
    if (selectedRecipe) {
      this.#rememberDefaultCraftToolSelections(this.#selectedRecipeUuid, this.#craftMode, craft.toolRequirements);
      if (!acquisition && !usage) this.#prepareCraftRepeatContext(craft);
    }
    const selectedRecipeSummary = craftRecipeCatalog?.byUuid.get(this.#selectedRecipeUuid) ?? null;
    // Opening a recipe must not unfold the browser: the folder tree is always
    // rendered from the tab's own expansion state and starts fully collapsed.
    this.#updateActiveCraftTabTitle(selectedRecipeSummary ?? selectedRecipe);
    this.#saveActiveCraftTabState();

    const recipeList = prepareCraftRecipeCategories(recipes, {
      expandedKeys: this.#expandedRecipeNodes,
      mode: this.#craftMode,
      search: this.#recipeSearch,
      selectedRecipeUuid: this.#selectedRecipeUuid,
      actor: this.#actor
    });

    const preparedContext = {
      ...context,
      actor: actorContext,
      bulk: this.#getActiveCraftTab()?.bulk ? await this.#prepareBulkContext() : null,
      craftTabs: this.#getCraftTabsContext(),
      recipeCategories: recipeList.categories,
      recipeSearch: this.#recipeSearch,
      recipe: acquisitionTarget || usageTarget || selectedRecipe ? {
        uuid: acquisitionTarget?.uuid ?? usageTarget?.uuid ?? selectedRecipe.uuid,
        name: acquisitionTarget
          ? String(acquisitionTarget.name ?? "")
          : (usageTarget
            ? String(usageTarget.name ?? "")
            : getCraftRecipeDisplayName(selectedRecipeSummary ?? selectedRecipe)),
        img: normalizeImagePath(acquisitionTarget?.img ?? usageTarget?.img ?? selectedRecipe?.img, FALLBACK_ICON)
      } : null,
      inventory: actorContext.inventory,
      craftMode: this.#craftMode,
      craftModes: getCraftModeChoices(this.#craftMode),
      craft,
      load: actorContext.load
    };
    return preparedContext;
  }

  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    this.#renderRefresh = foundry.utils.debounce(() => {
      if (!this.rendered || this.#contentsTransfer.renderBatch.active) return;
      this.#captureScrollPositions();
      this.#clearInventoryTooltip({ force: true });
      void this.#renderPreservingWindowStack();
    }, 60);
    this.#hookIds = [
      ["updateActor", Hooks.on("updateActor", (actor, _changes, hookOptions = {}) => {
        if (!hookOptions?.falloutMawCombatMovementResourceUpdate) this.#scheduleRefreshForActor(actor);
      })],
      ["deleteActor", Hooks.on("deleteActor", actor => this.#scheduleRefreshForActor(actor))],
      ["createItem", Hooks.on("createItem", item => this.#scheduleRefreshForItem(item))],
      ["updateItem", Hooks.on("updateItem", (item, changes = {}, hookOptions = {}) => {
        if (!isDeusExMachinaProgressItemUpdate(changes, hookOptions)) {
          this.#scheduleRefreshForItem(item);
        }
      })],
      ["deleteItem", Hooks.on("deleteItem", item => this.#scheduleRefreshForItem(item))]
    ];
  }

  render(...args) {
    if (this.#contentsTransfer.renderBatch.defer(args)) return Promise.resolve(this);
    return super.render(...args);
  }

  async _preRender(context, options) {
    if (this.element?.isConnected) this.#captureScrollPositions();
    await super._preRender(context, options);
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#renderedActorUuid = this.#actorUuid;
    this.#hoverPreviewInputKey = "";
    this.#hoverPreviewKey = "";
    this.setPosition();
    this.#bindViewportResize();
    this._dragDrop.bind(this.element);
    this.#bindInventoryListeners();
    this.#contentsTransfer.bind(this.element, {
      application: this,
      getActor: () => this.#actor,
      beforeTransfer: () => {
        this.#renderRefresh?.cancel?.();
        this.#captureScrollPositions();
        this.#saveActiveCraftTabState();
      },
      afterTransfer: () => this.#renderRefresh?.cancel?.(),
      canUse: () => this._canDragDrop(),
      canTransfer: canTransferOwnedContents,
      onSelect: () => this.#clearInventoryTooltip({ force: true })
    });
    this.#activateWeaponSlotAspectSizing();
    this.#restoreScrollPositions();
    this.#activateCraftTabs();
    this.#activateControls();
    this.#activateCraftViewer();
    this.#startPendingOperation();
    this.#rememberActorWorkspace();
}

  #renderPreservingWindowStack(options = {}) {
    if (this.rendered) this.#captureScrollPositions();
    this.#saveActiveCraftTabState();
    return this.render({ ...options, force: !this.rendered });
  }

  async close(options = {}) {
    this.#captureScrollPositions();
    this.#rememberActorWorkspace();
    return super.close(options);
  }

  async _onClose(options) {
    await super._onClose(options);
    this.#contentsTransfer.destroy();
    this.#craftBatchSummaryClose?.();
    if (this.#recipeListRenderFrame) cancelAnimationFrame(this.#recipeListRenderFrame);
    this.#recipeListRenderFrame = 0;
    this.#unbindViewportResize();
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    this.#clearInventoryDropPreview();
    this.#clearInventoryTooltip({ force: true });
    this.#unbindInventoryTooltipDocumentClose();
    document.querySelectorAll(".fallout-maw-inventory-context-menu").forEach(menu => menu.remove());
    for (const [hookName, hookId] of this.#hookIds) Hooks.off(hookName, hookId);
    this.#hookIds = [];
    this.#scrollPositions.clear();
    if (craftWindow === this) craftWindow = null;
  }

  #getFullscreenPosition(position = {}) {
    const { viewportWidth, viewportHeight } = this.#getViewportMetrics();
    const scale = Math.max(
      0.1,
      Math.min(
        viewportWidth / CRAFT_WINDOW_REFERENCE_WIDTH,
        viewportHeight / CRAFT_WINDOW_REFERENCE_HEIGHT
      ) || 1
    );
    const width = CRAFT_WINDOW_REFERENCE_WIDTH;
    const height = CRAFT_WINDOW_REFERENCE_HEIGHT;
    return {
      ...position,
      left: Math.max(0, (viewportWidth - (width * scale)) / 2),
      top: Math.max(0, (viewportHeight - (height * scale)) / 2),
      width,
      height,
      scale
    };
  }

  #getViewportMetrics() {
    const view = this.element?.ownerDocument?.defaultView ?? window;
    const documentElement = view.document?.documentElement ?? document.documentElement;
    return {
      view,
      viewportWidth: view.innerWidth || documentElement?.clientWidth || CRAFT_WINDOW_FALLBACK_VIEWPORT_WIDTH,
      viewportHeight: view.innerHeight || documentElement?.clientHeight || CRAFT_WINDOW_FALLBACK_VIEWPORT_HEIGHT
    };
  }

  #applyUiScale(scale = 1) {
    const normalizedScale = Math.max(0.1, Number(scale) || 1);
    this.#uiScale = normalizedScale;
    this.element?.style?.setProperty("--fallout-maw-ui-scale", String(normalizedScale));
  }

  #bindViewportResize() {
    if (this.#viewportResizeHandler) return;
    const view = this.element?.ownerDocument?.defaultView ?? window;
    this.#viewportResizeHandler = () => this.setPosition();
    view.addEventListener("resize", this.#viewportResizeHandler);
    this.#pageHideHandler = () => {
      this.#captureScrollPositions();
      this.#rememberActorWorkspace();
    };
    view.addEventListener("pagehide", this.#pageHideHandler);
  }

  #unbindViewportResize() {
    if (!this.#viewportResizeHandler) return;
    const view = this.element?.ownerDocument?.defaultView ?? window;
    view.removeEventListener("resize", this.#viewportResizeHandler);
    view.removeEventListener("pagehide", this.#pageHideHandler);
    this.#viewportResizeHandler = null;
    this.#pageHideHandler = null;
  }

  #activateWeaponSlotAspectSizing() {
    const images = this.element?.querySelectorAll(".fallout-maw-weapon-slot .fallout-maw-inventory-item > img") ?? [];
    for (const image of images) {
      const applyAspect = () => setWeaponSlotImageAspect(image);
      if (image.complete && image.naturalWidth && image.naturalHeight) applyAspect();
      else image.addEventListener("load", applyAspect, { once: true });
    }
  }

  #captureScrollPositions() {
    if (this.#renderedActorUuid !== this.#actorUuid) return;
    this.element?.querySelectorAll("[data-search-scroll-key]").forEach(element => {
      const key = String(element.dataset.searchScrollKey ?? "");
      if (!key) return;
      this.#scrollPositions.set(key, {
        left: element.scrollLeft ?? 0,
        top: element.scrollTop ?? 0
      });
    });
  }

  #restoreScrollPositions() {
    const view = this.element?.ownerDocument?.defaultView ?? window;
    view.requestAnimationFrame(() => {
      if (!this.rendered) return;
      for (const element of this.element?.querySelectorAll("[data-search-scroll-key]") ?? []) {
        const key = String(element.dataset.searchScrollKey ?? "");
        const position = this.#scrollPositions.get(key);
        if (!position) continue;
        element.scrollLeft = position.left;
        element.scrollTop = position.top;
      }
    });
  }

  #syncRecipeSelectionDom() {
    this.element?.querySelectorAll("[data-recipe-uuid]").forEach(element => {
      element.classList.toggle("selected", element.dataset.recipeUuid === this.#selectedRecipeUuid);
    });
    this.#syncCraftTabsDom();
  }

  async #prepareCraftPanelContext() {
    this.#actor ??= await resolveActor(this.#actorUuid);
    const selectedSelection = this.#selectedRecipeUuid ? resolveCraftRecipeSelection(this.#selectedRecipeUuid) : null;
    const selectedRecipe = selectedSelection?.item ?? null;
    let acquisitionTarget = this.#acquisitionTargetUuid ? resolveCraftAcquisitionTargetItem(this.#acquisitionTargetUuid) : null;
    if (this.#acquisitionTargetUuid && !acquisitionTarget) {
      this.#acquisitionTargetUuid = "";
      acquisitionTarget = null;
    }
    let usageTarget = this.#usageTargetUuid ? resolveCraftAcquisitionTargetItem(this.#usageTargetUuid) : null;
    if (this.#usageTargetUuid && !usageTarget) {
      this.#usageTargetUuid = "";
      usageTarget = null;
    }
    this.#selectedRecipeId = selectedSelection?.recipeId ?? DEFAULT_CRAFT_RECIPE_ID;
    this.#selectedRecipe = selectedRecipe;
    const craft = selectedRecipe
      ? prepareCraftContext(selectedRecipe, this.#actor, {
        busy: this.#busy,
        mode: this.#craftMode,
        recipeId: this.#selectedRecipeId,
        resourceOptions: this.#craftResourceOptions,
        toolPickerNodeId: this.#craftToolPickerNodeId,
        toolSelections: this.#getCraftToolSelections(this.#selectedRecipeUuid, this.#craftMode)
      })
      : createEmptyCraftContext(this.#busy);
    const acquisition = acquisitionTarget ? await this.#prepareAcquisitionWaysContext(acquisitionTarget) : null;
    const usage = usageTarget ? await this.#prepareUsageCraftsContext(usageTarget) : null;
    craft.canReturn = !this.#busy && Boolean(this.#getCraftReturnTab());
    if (acquisition) {
      craft.acquisition = acquisition;
      craft.canShowAcquisitionWays = false;
      craft.summary = auditFormat("FALLOUTMAW.AuditApps.AcquisitionMethods", { v0: (acquisition.entries.length) }, "{v0} способов получения");
      this.#craftLinkData = { nodes: [], links: [] };
    } else if (usage) {
      craft.usage = usage;
      craft.canShowAcquisitionWays = false;
      craft.summary = usage.summary;
      this.#craftLinkData = { nodes: [], links: [] };
    } else {
      const hasWays = selectedRecipe ? hasAcquisitionWaysForItem(selectedRecipe) : false;
      craft.canShowAcquisitionWays = hasWays;
      this.#craftLinkData = selectedRecipe ? { nodes: craft.nodes ?? [], links: craft.links ?? [] } : { nodes: [], links: [] };
    }
    if (selectedRecipe) {
      this.#rememberDefaultCraftToolSelections(this.#selectedRecipeUuid, this.#craftMode, craft.toolRequirements);
      if (!acquisition && !usage) this.#prepareCraftRepeatContext(craft);
    }
    this.#updateActiveCraftTabTitle(selectedRecipe);
    this.#saveActiveCraftTabState();
    return {
      bulk: this.#getActiveCraftTab()?.bulk ? await this.#prepareBulkContext() : null,
      recipe: acquisitionTarget || usageTarget || selectedRecipe ? {
        uuid: acquisitionTarget?.uuid ?? usageTarget?.uuid ?? selectedRecipe.uuid,
        name: acquisitionTarget
          ? String(acquisitionTarget.name ?? "")
          : (usageTarget ? String(usageTarget.name ?? "") : getCraftRecipeDisplayName(selectedRecipe)),
        img: normalizeImagePath(acquisitionTarget?.img ?? usageTarget?.img ?? selectedRecipe?.img, FALLBACK_ICON)
      } : null,
      craft,
      craftModes: getCraftModeChoices(this.#craftMode),
      craftMode: this.#craftMode
    };
  }

  #prepareCraftRepeatContext(craft = {}) {
    const repeatMax = craft.canCraft
      ? getCraftRepeatLimit(this.#actor, craft.requirements, craft.toolRequirements, this.#getCraftToolSelections())
      : 0;
    this.#craftRepeatCount = normalizeCraftRepeatCount(this.#craftRepeatCount, repeatMax);
    craft.repeatCount = this.#craftRepeatCount;
    craft.repeatMax = repeatMax;
    craft.repeatDisabled = Boolean(this.#busy || repeatMax < 1);
  }

  async #prepareAcquisitionWaysContext(targetItem) {
    if (!targetItem) return null;
    await getCraftRecipeSummaries(this.#actor);
    const { recipes: allCandidateRecipes, targetProfile } = findAcquisitionRecipesForItem(targetItem);
    const availability = this.#actor ? getCraftAvailabilityIndex(this.#actor) : null;
    const entries = buildAcquisitionWayEntries(targetItem, targetProfile, allCandidateRecipes, this.#actor, availability);

    entries.sort(compareCraftRecipeAvailability);
    return {
      targetUuid: targetItem.uuid,
      targetName: String(targetItem.name ?? ""),
      targetImg: normalizeImagePath(targetItem.img, FALLBACK_ICON),
      entries,
      empty: entries.length < 1
    };
  }

  async #prepareUsageCraftsContext(targetItem) {
    if (!targetItem) return null;
    const recipes = await getCraftRecipeSummaries(this.#actor);
    const isCompatibility = this.#usageKind === "ammo" || this.#usageKind === "modules";
    const availability = this.#actor ? getCraftAvailabilityIndex(this.#actor) : null;
    let entries;
    if (isCompatibility) {
      entries = buildCompatibleCraftEntries(targetItem, this.#usageKind, recipes, this.#actor, availability);
    } else {
      const { recipes: candidates, targetProfile } = findUsageRecipesForItem(targetItem);
      entries = buildUsageCraftEntries(targetItem, targetProfile, candidates, this.#actor, availability);
    }

    entries.sort(compareCraftRecipeAvailability);
    return {
      title: isCompatibility
        ? (this.#usageKind === "ammo" ? auditLocalize("FALLOUTMAW.AuditApps.CompatibleAmmunition", "Подходящие боеприпасы") : auditLocalize("FALLOUTMAW.Item.SuitableModules", "Подходящие модули"))
        : auditLocalize("FALLOUTMAW.AuditApps.ShowRecipesThatUseThisItem", "Показать в каких крафтах участвует"),
      emptyMessage: isCompatibility
        ? (this.#usageKind === "ammo" ? auditLocalize("FALLOUTMAW.AuditApps.ThereAreNoCraftingRecipesForCompatibleAmmunition", "Нет крафтов подходящих боеприпасов.") : auditLocalize("FALLOUTMAW.AuditApps.ThereAreNoCraftingRecipesForCompatibleModules", "Нет крафтов подходящих модулей."))
        : auditLocalize("FALLOUTMAW.AuditApps.ThereAreNoCraftingRecipesThatUseThis", "Нет крафтов, где используется этот предмет."),
      summary: `${entries.length} ${isCompatibility ? auditLocalize("FALLOUTMAW.AuditApps.CompatibleRecipes", "подходящих крафтов") : auditLocalize("FALLOUTMAW.AuditApps.RecipesUsingThisItem", "крафтов с участием")}`,
      targetUuid: targetItem.uuid,
      targetName: String(targetItem.name ?? ""),
      targetImg: normalizeImagePath(targetItem.img, FALLBACK_ICON),
      entries,
      empty: entries.length < 1
    };
  }

  async #updateCraftPanel() {
    const context = await this.#prepareCraftPanelContext();
    const html = await foundry.applications.handlebars.renderTemplate(TEMPLATES.craftWindowPanel, context);
    const panel = this.element?.querySelector(".fallout-maw-craft-window-craft");
    if (!panel) return;
    const wrapper = document.createElement("div");
    wrapper.innerHTML = html.trim();
    const replacement = wrapper.firstElementChild;
    if (!replacement) return;
    panel.replaceWith(replacement);
    this.#activateCraftPanelControls();
    this.#activateCraftViewer();
    this.#rememberActorWorkspace();
  }

  #activateCraftPanelControls() {
    this.#bindBulkControls();
    this.element?.querySelectorAll("[data-craft-mode]").forEach(button => {
      if (button.dataset.craftModeBound === "true") return;
      button.dataset.craftModeBound = "true";
      button.addEventListener("click", async event => {
        event.preventDefault();
        if (this.#busy) return;
        const mode = normalizeCraftMode(event.currentTarget?.dataset?.craftMode);
        if (mode === this.#craftMode) return;
        if (this.#getActiveCraftTab()?.bulk) { await this.#addCraftTab({ mode }); return; }
        this.#craftMode = mode;
        this.#craftResourceOptions = {};
        this.#selectedRecipe = null;
        this.#acquisitionTargetUuid = "";
        this.#usageTargetUuid = "";
        this.#craftViewportOverride = null;
        this.#craftToolPickerNodeId = "";
        this.#craftRepeatCount = 0;
        await getCraftRecipeSummaries(this.#actor);
        const selectedSummary = craftRecipeCatalog?.byUuid.get(this.#selectedRecipeUuid);
        if (this.#selectedRecipeUuid && !hasCraftRecipeDataForMode(selectedSummary?.system?.craft, mode)) {
          this.#selectedRecipeUuid = "";
        }
        this.#saveActiveCraftTabState();
        for (const modeButton of this.element?.querySelectorAll("[data-craft-mode]") ?? []) {
          const selected = normalizeCraftMode(modeButton.dataset.craftMode) === mode;
          modeButton.classList.toggle("active", selected);
          modeButton.setAttribute("aria-pressed", selected ? "true" : "false");
        }
        await Promise.all([this.#updateRecipeList(), this.#updateCraftPanel()]);
      });
    });
    this.element?.querySelectorAll("[data-craft-repeat-count]").forEach(input => {
      if (input.dataset.craftRepeatBound === "true") return;
      input.dataset.craftRepeatBound = "true";
      const syncValue = ({ commit = false } = {}) => {
        const max = Math.max(0, toInteger(input.max));
        const raw = input.valueAsNumber;
        if (Number.isFinite(raw)) this.#craftRepeatCount = normalizeCraftRepeatCount(raw, max);
        else if (commit) this.#craftRepeatCount = 0;
        if (commit) input.value = String(this.#craftRepeatCount);
        this.#saveActiveCraftTabState();
      };
      input.addEventListener("input", () => syncValue());
      input.addEventListener("change", () => syncValue({ commit: true }));
    });
    this.element?.querySelectorAll('[data-action="craft"]').forEach(button => {
      if (button.dataset.craftActionBound === "true") return;
      button.dataset.craftActionBound = "true";
      button.addEventListener("click", event => this.#onCraft(event));
    });
    this.element?.querySelectorAll('[data-action="showAcquisitionWays"]').forEach(button => {
      if (button.dataset.acquisitionWaysBound === "true") return;
      button.dataset.acquisitionWaysBound = "true";
      button.addEventListener("click", event => {
        event.preventDefault();
        const item = this.#selectedRecipe ?? resolveCraftAcquisitionTargetItem(this.#acquisitionTargetUuid);
        void this.#showAcquisitionWaysForItem(item);
      });
    });
    this.element?.querySelectorAll('[data-action="hideAcquisitionWays"]').forEach(button => {
      if (button.dataset.acquisitionBackBound === "true") return;
      button.dataset.acquisitionBackBound = "true";
      button.addEventListener("click", event => {
        event.preventDefault();
        void this.#returnFromCraftTab();
      });
    });
    this.element?.querySelectorAll("[data-acquisition-recipe-uuid]").forEach(entry => {
      if (entry.dataset.acquisitionRecipeBound === "true") return;
      entry.dataset.acquisitionRecipeBound = "true";
      const open = event => {
        event.preventDefault();
        const recipeUuid = String(entry.dataset.acquisitionRecipeUuid ?? "");
        if (!recipeUuid) return;
        this.openSelection({
          mode: normalizeCraftMode(entry.dataset.acquisitionRecipeMode),
          recipeSelectionUuid: recipeUuid
        });
        void this.#renderPreservingWindowStack();
      };
      entry.addEventListener("click", open);
      entry.addEventListener("keydown", event => {
        if (!["Enter", " "].includes(event.key)) return;
        open(event);
      });
    });
  }

  #activateControls() {
    const search = this.element?.querySelector("[data-craft-recipe-search]");
    search?.addEventListener("input", event => {
      this.#recipeSearch = String(event.currentTarget?.value ?? "");
      this.#saveActiveCraftTabState();
      this.#scheduleRecipeListUpdate();
    });
    const sidebar = this.element?.querySelector(".fallout-maw-craft-window-recipes");
    sidebar?.addEventListener("click", event => {
      const categoryToggle = event.target.closest("[data-craft-recipe-category-toggle]");
      const subcategoryToggle = event.target.closest("[data-craft-recipe-subcategory-toggle]");
      const classToggle = event.target.closest("[data-craft-recipe-class-toggle]");
      if (categoryToggle || subcategoryToggle || classToggle) {
        event.preventDefault();
        const key = String(
          categoryToggle?.dataset.craftRecipeCategoryToggle
          ?? subcategoryToggle?.dataset.craftRecipeSubcategoryToggle
          ?? classToggle?.dataset.craftRecipeClassToggle
          ?? ""
        );
        if (!key) return;
        const toggle = categoryToggle ?? subcategoryToggle ?? classToggle;
        if (toggle.getAttribute("aria-expanded") === "true") {
          // Folding a node also folds everything nested inside it.
          this.#expandedRecipeNodes = new Set(
            [...this.#expandedRecipeNodes].filter(entry => entry !== key && !entry.startsWith(`${key}:`))
          );
        } else {
          this.#expandedRecipeNodes.add(key);
        }
        this.#saveActiveCraftTabState();
        void this.#updateRecipeList();
        return;
      }

      const recipeButton = event.target.closest("[data-recipe-uuid]");
      if (!recipeButton || this.#busy) return;
      event.preventDefault();
      const recipeUuid = String(recipeButton.dataset.recipeUuid ?? "");
      if (this.#getActiveCraftTab()?.bulk) {
        this.openSelection({ mode: this.#craftMode, recipeSelectionUuid: recipeUuid });
        void this.#renderPreservingWindowStack();
        return;
      }
      if (recipeUuid === this.#selectedRecipeUuid && !this.#acquisitionTargetUuid && !this.#usageTargetUuid) return;
      this.#selectedRecipeUuid = recipeUuid;
      this.#craftResourceOptions = {};
      this.#selectedRecipe = null;
      this.#acquisitionTargetUuid = "";
      this.#usageTargetUuid = "";
      this.#craftViewportOverride = null;
      this.#craftToolPickerNodeId = "";
      this.#craftRepeatCount = 0;
      this.#updateActiveCraftTabTitle();
      this.#saveActiveCraftTabState();
      this.#syncRecipeSelectionDom();
      void this.#updateCraftPanel();
    });
    sidebar?.addEventListener("keydown", event => {
      if (!["Enter", " "].includes(event.key)) return;
      const actionable = event.target.closest("[data-craft-recipe-toggle], [data-recipe-uuid]");
      if (!actionable) return;
      event.preventDefault();
      actionable.click();
    });
    this.#activateCraftPanelControls();
  }

  #scheduleRecipeListUpdate() {
    if (this.#recipeListRenderFrame) return;
    this.#recipeListRenderFrame = requestAnimationFrame(() => {
      this.#recipeListRenderFrame = 0;
      void this.#updateRecipeList();
    });
  }

  /**
   * The recipe list is rebuilt by replacing the whole scroll container, so its
   * scrollTop has to be re-anchored by hand: assigning scrollTop to a detached
   * node is a no-op (its scrollHeight is still 0), and the browser's own scroll
   * anchoring cannot see the swap. We therefore remember which folder header sat
   * at the top of the viewport and put the same header back at the same offset.
   */
  #captureRecipeListAnchor(scroller) {
    if (!scroller) return null;
    const top = scroller.scrollTop;
    for (const header of scroller.querySelectorAll(
      "[data-craft-recipe-category-toggle], [data-craft-recipe-subcategory-toggle], [data-craft-recipe-class-toggle]"
    )) {
      const offset = header.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      if (offset >= -1) return { key: header.dataset.craftRecipeCategoryToggle
        ?? header.dataset.craftRecipeSubcategoryToggle
        ?? header.dataset.craftRecipeClassToggle
        ?? "", offset, top };
    }
    return { key: "", offset: 0, top };
  }

  #restoreRecipeListAnchor(scroller, anchor) {
    if (!scroller || !anchor) return;
    const apply = () => {
      if (!scroller.isConnected) return;
      if (!anchor.key) {
        scroller.scrollTop = anchor.top;
        return;
      }
      const header = [...scroller.querySelectorAll(
        "[data-craft-recipe-category-toggle], [data-craft-recipe-subcategory-toggle], [data-craft-recipe-class-toggle]"
      )].find(element => (element.dataset.craftRecipeCategoryToggle
        ?? element.dataset.craftRecipeSubcategoryToggle
        ?? element.dataset.craftRecipeClassToggle) === anchor.key);
      if (!header) {
        scroller.scrollTop = anchor.top;
        return;
      }
      const drift = (header.getBoundingClientRect().top - scroller.getBoundingClientRect().top) - anchor.offset;
      if (drift) scroller.scrollTop += drift;
    };
    apply();
    (this.element?.ownerDocument?.defaultView ?? window).requestAnimationFrame(apply);
  }

  async #updateRecipeList() {
    const current = this.element?.querySelector(".fallout-maw-craft-window-recipe-list");
    if (!current) return;
    const version = ++this.#recipeListRenderVersion;
    const anchor = normalizeCraftSearchText(this.#recipeSearch) ? null : this.#captureRecipeListAnchor(current);
    const recipes = await getCraftRecipeSummaries(this.#actor);
    const recipeList = prepareCraftRecipeCategories(recipes, {
      expandedKeys: this.#expandedRecipeNodes,
      mode: this.#craftMode,
      search: this.#recipeSearch,
      selectedRecipeUuid: this.#selectedRecipeUuid,
      actor: this.#actor
    });
    const html = await foundry.applications.handlebars.renderTemplate(TEMPLATES.craftWindowRecipeList, {
      recipeCategories: recipeList.categories,
    });
    if (version !== this.#recipeListRenderVersion || !this.rendered) return;
    const holder = document.createElement("template");
    holder.innerHTML = html.trim();
    const replacement = holder.content.firstElementChild;
    if (!replacement) return;
    current.replaceWith(replacement);
    this.#restoreRecipeListAnchor(replacement, anchor);
}

  #activateCraftViewer() {
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    this.element?.querySelectorAll("[data-craft-embedded-toggle]").forEach(button => {
      if (button.dataset.craftEmbeddedBound) return;
      button.dataset.craftEmbeddedBound = "true";
      const toggle = event => {
        event.preventDefault();
        event.stopPropagation();
        if (this.#busy) return;
        const key = button.dataset.craftEmbeddedToggle;
        this.#craftResourceOptions.selections ??= {};
        this.#craftResourceOptions.selections[key] = this.#craftResourceOptions.selections[key] === false;
        this.#saveActiveCraftTabState();
        void this.#updateCraftPanel();
      };
      button.addEventListener("click", toggle);
      button.addEventListener("keydown", event => { if (["Enter", " "].includes(event.key)) toggle(event); });
    });
    const workspace = this.element?.querySelector("[data-craft-workspace]");
    if (!workspace) return;
    workspace.addEventListener("contextmenu", event => this.#onCraftWorkspaceContextMenu(event));
    workspace.addEventListener("pointerdown", event => this.#onCraftWorkspacePointerDown(event));
    workspace.addEventListener("click", event => this.#onCraftWorkspaceClick(event));
    workspace.addEventListener("wheel", event => this.#onCraftWheel(event), { passive: false });
    workspace.querySelectorAll("[data-craft-tool-select]").forEach(button => {
      button.addEventListener("click", event => this.#onCraftToolSelect(event));
    });
    this.#craftGridStep = getCraftGridMetrics(workspace).step;
    const viewport = this.#getCraftViewport();
    this.#setCraftViewportStyle(viewport.x, viewport.y, viewport.zoom);
    this.#syncCraftNodeLayouts();
    this.#scheduleCraftLinkRenderAfterLayout();
    if (typeof ResizeObserver !== "undefined") {
      this.#resizeObserver = new ResizeObserver(() => this.#scheduleCraftLinkRender());
      this.#resizeObserver.observe(workspace);
    }
  }

  #onCraftWorkspaceClick(event) {
    if (event.target?.closest?.("[data-craft-tool-picker]")) return;
    const toolNode = event.target?.closest?.("[data-craft-tool-node]");
    if (toolNode) {
      event.preventDefault();
      event.stopPropagation();
      this.#craftToolPickerNodeId = String(toolNode.dataset.craftNodeId ?? "");
      this.#saveActiveCraftTabState();
      this.#clearInventoryTooltip({ force: true });
      void this.#updateCraftPanel();
      return;
    }
    if (!this.#craftToolPickerNodeId) return;
    this.#craftToolPickerNodeId = "";
    this.#saveActiveCraftTabState();
    void this.#updateCraftPanel();
  }

  #onCraftToolSelect(event) {
    event.preventDefault();
    event.stopPropagation();
    const requirementKey = String(event.currentTarget?.dataset?.craftToolSelect ?? "");
    const instrumentId = String(event.currentTarget?.dataset?.instrumentId ?? "");
    if (!requirementKey || !instrumentId || !this.#selectedRecipeUuid) return;
    this.#craftToolSelections.set(getCraftToolSelectionStorageKey(this.#selectedRecipeUuid, this.#craftMode, requirementKey), instrumentId);
    this.#saveActiveCraftTabState();
    void this.#updateCraftPanel();
  }

  #bindInventoryListeners() {
    this.element?.addEventListener("click", event => {
      const el = event.target?.closest?.("[data-item-id][data-search-actor-uuid]");
      if (!el || !(event.shiftKey || event.ctrlKey) || !this._canDragDrop()) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const item = this.#actor?.items.get(el.dataset.itemId);
      if (item) void this.#addBulkItem(item, event, el.dataset);
    }, { capture: true });
    const root = this.element?.querySelector("[data-search-root]");
    if (!root || root.dataset.craftInventoryBound) return;
    root.dataset.craftInventoryBound = "true";
    root.addEventListener("pointerover", event => this.#onInventoryTooltipPointerOver(event));
    root.addEventListener("pointerout", event => this.#onInventoryTooltipPointerOut(event));
    root.addEventListener("mousedown", event => this.#onInventoryTooltipMiddleMouseDown(event));
    root.addEventListener("auxclick", event => this.#onInventoryTooltipAuxClick(event));
    root.addEventListener("contextmenu", event => this.#onCraftRootContextMenu(event));
    root.addEventListener("click", event => {
      if (!event.target?.closest?.(".fallout-maw-inventory-context-menu")) {
        document.querySelectorAll(".fallout-maw-inventory-context-menu").forEach(menu => menu.remove());
      }
    });
  }

  _canDragStart() {
    return Boolean(this.#actor?.isOwner && !this.#busy);
  }

  _canDragDrop() {
    return Boolean(this.#actor?.isOwner && !this.#busy);
  }

  _onDragStart(event) {
    resetInventoryHoverCheckerCache();
    this.#clearInventoryTooltip({ force: true });
    this.#clearInventoryDropPreview();
    const itemElement = event.currentTarget?.closest?.("[data-item-id][data-search-actor-uuid]");
    const itemId = String(itemElement?.dataset?.itemId ?? "");
    const stackIndex = Math.max(0, toInteger(itemElement?.dataset?.stackIndex));
    const stackQuantity = Math.max(0, toInteger(itemElement?.dataset?.stackQuantity));
    const item = this.#actor?.items?.get(itemId);
    if (!item || !this._canDragStart()) return;
    this.#draggedItemId = item.id;
    this.#draggedItemData = item.toObject();
    if (usesVirtualInventoryStacks(item)) {
      foundry.utils.setProperty(this.#draggedItemData, "system.quantity", stackQuantity || getItemStackPartQuantity(item, stackIndex));
    }
    event.dataTransfer?.setData("text/plain", JSON.stringify({
      type: "Item",
      uuid: item.uuid,
      itemId: item.id,
      stackIndex,
      stackQuantity: stackQuantity || (usesVirtualInventoryStacks(item) ? getItemStackPartQuantity(item, stackIndex) : getItemQuantity(item)),
      actorUuid: this.#actor.uuid,
      sourceActorUuid: this.#actor.uuid,
      falloutMawSearchInventory: true
    }));
    this.#highlightEquipmentSlotsForItem(item);
    event.currentTarget?.classList?.add("dragging");
  }

  _onDragOver(event) {
    if (event.target?.closest?.("[data-bulk-drop]")) { event.preventDefault(); return; }
    event.stopPropagation();
    const zone = this.#getInventoryDropZone(event);
    if (!zone || !this._canDragDrop()) return;
    event.preventDefault();
    this.#clearInventoryTooltip({ force: true });
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    this.#draggedItemData = this.#getPreviewItemData(event);
    this.#setInventoryHoverPreview(zone, event);
  }

  _onDragLeave(event) {
    const zone = event.target?.closest?.("[data-search-drop-zone]");
    if (!zone) return;
    const hoveredElement = document.elementFromPoint(event.clientX, event.clientY);
    if (hoveredElement?.closest?.("[data-search-drop-zone]") === zone) return;
    if (zone.closest("[data-inventory-grid]") && hoveredElement?.closest?.("[data-inventory-grid]") === zone.closest("[data-inventory-grid]")) return;
    this.#clearInventoryHoverPreview();
  }

  _onDragEnd() {
    this.#draggedItemData = null;
    this.#draggedItemId = "";
    this.#clearInventoryDropPreview();
    this.element?.querySelectorAll(".dragging").forEach(element => element.classList.remove("dragging"));
  }

  async _onDrop(event) {
    event.preventDefault();
    event.stopPropagation();
    try {
      if (!this._canDragDrop()) return null;
      const data = getDragEventData(event);
      if (data?.type !== "Item") return null;
      const item = this.#actor?.items?.get(String(data.itemId ?? ""))
        ?? this.#actor?.items?.contents?.find(entry => entry.uuid === data.uuid);
      if (!item) return null;
      if (event.target?.closest?.("[data-bulk-drop]")) {
        if ((data.actorUuid ?? data.sourceActorUuid ?? item.parent?.uuid) !== this.#actorUuid) return null;
        return await this.#addBulkItem(item, event, data);
      }
      const sourceStackIndex = Math.max(0, toInteger(data.stackIndex));
      const sourceStackQuantity = Math.max(0, toInteger(data.stackQuantity));
      const itemData = item.toObject();
      applyInventoryDragRotation(itemData, data);
      if (usesVirtualInventoryStacks(item)) {
        foundry.utils.setProperty(itemData, "system.quantity", sourceStackQuantity || getItemStackPartQuantity(item, sourceStackIndex));
      }
      const zone = this.#getInventoryDropZone(event);
      if (!zone) return null;
      this.#captureScrollPositions();
      const placementRequest = getDropZonePlacementRequest(zone);
      const parentId = (placementRequest.mode === "inventory" || placementRequest.mode === LOCKED_STORAGE_PLACEMENT_MODE)
        ? getDropZoneParentId(zone)
        : ROOT_CONTAINER_ID;
      const targetElement = getCraftInventoryGridItemElementAtPointer(event, this.element)
        ?? zone?.closest?.("[data-inventory-grid-item][data-item-id]");
      const targetStackIndex = Math.max(0, toInteger(targetElement?.dataset?.stackIndex));
      const targetItem = this.#getTargetStackItem(zone, item, parentId, { sourceStackIndex, targetStackIndex });
      let quantity;
      if (canStackItems(itemData, targetItem)) {
        quantity = await this.#getCraftStackQuantity(item, targetItem, event, { sourceStackIndex, sourceStackQuantity, targetStackIndex });
        if (!quantity) return null;
        const moved = await stackActorInventoryItem({
          sourceActor: this.#actor,
          targetActor: this.#actor,
          sourceItem: item,
          targetItem,
          targetParentId: parentId,
          quantity,
          sourceStackIndex,
          targetStackIndex
        });
        if (this.rendered) await this.#renderPreservingWindowStack();
        return moved;
      } else {
        quantity = usesVirtualInventoryStacks(item)
          ? Math.max(1, sourceStackQuantity || getItemStackPartQuantity(item, sourceStackIndex))
          : Math.max(1, getItemQuantity(item));
      }
      if (!quantity) return null;
      const pointerPlacement = (placementRequest.mode === "inventory" || placementRequest.mode === LOCKED_STORAGE_PLACEMENT_MODE)
        ? getSearchDropPlacementForPointer({
          actor: this.#actor,
          itemData,
          sourceActor: this.#actor,
          sourceItemId: item.id,
          parentId,
          event,
          zone
        })
        : null;
      const moved = await transferItemBetweenActors({
        sourceActor: this.#actor,
        targetActor: this.#actor,
        sourceItem: item,
        targetMode: placementRequest.mode,
        targetParentId: parentId,
        targetEquipmentSlot: placementRequest.equipmentSlot,
        targetWeaponSet: placementRequest.weaponSet,
        targetWeaponSlot: placementRequest.weaponSlot,
        targetConstructPartSlot: placementRequest.constructPartSlot,
        targetX: pointerPlacement?.x ?? ((placementRequest.mode === "inventory" || placementRequest.mode === LOCKED_STORAGE_PLACEMENT_MODE) && zone?.dataset?.inventoryCell !== undefined ? toInteger(zone.dataset.x) : null),
        targetY: pointerPlacement?.y ?? ((placementRequest.mode === "inventory" || placementRequest.mode === LOCKED_STORAGE_PLACEMENT_MODE) && zone?.dataset?.inventoryCell !== undefined ? toInteger(zone.dataset.y) : null),
        targetRotated: Boolean(itemData.system?.placement?.rotated),
        targetItemId: targetItem?.id ?? "",
        quantity,
        sourceStackIndex,
        allowLocked: true
      });
      if (this.rendered) await this.#renderPreservingWindowStack();
      return moved;
    } finally {
      this._onDragEnd();
    }
  }

  #getInventoryDropZone(eventOrTarget) {
    const target = eventOrTarget?.target ?? eventOrTarget;
    const pointedCell = this.#getInventoryCellAtPointer(eventOrTarget, target);
    if (pointedCell) return pointedCell;

    const targetItem = target?.closest?.("[data-inventory-grid-item][data-item-id][data-search-actor-uuid]");
    if (targetItem && this.element?.contains(targetItem)) return targetItem;
    return target?.closest?.("[data-search-drop-zone]") ?? null;
  }

  #getInventoryCellAtPointer(eventOrTarget, target = null) {
    const clientX = Number(eventOrTarget?.clientX);
    const clientY = Number(eventOrTarget?.clientY);
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;

    const pointedElement = document.elementFromPoint(clientX, clientY);
    const grid = (
      target?.closest?.("[data-inventory-grid]")
      ?? pointedElement?.closest?.("[data-inventory-grid]")
      ?? null
    );
    if (!grid || !this.element?.contains(grid)) return null;

    const pointer = getSearchInventoryGridPointerPosition(eventOrTarget, grid, this.#actor, getDropZoneParentId(grid));
    if (!pointer) return null;
    const x = Math.round(pointer.x);
    const y = Math.round(pointer.y);
    return syncInventoryVirtualCell(grid, { x, y }, {
      inventoryParentId: getDropZoneParentId(grid),
      searchDropZone: "",
      searchActorUuid: String(grid.dataset.searchActorUuid ?? "")
    });
  }

  #getTargetStackItem(target, sourceItem, parentId = ROOT_CONTAINER_ID, { sourceStackIndex = 0, targetStackIndex = 0 } = {}) {
    const itemElement = target?.closest?.("[data-item-id][data-search-actor-uuid]");
    const sameVirtualDocumentStack = Boolean(
      sourceItem
      && usesVirtualInventoryStacks(sourceItem)
      && itemElement?.dataset?.itemId === sourceItem.id
      && Math.max(0, toInteger(targetStackIndex)) !== Math.max(0, toInteger(sourceStackIndex))
    );
    if (itemElement && itemElement.dataset.searchActorUuid === this.#actor?.uuid && (itemElement.dataset.itemId !== sourceItem.id || sameVirtualDocumentStack)) {
      if (!itemElement.closest("[data-inventory-grid]")) return null;
      if (String(itemElement.dataset.inventoryParentId ?? ROOT_CONTAINER_ID) !== String(parentId ?? ROOT_CONTAINER_ID)) return null;
      return this.#actor.items.get(itemElement.dataset.itemId) ?? null;
    }

    const cell = target?.closest?.("[data-inventory-cell]");
    if (!cell) return null;
    const x = toInteger(cell.dataset.x);
    const y = toInteger(cell.dataset.y);
    return getContextInventoryItems(parentId, this.#actor.items).find(item => {
      if (item.id === sourceItem.id) return false;
      const placement = normalizeInventoryPlacement(item.system?.placement ?? {}, item, this.#actor.items);
      return placementContainsInventoryCell(placement, x, y);
    }) ?? null;
  }

  #getPreviewItemData(event) {
    const data = getDragEventData(event);
    if (data?.type !== "Item") return null;
    if (this.#draggedItemData) return applyInventoryDragRotation(this.#draggedItemData, data);
    const item = this.#actor?.items?.get(String(data.itemId ?? ""));
    if (!item) return null;
    this.#draggedItemId = item.id;
    const itemData = item.toObject();
    if (usesVirtualInventoryStacks(item)) {
      const stackIndex = Math.max(0, toInteger(data.stackIndex));
      const stackQuantity = Math.max(0, toInteger(data.stackQuantity));
      foundry.utils.setProperty(itemData, "system.quantity", stackQuantity || getItemStackPartQuantity(item, stackIndex));
    }
    return applyInventoryDragRotation(itemData, data);
  }

  async #getCraftStackQuantity(sourceItem, targetItem, _event, { sourceStackIndex = 0, sourceStackQuantity = 0, targetStackIndex = null } = {}) {
    const sourceQuantity = usesVirtualInventoryStacks(sourceItem)
      ? Math.max(1, sourceStackQuantity || getItemStackPartQuantity(sourceItem, sourceStackIndex))
      : Math.max(1, getItemQuantity(sourceItem));
    const availableSpace = usesVirtualInventoryStacks(targetItem)
      ? Math.max(0, getItemMaxStack(targetItem) - getItemStackPartQuantity(targetItem, targetStackIndex))
      : Math.max(0, getItemMaxStack(targetItem) - getItemQuantity(targetItem));
    const maxTransfer = Math.min(sourceQuantity, availableSpace);
    return maxTransfer > 0 ? maxTransfer : 0;
  }

  #setInventoryHoverPreview(zone = null, event = null) {
    if (!zone) {
      this.#clearInventoryHoverPreview();
      return;
    }

    const actor = zone.dataset.searchActorUuid === this.#actor?.uuid ? this.#actor : null;
    if (zone.dataset.constructPartSlot || zone.dataset.equipmentSlot || (zone.dataset.weaponSet && zone.dataset.weaponSlot)) {
      const inputKey = `slot:${actor?.uuid ?? ""}:${zone.dataset.constructPartSlot ?? ""}:${zone.dataset.equipmentSlot ?? ""}:${zone.dataset.weaponSet ?? ""}:${zone.dataset.weaponSlot ?? ""}:${this.#actor?.uuid ?? ""}:${this.#draggedItemId}`;
      if (this.#hoverPreviewInputKey === inputKey) return;
      this.#hoverPreviewInputKey = inputKey;
      if (!actor || !this.#draggedItemData) {
        this.#clearInventoryHoverPreviewClasses();
        return;
      }
      const placementRequest = getDropZonePlacementRequest(zone);
      const excludeItemIds = actor.uuid === this.#actor?.uuid && this.#draggedItemId ? [this.#draggedItemId] : [];
      if (resolveActorPlacement(actor, this.#draggedItemData, {
        mode: placementRequest.mode,
        equipmentSlot: placementRequest.equipmentSlot,
        weaponSet: placementRequest.weaponSet,
        weaponSlot: placementRequest.weaponSlot,
        constructPartSlot: placementRequest.constructPartSlot,
        x: 1,
        y: 1
      }, excludeItemIds)) {
        this.#applySingleZonePreview(zone, inputKey);
        return;
      }
      this.#clearInventoryHoverPreviewClasses();
      return;
    }

    if (zone.dataset.inventoryCell === undefined && zone.dataset.inventoryGridItem === undefined) {
      this.#clearInventoryHoverPreview();
      return;
    }

    if (!actor || !this.#draggedItemData) {
      this.#applySingleZonePreview(zone, `inventory-cell:${zone.dataset.searchActorUuid ?? ""}:${getDropZoneParentId(zone)}:${zone.dataset.x ?? ""}:${zone.dataset.y ?? ""}`);
      return;
    }

    const parentId = getDropZoneParentId(zone);
    const inputKey = `inventory:${actor.uuid}:${parentId}:${zone.dataset.x ?? ""}:${zone.dataset.y ?? ""}:${this.#actor?.uuid ?? ""}:${this.#draggedItemId}:${Boolean(this.#draggedItemData?.system?.placement?.rotated)}`;
    if (this.#hoverPreviewInputKey === inputKey) return;
    this.#hoverPreviewInputKey = inputKey;
    const sourceItem = this.#actor?.items.get(this.#draggedItemId);
    const targetItem = sourceItem ? this.#getTargetStackItem(zone, sourceItem, parentId) : null;
    if (canStackItems(this.#draggedItemData, targetItem)) {
      this.#applyInventoryStackPreview(actor, parentId, targetItem);
      return;
    }

    const placement = getSearchDropPlacementForPointer({
      actor,
      itemData: this.#draggedItemData,
      sourceActor: this.#actor,
      sourceItemId: this.#draggedItemId,
      parentId,
      event,
      zone,
      findNearest: Boolean(targetItem)
    });
    if (!placement) {
      if (this.#hoverPreviewKey === "none") return;
      this.#clearInventoryHoverPreviewClasses();
      this.#hoverPreviewKey = "none";
      return;
    }
    this.#applyInventoryPlacementPreview(actor, parentId, placement);
  }

  #applySingleZonePreview(zone, key = "") {
    const previewKey = `zone:${key}`;
    if (this.#hoverPreviewKey === previewKey) return;
    this.#clearInventoryHoverPreviewClasses();
    this.#hoverPreviewKey = previewKey;
    zone?.classList?.add("drop-preview");
  }

  #applyInventoryPlacementPreview(actor, parentId, placement) {
    if (!placement) return;
    const previewKey = `inventory:${actor.uuid}:${parentId ?? ROOT_CONTAINER_ID}:${placement.x}:${placement.y}:${placement.width}:${placement.height}:${Boolean(placement.rotated)}`;
    if (this.#hoverPreviewKey === previewKey) return;
    this.#clearInventoryHoverPreviewClasses();
    this.#hoverPreviewKey = previewKey;
    renderInventoryPlacementPreview(
      this.#getInventoryGridElement(actor.uuid, parentId),
      placement,
      { className: "drop-preview", kind: "placement" }
    );
  }

  #applyInventoryStackPreview(actor, parentId, targetItem) {
    if (!actor || !targetItem) return;
    const previewKey = `stack:${actor.uuid}:${parentId ?? ROOT_CONTAINER_ID}:${targetItem.id}:${getItemQuantity(targetItem)}:${getItemMaxStack(targetItem)}`;
    if (this.#hoverPreviewKey === previewKey) return;
    this.#clearInventoryHoverPreviewClasses();
    this.#hoverPreviewKey = previewKey;

    const escapedUuid = CSS.escape(actor.uuid);
    const escapedParentId = CSS.escape(parentId ?? ROOT_CONTAINER_ID);
    const escapedItemId = CSS.escape(targetItem.id);
    this.element?.querySelector(
      `[data-inventory-grid-item][data-search-actor-uuid="${escapedUuid}"][data-item-id="${escapedItemId}"][data-inventory-parent-id="${escapedParentId}"]`
    )?.classList.add("drop-stack-preview");

    const placement = normalizeInventoryPlacement(targetItem.system?.placement ?? {}, targetItem, actor.items);
    renderInventoryPlacementPreview(
      this.#getInventoryGridElement(actor.uuid, parentId),
      placement,
      { className: "drop-stack-preview", kind: "stack" }
    );
  }

  #getInventoryGridElement(actorUuid = "", parentId = ROOT_CONTAINER_ID) {
    const escapedUuid = CSS.escape(String(actorUuid ?? ""));
    const escapedParentId = CSS.escape(String(parentId ?? ROOT_CONTAINER_ID));
    return this.element?.querySelector(
      `[data-inventory-grid][data-search-actor-uuid="${escapedUuid}"][data-inventory-parent-id="${escapedParentId}"]`
    ) ?? null;
  }

  #clearInventoryDropPreview() {
    this.#clearInventoryHoverPreview();
    clearInventoryVirtualCells(this.element);
    this.element?.querySelectorAll(".drop-match-preview").forEach(element => element.classList.remove("drop-match-preview"));
  }

  #clearInventoryHoverPreview() {
    this.#hoverPreviewInputKey = "";
    this.#clearInventoryHoverPreviewClasses();
  }

  #clearInventoryHoverPreviewClasses() {
    this.#hoverPreviewKey = "";
    clearInventoryPlacementPreviews(this.element);
    this.element?.querySelectorAll(".drop-preview, .drop-stack-preview").forEach(element => {
      element.classList.remove("drop-preview", "drop-stack-preview");
    });
  }

  #highlightEquipmentSlotsForItem(item) {
    const race = getActorRace(this.#actor);
    for (const slot of getRaceEquipmentSlotsForItem(race, item)) {
      this.element?.querySelector(`[data-equipment-slot="${CSS.escape(slot.key)}"]`)?.classList.add("drop-match-preview");
    }
    if (this.#actor?.type === "construct") {
      for (const slot of getConstructPartSlots(this.#actor)) {
        if (!isConstructPartCompatibleWithSlot(item, slot)) continue;
        const installed = getInstalledConstructPartForSlot(this.#actor, slot.id);
        if (installed && installed.id !== item.id) continue;
        this.element?.querySelector(`[data-construct-part-slot="${CSS.escape(slot.id)}"]`)?.classList.add("drop-match-preview");
      }
    }
    for (const set of race?.weaponSets ?? []) {
      for (const slot of set.slots ?? []) {
        if (!canUseWeaponSlotForItem(race, item, set.key, slot.key)) continue;
        this.element?.querySelector(`[data-weapon-set="${CSS.escape(set.key)}"][data-weapon-slot="${CSS.escape(slot.key)}"]`)?.classList.add("drop-match-preview");
      }
    }
    if (getValidSelectedWeaponSlotKeys(race, item).size) {
      this.element?.querySelectorAll('[data-weapon-set^="container:"][data-weapon-slot]').forEach(element => {
        element.classList.add("drop-match-preview");
      });
    }
  }

  #onCraftRootContextMenu(event) {
    if (this.#onInventoryContextMenu(event)) return;
    this.#onCraftRecipeContextMenu(event);
  }

  #onCraftWorkspaceContextMenu(event) {
    if (this.#onCraftRecipeContextMenu(event)) return;
    event.preventDefault();
  }

  #onInventoryContextMenu(event) {
    const itemElement = event.target?.closest?.("[data-item-id][data-search-actor-uuid]");
    if (!itemElement || !this.element?.contains(itemElement) || !this.#actor?.isOwner || this.#busy) return false;
    const item = this.#actor.items.get(String(itemElement.dataset.itemId ?? ""));
    if (!item) return false;
    event.preventDefault();
    event.stopPropagation();
    this.#showInventoryContextMenu(item, event, {
      stackIndex: Math.max(0, toInteger(itemElement.dataset.stackIndex)),
      stackQuantity: Math.max(0, toInteger(itemElement.dataset.stackQuantity))
    });
    return true;
  }

  #onCraftRecipeContextMenu(event) {
    const item = this.#resolveCraftContextMenuItem(event);
    if (!item) return false;
    event.preventDefault();
    event.stopPropagation();
    void this.#showCraftOpenContextMenu(item, event);
    return true;
  }

  #resolveCraftContextMenuItem(event) {
    if (event.target?.closest?.("[data-craft-tool-picker], .fallout-maw-inventory-context-menu")) return null;
    const anchor = event.target?.closest?.("[data-recipe-uuid], [data-tooltip-uuid], [data-tooltip-item][data-search-actor-uuid]");
    if (!anchor || !this.element?.contains(anchor)) return null;
    if (anchor.closest("[data-item-id][data-search-actor-uuid]")) return null;

    const recipeUuid = String(anchor.dataset.recipeUuid ?? "").trim();
    if (recipeUuid) return resolveCraftRecipeSelection(recipeUuid)?.item ?? null;

    const documentUuid = String(anchor.dataset.tooltipUuid ?? "").trim();
    if (documentUuid) {
      const selection = documentUuid.includes(CRAFT_RECIPE_SELECTION_SEPARATOR) ? resolveCraftRecipeSelection(documentUuid) : null;
      return selection?.item ?? resolveWorldItemSync(documentUuid);
    }

    const actorUuid = String(anchor.dataset.searchActorUuid ?? "").trim();
    const itemId = String(anchor.dataset.tooltipItem ?? "").trim();
    if (!itemId) return null;
    const actor = actorUuid === this.#actor?.uuid ? this.#actor : null;
    return actor?.items?.get(itemId) ?? null;
  }

  #onInventoryTooltipPointerOver(event) {
    if (this.#tooltipPinned) return;
    const anchor = event.target?.closest?.("[data-craft-link-tooltip], [data-tooltip-item][data-search-actor-uuid], [data-tooltip-uuid]");
    if (!anchor || !this.element?.contains(anchor)) return;
    this.#cancelInventoryTooltipClose();
    this.#tooltipCompareMode = Boolean(event.ctrlKey);
    if (this.#tooltipAnchorElement === anchor && this.#tooltipElement) return;
    this.#scheduleInventoryTooltip(anchor, { compareMode: event.ctrlKey });
  }

  #onInventoryTooltipPointerOut(event) {
    const anchor = event.target?.closest?.("[data-craft-link-tooltip], [data-tooltip-item][data-search-actor-uuid], [data-tooltip-uuid]");
    if (!anchor || !this.element?.contains(anchor)) return;
    if (anchor.contains(event.relatedTarget) || this.#tooltipElement?.contains(event.relatedTarget)) return;
    const nextAnchor = event.relatedTarget?.closest?.("[data-craft-link-tooltip], [data-tooltip-item][data-search-actor-uuid], [data-tooltip-uuid]");
    if (nextAnchor && this.element?.contains(nextAnchor)) return;
    if (!this.#tooltipPinned) this.#scheduleInventoryTooltipClose();
  }

  #onInventoryTooltipMiddleMouseDown(event) {
    if (event.button !== 1) return;
    if (!event.target?.closest?.("[data-craft-link-tooltip], [data-tooltip-item], [data-tooltip-uuid], .fallout-maw-inventory-tooltip")) return;
    event.preventDefault();
  }

  #onInventoryTooltipAuxClick(event) {
    if (event.button !== 1) return;
    const anchor = event.target?.closest?.("[data-craft-link-tooltip], [data-tooltip-item][data-search-actor-uuid], [data-tooltip-uuid]");
    if (!anchor || !this.element?.contains(anchor)) return;
    event.preventDefault();
    event.stopPropagation();
    this.#clearInventoryTooltip({ force: true });
    this.#tooltipCompareMode = Boolean(event.ctrlKey);
    void this.#showInventoryTooltip(anchor, { pinned: true });
  }

  #scheduleInventoryTooltip(anchor, { compareMode = this.#tooltipCompareMode } = {}) {
    if (this.#tooltipPinned) return;
    this.#tooltipCompareMode = Boolean(compareMode);
    const view = this.element?.ownerDocument?.defaultView ?? window;
    if (this.#tooltipElement && !this.#tooltipPinned) {
      if (this.#tooltipTimer) {
        view.clearTimeout(this.#tooltipTimer);
        this.#tooltipTimer = null;
      }
      this.#tooltipAnchorElement = anchor;
      this.#tooltipActorUuid = String(anchor.dataset.searchActorUuid ?? "");
      this.#tooltipDocumentUuid = getCraftLinkTooltipDocumentKey(anchor) || String(anchor.dataset.tooltipUuid ?? "");
      this.#tooltipItemId = String(anchor.dataset.tooltipItem ?? anchor.dataset.itemId ?? "");
      this.#tooltipWeaponTabIndex = 0;
      void this.#showInventoryTooltip(anchor, { refresh: true });
      return;
    }

    this.#clearInventoryTooltip();
    this.#tooltipCompareMode = Boolean(compareMode);
    this.#tooltipAnchorElement = anchor;
    this.#tooltipActorUuid = String(anchor.dataset.searchActorUuid ?? "");
    this.#tooltipDocumentUuid = getCraftLinkTooltipDocumentKey(anchor) || String(anchor.dataset.tooltipUuid ?? "");
    this.#tooltipItemId = String(anchor.dataset.tooltipItem ?? anchor.dataset.itemId ?? "");
    this.#tooltipWeaponTabIndex = 0;
    this.#tooltipTimer = view.setTimeout(() => {
      this.#tooltipTimer = null;
      void this.#showInventoryTooltip(anchor);
    }, 420);
  }

  async #showInventoryTooltip(anchor = this.#tooltipAnchorElement, { pinned = false, refresh = false } = {}) {
    let tooltipHTML = "";
    let documentUuid = "";
    let tooltipActorUuid = "";
    let tooltipItemId = "";
    const craftLinkTooltipData = getCraftLinkTooltipDataFromAnchor(anchor);
    if (craftLinkTooltipData) {
      tooltipHTML = renderCraftLinkTooltipHTML(craftLinkTooltipData);
      documentUuid = getCraftLinkTooltipDocumentKey(anchor);
    } else {
      const tooltipData = await this.#resolveTooltipItem(anchor);
      if (!tooltipData?.item) return;
      const { actor, item } = tooltipData;
      tooltipHTML = await renderInventoryItemTooltipHTML(item, actor, {
        activeWeaponIndex: this.#tooltipWeaponTabIndex,
        baseMode: false,
        compareActor: this.#actor,
        compareMode: this.#tooltipCompareMode,
        evaluatingActor: this.#actor
      });
      documentUuid = String(item.uuid ?? "");
      tooltipActorUuid = String(actor?.uuid ?? "");
      tooltipItemId = item.id;
    }
    if (refresh && (
      this.#tooltipDocumentUuid
        ? this.#tooltipDocumentUuid !== documentUuid
        : ((this.#tooltipActorUuid !== tooltipActorUuid) || (this.#tooltipItemId !== tooltipItemId))
    )) return;

    if (refresh && this.#tooltipElement && !this.#tooltipPinned && !pinned) {
      this.#tooltipElement.innerHTML = tooltipHTML;
      this.#tooltipElement.classList.remove("pinned");
      this.#tooltipElement.style.pointerEvents = "none";
      this.#tooltipPinned = false;
      this.#tooltipAnchorElement = anchor;
      this.#tooltipActorUuid = tooltipActorUuid;
      this.#tooltipDocumentUuid = documentUuid;
      this.#tooltipItemId = tooltipItemId;
      this.#bindInventoryTooltipKeyMode();
      this.#positionInventoryTooltip();
      requestAnimationFrame(() => {
        const description = this.#tooltipElement?.querySelector(".description");
        description?.classList.toggle("overflowing", description.clientHeight < description.scrollHeight);
        this.#positionInventoryTooltip();
      });
      return;
    }

    this.#clearInventoryTooltip({ keepAnchor: true });
    const tooltip = document.createElement("aside");
    tooltip.className = craftLinkTooltipData ? "fallout-maw-inventory-tooltip fallout-maw-craft-link-tooltip" : "fallout-maw-inventory-tooltip";
    tooltip.classList.toggle("pinned", Boolean(pinned));
    tooltip.style.setProperty("--fallout-maw-ui-scale", String(this.#uiScale));
    tooltip.innerHTML = tooltipHTML;
    tooltip.style.pointerEvents = pinned ? "auto" : "none";
    tooltip.addEventListener("pointerdown", () => this.#syncInventoryTooltipLayer({ bringToFront: true }));
    tooltip.addEventListener("pointerenter", () => this.#cancelInventoryTooltipClose());
    tooltip.addEventListener("pointerleave", event => {
      if (this.#tooltipPinned) return;
      if (this.#tooltipAnchorElement?.contains(event.relatedTarget)) return;
      this.#scheduleInventoryTooltipClose();
    });
    tooltip.addEventListener("click", event => this.#onTooltipClick(event));
    tooltip.addEventListener("auxclick", event => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      const nestedAnchor = event.target?.closest?.("[data-tooltip-html]");
      if (nestedAnchor && tooltip.contains(nestedAnchor)) {
        return;
      }
      this.#tooltipPinned = true;
      tooltip.classList.add("pinned");
      tooltip.style.pointerEvents = "auto";
      this.#bindInventoryTooltipDocumentClose();
      this.#syncInventoryTooltipLayer({ bringToFront: true });
    });
    document.body.append(tooltip);
    this.#tooltipElement = tooltip;
    this.#tooltipPinned = Boolean(pinned);
    this.#tooltipAnchorElement = anchor;
    this.#tooltipActorUuid = tooltipActorUuid;
    this.#tooltipDocumentUuid = documentUuid;
    this.#tooltipItemId = tooltipItemId;
    if (pinned) this.#bindInventoryTooltipDocumentClose();
    this.#bindInventoryTooltipKeyMode();
    this.#syncInventoryTooltipLayer({ bringToFront: pinned });
    this.#positionInventoryTooltip();
    requestAnimationFrame(() => {
      const description = tooltip.querySelector(".description");
      description?.classList.toggle("overflowing", description.clientHeight < description.scrollHeight);
      this.#positionInventoryTooltip();
    });
  }

  #onTooltipClick(event) {
    const button = event.target?.closest?.("[data-tooltip-weapon-tab]");
    if (!button || !this.#tooltipElement?.contains(button)) return;
    event.preventDefault();
    event.stopPropagation();
    const index = Math.max(0, toInteger(button.dataset.tooltipWeaponTab));
    this.#tooltipWeaponTabIndex = index;
    if (this.#tooltipElement?.querySelector(".fallout-maw-tooltip-comparison")) {
      void this.#showInventoryTooltip(this.#tooltipAnchorElement, { refresh: true });
      return;
    }
    activateInventoryTooltipTab(this.#tooltipElement, index);
    this.#positionInventoryTooltip();
  }

  #positionInventoryTooltip() {
    if (!this.#tooltipElement || !this.#tooltipAnchorElement?.isConnected) return;
    this.#syncInventoryTooltipLayer();
    const { viewportWidth, viewportHeight } = this.#getViewportMetrics();
    const margin = Math.max(8, 12 * this.#uiScale);
    const gap = Math.max(10, 12 * this.#uiScale);
    const anchorRect = this.#tooltipAnchorElement.getBoundingClientRect();
    let tooltipRect = this.#tooltipElement.getBoundingClientRect();
    let left = anchorRect.right + gap;
    if ((left + tooltipRect.width) > (viewportWidth - margin)) left = anchorRect.left - tooltipRect.width - gap;
    left = Math.max(margin, Math.min(viewportWidth - tooltipRect.width - margin, left));
    let top = anchorRect.top + ((anchorRect.height - tooltipRect.height) / 2);
    top = Math.max(margin, Math.min(viewportHeight - tooltipRect.height - margin, top));
    this.#tooltipElement.style.left = `${Math.round(left)}px`;
    this.#tooltipElement.style.top = `${Math.round(top)}px`;
    this.#tooltipElement.style.maxHeight = `${Math.max(220, viewportHeight - (margin * 2))}px`;
    tooltipRect = this.#tooltipElement.getBoundingClientRect();
    if ((tooltipRect.top + tooltipRect.height) > (viewportHeight - margin)) {
      this.#tooltipElement.style.top = `${Math.round(Math.max(margin, viewportHeight - tooltipRect.height - margin))}px`;
    }
  }

  #syncInventoryTooltipLayer({ bringToFront = false } = {}) {
    if (bringToFront) this.bringToFront?.();
    const baseZIndex = getOverlayBaseZIndex(this.element);
    if (this.#tooltipElement) this.#tooltipElement.style.zIndex = String(baseZIndex + 2);
    if (game.tooltip?.element && this.#tooltipElement?.contains(game.tooltip.element)) {
      game.tooltip.tooltip.style.zIndex = String(baseZIndex + 3);
    }
    const ownerDocument = this.element?.ownerDocument ?? document;
    const menus = ownerDocument.querySelectorAll(".fallout-maw-inventory-context-menu");
    for (const menu of menus) menu.style.zIndex = String(baseZIndex + 2);
    if (bringToFront || this.#tooltipPinned || menus.length) reserveOverlayZIndex(baseZIndex + 3);
  }

  #positionOverlayAtPointer(element, pointer = {}, baseMargin = 14) {
    if (!element) return;
    const { viewportWidth, viewportHeight } = this.#getViewportMetrics();
    const rect = element.getBoundingClientRect();
    const margin = Math.max(8, baseMargin * this.#uiScale);
    const pointerX = Number(pointer?.x);
    const pointerY = Number(pointer?.y);
    const x = Math.min(
      (Number.isFinite(pointerX) ? pointerX : 0) + margin,
      viewportWidth - rect.width - margin
    );
    const y = Math.min(
      (Number.isFinite(pointerY) ? pointerY : 0) + margin,
      viewportHeight - rect.height - margin
    );
    element.style.left = `${Math.max(margin, x)}px`;
    element.style.top = `${Math.max(margin, y)}px`;
  }

  async #resolveTooltipItem(anchor = this.#tooltipAnchorElement) {
    const documentUuid = String(anchor?.dataset?.tooltipUuid ?? this.#tooltipDocumentUuid ?? "").trim();
    if (documentUuid) {
      const item = resolveWorldItemSync(documentUuid);
      if (item) return { item, actor: item.parent?.documentName === "Actor" ? item.parent : null };
    }
    const actorUuid = String(anchor?.dataset?.searchActorUuid ?? this.#tooltipActorUuid ?? "");
    const actor = actorUuid && actorUuid === this.#actor?.uuid ? this.#actor : await resolveActor(actorUuid || this.#actorUuid);
    const itemId = String(anchor?.dataset?.tooltipItem ?? anchor?.dataset?.itemId ?? this.#tooltipItemId ?? "");
    const item = actor?.items?.get(itemId);
    return item ? { item, actor } : null;
  }

  #scheduleInventoryTooltipClose() {
    if (this.#tooltipPinned || this.#tooltipCloseTimer) return;
    const view = this.element?.ownerDocument?.defaultView ?? window;
    this.#tooltipCloseTimer = view.setTimeout(() => {
      this.#tooltipCloseTimer = null;
      this.#clearInventoryTooltip();
    }, 120);
  }

  #cancelInventoryTooltipClose() {
    if (!this.#tooltipCloseTimer) return;
    const view = this.element?.ownerDocument?.defaultView ?? window;
    view.clearTimeout(this.#tooltipCloseTimer);
    this.#tooltipCloseTimer = null;
  }

  #bindInventoryTooltipDocumentClose() {
    if (this.#tooltipDocumentPointerDownHandler) return;
    const view = this.element?.ownerDocument?.defaultView ?? window;
    this.#tooltipDocumentPointerDownHandler = event => {
      const insideTooltip = this.#tooltipElement?.contains(event.target);
      if (event.button === 1 && insideTooltip) {
        event.preventDefault();
        return;
      }
      if (!this.#tooltipPinned || !this.#tooltipElement) return;
      if (insideTooltip) return;
      this.#clearInventoryTooltip({ force: true });
    };
    view.document.addEventListener("pointerdown", this.#tooltipDocumentPointerDownHandler, { capture: true });
  }

  #unbindInventoryTooltipDocumentClose() {
    if (!this.#tooltipDocumentPointerDownHandler) return;
    const view = this.element?.ownerDocument?.defaultView ?? window;
    view.document.removeEventListener("pointerdown", this.#tooltipDocumentPointerDownHandler, { capture: true });
    this.#tooltipDocumentPointerDownHandler = null;
  }

  #bindInventoryTooltipKeyMode() {
    if (this.#tooltipDocumentKeyHandler) return;
    const view = this.element?.ownerDocument?.defaultView ?? window;
    this.#tooltipDocumentKeyHandler = event => {
      if (event.key !== "Control") return;
      const compareMode = event.type === "keydown";
      if (this.#tooltipCompareMode === compareMode) return;
      this.#tooltipCompareMode = compareMode;
      if (this.#tooltipAnchorElement) void this.#showInventoryTooltip(this.#tooltipAnchorElement, { refresh: true });
    };
    view.document.addEventListener("keydown", this.#tooltipDocumentKeyHandler, { capture: true });
    view.document.addEventListener("keyup", this.#tooltipDocumentKeyHandler, { capture: true });
  }

  #unbindInventoryTooltipKeyMode() {
    if (!this.#tooltipDocumentKeyHandler) return;
    const view = this.element?.ownerDocument?.defaultView ?? window;
    view.document.removeEventListener("keydown", this.#tooltipDocumentKeyHandler, { capture: true });
    view.document.removeEventListener("keyup", this.#tooltipDocumentKeyHandler, { capture: true });
    this.#tooltipDocumentKeyHandler = null;
  }

  #clearInventoryTooltip({ force = false, keepAnchor = false } = {}) {
    if (this.#tooltipTimer) {
      const view = this.element?.ownerDocument?.defaultView ?? window;
      view.clearTimeout(this.#tooltipTimer);
      this.#tooltipTimer = null;
    }
    this.#cancelInventoryTooltipClose();
    if (this.#tooltipPinned && !force) return;
    this.#unbindInventoryTooltipDocumentClose();
    this.#unbindInventoryTooltipKeyMode();
    this.#tooltipElement?.remove();
    this.#tooltipElement = null;
    this.#tooltipPinned = false;
    if (!keepAnchor) this.#tooltipCompareMode = false;
    if (!keepAnchor) {
      this.#tooltipAnchorElement = null;
      this.#tooltipActorUuid = "";
      this.#tooltipDocumentUuid = "";
      this.#tooltipItemId = "";
    }
  }

  async #showInventoryContextMenu(item, event, { stackIndex = 0, stackQuantity = 0 } = {}) {
    this.#clearCraftContextOverlays();

    const placementMode = String(item.system?.placement?.mode ?? "");
    const isSlottedEquipment = placementMode === "equipment";
    const isSlottedWeapon = placementMode === "weapon";
    const isSlottedItem = isSlottedEquipment || isSlottedWeapon || isInstalledConstructPartItem(item);
    const isEquipped = Boolean(item.system?.equipped);
    const isContainer = isContainerItem(item);
    const craftOpenOptions = await getCraftWindowOpenOptionsForItem(item, this.#actor);
    const canQuickDisassemble = (await getQuickDisassemblyItems(this.#actor)).some(entry => entry.id === item.id);
    const menuOptions = [];

    if (game.user?.isGM) {
      menuOptions.push(["edit", "fa-pen-to-square", game.i18n.localize("FALLOUTMAW.Common.Edit")]);
    }
    if (isContainer) {
      menuOptions.push(["open", "fa-box-open", game.i18n.localize("FALLOUTMAW.Item.Open")]);
    }
    if (canQuickDisassemble) menuOptions.push(["quick-disassemble", "fa-screwdriver-wrench", auditLocalize("FALLOUTMAW.AuditApps.Dismantle", "Разобрать")]);
    for (const [index, option] of craftOpenOptions.entries()) {
      menuOptions.push([`craft-open-${index}`, option.icon, option.label]);
    }
    if (item?.type === "gear") {
      if (hasAcquisitionWaysForItem(item)) {
        menuOptions.push(["show-acquisition", "fa-route", auditLocalize("FALLOUTMAW.AuditApps.ShowAcquisitionMethods", "Показать способы получения")]);
      }
      if (findUsageRecipesForItem(item).recipes.length) {
        menuOptions.push(["show-usage", "fa-diagram-project", auditLocalize("FALLOUTMAW.AuditApps.ShowRecipesThatUseThisItem", "Показать в каких крафтах участвует")]);
      }
      menuOptions.push(...getCraftCompatibilityActions(item).map(option => [option.action, option.icon, option.label]));
    }
    if (getItemInteractionState(this.#actor, item).hasInteraction) {
      menuOptions.push(["interact", "fa-hand-pointer", auditLocalize("FALLOUTMAW.AuditApps.Interaction", "Взаимодействие")]);
    }
    if (canUseActiveItem(item)) {
      menuOptions.push(["use", "fa-play", auditLocalize("FALLOUTMAW.Common.Apply", "Применить")]);
    }
    const canRotate = canShowInventoryRotateAction(item);
    const rotationResolution = canRotate ? this.#resolveCraftItemRotation(item) : null;
    if (canRotate) {
      menuOptions.push(["rotate", "fa-rotate", game.i18n.localize("FALLOUTMAW.Item.Rotate"), !rotationResolution, rotationResolution ? "" : getInventoryRotationUnavailableLabel()]);
    }
    if (isSlottedItem || isEquipped) {
      menuOptions.push(["unequip", "fa-hand", game.i18n.localize("FALLOUTMAW.Item.Unequip")]);
    } else {
      menuOptions.push(["equip", "fa-shirt", game.i18n.localize("FALLOUTMAW.Item.Equip")]);
    }
    const selectedQuantity = usesVirtualInventoryStacks(item)
      ? Math.max(1, stackQuantity || getItemStackPartQuantity(item, stackIndex))
      : getItemQuantity(item);
    if (selectedQuantity > 1) {
      menuOptions.push(["split", "fa-code-branch", auditLocalize("FALLOUTMAW.AuditApps.Split", "Разделить")]);
    }
    if (game.user?.isGM && !isSlottedItem) {
      menuOptions.push(["copy", "fa-copy", game.i18n.localize("FALLOUTMAW.Common.Copy")]);
    }
    if (game.user?.isGM && !isInstalledConstructPartItem(item)) {
      menuOptions.push(["delete", "fa-trash", game.i18n.localize("FALLOUTMAW.Common.Delete")]);
    }

    const menu = document.createElement("nav");
    menu.className = "fallout-maw-inventory-context-menu";
    menu.style.setProperty("--fallout-maw-ui-scale", String(this.#uiScale));
    menu.innerHTML = menuOptions
      .map(([action, icon, label, disabled = false, title = ""]) => `<button type="button" data-action="${action}"${disabled ? " disabled" : ""}${title ? ` title="${escapeAttribute(title)}"` : ""}><i class="fa-solid ${icon}"></i>${label}</button>`)
      .join("");
    document.body.append(menu);
    this.#syncInventoryTooltipLayer({ bringToFront: true });
    this.#positionOverlayAtPointer(menu, { x: event.clientX, y: event.clientY }, 8);

    menu.addEventListener("click", async clickEvent => {
      const action = clickEvent.target.closest("button")?.dataset.action;
      if (!action) return;
      clickEvent.preventDefault();
      menu.remove();
      if (action === "edit" && game.user?.isGM) return item.sheet?.render(true);
      if (action === "open") return this.#openCraftContainerSheet(item);
      if (action === "quick-disassemble") {
        try { notifyQuickDisassemblyResult(await quickDisassembleItems({ actor: this.#actor, itemIds: [item.id] })); }
        catch (error) { ui.notifications.warn(error.message); }
        return;
      }
      if (action.startsWith("craft-open-")) {
        const option = craftOpenOptions[toInteger(action.slice("craft-open-".length))];
        if (!option) return undefined;
        this.openSelection(option);
        return this.#renderPreservingWindowStack();
      }
      if (action === "show-acquisition") return this.#showAcquisitionWaysForItem(item);
      if (action === "show-usage") return this.#showUsageCraftsForItem(item);
      if (action === "show-ammo") return this.#showUsageCraftsForItem(item, "ammo");
      if (action === "show-modules") return this.#showUsageCraftsForItem(item, "modules");
      if (action === "interact") return openItemInteractionDialog({ actor: this.#actor, item, application: this });
      if (action === "use") return useActiveItem({ actor: this.#actor, item, application: this });
      if (action === "rotate") return this.#rotateCraftItem(item);
      if (action === "equip") return this.#equipCraftItem(item);
      if (action === "unequip") return this.#unequipCraftItem(item);
      if (action === "split") return this.#splitCraftItem(item, { stackIndex, stackQuantity: selectedQuantity });
      if (action === "copy" && game.user?.isGM) return copyActorInventoryItem(this.#actor, item, { allowLocked: true });
      if (action === "delete" && game.user?.isGM) {
        return executeInventoryMutation({
          actor: this.#actor,
          deletes: [item.id]
        }, { reason: "delete" });
      }
      return undefined;
    });
  }

  async #showCraftOpenContextMenu(item, event) {
    this.#clearCraftContextOverlays();
    const craftOpenOptions = await getCraftWindowOpenOptionsForItem(item, this.#actor);
    const menuOptions = craftOpenOptions.map((option, index) => ({
      action: `craft-open-${index}`,
      icon: option.icon,
      label: option.label
    }));
    if (item?.type === "gear") {
      if (hasAcquisitionWaysForItem(item)) {
        menuOptions.push({ action: "show-acquisition", icon: "fa-route", label: auditLocalize("FALLOUTMAW.AuditApps.ShowAcquisitionMethods", "Показать способы получения") });
      }
      if (findUsageRecipesForItem(item).recipes.length) {
        menuOptions.push({ action: "show-usage", icon: "fa-diagram-project", label: auditLocalize("FALLOUTMAW.AuditApps.ShowRecipesThatUseThisItem", "Показать в каких крафтах участвует") });
      }
      menuOptions.push(...getCraftCompatibilityActions(item));
    }
    if (!menuOptions.length) return;

    const menu = document.createElement("nav");
    menu.className = "fallout-maw-inventory-context-menu";
    menu.style.setProperty("--fallout-maw-ui-scale", String(this.#uiScale));
    menu.innerHTML = menuOptions
      .map(option => `<button type="button" data-action="${option.action}"><i class="fa-solid ${option.icon}"></i>${option.label}</button>`)
      .join("");
    document.body.append(menu);
    this.#syncInventoryTooltipLayer({ bringToFront: true });
    this.#positionOverlayAtPointer(menu, { x: event.clientX, y: event.clientY }, 8);

    menu.addEventListener("click", async clickEvent => {
      const action = clickEvent.target.closest("button")?.dataset.action;
      if (!action) return;
      clickEvent.preventDefault();
      menu.remove();
      if (action === "show-acquisition") return this.#showAcquisitionWaysForItem(item);
      if (action === "show-usage") return this.#showUsageCraftsForItem(item);
      if (action === "show-ammo") return this.#showUsageCraftsForItem(item, "ammo");
      if (action === "show-modules") return this.#showUsageCraftsForItem(item, "modules");
      if (!action.startsWith("craft-open-")) return undefined;
      const option = craftOpenOptions[toInteger(action.slice("craft-open-".length))];
      if (!option) return undefined;
      this.openSelection(option);
      return this.#renderPreservingWindowStack();
    });
  }

  #showAcquisitionWaysForItem(item) {
    if (!item?.uuid) return undefined;
    this.#clearCraftContextOverlays();
    return this.#addCraftTab({
      returnTabId: this.#getActiveCraftTab()?.id,
      mode: this.#craftMode,
      acquisitionTargetUuid: String(item.uuid)
    });
  }

  #showUsageCraftsForItem(item, kind = "usage") {
    if (!item?.uuid) return undefined;
    this.#clearCraftContextOverlays();
    return this.#addCraftTab({
      returnTabId: this.#getActiveCraftTab()?.id,
      mode: this.#craftMode,
      usageTargetUuid: String(item.uuid),
      usageKind: kind
    });
  }

  #clearCraftContextOverlays() {
    this.#clearInventoryTooltip({ force: true });
    game.tooltip?.clearPending?.();
    game.tooltip?.deactivate?.();
    document.querySelectorAll(".fallout-maw-inventory-context-menu").forEach(menu => menu.remove());
    document.querySelectorAll(".fallout-maw-inventory-tooltip").forEach(tooltip => {
      if (tooltip !== this.#tooltipElement) tooltip.remove();
    });
  }

  #openCraftContainerSheet(item) {
    if (!isContainerItem(item)) return null;
    const app = new FalloutMaWContainerSheet({
      document: item,
      evaluatingActorUuid: this.#actor?.uuid ?? ""
    });
    app.render({ force: true });
    app.bringToFront();
    return app;
  }

  #resolveCraftItemRotation(item) {
    const parentId = item.system?.placement?.mode === LOCKED_STORAGE_PLACEMENT_MODE
      ? LOCKED_STORAGE_PARENT_ID
      : getItemContainerParentId(item);
    const dimensions = parentId && parentId !== LOCKED_STORAGE_PARENT_ID
      ? getContainerInventoryGridOptions(this.#actor.items.get(parentId))
      : getActorInventoryGridDimensions(this.#actor, getActorRace(this.#actor));
    const options = parentId === LOCKED_STORAGE_PARENT_ID
      ? {
        allowOverflowRows: true,
        extraRows: INFINITE_ROOT_INVENTORY_EMPTY_ROWS,
        placementMode: LOCKED_STORAGE_PLACEMENT_MODE,
        preferredPlacementModes: [LOCKED_STORAGE_PLACEMENT_MODE]
      }
      : (parentId ? getContainerInventoryGridOptions(this.#actor.items.get(parentId)) : getActorRootInventoryGridOptions(this.#actor, parentId));
    return resolveInventoryItemRotation({
      item,
      parentId,
      contextItems: getContextInventoryItems(parentId, this.#actor.items),
      columns: dimensions.columns,
      rows: dimensions.rows,
      allItems: this.#actor.items,
      excludeItemIds: [item.id],
      options
    });
  }

  async #rotateCraftItem(item, resolution = this.#resolveCraftItemRotation(item)) {
    const updateData = createInventoryRotationUpdate(item, resolution);
    if (!updateData) {
      ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));
      return null;
    }
    await executeInventoryMutation({
      actor: this.#actor,
      updates: [updateData]
    }, { reason: "rotate" });
    return this.#actor.items.get(item.id) ?? null;
  }

  async #equipCraftItem(item) {
    return transferItemBetweenActors({
      sourceActor: this.#actor,
      targetActor: this.#actor,
      sourceItem: item,
      targetMode: "equipment",
      targetParentId: ROOT_CONTAINER_ID,
      quantity: getItemQuantity(item),
      allowLocked: true
    });
  }

  async #unequipCraftItem(item) {
    const placement = getFirstAvailableActorInventoryPlacement(this.#actor, ROOT_CONTAINER_ID, item, [item.id], []);
    if (!placement) {
      ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));
      return null;
    }
    return transferItemBetweenActors({
      sourceActor: this.#actor,
      targetActor: this.#actor,
      sourceItem: item,
      targetMode: "inventory",
      targetParentId: ROOT_CONTAINER_ID,
      targetX: placement.x,
      targetY: placement.y,
      quantity: getItemQuantity(item),
      allowLocked: true
    });
  }

  async #splitCraftItem(item, { stackIndex = 0, stackQuantity = 0 } = {}) {
    const quantity = usesVirtualInventoryStacks(item)
      ? Math.max(1, stackQuantity || getItemStackPartQuantity(item, stackIndex))
      : getItemQuantity(item);
    if (quantity <= 1) return null;
    const amount = await promptSearchItemStackQuantity({
      item,
      title: auditLocalize("FALLOUTMAW.AuditApps.SplitItem", "Разделить предмет"),
      actionLabel: auditLocalize("FALLOUTMAW.AuditApps.Split", "Разделить"),
      max: quantity - 1,
      value: Math.max(1, Math.floor(quantity / 2))
    });
    if (!amount) return null;
    try {
      if (usesVirtualInventoryStacks(item)) {
        const splitData = item.toObject();
        foundry.utils.setProperty(splitData, "system.quantity", amount);
        const parentId = item.system?.placement?.mode === LOCKED_STORAGE_PLACEMENT_MODE
          ? LOCKED_STORAGE_PARENT_ID
          : getItemContainerParentId(item);
        const placement = getFirstAvailableActorInventoryPlacement(this.#actor, parentId, splitData, [], []);
        if (!placement) throw new Error(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));
        const updateData = createItemStackPartSplitUpdate(
          item,
          Math.max(0, toInteger(stackIndex)),
          amount,
          { ...placement, mode: parentId === LOCKED_STORAGE_PARENT_ID ? LOCKED_STORAGE_PLACEMENT_MODE : "inventory" }
        );
        if (!updateData) throw new Error(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));
        const result = await executeInventoryMutation({
          actor: this.#actor,
          updates: [updateData]
        }, { reason: "split-stack" });
        if (this.rendered) await this.#renderPreservingWindowStack();
        return result;
      }
      return await splitActorInventoryItem(this.#actor, item, amount, { allowLocked: true });
    } catch (error) {
      console.error(`${SYSTEM_ID} | Craft inventory split failed`, error);
      ui.notifications.warn(error.message || auditLocalize("FALLOUTMAW.AuditApps.FailedToSplitTheItem", "Не удалось разделить предмет."));
    }
    return null;
  }

  #scheduleRefreshForActor(actor) {
    if (!actor || actor.uuid !== this.#actorUuid) return;
    invalidateCraftRecipeAvailabilityCaches();
    if (this.#busy || this.#contentsTransfer.renderBatch.active) return;
    this.#renderRefresh?.();
  }

  #scheduleRefreshForItem(item) {
    if (!item) return;
    if (item.parent?.uuid === this.#actorUuid) {
      invalidateCraftRecipeAvailabilityCaches();
      if (!this.#busy && !this.#contentsTransfer.renderBatch.active) this.#renderRefresh?.();
      return;
    }
    if (!item.parent) {
      invalidateWorldRecipeLayoutCache();
      invalidateCraftRecipeAvailabilityCaches();
      if (!this.#busy && !this.#contentsTransfer.renderBatch.active) this.#renderRefresh?.();
    }
  }

  #getCraftToolSelections(recipeUuid = this.#selectedRecipeUuid, mode = this.#craftMode) {
    const selections = {};
    const prefix = getCraftToolSelectionStoragePrefix(recipeUuid, mode);
    for (const [key, itemId] of this.#craftToolSelections.entries()) {
      if (!key.startsWith(prefix)) continue;
      selections[key.slice(prefix.length)] = itemId;
    }
    return selections;
  }

  #storeCraftToolSelections(recipeUuid = this.#selectedRecipeUuid, mode = this.#craftMode, selections = {}, { onlyMissing = false } = {}) {
    if (!recipeUuid) return;
    for (const [requirementKey, itemId] of Object.entries(normalizeCraftToolSelections(selections))) {
      if (!requirementKey || !itemId) continue;
      const storageKey = getCraftToolSelectionStorageKey(recipeUuid, mode, requirementKey);
      if (onlyMissing && this.#craftToolSelections.has(storageKey)) continue;
      this.#craftToolSelections.set(storageKey, itemId);
    }
  }

  #rememberDefaultCraftToolSelections(recipeUuid = this.#selectedRecipeUuid, mode = this.#craftMode, toolRequirements = []) {
    const selections = {};
    for (const requirement of toolRequirements) {
      const itemId = String(requirement?.selectedInstrument?.id ?? "");
      if (!requirement?.key || !itemId) continue;
      selections[requirement.key] = itemId;
    }
    this.#storeCraftToolSelections(recipeUuid, mode, selections, { onlyMissing: true });
  }

  async #onCraft(event) {
    event.preventDefault();
    if (this.#busy) return undefined;
    const actor = await resolveActor(this.#actorUuid);
    const selection = resolveCraftRecipeSelection(this.#selectedRecipeUuid);
    const recipe = selection?.item ?? null;
    this.#selectedRecipe = recipe;
    this.#selectedRecipeId = selection?.recipeId ?? DEFAULT_CRAFT_RECIPE_ID;
    const repeatContext = recipe
      ? prepareCraftContext(recipe, actor, {
        mode: this.#craftMode,
        recipeId: this.#selectedRecipeId,
        resourceOptions: this.#craftResourceOptions,
        toolSelections: this.#getCraftToolSelections(this.#selectedRecipeUuid, this.#craftMode)
      })
      : createEmptyCraftContext();
    this.#rememberDefaultCraftToolSelections(this.#selectedRecipeUuid, this.#craftMode, repeatContext.toolRequirements);
    const toolSelections = this.#getCraftToolSelections(this.#selectedRecipeUuid, this.#craftMode);
    const repeatMax = repeatContext.canCraft
      ? getCraftRepeatLimit(actor, repeatContext.requirements, repeatContext.toolRequirements, toolSelections)
      : 0;
    const repeatCount = this.#readCraftRepeatCount(repeatMax);
    const validation = await validateCraftRequest(actor, recipe, this.#craftMode, toolSelections, this.#selectedRecipeId, this.#craftResourceOptions);
    if (!validation.valid) {
      ui.notifications.warn(validation.message);
      return undefined;
    }
    this.#storeCraftToolSelections(this.#selectedRecipeUuid, this.#craftMode, validation.toolSelections);

    if (repeatCount > 0) {
      await this.#runCraftBatch(actor, recipe, validation, repeatCount);
      return undefined;
    }

    this.#busy = true;
    const linkResults = await this.#resolveCraftLinkResults(actor, validation.links);
    if (!linkResults) {
      this.#busy = false;
      ui.notifications.warn(auditLocalize("FALLOUTMAW.AuditApps.CraftingCheckFailed", "Проверка крафта не выполнена."));
      return undefined;
    }

    const operation = this.#buildCraftOperation(actor, recipe, validation, linkResults);
    this.#pendingOperation = operation;
    this.#startedOperationId = operation.id;
    await this.#runCraftOperationAnimation(operation);
    return undefined;
  }

  #readCraftRepeatCount(repeatMax = 0) {
    const input = this.element?.querySelector("[data-craft-repeat-count]");
    const raw = Number.isFinite(input?.valueAsNumber) ? input.valueAsNumber : this.#craftRepeatCount;
    this.#craftRepeatCount = normalizeCraftRepeatCount(raw, repeatMax);
    if (input) {
      input.max = String(Math.max(0, toInteger(repeatMax)));
      input.value = String(this.#craftRepeatCount);
    }
    this.#saveActiveCraftTabState();
    return this.#craftRepeatCount;
  }

  async #resolveCraftLinkResults(actor, links = [], { createMessages = true, collector = null, mode = this.#craftMode } = {}) {
    const linkResults = [];
    const thresholdMode = isSkillThresholdMode(getCraftingSettings().craft.mode);
    for (const link of links) {
      if (link.noCheck) {
        linkResults.push({
          linkId: link.id,
          linkKey: link.key,
          linkIndex: link.index,
          success: true,
          resultKey: "noCheck"
        });
        continue;
      }
      if (thresholdMode) {
        linkResults.push({
          linkId: link.id,
          linkKey: link.key,
          linkIndex: link.index,
          success: true,
          resultKey: "skillThreshold"
        });
        continue;
      }
      const outcome = await requestSkillCheck({
        actor,
        skillKey: link.skillKey,
        data: { difficulty: link.difficulty, allowImplicitTarget: false },
        animate: false,
        createMessage: createMessages,
        completionCollector: createMessages ? null : collector,
        requester: mode === CRAFT_MODE_DISASSEMBLY ? auditLocalize("FALLOUTMAW.Craft.Disassembly", "Разбор") : auditLocalize("FALLOUTMAW.AuditApps.Crafting", "Крафт")
      });
      if (!outcome) return null;
      collector?.add(outcome);
      linkResults.push({
        linkId: link.id,
        linkKey: link.key,
        linkIndex: link.index,
        success: outcome.result?.key === "success" || outcome.result?.key === "criticalSuccess",
        resultKey: String(outcome.result?.key ?? "failure")
      });
    }
    return linkResults;
  }

  #buildCraftOperation(actor, recipe, validation, linkResults = []) {
    return {
      id: foundry.utils.randomID(),
      actorUuid: actor.uuid,
      recipeUuid: recipe.uuid,
      recipeSelectionUuid: this.#selectedRecipeUuid,
      recipeId: this.#selectedRecipeId,
      mode: this.#craftMode,
      success: linkResults.every(result => result.success),
      requirements: validation.requirements,
      toolRequirements: validation.toolRequirements,
      toolSelections: validation.toolSelections,
      outputs: validation.outputs,
      outputNodeIds: validation.outputNodeIds,
      failureOutputs: validation.failureOutputs,
      resourceOptions: foundry.utils.deepClone(this.#craftResourceOptions),
      linkResults
    };
  }

  async #runCraftBatch(actor, recipe, firstValidation, repeatCount = 0) {
    const requested = normalizeCraftRepeatCount(repeatCount, repeatCount) + 1;
    const summary = createCraftBatchSummary(requested, this.#craftMode);
    const collector = createSkillCheckBatchCollector({
      requester: this.#craftMode === CRAFT_MODE_DISASSEMBLY ? auditLocalize("FALLOUTMAW.Craft.Disassembly", "Разбор") : auditLocalize("FALLOUTMAW.AuditApps.Crafting", "Крафт"),
      title: game.i18n.format("FALLOUTMAW.Craft.BatchChatTitle", { name: recipe.name })
    });
    let warning = "";
    this.#busy = true;

    try {
      for (let attempt = 0; attempt < requested; attempt += 1) {
        const validation = attempt === 0
          ? firstValidation
          : await validateCraftRequest(
            actor,
            recipe,
            this.#craftMode,
            this.#getCraftToolSelections(this.#selectedRecipeUuid, this.#craftMode),
            this.#selectedRecipeId,
            this.#craftResourceOptions
          );
        if (!validation.valid) {
          warning = validation.message || auditLocalize("FALLOUTMAW.AuditApps.NotEnoughResourcesForTheNextAttempt", "Недостаточно ресурсов для следующей попытки.");
          break;
        }
        this.#storeCraftToolSelections(this.#selectedRecipeUuid, this.#craftMode, validation.toolSelections);

        const linkResults = await this.#resolveCraftLinkResults(actor, validation.links, {
          createMessages: false,
          collector
        });
        if (!linkResults) {
          warning = auditLocalize("FALLOUTMAW.AuditApps.CraftingCheckFailed", "Проверка крафта не выполнена.");
          break;
        }

        const operation = this.#buildCraftOperation(actor, recipe, validation, linkResults);
        try {
          await applyCraftOperation(operation);
        } catch (error) {
          console.error(`${SYSTEM_ID} | Craft batch operation failed`, error);
          warning = error.message || auditLocalize("FALLOUTMAW.AuditApps.TheNextCraftingAttemptDidNotComplete", "Следующая попытка крафта не завершена.");
          break;
        }

        const resultKey = getCraftAttemptResultKey(linkResults);
        summary.results[resultKey] += 1;
        summary.completed += 1;
      }

      if (collector.size) {
        try {
          await collector.publish({ forceBatch: true });
        } catch (error) {
          console.error(`${SYSTEM_ID} | Craft batch chat card failed`, error);
          ui.notifications.warn(auditLocalize("FALLOUTMAW.AuditApps.TheSeriesCompletedButTheCheckCardWas", "Серия выполнена, но карточка проверок не была создана."));
        }
      }
      if (warning) ui.notifications.warn(warning);
      if (summary.completed) await this.#showCraftBatchSummary(summary);
    } finally {
      // A failed attempt must not leave earlier collected checks waiting for a
      // common card that the batch can no longer publish.
      await Promise.allSettled([collector.abort()]);
      this.#busy = false;
      if (this.rendered) {
        this.#captureScrollPositions();
        await this.#renderPreservingWindowStack();
      }
    }
  }

  #showCraftBatchSummary(summary = {}) {
    this.#craftBatchSummaryClose?.();
    const workspace = this.element?.querySelector("[data-craft-workspace]");
    if (!workspace) return Promise.resolve();

    const overlay = document.createElement("section");
    const titleId = `fallout-maw-craft-batch-${foundry.utils.randomID()}`;
    const disassembly = summary.mode === CRAFT_MODE_DISASSEMBLY;
    const rows = [
      ["criticalSuccess", "critical-success", game.i18n.localize("FALLOUTMAW.SkillCheck.CriticalSuccess")],
      ["success", "success", game.i18n.localize("FALLOUTMAW.SkillCheck.Success")],
      ["failure", "failure", game.i18n.localize("FALLOUTMAW.SkillCheck.Failure")],
      ["criticalFailure", "critical-failure", game.i18n.localize("FALLOUTMAW.SkillCheck.CriticalFailure")]
    ];
    overlay.className = "fallout-maw-craft-batch-overlay";
    overlay.dataset.craftBatchSummary = "true";
    overlay.tabIndex = 0;
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "false");
    overlay.setAttribute("aria-labelledby", titleId);
    overlay.innerHTML = `
      <article class="fallout-maw-chat-card fallout-maw-skill-check-card fallout-maw-skill-check-batch-card fallout-maw-craft-batch-terminal">
        <header class="fallout-maw-skill-check-terminal-header">
          <div>
            <span class="fallout-maw-skill-check-kicker">${escapeHTML(game.i18n.localize(disassembly ? "FALLOUTMAW.Craft.BatchDisassemblyProtocol" : "FALLOUTMAW.Craft.BatchCraftProtocol"))}</span>
            <h2 id="${escapeAttribute(titleId)}">${escapeHTML(game.i18n.localize("FALLOUTMAW.Craft.BatchComplete"))}</h2>
          </div>
          <div class="fallout-maw-craft-batch-terminal-actions">
            <strong class="fallout-maw-skill-check-batch-total">×${Math.max(0, toInteger(summary.completed))}</strong>
            <button type="button" data-craft-batch-dismiss title="${escapeAttribute(game.i18n.localize("FALLOUTMAW.Craft.BatchDismissNow"))}" aria-label="${escapeAttribute(game.i18n.localize("FALLOUTMAW.Craft.BatchDismissNow"))}"><i class="fa-solid fa-xmark"></i></button>
          </div>
        </header>
        <section class="fallout-maw-skill-check-batch-results">
          ${rows.map(([key, cssClass, label]) => {
            const count = Math.max(0, toInteger(summary.results?.[key]));
            return `<div class="fallout-maw-skill-check-batch-result ${cssClass}${count ? "" : " empty"}"><span>${escapeHTML(label)}</span><strong>${count}</strong></div>`;
          }).join("")}
        </section>
      </article>`;
    workspace.appendChild(overlay);

    return new Promise(resolve => {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        if (this.#craftBatchSummaryTimer) clearTimeout(this.#craftBatchSummaryTimer);
        this.#craftBatchSummaryTimer = null;
        overlay.classList.add("is-closing");
        setTimeout(() => {
          overlay.remove();
          if (this.#craftBatchSummaryClose === close) this.#craftBatchSummaryClose = null;
          resolve();
        }, CRAFT_BATCH_SUMMARY_CLOSE_MS);
      };
      this.#craftBatchSummaryClose = close;
      this.#craftBatchSummaryTimer = setTimeout(close, CRAFT_BATCH_SUMMARY_DURATION_MS);
      overlay.addEventListener("pointerdown", event => event.stopPropagation());
      overlay.addEventListener("contextmenu", event => {
        event.preventDefault();
        event.stopPropagation();
      });
      overlay.addEventListener("wheel", event => {
        event.preventDefault();
        event.stopPropagation();
      }, { passive: false });
      overlay.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        close();
      });
      overlay.addEventListener("keydown", event => {
        if (!["Escape", "Enter", " "].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        close();
      });
      requestAnimationFrame(() => overlay.classList.add("is-visible"));
      overlay.focus({ preventScroll: true });
    });
  }

  #startPendingOperation() {
    const operation = this.#pendingOperation;
    if (!operation || this.#startedOperationId === operation.id) return;
    this.#startedOperationId = operation.id;
    void this.#runCraftOperationAnimation(operation);
  }

  async #runCraftOperationAnimation(operation) {
    this.#animatingOperationId = operation.id;
    try {
      await waitForAnimationFrame();
      this.#cancelScheduledCraftLinkRender();
      this.#syncCraftNodeLayouts();
      this.#renderCraftLinks(operation);
      await waitForAnimationFrame();
      this.#cancelScheduledCraftLinkRender();
      await animateCraftLinks(this.element, operation);
      if (this.#pendingOperation?.id !== operation.id) return;
      try {
        await applyCraftOperation(operation);
        await animateCraftCompletionNodes(this.element, operation);
      } catch (error) {
        console.error(`${SYSTEM_ID} | Craft operation failed`, error);
        ui.notifications.warn(error.message || auditLocalize("FALLOUTMAW.AuditApps.CraftingDidNotComplete", "Крафт не завершен."));
      }
    } finally {
      if (this.#animatingOperationId === operation.id) this.#animatingOperationId = "";
      if (this.#pendingOperation?.id === operation.id) {
        this.#busy = false;
        this.#pendingOperation = null;
        this.#startedOperationId = "";
      }
      if (this.rendered && !this.#pendingOperation) {
        this.#captureScrollPositions();
        await this.#renderPreservingWindowStack();
      }
    }
  }

  #syncCraftNodeLayouts() {
    const workspace = this.element?.querySelector("[data-craft-workspace]");
    const metrics = getCraftGridMetrics(workspace);
    this.element?.querySelectorAll("[data-craft-block-id]").forEach(block => {
      applyCraftElementLayout(block, {
        x: Number(block.dataset.craftX) || 0,
        y: Number(block.dataset.craftY) || 0,
        width: Number(block.dataset.craftWidth) || 1,
        height: Number(block.dataset.craftHeight) || 1
      }, metrics);
    });
    this.element?.querySelectorAll("[data-craft-block-frame-id]").forEach(block => {
      applyCraftElementLayout(block, {
        x: Number(block.dataset.craftX) || 0,
        y: Number(block.dataset.craftY) || 0,
        width: Number(block.dataset.craftWidth) || 1,
        height: Number(block.dataset.craftHeight) || 1
      }, metrics);
    });
    this.element?.querySelectorAll("[data-craft-node-id]").forEach(node => {
      applyCraftElementLayout(node, {
        x: Number(node.dataset.craftX) || 0,
        y: Number(node.dataset.craftY) || 0,
        width: Number(node.dataset.craftWidth) || 1,
        height: Number(node.dataset.craftHeight) || 1
      }, metrics);
    });
  }

  #scheduleCraftLinkRender() {
    if (this.#animatingOperationId) return;
    if (this.#linkRenderFrame) return;
    this.#linkRenderFrame = requestAnimationFrame(() => {
      this.#linkRenderFrame = 0;
      if (this.#animatingOperationId) return;
      this.#syncCraftNodeLayouts();
      this.#renderCraftLinks(this.#pendingOperation);
    });
  }

  #cancelScheduledCraftLinkRender() {
    if (!this.#linkRenderFrame) return;
    cancelAnimationFrame(this.#linkRenderFrame);
    this.#linkRenderFrame = 0;
  }

  #scheduleCraftLinkRenderAfterLayout() {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => this.#scheduleCraftLinkRender());
    });
  }

  #getCraftViewport() {
    if (this.#craftViewportOverride) return this.#craftViewportOverride;
    const workspace = this.element?.querySelector("[data-craft-workspace]");
    if (this.#selectedRecipe && workspace) return getCraftFitViewport(this.#selectedRecipe, this.#craftMode, workspace, this.#selectedRecipeId, this.#craftLinkData.nodes);
    return this.#selectedRecipe ? getCraftViewport(this.#selectedRecipe, this.#craftMode, this.#selectedRecipeId) : normalizeCraftViewport();
  }

  #setCraftViewportStyle(x, y, zoom = this.#getCraftViewport().zoom) {
    const workspace = this.element?.querySelector("[data-craft-workspace]");
    const world = this.element?.querySelector("[data-craft-world]");
    const nodes = this.#craftLinkData.nodes ?? [];
    const viewport = clampCraftViewportToVisibleNode(normalizeCraftViewport({ x, y, zoom }), workspace, nodes);
    this.#craftViewportOverride = viewport;
    this.#saveActiveCraftTabState();
    workspace?.style.setProperty("--craft-pan-x", `${viewport.x}px`);
    workspace?.style.setProperty("--craft-pan-y", `${viewport.y}px`);
    workspace?.style.setProperty("--craft-zoom", String(viewport.zoom));
    workspace?.style.setProperty("--fallout-maw-craft-scaled-step", `${Math.round(this.#craftGridStep * viewport.zoom)}px`);
    world?.style.setProperty("--craft-pan-x", `${viewport.x}px`);
    world?.style.setProperty("--craft-pan-y", `${viewport.y}px`);
    world?.style.setProperty("--craft-zoom", String(viewport.zoom));
    return viewport;
  }

  #onCraftWorkspacePointerDown(event) {
    if (event.button !== 2) return;
    event.preventDefault();
    event.stopPropagation();
    const viewport = this.#getCraftViewport();
    this.#craftPanDrag = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: viewport.x,
      startY: viewport.y,
      moved: false
    };
    const onMove = moveEvent => this.#onCraftPanMove(moveEvent);
    const onUp = upEvent => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      this.#onCraftPanEnd(upEvent);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
  }

  #onCraftPanMove(event) {
    const drag = this.#craftPanDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    const nextX = drag.startX + (event.clientX - drag.startClientX);
    const nextY = drag.startY + (event.clientY - drag.startClientY);
    drag.moved = true;
    this.#setCraftViewportStyle(nextX, nextY);
  }

  #onCraftPanEnd(event) {
    const drag = this.#craftPanDrag;
    this.#craftPanDrag = null;
    if (!drag || event.pointerId !== drag.pointerId || !drag.moved) return;
    const nextX = Math.round(drag.startX + (event.clientX - drag.startClientX));
    const nextY = Math.round(drag.startY + (event.clientY - drag.startClientY));
    this.#setCraftViewportStyle(nextX, nextY);
  }

  #onCraftWheel(event) {
    event.preventDefault();
    const workspace = this.element?.querySelector("[data-craft-workspace]");
    const rect = workspace?.getBoundingClientRect();
    if (!rect) return undefined;
    const viewport = this.#getCraftViewport();
    const factor = Math.exp(-event.deltaY * 0.0015);
    const nextZoom = clampCraftZoom(viewport.zoom * factor);
    if (Math.abs(nextZoom - viewport.zoom) < 0.001) return undefined;
    const pointerX = event.clientX - rect.left - (rect.width / 2);
    const pointerY = event.clientY - rect.top - (rect.height / 2);
    const worldX = (pointerX - viewport.x) / viewport.zoom;
    const worldY = (pointerY - viewport.y) / viewport.zoom;
    const nextX = pointerX - (worldX * nextZoom);
    const nextY = pointerY - (worldY * nextZoom);
    const nextViewport = this.#setCraftViewportStyle(nextX, nextY, nextZoom);
    if (this.#craftPanDrag) {
      this.#craftPanDrag.startClientX = event.clientX;
      this.#craftPanDrag.startClientY = event.clientY;
      this.#craftPanDrag.startX = nextViewport.x;
      this.#craftPanDrag.startY = nextViewport.y;
    }
    return undefined;
  }

  #renderCraftLinks(operation = null) {
    const workspace = this.element?.querySelector("[data-craft-workspace]");
    const svg = workspace?.querySelector("[data-craft-links]");
    if (!workspace || !svg || !this.#selectedRecipeUuid) return;
    if (!workspace.getClientRects().length || !svg.getClientRects().length) return;
    const mode = operation?.mode ?? this.#craftMode;
    const craft = this.#craftLinkData;
    const nodeData = new Map((craft.nodes ?? []).map(node => [node.id, node]));
    const resultByLink = createCraftLinkResultMap(operation?.linkResults ?? []);
    const flowByLink = getCraftLinkFlowMap(craft.links ?? [], craft.nodes ?? [], mode);
    const fragment = document.createDocumentFragment();

    for (const [linkIndex, link] of (craft.links ?? []).entries()) {
      const fromNode = nodeData.get(link.fromNodeId);
      const toNode = nodeData.get(link.toNodeId);
      if (!fromNode || !toNode || getCraftResolvedEndpointId(fromNode) === getCraftResolvedEndpointId(toNode)) continue;
      const linkKey = getCraftResolvedLinkKey(link, craft.nodes ?? []);
      const flow = flowByLink.get(link.id) ?? getCraftLinkFlow(link, nodeData, mode);
      const from = getCraftEndpointElement(workspace, craft.nodes ?? [], flow.fromNodeId);
      const to = getCraftEndpointElement(workspace, craft.nodes ?? [], flow.toNodeId);
      if (!from || !to) continue;
      const flowFromKey = getCraftResolvedEndpointId(nodeData.get(flow.fromNodeId));
      const flowToKey = getCraftResolvedEndpointId(nodeData.get(flow.toNodeId));
      const anchors = flow.reversed
        ? { from: getCraftLinkAnchor(link, "to"), to: getCraftLinkAnchor(link, "from") }
        : getCraftLinkAnchors(link);
      const geometry = getCraftConnectorGeometry(from, to, svg, getCraftLinkBend(link, svg), anchors);
      appendCraftLinkPath(fragment, geometry, link, {
        result: resultByLink.get(`id:${link.id}`)
          ?? resultByLink.get(`key:${linkKey}`)
          ?? resultByLink.get(`index:${linkIndex}`),
        recipeUuid: this.#selectedRecipeUuid,
        linkKey,
        linkIndex,
        flowFromKey,
        flowToKey
      });
    }
    svg.replaceChildren(fragment);
  }
}

function normalizeCraftRepeatCount(value, maximum = 0) {
  const numeric = Number(value);
  const integer = Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
  return Math.min(Math.max(0, integer), Math.max(0, toInteger(maximum)));
}

function getCraftRepeatLimit(actor, requirements = [], toolRequirements = [], toolSelections = {}) {
  if (!actor) return 0;
  let operationLimit = Number.POSITIVE_INFINITY;
  let hasConsumableRequirement = false;

  for (const requirement of requirements) {
    const quantity = Math.max(0, toInteger(requirement?.quantity));
    if (!quantity) continue;
    hasConsumableRequirement = true;
    const owned = Math.max(0, toInteger(requirement?.owned));
    operationLimit = Math.min(operationLimit, Math.floor(owned / quantity));
  }

  const normalizedSelections = normalizeCraftToolSelections(toolSelections);
  const toolGroups = new Map();
  for (const requirement of toolRequirements) {
    const quantity = Math.max(0, toInteger(requirement?.quantity));
    const toolKey = String(requirement?.toolKey ?? "").trim();
    if (!quantity || !toolKey) continue;
    hasConsumableRequirement = true;
    const selectedId = String(normalizedSelections[requirement.key] ?? requirement?.selectedInstrument?.id ?? "");
    const selected = getActorCraftToolCandidates(actor, requirement).find(candidate => candidate.id === selectedId) ?? null;
    if (!selected) return 0;
    const supplyKey = selected.supplyKey;
    const group = toolGroups.get(supplyKey) ?? {
      quantity: 0,
      supply: Math.max(0, toInteger(selected.supplyValue))
    };
    group.quantity += quantity;
    group.supply = Math.min(group.supply, Math.max(0, toInteger(selected.supplyValue)));
    toolGroups.set(supplyKey, group);
  }
  for (const group of toolGroups.values()) {
    operationLimit = Math.min(operationLimit, Math.floor(group.supply / group.quantity));
  }

  if (!hasConsumableRequirement || !Number.isFinite(operationLimit)) return 0;
  return Math.max(0, operationLimit - 1);
}

function getCraftAttemptResultKey(linkResults = []) {
  const checkedResults = linkResults.filter(result => result.resultKey !== "noCheck");
  if (!checkedResults.length) return "success";
  if (checkedResults.some(result => result.resultKey === "criticalFailure")) return "criticalFailure";
  if (checkedResults.some(result => !result.success)) return "failure";
  if (checkedResults.every(result => result.resultKey === "criticalSuccess")) return "criticalSuccess";
  return "success";
}

function createCraftBatchSummary(requested = 0, mode = CRAFT_MODE_CREATE) {
  return {
    requested: Math.max(0, toInteger(requested)),
    completed: 0,
    mode: normalizeCraftMode(mode),
    results: {
      criticalSuccess: 0,
      success: 0,
      failure: 0,
      criticalFailure: 0
    }
  };
}

async function validateCraftRequest(actor, recipe, mode = CRAFT_MODE_CREATE, toolSelections = {}, recipeId = DEFAULT_CRAFT_RECIPE_ID, resourceOptions = {}) {
  // Transactions may continue after closing the window and removing its Item
  // hooks. Cached display quantities must never authorize another attempt.
  invalidateCraftRecipeAvailabilityCaches();
  mode = normalizeCraftMode(mode);
  const skillActor = resourceOptions.skillActor ?? actor;
  if (!actor?.isOwner) return { valid: false, message: auditLocalize("FALLOUTMAW.AuditApps.YouDoNotHavePermissionToCraftWith", "Нет прав на крафт этим актером.") };
  if (!recipe) return { valid: false, message: auditLocalize("FALLOUTMAW.AuditApps.NoRecipeSelected", "Рецепт не выбран.") };
  if (!actorKnowsCraftItem(skillActor, recipe) && !(mode === CRAFT_MODE_DISASSEMBLY && canUseOwnedDisassembly(actor, recipe))) {
    return { valid: false, message: game.i18n.localize("FALLOUTMAW.Craft.KnowledgeRequired") };
  }

  const craft = getCraftRenderData(recipe, skillActor, mode, { toolSelections, recipeId, randomizeBlocks: true });
  if (mode === CRAFT_MODE_DISASSEMBLY && resourceOptions.sourceItemId) {
    for (const requirement of craft.requirements) {
      requirement.itemId = resourceOptions.sourceItemId;
      requirement.owned = getItemQuantity(actor.items.get(resourceOptions.sourceItemId));
    }
    try { createCraftRequirementSpendPlan(actor, craft.requirements); }
    catch (error) { return { valid: false, message: error.message }; }
  }
  if (!craft.links.length) return { valid: false, message: auditLocalize("FALLOUTMAW.AuditApps.TheRecipeHasNoLinksForChecks", "В рецепте нет связей для проверок.") };
  const links = prepareCraftOperationLinks(craft.links, craft.nodes);
  const unmetSkillThreshold = getUnmetCraftSkillThreshold(skillActor, links);
  if (unmetSkillThreshold) {
    return { valid: false, message: getCraftSkillThresholdMessage(unmetSkillThreshold, mode) };
  }
  if (!craft.requirements.length && !craft.toolRequirements.length) {
    return {
      valid: false,
      message: mode === CRAFT_MODE_DISASSEMBLY ? auditLocalize("FALLOUTMAW.AuditApps.TheRecipeHasNoItemToDismantle", "В рецепте нет предмета для разбора.") : auditLocalize("FALLOUTMAW.AuditApps.TheRecipeHasNoComponentsOrTools", "В рецепте нет компонентов или инструментов.")
    };
  }
  if (craft.requirements.some(requirement => !requirement.sourceUuid)) {
    return {
      valid: false,
      message: mode === CRAFT_MODE_DISASSEMBLY ? auditLocalize("FALLOUTMAW.AuditApps.TheRecipeContainsADismantlingItemWithoutA", "В рецепте есть предмет разбора без исходного документа.") : auditLocalize("FALLOUTMAW.AuditApps.TheRecipeContainsAComponentWithoutASource", "В рецепте есть компонент без исходного документа.")
    };
  }
  if (mode === CRAFT_MODE_DISASSEMBLY && !craft.outputs.length) {
    return { valid: false, message: auditLocalize("FALLOUTMAW.AuditApps.TheRecipeHasNoDismantlingResults", "В рецепте нет результатов разбора.") };
  }
  if (mode === CRAFT_MODE_DISASSEMBLY && craft.outputs.some(output => !output.sourceUuid)) {
    return { valid: false, message: auditLocalize("FALLOUTMAW.AuditApps.TheRecipeContainsADismantlingResultWithoutA", "В рецепте есть результат разбора без исходного документа.") };
  }
  if (craft.requirements.some(requirement => requirement.owned < requirement.quantity)) {
    return {
      valid: false,
      message: mode === CRAFT_MODE_DISASSEMBLY ? auditLocalize("FALLOUTMAW.AuditApps.ThereIsNoItemToDismantle", "Нет предмета для разбора.") : auditLocalize("FALLOUTMAW.AuditApps.NotEnoughComponentsForCrafting", "Недостаточно компонентов для крафта.")
    };
  }
  const toolRequirements = craft.toolRequirements.map(requirement => ({
    key: requirement.key,
    toolKey: requirement.toolKey,
    toolClass: requirement.toolClass,
    quantity: requirement.quantity
  }));
  const toolSpendPlan = createCraftToolRequirementSpendPlan(skillActor, toolRequirements, toolSelections);
  if (!toolSpendPlan.valid) return { valid: false, message: toolSpendPlan.message };
  const resolvedToolSelections = Object.fromEntries(Array.from(toolSpendPlan.selectedByRequirement.entries()).map(([key, instrument]) => [key, instrument.id]));
  const requirements = craft.requirements.map(requirement => ({
    key: requirement.key,
    itemId: requirement.itemId,
    sourceUuid: requirement.sourceUuid,
    sourceKeys: requirement.sourceKeys,
    quantity: requirement.quantity
  }));
  const outputs = craft.outputs.map(output => ({
    sourceUuid: output.sourceUuid,
    quantity: output.quantity,
    nodeIds: output.nodeIds
  }));
  const failureOutputs = getCraftFailureOutputs(craft.nodes, craft.links, mode);

  return {
    valid: true,
    requirements,
    toolRequirements,
    toolSelections: resolvedToolSelections,
    outputs,
    outputNodeIds: outputs.flatMap(output => Array.from(output.nodeIds ?? [])),
    failureOutputs,
    links
  };
}

async function applyBulkCraftOperations(actor, operations, expectedItems, { skillActor = actor, expectedToolItems = null } = {}) {
  invalidateCraftRecipeAvailabilityCaches();
  if (!actor?.isOwner || !skillActor?.isOwner) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.YouDoNotHavePermissionToDismantleWith", "Нет прав на разбор этим актёром."));
  const requirements = new Map(), tools = new Map(), toolSelections = {}, outputs = new Map();
  const settings = getCraftingSettings();
  const recipes = new Set();
  const embeddedOutputs = [];
  const addQuantity = (map, key, entry) => {
    const current = map.get(key);
    if (current) current.quantity += entry.quantity;
    else map.set(key, { ...entry });
  };
  for (const operation of operations) {
    if (operation.actorUuid !== actor.uuid || operation.mode !== CRAFT_MODE_DISASSEMBLY) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.InvalidDismantlingOperation", "Некорректная операция разбора."));
    if (!recipes.has(operation.recipeUuid)) {
      const recipe = resolveWorldItemSync(operation.recipeUuid);
      if (!recipe) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.RecipeNotFound", "Рецепт не найден."));
      if (!actorKnowsCraftItem(skillActor, recipe) && !canUseOwnedDisassembly(actor, recipe)) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.RecipeKnowledgeRequired_364", "Необходимо знание рецепта."));
      recipes.add(operation.recipeUuid);
    }
    const hasFailureOutput = !operation.success && operation.failureOutputs?.length > 0;
    const refund = !operation.success && !hasFailureOutput
      ? getCraftFailureRefundPercent(settings, operation.linkResults?.map(result => result.resultKey)) : 0;
    const spent = [];
    for (const requirement of operation.requirements) {
      const quantity = operation.success || hasFailureOutput ? requirement.quantity : calculateCraftConsumedQuantity(requirement.quantity, refund);
      spent.push({ ...requirement, quantity });
      const key = JSON.stringify([requirement.itemId, requirement.sourceUuid, requirement.sourceKeys, requirement.key]);
      addQuantity(requirements, key, { ...requirement, quantity });
    }
    for (const tool of operation.toolRequirements ?? []) {
      const selected = operation.toolSelections?.[tool.key];
      const key = JSON.stringify([tool.toolKey, tool.toolClass, selected, selected ? "" : tool.key]);
      addQuantity(tools, key, { ...tool, key });
      if (selected) toolSelections[key] = selected;
    }
    const resources = prepareCraftDisassemblyResources(actor, spent,
      (operation.success ? operation.outputs : operation.failureOutputs) ?? [], operation.repetitions ?? 1);
    embeddedOutputs.push(...resources.embedded);
    for (const output of resources.outputs) {
      addQuantity(outputs, output.sourceUuid, output);
    }
  }
  for (const requirement of requirements.values()) {
    const item = actor.items.get(requirement.itemId);
    if (item && (item.system?.locked || isNaturalRaceItem(item)
      || actor.items.contents.some(child => getItemContainerParentId(child) === item.id))) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.TheItemCannotBeDismantled_365", "Предмет недоступен для разбора."));
  }
  const spendPlan = createCraftRequirementSpendPlan(actor, [...requirements.values()]);
  const toolPlan = createCraftToolRequirementSpendPlan(skillActor, [...tools.values()], toolSelections);
  if (!toolPlan.valid) throw new Error(toolPlan.message);
  const sameActor = skillActor.uuid === actor.uuid;
  const consumption = { updates: [...spendPlan.updates, ...(sameActor ? toolPlan.updates : [])], deletes: [...spendPlan.deletes, ...(sameActor ? toolPlan.deletes : [])] };
  const additionalMutations = sameActor ? [] : [{ actor: skillActor, expectedItems: expectedToolItems, updates: toolPlan.updates, deletes: toolPlan.deletes }];
  const specs = await getCraftOutputSpecs(null, CRAFT_MODE_DISASSEMBLY, [...outputs.values(), ...embeddedOutputs]);
  const plan = planCraftDisassemblyPlacement(actor, specs, projectCraftInventoryState(actor, consumption), consumption);
  if (!plan.valid) throw new Error(plan.message);
  const mutation = { actor, expectedItems, updates: [...consumption.updates, ...plan.updates], deletes: consumption.deletes, creates: plan.creates };
  const dropped = Boolean(plan.overflow?.length);
  if (dropped) await commitInventoryWithDroppedItems(actor, mutation, plan.overflow, { reason: "bulk-disassembly", additionalMutations });
  else await executeInventoryMutation(additionalMutations.length ? [mutation, ...additionalMutations] : mutation, { reason: "bulk-disassembly" });
  return { dropped };
}

async function applyCraftOperation(operation) {
  invalidateCraftRecipeAvailabilityCaches();
  const actor = await resolveActor(operation.actorUuid);
  const recipe = resolveWorldItemSync(operation.recipeUuid);
  if (!actor?.isOwner) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.YouDoNotHavePermissionToCraftWith", "Нет прав на крафт этим актером."));
  if (!recipe) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.RecipeNotFound", "Рецепт не найден."));
  const expectedItems = actor.items.contents.map(item => foundry.utils.deepClone(item.toObject?.() ?? item));

  if (!actorKnowsCraftItem(actor, recipe) && !(operation.mode === CRAFT_MODE_DISASSEMBLY && canUseOwnedDisassembly(actor, recipe))) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.RecipeKnowledgeRequired_364", "Необходимо знание рецепта."));
  const craftingSettings = getCraftingSettings();
  const hasFailureOutput = !operation.success && operation.failureOutputs?.length > 0;
  const refundPercent = !operation.success && !hasFailureOutput
    ? getCraftFailureRefundPercent(craftingSettings, operation.linkResults?.map(result => result.resultKey))
    : 0;
  let spendRequirements = operation.success || hasFailureOutput
    ? operation.requirements
    : operation.requirements.map(requirement => ({
      ...requirement,
      quantity: calculateCraftConsumedQuantity(requirement.quantity, refundPercent)
    }));
  let spendPlan = createCraftRequirementSpendPlan(actor, spendRequirements);
  let preparedSpecs = null;
  if (operation.mode !== CRAFT_MODE_DISASSEMBLY && operation.success) {
    const embedded = prepareCraftEmbeddedCreation(actor, recipe, spendPlan, operation.recipeId, operation.resourceOptions);
    spendRequirements = [...spendRequirements, ...embedded.requirements];
    spendPlan = createCraftRequirementSpendPlan(actor, spendRequirements);
    preparedSpecs = mergeCraftOutputSpecs(embedded.specs.map(spec => ({ ...spec,
      data: createCraftOutputItemData({ uuid: recipe.uuid, toObject: () => foundry.utils.deepClone(spec.data) })
    })));
  } else if (operation.mode === CRAFT_MODE_DISASSEMBLY) {
    const resources = prepareCraftDisassemblyResources(actor, spendRequirements,
      (operation.success ? operation.outputs : operation.failureOutputs) ?? []);
    preparedSpecs = await getCraftOutputSpecs(recipe, operation.mode, [...resources.outputs, ...resources.embedded], operation.recipeId);
  }
  const toolSpendPlan = createCraftToolRequirementSpendPlan(actor, operation.toolRequirements, operation.toolSelections);
  if (!toolSpendPlan.valid) throw new Error(toolSpendPlan.message);
  const consumptionPlan = {
    updates: [...spendPlan.updates, ...toolSpendPlan.updates],
    deletes: [...spendPlan.deletes, ...toolSpendPlan.deletes]
  };
  const outputPlan = preparedSpecs
    ? (operation.mode === CRAFT_MODE_DISASSEMBLY
      ? planCraftDisassemblyPlacement(actor, preparedSpecs, projectCraftInventoryState(actor, consumptionPlan), consumptionPlan)
      : planCraftOutputPlacement(actor, preparedSpecs, projectCraftInventoryState(actor, consumptionPlan)))
    : await createCraftFailureOutputPlan(actor, recipe, operation.mode, operation.failureOutputs, consumptionPlan, operation.recipeId);
  if (!outputPlan.valid) throw new Error(outputPlan.message);

  const mutation = {
    actor,
    expectedItems,
    updates: [
      ...spendPlan.updates,
      ...toolSpendPlan.updates,
      ...(outputPlan.updates ?? [])
    ],
    deletes: [
      ...spendPlan.deletes,
      ...toolSpendPlan.deletes
    ],
    creates: outputPlan.creates ?? []
  };
  const reason = operation.success ? "craft" : "craft-failure";
  const dropped = Boolean(outputPlan.overflow?.length);
  if (dropped) {
    await commitInventoryWithDroppedItems(actor, mutation, outputPlan.overflow, { reason });
    if (!operation.suppressOverflowNotification) ui.notifications.warn(auditLocalize("FALLOUTMAW.AuditApps.ThereWasNotEnoughInventorySpaceExcessItems", "В инвентаре не хватило места, лишние предметы выброшены на землю."));
  } else await executeInventoryMutation(mutation, { reason });
  return { dropped };
}

async function spendCraftRequirements(actor, requirements = [], plan = null) {
  const spendPlan = plan ?? createCraftRequirementSpendPlan(actor, requirements);
  return executeInventoryMutation({
    actor,
    updates: spendPlan.updates,
    deletes: spendPlan.deletes
  }, { reason: "craft-consume" });
}

async function spendCraftToolRequirements(actor, plan = null) {
  return executeInventoryMutation({
    actor,
    updates: plan?.updates ?? [],
    deletes: plan?.deletes ?? []
  }, { reason: "craft-tool-consume" });
}

function createCraftRequirementSpendPlan(actor, requirements = []) {
  const index = getCraftAvailabilityIndex(actor);
  const availableByItemId = new Map(
    index.items.map(entry => [entry.item.id, Math.max(0, entry.quantity)])
  );
  const consumedByItemId = new Map();
  const stackOrderByItemId = new Map();

  for (const requirement of requirements) {
    let remaining = Math.max(0, toInteger(requirement.quantity));
    if (!remaining) continue;
    const candidates = getIndexedCraftRequirementCandidates(index, requirement).map(entry => entry.item);

    for (const item of candidates) {
      if (remaining <= 0) break;
      const quantity = Math.max(0, availableByItemId.get(item.id) ?? 0);
      if (quantity <= 0) continue;
      const consumed = Math.min(quantity, remaining);
      availableByItemId.set(item.id, quantity - consumed);
      consumedByItemId.set(item.id, (consumedByItemId.get(item.id) ?? 0) + consumed);
      if (Array.isArray(requirement.stackOrder)) {
        stackOrderByItemId.set(item.id, [...new Set([...(stackOrderByItemId.get(item.id) ?? []), ...requirement.stackOrder])]);
      }
      remaining -= consumed;
    }

    if (remaining > 0) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.ComponentsRanOutBeforeCraftingWasCompleted", "Компоненты закончились до завершения крафта."));
  }

  const updates = [];
  const deletes = [];
  for (const [itemId, consumed] of consumedByItemId) {
    const item = actor.items.get(itemId);
    if (!item || consumed <= 0) continue;
    const remaining = Math.max(0, getItemQuantity(item) - consumed);
    if (remaining <= 0) {
      deletes.push(itemId);
      continue;
    }
    if (usesVirtualInventoryStacks(item)) {
      const updateData = createCraftStackConsumptionUpdate(item, consumed, stackOrderByItemId.get(itemId));
      if (!updateData || (updateData["system.quantity"] ?? 0) <= 0) deletes.push(itemId);
      else updates.push(updateData);
    } else {
      updates.push({ _id: itemId, "system.quantity": remaining });
    }
  }
  return { updates, deletes, consumedByItemId };
}

function createCraftStackConsumptionUpdate(item, amount, stackOrder = []) {
  if (!stackOrder.length) return createItemStackPartRemovalUpdate(item, amount, 0);
  const parts = getItemStackParts(item);
  const order = [...new Set([...stackOrder, ...parts.map((_, index) => index)])]
    .filter(index => Number.isInteger(index) && index >= 0 && index < parts.length);
  let remaining = amount;
  const allocations = [];
  for (const index of order) {
    const quantity = Math.min(remaining, parts[index].quantity);
    if (quantity > 0) allocations.push({ index, quantity });
    remaining -= quantity;
    if (remaining <= 0) break;
  }
  const projected = foundry.utils.deepClone(item.toObject?.() ?? item);
  let result = null;
  // Work backwards so removing a full selected stack cannot renumber the
  // earlier stacks whose quantities were chosen by the same UI selection.
  for (const allocation of allocations.sort((left, right) => right.index - left.index)) {
    result = createItemStackPartRemovalUpdate(projected, allocation.quantity, allocation.index);
    if (!result) continue;
    for (const [key, value] of Object.entries(result)) {
      if (key !== "_id") foundry.utils.setProperty(projected, key, value);
    }
  }
  return result;
}

function createCraftToolRequirementSpendPlan(actor, requirements = [], selections = {}, index = null) {
  const updatesByItemId = new Map();
  const depletedItemIds = new Set();
  const supplyByItemTool = new Map();
  const ownedByRequirement = new Map();
  const selectedByRequirement = new Map();
  const missingKeys = new Set();
  const unavailableSelectedKeys = new Set();
  const normalizedSelections = normalizeCraftToolSelections(selections);
  const orderedRequirements = [...requirements]
    .sort((left, right) => toToolClassRank(right.toolClass) - toToolClassRank(left.toolClass));
  const getCandidates = (requirement) => index
    ? getIndexedActorCraftToolCandidates(index, requirement, supplyByItemTool)
    : getActorCraftToolCandidates(actor, requirement, supplyByItemTool);

  for (const requirement of orderedRequirements) {
    const requiredQuantity = Math.max(0, toInteger(requirement.quantity));
    const toolKey = String(requirement.toolKey ?? "").trim();
    if (!requiredQuantity || !toolKey) {
      ownedByRequirement.set(requirement.key, 0);
      continue;
    }

    const candidates = getCandidates(requirement);
    const hasManualSelection = Object.hasOwn(normalizedSelections, requirement.key) && Boolean(normalizedSelections[requirement.key]);
    const selectedId = hasManualSelection ? normalizedSelections[requirement.key] : "";
    const selected = hasManualSelection
      ? candidates.find(candidate => candidate.id === selectedId) ?? null
      : getDefaultCraftToolCandidate(candidates, requirement);
    const owned = selected?.supplyValue ?? 0;
    ownedByRequirement.set(requirement.key, owned);
    if (selected) selectedByRequirement.set(requirement.key, { ...selected, supplyValue: owned });
    else if (hasManualSelection) unavailableSelectedKeys.add(requirement.key);

    let remaining = requiredQuantity;
    if (selected?.supplyValue > 0) {
      const spend = Math.min(selected.supplyValue, remaining);
      selected.supplyValue -= spend;
      remaining -= spend;
      supplyByItemTool.set(selected.supplyKey, selected.supplyValue);
      if (selected.supplyValue <= 0 && selected.deletesItemOnDepletion) {
        depletedItemIds.add(selected.item.id);
      } else {
        const update = updatesByItemId.get(selected.item.id) ?? { _id: selected.item.id };
        update[selected.resourcePath] = selected.supplyValue;
        updatesByItemId.set(selected.item.id, update);
      }
    }

    if (remaining > 0) missingKeys.add(requirement.key);
  }

  return {
    valid: missingKeys.size === 0,
    message: unavailableSelectedKeys.size
      ? auditLocalize("FALLOUTMAW.AuditApps.TheSelectedToolIsNoLongerAvailableFor", "Выбранный инструмент больше недоступен для крафта.")
      : (missingKeys.size ? auditLocalize("FALLOUTMAW.AuditApps.CompatibleToolsDoNotHaveEnoughChargesFor", "Недостаточно зарядов подходящих инструментов для крафта.") : ""),
    updates: Array.from(updatesByItemId.entries())
      .filter(([itemId]) => !depletedItemIds.has(itemId))
      .map(([, update]) => update),
    deletes: Array.from(depletedItemIds),
    missingKeys,
    ownedByRequirement,
    selectedByRequirement
  };
}

function getActorCraftToolCandidates(actor, requirement = {}, supplyByItemTool = new Map()) {
  const requiredClass = normalizeToolClass(requirement.toolClass);
  const toolKey = String(requirement.toolKey ?? "").trim();
  return (actor?.items?.contents ?? [])
    .filter(item => !isNaturalRaceItem(item))
    .flatMap(item => getEnabledToolFunctions(item)
      .filter(tool => String(tool.toolKey ?? "") === toolKey && isToolClassAccepted(tool.toolClass, requiredClass))
      .map(tool => {
        const resource = tool.resource ?? getToolResourceState(item, tool);
        const supplyKey = `${item.id}:${resource.updatePath}`;
        const supplyValue = supplyByItemTool.has(supplyKey)
          ? supplyByItemTool.get(supplyKey)
          : (resource.available ? resource.value : 0);
        return {
          id: item.id,
          item,
          name: item.name ?? "",
          img: normalizeImagePath(item.img || FALLBACK_ICON),
          toolKey,
          supplyKey,
          resourceMode: resource.mode,
          resourcePath: resource.updatePath,
          deletesItemOnDepletion: resource.deletesItemOnDepletion,
          toolClass: normalizeToolClass(tool.toolClass),
          supplyValue
        };
      }))
    .filter(candidate => candidate.supplyValue > 0)
    .sort((left, right) => (
      Number(right.supplyValue >= Math.max(0, toInteger(requirement.quantity))) - Number(left.supplyValue >= Math.max(0, toInteger(requirement.quantity)))
      || (toToolClassRank(left.toolClass) - toToolClassRank(requiredClass)) - (toToolClassRank(right.toolClass) - toToolClassRank(requiredClass))
      || right.supplyValue - left.supplyValue
      || String(left.item.name ?? "").localeCompare(String(right.item.name ?? ""), game.i18n.lang)
      || String(left.id ?? "").localeCompare(String(right.id ?? ""), game.i18n.lang)
    ));
}

function getDefaultCraftToolCandidate(candidates = [], requirement = {}) {
  if (!candidates.length) return null;
  const requiredQuantity = Math.max(0, toInteger(requirement.quantity));
  return candidates.find(candidate => Math.max(0, toInteger(candidate.supplyValue)) >= requiredQuantity) ?? candidates[0] ?? null;
}

function prepareCraftToolCandidateForDisplay(candidate = {}, requirement = {}, selected = false) {
  const requiredQuantity = Math.max(0, toInteger(requirement.quantity));
  return {
    id: String(candidate.id ?? ""),
    name: String(candidate.name ?? candidate.item?.name ?? ""),
    img: normalizeImagePath(candidate.img || candidate.item?.img || FALLBACK_ICON),
    toolClass: normalizeToolClass(candidate.toolClass),
    supplyValue: Math.max(0, toInteger(candidate.supplyValue)),
    selected: Boolean(selected),
    usable: Math.max(0, toInteger(candidate.supplyValue)) >= requiredQuantity
  };
}

function normalizeCraftToolSelections(selections = {}) {
  if (selections instanceof Map) return Object.fromEntries(selections.entries());
  if (!selections || typeof selections !== "object") return {};
  return Object.fromEntries(Object.entries(selections).map(([key, value]) => [String(key), String(value ?? "")]));
}

function getCraftToolSelectionStoragePrefix(recipeUuid = "", mode = CRAFT_MODE_CREATE) {
  return `${String(recipeUuid ?? "")}:${normalizeCraftMode(mode)}:`;
}

function getCraftToolSelectionStorageKey(recipeUuid = "", mode = CRAFT_MODE_CREATE, requirementKey = "") {
  return `${getCraftToolSelectionStoragePrefix(recipeUuid, mode)}${String(requirementKey ?? "")}`;
}

async function createCraftFailureOutputPlan(actor, recipe, mode = CRAFT_MODE_CREATE, failureOutputs = [], spendPlan = null, recipeId = DEFAULT_CRAFT_RECIPE_ID) {
  if (!failureOutputs?.length) return { valid: true, updates: [], creates: [] };
  const specs = [];
  for (const output of failureOutputs) {
    if (Number(output.quantity) <= 0) continue;
    const source = resolveWorldItemSync(output.sourceUuid);
    if (!source) return { valid: false, message: auditLocalize("FALLOUTMAW.AuditApps.FailureResultNotFound", "Результат при провале не найден.") };
    specs.push({
      data: createCraftOutputItemData(source, { mode, emptyContents: true }),
      quantity: Math.max(1, toInteger(output.quantity) || 1)
    });
  }
  const outputSpecs = mergeCraftOutputSpecs(specs);
  const projectedItems = projectCraftInventoryState(actor, spendPlan ?? { updates: [], deletes: [] });
  return mode === CRAFT_MODE_DISASSEMBLY
    ? planCraftDisassemblyPlacement(actor, outputSpecs, projectedItems, spendPlan)
    : planCraftOutputPlacement(actor, outputSpecs, projectedItems);
}

async function createCraftOutputPlan(actor, recipe, mode = CRAFT_MODE_CREATE, outputs = [], spendPlan = null, recipeId = DEFAULT_CRAFT_RECIPE_ID) {
  const outputSpecs = await getCraftOutputSpecs(recipe, mode, outputs, recipeId);
  if (!outputSpecs.length) return { valid: true, updates: [], creates: [] };
  const projectedItems = projectCraftInventoryState(actor, spendPlan ?? { updates: [], deletes: [] });
  const plan = mode === CRAFT_MODE_DISASSEMBLY
    ? planCraftDisassemblyPlacement(actor, outputSpecs, projectedItems, spendPlan)
    : planCraftOutputPlacement(actor, outputSpecs, projectedItems);
  return plan;
}

function getCraftConsumedInputs(actor, requirements = []) {
  const consumed = requirements.every(requirement => requirement.itemId)
    ? requirements.reduce((map, requirement) => map.set(requirement.itemId, (map.get(requirement.itemId) ?? 0) + requirement.quantity), new Map())
    : createCraftRequirementSpendPlan(actor, requirements).consumedByItemId;
  return [...consumed].filter(([, quantity]) => quantity > 0)
    .map(([id, quantity]) => ({ item: actor.items.get(id), quantity })).filter(input => input.item);
}

function prepareCraftDisassemblyResources(actor, requirements, outputs, repetitions = 1) {
  const inputs = getCraftConsumedInputs(actor, requirements);
  return {
    inputs,
    outputs: scaleCraftDisassemblyOutputs(outputs, inputs, repetitions),
    embedded: getCraftEmbeddedReturns(inputs)
  };
}

function prepareCraftEmbeddedCreation(actor, recipe, spendPlan, recipeId, options = {}) {
  const occupiedParents = new Set((actor.items.contents ?? []).map(item => getItemContainerParentId(item)).filter(Boolean));
  const inventory = getCraftAvailabilityIndex(actor).items.map(entry => entry.item)
    .filter(item => !occupiedParents.has(item.id));
  return planCraftEmbeddedCreation(recipe, inventory, {
    quantity: getCraftRecipeOutputQuantity(recipe, recipeId),
    consumed: spendPlan.consumedByItemId,
    selections: options?.selections ?? {}
  });
}

async function getCraftOutputSpecs(recipe, mode = CRAFT_MODE_CREATE, outputs = [], recipeId = DEFAULT_CRAFT_RECIPE_ID) {
  if (normalizeCraftMode(mode) !== CRAFT_MODE_DISASSEMBLY) {
    return mergeCraftOutputSpecs([{
      data: createCraftOutputItemData(recipe, { mode, emptyContents: true }),
      quantity: getCraftRecipeOutputQuantity(recipe, recipeId)
    }]);
  }

  const specs = [];
  for (const output of outputs) {
    if (Number(output.quantity) <= 0) continue;
    if (output.embedded && !output.data) throw new Error(auditFormat("FALLOUTMAW.AuditApps.EmbeddedItemNotFound_370", { v0: (output.name) }, "Не найден встроенный предмет: {v0}"));
    if (output.data) {
      specs.push({ quantity: output.quantity, data: createCraftOutputItemData({
        uuid: output.sourceUuid,
        toObject: () => foundry.utils.deepClone(output.data)
      }, { mode }) });
      continue;
    }
    const source = resolveWorldItemSync(output.sourceUuid);
    if (!source) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.DismantlingResultNotFound_371", "Результат разбора не найден."));
    specs.push({
      data: createCraftOutputItemData(source, { mode, emptyContents: true }),
      quantity: Math.max(1, toInteger(output.quantity) || 1)
    });
  }
  return mergeCraftOutputSpecs(specs);
}

function getCraftRecipeOutputQuantity(recipe, recipeId = DEFAULT_CRAFT_RECIPE_ID) {
  const root = getCraftNodesWithRoot(recipe, CRAFT_MODE_CREATE, recipeId).find(node => node.root);
  return Math.max(1, toInteger(root?.quantity) || toInteger(recipe?.system?.quantity) || 1);
}

function createCraftOutputItemData(source, { mode = CRAFT_MODE_CREATE, emptyContents = false } = {}) {
  const data = emptyContents
    ? planCraftEmbeddedCreation(source, [], { quantity: 1 }).specs[0].data
    : createSourcedInventoryItemData(source);
  delete data._id;
  delete data.id;
  delete data.folder;
  foundry.utils.setProperty(data, "system.equipped", false);
  foundry.utils.setProperty(data, "system.stackParts", []);
  foundry.utils.setProperty(data, "system.container.parentId", ROOT_CONTAINER_ID);
  foundry.utils.setProperty(data, "system.placement.mode", "inventory");
  foundry.utils.setProperty(data, "system.placement.equipmentSlot", "");
  foundry.utils.setProperty(data, "system.placement.weaponSet", "");
  foundry.utils.setProperty(data, "system.placement.weaponSlot", "");

  data._stats ??= {};
  if (normalizeCraftMode(mode) === CRAFT_MODE_DISASSEMBLY) {
    data._stats.compendiumSource = null;
    data._stats.duplicateSource = source.uuid;
  } else {
    data._stats.compendiumSource = null;
    data._stats.duplicateSource = source.uuid;
  }
  data._stats.exportSource = null;
  return data;
}

function mergeCraftOutputSpecs(specs = []) {
  const merged = [];
  for (const spec of specs) {
    if (Number(spec?.quantity) <= 0) continue;
    const quantity = Math.max(1, toInteger(spec?.quantity) || 1);
    const data = foundry.utils.deepClone(spec?.data ?? {});
    foundry.utils.setProperty(data, "system.quantity", 1);
    const key = getCraftItemFingerprint(data);
    const existing = merged.find(entry => entry.key === key);
    if (existing) {
      existing.quantity += quantity;
      continue;
    }
    merged.push({ key, data, quantity });
  }
  return merged;
}

function planCraftDisassemblyPlacement(actor, outputSpecs = [], projectedItems = [], spendPlan = {}) {
  const accepted = [], overflow = [];
  const attempt = specs => {
    const plan = planCraftOutputPlacement(actor, specs, projectedItems);
    if (!plan.valid) return plan;
    try {
      validateActorInventoryState(actor, projectCraftInventoryState(actor, {
        updates: [...(spendPlan?.updates ?? []), ...(plan.updates ?? [])],
        deletes: spendPlan?.deletes ?? [], creates: plan.creates ?? []
      }));
    } catch (error) { return { valid: false, message: error.message }; }
    return plan;
  };
  const complete = attempt(outputSpecs);
  if (complete.valid) return { ...complete, overflow: [] };
  let result = attempt([]);
  for (const spec of outputSpecs) {
    let low = 0, high = spec.quantity;
    while (low < high) {
      const quantity = Math.ceil((low + high) / 2);
      const plan = attempt([...accepted, { ...spec, quantity }]);
      if (plan.valid) { low = quantity; result = plan; } else high = quantity - 1;
    }
    if (low) accepted.push({ ...spec, quantity: low });
    if (low < spec.quantity) overflow.push({ data: spec.data, quantity: spec.quantity - low });
  }
  return { ...result, overflow };
}

function planCraftOutputPlacement(actor, outputSpecs = [], projectedItems = []) {
  const updates = [];
  const creates = [];
  const planningItems = projectedItems.map(item => foundry.utils.deepClone(item));
  const stackCandidateIndex = createInventoryStackCandidateIndex(
    planningItems.filter(item => actor?.items?.has(getItemId(item)))
  );
  const outputContexts = getCraftOutputContexts(actor, planningItems);
  const contextOrder = new Map(outputContexts.map((context, index) => [context.parentId, index]));

  for (const spec of outputSpecs) {
    const maxStack = getItemMaxStack(spec.data);
    let remainingQuantity = Math.max(1, toInteger(spec.quantity) || 1);

    const stackTargets = getCraftOutputStackTargets(actor, spec.data, planningItems, stackCandidateIndex, contextOrder);
    for (const target of stackTargets) {
      if (remainingQuantity <= 0) break;
      const availableSpace = usesVirtualInventoryStacks(target)
        ? Number.POSITIVE_INFINITY
        : Math.max(0, getItemMaxStack(target) - getItemQuantity(target));
      if (!availableSpace) continue;
      const stackQuantity = Math.min(remainingQuantity, availableSpace);
      if (!canCraftOutputIncreaseStack(target, stackQuantity, spec.data, planningItems)) continue;

      const nextQuantity = getItemQuantity(target) + stackQuantity;
      let updateData = null;
      if (usesVirtualInventoryStacks(target)) {
        const overflowQuantity = getItemStackAdditionOverflowQuantity(target, stackQuantity);
        const addedStackParts = createCraftOutputStackParts(
          actor,
          spec.data,
          overflowQuantity,
          getItemContainerParentId(target),
          null,
          planningItems,
          outputContexts
        );
        if (!addedStackParts) continue;
        updateData = createItemStackPartAdditionUpdate(target, stackQuantity, null, addedStackParts);
      } else {
        updateData = { _id: getItemId(target), "system.quantity": nextQuantity };
      }
      if (updateData) upsertCraftOutputUpdate(updates, target, updateData);
      foundry.utils.setProperty(target, "system.quantity", nextQuantity);
      if (updateData?.["system.stackParts"]) foundry.utils.setProperty(target, "system.stackParts", updateData["system.stackParts"]);
      remainingQuantity -= stackQuantity;
    }

    while (remainingQuantity > 0) {
      const virtualStack = usesVirtualInventoryStacks(spec.data);
      const stackQuantity = virtualStack ? remainingQuantity : Math.min(remainingQuantity, maxStack);
      const createData = foundry.utils.deepClone(spec.data);
      foundry.utils.setProperty(createData, "system.quantity", stackQuantity);
      const target = findCraftOutputTarget(actor, createData, planningItems, outputContexts);
      if (!target) {
        return {
          valid: false,
          message: auditLocalize("FALLOUTMAW.AuditApps.EvenAfterConsumingTheComponentsThereIsNot", "Даже после расхода компонентов не хватает места или грузоподъемности для результатов крафта.")
        };
      }
      if (virtualStack) {
        const stackParts = createCraftOutputStackParts(actor, createData, stackQuantity, target.parentId, target.placement, planningItems, outputContexts);
        if (!stackParts) {
          return {
            valid: false,
            message: auditLocalize("FALLOUTMAW.AuditApps.EvenAfterConsumingTheComponentsThereIsNot", "Даже после расхода компонентов не хватает места или грузоподъемности для результатов крафта.")
          };
        }
        foundry.utils.setProperty(createData, "system.stackParts", stackParts);
        const primaryPart = stackParts[0] ?? null;
        if (primaryPart) {
          target.placement.x = primaryPart.x;
          target.placement.y = primaryPart.y;
          target.placement.rotated = Boolean(primaryPart.rotated);
        }
      } else if (usesVirtualInventoryStacks(createData)) {
        foundry.utils.setProperty(createData, "system.stackParts", createItemStackPartsForQuantity(createData, stackQuantity));
      }

      const storedPlacement = createStoredPlacement(target.placement, createData);
      foundry.utils.setProperty(createData, "system.equipped", false);
      foundry.utils.setProperty(createData, "system.container.parentId", target.parentId);
      foundry.utils.setProperty(createData, "system.placement", storedPlacement);
      creates.push(createData);

      const syntheticId = `craft-output-${creates.length}`;
      const projectedCreate = foundry.utils.deepClone(createData);
      projectedCreate._id = syntheticId;
      projectedCreate.id = syntheticId;
      planningItems.push(projectedCreate);
      remainingQuantity -= stackQuantity;
    }
  }

  return { valid: true, updates, creates };
}

function createCraftOutputStackParts(actor, itemData, quantity, parentId, preferredPlacement = null, planningItems = [], outputContexts = []) {
  if (!usesVirtualInventoryStacks(itemData)) return createItemStackPartsForQuantity(itemData, quantity);
  const context = outputContexts.find(entry => entry.parentId === parentId);
  if (!context) return null;
  return createAnchoredItemStackPartsForQuantity({
    itemData,
    quantity,
    preferredPlacement,
    contextItems: getContextInventoryItems(parentId, planningItems),
    columns: context.dimensions.columns,
    rows: context.dimensions.rows,
    allItems: planningItems,
    options: context.options
  });
}

function getCraftOutputStackTargets(actor, itemData, planningItems = [], stackCandidateIndex = null, contextOrder = new Map()) {
  return getInventoryStackCandidates(stackCandidateIndex, itemData).filter(item => (
    actor?.items?.has(getItemId(item))
    && contextOrder.has(getItemContainerParentId(item))
    && canStackItems(itemData, item)
  )).sort((left, right) => {
    const leftContext = contextOrder.get(getItemContainerParentId(left)) ?? Number.MAX_SAFE_INTEGER;
    const rightContext = contextOrder.get(getItemContainerParentId(right)) ?? Number.MAX_SAFE_INTEGER;
    if (leftContext !== rightContext) return leftContext - rightContext;
    return getItemQuantity(right) - getItemQuantity(left);
  });
}

function canCraftOutputIncreaseStack(targetItem, quantity, itemData, planningItems = []) {
  const parentId = getItemContainerParentId(targetItem);
  if (!parentId) return true;
  const container = planningItems.find(item => getItemId(item) === parentId);
  if (!container) return false;
  const maxLoad = getContainerMaxLoad(container);
  const extraData = foundry.utils.deepClone(itemData);
  foundry.utils.setProperty(extraData, "system.quantity", quantity);
  const projectedLoad = getContainerContentsWeight(container, planningItems) + getItemTotalWeight(extraData, planningItems);
  return projectedLoad <= maxLoad;
}

function upsertCraftOutputUpdate(updates, item, changes = {}) {
  const itemId = getItemId(item);
  if (!itemId) return;
  const existing = updates.find(update => update._id === itemId);
  if (existing) {
    Object.assign(existing, changes);
    return;
  }
  updates.push({ _id: itemId, ...changes });
}

function findCraftOutputTarget(actor, itemData, planningItems = [], outputContexts = []) {
  for (const context of outputContexts) {
    if (context.parentId && !canCraftContainerAcceptItem(context.parentId, itemData, planningItems)) continue;
    const placement = findFirstAvailableResolvedInventoryPlacement(
      getContextInventoryItems(context.parentId, planningItems),
      context.dimensions.columns,
      context.dimensions.rows,
      itemData,
      planningItems,
      [],
      [],
      context.options
    );
    if (placement) return { parentId: context.parentId, placement };
  }
  return null;
}

function getCraftOutputContexts(actor, planningItems = []) {
  const race = getActorRace(actor);
  const inventorySize = getActorInventoryGridDimensions(actor, race);
  const contexts = inventorySize.columns > 0 && inventorySize.rows > 0 ? [{
    parentId: ROOT_CONTAINER_ID,
    dimensions: inventorySize,
    options: getActorRootInventoryGridOptions(actor, ROOT_CONTAINER_ID)
  }] : [];

  for (const item of planningItems) {
    if (!isContainerItem(item) || !item.system?.equipped) continue;
    const containerId = getItemId(item);
    if (!containerId) continue;
    const gridOptions = getContainerInventoryGridOptions(item);
    contexts.push({
      parentId: containerId,
      dimensions: gridOptions,
      options: gridOptions
    });
  }
  return contexts;
}

function canCraftContainerAcceptItem(containerId, itemData, planningItems = []) {
  const container = planningItems.find(item => getItemId(item) === containerId);
  if (!container) return false;
  const projectedLoad = getContainerContentsWeight(container, planningItems) + getItemTotalWeight(itemData, planningItems);
  return projectedLoad <= getContainerMaxLoad(container);
}

function projectCraftInventoryState(actor, { updates = [], deletes = [], creates = [] } = {}) {
  const itemMap = new Map(actor.items.contents.map(item => [item.id, item.toObject()]));
  for (const update of updates) {
    if (!update?._id || !itemMap.has(update._id)) continue;
    const nextData = foundry.utils.deepClone(itemMap.get(update._id));
    for (const [key, value] of Object.entries(update)) {
      if (key === "_id") continue;
      foundry.utils.setProperty(nextData, key, value);
    }
    itemMap.set(update._id, nextData);
  }
  for (const deleteId of deletes) itemMap.delete(deleteId);
  let syntheticIndex = 0;
  for (const createData of creates) {
    const syntheticId = String(createData?._id ?? `synthetic-${syntheticIndex += 1}`);
    const nextData = foundry.utils.deepClone(createData);
    nextData._id = syntheticId;
    nextData.id = syntheticId;
    itemMap.set(syntheticId, nextData);
  }
  return Array.from(itemMap.values());
}

async function applyCraftOutputPlan(actor, outputPlan = {}) {
  return executeInventoryMutation({
    actor,
    updates: outputPlan.updates ?? [],
    creates: outputPlan.creates ?? []
  }, { reason: "craft-output" });
}

function prepareCraftContext(recipe, actor, { busy = false, mode = CRAFT_MODE_CREATE, recipeId = DEFAULT_CRAFT_RECIPE_ID, toolPickerNodeId = "", toolSelections = {}, resourceOptions = {} } = {}) {
  mode = normalizeCraftMode(mode);
  const data = getCraftRenderData(recipe, actor, mode, { toolSelections, recipeId });
  data.embeddedChips = [];
  data.embeddedOptional = mode !== CRAFT_MODE_DISASSEMBLY;
  if (mode === CRAFT_MODE_DISASSEMBLY && resourceOptions.sourceItemId) {
    for (const requirement of data.requirements) {
      requirement.itemId = resourceOptions.sourceItemId;
      requirement.owned = getItemQuantity(actor?.items.get(resourceOptions.sourceItemId));
    }
  }
  let resourceError = "";
  try {
    const spendPlan = createCraftRequirementSpendPlan(actor, data.requirements);
    if (mode === CRAFT_MODE_DISASSEMBLY) {
      const resources = prepareCraftDisassemblyResources(actor, data.requirements, data.outputs);
      const byNode = new Map(resources.outputs.flatMap(output => (output.nodeIds ?? []).map(id => [id, output])));
      data.nodes = data.nodes.map(node => {
        if (byNode.has(node.id)) {
          const output = byNode.get(node.id);
          return { ...node, quantity: output.quantity, quantityLabel: formatCraftYieldQuantity(output.quantity, output.fullQuantity) };
        }
        if (node.root && resources.inputs.length === 1) {
          const source = resources.inputs[0].item;
          return { ...node, tooltipUuid: source.uuid, quantityLabel: `${getItemQuantity(source)}/${node.quantity}` };
        }
        return node;
      });
      data.outputs = resources.outputs;
      data.embeddedChips = resources.embedded;
      if (resources.embedded.some(output => !output.data)) resourceError = auditLocalize("FALLOUTMAW.AuditApps.EmbeddedItemNotFound", "Не найден встроенный предмет");
    } else {
      data.embeddedChips = prepareCraftEmbeddedCreation(actor, recipe, spendPlan, recipeId, resourceOptions).chips;
    }
  } catch (error) {
    resourceError = error.message;
    if (mode !== CRAFT_MODE_DISASSEMBLY) data.embeddedChips = planCraftEmbeddedCreation(recipe, [], {
      quantity: getCraftRecipeOutputQuantity(recipe, recipeId), selections: resourceOptions.selections
    }).chips;
  }
  const missingCount = data.requirements.filter(requirement => requirement.owned < requirement.quantity).length
    + data.toolRequirements.filter(requirement => requirement.owned < requirement.quantity).length;
  const checks = getCraftCheckSummaries(data.links);
  const hasRequiredComponents = missingCount === 0;
  const unmetSkillThreshold = getUnmetCraftSkillThreshold(
    actor,
    prepareCraftOperationLinks(data.links, data.nodes)
  );
  const toolPickerNode = data.nodes.find(node => node.id === toolPickerNodeId && node.toolRequirements?.length) ?? null;
  const graph = layoutCraftEmbeddedItems(data.nodes, data.links, data.embeddedChips, mode);
  data.nodes = graph.nodes.map(node => ({ ...node, style: buildCraftNodeStyle(node) }));
  data.links = graph.links;
  data.blocks = getCraftBlocks(data.nodes).map(block => ({ ...block, label: `Craft block ${block.id}`, style: buildCraftNodeStyle(block) }));
  return {
    mode,
    ...data,
    embeddedBusy: busy,
    actionTitle: mode === CRAFT_MODE_DISASSEMBLY ? auditLocalize("FALLOUTMAW.AuditApps.Dismantle", "Разобрать") : auditLocalize("FALLOUTMAW.AuditApps.Craft", "Произвести крафт"),
    actionIcon: mode === CRAFT_MODE_DISASSEMBLY ? "fa-screwdriver-wrench" : "fa-hammer",
    nodes: data.nodes.map(node => ({
      ...node,
      toolPickerOpen: toolPickerNode?.id === node.id
    })),
    toolPicker: null,
    checks,
    canCraft: Boolean((actorKnowsCraftItem(actor, recipe) || (mode === CRAFT_MODE_DISASSEMBLY && canUseOwnedDisassembly(actor, recipe))) && actor?.isOwner && !busy && !resourceError && data.links.length && (data.requirements.length || data.toolRequirements.length) && hasRequiredComponents && !unmetSkillThreshold && (mode !== CRAFT_MODE_DISASSEMBLY || data.outputs.length)),
    summary: resourceError || (unmetSkillThreshold
      ? getCraftSkillThresholdMessage(unmetSkillThreshold, mode)
      : (missingCount
        ? (mode === CRAFT_MODE_DISASSEMBLY ? auditLocalize("FALLOUTMAW.AuditApps.NoItemToDismantle", "Нет предмета для разбора") : auditFormat("FALLOUTMAW.AuditApps.MissingComponentsTools", { v0: (missingCount) }, "Не хватает компонентов/инструментов: {v0}"))
        : (mode === CRAFT_MODE_DISASSEMBLY ? auditFormat("FALLOUTMAW.AuditApps.Results", { v0: (data.outputs.length) }, "Результаты: {v0}") : auditFormat("FALLOUTMAW.AuditApps.ComponentsTools", { v0: (data.requirements.length), v1: (data.toolRequirements.length) }, "Компоненты: {v0}, инструменты: {v1}"))))
  };
}

function createEmptyCraftContext(busy = false) {
  return {
    blocks: [],
    nodes: [],
    links: [],
    requirements: [],
    toolRequirements: [],
    toolPicker: null,
    outputs: [],
    checks: [],
    actionTitle: "",
    actionIcon: "fa-hammer",
    viewportStyle: "",
    canCraft: !busy && false,
    summary: ""
  };
}

function getCraftCheckSummaries(links = []) {
  const skillLabels = new Map(getSkillSettings().map(skill => [skill.key, skill.label]));
  const byCheck = new Map();
  for (const link of links) {
    if (isCraftLinkFailureResult(link) || isCraftLinkNoCheck(link)) continue;
    const skillKey = String(link.skillKey ?? "repair") || "repair";
    const skillLabel = skillLabels.get(skillKey) ?? skillKey;
    const difficulty = normalizeCraftLinkDifficulty(link.difficulty);
    const key = `${skillKey}:${difficulty}`;
    const existing = byCheck.get(key);
    if (existing) {
      existing.count += 1;
      existing.label = getCraftCheckLabel(existing);
      continue;
    }
    const entry = { index: byCheck.size, skillKey, skillLabel, difficulty, count: 1, label: "" };
    entry.label = getCraftCheckLabel(entry);
    byCheck.set(key, entry);
  }
  return Array.from(byCheck.values());
}

function getCraftCheckLabel(check) {
  const suffix = check.count > 1 ? auditFormat("FALLOUTMAW.AuditApps.X", { v0: (check.count) }, " ({v0}х)") : "";
  return auditFormat("FALLOUTMAW.AuditApps.Difficulty", { v0: (check.skillLabel), v1: (check.difficulty), v2: (suffix) }, "{v0}: Сложность {v1}{v2}");
}

function getCraftSkillLabel(skillKey = "") {
  const normalized = String(skillKey ?? "repair") || "repair";
  return getSkillSettings().find(skill => skill.key === normalized)?.label ?? normalized;
}

function prepareCraftOperationLinks(links = [], nodes = []) {
  return links
    .filter(link => !isCraftLinkFailureResult(link))
    .map((link, index) => ({
      id: link.id,
      key: getCraftResolvedLinkKey(link, nodes),
      index,
      noCheck: isCraftLinkNoCheck(link),
      skillKey: String(link.skillKey ?? "repair") || "repair",
      difficulty: normalizeCraftLinkDifficulty(link.difficulty)
    }));
}

function getUnmetCraftSkillThreshold(actor, links = []) {
  if (!isSkillThresholdMode(getCraftingSettings().craft.mode)) return null;
  for (const link of links) {
    if (link.noCheck) continue;
    const skillValue = toInteger(actor?.system?.skills?.[link.skillKey]?.value);
    if (skillValue >= link.difficulty) continue;
    return {
      skillKey: link.skillKey,
      skillLabel: getCraftSkillLabel(link.skillKey),
      skillValue,
      difficulty: link.difficulty
    };
  }
  return null;
}

function getCraftSkillThresholdMessage(threshold = {}, mode = CRAFT_MODE_CREATE) {
  const action = normalizeCraftMode(mode) === CRAFT_MODE_DISASSEMBLY ? auditLocalize("FALLOUTMAW.AuditApps.Dismantling", "разбора") : auditLocalize("FALLOUTMAW.AuditApps.Crafting_381", "крафта");
  return auditFormat("FALLOUTMAW.AuditApps.RequiresCurrently", { v0: (action), v1: (threshold.difficulty), v2: (threshold.skillLabel), v3: (threshold.skillValue) }, "Для {v0} нужно {v1} {v2} (сейчас {v3}).");
}

function getCraftLinkTooltipData(link = null) {
  if (!link || isCraftLinkFailureResult(link) || isCraftLinkNoCheck(link)) return null;
  const skillKey = String(link.skillKey ?? "repair") || "repair";
  return {
    id: String(link.id ?? ""),
    skillLabel: getCraftSkillLabel(skillKey),
    difficulty: normalizeCraftLinkDifficulty(link.difficulty)
  };
}

function getCraftLinkTooltipDataFromAnchor(anchor = null) {
  if (!anchor?.dataset?.craftLinkTooltip) return null;
  return {
    id: String(anchor.dataset.craftLinkId ?? ""),
    skillLabel: String(anchor.dataset.craftLinkSkillLabel ?? ""),
    difficulty: Math.max(0, toInteger(anchor.dataset.craftLinkDifficulty))
  };
}

function getCraftLinkTooltipDocumentKey(anchor = null) {
  if (!anchor?.dataset?.craftLinkTooltip) return "";
  return `craft-link:${anchor.dataset.craftRecipeUuid ?? ""}:${anchor.dataset.craftLinkId ?? ""}`;
}

function renderCraftLinkTooltipHTML({ skillLabel = "", difficulty = 0 } = {}) {
  return auditFormat("FALLOUTMAW.AuditApps.SkillDifficulty", { v0: (escapeHTML(skillLabel)), v1: (escapeHTML(String(difficulty))) }, "\n    <section class=\"content fallout-maw-craft-link-tooltip-content\">\n      <section class=\"functions\">\n        <div class=\"function-section\">\n          <div class=\"function-grid\">\n            <div class=\"function-row\">\n              <span>Навык</span>\n              <strong>{v0}</strong>\n            </div>\n            <div class=\"function-row\">\n              <span>Сложность</span>\n              <strong>{v1}</strong>\n            </div>\n          </div>\n        </div>\n      </section>\n    </section>\n  ");
}

function getCraftRenderData(recipe, actor, mode = CRAFT_MODE_CREATE, { toolSelections = {}, recipeId = DEFAULT_CRAFT_RECIPE_ID, randomizeBlocks = false } = {}) {
  mode = normalizeCraftMode(mode);
  const index = actor ? getCraftAvailabilityIndex(actor) : null;
  const nodes = getCraftNodesWithRoot(recipe, mode, recipeId);
  const links = getCraftLinks(recipe, mode, recipeId, nodes);
  const requirements = mode === CRAFT_MODE_DISASSEMBLY
    ? getCraftRequirements(getCraftMaterialRequirementNodes(nodes, links, mode), { includeRoot: true })
    : getCraftRequirements(getCraftMaterialRequirementNodes(nodes, links, mode, {
      actor,
      index,
      randomize: randomizeBlocks
    }));
  const toolRequirements = getCraftToolRequirements(nodes, { index, actor });
  const outputs = mode === CRAFT_MODE_DISASSEMBLY ? getCraftOutputs(nodes, { links, randomize: randomizeBlocks }) : [];
  const requirementByNodeId = new Map(requirements.flatMap(requirement => requirement.nodeIds.map(nodeId => [nodeId, requirement])));
  const ownedByRequirement = index
    ? getActorOwnedCraftRequirementsFromIndex(index, requirements)
    : getActorOwnedCraftRequirements(actor, requirements);
  const toolSpendPlan = createCraftToolRequirementSpendPlan(actor, toolRequirements, toolSelections, index);
  const toolRequirementByNodeId = new Map(toolRequirements.flatMap(requirement => requirement.nodeIds.map(nodeId => [nodeId, requirement])));
  const getToolCandidates = (requirement) => index
    ? getIndexedActorCraftToolCandidates(index, requirement)
    : getActorCraftToolCandidates(actor, requirement);
  const toolRequirementDisplayByKey = new Map(toolRequirements.map(requirement => {
    const selected = toolSpendPlan.selectedByRequirement.get(requirement.key) ?? null;
    return [requirement.key, {
      ...requirement,
      owned: toolSpendPlan.ownedByRequirement.get(requirement.key) ?? 0,
      selectedInstrument: selected ? prepareCraftToolCandidateForDisplay(selected, requirement, true) : null,
      candidates: getToolCandidates(requirement)
        .map(candidate => prepareCraftToolCandidateForDisplay(candidate, requirement, selected?.id === candidate.id))
    }];
  }));
  const blocks = getCraftBlocks(nodes);
  const viewport = getCraftViewport(recipe, mode, recipeId);
  const sourceMissing = new Set(
    requirements
      .filter(requirement => (ownedByRequirement.get(requirement.key) ?? 0) < requirement.quantity)
      .map(requirement => requirement.key)
  );
  const missingToolNodeIds = new Set(
    toolRequirements
      .filter(requirement => (toolSpendPlan.ownedByRequirement.get(requirement.key) ?? 0) < requirement.quantity)
      .flatMap(requirement => requirement.nodeIds)
  );

  const renderData = {
    blocks: blocks.map(block => ({
      ...block,
      label: `Craft block ${block.id}`,
      style: buildCraftNodeStyle(block)
    })),
    nodes: nodes.map((node, index) => {
      const requirement = requirementByNodeId.get(node.id) ?? null;
      const toolRequirement = toolRequirementByNodeId.get(node.id) ?? null;
      const nodeToolRequirements = toolRequirements
        .filter(entry => entry.nodeIds.includes(node.id))
        .map(entry => toolRequirementDisplayByKey.get(entry.key))
        .filter(Boolean);
      const selectedTool = nodeToolRequirements.find(entry => entry.selectedInstrument)?.selectedInstrument ?? null;
      const sourceUuid = requirement?.sourceUuid ?? getCraftNodeSourceUuid(node);
      const quantity = Math.max(1, toInteger(node.quantity) || 1);
      const owned = node.root && mode !== CRAFT_MODE_DISASSEMBLY ? quantity : (ownedByRequirement.get(requirement?.key) ?? 0);
      const toolOwned = nodeToolRequirements.length
        ? Math.min(...nodeToolRequirements.map(entry => entry.owned))
        : 0;
      return {
        ...node,
        index,
        sourceUuid,
        tooltipUuid: node.root ? recipe.uuid : sourceUuid,
        tooltipActorUuid: selectedTool ? actor?.uuid ?? "" : "",
        tooltipItemId: selectedTool?.id ?? "",
        sourceKeys: requirement?.sourceKeys ?? [],
        isToolRequirement: nodeToolRequirements.length > 0,
        toolRequirements: nodeToolRequirements,
        quantity,
        owned,
        name: selectedTool?.name ?? node.name,
        img: selectedTool?.img ?? node.img,
        quantityLabel: node.root && mode !== CRAFT_MODE_DISASSEMBLY
          ? auditFormat("FALLOUTMAW.AuditApps.X_384", { v0: (quantity) }, "{v0}х")
          : (toolRequirement ? `${toolOwned}/${quantity}` : (requirement ? `${owned}/${quantity}` : auditFormat("FALLOUTMAW.AuditApps.X_384", { v0: (quantity) }, "{v0}х"))),
        missing: Boolean((requirement && sourceMissing.has(requirement.key)) || missingToolNodeIds.has(node.id)),
        style: buildCraftNodeStyle(node)
      };
    }),
    links,
    requirements: requirements.map(requirement => ({
      key: requirement.key,
      sourceUuid: requirement.sourceUuid,
      sourceKeys: requirement.sourceKeys,
      quantity: requirement.quantity,
      owned: ownedByRequirement.get(requirement.key) ?? 0
    })),
    toolRequirements: toolRequirements.map(requirement => toolRequirementDisplayByKey.get(requirement.key) ?? requirement),
    outputs,
    viewport,
    viewportStyle: `--craft-pan-x: ${Math.round(viewport.x)}px; --craft-pan-y: ${Math.round(viewport.y)}px; --craft-zoom: ${viewport.zoom};`
  };
  return renderData;
}

/** Render knowledge previews with the exact read-only craft workspace. */
export function renderCraftKnowledgeVariantsHTML(recipe, actor = null) {
  const recipes = getCraftRecipeEntries(recipe);
  const views = recipes.flatMap(entry => [
    hasCraftKnowledgeLayoutData(entry) ? { recipeId: entry.id, recipeName: entry.name, mode: CRAFT_MODE_CREATE } : null,
    hasCraftKnowledgeLayoutData(entry.disassembly) ? { recipeId: entry.id, recipeName: entry.name, mode: CRAFT_MODE_DISASSEMBLY } : null
  ].filter(Boolean));
  if (!views.length) return "";
  const groupId = `craft-knowledge-${foundry.utils.randomID()}`;
  return `
    <section class="fallout-maw-recipe-knowledge-craft" data-craft-evaluating-actor-uuid="${escapeAttribute(actor?.uuid ?? "")}">
      <div class="fallout-maw-recipe-knowledge-variant-tabs">
        ${views.map((view, index) => {
          const inputId = `${groupId}-${index}`;
          const disassembly = view.mode === CRAFT_MODE_DISASSEMBLY;
          const modeLabel = game.i18n.localize(disassembly ? "FALLOUTMAW.Craft.Disassembly" : "FALLOUTMAW.Craft.Creation");
          const label = recipes.length > 1 ? `${view.recipeName} · ${modeLabel}` : modeLabel;
          const craft = getCraftRenderData(recipe, actor, view.mode, { recipeId: view.recipeId });
          return `
            <input type="radio" id="${escapeAttribute(inputId)}" name="${escapeAttribute(groupId)}" ${index === 0 ? "checked" : ""}>
            <label for="${escapeAttribute(inputId)}" title="${escapeAttribute(label)}"><i class="fa-solid ${disassembly ? "fa-screwdriver-wrench" : "fa-hammer"}"></i><span>${escapeHTML(label)}</span></label>
            <div class="fallout-maw-recipe-knowledge-variant-panel" data-craft-knowledge-panel data-craft-recipe-uuid="${escapeAttribute(recipe.uuid ?? "")}" data-craft-mode="${escapeAttribute(view.mode)}" data-craft-recipe-id="${escapeAttribute(view.recipeId)}">
              ${renderCraftKnowledgeWorkspaceHTML(craft, view.mode)}
            </div>
          `;
        }).join("")}
      </div>
    </section>`;
}

function renderCraftKnowledgeWorkspaceHTML(craft, mode) {
  const blocks = craft.blocks.map(block => `<div class="fallout-maw-craft-block readonly" data-craft-block-id="${escapeAttribute(block.id)}" data-craft-x="${block.x}" data-craft-y="${block.y}" data-craft-width="${block.width}" data-craft-height="${block.height}" style="${escapeAttribute(block.style)}" aria-label="${escapeAttribute(block.label)}"></div>`).join("");
  const nodes = craft.nodes.map(node => `
    <div class="fallout-maw-craft-node readonly ${node.root ? "root" : ""} ${node.isToolRequirement ? "tool-requirement" : ""} ${node.missing ? "missing" : ""}"
      data-craft-node-id="${escapeAttribute(node.id)}" data-craft-block-id="${escapeAttribute(node.blockId)}" data-craft-x="${node.x}" data-craft-y="${node.y}" data-craft-width="${node.width}" data-craft-height="${node.height}"
      ${node.tooltipUuid ? `data-tooltip-uuid="${escapeAttribute(node.tooltipUuid)}"` : ""} style="${escapeAttribute(node.style)}">
      <span class="fallout-maw-craft-node-image"><img src="${escapeAttribute(node.img)}" alt="${escapeAttribute(node.name)}"><span class="fallout-maw-craft-node-quantity">${escapeHTML(node.quantityLabel)}</span></span>
    </div>`).join("");
  const frames = craft.blocks.map(block => `<div class="fallout-maw-craft-block-frame readonly" data-craft-block-frame-id="${escapeAttribute(block.id)}" data-craft-x="${block.x}" data-craft-y="${block.y}" data-craft-width="${block.width}" data-craft-height="${block.height}" style="${escapeAttribute(block.style)}" aria-hidden="true"></div>`).join("");
  return `
    <div class="fallout-maw-craft-editor fallout-maw-craft-viewer fallout-maw-craft-mode-${escapeAttribute(mode)}" data-craft-workspace style="${escapeAttribute(craft.viewportStyle)}">
      <div class="fallout-maw-craft-world" data-craft-world style="${escapeAttribute(craft.viewportStyle)}">
        <svg class="fallout-maw-craft-links" data-craft-links aria-hidden="true"></svg>${blocks}${nodes}${frames}
      </div>
    </div>`;
}

/** Draw exact craft pipes once a tooltip panel is measurable. */
export function activateCraftKnowledgeVariants(root) {
  if (!root) return;
  root.querySelector(".fallout-maw-recipe-knowledge-craft")?.addEventListener("contextmenu", event => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
  });
  const renderVisible = () => {
    for (const panel of root.querySelectorAll("[data-craft-knowledge-panel]")) {
      if (panel.getClientRects().length) renderCraftKnowledgePanelLinks(panel);
    }
  };
  root.addEventListener("change", event => {
    if (event.target.matches(".fallout-maw-recipe-knowledge-variant-tabs > input[type='radio']")) requestAnimationFrame(renderVisible);
  });
  for (const panel of root.querySelectorAll("[data-craft-knowledge-panel]")) activateCraftKnowledgePanelViewport(panel);
  activateCraftKnowledgeNodeTooltips(root);
  requestAnimationFrame(renderVisible);
}

function activateCraftKnowledgePanelViewport(panel) {
  const workspace = panel.querySelector("[data-craft-workspace]");
  const world = workspace?.querySelector("[data-craft-world]");
  if (!workspace || !world || workspace.dataset.craftKnowledgeInteractive === "true") return;
  workspace.dataset.craftKnowledgeInteractive = "true";
  const readViewport = () => {
    const styles = getComputedStyle(workspace);
    return normalizeCraftViewport({
      x: Number.parseFloat(styles.getPropertyValue("--craft-pan-x")),
      y: Number.parseFloat(styles.getPropertyValue("--craft-pan-y")),
      zoom: Number.parseFloat(styles.getPropertyValue("--craft-zoom"))
    });
  };
  const setViewport = (x, y, zoom) => {
    const viewport = normalizeCraftViewport({ x, y, zoom });
    const step = getCraftGridMetrics(workspace).step;
    for (const element of [workspace, world]) {
      element.style.setProperty("--craft-pan-x", `${viewport.x}px`);
      element.style.setProperty("--craft-pan-y", `${viewport.y}px`);
      element.style.setProperty("--craft-zoom", String(viewport.zoom));
    }
    workspace.style.setProperty("--fallout-maw-craft-scaled-step", `${Math.round(step * viewport.zoom)}px`);
    requestAnimationFrame(() => renderCraftKnowledgePanelLinks(panel));
    return viewport;
  };
  let drag = null;
  workspace.addEventListener("contextmenu", event => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
  });
  workspace.addEventListener("pointerdown", event => {
    if (event.button !== 2) return;
    event.preventDefault();
    event.stopPropagation();
    const viewport = readViewport();
    drag = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: viewport.x, y: viewport.y };
    const onMove = moveEvent => {
      if (!drag || moveEvent.pointerId !== drag.pointerId) return;
      moveEvent.preventDefault();
      setViewport(drag.x + moveEvent.clientX - drag.clientX, drag.y + moveEvent.clientY - drag.clientY, readViewport().zoom);
    };
    const onUp = upEvent => {
      if (drag && upEvent.pointerId === drag.pointerId) drag = null;
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  });
  workspace.addEventListener("wheel", event => {
    event.preventDefault();
    event.stopPropagation();
    const rect = workspace.getBoundingClientRect();
    const viewport = readViewport();
    const zoom = clampCraftZoom(viewport.zoom * Math.exp(-event.deltaY * 0.0015));
    if (Math.abs(zoom - viewport.zoom) < 0.001) return;
    const pointerX = event.clientX - rect.left - (rect.width / 2);
    const pointerY = event.clientY - rect.top - (rect.height / 2);
    const worldX = (pointerX - viewport.x) / viewport.zoom;
    const worldY = (pointerY - viewport.y) / viewport.zoom;
    setViewport(pointerX - (worldX * zoom), pointerY - (worldY * zoom), zoom);
  }, { passive: false });
}

function activateCraftKnowledgeNodeTooltips(root) {
  let timer = null;
  let anchor = null;
  const clearTimer = () => {
    if (!timer) return;
    window.clearTimeout(timer);
    timer = null;
  };
  const remove = () => {
    clearTimer();
    if (game.tooltip?.element === anchor) game.tooltip.deactivate();
    anchor = null;
  };
  const scheduleRemove = (node, relatedTarget) => {
    if (node?.contains?.(relatedTarget) || game.tooltip?.tooltip?.contains?.(relatedTarget)) return;
    clearTimer();
    timer = window.setTimeout(() => {
      timer = null;
      if (node?.matches?.(":hover") || game.tooltip?.tooltip?.matches?.(":hover")) return;
      remove();
    }, 140);
  };
  root.addEventListener("pointerover", event => {
    const node = event.target.closest?.("[data-craft-node-id][data-tooltip-uuid]");
    if (!node || node.contains(event.relatedTarget)) return;
    clearTimer();
    anchor = node;
    timer = window.setTimeout(async () => {
      timer = null;
      const item = resolveWorldItemSync(node.dataset.tooltipUuid);
      if (!item || anchor !== node || !node.isConnected) return;
      const sourceActor = item.parent?.documentName === "Actor" ? item.parent : null;
      const evaluatingActorUuid = String(root.querySelector("[data-craft-evaluating-actor-uuid]")?.dataset?.craftEvaluatingActorUuid ?? "");
      const evaluatingActor = await resolveActor(evaluatingActorUuid);
      const html = await renderInventoryItemTooltipHTML(item, sourceActor, { evaluatingActor });
      if (anchor !== node || !node.isConnected) return;
      const content = document.createElement("div");
      content.innerHTML = html;
      content.addEventListener("pointerenter", clearTimer);
      content.addEventListener("pointerleave", leaveEvent => scheduleRemove(node, leaveEvent.relatedTarget));
      content.addEventListener("click", clickEvent => {
        const button = clickEvent.target.closest?.("[data-tooltip-weapon-tab]");
        if (!button) return;
        const index = Math.max(0, toInteger(button.dataset.tooltipWeaponTab));
        activateInventoryTooltipTab(content, index);
      });
      game.tooltip.activate(node, {
        html: content,
        cssClass: "fallout-maw-inventory-tooltip fallout-maw-recipe-knowledge-node-tooltip",
        direction: node.getBoundingClientRect().left > (window.innerWidth / 2) ? "LEFT" : "RIGHT"
      });
    }, 280);
  });
  root.addEventListener("pointerout", event => {
    const node = event.target.closest?.("[data-craft-node-id][data-tooltip-uuid]");
    if (node && !node.contains(event.relatedTarget)) scheduleRemove(node, event.relatedTarget);
  });
}

function renderCraftKnowledgePanelLinks(panel) {
  const workspace = panel.querySelector("[data-craft-workspace]");
  const svg = workspace?.querySelector("[data-craft-links]");
  const recipe = resolveWorldItemSync(panel.dataset.craftRecipeUuid);
  if (!workspace || !svg || !recipe || !svg.getClientRects().length) return;
  const mode = normalizeCraftMode(panel.dataset.craftMode);
  const recipeId = String(panel.dataset.craftRecipeId || DEFAULT_CRAFT_RECIPE_ID);
  const craft = getCraftRenderData(recipe, null, mode, { recipeId });
  const nodeData = new Map(craft.nodes.map(node => [node.id, node]));
  const flowByLink = getCraftLinkFlowMap(craft.links, craft.nodes, mode);
  const fragment = document.createDocumentFragment();
  for (const [linkIndex, link] of craft.links.entries()) {
    const fromNode = nodeData.get(link.fromNodeId);
    const toNode = nodeData.get(link.toNodeId);
    if (!fromNode || !toNode || getCraftResolvedEndpointId(fromNode) === getCraftResolvedEndpointId(toNode)) continue;
    const linkKey = getCraftResolvedLinkKey(link, craft.nodes);
    const flow = flowByLink.get(link.id) ?? getCraftLinkFlow(link, nodeData, mode);
    const from = getCraftEndpointElement(workspace, craft.nodes, flow.fromNodeId);
    const to = getCraftEndpointElement(workspace, craft.nodes, flow.toNodeId);
    if (!from || !to) continue;
    const anchors = flow.reversed ? { from: getCraftLinkAnchor(link, "to"), to: getCraftLinkAnchor(link, "from") } : getCraftLinkAnchors(link);
    appendCraftLinkPath(fragment, getCraftConnectorGeometry(from, to, svg, getCraftLinkBend(link, svg), anchors), link, {
      recipeUuid: recipe.uuid,
      linkKey,
      linkIndex,
      flowFromKey: getCraftResolvedEndpointId(nodeData.get(flow.fromNodeId)),
      flowToKey: getCraftResolvedEndpointId(nodeData.get(flow.toNodeId))
    });
  }
  svg.replaceChildren(fragment);
}

function getCraftRequirements(nodes = [], { includeRoot = false } = {}) {
  const requirements = [];
  for (const node of nodes) {
    if (node.root && !includeRoot) continue;
    if (isCraftNodeToolRequirement(node)) continue;
    const sourceUuid = getCraftNodeSourceUuid(node);
    const quantity = Math.max(1, toInteger(node.quantity) || 1);
    const sourceKeys = getCraftItemSourceProfile(sourceUuid).sourceKeys;
    const key = getCraftRequirementKey({ sourceKeys, sourceUuid });
    const existing = requirements.find(requirement => requirement.key === key);
    if (existing) {
      existing.quantity += quantity;
      existing.nodeIds.push(node.id);
      continue;
    }
    requirements.push({
      key,
      sourceUuid,
      sourceKeys: Array.from(sourceKeys),
      quantity,
      nodeIds: [node.id]
    });
  }
  return requirements;
}

function getCraftToolRequirements(nodes = [], { actor = null, index = null } = {}) {
  const requirements = [];
  const toolLabels = new Map(getToolSettings().map(tool => [tool.key, tool.label]));
  const toolNodes = getCraftToolRequirementNodes(nodes, { actor, index });
  for (const node of toolNodes) {
    if (node.root) continue;
    const quantity = Math.max(1, toInteger(node.quantity) || 1);
    for (const tool of getCraftNodeToolRequirements(node)) {
      const key = getCraftToolRequirementKey(tool);
      const existing = requirements.find(requirement => requirement.key === key);
      if (existing) {
        existing.quantity += quantity;
        existing.nodeIds.push(node.id);
        continue;
      }
      requirements.push({
        key,
        toolKey: tool.toolKey,
        toolLabel: toolLabels.get(tool.toolKey) ?? tool.toolKey,
        toolClass: tool.toolClass,
        quantity,
        nodeIds: [node.id]
      });
    }
  }
  const sourceActor = actor ?? index?.actor ?? null;
  for (const requirement of requirements) {
    requirement.baseQuantity = requirement.quantity;
    requirement.quantity = getCraftToolSupplyCost(
      sourceActor,
      index,
      requirement.toolKey,
      requirement.quantity
    );
  }
  return requirements;
}

function getCraftToolRequirementNodes(nodes = [], { actor = null, index = null } = {}) {
  const output = [];
  const groupedIds = new Set();
  for (const [blockId, blockNodes] of groupCraftNodesByBlock(nodes).entries()) {
    groupedIds.add(blockId);
    const toolNodes = blockNodes.filter(node => isCraftNodeToolRequirement(node));
    if (!toolNodes.length) continue;
    const isToolBlock = toolNodes.length === blockNodes.length;
    const limit = isToolBlock ? normalizeCraftBlockLimit(getCraftBlockLimit(blockNodes)) : null;
    if (!Number.isInteger(limit) || limit <= 0 || limit >= toolNodes.length) {
      output.push(...toolNodes);
      continue;
    }
    output.push(...selectAvailableCraftToolBlockNodes(toolNodes, limit, { actor, index }));
  }
  for (const node of nodes) {
    const blockId = String(node.blockId ?? "");
    if (blockId && groupedIds.has(blockId)) continue;
    if (isCraftNodeToolRequirement(node)) output.push(node);
  }
  return output;
}

function selectAvailableCraftToolBlockNodes(nodes = [], limit = 1, { actor = null, index = null } = {}) {
  const selected = [];
  const selectedIds = new Set();
  const supplyByItemTool = new Map();
  const requiredCount = Math.min(nodes.length, Math.max(1, toInteger(limit) || 1));

  while (selected.length < requiredCount) {
    let best = null;
    for (const node of nodes) {
      if (selectedIds.has(node.id)) continue;
      const score = getCraftToolNodeAvailabilityScore(node, { actor, index, supplyByItemTool });
      if (!best || score.available > best.score.available || (score.available === best.score.available && score.supply > best.score.supply)) {
        best = { node, score };
      }
    }
    if (!best) break;
    selected.push(best.node);
    selectedIds.add(best.node.id);
    reserveCraftToolNodeAvailability(best.node, { actor, index, supplyByItemTool });
  }

  if (selected.length >= requiredCount) return selected;
  for (const node of nodes) {
    if (selectedIds.has(node.id)) continue;
    selected.push(node);
    selectedIds.add(node.id);
    if (selected.length >= requiredCount) break;
  }
  return selected;
}

function getCraftToolNodeAvailabilityScore(node = {}, { actor = null, index = null, supplyByItemTool = new Map() } = {}) {
  let available = 1;
  let supply = 0;
  for (const tool of getCraftNodeToolRequirements(node)) {
    const requirement = {
      key: getCraftToolRequirementKey(tool),
      toolKey: tool.toolKey,
      toolClass: tool.toolClass,
      quantity: getCraftToolSupplyCost(
        actor,
        index,
        tool.toolKey,
        Math.max(1, toInteger(node.quantity) || 1)
      )
    };
    const candidates = index
      ? getIndexedActorCraftToolCandidates(index, requirement, supplyByItemTool)
      : getActorCraftToolCandidates(actor, requirement, supplyByItemTool);
    const selected = getDefaultCraftToolCandidate(candidates, requirement);
    const enough = (selected?.supplyValue ?? 0) >= requirement.quantity;
    if (!enough) available = 0;
    supply += selected?.supplyValue ?? 0;
  }
  return { available, supply };
}

function reserveCraftToolNodeAvailability(node = {}, { actor = null, index = null, supplyByItemTool = new Map() } = {}) {
  for (const tool of getCraftNodeToolRequirements(node)) {
    const requirement = {
      key: getCraftToolRequirementKey(tool),
      toolKey: tool.toolKey,
      toolClass: tool.toolClass,
      quantity: getCraftToolSupplyCost(
        actor,
        index,
        tool.toolKey,
        Math.max(1, toInteger(node.quantity) || 1)
      )
    };
    const candidates = index
      ? getIndexedActorCraftToolCandidates(index, requirement, supplyByItemTool)
      : getActorCraftToolCandidates(actor, requirement, supplyByItemTool);
    const selected = getDefaultCraftToolCandidate(candidates, requirement);
    if (!selected) continue;
    const remaining = Math.max(0, Math.max(0, toInteger(selected.supplyValue)) - requirement.quantity);
    supplyByItemTool.set(selected.supplyKey, remaining);
  }
}

function getCraftNodeToolRequirements(node = {}) {
  const sourceItem = resolveWorldItemSync(getCraftNodeSourceUuid(node));
  if (!sourceItem) return [];
  return getEnabledToolFunctions(sourceItem)
    .filter(tool => !tool.useAsItem)
    .map(tool => ({
      toolKey: String(tool.toolKey ?? "").trim(),
      toolClass: normalizeToolClass(tool.toolClass)
    }))
    .filter(tool => tool.toolKey);
}

function isCraftNodeToolRequirement(node = {}) {
  return Boolean(!node.root && getCraftNodeToolRequirements(node).length);
}

function getCraftToolRequirementKey({ toolKey = "", toolClass = "D" } = {}) {
  return `tool:${toolKey}:${normalizeToolClass(toolClass)}`;
}

function getCraftOutputs(nodes = [], { links = [], randomize = false } = {}) {
  const excludeNodeIds = getCraftFailureOutputNodeIds(nodes, links, CRAFT_MODE_DISASSEMBLY);
  return getCraftBlockLimitedNodes(nodes, { randomize, excludeNodeIds })
    .filter(node => !node.root)
    .filter(node => !isCraftNodeToolRequirement(node))
    .map(node => ({
      sourceUuid: getCraftNodeSourceUuid(node),
      quantity: Math.max(1, toInteger(node.quantity) || 1),
      nodeIds: [node.id]
    }));
}

function getCraftBlockLimitedNodes(nodes = [], { toolsOnly = false, randomize = false, excludeNodeIds = new Set() } = {}) {
  const output = [];
  const groupedIds = new Set();
  const excluded = excludeNodeIds instanceof Set ? excludeNodeIds : new Set(excludeNodeIds ?? []);
  for (const [blockId, blockNodes] of groupCraftNodesByBlock(nodes).entries()) {
    groupedIds.add(blockId);
    const candidates = blockNodes
      .filter(node => !excluded.has(node.id))
      .filter(node => toolsOnly ? isCraftNodeToolRequirement(node) : !isCraftNodeToolRequirement(node));
    const limit = normalizeCraftBlockLimit(getCraftBlockLimit(blockNodes));
    const selected = Number.isInteger(limit) && limit > 0
      ? selectCraftBlockVariantNodes(candidates, limit, { randomize })
      : candidates;
    output.push(...selected);
  }
  for (const node of nodes) {
    const blockId = String(node.blockId ?? "");
    if (blockId && groupedIds.has(blockId)) continue;
    if (excluded.has(node.id)) continue;
    if (toolsOnly && !isCraftNodeToolRequirement(node)) continue;
    if (!toolsOnly && isCraftNodeToolRequirement(node)) continue;
    output.push(node);
  }
  return output;
}

function getCraftMaterialBlockLimitedNodes(nodes = [], {
  actor = null,
  index = null,
  randomize = false,
  excludeNodeIds = new Set()
} = {}) {
  const output = [];
  const choices = [];
  const groupedIds = new Set();
  const excluded = excludeNodeIds instanceof Set ? excludeNodeIds : new Set(excludeNodeIds ?? []);
  for (const [blockId, blockNodes] of groupCraftNodesByBlock(nodes).entries()) {
    groupedIds.add(blockId);
    const candidates = blockNodes
      .filter(node => !excluded.has(node.id))
      .filter(node => !isCraftNodeToolRequirement(node));
    const limit = normalizeCraftBlockLimit(getCraftBlockLimit(blockNodes));
    if (Number.isInteger(limit) && limit > 0 && limit < candidates.length) choices.push({ nodes: candidates, limit });
    else output.push(...candidates);
  }
  for (const node of nodes) {
    const blockId = String(node.blockId ?? "");
    if (blockId && groupedIds.has(blockId)) continue;
    if (excluded.has(node.id) || isCraftNodeToolRequirement(node)) continue;
    output.push(node);
  }
  output.push(...selectAvailableCraftMaterialBlocks(choices, output, { actor, index, randomize }));
  return output;
}

function selectAvailableCraftMaterialBlocks(groups = [], mandatory = [], { actor = null, index = null, randomize = false } = {}) {
  const fallback = () => groups.flatMap(group => selectAvailableCraftMaterialBlockNodes(group.nodes, group.limit, { actor, index, randomize }));
  if (!groups.length || (!actor && !index)) return fallback();
  const allNodes = [...mandatory, ...groups.flatMap(group => group.nodes)];
  const requirements = getCraftRequirements(allNodes);
  const owned = index ? getActorOwnedCraftRequirementsFromIndex(index, requirements) : getActorOwnedCraftRequirements(actor, requirements);
  const nodeRequirements = new Map(allNodes.map(node => [node.id, getCraftRequirements([node])[0] ?? null]));
  const remaining = new Map(owned);
  for (const requirement of getCraftRequirements(mandatory)) {
    const available = (remaining.get(requirement.key) ?? 0) - requirement.quantity;
    if (available < 0) return fallback();
    remaining.set(requirement.key, available);
  }

  // Reserve mandatory materials first, then find compatible choices across
  // blocks. A locally attractive A must not starve a later block when B works.
  const ordered = [...groups].sort((left, right) => left.nodes.length - left.limit - (right.nodes.length - right.limit));
  let attempts = 0;
  const rejected = new Set();
  const chooseGroup = (groupIndex, available) => {
    if (groupIndex === ordered.length) return [];
    // Authored graphs can contain many alternatives; bound backtracking so a
    // pathological diagram cannot freeze the recipe browser.
    if (++attempts > 4096) return null;
    const cacheKey = `${groupIndex}:${JSON.stringify([...available])}`;
    if (rejected.has(cacheKey)) return null;
    const group = ordered[groupIndex];
    const candidates = group.nodes.map((node, order) => {
      const requirement = nodeRequirements.get(node.id);
      const quantity = requirement?.quantity ?? 0;
      const owned = requirement ? available.get(requirement.key) ?? 0 : 0;
      return { node, order, requirement, owned, quantity, batches: quantity ? Math.floor(owned / quantity) : 0 };
    }).filter(entry => entry.requirement && entry.owned >= entry.quantity)
      .sort((left, right) => right.batches - left.batches || right.owned - left.owned || left.order - right.order);
    const chooseNodes = (start, needed, rest, selected) => {
      if (!needed) {
        const following = chooseGroup(groupIndex + 1, rest);
        return following ? [...selected, ...following] : null;
      }
      for (let i = start; i <= candidates.length - needed; i += 1) {
        if (++attempts > 4096) return null;
        const entry = candidates[i];
        const quantity = (rest.get(entry.requirement.key) ?? 0) - entry.quantity;
        if (quantity < 0) continue;
        const next = new Map(rest);
        next.set(entry.requirement.key, quantity);
        const result = chooseNodes(i + 1, needed - 1, next, [...selected, entry.node]);
        if (result) return result;
      }
      return null;
    };
    const result = chooseNodes(0, group.limit, available, []);
    if (!result) rejected.add(cacheKey);
    return result;
  };
  return chooseGroup(0, remaining) ?? fallback();
}

function selectAvailableCraftMaterialBlockNodes(nodes = [], limit = 1, {
  actor = null,
  index = null,
  randomize = false
} = {}) {
  const count = Math.min(nodes.length, Math.max(1, toInteger(limit) || 1));
  if (count >= nodes.length) return [...nodes];
  if (!actor && !index) return selectCraftBlockVariantNodes(nodes, count, { randomize });

  const scored = nodes.map((node, order) => {
    const requirements = getCraftRequirements([node]);
    const requirement = requirements[0] ?? null;
    const ownedByRequirement = index
      ? getActorOwnedCraftRequirementsFromIndex(index, requirements)
      : getActorOwnedCraftRequirements(actor, requirements);
    const owned = requirement ? Math.max(0, toInteger(ownedByRequirement.get(requirement.key))) : 0;
    const quantity = requirement ? Math.max(1, toInteger(requirement.quantity) || 1) : 1;
    return {
      node,
      order,
      available: owned >= quantity ? 1 : 0,
      batches: Math.floor(owned / quantity),
      owned
    };
  });
  scored.sort((left, right) => (
    right.available - left.available
    || right.batches - left.batches
    || right.owned - left.owned
    || left.order - right.order
  ));
  return scored.slice(0, count).map(entry => entry.node);
}

function selectCraftBlockVariantNodes(nodes = [], limit = 1, { randomize = false } = {}) {
  const count = Math.min(nodes.length, Math.max(1, toInteger(limit) || 1));
  if (count >= nodes.length) return [...nodes];
  if (!randomize) return nodes.slice(0, count);
  const pool = [...nodes];
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [pool[index], pool[swapIndex]] = [pool[swapIndex], pool[index]];
  }
  return pool.slice(0, count);
}

function getActorOwnedCraftRequirements(actor, requirements = []) {
  const sources = new Map();
  for (const requirement of requirements) {
    let quantity = 0;
    for (const item of actor?.items?.contents ?? []) {
      if (isNaturalRaceItem(item)) continue;
      if (!craftItemMatchesRequirement(item, requirement)) continue;
      quantity += getItemQuantity(item);
    }
    sources.set(requirement.key, quantity);
  }
  return sources;
}

function createCraftAvailabilityIndex(actor = null) {
  const items = [];
  const itemsBySourceKey = new Map();
  for (const item of actor?.items?.contents ?? []) {
    if (isNaturalRaceItem(item)) continue;
    const quantity = getItemQuantity(item);
    if (quantity <= 0) continue;
    const entry = {
      item,
      quantity,
      sourceKeys: getCraftItemSourceKeys(item),
      tools: getEnabledToolFunctions(item)
    };
    items.push(entry);
    for (const sourceKey of entry.sourceKeys) {
      const bucket = itemsBySourceKey.get(sourceKey) ?? [];
      bucket.push(entry);
      itemsBySourceKey.set(sourceKey, bucket);
    }
  }
  return { actor, items, itemsBySourceKey, toolSupplyCostPercentByKey: new Map() };
}

function getCraftToolSupplyCost(actor = null, index = null, toolKey = "", baseCost = 0) {
  const sourceActor = actor ?? index?.actor ?? null;
  if (!sourceActor) return applyToolSupplyCostPercent(baseCost, 0);
  const key = String(toolKey ?? "").trim();
  const cache = index?.toolSupplyCostPercentByKey;
  let percent = cache?.get(key);
  if (percent === undefined) {
    percent = getActorToolSupplyCostPercent(sourceActor, key, { requester: "craft" });
    cache?.set(key, percent);
  }
  return applyToolSupplyCostPercent(baseCost, percent);
}

function getActorOwnedCraftRequirementsFromIndex(index = null, requirements = []) {
  const sources = new Map();
  for (const requirement of requirements) {
    const quantity = getIndexedCraftRequirementCandidates(index, requirement)
      .reduce((total, item) => total + item.quantity, 0);
    sources.set(requirement.key, quantity);
  }
  return sources;
}

function getIndexedCraftRequirementCandidates(index = null, requirement = {}) {
  const candidates = [];
  const seenItemIds = new Set();
  for (const sourceKey of requirement.sourceKeys ?? []) {
    for (const entry of index?.itemsBySourceKey?.get(sourceKey) ?? []) {
      const itemId = String(entry?.item?.id ?? "");
      if (!itemId || seenItemIds.has(itemId) || !craftIndexedItemMatchesRequirement(entry, requirement)) continue;
      seenItemIds.add(itemId);
      candidates.push(entry);
    }
  }
  return candidates;
}

function craftIndexedItemMatchesRequirement(indexedItem = {}, requirement = {}) {
  if (indexedItem.quantity <= 0) return false;
  if (requirement.itemId && indexedItem.item?.id !== requirement.itemId) return false;

  const requirementKeys = new Set(Array.from(requirement.sourceKeys ?? []).map(key => String(key ?? "").trim()).filter(Boolean));
  const itemKeys = indexedItem.sourceKeys ?? new Set();
  return Boolean(requirementKeys.size && itemKeys.size && setsIntersect(requirementKeys, itemKeys));
}

function craftItemMatchesRequirement(item, requirement = {}) {
  if (getItemQuantity(item) <= 0) return false;

  const requirementKeys = new Set(Array.from(requirement.sourceKeys ?? []).map(key => String(key ?? "").trim()).filter(Boolean));
  const itemKeys = getCraftItemSourceKeys(item);
  return Boolean(requirementKeys.size && itemKeys.size && setsIntersect(requirementKeys, itemKeys));
}

function createCraftToolRequirementAvailabilityPlan(index = null, requirements = []) {
  const supplyByItemTool = new Map();
  const ownedByRequirement = new Map();
  const orderedRequirements = [...requirements]
    .sort((left, right) => toToolClassRank(right.toolClass) - toToolClassRank(left.toolClass));

  for (const requirement of orderedRequirements) {
    const requiredQuantity = Math.max(0, toInteger(requirement.quantity));
    const toolKey = String(requirement.toolKey ?? "").trim();
    if (!requiredQuantity || !toolKey) {
      ownedByRequirement.set(requirement.key, 0);
      continue;
    }

    const selected = getDefaultCraftToolCandidate(getIndexedActorCraftToolCandidates(index, requirement, supplyByItemTool), requirement);
    const owned = selected?.supplyValue ?? 0;
    ownedByRequirement.set(requirement.key, owned);

    let remaining = requiredQuantity;
    if (selected?.supplyValue > 0) {
      const spend = Math.min(selected.supplyValue, remaining);
      selected.supplyValue -= spend;
      remaining -= spend;
      supplyByItemTool.set(selected.supplyKey, selected.supplyValue);
    }
  }

  return { ownedByRequirement };
}

function getIndexedActorCraftToolCandidates(index = null, requirement = {}, supplyByItemTool = new Map()) {
  const requiredClass = normalizeToolClass(requirement.toolClass);
  const toolKey = String(requirement.toolKey ?? "").trim();
  return (index?.items ?? [])
    .flatMap(entry => (entry.tools ?? [])
      .filter(tool => String(tool.toolKey ?? "") === toolKey && isToolClassAccepted(tool.toolClass, requiredClass))
      .map(tool => {
        const resource = tool.resource ?? getToolResourceState(entry.item, tool);
        const supplyKey = `${entry.item.id}:${resource.updatePath}`;
        const supplyValue = supplyByItemTool.has(supplyKey)
          ? supplyByItemTool.get(supplyKey)
          : (resource.available ? resource.value : 0);
        return {
          id: entry.item.id,
          item: entry.item,
          name: entry.item.name ?? "",
          img: normalizeImagePath(entry.item.img || FALLBACK_ICON),
          toolKey,
          supplyKey,
          resourceMode: resource.mode,
          resourcePath: resource.updatePath,
          deletesItemOnDepletion: resource.deletesItemOnDepletion,
          toolClass: normalizeToolClass(tool.toolClass),
          supplyValue
        };
      }))
    .filter(candidate => candidate.supplyValue > 0)
    .sort((left, right) => (
      Number(right.supplyValue >= Math.max(0, toInteger(requirement.quantity))) - Number(left.supplyValue >= Math.max(0, toInteger(requirement.quantity)))
      || (toToolClassRank(left.toolClass) - toToolClassRank(requiredClass)) - (toToolClassRank(right.toolClass) - toToolClassRank(requiredClass))
      || right.supplyValue - left.supplyValue
      || String(left.item.name ?? "").localeCompare(String(right.item.name ?? ""), game.i18n.lang)
      || String(left.id ?? "").localeCompare(String(right.id ?? ""), game.i18n.lang)
    ));
}

function getCraftRequirementKey({ sourceKeys = new Set(), sourceUuid = "" } = {}) {
  const normalizedKeys = Array.from(sourceKeys).map(key => String(key ?? "").trim()).filter(Boolean).sort();
  return JSON.stringify(normalizedKeys.length ? normalizedKeys : [String(sourceUuid ?? "").trim()].filter(Boolean));
}

function getCraftItemFingerprint(itemOrNode = null) {
  const system = itemOrNode?.system ?? itemOrNode ?? {};
  const footprint = getCraftItemFootprint(itemOrNode);
  const creatureOptions = getCreatureOptions();
  const weaponRequirement = getWeaponSlotRequirement(system);
  return JSON.stringify(normalizeStackComparableValue({
    type: itemOrNode?.type ?? system?.type ?? "",
    name: itemOrNode?.name ?? "",
    img: normalizeImagePath(itemOrNode?.img || FALLBACK_ICON),
    weight: Number(system.weight) || 0,
    price: Number(system.price) || 0,
    priceCurrency: String(system.priceCurrency ?? ""),
    maxStack: getItemMaxStack(itemOrNode),
    width: footprint.width,
    height: footprint.height,
    equipmentSlots: Array.from(getValidSelectedEquipmentSlotKeysForOptions(creatureOptions, system)).sort(),
    weaponSlotRequirement: {
      mode: weaponRequirement.mode,
      selectedKeys: Array.from(getValidSelectedWeaponSlotKeysForOptions(creatureOptions, system)).sort()
    },
    functions: system.functions ?? {}
  }));
}

function normalizeStackComparableValue(value) {
  if (typeof value?.toObject === "function") return normalizeStackComparableValue(value.toObject(false));
  if (value instanceof Set) return Array.from(value).sort();
  if (Array.isArray(value)) return value.map(entry => normalizeStackComparableValue(entry));
  if (!value || typeof value !== "object") return value ?? null;

  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  return Object.fromEntries(entries.map(([key, entryValue]) => [key, normalizeStackComparableValue(entryValue)]));
}

function setsIntersect(left, right) {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

function getCraftItemFootprint(itemOrNode = null) {
  const placement = itemOrNode?.system?.placement ?? itemOrNode?.placement ?? {};
  return {
    width: Math.max(1, toInteger(placement.width) || toInteger(itemOrNode?.width) || 1),
    height: Math.max(1, toInteger(placement.height) || toInteger(itemOrNode?.height) || 1)
  };
}

function getCraftNodeSourceUuid(node) {
  return String(node?.itemUuid ?? "").trim();
}

function normalizeCraftMode(mode) {
  return String(mode ?? "") === CRAFT_MODE_DISASSEMBLY ? CRAFT_MODE_DISASSEMBLY : CRAFT_MODE_CREATE;
}

function getCraftModeChoices(activeMode = CRAFT_MODE_CREATE) {
  const mode = normalizeCraftMode(activeMode);
  return [
    {
      key: CRAFT_MODE_CREATE,
      label: auditLocalize("FALLOUTMAW.Craft.Creation", "Создание"),
      selected: mode === CRAFT_MODE_CREATE
    },
    {
      key: CRAFT_MODE_DISASSEMBLY,
      label: auditLocalize("FALLOUTMAW.Craft.Disassembly", "Разбор"),
      selected: mode === CRAFT_MODE_DISASSEMBLY
    }
  ];
}

function getCraftRecipeEntry(item, recipeId = DEFAULT_CRAFT_RECIPE_ID) {
  const recipes = getCraftRecipeEntries(item);
  return recipes.find(recipe => recipe.id === recipeId) ?? recipes[0] ?? createDefaultCraftRecipeEntry(item);
}

function getCraftRecipeEntries(itemOrCraft = {}) {
  const craft = itemOrCraft?.system?.craft ?? itemOrCraft ?? {};
  if (craft && typeof craft === "object" && craftRecipeEntryCache.has(craft)) {
    return craftRecipeEntryCache.get(craft);
  }
  const legacyRecipe = createDefaultCraftRecipeEntry({ system: { craft } });
  const source = Array.isArray(craft?.recipes) && craft.recipes.length
    ? craft.recipes
    : [legacyRecipe];
  const usedIds = new Set();
  const entries = source.map((entry, index) => {
    const fallback = (index === 0 || entry?.id === DEFAULT_CRAFT_RECIPE_ID) ? legacyRecipe : {};
    const normalized = normalizeCraftRecipeEntry(mergeCraftRecipeWithLegacyFallback(entry, fallback), index, usedIds);
    usedIds.add(normalized.id);
    return normalized;
  });
  if (!entries.some(entry => entry.id === DEFAULT_CRAFT_RECIPE_ID)) {
    entries.unshift(legacyRecipe);
  }
  if (craft && typeof craft === "object") craftRecipeEntryCache.set(craft, entries);
  return entries;
}

function createDefaultCraftRecipeEntry(itemOrCraft = {}) {
  const craft = itemOrCraft?.system?.craft ?? itemOrCraft ?? {};
  return normalizeCraftRecipeEntry({
    id: DEFAULT_CRAFT_RECIPE_ID,
    name: DEFAULT_CRAFT_RECIPE_NAME(),
    nodes: craft.nodes ?? [],
    links: craft.links ?? [],
    viewport: craft.viewport ?? {},
    disassembly: craft.disassembly ?? {}
  }, 0);
}

function normalizeCraftRecipeEntry(entry = {}, index = 0, usedIds = new Set()) {
  const fallbackId = index === 0 ? DEFAULT_CRAFT_RECIPE_ID : `recipe${index + 1}`;
  let id = String(entry?.id ?? fallbackId).trim() || fallbackId;
  id = getUniqueCraftRecipeId(id, usedIds);
  return {
    id,
    name: String(entry?.name ?? (index === 0 ? DEFAULT_CRAFT_RECIPE_NAME() : auditFormat("FALLOUTMAW.AuditApps.Recipe", { v0: (index + 1) }, "Рецепт_{v0}"))).trim() || auditFormat("FALLOUTMAW.AuditApps.Recipe", { v0: (index + 1) }, "Рецепт_{v0}"),
    ...normalizeCraftRecipeLayout(entry),
    disassembly: normalizeCraftRecipeLayout(entry?.disassembly)
  };
}

function mergeCraftRecipeWithLegacyFallback(entry = {}, fallback = {}) {
  const source = foundry.utils.deepClone(entry ?? {});
  const hasLegacyData = hasCraftRecipeEntryData(fallback);
  const isDefaultRecipe = !source.id || source.id === DEFAULT_CRAFT_RECIPE_ID;
  if (!hasLegacyData || !isDefaultRecipe || hasCraftRecipeEntryData(source)) {
    return { ...fallback, ...source };
  }
  return {
    ...source,
    nodes: fallback.nodes,
    links: fallback.links,
    viewport: fallback.viewport,
    disassembly: fallback.disassembly
  };
}

function normalizeCraftRecipeLayout(layout = {}) {
  return {
    nodes: Array.from(layout?.nodes ?? []).map(normalizeCraftNode),
    links: Array.from(layout?.links ?? []).map(normalizeCraftLink),
    viewport: normalizeCraftViewport(layout?.viewport ?? {})
  };
}

function getUniqueCraftRecipeId(baseId = "recipe", usedIds = new Set()) {
  const used = usedIds instanceof Set ? usedIds : new Set(usedIds ?? []);
  const base = String(baseId ?? "").trim() || "recipe";
  if (!used.has(base)) return base;
  let index = 2;
  while (used.has(`${base}${index}`)) index += 1;
  return `${base}${index}`;
}

function hasCraftRecipeEntryData(recipe = {}) {
  return Boolean(
    (recipe?.nodes ?? []).length
    || (recipe?.links ?? []).length
    || (recipe?.disassembly?.nodes ?? []).length
    || (recipe?.disassembly?.links ?? []).length
  );
}

function getCraftRecipeData(item, mode = CRAFT_MODE_CREATE, recipeId = DEFAULT_CRAFT_RECIPE_ID) {
  const recipe = getCraftRecipeEntry(item, recipeId);
  if (normalizeCraftMode(mode) === CRAFT_MODE_DISASSEMBLY) return recipe.disassembly ?? {};
  return recipe;
}

function getCraftNodesWithRoot(item, mode = CRAFT_MODE_CREATE, recipeId = DEFAULT_CRAFT_RECIPE_ID) {
  const nodes = getCraftNodes(item, mode, recipeId);
  const rootIndex = nodes.findIndex(node => node.root);
  const root = createCraftRootNode(item, rootIndex >= 0 ? nodes[rootIndex] : {});
  if (rootIndex >= 0) {
    nodes[rootIndex] = root;
    return nodes;
  }
  const result = [root, ...nodes];
  return result;
}

function getCraftNodes(item, mode = CRAFT_MODE_CREATE, recipeId = DEFAULT_CRAFT_RECIPE_ID) {
  return Array.from(getCraftRecipeData(item, mode, recipeId)?.nodes ?? [])
    .map(normalizeCraftNode)
    .map(refreshCraftNodeFromSource)
    .filter(node => node.id);
}

function refreshCraftNodeFromSource(node = {}) {
  if (node.root) return node;
  const source = resolveWorldItemSync(getCraftNodeSourceUuid(node));
  if (!source) {
    return node;
  }
  const footprint = getCraftItemFootprint(source);
  const refreshed = normalizeCraftNode({
    ...node,
    name: source.name ?? node.name,
    img: normalizeImagePath(source.img || node.img, FALLBACK_ICON),
    type: source.type ?? node.type,
    width: footprint.width,
    height: footprint.height
  });
  return refreshed;
}

function getCraftLinks(item, mode = CRAFT_MODE_CREATE, recipeId = DEFAULT_CRAFT_RECIPE_ID, nodes = null) {
  nodes ??= getCraftNodesWithRoot(item, mode, recipeId);
  const links = normalizeCraftLinksForNodes(Array.from(getCraftRecipeData(item, mode, recipeId)?.links ?? []), nodes);
  return links;
}

function getCraftViewport(item, mode = CRAFT_MODE_CREATE, recipeId = DEFAULT_CRAFT_RECIPE_ID) {
  return normalizeCraftViewport(getCraftRecipeData(item, mode, recipeId)?.viewport ?? {});
}

function getCraftFitViewport(item, mode = CRAFT_MODE_CREATE, workspace = null, recipeId = DEFAULT_CRAFT_RECIPE_ID, nodes = null) {
  nodes ??= getCraftNodesWithRoot(item, mode, recipeId);
  const bounds = getCraftNodesBounds(nodes);
  const rect = workspace?.getBoundingClientRect?.();
  if (!bounds || !rect?.width || !rect?.height) return getCraftViewport(item, mode, recipeId);
  const metrics = getCraftGridMetrics(workspace);
  const paddedWidth = Math.max(1, bounds.width + 2) * metrics.step;
  const paddedHeight = Math.max(1, bounds.height + 2) * metrics.step;
  const zoom = clampCraftZoom(Math.min(rect.width / paddedWidth, rect.height / paddedHeight));
  return normalizeCraftViewport({
    x: -(Number(bounds.x) || 0) * metrics.step * zoom,
    y: -(Number(bounds.y) || 0) * metrics.step * zoom,
    zoom
  });
}

function createCraftRootNode(item, source = {}) {
  const placement = item?.system?.placement ?? {};
  const width = Math.max(1, toInteger(placement.width) || toInteger(source.width) || 1);
  const height = Math.max(1, toInteger(placement.height) || toInteger(source.height) || 1);
  const rootItemUuid = String(item?.itemUuid ?? item?.uuid ?? source.itemUuid ?? "");
  return normalizeCraftNode({
    ...source,
    id: String(source.id || CRAFT_ROOT_NODE_ID),
    itemUuid: rootItemUuid,
    name: item?.name ?? "",
    img: normalizeImagePath(item?.img || FALLBACK_ICON),
    type: item?.type ?? "",
    width,
    height,
    quantity: Math.max(1, toInteger(source.quantity) || toInteger(item?.system?.quantity) || 1),
    blockId: String(source.blockId ?? ""),
    blockLimit: normalizeCraftBlockLimit(source.blockLimit),
    root: true
  });
}

function normalizeCraftNode(node = {}) {
  const width = Math.max(1, toInteger(node.width) || 1);
  const height = Math.max(1, toInteger(node.height) || 1);
  return {
    id: String(node.id ?? ""),
    itemUuid: String(node.itemUuid ?? ""),
    name: String(node.name ?? ""),
    img: normalizeImagePath(node.img, FALLBACK_ICON),
    type: String(node.type ?? ""),
    x: snapCraftGridCoordinate(node.x, width),
    y: snapCraftGridCoordinate(node.y, height),
    width,
    height,
    quantity: Math.max(1, toInteger(node.quantity) || 1),
    blockId: String(node.blockId ?? ""),
    blockLimit: normalizeCraftBlockLimit(node.blockLimit),
    root: Boolean(node.root)
  };
}

function normalizeCraftBlockLimit(value) {
  if (value === null || value === undefined || value === "") return null;
  const limit = Math.max(0, toInteger(value));
  return limit > 0 ? limit : null;
}

function normalizeCraftLink(link = {}) {
  let bendX = toOptionalNumber(link.bendX);
  let bendY = toOptionalNumber(link.bendY);
  const fromAnchorOffset = toOptionalNumber(link.fromAnchorOffset);
  const toAnchorOffset = toOptionalNumber(link.toAnchorOffset);
  if (bendX === 0 && bendY === 0) {
    bendX = null;
    bendY = null;
  }
  return {
    id: String(link.id || getCraftFallbackLinkId(link)),
    fromNodeId: String(link.fromNodeId ?? ""),
    toNodeId: String(link.toNodeId ?? ""),
    skillKey: String(link.skillKey ?? "repair"),
    difficulty: normalizeCraftLinkDifficulty(link.difficulty),
    noCheck: isCraftLinkNoCheck(link),
    failureResult: isCraftLinkFailureResult(link),
    bendX,
    bendY,
    fromAnchorSide: normalizeCraftAnchorSide(link.fromAnchorSide),
    fromAnchorOffset: Number.isFinite(fromAnchorOffset) ? clampNumber(fromAnchorOffset, 0, 1) : null,
    toAnchorSide: normalizeCraftAnchorSide(link.toAnchorSide),
    toAnchorOffset: Number.isFinite(toAnchorOffset) ? clampNumber(toAnchorOffset, 0, 1) : null
  };
}

function normalizeCraftLinkDifficulty(value, fallback = 60) {
  const number = Number(value);
  return Math.max(0, Number.isFinite(number) ? Math.trunc(number) : fallback);
}

function isCraftLinkNoCheck(link = {}) {
  if (isCraftLinkFailureResult(link)) return true;
  const value = link?.noCheck;
  return value === true || value === "true" || value === 1 || value === "1" || value === "on";
}

function isCraftLinkFailureResult(link = {}) {
  const value = link?.failureResult;
  return value === true || value === "true" || value === 1 || value === "1" || value === "on";
}

function isCraftOutputResourceNode(node, mode = CRAFT_MODE_CREATE) {
  if (!node || isCraftNodeToolRequirement(node)) return false;
  return normalizeCraftMode(mode) === CRAFT_MODE_DISASSEMBLY ? !node.root : Boolean(node.root);
}

function isCraftLinkConnectedToOutputResource(link, nodes = [], mode = CRAFT_MODE_CREATE) {
  const from = nodes.find(node => node.id === link.fromNodeId);
  const to = nodes.find(node => node.id === link.toNodeId);
  return isCraftOutputResourceNode(from, mode) || isCraftOutputResourceNode(to, mode);
}

function getCraftFailureOutputNodeIds(nodes = [], links = [], mode = CRAFT_MODE_CREATE) {
  mode = normalizeCraftMode(mode);
  const outputResourceIds = new Set(
    nodes.filter(node => isCraftOutputResourceNode(node, mode)).map(node => node.id)
  );
  const failureNodeIds = new Set();
  for (const link of links) {
    if (!isCraftLinkFailureResult(link)) continue;
    if (mode === CRAFT_MODE_DISASSEMBLY) {
      // The root is the consumed object here; the marked output endpoint is
      // the failed dismantling result. Creation instead branches off its root.
      if (outputResourceIds.has(link.fromNodeId)) failureNodeIds.add(link.fromNodeId);
      if (outputResourceIds.has(link.toNodeId)) failureNodeIds.add(link.toNodeId);
    } else {
      if (outputResourceIds.has(link.fromNodeId)) failureNodeIds.add(link.toNodeId);
      if (outputResourceIds.has(link.toNodeId)) failureNodeIds.add(link.fromNodeId);
    }
  }
  return failureNodeIds;
}

function getCraftFailureOutputs(nodes = [], links = [], mode = CRAFT_MODE_CREATE) {
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const failureNodeIds = getCraftFailureOutputNodeIds(nodes, links, mode);
  return Array.from(failureNodeIds)
    .map(nodeId => nodeById.get(nodeId))
    .filter(node => node && !node.root && !isCraftNodeToolRequirement(node))
    .map(node => ({
      sourceUuid: getCraftNodeSourceUuid(node),
      quantity: Math.max(1, toInteger(node.quantity) || 1),
      nodeIds: [node.id]
    }))
    .filter(output => output.sourceUuid);
}

function getCraftFallbackLinkId(link = {}) {
  return [
    "link",
    String(link.fromNodeId ?? ""),
    String(link.toNodeId ?? ""),
    String(link.skillKey ?? "repair"),
    String(link.difficulty ?? 60),
    String(link.fromAnchorSide ?? ""),
    String(link.fromAnchorOffset ?? ""),
    String(link.toAnchorSide ?? ""),
    String(link.toAnchorOffset ?? ""),
    String(link.noCheck ?? false),
    String(link.failureResult ?? false),
    String(link.bendX ?? ""),
    String(link.bendY ?? "")
  ].join(":");
}

function normalizeCraftLinksForNodes(links = [], nodes = []) {
  const nodeIds = new Set(nodes.map(node => node.id));
  const byResolvedPair = new Map();
  for (const rawLink of links) {
    const link = normalizeCraftLink(rawLink);
    if (!nodeIds.has(link.fromNodeId) || !nodeIds.has(link.toNodeId) || link.fromNodeId === link.toNodeId) continue;
    const key = getCraftResolvedLinkKey(link, nodes);
    if (!key || byResolvedPair.has(key)) continue;
    byResolvedPair.set(key, link);
  }
  return Array.from(byResolvedPair.values());
}

function getCraftResolvedLinkKey(link, nodes = []) {
  return getCraftResolvedPairKey(link.fromNodeId, link.toNodeId, nodes);
}

function getCraftResolvedPairKey(fromNodeId, toNodeId, nodes = []) {
  const from = nodes.find(node => node.id === fromNodeId);
  const to = nodes.find(node => node.id === toNodeId);
  const fromKey = getCraftResolvedEndpointId(from);
  const toKey = getCraftResolvedEndpointId(to);
  if (!fromKey || !toKey || fromKey === toKey) return "";
  return [fromKey, toKey].sort().join("|");
}

function getCraftResolvedEndpointId(node) {
  if (!node) return "";
  return node.blockId ? `block:${node.blockId}` : `node:${node.id}`;
}

function getCraftBlocks(nodes = []) {
  return Array.from(groupCraftNodesByBlock(nodes).entries())
    .map(([id, blockNodes]) => ({
      id,
      nodeIds: blockNodes.map(node => node.id),
      nodeCount: blockNodes.length,
      blockLimit: getCraftBlockLimit(blockNodes),
      isToolBlock: blockNodes.length > 0 && blockNodes.every(node => isCraftNodeToolRequirement(node)),
      ...getCraftNodesBounds(blockNodes)
    }))
    .filter(block => block.nodeIds.length > 1 && block.width > 0 && block.height > 0);
}

function getCraftBlockLimit(nodes = []) {
  for (const node of nodes) {
    const limit = normalizeCraftBlockLimit(node.blockLimit);
    if (Number.isInteger(limit) && limit > 0) return limit;
  }
  return null;
}

function groupCraftNodesByBlock(nodes = []) {
  const groups = new Map();
  for (const node of nodes) {
    if (!node.blockId) continue;
    if (!groups.has(node.blockId)) groups.set(node.blockId, []);
    groups.get(node.blockId).push(node);
  }
  return groups;
}

function craftNodeToBounds(node = {}) {
  const width = Math.max(1, toInteger(node.width) || 1);
  const height = Math.max(1, toInteger(node.height) || 1);
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
    width: Math.max(1, Math.round(right - left)),
    height: Math.max(1, Math.round(bottom - top))
  };
}

function buildCraftNodeStyle(node) {
  const width = Math.max(1, toInteger(node.width) || 1);
  const height = Math.max(1, toInteger(node.height) || 1);
  const widthPx = (width * 52) + ((width - 1) * 4);
  const heightPx = (height * 52) + ((height - 1) * 4);
  return [
    `--craft-x: ${Number(node.x) || 0};`,
    `--craft-y: ${Number(node.y) || 0};`,
    `--craft-width: ${width};`,
    `--craft-height: ${height};`,
    `--craft-offset-x: ${(Number(node.x) || 0) * CRAFT_GRID_FALLBACK_STEP}px;`,
    `--craft-offset-y: ${(Number(node.y) || 0) * CRAFT_GRID_FALLBACK_STEP}px;`,
    `--craft-node-width: ${widthPx}px;`,
    `--craft-node-height: ${heightPx}px;`,
    `--craft-node-half-width: ${widthPx / 2}px;`,
    `--craft-node-half-height: ${heightPx / 2}px;`
  ].join(" ");
}

function snapCraftGridCoordinate(value, size = 1) {
  const numericSize = Math.max(1, toInteger(size) || 1);
  const offset = numericSize % 2 === 0 ? 0.5 : 0;
  const number = Number(value);
  return (Number.isFinite(number) ? Math.round(number - offset) : 0) + offset;
}

function normalizeCraftViewport(viewport = {}) {
  return {
    x: Math.round(Number(viewport.x) || 0),
    y: Math.round(Number(viewport.y) || 0),
    zoom: clampCraftZoom(viewport.zoom)
  };
}

function clampCraftZoom(value) {
  const zoom = Number(value);
  if (!Number.isFinite(zoom)) return 1;
  return Math.max(CRAFT_MIN_ZOOM, Math.min(CRAFT_MAX_ZOOM, zoom));
}

function applyCraftElementLayout(element, { x = 0, y = 0, width = 1, height = 1 } = {}, metrics = null) {
  metrics ??= getCraftGridMetrics(element?.closest?.("[data-craft-workspace]"));
  const normalizedWidth = Math.max(1, toInteger(width) || 1);
  const normalizedHeight = Math.max(1, toInteger(height) || 1);
  const widthPx = (normalizedWidth * metrics.cell) + ((normalizedWidth - 1) * metrics.gap);
  const heightPx = (normalizedHeight * metrics.cell) + ((normalizedHeight - 1) * metrics.gap);
  element.style.setProperty("--craft-offset-x", `${(Number(x) || 0) * metrics.step}px`);
  element.style.setProperty("--craft-offset-y", `${(Number(y) || 0) * metrics.step}px`);
  element.style.setProperty("--craft-node-width", `${widthPx}px`);
  element.style.setProperty("--craft-node-height", `${heightPx}px`);
  element.style.setProperty("--craft-node-half-width", `${widthPx / 2}px`);
  element.style.setProperty("--craft-node-half-height", `${heightPx / 2}px`);
}

function getCraftGridMetrics(element) {
  const styles = element ? getComputedStyle(element) : null;
  const cell = Math.max(1, cssDimensionToPixels(styles?.getPropertyValue("--fallout-maw-craft-cell-size") || "52px", element)) || 52;
  const gap = Math.max(0, cssDimensionToPixels(styles?.getPropertyValue("--fallout-maw-craft-grid-gap") || "4px", element)) || 4;
  const step = Math.max(1, cell + gap) || CRAFT_GRID_FALLBACK_STEP;
  return { cell, gap, step };
}

function clampCraftViewportToVisibleNode(viewport, workspace, nodes = []) {
  const workspaceRect = workspace?.getBoundingClientRect();
  if (!workspaceRect || workspaceRect.width <= 0 || workspaceRect.height <= 0 || !nodes.length) return viewport;
  const metrics = getCraftGridMetrics(workspace);
  const context = { metrics, width: workspaceRect.width, height: workspaceRect.height };
  if (nodes.some(node => isCraftNodeVisibleInViewport(node, viewport, context))) return viewport;
  let nearestAdjustment = null;
  for (const node of nodes) {
    const nodeRect = getCraftNodeScreenRect(node, viewport, context);
    const dx = getCraftNodeContainmentDelta(nodeRect.left, nodeRect.right, context.width);
    const dy = getCraftNodeContainmentDelta(nodeRect.top, nodeRect.bottom, context.height);
    const distance = Math.hypot(dx, dy);
    if (!nearestAdjustment || distance < nearestAdjustment.distance) {
      nearestAdjustment = { dx, dy, distance };
    }
  }
  if (!nearestAdjustment) return viewport;
  return normalizeCraftViewport({
    ...viewport,
    x: viewport.x + nearestAdjustment.dx,
    y: viewport.y + nearestAdjustment.dy
  });
}

function isCraftNodeVisibleInViewport(node, viewport, context) {
  const nodeRect = getCraftNodeScreenRect(node, viewport, context);
  return nodeRect.left >= 0
    && nodeRect.right <= context.width
    && nodeRect.top >= 0
    && nodeRect.bottom <= context.height;
}

function getCraftNodeContainmentDelta(start, end, size) {
  const nodeSize = end - start;
  if (nodeSize > size) return (size / 2) - ((start + end) / 2);
  if (start < 0) return -start;
  if (end > size) return size - end;
  return 0;
}

function getCraftNodeScreenRect(node, viewport, context) {
  const metrics = context.metrics;
  const width = Math.max(1, toInteger(node.width) || 1);
  const height = Math.max(1, toInteger(node.height) || 1);
  const widthPx = (width * metrics.cell) + ((width - 1) * metrics.gap);
  const heightPx = (height * metrics.cell) + ((height - 1) * metrics.gap);
  const centerX = ((Number(node.x) || 0) * metrics.step);
  const centerY = ((Number(node.y) || 0) * metrics.step);
  const zoom = clampCraftZoom(viewport.zoom);
  const screenCenterX = (context.width / 2) + viewport.x + (centerX * zoom);
  const screenCenterY = (context.height / 2) + viewport.y + (centerY * zoom);
  const halfWidth = (widthPx * zoom) / 2;
  const halfHeight = (heightPx * zoom) / 2;
  return {
    left: screenCenterX - halfWidth,
    right: screenCenterX + halfWidth,
    top: screenCenterY - halfHeight,
    bottom: screenCenterY + halfHeight
  };
}

function cssDimensionToPixels(value, element = document.documentElement) {
  const raw = String(value ?? "").trim();
  const numeric = Number.parseFloat(raw);
  if (!Number.isFinite(numeric)) return 0;
  if (raw.endsWith("rem")) return numeric * (Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
  if (raw.endsWith("em")) return numeric * (Number.parseFloat(getComputedStyle(element).fontSize) || 16);
  return numeric;
}

function getCraftLinkFlow(link, nodeData, mode = CRAFT_MODE_CREATE) {
  mode = normalizeCraftMode(mode);
  const from = nodeData.get(link.fromNodeId);
  const to = nodeData.get(link.toNodeId);
  if (mode === CRAFT_MODE_DISASSEMBLY) {
    if (!from?.root && to?.root) return { fromNodeId: link.toNodeId, toNodeId: link.fromNodeId, reversed: true };
    return { fromNodeId: link.fromNodeId, toNodeId: link.toNodeId, reversed: false };
  }
  if (from?.root && !to?.root) return { fromNodeId: link.toNodeId, toNodeId: link.fromNodeId, reversed: true };
  return { fromNodeId: link.fromNodeId, toNodeId: link.toNodeId, reversed: false };
}

function getCraftLinkFlowMap(links = [], nodes = [], mode = CRAFT_MODE_CREATE) {
  mode = normalizeCraftMode(mode);
  const nodeData = new Map(nodes.map(node => [node.id, node]));
  const root = nodes.find(node => node.root);
  const rootKey = getCraftResolvedEndpointId(root);
  const graph = new Map();
  for (const link of links) {
    const from = nodeData.get(link.fromNodeId);
    const to = nodeData.get(link.toNodeId);
    const fromKey = getCraftResolvedEndpointId(from);
    const toKey = getCraftResolvedEndpointId(to);
    if (!fromKey || !toKey || fromKey === toKey) continue;
    if (!graph.has(fromKey)) graph.set(fromKey, new Set());
    if (!graph.has(toKey)) graph.set(toKey, new Set());
    graph.get(fromKey).add(toKey);
    graph.get(toKey).add(fromKey);
  }

  const distance = new Map();
  if (rootKey) {
    const queue = [rootKey];
    distance.set(rootKey, 0);
    for (let index = 0; index < queue.length; index += 1) {
      const key = queue[index];
      const nextDistance = distance.get(key) + 1;
      for (const next of graph.get(key) ?? []) {
        if (distance.has(next)) continue;
        distance.set(next, nextDistance);
        queue.push(next);
      }
    }
  }

  const flowById = new Map();
  for (const link of links) {
    const fallback = getCraftLinkFlow(link, nodeData, mode);
    const fromKey = getCraftResolvedEndpointId(nodeData.get(link.fromNodeId));
    const toKey = getCraftResolvedEndpointId(nodeData.get(link.toNodeId));
    const fromDistance = distance.get(fromKey);
    const toDistance = distance.get(toKey);
    if (!Number.isFinite(fromDistance) || !Number.isFinite(toDistance) || fromDistance === toDistance) {
      flowById.set(link.id, fallback);
      continue;
    }
    const forward = mode === CRAFT_MODE_DISASSEMBLY
      ? fromDistance < toDistance
      : fromDistance > toDistance;
    flowById.set(link.id, forward
      ? { fromNodeId: link.fromNodeId, toNodeId: link.toNodeId, reversed: false }
      : { fromNodeId: link.toNodeId, toNodeId: link.fromNodeId, reversed: true });
  }
  return flowById;
}

function getCraftEndpointElement(workspace, nodes, nodeId) {
  const node = nodes.find(entry => entry.id === nodeId);
  const blockId = String(node?.blockId ?? "");
  return (blockId ? workspace?.querySelector(`[data-craft-block-id="${CSS.escape(blockId)}"]`) : null)
    ?? workspace?.querySelector(`[data-craft-node-id="${CSS.escape(nodeId)}"]`)
    ?? null;
}

function appendCraftLinkPath(svg, geometry, link, { result = null, recipeUuid = "", linkKey = "", linkIndex = null, flowFromKey = "", flowToKey = "" } = {}) {
  if (!geometry?.centerPath) return;
  const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
  group.classList.add("fallout-maw-craft-link", "readonly");
  if (isCraftLinkFailureResult(link)) group.classList.add("failure-result");
  group.dataset.craftLinkId = link.id;
  if (linkKey) group.dataset.craftLinkKey = linkKey;
  if (linkIndex !== null && linkIndex !== undefined) group.dataset.craftLinkIndex = String(linkIndex);
  if (flowFromKey) group.dataset.craftFlowFrom = flowFromKey;
  if (flowToKey) group.dataset.craftFlowTo = flowToKey;
  group.dataset.craftRecipeUuid = recipeUuid;
  if (result) {
    group.dataset.craftFlowResult = result.success ? "success" : "failure";
    group.dataset.craftFlowBreak = String(getCraftFailureBreakFraction(recipeUuid, linkKey || link.id));
  }
  const tooltipData = getCraftLinkTooltipData(link);
  if (tooltipData) {
    group.dataset.craftLinkTooltip = "true";
    group.dataset.craftLinkSkillLabel = tooltipData.skillLabel;
    group.dataset.craftLinkDifficulty = String(tooltipData.difficulty);
    group.setAttribute("aria-label", auditFormat("FALLOUTMAW.AuditApps.Difficulty_387", { v0: (tooltipData.skillLabel), v1: (tooltipData.difficulty) }, "{v0}: Сложность {v1}"));
  }
  const hitPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  hitPath.classList.add("fallout-maw-craft-link-hit");
  hitPath.setAttribute("d", geometry.centerPath);
  group.appendChild(hitPath);
  for (const [className, pathData] of [
    ["fallout-maw-craft-link-shadow", geometry.centerPath],
    ["fallout-maw-craft-link-wall", geometry.centerPath],
    ["fallout-maw-craft-link-glass", geometry.centerPath],
    ["fallout-maw-craft-link-highlight", geometry.centerPath],
    ["fallout-maw-craft-link-fluid fallout-maw-craft-link-fluid-gold", geometry.centerPath]
  ]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    for (const token of className.split(" ")) path.classList.add(token);
    path.setAttribute("d", pathData);
    group.appendChild(path);
  }
  for (const [socketIndex, point] of [geometry.start, geometry.end].entries()) {
    if (!point?.socketPath) continue;
    const socket = document.createElementNS("http://www.w3.org/2000/svg", "path");
    socket.classList.add("fallout-maw-craft-link-socket");
    socket.setAttribute("d", point.socketPath);
    group.appendChild(socket);
    const fluidSocket = document.createElementNS("http://www.w3.org/2000/svg", "path");
    fluidSocket.classList.add("fallout-maw-craft-link-fluid-socket", socketIndex === 0 ? "start" : "end");
    fluidSocket.setAttribute("d", point.socketPath);
    group.appendChild(fluidSocket);
  }
  svg.appendChild(group);
}

function getCraftConnectorGeometry(fromElement, toElement, svg, bend = null, anchors = null) {
  const from = getElementRectRelativeToSvg(fromElement, svg);
  const to = getElementRectRelativeToSvg(toElement, svg);
  if (!from || !to) return null;
  return buildCraftConnectorGeometry(from, to, bend, anchors);
}

function getElementRectRelativeToSvg(element, svg) {
  if (!element || !svg) return null;
  const rect = element.getBoundingClientRect();
  const svgRect = svg.getBoundingClientRect();
  const zoom = getCraftSvgZoom(svg);
  return {
    left: (rect.left - svgRect.left) / zoom,
    right: (rect.right - svgRect.left) / zoom,
    top: (rect.top - svgRect.top) / zoom,
    bottom: (rect.bottom - svgRect.top) / zoom,
    width: rect.width / zoom,
    height: rect.height / zoom
  };
}

function getCraftSvgZoom(svg) {
  const workspace = svg?.closest?.("[data-craft-workspace]");
  const styles = getComputedStyle(workspace ?? svg);
  const zoom = Number.parseFloat(styles.getPropertyValue("--craft-zoom"));
  const uiScale = Number.parseFloat(styles.getPropertyValue("--fallout-maw-ui-scale"));
  const totalScale = (Number.isFinite(zoom) && zoom > 0 ? zoom : 1)
    * (Number.isFinite(uiScale) && uiScale > 0 ? uiScale : 1);
  return totalScale > 0 ? totalScale : 1;
}

function buildCraftConnectorGeometry(from, to, bend = null, anchors = null) {
  const fromCenter = getRectCenter(from);
  const toCenter = getRectCenter(to);
  let startAnchor;
  let endAnchor;
  let path;
  if (bend) {
    startAnchor = getCraftResolvedAnchor(from, anchors?.from, bend);
    endAnchor = getCraftResolvedAnchor(to, anchors?.to, bend);
    path = buildBentTubeCenterPath(startAnchor, bend, endAnchor);
  } else {
    startAnchor = getCraftResolvedAnchor(from, anchors?.from, toCenter);
    endAnchor = getCraftResolvedAnchor(to, anchors?.to, fromCenter);
    path = buildDefaultTubeCenterPath(startAnchor, endAnchor);
  }
  return {
    centerPath: path,
    start: {
      ...startAnchor.tubePoint,
      socketPath: buildCraftSocketPath(startAnchor)
    },
    end: {
      ...endAnchor.tubePoint,
      socketPath: buildCraftSocketPath(endAnchor)
    }
  };
}

function buildDefaultTubeCenterPath(startAnchor, endAnchor) {
  const start = startAnchor.tubePoint;
  const end = endAnchor.tubePoint;
  const distance = Math.max(1, getPointDistance(start, end));
  const direction = normalizeVector({ x: end.x - start.x, y: end.y - start.y });
  const baseHandle = Math.min(120, distance * 0.34);
  const startHandle = baseHandle * Math.max(0, dotVector(startAnchor.normal, direction));
  const endHandle = baseHandle * Math.max(0, dotVector(endAnchor.normal, { x: -direction.x, y: -direction.y }));
  const c1 = addScaledVector(start, startAnchor.normal, startHandle);
  const c2 = addScaledVector(end, endAnchor.normal, endHandle);
  return `M ${formatPoint(start)} C ${formatPoint(c1)} ${formatPoint(c2)} ${formatPoint(end)}`;
}

function buildBentTubeCenterPath(startAnchor, bend, endAnchor) {
  const start = startAnchor.tubePoint;
  const end = endAnchor.tubePoint;
  if (isPointNearSegment(bend, start, end, 10)) return buildDefaultTubeCenterPath(startAnchor, endAnchor);
  const startDistance = getPointDistance(start, bend);
  const endDistance = getPointDistance(end, bend);
  const startDirection = normalizeVector({ x: bend.x - start.x, y: bend.y - start.y });
  const endDirection = normalizeVector({ x: end.x - bend.x, y: end.y - bend.y });
  const startHandle = Math.min(100, startDistance * 0.34) * Math.max(0, dotVector(startAnchor.normal, startDirection));
  const endHandle = Math.min(100, endDistance * 0.34) * Math.max(0, dotVector(endAnchor.normal, { x: -endDirection.x, y: -endDirection.y }));
  const bendTangent = getBendTangent(start, bend, end);
  const bendHandleA = Math.min(90, startDistance * 0.28);
  const bendHandleB = Math.min(90, endDistance * 0.28);
  const c1 = addScaledVector(start, startAnchor.normal, startHandle);
  const c2 = addScaledVector(bend, bendTangent, -bendHandleA);
  const c3 = addScaledVector(bend, bendTangent, bendHandleB);
  const c4 = addScaledVector(end, endAnchor.normal, endHandle);
  return `M ${formatPoint(start)} C ${formatPoint(c1)} ${formatPoint(c2)} ${formatPoint(bend)} C ${formatPoint(c3)} ${formatPoint(c4)} ${formatPoint(end)}`;
}

function getRectCenter(rect) {
  return {
    x: (rect.left + rect.right) / 2,
    y: (rect.top + rect.bottom) / 2
  };
}

function getCraftResolvedAnchor(rect, anchor, fallbackToward) {
  return anchor?.side ? getRectAnchorFromData(rect, anchor) : getRectAnchor(rect, fallbackToward);
}

function getRectAnchor(rect, toward) {
  const center = getRectCenter(rect);
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  if (!dx && !dy) {
    const normal = { x: 0, y: 1 };
    return {
      side: "bottom",
      offset: 0.5,
      point: center,
      tubePoint: addScaledVector(center, normal, CRAFT_SOCKET_DEPTH_PX),
      normal,
      tangent: { x: 1, y: 0 }
    };
  }
  const halfWidth = Math.max(1, rect.width / 2);
  const halfHeight = Math.max(1, rect.height / 2);
  const socketHalfWidth = CRAFT_SOCKET_HALF_WIDTH_PX;
  let point;
  let normal;
  let side;
  let offset;
  if (Math.abs(dx / halfWidth) > Math.abs(dy / halfHeight)) {
    const sign = Math.sign(dx) || 1;
    const scale = halfWidth / Math.abs(dx);
    point = {
      x: center.x + (sign * halfWidth),
      y: clampNumber(center.y + (dy * scale), rect.top + socketHalfWidth, rect.bottom - socketHalfWidth)
    };
    side = sign < 0 ? "left" : "right";
    offset = (point.y - rect.top) / Math.max(1, rect.height);
    normal = { x: sign, y: 0 };
  } else {
    const sign = Math.sign(dy) || 1;
    const scale = halfHeight / Math.abs(dy);
    point = {
      x: clampNumber(center.x + (dx * scale), rect.left + socketHalfWidth, rect.right - socketHalfWidth),
      y: center.y + (sign * halfHeight)
    };
    side = sign < 0 ? "top" : "bottom";
    offset = (point.x - rect.left) / Math.max(1, rect.width);
    normal = { x: 0, y: sign };
  }
  return {
    side,
    offset: clampNumber(offset, 0, 1),
    point,
    tubePoint: addScaledVector(point, normal, CRAFT_SOCKET_DEPTH_PX),
    normal,
    tangent: { x: -normal.y, y: normal.x }
  };
}

function getRectAnchorFromData(rect, anchor) {
  const side = normalizeCraftAnchorSide(anchor?.side) || "bottom";
  const rawOffset = Number(anchor?.offset);
  const offset = Number.isFinite(rawOffset) ? clampNumber(rawOffset, 0, 1) : 0.5;
  const socketHalfWidth = CRAFT_SOCKET_HALF_WIDTH_PX;
  let point;
  let normal;
  if (side === "left" || side === "right") {
    const sign = side === "left" ? -1 : 1;
    point = {
      x: sign < 0 ? rect.left : rect.right,
      y: clampNumber(rect.top + (rect.height * offset), rect.top + socketHalfWidth, rect.bottom - socketHalfWidth)
    };
    normal = { x: sign, y: 0 };
  } else {
    const sign = side === "top" ? -1 : 1;
    point = {
      x: clampNumber(rect.left + (rect.width * offset), rect.left + socketHalfWidth, rect.right - socketHalfWidth),
      y: sign < 0 ? rect.top : rect.bottom
    };
    normal = { x: 0, y: sign };
  }
  return {
    side,
    offset,
    point,
    tubePoint: addScaledVector(point, normal, CRAFT_SOCKET_DEPTH_PX),
    normal,
    tangent: { x: -normal.y, y: normal.x }
  };
}

function getRawCraftLinkBend(link) {
  const x = toOptionalNumber(link.bendX);
  const y = toOptionalNumber(link.bendY);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function getCraftLinkBend(link, svg = null) {
  const bend = getRawCraftLinkBend(link);
  if (!bend) return null;
  if (!svg) return bend;
  if (isLegacyCraftBend(link)) return null;
  return craftStoredBendToSvgPoint(svg, bend);
}

function isLegacyCraftBend(link) {
  const bend = getRawCraftLinkBend(link);
  if (!bend) return false;
  return Math.max(Math.abs(bend.x), Math.abs(bend.y)) > CRAFT_LEGACY_BEND_PIXEL_THRESHOLD;
}

function craftStoredBendToSvgPoint(svg, bend) {
  const center = getCraftSvgLocalCenter(svg);
  const metrics = getCraftGridMetrics(svg?.closest?.("[data-craft-workspace]"));
  return {
    x: center.x + (bend.x * metrics.step),
    y: center.y + (bend.y * metrics.step)
  };
}

function getCraftSvgLocalCenter(svg) {
  const rect = svg?.getBoundingClientRect?.();
  const zoom = getCraftSvgZoom(svg);
  const width = rect?.width ? rect.width / zoom : 0;
  const height = rect?.height ? rect.height / zoom : 0;
  return {
    x: width / 2,
    y: height / 2
  };
}

function getCraftLinkAnchor(link, role) {
  const offset = toOptionalNumber(link?.[`${role}AnchorOffset`]);
  return {
    side: normalizeCraftAnchorSide(link?.[`${role}AnchorSide`]),
    offset: Number.isFinite(offset) ? clampNumber(offset, 0, 1) : null
  };
}

function getCraftLinkAnchors(link) {
  return {
    from: getCraftLinkAnchor(link, "from"),
    to: getCraftLinkAnchor(link, "to")
  };
}

function normalizeCraftAnchorSide(side) {
  const value = String(side ?? "");
  return ["left", "right", "top", "bottom"].includes(value) ? value : "";
}

function buildCraftSocketPath(anchor) {
  const halfWidth = CRAFT_SOCKET_HALF_WIDTH_PX;
  const inset = 0.5;
  const outer = addScaledVector(anchor.point, anchor.normal, CRAFT_SOCKET_DEPTH_PX);
  const inner = addScaledVector(anchor.point, anchor.normal, inset);
  const corners = [
    addScaledVector(inner, anchor.tangent, -halfWidth),
    addScaledVector(inner, anchor.tangent, halfWidth),
    addScaledVector(outer, anchor.tangent, halfWidth),
    addScaledVector(outer, anchor.tangent, -halfWidth)
  ];
  return `M ${formatPoint(corners[0])} L ${formatPoint(corners[1])} L ${formatPoint(corners[2])} L ${formatPoint(corners[3])} Z`;
}

function getBendTangent(start, bend, end) {
  const incoming = normalizeVector({ x: bend.x - start.x, y: bend.y - start.y });
  const outgoing = normalizeVector({ x: end.x - bend.x, y: end.y - bend.y });
  const tangent = normalizeVector({ x: incoming.x + outgoing.x, y: incoming.y + outgoing.y });
  if (tangent.x || tangent.y) return tangent;
  return normalizeVector({ x: end.x - start.x, y: end.y - start.y });
}

function normalizeVector(vector) {
  const length = Math.hypot(vector.x, vector.y);
  if (length < 0.0001) return { x: 0, y: 0 };
  return { x: vector.x / length, y: vector.y / length };
}

function dotVector(a, b) {
  return (a.x * b.x) + (a.y * b.y);
}

function getPointDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function isPointNearSegment(point, start, end, threshold) {
  return getPointToSegmentDistance(point, start, end) <= threshold;
}

function getPointToSegmentDistance(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = (dx * dx) + (dy * dy);
  if (lengthSquared < 0.0001) return getPointDistance(point, start);
  const t = clampNumber(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, 0, 1);
  const projection = {
    x: start.x + (dx * t),
    y: start.y + (dy * t)
  };
  return getPointDistance(point, projection);
}

function addScaledVector(point, vector, scale) {
  return {
    x: point.x + (vector.x * scale),
    y: point.y + (vector.y * scale)
  };
}

function clampNumber(value, min, max) {
  if (min > max) return (min + max) / 2;
  return Math.max(min, Math.min(max, value));
}

function formatPoint(point) {
  return `${roundPathNumber(point.x)} ${roundPathNumber(point.y)}`;
}

function roundPathNumber(value) {
  return Number(value).toFixed(2).replace(/\.?0+$/, "");
}

function toOptionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function animateCraftLinks(element, operation) {
  const resultByLink = createCraftLinkResultMap(operation?.linkResults ?? []);
  const groups = Array.from(element?.querySelectorAll("[data-craft-link-id]") ?? [])
    .filter(group => (
      resultByLink.has(`id:${group.dataset.craftLinkId ?? ""}`)
      || resultByLink.has(`key:${group.dataset.craftLinkKey ?? ""}`)
      || resultByLink.has(`index:${group.dataset.craftLinkIndex ?? ""}`)
    ));
  if (!groups.length) {
    await delay(CRAFT_FLOW_DURATION_MS);
    return;
  }
  const routes = getCraftFlowAnimationRoutes(groups);
  await Promise.all(routes.map(route => animateCraftLinkRoute(route)));
}

async function animateCraftCompletionNodes(element, operation = {}) {
  const workspace = element?.querySelector("[data-craft-workspace]");
  if (!workspace) return;
  const mode = normalizeCraftMode(operation.mode);
  const outputNodeIds = new Set(Array.from(operation.outputNodeIds ?? []).map(id => String(id ?? "")).filter(Boolean));
  const nodes = mode === CRAFT_MODE_DISASSEMBLY && outputNodeIds.size
    ? Array.from(outputNodeIds)
      .map(nodeId => workspace.querySelector(`[data-craft-node-id="${CSS.escape(nodeId)}"]`))
      .filter(Boolean)
    : Array.from(workspace.querySelectorAll(mode === CRAFT_MODE_DISASSEMBLY
      ? ".fallout-maw-craft-node:not(.root)"
      : ".fallout-maw-craft-node.root"));
  if (!nodes.length) return;
  const className = operation.success ? "craft-pulse-success" : "craft-pulse-failure";
  await Promise.all(nodes.map(node => runCraftCompletionNodePulse(node, className)));
}

async function runCraftCompletionNodePulse(node, className = "craft-pulse-success") {
  if (!node?.classList) return;
  const image = node.querySelector(".fallout-maw-craft-node-image") ?? node;
  node.classList.remove(className);
  void node.offsetWidth;
  node.classList.add(className);
  await waitForAnimationFrame();
  if (typeof image.getAnimations === "function") {
    const animations = image.getAnimations()
      .filter(animation => String(animation.animationName ?? "").startsWith("fallout-maw-craft-pulse"));
    if (animations.length) await Promise.allSettled(animations.map(animation => animation.finished));
  } else {
    await new Promise(resolve => {
      const onEnd = event => {
        if (event.target !== image) return;
        image.removeEventListener("animationend", onEnd);
        resolve();
      };
      image.addEventListener("animationend", onEnd, { once: true });
    });
  }
  node.classList.remove(className);
}

async function animateCraftLinkRoute(route = []) {
  if (!route.length) return;
  const duration = Math.max(1, CRAFT_FLOW_DURATION_MS / route.length);
  let inheritedFailure = false;
  for (const group of route) {
    await animateCraftLinkGroup(group, { duration, inheritedFailure });
    inheritedFailure = inheritedFailure || isCraftFlowGroupFailure(group);
  }
}

function getCraftFlowAnimationRoutes(groups = []) {
  const entries = groups.map((group, index) => ({
    group,
    index,
    from: String(group.dataset.craftFlowFrom ?? ""),
    to: String(group.dataset.craftFlowTo ?? "")
  }));
  if (entries.some(entry => !entry.from || !entry.to)) {
    return entries.map(entry => [entry.group]);
  }

  const incoming = new Map();
  const outgoing = new Map();
  for (const entry of entries) {
    if (!incoming.has(entry.to)) incoming.set(entry.to, []);
    if (!outgoing.has(entry.from)) outgoing.set(entry.from, []);
    incoming.get(entry.to).push(entry);
    outgoing.get(entry.from).push(entry);
  }

  const visited = new Set();
  const routes = [];
  const starts = entries
    .filter(entry => (incoming.get(entry.from)?.length ?? 0) !== 1)
    .sort((left, right) => left.index - right.index);

  const buildRoute = start => {
    const route = [];
    let entry = start;
    while (entry && !visited.has(entry)) {
      route.push(entry.group);
      visited.add(entry);
      const nextEntries = outgoing.get(entry.to) ?? [];
      if ((incoming.get(entry.to)?.length ?? 0) !== 1 || nextEntries.length !== 1) break;
      entry = nextEntries[0];
    }
    return route;
  };

  for (const start of starts) {
    if (visited.has(start)) continue;
    const route = buildRoute(start);
    if (route.length) routes.push(route);
  }

  for (const entry of entries) {
    if (visited.has(entry)) continue;
    const route = buildRoute(entry);
    if (route.length) routes.push(route);
  }

  return routes.length ? routes : entries.map(entry => [entry.group]);
}

function createCraftLinkResultMap(results = []) {
  const map = new Map();
  for (const result of results) {
    const linkId = String(result?.linkId ?? "");
    const linkKey = String(result?.linkKey ?? result?.key ?? "");
    const linkIndex = String(result?.linkIndex ?? "");
    if (linkId) map.set(`id:${linkId}`, result);
    if (linkKey) map.set(`key:${linkKey}`, result);
    if (linkIndex) map.set(`index:${linkIndex}`, result);
  }
  return map;
}

function animateCraftLinkGroup(group, { duration = CRAFT_FLOW_DURATION_MS, inheritedFailure = false } = {}) {
  const gold = group.querySelector(".fallout-maw-craft-link-fluid-gold");
  const startSocket = group.querySelector(".fallout-maw-craft-link-fluid-socket.start");
  const endSocket = group.querySelector(".fallout-maw-craft-link-fluid-socket.end");
  duration = Math.max(1, Number(duration) || CRAFT_FLOW_DURATION_MS);
  if (!gold) return delay(duration);
  const total = Math.max(1, gold.getTotalLength?.() ?? 1);
  const success = !inheritedFailure && !isCraftFlowGroupFailure(group);
  const breakFraction = Math.max(0.3, Math.min(0.7, Number(group.dataset.craftFlowBreak) || 0.5));
  const initialTone = inheritedFailure ? 1 : 0;

  initializeCraftFlowPath(gold, total);
  setCraftFlowOpacity(gold, 1);
  setCraftFlowTone(gold, initialTone);
  setCraftFlowSocketOpacity(startSocket, 0);
  setCraftFlowSocketOpacity(endSocket, 0);
  setCraftFlowSocketTone(startSocket, initialTone);
  setCraftFlowSocketTone(endSocket, initialTone);

  return new Promise(resolve => {
    const startedAt = performance.now();
    const step = now => {
      const elapsed = Math.max(0, now - startedAt);
      const progress = Math.min(1, elapsed / duration);
      const goldPhases = getCraftFlowPhaseProgress(progress);
      const goldFilledLength = total * goldPhases.pipe;
      const redTone = inheritedFailure ? 1 : (success ? 0 : clampNumber((progress - breakFraction) / CRAFT_FLOW_FAILURE_BLEND_FRACTION, 0, 1));
      drawCraftFlowFill(gold, total, goldFilledLength);
      setCraftFlowTone(gold, redTone);
      setCraftFlowSocketOpacity(startSocket, goldPhases.startSocket);
      setCraftFlowSocketOpacity(endSocket, goldPhases.endSocket);
      setCraftFlowSocketTone(startSocket, redTone);
      setCraftFlowSocketTone(endSocket, redTone);
      if (progress < 1) {
        requestAnimationFrame(step);
      } else {
        const finalTone = success ? 0 : 1;
        drawCraftFlowFill(gold, total, total);
        setCraftFlowTone(gold, finalTone);
        setCraftFlowSocketOpacity(startSocket, 1);
        setCraftFlowSocketOpacity(endSocket, 1);
        setCraftFlowSocketTone(startSocket, finalTone);
        setCraftFlowSocketTone(endSocket, finalTone);
        resolve();
      }
    };
    requestAnimationFrame(step);
  });
}

function isCraftFlowGroupFailure(group) {
  return group?.dataset?.craftFlowResult === "failure";
}

function initializeCraftFlowPath(path, total) {
  path.classList.add("active");
  path.setAttribute("stroke-dasharray", `0 ${total}`);
  path.setAttribute("stroke-dashoffset", "0");
}

function drawCraftFlowFill(path, total, visibleLength, startLength = 0) {
  const start = Math.max(0, Math.min(total, startLength));
  const end = Math.max(start, Math.min(total, visibleLength));
  const visible = Math.max(0, end - start);
  path.setAttribute("stroke-dasharray", `${visible} ${total}`);
  path.setAttribute("stroke-dashoffset", String(-start));
}

function getCraftFlowPhaseProgress(progress) {
  const socketPhase = CRAFT_FLOW_SOCKET_PHASE_FRACTION;
  const pipePhase = Math.max(0.001, 1 - (socketPhase * 2));
  return {
    startSocket: clampNumber(progress / socketPhase, 0, 1),
    pipe: clampNumber((progress - socketPhase) / pipePhase, 0, 1),
    endSocket: clampNumber((progress - socketPhase - pipePhase) / socketPhase, 0, 1)
  };
}

function setCraftFlowOpacity(path, opacity) {
  path.style.opacity = String(clampNumber(opacity, 0, 1));
}

function setCraftFlowTone(path, tone) {
  const amount = clampNumber(tone, 0, 1);
  const color = mixCraftFlowColor(CRAFT_FLOW_GOLD, CRAFT_FLOW_RED, amount);
  path.style.stroke = `rgba(${color.r}, ${color.g}, ${color.b}, 0.96)`;
  path.style.filter = `drop-shadow(0 0 ${5 + amount}px rgba(${color.r}, ${color.g}, ${color.b}, ${0.65 + (amount * 0.01)}))`;
}

function setCraftFlowSocketOpacity(socket, opacity) {
  if (!socket) return;
  socket.style.opacity = String(clampNumber(opacity, 0, 1));
}

function setCraftFlowSocketTone(socket, tone) {
  if (!socket) return;
  const amount = clampNumber(tone, 0, 1);
  const fill = mixCraftFlowColor(CRAFT_FLOW_SOCKET_GOLD_FILL, CRAFT_FLOW_SOCKET_RED_FILL, amount);
  const stroke = mixCraftFlowColor(CRAFT_FLOW_SOCKET_GOLD_STROKE, CRAFT_FLOW_SOCKET_RED_STROKE, amount);
  socket.style.fill = formatCraftFlowColor(fill);
  socket.style.stroke = formatCraftFlowColor(stroke);
  socket.style.filter = `drop-shadow(0 0 ${6 + amount}px rgba(${fill.r}, ${fill.g}, ${fill.b}, ${0.56 + (amount * 0.06)}))`;
}

function mixCraftFlowColor(from, to, amount) {
  return {
    r: Math.round(from.r + ((to.r - from.r) * amount)),
    g: Math.round(from.g + ((to.g - from.g) * amount)),
    b: Math.round(from.b + ((to.b - from.b) * amount)),
    a: from.a === undefined || to.a === undefined ? undefined : from.a + ((to.a - from.a) * amount)
  };
}

function formatCraftFlowColor(color) {
  const alpha = Number.isFinite(color.a) ? color.a : 1;
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
}

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getCraftFailureBreakFraction(recipeUuid = "", linkId = "") {
  const source = `${recipeUuid}:${linkId}`;
  let hash = 0;
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) - hash) + source.charCodeAt(index);
    hash |= 0;
  }
  return 0.3 + ((Math.abs(hash) % 401) / 1000);
}

function isToolClassAccepted(actual, required) {
  return toToolClassRank(actual) >= toToolClassRank(required);
}

function toToolClassRank(value) {
  return TOOL_CLASS_RANK[String(value ?? "D")] ?? 0;
}

function normalizeToolClass(value) {
  const toolClass = String(value ?? "D");
  return Object.hasOwn(TOOL_CLASS_RANK, toolClass) ? toolClass : "D";
}

function prepareCraftRecipeCategories(recipes = [], { selectedRecipeUuid = "", search = "", expandedKeys = new Set(), mode = CRAFT_MODE_CREATE, actor = null } = {}) {
  mode = normalizeCraftMode(mode);
  const normalizedSearch = normalizeCraftSearchText(search);
  const matched = [];
  for (const recipe of recipes) {
    if (!hasCraftRecipeDataForMode(recipe.system?.craft, mode)) continue;
    const searchText = recipe.known === false
      ? normalizeCraftSearchText(`${recipe.category} ${recipe.itemClass}`)
      : recipe.searchText ?? normalizeCraftSearchText(getCraftRecipeDisplayName(recipe));
    if (normalizedSearch && !searchText.includes(normalizedSearch)) continue;
    matched.push(recipe);
  }

  const categories = createCraftRecipeGrouping({
    recipes: matched,
    itemCategories: getItemCategorySettings(),
    collator: new Intl.Collator(game.i18n.lang, { numeric: true, sensitivity: "base" })
  });

  // Every matched recipe is materialized. Only collapsed folders are skipped,
  // and they are reopened by the user, so nothing is ever silently dropped.
  const availability = actor ? getCraftAvailabilityIndex(actor) : null;
  const prepareRecipes = list => list.map(recipe => prepareCraftRecipeDisplay({
    ...recipe,
    unknown: recipe.known === false,
    missing: recipe.known !== false && (actor
      ? isCraftRecipeMissing(recipe, actor, mode, availability)
      : craftRecipeMissingCache.get(getCraftRecipeMissingCacheKey(mode, recipe.uuid)) ?? false),
    selected: recipe.uuid === selectedRecipeUuid
  })).sort(compareCraftRecipeAvailability);

  const prepared = categories.map(category => {
    const categoryKey = craftCategoryExpansionKey(category.key);
    let categoryCount = 0;
    const subcategories = category.subcategories.filter(subcategory => !normalizedSearch || subcategory.hasRecipes).map(subcategory => {
      const subcategoryKey = craftSubcategoryExpansionKey(category.key, subcategory.key);
      const classFolders = subcategory.classFolders.map(folder => {
        const folderKey = craftClassFolderExpansionKey(category.key, subcategory.key, folder.key);
        const isExpanded = expandedKeys.has(folderKey) || (normalizedSearch && folder.recipes.length > 0);
        return {
          key: folderKey,
          itemClass: folder.key,
          label: getCraftClassLabel(folder.key),
          count: folder.recipes.length,
          collapsed: !isExpanded,
          searching: Boolean(normalizedSearch),
          recipes: isExpanded ? prepareRecipes(folder.recipes) : []
        };
      });

      const classless = subcategory.classlessRecipes;
      const hasClassFolders = classFolders.length > 0;
      // Every level starts folded and is opened only by an explicit click, so a
      // single "expanded" set drives categories, subcategories and class folders.
      // A search reveals only the branches that actually matched.
      const subcategoryExpanded = expandedKeys.has(subcategoryKey)
        || !subcategory.rawSubcategory
        || (normalizedSearch && (classless.length > 0 || subcategory.classFolders.length > 0));

      // Classless recipes are listed directly under the subcategory, after its
      // class folders: everything without a class goes into lists after them.
      const recipeList = subcategoryExpanded && classless.length ? prepareRecipes(classless) : [];

      const count = classFolders.reduce((sum, folder) => sum + folder.count, 0) + classless.length;
      categoryCount += count;
      return {
        key: subcategoryKey,
        label: subcategory.rawSubcategory
          ? (subcategory.isUnconfigured
            ? game.i18n.format("FALLOUTMAW.Craft.SubcategoryOther", { name: subcategory.rawSubcategory })
            : subcategory.rawSubcategory)
          : game.i18n.localize("FALLOUTMAW.Craft.SubcategoryNone"),
        rawSubcategory: subcategory.rawSubcategory,
        transparent: !subcategory.rawSubcategory,
        unconfigured: subcategory.isUnconfigured,
        collapsed: !subcategoryExpanded,
        searching: Boolean(normalizedSearch),
        hasClassFolders,
        hasRecipes: subcategory.hasRecipes,
        classFolders,
        count,
        recipes: recipeList
      };
    });

    const categoryExpanded = category.isUncategorized || expandedKeys.has(categoryKey) || (normalizedSearch && categoryCount > 0);
    return {
      key: categoryKey,
      label: category.isUncategorized
        ? game.i18n.localize("FALLOUTMAW.Craft.CategoryNone")
        : category.rawCategory,
      uncategorized: category.isUncategorized,
      collapsed: !categoryExpanded,
      searching: Boolean(normalizedSearch),
      count: categoryCount,
      subcategories
    };
  });

  return { categories: prepared };
}

function buildCraftOpenOptionsForMode(recipes = [], mode = CRAFT_MODE_CREATE) {
  mode = normalizeCraftMode(mode);
  const modeRecipes = recipes.filter(recipe => hasCraftRecipeDataForMode(recipe.system?.craft, mode));
  const multiple = modeRecipes.length > 1;
  const icon = mode === CRAFT_MODE_DISASSEMBLY ? "fa-screwdriver-wrench" : "fa-hammer";
  const baseLabel = mode === CRAFT_MODE_DISASSEMBLY ? auditLocalize("FALLOUTMAW.AuditApps.OpenDismantling", "Открыть разбор") : auditLocalize("FALLOUTMAW.AuditApps.OpenCrafting", "Открыть крафт");
  return modeRecipes.map(recipe => ({
    action: `${mode}:${recipe.uuid}`,
    icon,
    label: multiple ? `${baseLabel}: ${getCraftRecipeDisplayName(recipe)}` : baseLabel,
    mode,
    recipeSelectionUuid: recipe.uuid
  }));
}

function craftItemMatchesRecipeSource(item = null, recipe = null, itemProfile = null, recipeProfile = null) {
  if (!item || !recipe?.itemUuid) return false;
  if (item.uuid === recipe.itemUuid) return true;

  recipeProfile ??= recipe.sourceProfile ?? getCraftItemSourceProfile(recipe.itemUuid);
  itemProfile ??= getCraftItemMatchProfile(item);
  const itemKeys = itemProfile.sourceKeys;
  const recipeKeys = recipeProfile.sourceKeys ?? new Set();
  return Boolean(recipeKeys.size && itemKeys.size && setsIntersect(recipeKeys, itemKeys));
}

function getCraftRecipeMissingCount(recipe, actor, mode = CRAFT_MODE_CREATE, availability = null) {
  if (!actor) return 0;
  mode = normalizeCraftMode(mode);
  const recipeId = recipe?.recipeId ?? DEFAULT_CRAFT_RECIPE_ID;
  const nodes = getCraftNodesWithRoot(recipe, mode, recipeId);
  const links = getCraftLinks(recipe, mode, recipeId, nodes);
  const index = availability ?? createCraftAvailabilityIndex(actor);
  const requirements = mode === CRAFT_MODE_DISASSEMBLY
    ? getCraftRequirements(getCraftMaterialRequirementNodes(nodes, links, mode), { includeRoot: true })
    : getCraftRequirements(getCraftMaterialRequirementNodes(nodes, links, mode, { actor, index }));
  const toolRequirements = getCraftToolRequirements(nodes, { actor, index });
  const ownedByRequirement = getActorOwnedCraftRequirementsFromIndex(index, requirements);
  const toolAvailability = createCraftToolRequirementAvailabilityPlan(index, toolRequirements);
  return requirements.filter(requirement => (ownedByRequirement.get(requirement.key) ?? 0) < requirement.quantity).length
    + toolRequirements.filter(requirement => (toolAvailability.ownedByRequirement.get(requirement.key) ?? 0) < requirement.quantity).length;
}

function getCraftRecipeCategory(recipe) {
  const grouping = getCraftRecipeGrouping(recipe);
  const parts = [grouping.category || game.i18n.localize("FALLOUTMAW.Craft.CategoryNone")];
  if (grouping.subcategory) parts.push(grouping.subcategory);
  if (grouping.itemClass) parts.push(getCraftClassLabel(grouping.itemClass));
  return parts.join(" / ");
}

function getCraftRecipeDisplayName(recipe) {
  const name = String(recipe?.name ?? "");
  const quantity = Math.max(1, toInteger(recipe?.system?.quantity) || 1);
  return quantity > 1 ? auditFormat("FALLOUTMAW.AuditApps.X_390", { v0: (name), v1: (quantity) }, "{v0} ({v1}х)") : name;
}

function normalizeCraftSearchText(value = "") {
  return String(value ?? "").trim().toLocaleLowerCase(game.i18n.lang);
}

async function getCraftRecipeSummaries(actor = null) {
  const knownUuids = getKnownCraftItemUuids(actor);
  if (craftRecipeCatalog && craftRecipeCatalog.actorUuid === (actor?.uuid ?? "")
    && craftRecipeCatalog.knownUuids === knownUuids) {
    return craftRecipeCatalog.recipes;
  }

  const recipes = [];
  const byUuid = new Map();
  const bySourceUuid = new Map();
  const byUsageUuid = new Map();
  const byOutputUuid = new Map();
  for (const itemUuid of new Set([...knownUuids, ...(globalThis.game?.items?.contents ?? []).map(item => item.uuid)])) {
    const item = resolveWorldItemSync(itemUuid);
    if (!isCraftRecipeItem(item)) continue;
    const itemRecipes = getCraftRecipeCatalogEntries(item);
    for (const recipe of itemRecipes) {
      if (!hasCraftRecipeData(recipe)) continue;
      const summary = prepareRecipeSummary(item, recipe);
      summary.known = knownUuids.has(item.uuid);
      recipes.push(summary);
      byUuid.set(summary.uuid, summary);
      for (const sourceKey of getCraftItemSourceProfile(item.uuid).sourceKeys) {
        addRecipeToCraftSourceIndexBucket(bySourceUuid, sourceKey, summary);
      }
      indexCraftRecipeReferences(byUsageUuid, summary, recipe.nodes);
      indexCraftRecipeReferences(byOutputUuid, summary, recipe.disassembly?.nodes);
    }
  }

  craftRecipeCatalog = {
    actorUuid: actor?.uuid ?? "",
    knownUuids,
    recipes,
    byUuid,
    bySourceUuid,
    byUsageUuid,
    byOutputUuid
  };
  return recipes;
}

function getCraftRecipeCatalogEntries(item = null) {
  const craft = item?.system?.craft ?? {};
  const legacy = {
    id: DEFAULT_CRAFT_RECIPE_ID,
    name: DEFAULT_CRAFT_RECIPE_NAME(),
    nodes: craft.nodes ?? [],
    links: craft.links ?? [],
    viewport: craft.viewport ?? {},
    disassembly: craft.disassembly ?? {}
  };
  const source = Array.isArray(craft.recipes) && craft.recipes.length ? craft.recipes : [legacy];
  const entries = source.map((entry, index) => {
    const fallback = index === 0 || entry?.id === DEFAULT_CRAFT_RECIPE_ID ? legacy : {};
    const usesLegacyLayout = hasCraftRecipeEntryData(fallback)
      && (!entry?.id || entry.id === DEFAULT_CRAFT_RECIPE_ID)
      && !hasCraftRecipeEntryData(entry);
    const merged = usesLegacyLayout
      ? { ...entry, nodes: fallback.nodes, links: fallback.links, viewport: fallback.viewport, disassembly: fallback.disassembly }
      : { ...fallback, ...entry };
    return {
      ...merged,
      id: String(merged.id ?? (index ? `recipe${index + 1}` : DEFAULT_CRAFT_RECIPE_ID)).trim() || DEFAULT_CRAFT_RECIPE_ID,
      name: String(merged.name ?? (index ? auditFormat("FALLOUTMAW.AuditApps.Recipe", { v0: (index + 1) }, "Рецепт_{v0}") : DEFAULT_CRAFT_RECIPE_NAME())).trim() || DEFAULT_CRAFT_RECIPE_NAME(),
      nodes: merged.nodes ?? [],
      links: merged.links ?? [],
      viewport: merged.viewport ?? {},
      disassembly: merged.disassembly ?? {}
    };
  });
  if (!entries.some(entry => entry.id === DEFAULT_CRAFT_RECIPE_ID) && hasCraftRecipeEntryData(legacy)) entries.unshift(legacy);
  return entries.filter(hasCraftRecipeData);
}

function indexCraftRecipeReferences(map, recipe, nodes = []) {
  for (const node of nodes ?? []) {
    if (node?.root) continue;
    addRecipeToCraftSourceIndexBucket(map, getCraftNodeSourceUuid(node), recipe);
  }
}

function isCraftRecipeItem(item) {
  return item?.type === "gear" && !item.parent && hasCraftRecipeData(item.system?.craft);
}

function hasCraftRecipeData(craft = {}) {
  if (Array.isArray(craft?.recipes) && craft.recipes.some(recipe => hasCraftRecipeData(recipe))) return true;
  return hasCraftRecipeDataForMode(craft, CRAFT_MODE_CREATE) || hasCraftRecipeDataForMode(craft, CRAFT_MODE_DISASSEMBLY);
}

function hasCraftRecipeDataForMode(craft = {}, mode = CRAFT_MODE_CREATE) {
  // The model initializes recipes to [], even on items which still keep their
  // default recipe in the legacy layout fields used by both recipe editors.
  if (Array.isArray(craft?.recipes) && craft.recipes.some(recipe => hasCraftRecipeDataForMode(recipe, mode))) return true;
  const recipe = normalizeCraftMode(mode) === CRAFT_MODE_DISASSEMBLY ? craft?.disassembly : craft;
  return hasCraftKnowledgeLayoutData(recipe);
}

function prepareRecipeSummary(item, recipe = createDefaultCraftRecipeEntry(item)) {
  const summary = {
    uuid: getCraftRecipeSelectionUuid(item.uuid, recipe.id),
    itemUuid: item.uuid,
    recipeId: recipe.id,
    recipeName: recipe.name,
    name: item.name,
    img: normalizeImagePath(item.img, FALLBACK_ICON),
    type: item.type,
    system: {
      quantity: Math.max(1, toInteger(item.system?.quantity) || 1),
      itemCategory: String(item.system?.itemCategory ?? ""),
      itemSubcategory: String(item.system?.itemSubcategory ?? ""),
      placement: item.system?.placement ?? {},
      craft: { ...recipe, disassemblyRequiresRecipe: Boolean(item.system?.craft?.disassemblyRequiresRecipe) }
    }
  };
  summary.itemClass = getCraftItemClass(item);
  summary.category = getCraftRecipeCategory(summary);
  summary.displayName = getCraftRecipeDisplayName(summary);
  summary.searchText = normalizeCraftSearchText(
    `${summary.displayName} ${summary.recipeName ?? ""} ${summary.category} ${summary.itemClass}`
  );
  return summary;
}

function getCraftRecipeSelectionUuid(itemUuid = "", recipeId = DEFAULT_CRAFT_RECIPE_ID) {
  return `${String(itemUuid ?? "")}${CRAFT_RECIPE_SELECTION_SEPARATOR}${String(recipeId ?? DEFAULT_CRAFT_RECIPE_ID)}`;
}

function parseCraftRecipeSelectionUuid(selectionUuid = "") {
  const text = String(selectionUuid ?? "");
  const index = text.lastIndexOf(CRAFT_RECIPE_SELECTION_SEPARATOR);
  if (index < 0) return { itemUuid: text, recipeId: DEFAULT_CRAFT_RECIPE_ID };
  return {
    itemUuid: text.slice(0, index),
    recipeId: text.slice(index + CRAFT_RECIPE_SELECTION_SEPARATOR.length) || DEFAULT_CRAFT_RECIPE_ID
  };
}

function resolveCraftRecipeSelection(selectionUuid = "") {
  const selection = parseCraftRecipeSelectionUuid(selectionUuid);
  const item = resolveWorldItemSync(selection.itemUuid);
  if (!item) return null;
  const recipeId = getCraftRecipeEntries(item).some(recipe => recipe.id === selection.recipeId)
    ? selection.recipeId
    : DEFAULT_CRAFT_RECIPE_ID;
  return { item, recipeId };
}

function getActorRace(actor) {
  const raceId = actor?.system?.creature?.raceId;
  return getCreatureOptions().races.find(entry => entry.id === raceId) ?? null;
}

function escapeAttribute(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getCraftInventoryGridItemElementAtPointer(event = null, root = null) {
  const clientX = Number(event?.clientX);
  const clientY = Number(event?.clientY);
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  const element = document.elementFromPoint(clientX, clientY);
  const itemElement = element?.closest?.("[data-inventory-grid-item][data-item-id]") ?? null;
  if (!itemElement || (root && !root.contains(itemElement))) return null;
  return itemElement;
}

function createEmptyActorContext() {
  // A token-backed Actor can disappear while this window is still open.
  // Keep the context renderable until an available Actor is selected again.
  return {
    uuid: "",
    name: "",
    img: FALLBACK_ICON,
    canInteract: false,
    inventory: createEmptyInventoryContext(),
    load: { value: 0, max: 0, percent: 0, trend: "normal", state: "normal" }
  };
}

function createEmptyInventoryContext() {
  return {
    equipmentSlots: [],
    weaponSets: [],
    containers: [],
    lockedStorage: {
      id: LOCKED_STORAGE_PARENT_ID,
      grid: {
        columns: 1,
        rows: 1,
        cells: [],
        items: []
      }
    },
    grid: {
      columns: 1,
      rows: 1,
      cells: [],
      items: []
    }
  };
}

function prepareCraftInventoryContext(inventory, actor) {
  const actorUuid = actor?.uuid ?? "";
  const mapItem = item => item ? {
    ...item,
    actorUuid,
    draggableClass: actor?.isOwner ? "draggable" : ""
  } : null;
  return {
    ...inventory,
    equipmentSlots: (inventory.equipmentSlots ?? []).map(slot => ({
      ...slot,
      item: mapItem(slot.item)
    })),
    prosthesisSlots: (inventory.prosthesisSlots ?? []).map(slot => ({
      ...slot,
      item: mapItem(slot.item)
    })),
    weaponSets: (inventory.weaponSets ?? []).map(set => ({
      ...set,
      slots: (set.slots ?? []).map(slot => ({
        ...slot,
        actorUuid,
        item: mapItem(slot.item)
      }))
    })),
    grid: {
      ...inventory.grid,
      items: (inventory.grid?.items ?? []).map(mapItem)
    },
    containers: (inventory.containers ?? []).map(container => ({
      ...mapItem(container),
      grid: {
        ...container.grid,
        items: (container.grid?.items ?? []).map(mapItem)
      }
    })),
    lockedStorage: inventory.lockedStorage
      ? {
        ...inventory.lockedStorage,
        grid: {
          ...inventory.lockedStorage.grid,
          items: (inventory.lockedStorage.grid?.items ?? []).map(mapItem)
        }
      }
      : null
  };
}

function getCraftInventoryDimensions(actor, parentId = ROOT_CONTAINER_ID) {
  if (parentId === LOCKED_STORAGE_PARENT_ID) {
    return getActorInventoryGridDimensions(actor, getActorRace(actor));
  }
  if (parentId) {
    const container = actor?.items?.get(parentId);
    if (container) return getContainerInventoryGridOptions(container);
  }
  return getActorInventoryGridDimensions(actor, getActorRace(actor));
}

function getDragEventData(event) {
  const cachedPayload = CONFIG.ux.DragDrop?.getPayload?.();
  if (cachedPayload && typeof cachedPayload === "object") return cachedPayload;
  for (const type of ["application/json", "text/plain"]) {
    const raw = event.dataTransfer?.getData(type);
    if (!raw) continue;
    try {
      return JSON.parse(raw);
    } catch (_error) {
      continue;
    }
  }
  return null;
}

function setWeaponSlotImageAspect(image) {
  const width = Number(image?.naturalWidth);
  const height = Number(image?.naturalHeight);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
  const slot = image.closest(".fallout-maw-weapon-slot");
  if (!slot) return;
  slot.style.setProperty("--fallout-maw-weapon-slot-image-aspect", String(Math.max(1, width / height)));
}

async function resolveActor(uuid) {
  const normalized = String(uuid ?? "").trim();
  if (!normalized) return null;
  try {
    const document = await globalThis.fromUuid?.(normalized);
    return document instanceof Actor ? document : null;
  } catch (_error) {
    return null;
  }
}

function waitForAnimationFrame() {
  return new Promise(resolve => requestAnimationFrame(resolve));
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function canUseOwnedDisassembly(actor, recipe) {
  if (!actor || !recipe || recipe.system?.craft?.disassemblyRequiresRecipe) return false;
  return (actor.items?.contents ?? []).some(item => getItemQuantity(item) > 0 && craftItemMatchesRecipeSource(item, { itemUuid: recipe.itemUuid ?? recipe.uuid }));
}
