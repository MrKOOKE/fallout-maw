import { TEMPLATES } from "../constants.mjs";
import { FalloutMaWFormApplicationV2 } from "./base-form-application-v2.mjs";
import {
  ITEM_FUNCTIONS,
  getConditionFunction,
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
  getInstalledConstructPartForSlot,
  isConstructPartCompatibleWithSlot
} from "../utils/construct-parts.mjs";
import { getActorInventoryGridDimensions, getActorRootInventoryGridOptions } from "../utils/actor-display-data.mjs";
import {
  ROOT_CONTAINER_ID,
  createStoredPlacement,
  findFirstAvailableInventoryPlacement,
  getContextInventoryItems
} from "../utils/inventory-containers.mjs";
import { applyDestroyedLimbConsequences, clearLimbLossState, isLimbDestroyed } from "../combat/damage-hub.mjs";

export class ConstructStructureApplication extends FalloutMaWFormApplicationV2 {
  #entries = [];
  #draggedEntryId = "";
  #dropCommitted = false;
  #previewDirty = false;

  constructor(actor, options = {}) {
    super(options);
    this.actor = actor;
    this.#entries = getOwnedConstructPartEntries(actor);
  }

  static DEFAULT_OPTIONS = {
    ...FalloutMaWFormApplicationV2.DEFAULT_OPTIONS,
    id: "fallout-maw-construct-structure",
    classes: ["fallout-maw", "fallout-maw-config-form", "fallout-maw-construct-structure"],
    position: {
      width: 760,
      height: "auto"
    },
    window: {
      title: "Строение конструкта",
      resizable: true
    },
    form: {
      handler: FalloutMaWFormApplicationV2.handleFormSubmit,
      submitOnChange: false,
      closeOnSubmit: true
    }
  };

  static PARTS = {
    body: {
      template: TEMPLATES.constructStructure
    }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    return foundry.utils.mergeObject(context, {
      actor: this.actor,
      entries: this.#entries.map((entry, index) => prepareConstructPartEntry(entry, index)),
      hasEntries: this.#entries.length > 0
    }, { inplace: false });
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
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

  async _processFormData(_event, _form, _formData) {
    return this.#saveStructure();
  }

  #onPartListDragOver(event) {
    event.preventDefault();
    const entryId = this.#readDraggedEntryId(event);
    if (event.dataTransfer) event.dataTransfer.dropEffect = entryId ? "move" : "copy";
    if (entryId) this.#previewEntryDrop(event);
  }

  async #onDropConstructPart(event) {
    event.preventDefault();
    const data = readDropData(event);
    if (data?.type !== "Item") return;
    const item = await Item.implementation.fromDropData(data).catch(() => null);
    if (!isConstructPartItem(item)) {
      ui.notifications?.warn?.("Можно добавить только предмет с функцией «Деталь конструкта».");
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
    if (!entryId) return this.#onDropIntoEntry(event);
    event.preventDefault();
    event.stopPropagation();
    this.#syncEntriesToPreviewOrder();
    this.#dropCommitted = true;
    this.#previewDirty = false;
    return this.render();
  }

