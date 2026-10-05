import { localize as auditLocalize } from "../utils/i18n.mjs";
import { TEMPLATES } from "../constants.mjs";
import { executeInventoryMutation } from "../inventory/mutation.mjs";
import { canDropItemsForActor, commitInventoryWithDroppedItems } from "../items/dropped-items.mjs";
import { planConstructStructureDepartures } from "./construct-structure-departures.mjs";
import { FalloutMaWFormApplicationV2 } from "./base-form-application-v2.mjs";
import { ConstructVisualEditor } from "./construct-visual-editor.mjs";
import { ConstructSystemsConfig } from "./construct-systems-config.mjs";
import { createConstructHubDraftActor } from "./construct-hub-draft.mjs";
import { captureConstructHubView, restoreConstructHubView, getConstructHubDetailKey } from "./construct-hub-view-state.mjs";
import { getActorContainerFlag } from "../utils/actor-containers.mjs";
import { getConstructSystemState } from "../utils/construct-systems.mjs";
import {
  ITEM_FUNCTIONS,
  getConditionFunction,
  getEnabledWeaponFunctions,
  hasItemFunction
} from "../utils/item-functions.mjs";
import {
  clipperDifference,
  clipperIntersect,
  getPathsArea,
  getPathsBounds,
  normalizeLimbSilhouette,
  normalizePaths
} from "../utils/limb-silhouette.mjs";
import { toInteger } from "../utils/numbers.mjs";
import {
  createConstructPartSlotFromItem,
  getConstructPartLimbKey,
  getConstructPartSlots,
  getConstructPartTypeLabel,
  getInstalledConstructPartForSlot
} from "../utils/construct-parts.mjs";
import { getActorInventoryGridDimensions, getActorRootInventoryGridOptions, prepareInventoryContext } from "../utils/actor-display-data.mjs";
import {
  ROOT_CONTAINER_ID,
  createStoredPlacement,
  findFirstAvailableInventoryPlacement,
  getAllContainedItems,
  getContainerContentsWeight,
  getContainerInventoryGridOptions,
  getContainerMaxLoad,
  getContextInventoryItems,
  getItemQuantity,
  getItemTotalWeight,
  isContainerItem
} from "../utils/inventory-containers.mjs";
import { applyDestroyedLimbConsequences, clearLimbLossState, isLimbDestroyed } from "../combat/damage-hub.mjs";

export class ConstructStructureApplication extends FalloutMaWFormApplicationV2 {
  #entries = [];
  #draggedEntryId = "";
  #dropCommitted = false;
  #previewDirty = false;
  #visual;
  #systems;
  #selectedSlotId = "";
  #itemDrafts = new Map();
  #itemChanges = new Map();
  #events;
  #dirty = false;
  #saving = false;
  #details = new Map();

  constructor(actor, options = {}) {
    super(options);
    this.actor = actor;
    this.#entries = getOwnedConstructPartEntries(actor);
    this.#selectedSlotId = this.#entries[0]?.slot.id ?? "";
    this.#systems = new ConstructSystemsConfig(actor).attachHub(this);
    this.#visual = new ConstructVisualEditor(actor).attachHub(this);
  }

  static DEFAULT_OPTIONS = {
    ...FalloutMaWFormApplicationV2.DEFAULT_OPTIONS,
    id: "fallout-maw-construct-structure",
    classes: ["fallout-maw", "fallout-maw-config-form", "fallout-maw-construct-structure", "construct-visual-editor", "construct-hub"],
    position: {
      width: 1240,
      height: 880
    },
    window: {
      get title() { return auditLocalize("FALLOUTMAW.AuditApps.ConstructStructure", "Строение конструкта"); },
      resizable: true
    },
    form: {
      handler: FalloutMaWFormApplicationV2.handleFormSubmit,
      submitOnChange: false,
      closeOnSubmit: false
    }
  };

  static PARTS = {
    body: {
      template: TEMPLATES.constructStructure
    }
  };

