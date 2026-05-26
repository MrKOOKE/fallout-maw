import { createDefaultInventorySize } from "../settings/creature-options.mjs";
import { getCurrencySettings } from "../settings/accessors.mjs";
import {
  getEquipmentSlotSelectionKey,
  getRequiredWeaponSlotsForItem,
  getSelectedEquipmentSlotKeys,
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
  isContainerItem,
  normalizeInventoryPlacement,
  prepareInventoryGridContext
} from "./inventory-containers.mjs";
import { hasItemFunction, ITEM_FUNCTIONS } from "./item-functions.mjs";
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

export function prepareInventoryContext(actor, race) {
  const currencies = getCurrencySettings();
  const { columns, rows } = getInventoryGridDimensions(race);
  const allItems = actor.items.contents.filter(item => !["ability", "trauma", "disease"].includes(item.type));
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

  const weaponSets = [
    ...(race?.weaponSets ?? []).map(set => prepareWeaponSetContext(set, race, topLevelItems, assignedItemIds, actor)),
    ...prepareContainerWeaponSets(actor, topLevelItems, assignedItemIds)
  ];

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
    equipmentSlots,
    weaponSets,
    containers,
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
  return {
    id: item.id,
    uuid: item.uuid,
    name: item.name,
    img: normalizeImagePath(item.img, "icons/svg/item-bag.svg"),
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
