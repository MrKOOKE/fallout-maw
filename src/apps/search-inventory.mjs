import { SYSTEM_ID, TEMPLATES } from "../constants.mjs";
import { getCreatureOptions } from "../settings/accessors.mjs";
import { createDefaultInventorySize } from "../settings/creature-options.mjs";
import { getCurrencySettings } from "../settings/accessors.mjs";
import {
  FALLBACK_ICON,
  escapeHTML,
  formatWeight,
  normalizeImagePath,
  prepareInventoryContext
} from "../utils/actor-display-data.mjs";
import {
  ROOT_CONTAINER_ID,
  createInventoryPlacement,
  createStoredPlacement,
  findFirstAvailableInventoryPlacement,
  getAllContainedItems,
  getContainerContentsWeight,
  getContextInventoryItems,
  getContainerDimensions,
  getContainerMaxLoad,
  getItemActorLoadWeight,
  getItemContainerParentId,
  getItemFootprint,
  getItemMaxStack,
  getItemQuantity,
  getItemTotalWeight,
  isContainerItem,
  isInventoryPlacementAvailable,
  normalizeInventoryPlacement,
  placementContainsInventoryCell,
  validateInventoryTree
} from "../utils/inventory-containers.mjs";
import {
  canUseWeaponSlotForItem,
  getEquipmentSlotSelectionKey,
  getRaceEquipmentSlotsForItem,
  getRequiredWeaponSlotsForItem,
  getSelectedEquipmentSlotKeys,
  getWeaponSlotRequirement,
  getWeaponSlotRequirementSize,
  isContainerWeaponSetKey
} from "../utils/equipment-slots.mjs";
import { renderInventoryItemTooltipHTML } from "../sheets/actor-sheet.mjs";
import { toInteger } from "../utils/numbers.mjs";

const { ApplicationV2, DialogV2, HandlebarsApplicationMixin } = foundry.applications.api;

const SEARCH_INVENTORY_REFERENCE_WIDTH = 2560;
const SEARCH_INVENTORY_REFERENCE_HEIGHT = 1440;
const SEARCH_INVENTORY_FALLBACK_VIEWPORT_WIDTH = 1280;
const SEARCH_INVENTORY_FALLBACK_VIEWPORT_HEIGHT = 720;
const SEARCH_INVENTORY_SOCKET = `system.${SYSTEM_ID}`;
const SEARCH_INVENTORY_SOCKET_SCOPE = "fallout-maw.searchInventory";
const SEARCH_INVENTORY_SOCKET_TIMEOUT = 10000;

let searchInventoryWindow = null;
const pendingSearchInventorySocketRequests = new Map();

export function registerSearchInventorySocket() {
  game.socket.on(SEARCH_INVENTORY_SOCKET, handleSearchInventorySocketMessage);
}

export function openSearchInventoryWindow({ searcherActor, searchedActor } = {}) {
  if (!searcherActor || !searchedActor) return undefined;
  if (searcherActor.uuid === searchedActor.uuid) return undefined;

  searchInventoryWindow ??= new SearchInventoryApplication();
  searchInventoryWindow.setActors(searcherActor, searchedActor);
  return searchInventoryWindow.render({ force: true });
}