  async _prepareContext(options) {
    // Existing game servers may retain the old package manifest until restart.
    // Load this panel's style when opened so a client refresh is sufficient.
    const doc = globalThis.document;
    if (doc) {
      const href = new URL("systems/fallout-maw/styles/construct-hub.css", doc.baseURI).href;
      if (!Array.from(doc.querySelectorAll('link[rel="stylesheet"]')).some(link => link.href === href)) {
        const link = doc.createElement("link"); link.rel = "stylesheet"; link.href = href;
        doc.head.append(link);
      }
    }
    const context = await super._prepareContext(options);
    if (!this.#entries.some(entry => entry.slot.id === this.#selectedSlotId)) this.#selectedSlotId = this.#entries[0]?.slot.id ?? "";
    const visual = await this.#visual._prepareContext(options);
    const systems = await this.#systems._prepareContext(options);
    visual.selectedPart = visual.parts.find(part => part.slotId === this.#selectedSlotId);
    visual.selectedInterior = visual.interior.find(part => part.slotId === this.#selectedSlotId);
    const passengers = getActorContainerFlag(this.actor).passengers;
    visual.seats = visual.seats.map(seat => ({ ...seat,
      occupant: passengers.find(row => row.slotId === seat.slotId && row.slotIndex === seat.slotIndex),
      controlledPart: visual.parts.find(part => part.slotId === seat.partSlotId)?.label }));
    visual.selectedSeat = visual.seats.find(seat => seat.selected);
    const selectedEntry = this.#entries.find(entry => entry.slot.id === this.#selectedSlotId);
    const draftActor = this.draftActor;
    const selectedItem = selectedEntry && draftActor.items.get(selectedEntry.itemId || selectedEntry.draftItemId);
    const weapons = this.actor.items.contents.filter(item => String(item.system?.placement?.weaponSet ?? "").startsWith(
      `container:constructPart:${this.#selectedSlotId}:`)).map(item => ({ id: item.id, name: item.name, img: item.img }));
    if (selectedItem && getEnabledWeaponFunctions(selectedItem, { ignoreBroken: true }).length) {
      weapons.unshift({ id: selectedItem.id, name: selectedItem.name, img: selectedItem.img });
    }
    const contributions = (selectedItem?.system?.functions?.constructPart?.systems ?? []).map((row, index) => ({ ...row, index,
      choices: systems.systems.map(system => ({ ...system, selected: system.id === row.systemId })) }));
    const partials = ["preview", "part", "anchor", "seat", "interior"];
    const html = await Promise.all(partials.map(name => foundry.applications.handlebars.renderTemplate(
      `systems/fallout-maw/templates/actor/construct-hub-${name}.hbs`, visual)));
    const systemHtml = await foundry.applications.handlebars.renderTemplate(
      "systems/fallout-maw/templates/actor/construct-hub-system.hbs", systems);
    return foundry.utils.mergeObject(context, {
      actor: this.actor,
      entries: this.#entries.map((entry, index) => ({ ...prepareConstructPartEntry({ ...entry,
        item: draftActor.items.get(entry.itemId || entry.draftItemId) ?? entry.item }, index),
        selected: entry.slot.id === this.#selectedSlotId,
        rotates: visual.parts.some(part => part.slotId === entry.slot.id && part.rotates),
        location: visual.interior.find(part => part.slotId === entry.slot.id)?.locationLabel,
        systemNames: (draftActor.items.get(entry.itemId || entry.draftItemId)?.system?.functions?.constructPart?.systems ?? [])
          .map(row => systems.systems.find(system => system.id === row.systemId)?.name).filter(Boolean).join(", ") })),
      hasEntries: this.#entries.length > 0, visual, systems,
      previewHtml: html[0], partHtml: html[1], anchorHtml: html[2], seatHtml: html[3], interiorHtml: html[4], systemHtml,
      selectedEntry: selectedEntry && { ...prepareConstructPartEntry({ ...selectedEntry, item: selectedItem },
        this.#entries.indexOf(selectedEntry)), item: selectedItem, contributions },
      dirty: this.#dirty,
      weapons,
      weaponSets: (selectedItem?.system?.functions?.constructPart?.weaponSets ?? []).map((row, index) => ({ ...row, index }))
    }, { inplace: false });
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#events?.abort(); this.#events = new AbortController();
    const listenerOptions = { signal: this.#events.signal };
    await this.#visual._onRender(context, options);
    await this.#systems._onRender(context, options);
    this.element.addEventListener("click", event => void this.#onHubClick(event), listenerOptions);
    this.element.addEventListener("change", event => this.#onHubChange(event), listenerOptions);
    this.element.addEventListener("input", event => this.#onHubChange(event), listenerOptions);
    for (const detail of this.element.querySelectorAll("details")) {
      const key = getConstructHubDetailKey(detail);
      detail.dataset.hubDetails = key;
      if (this.#details.has(key)) detail.open = this.#details.get(key);
      detail.addEventListener("toggle", () => this.#details.set(key, detail.open), listenerOptions);
    }
    const list = this.element?.querySelector("[data-construct-part-list]");
    list?.addEventListener("dragover", event => this.#onPartListDragOver(event));
    list?.addEventListener("drop", event => this.#onEntryListDrop(event));
    for (const card of this.element?.querySelectorAll("[data-construct-part-entry-id]") ?? []) {
      card.addEventListener("dragstart", event => this.#onEntryDragStart(event));
      card.addEventListener("dragend", event => this.#onEntryDragEnd(event));
      card.addEventListener("dragover", event => this.#onEntryDragOver(event));
      card.addEventListener("drop", event => this.#onEntryDrop(event));
    }
    for (const button of this.element?.querySelectorAll("[data-construct-part-remove]") ?? []) {
      button.addEventListener("click", event => this.#onRemoveEntry(event));
    }
  }

  _preSyncPartState(partId, newElement, priorElement, state) {
    super._preSyncPartState(partId, newElement, priorElement, state);
    state.constructHubView = captureConstructHubView(priorElement);
    state.focus = undefined;
    state.scrollPositions = [];
  }

  _syncPartState(partId, newElement, priorElement, state) {
    super._syncPartState(partId, newElement, priorElement, state);
    restoreConstructHubView(newElement, state.constructHubView, this.#details);
  }

  async _processFormData(_event, _form, _formData) {
    if (this.#saving || !this.actor.isOwner) return;
    const systems = this.#systems.getActorUpdate();
    const visual = this.#visual.getActorUpdate();
    if (!systems || !visual) return;
    this.#saving = true;
    const layout = this.element?.querySelector(".construct-hub-layout");
    if (layout) layout.inert = true;
    const save = this.element?.querySelector('[type="submit"]');
    if (save) save.disabled = true;
    try {
      if (!await this.#saveStructure({ ...systems, ...visual })) return;
      this.#entries = getOwnedConstructPartEntries(this.actor);
      this.#itemDrafts.clear(); this.#itemChanges.clear(); this.#dirty = false;
      ui.notifications?.info("Строение, модульная сборка, системы и экипаж сохранены.");
      await this.render();
    } finally {
      this.#saving = false;
      if (layout?.isConnected) layout.inert = false;
      if (save?.isConnected) save.disabled = false;
    }
  }

  get selectedSlotId() { return this.#selectedSlotId; }
  get draftActor() { return createConstructHubDraftActor(this.actor, this.#entries, this.#systems.draft, this.#itemDrafts); }
  // The shared base restores on the next animation frame, after intermediate layout changes.
  // This hub instead restores synchronously at replacement time, including its responsive outer scroller.
  static get scrollPreservationSelectors() { return []; }

  markDraftDirty() { this.#markDirty(); }

  syncDraftLabels() {
    const root = this.element;
    if (!root) return;
    for (const button of root.querySelectorAll('[data-action="selectVisualRecord"]')) {
      const row = this.#visual.draft[button.dataset.kind]?.[Number(button.dataset.index)];
      if (!row?.name) continue;
      const label = button.querySelector("strong");
      if (label) label.textContent = row.name;
      else button.textContent = row.name;
      button.title = row.name;
    }
    for (const system of this.#systems.draft) {
      for (const button of root.querySelectorAll('[data-action="selectSystem"]')) {
        if (button.dataset.systemId === system.id) button.textContent = button.title = system.name;
      }
      for (const label of root.querySelectorAll('label:has([data-system-id])')) {
        const input = label.querySelector('input[data-system-id]');
        if (input?.dataset.systemId === system.id) label.querySelector("span").textContent = system.name;
      }
    }
    const names = new Map([...this.#visual.draft.anchors, ...this.#systems.draft].map(row => [row.id, row.name]));
    for (const option of root.querySelectorAll("select option")) {
      if (names.has(option.value)) option.textContent = names.get(option.value);
    }
  }

  #markDirty() {
    this.#dirty = true;
    const status = this.element?.querySelector("[data-hub-save-status]");
    if (status) status.textContent = "Есть изменения";
  }

  #selectSlot(slotId) {
    this.#selectedSlotId = slotId; this.#visual.selectPartSlot(slotId);
    const entry = this.#entries.find(row => row.slot.id === slotId);
    const source = this.#itemDrafts.get(entry?.itemId) ?? entry?.item ?? entry?.itemData;
    const systemId = source?.system?.functions?.constructPart?.systems?.[0]?.systemId;
    if (systemId) this.#systems.selectSystemId(systemId);
  }

  #editableItem(slotId = this.#selectedSlotId) {
    const entry = this.#entries.find(row => row.slot.id === slotId);
    if (!entry?.installed) return null;
    if (!entry.itemId) return entry.itemData;
    if (!this.#itemDrafts.has(entry.itemId)) this.#itemDrafts.set(entry.itemId, { ...entry.item.toObject(), id: entry.itemId });
    return this.#itemDrafts.get(entry.itemId);
  }

  #setItemField(path, value, slotId = this.#selectedSlotId) {
    const item = this.#editableItem(slotId);
    if (!item) return;
    foundry.utils.setProperty(item, path, value);
    if (item.id && this.actor.items.has(item.id)) {
      const changes = this.#itemChanges.get(item.id) ?? { _id: item.id };
      const arrayPath = ["system.functions.constructPart.systems", "system.functions.constructPart.weaponSets"]
        .find(prefix => path.startsWith(`${prefix}.`));
      const updatePath = arrayPath ?? path;
      changes[updatePath] = foundry.utils.deepClone(foundry.utils.getProperty(item, updatePath));
      this.#itemChanges.set(item.id, changes);
    }
    this.#markDirty();
  }

  #onHubChange(event) {
    if (this.#saving) return;
    if (event.target.matches("[data-visual-key], [data-system-field]")) this.#markDirty();
    const field = event.target.closest("[data-hub-item-field]");
    if (!field) return;
    this.#setItemField(field.dataset.hubItemField, field.type === "checkbox" ? field.checked
      : field.type === "number" ? Number(field.value) : field.value);
    const state = getConstructSystemState(this.draftActor, this.#systems.selectedId);
    const values = this.element.querySelectorAll(".construct-system-summary strong");
    if (state && values.length === 2) {
      values[0].textContent = String(state.capacity); values[1].textContent = `${state.movementPoints} ОП`;
    }
    // Contribution values and weapon-set labels do not change form structure.
    // Keep the existing controls alive, including focus and the next button being clicked.
  }

  async #onHubClick(event) {
    const button = event.target.closest("button");
    if (!button || this.#saving) return;
    if (button.dataset.hubSelectPart) {
      event.preventDefault(); this.#selectSlot(button.dataset.hubSelectPart); return this.render();
    }
    if (button.dataset.hubOpenItem) {
      event.preventDefault(); return this.actor.items.get(button.dataset.hubOpenItem)?.sheet.render(true);
    }
    if (button.dataset.hubAction) {
      event.preventDefault();
      const item = this.#editableItem(); if (!item) return;
      const path = button.dataset.hubAction.includes("WeaponSet") ? "system.functions.constructPart.weaponSets" : "system.functions.constructPart.systems";
      const rows = foundry.utils.deepClone(foundry.utils.getProperty(item, path) ?? []);
      if (button.dataset.hubAction.startsWith("remove")) {
        if (path.endsWith("weaponSets") && this.actor.items.contents.some(weapon =>
          String(weapon.system?.placement?.weaponSet ?? "") === `container:constructPart:${this.#selectedSlotId}:${rows[Number(button.dataset.index)]?.id}`)) {
          ui.notifications.warn("Сначала снимите оружие с этого набора."); return;
        }
        rows.splice(Number(button.dataset.index), 1);
      } else if (path.endsWith("weaponSets")) rows.push({ id: foundry.utils.randomID(), label: "Оружие", quantity: 1 });
      else rows.push({ systemId: this.#systems.selectedId || this.#systems.draft[0]?.id || "", capacity: 0, movementPoints: 0, activationProvider: false });
      this.#setItemField(path, rows); return this.render();
    }
    if (!button.dataset.action) return;
    if (!ConstructVisualEditor.DEFAULT_OPTIONS.actions[button.dataset.action]
      && !ConstructSystemsConfig.DEFAULT_OPTIONS.actions[button.dataset.action]) return;
    if (button.dataset.action === "removeSystem") {
      const id = this.#systems.selectedId;
      for (const entry of this.#entries) {
        const source = this.#itemDrafts.get(entry.itemId) ?? entry.item ?? entry.itemData;
        const rows = source?.system?.functions?.constructPart?.systems ?? [];
        if (rows.some(row => row.systemId === id)) this.#setItemField("system.functions.constructPart.systems",
          rows.filter(row => row.systemId !== id), entry.slot.id);
      }
    }
    if (["addVisualAnchor", "placeVisualAnchor"].includes(button.dataset.action)) this.#details.set("anchors", true);
    if (!["selectVisualRecord", "selectSystem", "resetVisualAim", "resetPreviewCamera"].includes(button.dataset.action)) this.#markDirty();
    if (button.dataset.action === "selectVisualRecord" && button.dataset.kind === "parts") {
      const slotId = this.#visual.draft.parts[Number(button.dataset.index)]?.slotId;
      if (slotId) this.#selectedSlotId = slotId;
    }
    if (button.dataset.action === "selectVisualRecord" && button.dataset.kind === "seats") {
      const slotId = this.#visual.draft.seats[Number(button.dataset.index)]?.partSlotId;
      if (slotId) this.#selectSlot(slotId);
    }
    await this.#visual.dispatchHubAction(event, button) || await this.#systems.dispatchHubAction(event, button);
  }

  async close(options = {}) {
    this.#events?.abort(); this.#visual.disposeHub(); this.#systems.disposeHub();
    return super.close(options);
  }

  #onPartListDragOver(event) {
    event.preventDefault();
    const entryId = this.#readDraggedEntryId(event);
    if (event.dataTransfer) event.dataTransfer.dropEffect = entryId ? "move" : "copy";
    if (entryId) this.#previewEntryDrop(event);
  }

  async #onDropConstructPart(event) {
    event.preventDefault();
    event.stopPropagation();
    if (this.#saving) return;
    const data = readDropData(event);
    if (data?.type !== "Item") return;
    const item = await Item.implementation.fromDropData(data).catch(() => null);
    if (!isConstructPartItem(item)) {
      ui.notifications?.warn?.(auditLocalize("FALLOUTMAW.AuditApps.OnlyAnItemWithTheConstructPartFunction", "Можно добавить только предмет с функцией «Деталь конструкта»."));
      return;
    }

    if (item.parent === this.actor && this.#entries.some(entry => entry.itemId === item.id && entry.installed)) return;
    const preferredId = item.parent === this.actor
      && !this.#entries.some(entry => entry.slot?.id === item.id)
      ? item.id
      : foundry.utils.randomID();
    const slot = createConstructPartSlotFromItem(item, { id: preferredId, order: this.#entries.length });
    if (!slot) return;
    this.#entries.push(createConstructPartEntry(slot, {
      item: item.parent === this.actor ? item : null,
      itemData: item.parent === this.actor ? null : item.toObject(),
      installed: true
    }));
    this.#selectSlot(slot.id); this.#markDirty();
    return this.render();
  }

  #onEntryDragStart(event) {
    if (event.target?.closest?.("[data-construct-part-remove], button, input, select, textarea, a")) {
      event.preventDefault();
      return;
    }
    const entryId = event.currentTarget?.dataset?.constructPartEntryId ?? "";
    if (!entryId) return;
    this.#draggedEntryId = entryId;
    this.#dropCommitted = false;
    this.#previewDirty = false;
    event.currentTarget.classList.add("dragging");
    if (event.dataTransfer) {
      event.dataTransfer.setData("application/x-fallout-maw-construct-entry-id", entryId);
      event.dataTransfer.setData("text/plain", JSON.stringify({ type: "ConstructPartEntry", entryId }));
      event.dataTransfer.effectAllowed = "move";
    }
  }

  #onEntryDragEnd(event) {
    event.currentTarget?.classList.remove("dragging");
    this.element?.querySelector("[data-construct-part-list]")?.classList.remove("drag-preview-active");
    const shouldRestorePreview = this.#previewDirty && !this.#dropCommitted;
    this.#draggedEntryId = "";
    this.#dropCommitted = false;
    this.#previewDirty = false;
    if (shouldRestorePreview) return this.render();
  }

  #onEntryDragOver(event) {
    if (!this.#readDraggedEntryId(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    this.#previewEntryDrop(event);
  }

  async #onEntryDrop(event) {
    const entryId = this.#readDraggedEntryId(event);
    if (!entryId) return this.#onDropConstructPart(event);
    event.preventDefault();
    event.stopPropagation();
    this.#syncEntriesToPreviewOrder();
    this.#dropCommitted = true;
    this.#previewDirty = false;
    return this.render();
  }

  #onEntryListDrop(event) {
    const entryId = this.#readDraggedEntryId(event);
    if (entryId) {
      if (event.target?.closest?.("[data-construct-part-entry-id]")) return;
      event.preventDefault();
      event.stopPropagation();
      this.#syncEntriesToPreviewOrder();
      this.#dropCommitted = true;
      this.#previewDirty = false;
      return this.render();
    }
    return this.#onDropConstructPart(event);
  }

  #onRemoveEntry(event) {
    event.preventDefault();
    if (this.#saving) return;
    const entryId = event.currentTarget?.dataset?.constructPartRemove ?? "";
    if (!entryId) return;
    const entry = this.#entries.find(candidate => candidate.entryId === entryId);
    if (!entry) return;
    if (hasConstructPartWeaponOccupants(this.actor, entry.slot?.id)) {
      ui.notifications?.warn?.(auditLocalize("FALLOUTMAW.AuditApps.FirstRemoveTheWeaponsInstalledInThisConstruct", "Сначала снимите оружие, установленное в слоты этой детали конструкта."));
      return;
    }
    this.#entries = this.#entries.filter(candidate => candidate !== entry);
    this.#markDirty();
    return this.render();
  }

  #readDraggedEntryId(event) {
    return event.dataTransfer?.getData("application/x-fallout-maw-construct-entry-id") || this.#draggedEntryId;
  }

  #previewEntryDrop(event) {
    const entryId = this.#readDraggedEntryId(event);
    const list = this.element?.querySelector("[data-construct-part-list]");
    const draggedCard = Array.from(list?.querySelectorAll("[data-construct-part-entry-id]") ?? [])
      .find(element => element.dataset.constructPartEntryId === entryId);
    if (!list || !draggedCard) return;

    const targetCard = event.target?.closest?.("[data-construct-part-entry-id]");
    if (!targetCard || !list.contains(targetCard)) {
      if (draggedCard.nextElementSibling) {
        list.appendChild(draggedCard);
        this.#previewDirty = true;
      }
      list.classList.add("drag-preview-active");
      return;
    }

    if (targetCard === draggedCard) return;
    const rect = targetCard.getBoundingClientRect();
    const insertBefore = getComputedStyle(list).display === "grid"
      ? event.clientX < rect.left + (rect.width / 2) : event.clientY < rect.top + (rect.height / 2);
    const reference = insertBefore ? targetCard : targetCard.nextElementSibling;
    if (reference === draggedCard) return;
    list.insertBefore(draggedCard, reference);
    list.classList.add("drag-preview-active");
    this.#previewDirty = true;
  }

  #syncEntriesToPreviewOrder() {
    const list = this.element?.querySelector("[data-construct-part-list]");
    const orderedIds = Array.from(list?.querySelectorAll("[data-construct-part-entry-id]") ?? [])
      .map(element => element.dataset.constructPartEntryId)
      .filter(Boolean);
    if (!orderedIds.length) return;

    const entriesById = new Map(this.#entries.map(entry => [entry.entryId, entry]));
    const orderedEntries = orderedIds.map(id => entriesById.get(id)).filter(Boolean);
    const orderedIdSet = new Set(orderedIds);
    for (const entry of this.#entries) {
      if (!orderedIdSet.has(entry.entryId)) orderedEntries.push(entry);
    }
    this.#entries = orderedEntries;
    this.#markDirty();
  }

  async #saveStructure(extraActorUpdates = {}) {
    if (this.actor.type !== "construct") return;
    const updates = Array.from(this.#itemChanges.values()).filter(update => this.#entries.some(entry => entry.itemId === update._id));
    const createPlans = [];
    const droppedParts = [];
    const previousEntries = getOwnedConstructPartEntries(this.actor);
    const entriesBySlotId = new Map(this.#entries.map(entry => [entry.slot.id, entry]));
    const { removedSlotIds, deletedItemIds, detachedEntries } = planConstructStructureDepartures(
      previousEntries,
      this.#entries
    );
    const installedOwnedIds = new Set(
      this.#entries
        .filter(entry => entry.installed && entry.itemId)
        .map(entry => entry.itemId)
    );
    const installedSlotIds = [];
    const finalSlots = [];

    const { columns, rows } = getActorInventoryGridDimensions(this.actor, null);
    const detachedSlotIds = detachedEntries.map(({ entry }) => entry.slot.id);
    const detachedItems = detachedEntries.filter(({ item }) => !installedOwnedIds.has(item.id));
    const inventoryExcludeIds = Array.from(new Set([
      ...installedOwnedIds,
      ...detachedItems.map(({ item }) => item.id)
    ]));
    const reservedPlacements = [];
    const candidateParentIds = [
      ROOT_CONTAINER_ID,
      ...prepareInventoryContext(this.actor, null, { includeLocked: false }).containers
        .map(container => container.id)
        .filter(id => !deletedItemIds.includes(id) && !detachedItems.some(({ item }) => item.id === id))
    ];

    for (const { entry, item } of detachedItems) {
      if (hasConstructPartWeaponOccupants(this.actor, entry.slot.id)) {
        ui.notifications?.warn?.(auditLocalize("FALLOUTMAW.AuditApps.FirstRemoveTheWeaponsInstalledInThisConstruct", "Сначала снимите оружие, установленное в слоты этой детали конструкта."));
        return;
      }
      const placementContext = candidateParentIds
        .map(parentId => {
          const container = parentId ? this.actor.items.get(parentId) : null;
          if (parentId && !container) return null;
          const reserved = reservedPlacements.filter(entry => entry.parentId === parentId);
          if (container) {
            const contentsWeight = getContainerContentsWeight(container, this.actor.items);
            const reservedWeight = reserved.reduce((total, entry) => total + getItemTotalWeight(entry.item, this.actor.items), 0);
            if (contentsWeight + reservedWeight + getItemTotalWeight(item, this.actor.items) > getContainerMaxLoad(container) + 0.0001) return null;
          }
          const grid = container ? getContainerInventoryGridOptions(container) : { columns, rows };
          const placement = findFirstAvailableInventoryPlacement(
            getContextInventoryItems(parentId, this.actor.items),
            grid.columns,
            grid.rows,
            item,
            this.actor.items,
            inventoryExcludeIds,
            reserved.map(entry => entry.placement),
            container ? grid : getActorRootInventoryGridOptions(this.actor, ROOT_CONTAINER_ID)
          );
          return placement ? { parentId, placement, item } : null;
        })
        .find(Boolean);
      if (!placementContext) {
        droppedParts.push({
          data: item.toObject(),
          quantity: getItemQuantity(item),
          containedItems: isContainerItem(item)
            ? getAllContainedItems(item.id, this.actor.items).map(contained => contained.toObject())
            : []
        });
        deletedItemIds.push(item.id);
        continue;
      }
      reservedPlacements.push(placementContext);
      updates.push(createConstructPartInventoryUpdate(item, placementContext.placement, placementContext.parentId));
    }

    for (const [order, entry] of this.#entries.entries()) {
      const source = this.#itemDrafts.get(entry.itemId) ?? entry.item ?? entry.itemData;
      const slot = entry.installed && source
        ? createConstructPartSlotFromItem(source, { id: entry.slot.id, order })
        : { ...foundry.utils.deepClone(entry.slot), order };
      if (!slot) continue;
      finalSlots.push(slot);
      entry.slot = slot;

      if (!entry.installed) continue;
      installedSlotIds.push(slot.id);
      if (entry.itemId) {
        const item = this.actor.items.get(entry.itemId);
        if (!isConstructPartItem(item)) continue;
        updates.push(createConstructPartPlacementUpdate(item.id, slot.id, order));
        continue;
      }

      const createData = createConstructPartCreateData(entry.itemData, slot.id, order);
      if (createData) createPlans.push({ entryId: entry.entryId, order, data: { ...createData, _id: entry.draftItemId } });
    }

    const actorUpdates = {
      "system.creature.typeId": "",
      "system.creature.raceId": "",
      "system.creature.subtypeId": "",
      "system.constructPartSlots": finalSlots,
      ...buildConstructSilhouetteUpdate(this.actor, {
        previousEntries,
        finalEntries: this.#entries
      }),
      ...extraActorUpdates
    };
    const mutation = {
      actor: this.actor,
      updates: coalesceConstructPartItemUpdates(updates),
      deletes: deletedItemIds,
      creates: createPlans.map(plan => plan.data),
      preserveCreateIds: true,
      actorUpdates
    };
    if (droppedParts.length) {
      if (!canDropItemsForActor(this.actor)) {
        ui.notifications?.warn?.(auditLocalize("FALLOUTMAW.AuditApps.DroppingAPartRequiresTheConstructSToken", "Для выброса детали нужен токен конструкта на текущей сцене."));
        return;
      }
      await commitInventoryWithDroppedItems(this.actor, mutation, droppedParts, {
        reason: "construct-structure-save"
      });
      ui.notifications?.warn?.(auditLocalize("FALLOUTMAW.AuditApps.ThereWasNotEnoughInventorySpaceRemovedParts", "В инвентаре не хватило места: снятые детали выброшены на землю."));
    } else {
      await executeInventoryMutation(mutation, { reason: "construct-structure-save" });
    }

    for (const slotId of detachedSlotIds) {
      if (!entriesBySlotId.has(slotId)) continue;
      if (getInstalledConstructPartForSlot(this.actor, slotId)) continue;
      await applyDestroyedLimbConsequences(this.actor, [getConstructPartLimbKey(slotId)], { ignoreInstalledProsthesis: true });
    }
    for (const slotId of removedSlotIds) {
      await clearLimbLossState(this.actor, getConstructPartLimbKey(slotId));
    }
    for (const slotId of installedSlotIds) {
      if (!getInstalledConstructPartForSlot(this.actor, slotId)) continue;
      const limbKey = getConstructPartLimbKey(slotId);
      if (isLimbDestroyed(this.actor, limbKey)) {
        await applyDestroyedLimbConsequences(this.actor, [limbKey], { ignoreInstalledProsthesis: true });
      } else {
        await clearLimbLossState(this.actor, limbKey);
      }
    }
    return true;
  }
}

export function openConstructStructure(actor) {
  if (!actor || actor.type !== "construct") return undefined;
  return new ConstructStructureApplication(actor).render(true);
}

function buildConstructSilhouetteUpdate(actor, {
  previousEntries = [],
  finalEntries = []
} = {}) {
  if (actor?.type !== "construct" || !actor.system?.limbSilhouetteOverride) return {};

  const source = normalizeLimbSilhouette(
    actor.system?.limbSilhouette,
    previousEntries.map(entry => ({
      key: getConstructPartLimbKey(entry.slot?.id),
      label: getConstructPartTypeLabel(entry.item ?? entry.slot) || entry.slot?.id
    }))
  );
  if (!source) return {};

  const previousKeys = previousEntries.map(entry => getConstructPartLimbKey(entry.slot?.id)).filter(Boolean);
  const previousKeySet = new Set(previousKeys);
  const previousKeyByOrder = new Map(previousKeys.map((key, index) => [index, key]));
  const finalLimbs = finalEntries
    .map(entry => ({
      key: getConstructPartEntryFinalLimbKey(entry),
      label: getConstructPartEntryLabel(entry)
    }))
    .filter(entry => entry.key);
  const finalKeySet = new Set(finalLimbs.map(entry => entry.key));
  const sourcePartsByKey = new Map(source.parts.map(part => [part.limbKey, {
    limbKey: part.limbKey,
    paths: normalizePaths(foundry.utils.deepClone(part.paths))
  }]));

  const mappedOldKeys = new Set();
  const parts = [];
  for (const key of previousKeys) {
    if (!finalKeySet.has(key)) continue;
    const sourcePart = sourcePartsByKey.get(key);
    if (!sourcePart?.paths?.length) continue;
    mappedOldKeys.add(key);
    parts.push({
      limbKey: key,
      paths: normalizePaths(foundry.utils.deepClone(sourcePart.paths))
    });
  }

  const replacementNewKeys = new Set();
  for (const [order, entry] of finalEntries.entries()) {
    const newKey = getConstructPartEntryFinalLimbKey(entry);
    if (!newKey || previousKeySet.has(newKey)) continue;
    const replacedOldKey = previousKeyByOrder.get(order);
    const replacedPart = sourcePartsByKey.get(replacedOldKey);
    if (!replacedPart?.paths?.length || mappedOldKeys.has(replacedOldKey)) continue;
    mappedOldKeys.add(replacedOldKey);
    replacementNewKeys.add(newKey);
    parts.push({
      limbKey: newKey,
      paths: normalizePaths(foundry.utils.deepClone(replacedPart.paths))
    });
  }

  let outline = normalizePaths(source.outline);
  const removedPaths = source.parts
    .filter(part => previousKeySet.has(part.limbKey) && !mappedOldKeys.has(part.limbKey))
    .flatMap(part => part.paths ?? []);
  if (removedPaths.length) {
    try {
      outline = clipperDifference(outline, removedPaths);
    } catch (error) {
      console.warn(`Fallout MaW | Failed to remove deleted construct part from limb silhouette: ${error.message}`);
    }
  }

  const additionalKeys = finalLimbs
    .map(entry => entry.key)
    .filter(key => key && !previousKeySet.has(key) && !replacementNewKeys.has(key));
  for (const key of additionalKeys) splitAssignedConstructSilhouettePart(parts, key);

  const silhouette = normalizeLimbSilhouette({
    width: source.width,
    height: source.height,
    image: source.image,
    outline,
    parts
  }, finalLimbs);
  return { "system.limbSilhouette": silhouette };
}

function splitAssignedConstructSilhouettePart(parts, newLimbKey) {
  if (!newLimbKey || parts.some(part => part.limbKey === newLimbKey)) return false;
  const donorIndex = parts.reduce((bestIndex, part, index) => {
    const bestArea = bestIndex >= 0 ? getPathsArea(parts[bestIndex].paths) : -1;
    const area = getPathsArea(part.paths);
    return area > bestArea ? index : bestIndex;
  }, -1);
  if (donorIndex < 0) return false;

  const split = splitConstructSilhouettePaths(parts[donorIndex].paths);
  if (!split) return false;
  parts[donorIndex] = {
    ...parts[donorIndex],
    paths: split.remaining
  };
  parts.push({
    limbKey: newLimbKey,
    paths: split.assigned
  });
  return true;
}

function splitConstructSilhouettePaths(paths) {
  const bounds = getPathsBounds(paths);
  if (!bounds) return null;
  return splitConstructSilhouettePathsByAxis(paths, bounds, "x")
    ?? splitConstructSilhouettePathsByAxis(paths, bounds, "y");
}

function splitConstructSilhouettePathsByAxis(paths, bounds, axis) {
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const clipPath = axis === "x"
    ? createRectanglePath(bounds.minX, bounds.minY, bounds.minX + (width / 2), bounds.maxY)
    : createRectanglePath(bounds.minX, bounds.minY, bounds.maxX, bounds.minY + (height / 2));

  try {
    const assigned = normalizePaths(clipperIntersect(paths, [clipPath]));
    const remaining = normalizePaths(clipperDifference(paths, assigned));
    if (!assigned.length || !remaining.length) return null;
    if (getPathsArea(assigned) <= 0 || getPathsArea(remaining) <= 0) return null;
    return { assigned, remaining };
  } catch (error) {
    console.warn(`Fallout MaW | Failed to split construct limb silhouette part: ${error.message}`);
    return null;
  }
}

function createRectanglePath(left, top, right, bottom) {
  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom }
  ];
}

function getConstructPartEntryFinalLimbKey(entry) {
  return getConstructPartLimbKey(entry?.slot?.id);
}

function getConstructPartEntryLabel(entry) {
  return getConstructPartTypeLabel(entry?.item ?? entry?.itemData ?? entry?.slot)
    || String(entry?.slot?.profile?.name ?? entry?.slot?.id ?? "");
}

function getOwnedConstructPartEntries(actor) {
  return getConstructPartSlots(actor).map(slot => {
    const item = getInstalledConstructPartForSlot(actor, slot.id);
    return createConstructPartEntry(slot, { item, installed: Boolean(item) });
  });
}

function createConstructPartEntry(slot, { item = null, itemData = null, installed = false } = {}) {
  return {
    entryId: `slot.${slot.id}`,
    slot,
    itemId: item?.id ?? "",
    draftItemId: item?.id ?? slot.id,
    item,
    itemData,
    installed: Boolean(installed)
  };
}

function prepareConstructPartEntry(entry, index) {
  const item = entry.installed ? entry.item ?? entry.itemData : null;
  const hasCondition = Boolean(item && hasItemFunction(item, ITEM_FUNCTIONS.condition));
  const condition = hasCondition ? getConditionFunction(item) : {};
  const profileMax = Math.max(0, toInteger(entry.slot?.profile?.conditionMax));
  const max = hasCondition ? Math.max(0, toInteger(condition.max)) : profileMax;
  const value = hasCondition ? Math.max(0, Math.min(max, toInteger(condition.value))) : 0;
  const percent = entry.installed
    ? (hasCondition && max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 100)
    : 0;
  const typeLabel = getConstructPartTypeLabel(item ?? entry.slot) || entry.slot?.profile?.name || auditLocalize("FALLOUTMAW.AuditApps.Part", "Деталь");
  const stateColor = entry.installed ? getConstructPartStateColor(hasCondition, value, max) : "#4f9e99";
  return {
    id: entry.entryId,
    slotId: entry.slot?.id ?? "",
    order: index + 1,
    name: String(item?.name ?? entry.slot?.profile?.name ?? typeLabel),
    img: item?.img || entry.slot?.profile?.img || "icons/svg/item-bag.svg",
    typeLabel,
    partType: getConstructPartTypeLabel(entry.slot) || typeLabel,
    installed: entry.installed,
    phantom: !entry.installed,
    hasCondition,
    value: entry.installed ? (hasCondition ? value : 1) : 0,
    max: entry.installed ? (hasCondition ? Math.max(1, max) : 1) : Math.max(1, max),
    valueLabel: entry.installed ? (hasCondition ? String(value) : "∞") : auditLocalize("FALLOUTMAW.AuditApps.EMPTY", "ПУСТО"),
    maxLabel: entry.installed && hasCondition ? String(max) : "",
    stateTitle: entry.installed ? (hasCondition ? `${value} / ${max}` : "∞") : auditLocalize("FALLOUTMAW.AuditApps.EmptyPartSlot", "Пустой слот детали"),
    meterStyle: `--construct-part-meter-color: ${stateColor};`,
    fillStyle: `width: ${Number(percent.toFixed(2))}%;`
  };
}

function getConstructPartStateColor(hasCondition, value, max) {
  if (!hasCondition) return "#d9eef5";
  if (max <= 0) return "#8a3b35";
  const ratio = value / max;
  if (ratio <= 0.25) return "#b1463d";
  if (ratio <= 0.5) return "#b99846";
  return "#7fa36a";
}

function isConstructPartItem(item) {
  return Boolean(item?.type === "gear" && hasItemFunction(item, ITEM_FUNCTIONS.constructPart, { ignoreBroken: true }));
}

function createConstructPartPlacementUpdate(itemId, slotId, order) {
  return {
    _id: itemId,
    "system.equipped": true,
    "system.container.parentId": "",
    "system.placement.mode": ITEM_FUNCTIONS.constructPart,
    "system.placement.equipmentSlot": "",
    "system.placement.weaponSet": "",
    "system.placement.weaponSlot": "",
    "system.placement.limbKey": slotId,
    "system.placement.constructPartOrder": order
  };
}

function createConstructPartCreateData(itemData, slotId, order) {
  if (!isConstructPartItem(itemData)) return null;
  const createData = foundry.utils.deepClone(itemData);
  delete createData._id;
  delete createData.id;
  foundry.utils.mergeObject(createData, {
    system: {
      equipped: true,
      container: {
        parentId: ""
      },
      placement: {
        mode: ITEM_FUNCTIONS.constructPart,
        equipmentSlot: "",
        weaponSet: "",
        weaponSlot: "",
        limbKey: slotId,
        constructPartOrder: order,
        x: 1,
        y: 1,
        width: Math.max(1, toInteger(itemData?.system?.placement?.width ?? 1)),
        height: Math.max(1, toInteger(itemData?.system?.placement?.height ?? 1))
      }
    }
  });
  return createData;
}

function createConstructPartInventoryUpdate(item, placement, parentId = ROOT_CONTAINER_ID) {
  const stored = createStoredPlacement({
    ...placement,
    mode: "inventory",
    equipmentSlot: "",
    weaponSet: "",
    weaponSlot: "",
    limbKey: "",
    constructPartOrder: 0
  }, item);
  return {
    _id: item.id,
    "system.equipped": false,
    "system.container.parentId": parentId,
    "system.placement.mode": "inventory",
    "system.placement.equipmentSlot": "",
    "system.placement.weaponSet": "",
    "system.placement.weaponSlot": "",
    "system.placement.limbKey": "",
    "system.placement.constructPartOrder": 0,
    "system.placement.x": stored.x,
    "system.placement.y": stored.y,
    "system.placement.width": stored.width,
    "system.placement.height": stored.height,
    "system.placement.rotated": stored.rotated
  };
}

function hasConstructPartWeaponOccupants(actor, slotId = "") {
  return Boolean(slotId && actor?.items?.contents?.some(item => (
    String(item.system?.placement?.mode ?? "") === "weapon"
    && String(item.system?.placement?.weaponSet ?? "").startsWith(`container:constructPart:${slotId}:`)
  )));
}

function coalesceConstructPartItemUpdates(updates = []) {
  const byId = new Map();
  for (const update of updates) {
    const id = String(update?._id ?? "").trim();
    if (!id) continue;
    const merged = byId.get(id) ?? { _id: id };
    Object.assign(merged, update, { _id: id });
    byId.set(id, merged);
  }
  return Array.from(byId.values());
}

function readDropData(event) {
  try {
    return JSON.parse(event.dataTransfer?.getData("text/plain") ?? "{}");
  } catch (_error) {
    return null;
  }
}
