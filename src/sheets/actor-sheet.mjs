import { FALLOUT_MAW } from "../config/system-config.mjs";
import { TEMPLATES } from "../constants.mjs";
import { AdvancementApplication } from "../advancement/application.mjs";
import {
  getCharacteristicSettings,
  getCreatureOptions,
  getCurrencySettings,
  getDamageTypeSettings,
  getLevelSettings,
  getNeedSettings,
  getProficiencySettings,
  getResourceSettings,
  getSkillSettings
} from "../settings/accessors.mjs";
import { getLevelThreshold } from "../settings/levels.mjs";
import { createDefaultInventorySize } from "../settings/creature-options.mjs";
import {
  getEquipmentSlotSelectionKey,
  getRaceEquipmentSlotsForItem,
  getSelectedEquipmentSlotKeys
} from "../utils/equipment-slots.mjs";
  import {
    completeResearch,
    deleteResearchWithConfirm,
    openCreateResearchDialog,
    openManageResearchDialog,
    openResearchTimeDialog,
  prepareResearchesForDisplay
} from "../research/index.mjs";
import { openSkillCheckDialog } from "../rolls/skill-check.mjs";
import {
  ROOT_CONTAINER_ID,
  buildInventoryCellStyle as buildInventoryCellStyleHelper,
  createStoredPlacement,
  createInventoryPlacement as createInventoryPlacementHelper,
  findFirstAvailableInventoryPlacement as findFirstAvailableInventoryPlacementHelper,
  getContainerContentsWeight,
  getContainerDimensions,
  getContainerMaxLoad,
  getContextInventoryItems,
  getItemContainerParentId,
  getItemFootprint as getItemFootprintHelper,
  getItemMaxStack as getItemMaxStackHelper,
  getItemQuantity as getItemQuantityHelper,
  getItemTotalWeight,
  hasContainerCycle,
  isContainerItem,
  isInventoryPlacementAvailable as isInventoryPlacementAvailableHelper,
  normalizeInventoryPlacement as normalizeInventoryPlacementHelper,
  placementContainsInventoryCell as placementContainsInventoryCellHelper,
  prepareInventoryGridContext,
  validateInventoryTree
} from "../utils/inventory-containers.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { FalloutMaWContainerSheet } from "./container-sheet.mjs";

const { ActorSheetV2 } = foundry.applications.sheets;
const { HandlebarsApplicationMixin } = foundry.applications.api;

export class FalloutMaWActorSheet extends HandlebarsApplicationMixin(ActorSheetV2) {
  #freeEdit = false;
  #activeLimbKey = "";
  #draggedItemData = null;
  #draggedItemId = "";
  #dragPreviewSourceKey = "";
  #dragDrop = null;
  #tooltipTimer = null;
  #tooltipElement = null;
  #tooltipPointer = { x: 0, y: 0 };
  #viewportResizeHandler = null;
  #tabScrollPositions = new Map();

  static DEFAULT_OPTIONS = {
    classes: ["fallout-maw", "fallout-maw-sheet", "fallout-maw-actor-sheet", "sheet", "actor"],
    position: {
      width: 1280,
      height: 720
    },
    form: {
      submitOnChange: true
    },
    window: {
      resizable: false
    },
    actions: {
        openDevelopment: this.#onOpenDevelopment,
        toggleFreeEdit: this.#onToggleFreeEdit,
        selectLimb: this.#onSelectLimb,
        createResearch: this.#onCreateResearch,
        deleteResearch: this.#onDeleteResearch,
        manageResearch: this.#onManageResearch,
        openResearchTime: this.#onOpenResearchTime,
        createEffect: this.#onCreateEffect,
      editEffect: this.#onEditEffect,
      toggleEffect: this.#onToggleEffect,
      deleteEffect: this.#onDeleteEffect,
      rollSkill: this.#onRollSkill
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
    },
    research: {
      template: TEMPLATES.actorSheet.research
    },
    effects: {
      template: TEMPLATES.actorSheet.effects
    }
  };

  static TABS = {
    primary: {
      tabs: [
        { id: "inventory", group: "primary", label: "FALLOUTMAW.Tabs.InventoryEquipment" },
        { id: "indicators", group: "primary", label: "FALLOUTMAW.Tabs.Indicators" },
        { id: "identity", group: "primary", label: "FALLOUTMAW.Tabs.IdentityData" },
        { id: "research", group: "primary", label: "FALLOUTMAW.Tabs.Research" },
        { id: "effects", group: "primary", label: "FALLOUTMAW.Tabs.Effects" }
      ],
      initial: "inventory"
    }
  };

  get actor() {
    return this.document;
  }

