import { TEMPLATES } from "../constants.mjs";
import { getCreatureOptions } from "../settings/accessors.mjs";
import { createDefaultInventorySize } from "../settings/creature-options.mjs";
import {
  buildInventoryCellStyle,
  createAnchoredItemStackPartsForQuantity,
  createItemStackPartAdditionUpdate,
  createItemStackPartMergeUpdate,
  createItemStackPartPlacementUpdate,
  createItemStackPartRemovalUpdate,
  createItemStackPartSplitUpdate,
  createStoredPlacement,
  createInventoryPlacement,
  findFirstAvailableInventoryPlacement,
  getContainerContentsWeight,
  getContainerInventoryGridOptions,
  getContainerMaxLoad,
  getContextInventoryItems,
  getItemContainerParentId,
  getItemMaxStack,
  getItemQuantity,
  getItemStackAdditionOverflowQuantity,
  getItemStackPartQuantity,
  getItemTotalWeight,
  isContainerItem,
  isInventoryPlacementAvailable,
  normalizeInventoryPlacement,
  placementContainsInventoryCell,
  prepareInventoryGridContext,
  resetInventoryHoverCheckerCache,
  usesVirtualInventoryStacks,
  validateInventoryTree
} from "../utils/inventory-containers.mjs";
import {
  applyInventoryDragRotation,
  canShowInventoryRotateAction,
  createInventoryRotationUpdate,
  getInventoryRotationUnavailableLabel,
  resolveInventoryItemRotation
} from "../utils/inventory-rotation.mjs";
import { isItemBrokenByCondition } from "../utils/item-functions.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { grantActorInventoryItem } from "../utils/inventory-grants.mjs";
import { resolveWorldItemSync } from "../utils/world-items.mjs";
import { canUseActiveItem, useActiveItem } from "../items/active-item-use.mjs";
import { openItemInteractionDialog } from "../items/item-interaction-dialogs.mjs";
import {
  getItemInteractionState,
  resolveActorInteractionToken
} from "../items/item-interactions.mjs";
import {
  clearInventoryPlacementPreviews,
  clearInventoryVirtualCells,
  getInventoryGridPointerPosition as getInventoryGridPointerPositionFromElement,
  renderInventoryPlacementPreview,
  syncInventoryVirtualCell
} from "../utils/inventory-grid-dom.mjs";
import {
  preserveTextSelectionBeforePartSync,
  restoreTextSelectionAfterPartSync
} from "../utils/application-focus-state.mjs";

const { ItemSheetV2 } = foundry.applications.sheets;
const { DialogV2, HandlebarsApplicationMixin } = foundry.applications.api;
const { FormDataExtended } = foundry.applications.ux;

