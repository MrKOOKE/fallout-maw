import { TEMPLATES } from "../constants.mjs";
import { getCharacteristicSettings, getCreatureOptions, getCurrencySettings, getDamageTypeSettings, getSkillSettings, getToolSettings } from "../settings/accessors.mjs";
import { groupRaceEquipmentSlotsBySet, groupRaceWeaponSlotsBySet } from "../utils/equipment-slots.mjs";
import {
  ITEM_FUNCTIONS,
  createToolFunctionKey,
  getDamageSourceFunction,
  getToolKeyFromFunctionKey,
  hasItemFunction
} from "../utils/item-functions.mjs";
import { FALLBACK_ICON, normalizeImagePath } from "../utils/actor-display-data.mjs";
import { toInteger } from "../utils/numbers.mjs";

const { ItemSheetV2 } = foundry.applications.sheets;
const { DialogV2, HandlebarsApplicationMixin } = foundry.applications.api;
const TextEditor = foundry.applications.ux.TextEditor.implementation;
const DEFAULT_WEAPON_ATTACK_CONE_DEGREES = 3;
const DEFAULT_WEAPON_ACTION_POINT_COST = 5;
const DEFAULT_RELOAD_ACTION_POINT_COST = 2;
const DEFAULT_CONDITION_WEAKENING_THRESHOLD = 20;
const DEFAULT_ITEM_SHEET_HEIGHT = 4000;
let itemSheetSourceSyncHooksRegistered = false;

