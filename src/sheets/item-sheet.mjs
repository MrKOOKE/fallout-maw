import { activateEffectKeyAutocomplete } from "../apps/effect-key-autocomplete.mjs";
import { TEMPLATES } from "../constants.mjs";
import { getCharacteristicSettings, getCreatureOptions, getCurrencySettings, getDamageTypeSettings, getNeedSettings, getProficiencySettings, getSkillSettings, getToolSettings } from "../settings/accessors.mjs";
import { getEquipmentSlotSelectionKey, groupRaceEquipmentSlotsBySet, groupRaceWeaponSlotsBySet } from "../utils/equipment-slots.mjs";
import {
  buildDamageMitigationLimbSetChoices,
  buildDamageMitigationTables,
  getSelectedDamageMitigationLimbSetIds
} from "../utils/damage-mitigation-display.mjs";
import {
  DAMAGE_MITIGATION_MODES,
  ITEM_FUNCTIONS,
  createToolFunctionKey,
  getDamageSourceFunction,
  getToolKeyFromFunctionKey,
  hasItemFunction
} from "../utils/item-functions.mjs";
import { FALLBACK_ICON, normalizeImagePath } from "../utils/actor-display-data.mjs";
import {
  ABILITY_CHANGE_TYPES,
  ABILITY_CONDITION_TYPES,
  ABILITY_EQUIPMENT_OPERATORS,
  ABILITY_FUNCTION_TYPES,
  createAbilityChange,
  createAbilityCondition,
  createAbilityFunction,
  normalizeAbilityFunctions
} from "../settings/abilities.mjs";
import { buildEffectKeyTokens } from "../utils/effect-key-tokens.mjs";
import { toInteger } from "../utils/numbers.mjs";
import {
  getWeaponModuleSlots,
  getWeaponModuleSlotItemData,
  getWeaponModuleTechnicalName,
  isModuleItemCompatibleWithSlot,
  isWeaponModuleItem
} from "../utils/weapon-modules.mjs";

const { ItemSheetV2 } = foundry.applications.sheets;
const { DialogV2, HandlebarsApplicationMixin } = foundry.applications.api;
const TextEditor = foundry.applications.ux.TextEditor.implementation;
const DEFAULT_WEAPON_ATTACK_CONE_DEGREES = 3;
const DEFAULT_WEAPON_ACTION_POINT_COST = 5;
const DEFAULT_RELOAD_ACTION_POINT_COST = 2;
const DEFAULT_ATTACK_ANIMATION_DELAY_MS = 200;
const DEFAULT_CONDITION_WEAKENING_THRESHOLD = 20;
const DEFAULT_ITEM_SHEET_HEIGHT = 4000;
const CRAFT_ROOT_NODE_ID = "root";
const CRAFT_GRID_FALLBACK_STEP = 56;
const CRAFT_DRAG_THRESHOLD_PX = 4;
const CRAFT_MIN_ZOOM = 0.45;
const CRAFT_MAX_ZOOM = 2.5;
const CRAFT_SOCKET_DEPTH_PX = 9;
const CRAFT_SOCKET_HALF_WIDTH_PX = 8;
const CRAFT_BLOCK_SEARCH_RADIUS = 24;
const CRAFT_MODE_CREATE = "craft";
const CRAFT_MODE_DISASSEMBLY = "disassembly";
const CRAFT_LEGACY_BEND_PIXEL_THRESHOLD = 80;
let itemSheetSourceSyncHooksRegistered = false;
const activeCraftModes = new WeakMap();