export class FalloutMaWContainerSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
  #draggedItemData = null;
  #draggedItemId = "";
  #hoverPreviewInputKey = "";
  #hoverPreviewKey = "";
  #dragDrop = null;

  static DEFAULT_OPTIONS = {
    classes: ["fallout-maw", "fallout-maw-sheet", "fallout-maw-container-sheet", "sheet", "item"],
    position: {
      width: 620,
      height: "auto"
    },
    form: {
      submitOnChange: true
    },
    window: {
      resizable: true
    }
  };

  static PARTS = {
    body: {
      template: TEMPLATES.containerSheet
    }
  };

  get item() {
    return this.document;
  }

  _preSyncPartState(partId, newElement, priorElement, state) {
    super._preSyncPartState(partId, newElement, priorElement, state);
    preserveTextSelectionBeforePartSync(priorElement, state);
  }

  _syncPartState(partId, newElement, priorElement, state) {
    super._syncPartState(partId, newElement, priorElement, state);
    restoreTextSelectionAfterPartSync(newElement, state);
  }

  get actor() {
    return this.item.actor;
  }

  get _dragDrop() {
    return this.#dragDrop ??= new foundry.applications.ux.DragDrop.implementation({
      dragSelector: ".draggable",
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

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const actor = this.actor;
    const allItems = actor?.items?.contents ?? [];
    const actorInteractionToken = resolveActorInteractionToken(actor);
    const dimensions = getContainerInventoryGridOptions(this.item);
    const grid = prepareInventoryGridContext(
      getContextInventoryItems(this.item.id, allItems),
      dimensions.columns,
      dimensions.rows,
      allItems,
      (item, placement) => ({
        ...createInventoryItemData(item, allItems, placement, { actor, token: actorInteractionToken }),
        gridStyle: buildInventoryCellStyle(placement.x, placement.y, placement)
      }),
      dimensions
    );

    return foundry.utils.mergeObject(context, {
      actor,
      item: this.item,
      system: this.item.system,
      sourceSystem: this.item.system?._source ?? this.item.system,
      owner: this.item.isOwner,
      editable: this.isEditable,
      grid,
      load: {
        value: formatWeight(getContainerContentsWeight(this.item, allItems)),
        max: formatWeight(getContainerMaxLoad(this.item))
      }
    }, { inplace: false });
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#hoverPreviewKey = "";
    this.element?.querySelectorAll("[data-item-id]").forEach(element => {
      element.addEventListener("contextmenu", event => this.#onItemContextMenu(event));
    });
  }

  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    if (this.actor) this.actor.apps[this.id] = this;
  }

  _onClose(options) {
    super._onClose(options);
    if (this.actor) delete this.actor.apps[this.id];
    this.#draggedItemData = null;
    this.#draggedItemId = "";
    this.#clearInventoryDropPreview();
  }

  async _onDragStart(event) {
    const itemId = event.currentTarget?.dataset?.itemId ?? "";
    const item = this.actor?.items?.get(itemId);
    if (!item) return;
    const stackIndex = Math.max(0, toInteger(event.currentTarget?.dataset?.stackIndex));
    const stackQuantity = Math.max(0, toInteger(event.currentTarget?.dataset?.stackQuantity));
    resetInventoryHoverCheckerCache();
    this.#draggedItemId = item.id;
    this.#draggedItemData = item.toObject();
    if (usesVirtualInventoryStacks(item)) {
      foundry.utils.setProperty(this.#draggedItemData, "system.quantity", stackQuantity || getItemStackPartQuantity(item, stackIndex));
    }
    const dragData = item.toDragData();
    dragData.itemId = item.id;
    dragData.stackIndex = stackIndex;
    dragData.stackQuantity = stackQuantity || (usesVirtualInventoryStacks(item) ? getItemStackPartQuantity(item, stackIndex) : getItemQuantity(item));
    event.dataTransfer?.setData("text/plain", JSON.stringify(dragData));
    event.currentTarget?.classList?.add("dragging");
  }

  _onDragOver(event) {
    const zone = this.#getDropZone(event);
    if (!zone) return;
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    this.#draggedItemData = this.#getPreviewItemData(event);
    this.#setInventoryHoverPreview(zone);
  }

  _onDragEnd() {
    this.#draggedItemData = null;
    this.#draggedItemId = "";
    this.#clearInventoryDropPreview();
    this.#clearInventoryDraggingState();
  }

  async _onDrop(event) {
    const data = this.#getDragEventData(event);
    this.#draggedItemData = null;
    this.#draggedItemId = "";
    this.#clearInventoryDropPreview();
    if (data?.type !== "Item") return null;

    const dropped = await this.#getDroppedItemFromData(data);
    if (!dropped) return null;
    const sourceStackIndex = Math.max(0, toInteger(data.stackIndex));

    const zone = this.#getDropZone(event);
    const targetElement = getInventoryGridItemElementAtPointer(event, this.element)
      ?? zone?.closest?.("[data-inventory-grid-item][data-item-id]");
    const targetStackIndex = Math.max(0, toInteger(targetElement?.dataset?.stackIndex));
    const pointedTargetItem = targetElement
      ? this.actor.items.get(String(targetElement.dataset.itemId ?? "")) ?? null
      : null;
    if (
      dropped.item?.parent === this.actor
      && usesVirtualInventoryStacks(dropped.item)
      && targetElement?.dataset?.itemId === dropped.item.id
      && targetStackIndex !== sourceStackIndex
    ) {
      const updateData = createItemStackPartMergeUpdate(dropped.item, sourceStackIndex, targetStackIndex, getItemQuantity(dropped.itemData));
      if (!updateData) return null;
      if (!this.#validateProjectedInventoryState({ updates: [updateData] })) return null;
      await this.actor.updateEmbeddedDocuments("Item", [updateData]);
      return this.actor.items.get(dropped.item.id) ?? null;
    }
    const targetItem = (
      pointedTargetItem
      && pointedTargetItem.id !== dropped.item?.id
      && getItemContainerParentId(pointedTargetItem) === this.item.id
    )
      ? pointedTargetItem
      : this.#getTargetStackItem(zone, dropped.item?.id ?? "");
    if (this.#canStackDroppedItem(dropped.itemData, targetItem)) {
      const quantity = await this.#getDroppedStackQuantity(dropped, targetItem, event, { targetStackIndex });
      if (!quantity) return null;
      return this.#stackDroppedItemQuantity(dropped.item, dropped.itemData, targetItem, quantity, { sourceStackIndex, targetStackIndex });
    }

    let placement = this.#getPlacementForDropZone(zone, dropped.itemData, [dropped.item?.id ?? ""]);
    if (!placement) return null;
    if (targetItem && !this.#areStackable(dropped.itemData, targetItem)) {
      placement = this.#getFirstAvailableInventoryPlacement(dropped.itemData, [dropped.item?.id ?? ""]);
      if (!placement) {
        this.#warnValidation({ reason: "no-space" });
        return null;
      }
    }

    if (dropped.item?.parent === this.actor) {
      return this.#moveOwnedItem(dropped.item, placement, targetItem, { sourceStackIndex });
    }

    return this.#createOrStackDroppedItem(dropped.itemData, placement, targetItem);
  }

  #getDropZone(eventOrTarget) {
    const target = eventOrTarget?.target ?? eventOrTarget;
    const pointedCell = this.#getInventoryCellAtPointer(eventOrTarget, target);
    if (pointedCell) return pointedCell;

    const targetItem = target?.closest?.("[data-inventory-grid-item][data-item-id]");
    if (targetItem && this.element?.contains(targetItem)) return targetItem;
    const cell = target?.closest?.("[data-inventory-cell]");
    if (cell) return cell;
    return target?.closest?.("[data-container-drop-surface]") ?? null;
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

    const pointer = this.#getInventoryGridPointerPosition(eventOrTarget, grid);
    if (!pointer) return null;
    return syncInventoryVirtualCell(grid, pointer);
  }

  #getInventoryGridPointerPosition(event, grid) {
    return getInventoryGridPointerPositionFromElement(event, grid);
  }

  async #getDroppedItemFromData(data) {
    if (data?.type !== "Item") return null;

    const ownedItem = data.itemId ? this.actor?.items?.get(data.itemId) : null;
    if (ownedItem) {
      const itemData = ownedItem.toObject();
      if (usesVirtualInventoryStacks(ownedItem)) {
        foundry.utils.setProperty(itemData, "system.quantity", Math.max(1, toInteger(data.stackQuantity) || getItemStackPartQuantity(ownedItem, Math.max(0, toInteger(data.stackIndex)))));
      }
      return { item: ownedItem, itemData: applyInventoryDragRotation(itemData, data) };
    }

    const item = data.uuid ? resolveWorldItemSync(data.uuid) : null;
    if (!(item instanceof Item)) return null;
    const itemData = item.toObject();
    if (usesVirtualInventoryStacks(item)) {
      foundry.utils.setProperty(itemData, "system.quantity", Math.max(1, toInteger(data.stackQuantity) || getItemStackPartQuantity(item, Math.max(0, toInteger(data.stackIndex)))));
    }
    return { item, itemData: applyInventoryDragRotation(itemData, data) };
  }

  #getPreviewItemData(event) {
    const data = this.#getDragEventData(event);
    if (data?.type !== "Item") return null;
    if (this.#draggedItemData) return applyInventoryDragRotation(this.#draggedItemData, data);

    const ownedItem = data.itemId ? this.actor?.items?.get(data.itemId) : null;
    if (ownedItem) {
      this.#draggedItemId = ownedItem.id;
      const itemData = ownedItem.toObject();
      if (usesVirtualInventoryStacks(ownedItem)) {
        foundry.utils.setProperty(itemData, "system.quantity", Math.max(1, toInteger(data.stackQuantity) || getItemStackPartQuantity(ownedItem, Math.max(0, toInteger(data.stackIndex)))));
      }
      return applyInventoryDragRotation(itemData, data);
    }

    const droppedDocument = data.uuid ? resolveWorldItemSync(data.uuid) : null;
    if (droppedDocument instanceof Item) {
      const itemData = droppedDocument.toObject();
      if (usesVirtualInventoryStacks(droppedDocument)) {
        foundry.utils.setProperty(itemData, "system.quantity", Math.max(1, toInteger(data.stackQuantity) || getItemStackPartQuantity(droppedDocument, Math.max(0, toInteger(data.stackIndex)))));
      }
      return applyInventoryDragRotation(itemData, data);
    }
    return null;
  }

  #getDragEventData(event) {
    const cachedPayload = CONFIG.ux.DragDrop?.getPayload?.();
    if (cachedPayload && (typeof cachedPayload === "object")) return cachedPayload;

    try {
      const textEditor = foundry.applications.ux.TextEditor?.implementation ?? globalThis.TextEditor?.implementation ?? globalThis.TextEditor;
      const data = textEditor.getDragEventData(event);
      if (data && (typeof data === "object")) return data;
    } catch (_error) {
      // Fall through.
    }

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

  #getPlacementForDropZone(zone, itemData = null, excludeItemIds = []) {
    if (zone?.dataset.inventoryCell !== undefined) {
      return createInventoryPlacement(toInteger(zone.dataset.x), toInteger(zone.dataset.y), itemData, this.actor.items);
    }
    return this.#getFirstAvailableInventoryPlacement(itemData, excludeItemIds);
  }

  #getFirstAvailableInventoryPlacement(itemData = null, excludeItemIds = [], reservedPlacements = []) {
    const { columns, rows } = getContainerInventoryGridOptions(this.item);
    return findFirstAvailableInventoryPlacement(
      getContextInventoryItems(this.item.id, this.actor.items),
      columns,
      rows,
      itemData,
      this.actor.items,
      excludeItemIds,
      reservedPlacements,
      getContainerInventoryGridOptions(this.item)
    );
  }

  #isInventoryPlacementAvailable(placement, excludeItemIds = [], reservedPlacements = []) {
    const { columns, rows } = getContainerInventoryGridOptions(this.item);
    return isInventoryPlacementAvailable(
      placement,
      getContextInventoryItems(this.item.id, this.actor.items),
      columns,
      rows,
      this.actor.items,
      excludeItemIds,
      reservedPlacements,
      getContainerInventoryGridOptions(this.item)
    );
  }

  #getTargetStackItem(target, sourceItemId = "") {
    const itemElement = target?.closest?.("[data-item-id]");
    if (itemElement && (itemElement.dataset.itemId !== sourceItemId)) {
      return this.actor.items.get(itemElement.dataset.itemId) ?? null;
    }

    const cell = target?.closest?.("[data-inventory-cell]");
    if (!cell) return null;
    const x = toInteger(cell.dataset.x);
    const y = toInteger(cell.dataset.y);
    return getContextInventoryItems(this.item.id, this.actor.items).find(item => {
      if (item.id === sourceItemId) return false;
      const placement = normalizeInventoryPlacement(item.system?.placement ?? {}, item, this.actor.items);
      return placementContainsInventoryCell(placement, x, y);
    }) ?? null;
  }

  #onInventoryDragLeave(event) {
    const zone = event.target?.closest?.("[data-inventory-cell], [data-container-drop-surface]");
    if (!zone) return;

    const hoveredElement = document.elementFromPoint(event.clientX, event.clientY);
    const hoveredZone = hoveredElement?.closest?.("[data-inventory-cell], [data-container-drop-surface]") ?? null;
    if (hoveredZone === zone) return;

    if (hoveredElement && this.element?.contains(hoveredElement)) {
      this.#clearInventoryHoverPreview();
      return;
    }

    this.#clearInventoryDropPreview();
  }

  #setInventoryHoverPreview(zone = null) {
    if (!zone) {
      this.#clearInventoryHoverPreview();
      return;
    }
    if (zone.dataset.inventoryCell !== undefined || zone.dataset.inventoryGridItem !== undefined) {
      this.#setInventoryCellHoverPreview(zone);
      return;
    }
    this.#clearInventoryHoverPreview();
  }

  #setInventoryCellHoverPreview(zone) {
    if (!this.#draggedItemData) {
      this.#applySingleZonePreview(zone, `cell:${zone.dataset.x ?? ""}:${zone.dataset.y ?? ""}`);
      return;
    }

    const inputKey = `cell:${zone.dataset.x ?? ""}:${zone.dataset.y ?? ""}:${this.#draggedItemId}:${Boolean(this.#draggedItemData?.system?.placement?.rotated)}`;
    if (this.#hoverPreviewInputKey === inputKey) return;
    this.#hoverPreviewInputKey = inputKey;

    const sourceItemId = this.#draggedItemId || "";
    const targetItem = this.#getTargetStackItem(zone, sourceItemId);
    const targetHasStackRoom = targetItem
      && this.#areStackable(this.#draggedItemData, targetItem)
      && (getItemQuantity(targetItem) < getItemMaxStack(targetItem));
    if (targetHasStackRoom) {
      this.#applyInventoryStackPreview(targetItem);
      return;
    }

    const placement = createInventoryPlacement(
      toInteger(zone.dataset.x),
      toInteger(zone.dataset.y),
      this.#draggedItemData,
      this.actor.items
    );
    const excludeItemIds = sourceItemId ? [sourceItemId] : [];
    if (!this.#isInventoryPlacementAvailable(placement, excludeItemIds)) {
      this.#clearInventoryHoverPreview();
      return;
    }
    this.#applyInventoryPlacementPreview(placement);
  }

  #applySingleZonePreview(zone, key = "") {
    const previewKey = `single:${key}`;
    if (this.#hoverPreviewKey === previewKey) return;
    this.#clearInventoryHoverPreview();
    this.#hoverPreviewKey = previewKey;
    zone?.classList?.add("drop-preview");
  }

  #applyInventoryPlacementPreview(placement) {
    if (!placement) return;
    const previewKey = `placement:${placement.x}:${placement.y}:${placement.width}:${placement.height}:${Boolean(placement.rotated)}`;
    if (this.#hoverPreviewKey === previewKey) return;
    this.#clearInventoryHoverPreview();
    this.#hoverPreviewKey = previewKey;
    renderInventoryPlacementPreview(this.element?.querySelector("[data-inventory-grid]"), placement, {
      className: "drop-preview",
      kind: "placement"
    });
  }

  #applyInventoryStackPreview(targetItem) {
    if (!targetItem) return;
    const previewKey = `stack:${targetItem.id}:${getItemQuantity(targetItem)}:${getItemMaxStack(targetItem)}`;
    if (this.#hoverPreviewKey === previewKey) return;
    this.#clearInventoryHoverPreview();
    this.#hoverPreviewKey = previewKey;
    const escapedItemId = CSS.escape(targetItem.id);
    this.element?.querySelector(
      `[data-inventory-grid-item][data-item-id="${escapedItemId}"]`
    )?.classList.add("drop-stack-preview");

    const placement = normalizeInventoryPlacement(targetItem.system?.placement ?? {}, targetItem, this.actor.items);
    renderInventoryPlacementPreview(this.element?.querySelector("[data-inventory-grid]"), placement, {
      className: "drop-stack-preview",
      kind: "stack"
    });
  }

  #clearInventoryHoverPreview() {
    this.#hoverPreviewInputKey = "";
    this.#hoverPreviewKey = "";
    clearInventoryPlacementPreviews(this.element);
    this.element?.querySelectorAll(".drop-preview, .drop-stack-preview").forEach(element => {
      element.classList.remove("drop-preview", "drop-stack-preview");
    });
  }

  #clearInventoryDropPreview() {
    this.#clearInventoryHoverPreview();
    clearInventoryVirtualCells(this.element);
  }

  #clearInventoryDraggingState() {
    this.element?.querySelectorAll(".dragging").forEach(element => {
      element.classList.remove("dragging");
    });
  }

  async #moveOwnedItem(item, placement, targetItem = null, { sourceStackIndex = 0 } = {}) {
    const itemData = item.toObject();
    foundry.utils.setProperty(itemData, "system.placement.rotated", Boolean(placement.rotated));
    if (usesVirtualInventoryStacks(item)) {
      foundry.utils.setProperty(itemData, "system.quantity", getItemStackPartQuantity(item, sourceStackIndex));
    }
    return this.#insertItemIntoContainer(itemData, placement, { sourceItem: item, targetItem, sourceStackIndex });
  }

  #canStackDroppedItem(itemData, targetItem = null) {
    return Boolean(
      targetItem
      && this.#areStackable(itemData, targetItem)
      && (usesVirtualInventoryStacks(targetItem) || getItemQuantity(targetItem) < getItemMaxStack(targetItem))
    );
  }

  async #getDroppedStackQuantity(dropped, targetItem, _event, { targetStackIndex = null } = {}) {
    const sourceQuantity = Math.max(1, getItemQuantity(dropped?.itemData ?? dropped?.item));
    const availableSpace = usesVirtualInventoryStacks(targetItem)
      ? Math.max(0, getItemMaxStack(targetItem) - getItemStackPartQuantity(targetItem, targetStackIndex))
      : Math.max(0, getItemMaxStack(targetItem) - getItemQuantity(targetItem));
    const maxTransfer = Math.min(sourceQuantity, availableSpace);
    return maxTransfer > 0 ? maxTransfer : 0;
  }

  async #stackDroppedItemQuantity(sourceItem, itemData, targetItem, quantity, { sourceStackIndex = 0, targetStackIndex = null } = {}) {
    const transferQuantity = Math.max(1, toInteger(quantity));
    const sourceOwned = sourceItem?.parent === this.actor;
    const sourceQuantity = Math.max(1, getItemQuantity(usesVirtualInventoryStacks(itemData) ? itemData : (sourceOwned ? sourceItem : itemData)));
    const targetQuantity = getItemQuantity(targetItem);
    if (sourceOwned && usesVirtualInventoryStacks(sourceItem) && sourceItem.id === targetItem.id) return targetItem;
    const virtualTarget = usesVirtualInventoryStacks(targetItem);
    const virtualSource = sourceOwned && usesVirtualInventoryStacks(sourceItem);
    const availableSpace = virtualTarget ? Number.POSITIVE_INFINITY : Math.max(0, getItemMaxStack(targetItem) - targetQuantity);
    const appliedQuantity = Math.min(transferQuantity, sourceQuantity, availableSpace);
    if (!appliedQuantity) return null;

    const targetUpdate = virtualTarget
      ? createItemStackPartAdditionUpdate(targetItem, appliedQuantity, targetStackIndex)
      : {
          _id: targetItem.id,
          "system.quantity": targetQuantity + appliedQuantity
        };
    if (!targetUpdate) return null;
    const updates = [targetUpdate];
    const deletes = [];
    if (sourceOwned) {
      if (virtualSource) {
        const sourceUpdate = createItemStackPartRemovalUpdate(sourceItem, appliedQuantity, sourceStackIndex);
        if ((sourceUpdate?.["system.quantity"] ?? getItemQuantity(sourceItem)) <= 0) deletes.push(sourceItem.id);
        else if (sourceUpdate) updates.push(sourceUpdate);
      } else if (appliedQuantity >= sourceQuantity) deletes.push(sourceItem.id);
      else {
        updates.push({
          _id: sourceItem.id,
          "system.quantity": sourceQuantity - appliedQuantity
        });
      }
    }

    if (!this.#validateProjectedInventoryState({ updates, deletes })) return null;
    await this.actor.updateEmbeddedDocuments("Item", updates);
    if (deletes.length) await this.actor.deleteEmbeddedDocuments("Item", deletes);
    return this.actor.items.get(targetItem.id) ?? null;
  }

  async #createOrStackDroppedItem(itemData, placement, targetItem = null) {
    if (!itemData) return null;
    return this.#insertItemIntoContainer(itemData, placement, { targetItem });
  }

  async #insertItemIntoContainer(itemData, requestedPlacement, { sourceItem = null, targetItem = null, sourceStackIndex = 0 } = {}) {
    if (usesVirtualInventoryStacks(itemData)) {
      return this.#insertVirtualStackItemIntoContainer(itemData, requestedPlacement, { sourceItem, targetItem, sourceStackIndex });
    }

    const maxStack = getItemMaxStack(itemData);
    let remainingQuantity = Math.max(1, getItemQuantity(itemData));
    const excludedIds = [sourceItem?.id ?? ""].filter(Boolean);
    const preferredPlacement = normalizeInventoryPlacement(requestedPlacement, itemData, this.actor.items);
    const stackTargets = this.#getCompatibleStackTarget(itemData, targetItem, excludedIds);
    const targetUpdates = [];

    for (const stackTarget of stackTargets) {
      const availableSpace = Math.max(0, getItemMaxStack(stackTarget) - getItemQuantity(stackTarget));
      if (!availableSpace) continue;

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
      const sourcePlacement = this.#getSourcePlacement(sourceItem, itemData, targetItem ? null : preferredPlacement, targetItem, reservedPlacements);
      if (!sourcePlacement) {
        this.#warnValidation({ reason: "no-space" });
        return null;
      }

      const sourceQuantity = Math.min(remainingQuantity, maxStack);
      remainingQuantity -= sourceQuantity;
      reservedPlacements.push(sourcePlacement);
      const storedPlacement = createStoredPlacement(sourcePlacement, sourceItem);
      sourceUpdate = {
        _id: sourceItem.id,
        "system.quantity": sourceQuantity,
        "system.equipped": false,
        "system.container.parentId": this.item.id,
        "system.placement.mode": storedPlacement.mode,
        "system.placement.equipmentSlot": storedPlacement.equipmentSlot,
        "system.placement.weaponSet": storedPlacement.weaponSet,
        "system.placement.weaponSlot": storedPlacement.weaponSlot,
        "system.placement.x": storedPlacement.x,
        "system.placement.y": storedPlacement.y,
        "system.placement.width": storedPlacement.width,
        "system.placement.height": storedPlacement.height,
        "system.placement.rotated": storedPlacement.rotated
      };
      deleteSource = false;
    }

    let nextPlacement = this.#isInventoryPlacementAvailable(preferredPlacement, excludedIds, reservedPlacements)
      ? preferredPlacement
      : null;
    while (remainingQuantity > 0) {
      const stackQuantity = Math.min(remainingQuantity, maxStack);
      const placement = nextPlacement ?? this.#getFirstAvailableInventoryPlacement(itemData, excludedIds, reservedPlacements);
      if (!placement) {
        this.#warnValidation({ reason: "no-space" });
        return null;
      }

      createData.push(this.#createInventoryStackData(itemData, stackQuantity, placement));
      reservedPlacements.push(placement);
      remainingQuantity -= stackQuantity;
      nextPlacement = null;
    }

    if (!this.#validateProjectedInventoryState({
      updates: [...targetUpdates, ...(sourceUpdate ? [sourceUpdate] : [])],
      deletes: (!sourceUpdate && deleteSource && sourceItem) ? [sourceItem.id] : [],
      creates: createData
    })) return null;

    if (targetUpdates.length) await this.actor.updateEmbeddedDocuments("Item", targetUpdates);
    if (sourceUpdate) await this.actor.updateEmbeddedDocuments("Item", [sourceUpdate]);
    else if (deleteSource && sourceItem) await this.actor.deleteEmbeddedDocuments("Item", [sourceItem.id]);
    if (createData.length) return this.actor.createEmbeddedDocuments("Item", createData);
    if (sourceUpdate) return this.actor.items.get(sourceItem.id) ?? null;
    if (targetUpdates.length) return this.actor.items.get(targetUpdates[0]._id) ?? null;
    return null;
  }

  async #insertVirtualStackItemIntoContainer(itemData, requestedPlacement, { sourceItem = null, targetItem = null, sourceStackIndex = 0 } = {}) {
    const quantity = Math.max(1, getItemQuantity(itemData));
    const sourceOwned = sourceItem?.parent === this.actor;
    const preferredPlacement = normalizeInventoryPlacement(requestedPlacement, itemData, this.actor.items);
    if (sourceOwned && sourceItem && getItemContainerParentId(sourceItem) === this.item.id && (!targetItem || targetItem.id === sourceItem.id)) {
      const updateData = createItemStackPartPlacementUpdate(sourceItem, sourceStackIndex, preferredPlacement);
      if (!updateData) return null;
      if (!this.#validateProjectedInventoryState({ updates: [updateData] })) return null;
      await this.actor.updateEmbeddedDocuments("Item", [updateData]);
      return this.actor.items.get(sourceItem.id) ?? null;
    }

    const excludedIds = [sourceOwned ? sourceItem?.id ?? "" : ""].filter(Boolean);
    const target = this.#getCompatibleVirtualStackTarget(itemData, targetItem, excludedIds);
    const { columns, rows } = getContainerInventoryGridOptions(this.item);
    const overflowQuantity = target ? getItemStackAdditionOverflowQuantity(target, quantity) : quantity;
    const stackParts = createAnchoredItemStackPartsForQuantity({
      itemData,
      quantity: overflowQuantity,
      preferredPlacement,
      contextItems: getContextInventoryItems(this.item.id, this.actor.items),
      columns,
      rows,
      allItems: this.actor.items,
      excludeItemIds: excludedIds,
      options: getContainerInventoryGridOptions(this.item)
    });
    if (!stackParts) {
      this.#warnValidation({ reason: "no-space" });
      return null;
    }
    const targetUpdates = [];
    const createData = [];

    if (target) {
      const updateData = createItemStackPartAdditionUpdate(target, quantity, null, stackParts);
      if (updateData) targetUpdates.push(updateData);
    } else {
      const createDataEntry = this.#createInventoryStackData(itemData, quantity, preferredPlacement);
      foundry.utils.setProperty(createDataEntry, "system.stackParts", stackParts);
      const primaryPart = stackParts[0] ?? null;
      if (primaryPart) {
        foundry.utils.setProperty(createDataEntry, "system.placement.x", primaryPart.x);
        foundry.utils.setProperty(createDataEntry, "system.placement.y", primaryPart.y);
        foundry.utils.setProperty(createDataEntry, "system.placement.rotated", Boolean(primaryPart.rotated));
      }
      createData.push(createDataEntry);
    }

    const sourceUpdates = [];
    const sourceDeletes = [];
    if (sourceOwned && sourceItem) {
      const removalUpdate = createItemStackPartRemovalUpdate(sourceItem, quantity, sourceStackIndex);
      if ((removalUpdate?.["system.quantity"] ?? getItemQuantity(sourceItem)) <= 0) sourceDeletes.push(sourceItem.id);
      else if (removalUpdate) sourceUpdates.push(removalUpdate);
    }

    const updates = [...targetUpdates, ...sourceUpdates];
    if (!this.#validateProjectedInventoryState({ updates, deletes: sourceDeletes, creates: createData })) return null;
    if (updates.length) await this.actor.updateEmbeddedDocuments("Item", updates);
    if (sourceDeletes.length) await this.actor.deleteEmbeddedDocuments("Item", sourceDeletes);
    if (createData.length) return this.actor.createEmbeddedDocuments("Item", createData);
    return target ? this.actor.items.get(target.id) ?? null : null;
  }

  #getCompatibleStackTarget(itemData, preferredTarget = null, excludeItemIds = []) {
    const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
    const canUsePreferredTarget = preferredTarget
      && !excluded.has(preferredTarget.id)
      && (getItemContainerParentId(preferredTarget) === this.item.id)
      && this.#areStackable(itemData, preferredTarget)
      && (getItemQuantity(preferredTarget) < getItemMaxStack(preferredTarget));
    return canUsePreferredTarget ? [preferredTarget] : [];
  }

  #getCompatibleVirtualStackTarget(itemData, preferredTarget = null, excludeItemIds = []) {
    const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
    if (
      preferredTarget
      && !excluded.has(preferredTarget.id)
      && getItemContainerParentId(preferredTarget) === this.item.id
      && usesVirtualInventoryStacks(preferredTarget)
      && this.#areStackable(itemData, preferredTarget)
    ) return preferredTarget;

    for (const item of getContextInventoryItems(this.item.id, this.actor.items)) {
      if (!item || excluded.has(item.id)) continue;
      if (!usesVirtualInventoryStacks(item)) continue;
      if (!this.#areStackable(itemData, item)) continue;
      return item;
    }
    return null;
  }

  #getSourcePlacement(sourceItem, itemData, preferredPlacement = null, targetItem = null, reservedPlacements = []) {
    const excludedIds = [sourceItem.id, targetItem?.id ?? ""].filter(Boolean);
    const currentPlacement = (
      sourceItem.system?.placement?.mode === "inventory"
      && (getItemContainerParentId(sourceItem) === this.item.id)
    )
      ? normalizeInventoryPlacement(sourceItem.system?.placement ?? {}, itemData, this.actor.items)
      : null;

    if (targetItem && currentPlacement && this.#isInventoryPlacementAvailable(currentPlacement, excludedIds, reservedPlacements)) {
      return currentPlacement;
    }
    if (preferredPlacement && this.#isInventoryPlacementAvailable(preferredPlacement, excludedIds, reservedPlacements)) {
      return preferredPlacement;
    }
    if (currentPlacement && this.#isInventoryPlacementAvailable(currentPlacement, excludedIds, reservedPlacements)) {
      return currentPlacement;
    }
    return this.#getFirstAvailableInventoryPlacement(itemData, excludedIds, reservedPlacements);
  }

  #createInventoryStackData(itemData, quantity, placement) {
    const createData = foundry.utils.deepClone(itemData);
    delete createData._id;
    delete createData.id;
    const storedPlacement = createStoredPlacement(placement, itemData);
    foundry.utils.mergeObject(createData, {
      system: {
        quantity,
        equipped: false,
        container: {
          parentId: this.item.id
        },
        placement: {
          mode: storedPlacement.mode,
          equipmentSlot: storedPlacement.equipmentSlot,
          weaponSet: storedPlacement.weaponSet,
          weaponSlot: storedPlacement.weaponSlot,
          x: storedPlacement.x,
          y: storedPlacement.y,
          width: storedPlacement.width,
          height: storedPlacement.height,
          rotated: storedPlacement.rotated
        }
      }
    });
    return createData;
  }

  #validateProjectedInventoryState({ updates = [], deletes = [], creates = [] } = {}) {
    const validation = validateInventoryTree(
      this.#projectInventoryState({ updates, deletes, creates }),
      getRootInventoryDimensions(this.actor)
    );
    if (validation.valid) return true;
    this.#warnValidation(validation);
    return false;
  }

  #projectInventoryState({ updates = [], deletes = [], creates = [] } = {}) {
    const itemMap = new Map(this.actor.items.contents.map(item => [item.id, item.toObject()]));

    for (const update of updates) {
      if (!update?._id || !itemMap.has(update._id)) continue;
      const nextData = foundry.utils.deepClone(itemMap.get(update._id));
      for (const [key, value] of Object.entries(update)) {
        if (key === "_id") continue;
        foundry.utils.setProperty(nextData, key, value);
      }
      itemMap.set(update._id, nextData);
    }

    for (const deleteId of deletes) {
      itemMap.delete(deleteId);
    }

    let syntheticIndex = 0;
    for (const createData of creates) {
      const syntheticId = String(createData?._id ?? `synthetic-${syntheticIndex += 1}`);
      itemMap.set(syntheticId, foundry.utils.mergeObject(
        foundry.utils.deepClone(createData),
        { _id: syntheticId, id: syntheticId },
        { inplace: false }
      ));
    }

    return Array.from(itemMap.values());
  }

  #warnValidation(validation) {
    if (validation?.reason === "recursive") {
      ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Messages.ContainerRecursiveError"));
      return;
    }
    if (validation?.reason === "max-load") {
      ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Messages.ContainerMaxLoadExceeded"));
      return;
    }
    ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));
  }

  #onItemContextMenu(event) {
    event.preventDefault();
    const item = this.actor.items.get(event.currentTarget?.dataset?.itemId ?? "");
    if (!item) return;
    const stackIndex = Math.max(0, toInteger(event.currentTarget?.dataset?.stackIndex));
    const stackQuantity = Math.max(0, toInteger(event.currentTarget?.dataset?.stackQuantity));
    const selectedQuantity = usesVirtualInventoryStacks(item)
      ? Math.max(1, stackQuantity || getItemStackPartQuantity(item, stackIndex))
      : getItemQuantity(item);

    document.querySelectorAll(".fallout-maw-inventory-context-menu").forEach(menu => menu.remove());
    const menu = document.createElement("nav");
    menu.className = "fallout-maw-inventory-context-menu";
    const menuOptions = [];
    if (game.user?.isGM) {
      menuOptions.push(["edit", "fa-pen-to-square", game.i18n.localize("FALLOUTMAW.Common.Edit")]);
    }
    if (isContainerItem(item)) {
      menuOptions.push(["open", "fa-box-open", game.i18n.localize("FALLOUTMAW.Item.Open")]);
    }
    if (getItemInteractionState(this.actor, item).hasInteraction) {
      menuOptions.push(["interact", "fa-hand-pointer", "Взаимодействие"]);
    }
    if (canUseActiveItem(item)) {
      menuOptions.push(["use", "fa-play", "Применить"]);
    }
    const canRotate = canShowInventoryRotateAction(item);
    const rotationResolution = canRotate ? this.#resolveInventoryRotation(item) : null;
    if (canRotate) {
      menuOptions.push(["rotate", "fa-rotate", game.i18n.localize("FALLOUTMAW.Item.Rotate"), !rotationResolution, rotationResolution ? "" : getInventoryRotationUnavailableLabel()]);
    }
    if (selectedQuantity > 1) {
      menuOptions.push(["split", "fa-code-branch", "Разделить"]);
    }
    if (game.user?.isGM) {
      menuOptions.push(["copy", "fa-copy", game.i18n.localize("FALLOUTMAW.Common.Copy")]);
      menuOptions.push(["delete", "fa-trash", game.i18n.localize("FALLOUTMAW.Common.Delete")]);
    }
    menu.innerHTML = menuOptions
      .map(([action, icon, label, disabled = false, title = ""]) => `<button type="button" data-action="${action}"${disabled ? " disabled" : ""}${title ? ` title="${escapeAttribute(title)}"` : ""}><i class="fa-solid ${icon}"></i>${label}</button>`)
      .join("");
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
    document.body.append(menu);

    menu.addEventListener("click", async clickEvent => {
      const action = clickEvent.target.closest("button")?.dataset.action;
      if (!action) return;
      clickEvent.preventDefault();
      menu.remove();
      if (action === "edit" && game.user?.isGM) return item.sheet?.render(true);
      if (action === "open") {
        const app = new FalloutMaWContainerSheet({ document: item });
        app.render({ force: true });
        app.bringToFront();
        return app;
      }
      if (action === "interact") return openItemInteractionDialog({ actor: this.actor, item, application: this });
      if (action === "use") return useActiveItem({ actor: this.actor, item, application: this });
      if (action === "rotate") return this.#rotateInventoryItem(item);
      if (action === "split") return this.#splitInventoryItem(item, { stackIndex, stackQuantity: selectedQuantity });
      if (action === "copy" && game.user?.isGM) return this.#copyInventoryItem(item);
      if (action === "delete" && game.user?.isGM) return this.#deleteInventoryItem(item, { stackIndex, stackQuantity: selectedQuantity });
      return undefined;
    });
  }

  #resolveInventoryRotation(item) {
    const { columns, rows } = getContainerInventoryGridOptions(this.item);
    return resolveInventoryItemRotation({
      item,
      parentId: this.item.id,
      contextItems: getContextInventoryItems(this.item.id, this.actor.items),
      columns,
      rows,
      allItems: this.actor.items,
      excludeItemIds: [item.id],
      options: getContainerInventoryGridOptions(this.item)
    });
  }

  async #rotateInventoryItem(item, resolution = this.#resolveInventoryRotation(item)) {
    const updateData = createInventoryRotationUpdate(item, resolution);
    if (!updateData) {
      this.#warnValidation({ reason: "no-space" });
      return null;
    }
    if (!this.#validateProjectedInventoryState({ updates: [updateData] })) return null;
    await this.actor.updateEmbeddedDocuments("Item", [updateData]);
    return this.actor.items.get(item.id) ?? null;
  }

  async #copyInventoryItem(item) {
    const data = item.toObject();
    delete data._id;
    delete data.id;
    if (usesVirtualInventoryStacks(item)) {
      try {
        return await grantActorInventoryItem(this.actor, data, {
          quantity: getItemQuantity(item),
          parentId: this.item.id
        });
      } catch (_error) {
        this.#warnValidation({ reason: "no-space" });
        return null;
      }
    }
    const placement = this.#getFirstAvailableInventoryPlacement(data, [], []);
    if (!placement) {
      this.#warnValidation({ reason: "no-space" });
      return null;
    }
    foundry.utils.setProperty(data, "system.container.parentId", this.item.id);
    foundry.utils.setProperty(data, "system.placement", createStoredPlacement(placement, data));
    if (!this.#validateProjectedInventoryState({ creates: [data] })) return null;
    return this.actor.createEmbeddedDocuments("Item", [data]);
  }

  async #splitInventoryItem(item, { stackIndex = 0, stackQuantity = 0 } = {}) {
    const quantity = usesVirtualInventoryStacks(item)
      ? Math.max(1, stackQuantity || getItemStackPartQuantity(item, stackIndex))
      : getItemQuantity(item);
    if (quantity <= 1) return null;
    const amount = await promptItemStackQuantity({
      item,
      title: "Разделить предмет",
      actionLabel: "Разделить",
      max: quantity - 1,
      value: Math.max(1, Math.floor(quantity / 2))
    });
    if (!amount) return null;

    if (usesVirtualInventoryStacks(item)) {
      const splitData = item.toObject();
      foundry.utils.setProperty(splitData, "system.quantity", amount);
      const placement = this.#getFirstAvailableInventoryPlacement(splitData, [], []);
      if (!placement) {
        this.#warnValidation({ reason: "no-space" });
        return null;
      }
      const updateData = createItemStackPartSplitUpdate(item, stackIndex, amount, placement);
      if (!updateData) return null;
      if (!this.#validateProjectedInventoryState({ updates: [updateData] })) return null;
      await this.actor.updateEmbeddedDocuments("Item", [updateData]);
      return this.actor.items.get(item.id) ?? null;
    }

    const data = item.toObject();
    delete data._id;
    delete data.id;
    foundry.utils.setProperty(data, "system.quantity", amount);
    const placement = this.#getFirstAvailableInventoryPlacement(data, [], []);
    if (!placement) {
      this.#warnValidation({ reason: "no-space" });
      return null;
    }
    foundry.utils.setProperty(data, "system.container.parentId", this.item.id);
    foundry.utils.setProperty(data, "system.placement", createStoredPlacement(placement, data));
    const updateData = {
      _id: item.id,
      "system.quantity": quantity - amount
    };
    if (!this.#validateProjectedInventoryState({ updates: [updateData], creates: [data] })) return null;
    await item.update({ "system.quantity": quantity - amount });
    return this.actor.createEmbeddedDocuments("Item", [data]);
  }

  async #deleteInventoryItem(item, { stackIndex = 0, stackQuantity = 0 } = {}) {
    if (!usesVirtualInventoryStacks(item)) return item.delete();
    const amount = Math.max(1, stackQuantity || getItemStackPartQuantity(item, stackIndex));
    const updateData = createItemStackPartRemovalUpdate(item, amount, stackIndex);
    if (!updateData || (updateData["system.quantity"] ?? 0) <= 0) return this.actor.deleteEmbeddedDocuments("Item", [item.id]);
    if (!this.#validateProjectedInventoryState({ updates: [updateData] })) return null;
    return this.actor.updateEmbeddedDocuments("Item", [updateData]);
  }

  #areStackable(sourceData, targetItem) {
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
      && serializeItemFunctions(sourceSystem.functions) === serializeItemFunctions(targetSystem.functions)
    );
  }
}