export class FalloutMaWItemSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
  #functionPickerActive = false;
  #mitigationFillDrag = null;

  static DEFAULT_OPTIONS = {
    classes: ["fallout-maw", "fallout-maw-sheet", "fallout-maw-item-sheet", "sheet", "item"],
    position: {
      width: 930,
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
      template: TEMPLATES.itemSheet,
      scrollable: [".tab.active"]
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

  _initializeApplicationOptions(options) {
    options = super._initializeApplicationOptions(options);
    if (!["disease", "trauma"].includes(String(options.document?.type ?? "")) && options.position?.height === "auto") {
      options.position.height = DEFAULT_ITEM_SHEET_HEIGHT;
    }
    return options;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const item = this.item;
    const type = item.type;
    const priceCurrency = item.system?.priceCurrency ?? "";
    const occupiedSlots = item.system?.occupiedSlots ?? {};
    const weaponSlotRequirement = item.system?.weaponSlotRequirement ?? {};
    const occupiedWeaponSlots = weaponSlotRequirement.slots ?? {};
    const creatureOptions = getCreatureOptions();
    const characteristicSettings = getCharacteristicSettings();
    const damageTypeSettings = getDamageTypeSettings();
    const toolSettings = getToolSettings();
    const skillSettings = getSkillSettings();
    const equipmentSlotGroups = groupRaceEquipmentSlotsBySet(creatureOptions);
    const weaponSlotGroups = groupRaceWeaponSlotsBySet(creatureOptions);
    const equipmentSlotSelections = new Map();
    const weaponSlotSelections = new Map();
    const hasContainerFunction = hasItemFunction(item, ITEM_FUNCTIONS.container);
    const hasDamageMitigationFunction = hasItemFunction(item, ITEM_FUNCTIONS.damageMitigation);
    const hasDamageSourceFunction = hasItemFunction(item, ITEM_FUNCTIONS.damageSource);
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
        value: ITEM_FUNCTIONS.damageSource,
        label: game.i18n.localize("FALLOUTMAW.Item.FunctionDamageSource"),
        disabled: hasDamageSourceFunction
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

    for (const group of weaponSlotGroups) {
      for (const slot of group.slots) {
        if (!weaponSlotSelections.has(slot.selectionKey)) {
          weaponSlotSelections.set(slot.selectionKey, {
            selectionKey: slot.selectionKey,
            label: slot.label,
            selected: Boolean(occupiedWeaponSlots[slot.selectionKey])
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
      hasDamageSourceFunction,
      damageSourceDamageTypeRows: buildDamageSourceDamageTypeRows(item, damageTypeSettings),
      hasConditionFunction,
      conditionRecoveryMethodRows: buildConditionRecoveryMethodRows(item, toolSettings),
      hasWeaponFunction,
      hasWeaponMagazineCost: hasWeaponResourceCost(item, "magazine"),
      toolFunctions,
      weaponFunctionSections: buildWeaponFunctionSections(item, damageTypeSettings, skillSettings, characteristicSettings, hasConditionFunction),
      weaponDamageTypeChoices: buildWeaponDamageTypeChoices(item, damageTypeSettings),
      weaponDamageTypeRows: buildWeaponDamageTypeRows(item, damageTypeSettings),
      weaponSkillChoices: buildWeaponSkillChoices(item, skillSettings),
      weaponResourceCosts: buildWeaponResourceCostRows(item, hasConditionFunction),
      weaponActionChoices: buildWeaponActionChoices(item, damageTypeSettings),
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
      weaponSlotRequirementModeChoices: buildWeaponSlotRequirementModeChoices(weaponSlotRequirement.mode),
      weaponSlotSelections: Array.from(weaponSlotSelections.values()),
      weaponSlotGroups: weaponSlotGroups.map(group => ({
        raceNames: group.races.join(", "),
        slots: group.slots.map(slot => ({
          ...slot,
          selected: Boolean(occupiedWeaponSlots[slot.selectionKey])
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
    this.element?.querySelectorAll("[data-weapon-slot-choice]").forEach(button => {
      button.addEventListener("click", event => this.#onWeaponSlotChoice(event));
    });
    this.element?.querySelectorAll("[data-weapon-action-choice]").forEach(button => {
      button.addEventListener("click", event => this.#onWeaponActionChoice(event));
    });
    this.element?.querySelectorAll("[data-add-weapon-damage-type]").forEach(button => {
      button.addEventListener("click", event => this.#onAddWeaponDamageType(event));
    });
    this.element?.querySelectorAll("[data-delete-weapon-damage-type]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteWeaponDamageType(event));
    });
    this.element?.querySelectorAll("[data-weapon-damage-percent]").forEach(input => {
      input.addEventListener("input", event => this.#onWeaponDamagePercentInput(event));
      input.addEventListener("change", event => this.#onWeaponDamagePercentChange(event));
    });
    this.element?.querySelectorAll("[data-add-damage-source-damage-type]").forEach(button => {
      button.addEventListener("click", event => this.#onAddDamageSourceDamageType(event));
    });
    this.element?.querySelectorAll("[data-delete-damage-source-damage-type]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteDamageSourceDamageType(event));
    });
    this.element?.querySelectorAll("[data-damage-source-percent]").forEach(input => {
      input.addEventListener("input", event => this.#onDamageSourcePercentInput(event));
      input.addEventListener("change", event => this.#onDamageSourcePercentChange(event));
    });
    this.element?.querySelectorAll("[data-weapon-damage-mode]").forEach(select => {
      select.addEventListener("change", event => this.#onWeaponDamageModeChange(event));
    });
    this.element?.querySelectorAll("[data-weapon-magazine-source-drop]").forEach(zone => {
      zone.addEventListener("dragover", event => this.#onWeaponMagazineSourceDragOver(event));
      zone.addEventListener("drop", event => this.#onWeaponMagazineSourceDrop(event));
    });
    this.element?.querySelectorAll("[data-select-weapon-magazine-source]").forEach(source => {
      source.addEventListener("click", event => this.#onSelectWeaponMagazineSource(event));
    });
    this.element?.querySelectorAll("[data-delete-weapon-magazine-source]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteWeaponMagazineSource(event));
    });
    this.element?.querySelectorAll("[data-add-volley-region-damage]").forEach(button => {
      button.addEventListener("click", event => this.#onAddVolleyRegionDamage(event));
    });
    this.element?.querySelectorAll("[data-delete-volley-region-damage]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteVolleyRegionDamage(event));
    });
    this.element?.querySelectorAll("[data-weapon-attack-mode-enabled]").forEach(input => {
      input.addEventListener("change", event => this.#onWeaponAttackModeEnabledChange(event));
    });
    this.element?.querySelectorAll("[data-browse-weapon-attack-sound]").forEach(button => {
      button.addEventListener("click", event => this.#onBrowseWeaponAttackSound(event));
    });
    this.element?.querySelectorAll("[data-browse-weapon-explosion-sound]").forEach(button => {
      button.addEventListener("click", event => this.#onBrowseWeaponExplosionSound(event));
    });
    this.element?.querySelector("[data-add-item-function]")?.addEventListener("click", event => this.#onAddItemFunction(event));
    this.element?.querySelector("[data-add-additional-weapon-function]")?.addEventListener("click", event => this.#onAddAdditionalWeaponFunction(event));
    this.element?.querySelectorAll("[data-delete-additional-weapon-function]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteAdditionalWeaponFunction(event));
    });
    this.element?.querySelector("[data-choose-item-function]")?.addEventListener("change", event => this.#onChooseItemFunction(event));
    this.element?.querySelectorAll("[data-container-load-reduction]").forEach(input => {
      input.addEventListener("input", event => this.#onContainerLoadReductionInput(event));
      input.addEventListener("change", event => this.#onContainerLoadReductionChange(event));
    });
    this.element?.querySelectorAll("[data-remove-item-function]").forEach(button => {
      button.addEventListener("click", event => this.#onRemoveItemFunction(event));
    });
    this.element?.querySelectorAll("[data-add-weapon-resource-cost]").forEach(button => {
      button.addEventListener("click", event => this.#onAddWeaponResourceCost(event));
    });
    this.element?.querySelectorAll("[data-delete-weapon-resource-cost]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteWeaponResourceCost(event));
    });
    this.element?.querySelector("[data-add-condition-recovery-method]")?.addEventListener("click", event => this.#onAddConditionRecoveryMethod(event));
    this.element?.querySelectorAll("[data-delete-condition-recovery-method]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteConditionRecoveryMethod(event));
    });
    this.element?.querySelectorAll("[data-add-weapon-special-property]").forEach(button => {
      button.addEventListener("click", event => this.#onAddWeaponSpecialProperty(event));
    });
    this.element?.querySelectorAll("[data-delete-weapon-special-property]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteWeaponSpecialProperty(event));
    });
    this.element?.querySelectorAll("[data-add-weapon-requirement]").forEach(button => {
      button.addEventListener("click", event => this.#onAddWeaponRequirement(event));
    });
    this.element?.querySelectorAll("[data-delete-weapon-requirement]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteWeaponRequirement(event));
    });
    this.element?.querySelectorAll("[data-weapon-requirement-type]").forEach(select => {
      select.addEventListener("change", event => this.#onWeaponRequirementTypeChange(event));
    });
    this.element?.querySelectorAll("[data-add-weapon-critical-failure-consequence]").forEach(button => {
      button.addEventListener("click", event => this.#onAddWeaponCriticalFailureConsequence(event));
    });
    this.element?.querySelectorAll("[data-delete-weapon-critical-failure-consequence]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteWeaponCriticalFailureConsequence(event));
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

  #onWeaponSlotChoice(event) {
    event.preventDefault();
    const key = event.currentTarget.dataset.weaponSlotChoice;
    if (!key) return;

    const input = this.element.querySelector(`[data-weapon-slot-input="${key}"]`);
    if (!input) return;

    input.checked = !input.checked;
    this.element.querySelectorAll(`[data-weapon-slot-choice="${key}"]`).forEach(button => {
      button.classList.toggle("active", input.checked);
      button.setAttribute("aria-pressed", String(input.checked));
    });
    return this.item.update({ [`system.weaponSlotRequirement.slots.${key}`]: input.checked });
  }

  #onWeaponActionChoice(event) {
    event.preventDefault();
    const key = event.currentTarget.dataset.weaponActionChoice;
    if (!key) return;

    const section = getWeaponFunctionSection(event.currentTarget);
    const path = getWeaponFunctionPath(section);
    const input = section?.querySelector(`[data-weapon-action-input="${key}"]`);
    if (!input) return;

    input.checked = !input.checked;
    event.currentTarget.classList.toggle("active", input.checked);
    event.currentTarget.setAttribute("aria-pressed", String(input.checked));
    return this.item.update({ [`${path}.availableActions.${key}`]: input.checked });
  }

  #onWeaponAttackModeEnabledChange(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    const input = event.currentTarget;
    const section = input.closest("[data-weapon-function-section]");
    const action = input.closest("[data-weapon-action-settings]");
    const path = getWeaponFunctionPath(section);
    const actionKey = String(action?.dataset.weaponActionSettings ?? "");
    const mode = String(input.dataset.weaponAttackModeEnabled ?? "");
    if (!path || !actionKey || !mode) return undefined;

    const modeInputs = Array.from(action.querySelectorAll("[data-weapon-attack-mode-enabled]"));
    const enabledInputs = modeInputs.filter(entry => entry.checked);
    if (!enabledInputs.length) {
      input.checked = true;
      return undefined;
    }

    return this.item.update({ [`${path}.${actionKey}.${mode}.enabled`]: input.checked });
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
        "system.functions.container.extraWeaponSlots": Math.max(0, toInteger(this.item.system?.functions?.container?.extraWeaponSlots)),
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

    if (functionKey === ITEM_FUNCTIONS.damageSource) {
      this.#functionPickerActive = false;
      return this.item.update({
        "system.functions.damageSource": createDefaultDamageSourceFunctionData({ enabled: true })
      });
    }

    if (functionKey === ITEM_FUNCTIONS.condition) {
      this.#functionPickerActive = false;
      return this.item.update({
        "system.functions.condition.enabled": true,
        "system.functions.condition.value": 0,
        "system.functions.condition.max": 0,
        "system.functions.condition.weakeningThreshold": DEFAULT_CONDITION_WEAKENING_THRESHOLD,
        "system.functions.condition.recoveryMethods": []
      });
    }

    if (functionKey === ITEM_FUNCTIONS.weapon) {
      this.#functionPickerActive = false;
      return this.item.update({
        "system.functions.weapon": createDefaultWeaponFunctionData({ enabled: true })
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
        "system.functions.container.loadReduction": 0,
        "system.functions.container.extraWeaponSlots": 0
      });
    }
    if (functionKey === ITEM_FUNCTIONS.damageMitigation) {
      return this.item.update({ "system.functions.damageMitigation.enabled": false });
    }
    if (functionKey === ITEM_FUNCTIONS.damageSource) {
      return this.item.update({
        "system.functions.damageSource": createDefaultDamageSourceFunctionData({ enabled: false })
      });
    }
    if (functionKey === ITEM_FUNCTIONS.condition) {
      const additionalWeapons = Object.fromEntries(getAdditionalWeaponFunctionEntries(this.item)
        .map(({ id, data }) => [
          id,
          {
            ...foundry.utils.deepClone(data),
            resourceCosts: (data?.resourceCosts ?? []).filter(cost => cost.type !== "condition")
          }
        ]));
      return this.item.update({
        "system.functions.condition.enabled": false,
        "system.functions.condition.value": 0,
        "system.functions.condition.max": 0,
        "system.functions.weapon.resourceCosts": (this.item.system?.functions?.weapon?.resourceCosts ?? [])
          .filter(cost => cost.type !== "condition"),
        "system.functions.additionalWeapons": additionalWeapons
      });
    }
    if (functionKey === ITEM_FUNCTIONS.weapon) {
      return this.item.update({
        "system.functions.weapon.enabled": false,
        "system.functions.weapon.resourceCosts": [],
        "system.functions.weapon.specialProperties": [],
        "system.functions.additionalWeapons": {}
      });
    }
    const toolKey = getToolKeyFromFunctionKey(functionKey);
    if (toolKey) {
      return this.item.update({ [`system.functions.tools.${toolKey}.enabled`]: false });
    }
    return undefined;
  }

  #onAddAdditionalWeaponFunction(event) {
    event.preventDefault();
    const additionalWeapons = Object.fromEntries(getAdditionalWeaponFunctionEntries(this.item)
      .map(({ id, data }) => [id, foundry.utils.deepClone(data)]));
    const baseWeapon = this.item.system?.functions?.weapon ?? {};
    const id = foundry.utils.randomID();
    additionalWeapons[id] = createDefaultWeaponFunctionData({
      ...foundry.utils.deepClone(baseWeapon),
      id,
      name: getNextAdditionalWeaponFunctionName(Object.values(additionalWeapons)),
      enabled: true
    });
    return this.item.update({ "system.functions.additionalWeapons": additionalWeapons });
  }

  #onDeleteAdditionalWeaponFunction(event) {
    event.preventDefault();
    event.stopPropagation();
    const id = String(event.currentTarget?.dataset?.deleteAdditionalWeaponFunction ?? "");
    if (!id) return undefined;
    return this.item.update({ [`system.functions.additionalWeapons.${id}`]: globalThis._del });
  }

  #onAddWeaponResourceCost(event) {
    event.preventDefault();
    const path = getWeaponFunctionPath(getWeaponFunctionSection(event.currentTarget));
    const weaponData = foundry.utils.getProperty(this.item, path) ?? {};
    const costs = [...(weaponData?.resourceCosts ?? [])];
    const type = getDefaultNewWeaponResourceCostType(weaponData, hasItemFunction(this.item, ITEM_FUNCTIONS.condition));
    costs.push({ type, amount: 0 });
    return this.item.update({ [`${path}.resourceCosts`]: costs });
  }

  #onDeleteWeaponResourceCost(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.dataset?.deleteWeaponResourceCost);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const path = getWeaponFunctionPath(getWeaponFunctionSection(event.currentTarget));
    const costs = [...(foundry.utils.getProperty(this.item, path)?.resourceCosts ?? [])];
    const weaponData = foundry.utils.getProperty(this.item, path) ?? {};
    if (isLockedWeaponMagazineResourceCost(weaponData, costs, index)) return undefined;
    costs.splice(index, 1);
    return this.item.update({ [`${path}.resourceCosts`]: costs });
  }

  #onAddConditionRecoveryMethod(event) {
    event.preventDefault();
    const methods = [...(this.item.system?.functions?.condition?.recoveryMethods ?? [])];
    const firstTool = getToolSettings().at(0)?.key ?? "";
    methods.push({
      type: "tools",
      toolKey: firstTool,
      toolClass: "D",
      difficulty: 0
    });
    return this.item.update({ "system.functions.condition.recoveryMethods": methods });
  }

  #onDeleteConditionRecoveryMethod(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.dataset?.deleteConditionRecoveryMethod);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const methods = [...(this.item.system?.functions?.condition?.recoveryMethods ?? [])];
    methods.splice(index, 1);
    return this.item.update({ "system.functions.condition.recoveryMethods": methods });
  }

  #onAddWeaponSpecialProperty(event) {
    event.preventDefault();
    const path = getWeaponFunctionPath(getWeaponFunctionSection(event.currentTarget));
    const properties = [...(foundry.utils.getProperty(this.item, path)?.specialProperties ?? [])];
    properties.push("hitAllConeTargets");
    return this.item.update({ [`${path}.specialProperties`]: properties });
  }

  #onDeleteWeaponSpecialProperty(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.dataset?.deleteWeaponSpecialProperty);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const path = getWeaponFunctionPath(getWeaponFunctionSection(event.currentTarget));
    const properties = [...(foundry.utils.getProperty(this.item, path)?.specialProperties ?? [])];
    properties.splice(index, 1);
    return this.item.update({ [`${path}.specialProperties`]: properties });
  }

  #onAddWeaponRequirement(event) {
    event.preventDefault();
    const path = getWeaponFunctionPath(getWeaponFunctionSection(event.currentTarget));
    const requirements = [...(foundry.utils.getProperty(this.item, path)?.requirements ?? [])];
    requirements.push({
      type: "characteristic",
      key: getCharacteristicSettings().at(0)?.key ?? "",
      value: 0
    });
    return this.item.update({ [`${path}.requirements`]: requirements });
  }

  #onDeleteWeaponRequirement(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.dataset?.deleteWeaponRequirement);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const path = getWeaponFunctionPath(getWeaponFunctionSection(event.currentTarget));
    const requirements = [...(foundry.utils.getProperty(this.item, path)?.requirements ?? [])];
    requirements.splice(index, 1);
    return this.item.update({ [`${path}.requirements`]: requirements });
  }

  #onWeaponRequirementTypeChange(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    const index = Number(event.currentTarget?.dataset?.weaponRequirementType);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const type = String(event.currentTarget?.value ?? "") === "skill" ? "skill" : "characteristic";
    const path = getWeaponFunctionPath(getWeaponFunctionSection(event.currentTarget));
    const key = type === "skill"
      ? getSkillSettings().at(0)?.key ?? ""
      : getCharacteristicSettings().at(0)?.key ?? "";
    return this.item.update({
      [`${path}.requirements.${index}.type`]: type,
      [`${path}.requirements.${index}.key`]: key
    });
  }

  #onAddWeaponCriticalFailureConsequence(event) {
    event.preventDefault();
    const section = getWeaponFunctionSection(event.currentTarget);
    const path = getWeaponFunctionPath(section);
    const actionKey = String(event.currentTarget?.dataset?.addWeaponCriticalFailureConsequence ?? "");
    if (!actionKey) return undefined;
    const weaponData = foundry.utils.getProperty(this.item, path) ?? {};
    const actionData = weaponData?.[actionKey] ?? {};
    const consequences = [...(actionData.criticalFailureConsequences ?? [])];
    consequences.push({
      type: "extraResourceCost",
      resourceType: getAvailableWeaponResourceTypes(weaponData).at(0) ?? "",
      amount: 0
    });
    return this.item.update({ [`${path}.${actionKey}.criticalFailureConsequences`]: consequences });
  }

  #onDeleteWeaponCriticalFailureConsequence(event) {
    event.preventDefault();
    const section = getWeaponFunctionSection(event.currentTarget);
    const path = getWeaponFunctionPath(section);
    const actionKey = String(event.currentTarget?.dataset?.weaponActionKey ?? "");
    const index = Number(event.currentTarget?.dataset?.deleteWeaponCriticalFailureConsequence);
    if (!actionKey || !Number.isInteger(index) || index < 0) return undefined;
    const actionData = foundry.utils.getProperty(this.item, `${path}.${actionKey}`) ?? {};
    const consequences = [...(actionData.criticalFailureConsequences ?? [])];
    consequences.splice(index, 1);
    return this.item.update({ [`${path}.${actionKey}.criticalFailureConsequences`]: consequences });
  }

  #onAddWeaponDamageType(event) {
    event.preventDefault();
    const section = getWeaponFunctionSection(event.currentTarget);
    const path = getWeaponFunctionPath(section);
    const entries = readWeaponDamageTypeRows(section);
    const damageTypes = getDamageTypeSettings();
    const existingKeys = new Set(entries.map(entry => entry.key));
    const key = damageTypes.find(type => !existingKeys.has(type.key))?.key
      ?? damageTypes.at(0)?.key
      ?? "firearm";
    const used = entries.reduce((total, entry) => total + clampPercent(entry.percent), 0);
    entries.push({ key, percent: Math.max(0, 100 - used) });
    return this.item.update({ [`${path}.damageTypes`]: entries });
  }

  #onDeleteWeaponDamageType(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.dataset?.deleteWeaponDamageType);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const section = getWeaponFunctionSection(event.currentTarget);
    const path = getWeaponFunctionPath(section);
    const entries = readWeaponDamageTypeRows(section);
    entries.splice(index, 1);
    if (!entries.length) entries.push({ key: "firearm", percent: 100 });
    return this.item.update({ [`${path}.damageTypes`]: entries });
  }

  #onWeaponDamagePercentInput(event) {
    const input = event.currentTarget;
    const section = getWeaponFunctionSection(input);
    const row = input.closest("[data-weapon-damage-type-row]");
    if (!row) return;
    const index = Number(row.dataset.weaponDamageTypeRow);
    if (!Number.isInteger(index)) return;
    row.querySelectorAll("[data-weapon-damage-percent]").forEach(percentInput => {
      if (percentInput !== input) percentInput.value = input.value;
    });
    const entries = normalizeWeaponDamageTypeOverflow(readWeaponDamageTypeRows(section), index);
    writeWeaponDamageTypePercents(section, entries);
  }

  #onWeaponDamagePercentChange(event) {
    event.preventDefault();
    const section = getWeaponFunctionSection(event.currentTarget);
    const path = getWeaponFunctionPath(section);
    const row = event.currentTarget.closest("[data-weapon-damage-type-row]");
    const index = Number(row?.dataset?.weaponDamageTypeRow);
    const entries = normalizeWeaponDamageTypeOverflow(readWeaponDamageTypeRows(section), Number.isInteger(index) ? index : -1);
    writeWeaponDamageTypePercents(section, entries);
    return this.item.update({ [`${path}.damageTypes`]: entries });
  }

  #onAddDamageSourceDamageType(event) {
    event.preventDefault();
    const entries = readDamageSourceDamageTypeRows(this.element);
    const damageTypes = getDamageTypeSettings();
    const existingKeys = new Set(entries.map(entry => entry.key));
    const key = damageTypes.find(type => !existingKeys.has(type.key))?.key
      ?? damageTypes.at(0)?.key
      ?? "firearm";
    const used = entries.reduce((total, entry) => total + clampPercent(entry.percent), 0);
    entries.push({ key, percent: Math.max(0, 100 - used) });
    return this.item.update({ "system.functions.damageSource.damageTypes": entries });
  }

  #onDeleteDamageSourceDamageType(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.dataset?.deleteDamageSourceDamageType);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const entries = readDamageSourceDamageTypeRows(this.element);
    entries.splice(index, 1);
    if (!entries.length) entries.push({ key: "firearm", percent: 100 });
    return this.item.update({ "system.functions.damageSource.damageTypes": entries });
  }

  #onDamageSourcePercentInput(event) {
    const input = event.currentTarget;
    const row = input.closest("[data-damage-source-type-row]");
    if (!row) return;
    const index = Number(row.dataset.damageSourceTypeRow);
    if (!Number.isInteger(index)) return;
    row.querySelectorAll("[data-damage-source-percent]").forEach(percentInput => {
      if (percentInput !== input) percentInput.value = input.value;
    });
    const entries = normalizeWeaponDamageTypeOverflow(readDamageSourceDamageTypeRows(this.element), index);
    writeDamageSourceTypePercents(this.element, entries);
  }

  #onDamageSourcePercentChange(event) {
    event.preventDefault();
    const row = event.currentTarget.closest("[data-damage-source-type-row]");
    const index = Number(row?.dataset?.damageSourceTypeRow);
    const entries = normalizeWeaponDamageTypeOverflow(readDamageSourceDamageTypeRows(this.element), Number.isInteger(index) ? index : -1);
    writeDamageSourceTypePercents(this.element, entries);
    return this.item.update({ "system.functions.damageSource.damageTypes": entries });
  }

  #onWeaponDamageModeChange(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    const section = getWeaponFunctionSection(event.currentTarget);
    const path = getWeaponFunctionPath(section);
    const mode = String(event.currentTarget?.value ?? "") === "source" ? "source" : "manual";
    const weaponData = foundry.utils.getProperty(this.item, path) ?? {};
    const updateData = { [`${path}.damageMode`]: mode };
    if (mode === "source") {
      Object.assign(updateData, buildWeaponMagazineSourceModeUpdates(path, weaponData));
    }
    return this.item.update(updateData);
  }

  #onWeaponMagazineSourceDragOver(event) {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "link";
  }

  async #onWeaponMagazineSourceDrop(event) {
    event.preventDefault();
    event.stopPropagation();
    const section = getWeaponFunctionSection(event.currentTarget);
    const path = getWeaponFunctionPath(section);
    if (!path) return undefined;
    const item = await getDroppedItem(event);
    if (!item) return undefined;
    if (!isWorldDamageSourceItem(item)) {
      ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Item.WeaponReloadSourceWorldOnly"));
      return undefined;
    }
    const weaponData = foundry.utils.getProperty(this.item, path) ?? {};
    const sources = getWeaponMagazineSourceUuids(weaponData);
    const index = Number(event.currentTarget?.dataset?.weaponMagazineSourceIndex);
    if (Number.isInteger(index) && index >= 0 && index < sources.length) sources[index] = item.uuid;
    else sources.push(item.uuid);
    const uniqueSources = uniqueStrings(sources);
    return this.item.update({
      [`${path}.magazine.sourceItemUuid`]: item.uuid,
      [`${path}.magazine.sourceItemUuids`]: uniqueSources
    });
  }

  #onSelectWeaponMagazineSource(event) {
    event.preventDefault();
    event.stopPropagation();
    const path = getWeaponFunctionPath(getWeaponFunctionSection(event.currentTarget));
    if (!path) return undefined;
    const uuid = String(event.currentTarget?.dataset?.selectWeaponMagazineSource ?? "").trim();
    if (!uuid) return undefined;
    return this.item.update({ [`${path}.magazine.sourceItemUuid`]: uuid });
  }

  #onDeleteWeaponMagazineSource(event) {
    event.preventDefault();
    event.stopPropagation();
    const path = getWeaponFunctionPath(getWeaponFunctionSection(event.currentTarget));
    if (!path) return undefined;
    const index = Number(event.currentTarget?.dataset?.deleteWeaponMagazineSource);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const weaponData = foundry.utils.getProperty(this.item, path) ?? {};
    const sources = getWeaponMagazineSourceUuids(weaponData);
    const removed = sources.splice(index, 1).at(0) ?? "";
    const active = String(weaponData?.magazine?.sourceItemUuid ?? "");
    return this.item.update({
      [`${path}.magazine.sourceItemUuid`]: active === removed ? (sources.at(0) ?? "") : active,
      [`${path}.magazine.sourceItemUuids`]: sources
    });
  }

  #onAddVolleyRegionDamage(event) {
    event.preventDefault();
    const section = getWeaponFunctionSection(event.currentTarget);
    const path = getWeaponFunctionPath(section);
    const entries = readVolleyRegionDamageRows(section);
    const damageTypes = getDamageTypeSettings();
    const existingKeys = new Set(entries.map(entry => entry.damageTypeKey));
    const damageTypeKey = damageTypes.find(type => !existingKeys.has(type.key))?.key
      ?? damageTypes.at(0)?.key
      ?? "firearm";
    entries.push({ damageTypeKey, amount: 0 });
    return this.item.update({ [`${path}.volley.regionDamageEntries`]: entries });
  }

  #onDeleteVolleyRegionDamage(event) {
    event.preventDefault();
    const section = getWeaponFunctionSection(event.currentTarget);
    const path = getWeaponFunctionPath(section);
    const index = Number(event.currentTarget?.dataset?.deleteVolleyRegionDamage);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const entries = readVolleyRegionDamageRows(section);
    entries.splice(index, 1);
    return this.item.update({ [`${path}.volley.regionDamageEntries`]: entries });
  }

  async #onBrowseWeaponAttackSound(event) {
    event.preventDefault();
    const section = getWeaponFunctionSection(event.currentTarget);
    const input = section?.querySelector("[data-weapon-attack-sound-input]");
    if (!input) return undefined;
    const picker = new foundry.applications.apps.FilePicker.implementation({
      type: "audio",
      current: input.value ?? "",
      callback: path => {
        input.value = path;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    await picker.browse(undefined, { render: false });
    return picker.render({ force: true });
  }

  async #onBrowseWeaponExplosionSound(event) {
    event.preventDefault();
    const section = getWeaponFunctionSection(event.currentTarget);
    const input = section?.querySelector("[data-weapon-explosion-sound-input]");
    if (!input) return undefined;
    const picker = new foundry.applications.apps.FilePicker.implementation({
      type: "audio",
      current: input.value ?? "",
      callback: path => {
        input.value = path;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    await picker.browse(undefined, { render: false });
    return picker.render({ force: true });
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

export function registerItemSheetSourceSyncHooks() {
  if (itemSheetSourceSyncHooksRegistered) return;
  itemSheetSourceSyncHooksRegistered = true;
  Hooks.on("updateItem", item => {
    if (!item || item.actor || !hasItemFunction(item, ITEM_FUNCTIONS.damageSource)) return;
    refreshWeaponSheetsForDamageSource(item.uuid);
  });
}

function getHealingSkillLabel(item) {
  if (!["trauma", "disease"].includes(item?.type)) return "";
  const key = item.system?.healingSkillKey ?? "";
  return getSkillSettings().find(skill => skill.key === key)?.label ?? key;
}

function getItemFunctionLabel(functionKey = "") {
  if (functionKey === ITEM_FUNCTIONS.container) return game.i18n.localize("FALLOUTMAW.Item.FunctionContainer");
  if (functionKey === ITEM_FUNCTIONS.damageMitigation) return game.i18n.localize("FALLOUTMAW.Item.FunctionDamageMitigation");
  if (functionKey === ITEM_FUNCTIONS.damageSource) return game.i18n.localize("FALLOUTMAW.Item.FunctionDamageSource");
  if (functionKey === ITEM_FUNCTIONS.condition) return game.i18n.localize("FALLOUTMAW.Item.FunctionCondition");
  if (functionKey === ITEM_FUNCTIONS.weapon) return game.i18n.localize("FALLOUTMAW.Item.FunctionWeapon");
  const toolKey = getToolKeyFromFunctionKey(functionKey);
  if (toolKey) return getToolSettings().find(tool => tool.key === toolKey)?.label ?? toolKey;
  return game.i18n.localize("FALLOUTMAW.Item.Function");
}

function buildWeaponFunctionSections(item, damageTypeSettings, skillSettings, characteristicSettings, hasConditionFunction) {
  if (!hasItemFunction(item, ITEM_FUNCTIONS.weapon)) return [];
  const primaryWeapon = item.system?.functions?.weapon ?? {};
  const sourcePrimaryWeapon = item.system?._source?.functions?.weapon ?? {};
  const additionalWeapons = getAdditionalWeaponFunctionEntries(item);
  const sourceAdditionalWeapons = getAdditionalWeaponFunctionEntries({ system: item.system?._source ?? {} });
  return [
    buildWeaponFunctionSection({
      title: game.i18n.localize("FALLOUTMAW.Item.FunctionWeapon"),
      path: "system.functions.weapon",
      weaponData: primaryWeapon,
      sourceWeaponData: sourcePrimaryWeapon,
      damageTypeSettings,
      skillSettings,
      characteristicSettings,
      hasConditionFunction,
      isPrimary: true,
      canAddAdditional: true
    }),
    ...additionalWeapons.map(({ id, data: weaponData }, index) => buildWeaponFunctionSection({
      title: String(weaponData?.name ?? "").trim() || getDefaultAdditionalWeaponFunctionName(index),
      path: `system.functions.additionalWeapons.${id}`,
      weaponData,
      sourceWeaponData: sourceAdditionalWeapons.find(entry => entry.id === id)?.data ?? {},
      damageTypeSettings,
      skillSettings,
      characteristicSettings,
      hasConditionFunction,
      isAdditional: true,
      id,
      index
    }))
  ];
}

function buildWeaponFunctionSection({
  title = "",
  path = "system.functions.weapon",
  weaponData = {},
  sourceWeaponData = {},
  damageTypeSettings = [],
  skillSettings = [],
  characteristicSettings = [],
  hasConditionFunction = false,
  isPrimary = false,
  canAddAdditional = false,
  isAdditional = false,
  id = "",
  index = -1
} = {}) {
  const effectiveWeaponData = getWeaponDisplayData(weaponData);
  return {
    title,
    path,
    weaponData: effectiveWeaponData,
    isPrimary,
    isAdditional,
    canAddAdditional,
    id,
    index,
    damageModeChoices: buildWeaponDamageModeChoices(weaponData?.damageMode),
    usesDamageSource: isSourceDamageMode(weaponData),
    hasMagazineCost: hasWeaponResourceCostData(weaponData, "magazine") || isSourceDamageMode(weaponData),
    magazineSourceItems: buildWeaponMagazineSourceItems(weaponData),
    hasVolleyAction: Boolean(weaponData?.availableActions?.volley),
    damageTypeRows: buildWeaponDamageTypeRowsForData(effectiveWeaponData, damageTypeSettings, sourceWeaponData),
    skillChoices: buildWeaponSkillChoicesForData(effectiveWeaponData, skillSettings),
    resourceCosts: buildWeaponResourceCostRowsForData(weaponData, hasConditionFunction),
    specialProperties: buildWeaponSpecialPropertyRowsForData(weaponData),
    requirements: buildWeaponRequirementRowsForData(weaponData, characteristicSettings, skillSettings),
    actionChoices: buildWeaponActionChoicesForData(weaponData, sourceWeaponData, damageTypeSettings)
  };
}

function buildWeaponResourceCostRows(item, hasConditionFunction) {
  return buildWeaponResourceCostRowsForData(item.system?.functions?.weapon ?? {}, hasConditionFunction);
}

function buildWeaponResourceCostRowsForData(weaponData, hasConditionFunction) {
  const costs = Array.isArray(weaponData?.resourceCosts)
    ? weaponData.resourceCosts
    : Object.values(weaponData?.resourceCosts ?? {});
  let lockedMagazineUsed = false;
  const rows = costs.map((cost, index) => {
    const type = String(cost?.type ?? "magazine");
    const locked = isSourceDamageMode(weaponData) && type === "magazine" && !lockedMagazineUsed;
    if (type === "magazine") lockedMagazineUsed = true;
    return {
      index,
      amount: Number(cost.amount) || 0,
      locked,
      synthetic: false,
      type,
      typeChoices: buildWeaponResourceTypeChoices(type, hasConditionFunction)
    };
  });
  if (isSourceDamageMode(weaponData) && !lockedMagazineUsed) {
    rows.push({
      index: "source-magazine",
      amount: 1,
      locked: true,
      synthetic: true,
      type: "magazine",
      typeChoices: buildWeaponResourceTypeChoices("magazine", hasConditionFunction)
    });
  }
  return rows;
}

function isLockedWeaponMagazineResourceCost(weaponData = {}, costs = [], index = -1) {
  if (!isSourceDamageMode(weaponData) || !Number.isInteger(index) || index < 0) return false;
  if (String(costs[index]?.type ?? "") !== "magazine") return false;
  return !costs.slice(0, index).some(cost => String(cost?.type ?? "") === "magazine");
}

function getDefaultNewWeaponResourceCostType(weaponData = {}, hasConditionFunction = false) {
  const used = new Set((weaponData?.resourceCosts ?? []).map(cost => String(cost?.type ?? "")));
  if (isSourceDamageMode(weaponData)) used.add("magazine");
  if (hasConditionFunction && !used.has("condition")) return "condition";
  if (!used.has("quantity")) return "quantity";
  if (!used.has("magazine")) return "magazine";
  return hasConditionFunction ? "condition" : "quantity";
}

function buildWeaponSpecialPropertyRowsForData(weaponData) {
  return (weaponData?.specialProperties ?? []).map((property, index) => ({
    index,
    choices: buildWeaponSpecialPropertyChoices(property)
  }));
}

function buildWeaponSpecialPropertyChoices(selected) {
  return [{
    value: "hitAllConeTargets",
    label: game.i18n.localize("FALLOUTMAW.Item.WeaponSpecialHitAllConeTargets")
  }].map(choice => ({
    ...choice,
    selected: choice.value === String(selected ?? "")
  }));
}

function buildWeaponRequirementRowsForData(weaponData, characteristicSettings = [], skillSettings = []) {
  return (weaponData?.requirements ?? []).map((requirement, index) => {
    const type = String(requirement?.type ?? "characteristic") === "skill" ? "skill" : "characteristic";
    return {
      index,
      type,
      key: String(requirement?.key ?? ""),
      value: Math.max(0, Number(requirement?.value) || 0),
      typeChoices: buildWeaponRequirementTypeChoices(type),
      keyChoices: buildWeaponRequirementKeyChoices(type, requirement?.key, characteristicSettings, skillSettings)
    };
  });
}

function buildWeaponRequirementTypeChoices(selected) {
  return [
    { value: "characteristic", label: game.i18n.localize("FALLOUTMAW.Item.WeaponRequirementCharacteristic") },
    { value: "skill", label: game.i18n.localize("FALLOUTMAW.Item.WeaponRequirementSkill") }
  ].map(choice => ({
    ...choice,
    selected: choice.value === selected
  }));
}

function buildWeaponRequirementKeyChoices(type, selected, characteristicSettings = [], skillSettings = []) {
  const entries = type === "skill" ? skillSettings : characteristicSettings;
  return entries.map(entry => ({
    value: entry.key,
    label: entry.label,
    selected: entry.key === String(selected ?? "")
  }));
}

function buildWeaponSlotRequirementModeChoices(selected) {
  const value = selected === "all" ? "all" : "oneOf";
  return [
    { value: "oneOf", label: game.i18n.localize("FALLOUTMAW.Item.WeaponSlotModeOneOf") },
    { value: "all", label: game.i18n.localize("FALLOUTMAW.Item.WeaponSlotModeAll") }
  ].map(choice => ({
    ...choice,
    selected: choice.value === value
  }));
}

function getAvailableWeaponResourceTypes(weaponData = {}) {
  return Array.from(new Set((weaponData?.resourceCosts ?? [])
    .map(cost => String(cost?.type ?? "").trim())
    .filter(Boolean)));
}

function getWeaponResourceTypeLabel(type = "") {
  if (type === "magazine") return game.i18n.localize("FALLOUTMAW.Item.WeaponCostMagazine");
  if (type === "condition") return game.i18n.localize("FALLOUTMAW.Item.WeaponCostCondition");
  if (type === "quantity") return game.i18n.localize("FALLOUTMAW.Item.WeaponCostQuantity");
  return String(type || "-");
}

function buildWeaponCriticalFailureConsequenceRows(actionData = {}, weaponData = {}) {
  const resourceTypes = getAvailableWeaponResourceTypes(weaponData);
  return (actionData?.criticalFailureConsequences ?? []).map((consequence, index) => ({
    index,
    type: String(consequence?.type ?? "extraResourceCost"),
    amount: Number(consequence?.amount) || 0,
    typeChoices: [{
      value: "extraResourceCost",
      label: game.i18n.localize("FALLOUTMAW.Item.WeaponCriticalFailureExtraResourceCost"),
      selected: true
    }],
    resourceChoices: resourceTypes.map(type => ({
      value: type,
      label: getWeaponResourceTypeLabel(type),
      selected: type === String(consequence?.resourceType ?? "")
    }))
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

function buildWeaponDamageTypeRows(item, damageTypeSettings) {
  return buildWeaponDamageTypeRowsForData(
    item.system?.functions?.weapon,
    damageTypeSettings,
    item.system?._source?.functions?.weapon
  );
}

function buildDamageSourceDamageTypeRows(item, damageTypeSettings) {
  return buildWeaponDamageTypeRowsForData(
    item.system?.functions?.damageSource,
    damageTypeSettings,
    item.system?._source?.functions?.damageSource
  );
}

function buildWeaponDamageModeChoices(selected = "manual") {
  const value = String(selected ?? "") === "source" ? "source" : "manual";
  return [
    { value: "manual", label: game.i18n.localize("FALLOUTMAW.Item.WeaponDamageModeManual") },
    { value: "source", label: game.i18n.localize("FALLOUTMAW.Item.WeaponDamageModeSource") }
  ].map(choice => ({
    ...choice,
    selected: choice.value === value
  }));
}

function isSourceDamageMode(weaponData = {}) {
  return String(weaponData?.damageMode ?? "manual") === "source";
}

function getWeaponDisplayData(weaponData = {}) {
  if (!isSourceDamageMode(weaponData)) return weaponData;
  const sourceItem = getWeaponMagazineSourceItem(weaponData);
  if (!sourceItem || !hasItemFunction(sourceItem, ITEM_FUNCTIONS.damageSource)) return weaponData;
  const source = getDamageSourceFunction(sourceItem);
  return {
    ...weaponData,
    damage: source.damage,
    pellets: Math.max(1, toInteger(source.pellets) || 1),
    damageTypeKey: source.damageTypeKey,
    damageTypes: source.damageTypes
  };
}

function buildWeaponMagazineSourceItems(weaponData = {}) {
  const activeUuid = String(weaponData?.magazine?.sourceItemUuid ?? "").trim();
  const rows = getWeaponMagazineSourceUuids(weaponData).map((uuid, index) => {
    const item = getWeaponMagazineSourceItem({ magazine: { sourceItemUuid: uuid } });
    const source = item ? getDamageSourceFunction(item) : null;
    return {
      index,
      uuid,
      name: String(source?.name ?? "").trim() || item?.name || uuid,
      img: normalizeImagePath(item?.img, FALLBACK_ICON),
      active: uuid === activeUuid,
      empty: false
    };
  });
  rows.push({
    index: rows.length,
    uuid: "",
    name: "",
    active: false,
    empty: true
  });
  return rows;
}

function getWeaponMagazineSourceItem(weaponData = {}) {
  const uuid = String(weaponData?.magazine?.sourceItemUuid ?? "").trim();
  if (!uuid) return null;
  return globalThis.fromUuidSync?.(uuid) ?? foundry.utils.fromUuidSync?.(uuid) ?? null;
}

function getWeaponMagazineSourceUuids(weaponData = {}) {
  return uniqueStrings([
    ...(Array.isArray(weaponData?.magazine?.sourceItemUuids) ? weaponData.magazine.sourceItemUuids : []),
    String(weaponData?.magazine?.sourceItemUuid ?? "")
  ]);
}

function uniqueStrings(values = []) {
  return Array.from(new Set((values ?? []).map(value => String(value ?? "").trim()).filter(Boolean)));
}

function refreshWeaponSheetsForDamageSource(sourceUuid = "") {
  const uuid = String(sourceUuid ?? "").trim();
  if (!uuid) return;
  for (const item of getAllWorldAndActorItems()) {
    if (!itemReferencesDamageSource(item, uuid)) continue;
    for (const app of Object.values(item.apps ?? {})) {
      app.render?.({ force: true });
    }
  }
}

function getAllWorldAndActorItems() {
  return [
    ...(game.items?.contents ?? []),
    ...(game.actors?.contents ?? []).flatMap(actor => actor.items?.contents ?? [])
  ];
}

function itemReferencesDamageSource(item, sourceUuid = "") {
  if (!item || !hasItemFunction(item, ITEM_FUNCTIONS.weapon)) return false;
  return getWeaponFunctionDataList(item).some(weaponData => (
    getWeaponMagazineSourceUuids(weaponData).includes(sourceUuid)
  ));
}

function getWeaponFunctionDataList(item) {
  const functions = item.system?.functions ?? {};
  const entries = [];
  if (functions.weapon?.enabled) entries.push(functions.weapon);
  const additional = functions.additionalWeapons;
  if (additional && typeof additional === "object") {
    entries.push(...Object.values(additional).filter(data => data?.enabled));
  }
  return entries;
}

function buildWeaponDamageTypeRowsForData(weaponData, damageTypeSettings, sourceWeaponData) {
  const rows = normalizeWeaponDamageTypeRows(
    weaponData,
    damageTypeSettings,
    sourceWeaponData
  );
  return rows.map((entry, index) => ({
    index,
    key: entry.key,
    percent: clampPercent(entry.percent),
    choices: damageTypeSettings.map(damageType => ({
      value: damageType.key,
      label: damageType.label,
      selected: damageType.key === entry.key
    }))
  }));
}

function buildVolleyRegionDamageRowsForData(entries = [], damageTypeSettings = []) {
  return normalizeVolleyRegionDamageEntries(entries).map((entry, index) => ({
    index,
    damageTypeKey: entry.damageTypeKey,
    amount: Math.max(0, toInteger(entry.amount)),
    choices: damageTypeSettings.map(damageType => ({
      value: damageType.key,
      label: damageType.label,
      selected: damageType.key === entry.damageTypeKey
    }))
  }));
}

function buildWeaponSkillChoices(item, skillSettings) {
  return buildWeaponSkillChoicesForData(item.system?.functions?.weapon ?? {}, skillSettings);
}

function buildWeaponSkillChoicesForData(weaponData, skillSettings) {
  const selected = String(weaponData?.skillKey ?? "");
  return skillSettings.map(skill => ({
    value: skill.key,
    label: skill.label,
    selected: skill.key === selected
  }));
}

function hasWeaponResourceCost(item, type) {
  return hasWeaponResourceCostData(item.system?.functions?.weapon ?? {}, type);
}

function hasWeaponResourceCostData(weaponData, type) {
  if (type === "magazine" && isSourceDamageMode(weaponData)) return true;
  return (weaponData?.resourceCosts ?? []).some(cost => cost.type === type);
}

function buildWeaponResourceTypeChoices(selected, hasConditionFunction) {
  const choices = [
    { value: "magazine", label: game.i18n.localize("FALLOUTMAW.Item.WeaponCostMagazine") },
    { value: "quantity", label: game.i18n.localize("FALLOUTMAW.Item.WeaponCostQuantity") }
  ];
  if (hasConditionFunction) {
    choices.push({ value: "condition", label: game.i18n.localize("FALLOUTMAW.Item.WeaponCostCondition") });
  }
  return choices.map(choice => ({
    ...choice,
    selected: choice.value === selected
  }));
}

function buildWeaponActionChoices(item, damageTypeSettings = []) {
  return buildWeaponActionChoicesForData(
    item.system?.functions?.weapon ?? {},
    item.system?._source?.functions?.weapon ?? {},
    damageTypeSettings
  );
}

function buildWeaponActionChoicesForData(weaponData = {}, sourceWeaponData = {}, damageTypeSettings = []) {
  const actions = weaponData?.availableActions ?? {};
  const hasMagazineCost = hasWeaponResourceCostData(weaponData, "magazine");
  const fallbackCone = Number(weaponData.attackConeDegrees) || DEFAULT_WEAPON_ATTACK_CONE_DEGREES;
  return [
    { key: "aimedShot", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionAimedShot") },
    { key: "snapshot", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionSnapshot") },
    { key: "burst", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionBurst") },
    { key: "volley", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionVolley"), isVolley: true },
    { key: "meleeAttack", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionMeleeAttack"), isMelee: true },
    { key: "aimedMeleeAttack", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionAimedMeleeAttack"), isMelee: true },
    { key: "reload", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionReload"), isReload: true, autoSelected: hasMagazineCost }
  ].map(action => {
    const actionData = weaponData?.[action.key] ?? {};
    const sourceActionData = sourceWeaponData?.[action.key] ?? {};
    const actionName = String(actionData?.name ?? "").trim();
    const hasActionCone = Object.hasOwn(sourceActionData, "attackConeDegrees");
    const thrust = prepareWeaponAttackModeSettings(actionData?.thrust);
    const swing = prepareWeaponAttackModeSettings(actionData?.swing);
    if (!thrust.enabled && !swing.enabled) {
      thrust.enabled = true;
      swing.enabled = true;
    }
    return {
      ...action,
      name: actionName,
      displayLabel: actionName || action.label,
      selected: Boolean(actions[action.key]) || Boolean(action.autoSelected),
      isBurst: action.key === "burst",
      isVolley: action.key === "volley",
      isMelee: Boolean(action.isMelee),
      actionPointCost: getWeaponActionPointCostForData(weaponData, action.key),
      attackConeDegrees: Number(hasActionCone ? actionData.attackConeDegrees : fallbackCone) || DEFAULT_WEAPON_ATTACK_CONE_DEGREES,
      burstCount: Math.max(1, Number(weaponData?.burst?.count) || 3),
      burstDifficultyPerShot: getWeaponBurstDifficultyPerShotForData(weaponData),
      volleyDamageRadius: Math.max(0, Number(weaponData?.volley?.damageRadius) || 0),
      volleyRegionRadius: Math.max(0, Number(weaponData?.volley?.regionRadius) || 0),
      volleyRegionDamageRows: buildVolleyRegionDamageRowsForData(weaponData?.volley?.regionDamageEntries, damageTypeSettings),
      volleyRegionDurationSeconds: Math.max(0, Math.trunc(Number(weaponData?.volley?.regionDurationSeconds) || 0)),
      volleyRegionDelaySeconds: Math.max(0, Math.trunc(Number(weaponData?.volley?.regionDelaySeconds) || 0)),
      volleyRegionRadiusDeltaMeters: Number(weaponData?.volley?.regionRadiusDeltaMeters) || 0,
      criticalFailureConsequences: action.isReload ? [] : buildWeaponCriticalFailureConsequenceRows(actionData, weaponData),
      thrust,
      swing
    };
  });
}

function getWeaponBurstDifficultyPerShotForData(weaponData = {}) {
  const value = Number(weaponData?.burst?.difficultyPerShot);
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 10;
}

function getWeaponActionPointCostForData(weaponData = {}, actionKey = "") {
  const value = Number(weaponData?.[actionKey]?.actionPointCost);
  const fallback = actionKey === "reload" ? DEFAULT_RELOAD_ACTION_POINT_COST : DEFAULT_WEAPON_ACTION_POINT_COST;
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : fallback;
}

function prepareWeaponAttackModeSettings(modeData = {}) {
  return {
    enabled: modeData?.enabled !== false,
    accuracyModifier: Number(modeData?.accuracyModifier) || 0,
    criticalChanceModifier: Number(modeData?.criticalChanceModifier) || 0,
    damagePercentModifier: Number(modeData?.damagePercentModifier) || 0
  };
}

function createDefaultDamageSourceFunctionData(source = {}) {
  return foundry.utils.mergeObject({
    enabled: false,
    name: "",
    damage: 0,
    pellets: 1,
    damageTypeKey: "firearm",
    damageTypes: [{ key: "firearm", percent: 100 }],
    accuracyBonus: 0,
    criticalChanceModifier: 0,
    criticalDamagePercent: 0,
    maxRangeMeters: 0,
    effectiveRange: {
      value: 0,
      max: 0
    },
    penetration: 0
  }, foundry.utils.deepClone(source), { inplace: false });
}

function createDefaultWeaponFunctionData(source = {}) {
  return foundry.utils.mergeObject({
    enabled: false,
    damageMode: "manual",
    damage: 0,
    pellets: 1,
    damageTypeKey: "firearm",
    damageTypes: [{ key: "firearm", percent: 100 }],
    attackAnimationKey: "",
    attackSoundPath: "",
    attackAnimationDelayMs: 0,
    skillKey: "rangedCombat",
    accuracyBonus: 0,
    criticalChanceModifier: 0,
    criticalDamagePercent: 150,
    attackConeDegrees: DEFAULT_WEAPON_ATTACK_CONE_DEGREES,
    maxRangeMeters: 0,
    effectiveRange: {
      value: 0,
      max: 0
    },
    penetration: 0,
    magazine: {
      value: 0,
      max: 0,
      sourceItemUuid: "",
      sourceItemUuids: []
    },
    resourceCosts: [],
    specialProperties: [],
    requirements: [],
    availableActions: {
      aimedShot: false,
      snapshot: false,
      burst: false,
      volley: false,
      meleeAttack: false,
      aimedMeleeAttack: false,
      reload: false
    },
    aimedShot: {
      name: "",
      actionPointCost: DEFAULT_WEAPON_ACTION_POINT_COST,
      attackConeDegrees: DEFAULT_WEAPON_ATTACK_CONE_DEGREES,
      criticalFailureConsequences: []
    },
    snapshot: {
      name: "",
      actionPointCost: DEFAULT_WEAPON_ACTION_POINT_COST,
      attackConeDegrees: DEFAULT_WEAPON_ATTACK_CONE_DEGREES,
      criticalFailureConsequences: []
    },
    burst: {
      name: "",
      actionPointCost: DEFAULT_WEAPON_ACTION_POINT_COST,
      attackConeDegrees: DEFAULT_WEAPON_ATTACK_CONE_DEGREES,
      count: 3,
      difficultyPerShot: 10,
      criticalFailureConsequences: []
    },
    volley: {
      name: "",
      actionPointCost: DEFAULT_WEAPON_ACTION_POINT_COST,
      damageRadius: 0,
      regionRadius: 0,
      regionDamageEntries: [],
      regionDurationSeconds: 0,
      regionDelaySeconds: 0,
      regionRadiusDeltaMeters: 0,
      explosionAnimationKey: "",
      explosionSoundPath: "",
      criticalFailureConsequences: []
    },
    meleeAttack: createDefaultWeaponMeleeActionData(),
    aimedMeleeAttack: createDefaultWeaponMeleeActionData(),
    reload: {
      name: "",
      actionPointCost: DEFAULT_RELOAD_ACTION_POINT_COST
    }
  }, foundry.utils.deepClone(source), { inplace: false });
}

function createDefaultWeaponMeleeActionData() {
  return {
    name: "",
    actionPointCost: DEFAULT_WEAPON_ACTION_POINT_COST,
    attackConeDegrees: DEFAULT_WEAPON_ATTACK_CONE_DEGREES,
    criticalFailureConsequences: [],
    thrust: {
      enabled: true,
      accuracyModifier: 0,
      criticalChanceModifier: 0,
      damagePercentModifier: 0
    },
    swing: {
      enabled: true,
      accuracyModifier: 0,
      criticalChanceModifier: 0,
      damagePercentModifier: 0
    }
  };
}

function getNextAdditionalWeaponFunctionName(additionalWeapons = []) {
  const usedNames = new Set(additionalWeapons.map(entry => String(entry?.name ?? "").trim()).filter(Boolean));
  for (let index = 0; index < 1000; index += 1) {
    const name = getDefaultAdditionalWeaponFunctionName(index);
    if (!usedNames.has(name)) return name;
  }
  return getDefaultAdditionalWeaponFunctionName(additionalWeapons.length);
}

function getDefaultAdditionalWeaponFunctionName(index) {
  return `${game.i18n.localize("FALLOUTMAW.Item.AdditionalWeaponFunction")} ${index + 1}`;
}

function getWeaponFunctionSection(element) {
  return element?.closest?.("[data-weapon-function-section]") ?? null;
}

function getWeaponFunctionPath(section) {
  return String(section?.dataset?.weaponFunctionPath ?? "") || "system.functions.weapon";
}

function getAdditionalWeaponFunctionEntries(item) {
  const additionalWeapons = item?.system?.functions?.additionalWeapons;
  if (Array.isArray(additionalWeapons)) {
    return additionalWeapons
      .map((data, index) => ({
        id: String(data?.id || `legacy${index}`),
        data: {
          ...data,
          id: String(data?.id || `legacy${index}`)
        }
      }))
      .filter(entry => entry.id);
  }
  if (!additionalWeapons || typeof additionalWeapons !== "object") return [];
  return Object.entries(additionalWeapons)
    .map(([id, data]) => ({
      id: String(id),
      data: {
        ...data,
        id: String(data?.id || id)
      }
    }))
    .filter(entry => entry.id);
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

function buildConditionRecoveryMethodRows(item, toolSettings = []) {
  const classChoices = ["D", "C", "B", "A", "S"];
  return (item.system?.functions?.condition?.recoveryMethods ?? []).map((method, index) => {
    const type = String(method?.type ?? "tools") === "tools" ? "tools" : "tools";
    const toolKey = String(method?.toolKey ?? "");
    const toolChoices = toolSettings.map(tool => ({
      value: tool.key,
      label: tool.label,
      selected: tool.key === toolKey
    }));
    if (!toolChoices.some(choice => choice.selected) && toolChoices[0]) toolChoices[0].selected = true;
    return {
      index,
      type,
      toolKey,
      toolClass: String(method?.toolClass ?? "D"),
      difficulty: Math.max(0, toInteger(method?.difficulty)),
      typeChoices: [{
        value: "tools",
        label: game.i18n.localize("FALLOUTMAW.Item.ConditionRecoveryMethodTools"),
        selected: true
      }],
      toolChoices,
      classChoices: classChoices.map(value => ({
        value,
        label: value,
        selected: value === String(method?.toolClass ?? "D")
      }))
    };
  });
}

function normalizePercentInput(value) {
  return Math.max(0, Math.min(100, Math.trunc(Number(value) || 0)));
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Math.trunc(Number(value) || 0)));
}

function normalizeWeaponDamageTypeRows(weaponData = {}, damageTypeSettings = [], sourceWeaponData = null) {
  const validKeys = new Set(damageTypeSettings.map(type => type.key));
  const fallbackKey = String(weaponData?.damageTypeKey ?? "").trim()
    || damageTypeSettings.at(0)?.key
    || "firearm";
  const hasConfiguredDamageTypes = sourceWeaponData ? Object.hasOwn(sourceWeaponData, "damageTypes") : Array.isArray(weaponData?.damageTypes);
  const rows = hasConfiguredDamageTypes && Array.isArray(weaponData?.damageTypes)
    ? weaponData.damageTypes
      .map(entry => ({
        key: String(entry?.key ?? "").trim(),
        percent: clampPercent(entry?.percent)
      }))
      .filter(entry => entry.key && (!validKeys.size || validKeys.has(entry.key)))
    : [];
  if (!rows.length) return [{ key: fallbackKey, percent: 100 }];
  if (!rows.some(entry => entry.percent > 0)) rows[0].percent = 100;
  return rows;
}

function readWeaponDamageTypeRows(root) {
  const rows = Array.from(root?.querySelectorAll("[data-weapon-damage-type-row]") ?? []);
  return rows.map(row => ({
    key: String(row.querySelector("[data-weapon-damage-type-key]")?.value ?? "").trim(),
    percent: clampPercent(row.querySelector("[data-weapon-damage-percent]")?.value)
  })).filter(entry => entry.key);
}

function readVolleyRegionDamageRows(root) {
  const rows = Array.from(root?.querySelectorAll("[data-volley-region-damage-row]") ?? []);
  return normalizeVolleyRegionDamageEntries(rows.map(row => ({
    damageTypeKey: String(row.querySelector("[data-volley-region-damage-type]")?.value ?? "").trim(),
    amount: Math.max(0, toInteger(row.querySelector("[data-volley-region-damage-amount]")?.value))
  })));
}

function normalizeVolleyRegionDamageEntries(entries = []) {
  const values = Array.isArray(entries) ? entries : Object.values(entries ?? {});
  return values
    .map(entry => ({
      damageTypeKey: String(entry?.damageTypeKey ?? "").trim(),
      amount: Math.max(0, toInteger(entry?.amount))
    }))
    .filter(entry => entry.damageTypeKey || entry.amount > 0);
}

function normalizeWeaponDamageTypeOverflow(entries = [], changedIndex = -1) {
  const normalized = entries.map(entry => ({
    key: String(entry?.key ?? "").trim(),
    percent: clampPercent(entry?.percent)
  })).filter(entry => entry.key);
  const total = normalized.reduce((sum, entry) => sum + entry.percent, 0);
  if (total <= 100) return normalized;

  let excess = total - 100;
  let candidates = normalized
    .map((entry, index) => ({ entry, index }))
    .filter(candidate => candidate.index !== changedIndex && candidate.entry.percent > 0);

  while (excess > 0 && candidates.length) {
    const share = Math.max(1, Math.ceil(excess / candidates.length));
    for (const candidate of candidates) {
      if (excess <= 0) break;
      const reduction = Math.min(candidate.entry.percent, share, excess);
      candidate.entry.percent -= reduction;
      excess -= reduction;
    }
    candidates = candidates.filter(candidate => candidate.entry.percent > 0);
  }

  if (excess > 0 && normalized[changedIndex]) normalized[changedIndex].percent = Math.max(0, normalized[changedIndex].percent - excess);
  return normalized;
}

function writeWeaponDamageTypePercents(root, entries = []) {
  const rows = Array.from(root?.querySelectorAll("[data-weapon-damage-type-row]") ?? []);
  rows.forEach((row, index) => {
    const value = String(clampPercent(entries[index]?.percent));
    row.querySelectorAll("[data-weapon-damage-percent]").forEach(input => {
      input.value = value;
    });
  });
}

function readDamageSourceDamageTypeRows(root) {
  const rows = Array.from(root?.querySelectorAll("[data-damage-source-type-row]") ?? []);
  return rows.map(row => ({
    key: String(row.querySelector("[data-damage-source-type-key]")?.value ?? "").trim(),
    percent: clampPercent(row.querySelector("[data-damage-source-percent]")?.value)
  })).filter(entry => entry.key);
}

function writeDamageSourceTypePercents(root, entries = []) {
  const rows = Array.from(root?.querySelectorAll("[data-damage-source-type-row]") ?? []);
  rows.forEach((row, index) => {
    const value = String(clampPercent(entries[index]?.percent));
    row.querySelectorAll("[data-damage-source-percent]").forEach(input => {
      input.value = value;
    });
  });
}

function buildWeaponMagazineSourceModeUpdates(path, weaponData = {}) {
  const updateData = {
    [`${path}.availableActions.reload`]: true
  };
  if (!weaponData?.magazine) {
    updateData[`${path}.magazine.value`] = 0;
    updateData[`${path}.magazine.max`] = 0;
    updateData[`${path}.magazine.sourceItemUuid`] = "";
    updateData[`${path}.magazine.sourceItemUuids`] = [];
  }
  return updateData;
}

async function getDroppedItem(event) {
  const transfer = event?.dataTransfer;
  if (!transfer) return null;
  let data = null;
  try {
    data = JSON.parse(transfer.getData("text/plain") || "{}");
  } catch (_error) {
    data = null;
  }
  if (!data || data.type !== "Item") return null;
  return foundry.utils.getDocumentClass("Item").fromDropData(data);
}

function isWorldDamageSourceItem(item) {
  return Boolean(item && !item.actor && hasItemFunction(item, ITEM_FUNCTIONS.damageSource));
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
