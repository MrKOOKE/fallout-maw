import { TEMPLATES } from "../constants.mjs";
import { getCreatureOptions, getCurrencySettings, getDamageTypeSettings, getSkillSettings, getToolSettings } from "../settings/accessors.mjs";
import { groupRaceEquipmentSlotsBySet } from "../utils/equipment-slots.mjs";
import {
  ITEM_FUNCTIONS,
  createToolFunctionKey,
  getToolKeyFromFunctionKey,
  hasItemFunction
} from "../utils/item-functions.mjs";

const { ItemSheetV2 } = foundry.applications.sheets;
const { DialogV2, HandlebarsApplicationMixin } = foundry.applications.api;
const TextEditor = foundry.applications.ux.TextEditor.implementation;

export class FalloutMaWItemSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
  #functionPickerActive = false;
  #mitigationFillDrag = null;

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
    const toolSettings = getToolSettings();
    const skillSettings = getSkillSettings();
    const equipmentSlotGroups = groupRaceEquipmentSlotsBySet(creatureOptions);
    const equipmentSlotSelections = new Map();
    const hasContainerFunction = hasItemFunction(item, ITEM_FUNCTIONS.container);
    const hasDamageMitigationFunction = hasItemFunction(item, ITEM_FUNCTIONS.damageMitigation);
    const hasConditionFunction = hasItemFunction(item, ITEM_FUNCTIONS.condition);
    const hasWeaponFunction = hasItemFunction(item, ITEM_FUNCTIONS.weapon);
    const containerLoadReduction = Math.max(0, Math.min(100, Number(item.system?.functions?.container?.loadReduction) || 0));
    const descriptionHTML = await TextEditor.enrichHTML(item.system?.description ?? "", {
      secrets: item.isOwner,
      relativeTo: item,
      rollData: item.getRollData?.() ?? {}
    });
    const toolFunctions = buildToolFunctionEntries(item, toolSettings, skillSettings);
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
      },
      {
        value: ITEM_FUNCTIONS.condition,
        label: game.i18n.localize("FALLOUTMAW.Item.FunctionCondition"),
        disabled: hasConditionFunction
      },
      {
        value: ITEM_FUNCTIONS.weapon,
        label: game.i18n.localize("FALLOUTMAW.Item.FunctionWeapon"),
        disabled: hasWeaponFunction
      },
      ...toolFunctions.map(tool => ({
        value: createToolFunctionKey(tool.key),
        label: tool.label,
        disabled: tool.enabled
      }))
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
      isTrauma: type === "trauma",
      isDisease: type === "disease",
      traumaHealingSkillLabel: getHealingSkillLabel(item),
      healingSkillLabel: getHealingSkillLabel(item),
      isContainerFunction: hasContainerFunction,
      hasDamageMitigationFunction,
      hasConditionFunction,
      hasWeaponFunction,
      hasWeaponMagazineCost: hasWeaponResourceCost(item, "magazine"),
      toolFunctions,
      weaponDamageTypeChoices: buildWeaponDamageTypeChoices(item, damageTypeSettings),
      weaponSkillChoices: buildWeaponSkillChoices(item, skillSettings),
      weaponResourceCosts: buildWeaponResourceCostRows(item, hasConditionFunction),
      weaponActionChoices: buildWeaponActionChoices(item),
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
    this.element?.querySelectorAll("[data-weapon-action-choice]").forEach(button => {
      button.addEventListener("click", event => this.#onWeaponActionChoice(event));
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
    this.element?.querySelector("[data-add-weapon-resource-cost]")?.addEventListener("click", event => this.#onAddWeaponResourceCost(event));
    this.element?.querySelectorAll("[data-delete-weapon-resource-cost]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteWeaponResourceCost(event));
    });
    this.element?.querySelectorAll("[data-mitigation-fill-handle]").forEach(handle => {
      handle.addEventListener("pointerdown", event => this.#onMitigationFillStart(event));
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

  #onWeaponActionChoice(event) {
    event.preventDefault();
    const key = event.currentTarget.dataset.weaponActionChoice;
    if (!key) return;

    const input = this.element.querySelector(`[data-weapon-action-input="${key}"]`);
    if (!input) return;

    input.checked = !input.checked;
    event.currentTarget.classList.toggle("active", input.checked);
    event.currentTarget.setAttribute("aria-pressed", String(input.checked));
    return this.item.update({ [`system.functions.weapon.availableActions.${key}`]: input.checked });
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

    if (functionKey === ITEM_FUNCTIONS.condition) {
      this.#functionPickerActive = false;
      return this.item.update({
        "system.functions.condition.enabled": true,
        "system.functions.condition.value": 0,
        "system.functions.condition.max": 0
      });
    }

    if (functionKey === ITEM_FUNCTIONS.weapon) {
      this.#functionPickerActive = false;
      return this.item.update({
        "system.functions.weapon.enabled": true,
        "system.functions.weapon.damage": 0,
        "system.functions.weapon.pellets": 1,
        "system.functions.weapon.damageTypeKey": "firearm",
        "system.functions.weapon.attackAnimationKey": "",
        "system.functions.weapon.attackAnimationDelayMs": 0,
        "system.functions.weapon.skillKey": "rangedCombat",
        "system.functions.weapon.accuracyBonus": 0,
        "system.functions.weapon.attackConeDegrees": 0,
        "system.functions.weapon.maxRangeMeters": 0,
        "system.functions.weapon.effectiveRange.value": 0,
        "system.functions.weapon.effectiveRange.max": 0,
        "system.functions.weapon.penetration": 0,
        "system.functions.weapon.magazine.value": 0,
        "system.functions.weapon.magazine.max": 0,
        "system.functions.weapon.resourceCosts": [],
        "system.functions.weapon.availableActions": {
          aimedShot: false,
          snapshot: false,
          burst: false
        },
        "system.functions.weapon.aimedShot.attackConeDegrees": 0,
        "system.functions.weapon.snapshot.attackConeDegrees": 0,
        "system.functions.weapon.burst.attackConeDegrees": 0,
        "system.functions.weapon.burst.count": 3
      });
    }

    const toolKey = getToolKeyFromFunctionKey(functionKey);
    if (toolKey) {
      this.#functionPickerActive = false;
      return this.item.update({
        [`system.functions.tools.${toolKey}.enabled`]: true,
        [`system.functions.tools.${toolKey}.toolClass`]: "D",
        [`system.functions.tools.${toolKey}.supply.value`]: 0,
        [`system.functions.tools.${toolKey}.supply.max`]: 0,
        [`system.functions.tools.${toolKey}.skillValue`]: 0,
        [`system.functions.tools.${toolKey}.skillKey`]: ""
      });
    }

    return undefined;
  }

  async #onRemoveItemFunction(event) {
    event.preventDefault();
    const functionKey = String(event.currentTarget?.dataset?.removeItemFunction ?? "");
    const functionLabel = getItemFunctionLabel(functionKey);
    const confirmed = await DialogV2.confirm({
      window: {
        title: game.i18n.localize("FALLOUTMAW.Item.DeleteFunction")
      },
      content: `<p>${game.i18n.format("FALLOUTMAW.Item.DeleteFunctionConfirm", { function: functionLabel })}</p>`,
      yes: {
        icon: "fa-solid fa-trash",
        label: game.i18n.localize("FALLOUTMAW.Common.Delete")
      },
      no: {
        label: game.i18n.localize("Cancel")
      },
      rejectClose: false,
      modal: true
    });
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
    if (functionKey === ITEM_FUNCTIONS.condition) {
      return this.item.update({
        "system.functions.condition.enabled": false,
        "system.functions.condition.value": 0,
        "system.functions.condition.max": 0,
        "system.functions.weapon.resourceCosts": (this.item.system?.functions?.weapon?.resourceCosts ?? [])
          .filter(cost => cost.type !== "condition")
      });
    }
    if (functionKey === ITEM_FUNCTIONS.weapon) {
      return this.item.update({
        "system.functions.weapon.enabled": false,
        "system.functions.weapon.resourceCosts": []
      });
    }
    const toolKey = getToolKeyFromFunctionKey(functionKey);
    if (toolKey) {
      return this.item.update({ [`system.functions.tools.${toolKey}.enabled`]: false });
    }
    return undefined;
  }

  #onAddWeaponResourceCost(event) {
    event.preventDefault();
    const costs = [...(this.item.system?.functions?.weapon?.resourceCosts ?? [])];
    costs.push({ type: "magazine", amount: 0 });
    return this.item.update({ "system.functions.weapon.resourceCosts": costs });
  }

  #onDeleteWeaponResourceCost(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.dataset?.deleteWeaponResourceCost);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const costs = [...(this.item.system?.functions?.weapon?.resourceCosts ?? [])];
    costs.splice(index, 1);
    return this.item.update({ "system.functions.weapon.resourceCosts": costs });
  }

  #onMitigationFillStart(event) {
    if (event.button !== 0) return;

    const handle = event.currentTarget;
    const input = handle.closest(".fallout-maw-mitigation-cell")?.querySelector("input");
    if (!input) return;

    event.preventDefault();
    event.stopPropagation();
    this.#endMitigationFillDrag(false);

    const originCell = input.closest("[data-mitigation-cell]");
    const cells = this.#getMitigationFillCells();
    if (!originCell || !cells.length) return;

    this.#mitigationFillDrag = {
      pointerId: event.pointerId,
      value: input.value,
      origin: {
        row: Number(originCell.dataset.mitigationRow) || 0,
        column: Number(originCell.dataset.mitigationColumn) || 0
      },
      cells,
      activeInputs: new Set()
    };
    handle.setPointerCapture?.(event.pointerId);
    this.#updateMitigationFillRectangle(originCell);
    document.addEventListener("pointermove", this.#onMitigationFillMove);
    document.addEventListener("pointerup", this.#onMitigationFillEnd);
    document.addEventListener("pointercancel", this.#onMitigationFillCancel);
  }

  #onMitigationFillMove = event => {
    const drag = this.#mitigationFillDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;

    const element = document.elementFromPoint(event.clientX, event.clientY);
    const cell = element?.closest?.("[data-mitigation-cell]");
    if (!cell || !this.element?.contains(cell)) return;

    this.#updateMitigationFillRectangle(cell);
  };

  #onMitigationFillEnd = event => {
    const drag = this.#mitigationFillDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.#endMitigationFillDrag(true);
  };

  #onMitigationFillCancel = event => {
    const drag = this.#mitigationFillDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.#endMitigationFillDrag(false);
  };

  #getMitigationFillCells() {
    return Array.from(this.element?.querySelectorAll("[data-mitigation-cell]") ?? [])
      .map(cell => {
        const input = cell.querySelector("input");
        if (!input) return null;
        return {
          cell,
          input,
          row: Number(cell.dataset.mitigationRow) || 0,
          column: Number(cell.dataset.mitigationColumn) || 0,
          originalValue: input.value
        };
      })
      .filter(Boolean);
  }

  #updateMitigationFillRectangle(targetCell) {
    const drag = this.#mitigationFillDrag;
    if (!drag) return;

    const target = {
      row: Number(targetCell.dataset.mitigationRow) || 0,
      column: Number(targetCell.dataset.mitigationColumn) || 0
    };
    const minRow = Math.min(drag.origin.row, target.row);
    const maxRow = Math.max(drag.origin.row, target.row);
    const minColumn = Math.min(drag.origin.column, target.column);
    const maxColumn = Math.max(drag.origin.column, target.column);
    const nextActiveInputs = new Set();

    for (const entry of drag.cells) {
      const inRectangle = entry.row >= minRow
        && entry.row <= maxRow
        && entry.column >= minColumn
        && entry.column <= maxColumn;

      if (inRectangle) {
        entry.input.value = drag.value;
        entry.cell.classList.add("fill-target");
        nextActiveInputs.add(entry.input);
      } else {
        entry.input.value = entry.originalValue;
        entry.cell.classList.remove("fill-target");
      }
    }

    drag.activeInputs = nextActiveInputs;
  }

  #endMitigationFillDrag(save) {
    const drag = this.#mitigationFillDrag;
    if (!drag) return;

    document.removeEventListener("pointermove", this.#onMitigationFillMove);
    document.removeEventListener("pointerup", this.#onMitigationFillEnd);
    document.removeEventListener("pointercancel", this.#onMitigationFillCancel);
    this.#mitigationFillDrag = null;

    const inputs = Array.from(drag.activeInputs);
    window.setTimeout(() => {
      for (const input of inputs) input.closest(".fallout-maw-mitigation-cell")?.classList.remove("fill-target");
    }, 180);

    if (!save) {
      for (const entry of drag.cells) entry.input.value = entry.originalValue;
      return;
    }

    if (!inputs.length) return;
    const updateData = {};
    for (const input of inputs) updateData[input.name] = Number(input.value) || 0;
    return this.item.update(updateData);
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

function getHealingSkillLabel(item) {
  if (!["trauma", "disease"].includes(item?.type)) return "";
  const key = item.system?.healingSkillKey ?? "";
  return getSkillSettings().find(skill => skill.key === key)?.label ?? key;
}

function getItemFunctionLabel(functionKey = "") {
  if (functionKey === ITEM_FUNCTIONS.container) return game.i18n.localize("FALLOUTMAW.Item.FunctionContainer");
  if (functionKey === ITEM_FUNCTIONS.damageMitigation) return game.i18n.localize("FALLOUTMAW.Item.FunctionDamageMitigation");
  if (functionKey === ITEM_FUNCTIONS.condition) return game.i18n.localize("FALLOUTMAW.Item.FunctionCondition");
  if (functionKey === ITEM_FUNCTIONS.weapon) return game.i18n.localize("FALLOUTMAW.Item.FunctionWeapon");
  const toolKey = getToolKeyFromFunctionKey(functionKey);
  if (toolKey) return getToolSettings().find(tool => tool.key === toolKey)?.label ?? toolKey;
  return game.i18n.localize("FALLOUTMAW.Item.Function");
}

function buildWeaponResourceCostRows(item, hasConditionFunction) {
  return (item.system?.functions?.weapon?.resourceCosts ?? []).map((cost, index) => ({
    index,
    amount: Number(cost.amount) || 0,
    typeChoices: buildWeaponResourceTypeChoices(cost.type, hasConditionFunction)
  }));
}

function buildWeaponDamageTypeChoices(item, damageTypeSettings) {
  const selected = String(item.system?.functions?.weapon?.damageTypeKey ?? "");
  return damageTypeSettings.map(damageType => ({
    value: damageType.key,
    label: damageType.label,
    selected: damageType.key === selected
  }));
}

function buildWeaponSkillChoices(item, skillSettings) {
  const selected = String(item.system?.functions?.weapon?.skillKey ?? "");
  return skillSettings.map(skill => ({
    value: skill.key,
    label: skill.label,
    selected: skill.key === selected
  }));
}

function hasWeaponResourceCost(item, type) {
  return (item.system?.functions?.weapon?.resourceCosts ?? []).some(cost => cost.type === type);
}

function buildWeaponResourceTypeChoices(selected, hasConditionFunction) {
  const choices = [
    { value: "magazine", label: game.i18n.localize("FALLOUTMAW.Item.WeaponCostMagazine") }
  ];
  if (hasConditionFunction) {
    choices.push({ value: "condition", label: game.i18n.localize("FALLOUTMAW.Item.WeaponCostCondition") });
  }
  return choices.map(choice => ({
    ...choice,
    selected: choice.value === selected
  }));
}

function buildWeaponActionChoices(item) {
  const actions = item.system?.functions?.weapon?.availableActions ?? {};
  const weaponData = item.system?.functions?.weapon ?? {};
  const sourceWeaponData = item.system?._source?.functions?.weapon ?? {};
  const fallbackCone = Number(weaponData.attackConeDegrees) || 0;
  return [
    { key: "aimedShot", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionAimedShot") },
    { key: "snapshot", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionSnapshot") },
    { key: "burst", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionBurst") }
  ].map(action => {
    const actionData = weaponData?.[action.key] ?? {};
    const sourceActionData = sourceWeaponData?.[action.key] ?? {};
    const hasActionCone = Object.hasOwn(sourceActionData, "attackConeDegrees");
    return {
      ...action,
      selected: Boolean(actions[action.key]),
      isBurst: action.key === "burst",
      attackConeDegrees: Number(hasActionCone ? actionData.attackConeDegrees : fallbackCone) || 0,
      burstCount: Math.max(1, Number(weaponData?.burst?.count) || 3)
    };
  });
}

function buildToolFunctionEntries(item, toolSettings, skillSettings) {
  const skillChoices = [
    { value: "", label: "Не используется" },
    ...skillSettings.map(skill => ({ value: skill.key, label: skill.label }))
  ];
  const classChoices = ["D", "C", "B", "A", "S"];
  const functions = item.system?.functions?.tools ?? {};

  return toolSettings.map(tool => {
    const data = functions?.[tool.key] ?? {};
    const skillKey = String(data.skillKey ?? "");
    const toolClass = String(data.toolClass ?? "D");
    return {
      ...tool,
      functionKey: createToolFunctionKey(tool.key),
      enabled: Boolean(data.enabled),
      toolClass,
      classChoices: classChoices.map(value => ({
        value,
        label: value,
        selected: value === toolClass
      })),
      skillChoices: skillChoices.map(choice => ({
        ...choice,
        selected: choice.value === skillKey
      })),
      supplyValue: Number(data.supply?.value) || 0,
      supplyMax: Number(data.supply?.max) || 0,
      skillValue: Number(data.skillValue) || 0,
      skillKey
    };
  });
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
    rows: damageTypeSettings.map((damageType, rowIndex) => ({
      damageTypeKey: damageType.key,
      damageTypeLabel: damageType.label,
      cells: limbs.map((limb, columnIndex) => ({
        limbKey: limb.key,
        damageTypeKey: damageType.key,
        rowIndex,
        columnIndex,
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
