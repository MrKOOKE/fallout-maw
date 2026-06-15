import { SYSTEM_ID, TEMPLATES } from "../constants.mjs";
import { getCreatureOptions, getSkillSettings, getToolSettings } from "../settings/accessors.mjs";
import { createDefaultInventorySize } from "../settings/creature-options.mjs";
import { requestSkillCheck } from "../rolls/skill-check.mjs";
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
  transferItemBetweenActors
} from "./search-inventory.mjs";
import {
  FALLBACK_ICON,
  getActorInventoryGridDimensions,
  getActorRootInventoryGridOptions,
  normalizeImagePath
} from "../utils/actor-display-data.mjs";
import { getInventoryTooltipCompareActor, renderInventoryItemTooltipHTML } from "../sheets/actor-sheet.mjs";
import { FalloutMaWContainerSheet } from "../sheets/container-sheet.mjs";
import { isNaturalRaceItem } from "../races/natural-items.mjs";
import {
  ROOT_CONTAINER_ID,
  INFINITE_ROOT_INVENTORY_EMPTY_ROWS,
  LOCKED_STORAGE_PARENT_ID,
  LOCKED_STORAGE_PLACEMENT_MODE,
  createStoredPlacement,
  findFirstAvailableResolvedInventoryPlacement,
  getContainerContentsWeight,
  getContainerDimensions,
  getContainerMaxLoad,
  getContextInventoryItems,
  getItemContainerParentId,
  getItemId,
  getItemMaxStack,
  getItemQuantity,
  getItemTotalWeight,
  isContainerItem,
  normalizeInventoryPlacement,
  placementContainsInventoryCell
} from "../utils/inventory-containers.mjs";
import {
  canShowInventoryRotateAction,
  createInventoryRotationUpdate,
  getInventoryRotationUnavailableLabel,
  resolveInventoryItemRotation
} from "../utils/inventory-rotation.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { getEnabledToolFunctions } from "../utils/item-functions.mjs";
import { isCompendiumUuid, resolveWorldItemSync } from "../utils/world-items.mjs";
import { canUseActiveItem, useActiveItem } from "../items/active-item-use.mjs";

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
const DEFAULT_CRAFT_RECIPE_NAME = "Рецепт_1";
const CRAFT_RECIPE_SELECTION_SEPARATOR = "::recipe:";
const TOOL_CLASS_RANK = Object.freeze({ D: 0, C: 1, B: 2, A: 3, S: 4 });

let craftWindow = null;
let craftRecipeCache = null;
let craftRecipeCacheTime = 0;

export function openCraftWindow({ actor } = {}) {
  if (!actor) return undefined;
  craftWindow ??= new CraftWindowApplication();
  craftWindow.setActor(actor);
  return craftWindow.render({ force: true });
}

