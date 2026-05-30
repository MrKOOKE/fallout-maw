import { FALLOUT_MAW } from "../config/system-config.mjs";
import { SYSTEM_ID, TEMPLATES } from "../constants.mjs";
import {
  getCreatureOptions,
  getActorNeedSettings,
  getDamageTypeSettings,
  getResourceSettings,
  getSkillSettings,
  getSystemActionSettings,
  getTokenActionHudIcons
} from "../settings/accessors.mjs";
import {
  TOKEN_ACTION_HUD_COLLAPSED_SECTIONS_SETTING,
  TOKEN_ACTION_HUD_ENABLED_SETTING,
  TOKEN_ACTION_HUD_SCALE_SETTING
} from "../settings/constants.mjs";
import { requestSkillCheck } from "../rolls/skill-check.mjs";
import { applyDamageCostModifier, fullyRestoreActorDamageState, getDamageCostModifierState, getLimbHealingCap, getResourceLimitState, isLimbDestroyed } from "../combat/damage-hub.mjs";
import { MOVEMENT_RESOURCE_PREVIEW_HOOK } from "../combat/movement-resources.mjs";
import {
  cancelWeaponAttack,
  hasRequiredWeaponReloadActionPoints,
  spendWeaponReloadActionPoints,
  startWeaponAttack
} from "../combat/weapon-attack-controller.mjs";
import { useFirstAidItem } from "../items/first-aid.mjs";
import { openLimbDamageDialog } from "./limb-damage-dialog.mjs";
import { requestMedicineTarget } from "./medicine-dialog.mjs";
import { requestRepairTarget } from "./repair-dialog.mjs";
import { openSearchInventoryWindow, requestTradeInventoryWindow } from "./search-inventory.mjs";
import { openCraftWindow } from "./craft-window.mjs";
import { openStealthWindow } from "../stealth/index.mjs";
import { getWeaponActionBlockState } from "../abilities/runtime-state.mjs";
import {
  FALLBACK_ICON,
  getActorInventoryGridDimensions,
  normalizeImagePath,
  prepareIndicatorEntry,
  prepareInventoryContext
} from "../utils/actor-display-data.mjs";
import {
  ROOT_CONTAINER_ID,
  createStoredPlacement,
  findFirstAvailableInventoryPlacement,
  getItemMaxStack,
  getContextInventoryItems,
  getItemQuantity
} from "../utils/inventory-containers.mjs";
import { ITEM_FUNCTIONS, getConditionFunction, getDamageSourceFunction, getEnabledWeaponFunctions, getFirstAidChargesData, getWeaponFunctionById, getWeaponFunctionModuleSlots, getWeaponFunctionUpdatePath, hasItemFunction, isActiveItem } from "../utils/item-functions.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { createLimbSilhouetteHud } from "../utils/limb-silhouette.mjs";
import { renderInventoryItemTooltipHTML } from "../sheets/actor-sheet.mjs";
import { AdvancementApplication } from "../advancement/application.mjs";
import {
  applyWeaponModuleModifiers,
  getWeaponModuleSlots,
  getWeaponModuleSlotItemData,
  getWeaponModuleTechnicalName,
  isModuleItemCompatibleWithSlot
} from "../utils/weapon-modules.mjs";
import { FalloutMaWFormApplicationV2, getFlatFormData } from "./base-form-application-v2.mjs";

const { ApplicationV2, DialogV2, HandlebarsApplicationMixin } = foundry.applications.api;
const FormDataExtended = foundry.applications.ux.FormDataExtended;
const TOKEN_ACTION_HUD_SOCKET = `system.${SYSTEM_ID}`;
const TOKEN_ACTION_HUD_SOCKET_SCOPE = "fallout-maw.tokenActionHud";
const TOKEN_ACTION_HUD_SOCKET_TIMEOUT = 10000;
const SELECTED_HUD_WEAPON_FLAG = "selectedHudWeaponItemId";
const SELECTED_HUD_WEAPON_SET_FLAG = "selectedHudWeaponSetKey";
const TOKEN_ACTION_HUD_SCALE_DEFAULT = 50;
const TOKEN_ACTION_HUD_SCALE_MIN = 25;
const TOKEN_ACTION_HUD_SCALE_MAX = 100;
const HUD_METER_SECTION_KEYS = Object.freeze(["resources", "needs"]);
const HUD_LIMB_LAYER_KEYS = Object.freeze(["state", "defense", "resistance"]);
const HUD_LIMB_LAYERS = Object.freeze([
  { key: "state", label: "Состояние" },
  { key: "defense", label: "Защита" }
]);
const HUD_LIMB_LAYER_CHOICES = Object.freeze([
  ...HUD_LIMB_LAYERS,
  { key: "resistance", label: "Сопротивление" }
]);
const openReloadDialogs = new Map();
const HUD_SILENT_ITEM_UPDATE_PATHS = new Set([
  "system.functions.weapon.magazine.value",
  "system.functions.condition.value"
]);
const HUD_ACTIONS = Object.freeze([
  { key: "weapon", label: "Оружие", icon: "icons/svg/combat.svg" },
  { key: "items", label: "Предметы", icon: "icons/svg/item-bag.svg" },
  { key: "abilities", label: "Способности", icon: "icons/svg/aura.svg" },
  { key: "skills", label: "Испытания", icon: "icons/svg/dice-target.svg" },
  { key: "actions", label: "Действия", icon: "icons/svg/aura.svg" },
  { key: "settings", label: "Настройки", icon: "icons/svg/lever.svg" }
]);

let tokenActionHud = null;
let tokenActionHudScaleSettings = null;
let hooksRegistered = false;
let tokenActionHudRefresh = null;
let tokenActionHudLayoutRefresh = null;
let tokenActionHudPreviewPercent = null;
let tokenActionHudMovementPreview = null;
const pendingTokenActionHudSocketRequests = new Map();
const hudImageAspectCache = new Map();

export function registerTokenActionHudHooks() {
  if (hooksRegistered) return;
  Hooks.on("getSceneControlButtons", addTokenActionHudControlButton);
  Hooks.on("controlToken", scheduleTokenActionHudRefresh);
  Hooks.on("canvasReady", scheduleTokenActionHudRefresh);
  Hooks.on("canvasTearDown", () => {
    cancelWeaponAttack();
    closeTokenActionHud();
  });
  Hooks.on("updateActor", scheduleTokenActionHudRefreshForActor);
  Hooks.on("updateItem", scheduleTokenActionHudRefreshForUpdatedItem);
  Hooks.on("createItem", scheduleTokenActionHudRefreshForItem);
  Hooks.on("deleteItem", scheduleTokenActionHudRefreshForItem);
  Hooks.on("updateToken", scheduleTokenActionHudRefresh);
  Hooks.on("updateCombat", scheduleTokenActionHudRefresh);
  Hooks.on("deleteCombat", scheduleTokenActionHudRefresh);
  Hooks.on("createCombatant", scheduleTokenActionHudRefresh);
  Hooks.on("deleteCombatant", scheduleTokenActionHudRefresh);
  Hooks.on("updateSetting", scheduleTokenActionHudRefreshForSetting);
  Hooks.on(MOVEMENT_RESOURCE_PREVIEW_HOOK, applyTokenActionHudMovementPreview);
  window.addEventListener("resize", scheduleTokenActionHudRefresh);
  tokenActionHudRefresh = foundry.utils.debounce(syncTokenActionHud, 60);
  tokenActionHudLayoutRefresh = foundry.utils.debounce(layoutCurrentTokenActionHud, 60);
  applyTokenActionHudScale(getTokenActionHudScalePercent());
  hooksRegistered = true;
}

export function registerTokenActionHudSocket() {
  game.socket.on(TOKEN_ACTION_HUD_SOCKET, handleTokenActionHudSocketMessage);
}

export function refreshTokenActionHudControlButton() {
  if (!ui.controls?.rendered) return;
  void ui.controls.render({ force: true, reset: true });
}

export function syncTokenActionHud() {
  if (!game.ready || !canvas?.ready || !isTokenActionHudEnabled()) {
    closeTokenActionHud();
    return;
  }

  const token = getSelectedTokenForHud();
  if (!token) {
    closeTokenActionHud();
    return;
  }

  tokenActionHud ??= new TokenActionHud();
  tokenActionHud.setToken(token);
  void tokenActionHud.render({ force: true });
}

function scheduleTokenActionHudRefresh() {
  tokenActionHudRefresh?.();
}

function scheduleTokenActionHudRefreshForActor(actor) {
  if (!isActiveHudActor(actor)) return;
  scheduleTokenActionHudRefresh();
}

function scheduleTokenActionHudRefreshForItem(item) {
  if (!isActiveHudActor(item?.parent)) return;
  scheduleTokenActionHudRefresh();
}

function scheduleTokenActionHudRefreshForUpdatedItem(item, changes) {
  if (isActiveHudDamageSourcePrototype(item)) {
    scheduleTokenActionHudRefresh();
    return;
  }
  if (isHudSilentItemUpdate(changes)) return;
  scheduleTokenActionHudRefreshForItem(item);
}

function isActiveHudDamageSourcePrototype(item) {
  if (!item || item.actor || !hasItemFunction(item, ITEM_FUNCTIONS.damageSource)) return false;
  const token = getSelectedTokenForHud();
  const actor = token?.actor;
  if (!actor) return false;
  return (actor.items?.contents ?? []).some(actorItem => (
    getEnabledWeaponFunctions(actorItem).some(weapon => (
      getWeaponMagazineSourceUuids(weapon.data).includes(item.uuid)
    ))
  ));
}

function isHudSilentItemUpdate(changes = {}) {
  const paths = Object.keys(foundry.utils.flattenObject(changes));
  return Boolean(paths.length) && paths.every(path => HUD_SILENT_ITEM_UPDATE_PATHS.has(path));
}

function scheduleTokenActionHudRefreshForSetting(setting) {
  if (!String(setting?.key ?? "").startsWith(`${FALLOUT_MAW.id}.`)) return;
  if (setting.key === `${FALLOUT_MAW.id}.${TOKEN_ACTION_HUD_SCALE_SETTING}`) {
    applyTokenActionHudScale(getTokenActionHudScalePercent());
  }
  if (setting.key === `${FALLOUT_MAW.id}.${TOKEN_ACTION_HUD_COLLAPSED_SECTIONS_SETTING}`) return;
  scheduleTokenActionHudRefresh();
}

function isActiveHudActor(actor) {
  return Boolean(actor && tokenActionHud?.actor?.uuid === actor.uuid);
}

function closeTokenActionHud() {
  if (!tokenActionHud) return;
  const hud = tokenActionHud;
  tokenActionHud = null;
  void hud.close();
}

function layoutCurrentTokenActionHud() {
  if (!tokenActionHud?.element?.isConnected) return;
  layoutTokenActionHud(tokenActionHud.element);
}

function applyTokenActionHudMovementPreview(preview) {
  tokenActionHudMovementPreview = preview;
  tokenActionHud?.applyMovementResourcePreview(preview);
}

function addTokenActionHudControlButton(controls) {
  const tokenControls = controls.tokens;
  if (!tokenControls?.tools || tokenControls.tools.falloutMawTokenHud) return;

  tokenControls.tools.falloutMawTokenHud = {
    name: "falloutMawTokenHud",
    title: "Token Action HUD",
    icon: "fa-solid fa-table-cells-large",
    order: Object.keys(tokenControls.tools).length,
    toggle: true,
    active: isTokenActionHudEnabled(),
    visible: true,
    onChange: (_event, active) => toggleTokenActionHud(active)
  };
}

async function toggleTokenActionHud(active) {
  await game.settings.set(FALLOUT_MAW.id, TOKEN_ACTION_HUD_ENABLED_SETTING, Boolean(active));
  syncTokenActionHud();
  refreshTokenActionHudControlButton();
}

function isTokenActionHudEnabled() {
  try {
    return game.settings.get(FALLOUT_MAW.id, TOKEN_ACTION_HUD_ENABLED_SETTING) !== false;
  } catch (_error) {
    return true;
  }
}

function getTokenActionHudScalePercent() {
  try {
    return normalizeTokenActionHudScalePercent(game.settings.get(FALLOUT_MAW.id, TOKEN_ACTION_HUD_SCALE_SETTING));
  } catch (_error) {
    return TOKEN_ACTION_HUD_SCALE_DEFAULT;
  }
}

function normalizeTokenActionHudScalePercent(value) {
  const rounded = Math.round(Number(value) || TOKEN_ACTION_HUD_SCALE_DEFAULT);
  return Math.min(TOKEN_ACTION_HUD_SCALE_MAX, Math.max(TOKEN_ACTION_HUD_SCALE_MIN, rounded));
}

function tokenActionHudScaleFactor(percent) {
  return normalizeTokenActionHudScalePercent(percent) / TOKEN_ACTION_HUD_SCALE_DEFAULT;
}

function applyTokenActionHudScale(percent) {
  const normalized = normalizeTokenActionHudScalePercent(percent);
  tokenActionHudPreviewPercent = normalized;
  document.documentElement?.style?.setProperty("--fallout-maw-token-action-hud-scale", String(tokenActionHudScaleFactor(normalized)));
  tokenActionHudLayoutRefresh?.();
}

function getSelectedTokenForHud() {
  const controlled = canvas?.tokens?.controlled ?? [];
  return controlled.find(token => token?.actor?.testUserPermission?.(game.user, "LIMITED")) ?? null;
}

function getSelectedHudActors() {
  const actors = [];
  const seen = new Set();
  for (const token of canvas?.tokens?.controlled ?? []) {
    const actor = token?.actor;
    if (!actor?.testUserPermission?.(game.user, "OWNER") || seen.has(actor.uuid)) continue;
    seen.add(actor.uuid);
    actors.push(actor);
  }
  return actors;
}

function getFirstHudTarget() {
  const token = Array.from(game.user?.targets ?? [])
    .find(target => target?.actor) ?? null;
  return {
    token,
    actor: token?.actor ?? null
  };
}

function prepareEndTurnAction(token) {
  if (!isTokenCombatTurn(token, game.combat) || !canUserAdvanceCombatTurn(game.combat)) return null;
  return {
    label: "Конец хода",
    title: "Завершить ход",
    icon: "fa-solid fa-forward-step"
  };
}

function isTokenCombatTurn(token, combat) {
  const tokenDocument = token?.document ?? token;
  const combatant = combat?.combatant;
  if (!tokenDocument || !combatant) return false;
  if (combat.round < 1 || combat.turn === null) return false;
  if (combatant.sceneId && tokenDocument.parent?.id && combatant.sceneId !== tokenDocument.parent.id) return false;
  return combatant.tokenId === tokenDocument.id;
}

function canUserAdvanceCombatTurn(combat) {
  if (!combat) return false;
  const updateData = combat.turn && combat.turn.between?.(1, combat.turns.length - 2)
    ? { turn: 0 }
    : { round: 0 };
  return Boolean(combat.canUserModify?.(game.user, "update", updateData));
}

