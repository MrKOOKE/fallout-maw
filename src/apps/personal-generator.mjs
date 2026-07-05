import { SYSTEM_ID, TEMPLATES } from "../constants.mjs";
import { getCreatureOptions, getCurrencySettings } from "../settings/accessors.mjs";
import {
  PERSONAL_GENERATOR_PRESETS_SETTING,
  PERSONAL_NAME_RANDOMIZER_SETTING
} from "../settings/constants.mjs";
import { getBaselineDefault } from "../settings/baseline.mjs";
import {
  canUseWeaponSlotForItem,
  getEquipmentSlotSelectionKey,
  getRaceEquipmentSlotsForItem,
  getRequiredEquipmentSlotsForItem,
  getRequiredWeaponSlotsForItem,
  getWeaponSlotRequirement,
  getWeaponSlotRequirementSize,
  isContainerWeaponSetKey
} from "../utils/equipment-slots.mjs";
import {
  ROOT_CONTAINER_ID,
  createAnchoredItemStackPartsForQuantity,
  createInventoryPlacement,
  createItemStackPartAdditionUpdate,
  createStoredPlacement,
  findFirstAvailableInventoryPlacement,
  getContainerContentsWeight,
  getContainerInventoryGridOptions,
  getContainerMaxLoad,
  getContextInventoryItems,
  getItemMaxStack,
  getItemQuantity,
  getItemTotalWeight,
  hasContainerCycle,
  isContainerItem,
  usesVirtualInventoryStacks,
  validateInventoryTree
} from "../utils/inventory-containers.mjs";
import { getActorInventoryGridDimensions, getActorRootInventoryGridOptions, normalizeImagePath } from "../utils/actor-display-data.mjs";
import { ITEM_FUNCTIONS, hasItemFunction } from "../utils/item-functions.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { resolveWorldItemSync } from "../utils/world-items.mjs";
import { FalloutMaWFormApplicationV2 } from "./base-form-application-v2.mjs";
import { canStackItems } from "./search-inventory.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const BaseFilePicker = foundry.applications.apps.FilePicker.implementation;

const DEFAULT_NAME_BLOCK_IDS = Object.freeze({
  male: "default-male-names",
  female: "default-female-names",
  commonSurname: "default-surnames-common",
  nobleSurname: "default-surnames-noble"
});

const DEFAULT_NAME_BLOCKS = Object.freeze([
  { id: DEFAULT_NAME_BLOCK_IDS.male, name: "Мужские имена", namesText: "Аарон, Адам, Артур, Виктор, Даниил, Илья, Максим, Роман" },
  { id: DEFAULT_NAME_BLOCK_IDS.female, name: "Женские имена", namesText: "Анна, Алиса, Виктория, Дарья, Елена, Ирина, Мария, София" },
  { id: DEFAULT_NAME_BLOCK_IDS.commonSurname, name: "Простые фамилии", namesText: "Смит, Браун, Миллер, Уилсон, Кларк, Уокер, Холл, Янг" },
  { id: DEFAULT_NAME_BLOCK_IDS.nobleSurname, name: "Знатные фамилии", namesText: "Блэквуд, Фэрфакс, Уиндзор, Кавендиш, Монтгомери, Равенскрофт" }
]);

const PERSONAL_GENERATOR_DEFAULTS = Object.freeze({
  enabled: false,
  name: {
    enabled: true,
    appendToTokenName: true,
    overwriteBaseName: false,
    firstNameBlockId: DEFAULT_NAME_BLOCK_IDS.male,
    surnameBlockId: DEFAULT_NAME_BLOCK_IDS.commonSurname,
    useSurname: true,
    countPreview: 10
  },
  currency: {
    enabled: false,
    mode: "add",
    ranges: {}
  },
  images: {
    enabled: false,
    includeCurrent: true,
    paths: []
  },
  items: {
    enabled: false,
    blocks: []
  }
});

let personalGeneratorWindow = null;

export function registerPersonalGeneratorSettings() {
  game.settings.register(SYSTEM_ID, PERSONAL_NAME_RANDOMIZER_SETTING, {
    name: "Настройки персонального генератора",
    scope: "world",
    config: false,
    type: Object,
    default: getBaselineDefault(PERSONAL_NAME_RANDOMIZER_SETTING, { blocks: DEFAULT_NAME_BLOCKS.map(block => ({ ...block })) })
  });

  game.settings.register(SYSTEM_ID, PERSONAL_GENERATOR_PRESETS_SETTING, {
    name: "Пресеты персонального генератора",
    scope: "world",
    config: false,
    type: Object,
    default: getBaselineDefault(PERSONAL_GENERATOR_PRESETS_SETTING, {})
  });
}

export function registerPersonalGeneratorHooks() {
  Hooks.on("getActorContextOptions", (app, entryOptions) => {
    entryOptions.unshift(
      {
        label: game.i18n.localize("FALLOUTMAW.Actor.PersonalGenerator"),
        icon: "fa-solid fa-user-gear",
        visible: li => getActorFromDirectoryEntry(app, li)?.isOwner === true,
        onClick: (_event, li) => openPersonalGenerator(getActorFromDirectoryEntry(app, li))
      },
      {
        label: "Прототип токена",
        icon: "fa-solid fa-circle-user",
        visible: li => canConfigurePrototypeToken(getActorFromDirectoryEntry(app, li)),
        onClick: (_event, li) => openPrototypeTokenConfig(getActorFromDirectoryEntry(app, li))
      }
    );
  });

  Hooks.on("preCreateToken", (document, data, _options, userId) => {
    if (game.user?.id && userId && game.user.id !== userId) return undefined;
    return preparePersonalGeneratorToken(document, data);
  });

  Hooks.on("createToken", (document, _options, userId) => {
    if (game.user?.id && userId && game.user.id !== userId) return undefined;
    return finalizePersonalGeneratorToken(document);
  });
}

export function openPersonalGenerator(actor) {
  if (!actor) return undefined;
  personalGeneratorWindow ??= new PersonalGeneratorApplication();
  personalGeneratorWindow.setActor(actor);
  return personalGeneratorWindow.render({ force: true });
}

function openPrototypeTokenConfig(actor, renderOptions = {}) {
  if (!actor || !canConfigurePrototypeToken(actor)) return undefined;
  return new CONFIG.Token.prototypeSheetClass({ prototype: actor.prototypeToken }).render({
    force: true,
    ...renderOptions
  });
}

function canConfigurePrototypeToken(actor) {
  return !!actor && ((game.user?.isGM === true) || ((actor.isOwner === true) && (game.user?.can("TOKEN_CONFIGURE") === true)));
}

function getActorFromDirectoryEntry(app, li) {
  const entry = li?.closest?.("[data-entry-id]") ?? li;
  const actorId = entry?.dataset?.entryId ?? entry?.dataset?.documentId ?? "";
  return app?.collection?.get?.(actorId) ?? game.actors?.get?.(actorId) ?? null;
}

export class PersonalNameRandomizerConfig extends FalloutMaWFormApplicationV2 {
  constructor(options = {}) {
    super(options);
    this.blocks = getPersonalNameBlocks();
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-personal-name-randomizer",
    classes: ["fallout-maw", "fallout-maw-config-form", "fallout-maw-personal-name-randomizer"],
    position: { width: 760, height: "auto" },
    form: {
      closeOnSubmit: true
    },
    actions: {
      createBlock: this.#onCreateBlock,
      deleteBlock: this.#onDeleteBlock,
      resetDefaults: this.#onResetDefaults
    }
  };

  static PARTS = {
    form: { template: TEMPLATES.settings.personalNameRandomizer }
  };

  get title() {
    return "Настройки персонального генератора";
  }

  async _prepareContext(options) {
    return {
      ...(await super._prepareContext(options)),
      blocks: this.blocks
    };
  }

  async _processFormData() {
    this.blocks = this.#readBlocksFromForm();
    await game.settings.set(SYSTEM_ID, PERSONAL_NAME_RANDOMIZER_SETTING, { blocks: this.blocks });
    ui.notifications.info("Настройки персонального генератора сохранены.");
    return this.forceRender();
  }

  static #onCreateBlock(event) {
    event.preventDefault();
    this.blocks = this.#readBlocksFromForm();
    this.blocks.push({
      id: getUniqueId("name-block", this.blocks.map(block => block.id)),
      name: "Новый блок",
      namesText: ""
    });
    return this.forceRender();
  }

  static #onDeleteBlock(event, target) {
    event.preventDefault();
    const rows = Array.from(this.form?.querySelectorAll("[data-name-block-row]") ?? []);
    const index = rows.indexOf(target.closest("[data-name-block-row]"));
    if (index < 0) return undefined;
    this.blocks = this.#readBlocksFromForm();
    this.blocks.splice(index, 1);
    return this.forceRender();
  }

  static async #onResetDefaults(event) {
    event.preventDefault();
    await game.settings.set(SYSTEM_ID, PERSONAL_NAME_RANDOMIZER_SETTING, { blocks: DEFAULT_NAME_BLOCKS.map(block => ({ ...block })) });
    this.blocks = getPersonalNameBlocks();
    return this.forceRender();
  }

  #readBlocksFromForm() {
    return Array.from(this.form?.querySelectorAll("[data-name-block-row]") ?? [])
      .map(row => ({
        id: String(row.querySelector("[data-field='id']")?.value ?? "").trim(),
        name: String(row.querySelector("[data-field='name']")?.value ?? "").trim(),
        namesText: String(row.querySelector("[data-field='namesText']")?.value ?? "").trim()
      }))
      .filter(block => block.id && block.name);
  }
}

