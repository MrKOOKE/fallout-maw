import { SYSTEM_ID } from "../constants.mjs";
import { getCreatureOptions } from "../settings/accessors.mjs";
import { LOCKED_FEATURES_CATEGORY_ID, prepareAbilityItemData } from "../settings/abilities.mjs";
import { createStoredPlacement, ROOT_CONTAINER_ID } from "../utils/inventory-containers.mjs";

export const NATURAL_RACE_ITEM_FLAG = "naturalRaceItem";
export const NATURAL_RACE_WEAPON_SET_KEY = "naturalRaceWeapons";
export const NATURAL_RACE_ITEM_KINDS = Object.freeze({
  weapon: "weapon",
  feature: "feature"
});

const DEFAULT_NATURAL_WEAPON_NAME = "Natural Weapon";
const DEFAULT_NATURAL_FEATURE_NAME = "Natural Feature";
const naturalItemSyncActors = new Set();

export function createDefaultNaturalWeaponEntry() {
  const id = foundry.utils.randomID();
  return normalizeNaturalRaceItemEntry({
    id,
    item: {
      name: DEFAULT_NATURAL_WEAPON_NAME,
      type: "gear",
      img: "icons/svg/combat.svg",
      system: {
        itemFunction: "",
        quantity: 1,
        maxStack: 1,
        weight: 0,
        price: 0,
        equipped: false,
        container: { parentId: "" },
        placement: createNaturalWeaponPlacement(id)
      }
    }
  }, NATURAL_RACE_ITEM_KINDS.weapon);
}

export function createDefaultNaturalFeatureEntry() {
  return normalizeNaturalRaceItemEntry({
    id: foundry.utils.randomID(),
    item: {
      name: DEFAULT_NATURAL_FEATURE_NAME,
      type: "ability",
      img: "icons/svg/upgrade.svg",
      system: {
        cost: 0,
        formula: "",
        acquisition: {
          onlyFree: true,
          onlyManual: true,
          skillKey: "",
          difficulty: 60
        },
        acquisitionRequirements: [],
        functions: []
      }
    }
  }, NATURAL_RACE_ITEM_KINDS.feature);
}

export function createNaturalFeatureEntryFromCatalogAbility(ability = {}) {
  return normalizeNaturalRaceItemEntry({
    id: foundry.utils.randomID(),
    item: prepareAbilityItemData(ability, { categoryId: LOCKED_FEATURES_CATEGORY_ID })
  }, NATURAL_RACE_ITEM_KINDS.feature);
}

export function normalizeNaturalRaceItemEntries(entries, kind) {
  return (Array.isArray(entries) ? entries : [])
    .map(entry => normalizeNaturalRaceItemEntry(entry, kind))
    .filter(entry => entry.id && entry.item);
}

export function normalizeNaturalRaceItemEntry(entry = {}, kind = NATURAL_RACE_ITEM_KINDS.weapon) {
  const id = String(entry?.id ?? "").trim() || foundry.utils.randomID();
  const item = normalizeNaturalRaceItemData(entry?.item ?? entry, kind, id);
  return { id, item };
}

export function normalizeNaturalRaceItemData(itemData = {}, kind = NATURAL_RACE_ITEM_KINDS.weapon, sourceId = "") {
  const data = foundry.utils.deepClone(itemData ?? {});
  delete data._id;
  delete data.id;
  data.name = String(data.name ?? "").trim() || (
    kind === NATURAL_RACE_ITEM_KINDS.feature ? DEFAULT_NATURAL_FEATURE_NAME : DEFAULT_NATURAL_WEAPON_NAME
  );
  data.type = kind === NATURAL_RACE_ITEM_KINDS.feature ? "ability" : "gear";
  data.img = String(data.img ?? "").trim() || (
    kind === NATURAL_RACE_ITEM_KINDS.feature ? "icons/svg/upgrade.svg" : "icons/svg/combat.svg"
  );
  data.system ??= {};
  if (kind === NATURAL_RACE_ITEM_KINDS.weapon) {
    data.system.quantity = 1;
    data.system.maxStack = 1;
    data.system.equipped = false;
    data.system.container = { ...(data.system.container ?? {}), parentId: ROOT_CONTAINER_ID };
    data.system.placement = createNaturalWeaponPlacement(sourceId);
    data.system.occupiedSlots = {};
    data.system.weaponSlotRequirement = { mode: "oneOf", slots: {} };
  } else {
    data.system.cost = 0;
  }
  delete data.flags?.[SYSTEM_ID]?.[NATURAL_RACE_ITEM_FLAG];
  return data;
}

