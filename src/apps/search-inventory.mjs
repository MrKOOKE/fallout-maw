import { SYSTEM_ID, TEMPLATES } from "../constants.mjs";
import { getCreatureOptions, getCurrencySettings, getItemCategorySettings, getProficiencySettings, getSkillSettings } from "../settings/accessors.mjs";
import {
  FALLBACK_ICON,
  escapeHTML,
  formatWeight,
  getActorInventoryGridDimensions,
  getActorRootInventoryGridOptions,
  normalizeImagePath,
  prepareInventoryContext
} from "../utils/actor-display-data.mjs";
import {
  ROOT_CONTAINER_ID,
  INFINITE_ROOT_INVENTORY_EMPTY_ROWS,
  LOCKED_STORAGE_PARENT_ID,
  LOCKED_STORAGE_PLACEMENT_MODE,
  BUTCHERING_STORAGE_PLACEMENT_MODE,
  buildInventoryCellStyle,
  buildInventoryGridStyle,
  createAnchoredItemStackPartsForQuantity,
  createItemStackPartAdditionUpdate,
  createItemStackPartMergeUpdate,
  createItemStackPartPlacementUpdate,
  createItemStackPartRemovalUpdate,
  createItemStackPartSplitUpdate,
  createInventoryHoverPlacementChecker,
  createInventoryPlacement,
  createStoredPlacement,
  findFirstAvailableInventoryPlacement,
  findFirstAvailableResolvedInventoryPlacement,
  getAllContainedItems,
  getContainerContentsWeight,
  getContextInventoryItems,
  getContainerDimensions,
  getContainerMaxLoad,
  getItemActorLoadWeight,
  getItemContainerParentId,
  getItemFootprint,
  getItemId,
  getItemsArray,
  getItemMaxStack,
  getItemQuantity,
  getItemStackPartQuantity,
  getItemTotalWeight,
  hasContainerCycle,
  inventoryPlacementsOverlap,
  isContainerItem,
  isItemInButcheringStorage,
  isItemLocked,
  isInventoryPlacementAvailable,
  normalizeInventoryPlacement,
  placementContainsInventoryCell,
  resetInventoryHoverCheckerCache,
  usesVirtualInventoryStacks,
  validateInventoryTree
} from "../utils/inventory-containers.mjs";
import {
  canShowInventoryRotateAction,
  createInventoryRotationUpdate,
  getInventoryRotationUnavailableLabel,
  resolveInventoryItemRotation
} from "../utils/inventory-rotation.mjs";
import {
  clearInventoryPlacementPreviews,
  clearInventoryVirtualCells,
  getInventoryGridPointerPosition as getInventoryGridPointerPositionFromElement,
  renderInventoryPlacementPreview,
  syncInventoryVirtualCell
} from "../utils/inventory-grid-dom.mjs";
import { resolveInventoryPointerPlacement } from "../utils/inventory-grid-hover.mjs";
import {
  canUseWeaponSlotForItem,
  doesItemOccupyEquipmentSlot,
  getRaceEquipmentSlotsForItem,
  getRequiredEquipmentSlotsForItem,
  getRequiredWeaponSlotsForItem,
  getValidSelectedEquipmentSlotKeysForOptions,
  getValidSelectedWeaponSlotKeys,
  getValidSelectedWeaponSlotKeysForOptions,
  getWeaponSlotRequirement,
  getWeaponSlotRequirementSize,
  isContainerWeaponSetKey
} from "../utils/equipment-slots.mjs";
import { getInventoryTooltipCompareActor, renderInventoryItemTooltipHTML } from "../sheets/actor-sheet.mjs";
import { FalloutMaWContainerSheet } from "../sheets/container-sheet.mjs";
import { isNaturalRaceItem } from "../races/natural-items.mjs";
import {
  getConditionFunction,
  getDamageSourceFunction,
  getEnergyConsumerFunction,
  getEnabledToolFunctions,
  hasItemFunction,
  ITEM_FUNCTIONS
} from "../utils/item-functions.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { getOverlayBaseZIndex, reserveOverlayZIndex } from "../utils/overlay-layer.mjs";
import { canSpendWeaponSwitchActionPoints, spendWeaponSwitchActionPoints } from "../combat/weapon-switching.mjs";
import { canUseActiveItem, useActiveItem } from "../items/active-item-use.mjs";
import { energySourceMatchesConsumer } from "../items/light-source.mjs";
import { openItemInteractionDialog } from "../items/item-interaction-dialogs.mjs";
import { getItemInteractionState } from "../items/item-interactions.mjs";
import {
  canDropItemsForActor,
  droppedItemsActorHasContents,
  dropActorInventoryItem,
  dropItemDataForActor,
  isDroppedItemsActor,
  registerDroppedItemsSearchOpener,
  requestDroppedItemsActorCleanup
} from "../items/dropped-items.mjs";
import { requestSkillCheckBatch } from "../rolls/skill-check.mjs";
import { resolveWorldItemSync } from "../utils/world-items.mjs";
import { getButcheringConfig, hasConfiguredButchering } from "./butchering-config.mjs";
import { requestActorHacking } from "./hacking-dialog.mjs";

const { ApplicationV2, DialogV2, HandlebarsApplicationMixin } = foundry.applications.api;
const { FormDataExtended } = foundry.applications.ux;

const SEARCH_INVENTORY_REFERENCE_WIDTH = 2560;
const SEARCH_INVENTORY_REFERENCE_HEIGHT = 1440;
const SEARCH_INVENTORY_FALLBACK_VIEWPORT_WIDTH = 1280;
const SEARCH_INVENTORY_FALLBACK_VIEWPORT_HEIGHT = 720;
const SEARCH_INVENTORY_SOCKET = `system.${SYSTEM_ID}`;
const SEARCH_INVENTORY_SOCKET_SCOPE = "fallout-maw.searchInventory";
const SEARCH_INVENTORY_SOCKET_TIMEOUT = 10000;
const SEARCH_INVENTORY_MODE_SEARCH = "search";
const SEARCH_INVENTORY_MODE_TRADE = "trade";
const SEARCH_INVENTORY_TRADE_KIND_REGULAR = "regular";
const SEARCH_INVENTORY_TRADE_KIND_PERSONAL = "personal";
const TRADE_OFFER_SIDES = Object.freeze(["searcher", "searched"]);
const TRADE_ROLE_PARTICIPANT = "participant";
const TRADE_ROLE_OBSERVER = "observer";
const TRADE_OFFER_DEFAULT_COLUMNS = 14;
const TRADE_OFFER_MAX_ROWS = 60;

function getFixedTradeOfferGridColumns() {
  return TRADE_OFFER_DEFAULT_COLUMNS;
}

function buildTradeOfferGridStyle(columns = TRADE_OFFER_DEFAULT_COLUMNS, rows = 1) {
  const normalizedColumns = Math.max(1, toInteger(columns) || TRADE_OFFER_DEFAULT_COLUMNS);
  const normalizedRows = Math.max(1, toInteger(rows) || 1);
  return [
    `--fallout-maw-trade-offer-columns: ${normalizedColumns};`,
    `--fallout-maw-trade-offer-rows: ${normalizedRows};`
  ].join(" ");
}
const TRADE_COMPATIBILITY_HIGHLIGHT_MS = 10000;
const DAMAGE_SOURCE_PROTOTYPE_FLAG = "damageSourcePrototypeUuid";
const TRADE_UNCATEGORIZED_LABEL = "Без категории";
const BUTCHERING_CONTAINER_FLAG = "butcheringContainer";

let searchInventoryWindow = null;
const pendingSearchInventorySocketRequests = new Map();
const pendingSearchInventoryTradeInvites = new Map();
const searchInventoryOperationQueues = new Map();
const activeSearchInventoryTradeSessions = new Map();

export function registerSearchInventorySocket() {
  registerDroppedItemsSearchOpener(openSearchInventoryWindow);
  game.socket.on(SEARCH_INVENTORY_SOCKET, handleSearchInventorySocketMessage);
  if (game.user?.isGM) {
    void migrateLegacyButcheringStorages();
    Hooks.on("canvasReady", () => void migrateLegacyButcheringStorages());
  }
}

export async function openSearchInventoryWindow({ searcherActor, searchedActor } = {}) {
  if (!searcherActor || !searchedActor) return undefined;
  if (searcherActor.uuid === searchedActor.uuid) return undefined;
  if (searchedActor.system?.hacking?.enabled === true) {
    return requestActorHacking({
      hackerActor: searcherActor,
      targetActor: searchedActor,
      onUnlocked: () => openSearchInventoryWindowNow({ searcherActor, searchedActor })
    });
  }
  return openSearchInventoryWindowNow({ searcherActor, searchedActor });
}

function openSearchInventoryWindowNow({ searcherActor, searchedActor } = {}) {
  searchInventoryWindow ??= new SearchInventoryApplication();
  searchInventoryWindow.setActors(searcherActor, searchedActor, {
    mode: SEARCH_INVENTORY_MODE_SEARCH,
    sessionId: "",
    tradeCurrencyKey: ""
  });
  return searchInventoryWindow.render({ force: true });
}

export async function requestTradeInventoryWindow({ traderActor, tradeActor } = {}) {
  if (!traderActor || !tradeActor) return undefined;
  if (traderActor.uuid === tradeActor.uuid) return undefined;

  const tradeKind = await promptTradeKind();
  if (!tradeKind) return undefined;
  if (tradeKind === SEARCH_INVENTORY_TRADE_KIND_PERSONAL) {
    return openTradeInventoryWindow({
      searcherActor: traderActor,
      searchedActor: tradeActor,
      sessionId: "",
      tradeCurrencyKey: getPrimaryTradeCurrencyKey(),
      tradeRole: TRADE_ROLE_PARTICIPANT,
      tradeSide: "searcher",
      tradeKind: SEARCH_INVENTORY_TRADE_KIND_PERSONAL
    });
  }

  const existingSession = await requestTradeSessionJoin({ traderActor, tradeActor });
  if (existingSession?.snapshot) {
    const selected = getTradeSnapshotSelectedActorUuids(existingSession.snapshot, game.user?.id ?? "");
    return openTradeInventoryWindow({
      searcherActor: await resolveActor(selected.searcher),
      searchedActor: await resolveActor(selected.searched),
      sessionId: existingSession.snapshot.sessionId,
      tradeCurrencyKey: existingSession.snapshot.tradeCurrencyKey,
      tradeRole: existingSession.role,
      tradeSide: existingSession.side,
      tradeSnapshot: existingSession.snapshot,
      tradeKind: SEARCH_INVENTORY_TRADE_KIND_REGULAR
    });
  }

  const recipientUser = getPrimaryActorOwnerUser(tradeActor);
  if (!recipientUser) {
    ui.notifications.warn("Нет активного владельца актера для торговли.");
    return undefined;
  }

  const sessionId = foundry.utils.randomID();
  const tradeCurrencyKey = getPrimaryTradeCurrencyKey();
  const payload = {
    sessionId,
    searcherActorUuid: traderActor.uuid,
    searchedActorUuid: tradeActor.uuid,
    tradeCurrencyKey,
    requesterUserId: game.user?.id ?? "",
    recipientUserId: recipientUser.id
  };

  if (recipientUser.id === game.user?.id) {
    const accepted = await confirmTradeInvite(payload);
    if (!accepted) return undefined;
  } else {
    let response;
    try {
      response = await requestTradeInviteSocket(payload, recipientUser);
    } catch (error) {
      ui.notifications.warn(error.message || "Запрос торговли не принят.");
      return undefined;
    }
    if (!response?.accepted) return undefined;
  }

  const session = await requestTradeSessionCreate(payload);
  const snapshot = session?.snapshot ?? null;
  const selected = snapshot ? getTradeSnapshotSelectedActorUuids(snapshot, game.user?.id ?? "") : {
    searcher: traderActor.uuid,
    searched: tradeActor.uuid
  };
  return openTradeInventoryWindow({
    searcherActor: await resolveActor(selected.searcher) ?? traderActor,
    searchedActor: await resolveActor(selected.searched) ?? tradeActor,
    sessionId,
    tradeCurrencyKey,
    tradeRole: TRADE_ROLE_PARTICIPANT,
    tradeSide: "searcher",
    tradeSnapshot: snapshot,
    tradeKind: SEARCH_INVENTORY_TRADE_KIND_REGULAR
  });
}

async function openTradeInventoryWindow({
  searcherActor,
  searchedActor,
  sessionId = "",
  tradeCurrencyKey = "",
  tradeRole = TRADE_ROLE_PARTICIPANT,
  tradeSide = "",
  tradeSnapshot = null,
  tradeKind = SEARCH_INVENTORY_TRADE_KIND_REGULAR
} = {}) {
  if (!searcherActor || !searchedActor) return undefined;
  if (searcherActor.uuid === searchedActor.uuid) return undefined;

  searchInventoryWindow ??= new SearchInventoryApplication();
  searchInventoryWindow.setActors(searcherActor, searchedActor, {
    mode: SEARCH_INVENTORY_MODE_TRADE,
    sessionId,
    tradeCurrencyKey: normalizeTradeCurrencyKey(tradeCurrencyKey),
    tradeRole,
    tradeSide,
    tradeSnapshot,
    tradeKind
  });
  return searchInventoryWindow.render({ force: true });
}

async function promptTradeKind() {
  const choice = await DialogV2.input({
    window: { title: "Торговля" },
    content: "<p>Выберите режим торговли.</p>",
    ok: {
      label: "Обычная",
      icon: "fa-solid fa-handshake",
      callback: () => SEARCH_INVENTORY_TRADE_KIND_REGULAR
    },
    buttons: [{
      action: "personal",
      label: "Личная",
      icon: "fa-solid fa-user-check",
      callback: () => SEARCH_INVENTORY_TRADE_KIND_PERSONAL
    }, {
      action: "cancel",
      label: game.i18n.localize("FALLOUTMAW.Common.Cancel")
    }],
    position: { width: 420 },
    rejectClose: false
  });
  if (!choice || choice === "cancel") return "";
  return String(choice);
}

class SearchInventoryApplication extends HandlebarsApplicationMixin(ApplicationV2) {
  #searcherActorUuid = "";
  #searchedActorUuid = "";
  #searcherActor = null;
  #searchedActor = null;
  #mode = SEARCH_INVENTORY_MODE_SEARCH;
  #tradeSessionId = "";
  #tradeCurrencyKey = "";
  #tradeKind = SEARCH_INVENTORY_TRADE_KIND_REGULAR;
  #tradeRole = TRADE_ROLE_PARTICIPANT;
  #tradeSide = "";
  #tradeSessionSnapshot = null;
  #tradeSessionRevision = 0;
  #tradeOffers = createEmptyTradeOffers();
  #tradeCatalogEnabledCategories = new Map();
  #tradeCatalogExpandedWeaponGroups = new Map();
  #tradeCompatibilityHighlight = null;
  #tradeCompatibilityHighlightTimer = null;
  #tradeCompletionInProgress = false;
  #tradeEquipmentCollapsed = true;
  #suppressCloseBroadcast = false;
  #draggedItemData = null;
  #draggedItemId = "";
  #draggedActorUuid = "";
  #draggedTradeOfferKind = "";
  #draggedTradeOfferKey = "";
  #dragDrop = null;
  #bulkTransferInProgress = false;
  #butcheringInProgress = false;
  #hoverPreviewInputKey = "";
  #hoverPreviewKey = "";
  #hookIds = [];
  #renderRefresh = null;
  #inventoryMutationDepth = 0;
  #scrollPositions = new Map();
  #tooltipAnchorElement = null;
  #tooltipActorUuid = "";
  #tooltipCloseTimer = null;
  #tooltipCompareMode = false;
  #tooltipDocumentKeyHandler = null;
  #tooltipDocumentPointerDownHandler = null;
  #tooltipElement = null;
  #tooltipItemId = "";
  #tooltipPinned = false;
  #tooltipTimer = null;
  #tooltipWeaponTabIndex = 0;
  #uiScale = 1;
  #viewportResizeHandler = null;

  static DEFAULT_OPTIONS = {
    actions: {
      toggleMinimize: SearchInventoryApplication.#onToggleMinimize
    },
    id: "fallout-maw-search-inventory",
    classes: ["fallout-maw", "fallout-maw-sheet", "fallout-maw-actor-sheet", "fallout-maw-search-inventory", "sheet", "actor"],
    position: {
      width: SEARCH_INVENTORY_REFERENCE_WIDTH,
      height: SEARCH_INVENTORY_REFERENCE_HEIGHT
    },
    window: {
      resizable: false
    }
  };

  static PARTS = {
    body: {
      template: TEMPLATES.searchInventory
    }
  };

  get title() {
    const searchedName = this.#searchedActor?.name ?? "";
    if (this.#isTradeMode()) return searchedName ? `Торговля: ${searchedName}` : "Торговля";
    return searchedName ? `Обыск: ${searchedName}` : "Обыск";
  }

  _getFrameButtons(options) {
    const buttons = super._getFrameButtons(options);
    buttons.push({
      action: "toggleMinimize",
      icon: "fa-solid fa-window-minimize",
      label: "APPLICATION.ACTIONS.Collapse"
    });
    return buttons;
  }

  static #onToggleMinimize(event) {
    event.preventDefault();
    event.stopPropagation();
    if (event.button !== 0) return;
    if (this.minimized) return this.maximize();
    return this.minimize();
  }

  setPosition(position = {}) {
    const fullscreenPosition = this.#getFullscreenPosition(position);
    const result = super.setPosition(fullscreenPosition);
    this.#applyUiScale(fullscreenPosition.scale);
    return result;
  }

  get _dragDrop() {
    return this.#dragDrop ??= new foundry.applications.ux.DragDrop.implementation({
      dragSelector: ".draggable",
      dropSelector: "[data-search-root]",
      permissions: {
        dragstart: this._canDragStart.bind(this),
        drop: this._canDragDrop.bind(this)
      },
      callbacks: {
        dragstart: this._onDragStart.bind(this),
        dragover: this._onDragOver.bind(this),
        dragleave: this.#onInventoryDragLeave.bind(this),
        drop: this._onDrop.bind(this),
        dragend: this._onDragEnd.bind(this)
      }
    });
  }

  setActors(searcherActor, searchedActor, {
    mode = SEARCH_INVENTORY_MODE_SEARCH,
    sessionId = "",
    tradeCurrencyKey = "",
    tradeRole = TRADE_ROLE_PARTICIPANT,
    tradeSide = "",
    tradeSnapshot = null,
    tradeKind = SEARCH_INVENTORY_TRADE_KIND_REGULAR
  } = {}) {
    this.#searcherActorUuid = searcherActor?.uuid ?? "";
    this.#searchedActorUuid = searchedActor?.uuid ?? "";
    this.#searcherActor = searcherActor ?? null;
    this.#searchedActor = searchedActor ?? null;
    this.#mode = mode === SEARCH_INVENTORY_MODE_TRADE ? SEARCH_INVENTORY_MODE_TRADE : SEARCH_INVENTORY_MODE_SEARCH;
    this.#tradeSessionId = String(sessionId ?? "");
    this.#tradeCurrencyKey = normalizeTradeCurrencyKey(tradeCurrencyKey);
    this.#tradeKind = tradeKind === SEARCH_INVENTORY_TRADE_KIND_PERSONAL
      ? SEARCH_INVENTORY_TRADE_KIND_PERSONAL
      : SEARCH_INVENTORY_TRADE_KIND_REGULAR;
    this.#tradeRole = tradeRole === TRADE_ROLE_OBSERVER ? TRADE_ROLE_OBSERVER : TRADE_ROLE_PARTICIPANT;
    this.#tradeSide = TRADE_OFFER_SIDES.includes(tradeSide) ? tradeSide : "";
    this.#tradeSessionSnapshot = null;
    this.#tradeSessionRevision = 0;
    this.#tradeOffers = createEmptyTradeOffers();
    this.#tradeCatalogEnabledCategories.clear();
    this.#tradeCatalogExpandedWeaponGroups.clear();
    this.#clearTradeCompatibilityHighlight();
    if (tradeSnapshot) this.#applyTradeSessionSnapshot(tradeSnapshot, { render: false });
    this.#tradeCompletionInProgress = false;
    this.#tradeEquipmentCollapsed = this.#isTradeMode();
    this.#clearInventoryDropPreview();
  }

  matchesTradeSession(sessionId) {
    return this.#isTradeMode() && this.#tradeSessionId === String(sessionId ?? "");
  }

  async closeTradeSessionFromSocket(sessionId) {
    if (!this.matchesTradeSession(sessionId)) return undefined;
    this.#suppressCloseBroadcast = true;
    return this.close({ force: true });
  }

  setTradeCurrencyKey(currencyKey) {
    if (this.#tradeSessionSnapshot) return;
    this.#setTradeCurrencyKey(currencyKey);
  }

  setTradeOffersState(state = {}) {
    if (!this.#isTradeMode()) return;
    if (this.#tradeSessionSnapshot) return;
    this.#tradeOffers = normalizeTradeOffersState(state);
    if (this.rendered) {
      this.#captureScrollPositions();
      void this.#renderPreservingWindowStack();
    }
  }

  applyCompletedTradeOffersState(state = {}) {
    if (!this.#isTradeMode()) return;
    this.#tradeOffers = normalizeTradeOffersState(state);
    if (this.rendered) {
      this.#captureScrollPositions();
      void this.#renderPreservingWindowStack();
    }
  }

  beginTradeCompletionLock() {
    if (this.#tradeCompletionInProgress) return;
    this.#tradeCompletionInProgress = true;
    this.#beginInventoryMutation();
  }

  endTradeCompletionLock({ render = true } = {}) {
    if (!this.#tradeCompletionInProgress) return;
    this.#tradeCompletionInProgress = false;
    this.#endInventoryMutation();
    if (render && this.rendered) {
      this.#captureScrollPositions();
      void this.#renderPreservingWindowStack();
    }
  }

  setTradeSessionSnapshot(snapshot = {}) {
    this.#applyTradeSessionSnapshot(snapshot, { render: true });
  }

  #applyTradeSessionSnapshot(snapshot = {}, { render = false } = {}) {
    if (!snapshot?.sessionId) return;
    if (this.#tradeSessionId && snapshot.sessionId !== this.#tradeSessionId) return;
    const revision = Math.max(0, toInteger(snapshot.revision));
    if (revision && revision <= this.#tradeSessionRevision) return;
    this.#tradeSessionId = String(snapshot.sessionId ?? this.#tradeSessionId);
    this.#tradeSessionRevision = revision;
    this.#tradeSessionSnapshot = normalizeTradeSessionSnapshot(snapshot);
    this.#tradeCurrencyKey = normalizeTradeCurrencyKey(this.#tradeSessionSnapshot.tradeCurrencyKey);
    this.#tradeOffers = normalizeTradeOffersState(this.#tradeSessionSnapshot.offers);
    const userId = game.user?.id ?? "";
    const participantSide = getTradeSessionUserParticipantSide(this.#tradeSessionSnapshot, userId);
    if (participantSide) {
      this.#tradeRole = TRADE_ROLE_PARTICIPANT;
      this.#tradeSide = participantSide;
    } else if ((this.#tradeSessionSnapshot.observers ?? []).some(observer => observer.userId === userId)) {
      this.#tradeRole = TRADE_ROLE_OBSERVER;
      this.#tradeSide = "";
    }
    const selected = getTradeSnapshotSelectedActorUuids(this.#tradeSessionSnapshot, userId);
    this.#searcherActorUuid = selected.searcher || this.#searcherActorUuid;
    this.#searchedActorUuid = selected.searched || this.#searchedActorUuid;
    this.#pruneTradeCatalogCategoryState();
    if (render && this.rendered) {
      this.#captureScrollPositions();
      void this.#renderPreservingWindowStack();
    }
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    this.#searcherActor = await resolveActor(this.#searcherActorUuid);
    this.#searchedActor = await resolveActor(this.#searchedActorUuid);

    const canInteract = this.#canInteract();
    const isTrade = this.#isTradeMode();
    const canButcher = !isTrade
      && canInteract
      && canStartActorButchering(this.#searchedActor);
    const tradeSideBarterValues = isTrade ? this.#getTradeSideBarterValues() : null;
    const tradeContext = isTrade ? this.#prepareTradeContext(tradeSideBarterValues) : null;
    const searcherSelector = isTrade ? this.#prepareTradeActorSelector("searcher") : null;
    const searchedSelector = isTrade ? this.#prepareTradeActorSelector("searched") : null;
    const canManageSearcher = this.#tradeOffers.completed ? this.#canClaimCompletedTradeSide("searcher") : this.#canManageTradeOfferSide("searcher");
    const canManageSearched = this.#tradeOffers.completed ? this.#canClaimCompletedTradeSide("searched") : this.#canManageTradeOfferSide("searched");
    const canConfirmSearcher = this.#canConfirmTradeSide("searcher");
    const canConfirmSearched = this.#isPersonalTradeMode() ? false : this.#canConfirmTradeSide("searched");
    return {
      ...context,
      canInteract,
      canButcher,
      isTrade,
      isObserver: isTrade && this.#tradeRole === TRADE_ROLE_OBSERVER,
      trade: tradeContext,
      fallbackIcon: FALLBACK_ICON,
      actors: [
        prepareSearchActorContext(this.#searcherActor, {
          side: "searcher",
          roleLabel: "Обыскивающий",
          canInteract: isTrade ? canManageSearcher : canInteract,
          mode: this.#mode,
          tradeCurrencyKey: this.#tradeCurrencyKey,
          tradeOffer: tradeContext?.offers?.searcher,
          tradeCatalogEnabledCategories: this.#getTradeCatalogEnabledCategories(this.#searcherActor?.uuid ?? this.#searcherActorUuid),
          tradeCatalogExpandedWeaponGroups: this.#getTradeCatalogExpandedWeaponGroups(this.#searcherActor?.uuid ?? this.#searcherActorUuid),
          sideBarterValues: tradeSideBarterValues,
          equipmentCollapsed: this.#tradeEquipmentCollapsed,
          selector: searcherSelector,
          canControl: canManageSearcher,
          canConfirm: canConfirmSearcher,
          showConfirm: true
        }),
        prepareSearchActorContext(this.#searchedActor, {
          side: "searched",
          roleLabel: "Обыскиваемый",
          canInteract: isTrade ? canManageSearched : canInteract,
          mode: this.#mode,
          tradeCurrencyKey: this.#tradeCurrencyKey,
          tradeOffer: tradeContext?.offers?.searched,
          tradeCatalogEnabledCategories: this.#getTradeCatalogEnabledCategories(this.#searchedActor?.uuid ?? this.#searchedActorUuid),
          tradeCatalogExpandedWeaponGroups: this.#getTradeCatalogExpandedWeaponGroups(this.#searchedActor?.uuid ?? this.#searchedActorUuid),
          sideBarterValues: tradeSideBarterValues,
          equipmentCollapsed: this.#tradeEquipmentCollapsed,
          selector: searchedSelector,
          canControl: canManageSearched,
          canConfirm: canConfirmSearched,
          showConfirm: !this.#isPersonalTradeMode()
        })
      ].filter(Boolean)
    };
  }

  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    this.#renderRefresh = foundry.utils.debounce(() => {
      if (!this.rendered) return;
      this.#captureScrollPositions();
      void this.#renderPreservingWindowStack();
    }, 60);
    this.#hookIds = [
      ["updateActor", Hooks.on("updateActor", actor => this.#scheduleRefreshForActor(actor))],
      ["deleteActor", Hooks.on("deleteActor", actor => this.#handleActorDeleted(actor))],
      ["createItem", Hooks.on("createItem", item => this.#scheduleRefreshForActor(item?.parent))],
      ["updateItem", Hooks.on("updateItem", item => this.#scheduleRefreshForActor(item?.parent, item?.id))],
      ["deleteItem", Hooks.on("deleteItem", item => this.#scheduleRefreshForActor(item?.parent, item?.id))]
    ];
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#hoverPreviewInputKey = "";
    this.#hoverPreviewKey = "";
    if (!this.minimized) this.setPosition();
    this.#bindViewportResize();
    this._dragDrop.bind(this.element);
    this.#bindInventoryTooltipListeners();
    this.#activateWeaponSlotAspectSizing();
    this.#cancelInventoryTooltipClose();
    this.#restoreScrollPositions(() => this.#restoreInventoryTooltipAfterRender());
    this.#syncRenderedTradeOfferColumns();
    this.#applyTradeCompatibilityHighlight();
  }

  #renderPreservingWindowStack(options = {}) {
    if (this.rendered) this.#captureScrollPositions();
    const result = this.render({ ...options, force: !this.rendered });
    return result;
  }

  async _onClose(options) {
    await super._onClose(options);
    this.#unbindViewportResize();
    for (const [hookName, hookId] of this.#hookIds) Hooks.off(hookName, hookId);
    this.#hookIds = [];
    this.#clearInventoryDropPreview();
    this.#clearTradeCompatibilityHighlight();
    this.#draggedItemData = null;
    this.#draggedItemId = "";
    this.#draggedActorUuid = "";
    this.#draggedTradeOfferKind = "";
    this.#draggedTradeOfferKey = "";
    this.#clearInventoryTooltip({ force: true });
    this.#unbindInventoryTooltipDocumentClose();
    this.#scrollPositions.clear();
    if (this.#isTradeMode() && this.#tradeSessionId && !this.#suppressCloseBroadcast) {
      if (this.#tradeSessionSnapshot) {
        void requestTradeSessionAction("leaveTradeSession", this.#prepareTradeSessionActionPayload({
          role: this.#tradeRole,
          side: this.#tradeSide
        })).catch(error => console.error(`${SYSTEM_ID} | Trade leave failed`, error));
      } else {
        broadcastTradeSessionClose(this.#tradeSessionId);
      }
    }
    this.#suppressCloseBroadcast = false;
    if (searchInventoryWindow === this) searchInventoryWindow = null;
  }

  #getFullscreenPosition(position = {}) {
    const { viewportWidth, viewportHeight } = this.#getViewportMetrics();
    const scale = Math.max(
      0.1,
      Math.min(
        viewportWidth / SEARCH_INVENTORY_REFERENCE_WIDTH,
        viewportHeight / SEARCH_INVENTORY_REFERENCE_HEIGHT
      ) || 1
    );
    const width = SEARCH_INVENTORY_REFERENCE_WIDTH;
    const height = SEARCH_INVENTORY_REFERENCE_HEIGHT;
    return {
      ...position,
      left: Math.max(0, (viewportWidth - (width * scale)) / 2),
      top: Math.max(0, (viewportHeight - (height * scale)) / 2),
      width,
      height,
      scale
    };
  }

  #getViewportMetrics() {
    const view = this.element?.ownerDocument?.defaultView ?? window;
    const documentElement = view.document?.documentElement ?? document.documentElement;
    return {
      view,
      viewportWidth: view.innerWidth || documentElement?.clientWidth || SEARCH_INVENTORY_FALLBACK_VIEWPORT_WIDTH,
      viewportHeight: view.innerHeight || documentElement?.clientHeight || SEARCH_INVENTORY_FALLBACK_VIEWPORT_HEIGHT
    };
  }

  #applyUiScale(scale = 1) {
    const normalizedScale = Math.max(0.1, Number(scale) || 1);
    this.#uiScale = normalizedScale;
    this.element?.style?.setProperty("--fallout-maw-ui-scale", String(normalizedScale));
  }

  #bindViewportResize() {
    if (this.#viewportResizeHandler) return;
    const { view } = this.#getViewportMetrics();
    this.#viewportResizeHandler = () => {
      if (!this.minimized) this.setPosition();
    };
    view.addEventListener("resize", this.#viewportResizeHandler);
  }

  #unbindViewportResize() {
    if (!this.#viewportResizeHandler) return;
    const { view } = this.#getViewportMetrics();
    view.removeEventListener("resize", this.#viewportResizeHandler);
    this.#viewportResizeHandler = null;
  }

  #activateWeaponSlotAspectSizing() {
    const images = this.element?.querySelectorAll(".fallout-maw-weapon-slot .fallout-maw-inventory-item > img") ?? [];
    for (const image of images) {
      const applyAspect = () => setWeaponSlotImageAspect(image);
      if (image.complete && image.naturalWidth && image.naturalHeight) applyAspect();
      else image.addEventListener("load", applyAspect, { once: true });
    }
  }

  #captureScrollPositions() {
    this.element?.querySelectorAll("[data-search-scroll-key]").forEach(element => {
      const key = String(element.dataset.searchScrollKey ?? "");
      if (!key) return;
      this.#scrollPositions.set(key, {
        left: element.scrollLeft ?? 0,
        top: element.scrollTop ?? 0,
        anchor: this.#getScrollAnchorPosition(element)
      });
    });
  }

  #getScrollAnchorPosition(scrollElement) {
    const anchor = this.#findScrollAnchorElement(scrollElement);
    const selector = anchor ? this.#getScrollAnchorSelector(anchor) : "";
    if (!anchor || !selector) return null;
    const scrollRect = scrollElement.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    return {
      selector,
      left: anchorRect.left - scrollRect.left,
      top: anchorRect.top - scrollRect.top
    };
  }

  #findScrollAnchorElement(scrollElement) {
    const scrollRect = scrollElement.getBoundingClientRect();
    const anchorGroups = [
      "[data-inventory-grid-item][data-inventory-parent-id][data-item-id][data-search-actor-uuid]",
      "[data-tooltip-item][data-item-id][data-search-actor-uuid]",
      "[data-trade-offer-entry][data-trade-offer-kind][data-trade-offer-side][data-trade-offer-key]"
    ];
    for (const selector of anchorGroups) {
      const candidates = Array.from(scrollElement.querySelectorAll(selector))
        .map(element => ({ element, rect: element.getBoundingClientRect() }))
        .filter(({ rect }) => rect.bottom > scrollRect.top && rect.top < scrollRect.bottom)
        .sort((left, right) => {
          const leftDistance = Math.abs(left.rect.top - scrollRect.top);
          const rightDistance = Math.abs(right.rect.top - scrollRect.top);
          return leftDistance - rightDistance;
        });
      if (candidates.length) return candidates[0].element;
    }
    return null;
  }

  #getScrollAnchorSelector(anchor) {
    if (anchor.matches("[data-inventory-grid-item][data-inventory-parent-id][data-item-id][data-search-actor-uuid]")) {
      const actorUuid = String(anchor.dataset.searchActorUuid ?? "");
      const itemId = String(anchor.dataset.itemId ?? "");
      const parentId = String(anchor.dataset.inventoryParentId ?? "");
      if (!actorUuid || !itemId) return "";
      const stackSelector = getStackAnchorSelector(anchor);
      return `[data-inventory-grid-item][data-inventory-parent-id="${CSS.escape(parentId)}"][data-search-actor-uuid="${CSS.escape(actorUuid)}"][data-item-id="${CSS.escape(itemId)}"]${stackSelector}`;
    }
    if (anchor.matches("[data-trade-offer-entry][data-trade-offer-kind][data-trade-offer-side][data-trade-offer-key]")) {
      const side = String(anchor.dataset.tradeOfferSide ?? "");
      const kind = String(anchor.dataset.tradeOfferKind ?? "");
      const key = String(anchor.dataset.tradeOfferKey ?? "");
      if (!side || !kind || !key) return "";
      return `[data-trade-offer-entry][data-trade-offer-side="${CSS.escape(side)}"][data-trade-offer-kind="${CSS.escape(kind)}"][data-trade-offer-key="${CSS.escape(key)}"]`;
    }
    if (anchor.matches("[data-tooltip-item][data-item-id][data-search-actor-uuid]")) {
      const actorUuid = String(anchor.dataset.searchActorUuid ?? "");
      const itemId = String(anchor.dataset.itemId ?? "");
      if (!actorUuid || !itemId) return "";
      const stackSelector = getStackAnchorSelector(anchor);
      return `[data-tooltip-item][data-search-actor-uuid="${CSS.escape(actorUuid)}"][data-item-id="${CSS.escape(itemId)}"]${stackSelector}`;
    }
    return "";
  }

  #restoreScrollPositions(afterRestore = null) {
    if (!this.rendered) return;
    for (const element of this.element?.querySelectorAll("[data-search-scroll-key]") ?? []) {
      const key = String(element.dataset.searchScrollKey ?? "");
      const position = this.#scrollPositions.get(key);
      if (!position) continue;
      element.scrollLeft = position.left;
      element.scrollTop = position.top;
      const anchor = position.anchor?.selector ? element.querySelector(position.anchor.selector) : null;
      if (!anchor) continue;
      for (let pass = 0; pass < 3; pass += 1) {
        const scrollRect = element.getBoundingClientRect();
        const anchorRect = anchor.getBoundingClientRect();
        const leftDelta = (anchorRect.left - scrollRect.left) - position.anchor.left;
        const topDelta = (anchorRect.top - scrollRect.top) - position.anchor.top;
        if (Math.abs(leftDelta) < 0.5 && Math.abs(topDelta) < 0.5) break;
        element.scrollLeft += leftDelta;
        element.scrollTop += topDelta;
      }
    }
    if (typeof afterRestore === "function") afterRestore();
  }

  _canDragStart() {
    return this.#canInteract();
  }

  _canDragDrop() {
    return this.#canInteract();
  }

  async _onDragStart(event) {
    resetInventoryHoverCheckerCache();
    this.#clearInventoryTooltip({ force: true });
    this.#clearInventoryDropPreview();
    this.#draggedTradeOfferKind = "";
    this.#draggedTradeOfferKey = "";
    const offerEntry = event.currentTarget?.closest?.("[data-trade-offer-entry]");
    if (this.#isTradeMode() && this.#tradeOffers.completed && offerEntry) {
      const side = String(offerEntry.dataset.tradeOfferSide ?? "");
      const kind = String(offerEntry.dataset.tradeOfferKind ?? "");
      const key = String(offerEntry.dataset.tradeOfferKey ?? "");
      if (!this.#canClaimCompletedTradeSide(side)) return;
      const entry = findTradeOfferEntry(this.#tradeOffers?.[side], kind, key);
      const itemData = kind === "item"
        ? getTradeOfferEntryItemData(entry, this.#getActorByUuid(String(entry?.sourceActorUuid ?? "")))
        : null;
      this.#draggedItemId = String(entry?.itemId ?? key);
      this.#draggedActorUuid = String(entry?.sourceActorUuid ?? "");
      this.#draggedItemData = itemData;
      this.#draggedTradeOfferKind = kind;
      this.#draggedTradeOfferKey = key;
      if (itemData) this.#highlightEquipmentSlotsForItem(itemData);
      event.dataTransfer?.setData("text/plain", JSON.stringify({
        type: "Item",
        uuid: "",
        itemId: String(entry?.itemId ?? key),
        actorUuid: String(entry?.sourceActorUuid ?? ""),
        sourceActorUuid: String(entry?.sourceActorUuid ?? ""),
        falloutMawTradeOffer: true,
        tradeOfferSide: side,
        tradeOfferKind: kind,
        tradeOfferKey: key,
        falloutMawSearchInventory: true
      }));
      event.currentTarget?.classList?.add("dragging");
      return;
    }
    const itemElement = event.currentTarget?.closest?.("[data-item-id][data-search-actor-uuid]");
    const itemId = String(itemElement?.dataset?.itemId ?? "");
    const actorUuid = String(itemElement?.dataset?.searchActorUuid ?? "");
    const stackIndex = Math.max(0, toInteger(itemElement?.dataset?.stackIndex));
    const stackQuantity = Math.max(0, toInteger(itemElement?.dataset?.stackQuantity));
    const tradeCatalogPhantom = itemElement?.dataset?.tradeCatalogPhantom !== undefined;
    const tradeCatalogAggregate = itemElement?.dataset?.tradeCatalogAggregate !== undefined;
    const actor = this.#getActorByUuid(actorUuid);
    const item = actor?.items?.get(itemId);
    if (!item || !this.#canInteract()) return;

    this.#draggedItemId = item.id;
    this.#draggedActorUuid = actor.uuid;
    this.#draggedItemData = item.toObject();
    if (usesVirtualInventoryStacks(item)) {
      foundry.utils.setProperty(this.#draggedItemData, "system.quantity", tradeCatalogAggregate
        ? (stackQuantity || getItemQuantity(item))
        : (stackQuantity || getItemStackPartQuantity(item, stackIndex)));
    }
    this.#draggedTradeOfferKind = String(offerEntry?.dataset?.tradeOfferKind ?? "");
    this.#draggedTradeOfferKey = String(offerEntry?.dataset?.tradeOfferKey ?? "");
    this.#highlightEquipmentSlotsForItem(this.#draggedItemData);
    event.dataTransfer?.setData("text/plain", JSON.stringify({
      type: "Item",
      uuid: item.uuid,
      itemId: item.id,
      stackIndex,
      stackQuantity: stackQuantity || (usesVirtualInventoryStacks(item) ? getItemStackPartQuantity(item, stackIndex) : getItemQuantity(item)),
      actorUuid: actor.uuid,
      sourceActorUuid: actor.uuid,
      falloutMawTradeOffer: Boolean(offerEntry),
      tradeOfferSide: String(offerEntry?.dataset?.tradeOfferSide ?? ""),
      tradeOfferKind: String(offerEntry?.dataset?.tradeOfferKind ?? ""),
      tradeOfferKey: String(offerEntry?.dataset?.tradeOfferKey ?? ""),
      falloutMawTradeCatalogPhantom: tradeCatalogPhantom,
      falloutMawTradeCatalogAggregate: tradeCatalogAggregate,
      falloutMawSearchInventory: true
    }));
    event.currentTarget?.classList?.add("dragging");
  }

  _onDragOver(event) {
    event.stopPropagation();
    const zone = this.#getDropZone(event);
    if (!zone || !this.#canInteract()) return;
    this.#clearInventoryTooltip({ force: true });
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    this.#draggedItemData = this.#getPreviewItemData(event);
    const data = this.#getDragEventData(event);
    if (this.#isTradeMode() && (data?.falloutMawTradeCatalogPhantom || (data?.falloutMawTradeOffer && !this.#tradeOffers.completed))) {
      const tradeOfferZone = zone.dataset.tradeOfferActorUuid !== undefined || Boolean(zone.closest?.("[data-trade-offer-grid]"));
      if (!tradeOfferZone) {
        this.#clearInventoryHoverPreview();
        return;
      }
    }
    this.#setInventoryHoverPreview(zone, event);
  }

  _onDragEnd() {
    this.#draggedItemData = null;
    this.#draggedItemId = "";
    this.#draggedActorUuid = "";
    this.#draggedTradeOfferKind = "";
    this.#draggedTradeOfferKey = "";
    this.#clearInventoryDropPreview();
    this.element?.querySelectorAll(".dragging").forEach(element => element.classList.remove("dragging"));
  }

  async _onDrop(event) {
    event.stopPropagation();
    const data = this.#getDragEventData(event);
    try {
      if (data?.type !== "Item" || !this.#canInteract()) return null;

      if (this.#isTradeMode() && this.#tradeOffers.completed && data.falloutMawTradeOffer) {
        return await this.#dropCompletedTradeOfferEntry({ data, event });
      }

      const sourceActor = this.#getActorByUuid(String(data.sourceActorUuid ?? data.actorUuid ?? ""));
      const item = sourceActor?.items?.get(String(data.itemId ?? ""));
      if (!sourceActor || !item) return null;
      const sourceStackIndex = Math.max(0, toInteger(data.stackIndex));
      const sourceStackQuantity = Math.max(0, toInteger(data.stackQuantity));
      const sourceAggregateStack = Boolean(data.falloutMawTradeCatalogAggregate);
      const draggedItemData = item.toObject();
      if (usesVirtualInventoryStacks(item)) {
        foundry.utils.setProperty(draggedItemData, "system.quantity", sourceAggregateStack
          ? (sourceStackQuantity || getItemQuantity(item))
          : (sourceStackQuantity || getItemStackPartQuantity(item, sourceStackIndex)));
      }

      const zone = this.#getDropZone(event);
      const tradeOfferActorUuid = String(zone?.dataset?.tradeOfferActorUuid ?? zone?.closest?.("[data-trade-offer-actor-uuid]")?.dataset?.tradeOfferActorUuid ?? "");
      if (this.#isTradeMode() && tradeOfferActorUuid) {
        if (data.falloutMawTradeOffer) return await this.#moveTradeOfferEntry({ data, item, zone, event });
        if (this.#tradeOffers.completed) return await this.#addItemToCompletedTradeHub({ sourceActor, item, offerActorUuid: tradeOfferActorUuid, event, zone });
        return await this.#addItemToTradeOffer({ sourceActor, item, offerActorUuid: tradeOfferActorUuid, event, zone });
      }
      if (this.#isTradeMode() && data.falloutMawTradeOffer && !this.#tradeOffers.completed) return null;
      if (this.#isTradeMode() && data.falloutMawTradeCatalogPhantom) return null;
      const targetActorUuid = String(zone?.dataset?.searchActorUuid ?? zone?.closest?.("[data-search-actor-uuid]")?.dataset?.searchActorUuid ?? "");
      const targetActor = this.#getActorByUuid(targetActorUuid);
      if (!targetActor) return null;
      const completedTradeOfferDrop = Boolean(this.#isTradeMode() && this.#tradeOffers.completed && data.falloutMawTradeOffer);
      if (this.#isTradeMode() && sourceActor.uuid !== targetActor.uuid && !completedTradeOfferDrop) {
        ui.notifications.warn("В торговле предметы сначала кладутся в предложение.");
        return null;
      }

      const placementRequest = getDropZonePlacementRequest(zone);
      const parentId = placementRequest.mode === "inventory" ? getDropZoneParentId(zone) : ROOT_CONTAINER_ID;
      const targetElement = getInventoryGridItemElementAtPointer(event, this.element)
        ?? zone?.closest?.("[data-inventory-grid-item][data-item-id]");
      const targetStackIndex = Math.max(0, toInteger(targetElement?.dataset?.stackIndex));
      const pointedTargetItem = (
        targetElement
        && String(targetElement.dataset.searchActorUuid ?? "") === targetActor.uuid
        && String(targetElement.dataset.inventoryParentId ?? ROOT_CONTAINER_ID) === String(parentId ?? ROOT_CONTAINER_ID)
      )
        ? targetActor.items.get(String(targetElement.dataset.itemId ?? "")) ?? null
        : null;
      const targetItem = (
        targetActor.uuid === sourceActor.uuid
        && usesVirtualInventoryStacks(item)
        && targetElement?.dataset?.itemId === item.id
        && targetStackIndex !== sourceStackIndex
      )
        ? item
        : (
          pointedTargetItem && (targetActor.uuid !== sourceActor.uuid || pointedTargetItem.id !== item.id)
            ? pointedTargetItem
            : this.#getTargetStackItem(zone, targetActor, item.id, parentId)
        );
      if (canStackItems(draggedItemData, targetItem)) {
        const quantity = await this.#getSearchStackQuantity(item, targetItem, event, { sourceActor, targetActor, sourceStackIndex, sourceStackQuantity, targetStackIndex });
        if (!quantity) return null;
        return await this.#executeSearchStackTransfer({
          searcherActorUuid: this.#searcherActorUuid,
          searchedActorUuid: this.#searchedActorUuid,
          sourceActorUuid: sourceActor.uuid,
          targetActorUuid: targetActor.uuid,
          itemId: item.id,
          targetItemId: targetItem.id,
          targetParentId: parentId,
          sourceStackIndex,
          targetStackIndex,
          quantity
        });
      }
      const pointerPlacement = placementRequest.mode === "inventory"
        ? getSearchDropPlacementForPointer({
          actor: targetActor,
          itemData: draggedItemData,
          sourceActor,
          sourceItemId: item.id,
          parentId,
          event,
          zone
        })
        : null;
      const quantity = await this.#getSearchTransferQuantity(item, event, { sourceActor, targetActor, sourceStackIndex, sourceStackQuantity });
      if (!quantity) return null;
      const payload = {
        searcherActorUuid: this.#searcherActorUuid,
        searchedActorUuid: this.#searchedActorUuid,
        sourceActorUuid: sourceActor.uuid,
        targetActorUuid: targetActor.uuid,
        itemId: item.id,
        targetMode: placementRequest.mode,
        targetParentId: parentId,
        targetEquipmentSlot: placementRequest.equipmentSlot,
        targetWeaponSet: placementRequest.weaponSet,
        targetWeaponSlot: placementRequest.weaponSlot,
        targetX: pointerPlacement?.x ?? (placementRequest.mode === "inventory" && zone?.dataset?.inventoryCell !== undefined ? toInteger(zone.dataset.x) : null),
        targetY: pointerPlacement?.y ?? (placementRequest.mode === "inventory" && zone?.dataset?.inventoryCell !== undefined ? toInteger(zone.dataset.y) : null),
        targetItemId: targetItem?.id ?? "",
        sourceStackIndex,
        quantity
      };

      const moved = await this.#executeSearchTransfer(payload);
      if (moved && this.#tradeOffers.completed && data.falloutMawTradeOffer) {
        if (this.#tradeSessionSnapshot) {
          const result = await requestTradeSessionAction("reduceCompletedTradeEntry", this.#prepareTradeSessionActionPayload({
            side: String(data.tradeOfferSide ?? ""),
            kind: String(data.tradeOfferKind ?? ""),
            key: String(data.tradeOfferKey ?? ""),
            quantity
          }));
          if (result?.snapshot) this.#applyTradeSessionSnapshot(result.snapshot, { render: true });
          return moved;
        }
        this.#tradeOffers = reduceTradeOfferEntryQuantity(
          this.#tradeOffers,
          String(data.tradeOfferSide ?? ""),
          String(data.tradeOfferKind ?? ""),
          String(data.tradeOfferKey ?? ""),
          quantity
        );
        this.#broadcastTradeOffers();
        this.#captureScrollPositions();
        await this.#renderPreservingWindowStack();
      }
      return moved;
    } finally {
      this.#draggedItemData = null;
      this.#draggedItemId = "";
      this.#draggedActorUuid = "";
      this.#draggedTradeOfferKind = "";
      this.#draggedTradeOfferKey = "";
      this.#clearInventoryDropPreview();
      this.element?.querySelectorAll(".dragging").forEach(element => element.classList.remove("dragging"));
    }
  }

  async #dropCompletedTradeOfferEntry({ data = {}, event = null } = {}) {
    const side = String(data.tradeOfferSide ?? "");
    const kind = String(data.tradeOfferKind ?? "");
    const key = String(data.tradeOfferKey ?? "");
    if (!TRADE_OFFER_SIDES.includes(side) || !this.#canClaimCompletedTradeSide(side)) return null;

    const zone = this.#getDropZone(event);
    if (zone?.dataset?.tradeOfferActorUuid !== undefined || zone?.closest?.("[data-trade-offer-grid]")) return null;
    const targetActorUuid = String(zone?.dataset?.searchActorUuid ?? zone?.closest?.("[data-search-actor-uuid]")?.dataset?.searchActorUuid ?? "");
    const targetActor = this.#getActorByUuid(targetActorUuid);
    if (!targetActor || this.#getTradeSideForActor(targetActor.uuid) !== side) return null;

    if (kind === "currency") return this.#claimCompletedTradeCurrency({ side, key, targetActor });
    if (kind !== "item") return null;

    const entry = findTradeOfferEntry(this.#tradeOffers?.[side], "item", key);
    const itemData = getTradeOfferEntryItemData(entry, this.#getActorByUuid(String(entry?.sourceActorUuid ?? "")));
    if (!entry || !itemData) return null;

    const available = Math.max(1, toInteger(entry.quantity));
    const placementRequest = getDropZonePlacementRequest(zone);
    const parentId = placementRequest.mode === "inventory" ? getDropZoneParentId(zone) : ROOT_CONTAINER_ID;
    const targetItem = this.#getTargetStackItem(zone, targetActor, String(data.itemId ?? ""), parentId);
    const quantity = available;

    const pointerPlacement = placementRequest.mode === "inventory"
      ? getSearchDropPlacementForPointer({
        actor: targetActor,
        itemData,
        sourceActor: null,
        sourceItemId: "",
        parentId,
        event,
        zone
      })
      : null;
    const payload = this.#prepareTradeSessionActionPayload({
      offers: this.#tradeOffers,
      side,
      kind,
      key,
      targetActorUuid: targetActor.uuid,
      targetMode: placementRequest.mode,
      targetParentId: parentId,
      targetEquipmentSlot: placementRequest.equipmentSlot,
      targetWeaponSet: placementRequest.weaponSet,
      targetWeaponSlot: placementRequest.weaponSlot,
      targetX: pointerPlacement?.x ?? (placementRequest.mode === "inventory" && zone?.dataset?.inventoryCell !== undefined ? toInteger(zone.dataset.x) : null),
      targetY: pointerPlacement?.y ?? (placementRequest.mode === "inventory" && zone?.dataset?.inventoryCell !== undefined ? toInteger(zone.dataset.y) : null),
      targetItemId: targetItem?.id ?? "",
      quantity
    });

    try {
      this.#beginInventoryMutation();
      if (this.#tradeSessionSnapshot) {
        const result = await requestTradeSessionAction("claimCompletedTradeEntry", payload);
        if (result?.snapshot) this.#applyTradeSessionSnapshot(result.snapshot, { render: false });
        this.#captureScrollPositions();
        await this.#renderPreservingWindowStack();
        return result;
      }
      const result = await enqueueSearchInventoryOperation(() => performCompletedTradeEntryClaim(payload, game.user?.id ?? ""));
      this.#tradeOffers = normalizeTradeOffersState(result?.offers ?? this.#tradeOffers);
      this.#broadcastTradeOffers();
      this.#captureScrollPositions();
      await this.#renderPreservingWindowStack();
      return result;
    } catch (error) {
      console.error(`${SYSTEM_ID} | Completed trade claim failed`, error);
      ui.notifications.warn(error.message || "Не удалось перенести купленное.");
      return null;
    } finally {
      this.#endInventoryMutation();
    }
  }

  async #claimCompletedTradeCurrency({ side = "", key = "", targetActor = null } = {}) {
    const entry = findTradeOfferEntry(this.#tradeOffers?.[side], "currency", key);
    const available = Math.max(0, toInteger(entry?.amount));
    if (!targetActor || !available) return null;
    const currency = getCurrencySettings().find(option => option.key === key);
    const formData = available > 1 ? await DialogV2.input({
      window: { title: "Перенести валюту" },
      content: `
        <p><strong>${escapeHTML(currency?.label ?? key)}</strong>: 1 / ${available}</p>
        <label class="fallout-maw-stacked-field">
          <span>${game.i18n.localize("FALLOUTMAW.Item.Quantity")}</span>
          <input type="number" name="amount" value="${available}" min="1" max="${available}" step="1" autofocus>
        </label>
      `,
      ok: {
        label: "Перенести",
        icon: "fa-solid fa-coins",
        callback: (_event, okButton) => new FormDataExtended(okButton.form).object
      },
      buttons: [{
        action: "cancel",
        label: game.i18n.localize("FALLOUTMAW.Common.Cancel")
      }],
      position: { width: 420 },
      rejectClose: false
    }) : { amount: available };
    if (!formData || formData === "cancel") return null;
    const amount = Math.max(1, Math.min(available, toInteger(formData.amount)));
    const payload = this.#prepareTradeSessionActionPayload({
      offers: this.#tradeOffers,
      side,
      kind: "currency",
      key,
      targetActorUuid: targetActor.uuid,
      quantity: amount
    });
    try {
      if (this.#tradeSessionSnapshot) {
        const result = await requestTradeSessionAction("claimCompletedTradeEntry", payload);
        if (result?.snapshot) this.#applyTradeSessionSnapshot(result.snapshot, { render: true });
        return result;
      }
      const result = await enqueueSearchInventoryOperation(() => performCompletedTradeEntryClaim(payload, game.user?.id ?? ""));
      this.#tradeOffers = normalizeTradeOffersState(result?.offers ?? this.#tradeOffers);
      this.#broadcastTradeOffers();
      this.#captureScrollPositions();
      await this.#renderPreservingWindowStack();
      return result;
    } catch (error) {
      console.error(`${SYSTEM_ID} | Completed trade currency claim failed`, error);
      ui.notifications.warn(error.message || "Не удалось перенести валюту.");
      return null;
    }
  }

  async #getSearchStackQuantity(sourceItem, targetItem, _event, options = {}) {
    const sourceQuantity = usesVirtualInventoryStacks(sourceItem)
      ? Math.max(1, toInteger(options.sourceStackQuantity) || getItemStackPartQuantity(sourceItem, options.sourceStackIndex))
      : Math.max(1, getItemQuantity(sourceItem));
    const availableSpace = usesVirtualInventoryStacks(targetItem)
      ? Math.max(0, getItemMaxStack(targetItem) - getItemStackPartQuantity(targetItem, options.targetStackIndex))
      : Math.max(0, getItemMaxStack(targetItem) - getItemQuantity(targetItem));
    const maxTransfer = Math.min(sourceQuantity, availableSpace);
    return maxTransfer > 0 ? maxTransfer : 0;
  }

  async #getSearchTransferQuantity(sourceItem, _event, options = {}) {
    if (usesVirtualInventoryStacks(sourceItem)) {
      return Math.max(1, toInteger(options.sourceStackQuantity) || getItemStackPartQuantity(sourceItem, options.sourceStackIndex));
    }
    return Math.max(1, getItemQuantity(sourceItem));
  }

  #getTradeQuantityPromptData(sourceActor = null, targetActor = null) {
    if (!this.#isTradeMode() || !sourceActor || !targetActor || sourceActor.uuid === targetActor.uuid) return null;
    const sourceSide = this.#getTradeSideForActor(sourceActor.uuid);
    const targetSide = this.#getTradeSideForActor(targetActor.uuid);
    if (!sourceSide || !targetSide) throw new Error("Trade actor side mismatch.");
    return this.#getTradeQuantityPromptDataForSides(sourceActor, sourceSide, targetSide);
  }

  #getTradeQuantityPromptDataForSides(sourceActor = null, sourceSide = "", targetSide = "") {
    if (!this.#isTradeMode() || !sourceActor || !sourceSide || !targetSide || sourceSide === targetSide) return null;
    const sideBarterValues = this.#getTradeSideBarterValues();
    return {
      currencyKey: this.#tradeCurrencyKey,
      sellerActor: sourceActor,
      barterAdjustmentPercent: getTradeBarterAdjustmentPercent(sideBarterValues[sourceSide], sideBarterValues[targetSide])
    };
  }

  async #addItemToTradeOffer({
    sourceActor = null,
    item = null,
    offerActorUuid = "",
    event = null,
    zone = null,
    sourceStackIndex = null,
    sourceStackQuantity = null,
    sourceWholeStack = false
  } = {}) {
    if (!this.#isTradeMode() || !sourceActor || !item) return null;
    if (sourceActor.uuid !== offerActorUuid) {
      ui.notifications.warn("Предмет кладется в предложение своего владельца.");
      return null;
    }
    const side = this.#getTradeSideForActor(sourceActor.uuid);
    if (!side || !this.#canManageTradeOfferSide(side)) return null;
    if (this.#tradeOffers.completed) return null;

    const dragData = event?.type === "drop" ? this.#getDragEventData(event) : null;
    const aggregateVirtualStack = Boolean(sourceWholeStack || dragData?.falloutMawTradeCatalogAggregate) && usesVirtualInventoryStacks(item);
    const selectedStackIndex = Math.max(0, toInteger(sourceStackIndex ?? dragData?.stackIndex));
    const selectedStackQuantity = Math.max(0, toInteger(sourceStackQuantity ?? dragData?.stackQuantity));
    const alreadyOffered = getTradeOfferedItemQuantity(
      this.#tradeOffers[side],
      item.id,
      sourceActor.uuid,
      usesVirtualInventoryStacks(item) && !aggregateVirtualStack ? selectedStackIndex : null
    );
    const sourceQuantity = aggregateVirtualStack
      ? Math.max(1, getItemQuantity(item))
      : usesVirtualInventoryStacks(item)
      ? Math.max(1, selectedStackQuantity || getItemStackPartQuantity(item, selectedStackIndex))
      : Math.max(1, getItemQuantity(item));
    const remaining = Math.max(0, sourceQuantity - alreadyOffered);
    if (remaining <= 0) {
      ui.notifications.info("Вся штучность предмета уже в предложении.");
      return null;
    }
    const quantity = event?.type === "drop" || remaining <= 1 || isContainerItem(item)
      ? remaining
      : await promptSearchItemStackQuantity({
        item,
        title: "Добавить в предложение",
        actionLabel: "Добавить",
        max: remaining,
        value: remaining,
        trade: this.#getTradeQuantityPromptDataForSides(sourceActor, side, getOppositeTradeSide(side))
      });
    if (!quantity) return null;

    const placement = this.#getTradeOfferDropPlacement({ side, zone, event, item, entryKind: "item", entryKey: item.id });
    if (zone && !placement) return null;
    if (this.#tradeSessionSnapshot) {
      this.#captureScrollPositions();
      const result = await requestTradeSessionAction("addTradeOfferItem", this.#prepareTradeSessionActionPayload({
        side,
        sourceActorUuid: sourceActor.uuid,
        itemId: item.id,
        quantity,
        sourceStackIndex: selectedStackIndex,
        sourceWholeStack: aggregateVirtualStack,
        placement
      }));
      if (result?.snapshot) this.#applyTradeSessionSnapshot(result.snapshot, { render: true });
      return result;
    }
    this.#tradeOffers = addTradeOfferItem(this.#tradeOffers, side, item, quantity, placement, sourceActor.uuid, {
      sourceStackIndex: selectedStackIndex,
      sourceWholeStack: aggregateVirtualStack
    });
    this.#resetTradeReady();
    this.#broadcastTradeOffers();
    this.#captureScrollPositions();
    return this.#renderPreservingWindowStack();
  }

  async #addItemToCompletedTradeHub({ sourceActor = null, item = null, offerActorUuid = "", event = null, zone = null, sourceStackIndex = null, sourceStackQuantity = null } = {}) {
    if (!this.#isTradeMode() || !this.#tradeOffers.completed || !sourceActor || !item) return null;
    const side = this.#getTradeSideForActor(offerActorUuid);
    if (!this.#canDepositCompletedTradeHub(side, sourceActor)) return null;
    const dragData = event?.type === "drop" ? this.#getDragEventData(event) : null;
    const selectedStackIndex = Math.max(0, toInteger(sourceStackIndex ?? dragData?.stackIndex));
    const selectedStackQuantity = Math.max(0, toInteger(sourceStackQuantity ?? dragData?.stackQuantity));
    const sourceQuantity = usesVirtualInventoryStacks(item)
      ? Math.max(1, selectedStackQuantity || getItemStackPartQuantity(item, selectedStackIndex))
      : getTransferItemQuantity(item, getItemQuantity(item));
    const quantity = event?.type === "drop" || sourceQuantity <= 1 || isContainerItem(item)
      ? sourceQuantity
      : await promptSearchItemStackQuantity({
        item,
        title: "Положить в купленное",
        actionLabel: "Положить",
        max: sourceQuantity,
        value: sourceQuantity
      });
    if (!quantity) return null;

    const placement = this.#getTradeOfferDropPlacement({ side, zone, event, item, entryKind: "item", entryKey: item.id });
    if (zone && !placement) return null;
    this.#beginInventoryMutation();
    try {
      if (this.#tradeSessionSnapshot) {
        const result = await requestTradeSessionAction("depositCompletedTradeItem", this.#prepareTradeSessionActionPayload({
          side,
          sourceActorUuid: sourceActor.uuid,
          itemId: item.id,
          quantity,
          sourceStackIndex: selectedStackIndex,
          placement
        }));
        if (result?.snapshot) this.#applyTradeSessionSnapshot(result.snapshot, { render: false });
        this.#captureScrollPositions();
        return await this.#renderPreservingWindowStack();
      }

      const result = await enqueueSearchInventoryOperation(() => performCompletedTradeHubDeposit({
        ...this.#prepareSearchOperationPayload({
          offers: this.#tradeOffers,
          side,
          sourceActorUuid: sourceActor.uuid,
          itemId: item.id,
          quantity,
          sourceStackIndex: selectedStackIndex,
          placement
        }),
        mode: SEARCH_INVENTORY_MODE_TRADE
      }, game.user?.id ?? ""));
      this.#tradeOffers = normalizeTradeOffersState(result?.offers ?? this.#tradeOffers);
      this.#broadcastTradeOffers();
      this.#captureScrollPositions();
      return await this.#renderPreservingWindowStack();
    } finally {
      this.#endInventoryMutation();
    }
  }

  async #moveTradeOfferEntry({ data = {}, item = null, zone = null, event = null } = {}) {
    const side = String(data.tradeOfferSide ?? "");
    const kind = String(data.tradeOfferKind ?? "");
    const key = String(data.tradeOfferKey ?? "");
    const offerActorUuid = String(zone?.dataset?.tradeOfferActorUuid ?? "");
    if (!TRADE_OFFER_SIDES.includes(side) || !kind || !key || !this.#canManageTradeOfferSide(side)) return null;
    if (offerActorUuid !== this.#getActorForTradeSide(side)?.uuid) return null;
    const placement = this.#getTradeOfferDropPlacement({ side, zone, event, item, entryKind: kind, entryKey: key });
    if (!placement) return null;
    if (this.#tradeSessionSnapshot) {
      this.#captureScrollPositions();
      const result = await requestTradeSessionAction("moveTradeOfferEntry", this.#prepareTradeSessionActionPayload({
        side,
        kind,
        key,
        placement,
        columns: getFixedTradeOfferGridColumns()
      }));
      if (result?.snapshot) this.#applyTradeSessionSnapshot(result.snapshot, { render: true });
      return result;
    }
    this.#tradeOffers = updateTradeOfferEntryPlacement(this.#tradeOffers, side, kind, key, placement, getFixedTradeOfferGridColumns());
    if (!this.#tradeOffers.completed) this.#resetTradeReady();
    this.#broadcastTradeOffers();
    this.#captureScrollPositions();
    return this.#renderPreservingWindowStack();
  }

  async #executeSearchStackTransfer(payload, { notify = true } = {}) {
    payload = this.#prepareSearchOperationPayload(payload);
    const sourceActor = this.#getActorByUuid(String(payload?.sourceActorUuid ?? ""));
    const targetActor = this.#getActorByUuid(String(payload?.targetActorUuid ?? ""));
    if (!sourceActor || !targetActor) return false;
    try {
      const responsibleGM = getResponsibleGM();
      if (responsibleGM && responsibleGM.id !== game.user?.id) {
        await requestSearchInventorySocket("stackItem", payload, responsibleGM);
      } else if (canModifySearchTransferDirectly(sourceActor, targetActor)) {
        await enqueueSearchInventoryOperation(() => performSearchInventoryStack(payload, game.user?.id ?? ""));
      } else {
        await requestSearchInventorySocket("stackItem", payload, responsibleGM);
      }
      await this.#finalizeDroppedItemsSearchAfterTransfer(sourceActor);
      return true;
    } catch (error) {
      console.error(`${SYSTEM_ID} | Search inventory stack failed`, error);
      if (notify) ui.notifications.warn(error.message || "Не удалось сложить предметы.");
    }
    return false;
  }

  async #executeSearchTransfer(payload, { notify = true } = {}) {
    payload = this.#prepareSearchOperationPayload(payload);
    const sourceActor = this.#getActorByUuid(String(payload?.sourceActorUuid ?? ""));
    const targetActor = this.#getActorByUuid(String(payload?.targetActorUuid ?? ""));
    if (!sourceActor || !targetActor) return false;
    try {
      const responsibleGM = getResponsibleGM();
      if (responsibleGM && responsibleGM.id !== game.user?.id) {
        await requestSearchInventorySocket("transferItem", payload, responsibleGM);
      } else if (canModifySearchTransferDirectly(sourceActor, targetActor)) {
        await enqueueSearchInventoryOperation(() => performSearchInventoryTransfer(payload, game.user?.id ?? ""));
      } else {
        await requestSearchInventorySocket("transferItem", payload, responsibleGM);
      }
      await this.#finalizeDroppedItemsSearchAfterTransfer(sourceActor);
      return true;
    } catch (error) {
      console.error(`${SYSTEM_ID} | Search inventory transfer failed`, error);
      if (!notify) return false;
      ui.notifications.warn(error.message || "Не удалось перенести предмет.");
    }
    return false;
  }

  async #finalizeDroppedItemsSearchAfterTransfer(sourceActor) {
    if (!sourceActor || !isDroppedItemsActor(sourceActor) || sourceActor.uuid !== this.#searchedActorUuid) return;
    const result = await requestDroppedItemsActorCleanup(sourceActor.uuid);
    const freshActor = game.actors.get(sourceActor.id);
    const hasLoot = freshActor ? droppedItemsActorHasContents(freshActor) : false;
    if (result?.deleted || !hasLoot) void this.close({ force: true });
  }

  #canInteract() {
    if (this.#isTradeMode()) {
      if (this.#tradeRole === TRADE_ROLE_OBSERVER) return false;
      if (this.#tradeSessionSnapshot) return Boolean(game.user?.isGM || this.#canControlTradeSide(this.#tradeSide));
      return Boolean(game.user?.isGM
        || this.#searcherActor?.testUserPermission?.(game.user, "OWNER")
        || this.#searchedActor?.testUserPermission?.(game.user, "OWNER"));
    }
    return Boolean(game.user?.isGM || this.#searcherActor?.testUserPermission?.(game.user, "OWNER"));
  }

  #isTradeMode() {
    return this.#mode === SEARCH_INVENTORY_MODE_TRADE;
  }

  #isPersonalTradeMode() {
    return this.#isTradeMode() && this.#tradeKind === SEARCH_INVENTORY_TRADE_KIND_PERSONAL;
  }

  #prepareSearchOperationPayload(payload = {}) {
    if (!this.#isTradeMode()) return payload;
    return {
      ...payload,
      mode: SEARCH_INVENTORY_MODE_TRADE,
      tradeSessionId: this.#tradeSessionId,
      tradeCurrencyKey: this.#tradeCurrencyKey
    };
  }

  #prepareTradeActorSelector(side = "") {
    const participants = getTradeSnapshotAvailableSideParticipants(this.#tradeSessionSnapshot, side);
    if (!participants.length) return null;
    const selectedUuid = side === "searcher" ? this.#searcherActorUuid : this.#searchedActorUuid;
    const getParticipantLabel = participant => {
      const actor = game.actors?.get(participant?.actorId ?? "") ?? getCachedActorByUuid(participant?.actorUuid);
      return actor ? formatTradeActorName(actor) : String(participant?.actorUuid ?? "");
    };
    const selected = participants.find(participant => participant.actorUuid === selectedUuid) ?? participants.at(0);
    return {
      side,
      canSelect: this.#canSelectTradeActorSide(side) && participants.length > 1,
      options: participants.map(participant => ({
        actorUuid: participant.actorUuid,
        selected: participant.actorUuid === selectedUuid,
        label: getParticipantLabel(participant)
      })),
      label: getParticipantLabel(selected)
    };
  }

  #prepareTradeContext(sideBarterValues = this.#getTradeSideBarterValues()) {
    const offers = prepareTradeOffersContext(this.#tradeOffers, {
      searcherActor: this.#searcherActor,
      searchedActor: this.#searchedActor,
      tradeCurrencyKey: this.#tradeCurrencyKey,
      sideBarterValues
    });
    if (this.#tradeSessionSnapshot) {
      for (const side of TRADE_OFFER_SIDES) {
        const actorUuid = this.#getActorForTradeSide(side)?.uuid ?? "";
        const readyActors = this.#tradeOffers?.[side]?.readyActors ?? [];
        offers[side].ready = Boolean(actorUuid && readyActors.includes(actorUuid));
      }
    }
    const searcherTotal = offers.searcher.total;
    const searchedTotal = offers.searched.total;
    const difference = Math.abs(searcherTotal - searchedTotal);
    offers.searcher.difference = searcherTotal - searchedTotal;
    offers.searcher.differenceLabel = formatTradeOfferDifference(offers.searcher.difference);
    offers.searcher.differenceClass = getTradeOfferDifferenceClass(offers.searcher.difference);
    offers.searched.difference = searchedTotal - searcherTotal;
    offers.searched.differenceLabel = formatTradeOfferDifference(offers.searched.difference);
    offers.searched.differenceClass = getTradeOfferDifferenceClass(offers.searched.difference);
    return {
      currencyKey: this.#tradeCurrencyKey,
      offers,
      balance: {
        difference,
        label: difference ? String(difference) : "0",
        arrow: searcherTotal < searchedTotal ? "←" : searcherTotal > searchedTotal ? "→" : "↔",
        side: searcherTotal < searchedTotal ? "searcher" : searcherTotal > searchedTotal ? "searched" : ""
      }
    };
  }

  #getTradeSideForActor(actorUuid = "") {
    if (this.#tradeSessionSnapshot) return getTradeSessionActorSide(this.#tradeSessionSnapshot, actorUuid);
    if (actorUuid === this.#searcherActorUuid) return "searcher";
    if (actorUuid === this.#searchedActorUuid) return "searched";
    return "";
  }

  #getTradeSideBarterValues() {
    return getTradeSideBarterValues({
      snapshot: this.#tradeSessionSnapshot,
      searcherActor: this.#searcherActor,
      searchedActor: this.#searchedActor
    });
  }

  #getActorForTradeSide(side = "") {
    if (side === "searcher") return this.#searcherActor;
    if (side === "searched") return this.#searchedActor;
    return null;
  }

  #getTradeCatalogEnabledCategories(actorUuid = "") {
    const key = String(actorUuid ?? "");
    let enabled = this.#tradeCatalogEnabledCategories.get(key);
    if (!enabled) {
      enabled = new Set();
      this.#tradeCatalogEnabledCategories.set(key, enabled);
    }
    return enabled;
  }

  #getTradeCatalogExpandedWeaponGroups(actorUuid = "") {
    const key = String(actorUuid ?? "");
    let expanded = this.#tradeCatalogExpandedWeaponGroups.get(key);
    if (!expanded) {
      expanded = new Set();
      this.#tradeCatalogExpandedWeaponGroups.set(key, expanded);
    }
    return expanded;
  }

  #pruneTradeCatalogCategoryState() {
    const actorUuids = new Set([this.#searcherActorUuid, this.#searchedActorUuid].filter(Boolean));
    for (const actorUuid of getTradeSnapshotActorUuids(this.#tradeSessionSnapshot)) actorUuids.add(actorUuid);
    for (const key of this.#tradeCatalogEnabledCategories.keys()) {
      if (!actorUuids.has(key)) this.#tradeCatalogEnabledCategories.delete(key);
    }
    for (const key of this.#tradeCatalogExpandedWeaponGroups.keys()) {
      if (!actorUuids.has(key)) this.#tradeCatalogExpandedWeaponGroups.delete(key);
    }
  }

  #canControlTradeSide(side = "") {
    if (this.#tradeRole === TRADE_ROLE_OBSERVER) return false;
    if (this.#tradeSessionSnapshot) return canUserControlTradeSessionSide(this.#tradeSessionSnapshot, side, game.user?.id ?? "");
    const actor = this.#getActorForTradeSide(side);
    return Boolean(game.user?.isGM || actor?.testUserPermission?.(game.user, "OWNER"));
  }

  #canManageTradeOfferSide(side = "") {
    if (this.#tradeRole === TRADE_ROLE_OBSERVER) return false;
    if (this.#tradeSessionSnapshot) return canUserParticipateInTradeSession(this.#tradeSessionSnapshot, game.user?.id ?? "");
    return TRADE_OFFER_SIDES.includes(side) && this.#canInteract();
  }

  #canConfirmTradeSide(side = "") {
    if (this.#isPersonalTradeMode()) return TRADE_OFFER_SIDES.includes(side) && this.#canInteract();
    return this.#canControlTradeSide(side);
  }

  #canSelectTradeActorSide(side = "") {
    if (!this.#isTradeMode() || this.#tradeRole === TRADE_ROLE_OBSERVER) return false;
    if (game.user?.isGM) return TRADE_OFFER_SIDES.includes(side);
    if (this.#tradeSessionSnapshot) return canUserParticipateInTradeSession(this.#tradeSessionSnapshot, game.user?.id ?? "");
    return this.#canControlTradeSide(side);
  }

  #canClaimCompletedTradeSide(side = "") {
    if (!this.#isTradeMode() || this.#tradeRole === TRADE_ROLE_OBSERVER) return false;
    if (game.user?.isGM) return TRADE_OFFER_SIDES.includes(side);
    return this.#canControlTradeSide(side);
  }

  #canDepositCompletedTradeHub(side = "", sourceActor = null) {
    if (!this.#isTradeMode() || !this.#tradeOffers.completed || this.#tradeRole === TRADE_ROLE_OBSERVER) return false;
    if (!TRADE_OFFER_SIDES.includes(side) || !sourceActor) return false;
    if (game.user?.isGM) return true;
    const sourceSide = this.#getTradeSideForActor(sourceActor.uuid);
    if (!sourceSide) return false;
    if (this.#tradeSessionSnapshot) return canUserControlTradeSessionSide(this.#tradeSessionSnapshot, sourceSide, game.user?.id ?? "");
    return Boolean(sourceActor.testUserPermission?.(game.user, "OWNER"));
  }

  #prepareTradeSessionActionPayload(payload = {}) {
    return {
      ...payload,
      sessionId: this.#tradeSessionId,
      requesterUserId: game.user?.id ?? ""
    };
  }

  #getTradeOfferGridColumns(_zone = null) {
    return getFixedTradeOfferGridColumns();
  }

  #getTradeOfferDropPlacement({ side = "", zone = null, event = null, item = null, entryKind = "item", entryKey = "" } = {}) {
    const actor = this.#getActorForTradeSide(side);
    const grid = this.#getTradeOfferGridElement(zone)
      ?? (actor ? this.element?.querySelector(`[data-trade-offer-grid][data-trade-offer-actor-uuid="${CSS.escape(actor.uuid)}"]`) : null);
    const columns = getFixedTradeOfferGridColumns();
    const footprint = entryKind === "currency" ? { width: 1, height: 1 } : getItemFootprint(item, this.#getActorForTradeSide(side)?.items);
    const width = Math.max(1, Math.min(columns, toInteger(footprint?.width) || 1));
    const height = Math.max(1, toInteger(footprint?.height) || 1);
    const rotated = entryKind !== "currency" && Boolean(item?.system?.placement?.rotated);
    const occupied = getTradeOfferOccupiedPlacements(this.#tradeOffers[side], { excludeKind: entryKind, excludeKey: entryKey });
    const pointerPosition = grid && zone ? getTradeOfferGridPointerPosition(grid, event, { columns }) : null;
    if (zone && !pointerPosition) return null;
    const pointer = getTradeOfferGridPointerPlacement(pointerPosition, { columns, width, height });
    const rows = Math.max(TRADE_OFFER_MAX_ROWS, pointer ? pointer.y + height : height);
    if (pointer && isTradeOfferPlacementAvailable(pointer, occupied, columns, rows)) return { ...pointer, rotated };
    const placement = pointer
      ? findNearestAvailableTradeOfferPlacement(occupied, columns, rows, { width, height }, pointer)
      : findFirstAvailableTradeOfferPlacement(occupied, columns, rows, { width, height });
    return placement ? { ...placement, rotated } : null;
  }

  #getTradeOfferGridElement(zone = null) {
    if (!zone) return null;
    if (zone.matches?.("[data-trade-offer-grid]")) return zone;
    return zone.closest?.("[data-trade-offer-grid]")
      ?? zone.querySelector?.("[data-trade-offer-grid]")
      ?? null;
  }

  #syncRenderedTradeOfferColumns() {
    // Trade offer grid uses a fixed column count independent of inventory layout.
  }

  #resetTradeReady() {
    this.#tradeOffers.completed = false;
    this.#tradeOffers.searcher.ready = false;
    this.#tradeOffers.searched.ready = false;
  }

  #broadcastTradeOffers() {
    broadcastTradeOffersState(this.#tradeSessionId, this.#tradeOffers);
  }

  #getTradeEqualizeCurrencyAmount(side = "", currencyKey = "") {
    if (!TRADE_OFFER_SIDES.includes(side) || !currencyKey) return 0;
    const tradeContext = this.#prepareTradeContext();
    const ownTotal = Math.max(0, toInteger(tradeContext?.offers?.[side]?.total));
    const otherSide = side === "searcher" ? "searched" : "searcher";
    const otherTotal = Math.max(0, toInteger(tradeContext?.offers?.[otherSide]?.total));
    const missing = Math.max(0, otherTotal - ownTotal);
    if (!missing) return 0;
    return convertTradeCurrencyValueToAmount(missing, currencyKey, this.#tradeCurrencyKey);
  }

  async #completeTradeOffers() {
    if (this.#tradeCompletionInProgress) return;
    this.beginTradeCompletionLock();
    try {
      const payload = {
        searcherActorUuid: this.#searcherActorUuid,
        searchedActorUuid: this.#searchedActorUuid,
        tradeSessionId: this.#tradeSessionId,
        tradeCurrencyKey: this.#tradeCurrencyKey,
        offers: this.#tradeOffers
      };
      const responsibleGM = getResponsibleGM();
      let result;
      if (responsibleGM && responsibleGM.id !== game.user?.id) {
        result = await requestSearchInventorySocket("completeTrade", payload, responsibleGM);
      } else {
        result = await enqueueSearchInventoryOperation(() => performTradeComplete(payload, game.user?.id ?? ""));
      }
      this.#tradeOffers = normalizeTradeOffersState(result?.offers ?? createEmptyTradeOffers());
      this.#broadcastTradeOffers();
      ui.notifications.info("Обмен совершен.");
      this.#captureScrollPositions();
      await this.#renderPreservingWindowStack();
    } catch (error) {
      console.error(`${SYSTEM_ID} | Trade completion failed`, error);
      this.#resetTradeReady();
      this.#broadcastTradeOffers();
      ui.notifications.warn(error.message || "Не удалось завершить обмен.");
      await this.#renderPreservingWindowStack();
    } finally {
      this.endTradeCompletionLock({ render: false });
    }
  }

  async #completePersonalTradeOffers() {
    if (this.#tradeCompletionInProgress) return;
    const tradeContext = this.#prepareTradeContext();
    const searcherTotal = Math.max(0, toInteger(tradeContext?.offers?.searcher?.total));
    const searchedTotal = Math.max(0, toInteger(tradeContext?.offers?.searched?.total));
    const difference = Math.abs(searcherTotal - searchedTotal);
    if (difference > 0) {
      const approved = await requestPersonalTradeApproval({
        searcherActor: this.#searcherActor,
        searchedActor: this.#searchedActor,
        searcherTotal,
        searchedTotal,
        tradeCurrencyKey: this.#tradeCurrencyKey
      });
      if (!approved) return;
    }

    this.beginTradeCompletionLock();
    try {
      const payload = {
        searcherActorUuid: this.#searcherActorUuid,
        searchedActorUuid: this.#searchedActorUuid,
        tradeCurrencyKey: this.#tradeCurrencyKey,
        offers: this.#tradeOffers
      };
      const responsibleGM = getResponsibleGM();
      let result;
      if (responsibleGM && responsibleGM.id !== game.user?.id) {
        result = await requestSearchInventorySocket("completePersonalTrade", payload, responsibleGM);
      } else {
        result = await enqueueSearchInventoryOperation(() => performPersonalTradeComplete(payload, game.user?.id ?? ""));
      }
      this.#tradeOffers = createEmptyTradeOffers();
      ui.notifications.info(result?.droppedCount
        ? `Обмен совершен. Предметов выброшено: ${result.droppedCount}.`
        : "Обмен совершен.");
      await this.close({ force: true });
    } catch (error) {
      console.error(`${SYSTEM_ID} | Personal trade completion failed`, error);
      ui.notifications.warn(error.message || "Не удалось завершить личную торговлю.");
      await this.#renderPreservingWindowStack();
    } finally {
      this.endTradeCompletionLock({ render: false });
    }
  }

  #getActorByUuid(uuid) {
    const normalized = String(uuid ?? "");
    if (normalized === this.#searcherActor?.uuid) return this.#searcherActor;
    if (normalized === this.#searchedActor?.uuid) return this.#searchedActor;
    const actor = getCachedActorByUuid(normalized);
    if (actor) return actor;
    return null;
  }

  #scheduleRefreshForActor(actor, itemId = "") {
    if (!actor) return;
    if (this.#inventoryMutationDepth > 0) return;
    if (this.#tradeCompletionInProgress) return;
    if (itemId && this.#shouldSuppressTradeOfferItemRefresh(itemId)) return;
    if (![this.#searcherActorUuid, this.#searchedActorUuid, ...getTradeSnapshotActorUuids(this.#tradeSessionSnapshot)].includes(actor.uuid)) return;
    this.#renderRefresh?.();
  }

  #handleActorDeleted(actor) {
    if (!actor) return;
    const actorUuids = [this.#searcherActorUuid, this.#searchedActorUuid, ...getTradeSnapshotActorUuids(this.#tradeSessionSnapshot)];
    if (!actorUuids.includes(actor.uuid)) return;
    if (isDroppedItemsActor(actor)) {
      void this.close({ force: true });
      return;
    }
    this.#scheduleRefreshForActor(actor);
  }

  #shouldSuppressTradeOfferItemRefresh(itemId = "") {
    if (!this.#isTradeMode() || this.#tradeOffers.completed) return false;
    if (!this.#tradeOffers.searcher.ready || !this.#tradeOffers.searched.ready) return false;
    const normalized = String(itemId ?? "");
    if (!normalized) return false;
    for (const side of TRADE_OFFER_SIDES) {
      for (const entry of this.#tradeOffers[side]?.items ?? []) {
        if (String(entry.itemId ?? "") === normalized) return true;
      }
    }
    return false;
  }

  #beginInventoryMutation() {
    this.#inventoryMutationDepth += 1;
  }

  #endInventoryMutation() {
    this.#inventoryMutationDepth = Math.max(0, this.#inventoryMutationDepth - 1);
  }

  #getDropZone(eventOrTarget) {
    const target = eventOrTarget?.target ?? eventOrTarget;
    const pointedCell = this.#getInventoryCellAtPointer(eventOrTarget, target);
    if (pointedCell) return pointedCell;

    const targetItem = target?.closest?.("[data-inventory-grid-item][data-item-id][data-search-actor-uuid]");
    if (targetItem && this.element?.contains(targetItem)) return targetItem;
    return target?.closest?.("[data-search-drop-zone]") ?? null;
  }

  #getInventoryCellAtPointer(eventOrTarget, target = null) {
    const clientX = Number(eventOrTarget?.clientX);
    const clientY = Number(eventOrTarget?.clientY);
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;

    const pointedElement = document.elementFromPoint(clientX, clientY);
    const grid = (
      target?.closest?.("[data-inventory-grid]")
      ?? pointedElement?.closest?.("[data-inventory-grid]")
      ?? null
    );
    if (!grid || !this.element?.contains(grid)) return null;

    const actor = this.#getActorByUuid(String(grid.dataset.searchActorUuid ?? ""));
    const pointer = getSearchInventoryGridPointerPosition(eventOrTarget, grid, actor, getDropZoneParentId(grid));
    if (!pointer) return null;
    const x = Math.round(pointer.x);
    const y = Math.round(pointer.y);
    return syncInventoryVirtualCell(grid, { x, y }, {
      inventoryParentId: getDropZoneParentId(grid),
      searchDropZone: "",
      searchActorUuid: String(grid.dataset.searchActorUuid ?? "")
    });
  }

  #getPreviewItemData(event) {
    if (this.#draggedItemData) return this.#draggedItemData;
    const data = this.#getDragEventData(event);
    if (data?.type !== "Item") return null;
    this.#draggedTradeOfferKind = String(data.tradeOfferKind ?? "");
    this.#draggedTradeOfferKey = String(data.tradeOfferKey ?? "");
    if (this.#isTradeMode() && this.#tradeOffers.completed && data.falloutMawTradeOffer && data.tradeOfferKind === "item") {
      const entry = findTradeOfferEntry(this.#tradeOffers?.[String(data.tradeOfferSide ?? "")], "item", String(data.tradeOfferKey ?? ""));
      const itemData = getTradeOfferEntryItemData(entry, this.#getActorByUuid(String(entry?.sourceActorUuid ?? "")));
      if (!itemData) return null;
      this.#draggedItemId = String(entry.itemId ?? "");
      this.#draggedActorUuid = String(entry.sourceActorUuid ?? "");
      return itemData;
    }
    const actor = this.#getActorByUuid(String(data.sourceActorUuid ?? data.actorUuid ?? ""));
    const item = actor?.items?.get(String(data.itemId ?? ""));
    if (!item) return null;
    this.#draggedItemId = item.id;
    this.#draggedActorUuid = actor.uuid;
    const itemData = item.toObject();
    if (usesVirtualInventoryStacks(item)) {
      const stackIndex = Math.max(0, toInteger(data.stackIndex));
      const stackQuantity = Math.max(0, toInteger(data.stackQuantity));
      foundry.utils.setProperty(itemData, "system.quantity", stackQuantity || getItemStackPartQuantity(item, stackIndex));
    }
    return itemData;
  }

  #getDragEventData(event) {
    const cachedPayload = CONFIG.ux.DragDrop?.getPayload?.();
    if (cachedPayload && typeof cachedPayload === "object") return cachedPayload;

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

  #getTargetStackItem(target, actor, sourceItemId = "", parentId = ROOT_CONTAINER_ID) {
    const itemElement = target?.closest?.("[data-item-id][data-search-actor-uuid]");
    if (itemElement && itemElement.dataset.searchActorUuid === actor.uuid && itemElement.dataset.itemId !== sourceItemId) {
      if (!itemElement.closest("[data-inventory-grid]")) return null;
      if (String(itemElement.dataset.inventoryParentId ?? ROOT_CONTAINER_ID) !== String(parentId ?? ROOT_CONTAINER_ID)) return null;
      return actor.items.get(itemElement.dataset.itemId) ?? null;
    }

    const cell = target?.closest?.("[data-inventory-cell]");
    if (!cell) return null;
    const x = toInteger(cell.dataset.x);
    const y = toInteger(cell.dataset.y);
    return getContextInventoryItems(parentId, actor.items).find(item => {
      if (item.id === sourceItemId) return false;
      const placement = normalizeInventoryPlacement(item.system?.placement ?? {}, item, actor.items);
      return placementContainsInventoryCell(placement, x, y);
    }) ?? null;
  }

  #onInventoryDragLeave(event) {
    const zone = event.target?.closest?.("[data-search-drop-zone]");
    if (!zone) return;

    const hoveredElement = document.elementFromPoint(event.clientX, event.clientY);
    const hoveredZone = hoveredElement?.closest?.("[data-search-drop-zone]") ?? null;
    if (hoveredZone === zone) return;
    if (zone.closest("[data-inventory-grid]") && hoveredElement?.closest?.("[data-inventory-grid]") === zone.closest("[data-inventory-grid]")) return;
    if (zone.closest("[data-trade-offer-grid]") && hoveredElement?.closest?.("[data-trade-offer-grid]") === zone.closest("[data-trade-offer-grid]")) return;
    this.#clearInventoryHoverPreview();
  }

  #setInventoryHoverPreview(zone = null, event = null) {
    if (!zone) {
      this.#clearInventoryHoverPreview();
      return;
    }

    if (this.#isTradeMode() && zone.dataset.tradeOfferActorUuid !== undefined) {
      this.#applyTradeOfferPreview(zone, event);
      return;
    }

    const actor = this.#getActorByUuid(String(zone.dataset.searchActorUuid ?? ""));
    if (zone.dataset.equipmentSlot || (zone.dataset.weaponSet && zone.dataset.weaponSlot)) {
      const inputKey = `slot:${actor?.uuid ?? ""}:${zone.dataset.equipmentSlot ?? ""}:${zone.dataset.weaponSet ?? ""}:${zone.dataset.weaponSlot ?? ""}:${this.#draggedActorUuid}:${this.#draggedItemId}`;
      if (this.#hoverPreviewInputKey === inputKey) return;
      this.#hoverPreviewInputKey = inputKey;
      if (!actor || !this.#draggedItemData) {
        this.#clearInventoryHoverPreviewClasses();
        return;
      }
      const placementRequest = getDropZonePlacementRequest(zone);
      const excludeItemIds = actor.uuid === this.#draggedActorUuid && this.#draggedItemId ? [this.#draggedItemId] : [];
      if (resolveActorPlacement(actor, this.#draggedItemData, {
        mode: placementRequest.mode,
        equipmentSlot: placementRequest.equipmentSlot,
        weaponSet: placementRequest.weaponSet,
        weaponSlot: placementRequest.weaponSlot,
        x: 1,
        y: 1
      }, excludeItemIds)) {
        this.#applySingleZonePreview(zone, inputKey);
        return;
      }
      this.#clearInventoryHoverPreviewClasses();
      return;
    }
    if (zone.dataset.inventoryCell === undefined && zone.dataset.inventoryGridItem === undefined) {
      this.#clearInventoryHoverPreview();
      return;
    }

    if (!actor || !this.#draggedItemData) {
      this.#applySingleZonePreview(zone, `inventory-cell:${zone.dataset.searchActorUuid ?? ""}:${getDropZoneParentId(zone)}:${zone.dataset.x ?? ""}:${zone.dataset.y ?? ""}`);
      return;
    }

    const parentId = getDropZoneParentId(zone);
    const inputKey = `inventory:${actor.uuid}:${parentId}:${zone.dataset.x ?? ""}:${zone.dataset.y ?? ""}:${this.#draggedActorUuid}:${this.#draggedItemId}`;
    if (this.#hoverPreviewInputKey === inputKey) return;
    this.#hoverPreviewInputKey = inputKey;
    const targetItem = this.#getTargetStackItem(zone, actor, this.#draggedItemId, parentId);
    const stackRoom = targetItem
      && areStackable(this.#draggedItemData, targetItem)
      && getItemQuantity(targetItem) < getItemMaxStack(targetItem);
    if (stackRoom) {
      this.#applyInventoryStackPreview(actor, parentId, targetItem);
      return;
    }

    const placement = getSearchDropPlacementForPointer({
      actor,
      itemData: this.#draggedItemData,
      sourceActor: this.#getActorByUuid(this.#draggedActorUuid),
      sourceItemId: this.#draggedItemId,
      parentId,
      event,
      zone,
      findNearest: Boolean(targetItem)
    });
    if (!placement) {
      if (this.#hoverPreviewKey === "none") return;
      this.#clearInventoryHoverPreviewClasses();
      this.#hoverPreviewKey = "none";
      return;
    }
    this.#applyInventoryPlacementPreview(actor, parentId, placement);
  }

  #applySingleZonePreview(zone, key = "") {
    const previewKey = `zone:${key}`;
    if (this.#hoverPreviewKey === previewKey) return;
    this.#clearInventoryHoverPreviewClasses();
    this.#hoverPreviewKey = previewKey;
    zone?.classList?.add("drop-preview");
  }

  #applyInventoryPlacementPreview(actor, parentId, placement) {
    if (!placement) return;
    const previewKey = `inventory:${actor.uuid}:${parentId ?? ROOT_CONTAINER_ID}:${placement.x}:${placement.y}:${placement.width}:${placement.height}`;
    if (this.#hoverPreviewKey === previewKey) return;
    this.#clearInventoryHoverPreviewClasses();
    this.#hoverPreviewKey = previewKey;
    renderInventoryPlacementPreview(
      this.#getInventoryGridElement(actor.uuid, parentId),
      placement,
      { className: "drop-preview", kind: "placement" }
    );
  }

  #applyInventoryStackPreview(actor, parentId, targetItem) {
    if (!actor || !targetItem) return;
    const previewKey = `stack:${actor.uuid}:${parentId ?? ROOT_CONTAINER_ID}:${targetItem.id}:${getItemQuantity(targetItem)}:${getItemMaxStack(targetItem)}`;
    if (this.#hoverPreviewKey === previewKey) return;
    this.#clearInventoryHoverPreviewClasses();
    this.#hoverPreviewKey = previewKey;

    const escapedUuid = CSS.escape(actor.uuid);
    const escapedParentId = CSS.escape(parentId ?? ROOT_CONTAINER_ID);
    const escapedItemId = CSS.escape(targetItem.id);
    this.element?.querySelector(
      `[data-inventory-grid-item][data-search-actor-uuid="${escapedUuid}"][data-item-id="${escapedItemId}"][data-inventory-parent-id="${escapedParentId}"]`
    )?.classList.add("drop-stack-preview");

    const placement = normalizeInventoryPlacement(targetItem.system?.placement ?? {}, targetItem, actor.items);
    renderInventoryPlacementPreview(
      this.#getInventoryGridElement(actor.uuid, parentId),
      placement,
      { className: "drop-stack-preview", kind: "stack" }
    );
  }

  #getInventoryGridElement(actorUuid = "", parentId = ROOT_CONTAINER_ID) {
    const escapedUuid = CSS.escape(String(actorUuid ?? ""));
    const escapedParentId = CSS.escape(String(parentId ?? ROOT_CONTAINER_ID));
    return this.element?.querySelector(
      `[data-inventory-grid][data-search-actor-uuid="${escapedUuid}"][data-inventory-parent-id="${escapedParentId}"]`
    ) ?? null;
  }

  #applyTradeOfferPreview(zone = null, event = null) {
    const grid = this.#getTradeOfferGridElement(zone);
    if (!grid) {
      this.#clearInventoryHoverPreviewClasses();
      return;
    }
    const offerActorUuid = String(grid?.dataset?.tradeOfferActorUuid ?? "");
    const side = this.#getTradeSideForActor(offerActorUuid);
    const sourceActor = this.#getActorByUuid(this.#draggedActorUuid);
    const sourceItem = sourceActor?.items?.get(this.#draggedItemId);
    const entryKind = this.#draggedTradeOfferKind || "item";
    const entryKey = this.#draggedTradeOfferKey || this.#draggedItemId;
    const placement = side
      ? this.#getTradeOfferDropPlacement({ side, zone, event, item: sourceItem ?? this.#draggedItemData, entryKind, entryKey })
      : null;
    if (!placement) {
      this.#clearInventoryHoverPreviewClasses();
      return;
    }
    const previewKey = `trade-offer:${offerActorUuid}:${placement.x}:${placement.y}:${placement.width}:${placement.height}:${this.#draggedActorUuid}:${this.#draggedItemId}:${entryKind}:${entryKey}`;
    if (this.#hoverPreviewKey === previewKey) return;
    this.#clearInventoryHoverPreviewClasses();
    this.#hoverPreviewKey = previewKey;
    const requiredRows = Math.max(
      toInteger(grid.style.getPropertyValue("--fallout-maw-inventory-rows")) || 1,
      placement.y + placement.height - 1
    );
    grid.style.setProperty("--fallout-maw-inventory-rows", String(requiredRows));
    renderInventoryPlacementPreview(grid, placement, {
      className: "drop-preview",
      kind: "trade-offer"
    });
  }

  #clearInventoryDropPreview() {
    this.#clearInventoryHoverPreview();
    this.#clearTradeOfferPreviewCells();
    clearInventoryVirtualCells(this.element);
    this.element?.querySelectorAll(".drop-match-preview").forEach(element => element.classList.remove("drop-match-preview"));
  }

  #clearInventoryHoverPreview() {
    this.#hoverPreviewInputKey = "";
    this.#clearInventoryHoverPreviewClasses();
  }

  #clearInventoryHoverPreviewClasses() {
    this.#hoverPreviewKey = "";
    this.#clearTradeOfferPreviewCells();
    clearInventoryPlacementPreviews(this.element);
    this.element?.querySelectorAll(".drop-preview, .drop-stack-preview").forEach(element => {
      element.classList.remove("drop-preview", "drop-stack-preview");
    });
  }

  #clearTradeOfferPreviewCells() {
    for (const grid of this.element?.querySelectorAll("[data-trade-offer-grid]") ?? []) {
      const rows = Math.max(1, toInteger(grid.dataset.tradeOfferRows) || toInteger(grid.style.getPropertyValue("--fallout-maw-inventory-base-rows")) || 1);
      grid.style.setProperty("--fallout-maw-inventory-rows", String(rows));
    }
  }

  #highlightEquipmentSlotsForItem(itemData) {
    if (!itemData) return false;
    let highlighted = false;

    for (const actor of [this.#searcherActor, this.#searchedActor]) {
      if (!actor) continue;
      const actorUuid = CSS.escape(actor.uuid);
      const race = getCreatureOptions().races.find(entry => entry.id === actor.system?.creature?.raceId) ?? null;

      for (const slot of getRaceEquipmentSlotsForItem(race, itemData)) {
        this.element?.querySelector(
          `[data-search-actor-uuid="${actorUuid}"][data-equipment-slot="${CSS.escape(slot.key)}"]`
        )?.classList.add("drop-match-preview");
        highlighted = true;
      }

      for (const set of race?.weaponSets ?? []) {
        for (const slot of set.slots ?? []) {
          if (!canUseWeaponSlotForItem(race, itemData, set.key, slot.key)) continue;
          this.element?.querySelector(
            `[data-search-actor-uuid="${actorUuid}"][data-weapon-set="${CSS.escape(set.key)}"][data-weapon-slot="${CSS.escape(slot.key)}"]`
          )?.classList.add("drop-match-preview");
          highlighted = true;
        }
      }

      if (getValidSelectedWeaponSlotKeys(race, itemData).size) {
        this.element?.querySelectorAll(
          `[data-search-actor-uuid="${actorUuid}"][data-weapon-set^="container:"][data-weapon-slot]`
        ).forEach(element => {
          element.classList.add("drop-match-preview");
          highlighted = true;
        });
      }
    }

    return highlighted;
  }

  #bindInventoryTooltipListeners() {
    const root = this.element?.querySelector("[data-search-root]");
    if (!root || root.dataset.tooltipBound) return;
    root.dataset.tooltipBound = "true";
    root.addEventListener("pointerover", event => this.#onInventoryTooltipPointerOver(event));
    root.addEventListener("pointerout", event => this.#onInventoryTooltipPointerOut(event));
    root.addEventListener("pointerover", event => this.#onTradeItemPointerOver(event));
    root.addEventListener("pointerout", event => this.#onTradeItemPointerOut(event));
    root.addEventListener("mousedown", event => this.#onInventoryTooltipMiddleMouseDown(event));
    root.addEventListener("auxclick", event => this.#onInventoryTooltipAuxClick(event));
    root.addEventListener("click", event => void this.#onSearchRootClick(event));
    root.addEventListener("change", event => void this.#onSearchRootChange(event));
    root.addEventListener("contextmenu", event => this.#onSearchRootContextMenu(event));
  }

  #onInventoryTooltipMiddleMouseDown(event) {
    if (event.button !== 1) return;
    if (!event.target?.closest?.("[data-tooltip-item], .fallout-maw-inventory-tooltip")) return;
    event.preventDefault();
  }

  async #onSearchRootClick(event) {
    document.querySelectorAll(".fallout-maw-inventory-context-menu").forEach(menu => menu.remove());
    const equipmentToggle = event.target?.closest?.("[data-trade-equipment-toggle]");
    if (equipmentToggle && this.element?.contains(equipmentToggle)) {
      event.preventDefault();
      event.stopPropagation();
      this.#tradeEquipmentCollapsed = !this.#tradeEquipmentCollapsed;
      this.#captureScrollPositions();
      await this.#renderPreservingWindowStack();
      return;
    }

    const tradeCatalogCategory = event.target?.closest?.("[data-trade-catalog-category]");
    if (tradeCatalogCategory && this.element?.contains(tradeCatalogCategory)) {
      await this.#onTradeCatalogCategoryClick(event, tradeCatalogCategory);
      return;
    }

    const tradeCatalogWeaponGroup = event.target?.closest?.("[data-trade-catalog-weapon-group]");
    if (tradeCatalogWeaponGroup && this.element?.contains(tradeCatalogWeaponGroup)) {
      await this.#onTradeCatalogWeaponGroupClick(event, tradeCatalogWeaponGroup);
      return;
    }

    const bulkButton = event.target?.closest?.("[data-search-bulk-transfer]");
    if (bulkButton && this.element?.contains(bulkButton)) {
      await this.#onSearchBulkTransferClick(event, bulkButton);
      return;
    }

    const butcheringButton = event.target?.closest?.("[data-search-butchering]");
    if (butcheringButton && this.element?.contains(butcheringButton)) {
      await this.#onButcheringClick(event, butcheringButton);
      return;
    }

    const tradeReadyButton = event.target?.closest?.("[data-trade-ready]");
    if (tradeReadyButton && this.element?.contains(tradeReadyButton)) {
      await this.#onTradeReadyClick(event, tradeReadyButton);
      return;
    }

    const tradeRestartButton = event.target?.closest?.("[data-trade-restart]");
    if (tradeRestartButton && this.element?.contains(tradeRestartButton)) {
      await this.#onTradeRestartClick(event, tradeRestartButton);
      return;
    }

    const tradeOfferRemove = event.target?.closest?.("[data-trade-offer-remove]");
    if (tradeOfferRemove && this.element?.contains(tradeOfferRemove)) {
      await this.#onTradeOfferRemoveClick(event, tradeOfferRemove);
      return;
    }

    const currencyButton = event.target?.closest?.("[data-search-currency][data-search-actor-uuid]");
    if (currencyButton && this.element?.contains(currencyButton)) {
      if (this.#isTradeMode()) {
        await this.#onTradeCurrencyClick(event, currencyButton);
        return;
      }
      await this.#onSearchCurrencyClick(event, currencyButton);
      return;
    }

    if (!event.shiftKey) return;
    const itemElement = event.target?.closest?.("[data-item-id][data-search-actor-uuid]");
    if (!itemElement || !this.element?.contains(itemElement)) return;
    event.preventDefault();
    event.stopPropagation();
    if (this.#isTradeMode()) {
      const completedOfferEntry = itemElement.closest("[data-trade-offer-entry]");
      if (this.#tradeOffers.completed && completedOfferEntry) {
        await this.#claimCompletedTradeOfferEntry(completedOfferEntry);
        return;
      }
      const actor = this.#getActorByUuid(String(itemElement.dataset.searchActorUuid ?? ""));
      const item = actor?.items?.get(String(itemElement.dataset.itemId ?? ""));
      if (!actor || !item) return;
      const sourceStackIndex = Math.max(0, toInteger(itemElement.dataset.stackIndex));
      const sourceStackQuantity = Math.max(0, toInteger(itemElement.dataset.stackQuantity));
      const sourceWholeStack = itemElement.dataset.tradeCatalogAggregate !== undefined;
      if (this.#tradeOffers.completed) {
        await this.#addItemToCompletedTradeHub({ sourceActor: actor, item, offerActorUuid: actor.uuid, event, sourceStackIndex, sourceStackQuantity });
        return;
      }
      await this.#addItemToTradeOffer({ sourceActor: actor, item, offerActorUuid: actor.uuid, event, sourceStackIndex, sourceStackQuantity, sourceWholeStack });
      return;
    }
    await this.#transferItemToOppositeRoot(itemElement);
  }

  async #onTradeCatalogCategoryClick(event, button) {
    event.preventDefault();
    event.stopPropagation();
    if (!this.#isTradeMode() || this.#tradeOffers.completed) return;
    const actorUuid = String(button?.dataset?.tradeActorUuid ?? "");
    const category = normalizeTradeCatalogCategory(button?.dataset?.tradeCatalogCategory);
    if (!actorUuid || !category) return;
    const enabled = this.#getTradeCatalogEnabledCategories(actorUuid);
    if (enabled.has(category)) enabled.delete(category);
    else enabled.add(category);
    this.#captureScrollPositions();
    await this.#renderPreservingWindowStack();
  }

  async #onTradeCatalogWeaponGroupClick(event, button) {
    event.preventDefault();
    event.stopPropagation();
    if (!this.#isTradeMode() || this.#tradeOffers.completed) return;
    const actorUuid = String(button?.dataset?.tradeActorUuid ?? "");
    const stateKey = String(button?.dataset?.tradeCatalogWeaponGroup ?? "").trim();
    if (!actorUuid || !stateKey) return;
    const expanded = this.#getTradeCatalogExpandedWeaponGroups(actorUuid);
    if (expanded.has(stateKey)) expanded.delete(stateKey);
    else expanded.add(stateKey);
    this.#captureScrollPositions();
    await this.#renderPreservingWindowStack();
  }

  async #onSearchRootChange(event) {
    const select = event.target?.closest?.("[data-trade-actor-select]");
    if (!select || !this.element?.contains(select)) return;
    event.preventDefault();
    event.stopPropagation();
    const side = String(select.dataset.tradeActorSelect ?? "");
    const actorUuid = String(select.value ?? "");
    if (!TRADE_OFFER_SIDES.includes(side) || !actorUuid || !this.#canSelectTradeActorSide(side)) return;
    const payload = this.#prepareTradeSessionActionPayload({
      side,
      actorUuid
    });
    const result = await requestTradeSessionAction("selectTradeActor", payload);
    if (result?.snapshot) this.#applyTradeSessionSnapshot(result.snapshot, { render: true });
  }

  #onSearchRootContextMenu(event) {
    const currencyButton = event.target?.closest?.("[data-search-currency][data-search-actor-uuid]");
    if (currencyButton && this.element?.contains(currencyButton) && this.#isTradeMode()) {
      event.preventDefault();
      event.stopPropagation();
      this.#showTradeCurrencyContextMenu(currencyButton, event);
      return;
    }

    const itemElement = event.target?.closest?.("[data-item-id][data-search-actor-uuid]");
    if (!itemElement || !this.element?.contains(itemElement)) return;
    const actor = this.#getActorByUuid(String(itemElement.dataset.searchActorUuid ?? ""));
    const item = actor?.items?.get(String(itemElement.dataset.itemId ?? ""));
    if (!actor || !item) return;
    event.preventDefault();
    event.stopPropagation();
    if (this.#isTradeMode() && !this.#tradeOffers.completed) {
      this.#showTradeInventoryContextMenu(actor, item, event, {
        stackIndex: Math.max(0, toInteger(itemElement.dataset.stackIndex)),
        stackQuantity: Math.max(0, toInteger(itemElement.dataset.stackQuantity)),
        sourceWholeStack: itemElement.dataset.tradeCatalogAggregate !== undefined
      });
      return;
    }
    if (!this.#canInteract()) return;
    this.#showInventoryContextMenu(actor, item, event, {
      stackIndex: Math.max(0, toInteger(itemElement.dataset.stackIndex)),
      stackQuantity: Math.max(0, toInteger(itemElement.dataset.stackQuantity))
    });
  }

  #showTradeInventoryContextMenu(actor, item, event, { stackIndex = 0, stackQuantity = 0, sourceWholeStack = false } = {}) {
    if (!this.#isTradeMode() || this.#tradeOffers.completed || !actor || !item) return;
    this.#clearInventoryTooltip({ force: true });
    document.querySelectorAll(".fallout-maw-inventory-context-menu").forEach(menu => menu.remove());

    const canOffer = Boolean(this.#isTradeMode() && !this.#tradeOffers.completed && this.#tradeRole !== TRADE_ROLE_OBSERVER);
    const menuOptions = [
      ["offer", "fa-cart-plus", "В предложение", !canOffer]
    ];
    if (canHighlightTradeAmmoCompatibility(item)) {
      menuOptions.push(["highlightAmmo", "fa-crosshairs", "Подходящие боеприпасы"]);
    }
    if (canHighlightTradeEnergyCompatibility(item)) {
      menuOptions.push(["highlightEnergy", "fa-bolt", "Подходящие источники энергии"]);
    }

    const menu = document.createElement("nav");
    menu.className = "fallout-maw-inventory-context-menu";
    menu.dataset.pointerX = String(event.clientX);
    menu.dataset.pointerY = String(event.clientY);
    this.#applyOverlayUiScale(menu);
    menu.innerHTML = menuOptions
      .map(([action, icon, label, disabled = false]) => `<button type="button" data-action="${action}"${disabled ? " disabled" : ""}><i class="fa-solid ${icon}"></i>${label}</button>`)
      .join("");
    document.body.append(menu);
    this.#syncInventoryTooltipLayer({ bringToFront: true });
    this.#positionOverlayAtPointer(menu, { x: event.clientX, y: event.clientY }, 8);

    menu.addEventListener("click", async clickEvent => {
      const action = clickEvent.target.closest("button")?.dataset.action;
      if (!action) return;
      clickEvent.preventDefault();
      menu.remove();
      if (action === "offer") {
        return this.#addItemToTradeOffer({
          sourceActor: actor,
          item,
          offerActorUuid: actor.uuid,
          sourceStackIndex: Math.max(0, toInteger(stackIndex)),
          sourceStackQuantity: Math.max(0, toInteger(stackQuantity)),
          sourceWholeStack
        });
      }
      if (action === "highlightAmmo") return this.#setTradeCompatibilityHighlight("ammo", actor, item);
      if (action === "highlightEnergy") return this.#setTradeCompatibilityHighlight("energy", actor, item);
      return undefined;
    });
  }

  #showInventoryContextMenu(actor, item, event, { stackIndex = 0, stackQuantity = 0 } = {}) {
    this.#clearInventoryTooltip({ force: true });
    document.querySelectorAll(".fallout-maw-inventory-context-menu").forEach(menu => menu.remove());

    const placementMode = String(item.system?.placement?.mode ?? "");
    const isSlottedEquipment = placementMode === "equipment";
    const isSlottedWeapon = placementMode === "weapon";
    const isSlottedItem = isSlottedEquipment || isSlottedWeapon;
    const isEquipped = Boolean(item.system?.equipped);
    const isContainer = isContainerItem(item);
    const isButcheringItem = isItemInButcheringStorage(item);
    const canRotate = canShowInventoryRotateAction(item);
    const rotationResolution = canRotate ? this.#resolveSearchItemRotation(actor, item) : null;
    const selectedQuantity = usesVirtualInventoryStacks(item)
      ? Math.max(1, stackQuantity || getItemStackPartQuantity(item, stackIndex))
      : getItemQuantity(item);
    const menuOptions = [];

    if (isButcheringItem) {
      menuOptions.push(["takeButchering", "fa-hand", "Забрать"]);
    } else if (game.user?.isGM) {
      menuOptions.push(["edit", "fa-pen-to-square", game.i18n.localize("FALLOUTMAW.Common.Edit")]);
    }
    if (!isButcheringItem && isContainer) {
      menuOptions.push(["open", "fa-box-open", game.i18n.localize("FALLOUTMAW.Item.Open")]);
    }
    if (!isButcheringItem && getItemInteractionState(actor, item).hasInteraction) {
      menuOptions.push(["interact", "fa-hand-pointer", "Взаимодействие"]);
    }
    if (!isButcheringItem && canUseActiveItem(item)) {
      menuOptions.push(["use", "fa-play", "Применить"]);
    }
    if (!isButcheringItem && canRotate) {
      menuOptions.push(["rotate", "fa-rotate", game.i18n.localize("FALLOUTMAW.Item.Rotate"), !rotationResolution, rotationResolution ? "" : getInventoryRotationUnavailableLabel()]);
    }
    if (!isButcheringItem && (isSlottedItem || isEquipped)) {
      menuOptions.push(["unequip", "fa-hand", game.i18n.localize("FALLOUTMAW.Item.Unequip")]);
    } else if (!isButcheringItem) {
      menuOptions.push(["equip", "fa-shirt", game.i18n.localize("FALLOUTMAW.Item.Equip")]);
    }
    if (!isButcheringItem && selectedQuantity > 1) {
      menuOptions.push(["split", "fa-code-branch", "Разделить"]);
    }
    if (!isButcheringItem) {
      menuOptions.push(["drop", "fa-arrow-down", "Выбросить"]);
    }
    if (!isButcheringItem && game.user?.isGM && !isSlottedItem) {
      menuOptions.push(["copy", "fa-copy", game.i18n.localize("FALLOUTMAW.Common.Copy")]);
    }
    if (!isButcheringItem && game.user?.isGM) {
      menuOptions.push(["delete", "fa-trash", game.i18n.localize("FALLOUTMAW.Common.Delete")]);
    }

    const menu = document.createElement("nav");
    menu.className = "fallout-maw-inventory-context-menu";
    menu.dataset.pointerX = String(event.clientX);
    menu.dataset.pointerY = String(event.clientY);
    this.#applyOverlayUiScale(menu);
    menu.innerHTML = menuOptions
      .map(([action, icon, label, disabled = false, title = ""]) => `<button type="button" data-action="${action}"${disabled ? " disabled" : ""}${title ? ` title="${escapeHTML(title)}"` : ""}><i class="fa-solid ${icon}"></i>${label}</button>`)
      .join("");
    document.body.append(menu);
    this.#syncInventoryTooltipLayer({ bringToFront: true });
    this.#positionOverlayAtPointer(menu, { x: event.clientX, y: event.clientY }, 8);

    menu.addEventListener("click", async clickEvent => {
      const action = clickEvent.target.closest("button")?.dataset.action;
      if (!action) return;
      clickEvent.preventDefault();
      menu.remove();
      if (action === "takeButchering") return this.#takeButcheringItem(actor, item);
      if (action === "edit" && game.user?.isGM) return item.sheet?.render(true);
      if (action === "open") return this.#openSearchContainerSheet(item);
      if (action === "interact") return openItemInteractionDialog({ actor, item, application: this });
      if (action === "use") return useActiveItem({ actor, item, application: this });
      if (action === "rotate") return this.#rotateSearchItem(actor, item);
      if (action === "equip") return this.#equipSearchItem(actor, item);
      if (action === "unequip") return this.#unequipSearchItem(actor, item);
      if (action === "split") return this.#splitSearchItem(actor, item, { stackIndex, stackQuantity: selectedQuantity });
      if (action === "drop") return this.#dropSearchItem(actor, item, { stackIndex, stackQuantity: selectedQuantity });
      if (action === "copy" && game.user?.isGM) return copyActorInventoryItem(actor, item);
      if (action === "delete" && game.user?.isGM) return this.#deleteSearchItem(actor, item, { stackIndex, stackQuantity: selectedQuantity });
      return undefined;
    });
  }

  #showTradeCurrencyContextMenu(button, event) {
    if (!this.#canInteract()) return;
    const currencyKey = String(button?.dataset?.searchCurrency ?? "");
    const currency = getCurrencySettings().find(entry => entry.key === currencyKey);
    if (!currency) return;

    this.#clearInventoryTooltip({ force: true });
    document.querySelectorAll(".fallout-maw-inventory-context-menu").forEach(menu => menu.remove());

    const menu = document.createElement("nav");
    menu.className = "fallout-maw-inventory-context-menu";
    menu.dataset.pointerX = String(event.clientX);
    menu.dataset.pointerY = String(event.clientY);
    this.#applyOverlayUiScale(menu);
    menu.innerHTML = `<button type="button" data-action="tradePrimary"><i class="fa-solid fa-coins"></i>Сделать основной</button>`;
    document.body.append(menu);
    this.#syncInventoryTooltipLayer({ bringToFront: true });
    this.#positionOverlayAtPointer(menu, { x: event.clientX, y: event.clientY }, 8);

    menu.addEventListener("click", clickEvent => {
      const action = clickEvent.target.closest("button")?.dataset.action;
      if (action !== "tradePrimary") return;
      clickEvent.preventDefault();
      menu.remove();
      this.#setTradeCurrencyKey(currencyKey, { broadcast: true });
    });
  }

  async #onTradeReadyClick(event, button) {
    event.preventDefault();
    event.stopPropagation();
    const side = String(button?.dataset?.tradeReady ?? "");
    if (!TRADE_OFFER_SIDES.includes(side) || !this.#canConfirmTradeSide(side)) return;
    if (this.#tradeOffers.completed) return;
    if (this.#isPersonalTradeMode()) {
      await this.#completePersonalTradeOffers();
      return;
    }
    if (this.#tradeSessionSnapshot) {
      const result = await requestTradeSessionAction("setTradeReady", this.#prepareTradeSessionActionPayload({
        side,
        actorUuid: this.#getActorForTradeSide(side)?.uuid ?? ""
      }));
      if (result?.snapshot) this.#applyTradeSessionSnapshot(result.snapshot, { render: true });
      if (result?.completed) ui.notifications.info("Обмен совершен.");
      return;
    }
    this.#tradeOffers[side].ready = !this.#tradeOffers[side].ready;
    this.#broadcastTradeOffers();
    this.#captureScrollPositions();
    await this.#renderPreservingWindowStack();
    if (this.#tradeOffers.searcher.ready && this.#tradeOffers.searched.ready) {
      await this.#completeTradeOffers();
    }
  }

  async #onTradeRestartClick(event, button) {
    event.preventDefault();
    event.stopPropagation();
    if (!this.#isTradeMode() || !this.#tradeOffers.completed || !this.#canInteract()) return;
    if (this.#tradeSessionSnapshot) {
      const result = await requestTradeSessionAction("restartTrade", this.#prepareTradeSessionActionPayload({}));
      if (result?.snapshot) this.#applyTradeSessionSnapshot(result.snapshot, { render: true });
      return;
    }
    this.#tradeOffers = createEmptyTradeOffers();
    this.#broadcastTradeOffers();
    this.#captureScrollPositions();
    await this.#renderPreservingWindowStack();
  }

  async #claimCompletedTradeOfferEntry(entryElement = null) {
    if (!this.#tradeOffers.completed || !entryElement) return;
    const side = String(entryElement.dataset.tradeOfferSide ?? "");
    const kind = String(entryElement.dataset.tradeOfferKind ?? "");
    const key = String(entryElement.dataset.tradeOfferKey ?? "");
    const targetActor = this.#getActorForTradeSide(side);
    const entry = findTradeOfferEntry(this.#tradeOffers?.[side], kind, key);
    if (!TRADE_OFFER_SIDES.includes(side) || kind !== "item" || !key || !targetActor || !this.#canClaimCompletedTradeSide(side)) return;
    const itemData = getTradeOfferEntryItemData(entry, null);
    if (!itemData) return;
    const available = Math.max(1, toInteger(entry?.quantity));
    const quantity = available > 1 && !isContainerItem(itemData)
      ? await promptSearchItemStackQuantity({
        item: itemData,
        title: "Забрать купленное",
        actionLabel: "Забрать",
        max: available,
        value: available
      })
      : available;
    if (!quantity) return;
    const target = getCompletedTradeClaimTarget(targetActor, itemData, entry?.containedItems ?? [], { quantity });
    if (!target) {
      ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));
      return;
    }
    const payload = this.#prepareTradeSessionActionPayload({
      offers: this.#tradeOffers,
      side,
      kind,
      key,
      targetActorUuid: targetActor.uuid,
      targetMode: "inventory",
      targetParentId: String(target.parentId ?? ROOT_CONTAINER_ID),
      targetX: target.placement?.x ?? null,
      targetY: target.placement?.y ?? null,
      autoTargetParent: false,
      quantity
    });
    this.#beginInventoryMutation();
    try {
      if (this.#tradeSessionSnapshot) {
        const result = await requestTradeSessionAction("claimCompletedTradeEntry", payload);
        if (result?.snapshot) this.#applyTradeSessionSnapshot(result.snapshot, { render: false });
      } else {
        const result = await enqueueSearchInventoryOperation(() => performCompletedTradeEntryClaim(payload, game.user?.id ?? ""));
        this.#tradeOffers = normalizeTradeOffersState(result?.offers ?? this.#tradeOffers);
        this.#broadcastTradeOffers();
      }
    } finally {
      this.#endInventoryMutation();
      this.#captureScrollPositions();
      await this.#renderPreservingWindowStack();
    }
  }

  async #onTradeOfferRemoveClick(event, button) {
    event.preventDefault();
    event.stopPropagation();
    this.#clearInventoryTooltip({ force: true });
    document.querySelectorAll(".fallout-maw-inventory-context-menu").forEach(menu => menu.remove());
    const side = String(button?.dataset?.tradeSide ?? "");
    if (!TRADE_OFFER_SIDES.includes(side) || !this.#canManageTradeOfferSide(side)) return;
    const kind = String(button?.dataset?.tradeOfferRemove ?? "");
    const key = String(button?.dataset?.tradeOfferKey ?? "");
    if (this.#tradeOffers.completed && kind === "all") {
      await this.#claimCompletedTradeOfferSide(side);
      return;
    }
    if (this.#tradeSessionSnapshot) {
      let amount = 0;
      let quantity = 0;
      if (kind === "currency") {
        amount = await this.#promptTradeCurrencyRemoval(side, key);
        if (!amount) return;
      } else if (kind === "item") {
        quantity = await this.#promptTradeItemRemoval(side, key);
        if (!quantity) return;
      }
      const result = await requestTradeSessionAction("removeTradeOfferEntry", this.#prepareTradeSessionActionPayload({
        side,
        kind,
        key,
        actorUuid: this.#getActorForTradeSide(side)?.uuid ?? "",
        amount,
        quantity
      }));
      if (result?.snapshot) this.#applyTradeSessionSnapshot(result.snapshot, { render: true });
      return;
    }
    if (kind === "item") {
      const quantity = await this.#promptTradeItemRemoval(side, key);
      if (!quantity) return;
      this.#tradeOffers = reduceTradeOfferEntryQuantity(this.#tradeOffers, side, kind, key, quantity);
    } else if (kind === "currency") {
      const amount = await this.#promptTradeCurrencyRemoval(side, key);
      if (!amount) return;
      this.#tradeOffers = reduceTradeOfferEntryQuantity(this.#tradeOffers, side, kind, key, amount);
    } else {
      this.#tradeOffers = removeTradeOfferEntry(this.#tradeOffers, side, kind, key);
    }
    if (!this.#tradeOffers.completed) this.#resetTradeReady();
    this.#broadcastTradeOffers();
    this.#captureScrollPositions();
    await this.#renderPreservingWindowStack();
  }

  async #claimCompletedTradeOfferSide(side = "") {
    const targetActor = this.#getActorForTradeSide(side);
    if (!targetActor || !this.#canClaimCompletedTradeSide(side)) return;
    const entries = [
      ...(this.#tradeOffers?.[side]?.items ?? []).map(entry => ({
        kind: "item",
        key: getTradeOfferEntryKey(entry, "item"),
        quantity: Math.max(1, toInteger(entry.quantity)),
        itemData: getTradeOfferEntryItemData(entry, null),
        containedItems: entry.containedItems ?? []
      })),
      ...(this.#tradeOffers?.[side]?.currencies ?? []).map(entry => ({
        kind: "currency",
        key: getTradeOfferEntryKey(entry, "currency"),
        quantity: Math.max(1, toInteger(entry.amount))
      }))
    ];
    const batchEntries = [];
    for (const entry of entries) {
      const target = entry.kind === "item"
        ? getCompletedTradeClaimTarget(targetActor, entry.itemData, entry.containedItems, { quantity: entry.quantity })
        : null;
      if (entry.kind === "item" && !target) {
        ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));
        break;
      }
      batchEntries.push({
        side,
        kind: entry.kind,
        key: entry.key,
        targetActorUuid: targetActor.uuid,
        targetMode: "inventory",
        targetParentId: String(target?.parentId ?? ROOT_CONTAINER_ID),
        targetX: target?.placement?.x ?? null,
        targetY: target?.placement?.y ?? null,
        autoTargetParent: false,
        quantity: entry.quantity
      });
    }
    if (!batchEntries.length) return;
    this.#beginInventoryMutation();
    try {
      if (this.#tradeSessionSnapshot) {
        const result = await requestTradeSessionAction("claimCompletedTradeBatch", this.#prepareTradeSessionActionPayload({
          offers: this.#tradeOffers,
          entries: batchEntries
        }));
        if (result?.snapshot) this.#applyTradeSessionSnapshot(result.snapshot, { render: false });
      } else {
        const result = await enqueueSearchInventoryOperation(() => performCompletedTradeBatchClaim({
          ...this.#prepareTradeSessionActionPayload({ offers: this.#tradeOffers }),
          entries: batchEntries
        }, game.user?.id ?? ""));
        this.#tradeOffers = normalizeTradeOffersState(result?.offers ?? this.#tradeOffers);
      }
    } catch (error) {
      console.error(`${SYSTEM_ID} | Completed trade claim all failed`, error);
      ui.notifications.warn(error.message || "Не удалось забрать все купленное.");
    } finally {
      this.#endInventoryMutation();
      this.#captureScrollPositions();
      await this.#renderPreservingWindowStack();
    }
  }

  async #onTradeCurrencyClick(event, button) {
    event.preventDefault();
    event.stopPropagation();
    const actor = this.#getActorByUuid(String(button?.dataset?.searchActorUuid ?? ""));
    const side = this.#getTradeSideForActor(actor?.uuid ?? "");
    const currencyKey = String(button?.dataset?.searchCurrency ?? "");
    if (!actor || !side || !currencyKey || !this.#canManageTradeOfferSide(side)) return;
    if (this.#tradeOffers.completed) return;
    const available = getTradeAvailableCurrencyAmount(this.#tradeOffers[side], actor, currencyKey);
    if (available <= 0) {
      ui.notifications.warn("Свободной валюты нет.");
      return;
    }
    const equalizeAmount = this.#getTradeEqualizeCurrencyAmount(side, currencyKey);
    const currency = getCurrencySettings().find(entry => entry.key === currencyKey);
    const formData = await DialogV2.input({
      window: { title: "Добавить валюту" },
      content: `
        <p><strong>${escapeHTML(currency?.label ?? currencyKey)}</strong>: 0 / ${available}</p>
        <label class="fallout-maw-stacked-field">
          <span>Количество</span>
          <input type="number" name="amount" value="${Math.min(available, Math.max(1, equalizeAmount || available))}" min="1" max="${available}" step="1" autofocus>
        </label>
      `,
      ok: {
        label: "Добавить",
        icon: "fa-solid fa-coins",
        callback: (_event, okButton) => new FormDataExtended(okButton.form).object
      },
      buttons: [
        ...(equalizeAmount > 0 ? [{
          action: "equalize",
          label: "Уравнять",
          icon: "fa-solid fa-scale-balanced",
          callback: () => ({ amount: Math.min(available, equalizeAmount) })
        }] : []),
        {
          action: "cancel",
          label: game.i18n.localize("FALLOUTMAW.Common.Cancel")
        }
      ],
      position: { width: 420 },
      rejectClose: false
    });
    if (!formData || formData === "cancel") return;
    const amount = Math.max(1, Math.min(available, toInteger(formData.amount)));
    if (!amount) return;
    const placement = this.#getTradeOfferDropPlacement({ side, item: null, entryKind: "currency", entryKey: currencyKey });
    if (this.#tradeSessionSnapshot) {
      const result = await requestTradeSessionAction("addTradeOfferCurrency", this.#prepareTradeSessionActionPayload({
        side,
        sourceActorUuid: actor.uuid,
        currencyKey,
        amount,
        placement
      }));
      if (result?.snapshot) this.#applyTradeSessionSnapshot(result.snapshot, { render: true });
      return;
    }
    this.#tradeOffers = addTradeOfferCurrency(this.#tradeOffers, side, currencyKey, amount, placement, actor.uuid, game.user?.id ?? "");
    this.#resetTradeReady();
    this.#broadcastTradeOffers();
    this.#captureScrollPositions();
    await this.#renderPreservingWindowStack();
  }

  async #promptTradeItemRemoval(side = "", key = "") {
    const entry = findTradeOfferEntry(this.#tradeOffers?.[side], "item", key);
    const itemData = getTradeOfferEntryItemData(entry, this.#getActorByUuid(String(entry?.sourceActorUuid ?? "")));
    if (!entry || !itemData) return 0;
    const quantity = Math.max(1, toInteger(entry.quantity));
    if (quantity <= 1 || isContainerItem(itemData)) return quantity;
    return promptSearchItemStackQuantity({
      item: itemData,
      title: "Убрать из предложения",
      actionLabel: "Убрать",
      max: quantity,
      value: quantity
    });
  }

  async #promptTradeCurrencyRemoval(side = "", currencyKey = "") {
    const actorUuid = this.#getActorForTradeSide(side)?.uuid ?? "";
    const available = getTradeOfferCurrencyContributionAmount(this.#tradeOffers?.[side], currencyKey, actorUuid);
    if (available <= 0) {
      ui.notifications.warn("Нет вашего вклада этой валюты.");
      return 0;
    }
    const currency = getCurrencySettings().find(entry => entry.key === currencyKey);
    const formData = await DialogV2.input({
      window: { title: "Убрать валюту" },
      content: `
        <p><strong>${escapeHTML(currency?.label ?? currencyKey)}</strong>: 0 / ${available}</p>
        <label class="fallout-maw-stacked-field">
          <span>${game.i18n.localize("FALLOUTMAW.Item.Quantity")}</span>
          <input type="number" name="amount" value="${available}" min="1" max="${available}" step="1" autofocus>
        </label>
      `,
      ok: {
        label: "Убрать",
        icon: "fa-solid fa-xmark",
        callback: (_event, okButton) => new FormDataExtended(okButton.form).object
      },
      buttons: [{
        action: "cancel",
        label: game.i18n.localize("FALLOUTMAW.Common.Cancel")
      }],
      position: { width: 420 },
      rejectClose: false
    });
    if (!formData || formData === "cancel") return 0;
    return Math.max(1, Math.min(available, toInteger(formData.amount)));
  }

  #setTradeCurrencyKey(currencyKey, { broadcast = false } = {}) {
    if (!this.#isTradeMode()) return;
    const normalized = normalizeTradeCurrencyKey(currencyKey);
    if (normalized === this.#tradeCurrencyKey) return;
    this.#tradeCurrencyKey = normalized;
    if (broadcast && this.#tradeSessionSnapshot) {
      void requestTradeSessionAction("setTradeCurrency", this.#prepareTradeSessionActionPayload({ currencyKey: normalized }))
        .then(result => {
          if (result?.snapshot) this.#applyTradeSessionSnapshot(result.snapshot, { render: true });
        })
        .catch(error => console.error(`${SYSTEM_ID} | Trade currency change failed`, error));
      return;
    }
    if (broadcast) broadcastTradeCurrencyChange(this.#tradeSessionId, normalized);
    if (this.rendered) {
      this.#captureScrollPositions();
      void this.#renderPreservingWindowStack();
    }
  }

  #onTradeItemPointerOver(event) {
    if (!this.#isTradeMode()) return;
    return;
  }

  #onTradeItemPointerOut(event) {
    if (!this.#isTradeMode()) return;
    const itemElement = event.target?.closest?.("[data-item-id][data-search-actor-uuid][data-trade-price]");
    if (!itemElement || !this.element?.contains(itemElement)) return;
    if (itemElement.contains(event.relatedTarget)) return;
    this.#clearTradeCurrencyPreview();
  }

  #previewTradeCurrencyForItem(itemElement) {
    this.#clearTradeCurrencyPreview();
    const localActorUuid = this.#getLocalTradeActorUuid();
    const itemActorUuid = String(itemElement?.dataset?.searchActorUuid ?? "");
    const price = Math.max(0, toInteger(itemElement?.dataset?.tradePrice));
    if (!localActorUuid || !itemActorUuid || !price || !this.#tradeCurrencyKey) return;

    const chip = this.element?.querySelector(
      `[data-search-currency="${CSS.escape(this.#tradeCurrencyKey)}"][data-search-actor-uuid="${CSS.escape(localActorUuid)}"]`
    );
    const amountElement = chip?.querySelector?.(".fallout-maw-currency-amount");
    if (!chip || !amountElement) return;

    const baseAmount = Math.max(0, toInteger(chip.dataset.tradeBaseAmount ?? amountElement.textContent));
    const delta = itemActorUuid === localActorUuid ? price : -price;
    amountElement.textContent = String(baseAmount + delta);
    chip.classList.add("trade-preview");
    chip.classList.toggle("trade-preview-positive", delta > 0);
    chip.classList.toggle("trade-preview-negative", delta < 0);
  }

  #clearTradeCurrencyPreview() {
    for (const chip of this.element?.querySelectorAll(".fallout-maw-currency-chip.trade-preview") ?? []) {
      const amountElement = chip.querySelector(".fallout-maw-currency-amount");
      if (amountElement) amountElement.textContent = String(toInteger(chip.dataset.tradeBaseAmount ?? amountElement.textContent));
      chip.classList.remove("trade-preview", "trade-preview-positive", "trade-preview-negative");
    }
  }

  #getLocalTradeActorUuid() {
    if (this.#searcherActor?.testUserPermission?.(game.user, "OWNER")) return this.#searcherActor.uuid;
    if (this.#searchedActor?.testUserPermission?.(game.user, "OWNER")) return this.#searchedActor.uuid;
    return game.user?.isGM ? (this.#searcherActor?.uuid ?? this.#searchedActor?.uuid ?? "") : "";
  }

  #openSearchContainerSheet(item) {
    if (!isContainerItem(item)) return null;
    const app = new FalloutMaWContainerSheet({ document: item });
    app.render({ force: true });
    app.bringToFront();
    return app;
  }

  #resolveSearchItemRotation(actor, item) {
    const parentId = item.system?.placement?.mode === LOCKED_STORAGE_PLACEMENT_MODE
      ? LOCKED_STORAGE_PARENT_ID
      : getItemContainerParentId(item);
    const { columns, rows } = getActorInventoryContextDimensions(actor, parentId);
    return resolveInventoryItemRotation({
      item,
      parentId,
      contextItems: getContextInventoryItems(parentId, actor.items),
      columns,
      rows,
      allItems: actor.items,
      excludeItemIds: [item.id],
      options: getActorInventoryContextOptions(actor, parentId)
    });
  }

  async #takeButcheringItem(sourceActor, item) {
    if (!isItemInButcheringStorage(item) || sourceActor?.uuid !== this.#searchedActorUuid) return;
    const targetActor = this.#searcherActor;
    const targetParentId = getQuickTransferTargetParentId({ sourceActor, targetActor, sourceItem: item });
    if (!targetActor || targetParentId === null) {
      ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));
      return;
    }
    return this.#executeSearchTransfer({
      searcherActorUuid: this.#searcherActorUuid,
      searchedActorUuid: this.#searchedActorUuid,
      sourceActorUuid: sourceActor.uuid,
      targetActorUuid: targetActor.uuid,
      itemId: item.id,
      targetMode: "inventory",
      targetParentId,
      targetEquipmentSlot: "",
      targetWeaponSet: "",
      targetWeaponSlot: "",
      targetX: null,
      targetY: null,
      targetItemId: ""
    });
  }

  async #rotateSearchItem(actor, item, resolution = this.#resolveSearchItemRotation(actor, item)) {
    const updateData = createInventoryRotationUpdate(item, resolution);
    if (!updateData) {
      ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));
      return null;
    }
    const payload = this.#prepareSearchOperationPayload({
      searcherActorUuid: this.#searcherActorUuid,
      searchedActorUuid: this.#searchedActorUuid,
      actorUuid: actor.uuid,
      itemId: item.id
    });
    try {
      const responsibleGM = getResponsibleGM();
      if (responsibleGM && responsibleGM.id !== game.user?.id) {
        await requestSearchInventorySocket("rotateItem", payload, responsibleGM);
      } else if (canModifySearchTransferDirectly(actor, actor)) {
        await enqueueSearchInventoryOperation(() => performSearchInventoryRotate(payload, game.user?.id ?? ""));
      } else {
        await requestSearchInventorySocket("rotateItem", payload, responsibleGM);
      }
    } catch (error) {
      console.error(`${SYSTEM_ID} | Search inventory rotate failed`, error);
      ui.notifications.warn(error.message || game.i18n.localize("FALLOUTMAW.Messages.InventoryRotateNoSpace"));
    }
    return null;
  }

  async #equipSearchItem(actor, item) {
    return this.#executeSearchTransfer({
      searcherActorUuid: this.#searcherActorUuid,
      searchedActorUuid: this.#searchedActorUuid,
      sourceActorUuid: actor.uuid,
      targetActorUuid: actor.uuid,
      itemId: item.id,
      targetMode: "equipment",
      targetParentId: ROOT_CONTAINER_ID,
      targetEquipmentSlot: "",
      targetWeaponSet: "",
      targetWeaponSlot: "",
      targetX: null,
      targetY: null,
      targetItemId: ""
    });
  }

  async #unequipSearchItem(actor, item) {
    const placement = getFirstAvailableActorInventoryPlacement(actor, ROOT_CONTAINER_ID, item, [item.id], []);
    if (!placement) {
      ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));
      return null;
    }
    return this.#executeSearchTransfer({
      searcherActorUuid: this.#searcherActorUuid,
      searchedActorUuid: this.#searchedActorUuid,
      sourceActorUuid: actor.uuid,
      targetActorUuid: actor.uuid,
      itemId: item.id,
      targetMode: "inventory",
      targetParentId: ROOT_CONTAINER_ID,
      targetEquipmentSlot: "",
      targetWeaponSet: "",
      targetWeaponSlot: "",
      targetX: placement.x,
      targetY: placement.y,
      targetItemId: ""
    });
  }

  async #splitSearchItem(actor, item, { stackIndex = 0, stackQuantity = 0 } = {}) {
    const quantity = usesVirtualInventoryStacks(item)
      ? Math.max(1, stackQuantity || getItemStackPartQuantity(item, stackIndex))
      : getItemQuantity(item);
    if (quantity <= 1) return null;
    const amount = await promptSearchItemStackQuantity({
      item,
      title: "Разделить предмет",
      actionLabel: "Разделить",
      max: quantity - 1,
      value: Math.max(1, Math.floor(quantity / 2))
    });
    if (!amount) return null;

    const payload = {
      searcherActorUuid: this.#searcherActorUuid,
      searchedActorUuid: this.#searchedActorUuid,
      actorUuid: actor.uuid,
      itemId: item.id,
      amount,
      stackIndex: Math.max(0, toInteger(stackIndex))
    };
    try {
      const responsibleGM = getResponsibleGM();
      if (responsibleGM && responsibleGM.id !== game.user?.id) {
        await requestSearchInventorySocket("splitItem", payload, responsibleGM);
      } else if (game.user?.isGM || actor.testUserPermission?.(game.user, "OWNER")) {
        await enqueueSearchInventoryOperation(() => performSearchInventorySplit(payload, game.user?.id ?? ""));
      } else {
        await requestSearchInventorySocket("splitItem", payload, responsibleGM);
      }
    } catch (error) {
      console.error(`${SYSTEM_ID} | Search inventory split failed`, error);
      ui.notifications.warn(error.message || "Не удалось разделить предмет.");
    }
    return null;
  }

  async #dropSearchItem(actor, item, { stackIndex = 0, stackQuantity = 0 } = {}) {
    if (!actor || !item) return null;
    if (!game.user?.isGM && !actor.testUserPermission?.(game.user, "OWNER")) {
      ui.notifications.warn("Нет прав на выбрасывание предметов этого актера.");
      return null;
    }
    const quantity = usesVirtualInventoryStacks(item)
      ? Math.max(1, stackQuantity || getItemStackPartQuantity(item, stackIndex))
      : getItemQuantity(item);
    try {
      await dropActorInventoryItem(actor, item, {
        quantity,
        stackIndex: Math.max(0, toInteger(stackIndex))
      });
      this.#clearInventoryTooltip({ force: true });
      this.#captureScrollPositions();
      await this.#renderPreservingWindowStack();
    } catch (error) {
      console.error(`${SYSTEM_ID} | Search inventory item drop failed`, error);
      ui.notifications.warn(error.message || "Не удалось выбросить предмет.");
    }
    return null;
  }

  async #deleteSearchItem(actor, item, { stackIndex = 0, stackQuantity = 0 } = {}) {
    if (!usesVirtualInventoryStacks(item)) return item.delete();
    const amount = Math.max(1, stackQuantity || getItemStackPartQuantity(item, stackIndex));
    const updateData = createItemStackPartRemovalUpdate(item, amount, stackIndex);
    if (!updateData || (updateData["system.quantity"] ?? 0) <= 0) return actor.deleteEmbeddedDocuments("Item", [item.id]);
    return actor.updateEmbeddedDocuments("Item", [updateData]);
  }

  async #transferItemToOppositeRoot(itemElement) {
    if (!this.#canInteract()) return;
    const sourceActor = this.#getActorByUuid(String(itemElement?.dataset?.searchActorUuid ?? ""));
    const targetActor = sourceActor?.uuid === this.#searcherActorUuid ? this.#searchedActor : this.#searcherActor;
    const item = sourceActor?.items?.get(String(itemElement?.dataset?.itemId ?? ""));
    if (!sourceActor || !targetActor || !item || sourceActor.uuid === targetActor.uuid) return;
    const sourceStackIndex = Math.max(0, toInteger(itemElement?.dataset?.stackIndex));
    const sourceStackQuantity = Math.max(0, toInteger(itemElement?.dataset?.stackQuantity));
    const targetParentId = getQuickTransferTargetParentId({ sourceActor, targetActor, sourceItem: item });
    if (targetParentId === null) {
      ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));
      return;
    }
    this.#clearInventoryTooltip({ force: true });
    await this.#executeSearchTransfer({
      searcherActorUuid: this.#searcherActorUuid,
      searchedActorUuid: this.#searchedActorUuid,
      sourceActorUuid: sourceActor.uuid,
      targetActorUuid: targetActor.uuid,
      itemId: item.id,
      targetMode: "inventory",
      targetParentId,
      targetEquipmentSlot: "",
      targetWeaponSet: "",
      targetWeaponSlot: "",
      targetX: null,
      targetY: null,
      targetItemId: "",
      quantity: usesVirtualInventoryStacks(item)
        ? Math.max(1, sourceStackQuantity || getItemStackPartQuantity(item, sourceStackIndex))
        : getItemQuantity(item),
      sourceStackIndex
    });
  }

  async #onSearchBulkTransferClick(event, button) {
    event.preventDefault();
    event.stopPropagation();
    if (!this.#canInteract() || this.#bulkTransferInProgress) return;

    const direction = String(button?.dataset?.searchBulkTransfer ?? "");
    const sourceActor = direction === "take" ? this.#searchedActor : this.#searcherActor;
    const targetActor = direction === "take" ? this.#searcherActor : this.#searchedActor;
    if (!sourceActor || !targetActor || sourceActor.uuid === targetActor.uuid) return;

    if (direction === "put") {
      const confirmed = await DialogV2.confirm({
        window: {
          title: "Положить все"
        },
        content: `<p>Перенести все предметы и валюту из <strong>${escapeHTML(sourceActor.name)}</strong> в <strong>${escapeHTML(targetActor.name)}</strong>?</p>`,
        yes: {
          label: "Да",
          icon: "fa-solid fa-check"
        },
        no: {
          label: "Нет"
        },
        rejectClose: false,
        modal: true
      });
      if (!confirmed) return;
    }

    this.#bulkTransferInProgress = true;
    this.element?.querySelectorAll("[data-search-bulk-transfer]").forEach(element => {
      element.disabled = true;
    });
    this.#clearInventoryTooltip({ force: true });

    try {
      const result = await this.#transferAllBetweenActors(sourceActor, targetActor);
      if (result.failedItems > 0) {
        ui.notifications.warn(`Не удалось перенести предметов: ${result.failedItems}.`);
      }
      if (!result.items && !result.currencies && !result.failedItems) {
        ui.notifications.info("Нечего переносить.");
      }
    } finally {
      this.#bulkTransferInProgress = false;
      this.element?.querySelectorAll("[data-search-bulk-transfer]").forEach(element => {
        element.disabled = !this.#canInteract();
      });
    }
  }

  async #transferAllBetweenActors(sourceActor, targetActor) {
    const result = {
      items: 0,
      failedItems: 0,
      currencies: 0
    };

    const sourceItemIds = getBulkTransferSourceItemIds(sourceActor);
    for (const itemId of sourceItemIds) {
      const item = sourceActor.items?.get(itemId);
      if (!item) continue;
      const targetParentId = getQuickTransferTargetParentId({ sourceActor, targetActor, sourceItem: item });
      if (targetParentId === null) {
        result.failedItems += 1;
        continue;
      }
      const moved = await this.#executeSearchTransfer({
        searcherActorUuid: this.#searcherActorUuid,
        searchedActorUuid: this.#searchedActorUuid,
        sourceActorUuid: sourceActor.uuid,
        targetActorUuid: targetActor.uuid,
        itemId: item.id,
        targetMode: "inventory",
        targetParentId,
        targetEquipmentSlot: "",
        targetWeaponSet: "",
        targetWeaponSlot: "",
        targetX: null,
        targetY: null,
        targetItemId: ""
      }, { notify: false });
      if (moved) result.items += 1;
      else result.failedItems += 1;
    }

    for (const currency of getCurrencySettings()) {
      const currencyKey = String(currency?.key ?? "");
      const amount = Math.max(0, toInteger(sourceActor.system?.currencies?.[currencyKey]));
      if (!currencyKey || !amount) continue;
      const moved = await this.#executeSearchCurrencyTransfer({
        searcherActorUuid: this.#searcherActorUuid,
        searchedActorUuid: this.#searchedActorUuid,
        sourceActorUuid: sourceActor.uuid,
        targetActorUuid: targetActor.uuid,
        currencyKey,
        amount
      }, { notify: false });
      if (moved) result.currencies += 1;
    }

    return result;
  }

  async #onSearchCurrencyClick(event, button) {
    event.preventDefault();
    event.stopPropagation();
    if (!this.#canInteract()) return;

    const sourceActor = this.#getActorByUuid(String(button?.dataset?.searchActorUuid ?? ""));
    const targetActor = sourceActor?.uuid === this.#searcherActorUuid ? this.#searchedActor : this.#searcherActor;
    const currencyKey = String(button?.dataset?.searchCurrency ?? "");
    if (!sourceActor || !targetActor || !currencyKey || sourceActor.uuid === targetActor.uuid) return;

    const currency = getCurrencySettings().find(entry => entry.key === currencyKey);
    const available = Math.max(0, toInteger(sourceActor.system?.currencies?.[currencyKey]));
    if (!available) {
      ui.notifications.warn("У актера нет этой валюты.");
      return;
    }

    const actionLabel = sourceActor.uuid === this.#searchedActorUuid ? "Забрать" : "Переложить";
    const formData = await DialogV2.input({
      window: {
        title: `${actionLabel} валюту`
      },
      content: `
        <p><strong>${escapeHTML(sourceActor.name)}</strong> -> <strong>${escapeHTML(targetActor.name)}</strong></p>
        <label class="fallout-maw-stacked-field">
          <span>${escapeHTML(currency?.label ?? currencyKey)}: 0 / ${available}</span>
          <input type="number" name="amount" value="${available}" min="1" max="${available}" step="1" autofocus>
        </label>
      `,
      ok: {
        label: actionLabel,
        icon: "fa-solid fa-coins",
        callback: (_event, okButton) => new FormDataExtended(okButton.form).object
      },
      buttons: [{
        action: "cancel",
        label: "Отмена"
      }],
      position: {
        width: 420
      },
      rejectClose: false
    });
    if (!formData || formData === "cancel") return;

    const amount = Math.max(1, Math.min(available, toInteger(formData.amount)));
    if (!amount) return;
    const payload = {
      searcherActorUuid: this.#searcherActorUuid,
      searchedActorUuid: this.#searchedActorUuid,
      sourceActorUuid: sourceActor.uuid,
      targetActorUuid: targetActor.uuid,
      currencyKey,
      amount
    };

    try {
      const responsibleGM = getResponsibleGM();
      if (responsibleGM && responsibleGM.id !== game.user?.id) {
        await requestSearchInventorySocket("transferCurrency", payload, responsibleGM);
      } else if (canModifySearchTransferDirectly(sourceActor, targetActor)) {
        await enqueueSearchInventoryOperation(() => performSearchCurrencyTransfer(payload, game.user?.id ?? ""));
      } else {
        await requestSearchInventorySocket("transferCurrency", payload, responsibleGM);
      }
    } catch (error) {
      console.error(`${SYSTEM_ID} | Search currency transfer failed`, error);
      ui.notifications.warn(error.message || "Не удалось перенести валюту.");
    }
  }

  async #executeSearchCurrencyTransfer(payload, { notify = true } = {}) {
    const sourceActor = this.#getActorByUuid(String(payload?.sourceActorUuid ?? ""));
    const targetActor = this.#getActorByUuid(String(payload?.targetActorUuid ?? ""));
    if (!sourceActor || !targetActor) return false;
    try {
      const responsibleGM = getResponsibleGM();
      if (responsibleGM && responsibleGM.id !== game.user?.id) {
        await requestSearchInventorySocket("transferCurrency", payload, responsibleGM);
      } else if (canModifySearchTransferDirectly(sourceActor, targetActor)) {
        await enqueueSearchInventoryOperation(() => performSearchCurrencyTransfer(payload, game.user?.id ?? ""));
      } else {
        await requestSearchInventorySocket("transferCurrency", payload, responsibleGM);
      }
      return true;
    } catch (error) {
      console.error(`${SYSTEM_ID} | Search currency transfer failed`, error);
      if (notify) ui.notifications.warn(error.message || "Не удалось перенести валюту.");
    }
    return false;
  }

  #onInventoryTooltipPointerOver(event) {
    if (this.#tooltipPinned) return;
    const anchor = event.target?.closest?.("[data-tooltip-item][data-search-actor-uuid]");
    if (!anchor || !this.element?.contains(anchor)) return;
    this.#cancelInventoryTooltipClose();
    this.#tooltipCompareMode = Boolean(event.ctrlKey);
    if (this.#tooltipAnchorElement === anchor && this.#tooltipElement) return;
    this.#scheduleInventoryTooltip(anchor, { compareMode: event.ctrlKey });
  }

  #onInventoryTooltipPointerOut(event) {
    const anchor = event.target?.closest?.("[data-tooltip-item][data-search-actor-uuid]");
    if (!anchor || !this.element?.contains(anchor)) return;
    if (anchor.contains(event.relatedTarget) || this.#tooltipElement?.contains(event.relatedTarget)) return;
    const nextAnchor = event.relatedTarget?.closest?.("[data-tooltip-item][data-search-actor-uuid]");
    if (nextAnchor && this.element?.contains(nextAnchor)) return;
    if (!this.#tooltipPinned) this.#scheduleInventoryTooltipClose();
  }

  #onInventoryTooltipAuxClick(event) {
    if (event.button !== 1) return;
    const anchor = event.target?.closest?.("[data-tooltip-item][data-search-actor-uuid]");
    if (!anchor || !this.element?.contains(anchor)) return;
    event.preventDefault();
    event.stopPropagation();
    this.#clearInventoryTooltip({ force: true });
    this.#tooltipCompareMode = Boolean(event.ctrlKey);
    void this.#showInventoryTooltip(anchor, { pinned: true });
  }

  #scheduleInventoryTooltip(anchor, { compareMode = this.#tooltipCompareMode } = {}) {
    if (this.#tooltipPinned) return;
    this.#tooltipCompareMode = Boolean(compareMode);
    const view = this.element?.ownerDocument?.defaultView ?? window;
    if (this.#tooltipElement && !this.#tooltipPinned) {
      if (this.#tooltipTimer) {
        view.clearTimeout(this.#tooltipTimer);
        this.#tooltipTimer = null;
      }
      const actorUuid = String(anchor.dataset.searchActorUuid ?? "");
      const itemId = String(anchor.dataset.tooltipItem ?? anchor.dataset.itemId ?? "");
      if (actorUuid === this.#tooltipActorUuid && itemId === this.#tooltipItemId) {
        this.#tooltipAnchorElement = anchor;
        this.#positionInventoryTooltip();
        this.#updateInventoryTooltipOverflowState(this.#tooltipElement);
        return;
      }
      this.#tooltipAnchorElement = anchor;
      this.#tooltipActorUuid = actorUuid;
      this.#tooltipItemId = itemId;
      this.#tooltipWeaponTabIndex = 0;
      void this.#showInventoryTooltip(anchor, { refresh: true });
      return;
    }

    this.#clearInventoryTooltip();
    this.#tooltipCompareMode = Boolean(compareMode);
    this.#tooltipAnchorElement = anchor;
    this.#tooltipActorUuid = String(anchor.dataset.searchActorUuid ?? "");
    this.#tooltipItemId = String(anchor.dataset.tooltipItem ?? anchor.dataset.itemId ?? "");
    this.#tooltipWeaponTabIndex = 0;
    this.#tooltipTimer = view.setTimeout(() => {
      this.#tooltipTimer = null;
      void this.#showInventoryTooltip(anchor);
    }, 420);
  }

  async #showInventoryTooltip(anchor = this.#tooltipAnchorElement, { pinned = false, refresh = false } = {}) {
    const actor = this.#getActorByUuid(String(anchor?.dataset?.searchActorUuid ?? this.#tooltipActorUuid));
    const itemId = String(anchor?.dataset?.tooltipItem ?? anchor?.dataset?.itemId ?? this.#tooltipItemId);
    const item = actor?.items?.get(itemId);
    if (!actor || !item) return;

    const tooltipHTML = await renderInventoryItemTooltipHTML(item, actor, {
      activeWeaponIndex: this.#tooltipWeaponTabIndex,
      baseMode: false,
      compareActor: getInventoryTooltipCompareActor(),
      compareMode: this.#tooltipCompareMode
    });
    if (refresh && ((this.#tooltipActorUuid !== actor.uuid) || (this.#tooltipItemId !== item.id))) return;

    if (refresh && this.#tooltipElement) {
      const keepPinned = this.#tooltipPinned || Boolean(pinned);
      this.#tooltipElement.innerHTML = tooltipHTML;
      this.#tooltipElement.classList.toggle("pinned", keepPinned);
      this.#tooltipElement.style.pointerEvents = keepPinned ? "auto" : "none";
      this.#tooltipPinned = keepPinned;
      this.#tooltipAnchorElement = anchor;
      this.#tooltipActorUuid = actor.uuid;
      this.#tooltipItemId = item.id;
      if (keepPinned) this.#bindInventoryTooltipDocumentClose();
      this.#bindInventoryTooltipKeyMode();
      this.#positionInventoryTooltip();
      requestAnimationFrame(() => {
        const description = this.#tooltipElement?.querySelector(".description");
        description?.classList.toggle("overflowing", description.clientHeight < description.scrollHeight);
        this.#positionInventoryTooltip();
      });
      return;
    }

    this.#clearInventoryTooltip({ keepAnchor: true });
    const tooltip = document.createElement("aside");
    tooltip.className = "fallout-maw-inventory-tooltip";
    tooltip.classList.toggle("pinned", Boolean(pinned));
    tooltip.style.setProperty("--fallout-maw-ui-scale", String(this.#uiScale));
    tooltip.style.pointerEvents = pinned ? "auto" : "none";
    tooltip.innerHTML = tooltipHTML;
    tooltip.addEventListener("pointerdown", () => this.#syncInventoryTooltipLayer({ bringToFront: true }));
    tooltip.addEventListener("pointerenter", () => this.#cancelInventoryTooltipClose());
    tooltip.addEventListener("pointerleave", event => {
      if (this.#tooltipPinned) return;
      if (this.#tooltipAnchorElement?.contains(event.relatedTarget)) return;
      this.#scheduleInventoryTooltipClose();
    });
    tooltip.addEventListener("click", event => this.#onTooltipClick(event));
    tooltip.addEventListener("auxclick", event => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      this.#tooltipPinned = true;
      tooltip.classList.add("pinned");
      tooltip.style.pointerEvents = "auto";
      this.#bindInventoryTooltipDocumentClose();
      this.#syncInventoryTooltipLayer({ bringToFront: true });
    });
    document.body.append(tooltip);
    this.#tooltipElement = tooltip;
    this.#tooltipPinned = Boolean(pinned);
    this.#tooltipAnchorElement = anchor;
    this.#tooltipActorUuid = actor.uuid;
    this.#tooltipItemId = item.id;
    if (pinned) this.#bindInventoryTooltipDocumentClose();
    this.#bindInventoryTooltipKeyMode();
    this.#syncInventoryTooltipLayer({ bringToFront: pinned });
    this.#positionInventoryTooltip();
    requestAnimationFrame(() => {
      const description = tooltip.querySelector(".description");
      description?.classList.toggle("overflowing", description.clientHeight < description.scrollHeight);
      this.#positionInventoryTooltip();
    });
  }

  #restoreInventoryTooltipAfterRender() {
    if (!this.#tooltipActorUuid || !this.#tooltipItemId) return;
    if (!this.#tooltipElement && !this.#tooltipTimer) return;
    const anchor = this.#findInventoryTooltipAnchor(this.#tooltipActorUuid, this.#tooltipItemId);
    if (!anchor) {
      this.#clearInventoryTooltip({ force: true });
      return;
    }

    this.#tooltipAnchorElement = anchor;
    this.#cancelInventoryTooltipClose();
    if (this.#tooltipTimer) {
      const view = this.element?.ownerDocument?.defaultView ?? window;
      view.clearTimeout(this.#tooltipTimer);
      this.#tooltipTimer = null;
      this.#scheduleInventoryTooltip(anchor);
      return;
    }
    if (!this.#tooltipElement) return;
    this.#tooltipAnchorElement = anchor;
    this.#tooltipActorUuid = String(anchor.dataset.searchActorUuid ?? this.#tooltipActorUuid);
    this.#tooltipItemId = String(anchor.dataset.tooltipItem ?? anchor.dataset.itemId ?? this.#tooltipItemId);
    this.#positionInventoryTooltip();
    this.#updateInventoryTooltipOverflowState(this.#tooltipElement);
  }

  #findInventoryTooltipAnchor(actorUuid = "", itemId = "") {
    if (!this.element || !actorUuid || !itemId) return null;
    const escapedActorUuid = CSS.escape(actorUuid);
    const escapedItemId = CSS.escape(itemId);
    return this.element.querySelector(
      `[data-tooltip-item="${escapedItemId}"][data-search-actor-uuid="${escapedActorUuid}"],`
      + `[data-tooltip-item][data-item-id="${escapedItemId}"][data-search-actor-uuid="${escapedActorUuid}"]`
    );
  }

  #onTooltipClick(event) {
    const button = event.target?.closest?.("[data-tooltip-weapon-tab]");
    if (!button || !this.#tooltipElement?.contains(button)) return;
    event.preventDefault();
    event.stopPropagation();
    const index = Math.max(0, toInteger(button.dataset.tooltipWeaponTab));
    this.#tooltipWeaponTabIndex = index;
    if (this.#tooltipElement?.querySelector(".fallout-maw-tooltip-comparison")) {
      void this.#showInventoryTooltip(this.#tooltipAnchorElement, { refresh: true });
      return;
    }
    this.#tooltipElement.querySelectorAll("[data-tooltip-weapon-tab]").forEach(entry => {
      const active = toInteger(entry.dataset.tooltipWeaponTab) === index;
      entry.classList.toggle("active", active);
      entry.setAttribute("aria-selected", active ? "true" : "false");
    });
    this.#tooltipElement.querySelectorAll("[data-tooltip-weapon-panel]").forEach(panel => {
      panel.classList.toggle("active", toInteger(panel.dataset.tooltipWeaponPanel) === index);
    });
    this.#positionInventoryTooltip();
  }

  #positionInventoryTooltip() {
    if (!this.#tooltipElement || !this.#tooltipAnchorElement?.isConnected) return;
    this.#syncInventoryTooltipLayer();
    const { viewportWidth, viewportHeight } = this.#getViewportMetrics();
    const margin = Math.max(8, 12 * this.#uiScale);
    const gap = Math.max(10, 12 * this.#uiScale);
    const anchorRect = this.#tooltipAnchorElement.getBoundingClientRect();
    let tooltipRect = this.#tooltipElement.getBoundingClientRect();
    let left = anchorRect.right + gap;
    if ((left + tooltipRect.width) > (viewportWidth - margin)) left = anchorRect.left - tooltipRect.width - gap;
    left = Math.max(margin, Math.min(viewportWidth - tooltipRect.width - margin, left));
    let top = anchorRect.top + ((anchorRect.height - tooltipRect.height) / 2);
    top = Math.max(margin, Math.min(viewportHeight - tooltipRect.height - margin, top));
    this.#tooltipElement.style.left = `${Math.round(left)}px`;
    this.#tooltipElement.style.top = `${Math.round(top)}px`;
    this.#tooltipElement.style.maxHeight = `${Math.max(220, viewportHeight - (margin * 2))}px`;
    tooltipRect = this.#tooltipElement.getBoundingClientRect();
    if ((tooltipRect.top + tooltipRect.height) > (viewportHeight - margin)) {
      this.#tooltipElement.style.top = `${Math.round(Math.max(margin, viewportHeight - tooltipRect.height - margin))}px`;
    }
  }

  async #onButcheringClick(event, button) {
    event.preventDefault();
    event.stopPropagation();
    if (!this.#canInteract() || this.#isTradeMode() || this.#butcheringInProgress) return;
    if (!canStartActorButchering(this.#searchedActor)) return;

    this.#butcheringInProgress = true;
    button.disabled = true;
    try {
      const payload = {
        searcherActorUuid: this.#searcherActorUuid,
        searchedActorUuid: this.#searchedActorUuid
      };
      const responsibleGM = getResponsibleGM();
      if (responsibleGM && responsibleGM.id !== game.user?.id) {
        await requestSearchInventorySocket("butcherActor", payload, responsibleGM);
      } else if (game.user?.isGM) {
        await enqueueSearchInventoryOperation(
          () => performActorButchering(payload, game.user?.id ?? "")
        );
      } else {
        await requestSearchInventorySocket("butcherActor", payload, responsibleGM);
      }
      ui.notifications.info(`${this.#searchedActor?.name ?? "Цель"}: разделка завершена.`);
    } catch (error) {
      console.error(`${SYSTEM_ID} | Butchering failed`, error);
      ui.notifications.warn(error.message || "Не удалось выполнить разделку.");
    } finally {
      this.#butcheringInProgress = false;
      if (button.isConnected) button.disabled = !canStartActorButchering(this.#searchedActor);
    }
  }

  #syncInventoryTooltipLayer({ bringToFront = false } = {}) {
    if (bringToFront) this.bringToFront?.();
    const baseZIndex = getOverlayBaseZIndex(this.element);
    if (this.#tooltipElement) this.#tooltipElement.style.zIndex = String(baseZIndex + 2);
    if (game.tooltip?.element && this.#tooltipElement?.contains(game.tooltip.element)) {
      game.tooltip.tooltip.style.zIndex = String(baseZIndex + 3);
    }
    const ownerDocument = this.element?.ownerDocument ?? document;
    const menus = ownerDocument.querySelectorAll(".fallout-maw-inventory-context-menu");
    for (const menu of menus) menu.style.zIndex = String(baseZIndex + 2);
    if (bringToFront || this.#tooltipPinned || menus.length) reserveOverlayZIndex(baseZIndex + 3);
  }

  #applyOverlayUiScale(element) {
    if (!element) return;
    element.style.setProperty("--fallout-maw-ui-scale", String(this.#uiScale));
  }

  #positionOverlayAtPointer(element, pointer = {}, baseMargin = 14) {
    if (!element) return;
    const { viewportWidth, viewportHeight } = this.#getViewportMetrics();
    const rect = element.getBoundingClientRect();
    const margin = Math.max(8, baseMargin * this.#uiScale);
    const pointerX = Number(pointer?.x);
    const pointerY = Number(pointer?.y);
    const x = Math.min(
      (Number.isFinite(pointerX) ? pointerX : 0) + margin,
      viewportWidth - rect.width - margin
    );
    const y = Math.min(
      (Number.isFinite(pointerY) ? pointerY : 0) + margin,
      viewportHeight - rect.height - margin
    );
    element.style.left = `${Math.max(margin, x)}px`;
    element.style.top = `${Math.max(margin, y)}px`;
  }

  #updateInventoryTooltipOverflowState(tooltip = this.#tooltipElement) {
    const description = tooltip?.querySelector(".description");
    description?.classList.toggle("overflowing", description.clientHeight < description.scrollHeight);
  }

  #scheduleInventoryTooltipClose() {
    if (this.#tooltipPinned || this.#tooltipCloseTimer) return;
    const view = this.element?.ownerDocument?.defaultView ?? window;
    this.#tooltipCloseTimer = view.setTimeout(() => {
      this.#tooltipCloseTimer = null;
      this.#clearInventoryTooltip();
    }, 120);
  }

  #cancelInventoryTooltipClose() {
    if (!this.#tooltipCloseTimer) return;
    const view = this.element?.ownerDocument?.defaultView ?? window;
    view.clearTimeout(this.#tooltipCloseTimer);
    this.#tooltipCloseTimer = null;
  }

  #bindInventoryTooltipDocumentClose() {
    if (this.#tooltipDocumentPointerDownHandler) return;
    const view = this.element?.ownerDocument?.defaultView ?? window;
    this.#tooltipDocumentPointerDownHandler = event => {
      const insideTooltip = this.#tooltipElement?.contains(event.target);
      if (event.button === 1 && insideTooltip) {
        event.preventDefault();
        return;
      }
      if (!this.#tooltipPinned || !this.#tooltipElement) return;
      if (insideTooltip) return;
      this.#clearInventoryTooltip({ force: true });
    };
    view.document.addEventListener("pointerdown", this.#tooltipDocumentPointerDownHandler, { capture: true });
  }

  #unbindInventoryTooltipDocumentClose() {
    if (!this.#tooltipDocumentPointerDownHandler) return;
    const view = this.element?.ownerDocument?.defaultView ?? window;
    view.document.removeEventListener("pointerdown", this.#tooltipDocumentPointerDownHandler, { capture: true });
    this.#tooltipDocumentPointerDownHandler = null;
  }

  #bindInventoryTooltipKeyMode() {
    if (this.#tooltipDocumentKeyHandler) return;
    const view = this.element?.ownerDocument?.defaultView ?? window;
    this.#tooltipDocumentKeyHandler = event => {
      if (event.key !== "Control") return;
      const compareMode = event.type === "keydown";
      if (this.#tooltipCompareMode === compareMode) return;
      this.#tooltipCompareMode = compareMode;
      if (this.#tooltipAnchorElement) void this.#showInventoryTooltip(this.#tooltipAnchorElement, { refresh: true });
    };
    view.document.addEventListener("keydown", this.#tooltipDocumentKeyHandler, { capture: true });
    view.document.addEventListener("keyup", this.#tooltipDocumentKeyHandler, { capture: true });
  }

  #unbindInventoryTooltipKeyMode() {
    if (!this.#tooltipDocumentKeyHandler) return;
    const view = this.element?.ownerDocument?.defaultView ?? window;
    view.document.removeEventListener("keydown", this.#tooltipDocumentKeyHandler, { capture: true });
    view.document.removeEventListener("keyup", this.#tooltipDocumentKeyHandler, { capture: true });
    this.#tooltipDocumentKeyHandler = null;
  }

  #clearInventoryTooltip({ force = false, keepAnchor = false } = {}) {
    if (this.#tooltipTimer) {
      const view = this.element?.ownerDocument?.defaultView ?? window;
      view.clearTimeout(this.#tooltipTimer);
      this.#tooltipTimer = null;
    }
    this.#cancelInventoryTooltipClose();
    if (this.#tooltipPinned && !force) return;
    this.#unbindInventoryTooltipDocumentClose();
    this.#unbindInventoryTooltipKeyMode();
    this.#tooltipElement?.remove();
    this.#tooltipElement = null;
    this.#tooltipPinned = false;
    if (!keepAnchor) this.#tooltipCompareMode = false;
    if (!keepAnchor) {
      this.#tooltipAnchorElement = null;
      this.#tooltipActorUuid = "";
      this.#tooltipItemId = "";
    }
  }

  #setTradeCompatibilityHighlight(kind = "", actor = null, item = null) {
    const normalizedKind = kind === "energy" ? "energy" : "ammo";
    if (!this.#isTradeMode() || !actor || !item) return;
    this.#tradeCompatibilityHighlight = {
      kind: normalizedKind,
      actorUuid: actor.uuid,
      itemId: item.id,
      expiresAt: Date.now() + TRADE_COMPATIBILITY_HIGHLIGHT_MS
    };
    if (this.#tradeCompatibilityHighlightTimer) {
      window.clearTimeout(this.#tradeCompatibilityHighlightTimer);
      this.#tradeCompatibilityHighlightTimer = null;
    }
    this.#applyTradeCompatibilityHighlight();
    this.#tradeCompatibilityHighlightTimer = window.setTimeout(() => {
      this.#tradeCompatibilityHighlightTimer = null;
      this.#clearTradeCompatibilityHighlight();
    }, TRADE_COMPATIBILITY_HIGHLIGHT_MS);
  }

  #clearTradeCompatibilityHighlight() {
    if (this.#tradeCompatibilityHighlightTimer) {
      window.clearTimeout(this.#tradeCompatibilityHighlightTimer);
      this.#tradeCompatibilityHighlightTimer = null;
    }
    this.#tradeCompatibilityHighlight = null;
    this.element?.querySelectorAll(".trade-compatibility-highlight").forEach(element => {
      element.classList.remove("trade-compatibility-highlight");
    });
  }

  #applyTradeCompatibilityHighlight() {
    this.element?.querySelectorAll(".trade-compatibility-highlight").forEach(element => {
      element.classList.remove("trade-compatibility-highlight");
    });
    const state = this.#tradeCompatibilityHighlight;
    if (!this.#isTradeMode() || !state) return;
    if (Date.now() >= Math.max(0, toInteger(state.expiresAt))) {
      this.#clearTradeCompatibilityHighlight();
      return;
    }
    const sourceActor = this.#getActorByUuid(String(state.actorUuid ?? ""));
    const sourceItem = sourceActor?.items?.get(String(state.itemId ?? ""));
    if (!sourceActor || !sourceItem) return;
    for (const element of this.element?.querySelectorAll("[data-item-id][data-search-actor-uuid]") ?? []) {
      const actor = this.#getActorByUuid(String(element.dataset.searchActorUuid ?? ""));
      const item = actor?.items?.get(String(element.dataset.itemId ?? ""));
      if (!actor || !item) continue;
      const matches = state.kind === "energy"
        ? isTradeEnergyCompatibleItem(sourceItem, item)
        : isTradeAmmoCompatibleItem(sourceItem, item);
      if (matches) element.classList.add("trade-compatibility-highlight");
    }
  }
}

function canHighlightTradeAmmoCompatibility(item = null) {
  return Boolean(
    getTradeItemMagazineSourceUuids(item).length
    || hasItemFunction(item, ITEM_FUNCTIONS.damageSource, { ignoreBroken: true })
  );
}

function canHighlightTradeEnergyCompatibility(item = null) {
  return hasItemFunction(item, ITEM_FUNCTIONS.energyConsumer, { ignoreBroken: true });
}

function isTradeAmmoCompatibleItem(sourceItem = null, candidate = null) {
  if (!sourceItem || !candidate || sourceItem.id === candidate.id) return false;
  const sourceMagazineUuids = getTradeItemMagazineSourceUuids(sourceItem);
  if (sourceMagazineUuids.length) {
    return hasItemFunction(candidate, ITEM_FUNCTIONS.damageSource, { ignoreBroken: true })
      && sourceMagazineUuids.some(uuid => tradeDamageSourceMatchesPrototype(candidate, uuid));
  }
  if (!hasItemFunction(sourceItem, ITEM_FUNCTIONS.damageSource, { ignoreBroken: true })) return false;
  const candidateMagazineUuids = getTradeItemMagazineSourceUuids(candidate);
  return candidateMagazineUuids.some(uuid => tradeDamageSourceMatchesPrototype(sourceItem, uuid));
}

function isTradeEnergyCompatibleItem(sourceItem = null, candidate = null) {
  if (!sourceItem || !candidate || sourceItem.id === candidate.id) return false;
  if (!hasItemFunction(sourceItem, ITEM_FUNCTIONS.energyConsumer, { ignoreBroken: true })) return false;
  if (!hasItemFunction(candidate, ITEM_FUNCTIONS.energySource, { ignoreBroken: true })) return false;
  return energySourceMatchesConsumer(candidate, getEnergyConsumerFunction(sourceItem));
}

function getTradeItemMagazineSourceUuids(item = null) {
  return Array.from(new Set(getTradeWeaponDataList(item)
    .flatMap(weaponData => [
      ...(Array.isArray(weaponData?.magazine?.sourceItemUuids) ? weaponData.magazine.sourceItemUuids : []),
      String(weaponData?.magazine?.sourceItemUuid ?? "")
    ])
    .map(value => String(value ?? "").trim())
    .filter(Boolean)));
}

function getTradeWeaponDataList(item = null) {
  const functions = item?.system?.functions ?? {};
  const entries = [];
  if (functions.weapon?.enabled) entries.push(functions.weapon);
  const additional = functions.additionalWeapons;
  if (additional && typeof additional === "object") {
    entries.push(...Object.values(additional).filter(data => data?.enabled));
  }
  return entries;
}

function tradeDamageSourceMatchesPrototype(item = null, prototypeUuid = "") {
  const uuid = String(prototypeUuid ?? "").trim();
  if (!item || !uuid || !hasItemFunction(item, ITEM_FUNCTIONS.damageSource, { ignoreBroken: true })) return false;
  if (item.uuid === uuid || item.id === uuid) return true;
  const flagUuid = String(item.getFlag?.(SYSTEM_ID, DAMAGE_SOURCE_PROTOTYPE_FLAG) ?? item.getFlag?.("core", "sourceId") ?? "").trim();
  if (flagUuid === uuid) return true;
  const prototype = resolveWorldItemSync(uuid);
  if (!prototype || !hasItemFunction(prototype, ITEM_FUNCTIONS.damageSource, { ignoreBroken: true })) return false;
  if (item.name !== prototype.name) return false;
  return areTradeDamageSourcesEqual(getDamageSourceFunction(item), getDamageSourceFunction(prototype));
}

function areTradeDamageSourcesEqual(left = {}, right = {}) {
  if (String(left?.name ?? "") !== String(right?.name ?? "")) return false;
  if (String(left?.damage ?? "0") !== String(right?.damage ?? "0")) return false;
  if (String(left?.pellets ?? "1") !== String(right?.pellets ?? "1")) return false;
  if (String(left?.damageTypeKey ?? "") !== String(right?.damageTypeKey ?? "")) return false;
  if (String(left?.attackAnimationKey ?? "") !== String(right?.attackAnimationKey ?? "")) return false;
  if (String(left?.accuracyBonus ?? "0") !== String(right?.accuracyBonus ?? "0")) return false;
  if (String(left?.criticalChanceModifier ?? "0") !== String(right?.criticalChanceModifier ?? "0")) return false;
  if (String(left?.criticalDamagePercent ?? "0") !== String(right?.criticalDamagePercent ?? "0")) return false;
  if (String(left?.maxRangeMeters ?? "0") !== String(right?.maxRangeMeters ?? "0")) return false;
  if (String(left?.effectiveRange?.value ?? "0") !== String(right?.effectiveRange?.value ?? "0")) return false;
  if (String(left?.effectiveRange?.max ?? "0") !== String(right?.effectiveRange?.max ?? "0")) return false;
  if (String(left?.penetration ?? "0") !== String(right?.penetration ?? "0")) return false;
  if (normalizeTradeDamageSourceTypes(left?.damageTypes) !== normalizeTradeDamageSourceTypes(right?.damageTypes)) return false;
  return normalizeTradeDamageSourceVolley(left?.volley) === normalizeTradeDamageSourceVolley(right?.volley);
}

function normalizeTradeDamageSourceTypes(entries = []) {
  return (Array.isArray(entries) ? entries : [])
    .map(entry => `${String(entry?.key ?? "")}:${toInteger(entry?.percent)}`)
    .sort()
    .join("|");
}

function normalizeTradeDamageSourceVolley(volley = {}) {
  const regionDamage = (Array.isArray(volley?.regionDamageEntries) ? volley.regionDamageEntries : [])
    .map(entry => `${String(entry?.damageTypeKey ?? "")}:${String(entry?.amount ?? "0")}`)
    .sort()
    .join("|");
  return [
    String(volley?.damageRadius ?? "0"),
    String(volley?.regionRadius ?? "0"),
    regionDamage,
    String(volley?.regionDurationSeconds ?? "0"),
    String(volley?.regionDelaySeconds ?? "0"),
    String(volley?.regionRadiusDeltaMeters ?? "0"),
    String(volley?.explosionAnimationKey ?? "")
  ].join(";");
}

export function prepareSearchActorContext(actor, {
  side = "",
  roleLabel = "",
  canInteract = false,
  mode = SEARCH_INVENTORY_MODE_SEARCH,
  tradeCurrencyKey = "",
  tradeOffer = null,
  tradeCatalogEnabledCategories = null,
  tradeCatalogExpandedWeaponGroups = null,
  sideBarterValues = null,
  equipmentCollapsed = false,
  selector = null,
  canControl = false,
  canConfirm = false,
  showConfirm = true,
  showLockedItems = false
} = {}) {
  if (!actor) return null;
  const isTrade = mode === SEARCH_INVENTORY_MODE_TRADE;
  const selectedTradeCurrencyKey = normalizeTradeCurrencyKey(tradeCurrencyKey);
  const race = getCreatureOptions().races.find(entry => entry.id === actor.system?.creature?.raceId);
  const inventory = prepareInventoryContext(actor, race, { includeLocked: showLockedItems });
  const decoratedInventory = decorateInventoryForSearch(inventory, actor, canInteract, {
    isTrade,
    tradeCurrencyKey: selectedTradeCurrencyKey,
    tradeOffer,
    tradeCatalogEnabledCategories,
    tradeCatalogExpandedWeaponGroups,
    side,
    sideBarterValues
  });
  const loadValue = Math.max(0, Number(actor.system?.load?.value) || 0);
  const loadMax = Math.max(0, Number(actor.system?.load?.max) || 0);
  const loadRatio = loadMax > 0 ? loadValue / loadMax : 0;
  const currencies = getCurrencySettings().map(currency => ({
    ...currency,
    amount: isTrade
      ? getTradeAvailableCurrencyAmount(tradeOffer, actor, currency.key)
      : toInteger(actor.system?.currencies?.[currency.key]),
    hasImage: Boolean(currency.img),
    tradePrimary: isTrade && currency.key === selectedTradeCurrencyKey
  }));

  return {
    side,
    roleLabel,
    uuid: actor.uuid,
    name: isTrade ? formatTradeActorName(actor) : actor.name,
    selector,
    img: normalizeImagePath(actor.img, "icons/svg/mystery-man.svg"),
    inventory: decoratedInventory,
    currencies,
    tradeOffer: tradeOffer ? { ...tradeOffer, canControl, canConfirm, showConfirm } : tradeOffer,
    equipmentCollapsed: isTrade && equipmentCollapsed,
    load: {
      value: formatWeight(loadValue),
      max: formatWeight(loadMax),
      percent: Number(Math.max(0, Math.min(100, loadRatio * 100)).toFixed(2)),
      trend: "negative",
      state: loadRatio >= 1 ? "critical" : loadRatio >= 0.75 ? "warning" : "normal"
    }
  };
}

function decorateInventoryForSearch(inventory, actor, canInteract, {
  isTrade = false,
  tradeCurrencyKey = "",
  tradeOffer = null,
  tradeCatalogEnabledCategories = null,
  tradeCatalogExpandedWeaponGroups = null,
  side = "",
  sideBarterValues = null
} = {}) {
  const actorUuid = actor.uuid;
  const oppositeSide = getOppositeTradeSide(side);
  const barterAdjustmentPercent = isTrade
    ? getTradeBarterAdjustmentPercent(sideBarterValues?.[side], sideBarterValues?.[oppositeSide])
    : 0;
  const decorateItem = item => {
    if (!item) return item;
    const liveItem = actor.items.get(String(item.id));
    const weaponProficiencyKey = getTradeCatalogWeaponProficiencyKey(liveItem);
    const offeredQuantity = isTrade && tradeOffer && !tradeOffer.completed
      ? getTradeOfferedSourceItemQuantity(item, tradeOffer, actor)
      : 0;
    const sourceQuantity = getTradeSourceItemQuantity(item);
    const displayedQuantity = offeredQuantity > 0
      ? Math.max(0, sourceQuantity - offeredQuantity)
      : sourceQuantity;
    return {
      ...item,
      actorUuid,
      itemCategory: String(liveItem?.system?.itemCategory ?? item.itemCategory ?? ""),
      tradeCatalogWeaponProficiencyKey: weaponProficiencyKey,
      quantity: displayedQuantity,
      draggableClass: canInteract ? `draggable${isTradeItemFullyOffered(item, tradeOffer, actor) ? " trade-offered-source" : ""}` : "",
      tradePrice: isTrade && liveItem ? formatItemTradePrice(liveItem, tradeCurrencyKey, actor, { barterAdjustmentPercent }) : ""
    };
  };

  const decorated = {
    ...inventory,
    equipmentSlots: (inventory.equipmentSlots ?? []).map(slot => ({
      ...slot,
      item: decorateItem(slot.item)
    })),
    prosthesisSlots: (inventory.prosthesisSlots ?? []).map(slot => ({
      ...slot,
      item: decorateItem(slot.item)
    })),
    weaponSets: (inventory.weaponSets ?? []).map(set => ({
      ...set,
      slots: (set.slots ?? []).map(slot => ({
        ...slot,
        actorUuid,
        weaponSetKey: set.key,
        item: decorateItem(slot.item)
      }))
    })),
    grid: {
      ...inventory.grid,
      items: (inventory.grid?.items ?? []).map(decorateItem)
    },
    containers: (inventory.containers ?? []).map(container => ({
      ...decorateItem(container),
      grid: {
        ...container.grid,
        items: (container.grid?.items ?? []).map(decorateItem)
      }
    })),
    butcheringStorage: !isTrade && inventory.butcheringStorage
      ? {
        ...inventory.butcheringStorage,
        grid: {
          ...inventory.butcheringStorage.grid,
          items: (inventory.butcheringStorage.grid?.items ?? []).map(decorateItem)
        }
      }
      : null,
    lockedStorage: inventory.lockedStorage
      ? {
        ...inventory.lockedStorage,
        grid: {
          ...inventory.lockedStorage.grid,
          items: (inventory.lockedStorage.grid?.items ?? []).map(decorateItem)
        }
      }
      : null
  };
  return {
    ...decorated,
    tradeCatalog: isTrade && tradeOffer && !tradeOffer.completed
      ? prepareTradeCatalogContext(decorated, actor, tradeCatalogEnabledCategories, {
        canInteract,
        tradeOffer,
        expandedWeaponGroups: tradeCatalogExpandedWeaponGroups
      })
      : null
  };
}

function prepareTradeCatalogContext(inventory = {}, actor = null, enabledCategoriesInput = null, {
  canInteract = false,
  tradeOffer = null,
  expandedWeaponGroups: expandedWeaponGroupsInput = null
} = {}) {
  const columns = TRADE_OFFER_DEFAULT_COLUMNS;
  const enabledCategories = enabledCategoriesInput instanceof Set
    ? enabledCategoriesInput
    : new Set(Array.isArray(enabledCategoriesInput) ? enabledCategoriesInput.map(normalizeTradeCatalogCategory) : []);
  const expandedWeaponGroups = expandedWeaponGroupsInput instanceof Set
    ? expandedWeaponGroupsInput
    : new Set(Array.isArray(expandedWeaponGroupsInput) ? expandedWeaponGroupsInput.map(value => String(value ?? "").trim()).filter(Boolean) : []);
  const allItems = aggregateTradeCatalogItems(collectTradeCatalogItems(inventory)
    .map(item => ({
      ...item,
      categoryLabel: normalizeTradeCatalogCategory(item?.itemCategory),
      catalogQuantity: getTradeCatalogItemQuantity(item),
      catalogSourceQuantity: getTradeCatalogItemSourceQuantity(item)
    })), actor, tradeOffer);
  const categoryLabels = getTradeCatalogCategoryLabels(allItems);
  const categories = categoryLabels.map(label => {
    const items = allItems.filter(item => item.categoryLabel === label);
    return {
      label,
      enabled: enabledCategories.has(label),
      count: items.length,
      weaponGroups: enabledCategories.has(label) ? getTradeCatalogWeaponGroups(items, label, expandedWeaponGroups) : []
    };
  });
  const weaponGroups = categories.flatMap(category => category.enabled ? category.weaponGroups : []);

  const gridItems = [];
  const dividers = [];
  let y = 1;
  for (const category of categories) {
    if (!category.enabled) continue;
    const categoryItems = allItems.filter(item => item.categoryLabel === category.label);
    if (!categoryItems.length) continue;
    dividers.push({
      label: category.label,
      count: categoryItems.length,
      style: `grid-column: 1 / span ${columns}; grid-row: ${y};`
    });
    y += 1;

    for (const sectionItems of getTradeCatalogLayoutSections(categoryItems, category.label, expandedWeaponGroups)) {
      const placedItems = placeTradeCatalogItems(sectionItems, { columns, startY: y });
      for (const { item, placement } of placedItems.items) {
        gridItems.push({
          ...item,
          phantom: true,
          draggableClass: canInteract ? String(item.draggableClass || "draggable") : "",
          quantity: item.catalogQuantity,
          showQuantity: Boolean(item.showQuantity || item.catalogQuantity > 1 || item.tradeCatalogAggregate),
          placement,
          gridStyle: buildInventoryCellStyle(placement.x, placement.y, placement)
        });
      }
      y = placedItems.nextY;
    }
  }

  const rows = Math.max(1, y - 1);
  return {
    categories,
    weaponGroups,
    grid: {
      columns,
      rows,
      style: buildInventoryGridStyle(columns, rows),
      dividers,
      items: gridItems,
      empty: !gridItems.length
    }
  };
}

function collectTradeCatalogItems(inventory = {}) {
  const items = [];
  const seen = new Set();
  const addItem = (item = null, source = "") => {
    if (!item?.id || item.phantom) return;
    if (isEquippedTradeCatalogContainer(item, source)) return;
    const key = [
      String(item.actorUuid ?? ""),
      String(item.id ?? ""),
      Math.max(0, toInteger(item.stackIndex)),
      String(item.parentId ?? ""),
      source
    ].join("|");
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };

  for (const slot of inventory.equipmentSlots ?? []) addItem(slot.item, "equipment");
  for (const slot of inventory.prosthesisSlots ?? []) addItem(slot.item, "prosthesis");
  for (const set of inventory.weaponSets ?? []) {
    for (const slot of set.slots ?? []) if (!slot.phantom) addItem(slot.item, `weapon:${set.key}:${slot.key}`);
  }
  for (const item of inventory.grid?.items ?? []) addItem(item, "inventory");
  for (const container of inventory.containers ?? []) {
    for (const item of container.grid?.items ?? []) addItem(item, `container:${container.id}`);
  }
  return items;
}

function isEquippedTradeCatalogContainer(item = null, source = "") {
  if (!isContainerItem(item)) return false;
  const sourceKey = String(source ?? "");
  if (sourceKey === "equipment" || sourceKey === "prosthesis" || sourceKey.startsWith("weapon:")) return true;
  const placementMode = String(item?.placement?.mode ?? item?.system?.placement?.mode ?? "");
  return Boolean(item?.equipped || item?.system?.equipped || (placementMode && placementMode !== "inventory"));
}

function aggregateTradeCatalogItems(items = [], actor = null, tradeOffer = null) {
  const result = [];
  const virtualGroups = new Map();
  for (const item of items) {
    if (!item?.virtualStack) {
      result.push(item);
      continue;
    }
    const key = `${String(item.actorUuid ?? "")}|${String(item.id ?? "")}`;
    const existing = virtualGroups.get(key);
    if (!existing) {
      const aggregate = {
        ...item,
        tradeCatalogAggregate: true,
        stackIndex: 0,
        catalogQuantity: Math.max(0, toInteger(item.catalogQuantity)),
        catalogSourceQuantity: Math.max(0, toInteger(item.catalogSourceQuantity)),
        stackQuantity: Math.max(0, toInteger(item.catalogQuantity))
      };
      virtualGroups.set(key, aggregate);
      result.push(aggregate);
      continue;
    }
    existing.catalogQuantity += Math.max(0, toInteger(item.catalogQuantity));
    existing.catalogSourceQuantity += Math.max(0, toInteger(item.catalogSourceQuantity));
    existing.stackQuantity = existing.catalogQuantity;
  }
  for (const item of virtualGroups.values()) {
    const sourceTotal = Math.max(0, toInteger(item.catalogSourceQuantity));
    const offeredTotal = tradeOffer
      ? getTradeOfferedItemQuantity(tradeOffer, item.id, String(item.actorUuid ?? actor?.uuid ?? ""))
      : Math.max(0, sourceTotal - toInteger(item.catalogQuantity));
    item.catalogQuantity = Math.max(0, sourceTotal - offeredTotal);
    item.quantity = item.catalogQuantity;
    item.stackQuantity = item.catalogQuantity;
    item.draggableClass = String(item.draggableClass ?? "draggable").replace(/\s*\btrade-offered-source\b/g, "");
    if (item.catalogQuantity <= 0) item.draggableClass = `${item.draggableClass || "draggable"} trade-offered-source`.trim();
  }
  return result;
}

function getTradeCatalogWeaponGroups(items = [], categoryLabel = "", expandedWeaponGroups = new Set()) {
  const groups = new Map();
  for (const item of items) {
    if (!isTradeCatalogWeaponItem(item)) continue;
    const key = getTradeCatalogWeaponProficiencyKey(item);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        stateKey: getTradeCatalogWeaponGroupStateKey(categoryLabel, key),
        label: getTradeCatalogWeaponProficiencyLabel(key),
        count: 0,
        expanded: false
      });
    }
    groups.get(key).count += 1;
  }
  const order = getTradeCatalogWeaponProficiencyOrder();
  return Array.from(groups.values())
    .map(group => ({
      ...group,
      expanded: expandedWeaponGroups.has(group.stateKey)
    }))
    .sort((left, right) => {
      const leftOrder = order.get(left.key) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = order.get(right.key) ?? Number.MAX_SAFE_INTEGER;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return left.label.localeCompare(right.label);
    });
}

function getTradeCatalogLayoutSections(items = [], categoryLabel = "", expandedWeaponGroups = new Set()) {
  if (!items.some(isTradeCatalogWeaponItem)) return [items];
  const sections = [];
  const weaponSections = new Map();
  const nonWeaponItems = [];
  for (const item of items) {
    if (!isTradeCatalogWeaponItem(item)) {
      nonWeaponItems.push(item);
      continue;
    }
    const key = getTradeCatalogWeaponProficiencyKey(item);
    if (!weaponSections.has(key)) weaponSections.set(key, []);
    weaponSections.get(key).push(item);
  }
  const order = getTradeCatalogWeaponProficiencyOrder();
  sections.push(...Array.from(weaponSections.entries())
    .filter(([key]) => expandedWeaponGroups.has(getTradeCatalogWeaponGroupStateKey(categoryLabel, key)))
    .sort(([leftKey], [rightKey]) => {
      const leftOrder = order.get(leftKey) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = order.get(rightKey) ?? Number.MAX_SAFE_INTEGER;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return getTradeCatalogWeaponProficiencyLabel(leftKey).localeCompare(getTradeCatalogWeaponProficiencyLabel(rightKey));
    })
    .map(([, section]) => section));
  if (nonWeaponItems.length) sections.push(nonWeaponItems);
  return sections.filter(section => section.length);
}

function isTradeCatalogWeaponItem(item = null) {
  return Boolean(String(item?.tradeCatalogWeaponProficiencyKey ?? "").trim()) || getTradeWeaponDataList(item).length > 0;
}

function getTradeCatalogWeaponProficiencyKey(item = null) {
  const preparedKey = String(item?.tradeCatalogWeaponProficiencyKey ?? "").trim();
  if (preparedKey) return preparedKey;
  const weaponData = getTradeWeaponDataList(item)[0] ?? null;
  if (!weaponData) return "";
  return String(weaponData?.proficiencyKey ?? "").trim() || "__none__";
}

function getTradeCatalogWeaponGroupStateKey(categoryLabel = "", proficiencyKey = "") {
  return `${normalizeTradeCatalogCategory(categoryLabel)}::${String(proficiencyKey ?? "").trim() || "__none__"}`;
}

function getTradeCatalogWeaponProficiencyLabel(proficiencyKey = "") {
  const key = String(proficiencyKey ?? "").trim();
  if (!key || key === "__none__") return "Без владения";
  return getProficiencySettings().find(proficiency => proficiency.key === key)?.label ?? key;
}

function getTradeCatalogWeaponProficiencyOrder() {
  return new Map(getProficiencySettings().map((proficiency, index) => [String(proficiency.key ?? "").trim(), index]));
}

function placeTradeCatalogItems(items = [], { columns = TRADE_OFFER_DEFAULT_COLUMNS, startY = 1 } = {}) {
  const occupied = new Set();
  const placed = [];
  let maxY = startY - 1;
  for (const item of getTradeCatalogPackingOrder(items, columns)) {
    const footprint = getTradeCatalogItemFootprint(item, columns);
    const placement = {
      ...findTradeCatalogPlacement(occupied, footprint, columns, startY),
      rotated: Boolean(item?.placement?.rotated)
    };
    markTradeCatalogPlacement(occupied, placement);
    maxY = Math.max(maxY, placement.y + placement.height - 1);
    placed.push({ item, placement });
  }
  return {
    items: placed,
    nextY: Math.max(startY, maxY + 1)
  };
}

function getTradeCatalogPackingOrder(items = [], columns = TRADE_OFFER_DEFAULT_COLUMNS) {
  return items
    .map((item, index) => {
      const footprint = getTradeCatalogItemFootprint(item, columns);
      return {
        item,
        index,
        area: footprint.width * footprint.height,
        width: footprint.width,
        height: footprint.height
      };
    })
    .sort((left, right) => {
      if (right.area !== left.area) return right.area - left.area;
      if (right.height !== left.height) return right.height - left.height;
      if (right.width !== left.width) return right.width - left.width;
      return left.index - right.index;
    })
    .map(entry => entry.item);
}

function findTradeCatalogPlacement(occupied, footprint = {}, columns = TRADE_OFFER_DEFAULT_COLUMNS, startY = 1) {
  const gridColumns = Math.max(1, toInteger(columns) || TRADE_OFFER_DEFAULT_COLUMNS);
  const width = Math.max(1, Math.min(gridColumns, toInteger(footprint.width) || 1));
  const height = Math.max(1, toInteger(footprint.height) || 1);
  const maxX = Math.max(1, gridColumns - width + 1);
  for (let y = Math.max(1, toInteger(startY) || 1); ; y += 1) {
    for (let x = 1; x <= maxX; x += 1) {
      const placement = { x, y, width, height, rotated: Boolean(footprint.rotated) };
      if (isTradeCatalogPlacementFree(occupied, placement)) return placement;
    }
  }
}

function isTradeCatalogPlacementFree(occupied, placement = {}) {
  for (let y = placement.y; y < placement.y + placement.height; y += 1) {
    for (let x = placement.x; x < placement.x + placement.width; x += 1) {
      if (occupied.has(`${x}:${y}`)) return false;
    }
  }
  return true;
}

function markTradeCatalogPlacement(occupied, placement = {}) {
  for (let y = placement.y; y < placement.y + placement.height; y += 1) {
    for (let x = placement.x; x < placement.x + placement.width; x += 1) {
      occupied.add(`${x}:${y}`);
    }
  }
}

function getTradeCatalogCategoryLabels(items = []) {
  const labels = [];
  const addLabel = label => {
    label = normalizeTradeCatalogCategory(label);
    if (!labels.includes(label)) labels.push(label);
  };
  for (const category of getItemCategorySettings()) addLabel(category?.label ?? category);
  for (const item of items) addLabel(item.categoryLabel);
  return labels.filter(label => items.some(item => item.categoryLabel === label));
}

function normalizeTradeCatalogCategory(category = "") {
  return String(category ?? "").trim() || TRADE_UNCATEGORIZED_LABEL;
}

function getTradeCatalogItemQuantity(item = null) {
  if (!item) return 0;
  if (item.virtualStack) return Math.max(0, Math.min(toInteger(item.stackQuantity), toInteger(item.quantity)));
  return Math.max(0, toInteger(item.quantity));
}

function getTradeCatalogItemSourceQuantity(item = null) {
  if (!item) return 0;
  if (item.virtualStack) return Math.max(0, toInteger(item.stackQuantity));
  return Math.max(0, toInteger(item.quantity));
}

function getTradeCatalogItemFootprint(item = null, columns = TRADE_OFFER_DEFAULT_COLUMNS) {
  const placement = item?.placement ?? {};
  return {
    width: Math.max(1, Math.min(Math.max(1, toInteger(columns) || TRADE_OFFER_DEFAULT_COLUMNS), toInteger(placement.width) || 1)),
    height: Math.max(1, toInteger(placement.height) || 1)
  };
}

async function performActorButchering(payload = {}, requesterUserId = "") {
  const searcherActor = await resolveActor(payload.searcherActorUuid);
  const searchedActor = await resolveActor(payload.searchedActorUuid);
  if (!searcherActor || !searchedActor) throw new Error("Актёр разделки не найден.");

  validateSearchOrTradeRequester(payload, requesterUserId, searcherActor, searchedActor);
  if (!isActorDeadForButchering(searchedActor)) throw new Error("Разделывать можно только мёртвую цель.");

  const config = getButcheringConfig(searchedActor);
  if (!hasConfiguredButchering(config)) throw new Error("Разделка для этой цели не настроена.");
  if (config.completed) throw new Error("Эта цель уже разделана.");

  const rewardDocuments = await resolveButcheringRewardDocuments(config);
  const worstCaseRewards = selectWorstCaseButcheringRewards(config, rewardDocuments);
  createButcheringInventoryPlan(searchedActor, worstCaseRewards);

  const batch = await requestSkillCheckBatch({
    actor: searcherActor,
    skillKey: config.skillKey,
    entries: config.stages.map(stage => ({
      data: {
        difficulty: stage.difficulty
      }
    })),
    animate: false,
    createMessage: true,
    requester: requesterUserId,
    title: `Разделка: ${searchedActor.name}`
  });
  if (!batch || batch.outcomes?.length !== config.stages.length) {
    throw new Error("Не удалось выполнить проверки разделки.");
  }

  const rewards = [];
  for (const [index, stage] of config.stages.entries()) {
    const outcomeKey = String(batch.outcomes[index]?.result?.key ?? "failure");
    for (const reward of stage.outcomes?.[outcomeKey] ?? []) {
      const document = rewardDocuments.get(reward.uuid);
      if (!document) throw new Error(`Предмет награды «${reward.name}» недоступен.`);
      rewards.push({
        itemData: document.toObject(),
        quantity: randomButcheringRewardQuantity(reward)
      });
    }
  }

  const plan = createButcheringInventoryPlan(searchedActor, rewards);
  await applyButcheringInventoryPlan(searchedActor, plan, config);
  return {
    ok: true,
    stages: batch.outcomes.map(outcome => outcome.result?.key ?? "failure"),
    rewards: rewards.length
  };
}

function canStartActorButchering(actor) {
  if (!actor || !isActorDeadForButchering(actor)) return false;
  const config = getButcheringConfig(actor);
  return hasConfiguredButchering(config) && !config.completed;
}

function isActorDeadForButchering(actor) {
  if (!actor) return false;
  const defeatedStatus = CONFIG.specialStatusEffects.DEFEATED;
  if (
    actor.statuses?.has?.("dead")
    || (defeatedStatus && actor.statuses?.has?.(defeatedStatus))
  ) return true;

  return Boolean(game.combat?.combatants?.some(combatant => (
    combatant.defeated
    && combatant.actor?.uuid === actor.uuid
  )));
}

async function resolveButcheringRewardDocuments(config = {}) {
  const documents = new Map();
  for (const stage of config.stages ?? []) {
    for (const rewards of Object.values(stage.outcomes ?? {})) {
      for (const reward of rewards ?? []) {
        if (documents.has(reward.uuid)) continue;
        const document = await fromUuid(String(reward.uuid ?? ""));
        if (!(document instanceof Item)) {
          throw new Error(`Предмет награды «${reward.name}» недоступен.`);
        }
        documents.set(reward.uuid, document);
      }
    }
  }
  return documents;
}

function selectWorstCaseButcheringRewards(config = {}, documents = new Map()) {
  const rewards = [];
  for (const stage of config.stages ?? []) {
    let selected = [];
    let selectedScore = { area: -1, weight: -1, stacks: -1 };
    for (const outcomeRewards of Object.values(stage.outcomes ?? {})) {
      const candidate = (outcomeRewards ?? []).map(reward => ({
        itemData: documents.get(reward.uuid)?.toObject(),
        quantity: Math.max(1, toInteger(reward.max) || toInteger(reward.quantity) || 1)
      })).filter(entry => entry.itemData);
      const score = getButcheringRewardDemand(candidate);
      if (compareButcheringRewardDemand(score, selectedScore) <= 0) continue;
      selected = candidate;
      selectedScore = score;
    }
    rewards.push(...selected);
  }
  return rewards;
}

function getButcheringRewardDemand(rewards = []) {
  return rewards.reduce((score, reward) => {
    const maxStack = Math.max(1, getItemMaxStack(reward.itemData));
    const quantity = Math.max(1, toInteger(reward.quantity));
    const stacks = Math.ceil(quantity / maxStack);
    const footprint = getItemFootprint(reward.itemData);
    score.area += Math.max(1, footprint.width * footprint.height) * stacks;
    score.weight += Math.max(0, Number(reward.itemData?.system?.weight) || 0) * quantity;
    score.stacks += stacks;
    return score;
  }, { area: 0, weight: 0, stacks: 0 });
}

function compareButcheringRewardDemand(left, right) {
  return (left.area - right.area)
    || (left.weight - right.weight)
    || (left.stacks - right.stacks);
}

function randomButcheringRewardQuantity(reward = {}) {
  const legacyQuantity = Math.max(1, toInteger(reward.quantity) || 1);
  const minimum = Math.max(1, toInteger(reward.min) || legacyQuantity);
  const maximum = Math.max(1, toInteger(reward.max) || legacyQuantity);
  const lower = Math.min(minimum, maximum);
  const upper = Math.max(minimum, maximum);
  return lower + Math.floor(Math.random() * ((upper - lower) + 1));
}

function createButcheringInventoryPlan(actor, rewards = []) {
  const legacyContainers = actor.items.contents.filter(item => item.getFlag?.(SYSTEM_ID, BUTCHERING_CONTAINER_FLAG) === true);
  const legacyContainerIds = new Set(legacyContainers.map(item => item.id));
  const projected = new Map(
    actor.items.contents
      .filter(item => !legacyContainerIds.has(item.id))
      .map(item => [item.id, item.toObject()])
  );
  const updates = new Map();
  const createData = [];

  for (const item of projected.values()) {
    if (!legacyContainerIds.has(getItemContainerParentId(item))) continue;
    foundry.utils.setProperty(item, "system.container.parentId", ROOT_CONTAINER_ID);
    foundry.utils.setProperty(item, "system.placement.mode", BUTCHERING_STORAGE_PLACEMENT_MODE);
  }

  for (const reward of rewards) {
    const sourceData = foundry.utils.deepClone(reward.itemData);
    delete sourceData._id;
    delete sourceData.id;
    delete sourceData.folder;
    foundry.utils.setProperty(sourceData, "system.equipped", false);
    foundry.utils.setProperty(sourceData, "system.locked", false);
    let remaining = Math.max(1, toInteger(reward.quantity));

    for (const target of Array.from(projected.values())) {
      if (remaining <= 0) break;
      if (!isItemInButcheringStorage(target) || !canStackItems(sourceData, target)) continue;
      const available = Math.max(0, getItemMaxStack(target) - getItemQuantity(target));
      const amount = Math.min(remaining, available);
      if (!amount) continue;
      const nextQuantity = getItemQuantity(target) + amount;
      foundry.utils.setProperty(target, "system.quantity", nextQuantity);
      const targetId = getItemId(target);
      if (actor.items?.has(targetId)) {
        mergeButcheringItemUpdate(updates, targetId, { "system.quantity": nextQuantity });
      }
      remaining -= amount;
    }

    const maxStack = Math.max(1, getItemMaxStack(sourceData));
    while (remaining > 0) {
      const quantity = Math.min(remaining, maxStack);
      const stackData = foundry.utils.deepClone(sourceData);
      foundry.utils.setProperty(stackData, "system.quantity", quantity);
      const created = foundry.utils.deepClone(stackData);
      const syntheticId = foundry.utils.randomID();
      created._id = syntheticId;
      created.id = syntheticId;
      foundry.utils.setProperty(created, "system.container.parentId", ROOT_CONTAINER_ID);
      foundry.utils.setProperty(created, "system.placement.mode", BUTCHERING_STORAGE_PLACEMENT_MODE);
      createData.push(created);
      projected.set(syntheticId, created);
      remaining -= quantity;
    }
  }

  const projectedItems = Array.from(projected.values());
  const specialItems = projectedItems.filter(item => isItemInButcheringStorage(item));
  const placedItems = [];
  const columns = specialItems.reduce(
    (maximum, item) => Math.max(maximum, getItemFootprint(item, specialItems).width),
    Math.max(1, getActorInventoryContextDimensions(actor, ROOT_CONTAINER_ID).columns)
  );
  for (const item of specialItems) {
    let placement = findFirstAvailableInventoryPlacement(
      placedItems,
      columns,
      1,
      item,
      specialItems,
      [],
      [],
      {
        allowOverflowRows: true,
        placementMode: BUTCHERING_STORAGE_PLACEMENT_MODE,
        preferredPlacementModes: [BUTCHERING_STORAGE_PLACEMENT_MODE]
      }
    );
    if (!placement) {
      const nextRow = placedItems.reduce((row, placedItem) => {
        const placed = normalizeInventoryPlacement(placedItem.system?.placement ?? {}, placedItem, specialItems);
        return Math.max(row, placed.y + placed.height);
      }, 1);
      placement = createInventoryPlacement(1, nextRow, item, specialItems);
    }
    const storedPlacement = createStoredPlacement({
      ...placement,
      mode: BUTCHERING_STORAGE_PLACEMENT_MODE
    }, item);
    foundry.utils.setProperty(item, "system.container.parentId", ROOT_CONTAINER_ID);
    foundry.utils.setProperty(item, "system.placement", storedPlacement);
    placedItems.push(item);
    const itemId = getItemId(item);
    if (actor.items?.has(itemId)) {
      mergeButcheringItemUpdate(updates, itemId, {
        "system.container.parentId": ROOT_CONTAINER_ID,
        "system.placement": storedPlacement
      });
    }
  }

  const updateData = Array.from(updates.values());
  const deleteIds = Array.from(legacyContainerIds);
  return {
    updates: updateData,
    creates: createData,
    deletes: deleteIds,
    rollbackUpdates: createButcheringRollbackUpdates(actor, updateData)
  };
}

async function migrateLegacyButcheringStorages() {
  const actors = new Map();
  for (const actor of game.actors?.contents ?? []) {
    if (actor?.uuid) actors.set(actor.uuid, actor);
  }
  for (const tokenDocument of canvas.scene?.tokens ?? []) {
    const actor = tokenDocument.actor;
    if (actor?.uuid) actors.set(actor.uuid, actor);
  }

  for (const actor of actors.values()) {
    if (!actor.items?.some(item => item.getFlag?.(SYSTEM_ID, BUTCHERING_CONTAINER_FLAG) === true)) continue;
    try {
      await enqueueSearchInventoryOperation(async () => {
        const plan = createButcheringInventoryPlan(actor, []);
        if (plan.updates.length) await actor.updateEmbeddedDocuments("Item", plan.updates, { render: false });
        if (plan.deletes.length) await actor.deleteEmbeddedDocuments("Item", plan.deletes, { render: false });
      });
    } catch (error) {
      console.warn(`${SYSTEM_ID} | Legacy butchering storage migration failed for ${actor.uuid}`, error);
    }
  }
}

function mergeButcheringItemUpdate(updates, itemId, data = {}) {
  const current = updates.get(itemId) ?? { _id: itemId };
  updates.set(itemId, {
    ...current,
    ...data
  });
}

function createButcheringRollbackUpdates(actor, updates = []) {
  return updates.map(update => {
    const item = actor.items?.get(update._id);
    if (!item) return null;
    const rollback = { _id: item.id };
    for (const key of Object.keys(update)) {
      if (key === "_id") continue;
      foundry.utils.setProperty(rollback, key, foundry.utils.deepClone(foundry.utils.getProperty(item, key)));
    }
    return rollback;
  }).filter(Boolean);
}

async function applyButcheringInventoryPlan(actor, plan, config) {
  const createdIds = plan.creates.map(data => String(data._id ?? "")).filter(Boolean);
  try {
    if (plan.updates.length) await actor.updateEmbeddedDocuments("Item", plan.updates, { render: false });
    if (plan.creates.length) {
      await actor.createEmbeddedDocuments("Item", plan.creates, {
        keepId: true,
        render: false
      });
    }
    await actor.setFlag(SYSTEM_ID, "butchering", {
      ...config,
      completed: true
    });
    if (plan.deletes.length) {
      await actor.deleteEmbeddedDocuments("Item", plan.deletes, { render: false }).catch(error => {
        console.warn(`${SYSTEM_ID} | Legacy butchering container cleanup failed`, error);
      });
    }
  } catch (error) {
    if (createdIds.length) {
      const existingCreatedIds = createdIds.filter(id => actor.items?.has(id));
      if (existingCreatedIds.length) {
        await actor.deleteEmbeddedDocuments("Item", existingCreatedIds, { render: false }).catch(() => undefined);
      }
    }
    if (plan.rollbackUpdates.length) {
      await actor.updateEmbeddedDocuments("Item", plan.rollbackUpdates, { render: false }).catch(() => undefined);
    }
    throw error;
  }
}

async function performSearchInventoryTransfer(payload = {}, requesterUserId = "") {
  const searcherActor = await resolveActor(payload.searcherActorUuid);
  const searchedActor = await resolveActor(payload.searchedActorUuid);
  const sourceActor = await resolveActor(payload.sourceActorUuid);
  const targetActor = await resolveActor(payload.targetActorUuid);
  if (!searcherActor || !searchedActor || !sourceActor || !targetActor) throw new Error("Actor not found.");

  validateSearchOrTradeRequester(payload, requesterUserId, searcherActor, searchedActor);

  const allowedActorUuids = getSearchOrTradeAllowedActorUuids(payload, searcherActor, searchedActor, requesterUserId);
  if (!allowedActorUuids.has(sourceActor.uuid) || !allowedActorUuids.has(targetActor.uuid)) {
    throw new Error("Search transfer actor mismatch.");
  }

  const item = sourceActor.items?.get(String(payload.itemId ?? ""));
  if (!item) throw new Error("Item not found.");
  if (isItemInButcheringStorage(item) && (
    isTradePayload(payload)
    || sourceActor.uuid !== searchedActor.uuid
    || targetActor.uuid !== searcherActor.uuid
  )) {
    throw new Error("Предметы разделки можно только забирать у обыскиваемой цели.");
  }
  assertSearchTransferableItem(item, { allowButchering: true });
  const quantity = getTransferItemQuantity(item, payload.quantity);
  const targetParentId = String(payload.targetParentId ?? ROOT_CONTAINER_ID);
  validateTargetParent(targetActor, targetParentId);

  const tradePayment = getTradePaymentRequest({
    payload,
    searcherActor,
    searchedActor,
    buyerActor: targetActor,
    sellerActor: sourceActor,
    item,
    quantity
  });
  if (tradePayment) ensureTradeItemPayment(tradePayment);

  const result = await transferItemBetweenActors({
    sourceActor,
    targetActor,
    sourceItem: item,
    targetMode: String(payload.targetMode ?? "inventory"),
    targetParentId,
    targetEquipmentSlot: String(payload.targetEquipmentSlot ?? ""),
    targetWeaponSet: String(payload.targetWeaponSet ?? ""),
    targetWeaponSlot: String(payload.targetWeaponSlot ?? ""),
    targetX: payload.targetX,
    targetY: payload.targetY,
    targetItemId: String(payload.targetItemId ?? ""),
    quantity,
    sourceStackIndex: Math.max(0, toInteger(payload.sourceStackIndex)),
    allowButchering: isItemInButcheringStorage(item)
  });
  if (tradePayment) await applyTradeItemPayment(tradePayment);
  await requestDroppedItemsActorCleanup(sourceActor.uuid);
  return result;
}

async function performSearchInventorySplit(payload = {}, requesterUserId = "") {
  const searcherActor = await resolveActor(payload.searcherActorUuid);
  const searchedActor = await resolveActor(payload.searchedActorUuid);
  const actor = await resolveActor(payload.actorUuid);
  if (!searcherActor || !searchedActor || !actor) throw new Error("Actor not found.");

  validateSearchOrTradeRequester(payload, requesterUserId, searcherActor, searchedActor);

  const allowedActorUuids = getSearchOrTradeAllowedActorUuids(payload, searcherActor, searchedActor, requesterUserId);
  if (!allowedActorUuids.has(actor.uuid)) throw new Error("Search split actor mismatch.");

  const item = actor.items?.get(String(payload.itemId ?? ""));
  if (!item) throw new Error("Item not found.");
  if (isItemInButcheringStorage(item)) throw new Error("Предмет разделки нельзя разделять в хранилище.");
  assertSearchTransferableItem(item);
  if (usesVirtualInventoryStacks(item)) {
    const splitData = item.toObject();
    foundry.utils.setProperty(splitData, "system.quantity", toInteger(payload.amount));
    const parentId = item.system?.placement?.mode === LOCKED_STORAGE_PLACEMENT_MODE
      ? LOCKED_STORAGE_PARENT_ID
      : getItemContainerParentId(item);
    const placement = getFirstAvailableActorInventoryPlacement(actor, parentId, splitData, [], []);
    if (!placement) throwInventoryNoSpace();
    const updateData = createItemStackPartSplitUpdate(
      item,
      Math.max(0, toInteger(payload.stackIndex)),
      toInteger(payload.amount),
      createContextInventoryPlacement(placement, parentId)
    );
    if (!updateData) throwInventoryNoSpace();
    if (!validateActorProjectedInventoryState(actor, { updates: [updateData] })) throwInventoryNoSpace();
    await actor.updateEmbeddedDocuments("Item", [updateData]);
    return actor.items.get(item.id) ?? null;
  }
  return splitActorInventoryItem(actor, item, toInteger(payload.amount));
}

async function performSearchInventoryRotate(payload = {}, requesterUserId = "") {
  const searcherActor = await resolveActor(payload.searcherActorUuid);
  const searchedActor = await resolveActor(payload.searchedActorUuid);
  const actor = await resolveActor(payload.actorUuid);
  if (!searcherActor || !searchedActor || !actor) throw new Error("Actor not found.");

  validateSearchOrTradeRequester(payload, requesterUserId, searcherActor, searchedActor);

  const allowedActorUuids = getSearchOrTradeAllowedActorUuids(payload, searcherActor, searchedActor, requesterUserId);
  if (!allowedActorUuids.has(actor.uuid)) throw new Error("Search rotate actor mismatch.");

  const item = actor.items?.get(String(payload.itemId ?? ""));
  if (!item) throw new Error("Item not found.");
  if (isItemInButcheringStorage(item)) throw new Error("Предмет разделки нельзя поворачивать в хранилище.");
  assertSearchTransferableItem(item, { allowLocked: true });
  const parentId = item.system?.placement?.mode === LOCKED_STORAGE_PLACEMENT_MODE
    ? LOCKED_STORAGE_PARENT_ID
    : getItemContainerParentId(item);
  const { columns, rows } = getActorInventoryContextDimensions(actor, parentId);
  const resolution = resolveInventoryItemRotation({
    item,
    parentId,
    contextItems: getContextInventoryItems(parentId, actor.items),
    columns,
    rows,
    allItems: actor.items,
    excludeItemIds: [item.id],
    options: getActorInventoryContextOptions(actor, parentId)
  });
  const updateData = createInventoryRotationUpdate(item, resolution);
  if (!updateData) throw new Error(game.i18n.localize("FALLOUTMAW.Messages.InventoryRotateNoSpace"));
  if (!validateActorProjectedInventoryState(actor, { updates: [updateData] })) throwInventoryNoSpace();
  await actor.updateEmbeddedDocuments("Item", [updateData]);
  return actor.items.get(item.id) ?? null;
}

async function performSearchInventoryStack(payload = {}, requesterUserId = "") {
  const searcherActor = await resolveActor(payload.searcherActorUuid);
  const searchedActor = await resolveActor(payload.searchedActorUuid);
  const sourceActor = await resolveActor(payload.sourceActorUuid);
  const targetActor = await resolveActor(payload.targetActorUuid);
  if (!searcherActor || !searchedActor || !sourceActor || !targetActor) throw new Error("Actor not found.");

  validateSearchOrTradeRequester(payload, requesterUserId, searcherActor, searchedActor);

  const allowedActorUuids = getSearchOrTradeAllowedActorUuids(payload, searcherActor, searchedActor, requesterUserId);
  if (!allowedActorUuids.has(sourceActor.uuid) || !allowedActorUuids.has(targetActor.uuid)) {
    throw new Error("Search stack actor mismatch.");
  }

  const sourceItem = sourceActor.items?.get(String(payload.itemId ?? ""));
  const targetItem = targetActor.items?.get(String(payload.targetItemId ?? ""));
  if (!sourceItem || !targetItem) throw new Error("Item not found.");
  if (isItemInButcheringStorage(sourceItem) && (
    isTradePayload(payload)
    || sourceActor.uuid !== searchedActor.uuid
    || targetActor.uuid !== searcherActor.uuid
  )) {
    throw new Error("Предметы разделки можно только забирать у обыскиваемой цели.");
  }
  assertSearchTransferableItem(sourceItem, { allowButchering: true });
  assertSearchTransferableItem(targetItem);
  const quantity = toInteger(payload.quantity);
  const tradePayment = getTradePaymentRequest({
    payload,
    searcherActor,
    searchedActor,
    buyerActor: targetActor,
    sellerActor: sourceActor,
    item: sourceItem,
    quantity
  });
  if (tradePayment) ensureTradeItemPayment(tradePayment);

  const result = await stackActorInventoryItem({
    sourceActor,
    targetActor,
    sourceItem,
    targetItem,
    targetParentId: String(payload.targetParentId ?? ROOT_CONTAINER_ID),
    quantity,
    sourceStackIndex: Math.max(0, toInteger(payload.sourceStackIndex)),
    targetStackIndex: Math.max(0, toInteger(payload.targetStackIndex))
  });
  if (tradePayment) await applyTradeItemPayment(tradePayment);
  await requestDroppedItemsActorCleanup(sourceActor.uuid);
  return result;
}

async function performSearchCurrencyTransfer(payload = {}, requesterUserId = "") {
  const searcherActor = await resolveActor(payload.searcherActorUuid);
  const searchedActor = await resolveActor(payload.searchedActorUuid);
  const sourceActor = await resolveActor(payload.sourceActorUuid);
  const targetActor = await resolveActor(payload.targetActorUuid);
  if (!searcherActor || !searchedActor || !sourceActor || !targetActor) throw new Error("Actor not found.");

  validateSearchOrTradeRequester(payload, requesterUserId, searcherActor, searchedActor);

  const allowedActorUuids = getSearchOrTradeAllowedActorUuids(payload, searcherActor, searchedActor, requesterUserId);
  if (!allowedActorUuids.has(sourceActor.uuid) || !allowedActorUuids.has(targetActor.uuid) || sourceActor.uuid === targetActor.uuid) {
    throw new Error("Search currency transfer actor mismatch.");
  }

  const currencyKey = String(payload.currencyKey ?? "");
  const currencyExists = getCurrencySettings().some(entry => entry.key === currencyKey);
  if (!currencyKey || !currencyExists) throw new Error("Invalid currency.");

  const available = Math.max(0, toInteger(sourceActor.system?.currencies?.[currencyKey]));
  const amount = Math.max(0, Math.min(available, toInteger(payload.amount)));
  if (!amount) throw new Error("No currency to transfer.");

  const targetAmount = Math.max(0, toInteger(targetActor.system?.currencies?.[currencyKey]));
  await sourceActor.update({ [`system.currencies.${currencyKey}`]: available - amount });
  await targetActor.update({ [`system.currencies.${currencyKey}`]: targetAmount + amount });
  await requestDroppedItemsActorCleanup(sourceActor.uuid);
  return { amount };
}

async function performTradeComplete(payload = {}, requesterUserId = "") {
  const searcherActor = await resolveActor(payload.searcherActorUuid);
  const searchedActor = await resolveActor(payload.searchedActorUuid);
  if (!searcherActor || !searchedActor) throw new Error("Actor not found.");
  validateSearchOrTradeRequester({ ...payload, mode: SEARCH_INVENTORY_MODE_TRADE }, requesterUserId, searcherActor, searchedActor);

  const offers = normalizeTradeOffersState(payload.offers);
  if (!offers.searcher.ready || !offers.searched.ready) throw new Error("Trade is not confirmed by both sides.");
  validateTradeOfferSide(searcherActor, offers.searcher);
  validateTradeOfferSide(searchedActor, offers.searched);
  const searchedReceived = prepareReceivedTradeOfferSide({ targetActor: searchedActor, offer: offers.searcher });
  const searcherReceived = prepareReceivedTradeOfferSide({ targetActor: searcherActor, offer: offers.searched });
  const completedOffers = normalizeTradeOffersState({
    completed: true,
    searcher: searcherReceived,
    searched: searchedReceived
  });
  const sessionId = String(payload.tradeSessionId ?? "");
  await consumeTradeOfferSide({ sourceActor: searcherActor, offer: offers.searcher });
  await consumeTradeOfferSide({ sourceActor: searchedActor, offer: offers.searched });
  applyLocalCompletedTradeOffers(sessionId, completedOffers);
  if (sessionId) broadcastTradeOffersState(sessionId, completedOffers);
  return { ok: true, offers: completedOffers };
}

async function performPersonalTradeComplete(payload = {}, requesterUserId = "") {
  const searcherActor = await resolveActor(payload.searcherActorUuid);
  const searchedActor = await resolveActor(payload.searchedActorUuid);
  if (!searcherActor || !searchedActor) throw new Error("Actor not found.");
  validateSearchOrTradeRequester({ ...payload, mode: SEARCH_INVENTORY_MODE_TRADE }, requesterUserId, searcherActor, searchedActor);

  const offers = normalizeTradeOffersState(payload.offers);
  validateTradeOfferSide(searcherActor, offers.searcher);
  validateTradeOfferSide(searchedActor, offers.searched);
  const searchedReceived = prepareReceivedTradeOfferSide({ targetActor: searchedActor, offer: offers.searcher });
  const searcherReceived = prepareReceivedTradeOfferSide({ targetActor: searcherActor, offer: offers.searched });
  ensureTradeOfferSideCanBeDelivered(searchedActor, searchedReceived);
  ensureTradeOfferSideCanBeDelivered(searcherActor, searcherReceived);
  await consumeTradeOfferSide({ sourceActor: searcherActor, offer: offers.searcher });
  await consumeTradeOfferSide({ sourceActor: searchedActor, offer: offers.searched });
  const searchedResult = await deliverTradeOfferSideToActor(searchedActor, searchedReceived);
  const searcherResult = await deliverTradeOfferSideToActor(searcherActor, searcherReceived);
  return {
    ok: true,
    droppedCount: Math.max(0, toInteger(searchedResult?.droppedCount)) + Math.max(0, toInteger(searcherResult?.droppedCount))
  };
}

function ensureTradeOfferSideCanBeDelivered(targetActor, offer = {}) {
  for (const entry of offer?.items ?? []) {
    const itemData = getTradeOfferEntryItemData(entry, null);
    const quantity = Math.max(1, toInteger(entry?.quantity));
    if (!itemData || !quantity) continue;
    foundry.utils.setProperty(itemData, "system.quantity", quantity);
    if (getCompletedTradeClaimTarget(targetActor, itemData, entry.containedItems ?? [], { quantity })) continue;
    if (canDropItemsForActor(targetActor)) continue;
    throw new Error("У получателя нет места в инвентаре и нет токена на сцене для дропа.");
  }
}

async function deliverTradeOfferSideToActor(targetActor, offer = {}) {
  let droppedCount = 0;
  const currencyUpdates = {};
  for (const entry of offer?.currencies ?? []) {
    const currencyKey = String(entry.currencyKey ?? "");
    const amount = Math.max(0, toInteger(entry.amount));
    if (!currencyKey || !amount) continue;
    const path = `system.currencies.${currencyKey}`;
    currencyUpdates[path] = Math.max(0, toInteger(currencyUpdates[path] ?? getActorCurrencyAmount(targetActor, currencyKey))) + amount;
  }
  if (Object.keys(currencyUpdates).length) await targetActor.update(currencyUpdates, { render: false });

  for (const entry of offer?.items ?? []) {
    const itemData = getTradeOfferEntryItemData(entry, null);
    const quantity = Math.max(1, toInteger(entry?.quantity));
    if (!itemData || !quantity) continue;
    foundry.utils.setProperty(itemData, "system.quantity", quantity);
    const containedItems = entry.containedItems ?? [];
    const target = getCompletedTradeClaimTarget(targetActor, itemData, containedItems, { quantity });
    if (target) {
      try {
        await createCompletedTradeItem(targetActor, itemData, containedItems, {
          targetMode: "inventory",
          targetParentId: String(target.parentId ?? ROOT_CONTAINER_ID),
          targetX: target.placement?.x,
          targetY: target.placement?.y,
          skipProjectedValidation: false
        });
        continue;
      } catch (error) {
        console.warn(`${SYSTEM_ID} | Personal trade item could not fit, dropping to scene`, error);
      }
    }
    await dropItemDataForActor(targetActor, itemData, containedItems, {
      quantity,
      sourceActorUuid: String(entry.sourceActorUuid ?? "")
    });
    droppedCount += 1;
  }
  return { droppedCount };
}

async function performCompletedTradeEntryClaim(payload = {}, requesterUserId = "") {
  const targetActor = await resolveActor(payload.targetActorUuid);
  if (!targetActor) throw new Error("Actor not found.");

  const session = getActiveTradeSession(payload.sessionId);
  if (session) {
    ensureTradeSessionActorControl(session, targetActor.uuid, requesterUserId);
    if (getTradeSessionActorSide(session, targetActor.uuid) !== payload.side) throw new Error("Trade recipient side mismatch.");
  } else {
    const searcherActor = await resolveActor(payload.searcherActorUuid);
    const searchedActor = await resolveActor(payload.searchedActorUuid);
    if (!searcherActor || !searchedActor) throw new Error("Actor not found.");
    validateSearchOrTradeRequester({ ...payload, mode: SEARCH_INVENTORY_MODE_TRADE }, requesterUserId, searcherActor, searchedActor);
    const sideActorUuid = payload.side === "searcher" ? searcherActor.uuid : searchedActor.uuid;
    if (targetActor.uuid !== sideActorUuid) throw new Error("Trade recipient side mismatch.");
  }

  const offers = normalizeTradeOffersState(session?.offers ?? payload.offers);
  if (!offers.completed) throw new Error("Trade is not completed.");
  const side = String(payload.side ?? "");
  const kind = String(payload.kind ?? "");
  const key = String(payload.key ?? "");
  if (!TRADE_OFFER_SIDES.includes(side)) throw new Error("Invalid trade side.");

  if (kind === "currency") {
    const entry = findTradeOfferEntry(offers[side], "currency", key);
    const amount = Math.max(1, Math.min(Math.max(0, toInteger(entry?.amount)), toInteger(payload.quantity)));
    if (!entry || !amount) throw new Error("Trade currency not found.");
    await targetActor.update({ [`system.currencies.${entry.currencyKey}`]: getActorCurrencyAmount(targetActor, entry.currencyKey) + amount });
    const reduced = reduceTradeOfferEntryQuantity(offers, side, "currency", key, amount);
    if (session) session.offers = reduced;
    return { ok: true, offers: reduced };
  }

  if (kind !== "item") throw new Error("Invalid trade entry.");
  const entry = findTradeOfferEntry(offers[side], "item", key);
  const itemData = getTradeOfferEntryItemData(entry, null);
  const quantity = Math.max(1, Math.min(Math.max(0, toInteger(entry?.quantity)), toInteger(payload.quantity)));
  if (!entry || !itemData || !quantity) throw new Error("Trade item not found.");
  foundry.utils.setProperty(itemData, "system.quantity", quantity);
  const autoTarget = payload.autoTargetParent && String(payload.targetMode ?? "inventory") === "inventory"
    ? getCompletedTradeClaimTarget(targetActor, itemData, entry.containedItems ?? [], { quantity })
    : null;
  if (payload.autoTargetParent && String(payload.targetMode ?? "inventory") === "inventory" && !autoTarget) {
    throwInventoryNoSpace();
  }
  await createCompletedTradeItem(targetActor, itemData, entry.containedItems ?? [], {
    targetMode: String(payload.targetMode ?? "inventory"),
    targetParentId: String(autoTarget?.parentId ?? payload.targetParentId ?? ROOT_CONTAINER_ID),
    targetEquipmentSlot: String(payload.targetEquipmentSlot ?? ""),
    targetWeaponSet: String(payload.targetWeaponSet ?? ""),
    targetWeaponSlot: String(payload.targetWeaponSlot ?? ""),
    targetX: autoTarget?.placement?.x ?? payload.targetX,
    targetY: autoTarget?.placement?.y ?? payload.targetY,
    targetItemId: String(payload.targetItemId ?? ""),
    skipProjectedValidation: !payload.autoTargetParent && String(payload.targetMode ?? "inventory") === "inventory"
  });
  const reduced = reduceTradeOfferEntryQuantity(offers, side, "item", key, quantity);
  if (session) session.offers = reduced;
  return { ok: true, offers: reduced };
}

async function performCompletedTradeBatchClaim(payload = {}, requesterUserId = "") {
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  if (!entries.length) return { ok: true, offers: normalizeTradeOffersState(payload.offers) };
  let offers = null;
  for (const entry of entries) {
    const result = await performCompletedTradeEntryClaim({ ...payload, ...entry, offers: offers ?? payload.offers }, requesterUserId);
    offers = result?.offers ?? offers;
  }
  return { ok: true, offers: offers ?? normalizeTradeOffersState(payload.offers) };
}

async function performCompletedTradeHubDeposit(payload = {}, requesterUserId = "") {
  const sourceActor = await resolveActor(payload.sourceActorUuid);
  if (!sourceActor) throw new Error("Actor not found.");
  const item = sourceActor.items?.get(String(payload.itemId ?? ""));
  if (!item) throw new Error("Item not found.");
  assertSearchTransferableItem(item);

  const session = getActiveTradeSession(payload.sessionId);
  if (session) {
    if (!session.offers?.completed) throw new Error("Trade is not completed.");
    if (!getTradeSessionActorSide(session, sourceActor.uuid)) throw new Error("Trade source actor mismatch.");
    ensureTradeSessionActorControl(session, sourceActor.uuid, requesterUserId);
  } else {
    const searcherActor = await resolveActor(payload.searcherActorUuid);
    const searchedActor = await resolveActor(payload.searchedActorUuid);
    if (!searcherActor || !searchedActor) throw new Error("Actor not found.");
    validateSearchOrTradeRequester({ ...payload, mode: SEARCH_INVENTORY_MODE_TRADE }, requesterUserId, searcherActor, searchedActor);
    const allowedActorUuids = getSearchOrTradeAllowedActorUuids({ ...payload, mode: SEARCH_INVENTORY_MODE_TRADE }, searcherActor, searchedActor, requesterUserId);
    if (!allowedActorUuids.has(sourceActor.uuid)) throw new Error("Trade source actor mismatch.");
    const requester = requesterUserId ? game.users?.get(requesterUserId) : game.user;
    if (!requester?.isGM && !sourceActor.testUserPermission?.(requester, "OWNER")) throw new Error("No trade actor owner permission.");
  }

  const offers = normalizeTradeOffersState(session?.offers ?? payload.offers);
  if (!offers.completed) throw new Error("Trade is not completed.");
  const side = String(payload.side ?? "");
  if (!TRADE_OFFER_SIDES.includes(side)) throw new Error("Invalid trade side.");
  const quantity = getTransferItemQuantity(item, payload.quantity);
  const deposited = await depositItemIntoCompletedTradeHub(offers, side, sourceActor, item, quantity, payload.placement, {
    sourceStackIndex: Math.max(0, toInteger(payload.sourceStackIndex))
  });
  if (session) session.offers = deposited;
  return { ok: true, offers: deposited };
}

async function depositItemIntoCompletedTradeHub(offersState = {}, side = "", sourceActor = null, item = null, quantity = 0, placement = null, { sourceStackIndex = 0 } = {}) {
  const offers = normalizeTradeOffersState(offersState);
  if (!offers.completed) throw new Error("Trade is not completed.");
  if (!TRADE_OFFER_SIDES.includes(side) || !sourceActor || !item) throw new Error("Invalid completed trade deposit.");
  const amount = getTransferItemQuantity(item, quantity);
  const itemData = item.toObject();
  foundry.utils.setProperty(itemData, "system.quantity", amount);
  const containedItems = isContainerItem(item)
    ? getAllContainedItems(item.id, sourceActor.items).map(contained => contained.toObject())
    : [];
  offers[side].items.push({
    entryId: foundry.utils.randomID(),
    itemId: item.id,
    sourceActorUuid: sourceActor.uuid,
    returnActorUuid: sourceActor.uuid,
    quantity: amount,
    itemData,
    containedItems,
    placement: normalizeTradeOfferPlacement(placement, getItemFootprint(item, sourceActor.items))
  });
  if (isContainerItem(item)) {
    const deleteIds = [item.id, ...containedItems.map(contained => String(contained._id ?? contained.id ?? "")).filter(Boolean)];
    await sourceActor.deleteEmbeddedDocuments("Item", deleteIds, { render: false });
  } else {
    if (usesVirtualInventoryStacks(item)) await removeTransferredVirtualStackQuantity(sourceActor, item, amount, sourceStackIndex, { render: false });
    else await removeTransferredItemQuantity(sourceActor, item, amount, { render: false });
  }
  return offers;
}

function validateTradeOfferSide(actor, offer = {}) {
  const itemEntries = [...(offer?.items ?? [])].sort((left, right) => (
    Math.max(0, toInteger(right?.sourceStackIndex)) - Math.max(0, toInteger(left?.sourceStackIndex))
  ));
  for (const entry of itemEntries) {
    const sourceActor = getCachedActorByUuid(entry.sourceActorUuid);
    if (!sourceActor) throw new Error("Trade item source actor not found.");
    const item = sourceActor?.items?.get(String(entry.itemId ?? ""));
    if (!item) throw new Error("Item not found.");
    assertSearchTransferableItem(item);
    const requested = Math.max(1, toInteger(entry.quantity));
    const sourceStackIndex = toInteger(entry.sourceStackIndex);
    const available = usesVirtualInventoryStacks(item)
      ? (sourceStackIndex < 0 ? Math.max(1, getItemQuantity(item)) : getItemStackPartQuantity(item, Math.max(0, sourceStackIndex)))
      : Math.max(1, getItemQuantity(item));
    if (!isContainerItem(item) && requested > available) throw new Error("Not enough item quantity.");
  }
  for (const entry of offer?.currencies ?? []) {
    const currencyKey = String(entry.currencyKey ?? "");
    if (entry.contributions?.length) {
      for (const contribution of entry.contributions) {
        const sourceActor = getCachedActorByUuid(contribution.actorUuid);
        const amount = Math.max(0, toInteger(contribution.amount));
        if (!currencyKey || !amount) continue;
        if (!sourceActor) throw new Error("Trade currency source actor not found.");
        if (getActorCurrencyAmount(sourceActor, currencyKey) < amount) throw new Error("Not enough currency for trade.");
      }
      continue;
    }
    const amount = Math.max(0, toInteger(entry.amount));
    if (!currencyKey || !amount) continue;
    if (getActorCurrencyAmount(actor, currencyKey) < amount) throw new Error("Недостаточно валюты для обмена.");
  }
}

function prepareReceivedTradeOfferSide({ targetActor = null, offer } = {}) {
  const received = {
    items: [],
    currencies: [],
    ready: false,
    columns: Math.max(1, toInteger(offer?.columns) || TRADE_OFFER_DEFAULT_COLUMNS)
  };

  for (const entry of offer?.items ?? []) {
    const entrySourceActor = getCachedActorByUuid(entry.sourceActorUuid);
    if (!entrySourceActor) throw new Error("Trade item source actor not found.");
    const item = entrySourceActor.items?.get(String(entry.itemId ?? ""));
    if (!item) throw new Error("Item not found.");
    assertSearchTransferableItem(item);
    const quantity = getTransferItemQuantity(item, entry.quantity);
    const itemData = item.toObject();
    foundry.utils.setProperty(itemData, "system.quantity", quantity);
    const containedItems = isContainerItem(item)
      ? getAllContainedItems(item.id, entrySourceActor.items).map(contained => contained.toObject())
      : [];
    received.items.push({
      entryId: foundry.utils.randomID(),
      itemId: item.id,
      sourceActorUuid: entrySourceActor.uuid,
      returnActorUuid: String(targetActor?.uuid ?? ""),
      quantity,
      itemData,
      containedItems,
      placement: normalizeTradeOfferPlacement(entry.placement, getItemFootprint(item, entrySourceActor.items))
    });
  }

  for (const entry of offer?.currencies ?? []) {
    const currencyKey = String(entry.currencyKey ?? "");
    if (entry.contributions?.length) {
      let amount = 0;
      for (const contribution of entry.contributions) {
        const contributionAmount = Math.max(0, toInteger(contribution.amount));
        if (!currencyKey || !contributionAmount) continue;
        const entrySourceActor = getCachedActorByUuid(contribution.actorUuid);
        if (!entrySourceActor) throw new Error("Trade currency source actor not found.");
        const available = getActorCurrencyAmount(entrySourceActor, currencyKey);
        if (available < contributionAmount) throw new Error("Not enough currency for trade.");
        amount += contributionAmount;
      }
      if (!amount) continue;
      received.currencies.push({
        currencyKey,
        amount,
        contributions: [],
        returnActorUuid: String(targetActor?.uuid ?? ""),
        placement: normalizeTradeOfferPlacement(entry.placement, { width: 1, height: 1 })
      });
      continue;
    }
    const amount = Math.max(0, toInteger(entry.amount));
    if (!currencyKey || !amount) continue;
    received.currencies.push({
      currencyKey,
      amount,
      contributions: [],
      returnActorUuid: String(targetActor?.uuid ?? ""),
      placement: normalizeTradeOfferPlacement(entry.placement, { width: 1, height: 1 })
    });
  }

  return received;
}

function planTradeOfferItemConsumption(offer = {}) {
  const deleteIdsByActor = new Map();
  const sequentialOps = [];

  const addDeleteId = (actor, itemId) => {
    if (!actor || !itemId) return;
    const actorUuid = String(actor.uuid ?? "");
    if (!actorUuid) return;
    if (!deleteIdsByActor.has(actorUuid)) deleteIdsByActor.set(actorUuid, new Set());
    deleteIdsByActor.get(actorUuid).add(String(itemId));
  };

  for (const entry of offer?.items ?? []) {
    const entrySourceActor = getCachedActorByUuid(entry.sourceActorUuid);
    if (!entrySourceActor) throw new Error("Trade item source actor not found.");
    const item = entrySourceActor.items?.get(String(entry.itemId ?? ""));
    if (!item) throw new Error("Item not found.");
    const quantity = getTransferItemQuantity(item, entry.quantity);
    if (isContainerItem(item)) {
      const containedItems = getAllContainedItems(item.id, entrySourceActor.items);
      addDeleteId(entrySourceActor, item.id);
      for (const contained of containedItems) addDeleteId(entrySourceActor, contained.id);
      continue;
    }
    const sourceStackIndex = toInteger(entry.sourceStackIndex);
    const sourceQuantity = Math.max(1, getItemQuantity(item));
    const transferQuantity = Math.max(1, Math.min(sourceQuantity, quantity));
    if (usesVirtualInventoryStacks(item)) {
      sequentialOps.push(renderFlag => (
        sourceStackIndex < 0
          ? removeTransferredItemDocumentQuantity(entrySourceActor, item, quantity, { render: renderFlag })
          : removeTransferredVirtualStackQuantity(entrySourceActor, item, quantity, Math.max(0, sourceStackIndex), { render: renderFlag })
      ));
      continue;
    }
    if (transferQuantity >= sourceQuantity) addDeleteId(entrySourceActor, item.id);
    else sequentialOps.push(renderFlag => removeTransferredItemQuantity(entrySourceActor, item, quantity, { render: renderFlag }));
  }

  return { deleteIdsByActor, sequentialOps };
}

async function executeTradeOfferItemConsumption(plan = {}, consumeRender = { render: false }) {
  const render = consumeRender?.render !== false ? consumeRender : { render: false };
  let batchDeleteCount = 0;
  for (const [actorUuid, deleteIds] of plan.deleteIdsByActor ?? []) {
    const actor = getCachedActorByUuid(actorUuid);
    if (!actor || !deleteIds?.size) continue;
    const ids = [...deleteIds];
    batchDeleteCount += ids.length;
    await actor.deleteEmbeddedDocuments("Item", ids, render);
  }
  for (const operation of plan.sequentialOps ?? []) {
    await operation(render.render);
  }
  return { batchDeleteCount, sequentialCount: plan.sequentialOps?.length ?? 0 };
}

async function consumeTradeOfferSide({ sourceActor, offer } = {}) {
  const consumeRender = { render: false };
  const plan = planTradeOfferItemConsumption(offer);
  await executeTradeOfferItemConsumption(plan, consumeRender);

  const currencyUpdatesByActor = new Map();
  const queueCurrencyDeduction = (actor, currencyKey, amount) => {
    if (!actor || !currencyKey || !amount) return;
    const actorUuid = String(actor.uuid ?? "");
    if (!actorUuid) return;
    if (!currencyUpdatesByActor.has(actorUuid)) currencyUpdatesByActor.set(actorUuid, new Map());
    const actorCurrencies = currencyUpdatesByActor.get(actorUuid);
    actorCurrencies.set(currencyKey, Math.max(0, toInteger(actorCurrencies.get(currencyKey))) + amount);
  };

  for (const entry of offer?.currencies ?? []) {
    const currencyKey = String(entry.currencyKey ?? "");
    if (entry.contributions?.length) {
      for (const contribution of entry.contributions) {
        const entrySourceActor = getCachedActorByUuid(contribution.actorUuid);
        const contributionAmount = Math.max(0, toInteger(contribution.amount));
        if (!currencyKey || !contributionAmount) continue;
        if (!entrySourceActor) throw new Error("Trade currency source actor not found.");
        const available = getActorCurrencyAmount(entrySourceActor, currencyKey);
        if (available < contributionAmount) throw new Error("Not enough currency for trade.");
        queueCurrencyDeduction(entrySourceActor, currencyKey, contributionAmount);
      }
      continue;
    }
    const amount = Math.max(0, toInteger(entry.amount));
    if (!currencyKey || !amount) continue;
    const available = getActorCurrencyAmount(sourceActor, currencyKey);
    if (available < amount) throw new Error("Недостаточно валюты для обмена.");
    queueCurrencyDeduction(sourceActor, currencyKey, amount);
  }

  for (const [actorUuid, currencyDeductions] of currencyUpdatesByActor) {
    const actor = getCachedActorByUuid(actorUuid);
    if (!actor) throw new Error("Trade currency source actor not found.");
    const updateData = {};
    for (const [currencyKey, amount] of currencyDeductions) {
      const available = getActorCurrencyAmount(actor, currencyKey);
      if (available < amount) throw new Error("Not enough currency for trade.");
      updateData[`system.currencies.${currencyKey}`] = available - amount;
    }
    if (Object.keys(updateData).length) await actor.update(updateData, consumeRender);
  }
}

async function applyTradeOfferSide({ sourceActor, targetActor = null, offer } = {}) {
  const received = prepareReceivedTradeOfferSide({ targetActor, offer });
  await consumeTradeOfferSide({ sourceActor, offer });
  return received;
}

async function transferTradeOfferItemToActor({ sourceActor, targetActor, sourceItem, quantity = 0, sourceStackIndex = 0 } = {}) {
  assertSearchTransferableItem(sourceItem);
  const transferQuantity = getTransferItemQuantity(sourceItem, quantity);
  const itemData = sourceItem.toObject();
  foundry.utils.setProperty(itemData, "system.quantity", transferQuantity);

  if (isContainerItem(sourceItem)) {
    const placement = getFirstAvailableActorInventoryPlacement(targetActor, ROOT_CONTAINER_ID, itemData, [], [], { allowLockedDisplacement: true });
    if (!placement) throwInventoryNoSpace();
    const createdRoot = await transferContainerTree({
      sourceActor,
      targetActor,
      sourceItem,
      targetParentId: ROOT_CONTAINER_ID,
      preferredPlacement: placement
    });
    return createdRoot ? [createdRoot] : [];
  }

  if (usesVirtualInventoryStacks(itemData)) {
    const placement = getFirstAvailableActorInventoryPlacement(targetActor, ROOT_CONTAINER_ID, itemData, [], [], { allowLockedDisplacement: true });
    if (!placement) throwInventoryNoSpace();
    const result = await insertVirtualStackItemIntoActorInventory(targetActor, itemData, placement, {
      sourceActor,
      sourceItem,
      parentId: ROOT_CONTAINER_ID,
      sourceStackIndex: Math.max(0, toInteger(sourceStackIndex))
    });
    return Array.isArray(result) ? result : (result ? [result] : []);
  }

  const maxStack = getItemMaxStack(itemData);
  let remainingQuantity = transferQuantity;
  const reservedPlacements = [];
  const createData = [];
  const displacementUpdates = [];
  const addDisplacementUpdates = placement => {
    const updates = getPlacementDisplacementUpdates(targetActor, itemData, placement, ROOT_CONTAINER_ID, []);
    if (!updates) throwInventoryNoSpace();
    for (const update of updates) {
      if (!displacementUpdates.some(existing => existing._id === update._id)) displacementUpdates.push(update);
    }
  };
  while (remainingQuantity > 0) {
    const stackQuantity = Math.min(remainingQuantity, maxStack);
    const placement = getFirstAvailableActorInventoryPlacement(targetActor, ROOT_CONTAINER_ID, itemData, [], reservedPlacements, { allowLockedDisplacement: true });
    if (!placement) throwInventoryNoSpace();
    createData.push(createInventoryStackData(itemData, stackQuantity, ROOT_CONTAINER_ID, placement));
    reservedPlacements.push(placement);
    addDisplacementUpdates(placement);
    remainingQuantity -= stackQuantity;
  }

  if (!validateActorProjectedInventoryState(targetActor, { updates: displacementUpdates, creates: createData })) throwInventoryNoSpace();
  if (displacementUpdates.length) await targetActor.updateEmbeddedDocuments("Item", displacementUpdates);
  const createdItems = await targetActor.createEmbeddedDocuments("Item", createData);
  await removeTransferredItemQuantity(sourceActor, sourceItem, transferQuantity);
  return createdItems;
}

function validateSearchOrTradeRequester(payload = {}, requesterUserId = "", searcherActor = null, searchedActor = null) {
  const requester = requesterUserId ? game.users?.get(requesterUserId) : game.user;
  if (!requester || requester.isGM) return;
  if (isTradePayload(payload)) {
    const session = getActiveTradeSession(payload.tradeSessionId);
    if (session && TRADE_OFFER_SIDES.some(side => canUserControlTradeSessionSide(session, side, requesterUserId))) return;
    if (searcherActor?.testUserPermission?.(requester, "OWNER")) return;
    if (searchedActor?.testUserPermission?.(requester, "OWNER")) return;
    throw new Error("No trade actor owner permission.");
  }
  if (!searcherActor?.testUserPermission?.(requester, "OWNER")) {
    throw new Error("No searcher actor owner permission.");
  }
}

function getStackAnchorSelector(anchor = null) {
  if (!anchor || !Object.prototype.hasOwnProperty.call(anchor.dataset ?? {}, "stackIndex")) return "";
  return `[data-stack-index="${CSS.escape(String(anchor.dataset.stackIndex ?? ""))}"]`;
}

function getSearchOrTradeAllowedActorUuids(payload = {}, searcherActor = null, searchedActor = null, requesterUserId = "") {
  const session = isTradePayload(payload) ? getActiveTradeSession(payload.tradeSessionId) : null;
  let uuids = [searcherActor?.uuid, searchedActor?.uuid];
  if (session) {
    const requester = requesterUserId ? game.users?.get(requesterUserId) : game.user;
    const includeDisconnected = Boolean(session.offers?.completed);
    uuids = requester?.isGM
      ? TRADE_OFFER_SIDES.flatMap(side => getTradeSessionSideActorUuids(session, side, { includeDisconnected }))
      : TRADE_OFFER_SIDES
        .filter(side => canUserControlTradeSessionSide(session, side, requesterUserId))
        .flatMap(side => getTradeSessionSideActorUuids(session, side, { includeDisconnected }));
  }
  return new Set(uuids.filter(Boolean));
}

function isTradePayload(payload = {}) {
  return payload?.mode === SEARCH_INVENTORY_MODE_TRADE;
}

function getTradePaymentRequest({ payload = {}, searcherActor = null, searchedActor = null, buyerActor = null, sellerActor = null, item = null, quantity = 1 } = {}) {
  if (!isTradePayload(payload) || !buyerActor || !sellerActor || !item || buyerActor.uuid === sellerActor.uuid) return null;
  const barterAdjustmentPercent = getTradePayloadBarterAdjustmentPercent({
    payload,
    searcherActor,
    searchedActor,
    sellerActor,
    buyerActor
  });
  return {
    buyerActor,
    sellerActor,
    item,
    currencyKey: normalizeTradeCurrencyKey(payload.tradeCurrencyKey),
    quantity,
    barterAdjustmentPercent
  };
}

function getTransferItemQuantity(item, quantity = 0) {
  const sourceQuantity = Math.max(1, getItemQuantity(item));
  if (isContainerItem(item)) return 1;
  const requested = toInteger(quantity);
  return requested > 0 ? Math.max(1, Math.min(sourceQuantity, requested)) : sourceQuantity;
}

async function removeTransferredItemQuantity(actor, item, quantity = 0, { render = true } = {}) {
  if (usesVirtualInventoryStacks(item)) return removeTransferredVirtualStackQuantity(actor, item, quantity, 0, { render });
  const sourceQuantity = Math.max(1, getItemQuantity(item));
  const transferQuantity = Math.max(1, Math.min(sourceQuantity, toInteger(quantity) || sourceQuantity));
  if (transferQuantity >= sourceQuantity) return actor.deleteEmbeddedDocuments("Item", [item.id], { render });
  return actor.updateEmbeddedDocuments("Item", [{
    _id: item.id,
    "system.quantity": sourceQuantity - transferQuantity
  }], { render });
}

async function removeTransferredItemDocumentQuantity(actor, item, quantity = 0, { render = true } = {}) {
  const sourceQuantity = Math.max(1, getItemQuantity(item));
  const transferQuantity = Math.max(1, Math.min(sourceQuantity, toInteger(quantity) || sourceQuantity));
  if (transferQuantity >= sourceQuantity) return actor.deleteEmbeddedDocuments("Item", [item.id], { render });
  return actor.updateEmbeddedDocuments("Item", [{
    _id: item.id,
    "system.quantity": sourceQuantity - transferQuantity
  }], { render });
}

async function removeTransferredVirtualStackQuantity(actor, item, quantity = 0, stackIndex = 0, { render = true } = {}) {
  const sourceQuantity = Math.max(1, getItemQuantity(item));
  const transferQuantity = Math.max(1, Math.min(sourceQuantity, toInteger(quantity) || sourceQuantity));
  const updateData = createItemStackPartRemovalUpdate(item, transferQuantity, stackIndex);
  if (!updateData || (updateData["system.quantity"] ?? 0) <= 0) return actor.deleteEmbeddedDocuments("Item", [item.id], { render });
  return actor.updateEmbeddedDocuments("Item", [updateData], { render });
}

function ensureTradeItemPayment({ buyerActor, sellerActor, item, currencyKey, quantity = 1, barterAdjustmentPercent = null } = {}) {
  const price = calculateItemTradePrice(item, currencyKey, quantity, { sellerActor, barterAdjustmentPercent });
  if (price <= 0) return;
  const available = getActorCurrencyAmount(buyerActor, currencyKey);
  if (available < price) {
    const currency = getCurrencySettings().find(entry => entry.key === currencyKey);
    throw new Error(`Недостаточно валюты: ${buyerActor?.name ?? ""} (${price} ${currency?.label ?? currencyKey}).`);
  }
}

async function applyTradeItemPayment({ buyerActor, sellerActor, item, currencyKey, quantity = 1, barterAdjustmentPercent = null } = {}) {
  const price = calculateItemTradePrice(item, currencyKey, quantity, { sellerActor, barterAdjustmentPercent });
  if (price <= 0) return { price: 0 };
  const buyerAmount = getActorCurrencyAmount(buyerActor, currencyKey);
  const sellerAmount = getActorCurrencyAmount(sellerActor, currencyKey);
  if (buyerAmount < price) throw new Error("Недостаточно валюты.");
  await buyerActor.update({ [`system.currencies.${currencyKey}`]: buyerAmount - price });
  await sellerActor.update({ [`system.currencies.${currencyKey}`]: sellerAmount + price });
  return { price, currencyKey };
}

function calculateItemTradePrice(item, currencyKey = "", quantity = 1, {
  sellerActor = null,
  barterAdjustmentPercent = null,
  itemCollection = null,
  containedItems = []
} = {}) {
  if (!sellerActor) throw new Error("Seller actor is required for trade price calculation.");
  const barterPercent = Number(barterAdjustmentPercent);
  if (!Number.isFinite(barterPercent)) throw new Error("Trade barter adjustment percent is required.");
  const currencies = getCurrencySettings();
  const targetCurrency = currencies.find(entry => entry.key === currencyKey) ?? currencies.find(entry => entry.primaryTrade) ?? currencies.at(0);
  const markupPercent = Number(sellerActor.system.trade.markupPercent);
  if (!Number.isFinite(markupPercent)) throw new Error("Seller trade markup must be numeric.");
  const percentMultiplier = 1 + ((markupPercent + barterPercent) / 100);
  return calculateItemTradePriceTree(item, {
    targetCurrency,
    currencies,
    quantity: Math.max(1, toInteger(quantity)),
    percentMultiplier,
    itemCollection: itemCollection ?? sellerActor?.items ?? null,
    containedItems
  });
}

function calculateItemTradePriceTree(item, {
  targetCurrency = null,
  currencies = getCurrencySettings(),
  quantity = null,
  percentMultiplier = 1,
  itemCollection = null,
  containedItems = [],
  visitedIds = new Set(),
  visitedObjects = new WeakSet()
} = {}) {
  if (!item || typeof item !== "object") return 0;
  const itemId = getItemId(item);
  if (itemId) {
    if (visitedIds.has(itemId)) return 0;
    visitedIds.add(itemId);
  } else {
    if (visitedObjects.has(item)) return 0;
    visitedObjects.add(item);
  }

  const itemQuantity = quantity === null
    ? Math.max(1, getItemQuantity(item))
    : Math.max(1, toInteger(quantity));
  let price = calculateSingleItemTradePrice(item, targetCurrency, currencies, itemQuantity, percentMultiplier);
  for (const child of getItemTradePriceChildren(item, itemCollection, containedItems)) {
    price += calculateItemTradePriceTree(child, {
      targetCurrency,
      currencies,
      percentMultiplier,
      itemCollection,
      containedItems,
      visitedIds,
      visitedObjects
    });
  }
  return price;
}

function calculateSingleItemTradePrice(item, targetCurrency = null, currencies = getCurrencySettings(), quantity = 1, percentMultiplier = 1) {
  const unitPrice = Math.max(0, Number(item?.system?.price ?? item?.price) || 0);
  const itemQuantity = Math.max(1, toInteger(quantity));
  if (!unitPrice) return 0;

  const sourceCurrencyKey = String(item?.system?.priceCurrency ?? item?.priceCurrency ?? "");
  const sourceCurrency = currencies.find(entry => entry.key === sourceCurrencyKey) ?? targetCurrency;
  const sourceValue = Math.max(0, Number(sourceCurrency?.value) || 0);
  const targetValue = Math.max(0, Number(targetCurrency?.value) || 0);
  const basePrice = !sourceValue || !targetValue
    ? unitPrice * itemQuantity
    : (unitPrice * itemQuantity * sourceValue) / targetValue;
  const functionMultiplier = getItemTradeFunctionPriceMultiplier(item);
  return Math.max(0, Math.ceil(basePrice * functionMultiplier * percentMultiplier));
}

function formatItemTradePrice(item, currencyKey = "", sellerActor = null, { barterAdjustmentPercent = null } = {}) {
  const price = calculateItemTradePrice(item, currencyKey, 1, { sellerActor, barterAdjustmentPercent });
  if (price <= 0) return "";
  return price;
}

function getItemTradePriceChildren(item, itemCollection = null, containedItems = []) {
  if (item?.__falloutMawTradeReference) return [];
  const children = [];
  const seenIds = new Set();
  const seenObjects = new WeakSet();
  const parentId = getItemId(item);
  if (parentId) {
    for (const candidate of getTradePriceItemCollection(itemCollection, containedItems)) {
      if (!candidate || getItemId(candidate) === parentId) continue;
      const containerParentId = getItemContainerParentId(candidate);
      const attachedParentId = String(candidate?.system?.placement?.parentItemId ?? "");
      if (containerParentId !== parentId && attachedParentId !== parentId) continue;
      addTradePriceChild(children, candidate, seenIds, seenObjects);
    }
  }
  for (const embedded of getEmbeddedTradeItemDataChildren(item)) {
    addTradePriceChild(children, embedded, seenIds, seenObjects);
  }
  for (const referenced of getReferencedTradeItemDataChildren(item)) {
    addTradePriceChild(children, referenced, seenIds, seenObjects);
  }
  return children;
}

function getTradePriceItemCollection(itemCollection = null, containedItems = []) {
  const items = [];
  if (itemCollection) items.push(...getItemsArray(itemCollection));
  if (containedItems) items.push(...getItemsArray(containedItems));
  return items.filter(Boolean);
}

function addTradePriceChild(children = [], item = null, seenIds = new Set(), seenObjects = new WeakSet()) {
  if (!item || typeof item !== "object") return;
  const id = getItemId(item);
  if (id) {
    if (seenIds.has(id)) return;
    seenIds.add(id);
  } else {
    if (seenObjects.has(item)) return;
    seenObjects.add(item);
  }
  children.push(item);
}

function getEmbeddedTradeItemDataChildren(item = null) {
  const rootData = item?.toObject ? item.toObject() : item;
  const results = [];
  const visited = new WeakSet();
  collectEmbeddedTradeItemData(rootData?.system ?? rootData, results, visited);
  return results;
}

function collectEmbeddedTradeItemData(value = null, results = [], visited = new WeakSet()) {
  if (!value || typeof value !== "object") return;
  if (visited.has(value)) return;
  visited.add(value);
  for (const child of Object.values(value)) {
    if (!child || typeof child !== "object") continue;
    if (isEmbeddedTradeItemData(child)) {
      results.push(child);
      continue;
    }
    collectEmbeddedTradeItemData(child, results, visited);
  }
}

function isEmbeddedTradeItemData(value = null) {
  return Boolean(
    value
    && typeof value === "object"
    && value.system
    && typeof value.system === "object"
    && (
      value.name !== undefined
      || value.type !== undefined
      || value.img !== undefined
      || value.id !== undefined
      || value._id !== undefined
    )
  );
}

function getReferencedTradeItemDataChildren(item = null) {
  const rootData = item?.toObject ? item.toObject() : item;
  const results = [];
  const visited = new WeakSet();
  collectReferencedTradeItemData(rootData?.system ?? rootData, results, visited);
  return results;
}

function collectReferencedTradeItemData(value = null, results = [], visited = new WeakSet()) {
  if (!value || typeof value !== "object") return;
  if (visited.has(value)) return;
  visited.add(value);
  const referenced = createTradeReferenceItemData(value);
  if (referenced) {
    results.push(referenced);
    return;
  }
  for (const child of Object.values(value)) {
    if (!child || typeof child !== "object") continue;
    if (isEmbeddedTradeItemData(child)) continue;
    collectReferencedTradeItemData(child, results, visited);
  }
}

function createTradeReferenceItemData(value = null) {
  const uuid = String(value?.sourceItemUuid ?? "").trim();
  const quantity = Math.max(0, toInteger(value?.value));
  if (!uuid || !quantity) return null;
  const item = resolveWorldItemSync(uuid);
  if (!item) return null;
  const data = item.toObject?.() ?? foundry.utils.deepClone(item);
  delete data._id;
  delete data.id;
  foundry.utils.setProperty(data, "system.quantity", quantity);
  data.__falloutMawTradeReference = true;
  return data;
}

function getActorCurrencyAmount(actor, currencyKey = "") {
  return Math.max(0, toInteger(actor?.system?.currencies?.[currencyKey]));
}

function normalizeTradeCurrencyKey(currencyKey = "") {
  const currencies = getCurrencySettings();
  const key = String(currencyKey ?? "");
  if (currencies.some(entry => entry.key === key)) return key;
  return getPrimaryTradeCurrencyKey(currencies);
}

function getPrimaryTradeCurrencyKey(currencies = getCurrencySettings()) {
  return String((currencies.find(entry => entry.primaryTrade) ?? currencies.at(0))?.key ?? "");
}

function createEmptyTradeOffers() {
  return {
    completed: false,
    searcher: { items: [], currencies: [], ready: false, readyActors: [], columns: TRADE_OFFER_DEFAULT_COLUMNS },
    searched: { items: [], currencies: [], ready: false, readyActors: [], columns: TRADE_OFFER_DEFAULT_COLUMNS }
  };
}

function normalizeTradeOffersState(state = {}) {
  const result = createEmptyTradeOffers();
  result.completed = Boolean(state?.completed);
  for (const side of TRADE_OFFER_SIDES) {
    const source = state?.[side] ?? {};
    result[side].ready = Boolean(source.ready);
    result[side].readyActors = (Array.isArray(source.readyActors) ? source.readyActors : [])
      .map(actorUuid => String(actorUuid ?? ""))
      .filter(Boolean);
    result[side].columns = TRADE_OFFER_DEFAULT_COLUMNS;
    result[side].items = (Array.isArray(source.items) ? source.items : [])
      .map(entry => ({
        entryId: String(entry?.entryId ?? entry?.offerKey ?? entry?.itemId ?? foundry.utils.randomID()),
        itemId: String(entry?.itemId ?? ""),
        sourceActorUuid: String(entry?.sourceActorUuid ?? ""),
        sourceStackIndex: toInteger(entry?.sourceStackIndex),
        returnActorUuid: String(entry?.returnActorUuid ?? ""),
        quantity: Math.max(1, toInteger(entry?.quantity)),
        itemData: normalizeTradeOfferItemData(entry?.itemData),
        containedItems: normalizeTradeOfferContainedItems(entry?.containedItems),
        placement: normalizeTradeOfferPlacement(entry?.placement)
      }))
      .filter(entry => entry.itemId);
    result[side].currencies = (Array.isArray(source.currencies) ? source.currencies : [])
      .map(entry => normalizeTradeCurrencyOfferEntry(entry))
      .filter(entry => entry.currencyKey && entry.amount > 0);
  }
  return result;
}

function normalizeTradeCurrencyOfferEntry(entry = {}) {
  const currencyKey = String(entry?.currencyKey ?? "");
  const rawContributions = Array.isArray(entry?.contributions) ? entry.contributions : [];
  const contributions = rawContributions
    .map(contribution => ({
      actorUuid: String(contribution?.actorUuid ?? contribution?.sourceActorUuid ?? ""),
      userId: String(contribution?.userId ?? ""),
      amount: Math.max(0, toInteger(contribution?.amount))
    }))
    .filter(contribution => contribution.actorUuid && contribution.amount > 0);
  const fallbackAmount = Math.max(0, toInteger(entry?.amount));
  if (!contributions.length && fallbackAmount > 0) {
    contributions.push({
      actorUuid: String(entry?.sourceActorUuid ?? ""),
      userId: String(entry?.userId ?? ""),
      amount: fallbackAmount
    });
  }
  const amount = contributions.length
    ? contributions.reduce((total, contribution) => total + Math.max(0, toInteger(contribution.amount)), 0)
    : fallbackAmount;
  return {
    currencyKey,
    amount,
    contributions,
    returnActorUuid: String(entry?.returnActorUuid ?? ""),
    placement: normalizeTradeOfferPlacement(entry?.placement)
  };
}

function normalizeTradeOfferItemData(itemData = null) {
  if (!itemData || typeof itemData !== "object") return null;
  return foundry.utils.deepClone(itemData);
}

function normalizeTradeOfferContainedItems(containedItems = []) {
  return (Array.isArray(containedItems) ? containedItems : [])
    .map(itemData => normalizeTradeOfferItemData(itemData))
    .filter(Boolean);
}

function getTradeOfferedItemQuantity(offer = {}, itemId = "", actorUuid = "", sourceStackIndex = null) {
  const key = String(itemId ?? "");
  const sourceActorUuid = String(actorUuid ?? "");
  const hasSourceStackIndex = sourceStackIndex !== null && sourceStackIndex !== undefined;
  const normalizedStackIndex = toInteger(sourceStackIndex);
  return (offer?.items ?? [])
    .filter(entry => String(entry.itemId ?? entry.id ?? entry.offerKey ?? "") === key)
    .filter(entry => !sourceActorUuid || String(entry.sourceActorUuid ?? entry.actorUuid ?? "") === sourceActorUuid)
    .filter(entry => !hasSourceStackIndex || toInteger(entry.sourceStackIndex) === normalizedStackIndex)
    .reduce((total, entry) => total + Math.max(0, toInteger(entry.quantity)), 0);
}

function getTradeOfferedCurrencyAmount(offer = {}, currencyKey = "") {
  const key = String(currencyKey ?? "");
  return (offer?.currencies ?? [])
    .filter(entry => String(entry.currencyKey ?? "") === key)
    .reduce((total, entry) => total + Math.max(0, toInteger(entry.amount)), 0);
}

function getTradeAvailableCurrencyAmount(offer = {}, actor = null, currencyKey = "") {
  const amount = getActorCurrencyAmount(actor, currencyKey);
  const offered = getTradeOfferCurrencyContributionAmount(offer, currencyKey, actor?.uuid ?? "");
  return Math.max(0, amount - offered);
}

function getTradeOfferCurrencyContributionAmount(offer = {}, currencyKey = "", actorUuid = "", userId = "") {
  const key = String(currencyKey ?? "");
  const sourceActorUuid = String(actorUuid ?? "");
  const sourceUserId = String(userId ?? "");
  return (offer?.currencies ?? [])
    .filter(entry => String(entry.currencyKey ?? "") === key)
    .flatMap(entry => entry.contributions ?? [])
    .filter(entry => String(entry.actorUuid ?? "") === sourceActorUuid && (!sourceUserId || String(entry.userId ?? "") === sourceUserId))
    .reduce((total, entry) => total + Math.max(0, toInteger(entry.amount)), 0);
}

function getTradeOfferEntryKey(entry = {}, kind = "") {
  if (kind === "currency") return String(entry.currencyKey ?? entry.offerKey ?? "");
  return String(entry.entryId ?? entry.offerKey ?? entry.itemId ?? "");
}

function findTradeOfferEntry(offer = {}, kind = "", key = "") {
  const normalizedKey = String(key ?? "");
  if (!normalizedKey) return null;
  if (kind === "currency") return (offer?.currencies ?? []).find(entry => getTradeOfferEntryKey(entry, "currency") === normalizedKey) ?? null;
  if (kind === "item") return (offer?.items ?? []).find(entry => getTradeOfferEntryKey(entry, "item") === normalizedKey) ?? null;
  return null;
}

function getTradeOfferEntryItemData(entry = null, sourceActor = null) {
  if (!entry) return null;
  const liveItem = sourceActor?.items?.get(String(entry.itemId ?? ""));
  const itemData = liveItem?.toObject?.() ?? normalizeTradeOfferItemData(entry.itemData);
  if (!itemData) return null;
  foundry.utils.setProperty(itemData, "system.quantity", Math.max(1, toInteger(entry.quantity)));
  return itemData;
}

function normalizeTradeOfferPlacement(placement = null, fallback = null) {
  if (!placement || typeof placement !== "object") {
    if (!fallback || typeof fallback !== "object") return null;
    placement = {};
  }
  return {
    x: Math.max(1, toInteger(placement?.x) || toInteger(fallback?.x) || 1),
    y: Math.max(1, toInteger(placement?.y) || toInteger(fallback?.y) || 1),
    width: Math.max(1, toInteger(placement?.width) || toInteger(fallback?.width) || 1),
    height: Math.max(1, toInteger(placement?.height) || toInteger(fallback?.height) || 1),
    rotated: Boolean(placement?.rotated ?? fallback?.rotated)
  };
}

function addTradeOfferItem(state = {}, side = "", item = null, quantity = 0, placement = null, sourceActorUuid = "", { sourceStackIndex = 0, sourceWholeStack = false } = {}) {
  const offers = normalizeTradeOffersState(state);
  if (!TRADE_OFFER_SIDES.includes(side) || !item) return offers;
  const itemId = String(item.id ?? "");
  const sourceUuid = String(sourceActorUuid ?? "");
  const stackIndex = Math.max(0, toInteger(sourceStackIndex));
  if (!sourceUuid) return offers;
  const virtualStack = usesVirtualInventoryStacks(item);
  const aggregateVirtualStack = virtualStack && Boolean(sourceWholeStack);
  const stackLimit = aggregateVirtualStack
    ? Math.max(1, getItemQuantity(item))
    : virtualStack
    ? Math.max(1, getItemStackPartQuantity(item, stackIndex))
    : Math.max(1, getItemQuantity(item));
  const alreadyOffered = getTradeOfferedItemQuantity(offers[side], itemId, sourceUuid, virtualStack && !aggregateVirtualStack ? stackIndex : null);
  const amount = Math.max(0, Math.min(Math.max(0, toInteger(quantity)), Math.max(0, stackLimit - alreadyOffered)));
  if (!amount) return offers;
  const storedStackIndex = aggregateVirtualStack ? -1 : (virtualStack ? stackIndex : 0);
  const existing = offers[side].items.find(entry => (
    entry.itemId === itemId
    && String(entry.sourceActorUuid ?? "") === sourceUuid
    && (!virtualStack || toInteger(entry.sourceStackIndex) === storedStackIndex)
  ));
  if (existing) existing.quantity += amount;
  else offers[side].items.push({
    entryId: foundry.utils.randomID(),
    itemId,
    sourceActorUuid: sourceUuid,
    sourceStackIndex: storedStackIndex,
    quantity: amount,
    placement: normalizeTradeOfferPlacement(placement)
  });
  return offers;
}

function addTradeOfferCurrency(state = {}, side = "", currencyKey = "", amount = 0, placement = null, sourceActorUuid = "", userId = "") {
  const offers = normalizeTradeOffersState(state);
  if (!TRADE_OFFER_SIDES.includes(side) || !currencyKey) return offers;
  const value = Math.max(1, toInteger(amount));
  const existing = offers[side].currencies.find(entry => entry.currencyKey === currencyKey);
  const actorUuid = String(sourceActorUuid ?? "");
  const contributorUserId = String(userId ?? "");
  if (existing) {
    const contribution = existing.contributions.find(entry => entry.actorUuid === actorUuid);
    if (contribution) {
      contribution.amount += value;
      contribution.userId ||= contributorUserId;
    }
    else existing.contributions.push({ actorUuid, userId: contributorUserId, amount: value });
    existing.amount = existing.contributions.reduce((total, entry) => total + Math.max(0, toInteger(entry.amount)), 0);
  } else {
    offers[side].currencies.push({
      currencyKey,
      amount: value,
      contributions: [{ actorUuid, userId: contributorUserId, amount: value }],
      placement: normalizeTradeOfferPlacement(placement)
    });
  }
  return offers;
}

function updateTradeOfferEntryPlacement(state = {}, side = "", kind = "", key = "", placement = null, _columns = TRADE_OFFER_DEFAULT_COLUMNS) {
  const offers = normalizeTradeOffersState(state);
  if (!TRADE_OFFER_SIDES.includes(side)) return offers;
  const entries = kind === "currency" ? offers[side].currencies : offers[side].items;
  const entry = entries.find(candidate => getTradeOfferEntryKey(candidate, kind) === key);
  if (!entry) return offers;
  entry.placement = normalizeTradeOfferPlacement(placement);
  offers[side].columns = TRADE_OFFER_DEFAULT_COLUMNS;
  return offers;
}

function removeTradeOfferEntry(state = {}, side = "", kind = "", key = "") {
  const offers = normalizeTradeOffersState(state);
  if (!TRADE_OFFER_SIDES.includes(side)) return offers;
  if (kind === "item") {
    offers[side].items = offers[side].items.filter(entry => getTradeOfferEntryKey(entry, "item") !== key);
  } else if (kind === "currency") {
    offers[side].currencies = offers[side].currencies.filter(entry => entry.currencyKey !== key);
  } else if (kind === "all") {
    offers[side].items = [];
    offers[side].currencies = [];
  }
  return offers;
}

function reduceTradeOfferEntryQuantity(state = {}, side = "", kind = "", key = "", quantity = 0) {
  const offers = normalizeTradeOffersState(state);
  if (!TRADE_OFFER_SIDES.includes(side)) return offers;
  const amount = Math.max(1, toInteger(quantity));
  if (kind === "currency") {
    const entry = offers[side].currencies.find(candidate => candidate.currencyKey === key);
    if (!entry) return offers;
    let remaining = amount;
    for (const contribution of entry.contributions ?? []) {
      const taken = Math.min(remaining, Math.max(0, toInteger(contribution.amount)));
      contribution.amount -= taken;
      remaining -= taken;
      if (!remaining) break;
    }
    entry.contributions = (entry.contributions ?? []).filter(contribution => Math.max(0, toInteger(contribution.amount)) > 0);
    entry.amount = Math.max(0, toInteger(entry.amount) - amount);
    if (entry.amount > 0 && !entry.contributions.length) entry.contributions = [{ actorUuid: "", userId: "", amount: entry.amount }];
    offers[side].currencies = offers[side].currencies.filter(candidate => candidate.amount > 0);
    return offers;
  }
  if (kind !== "item") return offers;
  const entry = offers[side].items.find(candidate => getTradeOfferEntryKey(candidate, "item") === key);
  if (!entry) return offers;
  entry.quantity = Math.max(0, toInteger(entry.quantity) - amount);
  if (entry.itemData) foundry.utils.setProperty(entry.itemData, "system.quantity", entry.quantity);
  offers[side].items = offers[side].items.filter(candidate => candidate.quantity > 0);
  return offers;
}

function prepareTradeOffersContext(state = {}, { searcherActor = null, searchedActor = null, tradeCurrencyKey = "", sideBarterValues = null } = {}) {
  const offers = normalizeTradeOffersState(state);
  offers.searcher.completed = offers.completed;
  offers.searched.completed = offers.completed;
  const context = {
    searcher: prepareTradeOfferSideContext(offers.searcher, searcherActor, "searcher", tradeCurrencyKey, sideBarterValues),
    searched: prepareTradeOfferSideContext(offers.searched, searchedActor, "searched", tradeCurrencyKey, sideBarterValues)
  };
  context.searcher.completed = offers.completed;
  context.searched.completed = offers.completed;
  return context;
}

function prepareTradeOfferSideContext(offer = {}, actor = null, side = "", tradeCurrencyKey = "", sideBarterValues = null) {
  const items = [];
  let total = 0;
  const columns = getFixedTradeOfferGridColumns();
  const occupiedPlacements = [];
  const buyerSide = getOppositeTradeSide(side);
  const barterAdjustmentPercent = getTradeBarterAdjustmentPercent(sideBarterValues?.[side], sideBarterValues?.[buyerSide]);
  for (const entry of offer.items ?? []) {
    const sourceActor = getCachedActorByUuid(entry.sourceActorUuid);
    if (!sourceActor) continue;
    const liveItem = sourceActor?.items?.get(String(entry.itemId ?? ""));
    const itemData = offer.completed
      ? (normalizeTradeOfferItemData(entry.itemData) ?? liveItem?.toObject?.())
      : (liveItem?.toObject?.() ?? normalizeTradeOfferItemData(entry.itemData));
    if (!itemData) continue;
    const sourceQuantity = offer.completed ? Math.max(1, toInteger(entry.quantity)) : Math.max(1, getItemQuantity(liveItem ?? itemData));
    const quantity = Math.max(1, Math.min(sourceQuantity, toInteger(entry.quantity)));
    foundry.utils.setProperty(itemData, "system.quantity", quantity);
    const priceItemCollection = liveItem ? sourceActor?.items : entry.containedItems ?? [];
    const price = calculateItemTradePrice(liveItem ?? itemData, tradeCurrencyKey, quantity, {
      sellerActor: sourceActor,
      barterAdjustmentPercent,
      itemCollection: priceItemCollection,
      containedItems: entry.containedItems ?? []
    });
    const footprint = getItemFootprint(liveItem ?? itemData, priceItemCollection);
    const placement = resolveTradeOfferEntryPlacement(entry.placement, footprint, occupiedPlacements, columns);
    placement.rotated = Boolean(entry.placement?.rotated ?? (liveItem ?? itemData)?.system?.placement?.rotated);
    const offerKey = getTradeOfferEntryKey(entry, "item");
    const interactionState = getItemInteractionState(sourceActor, liveItem ?? itemData);
    occupiedPlacements.push({ kind: "item", key: offerKey, placement });
    total += price;
    items.push({
      offerKey,
      side,
      completed: Boolean(offer.completed),
      id: String(entry.itemId ?? liveItem?.id ?? offerKey),
      sourceActorUuid: sourceActor?.uuid ?? "",
      sourceStackIndex: Math.max(0, toInteger(entry.sourceStackIndex)),
      actorUuid: sourceActor?.uuid ?? "",
      name: liveItem?.name ?? itemData.name,
      img: normalizeImagePath(liveItem?.img ?? itemData.img, FALLBACK_ICON),
      quantity,
      showQuantity: getItemMaxStack(liveItem ?? itemData) > 1 || quantity > 1,
      price: price > 0 ? price : "",
      interactionToggleable: interactionState.toggleable,
      interactionToggled: interactionState.toggled,
      placement,
      gridStyle: buildInventoryCellStyle(placement.x, placement.y, placement)
    });
  }

  const currencies = [];
  for (const entry of offer.currencies ?? []) {
    const currencyKey = String(entry.currencyKey ?? "");
    const amount = Math.max(0, toInteger(entry.amount));
    if (!currencyKey || !amount) continue;
    const currency = getCurrencySettings().find(option => option.key === currencyKey);
    const value = calculateCurrencyTradeValue(amount, currencyKey, tradeCurrencyKey);
    const placement = resolveTradeOfferEntryPlacement(entry.placement, { width: 1, height: 1 }, occupiedPlacements, columns);
    occupiedPlacements.push({ kind: "currency", key: currencyKey, placement });
    total += value;
    currencies.push({
      offerKey: currencyKey,
      side,
      completed: Boolean(offer.completed),
      currencyKey,
      label: currency?.label ?? currencyKey,
      img: currency?.img ?? "",
      hasImage: Boolean(currency?.img),
      amount,
      value,
      placement,
      gridStyle: buildInventoryCellStyle(placement.x, placement.y, placement)
    });
  }

  const rows = Math.max(1, occupiedPlacements.reduce((max, entry) => Math.max(max, entry.placement.y + entry.placement.height - 1), 1));
  const style = buildTradeOfferGridStyle(columns, rows);

  return {
    side,
    ready: Boolean(offer.ready),
    total,
    items,
    currencies,
    grid: { columns, rows, style },
    empty: !items.length && !currencies.length
  };
}

function formatTradeOfferDifference(value = 0) {
  const amount = toInteger(value);
  if (!amount) return "0";
  return String(amount);
}

function getTradeOfferDifferenceClass(value = 0) {
  const amount = toInteger(value);
  if (amount > 0) return "positive";
  if (amount < 0) return "negative";
  return "neutral";
}

function resolveTradeOfferEntryPlacement(placement = null, footprint = {}, occupiedPlacements = [], columns = TRADE_OFFER_DEFAULT_COLUMNS) {
  const normalizedPlacement = normalizeTradeOfferPlacement(placement, footprint);
  const width = Math.max(1, Math.min(columns, toInteger(normalizedPlacement?.width) || toInteger(footprint?.width) || 1));
  const height = Math.max(1, toInteger(normalizedPlacement?.height) || toInteger(footprint?.height) || 1);
  const requested = normalizeTradeOfferPlacement({ ...(normalizedPlacement ?? {}), width, height }, { width, height });
  if (isTradeOfferPlacementAvailable(requested, occupiedPlacements.map(entry => entry.placement), columns, TRADE_OFFER_MAX_ROWS)) return requested;
  return findFirstAvailableTradeOfferPlacement(occupiedPlacements.map(entry => entry.placement), columns, TRADE_OFFER_MAX_ROWS, { width, height }) ?? requested;
}

function getTradeOfferOccupiedPlacements(offer = {}, { excludeKind = "", excludeKey = "" } = {}) {
  const occupied = [];
  for (const entry of offer?.items ?? []) {
    const key = getTradeOfferEntryKey(entry, "item");
    if (excludeKind === "item" && key === excludeKey) continue;
    const placement = normalizeTradeOfferPlacement(entry.placement);
    if (placement) occupied.push(placement);
  }
  for (const entry of offer?.currencies ?? []) {
    const key = String(entry.currencyKey ?? entry.offerKey ?? "");
    if (excludeKind === "currency" && key === excludeKey) continue;
    const placement = normalizeTradeOfferPlacement(entry.placement);
    if (placement) occupied.push(placement);
  }
  return occupied;
}

function getTradeOfferGridPointerPosition(grid = null, event = null, { columns = TRADE_OFFER_DEFAULT_COLUMNS } = {}) {
  return getInventoryGridPointerPositionFromElement(event, grid, {
    columns: Math.max(1, toInteger(columns) || TRADE_OFFER_DEFAULT_COLUMNS),
    allowOverflowRows: true,
    clamp: true
  });
}

function resolveCssLengthPixels(parent = null, value = "", fallback = 0) {
  const text = String(value ?? "").trim();
  const numeric = Number.parseFloat(text);
  if (Number.isFinite(numeric) && text.endsWith("px")) return numeric;
  if (!parent || !text) return Number.isFinite(numeric) ? numeric : fallback;
  const probe = document.createElement("div");
  Object.assign(probe.style, {
    position: "absolute",
    visibility: "hidden",
    pointerEvents: "none",
    width: text,
    height: "0"
  });
  parent.append(probe);
  const pixels = probe.getBoundingClientRect().width;
  probe.remove();
  return pixels > 0 ? pixels : (Number.isFinite(numeric) ? numeric : fallback);
}

function getTradeOfferGridPointerPlacement(pointer = null, { columns = TRADE_OFFER_DEFAULT_COLUMNS, width = 1, height = 1 } = {}) {
  if (!pointer) return null;
  const anchorX = Number(pointer.x);
  const anchorY = Number(pointer.y);
  if (!Number.isFinite(anchorX) || !Number.isFinite(anchorY)) return null;
  const rawX = Math.round(anchorX - ((width - 1) / 2));
  const rawY = Math.round(anchorY - ((height - 1) / 2));
  return normalizeTradeOfferPlacement({
    x: Math.max(1, Math.min(Math.max(1, columns - width + 1), rawX)),
    y: Math.max(1, rawY),
    width,
    height
  });
}

function isTradeOfferPlacementAvailable(placement = null, occupiedPlacements = [], columns = TRADE_OFFER_DEFAULT_COLUMNS, rows = TRADE_OFFER_MAX_ROWS) {
  const normalized = normalizeTradeOfferPlacement(placement);
  if (!normalized) return false;
  if (normalized.x < 1 || normalized.y < 1) return false;
  if ((normalized.x + normalized.width - 1) > columns) return false;
  if ((normalized.y + normalized.height - 1) > rows) return false;
  return !occupiedPlacements.some(existing => tradeOfferPlacementsOverlap(normalized, normalizeTradeOfferPlacement(existing)));
}

function findFirstAvailableTradeOfferPlacement(occupiedPlacements = [], columns = TRADE_OFFER_DEFAULT_COLUMNS, rows = TRADE_OFFER_MAX_ROWS, footprint = {}) {
  const width = Math.max(1, Math.min(columns, toInteger(footprint.width) || 1));
  const height = Math.max(1, toInteger(footprint.height) || 1);
  for (let y = 1; y <= rows; y += 1) {
    for (let x = 1; x <= Math.max(1, columns - width + 1); x += 1) {
      const placement = normalizeTradeOfferPlacement({ x, y, width, height });
      if (isTradeOfferPlacementAvailable(placement, occupiedPlacements, columns, rows)) return placement;
    }
  }
  return null;
}

function findNearestAvailableTradeOfferPlacement(occupiedPlacements = [], columns = TRADE_OFFER_DEFAULT_COLUMNS, rows = TRADE_OFFER_MAX_ROWS, footprint = {}, preferred = null) {
  const width = Math.max(1, Math.min(columns, toInteger(footprint.width) || 1));
  const height = Math.max(1, toInteger(footprint.height) || 1);
  const preferredPlacement = normalizeTradeOfferPlacement(preferred, { width, height }) ?? normalizeTradeOfferPlacement({ x: 1, y: 1, width, height });
  const candidates = [];
  for (let y = 1; y <= rows; y += 1) {
    for (let x = 1; x <= Math.max(1, columns - width + 1); x += 1) {
      const placement = normalizeTradeOfferPlacement({ x, y, width, height });
      if (!isTradeOfferPlacementAvailable(placement, occupiedPlacements, columns, rows)) continue;
      candidates.push({
        placement,
        distance: ((placement.x - preferredPlacement.x) ** 2) + ((placement.y - preferredPlacement.y) ** 2)
      });
    }
  }
  candidates.sort((left, right) => left.distance - right.distance || left.placement.y - right.placement.y || left.placement.x - right.placement.x);
  return candidates[0]?.placement ?? null;
}

function tradeOfferPlacementsOverlap(left = null, right = null) {
  const a = normalizeTradeOfferPlacement(left);
  const b = normalizeTradeOfferPlacement(right);
  if (!a || !b) return false;
  return !(
    a.x + a.width <= b.x
    || b.x + b.width <= a.x
    || a.y + a.height <= b.y
    || b.y + b.height <= a.y
  );
}

function isTradeItemFullyOffered(item = null, tradeOffer = null, actor = null) {
  if (!item || !tradeOffer || tradeOffer.completed) return false;
  return getTradeOfferedSourceItemQuantity(item, tradeOffer, actor) >= getTradeSourceItemQuantity(item);
}

function getTradeOfferedSourceItemQuantity(item = null, tradeOffer = null, actor = null) {
  if (!item || !tradeOffer) return 0;
  const actorUuid = String(actor?.uuid ?? item?.actorUuid ?? "");
  if (usesVirtualInventoryStacks(item)) {
    const stackIndex = Math.max(0, toInteger(item?.stackIndex ?? item?._stackIndex));
    return getTradeOfferedItemQuantity(tradeOffer, item.id, actorUuid, stackIndex);
  }
  return getTradeOfferedItemQuantity(tradeOffer, item.id, actorUuid);
}

function getTradeSourceItemQuantity(item = null) {
  if (!item) return 0;
  if (usesVirtualInventoryStacks(item)) {
    const stackIndex = Math.max(0, toInteger(item?.stackIndex ?? item?._stackIndex));
    return Math.max(1, toInteger(item?.stackQuantity ?? item?._stackQuantity) || getItemStackPartQuantity(item, stackIndex));
  }
  return Math.max(1, getItemQuantity(item));
}

function calculateCurrencyTradeValue(amount = 0, sourceCurrencyKey = "", targetCurrencyKey = "") {
  const sourceAmount = Math.max(0, toInteger(amount));
  if (!sourceAmount) return 0;
  const currencies = getCurrencySettings();
  const targetCurrency = currencies.find(entry => entry.key === targetCurrencyKey) ?? currencies.find(entry => entry.primaryTrade) ?? currencies.at(0);
  const sourceCurrency = currencies.find(entry => entry.key === sourceCurrencyKey) ?? targetCurrency;
  const sourceValue = Math.max(0, Number(sourceCurrency?.value) || 0);
  const targetValue = Math.max(0, Number(targetCurrency?.value) || 0);
  if (!sourceValue || !targetValue) return sourceAmount;
  return Math.ceil((sourceAmount * sourceValue) / targetValue);
}

function convertTradeCurrencyValueToAmount(value = 0, currencyKey = "", valueCurrencyKey = "") {
  const targetValueAmount = Math.max(0, toInteger(value));
  if (!targetValueAmount) return 0;
  const currencies = getCurrencySettings();
  const valueCurrency = currencies.find(entry => entry.key === valueCurrencyKey) ?? currencies.find(entry => entry.primaryTrade) ?? currencies.at(0);
  const currency = currencies.find(entry => entry.key === currencyKey) ?? valueCurrency;
  const valueCurrencyValue = Math.max(0, Number(valueCurrency?.value) || 0);
  const currencyValue = Math.max(0, Number(currency?.value) || 0);
  if (!valueCurrencyValue || !currencyValue) return targetValueAmount;
  return Math.max(1, Math.ceil((targetValueAmount * valueCurrencyValue) / currencyValue));
}

function getItemTradeFunctionPriceMultiplier(itemOrSystem = null) {
  return Math.max(0, getItemTradeConditionPriceMultiplier(itemOrSystem) * getItemTradeToolSupplyPriceMultiplier(itemOrSystem));
}

function getItemTradeConditionPriceMultiplier(itemOrSystem = null) {
  if (!hasItemFunction(itemOrSystem, ITEM_FUNCTIONS.condition)) return 1;
  const condition = getConditionFunction(itemOrSystem);
  const max = Math.max(0, toInteger(condition.max));
  if (max <= 0) return 1;
  const value = Math.max(0, Math.min(max, toInteger(condition.value)));
  return 0.2 + ((value / max) * 0.8);
}

function getItemTradeToolSupplyPriceMultiplier(itemOrSystem = null) {
  const toolFunctions = getEnabledToolFunctions(itemOrSystem);
  if (!toolFunctions.length) return 1;
  const ratios = toolFunctions.map(tool => {
    const max = Math.max(0, toInteger(tool.supply?.max));
    if (max <= 0) return 0;
    const value = Math.max(0, Math.min(max, toInteger(tool.supply?.value)));
    return value / max;
  });
  return Math.max(0, Math.min(...ratios));
}

function getActorBarterValue(actor) {
  return toInteger(actor?.system?.skills?.barter?.value);
}

function getTradeSideBarterValues({ snapshot = null, searcherActor = null, searchedActor = null } = {}) {
  return {
    searcher: getTradeSideMaxBarterValue("searcher", { snapshot, actor: searcherActor }),
    searched: getTradeSideMaxBarterValue("searched", { snapshot, actor: searchedActor })
  };
}

function getTradeSideMaxBarterValue(side = "", { snapshot = null, actor = null } = {}) {
  if (!TRADE_OFFER_SIDES.includes(side)) throw new Error("Invalid trade side.");
  const actors = snapshot
    ? getTradeSnapshotSideParticipants(snapshot, side).map(participant => getCachedActorByUuid(participant.actorUuid)).filter(Boolean)
    : [actor].filter(Boolean);
  if (!actors.length) return 0;
  return Math.max(...actors.map(getActorBarterValue));
}

function getTradeBarterAdjustmentPercent(sellerBarter = null, buyerBarter = null) {
  const sellerValue = Number(sellerBarter);
  const buyerValue = Number(buyerBarter);
  if (!Number.isFinite(sellerValue) || !Number.isFinite(buyerValue)) throw new Error("Trade barter values are required.");
  return (sellerValue - buyerValue) / 10;
}

function getOppositeTradeSide(side = "") {
  if (side === "searcher") return "searched";
  if (side === "searched") return "searcher";
  return "";
}

function getTradePayloadBarterAdjustmentPercent({ payload = {}, searcherActor = null, searchedActor = null, sellerActor = null, buyerActor = null } = {}) {
  const session = getActiveTradeSession(payload.tradeSessionId);
  const sellerSide = session ? getTradeSessionActorSide(session, sellerActor?.uuid) : getTradeActorSideFromActors(sellerActor, searcherActor, searchedActor);
  const buyerSide = session ? getTradeSessionActorSide(session, buyerActor?.uuid) : getTradeActorSideFromActors(buyerActor, searcherActor, searchedActor);
  if (!sellerSide || !buyerSide || sellerSide === buyerSide) throw new Error("Trade payment side mismatch.");
  const sideBarterValues = getTradeSideBarterValues({ snapshot: session, searcherActor, searchedActor });
  return getTradeBarterAdjustmentPercent(sideBarterValues[sellerSide], sideBarterValues[buyerSide]);
}

function getTradeActorSideFromActors(actor = null, searcherActor = null, searchedActor = null) {
  if (!actor) return "";
  if (searcherActor && actor.uuid === searcherActor.uuid) return "searcher";
  if (searchedActor && actor.uuid === searchedActor.uuid) return "searched";
  return "";
}

function formatTradeActorName(actor) {
  const barterLabel = getSkillSettings().find(skill => skill.key === "barter")?.label ?? "Бартер";
  return actor ? `${actor.name} (${barterLabel}: ${getActorBarterValue(actor)})` : "";
}

async function createCompletedTradeItem(targetActor, itemData, containedItems = [], {
  targetMode = "inventory",
  targetParentId = ROOT_CONTAINER_ID,
  targetEquipmentSlot = "",
  targetWeaponSet = "",
  targetWeaponSlot = "",
  targetX = null,
  targetY = null,
  targetItemId = "",
  skipProjectedValidation = false
} = {}) {
  validateTargetParent(targetActor, targetParentId);
  const targetItem = targetItemId ? targetActor.items?.get(targetItemId) : null;
  const targetStack = targetMode === "inventory"
    ? getCompatibleStackTarget(targetActor, itemData, targetItem, [], targetParentId).at(0)
    : null;
  const targetStackPlacement = targetStack
    ? normalizeInventoryPlacement(targetStack.system?.placement ?? {}, targetStack, targetActor.items)
    : null;
  const preferredPlacement = getRequestedTargetPlacement({
    sourceActor: null,
    targetActor,
    itemData,
    targetMode,
    targetParentId,
    targetEquipmentSlot,
    targetWeaponSet,
    targetWeaponSlot,
    targetX,
    targetY,
    targetItemId
  }) ?? targetStackPlacement;
  if (!preferredPlacement) throwInventoryNoSpace();
  if (isContainerItem(itemData)) {
    return createCompletedTradeContainerTree(targetActor, itemData, containedItems, targetParentId, preferredPlacement);
  }
  if (preferredPlacement.mode === "inventory") {
    return insertItemIntoActorInventory(targetActor, itemData, preferredPlacement, {
      sourceItem: null,
      targetItem,
      parentId: targetParentId,
      skipProjectedValidation
    });
  }
  const createData = createInventoryStackData(itemData, getItemQuantity(itemData), ROOT_CONTAINER_ID, preferredPlacement, {
    equipped: preferredPlacement.mode === "equipment"
  });
  const replacementUpdates = createActorUnequipReplacementUpdates(
    targetActor,
    getActorPlacementConflictingItems(targetActor, itemData, preferredPlacement)
  );
  if (!replacementUpdates) throwInventoryNoSpace();
  if (!validateActorProjectedInventoryState(targetActor, { updates: replacementUpdates, creates: [createData] })) throwInventoryNoSpace();
  if (replacementUpdates.length) await targetActor.updateEmbeddedDocuments("Item", replacementUpdates);
  return targetActor.createEmbeddedDocuments("Item", [createData]);
}

async function createCompletedTradeContainerTree(targetActor, rootItemData, containedItems = [], targetParentId = ROOT_CONTAINER_ID, preferredPlacement = null) {
  if (preferredPlacement.mode === "inventory" && !isActorInventoryPlacementAvailable(targetActor, targetParentId, preferredPlacement, [], [], { allowLockedDisplacement: true })) {
    throwInventoryNoSpace();
  }
  const rootCreateData = createInventoryStackData(rootItemData, 1, targetParentId, preferredPlacement, {
    equipped: preferredPlacement.mode === "equipment"
  });
  const displacementUpdates = preferredPlacement.mode === "inventory"
    ? getPlacementDisplacementUpdates(targetActor, rootItemData, preferredPlacement, targetParentId, [])
    : [];
  if (!displacementUpdates) throwInventoryNoSpace();
  const validationCreates = buildCompletedContainerTreeValidationCreates(rootCreateData, rootItemData, containedItems);
  if (!validateActorProjectedInventoryState(targetActor, { updates: displacementUpdates, creates: validationCreates })) throwInventoryNoSpace();

  const oldRootId = String(rootItemData?._id ?? rootItemData?.id ?? "");
  const treeCreateData = buildContainerTreeCreateData({
    targetActor,
    rootCreateData,
    rootOldId: oldRootId,
    containedItems,
    getChildData: child => child,
    getChildOldId: child => String(child?._id ?? child?.id ?? "")
  });
  if (displacementUpdates.length) await targetActor.updateEmbeddedDocuments("Item", displacementUpdates);
  const createdItems = await targetActor.createEmbeddedDocuments("Item", treeCreateData.creates, { keepId: true });
  return createdItems.find(item => item.id === treeCreateData.rootId) ?? createdItems.at(0) ?? null;
}

function buildCompletedContainerTreeValidationCreates(rootCreateData, rootItemData, containedItems = []) {
  const rootSyntheticId = "synthetic-completed-container-root";
  const oldRootId = String(rootItemData?._id ?? rootItemData?.id ?? "");
  const syntheticIdMap = new Map([[oldRootId, rootSyntheticId]]);
  const creates = [{
    ...foundry.utils.deepClone(rootCreateData),
    _id: rootSyntheticId,
    id: rootSyntheticId
  }];
  let index = 0;
  for (const childDataRaw of containedItems) {
    const oldParentId = getItemContainerParentId(childDataRaw);
    const newParentId = syntheticIdMap.get(oldParentId);
    if (!newParentId) continue;
    const syntheticId = `synthetic-completed-container-child-${index += 1}`;
    const oldChildId = String(childDataRaw?._id ?? childDataRaw?.id ?? "");
    const childData = foundry.utils.deepClone(childDataRaw);
    delete childData._id;
    delete childData.id;
    foundry.utils.mergeObject(childData, {
      _id: syntheticId,
      id: syntheticId,
      system: {
        equipped: false,
        container: {
          parentId: newParentId
        }
      }
    });
    creates.push(childData);
    if (oldChildId) syntheticIdMap.set(oldChildId, syntheticId);
  }
  return creates;
}

function buildContainerTreeCreateData({
  targetActor = null,
  rootCreateData = {},
  rootOldId = "",
  containedItems = [],
  getChildData = child => child,
  getChildOldId = (_child, childData) => String(childData?._id ?? childData?.id ?? "")
} = {}) {
  const reservedIds = new Set();
  const rootId = createUniqueEmbeddedItemId(targetActor, reservedIds);
  const idMap = new Map([[String(rootOldId ?? ""), rootId]]);
  const rootData = foundry.utils.deepClone(rootCreateData);
  rootData._id = rootId;
  delete rootData.id;
  const creates = [rootData];

  for (const child of containedItems) {
    const childDataRaw = getChildData(child);
    const oldParentId = getItemContainerParentId(childDataRaw);
    const newParentId = idMap.get(oldParentId);
    if (!newParentId) continue;
    const childId = createUniqueEmbeddedItemId(targetActor, reservedIds);
    const childData = foundry.utils.deepClone(childDataRaw);
    childData._id = childId;
    delete childData.id;
    foundry.utils.mergeObject(childData, {
      system: {
        equipped: false,
        container: {
          parentId: newParentId
        }
      }
    });
    creates.push(childData);
    const oldChildId = String(getChildOldId(child, childDataRaw) ?? "");
    if (oldChildId) idMap.set(oldChildId, childId);
  }

  return { creates, rootId };
}

function createUniqueEmbeddedItemId(actor = null, reservedIds = new Set()) {
  let id = "";
  do {
    id = foundry.utils.randomID();
  } while (!id || reservedIds.has(id) || actor?.items?.has?.(id));
  reservedIds.add(id);
  return id;
}

export async function transferItemBetweenActors({
  sourceActor,
  targetActor,
  sourceItem,
  targetMode = "inventory",
  targetParentId = ROOT_CONTAINER_ID,
  targetEquipmentSlot = "",
  targetWeaponSet = "",
  targetWeaponSlot = "",
  targetX = null,
  targetY = null,
  targetItemId = "",
  quantity = 0,
  sourceStackIndex = 0,
  allowLocked = false,
  allowButchering = false,
  spendWeaponSwitchCost = true
} = {}) {
  assertSearchTransferableItem(sourceItem, { allowLocked, allowButchering });
  const itemData = sourceItem.toObject();
  const transferQuantity = getTransferItemQuantity(sourceItem, quantity);
  foundry.utils.setProperty(itemData, "system.quantity", transferQuantity);
  const targetItem = targetItemId ? targetActor.items?.get(targetItemId) : null;
  const targetStackPlacement = isInventoryContextPlacementMode(targetMode) && targetItem && areStackable(itemData, targetItem) && getItemQuantity(targetItem) < getItemMaxStack(targetItem)
    ? normalizeInventoryPlacement(targetItem.system?.placement ?? {}, targetItem, targetActor.items)
    : null;
  const preferredPlacement = getRequestedTargetPlacement({
    sourceActor,
    targetActor,
    sourceItem,
    itemData,
    targetMode,
    targetParentId,
    targetEquipmentSlot,
    targetWeaponSet,
    targetWeaponSlot,
    targetX,
    targetY,
    excludeItemId: sourceActor.uuid === targetActor.uuid ? sourceItem.id : ""
  }) ?? targetStackPlacement;
  if (!preferredPlacement) throw new Error(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));

  if (!isInventoryContextPlacementMode(preferredPlacement.mode)) {
    if (sourceActor.uuid === targetActor.uuid) return moveOwnedItemToActorPlacement(targetActor, sourceItem, preferredPlacement, { spendWeaponSwitchCost });
    if (isContainerItem(sourceItem)) return transferContainerTree({ sourceActor, targetActor, sourceItem, targetParentId: ROOT_CONTAINER_ID, preferredPlacement });
    return createExternalPlacedItem(targetActor, itemData, preferredPlacement, { sourceActor, sourceItem, sourceStackIndex, spendWeaponSwitchCost });
  }

  if (sourceActor.uuid === targetActor.uuid) {
    const moved = await moveOwnedInventoryItemInInventoryFast(targetActor, sourceItem, preferredPlacement, {
      parentId: targetParentId,
      quantity: transferQuantity,
      targetItem,
      sourceStackIndex
    });
    if (moved) return moved;
    return insertItemIntoActorInventory(targetActor, itemData, preferredPlacement, {
      sourceItem,
      targetItem,
      parentId: targetParentId,
      sourceStackIndex
    });
  }

  if (isContainerItem(sourceItem)) {
    return transferContainerTree({ sourceActor, targetActor, sourceItem, targetParentId, preferredPlacement });
  }

  return insertExternalItemIntoActorInventory(targetActor, itemData, preferredPlacement, {
    sourceActor,
    sourceItem,
    targetItem,
    parentId: targetParentId,
    sourceStackIndex
  });
}

async function moveOwnedItemToActorPlacement(actor, item, placement, { spendWeaponSwitchCost = true } = {}) {
  const placementResolution = resolveActorPlacementWithReplacements(actor, item.toObject(), placement, [item.id]);
  if (!placementResolution) throw new Error(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));
  const { placement: resolvedPlacement, conflicts } = placementResolution;
  const spendsWeaponSwitch = spendWeaponSwitchCost && resolvedPlacement.mode === "weapon";
  if (spendsWeaponSwitch && !canSpendWeaponSwitchActionPoints(actor)) return null;
  const updateData = createPlacementItemUpdate(item.id, getItemQuantity(item), ROOT_CONTAINER_ID, resolvedPlacement, item, {
    equipped: resolvedPlacement.mode === "equipment"
  });
  const replacementUpdates = createActorUnequipReplacementUpdates(actor, conflicts, [item.id]);
  if (!replacementUpdates) throwInventoryNoSpace();
  const updates = [...replacementUpdates, updateData];
  if (!validateActorProjectedInventoryState(actor, { updates })) {
    throwInventoryNoSpace();
  }
  const result = await actor.updateEmbeddedDocuments("Item", updates);
  if (spendsWeaponSwitch) await spendWeaponSwitchActionPoints(actor);
  return result;
}

async function createExternalPlacedItem(actor, itemData, placement, { sourceActor, sourceItem, sourceStackIndex = 0, spendWeaponSwitchCost = true } = {}) {
  const placementResolution = resolveActorPlacementWithReplacements(actor, itemData, placement);
  if (!placementResolution) throw new Error(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));
  const { placement: resolvedPlacement, conflicts } = placementResolution;
  const spendsWeaponSwitch = spendWeaponSwitchCost && resolvedPlacement.mode === "weapon";
  if (spendsWeaponSwitch && !canSpendWeaponSwitchActionPoints(actor)) return null;
  const createData = createInventoryStackData(itemData, getItemQuantity(itemData), ROOT_CONTAINER_ID, resolvedPlacement, {
    equipped: resolvedPlacement.mode === "equipment"
  });
  const replacementUpdates = createActorUnequipReplacementUpdates(actor, conflicts);
  if (!replacementUpdates) throwInventoryNoSpace();
  if (!validateActorProjectedInventoryState(actor, { updates: replacementUpdates, creates: [createData] })) {
    throwInventoryNoSpace();
  }
  if (replacementUpdates.length) await actor.updateEmbeddedDocuments("Item", replacementUpdates);
  const created = await actor.createEmbeddedDocuments("Item", [createData]);
  if (usesVirtualInventoryStacks(sourceItem)) await removeTransferredVirtualStackQuantity(sourceActor, sourceItem, getItemQuantity(itemData), sourceStackIndex);
  else await removeTransferredItemQuantity(sourceActor, sourceItem, getItemQuantity(itemData));
  if (spendsWeaponSwitch) await spendWeaponSwitchActionPoints(actor);
  return created;
}

async function insertItemIntoActorInventory(actor, itemData, requestedPlacement, {
  sourceItem = null,
  targetItem = null,
  parentId = ROOT_CONTAINER_ID,
  sourceStackIndex = 0,
  skipProjectedValidation = false
} = {}) {
  if (usesVirtualInventoryStacks(itemData)) {
    return insertVirtualStackItemIntoActorInventory(actor, itemData, requestedPlacement, {
      sourceItem,
      targetItem,
      parentId,
      sourceStackIndex
    });
  }

  const maxStack = getItemMaxStack(itemData);
  const transferQuantity = Math.max(1, getItemQuantity(itemData));
  const sourceOriginalQuantity = sourceItem ? Math.max(1, getItemQuantity(sourceItem)) : 0;
  const partialSourceTransfer = Boolean(sourceItem && transferQuantity < sourceOriginalQuantity);
  let remainingQuantity = transferQuantity;
  const excludedIds = [sourceItem?.id ?? ""].filter(Boolean);
  const preferredPlacement = normalizeInventoryPlacement(requestedPlacement, itemData, actor.items);
  const usableTargetItem = targetItem && areStackable(itemData, targetItem) ? targetItem : null;
  const stackTargets = getCompatibleStackTarget(actor, itemData, usableTargetItem, excludedIds, parentId);
  const targetUpdates = [];
  const displacementUpdates = [];
  const addDisplacementUpdates = placement => {
    const updates = getPlacementDisplacementUpdates(actor, itemData, placement, parentId, excludedIds);
    if (!updates) throwInventoryNoSpace();
    for (const update of updates) {
      if (!displacementUpdates.some(existing => existing._id === update._id)) displacementUpdates.push(update);
    }
  };

  for (const stackTarget of stackTargets) {
    const availableSpace = Math.max(0, getItemMaxStack(stackTarget) - getItemQuantity(stackTarget));
    const transferredQuantity = Math.min(remainingQuantity, availableSpace);
    if (!transferredQuantity) continue;
    targetUpdates.push({
      _id: stackTarget.id,
      "system.quantity": getItemQuantity(stackTarget) + transferredQuantity
    });
    remainingQuantity -= transferredQuantity;
    if (!remainingQuantity) break;
  }

  const reservedPlacements = [];
  const createData = [];
  let sourceUpdate = null;
  let deleteSource = Boolean(sourceItem);

  if (sourceItem && !partialSourceTransfer && remainingQuantity > 0) {
    const sourcePlacement = getSourcePlacement(actor, sourceItem, itemData, usableTargetItem ? null : preferredPlacement, usableTargetItem, parentId, reservedPlacements);
    if (!sourcePlacement) throwInventoryNoSpace();
    const sourceQuantity = Math.min(remainingQuantity, maxStack);
    remainingQuantity -= sourceQuantity;
    reservedPlacements.push(sourcePlacement);
    addDisplacementUpdates(sourcePlacement);
    sourceUpdate = createInventoryItemUpdate(sourceItem.id, sourceQuantity, parentId, sourcePlacement, sourceItem);
    deleteSource = false;
  }

  let nextPlacement = isActorInventoryPlacementAvailable(actor, parentId, preferredPlacement, excludedIds, reservedPlacements, { allowLockedDisplacement: true })
    ? preferredPlacement
    : null;
  while (remainingQuantity > 0) {
    const stackQuantity = Math.min(remainingQuantity, maxStack);
    const placement = nextPlacement ?? getFirstAvailableActorInventoryPlacement(actor, parentId, itemData, excludedIds, reservedPlacements, { allowLockedDisplacement: true });
    if (!placement) throwInventoryNoSpace();
    createData.push(createInventoryStackData(itemData, stackQuantity, parentId, placement));
    reservedPlacements.push(placement);
    addDisplacementUpdates(placement);
    remainingQuantity -= stackQuantity;
    nextPlacement = null;
  }

  const updates = mergeItemUpdates(
    targetUpdates,
    displacementUpdates,
    sourceUpdate ? [sourceUpdate] : [],
    partialSourceTransfer ? [{ _id: sourceItem.id, "system.quantity": sourceOriginalQuantity - transferQuantity }] : []
  );
  const deletes = (!partialSourceTransfer && !sourceUpdate && deleteSource && sourceItem) ? [sourceItem.id] : [];

  if (!skipProjectedValidation && !validateActorProjectedInventoryState(actor, {
    updates,
    deletes,
    creates: createData
  })) {
    throwInventoryNoSpace();
  }

  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
  if (deletes.length) await actor.deleteEmbeddedDocuments("Item", deletes);
  if (createData.length) return actor.createEmbeddedDocuments("Item", createData);
  return null;
}

async function insertVirtualStackItemIntoActorInventory(actor, itemData, requestedPlacement, {
  sourceActor = null,
  sourceItem = null,
  targetItem = null,
  parentId = ROOT_CONTAINER_ID,
  sourceStackIndex = 0
} = {}) {
  const quantity = Math.max(1, getItemQuantity(itemData));
  const preferredPlacement = createContextInventoryPlacement(
    normalizeInventoryPlacement(requestedPlacement, itemData, actor.items),
    parentId
  );
  const excludedIds = [sourceActor?.uuid === actor.uuid || sourceItem?.parent === actor ? sourceItem?.id ?? "" : ""].filter(Boolean);
  const target = getCompatibleVirtualStackTarget(actor, itemData, targetItem, excludedIds, parentId);
  const dimensions = getActorInventoryContextDimensions(actor, parentId);
  const stackParts = createAnchoredItemStackPartsForQuantity({
    itemData,
    quantity,
    preferredPlacement,
    contextItems: getContextInventoryItems(parentId, actor.items),
    columns: dimensions.columns,
    rows: dimensions.rows,
    allItems: actor.items,
    excludeItemIds: excludedIds,
    options: getActorInventoryContextOptions(actor, parentId)
  });
  if (!stackParts) throwInventoryNoSpace();
  const targetUpdates = [];
  const createData = [];

  if (target) {
    const additionUpdate = createItemStackPartAdditionUpdate(target, quantity, null, stackParts);
    if (additionUpdate) targetUpdates.push(additionUpdate);
  } else {
    const createDataEntry = createInventoryStackData(itemData, quantity, parentId, preferredPlacement);
    foundry.utils.setProperty(createDataEntry, "system.stackParts", stackParts);
    const primaryPart = stackParts[0] ?? null;
    if (primaryPart) {
      foundry.utils.setProperty(createDataEntry, "system.placement.x", primaryPart.x);
      foundry.utils.setProperty(createDataEntry, "system.placement.y", primaryPart.y);
      foundry.utils.setProperty(createDataEntry, "system.placement.rotated", Boolean(primaryPart.rotated));
    }
    createData.push(createDataEntry);
  }

  const sourceUpdates = [];
  const sourceDeletes = [];
  const sourceOwner = sourceActor ?? sourceItem?.parent ?? null;
  if (sourceItem && sourceOwner?.uuid === actor.uuid) {
    const removalUpdate = createItemStackPartRemovalUpdate(sourceItem, quantity, sourceStackIndex);
    if ((removalUpdate?.["system.quantity"] ?? getItemQuantity(sourceItem)) <= 0) sourceDeletes.push(sourceItem.id);
    else if (removalUpdate) sourceUpdates.push(removalUpdate);
  }

  if (sourceOwner?.uuid === actor.uuid) {
    const updates = mergeItemUpdates(targetUpdates, sourceUpdates);
    if (!validateActorProjectedInventoryState(actor, { updates, deletes: sourceDeletes, creates: createData })) throwInventoryNoSpace();
    if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
    if (sourceDeletes.length) await actor.deleteEmbeddedDocuments("Item", sourceDeletes);
    if (createData.length) return actor.createEmbeddedDocuments("Item", createData);
    return target ? actor.items.get(target.id) ?? null : null;
  }

  if (!validateActorProjectedInventoryState(actor, { updates: targetUpdates, creates: createData })) throwInventoryNoSpace();
  if (targetUpdates.length) await actor.updateEmbeddedDocuments("Item", targetUpdates);
  if (createData.length) await actor.createEmbeddedDocuments("Item", createData);
  if (sourceOwner && sourceItem) await removeTransferredVirtualStackQuantity(sourceOwner, sourceItem, quantity, sourceStackIndex);
  return target ? actor.items.get(target.id) ?? null : null;
}

async function moveOwnedInventoryItemInInventoryFast(actor, sourceItem, requestedPlacement, {
  parentId = ROOT_CONTAINER_ID,
  quantity = 0,
  targetItem = null,
  sourceStackIndex = 0
} = {}) {
  if (!actor || !sourceItem || targetItem) return null;
  if (!isInventoryContextPlacementMode(requestedPlacement?.mode)) return null;
  if (isItemInButcheringStorage(sourceItem)) return null;

  const sourceQuantity = Math.max(1, getItemQuantity(sourceItem));
  if (usesVirtualInventoryStacks(sourceItem)) {
    const storedParentId = getStoredInventoryParentId(parentId);
    const placementMode = getInventoryPlacementModeForParent(parentId);
    if (
      getItemContainerParentId(sourceItem) !== storedParentId
      || sourceItem.system?.placement?.mode !== placementMode
    ) return null;
    const placement = createContextInventoryPlacement(
      normalizeInventoryPlacement(requestedPlacement, sourceItem, actor.items),
      parentId
    );
    const updateData = createItemStackPartPlacementUpdate(sourceItem, sourceStackIndex, placement);
    if (!updateData) return null;
    if (!validateActorProjectedInventoryState(actor, { updates: [updateData] })) throwInventoryNoSpace();
    await actor.updateEmbeddedDocuments("Item", [updateData], { render: false });
    return actor.items.get(sourceItem.id) ?? sourceItem;
  }

  if (Math.max(1, toInteger(quantity) || sourceQuantity) !== sourceQuantity) return null;

  const itemData = sourceItem.toObject();
  if (isContainerItem(sourceItem)) {
    if (String(parentId ?? ROOT_CONTAINER_ID) === sourceItem.id) return null;
    if (getAllContainedItems(sourceItem.id, actor.items).some(item => item.id === String(parentId ?? ROOT_CONTAINER_ID))) return null;
  }

  const placement = createContextInventoryPlacement(
    normalizeInventoryPlacement(requestedPlacement, itemData, actor.items),
    parentId
  );
  if (!isActorInventoryPlacementAvailable(actor, parentId, placement, [sourceItem.id], [], { allowLockedDisplacement: false })) return null;
  if (!canFitItemWeightInActorParent(actor, sourceItem, parentId, [], [sourceItem.id])) return null;

  const updateData = createInventoryItemUpdate(sourceItem.id, sourceQuantity, parentId, placement, sourceItem);
  await actor.updateEmbeddedDocuments("Item", [updateData], { render: false });
  return actor.items.get(sourceItem.id) ?? sourceItem;
}

async function insertExternalItemIntoActorInventory(actor, itemData, requestedPlacement, {
  sourceActor,
  sourceItem,
  targetItem = null,
  parentId = ROOT_CONTAINER_ID,
  sourceStackIndex = 0
} = {}) {
  if (usesVirtualInventoryStacks(itemData)) {
    return insertVirtualStackItemIntoActorInventory(actor, itemData, requestedPlacement, {
      sourceActor,
      sourceItem,
      targetItem,
      parentId,
      sourceStackIndex
    });
  }

  const maxStack = getItemMaxStack(itemData);
  let remainingQuantity = Math.max(1, getItemQuantity(itemData));
  const usableTargetItem = targetItem && areStackable(itemData, targetItem) ? targetItem : null;
  const stackTargets = getCompatibleStackTarget(actor, itemData, usableTargetItem, [], parentId);
  const targetUpdates = [];
  const displacementUpdates = [];
  const addDisplacementUpdates = placement => {
    const updates = getPlacementDisplacementUpdates(actor, itemData, placement, parentId, []);
    if (!updates) throwInventoryNoSpace();
    for (const update of updates) {
      if (!displacementUpdates.some(existing => existing._id === update._id)) displacementUpdates.push(update);
    }
  };

  for (const stackTarget of stackTargets) {
    const availableSpace = Math.max(0, getItemMaxStack(stackTarget) - getItemQuantity(stackTarget));
    const transferredQuantity = Math.min(remainingQuantity, availableSpace);
    if (!transferredQuantity) continue;
    targetUpdates.push({
      _id: stackTarget.id,
      "system.quantity": getItemQuantity(stackTarget) + transferredQuantity
    });
    remainingQuantity -= transferredQuantity;
    if (!remainingQuantity) break;
  }

  const reservedPlacements = [];
  const createData = [];
  let nextPlacement = usableTargetItem ? null : requestedPlacement;
  while (remainingQuantity > 0) {
    const stackQuantity = Math.min(remainingQuantity, maxStack);
    const placement = nextPlacement && isActorInventoryPlacementAvailable(actor, parentId, nextPlacement, [], reservedPlacements, { allowLockedDisplacement: true })
      ? nextPlacement
      : getFirstAvailableActorInventoryPlacement(actor, parentId, itemData, [], reservedPlacements, { allowLockedDisplacement: true });
    if (!placement) throwInventoryNoSpace();
    createData.push(createInventoryStackData(itemData, stackQuantity, parentId, placement));
    reservedPlacements.push(placement);
    addDisplacementUpdates(placement);
    remainingQuantity -= stackQuantity;
    nextPlacement = null;
  }

  const updates = mergeItemUpdates(targetUpdates, displacementUpdates);

  if (!validateActorProjectedInventoryState(actor, { updates, creates: createData })) {
    throwInventoryNoSpace();
  }

  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
  if (createData.length) await actor.createEmbeddedDocuments("Item", createData);
  await removeTransferredItemQuantity(sourceActor, sourceItem, getItemQuantity(itemData));
  return null;
}

async function transferContainerTree({ sourceActor, targetActor, sourceItem, targetParentId, preferredPlacement } = {}) {
  if (preferredPlacement.mode === "inventory" && !isActorInventoryPlacementAvailable(targetActor, targetParentId, preferredPlacement, [], [], { allowLockedDisplacement: true })) {
    throw new Error(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));
  }
  if (preferredPlacement.mode === "inventory" && targetParentId) {
    const targetContainer = targetActor.items?.get(targetParentId);
    const projectedLoad = getContainerContentsWeight(targetContainer, targetActor.items) + getItemTotalWeight(sourceItem, sourceActor.items);
    if (projectedLoad > getContainerMaxLoad(targetContainer)) throw new Error(game.i18n.localize("FALLOUTMAW.Messages.ContainerMaxLoadExceeded"));
  }

  const rootData = sourceItem.toObject();
  const replacementUpdates = preferredPlacement.mode === "inventory"
    ? []
    : createActorUnequipReplacementUpdates(
      targetActor,
      getActorPlacementConflictingItems(targetActor, rootData, preferredPlacement)
    );
  if (!replacementUpdates) throwInventoryNoSpace();
  const spendsWeaponSwitch = preferredPlacement.mode === "weapon";
  if (spendsWeaponSwitch && !canSpendWeaponSwitchActionPoints(targetActor)) return null;
  const createData = createInventoryStackData(rootData, 1, targetParentId, preferredPlacement, {
    equipped: preferredPlacement.mode === "equipment"
  });
  const displacementUpdates = preferredPlacement.mode === "inventory"
    ? getPlacementDisplacementUpdates(targetActor, rootData, preferredPlacement, targetParentId, [])
    : [];
  if (!displacementUpdates) throwInventoryNoSpace();
  const containedItems = getAllContainedItems(sourceItem.id, sourceActor.items);
  const validationCreates = buildContainerTreeValidationCreates(createData, sourceItem, containedItems);
  if (!validateActorProjectedInventoryState(targetActor, { updates: [...replacementUpdates, ...displacementUpdates], creates: validationCreates })) {
    throwInventoryNoSpace();
  }

  const targetUpdates = mergeItemUpdates(replacementUpdates, displacementUpdates);
  const treeCreateData = buildContainerTreeCreateData({
    targetActor,
    rootCreateData: createData,
    rootOldId: sourceItem.id,
    containedItems,
    getChildData: child => child.toObject(),
    getChildOldId: child => child.id
  });

  if (targetUpdates.length) await targetActor.updateEmbeddedDocuments("Item", targetUpdates);
  const createdItems = await targetActor.createEmbeddedDocuments("Item", treeCreateData.creates, { keepId: true });
  const createdRoot = createdItems.find(item => item.id === treeCreateData.rootId) ?? createdItems.at(0) ?? null;

  await sourceActor.deleteEmbeddedDocuments("Item", [sourceItem.id, ...containedItems.map(item => item.id)]);
  if (spendsWeaponSwitch) await spendWeaponSwitchActionPoints(targetActor);
  return createdRoot;
}

function buildContainerTreeValidationCreates(rootCreateData, sourceItem, containedItems = []) {
  const rootSyntheticId = "synthetic-container-root";
  const syntheticIdMap = new Map([[sourceItem.id, rootSyntheticId]]);
  const creates = [{
    ...foundry.utils.deepClone(rootCreateData),
    _id: rootSyntheticId,
    id: rootSyntheticId
  }];

  let index = 0;
  for (const child of containedItems) {
    const oldParentId = getItemContainerParentId(child);
    const newParentId = syntheticIdMap.get(oldParentId);
    if (!newParentId) continue;
    const syntheticId = `synthetic-container-child-${index += 1}`;
    const childData = child.toObject();
    delete childData._id;
    delete childData.id;
    foundry.utils.mergeObject(childData, {
      _id: syntheticId,
      id: syntheticId,
      system: {
        equipped: false,
        container: {
          parentId: newParentId
        }
      }
    });
    creates.push(childData);
    syntheticIdMap.set(child.id, syntheticId);
  }

  return creates;
}

function findCompatibleStackTargets(actor, itemData, preferredTarget = null, excludeItemIds = [], parentId = ROOT_CONTAINER_ID) {
  const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
  const targets = [];
  const canUsePreferredTarget = preferredTarget
    && !excluded.has(preferredTarget.id)
    && getItemContainerParentId(preferredTarget) === parentId
    && areStackable(itemData, preferredTarget)
    && getItemQuantity(preferredTarget) < getItemMaxStack(preferredTarget);
  if (canUsePreferredTarget) targets.push(preferredTarget);

  for (const item of getContextInventoryItems(parentId, actor.items)) {
    if (!item || excluded.has(item.id) || targets.some(target => target.id === item.id)) continue;
    if (!canMaybeStackItems(itemData, item)) continue;
    if (!areStackable(itemData, item) || getItemQuantity(item) >= getItemMaxStack(item)) continue;
    targets.push(item);
  }
  return targets;
}

function getCompatibleStackTarget(actor, itemData, preferredTarget = null, excludeItemIds = [], parentId = ROOT_CONTAINER_ID) {
  const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
  const storedParentId = getStoredInventoryParentId(parentId);
  const placementMode = getInventoryPlacementModeForParent(parentId);
  const canUsePreferredTarget = preferredTarget
    && !excluded.has(preferredTarget.id)
    && getItemContainerParentId(preferredTarget) === storedParentId
    && preferredTarget.system?.placement?.mode === placementMode
    && areStackable(itemData, preferredTarget)
    && getItemQuantity(preferredTarget) < getItemMaxStack(preferredTarget);
  return canUsePreferredTarget ? [preferredTarget] : [];
}

function getCompatibleVirtualStackTarget(actor, itemData, preferredTarget = null, excludeItemIds = [], parentId = ROOT_CONTAINER_ID) {
  const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
  const storedParentId = getStoredInventoryParentId(parentId);
  const placementMode = getInventoryPlacementModeForParent(parentId);
  const candidates = [];
  if (preferredTarget) candidates.push(preferredTarget);
  candidates.push(...getContextInventoryItems(parentId, actor.items));
  return candidates.find(candidate => (
    candidate
    && !excluded.has(candidate.id)
    && usesVirtualInventoryStacks(candidate)
    && getItemContainerParentId(candidate) === storedParentId
    && candidate.system?.placement?.mode === placementMode
    && areStackable(itemData, candidate)
  )) ?? null;
}

function getSourcePlacement(actor, sourceItem, itemData, preferredPlacement = null, targetItem = null, parentId = ROOT_CONTAINER_ID, reservedPlacements = []) {
  const excludedIds = [sourceItem.id, targetItem?.id ?? ""].filter(Boolean);
  const storedParentId = getStoredInventoryParentId(parentId);
  const placementMode = getInventoryPlacementModeForParent(parentId);
  const currentPlacement = (
    sourceItem.system?.placement?.mode === placementMode
    && getItemContainerParentId(sourceItem) === storedParentId
  )
    ? normalizeInventoryPlacement(sourceItem.system?.placement ?? {}, itemData, actor.items)
    : null;

  if (targetItem && currentPlacement && isActorInventoryPlacementAvailable(actor, parentId, currentPlacement, excludedIds, reservedPlacements, { allowLockedDisplacement: true })) return currentPlacement;
  if (preferredPlacement && isActorInventoryPlacementAvailable(actor, parentId, preferredPlacement, excludedIds, reservedPlacements, { allowLockedDisplacement: true })) return preferredPlacement;
  if (currentPlacement && isActorInventoryPlacementAvailable(actor, parentId, currentPlacement, excludedIds, reservedPlacements, { allowLockedDisplacement: true })) return currentPlacement;
  const placement = getFirstAvailableActorInventoryPlacement(actor, parentId, itemData, excludedIds, reservedPlacements, { allowLockedDisplacement: true });
  return placement ? createContextInventoryPlacement(placement, parentId) : null;
}

function getRequestedTargetPlacement({
  sourceActor,
  targetActor,
  sourceItem = null,
  itemData,
  targetMode = "inventory",
  targetParentId,
  targetEquipmentSlot = "",
  targetWeaponSet = "",
  targetWeaponSlot = "",
  targetX,
  targetY,
  excludeItemId = ""
} = {}) {
  const excluded = excludeItemId ? [excludeItemId] : [];
  if (targetMode === "equipment") {
    return resolveActorPlacement(targetActor, itemData, {
      mode: "equipment",
      equipmentSlot: targetEquipmentSlot,
      weaponSet: "",
      weaponSlot: "",
      x: 1,
      y: 1
    }, excluded, [], ROOT_CONTAINER_ID, { allowReplacement: true });
  }
  if (targetMode === "weapon") {
    return resolveActorPlacement(targetActor, itemData, {
      mode: "weapon",
      equipmentSlot: "",
      weaponSet: targetWeaponSet,
      weaponSlot: targetWeaponSlot,
      x: 1,
      y: 1
    }, excluded, [], ROOT_CONTAINER_ID, { allowReplacement: true });
  }

  if (Number.isFinite(Number(targetX)) && Number.isFinite(Number(targetY))) {
    const placement = createInventoryPlacement(toInteger(targetX), toInteger(targetY), itemData, targetActor.items);
    if (isContainerItem(itemData) && sourceActor) {
      const footprint = getItemFootprint(sourceItem ?? itemData, sourceActor.items);
      placement.width = footprint.width;
      placement.height = footprint.height;
    }
    const contextPlacement = createContextInventoryPlacement(placement, targetParentId);
    if (isActorInventoryPlacementAvailable(targetActor, targetParentId, contextPlacement, excluded, [], { allowLockedDisplacement: true })) return contextPlacement;
  }
  const placement = getFirstAvailableActorInventoryPlacement(targetActor, targetParentId, itemData, excluded, [], { allowLockedDisplacement: true });
  return placement ? createContextInventoryPlacement(placement, targetParentId) : null;
}

export function getSearchDropPlacementForPointer({
  actor,
  itemData,
  sourceActor,
  sourceItemId = "",
  parentId = ROOT_CONTAINER_ID,
  event = null,
  zone = null,
  findNearest = true
} = {}) {
  if (!actor || !itemData) return null;
  const grid = zone?.closest?.("[data-inventory-grid]");
  const pointer = getSearchInventoryGridPointerPosition(event, grid, actor, parentId);
  const fallbackCellX = toInteger(zone?.dataset?.x);
  const fallbackCellY = toInteger(zone?.dataset?.y);
  const anchor = pointer ?? {
    x: fallbackCellX,
    y: fallbackCellY
  };
  if (!anchor.x || !anchor.y) return null;

  const dimensions = getActorInventoryContextDimensions(actor, parentId);
  const excludeItemIds = sourceActor?.uuid === actor.uuid && sourceItemId ? [sourceItemId] : [];
  const sourceItem = sourceItemId ? sourceActor?.items?.get(sourceItemId) ?? null : null;
  const contextOptions = getActorInventoryContextOptions(actor, parentId);
  const contextItems = getContextInventoryItems(parentId, actor.items)
    .filter(item => contextOptions.allowLockedDisplacement && !isLockedStorageParentId(parentId) ? !isItemLocked(item) : true);
  const isPlacementAvailable = createInventoryHoverPlacementChecker(
    contextItems,
    dimensions.columns,
    dimensions.rows,
    actor.items,
    excludeItemIds,
    contextOptions,
    parentId
  );
  const result = resolveInventoryPointerPlacement({
    anchor,
    itemData,
    items: actor.items,
    dimensions,
    options: contextOptions,
    sourceItem,
    findNearest,
    isPlacementAvailable
  });
  return result;
}

export function getSearchInventoryGridPointerPosition(event = null, grid = null, actor = null, parentId = ROOT_CONTAINER_ID) {
  if (!grid || !actor) return null;
  return getInventoryGridPointerPositionFromElement(event, grid, {
    allowOverflowRows: getActorInventoryContextOptions(actor, parentId).allowOverflowRows,
    clamp: true
  });
}

export function resolveActorPlacement(
  actor,
  itemData,
  placement = {},
  excludeItemIds = [],
  reservedPlacements = [],
  parentId = ROOT_CONTAINER_ID,
  options = {}
) {
  if (placement.mode === "equipment") return resolveActorEquipmentPlacement(actor, itemData, placement, excludeItemIds, options);
  if (placement.mode === "weapon") return resolveActorWeaponPlacement(actor, itemData, placement, excludeItemIds, options);

  const normalizedPlacement = normalizeInventoryPlacement(placement, itemData, actor.items);
  return isActorInventoryPlacementAvailable(actor, parentId, normalizedPlacement, excludeItemIds, reservedPlacements)
    ? normalizedPlacement
    : null;
}

function resolveActorPlacementWithReplacements(actor, itemData, placement = {}, excludeItemIds = []) {
  const resolvedPlacement = resolveActorPlacement(actor, itemData, placement, excludeItemIds, [], ROOT_CONTAINER_ID, {
    allowReplacement: true
  });
  if (!resolvedPlacement) return null;
  return {
    placement: resolvedPlacement,
    conflicts: getActorPlacementConflictingItems(actor, itemData, resolvedPlacement, excludeItemIds)
  };
}

function resolveActorEquipmentPlacement(actor, itemData, placement = {}, excludeItemIds = [], { allowReplacement = false } = {}) {
  const race = getActorRace(actor);
  const selectedSlots = getRaceEquipmentSlotsForItem(race, itemData);
  const targetSlot = placement.equipmentSlot
    ? selectedSlots.find(slot => slot.key === placement.equipmentSlot)
    : selectedSlots[0];
  if (!targetSlot) return null;

  const requiredSlots = getRequiredEquipmentSlotsForItem(race, itemData, targetSlot.key);
  if (!requiredSlots.length) return null;
  const blocked = requiredSlots.some(slot => Boolean(getEquipmentItemForActorSlot(actor, slot, excludeItemIds)));
  if (blocked && !allowReplacement) return null;

  const footprint = getItemFootprint(itemData);
  return {
    ...placement,
    mode: "equipment",
    equipmentSlot: targetSlot.key,
    weaponSet: "",
    weaponSlot: "",
    width: footprint.width,
    height: footprint.height
  };
}

function resolveActorWeaponPlacement(actor, itemData, placement = {}, excludeItemIds = [], { allowReplacement = false } = {}) {
  const requiredSlotKeys = getActorWeaponPlacementSlotKeys(actor, itemData, placement);
  if (!requiredSlotKeys.length) return null;

  const blocked = requiredSlotKeys.some(slotKey => Boolean(getWeaponItemForActorSlot(
    actor,
    placement.weaponSet,
    slotKey,
    excludeItemIds
  )));
  if (blocked && !allowReplacement) return null;

  const footprint = getItemFootprint(itemData);
  return {
    ...placement,
    mode: "weapon",
    equipmentSlot: "",
    width: footprint.width,
    height: footprint.height
  };
}

function getActorWeaponPlacementSlotKeys(actor, itemData, placement = {}) {
  const race = getActorRace(actor);
  const setKey = String(placement.weaponSet ?? "");
  const primarySlotKey = String(placement.weaponSlot ?? "");
  if (!setKey || !primarySlotKey) return [];
  const requirement = getWeaponSlotRequirement(itemData);
  if (!requirement.selectedKeys.size) return [];

  if (isContainerWeaponSetKey(setKey)) {
    const inventory = prepareInventoryContext(actor, race);
    const set = (inventory.weaponSets ?? []).find(entry => entry.key === setKey);
    const slots = set?.slots ?? [];
    const primaryIndex = slots.findIndex(slot => slot.key === primarySlotKey);
    if (primaryIndex < 0) return [];
    const size = getWeaponSlotRequirementSize(itemData, race);
    const requiredSlots = slots.slice(primaryIndex, primaryIndex + size);
    return requiredSlots.length === size ? requiredSlots.map(slot => slot.key) : [];
  }

  if (!canUseWeaponSlotForItem(race, itemData, setKey, primarySlotKey)) return [];
  return getRequiredWeaponSlotsForItem(race, itemData, setKey, primarySlotKey).map(slot => slot.key);
}

function getQuickTransferTargetParentId({ sourceActor, targetActor, sourceItem } = {}) {
  if (!sourceActor || !targetActor || !sourceItem) return null;
  const candidateParentIds = getQuickTransferParentCandidates(targetActor);
  for (const parentId of candidateParentIds) {
    if (!canQuickTransferItemIntoParent({ sourceActor, targetActor, sourceItem, parentId })) continue;
    return parentId;
  }
  return null;
}

function getCompletedTradeClaimTarget(targetActor, itemData = null, containedItems = [], { quantity = 0 } = {}) {
  if (!targetActor || !itemData) return null;
  const transferQuantity = Math.max(1, toInteger(quantity) || getItemQuantity(itemData));
  const candidateParentIds = getActorInventoryPlacementParentCandidates(targetActor, itemData, []);

  for (const parentId of candidateParentIds) {
    if (!canCompletedTradeClaimFitParent(targetActor, itemData, containedItems, parentId, { quantity: transferQuantity })) continue;

    if (!isContainerItem(itemData) && getCompletedTradeClaimStackRoom(targetActor, itemData, parentId) >= transferQuantity) {
      return { parentId, placement: null };
    }

    const placement = getFirstAvailableActorInventoryPlacement(targetActor, parentId, itemData, [], [], { allowLockedDisplacement: true });
    if (!placement) continue;

    const needsFullValidation = isContainerItem(itemData) || (containedItems?.length > 0);
    if (needsFullValidation && !validateCompletedTradeClaimTarget(targetActor, itemData, containedItems, parentId, placement, { quantity: transferQuantity })) continue;
    return { parentId, placement };
  }

  return null;
}

function getCompletedTradeClaimStackRoom(targetActor, itemData = null, parentId = ROOT_CONTAINER_ID) {
  if (isContainerItem(itemData)) return 0;
  return findCompatibleStackTargets(targetActor, itemData, null, [], parentId).reduce((total, target) => (
    total + Math.max(0, getItemMaxStack(target) - getItemQuantity(target))
  ), 0);
}

function canCompletedTradeClaimFitParent(targetActor, itemData = null, containedItems = [], parentId = ROOT_CONTAINER_ID, { quantity = 0 } = {}) {
  if (!parentId) return true;
  const container = targetActor.items?.get(parentId);
  if (!container) return false;
  const quantityData = foundry.utils.deepClone(itemData);
  foundry.utils.setProperty(quantityData, "system.quantity", Math.max(1, toInteger(quantity) || getItemQuantity(itemData)));
  const currentLoad = getContainerContentsWeight(container, targetActor.items);
  const addedLoad = getCompletedTradeClaimItemWeight(quantityData, containedItems);
  return currentLoad + addedLoad <= getContainerMaxLoad(container) + 0.0001;
}

function getCompletedTradeClaimItemWeight(itemData = null, containedItems = []) {
  const ownWeight = Math.max(1, getItemQuantity(itemData)) * (Math.max(0, Number(itemData?.system?.weight) || 0));
  if (!isContainerItem(itemData)) return ownWeight;
  const rootId = String(itemData?._id ?? itemData?.id ?? "");
  const contentsWeight = containedItems
    .filter(contained => getItemContainerParentId(contained) === rootId)
    .reduce((total, contained) => total + getItemTotalWeight(contained, containedItems), 0);
  return ownWeight + contentsWeight;
}

function validateCompletedTradeClaimTarget(targetActor, itemData = null, containedItems = [], parentId = ROOT_CONTAINER_ID, placement = null, { quantity = 0 } = {}) {
  if (!placement) return false;
  const quantityData = foundry.utils.deepClone(itemData);
  foundry.utils.setProperty(quantityData, "system.quantity", Math.max(1, toInteger(quantity) || getItemQuantity(itemData)));
  const createData = createInventoryStackData(quantityData, getItemQuantity(quantityData), parentId, placement);
  const creates = isContainerItem(quantityData)
    ? buildCompletedContainerTreeValidationCreates(createData, quantityData, containedItems)
    : [createData];
  try {
    return validateActorProjectedInventoryState(targetActor, { creates });
  } catch (_error) {
    return false;
  }
}

function getQuickTransferParentCandidates(actor) {
  const parentIds = [ROOT_CONTAINER_ID];
  const inventory = prepareInventoryContext(actor, getActorRace(actor), { includeLocked: false });
  for (const container of inventory.containers ?? []) {
    const id = String(container?.id ?? "");
    if (!id || parentIds.includes(id)) continue;
    parentIds.push(id);
  }
  return parentIds;
}

function getBulkTransferSourceItemIds(actor) {
  const items = (actor?.items?.contents ?? []).filter(item => isSearchTransferableItem(item, { allowButchering: true }));
  const itemMap = new Map(items.map(item => [item.id, item]));
  const selectedIds = new Set(items.map(item => item.id));
  return items
    .filter(item => !hasBulkTransferSelectedAncestor(item, itemMap, selectedIds))
    .map(item => item.id);
}

function isSearchTransferableItem(item, { allowLocked = false, allowButchering = false } = {}) {
  return Boolean(
    item
    && item.type !== "trauma"
    && item.type !== "disease"
    && !isNaturalRaceItem(item)
    && (allowLocked || !isItemLocked(item))
    && (allowButchering || !isItemInButcheringStorage(item))
  );
}

function assertSearchTransferableItem(item, { allowLocked = false, allowButchering = false } = {}) {
  if (!isSearchTransferableItem(item, { allowLocked, allowButchering })) {
    throw new Error("This item cannot be moved through search or trade.");
  }
}

function hasBulkTransferSelectedAncestor(item, itemMap, selectedIds) {
  const visited = new Set();
  let parentId = getItemContainerParentId(item);
  while (parentId) {
    if (selectedIds.has(parentId)) return true;
    if (visited.has(parentId)) return false;
    visited.add(parentId);
    parentId = getItemContainerParentId(itemMap.get(parentId));
  }
  return false;
}

function getActorPlacementConflictingItems(actor, itemData, placement = {}, excludeItemIds = []) {
  if (placement.mode === "equipment") return getActorEquipmentConflictingItems(actor, itemData, placement, excludeItemIds);
  if (placement.mode === "weapon") return getActorWeaponConflictingItems(actor, itemData, placement, excludeItemIds);
  return [];
}

function getActorEquipmentConflictingItems(actor, itemData, placement = {}, excludeItemIds = []) {
  const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
  const race = getActorRace(actor);
  const targetSlots = getRequiredEquipmentSlotsForItem(race, itemData, placement.equipmentSlot);
  if (!targetSlots.length) return [];

  return actor.items?.contents?.filter(item => {
    if (excluded.has(item.id)) return false;
    if (item.system?.placement?.mode !== "equipment") return false;
    return targetSlots.some(slot => doesItemOccupyEquipmentSlot(item, slot));
  }) ?? [];
}

function getActorWeaponConflictingItems(actor, itemData, placement = {}, excludeItemIds = []) {
  const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
  const conflicts = new Map();
  for (const slotKey of getActorWeaponPlacementSlotKeys(actor, itemData, placement)) {
    const item = getWeaponItemForActorSlot(actor, placement.weaponSet, slotKey, excludeItemIds);
    if (!item || excluded.has(item.id)) continue;
    conflicts.set(item.id, item);
  }
  return Array.from(conflicts.values());
}

function createActorUnequipReplacementUpdates(actor, items = [], excludeItemIds = []) {
  const conflicts = Array.from(new Map(items.filter(Boolean).map(item => [item.id, item])).values());
  if (!conflicts.length) return [];

  const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
  for (const item of conflicts) excluded.add(item.id);

  const reservedPlacementContexts = [];
  const updates = [];
  for (const item of conflicts) {
    if (isItemLocked(item)) {
      updates.push(createLockedStorageItemUpdate(item));
      continue;
    }
    const placementContext = getFirstAvailableActorInventoryPlacementContext(actor, item, Array.from(excluded), reservedPlacementContexts);
    if (!placementContext) return null;
    reservedPlacementContexts.push({ ...placementContext, itemData: item });
    updates.push(createActorInventoryPlacementUpdate(item, placementContext));
  }
  return updates;
}

function getFirstAvailableActorInventoryPlacementContext(actor, itemData = null, excludeItemIds = [], reservedPlacementContexts = []) {
  for (const parentId of getActorInventoryPlacementParentCandidates(actor, itemData, excludeItemIds)) {
    const reservedPlacements = reservedPlacementContexts
      .filter(entry => String(entry?.parentId ?? ROOT_CONTAINER_ID) === String(parentId ?? ROOT_CONTAINER_ID))
      .map(entry => entry.placement);
    if (!canFitItemWeightInActorParent(actor, itemData, parentId, reservedPlacementContexts, excludeItemIds)) continue;
    const placement = getFirstAvailableActorInventoryPlacement(actor, parentId, itemData, excludeItemIds, reservedPlacements);
    if (placement) return { parentId, placement };
  }
  return null;
}

function getActorInventoryPlacementParentCandidates(actor, itemData = null, excludeItemIds = []) {
  const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
  const candidates = [ROOT_CONTAINER_ID];
  const inventory = prepareInventoryContext(actor, getActorRace(actor), { includeLocked: false });
  for (const container of inventory.containers ?? []) {
    const parentId = String(container?.id ?? "");
    if (!parentId || excluded.has(parentId)) continue;
    if (hasContainerCycle(itemData, parentId, actor.items)) continue;
    candidates.push(parentId);
  }
  return candidates;
}

function canFitItemWeightInActorParent(actor, itemData = null, parentId = ROOT_CONTAINER_ID, reservedPlacementContexts = [], excludeItemIds = []) {
  if (!parentId) return true;
  const container = actor.items?.get(parentId);
  if (!container) return false;
  const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
  const releasedLoad = actor.items.contents
    .filter(item => excluded.has(item.id) && String(item.system?.container?.parentId ?? ROOT_CONTAINER_ID) === String(parentId))
    .reduce((total, item) => total + getItemTotalWeight(item, actor.items), 0);
  const currentLoad = Math.max(0, getContainerContentsWeight(container, actor.items) - releasedLoad);
  const reservedLoad = reservedPlacementContexts
    .filter(entry => String(entry?.parentId ?? ROOT_CONTAINER_ID) === parentId)
    .reduce((total, entry) => total + getItemTotalWeight(entry.itemData, actor.items), 0);
  return currentLoad + reservedLoad + getItemTotalWeight(itemData, actor.items) <= getContainerMaxLoad(container) + 0.0001;
}

function createActorInventoryPlacementUpdate(item, placementContext = {}) {
  return createPlacementItemUpdate(
    item.id,
    getItemQuantity(item),
    String(placementContext.parentId ?? ROOT_CONTAINER_ID),
    placementContext.placement,
    item,
    { equipped: false }
  );
}

function canQuickTransferItemIntoParent({ sourceActor, targetActor, sourceItem, parentId = ROOT_CONTAINER_ID } = {}) {
  const itemData = sourceItem?.toObject?.();
  if (!itemData) return false;
  if (parentId && !targetActor.items?.get(parentId)) return false;

  if (sourceActor.uuid === targetActor.uuid) {
    if (parentId === sourceItem.id) return false;
    if (getAllContainedItems(sourceItem.id, sourceActor.items).some(item => item.id === parentId)) return false;
  }

  const excludeItemIds = sourceActor.uuid === targetActor.uuid ? [sourceItem.id] : [];
  const stackRoom = isContainerItem(itemData)
    ? 0
    : findCompatibleStackTargets(targetActor, itemData, null, excludeItemIds, parentId).reduce((total, target) => (
      total + Math.max(0, getItemMaxStack(target) - getItemQuantity(target))
    ), 0);
  const quantity = Math.max(1, getItemQuantity(sourceItem));
  const placement = getFirstAvailableActorInventoryPlacement(targetActor, parentId, itemData, excludeItemIds, [], { allowLockedDisplacement: true });
  if (!placement && stackRoom < quantity) return false;

  if (!parentId) return true;
  const container = targetActor.items?.get(parentId);
  const currentLoad = getContainerContentsWeight(container, targetActor.items);
  const addedLoad = getItemTotalWeight(sourceItem, sourceActor.items);
  return currentLoad + addedLoad <= getContainerMaxLoad(container) + 0.0001;
}

function getEquipmentItemForActorSlot(actor, slot, excludeItemIds = []) {
  const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
  return actor.items?.contents?.find(item => {
    if (excluded.has(item.id)) return false;
    if (item.system?.placement?.mode !== "equipment") return false;
    return doesItemOccupyEquipmentSlot(item, slot);
  }) ?? null;
}

function getWeaponItemForActorSlot(actor, setKey = "", slotKey = "", excludeItemIds = []) {
  const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
  const inventory = prepareInventoryContext(actor, getActorRace(actor));
  const set = (inventory.weaponSets ?? []).find(entry => entry.key === setKey);
  const slot = (set?.slots ?? []).find(entry => entry.key === slotKey);
  const itemId = String(slot?.item?.id ?? "");
  return itemId && !excluded.has(itemId) ? actor.items?.get(itemId) ?? null : null;
}

function getActorRace(actor) {
  return getCreatureOptions().races.find(entry => entry.id === actor?.system?.creature?.raceId) ?? null;
}

function isLockedStorageParentId(parentId = ROOT_CONTAINER_ID) {
  return String(parentId ?? ROOT_CONTAINER_ID) === LOCKED_STORAGE_PARENT_ID;
}

function getStoredInventoryParentId(parentId = ROOT_CONTAINER_ID) {
  return isLockedStorageParentId(parentId) ? ROOT_CONTAINER_ID : parentId;
}

function getInventoryPlacementModeForParent(parentId = ROOT_CONTAINER_ID) {
  return isLockedStorageParentId(parentId) ? LOCKED_STORAGE_PLACEMENT_MODE : "inventory";
}

function createContextInventoryPlacement(placement = {}, parentId = ROOT_CONTAINER_ID) {
  return {
    ...placement,
    mode: getInventoryPlacementModeForParent(parentId),
    equipmentSlot: "",
    weaponSet: "",
    weaponSlot: "",
    limbKey: ""
  };
}

function isInventoryContextPlacementMode(mode = "") {
  return mode === "inventory" || mode === LOCKED_STORAGE_PLACEMENT_MODE;
}

function getActorInventoryContextOptions(actor, parentId = ROOT_CONTAINER_ID) {
  if (isLockedStorageParentId(parentId)) {
    return {
      allowOverflowRows: true,
      extraRows: INFINITE_ROOT_INVENTORY_EMPTY_ROWS,
      placementMode: LOCKED_STORAGE_PLACEMENT_MODE,
      preferredPlacementModes: [LOCKED_STORAGE_PLACEMENT_MODE]
    };
  }
  return getActorRootInventoryGridOptions(actor, parentId);
}

function createInventoryStackData(itemData, quantity, parentId, placement, { equipped = false } = {}) {
  const createData = foundry.utils.deepClone(itemData);
  delete createData._id;
  delete createData.id;
  const placementForStorage = (placement?.mode === "inventory" || placement?.mode === LOCKED_STORAGE_PLACEMENT_MODE)
    ? createContextInventoryPlacement(placement, parentId)
    : placement;
  const storedPlacement = createStoredPlacement(placementForStorage, itemData);
  foundry.utils.mergeObject(createData, {
    system: {
      quantity,
      equipped: Boolean(equipped),
      ...(isLockedStorageParentId(parentId) ? { locked: true } : {}),
      container: {
        parentId: getStoredInventoryParentId(parentId)
      },
      placement: {
        mode: storedPlacement.mode,
        equipmentSlot: storedPlacement.equipmentSlot,
        weaponSet: storedPlacement.weaponSet,
        weaponSlot: storedPlacement.weaponSlot,
        limbKey: storedPlacement.limbKey,
        constructPartOrder: storedPlacement.constructPartOrder,
        x: storedPlacement.x,
        y: storedPlacement.y,
        width: storedPlacement.width,
        height: storedPlacement.height,
        rotated: storedPlacement.rotated
      }
    }
  });
  return createData;
}

export async function copyActorInventoryItem(actor, item, { allowLocked = false } = {}) {
  assertSearchTransferableItem(item, { allowLocked });
  const data = item.toObject();
  delete data._id;
  delete data.id;
  const parentId = item.system?.placement?.mode === LOCKED_STORAGE_PLACEMENT_MODE
    ? LOCKED_STORAGE_PARENT_ID
    : getItemContainerParentId(item);
  const placement = getFirstAvailableActorInventoryPlacement(actor, parentId, data, [], []);
  if (!placement) throwInventoryNoSpace();
  foundry.utils.setProperty(data, "system.container.parentId", getStoredInventoryParentId(parentId));
  foundry.utils.setProperty(data, "system.placement", createStoredPlacement(createContextInventoryPlacement(placement, parentId), data));
  if (!validateActorProjectedInventoryState(actor, { creates: [data] })) throwInventoryNoSpace();
  return actor.createEmbeddedDocuments("Item", [data]);
}

export async function splitActorInventoryItem(actor, item, amount, { allowLocked = false } = {}) {
  assertSearchTransferableItem(item, { allowLocked });
  const quantity = getItemQuantity(item);
  const splitQuantity = Math.max(1, Math.min(quantity - 1, toInteger(amount)));
  if (quantity <= 1 || !splitQuantity) throw new Error("No quantity to split.");

  const data = item.toObject();
  delete data._id;
  delete data.id;
  foundry.utils.setProperty(data, "system.quantity", splitQuantity);
  const parentId = item.system?.placement?.mode === LOCKED_STORAGE_PLACEMENT_MODE
    ? LOCKED_STORAGE_PARENT_ID
    : getItemContainerParentId(item);
  const placement = getFirstAvailableActorInventoryPlacement(actor, parentId, data, [], []);
  if (!placement) throwInventoryNoSpace();
  foundry.utils.setProperty(data, "system.container.parentId", getStoredInventoryParentId(parentId));
  foundry.utils.setProperty(data, "system.placement", createStoredPlacement(createContextInventoryPlacement(placement, parentId), data));
  const updateData = {
    _id: item.id,
    "system.quantity": quantity - splitQuantity
  };
  if (!validateActorProjectedInventoryState(actor, { updates: [updateData], creates: [data] })) throwInventoryNoSpace();
  await actor.updateEmbeddedDocuments("Item", [updateData]);
  return actor.createEmbeddedDocuments("Item", [data]);
}

export async function stackActorInventoryItem({
  sourceActor,
  targetActor,
  sourceItem,
  targetItem,
  targetParentId = ROOT_CONTAINER_ID,
  quantity = 0,
  sourceStackIndex = 0,
  targetStackIndex = null
} = {}) {
  assertSearchTransferableItem(sourceItem, { allowButchering: isItemInButcheringStorage(sourceItem) });
  assertSearchTransferableItem(targetItem);
  if (!canStackItems(sourceItem?.toObject?.(), targetItem)) throw new Error("Items cannot be stacked.");
  if (usesVirtualInventoryStacks(sourceItem) && sourceActor.uuid === targetActor.uuid && sourceItem.id === targetItem.id) {
    const updateData = createItemStackPartMergeUpdate(sourceItem, sourceStackIndex, targetStackIndex, quantity);
    if (!updateData) throw new Error("No stack room.");
    if (!validateActorProjectedInventoryState(targetActor, { updates: [updateData] })) throwInventoryNoSpace();
    await targetActor.updateEmbeddedDocuments("Item", [updateData]);
    return targetActor.items.get(targetItem.id) ?? null;
  }
  if (getItemContainerParentId(targetItem) !== targetParentId) throw new Error("Invalid stack target.");

  const sourceQuantity = Math.max(1, getItemQuantity(sourceItem));
  const targetQuantity = getItemQuantity(targetItem);
  const virtualTarget = usesVirtualInventoryStacks(targetItem);
  const virtualSource = usesVirtualInventoryStacks(sourceItem);
  const availableSpace = virtualTarget
    ? Math.max(0, getItemMaxStack(targetItem) - getItemStackPartQuantity(targetItem, targetStackIndex))
    : Math.max(0, getItemMaxStack(targetItem) - targetQuantity);
  const appliedQuantity = Math.min(Math.max(1, toInteger(quantity)), sourceQuantity, availableSpace);
  if (!appliedQuantity) throw new Error("No stack room.");

  const targetUpdate = virtualTarget
    ? createItemStackPartAdditionUpdate(targetItem, appliedQuantity, targetStackIndex)
    : {
        _id: targetItem.id,
        "system.quantity": targetQuantity + appliedQuantity
      };
  if (!targetUpdate) throwInventoryNoSpace();

  if (sourceActor.uuid === targetActor.uuid) {
    const updates = [targetUpdate];
    const deletes = [];
    if (appliedQuantity >= sourceQuantity) deletes.push(sourceItem.id);
    else if (virtualSource) updates.push(createItemStackPartRemovalUpdate(sourceItem, appliedQuantity, sourceStackIndex));
    else {
      updates.push({
        _id: sourceItem.id,
        "system.quantity": sourceQuantity - appliedQuantity
      });
    }
    if (!validateActorProjectedInventoryState(targetActor, { updates, deletes })) throwInventoryNoSpace();
    await targetActor.updateEmbeddedDocuments("Item", updates);
    if (deletes.length) await targetActor.deleteEmbeddedDocuments("Item", deletes);
    return targetActor.items.get(targetItem.id) ?? null;
  }

  if (!validateActorProjectedInventoryState(targetActor, { updates: [targetUpdate] })) throwInventoryNoSpace();
  await targetActor.updateEmbeddedDocuments("Item", [targetUpdate]);
  if (virtualSource) await removeTransferredVirtualStackQuantity(sourceActor, sourceItem, appliedQuantity, sourceStackIndex);
  else if (appliedQuantity >= sourceQuantity) await sourceActor.deleteEmbeddedDocuments("Item", [sourceItem.id]);
  else await sourceActor.updateEmbeddedDocuments("Item", [{
    _id: sourceItem.id,
    "system.quantity": sourceQuantity - appliedQuantity
  }]);
  return targetActor.items.get(targetItem.id) ?? null;
}

export function canStackItems(sourceData, targetItem = null) {
  return Boolean(
    targetItem
    && !isNaturalRaceItem(sourceData)
    && !isNaturalRaceItem(targetItem)
    && areStackable(sourceData, targetItem)
    && (usesVirtualInventoryStacks(targetItem) || getItemQuantity(targetItem) < getItemMaxStack(targetItem))
  );
}

export async function promptSearchItemStackQuantity({ item, title = "Количество", actionLabel = "Ок", max = 1, value = 1, trade = null } = {}) {
  const limit = Math.max(1, toInteger(max));
  const initial = Math.max(1, Math.min(limit, toInteger(value) || limit));
  const sellerActor = trade?.sellerActor;
  const barterAdjustmentPercent = trade?.barterAdjustmentPercent;
  const currencyKey = String(trade?.currencyKey ?? "");
  const currency = getCurrencySettings().find(entry => entry.key === normalizeTradeCurrencyKey(currencyKey));
  const hasTradePrice = Boolean(trade && currencyKey && sellerActor);
  const tradePriceContent = hasTradePrice
    ? `<p class="fallout-maw-trade-quantity-price" data-trade-quantity-price><span>Итого</span><strong data-trade-quantity-total>${calculateItemTradePrice(item, currencyKey, initial, { sellerActor, barterAdjustmentPercent })} ${escapeHTML(currency?.label ?? currencyKey)}</strong></p>`
    : "";
  const formData = await DialogV2.input({
    window: { title },
    content: `
      <p><strong>${escapeHTML(item?.name ?? "")}</strong></p>
      <label class="fallout-maw-stacked-field">
        <span>${game.i18n.localize("FALLOUTMAW.Item.Quantity")}: 1 / ${limit}</span>
        <input type="number" name="quantity" value="${initial}" min="1" max="${limit}" step="1" autofocus>
      </label>
      ${tradePriceContent}
    `,
    render: (_event, dialog) => {
      if (!hasTradePrice) return;
      const input = dialog.element?.querySelector("input[name='quantity']");
      const total = dialog.element?.querySelector("[data-trade-quantity-total]");
      if (!input || !total) return;
      const updateTotal = () => {
        const quantity = Math.max(1, Math.min(limit, toInteger(input.value)));
        total.textContent = `${calculateItemTradePrice(item, currencyKey, quantity, { sellerActor, barterAdjustmentPercent })} ${currency?.label ?? currencyKey}`;
      };
      input.addEventListener("input", updateTotal);
      input.addEventListener("change", updateTotal);
      updateTotal();
    },
    ok: {
      label: actionLabel,
      icon: "fa-solid fa-check",
      callback: (_event, button) => new FormDataExtended(button.form).object
    },
    buttons: [{
      action: "cancel",
      label: game.i18n.localize("FALLOUTMAW.Common.Cancel")
    }],
    position: { width: 420 },
    rejectClose: false
  });
  if (!formData || formData === "cancel") return 0;
  return Math.max(1, Math.min(limit, toInteger(formData.quantity)));
}

function getInventoryGridItemElementAtPointer(event = null, root = null) {
  const direct = event?.target?.closest?.("[data-inventory-grid-item][data-item-id]");
  if (direct && (!root || root.contains(direct))) return direct;
  const clientX = Number(event?.clientX);
  const clientY = Number(event?.clientY);
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  const pointed = document.elementFromPoint(clientX, clientY)?.closest?.("[data-inventory-grid-item][data-item-id]") ?? null;
  return pointed && (!root || root.contains(pointed)) ? pointed : null;
}

function createInventoryItemUpdate(itemId, quantity, parentId, placement, itemData) {
  return createPlacementItemUpdate(itemId, quantity, parentId, placement, itemData, { equipped: false });
}

function mergeItemUpdates(...groups) {
  const updates = new Map();
  for (const group of groups) {
    for (const update of group ?? []) {
      const id = String(update?._id ?? "");
      if (!id) continue;
      updates.set(id, {
        ...(updates.get(id) ?? {}),
        ...update,
        _id: id
      });
    }
  }
  return Array.from(updates.values());
}

function createPlacementItemUpdate(itemId, quantity, parentId, placement, itemData, { equipped = false } = {}) {
  const placementForStorage = (placement?.mode === "inventory" || placement?.mode === LOCKED_STORAGE_PLACEMENT_MODE)
    ? createContextInventoryPlacement(placement, parentId)
    : placement;
  const storedPlacement = createStoredPlacement(placementForStorage, itemData);
  return {
    _id: itemId,
    "system.quantity": quantity,
    "system.equipped": Boolean(equipped),
    ...(isLockedStorageParentId(parentId) ? { "system.locked": true } : {}),
    "system.container.parentId": getStoredInventoryParentId(parentId),
    "system.placement.mode": storedPlacement.mode,
    "system.placement.equipmentSlot": storedPlacement.equipmentSlot,
    "system.placement.weaponSet": storedPlacement.weaponSet,
    "system.placement.weaponSlot": storedPlacement.weaponSlot,
    "system.placement.limbKey": storedPlacement.limbKey,
    "system.placement.constructPartOrder": storedPlacement.constructPartOrder,
    "system.placement.x": storedPlacement.x,
    "system.placement.y": storedPlacement.y,
    "system.placement.width": storedPlacement.width,
    "system.placement.height": storedPlacement.height,
    "system.placement.rotated": storedPlacement.rotated
  };
}

function createLockedStorageItemUpdate(item) {
  const storedPlacement = createStoredPlacement({
    mode: LOCKED_STORAGE_PLACEMENT_MODE,
    equipmentSlot: "",
    weaponSet: "",
    weaponSlot: "",
    limbKey: "",
    x: 1,
    y: 1
  }, item);
  return {
    _id: item.id,
    "system.equipped": false,
    "system.container.parentId": ROOT_CONTAINER_ID,
    "system.placement.mode": storedPlacement.mode,
    "system.placement.equipmentSlot": "",
    "system.placement.weaponSet": "",
    "system.placement.weaponSlot": "",
    "system.placement.limbKey": "",
    "system.placement.constructPartOrder": storedPlacement.constructPartOrder,
    "system.placement.x": storedPlacement.x,
    "system.placement.y": storedPlacement.y,
    "system.placement.width": storedPlacement.width,
    "system.placement.height": storedPlacement.height,
    "system.placement.rotated": storedPlacement.rotated
  };
}

function getLockedInventoryDisplacementUpdates(actor, parentId, placement, excludeItemIds = []) {
  if (!actor || !placement || placement.mode !== "inventory") return [];
  const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
  const conflicts = getContextInventoryItems(parentId, actor.items).filter(item => {
    if (!item || excluded.has(item.id)) return false;
    const itemPlacement = normalizeInventoryPlacement(item.system?.placement ?? {}, item, actor.items);
    return inventoryPlacementsOverlap(placement, itemPlacement);
  });
  if (!conflicts.length) return [];
  if (conflicts.some(item => !isItemLocked(item))) return null;
  return conflicts.map(createLockedStorageItemUpdate);
}

function getPlacementDisplacementUpdates(actor, itemData, placement, parentId = ROOT_CONTAINER_ID, excludeItemIds = []) {
  if (!placement) return [];
  if (placement.mode === "inventory") return getLockedInventoryDisplacementUpdates(actor, parentId, placement, excludeItemIds);
  if (placement.mode === LOCKED_STORAGE_PLACEMENT_MODE) return [];
  const conflicts = getActorPlacementConflictingItems(actor, itemData, placement, excludeItemIds);
  if (!conflicts.length) return [];
  if (conflicts.some(item => !isItemLocked(item))) return [];
  return conflicts.map(createLockedStorageItemUpdate);
}

export function getFirstAvailableActorInventoryPlacement(actor, parentId, itemData, excludeItemIds = [], reservedPlacements = [], { allowLockedDisplacement = false } = {}) {
  const dimensions = getActorInventoryContextDimensions(actor, parentId);
  const contextItems = getContextInventoryItems(parentId, actor.items)
    .filter(item => allowLockedDisplacement && !isLockedStorageParentId(parentId) ? !isItemLocked(item) : true);
  const placement = findFirstAvailableResolvedInventoryPlacement(
    contextItems,
    dimensions.columns,
    dimensions.rows,
    itemData,
    actor.items,
    excludeItemIds,
    reservedPlacements,
    getActorInventoryContextOptions(actor, parentId)
  );
  return placement;
}

function isActorInventoryPlacementAvailable(actor, parentId, placement, excludeItemIds = [], reservedPlacements = [], { allowLockedDisplacement = false } = {}) {
  const dimensions = getActorInventoryContextDimensions(actor, parentId);
  const contextItems = getContextInventoryItems(parentId, actor.items)
    .filter(item => allowLockedDisplacement && !isLockedStorageParentId(parentId) ? !isItemLocked(item) : true);
  return isInventoryPlacementAvailable(
    placement,
    contextItems,
    dimensions.columns,
    dimensions.rows,
    actor.items,
    excludeItemIds,
    reservedPlacements,
    getActorInventoryContextOptions(actor, parentId)
  );
}

function getActorInventoryContextDimensions(actor, parentId = ROOT_CONTAINER_ID) {
  if (isLockedStorageParentId(parentId)) {
    const race = getCreatureOptions().races.find(entry => entry.id === actor.system?.creature?.raceId);
    return getActorInventoryGridDimensions(actor, race);
  }
  if (parentId) return getContainerDimensions(actor.items?.get(parentId));
  const race = getCreatureOptions().races.find(entry => entry.id === actor.system?.creature?.raceId);
  return getActorInventoryGridDimensions(actor, race);
}

function validateTargetParent(actor, parentId = ROOT_CONTAINER_ID) {
  if (!parentId) return;
  const parent = actor.items?.get(parentId);
  if (!parent || !isContainerItem(parent)) throw new Error("Invalid target container.");
}

function validateActorProjectedInventoryState(actor, { updates = [], deletes = [], creates = [] } = {}) {
  const projectedItems = projectActorInventoryState(actor, { updates, deletes, creates });
  const validation = validateInventoryTree(projectedItems, getActorInventoryContextDimensions(actor, ROOT_CONTAINER_ID), {
    rootOptions: getActorRootInventoryGridOptions(actor, ROOT_CONTAINER_ID)
  });
  if (validation.valid) {
    const loadValidation = validateActorLoadLimit(actor, projectedItems);
    if (loadValidation.valid) return true;
    throw new Error(getActorLoadLimitExceededMessage());
  }
  if (validation.reason === "recursive") throw new Error(game.i18n.localize("FALLOUTMAW.Messages.ContainerRecursiveError"));
  if (validation.reason === "max-load") throw new Error(game.i18n.localize("FALLOUTMAW.Messages.ContainerMaxLoadExceeded"));
  return false;
}

function projectActorInventoryState(actor, { updates = [], deletes = [], creates = [] } = {}) {
  const itemMap = new Map(actor.items.contents.map(item => [item.id, item.toObject()]));

  for (const update of updates) {
    if (!update?._id || !itemMap.has(update._id)) continue;
    const nextData = foundry.utils.deepClone(itemMap.get(update._id));
    for (const [key, value] of Object.entries(update)) {
      if (key === "_id") continue;
      foundry.utils.setProperty(nextData, key, value);
    }
    itemMap.set(update._id, nextData);
  }

  for (const deleteId of deletes) itemMap.delete(deleteId);

  let syntheticIndex = 0;
  for (const createData of creates) {
    const syntheticId = String(createData?._id ?? `synthetic-${syntheticIndex += 1}`);
    const nextData = foundry.utils.deepClone(createData);
    nextData._id = syntheticId;
    nextData.id = syntheticId;
    itemMap.set(syntheticId, nextData);
  }

  return Array.from(itemMap.values());
}

function areStackable(sourceData, targetItem) {
  const sourceSystem = sourceData?.system ?? {};
  const targetSystem = targetItem?.system ?? {};
  const creatureOptions = getCreatureOptions();
  return (
    sourceData?.type === targetItem?.type
    && !isContainerItem(sourceData)
    && !isContainerItem(targetItem)
    && sourceData?.name === targetItem?.name
    && sourceData?.img === targetItem?.img
    && isItemLocked(sourceData) === isItemLocked(targetItem)
    && Number(sourceSystem.weight) === Number(targetSystem.weight)
    && Number(sourceSystem.price) === Number(targetSystem.price)
    && String(sourceSystem.priceCurrency ?? "") === String(targetSystem.priceCurrency ?? "")
    && getItemMaxStack(sourceSystem) === getItemMaxStack(targetSystem)
    && getItemFootprint(sourceSystem).width === getItemFootprint(targetSystem).width
    && getItemFootprint(sourceSystem).height === getItemFootprint(targetSystem).height
    && serializeSet(getValidSelectedEquipmentSlotKeysForOptions(creatureOptions, sourceSystem)) === serializeSet(getValidSelectedEquipmentSlotKeysForOptions(creatureOptions, targetSystem))
    && serializeWeaponSlotRequirement(sourceSystem, creatureOptions) === serializeWeaponSlotRequirement(targetSystem, creatureOptions)
    && serializeItemFunctions(sourceSystem.functions) === serializeItemFunctions(targetSystem.functions)
  );
}

function canMaybeStackItems(sourceData, targetItem) {
  if (!sourceData || !targetItem) return false;
  if (sourceData?.type !== targetItem?.type) return false;
  if (isContainerItem(sourceData) || isContainerItem(targetItem)) return false;
  if (sourceData?.name !== targetItem?.name) return false;
  if (sourceData?.img !== targetItem?.img) return false;
  if (isItemLocked(sourceData) !== isItemLocked(targetItem)) return false;
  if (getItemQuantity(targetItem) >= getItemMaxStack(targetItem)) return false;

  const sourceSystem = sourceData?.system ?? {};
  const targetSystem = targetItem?.system ?? {};
  if (Number(sourceSystem.weight) !== Number(targetSystem.weight)) return false;
  if (Number(sourceSystem.price) !== Number(targetSystem.price)) return false;
  if (String(sourceSystem.priceCurrency ?? "") !== String(targetSystem.priceCurrency ?? "")) return false;
  if (getItemMaxStack(sourceSystem) !== getItemMaxStack(targetSystem)) return false;

  const sourceFootprint = getItemFootprint(sourceSystem);
  const targetFootprint = getItemFootprint(targetSystem);
  return sourceFootprint.width === targetFootprint.width && sourceFootprint.height === targetFootprint.height;
}

function serializeSet(set) {
  return Array.from(set).sort().join("|");
}

function serializeWeaponSlotRequirement(system = {}, creatureOptions = getCreatureOptions()) {
  const requirement = getWeaponSlotRequirement(system);
  return `${requirement.mode}:${serializeSet(getValidSelectedWeaponSlotKeysForOptions(creatureOptions, system))}`;
}

function serializeItemFunctions(functions = {}) {
  return JSON.stringify(normalizeItemFunctionsForStack(functions));
}

function normalizeItemFunctionsForStack(functions = {}) {
  return normalizeStackComparableValue(functions);
}

function normalizeStackComparableValue(value) {
  if (typeof value?.toObject === "function") return normalizeStackComparableValue(value.toObject(false));
  if (value instanceof Set) return Array.from(value).sort();
  if (Array.isArray(value)) return value.map(entry => normalizeStackComparableValue(entry));
  if (!value || typeof value !== "object") return value ?? null;

  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  return Object.fromEntries(entries.map(([key, entryValue]) => [key, normalizeStackComparableValue(entryValue)]));
}

function validateActorLoadLimit(actor, projectedItems = []) {
  const limit = getActorLoadLimit(actor);
  if (limit <= 0) return { valid: true };

  const currentLoad = Number(actor?.system?.load?.value) || calculateActorLoad(actor?.items?.contents ?? []);
  const projectedLoad = calculateActorLoad(projectedItems);
  if (projectedLoad <= (limit + 0.0001)) return { valid: true };
  if (projectedLoad <= (currentLoad + 0.0001)) return { valid: true };
  return { valid: false, reason: "actor-load-limit", value: projectedLoad, limit };
}

function getActorLoadLimit(actor) {
  const max = Number(actor?.system?.load?.max) || 0;
  const percent = Math.max(0, Number(actor?.system?.load?.limitPercent) || 0);
  if (max > 0 && percent > 0) return (max * percent) / 100;
  return Number(actor?.system?.load?.limit) || 0;
}

function calculateActorLoad(items = []) {
  const itemList = Array.isArray(items) ? items : Array.from(items ?? []);
  return Number(itemList.reduce((total, item) => (
    getItemContainerParentId(item)
      ? total
      : total + (Number(getItemActorLoadWeight(item, itemList)) || 0)
  ), 0).toFixed(1));
}

function getActorLoadLimitExceededMessage() {
  const key = "FALLOUTMAW.Messages.ActorLoadLimitExceeded";
  const localized = game.i18n.localize(key);
  return localized === key ? "Актер не может нести такой вес." : localized;
}

function throwInventoryNoSpace() {
  throw new Error(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));
}

export function getDropZoneParentId(zone) {
  return String(zone?.dataset?.inventoryParentId ?? zone?.dataset?.containerId ?? ROOT_CONTAINER_ID);
}

function setWeaponSlotImageAspect(image) {
  const width = Number(image?.naturalWidth);
  const height = Number(image?.naturalHeight);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
  const slot = image.closest(".fallout-maw-weapon-slot");
  if (!slot) return;
  slot.style.setProperty("--fallout-maw-weapon-slot-image-aspect", String(Math.max(1, width / height)));
}

export function getDropZonePlacementRequest(zone) {
  if (zone?.dataset?.equipmentSlot) {
    return {
      mode: "equipment",
      equipmentSlot: String(zone.dataset.equipmentSlot ?? ""),
      weaponSet: "",
      weaponSlot: ""
    };
  }
  if (zone?.dataset?.weaponSet && zone?.dataset?.weaponSlot) {
    return {
      mode: "weapon",
      equipmentSlot: "",
      weaponSet: String(zone.dataset.weaponSet ?? ""),
      weaponSlot: String(zone.dataset.weaponSlot ?? "")
    };
  }
  return {
    mode: getInventoryPlacementModeForParent(getDropZoneParentId(zone)),
    equipmentSlot: "",
    weaponSet: "",
    weaponSlot: ""
  };
}

function canModifySearchTransferDirectly(sourceActor, targetActor) {
  return Boolean(game.user?.isGM || (
    sourceActor?.testUserPermission?.(game.user, "OWNER")
    && targetActor?.testUserPermission?.(game.user, "OWNER")
  ));
}

async function enqueueSearchInventoryOperation(operation) {
  const key = "global";
  const previous = searchInventoryOperationQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => null).then(operation);
  searchInventoryOperationQueues.set(key, current);

  try {
    return await current;
  } finally {
    if (searchInventoryOperationQueues.get(key) === current) {
      searchInventoryOperationQueues.delete(key);
    }
  }
}

async function requestSearchInventorySocket(action, payload = {}, gm = getResponsibleGM()) {
  if (!gm && isTradePayload(payload)) throw new Error("Нет активного GM для торговли.");
  if (!gm) throw new Error("Нет активного GM для обыска.");
  const requestId = foundry.utils.randomID();
  const requesterUserId = game.user?.id ?? "";

  const promise = new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingSearchInventorySocketRequests.delete(requestId);
      reject(new Error("GM did not answer search inventory request."));
    }, SEARCH_INVENTORY_SOCKET_TIMEOUT);
    pendingSearchInventorySocketRequests.set(requestId, { resolve, reject, timeout });
  });

  game.socket.emit(SEARCH_INVENTORY_SOCKET, {
    scope: SEARCH_INVENTORY_SOCKET_SCOPE,
    type: "request",
    action,
    requestId,
    requesterUserId,
    gmUserId: gm.id,
    payload
  });
  return promise;
}

async function requestTradeSessionJoin({ traderActor = null, tradeActor = null } = {}) {
  if (!traderActor || !tradeActor) return null;
  const payload = {
    traderActorUuid: traderActor.uuid,
    tradeActorUuid: tradeActor.uuid,
    requesterUserId: game.user?.id ?? ""
  };
  try {
    return await requestTradeSessionAction("joinTradeSession", payload, { notify: false });
  } catch (_error) {
    return null;
  }
}

async function requestTradeSessionCreate(payload = {}) {
  try {
    return await requestTradeSessionAction("createTradeSession", payload, { notify: false });
  } catch (error) {
    console.error(`${SYSTEM_ID} | Trade session create failed`, error);
    return null;
  }
}

async function requestTradeSessionAction(action = "", payload = {}, { notify = true } = {}) {
  try {
    const responsibleGM = getResponsibleGM();
    if (responsibleGM && responsibleGM.id !== game.user?.id) {
      return requestSearchInventorySocket(action, payload, responsibleGM);
    }
    if (!responsibleGM && !game.user?.isGM) throw new Error("No active GM for trade.");
    return enqueueSearchInventoryOperation(() => performTradeSessionAction(action, payload, game.user?.id ?? ""));
  } catch (error) {
    console.error(`${SYSTEM_ID} | Trade session action failed`, error);
    if (notify) ui.notifications.warn(error.message || "Trade session action failed.");
    throw error;
  }
}

async function requestTradeInviteSocket(payload = {}, recipientUser = null) {
  if (!recipientUser?.active) throw new Error("Владелец актера не в сети.");
  const requestId = foundry.utils.randomID();
  const requesterUserId = game.user?.id ?? "";

  const promise = new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingSearchInventorySocketRequests.delete(requestId);
      reject(new Error("Владелец актера не ответил на торговлю."));
    }, SEARCH_INVENTORY_SOCKET_TIMEOUT);
    pendingSearchInventorySocketRequests.set(requestId, { resolve, reject, timeout });
  });

  game.socket.emit(SEARCH_INVENTORY_SOCKET, {
    scope: SEARCH_INVENTORY_SOCKET_SCOPE,
    type: "tradeInvite",
    requestId,
    requesterUserId,
    recipientUserId: recipientUser.id,
    payload
  });
  return promise;
}

async function requestPersonalTradeApproval({
  searcherActor = null,
  searchedActor = null,
  searcherTotal = 0,
  searchedTotal = 0,
  tradeCurrencyKey = ""
} = {}) {
  const recipientUser = getPrimaryActorOwnerUser(searchedActor);
  if (!recipientUser) {
    ui.notifications.warn("Нет активного владельца актера для подтверждения личной торговли.");
    return false;
  }
  const payload = {
    searcherActorUuid: searcherActor?.uuid ?? "",
    searchedActorUuid: searchedActor?.uuid ?? "",
    searcherActorName: searcherActor?.name ?? "",
    searchedActorName: searchedActor?.name ?? "",
    searcherTotal: Math.max(0, toInteger(searcherTotal)),
    searchedTotal: Math.max(0, toInteger(searchedTotal)),
    tradeCurrencyKey: normalizeTradeCurrencyKey(tradeCurrencyKey),
    requesterUserId: game.user?.id ?? "",
    recipientUserId: recipientUser.id
  };
  if (recipientUser.id === game.user?.id) return confirmPersonalTradeApproval(payload);
  try {
    const response = await requestPersonalTradeApprovalSocket(payload, recipientUser);
    return Boolean(response?.accepted);
  } catch (error) {
    ui.notifications.warn(error.message || "Личная торговля не подтверждена.");
    return false;
  }
}

async function requestPersonalTradeApprovalSocket(payload = {}, recipientUser = null) {
  if (!recipientUser?.active) throw new Error("Владелец актера не в сети.");
  const requestId = foundry.utils.randomID();
  const requesterUserId = game.user?.id ?? "";

  const promise = new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingSearchInventorySocketRequests.delete(requestId);
      reject(new Error("Владелец актера не ответил на личную торговлю."));
    }, SEARCH_INVENTORY_SOCKET_TIMEOUT);
    pendingSearchInventorySocketRequests.set(requestId, { resolve, reject, timeout });
  });

  game.socket.emit(SEARCH_INVENTORY_SOCKET, {
    scope: SEARCH_INVENTORY_SOCKET_SCOPE,
    type: "personalTradeApproval",
    requestId,
    requesterUserId,
    recipientUserId: recipientUser.id,
    payload
  });
  return promise;
}

function broadcastTradeSessionClose(sessionId = "") {
  if (!sessionId) return;
  game.socket.emit(SEARCH_INVENTORY_SOCKET, {
    scope: SEARCH_INVENTORY_SOCKET_SCOPE,
    type: "tradeClose",
    sessionId,
    senderUserId: game.user?.id ?? ""
  });
}

function broadcastTradeCurrencyChange(sessionId = "", currencyKey = "") {
  if (!sessionId || !currencyKey) return;
  game.socket.emit(SEARCH_INVENTORY_SOCKET, {
    scope: SEARCH_INVENTORY_SOCKET_SCOPE,
    type: "tradeCurrency",
    sessionId,
    currencyKey,
    senderUserId: game.user?.id ?? ""
  });
}

function broadcastTradeOffersState(sessionId = "", state = {}) {
  if (!sessionId) return;
  game.socket.emit(SEARCH_INVENTORY_SOCKET, {
    scope: SEARCH_INVENTORY_SOCKET_SCOPE,
    type: "tradeOffers",
    sessionId,
    state: normalizeTradeOffersState(state),
    senderUserId: game.user?.id ?? ""
  });
}

function applyLocalCompletedTradeOffers(sessionId = "", state = {}) {
  if (!searchInventoryWindow?.matchesTradeSession?.(sessionId)) return;
  searchInventoryWindow.applyCompletedTradeOffersState(state);
}

function applyLocalTradeCompletionLock(sessionId = "", locked = false, { render = true } = {}) {
  if (!searchInventoryWindow?.matchesTradeSession?.(sessionId)) return;
  if (locked) searchInventoryWindow.beginTradeCompletionLock();
  else searchInventoryWindow.endTradeCompletionLock({ render });
}

function broadcastTradeCompletionLock(sessionId = "", locked = false, { render = true } = {}) {
  if (!sessionId) return;
  applyLocalTradeCompletionLock(sessionId, locked, { render });
  game.socket.emit(SEARCH_INVENTORY_SOCKET, {
    scope: SEARCH_INVENTORY_SOCKET_SCOPE,
    type: "tradeCompletionLock",
    sessionId,
    locked: Boolean(locked),
    render,
    senderUserId: game.user?.id ?? ""
  });
}

async function handleSearchInventorySocketMessage(message = {}) {
  if (message?.scope !== SEARCH_INVENTORY_SOCKET_SCOPE) return;

  if (message.type === "response") {
    if (message.recipientUserId && message.recipientUserId !== game.user?.id) return;
    const pending = pendingSearchInventorySocketRequests.get(message.requestId);
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    pendingSearchInventorySocketRequests.delete(message.requestId);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error || "Search inventory socket request failed."));
    return;
  }

  if (message.type === "tradeInviteResponse") {
    if (message.recipientUserId && message.recipientUserId !== game.user?.id) return;
    const pending = pendingSearchInventorySocketRequests.get(message.requestId);
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    pendingSearchInventorySocketRequests.delete(message.requestId);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error || "Запрос торговли отклонен."));
    return;
  }

  if (message.type === "personalTradeApprovalResponse") {
    if (message.recipientUserId && message.recipientUserId !== game.user?.id) return;
    const pending = pendingSearchInventorySocketRequests.get(message.requestId);
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    pendingSearchInventorySocketRequests.delete(message.requestId);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error || "Личная торговля отклонена."));
    return;
  }

  if (message.type === "tradeInvite") {
    if (message.recipientUserId !== game.user?.id) return;
    await handleTradeInviteSocketMessage(message);
    return;
  }

  if (message.type === "personalTradeApproval") {
    if (message.recipientUserId !== game.user?.id) return;
    await handlePersonalTradeApprovalSocketMessage(message);
    return;
  }

  if (message.type === "tradeClose") {
    await searchInventoryWindow?.closeTradeSessionFromSocket?.(message.sessionId);
    return;
  }

  if (message.type === "tradeCurrency") {
    if (message.senderUserId === game.user?.id) return;
    if (!searchInventoryWindow?.matchesTradeSession?.(message.sessionId)) return;
    searchInventoryWindow.setTradeCurrencyKey(message.currencyKey);
    return;
  }

  if (message.type === "tradeOffers") {
    if (message.senderUserId === game.user?.id) return;
    if (!searchInventoryWindow?.matchesTradeSession?.(message.sessionId)) return;
    if (message.state?.completed) searchInventoryWindow.applyCompletedTradeOffersState(message.state);
    else searchInventoryWindow.setTradeOffersState(message.state);
    return;
  }

  if (message.type === "tradeCompletionLock") {
    if (!searchInventoryWindow?.matchesTradeSession?.(message.sessionId)) return;
    if (message.locked) searchInventoryWindow.beginTradeCompletionLock();
    else searchInventoryWindow.endTradeCompletionLock({ render: message.render !== false });
    return;
  }

  if (message.type === "tradeSessionSnapshot") {
    if (!searchInventoryWindow?.matchesTradeSession?.(message.sessionId)) return;
    searchInventoryWindow.setTradeSessionSnapshot(message.snapshot);
    return;
  }

  if (message.type !== "request") return;
  if (!game.user?.isGM || message.gmUserId !== game.user.id) return;

  try {
    let result;
    if (message.action === "transferItem") {
      result = await enqueueSearchInventoryOperation(
        () => performSearchInventoryTransfer(message.payload ?? {}, message.requesterUserId ?? "")
      );
    } else if (message.action === "stackItem") {
      result = await enqueueSearchInventoryOperation(
        () => performSearchInventoryStack(message.payload ?? {}, message.requesterUserId ?? "")
      );
    } else if (message.action === "splitItem") {
      result = await enqueueSearchInventoryOperation(
        () => performSearchInventorySplit(message.payload ?? {}, message.requesterUserId ?? "")
      );
    } else if (message.action === "rotateItem") {
      result = await enqueueSearchInventoryOperation(
        () => performSearchInventoryRotate(message.payload ?? {}, message.requesterUserId ?? "")
      );
    } else if (message.action === "transferCurrency") {
      result = await enqueueSearchInventoryOperation(
        () => performSearchCurrencyTransfer(message.payload ?? {}, message.requesterUserId ?? "")
      );
    } else if (message.action === "butcherActor") {
      result = await enqueueSearchInventoryOperation(
        () => performActorButchering(message.payload ?? {}, message.requesterUserId ?? "")
      );
    } else if (message.action === "completeTrade") {
      const sessionId = String(message.payload?.tradeSessionId ?? "");
      broadcastTradeCompletionLock(sessionId, true);
      try {
        result = await enqueueSearchInventoryOperation(
          () => performTradeComplete(message.payload ?? {}, message.requesterUserId ?? "")
        );
      } finally {
        broadcastTradeCompletionLock(sessionId, false, { render: false });
      }
    } else if (message.action === "completePersonalTrade") {
      result = await enqueueSearchInventoryOperation(
        () => performPersonalTradeComplete(message.payload ?? {}, message.requesterUserId ?? "")
      );
    } else if ([
      "createTradeSession",
      "joinTradeSession",
      "selectTradeActor",
      "addTradeOfferItem",
      "moveTradeOfferEntry",
      "depositCompletedTradeItem",
      "addTradeOfferCurrency",
      "removeTradeOfferEntry",
      "claimCompletedTradeEntry",
      "claimCompletedTradeBatch",
      "reduceCompletedTradeEntry",
      "setTradeCurrency",
      "setTradeReady",
      "restartTrade",
      "leaveTradeSession"
    ].includes(message.action)) {
      result = await enqueueSearchInventoryOperation(
        () => performTradeSessionAction(message.action, message.payload ?? {}, message.requesterUserId ?? "")
      );
    }
    game.socket.emit(SEARCH_INVENTORY_SOCKET, {
      scope: SEARCH_INVENTORY_SOCKET_SCOPE,
      type: "response",
      requestId: message.requestId,
      recipientUserId: message.requesterUserId,
      ok: true,
      result
    });
  } catch (error) {
    console.error(`${SYSTEM_ID} | Search inventory socket request failed`, error);
    game.socket.emit(SEARCH_INVENTORY_SOCKET, {
      scope: SEARCH_INVENTORY_SOCKET_SCOPE,
      type: "response",
      requestId: message.requestId,
      recipientUserId: message.requesterUserId,
      ok: false,
      error: error.message
    });
  }
}

async function handleTradeInviteSocketMessage(message = {}) {
  const payload = message.payload ?? {};
  const inviteKey = getTradeInviteKey(payload);
  if (pendingSearchInventoryTradeInvites.has(inviteKey)) {
    game.socket.emit(SEARCH_INVENTORY_SOCKET, {
      scope: SEARCH_INVENTORY_SOCKET_SCOPE,
      type: "tradeInviteResponse",
      requestId: message.requestId,
      recipientUserId: message.requesterUserId,
      ok: false,
      error: "Запрос торговли уже открыт."
    });
    return;
  }

  pendingSearchInventoryTradeInvites.set(inviteKey, true);
  try {
    const accepted = await confirmTradeInvite(payload);
    if (accepted) {
      const searcherActor = await resolveActor(payload.searcherActorUuid);
      const searchedActor = await resolveActor(payload.searchedActorUuid);
      await openTradeInventoryWindow({
        searcherActor,
        searchedActor,
        sessionId: payload.sessionId,
        tradeCurrencyKey: payload.tradeCurrencyKey
      });
    }
    game.socket.emit(SEARCH_INVENTORY_SOCKET, {
      scope: SEARCH_INVENTORY_SOCKET_SCOPE,
      type: "tradeInviteResponse",
      requestId: message.requestId,
      recipientUserId: message.requesterUserId,
      ok: true,
      result: { accepted }
    });
  } catch (error) {
    console.error(`${SYSTEM_ID} | Trade invite failed`, error);
    game.socket.emit(SEARCH_INVENTORY_SOCKET, {
      scope: SEARCH_INVENTORY_SOCKET_SCOPE,
      type: "tradeInviteResponse",
      requestId: message.requestId,
      recipientUserId: message.requesterUserId,
      ok: false,
      error: error.message
    });
  } finally {
    pendingSearchInventoryTradeInvites.delete(inviteKey);
  }
}

async function handlePersonalTradeApprovalSocketMessage(message = {}) {
  try {
    const accepted = await confirmPersonalTradeApproval(message.payload ?? {});
    game.socket.emit(SEARCH_INVENTORY_SOCKET, {
      scope: SEARCH_INVENTORY_SOCKET_SCOPE,
      type: "personalTradeApprovalResponse",
      requestId: message.requestId,
      recipientUserId: message.requesterUserId,
      ok: true,
      result: { accepted }
    });
  } catch (error) {
    console.error(`${SYSTEM_ID} | Personal trade approval failed`, error);
    game.socket.emit(SEARCH_INVENTORY_SOCKET, {
      scope: SEARCH_INVENTORY_SOCKET_SCOPE,
      type: "personalTradeApprovalResponse",
      requestId: message.requestId,
      recipientUserId: message.requesterUserId,
      ok: false,
      error: error.message
    });
  }
}

async function performTradeSessionAction(action = "", payload = {}, requesterUserId = "") {
  if (action === "createTradeSession") return createTradeSession(payload);
  if (action === "joinTradeSession") return joinTradeSession(payload);
  const session = getActiveTradeSession(payload.sessionId);
  if (!session) throw new Error("Trade session not found.");
  if (action === "selectTradeActor") {
    ensureTradeSessionParticipant(session, requesterUserId);
    selectTradeSessionActor(session, payload.side, payload.actorUuid, requesterUserId);
  } else if (action === "addTradeOfferItem") {
    const actor = await resolveActor(payload.sourceActorUuid);
    const item = actor?.items?.get(String(payload.itemId ?? ""));
    if (!actor || !item) throw new Error("Item not found.");
    assertSearchTransferableItem(item);
    ensureTradeSessionActorOfferMutation(session, actor.uuid, requesterUserId);
    if (getTradeSessionActorSide(session, actor.uuid) !== payload.side) throw new Error("Trade offer side mismatch.");
    session.offers = addTradeOfferItem(session.offers, payload.side, item, payload.quantity, payload.placement, actor.uuid, {
      sourceStackIndex: Math.max(0, toInteger(payload.sourceStackIndex)),
      sourceWholeStack: Boolean(payload.sourceWholeStack)
    });
    resetTradeSessionReady(session);
  } else if (action === "moveTradeOfferEntry") {
    ensureTradeSessionParticipant(session, requesterUserId);
    session.offers = updateTradeOfferEntryPlacement(session.offers, payload.side, payload.kind, payload.key, payload.placement, payload.columns);
    resetTradeSessionReady(session);
  } else if (action === "depositCompletedTradeItem") {
    if (!session.offers?.completed) throw new Error("Trade is not completed.");
    const actor = await resolveActor(payload.sourceActorUuid);
    if (!actor) throw new Error("Actor not found.");
    if (!getTradeSessionActorSide(session, actor.uuid)) throw new Error("Trade source actor mismatch.");
    ensureTradeSessionActorControl(session, actor.uuid, requesterUserId);
    await performCompletedTradeHubDeposit(payload, requesterUserId);
  } else if (action === "addTradeOfferCurrency") {
    const actor = await resolveActor(payload.sourceActorUuid);
    if (!actor) throw new Error("Actor not found.");
    ensureTradeSessionActorOfferMutation(session, actor.uuid, requesterUserId);
    if (getTradeSessionActorSide(session, actor.uuid) !== payload.side) throw new Error("Trade offer side mismatch.");
    const amount = Math.max(0, toInteger(payload.amount));
    const available = getTradeAvailableCurrencyAmount(session.offers?.[payload.side], actor, payload.currencyKey);
    if (!amount || amount > available) throw new Error("Not enough currency for trade.");
    session.offers = addTradeOfferCurrency(session.offers, payload.side, payload.currencyKey, payload.amount, payload.placement, actor.uuid, requesterUserId);
    resetTradeSessionReady(session);
  } else if (action === "removeTradeOfferEntry") {
    removeTradeSessionOfferEntry(session, payload, requesterUserId);
    if (!session.offers?.completed) resetTradeSessionReady(session);
  } else if (action === "claimCompletedTradeEntry") {
    const targetActor = await resolveActor(payload.targetActorUuid);
    if (!targetActor) throw new Error("Actor not found.");
    ensureTradeSessionActorControl(session, targetActor.uuid, requesterUserId);
    if (getTradeSessionActorSide(session, targetActor.uuid) !== payload.side) throw new Error("Trade recipient side mismatch.");
    await performCompletedTradeEntryClaim(payload, requesterUserId);
  } else if (action === "claimCompletedTradeBatch") {
    const entries = Array.isArray(payload.entries) ? payload.entries : [];
    if (!entries.length) return;
    const targetActor = await resolveActor(entries[0]?.targetActorUuid ?? payload.targetActorUuid);
    if (!targetActor) throw new Error("Actor not found.");
    ensureTradeSessionActorControl(session, targetActor.uuid, requesterUserId);
    if (getTradeSessionActorSide(session, targetActor.uuid) !== entries[0]?.side) throw new Error("Trade recipient side mismatch.");
    await performCompletedTradeBatchClaim({ ...payload, entries }, requesterUserId);
  } else if (action === "reduceCompletedTradeEntry") {
    session.offers = reduceTradeOfferEntryQuantity(session.offers, payload.side, payload.kind, payload.key, payload.quantity);
  } else if (action === "setTradeCurrency") {
    session.tradeCurrencyKey = normalizeTradeCurrencyKey(payload.currencyKey);
  } else if (action === "setTradeReady") {
    toggleTradeSessionReady(session, payload.side, payload.actorUuid, requesterUserId);
    if (isTradeSessionReadyToComplete(session)) await completeTradeSession(session, requesterUserId);
  } else if (action === "restartTrade") {
    session.offers = createEmptyTradeOffers();
    session.completed = false;
  } else if (action === "leaveTradeSession") {
    leaveTradeSession(session, requesterUserId);
    if (!session.offers?.completed && !tradeSessionHasConnectedParticipantOnEachSide(session)) {
      activeSearchInventoryTradeSessions.delete(session.sessionId);
      broadcastTradeSessionClose(session.sessionId);
      await closeLocalTradeSessionWindow(session.sessionId);
      return { closed: true };
    }
    if (!tradeSessionHasConnectedClients(session)) {
      if (session.offers?.completed) await reclaimCompletedTradeSessionRemainders(session);
      activeSearchInventoryTradeSessions.delete(session.sessionId);
      const snapshot = createTradeSessionSnapshot(session);
      broadcastTradeSessionSnapshot(snapshot);
      return { snapshot };
    }
  }
  touchTradeSession(session);
  const snapshot = createTradeSessionSnapshot(session);
  broadcastTradeSessionSnapshot(snapshot);
  return { snapshot, completed: Boolean(session.offers.completed) };
}

function createTradeSession(payload = {}) {
  const sessionId = String(payload.sessionId || foundry.utils.randomID());
  const existing = getActiveTradeSession(sessionId);
  if (existing) return { snapshot: createTradeSessionSnapshot(existing), role: TRADE_ROLE_PARTICIPANT, side: "searcher" };
  const session = {
    sessionId,
    revision: 1,
    completed: false,
    tradeCurrencyKey: normalizeTradeCurrencyKey(payload.tradeCurrencyKey),
    requesterUserId: String(payload.requesterUserId ?? ""),
    recipientUserId: String(payload.recipientUserId ?? ""),
    sides: {
      searcher: createTradeSessionSide(payload.searcherActorUuid, payload.requesterUserId, 0),
      searched: createTradeSessionSide(payload.searchedActorUuid, payload.recipientUserId, 0)
    },
    observers: [],
    offers: createEmptyTradeOffers()
  };
  activeSearchInventoryTradeSessions.set(sessionId, session);
  const snapshot = createTradeSessionSnapshot(session);
  broadcastTradeSessionSnapshot(snapshot);
  return { snapshot, role: TRADE_ROLE_PARTICIPANT, side: "searcher" };
}

function createTradeSessionSide(actorUuid = "", userId = "", order = 0) {
  const participant = createTradeParticipant(actorUuid, userId, order);
  return {
    participants: participant.actorUuid ? [participant] : [],
    selectedByUser: userId ? { [String(userId)]: String(actorUuid ?? "") } : {}
  };
}

function createTradeParticipant(actorUuid = "", userId = "", order = 0) {
  const actor = getCachedActorByUuid(actorUuid);
  return {
    actorUuid: String(actorUuid ?? ""),
    actorId: actor?.id ?? "",
    userId: String(userId ?? ""),
    order: Math.max(0, toInteger(order)),
    connected: true
  };
}

function joinTradeSession(payload = {}) {
  const traderActorUuid = String(payload.traderActorUuid ?? "");
  const tradeActorUuid = String(payload.tradeActorUuid ?? "");
  const requesterUserId = String(payload.requesterUserId ?? "");
  const sessions = Array.from(activeSearchInventoryTradeSessions.values());
  let session = sessions.find(entry => getTradeSnapshotSideParticipants(entry, "searched").some(participant => participant.actorUuid === tradeActorUuid));
  if (session) {
    addTradeSessionParticipant(session, "searcher", traderActorUuid, requesterUserId);
    selectTradeSessionActor(session, "searcher", traderActorUuid, requesterUserId);
    touchTradeSession(session);
    const snapshot = createTradeSessionSnapshot(session);
    broadcastTradeSessionSnapshot(snapshot);
    return { snapshot, role: TRADE_ROLE_PARTICIPANT, side: "searcher" };
  }
  session = sessions.find(entry => getTradeSessionParticipantActorUuids(entry).includes(tradeActorUuid));
  if (!session) return null;
  addTradeSessionObserver(session, requesterUserId);
  touchTradeSession(session);
  const snapshot = createTradeSessionSnapshot(session);
  broadcastTradeSessionSnapshot(snapshot);
  return { snapshot, role: TRADE_ROLE_OBSERVER, side: "" };
}

function addTradeSessionParticipant(session = {}, side = "", actorUuid = "", userId = "") {
  if (!TRADE_OFFER_SIDES.includes(side) || !actorUuid) return;
  const participants = session.sides?.[side]?.participants ?? [];
  const existing = participants.find(participant => participant.actorUuid === actorUuid);
  if (existing) {
    existing.connected = true;
    existing.userId ||= String(userId ?? "");
  } else {
    participants.push(createTradeParticipant(actorUuid, userId, participants.length));
  }
  session.sides[side].participants = participants;
  if (userId) session.sides[side].selectedByUser[String(userId)] = String(actorUuid);
}

function addTradeSessionObserver(session = {}, userId = "") {
  const id = String(userId ?? "");
  if (!id) return;
  const existing = session.observers.find(observer => observer.userId === id);
  if (existing) existing.connected = true;
  else session.observers.push({ userId: id, connected: true });
}

function selectTradeSessionActor(session = {}, side = "", actorUuid = "", userId = "") {
  if (!TRADE_OFFER_SIDES.includes(side)) return;
  if (!getTradeSnapshotAvailableSideParticipants(session, side).some(participant => participant.actorUuid === actorUuid)) return;
  session.sides[side].selectedByUser[String(userId ?? "")] = String(actorUuid);
}

function removeTradeSessionOfferEntry(session = {}, payload = {}, requesterUserId = "") {
  const side = String(payload.side ?? "");
  const kind = String(payload.kind ?? "");
  const key = String(payload.key ?? "");
  const actorUuid = String(payload.actorUuid ?? "");
  if (kind === "all") {
    if (actorUuid) ensureTradeSessionActorOfferMutation(session, actorUuid, requesterUserId);
    else ensureTradeSessionParticipant(session, requesterUserId);
    removeTradeSessionActorOffer(session, side, actorUuid);
    return;
  }
  if (kind !== "currency") {
    if (kind === "item") {
      const entry = session.offers?.[side]?.items?.find(candidate => getTradeOfferEntryKey(candidate, "item") === key);
      if (entry?.sourceActorUuid) ensureTradeSessionActorOfferMutation(session, entry.sourceActorUuid, requesterUserId);
      else ensureTradeSessionParticipant(session, requesterUserId);
      const quantity = Math.max(0, toInteger(payload.quantity));
      if (quantity) {
        session.offers = reduceTradeOfferEntryQuantity(session.offers, side, kind, key, quantity);
        return;
      }
    }
    session.offers = removeTradeOfferEntry(session.offers, side, kind, key);
    return;
  }
  ensureTradeSessionActorOfferMutation(session, actorUuid, requesterUserId);
  const offers = normalizeTradeOffersState(session.offers);
  const entry = offers[side]?.currencies?.find(candidate => candidate.currencyKey === key);
  if (!entry) return;
  const amount = Math.max(0, toInteger(payload.amount));
  if (!amount) {
    session.offers = removeTradeOfferEntry(offers, side, kind, key);
    return;
  }
  let remaining = amount;
  for (const contribution of entry.contributions ?? []) {
    if (contribution.actorUuid !== actorUuid) continue;
    const taken = Math.min(remaining, Math.max(0, toInteger(contribution.amount)));
    contribution.amount -= taken;
    remaining -= taken;
    if (!remaining) break;
  }
  entry.contributions = (entry.contributions ?? []).filter(contribution => Math.max(0, toInteger(contribution.amount)) > 0);
  entry.amount = entry.contributions.reduce((total, contribution) => total + Math.max(0, toInteger(contribution.amount)), 0);
  offers[side].currencies = offers[side].currencies.filter(candidate => candidate.amount > 0);
  session.offers = offers;
}

function toggleTradeSessionReady(session = {}, side = "", actorUuid = "", requesterUserId = "") {
  if (!TRADE_OFFER_SIDES.includes(side) || !actorUuid) return;
  ensureTradeSessionActorControl(session, actorUuid, requesterUserId);
  const offers = normalizeTradeOffersState(session.offers);
  const readyActors = new Set(offers[side].readyActors ?? []);
  if (readyActors.has(actorUuid)) readyActors.delete(actorUuid);
  else readyActors.add(actorUuid);
  offers[side].readyActors = Array.from(readyActors);
  offers[side].ready = getTradeSessionRequiredReadyActors(session, side).every(uuid => readyActors.has(uuid));
  session.offers = offers;
}

function resetTradeSessionReady(session = {}) {
  const offers = normalizeTradeOffersState(session.offers);
  offers.completed = false;
  for (const side of TRADE_OFFER_SIDES) {
    offers[side].ready = false;
    offers[side].readyActors = [];
  }
  session.completed = false;
  session.offers = offers;
}

function getTradeSessionRequiredReadyActors(session = {}, side = "") {
  const offers = normalizeTradeOffersState(session.offers);
  const actors = new Set();
  for (const item of offers[side]?.items ?? []) if (item.sourceActorUuid) actors.add(item.sourceActorUuid);
  for (const currency of offers[side]?.currencies ?? []) {
    for (const contribution of currency.contributions ?? []) if (contribution.actorUuid) actors.add(contribution.actorUuid);
  }
  if (!actors.size) {
    const first = getTradeSnapshotSideParticipants(session, side).find(participant => participant.connected) ?? getTradeSnapshotSideParticipants(session, side).at(0);
    if (first?.actorUuid) actors.add(first.actorUuid);
  }
  return Array.from(actors);
}

function isTradeSessionReadyToComplete(session = {}) {
  const offers = normalizeTradeOffersState(session.offers);
  return TRADE_OFFER_SIDES.every(side => {
    const ready = new Set(offers[side].readyActors ?? []);
    return getTradeSessionRequiredReadyActors(session, side).every(actorUuid => ready.has(actorUuid));
  });
}

async function completeTradeSession(session = {}, requesterUserId = "") {
  const offers = normalizeTradeOffersState(session.offers);
  for (const side of TRADE_OFFER_SIDES) validateTradeOfferSide(getTradeSessionFirstActor(session, side), offers[side]);
  const searcherTarget = getTradeSessionFirstActor(session, "searcher");
  const searchedTarget = getTradeSessionFirstActor(session, "searched");
  if (!searcherTarget || !searchedTarget) throw new Error("Trade participant not found.");
  const searchedReceived = prepareReceivedTradeOfferSide({ targetActor: searchedTarget, offer: offers.searcher });
  const searcherReceived = prepareReceivedTradeOfferSide({ targetActor: searcherTarget, offer: offers.searched });
  broadcastTradeCompletionLock(session.sessionId, true);
  try {
    await consumeTradeOfferSide({ sourceActor: searcherTarget, offer: offers.searcher });
    await consumeTradeOfferSide({ sourceActor: searchedTarget, offer: offers.searched });
    session.completed = true;
    session.offers = normalizeTradeOffersState({
      completed: true,
      searcher: searcherReceived,
      searched: searchedReceived
    });
    touchTradeSession(session);
    broadcastTradeSessionSnapshot(createTradeSessionSnapshot(session));
  } finally {
    broadcastTradeCompletionLock(session.sessionId, false, { render: false });
  }
}

async function reclaimCompletedTradeSessionRemainders(session = {}) {
  let offers = normalizeTradeOffersState(session.offers);
  if (!offers.completed) return offers;
  for (const side of TRADE_OFFER_SIDES) {
    for (const entry of [...offers[side].items]) {
      const targetActor = getCompletedTradeRemainderReturnActor(session, side, entry);
      if (!targetActor) throw new Error("Completed trade return actor not found.");
      const itemData = getTradeOfferEntryItemData(entry, null);
      const quantity = Math.max(1, toInteger(entry.quantity));
      if (!itemData || !quantity) continue;
      foundry.utils.setProperty(itemData, "system.quantity", quantity);
      const target = getCompletedTradeClaimTarget(targetActor, itemData, entry.containedItems ?? [], { quantity });
      if (!target) throwInventoryNoSpace();
      await createCompletedTradeItem(targetActor, itemData, entry.containedItems ?? [], {
        targetMode: "inventory",
        targetParentId: target.parentId,
        targetX: target.placement.x,
        targetY: target.placement.y,
        targetItemId: ""
      });
      offers = reduceTradeOfferEntryQuantity(offers, side, "item", getTradeOfferEntryKey(entry, "item"), quantity);
    }
    for (const entry of [...offers[side].currencies]) {
      const targetActor = getCompletedTradeRemainderReturnActor(session, side, entry);
      if (!targetActor) throw new Error("Completed trade return actor not found.");
      const amount = Math.max(0, toInteger(entry.amount));
      if (!entry.currencyKey || !amount) continue;
      await targetActor.update({ [`system.currencies.${entry.currencyKey}`]: getActorCurrencyAmount(targetActor, entry.currencyKey) + amount });
      offers = reduceTradeOfferEntryQuantity(offers, side, "currency", getTradeOfferEntryKey(entry, "currency"), amount);
    }
  }
  session.offers = offers;
  return offers;
}

function getCompletedTradeRemainderReturnActor(session = {}, side = "", entry = {}) {
  const returnActorUuid = String(entry?.returnActorUuid ?? "");
  if (returnActorUuid) return getCachedActorByUuid(returnActorUuid);
  return getTradeSessionFirstActor(session, side);
}

function leaveTradeSession(session = {}, userId = "") {
  const id = String(userId ?? "");
  for (const side of TRADE_OFFER_SIDES) {
    for (const participant of session.sides?.[side]?.participants ?? []) {
      if (participant.userId !== id) continue;
      participant.connected = false;
      if (!session.offers?.completed) removeTradeSessionActorOffer(session, side, participant.actorUuid);
    }
  }
  for (const observer of session.observers ?? []) {
    if (observer.userId === id) observer.connected = false;
  }
}

function removeTradeSessionActorOffer(session = {}, side = "", actorUuid = "") {
  const offers = normalizeTradeOffersState(session.offers);
  offers[side].items = offers[side].items.filter(entry => entry.sourceActorUuid !== actorUuid);
  for (const currency of offers[side].currencies) {
    currency.contributions = (currency.contributions ?? []).filter(contribution => contribution.actorUuid !== actorUuid);
    currency.amount = currency.contributions.reduce((total, contribution) => total + Math.max(0, toInteger(contribution.amount)), 0);
  }
  offers[side].currencies = offers[side].currencies.filter(entry => entry.amount > 0);
  session.offers = offers;
}

function tradeSessionHasConnectedClients(session = {}) {
  return TRADE_OFFER_SIDES.some(side => getTradeSnapshotSideParticipants(session, side).some(participant => participant.connected))
    || (session.observers ?? []).some(observer => observer.connected);
}

function tradeSessionHasConnectedParticipantOnEachSide(session = {}) {
  return TRADE_OFFER_SIDES.every(side => getTradeSnapshotSideParticipants(session, side).some(participant => participant.connected));
}

function ensureTradeSessionActorControl(session = {}, actorUuid = "", userId = "") {
  const user = userId ? game.users?.get(userId) : game.user;
  const actor = getCachedActorByUuid(actorUuid);
  if (user?.isGM || actor?.testUserPermission?.(user, "OWNER")) return;
  const side = getTradeSessionActorSide(session, actorUuid);
  if (side && canUserControlTradeSessionSide(session, side, userId)) return;
  throw new Error("No trade actor owner permission.");
}

function ensureTradeSessionActorOfferMutation(session = {}, actorUuid = "", userId = "") {
  if (!getTradeSessionActorSide(session, actorUuid)) throw new Error("Trade actor is not in session.");
  ensureTradeSessionParticipant(session, userId);
}

function ensureTradeSessionParticipant(session = {}, userId = "") {
  const user = userId ? game.users?.get(userId) : game.user;
  if (user?.isGM) return;
  if (canUserParticipateInTradeSession(session, userId)) return;
  throw new Error("No trade participant permission.");
}

function canUserControlTradeSessionSide(session = {}, side = "", userId = "") {
  if (!TRADE_OFFER_SIDES.includes(side)) return false;
  const user = userId ? game.users?.get(userId) : game.user;
  if (user?.isGM) return true;
  const id = String(userId || user?.id || "");
  if (!id) return false;
  return getTradeSnapshotSideParticipants(session, side).some(participant => participant.connected && participant.userId === id);
}

function canUserParticipateInTradeSession(session = {}, userId = "") {
  const user = userId ? game.users?.get(userId) : game.user;
  if (user?.isGM) return true;
  const id = String(userId || user?.id || "");
  if (!id) return false;
  return TRADE_OFFER_SIDES.some(side => getTradeSnapshotSideParticipants(session, side).some(participant => participant.connected && participant.userId === id));
}

function getTradeSessionUserParticipantSide(session = {}, userId = "") {
  const id = String(userId ?? "");
  if (!id) return "";
  return TRADE_OFFER_SIDES.find(side => getTradeSnapshotSideParticipants(session, side).some(participant => participant.connected && participant.userId === id)) ?? "";
}

function getTradeSessionActorSide(session = {}, actorUuid = "") {
  const uuid = String(actorUuid ?? "");
  return TRADE_OFFER_SIDES.find(side => getTradeSnapshotSideParticipants(session, side).some(participant => participant.actorUuid === uuid)) ?? "";
}

function getTradeSessionSideActorUuids(session = {}, side = "", { includeDisconnected = false } = {}) {
  return getTradeSnapshotSideParticipants(session, side)
    .filter(participant => includeDisconnected || participant.connected)
    .map(participant => participant.actorUuid)
    .filter(Boolean);
}

function getTradeSessionFirstActor(session = {}, side = "") {
  const participant = getTradeSnapshotSideParticipants(session, side)
    .slice()
    .sort((left, right) => toInteger(left.order) - toInteger(right.order))
    .find(entry => getCachedActorByUuid(entry.actorUuid));
  return getCachedActorByUuid(participant?.actorUuid);
}

function touchTradeSession(session = {}) {
  session.revision = Math.max(0, toInteger(session.revision)) + 1;
}

function createTradeSessionSnapshot(session = {}) {
  return normalizeTradeSessionSnapshot(session);
}

function broadcastTradeSessionSnapshot(snapshot = {}) {
  if (!snapshot?.sessionId) return;
  applyLocalTradeSessionSnapshot(snapshot);
  game.socket.emit(SEARCH_INVENTORY_SOCKET, {
    scope: SEARCH_INVENTORY_SOCKET_SCOPE,
    type: "tradeSessionSnapshot",
    sessionId: snapshot.sessionId,
    snapshot,
    senderUserId: game.user?.id ?? ""
  });
}

function applyLocalTradeSessionSnapshot(snapshot = {}) {
  if (!searchInventoryWindow?.matchesTradeSession?.(snapshot.sessionId)) return;
  searchInventoryWindow.setTradeSessionSnapshot(snapshot);
}

async function closeLocalTradeSessionWindow(sessionId = "") {
  if (!searchInventoryWindow?.matchesTradeSession?.(sessionId)) return;
  await searchInventoryWindow.closeTradeSessionFromSocket(sessionId);
}

function normalizeTradeSessionSnapshot(snapshot = {}) {
  return {
    sessionId: String(snapshot.sessionId ?? ""),
    revision: Math.max(0, toInteger(snapshot.revision)),
    completed: Boolean(snapshot.completed || snapshot.offers?.completed),
    tradeCurrencyKey: normalizeTradeCurrencyKey(snapshot.tradeCurrencyKey),
    sides: {
      searcher: normalizeTradeSessionSide(snapshot.sides?.searcher),
      searched: normalizeTradeSessionSide(snapshot.sides?.searched)
    },
    observers: (Array.isArray(snapshot.observers) ? snapshot.observers : [])
      .map(observer => ({ userId: String(observer?.userId ?? ""), connected: observer?.connected !== false }))
      .filter(observer => observer.userId),
    offers: normalizeTradeOffersState(snapshot.offers)
  };
}

function normalizeTradeSessionSide(side = {}) {
  const participants = (Array.isArray(side?.participants) ? side.participants : [])
    .map((participant, index) => {
      const normalized = createTradeParticipant(participant?.actorUuid, participant?.userId, toInteger(participant?.order) || index);
      normalized.connected = participant?.connected !== false;
      return normalized;
    })
    .filter(participant => participant.actorUuid);
  return {
    participants,
    selectedByUser: Object.fromEntries(Object.entries(side?.selectedByUser ?? {}).map(([userId, actorUuid]) => [String(userId), String(actorUuid)]))
  };
}

function getActiveTradeSession(sessionId = "") {
  return activeSearchInventoryTradeSessions.get(String(sessionId ?? "")) ?? null;
}

function getTradeSnapshotSideParticipants(snapshot = {}, side = "") {
  return Array.isArray(snapshot?.sides?.[side]?.participants) ? snapshot.sides[side].participants : [];
}

function getTradeSnapshotAvailableSideParticipants(snapshot = {}, side = "") {
  const participants = getTradeSnapshotSideParticipants(snapshot, side);
  if (snapshot?.completed || snapshot?.offers?.completed) return participants;
  return participants.filter(participant => participant.connected);
}

function getTradeSessionParticipantActorUuids(session = {}) {
  return TRADE_OFFER_SIDES.flatMap(side => getTradeSnapshotSideParticipants(session, side).map(participant => participant.actorUuid)).filter(Boolean);
}

function getTradeSnapshotActorUuids(snapshot = {}) {
  return getTradeSessionParticipantActorUuids(snapshot);
}

function getTradeSnapshotSelectedActorUuids(snapshot = {}, userId = "") {
  const result = {};
  for (const side of TRADE_OFFER_SIDES) {
    const participants = getTradeSnapshotAvailableSideParticipants(snapshot, side);
    const selected = snapshot?.sides?.[side]?.selectedByUser?.[String(userId ?? "")];
    result[side] = selected && participants.some(participant => participant.actorUuid === selected)
      ? selected
      : (participants.find(participant => participant.connected)?.actorUuid ?? participants.at(0)?.actorUuid ?? "");
  }
  return result;
}

function getCachedActorByUuid(uuid = "") {
  const key = String(uuid ?? "");
  if (!key) return null;
  const actorId = key.startsWith("Actor.") ? key.slice(6) : key;
  const actor = game.actors?.get(actorId);
  if (actor) return actor;
  try {
    const document = foundry.utils.fromUuidSync?.(key) ?? null;
    return document instanceof Actor ? document : null;
  } catch (_error) {
    return null;
  }
}

function getResponsibleGM() {
  return (game.users?.contents ?? [])
    .filter(user => user.active && user.isGM)
    .sort((left, right) => left.id.localeCompare(right.id))
    .at(0) ?? null;
}

function getPrimaryActorOwnerUser(actor) {
  const users = (game.users?.contents ?? [])
    .filter(user => user.active && actor?.testUserPermission?.(user, "OWNER"))
    .sort((left, right) => Number(left.isGM) - Number(right.isGM) || left.id.localeCompare(right.id));
  return users.at(0) ?? getResponsibleGM();
}

function getTradeInviteKey(payload = {}) {
  return [
    String(payload.requesterUserId ?? ""),
    String(payload.recipientUserId ?? ""),
    String(payload.searcherActorUuid ?? ""),
    String(payload.searchedActorUuid ?? "")
  ].join("|");
}

async function confirmTradeInvite(payload = {}) {
  const searcherActor = await resolveActor(payload.searcherActorUuid);
  const searchedActor = await resolveActor(payload.searchedActorUuid);
  if (!searcherActor || !searchedActor) throw new Error("Actor not found.");
  return DialogV2.confirm({
    window: { title: "Торговля" },
    content: `<p><strong>${escapeHTML(searcherActor.name)}</strong> предлагает торговлю с <strong>${escapeHTML(searchedActor.name)}</strong>.</p>`,
    yes: {
      label: "Принять",
      icon: "fa-solid fa-check"
    },
    no: {
      label: "Отклонить"
    },
    rejectClose: false,
    modal: true
  });
}

async function confirmPersonalTradeApproval(payload = {}) {
  const currency = getCurrencySettings().find(entry => entry.key === normalizeTradeCurrencyKey(payload.tradeCurrencyKey));
  const currencyLabel = currency?.label ?? payload.tradeCurrencyKey ?? "";
  return DialogV2.confirm({
    window: { title: "Личная торговля" },
    content: `
      <p>Подтвердить личную сделку?</p>
      <dl class="fallout-maw-trade-approval-summary">
        <dt>${escapeHTML(payload.searcherActorName ?? "Сторона 1")}</dt>
        <dd>${Math.max(0, toInteger(payload.searcherTotal))} ${escapeHTML(currencyLabel)}</dd>
        <dt>${escapeHTML(payload.searchedActorName ?? "Сторона 2")}</dt>
        <dd>${Math.max(0, toInteger(payload.searchedTotal))} ${escapeHTML(currencyLabel)}</dd>
      </dl>
    `,
    yes: {
      label: "Подтвердить",
      icon: "fa-solid fa-check"
    },
    no: {
      label: "Отклонить"
    },
    position: { width: 420 },
    rejectClose: false,
    modal: false
  });
}

async function resolveActor(uuid) {
  const document = uuid ? await fromUuid(String(uuid)) : null;
  return document instanceof Actor ? document : null;
}
