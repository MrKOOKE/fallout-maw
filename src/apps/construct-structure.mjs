import { TEMPLATES } from "../constants.mjs";
import { FalloutMaWFormApplicationV2 } from "./base-form-application-v2.mjs";
import {
  ITEM_FUNCTIONS,
  getConditionFunction,
  getConstructPartFunction,
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
import { resolveWorldItemSync } from "../utils/world-items.mjs";

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
    const item = resolveWorldItemSync(data.uuid);
    if (!isConstructPartItem(item)) {
      ui.notifications?.warn?.("Можно добавить только предмет с функцией «Деталь конструкта».");
      return;
    }

    if (item.parent === this.actor && !this.#entries.some(entry => entry.kind === "owned" && entry.itemId === item.id)) {
      this.#entries.push(createOwnedConstructPartEntry(item, false));
    } else {
      this.#entries.push(createConstructPartCreateEntry(item.toObject()));
    }
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

  #onEntryDrop(event) {
    const entryId = this.#readDraggedEntryId(event);
    if (!entryId) return;
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
    const entryId = event.currentTarget?.dataset?.constructPartRemove ?? "";
    if (!entryId) return;
    this.#entries = this.#entries.filter(entry => entry.entryId !== entryId);
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
    const keptOwnedIds = new Set();
    const previousEntries = getOwnedConstructPartEntries(this.actor);

    for (const [order, entry] of this.#entries.entries()) {
      if (entry.kind === "owned") {
        const item = this.actor.items.get(entry.itemId);
        if (!isConstructPartItem(item)) continue;
        keptOwnedIds.add(item.id);
        updates.push(createConstructPartPlacementUpdate(item.id, order));
        continue;
      }

      const createData = createConstructPartCreateData(entry.itemData, order);
      if (createData) createPlans.push({ entryId: entry.entryId, order, data: createData });
    }

    const installedIds = previousEntries.map(entry => entry.itemId);
    const deletes = installedIds.filter(itemId => !keptOwnedIds.has(itemId));
    if (deletes.length) await this.actor.deleteEmbeddedDocuments("Item", deletes);
    if (updates.length) await this.actor.updateEmbeddedDocuments("Item", updates);
    const createdItems = createPlans.length ? await this.actor.createEmbeddedDocuments("Item", createPlans.map(plan => plan.data)) : [];
    const createdItemsByEntryId = new Map(createdItems.map((item, index) => [createPlans[index]?.entryId, item]));
    const createdUpdates = createdItems.map(item => ({
      _id: item.id,
      "system.placement.limbKey": item.id
    }));
    if (createdUpdates.length) await this.actor.updateEmbeddedDocuments("Item", createdUpdates);

    await this.actor.update({
      "system.creature.typeId": "",
      "system.creature.raceId": "",
      "system.creature.subtypeId": "",
      ...buildConstructSilhouetteUpdate(this.actor, {
        previousEntries,
        finalEntries: this.#entries,
        createdItemsByEntryId
      })
    });
  }
}

export function openConstructStructure(actor) {
  if (!actor || actor.type !== "construct") return undefined;
  return new ConstructStructureApplication(actor).render(true);
}