export function registerNaturalRaceItemHooks() {
  Hooks.on("createActor", actor => void syncActorNaturalRaceItems(actor));
  Hooks.on("updateActor", (actor, changes) => {
    const paths = Object.keys(foundry.utils.flattenObject(changes ?? {}));
    if (paths.some(path => path === "system.creature.raceId" || path === "system.creature.typeId")) {
      void syncActorNaturalRaceItems(actor);
    }
  });
  Hooks.on("updateSetting", setting => {
    if (setting?.key === `${SYSTEM_ID}.creatureOptions`) void syncLoadedActorsNaturalRaceItems();
  });
  Hooks.on("preDeleteItem", (item, options) => {
    if (!isNaturalRaceWeapon(item)) return undefined;
    if (options?.allowNaturalRaceItemDelete) return undefined;
    ui.notifications?.warn?.("Natural race weapons cannot be deleted from an actor.");
    return false;
  });
  Hooks.on("deleteItem", item => {
    if (isNaturalRaceItem(item)) void syncActorNaturalRaceItems(item.parent);
  });
  Hooks.on("preUpdateItem", (item, changes, options) => {
    if (!isNaturalRaceWeapon(item) || options?.allowNaturalRaceItemUpdate) return undefined;
    const flag = getNaturalRaceItemFlag(item);
    const sourceId = String(flag?.sourceId ?? "");
    const enforced = createNaturalWeaponPlacement(sourceId);
    foundry.utils.setProperty(changes, "system.equipped", false);
    foundry.utils.setProperty(changes, "system.container.parentId", ROOT_CONTAINER_ID);
    for (const [key, value] of Object.entries(enforced)) {
      foundry.utils.setProperty(changes, `system.placement.${key}`, value);
    }
    return undefined;
  });
}

export async function syncLoadedActorsNaturalRaceItems() {
  if (!game.user?.isActiveGM) return;
  const actors = new Map();
  for (const actor of game.actors ?? []) actors.set(actor.uuid, actor);
  for (const token of canvas?.tokens?.placeables ?? []) {
    if (token.actor) actors.set(token.actor.uuid, token.actor);
  }
  for (const actor of actors.values()) await syncActorNaturalRaceItems(actor);
}

export async function syncActorNaturalRaceItems(actor) {
  if (!actor || !game.user?.isActiveGM) return;
  if (!["character", "npc"].includes(actor.type)) return;
  if (naturalItemSyncActors.has(actor.uuid)) return;

  naturalItemSyncActors.add(actor.uuid);
  try {
    const race = getCreatureOptions().races.find(entry => entry.id === actor.system?.creature?.raceId) ?? null;
    const desired = buildDesiredNaturalItems(race);
    const desiredKeys = new Set(desired.map(entry => getDesiredNaturalItemKey(entry.kind, entry.sourceId)));
    const naturalItems = actor.items?.filter(item => isNaturalRaceItem(item)) ?? [];
    const deletes = naturalItems
      .filter(item => !desiredKeys.has(getDesiredNaturalItemKey(getNaturalRaceItemFlag(item)?.kind, getNaturalRaceItemFlag(item)?.sourceId)))
      .map(item => item.id);
    if (deletes.length) await actor.deleteEmbeddedDocuments("Item", deletes, { allowNaturalRaceItemDelete: true });

    const remaining = actor.items?.filter(item => isNaturalRaceItem(item)) ?? [];
    const byKey = new Map(remaining.map(item => [
      getDesiredNaturalItemKey(getNaturalRaceItemFlag(item)?.kind, getNaturalRaceItemFlag(item)?.sourceId),
      item
    ]));
    const creates = [];
    const updates = [];

    for (const entry of desired) {
      const key = getDesiredNaturalItemKey(entry.kind, entry.sourceId);
      const existing = byKey.get(key);
      if (!existing) {
        creates.push(entry.data);
        continue;
      }

      const update = buildNaturalItemUpdate(existing, entry);
      if (update) updates.push(update);
    }

    if (updates.length) await actor.updateEmbeddedDocuments("Item", updates, { allowNaturalRaceItemUpdate: true });
    if (creates.length) await actor.createEmbeddedDocuments("Item", creates);
  } finally {
    naturalItemSyncActors.delete(actor.uuid);
  }
}

export function isNaturalRaceItem(itemOrData, kind = "") {
  const flag = getNaturalRaceItemFlag(itemOrData);
  if (!flag?.kind) return false;
  return kind ? flag.kind === kind : true;
}

export function isNaturalRaceWeapon(itemOrData) {
  return isNaturalRaceItem(itemOrData, NATURAL_RACE_ITEM_KINDS.weapon);
}

export function isNaturalRaceFeature(itemOrData) {
  return isNaturalRaceItem(itemOrData, NATURAL_RACE_ITEM_KINDS.feature);
}

export function getNaturalRaceItemFlag(itemOrData) {
  if (!itemOrData) return null;
  return itemOrData.getFlag?.(SYSTEM_ID, NATURAL_RACE_ITEM_FLAG)
    ?? itemOrData.flags?.[SYSTEM_ID]?.[NATURAL_RACE_ITEM_FLAG]
    ?? null;
}