function serializeItemFunctions(functions = {}) {
  return JSON.stringify(normalizeItemFunctionsForStack(functions));
}

function normalizeItemFunctionsForStack(functions = {}) {
  return normalizeStackComparableValue(functions);
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

async function promptItemStackQuantity({ item, title = "Количество", actionLabel = "Ок", max = 1, value = 1 } = {}) {
  const limit = Math.max(1, toInteger(max));
  const initial = Math.max(1, Math.min(limit, toInteger(value) || limit));
  const formData = await DialogV2.input({
    window: { title },
    content: `
      <p><strong>${escapeHTML(item?.name ?? "")}</strong></p>
      <label class="fallout-maw-stacked-field">
        <span>${game.i18n.localize("FALLOUTMAW.Item.Quantity")}: 1 / ${limit}</span>
        <input type="number" name="quantity" value="${initial}" min="1" max="${limit}" step="1" autofocus>
      </label>
    `,
    ok: {
      label: actionLabel,
      icon: "fa-solid fa-check",
      callback: (_event, button) => new FormDataExtended(button.form).object
    },
    buttons: [{
      action: "cancel",
      label: game.i18n.localize("FALLOUTMAW.Common.Cancel")
    }],
    position: { width: 420 },
    rejectClose: false
  });
  if (!formData || formData === "cancel") return 0;
  return Math.max(1, Math.min(limit, toInteger(formData.quantity)));
}

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value) {
  return escapeHTML(value);
}