function buildConstructSilhouetteUpdate(actor, {
  previousEntries = [],
  finalEntries = [],
  createdItemsByEntryId = new Map()
} = {}) {
  if (actor?.type !== "construct" || !actor.system?.limbSilhouetteOverride) return {};

  const source = normalizeLimbSilhouette(
    actor.system?.limbSilhouette,
    previousEntries.map(entry => ({
      key: getConstructPartLimbKey(entry.itemId),
      label: entry.item?.name ?? entry.itemId
    }))
  );
  if (!source) return {};

  const previousKeys = previousEntries.map(entry => getConstructPartLimbKey(entry.itemId));
  const previousKeySet = new Set(previousKeys);
  const previousKeyByOrder = new Map(previousKeys.map((key, index) => [index, key]));
  const finalLimbs = finalEntries
    .map(entry => ({
      key: getConstructPartEntryFinalLimbKey(entry, createdItemsByEntryId),
      label: getConstructPartEntryLabel(entry, createdItemsByEntryId)
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
    const newKey = getConstructPartEntryFinalLimbKey(entry, createdItemsByEntryId);
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

function getConstructPartEntryFinalLimbKey(entry, createdItemsByEntryId = new Map()) {
  const itemId = entry?.kind === "owned"
    ? entry.itemId
    : createdItemsByEntryId.get(entry?.entryId)?.id;
  return itemId ? getConstructPartLimbKey(itemId) : "";
}

function getConstructPartEntryLabel(entry, createdItemsByEntryId = new Map()) {
  if (entry?.kind === "owned") return String(entry.item?.name ?? entry.itemId ?? "");
  const item = createdItemsByEntryId.get(entry?.entryId);
  return String(item?.name ?? entry?.itemData?.name ?? "");
}

function getConstructPartLimbKey(itemId = "") {
  return itemId ? `constructPart:${itemId}` : "";
}

function getOwnedConstructPartEntries(actor) {
  return actor.items
    .filter(item => (
      isConstructPartItem(item)
      && String(item.system?.placement?.mode ?? "") === ITEM_FUNCTIONS.constructPart
    ))
    .sort(compareConstructPartItems)
    .map(item => createOwnedConstructPartEntry(item, true));
}

function createOwnedConstructPartEntry(item, installed) {
  return {
    kind: "owned",
    entryId: `owned.${item.id}`,
    itemId: item.id,
    item,
    installed
  };
}

function createConstructPartCreateEntry(itemData) {
  return {
    kind: "create",
    entryId: `create.${foundry.utils.randomID()}`,
    itemData
  };
}

function compareConstructPartItems(left, right) {
  const leftOrder = toInteger(left.system?.placement?.constructPartOrder);
  const rightOrder = toInteger(right.system?.placement?.constructPartOrder);
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  return String(left.id).localeCompare(String(right.id));
}

function prepareConstructPartEntry(entry, index) {
  const item = entry.item ?? entry.itemData;
  const part = getConstructPartFunction(item);
  const hasCondition = hasItemFunction(item, ITEM_FUNCTIONS.condition);
  const condition = hasCondition ? getConditionFunction(item) : {};
  const max = hasCondition ? Math.max(0, toInteger(condition.max)) : 0;
  const value = hasCondition ? Math.max(0, Math.min(max, toInteger(condition.value))) : 0;
  const percent = hasCondition && max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 100;
  const typeLabel = String(part.partType ?? "").trim() || item?.name || "Деталь";
  const stateColor = getConstructPartStateColor(hasCondition, value, max);
  return {
    id: entry.entryId,
    order: index + 1,
    name: String(item?.name ?? ""),
    img: item?.img || "icons/svg/item-bag.svg",
    typeLabel,
    hasCondition,
    value: hasCondition ? value : 1,
    max: hasCondition ? max : 1,
    valueLabel: hasCondition ? String(value) : "∞",
    maxLabel: hasCondition ? String(max) : "",
    stateTitle: hasCondition ? `${value} / ${max}` : "∞",
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

function createConstructPartPlacementUpdate(itemId, order) {
  return {
    _id: itemId,
    "system.equipped": false,
    "system.container.parentId": "",
    "system.placement.mode": ITEM_FUNCTIONS.constructPart,
    "system.placement.equipmentSlot": "",
    "system.placement.weaponSet": "",
    "system.placement.weaponSlot": "",
    "system.placement.limbKey": itemId,
    "system.placement.constructPartOrder": order
  };
}

function createConstructPartCreateData(itemData, order) {
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
        limbKey: "",
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

function readDropData(event) {
  try {
    return JSON.parse(event.dataTransfer?.getData("text/plain") ?? "{}");
  } catch (_error) {
    return null;
  }
}