  setPosition(position = {}) {
    return super.setPosition(this.#getFullscreenSheetPosition(position));
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
    const context = await super._prepareContext(options);
    const actor = this.actor;
    const creatureOptions = getCreatureOptions();
    const characteristicSettings = getCharacteristicSettings();
    const currencySettings = getCurrencySettings();
    const damageTypeSettings = getDamageTypeSettings();
    const resourceSettings = getResourceSettings();
    const needSettings = getNeedSettings();
    const proficiencySettings = getProficiencySettings();
    const skillSettings = getSkillSettings();
    const levelSettings = getLevelSettings();
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
    const level = Math.max(1, toInteger(actor.system?.attributes?.level));
    const currentExperience = Math.max(0, toInteger(actor.system?.development?.experience));
    const maxLevel = levelSettings[levelSettings.length - 1]?.level ?? 100;
    const loadValue = Math.max(0, Number(actor.system.load?.value) || 0);
    const loadMax = Math.max(0, Number(actor.system.load?.max) || 0);
    const loadRatio = loadMax > 0 ? (loadValue / loadMax) : 0;
    const loadPercent = Math.max(0, Math.min(100, loadRatio * 100));
    const nextThreshold = level >= maxLevel
      ? getLevelThreshold(levelSettings, Math.max(1, level))
      : getLevelThreshold(levelSettings, Math.max(1, level));
    const progressionPercent = nextThreshold > 0
      ? Math.max(0, Math.min(100, (currentExperience / nextThreshold) * 100))
      : 0;

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
        value: formatWeight(loadValue),
        max: formatWeight(loadMax),
        percent: Number(loadPercent.toFixed(2)),
        trend: "negative",
        state: loadRatio >= 1 ? "critical" : loadRatio >= 0.75 ? "warning" : "normal"
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
      progressionExperienceDisplay: `${currentExperience} / ${nextThreshold}`,
      progressionExperienceNext: nextThreshold,
      progressionExperiencePercent: Number(progressionPercent.toFixed(2)),
      characteristics: characteristicSettings.map(characteristic => ({
        ...characteristic,
        value: toInteger(actor.system?.characteristics?.[characteristic.key]),
        sourceValue: toInteger(sourceSystem.characteristics?.[characteristic.key] ?? actor.system?.characteristics?.[characteristic.key])
      })),
      resources: resourceSettings.map(resource => ({
        ...resource,
        value: toInteger(actor.system.resources?.[resource.key]?.value),
        bonus: toInteger(actor.system.resources?.[resource.key]?.bonus),
        max: toInteger(actor.system.resources?.[resource.key]?.max)
      })),
      needs: needSettings.map(need => ({
        ...need,
        value: toInteger(actor.system.needs?.[need.key]?.value),
        bonus: toInteger(actor.system.needs?.[need.key]?.bonus),
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
      proficiencies: proficiencySettings.map(proficiency => {
        const current = actor.system.proficiencies?.[proficiency.key] ?? {};
        return {
          ...proficiency,
          value: toInteger(current.value),
          bonus: toInteger(current.bonus),
          max: toInteger(current.max)
        };
      }),
      researches: prepareResearchesForDisplay(actor.system?.researches, skillSettings, actor.system?.skills),
      damageResistances: damageTypeSettings.map(damageType => ({
        ...damageType,
        value: toInteger(actor.system.damageResistances?.[activeLimbKey]?.[damageType.key])
      })),
      damageDefenses: damageTypeSettings.map(damageType => ({
        ...damageType,
        value: toInteger(actor.system.damageDefenses?.[activeLimbKey]?.[damageType.key])
      })),
      inventory,
      effectCategories: prepareEffectCategories(actor.effects.contents)
    }, { inplace: false });
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    super.setPosition(this.#getFullscreenSheetPosition());
    this.#bindViewportResize();
    this.#relocateEffectsAddButton();
    this.#activateCreatureSelectors();
    this.#activateInventoryInteractions();
    this.#activateTabScrollPersistence();
    this.#restoreActiveTabScroll();
  }

  _onClose(options) {
    super._onClose(options);
    this.#unbindViewportResize();
  }

  async _onDrop(event) {
    const data = this.#getDragEventData(event);
    if (data?.type !== "Item") return super._onDrop(event);

    this.#clearDragPreviewCache();
    this.#clearInventoryDropPreview();
    const dropped = await this.#getDroppedItemFromData(data);
    if (!dropped) return null;

    const zone = this.#getDropZone(event);
    const parentId = this.#getInventoryContextParentId(zone);
    const targetItem = this.#getTargetStackItem(zone, dropped.item?.id ?? "", parentId);
    let placement = this.#getPlacementForDropZone(zone, dropped.itemData, [dropped.item?.id ?? ""], parentId);
    if (!placement) return null;
    if (targetItem && !this.#areStackable(dropped.itemData, targetItem)) {
      placement = this.#getFirstAvailableInventoryPlacement(dropped.itemData, [dropped.item?.id ?? ""], [], parentId);
      if (!placement) {
        this.#warnInventoryNoSpace();
        return null;
      }
    }

    if (dropped.item?.parent === this.actor) {
      return this.#moveOwnedItem(dropped.item, placement, targetItem, parentId);
    }

    return this.#createOrStackDroppedItem(dropped.itemData, placement, targetItem, parentId);
  }

  _onDragOver(event) {
    const zone = this.#getDropZone(event);
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
    this.#dragPreviewSourceKey = this.#draggedItemId ? `owned:${this.#draggedItemId}` : "";
    this.#draggedItemData = item?.toObject() ?? null;
    event.currentTarget?.classList?.add("dragging");
    this.#highlightEquipmentSlotsForItem(this.#draggedItemData);
  }

  _onDragEnd() {
    this.#clearDragPreviewCache();
    this.#clearInventoryDropPreview();
    this.#clearInventoryDraggingState();
  }

  static #onToggleFreeEdit(event) {
    event.preventDefault();
    this.#freeEdit = !this.#freeEdit;
    return this.render({ force: true });
  }

  static #onOpenDevelopment(event) {
    event.preventDefault();
    return new AdvancementApplication(this.actor).render(true);
  }

  static #onSelectLimb(event, target) {
    event.preventDefault();
    const limbKey = target.dataset.limbKey ?? "";
    if (!limbKey || (limbKey === this.#activeLimbKey)) return undefined;
    this.#activeLimbKey = limbKey;
    return this.render({ parts: ["indicators"] });
  }

  static #onCreateResearch(event) {
    event.preventDefault();
    return openCreateResearchDialog(this.actor);
  }

  static #onManageResearch(event, target) {
    event.preventDefault();
    const researchId = target.closest("[data-research-id]")?.dataset.researchId ?? "";
    if (!researchId) return undefined;
    return openManageResearchDialog(this.actor, researchId);
  }