class PersonalGeneratorApplication extends HandlebarsApplicationMixin(ApplicationV2) {
  #actorUuid = "";
  #actor = null;
  #config = createPersonalGeneratorConfig();
  #dragDrop = null;
  #autosaveTimeout = null;
  #saveChain = Promise.resolve();
  #chainSource = null;
  #chainOverlay = null;
  #chainLine = null;
  #chainMoveHandler = null;
  #chainMouseDownHandler = null;
  #chainKeyHandler = null;
  #modifierKeyHandler = null;

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-personal-generator",
    classes: ["fallout-maw", "fallout-maw-sheet", "fallout-maw-personal-generator"],
    tag: "form",
    position: { width: 920 },
    window: { resizable: true },
    form: {
      handler: PersonalGeneratorApplication.#handleFormSubmit,
      submitOnChange: false,
      closeOnSubmit: false
    },
    actions: {
      createItemBlock: this.#onCreateItemBlock,
      deleteItemBlock: this.#onDeleteItemBlock,
      createItemEntry: this.#onCreateItemEntry,
      deleteItemEntry: this.#onDeleteItemEntry,
      browseImage: this.#onBrowseImage,
      removeImage: this.#onRemoveImage,
      previewNames: this.#onPreviewNames,
      togglePrototypeTokenLink: this.#onTogglePrototypeTokenLink,
      openItemEntry: this.#onOpenItemEntry,
      toggleItemLock: this.#onToggleItemLock,
      chainItemEntry: this.#onChainItemEntry
    }
  };

  static PARTS = {
    body: { template: TEMPLATES.personalGenerator }
  };

  get title() {
    return `Персональный генератор: ${this.#actor?.name ?? ""}`;
  }

  setActor(actor) {
    if (this.rendered && this.#actor && this.#actor.uuid !== actor?.uuid) void this.#saveCurrentConfig({ fromForm: true });
    this.#actorUuid = actor?.uuid ?? "";
    this.#actor = actor ?? null;
    this.#config = getPersonalGeneratorConfig(actor);
  }

  get _dragDrop() {
    return this.#dragDrop ??= new foundry.applications.ux.DragDrop.implementation({
      dragSelector: null,
      dropSelector: "[data-pg-block-drop]",
      permissions: {
        drop: () => true
      },
      callbacks: {
        drop: this.#onDropItem.bind(this)
      }
    });
  }

  async _prepareContext(options) {
    this.#actor = await fromUuid(this.#actorUuid);
    this.#config ??= getPersonalGeneratorConfig(this.#actor);
    return {
      ...(await super._prepareContext(options)),
      actor: this.#actor,
      config: preparePersonalGeneratorContext(this.#config),
      prototypeTokenLink: getPrototypeTokenLinkContext(this.#actor),
      currencyChoices: getCurrencyChoices(this.#config),
      nameBlockChoices: getNameBlockChoices(this.#config),
      pickModeChoices: getPickModeChoices(),
      generatedNamePreview: createNamePreview(this.#config.name)
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this._dragDrop.bind(this.element);
    this.element.addEventListener("input", event => this.#queueAutosaveFromEvent(event, 350));
    this.element.addEventListener("change", event => this.#queueAutosaveFromEvent(event, 0));
    this.element.addEventListener("click", event => this.#onEntryClick(event));
    this.element.addEventListener("dragstart", event => this.#onEntryDragStart(event));
    this.element.addEventListener("dragend", event => this.#onEntryDragEnd(event));
    this.element.addEventListener("dragenter", event => this.#onDropzoneDragEnter(event));
    this.element.addEventListener("dragleave", event => this.#onDropzoneDragLeave(event));
    this.element.addEventListener("dragover", event => this.#onDropzoneDragOver(event));
    this.element.addEventListener("pointerdown", event => this.#onEntryPointerDown(event), true);
    this.element.addEventListener("pointerup", () => this.#restoreEntryDragging(), true);
    this.element.addEventListener("pointercancel", () => this.#restoreEntryDragging(), true);
    if (this.#modifierKeyHandler) {
      document.removeEventListener("keydown", this.#modifierKeyHandler, true);
      document.removeEventListener("keyup", this.#modifierKeyHandler, true);
    }
    this.#modifierKeyHandler = event => this.#onModifierKeyChange(event);
    document.addEventListener("keydown", this.#modifierKeyHandler, true);
    document.addEventListener("keyup", this.#modifierKeyHandler, true);
    this.#syncChainLinkDisplay();
  }

  async close(options) {
    this.#cancelChainLink();
    if (this.#modifierKeyHandler) {
      document.removeEventListener("keydown", this.#modifierKeyHandler, true);
      document.removeEventListener("keyup", this.#modifierKeyHandler, true);
      this.#modifierKeyHandler = null;
    }
    if (this.#autosaveTimeout) {
      window.clearTimeout(this.#autosaveTimeout);
      this.#autosaveTimeout = null;
      await this.#saveCurrentConfig({ fromForm: true });
    }
    await this.#saveChain.catch(error => console.error(error));
    return super.close(options);
  }

  static async #handleFormSubmit(event, form) {
    event.preventDefault();
    return this.#saveCurrentConfig({ fromForm: true });
  }

  static async #onCreateItemBlock(event) {
    event.preventDefault();
    this.#config = this.#readConfigFromForm();
    this.#config.items.blocks.push(createItemBlock());
    await this.#saveCurrentConfig();
    return this.render({ force: true });
  }

  static async #onDeleteItemBlock(event, target) {
    event.preventDefault();
    const blockIndex = getRowIndex(target, "[data-pg-block]");
    if (blockIndex < 0) return undefined;
    this.#config = this.#readConfigFromForm();
    this.#config.items.blocks.splice(blockIndex, 1);
    await this.#saveCurrentConfig();
    return this.render({ force: true });
  }

  static async #onCreateItemEntry(event, target) {
    event.preventDefault();
    const blockIndex = getRowIndex(target, "[data-pg-block]");
    if (blockIndex < 0) return undefined;
    this.#config = this.#readConfigFromForm();
    this.#config.items.blocks[blockIndex]?.entries.push(createItemEntry());
    await this.#saveCurrentConfig();
    return this.render({ force: true });
  }

  static async #onDeleteItemEntry(event, target) {
    event.preventDefault();
    const blockIndex = getRowIndex(target, "[data-pg-block]");
    const entryIndex = getRowIndex(target, "[data-pg-entry]");
    if (blockIndex < 0 || entryIndex < 0) return undefined;
    this.#config = this.#readConfigFromForm();
    this.#config.items.blocks[blockIndex]?.entries.splice(entryIndex, 1);
    await this.#saveCurrentConfig();
    return this.render({ force: true });
  }

  static async #onPreviewNames(event) {
    event.preventDefault();
    this.#config = this.#readConfigFromForm();
    await this.#saveCurrentConfig();
    return this.render({ force: true });
  }

  static async #onBrowseImage(event) {
    event.preventDefault();
    this.#config = this.#readConfigFromForm();
    const current = this.#config.images.paths.at(-1) ?? this.#actor?.img ?? "";
    const picker = new PersonalGeneratorImageFilePicker({
      type: "image",
      current,
      callback: paths => {
        const existing = new Set(this.#config.images.paths);
        const selected = (Array.isArray(paths) ? paths : [paths])
          .map(path => String(path ?? "").trim())
          .filter(path => path && !existing.has(path));
        if (!selected.length) return;
        this.#config.images.paths.push(...selected);
        this.#saveCurrentConfig();
        this.render({ force: true });
      }
    });

    await picker.browse(undefined, { render: false });
    return picker.render({ force: true });
  }

  static async #onRemoveImage(event, target) {
    event.preventDefault();
    const thumbs = Array.from(this.element?.querySelectorAll("[data-pg-image-thumb]") ?? []);
    const index = thumbs.indexOf(target.closest("[data-pg-image-thumb]"));
    if (index < 0) return undefined;
    this.#config = this.#readConfigFromForm();
    this.#config.images.paths.splice(index, 1);
    await this.#saveCurrentConfig();
    return this.render({ force: true });
  }

  static async #onTogglePrototypeTokenLink(event) {
    event.preventDefault();
    if (!this.#actor || !canConfigurePrototypeToken(this.#actor)) return undefined;
    await this.#actor.update({ "prototypeToken.actorLink": !this.#actor.prototypeToken?.actorLink });
    this.#actor = await fromUuid(this.#actorUuid);
    return this.render({ force: true });
  }

  static async #onOpenItemEntry(event, target) {
    event.preventDefault();
    const uuid = target.closest("[data-pg-entry]")?.querySelector("[data-field='uuid']")?.value ?? "";
    const document = resolveWorldItemSync(uuid);
    return document?.sheet?.render?.(true);
  }

  static async #onToggleItemLock(event, target) {
    event.preventDefault();
    const entry = target.closest("[data-pg-entry]");
    const input = entry?.querySelector("[data-field='itemTradeLocked']");
    if (!entry || !input) return undefined;
    const locked = input.value !== "1";
    input.value = locked ? "1" : "0";
    target.classList.toggle("is-locked", locked);
    target.title = locked ? "Скрыт из обыска" : "Участвует в обыске";
    await this.#saveCurrentConfig({ fromForm: true });
    return undefined;
  }

  static async #onChainItemEntry(event, target) {
    event.preventDefault();
    const entry = target.closest("[data-pg-entry]");
    const block = target.closest("[data-pg-block]");
    const blockIndex = getRowIndex(block, "[data-pg-block]");
    const entryIndex = getRowIndex(entry, "[data-pg-entry]");
    if (!entry || blockIndex < 0 || entryIndex < 0) return undefined;

    this.#config = this.#readConfigFromForm();
    const currentEntry = this.#config.items.blocks[blockIndex]?.entries[entryIndex];
    if (!currentEntry) return undefined;

    if ((event.shiftKey || event.altKey) && currentEntry.chain) {
      currentEntry.chain = "";
      normalizeChainsInBlock(this.#config.items.blocks[blockIndex]);
      this.#cancelChainLink();
      await this.#saveCurrentConfig();
      return this.render({ force: true });
    }

    this.#startChainLink({ blockIndex, entryIndex, entryElement: entry, buttonElement: target });
    return undefined;
  }

  async #onDropItem(event) {
    this.#clearDropzoneHighlight(event.target?.closest?.("[data-pg-block-drop]"));
    const internalDrop = this.#getInternalEntryDropData(event);
    if (internalDrop) return this.#moveInternalEntryDrop(event, internalDrop);

    const blockElement = event.target?.closest?.("[data-pg-block]");
    const blockIndex = getRowIndex(blockElement, "[data-pg-block]");
    if (blockIndex < 0) return undefined;

    let item = null;
    try {
      const data = JSON.parse(event.dataTransfer?.getData("text/plain") || "{}");
      if (data?.type !== "Item") return undefined;
      item = resolveWorldItemSync(data.uuid);
    } catch (_error) {
      return undefined;
    }
    if (!item) return undefined;

    this.#config = this.#readConfigFromForm();
    this.#config.items.blocks[blockIndex]?.entries.push(createItemEntryFromItem(item));
    await this.#saveCurrentConfig();
    return this.render({ force: true });
  }

  #onDropzoneDragEnter(event) {
    const dropzone = event.target?.closest?.("[data-pg-block-drop]");
    if (!dropzone || !this.element?.contains(dropzone)) return;
    dropzone.dataset.dragDepth = String((toInteger(dropzone.dataset.dragDepth) || 0) + 1);
    dropzone.classList.add("drag-over");
  }

  #onDropzoneDragLeave(event) {
    const dropzone = event.target?.closest?.("[data-pg-block-drop]");
    if (!dropzone || !this.element?.contains(dropzone)) return;
    const depth = Math.max(0, (toInteger(dropzone.dataset.dragDepth) || 0) - 1);
    dropzone.dataset.dragDepth = String(depth);
    if (!depth) dropzone.classList.remove("drag-over");
  }

  #onDropzoneDragOver(event) {
    const dropzone = event.target?.closest?.("[data-pg-block-drop]");
    if (!dropzone || !this.element?.contains(dropzone)) return;
    event.preventDefault();
    dropzone.classList.add("drag-over");
  }

  #clearDropzoneHighlight(dropzone) {
    if (!dropzone) return;
    dropzone.dataset.dragDepth = "0";
    dropzone.classList.remove("drag-over");
  }

  #onEntryDragStart(event) {
    const entry = event.target?.closest?.("[data-pg-entry]");
    if (!entry) return;
    if (event.target.closest("button") || event.target.matches("input, select, textarea") || entry.draggable === false) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const block = entry.closest("[data-pg-block]");
    const blockIndex = getRowIndex(block, "[data-pg-block]");
    const entryIndex = getRowIndex(entry, "[data-pg-entry]");
    if (blockIndex < 0 || entryIndex < 0) return;
    entry.classList.add("pg-chip-dragging");
    event.dataTransfer?.setData("text/plain", JSON.stringify({
      type: "fallout-maw-personal-generator-entry",
      blockIndex,
      entryIndex,
      copy: event.shiftKey === true
    }));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = event.shiftKey ? "copy" : "move";
  }

  #onEntryDragEnd(event) {
    event.target?.closest?.("[data-pg-entry]")?.classList.remove("pg-chip-dragging");
    this.#restoreEntryDragging();
  }

  #onEntryPointerDown(event) {
    if (!event.target?.closest?.("button, input, select, textarea")) return;
    const entry = event.target.closest("[data-pg-entry]");
    if (!entry) return;
    entry.draggable = false;
  }

  #restoreEntryDragging() {
    for (const entry of this.element?.querySelectorAll("[data-pg-entry]") ?? []) {
      entry.draggable = true;
    }
  }

  #getInternalEntryDropData(event) {
    try {
      const data = JSON.parse(event.dataTransfer?.getData("text/plain") || "{}");
      return data?.type === "fallout-maw-personal-generator-entry" ? data : null;
    } catch (_error) {
      return null;
    }
  }

  async #moveInternalEntryDrop(event, data) {
    event.preventDefault();
    const targetBlock = event.target?.closest?.("[data-pg-block]");
    const targetBlockIndex = getRowIndex(targetBlock, "[data-pg-block]");
    const sourceBlockIndex = toInteger(data.blockIndex);
    const sourceEntryIndex = toInteger(data.entryIndex);
    if (targetBlockIndex < 0 || sourceBlockIndex < 0 || sourceEntryIndex < 0) return undefined;

    this.#config = this.#readConfigFromForm();
    const sourceBlock = this.#config.items.blocks[sourceBlockIndex];
    const target = this.#config.items.blocks[targetBlockIndex];
    const source = sourceBlock?.entries?.[sourceEntryIndex];
    if (!sourceBlock || !target || !source) return undefined;

    const chain = String(source.chain ?? "").trim();
    const moving = chain
      ? sourceBlock.entries.filter(entry => String(entry.chain ?? "").trim() === chain)
      : [source];
    if (!moving.length) return undefined;

    const copied = data.copy === true || event.shiftKey === true;
    const movedEntries = moving.map(entry => copied ? { ...entry } : entry);
    if (copied && chain) {
      const newChain = foundry.utils.randomID();
      for (const entry of movedEntries) entry.chain = newChain;
    }

    if (!copied) {
      const movingSet = new Set(moving);
      sourceBlock.entries = sourceBlock.entries.filter(entry => !movingSet.has(entry));
      normalizeChainsInBlock(sourceBlock);
    }
    target.entries.push(...movedEntries);
    normalizeChainsInBlock(target);
    await this.#saveCurrentConfig();
    return this.render({ force: true });
  }

  #queueAutosaveFromEvent(event, delay) {
    if (!event.target?.matches?.("input, select, textarea")) return;
    this.#queueAutosave(delay);
  }

  async #onEntryClick(event) {
    const entry = event.target?.closest?.("[data-pg-entry]");
    if (!entry || !this.element?.contains(entry)) return;

    const block = entry.closest("[data-pg-block]");
    const blockIndex = getRowIndex(block, "[data-pg-block]");
    const entryIndex = getRowIndex(entry, "[data-pg-entry]");
    if (blockIndex < 0 || entryIndex < 0) return;

    if (this.#chainSource) {
      return;
    }

    if (event.target.closest("button") || event.target.matches("input, select, textarea")) return;

    const input = entry.querySelector("[data-field='equip']");
    if (!input) return;
    const equipped = input.value !== "1";
    input.value = equipped ? "1" : "0";
    entry.classList.toggle("pg-equip-on", equipped);
    await this.#saveCurrentConfig({ fromForm: true });
  }

  #queueAutosave(delay = 350) {
    if (this.#autosaveTimeout) window.clearTimeout(this.#autosaveTimeout);
    this.#autosaveTimeout = window.setTimeout(() => {
      this.#autosaveTimeout = null;
      this.#saveCurrentConfig({ fromForm: true });
    }, delay);
  }

  #saveCurrentConfig({ fromForm = false } = {}) {
    if (!this.#actor) return Promise.resolve();
    const actor = this.#actor;
    const config = fromForm ? this.#readConfigFromForm() : createPersonalGeneratorConfig(this.#config);
    this.#config = config;
    this.#saveChain = this.#saveChain
      .catch(error => console.error(error))
      .then(() => actor.setFlag(SYSTEM_ID, "personalGenerator", config));
    return this.#saveChain;
  }

  #startChainLink({ blockIndex, entryIndex, entryElement, buttonElement }) {
    this.#cancelChainLink();
    this.#chainSource = { blockIndex, entryIndex };
    this.#createChainOverlay(entryElement, buttonElement);
    this.#syncChainLinkDisplay();
  }

  #createChainOverlay(entryElement, buttonElement) {
    const overlay = document.createElement("div");
    overlay.className = "fallout-maw-pg-chain-overlay";
    overlay.innerHTML = `
      <svg width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <filter id="falloutMawPgChainGlow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="2.5" result="blur"/>
            <feMerge>
              <feMergeNode in="blur"/>
              <feMergeNode in="SourceGraphic"/>
            </feMerge>
          </filter>
        </defs>
        <line x1="0" y1="0" x2="0" y2="0" filter="url(#falloutMawPgChainGlow)"/>
      </svg>`;
    document.body.appendChild(overlay);
    this.#chainOverlay = overlay;
    this.#chainLine = overlay.querySelector("line");

    const getStartPoint = () => {
      const source = buttonElement ?? entryElement;
      const rect = source.getBoundingClientRect();
      return { x: rect.left + (rect.width / 2), y: rect.top + (rect.height / 2) };
    };
    const updateLine = (x, y) => {
      const start = getStartPoint();
      this.#chainLine?.setAttribute("x1", String(start.x));
      this.#chainLine?.setAttribute("y1", String(start.y));
      this.#chainLine?.setAttribute("x2", String(x));
      this.#chainLine?.setAttribute("y2", String(y));
    };

    this.#chainMoveHandler = event => updateLine(event.clientX, event.clientY);
    this.#chainMouseDownHandler = event => this.#onChainMouseDown(event);
    this.#chainKeyHandler = event => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.#cancelChainLink();
      }
    };
    document.addEventListener("mousemove", this.#chainMoveHandler, true);
    document.addEventListener("mousedown", this.#chainMouseDownHandler, true);
    document.addEventListener("keydown", this.#chainKeyHandler, true);
    const start = getStartPoint();
    updateLine(start.x, start.y);
  }

  async #onChainMouseDown(event) {
    if (!this.#chainSource) return;
    const preventFollowupClick = clickEvent => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      clickEvent.stopImmediatePropagation();
    };
    document.addEventListener("click", preventFollowupClick, true);
    window.setTimeout(() => document.removeEventListener("click", preventFollowupClick, true), 0);

    const entry = event.target?.closest?.("[data-pg-entry]");
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    if (!entry || !this.element?.contains(entry)) {
      this.#cancelChainLink();
      return;
    }

    const block = entry.closest("[data-pg-block]");
    const blockIndex = getRowIndex(block, "[data-pg-block]");
    const entryIndex = getRowIndex(entry, "[data-pg-entry]");
    const source = this.#chainSource;
    if (blockIndex !== source.blockIndex || entryIndex === source.entryIndex) {
      this.#cancelChainLink();
      return;
    }

    this.#config = this.#readConfigFromForm();
    linkItemEntriesInBlock(this.#config.items.blocks[blockIndex], source.entryIndex, entryIndex);
    this.#cancelChainLink();
    await this.#saveCurrentConfig();
    return this.render({ force: true });
  }

  #cancelChainLink() {
    this.#chainSource = null;
    if (this.#chainMoveHandler) document.removeEventListener("mousemove", this.#chainMoveHandler, true);
    if (this.#chainMouseDownHandler) document.removeEventListener("mousedown", this.#chainMouseDownHandler, true);
    if (this.#chainKeyHandler) document.removeEventListener("keydown", this.#chainKeyHandler, true);
    this.#chainMoveHandler = null;
    this.#chainMouseDownHandler = null;
    this.#chainKeyHandler = null;
    this.#chainOverlay?.remove();
    this.#chainOverlay = null;
    this.#chainLine = null;
    this.#syncChainLinkDisplay();
  }

  #onModifierKeyChange(event) {
    if (event.key !== "Shift" && event.key !== "Alt") return;
    const removeMode = event.shiftKey || event.altKey;
    this.#syncChainRemoveMode(removeMode);
  }

  #syncChainRemoveMode(removeMode) {
    for (const button of this.element?.querySelectorAll(".fallout-maw-pg-chain-button.is-on") ?? []) {
      button.classList.toggle("pg-chain-remove-mode", removeMode);
    }
  }

  #syncChainLinkDisplay() {
    const source = this.#chainSource;
    for (const entry of this.element?.querySelectorAll("[data-pg-entry]") ?? []) {
      const block = entry.closest("[data-pg-block]");
      const blockIndex = getRowIndex(block, "[data-pg-block]");
      const entryIndex = getRowIndex(entry, "[data-pg-entry]");
      const active = !!source && source.blockIndex === blockIndex && source.entryIndex === entryIndex;
      const target = !!source && source.blockIndex === blockIndex && source.entryIndex !== entryIndex;
      entry.classList.toggle("pg-chain-link-source", active);
      entry.classList.toggle("pg-chain-link-target", target);
    }
  }

  #readConfigFromForm() {
    const form = this.element;
    const config = createPersonalGeneratorConfig({
      enabled: getChecked(form, "enabled"),
      name: {
        enabled: getChecked(form, "name.enabled"),
        appendToTokenName: getChecked(form, "name.appendToTokenName"),
        overwriteBaseName: getChecked(form, "name.overwriteBaseName"),
        firstNameBlockId: getValue(form, "name.firstNameBlockId"),
        surnameBlockId: getValue(form, "name.surnameBlockId"),
        useSurname: getChecked(form, "name.useSurname"),
        countPreview: getInteger(form, "name.countPreview", 10)
      },
      currency: {
        enabled: getChecked(form, "currency.enabled"),
        mode: getValue(form, "currency.mode") === "set" ? "set" : "add",
        ranges: readCurrencyRanges(form)
      },
      images: {
        enabled: getChecked(form, "images.enabled"),
        includeCurrent: getChecked(form, "images.includeCurrent"),
        paths: readImagePaths(form)
      },
      items: {
        enabled: getChecked(form, "items.enabled"),
        blocks: readItemBlocks(form)
      }
    });
    return config;
  }
}