class TokenActionHud extends HandlebarsApplicationMixin(ApplicationV2) {
  #token = null;
  #activeTray = "";
  #limbDisplayLayer = "state";
  #layoutFrame = null;
  #itemTooltipElement = null;
  #itemTooltipNestedElement = null;
  #itemTooltipNestedAnchorElement = null;
  #itemTooltipNestedCloseTimer = null;
  #itemTooltipNestedPinned = false;
  #itemTooltipAnchorElement = null;
  #itemTooltipItemId = "";
  #itemTooltipTimer = null;
  #itemTooltipCloseTimer = null;
  #itemTooltipPinned = false;
  #itemTooltipWeaponTabIndex = 0;
  #itemTooltipBaseMode = false;
  #itemTooltipPointerDownHandler = null;
  #itemTooltipKeyHandler = null;
  #itemTooltipSuppressHudActivation = false;
  #itemTooltipSuppressHudActivationTimer = null;
  #editableMeterSections = {
    resources: false,
    needs: false
  };
  #limbPopover = {
    element: null,
    showTimer: null,
    hideTimer: null,
    hoveredPart: null,
    boundRoot: null
  };

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-token-action-hud",
    classes: ["fallout-maw", "fallout-maw-token-action-hud"],
    tag: "aside",
    window: {
      frame: false,
      positioned: false
    },
    actions: {
      toggleTray: TokenActionHud.#onToggleTray,
      toggleMeterSection: TokenActionHud.#onToggleMeterSection,
      toggleMeterEdit: TokenActionHud.#onToggleMeterEdit,
      selectHudWeaponSet: TokenActionHud.#onSelectHudWeaponSet,
      selectHudWeapon: { handler: TokenActionHud.#onSelectHudWeapon, buttons: [0, 1] },
      toggleWeaponActions: { handler: TokenActionHud.#onToggleWeaponActions, buttons: [0, 1] },
      useWeaponAction: { handler: TokenActionHud.#onUseWeaponAction, buttons: [0, 1] },
      gmHealSelected: TokenActionHud.#onGmHealSelected,
      gmAwardExperience: TokenActionHud.#onGmAwardExperience,
      endCombatTurn: TokenActionHud.#onEndCombatTurn,
      openSettings: TokenActionHud.#onOpenSettings,
      rollSkill: TokenActionHud.#onRollSkill,
      openItem: { handler: TokenActionHud.#onOpenItem, buttons: [1] },
      useItem: { handler: TokenActionHud.#onUseItem, buttons: [0, 1] },
      useSystemAction: TokenActionHud.#onUseSystemAction
    }
  };

  static PARTS = {
    hud: {
      root: true,
      template: TEMPLATES.tokenActionHud
    }
  };

  get token() {
    return this.#token;
  }

  get actor() {
    return this.#token?.actor ?? null;
  }

  close(options = {}) {
    return super.close({ ...options, animate: false });
  }

  setToken(token) {
    if (this.#token?.id !== token?.id) {
      cancelWeaponAttack();
      this.#activeTray = "";
      this.#editableMeterSections.resources = false;
      this.#editableMeterSections.needs = false;
    }
    this.#token = token;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const actor = this.actor;
    const race = getCreatureOptions().races.find(entry => entry.id === actor.system?.creature?.raceId);
    const inventory = prepareInventoryContext(actor, race);
    const activeWeaponSetKey = getActiveHudWeaponSetKey(actor, inventory.weaponSets);
    const selectedWeapon = getSelectedHudWeapon(actor, inventory.weaponSets, activeWeaponSetKey);
    const hudIcons = getTokenActionHudIcons();
    const weaponSet = prepareHudWeaponSet(inventory.weaponSets, activeWeaponSetKey, selectedWeapon?.id ?? "", hudIcons);
    const weaponSets = prepareHudWeaponSets(inventory.weaponSets, activeWeaponSetKey, selectedWeapon?.id ?? "", hudIcons);
    const selectedWeaponSlot = getSelectedHudWeaponSlot(weaponSet, selectedWeapon?.id ?? "");
    const selectedWeaponDisabled = Boolean(selectedWeaponSlot?.useDisabled);
    const weaponActionRows = prepareWeaponActionRows(actor, selectedWeapon, selectedWeaponDisabled, hudIcons);
    const skills = prepareSkillButtons(actor, hudIcons);
    const items = prepareOwnedItemButtons(actor, "gear", "icons/svg/item-bag.svg", { activeOnly: true });
    const abilities = prepareOwnedAbilityButtons(actor, "icons/svg/aura.svg");
    const systemActions = prepareSystemActionButtons();
    const actions = prepareActions(this.#activeTray, selectedWeapon, items, abilities, systemActions, hudIcons);
    const tray = prepareTrayContext(this.#activeTray, skills, items, abilities, systemActions, weaponActionRows, weaponSet, weaponSets);
    const meterSections = prepareMeterSectionStates(this.#editableMeterSections);
    const displayLimbs = prepareDisplayLimbs(actor, this.#limbDisplayLayer);
    const limbSilhouette = createLimbSilhouetteHud(race?.limbSilhouette, displayLimbs);

    return {
      ...context,
      actor,
      token: this.#token,
      limbs: limbSilhouette?.visible ? [] : prepareLimbEntries(displayLimbs),
      limbSilhouette,
      limbLayer: prepareLimbLayerContext(this.#limbDisplayLayer),
      gmControls: game.user?.isGM ? {
        selectedCount: getSelectedHudActors().length
      } : null,
      resources: prepareResourceEntries(actor),
      needs: prepareNeedEntries(actor),
      activeTray: this.#activeTray,
      weaponSet,
      weaponSets,
      selectedWeapon,
      actions,
      endTurnAction: prepareEndTurnAction(this.#token),
      meterSections,
      tray,
      fallbackIcon: FALLBACK_ICON
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#activateLimbControlClicks();
    const silhouette = this.element?.querySelector("[data-limb-popover-root]");
    if (silhouette && silhouette !== this.#limbPopover.boundRoot) {
      silhouette.addEventListener("pointermove", event => this.#onLimbPopoverMove(event));
      silhouette.addEventListener("pointerleave", () => this.#onLimbPopoverLeaveRoot());
      this.#limbPopover.boundRoot = silhouette;
    }
    this.applyMovementResourcePreview(tokenActionHudMovementPreview);
    this.#activateVariableWidthTiles();
    this.#scheduleLayout();
  }

  _attachFrameListeners() {
    super._attachFrameListeners();
    this.element.addEventListener("pointerdown", event => this.#onHudItemMiddlePointerDown(event));
    this.element.addEventListener("mouseover", event => this.#onHudItemTooltipMouseOver(event));
    this.element.addEventListener("mouseout", event => this.#onHudItemTooltipMouseOut(event));
    this.element.addEventListener("click", event => this.#onHudItemTooltipHudActivation(event), { capture: true });
    this.element.addEventListener("auxclick", event => this.#onHudItemTooltipHudActivation(event), { capture: true });
    this.element.addEventListener("contextmenu", event => this.#onHudItemTooltipHudActivation(event), { capture: true });
    this.element.addEventListener("contextmenu", event => this.#onHudContextMenu(event));
    this.element.addEventListener("click", event => this.#onLimbLayerOptionClick(event));
    this.element.addEventListener("change", event => this.#onMeterValueInputChange(event));
    this.element.addEventListener("keydown", event => this.#onMeterValueInputKeyDown(event));
  }

  applyMovementResourcePreview(preview) {
    const resources = this.#getMovementResourcePreviewResources(preview);
    for (const meter of this.element?.querySelectorAll("[data-token-hud-resource-meter]") ?? []) {
      const key = String(meter.dataset.resourceKey ?? "");
      const spent = Math.max(0, toInteger(resources?.[key]));
      applyMeterPreview(meter, spent);
    }
  }

  #getMovementResourcePreviewResources(preview) {
    if (!preview || preview.actorUuid !== this.actor?.uuid) return null;
    if (preview.tokenId && preview.tokenId !== this.#token?.document?.id) return null;
    const sceneId = this.#token?.document?.parent?.id ?? this.#token?.document?.scene?.id ?? "";
    if (preview.sceneId && sceneId && preview.sceneId !== sceneId) return null;
    return preview.resources ?? null;
  }

  async _onClose(options) {
    await super._onClose(options);
    cancelWeaponAttack();
    if (this.#layoutFrame) cancelAnimationFrame(this.#layoutFrame);
    this.#layoutFrame = null;
    this.#clearHudItemTooltip();
    this.#clearHudItemTooltipActivationSuppression();
    this.#destroyLimbPopover();
  }

  #scheduleLayout() {
    if (this.#layoutFrame) cancelAnimationFrame(this.#layoutFrame);
    this.#layoutFrame = requestAnimationFrame(() => {
      this.#layoutFrame = null;
      layoutTokenActionHud(this.element);
    });
  }

  #activateVariableWidthTiles() {
    const images = this.element?.querySelectorAll(
      ".fallout-maw-token-hud-main-action.variable-width img, .fallout-maw-token-hud-weapon-slot:not(.empty) > img, .fallout-maw-token-hud-set-slot-preview:not(.empty) > img"
    ) ?? [];
    for (const image of images) {
      const applyAspect = () => {
        if (setHudTileImageAspect(image)) this.#scheduleLayout();
      };
      if (image.complete && image.naturalWidth && image.naturalHeight) applyAspect();
      else image.addEventListener("load", applyAspect, { once: true });
    }
  }

  static #onToggleTray(event, target) {
    event.preventDefault();
    const tray = target.dataset.tray ?? "";
    this.#activeTray = this.#activeTray === tray ? "" : tray;
    return this.render({ force: true });
  }

  static async #onSelectHudWeaponSet(event, target) {
    event.preventDefault();
    const actor = this.actor;
    if (!actor?.isOwner) return undefined;
    const weaponSetKey = String(target.dataset.weaponSet ?? "");
    if (!weaponSetKey) return undefined;
    await actor.setFlag(FALLOUT_MAW.id, SELECTED_HUD_WEAPON_SET_FLAG, weaponSetKey);

    const race = getCreatureOptions().races.find(entry => entry.id === actor.system?.creature?.raceId);
    const inventory = prepareInventoryContext(actor, race);
    const set = inventory.weaponSets.find(entry => entry.key === weaponSetKey);
    const firstWeaponId = getUniqueHudWeaponSlots(set?.slots ?? []).at(0)?.item?.id ?? "";
    if (firstWeaponId) await actor.setFlag(FALLOUT_MAW.id, SELECTED_HUD_WEAPON_FLAG, firstWeaponId);
    this.#activeTray = "";
    return this.render({ force: true });
  }

  static async #onToggleMeterSection(event, target) {
    event.preventDefault();
    const section = String(target.dataset.section ?? "");
    if (!HUD_METER_SECTION_KEYS.includes(section)) return undefined;

    const sectionElement = this.element?.querySelector(`[data-token-hud-meter-section="${section}"]`);
    const collapsed = !sectionElement?.classList.contains("collapsed");
    applyMeterSectionCollapsedState(this.element, section, collapsed);
    this.#scheduleLayout();
    window.setTimeout(() => this.#scheduleLayout(), 220);

    const current = getTokenActionHudCollapsedSections();
    current[section] = collapsed;
    await game.settings.set(FALLOUT_MAW.id, TOKEN_ACTION_HUD_COLLAPSED_SECTIONS_SETTING, current);
    return undefined;
  }

  static #onToggleMeterEdit(event, target) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return undefined;
    const section = String(target.dataset.section ?? "");
    if (!HUD_METER_SECTION_KEYS.includes(section)) return undefined;
    this.#editableMeterSections[section] = !this.#editableMeterSections[section];
    return this.render({ force: true });
  }

  static #onOpenSettings(event) {
    event.preventDefault();
    tokenActionHudScaleSettings ??= new TokenActionHudScaleSettings();
    return tokenActionHudScaleSettings.render({ force: true });
  }

  static async #onEndCombatTurn(event) {
    event.preventDefault();
    const combat = game.combat;
    if (!isTokenCombatTurn(this.token, combat) || !canUserAdvanceCombatTurn(combat)) return undefined;
    this.#activeTray = "";
    await combat.nextTurn();
    return this.render({ force: true });
  }

  static async #onGmHealSelected(event) {
    event.preventDefault();
    if (!game.user?.isGM) return undefined;

    const actors = getSelectedHudActors();
    if (!actors.length) return undefined;
    const formData = await DialogV2.input({
      window: {
        title: "Полное восстановление"
      },
      content: `
        <p>Полностью вылечить выбранных актеров: ${actors.length}?</p>
        <label class="fallout-maw-gm-heal-repair-option">
          <input type="checkbox" name="repairItems" value="true">
          <span>Починить все предметы?</span>
        </label>
      `,
      ok: {
        label: "Вылечить",
        icon: "fa-solid fa-kit-medical",
        callback: (_event, button) => new FormDataExtended(button.form).object
      },
      buttons: [{
        action: "cancel",
        label: "Отмена"
      }],
      rejectClose: false
    });
    if (!formData || formData === "cancel") return undefined;

    const repairItems = Boolean(formData.repairItems);
    for (const actor of actors) await fullyRestoreActor(actor, { repairItems });
    return this.render({ force: true });
  }

  static async #onGmAwardExperience(event) {
    event.preventDefault();
    if (!game.user?.isGM) return undefined;

    const actors = getSelectedHudActors();
    if (!actors.length) return undefined;
    const formData = await DialogV2.input({
      window: {
        title: "Выдать опыт"
      },
      content: `
        <p>Выдать опыт выбранным актерам: ${actors.length}.</p>
        <label class="fallout-maw-stacked-field">
          <span>Опыт</span>
          <input type="number" name="experience" value="0" min="0" step="1" autofocus>
        </label>
      `,
      ok: {
        label: "Выдать",
        icon: "fa-solid fa-star",
        callback: (_event, button) => new FormDataExtended(button.form).object
      },
      position: {
        width: 420
      },
      rejectClose: false
    });
    if (!formData) return undefined;

    const amount = Math.max(0, toInteger(formData.experience));
    if (!amount) return undefined;
    for (const actor of actors) {
      const current = Math.max(0, toInteger(actor.system?.development?.experience));
      await actor.update({ "system.development.experience": current + amount });
    }
    return this.render({ force: true });
  }

  static async #onSelectHudWeapon(event, target) {
    event.preventDefault();
    const actor = this.actor;
    if (!actor?.isOwner) return undefined;
    const itemId = String(target.dataset.itemId ?? "");
    const item = actor.items.get(itemId);
    if (!itemId || !item) return undefined;
    if (isMiddleMouseClick(event)) return item.sheet?.render(true);
    if (event.button !== 0) return undefined;
    await actor.setFlag(FALLOUT_MAW.id, SELECTED_HUD_WEAPON_FLAG, itemId);
    const weaponSetKey = String(target.dataset.weaponSet ?? "");
    if (weaponSetKey) await actor.setFlag(FALLOUT_MAW.id, SELECTED_HUD_WEAPON_SET_FLAG, weaponSetKey);
    this.#activeTray = "";
    return this.render({ force: true });
  }

  static async #onToggleWeaponActions(event, target) {
    event.preventDefault();
    const itemId = String(target.dataset.itemId ?? "");
    if (!itemId) return undefined;
    if (isMiddleMouseClick(event)) {
      const item = this.actor?.items.get(itemId);
      return item?.sheet?.render(true);
    }
    if (event.button !== 0) return undefined;
    const currentItemId = String(this.actor?.getFlag(FALLOUT_MAW.id, SELECTED_HUD_WEAPON_FLAG) ?? "");
    const wasOpenForItem = this.#activeTray === "weaponActions" && currentItemId === itemId;
    if (itemId) await this.actor?.setFlag(FALLOUT_MAW.id, SELECTED_HUD_WEAPON_FLAG, itemId);
    const weaponSetKey = String(target.dataset.weaponSet ?? "");
    if (weaponSetKey) await this.actor?.setFlag(FALLOUT_MAW.id, SELECTED_HUD_WEAPON_SET_FLAG, weaponSetKey);
    this.#activeTray = wasOpenForItem ? "" : "weaponActions";
    return this.render({ force: true });
  }

  static #onUseWeaponAction(event, target) {
    event.preventDefault();
    const actionKey = String(target.dataset.weaponActionKey ?? "");
    const weaponFunctionId = String(target.dataset.weaponFunctionId ?? "");
    const itemId = String(target.dataset.itemId ?? "");
    const item = this.actor?.items.get(itemId);
    if (!item || !actionKey) return undefined;
    if (isMiddleMouseClick(event)) return item.sheet?.render(true);
    if (event.button !== 0) return undefined;
    if (isHudWeaponDisabled(this.actor, item)) return undefined;
    const blockState = getWeaponActionBlockState(this.actor, actionKey);
    if (blockState.blocked) {
      ui.notifications.warn(`${this.actor?.name ?? ""}: действие заблокировано (${blockState.effect?.name ?? actionKey}).`);
      return undefined;
    }
    if (actionKey === "reload") {
      return openWeaponReloadDialog({
        actor: this.actor,
        weapon: item,
        weaponFunctionId,
        application: this
      });
    }
    return startWeaponAttack({ token: this.token, weapon: item, actionKey, weaponFunctionId });
  }

  static #onRollSkill(event, target) {
    event.preventDefault();
    const skillKey = target.dataset.skillKey ?? "";
    if (!skillKey) return undefined;
    return requestSkillCheck({
      actor: this.actor,
      skillKey,
      animate: true,
      prompt: true,
      requester: "tokenHud"
    });
  }

  static #onOpenItem(event, target) {
    event.preventDefault();
    if (!isMiddleMouseClick(event)) return undefined;
    const item = this.actor?.items.get(target.dataset.itemId ?? "");
    return item?.sheet?.render(true);
  }

  static async #onUseItem(event, target) {
    event.preventDefault();
    const item = this.actor?.items.get(target.dataset.itemId ?? "");
    if (!item) return undefined;
    if (isMiddleMouseClick(event)) return item.sheet?.render(true);
    if (event.button !== 0) return undefined;
    if (!isActiveItem(item)) return undefined;
    const targetData = getFirstHudTarget();
    const targetActor = targetData.actor ?? this.actor;
    if (!targetActor) return undefined;
    const used = await useFirstAidItem({
      sourceActor: this.actor,
      sourceToken: this.token,
      targetActor,
      targetToken: targetData.token ?? this.token,
      item
    });
    if (used) {
      return this.render({ force: true });
    }
    return undefined;
  }

  static #onUseSystemAction(event, target) {
    event.preventDefault();
    const key = String(target.dataset.systemActionKey ?? "");
    if (!["advancement", "medicine", "repair", "search", "trade", "craft", "stealth"].includes(key)) return undefined;

    if (key === "advancement") {
      if (!this.actor?.isOwner) return undefined;
      this.#activeTray = "";
      void this.render({ force: true });
      return new AdvancementApplication(this.actor).render(true);
    }
    void this.render({ force: true });
    if (key === "craft") return openCraftWindow({ actor: this.actor });
    if (key === "stealth") return openStealthWindow(this.token);
    if (key === "trade") return this.#requestTradeInventory();
    if (key === "search") return this.#openSearchInventory();
    if (key === "repair") return requestRepairTarget(this.token);
    return requestMedicineTarget(this.token);
  }

  #openSearchInventory() {
    const targetData = getFirstHudTarget();
    const targetActor = targetData.actor;
    if (!targetActor) {
      ui.notifications.warn("Для обыска выберите цель.");
      return undefined;
    }
    if (targetActor.uuid === this.actor?.uuid) {
      ui.notifications.warn("Нужна другая цель для обыска.");
      return undefined;
    }

    void this.render({ force: true });
    return openSearchInventoryWindow({
      searcherActor: this.actor,
      searchedActor: targetActor
    });
  }

  #requestTradeInventory() {
    const targetData = getFirstHudTarget();
    const targetActor = targetData.actor;
    if (!targetActor) {
      ui.notifications.warn("Для торговли выберите цель.");
      return undefined;
    }
    if (targetActor.uuid === this.actor?.uuid) {
      ui.notifications.warn("Нужна другая цель для торговли.");
      return undefined;
    }

    void this.render({ force: true });
    return requestTradeInventoryWindow({
      traderActor: this.actor,
      tradeActor: targetActor
    });
  }

  #activateLimbControlClicks() {
    const root = this.element;
    if (!root || root.dataset.limbControlClicksBound === "true") return;
    root.dataset.limbControlClicksBound = "true";
    root.addEventListener("click", event => this.#onLimbControlClick(event), { capture: true });
    root.addEventListener("keydown", event => this.#onLimbControlKeyDown(event), { capture: true });
  }

  #onHudItemMiddlePointerDown(event) {
    if (event.button !== 1 || !this.#getHudItemActionElement(event.target)) return;
    event.preventDefault();
  }

  #onHudItemTooltipHudActivation(event) {
    if (!this.#itemTooltipSuppressHudActivation) return;
    if (this.#itemTooltipElement?.contains(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  #onHudContextMenu(event) {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest('[data-action="toggleWeaponActions"][data-item-id]');
    if (!button || !this.element?.contains(button)) return;
    event.preventDefault();
    event.stopPropagation();
    const item = this.actor?.items.get(String(button.dataset.itemId ?? ""));
    if (!item) return;
    if (this.#itemTooltipElement && this.#itemTooltipItemId === item.id) {
      this.#clearHudItemTooltip();
      return;
    }
    this.#itemTooltipBaseMode = Boolean(event.altKey);
    this.#itemTooltipWeaponTabIndex = 0;
    void this.#showHudItemTooltip(item, button, { pinned: true });
  }

  #onHudItemTooltipMouseOver(event) {
    if (this.#itemTooltipPinned) return;
    const button = this.#getHudTooltipItemElement(event.target);
    if (!button || button.contains(event.relatedTarget)) return;
    const item = this.actor?.items.get(String(button.dataset.hudTooltipItem ?? ""));
    if (!item) return;

    this.#cancelHudItemTooltipClose();
    this.#itemTooltipBaseMode = Boolean(event.altKey);
    this.#itemTooltipWeaponTabIndex = 0;
    this.#itemTooltipAnchorElement = button;
    this.#itemTooltipItemId = item.id;
    if (this.#itemTooltipElement && !this.#itemTooltipPinned) {
      const view = this.element?.ownerDocument?.defaultView ?? window;
      if (this.#itemTooltipTimer) {
        view.clearTimeout(this.#itemTooltipTimer);
        this.#itemTooltipTimer = null;
      }
      this.#clearNestedHudItemTooltip({ force: true });
      void this.#showHudItemTooltip(item, button, { pinned: false, refresh: true });
      return;
    }

    this.#clearHudItemTooltip();
    this.#itemTooltipAnchorElement = button;
    this.#itemTooltipItemId = item.id;
    const view = this.element?.ownerDocument?.defaultView ?? window;
    this.#itemTooltipTimer = view.setTimeout(() => {
      this.#itemTooltipTimer = null;
      void this.#showHudItemTooltip(item, button, { pinned: false });
    }, 300);
  }

  #onHudItemTooltipMouseOut(event) {
    if (this.#itemTooltipPinned) return;
    const button = this.#getHudTooltipItemElement(event.target);
    if (!button || button.contains(event.relatedTarget)) return;
    if (this.#getHudTooltipItemElement(event.relatedTarget)) return;
    if (this.#itemTooltipElement?.contains(event.relatedTarget)) return;
    this.#scheduleHudItemTooltipClose();
  }

  #onLimbLayerOptionClick(event) {
    if (!(event.target instanceof Element)) return;
    const option = event.target.closest("[data-limb-layer-option]");
    if (!option || !this.element?.contains(option)) return;
    event.preventDefault();
    event.stopPropagation();
    option.closest("[data-limb-layer-menu]")?.removeAttribute("open");
    this.#setLimbDisplayLayer(String(option.dataset.limbLayerOption ?? ""));
  }

  #setLimbDisplayLayer(layer) {
    if (!HUD_LIMB_LAYER_KEYS.includes(layer) || layer === this.#limbDisplayLayer) return;
    this.#limbDisplayLayer = layer;
    this.#destroyLimbPopover();
    void this.render({ force: true });
  }

  #getHudItemActionElement(target) {
    if (!(target instanceof Element)) return null;
    const button = target.closest("[data-action][data-item-id]");
    if (!button || !this.element?.contains(button)) return null;
    const action = String(button.dataset.action ?? "");
    return ["openItem", "useItem", "selectHudWeapon", "useWeaponAction", "toggleWeaponActions"].includes(action) ? button : null;
  }

  #getHudTooltipItemElement(target) {
    if (!(target instanceof Element)) return null;
    const button = target.closest("[data-hud-tooltip-item]");
    return button && this.element?.contains(button) ? button : null;
  }

  #onLimbControlKeyDown(event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    this.#onLimbControlClick(event);
  }

  #onLimbControlClick(event) {
    if (!(event.target instanceof Element)) return;
    const limbsBlock = event.target.closest(".fallout-maw-token-hud-limbs");
    if (!limbsBlock || !this.element?.contains(limbsBlock)) return;

    const silhouette = event.target.closest("[data-limb-popover-root]");
    const target = silhouette
      ? getHoveredLimbPart(silhouette, event)
      : event.target.closest("[data-limb-key]");
    if (!target) return;
    if (!game.user?.isGM) return;

    event.preventDefault();
    event.stopPropagation();
    this.#destroyLimbPopover();
    void openLimbDamageDialog(this.actor, target.dataset.limbKey ?? "");
  }

  #onMeterValueInputKeyDown(event) {
    const input = event.target?.closest?.("[data-token-hud-meter-value-input]");
    if (!input || !this.element?.contains(input)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      input.value = String(input.dataset.originalValue ?? input.value ?? "0");
      input.blur();
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    input.blur();
  }

  async #onMeterValueInputChange(event) {
    const input = event.target?.closest?.("[data-token-hud-meter-value-input]");
    if (!input || !this.element?.contains(input)) return;
    if (!game.user?.isGM) return;

    const section = String(input.dataset.section ?? "");
    const key = String(input.dataset.key ?? "");
    if (!HUD_METER_SECTION_KEYS.includes(section) || !this.#editableMeterSections[section] || !key) return;

    const actor = this.actor;
    const data = actor?.system?.[section]?.[key];
    if (!actor || !data) return;

    const min = Math.max(0, toInteger(data.min));
    const max = Math.max(min, toInteger(data.max));
    const value = Math.min(max, Math.max(min, toInteger(input.value)));
    input.value = String(value);
    input.dataset.originalValue = String(value);

    const updates = {
      [`system.${section}.${key}.value`]: value
    };
    if (section === "resources") {
      updates[`system.resources.${key}.spent`] = Math.max(0, max - value);
    }
    await actor.update(updates);
  }

  #onLimbPopoverMove(event) {
    const target = getHoveredLimbPart(event.currentTarget, event);
    if (target === this.#limbPopover.hoveredPart) return;
    this.#limbPopover.hoveredPart = target;
    if (!target) {
      this.#scheduleLimbPopoverClose();
      return;
    }

    this.#clearLimbPopoverTimers();
    const delay = this.#limbPopover.element?.isConnected ? 200 : 400;
    this.#limbPopover.showTimer = window.setTimeout(() => this.#showLimbPopover(target), delay);
  }

  #onLimbPopoverLeaveRoot() {
    this.#limbPopover.hoveredPart = null;
    this.#scheduleLimbPopoverClose();
  }

  async #showHudItemTooltip(item, anchor, { pinned = true, refresh = false } = {}) {
    const tooltipHTML = await renderInventoryItemTooltipHTML(item, this.actor, {
      activeWeaponIndex: this.#itemTooltipWeaponTabIndex,
      baseMode: this.#itemTooltipBaseMode
    });
    if (refresh && this.#itemTooltipItemId !== item.id) return;

    if (refresh && this.#itemTooltipElement && !this.#itemTooltipPinned && !pinned) {
      this.#itemTooltipElement.innerHTML = tooltipHTML;
      this.#itemTooltipElement.classList.remove("pinned");
      this.#itemTooltipElement.style.pointerEvents = "none";
      this.#itemTooltipAnchorElement = anchor;
      this.#itemTooltipItemId = item.id;
      this.#itemTooltipPinned = false;
      this.#positionHudItemTooltip();
      requestAnimationFrame(() => {
        if (!this.#itemTooltipElement) return;
        const description = this.#itemTooltipElement.querySelector(".description");
        description?.classList.toggle("overflowing", description.clientHeight < description.scrollHeight);
        this.#positionHudItemTooltip();
      });
      return;
    }

    this.#clearHudItemTooltip();
    const tooltip = document.createElement("aside");
    tooltip.className = "fallout-maw-inventory-tooltip";
    tooltip.classList.toggle("pinned", Boolean(pinned));
    tooltip.style.setProperty("--fallout-maw-ui-scale", String(tokenActionHudScaleFactor(getTokenActionHudScalePercent())));
    tooltip.style.pointerEvents = pinned ? "auto" : "none";
    tooltip.innerHTML = tooltipHTML;
    tooltip.addEventListener("click", event => this.#onHudItemTooltipClick(event));
    tooltip.addEventListener("pointerover", event => this.#onHudItemTooltipPointerOver(event));
    tooltip.addEventListener("pointerout", event => this.#onHudItemTooltipPointerOut(event));
    tooltip.addEventListener("auxclick", event => this.#onHudItemTooltipAuxClick(event));
    tooltip.addEventListener("contextmenu", event => this.#onHudItemTooltipContextMenu(event));
    tooltip.addEventListener("mouseleave", event => {
      if (this.#itemTooltipPinned) return;
      if (this.#itemTooltipAnchorElement?.contains(event.relatedTarget)) return;
      if (this.#itemTooltipNestedElement?.contains(event.relatedTarget)) return;
      this.#scheduleHudItemTooltipClose();
    });
    document.body.append(tooltip);
    this.#itemTooltipElement = tooltip;
    this.#itemTooltipAnchorElement = anchor;
    this.#itemTooltipItemId = item.id;
    this.#itemTooltipPinned = Boolean(pinned);
    if (pinned) this.#bindHudItemTooltipDocumentListeners();
    this.#positionHudItemTooltip();
    requestAnimationFrame(() => {
      const description = tooltip.querySelector(".description");
      description?.classList.toggle("overflowing", description.clientHeight < description.scrollHeight);
      this.#positionHudItemTooltip();
    });
  }

  async #refreshHudItemTooltip() {
    if (!this.#itemTooltipElement || !this.#itemTooltipItemId) return;
    const item = this.actor?.items.get(this.#itemTooltipItemId);
    if (!item) return this.#clearHudItemTooltip();
    this.#clearNestedHudItemTooltip({ force: true });
    this.#itemTooltipElement.innerHTML = await renderInventoryItemTooltipHTML(item, this.actor, {
      activeWeaponIndex: this.#itemTooltipWeaponTabIndex,
      baseMode: this.#itemTooltipBaseMode
    });
    this.#itemTooltipElement.style.pointerEvents = this.#itemTooltipPinned ? "auto" : "none";
    this.#clampHudItemTooltipToViewport(this.#itemTooltipElement);
    requestAnimationFrame(() => {
      if (!this.#itemTooltipElement) return;
      const description = this.#itemTooltipElement.querySelector(".description");
      description?.classList.toggle("overflowing", description.clientHeight < description.scrollHeight);
      this.#clampHudItemTooltipToViewport(this.#itemTooltipElement);
    });
  }

  async #onHudItemTooltipClick(event) {
    const nestedAnchor = event.target?.closest?.("[data-fallout-maw-nested-tooltip-html]");
    if (!nestedAnchor) {
      this.#clearNestedHudItemTooltip({ force: true });
    }

    const moduleRemove = event.target?.closest?.("[data-tooltip-module-remove]");
    if (moduleRemove && this.#itemTooltipElement?.contains(moduleRemove)) {
      event.preventDefault();
      event.stopPropagation();
      await this.#removeHudWeaponModule(moduleRemove);
      return;
    }

    const moduleChoice = event.target?.closest?.("[data-tooltip-module-choice]");
    if (moduleChoice && this.#itemTooltipElement?.contains(moduleChoice)) {
      if (nestedAnchor && moduleChoice.contains(nestedAnchor)) return;
      event.preventDefault();
      event.stopPropagation();
      await this.#installHudWeaponModuleFromTooltipChoice(moduleChoice);
      return;
    }

    const moduleSlot = event.target?.closest?.("[data-tooltip-module-slot]");
    if (moduleSlot && this.#itemTooltipElement?.contains(moduleSlot)) {
      event.preventDefault();
      event.stopPropagation();
      this.#toggleHudWeaponModulePicker(moduleSlot);
      return;
    }

    const button = event.target?.closest?.("[data-tooltip-weapon-tab]");
    if (!button || !this.#itemTooltipElement?.contains(button)) return;
    event.preventDefault();
    event.stopPropagation();
    const index = Math.max(0, toInteger(button.dataset.tooltipWeaponTab));
    if (index === this.#itemTooltipWeaponTabIndex) return;
    this.#itemTooltipWeaponTabIndex = index;
    this.#activateHudItemTooltipWeaponTab(index);
  }

  #onHudItemTooltipPointerOver(event) {
    const anchor = event.target?.closest?.("[data-fallout-maw-nested-tooltip-html]");
    if (!anchor || !this.#itemTooltipElement?.contains(anchor)) return;
    this.#cancelNestedHudItemTooltipClose();
    if (this.#itemTooltipNestedPinned) return;
    if (this.#itemTooltipNestedElement && this.#itemTooltipNestedAnchorElement === anchor) return;
    this.#showNestedHudItemTooltip(anchor);
  }

  #onHudItemTooltipPointerOut(event) {
    const anchor = event.target?.closest?.("[data-fallout-maw-nested-tooltip-html]");
    if (!anchor || !this.#itemTooltipElement?.contains(anchor)) return;
    if (anchor.contains(event.relatedTarget) || this.#itemTooltipNestedElement?.contains(event.relatedTarget)) return;
    this.#scheduleNestedHudItemTooltipClose();
  }

  #onHudItemTooltipAuxClick(event) {
    if (event.button !== 1) return;
    const anchor = event.target?.closest?.("[data-fallout-maw-nested-tooltip-html]");
    if (!anchor || !this.#itemTooltipElement?.contains(anchor)) return;
    event.preventDefault();
    event.stopPropagation();
    if (this.#itemTooltipNestedElement && this.#itemTooltipNestedAnchorElement === anchor) {
      this.#pinNestedHudItemTooltip();
    } else {
      this.#showNestedHudItemTooltip(anchor, { pinned: true });
    }
  }

  async #onHudItemTooltipContextMenu(event) {
    const moduleSlot = event.target?.closest?.("[data-tooltip-module-slot]");
    if (!moduleSlot || !this.#itemTooltipElement?.contains(moduleSlot)) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  #toggleHudWeaponModulePicker(slotElement) {
    const weaponIndex = Math.max(0, toInteger(slotElement?.dataset?.tooltipWeaponIndex));
    const slotIndex = Math.max(0, toInteger(slotElement?.dataset?.tooltipModuleSlotIndex));
    const panelKey = `${weaponIndex}:${slotIndex}`;
    const panel = this.#itemTooltipElement?.querySelector(`[data-tooltip-module-picker-panel="${CSS.escape(panelKey)}"]`);
    if (!panel) return;
    const wasActive = panel.classList.contains("active");
    this.#itemTooltipElement.querySelectorAll("[data-tooltip-module-picker-panel]").forEach(entry => entry.classList.remove("active"));
    this.#itemTooltipElement.querySelectorAll("[data-tooltip-module-slot]").forEach(entry => entry.classList.remove("selecting"));
    if (wasActive) {
      this.#clampHudItemTooltipToViewport(this.#itemTooltipElement);
      return;
    }
    panel.classList.add("active");
    slotElement.classList.add("selecting");
    requestAnimationFrame(() => this.#clampHudItemTooltipToViewport(this.#itemTooltipElement));
  }

  #activateHudItemTooltipWeaponTab(index) {
    if (!this.#itemTooltipElement) return;
    this.#itemTooltipElement.querySelectorAll("[data-tooltip-weapon-tab]").forEach(button => {
      const active = toInteger(button.dataset.tooltipWeaponTab) === index;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    this.#itemTooltipElement.querySelectorAll("[data-tooltip-weapon-panel]").forEach(panel => {
      panel.classList.toggle("active", toInteger(panel.dataset.tooltipWeaponPanel) === index);
    });
    this.#clampHudItemTooltipToViewport(this.#itemTooltipElement);
  }

  async #installHudWeaponModuleFromTooltipChoice(choiceElement) {
    const { weapon, entries, weaponIndex, slotIndex } = this.#getHudWeaponModuleSlotContext(choiceElement);
    const moduleItem = this.actor.items.get(String(choiceElement?.dataset?.tooltipModuleChoice ?? ""));
    if (!weapon || !moduleItem) return undefined;
    return this.#installHudWeaponModule(weapon, entries[weaponIndex], slotIndex, moduleItem);
  }

  async #removeHudWeaponModule(slotElement) {
    const { weapon, entry, slotIndex, slot } = this.#getHudWeaponModuleSlotContext(slotElement);
    const itemData = getWeaponModuleSlotItemData(slot);
    if (!weapon || !entry || !itemData?.system) return undefined;
    return this.#uninstallHudWeaponModule(weapon, entry, slotIndex, itemData);
  }

  #getHudWeaponModuleSlotContext(slotElement) {
    const weapon = this.#itemTooltipItemId ? this.actor?.items.get(this.#itemTooltipItemId) : null;
    const entries = weapon ? getEnabledWeaponFunctions(weapon) : [];
    const weaponIndex = Math.max(0, toInteger(slotElement?.dataset?.tooltipWeaponIndex));
    const slotIndex = Math.max(0, toInteger(slotElement?.dataset?.tooltipModuleSlotIndex));
    const entry = entries[weaponIndex] ?? null;
    const slot = entry?.canHaveModuleSlots ? getWeaponModuleSlots(entry?.data ?? {})[slotIndex] ?? null : null;
    return { weapon, entries, entry, weaponIndex, slotIndex, slot };
  }

  async #installHudWeaponModule(weapon, entry, slotIndex, moduleItem) {
    const path = getWeaponFunctionPath(weapon, entry?.isPrimary ? ITEM_FUNCTIONS.weapon : entry?.id);
    const slots = getWeaponModuleSlots(entry?.data ?? {});
    const slot = slots[slotIndex];
    if (!slot || !isModuleItemCompatibleWithSlot(moduleItem, slot)) return undefined;
    const oldItemData = getWeaponModuleSlotItemData(slot);

    const itemData = moduleItem.toObject();
    delete itemData._id;
    foundry.utils.setProperty(itemData, "system.quantity", 1);
    slots[slotIndex] = { ...slot, itemUuid: moduleItem.uuid, itemData };
    await weapon.update({ [`${path}.moduleSlots`]: slots });
    if (oldItemData?.system) await returnModuleItemToActorInventory(this.actor, oldItemData);
    const quantity = getItemQuantity(moduleItem);
    if (quantity > 1) await moduleItem.update({ "system.quantity": quantity - 1 });
    else await moduleItem.delete();
    this.#restoreHudModuleSlotsTab(weapon.id);
    return this.#refreshHudItemTooltip();
  }

  async #uninstallHudWeaponModule(weapon, entry, slotIndex, itemData) {
    const path = getWeaponFunctionPath(weapon, entry?.isPrimary ? ITEM_FUNCTIONS.weapon : entry?.id);
    const slots = getWeaponModuleSlots(entry?.data ?? {});
    const slot = slots[slotIndex];
    if (!slot) return undefined;
    slots[slotIndex] = { ...slot, itemUuid: "", itemData: {} };
    await weapon.update({ [`${path}.moduleSlots`]: slots });
    await returnModuleItemToActorInventory(this.actor, itemData);
    this.#restoreHudModuleSlotsTab(weapon.id);
    return this.#refreshHudItemTooltip();
  }

  #restoreHudModuleSlotsTab(weaponId = "") {
    const weapon = this.actor?.items.get(String(weaponId ?? ""));
    if (!weapon) return;
    this.#itemTooltipWeaponTabIndex = getEnabledWeaponFunctions(weapon).length;
  }

  #showNestedHudItemTooltip(anchor, { pinned = false } = {}) {
    const html = String(anchor?.dataset?.falloutMawNestedTooltipHtml ?? "").trim();
    if (!html) return;
    if (this.#itemTooltipNestedElement && this.#itemTooltipNestedAnchorElement === anchor) {
      if (pinned) this.#pinNestedHudItemTooltip();
      return;
    }
    this.#clearNestedHudItemTooltip({ force: true });

    const tooltip = document.createElement("aside");
    const tooltipClass = String(anchor.dataset.falloutMawNestedTooltipClass || "fallout-maw-inventory-tooltip fallout-maw-module-item-tooltip");
    tooltip.className = `${tooltipClass} fallout-maw-nested-tooltip`;
    tooltip.classList.toggle("pinned", Boolean(pinned));
    tooltip.style.setProperty("--fallout-maw-ui-scale", String(tokenActionHudScaleFactor(getTokenActionHudScalePercent())));
    tooltip.innerHTML = html;
    tooltip.addEventListener("pointerenter", () => this.#cancelNestedHudItemTooltipClose());
    tooltip.addEventListener("pointerleave", event => {
      if (this.#itemTooltipNestedPinned) return;
      if (this.#itemTooltipNestedAnchorElement?.contains(event.relatedTarget)) return;
      this.#scheduleNestedHudItemTooltipClose();
    });
    tooltip.addEventListener("auxclick", event => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      this.#itemTooltipNestedPinned = true;
      tooltip.classList.add("pinned");
    });

    document.body.append(tooltip);
    this.#itemTooltipNestedElement = tooltip;
    this.#itemTooltipNestedAnchorElement = anchor;
    this.#itemTooltipNestedPinned = Boolean(pinned);
    this.#positionNestedHudItemTooltip();
    requestAnimationFrame(() => {
      if (!this.#itemTooltipNestedElement) return;
      const description = this.#itemTooltipNestedElement.querySelector(".description");
      description?.classList.toggle("overflowing", description.clientHeight < description.scrollHeight);
      this.#positionNestedHudItemTooltip();
    });
  }

  #pinNestedHudItemTooltip() {
    this.#cancelNestedHudItemTooltipClose();
    this.#itemTooltipNestedPinned = true;
    this.#itemTooltipNestedElement?.classList.add("pinned");
  }

  #positionNestedHudItemTooltip() {
    const tooltip = this.#itemTooltipNestedElement;
    const anchor = this.#itemTooltipNestedAnchorElement;
    if (!tooltip || !anchor?.isConnected) return;
    const view = this.element?.ownerDocument?.defaultView ?? window;
    const margin = 10;
    const gap = 12;
    this.#syncHudItemTooltipAvailableHeight(tooltip, view.innerHeight, margin);

    const anchorRect = anchor.getBoundingClientRect();
    const parentRect = this.#itemTooltipElement?.getBoundingClientRect();
    let rect = tooltip.getBoundingClientRect();
    let left = (parentRect?.right ?? anchorRect.right) + gap;
    if ((left + rect.width) > (view.innerWidth - margin)) {
      left = (parentRect?.left ?? anchorRect.left) - rect.width - gap;
    }
    left = Math.max(margin, Math.min(view.innerWidth - rect.width - margin, left));
    let top = anchorRect.top + ((anchorRect.height - rect.height) / 2);
    top = Math.max(margin, Math.min(view.innerHeight - rect.height - margin, top));
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(top)}px`;

    this.#syncHudItemTooltipAvailableHeight(tooltip, view.innerHeight, margin);
    rect = tooltip.getBoundingClientRect();
    if ((rect.top + rect.height) > (view.innerHeight - margin)) {
      tooltip.style.top = `${Math.round(Math.max(margin, view.innerHeight - rect.height - margin))}px`;
    }
  }

  #scheduleNestedHudItemTooltipClose() {
    if (this.#itemTooltipNestedPinned || this.#itemTooltipNestedCloseTimer) return;
    const view = this.element?.ownerDocument?.defaultView ?? window;
    this.#itemTooltipNestedCloseTimer = view.setTimeout(() => {
      this.#itemTooltipNestedCloseTimer = null;
      this.#clearNestedHudItemTooltip();
    }, 120);
  }

  #cancelNestedHudItemTooltipClose() {
    if (!this.#itemTooltipNestedCloseTimer) return;
    const view = this.element?.ownerDocument?.defaultView ?? window;
    view.clearTimeout(this.#itemTooltipNestedCloseTimer);
    this.#itemTooltipNestedCloseTimer = null;
  }

  #scheduleHudItemTooltipClose() {
    if (this.#itemTooltipPinned || this.#itemTooltipCloseTimer) return;
    const view = this.element?.ownerDocument?.defaultView ?? window;
    this.#itemTooltipCloseTimer = view.setTimeout(() => {
      this.#itemTooltipCloseTimer = null;
      this.#clearHudItemTooltip();
    }, 160);
  }

  #cancelHudItemTooltipClose() {
    if (!this.#itemTooltipCloseTimer) return;
    const view = this.element?.ownerDocument?.defaultView ?? window;
    view.clearTimeout(this.#itemTooltipCloseTimer);
    this.#itemTooltipCloseTimer = null;
  }

  #clearNestedHudItemTooltip({ force = false } = {}) {
    this.#cancelNestedHudItemTooltipClose();
    if (this.#itemTooltipNestedPinned && !force) return;
    this.#itemTooltipNestedElement?.remove();
    this.#itemTooltipNestedElement = null;
    this.#itemTooltipNestedAnchorElement = null;
    this.#itemTooltipNestedPinned = false;
  }

  #positionHudItemTooltip() {
    const tooltip = this.#itemTooltipElement;
    const anchor = this.#itemTooltipAnchorElement;
    if (!tooltip || !anchor?.isConnected) return;
    const view = this.element?.ownerDocument?.defaultView ?? window;
    const anchorRect = anchor.getBoundingClientRect();
    const margin = 10;
    const gap = 12;
    this.#syncHudItemTooltipAvailableHeight(tooltip, view.innerHeight, margin);
    let tooltipRect = tooltip.getBoundingClientRect();
    let left = anchorRect.left + ((anchorRect.width - tooltipRect.width) / 2);
    left = Math.max(margin, Math.min(view.innerWidth - tooltipRect.width - margin, left));
    let top = anchorRect.top - tooltipRect.height - gap;
    if (top < margin) top = Math.min(view.innerHeight - tooltipRect.height - margin, anchorRect.bottom + gap);
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(Math.max(margin, top))}px`;
    tooltip.dataset.tooltipDirection = "hud";
    this.#syncHudItemTooltipAvailableHeight(tooltip, view.innerHeight, margin);
    tooltipRect = tooltip.getBoundingClientRect();
    if ((tooltipRect.top + tooltipRect.height) > (view.innerHeight - margin)) {
      tooltip.style.top = `${Math.round(Math.max(margin, view.innerHeight - tooltipRect.height - margin))}px`;
    }
  }

  #clampHudItemTooltipToViewport(tooltip) {
    if (!tooltip) return;
    const view = this.element?.ownerDocument?.defaultView ?? window;
    const margin = 10;
    this.#syncHudItemTooltipAvailableHeight(tooltip, view.innerHeight, margin);
    const rect = tooltip.getBoundingClientRect();
    let left = Number.parseFloat(tooltip.style.left);
    let top = Number.parseFloat(tooltip.style.top);
    if (!Number.isFinite(left)) left = rect.left;
    if (!Number.isFinite(top)) top = rect.top;
    left = Math.max(margin, Math.min(view.innerWidth - rect.width - margin, left));
    top = Math.max(margin, Math.min(view.innerHeight - rect.height - margin, top));
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(top)}px`;
  }

  #syncHudItemTooltipAvailableHeight(tooltip, viewportHeight, margin) {
    if (!tooltip) return;
    const style = getComputedStyle(tooltip);
    const scale = Math.max(0.1, Number.parseFloat(style.getPropertyValue("--fallout-maw-ui-scale")) || 1);
    const maxTooltipHeight = Math.max(220, Math.floor((viewportHeight - (margin * 2)) / scale));
    tooltip.style.setProperty("--fallout-maw-tooltip-max-height", `${maxTooltipHeight}px`);

    const picker = tooltip.querySelector(".tooltip-module-picker-panels:has(.tooltip-module-picker-panel.active)");
    if (!picker) {
      tooltip.style.removeProperty("--fallout-maw-module-picker-max-height");
      return;
    }

    const tooltipRect = tooltip.getBoundingClientRect();
    const pickerRect = picker.getBoundingClientRect();
    const nonPickerHeight = Math.max(0, tooltipRect.height - pickerRect.height);
    const maxPickerHeight = Math.max(160, Math.floor((viewportHeight - (margin * 2) - nonPickerHeight) / scale));
    tooltip.style.setProperty("--fallout-maw-module-picker-max-height", `${maxPickerHeight}px`);
  }

  #bindHudItemTooltipDocumentListeners() {
    const view = this.element?.ownerDocument?.defaultView ?? window;
    if (!this.#itemTooltipPointerDownHandler) {
      this.#itemTooltipPointerDownHandler = event => {
        const insideParentTooltip = this.#itemTooltipElement?.contains(event.target);
        const insideNestedTooltip = this.#itemTooltipNestedElement?.contains(event.target);
        if (event.button === 1 && (insideParentTooltip || insideNestedTooltip)) {
          event.preventDefault();
          return;
        }
        if (insideNestedTooltip) return;
        if (insideParentTooltip) {
          this.#clearNestedHudItemTooltip({ force: true });
          return;
        }
        if (this.element?.contains?.(event.target)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          this.#suppressNextHudItemTooltipActivation();
        }
        this.#clearHudItemTooltip();
      };
      view.document.addEventListener("pointerdown", this.#itemTooltipPointerDownHandler, { capture: true });
    }
    if (!this.#itemTooltipKeyHandler) {
      this.#itemTooltipKeyHandler = event => {
        if (event.key === "Escape") return this.#clearHudItemTooltip();
        if (event.key !== "Alt") return undefined;
        const baseMode = event.type === "keydown";
        if (this.#itemTooltipBaseMode === baseMode) return undefined;
        this.#itemTooltipBaseMode = baseMode;
        void this.#refreshHudItemTooltip();
        return undefined;
      };
      view.document.addEventListener("keydown", this.#itemTooltipKeyHandler, { capture: true });
      view.document.addEventListener("keyup", this.#itemTooltipKeyHandler, { capture: true });
    }
  }

  #clearHudItemTooltip() {
    const view = this.element?.ownerDocument?.defaultView ?? window;
    if (this.#itemTooltipTimer) {
      view.clearTimeout(this.#itemTooltipTimer);
      this.#itemTooltipTimer = null;
    }
    this.#cancelHudItemTooltipClose();
    if (this.#itemTooltipPointerDownHandler) {
      view.document.removeEventListener("pointerdown", this.#itemTooltipPointerDownHandler, { capture: true });
      this.#itemTooltipPointerDownHandler = null;
    }
    if (this.#itemTooltipKeyHandler) {
      view.document.removeEventListener("keydown", this.#itemTooltipKeyHandler, { capture: true });
      view.document.removeEventListener("keyup", this.#itemTooltipKeyHandler, { capture: true });
      this.#itemTooltipKeyHandler = null;
    }
    this.#clearNestedHudItemTooltip({ force: true });
    this.#itemTooltipElement?.remove();
    this.#itemTooltipElement = null;
    this.#itemTooltipAnchorElement = null;
    this.#itemTooltipItemId = "";
    this.#itemTooltipPinned = false;
    this.#itemTooltipWeaponTabIndex = 0;
    this.#itemTooltipBaseMode = false;
  }

  #suppressNextHudItemTooltipActivation() {
    const view = this.element?.ownerDocument?.defaultView ?? window;
    this.#itemTooltipSuppressHudActivation = true;
    if (this.#itemTooltipSuppressHudActivationTimer) view.clearTimeout(this.#itemTooltipSuppressHudActivationTimer);
    this.#itemTooltipSuppressHudActivationTimer = view.setTimeout(() => {
      this.#itemTooltipSuppressHudActivation = false;
      this.#itemTooltipSuppressHudActivationTimer = null;
    }, 250);
  }

  #clearHudItemTooltipActivationSuppression() {
    const view = this.element?.ownerDocument?.defaultView ?? window;
    this.#itemTooltipSuppressHudActivation = false;
    if (!this.#itemTooltipSuppressHudActivationTimer) return;
    view.clearTimeout(this.#itemTooltipSuppressHudActivationTimer);
    this.#itemTooltipSuppressHudActivationTimer = null;
  }

  #scheduleLimbPopoverClose() {
    if (this.#limbPopover.showTimer) {
      window.clearTimeout(this.#limbPopover.showTimer);
      this.#limbPopover.showTimer = null;
    }
    this.#limbPopover.hideTimer = window.setTimeout(() => this.#destroyLimbPopover(), 200);
  }

  #showLimbPopover(target) {
    if (!target?.isConnected) return;
    this.#clearLimbPopoverTimers();
    const label = String(target.dataset.label ?? "");
    const value = String(target.dataset.value ?? "0");
    const max = String(target.dataset.max ?? "0");
    const rows = parseLimbPopoverRows(target);

    const element = this.#limbPopover.element ?? document.createElement("div");
    element.className = "fallout-maw fallout-maw-token-hud-limb-popover";
    element.replaceChildren();
    const title = document.createElement("div");
    title.className = "fallout-maw-token-hud-limb-popover-title";
    title.textContent = label;
    element.append(title);
    if (rows.length) {
      for (const row of rows) {
        const valueRow = document.createElement("div");
        valueRow.className = "fallout-maw-token-hud-limb-popover-row";
        const rowLabel = document.createElement("span");
        rowLabel.textContent = String(row.label ?? "");
        const rowValue = document.createElement("strong");
        rowValue.textContent = String(row.value ?? "");
        valueRow.append(rowLabel, rowValue);
        element.append(valueRow);
      }
    } else {
      const valueRow = document.createElement("div");
      valueRow.className = "fallout-maw-token-hud-limb-popover-value";
      valueRow.textContent = max ? `${value} / ${max}` : value;
      element.append(valueRow);
    }
    document.body.append(element);
    this.#limbPopover.element = element;
    positionLimbPopover(element, target);
  }

  #clearLimbPopoverTimers() {
    if (this.#limbPopover.showTimer) window.clearTimeout(this.#limbPopover.showTimer);
    if (this.#limbPopover.hideTimer) window.clearTimeout(this.#limbPopover.hideTimer);
    this.#limbPopover.showTimer = null;
    this.#limbPopover.hideTimer = null;
  }

  #destroyLimbPopover() {
    this.#clearLimbPopoverTimers();
    this.#limbPopover.element?.remove();
    this.#limbPopover.element = null;
    this.#limbPopover.hoveredPart = null;
    this.#limbPopover.boundRoot = null;
  }

}

function prepareMeterSectionStates(editable = {}) {
  const collapsed = getTokenActionHudCollapsedSections();
  return {
    resources: prepareMeterSectionState(collapsed.resources, editable.resources),
    needs: prepareMeterSectionState(collapsed.needs, editable.needs)
  };
}

function prepareMeterSectionState(collapsed, editable) {
  return {
    collapsed: Boolean(collapsed),
    expanded: !collapsed,
    editable: Boolean(editable)
  };
}

function getTokenActionHudCollapsedSections() {
  try {
    const value = game.settings.get(FALLOUT_MAW.id, TOKEN_ACTION_HUD_COLLAPSED_SECTIONS_SETTING);
    return HUD_METER_SECTION_KEYS.reduce((result, key) => {
      result[key] = Boolean(value?.[key]);
      return result;
    }, {});
  } catch (_error) {
    return HUD_METER_SECTION_KEYS.reduce((result, key) => {
      result[key] = false;
      return result;
    }, {});
  }
}

function applyMeterSectionCollapsedState(element, section, collapsed) {
  const sectionElement = element?.querySelector(`[data-token-hud-meter-section="${section}"]`);
  if (!sectionElement) return;
  sectionElement.classList.toggle("collapsed", collapsed);
  const button = sectionElement.querySelector("[data-token-hud-meter-toggle]");
  button?.setAttribute("aria-expanded", String(!collapsed));
}

class TokenActionHudScaleSettings extends FalloutMaWFormApplicationV2 {
  #lastPreviewPercent = null;

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-token-action-hud-scale-settings",
    classes: ["fallout-maw", "fallout-maw-config-form", "fallout-maw-token-action-hud-scale-settings"],
    position: {
      width: 380,
      height: "auto"
    },
    window: {
      resizable: false
    },
    form: {
      handler: TokenActionHudScaleSettings.handleFormSubmit,
      submitOnChange: false,
      closeOnSubmit: true
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.tokenActionHudScaleSettings
    }
  };

  get title() {
    return game.i18n.localize("FALLOUTMAW.Settings.HUD.Scale");
  }

  async _prepareContext(options) {
    const scale = tokenActionHudPreviewPercent ?? getTokenActionHudScalePercent();
    return {
      ...(await super._prepareContext(options)),
      scale,
      min: TOKEN_ACTION_HUD_SCALE_MIN,
      max: TOKEN_ACTION_HUD_SCALE_MAX
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const range = this.element?.querySelector("[data-token-action-hud-scale]");
    const output = this.element?.querySelector("[data-token-action-hud-scale-output]");
    range?.addEventListener("input", event => this.#previewScale(event.currentTarget, output));
  }

  async _onClose(options) {
    await super._onClose(options);
    tokenActionHudScaleSettings = null;
    applyTokenActionHudScale(getTokenActionHudScalePercent());
  }

  async _processFormData(_event, _form, formData) {
    const data = getFlatFormData(formData);
    const scale = normalizeTokenActionHudScalePercent(data.scale);
    await game.settings.set(FALLOUT_MAW.id, TOKEN_ACTION_HUD_SCALE_SETTING, scale);
    applyTokenActionHudScale(scale);
  }

  #previewScale(range, output) {
    const scale = normalizeTokenActionHudScalePercent(range?.value);
    if (scale === this.#lastPreviewPercent) return;
    this.#lastPreviewPercent = scale;
    if (output) output.textContent = `${scale}%`;
    applyTokenActionHudScale(scale);
  }
}

function prepareLimbLayerContext(activeLayer = "state") {
  const active = HUD_LIMB_LAYER_KEYS.includes(activeLayer) ? activeLayer : "state";
  return {
    key: active,
    label: HUD_LIMB_LAYER_CHOICES.find(layer => layer.key === active)?.label ?? "Состояние",
    choices: HUD_LIMB_LAYER_CHOICES.filter(layer => HUD_LIMB_LAYER_KEYS.includes(layer.key)).map(layer => ({
      ...layer,
      selected: layer.key === active
    }))
  };
}

function prepareDisplayLimbs(actor, layer = "state") {
  const baseLimbs = Object.fromEntries(Object.entries(actor.system?.limbs ?? {}).map(([key, limb]) => [
    key,
    prepareLimbDisplayData(actor, key, limb)
  ]));
  if (layer === "defense" || layer === "resistance") return prepareMitigationLayerLimbs(actor, baseLimbs, layer);
  return baseLimbs;
}

function prepareMitigationLayerLimbs(actor, limbs = {}, layer = "defense") {
  const damageTypes = getDamageTypeSettings();
  const source = layer === "resistance" ? actor.system?.damageResistances : actor.system?.damageDefenses;
  return Object.fromEntries(Object.entries(limbs ?? {}).map(([key, limb]) => {
    const rows = damageTypes.map(damageType => {
      const value = toInteger(source?.[key]?.[damageType.key]);
      return {
        label: String(damageType.label ?? damageType.key),
        value,
        display: formatSignedNumber(value)
      };
    });
    const score = averageMitigationValue(rows.map(row => row.value));
    return [key, {
      ...limb,
      fill: getMitigationLayerColor(score),
      displayValue: formatSignedNumber(score),
      displayMax: "",
      popoverRows: rows.map(row => ({
        label: row.label,
        value: row.display
      }))
    }];
  }));
}

function averageMitigationValue(values = []) {
  if (!values.length) return 0;
  const total = values.reduce((sum, value) => sum + Math.max(-100, Math.min(100, toInteger(value))), 0);
  return Math.round(total / values.length);
}

function getMitigationLayerColor(value) {
  const number = Math.max(-100, Math.min(100, Number(value) || 0));
  if (number > 0) return mixColor([0, 0, 0], [218, 181, 64], number / 100);
  if (number < 0) return mixColor([0, 0, 0], [185, 48, 43], Math.abs(number) / 100);
  return "rgb(0, 0, 0)";
}

function mixColor(from, to, ratio) {
  const t = Math.max(0, Math.min(1, Number(ratio) || 0));
  const channels = from.map((value, index) => Math.round(value + ((to[index] - value) * t)));
  return `rgb(${channels[0]}, ${channels[1]}, ${channels[2]})`;
}

function formatSignedNumber(value) {
  const number = toInteger(value);
  return number > 0 ? `+${number}` : String(number);
}

function parseLimbPopoverRows(target) {
  const text = String(target?.dataset?.popoverRows ?? "").trim();
  if (!text) return [];
  try {
    const rows = JSON.parse(text);
    return Array.isArray(rows) ? rows : [];
  } catch (_error) {
    return [];
  }
}

function prepareLimbDisplayData(actor, limbKey, limb = {}) {
  if (isLimbDestroyed(actor, limbKey)) {
    return {
      ...limb,
      displayValue: "Отсутствует",
      displayMax: "",
      stateLabel: "Отсутствует"
    };
  }
  const max = getLimbHealingCap(actor, limbKey);
  if (max >= toInteger(limb?.max)) return limb;
  return {
    ...limb,
    max,
    scaleMax: limb.max
  };
}

function prepareLimbEntries(limbs = {}) {
  return Object.entries(limbs ?? {}).map(([key, limb]) => prepareIndicatorEntry({
    key,
    label: String(limb?.label ?? key),
    color: "#8f8456",
    data: limb
  }));
}

function prepareResourceEntries(actor) {
  const limited = getResourceLimitState(actor).resources;
  return getResourceSettings().map(resource => prepareIndicatorEntry({
    ...resource,
    data: actor.system.resources?.[resource.key]
  })).map(entry => addLimitedResourceDisplay(entry, limited[entry.key]));
}

function prepareNeedEntries(actor) {
  return getActorNeedSettings(actor).map(need => prepareIndicatorEntry({
    ...need,
    data: actor.system.needs?.[need.key]
  }));
}

function prepareSkillButtons(actor, hudIcons = {}) {
  return getSkillSettings().map(skill => {
    const actorSkill = actor.system.skills?.[skill.key] ?? {};
    return {
      ...skill,
      img: normalizeImagePath(hudIcons.skillIcons?.[skill.key] ?? skill.img),
      value: toInteger(actorSkill.value)
    };
  });
}

function prepareOwnedItemButtons(actor, type, fallbackIcon, { activeOnly = false } = {}) {
  return actor.items
    .filter(item => item.type === type)
    .filter(item => !activeOnly || isActiveItem(item))
    .map(item => {
      const firstAidCharges = getFirstAidChargesData(item);
      return {
        id: item.id,
        name: item.name,
        img: normalizeImagePath(item.img, fallbackIcon),
        quantity: toInteger(item.system?.quantity),
        showQuantity: toInteger(item.system?.maxStack) > 1,
        firstAidCharges,
        showFirstAidCharges: hasItemFunction(item, ITEM_FUNCTIONS.firstAid) && firstAidCharges.max > 1
      };
    });
}

function prepareOwnedAbilityButtons(actor, fallbackIcon) {
  return actor.items
    .filter(item => item.type === "ability")
    .map(item => ({
      id: item.id,
      name: item.name,
      img: normalizeImagePath(item.img, fallbackIcon),
      active: isActiveAbility(item)
    }));
}

function prepareAbilityGroups(abilities = []) {
  return [
    {
      key: "active",
      label: "Активные",
      items: abilities.filter(ability => ability.active),
      emptyLabel: "Активных способностей нет."
    },
    {
      key: "passive",
      label: "Пассивные",
      items: abilities.filter(ability => !ability.active),
      emptyLabel: "Пассивных способностей нет."
    }
  ];
}

function isActiveAbility(item) {
  const system = item?.system ?? {};
  return Boolean(system.active || system.activation?.enabled || system.use?.enabled);
}

function prepareSystemActionButtons() {
  const advancementAction = {
    key: "advancement",
    label: "Повышение уровня",
    img: normalizeImagePath("icons/svg/upgrade.svg", "icons/svg/aura.svg")
  };
  const configuredActions = getSystemActionSettings().map(action => ({
    ...action,
    img: normalizeImagePath(action.img, "icons/svg/aura.svg")
  }));
  return [advancementAction, ...configuredActions];
}

function prepareTrayContext(activeTray, skills, items, abilities, systemActions, weaponActionRows, weaponSet = null, weaponSets = []) {
  const trayItems = activeTray === "skills"
    ? skills
    : activeTray === "items"
      ? items
      : activeTray === "abilities"
        ? abilities
        : activeTray === "actions"
          ? systemActions
          : activeTray === "weaponActions"
            ? weaponActionRows.flatMap(row => row.actions)
            : activeTray === "weaponSets"
              ? weaponSets
              : [];
  return {
    skills,
    items,
    abilities,
    abilityGroups: prepareAbilityGroups(abilities),
    systemActions,
    weaponActionRows,
    weaponSet,
    weaponSets,
    metrics: prepareTrayMetrics(trayItems),
    visible: Boolean(activeTray)
  };
}

function prepareTrayMetrics(_items) {
  return {
    style: ""
  };
}

function prepareActions(activeTray, selectedWeapon, items, abilities, systemActions, hudIcons = {}) {
  return HUD_ACTIONS.filter(action => action.key !== "weapon").map(action => {
    const count = action.key === "items"
      ? items.length
      : action.key === "abilities"
        ? abilities.length
        : action.key === "actions"
          ? systemActions.length
          : 0;
    return {
      ...action,
      active: activeTray === action.key,
      disabled: false,
      icon: normalizeImagePath(hudIcons.mainActions?.[action.key], action.icon),
      caption: action.label,
      count
    };
  });
}

function prepareHudWeaponSet(weaponSets = [], activeSetKey = "", selectedWeaponId = "", hudIcons = {}) {
  return prepareHudWeaponSets(weaponSets, activeSetKey, selectedWeaponId, hudIcons)
    .find(entry => entry.key === activeSetKey) ?? null;
}

function prepareHudWeaponSets(weaponSets = [], activeSetKey = "", selectedWeaponId = "", hudIcons = {}) {
  return weaponSets.map(set => ({
    ...set,
    active: set.key === activeSetKey,
    slots: (set.slots ?? []).map(slot => ({
      ...slot,
      hudAspectStyle: getHudItemAspectStyle(slot.item),
      weaponSetKey: set.key,
      emptyIcon: normalizeImagePath(hudIcons.emptyWeaponSlotIcon, "icons/svg/combat.svg"),
      selected: Boolean(slot.item?.id && !slot.phantom && slot.item.id === selectedWeaponId)
    })),
    weapons: getUniqueHudWeaponSlots(set.slots ?? []).map(slot => ({
      ...slot,
      hudAspectStyle: getHudItemAspectStyle(slot.item),
      weaponSetKey: set.key,
      selected: Boolean(slot.item?.id && slot.item.id === selectedWeaponId)
    }))
  }));
}

function getHudItemAspectStyle(item = null) {
  const cachedAspect = getCachedHudImageAspect(item?.img);
  if (cachedAspect) return `--fallout-maw-hud-image-aspect: ${cachedAspect};`;

  const width = Math.max(1, toInteger(item?.placement?.width));
  const height = Math.max(1, toInteger(item?.placement?.height));
  const aspect = Math.max(1, width / height);
  return `--fallout-maw-hud-image-aspect: ${aspect};`;
}

function getCachedHudImageAspect(src = "") {
  const keys = getHudImageAspectCacheKeys(src);
  for (const key of keys) {
    const value = hudImageAspectCache.get(key);
    if (value) return value;
  }
  return 0;
}

function getUniqueHudWeaponSlots(slots = []) {
  const seen = new Set();
  const entries = [];
  for (const slot of slots) {
    const id = slot.item?.id ?? "";
    if (!id || slot.phantom || seen.has(id)) continue;
    seen.add(id);
    entries.push(slot);
  }
  return entries;
}

function getSelectedHudWeaponSlot(weaponSet = null, selectedWeaponId = "") {
  if (!weaponSet || !selectedWeaponId) return null;
  return (weaponSet.slots ?? []).find(slot => slot.item?.id === selectedWeaponId && !slot.phantom) ?? null;
}

function isHudWeaponDisabled(actor, weapon) {
  const race = getCreatureOptions().races.find(entry => entry.id === actor?.system?.creature?.raceId);
  const inventory = actor ? prepareInventoryContext(actor, race) : { weaponSets: [] };
  const placement = weapon?.system?.placement ?? {};
  const set = (inventory.weaponSets ?? []).find(entry => entry.key === placement.weaponSet);
  const slot = (set?.slots ?? []).find(entry => entry.item?.id === weapon?.id && !entry.phantom);
  return Boolean(slot?.useDisabled);
}

function getActiveHudWeaponSetKey(actor, weaponSets = []) {
  if (!weaponSets.length) return "";
  const selectedSetKey = String(actor.getFlag(FALLOUT_MAW.id, SELECTED_HUD_WEAPON_SET_FLAG) ?? "");
  if (weaponSets.some(set => set.key === selectedSetKey)) return selectedSetKey;

  const selectedId = String(actor.getFlag(FALLOUT_MAW.id, SELECTED_HUD_WEAPON_FLAG) ?? "");
  const selectedSet = selectedId
    ? weaponSets.find(set => (set.slots ?? []).some(slot => slot.item?.id === selectedId && !slot.phantom))
    : null;
  return selectedSet?.key ?? weaponSets[0].key;
}

function getSelectedHudWeapon(actor, weaponSets = [], activeSetKey = "") {
  const set = weaponSets.find(entry => entry.key === activeSetKey) ?? weaponSets[0] ?? null;
  if (!set) return null;
  const selectedId = String(actor.getFlag(FALLOUT_MAW.id, SELECTED_HUD_WEAPON_FLAG) ?? "");
  const weaponIds = (set.slots ?? []).filter(slot => !slot.phantom).map(slot => slot.item?.id).filter(Boolean);
  const resolvedId = weaponIds.includes(selectedId) ? selectedId : weaponIds[0];
  return resolvedId ? actor.items.get(resolvedId) ?? null : null;
}

function isMiddleMouseClick(event) {
  return event?.button === 1;
}

function prepareWeaponActionRows(actor, selectedWeapon, forceDisabled = false, hudIcons = {}) {
  if (!selectedWeapon) return [];
  return getEnabledWeaponFunctions(selectedWeapon)
    .sort((left, right) => {
      if (left.isPrimary === right.isPrimary) return (left.index ?? 0) - (right.index ?? 0);
      return left.isPrimary ? 1 : -1;
    })
    .map((weaponFunction, index) => ({
      id: weaponFunction.id,
      label: weaponFunction.isPrimary
        ? selectedWeapon.name
        : weaponFunction.name || `${game.i18n.localize("FALLOUTMAW.Item.AdditionalWeaponFunction")} ${index + 1}`,
      actions: prepareWeaponActionButtonsForFunction(actor, selectedWeapon, weaponFunction, forceDisabled, hudIcons)
    }))
    .filter(row => row.actions.length);
}

function prepareWeaponActionButtonsForFunction(actor, selectedWeapon, weaponFunction, forceDisabled = false, hudIcons = {}) {
  const weaponData = applyWeaponModuleModifiers(weaponFunction?.data ?? {}, {
    moduleSlots: getWeaponFunctionModuleSlots(selectedWeapon, weaponFunction?.id)
  });
  const actions = weaponData?.availableActions ?? {};
  const hasMagazineCost = hasWeaponResourceCostData(weaponData, "magazine");
  const buttons = [
    { key: "aimedShot", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionAimedShot"), configured: Boolean(actions.aimedShot) },
    { key: "snapshot", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionSnapshot"), configured: Boolean(actions.snapshot) },
    { key: "burst", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionBurst"), configured: Boolean(actions.burst), visible: Boolean(actions.burst) },
    { key: "volley", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionVolley"), configured: Boolean(actions.volley), visible: Boolean(actions.volley) },
    { key: "meleeAttack", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionMeleeAttack"), configured: Boolean(actions.meleeAttack) },
    { key: "aimedMeleeAttack", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionAimedMeleeAttack"), configured: Boolean(actions.aimedMeleeAttack) },
    { key: "reload", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionReload"), configured: hasMagazineCost, visible: hasMagazineCost }
  ];
  return buttons.filter(action => action.visible !== false && action.configured).map(action => {
    const blockState = getWeaponActionBlockState(actor, action.key);
    const actionPointCost = getWeaponActionPointCostForHud(actor, weaponData, action.key);
    return {
      ...action,
      label: String(weaponData?.[action.key]?.name ?? "").trim() || action.label,
      disabled: forceDisabled || blockState.blocked,
      itemId: selectedWeapon.id,
      weaponFunctionId: weaponFunction.isPrimary ? ITEM_FUNCTIONS.weapon : weaponFunction.id,
      img: normalizeImagePath(hudIcons.weaponActions?.[action.key], "icons/svg/combat.svg"),
      actionPointCost,
      actionPointCostLabel: `${actionPointCost} ОД`
    };
  });
}

function getWeaponActionPointCostForHud(actor, weaponData = {}, actionKey = "") {
  const value = Number(weaponData?.[actionKey]?.actionPointCost);
  const fallback = actionKey === "reload" ? 2 : 5;
  const baseCost = Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : fallback;
  return applyDamageCostModifier(baseCost, getDamageCostModifierState(actor, { actionKey }).action);
}

function hasWeaponResourceCostData(weaponData = {}, type = "") {
  if (type === "magazine" && String(weaponData?.damageMode ?? "manual") === "source") return true;
  return (weaponData?.resourceCosts ?? []).some(cost => String(cost?.type ?? "") === type);
}

function updateReloadDialogMagazineReadout(dialog, actor, weaponId, weaponFunctionId) {
  const weapon = actor.items.get(weaponId);
  const el = dialog.element?.querySelector?.("[data-reload-magazine-readout]");
  if (!el || !weapon) return;
  const wd = getWeaponFunctionById(weapon, weaponFunctionId) ?? {};
  const cur = Math.max(0, toInteger(wd?.magazine?.value));
  const max = Math.max(0, toInteger(wd?.magazine?.max));
  el.textContent = `${game.i18n.localize("FALLOUTMAW.Item.WeaponMagazine")}: ${cur} / ${max}`;
}

function updateReloadDialogState(dialog, actor, weaponId, weaponFunctionId) {
  const weapon = actor?.items?.get(weaponId);
  if (!dialog?.element || !weapon) return;
  const weaponData = getWeaponFunctionById(weapon, weaponFunctionId) ?? {};
  const state = buildWeaponReloadDialogState(actor, weaponData);

  const label = dialog.element.querySelector("[data-reload-source-label]");
  if (label) label.textContent = state.sourceLabel;
  updateReloadDialogMagazineReadout(dialog, actor, weaponId, weaponFunctionId);

  const select = dialog.element.querySelector("[data-reload-source-select]");
  if (!select) return;
  const currentValue = String(select.value ?? "").trim();
  const selectedAvailable = state.availableSources.some(entry => entry.uuid === currentValue);
  select.innerHTML = state.availableSources.map(entry => `
    <option value="${escapeAttribute(entry.uuid)}" ${entry.selected || (!selectedAvailable && entry.uuid === state.sourceItem?.uuid) ? "selected" : ""}>
      ${escapeHTML(entry.name)} (${entry.quantity})
    </option>
  `).join("");
  select.disabled = !state.availableSources.length;
  if (selectedAvailable) select.value = currentValue;
}

function buildWeaponReloadDialogState(actor, weaponData = {}) {
  const sourceItems = getWeaponMagazineSourceItems(weaponData);
  const sourceItem = getActiveWeaponMagazineSourceItem(weaponData, sourceItems);
  const source = getDamageSourceFunction(sourceItem);
  const sourceLabel = sourceItem
    ? String(source?.name ?? "").trim() || sourceItem.name
    : game.i18n.localize("FALLOUTMAW.Item.WeaponMagazineSourceEmpty");
  const current = Math.max(0, toInteger(weaponData.magazine?.value));
  const max = Math.max(0, toInteger(weaponData.magazine?.max));
  const availableSources = sourceItems
    .map(item => ({
      uuid: item.uuid,
      name: String(getDamageSourceFunction(item)?.name ?? "").trim() || item.name,
      quantity: getActorMagazineSourceQuantity(actor, item),
      selected: item.uuid === sourceItem?.uuid
    }))
    .filter(entry => entry.quantity > 0);

  return { sourceItems, sourceItem, sourceLabel, current, max, availableSources };
}

async function openWeaponReloadDialog({ actor = null, weapon = null, weaponFunctionId = "", application = null } = {}) {
  if (!actor?.isOwner || !weapon) return undefined;
  const weaponId = weapon.id;
  const dialogKey = getReloadDialogKey(actor, weaponId, weaponFunctionId);
  const existingDialog = openReloadDialogs.get(dialogKey);
  if (existingDialog) {
    updateReloadDialogState(existingDialog, actor, weaponId, weaponFunctionId);
    existingDialog.bringToFront?.();
    return undefined;
  }

  const weaponData = getWeaponFunctionById(weapon, weaponFunctionId) ?? {};
  if (!hasWeaponResourceCostData(weaponData, "magazine")) return undefined;

  const state = buildWeaponReloadDialogState(actor, weaponData);
  const sourceItems = state.sourceItems;
  const sourceItem = state.sourceItem;
  if (!sourceItems.length || !sourceItem) {
    ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Item.WeaponReloadNoSource"));
    return undefined;
  }

  const runReloadStep = async (dialog, action, sourceUuid) => {
    const freshWeapon = actor.items.get(weaponId);
    if (!freshWeapon) return;
    if (!hasRequiredWeaponReloadActionPoints(actor, freshWeapon, weaponFunctionId)) return;
    try {
      await requestWeaponReloadOperation({
        actor,
        weapon: freshWeapon,
        weaponFunctionId,
        action,
        sourceUuid
      });
      await spendWeaponReloadActionPoints(actor, freshWeapon, weaponFunctionId);
    } catch (error) {
      ui.notifications.warn(error.message);
      return;
    }
    updateReloadDialogState(dialog, actor, weaponId, weaponFunctionId);
    await application?.render({ force: true });
  };

  const dialog = new DialogV2({
    window: {
      title: game.i18n.localize("FALLOUTMAW.Item.WeaponActionReload")
    },
    content: `
      <form class="fallout-maw-reload-dialog-form">
      <div class="fallout-maw-reload-dialog">
        <p><strong data-reload-source-label>${escapeHTML(state.sourceLabel)}</strong></p>
        <p data-reload-magazine-readout>${escapeHTML(game.i18n.localize("FALLOUTMAW.Item.WeaponMagazine"))}: ${state.current} / ${state.max}</p>
        <label>
          <span>${escapeHTML(game.i18n.localize("FALLOUTMAW.Item.WeaponMagazineSource"))}</span>
          <select name="sourceUuid" data-reload-source-select ${state.availableSources.length ? "" : "disabled"}>
            ${state.availableSources.map(entry => `
              <option value="${escapeAttribute(entry.uuid)}" ${entry.selected ? "selected" : ""}>
                ${escapeHTML(entry.name)} (${entry.quantity})
              </option>
            `).join("")}
          </select>
        </label>
      </div>
      </form>
    `,
    form: {
      closeOnSubmit: false
    },
    buttons: [
      {
        action: "insert",
        label: game.i18n.localize("FALLOUTMAW.Item.WeaponReloadInsert"),
        icon: "fa-solid fa-arrow-down",
        default: true,
        callback: async (event, button, dlg) => {
          await runReloadStep(dlg, "insert", readReloadDialogSourceUuid(button));
        }
      },
      {
        action: "extract",
        label: game.i18n.localize("FALLOUTMAW.Item.WeaponReloadExtract"),
        icon: "fa-solid fa-arrow-up",
        callback: async (event, button, dlg) => {
          await runReloadStep(dlg, "extract", readReloadDialogSourceUuid(button));
        }
      },
      {
        action: "cancel",
        label: game.i18n.localize("FALLOUTMAW.Common.Cancel"),
        icon: "fa-solid fa-xmark",
        type: "button",
        callback: (event, button, dlg) => {
          dlg.close();
        }
      }
    ],
    position: {
      width: 360
    }
  });

  dialog.addEventListener("render", () => {
    const select = dialog.element?.querySelector?.("[data-reload-source-select]");
    if (!select || select.dataset.reloadAmmoWatcher) return;
    select.dataset.reloadAmmoWatcher = "1";
    select.addEventListener("change", async () => {
      const freshWeapon = actor.items.get(weaponId);
      if (!freshWeapon) return;
      const wd = getWeaponFunctionById(freshWeapon, weaponFunctionId) ?? {};
      const newUuid = String(select.value ?? "").trim();
      const loadedUuid = String(wd?.magazine?.sourceItemUuid ?? "").trim();
      const rounds = Math.max(0, toInteger(wd?.magazine?.value));
      if (!rounds) return;
      if (newUuid === loadedUuid) return;
      const configuredSources = getWeaponMagazineSourceItems(wd);
      const loadedSource = configuredSources.find(item => item.uuid === loadedUuid);
      if (!loadedSource) return;
      await runReloadStep(dialog, "extract", loadedSource.uuid);
    });
  }, { once: true });

  bindReloadDialogLiveUpdates(dialog, actor, weaponId, weaponFunctionId);
  openReloadDialogs.set(dialogKey, dialog);
  dialog.addEventListener("close", () => {
    if (openReloadDialogs.get(dialogKey) === dialog) openReloadDialogs.delete(dialogKey);
  }, { once: true });
  await dialog.render({ force: true });
  return undefined;
}

function getReloadDialogKey(actor, weaponId, weaponFunctionId = "") {
  return [actor?.uuid ?? "", weaponId ?? "", String(weaponFunctionId ?? "")].join("|");
}

function bindReloadDialogLiveUpdates(dialog, actor, weaponId, weaponFunctionId) {
  let refreshTimeout = null;
  const scheduleRefresh = () => {
    if (refreshTimeout) window.clearTimeout(refreshTimeout);
    refreshTimeout = window.setTimeout(() => {
      refreshTimeout = null;
      updateReloadDialogState(dialog, actor, weaponId, weaponFunctionId);
    }, 25);
  };
  const actorMatches = candidate => candidate?.uuid === actor?.uuid;
  const itemMatches = item => item?.parent?.uuid === actor?.uuid
    || (item?.id === weaponId && item?.parent?.uuid === actor?.uuid);

  const hooks = [
    ["updateActor", Hooks.on("updateActor", updatedActor => {
      if (actorMatches(updatedActor)) scheduleRefresh();
    })],
    ["updateItem", Hooks.on("updateItem", item => {
      if (itemMatches(item)) scheduleRefresh();
    })],
    ["createItem", Hooks.on("createItem", item => {
      if (itemMatches(item)) scheduleRefresh();
    })],
    ["deleteItem", Hooks.on("deleteItem", item => {
      if (itemMatches(item)) scheduleRefresh();
    })]
  ];

  dialog.addEventListener("close", () => {
    if (refreshTimeout) window.clearTimeout(refreshTimeout);
    for (const [hook, id] of hooks) Hooks.off(hook, id);
  }, { once: true });
}

async function requestWeaponReloadOperation({ actor = null, weapon = null, weaponFunctionId = "", action = "", sourceUuid = "" } = {}) {
  if (!actor?.isOwner || !weapon) return undefined;
  const payload = {
    actorUuid: actor.uuid,
    weaponId: weapon.id,
    weaponFunctionId: String(weaponFunctionId ?? ""),
    action: String(action ?? ""),
    sourceUuid: String(sourceUuid ?? "")
  };
  if (game.user?.isGM) return performWeaponReloadOperation(payload, game.user?.id ?? "");
  const gm = getResponsibleGM();
  if (!gm) throw new Error(game.i18n.localize("FALLOUTMAW.Item.WeaponReloadNoGM"));
  return requestTokenActionHudSocket("weaponReload", payload, gm);
}

async function performWeaponReloadOperation({ actorUuid = "", weaponId = "", weaponFunctionId = "", action = "", sourceUuid = "" } = {}, requesterUserId = "") {
  const actor = await fromUuid(actorUuid);
  if (!actor) throw new Error("Actor not found.");
  const requester = requesterUserId ? game.users?.get(requesterUserId) : game.user;
  if (requester && !actor.testUserPermission(requester, "OWNER")) throw new Error("No actor owner permission.");
  const weapon = actor.items?.get(weaponId);
  if (!weapon || !hasItemFunction(weapon, ITEM_FUNCTIONS.weapon)) throw new Error("Weapon not found.");
  const weaponData = getWeaponFunctionById(weapon, weaponFunctionId) ?? {};
  if (!hasWeaponResourceCostData(weaponData, "magazine")) return undefined;
  const configuredSources = getWeaponMagazineSourceItems(weaponData);
  const loadedUuid = String(weaponData?.magazine?.sourceItemUuid ?? "").trim();

  if (String(action) === "extract") {
    const extractSource = (loadedUuid ? configuredSources.find(item => item.uuid === loadedUuid) : null)
      ?? configuredSources.find(item => item.uuid === sourceUuid)
      ?? getActiveWeaponMagazineSourceItem(weaponData, configuredSources);
    if (!extractSource || extractSource.actor || !hasItemFunction(extractSource, ITEM_FUNCTIONS.damageSource)) {
      throw new Error(game.i18n.localize("FALLOUTMAW.Item.WeaponReloadNoSource"));
    }
    return extractWeaponMagazineSource(actor, weapon, weaponFunctionId, weaponData, extractSource);
  }

  const insertSource = configuredSources.find(item => item.uuid === sourceUuid)
    ?? getActiveWeaponMagazineSourceItem(weaponData, configuredSources);
  if (!insertSource || insertSource.actor || !hasItemFunction(insertSource, ITEM_FUNCTIONS.damageSource)) {
    throw new Error(game.i18n.localize("FALLOUTMAW.Item.WeaponReloadNoSource"));
  }
  if (String(action) === "insert") return insertWeaponMagazineSource(actor, weapon, weaponFunctionId, weaponData, insertSource);
  return undefined;
}

async function insertWeaponMagazineSource(actor, weapon, weaponFunctionId, weaponData, sourceItem) {
  const current = Math.max(0, toInteger(weaponData.magazine?.value));
  const max = Math.max(0, toInteger(weaponData.magazine?.max));
  if (max && current >= max) {
    throw new Error(game.i18n.localize("FALLOUTMAW.Item.WeaponReloadMagazineFull"));
  }
  const sourceStacks = getActorMagazineSourceStacks(actor, sourceItem);
  const available = sourceStacks.reduce((total, item) => total + getItemQuantity(item), 0);
  if (!available) {
    throw new Error(game.i18n.localize("FALLOUTMAW.Item.WeaponReloadSourceEmpty"));
  }
  const capacity = max > 0 ? Math.max(0, max - current) : available;
  const amount = Math.min(capacity, available);
  if (!amount) return;
  const updates = [{
    _id: weapon.id,
    [`${getWeaponFunctionPath(weapon, weaponFunctionId)}.magazine.sourceItemUuid`]: sourceItem.uuid,
    [`${getWeaponFunctionPath(weapon, weaponFunctionId)}.magazine.value`]: current + amount
  }];
  const deletes = [];
  let remaining = amount;
  for (const stack of sourceStacks) {
    if (remaining <= 0) break;
    const quantity = getItemQuantity(stack);
    const spent = Math.min(quantity, remaining);
    const next = quantity - spent;
    if (next > 0) updates.push({ _id: stack.id, "system.quantity": next });
    else deletes.push(stack.id);
    remaining -= spent;
  }
  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
  if (deletes.length) return actor.deleteEmbeddedDocuments("Item", deletes);
  return undefined;
}

async function extractWeaponMagazineSource(actor, weapon, weaponFunctionId, weaponData, sourceItem) {
  const current = Math.max(0, toInteger(weaponData.magazine?.value));
  if (!current) {
    throw new Error(game.i18n.localize("FALLOUTMAW.Item.WeaponReloadMagazineEmpty"));
  }
  const sourceStacks = getActorMagazineSourceStacks(actor, sourceItem);
  const updates = [{
    _id: weapon.id,
    [`${getWeaponFunctionPath(weapon, weaponFunctionId)}.magazine.sourceItemUuid`]: sourceItem.uuid,
    [`${getWeaponFunctionPath(weapon, weaponFunctionId)}.magazine.value`]: 0
  }];
  const targetStack = sourceStacks.at(0);
  if (targetStack) {
    updates.push({
      _id: targetStack.id,
      "system.quantity": getItemQuantity(targetStack) + current
    });
    return actor.updateEmbeddedDocuments("Item", updates);
  }
  await actor.updateEmbeddedDocuments("Item", updates);
  return createActorMagazineSourceStack(actor, sourceItem, current);
}

function getWeaponFunctionPath(weapon, weaponFunctionId = "") {
  return getWeaponFunctionUpdatePath(weapon, weaponFunctionId || ITEM_FUNCTIONS.weapon) || "system.functions.weapon";
}

function getWeaponMagazineSourceItem(weaponData = {}) {
  const uuid = String(weaponData?.magazine?.sourceItemUuid ?? "").trim();
  if (!uuid) return null;
  return globalThis.fromUuidSync?.(uuid) ?? foundry.utils.fromUuidSync?.(uuid) ?? null;
}

function getWeaponMagazineSourceItems(weaponData = {}) {
  return getWeaponMagazineSourceUuids(weaponData)
    .map(uuid => getWeaponMagazineSourceItem({ magazine: { sourceItemUuid: uuid } }))
    .filter(item => item && !item.actor && hasItemFunction(item, ITEM_FUNCTIONS.damageSource));
}

function readReloadDialogSourceUuid(button) {
  const form = button?.form ?? button?.closest?.(".window-app, .application, dialog")?.querySelector?.("form");
  if (!form) return "";
  return String(new FormDataExtended(form).object.sourceUuid ?? "");
}

function getActiveWeaponMagazineSourceItem(weaponData = {}, sourceItems = getWeaponMagazineSourceItems(weaponData)) {
  const activeUuid = String(weaponData?.magazine?.sourceItemUuid ?? "").trim();
  return sourceItems.find(item => item.uuid === activeUuid) ?? sourceItems.at(0) ?? null;
}

function getWeaponMagazineSourceUuids(weaponData = {}) {
  return Array.from(new Set([
    ...(Array.isArray(weaponData?.magazine?.sourceItemUuids) ? weaponData.magazine.sourceItemUuids : []),
    String(weaponData?.magazine?.sourceItemUuid ?? "")
  ].map(value => String(value ?? "").trim()).filter(Boolean)));
}

function getActorMagazineSourceQuantity(actor, sourceItem) {
  return getActorMagazineSourceStacks(actor, sourceItem)
    .reduce((total, item) => total + getItemQuantity(item), 0);
}

function getActorMagazineSourceStacks(actor, sourceItem) {
  if (!actor || !sourceItem) return [];
  return (actor.items?.contents ?? []).filter(item => isMatchingMagazineSourceItem(item, sourceItem));
}

function isMatchingMagazineSourceItem(item, sourceItem) {
  if (!item || !sourceItem || !hasItemFunction(item, ITEM_FUNCTIONS.damageSource)) return false;
  if (item.getFlag?.(SYSTEM_ID, "damageSourcePrototypeUuid") === sourceItem.uuid) return true;
  if (item.name !== sourceItem.name) return false;
  return areDamageSourcesEqual(getDamageSourceFunction(item), getDamageSourceFunction(sourceItem));
}

function areDamageSourcesEqual(left = {}, right = {}) {
  if (String(left?.name ?? "") !== String(right?.name ?? "")) return false;
  if (toInteger(left?.damage) !== toInteger(right?.damage)) return false;
  if (toInteger(left?.pellets) !== toInteger(right?.pellets)) return false;
  if (String(left?.damageTypeKey ?? "") !== String(right?.damageTypeKey ?? "")) return false;
  if (String(left?.attackAnimationKey ?? "") !== String(right?.attackAnimationKey ?? "")) return false;
  if (String(left?.attackSoundPath ?? "") !== String(right?.attackSoundPath ?? "")) return false;
  if (toInteger(left?.attackAnimationDelayMs) !== toInteger(right?.attackAnimationDelayMs)) return false;
  if (toInteger(left?.accuracyBonus) !== toInteger(right?.accuracyBonus)) return false;
  if (toInteger(left?.criticalChanceModifier) !== toInteger(right?.criticalChanceModifier)) return false;
  if (toInteger(left?.criticalDamagePercent) !== toInteger(right?.criticalDamagePercent)) return false;
  if (Number(left?.maxRangeMeters || 0) !== Number(right?.maxRangeMeters || 0)) return false;
  if (Number(left?.effectiveRange?.value || 0) !== Number(right?.effectiveRange?.value || 0)) return false;
  if (Number(left?.effectiveRange?.max || 0) !== Number(right?.effectiveRange?.max || 0)) return false;
  if (toInteger(left?.penetration) !== toInteger(right?.penetration)) return false;
  const leftTypes = normalizeDamageSourceTypeSignature(left?.damageTypes);
  const rightTypes = normalizeDamageSourceTypeSignature(right?.damageTypes);
  if (leftTypes !== rightTypes) return false;
  return normalizeDamageSourceVolleySignature(left?.volley) === normalizeDamageSourceVolleySignature(right?.volley);
}

function normalizeDamageSourceTypeSignature(entries = []) {
  return (entries ?? [])
    .map(entry => `${String(entry?.key ?? "")}:${toInteger(entry?.percent)}`)
    .sort()
    .join("|");
}

function normalizeDamageSourceVolleySignature(volley = {}) {
  const regionDamage = (Array.isArray(volley?.regionDamageEntries) ? volley.regionDamageEntries : [])
    .map(entry => `${String(entry?.damageTypeKey ?? "")}:${toInteger(entry?.amount)}`)
    .sort()
    .join("|");
  return [
    Number(volley?.damageRadius || 0),
    Number(volley?.regionRadius || 0),
    regionDamage,
    toInteger(volley?.regionDurationSeconds),
    toInteger(volley?.regionDelaySeconds),
    Number(volley?.regionRadiusDeltaMeters || 0),
    String(volley?.explosionAnimationKey ?? ""),
    String(volley?.explosionSoundPath ?? "")
  ].join(";");
}

async function createActorMagazineSourceStack(actor, sourceItem, quantity) {
  const createData = sourceItem.toObject();
  delete createData._id;
  foundry.utils.setProperty(createData, "system.quantity", Math.max(0, toInteger(quantity)));
  foundry.utils.setProperty(createData, `flags.${SYSTEM_ID}.damageSourcePrototypeUuid`, sourceItem.uuid);

  const placement = getFirstAvailableRootInventoryPlacement(actor, createData);
  if (!placement) throw new Error(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));
  const storedPlacement = createStoredPlacement(placement, createData);
  foundry.utils.mergeObject(createData, {
    system: {
      equipped: false,
      container: {
        parentId: ROOT_CONTAINER_ID
      },
      placement: {
        mode: storedPlacement.mode,
        equipmentSlot: storedPlacement.equipmentSlot,
        weaponSet: storedPlacement.weaponSet,
        weaponSlot: storedPlacement.weaponSlot,
        x: storedPlacement.x,
        y: storedPlacement.y,
        width: storedPlacement.width,
        height: storedPlacement.height
      }
    }
  });
  return actor.createEmbeddedDocuments("Item", [createData]);
}

async function returnModuleItemToActorInventory(actor, itemData) {
  if (!actor || !itemData?.system) return null;
  const moduleName = getWeaponModuleTechnicalName(itemData);
  const stackTarget = actor.items.contents.find(item => (
    getWeaponModuleTechnicalName(item) === moduleName
    && getItemQuantity(item) < getItemMaxStack(item)
    && String(item.system?.placement?.mode ?? "inventory") === "inventory"
  ));
  if (stackTarget) {
    return stackTarget.update({ "system.quantity": getItemQuantity(stackTarget) + 1 });
  }

  const placement = getFirstAvailableRootInventoryPlacement(actor, itemData);
  if (!placement) {
    ui.notifications.warn("Нет места в инвентаре для снятого модуля.");
    return null;
  }
  const createData = foundry.utils.deepClone(itemData);
  delete createData._id;
  const storedPlacement = createStoredPlacement(placement, itemData);
  foundry.utils.mergeObject(createData, {
    system: {
      quantity: 1,
      equipped: false,
      container: { parentId: ROOT_CONTAINER_ID },
      placement: {
        mode: storedPlacement.mode,
        equipmentSlot: storedPlacement.equipmentSlot,
        weaponSet: storedPlacement.weaponSet,
        weaponSlot: storedPlacement.weaponSlot,
        x: storedPlacement.x,
        y: storedPlacement.y,
        width: storedPlacement.width,
        height: storedPlacement.height
      }
    }
  });
  return actor.createEmbeddedDocuments("Item", [createData]);
}

function getFirstAvailableRootInventoryPlacement(actor, itemData) {
  const allItems = actor?.items?.contents ?? [];
  const rootItems = getContextInventoryItems(ROOT_CONTAINER_ID, allItems);
  const { columns, rows } = getActorRootInventoryDimensions(actor);
  return findFirstAvailableInventoryPlacement(rootItems, columns, rows, itemData, allItems);
}

function getActorRootInventoryDimensions(actor) {
  const race = getCreatureOptions().races.find(entry => entry.id === actor?.system?.creature?.raceId);
  return getActorInventoryGridDimensions(actor, race);
}

async function requestTokenActionHudSocket(action, payload = {}, gm = getResponsibleGM()) {
  if (!gm) throw new Error(game.i18n.localize("FALLOUTMAW.Item.WeaponReloadNoGM"));
  const requestId = foundry.utils.randomID();
  const requesterUserId = game.user?.id ?? "";

  const promise = new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingTokenActionHudSocketRequests.delete(requestId);
      reject(new Error("GM did not answer token HUD request."));
    }, TOKEN_ACTION_HUD_SOCKET_TIMEOUT);
    pendingTokenActionHudSocketRequests.set(requestId, { resolve, reject, timeout });
  });

  game.socket.emit(TOKEN_ACTION_HUD_SOCKET, {
    scope: TOKEN_ACTION_HUD_SOCKET_SCOPE,
    type: "request",
    action,
    requestId,
    requesterUserId,
    gmUserId: gm.id,
    payload
  });
  return promise;
}

async function handleTokenActionHudSocketMessage(message = {}) {
  if (message?.scope !== TOKEN_ACTION_HUD_SOCKET_SCOPE) return;

  if (message.type === "response") {
    if (message.recipientUserId && message.recipientUserId !== game.user?.id) return;
    const pending = pendingTokenActionHudSocketRequests.get(message.requestId);
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    pendingTokenActionHudSocketRequests.delete(message.requestId);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error || "Token HUD socket request failed."));
    return;
  }

  if (message.type !== "request") return;
  if (!game.user?.isGM || message.gmUserId !== game.user.id) return;

  try {
    const result = await handleTokenActionHudSocketRequest(message.action, message.payload ?? {}, message.requesterUserId ?? "");
    game.socket.emit(TOKEN_ACTION_HUD_SOCKET, {
      scope: TOKEN_ACTION_HUD_SOCKET_SCOPE,
      type: "response",
      requestId: message.requestId,
      recipientUserId: message.requesterUserId,
      ok: true,
      result
    });
  } catch (error) {
    console.error(`${SYSTEM_ID} | Token Action HUD socket request failed`, error);
    game.socket.emit(TOKEN_ACTION_HUD_SOCKET, {
      scope: TOKEN_ACTION_HUD_SOCKET_SCOPE,
      type: "response",
      requestId: message.requestId,
      recipientUserId: message.requesterUserId,
      ok: false,
      error: error.message
    });
  }
}

async function handleTokenActionHudSocketRequest(action, payload = {}, requesterUserId = "") {
  if (action === "weaponReload") return performWeaponReloadOperation(payload, requesterUserId);
  return undefined;
}

function getResponsibleGM() {
  return (game.users?.contents ?? [])
    .filter(user => user.active && user.isGM)
    .sort((left, right) => left.id.localeCompare(right.id))
    .at(0) ?? null;
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  })[character]);
}

function escapeAttribute(value) {
  return escapeHTML(value).replace(/`/g, "&#096;");
}

function applyMeterPreview(meter, spent) {
  if (!meter) return;

  const min = toInteger(meter.dataset.resourceMin);
  const value = toInteger(meter.dataset.resourceValue);
  const max = Math.max(min, toInteger(meter.dataset.resourceMax));
  const limited = Math.min(Math.max(0, toInteger(meter.dataset.resourceLimited)), Math.max(0, value - min));
  const range = Math.max(0, max - min);
  const availableValue = Math.max(min, value - limited);
  const cappedSpend = Math.min(Math.max(0, spent), Math.max(0, availableValue - min));
  if (!range || !cappedSpend) {
    meter.classList.remove("preview-spend");
    meter.style.removeProperty("--meter-preview-left");
    meter.style.removeProperty("--meter-preview-width");
    return;
  }

  const left = ((availableValue - cappedSpend - min) / range) * 100;
  const width = (cappedSpend / range) * 100;
  meter.style.setProperty("--meter-preview-left", `${Math.max(0, left).toFixed(2)}%`);
  meter.style.setProperty("--meter-preview-width", `${Math.min(100, width).toFixed(2)}%`);
  meter.classList.add("preview-spend");
}

function addLimitedResourceDisplay(entry, limit = null) {
  const amount = Math.min(Math.max(0, toInteger(limit?.amount)), Math.max(0, entry.value - entry.min));
  if (!amount) return entry;
  const range = Math.max(0, entry.max - entry.min);
  if (!range) return entry;
  const left = ((entry.value - amount - entry.min) / range) * 100;
  const width = (amount / range) * 100;
  const color = String(limit?.color || "#3f8cff");
  return {
    ...entry,
    blockedAmount: amount,
    blockedStyle: [
      `--meter-blocked-left: ${Math.max(0, left).toFixed(2)}%`,
      `--meter-blocked-width: ${Math.min(100, width).toFixed(2)}%`,
      `--meter-blocked-color: ${color}`
    ].join("; ")
  };
}

async function fullyRestoreActor(actor, { repairItems = false } = {}) {
  await fullyRestoreActorDamageState(actor);
  if (repairItems) await fullyRepairActorItems(actor);
}

async function fullyRepairActorItems(actor) {
  const itemUpdates = [];
  for (const item of actor.items ?? []) {
    if (!hasItemFunction(item, ITEM_FUNCTIONS.condition)) continue;
    const condition = getConditionFunction(item);
    const max = Math.max(0, toInteger(condition.max));
    const current = Math.max(0, toInteger(condition.value));
    if (current === max) continue;
    itemUpdates.push({
      _id: item.id,
      "system.functions.condition.value": max
    });
  }
  if (itemUpdates.length) await actor.updateEmbeddedDocuments("Item", itemUpdates);
}

function layoutTokenActionHud(element) {
  if (!element?.isConnected) return;
  const margin = 12;
  const safeRight = getSafeRight(margin);
  const actions = element.querySelector("[data-token-action-hud-actions]");
  const popup = element.querySelector("[data-token-action-hud-popup]");
  const actionsRect = actions?.getBoundingClientRect();
  const rootRect = element.getBoundingClientRect();
  const scale = getActiveTokenActionHudScaleFactor();

  const availableWidth = actionsRect
    ? Math.max(96, (safeRight - actionsRect.left) / scale)
    : Math.max(96, (safeRight - rootRect.left) / scale);
  element.style.setProperty("--fallout-maw-token-hud-actions-width", `${Math.floor(availableWidth)}px`);

  if (popup) {
    balanceTokenActionHudPopup(popup, availableWidth);
    const popupBottom = actionsRect?.top ?? rootRect.top;
    const maxHeight = Math.max(72, (popupBottom - margin) / scale);
    element.style.setProperty("--fallout-maw-token-hud-popup-max-height", `${Math.floor(maxHeight)}px`);
  }

  element.classList.add("layout-ready");
}

function balanceTokenActionHudPopup(popup, availableWidth) {
  if (!popup || popup.classList.contains("weapon-actions") || popup.classList.contains("weapon-sets")) return;
  const itemCount = popup.querySelectorAll(":scope > button").length;
  if (itemCount <= 0) {
    popup.style.removeProperty("--fallout-maw-token-hud-balanced-columns");
    return;
  }

  const style = getComputedStyle(popup);
  const tileSize = Number.parseFloat(style.getPropertyValue("--fallout-maw-token-hud-action-tile-width"))
    || Number.parseFloat(style.getPropertyValue("--fallout-maw-token-hud-tile"))
    || 115;
  const gap = Number.parseFloat(style.columnGap) || 5;
  const maxColumns = Math.max(1, Math.floor((availableWidth + gap) / (tileSize + gap)));
  const rows = Math.max(1, Math.ceil(itemCount / maxColumns));
  const columns = Math.max(1, Math.ceil(itemCount / rows));
  popup.style.setProperty("--fallout-maw-token-hud-balanced-columns", String(columns));
}

function setHudTileImageAspect(image) {
  const width = Number(image?.naturalWidth);
  const height = Number(image?.naturalHeight);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;
  const tile = image.closest(".fallout-maw-token-hud-main-action, .fallout-maw-token-hud-weapon-slot, .fallout-maw-token-hud-set-slot-preview");
  if (!tile) return false;
  const aspect = Math.max(1, width / height);
  const aspectText = String(aspect);
  for (const key of getHudImageAspectCacheKeys(image.getAttribute("src") || image.currentSrc || image.src)) {
    hudImageAspectCache.set(key, aspectText);
  }
  if (tile.style.getPropertyValue("--fallout-maw-hud-image-aspect") === aspectText) return false;
  tile.style.setProperty("--fallout-maw-hud-image-aspect", aspectText);
  return true;
}

function getHudImageAspectCacheKeys(src = "") {
  return Array.from(new Set([
    String(src ?? "").trim(),
    normalizeImagePath(src)
  ].filter(Boolean)));
}

function positionLimbPopover(popover, target) {
  const margin = 8;
  const gap = 10;
  const targetRect = target.getBoundingClientRect();
  const popoverRect = popover.getBoundingClientRect();
  let left = targetRect.left + ((targetRect.width - popoverRect.width) / 2);
  let top = targetRect.top - popoverRect.height - gap;

  if (top < margin) top = targetRect.bottom + gap;

  left = Math.max(margin, Math.min(window.innerWidth - popoverRect.width - margin, left));
  top = Math.max(margin, Math.min(window.innerHeight - popoverRect.height - margin, top));
  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(top)}px`;
}

function getHoveredLimbPart(svg, event) {
  if (!(svg instanceof SVGSVGElement)) return null;
  const screenPoint = svg.createSVGPoint();
  screenPoint.x = event.clientX;
  screenPoint.y = event.clientY;

  const parts = Array.from(svg.querySelectorAll("[data-limb-popover]")).reverse();
  for (const part of parts) {
    const matrix = part.getScreenCTM()?.inverse();
    if (!matrix) continue;
    const localPoint = screenPoint.matrixTransform(matrix);
    if (part.isPointInFill(localPoint)) return part;
  }
  return null;
}

function getActiveTokenActionHudScaleFactor() {
  return tokenActionHudScaleFactor(tokenActionHudPreviewPercent ?? getTokenActionHudScalePercent());
}

function getSafeRight(margin) {
  const candidates = [window.innerWidth - margin];
  for (const selector of ["#ui-right", "#sidebar", "#chat-notifications", ".chat-sidebar .chat-form"]) {
    const element = document.querySelector(selector);
    const rect = element?.getBoundingClientRect();
    if (rect && rect.width > 0 && rect.left > (window.innerWidth * 0.45)) candidates.push(rect.left - margin);
  }
  return Math.max(margin + 120, Math.min(...candidates));
}