export class FalloutMaWItemSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
  #functionPickerActive = false;
  #mitigationFillDrag = null;
  #craftMode = CRAFT_MODE_CREATE;
  #craftSelection = null;
  #craftAttachSourceNodeId = "";
  #craftPanDrag = null;
  #craftNodeDrag = null;
  #craftLinkDrag = null;
  #craftSocketDrag = null;
  #craftLinkRenderFrame = 0;
  #craftResizeObserver = null;
  #craftViewportOverride = null;
  #craftViewportPersistTimeout = 0;

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
        { id: "functions", group: "primary", label: "FALLOUTMAW.Item.FunctionsTab" },
        { id: "craft", group: "primary", label: "FALLOUTMAW.Item.CraftTab" }
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
    const proficiencySettings = getProficiencySettings();
    const equipmentSlotGroups = groupRaceEquipmentSlotsBySet(creatureOptions);
    const weaponSlotGroups = groupRaceWeaponSlotsBySet(creatureOptions);
    const equipmentSlotSelections = new Map();
    const weaponSlotSelections = new Map();
    const hasContainerFunction = hasItemFunction(item, ITEM_FUNCTIONS.container);
    const hasDamageMitigationFunction = hasItemFunction(item, ITEM_FUNCTIONS.damageMitigation);
    const hasDamageSourceFunction = hasItemFunction(item, ITEM_FUNCTIONS.damageSource);
    const hasModuleFunction = hasItemFunction(item, ITEM_FUNCTIONS.module);
    const hasConditionFunction = hasItemFunction(item, ITEM_FUNCTIONS.condition);
    const hasFirstAidFunction = hasItemFunction(item, ITEM_FUNCTIONS.firstAid);
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
        value: ITEM_FUNCTIONS.firstAid,
        label: game.i18n.localize("FALLOUTMAW.Item.FunctionFirstAid"),
        disabled: hasFirstAidFunction
      },
      {
        value: ITEM_FUNCTIONS.weapon,
        label: game.i18n.localize("FALLOUTMAW.Item.FunctionWeapon"),
        disabled: hasWeaponFunction
      },
      {
        value: ITEM_FUNCTIONS.module,
        label: game.i18n.localize("FALLOUTMAW.Item.FunctionModule"),
        disabled: hasModuleFunction
      },
      ...toolFunctions.map(tool => ({
        value: createToolFunctionKey(tool.key),
        label: tool.label,
        disabled: tool.enabled
      }))
    ];
    const abilityFunctionChoices = [
      {
        value: "",
        label: "Выберите функцию",
        disabled: true,
        selected: true
      },
      {
        value: ABILITY_FUNCTION_TYPES.effectChanges,
        label: "Свободная настройка"
      },
      {
        value: ABILITY_FUNCTION_TYPES.acquisitionChanges,
        label: "Разовое изменение при приобретении"
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

    activeCraftModes.set(item, this.#craftMode);
    const craft = prepareCraftContext(item, skillSettings, this.#craftSelection, this.#craftAttachSourceNodeId, this.#craftMode);

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
      hasModuleFunction,
      weaponModuleTargetChoices: buildWeaponModuleTargetChoices(item.system?.functions?.module?.targetFunction),
      damageSourceDamageTypeRows: buildDamageSourceDamageTypeRows(item, damageTypeSettings),
      damageSourceVolleyRegionDamageRows: buildDamageSourceVolleyRegionDamageRows(item, damageTypeSettings),
      hasConditionFunction,
      hasFirstAidFunction,
      firstAidEffectRows: buildFirstAidEffectRows(item),
      firstAidNeedRows: buildFirstAidNeedRows(item),
      conditionRecoveryMethodRows: buildConditionRecoveryMethodRows(item, toolSettings),
      hasWeaponFunction,
      hasWeaponMagazineCost: hasWeaponResourceCost(item, "magazine"),
      toolFunctions,
      weaponModuleChoices: buildWeaponModuleChoices(item),
      weaponFunctionSections: buildWeaponFunctionSections(item, damageTypeSettings, skillSettings, proficiencySettings, characteristicSettings, hasConditionFunction),
      weaponDamageTypeChoices: buildWeaponDamageTypeChoices(item, damageTypeSettings),
      weaponDamageTypeRows: buildWeaponDamageTypeRows(item, damageTypeSettings),
      weaponSkillChoices: buildWeaponSkillChoices(item, skillSettings),
      weaponResourceCosts: buildWeaponResourceCostRows(item, hasConditionFunction),
      weaponActionChoices: buildWeaponActionChoices(item, damageTypeSettings),
      containerLoadReduction,
      canAddItemFunction: availableFunctionChoices.some(choice => choice.value && !choice.disabled),
      showFunctionPicker: this.#functionPickerActive,
      isAbility: type === "ability",
      isAbilityOnlyFree: Boolean(item.system?.acquisition?.onlyFree),
      isAbilityOnlyManual: Boolean(item.system?.acquisition?.onlyManual),
      canAddAbilityFunction: true,
      abilityFunctionChoices,
      abilityResearchSkillChoices: skillSettings.map((skill, index) => ({
        key: skill.key,
        label: skill.label,
        selected: skill.key === item.system?.acquisition?.skillKey || (!item.system?.acquisition?.skillKey && index === 0)
      })),
      abilityFunctions: normalizeAbilityFunctions(item.system?.functions ?? [])
        .map((entry, index) => prepareAbilityFunctionRowsForDisplay(entry, index)),
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
      damageMitigationLimbSetChoices: buildDamageMitigationLimbSetChoices(item, creatureOptions),
      damageMitigationTables: buildDamageMitigationTables(item, creatureOptions, damageTypeSettings),
      craft,
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
    this.element?.querySelectorAll("[data-add-damage-source-volley-region-damage]").forEach(button => {
      button.addEventListener("click", event => this.#onAddDamageSourceVolleyRegionDamage(event));
    });
    this.element?.querySelectorAll("[data-delete-damage-source-volley-region-damage]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteDamageSourceVolleyRegionDamage(event));
    });
    this.element?.querySelectorAll("[data-browse-damage-source-attack-sound]").forEach(button => {
      button.addEventListener("click", event => this.#onBrowseDamageSourceAttackSound(event));
    });
    this.element?.querySelectorAll("[data-browse-damage-source-explosion-sound]").forEach(button => {
      button.addEventListener("click", event => this.#onBrowseDamageSourceExplosionSound(event));
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
    this.element?.querySelector("[data-add-ability-function]")?.addEventListener("click", event => this.#onAddAbilityFunction(event));
    this.element?.querySelector("[data-add-additional-weapon-function]")?.addEventListener("click", event => this.#onAddAdditionalWeaponFunction(event));
    this.element?.querySelector("[data-add-module-weapon-function]")?.addEventListener("click", event => this.#onAddModuleWeaponFunction(event));
    this.element?.querySelectorAll("[data-delete-additional-weapon-function]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteAdditionalWeaponFunction(event));
    });
    this.element?.querySelectorAll("[data-delete-module-weapon-function]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteModuleWeaponFunction(event));
    });
    this.element?.querySelector("[data-choose-item-function]")?.addEventListener("change", event => this.#onChooseItemFunction(event));
    this.element?.querySelector("[data-choose-ability-function]")?.addEventListener("change", event => this.#onChooseAbilityFunction(event));
    this.element?.querySelectorAll("[data-delete-ability-function]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteAbilityFunction(event));
    });
    this.element?.querySelectorAll("[data-add-ability-change]").forEach(button => {
      button.addEventListener("click", event => this.#onAddAbilityChange(event));
    });
    this.element?.querySelectorAll("[data-delete-ability-change]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteAbilityChange(event));
    });
    this.element?.querySelectorAll("[data-add-ability-condition]").forEach(button => {
      button.addEventListener("click", event => this.#onAddAbilityCondition(event));
    });
    this.element?.querySelectorAll("[data-delete-ability-condition]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteAbilityCondition(event));
    });
    this.element?.querySelectorAll("[data-add-ability-penalty]").forEach(button => {
      button.addEventListener("click", event => this.#onAddAbilityPenalty(event));
    });
    this.element?.querySelectorAll("[data-delete-ability-penalty]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteAbilityPenalty(event));
    });
    this.element?.querySelectorAll("[data-ability-condition-type]").forEach(select => {
      select.addEventListener("change", event => this.#onAbilityConditionTypeChange(event));
    });
    this.element?.querySelector("[data-ability-only-free]")?.addEventListener("change", event => this.#onAbilityOnlyFreeChange(event));
    this.element?.querySelector("[data-ability-only-manual]")?.addEventListener("change", event => this.#onAbilityOnlyManualChange(event));
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
    this.element?.querySelectorAll("[data-add-weapon-module-slot]").forEach(button => {
      button.addEventListener("click", event => this.#onAddWeaponModuleSlot(event));
    });
    this.element?.querySelectorAll("[data-weapon-module-slot-key-select]").forEach(select => {
      select.addEventListener("change", event => this.#onWeaponModuleSlotKeyChange(event));
    });
    this.element?.querySelectorAll("[data-delete-weapon-module-slot]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteWeaponModuleSlot(event));
    });
    this.element?.querySelectorAll("[data-weapon-module-slot-drop]").forEach(zone => {
      zone.addEventListener("dragover", event => this.#onWeaponModuleSlotDragOver(event));
      zone.addEventListener("drop", event => this.#onWeaponModuleSlotDrop(event));
    });
    this.element?.querySelector("[data-add-condition-recovery-method]")?.addEventListener("click", event => this.#onAddConditionRecoveryMethod(event));
    this.element?.querySelectorAll("[data-delete-condition-recovery-method]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteConditionRecoveryMethod(event));
    });
    this.element?.querySelector("[data-add-first-aid-effect]")?.addEventListener("click", event => this.#onAddFirstAidEffect(event));
    this.element?.querySelectorAll("[data-delete-first-aid-effect]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteFirstAidEffect(event));
    });
    this.element?.querySelector("[data-add-first-aid-need]")?.addEventListener("click", event => this.#onAddFirstAidNeed(event));
    this.element?.querySelectorAll("[data-delete-first-aid-need]").forEach(button => {
      button.addEventListener("click", event => this.#onDeleteFirstAidNeed(event));
    });
    activateEffectKeyAutocomplete(this.element, buildEffectKeyTokens({ includeFirstAidHealing: true }));
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
    this.element?.querySelectorAll("[data-mitigation-limb-set-choice]").forEach(button => {
      button.addEventListener("click", event => this.#onMitigationLimbSetChoice(event));
    });
    this.#activateCraftEditor();
  }

  #activateCraftEditor() {
    this.#craftResizeObserver?.disconnect();
    this.#craftResizeObserver = null;
    const workspace = this.element?.querySelector("[data-craft-workspace]");
    if (!workspace) return;
    workspace.addEventListener("contextmenu", event => event.preventDefault());
    workspace.addEventListener("pointerdown", event => this.#onCraftWorkspacePointerDown(event));
    workspace.addEventListener("dragover", event => this.#onCraftDragOver(event));
    workspace.addEventListener("drop", event => this.#onCraftDrop(event));
    workspace.addEventListener("dragleave", event => this.#onCraftDragLeave(event));
    workspace.addEventListener("wheel", event => this.#onCraftWheel(event), { passive: false });
    workspace.addEventListener("pointermove", event => this.#onCraftAttachPointerMove(event));
    workspace.querySelectorAll("[data-craft-node-id]").forEach(node => {
      node.addEventListener("pointerdown", event => this.#onCraftNodePointerDown(event));
    });
    workspace.querySelectorAll("[data-craft-block-id]:not([data-craft-node-id])").forEach(block => {
      block.addEventListener("pointerdown", event => this.#onCraftBlockPointerDown(event));
    });
    workspace.querySelector("[data-craft-attach-node]")?.addEventListener("click", event => this.#onCraftAttachNode(event));
    workspace.querySelector("[data-craft-detach-node]")?.addEventListener("click", event => this.#onCraftDetachNode(event));
    workspace.querySelector("[data-craft-extract-node]")?.addEventListener("click", event => this.#onCraftExtractNode(event));
    workspace.querySelector("[data-craft-delete-link]")?.addEventListener("click", event => this.#onCraftDeleteLink(event));
    workspace.querySelector("[data-craft-delete-node]")?.addEventListener("click", event => this.#onCraftDeleteNode(event));
    workspace.querySelector("[data-craft-cancel-attach]")?.addEventListener("click", event => this.#onCraftCancelAttach(event));
    workspace.querySelector("[data-craft-node-quantity]")?.addEventListener("change", event => this.#onCraftNodeQuantityChange(event));
    this.element?.querySelectorAll("[data-craft-mode]").forEach(button => {
      button.addEventListener("click", event => this.#onCraftModeChange(event));
    });
    this.element?.querySelector("[data-craft-reverse-creation]")?.addEventListener("click", event => this.#onCraftReverseCreation(event));
    this.element?.querySelector('[data-action="tab"][data-tab="craft"]')?.addEventListener("click", () => {
      this.#scheduleCraftLinkRenderAfterLayout();
      requestAnimationFrame(() => requestAnimationFrame(() => this.#normalizeLegacyCraftBends()));
    });
    if (typeof ResizeObserver === "function") {
      this.#craftResizeObserver = new ResizeObserver(() => this.#scheduleCraftLinkRender());
      this.#craftResizeObserver.observe(workspace);
    }
    const viewport = this.#getCraftViewport();
    this.#setCraftViewportStyle(viewport.x, viewport.y, viewport.zoom);
    this.#syncCraftNodeLayouts();
    this.#scheduleCraftLinkRenderAfterLayout();
    this.#normalizeLegacyCraftBends();
    this.#positionCraftPopover();
  }

  #onCraftWorkspacePointerDown(event) {
    if (event.target?.closest?.(".fallout-maw-craft-popover")) return;
    if (event.button === 0) {
      if (this.#craftAttachSourceNodeId) {
        const workspace = event.currentTarget;
        const target = getCraftAttachTarget(workspace, event, this.#craftAttachSourceNodeId);
        const targetNodeId = String(target?.dataset?.craftNodeId ?? "");
        if (targetNodeId) {
          event.preventDefault();
          event.stopPropagation();
          return this.#createCraftLink(this.#craftAttachSourceNodeId, targetNodeId, event);
        }
      }
      if (event.target?.closest?.("[data-craft-node-id], [data-craft-link-id]")) return;
      if (!this.#craftSelection && !this.#craftAttachSourceNodeId) return;
      this.#craftSelection = null;
      this.#craftAttachSourceNodeId = "";
      this.#hideCraftSnapPreview();
      return this.render({ force: true });
    }
    if (event.button !== 2) return;
    event.preventDefault();
    event.stopPropagation();
    const viewport = this.#getCraftViewport();
    this.#craftPanDrag = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: viewport.x,
      startY: viewport.y,
      moved: false
    };
    const onMove = moveEvent => this.#onCraftPanMove(moveEvent);
    const onUp = upEvent => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      this.#onCraftPanEnd(upEvent);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
  }

  #onCraftPanMove(event) {
    const drag = this.#craftPanDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    const nextX = drag.startX + (event.clientX - drag.startClientX);
    const nextY = drag.startY + (event.clientY - drag.startClientY);
    drag.moved = true;
    this.#setCraftViewportStyle(nextX, nextY);
  }

  #onCraftPanEnd(event) {
    const drag = this.#craftPanDrag;
    this.#craftPanDrag = null;
    if (!drag || event.pointerId !== drag.pointerId || !drag.moved) return;
    const nextX = Math.round(drag.startX + (event.clientX - drag.startClientX));
    const nextY = Math.round(drag.startY + (event.clientY - drag.startClientY));
    const viewport = this.#setCraftViewportStyle(nextX, nextY);
    const path = getCraftRecipeDataPath(getActiveCraftMode(this.item));
    return this.item.update({
      [`${path}.viewport.x`]: viewport.x,
      [`${path}.viewport.y`]: viewport.y,
      [`${path}.viewport.zoom`]: viewport.zoom
    });
  }

  #getCraftViewport() {
    return this.#craftViewportOverride ?? getCraftViewport(this.item);
  }

  #setCraftViewportStyle(x, y, zoom = this.#getCraftViewport().zoom) {
    const workspace = this.element?.querySelector("[data-craft-workspace]");
    const world = this.element?.querySelector("[data-craft-world]");
    if (!world) return normalizeCraftViewport({ x, y, zoom });
    const viewport = this.#clampCraftViewport(normalizeCraftViewport({ x, y, zoom }));
    this.#craftViewportOverride = viewport;
    workspace?.style.setProperty("--craft-pan-x", `${viewport.x}px`);
    workspace?.style.setProperty("--craft-pan-y", `${viewport.y}px`);
    workspace?.style.setProperty("--craft-zoom", String(viewport.zoom));
    workspace?.style.setProperty("--fallout-maw-craft-scaled-step", `${Math.round(getCraftGridStep(workspace) * viewport.zoom)}px`);
    world.style.setProperty("--craft-pan-x", `${viewport.x}px`);
    world.style.setProperty("--craft-pan-y", `${viewport.y}px`);
    world.style.setProperty("--craft-zoom", String(viewport.zoom));
    this.#scheduleCraftLinkRender();
    this.#positionCraftPopover();
    return viewport;
  }

  #clampCraftViewport(viewport) {
    const workspace = this.element?.querySelector("[data-craft-workspace]");
    return clampCraftViewportToVisibleNode(viewport, workspace, getCraftNodesWithRoot(this.item));
  }

  #onCraftDragOver(event) {
    if (event.target?.closest?.(".fallout-maw-craft-popover")) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    const data = this.#getPreviewCraftDropData(event);
    const coords = this.#getCraftPointerGridCoordinates(event, data);
    const preview = this.#getCraftExternalDropPreview(event, coords, data);
    this.#showCraftSnapPreview(preview, preview);
  }

  async #onCraftDrop(event) {
    if (event.target?.closest?.(".fallout-maw-craft-popover")) return;
    event.preventDefault();
    event.stopPropagation();
    this.#hideCraftSnapPreview();
    const data = this.#getDragEventData(event);
    if (data?.type !== "Item") return undefined;
    const droppedItem = await foundry.utils.getDocumentClass("Item").fromDropData(data);
    if (!isValidCraftComponentItem(droppedItem)) {
      ui.notifications.warn("В крафт можно добавлять только предметы из глобального хранилища, кроме болезней, травм и способностей.");
      return undefined;
    }

    const footprint = getCraftItemFootprint(droppedItem);
    const coords = this.#getCraftPointerGridCoordinates(event, footprint);
    const nodes = getCraftNodesWithRoot(this.item);
    const newNode = createCraftNodeFromItem(droppedItem, coords);
    const target = this.#getCraftDropTarget(event);
    if (target) {
      const result = mergeCraftNodesIntoTarget({
        nodes: [...nodes, newNode],
        links: getCraftLinks(this.item),
        movingNodeIds: [newNode.id],
        target,
        preferredPoint: coords
      });
      this.#craftSelection = { type: "node", id: newNode.id };
      this.#craftAttachSourceNodeId = "";
      return this.#updateCraftRecipe(result);
    }

    nodes.push(newNode);
    const placedNodes = placeExtractedCraftNode(nodes, newNode.id);
    this.#craftSelection = { type: "node", id: newNode.id };
    this.#craftAttachSourceNodeId = "";
    return this.#updateCraftRecipe({ nodes: placedNodes });
  }

  #onCraftDragLeave(event) {
    const workspace = event.currentTarget;
    if (event.relatedTarget && workspace.contains(event.relatedTarget)) return;
    this.#hideCraftSnapPreview();
  }

  #onCraftWheel(event) {
    if (event.target?.closest?.(".fallout-maw-craft-popover")) return;
    event.preventDefault();
    const workspace = this.element?.querySelector("[data-craft-workspace]");
    const rect = workspace?.getBoundingClientRect();
    if (!rect) return undefined;
    const viewport = this.#getCraftViewport();
    const factor = Math.exp(-event.deltaY * 0.0015);
    const nextZoom = clampCraftZoom(viewport.zoom * factor);
    if (Math.abs(nextZoom - viewport.zoom) < 0.001) return undefined;
    const pointerX = event.clientX - rect.left - (rect.width / 2);
    const pointerY = event.clientY - rect.top - (rect.height / 2);
    const worldX = (pointerX - viewport.x) / viewport.zoom;
    const worldY = (pointerY - viewport.y) / viewport.zoom;
    const nextX = pointerX - (worldX * nextZoom);
    const nextY = pointerY - (worldY * nextZoom);
    const nextViewport = this.#setCraftViewportStyle(nextX, nextY, nextZoom);
    if (this.#craftPanDrag) {
      this.#craftPanDrag.startClientX = event.clientX;
      this.#craftPanDrag.startClientY = event.clientY;
      this.#craftPanDrag.startX = nextViewport.x;
      this.#craftPanDrag.startY = nextViewport.y;
    }
    this.#scheduleCraftViewportPersist(nextViewport.x, nextViewport.y, nextViewport.zoom);
    return undefined;
  }

  #scheduleCraftViewportPersist(x, y, zoom) {
    if (this.#craftViewportPersistTimeout) window.clearTimeout(this.#craftViewportPersistTimeout);
    this.#craftViewportPersistTimeout = window.setTimeout(() => {
      this.#craftViewportPersistTimeout = 0;
      const path = getCraftRecipeDataPath(getActiveCraftMode(this.item));
      this.item.update({
        [`${path}.viewport.x`]: Math.round(x),
        [`${path}.viewport.y`]: Math.round(y),
        [`${path}.viewport.zoom`]: clampCraftZoom(zoom)
      });
    }, 140);
  }

  #getPreviewCraftDropData(event) {
    const data = this.#getDragEventData(event);
    const source = data?.data?.system ?? {};
    const placement = source?.placement ?? {};
    return {
      width: Math.max(1, toInteger(placement.width) || 1),
      height: Math.max(1, toInteger(placement.height) || 1)
    };
  }

  #getCraftPointerGridCoordinates(event, { width = 1, height = 1 } = {}) {
    const workspace = this.element?.querySelector("[data-craft-workspace]");
    const rect = workspace?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const viewport = this.#getCraftViewport();
    const step = getCraftGridStep(workspace);
    const rawX = (event.clientX - rect.left - (rect.width / 2) - viewport.x) / (step * viewport.zoom);
    const rawY = (event.clientY - rect.top - (rect.height / 2) - viewport.y) / (step * viewport.zoom);
    return {
      x: snapCraftGridCoordinate(rawX, width),
      y: snapCraftGridCoordinate(rawY, height)
    };
  }

  #getCraftExternalDropPreview(event, coords = { x: 0, y: 0 }, { width = 1, height = 1 } = {}) {
    const previewNode = normalizeCraftNode({
      id: "__preview__",
      x: coords.x,
      y: coords.y,
      width,
      height
    });
    const nodes = getCraftNodesWithRoot(this.item);
    const target = this.#getCraftDropTarget(event);
    if (target) {
      const result = mergeCraftNodesIntoTarget({
        nodes: [...nodes, previewNode],
        links: getCraftLinks(this.item),
        movingNodeIds: [previewNode.id],
        target,
        preferredPoint: coords
      });
      return getCraftNodesBounds(result.nodes.filter(node => node.id === previewNode.id)) ?? craftNodeToBounds(previewNode);
    }
    const position = findNearestFreeCraftNodePosition(previewNode, getCraftOccupiedBounds(nodes));
    return craftNodeToBounds({ ...previewNode, ...position });
  }

  #getCraftDropTarget(event, { excludeNodeIds = new Set(), excludeBlockId = "" } = {}) {
    const workspace = this.element?.querySelector("[data-craft-workspace]");
    if (!workspace) return null;
    const excludedNodes = excludeNodeIds instanceof Set ? excludeNodeIds : new Set(excludeNodeIds ?? []);
    const pointElement = document.elementFromPoint(event.clientX, event.clientY);
    const directNode = pointElement?.closest?.("[data-craft-node-id]");
    if (directNode && workspace.contains(directNode)) {
      const nodeId = String(directNode.dataset.craftNodeId ?? "");
      const blockId = String(directNode.dataset.craftBlockId ?? "");
      if (!excludedNodes.has(nodeId) && (!blockId || blockId !== excludeBlockId)) return { type: "node", id: nodeId };
    }
    const directBlock = pointElement?.closest?.("[data-craft-block-id]");
    if (directBlock && workspace.contains(directBlock)) {
      const blockId = String(directBlock.dataset.craftBlockId ?? "");
      if (blockId && blockId !== excludeBlockId) return { type: "block", id: blockId };
    }

    let nearest = null;
    let nearestDistance = 34;
    for (const element of workspace.querySelectorAll("[data-craft-node-id], [data-craft-block-id]")) {
      const nodeId = String(element.dataset.craftNodeId ?? "");
      const blockId = String(element.dataset.craftBlockId ?? "");
      if ((nodeId && excludedNodes.has(nodeId)) || (blockId && blockId === excludeBlockId)) continue;
      const distance = getPointToDomRectDistance(event.clientX, event.clientY, element.getBoundingClientRect());
      if (distance < nearestDistance) {
        nearest = nodeId ? { type: "node", id: nodeId } : { type: "block", id: blockId };
        nearestDistance = distance;
      }
    }
    return nearest;
  }

  #onCraftNodePointerDown(event) {
    if (event.button !== 0) return;
    const nodeElement = event.currentTarget;
    const nodeId = String(nodeElement.dataset.craftNodeId ?? "");
    if (!nodeId) return;
    event.preventDefault();
    event.stopPropagation();

    if (this.#craftAttachSourceNodeId) {
      if (nodeId !== this.#craftAttachSourceNodeId) return this.#createCraftLink(this.#craftAttachSourceNodeId, nodeId, event);
      this.#craftAttachSourceNodeId = "";
      return this.render({ force: true });
    }

    const nodes = getCraftNodesWithRoot(this.item);
    const node = nodes.find(entry => entry.id === nodeId);
    if (!node) return;
    const blockId = String(node.blockId ?? "");
    const movingNodeIds = blockId && !event.shiftKey
      ? nodes.filter(entry => entry.blockId === blockId).map(entry => entry.id)
      : [nodeId];
    const movingNodes = nodes.filter(entry => movingNodeIds.includes(entry.id));
    const bounds = getCraftNodesBounds(movingNodes) ?? craftNodeToBounds(node);
    this.#craftNodeDrag = {
      pointerId: event.pointerId,
      nodeId,
      blockId: blockId && !event.shiftKey ? blockId : "",
      sourceBlockId: blockId,
      movingNodeIds,
      element: nodeElement,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: Number(nodeElement.dataset.craftX) || 0,
      startY: Number(nodeElement.dataset.craftY) || 0,
      previewX: bounds.x,
      previewY: bounds.y,
      previewWidth: bounds.width,
      previewHeight: bounds.height,
      moved: false
    };

    const onMove = moveEvent => this.#onCraftNodeMove(moveEvent);
    const onUp = upEvent => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      this.#onCraftNodeEnd(upEvent);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
  }

  #onCraftBlockPointerDown(event) {
    if (event.button !== 0 || this.#craftAttachSourceNodeId) return;
    const blockElement = event.currentTarget;
    const blockId = String(blockElement.dataset.craftBlockId ?? "");
    if (!blockId) return;
    event.preventDefault();
    event.stopPropagation();
    const nodes = getCraftNodesWithRoot(this.item);
    const movingNodeIds = nodes.filter(node => node.blockId === blockId).map(node => node.id);
    if (!movingNodeIds.length) return;
    const bounds = getCraftNodesBounds(nodes.filter(node => movingNodeIds.includes(node.id))) ?? {
      x: Number(blockElement.dataset.craftX) || 0,
      y: Number(blockElement.dataset.craftY) || 0,
      width: Number(blockElement.dataset.craftWidth) || 1,
      height: Number(blockElement.dataset.craftHeight) || 1
    };
    this.#craftNodeDrag = {
      pointerId: event.pointerId,
      nodeId: "",
      blockId,
      sourceBlockId: blockId,
      movingNodeIds,
      element: blockElement,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: Number(blockElement.dataset.craftX) || 0,
      startY: Number(blockElement.dataset.craftY) || 0,
      previewX: bounds.x,
      previewY: bounds.y,
      previewWidth: bounds.width,
      previewHeight: bounds.height,
      moved: false
    };

    const onMove = moveEvent => this.#onCraftNodeMove(moveEvent);
    const onUp = upEvent => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      this.#onCraftNodeEnd(upEvent);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
  }

  #onCraftNodeMove(event) {
    const drag = this.#craftNodeDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    const dx = event.clientX - drag.startClientX;
    const dy = event.clientY - drag.startClientY;
    if (!drag.moved && Math.hypot(dx, dy) < CRAFT_DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    this.#setCraftDraggingState(drag, true);
    const step = getCraftGridStep(this.element?.querySelector("[data-craft-workspace]"));
    const zoom = this.#getCraftViewport().zoom;
    const deltaX = Math.round(dx / (step * zoom));
    const deltaY = Math.round(dy / (step * zoom));
    drag.deltaX = deltaX;
    drag.deltaY = deltaY;
    const resolved = resolveCraftDragPlacement(getCraftNodesWithRoot(this.item), drag.movingNodeIds, {
      deltaX,
      deltaY,
      movingBlockId: drag.blockId,
      sourceBlockId: drag.sourceBlockId
    });
    drag.resolvedDeltaX = resolved.deltaX;
    drag.resolvedDeltaY = resolved.deltaY;
    const preview = this.#getCraftNodeDragPreview(drag, resolved.deltaX, resolved.deltaY);
    this.#showCraftSnapPreview({ x: preview.x, y: preview.y }, preview);
  }

  #getCraftNodeDragPreview(drag, deltaX = 0, deltaY = 0) {
    const movingIds = new Set(drag.movingNodeIds ?? [drag.nodeId].filter(Boolean));
    const movingNodes = getCraftNodesWithRoot(this.item)
      .filter(node => movingIds.has(node.id))
      .map(node => ({ ...node, x: node.x + deltaX, y: node.y + deltaY }));
    return getCraftNodesBounds(movingNodes) ?? {
      x: (Number(drag.previewX) || 0) + deltaX,
      y: (Number(drag.previewY) || 0) + deltaY,
      width: Math.max(1, toInteger(drag.previewWidth) || 1),
      height: Math.max(1, toInteger(drag.previewHeight) || 1)
    };
  }

  #onCraftNodeEnd(event) {
    const drag = this.#craftNodeDrag;
    this.#craftNodeDrag = null;
    if (!drag || event.pointerId !== drag.pointerId) return undefined;
    this.#setCraftDraggingState(drag, false);
    this.#hideCraftSnapPreview();
    if (!drag.moved) {
      this.#craftSelection = drag.nodeId ? { type: "node", id: drag.nodeId } : { type: "block", id: drag.blockId };
      this.#craftAttachSourceNodeId = "";
      return this.render({ force: true });
    }
    const deltaX = Number(drag.resolvedDeltaX ?? drag.deltaX ?? 0) || 0;
    const deltaY = Number(drag.resolvedDeltaY ?? drag.deltaY ?? 0) || 0;
    const movingIds = new Set(drag.movingNodeIds ?? [drag.nodeId].filter(Boolean));
    const target = this.#getCraftDropTarget(event, {
      excludeNodeIds: movingIds,
      excludeBlockId: drag.blockId || drag.sourceBlockId
    });
    const shiftedNodes = getCraftNodesWithRoot(this.item).map(node => (
      movingIds.has(node.id) ? { ...node, x: node.x + deltaX, y: node.y + deltaY } : node
    ));

    if (target) {
      const result = mergeCraftNodesIntoTarget({
        nodes: shiftedNodes,
        links: getCraftLinks(this.item),
        movingNodeIds: [...movingIds],
        target,
        preferredPoint: this.#getCraftPointerGridCoordinates(event, {
          width: drag.previewWidth,
          height: drag.previewHeight
        })
      });
      this.#craftSelection = drag.nodeId ? { type: "node", id: drag.nodeId } : null;
      this.#craftAttachSourceNodeId = "";
      return this.#updateCraftRecipe(result);
    }

    const nodes = resolveCraftMoveCollisions(shiftedNodes, [...movingIds], {
      movingBlockId: drag.blockId,
      sourceBlockId: drag.sourceBlockId
    });
    this.#craftSelection = null;
    this.#craftAttachSourceNodeId = "";
    return this.#updateCraftRecipe({ nodes });
  }

  #setCraftDraggingState(drag, enabled) {
    const method = enabled ? "add" : "remove";
    drag.element?.classList?.[method]?.("dragging");
    const workspace = this.element?.querySelector("[data-craft-workspace]");
    if (drag.blockId) {
      workspace?.querySelector(`[data-craft-block-id="${CSS.escape(drag.blockId)}"]`)?.classList?.[method]?.("dragging");
      workspace?.querySelector(`[data-craft-block-frame-id="${CSS.escape(drag.blockId)}"]`)?.classList?.[method]?.("dragging");
    }
    for (const nodeId of drag.movingNodeIds ?? []) {
      workspace?.querySelector(`[data-craft-node-id="${CSS.escape(nodeId)}"]`)?.classList?.[method]?.("dragging");
    }
  }

  #onCraftModeChange(event) {
    event.preventDefault();
    const mode = normalizeCraftMode(event.currentTarget?.dataset?.craftMode);
    if (mode === this.#craftMode) return undefined;
    this.#craftMode = mode;
    activeCraftModes.set(this.item, mode);
    this.#craftSelection = null;
    this.#craftAttachSourceNodeId = "";
    this.#craftViewportOverride = null;
    return this.render({ force: true });
  }

  async #onCraftReverseCreation(event) {
    event.preventDefault();
    const confirmed = await DialogV2.confirm({
      window: {
        title: "Реверсировать создание"
      },
      content: "<p>Скопировать схему создания в разбор, развернув связи и отзеркалив сетку относительно предмета?</p>",
      yes: {
        icon: "fa-solid fa-rotate",
        label: "Реверсировать"
      },
      no: {
        label: game.i18n.localize("Cancel")
      },
      rejectClose: false,
      modal: true
    });
    if (!confirmed) return undefined;

    const reversed = createReversedCraftRecipe(this.item);
    this.#craftMode = CRAFT_MODE_DISASSEMBLY;
    activeCraftModes.set(this.item, this.#craftMode);
    this.#craftSelection = null;
    this.#craftAttachSourceNodeId = "";
    this.#craftViewportOverride = null;
    return this.item.update({
      "system.craft.disassembly.nodes": reversed.nodes,
      "system.craft.disassembly.links": reversed.links,
      "system.craft.disassembly.viewport": reversed.viewport
    });
  }

  #onCraftAttachNode(event) {
    event.preventDefault();
    const nodeId = String(event.currentTarget.dataset.craftAttachNode ?? "");
    if (!nodeId) return undefined;
    this.#craftSelection = null;
    this.#craftAttachSourceNodeId = nodeId;
    return this.render({ force: true });
  }

  #onCraftCancelAttach(event) {
    event.preventDefault();
    this.#craftAttachSourceNodeId = "";
    return this.render({ force: true });
  }

  #onCraftDetachNode(event) {
    event.preventDefault();
    const nodeId = String(event.currentTarget.dataset.craftDetachNode ?? "");
    if (!nodeId) return undefined;
    const links = getCraftLinks(this.item).filter(link => link.fromNodeId !== nodeId && link.toNodeId !== nodeId);
    this.#craftSelection = { type: "node", id: nodeId };
    this.#craftAttachSourceNodeId = "";
    return this.#updateCraftRecipe({ links });
  }

  #onCraftDeleteLink(event) {
    event.preventDefault();
    const linkId = String(event.currentTarget.dataset.craftDeleteLink ?? "");
    if (!linkId) return undefined;
    const links = getCraftLinks(this.item).filter(link => link.id !== linkId);
    this.#craftSelection = null;
    this.#craftAttachSourceNodeId = "";
    return this.#updateCraftRecipe({ links });
  }

  #onCraftExtractNode(event) {
    event.preventDefault();
    const nodeId = String(event.currentTarget.dataset.craftExtractNode ?? "");
    if (!nodeId) return undefined;
    let nodes = getCraftNodesWithRoot(this.item).map(node => (
      node.id === nodeId ? { ...node, blockId: "" } : node
    ));
    const normalized = normalizeCraftRecipeParts(nodes, getCraftLinks(this.item));
    nodes = placeExtractedCraftNode(normalized.nodes, nodeId);
    this.#craftSelection = { type: "node", id: nodeId };
    this.#craftAttachSourceNodeId = "";
    return this.#updateCraftRecipe({ nodes, links: normalized.links });
  }

  #onCraftNodeQuantityChange(event) {
    const nodeId = String(event.currentTarget.dataset.craftNodeQuantity ?? "");
    if (!nodeId) return undefined;
    const quantity = Math.max(1, toInteger(event.currentTarget.value) || 1);
    event.currentTarget.value = String(quantity);
    const nodes = getCraftNodesWithRoot(this.item).map(node => (
      node.id === nodeId ? { ...node, quantity } : node
    ));
    this.#craftSelection = { type: "node", id: nodeId };
    return this.#updateCraftRecipe({ nodes });
  }

  #onCraftDeleteNode(event) {
    event.preventDefault();
    const nodeId = String(event.currentTarget.dataset.craftDeleteNode ?? "");
    if (!nodeId) return undefined;
    const nodes = getCraftNodesWithRoot(this.item);
    const node = nodes.find(entry => entry.id === nodeId);
    if (!node || node.root) return undefined;
    const links = getCraftLinks(this.item).filter(link => link.fromNodeId !== nodeId && link.toNodeId !== nodeId);
    this.#craftSelection = null;
    this.#craftAttachSourceNodeId = "";
    return this.#updateCraftRecipe({
      nodes: nodes.filter(entry => entry.id !== nodeId),
      links
    });
  }

  #onCraftAttachPointerMove(event) {
    if (!this.#craftAttachSourceNodeId) return;
    const workspace = this.element?.querySelector("[data-craft-workspace]");
    if (!workspace) return;
    workspace.querySelectorAll(".fallout-maw-craft-node.attach-target").forEach(node => node.classList.remove("attach-target"));
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest?.("[data-craft-node-id]");
    if (target
      && workspace.contains(target)
      && target.dataset.craftNodeId !== this.#craftAttachSourceNodeId
      && this.#canCreateCraftLink(this.#craftAttachSourceNodeId, String(target.dataset.craftNodeId ?? ""))
    ) {
      target.classList.add("attach-target");
    }
    this.#renderCraftLinks({ previewEvent: event });
  }

  #showCraftSnapPreview({ x = 0, y = 0 } = {}, { width = 1, height = 1 } = {}) {
    const preview = this.element?.querySelector("[data-craft-snap-preview]");
    if (!preview) return;
    preview.hidden = false;
    preview.style.setProperty("--craft-x", String(x));
    preview.style.setProperty("--craft-y", String(y));
    preview.style.setProperty("--craft-width", String(Math.max(1, toInteger(width) || 1)));
    preview.style.setProperty("--craft-height", String(Math.max(1, toInteger(height) || 1)));
    this.#applyCraftElementLayout(preview, { x, y, width, height });
  }

  #hideCraftSnapPreview() {
    this.element?.querySelector("[data-craft-snap-preview]")?.setAttribute("hidden", "");
  }

  #scheduleCraftLinkRender() {
    if (this.#craftLinkRenderFrame) return;
    this.#craftLinkRenderFrame = requestAnimationFrame(() => {
      this.#craftLinkRenderFrame = 0;
      if (!this.#isCraftWorkspaceRenderable()) return;
      this.#syncCraftNodeLayouts();
      this.#renderCraftLinks();
    });
  }

  #scheduleCraftLinkRenderAfterLayout() {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => this.#scheduleCraftLinkRender());
    });
  }

  #isCraftWorkspaceRenderable() {
    const workspace = this.element?.querySelector("[data-craft-workspace]");
    const svg = workspace?.querySelector("[data-craft-links]");
    if (!workspace || !svg) return false;
    if (!workspace.getClientRects().length || !svg.getClientRects().length) return false;
    const workspaceRect = workspace.getBoundingClientRect();
    const svgRect = svg.getBoundingClientRect();
    return workspaceRect.width > 0 && workspaceRect.height > 0 && svgRect.width > 0 && svgRect.height > 0;
  }

  #syncCraftNodeLayouts() {
    this.element?.querySelectorAll("[data-craft-block-id]").forEach(block => {
      this.#applyCraftElementLayout(block, {
        x: Number(block.dataset.craftX) || 0,
        y: Number(block.dataset.craftY) || 0,
        width: Number(block.dataset.craftWidth) || 1,
        height: Number(block.dataset.craftHeight) || 1
      });
    });
    this.element?.querySelectorAll("[data-craft-block-frame-id]").forEach(block => {
      this.#applyCraftElementLayout(block, {
        x: Number(block.dataset.craftX) || 0,
        y: Number(block.dataset.craftY) || 0,
        width: Number(block.dataset.craftWidth) || 1,
        height: Number(block.dataset.craftHeight) || 1
      });
    });
    this.element?.querySelectorAll("[data-craft-node-id]").forEach(node => {
      this.#applyCraftElementLayout(node, {
        x: Number(node.dataset.craftX) || 0,
        y: Number(node.dataset.craftY) || 0,
        width: Number(node.dataset.craftWidth) || 1,
        height: Number(node.dataset.craftHeight) || 1
      });
    });
  }

  #applyCraftElementLayout(element, { x = 0, y = 0, width = 1, height = 1 } = {}) {
    const metrics = getCraftGridMetrics(this.element?.querySelector("[data-craft-workspace]"));
    const normalizedWidth = Math.max(1, toInteger(width) || 1);
    const normalizedHeight = Math.max(1, toInteger(height) || 1);
    const widthPx = (normalizedWidth * metrics.cell) + ((normalizedWidth - 1) * metrics.gap);
    const heightPx = (normalizedHeight * metrics.cell) + ((normalizedHeight - 1) * metrics.gap);
    element.style.setProperty("--craft-offset-x", `${(Number(x) || 0) * metrics.step}px`);
    element.style.setProperty("--craft-offset-y", `${(Number(y) || 0) * metrics.step}px`);
    element.style.setProperty("--craft-node-width", `${widthPx}px`);
    element.style.setProperty("--craft-node-height", `${heightPx}px`);
    element.style.setProperty("--craft-node-half-width", `${widthPx / 2}px`);
    element.style.setProperty("--craft-node-half-height", `${heightPx / 2}px`);
  }

  async #createCraftLink(fromNodeId, toNodeId, event = null) {
    const nodes = getCraftNodesWithRoot(this.item);
    if (!nodes.some(node => node.id === fromNodeId) || !nodes.some(node => node.id === toNodeId)) return undefined;
    if (getCraftResolvedEndpointId(nodes.find(node => node.id === fromNodeId)) === getCraftResolvedEndpointId(nodes.find(node => node.id === toNodeId))) {
      return undefined;
    }
    const links = getCraftLinks(this.item).filter(link => (
      getCraftResolvedLinkKey(link, nodes) !== getCraftResolvedPairKey(fromNodeId, toNodeId, nodes)
    ));
    const skillKey = getDefaultCraftSkillKey(getSkillSettings());
    const anchors = event ? this.#getCraftNewLinkAnchors(fromNodeId, toNodeId, event) : {};
    const link = {
      id: foundry.utils.randomID(),
      fromNodeId,
      toNodeId,
      skillKey,
      difficulty: 60,
      ...buildCraftAnchorUpdateData(anchors)
    };
    links.push(link);
    this.#craftSelection = { type: "link", id: link.id };
    this.#craftAttachSourceNodeId = "";
    return this.#updateCraftRecipe({ nodes, links });
  }

  #getCraftNewLinkAnchors(fromNodeId, toNodeId, event) {
    const workspace = this.element?.querySelector("[data-craft-workspace]");
    const svg = workspace?.querySelector("[data-craft-links]");
    const fromElement = this.#getCraftEndpointElement(fromNodeId, workspace);
    const toElement = this.#getCraftEndpointElement(toNodeId, workspace);
    const from = getElementRectRelativeToSvg(fromElement, svg);
    const to = getElementRectRelativeToSvg(toElement, svg);
    if (!from || !to || !svg) return {};
    const cursor = getCraftSvgPointFromEvent(event, svg);
    return {
      from: anchorToData(getCraftResolvedAnchor(from, null, getRectCenter(to))),
      to: anchorToData(getCraftSnapAnchor(to, cursor, getRectCenter(from)))
    };
  }

  #renderCraftLinks({ previewEvent = null } = {}) {
    const workspace = this.element?.querySelector("[data-craft-workspace]");
    const svg = workspace?.querySelector("[data-craft-links]");
    if (!workspace || !svg) return;
    if (!this.#isCraftWorkspaceRenderable()) return;
    svg.replaceChildren();
    const nodeData = new Map(getCraftNodesWithRoot(this.item).map(node => [node.id, node]));
    const selectedLinkId = this.#craftSelection?.type === "link" ? this.#craftSelection.id : "";
    for (const link of getCraftLinks(this.item)) {
      const fromNode = nodeData.get(link.fromNodeId);
      const toNode = nodeData.get(link.toNodeId);
      if (!fromNode || !toNode || getCraftResolvedEndpointId(fromNode) === getCraftResolvedEndpointId(toNode)) continue;
      const from = this.#getCraftEndpointElement(link.fromNodeId, workspace);
      const to = this.#getCraftEndpointElement(link.toNodeId, workspace);
      if (!from || !to) continue;
      const bend = this.#craftLinkDrag?.linkId === link.id
        ? this.#craftLinkDrag.bend
        : this.#craftSocketDrag?.linkId === link.id
          ? this.#craftSocketDrag.bend
        : getCraftLinkBend(link, svg);
      const anchors = this.#craftLinkDrag?.linkId === link.id
        ? this.#craftLinkDrag.anchors
        : this.#craftSocketDrag?.linkId === link.id
          ? this.#craftSocketDrag.anchors
          : getCraftLinkAnchors(link);
      this.#appendCraftLinkPath(svg, getCraftConnectorGeometry(from, to, svg, bend, anchors), link, selectedLinkId);
    }
    if (this.#craftAttachSourceNodeId && previewEvent) {
      const source = this.#getCraftEndpointElement(this.#craftAttachSourceNodeId, workspace);
      if (source) {
        const target = getCraftAttachTarget(workspace, previewEvent, this.#craftAttachSourceNodeId);
        const targetNodeId = String(target?.dataset?.craftNodeId ?? "");
        const canLinkTarget = targetNodeId && this.#canCreateCraftLink(this.#craftAttachSourceNodeId, targetNodeId);
        if (target && canLinkTarget) target.classList.add("attach-target");
        const geometry = target && canLinkTarget
          ? getCraftAttachPreviewGeometry(source, this.#getCraftEndpointElement(targetNodeId, workspace), svg, previewEvent)
          : getCraftConnectorGeometryToPoint(source, previewEvent, svg);
        this.#appendCraftPreviewConnector(svg, geometry);
      }
    }
    this.#positionCraftPopover();
  }

  #canCreateCraftLink(fromNodeId, toNodeId) {
    const nodes = getCraftNodesWithRoot(this.item);
    const from = nodes.find(node => node.id === fromNodeId);
    const to = nodes.find(node => node.id === toNodeId);
    return Boolean(from && to && getCraftResolvedEndpointId(from) !== getCraftResolvedEndpointId(to));
  }

  #getCraftEndpointElement(nodeId, workspace = this.element?.querySelector("[data-craft-workspace]")) {
    const node = getCraftNodesWithRoot(this.item).find(entry => entry.id === nodeId);
    const blockId = String(node?.blockId ?? "");
    return (blockId ? workspace?.querySelector(`[data-craft-block-id="${CSS.escape(blockId)}"]`) : null)
      ?? workspace?.querySelector(`[data-craft-node-id="${CSS.escape(nodeId)}"]`)
      ?? null;
  }

  #appendCraftLinkPath(svg, geometry, link, selectedLinkId) {
    if (!geometry?.centerPath) return;
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.classList.add("fallout-maw-craft-link");
    if (link.id === selectedLinkId) group.classList.add("selected");
    group.dataset.craftLinkId = link.id;
    for (const [className, pathData] of [
      ["fallout-maw-craft-link-hit", geometry.centerPath],
      ["fallout-maw-craft-link-shadow", geometry.centerPath],
      ["fallout-maw-craft-link-wall", geometry.centerPath],
      ["fallout-maw-craft-link-glass", geometry.centerPath],
      ["fallout-maw-craft-link-highlight", geometry.centerPath]
    ]) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.classList.add(className);
      path.setAttribute("d", pathData);
      group.appendChild(path);
    }
    for (const [role, point] of [["from", geometry.start], ["to", geometry.end]]) {
      for (const [className, socketPath] of [
        ["fallout-maw-craft-link-socket-shadow", point.socketPath],
        ["fallout-maw-craft-link-socket", point.socketPath]
      ]) {
        const socket = document.createElementNS("http://www.w3.org/2000/svg", "path");
        socket.classList.add(className);
        socket.dataset.craftSocketRole = role;
        socket.setAttribute("d", socketPath);
        if (className === "fallout-maw-craft-link-socket") {
          socket.addEventListener("pointerdown", event => this.#onCraftSocketPointerDown(event, link, role, svg));
        }
        group.appendChild(socket);
      }
    }
    group.addEventListener("pointerdown", event => this.#onCraftLinkPointerDown(event, link, svg));
    group.addEventListener("dblclick", event => {
      event.preventDefault();
      event.stopPropagation();
      this.#craftSelection = { type: "link", id: link.id };
      this.#craftAttachSourceNodeId = "";
      this.render({ force: true });
    });
    svg.appendChild(group);
  }

  #onCraftLinkPointerDown(event, link, svg) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const start = getCraftSvgPointFromEvent(event, svg);
    const anchors = this.#getCraftLinkAnchorData(link, svg);
    this.#craftLinkDrag = {
      pointerId: event.pointerId,
      linkId: link.id,
      startClientX: event.clientX,
      startClientY: event.clientY,
      bend: getCraftLinkBend(link, svg) ?? start,
      anchors,
      moved: false
    };
    const onMove = moveEvent => this.#onCraftLinkMove(moveEvent);
    const onUp = upEvent => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      this.#onCraftLinkEnd(upEvent);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
  }

  #onCraftLinkMove(event) {
    const drag = this.#craftLinkDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    const dx = event.clientX - drag.startClientX;
    const dy = event.clientY - drag.startClientY;
    if (!drag.moved && Math.hypot(dx, dy) < CRAFT_DRAG_THRESHOLD_PX) return;
    const svg = this.element?.querySelector("[data-craft-links]");
    if (!svg) return;
    drag.moved = true;
    drag.bend = getCraftSvgPointFromEvent(event, svg);
    this.#renderCraftLinks();
  }

  #onCraftLinkEnd(event) {
    const drag = this.#craftLinkDrag;
    this.#craftLinkDrag = null;
    if (!drag || event.pointerId !== drag.pointerId) return undefined;
    this.#craftAttachSourceNodeId = "";
    if (!drag.moved) {
      this.#craftSelection = { type: "link", id: drag.linkId };
      return this.render({ force: true });
    }
    const svg = this.element?.querySelector("[data-craft-links]");
    if (!svg) return undefined;
    const links = getCraftLinks(this.item).map(link => (
      link.id === drag.linkId
        ? { ...link, ...craftSvgPointToStoredBend(svg, drag.bend), ...buildCraftAnchorUpdateData(drag.anchors) }
        : link
    ));
    this.#craftSelection = null;
    return this.#updateCraftRecipe({ links });
  }

  #onCraftSocketPointerDown(event, link, role, svg) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const anchors = this.#getCraftLinkAnchorData(link, svg);
    this.#craftSocketDrag = {
      pointerId: event.pointerId,
      linkId: link.id,
      role,
      anchors,
      bend: getCraftLinkBend(link, svg),
      moved: false,
      startClientX: event.clientX,
      startClientY: event.clientY
    };
    const onMove = moveEvent => this.#onCraftSocketMove(moveEvent);
    const onUp = upEvent => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      this.#onCraftSocketEnd(upEvent);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
  }

  #onCraftSocketMove(event) {
    const drag = this.#craftSocketDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    const dx = event.clientX - drag.startClientX;
    const dy = event.clientY - drag.startClientY;
    if (!drag.moved && Math.hypot(dx, dy) < CRAFT_DRAG_THRESHOLD_PX) return;
    const workspace = this.element?.querySelector("[data-craft-workspace]");
    const svg = workspace?.querySelector("[data-craft-links]");
    const link = getCraftLinks(this.item).find(entry => entry.id === drag.linkId);
    const nodeId = drag.role === "from" ? link?.fromNodeId : link?.toNodeId;
    const nodeElement = nodeId ? this.#getCraftEndpointElement(nodeId, workspace) : null;
    const rect = getElementRectRelativeToSvg(nodeElement, svg);
    if (!rect || !svg) return;
    drag.moved = true;
    drag.anchors = {
      ...drag.anchors,
      [drag.role]: anchorToData(getNearestRectAnchor(rect, getCraftSvgPointFromEvent(event, svg)))
    };
    this.#renderCraftLinks();
  }

  #onCraftSocketEnd(event) {
    const drag = this.#craftSocketDrag;
    this.#craftSocketDrag = null;
    if (!drag || event.pointerId !== drag.pointerId) return undefined;
    if (!drag.moved) return undefined;
    const links = getCraftLinks(this.item).map(link => (
      link.id === drag.linkId ? { ...link, ...buildCraftAnchorUpdateData(drag.anchors) } : link
    ));
    this.#craftSelection = null;
    return this.#updateCraftRecipe({ links });
  }

  #getCraftLinkAnchorData(link, svg) {
    const workspace = this.element?.querySelector("[data-craft-workspace]");
    const fromElement = this.#getCraftEndpointElement(link.fromNodeId, workspace);
    const toElement = this.#getCraftEndpointElement(link.toNodeId, workspace);
    const from = getElementRectRelativeToSvg(fromElement, svg);
    const to = getElementRectRelativeToSvg(toElement, svg);
    if (!from || !to) return getCraftLinkAnchors(link);
    const bend = getCraftLinkBend(link, svg);
    const fromAnchor = getCraftResolvedAnchor(from, getCraftLinkAnchor(link, "from"), bend ?? getRectCenter(to));
    const toAnchor = getCraftResolvedAnchor(to, getCraftLinkAnchor(link, "to"), bend ?? getRectCenter(from));
    return {
      from: anchorToData(fromAnchor),
      to: anchorToData(toAnchor)
    };
  }

  #appendCraftPreviewConnector(svg, geometry) {
    if (!geometry?.centerPath) return;
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.classList.add("fallout-maw-craft-link", "preview");
    for (const [className, pathData] of [
      ["fallout-maw-craft-link-shadow", geometry.centerPath],
      ["fallout-maw-craft-link-wall", geometry.centerPath],
      ["fallout-maw-craft-link-glass", geometry.centerPath],
      ["fallout-maw-craft-link-highlight", geometry.centerPath]
    ]) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.classList.add(className);
      path.setAttribute("d", pathData);
      group.appendChild(path);
    }
    if (geometry.start?.socketPath) {
      const socket = document.createElementNS("http://www.w3.org/2000/svg", "path");
      socket.classList.add("fallout-maw-craft-link-socket");
      socket.setAttribute("d", geometry.start.socketPath);
      group.appendChild(socket);
    }
    if (geometry.end?.socketPath) {
      const socket = document.createElementNS("http://www.w3.org/2000/svg", "path");
      socket.classList.add("fallout-maw-craft-link-socket");
      socket.setAttribute("d", geometry.end.socketPath);
      group.appendChild(socket);
    }
    svg.appendChild(group);
  }

  #updateCraftRecipe({ nodes = null, links = null, viewport = null } = {}) {
    const updateData = {};
    const path = getCraftRecipeDataPath(getActiveCraftMode(this.item));
    if (nodes || links) {
      const normalized = normalizeCraftRecipeParts(
        nodes ? nodes.map(normalizeCraftNode) : getCraftNodesWithRoot(this.item),
        links ? links.map(normalizeCraftLink) : getCraftLinks(this.item)
      );
      if (nodes) updateData[`${path}.nodes`] = normalized.nodes;
      if (nodes || links) updateData[`${path}.links`] = normalized.links;
    }
    if (viewport) updateData[`${path}.viewport`] = normalizeCraftViewport(viewport);
    return this.item.update(updateData);
  }

  #normalizeLegacyCraftBends() {
    const svg = this.element?.querySelector("[data-craft-links]");
    if (!svg) return undefined;
    const rect = svg.getBoundingClientRect();
    if (!svg.getClientRects().length || rect.width <= 0 || rect.height <= 0) return undefined;
    const links = getCraftLinks(this.item);
    if (!links.some(link => isLegacyCraftBend(link))) return undefined;
    return this.#updateCraftRecipe({
      links: links.map(link => (
        isLegacyCraftBend(link) ? { ...link, ...craftSvgPointToStoredBend(svg, getRawCraftLinkBend(link)) } : link
      ))
    });
  }

  #positionCraftPopover() {
    const workspace = this.element?.querySelector("[data-craft-workspace]");
    const popover = workspace?.querySelector("[data-craft-popover]");
    if (!workspace || !popover || popover.hidden) return;
    const workspaceRect = workspace.getBoundingClientRect();
    const target = this.#getCraftPopoverTargetElement(workspace);
    if (!target) return;
    const targetRect = target.getBoundingClientRect();
    const preferredLeft = targetRect.right - workspaceRect.left + 12;
    const preferredTop = targetRect.top - workspaceRect.top;
    const popoverWidth = popover.offsetWidth || 220;
    const popoverHeight = popover.offsetHeight || 160;
    let left = preferredLeft;
    if ((left + popoverWidth + 8) > workspaceRect.width) left = (targetRect.left - workspaceRect.left) - popoverWidth - 12;
    left = Math.max(8, Math.min(workspaceRect.width - popoverWidth - 8, left));
    const top = Math.max(8, Math.min(workspaceRect.height - popoverHeight - 8, preferredTop));
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
  }

  #getCraftPopoverTargetElement(workspace) {
    if (this.#craftSelection?.type === "node") {
      return workspace.querySelector(`[data-craft-node-id="${CSS.escape(this.#craftSelection.id)}"]`);
    }
    if (this.#craftSelection?.type === "link") {
      return workspace.querySelector(`[data-craft-link-id="${CSS.escape(this.#craftSelection.id)}"]`);
    }
    if (this.#craftAttachSourceNodeId) {
      return workspace.querySelector(`[data-craft-node-id="${CSS.escape(this.#craftAttachSourceNodeId)}"]`);
    }
    return null;
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

  #onAddAbilityFunction(event) {
    event.preventDefault();
    this.#functionPickerActive = true;
    return this.render({ force: true });
  }

  #onChooseAbilityFunction(event) {
    event.preventDefault();
    const functionType = String(event.currentTarget?.value ?? "");
    if (!Object.values(ABILITY_FUNCTION_TYPES).includes(functionType)) return undefined;
    const functions = normalizeAbilityFunctions(this.item.system?.functions ?? []);
    functions.push(createAbilityFunction(functionType));
    this.#functionPickerActive = false;
    return this.item.update({ "system.functions": functions });
  }

  #onDeleteAbilityFunction(event) {
    event.preventDefault();
    event.stopPropagation();
    const row = event.currentTarget?.closest?.("[data-ability-function-row]");
    const functionId = String(row?.dataset.functionId ?? "");
    const rowIndex = Number(row?.dataset.functionIndex ?? -1);
    const functions = normalizeAbilityFunctions(this.item.system?.functions ?? []);
    const index = functionId
      ? functions.findIndex(entry => entry.id === functionId)
      : rowIndex;
    if (index < 0) return undefined;
    functions.splice(index, 1);
    return this.item.update({ "system.functions": functions });
  }

  #onAddAbilityChange(event) {
    event.preventDefault();
    const functionIndex = Number(event.currentTarget?.closest?.("[data-ability-function-row]")?.dataset.functionIndex ?? -1);
    const functions = normalizeAbilityFunctions(this.item.system?.functions ?? []);
    if (!functions[functionIndex]) return undefined;
    functions[functionIndex].changes.push(createAbilityChange());
    return this.item.update({ "system.functions": functions });
  }

  #onDeleteAbilityChange(event) {
    event.preventDefault();
    event.stopPropagation();
    const functionIndex = Number(event.currentTarget?.closest?.("[data-ability-function-row]")?.dataset.functionIndex ?? -1);
    const changeIndex = Number(event.currentTarget?.closest?.("[data-ability-change-row]")?.dataset.changeIndex ?? -1);
    const functions = normalizeAbilityFunctions(this.item.system?.functions ?? []);
    if (!functions[functionIndex]?.changes?.[changeIndex]) return undefined;
    functions[functionIndex].changes.splice(changeIndex, 1);
    return this.item.update({ "system.functions": functions });
  }

  #onAddAbilityCondition(event) {
    event.preventDefault();
    const functionIndex = Number(event.currentTarget?.closest?.("[data-ability-function-row]")?.dataset.functionIndex ?? -1);
    const functions = normalizeAbilityFunctions(this.item.system?.functions ?? []);
    if (!functions[functionIndex]) return undefined;
    functions[functionIndex].conditions.push(createAbilityCondition(""));
    return this.item.update({ "system.functions": functions });
  }

  #onDeleteAbilityCondition(event) {
    event.preventDefault();
    event.stopPropagation();
    const functionIndex = Number(event.currentTarget?.closest?.("[data-ability-function-row]")?.dataset.functionIndex ?? -1);
    const conditionIndex = Number(event.currentTarget?.closest?.("[data-ability-condition-row]")?.dataset.conditionIndex ?? -1);
    const functions = normalizeAbilityFunctions(this.item.system?.functions ?? []);
    if (!functions[functionIndex]?.conditions?.[conditionIndex]) return undefined;
    functions[functionIndex].conditions.splice(conditionIndex, 1);
    return this.item.update({ "system.functions": functions });
  }

  #onAddAbilityPenalty(event) {
    event.preventDefault();
    const functionIndex = Number(event.currentTarget?.closest?.("[data-ability-function-row]")?.dataset.functionIndex ?? -1);
    const functions = normalizeAbilityFunctions(this.item.system?.functions ?? []);
    if (!functions[functionIndex]?.conditions?.length) return undefined;
    functions[functionIndex].penalties.push(createAbilityChange());
    return this.item.update({ "system.functions": functions });
  }

  #onDeleteAbilityPenalty(event) {
    event.preventDefault();
    event.stopPropagation();
    const functionIndex = Number(event.currentTarget?.closest?.("[data-ability-function-row]")?.dataset.functionIndex ?? -1);
    const penaltyIndex = Number(event.currentTarget?.closest?.("[data-ability-penalty-row]")?.dataset.penaltyIndex ?? -1);
    const functions = normalizeAbilityFunctions(this.item.system?.functions ?? []);
    if (!functions[functionIndex]?.penalties?.[penaltyIndex]) return undefined;
    functions[functionIndex].penalties.splice(penaltyIndex, 1);
    return this.item.update({ "system.functions": functions });
  }

  async #onAbilityConditionTypeChange(event) {
    event.preventDefault();
    const path = String(event.currentTarget?.name ?? "");
    if (!path) return undefined;
    await this.item.update({ [path]: event.currentTarget.value });
    return this.render({ force: true });
  }

  #onAbilityOnlyFreeChange(event) {
    event.preventDefault();
    const checked = Boolean(event.currentTarget?.checked);
    return this.item.update({
      "system.acquisition.onlyFree": checked,
      "system.acquisition.onlyManual": checked ? false : Boolean(this.item.system?.acquisition?.onlyManual)
    });
  }

  #onAbilityOnlyManualChange(event) {
    event.preventDefault();
    const checked = Boolean(event.currentTarget?.checked);
    return this.item.update({
      "system.acquisition.onlyFree": checked ? false : Boolean(this.item.system?.acquisition?.onlyFree),
      "system.acquisition.onlyManual": checked
    });
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
        "system.functions.damageMitigation.mode": DAMAGE_MITIGATION_MODES.defense
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

    if (functionKey === ITEM_FUNCTIONS.firstAid) {
      this.#functionPickerActive = false;
      return this.item.update({
        "system.functions.firstAid.enabled": true,
        "system.functions.firstAid.healing": 0,
        "system.functions.firstAid.healingIsPercentage": false,
        "system.functions.firstAid.durationSeconds": 0,
        "system.functions.firstAid.intervalSeconds": 6,
        "system.functions.firstAid.actionPointCost": 0,
        "system.functions.firstAid.maxDistance": 0,
        "system.functions.firstAid.difficulty": 0,
        "system.functions.firstAid.criticalSuccessHealingBonus": 20,
        "system.functions.firstAid.criticalFailureDamageMin": 1,
        "system.functions.firstAid.criticalFailureDamageMax": 10,
        "system.functions.firstAid.needs": [],
        "system.functions.firstAid.limbSelection.count": 0,
        "system.functions.firstAid.limbSelection.value": 0,
        "system.functions.firstAid.changes": []
      });
    }

    if (functionKey === ITEM_FUNCTIONS.weapon) {
      this.#functionPickerActive = false;
      return this.item.update({
        "system.functions.weapon": createDefaultWeaponFunctionData({ enabled: true })
      });
    }

    if (functionKey === ITEM_FUNCTIONS.module) {
      this.#functionPickerActive = false;
      return this.item.update({
        "system.functions.module.enabled": true,
        "system.functions.module.name": "",
        "system.functions.module.targetFunction": "weapon",
        "system.functions.module.additionalWeapons": {}
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
    if (functionKey === ITEM_FUNCTIONS.firstAid) {
      return this.item.update({
        "system.functions.firstAid.enabled": false,
        "system.functions.firstAid.healing": 0,
        "system.functions.firstAid.healingIsPercentage": false,
        "system.functions.firstAid.durationSeconds": 0,
        "system.functions.firstAid.intervalSeconds": 6,
        "system.functions.firstAid.actionPointCost": 0,
        "system.functions.firstAid.maxDistance": 0,
        "system.functions.firstAid.difficulty": 0,
        "system.functions.firstAid.criticalSuccessHealingBonus": 20,
        "system.functions.firstAid.criticalFailureDamageMin": 1,
        "system.functions.firstAid.criticalFailureDamageMax": 10,
        "system.functions.firstAid.needs": [],
        "system.functions.firstAid.limbSelection.count": 0,
        "system.functions.firstAid.limbSelection.value": 0,
        "system.functions.firstAid.changes": []
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
    if (functionKey === ITEM_FUNCTIONS.module) {
      return this.item.update({
        "system.functions.module.enabled": false,
        "system.functions.module.name": "",
        "system.functions.module.targetFunction": "weapon",
        "system.functions.module.additionalWeapons": {}
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
      enabled: true,
      moduleSlots: []
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

  #onAddModuleWeaponFunction(event) {
    event.preventDefault();
    const moduleWeapons = Object.fromEntries(getModuleWeaponFunctionEntries(this.item)
      .map(({ id, data }) => [id, foundry.utils.deepClone(data)]));
    const id = foundry.utils.randomID();
    moduleWeapons[id] = createDefaultWeaponFunctionData({
      id,
      name: getNextAdditionalWeaponFunctionName(Object.values(moduleWeapons)),
      enabled: true,
      moduleSlots: []
    });
    return this.item.update({ "system.functions.module.additionalWeapons": moduleWeapons });
  }

  #onDeleteModuleWeaponFunction(event) {
    event.preventDefault();
    event.stopPropagation();
    const id = String(event.currentTarget?.dataset?.deleteModuleWeaponFunction ?? "");
    if (!id) return undefined;
    return this.item.update({ [`system.functions.module.additionalWeapons.${id}`]: globalThis._del });
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

  #onAddWeaponModuleSlot(event) {
    event.preventDefault();
    const path = getWeaponFunctionPath(getWeaponFunctionSection(event.currentTarget));
    const weaponData = foundry.utils.getProperty(this.item, path) ?? {};
    const slots = [...getWeaponModuleSlots(weaponData)];
    slots.push({
      id: foundry.utils.randomID(),
      moduleKey: "",
      itemUuid: "",
      itemData: {}
    });
    return this.item.update({ [`${path}.moduleSlots`]: slots });
  }

  #onWeaponModuleSlotKeyChange(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    const index = Number(event.currentTarget?.dataset?.weaponModuleSlotKeySelect);
    const moduleKey = String(event.currentTarget?.value ?? "").trim();
    if (!Number.isInteger(index) || index < 0 || !moduleKey) return undefined;
    const path = getWeaponFunctionPath(getWeaponFunctionSection(event.currentTarget));
    const slots = [...getWeaponModuleSlots(foundry.utils.getProperty(this.item, path) ?? {})];
    const slot = slots[index];
    if (!slot) return undefined;
    slots[index] = {
      ...slot,
      moduleKey,
      itemUuid: "",
      itemData: {}
    };
    return this.item.update({ [`${path}.moduleSlots`]: slots });
  }

  #onDeleteWeaponModuleSlot(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.dataset?.deleteWeaponModuleSlot);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const path = getWeaponFunctionPath(getWeaponFunctionSection(event.currentTarget));
    const slots = [...getWeaponModuleSlots(foundry.utils.getProperty(this.item, path) ?? {})];
    slots.splice(index, 1);
    return this.item.update({ [`${path}.moduleSlots`]: slots });
  }

  #onWeaponModuleSlotDragOver(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  async #onWeaponModuleSlotDrop(event) {
    event.preventDefault();
    const zone = event.currentTarget;
    const index = Number(zone?.dataset?.weaponModuleSlotDrop);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const data = this.#getDragEventData(event);
    if (data?.type !== "Item") return undefined;
    const droppedItem = data.uuid
      ? await foundry.utils.getDocumentClass("Item").fromDropData(data)
      : null;
    if (!droppedItem || !isWeaponModuleItem(droppedItem)) return ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Item.WeaponModuleDropInvalid"));

    const path = getWeaponFunctionPath(getWeaponFunctionSection(zone));
    const weaponData = foundry.utils.getProperty(this.item, path) ?? {};
    const slots = [...getWeaponModuleSlots(weaponData)];
    const slot = slots[index];
    if (!slot || !isModuleItemCompatibleWithSlot(droppedItem, slot)) {
      return ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Item.WeaponModuleDropInvalid"));
    }
    const itemData = droppedItem.toObject();
    foundry.utils.setProperty(itemData, "system.quantity", 1);
    slots[index] = {
      ...slot,
      itemUuid: droppedItem.uuid,
      itemData
    };
    return this.item.update({ [`${path}.moduleSlots`]: slots });
  }

  #getDragEventData(event) {
    const cachedPayload = CONFIG.ux.DragDrop?.getPayload?.();
    if (cachedPayload && (typeof cachedPayload === "object")) return cachedPayload;

    try {
      const textEditor = foundry.applications.ux.TextEditor?.implementation ?? globalThis.TextEditor?.implementation ?? globalThis.TextEditor;
      const data = textEditor.getDragEventData(event);
      if (data && (typeof data === "object")) return data;
    } catch (_error) {
      // Fall through to explicit transfer payloads.
    }

    for (const type of ["application/json", "text/plain"]) {
      const raw = event.dataTransfer?.getData(type);
      if (!raw) continue;
      try {
        return JSON.parse(raw);
      } catch (_error) {
        continue;
      }
    }

    return null;
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

  #onAddFirstAidEffect(event) {
    event.preventDefault();
    const changes = [...(this.item.system?.functions?.firstAid?.changes ?? [])];
    changes.push({ key: "", type: "add", value: "0", phase: "initial", priority: null });
    return this.item.update({ "system.functions.firstAid.changes": changes });
  }

  #onDeleteFirstAidEffect(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.dataset?.deleteFirstAidEffect);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const changes = [...(this.item.system?.functions?.firstAid?.changes ?? [])];
    changes.splice(index, 1);
    return this.item.update({ "system.functions.firstAid.changes": changes });
  }

  #onAddFirstAidNeed(event) {
    event.preventDefault();
    const source = this.item.system?.functions?.firstAid?.needs ?? [];
    const current = Array.isArray(source)
      ? [...source]
      : Object.entries(source).map(([needKey, value]) => ({ needKey, value }));
    const existing = new Set(current.map(entry => String(entry?.needKey ?? "")));
    const need = getNeedSettings().find(entry => !existing.has(entry.key)) ?? getNeedSettings()[0];
    if (!need) return undefined;
    current.push({ needKey: need.key, value: 0 });
    return this.item.update({ "system.functions.firstAid.needs": current });
  }

  #onDeleteFirstAidNeed(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.dataset?.deleteFirstAidNeed);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const current = [...(this.item.system?.functions?.firstAid?.needs ?? [])];
    current.splice(index, 1);
    return this.item.update({ "system.functions.firstAid.needs": current });
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
    const damageTypes = getConfigurableDamageTypes(getDamageTypeSettings());
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
    const damageTypes = getConfigurableDamageTypes(getDamageTypeSettings());
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

  #onAddDamageSourceVolleyRegionDamage(event) {
    event.preventDefault();
    const entries = readDamageSourceVolleyRegionDamageRows(this.element);
    const damageTypes = getConfigurableDamageTypes(getDamageTypeSettings());
    const existingKeys = new Set(entries.map(entry => entry.damageTypeKey));
    const damageTypeKey = damageTypes.find(type => !existingKeys.has(type.key))?.key
      ?? damageTypes.at(0)?.key
      ?? "firearm";
    entries.push({ damageTypeKey, amount: 0 });
    return this.item.update({ "system.functions.damageSource.volley.regionDamageEntries": entries });
  }

  #onDeleteDamageSourceVolleyRegionDamage(event) {
    event.preventDefault();
    const index = Number(event.currentTarget?.dataset?.deleteDamageSourceVolleyRegionDamage);
    if (!Number.isInteger(index) || index < 0) return undefined;
    const entries = readDamageSourceVolleyRegionDamageRows(this.element);
    entries.splice(index, 1);
    return this.item.update({ "system.functions.damageSource.volley.regionDamageEntries": entries });
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
    const damageTypes = getConfigurableDamageTypes(getDamageTypeSettings());
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

  async #onBrowseDamageSourceAttackSound(event) {
    event.preventDefault();
    const input = this.element?.querySelector("[data-damage-source-attack-sound-input]");
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

  async #onBrowseDamageSourceExplosionSound(event) {
    event.preventDefault();
    const input = this.element?.querySelector("[data-damage-source-explosion-sound-input]");
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

  #onMitigationLimbSetChoice(event) {
    event.preventDefault();
    const groupId = String(event.currentTarget?.dataset?.mitigationLimbSetChoice ?? "");
    if (!groupId) return undefined;

    const choices = buildDamageMitigationLimbSetChoices(this.item, getCreatureOptions());
    const validIds = new Set(choices.map(choice => choice.id));
    if (!validIds.has(groupId)) return undefined;

    const selected = new Set(getSelectedDamageMitigationLimbSetIds(this.item, choices));
    if (selected.has(groupId)) {
      if (selected.size <= 1) return undefined;
      selected.delete(groupId);
    } else {
      selected.add(groupId);
    }

    return this.item.update({ "system.functions.damageMitigation.limbSetIds": Array.from(selected) });
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
        group: String(originCell.dataset.mitigationGroup ?? ""),
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
          group: String(cell.dataset.mitigationGroup ?? ""),
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
      group: String(targetCell.dataset.mitigationGroup ?? ""),
      row: Number(targetCell.dataset.mitigationRow) || 0,
      column: Number(targetCell.dataset.mitigationColumn) || 0
    };
    if (target.group !== drag.origin.group) return;
    const minRow = Math.min(drag.origin.row, target.row);
    const maxRow = Math.max(drag.origin.row, target.row);
    const minColumn = Math.min(drag.origin.column, target.column);
    const maxColumn = Math.max(drag.origin.column, target.column);
    const nextActiveInputs = new Set();

    for (const entry of drag.cells) {
      const inRectangle = entry.group === drag.origin.group
        && entry.row >= minRow
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
  if (functionKey === ITEM_FUNCTIONS.firstAid) return game.i18n.localize("FALLOUTMAW.Item.FunctionFirstAid");
  if (functionKey === ITEM_FUNCTIONS.weapon) return game.i18n.localize("FALLOUTMAW.Item.FunctionWeapon");
  if (functionKey === ITEM_FUNCTIONS.module) return game.i18n.localize("FALLOUTMAW.Item.FunctionModule");
  const toolKey = getToolKeyFromFunctionKey(functionKey);
  if (toolKey) return getToolSettings().find(tool => tool.key === toolKey)?.label ?? toolKey;
  return game.i18n.localize("FALLOUTMAW.Item.Function");
}