class PersonalGeneratorImageFilePicker extends BaseFilePicker {
  #selectedPaths = new Set();
  #selectionAnchorPath = "";

  constructor(options = {}) {
    super({
      ...options,
      type: "image"
    });
    this.#selectedPaths = new Set((Array.isArray(options.selected) ? options.selected : [])
      .map(path => String(path ?? "").trim())
      .filter(Boolean));
    this.#selectionAnchorPath = String(options.current ?? "").trim();
  }

  static get LAST_DISPLAY_MODE() {
    return BaseFilePicker.LAST_DISPLAY_MODE;
  }

  static set LAST_DISPLAY_MODE(value) {
    BaseFilePicker.LAST_DISPLAY_MODE = value;
  }

  static DEFAULT_OPTIONS = {
    id: "file-picker",
    classes: ["fallout-maw-pg-image-picker"],
    actions: {
      pickFile: this.#onPickFile
    },
    form: {
      handler: this.#onSubmit
    }
  };

  get title() {
    return "Добавить изображения";
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#syncSelectionDisplay();
  }

  static #onPickFile(event, pickedRow) {
    event.preventDefault();
    const path = String(pickedRow?.dataset?.path ?? "").trim();
    if (!path) return undefined;

    const additive = event.ctrlKey || event.metaKey;
    const rows = this.#getVisibleFileRows(pickedRow);
    const anchorPath = this.#selectionAnchorPath || this.#getFirstSelectedVisiblePath(rows) || path;
    const range = event.shiftKey
      ? this.#getSelectionRange(rows, anchorPath, path)
      : [];

    if (range.length) {
      if (!additive) this.#selectedPaths.clear();
      for (const row of range) this.#selectedPaths.add(row.dataset.path);
    } else if (additive) {
      if (this.#selectedPaths.has(path)) this.#selectedPaths.delete(path);
      else this.#selectedPaths.add(path);
    } else {
      this.#selectedPaths.clear();
      this.#selectedPaths.add(path);
    }

    if (!event.shiftKey) this.#selectionAnchorPath = path;
    this.#syncSelectionDisplay();
    return undefined;
  }

  static async #onSubmit(event) {
    if (this.options.tileSize) return undefined;
    event.preventDefault();

    const paths = Array.from(this.#selectedPaths);
    if (!paths.length) {
      ui.notifications.error("Выберите хотя бы одно изображение.");
      return undefined;
    }

    if (this.callback) this.callback(paths, this);
    return this.close();
  }

  #getVisibleFileRows(row) {
    return Array.from(row?.closest?.("ul")?.querySelectorAll("li.file[data-path]") ?? [])
      .filter(entry => entry.style.display !== "none");
  }

  #getSelectionRange(rows, startPath, endPath) {
    const start = rows.findIndex(row => row.dataset.path === startPath);
    const end = rows.findIndex(row => row.dataset.path === endPath);
    if ((start < 0) || (end < 0)) return [];
    const [from, to] = start < end ? [start, end] : [end, start];
    return rows.slice(from, to + 1);
  }

  #getFirstSelectedVisiblePath(rows) {
    return rows.find(row => this.#selectedPaths.has(row.dataset.path))?.dataset.path ?? "";
  }

  #syncSelectionDisplay() {
    const form = this.element;
    if (!form) return;

    for (const row of form.querySelectorAll("li.file[data-path]")) {
      row.classList.toggle("picked", this.#selectedPaths.has(row.dataset.path));
    }

    if (form.elements.file) {
      const paths = Array.from(this.#selectedPaths);
      form.elements.file.value = paths.length === 1
        ? paths[0]
        : (paths.length ? `Выбрано: ${paths.length}` : "");
    }
  }
}

