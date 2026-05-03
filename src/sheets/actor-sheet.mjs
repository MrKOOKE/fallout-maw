import { FALLOUT_MAW } from "../config/system-config.mjs";
import { TEMPLATES } from "../constants.mjs";
import {
  getCharacteristicSettings,
  getCreatureOptions,
  getCurrencySettings,
  getDamageTypeSettings,
  getNeedSettings,
  getResourceSettings,
  getSkillSettings
} from "../settings/accessors.mjs";
import { createDefaultInventorySize } from "../settings/creature-options.mjs";
import {
  getEquipmentSlotSelectionKey,
  getRaceEquipmentSlotsForItem,
  getSelectedEquipmentSlotKeys
} from "../utils/equipment-slots.mjs";
import { toInteger } from "../utils/numbers.mjs";

const { ActorSheetV2 } = foundry.applications.sheets;
const { HandlebarsApplicationMixin } = foundry.applications.api;

export class FalloutMaWActorSheet extends HandlebarsApplicationMixin(ActorSheetV2) {
  #freeEdit = false;
  #activeLimbKey = "";
  #draggedItemData = null;
  #draggedItemId = "";
  #dragDrop = null;
  #tooltipTimer = null;
  #tooltipElement = null;
  #tooltipPointer = { x: 0, y: 0 };

  static DEFAULT_OPTIONS = {
    classes: ["fallout-maw", "fallout-maw-sheet", "fallout-maw-actor-sheet", "sheet", "actor"],
    position: {
      width: 760,
      height: 820
    },
    form: {
      submitOnChange: true
    },
    window: {
      resizable: true
    },
    actions: {
      toggleFreeEdit: this.#onToggleFreeEdit,
      selectLimb: this.#onSelectLimb
    }
  };

  static PARTS = {
    header: {
      template: TEMPLATES.actorSheet.header
    },
    tabs: {
      template: TEMPLATES.actorSheet.tabs
    },
    inventory: {
      template: TEMPLATES.actorSheet.inventory
    },
    indicators: {
      template: TEMPLATES.actorSheet.indicators
    },
    identity: {
      template: TEMPLATES.actorSheet.identity
    }
  };

  static TABS = {
    primary: {
      tabs: [
        { id: "inventory", group: "primary", label: "FALLOUTMAW.Tabs.InventoryEquipment" },
        { id: "indicators", group: "primary", label: "FALLOUTMAW.Tabs.Indicators" },
        { id: "identity", group: "primary", label: "FALLOUTMAW.Tabs.IdentityData" }
      ],
      initial: "inventory"
    }
  };