function prepareAbilityFunctionRowsForDisplay(entry, functionIndex = 0) {
  const type = String(entry?.type ?? ABILITY_FUNCTION_TYPES.effectChanges);
  return {
    ...entry,
    functionIndex,
    typeLabel: type === ABILITY_FUNCTION_TYPES.acquisitionChanges ? "Разовое изменение при приобретении" : "Свободная настройка",
    changes: (entry?.changes ?? []).map((change, index) => prepareAbilityChangeForDisplay(change, functionIndex, index)),
    conditions: (entry?.conditions ?? []).map((condition, index) => prepareAbilityConditionForDisplay(condition, functionIndex, index)),
    penalties: (entry?.penalties ?? []).map((change, index) => prepareAbilityPenaltyForDisplay(change, functionIndex, index)),
    hasConditions: Boolean(entry?.conditions?.length),
    hasPenalties: Boolean(entry?.penalties?.length),
    canAddPenalty: Boolean(entry?.conditions?.length)
  };
}

function prepareAbilityChangeForDisplay(change, functionIndex, index) {
  return {
    ...change,
    functionIndex,
    index,
    priority: change?.priority ?? "",
    typeChoices: buildAbilityChangeTypeChoices(change?.type)
  };
}

function prepareAbilityPenaltyForDisplay(change, functionIndex, index) {
  return {
    ...prepareAbilityChangeForDisplay(change, functionIndex, index),
    penaltyIndex: index
  };
}