async function preparePersonalGeneratorToken(document, data = {}) {
  if (!document) return undefined;
  const actorLink = Object.hasOwn(data ?? {}, "actorLink") ? data.actorLink : document.actorLink;
  if (actorLink) return undefined;

  const actorId = data?.actorId ?? document.actorId;
  const actor = document.actor ?? game.actors?.get(actorId);
  if (!actor) return undefined;

  const config = getPersonalGeneratorConfig(actor);
  if (!config.enabled) return undefined;

  const updates = {};
  const mergeDelta = patch => {
    if (!patch || !Object.keys(patch).length) return;
    const baseDelta = foundry.utils.deepClone(updates.delta ?? data?.delta ?? document._source?.delta ?? document.delta ?? {});
    updates.delta = foundry.utils.mergeObject(baseDelta, patch, { inplace: false, overwrite: true });
  };

  const currentActorName = String(actor.name ?? "").trim();
  const cleanedActorName = currentActorName.replace(/\s*\([^)]*\)/g, "").trim();
  if (cleanedActorName && cleanedActorName !== currentActorName) {
    const deltaPatch = {};
    foundry.utils.setProperty(deltaPatch, "name", cleanedActorName);
    mergeDelta(deltaPatch);
  }

  if (config.name.enabled && config.name.appendToTokenName) {
    const baseName = String(data?.name ?? document.name ?? actor.name ?? "").trim();
    const generated = generatePersonalName(config.name);
    const nextName = config.name.overwriteBaseName
      ? applyNameOverwrite(baseName, generated)
      : applyNameAddition(baseName, generated);
    if (nextName && nextName !== baseName) updates.name = nextName;
  }

  if (config.currency.enabled) {
    const deltaPatch = {};
    for (const [currencyKey, range] of Object.entries(config.currency.ranges ?? {})) {
      const min = toInteger(range?.min);
      const max = toInteger(range?.max);
      if (min === 0 && max === 0) continue;
      const amount = randomIntInclusive(min, max);
      if (!amount) continue;
      const base = Number(foundry.utils.getProperty(actor, `system.currencies.${currencyKey}`)) || 0;
      const value = config.currency.mode === "set" ? amount : base + amount;
      foundry.utils.setProperty(deltaPatch, `system.currencies.${currencyKey}`, Math.max(0, Math.trunc(value)));
    }
    mergeDelta(deltaPatch);
  }

  if (config.images.enabled) {
    const configured = Array.isArray(config.images.paths) ? config.images.paths : [];
    const currentSrc = String(data?.texture?.src ?? document?.texture?.src ?? actor.img ?? "").trim();
    const pool = Array.from(new Set([
      ...configured.map(path => String(path ?? "").trim()).filter(Boolean),
      ...(config.images.includeCurrent && currentSrc ? [currentSrc] : [])
    ]));
    const picked = pickRandom(pool);
    if (picked) {
      foundry.utils.setProperty(updates, "texture.src", picked);
      const deltaPatch = {};
      foundry.utils.setProperty(deltaPatch, "img", picked);
      mergeDelta(deltaPatch);
    }
  }

  if (Object.keys(updates).length) document.updateSource(updates);
  return undefined;
}

async function applyPersonalGeneratorTokenItems(document) {
  if (!document || document.actorLink) return undefined;

  let actor = document.actor;
  if (!actor) {
    await new Promise(resolve => setTimeout(resolve, 0));
    actor = document.actor;
  }
  if (!actor) return undefined;

  const baseActor = document.actorId ? game.actors?.get(document.actorId) : null;
  if (!baseActor) return undefined;

  const config = getPersonalGeneratorConfig(baseActor);
  if (!config.enabled || !config.items.enabled) return undefined;
  if (document.getFlag?.(SYSTEM_ID, "personalGeneratorItemsApplied")) return undefined;

  const rolledItems = await rollPersonalItemBlocks(config.items);
  if (!rolledItems.length) {
    await document.setFlag?.(SYSTEM_ID, "personalGeneratorItemsApplied", true);
    return undefined;
  }

  const plan = planPersonalGeneratorItems(actor, rolledItems);
  if (!plan?.creates?.length && !plan?.updates?.length) {
    ui.notifications.warn(`Персональный генератор: для ${document.name} нет места под выбранные предметы.`);
    await document.setFlag?.(SYSTEM_ID, "personalGeneratorItemsApplied", true);
    return undefined;
  }

  if (plan.updates.length) await actor.updateEmbeddedDocuments("Item", plan.updates);
  const created = plan.creates.length ? await actor.createEmbeddedDocuments("Item", plan.creates, { render: false }) : [];
  await applyGeneratedEquipment(actor, created);
  await document.setFlag?.(SYSTEM_ID, "personalGeneratorItemsApplied", true);

  await new Promise(resolve => setTimeout(resolve, 50));
  await restoreHealthIfAlive(actor);
  return undefined;
}

async function finalizePersonalGeneratorToken(document) {
  await syncPersonalGeneratorTokenActorPortrait(document);
  return applyPersonalGeneratorTokenItems(document);
}

async function syncPersonalGeneratorTokenActorPortrait(document) {
  if (!document || document.actorLink) return undefined;

  const baseActor = document.actorId ? game.actors?.get(document.actorId) : null;
  if (!baseActor) return undefined;

  const config = getPersonalGeneratorConfig(baseActor);
  if (!config.enabled || !config.images.enabled) return undefined;

  const img = String(document.texture?.src ?? "").trim();
  if (!img || String(document.actor?.img ?? "").trim() === img) return undefined;

  await document.update({ "delta.img": img }, { animate: false });
  return undefined;
}

