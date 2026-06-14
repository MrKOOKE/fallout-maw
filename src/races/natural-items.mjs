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
const DEFAULT_NATURAL_SET_LABEL = "Основной";
const naturalItemSyncActors = new Set();

export function createDefaultNaturalItemSetEntry(existingIds = []) {
  const id = getUniqueNaturalSetId("naturalSet", existingIds);
  return normalizeNaturalItemSetEntry({
    id,
    label: getDefaultNaturalSetLabel(),
    naturalWeapons: [],
    naturalFeatures: []
  });
}

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

export function normalizeNaturalItemSetEntries(entries, legacyWeapons = [], legacyFeatures = []) {
  const source = Array.isArray(entries)
    ? entries
    : [{
      id: "naturalSet",
      label: getDefaultNaturalSetLabel(),
      naturalWeapons: legacyWeapons,
      naturalFeatures: legacyFeatures
    }];
  const usedIds = new Set();
  return source.map((entry, index) => {
    const normalized = normalizeNaturalItemSetEntry(entry, index);
    const baseId = normalized.id || `naturalSet${index + 1}`;
    normalized.id = getUniqueNaturalSetId(baseId, usedIds);
    usedIds.add(normalized.id);
    return normalized;
  });
}

export function normalizeNaturalItemSetEntry(entry = {}, index = 0) {
  return {
    id: String(entry?.id ?? "").trim() || `naturalSet${index + 1}`,
    label: String(entry?.label ?? "").trim() || getDefaultNaturalSetLabel(),
    naturalWeapons: normalizeNaturalRaceItemEntries(entry?.naturalWeapons, NATURAL_RACE_ITEM_KINDS.weapon),
    naturalFeatures: normalizeNaturalRaceItemEntries(entry?.naturalFeatures, NATURAL_RACE_ITEM_KINDS.feature)
  };
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
    if (paths.some(path => path === "system.creature.raceId" || path === "system.creature.subtypeId")) {
      void syncActorNaturalRaceItems(actor);
    }
  });
  Hooks.on("preDeleteItem", (item, options) => {
    if (!isNaturalRaceWeapon(item)) return undefined;
    if (options?.allowNaturalRaceItemDelete) return undefined;
    ui.notifications?.warn?.("Natural race weapons cannot be deleted from an actor.");
    return false;
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

export async function syncLoadedActorNaturalRaceItems() {
  if (!game.user?.isActiveGM) return;
  for (const actor of getLoadedNaturalRaceItemActors()) {
    await syncActorNaturalRaceItems(actor);
  }
}

export async function syncActorNaturalRaceItems(actor) {
  if (!actor || !game.user?.isActiveGM) return;
  if (actor.type !== "character") return;
  if (naturalItemSyncActors.has(actor.uuid)) return;

  naturalItemSyncActors.add(actor.uuid);
  try {
    const race = getCreatureOptions().races.find(entry => entry.id === actor.system?.creature?.raceId) ?? null;
    const naturalSet = getActorNaturalItemSet(actor, race);
    const desired = buildDesiredNaturalItems(race, naturalSet);
    const naturalItems = actor.items?.filter(item => isNaturalRaceItem(item)) ?? [];
    const { creates, deletes } = planActorNaturalRaceItemSync(naturalItems, desired);
    if (!creates.length && !deletes.length) return;
    if (deletes.length) await actor.deleteEmbeddedDocuments("Item", deletes, { allowNaturalRaceItemDelete: true });
    if (creates.length) await actor.createEmbeddedDocuments("Item", creates.map(entry => entry.data));
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
  const naturalSet = getActorNaturalItemSet(actor, race);
  const slots = (naturalSet?.naturalWeapons ?? []).map(entry => {
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
    label: naturalSet?.label || game.i18n.localize("FALLOUTMAW.Settings.CreatureOptions.NaturalWeapons"),
    slots
  };
}

export function getActorNaturalItemSet(actor, race) {
  const sets = race?.naturalItemSets ?? [];
  if (!sets.length) return null;
  const subtypeId = String(actor?.system?.creature?.subtypeId ?? "");
  return sets.find(entry => entry.id === subtypeId) ?? sets[0] ?? null;
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

function buildDesiredNaturalItems(race, naturalSet) {
  if (!race || !naturalSet) return [];
  return [
    ...(naturalSet.naturalWeapons ?? []).map(entry => buildDesiredNaturalItem(race, naturalSet, entry, NATURAL_RACE_ITEM_KINDS.weapon)),
    ...(naturalSet.naturalFeatures ?? []).map(entry => buildDesiredNaturalItem(race, naturalSet, entry, NATURAL_RACE_ITEM_KINDS.feature))
  ].filter(Boolean);
}

function buildDesiredNaturalItem(race, naturalSet, entry, kind) {
  if (!entry?.id || !entry?.item) return null;
  const templateSignature = getNaturalRaceItemTemplateSignature(entry.item, kind, entry.id);
  const data = normalizeNaturalRaceItemData(entry.item, kind, entry.id);
  foundry.utils.setProperty(data, `flags.${SYSTEM_ID}.${NATURAL_RACE_ITEM_FLAG}`, {
    kind,
    raceId: race.id,
    subtypeId: naturalSet.id,
    sourceId: entry.id,
    templateSignature
  });
  return {
    kind,
    raceId: race.id,
    subtypeId: naturalSet.id,
    sourceId: entry.id,
    templateSignature,
    data
  };
}

function planActorNaturalRaceItemSync(naturalItems = [], desired = []) {
  const desiredByKey = new Map(desired.map(entry => [getNaturalRaceItemSyncKey(entry), entry]));
  const keptKeys = new Set();
  const deletes = [];

  for (const item of naturalItems) {
    const flag = getNaturalRaceItemFlag(item);
    const key = getNaturalRaceItemSyncKey(flag);
    const desiredEntry = desiredByKey.get(key);
    const current = {
      kind: String(flag?.kind ?? ""),
      raceId: String(flag?.raceId ?? ""),
      subtypeId: String(flag?.subtypeId ?? ""),
      sourceId: String(flag?.sourceId ?? ""),
      templateSignature: String(flag?.templateSignature ?? "")
    };
    const matches = desiredEntry
      && !keptKeys.has(key)
      && current.kind === desiredEntry.kind
      && current.raceId === desiredEntry.raceId
      && current.subtypeId === desiredEntry.subtypeId
      && current.sourceId === desiredEntry.sourceId
      && current.templateSignature === desiredEntry.templateSignature;
    if (matches) {
      keptKeys.add(key);
      continue;
    }
    deletes.push(item.id);
  }

  const creates = desired.filter(entry => !keptKeys.has(getNaturalRaceItemSyncKey(entry)));
  return { creates, deletes };
}

function getNaturalRaceItemSyncKey(entry = {}) {
  return `${entry?.kind ?? ""}:${entry?.sourceId ?? ""}`;
}

function getNaturalRaceItemTemplateSignature(itemData, kind, sourceId = "") {
  const data = normalizeNaturalRaceItemData(itemData, kind, sourceId);
  return JSON.stringify(sortObjectKeys(data));
}

function getLoadedNaturalRaceItemActors() {
  const actors = new Set(game.actors?.contents ?? []);
  for (const token of globalThis.canvas?.tokens?.placeables ?? []) {
    if (token.actor) actors.add(token.actor);
  }
  return actors;
}

function getUniqueNaturalSetId(baseId = "naturalSet", existingIds = []) {
  const existing = existingIds instanceof Set ? existingIds : new Set(existingIds);
  const base = String(baseId ?? "").trim() || "naturalSet";
  if (!existing.has(base)) return base;
  let index = 2;
  while (existing.has(`${base}${index}`)) index += 1;
  return `${base}${index}`;
}

function getDefaultNaturalSetLabel() {
  return globalThis.game?.i18n?.localize?.("FALLOUTMAW.Settings.CreatureOptions.DefaultNaturalSet") || DEFAULT_NATURAL_SET_LABEL;
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