function prepareAbilityConditionForDisplay(condition, functionIndex, index) {
  const type = String(condition?.type ?? "");
  const isHealth = type === ABILITY_CONDITION_TYPES.healthPercent;
  const isEquipment = type === ABILITY_CONDITION_TYPES.equipmentSlotOccupied;
  return {
    ...condition,
    functionIndex,
    index,
    isPending: !isHealth && !isEquipment,
    isHealth,
    isEquipment,
    typeLabel: getAbilityConditionTypeLabel(type),
    typeChoices: buildAbilityConditionTypeChoices(type),
    healthOperatorChoices: [
      { value: "lte", label: "<=", selected: String(condition?.operator ?? "lte") !== "gte" },
      { value: "gte", label: ">=", selected: String(condition?.operator ?? "lte") === "gte" }
    ],
    equipmentOperatorChoices: [
      { value: ABILITY_EQUIPMENT_OPERATORS.occupied, label: "Занят", selected: condition?.operator !== ABILITY_EQUIPMENT_OPERATORS.empty },
      { value: ABILITY_EQUIPMENT_OPERATORS.empty, label: "Не занят", selected: condition?.operator === ABILITY_EQUIPMENT_OPERATORS.empty }
    ],
    equipmentSlotChoices: buildAbilityEquipmentSlotChoices(condition?.equipmentSlotKey)
  };
}

