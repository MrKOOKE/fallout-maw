import {
  ITEM_FUNCTIONS,
  getConditionFunction,
  getConstructPartFunction,
  hasItemFunction
} from "./item-functions.mjs";
import { toInteger } from "./numbers.mjs";

const CONSTRUCT_PART_LIMB_PREFIX = "constructPart:";
const LEGACY_CONSTRUCT_PART_LIMB_PREFIX = "constructPart.";

export function getConstructPartLimbKey(slotId = "") {
  const id = normalizeId(slotId);
  return id ? `${CONSTRUCT_PART_LIMB_PREFIX}${id}` : "";
}

export function getConstructPartSlotIdFromLimbKey(limbKey = "") {
  const key = String(limbKey ?? "").trim();
  if (key.startsWith(CONSTRUCT_PART_LIMB_PREFIX)) return normalizeId(key.slice(CONSTRUCT_PART_LIMB_PREFIX.length));
  if (key.startsWith(LEGACY_CONSTRUCT_PART_LIMB_PREFIX)) return normalizeId(key.slice(LEGACY_CONSTRUCT_PART_LIMB_PREFIX.length));
  return "";
}

export function getConstructPartSlotId(item = null) {
  const stored = normalizeId(item?.system?.placement?.limbKey);
  if (stored) return getConstructPartSlotIdFromLimbKey(stored) || stored;
  return normalizeId(item?.id ?? item?._id);
}

export function getConstructPartSlots(actor = null) {
  if (getActorType(actor) !== "construct") return [];

  const storedSlots = getStoredConstructPartSlots(actor)
    .map((slot, index) => normalizeConstructPartSlot(slot, index))
    .filter(Boolean);
  const slotsById = new Map(storedSlots.map(slot => [slot.id, slot]));

  for (const item of getActorItems(actor).filter(isInstalledConstructPartItem)) {
    const id = getConstructPartSlotId(item);
    if (!id || slotsById.has(id)) continue;
    const slot = createConstructPartSlotFromItem(item, { id });
    if (slot) slotsById.set(id, slot);
  }

  return Array.from(slotsById.values()).sort(compareConstructPartSlots);
}

export function getConstructPartSlot(actor = null, slotId = "") {
  const id = normalizeId(slotId);
  if (!id) return null;
  return getConstructPartSlots(actor).find(slot => slot.id === id) ?? null;
}

export function getConstructPartSlotForLimb(actor = null, limbKey = "") {
  return getConstructPartSlot(actor, getConstructPartSlotIdFromLimbKey(limbKey));
}

export function getInstalledConstructPartForSlot(actor = null, slotOrId = "") {
  const id = normalizeId(slotOrId?.id ?? slotOrId);
  if (!id) return null;
  return getActorItems(actor).find(item => (
    isInstalledConstructPartItem(item)
    && getConstructPartSlotId(item) === id
  )) ?? null;
}

export function getInstalledConstructPartForLimb(actor = null, limbKey = "") {
  return getInstalledConstructPartForSlot(actor, getConstructPartSlotIdFromLimbKey(limbKey));
}

export function getConstructPartTypeLabel(itemOrSlot = null) {
  const constructPart = getConstructPartSnapshot(itemOrSlot);
  for (const candidate of [
    itemOrSlot?.partType,
    constructPart?.partType,
    itemOrSlot?.system?.functions?.constructPart?.partType
  ]) {
    const explicit = normalizeDisplayText(candidate);
    if (explicit) return explicit;
  }
  return normalizeDisplayText(itemOrSlot?.name)
    || normalizeDisplayText(itemOrSlot?.profile?.name);
}

export function isConstructPartCompatibleWithSlot(item = null, slot = null) {
  if (!isConstructPartItem(item) || !slot) return false;
  const itemType = normalizeConstructPartType(getConstructPartTypeLabel(item));
  const slotType = normalizeConstructPartType(getConstructPartTypeLabel(slot));
  return Boolean(itemType && slotType && itemType === slotType);
}

