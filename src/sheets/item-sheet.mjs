import { TEMPLATES } from "../constants.mjs";
import { getCreatureOptions, getCurrencySettings } from "../settings/accessors.mjs";
import { groupRaceEquipmentSlotsBySet } from "../utils/equipment-slots.mjs";

const { ItemSheetV2 } = foundry.applications.sheets;
const { HandlebarsApplicationMixin } = foundry.applications.api;

export class FalloutMaWItemSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
  static DEFAULT_OPTIONS = {
    classes: ["fallout-maw", "fallout-maw-sheet", "fallout-maw-item-sheet", "sheet", "item"],
    position: {
      width: 620,
      height: "auto"
    },
    form: {
      submitOnChange: true
    },
    window: {
      resizable: true
    }
  };

  static PARTS = {
    body: {
      template: TEMPLATES.itemSheet
    }
  };

  get item() {
    return this.document;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const item = this.item;
    const type = item.type;
    const priceCurrency = item.system?.priceCurrency ?? "";
    const occupiedSlots = item.system?.occupiedSlots ?? {};
    const itemFunction = item.system?.itemFunction ?? "";
    const equipmentSlotGroups = groupRaceEquipmentSlotsBySet(getCreatureOptions());
    const equipmentSlotSelections = new Map();

    for (const group of equipmentSlotGroups) {
      for (const slot of group.slots) {
        if (!equipmentSlotSelections.has(slot.selectionKey)) {
          equipmentSlotSelections.set(slot.selectionKey, {
            selectionKey: slot.selectionKey,
            label: slot.label,
            selected: Boolean(occupiedSlots[slot.selectionKey])
          });
        }
      }
    }

    return foundry.utils.mergeObject(context, {
      item,
      system: item.system,
      sourceSystem: item.system?._source ?? item.system,
      owner: item.isOwner,
      editable: this.isEditable,
      itemType: type,
      isGear: type === "gear",
      isContainerFunction: itemFunction === "container",
      isWeapon: type === "weapon",
      isArmor: type === "armor",
      isAbility: type === "ability",
      isEffect: type === "effect",
      itemFunctionChoices: [
        { value: "", label: game.i18n.localize("FALLOUTMAW.Item.FunctionNone"), selected: itemFunction === "" },
        { value: "container", label: game.i18n.localize("FALLOUTMAW.Item.FunctionContainer"), selected: itemFunction === "container" }
      ],
      currencies: getCurrencySettings().map(currency => ({
        ...currency,
        selected: currency.key === priceCurrency
      })),
      equipmentSlotSelections: Array.from(equipmentSlotSelections.values()),
      equipmentSlotGroups: equipmentSlotGroups.map(group => ({
        raceNames: group.races.join(", "),
        slots: group.slots.map(slot => ({
          ...slot,
          selected: Boolean(occupiedSlots[slot.selectionKey])
        }))
      })),
      totalWeight: item.totalWeight
    }, { inplace: false });
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.element?.querySelectorAll("[data-equipment-slot-choice]").forEach(button => {
      button.addEventListener("click", event => this.#onEquipmentSlotChoice(event));
    });
    this.element?.querySelector('select[name="system.itemFunction"]')?.addEventListener("change", event => {
      this.#onItemFunctionChange(event);
    });
  }

  #onEquipmentSlotChoice(event) {
    event.preventDefault();
    const key = event.currentTarget.dataset.equipmentSlotChoice;
    if (!key) return;

    const input = this.element.querySelector(`[data-equipment-slot-input="${key}"]`);
    if (!input) return;

    input.checked = !input.checked;
    this.element.querySelectorAll(`[data-equipment-slot-choice="${key}"]`).forEach(button => {
      button.classList.toggle("active", input.checked);
      button.setAttribute("aria-pressed", String(input.checked));
    });
    return this.item.update({ [`system.occupiedSlots.${key}`]: input.checked });
  }

  #onItemFunctionChange(event) {
    const nextValue = String(event.currentTarget?.value ?? "");
    if (nextValue !== "container") return;
    return this.item.update({
      "system.quantity": 1,
      "system.maxStack": 1
    });
  }
}