  static #onDeleteResearch(event, target) {
    event.preventDefault();
    const researchId = target.closest("[data-research-id]")?.dataset.researchId ?? "";
    if (!researchId) return undefined;
    return deleteResearchWithConfirm(this.actor, researchId);
  }

  static #onOpenResearchTime(event, target) {
    event.preventDefault();
    const researchId = target.closest("[data-research-id]")?.dataset.researchId ?? "";
    if (!researchId) return undefined;
    const research = this.actor.getResearch(researchId);
    if (research && (Number(research.progress) >= Number(research.target))) {
      return completeResearch(this.actor, researchId);
    }
    return openResearchTimeDialog(this.actor, researchId);
  }

  static async #onCreateEffect(event) {
    event.preventDefault();
    const [effect] = await this.actor.createEmbeddedDocuments("ActiveEffect", [{
      type: "base",
      name: game.i18n.localize("FALLOUTMAW.Effects.NewEffect"),
      img: "icons/svg/aura.svg",
      disabled: false,
      flags: {
        "fallout-maw": {
          kind: "active"
        }
      },
      system: {
        changes: []
      }
    }]);
    effect?.sheet?.render(true);
    return this.render({ parts: ["effects"] });
  }

  static #onEditEffect(event, target) {
    event.preventDefault();
    const effect = this.actor.effects.get(target.closest("[data-effect-id]")?.dataset.effectId ?? "");
    return effect?.sheet?.render(true);
  }

  static #onToggleEffect(event, target) {
    event.preventDefault();
    const effect = this.actor.effects.get(target.closest("[data-effect-id]")?.dataset.effectId ?? "");
    return effect?.update({ disabled: !effect.disabled });
  }

  static #onDeleteEffect(event, target) {
    event.preventDefault();
    const effect = this.actor.effects.get(target.closest("[data-effect-id]")?.dataset.effectId ?? "");
    return effect?.delete();
  }

  static #onRollSkill(event, target) {
    event.preventDefault();
    const skillKey = target.dataset.skillKey ?? "";
    if (!skillKey) return undefined;
    return openSkillCheckDialog(this.actor, skillKey);
  }

  #relocateEffectsAddButton() {
    const root = this.element;
    const button = root?.querySelector(".fallout-maw-effects-tab .fallout-maw-floating-add");
    if (!root || !button) return;
    for (const existing of root.querySelectorAll(":scope > .fallout-maw-floating-add")) {
      if (existing !== button) existing.remove();
    }
    root.append(button);
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

  #activateTabScrollPersistence() {
    const root = this.element;
    if (!root || (root.dataset.falloutMawTabScrollPersistence === "true")) return;
    root.dataset.falloutMawTabScrollPersistence = "true";
    root.addEventListener("scroll", event => this.#onTabScroll(event), true);
  }

  #onTabScroll(event) {
    const tab = event.target?.closest?.(".tab[data-tab]");
    if (!tab) return;
    this.#tabScrollPositions.set(tab.dataset.tab, tab.scrollTop ?? 0);
  }

  #restoreActiveTabScroll() {
    const activeTab = this.element?.querySelector?.(".tab.active[data-tab]");
    if (!activeTab) return;

    const scrollTop = this.#tabScrollPositions.get(activeTab.dataset.tab) ?? 0;
    const view = this.element?.ownerDocument?.defaultView ?? window;
    view.requestAnimationFrame(() => {
      if (!this.element?.isConnected) return;
      const nextActiveTab = this.element.querySelector(".tab.active[data-tab]");
      if (!nextActiveTab || (nextActiveTab.dataset.tab !== activeTab.dataset.tab)) return;
      nextActiveTab.scrollTop = scrollTop;
    });
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

    this.#clearDragPreviewCache();
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

  #getDropZone(eventOrTarget) {
    const target = eventOrTarget?.target ?? eventOrTarget;
    const pointedCell = this.#getInventoryCellAtPointer(eventOrTarget, target);
    if (pointedCell) return pointedCell;

    const specificZone = target?.closest?.("[data-inventory-cell], [data-equipment-slot], [data-weapon-slot]");
    if (specificZone) return specificZone;
    const equipmentSurface = target?.closest?.("[data-equipment-drop-surface]");
    if (equipmentSurface) return equipmentSurface;
    const containerSurface = target?.closest?.("[data-container-drop-surface]");
    if (containerSurface) return containerSurface;
    const surface = target?.closest?.("[data-inventory-drop-surface]");
    if (surface) return surface;
    if (target?.closest?.(".fallout-maw-actor-sheet")) return this.element.querySelector('[data-tab="inventory"]');
    return this.element?.querySelector('[data-tab="inventory"]') ?? null;
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

    for (const cell of grid.querySelectorAll("[data-inventory-cell]")) {
      const rect = cell.getBoundingClientRect();
      if (
        clientX >= rect.left
        && clientX <= rect.right
        && clientY >= rect.top
        && clientY <= rect.bottom
      ) return cell;
    }
    return null;
  }

  #getInventoryContextParentId(zone = null) {
    if (!zone) return ROOT_CONTAINER_ID;
    return String(zone.dataset.inventoryParentId ?? zone.dataset.containerId ?? ROOT_CONTAINER_ID);
  }

  #getContextInventoryItems(parentId = ROOT_CONTAINER_ID) {
    return getContextInventoryItems(parentId, this.actor.items);
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
    const parentId = this.#getInventoryContextParentId(zone);
    const targetItem = this.#getTargetStackItem(zone, sourceItemId, parentId);
    const targetHasStackRoom = targetItem
      && this.#areStackable(this.#draggedItemData, targetItem)
      && (getItemQuantity(targetItem) < getItemMaxStack(targetItem));
    if (targetHasStackRoom) {
      this.#applyInventoryPlacementPreview(normalizeInventoryPlacement(targetItem.system?.placement ?? {}, targetItem, this.actor.items), parentId);
      return;
    }

    const placement = createInventoryPlacement(
      toInteger(zone.dataset.x),
      toInteger(zone.dataset.y),
      this.#draggedItemData,
      this.actor.items
    );
    const excludeItemIds = sourceItemId ? [sourceItemId] : [];
    if (!this.#isInventoryPlacementAvailable(placement, excludeItemIds, [], parentId)) return;
    this.#applyInventoryPlacementPreview(placement, parentId);
  }

  #applyInventoryPlacementPreview(placement, parentId = ROOT_CONTAINER_ID) {
    if (!placement) return;
    const escapedParentId = CSS.escape(parentId);
    for (let y = placement.y; y < (placement.y + placement.height); y += 1) {
      for (let x = placement.x; x < (placement.x + placement.width); x += 1) {
        this.element?.querySelector(
          `[data-inventory-cell][data-inventory-parent-id="${escapedParentId}"][data-x="${x}"][data-y="${y}"]`
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
    this.element?.querySelectorAll(".drop-match-preview").forEach(element => {
      element.classList.remove("drop-match-preview");
    });
  }

  #clearDragPreviewCache() {
    this.#draggedItemData = null;
    this.#draggedItemId = "";
    this.#dragPreviewSourceKey = "";
  }

  #clearInventoryDraggingState() {
    this.element?.querySelectorAll(".dragging").forEach(element => {
      element.classList.remove("dragging");
    });
  }

  #getPlacementForDropZone(zone, itemData = null, excludeItemIds = [], parentId = ROOT_CONTAINER_ID) {
    if (zone.dataset.inventoryCell !== undefined) {
      return createInventoryPlacement(toInteger(zone.dataset.x), toInteger(zone.dataset.y), itemData, this.actor.items);
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

    return this.#getFirstAvailableInventoryPlacement(itemData, excludeItemIds, [], parentId);
  }

  #getInventoryGridDimensions(parentId = ROOT_CONTAINER_ID) {
    if (parentId && (parentId !== ROOT_CONTAINER_ID)) {
      return getContainerDimensions(this.actor.items.get(parentId));
    }
    return getInventoryGridDimensions(this.#getCurrentRace());
  }

  #getFirstAvailableInventoryPlacement(itemData = null, excludeItemIds = [], reservedPlacements = [], parentId = ROOT_CONTAINER_ID) {
    const { columns, rows } = this.#getInventoryGridDimensions(parentId);
    return findFirstAvailableInventoryPlacement(
      this.#getContextInventoryItems(parentId),
      columns,
      rows,
      itemData,
      this.actor.items,
      excludeItemIds,
      reservedPlacements
    );
  }

  #isInventoryPlacementAvailable(placement, excludeItemIds = [], reservedPlacements = [], parentId = ROOT_CONTAINER_ID) {
    const { columns, rows } = this.#getInventoryGridDimensions(parentId);
    return isInventoryPlacementAvailable(
      placement,
      this.#getContextInventoryItems(parentId),
      columns,
      rows,
      this.actor.items,
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
    const data = this.#getDragEventData(event);
    if (data?.type !== "Item") {
      this.#clearDragPreviewCache();
      return null;
    }

    const sourceKey = this.#getDragPreviewSourceKey(data);
    if (this.#draggedItemData && sourceKey && (sourceKey === this.#dragPreviewSourceKey)) return this.#draggedItemData;

    const ownedItem = data.itemId ? this.actor.items.get(data.itemId) : null;
    if (ownedItem) {
      this.#draggedItemId = ownedItem.id;
      this.#dragPreviewSourceKey = sourceKey;
      this.#draggedItemData = ownedItem.toObject();
      return this.#draggedItemData;
    }

    const droppedDocument = data.uuid ? foundry.utils.fromUuidSync(data.uuid) : null;
    if (droppedDocument instanceof Item) {
      this.#dragPreviewSourceKey = sourceKey;
      this.#draggedItemData = droppedDocument.toObject();
      return this.#draggedItemData;
    }
    this.#clearDragPreviewCache();
    return null;
  }

  #getDragPreviewSourceKey(data = {}) {
    if (data?.itemId) return `owned:${data.itemId}`;
    if (data?.uuid) return `uuid:${data.uuid}`;
    if (data?._id) return `id:${data._id}`;
    return "";
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

  #getTargetStackItem(target, sourceItemId = "", parentId = ROOT_CONTAINER_ID) {
    const itemElement = target?.closest?.("[data-item-id]");
    if (itemElement && itemElement.dataset.itemId !== sourceItemId) {
      if (!itemElement.closest("[data-inventory-grid]")) return null;
      if (String(itemElement.dataset.inventoryParentId ?? ROOT_CONTAINER_ID) !== String(parentId ?? ROOT_CONTAINER_ID)) return null;
      return this.actor.items.get(itemElement.dataset.itemId) ?? null;
    }

    const cell = target?.closest?.("[data-inventory-cell]");
    if (!cell) return null;
    const x = toInteger(cell.dataset.x);
    const y = toInteger(cell.dataset.y);
    return this.#getContextInventoryItems(parentId).find(item => {
      if (item.id === sourceItemId) return false;
      const placement = normalizeInventoryPlacement(item.system?.placement ?? {}, item, this.actor.items);
      return placement.mode === "inventory" && placementContainsInventoryCell(placement, x, y);
    }) ?? null;
  }

  async #moveOwnedItem(item, placement, targetItem = null, parentId = ROOT_CONTAINER_ID) {
    if (placement.mode === "inventory") {
      return this.#insertItemIntoInventory(item.toObject(), placement, { sourceItem: item, targetItem, parentId });
    }

    const resolvedPlacement = this.#resolvePlacement(item.toObject(), placement, [item.id]);
    if (!resolvedPlacement) return null;
    const storedPlacement = createStoredPlacement(resolvedPlacement, item);
    const wasEquipment = item.system?.placement?.mode === "equipment";
    const isEquipment = resolvedPlacement.mode === "equipment";
    const updateData = {
      "system.equipped": isEquipment ? true : (wasEquipment ? false : Boolean(item.system?.equipped)),
      "system.container.parentId": ROOT_CONTAINER_ID,
      "system.placement.mode": storedPlacement.mode,
      "system.placement.equipmentSlot": storedPlacement.equipmentSlot,
      "system.placement.weaponSet": storedPlacement.weaponSet,
      "system.placement.weaponSlot": storedPlacement.weaponSlot,
      "system.placement.x": storedPlacement.x,
      "system.placement.y": storedPlacement.y,
      "system.placement.width": storedPlacement.width,
      "system.placement.height": storedPlacement.height
    };
    if (!this.#validateProjectedInventoryState({ updates: [{ _id: item.id, ...updateData }] })) return null;
    return item.update(updateData);
  }

  async #createOrStackDroppedItem(itemData, placement, targetItem = null, parentId = ROOT_CONTAINER_ID) {
    if (!itemData) return null;
    if (placement.mode === "inventory") {
      return this.#insertItemIntoInventory(itemData, placement, { targetItem, parentId });
    }

    const resolvedPlacement = this.#resolvePlacement(itemData, placement);
    if (!resolvedPlacement) return null;
    const storedPlacement = createStoredPlacement(resolvedPlacement, itemData);

    const createData = foundry.utils.deepClone(itemData);
    delete createData._id;
    foundry.utils.mergeObject(createData, {
      system: {
        equipped: resolvedPlacement.mode === "equipment",
        container: {
          parentId: ROOT_CONTAINER_ID
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
    if (!this.#validateProjectedInventoryState({ creates: [createData] })) return null;
    return this.actor.createEmbeddedDocuments("Item", [createData]);
  }

  async #insertItemIntoInventory(itemData, requestedPlacement, { sourceItem = null, targetItem = null, parentId = ROOT_CONTAINER_ID } = {}) {
    const maxStack = getItemMaxStack(itemData);
    let remainingQuantity = Math.max(1, getItemQuantity(itemData));
    const excludedIds = [sourceItem?.id ?? ""].filter(Boolean);
    const preferredPlacement = normalizeInventoryPlacement(requestedPlacement, itemData, this.actor.items);
    const stackTargets = this.#findCompatibleStackTargets(itemData, targetItem, excludedIds, parentId);
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
        parentId,
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
      const storedPlacement = createStoredPlacement(sourcePlacement, sourceItem);
      sourceUpdate = {
        _id: sourceItem.id,
        "system.quantity": sourceQuantity,
        "system.equipped": false,
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
      deleteSource = false;
    }

    let nextPlacement = this.#isInventoryPlacementAvailable(preferredPlacement, excludedIds, reservedPlacements, parentId)
      ? preferredPlacement
      : null;
    while (remainingQuantity > 0) {
      const stackQuantity = Math.min(remainingQuantity, maxStack);
      const placement = nextPlacement ?? this.#getFirstAvailableInventoryPlacement(itemData, excludedIds, reservedPlacements, parentId);
      if (!placement) {
        this.#warnInventoryNoSpace();
        return null;
      }

      createData.push(this.#createInventoryStackData(itemData, stackQuantity, placement, parentId));
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

  #findCompatibleStackTargets(itemData, preferredTarget = null, excludeItemIds = [], parentId = ROOT_CONTAINER_ID) {
    const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
    const targets = [];
    const canUsePreferredTarget = preferredTarget
      && !excluded.has(preferredTarget.id)
      && (getItemContainerParentId(preferredTarget) === parentId)
      && preferredTarget.system?.placement?.mode === "inventory"
      && this.#areStackable(itemData, preferredTarget)
      && (getItemQuantity(preferredTarget) < getItemMaxStack(preferredTarget));
    if (canUsePreferredTarget) targets.push(preferredTarget);

    for (const item of this.#getContextInventoryItems(parentId)) {
      if (!item || excluded.has(item.id)) continue;
      if (targets.some(target => target.id === item.id)) continue;
      if (!this.#areStackable(itemData, item)) continue;
      if (getItemQuantity(item) >= getItemMaxStack(item)) continue;
      targets.push(item);
    }

    return targets;
  }

  #getSourceInventoryPlacement(
    sourceItem,
    itemData,
    parentId = ROOT_CONTAINER_ID,
    preferredPlacement = null,
    targetItem = null,
    reservedPlacements = []
  ) {
    const excludedIds = [sourceItem.id, targetItem?.id ?? ""].filter(Boolean);
    const currentPlacement = (
      sourceItem.system?.placement?.mode === "inventory"
      && (getItemContainerParentId(sourceItem) === parentId)
    )
      ? normalizeInventoryPlacement(sourceItem.system?.placement ?? {}, itemData, this.actor.items)
      : null;

    if (targetItem && currentPlacement && this.#isInventoryPlacementAvailable(currentPlacement, excludedIds, reservedPlacements, parentId)) {
      return currentPlacement;
    }
    if (preferredPlacement && this.#isInventoryPlacementAvailable(preferredPlacement, excludedIds, reservedPlacements, parentId)) {
      return preferredPlacement;
    }
    if (currentPlacement && this.#isInventoryPlacementAvailable(currentPlacement, excludedIds, reservedPlacements, parentId)) {
      return currentPlacement;
    }
    return this.#getFirstAvailableInventoryPlacement(itemData, excludedIds, reservedPlacements, parentId);
  }

  #createInventoryStackData(itemData, quantity, placement, parentId = ROOT_CONTAINER_ID) {
    const createData = foundry.utils.deepClone(itemData);
    delete createData._id;
    const storedPlacement = createStoredPlacement(placement, itemData);
    foundry.utils.mergeObject(createData, {
      system: {
        quantity,
        equipped: false,
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

  #validateProjectedInventoryState({ updates = [], deletes = [], creates = [] } = {}) {
    const projectedItems = this.#projectInventoryState({ updates, deletes, creates });
    const validation = validateInventoryTree(projectedItems, getInventoryGridDimensions(this.#getCurrentRace()));
    if (validation.valid) return true;
    this.#warnInventoryValidation(validation);
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

  #warnInventoryValidation(validation) {
    if (validation?.reason === "recursive") {
      ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Messages.ContainerRecursiveError"));
      return;
    }
    if (validation?.reason === "max-load") {
      ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Messages.ContainerMaxLoadExceeded"));
      return;
    }
    this.#warnInventoryNoSpace();
  }

  #resolvePlacement(itemData, placement, excludeItemIds = [], reservedPlacements = [], parentId = ROOT_CONTAINER_ID) {
    if (placement.mode === "inventory") {
      return this.#resolveInventoryPlacement(itemData, placement, excludeItemIds, reservedPlacements, parentId);
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

  #resolveInventoryPlacement(itemData, placement, excludeItemIds = [], reservedPlacements = [], parentId = ROOT_CONTAINER_ID) {
    const normalizedPlacement = normalizeInventoryPlacement(placement, itemData, this.actor.items);
    return this.#isInventoryPlacementAvailable(normalizedPlacement, excludeItemIds, reservedPlacements, parentId)
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
      && serializeItemFunctions(sourceSystem.functions) === serializeItemFunctions(targetSystem.functions)
    );
  }

  #showInventoryContextMenu(item, event) {
    this.#closeInventoryContextMenu();
    const isSlottedEquipment = item.system?.placement?.mode === "equipment";
    const isEquipped = Boolean(item.system?.equipped);
    const isContainer = isContainerItem(item);
    const menu = document.createElement("nav");
    menu.className = "fallout-maw-inventory-context-menu";
    const menuOptions = [
      ["edit", "fa-pen-to-square", game.i18n.localize("FALLOUTMAW.Common.Edit")]
    ];
    if (isContainer) {
      menuOptions.push(["open", "fa-box-open", game.i18n.localize("FALLOUTMAW.Item.Open")]);
    }
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
      if (action === "open") return this.#openContainerSheet(item);
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

  #openContainerSheet(item) {
    if (!isContainerItem(item)) return null;
    const app = new FalloutMaWContainerSheet({ document: item });
    app.render({ force: true });
    app.bringToFront();
    return app;
  }

  async #copyInventoryItem(item) {
    const data = item.toObject();
    delete data._id;
    const parentId = getItemContainerParentId(item);
    const placement = this.#getFirstAvailableInventoryPlacement(data, [], [], parentId);
    if (!placement) {
      this.#warnInventoryNoSpace();
      return null;
    }
    foundry.utils.setProperty(data, "system.container.parentId", parentId);
    foundry.utils.setProperty(data, "system.placement", createStoredPlacement(placement, item));
    if (!this.#validateProjectedInventoryState({ creates: [data] })) return null;
    return this.actor.createEmbeddedDocuments("Item", [data]);
  }

  async #equipInventoryItem(item) {
    const race = this.#getCurrentRace();
    const selectedSlots = getRaceEquipmentSlotsForItem(race, item);
    if (!selectedSlots.length) {
      const updateData = {
        "system.equipped": true,
        "system.container.parentId": ROOT_CONTAINER_ID
      };
      if (!this.#validateProjectedInventoryState({ updates: [{ _id: item.id, ...updateData }] })) return null;
      return item.update(updateData);
    }

    const blocked = selectedSlots.some(slot => Boolean(this.#getEquipmentItemForSlot(slot, item.id)));
    if (blocked) {
      const updateData = {
        "system.equipped": true,
        "system.container.parentId": ROOT_CONTAINER_ID
      };
      if (!this.#validateProjectedInventoryState({ updates: [{ _id: item.id, ...updateData }] })) return null;
      return item.update(updateData);
    }

    const slot = selectedSlots[0];
    const storedPlacement = createStoredPlacement({
      mode: "equipment",
      equipmentSlot: slot.key,
      weaponSet: "",
      weaponSlot: "",
      x: 1,
      y: 1
    }, item);
    const updateData = {
      "system.equipped": true,
      "system.container.parentId": ROOT_CONTAINER_ID,
      "system.placement.mode": storedPlacement.mode,
      "system.placement.equipmentSlot": storedPlacement.equipmentSlot,
      "system.placement.weaponSet": storedPlacement.weaponSet,
      "system.placement.weaponSlot": storedPlacement.weaponSlot,
      "system.placement.x": storedPlacement.x,
      "system.placement.y": storedPlacement.y,
      "system.placement.width": storedPlacement.width,
      "system.placement.height": storedPlacement.height
    };
    if (!this.#validateProjectedInventoryState({ updates: [{ _id: item.id, ...updateData }] })) return null;
    return item.update(updateData);
  }

  async #unequipInventoryItem(item) {
    const currentPlacement = item.system?.placement ?? {};
    const placement = (
      currentPlacement.mode === "inventory"
      && !getItemContainerParentId(item)
    )
      ? normalizeInventoryPlacement(currentPlacement, item, this.actor.items)
      : this.#getFirstAvailableInventoryPlacement(item, [item.id], [], ROOT_CONTAINER_ID);
    if (!placement) {
      this.#warnInventoryNoSpace();
      return null;
    }
    const storedPlacement = createStoredPlacement(placement, item);
    const updateData = {
      "system.equipped": false,
      "system.container.parentId": ROOT_CONTAINER_ID,
      "system.placement.mode": storedPlacement.mode,
      "system.placement.equipmentSlot": storedPlacement.equipmentSlot,
      "system.placement.weaponSet": storedPlacement.weaponSet,
      "system.placement.weaponSlot": storedPlacement.weaponSlot,
      "system.placement.x": storedPlacement.x,
      "system.placement.y": storedPlacement.y,
      "system.placement.width": storedPlacement.width,
      "system.placement.height": storedPlacement.height
    };
    if (!this.#validateProjectedInventoryState({ updates: [{ _id: item.id, ...updateData }] })) return null;
    return item.update(updateData);
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
    const totalWeight = Number(getItemTotalWeight(item, this.actor.items).toFixed(1));
    const totalPrice = unitPrice * quantity;
    const currencyLabel = currency?.label ? ` ${currency.label}` : "";
    const containerLine = isContainerItem(item)
      ? `<span>${game.i18n.localize("FALLOUTMAW.Item.ContainerCurrentLoad")}: ${formatWeight(getContainerContentsWeight(item, this.actor.items))} / ${formatWeight(getContainerMaxLoad(item))} ${game.i18n.localize("FALLOUTMAW.Common.Kg")}</span>`
      : "";

    const tooltip = document.createElement("aside");
    tooltip.className = "fallout-maw-inventory-tooltip";
    tooltip.innerHTML = `
      <strong>${escapeHTML(item.name)}</strong>
      <span>${game.i18n.localize("FALLOUTMAW.Item.Weight")}: ${formatNumber(unitWeight)} / ${formatNumber(totalWeight)} ${game.i18n.localize("FALLOUTMAW.Common.Kg")}</span>
      <span>${game.i18n.localize("FALLOUTMAW.Item.Price")}: ${formatNumber(unitPrice)}${currencyLabel} / ${formatNumber(totalPrice)}${currencyLabel}</span>
      ${containerLine}
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

  #getFullscreenSheetPosition(position = {}) {
    const view = this.element?.ownerDocument?.defaultView ?? window;
    const viewportWidth = view.innerWidth || document.documentElement?.clientWidth || 1280;
    const viewportHeight = view.innerHeight || document.documentElement?.clientHeight || 720;
    const margin = 0;

    return foundry.utils.mergeObject({
      left: margin,
      top: margin,
      width: Math.max(320, viewportWidth - (margin * 2)),
      height: Math.max(240, viewportHeight - (margin * 2))
    }, position ?? {}, { inplace: false, overwrite: false });
  }

  #bindViewportResize() {
    const view = this.element?.ownerDocument?.defaultView ?? window;
    if (this.#viewportResizeHandler) return;
    this.#viewportResizeHandler = () => this.setPosition();
    view.addEventListener("resize", this.#viewportResizeHandler);
  }

  #unbindViewportResize() {
    if (!this.#viewportResizeHandler) return;
    const view = this.element?.ownerDocument?.defaultView ?? window;
    view.removeEventListener("resize", this.#viewportResizeHandler);
    this.#viewportResizeHandler = null;
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

function serializeItemFunctions(functions = {}) {
  return JSON.stringify(functions ?? {});
}

function getInventoryGridDimensions(race) {
  const inventorySize = race?.inventorySize ?? createDefaultInventorySize();
  return {
    columns: Math.max(1, toInteger(inventorySize.columns)),
    rows: Math.max(1, toInteger(inventorySize.rows))
  };
}

function getItemQuantity(itemOrSystem) {
  return getItemQuantityHelper(itemOrSystem);
}

function getItemMaxStack(itemOrSystem) {
  return getItemMaxStackHelper(itemOrSystem);
}

function getItemFootprint(itemOrSystem) {
  return getItemFootprintHelper(itemOrSystem);
}

function createInventoryPlacement(x = 1, y = 1, itemOrSystem = null, items = null) {
  return createInventoryPlacementHelper(x, y, itemOrSystem, items);
}

function normalizeInventoryPlacement(placement = {}, itemOrSystem = null, items = null) {
  return normalizeInventoryPlacementHelper(placement, itemOrSystem, items);
}

function placementContainsInventoryCell(placement, x, y) {
  return placementContainsInventoryCellHelper(placement, x, y);
}

function isInventoryPlacementAvailable(placement, items, columns, rows, allItems = items, excludeItemIds = [], reservedPlacements = []) {
  return isInventoryPlacementAvailableHelper(placement, items, columns, rows, allItems, excludeItemIds, reservedPlacements);
}

function findFirstAvailableInventoryPlacement(items, columns, rows, itemOrSystem = null, allItems = items, excludeItemIds = [], reservedPlacements = []) {
  return findFirstAvailableInventoryPlacementHelper(items, columns, rows, itemOrSystem, allItems, excludeItemIds, reservedPlacements);
}

function buildInventoryCellStyle(x, y, placement = null) {
  return buildInventoryCellStyleHelper(x, y, placement);
}

function prepareInventoryContext(actor, race) {
  const currencies = getCurrencySettings();
  const { columns, rows } = getInventoryGridDimensions(race);
  const allItems = actor.items.contents;
  const allItemData = allItems.map(item => createInventoryItemData(item, allItems, currencies));
  const assignedItemIds = new Set();
  const topLevelItems = allItemData.filter(item => !item.parentId);

  const equipmentSlots = (race?.equipmentSlots ?? []).map(slot => {
    const item = topLevelItems.find(candidate => (
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
      const item = topLevelItems.find(candidate => (
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

  const inventoryItems = allItems.filter(item => (
    !assignedItemIds.has(item.id)
    && !getItemContainerParentId(item)
  ));
  const grid = prepareInventoryGridContext(inventoryItems, columns, rows, allItems, (item, placement) => ({
    ...createInventoryItemData(item, allItems, currencies, placement),
    gridStyle: buildInventoryCellStyle(placement.x, placement.y, placement)
  }));
  const containers = topLevelItems
    .filter(item => item.isContainer && item.equipped)
    .map(item => {
      const containerDocument = actor.items.get(item.id);
      const dimensions = getContainerDimensions(containerDocument);
      const contents = getContextInventoryItems(item.id, allItems);
      const containerLoadValue = Math.max(0, Number(getContainerContentsWeight(containerDocument, allItems)) || 0);
      const containerLoadMax = Math.max(0, Number(getContainerMaxLoad(containerDocument)) || 0);
      const containerLoadRatio = containerLoadMax > 0 ? (containerLoadValue / containerLoadMax) : 0;
      return {
        ...item,
        grid: prepareInventoryGridContext(contents, dimensions.columns, dimensions.rows, allItems, (childItem, placement) => ({
          ...createInventoryItemData(childItem, allItems, currencies, placement),
          gridStyle: buildInventoryCellStyle(placement.x, placement.y, placement)
        })),
        load: {
          value: formatWeight(containerLoadValue),
          max: formatWeight(containerLoadMax),
          percent: Number(Math.max(0, Math.min(100, containerLoadRatio * 100)).toFixed(2)),
          trend: "negative",
          state: containerLoadRatio >= 1 ? "critical" : containerLoadRatio >= 0.75 ? "warning" : "normal"
        }
      };
    });

  return {
    equipmentSlots,
    weaponSets,
    containers,
    grid
  };
}

function createInventoryItemData(item, allItems, currencies = [], placement = null) {
  const resolvedPlacement = placement ?? normalizeInventoryPlacement(item.system?.placement ?? {}, item, allItems);
  const container = item.system?.container ?? {};
  return {
    id: item.id,
    uuid: item.uuid,
    name: item.name,
    img: item.img,
    type: item.type,
    quantity: getItemQuantity(item),
    maxStack: getItemMaxStack(item),
    showQuantity: getItemMaxStack(item) > 1,
    weight: Number(item.system?.weight) || 0,
    totalWeight: Number(getItemTotalWeight(item, allItems).toFixed(1)),
    price: Number(item.system?.price) || 0,
    priceCurrency: item.system?.priceCurrency ?? "",
    priceCurrencyLabel: currencies.find(currency => currency.key === item.system?.priceCurrency)?.label ?? "",
    equipped: Boolean(item.system?.equipped),
    occupiedSlots: item.system?.occupiedSlots ?? {},
    itemFunction: item.system?.itemFunction ?? "",
    isContainer: isContainerItem(item),
    parentId: getItemContainerParentId(item),
    placement: resolvedPlacement,
    container: {
      parentId: String(container.parentId ?? ""),
      columns: Math.max(1, toInteger(container.columns) || 1),
      rows: Math.max(1, toInteger(container.rows) || 1),
      maxLoad: Math.max(0, Number(container.maxLoad) || 0)
    }
  };
}

function prepareEffectCategories(effects = []) {
  const categories = [
    {
      key: "temporary",
      label: game.i18n.localize("FALLOUTMAW.Effects.KindTemporary"),
      effects: []
    },
    {
      key: "active",
      label: game.i18n.localize("FALLOUTMAW.Effects.KindActive"),
      effects: []
    },
    {
      key: "passive",
      label: game.i18n.localize("FALLOUTMAW.Effects.KindPassive"),
      effects: []
    },
    {
      key: "inactive",
      label: game.i18n.localize("FALLOUTMAW.Effects.KindInactive"),
      effects: []
    }
  ];
  const categoryMap = new Map(categories.map(category => [category.key, category]));

  for (const effect of effects) {
    effect.updateDuration?.();
    const kind = effect.disabled ? "inactive" : getEffectCategoryKey(effect);
    categoryMap.get(kind)?.effects.push({
      id: effect.id,
      name: effect.name,
      img: effect.img,
      disabled: effect.disabled,
      changes: effect.system?.changes?.length ?? effect.changes?.length ?? 0,
      duration: getEffectDurationLabel(effect)
    });
  }

  return categories;
}

function getEffectCategoryKey(effect) {
  const kind = String(effect.getFlag("fallout-maw", "kind") || "");
  if (["temporary", "active", "passive"].includes(kind)) return kind;
  if (effect.isTemporary) return "temporary";
  return "active";
}

function getEffectDurationLabel(effect) {
  if (!effect.duration?.remaining) return "";
  return effect.duration.label ?? "";
}
