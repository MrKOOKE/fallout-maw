import { SYSTEM_ID, TEMPLATES } from "../constants.mjs";
import { getCreatureOptions, getCurrencySettings } from "../settings/accessors.mjs";
import { actorHasAbility, findCatalogAbility, grantCatalogAbility } from "../abilities/purchase.mjs";
import {
  ABILITY_CATALOG_DRAG_TYPE,
  getAbilitySourceCategoryId,
  getAbilitySourceId,
  prepareAbilityItemData
} from "../settings/abilities.mjs";
import {
  PERSONAL_GENERATOR_PRESETS_SETTING,
  PERSONAL_NAME_RANDOMIZER_SETTING
} from "../settings/constants.mjs";
import { getMainPresetDefault } from "../settings/presets/manager.mjs";
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
  getItemStackAvailableSpace,
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

const DEFAULT_NAME_BLOCK_ID_LIST = Object.freeze([
  DEFAULT_NAME_BLOCK_IDS.male,
  DEFAULT_NAME_BLOCK_IDS.commonSurname
]);

const PERSONAL_GENERATOR_DEFAULTS = Object.freeze({
  enabled: false,
  name: {
    enabled: true,
    appendToTokenName: true,
    overwriteBaseName: false,
    blockIds: [...DEFAULT_NAME_BLOCK_ID_LIST],
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
  abilities: {
    enabled: false,
    entries: []
  },
  items: {
    enabled: false,
    blocks: []
  }
});

const PERSONAL_GENERATOR_DROPZONE_SELECTOR = "[data-pg-block-drop]";

let personalGeneratorWindow = null;

export function registerPersonalGeneratorSettings() {
  game.settings.register(SYSTEM_ID, PERSONAL_NAME_RANDOMIZER_SETTING, {
    name: "Настройки персонального генератора",
    scope: "world",
    preset: true,
    config: false,
    type: Object,
    default: getMainPresetDefault(PERSONAL_NAME_RANDOMIZER_SETTING, { blocks: DEFAULT_NAME_BLOCKS.map(block => ({ ...block })) })
  });

  game.settings.register(SYSTEM_ID, PERSONAL_GENERATOR_PRESETS_SETTING, {
    name: "Пресеты персонального генератора",
    scope: "world",
    preset: true,
    config: false,
    type: Object,
    default: getMainPresetDefault(PERSONAL_GENERATOR_PRESETS_SETTING, {})
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
    await game.settings.set(SYSTEM_ID, PERSONAL_NAME_RANDOMIZER_SETTING, getMainPresetDefault(PERSONAL_NAME_RANDOMIZER_SETTING, {
      blocks: DEFAULT_NAME_BLOCKS.map(block => ({ ...block }))
    }));
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
  #interactionAbort = null;
  #draggingEntry = null;
  #activeDragPayload = null;

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
      createNameBlock: this.#onCreateNameBlock,
      deleteNameBlock: this.#onDeleteNameBlock,
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
    const raw = actor?.getFlag?.(SYSTEM_ID, "personalGenerator") ?? {};
    const missingEntryIds = personalGeneratorConfigMissingEntryIds(raw);
    this.#config = getPersonalGeneratorConfig(actor);
    if (missingEntryIds && actor) void actor.setFlag(SYSTEM_ID, "personalGenerator", this.#config);
  }

  get _dragDrop() {
    return this.#dragDrop ??= new foundry.applications.ux.DragDrop.implementation({
      dragSelector: null,
      dropSelector: PERSONAL_GENERATOR_DROPZONE_SELECTOR,
      permissions: {
        drop: () => true
      },
      callbacks: {
        dragover: this.#onDropzoneDragOver.bind(this),
        dragenter: this.#onDropzoneDragEnter.bind(this),
        dragleave: this.#onDropzoneDragLeave.bind(this)
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
      nameBlockRows: getNameBlockRows(this.#config),
      pickModeChoices: getPickModeChoices(),
      generatedNamePreview: createNamePreview(this.#config.name)
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#resetEntryVisualState();
    this._dragDrop.bind(this.element);
    this.#activateInteractionListeners();
    this.#syncAllPickModeFields();
    this.#syncChainLinkDisplay();
  }

  async _onClose(options) {
    this.#cancelChainLink();
    this.#abortInteractionListeners();
    await super._onClose(options);
  }

  async close(options) {
    this.#cancelChainLink();
    this.#abortInteractionListeners();
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
    const entryId = getItemEntryId(target);
    if (blockIndex < 0 || !entryId) return undefined;
    this.#config = this.#readConfigFromForm();
    const block = this.#config.items.blocks[blockIndex];
    if (!block) return undefined;
    block.entries = block.entries.filter(entry => entry.entryId !== entryId);
    normalizeChainsInBlock(block);
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

  static async #onCreateNameBlock(event) {
    event.preventDefault();
    this.#config = this.#readConfigFromForm();
    const fallback = getPersonalNameBlocks()[0]?.id ?? DEFAULT_NAME_BLOCK_IDS.male;
    this.#config.name.blockIds.push(fallback);
    this.#config.name = normalizeNameConfig(this.#config.name);
    await this.#saveCurrentConfig();
    return this.render({ force: true });
  }

  static async #onDeleteNameBlock(event, target) {
    event.preventDefault();
    const index = getRowIndex(target, "[data-pg-name-block]");
    if (index < 0) return undefined;
    this.#config = this.#readConfigFromForm();
    if (this.#config.name.blockIds.length <= 1) return undefined;
    this.#config.name.blockIds.splice(index, 1);
    this.#config.name = normalizeNameConfig(this.#config.name);
    await this.#saveCurrentConfig();
    return this.render({ force: true });
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
    const blockId = getBlockId(entry);
    const entryId = getItemEntryId(entry);
    if (!entry || !blockId || !entryId) return undefined;

    this.#config = this.#readConfigFromForm();
    const block = findPersonalGeneratorBlock(this.#config.items.blocks, blockId);
    const currentEntry = findPersonalGeneratorEntry(block, entryId);
    if (!currentEntry) return undefined;

    if ((event.shiftKey || event.altKey) && currentEntry.chain) {
      currentEntry.chain = "";
      normalizeChainsInBlock(block);
      this.#cancelChainLink();
      await this.#saveCurrentConfig();
      return this.render({ force: true });
    }

    this.#startChainLink({ blockId, entryId, entryElement: entry, buttonElement: target });
    return undefined;
  }

  async #onDropItem(event) {
    event.preventDefault();
    event.stopPropagation();
    const internalDrop = this.#resolveInternalEntryDropData(event);
    this.#clearDropzoneHighlight(event.target?.closest?.(PERSONAL_GENERATOR_DROPZONE_SELECTOR));
    if (internalDrop) {
      await this.#moveInternalEntryDrop(event, internalDrop);
      this.#activeDragPayload = null;
      this.#resetEntryVisualState();
      return undefined;
    }
    this.#resetEntryVisualState();

    const blockElement = this.#getItemBlockElementForDrop(event);
    const blockIndex = getRowIndex(blockElement, "[data-pg-block]");
    if (blockIndex < 0) return undefined;

    const data = this.#getDragEventData(event);
    const abilityEntry = await createAbilityEntryFromDropData(data);
    if (abilityEntry) {
      this.#config = this.#readConfigFromForm();
      this.#config.items.blocks[blockIndex]?.entries.push(createItemEntryFromAbilityEntry(abilityEntry));
      await this.#saveCurrentConfig();
      return this.render({ force: true });
    }

    if (data?.type !== "Item") return undefined;
    const item = await resolveItemDocumentFromDropData(data);
    if (!item) return undefined;

    this.#config = this.#readConfigFromForm();
    this.#config.items.blocks[blockIndex]?.entries.push(createItemEntryFromItem(item));
    await this.#saveCurrentConfig();
    return this.render({ force: true });
  }

  #onDropzoneDragEnter(event) {
    const dropzone = event.target?.closest?.(PERSONAL_GENERATOR_DROPZONE_SELECTOR);
    if (!dropzone || !this.element?.contains(dropzone)) return;
    dropzone.dataset.dragDepth = String((toInteger(dropzone.dataset.dragDepth) || 0) + 1);
    dropzone.classList.add("drag-over");
  }

  #onDropzoneDragLeave(event) {
    const dropzone = event.target?.closest?.(PERSONAL_GENERATOR_DROPZONE_SELECTOR);
    if (!dropzone || !this.element?.contains(dropzone)) return;
    const depth = Math.max(0, (toInteger(dropzone.dataset.dragDepth) || 0) - 1);
    dropzone.dataset.dragDepth = String(depth);
    if (!depth) dropzone.classList.remove("drag-over");
  }

  #onDropzoneDragOver(event) {
    const dropzone = event.target?.closest?.(PERSONAL_GENERATOR_DROPZONE_SELECTOR);
    if (!dropzone || !this.element?.contains(dropzone)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = this.#getDropEffectForEvent(event);
    dropzone.classList.add("drag-over");
  }

  #activateInteractionListeners() {
    this.#abortInteractionListeners();
    const element = this.element;
    if (!element) return undefined;

    this.#interactionAbort = new AbortController();
    const { signal } = this.#interactionAbort;
    const onPointerRelease = () => {
      this.#restoreEntryDragging();
    };

    this.#prepareEntryImagesForDrag(element);
    const interactionRoot = element.querySelector(".window-content") ?? element;

    element.addEventListener("input", event => this.#queueAutosaveFromEvent(event, 350), { signal });
    element.addEventListener("change", event => this.#queueAutosaveFromEvent(event, 0), { signal });
    interactionRoot.addEventListener("click", event => this.#onEntryClick(event), { signal });
    interactionRoot.addEventListener("dragstart", event => this.#onEntryDragStart(event), { signal });
    interactionRoot.addEventListener("dragend", event => this.#onEntryDragEnd(event), { signal });
    interactionRoot.addEventListener("dragenter", event => this.#onDropzoneDragEnter(event), { signal });
    interactionRoot.addEventListener("dragleave", event => this.#onDropzoneDragLeave(event), { signal });
    interactionRoot.addEventListener("dragover", event => this.#onDropzoneDragOver(event), { signal });
    interactionRoot.addEventListener("drop", event => void this.#onDropItem(event), { signal });
    interactionRoot.addEventListener("change", event => {
      if (event.target?.matches?.("[data-field='pickMode']")) this.#syncPickModeFields(event.target.closest("[data-pg-block]"));
    }, { signal });
    interactionRoot.addEventListener("pointerdown", event => this.#onEntryPointerDown(event), { capture: true, signal });
    interactionRoot.addEventListener("pointerup", onPointerRelease, { capture: true, signal });
    interactionRoot.addEventListener("pointercancel", onPointerRelease, { capture: true, signal });
    document.addEventListener("dragend", event => this.#onDocumentDragEnd(event), { capture: true, signal });
    document.addEventListener("keydown", event => this.#onModifierKeyChange(event), { capture: true, signal });
    document.addEventListener("keyup", event => this.#onModifierKeyChange(event), { capture: true, signal });
    return undefined;
  }

  #prepareEntryImagesForDrag(root = this.element) {
    for (const img of root?.querySelectorAll(".fallout-maw-pg-entry-img") ?? []) {
      img.draggable = false;
    }
  }

  #abortInteractionListeners() {
    this.#interactionAbort?.abort();
    this.#interactionAbort = null;
  }

  #resetEntryVisualState() {
    const root = this.element;

    if (this.#draggingEntry?.isConnected) this.#draggingEntry.classList.remove("pg-chip-dragging");
    this.#draggingEntry = null;

    for (const entry of root?.querySelectorAll("[data-pg-entry].pg-chip-dragging") ?? []) {
      entry.classList.remove("pg-chip-dragging");
    }
    for (const dropzone of root?.querySelectorAll(`${PERSONAL_GENERATOR_DROPZONE_SELECTOR}.drag-over`) ?? []) {
      this.#clearDropzoneHighlight(dropzone);
    }
    if (!this.#chainSource) {
      for (const entry of root?.querySelectorAll("[data-pg-entry]") ?? []) {
        entry.classList.remove("pg-chain-link-source", "pg-chain-link-target");
      }
    }

    this.#restoreEntryDragging();
    return undefined;
  }

  #onDocumentDragEnd(event) {
    const fromApp = !!event.target?.closest?.(`#${this.id}`);
    if (!fromApp && !this.#draggingEntry && !this.#activeDragPayload) return undefined;
    this.#activeDragPayload = null;
    return this.#resetEntryVisualState();
  }

  #getDropEffectForEvent(event) {
    const data = this.#resolveInternalEntryDropData(event) ?? this.#getDragEventData(event);
    if (data?.type === "fallout-maw-personal-generator-entry") {
      return data.copy === true || event.shiftKey === true ? "copy" : "move";
    }
    return "copy";
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
    const blockId = getBlockId(entry);
    const entryId = getItemEntryId(entry);
    if (!blockId || !entryId) return;
    this.#draggingEntry = entry;
    entry.classList.add("pg-chip-dragging");
    const payload = {
      type: "fallout-maw-personal-generator-entry",
      blockId,
      entryId,
      copy: event.shiftKey === true
    };
    this.#activeDragPayload = payload;
    event.dataTransfer?.setData("text/plain", JSON.stringify(payload));
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "copyMove";
    }
  }

  #onEntryDragEnd(_event) {
    this.#activeDragPayload = null;
    this.#resetEntryVisualState();
    return undefined;
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

  #resolveInternalEntryDropData(event) {
    const data = this.#getDragEventData(event);
    if (data?.type === "fallout-maw-personal-generator-entry" && data.entryId && data.blockId) return data;
    if (this.#activeDragPayload?.type === "fallout-maw-personal-generator-entry") return { ...this.#activeDragPayload };
    return null;
  }

  #getItemBlockElementForDrop(event) {
    return event.target?.closest?.("[data-pg-block-drop]")?.closest?.("[data-pg-block]")
      ?? event.target?.closest?.("[data-pg-block]");
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

  async #moveInternalEntryDrop(event, data) {
    event.preventDefault();
    event.stopPropagation();

    const targetBlockElement = this.#getItemBlockElementForDrop(event);
    const targetBlockId = getBlockId(targetBlockElement);
    if (!targetBlockId) return undefined;

    const copy = data.copy === true || event.shiftKey === true;
    this.#config = this.#readConfigFromForm();
    const sourceBlock = findPersonalGeneratorBlock(this.#config.items.blocks, data.blockId);
    const targetBlock = findPersonalGeneratorBlock(this.#config.items.blocks, targetBlockId);
    const sourceEntry = findPersonalGeneratorEntry(sourceBlock, data.entryId);
    if (!sourceBlock || !targetBlock || !sourceEntry) return undefined;

    const moving = getPersonalGeneratorChainGroup(sourceBlock.entries, sourceEntry);
    const movedEntries = copy
      ? clonePersonalGeneratorItemEntries(moving)
      : moving.map(entry => entry);

    if (copy && moving.length > 1) {
      const newChain = foundry.utils.randomID();
      for (const entry of movedEntries) entry.chain = newChain;
    }

    if (!copy) {
      const movingIds = new Set(moving.map(entry => entry.entryId));
      sourceBlock.entries = sourceBlock.entries.filter(entry => !movingIds.has(entry.entryId));
      normalizeChainsInBlock(sourceBlock);
    }

    targetBlock.entries.push(...movedEntries);
    normalizeChainsInBlock(targetBlock);
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

  #startChainLink({ blockId, entryId, entryElement, buttonElement }) {
    this.#cancelChainLink();
    this.#chainSource = { blockId, entryId };
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

    const blockId = getBlockId(entry);
    const entryId = getItemEntryId(entry);
    const source = this.#chainSource;
    if (!blockId || !entryId || blockId !== source.blockId || entryId === source.entryId) {
      this.#cancelChainLink();
      return;
    }

    this.#config = this.#readConfigFromForm();
    const block = findPersonalGeneratorBlock(this.#config.items.blocks, blockId);
    linkItemEntriesInBlock(block, source.entryId, entryId);
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
    if (this.#activeDragPayload) this.#activeDragPayload.copy = event.shiftKey === true;
  }

  #syncChainRemoveMode(removeMode) {
    for (const button of this.element?.querySelectorAll(".fallout-maw-pg-chain-button.is-on") ?? []) {
      button.classList.toggle("pg-chain-remove-mode", removeMode);
    }
  }

  #syncChainLinkDisplay() {
    const source = this.#chainSource;
    for (const entry of this.element?.querySelectorAll("[data-pg-entry]") ?? []) {
      const blockId = getBlockId(entry);
      const entryId = getItemEntryId(entry);
      const active = !!source && source.blockId === blockId && source.entryId === entryId;
      const target = !!source && source.blockId === blockId && source.entryId !== entryId;
      entry.classList.toggle("pg-chain-link-source", active);
      entry.classList.toggle("pg-chain-link-target", target);
    }
  }

  #syncAllPickModeFields() {
    for (const block of this.element?.querySelectorAll("[data-pg-block]") ?? []) {
      this.#syncPickModeFields(block);
    }
  }

  #syncPickModeFields(blockElement) {
    if (!blockElement) return undefined;
    const pickMode = normalizePickMode(blockElement.querySelector("[data-field='pickMode']")?.value);
    const currencyField = blockElement.querySelector("[data-pg-pick-currency]");
    if (currencyField) currencyField.hidden = pickMode !== "totalValue";
    return undefined;
  }

  #readConfigFromForm() {
    const form = this.element;
    const previousBlocks = this.#config?.items?.blocks ?? [];
    const previousAbilities = this.#config?.abilities ?? { enabled: false, entries: [] };
    const config = createPersonalGeneratorConfig({
      enabled: getChecked(form, "enabled"),
      name: {
        enabled: getChecked(form, "name.enabled"),
        appendToTokenName: getChecked(form, "name.appendToTokenName"),
        overwriteBaseName: getChecked(form, "name.overwriteBaseName"),
        blockIds: readNameBlockIds(form),
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
      abilities: {
        enabled: previousAbilities.enabled === true,
        entries: previousAbilities.entries ?? []
      },
      items: {
        enabled: getChecked(form, "items.enabled"),
        blocks: readItemBlocks(form, previousBlocks)
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

  const rolledEntries = await rollPersonalItemBlocks(config.items);
  const rolledAbilities = rolledEntries.filter(entry => entry?.type === "ability");
  const rolledItems = rolledEntries.filter(entry => entry?.type !== "ability");
  if (rolledAbilities.length) await createPersonalGeneratorAbilityItems(actor, rolledAbilities);

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

async function applyPersonalGeneratorTokenAbilities(document) {
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
  if (!config.enabled || !config.abilities.enabled) return undefined;
  if (document.getFlag?.(SYSTEM_ID, "personalGeneratorAbilitiesApplied")) return undefined;

  const abilitiesData = [];
  for (const entry of normalizeAbilityEntries(config.abilities.entries)) {
    const itemData = await createEmbeddedAbilityData({ ...entry, kind: "ability" });
    if (itemData) abilitiesData.push(itemData);
  }
  await createPersonalGeneratorAbilityItems(actor, abilitiesData);

  await document.setFlag?.(SYSTEM_ID, "personalGeneratorAbilitiesApplied", true);
  return undefined;
}

async function createPersonalGeneratorAbilityItems(actor, abilitiesData = []) {
  if (!actor || !abilitiesData.length) return [];

  const creates = [];
  for (const sourceData of abilitiesData) {
    if (sourceData?.type !== "ability") continue;
    const sourceId = getAbilitySourceId(sourceData);
    if (sourceId) {
      if (actorHasAbility(actor, sourceId)) continue;
      const item = await grantCatalogAbility(actor, sourceId);
      if (item) continue;
    }

    const itemData = foundry.utils.deepClone(sourceData);
    delete itemData._id;
    delete itemData.id;
    creates.push(itemData);
  }

  return creates.length ? actor.createEmbeddedDocuments("Item", creates, { render: false }) : [];
}

async function finalizePersonalGeneratorToken(document) {
  await syncPersonalGeneratorTokenActorPortrait(document);
  await applyPersonalGeneratorTokenItems(document);
  return applyPersonalGeneratorTokenAbilities(document);
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
    const entries = normalizeItemEntries(block.entries).filter(entry => entry.kind === "ability" ? (entry.sourceId || entry.uuid) : entry.uuid);
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
    if (entry.kind === "ability") {
      const abilityData = await createEmbeddedAbilityData(entry);
      if (!abilityData) continue;
      foundry.utils.setProperty(abilityData, `flags.${SYSTEM_ID}.personalGeneratorAbility`, true);
      output.push(abilityData);
      continue;
    }

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
      const target = getProjectedStackTargets(projected, itemData)
        .find(candidate => getItemStackAvailableSpace(candidate) > 0);
      if (target) {
        const parentId = String(foundry.utils.getProperty(target, "system.container.parentId") ?? ROOT_CONTAINER_ID);
        const quantity = Math.min(remainingQuantity, getItemStackAvailableSpace(target));
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
  output.name = normalizeNameConfig(output.name);

  output.currency.enabled = output.currency.enabled === true;
  output.currency.mode = output.currency.mode === "set" ? "set" : "add";
  output.currency.ranges = normalizeCurrencyRanges(output.currency.ranges);

  output.images.enabled = output.images.enabled === true;
  output.images.includeCurrent = output.images.includeCurrent !== false;
  output.images.paths = Array.from(new Set((Array.isArray(output.images.paths) ? output.images.paths : [])
    .map(path => String(path ?? "").trim())
    .filter(Boolean)));

  output.abilities ??= { enabled: false, entries: [] };
  output.abilities.enabled = output.abilities?.enabled === true;
  output.abilities.entries = normalizeAbilityEntries(output.abilities?.entries);

  output.items.enabled = output.items.enabled === true;
  output.items.blocks = (Array.isArray(output.items.blocks) ? output.items.blocks : []).map(normalizeItemBlock);
  return output;
}

async function createEmbeddedAbilityData(entry = {}) {
  const sourceId = String(entry.sourceId ?? "").trim();
  if (sourceId) {
    const catalogEntry = findCatalogAbility(sourceId);
    if (!catalogEntry) return null;
    return prepareAbilityItemData(catalogEntry.ability, {
      categoryId: String(entry.categoryId ?? catalogEntry.category?.id ?? "").trim()
    });
  }

  const item = entry.uuid ? await resolveItem(entry.uuid) : null;
  if (!(item instanceof Item) || item.type !== "ability") return null;
  const itemData = item.toObject();
  delete itemData._id;
  delete itemData.id;
  return itemData;
}

function normalizeAbilityEntries(entries = []) {
  const seen = new Set();
  const normalized = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const sourceId = String(entry.sourceId ?? entry.id ?? "").trim();
    const uuid = String(entry.uuid ?? "").trim();
    if (!sourceId && !uuid) continue;
    const key = sourceId ? `source:${sourceId}` : `uuid:${uuid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      sourceId,
      categoryId: String(entry.categoryId ?? "").trim(),
      uuid,
      name: String(entry.name ?? "").trim(),
      img: normalizeImagePath(entry.img || "icons/svg/aura.svg")
    });
  }
  return normalized;
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
    const sourceId = String(entry.sourceId ?? entry.abilitySourceId ?? "").trim();
    let uuid = String(entry.uuid ?? entry.itemUuid ?? "").trim();
    const legacyItemId = String(entry.itemId ?? "").trim();
    if (!uuid && legacyItemId) uuid = `Item.${legacyItemId}`;
    const kind = String(entry.kind ?? entry.type ?? "").trim() === "ability" || sourceId ? "ability" : "item";
    return {
      entryId: String(entry.entryId ?? "").trim() || foundry.utils.randomID(),
      kind,
      sourceId,
      categoryId: String(entry.categoryId ?? "").trim(),
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
  return normalizeItemEntries([{ kind: "item", uuid: "", name: "", img: "", min: 1, max: 1, weight: 100, condMin: 100, condMax: 100 }])[0]
    ?? {
      entryId: foundry.utils.randomID(),
      kind: "item", sourceId: "", categoryId: "", uuid: "", name: "", img: "",
      equip: false, hasCondition: false, chain: "", min: 1, max: 1, condMin: 100, condMax: 100, weight: 100, itemTradeLocked: false
    };
}

function createItemEntryFromItem(item) {
  if (item?.type === "ability") {
    return createItemEntryFromAbilityEntry({
      sourceId: getAbilitySourceId(item),
      categoryId: getAbilitySourceCategoryId(item),
      uuid: item.uuid,
      name: item.name,
      img: item.img
    });
  }

  return {
    ...createItemEntry(),
    uuid: item.uuid,
    name: item.name,
    img: normalizeImagePath(item.img),
    hasCondition: hasItemFunction(item, ITEM_FUNCTIONS.condition),
    itemTradeLocked: Boolean(item.system?.locked || item.getFlag?.(SYSTEM_ID, "itemTradeLocked"))
  };
}

function createItemEntryFromAbilityEntry(entry = {}) {
  return {
    ...createItemEntry(),
    kind: "ability",
    sourceId: String(entry.sourceId ?? "").trim(),
    categoryId: String(entry.categoryId ?? "").trim(),
    uuid: String(entry.uuid ?? "").trim(),
    name: String(entry.name ?? "").trim() || "Способность",
    img: normalizeImagePath(entry.img || "icons/svg/aura.svg"),
    equip: false,
    hasCondition: false,
    hasDurability: false
  };
}

async function createAbilityEntryFromDropData(data = {}) {
  if (data?.type === ABILITY_CATALOG_DRAG_TYPE) {
    const sourceId = String(data.sourceId ?? "").trim();
    if (!sourceId) return null;
    const catalogEntry = findCatalogAbility(sourceId);
    const ability = catalogEntry?.ability ?? data;
    return normalizeAbilityEntries([{
      sourceId,
      categoryId: String(data.categoryId ?? catalogEntry?.category?.id ?? "").trim(),
      name: ability.name,
      img: ability.img
    }])[0] ?? null;
  }

  if (data?.type !== "Item") return null;
  const item = await resolveItemDocumentFromDropData(data);
  if (!(item instanceof Item) || item.type !== "ability") return null;
  return normalizeAbilityEntries([{
    sourceId: getAbilitySourceId(item),
    categoryId: getAbilitySourceCategoryId(item),
    uuid: item.uuid,
    name: item.name,
    img: item.img
  }])[0] ?? null;
}

async function resolveItemDocumentFromDropData(data = {}) {
  const item = data.uuid ? resolveWorldItemSync(data.uuid) : null;
  if (item) return item;

  try {
    return await Item.implementation.fromDropData(data);
  } catch (_error) {
    return null;
  }
}

function linkItemEntriesInBlock(block, sourceEntryId, targetEntryId) {
  const entries = block?.entries ?? [];
  const source = findPersonalGeneratorEntry(block, sourceEntryId);
  const target = findPersonalGeneratorEntry(block, targetEntryId);
  if (!source || !target || source.entryId === target.entryId) return;
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
    name: normalizeNameConfig(config.name ?? {}),
    itemBlocks: config.items.blocks.map(block => ({
      ...block,
      showPickCurrency: block.pickMode === "totalValue",
      pickModeChoices: getPickModeChoices().map(choice => ({
        ...choice,
        selected: choice.value === block.pickMode
      })),
      currencyChoices: getCurrencySettings().map(currency => ({
        ...currency,
        img: normalizeImagePath(currency.img),
        hasImage: Boolean(currency.img),
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

function prepareAbilityEntriesForDisplay(entries = []) {
  return normalizeAbilityEntries(entries).map(entry => {
    const catalogEntry = entry.sourceId ? findCatalogAbility(entry.sourceId) : null;
    const item = !catalogEntry && entry.uuid ? resolveWorldItemSync(entry.uuid) : null;
    const ability = catalogEntry?.ability ?? item ?? entry;
    return {
      ...entry,
      name: String(ability?.name ?? entry.name ?? "").trim() || "Способность",
      img: normalizeImagePath(ability?.img ?? entry.img ?? "icons/svg/aura.svg")
    };
  });
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

function getNameBlockRows(config = {}) {
  const nameConfig = normalizeNameConfig(config.name ?? {});
  const choices = getPersonalNameBlocks().map(block => ({
    value: block.id,
    label: block.name
  }));
  return nameConfig.blockIds.map((blockId, index) => ({
    index,
    blockId,
    canDelete: nameConfig.blockIds.length > 1,
    choices: choices.map(choice => ({
      ...choice,
      selected: choice.value === blockId
    }))
  }));
}

function getCurrencyChoices(config = {}) {
  return getCurrencySettings().map(currency => ({
    ...currency,
    img: normalizeImagePath(currency.img),
    hasImage: Boolean(currency.img),
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

function normalizeNameConfig(name = {}) {
  const known = new Set(getPersonalNameBlocks().map(block => block.id));
  const normalizeId = (blockId, fallback) => {
    const id = String(blockId ?? "").trim();
    return known.has(id) ? id : fallback;
  };

  let blockIds = Array.isArray(name.blockIds)
    ? name.blockIds.map(id => normalizeId(id, "")).filter(Boolean)
    : [];
  if (!blockIds.length) {
    blockIds.push(normalizeId(name.firstNameBlockId, DEFAULT_NAME_BLOCK_IDS.male));
    if (name.useSurname !== false) {
      blockIds.push(normalizeId(name.surnameBlockId, DEFAULT_NAME_BLOCK_IDS.commonSurname));
    }
  }
  if (!blockIds.length) blockIds = [...DEFAULT_NAME_BLOCK_ID_LIST];

  return {
    ...name,
    blockIds,
    firstNameBlockId: blockIds[0] ?? DEFAULT_NAME_BLOCK_IDS.male,
    surnameBlockId: blockIds[1] ?? DEFAULT_NAME_BLOCK_IDS.commonSurname,
    useSurname: blockIds.length > 1,
    countPreview: Math.max(1, Math.min(30, toInteger(name.countPreview) || 10))
  };
}

function generatePersonalName(config = {}) {
  const nameConfig = normalizeNameConfig(config);
  const parts = nameConfig.blockIds
    .map(blockId => pickRandom(parseNamesFromBlock(blockId)))
    .filter(Boolean);
  return parts.join(" ").trim();
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

function readAbilityEntries(form) {
  return normalizeAbilityEntries(Array.from(form.querySelectorAll("[data-pg-ability-entry]")).map(entry => ({
    sourceId: String(entry.querySelector("[data-field='sourceId']")?.value ?? "").trim(),
    categoryId: String(entry.querySelector("[data-field='categoryId']")?.value ?? "").trim(),
    uuid: String(entry.querySelector("[data-field='uuid']")?.value ?? "").trim(),
    name: String(entry.querySelector("[data-field='name']")?.value ?? "").trim(),
    img: String(entry.querySelector("[data-field='img']")?.value ?? "").trim()
  })));
}

function personalGeneratorConfigMissingEntryIds(config = {}) {
  return (config.items?.blocks ?? []).some(block =>
    (block.entries ?? []).some(entry => !String(entry.entryId ?? "").trim())
  );
}

function findPersonalGeneratorBlock(blocks = [], blockId = "") {
  const id = String(blockId ?? "").trim();
  if (!id) return null;
  return blocks.find(block => String(block.id) === id) ?? null;
}

function findPersonalGeneratorEntry(block, entryId = "") {
  const id = String(entryId ?? "").trim();
  if (!block || !id) return null;
  return block.entries?.find(entry => entry.entryId === id) ?? null;
}

function getPersonalGeneratorChainGroup(entries = [], entry = null) {
  if (!entry) return [];
  const chain = String(entry.chain ?? "").trim();
  if (!chain) return [entry];
  const grouped = entries.filter(current => String(current.chain ?? "").trim() === chain);
  return grouped.length >= 2 ? grouped : [entry];
}

function clonePersonalGeneratorItemEntries(entries = []) {
  return entries.map(entry => {
    const cloned = foundry.utils.deepClone(entry);
    cloned.entryId = foundry.utils.randomID();
    return cloned;
  });
}

function getBlockId(target) {
  const block = target?.closest?.("[data-pg-block]") ?? target;
  return String(block?.dataset?.blockId ?? "").trim();
}

function getItemEntryId(target) {
  const entry = target?.closest?.("[data-pg-entry]") ?? target;
  return String(entry?.dataset?.entryId ?? entry?.querySelector?.("[data-field='entryId']")?.value ?? "").trim();
}

function readEntryElementData(entry) {
  return normalizeItemEntries([{
    entryId: getItemEntryId(entry),
    kind: String(entry.querySelector("[data-field='kind']")?.value ?? "item").trim(),
    sourceId: String(entry.querySelector("[data-field='sourceId']")?.value ?? "").trim(),
    categoryId: String(entry.querySelector("[data-field='categoryId']")?.value ?? "").trim(),
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
  }])[0];
}

function readNameBlockIds(form) {
  const blockIds = Array.from(form.querySelectorAll("[data-pg-name-block]"))
    .map(row => String(row.querySelector("[data-field='blockId']")?.value ?? "").trim())
    .filter(Boolean);
  return blockIds.length ? blockIds : [...DEFAULT_NAME_BLOCK_ID_LIST];
}

function readItemBlocks(form, previousBlocks = []) {
  const previousById = new Map(previousBlocks.map(block => [block.id, block]));
  return Array.from(form.querySelectorAll("[data-pg-block]")).map(block => {
    const id = String(block.dataset.blockId || foundry.utils.randomID()).trim();
    const previous = previousById.get(id);
    const pickMode = normalizePickMode(block.querySelector("[data-field='pickMode']")?.value);
    const pickCurrencyField = block.querySelector("[data-field='pickCurrency']");
    const pickCurrency = pickMode === "totalValue" && pickCurrencyField
      ? String(pickCurrencyField.value ?? getDefaultCurrencyKey()).trim()
      : String(previous?.pickCurrency ?? getDefaultCurrencyKey()).trim();
    return {
      id,
      name: String(block.querySelector("[data-field='name']")?.value ?? "").trim(),
      pick: String(block.querySelector("[data-field='pick']")?.value ?? "1").trim(),
      pickMode,
      pickCurrency,
      exclusions: Array.isArray(previous?.exclusions) ? [...previous.exclusions] : [],
      entries: Array.from(block.querySelectorAll("[data-pg-entry]")).map(readEntryElementData)
    };
  });
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