async function rollPersonalItemBlocks(itemsConfig = {}) {
  const output = [];
  const blocks = Array.isArray(itemsConfig.blocks) ? itemsConfig.blocks : [];
  if (!blocks.length) return output;

  const selectedBlocks = selectBlocksFromExclusionGroups(blocks, buildExclusionGroups(blocks));
  for (const block of selectedBlocks) {
    const entries = normalizeItemEntries(block.entries).filter(entry => entry.uuid);
    if (!entries.length) continue;

    const pickMode = normalizePickMode(block.pickMode);
    const pickValue = parsePickValue(block.pick);
    if (!pickValue) continue;

    if (pickMode === "totalQuantity") {
      output.push(...await rollTotalQuantityBlock(entries, pickValue));
      continue;
    }

    if (pickMode === "totalValue") {
      output.push(...await rollTotalValueBlock(entries, pickValue, block.pickCurrency));
      continue;
    }

    output.push(...await rollCountBlock(entries, pickValue));
  }

  return mergeStackableItemData(output);
}

async function rollTotalQuantityBlock(entries, pickValue) {
  const normalized = entries.map(entry => {
    const min = Math.min(entry.min, entry.max);
    const max = Math.max(entry.min, entry.max);
    return isDefaultQuantityRange(entry)
      ? { ...entry, min: 0, max: Math.max(0, pickValue) }
      : { ...entry, min, max };
  });
  const minTotal = normalized.reduce((sum, entry) => sum + entry.min, 0);
  const maxTotal = Math.max(minTotal, normalized.reduce((sum, entry) => sum + entry.max, 0));
  const target = Math.min(Math.max(pickValue, minTotal), maxTotal);
  const quantities = normalized.map(entry => entry.min);
  distributeWeightedQuantity(normalized, quantities, target - minTotal);
  return buildRolledItemData(normalized, quantities);
}

async function rollTotalValueBlock(entries, pickValue, currencyKey) {
  const targetValue = Math.max(0, pickValue) * getCurrencyValueRatio(currencyKey || getDefaultCurrencyKey());
  if (!targetValue) return [];
  const docs = await Promise.all(entries.map(entry => resolveItem(entry.uuid)));
  const resolved = entries.map((entry, index) => {
    const doc = docs[index];
    if (!doc) return null;
    const price = getItemPriceValue(doc);
    const min = Math.min(entry.min, entry.max);
    const max = Math.max(entry.min, entry.max);
    const effectiveMax = isDefaultQuantityRange(entry) ? (price > 0 ? Math.floor(targetValue / price) : 0) : max;
    return { ...entry, doc, price, min: isDefaultQuantityRange(entry) ? 0 : min, max: Math.max(min, effectiveMax) };
  }).filter(Boolean);
  const quantities = resolved.map(entry => entry.min);
  let remaining = targetValue - resolved.reduce((sum, entry, index) => sum + (entry.price * quantities[index]), 0);

  for (const [index, entry] of resolved.entries()) {
    if (entry.price > 0 || entry.max <= entry.min) continue;
    quantities[index] = randomIntInclusive(entry.min, entry.max);
  }

  const candidates = new Set(resolved.map((entry, index) => (
    entry.price > 0 && quantities[index] < entry.max ? index : null
  )).filter(index => index !== null));
  let guard = 0;
  while (remaining > 0 && candidates.size && guard < 20000) {
    guard += 1;
    const index = pickWeightedIndex(Array.from(candidates), candidate => resolved[candidate].weight);
    const price = resolved[index].price;
    if (price <= 0 || price > remaining) {
      candidates.delete(index);
      continue;
    }
    quantities[index] += 1;
    remaining -= price;
    if (quantities[index] >= resolved[index].max) candidates.delete(index);
  }

  return buildRolledItemData(resolved, quantities);
}

async function rollCountBlock(entries, pickValue) {
  const groups = createEntrySelectionGroups(entries);
  const pickedGroups = sampleWeightedUnique(groups, Math.min(pickValue, groups.length));
  const selected = pickedGroups.flatMap(group => group.entries ?? []);
  const quantities = selected.map(entry => randomIntInclusive(Math.min(entry.min, entry.max), Math.max(entry.min, entry.max)));
  return buildRolledItemData(selected, quantities);
}

async function buildRolledItemData(entries, quantities) {
  const output = [];
  for (const [index, entry] of entries.entries()) {
    const quantity = Math.max(0, toInteger(quantities[index]));
    if (!quantity) continue;
    const item = entry.doc ?? await resolveItem(entry.uuid);
    if (!item) continue;
    const splitQuantity = needsUniqueGeneratedItem(item);
    const count = splitQuantity ? quantity : 1;
    const itemQuantity = splitQuantity ? 1 : quantity;
    for (let iteration = 0; iteration < count; iteration += 1) {
      const data = createEmbeddedItemData(item, itemQuantity, entry);
      if (!data) continue;
      if (entry.hasDurability || entry.hasCondition) {
        applyConditionToItemData(data, randomIntInclusive(Math.min(entry.condMin, entry.condMax), Math.max(entry.condMin, entry.condMax)));
      }
      foundry.utils.setProperty(data, `flags.${SYSTEM_ID}.personalGeneratorEquip`, Boolean(entry.equip));
      output.push(data);
    }
  }
  return output;
}

function planPersonalGeneratorItems(actor, itemsData) {
  const updates = [];
  const creates = [];
  const reservedPlacements = new Map();
  const projected = createProjectedItemMap(actor);
  const { occupiedEquipmentSlots, occupiedWeaponSlots } = getOccupiedGeneratedEquipSlots(actor);

  for (const itemData of itemsData) {
    const maxStack = getItemMaxStack(itemData);
    let remainingQuantity = Math.max(1, getItemQuantity(itemData));

    if (maxStack > 1) {
      const [target] = getProjectedStackTargets(projected, itemData);
      if (target) {
        const parentId = String(foundry.utils.getProperty(target, "system.container.parentId") ?? ROOT_CONTAINER_ID);
        const quantity = remainingQuantity;
        const update = usesVirtualInventoryStacks(target)
          ? createItemStackPartAdditionUpdate(target, quantity)
          : { _id: target._id ?? target.id, "system.quantity": getItemQuantity(target) + quantity };
        if (!update) continue;
        const nextProjected = cloneProjectedMap(projected);
        applyProjectedItemUpdate(nextProjected.get(update._id), update);
        if (!validateProjectedItems(actor, nextProjected)) continue;
        updates.push(update);
        applyProjectedItemUpdate(projected.get(update._id), update);
        remainingQuantity -= quantity;
        if (parentId && !canContainerAcceptMoreWeight(projected, parentId)) break;
      }
    }

    while (remainingQuantity > 0) {
      const quantity = maxStack > 1 ? remainingQuantity : Math.min(remainingQuantity, maxStack);
      const stackData = foundry.utils.deepClone(itemData);
      foundry.utils.setProperty(stackData, "system.quantity", quantity);
      const equipPlacement = getGeneratedEquipRequest(stackData)
        ? findGeneratedEquipPlacement(actor, stackData, occupiedEquipmentSlots, occupiedWeaponSlots)
        : null;
      if (equipPlacement) {
        const createData = createInventoryItemDataForPlacement(stackData, {
          parentId: ROOT_CONTAINER_ID,
          placement: equipPlacement
        });
        if (usesVirtualInventoryStacks(createData)) {
          foundry.utils.setProperty(createData, "system.stackParts", createStackPartsForGeneratedPlacement(createData, equipPlacement));
        }
        creates.push(createData);
        const syntheticId = `personal-generator-${creates.length}`;
        const projectedCreate = foundry.utils.deepClone(createData);
        projectedCreate._id = syntheticId;
        projectedCreate.id = syntheticId;
        projected.set(syntheticId, projectedCreate);
        remainingQuantity -= quantity;
        continue;
      }

      const target = findFirstGeneratedItemPlacement(actor, projected, stackData, reservedPlacements);
      if (!target) break;
      const createData = createInventoryItemDataForPlacement(stackData, target);
      if (usesVirtualInventoryStacks(createData)) {
        foundry.utils.setProperty(createData, "system.stackParts", target.stackParts);
      }
      creates.push(createData);
      const syntheticId = `personal-generator-${creates.length}`;
      const projectedCreate = foundry.utils.deepClone(createData);
      projectedCreate._id = syntheticId;
      projectedCreate.id = syntheticId;
      projected.set(syntheticId, projectedCreate);
      if (!reservedPlacements.has(target.parentId)) reservedPlacements.set(target.parentId, []);
      reservedPlacements.get(target.parentId).push(...(target.placements ?? [target.placement]));
      remainingQuantity -= quantity;
    }
  }

  return { updates, creates };
}

function findFirstGeneratedItemPlacement(actor, projectedMap, itemData, reservedPlacements = new Map()) {
  const rootDimensions = getActorRootDimensions(actor);
  const projectedItems = Array.from(projectedMap.values());
  for (const parentId of getGeneratedItemParentCandidates(actor, projectedItems, itemData)) {
    const dimensions = parentId ? getContainerInventoryGridOptions(actor.items?.get(parentId)) : rootDimensions;
    const options = parentId ? dimensions : getActorRootInventoryGridOptions(actor, parentId);
    if (parentId && !canProjectedContainerAcceptWeight(projectedMap, parentId, itemData)) continue;
    const contextItems = getContextInventoryItems(parentId, projectedItems);
    if (usesVirtualInventoryStacks(itemData)) {
      const stackParts = createAnchoredItemStackPartsForQuantity({
        itemData,
        quantity: getItemQuantity(itemData),
        contextItems,
        columns: dimensions.columns,
        rows: dimensions.rows,
        allItems: projectedItems,
        reservedPlacements: reservedPlacements.get(parentId) ?? [],
        options
      });
      if (!stackParts?.length) continue;
      const placements = stackParts.map(part => createInventoryPlacement(part.x, part.y, itemData, projectedItems));
      const createData = createInventoryItemDataForPlacement(itemData, {
        parentId,
        placement: placements[0]
      });
      foundry.utils.setProperty(createData, "system.stackParts", stackParts);
      const testProjected = cloneProjectedMap(projectedMap);
      const syntheticId = `personal-generator-test-${foundry.utils.randomID()}`;
      createData._id = syntheticId;
      createData.id = syntheticId;
      testProjected.set(syntheticId, createData);
      if (validateProjectedItems(actor, testProjected)) return {
        parentId,
        placement: placements[0],
        placements,
        stackParts
      };
      continue;
    }
    const placement = findFirstAvailableInventoryPlacement(
      contextItems,
      dimensions.columns,
      dimensions.rows,
      itemData,
      projectedItems,
      [],
      reservedPlacements.get(parentId) ?? [],
      options
    );
    if (!placement) continue;
    const createData = createInventoryItemDataForPlacement(itemData, { parentId, placement });
    const testProjected = cloneProjectedMap(projectedMap);
    const syntheticId = `personal-generator-test-${foundry.utils.randomID()}`;
    createData._id = syntheticId;
    createData.id = syntheticId;
    testProjected.set(syntheticId, createData);
    if (validateProjectedItems(actor, testProjected)) return { parentId, placement };
  }
  return null;
}

