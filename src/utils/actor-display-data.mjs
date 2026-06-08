import { createDefaultInventorySize } from "../settings/creature-options.mjs";
import { getCurrencySettings } from "../settings/accessors.mjs";
import {
  doesItemOccupyEquipmentSlot,
  getRequiredWeaponSlotsForItem,
  getWeaponSlotRequirement,
  getWeaponSlotRequirementSize,
  isContainerWeaponSetKey
} from "./equipment-slots.mjs";
import { getLimbHealingCap } from "../combat/damage-hub.mjs";
import {
  getContainerContentsWeight,
  getContainerDimensions,
  getContainerMaxLoad,
  getItemContainerParentId,
  getItemFootprint,
  getItemMaxStack,
  getItemQuantity,
  getItemTotalWeight,
  INFINITE_ROOT_INVENTORY_EMPTY_ROWS,
  isItemInLockedStorage,
  isItemLocked,
  isContainerItem,
  LOCKED_STORAGE_PARENT_ID,
  LOCKED_STORAGE_PLACEMENT_MODE,
  normalizeInventoryPlacement,
  prepareInventoryGridContext
} from "./inventory-containers.mjs";
import { getActiveItemChargesData, getConstructPartFunction, hasItemFunction, isItemBrokenByCondition, ITEM_FUNCTIONS } from "./item-functions.mjs";
import { getNaturalWeaponSetContext, isNaturalRaceItem } from "../races/natural-items.mjs";
import { toInteger } from "./numbers.mjs";

export const FALLBACK_ICON = "icons/svg/d20-grey.svg";

export function normalizeImagePath(path, fallback = FALLBACK_ICON) {
  const normalized = String(path ?? "").trim();
  return normalized || fallback;
}

export function formatWeight(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

export function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

export function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[char]);
}

export function prepareIndicatorEntry({
  key = "",
  label = "",
  color = "#8f8456",
  data = {},
  inputName = "",
  active = false,
  ...extra
} = {}) {
  const min = toInteger(data?.min);
  const max = Math.max(min, toInteger(data?.max));
  const scaleMax = Math.max(min, toInteger(data?.scaleMax ?? data?.max));
  const value = Math.min(Math.max(toInteger(data?.value), min), Math.max(max, scaleMax));
  const negativeRange = min < 0 ? Math.abs(min) : 0;
  const positiveFloor = Math.max(0, min);
  const positiveRange = Math.max(0, scaleMax - positiveFloor);
  const isNegative = value < 0 && negativeRange > 0;
  const percent = isNegative
    ? ((Math.abs(value) / negativeRange) * 100)
    : (positiveRange > 0 ? (((Math.max(value, positiveFloor) - positiveFloor) / positiveRange) * 100) : 0);
  const segments = getIndicatorSegmentCount(isNegative ? negativeRange : positiveRange || scaleMax || max);
  const normalizedColor = normalizeIndicatorColor(isNegative ? "#c8463d" : color);

  return {
    ...extra,
    key,
    label,
    color: normalizedColor,
    min,
    value,
    valueLabel: data?.displayValue ?? value,
    max,
    maxLabel: data?.displayMax ?? max,
    active,
    inputName,
    isNegative,
    percent: Number(percent.toFixed(2)),
    segments,
    meterStyle: buildIndicatorMeterStyle(normalizedColor, segments),
    fillStyle: buildIndicatorFillStyle(normalizedColor, percent, { reverse: isNegative })
  };
}

export function getInventoryGridDimensions(race) {
  const inventorySize = race?.inventorySize ?? createDefaultInventorySize();
  return {
    columns: Math.max(1, toInteger(inventorySize.columns)),
    rows: Math.max(1, toInteger(inventorySize.rows))
  };
}

export function getActorInventoryGridDimensions(actor, race) {
  const inventory = actor?.system?.inventory;
  const columns = toInteger(inventory?.columns);
  const rows = toInteger(inventory?.rows);
  if (columns > 0 && rows > 0) return { columns, rows };
  return getInventoryGridDimensions(race);
}