function getInventoryGridItemElementAtPointer(event = null, root = null) {
  const direct = event?.target?.closest?.("[data-inventory-grid-item][data-item-id]");
  if (direct && (!root || root.contains(direct))) return direct;
  const clientX = Number(event?.clientX);
  const clientY = Number(event?.clientY);
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  const pointed = document.elementFromPoint(clientX, clientY)?.closest?.("[data-inventory-grid-item][data-item-id]") ?? null;
  return pointed && (!root || root.contains(pointed)) ? pointed : null;
}

function formatWeight(value) {
  const numeric = Number(value) || 0;
  if (Number.isInteger(numeric)) return String(numeric);
  return numeric.toFixed(1).replace(/\.0$/, "");
}

function createInventoryItemData(item, allItems, placement = null, { actor = null, token = null } = {}) {
  const resolvedPlacement = placement ?? normalizeInventoryPlacement(item.system?.placement ?? {}, item, allItems);
  const interactionState = getItemInteractionState(actor ?? item?.actor, item, { token });
  return {
    id: item.id,
    stackIndex: Math.max(0, toInteger(item._stackIndex)),
    stackQuantity: Math.max(1, toInteger(item._stackQuantity) || getItemQuantity(item)),
    virtualStack: usesVirtualInventoryStacks(item),
    name: item.name,
    img: item.img,
    type: item.type,
    quantity: getItemQuantity(item),
    maxStack: getItemMaxStack(item),
    showQuantity: getItemMaxStack(item) > 1,
    totalWeight: Number(getItemTotalWeight(item, allItems).toFixed(1)),
    equipped: Boolean(item.system?.equipped),
    brokenCondition: isItemBrokenByCondition(item),
    interactionToggleable: interactionState.toggleable,
    interactionToggled: interactionState.toggled,
    isContainer: isContainerItem(item),
    parentId: getItemContainerParentId(item),
    placement: resolvedPlacement
  };
}

function getRootInventoryDimensions(actor) {
  const race = getCreatureOptions().races.find(entry => entry.id === actor?.system?.creature?.raceId);
  const inventorySize = race?.inventorySize ?? createDefaultInventorySize();
  return {
    columns: Math.max(1, toInteger(inventorySize.columns)),
    rows: Math.max(1, toInteger(inventorySize.rows))
  };
}
