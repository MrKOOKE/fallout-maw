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

    this.#clearInventoryDropPreview();
    const dropped = await this.#getDroppedItemFromData(data);
    if (!dropped) return null;

    const zone = this.#getDropZone(event.target);
    const targetItem = this.#getTargetStackItem(event.target, dropped.item?.id ?? "");
    let placement = this.#getPlacementForDropZone(zone, dropped.item?.id ?? "");
    if (!placement) return null;
    if (targetItem && !this.#areStackable(dropped.itemData, targetItem)) {
      placement = this.#getFirstAvailableInventoryPlacement(dropped.item?.id ?? "");
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
    this.#setInventoryDropPreview(zone, this.#getDroppedItemDataSync(event));
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
    if (!zone || zone.contains(event.relatedTarget)) return;
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
    const specificZone = target?.closest?.("[data-inventory-cell], [data-equipment-slot], [data-weapon-slot]");
    if (specificZone) return specificZone;
    const equipmentSurface = target?.closest?.("[data-equipment-drop-surface]");
    if (equipmentSurface) return equipmentSurface;
    const surface = target?.closest?.("[data-inventory-drop-surface]");
    if (surface) return surface;
    if (target?.closest?.(".fallout-maw-actor-sheet")) return this.element.querySelector('[data-tab="inventory"]');
    return this.element?.querySelector('[data-tab="inventory"]') ?? null;
  }

  #setInventoryDropPreview(zone, itemData = null) {
    this.#clearInventoryDropPreview();
    if ((zone.dataset.equipmentSlot || zone.dataset.equipmentDropSurface !== undefined) && itemData) {
      const highlighted = this.#highlightEquipmentSlotsForItem(itemData, zone.dataset.equipmentSlot);
      if (highlighted) return;
    }
    zone.classList.add("drop-preview");
  }

  #highlightEquipmentSlotsForItem(itemData, hoveredSlotKey = "") {
    const race = this.#getCurrentRace();
    const selectedSlots = getRaceEquipmentSlotsForItem(race, itemData);
    if (!selectedSlots.length) return false;
    if (hoveredSlotKey && !selectedSlots.some(slot => slot.key === hoveredSlotKey)) return false;

    for (const slot of selectedSlots) {
      this.element?.querySelector(`[data-equipment-slot="${CSS.escape(slot.key)}"]`)?.classList.add("drop-preview");
    }
    return true;
  }

  #clearInventoryDropPreview() {
    this.element?.querySelectorAll(".drop-preview, .dragging").forEach(element => {
      element.classList.remove("drop-preview", "dragging");
    });
  }

  #getPlacementForDropZone(zone, excludeItemId = "") {
    if (zone.dataset.inventoryCell !== undefined) {
      return createInventoryPlacement(toInteger(zone.dataset.x), toInteger(zone.dataset.y));
    }

    if (zone.dataset.equipmentSlot) {
      return {
        mode: "equipment",
        equipmentSlot: zone.dataset.equipmentSlot,
        weaponSet: "",
        weaponSlot: "",
        x: 1,
        y: 1
      };
    }

    if (zone.dataset.equipmentDropSurface !== undefined) {
      return {
        mode: "equipment",
        equipmentSlot: "",
        weaponSet: "",
        weaponSlot: "",
        x: 1,
        y: 1
      };
    }

    if (zone.dataset.weaponSet && zone.dataset.weaponSlot) {
      return {
        mode: "weapon",
        equipmentSlot: "",
        weaponSet: zone.dataset.weaponSet,
        weaponSlot: zone.dataset.weaponSlot,
        x: 1,
        y: 1
      };
    }

    return this.#getFirstAvailableInventoryPlacement(excludeItemId);
  }

  #getFirstAvailableInventoryPlacement(excludeItemId = "") {
    const race = getCreatureOptions().races.find(entry => entry.id === this.actor.system?.creature?.raceId);
    const columns = Math.max(1, toInteger(race?.inventorySize?.columns ?? 10));
    const rows = Math.max(1, toInteger(race?.inventorySize?.rows ?? 2));

    for (let y = 1; y <= rows; y += 1) {
      for (let x = 1; x <= columns; x += 1) {
        if (!this.#isInventoryCellOccupied(x, y, excludeItemId)) return createInventoryPlacement(x, y);
      }
    }

    return createInventoryPlacement(1, 1);
  }

  #isInventoryCellOccupied(x, y, excludeItemId = "") {
    return this.actor.items.contents.some(item => {
      if (item.id === excludeItemId) return false;
      const placement = item.system?.placement ?? {};
      return (
        placement.mode === "inventory"
        && toInteger(placement.x) === x
        && toInteger(placement.y) === y
      );
    });
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

  #getDroppedItemDataSync(event) {
    const data = this.#getDragEventData(event);
    if (data?.type !== "Item") return null;

    const ownedItem = data.itemId ? this.actor.items.get(data.itemId) : null;
    if (ownedItem) return ownedItem.toObject();

    const document = data.uuid && typeof fromUuidSync === "function" ? fromUuidSync(data.uuid) : null;
    return document instanceof Item ? document.toObject() : null;
  }

  #getDragEventData(event) {
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
      if (!itemElement.closest("[data-inventory-cell]")) return null;
      return this.actor.items.get(itemElement.dataset.itemId) ?? null;
    }

    const cell = target?.closest?.("[data-inventory-cell]");
    if (!cell) return null;
    const x = toInteger(cell.dataset.x);
    const y = toInteger(cell.dataset.y);
    return this.actor.items.contents.find(item => {
      if (item.id === sourceItemId) return false;
      const placement = item.system?.placement ?? {};
      return (
        placement.mode === "inventory"
        && toInteger(placement.x) === x
        && toInteger(placement.y) === y
      );
    }) ?? null;
  }

  async #moveOwnedItem(item, placement, targetItem = null) {
    if (targetItem && this.#areStackable(item.toObject(), targetItem)) {
      const nextQuantity = toInteger(targetItem.system?.quantity) + toInteger(item.system?.quantity);
      await this.actor.updateEmbeddedDocuments("Item", [{
        _id: targetItem.id,
        "system.quantity": nextQuantity
      }]);
      return this.actor.deleteEmbeddedDocuments("Item", [item.id]);
    }

    const resolvedPlacement = this.#resolveEquipmentPlacement(item.toObject(), placement, item.id);
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
      "system.placement.y": resolvedPlacement.y
    });
  }

  async #createOrStackDroppedItem(itemData, placement, targetItem = null) {
    if (!itemData) return null;
    const resolvedPlacement = this.#resolveEquipmentPlacement(itemData, placement);
    if (!resolvedPlacement) return null;
    const stackTarget = resolvedPlacement.mode !== "equipment"
      ? (targetItem && this.#areStackable(itemData, targetItem)
        ? targetItem
        : this.#findStackTarget(itemData))
      : null;

    if (stackTarget) {
      const nextQuantity = toInteger(stackTarget.system?.quantity) + Math.max(1, toInteger(itemData.system?.quantity));
      return this.actor.updateEmbeddedDocuments("Item", [{
        _id: stackTarget.id,
        "system.quantity": nextQuantity
      }]);
    }

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
          y: resolvedPlacement.y
        }
      }
    });
    return this.actor.createEmbeddedDocuments("Item", [createData]);
  }

  #findStackTarget(itemData, excludeItemId = "") {
    return this.actor.items.contents.find(item => (
      item.id !== excludeItemId
      && this.#areStackable(itemData, item)
    )) ?? null;
  }

  #resolveEquipmentPlacement(itemData, placement, excludeItemId = "") {
    if (placement.mode !== "equipment") return placement;

    const race = this.#getCurrentRace();
    const selectedSlots = getRaceEquipmentSlotsForItem(race, itemData);
    const targetSlot = placement.equipmentSlot
      ? selectedSlots.find(slot => slot.key === placement.equipmentSlot)
      : selectedSlots[0];
    if (!targetSlot) return null;

    const blocked = selectedSlots.some(slot => {
      const occupyingItem = this.#getEquipmentItemForSlot(slot, excludeItemId);
      return Boolean(occupyingItem);
    });
    if (blocked) return null;

    return {
      ...placement,
      equipmentSlot: targetSlot.key
    };
  }

  #getEquipmentItemForSlot(slot, excludeItemId = "") {
    const slotSelectionKey = getEquipmentSlotSelectionKey(slot.label);
    return this.actor.items.contents.find(item => {
      if (item.id === excludeItemId) return false;
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
    foundry.utils.setProperty(data, "system.placement", this.#getFirstAvailableInventoryPlacement());
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
      ? currentPlacement
      : this.#getFirstAvailableInventoryPlacement(item.id);
    return item.update({
      "system.equipped": false,
      "system.placement.mode": placement.mode,
      "system.placement.equipmentSlot": placement.equipmentSlot,
      "system.placement.weaponSet": placement.weaponSet,
      "system.placement.weaponSlot": placement.weaponSlot,
      "system.placement.x": placement.x,
      "system.placement.y": placement.y
    });
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

function createInventoryPlacement(x = 1, y = 1) {
  return {
    mode: "inventory",
    equipmentSlot: "",
    weaponSet: "",
    weaponSlot: "",
    x: Math.max(1, toInteger(x)),
    y: Math.max(1, toInteger(y))
  };
}

function prepareInventoryContext(actor, race) {
  const currencies = getCurrencySettings();
  const inventorySize = race?.inventorySize ?? createDefaultInventorySize();
  const columns = Math.max(1, toInteger(inventorySize.columns));
  const rows = Math.max(1, toInteger(inventorySize.rows));
  const allItems = actor.items.contents.map(item => ({
    id: item.id,
    uuid: item.uuid,
    name: item.name,
    img: item.img,
    type: item.type,
    quantity: toInteger(item.system?.quantity),
    weight: Number(item.system?.weight) || 0,
    totalWeight: Number(item.totalWeight) || 0,
    price: Number(item.system?.price) || 0,
    priceCurrency: item.system?.priceCurrency ?? "",
    priceCurrencyLabel: currencies.find(currency => currency.key === item.system?.priceCurrency)?.label ?? "",
    equipped: Boolean(item.system?.equipped),
    occupiedSlots: item.system?.occupiedSlots ?? {},
    placement: item.system?.placement ?? {}
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
  const unplacedInventoryItems = inventoryItems.filter(item => (
    item.placement?.mode !== "inventory"
    || !toInteger(item.placement?.x)
    || !toInteger(item.placement?.y)
  ));
  const cells = [];
  const placedGridItemIds = new Set();
  for (let y = 1; y <= rows; y += 1) {
    for (let x = 1; x <= columns; x += 1) {
      const placedItem = inventoryItems.find(candidate => {
        const placement = candidate.placement ?? {};
        return (
          !placedGridItemIds.has(candidate.id)
          && placement.mode === "inventory"
          && toInteger(placement.x) === x
          && toInteger(placement.y) === y
        );
      });
      const item = placedItem ?? unplacedInventoryItems.filter(candidate => !placedGridItemIds.has(candidate.id))[0] ?? null;
      if (item) placedGridItemIds.add(item.id);
      cells.push({ x, y, item });
    }
  }

  return {
    equipmentSlots,
    weaponSets,
    grid: {
      columns,
      rows,
      cells
    }
  };
}