export function actorHasInfiniteRootInventory(actor) {
  return Boolean(actor?.system?.trade?.infiniteInventory);
}

export function getActorRootInventoryGridOptions(actor, parentId = "") {
  return {
    allowOverflowRows: !parentId && actorHasInfiniteRootInventory(actor),
    extraRows: !parentId && actorHasInfiniteRootInventory(actor) ? INFINITE_ROOT_INVENTORY_EMPTY_ROWS : 0
  };
}

export function prepareInventoryContext(actor, race, { includeLocked = true } = {}) {
  const currencies = getCurrencySettings();
  const { columns, rows } = getActorInventoryGridDimensions(actor, race);
  const allItems = actor.items.contents.filter(item => (
    !["ability", "trauma", "disease"].includes(item.type)
    && !isNaturalRaceItem(item)
    && (includeLocked || !isItemLocked(item))
  ));
  const allItemData = allItems.map(item => createInventoryItemData(item, allItems, currencies));
  const naturalWeaponSet = actor?.type === "construct"
    ? getConstructNaturalWeaponSetContext(actor, allItemData)
    : getNaturalWeaponSetContext(actor, race, currencies);
  const assignedItemIds = new Set();
  const topLevelItems = allItemData.filter(item => !item.parentId);
  for (const item of topLevelItems) {
    if (item.placement?.mode === ITEM_FUNCTIONS.constructPart) assignedItemIds.add(item.id);
  }

  const equipmentSlots = [
    ...(race?.equipmentSlots ?? []).map(slot => {
      const item = topLevelItems.find(candidate => (
        candidate.placement?.mode === "equipment"
        && doesItemOccupyEquipmentSlot(candidate, slot)
      ));
      if (item) assignedItemIds.add(item.id);
      return { ...slot, item };
    }),
    ...prepareConstructPartEquipmentSlots(actor, topLevelItems, assignedItemIds)
  ];

  const prosthesisSlots = actor?.type === "construct"
    ? []
    : Object.entries(actor.system?.limbs ?? {})
      .map(([key, limb]) => {
        const item = topLevelItems.find(candidate => (
          candidate.placement?.mode === "prosthesis"
          && candidate.placement?.limbKey === key
        ));
        if (!item) return null;
        assignedItemIds.add(item.id);
        return {
          key,
          label: String(limb?.label ?? key),
          item
        };
      })
      .filter(Boolean);

  const weaponSets = [
    ...(race?.weaponSets ?? []).map(set => prepareWeaponSetContext(set, race, topLevelItems, assignedItemIds, actor)),
    ...prepareConstructPartWeaponSets(actor, topLevelItems, assignedItemIds),
    ...prepareContainerWeaponSets(actor, topLevelItems, assignedItemIds)
  ];

  const inventoryItems = allItems.filter(item => (
    !assignedItemIds.has(item.id)
    && !getItemContainerParentId(item)
    && !isItemInLockedStorage(item)
  ));
  const lockedStorageItems = allItems.filter(item => isItemInLockedStorage(item));
  const lockedStorage = {
    id: LOCKED_STORAGE_PARENT_ID,
    columns,
    rows: 1,
    grid: prepareInventoryGridContext(lockedStorageItems, columns, 1, allItems, (item, placement) => {
      const normalizedPlacement = {
        ...placement,
        mode: LOCKED_STORAGE_PLACEMENT_MODE
      };
      return {
        ...createInventoryItemData(item, allItems, currencies, normalizedPlacement),
        gridStyle: buildInventoryCellStyle(normalizedPlacement.x, normalizedPlacement.y, normalizedPlacement)
      };
    }, {
      allowOverflowRows: true,
      compactRows: true,
      compactVerticalOffset: true,
      extraRows: 1,
      placementMode: LOCKED_STORAGE_PLACEMENT_MODE,
      preferredPlacementModes: [LOCKED_STORAGE_PLACEMENT_MODE]
    })
  };
  const grid = prepareInventoryGridContext(inventoryItems, columns, rows, allItems, (item, placement) => ({
    ...createInventoryItemData(item, allItems, currencies, placement),
    gridStyle: buildInventoryCellStyle(placement.x, placement.y, placement)
  }), getActorRootInventoryGridOptions(actor, ""));
  const containers = topLevelItems
    .filter(item => item.isContainer && item.equipped)
    .map(item => {
      const containerDocument = actor.items.get(item.id);
      const dimensions = getContainerDimensions(containerDocument);
      const contents = actor.items.contents.filter(child => getItemContainerParentId(child) === item.id);
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
    equipmentHeading: actor?.type === "construct" ? "Строение" : game.i18n.localize("FALLOUTMAW.Common.Equipment"),
    equipmentSlots,
    prosthesisSlots,
    weaponSets,
    naturalWeaponSet,
    containers,
    lockedStorage,
    grid
  };
}

function prepareWeaponSetContext(set, race, topLevelItems, assignedItemIds, actor = null) {
  return {
    ...set,
    slots: (set.slots ?? []).map((slot, index, slots) => prepareWeaponSlotContext({
      setKey: set.key,
      slot,
      slotIndex: index,
      setSlots: slots,
      label: (race?.limbs ?? []).find(entry => entry.key === slot.limbKey)?.label || slot.limbKey || slot.key,
      topLevelItems,
      assignedItemIds,
      race,
      actor
    }))
  };
}

function getConstructNaturalWeaponSetContext(actor, allItemData = []) {
  const slots = allItemData
    .filter(item => isInstalledConstructPartWeapon(actor, item))
    .sort(compareConstructPartDisplayItems)
    .map(item => {
      const document = actor.items.get(item.id);
      const part = getConstructPartFunction(document);
      const label = String(part.partType ?? "").trim() || item.name;
      return {
        key: `constructPartWeapon.${item.id}`,
        label,
        item
      };
    });
  if (!slots.length) return null;
  return {
    key: "constructPartWeapons",
    label: "Оружие",
    slots
  };
}

function prepareConstructPartEquipmentSlots(actor, topLevelItems, assignedItemIds) {
  if (actor?.type !== "construct") return [];
  return topLevelItems
    .filter(item => isInstalledConstructPart(actor, item) && !isInstalledConstructPartWeapon(actor, item))
    .sort(compareConstructPartDisplayItems)
    .map(item => {
      assignedItemIds?.add(item.id);
      const document = actor.items.get(item.id);
      const part = getConstructPartFunction(document);
      const label = String(part.partType ?? "").trim() || item.name;
      return {
        key: `constructPart:${item.id}`,
        label: abbreviateConstructPartSlotLabel(label),
        fullLabel: label,
        locked: true,
        item: {
          ...item,
          equipped: true,
          locked: true
        }
      };
    });
}

function prepareConstructPartWeaponSets(actor, topLevelItems, assignedItemIds) {
  if (actor?.type !== "construct") return [];
  return topLevelItems
    .filter(item => isInstalledConstructPart(actor, item))
    .sort(compareConstructPartDisplayItems)
    .flatMap(item => {
      const document = actor.items.get(item.id);
      const part = getConstructPartFunction(document);
      const partType = String(part.partType ?? "").trim() || item.name;
      return normalizeConstructPartWeaponSets(part.weaponSets).map(set => {
        const setKey = getConstructPartWeaponSetKey(item.id, set.id);
        const label = set.label || `${partType}: оружие`;
        const slots = Array.from({ length: set.quantity }, (_value, index) => {
          const slotKey = getConstructPartWeaponSlotKey(index);
          return {
            key: slotKey,
            label: `${label} ${index + 1}`
          };
        });
        return {
          key: setKey,
          label,
          constructPartId: item.id,
          slots: slots.map((slot, index) => prepareWeaponSlotContext({
            setKey,
            slot,
            slotIndex: index,
            setSlots: slots,
            label: slot.label,
            topLevelItems,
            assignedItemIds,
            actor
          }))
        };
      });
    });
}

function isInstalledConstructPartWeapon(actor, item) {
  const document = actor?.items?.get(item?.id ?? "");
  return Boolean(isInstalledConstructPart(actor, item) && hasItemFunction(document, ITEM_FUNCTIONS.weapon, { ignoreBroken: true }));
}

function isInstalledConstructPart(actor, item) {
  const document = actor?.items?.get(item?.id ?? "");
  return Boolean(
    document?.type === "gear"
    && item?.placement?.mode === ITEM_FUNCTIONS.constructPart
    && hasItemFunction(document, ITEM_FUNCTIONS.constructPart)
  );
}

function normalizeConstructPartWeaponSets(sets) {
  return (Array.isArray(sets) ? sets : [])
    .map(entry => ({
      id: String(entry?.id ?? "").trim(),
      label: String(entry?.label ?? "").trim(),
      quantity: Math.max(0, toInteger(entry?.quantity))
    }))
    .filter(entry => entry.id && entry.quantity > 0);
}

function compareConstructPartDisplayItems(left, right) {
  const leftOrder = toInteger(left?.placement?.constructPartOrder);
  const rightOrder = toInteger(right?.placement?.constructPartOrder);
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  return String(left?.id ?? "").localeCompare(String(right?.id ?? ""));
}

function abbreviateConstructPartSlotLabel(label = "") {
  const words = String(label ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "";
  return words
    .map((word, index) => Array.from(word).slice(0, index === 0 ? 3 : 2).join(""))
    .join("");
}

function prepareContainerWeaponSets(actor, topLevelItems, assignedItemIds) {
  return topLevelItems
    .map(item => ({
      item,
      extraWeaponSlots: getContainerExtraWeaponSlots(actor.items.get(item.id))
    }))
    .filter(entry => entry.item.equipped && entry.extraWeaponSlots > 0)
    .map(entry => {
      const setKey = getContainerWeaponSetKey(entry.item.id);
      return {
        key: setKey,
        label: entry.item.name,
        containerId: entry.item.id,
        slots: Array.from({ length: entry.extraWeaponSlots }, (_value, index) => {
          const slotKey = getContainerWeaponSlotKey(index);
          const label = game.i18n.format("FALLOUTMAW.Item.ContainerExtraWeaponSlotLabel", { number: index + 1 });
          return prepareWeaponSlotContext({
            setKey,
            slot: {
              key: slotKey,
              label,
              containerId: entry.item.id
            },
            slotIndex: index,
            setSlots: Array.from({ length: entry.extraWeaponSlots }, (_slotValue, slotIndex) => ({
              key: getContainerWeaponSlotKey(slotIndex),
              label: game.i18n.format("FALLOUTMAW.Item.ContainerExtraWeaponSlotLabel", { number: slotIndex + 1 }),
              containerId: entry.item.id
            })),
            label,
            topLevelItems,
            assignedItemIds,
            actor
          });
        })
      };
    });
}

function prepareWeaponSlotContext({
  setKey = "",
  slot = {},
  slotIndex = 0,
  setSlots = [],
  label = "",
  topLevelItems = [],
  assignedItemIds = null,
  race = null,
  actor = null
} = {}) {
  const occupant = findWeaponSlotOccupant({
    setKey,
    slot,
    slotIndex,
    setSlots,
    topLevelItems,
    race,
    actor
  });
  const item = occupant?.item ?? null;
  if (item) assignedItemIds?.add(item.id);
  return {
    ...slot,
    label: label || slot.label || slot.key,
    item: item ? {
      ...item,
      phantom: Boolean(occupant?.phantom),
      useDisabled: Boolean(occupant?.useDisabled)
    } : null,
    phantom: Boolean(occupant?.phantom),
    useDisabled: Boolean(occupant?.useDisabled)
  };
}

function findWeaponSlotOccupant({ setKey = "", slot = {}, slotIndex = 0, setSlots = [], topLevelItems = [], race = null, actor = null } = {}) {
  for (const candidate of topLevelItems) {
    const placement = candidate.placement ?? {};
    if (placement.mode !== "weapon" || placement.weaponSet !== setKey) continue;
    if (placement.weaponSlot === slot.key) {
      return {
        item: candidate,
        phantom: false,
        useDisabled: isWeaponSlotOccupantDisabled(actor, race, candidate)
      };
    }

    if (!isPhantomWeaponSlotForItem({ setKey, slot, slotIndex, setSlots, item: candidate, race })) continue;
    return {
      item: candidate,
      phantom: true,
      useDisabled: isWeaponSlotOccupantDisabled(actor, race, candidate)
    };
  }
  return null;
}

function isPhantomWeaponSlotForItem({ setKey = "", slot = {}, slotIndex = 0, setSlots = [], item = null, race = null } = {}) {
  const placement = item?.placement ?? {};
  if (placement.weaponSlot === slot.key) return false;

  if (isContainerWeaponSetKey(setKey)) {
    const primaryIndex = setSlots.findIndex(entry => entry.key === placement.weaponSlot);
    if (primaryIndex < 0) return false;
    const size = getWeaponSlotRequirementSize(item);
    return slotIndex > primaryIndex && slotIndex < (primaryIndex + size);
  }

  const requiredSlots = getRequiredWeaponSlotsForItem(race, item, setKey, placement.weaponSlot);
  return requiredSlots.some(requiredSlot => requiredSlot.key === slot.key);
}

function isWeaponSlotOccupantDisabled(actor, race, item = null) {
  if (!actor || !item || isContainerWeaponSetKey(item.placement?.weaponSet)) return false;
  const requiredSlots = getRequiredWeaponSlotsForItem(race, item, item.placement?.weaponSet, item.placement?.weaponSlot);
  if (getWeaponSlotRequirement(item).selectedKeys.size && !requiredSlots.length) return true;
  return requiredSlots.some(slot => slot.limbKey && getLimbHealingCap(actor, slot.limbKey) <= 0);
}

function getConstructPartWeaponSetKey(itemId = "", setId = "") {
  return `container:constructPart:${itemId}:${setId}`;
}

function getConstructPartWeaponSlotKey(index = 0) {
  return `constructPartWeaponSlot${Math.max(1, toInteger(index) + 1)}`;
}

function getContainerExtraWeaponSlots(container) {
  if (!container || !hasItemFunction(container, ITEM_FUNCTIONS.container)) return 0;
  return Math.max(0, toInteger(container.system?.functions?.container?.extraWeaponSlots));
}

function getContainerWeaponSetKey(containerId = "") {
  return `container:${containerId}`;
}

function getContainerWeaponSlotKey(index = 0) {
  return `extraWeaponSlot${Math.max(1, toInteger(index) + 1)}`;
}

export function createInventoryItemData(item, allItems, currencies = [], placement = null) {
  const resolvedPlacement = placement ?? normalizeInventoryPlacement(item.system?.placement ?? {}, item, allItems);
  const container = item.system?.container ?? {};
  const firstAidCharges = getActiveItemChargesData(item);
  const showFirstAidCharges = (
    hasItemFunction(item, ITEM_FUNCTIONS.firstAid, { ignoreBroken: true })
    || hasItemFunction(item, ITEM_FUNCTIONS.needChange, { ignoreBroken: true })
  ) && firstAidCharges.max > 1;
  return {
    id: item.id,
    uuid: item.uuid,
    name: item.name,
    img: normalizeImagePath(item.img, "icons/svg/item-bag.svg"),
    type: item.type,
    quantity: getItemQuantity(item),
    maxStack: getItemMaxStack(item),
    showQuantity: getItemMaxStack(item) > 1,
    firstAidCharges,
    showFirstAidCharges,
    weight: Number(item.system?.weight) || 0,
    totalWeight: Number(getItemTotalWeight(item, allItems).toFixed(1)),
    price: Number(item.system?.price) || 0,
    priceCurrency: item.system?.priceCurrency ?? "",
    priceCurrencyLabel: currencies.find(currency => currency.key === item.system?.priceCurrency)?.label ?? "",
    equipped: Boolean(item.system?.equipped),
    locked: Boolean(item.system?.locked),
    brokenCondition: isItemBrokenByCondition(item),
    occupiedSlots: item.system?.occupiedSlots ?? {},
    occupiedSlotMode: item.system?.occupiedSlotMode ?? "all",
    weaponSlotRequirement: item.system?.weaponSlotRequirement ?? { mode: "oneOf", slots: {} },
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

function getIndicatorSegmentCount(value = 0) {
  if (value <= 0) return 10;
  return Math.max(1, Math.min(24, Math.trunc(value)));
}

function buildIndicatorMeterStyle(color, segments) {
  const baseColor = normalizeIndicatorColor(color);
  return [
    `--meter-sections: ${segments}`,
    `--meter-color: ${baseColor}`,
    `--meter-color-strong: ${mixHexColor(baseColor, "#ffffff", 0.2)}`,
    `--meter-color-dark: ${mixHexColor(baseColor, "#000000", 0.28)}`,
    `--meter-color-soft: ${hexToRgba(baseColor, 0.2)}`,
    `--meter-color-glow: ${hexToRgba(baseColor, 0.34)}`
  ].join("; ");
}

function buildIndicatorFillStyle(color, percent, { reverse = false } = {}) {
  const baseColor = normalizeIndicatorColor(color);
  const strongColor = mixHexColor(baseColor, "#ffffff", 0.2);
  const darkColor = mixHexColor(baseColor, "#000000", 0.28);
  return [
    reverse ? "margin-left: auto" : "",
    `width: ${Number(percent.toFixed(2))}%`,
    `background: linear-gradient(180deg, ${strongColor}, ${darkColor})`,
    `box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.22), 0 0 14px ${hexToRgba(baseColor, 0.34)}`
  ].filter(Boolean).join("; ");
}

function normalizeIndicatorColor(color) {
  const normalized = String(color ?? "").trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{6}$/.test(normalized)) return `#${normalized}`;
  if (/^[0-9a-f]{3}$/.test(normalized)) return `#${normalized.split("").map(char => `${char}${char}`).join("")}`;
  return "#8f8456";
}

function mixHexColor(hexColor, mixWith, amount = 0.5) {
  const base = hexToRgb(normalizeIndicatorColor(hexColor));
  const mix = hexToRgb(normalizeIndicatorColor(mixWith));
  const ratio = Math.max(0, Math.min(1, Number(amount) || 0));
  const channels = [base.r, base.g, base.b].map((channel, index) => {
    const target = [mix.r, mix.g, mix.b][index];
    return Math.round(channel + ((target - channel) * ratio));
  });
  return `#${channels.map(channel => channel.toString(16).padStart(2, "0")).join("")}`;
}

function hexToRgba(hexColor, alpha = 1) {
  const { r, g, b } = hexToRgb(normalizeIndicatorColor(hexColor));
  const normalizedAlpha = Math.max(0, Math.min(1, Number(alpha) || 0));
  return `rgba(${r}, ${g}, ${b}, ${normalizedAlpha})`;
}

function hexToRgb(hexColor) {
  const normalized = normalizeIndicatorColor(hexColor).slice(1);
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16)
  };
}

function buildInventoryCellStyle(x, y, placement = null) {
  const normalized = placement ?? { width: 1, height: 1 };
  return [
    `grid-column: ${x} / span ${Math.max(1, toInteger(normalized.width))}`,
    `grid-row: ${y} / span ${Math.max(1, toInteger(normalized.height))}`
  ].join("; ");
}