class SearchInventoryApplication extends HandlebarsApplicationMixin(ApplicationV2) {
  #searcherActorUuid = "";
  #searchedActorUuid = "";
  #searcherActor = null;
  #searchedActor = null;
  #draggedItemData = null;
  #draggedItemId = "";
  #draggedActorUuid = "";
  #dragDrop = null;
  #hoverPreviewInputKey = "";
  #hoverPreviewKey = "";
  #hookIds = [];
  #renderRefresh = null;
  #scrollPositions = new Map();
  #tooltipAnchorElement = null;
  #tooltipActorUuid = "";
  #tooltipCloseTimer = null;
  #tooltipDocumentPointerDownHandler = null;
  #tooltipElement = null;
  #tooltipItemId = "";
  #tooltipPinned = false;
  #tooltipTimer = null;
  #tooltipWeaponTabIndex = 0;
  #uiScale = 1;
  #viewportResizeHandler = null;

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-search-inventory",
    classes: ["fallout-maw", "fallout-maw-sheet", "fallout-maw-actor-sheet", "fallout-maw-search-inventory", "sheet", "actor"],
    position: {
      width: SEARCH_INVENTORY_REFERENCE_WIDTH,
      height: SEARCH_INVENTORY_REFERENCE_HEIGHT
    },
    window: {
      resizable: false
    }
  };

  static PARTS = {
    body: {
      template: TEMPLATES.searchInventory
    }
  };

  get title() {
    const searchedName = this.#searchedActor?.name ?? "";
    return searchedName ? `Обыск: ${searchedName}` : "Обыск";
  }

  setPosition(position = {}) {
    const fullscreenPosition = this.#getFullscreenPosition(position);
    const result = super.setPosition(fullscreenPosition);
    this.#applyUiScale(fullscreenPosition.scale);
    return result;
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
        dragleave: this.#onInventoryDragLeave.bind(this),
        drop: this._onDrop.bind(this),
        dragend: this._onDragEnd.bind(this)
      }
    });
  }

  setActors(searcherActor, searchedActor) {
    this.#searcherActorUuid = searcherActor?.uuid ?? "";
    this.#searchedActorUuid = searchedActor?.uuid ?? "";
    this.#searcherActor = searcherActor ?? null;
    this.#searchedActor = searchedActor ?? null;
    this.#clearInventoryDropPreview();
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    this.#searcherActor = await resolveActor(this.#searcherActorUuid);
    this.#searchedActor = await resolveActor(this.#searchedActorUuid);

    const canInteract = this.#canInteract();
    return {
      ...context,
      canInteract,
      fallbackIcon: FALLBACK_ICON,
      actors: [
        prepareSearchActorContext(this.#searcherActor, {
          side: "searcher",
          roleLabel: "Обыскивающий",
          canInteract
        }),
        prepareSearchActorContext(this.#searchedActor, {
          side: "searched",
          roleLabel: "Обыскиваемый",
          canInteract
        })
      ].filter(Boolean)
    };
  }

  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    this.#renderRefresh = foundry.utils.debounce(() => {
      if (!this.rendered) return;
      this.#captureScrollPositions();
      this.#clearInventoryTooltip({ force: true });
      void this.render({ force: true });
    }, 60);
    this.#hookIds = [
      ["updateActor", Hooks.on("updateActor", actor => this.#scheduleRefreshForActor(actor))],
      ["deleteActor", Hooks.on("deleteActor", actor => this.#scheduleRefreshForActor(actor))],
      ["createItem", Hooks.on("createItem", item => this.#scheduleRefreshForActor(item?.parent))],
      ["updateItem", Hooks.on("updateItem", item => this.#scheduleRefreshForActor(item?.parent))],
      ["deleteItem", Hooks.on("deleteItem", item => this.#scheduleRefreshForActor(item?.parent))]
    ];
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#hoverPreviewInputKey = "";
    this.#hoverPreviewKey = "";
    this.setPosition();
    this.#bindViewportResize();
    this._dragDrop.bind(this.element);
    this.#bindInventoryTooltipListeners();
    this.#activateWeaponSlotAspectSizing();
    this.#restoreScrollPositions();
  }

  async _onClose(options) {
    await super._onClose(options);
    this.#unbindViewportResize();
    for (const [hookName, hookId] of this.#hookIds) Hooks.off(hookName, hookId);
    this.#hookIds = [];
    this.#clearInventoryDropPreview();
    this.#draggedItemData = null;
    this.#draggedItemId = "";
    this.#draggedActorUuid = "";
    this.#clearInventoryTooltip({ force: true });
    this.#unbindInventoryTooltipDocumentClose();
    this.#scrollPositions.clear();
    if (searchInventoryWindow === this) searchInventoryWindow = null;
  }

  #getFullscreenPosition(position = {}) {
    const { viewportWidth, viewportHeight } = this.#getViewportMetrics();
    const scale = Math.max(
      0.1,
      Math.min(
        viewportWidth / SEARCH_INVENTORY_REFERENCE_WIDTH,
        viewportHeight / SEARCH_INVENTORY_REFERENCE_HEIGHT
      ) || 1
    );
    const width = SEARCH_INVENTORY_REFERENCE_WIDTH;
    const height = SEARCH_INVENTORY_REFERENCE_HEIGHT;
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
      viewportWidth: view.innerWidth || documentElement?.clientWidth || SEARCH_INVENTORY_FALLBACK_VIEWPORT_WIDTH,
      viewportHeight: view.innerHeight || documentElement?.clientHeight || SEARCH_INVENTORY_FALLBACK_VIEWPORT_HEIGHT
    };
  }

  #applyUiScale(scale = 1) {
    const normalizedScale = Math.max(0.1, Number(scale) || 1);
    this.#uiScale = normalizedScale;
    this.element?.style?.setProperty("--fallout-maw-ui-scale", String(normalizedScale));
  }

  #bindViewportResize() {
    if (this.#viewportResizeHandler) return;
    const { view } = this.#getViewportMetrics();
    this.#viewportResizeHandler = () => this.setPosition();
    view.addEventListener("resize", this.#viewportResizeHandler);
  }

  #unbindViewportResize() {
    if (!this.#viewportResizeHandler) return;
    const { view } = this.#getViewportMetrics();
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

  _canDragStart() {
    return this.#canInteract();
  }

  _canDragDrop() {
    return this.#canInteract();
  }

  async _onDragStart(event) {
    this.#clearInventoryTooltip({ force: true });
    this.#clearInventoryDropPreview();
    const itemElement = event.currentTarget?.closest?.("[data-item-id][data-search-actor-uuid]");
    const itemId = String(itemElement?.dataset?.itemId ?? "");
    const actorUuid = String(itemElement?.dataset?.searchActorUuid ?? "");
    const actor = this.#getActorByUuid(actorUuid);
    const item = actor?.items?.get(itemId);
    if (!item || !this.#canInteract()) return;

    this.#draggedItemId = item.id;
    this.#draggedActorUuid = actor.uuid;
    this.#draggedItemData = item.toObject();
    this.#highlightEquipmentSlotsForItem(this.#draggedItemData);
    event.dataTransfer?.setData("text/plain", JSON.stringify({
      type: "Item",
      uuid: item.uuid,
      itemId: item.id,
      actorUuid: actor.uuid,
      sourceActorUuid: actor.uuid,
      falloutMawSearchInventory: true
    }));
    event.currentTarget?.classList?.add("dragging");
  }

  _onDragOver(event) {
    event.stopPropagation();
    const zone = this.#getDropZone(event);
    if (!zone || !this.#canInteract()) return;
    this.#clearInventoryTooltip({ force: true });
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    this.#draggedItemData = this.#getPreviewItemData(event);
    this.#setInventoryHoverPreview(zone, event);
  }

  _onDragEnd() {
    this.#draggedItemData = null;
    this.#draggedItemId = "";
    this.#draggedActorUuid = "";
    this.#clearInventoryDropPreview();
    this.element?.querySelectorAll(".dragging").forEach(element => element.classList.remove("dragging"));
  }

  async _onDrop(event) {
    event.stopPropagation();
    const data = this.#getDragEventData(event);
    this.#draggedItemData = null;
    this.#draggedItemId = "";
    this.#draggedActorUuid = "";
    this.#clearInventoryDropPreview();
    if (data?.type !== "Item" || !this.#canInteract()) return null;

    const sourceActor = this.#getActorByUuid(String(data.sourceActorUuid ?? data.actorUuid ?? ""));
    const item = sourceActor?.items?.get(String(data.itemId ?? ""));
    if (!sourceActor || !item) return null;

    const zone = this.#getDropZone(event);
    const targetActorUuid = String(zone?.dataset?.searchActorUuid ?? zone?.closest?.("[data-search-actor-uuid]")?.dataset?.searchActorUuid ?? "");
    const targetActor = this.#getActorByUuid(targetActorUuid);
    if (!targetActor) return null;

    const placementRequest = getDropZonePlacementRequest(zone);
    const parentId = placementRequest.mode === "inventory" ? getDropZoneParentId(zone) : ROOT_CONTAINER_ID;
    const targetItem = this.#getTargetStackItem(zone, targetActor, item.id, parentId);
    const pointerPlacement = placementRequest.mode === "inventory"
      ? getSearchDropPlacementForPointer({
        actor: targetActor,
        itemData: item.toObject(),
        sourceActor,
        sourceItemId: item.id,
        parentId,
        event,
        zone
      })
      : null;
    const payload = {
      searcherActorUuid: this.#searcherActorUuid,
      searchedActorUuid: this.#searchedActorUuid,
      sourceActorUuid: sourceActor.uuid,
      targetActorUuid: targetActor.uuid,
      itemId: item.id,
      targetMode: placementRequest.mode,
      targetParentId: parentId,
      targetEquipmentSlot: placementRequest.equipmentSlot,
      targetWeaponSet: placementRequest.weaponSet,
      targetWeaponSlot: placementRequest.weaponSlot,
      targetX: pointerPlacement?.x ?? (placementRequest.mode === "inventory" && zone?.dataset?.inventoryCell !== undefined ? toInteger(zone.dataset.x) : null),
      targetY: pointerPlacement?.y ?? (placementRequest.mode === "inventory" && zone?.dataset?.inventoryCell !== undefined ? toInteger(zone.dataset.y) : null),
      targetItemId: targetItem?.id ?? ""
    };

    return this.#executeSearchTransfer(payload);
  }

  async #executeSearchTransfer(payload) {
    const sourceActor = this.#getActorByUuid(String(payload?.sourceActorUuid ?? ""));
    const targetActor = this.#getActorByUuid(String(payload?.targetActorUuid ?? ""));
    if (!sourceActor || !targetActor) return null;
    try {
      if (canModifySearchTransferDirectly(sourceActor, targetActor)) {
        await performSearchInventoryTransfer(payload, game.user?.id ?? "");
      } else {
        await requestSearchInventorySocket("transferItem", payload);
      }
    } catch (error) {
      console.error(`${SYSTEM_ID} | Search inventory transfer failed`, error);
      ui.notifications.warn(error.message || "Не удалось перенести предмет.");
    }
    return null;
  }

  #canInteract() {
    return Boolean(game.user?.isGM || this.#searcherActor?.testUserPermission?.(game.user, "OWNER"));
  }

  #getActorByUuid(uuid) {
    const normalized = String(uuid ?? "");
    if (normalized === this.#searcherActor?.uuid) return this.#searcherActor;
    if (normalized === this.#searchedActor?.uuid) return this.#searchedActor;
    return null;
  }

  #scheduleRefreshForActor(actor) {
    if (!actor) return;
    if (![this.#searcherActorUuid, this.#searchedActorUuid].includes(actor.uuid)) return;
    this.#renderRefresh?.();
  }

  #getDropZone(eventOrTarget) {
    const target = eventOrTarget?.target ?? eventOrTarget;
    const pointedCell = this.#getInventoryCellAtPointer(eventOrTarget, target);
    if (pointedCell) return pointedCell;
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

    const actor = this.#getActorByUuid(String(grid.dataset.searchActorUuid ?? ""));
    const pointer = getSearchInventoryGridPointerPosition(eventOrTarget, grid, actor, getDropZoneParentId(grid));
    if (!pointer) return null;
    const x = Math.round(pointer.x);
    const y = Math.round(pointer.y);
    return grid.querySelector(`[data-inventory-cell][data-x="${x}"][data-y="${y}"]`) ?? null;
  }

  #getPreviewItemData(event) {
    if (this.#draggedItemData) return this.#draggedItemData;
    const data = this.#getDragEventData(event);
    if (data?.type !== "Item") return null;
    const actor = this.#getActorByUuid(String(data.sourceActorUuid ?? data.actorUuid ?? ""));
    const item = actor?.items?.get(String(data.itemId ?? ""));
    if (!item) return null;
    this.#draggedItemId = item.id;
    this.#draggedActorUuid = actor.uuid;
    return item.toObject();
  }

  #getDragEventData(event) {
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

  #getTargetStackItem(target, actor, sourceItemId = "", parentId = ROOT_CONTAINER_ID) {
    const itemElement = target?.closest?.("[data-item-id][data-search-actor-uuid]");
    if (itemElement && itemElement.dataset.searchActorUuid === actor.uuid && itemElement.dataset.itemId !== sourceItemId) {
      if (!itemElement.closest("[data-inventory-grid]")) return null;
      if (String(itemElement.dataset.inventoryParentId ?? ROOT_CONTAINER_ID) !== String(parentId ?? ROOT_CONTAINER_ID)) return null;
      return actor.items.get(itemElement.dataset.itemId) ?? null;
    }

    const cell = target?.closest?.("[data-inventory-cell]");
    if (!cell) return null;
    const x = toInteger(cell.dataset.x);
    const y = toInteger(cell.dataset.y);
    return getContextInventoryItems(parentId, actor.items).find(item => {
      if (item.id === sourceItemId) return false;
      const placement = normalizeInventoryPlacement(item.system?.placement ?? {}, item, actor.items);
      return placementContainsInventoryCell(placement, x, y);
    }) ?? null;
  }

  #onInventoryDragLeave(event) {
    const zone = event.target?.closest?.("[data-search-drop-zone]");
    if (!zone) return;

    const hoveredElement = document.elementFromPoint(event.clientX, event.clientY);
    const hoveredZone = hoveredElement?.closest?.("[data-search-drop-zone]") ?? null;
    if (hoveredZone === zone) return;
    if (zone.closest("[data-inventory-grid]") && hoveredElement?.closest?.("[data-inventory-grid]") === zone.closest("[data-inventory-grid]")) return;
    this.#clearInventoryHoverPreview();
  }

  #setInventoryHoverPreview(zone = null, event = null) {
    if (!zone) {
      this.#clearInventoryHoverPreview();
      return;
    }

    const actor = this.#getActorByUuid(String(zone.dataset.searchActorUuid ?? ""));
    if (zone.dataset.equipmentSlot || (zone.dataset.weaponSet && zone.dataset.weaponSlot)) {
      const inputKey = `slot:${actor?.uuid ?? ""}:${zone.dataset.equipmentSlot ?? ""}:${zone.dataset.weaponSet ?? ""}:${zone.dataset.weaponSlot ?? ""}:${this.#draggedActorUuid}:${this.#draggedItemId}`;
      if (this.#hoverPreviewInputKey === inputKey) return;
      this.#hoverPreviewInputKey = inputKey;
      if (!actor || !this.#draggedItemData) {
        this.#clearInventoryHoverPreviewClasses();
        return;
      }
      const placementRequest = getDropZonePlacementRequest(zone);
      const excludeItemIds = actor.uuid === this.#draggedActorUuid && this.#draggedItemId ? [this.#draggedItemId] : [];
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
    if (zone.dataset.inventoryCell === undefined) {
      this.#clearInventoryHoverPreview();
      return;
    }

    if (!actor || !this.#draggedItemData) {
      this.#applySingleZonePreview(zone, `inventory-cell:${zone.dataset.searchActorUuid ?? ""}:${getDropZoneParentId(zone)}:${zone.dataset.x ?? ""}:${zone.dataset.y ?? ""}`);
      return;
    }

    const parentId = getDropZoneParentId(zone);
    const inputKey = `inventory:${actor.uuid}:${parentId}:${zone.dataset.x ?? ""}:${zone.dataset.y ?? ""}:${this.#draggedActorUuid}:${this.#draggedItemId}`;
    if (this.#hoverPreviewInputKey === inputKey) return;
    this.#hoverPreviewInputKey = inputKey;
    const targetItem = this.#getTargetStackItem(zone, actor, this.#draggedItemId, parentId);
    const targetHasStackRoom = targetItem
      && areStackable(this.#draggedItemData, targetItem)
      && getItemQuantity(targetItem) < getItemMaxStack(targetItem);
    if (targetHasStackRoom) {
      this.#applyInventoryPlacementPreview(actor, parentId, normalizeInventoryPlacement(targetItem.system?.placement ?? {}, targetItem, actor.items));
      return;
    }

    const placement = getSearchDropPlacementForPointer({
      actor,
      itemData: this.#draggedItemData,
      sourceActor: this.#getActorByUuid(this.#draggedActorUuid),
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
    this.element?.querySelectorAll(".drop-preview").forEach(element => element.classList.remove("drop-preview"));
  }

  #highlightEquipmentSlotsForItem(itemData) {
    if (!itemData) return false;
    let highlighted = false;

    for (const actor of [this.#searcherActor, this.#searchedActor]) {
      if (!actor) continue;
      const actorUuid = CSS.escape(actor.uuid);
      const race = getCreatureOptions().races.find(entry => entry.id === actor.system?.creature?.raceId) ?? null;

      for (const slot of getRaceEquipmentSlotsForItem(race, itemData)) {
        this.element?.querySelector(
          `[data-search-actor-uuid="${actorUuid}"][data-equipment-slot="${CSS.escape(slot.key)}"]`
        )?.classList.add("drop-match-preview");
        highlighted = true;
      }

      for (const set of race?.weaponSets ?? []) {
        for (const slot of set.slots ?? []) {
          if (!canUseWeaponSlotForItem(race, itemData, set.key, slot.key)) continue;
          this.element?.querySelector(
            `[data-search-actor-uuid="${actorUuid}"][data-weapon-set="${CSS.escape(set.key)}"][data-weapon-slot="${CSS.escape(slot.key)}"]`
          )?.classList.add("drop-match-preview");
          highlighted = true;
        }
      }

      this.element?.querySelectorAll(
        `[data-search-actor-uuid="${actorUuid}"][data-weapon-set^="container:"][data-weapon-slot]`
      ).forEach(element => {
        element.classList.add("drop-match-preview");
        highlighted = true;
      });
    }

    return highlighted;
  }

  #bindInventoryTooltipListeners() {
    const root = this.element?.querySelector("[data-search-root]");
    if (!root || root.dataset.tooltipBound) return;
    root.dataset.tooltipBound = "true";
    root.addEventListener("pointerover", event => this.#onInventoryTooltipPointerOver(event));
    root.addEventListener("pointerout", event => this.#onInventoryTooltipPointerOut(event));
    root.addEventListener("mousedown", event => this.#onInventoryTooltipMiddleMouseDown(event));
    root.addEventListener("auxclick", event => this.#onInventoryTooltipAuxClick(event));
    root.addEventListener("click", event => void this.#onSearchRootClick(event));
  }

  #onInventoryTooltipMiddleMouseDown(event) {
    if (event.button !== 1) return;
    if (!event.target?.closest?.("[data-tooltip-item], .fallout-maw-inventory-tooltip")) return;
    event.preventDefault();
  }

  async #onSearchRootClick(event) {
    const currencyButton = event.target?.closest?.("[data-search-currency][data-search-actor-uuid]");
    if (currencyButton && this.element?.contains(currencyButton)) {
      await this.#onSearchCurrencyClick(event, currencyButton);
      return;
    }

    if (!event.shiftKey) return;
    const itemElement = event.target?.closest?.("[data-item-id][data-search-actor-uuid]");
    if (!itemElement || !this.element?.contains(itemElement)) return;
    event.preventDefault();
    event.stopPropagation();
    await this.#transferItemToOppositeRoot(itemElement);
  }

  async #transferItemToOppositeRoot(itemElement) {
    if (!this.#canInteract()) return;
    const sourceActor = this.#getActorByUuid(String(itemElement?.dataset?.searchActorUuid ?? ""));
    const targetActor = sourceActor?.uuid === this.#searcherActorUuid ? this.#searchedActor : this.#searcherActor;
    const item = sourceActor?.items?.get(String(itemElement?.dataset?.itemId ?? ""));
    if (!sourceActor || !targetActor || !item || sourceActor.uuid === targetActor.uuid) return;
    const targetParentId = getQuickTransferTargetParentId({ sourceActor, targetActor, sourceItem: item });
    if (targetParentId === null) {
      ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));
      return;
    }
    this.#clearInventoryTooltip({ force: true });
    await this.#executeSearchTransfer({
      searcherActorUuid: this.#searcherActorUuid,
      searchedActorUuid: this.#searchedActorUuid,
      sourceActorUuid: sourceActor.uuid,
      targetActorUuid: targetActor.uuid,
      itemId: item.id,
      targetMode: "inventory",
      targetParentId,
      targetEquipmentSlot: "",
      targetWeaponSet: "",
      targetWeaponSlot: "",
      targetX: null,
      targetY: null,
      targetItemId: ""
    });
  }

  async #onSearchCurrencyClick(event, button) {
    event.preventDefault();
    event.stopPropagation();
    if (!this.#canInteract()) return;

    const sourceActor = this.#getActorByUuid(String(button?.dataset?.searchActorUuid ?? ""));
    const targetActor = sourceActor?.uuid === this.#searcherActorUuid ? this.#searchedActor : this.#searcherActor;
    const currencyKey = String(button?.dataset?.searchCurrency ?? "");
    if (!sourceActor || !targetActor || !currencyKey || sourceActor.uuid === targetActor.uuid) return;

    const currency = getCurrencySettings().find(entry => entry.key === currencyKey);
    const available = Math.max(0, toInteger(sourceActor.system?.currencies?.[currencyKey]));
    if (!available) {
      ui.notifications.warn("У актера нет этой валюты.");
      return;
    }

    const actionLabel = sourceActor.uuid === this.#searchedActorUuid ? "Забрать" : "Переложить";
    const formData = await DialogV2.input({
      window: {
        title: `${actionLabel} валюту`
      },
      content: `
        <p><strong>${escapeHTML(sourceActor.name)}</strong> -> <strong>${escapeHTML(targetActor.name)}</strong></p>
        <label class="fallout-maw-stacked-field">
          <span>${escapeHTML(currency?.label ?? currencyKey)}: 0 / ${available}</span>
          <input type="number" name="amount" value="${available}" min="1" max="${available}" step="1" autofocus>
        </label>
      `,
      ok: {
        label: actionLabel,
        icon: "fa-solid fa-coins",
        callback: (_event, okButton) => new FormDataExtended(okButton.form).object
      },
      buttons: [{
        action: "cancel",
        label: "Отмена"
      }],
      position: {
        width: 420
      },
      rejectClose: false
    });
    if (!formData || formData === "cancel") return;

    const amount = Math.max(1, Math.min(available, toInteger(formData.amount)));
    if (!amount) return;
    const payload = {
      searcherActorUuid: this.#searcherActorUuid,
      searchedActorUuid: this.#searchedActorUuid,
      sourceActorUuid: sourceActor.uuid,
      targetActorUuid: targetActor.uuid,
      currencyKey,
      amount
    };

    try {
      if (canModifySearchTransferDirectly(sourceActor, targetActor)) {
        await performSearchCurrencyTransfer(payload, game.user?.id ?? "");
      } else {
        await requestSearchInventorySocket("transferCurrency", payload);
      }
    } catch (error) {
      console.error(`${SYSTEM_ID} | Search currency transfer failed`, error);
      ui.notifications.warn(error.message || "Не удалось перенести валюту.");
    }
  }

  #onInventoryTooltipPointerOver(event) {
    if (this.#tooltipPinned) return;
    const anchor = event.target?.closest?.("[data-tooltip-item][data-search-actor-uuid]");
    if (!anchor || !this.element?.contains(anchor)) return;
    if (this.#tooltipAnchorElement === anchor && this.#tooltipElement) return;
    this.#scheduleInventoryTooltip(anchor);
  }

  #onInventoryTooltipPointerOut(event) {
    const anchor = event.target?.closest?.("[data-tooltip-item][data-search-actor-uuid]");
    if (!anchor || !this.element?.contains(anchor)) return;
    if (anchor.contains(event.relatedTarget) || this.#tooltipElement?.contains(event.relatedTarget)) return;
    if (!this.#tooltipPinned) this.#scheduleInventoryTooltipClose();
  }

  #onInventoryTooltipAuxClick(event) {
    if (event.button !== 1) return;
    const anchor = event.target?.closest?.("[data-tooltip-item][data-search-actor-uuid]");
    if (!anchor || !this.element?.contains(anchor)) return;
    event.preventDefault();
    event.stopPropagation();
    this.#clearInventoryTooltip({ force: true });
    void this.#showInventoryTooltip(anchor, { pinned: true });
  }

  #scheduleInventoryTooltip(anchor) {
    if (this.#tooltipPinned) return;
    this.#clearInventoryTooltip();
    this.#tooltipAnchorElement = anchor;
    this.#tooltipActorUuid = String(anchor.dataset.searchActorUuid ?? "");
    this.#tooltipItemId = String(anchor.dataset.tooltipItem ?? anchor.dataset.itemId ?? "");
    const view = this.element?.ownerDocument?.defaultView ?? window;
    this.#tooltipTimer = view.setTimeout(() => {
      this.#tooltipTimer = null;
      void this.#showInventoryTooltip(anchor);
    }, 420);
  }

  async #showInventoryTooltip(anchor = this.#tooltipAnchorElement, { pinned = false } = {}) {
    const actor = this.#getActorByUuid(String(anchor?.dataset?.searchActorUuid ?? this.#tooltipActorUuid));
    const itemId = String(anchor?.dataset?.tooltipItem ?? anchor?.dataset?.itemId ?? this.#tooltipItemId);
    const item = actor?.items?.get(itemId);
    if (!actor || !item) return;

    this.#clearInventoryTooltip({ keepAnchor: true });
    const tooltip = document.createElement("aside");
    tooltip.className = "fallout-maw-inventory-tooltip";
    tooltip.classList.toggle("pinned", Boolean(pinned));
    tooltip.style.setProperty("--fallout-maw-ui-scale", String(this.#uiScale));
    tooltip.style.pointerEvents = pinned ? "auto" : "none";
    tooltip.innerHTML = await renderInventoryItemTooltipHTML(item, actor, {
      activeWeaponIndex: this.#tooltipWeaponTabIndex,
      baseMode: false
    });
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
    this.#tooltipActorUuid = actor.uuid;
    this.#tooltipItemId = item.id;
    if (pinned) this.#bindInventoryTooltipDocumentClose();
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

  #clearInventoryTooltip({ force = false, keepAnchor = false } = {}) {
    if (this.#tooltipTimer) {
      const view = this.element?.ownerDocument?.defaultView ?? window;
      view.clearTimeout(this.#tooltipTimer);
      this.#tooltipTimer = null;
    }
    this.#cancelInventoryTooltipClose();
    if (this.#tooltipPinned && !force) return;
    this.#unbindInventoryTooltipDocumentClose();
    this.#tooltipElement?.remove();
    this.#tooltipElement = null;
    this.#tooltipPinned = false;
    if (!keepAnchor) {
      this.#tooltipAnchorElement = null;
      this.#tooltipActorUuid = "";
      this.#tooltipItemId = "";
    }
  }
}

function prepareSearchActorContext(actor, { side = "", roleLabel = "", canInteract = false } = {}) {
  if (!actor) return null;
  const race = getCreatureOptions().races.find(entry => entry.id === actor.system?.creature?.raceId);
  const inventory = prepareInventoryContext(actor, race);
  const decoratedInventory = decorateInventoryForSearch(inventory, actor.uuid, canInteract);
  const loadValue = Math.max(0, Number(actor.system?.load?.value) || 0);
  const loadMax = Math.max(0, Number(actor.system?.load?.max) || 0);
  const loadRatio = loadMax > 0 ? loadValue / loadMax : 0;
  const currencies = getCurrencySettings().map(currency => ({
    ...currency,
    amount: toInteger(actor.system?.currencies?.[currency.key]),
    hasImage: Boolean(currency.img)
  }));

  return {
    side,
    roleLabel,
    uuid: actor.uuid,
    name: actor.name,
    img: normalizeImagePath(actor.img, "icons/svg/mystery-man.svg"),
    inventory: decoratedInventory,
    currencies,
    load: {
      value: formatWeight(loadValue),
      max: formatWeight(loadMax),
      percent: Number(Math.max(0, Math.min(100, loadRatio * 100)).toFixed(2)),
      trend: "negative",
      state: loadRatio >= 1 ? "critical" : loadRatio >= 0.75 ? "warning" : "normal"
    }
  };
}

function decorateInventoryForSearch(inventory, actorUuid, canInteract) {
  const decorateItem = item => item ? {
    ...item,
    actorUuid,
    draggableClass: canInteract ? "draggable" : ""
  } : item;

  return {
    ...inventory,
    equipmentSlots: (inventory.equipmentSlots ?? []).map(slot => ({
      ...slot,
      item: decorateItem(slot.item)
    })),
    weaponSets: (inventory.weaponSets ?? []).map(set => ({
      ...set,
      slots: (set.slots ?? []).map(slot => ({
        ...slot,
        actorUuid,
        weaponSetKey: set.key,
        item: decorateItem(slot.item)
      }))
    })),
    grid: {
      ...inventory.grid,
      items: (inventory.grid?.items ?? []).map(decorateItem)
    },
    containers: (inventory.containers ?? []).map(container => ({
      ...decorateItem(container),
      grid: {
        ...container.grid,
        items: (container.grid?.items ?? []).map(decorateItem)
      }
    }))
  };
}

async function performSearchInventoryTransfer(payload = {}, requesterUserId = "") {
  const searcherActor = await resolveActor(payload.searcherActorUuid);
  const searchedActor = await resolveActor(payload.searchedActorUuid);
  const sourceActor = await resolveActor(payload.sourceActorUuid);
  const targetActor = await resolveActor(payload.targetActorUuid);
  if (!searcherActor || !searchedActor || !sourceActor || !targetActor) throw new Error("Actor not found.");

  const requester = requesterUserId ? game.users?.get(requesterUserId) : game.user;
  if (requester && !requester.isGM && !searcherActor.testUserPermission(requester, "OWNER")) {
    throw new Error("No searcher actor owner permission.");
  }

  const allowedActorUuids = new Set([searcherActor.uuid, searchedActor.uuid]);
  if (!allowedActorUuids.has(sourceActor.uuid) || !allowedActorUuids.has(targetActor.uuid)) {
    throw new Error("Search transfer actor mismatch.");
  }

  const item = sourceActor.items?.get(String(payload.itemId ?? ""));
  if (!item) throw new Error("Item not found.");
  const targetParentId = String(payload.targetParentId ?? ROOT_CONTAINER_ID);
  validateTargetParent(targetActor, targetParentId);

  return transferItemBetweenActors({
    sourceActor,
    targetActor,
    sourceItem: item,
    targetMode: String(payload.targetMode ?? "inventory"),
    targetParentId,
    targetEquipmentSlot: String(payload.targetEquipmentSlot ?? ""),
    targetWeaponSet: String(payload.targetWeaponSet ?? ""),
    targetWeaponSlot: String(payload.targetWeaponSlot ?? ""),
    targetX: payload.targetX,
    targetY: payload.targetY,
    targetItemId: String(payload.targetItemId ?? "")
  });
}

async function performSearchCurrencyTransfer(payload = {}, requesterUserId = "") {
  const searcherActor = await resolveActor(payload.searcherActorUuid);
  const searchedActor = await resolveActor(payload.searchedActorUuid);
  const sourceActor = await resolveActor(payload.sourceActorUuid);
  const targetActor = await resolveActor(payload.targetActorUuid);
  if (!searcherActor || !searchedActor || !sourceActor || !targetActor) throw new Error("Actor not found.");

  const requester = requesterUserId ? game.users?.get(requesterUserId) : game.user;
  if (requester && !requester.isGM && !searcherActor.testUserPermission(requester, "OWNER")) {
    throw new Error("No searcher actor owner permission.");
  }

  const allowedActorUuids = new Set([searcherActor.uuid, searchedActor.uuid]);
  if (!allowedActorUuids.has(sourceActor.uuid) || !allowedActorUuids.has(targetActor.uuid) || sourceActor.uuid === targetActor.uuid) {
    throw new Error("Search currency transfer actor mismatch.");
  }

  const currencyKey = String(payload.currencyKey ?? "");
  const currencyExists = getCurrencySettings().some(entry => entry.key === currencyKey);
  if (!currencyKey || !currencyExists) throw new Error("Invalid currency.");

  const available = Math.max(0, toInteger(sourceActor.system?.currencies?.[currencyKey]));
  const amount = Math.max(0, Math.min(available, toInteger(payload.amount)));
  if (!amount) throw new Error("No currency to transfer.");

  const targetAmount = Math.max(0, toInteger(targetActor.system?.currencies?.[currencyKey]));
  await sourceActor.update({ [`system.currencies.${currencyKey}`]: available - amount });
  await targetActor.update({ [`system.currencies.${currencyKey}`]: targetAmount + amount });
  return { amount };
}

async function transferItemBetweenActors({
  sourceActor,
  targetActor,
  sourceItem,
  targetMode = "inventory",
  targetParentId = ROOT_CONTAINER_ID,
  targetEquipmentSlot = "",
  targetWeaponSet = "",
  targetWeaponSlot = "",
  targetX = null,
  targetY = null,
  targetItemId = ""
} = {}) {
  const itemData = sourceItem.toObject();
  const targetItem = targetItemId ? targetActor.items?.get(targetItemId) : null;
  const targetStackPlacement = targetMode === "inventory" && targetItem && areStackable(itemData, targetItem) && getItemQuantity(targetItem) < getItemMaxStack(targetItem)
    ? normalizeInventoryPlacement(targetItem.system?.placement ?? {}, targetItem, targetActor.items)
    : null;
  const preferredPlacement = getRequestedTargetPlacement({
    sourceActor,
    targetActor,
    sourceItem,
    itemData,
    targetMode,
    targetParentId,
    targetEquipmentSlot,
    targetWeaponSet,
    targetWeaponSlot,
    targetX,
    targetY,
    excludeItemId: sourceActor.uuid === targetActor.uuid ? sourceItem.id : ""
  }) ?? targetStackPlacement;
  if (!preferredPlacement) throw new Error(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));

  if (preferredPlacement.mode !== "inventory") {
    if (sourceActor.uuid === targetActor.uuid) return moveOwnedItemToActorPlacement(targetActor, sourceItem, preferredPlacement);
    if (isContainerItem(sourceItem)) return transferContainerTree({ sourceActor, targetActor, sourceItem, targetParentId: ROOT_CONTAINER_ID, preferredPlacement });
    return createExternalPlacedItem(targetActor, itemData, preferredPlacement, { sourceActor, sourceItem });
  }

  if (sourceActor.uuid === targetActor.uuid) {
    return insertItemIntoActorInventory(targetActor, itemData, preferredPlacement, {
      sourceItem,
      targetItem,
      parentId: targetParentId
    });
  }

  if (isContainerItem(sourceItem)) {
    return transferContainerTree({ sourceActor, targetActor, sourceItem, targetParentId, preferredPlacement });
  }

  return insertExternalItemIntoActorInventory(targetActor, itemData, preferredPlacement, {
    sourceActor,
    sourceItem,
    targetItem,
    parentId: targetParentId
  });
}

async function moveOwnedItemToActorPlacement(actor, item, placement) {
  const resolvedPlacement = resolveActorPlacement(actor, item.toObject(), placement, [item.id]);
  if (!resolvedPlacement) throw new Error(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));
  const updateData = createPlacementItemUpdate(item.id, getItemQuantity(item), ROOT_CONTAINER_ID, resolvedPlacement, item, {
    equipped: resolvedPlacement.mode === "equipment"
  });
  if (!validateActorProjectedInventoryState(actor, { updates: [updateData] })) {
    throwInventoryNoSpace();
  }
  return actor.updateEmbeddedDocuments("Item", [updateData]);
}

async function createExternalPlacedItem(actor, itemData, placement, { sourceActor, sourceItem } = {}) {
  const resolvedPlacement = resolveActorPlacement(actor, itemData, placement);
  if (!resolvedPlacement) throw new Error(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));
  const createData = createInventoryStackData(itemData, getItemQuantity(itemData), ROOT_CONTAINER_ID, resolvedPlacement, {
    equipped: resolvedPlacement.mode === "equipment"
  });
  if (!validateActorProjectedInventoryState(actor, { creates: [createData] })) {
    throwInventoryNoSpace();
  }
  const created = await actor.createEmbeddedDocuments("Item", [createData]);
  await sourceActor.deleteEmbeddedDocuments("Item", [sourceItem.id]);
  return created;
}

async function insertItemIntoActorInventory(actor, itemData, requestedPlacement, { sourceItem = null, targetItem = null, parentId = ROOT_CONTAINER_ID } = {}) {
  const maxStack = getItemMaxStack(itemData);
  let remainingQuantity = Math.max(1, getItemQuantity(itemData));
  const excludedIds = [sourceItem?.id ?? ""].filter(Boolean);
  const preferredPlacement = normalizeInventoryPlacement(requestedPlacement, itemData, actor.items);
  const usableTargetItem = targetItem && areStackable(itemData, targetItem) ? targetItem : null;
  const stackTargets = findCompatibleStackTargets(actor, itemData, usableTargetItem, excludedIds, parentId);
  const targetUpdates = [];

  for (const stackTarget of stackTargets) {
    const availableSpace = Math.max(0, getItemMaxStack(stackTarget) - getItemQuantity(stackTarget));
    const transferredQuantity = Math.min(remainingQuantity, availableSpace);
    if (!transferredQuantity) continue;
    targetUpdates.push({
      _id: stackTarget.id,
      "system.quantity": getItemQuantity(stackTarget) + transferredQuantity
    });
    remainingQuantity -= transferredQuantity;
    if (!remainingQuantity) break;
  }

  const reservedPlacements = [];
  const createData = [];
  let sourceUpdate = null;
  let deleteSource = Boolean(sourceItem);

  if (sourceItem && remainingQuantity > 0) {
    const sourcePlacement = getSourcePlacement(actor, sourceItem, itemData, usableTargetItem ? null : preferredPlacement, usableTargetItem, parentId, reservedPlacements);
    if (!sourcePlacement) throwInventoryNoSpace();
    const sourceQuantity = Math.min(remainingQuantity, maxStack);
    remainingQuantity -= sourceQuantity;
    reservedPlacements.push(sourcePlacement);
    sourceUpdate = createInventoryItemUpdate(sourceItem.id, sourceQuantity, parentId, sourcePlacement, sourceItem);
    deleteSource = false;
  }

  let nextPlacement = isActorInventoryPlacementAvailable(actor, parentId, preferredPlacement, excludedIds, reservedPlacements)
    ? preferredPlacement
    : null;
  while (remainingQuantity > 0) {
    const stackQuantity = Math.min(remainingQuantity, maxStack);
    const placement = nextPlacement ?? getFirstAvailableActorInventoryPlacement(actor, parentId, itemData, excludedIds, reservedPlacements);
    if (!placement) throwInventoryNoSpace();
    createData.push(createInventoryStackData(itemData, stackQuantity, parentId, placement));
    reservedPlacements.push(placement);
    remainingQuantity -= stackQuantity;
    nextPlacement = null;
  }

  if (!validateActorProjectedInventoryState(actor, {
    updates: [...targetUpdates, ...(sourceUpdate ? [sourceUpdate] : [])],
    deletes: (!sourceUpdate && deleteSource && sourceItem) ? [sourceItem.id] : [],
    creates: createData
  })) {
    throwInventoryNoSpace();
  }

  if (targetUpdates.length) await actor.updateEmbeddedDocuments("Item", targetUpdates);
  if (sourceUpdate) await actor.updateEmbeddedDocuments("Item", [sourceUpdate]);
  else if (deleteSource && sourceItem) await actor.deleteEmbeddedDocuments("Item", [sourceItem.id]);
  if (createData.length) return actor.createEmbeddedDocuments("Item", createData);
  return null;
}

async function insertExternalItemIntoActorInventory(actor, itemData, requestedPlacement, {
  sourceActor,
  sourceItem,
  targetItem = null,
  parentId = ROOT_CONTAINER_ID
} = {}) {
  const maxStack = getItemMaxStack(itemData);
  let remainingQuantity = Math.max(1, getItemQuantity(itemData));
  const usableTargetItem = targetItem && areStackable(itemData, targetItem) ? targetItem : null;
  const stackTargets = findCompatibleStackTargets(actor, itemData, usableTargetItem, [], parentId);
  const targetUpdates = [];

  for (const stackTarget of stackTargets) {
    const availableSpace = Math.max(0, getItemMaxStack(stackTarget) - getItemQuantity(stackTarget));
    const transferredQuantity = Math.min(remainingQuantity, availableSpace);
    if (!transferredQuantity) continue;
    targetUpdates.push({
      _id: stackTarget.id,
      "system.quantity": getItemQuantity(stackTarget) + transferredQuantity
    });
    remainingQuantity -= transferredQuantity;
    if (!remainingQuantity) break;
  }

  const reservedPlacements = [];
  const createData = [];
  let nextPlacement = usableTargetItem ? null : requestedPlacement;
  while (remainingQuantity > 0) {
    const stackQuantity = Math.min(remainingQuantity, maxStack);
    const placement = nextPlacement && isActorInventoryPlacementAvailable(actor, parentId, nextPlacement, [], reservedPlacements)
      ? nextPlacement
      : getFirstAvailableActorInventoryPlacement(actor, parentId, itemData, [], reservedPlacements);
    if (!placement) throwInventoryNoSpace();
    createData.push(createInventoryStackData(itemData, stackQuantity, parentId, placement));
    reservedPlacements.push(placement);
    remainingQuantity -= stackQuantity;
    nextPlacement = null;
  }

  if (!validateActorProjectedInventoryState(actor, {
    updates: targetUpdates,
    creates: createData
  })) {
    throwInventoryNoSpace();
  }

  if (targetUpdates.length) await actor.updateEmbeddedDocuments("Item", targetUpdates);
  if (createData.length) await actor.createEmbeddedDocuments("Item", createData);
  await sourceActor.deleteEmbeddedDocuments("Item", [sourceItem.id]);
  return null;
}

async function transferContainerTree({ sourceActor, targetActor, sourceItem, targetParentId, preferredPlacement } = {}) {
  if (preferredPlacement.mode === "inventory" && !isActorInventoryPlacementAvailable(targetActor, targetParentId, preferredPlacement, [], [])) {
    throw new Error(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));
  }
  if (preferredPlacement.mode === "inventory" && targetParentId) {
    const targetContainer = targetActor.items?.get(targetParentId);
    const projectedLoad = getContainerContentsWeight(targetContainer, targetActor.items) + getItemTotalWeight(sourceItem, sourceActor.items);
    if (projectedLoad > getContainerMaxLoad(targetContainer)) throw new Error(game.i18n.localize("FALLOUTMAW.Messages.ContainerMaxLoadExceeded"));
  }

  const rootData = sourceItem.toObject();
  const createData = createInventoryStackData(rootData, 1, targetParentId, preferredPlacement, {
    equipped: preferredPlacement.mode === "equipment"
  });
  const containedItems = getAllContainedItems(sourceItem.id, sourceActor.items);
  const validationCreates = buildContainerTreeValidationCreates(createData, sourceItem, containedItems);
  if (!validateActorProjectedInventoryState(targetActor, { creates: validationCreates })) {
    throwInventoryNoSpace();
  }

  const [createdRoot] = await targetActor.createEmbeddedDocuments("Item", [createData]);
  const idMap = new Map([[sourceItem.id, createdRoot.id]]);
  for (const child of containedItems) {
    const childData = child.toObject();
    const oldParentId = getItemContainerParentId(child);
    const newParentId = idMap.get(oldParentId);
    if (!newParentId) continue;
    delete childData._id;
    delete childData.id;
    foundry.utils.mergeObject(childData, {
      system: {
        equipped: false,
        container: {
          parentId: newParentId
        }
      }
    });
    const [createdChild] = await targetActor.createEmbeddedDocuments("Item", [childData]);
    idMap.set(child.id, createdChild.id);
  }

  await sourceActor.deleteEmbeddedDocuments("Item", [sourceItem.id, ...containedItems.map(item => item.id)]);
  return createdRoot;
}

function buildContainerTreeValidationCreates(rootCreateData, sourceItem, containedItems = []) {
  const rootSyntheticId = "synthetic-container-root";
  const syntheticIdMap = new Map([[sourceItem.id, rootSyntheticId]]);
  const creates = [{
    ...foundry.utils.deepClone(rootCreateData),
    _id: rootSyntheticId,
    id: rootSyntheticId
  }];

  let index = 0;
  for (const child of containedItems) {
    const oldParentId = getItemContainerParentId(child);
    const newParentId = syntheticIdMap.get(oldParentId);
    if (!newParentId) continue;
    const syntheticId = `synthetic-container-child-${index += 1}`;
    const childData = child.toObject();
    delete childData._id;
    delete childData.id;
    foundry.utils.mergeObject(childData, {
      _id: syntheticId,
      id: syntheticId,
      system: {
        equipped: false,
        container: {
          parentId: newParentId
        }
      }
    });
    creates.push(childData);
    syntheticIdMap.set(child.id, syntheticId);
  }

  return creates;
}

function findCompatibleStackTargets(actor, itemData, preferredTarget = null, excludeItemIds = [], parentId = ROOT_CONTAINER_ID) {
  const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
  const targets = [];
  const canUsePreferredTarget = preferredTarget
    && !excluded.has(preferredTarget.id)
    && getItemContainerParentId(preferredTarget) === parentId
    && areStackable(itemData, preferredTarget)
    && getItemQuantity(preferredTarget) < getItemMaxStack(preferredTarget);
  if (canUsePreferredTarget) targets.push(preferredTarget);

  for (const item of getContextInventoryItems(parentId, actor.items)) {
    if (!item || excluded.has(item.id) || targets.some(target => target.id === item.id)) continue;
    if (!areStackable(itemData, item) || getItemQuantity(item) >= getItemMaxStack(item)) continue;
    targets.push(item);
  }
  return targets;
}

function getSourcePlacement(actor, sourceItem, itemData, preferredPlacement = null, targetItem = null, parentId = ROOT_CONTAINER_ID, reservedPlacements = []) {
  const excludedIds = [sourceItem.id, targetItem?.id ?? ""].filter(Boolean);
  const currentPlacement = (
    sourceItem.system?.placement?.mode === "inventory"
    && getItemContainerParentId(sourceItem) === parentId
  )
    ? normalizeInventoryPlacement(sourceItem.system?.placement ?? {}, itemData, actor.items)
    : null;

  if (targetItem && currentPlacement && isActorInventoryPlacementAvailable(actor, parentId, currentPlacement, excludedIds, reservedPlacements)) return currentPlacement;
  if (preferredPlacement && isActorInventoryPlacementAvailable(actor, parentId, preferredPlacement, excludedIds, reservedPlacements)) return preferredPlacement;
  if (currentPlacement && isActorInventoryPlacementAvailable(actor, parentId, currentPlacement, excludedIds, reservedPlacements)) return currentPlacement;
  return getFirstAvailableActorInventoryPlacement(actor, parentId, itemData, excludedIds, reservedPlacements);
}

function getRequestedTargetPlacement({
  sourceActor,
  targetActor,
  sourceItem = null,
  itemData,
  targetMode = "inventory",
  targetParentId,
  targetEquipmentSlot = "",
  targetWeaponSet = "",
  targetWeaponSlot = "",
  targetX,
  targetY,
  excludeItemId = ""
} = {}) {
  const excluded = excludeItemId ? [excludeItemId] : [];
  if (targetMode === "equipment") {
    return resolveActorPlacement(targetActor, itemData, {
      mode: "equipment",
      equipmentSlot: targetEquipmentSlot,
      weaponSet: "",
      weaponSlot: "",
      x: 1,
      y: 1
    }, excluded);
  }
  if (targetMode === "weapon") {
    return resolveActorPlacement(targetActor, itemData, {
      mode: "weapon",
      equipmentSlot: "",
      weaponSet: targetWeaponSet,
      weaponSlot: targetWeaponSlot,
      x: 1,
      y: 1
    }, excluded);
  }

  if (Number.isFinite(Number(targetX)) && Number.isFinite(Number(targetY))) {
    const placement = createInventoryPlacement(toInteger(targetX), toInteger(targetY), itemData, targetActor.items);
    if (isContainerItem(itemData) && sourceActor) {
      const footprint = getItemFootprint(sourceItem ?? itemData, sourceActor.items);
      placement.width = footprint.width;
      placement.height = footprint.height;
    }
    if (isActorInventoryPlacementAvailable(targetActor, targetParentId, placement, excluded, [])) return placement;
  }
  return getFirstAvailableActorInventoryPlacement(targetActor, targetParentId, itemData, excluded, []);
}

function getSearchDropPlacementForPointer({ actor, itemData, sourceActor, sourceItemId = "", parentId = ROOT_CONTAINER_ID, event = null, zone = null } = {}) {
  if (!actor || !itemData) return null;
  const grid = zone?.closest?.("[data-inventory-grid]");
  const pointer = getSearchInventoryGridPointerPosition(event, grid, actor, parentId);
  const fallbackCellX = toInteger(zone?.dataset?.x);
  const fallbackCellY = toInteger(zone?.dataset?.y);
  const anchor = pointer ?? {
    x: fallbackCellX,
    y: fallbackCellY
  };
  if (!anchor.x || !anchor.y) return null;

  const dimensions = getActorInventoryContextDimensions(actor, parentId);
  const basePlacement = createInventoryPlacement(1, 1, itemData, actor.items);
  if (isContainerItem(itemData) && sourceActor) {
    const footprint = getItemFootprint(sourceActor.items?.get(sourceItemId) ?? itemData, sourceActor.items);
    basePlacement.width = footprint.width;
    basePlacement.height = footprint.height;
  }

  const excludeItemIds = sourceActor?.uuid === actor.uuid && sourceItemId ? [sourceItemId] : [];
  const maxX = Math.max(1, dimensions.columns - basePlacement.width + 1);
  const maxY = Math.max(1, dimensions.rows - basePlacement.height + 1);
  const preferredX = Math.max(1, Math.min(maxX, Math.round(anchor.x - ((basePlacement.width - 1) / 2))));
  const preferredY = Math.max(1, Math.min(maxY, Math.round(anchor.y - ((basePlacement.height - 1) / 2))));
  const preferredPlacement = { ...basePlacement, x: preferredX, y: preferredY };
  if (isActorInventoryPlacementAvailable(actor, parentId, preferredPlacement, excludeItemIds, [])) return preferredPlacement;

  const candidates = [];
  for (let y = 1; y <= maxY; y += 1) {
    for (let x = 1; x <= maxX; x += 1) {
      if (x === preferredX && y === preferredY) continue;
      const placement = { ...basePlacement, x, y };
      const centerX = x + ((placement.width - 1) / 2);
      const centerY = y + ((placement.height - 1) / 2);
      candidates.push({
        placement,
        distance: ((centerX - anchor.x) ** 2) + ((centerY - anchor.y) ** 2)
      });
    }
  }

  candidates.sort((left, right) => (
    (left.distance - right.distance)
    || (left.placement.y - right.placement.y)
    || (left.placement.x - right.placement.x)
  ));
  return candidates.find(candidate => (
    isActorInventoryPlacementAvailable(actor, parentId, candidate.placement, excludeItemIds, [])
  ))?.placement ?? null;
}

function getSearchInventoryGridPointerPosition(event = null, grid = null, actor = null, parentId = ROOT_CONTAINER_ID) {
  const clientX = Number(event?.clientX);
  const clientY = Number(event?.clientY);
  if (!grid || !actor || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;

  const gridRect = grid.getBoundingClientRect();
  if (clientX < gridRect.left || clientX > gridRect.right || clientY < gridRect.top || clientY > gridRect.bottom) return null;

  const firstCell = grid.querySelector('[data-inventory-cell][data-x="1"][data-y="1"]') ?? grid.querySelector("[data-inventory-cell]");
  if (!firstCell) return null;
  const firstRect = firstCell.getBoundingClientRect();
  const secondColumnRect = grid.querySelector('[data-inventory-cell][data-y="1"][data-x="2"]')?.getBoundingClientRect();
  const secondRowRect = grid.querySelector('[data-inventory-cell][data-x="1"][data-y="2"]')?.getBoundingClientRect();
  const pitchX = secondColumnRect ? Math.max(1, secondColumnRect.left - firstRect.left) : Math.max(1, firstRect.width);
  const pitchY = secondRowRect ? Math.max(1, secondRowRect.top - firstRect.top) : Math.max(1, firstRect.height);
  const firstCenterX = firstRect.left + (firstRect.width / 2);
  const firstCenterY = firstRect.top + (firstRect.height / 2);
  const dimensions = getActorInventoryContextDimensions(actor, parentId);

  return {
    x: Math.max(1, Math.min(dimensions.columns, ((clientX - firstCenterX) / pitchX) + 1)),
    y: Math.max(1, Math.min(dimensions.rows, ((clientY - firstCenterY) / pitchY) + 1))
  };
}

function resolveActorPlacement(actor, itemData, placement = {}, excludeItemIds = [], reservedPlacements = [], parentId = ROOT_CONTAINER_ID) {
  if (placement.mode === "equipment") return resolveActorEquipmentPlacement(actor, itemData, placement, excludeItemIds);
  if (placement.mode === "weapon") return resolveActorWeaponPlacement(actor, itemData, placement, excludeItemIds);

  const normalizedPlacement = normalizeInventoryPlacement(placement, itemData, actor.items);
  return isActorInventoryPlacementAvailable(actor, parentId, normalizedPlacement, excludeItemIds, reservedPlacements)
    ? normalizedPlacement
    : null;
}

function resolveActorEquipmentPlacement(actor, itemData, placement = {}, excludeItemIds = []) {
  const race = getActorRace(actor);
  const selectedSlots = getRaceEquipmentSlotsForItem(race, itemData);
  const targetSlot = placement.equipmentSlot
    ? selectedSlots.find(slot => slot.key === placement.equipmentSlot)
    : selectedSlots[0];
  if (!targetSlot) return null;

  const blocked = selectedSlots.some(slot => Boolean(getEquipmentItemForActorSlot(actor, slot, excludeItemIds)));
  if (blocked) return null;

  const footprint = getItemFootprint(itemData);
  return {
    ...placement,
    mode: "equipment",
    equipmentSlot: targetSlot.key,
    weaponSet: "",
    weaponSlot: "",
    width: footprint.width,
    height: footprint.height
  };
}

function resolveActorWeaponPlacement(actor, itemData, placement = {}, excludeItemIds = []) {
  const requiredSlotKeys = getActorWeaponPlacementSlotKeys(actor, itemData, placement);
  if (!requiredSlotKeys.length) return null;

  const blocked = requiredSlotKeys.some(slotKey => Boolean(getWeaponItemForActorSlot(
    actor,
    placement.weaponSet,
    slotKey,
    excludeItemIds
  )));
  if (blocked) return null;

  const footprint = getItemFootprint(itemData);
  return {
    ...placement,
    mode: "weapon",
    equipmentSlot: "",
    width: footprint.width,
    height: footprint.height
  };
}

function getActorWeaponPlacementSlotKeys(actor, itemData, placement = {}) {
  const race = getActorRace(actor);
  const setKey = String(placement.weaponSet ?? "");
  const primarySlotKey = String(placement.weaponSlot ?? "");
  if (!setKey || !primarySlotKey) return [];

  if (isContainerWeaponSetKey(setKey)) {
    const inventory = prepareInventoryContext(actor, race);
    const set = (inventory.weaponSets ?? []).find(entry => entry.key === setKey);
    const slots = set?.slots ?? [];
    const primaryIndex = slots.findIndex(slot => slot.key === primarySlotKey);
    if (primaryIndex < 0) return [];
    const size = getWeaponSlotRequirementSize(itemData);
    const requiredSlots = slots.slice(primaryIndex, primaryIndex + size);
    return requiredSlots.length === size ? requiredSlots.map(slot => slot.key) : [];
  }

  if (!canUseWeaponSlotForItem(race, itemData, setKey, primarySlotKey)) return [];
  return getRequiredWeaponSlotsForItem(race, itemData, setKey, primarySlotKey).map(slot => slot.key);
}

function getQuickTransferTargetParentId({ sourceActor, targetActor, sourceItem } = {}) {
  if (!sourceActor || !targetActor || !sourceItem) return null;
  const candidateParentIds = getQuickTransferParentCandidates(targetActor);
  for (const parentId of candidateParentIds) {
    if (!canQuickTransferItemIntoParent({ sourceActor, targetActor, sourceItem, parentId })) continue;
    return parentId;
  }
  return null;
}

function getQuickTransferParentCandidates(actor) {
  const parentIds = [ROOT_CONTAINER_ID];
  const inventory = prepareInventoryContext(actor, getActorRace(actor));
  for (const container of inventory.containers ?? []) {
    const id = String(container?.id ?? "");
    if (!id || parentIds.includes(id)) continue;
    parentIds.push(id);
  }
  return parentIds;
}

function canQuickTransferItemIntoParent({ sourceActor, targetActor, sourceItem, parentId = ROOT_CONTAINER_ID } = {}) {
  const itemData = sourceItem?.toObject?.();
  if (!itemData) return false;
  if (parentId && !targetActor.items?.get(parentId)) return false;

  if (sourceActor.uuid === targetActor.uuid) {
    if (parentId === sourceItem.id) return false;
    if (getAllContainedItems(sourceItem.id, sourceActor.items).some(item => item.id === parentId)) return false;
  }

  const excludeItemIds = sourceActor.uuid === targetActor.uuid ? [sourceItem.id] : [];
  const stackRoom = isContainerItem(itemData)
    ? 0
    : findCompatibleStackTargets(targetActor, itemData, null, excludeItemIds, parentId).reduce((total, target) => (
      total + Math.max(0, getItemMaxStack(target) - getItemQuantity(target))
    ), 0);
  const quantity = Math.max(1, getItemQuantity(sourceItem));
  const placement = getFirstAvailableActorInventoryPlacement(targetActor, parentId, itemData, excludeItemIds, []);
  if (!placement && stackRoom < quantity) return false;

  if (!parentId) return true;
  const container = targetActor.items?.get(parentId);
  const currentLoad = getContainerContentsWeight(container, targetActor.items);
  const addedLoad = getItemTotalWeight(sourceItem, sourceActor.items);
  return currentLoad + addedLoad <= getContainerMaxLoad(container) + 0.0001;
}

function getEquipmentItemForActorSlot(actor, slot, excludeItemIds = []) {
  const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
  const slotSelectionKey = getEquipmentSlotSelectionKey(slot.label);
  return actor.items?.contents?.find(item => {
    if (excluded.has(item.id)) return false;
    if (item.system?.placement?.mode !== "equipment") return false;
    return getSelectedEquipmentSlotKeys(item).has(slotSelectionKey);
  }) ?? null;
}

function getWeaponItemForActorSlot(actor, setKey = "", slotKey = "", excludeItemIds = []) {
  const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
  const inventory = prepareInventoryContext(actor, getActorRace(actor));
  const set = (inventory.weaponSets ?? []).find(entry => entry.key === setKey);
  const slot = (set?.slots ?? []).find(entry => entry.key === slotKey);
  const itemId = String(slot?.item?.id ?? "");
  return itemId && !excluded.has(itemId) ? actor.items?.get(itemId) ?? null : null;
}

function getActorRace(actor) {
  return getCreatureOptions().races.find(entry => entry.id === actor?.system?.creature?.raceId) ?? null;
}

function createInventoryStackData(itemData, quantity, parentId, placement, { equipped = false } = {}) {
  const createData = foundry.utils.deepClone(itemData);
  delete createData._id;
  delete createData.id;
  const storedPlacement = createStoredPlacement(placement, itemData);
  foundry.utils.mergeObject(createData, {
    system: {
      quantity,
      equipped: Boolean(equipped),
      container: {
        parentId
      },
      placement: {
        mode: storedPlacement.mode,
        equipmentSlot: storedPlacement.equipmentSlot,
        weaponSet: storedPlacement.weaponSet,
        weaponSlot: storedPlacement.weaponSlot,
        x: storedPlacement.x,
        y: storedPlacement.y,
        width: storedPlacement.width,
        height: storedPlacement.height
      }
    }
  });
  return createData;
}

function createInventoryItemUpdate(itemId, quantity, parentId, placement, itemData) {
  return createPlacementItemUpdate(itemId, quantity, parentId, placement, itemData, { equipped: false });
}

function createPlacementItemUpdate(itemId, quantity, parentId, placement, itemData, { equipped = false } = {}) {
  const storedPlacement = createStoredPlacement(placement, itemData);
  return {
    _id: itemId,
    "system.quantity": quantity,
    "system.equipped": Boolean(equipped),
    "system.container.parentId": parentId,
    "system.placement.mode": storedPlacement.mode,
    "system.placement.equipmentSlot": storedPlacement.equipmentSlot,
    "system.placement.weaponSet": storedPlacement.weaponSet,
    "system.placement.weaponSlot": storedPlacement.weaponSlot,
    "system.placement.x": storedPlacement.x,
    "system.placement.y": storedPlacement.y,
    "system.placement.width": storedPlacement.width,
    "system.placement.height": storedPlacement.height
  };
}

function getFirstAvailableActorInventoryPlacement(actor, parentId, itemData, excludeItemIds = [], reservedPlacements = []) {
  const dimensions = getActorInventoryContextDimensions(actor, parentId);
  return findFirstAvailableInventoryPlacement(
    getContextInventoryItems(parentId, actor.items),
    dimensions.columns,
    dimensions.rows,
    itemData,
    actor.items,
    excludeItemIds,
    reservedPlacements
  );
}

function isActorInventoryPlacementAvailable(actor, parentId, placement, excludeItemIds = [], reservedPlacements = []) {
  const dimensions = getActorInventoryContextDimensions(actor, parentId);
  return isInventoryPlacementAvailable(
    placement,
    getContextInventoryItems(parentId, actor.items),
    dimensions.columns,
    dimensions.rows,
    actor.items,
    excludeItemIds,
    reservedPlacements
  );
}

function getActorInventoryContextDimensions(actor, parentId = ROOT_CONTAINER_ID) {
  if (parentId) return getContainerDimensions(actor.items?.get(parentId));
  const race = getCreatureOptions().races.find(entry => entry.id === actor.system?.creature?.raceId);
  const inventorySize = race?.inventorySize ?? createDefaultInventorySize();
  return {
    columns: Math.max(1, toInteger(inventorySize.columns) || createDefaultInventorySize().columns),
    rows: Math.max(1, toInteger(inventorySize.rows) || createDefaultInventorySize().rows)
  };
}

function validateTargetParent(actor, parentId = ROOT_CONTAINER_ID) {
  if (!parentId) return;
  const parent = actor.items?.get(parentId);
  if (!parent || !isContainerItem(parent)) throw new Error("Invalid target container.");
}

function validateActorProjectedInventoryState(actor, { updates = [], deletes = [], creates = [] } = {}) {
  const projectedItems = projectActorInventoryState(actor, { updates, deletes, creates });
  const validation = validateInventoryTree(projectedItems, getActorInventoryContextDimensions(actor, ROOT_CONTAINER_ID));
  if (validation.valid) {
    const loadValidation = validateActorLoadLimit(actor, projectedItems);
    if (loadValidation.valid) return true;
    throw new Error(getActorLoadLimitExceededMessage());
  }
  if (validation.reason === "recursive") throw new Error(game.i18n.localize("FALLOUTMAW.Messages.ContainerRecursiveError"));
  if (validation.reason === "max-load") throw new Error(game.i18n.localize("FALLOUTMAW.Messages.ContainerMaxLoadExceeded"));
  return false;
}

function projectActorInventoryState(actor, { updates = [], deletes = [], creates = [] } = {}) {
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

function areStackable(sourceData, targetItem) {
  const sourceSystem = sourceData?.system ?? {};
  const targetSystem = targetItem?.system ?? {};
  return (
    sourceData?.type === targetItem?.type
    && !isContainerItem(sourceData)
    && !isContainerItem(targetItem)
    && sourceData?.name === targetItem?.name
    && sourceData?.img === targetItem?.img
    && Number(sourceSystem.weight) === Number(targetSystem.weight)
    && Number(sourceSystem.price) === Number(targetSystem.price)
    && String(sourceSystem.priceCurrency ?? "") === String(targetSystem.priceCurrency ?? "")
    && getItemMaxStack(sourceSystem) === getItemMaxStack(targetSystem)
    && getItemFootprint(sourceSystem).width === getItemFootprint(targetSystem).width
    && getItemFootprint(sourceSystem).height === getItemFootprint(targetSystem).height
    && serializeSet(getSelectedEquipmentSlotKeys(sourceSystem)) === serializeSet(getSelectedEquipmentSlotKeys(targetSystem))
    && serializeWeaponSlotRequirement(sourceSystem) === serializeWeaponSlotRequirement(targetSystem)
    && JSON.stringify(sourceSystem.functions ?? {}) === JSON.stringify(targetSystem.functions ?? {})
  );
}

function serializeSet(set) {
  return Array.from(set).sort().join("|");
}

function serializeWeaponSlotRequirement(system = {}) {
  const requirement = getWeaponSlotRequirement(system);
  return `${requirement.mode}:${serializeSet(requirement.selectedKeys)}`;
}

function validateActorLoadLimit(actor, projectedItems = []) {
  const limit = getActorLoadLimit(actor);
  if (limit <= 0) return { valid: true };

  const currentLoad = Number(actor?.system?.load?.value) || calculateActorLoad(actor?.items?.contents ?? []);
  const projectedLoad = calculateActorLoad(projectedItems);
  if (projectedLoad <= (limit + 0.0001)) return { valid: true };
  if (projectedLoad <= (currentLoad + 0.0001)) return { valid: true };
  return { valid: false, reason: "actor-load-limit", value: projectedLoad, limit };
}

function getActorLoadLimit(actor) {
  const preparedLimit = Number(actor?.system?.load?.limit) || 0;
  if (preparedLimit > 0) return preparedLimit;
  const max = Number(actor?.system?.load?.max) || 0;
  if (max <= 0) return 0;
  const race = getCreatureOptions().races.find(entry => entry.id === actor?.system?.creature?.raceId) ?? null;
  const percent = Math.max(0, Number(race?.baseParameters?.loadLimitPercent) || 0);
  return percent > 0 ? (max * percent) / 100 : 0;
}

function calculateActorLoad(items = []) {
  const itemList = Array.isArray(items) ? items : Array.from(items ?? []);
  return Number(itemList.reduce((total, item) => (
    getItemContainerParentId(item)
      ? total
      : total + (Number(getItemActorLoadWeight(item, itemList)) || 0)
  ), 0).toFixed(1));
}

function getActorLoadLimitExceededMessage() {
  const key = "FALLOUTMAW.Messages.ActorLoadLimitExceeded";
  const localized = game.i18n.localize(key);
  return localized === key ? "Актер не может нести такой вес." : localized;
}

function throwInventoryNoSpace() {
  throw new Error(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));
}

function getDropZoneParentId(zone) {
  return String(zone?.dataset?.inventoryParentId ?? zone?.dataset?.containerId ?? ROOT_CONTAINER_ID);
}

function setWeaponSlotImageAspect(image) {
  const width = Number(image?.naturalWidth);
  const height = Number(image?.naturalHeight);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
  const slot = image.closest(".fallout-maw-weapon-slot");
  if (!slot) return;
  slot.style.setProperty("--fallout-maw-weapon-slot-image-aspect", String(Math.max(1, width / height)));
}

function getDropZonePlacementRequest(zone) {
  if (zone?.dataset?.equipmentSlot) {
    return {
      mode: "equipment",
      equipmentSlot: String(zone.dataset.equipmentSlot ?? ""),
      weaponSet: "",
      weaponSlot: ""
    };
  }
  if (zone?.dataset?.weaponSet && zone?.dataset?.weaponSlot) {
    return {
      mode: "weapon",
      equipmentSlot: "",
      weaponSet: String(zone.dataset.weaponSet ?? ""),
      weaponSlot: String(zone.dataset.weaponSlot ?? "")
    };
  }
  return {
    mode: "inventory",
    equipmentSlot: "",
    weaponSet: "",
    weaponSlot: ""
  };
}

function canModifySearchTransferDirectly(sourceActor, targetActor) {
  return Boolean(game.user?.isGM || (
    sourceActor?.testUserPermission?.(game.user, "OWNER")
    && targetActor?.testUserPermission?.(game.user, "OWNER")
  ));
}

async function requestSearchInventorySocket(action, payload = {}, gm = getResponsibleGM()) {
  if (!gm) throw new Error("Нет активного GM для обыска.");
  const requestId = foundry.utils.randomID();
  const requesterUserId = game.user?.id ?? "";

  const promise = new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingSearchInventorySocketRequests.delete(requestId);
      reject(new Error("GM did not answer search inventory request."));
    }, SEARCH_INVENTORY_SOCKET_TIMEOUT);
    pendingSearchInventorySocketRequests.set(requestId, { resolve, reject, timeout });
  });

  game.socket.emit(SEARCH_INVENTORY_SOCKET, {
    scope: SEARCH_INVENTORY_SOCKET_SCOPE,
    type: "request",
    action,
    requestId,
    requesterUserId,
    gmUserId: gm.id,
    payload
  });
  return promise;
}

async function handleSearchInventorySocketMessage(message = {}) {
  if (message?.scope !== SEARCH_INVENTORY_SOCKET_SCOPE) return;

  if (message.type === "response") {
    if (message.recipientUserId && message.recipientUserId !== game.user?.id) return;
    const pending = pendingSearchInventorySocketRequests.get(message.requestId);
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    pendingSearchInventorySocketRequests.delete(message.requestId);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error || "Search inventory socket request failed."));
    return;
  }

  if (message.type !== "request") return;
  if (!game.user?.isGM || message.gmUserId !== game.user.id) return;

  try {
    let result;
    if (message.action === "transferItem") {
      result = await performSearchInventoryTransfer(message.payload ?? {}, message.requesterUserId ?? "");
    } else if (message.action === "transferCurrency") {
      result = await performSearchCurrencyTransfer(message.payload ?? {}, message.requesterUserId ?? "");
    }
    game.socket.emit(SEARCH_INVENTORY_SOCKET, {
      scope: SEARCH_INVENTORY_SOCKET_SCOPE,
      type: "response",
      requestId: message.requestId,
      recipientUserId: message.requesterUserId,
      ok: true,
      result
    });
  } catch (error) {
    console.error(`${SYSTEM_ID} | Search inventory socket request failed`, error);
    game.socket.emit(SEARCH_INVENTORY_SOCKET, {
      scope: SEARCH_INVENTORY_SOCKET_SCOPE,
      type: "response",
      requestId: message.requestId,
      recipientUserId: message.requesterUserId,
      ok: false,
      error: error.message
    });
  }
}

function getResponsibleGM() {
  return (game.users?.contents ?? [])
    .filter(user => user.active && user.isGM)
    .sort((left, right) => left.id.localeCompare(right.id))
    .at(0) ?? null;
}

async function resolveActor(uuid) {
  const document = uuid ? await fromUuid(String(uuid)) : null;
  return document instanceof Actor ? document : null;
}