function getAbilityConditionTypeLabel(type) {
  return buildAbilityConditionTypeChoices(type).find(choice => choice.value === type)?.label ?? type;
}

function buildAbilityChangeTypeChoices(selected = ABILITY_CHANGE_TYPES.add) {
  return [
    { value: ABILITY_CHANGE_TYPES.add, label: "Добавить" },
    { value: ABILITY_CHANGE_TYPES.multiply, label: "Умножить" },
    { value: ABILITY_CHANGE_TYPES.override, label: "Заменить" },
    { value: ABILITY_CHANGE_TYPES.upgrade, label: "Повысить до" },
    { value: ABILITY_CHANGE_TYPES.downgrade, label: "Понизить до" }
  ].map(choice => ({
    ...choice,
    selected: choice.value === selected
  }));
}

function buildAbilityConditionTypeChoices(selected = "") {
  return [
    { value: "", label: "", selected: !selected },
    { value: ABILITY_CONDITION_TYPES.healthPercent, label: "Состояние ОЗ", selected: selected === ABILITY_CONDITION_TYPES.healthPercent },
    { value: ABILITY_CONDITION_TYPES.equipmentSlotOccupied, label: "Занятость слотов экипировки", selected: selected === ABILITY_CONDITION_TYPES.equipmentSlotOccupied }
  ];
}

function buildAbilityEquipmentSlotChoices(selected = "") {
  const slots = new Map();
  for (const race of getCreatureOptions().races ?? []) {
    for (const slot of race.equipmentSlots ?? []) {
      const key = String(slot.key || getEquipmentSlotSelectionKey(slot.label) || slot.label || "").trim();
      if (!key || slots.has(key)) continue;
      slots.set(key, String(slot.label || key));
    }
  }
  if (selected && !slots.has(selected)) slots.set(selected, selected);
  return Array.from(slots.entries()).map(([value, label]) => ({
    value,
    label,
    selected: value === selected
  }));
}

function prepareAbilityFunctionForDisplay(entry, characteristics, skills) {
  const type = String(entry?.type ?? ABILITY_FUNCTION_TYPES.characteristicBonus);
  const targetSettings = type === ABILITY_FUNCTION_TYPES.skillBonus ? skills : characteristics;
  return {
    ...entry,
    typeLabel: type === ABILITY_FUNCTION_TYPES.skillBonus ? "Изменение навыка" : "Изменение характеристики",
    conditionEnabled: Boolean(entry?.condition?.enabled),
    conditionLte: String(entry?.condition?.operator ?? "lte") !== "gte",
    conditionGte: String(entry?.condition?.operator ?? "lte") === "gte",
    value: toInteger(entry?.value),
    conditionPercent: Math.max(0, Math.min(100, toInteger(entry?.condition?.percent ?? 50))),
    targetChoices: targetSettings.map(setting => ({
      key: setting.key,
      label: setting.label,
      selected: setting.key === entry?.target
    }))
  };
}

function buildWeaponFunctionSections(item, damageTypeSettings, skillSettings, proficiencySettings, characteristicSettings, hasConditionFunction) {
  const sections = [];
  if (hasItemFunction(item, ITEM_FUNCTIONS.weapon)) {
    const primaryWeapon = item.system?.functions?.weapon ?? {};
    const sourcePrimaryWeapon = item.system?._source?.functions?.weapon ?? {};
    const additionalWeapons = getAdditionalWeaponFunctionEntries(item);
    const sourceAdditionalWeapons = getAdditionalWeaponFunctionEntries({ system: item.system?._source ?? {} });
    sections.push(buildWeaponFunctionSection({
      title: game.i18n.localize("FALLOUTMAW.Item.FunctionWeapon"),
      path: "system.functions.weapon",
      weaponData: primaryWeapon,
      sourceWeaponData: sourcePrimaryWeapon,
      damageTypeSettings,
      skillSettings,
      proficiencySettings,
      characteristicSettings,
      hasConditionFunction,
      isPrimary: true,
      canAddAdditional: true,
      canHaveModuleSlots: true
    }));
    sections.push(...additionalWeapons.map(({ id, data: weaponData }, index) => buildWeaponFunctionSection({
      title: String(weaponData?.name ?? "").trim() || getDefaultAdditionalWeaponFunctionName(index),
      path: `system.functions.additionalWeapons.${id}`,
      weaponData,
      sourceWeaponData: sourceAdditionalWeapons.find(entry => entry.id === id)?.data ?? {},
      damageTypeSettings,
      skillSettings,
      proficiencySettings,
      characteristicSettings,
      hasConditionFunction,
      isAdditional: true,
      isNamed: true,
      id,
      index
    })));
  }
  if (hasItemFunction(item, ITEM_FUNCTIONS.module)) {
    const moduleWeapons = getModuleWeaponFunctionEntries(item);
    const sourceModuleWeapons = getModuleWeaponFunctionEntries({ system: item.system?._source ?? {} });
    sections.push(...moduleWeapons.map(({ id, data: weaponData }, index) => buildWeaponFunctionSection({
      title: String(weaponData?.name ?? "").trim() || getDefaultAdditionalWeaponFunctionName(index),
      path: `system.functions.module.additionalWeapons.${id}`,
      weaponData,
      sourceWeaponData: sourceModuleWeapons.find(entry => entry.id === id)?.data ?? {},
      damageTypeSettings,
      skillSettings,
      proficiencySettings,
      characteristicSettings,
      hasConditionFunction,
      isModuleWeapon: true,
      isNamed: true,
      id,
      index
    })));
  }
  return sections;
}

function buildWeaponFunctionSection({
  title = "",
  path = "system.functions.weapon",
  weaponData = {},
  sourceWeaponData = {},
  damageTypeSettings = [],
  skillSettings = [],
  proficiencySettings = [],
  characteristicSettings = [],
  hasConditionFunction = false,
  isPrimary = false,
  canAddAdditional = false,
  canHaveModuleSlots = false,
  isAdditional = false,
  isModuleWeapon = false,
  isNamed = false,
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
    isModuleWeapon,
    isNamed,
    canAddAdditional,
    canHaveModuleSlots,
    id,
    index,
    damageModeChoices: buildWeaponDamageModeChoices(weaponData?.damageMode),
    usesDamageSource: isSourceDamageMode(weaponData),
    hasMagazineCost: hasWeaponResourceCostData(weaponData, "magazine") || isSourceDamageMode(weaponData),
    magazineSourceItems: buildWeaponMagazineSourceItems(weaponData),
    moduleSlots: canHaveModuleSlots ? buildWeaponModuleSlotRows(weaponData) : [],
    hasVolleyAction: Boolean(weaponData?.availableActions?.volley),
    damageTypeRows: buildWeaponDamageTypeRowsForData(effectiveWeaponData, damageTypeSettings, sourceWeaponData),
    skillChoices: buildWeaponSkillChoicesForData(effectiveWeaponData, skillSettings),
    proficiencyChoices: buildWeaponProficiencyChoicesForData(effectiveWeaponData, proficiencySettings),
    resourceCosts: buildWeaponResourceCostRowsForData(weaponData, hasConditionFunction),
    specialProperties: buildWeaponSpecialPropertyRowsForData(weaponData),
    requirements: buildWeaponRequirementRowsForData(weaponData, characteristicSettings, skillSettings),
    actionChoices: buildWeaponActionChoicesForData(effectiveWeaponData, sourceWeaponData, damageTypeSettings)
  };
}

function buildWeaponModuleChoices(excludeItem = null) {
  const excludeUuid = String(excludeItem?.uuid ?? "");
  const choices = getAllWorldAndActorItems()
    .filter(item => item?.uuid !== excludeUuid && isWeaponModuleItem(item))
    .map(item => ({
      value: getWeaponModuleTechnicalName(item),
      label: getWeaponModuleTechnicalName(item),
      uuid: item.uuid
    }))
    .filter(choice => choice.value);
  const unique = [];
  const used = new Set();
  for (const choice of choices) {
    if (used.has(choice.value)) continue;
    used.add(choice.value);
    unique.push(choice);
  }
  return unique.length ? unique : [{
    value: "",
    label: game.i18n.localize("FALLOUTMAW.Item.WeaponModuleNoAvailable")
  }];
}

function buildWeaponModuleSlotRows(weaponData = {}) {
  const slots = getWeaponModuleSlots(weaponData);
  const usedModuleKeys = new Set(slots.map(slot => String(slot.moduleKey ?? "").trim()).filter(Boolean));
  return slots.map((slot, index) => {
    const itemData = getWeaponModuleSlotItemData(slot);
    return {
      index,
      id: slot.id,
      moduleKey: slot.moduleKey,
      choices: buildWeaponModuleSlotChoices(slot.moduleKey, usedModuleKeys),
      item: itemData ? {
        name: getWeaponModuleTechnicalName(itemData),
        img: normalizeImagePath(itemData.img, FALLBACK_ICON)
      } : null
    };
  });
}