async function applyGeneratedEquipment(actor, createdItems = []) {
  const updates = [];
  const { occupiedEquipmentSlots, occupiedWeaponSlots } = getOccupiedGeneratedEquipSlots(actor);

  for (const item of createdItems) {
    if (!item?.getFlag?.(SYSTEM_ID, "personalGeneratorEquip")) continue;
    if (["equipment", "weapon"].includes(String(item.system?.placement?.mode ?? ""))) continue;
    const placement = findGeneratedEquipPlacement(actor, item, occupiedEquipmentSlots, occupiedWeaponSlots);
    if (!placement) continue;
    const storedPlacement = createStoredPlacement(placement, item);
    updates.push({
      _id: item.id,
      "system.equipped": storedPlacement.mode === "equipment",
      "system.container.parentId": ROOT_CONTAINER_ID,
      "system.placement.mode": storedPlacement.mode,
      "system.placement.equipmentSlot": storedPlacement.equipmentSlot,
      "system.placement.weaponSet": storedPlacement.weaponSet,
      "system.placement.weaponSlot": storedPlacement.weaponSlot,
      "system.placement.x": storedPlacement.x,
      "system.placement.y": storedPlacement.y,
      "system.placement.width": storedPlacement.width,
      "system.placement.height": storedPlacement.height,
      "system.placement.rotated": storedPlacement.rotated
    });
  }
  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
}

function getOccupiedGeneratedEquipSlots(actor) {
  const occupiedEquipmentSlots = new Set();
  const occupiedWeaponSlots = new Set();
  const race = getActorRace(actor);
  for (const item of actor.items ?? []) {
    const placement = item.system?.placement ?? {};
    if (placement.mode === "equipment") {
      for (const slot of getRequiredEquipmentSlotsForItem(race, item, placement.equipmentSlot)) {
        occupiedEquipmentSlots.add(getEquipmentSlotSelectionKey(slot.label));
      }
    }
    if (placement.mode === "weapon") {
      for (const key of getPlacedWeaponSlotKeys(actor, item, placement)) occupiedWeaponSlots.add(key);
    }
  }
  return { occupiedEquipmentSlots, occupiedWeaponSlots };
}

function getGeneratedEquipRequest(itemData) {
  return foundry.utils.getProperty(itemData, `flags.${SYSTEM_ID}.personalGeneratorEquip`) === true;
}

function findGeneratedEquipPlacement(actor, item, occupiedEquipmentSlots, occupiedWeaponSlots) {
  const race = getActorRace(actor);
  const equipmentSlots = getRaceEquipmentSlotsForItem(race, item);
  if (equipmentSlots.length) {
    for (const slot of equipmentSlots) {
      const requiredSlots = getRequiredEquipmentSlotsForItem(race, item, slot.key);
      if (!requiredSlots.length) continue;
      const requiredKeys = requiredSlots.map(entry => getEquipmentSlotSelectionKey(entry.label));
      if (requiredKeys.some(key => occupiedEquipmentSlots.has(key))) continue;
      for (const key of requiredKeys) occupiedEquipmentSlots.add(key);
      return { mode: "equipment", equipmentSlot: slot.key, weaponSet: "", weaponSlot: "", x: 1, y: 1 };
    }
  }

  const weaponRequirement = getWeaponSlotRequirement(item);
  if (!weaponRequirement.selectedKeys.size) return null;
  const inventory = prepareWeaponSetInventory(actor);
  for (const set of inventory.weaponSets) {
    for (const slot of set.slots ?? []) {
      const placement = { mode: "weapon", equipmentSlot: "", weaponSet: set.key, weaponSlot: slot.key, x: 1, y: 1 };
      const requiredSlots = getRequiredGeneratedWeaponSlotKeys(actor, item, placement, set.slots);
      if (!requiredSlots.length) continue;
      if (requiredSlots.some(key => occupiedWeaponSlots.has(key))) continue;
      for (const key of requiredSlots) occupiedWeaponSlots.add(key);
      return placement;
    }
  }
  return null;
}

function getRequiredGeneratedWeaponSlotKeys(actor, item, placement, setSlots = []) {
  const race = getActorRace(actor);
  if (isContainerWeaponSetKey(placement.weaponSet)) {
    const index = setSlots.findIndex(slot => slot.key === placement.weaponSlot);
    const size = getWeaponSlotRequirementSize(item, race);
    const required = setSlots.slice(index, index + size);
    return required.length === size ? required.map(slot => `${placement.weaponSet}:${slot.key}`) : [];
  }
  if (!canUseWeaponSlotForItem(race, item, placement.weaponSet, placement.weaponSlot)) return [];
  return getRequiredWeaponSlotsForItem(race, item, placement.weaponSet, placement.weaponSlot)
    .map(slot => `${placement.weaponSet}:${slot.key}`);
}

function getPlacedWeaponSlotKeys(actor, item, placement = {}) {
  const inventory = prepareWeaponSetInventory(actor);
  const set = inventory.weaponSets.find(entry => entry.key === placement.weaponSet);
  return getRequiredGeneratedWeaponSlotKeys(actor, item, placement, set?.slots ?? []);
}

function prepareWeaponSetInventory(actor) {
  const race = getActorRace(actor);
  const containerSets = Array.from(actor.items ?? [])
    .filter(item => isContainerItem(item) && item.system?.equipped)
    .map(container => {
      const count = Math.max(0, toInteger(container.system?.functions?.container?.extraWeaponSlots));
      return {
        key: `container:${container.id}`,
        slots: Array.from({ length: count }, (_value, index) => ({ key: `extra-${index + 1}` }))
      };
    });
  return { weaponSets: [...(race?.weaponSets ?? []), ...containerSets] };
}

function getPersonalGeneratorConfig(actorOrConfig = null) {
  const raw = actorOrConfig?.getFlag
    ? (actorOrConfig.getFlag(SYSTEM_ID, "personalGenerator") ?? {})
    : (actorOrConfig ?? {});
  return createPersonalGeneratorConfig(foundry.utils.mergeObject(
    foundry.utils.deepClone(PERSONAL_GENERATOR_DEFAULTS),
    raw,
    { inplace: false, overwrite: true }
  ));
}

function createPersonalGeneratorConfig(config = {}) {
  const output = foundry.utils.mergeObject(
    foundry.utils.deepClone(PERSONAL_GENERATOR_DEFAULTS),
    config ?? {},
    { inplace: false, overwrite: true }
  );
  output.enabled = output.enabled === true;
  output.name.enabled = output.name.enabled !== false;
  output.name.appendToTokenName = output.name.appendToTokenName !== false;
  output.name.overwriteBaseName = output.name.overwriteBaseName === true;
  output.name.firstNameBlockId = normalizeNameBlockId(output.name.firstNameBlockId, DEFAULT_NAME_BLOCK_IDS.male);
  output.name.surnameBlockId = normalizeNameBlockId(output.name.surnameBlockId, DEFAULT_NAME_BLOCK_IDS.commonSurname);
  output.name.useSurname = output.name.useSurname !== false;
  output.name.countPreview = Math.max(1, Math.min(30, toInteger(output.name.countPreview) || 10));

  output.currency.enabled = output.currency.enabled === true;
  output.currency.mode = output.currency.mode === "set" ? "set" : "add";
  output.currency.ranges = normalizeCurrencyRanges(output.currency.ranges);

  output.images.enabled = output.images.enabled === true;
  output.images.includeCurrent = output.images.includeCurrent !== false;
  output.images.paths = Array.from(new Set((Array.isArray(output.images.paths) ? output.images.paths : [])
    .map(path => String(path ?? "").trim())
    .filter(Boolean)));

  output.items.enabled = output.items.enabled === true;
  output.items.blocks = (Array.isArray(output.items.blocks) ? output.items.blocks : []).map(normalizeItemBlock);
  return output;
}

function normalizeItemBlock(block = {}) {
  const enabledCurrencyKeys = new Set(getCurrencySettings().map(currency => currency.key));
  const pickCurrency = String(block.pickCurrency ?? "").trim();
  return {
    id: String(block.id || foundry.utils.randomID()).trim(),
    name: String(block.name ?? "").trim(),
    pick: String(block.pick ?? block.maxPick ?? 0).trim(),
    pickMode: normalizePickMode(block.pickMode ?? block.mode),
    pickCurrency: enabledCurrencyKeys.has(pickCurrency) ? pickCurrency : getDefaultCurrencyKey(),
    exclusions: (Array.isArray(block.exclusions) ? block.exclusions : [])
      .map(id => String(id ?? "").trim())
      .filter(Boolean),
    entries: normalizeItemEntries(block.entries)
  };
}

function normalizeItemEntries(entries = []) {
  return (Array.isArray(entries) ? entries : []).map(entry => {
    let uuid = String(entry.uuid ?? entry.itemUuid ?? "").trim();
    const legacyItemId = String(entry.itemId ?? "").trim();
    if (!uuid && legacyItemId) uuid = `Item.${legacyItemId}`;
    return {
      uuid,
      name: String(entry.name ?? "").trim(),
      img: String(entry.img ?? "").trim(),
      equip: entry.equip === true,
      hasCondition: entry.hasCondition === true || entry.hasDurability === true,
      hasDurability: entry.hasDurability === true || entry.hasCondition === true,
      chain: String(entry.chain ?? entry.chainId ?? entry.link ?? entry.linkId ?? "").trim(),
      min: Math.max(0, toInteger(entry.min)),
      max: Math.max(0, toInteger(entry.max)),
      condMin: Math.max(0, Math.min(100, toInteger(entry.condMin ?? 100) || 100)),
      condMax: Math.max(0, Math.min(100, toInteger(entry.condMax ?? 100) || 100)),
      weight: Math.max(1, toInteger(entry.weight ?? 100) || 100),
      itemTradeLocked: entry.itemTradeLocked === true || entry.locked === true || entry.system?.locked === true
    };
  });
}

function createItemBlock() {
  return normalizeItemBlock({
    id: foundry.utils.randomID(),
    name: "Новый блок",
    pick: "1",
    pickMode: "count",
    pickCurrency: getDefaultCurrencyKey(),
    entries: [],
    exclusions: []
  });
}