export function createConstructPartSlotFromItem(item = null, { id = "", order = null } = {}) {
  if (!isConstructPartItem(item)) return null;
  const slotId = normalizeId(id) || getConstructPartSlotId(item) || createRandomId();
  if (!slotId) return null;

  const constructPart = cloneData(getRawConstructPartFunction(item));
  const hasCondition = hasItemFunction(item, ITEM_FUNCTIONS.condition, { ignoreBroken: true });
  const condition = hasCondition ? getConditionFunction(item) : {};
  const storedOrder = order === null || order === undefined
    ? toInteger(item?.system?.placement?.constructPartOrder)
    : toInteger(order);

  return normalizeConstructPartSlot({
    id: slotId,
    partType: getConstructPartTypeLabel(item),
    order: Math.max(0, storedOrder),
    profile: {
      name: String(item?.name ?? ""),
      img: String(item?.img ?? ""),
      conditionMax: hasCondition ? Math.max(0, toInteger(condition.max)) : 0,
      constructPart
    }
  });
}

export async function ensureConstructPartSlots(actorOrSource = null) {
  if (getActorType(actorOrSource) !== "construct") return [];

  if (!isActorDocument(actorOrSource)) return ensureConstructPartSlotSource(actorOrSource);

  const slots = getConstructPartSlots(actorOrSource).map(slot => {
    const installed = getInstalledConstructPartForSlot(actorOrSource, slot.id);
    return installed
      ? createConstructPartSlotFromItem(installed, { id: slot.id, order: slot.order }) ?? slot
      : slot;
  });
  const rawSlots = actorOrSource?._source?.system?.constructPartSlots;
  if (!Array.isArray(rawSlots) || !areSlotCollectionsEqual(rawSlots, slots)) {
    await actorOrSource.update({ "system.constructPartSlots": slots });
  }

  const slotById = new Map(slots.map(slot => [slot.id, slot]));
  const itemUpdates = getActorItems(actorOrSource)
    .filter(isInstalledConstructPartItem)
    .map(item => {
      const slotId = getConstructPartSlotId(item);
      const slot = slotById.get(slotId);
      if (!slot) return null;
      const currentLimbKey = String(item.system?.placement?.limbKey ?? "").trim();
      const currentOrder = Math.max(0, toInteger(item.system?.placement?.constructPartOrder));
      if (currentLimbKey === slot.id && currentOrder === slot.order) return null;
      return {
        _id: item.id,
        "system.placement.limbKey": slot.id,
        "system.placement.constructPartOrder": slot.order
      };
    })
    .filter(Boolean);
  if (itemUpdates.length) await actorOrSource.updateEmbeddedDocuments("Item", itemUpdates);
  return slots;
}

export function ensureConstructPartSlotSource(actorOrSource = null) {
  if (getActorType(actorOrSource) !== "construct") return [];

  const existing = actorOrSource?.system?.constructPartSlots;
  const items = getActorItems(actorOrSource).filter(isInstalledConstructPartItem);
  const slotsById = new Map(
    (Array.isArray(existing) ? existing : [])
      .map((slot, index) => normalizeConstructPartSlot(slot, index))
      .filter(Boolean)
      .map(slot => [slot.id, slot])
  );
  for (const item of items) {
    const slotId = getConstructPartSlotId(item);
    if (!slotId || slotsById.has(slotId)) continue;
    const slot = createConstructPartSlotFromItem(item, { id: slotId });
    if (slot) slotsById.set(slot.id, slot);
  }
  const slots = Array.from(slotsById.values()).sort(compareConstructPartSlots);

  actorOrSource.system ??= {};
  actorOrSource.system.constructPartSlots = slots;
  const slotById = new Map(slots.map(slot => [slot.id, slot]));
  for (const item of items) {
    const slotId = getConstructPartSlotId(item);
    if (!slotId) continue;
    item.system ??= {};
    item.system.placement ??= {};
    item.system.placement.limbKey = slotId;
    item.system.placement.constructPartOrder = slotById.get(slotId)?.order ?? 0;
  }
  return slots;
}

export function isInstalledConstructPartItem(item = null) {
  return Boolean(
    isConstructPartItem(item)
    && String(item?.system?.placement?.mode ?? "") === ITEM_FUNCTIONS.constructPart
  );
}

