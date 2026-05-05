import { TEMPLATES } from "../constants.mjs";
import { getCreatureOptions, getCurrencySettings, getDamageTypeSettings } from "../settings/accessors.mjs";
import { groupRaceEquipmentSlotsBySet } from "../utils/equipment-slots.mjs";
import { ITEM_FUNCTIONS, hasItemFunction } from "../utils/item-functions.mjs";

const { ItemSheetV2 } = foundry.applications.sheets;
const { HandlebarsApplicationMixin } = foundry.applications.api;
const TextEditor = foundry.applications.ux.TextEditor.implementation;

export class FalloutMaWItemSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
  #functionPickerActive = false;

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

  static TABS = {
    primary: {
      tabs: [
        { id: "details", group: "primary", label: "FALLOUTMAW.Item.DetailsTab" },
        { id: "functions", group: "primary", label: "FALLOUTMAW.Item.FunctionsTab" }
      ],
      initial: "details"
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
    const creatureOptions = getCreatureOptions();
    const damageTypeSettings = getDamageTypeSettings();
    const equipmentSlotGroups = groupRaceEquipmentSlotsBySet(creatureOptions);
    const equipmentSlotSelections = new Map();
    const hasContainerFunction = hasItemFunction(item, ITEM_FUNCTIONS.container);
    const hasDamageMitigationFunction = hasItemFunction(item, ITEM_FUNCTIONS.damageMitigation);
    const containerLoadReduction = Math.max(0, Math.min(100, Number(item.system?.functions?.container?.loadReduction) || 0));
    const descriptionHTML = await TextEditor.enrichHTML(item.system?.description ?? "", {
      secrets: item.isOwner,
      relativeTo: item,
      rollData: item.getRollData?.() ?? {}
    });
    const availableFunctionChoices = [
      {
        value: "",
        label: game.i18n.localize("FALLOUTMAW.Item.FunctionChoose"),
        disabled: true,
        selected: true
      },
      {
        value: ITEM_FUNCTIONS.container,
        label: game.i18n.localize("FALLOUTMAW.Item.FunctionContainer"),
        disabled: hasContainerFunction
      },
      {
        value: ITEM_FUNCTIONS.damageMitigation,
        label: game.i18n.localize("FALLOUTMAW.Item.FunctionDamageMitigation"),
        disabled: hasDamageMitigationFunction
      }
    ];

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
      descriptionHTML,
      isGear: type === "gear",
      isContainerFunction: hasContainerFunction,
      hasDamageMitigationFunction,
      containerLoadReduction,
      canAddItemFunction: availableFunctionChoices.some(choice => choice.value && !choice.disabled),
      showFunctionPicker: this.#functionPickerActive,
      isAbility: type === "ability",
      itemFunctionChoices: availableFunctionChoices,
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
      damageMitigationModeChoices: buildDamageMitigationModeChoices(item),
      damageMitigationTable: buildDamageMitigationTable(item, creatureOptions, damageTypeSettings),
      totalWeight: item.totalWeight
    }, { inplace: false });
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.element?.querySelectorAll("[data-equipment-slot-choice]").forEach(button => {
      button.addEventListener("click", event => this.#onEquipmentSlotChoice(event));
    });
    this.element?.querySelector("[data-add-item-function]")?.addEventListener("click", event => this.#onAddItemFunction(event));
    this.element?.querySelector("[data-choose-item-function]")?.addEventListener("change", event => this.#onChooseItemFunction(event));
    this.element?.querySelectorAll("[data-container-load-reduction]").forEach(input => {
      input.addEventListener("input", event => this.#onContainerLoadReductionInput(event));
      input.addEventListener("change", event => this.#onContainerLoadReductionChange(event));
    });
    this.element?.querySelectorAll("[data-remove-item-function]").forEach(button => {
      button.addEventListener("click", event => this.#onRemoveItemFunction(event));
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

  #onAddItemFunction(event) {
    event.preventDefault();
    this.#functionPickerActive = true;
    return this.render({ force: true });
  }

  #onChooseItemFunction(event) {
    event.preventDefault();
    const functionKey = String(event.currentTarget?.value ?? "");
    if (!functionKey) return undefined;

    if (functionKey === ITEM_FUNCTIONS.container) {
      this.#functionPickerActive = false;
      return this.item.update({
        "system.itemFunction": ITEM_FUNCTIONS.container,
        "system.functions.container.enabled": true,
        "system.functions.container.loadReduction": Number(this.item.system?.functions?.container?.loadReduction) || 0,
        "system.quantity": 1,
        "system.maxStack": 1
      });
    }

    if (functionKey === ITEM_FUNCTIONS.damageMitigation) {
      this.#functionPickerActive = false;
      return this.item.update({
        "system.functions.damageMitigation.enabled": true,
        "system.functions.damageMitigation.mode": "defense"
      });
    }

    return undefined;
  }

  #onRemoveItemFunction(event) {
    event.preventDefault();
    const functionKey = String(event.currentTarget?.dataset?.removeItemFunction ?? "");
    const functionLabel = getItemFunctionLabel(functionKey);
    const confirmed = window.confirm(game.i18n.format("FALLOUTMAW.Item.DeleteFunctionConfirm", {
      function: functionLabel
    }));
    if (!confirmed) return undefined;

    if (functionKey === ITEM_FUNCTIONS.container) {
      return this.item.update({
        "system.itemFunction": "",
        "system.functions.container.enabled": false,
        "system.functions.container.loadReduction": 0
      });
    }
    if (functionKey === ITEM_FUNCTIONS.damageMitigation) {
      return this.item.update({ "system.functions.damageMitigation.enabled": false });
    }
    return undefined;
  }

  #onContainerLoadReductionInput(event) {
    const value = normalizePercentInput(event.currentTarget?.value);
    this.#syncContainerLoadReductionInputs(value);
  }

  #onContainerLoadReductionChange(event) {
    event.preventDefault();
    const value = normalizePercentInput(event.currentTarget?.value);
    this.#syncContainerLoadReductionInputs(value);
    return this.item.update({ "system.functions.container.loadReduction": value });
  }

  #syncContainerLoadReductionInputs(value) {
    this.element?.querySelectorAll("[data-container-load-reduction]").forEach(input => {
      input.value = String(value);
    });
  }
}

function getItemFunctionLabel(functionKey = "") {
  if (functionKey === ITEM_FUNCTIONS.container) return game.i18n.localize("FALLOUTMAW.Item.FunctionContainer");
  if (functionKey === ITEM_FUNCTIONS.damageMitigation) return game.i18n.localize("FALLOUTMAW.Item.FunctionDamageMitigation");
  return game.i18n.localize("FALLOUTMAW.Item.Function");
}

function normalizePercentInput(value) {
  return Math.max(0, Math.min(100, Math.trunc(Number(value) || 0)));
}

function buildDamageMitigationModeChoices(item) {
  const mode = String(item.system?.functions?.damageMitigation?.mode || "defense");
  return [
    { value: "defense", label: game.i18n.localize("FALLOUTMAW.Item.MitigationModeDefense"), selected: mode === "defense" },
    { value: "resistance", label: game.i18n.localize("FALLOUTMAW.Item.MitigationModeResistance"), selected: mode === "resistance" }
  ];
}

function buildDamageMitigationTable(item, creatureOptions, damageTypeSettings) {
  const limbs = getUniqueLimbs(creatureOptions);
  const entries = item.system?.functions?.damageMitigation?.entries ?? {};

  return {
    limbs,
    columns: Math.max(1, limbs.length),
    rows: damageTypeSettings.map(damageType => ({
      damageTypeKey: damageType.key,
      damageTypeLabel: damageType.label,
      cells: limbs.map(limb => ({
        limbKey: limb.key,
        damageTypeKey: damageType.key,
        value: Number(entries?.[limb.key]?.[damageType.key]?.value) || 0
      }))
    }))
  };
}

function getUniqueLimbs(creatureOptions) {
  const limbs = new Map();
  for (const race of creatureOptions?.races ?? []) {
    for (const limb of race.limbs ?? []) {
      if (limbs.has(limb.key)) continue;
      limbs.set(limb.key, {
        key: limb.key,
        label: String(limb.label ?? limb.name ?? limb.key)
      });
    }
  }
  return Array.from(limbs.values());
}