  get actor() {
    return this.document;
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
        drop: this._onDrop.bind(this),
        dragend: this._onDragEnd.bind(this)
      }
    });
  }

  async _prepareContext(options) {
    this.actor.prepareData();

    const context = await super._prepareContext(options);
    const actor = this.actor;
    const creatureOptions = getCreatureOptions();
    const characteristicSettings = getCharacteristicSettings();
    const currencySettings = getCurrencySettings();
    const damageTypeSettings = getDamageTypeSettings();
    const resourceSettings = getResourceSettings();
    const needSettings = getNeedSettings();
    const skillSettings = getSkillSettings();
    const typeId = actor.system?.creature?.typeId;
    const raceId = actor.system?.creature?.raceId;
    const race = creatureOptions.races.find(entry => entry.id === raceId);
    const sourceSystem = actor.system?._source ?? actor.system;
    const limbEntries = Object.entries(actor.system?.limbs ?? {});
    const activeLimbKey = limbEntries.some(([key]) => key === this.#activeLimbKey)
      ? this.#activeLimbKey
      : (limbEntries[0]?.[0] ?? "");
    const limbs = limbEntries.map(([key, limb]) => ({
      key,
      label: String(limb?.label ?? key),
      value: toInteger(limb?.value),
      max: toInteger(limb?.max),
      active: key === activeLimbKey
    }));

    this.#activeLimbKey = activeLimbKey;

    const inventory = prepareInventoryContext(actor, race);

    return foundry.utils.mergeObject(context, {
      actor,
      system: actor.system,
      sourceSystem,
      config: FALLOUT_MAW,
      owner: actor.isOwner,
      editable: this.isEditable,
      freeEdit: this.#freeEdit,
      editLockAttribute: this.#freeEdit ? "" : "disabled",
      load: {
        value: formatWeight(actor.system.load?.value),
        max: formatWeight(actor.system.load?.max)
      },
      currencies: currencySettings.map(currency => ({
        ...currency,
        amount: toInteger(sourceSystem.currencies?.[currency.key] ?? actor.system.currencies?.[currency.key]),
        hasImage: Boolean(currency.img)
      })),
      creatureTypeName: creatureOptions.types.find(type => type.id === typeId)?.name || "",
      creatureRaceName: race?.name || "",
      creatureTypes: creatureOptions.types.map(type => ({ ...type, selected: type.id === typeId })),
      creatureRaces: creatureOptions.races.map(race => ({ ...race, selected: race.id === raceId })),
      characteristics: characteristicSettings.map(characteristic => ({
        ...characteristic,
        value: toInteger(sourceSystem.characteristics?.[characteristic.key])
      })),
      resources: resourceSettings.map(resource => ({
        ...resource,
        value: toInteger(actor.system.resources?.[resource.key]?.value),
        max: toInteger(actor.system.resources?.[resource.key]?.max)
      })),
      needs: needSettings.map(need => ({
        ...need,
        value: toInteger(actor.system.needs?.[need.key]?.value),
        max: toInteger(actor.system.needs?.[need.key]?.max)
      })),
      limbs,
      activeLimb: limbs.find(limb => limb.active) ?? null,
      skills: skillSettings.map(skill => {
        const current = actor.system.skills?.[skill.key] ?? {};
        const source = sourceSystem.skills?.[skill.key] ?? {};
        return {
          ...skill,
          base: toInteger(current.base),
          bonus: toInteger(source.bonus),
          value: toInteger(current.value)
        };
      }),
      damageResistances: damageTypeSettings.map(damageType => ({
        ...damageType,
        value: toInteger(actor.system.damageResistances?.[activeLimbKey]?.[damageType.key])
      })),
      inventory
    }, { inplace: false });
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#activateCreatureSelectors();
    this.#activateInventoryInteractions();
  }

  async _onDrop(event) {
    const data = this.#getDragEventData(event);
    if (data?.type !== "Item") return super._onDrop(event);

    this.#draggedItemData = null;
    this.#draggedItemId = "";
    this.#clearInventoryDropPreview();
    const dropped = await this.#getDroppedItemFromData(data);
    if (!dropped) return null;

    const zone = this.#getDropZone(event.target);
    const targetItem = this.#getTargetStackItem(event.target, dropped.item?.id ?? "");
    let placement = this.#getPlacementForDropZone(zone, dropped.itemData, [dropped.item?.id ?? ""]);
    if (!placement) return null;
    if (targetItem && !this.#areStackable(dropped.itemData, targetItem)) {
      placement = this.#getFirstAvailableInventoryPlacement(dropped.itemData, [dropped.item?.id ?? ""]);
      if (!placement) {
        this.#warnInventoryNoSpace();
        return null;
      }
    }

    if (dropped.item?.parent === this.actor) {
      return this.#moveOwnedItem(dropped.item, placement, targetItem);
    }

    return this.#createOrStackDroppedItem(dropped.itemData, placement, targetItem);
  }

  _onDragOver(event) {
    const zone = this.#getDropZone(event.target);
    if (!zone) return;
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    this.#draggedItemData = this.#getPreviewItemData(event);
    this.#setInventoryHoverPreview(zone);
  }

  async _onDragStart(event) {
    await super._onDragStart(event);
    this.#clearInventoryTooltip();
    this.#clearInventoryDropPreview();
    const item = this.actor.items.get(event.currentTarget?.dataset?.itemId ?? "");
    this.#draggedItemId = item?.id ?? "";
    this.#draggedItemData = item?.toObject() ?? null;
    event.currentTarget?.classList?.add("dragging");
    this.#highlightEquipmentSlotsForItem(this.#draggedItemData);
  }

  _onDragEnd() {
    this.#draggedItemData = null;
    this.#draggedItemId = "";
    this.#clearInventoryDropPreview();
    this.#clearInventoryDraggingState();
  }

  static #onToggleFreeEdit(event) {
    event.preventDefault();
    this.#freeEdit = !this.#freeEdit;
    return this.render({ force: true });
  }

  static #onSelectLimb(event, target) {
    event.preventDefault();
    const limbKey = target.dataset.limbKey ?? "";
    if (!limbKey || (limbKey === this.#activeLimbKey)) return undefined;
    this.#activeLimbKey = limbKey;
    return this.render({ parts: ["indicators"] });
  }

  #activateCreatureSelectors() {
    const root = this.element;
    const typeSelect = root?.querySelector("[data-creature-type-select]");
    const raceSelect = root?.querySelector("[data-creature-race-select]");
    if (!typeSelect || !raceSelect) return;

    const updateRaceOptions = () => {
      const typeId = typeSelect.value;
      let selectedAvailable = false;

      for (const option of raceSelect.options) {
        const optionTypeId = option.dataset.typeId;
        const visible = !option.value || (typeId && optionTypeId === typeId);
        option.hidden = !visible;
        option.disabled = !visible;
        if (visible && option.selected) selectedAvailable = true;
      }

      if (!selectedAvailable) raceSelect.value = "";
    };

    raceSelect.addEventListener("change", event => {
      const selected = event.currentTarget.selectedOptions[0];
      if (selected?.dataset.typeId) typeSelect.value = selected.dataset.typeId;
      updateRaceOptions();
    });
    typeSelect.addEventListener("change", updateRaceOptions);
    updateRaceOptions();
  }

  #activateInventoryInteractions() {
    const root = this.element;
    const inventoryTab = root?.querySelector('[data-tab="inventory"]');
    if (!inventoryTab) return;
    if (root.dataset.falloutMawInventoryInteractions === "true") return;
    root.dataset.falloutMawInventoryInteractions = "true";

    root.addEventListener("dragleave", event => this.#onInventoryDragLeave(event));
    root.addEventListener("contextmenu", event => this.#onInventoryContextMenu(event));
    root.addEventListener("mouseover", event => this.#onInventoryItemMouseOver(event));
    root.addEventListener("mousemove", event => this.#onInventoryItemMouseMove(event));
    root.addEventListener("mouseout", event => this.#onInventoryItemMouseOut(event));
    root.addEventListener("click", () => this.#closeInventoryContextMenu());
  }

  #onInventoryDragLeave(event) {
    const zone = event.target?.closest?.("[data-drop-zone], [data-equipment-drop-surface], [data-inventory-drop-surface]");
    if (!zone) return;

    const hoveredElement = document.elementFromPoint(event.clientX, event.clientY);
    const hoveredZone = hoveredElement?.closest?.("[data-drop-zone], [data-equipment-drop-surface], [data-inventory-drop-surface]") ?? null;
    if (hoveredZone === zone) return;

    const hoveredSheet = hoveredElement?.closest?.(".fallout-maw-actor-sheet");
    if (hoveredSheet === this.element) {
      this.#clearInventoryHoverPreview();
      return;
    }

    this.#clearInventoryDropPreview();
  }

  #onInventoryContextMenu(event) {
    const itemElement = event.target?.closest?.("[data-item-id]");
    if (!itemElement) return;

    event.preventDefault();
    event.stopPropagation();
    const item = this.actor.items.get(itemElement.dataset.itemId);
    if (!item) return;

    this.#showInventoryContextMenu(item, event);
  }

  #onInventoryItemMouseOver(event) {
    const itemElement = event.target?.closest?.("[data-tooltip-item]");
    if (!itemElement) return;
    if (itemElement.contains(event.relatedTarget)) return;

    const item = this.actor.items.get(itemElement.dataset.tooltipItem);
    if (!item) return;
    this.#tooltipPointer = { x: event.clientX, y: event.clientY };
    this.#clearInventoryTooltip();
    this.#tooltipTimer = setTimeout(() => this.#showInventoryTooltip(item), 500);
  }

  #onInventoryItemMouseMove(event) {
    if (!event.target?.closest?.("[data-tooltip-item]")) return;
    this.#tooltipPointer = { x: event.clientX, y: event.clientY };
    if (this.#tooltipElement) this.#positionInventoryTooltip();
  }

  #onInventoryItemMouseOut(event) {
    const itemElement = event.target?.closest?.("[data-tooltip-item]");
    if (!itemElement || itemElement.contains(event.relatedTarget)) return;
    this.#clearInventoryTooltip();
  }

  #getDropZone(target) {
    const inventoryItem = target?.closest?.("[data-inventory-grid-item]");
    if (inventoryItem) {
      const x = toInteger(inventoryItem.dataset.x);
      const y = toInteger(inventoryItem.dataset.y);
      return this.element?.querySelector(`[data-inventory-cell][data-x="${x}"][data-y="${y}"]`) ?? null;
    }
    const specificZone = target?.closest?.("[data-inventory-cell], [data-equipment-slot], [data-weapon-slot]");
    if (specificZone) return specificZone;
    const equipmentSurface = target?.closest?.("[data-equipment-drop-surface]");
    if (equipmentSurface) return equipmentSurface;
    const surface = target?.closest?.("[data-inventory-drop-surface]");
    if (surface) return surface;
    if (target?.closest?.(".fallout-maw-actor-sheet")) return this.element.querySelector('[data-tab="inventory"]');
    return this.element?.querySelector('[data-tab="inventory"]') ?? null;
  }

  #highlightEquipmentSlotsForItem(itemData) {
    const race = this.#getCurrentRace();
    const selectedSlots = getRaceEquipmentSlotsForItem(race, itemData);
    if (!selectedSlots.length) return false;

    for (const slot of selectedSlots) {
      this.element?.querySelector(`[data-equipment-slot="${CSS.escape(slot.key)}"]`)?.classList.add("drop-match-preview");
    }
    return true;
  }

  #setInventoryHoverPreview(zone = null) {
    this.#clearInventoryHoverPreview();
    if (!zone || zone.dataset.dropZone === undefined) return;
    if (zone.dataset.inventoryCell !== undefined) {
      this.#setInventoryCellHoverPreview(zone);
      return;
    }
    if (zone.classList.contains("drop-match-preview")) return;
    zone.classList.add("drop-preview");
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
      this.#applyInventoryPlacementPreview(normalizeInventoryPlacement(targetItem.system?.placement ?? {}, targetItem));
      return;
    }

    const placement = createInventoryPlacement(toInteger(zone.dataset.x), toInteger(zone.dataset.y), this.#draggedItemData);
    const excludeItemIds = sourceItemId ? [sourceItemId] : [];
    if (!this.#isInventoryPlacementAvailable(placement, excludeItemIds)) return;
    this.#applyInventoryPlacementPreview(placement);
  }

  #applyInventoryPlacementPreview(placement) {
    if (!placement) return;
    for (let y = placement.y; y < (placement.y + placement.height); y += 1) {
      for (let x = placement.x; x < (placement.x + placement.width); x += 1) {
        this.element?.querySelector(`[data-inventory-cell][data-x="${x}"][data-y="${y}"]`)?.classList.add("drop-preview");
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
    this.element?.querySelectorAll(".drop-match-preview").forEach(element => {
      element.classList.remove("drop-match-preview");
    });
  }

  #clearInventoryDraggingState() {
    this.element?.querySelectorAll(".dragging").forEach(element => {
      element.classList.remove("dragging");
    });
  }

  #getPlacementForDropZone(zone, itemData = null, excludeItemIds = []) {
    if (zone.dataset.inventoryCell !== undefined) {
      return createInventoryPlacement(toInteger(zone.dataset.x), toInteger(zone.dataset.y), itemData);
    }

    if (zone.dataset.equipmentSlot) {
      const footprint = getItemFootprint(itemData);
      return {
        mode: "equipment",
        equipmentSlot: zone.dataset.equipmentSlot,
        weaponSet: "",
        weaponSlot: "",
        x: 1,
        y: 1,
        width: footprint.width,
        height: footprint.height
      };
    }

    if (zone.dataset.equipmentDropSurface !== undefined) {
      const footprint = getItemFootprint(itemData);
      return {
        mode: "equipment",
        equipmentSlot: "",
        weaponSet: "",
        weaponSlot: "",
        x: 1,
        y: 1,
        width: footprint.width,
        height: footprint.height
      };
    }

    if (zone.dataset.weaponSet && zone.dataset.weaponSlot) {
      const footprint = getItemFootprint(itemData);
      return {
        mode: "weapon",
        equipmentSlot: "",
        weaponSet: zone.dataset.weaponSet,
        weaponSlot: zone.dataset.weaponSlot,
        x: 1,
        y: 1,
        width: footprint.width,
        height: footprint.height
      };
    }

    return this.#getFirstAvailableInventoryPlacement(itemData, excludeItemIds);
  }

  #getInventoryGridDimensions() {
    return getInventoryGridDimensions(this.#getCurrentRace());
  }

  #getFirstAvailableInventoryPlacement(itemData = null, excludeItemIds = [], reservedPlacements = []) {
    const { columns, rows } = this.#getInventoryGridDimensions();
    return findFirstAvailableInventoryPlacement(
      this.actor.items.contents,
      columns,
      rows,
      itemData,
      excludeItemIds,
      reservedPlacements
    );
  }

  #isInventoryPlacementAvailable(placement, excludeItemIds = [], reservedPlacements = []) {
    const { columns, rows } = this.#getInventoryGridDimensions();
    return isInventoryPlacementAvailable(
      placement,
      this.actor.items.contents,
      columns,
      rows,
      excludeItemIds,
      reservedPlacements
    );
  }

  async #getDroppedItemFromData(data) {
    if (data?.type !== "Item") return null;

    const ownedItem = data.itemId ? this.actor.items.get(data.itemId) : null;
    if (ownedItem) return { item: ownedItem, itemData: ownedItem.toObject() };

    const item = data.uuid
      ? await foundry.utils.getDocumentClass("Item").fromDropData(data)
      : null;
    if (!(item instanceof Item)) return null;
    return { item, itemData: item.toObject() };
  }

  #getPreviewItemData(event) {
    if (this.#draggedItemData) return this.#draggedItemData;
    const data = this.#getDragEventData(event);
    if (data?.type !== "Item") return null;

    const ownedItem = data.itemId ? this.actor.items.get(data.itemId) : null;
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
      // Fall through to explicit transfer payloads.
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

  #getTargetStackItem(target, sourceItemId = "") {
    const itemElement = target?.closest?.("[data-item-id]");
    if (itemElement && itemElement.dataset.itemId !== sourceItemId) {
      if (!itemElement.closest("[data-inventory-grid]")) return null;
      return this.actor.items.get(itemElement.dataset.itemId) ?? null;
    }

    const cell = target?.closest?.("[data-inventory-cell]");
    if (!cell) return null;
    const x = toInteger(cell.dataset.x);
    const y = toInteger(cell.dataset.y);
    return this.actor.items.contents.find(item => {
      if (item.id === sourceItemId) return false;
      const placement = normalizeInventoryPlacement(item.system?.placement ?? {}, item);
      return placement.mode === "inventory" && placementContainsInventoryCell(placement, x, y);
    }) ?? null;
  }

  async #moveOwnedItem(item, placement, targetItem = null) {
    if (placement.mode === "inventory") {
      return this.#insertItemIntoInventory(item.toObject(), placement, { sourceItem: item, targetItem });
    }

    const resolvedPlacement = this.#resolvePlacement(item.toObject(), placement, [item.id]);
    if (!resolvedPlacement) return null;
    const wasEquipment = item.system?.placement?.mode === "equipment";
    const isEquipment = resolvedPlacement.mode === "equipment";

    return item.update({
      "system.equipped": isEquipment ? true : (wasEquipment ? false : Boolean(item.system?.equipped)),
      "system.placement.mode": resolvedPlacement.mode,
      "system.placement.equipmentSlot": resolvedPlacement.equipmentSlot,
      "system.placement.weaponSet": resolvedPlacement.weaponSet,
      "system.placement.weaponSlot": resolvedPlacement.weaponSlot,
      "system.placement.x": resolvedPlacement.x,
      "system.placement.y": resolvedPlacement.y,
      "system.placement.width": resolvedPlacement.width,
      "system.placement.height": resolvedPlacement.height
    });
  }

  async #createOrStackDroppedItem(itemData, placement, targetItem = null) {
    if (!itemData) return null;
    if (placement.mode === "inventory") {
      return this.#insertItemIntoInventory(itemData, placement, { targetItem });
    }

    const resolvedPlacement = this.#resolvePlacement(itemData, placement);
    if (!resolvedPlacement) return null;

    const createData = foundry.utils.deepClone(itemData);
    delete createData._id;
    foundry.utils.mergeObject(createData, {
      system: {
        equipped: resolvedPlacement.mode === "equipment",
        placement: {
          mode: resolvedPlacement.mode,
          equipmentSlot: resolvedPlacement.equipmentSlot,
          weaponSet: resolvedPlacement.weaponSet,
          weaponSlot: resolvedPlacement.weaponSlot,
          x: resolvedPlacement.x,
          y: resolvedPlacement.y,
          width: resolvedPlacement.width,
          height: resolvedPlacement.height
        }
      }
    });
    return this.actor.createEmbeddedDocuments("Item", [createData]);
  }

  async #insertItemIntoInventory(itemData, requestedPlacement, { sourceItem = null, targetItem = null } = {}) {
    const maxStack = getItemMaxStack(itemData);
    let remainingQuantity = Math.max(1, getItemQuantity(itemData));
    const excludedIds = [sourceItem?.id ?? ""].filter(Boolean);
    const preferredPlacement = normalizeInventoryPlacement(requestedPlacement, itemData);
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
      const sourcePlacement = this.#getSourceInventoryPlacement(
        sourceItem,
        itemData,
        targetItem ? null : preferredPlacement,
        targetItem,
        reservedPlacements
      );
      if (!sourcePlacement) {
        this.#warnInventoryNoSpace();
        return null;
      }

      const sourceQuantity = Math.min(remainingQuantity, maxStack);
      remainingQuantity -= sourceQuantity;
      reservedPlacements.push(sourcePlacement);
      sourceUpdate = {
        _id: sourceItem.id,
        "system.quantity": sourceQuantity,
        "system.equipped": false,
        "system.placement.mode": sourcePlacement.mode,
        "system.placement.equipmentSlot": sourcePlacement.equipmentSlot,
        "system.placement.weaponSet": sourcePlacement.weaponSet,
        "system.placement.weaponSlot": sourcePlacement.weaponSlot,
        "system.placement.x": sourcePlacement.x,
        "system.placement.y": sourcePlacement.y,
        "system.placement.width": sourcePlacement.width,
        "system.placement.height": sourcePlacement.height
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
        this.#warnInventoryNoSpace();
        return null;
      }

      createData.push(this.#createInventoryStackData(itemData, stackQuantity, placement));
      reservedPlacements.push(placement);
      remainingQuantity -= stackQuantity;
      nextPlacement = null;
    }

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
      && preferredTarget.system?.placement?.mode === "inventory"
      && this.#areStackable(itemData, preferredTarget)
      && (getItemQuantity(preferredTarget) < getItemMaxStack(preferredTarget));
    if (canUsePreferredTarget) targets.push(preferredTarget);

    for (const item of this.actor.items.contents) {
      if (!item || excluded.has(item.id)) continue;
      if (targets.some(target => target.id === item.id)) continue;
      if (item.system?.placement?.mode !== "inventory") continue;
      if (!this.#areStackable(itemData, item)) continue;
      if (getItemQuantity(item) >= getItemMaxStack(item)) continue;
      targets.push(item);
    }

    return targets;
  }

  #getSourceInventoryPlacement(sourceItem, itemData, preferredPlacement = null, targetItem = null, reservedPlacements = []) {
    const excludedIds = [sourceItem.id, targetItem?.id ?? ""].filter(Boolean);
    const currentPlacement = sourceItem.system?.placement?.mode === "inventory"
      ? normalizeInventoryPlacement(sourceItem.system?.placement ?? {}, itemData)
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
    foundry.utils.mergeObject(createData, {
      system: {
        quantity,
        equipped: false,
        placement: {
          mode: placement.mode,
          equipmentSlot: placement.equipmentSlot,
          weaponSet: placement.weaponSet,
          weaponSlot: placement.weaponSlot,
          x: placement.x,
          y: placement.y,
          width: placement.width,
          height: placement.height
        }
      }
    });
    return createData;
  }

  #resolvePlacement(itemData, placement, excludeItemIds = [], reservedPlacements = []) {
    if (placement.mode === "inventory") {
      return this.#resolveInventoryPlacement(itemData, placement, excludeItemIds, reservedPlacements);
    }
    if (placement.mode === "equipment") {
      return this.#resolveEquipmentPlacement(itemData, placement, excludeItemIds);
    }

    const footprint = getItemFootprint(itemData);
    return {
      ...placement,
      width: footprint.width,
      height: footprint.height
    };
  }

  #resolveInventoryPlacement(itemData, placement, excludeItemIds = [], reservedPlacements = []) {
    const normalizedPlacement = normalizeInventoryPlacement(placement, itemData);
    return this.#isInventoryPlacementAvailable(normalizedPlacement, excludeItemIds, reservedPlacements)
      ? normalizedPlacement
      : null;
  }

  #resolveEquipmentPlacement(itemData, placement, excludeItemIds = []) {
    if (placement.mode !== "equipment") return placement;

    const race = this.#getCurrentRace();
    const selectedSlots = getRaceEquipmentSlotsForItem(race, itemData);
    const targetSlot = placement.equipmentSlot
      ? selectedSlots.find(slot => slot.key === placement.equipmentSlot)
      : selectedSlots[0];
    if (!targetSlot) return null;

    const blocked = selectedSlots.some(slot => Boolean(this.#getEquipmentItemForSlot(slot, excludeItemIds)));
    if (blocked) return null;

    const footprint = getItemFootprint(itemData);
    return {
      ...placement,
      equipmentSlot: targetSlot.key,
      width: footprint.width,
      height: footprint.height
    };
  }

  #getEquipmentItemForSlot(slot, excludeItemIds = []) {
    const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
    const slotSelectionKey = getEquipmentSlotSelectionKey(slot.label);
    return this.actor.items.contents.find(item => {
      if (excluded.has(item.id)) return false;
      if (item.system?.placement?.mode !== "equipment") return false;
      return getSelectedEquipmentSlotKeys(item).has(slotSelectionKey);
    }) ?? null;
  }

  #getCurrentRace() {
    return getCreatureOptions().races.find(entry => entry.id === this.actor.system?.creature?.raceId) ?? null;
  }

  #areStackable(sourceData, targetItem) {
    const sourceSystem = sourceData?.system ?? {};
    const targetSystem = targetItem?.system ?? {};
    return (
      sourceData?.type === targetItem?.type
      && sourceData?.name === targetItem?.name
      && sourceData?.img === targetItem?.img
      && Number(sourceSystem.weight) === Number(targetSystem.weight)
      && Number(sourceSystem.price) === Number(targetSystem.price)
      && String(sourceSystem.priceCurrency ?? "") === String(targetSystem.priceCurrency ?? "")
      && getItemMaxStack(sourceSystem) === getItemMaxStack(targetSystem)
      && getItemFootprint(sourceSystem).width === getItemFootprint(targetSystem).width
      && getItemFootprint(sourceSystem).height === getItemFootprint(targetSystem).height
      && serializeSet(getSelectedEquipmentSlotKeys(sourceSystem)) === serializeSet(getSelectedEquipmentSlotKeys(targetSystem))
    );
  }

  #showInventoryContextMenu(item, event) {
    this.#closeInventoryContextMenu();
    const isSlottedEquipment = item.system?.placement?.mode === "equipment";
    const isEquipped = Boolean(item.system?.equipped);
    const menu = document.createElement("nav");
    menu.className = "fallout-maw-inventory-context-menu";
    const menuOptions = [
      ["edit", "fa-pen-to-square", game.i18n.localize("FALLOUTMAW.Common.Edit")]
    ];
    if (isSlottedEquipment || isEquipped) {
      menuOptions.push(["unequip", "fa-hand", game.i18n.localize("FALLOUTMAW.Item.Unequip")]);
    } else {
      menuOptions.push(["equip", "fa-shirt", game.i18n.localize("FALLOUTMAW.Item.Equip")]);
    }
    if (!isSlottedEquipment) {
      menuOptions.push(["copy", "fa-copy", game.i18n.localize("FALLOUTMAW.Common.Copy")]);
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
      this.#closeInventoryContextMenu();
      if (action === "edit") return item.sheet?.render(true);
      if (action === "equip") return this.#equipInventoryItem(item);
      if (action === "unequip") return this.#unequipInventoryItem(item);
      if (action === "copy") return this.#copyInventoryItem(item);
      if (action === "delete") return item.delete();
      return undefined;
    });
  }

  #closeInventoryContextMenu() {
    document.querySelectorAll(".fallout-maw-inventory-context-menu").forEach(menu => menu.remove());
  }

  async #copyInventoryItem(item) {
    const data = item.toObject();
    delete data._id;
    const placement = this.#getFirstAvailableInventoryPlacement(data);
    if (!placement) {
      this.#warnInventoryNoSpace();
      return null;
    }
    foundry.utils.setProperty(data, "system.placement", placement);
    return this.actor.createEmbeddedDocuments("Item", [data]);
  }

  async #equipInventoryItem(item) {
    const race = this.#getCurrentRace();
    const selectedSlots = getRaceEquipmentSlotsForItem(race, item);
    if (!selectedSlots.length) return item.update({ "system.equipped": true });

    const blocked = selectedSlots.some(slot => Boolean(this.#getEquipmentItemForSlot(slot, item.id)));
    if (blocked) return item.update({ "system.equipped": true });

    const slot = selectedSlots[0];
    return item.update({
      "system.equipped": true,
      "system.placement.mode": "equipment",
      "system.placement.equipmentSlot": slot.key,
      "system.placement.weaponSet": "",
      "system.placement.weaponSlot": "",
      "system.placement.x": 1,
      "system.placement.y": 1
    });
  }

  async #unequipInventoryItem(item) {
    const currentPlacement = item.system?.placement ?? {};
    const placement = currentPlacement.mode === "inventory"
      ? normalizeInventoryPlacement(currentPlacement, item)
      : this.#getFirstAvailableInventoryPlacement(item, [item.id]);
    if (!placement) {
      this.#warnInventoryNoSpace();
      return null;
    }
    return item.update({
      "system.equipped": false,
      "system.placement.mode": placement.mode,
      "system.placement.equipmentSlot": placement.equipmentSlot,
      "system.placement.weaponSet": placement.weaponSet,
      "system.placement.weaponSlot": placement.weaponSlot,
      "system.placement.x": placement.x,
      "system.placement.y": placement.y,
      "system.placement.width": placement.width,
      "system.placement.height": placement.height
    });
  }

  #warnInventoryNoSpace() {
    ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));
  }

  #showInventoryTooltip(item) {
    const currencySettings = getCurrencySettings();
    const currency = currencySettings.find(entry => entry.key === item.system?.priceCurrency);
    const quantity = Math.max(1, toInteger(item.system?.quantity));
    const unitWeight = Number(item.system?.weight) || 0;
    const unitPrice = Number(item.system?.price) || 0;
    const totalWeight = unitWeight * quantity;
    const totalPrice = unitPrice * quantity;
    const currencyLabel = currency?.label ? ` ${currency.label}` : "";

    const tooltip = document.createElement("aside");
    tooltip.className = "fallout-maw-inventory-tooltip";
    tooltip.innerHTML = `
      <strong>${escapeHTML(item.name)}</strong>
      <span>${game.i18n.localize("FALLOUTMAW.Item.Weight")}: ${formatNumber(unitWeight)} / ${formatNumber(totalWeight)} ${game.i18n.localize("FALLOUTMAW.Common.Kg")}</span>
      <span>${game.i18n.localize("FALLOUTMAW.Item.Price")}: ${formatNumber(unitPrice)}${currencyLabel} / ${formatNumber(totalPrice)}${currencyLabel}</span>
    `;
    document.body.append(tooltip);
    this.#tooltipElement = tooltip;
    this.#positionInventoryTooltip();
  }

  #positionInventoryTooltip() {
    if (!this.#tooltipElement) return;
    const margin = 14;
    const rect = this.#tooltipElement.getBoundingClientRect();
    const x = Math.min(this.#tooltipPointer.x + margin, window.innerWidth - rect.width - margin);
    const y = Math.min(this.#tooltipPointer.y + margin, window.innerHeight - rect.height - margin);
    this.#tooltipElement.style.left = `${Math.max(margin, x)}px`;
    this.#tooltipElement.style.top = `${Math.max(margin, y)}px`;
  }

  #clearInventoryTooltip() {
    if (this.#tooltipTimer) {
      clearTimeout(this.#tooltipTimer);
      this.#tooltipTimer = null;
    }
    this.#tooltipElement?.remove();
    this.#tooltipElement = null;
  }
}

function formatWeight(value) {
  const numeric = Number(value) || 0;
  if (Number.isInteger(numeric)) return String(numeric);
  return numeric.toFixed(1).replace(/\.0$/, "");
}

function formatNumber(value) {
  const numeric = Number(value) || 0;
  if (Number.isInteger(numeric)) return String(numeric);
  return numeric.toFixed(2).replace(/\.?0+$/, "");
}

function escapeHTML(value) {
  const element = document.createElement("span");
  element.textContent = String(value ?? "");
  return element.innerHTML;
}

function serializeSet(set) {
  return Array.from(set).sort().join("|");
}

function getInventoryGridDimensions(race) {
  const inventorySize = race?.inventorySize ?? createDefaultInventorySize();
  return {
    columns: Math.max(1, toInteger(inventorySize.columns)),
    rows: Math.max(1, toInteger(inventorySize.rows))
  };
}

function getItemQuantity(itemOrSystem) {
  const system = itemOrSystem?.system ?? itemOrSystem ?? {};
  return Math.max(0, toInteger(system.quantity));
}

function getItemMaxStack(itemOrSystem) {
  const system = itemOrSystem?.system ?? itemOrSystem ?? {};
  return Math.max(1, toInteger(system.maxStack) || 1);
}

function getItemFootprint(itemOrSystem) {
  const system = itemOrSystem?.system ?? itemOrSystem ?? {};
  const placement = system.placement ?? {};
  return {
    width: Math.max(1, toInteger(placement.width) || 1),
    height: Math.max(1, toInteger(placement.height) || 1)
  };
}

function createInventoryPlacement(x = 1, y = 1, itemOrSystem = null) {
  const { width, height } = getItemFootprint(itemOrSystem);
  return {
    mode: "inventory",
    equipmentSlot: "",
    weaponSet: "",
    weaponSlot: "",
    x: Math.max(1, toInteger(x)),
    y: Math.max(1, toInteger(y)),
    width,
    height
  };
}

function normalizeInventoryPlacement(placement = {}, itemOrSystem = null) {
  placement ??= {};
  return {
    ...createInventoryPlacement(placement.x, placement.y, itemOrSystem),
    mode: placement.mode ?? "inventory",
    equipmentSlot: String(placement.equipmentSlot ?? ""),
    weaponSet: String(placement.weaponSet ?? ""),
    weaponSlot: String(placement.weaponSlot ?? ""),
    width: Math.max(1, toInteger(placement.width) || getItemFootprint(itemOrSystem).width),
    height: Math.max(1, toInteger(placement.height) || getItemFootprint(itemOrSystem).height)
  };
}

function isInventoryPlacementWithinBounds(placement, columns, rows) {
  if (!placement) return false;
  return (
    placement.x >= 1
    && placement.y >= 1
    && (placement.x + placement.width - 1) <= columns
    && (placement.y + placement.height - 1) <= rows
  );
}

function placementContainsInventoryCell(placement, x, y) {
  if (!placement) return false;
  return (
    x >= placement.x
    && x < (placement.x + placement.width)
    && y >= placement.y
    && y < (placement.y + placement.height)
  );
}

function inventoryPlacementsOverlap(left, right) {
  if (!left || !right) return false;
  return !(
    (left.x + left.width - 1) < right.x
    || (right.x + right.width - 1) < left.x
    || (left.y + left.height - 1) < right.y
    || (right.y + right.height - 1) < left.y
  );
}

function isInventoryPlacementAvailable(placement, items, columns, rows, excludeItemIds = [], reservedPlacements = []) {
  if (!isInventoryPlacementWithinBounds(placement, columns, rows)) return false;
  const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
  if (reservedPlacements.some(existing => inventoryPlacementsOverlap(placement, existing))) return false;

  return !items.some(item => {
    if (!item || excluded.has(item.id)) return false;
    const itemPlacement = normalizeInventoryPlacement(item.system?.placement ?? item.placement ?? {}, item);
    return itemPlacement.mode === "inventory" && inventoryPlacementsOverlap(placement, itemPlacement);
  });
}

function findFirstAvailableInventoryPlacement(items, columns, rows, itemOrSystem = null, excludeItemIds = [], reservedPlacements = []) {
  for (let y = 1; y <= rows; y += 1) {
    for (let x = 1; x <= columns; x += 1) {
      const candidate = createInventoryPlacement(x, y, itemOrSystem);
      if (isInventoryPlacementAvailable(candidate, items, columns, rows, excludeItemIds, reservedPlacements)) {
        return candidate;
      }
    }
  }
  return null;
}

function buildInventoryCellStyle(x, y, placement = null) {
  if (placement) {
    return [
      `grid-column: ${placement.x} / span ${placement.width};`,
      `grid-row: ${placement.y} / span ${placement.height};`
    ].join(" ");
  }
  return `grid-column: ${x}; grid-row: ${y};`;
}

function prepareInventoryContext(actor, race) {
  const currencies = getCurrencySettings();
  const { columns, rows } = getInventoryGridDimensions(race);
  const allItems = actor.items.contents.map(item => ({
    id: item.id,
    uuid: item.uuid,
    name: item.name,
    img: item.img,
    type: item.type,
    quantity: getItemQuantity(item),
    maxStack: getItemMaxStack(item),
    showQuantity: getItemMaxStack(item) > 1,
    weight: Number(item.system?.weight) || 0,
    totalWeight: Number(item.totalWeight) || 0,
    price: Number(item.system?.price) || 0,
    priceCurrency: item.system?.priceCurrency ?? "",
    priceCurrencyLabel: currencies.find(currency => currency.key === item.system?.priceCurrency)?.label ?? "",
    equipped: Boolean(item.system?.equipped),
    occupiedSlots: item.system?.occupiedSlots ?? {},
    placement: normalizeInventoryPlacement(item.system?.placement ?? {}, item)
  }));
  const assignedItemIds = new Set();

  const equipmentSlots = (race?.equipmentSlots ?? []).map(slot => {
    const item = allItems.find(candidate => (
      candidate.placement?.mode === "equipment"
      && getSelectedEquipmentSlotKeys(candidate).has(getEquipmentSlotSelectionKey(slot.label))
    ));
    if (item) assignedItemIds.add(item.id);
    return { ...slot, item };
  });

  const weaponSets = (race?.weaponSets ?? []).map(set => ({
    ...set,
    slots: (set.slots ?? []).map(slot => {
      const limb = (race?.limbs ?? []).find(entry => entry.key === slot.limbKey);
      const item = allItems.find(candidate => (
        candidate.placement?.mode === "weapon"
        && candidate.placement?.weaponSet === set.key
        && candidate.placement?.weaponSlot === slot.key
      ));
      if (item) assignedItemIds.add(item.id);
      return {
        ...slot,
        label: limb?.label || slot.limbKey || slot.key,
        item
      };
    })
  }));

  const inventoryItems = allItems.filter(item => !assignedItemIds.has(item.id));
  const placedInventoryItems = [];
  const reservedPlacements = [];
  const preferredItems = inventoryItems
    .filter(item => item.placement?.mode === "inventory")
    .sort((left, right) => {
      const yDifference = toInteger(left.placement?.y) - toInteger(right.placement?.y);
      if (yDifference !== 0) return yDifference;
      return toInteger(left.placement?.x) - toInteger(right.placement?.x);
    });
  const deferredItems = inventoryItems.filter(item => item.placement?.mode !== "inventory");

  for (const item of [...preferredItems, ...deferredItems]) {
    const preferredPlacement = item.placement?.mode === "inventory"
      ? normalizeInventoryPlacement(item.placement, item)
      : null;
    const placement = preferredPlacement && isInventoryPlacementAvailable(preferredPlacement, [], columns, rows, [], reservedPlacements)
      ? preferredPlacement
      : findFirstAvailableInventoryPlacement([], columns, rows, item, [], reservedPlacements);
    if (!placement) continue;
    reservedPlacements.push(placement);
    placedInventoryItems.push({
      ...item,
      placement,
      gridStyle: buildInventoryCellStyle(placement.x, placement.y, placement)
    });
  }

  const cells = [];
  for (let y = 1; y <= rows; y += 1) {
    for (let x = 1; x <= columns; x += 1) {
      cells.push({
        x,
        y,
        occupied: reservedPlacements.some(placement => placementContainsInventoryCell(placement, x, y)),
        style: buildInventoryCellStyle(x, y)
      });
    }
  }

  return {
    equipmentSlots,
    weaponSets,
    grid: {
      columns,
      rows,
      cells,
      items: placedInventoryItems
    }
  };
}