function createItemEntry() {
  return normalizeItemEntries([{ uuid: "", name: "", img: "", min: 1, max: 1, weight: 100, condMin: 100, condMax: 100 }])[0]
    ?? { uuid: "", name: "", img: "", equip: false, hasCondition: false, chain: "", min: 1, max: 1, condMin: 100, condMax: 100, weight: 100, itemTradeLocked: false };
}

function createItemEntryFromItem(item) {
  return {
    ...createItemEntry(),
    uuid: item.uuid,
    name: item.name,
    img: normalizeImagePath(item.img),
    hasCondition: hasItemFunction(item, ITEM_FUNCTIONS.condition),
    itemTradeLocked: Boolean(item.system?.locked || item.getFlag?.(SYSTEM_ID, "itemTradeLocked"))
  };
}

function linkItemEntriesInBlock(block, sourceIndex, targetIndex) {
  const entries = block?.entries ?? [];
  const source = entries[sourceIndex];
  const target = entries[targetIndex];
  if (!source || !target || source === target) return;
  const sourceChain = String(source.chain ?? "").trim();
  const targetChain = String(target.chain ?? "").trim();
  const chain = sourceChain || targetChain || foundry.utils.randomID();
  for (const entry of entries) {
    const current = String(entry.chain ?? "").trim();
    if (current && (current === sourceChain || current === targetChain)) entry.chain = chain;
  }
  source.chain = chain;
  target.chain = chain;
  normalizeChainsInBlock(block);
}

function normalizeChainsInBlock(block) {
  const entries = block?.entries ?? [];
  const counts = new Map();
  for (const entry of entries) {
    const chain = String(entry.chain ?? "").trim();
    entry.chain = chain;
    if (!chain) continue;
    counts.set(chain, (counts.get(chain) ?? 0) + 1);
  }
  for (const entry of entries) {
    if (entry.chain && (counts.get(entry.chain) ?? 0) < 2) entry.chain = "";
  }
}

function getPrototypeTokenLinkContext(actor) {
  const linked = actor?.prototypeToken?.actorLink === true;
  return {
    linked,
    status: linked ? "привязанный" : "отвязанный",
    toggleLabel: linked ? "Сделать отвязанным" : "Сделать привязанным",
    canConfigure: canConfigurePrototypeToken(actor)
  };
}

function preparePersonalGeneratorContext(config) {
  return {
    ...config,
    itemBlocks: config.items.blocks.map(block => ({
      ...block,
      exclusionsText: (block.exclusions ?? []).join(", "),
      pickModeChoices: getPickModeChoices().map(choice => ({
        ...choice,
        selected: choice.value === block.pickMode
      })),
      currencyChoices: getCurrencySettings().map(currency => ({
        ...currency,
        selected: currency.key === block.pickCurrency
      })),
      entries: (block.entries ?? []).map((entry, index) => ({
        ...entry,
        index,
        img: normalizeImagePath(entry.img)
      })),
      itemGroups: createItemEntryGroups(block.entries ?? [])
    }))
  };
}

function createItemEntryGroups(entries = []) {
  const normalized = (Array.isArray(entries) ? entries : []).map((entry, index) => ({
    ...entry,
    index,
    img: normalizeImagePath(entry.img),
    chain: String(entry.chain ?? "").trim()
  }));
  const chainMap = new Map();
  for (const entry of normalized) {
    if (!entry.chain) continue;
    if (!chainMap.has(entry.chain)) chainMap.set(entry.chain, []);
    chainMap.get(entry.chain).push(entry);
  }

  const groups = [];
  const seen = new Set();
  for (const entry of normalized) {
    const list = entry.chain ? (chainMap.get(entry.chain) ?? []) : [];
    if (entry.chain && list.length >= 2) {
      if (seen.has(entry.chain)) continue;
      seen.add(entry.chain);
      groups.push({ chain: entry.chain, entries: list });
      continue;
    }
    groups.push({ chain: "", entries: [{ ...entry, chain: "" }] });
  }
  return groups;
}

function getNameBlockChoices(config = {}) {
  const blocks = getPersonalNameBlocks();
  return blocks.map(block => ({
    value: block.id,
    label: block.name,
    firstSelected: block.id === config.name?.firstNameBlockId,
    surnameSelected: block.id === config.name?.surnameBlockId
  }));
}

function getCurrencyChoices(config = {}) {
  return getCurrencySettings().map(currency => ({
    ...currency,
    range: config.currency?.ranges?.[currency.key] ?? { min: 0, max: 0 },
    pickSelected: currency.key === config.items?.blocks?.[0]?.pickCurrency
  }));
}

function getPickModeChoices() {
  return [
    { value: "count", label: "Случайные позиции" },
    { value: "totalQuantity", label: "Общее количество" },
    { value: "totalValue", label: "Общая стоимость" }
  ];
}

function getPersonalNameBlocks() {
  const raw = game.settings.get(SYSTEM_ID, PERSONAL_NAME_RANDOMIZER_SETTING);
  const blocks = Array.isArray(raw?.blocks) && raw.blocks.length ? raw.blocks : DEFAULT_NAME_BLOCKS;
  return blocks.map(block => ({
    id: String(block.id ?? "").trim(),
    name: String(block.name ?? "").trim(),
    namesText: String(block.namesText ?? block.namesCsv ?? "").trim()
  })).filter(block => block.id && block.name);
}

function normalizeNameBlockId(blockId, fallback) {
  const id = String(blockId ?? "").trim();
  const known = new Set(getPersonalNameBlocks().map(block => block.id));
  return known.has(id) ? id : fallback;
}

function generatePersonalName(config = {}) {
  const first = pickRandom(parseNamesFromBlock(config.firstNameBlockId));
  if (!first) return "";
  const surname = config.useSurname ? pickRandom(parseNamesFromBlock(config.surnameBlockId)) : "";
  return `${first}${surname ? ` ${surname}` : ""}`.trim();
}

function createNamePreview(nameConfig = {}) {
  return Array.from({ length: Math.max(1, Math.min(30, toInteger(nameConfig.countPreview) || 10)) }, () => generatePersonalName(nameConfig))
    .filter(Boolean)
    .join(", ");
}

function parseNamesFromBlock(blockId) {
  const block = getPersonalNameBlocks().find(entry => entry.id === String(blockId ?? "").trim());
  return Array.from(new Set(String(block?.namesText ?? "")
    .split(/[,|;\n]+/u)
    .map(value => value.trim())
    .filter(Boolean)));
}

function applyNameAddition(baseName, addition) {
  const base = String(baseName ?? "").trim();
  const add = String(addition ?? "").trim();
  if (!add) return base;
  const suffix = base.match(/\s*\(\d+\)$/)?.[0] ?? "";
  const core = suffix ? base.replace(/\s*\(\d+\)$/, "").trim() : base;
  return `${core} ${add}`.trim() + suffix;
}

function applyNameOverwrite(baseName, generated) {
  const base = String(baseName ?? "").trim();
  const name = String(generated ?? "").trim();
  if (!name) return base;
  const suffix = base.match(/\s*\(\d+\)$/)?.[0] ?? "";
  return name + suffix;
}

function createEmbeddedItemData(item, quantity, entry = {}) {
  const count = Math.max(0, toInteger(quantity));
  if (!item || count <= 0) return null;
  const data = item.toObject();
  delete data._id;
  delete data.id;
  delete data.folder;
  foundry.utils.setProperty(data, "system.quantity", count);
  if (entry.itemTradeLocked) {
    foundry.utils.setProperty(data, "system.locked", true);
    foundry.utils.setProperty(data, `flags.${SYSTEM_ID}.itemTradeLocked`, true);
  }
  return data;
}

function applyConditionToItemData(data, conditionPercent) {
  const max = Math.max(0, toInteger(foundry.utils.getProperty(data, "system.functions.condition.max")));
  if (!max) return;
  const value = Math.max(0, Math.round(max * Math.max(0, Math.min(100, conditionPercent)) / 100));
  foundry.utils.setProperty(data, "system.functions.condition.value", value);
}

function mergeStackableItemData(itemsData) {
  const merged = [];
  for (const data of itemsData) {
    if (!data || getItemMaxStack(data) <= 1 || isContainerItem(data)) {
      merged.push(data);
      continue;
    }
    const existing = merged.find(candidate => canStackItems(data, candidate));
    if (!existing) {
      merged.push(data);
      continue;
    }
    foundry.utils.setProperty(existing, "system.quantity", getItemQuantity(existing) + getItemQuantity(data));
  }
  return merged;
}

function getGeneratedItemParentCandidates(actor, projectedItems, itemData) {
  const candidates = [ROOT_CONTAINER_ID];
  for (const item of actor.items ?? []) {
    const id = String(item.id ?? "");
    if (!id || !isContainerItem(item)) continue;
    if (hasContainerCycle(itemData, id, projectedItems)) continue;
    candidates.push(id);
  }
  return candidates;
}

function getProjectedStackTargets(projectedMap, itemData) {
  return Array.from(projectedMap.values()).filter(item => canStackItems(itemData, item));
}

function createProjectedItemMap(actor) {
  return new Map(actor.items.contents.map(item => [item.id, item.toObject()]));
}

function cloneProjectedMap(projectedMap) {
  return new Map(Array.from(projectedMap.entries()).map(([id, data]) => [id, foundry.utils.deepClone(data)]));
}

function applyProjectedItemUpdate(itemData, update = {}) {
  if (!itemData || !update) return itemData;
  for (const [key, value] of Object.entries(update)) {
    if (key === "_id") continue;
    foundry.utils.setProperty(itemData, key, value);
  }
  return itemData;
}

function validateProjectedItems(actor, projectedMap) {
  return validateInventoryTree(Array.from(projectedMap.values()), getActorRootDimensions(actor), {
    rootOptions: getActorRootInventoryGridOptions(actor, ROOT_CONTAINER_ID)
  }).valid;
}

function createStackPartsForGeneratedPlacement(itemData, placement) {
  return createAnchoredItemStackPartsForQuantity({
    itemData,
    quantity: getItemQuantity(itemData),
    preferredPlacement: placement,
    contextItems: [],
    columns: Math.max(1, toInteger(placement?.x) || 1),
    rows: Math.max(1, toInteger(placement?.y) || 1),
    allItems: [],
    options: { allowOverflowRows: true }
  }) ?? [];
}