export function getNaturalWeaponSetContext(actor, race, currencies = []) {
  const slots = (race?.naturalWeapons ?? []).map(entry => {
    const item = actor?.items?.contents?.find(candidate => {
      const flag = getNaturalRaceItemFlag(candidate);
      return flag?.kind === NATURAL_RACE_ITEM_KINDS.weapon && flag.sourceId === entry.id;
    }) ?? null;
    return {
      key: entry.id,
      label: item?.name || entry.item?.name || DEFAULT_NATURAL_WEAPON_NAME,
      item: item ? createNaturalWeaponDisplayItem(item, currencies) : null
    };
  });
  if (!slots.length) return null;
  return {
    key: NATURAL_RACE_WEAPON_SET_KEY,
    label: game.i18n.localize("FALLOUTMAW.Settings.CreatureOptions.NaturalWeapons"),
    slots
  };
}

export function createNaturalWeaponPlacement(sourceId = "") {
  return createStoredPlacement({
    mode: "weapon",
    equipmentSlot: "",
    weaponSet: NATURAL_RACE_WEAPON_SET_KEY,
    weaponSlot: sourceId,
    x: 1,
    y: 1,
    width: 1,
    height: 1
  });
}

function buildDesiredNaturalItems(race) {
  if (!race) return [];
  return [
    ...(race.naturalWeapons ?? []).map(entry => buildDesiredNaturalItem(race, entry, NATURAL_RACE_ITEM_KINDS.weapon)),
    ...(race.naturalFeatures ?? []).map(entry => buildDesiredNaturalItem(race, entry, NATURAL_RACE_ITEM_KINDS.feature))
  ].filter(Boolean);
}

function buildDesiredNaturalItem(race, entry, kind) {
  if (!entry?.id || !entry?.item) return null;
  const templateSignature = getNaturalRaceItemTemplateSignature(entry.item, kind, entry.id);
  const data = normalizeNaturalRaceItemData(entry.item, kind, entry.id);
  foundry.utils.setProperty(data, `flags.${SYSTEM_ID}.${NATURAL_RACE_ITEM_FLAG}`, {
    kind,
    raceId: race.id,
    sourceId: entry.id,
    templateSignature
  });
  return {
    kind,
    raceId: race.id,
    sourceId: entry.id,
    templateSignature,
    data
  };
}

function buildNaturalItemUpdate(existing, desired) {
  const flag = getNaturalRaceItemFlag(existing);
  const updateData = foundry.utils.deepClone(desired.data);
  updateData._id = existing.id;
  const comparableSignature = getNaturalRaceItemTemplateSignature(existing.toObject(), desired.kind, desired.sourceId);
  if (flag?.templateSignature === comparableSignature) return updateData;

  const update = {
    _id: existing.id,
    [`flags.${SYSTEM_ID}.${NATURAL_RACE_ITEM_FLAG}`]: {
      kind: desired.kind,
      raceId: desired.raceId,
      sourceId: desired.sourceId,
      templateSignature: flag?.templateSignature || comparableSignature
    }
  };
  if (desired.kind === NATURAL_RACE_ITEM_KINDS.weapon) {
    const placement = createNaturalWeaponPlacement(desired.sourceId);
    update["system.equipped"] = false;
    update["system.container.parentId"] = ROOT_CONTAINER_ID;
    for (const [key, value] of Object.entries(placement)) update[`system.placement.${key}`] = value;
  }
  return update;
}

function getNaturalRaceItemTemplateSignature(itemData, kind, sourceId = "") {
  const data = normalizeNaturalRaceItemData(itemData, kind, sourceId);
  return JSON.stringify(sortObjectKeys(data));
}

function getDesiredNaturalItemKey(kind = "", sourceId = "") {
  return `${kind}:${sourceId}`;
}

function createNaturalWeaponDisplayItem(item, currencies = []) {
  const currency = currencies.find(entry => entry.key === item.system?.priceCurrency);
  return {
    id: item.id,
    uuid: item.uuid,
    name: item.name,
    img: item.img || "icons/svg/combat.svg",
    type: item.type,
    quantity: 1,
    maxStack: 1,
    showQuantity: false,
    firstAidCharges: { value: 0, max: 0 },
    showFirstAidCharges: false,
    weight: Number(item.system?.weight) || 0,
    totalWeight: Number(item.system?.weight) || 0,
    price: Number(item.system?.price) || 0,
    priceCurrency: item.system?.priceCurrency ?? "",
    priceCurrencyLabel: currency?.label ?? "",
    equipped: false,
    occupiedSlots: {},
    weaponSlotRequirement: item.system?.weaponSlotRequirement ?? { mode: "oneOf", slots: {} },
    itemFunction: item.system?.itemFunction ?? "",
    isContainer: false,
    parentId: "",
    placement: createNaturalWeaponPlacement(getNaturalRaceItemFlag(item)?.sourceId ?? ""),
    container: {
      parentId: "",
      columns: 1,
      rows: 1,
      maxLoad: 0
    }
  };
}

function sortObjectKeys(value) {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortObjectKeys(entry)])
  );
}
