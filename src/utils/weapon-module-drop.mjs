import { ITEM_FUNCTIONS, getEnabledWeaponFunctions, getWeaponFunctionUpdatePath } from "./item-functions.mjs";
import { createWeaponModuleSlotItemData, findFreeWeaponModuleSlot, isFunctionModuleItem } from "./weapon-modules.mjs";
import { getItemQuantity } from "./inventory-containers.mjs";
import { executeInventoryMutation } from "../inventory/mutation.mjs";
import { planInventoryItemConsumption } from "../inventory/consume.mjs";
import { planWeaponMagazineCapacityTransition } from "../items/weapon-magazine.mjs";
import { InventoryModuleSlots } from "./inventory-module-slots.mjs";

export function canShowSuitableWeaponModules(item) {
  return getEnabledWeaponFunctions(item, { ignoreBroken: true }).length > 0;
}

export function canUseWeaponModuleDrag(data = {}) {
  return !data.falloutMawTradeOffer && !data.falloutMawTradeCatalogPhantom && !data.falloutMawTradeCatalogAggregate;
}

export function isWeaponModuleDrop(moduleItem, weapon) {
  return isFunctionModuleItem(moduleItem, ITEM_FUNCTIONS.weapon) && canShowSuitableWeaponModules(weapon);
}

export function getWeaponModuleDropElement(event, root) {
  const direct = event.target?.closest?.("[data-item-id]");
  if (direct && root?.contains(direct)) return direct;
  const doc = root?.ownerDocument ?? globalThis.document;
  const pointed = doc?.elementFromPoint?.(event.clientX, event.clientY)?.closest?.("[data-item-id]");
  return pointed && root?.contains(pointed) ? pointed : null;
}

function canInstallModule(actor, moduleItem) {
  if (!actor?.isOwner) return false;
  const sourceActor = moduleItem?.parent?.documentName === "Actor" ? moduleItem.parent : null;
  return sourceActor ? Boolean(sourceActor.isOwner) : Boolean(game.user?.isGM);
}

/** Install and consume together, including transfers between owned actors. */
export async function installDroppedWeaponModule({ actor, weapon, moduleItem, sourceStackIndex = 0 }) {
  if (!canInstallModule(actor, moduleItem)) return null;
  weapon = actor.items.get(weapon?.id);
  const sourceActor = moduleItem?.parent?.documentName === "Actor" ? moduleItem.parent : null;
  if (sourceActor) moduleItem = sourceActor.items.get(moduleItem.id);
  if (!weapon || !moduleItem || getItemQuantity(moduleItem) < 1) return null;
  const match = findFreeWeaponModuleSlot(weapon, moduleItem);
  if (!match) {
    ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Item.WeaponModuleNoFreeSlot"));
    return null;
  }
  const { entry, slots, slotIndex } = match;
  const path = getWeaponFunctionUpdatePath(weapon, entry.id);
  if (!path) return null;
  slots[slotIndex] = { ...slots[slotIndex], itemUuid: moduleItem.uuid ?? "", itemData: createWeaponModuleSlotItemData(moduleItem) };
  try {
    const magazinePlan = planWeaponMagazineCapacityTransition(actor, entry.data, slots);
    const update = { _id: weapon.id, [`${path}.moduleSlots`]: slots };
    if (magazinePlan.overflow) update[`${path}.magazine.value`] = magazinePlan.value;
    const plans = [{ actor, updates: [update, ...magazinePlan.updates], creates: magazinePlan.creates }];
    if (sourceActor) {
      const consumption = planInventoryItemConsumption({ item: moduleItem, amount: 1, stackIndex: sourceStackIndex });
      if (!consumption.changed) return null;
      plans.push({ actor: sourceActor, updates: consumption.updates, deletes: consumption.deletes });
    }
    await executeInventoryMutation(plans, { reason: "drop-install-weapon-module" });
    return actor.items.get(weapon.id) ?? null;
  } catch (error) {
    ui.notifications.warn(error.message);
    return null;
  }
}

