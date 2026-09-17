import { ITEM_FUNCTIONS, getEnabledWeaponFunctions, getWeaponFunctionUpdatePath } from "./item-functions.mjs";
import { getProtectionModuleTooltipEntry, getModuleTooltipTargetFunction } from "./function-module-tooltip.mjs";
import { getWeaponModuleSlots, getWeaponModuleSlotItemData } from "./weapon-modules.mjs";
import { planActorInventoryGrant } from "./inventory-grants.mjs";
import { planWeaponMagazineCapacityTransition } from "../items/weapon-magazine.mjs";
import { executeInventoryMutation } from "../inventory/mutation.mjs";
import { getOverlayBaseZIndex, reserveOverlayZIndex } from "./overlay-layer.mjs";

function getEntries(item) {
  return [...getEnabledWeaponFunctions(item, { ignoreBroken: true }), getProtectionModuleTooltipEntry(item)]
    .filter(entry => entry?.canHaveModuleSlots);
}

/** Return the module and any excess ammunition in the same inventory mutation. */
export async function uninstallInventoryModule(item, functionId, targetFunction, slotId) {
  const actor = item?.parent;
  if (actor?.documentName !== "Actor" || !actor.isOwner) return false;
  item = actor.items.get(item.id);
  const entry = item && getEntries(item).find(candidate => candidate.id === functionId
    && getModuleTooltipTargetFunction(candidate) === targetFunction);
  if (!entry) return false;
  const slots = getWeaponModuleSlots(entry.data);
  const index = slots.findIndex(slot => slot.id === slotId);
  const data = index >= 0 ? getWeaponModuleSlotItemData(slots[index]) : null;
  if (!data) return false;
  const path = targetFunction === ITEM_FUNCTIONS.damageMitigation
    ? "system.functions.damageMitigation" : getWeaponFunctionUpdatePath(item, entry.id);
  if (!path) return false;
  try {
    const grant = planActorInventoryGrant(actor, data, { quantity: 1, merge: false });
    if (!grant) throw new Error(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));
    slots[index] = { ...slots[index], itemUuid: "", itemData: {} };
    const magazine = targetFunction === ITEM_FUNCTIONS.weapon
      ? planWeaponMagazineCapacityTransition(actor, entry.data, slots, { reservedCreates: grant.creates })
      : { overflow: 0, updates: [], creates: [] };
    const update = { _id: item.id, [`${path}.moduleSlots`]: slots };
    if (magazine.overflow) update[`${path}.magazine.value`] = magazine.value;
    await executeInventoryMutation({ actor, updates: [update, ...grant.updates, ...magazine.updates],
      creates: [...grant.creates, ...magazine.creates] }, { reason: `uninstall-${targetFunction}-module` });
    return true;
  } catch (error) {
    ui.notifications.warn(error.message);
    return false;
  }
}

const SLOT_EVENTS = ["pointerdown", "mousedown", "click", "dblclick", "auxclick", "contextmenu",
  "dragstart", "pointerenter", "pointerover", "pointerout", "mouseover", "mouseout"];

/** Build once per Alt press/render; pointer movement never scans the inventory. */
export class InventoryModuleSlots {
  #root = null;
  #document = null;
  #options = null;
  #alt = false;
  #slots = new Map();
  #tooltip = null;
  #generation = 0;
  #busy = false;
  #key = event => this.#setAlt(event.altKey);
  #blur = () => this.#setAlt(false);
  #pointer = event => this.#setAlt(event.altKey);
  #event = event => {
    let button = event.target?.closest?.(".fallout-maw-item-module-slot");
    // Non-bubbling pointerenter also targets the parent item in container sheets.
    if (!button && event.type === "pointerenter" && this.#alt && this.#slots.size) {
      button = this.#document.elementFromPoint(event.clientX, event.clientY)?.closest?.(".fallout-maw-item-module-slot");
    }
    if (!button || !this.#slots.has(button)) return;
    event.stopImmediatePropagation();
    if (["pointerdown", "mousedown", "click", "dblclick", "auxclick", "contextmenu", "dragstart"].includes(event.type)) event.preventDefault();
    if (event.type === "pointerover" && !button.contains(event.relatedTarget)) void this.#showTooltip(button);
    if (event.type === "pointerout" && !button.contains(event.relatedTarget)) this.#clearTooltip();
    if (event.type === "click" && event.button === 0) void this.#remove(button);
  };