function isConstructPartItem(item = null) {
  return Boolean(
    item?.type === "gear"
    && hasItemFunction(item, ITEM_FUNCTIONS.constructPart, { ignoreBroken: true })
  );
}

function getActorType(actorOrSource = null) {
  return String(actorOrSource?.type ?? actorOrSource?._source?.type ?? "");
}

function isActorDocument(value = null) {
  return Boolean(
    value?.documentName === "Actor"
    && typeof value.update === "function"
    && typeof value.updateEmbeddedDocuments === "function"
  );
}

function getStoredConstructPartSlots(actor = null) {
  const value = actor?.system?.constructPartSlots ?? actor?._source?.system?.constructPartSlots;
  if (Array.isArray(value)) return value;
  return value && typeof value === "object" ? Object.values(value) : [];
}

function getActorItems(actorOrSource = null) {
  const items = actorOrSource?.items;
  if (Array.isArray(items)) return items;
  if (Array.isArray(items?.contents)) return items.contents;
  if (items && typeof items[Symbol.iterator] === "function") return Array.from(items);
  return [];
}

function getRawConstructPartFunction(item = null) {
  return item?._source?.system?.functions?.constructPart
    ?? item?.system?._source?.functions?.constructPart
    ?? item?.system?.functions?.constructPart
    ?? getConstructPartFunction(item)
    ?? {};
}

function getConstructPartSnapshot(itemOrSlot = null) {
  return itemOrSlot?.profile?.constructPart
    ?? itemOrSlot?._source?.system?.functions?.constructPart
    ?? itemOrSlot?.system?._source?.functions?.constructPart
    ?? itemOrSlot?.system?.functions?.constructPart
    ?? {};
}

function normalizeConstructPartSlot(slot = null, fallbackOrder = 0) {
  if (!slot || typeof slot !== "object") return null;
  const id = normalizeId(slot.id ?? slot._id);
  if (!id) return null;
  const profile = slot.profile && typeof slot.profile === "object" ? slot.profile : {};
  const constructPart = cloneData(profile.constructPart ?? slot.constructPart ?? {});
  const partType = normalizeDisplayText(slot.partType)
    || normalizeDisplayText(constructPart?.partType)
    || normalizeDisplayText(profile.name);
  return {
    id,
    partType,
    order: Math.max(0, toInteger(slot.order ?? fallbackOrder)),
    profile: {
      name: String(profile.name ?? slot.name ?? ""),
      img: String(profile.img ?? slot.img ?? ""),
      conditionMax: Math.max(0, toInteger(profile.conditionMax ?? slot.conditionMax)),
      constructPart
    }
  };
}

function normalizeConstructPartType(value = "") {
  const text = normalizeDisplayText(value);
  if (!text) return "";
  const locale = String(globalThis.game?.i18n?.lang ?? "").trim();
  try {
    return locale ? text.toLocaleLowerCase(locale) : text.toLocaleLowerCase();
  } catch (_error) {
    return text.toLowerCase();
  }
}

function normalizeDisplayText(value = "") {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeId(value = "") {
  return String(value ?? "").trim();
}

function compareConstructPartSlots(left, right) {
  const orderDelta = toInteger(left?.order) - toInteger(right?.order);
  if (orderDelta) return orderDelta;
  return String(left?.id ?? "").localeCompare(String(right?.id ?? ""));
}

function areSlotCollectionsEqual(left = [], right = []) {
  const normalizedLeft = (Array.isArray(left) ? left : [])
    .map((slot, index) => normalizeConstructPartSlot(slot, index))
    .filter(Boolean)
    .sort(compareConstructPartSlots);
  const normalizedRight = (Array.isArray(right) ? right : [])
    .map((slot, index) => normalizeConstructPartSlot(slot, index))
    .filter(Boolean)
    .sort(compareConstructPartSlots);
  return JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight);
}

function cloneData(value) {
  if (!value || typeof value !== "object") return {};
  if (globalThis.foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
  return structuredClone(value);
}

function createRandomId() {
  return globalThis.foundry?.utils?.randomID?.() ?? "";
}