/** One scan when a drag starts, rather than searching inventories on every pointer move. */
export class WeaponModuleDropPreview {
  #root = null;
  #resolveItem = null;
  #canUse = null;
  #moduleItem = null;
  #hookIds = [];
  #document = null;
  #generation = 0;
  #highlightTimer = null;
  #altSlots = new InventoryModuleSlots();
  #nativeStart = event => {
    const source = event.target?.closest?.(".directory-item.item[data-entry-id], .directory-item.item[data-document-id]");
    const worldItem = source ? game.items?.get(source.dataset.entryId ?? source.dataset.documentId) : null;
    if (worldItem) {
      void this.#start(worldItem.toDragData());
      return;
    }
    let data;
    try { data = JSON.parse(event.dataTransfer?.getData("application/json") || event.dataTransfer?.getData("text/plain") || "null"); }
    catch { return; }
    void this.#start(data);
  };
  #nativeEnd = () => this.#end();

  bind(root, { resolveItem, canUse, onModuleHover, getEvaluatingActor }) {
    this.#clear("module-drop-match-preview");
    this.#root = root;
    this.#resolveItem = resolveItem;
    this.#canUse = canUse;
    this.#altSlots.bind(root, { resolveItem, canUse, onModuleHover, getEvaluatingActor });
    if (!this.#hookIds.length) {
      this.#hookIds = [
        ["falloutMawItemDragStart", Hooks.on("falloutMawItemDragStart", data => { void this.#start(data); })],
        ["falloutMawItemDragEnd", Hooks.on("falloutMawItemDragEnd", () => this.#end())]
      ];
      this.#document = root?.ownerDocument ?? document;
      this.#document.addEventListener("dragstart", this.#nativeStart, true);
      this.#document.addEventListener("dragstart", this.#nativeStart);
      this.#document.addEventListener("dragend", this.#nativeEnd, true);
      this.#document.addEventListener("drop", this.#nativeEnd, true);
    }
    this.#apply();
  }

  async #start(data) {
    this.#end();
    if (data?.type !== "Item" || !canUseWeaponModuleDrag(data)) return;
    const generation = this.#generation;
    let item = data.data;
    if (!item && data.uuid) {
      try { item = foundry.utils.fromUuidSync(data.uuid); } catch { /* Compendium Items resolve asynchronously. */ }
    }
    if (!item) {
      try { item = await Item.implementation.fromDropData(data); } catch { return; }
    }
    if (generation !== this.#generation || !isFunctionModuleItem(item, ITEM_FUNCTIONS.weapon) || getItemQuantity(item) < 1) return;
    this.#moduleItem = item;
    this.#apply();
  }

  #apply() {
    if (!this.#moduleItem) return;
    const matches = new Map();
    for (const element of this.#root?.querySelectorAll("[data-item-id]") ?? []) {
      if (element.closest("[data-trade-offer-entry], [data-trade-catalog-phantom]")) continue;
      const weapon = this.#resolveItem(element);
      if (!weapon || !this.#canUse(weapon, element) || !canInstallModule(weapon.parent, this.#moduleItem)) continue;
      const key = weapon.uuid;
      if (!matches.has(key)) matches.set(key, Boolean(findFreeWeaponModuleSlot(weapon, this.#moduleItem)));
      if (matches.get(key)) element.classList.add("module-drop-match-preview");
    }
  }

  matches(event, moduleItem = this.#moduleItem) {
    if (!moduleItem) return false;
    const element = getWeaponModuleDropElement(event, this.#root);
    const weapon = element ? this.#resolveItem(element) : null;
    return Boolean(weapon && moduleItem && this.#canUse(weapon, element)
      && canInstallModule(weapon.parent, moduleItem) && findFreeWeaponModuleSlot(weapon, moduleItem));
  }

  highlightModules(weapon) {
    this.#clear("module-compatibility-highlight");
    if (this.#highlightTimer) clearTimeout(this.#highlightTimer);
    for (const element of this.#root?.querySelectorAll("[data-item-id]") ?? []) {
      const item = this.#resolveItem(element);
      if (item && findFreeWeaponModuleSlot(weapon, item)) element.classList.add("module-compatibility-highlight");
    }
    this.#highlightTimer = setTimeout(() => {
      this.#highlightTimer = null;
      this.#clear("module-compatibility-highlight");
    }, 10000);
  }

  #clear(className) {
    this.#root?.querySelectorAll(`.${className}`).forEach(element => element.classList.remove(className));
  }

  #end() {
    this.#generation++;
    this.#moduleItem = null;
    this.#clear("module-drop-match-preview");
  }

  destroy() {
    this.#altSlots.destroy();
    this.#end();
    this.#clear("module-compatibility-highlight");
    if (this.#highlightTimer) clearTimeout(this.#highlightTimer);
    this.#highlightTimer = null;
    for (const [name, id] of this.#hookIds) Hooks.off(name, id);
    this.#hookIds = [];
    this.#document?.removeEventListener("dragstart", this.#nativeStart);
    this.#document?.removeEventListener("dragstart", this.#nativeStart, true);
    this.#document?.removeEventListener("dragend", this.#nativeEnd, true);
    this.#document?.removeEventListener("drop", this.#nativeEnd, true);
    this.#document = null;
    this.#root = null;
  }
}