class CraftWindowApplication extends HandlebarsApplicationMixin(ApplicationV2) {
  #actorUuid = "";
  #actor = null;
  #selectedRecipeUuid = "";
  #selectedRecipeId = DEFAULT_CRAFT_RECIPE_ID;
  #selectedRecipe = null;
  #craftMode = CRAFT_MODE_CREATE;
  #craftToolPickerNodeId = "";
  #craftToolSelections = new Map();
  #busy = false;
  #pendingOperation = null;
  #startedOperationId = "";
  #animatingOperationId = "";
  #pulse = null;
  #dragDrop = null;
  #draggedItemData = null;
  #draggedItemId = "";
  #craftPanDrag = null;
  #craftViewportOverride = null;
  #expandedRecipeCategories = new Set();
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
  #resizeObserver = null;
  #scrollPositions = new Map();
  #viewportResizeHandler = null;
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
      template: TEMPLATES.craftWindow
    }
  };

  get title() {
    return "Крафт";
  }

  setActor(actor) {
    const actorUuid = String(actor?.uuid ?? "");
    if (actorUuid !== this.#actorUuid && this.#actorUuid) {
      this.#selectedRecipe = null;
      this.#craftViewportOverride = null;
      this.#craftToolPickerNodeId = "";
      this.#pulse = null;
      this.#pendingOperation = null;
      this.#startedOperationId = "";
      this.#animatingOperationId = "";
    } else if (actorUuid === this.#actorUuid) {
      this.#selectedRecipe = null;
    }
    this.#actorUuid = actorUuid;
    this.#actor = actor ?? null;
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
    this.#actor = await resolveActor(this.#actorUuid);
    const recipes = await getCraftRecipeSummaries();
    const modeRecipes = recipes.filter(recipe => hasCraftRecipeDataForMode(recipe.system?.craft, this.#craftMode));
    if (this.#selectedRecipeUuid && !modeRecipes.some(recipe => recipe.uuid === this.#selectedRecipeUuid)) {
      this.#selectedRecipeUuid = "";
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
        pulse: this.#pulse?.recipeUuid === this.#selectedRecipeUuid && this.#pulse?.mode === this.#craftMode ? this.#pulse : null,
        recipeId: this.#selectedRecipeId,
        toolPickerNodeId: this.#craftToolPickerNodeId,
        toolSelections: this.#getCraftToolSelections(this.#selectedRecipeUuid, this.#craftMode)
      })
      : createEmptyCraftContext(this.#busy);
    if (selectedRecipe) this.#rememberDefaultCraftToolSelections(this.#selectedRecipeUuid, this.#craftMode, craft.toolRequirements);
    const selectedRecipeSummary = recipes.find(recipe => recipe.uuid === this.#selectedRecipeUuid) ?? null;

    return {
      ...context,
      actor: actorContext,
      recipeCategories: prepareCraftRecipeCategories(recipes, this.#actor, {
        expandedCategories: this.#expandedRecipeCategories,
        mode: this.#craftMode,
        search: this.#recipeSearch,
        selectedRecipeUuid: this.#selectedRecipeUuid
      }),
      recipeSearch: this.#recipeSearch,
      recipe: selectedRecipe ? {
        uuid: selectedRecipe.uuid,
        name: getCraftRecipeDisplayName(selectedRecipeSummary ?? selectedRecipe),
        img: normalizeImagePath(selectedRecipe.img, FALLBACK_ICON)
      } : null,
      inventory: actorContext.inventory,
      craftMode: this.#craftMode,
      craftModes: getCraftModeChoices(this.#craftMode),
      craft,
      load: actorContext.load
    };
  }

  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    this.#renderRefresh = foundry.utils.debounce(() => {
      if (!this.rendered) return;
      this.#captureScrollPositions();
      this.#clearInventoryTooltip({ force: true });
      void this.#renderPreservingWindowStack();
    }, 60);
    this.#hookIds = [
      ["updateActor", Hooks.on("updateActor", actor => this.#scheduleRefreshForActor(actor))],
      ["deleteActor", Hooks.on("deleteActor", actor => this.#scheduleRefreshForActor(actor))],
      ["createItem", Hooks.on("createItem", item => this.#scheduleRefreshForItem(item))],
      ["updateItem", Hooks.on("updateItem", item => this.#scheduleRefreshForItem(item))],
      ["deleteItem", Hooks.on("deleteItem", item => this.#scheduleRefreshForItem(item))]
    ];
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#hoverPreviewInputKey = "";
    this.#hoverPreviewKey = "";
    this.setPosition();
    this.#bindViewportResize();
    this._dragDrop.bind(this.element);
    this.#bindInventoryListeners();
    this.#activateWeaponSlotAspectSizing();
    this.#restoreScrollPositions();
    this.#activateControls();
    this.#activateCraftViewer();
    this.#startPendingOperation();
  }

  #renderPreservingWindowStack(options = {}) {
    return this.render({ ...options, force: !this.rendered });
  }

  async _onClose(options) {
    await super._onClose(options);
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
  }

  #unbindViewportResize() {
    if (!this.#viewportResizeHandler) return;
    const view = this.element?.ownerDocument?.defaultView ?? window;
    view.removeEventListener("resize", this.#viewportResizeHandler);
    this.#viewportResizeHandler = null;
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

  #activateControls() {
    const search = this.element?.querySelector("[data-craft-recipe-search]");
    search?.addEventListener("input", event => {
      this.#recipeSearch = String(event.currentTarget?.value ?? "");
      this.#filterRecipeList();
    });
    this.element?.querySelectorAll("[data-craft-recipe-category-toggle]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        const category = String(event.currentTarget?.dataset?.craftRecipeCategoryToggle ?? "");
        if (!category) return;
        if (this.#expandedRecipeCategories.has(category)) this.#expandedRecipeCategories.delete(category);
        else this.#expandedRecipeCategories.add(category);
        this.#captureScrollPositions();
        void this.#renderPreservingWindowStack();
      });
      button.addEventListener("keydown", event => {
        if (!["Enter", " "].includes(event.key)) return;
        event.preventDefault();
        event.currentTarget?.click();
      });
    });
    this.element?.querySelectorAll("[data-recipe-uuid]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        if (this.#busy) return;
        this.#captureScrollPositions();
        this.#selectedRecipeUuid = String(event.currentTarget?.dataset?.recipeUuid ?? "");
        this.#selectedRecipe = null;
        this.#craftViewportOverride = null;
        this.#craftToolPickerNodeId = "";
        this.#pulse = null;
        void this.#renderPreservingWindowStack();
      });
      button.addEventListener("keydown", event => {
        if (!["Enter", " "].includes(event.key)) return;
        event.preventDefault();
        button.click();
      });
    });
    this.element?.querySelectorAll("[data-craft-mode]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        if (this.#busy) return;
        const mode = normalizeCraftMode(event.currentTarget?.dataset?.craftMode);
        if (mode === this.#craftMode) return;
        this.#craftMode = mode;
        this.#selectedRecipe = null;
        this.#craftViewportOverride = null;
        this.#craftToolPickerNodeId = "";
        this.#pulse = null;
        this.#captureScrollPositions();
        void this.#renderPreservingWindowStack();
      });
    });
    this.element?.querySelector('[data-action="craft"]')?.addEventListener("click", event => this.#onCraft(event));
    this.#filterRecipeList();
  }

  #filterRecipeList() {
    const query = normalizeCraftSearchText(this.#recipeSearch);
    this.element?.querySelectorAll("[data-craft-recipe-category]").forEach(category => {
      const categoryText = normalizeCraftSearchText(category.dataset.craftRecipeCategory ?? "");
      let visibleCount = 0;
      category.querySelectorAll("[data-recipe-uuid]").forEach(recipe => {
        const recipeText = normalizeCraftSearchText(recipe.dataset.recipeSearchText ?? recipe.textContent ?? "");
        const visible = !query || recipeText.includes(query) || categoryText.includes(query);
        recipe.hidden = !visible;
        if (visible) visibleCount += 1;
      });
      category.classList.toggle("searching", Boolean(query));
      category.hidden = visibleCount < 1;
    });
  }

  #activateCraftViewer() {
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    const workspace = this.element?.querySelector("[data-craft-workspace]");
    if (!workspace) return;
    workspace.addEventListener("contextmenu", event => event.preventDefault());
    workspace.addEventListener("pointerdown", event => this.#onCraftWorkspacePointerDown(event));
    workspace.addEventListener("click", event => this.#onCraftWorkspaceClick(event));
    workspace.addEventListener("wheel", event => this.#onCraftWheel(event), { passive: false });
    workspace.querySelectorAll("[data-craft-tool-select]").forEach(button => {
      button.addEventListener("click", event => this.#onCraftToolSelect(event));
    });
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
      this.#clearInventoryTooltip({ force: true });
      this.#captureScrollPositions();
      void this.#renderPreservingWindowStack();
      return;
    }
    if (!this.#craftToolPickerNodeId) return;
    this.#craftToolPickerNodeId = "";
    this.#captureScrollPositions();
    void this.#renderPreservingWindowStack();
  }

  #onCraftToolSelect(event) {
    event.preventDefault();
    event.stopPropagation();
    const requirementKey = String(event.currentTarget?.dataset?.craftToolSelect ?? "");
    const instrumentId = String(event.currentTarget?.dataset?.instrumentId ?? "");
    if (!requirementKey || !instrumentId || !this.#selectedRecipeUuid) return;
    this.#craftToolSelections.set(getCraftToolSelectionStorageKey(this.#selectedRecipeUuid, this.#craftMode, requirementKey), instrumentId);
    this.#captureScrollPositions();
    void this.#renderPreservingWindowStack();
  }

  #bindInventoryListeners() {
    const root = this.element?.querySelector("[data-search-root]");
    if (!root || root.dataset.craftInventoryBound) return;
    root.dataset.craftInventoryBound = "true";
    root.addEventListener("pointerover", event => this.#onInventoryTooltipPointerOver(event));
    root.addEventListener("pointerout", event => this.#onInventoryTooltipPointerOut(event));
    root.addEventListener("mousedown", event => this.#onInventoryTooltipMiddleMouseDown(event));
    root.addEventListener("auxclick", event => this.#onInventoryTooltipAuxClick(event));
    root.addEventListener("contextmenu", event => this.#onInventoryContextMenu(event));
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
    this.#clearInventoryTooltip({ force: true });
    this.#clearInventoryDropPreview();
    const itemElement = event.currentTarget?.closest?.("[data-item-id][data-search-actor-uuid]");
    const itemId = String(itemElement?.dataset?.itemId ?? "");
    const item = this.#actor?.items?.get(itemId);
    if (!item || !this._canDragStart()) return;
    this.#draggedItemId = item.id;
    this.#draggedItemData = item.toObject();
    event.dataTransfer?.setData("text/plain", JSON.stringify({
      type: "Item",
      uuid: item.uuid,
      itemId: item.id,
      actorUuid: this.#actor.uuid,
      sourceActorUuid: this.#actor.uuid,
      falloutMawSearchInventory: true
    }));
    this.#highlightEquipmentSlotsForItem(item);
    event.currentTarget?.classList?.add("dragging");
  }

  _onDragOver(event) {
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
      const item = this.#actor?.items?.get(String(data.itemId ?? ""));
      if (!item) return null;
      const zone = this.#getInventoryDropZone(event);
      if (!zone) return null;
      this.#captureScrollPositions();
      const placementRequest = getDropZonePlacementRequest(zone);
      const parentId = (placementRequest.mode === "inventory" || placementRequest.mode === LOCKED_STORAGE_PLACEMENT_MODE)
        ? getDropZoneParentId(zone)
        : ROOT_CONTAINER_ID;
      const targetItem = this.#getTargetStackItem(zone, item, parentId);
      let quantity;
      if (canStackItems(item.toObject(), targetItem)) {
        quantity = await this.#getCraftStackQuantity(item, targetItem, event);
      } else {
        quantity = Math.max(1, getItemQuantity(item));
      }
      if (!quantity) return null;
      const pointerPlacement = (placementRequest.mode === "inventory" || placementRequest.mode === LOCKED_STORAGE_PLACEMENT_MODE)
        ? getSearchDropPlacementForPointer({
          actor: this.#actor,
          itemData: item.toObject(),
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
        targetX: pointerPlacement?.x ?? ((placementRequest.mode === "inventory" || placementRequest.mode === LOCKED_STORAGE_PLACEMENT_MODE) && zone?.dataset?.inventoryCell !== undefined ? toInteger(zone.dataset.x) : null),
        targetY: pointerPlacement?.y ?? ((placementRequest.mode === "inventory" || placementRequest.mode === LOCKED_STORAGE_PLACEMENT_MODE) && zone?.dataset?.inventoryCell !== undefined ? toInteger(zone.dataset.y) : null),
        targetItemId: targetItem?.id ?? "",
        quantity,
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
    return grid.querySelector(`[data-inventory-cell][data-x="${x}"][data-y="${y}"]`) ?? null;
  }

  #getTargetStackItem(target, sourceItem, parentId = ROOT_CONTAINER_ID) {
    const itemElement = target?.closest?.("[data-item-id][data-search-actor-uuid]");
    if (itemElement && itemElement.dataset.searchActorUuid === this.#actor?.uuid && itemElement.dataset.itemId !== sourceItem.id) {
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
    if (this.#draggedItemData) return this.#draggedItemData;
    const data = getDragEventData(event);
    if (data?.type !== "Item") return null;
    const item = this.#actor?.items?.get(String(data.itemId ?? ""));
    if (!item) return null;
    this.#draggedItemId = item.id;
    return item.toObject();
  }

  async #getCraftStackQuantity(sourceItem, targetItem, event) {
    const sourceQuantity = Math.max(1, getItemQuantity(sourceItem));
    const availableSpace = Math.max(0, getItemMaxStack(targetItem) - getItemQuantity(targetItem));
    const maxTransfer = Math.min(sourceQuantity, availableSpace);
    if (maxTransfer <= 0) return 0;
    if (event?.shiftKey || maxTransfer <= 1) return maxTransfer;
    return promptSearchItemStackQuantity({
      item: sourceItem,
      title: "Сложить предметы",
      actionLabel: "Сложить",
      max: maxTransfer,
      value: maxTransfer
    });
  }

  #setInventoryHoverPreview(zone = null, event = null) {
    if (!zone) {
      this.#clearInventoryHoverPreview();
      return;
    }

    const actor = zone.dataset.searchActorUuid === this.#actor?.uuid ? this.#actor : null;
    if (zone.dataset.equipmentSlot || (zone.dataset.weaponSet && zone.dataset.weaponSlot)) {
      const inputKey = `slot:${actor?.uuid ?? ""}:${zone.dataset.equipmentSlot ?? ""}:${zone.dataset.weaponSet ?? ""}:${zone.dataset.weaponSlot ?? ""}:${this.#actor?.uuid ?? ""}:${this.#draggedItemId}`;
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
    const inputKey = `inventory:${actor.uuid}:${parentId}:${zone.dataset.x ?? ""}:${zone.dataset.y ?? ""}:${this.#actor?.uuid ?? ""}:${this.#draggedItemId}`;
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
      zone
    });
    if (!placement) {
      this.#clearInventoryHoverPreviewClasses();
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
    const previewKey = `inventory:${actor.uuid}:${parentId ?? ROOT_CONTAINER_ID}:${placement.x}:${placement.y}:${placement.width}:${placement.height}`;
    if (this.#hoverPreviewKey === previewKey) return;
    this.#clearInventoryHoverPreviewClasses();
    this.#hoverPreviewKey = previewKey;
    const escapedUuid = CSS.escape(actor.uuid);
    const escapedParentId = CSS.escape(parentId ?? ROOT_CONTAINER_ID);
    for (let y = placement.y; y < placement.y + placement.height; y += 1) {
      for (let x = placement.x; x < placement.x + placement.width; x += 1) {
        this.element?.querySelector(
          `[data-inventory-cell][data-search-actor-uuid="${escapedUuid}"][data-inventory-parent-id="${escapedParentId}"][data-x="${x}"][data-y="${y}"]`
        )?.classList.add("drop-preview");
      }
    }
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
    for (let y = placement.y; y < placement.y + placement.height; y += 1) {
      for (let x = placement.x; x < placement.x + placement.width; x += 1) {
        this.element?.querySelector(
          `[data-inventory-cell][data-search-actor-uuid="${escapedUuid}"][data-inventory-parent-id="${escapedParentId}"][data-x="${x}"][data-y="${y}"]`
        )?.classList.add("drop-stack-preview");
      }
    }
  }

  #clearInventoryDropPreview() {
    this.#clearInventoryHoverPreview();
    this.element?.querySelectorAll(".drop-match-preview").forEach(element => element.classList.remove("drop-match-preview"));
  }

  #clearInventoryHoverPreview() {
    this.#hoverPreviewInputKey = "";
    this.#clearInventoryHoverPreviewClasses();
  }

  #clearInventoryHoverPreviewClasses() {
    this.#hoverPreviewKey = "";
    this.element?.querySelectorAll(".drop-preview, .drop-stack-preview").forEach(element => {
      element.classList.remove("drop-preview", "drop-stack-preview");
    });
  }

  #highlightEquipmentSlotsForItem(item) {
    const race = getActorRace(this.#actor);
    for (const slot of getRaceEquipmentSlotsForItem(race, item)) {
      this.element?.querySelector(`[data-equipment-slot="${CSS.escape(slot.key)}"]`)?.classList.add("drop-match-preview");
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

  #onInventoryContextMenu(event) {
    const itemElement = event.target?.closest?.("[data-item-id][data-search-actor-uuid]");
    if (!itemElement || !this.element?.contains(itemElement) || !this.#actor?.isOwner || this.#busy) return;
    const item = this.#actor.items.get(String(itemElement.dataset.itemId ?? ""));
    if (!item) return;
    event.preventDefault();
    event.stopPropagation();
    this.#showInventoryContextMenu(item, event);
  }

  #onInventoryTooltipPointerOver(event) {
    if (this.#tooltipPinned) return;
    const anchor = event.target?.closest?.("[data-tooltip-item][data-search-actor-uuid], [data-tooltip-uuid]");
    if (!anchor || !this.element?.contains(anchor)) return;
    this.#cancelInventoryTooltipClose();
    this.#tooltipCompareMode = Boolean(event.ctrlKey);
    if (this.#tooltipAnchorElement === anchor && this.#tooltipElement) return;
    this.#scheduleInventoryTooltip(anchor, { compareMode: event.ctrlKey });
  }

  #onInventoryTooltipPointerOut(event) {
    const anchor = event.target?.closest?.("[data-tooltip-item][data-search-actor-uuid], [data-tooltip-uuid]");
    if (!anchor || !this.element?.contains(anchor)) return;
    if (anchor.contains(event.relatedTarget) || this.#tooltipElement?.contains(event.relatedTarget)) return;
    const nextAnchor = event.relatedTarget?.closest?.("[data-tooltip-item][data-search-actor-uuid], [data-tooltip-uuid]");
    if (nextAnchor && this.element?.contains(nextAnchor)) return;
    if (!this.#tooltipPinned) this.#scheduleInventoryTooltipClose();
  }

  #onInventoryTooltipMiddleMouseDown(event) {
    if (event.button !== 1) return;
    if (!event.target?.closest?.("[data-tooltip-item], [data-tooltip-uuid], .fallout-maw-inventory-tooltip")) return;
    event.preventDefault();
  }

  #onInventoryTooltipAuxClick(event) {
    if (event.button !== 1) return;
    const anchor = event.target?.closest?.("[data-tooltip-item][data-search-actor-uuid], [data-tooltip-uuid]");
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
      this.#tooltipDocumentUuid = String(anchor.dataset.tooltipUuid ?? "");
      this.#tooltipItemId = String(anchor.dataset.tooltipItem ?? anchor.dataset.itemId ?? "");
      this.#tooltipWeaponTabIndex = 0;
      void this.#showInventoryTooltip(anchor, { refresh: true });
      return;
    }

    this.#clearInventoryTooltip();
    this.#tooltipCompareMode = Boolean(compareMode);
    this.#tooltipAnchorElement = anchor;
    this.#tooltipActorUuid = String(anchor.dataset.searchActorUuid ?? "");
    this.#tooltipDocumentUuid = String(anchor.dataset.tooltipUuid ?? "");
    this.#tooltipItemId = String(anchor.dataset.tooltipItem ?? anchor.dataset.itemId ?? "");
    this.#tooltipWeaponTabIndex = 0;
    this.#tooltipTimer = view.setTimeout(() => {
      this.#tooltipTimer = null;
      void this.#showInventoryTooltip(anchor);
    }, 420);
  }

  async #showInventoryTooltip(anchor = this.#tooltipAnchorElement, { pinned = false, refresh = false } = {}) {
    const tooltipData = await this.#resolveTooltipItem(anchor);
    if (!tooltipData?.item) return;
    const { actor, item } = tooltipData;

    const tooltipHTML = await renderInventoryItemTooltipHTML(item, actor, {
      activeWeaponIndex: this.#tooltipWeaponTabIndex,
      baseMode: false,
      compareActor: getInventoryTooltipCompareActor(),
      compareMode: this.#tooltipCompareMode
    });
    const documentUuid = String(item.uuid ?? "");
    if (refresh && (
      this.#tooltipDocumentUuid
        ? this.#tooltipDocumentUuid !== documentUuid
        : ((this.#tooltipActorUuid !== String(actor?.uuid ?? "")) || (this.#tooltipItemId !== item.id))
    )) return;

    if (refresh && this.#tooltipElement && !this.#tooltipPinned && !pinned) {
      this.#tooltipElement.innerHTML = tooltipHTML;
      this.#tooltipElement.classList.remove("pinned");
      this.#tooltipElement.style.pointerEvents = "none";
      this.#tooltipPinned = false;
      this.#tooltipAnchorElement = anchor;
      this.#tooltipActorUuid = String(actor?.uuid ?? "");
      this.#tooltipDocumentUuid = documentUuid;
      this.#tooltipItemId = item.id;
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
    tooltip.className = "fallout-maw-inventory-tooltip";
    tooltip.classList.toggle("pinned", Boolean(pinned));
    tooltip.style.setProperty("--fallout-maw-ui-scale", String(this.#uiScale));
    tooltip.style.pointerEvents = pinned ? "auto" : "none";
    tooltip.innerHTML = tooltipHTML;
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
      this.#tooltipPinned = true;
      tooltip.classList.add("pinned");
      tooltip.style.pointerEvents = "auto";
      this.#bindInventoryTooltipDocumentClose();
    });
    document.body.append(tooltip);
    this.#tooltipElement = tooltip;
    this.#tooltipPinned = Boolean(pinned);
    this.#tooltipAnchorElement = anchor;
    this.#tooltipActorUuid = String(actor?.uuid ?? "");
    this.#tooltipDocumentUuid = documentUuid;
    this.#tooltipItemId = item.id;
    if (pinned) this.#bindInventoryTooltipDocumentClose();
    this.#bindInventoryTooltipKeyMode();
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
    this.#tooltipElement.querySelectorAll("[data-tooltip-weapon-tab]").forEach(entry => {
      const active = toInteger(entry.dataset.tooltipWeaponTab) === index;
      entry.classList.toggle("active", active);
      entry.setAttribute("aria-selected", active ? "true" : "false");
    });
    this.#tooltipElement.querySelectorAll("[data-tooltip-weapon-panel]").forEach(panel => {
      panel.classList.toggle("active", toInteger(panel.dataset.tooltipWeaponPanel) === index);
    });
    this.#positionInventoryTooltip();
  }

  #positionInventoryTooltip() {
    if (!this.#tooltipElement || !this.#tooltipAnchorElement?.isConnected) return;
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

  #showInventoryContextMenu(item, event) {
    this.#clearInventoryTooltip({ force: true });
    document.querySelectorAll(".fallout-maw-inventory-context-menu").forEach(menu => menu.remove());

    const placementMode = String(item.system?.placement?.mode ?? "");
    const isSlottedEquipment = placementMode === "equipment";
    const isSlottedWeapon = placementMode === "weapon";
    const isSlottedItem = isSlottedEquipment || isSlottedWeapon;
    const isEquipped = Boolean(item.system?.equipped);
    const isContainer = isContainerItem(item);
    const menuOptions = [];

    if (game.user?.isGM) {
      menuOptions.push(["edit", "fa-pen-to-square", game.i18n.localize("FALLOUTMAW.Common.Edit")]);
    }
    if (isContainer) {
      menuOptions.push(["open", "fa-box-open", game.i18n.localize("FALLOUTMAW.Item.Open")]);
    }
    if (canUseActiveItem(item)) {
      menuOptions.push(["use", "fa-play", "Применить"]);
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
    if (getItemQuantity(item) > 1) {
      menuOptions.push(["split", "fa-code-branch", "Разделить"]);
    }
    if (game.user?.isGM && !isSlottedItem) {
      menuOptions.push(["copy", "fa-copy", game.i18n.localize("FALLOUTMAW.Common.Copy")]);
    }
    if (game.user?.isGM) {
      menuOptions.push(["delete", "fa-trash", game.i18n.localize("FALLOUTMAW.Common.Delete")]);
    }

    const menu = document.createElement("nav");
    menu.className = "fallout-maw-inventory-context-menu";
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
    menu.innerHTML = menuOptions
      .map(([action, icon, label, disabled = false, title = ""]) => `<button type="button" data-action="${action}"${disabled ? " disabled" : ""}${title ? ` title="${escapeAttribute(title)}"` : ""}><i class="fa-solid ${icon}"></i>${label}</button>`)
      .join("");
    document.body.append(menu);

    menu.addEventListener("click", async clickEvent => {
      const action = clickEvent.target.closest("button")?.dataset.action;
      if (!action) return;
      clickEvent.preventDefault();
      menu.remove();
      if (action === "edit" && game.user?.isGM) return item.sheet?.render(true);
      if (action === "open") return this.#openCraftContainerSheet(item);
      if (action === "use") return useActiveItem({ actor: this.#actor, item, application: this });
      if (action === "rotate") return this.#rotateCraftItem(item);
      if (action === "equip") return this.#equipCraftItem(item);
      if (action === "unequip") return this.#unequipCraftItem(item);
      if (action === "split") return this.#splitCraftItem(item);
      if (action === "copy" && game.user?.isGM) return copyActorInventoryItem(this.#actor, item, { allowLocked: true });
      if (action === "delete" && game.user?.isGM) return item.delete();
      return undefined;
    });
  }

  #openCraftContainerSheet(item) {
    if (!isContainerItem(item)) return null;
    const app = new FalloutMaWContainerSheet({ document: item });
    app.render({ force: true });
    app.bringToFront();
    return app;
  }

  #resolveCraftItemRotation(item) {
    const parentId = item.system?.placement?.mode === LOCKED_STORAGE_PLACEMENT_MODE
      ? LOCKED_STORAGE_PARENT_ID
      : getItemContainerParentId(item);
    const dimensions = parentId && parentId !== LOCKED_STORAGE_PARENT_ID
      ? getContainerDimensions(this.#actor.items.get(parentId))
      : getActorInventoryGridDimensions(this.#actor, getActorRace(this.#actor));
    const options = parentId === LOCKED_STORAGE_PARENT_ID
      ? {
        allowOverflowRows: true,
        extraRows: INFINITE_ROOT_INVENTORY_EMPTY_ROWS,
        placementMode: LOCKED_STORAGE_PLACEMENT_MODE,
        preferredPlacementModes: [LOCKED_STORAGE_PLACEMENT_MODE]
      }
      : getActorRootInventoryGridOptions(this.#actor, parentId);
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
    await this.#actor.updateEmbeddedDocuments("Item", [updateData]);
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

  async #splitCraftItem(item) {
    const quantity = getItemQuantity(item);
    if (quantity <= 1) return null;
    const amount = await promptSearchItemStackQuantity({
      item,
      title: "Разделить предмет",
      actionLabel: "Разделить",
      max: quantity - 1,
      value: Math.max(1, Math.floor(quantity / 2))
    });
    if (!amount) return null;
    try {
      return await splitActorInventoryItem(this.#actor, item, amount, { allowLocked: true });
    } catch (error) {
      console.error(`${SYSTEM_ID} | Craft inventory split failed`, error);
      ui.notifications.warn(error.message || "Не удалось разделить предмет.");
    }
    return null;
  }

  #scheduleRefreshForActor(actor) {
    if (!actor || actor.uuid !== this.#actorUuid) return;
    this.#renderRefresh?.();
  }

  #scheduleRefreshForItem(item) {
    if (!item) return;
    if (item.parent?.uuid === this.#actorUuid) {
      if (!this.#busy) this.#renderRefresh?.();
      return;
    }
    if (!item.parent) {
      craftRecipeCache = null;
      if (!this.#busy) this.#renderRefresh?.();
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
    const validation = await validateCraftRequest(actor, recipe, this.#craftMode, this.#getCraftToolSelections(this.#selectedRecipeUuid, this.#craftMode), this.#selectedRecipeId);
    if (!validation.valid) {
      ui.notifications.warn(validation.message);
      return undefined;
    }
    this.#storeCraftToolSelections(this.#selectedRecipeUuid, this.#craftMode, validation.toolSelections);

    this.#busy = true;
    this.#pulse = null;
    this.#captureScrollPositions();
    await this.#renderPreservingWindowStack();

    const linkResults = [];
    for (const link of validation.links) {
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
      const outcome = await requestSkillCheck({
        actor,
        skillKey: link.skillKey,
        data: { difficulty: link.difficulty },
        animate: false,
        createMessage: true,
        requester: this.#craftMode === CRAFT_MODE_DISASSEMBLY ? "Разбор" : "Крафт"
      });
      if (!outcome) {
        this.#busy = false;
        this.#captureScrollPositions();
        await this.#renderPreservingWindowStack();
        ui.notifications.warn("Проверка крафта не выполнена.");
        return undefined;
      }
      linkResults.push({
        linkId: link.id,
        linkKey: link.key,
        linkIndex: link.index,
        success: outcome.result?.key === "success" || outcome.result?.key === "criticalSuccess",
        resultKey: String(outcome.result?.key ?? "failure")
      });
    }

    const operationId = foundry.utils.randomID();
    this.#pendingOperation = {
      id: operationId,
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
      outputPlan: validation.outputPlan,
      linkResults
    };
    this.#captureScrollPositions();
    await this.#renderPreservingWindowStack();
    return undefined;
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
        this.#pulse = {
          recipeUuid: operation.recipeSelectionUuid ?? operation.recipeUuid,
          mode: normalizeCraftMode(operation.mode),
          success: operation.success
        };
      } catch (error) {
        console.error(`${SYSTEM_ID} | Craft operation failed`, error);
        ui.notifications.warn(error.message || "Крафт не завершен.");
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
    this.element?.querySelectorAll("[data-craft-block-id]").forEach(block => {
      applyCraftElementLayout(block, {
        x: Number(block.dataset.craftX) || 0,
        y: Number(block.dataset.craftY) || 0,
        width: Number(block.dataset.craftWidth) || 1,
        height: Number(block.dataset.craftHeight) || 1
      });
    });
    this.element?.querySelectorAll("[data-craft-block-frame-id]").forEach(block => {
      applyCraftElementLayout(block, {
        x: Number(block.dataset.craftX) || 0,
        y: Number(block.dataset.craftY) || 0,
        width: Number(block.dataset.craftWidth) || 1,
        height: Number(block.dataset.craftHeight) || 1
      });
    });
    this.element?.querySelectorAll("[data-craft-node-id]").forEach(node => {
      applyCraftElementLayout(node, {
        x: Number(node.dataset.craftX) || 0,
        y: Number(node.dataset.craftY) || 0,
        width: Number(node.dataset.craftWidth) || 1,
        height: Number(node.dataset.craftHeight) || 1
      });
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
    if (this.#selectedRecipe && workspace) return getCraftFitViewport(this.#selectedRecipe, this.#craftMode, workspace, this.#selectedRecipeId);
    return this.#selectedRecipe ? getCraftViewport(this.#selectedRecipe, this.#craftMode, this.#selectedRecipeId) : normalizeCraftViewport();
  }

  #setCraftViewportStyle(x, y, zoom = this.#getCraftViewport().zoom) {
    const workspace = this.element?.querySelector("[data-craft-workspace]");
    const world = this.element?.querySelector("[data-craft-world]");
    const viewport = this.#clampCraftViewport(normalizeCraftViewport({ x, y, zoom }));
    this.#craftViewportOverride = viewport;
    workspace?.style.setProperty("--craft-pan-x", `${viewport.x}px`);
    workspace?.style.setProperty("--craft-pan-y", `${viewport.y}px`);
    workspace?.style.setProperty("--craft-zoom", String(viewport.zoom));
    workspace?.style.setProperty("--fallout-maw-craft-scaled-step", `${Math.round(getCraftGridMetrics(workspace).step * viewport.zoom)}px`);
    world?.style.setProperty("--craft-pan-x", `${viewport.x}px`);
    world?.style.setProperty("--craft-pan-y", `${viewport.y}px`);
    world?.style.setProperty("--craft-zoom", String(viewport.zoom));
    this.#scheduleCraftLinkRender();
    return viewport;
  }

  #clampCraftViewport(viewport) {
    const workspace = this.element?.querySelector("[data-craft-workspace]");
    return clampCraftViewportToVisibleNode(viewport, workspace, this.#selectedRecipe ? getCraftNodesWithRoot(this.#selectedRecipe, this.#craftMode, this.#selectedRecipeId) : []);
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
    svg.replaceChildren();

    const recipe = this.#selectedRecipe;
    if (!recipe) return;
    const mode = operation?.mode ?? this.#craftMode;
    const craft = getCraftRenderData(recipe, this.#actor, mode, { recipeId: this.#selectedRecipeId });
    const nodeData = new Map(craft.nodes.map(node => [node.id, node]));
    const resultByLink = createCraftLinkResultMap(operation?.linkResults ?? []);
    const flowByLink = getCraftLinkFlowMap(craft.links, craft.nodes, mode);

    for (const [linkIndex, link] of craft.links.entries()) {
      const fromNode = nodeData.get(link.fromNodeId);
      const toNode = nodeData.get(link.toNodeId);
      if (!fromNode || !toNode || getCraftResolvedEndpointId(fromNode) === getCraftResolvedEndpointId(toNode)) continue;
      const linkKey = getCraftResolvedLinkKey(link, craft.nodes);
      const flow = flowByLink.get(link.id) ?? getCraftLinkFlow(link, nodeData, mode);
      const from = getCraftEndpointElement(workspace, craft.nodes, flow.fromNodeId);
      const to = getCraftEndpointElement(workspace, craft.nodes, flow.toNodeId);
      if (!from || !to) continue;
      const flowFromKey = getCraftResolvedEndpointId(nodeData.get(flow.fromNodeId));
      const flowToKey = getCraftResolvedEndpointId(nodeData.get(flow.toNodeId));
      const anchors = flow.reversed
        ? { from: getCraftLinkAnchor(link, "to"), to: getCraftLinkAnchor(link, "from") }
        : getCraftLinkAnchors(link);
      const geometry = getCraftConnectorGeometry(from, to, svg, getCraftLinkBend(link, svg), anchors);
      appendCraftLinkPath(svg, geometry, link, {
        result: resultByLink.get(`id:${link.id}`)
          ?? resultByLink.get(`key:${linkKey}`)
          ?? resultByLink.get(`index:${linkIndex}`),
        recipeUuid: this.#selectedRecipeUuid || recipe.uuid,
        linkKey,
        linkIndex,
        flowFromKey,
        flowToKey
      });
    }
  }
}

async function validateCraftRequest(actor, recipe, mode = CRAFT_MODE_CREATE, toolSelections = {}, recipeId = DEFAULT_CRAFT_RECIPE_ID) {
  mode = normalizeCraftMode(mode);
  if (!actor?.isOwner) return { valid: false, message: "Нет прав на крафт этим актером." };
  if (!recipe) return { valid: false, message: "Рецепт не выбран." };
  const craft = getCraftRenderData(recipe, actor, mode, { toolSelections, recipeId });
  if (!craft.links.length) return { valid: false, message: "В рецепте нет связей для проверок." };
  if (!craft.requirements.length && !craft.toolRequirements.length) {
    return {
      valid: false,
      message: mode === CRAFT_MODE_DISASSEMBLY ? "В рецепте нет предмета для разбора." : "В рецепте нет компонентов или инструментов."
    };
  }
  if (craft.requirements.some(requirement => !requirement.sourceUuid && !requirement.fingerprint)) {
    return {
      valid: false,
      message: mode === CRAFT_MODE_DISASSEMBLY ? "В рецепте есть предмет разбора без исходного документа." : "В рецепте есть компонент без исходного документа."
    };
  }
  if (mode === CRAFT_MODE_DISASSEMBLY && !craft.outputs.length) {
    return { valid: false, message: "В рецепте нет результатов разбора." };
  }
  if (mode === CRAFT_MODE_DISASSEMBLY && craft.outputs.some(output => !output.sourceUuid)) {
    return { valid: false, message: "В рецепте есть результат разбора без исходного документа." };
  }
  if (craft.requirements.some(requirement => requirement.owned < requirement.quantity)) {
    return {
      valid: false,
      message: mode === CRAFT_MODE_DISASSEMBLY ? "Нет предмета для разбора." : "Недостаточно компонентов для крафта."
    };
  }
  const toolRequirements = craft.toolRequirements.map(requirement => ({
    key: requirement.key,
    toolKey: requirement.toolKey,
    toolClass: requirement.toolClass,
    quantity: requirement.quantity
  }));
  const toolSpendPlan = createCraftToolRequirementSpendPlan(actor, toolRequirements, toolSelections);
  if (!toolSpendPlan.valid) return { valid: false, message: toolSpendPlan.message };
  const resolvedToolSelections = Object.fromEntries(Array.from(toolSpendPlan.selectedByRequirement.entries()).map(([key, instrument]) => [key, instrument.id]));
  const requirements = craft.requirements.map(requirement => ({
    key: requirement.key,
    sourceUuid: requirement.sourceUuid,
    sourceKeys: requirement.sourceKeys,
    identity: requirement.identity,
    fingerprint: requirement.fingerprint,
    quantity: requirement.quantity
  }));
  const outputs = craft.outputs.map(output => ({
    sourceUuid: output.sourceUuid,
    quantity: output.quantity
  }));
  const spendPlan = createCraftRequirementSpendPlan(actor, requirements);
  const outputPlan = await createCraftOutputPlan(actor, recipe, mode, outputs, spendPlan, recipeId);
  if (!outputPlan.valid) return outputPlan;

  return {
    valid: true,
    requirements,
    toolRequirements,
    toolSelections: resolvedToolSelections,
    outputs,
    outputPlan,
    links: craft.links.map((link, index) => ({
      id: link.id,
      key: getCraftResolvedLinkKey(link, craft.nodes),
      index,
      noCheck: isCraftLinkNoCheck(link),
      skillKey: String(link.skillKey ?? "repair") || "repair",
      difficulty: normalizeCraftLinkDifficulty(link.difficulty)
    }))
  };
}

async function applyCraftOperation(operation) {
  const actor = await resolveActor(operation.actorUuid);
  const recipe = resolveWorldItemSync(operation.recipeUuid);
  if (!actor?.isOwner) throw new Error("Нет прав на крафт этим актером.");
  if (!recipe) throw new Error("Рецепт не найден.");

  const spendPlan = createCraftRequirementSpendPlan(actor, operation.requirements);
  const toolSpendPlan = createCraftToolRequirementSpendPlan(actor, operation.toolRequirements, operation.toolSelections);
  if (!toolSpendPlan.valid) throw new Error(toolSpendPlan.message);
  const outputPlan = operation.success
    ? (operation.outputPlan ?? await createCraftOutputPlan(actor, recipe, operation.mode, operation.outputs, spendPlan, operation.recipeId))
    : { valid: true, updates: [], creates: [] };
  if (!outputPlan.valid) throw new Error(outputPlan.message);

  await spendCraftRequirements(actor, operation.requirements, spendPlan);
  await spendCraftToolRequirements(actor, toolSpendPlan);
  if (!operation.success) return;
  await applyCraftOutputPlan(actor, outputPlan);
}

async function spendCraftRequirements(actor, requirements = [], plan = null) {
  const spendPlan = plan ?? createCraftRequirementSpendPlan(actor, requirements);
  if (spendPlan.updates.length) await actor.updateEmbeddedDocuments("Item", spendPlan.updates);
  if (spendPlan.deletes.length) await actor.deleteEmbeddedDocuments("Item", spendPlan.deletes);
}

async function spendCraftToolRequirements(actor, plan = null) {
  if (plan?.updates?.length) await actor.updateEmbeddedDocuments("Item", plan.updates);
}

function createCraftRequirementSpendPlan(actor, requirements = []) {
  const updates = [];
  const deletes = [];

  for (const requirement of requirements) {
    let remaining = Math.max(0, toInteger(requirement.quantity));
    if (!remaining) continue;
    const candidates = actor.items.contents.filter(item => !isNaturalRaceItem(item) && craftItemMatchesRequirement(item, requirement));

    for (const item of candidates) {
      if (remaining <= 0) break;
      const quantity = getItemQuantity(item);
      if (quantity <= 0) continue;
      if (quantity <= remaining) {
        deletes.push(item.id);
        remaining -= quantity;
      } else {
        updates.push({ _id: item.id, "system.quantity": quantity - remaining });
        remaining = 0;
      }
    }

    if (remaining > 0) throw new Error("Компоненты закончились до завершения крафта.");
  }

  return { updates, deletes };
}

function createCraftToolRequirementSpendPlan(actor, requirements = [], selections = {}) {
  const updatesByItemId = new Map();
  const supplyByItemTool = new Map();
  const ownedByRequirement = new Map();
  const selectedByRequirement = new Map();
  const missingKeys = new Set();
  const unavailableSelectedKeys = new Set();
  const normalizedSelections = normalizeCraftToolSelections(selections);
  const orderedRequirements = [...requirements]
    .sort((left, right) => toToolClassRank(right.toolClass) - toToolClassRank(left.toolClass));

  for (const requirement of orderedRequirements) {
    const requiredQuantity = Math.max(0, toInteger(requirement.quantity));
    const toolKey = String(requirement.toolKey ?? "").trim();
    if (!requiredQuantity || !toolKey) {
      ownedByRequirement.set(requirement.key, 0);
      continue;
    }

    const candidates = getActorCraftToolCandidates(actor, requirement, supplyByItemTool);
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
      const update = updatesByItemId.get(selected.item.id) ?? { _id: selected.item.id };
      update[`system.functions.tools.${selected.toolKey}.supply.value`] = selected.supplyValue;
      updatesByItemId.set(selected.item.id, update);
    }

    if (remaining > 0) missingKeys.add(requirement.key);
  }

  return {
    valid: missingKeys.size === 0,
    message: unavailableSelectedKeys.size
      ? "Выбранный инструмент больше недоступен для крафта."
      : (missingKeys.size ? "Недостаточно зарядов подходящих инструментов для крафта." : ""),
    updates: Array.from(updatesByItemId.values()),
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
        const supplyKey = `${item.id}:${toolKey}`;
        const supplyValue = supplyByItemTool.has(supplyKey)
          ? supplyByItemTool.get(supplyKey)
          : Math.max(0, toInteger(tool.supply?.value));
        return {
          id: item.id,
          item,
          name: item.name ?? "",
          img: normalizeImagePath(item.img || FALLBACK_ICON),
          toolKey,
          supplyKey,
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

async function createCraftOutputPlan(actor, recipe, mode = CRAFT_MODE_CREATE, outputs = [], spendPlan = null, recipeId = DEFAULT_CRAFT_RECIPE_ID) {
  const outputSpecs = await getCraftOutputSpecs(recipe, mode, outputs, recipeId);
  if (!outputSpecs.length) return { valid: true, updates: [], creates: [] };
  const projectedItems = projectCraftInventoryState(actor, spendPlan ?? { updates: [], deletes: [] });
  return planCraftOutputPlacement(actor, outputSpecs, projectedItems);
}

async function getCraftOutputSpecs(recipe, mode = CRAFT_MODE_CREATE, outputs = [], recipeId = DEFAULT_CRAFT_RECIPE_ID) {
  if (normalizeCraftMode(mode) !== CRAFT_MODE_DISASSEMBLY) {
    return mergeCraftOutputSpecs([{
      data: createCraftOutputItemData(recipe, { mode }),
      quantity: getCraftRecipeOutputQuantity(recipe, recipeId)
    }]);
  }

  const specs = [];
  for (const output of outputs) {
    const source = resolveWorldItemSync(output.sourceUuid);
    if (!source) throw new Error("Результат разбора не найден.");
    specs.push({
      data: createCraftOutputItemData(source, { mode }),
      quantity: Math.max(1, toInteger(output.quantity) || 1)
    });
  }
  return mergeCraftOutputSpecs(specs);
}

function getCraftRecipeOutputQuantity(recipe, recipeId = DEFAULT_CRAFT_RECIPE_ID) {
  const root = getCraftNodesWithRoot(recipe, CRAFT_MODE_CREATE, recipeId).find(node => node.root);
  return Math.max(1, toInteger(root?.quantity) || toInteger(recipe?.system?.quantity) || 1);
}

function createCraftOutputItemData(source, { mode = CRAFT_MODE_CREATE } = {}) {
  const data = source.toObject();
  delete data._id;
  delete data.id;
  delete data.folder;
  foundry.utils.setProperty(data, "system.equipped", false);
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

function planCraftOutputPlacement(actor, outputSpecs = [], projectedItems = []) {
  const updates = [];
  const creates = [];
  const planningItems = projectedItems.map(item => foundry.utils.deepClone(item));

  for (const spec of outputSpecs) {
    const maxStack = getItemMaxStack(spec.data);
    let remainingQuantity = Math.max(1, toInteger(spec.quantity) || 1);

    for (const target of getCraftOutputStackTargets(actor, spec.data, planningItems)) {
      if (remainingQuantity <= 0) break;
      const availableSpace = Math.max(0, getItemMaxStack(target) - getItemQuantity(target));
      if (!availableSpace) continue;
      const stackQuantity = Math.min(remainingQuantity, availableSpace);
      if (!canCraftOutputIncreaseStack(target, stackQuantity, spec.data, planningItems)) continue;

      const nextQuantity = getItemQuantity(target) + stackQuantity;
      upsertCraftOutputUpdate(updates, target, { "system.quantity": nextQuantity });
      foundry.utils.setProperty(target, "system.quantity", nextQuantity);
      remainingQuantity -= stackQuantity;
    }

    while (remainingQuantity > 0) {
      const stackQuantity = Math.min(remainingQuantity, maxStack);
      const createData = foundry.utils.deepClone(spec.data);
      foundry.utils.setProperty(createData, "system.quantity", stackQuantity);
      const target = findCraftOutputTarget(actor, createData, planningItems);
      if (!target) {
        return {
          valid: false,
          message: "Даже после расхода компонентов не хватает места или грузоподъемности для результатов крафта."
        };
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

function getCraftOutputStackTargets(actor, itemData, planningItems = []) {
  const contextOrder = new Map(getCraftOutputContexts(actor, planningItems).map((context, index) => [context.parentId, index]));
  return planningItems.filter(item => (
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

function findCraftOutputTarget(actor, itemData, planningItems = []) {
  for (const context of getCraftOutputContexts(actor, planningItems)) {
    if (context.parentId && !canCraftContainerAcceptItem(context.parentId, itemData, planningItems)) continue;
    const placement = findFirstAvailableResolvedInventoryPlacement(
      getContextInventoryItems(context.parentId, planningItems),
      context.dimensions.columns,
      context.dimensions.rows,
      itemData,
      planningItems,
      [],
      [],
      getActorRootInventoryGridOptions(actor, context.parentId)
    );
    if (placement) return { parentId: context.parentId, placement };
  }
  return null;
}

function getCraftOutputContexts(actor, planningItems = []) {
  const race = getActorRace(actor);
  const inventorySize = getActorInventoryGridDimensions(actor, race);
  const contexts = [{
    parentId: ROOT_CONTAINER_ID,
    dimensions: {
      columns: Math.max(1, toInteger(inventorySize.columns)),
      rows: Math.max(1, toInteger(inventorySize.rows))
    }
  }];

  for (const item of planningItems) {
    if (!isContainerItem(item) || !item.system?.equipped) continue;
    const containerId = getItemId(item);
    if (!containerId) continue;
    contexts.push({
      parentId: containerId,
      dimensions: getContainerDimensions(item)
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
  if (outputPlan.updates?.length) await actor.updateEmbeddedDocuments("Item", outputPlan.updates);
  if (outputPlan.creates?.length) await actor.createEmbeddedDocuments("Item", outputPlan.creates);
}

function prepareCraftContext(recipe, actor, { busy = false, mode = CRAFT_MODE_CREATE, pulse = null, recipeId = DEFAULT_CRAFT_RECIPE_ID, toolPickerNodeId = "", toolSelections = {} } = {}) {
  mode = normalizeCraftMode(mode);
  const data = getCraftRenderData(recipe, actor, mode, { toolSelections, recipeId });
  const missingCount = data.requirements.filter(requirement => requirement.owned < requirement.quantity).length
    + data.toolRequirements.filter(requirement => requirement.owned < requirement.quantity).length;
  const checks = getCraftCheckSummaries(data.links);
  const hasRequiredComponents = missingCount === 0;
  const toolPickerNode = data.nodes.find(node => node.id === toolPickerNodeId && node.toolRequirements?.length) ?? null;
  return {
    mode,
    ...data,
    actionTitle: mode === CRAFT_MODE_DISASSEMBLY ? "Разобрать" : "Произвести крафт",
    actionIcon: mode === CRAFT_MODE_DISASSEMBLY ? "fa-screwdriver-wrench" : "fa-hammer",
    nodes: data.nodes.map(node => ({
      ...node,
      toolPickerOpen: toolPickerNode?.id === node.id,
      pulseClass: shouldPulseCraftNode(node, mode, pulse) ? (pulse.success ? "craft-pulse-success" : "craft-pulse-failure") : ""
    })),
    toolPicker: null,
    checks,
    canCraft: Boolean(actor?.isOwner && !busy && data.links.length && (data.requirements.length || data.toolRequirements.length) && hasRequiredComponents && (mode !== CRAFT_MODE_DISASSEMBLY || data.outputs.length)),
    summary: missingCount
      ? (mode === CRAFT_MODE_DISASSEMBLY ? "Нет предмета для разбора" : `Не хватает компонентов/инструментов: ${missingCount}`)
      : (mode === CRAFT_MODE_DISASSEMBLY ? `Результаты: ${data.outputs.length}` : `Компоненты: ${data.requirements.length}, инструменты: ${data.toolRequirements.length}`)
  };
}

function shouldPulseCraftNode(node, mode = CRAFT_MODE_CREATE, pulse = null) {
  if (!pulse) return false;
  return normalizeCraftMode(mode) === CRAFT_MODE_DISASSEMBLY ? !node.root : node.root;
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
    if (isCraftLinkNoCheck(link)) continue;
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
  const suffix = check.count > 1 ? ` (${check.count}х)` : "";
  return `${check.skillLabel}: Сложность ${check.difficulty}${suffix}`;
}

function getCraftRenderData(recipe, actor, mode = CRAFT_MODE_CREATE, { toolSelections = {}, recipeId = DEFAULT_CRAFT_RECIPE_ID } = {}) {
  mode = normalizeCraftMode(mode);
  const nodes = getCraftNodesWithRoot(recipe, mode, recipeId);
  const links = getCraftLinks(recipe, mode, recipeId);
  const requirements = mode === CRAFT_MODE_DISASSEMBLY
    ? getCraftRequirements(nodes.filter(node => node.root), { includeRoot: true })
    : getCraftRequirements(nodes);
  const toolRequirements = mode === CRAFT_MODE_CREATE ? getCraftToolRequirements(nodes) : [];
  const outputs = mode === CRAFT_MODE_DISASSEMBLY ? getCraftOutputs(nodes) : [];
  const requirementByNodeId = new Map(requirements.flatMap(requirement => requirement.nodeIds.map(nodeId => [nodeId, requirement])));
  const ownedByRequirement = getActorOwnedCraftRequirements(actor, requirements);
  const toolSpendPlan = createCraftToolRequirementSpendPlan(actor, toolRequirements, toolSelections);
  const toolRequirementByNodeId = new Map(toolRequirements.flatMap(requirement => requirement.nodeIds.map(nodeId => [nodeId, requirement])));
  const toolRequirementDisplayByKey = new Map(toolRequirements.map(requirement => {
    const selected = toolSpendPlan.selectedByRequirement.get(requirement.key) ?? null;
    return [requirement.key, {
      ...requirement,
      owned: toolSpendPlan.ownedByRequirement.get(requirement.key) ?? 0,
      selectedInstrument: selected ? prepareCraftToolCandidateForDisplay(selected, requirement, true) : null,
      candidates: getActorCraftToolCandidates(actor, requirement)
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

  return {
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
          ? `${quantity}х`
          : (toolRequirement ? `${toolOwned}/${quantity}` : (requirement ? `${owned}/${quantity}` : `${quantity}х`)),
        missing: Boolean((requirement && sourceMissing.has(requirement.key)) || missingToolNodeIds.has(node.id)),
        style: buildCraftNodeStyle(node)
      };
    }),
    links,
    requirements: requirements.map(requirement => ({
      key: requirement.key,
      sourceUuid: requirement.sourceUuid,
      sourceKeys: requirement.sourceKeys,
      identity: requirement.identity,
      fingerprint: requirement.fingerprint,
      quantity: requirement.quantity,
      owned: ownedByRequirement.get(requirement.key) ?? 0
    })),
    toolRequirements: toolRequirements.map(requirement => toolRequirementDisplayByKey.get(requirement.key) ?? requirement),
    outputs,
    viewport,
    viewportStyle: `--craft-pan-x: ${Math.round(viewport.x)}px; --craft-pan-y: ${Math.round(viewport.y)}px; --craft-zoom: ${viewport.zoom};`
  };
}

function getCraftRequirements(nodes = [], { includeRoot = false } = {}) {
  const requirements = [];
  for (const node of nodes) {
    if (node.root && !includeRoot) continue;
    if (isCraftNodeToolRequirement(node)) continue;
    const sourceUuid = getCraftNodeSourceUuid(node);
    const quantity = Math.max(1, toInteger(node.quantity) || 1);
    const sourceItem = resolveWorldItemSync(sourceUuid);
    const sourceKeys = getCraftItemSourceKeys(sourceItem, sourceUuid);
    const identity = getCraftItemIdentity(sourceItem ?? node);
    const fingerprint = getCraftItemFingerprint(sourceItem ?? node);
    const key = getCraftRequirementKey({ sourceKeys, identity, fingerprint, sourceUuid });
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
      identity,
      fingerprint,
      quantity,
      nodeIds: [node.id]
    });
  }
  return requirements;
}

function getCraftToolRequirements(nodes = []) {
  const requirements = [];
  const toolLabels = new Map(getToolSettings().map(tool => [tool.key, tool.label]));
  for (const node of nodes) {
    if (node.root || String(node.blockId ?? "").trim()) continue;
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
  return requirements;
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
  return Boolean(!node.root && !String(node.blockId ?? "").trim() && getCraftNodeToolRequirements(node).length);
}

function getCraftToolRequirementKey({ toolKey = "", toolClass = "D" } = {}) {
  return `tool:${toolKey}:${normalizeToolClass(toolClass)}`;
}

function getCraftOutputs(nodes = []) {
  return nodes
    .filter(node => !node.root)
    .map(node => ({
      sourceUuid: getCraftNodeSourceUuid(node),
      quantity: Math.max(1, toInteger(node.quantity) || 1)
    }));
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

function craftItemMatchesRequirement(item, requirement = {}) {
  if (getItemQuantity(item) <= 0) return false;

  const requirementKeys = new Set(Array.from(requirement.sourceKeys ?? []).map(key => String(key ?? "").trim()).filter(Boolean));
  const itemKeys = getCraftItemSourceKeys(item);
  const identity = String(requirement.identity ?? "");
  if (requirementKeys.size && itemKeys.size) {
    if (setsIntersect(requirementKeys, itemKeys)) return !identity || getCraftItemIdentity(item) === identity;
  }

  const fingerprint = String(requirement.fingerprint ?? "");
  if (identity && getCraftItemIdentity(item) === identity) return true;
  if (fingerprint && getCraftItemFingerprint(item) !== fingerprint) return false;

  return Boolean(fingerprint);
}

function getCraftRequirementKey({ sourceKeys = new Set(), identity = "", fingerprint = "", sourceUuid = "" } = {}) {
  const normalizedKeys = Array.from(sourceKeys).map(key => String(key ?? "").trim()).filter(Boolean).sort();
  return JSON.stringify({
    source: normalizedKeys.length ? normalizedKeys : [String(sourceUuid ?? "").trim()].filter(Boolean),
    identity: String(identity ?? ""),
    fingerprint: String(fingerprint ?? "")
  });
}

function getCraftItemSourceKeys(itemOrDocument = null, fallbackUuid = "") {
  const keys = new Set();
  collectCraftItemSourceKeys(keys, itemOrDocument, fallbackUuid);
  return keys;
}

function collectCraftItemSourceKeys(keys, itemOrDocument = null, fallbackUuid = "", depth = 0) {
  if (depth > 4) return;
  const document = typeof itemOrDocument === "string" ? resolveWorldItemSync(itemOrDocument) : itemOrDocument;
  for (const key of [
    fallbackUuid,
    document?.uuid,
    document?._stats?.duplicateSource,
    document?._source?._stats?.duplicateSource,
    foundry.utils.getProperty(document, "flags.core.sourceId"),
    foundry.utils.getProperty(document, "_source.flags.core.sourceId"),
    foundry.utils.getProperty(document, "flags.fallout-maw.sourceId"),
    foundry.utils.getProperty(document, "_source.flags.fallout-maw.sourceId")
  ]) {
    const normalized = String(key ?? "").trim();
    if (normalized && !isCompendiumUuid(normalized)) keys.add(normalized);
  }

  for (const key of Array.from(keys)) {
    if (key === fallbackUuid || key === document?.uuid) continue;
    const sourceDocument = resolveWorldItemSync(key);
    if (sourceDocument) collectCraftItemSourceKeys(keys, sourceDocument, "", depth + 1);
  }
}

function getCraftItemIdentity(itemOrNode = null) {
  const system = itemOrNode?.system ?? itemOrNode ?? {};
  const footprint = getCraftItemFootprint(itemOrNode);
  return JSON.stringify(normalizeStackComparableValue({
    type: itemOrNode?.type ?? system?.type ?? "",
    name: itemOrNode?.name ?? "",
    img: normalizeImagePath(itemOrNode?.img || FALLBACK_ICON),
    maxStack: getItemMaxStack(itemOrNode),
    width: footprint.width,
    height: footprint.height
  }));
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
      label: "Создание",
      selected: mode === CRAFT_MODE_CREATE
    },
    {
      key: CRAFT_MODE_DISASSEMBLY,
      label: "Разбор",
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
  return entries;
}

function createDefaultCraftRecipeEntry(itemOrCraft = {}) {
  const craft = itemOrCraft?.system?.craft ?? itemOrCraft ?? {};
  return normalizeCraftRecipeEntry({
    id: DEFAULT_CRAFT_RECIPE_ID,
    name: DEFAULT_CRAFT_RECIPE_NAME,
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
    name: String(entry?.name ?? (index === 0 ? DEFAULT_CRAFT_RECIPE_NAME : `Рецепт_${index + 1}`)).trim() || `Рецепт_${index + 1}`,
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
  return [root, ...nodes];
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
  if (!source) return node;
  const footprint = getCraftItemFootprint(source);
  return normalizeCraftNode({
    ...node,
    name: source.name ?? node.name,
    img: normalizeImagePath(source.img || node.img, FALLBACK_ICON),
    type: source.type ?? node.type,
    width: footprint.width,
    height: footprint.height
  });
}

function getCraftLinks(item, mode = CRAFT_MODE_CREATE, recipeId = DEFAULT_CRAFT_RECIPE_ID) {
  const nodes = getCraftNodesWithRoot(item, mode, recipeId);
  return normalizeCraftLinksForNodes(Array.from(getCraftRecipeData(item, mode, recipeId)?.links ?? []), nodes);
}

function getCraftViewport(item, mode = CRAFT_MODE_CREATE, recipeId = DEFAULT_CRAFT_RECIPE_ID) {
  return normalizeCraftViewport(getCraftRecipeData(item, mode, recipeId)?.viewport ?? {});
}

function getCraftFitViewport(item, mode = CRAFT_MODE_CREATE, workspace = null, recipeId = DEFAULT_CRAFT_RECIPE_ID) {
  const nodes = getCraftNodesWithRoot(item, mode, recipeId);
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
  return normalizeCraftNode({
    ...source,
    id: String(source.id || CRAFT_ROOT_NODE_ID),
    itemUuid: item?.uuid ?? "",
    name: item?.name ?? "",
    img: normalizeImagePath(item?.img || FALLBACK_ICON),
    type: item?.type ?? "",
    width,
    height,
    quantity: Math.max(1, toInteger(source.quantity) || toInteger(item?.system?.quantity) || 1),
    blockId: String(source.blockId ?? ""),
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
    root: Boolean(node.root)
  };
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
  const value = link?.noCheck;
  return value === true || value === "true" || value === 1 || value === "1" || value === "on";
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
    .map(([id, blockNodes]) => ({ id, nodeIds: blockNodes.map(node => node.id), ...getCraftNodesBounds(blockNodes) }))
    .filter(block => block.nodeIds.length > 1 && block.width > 0 && block.height > 0);
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

function applyCraftElementLayout(element, { x = 0, y = 0, width = 1, height = 1 } = {}) {
  const metrics = getCraftGridMetrics(element?.closest?.("[data-craft-workspace]"));
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
  const rect = workspace?.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0 || !nodes.length) return viewport;
  if (nodes.some(node => isCraftNodeVisibleInViewport(node, viewport, workspace))) return viewport;
  let nearestAdjustment = null;
  for (const node of nodes) {
    const nodeRect = getCraftNodeScreenRect(node, viewport, workspace);
    const dx = getCraftNodeContainmentDelta(nodeRect.left, nodeRect.right, rect.width);
    const dy = getCraftNodeContainmentDelta(nodeRect.top, nodeRect.bottom, rect.height);
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

function isCraftNodeVisibleInViewport(node, viewport, workspace) {
  const workspaceRect = workspace?.getBoundingClientRect();
  if (!workspaceRect || workspaceRect.width <= 0 || workspaceRect.height <= 0) return true;
  const nodeRect = getCraftNodeScreenRect(node, viewport, workspace);
  return nodeRect.left >= 0
    && nodeRect.right <= workspaceRect.width
    && nodeRect.top >= 0
    && nodeRect.bottom <= workspaceRect.height;
}

function getCraftNodeContainmentDelta(start, end, size) {
  const nodeSize = end - start;
  if (nodeSize > size) return (size / 2) - ((start + end) / 2);
  if (start < 0) return -start;
  if (end > size) return size - end;
  return 0;
}

function getCraftNodeScreenRect(node, viewport, workspace) {
  const metrics = getCraftGridMetrics(workspace);
  const width = Math.max(1, toInteger(node.width) || 1);
  const height = Math.max(1, toInteger(node.height) || 1);
  const widthPx = (width * metrics.cell) + ((width - 1) * metrics.gap);
  const heightPx = (height * metrics.cell) + ((height - 1) * metrics.gap);
  const centerX = (Number(node.x) || 0) * metrics.step;
  const centerY = (Number(node.y) || 0) * metrics.step;
  const workspaceRect = workspace.getBoundingClientRect();
  const zoom = clampCraftZoom(viewport.zoom);
  const screenCenterX = (workspaceRect.width / 2) + viewport.x + (centerX * zoom);
  const screenCenterY = (workspaceRect.height / 2) + viewport.y + (centerY * zoom);
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

function prepareCraftRecipeCategories(recipes = [], actor = null, { selectedRecipeUuid = "", search = "", expandedCategories = new Set(), mode = CRAFT_MODE_CREATE } = {}) {
  mode = normalizeCraftMode(mode);
  const normalizedSearch = normalizeCraftSearchText(search);
  const categories = new Map();
  for (const recipe of recipes) {
    if (!hasCraftRecipeDataForMode(recipe.system?.craft, mode)) continue;
    const category = getCraftRecipeCategory(recipe);
    const displayName = getCraftRecipeDisplayName(recipe);
    if (normalizedSearch && !normalizeCraftSearchText(`${displayName} ${category}`).includes(normalizedSearch)) continue;
    const missing = getCraftRecipeMissingCount(recipe, actor, mode) > 0;
    const entry = {
      ...recipe,
      displayName,
      missing,
      selected: recipe.uuid === selectedRecipeUuid
    };
    if (!categories.has(category)) {
      categories.set(category, {
        key: category,
        label: category,
        recipes: []
      });
    }
    categories.get(category).recipes.push(entry);
  }

  return Array.from(categories.values())
    .map(category => ({
      ...category,
      collapsed: !normalizedSearch && !expandedCategories.has(category.key),
      count: category.recipes.length,
      recipes: category.recipes.sort((left, right) => left.displayName.localeCompare(right.displayName, game.i18n.lang))
    }))
    .sort((left, right) => left.label.localeCompare(right.label, game.i18n.lang));
}

function getCraftRecipeMissingCount(recipe, actor, mode = CRAFT_MODE_CREATE) {
  if (!actor) return 0;
  const data = getCraftRenderData(recipe, actor, mode);
  return data.requirements.filter(requirement => requirement.owned < requirement.quantity).length
    + data.toolRequirements.filter(requirement => requirement.owned < requirement.quantity).length;
}

function getCraftRecipeCategory(recipe) {
  return String(recipe?.system?.itemCategory ?? "").trim() || "Без категории";
}

function getCraftRecipeDisplayName(recipe) {
  const name = String(recipe?.name ?? "");
  const quantity = Math.max(1, toInteger(recipe?.system?.quantity) || 1);
  return quantity > 1 ? `${name} (${quantity}х)` : name;
}

function normalizeCraftSearchText(value = "") {
  return String(value ?? "").trim().toLocaleLowerCase(game.i18n.lang);
}

async function getCraftRecipeSummaries() {
  const now = Date.now();
  if (craftRecipeCache && (now - craftRecipeCacheTime) < 5000) return craftRecipeCache;
  const recipes = [];
  const seen = new Set();

  for (const item of game.items?.contents ?? []) {
    if (!isCraftRecipeItem(item) || seen.has(item.uuid)) continue;
    seen.add(item.uuid);
    for (const recipe of getCraftRecipeEntries(item)) {
      if (!hasCraftRecipeData(recipe)) continue;
      recipes.push(prepareRecipeSummary(item, recipe));
    }
  }

  recipes.sort((left, right) => left.name.localeCompare(right.name));
  craftRecipeCache = recipes;
  craftRecipeCacheTime = now;
  return recipes;
}

function isCraftRecipeItem(item) {
  return item?.type === "gear" && !item.parent && hasCraftRecipeData(item.system?.craft);
}

function hasCraftRecipeData(craft = {}) {
  if (Array.isArray(craft?.recipes) && craft.recipes.some(recipe => hasCraftRecipeData(recipe))) return true;
  return hasCraftRecipeDataForMode(craft, CRAFT_MODE_CREATE) || hasCraftRecipeDataForMode(craft, CRAFT_MODE_DISASSEMBLY);
}

function hasCraftRecipeDataForMode(craft = {}, mode = CRAFT_MODE_CREATE) {
  if (Array.isArray(craft?.recipes)) {
    return craft.recipes.some(recipe => hasCraftRecipeDataForMode(recipe, mode));
  }
  const recipe = normalizeCraftMode(mode) === CRAFT_MODE_DISASSEMBLY ? craft?.disassembly : craft;
  return Boolean((recipe?.nodes ?? []).length || (recipe?.links ?? []).length);
}

function prepareRecipeSummary(item, recipe = createDefaultCraftRecipeEntry(item)) {
  return {
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
      placement: foundry.utils.deepClone(item.system?.placement ?? {}),
      craft: foundry.utils.deepClone(recipe)
    }
  };
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
    const race = getActorRace(actor);
    const inventorySize = race?.inventorySize ?? createDefaultInventorySize();
    return {
      columns: Math.max(1, toInteger(inventorySize.columns)),
      rows: Math.max(1, toInteger(inventorySize.rows))
    };
  }
  if (parentId) {
    const container = actor?.items?.get(parentId);
    if (container) return getContainerDimensions(container);
  }
  const race = getActorRace(actor);
  const inventorySize = race?.inventorySize ?? createDefaultInventorySize();
  return {
    columns: Math.max(1, toInteger(inventorySize.columns) || createDefaultInventorySize().columns),
    rows: Math.max(1, toInteger(inventorySize.rows) || createDefaultInventorySize().rows)
  };
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