  bind(root, options) {
    this.#detachRoot();
    this.#root = root;
    this.#options = options;
    if (!this.#document) {
      this.#document = root.ownerDocument;
      this.#document.addEventListener("keydown", this.#key, true);
      this.#document.addEventListener("keyup", this.#key, true);
      this.#document.defaultView.addEventListener("blur", this.#blur);
    }
    for (const type of SLOT_EVENTS) root.addEventListener(type, this.#event, true);
    root.addEventListener("pointermove", this.#pointer, true);
    if (this.#alt) this.#build();
  }

  #setAlt(active) {
    active = Boolean(active);
    if (active === this.#alt) return;
    this.#alt = active;
    if (active) this.#build();
    else this.#clearSlots();
  }

  #build() {
    this.#clearSlots();
    const entriesByItem = new Map();
    for (const element of this.#root?.querySelectorAll(".fallout-maw-inventory-item[data-item-id][data-tooltip-item]") ?? []) {
      const item = this.#options.resolveItem(element);
      if (!item) continue;
      if (!entriesByItem.has(item)) entriesByItem.set(item, getEntries(item));
      const entries = entriesByItem.get(item);
      if (!entries.some(entry => entry.data?.moduleSlots?.length)) continue;
      const strip = this.#document.createElement("div");
      strip.className = "fallout-maw-item-module-slots";
      for (const entry of entries) {
        for (const slot of getWeaponModuleSlots(entry.data)) {
          const data = getWeaponModuleSlotItemData(slot);
          const button = this.#document.createElement("button");
          button.type = "button";
          button.className = "fallout-maw-item-module-slot";
          button.classList.toggle("empty", !slot.itemUuid && !slot.itemData?.system);
          button.setAttribute("aria-label", data?.name || slot.moduleKey || game.i18n.localize("FALLOUTMAW.Item.WeaponModuleSlots"));
          button.setAttribute("aria-disabled", String(!this.#options.canUse(item, element) || !item.parent?.isOwner));
          if (data) {
            const image = this.#document.createElement("img");
            image.src = data.img || "icons/svg/item-bag.svg";
            image.alt = data.name ?? "";
            image.draggable = false;
            button.append(image);
          }
          this.#slots.set(button, { element, functionId: entry.id,
            targetFunction: getModuleTooltipTargetFunction(entry), slotId: slot.id });
          strip.append(button);
        }
      }
      if (!strip.childElementCount) continue;
      element.classList.add("fallout-maw-has-alt-module-slots");
      element.append(strip);
    }
  }

  #context(button) {
    const context = this.#slots.get(button);
    if (!context) return null;
    const item = this.#options.resolveItem(context.element);
    const entry = item && getEntries(item).find(candidate => candidate.id === context.functionId
      && getModuleTooltipTargetFunction(candidate) === context.targetFunction);
    const slot = entry && getWeaponModuleSlots(entry.data).find(candidate => candidate.id === context.slotId);
    return slot ? { ...context, item, data: getWeaponModuleSlotItemData(slot) } : null;
  }

  async #remove(button) {
    const context = this.#context(button);
    if (!context?.data || this.#busy || !this.#alt || !this.#options.canUse(context.item, context.element)) return;
    this.#busy = true;
    this.#clearTooltip();
    this.#options.onModuleHover?.();
    try {
      await uninstallInventoryModule(context.item, context.functionId, context.targetFunction, context.slotId);
    } finally {
      this.#busy = false;
      if (this.#alt && this.#root?.isConnected) this.#build();
    }
  }

  async #showTooltip(button) {
    this.#clearTooltip();
    this.#options.onModuleHover?.();
    game.tooltip?.deactivate();
    const context = this.#context(button);
    if (!context?.data) return;
    const generation = this.#generation;
    try {
      // The actor sheet imports the inventory controllers, so render lazily.
      const { renderInventoryItemTooltipHTML, getInventoryTooltipPerspectiveActor } = await import("../sheets/actor-sheet.mjs");
      const actor = context.item.parent;
      const perspective = getInventoryTooltipPerspectiveActor(actor);
      const evaluatingActor = this.#options.getEvaluatingActor
        ? await this.#options.getEvaluatingActor(actor, perspective) : perspective;
      const html = await renderInventoryItemTooltipHTML(context.data, actor, { evaluatingActor, baseMode: true });
      if (generation !== this.#generation || !this.#alt || !button.isConnected) return;
      const tooltip = this.#document.createElement("aside");
      tooltip.className = "fallout-maw-inventory-tooltip fallout-maw-alt-module-tooltip";
      tooltip.setAttribute("role", "tooltip");
      tooltip.innerHTML = html;
      const view = this.#document.defaultView;
      const scale = Number.parseFloat(view.getComputedStyle(this.#root).getPropertyValue("--fallout-maw-ui-scale")) || 1;
      tooltip.style.setProperty("--fallout-maw-ui-scale", String(scale));
      tooltip.style.setProperty("--fallout-maw-tooltip-max-height", `${(view.innerHeight - 16) / scale}px`);
      tooltip.style.maxWidth = `${(view.innerWidth - 16) / scale}px`;
      const zIndex = getOverlayBaseZIndex(this.#root) + 5;
      tooltip.style.zIndex = String(zIndex);
      reserveOverlayZIndex(zIndex);
      this.#document.body.append(tooltip);
      this.#tooltip = tooltip;
      const anchor = button.getBoundingClientRect();
      const rect = tooltip.getBoundingClientRect();
      const left = anchor.right + rect.width + 12 <= view.innerWidth ? anchor.right + 12 : anchor.left - rect.width - 12;
      tooltip.style.left = `${Math.max(8, Math.min(left, view.innerWidth - rect.width - 8))}px`;
      tooltip.style.top = `${Math.max(8, Math.min(anchor.top, view.innerHeight - rect.height - 8))}px`;
    } catch (error) {
      if (generation === this.#generation) console.error("Fallout MAW | Failed to render installed module tooltip", error);
    }
  }

  #clearTooltip() {
    this.#generation++;
    this.#tooltip?.remove();
    this.#tooltip = null;
  }

  #clearSlots() {
    this.#clearTooltip();
    this.#root?.querySelectorAll(".fallout-maw-item-module-slots").forEach(strip => strip.remove());
    this.#root?.querySelectorAll(".fallout-maw-has-alt-module-slots").forEach(element => element.classList.remove("fallout-maw-has-alt-module-slots"));
    this.#slots.clear();
  }

  #detachRoot() {
    this.#clearSlots();
    for (const type of SLOT_EVENTS) this.#root?.removeEventListener(type, this.#event, true);
    this.#root?.removeEventListener("pointermove", this.#pointer, true);
  }

  destroy() {
    this.#detachRoot();
    this.#document?.removeEventListener("keydown", this.#key, true);
    this.#document?.removeEventListener("keyup", this.#key, true);
    this.#document?.defaultView.removeEventListener("blur", this.#blur);
    this.#document = null;
    this.#root = null;
    this.#options = null;
    this.#alt = false;
  }
}