function buildWeaponModuleSlotChoices(selected = "", excludedKeys = new Set()) {
  const selectedKey = String(selected ?? "");
  const availableChoices = buildWeaponModuleChoices()
    .filter(choice => !excludedKeys.has(choice.value) || choice.value === selectedKey || !choice.value);
  const moduleChoices = availableChoices.some(choice => choice.value) ? availableChoices : [{
    value: "",
    label: game.i18n.localize("FALLOUTMAW.Item.WeaponModuleNoAvailable")
  }];
  return [
    {
      value: "",
      label: game.i18n.localize("FALLOUTMAW.Item.WeaponModuleChooseSlot"),
      selected: !selectedKey,
      disabled: true
    },
    ...moduleChoices.map(choice => ({
      ...choice,
      selected: choice.value === selectedKey,
      disabled: !choice.value
    }))
  ];
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
  const choices = getConfigurableDamageTypes(damageTypeSettings);
  const selected = String(item.system?.functions?.weapon?.damageTypeKey ?? "");
  return choices.map(damageType => ({
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

function buildDamageSourceVolleyRegionDamageRows(item, damageTypeSettings) {
  return buildVolleyRegionDamageRowsForData(
    item.system?.functions?.damageSource?.volley?.regionDamageEntries,
    damageTypeSettings
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
    damageTypes: source.damageTypes,
    attackAnimationKey: String(source.attackAnimationKey ?? ""),
    attackSoundPath: String(source.attackSoundPath ?? ""),
    attackAnimationDelayMs: Math.max(0, toInteger(source.attackAnimationDelayMs)),
    volley: mergeDamageSourceVolleyData(weaponData.volley, source.volley)
  };
}

function mergeDamageSourceVolleyData(weaponVolley = {}, sourceVolley = {}) {
  return {
    ...(weaponVolley ?? {}),
    damageRadius: Math.max(0, Number(sourceVolley?.damageRadius) || 0),
    regionRadius: Math.max(0, Number(sourceVolley?.regionRadius) || 0),
    regionDamageEntries: Array.isArray(sourceVolley?.regionDamageEntries)
      ? foundry.utils.deepClone(sourceVolley.regionDamageEntries)
      : [],
    regionDurationSeconds: Math.max(0, toInteger(sourceVolley?.regionDurationSeconds)),
    regionDelaySeconds: Math.max(0, toInteger(sourceVolley?.regionDelaySeconds)),
    regionRadiusDeltaMeters: Number(sourceVolley?.regionRadiusDeltaMeters) || 0,
    explosionAnimationKey: String(sourceVolley?.explosionAnimationKey ?? ""),
    explosionSoundPath: String(sourceVolley?.explosionSoundPath ?? "")
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
  const choices = getConfigurableDamageTypes(damageTypeSettings);
  const rows = normalizeWeaponDamageTypeRows(
    weaponData,
    choices,
    sourceWeaponData
  );
  return rows.map((entry, index) => ({
    index,
    key: entry.key,
    percent: clampPercent(entry.percent),
    choices: choices.map(damageType => ({
      value: damageType.key,
      label: damageType.label,
      selected: damageType.key === entry.key
    }))
  }));
}

function buildVolleyRegionDamageRowsForData(entries = [], damageTypeSettings = []) {
  const choices = getConfigurableDamageTypes(damageTypeSettings);
  return normalizeVolleyRegionDamageEntries(entries).map((entry, index) => ({
    index,
    damageTypeKey: entry.damageTypeKey,
    amount: Math.max(0, toInteger(entry.amount)),
    choices: choices.map(damageType => ({
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

function buildWeaponModuleTargetChoices(selected = "weapon") {
  const value = String(selected ?? "") === "weapon" ? "weapon" : "weapon";
  return [{
    value: "weapon",
    label: game.i18n.localize("FALLOUTMAW.Item.FunctionWeapon"),
    selected: value === "weapon"
  }];
}

function buildWeaponProficiencyChoicesForData(weaponData, proficiencySettings) {
  const selected = String(weaponData?.proficiencyKey ?? "");
  const fallback = proficiencySettings[0]?.key ?? "";
  const selectedKey = proficiencySettings.some(proficiency => proficiency.key === selected) ? selected : fallback;
  if (!proficiencySettings.length) {
    return [{ value: "", label: game.i18n.localize("FALLOUTMAW.Settings.Proficiencies.Empty"), selected: true }];
  }
  return proficiencySettings.map(proficiency => ({
    value: proficiency.key,
    label: proficiency.label,
    selected: proficiency.key === selectedKey
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
    attackAnimationKey: "",
    attackSoundPath: "",
    attackAnimationDelayMs: DEFAULT_ATTACK_ANIMATION_DELAY_MS,
    accuracyBonus: 0,
    criticalChanceModifier: 0,
    criticalDamagePercent: 0,
    maxRangeMeters: 0,
    effectiveRange: {
      value: 0,
      max: 0
    },
    penetration: 0,
    volley: createDefaultDamageSourceVolleyData()
  }, foundry.utils.deepClone(source), { inplace: false });
}

function createDefaultDamageSourceVolleyData() {
  return {
    damageRadius: 0,
    regionRadius: 0,
    regionDamageEntries: [],
    regionDurationSeconds: 0,
    regionDelaySeconds: 0,
    regionRadiusDeltaMeters: 0,
    explosionAnimationKey: "",
    explosionSoundPath: ""
  };
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
    attackAnimationDelayMs: DEFAULT_ATTACK_ANIMATION_DELAY_MS,
    proficiencyKey: "pistol",
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
    moduleSlots: [],
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

function prepareCraftContext(item, skillSettings = [], selection = null, attachSourceNodeId = "", mode = CRAFT_MODE_CREATE) {
  mode = normalizeCraftMode(mode);
  const nodes = getCraftNodesWithRoot(item);
  const links = getCraftLinks(item);
  const blocks = getCraftBlocks(nodes);
  const viewport = getCraftViewport(item);
  const selectedNodeIndex = selection?.type === "node"
    ? nodes.findIndex(node => node.id === selection.id)
    : -1;
  const selectedNode = selectedNodeIndex >= 0
    ? prepareCraftNodeForDisplay(nodes[selectedNodeIndex], selectedNodeIndex, links)
    : null;
  const selectedLinkIndex = selection?.type === "link"
    ? links.findIndex(link => link.id === selection.id)
    : -1;
  const selectedLink = selectedLinkIndex >= 0
    ? prepareCraftLinkForDisplay(links[selectedLinkIndex], selectedLinkIndex, nodes, skillSettings)
    : null;
  const attachSourceNode = nodes.find(node => node.id === attachSourceNodeId) ?? null;
  return {
    mode,
    modes: [
      {
        key: CRAFT_MODE_CREATE,
        label: "Создание",
        selected: mode === CRAFT_MODE_CREATE
      },
      {
        key: CRAFT_MODE_DISASSEMBLY,
        label: "Разбор",
        selected: mode === CRAFT_MODE_DISASSEMBLY
      }
    ],
    canReverseCreation: mode === CRAFT_MODE_DISASSEMBLY && hasCraftRecipeData(getCraftRecipeData(item, CRAFT_MODE_CREATE)),
    linkFieldPrefix: mode === CRAFT_MODE_DISASSEMBLY ? "system.craft.disassembly.links" : "system.craft.links",
    blocks: blocks.map(block => ({
      ...block,
      label: `Craft block ${block.id}`,
      style: buildCraftNodeStyle(block),
      selected: selection?.type === "block" && selection.id === block.id
    })),
    nodes: nodes.map((node, index) => ({
      ...prepareCraftNodeForDisplay(node, index, links),
      style: buildCraftNodeStyle(node),
      selected: selection?.type === "node" && selection.id === node.id,
      attaching: attachSourceNodeId === node.id
    })),
    links,
    viewport,
    viewportStyle: `--craft-pan-x: ${Math.round(viewport.x)}px; --craft-pan-y: ${Math.round(viewport.y)}px; --craft-zoom: ${viewport.zoom};`,
    selectedNode,
    selectedLink,
    attachSourceNode,
    hasPopover: Boolean(selectedNode || selectedLink)
  };
}

function normalizeCraftMode(mode) {
  return String(mode ?? "") === CRAFT_MODE_DISASSEMBLY ? CRAFT_MODE_DISASSEMBLY : CRAFT_MODE_CREATE;
}

function getActiveCraftMode(item) {
  return normalizeCraftMode(activeCraftModes.get(item));
}

function getCraftRecipeDataPath(mode = CRAFT_MODE_CREATE) {
  return normalizeCraftMode(mode) === CRAFT_MODE_DISASSEMBLY ? "system.craft.disassembly" : "system.craft";
}

function getCraftRecipeData(item, mode = getActiveCraftMode(item)) {
  const craft = item?.system?.craft ?? {};
  if (normalizeCraftMode(mode) === CRAFT_MODE_DISASSEMBLY) return craft.disassembly ?? {};
  return craft;
}

function hasCraftRecipeData(craft = {}) {
  return Boolean((craft?.nodes ?? []).length || (craft?.links ?? []).length);
}

function prepareCraftNodeForDisplay(node, index, links) {
  const quantity = Math.max(1, toInteger(node.quantity) || 1);
  const linked = links.some(link => link.fromNodeId === node.id || link.toNodeId === node.id);
  return {
    ...node,
    index,
    linked,
    quantity,
    hasQuantityBadge: quantity > 1
  };
}

function getCraftBlocks(nodes = []) {
  return Array.from(groupCraftNodesByBlock(nodes).entries())
    .map(([id, blockNodes]) => ({ id, nodeIds: blockNodes.map(node => node.id), ...getCraftNodesBounds(blockNodes) }))
    .filter(block => block.nodeIds.length > 1 && block.width > 0 && block.height > 0);
}

function prepareCraftLinkForDisplay(link, index, nodes, skillSettings = []) {
  const from = nodes.find(node => node.id === link.fromNodeId);
  const to = nodes.find(node => node.id === link.toNodeId);
  const skillKey = String(link.skillKey ?? getDefaultCraftSkillKey(skillSettings));
  return {
    ...link,
    index,
    title: `${from?.name ?? "?"} -> ${to?.name ?? "?"}`,
    difficulty: Math.max(0, toInteger(link.difficulty) || 60),
    skillChoices: skillSettings.map((skill, skillIndex) => ({
      key: skill.key,
      label: skill.label,
      selected: skill.key === skillKey || (!skillKey && skillIndex === 0)
    }))
  };
}

function buildCraftNodeStyle(node) {
  const width = Math.max(1, toInteger(node.width) || 1);
  const height = Math.max(1, toInteger(node.height) || 1);
  const widthPx = (width * 52) + ((width - 1) * 4);
  const heightPx = (height * 52) + ((height - 1) * 4);
  return [
    `--craft-x: ${Number(node.x) || 0};`,
    `--craft-y: ${Number(node.y) || 0};`,
    `--craft-width: ${width};`,
    `--craft-height: ${height};`,
    `--craft-offset-x: ${(Number(node.x) || 0) * CRAFT_GRID_FALLBACK_STEP}px;`,
    `--craft-offset-y: ${(Number(node.y) || 0) * CRAFT_GRID_FALLBACK_STEP}px;`,
    `--craft-node-width: ${widthPx}px;`,
    `--craft-node-height: ${heightPx}px;`,
    `--craft-node-half-width: ${widthPx / 2}px;`,
    `--craft-node-half-height: ${heightPx / 2}px;`
  ].join(" ");
}

function getCraftNodesWithRoot(item) {
  const nodes = getCraftNodes(item);
  const rootIndex = nodes.findIndex(node => node.root);
  const root = createCraftRootNode(item, rootIndex >= 0 ? nodes[rootIndex] : {});
  if (rootIndex >= 0) {
    nodes[rootIndex] = root;
    return nodes;
  }
  return [root, ...nodes];
}

function getCraftNodes(item) {
  return Array.from(getCraftRecipeData(item)?.nodes ?? [])
    .map(normalizeCraftNode)
    .filter(node => node.id);
}

function getCraftLinks(item) {
  const nodes = getCraftNodesWithRoot(item);
  return normalizeCraftLinksForNodes(Array.from(getCraftRecipeData(item)?.links ?? []), nodes);
}

function getCraftViewport(item) {
  return normalizeCraftViewport(getCraftRecipeData(item)?.viewport ?? {});
}

function createCraftRootNode(item, source = {}) {
  const placement = item.system?.placement ?? {};
  const width = Math.max(1, toInteger(placement.width) || toInteger(source.width) || 1);
  const height = Math.max(1, toInteger(placement.height) || toInteger(source.height) || 1);
  return normalizeCraftNode({
    ...source,
    id: String(source.id || CRAFT_ROOT_NODE_ID),
    itemUuid: item.uuid,
    name: item.name,
    img: normalizeImagePath(item.img || FALLBACK_ICON),
    type: item.type,
    width,
    height,
    quantity: Math.max(1, toInteger(source.quantity) || 1),
    blockId: String(source.blockId ?? ""),
    root: true
  });
}

function createCraftNodeFromItem(item, { x = 0, y = 0 } = {}) {
  const { width, height } = getCraftItemFootprint(item);
  return normalizeCraftNode({
    id: foundry.utils.randomID(),
    itemUuid: item.uuid,
    name: item.name,
    img: normalizeImagePath(item.img || FALLBACK_ICON),
    type: item.type,
    x,
    y,
    width,
    height,
    quantity: 1,
    blockId: "",
    root: false
  });
}

function normalizeCraftNode(node = {}) {
  const width = Math.max(1, toInteger(node.width) || 1);
  const height = Math.max(1, toInteger(node.height) || 1);
  return {
    id: String(node.id || foundry.utils.randomID()),
    itemUuid: String(node.itemUuid ?? ""),
    name: String(node.name ?? ""),
    img: normalizeImagePath(String(node.img || FALLBACK_ICON)),
    type: String(node.type ?? ""),
    x: snapCraftGridCoordinate(node.x, width),
    y: snapCraftGridCoordinate(node.y, height),
    width,
    height,
    quantity: Math.max(1, toInteger(node.quantity) || 1),
    blockId: String(node.blockId ?? ""),
    root: Boolean(node.root)
  };
}

function getCraftItemFootprint(item) {
  const placement = item?.system?.placement ?? {};
  return {
    width: Math.max(1, toInteger(placement.width) || 1),
    height: Math.max(1, toInteger(placement.height) || 1)
  };
}

function snapCraftGridCoordinate(value, size = 1) {
  const number = Number(value);
  const offset = (Math.max(1, toInteger(size) || 1) - 1) / 2;
  return (Number.isFinite(number) ? Math.round(number - offset) : 0) + offset;
}

function normalizeCraftLink(link = {}) {
  let bendX = toOptionalNumber(link.bendX);
  let bendY = toOptionalNumber(link.bendY);
  const fromAnchorOffset = toOptionalNumber(link.fromAnchorOffset);
  const toAnchorOffset = toOptionalNumber(link.toAnchorOffset);
  if (bendX === 0 && bendY === 0) {
    bendX = null;
    bendY = null;
  }
  return {
    id: String(link.id || getCraftFallbackLinkId(link)),
    fromNodeId: String(link.fromNodeId ?? ""),
    toNodeId: String(link.toNodeId ?? ""),
    skillKey: String(link.skillKey ?? "repair"),
    difficulty: Math.max(0, toInteger(link.difficulty) || 60),
    bendX,
    bendY,
    fromAnchorSide: normalizeCraftAnchorSide(link.fromAnchorSide),
    fromAnchorOffset: Number.isFinite(fromAnchorOffset) ? clampNumber(fromAnchorOffset, 0, 1) : null,
    toAnchorSide: normalizeCraftAnchorSide(link.toAnchorSide),
    toAnchorOffset: Number.isFinite(toAnchorOffset) ? clampNumber(toAnchorOffset, 0, 1) : null
  };
}

function getCraftFallbackLinkId(link = {}) {
  return [
    "link",
    String(link.fromNodeId ?? ""),
    String(link.toNodeId ?? ""),
    String(link.skillKey ?? "repair"),
    String(link.difficulty ?? 60),
    String(link.fromAnchorSide ?? ""),
    String(link.fromAnchorOffset ?? ""),
    String(link.toAnchorSide ?? ""),
    String(link.toAnchorOffset ?? ""),
    String(link.bendX ?? ""),
    String(link.bendY ?? "")
  ].join(":");
}

function normalizeCraftRecipeParts(nodes = [], links = []) {
  const normalizedNodes = normalizeCraftBlockMembership(nodes.map(normalizeCraftNode));
  return {
    nodes: normalizedNodes,
    links: normalizeCraftLinksForNodes(links, normalizedNodes)
  };
}

function createReversedCraftRecipe(item) {
  const sourceNodes = getCraftNodesWithRootForMode(item, CRAFT_MODE_CREATE);
  const sourceLinks = getCraftLinksForMode(item, CRAFT_MODE_CREATE);
  const root = sourceNodes.find(node => node.root) ?? createCraftRootNode(item);
  const rootY = Number(root.y) || 0;
  const nodes = sourceNodes.map(node => normalizeCraftNode({
    ...foundry.utils.deepClone(node),
    y: mirrorCraftY(node.y, rootY)
  }));
  const links = sourceLinks.map(link => normalizeCraftLink({
    ...foundry.utils.deepClone(link),
    fromNodeId: link.toNodeId,
    toNodeId: link.fromNodeId,
    bendY: Number.isFinite(toOptionalNumber(link.bendY)) ? mirrorCraftY(link.bendY, rootY) : null,
    fromAnchorSide: mirrorCraftVerticalAnchorSide(link.toAnchorSide),
    fromAnchorOffset: link.toAnchorOffset,
    toAnchorSide: mirrorCraftVerticalAnchorSide(link.fromAnchorSide),
    toAnchorOffset: link.fromAnchorOffset
  }));
  return {
    ...normalizeCraftRecipeParts(nodes, links),
    viewport: normalizeCraftViewport(getCraftViewportForMode(item, CRAFT_MODE_CREATE))
  };
}

function getCraftNodesWithRootForMode(item, mode) {
  const nodes = getCraftNodesForMode(item, mode);
  const rootIndex = nodes.findIndex(node => node.root);
  const root = createCraftRootNode(item, rootIndex >= 0 ? nodes[rootIndex] : {});
  if (rootIndex >= 0) {
    nodes[rootIndex] = root;
    return nodes;
  }
  return [root, ...nodes];
}

function getCraftNodesForMode(item, mode) {
  return Array.from(getCraftRecipeData(item, mode)?.nodes ?? [])
    .map(normalizeCraftNode)
    .filter(node => node.id);
}

function getCraftLinksForMode(item, mode) {
  const nodes = getCraftNodesWithRootForMode(item, mode);
  return normalizeCraftLinksForNodes(Array.from(getCraftRecipeData(item, mode)?.links ?? []), nodes);
}

function getCraftViewportForMode(item, mode) {
  return normalizeCraftViewport(getCraftRecipeData(item, mode)?.viewport ?? {});
}

function mirrorCraftY(value, originY = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? originY - (number - originY) : originY;
}

function mirrorCraftVerticalAnchorSide(side) {
  const normalized = normalizeCraftAnchorSide(side);
  if (normalized === "top") return "bottom";
  if (normalized === "bottom") return "top";
  return normalized;
}

function normalizeCraftBlockMembership(nodes = []) {
  const blockCounts = new Map();
  for (const node of nodes) {
    if (!node.blockId) continue;
    blockCounts.set(node.blockId, (blockCounts.get(node.blockId) ?? 0) + 1);
  }
  return nodes.map(node => (
    node.blockId && (blockCounts.get(node.blockId) ?? 0) > 1 ? node : { ...node, blockId: "" }
  ));
}

function normalizeCraftLinksForNodes(links = [], nodes = []) {
  const nodeIds = new Set(nodes.map(node => node.id));
  const result = [];
  const used = new Set();
  for (const rawLink of links) {
    const link = normalizeCraftLink(rawLink);
    if (!link.id || !nodeIds.has(link.fromNodeId) || !nodeIds.has(link.toNodeId) || link.fromNodeId === link.toNodeId) continue;
    const key = getCraftResolvedLinkKey(link, nodes);
    if (!key || used.has(key)) continue;
    used.add(key);
    result.push(link);
  }
  return result;
}

function getCraftResolvedLinkKey(link, nodes = []) {
  return getCraftResolvedPairKey(link.fromNodeId, link.toNodeId, nodes);
}

function getCraftResolvedPairKey(fromNodeId, toNodeId, nodes = []) {
  const from = nodes.find(node => node.id === fromNodeId);
  const to = nodes.find(node => node.id === toNodeId);
  const fromKey = getCraftResolvedEndpointId(from);
  const toKey = getCraftResolvedEndpointId(to);
  if (!fromKey || !toKey || fromKey === toKey) return "";
  return [fromKey, toKey].sort().join("|");
}

function getCraftResolvedEndpointId(node) {
  if (!node) return "";
  return node.blockId ? `block:${node.blockId}` : `node:${node.id}`;
}

function groupCraftNodesByBlock(nodes = []) {
  const groups = new Map();
  for (const node of nodes) {
    const blockId = String(node.blockId ?? "");
    if (!blockId) continue;
    const group = groups.get(blockId) ?? [];
    group.push(node);
    groups.set(blockId, group);
  }
  return groups;
}

function craftNodeToBounds(node = {}) {
  const width = Math.max(1, toInteger(node.width) || 1);
  const height = Math.max(1, toInteger(node.height) || 1);
  const x = Number(node.x) || 0;
  const y = Number(node.y) || 0;
  return {
    left: x - (width / 2),
    right: x + (width / 2),
    top: y - (height / 2),
    bottom: y + (height / 2),
    x,
    y,
    width,
    height
  };
}

function getCraftNodesBounds(nodes = []) {
  const bounds = nodes.map(craftNodeToBounds);
  if (!bounds.length) return null;
  const left = Math.min(...bounds.map(bound => bound.left));
  const right = Math.max(...bounds.map(bound => bound.right));
  const top = Math.min(...bounds.map(bound => bound.top));
  const bottom = Math.max(...bounds.map(bound => bound.bottom));
  return {
    left,
    right,
    top,
    bottom,
    x: (left + right) / 2,
    y: (top + bottom) / 2,
    width: Math.max(1, Math.round(right - left)),
    height: Math.max(1, Math.round(bottom - top))
  };
}

function mergeCraftNodesIntoTarget({ nodes = [], links = [], movingNodeIds = [], target = null, preferredPoint = null } = {}) {
  const movingIds = new Set(movingNodeIds);
  const targetNodes = getCraftTargetNodes(nodes, target).filter(node => !movingIds.has(node.id));
  const movingNodes = nodes.filter(node => movingIds.has(node.id));
  if (!targetNodes.length || !movingNodes.length) return { nodes, links };
  const targetBlockId = String(targetNodes.find(node => node.blockId)?.blockId ?? foundry.utils.randomID());
  const targetNodeIds = new Set(targetNodes.map(node => node.id));
  let nextNodes = nodes.map(node => {
    if (movingIds.has(node.id) || targetNodeIds.has(node.id) || (node.blockId && targetNodes.some(targetNode => targetNode.blockId === node.blockId))) {
      return { ...node, blockId: targetBlockId };
    }
    return node;
  });
  const nextMovingNodes = nextNodes.filter(node => movingIds.has(node.id));
  const stationaryNodes = nextNodes.filter(node => !movingIds.has(node.id));
  const placement = findCraftGroupPlacement({
    movingNodes: nextMovingNodes,
    stationaryNodes,
    targetBounds: getCraftNodesBounds(nextNodes.filter(node => node.blockId === targetBlockId && !movingIds.has(node.id))) ?? getCraftNodesBounds(targetNodes),
    preferredPoint
  });
  nextNodes = nextNodes.map(node => (
    movingIds.has(node.id) ? { ...node, x: node.x + placement.dx, y: node.y + placement.dy } : node
  ));
  return normalizeCraftRecipeParts(nextNodes, links);
}

function getCraftTargetNodes(nodes = [], target = null) {
  if (!target) return [];
  if (target.type === "block") return nodes.filter(node => node.blockId === target.id);
  const targetNode = nodes.find(node => node.id === target.id);
  if (!targetNode) return [];
  return targetNode.blockId ? nodes.filter(node => node.blockId === targetNode.blockId) : [targetNode];
}

function placeExtractedCraftNode(nodes = [], nodeId = "") {
  const node = nodes.find(entry => entry.id === nodeId);
  if (!node) return nodes;
  const blockers = getCraftOccupiedBounds(nodes, { excludeNodeIds: [nodeId] });
  const position = findNearestFreeCraftNodePosition(node, blockers);
  return nodes.map(entry => (
    entry.id === nodeId ? { ...entry, x: position.x, y: position.y } : entry
  ));
}

function getCraftOccupiedBounds(nodes = [], { excludeNodeIds = [], ignoreBlockIds = [] } = {}) {
  const excluded = new Set(excludeNodeIds);
  const ignoredBlocks = new Set(ignoreBlockIds);
  const candidates = nodes.filter(node => !excluded.has(node.id));
  const occupied = [];
  const groupedNodeIds = new Set();
  for (const [blockId, blockNodes] of groupCraftNodesByBlock(candidates).entries()) {
    if (ignoredBlocks.has(blockId)) continue;
    if (blockNodes.length <= 1) continue;
    const bounds = getCraftNodesBounds(blockNodes);
    if (!bounds) continue;
    occupied.push(bounds);
    blockNodes.forEach(node => groupedNodeIds.add(node.id));
  }
  for (const node of candidates) {
    if (groupedNodeIds.has(node.id)) continue;
    occupied.push(craftNodeToBounds(node));
  }
  return occupied;
}

function getCraftDragBlockers(nodes = [], movingNodeIds = [], { movingBlockId = "", sourceBlockId = "" } = {}) {
  const ignoreBlockIds = [];
  if (movingBlockId) ignoreBlockIds.push(movingBlockId);
  else if (sourceBlockId) ignoreBlockIds.push(sourceBlockId);
  return getCraftOccupiedBounds(nodes, { excludeNodeIds: movingNodeIds, ignoreBlockIds });
}

function findNearestFreeCraftNodePosition(node = {}, blockers = []) {
  const width = Math.max(1, toInteger(node.width) || 1);
  const height = Math.max(1, toInteger(node.height) || 1);
  const origin = {
    x: snapCraftGridCoordinate(node.x, width),
    y: snapCraftGridCoordinate(node.y, height)
  };
  let best = null;
  const seen = new Set();
  for (let radius = 0; radius <= CRAFT_BLOCK_SEARCH_RADIUS; radius += 1) {
    for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
      for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
        if (Math.max(Math.abs(offsetX), Math.abs(offsetY)) !== radius) continue;
        const candidate = {
          x: snapCraftGridCoordinate(origin.x + offsetX, width),
          y: snapCraftGridCoordinate(origin.y + offsetY, height)
        };
        const key = `${candidate.x}:${candidate.y}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const bounds = craftNodeToBounds({ ...node, ...candidate, width, height });
        if (blockers.some(blocker => craftBoundsOverlap(bounds, blocker))) continue;
        const distance = ((candidate.x - origin.x) ** 2) + ((candidate.y - origin.y) ** 2);
        const score = distance + (candidate.y * 0.0001) + (candidate.x * 0.000001);
        if (!best || score < best.score) best = { ...candidate, score };
      }
    }
    if (best) return { x: best.x, y: best.y };
  }
  return origin;
}

function findCraftGroupPlacement({ movingNodes = [], stationaryNodes = [], targetBounds = null, preferredPoint = null } = {}) {
  const movingBounds = getCraftNodesBounds(movingNodes);
  if (!movingBounds || !targetBounds) return { dx: 0, dy: 0 };
  const desired = preferredPoint ?? { x: targetBounds.x, y: targetBounds.y };
  let best = null;
  for (let radius = 0; radius <= CRAFT_BLOCK_SEARCH_RADIUS; radius += 1) {
    const minX = Math.floor(targetBounds.left - movingBounds.width - radius);
    const maxX = Math.ceil(targetBounds.right + movingBounds.width + radius);
    const minY = Math.floor(targetBounds.top - movingBounds.height - radius);
    const maxY = Math.ceil(targetBounds.bottom + movingBounds.height + radius);
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        const candidateX = snapCraftGridCoordinate(x, movingBounds.width);
        const candidateY = snapCraftGridCoordinate(y, movingBounds.height);
        const dx = candidateX - movingBounds.x;
        const dy = candidateY - movingBounds.y;
        if (craftNodesOverlapAny(movingNodes, stationaryNodes, dx, dy)) continue;
        const movedBounds = offsetCraftBounds(movingBounds, dx, dy);
        const distance = Math.hypot(movedBounds.x - desired.x, movedBounds.y - desired.y);
        const expansion = getCraftBoundsUnionArea(targetBounds, movedBounds);
        const score = distance + (expansion * 0.001);
        if (!best || score < best.score) best = { dx, dy, score };
      }
    }
    if (best) return best;
  }
  return { dx: 0, dy: 0 };
}

function resolveCraftDragPlacement(nodes = [], movingNodeIds = [], { deltaX = 0, deltaY = 0, movingBlockId = "", sourceBlockId = "" } = {}) {
  const movingIds = new Set(movingNodeIds);
  const movingNodes = nodes.filter(node => movingIds.has(node.id));
  if (!movingNodes.length) return { deltaX, deltaY, bounds: null };
  const blockers = getCraftDragBlockers(nodes, [...movingIds], { movingBlockId, sourceBlockId });
  const preferredBounds = offsetCraftBounds(getCraftNodesBounds(movingNodes), deltaX, deltaY);
  if (!blockers.some(blocker => craftBoundsOverlap(preferredBounds, blocker))) {
    return { deltaX, deltaY, bounds: preferredBounds };
  }
  return findNearestFreeCraftGroupDelta(movingNodes, blockers, { deltaX, deltaY });
}

function resolveCraftMoveCollisions(nodes = [], movingNodeIds = [], options = {}) {
  const resolved = resolveCraftDragPlacement(nodes, movingNodeIds, { ...options, deltaX: 0, deltaY: 0 });
  if (!resolved.deltaX && !resolved.deltaY) return nodes;
  const movingIds = new Set(movingNodeIds);
  return nodes.map(node => (
    movingIds.has(node.id) ? { ...node, x: node.x + resolved.deltaX, y: node.y + resolved.deltaY } : node
  ));
}

function findNearestFreeCraftGroupDelta(movingNodes = [], blockers = [], { deltaX = 0, deltaY = 0 } = {}) {
  const originBounds = getCraftNodesBounds(movingNodes);
  if (!originBounds) return { deltaX, deltaY, bounds: null };
  let best = null;
  const seen = new Set();
  for (let radius = 0; radius <= CRAFT_BLOCK_SEARCH_RADIUS; radius += 1) {
    for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
      for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
        if (Math.max(Math.abs(offsetX), Math.abs(offsetY)) !== radius) continue;
        const candidateDeltaX = deltaX + offsetX;
        const candidateDeltaY = deltaY + offsetY;
        const key = `${candidateDeltaX}:${candidateDeltaY}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const bounds = offsetCraftBounds(originBounds, candidateDeltaX, candidateDeltaY);
        if (blockers.some(blocker => craftBoundsOverlap(bounds, blocker))) continue;
        const distance = (offsetX ** 2) + (offsetY ** 2);
        const score = distance + (bounds.y * 0.0001) + (bounds.x * 0.000001);
        if (!best || score < best.score) best = { deltaX: candidateDeltaX, deltaY: candidateDeltaY, bounds, score };
      }
    }
    if (best) return best;
  }
  return { deltaX, deltaY, bounds: offsetCraftBounds(originBounds, deltaX, deltaY) };
}

function craftNodesOverlapAny(movingNodes = [], stationaryNodes = [], dx = 0, dy = 0) {
  return movingNodes.some(moving => {
    const movingBounds = offsetCraftBounds(craftNodeToBounds(moving), dx, dy);
    return stationaryNodes.some(stationary => craftBoundsOverlap(movingBounds, craftNodeToBounds(stationary)));
  });
}

function craftBoundsOverlap(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function offsetCraftBounds(bounds, dx = 0, dy = 0) {
  return {
    ...bounds,
    left: bounds.left + dx,
    right: bounds.right + dx,
    top: bounds.top + dy,
    bottom: bounds.bottom + dy,
    x: bounds.x + dx,
    y: bounds.y + dy
  };
}

function getCraftBoundsUnionArea(a, b) {
  const width = Math.max(a.right, b.right) - Math.min(a.left, b.left);
  const height = Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top);
  return Math.max(0, width * height);
}

function toOptionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeCraftViewport(viewport = {}) {
  return {
    x: Math.round(Number(viewport.x) || 0),
    y: Math.round(Number(viewport.y) || 0),
    zoom: clampCraftZoom(viewport.zoom)
  };
}

function clampCraftZoom(value) {
  const zoom = Number(value);
  if (!Number.isFinite(zoom)) return 1;
  return Math.max(CRAFT_MIN_ZOOM, Math.min(CRAFT_MAX_ZOOM, zoom));
}

function isValidCraftComponentItem(item) {
  return Boolean(item && !item.actor && !["ability", "trauma", "disease"].includes(item.type));
}

function getDefaultCraftSkillKey(skillSettings = []) {
  return skillSettings.some(skill => skill.key === "repair")
    ? "repair"
    : String(skillSettings.at(0)?.key ?? "");
}

function getCraftGridStep(element) {
  return getCraftGridMetrics(element).step;
}

function getCraftGridMetrics(element) {
  const computed = element ? getComputedStyle(element) : null;
  const cell = parseCssLength(computed?.getPropertyValue("--fallout-maw-inventory-cell-size"), element) || 52;
  const gap = parseCssLength(computed?.getPropertyValue("--fallout-maw-inventory-grid-gap"), element) || 4;
  const step = Math.max(1, cell + gap) || CRAFT_GRID_FALLBACK_STEP;
  return { cell, gap, step };
}

function clampCraftViewportToVisibleNode(viewport, workspace, nodes = []) {
  const rect = workspace?.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0 || !nodes.length) return viewport;
  if (nodes.some(node => isCraftNodeVisibleInViewport(node, viewport, workspace))) return viewport;
  let nearestAdjustment = null;
  for (const node of nodes) {
    const nodeRect = getCraftNodeScreenRect(node, viewport, workspace);
    const dx = getCraftNodeContainmentDelta(nodeRect.left, nodeRect.right, rect.width);
    const dy = getCraftNodeContainmentDelta(nodeRect.top, nodeRect.bottom, rect.height);
    const distance = Math.hypot(dx, dy);
    if (!nearestAdjustment || distance < nearestAdjustment.distance) {
      nearestAdjustment = { dx, dy, distance };
    }
  }
  if (!nearestAdjustment) return viewport;
  return normalizeCraftViewport({
    ...viewport,
    x: viewport.x + nearestAdjustment.dx,
    y: viewport.y + nearestAdjustment.dy
  });
}

function isCraftNodeVisibleInViewport(node, viewport, workspace) {
  const workspaceRect = workspace?.getBoundingClientRect();
  if (!workspaceRect || workspaceRect.width <= 0 || workspaceRect.height <= 0) return true;
  const nodeRect = getCraftNodeScreenRect(node, viewport, workspace);
  return nodeRect.left >= 0
    && nodeRect.right <= workspaceRect.width
    && nodeRect.top >= 0
    && nodeRect.bottom <= workspaceRect.height;
}

function getCraftNodeContainmentDelta(start, end, size) {
  const nodeSize = end - start;
  if (nodeSize > size) return (size / 2) - ((start + end) / 2);
  if (start < 0) return -start;
  if (end > size) return size - end;
  return 0;
}

function getCraftNodeScreenRect(node, viewport, workspace) {
  const metrics = getCraftGridMetrics(workspace);
  const width = Math.max(1, toInteger(node.width) || 1);
  const height = Math.max(1, toInteger(node.height) || 1);
  const widthPx = (width * metrics.cell) + ((width - 1) * metrics.gap);
  const heightPx = (height * metrics.cell) + ((height - 1) * metrics.gap);
  const centerX = ((Number(node.x) || 0) * metrics.step);
  const centerY = ((Number(node.y) || 0) * metrics.step);
  const workspaceRect = workspace.getBoundingClientRect();
  const zoom = clampCraftZoom(viewport.zoom);
  const screenCenterX = (workspaceRect.width / 2) + viewport.x + (centerX * zoom);
  const screenCenterY = (workspaceRect.height / 2) + viewport.y + (centerY * zoom);
  const halfWidth = (widthPx * zoom) / 2;
  const halfHeight = (heightPx * zoom) / 2;
  return {
    left: screenCenterX - halfWidth,
    right: screenCenterX + halfWidth,
    top: screenCenterY - halfHeight,
    bottom: screenCenterY + halfHeight
  };
}

function parseCssLength(value, element) {
  const raw = String(value ?? "").trim();
  const numeric = Number.parseFloat(raw);
  if (!Number.isFinite(numeric)) return 0;
  if (raw.endsWith("rem")) return numeric * (Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
  if (raw.endsWith("em")) return numeric * (Number.parseFloat(getComputedStyle(element).fontSize) || 16);
  return numeric;
}

function getCraftConnectorGeometry(fromElement, toElement, svg, bend = null, anchors = null) {
  const from = getElementRectRelativeToSvg(fromElement, svg);
  const to = getElementRectRelativeToSvg(toElement, svg);
  if (!from || !to) return null;
  return buildCraftConnectorGeometry(from, to, bend, anchors);
}

function getCraftConnectorGeometryToPoint(fromElement, event, svg) {
  const from = getElementRectRelativeToSvg(fromElement, svg);
  const point = getCraftSvgPointFromEvent(event, svg);
  const to = {
    left: point.x,
    right: point.x,
    top: point.y,
    bottom: point.y,
    width: 1,
    height: 1
  };
  if (!from) return null;
  return buildCraftConnectorGeometry(from, to, null, {
    from: anchorToData(getCraftResolvedAnchor(from, null, point))
  });
}

function getCraftAttachPreviewGeometry(fromElement, toElement, svg, event) {
  const from = getElementRectRelativeToSvg(fromElement, svg);
  const to = getElementRectRelativeToSvg(toElement, svg);
  const point = getCraftSvgPointFromEvent(event, svg);
  if (!from || !to) return null;
  return buildCraftConnectorGeometry(from, to, null, {
    from: anchorToData(getCraftResolvedAnchor(from, null, getRectCenter(to))),
    to: anchorToData(getCraftSnapAnchor(to, point, getRectCenter(from)))
  });
}

function getCraftAttachTarget(workspace, event, sourceNodeId) {
  const pointElement = document.elementFromPoint(event.clientX, event.clientY)?.closest?.("[data-craft-node-id]");
  if (pointElement && workspace.contains(pointElement) && pointElement.dataset.craftNodeId !== sourceNodeId) return pointElement;
  let nearest = null;
  let nearestDistance = 34;
  for (const node of workspace.querySelectorAll("[data-craft-node-id]")) {
    if (node.dataset.craftNodeId === sourceNodeId) continue;
    const rect = node.getBoundingClientRect();
    const distance = getPointToDomRectDistance(event.clientX, event.clientY, rect);
    if (distance < nearestDistance) {
      nearest = node;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function getPointToDomRectDistance(x, y, rect) {
  const dx = Math.max(rect.left - x, 0, x - rect.right);
  const dy = Math.max(rect.top - y, 0, y - rect.bottom);
  return Math.hypot(dx, dy);
}

function getCraftSvgPointFromEvent(event, svg) {
  const svgRect = svg.getBoundingClientRect();
  const zoom = getCraftSvgZoom(svg);
  return {
    x: (event.clientX - svgRect.left) / zoom,
    y: (event.clientY - svgRect.top) / zoom
  };
}

function getElementRectRelativeToSvg(element, svg) {
  if (!element || !svg) return null;
  const rect = element.getBoundingClientRect();
  const svgRect = svg.getBoundingClientRect();
  const zoom = getCraftSvgZoom(svg);
  return {
    left: (rect.left - svgRect.left) / zoom,
    right: (rect.right - svgRect.left) / zoom,
    top: (rect.top - svgRect.top) / zoom,
    bottom: (rect.bottom - svgRect.top) / zoom,
    width: rect.width / zoom,
    height: rect.height / zoom
  };
}

function getCraftSvgZoom(svg) {
  const workspace = svg?.closest?.("[data-craft-workspace]");
  const zoom = Number.parseFloat(getComputedStyle(workspace ?? svg).getPropertyValue("--craft-zoom"));
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

function getRawCraftLinkBend(link) {
  const x = toOptionalNumber(link.bendX);
  const y = toOptionalNumber(link.bendY);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function getCraftLinkBend(link, svg = null) {
  const bend = getRawCraftLinkBend(link);
  if (!bend) return null;
  if (!svg || isLegacyCraftBend(link)) return bend;
  return craftStoredBendToSvgPoint(svg, bend);
}

function isLegacyCraftBend(link) {
  const bend = getRawCraftLinkBend(link);
  if (!bend) return false;
  return Math.max(Math.abs(bend.x), Math.abs(bend.y)) > CRAFT_LEGACY_BEND_PIXEL_THRESHOLD;
}

function craftStoredBendToSvgPoint(svg, bend) {
  const center = getCraftSvgLocalCenter(svg);
  const metrics = getCraftGridMetrics(svg?.closest?.("[data-craft-workspace]"));
  return {
    x: center.x + (bend.x * metrics.step),
    y: center.y + (bend.y * metrics.step)
  };
}

function craftSvgPointToStoredBend(svg, point) {
  const center = getCraftSvgLocalCenter(svg);
  const metrics = getCraftGridMetrics(svg?.closest?.("[data-craft-workspace]"));
  return {
    bendX: roundCraftBendCoordinate((Number(point?.x) || 0) - center.x, metrics.step),
    bendY: roundCraftBendCoordinate((Number(point?.y) || 0) - center.y, metrics.step)
  };
}

function roundCraftBendCoordinate(value, step) {
  const normalizedStep = Math.max(1, Number(step) || CRAFT_GRID_FALLBACK_STEP);
  return Math.round((value / normalizedStep) * 1000) / 1000;
}

function getCraftSvgLocalCenter(svg) {
  const rect = svg?.getBoundingClientRect?.();
  const zoom = getCraftSvgZoom(svg);
  const width = rect?.width ? rect.width / zoom : 0;
  const height = rect?.height ? rect.height / zoom : 0;
  return {
    x: width / 2,
    y: height / 2
  };
}

function buildCraftConnectorGeometry(from, to, bend = null, anchors = null) {
  const fromCenter = getRectCenter(from);
  const toCenter = getRectCenter(to);
  let startAnchor;
  let endAnchor;
  let path;
  if (bend) {
    startAnchor = getCraftResolvedAnchor(from, anchors?.from, bend);
    endAnchor = getCraftResolvedAnchor(to, anchors?.to, bend);
    path = buildBentTubeCenterPath(startAnchor, bend, endAnchor);
  } else {
    startAnchor = getCraftResolvedAnchor(from, anchors?.from, toCenter);
    endAnchor = getCraftResolvedAnchor(to, anchors?.to, fromCenter);
    path = buildDefaultTubeCenterPath(startAnchor, endAnchor);
  }
  return {
    centerPath: path,
    start: {
      ...startAnchor.tubePoint,
      socketPath: buildCraftSocketPath(startAnchor)
    },
    end: {
      ...endAnchor.tubePoint,
      socketPath: buildCraftSocketPath(endAnchor)
    }
  };
}

function buildDefaultTubeCenterPath(startAnchor, endAnchor) {
  const start = startAnchor.tubePoint;
  const end = endAnchor.tubePoint;
  const distance = Math.max(1, getPointDistance(start, end));
  const direction = normalizeVector({ x: end.x - start.x, y: end.y - start.y });
  const baseHandle = Math.min(120, distance * 0.34);
  const startHandle = baseHandle * Math.max(0, dotVector(startAnchor.normal, direction));
  const endHandle = baseHandle * Math.max(0, dotVector(endAnchor.normal, { x: -direction.x, y: -direction.y }));
  const c1 = addScaledVector(start, startAnchor.normal, startHandle);
  const c2 = addScaledVector(end, endAnchor.normal, endHandle);
  return `M ${formatPoint(start)} C ${formatPoint(c1)} ${formatPoint(c2)} ${formatPoint(end)}`;
}

function buildBentTubeCenterPath(startAnchor, bend, endAnchor) {
  const start = startAnchor.tubePoint;
  const end = endAnchor.tubePoint;
  if (isPointNearSegment(bend, start, end, 10)) return buildDefaultTubeCenterPath(startAnchor, endAnchor);
  const startDistance = getPointDistance(start, bend);
  const endDistance = getPointDistance(end, bend);
  const startDirection = normalizeVector({ x: bend.x - start.x, y: bend.y - start.y });
  const endDirection = normalizeVector({ x: end.x - bend.x, y: end.y - bend.y });
  const startHandle = Math.min(100, startDistance * 0.34) * Math.max(0, dotVector(startAnchor.normal, startDirection));
  const endHandle = Math.min(100, endDistance * 0.34) * Math.max(0, dotVector(endAnchor.normal, { x: -endDirection.x, y: -endDirection.y }));
  const bendTangent = getBendTangent(start, bend, end);
  const bendHandleA = Math.min(90, startDistance * 0.28);
  const bendHandleB = Math.min(90, endDistance * 0.28);
  const c1 = addScaledVector(start, startAnchor.normal, startHandle);
  const c2 = addScaledVector(bend, bendTangent, -bendHandleA);
  const c3 = addScaledVector(bend, bendTangent, bendHandleB);
  const c4 = addScaledVector(end, endAnchor.normal, endHandle);
  return `M ${formatPoint(start)} C ${formatPoint(c1)} ${formatPoint(c2)} ${formatPoint(bend)} C ${formatPoint(c3)} ${formatPoint(c4)} ${formatPoint(end)}`;
}

function getRectAnchor(rect, toward) {
  const center = getRectCenter(rect);
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  if (!dx && !dy) {
    const normal = { x: 0, y: 1 };
    return {
      side: "bottom",
      offset: 0.5,
      point: center,
      tubePoint: addScaledVector(center, normal, CRAFT_SOCKET_DEPTH_PX),
      normal,
      tangent: { x: 1, y: 0 }
    };
  }
  const halfWidth = Math.max(1, rect.width / 2);
  const halfHeight = Math.max(1, rect.height / 2);
  const socketHalfWidth = CRAFT_SOCKET_HALF_WIDTH_PX;
  let point;
  let normal;
  let side;
  let offset;
  if (Math.abs(dx / halfWidth) > Math.abs(dy / halfHeight)) {
    const sign = Math.sign(dx) || 1;
    const scale = halfWidth / Math.abs(dx);
    point = {
      x: center.x + (sign * halfWidth),
      y: clampNumber(center.y + (dy * scale), rect.top + socketHalfWidth, rect.bottom - socketHalfWidth)
    };
    side = sign < 0 ? "left" : "right";
    offset = (point.y - rect.top) / Math.max(1, rect.height);
    normal = { x: sign, y: 0 };
  } else {
    const sign = Math.sign(dy) || 1;
    const scale = halfHeight / Math.abs(dy);
    point = {
      x: clampNumber(center.x + (dx * scale), rect.left + socketHalfWidth, rect.right - socketHalfWidth),
      y: center.y + (sign * halfHeight)
    };
    side = sign < 0 ? "top" : "bottom";
    offset = (point.x - rect.left) / Math.max(1, rect.width);
    normal = { x: 0, y: sign };
  }
  return {
    side,
    offset: clampNumber(offset, 0, 1),
    point,
    tubePoint: addScaledVector(point, normal, CRAFT_SOCKET_DEPTH_PX),
    normal,
    tangent: { x: -normal.y, y: normal.x }
  };
}

function getNearestRectAnchor(rect, point) {
  const distances = [
    { side: "left", value: Math.abs(point.x - rect.left) },
    { side: "right", value: Math.abs(point.x - rect.right) },
    { side: "top", value: Math.abs(point.y - rect.top) },
    { side: "bottom", value: Math.abs(point.y - rect.bottom) }
  ].sort((a, b) => a.value - b.value);
  const side = distances[0]?.side ?? "bottom";
  const offset = side === "left" || side === "right"
    ? (point.y - rect.top) / Math.max(1, rect.height)
    : (point.x - rect.left) / Math.max(1, rect.width);
  return getRectAnchorFromData(rect, { side, offset });
}

function getCraftSnapAnchor(rect, point, fallbackToward) {
  return isPointInsideRect(point, rect)
    ? getRectAnchor(rect, fallbackToward)
    : getNearestRectAnchor(rect, point);
}

function isPointInsideRect(point, rect) {
  return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
}

function getCraftResolvedAnchor(rect, anchor, fallbackToward) {
  return anchor?.side ? getRectAnchorFromData(rect, anchor) : getRectAnchor(rect, fallbackToward);
}

function getRectAnchorFromData(rect, anchor) {
  const side = normalizeCraftAnchorSide(anchor?.side) || "bottom";
  const rawOffset = Number(anchor?.offset);
  const offset = Number.isFinite(rawOffset) ? clampNumber(rawOffset, 0, 1) : 0.5;
  const socketHalfWidth = CRAFT_SOCKET_HALF_WIDTH_PX;
  let point;
  let normal;
  if (side === "left" || side === "right") {
    const sign = side === "left" ? -1 : 1;
    point = {
      x: sign < 0 ? rect.left : rect.right,
      y: clampNumber(rect.top + (rect.height * offset), rect.top + socketHalfWidth, rect.bottom - socketHalfWidth)
    };
    normal = { x: sign, y: 0 };
  } else {
    const sign = side === "top" ? -1 : 1;
    point = {
      x: clampNumber(rect.left + (rect.width * offset), rect.left + socketHalfWidth, rect.right - socketHalfWidth),
      y: sign < 0 ? rect.top : rect.bottom
    };
    normal = { x: 0, y: sign };
  }
  return {
    side,
    offset,
    point,
    tubePoint: addScaledVector(point, normal, CRAFT_SOCKET_DEPTH_PX),
    normal,
    tangent: { x: -normal.y, y: normal.x }
  };
}

function anchorToData(anchor) {
  const offset = toOptionalNumber(anchor?.offset);
  return {
    side: normalizeCraftAnchorSide(anchor?.side),
    offset: Number.isFinite(offset) ? clampNumber(offset, 0, 1) : null
  };
}

function getCraftLinkAnchor(link, role) {
  const offset = toOptionalNumber(link?.[`${role}AnchorOffset`]);
  return {
    side: normalizeCraftAnchorSide(link?.[`${role}AnchorSide`]),
    offset: Number.isFinite(offset) ? clampNumber(offset, 0, 1) : null
  };
}

function getCraftLinkAnchors(link) {
  return {
    from: getCraftLinkAnchor(link, "from"),
    to: getCraftLinkAnchor(link, "to")
  };
}

function buildCraftAnchorUpdateData(anchors = {}) {
  const fromOffset = toOptionalNumber(anchors.from?.offset);
  const toOffset = toOptionalNumber(anchors.to?.offset);
  return {
    fromAnchorSide: normalizeCraftAnchorSide(anchors.from?.side),
    fromAnchorOffset: Number.isFinite(fromOffset) ? clampNumber(fromOffset, 0, 1) : null,
    toAnchorSide: normalizeCraftAnchorSide(anchors.to?.side),
    toAnchorOffset: Number.isFinite(toOffset) ? clampNumber(toOffset, 0, 1) : null
  };
}

function normalizeCraftAnchorSide(side) {
  const value = String(side ?? "");
  return ["left", "right", "top", "bottom"].includes(value) ? value : "";
}

function buildCraftSocketPath(anchor) {
  const halfWidth = CRAFT_SOCKET_HALF_WIDTH_PX;
  const inset = 0.5;
  const outer = addScaledVector(anchor.point, anchor.normal, CRAFT_SOCKET_DEPTH_PX);
  const inner = addScaledVector(anchor.point, anchor.normal, inset);
  const corners = [
    addScaledVector(inner, anchor.tangent, -halfWidth),
    addScaledVector(inner, anchor.tangent, halfWidth),
    addScaledVector(outer, anchor.tangent, halfWidth),
    addScaledVector(outer, anchor.tangent, -halfWidth)
  ];
  return `M ${formatPoint(corners[0])} L ${formatPoint(corners[1])} L ${formatPoint(corners[2])} L ${formatPoint(corners[3])} Z`;
}

function getBendTangent(start, bend, end) {
  const incoming = normalizeVector({ x: bend.x - start.x, y: bend.y - start.y });
  const outgoing = normalizeVector({ x: end.x - bend.x, y: end.y - bend.y });
  const tangent = normalizeVector({ x: incoming.x + outgoing.x, y: incoming.y + outgoing.y });
  if (tangent.x || tangent.y) return tangent;
  return normalizeVector({ x: end.x - start.x, y: end.y - start.y });
}

function normalizeVector(vector) {
  const length = Math.hypot(vector.x, vector.y);
  if (length < 0.0001) return { x: 0, y: 0 };
  return { x: vector.x / length, y: vector.y / length };
}

function dotVector(a, b) {
  return (a.x * b.x) + (a.y * b.y);
}

function getPointDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function isPointNearSegment(point, start, end, threshold) {
  return getPointToSegmentDistance(point, start, end) <= threshold;
}

function getPointToSegmentDistance(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = (dx * dx) + (dy * dy);
  if (lengthSquared < 0.0001) return getPointDistance(point, start);
  const t = clampNumber(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, 0, 1);
  const projection = {
    x: start.x + (dx * t),
    y: start.y + (dy * t)
  };
  return getPointDistance(point, projection);
}

function addScaledVector(point, vector, scale) {
  return {
    x: point.x + (vector.x * scale),
    y: point.y + (vector.y * scale)
  };
}

function addVectors(a, b) {
  return {
    x: a.x + b.x,
    y: a.y + b.y
  };
}

function clampNumber(value, min, max) {
  if (min > max) return (min + max) / 2;
  return Math.max(min, Math.min(max, value));
}

function formatPoint(point) {
  return `${roundPathNumber(point.x)} ${roundPathNumber(point.y)}`;
}

function getRectCenter(rect) {
  return {
    x: rect.left + (rect.width / 2),
    y: rect.top + (rect.height / 2)
  };
}

function getRectEdgePoint(rect, toward) {
  const center = getRectCenter(rect);
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  if (!dx && !dy) return center;
  const halfWidth = Math.max(1, rect.width / 2);
  const halfHeight = Math.max(1, rect.height / 2);
  const scale = Math.min(
    dx ? Math.abs(halfWidth / dx) : Number.POSITIVE_INFINITY,
    dy ? Math.abs(halfHeight / dy) : Number.POSITIVE_INFINITY
  );
  return {
    x: center.x + (dx * scale),
    y: center.y + (dy * scale)
  };
}

function roundPathNumber(value) {
  return Number(value).toFixed(2).replace(/\.?0+$/, "");
}

function getWeaponFunctionSection(element) {
  return element?.closest?.("[data-weapon-function-section]") ?? null;
}

function getWeaponFunctionPath(section) {
  return String(section?.dataset?.weaponFunctionPath ?? "") || "system.functions.weapon";
}

function getAdditionalWeaponFunctionEntries(item) {
  const additionalWeapons = item?.system?.functions?.additionalWeapons;
  return getWeaponFunctionEntries(additionalWeapons);
}

function getModuleWeaponFunctionEntries(item) {
  const moduleWeapons = item?.system?.functions?.module?.additionalWeapons;
  return getWeaponFunctionEntries(moduleWeapons);
}

function getWeaponFunctionEntries(additionalWeapons) {
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

function buildFirstAidEffectRows(item) {
  return (item.system?.functions?.firstAid?.changes ?? []).map((change, index) => ({
    index,
    key: String(change?.key ?? ""),
    type: String(change?.type ?? "add"),
    value: String(change?.value ?? "0"),
    priority: change?.priority ?? "",
    typeChoices: buildFirstAidEffectTypeChoices(change?.type)
  }));
}

function buildFirstAidNeedRows(item) {
  const settings = getNeedSettings();
  const source = Array.isArray(item.system?.functions?.firstAid?.needs)
    ? item.system.functions.firstAid.needs
    : Object.entries(item.system?.functions?.firstAid?.needs ?? {}).map(([needKey, value]) => ({ needKey, value }));
  return source.map((entry, index) => ({
    index,
    needKey: String(entry?.needKey ?? ""),
    value: toInteger(entry?.value),
    choices: settings.map(entry => ({
      value: entry.key,
      label: entry.label || entry.key,
      selected: entry.key === String(source[index]?.needKey ?? "")
    }))
  }));
}

function buildFirstAidEffectTypeChoices(selected = "add") {
  const value = String(selected ?? "add");
  return [
    { value: "add", label: game.i18n.localize("FALLOUTMAW.Effects.ChangeAdd") },
    { value: "multiply", label: game.i18n.localize("FALLOUTMAW.Effects.ChangeMultiply") },
    { value: "override", label: game.i18n.localize("FALLOUTMAW.Effects.ChangeOverride") }
  ].map(choice => ({
    ...choice,
    selected: choice.value === value
  }));
}

function normalizePercentInput(value) {
  return Math.max(0, Math.min(100, Math.trunc(Number(value) || 0)));
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Math.trunc(Number(value) || 0)));
}

function normalizeWeaponDamageTypeRows(weaponData = {}, damageTypeSettings = [], sourceWeaponData = null) {
  const validKeys = new Set(getConfigurableDamageTypes(damageTypeSettings).map(type => type.key));
  const configuredFallback = String(weaponData?.damageTypeKey ?? "").trim();
  const fallbackKey = validKeys.has(configuredFallback)
    ? configuredFallback
    : damageTypeSettings.at(0)?.key ?? "firearm";
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

function getConfigurableDamageTypes(damageTypeSettings = []) {
  return damageTypeSettings.filter(damageType => !damageType?.locked && !damageType?.system);
}

function readDamageSourceVolleyRegionDamageRows(root) {
  const rows = Array.from(root?.querySelectorAll("[data-damage-source-volley-region-damage-row]") ?? []);
  return normalizeVolleyRegionDamageEntries(rows.map(row => ({
    damageTypeKey: String(row.querySelector("[data-damage-source-volley-region-damage-type]")?.value ?? "").trim(),
    amount: Math.max(0, toInteger(row.querySelector("[data-damage-source-volley-region-damage-amount]")?.value))
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
  const mode = String(item.system?.functions?.damageMitigation?.mode || DAMAGE_MITIGATION_MODES.defense);
  return [
    {
      value: DAMAGE_MITIGATION_MODES.defense,
      label: game.i18n.localize("FALLOUTMAW.Item.MitigationModeDefense"),
      selected: mode === DAMAGE_MITIGATION_MODES.defense
    },
    {
      value: DAMAGE_MITIGATION_MODES.resistance,
      label: game.i18n.localize("FALLOUTMAW.Item.MitigationModeResistance"),
      selected: mode === DAMAGE_MITIGATION_MODES.resistance
    }
  ];
}
