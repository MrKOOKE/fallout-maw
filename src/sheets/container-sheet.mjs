import { TEMPLATES } from "../constants.mjs";
import { getCreatureOptions } from "../settings/accessors.mjs";
import { createDefaultInventorySize } from "../settings/creature-options.mjs";
import {
  buildInventoryCellStyle,
  createStoredPlacement,
  createInventoryPlacement,
  findFirstAvailableInventoryPlacement,
  getContainerContentsWeight,
  getContainerDimensions,
  getContainerMaxLoad,
  getContextInventoryItems,
  getItemContainerParentId,
  getItemMaxStack,
  getItemQuantity,
  getItemTotalWeight,
  isContainerItem,
  isInventoryPlacementAvailable,
  normalizeInventoryPlacement,
  placementContainsInventoryCell,
  prepareInventoryGridContext,
  validateInventoryTree
} from "../utils/inventory-containers.mjs";
import { toInteger } from "../utils/numbers.mjs";

const { ItemSheetV2 } = foundry.applications.sheets;
const { HandlebarsApplicationMixin } = foundry.applications.api;

export class FalloutMaWContainerSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
  #draggedItemData = null;
  #draggedItemId = "";
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
    const dimensions = getContainerDimensions(this.item);
    const grid = prepareInventoryGridContext(
      getContextInventoryItems(this.item.id, allItems),
      dimensions.columns,
      dimensions.rows,
      allItems,
      (item, placement) => ({
        ...createInventoryItemData(item, allItems, placement),
        gridStyle: buildInventoryCellStyle(placement.x, placement.y, placement)
      })
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
      },
      totalWeight: formatWeight(getItemTotalWeight(this.item, allItems))
    }, { inplace: false });
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
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
    this.#draggedItemId = item.id;
    this.#draggedItemData = item.toObject();
    const dragData = item.toDragData();
    dragData.itemId = item.id;
    event.dataTransfer?.setData("text/plain", JSON.stringify(dragData));
    event.currentTarget?.classList?.add("dragging");
  }

  _onDragOver(event) {
    const zone = this.#getDropZone(event.target);
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

    const zone = this.#getDropZone(event.target);
    const targetItem = this.#getTargetStackItem(event.target, dropped.item?.id ?? "");
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
      return this.#moveOwnedItem(dropped.item, placement, targetItem);
    }

    return this.#createOrStackDroppedItem(dropped.itemData, placement, targetItem);
  }

  #getDropZone(target) {
    const inventoryItem = target?.closest?.("[data-inventory-grid-item]");
    if (inventoryItem) {
      const x = toInteger(inventoryItem.dataset.x);
      const y = toInteger(inventoryItem.dataset.y);
      return this.element?.querySelector(`[data-inventory-cell][data-x="${x}"][data-y="${y}"]`) ?? null;
    }
    const cell = target?.closest?.("[data-inventory-cell]");
    if (cell) return cell;
    return target?.closest?.("[data-container-drop-surface]") ?? this.element?.querySelector("[data-container-drop-surface]") ?? null;
  }

  async #getDroppedItemFromData(data) {
    if (data?.type !== "Item") return null;

    const ownedItem = data.itemId ? this.actor?.items?.get(data.itemId) : null;
    if (ownedItem) return { item: ownedItem, itemData: ownedItem.toObject() };

    const item = data.uuid ? await foundry.utils.getDocumentClass("Item").fromDropData(data) : null;
    if (!(item instanceof Item)) return null;
    return { item, itemData: item.toObject() };
  }

  #getPreviewItemData(event) {
    if (this.#draggedItemData) return this.#draggedItemData;
    const data = this.#getDragEventData(event);
    if (data?.type !== "Item") return null;

    const ownedItem = data.itemId ? this.actor?.items?.get(data.itemId) : null;
    if (ownedItem) {
      this.#draggedItemId = ownedItem.id;
      return ownedItem.toObject();
    }

    const droppedDocument = data.uuid ? foundry.utils.fromUuidSync(data.uuid) : null;
    if (droppedDocument instanceof Item) return droppedDocument.toObject();
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
    const { columns, rows } = getContainerDimensions(this.item);
    return findFirstAvailableInventoryPlacement(
      getContextInventoryItems(this.item.id, this.actor.items),
      columns,
      rows,
      itemData,
      this.actor.items,
      excludeItemIds,
      reservedPlacements
    );
  }

  #isInventoryPlacementAvailable(placement, excludeItemIds = [], reservedPlacements = []) {
    const { columns, rows } = getContainerDimensions(this.item);
    return isInventoryPlacementAvailable(
      placement,
      getContextInventoryItems(this.item.id, this.actor.items),
      columns,
      rows,
      this.actor.items,
      excludeItemIds,
      reservedPlacements
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
    this.#clearInventoryHoverPreview();
    if (!zone) return;
    if (zone.dataset.inventoryCell !== undefined) {
      this.#setInventoryCellHoverPreview(zone);
      return;
    }
    this.#setContainerSurfaceHoverPreview();
  }

  #setInventoryCellHoverPreview(zone) {
    if (!this.#draggedItemData) {
      zone.classList.add("drop-preview");
      return;
    }

    const sourceItemId = this.#draggedItemId || "";
    const targetItem = this.#getTargetStackItem(zone, sourceItemId);
    const targetHasStackRoom = targetItem
      && this.#areStackable(this.#draggedItemData, targetItem)
      && (getItemQuantity(targetItem) < getItemMaxStack(targetItem));
    if (targetHasStackRoom) {
      this.#applyInventoryPlacementPreview(normalizeInventoryPlacement(targetItem.system?.placement ?? {}, targetItem, this.actor.items));
      return;
    }

    const placement = createInventoryPlacement(
      toInteger(zone.dataset.x),
      toInteger(zone.dataset.y),
      this.#draggedItemData,
      this.actor.items
    );
    const excludeItemIds = sourceItemId ? [sourceItemId] : [];
    if (!this.#isInventoryPlacementAvailable(placement, excludeItemIds)) return;
    this.#applyInventoryPlacementPreview(placement);
  }

  #setContainerSurfaceHoverPreview() {
    if (!this.#draggedItemData) return;
    const excludeItemIds = this.#draggedItemId ? [this.#draggedItemId] : [];
    const placement = this.#getFirstAvailableInventoryPlacement(this.#draggedItemData, excludeItemIds);
    if (!placement) return;
    this.#applyInventoryPlacementPreview(placement);
  }

  #applyInventoryPlacementPreview(placement) {
    if (!placement) return;
    for (let y = placement.y; y < (placement.y + placement.height); y += 1) {
      for (let x = placement.x; x < (placement.x + placement.width); x += 1) {
        this.element?.querySelector(
          `[data-inventory-cell][data-x="${x}"][data-y="${y}"]`
        )?.classList.add("drop-preview");
      }
    }
  }

  #clearInventoryHoverPreview() {
    this.element?.querySelectorAll(".drop-preview").forEach(element => {
      element.classList.remove("drop-preview");
    });
  }

  #clearInventoryDropPreview() {
    this.#clearInventoryHoverPreview();
  }

  #clearInventoryDraggingState() {
    this.element?.querySelectorAll(".dragging").forEach(element => {
      element.classList.remove("dragging");
    });
  }

  async #moveOwnedItem(item, placement, targetItem = null) {
    return this.#insertItemIntoContainer(item.toObject(), placement, { sourceItem: item, targetItem });
  }

  async #createOrStackDroppedItem(itemData, placement, targetItem = null) {
    if (!itemData) return null;
    return this.#insertItemIntoContainer(itemData, placement, { targetItem });
  }

  async #insertItemIntoContainer(itemData, requestedPlacement, { sourceItem = null, targetItem = null } = {}) {
    const maxStack = getItemMaxStack(itemData);
    let remainingQuantity = Math.max(1, getItemQuantity(itemData));
    const excludedIds = [sourceItem?.id ?? ""].filter(Boolean);
    const preferredPlacement = normalizeInventoryPlacement(requestedPlacement, itemData, this.actor.items);
    const stackTargets = this.#findCompatibleStackTargets(itemData, targetItem, excludedIds);
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
        "system.placement.height": storedPlacement.height
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

  #findCompatibleStackTargets(itemData, preferredTarget = null, excludeItemIds = []) {
    const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
    const targets = [];
    const canUsePreferredTarget = preferredTarget
      && !excluded.has(preferredTarget.id)
      && (getItemContainerParentId(preferredTarget) === this.item.id)
      && this.#areStackable(itemData, preferredTarget)
      && (getItemQuantity(preferredTarget) < getItemMaxStack(preferredTarget));
    if (canUsePreferredTarget) targets.push(preferredTarget);

    for (const item of getContextInventoryItems(this.item.id, this.actor.items)) {
      if (!item || excluded.has(item.id)) continue;
      if (targets.some(target => target.id === item.id)) continue;
      if (!this.#areStackable(itemData, item)) continue;
      if (getItemQuantity(item) >= getItemMaxStack(item)) continue;
      targets.push(item);
    }

    return targets;
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
          height: storedPlacement.height
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

    document.querySelectorAll(".fallout-maw-inventory-context-menu").forEach(menu => menu.remove());
    const menu = document.createElement("nav");
    menu.className = "fallout-maw-inventory-context-menu";
    const menuOptions = [
      ["edit", "fa-pen-to-square", game.i18n.localize("FALLOUTMAW.Common.Edit")]
    ];
    if (isContainerItem(item)) {
      menuOptions.push(["open", "fa-box-open", game.i18n.localize("FALLOUTMAW.Item.Open")]);
    }
    menuOptions.push(["delete", "fa-trash", game.i18n.localize("FALLOUTMAW.Common.Delete")]);
    menu.innerHTML = menuOptions
      .map(([action, icon, label]) => `<button type="button" data-action="${action}"><i class="fa-solid ${icon}"></i>${label}</button>`)
      .join("");
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
    document.body.append(menu);

    menu.addEventListener("click", async clickEvent => {
      const action = clickEvent.target.closest("button")?.dataset.action;
      if (!action) return;
      clickEvent.preventDefault();
      menu.remove();
      if (action === "edit") return item.sheet?.render(true);
      if (action === "open") {
        const app = new FalloutMaWContainerSheet({ document: item });
        app.render({ force: true });
        app.bringToFront();
        return app;
      }
      if (action === "delete") return item.delete();
      return undefined;
    });
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
    );
  }
}

function formatWeight(value) {
  const numeric = Number(value) || 0;
  if (Number.isInteger(numeric)) return String(numeric);
  return numeric.toFixed(1).replace(/\.0$/, "");
}

function createInventoryItemData(item, allItems, placement = null) {
  const resolvedPlacement = placement ?? normalizeInventoryPlacement(item.system?.placement ?? {}, item, allItems);
  return {
    id: item.id,
    name: item.name,
    img: item.img,
    type: item.type,
    quantity: getItemQuantity(item),
    maxStack: getItemMaxStack(item),
    showQuantity: getItemMaxStack(item) > 1,
    totalWeight: Number(getItemTotalWeight(item, allItems).toFixed(1)),
    equipped: Boolean(item.system?.equipped),
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