  async #onDropIntoEntry(event) {
    event.preventDefault();
    event.stopPropagation();
    const targetEntryId = event.currentTarget?.dataset?.constructPartEntryId ?? "";
    const entry = this.#entries.find(candidate => candidate.entryId === targetEntryId);
    if (!entry) return;
    if (entry.installed) {
      ui.notifications?.warn?.("Сначала снимите установленную деталь из этого слота.");
      return;
    }
    const data = readDropData(event);
    if (data?.type !== "Item") return;
    const item = await Item.implementation.fromDropData(data).catch(() => null);
    if (!isConstructPartCompatibleWithSlot(item, entry.slot)) {
      ui.notifications?.warn?.("Тип детали не совпадает с типом этого слота конструкта.");
      return;
    }
    if (item.parent === this.actor && this.#entries.some(candidate => candidate !== entry && candidate.installed && candidate.itemId === item.id)) {
      ui.notifications?.warn?.("Эта деталь уже установлена в другой слот конструкта.");
      return;
    }
    entry.item = item.parent === this.actor ? item : null;
    entry.itemId = entry.item?.id ?? "";
    entry.itemData = item.parent === this.actor ? null : item.toObject();
    entry.installed = true;
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
    const entryId = event.currentTarget?.dataset?.constructPartRemove ?? "";
    if (!entryId) return;
    const entry = this.#entries.find(candidate => candidate.entryId === entryId);
    if (!entry?.installed) return;
    if (hasConstructPartWeaponOccupants(this.actor, entry.slot?.id)) {
      ui.notifications?.warn?.("Сначала снимите оружие, установленное в слоты этой детали конструкта.");
      return;
    }
    entry.installed = false;
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
    const insertBefore = event.clientY < rect.top + (rect.height / 2);
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
  }

  async #saveStructure() {
    if (this.actor.type !== "construct") return;
    const updates = [];
    const createPlans = [];
    const previousEntries = getOwnedConstructPartEntries(this.actor);
    const previousItemBySlotId = new Map(previousEntries.map(entry => [entry.slot.id, entry.item]));
    const installedOwnedIds = new Set(
      this.#entries
        .filter(entry => entry.installed && entry.itemId)
        .map(entry => entry.itemId)
    );
    const installedSlotIds = [];
    const finalSlots = [];

    const { columns, rows } = getActorInventoryGridDimensions(this.actor, null);
    const rootItems = getContextInventoryItems(ROOT_CONTAINER_ID, this.actor.items);
    const detachedEntries = this.#entries
      .map(entry => ({ entry, item: previousItemBySlotId.get(entry.slot.id) ?? null }))
      .filter(({ entry, item }) => item && (!entry.installed || entry.itemId !== item.id));
    const detachedSlotIds = detachedEntries.map(({ entry }) => entry.slot.id);
    const detachedItems = detachedEntries.filter(({ item }) => !installedOwnedIds.has(item.id));
    const inventoryExcludeIds = Array.from(new Set([
      ...installedOwnedIds,
      ...detachedItems.map(({ item }) => item.id)
    ]));
    const reservedPlacements = [];

    for (const { entry, item } of detachedItems) {
      if (hasConstructPartWeaponOccupants(this.actor, entry.slot.id)) {
        ui.notifications?.warn?.("Сначала снимите оружие, установленное в слоты этой детали конструкта.");
        return;
      }
      const placement = findFirstAvailableInventoryPlacement(
        rootItems,
        columns,
        rows,
        item,
        this.actor.items,
        inventoryExcludeIds,
        reservedPlacements,
        getActorRootInventoryGridOptions(this.actor, ROOT_CONTAINER_ID)
      );
      if (!placement) {
        ui.notifications?.warn?.(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));
        return;
      }
      reservedPlacements.push(placement);
      updates.push(createConstructPartInventoryUpdate(item, placement));
    }

    for (const [order, entry] of this.#entries.entries()) {
      const source = entry.item ?? entry.itemData;
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
      if (createData) createPlans.push({ entryId: entry.entryId, order, data: createData });
    }

    const itemUpdates = coalesceConstructPartItemUpdates(updates);
    if (itemUpdates.length) await this.actor.updateEmbeddedDocuments("Item", itemUpdates);
    if (createPlans.length) await this.actor.createEmbeddedDocuments("Item", createPlans.map(plan => plan.data));

    await this.actor.update({
      "system.creature.typeId": "",
      "system.creature.raceId": "",
      "system.creature.subtypeId": "",
      "system.constructPartSlots": finalSlots,
      ...buildConstructSilhouetteUpdate(this.actor, {
        previousEntries,
        finalEntries: this.#entries
      })
    });

    for (const slotId of detachedSlotIds) {
      if (getInstalledConstructPartForSlot(this.actor, slotId)) continue;
      await applyDestroyedLimbConsequences(this.actor, [getConstructPartLimbKey(slotId)], { ignoreInstalledProsthesis: true });
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
  const typeLabel = getConstructPartTypeLabel(item ?? entry.slot) || entry.slot?.profile?.name || "Деталь";
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
    valueLabel: entry.installed ? (hasCondition ? String(value) : "∞") : "ПУСТО",
    maxLabel: entry.installed && hasCondition ? String(max) : "",
    stateTitle: entry.installed ? (hasCondition ? `${value} / ${max}` : "∞") : "Пустой слот детали",
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
  return Boolean(item?.type === "gear" && hasItemFunction(item, ITEM_FUNCTIONS.constructPart));
}

function createConstructPartPlacementUpdate(itemId, slotId, order) {
  return {
    _id: itemId,
    "system.equipped": false,
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
      equipped: false,
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

function createConstructPartInventoryUpdate(item, placement) {
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
    "system.container.parentId": ROOT_CONTAINER_ID,
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