function createInventoryItemDataForPlacement(itemData, target) {
  const data = foundry.utils.deepClone(itemData);
  delete data._id;
  delete data.id;
  delete data.folder;
  const storedPlacement = createStoredPlacement(target.placement, itemData);
  foundry.utils.mergeObject(data, {
    system: {
      equipped: storedPlacement.mode === "equipment",
      container: { parentId: target.parentId },
      placement: {
        mode: storedPlacement.mode,
        equipmentSlot: storedPlacement.equipmentSlot,
        weaponSet: storedPlacement.weaponSet,
        weaponSlot: storedPlacement.weaponSlot,
        x: storedPlacement.x,
        y: storedPlacement.y,
        width: storedPlacement.width,
        height: storedPlacement.height,
        rotated: storedPlacement.rotated
      }
    }
  });
  return data;
}

function canProjectedContainerAcceptWeight(projectedMap, parentId, itemData) {
  const container = projectedMap.get(parentId);
  if (!container) return false;
  const currentLoad = getContainerContentsWeight(parentId, Array.from(projectedMap.values()));
  return currentLoad + getItemTotalWeight(itemData, Array.from(projectedMap.values())) <= getContainerMaxLoad(container) + 0.0001;
}

function canContainerAcceptMoreWeight(projectedMap, parentId) {
  const container = projectedMap.get(parentId);
  if (!container) return false;
  return getContainerContentsWeight(parentId, Array.from(projectedMap.values())) <= getContainerMaxLoad(container) + 0.0001;
}

function getActorRootDimensions(actor) {
  return getActorInventoryGridDimensions(actor, getActorRace(actor));
}

function getActorRace(actor) {
  return getCreatureOptions().races.find(entry => entry.id === actor?.system?.creature?.raceId) ?? null;
}

async function restoreHealthIfAlive(actor) {
  const current = Number(foundry.utils.getProperty(actor, "system.resources.health.value")) || 0;
  const max = Number(foundry.utils.getProperty(actor, "system.resources.health.max")) || 0;
  if (current > 0 && max > 0 && current < max) await actor.update({ "system.resources.health.value": max });
}

function buildExclusionGroups(blocks) {
  const blockMap = new Map(blocks.map(block => [String(block.id), block]));
  const processed = new Set();
  const groups = [];
  for (const block of blocks) {
    const id = String(block.id ?? "");
    if (!id || processed.has(id)) continue;
    const group = new Set([id]);
    const queue = [...(block.exclusions ?? [])];
    while (queue.length) {
      const nextId = String(queue.shift() ?? "");
      if (!nextId || group.has(nextId)) continue;
      group.add(nextId);
      const nextBlock = blockMap.get(nextId);
      if (nextBlock) queue.push(...(nextBlock.exclusions ?? []));
    }
    for (const member of group) processed.add(member);
    groups.push(Array.from(group));
  }
  for (const block of blocks) {
    const id = String(block.id ?? "");
    if (id && !processed.has(id)) groups.push([id]);
  }
  return groups;
}

function selectBlocksFromExclusionGroups(blocks, groups) {
  const blockMap = new Map(blocks.map(block => [String(block.id), block]));
  return groups
    .map(group => blockMap.get(pickRandom(group)))
    .filter(Boolean);
}

function createEntrySelectionGroups(entries) {
  const groups = [];
  const chains = new Map();
  for (const entry of entries) {
    if (!entry.chain) {
      groups.push({ entries: [entry], weight: entry.weight });
      continue;
    }
    if (!chains.has(entry.chain)) chains.set(entry.chain, []);
    chains.get(entry.chain).push(entry);
  }
  for (const entries of chains.values()) {
    if (entries.length === 1) groups.push({ entries, weight: entries[0].weight });
    else groups.push({ entries, weight: Math.max(...entries.map(entry => entry.weight)) });
  }
  return groups;
}

function distributeWeightedQuantity(entries, quantities, remaining) {
  const candidates = new Set(entries.map((entry, index) => quantities[index] < entry.max ? index : null).filter(index => index !== null));
  while (remaining > 0 && candidates.size) {
    const index = pickWeightedIndex(Array.from(candidates), candidate => entries[candidate].weight);
    quantities[index] += 1;
    remaining -= 1;
    if (quantities[index] >= entries[index].max) candidates.delete(index);
  }
}

function sampleWeightedUnique(items, count) {
  const pool = [...items];
  const output = [];
  while (output.length < count && pool.length) {
    const index = pickWeightedIndex(pool, item => item.weight);
    output.push(pool[index]);
    pool.splice(index, 1);
  }
  return output;
}

function pickWeightedIndex(items, weightFn) {
  const weights = items.map(item => Math.max(1, Number(weightFn(item)) || 1));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let roll = Math.random() * total;
  for (let index = 0; index < weights.length; index += 1) {
    roll -= weights[index];
    if (roll <= 0) return index;
  }
  return Math.max(0, items.length - 1);
}

function isDefaultQuantityRange(entry) {
  return entry.min === 1 && entry.max === 1;
}

function normalizePickMode(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (["totalvalue", "total_value", "value"].includes(raw)) return "totalValue";
  if (["totalquantity", "total_quantity", "quantity"].includes(raw)) return "totalQuantity";
  return "count";
}

function parsePickValue(value) {
  if (typeof value === "number") return Math.max(0, Math.trunc(value));
  const raw = String(value ?? "").trim();
  const range = raw.match(/^(\d+)\s*-\s*(\d+)$/);
  if (range) {
    const min = Math.max(0, toInteger(range[1]));
    const max = Math.max(0, toInteger(range[2]));
    return randomIntInclusive(Math.min(min, max), Math.max(min, max));
  }
  return Math.max(0, toInteger(raw));
}

function randomIntInclusive(min, max) {
  const low = Math.min(toInteger(min), toInteger(max));
  const high = Math.max(toInteger(min), toInteger(max));
  return Math.floor(Math.random() * (high - low + 1)) + low;
}

function pickRandom(values) {
  const array = Array.isArray(values) ? values.filter(value => value !== undefined && value !== null && value !== "") : [];
  return array.length ? array[Math.floor(Math.random() * array.length)] : "";
}

async function resolveItem(uuid) {
  const value = String(uuid ?? "").trim();
  if (!value) return null;
  return resolveWorldItemSync(value);
}

function needsUniqueGeneratedItem(item) {
  return getItemMaxStack(item) <= 1 || isContainerItem(item);
}

function getDefaultCurrencyKey() {
  return getCurrencySettings().find(currency => currency.primaryTrade)?.key ?? getCurrencySettings()[0]?.key ?? "";
}

function getCurrencyValueRatio(currencyKey) {
  const currencies = getCurrencySettings();
  const primary = currencies.find(currency => currency.primaryTrade) ?? currencies[0];
  const current = currencies.find(currency => currency.key === currencyKey) ?? primary;
  const primaryValue = Number(primary?.value) || 1;
  const currentValue = Number(current?.value) || 1;
  return currentValue / primaryValue;
}

function getItemPriceValue(item) {
  const price = Number(item?.system?.price) || 0;
  const currencyKey = String(item?.system?.priceCurrency ?? getDefaultCurrencyKey());
  return Math.max(0, price) * getCurrencyValueRatio(currencyKey);
}

function normalizeCurrencyRanges(ranges = {}) {
  const output = {};
  for (const currency of getCurrencySettings()) {
    output[currency.key] = {
      min: Math.max(0, toInteger(ranges?.[currency.key]?.min)),
      max: Math.max(0, toInteger(ranges?.[currency.key]?.max))
    };
  }
  return output;
}

function readCurrencyRanges(form) {
  const ranges = {};
  for (const row of form.querySelectorAll("[data-currency-range]")) {
    const key = row.dataset.currencyRange;
    ranges[key] = {
      min: toInteger(row.querySelector("[data-field='min']")?.value),
      max: toInteger(row.querySelector("[data-field='max']")?.value)
    };
  }
  return ranges;
}

function readImagePaths(form) {
  return Array.from(form.querySelectorAll("[data-pg-image-path]"))
    .map(input => String(input.value ?? "").trim())
    .filter(Boolean);
}

function readItemBlocks(form) {
  return Array.from(form.querySelectorAll("[data-pg-block]")).map(block => ({
    id: String(block.dataset.blockId || foundry.utils.randomID()).trim(),
    name: String(block.querySelector("[data-field='name']")?.value ?? "").trim(),
    pick: String(block.querySelector("[data-field='pick']")?.value ?? "1").trim(),
    pickMode: normalizePickMode(block.querySelector("[data-field='pickMode']")?.value),
    pickCurrency: String(block.querySelector("[data-field='pickCurrency']")?.value ?? getDefaultCurrencyKey()).trim(),
    exclusions: splitComma(block.querySelector("[data-field='exclusions']")?.value),
    entries: Array.from(block.querySelectorAll("[data-pg-entry]")).map(entry => ({
      uuid: String(entry.querySelector("[data-field='uuid']")?.value ?? "").trim(),
      name: String(entry.querySelector("[data-field='name']")?.value ?? "").trim(),
      img: String(entry.querySelector("[data-field='img']")?.value ?? "").trim(),
      equip: getFieldBoolean(entry.querySelector("[data-field='equip']")),
      hasCondition: getFieldBoolean(entry.querySelector("[data-field='hasCondition']")),
      chain: String(entry.querySelector("[data-field='chain']")?.value ?? "").trim(),
      min: toInteger(entry.querySelector("[data-field='min']")?.value),
      max: toInteger(entry.querySelector("[data-field='max']")?.value),
      condMin: toInteger(entry.querySelector("[data-field='condMin']")?.value),
      condMax: toInteger(entry.querySelector("[data-field='condMax']")?.value),
      weight: toInteger(entry.querySelector("[data-field='weight']")?.value),
      itemTradeLocked: getFieldBoolean(entry.querySelector("[data-field='itemTradeLocked']"))
    }))
  }));
}

function getFieldBoolean(input) {
  if (!input) return false;
  if (input.type === "checkbox") return input.checked === true;
  return input.value === "1" || input.value === "true";
}

function getChecked(root, name) {
  return root.querySelector(`[name="${CSS.escape(name)}"]`)?.checked === true;
}

function getValue(root, name) {
  return String(root.querySelector(`[name="${CSS.escape(name)}"]`)?.value ?? "");
}

function getInteger(root, name, fallback = 0) {
  const value = toInteger(getValue(root, name));
  return value || fallback;
}

function getRowIndex(target, selector) {
  const row = target?.closest?.(selector) ?? target;
  return Number(row?.dataset?.index ?? -1);
}

function splitComma(value) {
  return String(value ?? "").split(/[,;\s]+/u).map(line => line.trim()).filter(Boolean);
}

function getUniqueId(base, existingValues) {
  const existing = new Set(existingValues.map(value => String(value)));
  if (!existing.has(base)) return base;
  let index = 2;
  while (existing.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}
