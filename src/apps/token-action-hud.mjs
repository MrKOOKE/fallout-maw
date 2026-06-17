import { FALLOUT_MAW } from "../config/system-config.mjs";
import { SYSTEM_ID, TEMPLATES } from "../constants.mjs";
import {
  getCreatureOptions,
  getActorNeedSettings,
  getDamageTypeSettings,
  getProficiencyInfluenceSettings,
  getProficiencySettings,
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
import { applyDamageCostModifier, fullyRestoreActorDamageState, getDamageCostModifierState, getDestroyedLimbStateLabel, getLimbHealingCap, getResourceLimitState, isLimbDestroyed } from "../combat/damage-hub.mjs";
import { MOVEMENT_RESOURCE_PREVIEW_HOOK } from "../combat/movement-resources.mjs";
import {
  REACTION_RESOURCE_KEY,
  decorateActionPointHudEntry,
  promptEndTurnConversion
} from "../combat/reaction-resources.mjs";
import { isReactionSystemLocked } from "../combat/reaction-hub.mjs";
import { canSpendWeaponSwitchActionPoints, getWeaponSwitchActionPointCost, spendWeaponSwitchActionPoints } from "../combat/weapon-switching.mjs";
import {
  getGrappleTargetId,
  getGrapplerId,
  startGrappleReposition,
  useGrappleAction
} from "../combat/active-actions.mjs";
import {
  POSTURE_EFFECT_CHANGE_ROOT,
  getActorPostureAction,
  getActorPostureWeaponActionPointCostBonus,
  isPostureEffectApplicableToActor,
  setActorTokensPosture
} from "../canvas/posture-movement.mjs";
import { evaluateActorEffectChangeNumber } from "../utils/active-effect-changes.mjs";
import { evaluateActorFormula } from "../utils/actor-formulas.mjs";
import {
  cancelWeaponAttack,
  hasRequiredWeaponReloadActionPoints,
  spendWeaponReloadActionPoints,
  startWeaponAttack
} from "../combat/weapon-attack-controller.mjs";
import { startTrapInteractionMode, startTrapPlacement } from "../canvas/traps.mjs";
import { useActiveItem } from "../items/active-item-use.mjs";
import {
  canActivateLightSource,
  getLightSourceDisplayName,
  isLightSourceActive,
  lightSourceUsesEnergyConsumer,
  openLightSourceEnergyDialog,
  toggleLightSource
} from "../items/light-source.mjs";
import { openLimbDamageDialog } from "./limb-damage-dialog.mjs";
import { requestMedicineTarget } from "./medicine-dialog.mjs";
import { requestRepairTarget } from "./repair-dialog.mjs";
import { openSearchInventoryWindow, requestTradeInventoryWindow } from "./search-inventory.mjs";
import { openCraftWindow } from "./craft-window.mjs";
import { openStealthWindow } from "../stealth/index.mjs";
import {
  getActorAtRandomActionPointCostReduction,
  getActorAtRandomActionPointCostSources,
  getWeaponActionBlockState
} from "../abilities/runtime-state.mjs";
import {
  getFixedAbilityToggleState,
  hasActiveFixedAbilityFunction,
  useFixedAbilityFunctionItem
} from "../abilities/fixed-functions.mjs";
import {
  canUseWeaponSlotForItem,
  getRequiredWeaponSlotsForItem,
  getWeaponSlotRequirement,
  getWeaponSlotRequirementSize,
  isContainerWeaponSetKey
} from "../utils/equipment-slots.mjs";
import {
  FALLBACK_ICON,
  getActorInventoryGridDimensions,
  getActorRootInventoryGridOptions,
  normalizeImagePath,
  prepareIndicatorEntry,
  prepareInventoryContext
} from "../utils/actor-display-data.mjs";
import {
  ROOT_CONTAINER_ID,
  createStoredPlacement,
  findFirstAvailableInventoryPlacement,
  getContainerContentsWeight,
  getContainerDimensions,
  getContainerMaxLoad,
  getItemContainerParentId,
  getItemMaxStack,
  getContextInventoryItems,
  getItemTotalWeight,
  getItemUnitWeight,
  hasContainerCycle,
  getItemQuantity
} from "../utils/inventory-containers.mjs";
import { ITEM_FUNCTIONS, WEAPON_SPECIAL_PROPERTIES, createWeaponFunctionUpdateData, getActiveItemChargesData, getConditionFunction, getConditionWeakeningData, getDamageSourceFunction, getEnabledWeaponFunctions, getModuleFunction, getProsthesisFunction, getWeaponAttackPowerState, getWeaponFunctionById, getWeaponFunctionModuleSlots, getWeaponFunctionUpdatePath, getWeaponSpecialPropertyType, hasItemFunction, hasWeaponSpecialPropertyData, isActiveItem, isItemBrokenByCondition, normalizeWeaponSpecialProperties } from "../utils/item-functions.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { resolveWorldItemSync } from "../utils/world-items.mjs";
import { createLimbSilhouetteHud } from "../utils/limb-silhouette.mjs";
import { renderInventoryItemTooltipHTML } from "../sheets/actor-sheet.mjs";
import { AdvancementApplication } from "../advancement/application.mjs";
import {
  applyWeaponModuleModifiers,
  getWeaponModuleDisplayName,
  getWeaponModuleSlots,
  getWeaponModuleSlotItemData,
  getWeaponModuleTechnicalName,
  isModuleItemCompatibleWithSlot
} from "../utils/weapon-modules.mjs";
import { getOverlayBaseZIndex, reserveOverlayZIndex } from "../utils/overlay-layer.mjs";
import { FalloutMaWFormApplicationV2, getFlatFormData } from "./base-form-application-v2.mjs";

const { ApplicationV2, DialogV2, HandlebarsApplicationMixin } = foundry.applications.api;
const FormDataExtended = foundry.applications.ux.FormDataExtended;
const TOKEN_ACTION_HUD_SOCKET = `system.${SYSTEM_ID}`;
const TOKEN_ACTION_HUD_SOCKET_SCOPE = "fallout-maw.tokenActionHud";
const TOKEN_ACTION_HUD_SOCKET_TIMEOUT = 10000;
const ABILITY_OVERLOAD_EFFECT_FLAG_KEY = "abilityOverload";
const ACTION_POINT_COST_TOOLTIP_DELAY_MS = 200;
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

function isHudActionBlockedByReactionLock() {
  if (!isReactionSystemLocked()) return false;
  ui.notifications.warn("Ожидание реакций: действие временно заблокировано.");
  return true;
}

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

export function refreshTokenActionHudForActor(actor) {
  scheduleTokenActionHudRefreshForActor(actor);
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
  #weaponEquipTarget = null;
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
  #actionPointCostTooltipTimer = null;
  #actionPointCostTooltipElement = null;
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
      openWeaponSlotPicker: { handler: TokenActionHud.#onOpenWeaponSlotPicker, buttons: [0, 1] },
      equipHudWeapon: { handler: TokenActionHud.#onEquipHudWeapon, buttons: [0, 1] },
      replaceHudWeapon: { handler: TokenActionHud.#onReplaceHudWeapon, buttons: [0, 1] },
      toggleWeaponActions: { handler: TokenActionHud.#onToggleWeaponActions, buttons: [0, 1] },
      useWeaponAction: { handler: TokenActionHud.#onUseWeaponAction, buttons: [0, 1] },
      toggleLightSource: { handler: TokenActionHud.#onToggleLightSource, buttons: [0, 1] },
      openLightSourceRecharge: { handler: TokenActionHud.#onOpenLightSourceRecharge, buttons: [0, 1] },
      setWeaponAttackPower: { handler: TokenActionHud.#onSetWeaponAttackPower, buttons: [0, 1] },
      gmHealSelected: TokenActionHud.#onGmHealSelected,
      gmAwardExperience: TokenActionHud.#onGmAwardExperience,
      endCombatTurn: TokenActionHud.#onEndCombatTurn,
      openSettings: TokenActionHud.#onOpenSettings,
      rollSkill: TokenActionHud.#onRollSkill,
      openItem: { handler: TokenActionHud.#onOpenItem, buttons: [1] },
      useItem: { handler: TokenActionHud.#onUseItem, buttons: [0, 1] },
      useAbility: { handler: TokenActionHud.#onUseAbility, buttons: [0, 1] },
      useActiveAction: TokenActionHud.#onUseActiveAction,
      dragGrappledTarget: TokenActionHud.#onDragGrappledTarget,
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
      this.#weaponEquipTarget = null;
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
    const hudWeaponSets = getHudWeaponSets(inventory);
    const activeWeaponSetKey = getActiveHudWeaponSetKey(actor, hudWeaponSets);
    const selectedWeapon = getSelectedHudWeapon(actor, hudWeaponSets, activeWeaponSetKey);
    const hudIcons = getTokenActionHudIcons();
    await preloadHudImageAspects(collectHudImageAspectSources(actor, hudWeaponSets, this.#weaponEquipTarget));
    const weaponSet = prepareHudWeaponSet(actor, hudWeaponSets, activeWeaponSetKey, selectedWeapon?.id ?? "", hudIcons);
    const weaponSets = prepareHudWeaponSets(actor, hudWeaponSets, activeWeaponSetKey, selectedWeapon?.id ?? "", hudIcons);
    const selectedWeaponSlot = getSelectedHudWeaponSlot(weaponSet, selectedWeapon?.id ?? "");
    const selectedWeaponDisabled = Boolean(selectedWeaponSlot?.useDisabled);
    const weaponActionRows = prepareWeaponActionRows(actor, selectedWeapon, selectedWeaponDisabled, hudIcons, selectedWeaponSlot, this.token);
    const weaponEquipChoices = prepareHudWeaponEquipChoices(actor, this.#weaponEquipTarget, hudIcons);
    const skills = prepareSkillButtons(actor, hudIcons);
    const items = prepareOwnedItemButtons(actor, "gear", "icons/svg/item-bag.svg", { activeOnly: true });
    const abilities = prepareOwnedAbilityButtons(actor, "icons/svg/aura.svg");
    const systemActions = prepareSystemActionButtons(hudIcons);
    const activeActions = prepareActiveActionButtons(this.#token, actor, weaponSet, selectedWeapon, selectedWeaponDisabled, hudIcons);
    const actionGroups = prepareActionGroups(activeActions, systemActions);
    const actions = prepareActions(this.#activeTray, selectedWeapon, items, abilities, actionGroups, hudIcons);
    const tray = prepareTrayContext(this.#activeTray, skills, items, abilities, activeActions, systemActions, actionGroups, weaponActionRows, weaponSet, weaponSets, weaponEquipChoices);
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
    this.#clearDetachedHudTooltips();
    this.#activateLimbControlClicks();
    const silhouette = this.element?.querySelector("[data-limb-popover-root]");
    if (silhouette && silhouette !== this.#limbPopover.boundRoot) {
      silhouette.addEventListener("pointermove", event => this.#onLimbPopoverMove(event));
      silhouette.addEventListener("pointerleave", () => this.#onLimbPopoverLeaveRoot());
      this.#limbPopover.boundRoot = silhouette;
    }
    this.applyMovementResourcePreview(tokenActionHudMovementPreview);
    this.#scheduleLayout();
  }

  _attachFrameListeners() {
    super._attachFrameListeners();
    this.element.addEventListener("pointerdown", event => this.#onHudItemMiddlePointerDown(event));
    this.element.addEventListener("pointerover", event => this.#onActionPointCostTooltipPointerOver(event));
    this.element.addEventListener("pointerout", event => this.#onActionPointCostTooltipPointerOut(event));
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
    this.#clearActionPointCostTooltip();
    this.#destroyLimbPopover();
  }

  #scheduleLayout() {
    if (this.#layoutFrame) cancelAnimationFrame(this.#layoutFrame);
    this.#layoutFrame = requestAnimationFrame(() => {
      this.#layoutFrame = null;
      layoutTokenActionHud(this.element);
    });
  }

  static #onToggleTray(event, target) {
    event.preventDefault();
    if (isHudActionBlockedByReactionLock()) return undefined;
    const tray = target.dataset.tray ?? "";
    this.#activeTray = this.#activeTray === tray ? "" : tray;
    if (this.#activeTray !== "weaponEquip") this.#weaponEquipTarget = null;
    return this.render({ force: true });
  }

  static async #onSelectHudWeaponSet(event, target) {
    event.preventDefault();
    if (isHudActionBlockedByReactionLock()) return undefined;
    const actor = this.actor;
    if (!actor?.isOwner) return undefined;
    const weaponSetKey = String(target.dataset.weaponSet ?? "");
    if (!weaponSetKey) return undefined;
    await actor.setFlag(FALLOUT_MAW.id, SELECTED_HUD_WEAPON_SET_FLAG, weaponSetKey);

    const race = getCreatureOptions().races.find(entry => entry.id === actor.system?.creature?.raceId);
    const inventory = prepareInventoryContext(actor, race);
    const set = getHudWeaponSets(inventory).find(entry => entry.key === weaponSetKey);
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
    if (isHudActionBlockedByReactionLock()) return undefined;
    const combat = game.combat;
    if (!isTokenCombatTurn(this.token, combat) || !canUserAdvanceCombatTurn(combat)) return undefined;
    this.#activeTray = "";
    const conversionMode = await promptEndTurnConversion(this.actor);
    if (!conversionMode) return this.render({ force: true });
    await combat.nextTurn({ falloutMawConversionMode: conversionMode });
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
    if (isHudActionBlockedByReactionLock()) return undefined;
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
    this.#weaponEquipTarget = null;
    this.#activeTray = "";
    return this.render({ force: true });
  }

  static async #onOpenWeaponSlotPicker(event, target) {
    event.preventDefault();
    if (isHudActionBlockedByReactionLock()) return undefined;
    if (isMiddleMouseClick(event) || event.button !== 0) return undefined;
    const weaponSetKey = String(target.dataset.weaponSet ?? "");
    const weaponSlotKey = String(target.dataset.weaponSlot ?? "");
    if (!weaponSetKey || !weaponSlotKey) return undefined;
    await this.actor?.setFlag(FALLOUT_MAW.id, SELECTED_HUD_WEAPON_SET_FLAG, weaponSetKey);
    this.#weaponEquipTarget = { weaponSetKey, weaponSlotKey, replaceItemId: "" };
    this.#activeTray = "weaponEquip";
    return this.render({ force: true });
  }

  static async #onReplaceHudWeapon(event, target) {
    event.preventDefault();
    if (isHudActionBlockedByReactionLock()) return undefined;
    const itemId = String(target.dataset.itemId ?? "");
    if (isMiddleMouseClick(event)) return this.actor?.items.get(itemId)?.sheet?.render(true);
    if (event.button !== 0) return undefined;
    const weaponSetKey = String(target.dataset.weaponSet ?? "");
    const weaponSlotKey = String(target.dataset.weaponSlot ?? "");
    if (!itemId || !weaponSetKey || !weaponSlotKey) return undefined;
    await this.actor?.setFlag(FALLOUT_MAW.id, SELECTED_HUD_WEAPON_SET_FLAG, weaponSetKey);
    await this.actor?.setFlag(FALLOUT_MAW.id, SELECTED_HUD_WEAPON_FLAG, itemId);
    this.#weaponEquipTarget = { weaponSetKey, weaponSlotKey, replaceItemId: itemId };
    this.#activeTray = "weaponEquip";
    return this.render({ force: true });
  }

  static async #onEquipHudWeapon(event, target) {
    event.preventDefault();
    if (isHudActionBlockedByReactionLock()) return undefined;
    const actor = this.actor;
    const itemId = String(target.dataset.itemId ?? "");
    const item = actor?.items.get(itemId);
    if (!item) return undefined;
    if (isMiddleMouseClick(event)) return item.sheet?.render(true);
    if (event.button !== 0) return undefined;

    const weaponSetKey = String(target.dataset.weaponSet ?? this.#weaponEquipTarget?.weaponSetKey ?? "");
    const weaponSlotKey = String(target.dataset.weaponSlot ?? this.#weaponEquipTarget?.weaponSlotKey ?? "");
    const result = await equipHudWeaponInSlot(actor, item, weaponSetKey, weaponSlotKey, {
      replaceItemId: this.#weaponEquipTarget?.replaceItemId ?? ""
    });
    if (!result) return undefined;
    await actor.setFlag(FALLOUT_MAW.id, SELECTED_HUD_WEAPON_SET_FLAG, weaponSetKey);
    await actor.setFlag(FALLOUT_MAW.id, SELECTED_HUD_WEAPON_FLAG, item.id);
    this.#weaponEquipTarget = null;
    this.#activeTray = "weaponActions";
    return this.render({ force: true });
  }

  static async #onToggleWeaponActions(event, target) {
    event.preventDefault();
    if (isHudActionBlockedByReactionLock()) return undefined;
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
    this.#weaponEquipTarget = null;
    this.#activeTray = wasOpenForItem ? "" : "weaponActions";
    return this.render({ force: true });
  }

  static #onUseWeaponAction(event, target) {
    event.preventDefault();
    if (isHudActionBlockedByReactionLock()) return undefined;
    const actionKey = String(target.dataset.weaponActionKey ?? "");
    const weaponFunctionId = String(target.dataset.weaponFunctionId ?? "");
    const itemId = String(target.dataset.itemId ?? "");
    const item = this.actor?.items.get(itemId);
    if (!item || !actionKey) return undefined;
    if (isMiddleMouseClick(event)) return item.sheet?.render(true);
    if (event.button !== 0) return undefined;
    if (isHudWeaponDisabled(this.actor, item)) return undefined;
    if (isWeaponActionBrokenForHud(item, weaponFunctionId)) {
      ui.notifications.warn("Предмет сломан.");
      return undefined;
    }
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

  static async #onToggleLightSource(event, target) {
    event.preventDefault();
    if (isHudActionBlockedByReactionLock()) return undefined;
    const itemId = String(target.dataset.itemId ?? "");
    const item = this.actor?.items.get(itemId);
    if (!item) return undefined;
    if (isMiddleMouseClick(event)) return item.sheet?.render(true);
    if (event.button !== 0) return undefined;
    if (target.disabled || isHudWeaponDisabled(this.actor, item)) return undefined;
    await toggleLightSource(this.token?.document ?? this.token, item);
    return this.render({ force: true });
  }

  static async #onOpenLightSourceRecharge(event, target) {
    event.preventDefault();
    if (isHudActionBlockedByReactionLock()) return undefined;
    const itemId = String(target.dataset.itemId ?? "");
    const item = this.actor?.items.get(itemId);
    if (!item) return undefined;
    if (isMiddleMouseClick(event)) return item.sheet?.render(true);
    if (event.button !== 0) return undefined;
    if (target.disabled) return undefined;
    return openLightSourceEnergyDialog({
      actor: this.actor,
      token: this.token,
      item,
      application: this,
      showToggle: false
    });
  }

  static async #onSetWeaponAttackPower(event, target) {
    event.preventDefault();
    if (isHudActionBlockedByReactionLock()) return undefined;
    const weaponFunctionId = String(target.dataset.weaponFunctionId ?? "");
    const itemId = String(target.dataset.itemId ?? "");
    const item = this.actor?.items.get(itemId);
    if (!item) return undefined;
    if (isMiddleMouseClick(event)) return item.sheet?.render(true);
    if (event.button !== 0) return undefined;
    if (isHudWeaponDisabled(this.actor, item)) return undefined;
    if (isWeaponActionBrokenForHud(item, weaponFunctionId)) {
      ui.notifications.warn("Предмет сломан.");
      return undefined;
    }
    const changed = await openWeaponAttackPowerDialog({
      actor: this.actor,
      weapon: item,
      weaponFunctionId,
      application: this
    });
    if (changed) return this.render({ force: true });
    return undefined;
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
    if (isHudActionBlockedByReactionLock()) return undefined;
    const item = this.actor?.items.get(target.dataset.itemId ?? "");
    if (!item) return undefined;
    if (isMiddleMouseClick(event)) return item.sheet?.render(true);
    if (event.button !== 0) return undefined;
    if (!isActiveItem(item)) return undefined;
    if (hasItemFunction(item, ITEM_FUNCTIONS.trap)) {
      return startTrapPlacement({
        actor: this.actor,
        token: this.token,
        item,
        application: this
      });
    }
    return useActiveItem({
      actor: this.actor,
      token: this.token,
      item,
      application: this
    });
  }

  static async #onUseAbility(event, target) {
    event.preventDefault();
    if (isHudActionBlockedByReactionLock()) return undefined;
    const item = this.actor?.items.get(target.dataset.itemId ?? "");
    if (!item) return undefined;
    if (isMiddleMouseClick(event)) return item.sheet?.render(true);
    if (event.button !== 0) return undefined;
    if (!hasActiveFixedAbilityFunction(item)) return undefined;
    return useFixedAbilityFunctionItem({
      actor: this.actor,
      token: this.token,
      item,
      application: this
    });
  }

  static async #onUseActiveAction(event, target) {
    event.preventDefault();
    if (isHudActionBlockedByReactionLock()) return undefined;
    const key = String(target.dataset.activeActionKey ?? "");
    if (!this.token?.actor?.isOwner) return undefined;
    if (key === "grapple") {
      await useGrappleAction(this.token);
      return this.render({ force: true });
    }
    if (key === "push") {
      const push = resolveHudPushAction(this.actor);
      if (!push) {
        ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Settings.HUD.NoPushWeapon"));
        return undefined;
      }
      return startWeaponAttack({
        token: this.token,
        weapon: push.weapon,
        actionKey: "push",
        weaponFunctionId: push.weaponFunctionId
      });
    }
    return undefined;
  }

  static async #onDragGrappledTarget(event) {
    event.preventDefault();
    if (isHudActionBlockedByReactionLock()) return undefined;
    await startGrappleReposition(this.token);
    return this.render({ force: true });
  }

  static #onUseSystemAction(event, target) {
    event.preventDefault();
    if (isHudActionBlockedByReactionLock()) return undefined;
    const key = String(target.dataset.systemActionKey ?? "");
    if (!["advancement", "medicine", "repair", "search", "trade", "craft", "stealth", "traps"].includes(key)) return undefined;

    if (key === "advancement") {
      if (!this.actor?.isOwner) return undefined;
      this.#activeTray = "";
      void this.render({ force: true });
      return new AdvancementApplication(this.actor).render(true);
    }
    void this.render({ force: true });
    if (key === "craft") return openCraftWindow({ actor: this.actor });
    if (key === "stealth") return openStealthWindow(this.token);
    if (key === "traps") return startTrapInteractionMode({ actor: this.actor, token: this.token });
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

  #onActionPointCostTooltipPointerOver(event) {
    const target = this.#getActionPointCostTooltipElement(event.target);
    if (!target || target.contains(event.relatedTarget)) return;
    const html = String(target.dataset.actionPointCostTooltipHtml ?? "").trim();
    if (!html) return;
    this.#clearActionPointCostTooltip();
    const view = this.element?.ownerDocument?.defaultView ?? window;
    this.#actionPointCostTooltipElement = target;
    this.#actionPointCostTooltipTimer = view.setTimeout(() => {
      this.#actionPointCostTooltipTimer = null;
      if (!target.isConnected || this.#actionPointCostTooltipElement !== target) return;
      game.tooltip?.activate(target, {
        html,
        cssClass: "fallout-maw-effect-tooltip fallout-maw-action-cost-tooltip",
        direction: "UP"
      });
    }, ACTION_POINT_COST_TOOLTIP_DELAY_MS);
  }

  #onActionPointCostTooltipPointerOut(event) {
    const target = this.#getActionPointCostTooltipElement(event.target);
    if (!target || target.contains(event.relatedTarget)) return;
    this.#clearActionPointCostTooltip();
  }

  #clearActionPointCostTooltip() {
    const view = this.element?.ownerDocument?.defaultView ?? window;
    if (this.#actionPointCostTooltipTimer) {
      view.clearTimeout(this.#actionPointCostTooltipTimer);
      this.#actionPointCostTooltipTimer = null;
    }
    if (game.tooltip?.element === this.#actionPointCostTooltipElement) game.tooltip.deactivate();
    this.#actionPointCostTooltipElement = null;
  }

  #onHudItemTooltipHudActivation(event) {
    if (this.#itemTooltipElement?.contains(event.target)) return;
    if (this.#itemTooltipSuppressHudActivation) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    const action = event.target instanceof Element ? event.target.closest("[data-action]") : null;
    if (!action || !this.element?.contains(action)) return;
    if (event.type === "auxclick" && event.button === 1 && this.#shouldPinHudTooltipOnMiddleClick(action)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.#pinHudTooltipFromActionElement(action, event);
      return;
    }
    this.#clearActionPointCostTooltip();
    if (this.#shouldKeepHudItemTooltipForAction(action, event)) {
      this.#cancelHudItemTooltipClose();
      return;
    }
    if (event.type !== "contextmenu") this.#clearHudItemTooltip();
  }

  #shouldKeepHudItemTooltipForAction(actionElement, event) {
    if (event.type !== "click") return false;
    if (!this.#itemTooltipElement || !this.#itemTooltipItemId) return false;
    if (String(actionElement?.dataset?.action ?? "") !== "useAbility") return false;
    const itemId = String(actionElement?.dataset?.hudTooltipItem ?? actionElement?.dataset?.itemId ?? "");
    return Boolean(itemId && itemId === this.#itemTooltipItemId);
  }

  #onHudContextMenu(event) {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest("[data-action][data-item-id]");
    if (!button || !this.element?.contains(button)) return;
    event.preventDefault();
    event.stopPropagation();
    const action = String(button.dataset.action ?? "");
    const item = this.actor?.items.get(String(button.dataset.itemId ?? ""));
    if (!item) return;
    if (game.user?.isGM && action !== "toggleWeaponActions") return item.sheet?.render(true);
    if (action !== "toggleWeaponActions") return;
    if (this.#itemTooltipElement && this.#itemTooltipItemId === item.id) {
      this.#clearHudItemTooltip();
      return;
    }
    this.#pinHudTooltipFromActionElement(button, event);
  }

  #shouldPinHudTooltipOnMiddleClick(actionElement) {
    const action = String(actionElement?.dataset?.action ?? "");
    return action === "openItem" || action === "useItem" || action === "useAbility";
  }

  #pinHudTooltipFromActionElement(actionElement, event = null) {
    const itemId = String(actionElement?.dataset?.hudTooltipItem ?? actionElement?.dataset?.itemId ?? "");
    const item = this.actor?.items.get(itemId);
    if (!item) return;
    this.#clearActionPointCostTooltip();
    if (this.#itemTooltipElement && this.#itemTooltipItemId === item.id && this.#itemTooltipPinned) {
      this.#clearHudItemTooltip({ force: true });
      return;
    }
    this.#itemTooltipBaseMode = Boolean(event?.altKey);
    this.#itemTooltipWeaponTabIndex = 0;
    void this.#showHudItemTooltip(item, actionElement, { pinned: true });
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
    return ["openItem", "useItem", "useAbility", "selectHudWeapon", "useWeaponAction", "toggleWeaponActions", "equipHudWeapon", "replaceHudWeapon"].includes(action) ? button : null;
  }

  #getHudTooltipItemElement(target) {
    if (!(target instanceof Element)) return null;
    const button = target.closest("[data-hud-tooltip-item]");
    return button && this.element?.contains(button) ? button : null;
  }

  #getActionPointCostTooltipElement(target) {
    if (!(target instanceof Element)) return null;
    const element = target.closest("[data-action-point-cost-tooltip]");
    return element && this.element?.contains(element) ? element : null;
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
    if (!this.#isLiveHudItemTooltipAnchor(anchor, item?.id)) return;
    if (refresh && this.#itemTooltipItemId !== item.id) return;

    if (refresh && this.#itemTooltipElement && !this.#itemTooltipPinned && !pinned) {
      this.#itemTooltipElement.innerHTML = tooltipHTML;
      this.#itemTooltipElement.classList.remove("pinned");
      this.#itemTooltipElement.style.pointerEvents = "none";
      this.#itemTooltipAnchorElement = anchor;
      this.#itemTooltipItemId = item.id;
      this.#itemTooltipPinned = false;
      this.#syncHudItemTooltipLayer();
      this.#positionHudItemTooltip();
      requestAnimationFrame(() => {
        if (!this.#itemTooltipElement) return;
        const description = this.#itemTooltipElement.querySelector(".description");
        description?.classList.toggle("overflowing", description.clientHeight < description.scrollHeight);
        this.#syncHudItemTooltipLayer();
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
    tooltip.addEventListener("pointerdown", () => this.#syncHudItemTooltipLayer({ bringToFront: true }));
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
    this.#syncHudItemTooltipLayer({ bringToFront: pinned });
    this.#positionHudItemTooltip();
    requestAnimationFrame(() => {
      const description = tooltip.querySelector(".description");
      description?.classList.toggle("overflowing", description.clientHeight < description.scrollHeight);
      this.#syncHudItemTooltipLayer();
      this.#positionHudItemTooltip();
    });
  }

  async #refreshHudItemTooltip() {
    if (!this.#itemTooltipElement || !this.#itemTooltipItemId) return;
    const initialAnchor = this.#resolveHudItemTooltipAnchor(this.#itemTooltipItemId);
    if (!initialAnchor && !this.#itemTooltipPinned) {
      return this.#clearHudItemTooltip();
    }
    const item = this.actor?.items.get(this.#itemTooltipItemId);
    if (!item) return this.#clearHudItemTooltip();
    this.#clearNestedHudItemTooltip({ force: true });
    const tooltipHTML = await renderInventoryItemTooltipHTML(item, this.actor, {
      activeWeaponIndex: this.#itemTooltipWeaponTabIndex,
      baseMode: this.#itemTooltipBaseMode
    });
    if (!this.#itemTooltipElement || this.#itemTooltipItemId !== item.id) return;
    const currentAnchor = this.#resolveHudItemTooltipAnchor(this.#itemTooltipItemId);
    if (!currentAnchor && !this.#itemTooltipPinned) {
      return this.#clearHudItemTooltip();
    }
    if (!this.#itemTooltipPinned && !this.#isHudItemTooltipHoverActive(currentAnchor)) {
      this.#queueHudItemTooltipHoverValidation();
    }
    this.#itemTooltipElement.innerHTML = tooltipHTML;
    this.#itemTooltipElement.style.pointerEvents = this.#itemTooltipPinned ? "auto" : "none";
    this.#syncHudItemTooltipLayer({ bringToFront: this.#itemTooltipPinned });
    this.#clampHudItemTooltipToViewport(this.#itemTooltipElement);
    requestAnimationFrame(() => {
      if (!this.#itemTooltipElement) return;
      const description = this.#itemTooltipElement.querySelector(".description");
      description?.classList.toggle("overflowing", description.clientHeight < description.scrollHeight);
      this.#syncHudItemTooltipLayer();
      this.#clampHudItemTooltipToViewport(this.#itemTooltipElement);
    });
  }

  async #onHudItemTooltipClick(event) {
    const nestedAnchor = event.target?.closest?.("[data-fallout-maw-nested-tooltip-html]");
    if (!nestedAnchor) {
      this.#clearNestedHudItemTooltip({ force: true });
    }
    const interactiveControl = event.target?.closest?.("[data-tooltip-module-remove], [data-tooltip-module-choice], [data-tooltip-module-slot], [data-tooltip-weapon-tab]");
    if (interactiveControl && this.#itemTooltipElement?.contains(interactiveControl)) this.#pinHudItemTooltip();

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
    if (!path) return undefined;
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
    if (!path) return undefined;
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
    tooltip.addEventListener("pointerdown", () => this.#syncHudItemTooltipLayer({ bringToFront: true }));
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
      this.#pinNestedHudItemTooltip();
    });

    document.body.append(tooltip);
    this.#itemTooltipNestedElement = tooltip;
    this.#itemTooltipNestedAnchorElement = anchor;
    this.#itemTooltipNestedPinned = Boolean(pinned);
    this.#syncHudItemTooltipLayer({ bringToFront: pinned });
    this.#positionNestedHudItemTooltip();
    requestAnimationFrame(() => {
      if (!this.#itemTooltipNestedElement) return;
      const description = this.#itemTooltipNestedElement.querySelector(".description");
      description?.classList.toggle("overflowing", description.clientHeight < description.scrollHeight);
      this.#syncHudItemTooltipLayer();
      this.#positionNestedHudItemTooltip();
    });
  }

  #pinHudItemTooltip() {
    this.#itemTooltipPinned = true;
    this.#itemTooltipElement?.classList.add("pinned");
    if (this.#itemTooltipElement) this.#itemTooltipElement.style.pointerEvents = "auto";
    this.#bindHudItemTooltipDocumentListeners();
    this.#syncHudItemTooltipLayer({ bringToFront: true });
  }

  #pinNestedHudItemTooltip() {
    this.#cancelNestedHudItemTooltipClose();
    this.#itemTooltipNestedPinned = true;
    this.#itemTooltipNestedElement?.classList.add("pinned");
    this.#syncHudItemTooltipLayer({ bringToFront: true });
  }

  #positionNestedHudItemTooltip() {
    const tooltip = this.#itemTooltipNestedElement;
    const anchor = this.#itemTooltipNestedAnchorElement;
    if (!tooltip) return;
    if (!anchor?.isConnected || !this.#itemTooltipElement?.contains(anchor)) {
      this.#clearNestedHudItemTooltip({ force: true });
      return;
    }
    const { viewportWidth, viewportHeight } = this.#getHudTooltipViewportMetrics();
    const margin = 10;
    const gap = 12;
    this.#syncHudItemTooltipAvailableHeight(tooltip, viewportHeight, margin);

    const anchorRect = anchor.getBoundingClientRect();
    const parentRect = this.#itemTooltipElement?.getBoundingClientRect();
    let rect = tooltip.getBoundingClientRect();
    let left = (parentRect?.right ?? anchorRect.right) + gap;
    if ((left + rect.width) > (viewportWidth - margin)) {
      left = (parentRect?.left ?? anchorRect.left) - rect.width - gap;
    }
    left = Math.max(margin, Math.min(viewportWidth - rect.width - margin, left));
    let top = anchorRect.top + ((anchorRect.height - rect.height) / 2);
    top = Math.max(margin, Math.min(viewportHeight - rect.height - margin, top));
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(top)}px`;

    this.#syncHudItemTooltipAvailableHeight(tooltip, viewportHeight, margin);
    rect = tooltip.getBoundingClientRect();
    if ((rect.top + rect.height) > (viewportHeight - margin)) {
      tooltip.style.top = `${Math.round(Math.max(margin, viewportHeight - rect.height - margin))}px`;
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
    const anchor = this.#resolveHudItemTooltipAnchor(this.#itemTooltipItemId);
    if (!tooltip) return;
    if (!anchor) {
      if (this.#itemTooltipPinned) {
        this.#clampHudItemTooltipToViewport(tooltip);
        return;
      }
      this.#clearHudItemTooltip();
      return;
    }
    const anchorRect = anchor.getBoundingClientRect();
    const { viewportWidth, viewportHeight } = this.#getHudTooltipViewportMetrics();
    const margin = 10;
    const gap = 12;
    const aboveAvailable = Math.max(0, anchorRect.top - margin - gap);
    const belowAvailable = Math.max(0, viewportHeight - anchorRect.bottom - margin - gap);
    const placeAbove = aboveAvailable >= Math.min(220, belowAvailable) || belowAvailable < 160;
    const availableHeight = placeAbove ? aboveAvailable : belowAvailable;
    this.#syncHudItemTooltipAvailableHeight(tooltip, viewportHeight, margin, { availableHeight });
    let tooltipRect = tooltip.getBoundingClientRect();
    let left = anchorRect.left + ((anchorRect.width - tooltipRect.width) / 2);
    left = Math.max(margin, Math.min(viewportWidth - tooltipRect.width - margin, left));
    let top = placeAbove
      ? anchorRect.top - tooltipRect.height - gap
      : anchorRect.bottom + gap;
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(Math.max(margin, Math.min(viewportHeight - tooltipRect.height - margin, top)))}px`;
    tooltip.dataset.tooltipDirection = "hud";
    this.#syncHudItemTooltipAvailableHeight(tooltip, viewportHeight, margin, { availableHeight });
    tooltipRect = tooltip.getBoundingClientRect();
    if (placeAbove && tooltipRect.bottom > (anchorRect.top - gap)) {
      tooltip.style.top = `${Math.round(Math.max(margin, anchorRect.top - tooltipRect.height - gap))}px`;
    } else if ((tooltipRect.top + tooltipRect.height) > (viewportHeight - margin)) {
      tooltip.style.top = `${Math.round(Math.max(margin, viewportHeight - tooltipRect.height - margin))}px`;
    }
  }

  #clampHudItemTooltipToViewport(tooltip) {
    if (!tooltip) return;
    if (tooltip === this.#itemTooltipElement && this.#isLiveHudItemTooltipAnchor(this.#itemTooltipAnchorElement, this.#itemTooltipItemId)) {
      this.#positionHudItemTooltip();
      return;
    }
    const { viewportWidth, viewportHeight } = this.#getHudTooltipViewportMetrics();
    const margin = 10;
    this.#syncHudItemTooltipAvailableHeight(tooltip, viewportHeight, margin);
    const rect = tooltip.getBoundingClientRect();
    let left = Number.parseFloat(tooltip.style.left);
    let top = Number.parseFloat(tooltip.style.top);
    if (!Number.isFinite(left)) left = rect.left;
    if (!Number.isFinite(top)) top = rect.top;
    left = Math.max(margin, Math.min(viewportWidth - rect.width - margin, left));
    top = Math.max(margin, Math.min(viewportHeight - rect.height - margin, top));
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(top)}px`;
  }

  #getHudTooltipViewportMetrics() {
    const view = this.element?.ownerDocument?.defaultView ?? window;
    const documentElement = view.document?.documentElement ?? document.documentElement;
    const visualViewport = view.visualViewport;
    return {
      viewportWidth: Math.max(
        0,
        Number(visualViewport?.width) || 0,
        Number(view.innerWidth) || 0,
        Number(documentElement?.clientWidth) || 0,
        Number(window.innerWidth) || 0
      ),
      viewportHeight: Math.max(
        0,
        Number(visualViewport?.height) || 0,
        Number(view.innerHeight) || 0,
        Number(documentElement?.clientHeight) || 0,
        Number(window.innerHeight) || 0
      )
    };
  }

  #syncHudItemTooltipAvailableHeight(tooltip, viewportHeight, margin, { availableHeight = null } = {}) {
    if (!tooltip) return;
    const style = getComputedStyle(tooltip);
    const scale = Math.max(0.1, Number.parseFloat(style.getPropertyValue("--fallout-maw-ui-scale")) || 1);
    const viewportAvailableHeight = Math.max(0, viewportHeight - (margin * 2));
    const resolvedAvailableHeight = Number.isFinite(Number(availableHeight))
      ? Math.max(0, Math.min(viewportAvailableHeight, Number(availableHeight)))
      : viewportAvailableHeight;
    const maxTooltipHeight = Math.max(80, Math.floor(resolvedAvailableHeight / scale));
    tooltip.style.setProperty("--fallout-maw-tooltip-max-height", `${maxTooltipHeight}px`);

    const picker = tooltip.querySelector(".tooltip-module-picker-panels:has(.tooltip-module-picker-panel.active)");
    if (!picker) {
      tooltip.style.removeProperty("--fallout-maw-module-picker-max-height");
      return;
    }

    const tooltipRect = tooltip.getBoundingClientRect();
    const pickerRect = picker.getBoundingClientRect();
    const nonPickerHeight = Math.max(0, tooltipRect.height - pickerRect.height);
    const maxPickerHeight = Math.max(80, Math.floor((resolvedAvailableHeight - nonPickerHeight) / scale));
    tooltip.style.setProperty("--fallout-maw-module-picker-max-height", `${maxPickerHeight}px`);
  }

  #syncHudItemTooltipLayer({ bringToFront = false } = {}) {
    if (bringToFront) this.bringToFront?.();
    const baseZIndex = getOverlayBaseZIndex(this.element);
    if (this.#itemTooltipElement) this.#itemTooltipElement.style.zIndex = String(baseZIndex + 2);
    if (this.#itemTooltipNestedElement) this.#itemTooltipNestedElement.style.zIndex = String(baseZIndex + 3);
    if (bringToFront || this.#itemTooltipPinned || this.#itemTooltipNestedPinned) {
      reserveOverlayZIndex(baseZIndex + 3);
    }
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

  #isLiveHudItemTooltipAnchor(anchor, itemId = "") {
    if (!(anchor instanceof Element) || !anchor.isConnected || !this.element?.contains(anchor)) return false;
    const expectedItemId = String(itemId ?? "");
    if (!expectedItemId) return true;
    const anchorItemId = String(anchor.dataset.hudTooltipItem ?? anchor.dataset.itemId ?? "");
    return !anchorItemId || anchorItemId === expectedItemId;
  }

  #resolveHudItemTooltipAnchor(itemId = "") {
    if (this.#isLiveHudItemTooltipAnchor(this.#itemTooltipAnchorElement, itemId)) return this.#itemTooltipAnchorElement;
    const expectedItemId = String(itemId ?? "");
    if (!expectedItemId) return null;
    const escapedItemId = CSS.escape(expectedItemId);
    const anchor = this.element?.querySelector(`[data-hud-tooltip-item="${escapedItemId}"], [data-item-id="${escapedItemId}"]`);
    if (!this.#isLiveHudItemTooltipAnchor(anchor, expectedItemId)) return null;
    this.#itemTooltipAnchorElement = anchor;
    return anchor;
  }

  #isHudItemTooltipHoverActive(anchor = null) {
    if (this.#itemTooltipPinned) return true;
    return Boolean(
      anchor?.matches?.(":hover")
      || this.#itemTooltipElement?.matches?.(":hover")
      || this.#itemTooltipNestedElement?.matches?.(":hover")
    );
  }

  #queueHudItemTooltipHoverValidation() {
    if (this.#itemTooltipPinned) return;
    const view = this.element?.ownerDocument?.defaultView ?? window;
    const validate = () => {
      if (!this.#itemTooltipElement || this.#itemTooltipPinned) return;
      const anchor = this.#resolveHudItemTooltipAnchor(this.#itemTooltipItemId);
      if (!this.#isHudItemTooltipHoverActive(anchor)) this.#clearHudItemTooltip();
    };
    if (typeof view.requestAnimationFrame === "function") view.requestAnimationFrame(validate);
    else view.setTimeout(validate, 0);
  }

  #clearDetachedHudTooltips() {
    if (this.#itemTooltipElement) {
      const anchor = this.#resolveHudItemTooltipAnchor(this.#itemTooltipItemId);
      if (anchor) {
        this.#cancelHudItemTooltipClose();
        this.#syncHudItemTooltipLayer();
        this.#positionHudItemTooltip();
        void this.#refreshHudItemTooltip();
        if (!this.#itemTooltipPinned) this.#queueHudItemTooltipHoverValidation();
      } else if (this.#itemTooltipPinned) {
        this.#syncHudItemTooltipLayer();
        this.#clampHudItemTooltipToViewport(this.#itemTooltipElement);
        void this.#refreshHudItemTooltip();
      } else {
        this.#clearHudItemTooltip();
      }
    }

    if (this.#itemTooltipNestedElement && (
      !this.#itemTooltipNestedAnchorElement?.isConnected
      || !this.#itemTooltipElement?.contains(this.#itemTooltipNestedAnchorElement)
    )) {
      this.#clearNestedHudItemTooltip({ force: true });
    }

    if (this.#actionPointCostTooltipElement && (
      !this.#actionPointCostTooltipElement.isConnected
      || !this.element?.contains(this.#actionPointCostTooltipElement)
    )) {
      this.#clearActionPointCostTooltip();
    }

    if (this.#limbPopover.element && (
      !this.#limbPopover.hoveredPart?.isConnected
      || !this.element?.contains(this.#limbPopover.hoveredPart)
    )) {
      this.#destroyLimbPopover();
    }
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
  const prosthesis = getInstalledActorProsthesis(actor, limbKey);
  if (prosthesis) {
    const hasCondition = hasItemFunction(prosthesis, ITEM_FUNCTIONS.condition);
    const condition = hasCondition ? getConditionFunction(prosthesis) : {};
    const conditionMax = Math.max(0, toInteger(condition.max));
    const conditionValue = Math.max(0, toInteger(condition.value));
    const ratio = hasCondition && conditionMax > 0 ? Math.max(0, Math.min(1, conditionValue / conditionMax)) : 1;
    return {
      ...limb,
      value: hasCondition ? conditionValue : toInteger(limb?.max),
      max: hasCondition ? conditionMax : toInteger(limb?.max),
      min: 0,
      scaleMax: hasCondition ? conditionMax : toInteger(limb?.max),
      displayValue: hasCondition ? conditionValue : "∞",
      displayMax: hasCondition ? conditionMax : "",
      stateLabel: prosthesis.name,
      fill: mixColor([22, 81, 122], [143, 216, 255], ratio),
      popoverRows: [
        { label: "Протез", value: prosthesis.name },
        { label: "Состояние", value: hasCondition ? `${conditionValue} / ${conditionMax}` : "∞" },
        { label: "Интеграция", value: `${Math.max(0, Math.min(100, toInteger(getProsthesisFunction(prosthesis).integrationPercent)))}%` }
      ]
    };
  }
  if (isLimbDestroyed(actor, limbKey)) {
    const stateLabel = getDestroyedLimbStateLabel(actor, limbKey);
    return {
      ...limb,
      displayValue: stateLabel,
      displayMax: "",
      stateLabel,
      fill: "rgba(6, 8, 8, 0.96)"
    };
  }
  const max = getLimbHealingCap(actor, limbKey);
  if (max >= toInteger(limb?.max)) return limb;
  const min = toInteger(limb?.min);
  const value = Math.min(Math.max(toInteger(limb?.value), min), max);
  return {
    ...limb,
    value,
    max,
    scaleMax: limb.max
  };
}

function getInstalledActorProsthesis(actor, limbKey = "") {
  const key = String(limbKey ?? "").trim();
  if (!key) return null;
  return actor?.items?.find(item => (
    item.type === "gear"
    && item.system?.equipped
    && hasItemFunction(item, ITEM_FUNCTIONS.prosthesis)
    && String(item.system?.placement?.mode ?? "") === "prosthesis"
    && String(item.system?.placement?.limbKey ?? "") === key
  )) ?? null;
}

function prepareLimbEntries(limbs = {}) {
  return Object.entries(limbs ?? {}).map(([key, limb]) => {
    const popoverRows = Array.isArray(limb?.popoverRows) ? limb.popoverRows : [];
    return prepareIndicatorEntry({
      key,
      label: String(limb?.label ?? key),
      color: "#8f8456",
      data: limb,
      popoverRowsJson: JSON.stringify(popoverRows)
    });
  });
}

function prepareResourceEntries(actor) {
  const limited = getResourceLimitState(actor).resources;
  return getResourceSettings()
    .filter(resource => resource.key !== REACTION_RESOURCE_KEY)
    .map(resource => prepareIndicatorEntry({
      ...resource,
      data: actor.system.resources?.[resource.key]
    }))
    .map(entry => decorateActionPointHudEntry(actor, entry))
    .map(entry => addLimitedResourceDisplay(entry, limited[entry.key]));
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
    .filter(item => !hasItemFunction(item, ITEM_FUNCTIONS.lightSource, { ignoreBroken: true }) || isHudEquipmentLightSource(item))
    .map(item => {
      const firstAidCharges = getActiveItemChargesData(item);
      const isLightSource = hasItemFunction(item, ITEM_FUNCTIONS.lightSource, { ignoreBroken: true });
      return {
        id: item.id,
        name: isLightSource ? getLightSourceDisplayName(item) : item.name,
        img: normalizeImagePath(item.img, fallbackIcon),
        quantity: toInteger(item.system?.quantity),
        showQuantity: toInteger(item.system?.maxStack) > 1,
        firstAidCharges,
        showFirstAidCharges: !isLightSource && isActiveItem(item) && firstAidCharges.max > 1
      };
    });
}

function isHudEquipmentLightSource(item = null) {
  return Boolean(
    item
    && hasItemFunction(item, ITEM_FUNCTIONS.lightSource, { ignoreBroken: true })
    && String(item.system?.placement?.mode ?? "") === "equipment"
  );
}

function prepareOwnedAbilityButtons(actor, fallbackIcon) {
  return actor.items
    .filter(item => item.type === "ability")
    .map(item => {
      const toggleState = getFixedAbilityToggleState(item);
      return {
        id: item.id,
        name: item.name,
        img: normalizeImagePath(item.img, fallbackIcon),
        active: isActiveAbility(item),
        toggleable: toggleState.toggleable,
        toggled: toggleState.active
      };
    });
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
  return Boolean(system.active || system.activation?.enabled || system.use?.enabled || hasActiveFixedAbilityFunction(item));
}

function prepareSystemActionButtons(hudIcons = {}) {
  const advancementAction = {
    key: "advancement",
    label: "Повышение уровня",
    img: normalizeImagePath(hudIcons.levelUpIcon, "icons/svg/upgrade.svg")
  };
  const configuredActions = getSystemActionSettings().map(action => ({
    ...action,
    img: normalizeImagePath(action.img, "icons/svg/aura.svg")
  }));
  return [advancementAction, ...configuredActions];
}

function prepareActiveActionButtons(token, actor, weaponSet = null, selectedWeapon = null, selectedWeaponDisabled = false, hudIcons = {}) {
  const grappleTargetId = getGrappleTargetId(token);
  const grapplerId = getGrapplerId(token);
  const grappleLabel = grappleTargetId
    ? game.i18n.localize("FALLOUTMAW.Settings.HUD.ReleaseGrapple")
    : (grapplerId ? game.i18n.localize("FALLOUTMAW.Settings.HUD.EscapeGrapple") : game.i18n.localize("FALLOUTMAW.Settings.HUD.Grapple"));
  const push = resolveHudPushAction(actor, weaponSet, selectedWeapon, selectedWeaponDisabled);
  return [
    {
      key: "grapple",
      label: grappleLabel,
      img: normalizeImagePath(hudIcons.activeActions?.grapple, normalizeImagePath(hudIcons.weaponActions?.meleeAttack, "icons/svg/net.svg")),
      action: "useActiveAction",
      datasetKey: "activeActionKey",
      disabled: !actor?.isOwner
    },
    {
      key: "dragGrappled",
      label: game.i18n.localize("FALLOUTMAW.Settings.HUD.DragGrappled"),
      img: normalizeImagePath(hudIcons.activeActions?.dragGrappled, "icons/svg/wingfoot.svg"),
      action: "dragGrappledTarget",
      disabled: !grappleTargetId || !actor?.isOwner
    },
    {
      key: "push",
      label: game.i18n.localize("FALLOUTMAW.Settings.HUD.Push"),
      img: normalizeImagePath(hudIcons.activeActions?.push, normalizeImagePath(hudIcons.weaponActions?.push, "icons/svg/impact.svg")),
      action: "useActiveAction",
      datasetKey: "activeActionKey",
      disabled: !push || !actor?.isOwner
    }
  ];
}

function prepareActionGroups(activeActions = [], systemActions = []) {
  return [
    {
      key: "active",
      label: game.i18n.localize("FALLOUTMAW.Settings.HUD.ActionsActive"),
      actions: activeActions
    },
    {
      key: "service",
      label: game.i18n.localize("FALLOUTMAW.Settings.HUD.ActionsService"),
      actions: systemActions
    }
  ];
}

function prepareTrayContext(activeTray, skills, items, abilities, activeActions, systemActions, actionGroups, weaponActionRows, weaponSet = null, weaponSets = [], weaponEquipChoices = []) {
  const trayItems = activeTray === "skills"
    ? skills
    : activeTray === "items"
      ? items
      : activeTray === "abilities"
        ? abilities
        : activeTray === "actions"
          ? [...activeActions, ...systemActions]
          : activeTray === "weaponActions"
            ? weaponActionRows.flatMap(row => row.actions)
            : activeTray === "weaponSets"
              ? weaponSets
              : activeTray === "weaponEquip"
                ? weaponEquipChoices
                : [];
  return {
    skills,
    items,
    abilities,
    abilityGroups: prepareAbilityGroups(abilities),
    activeActions,
    systemActions,
    actionGroups,
    weaponActionRows,
    weaponSet,
    weaponSets,
    weaponEquipChoices,
    metrics: prepareTrayMetrics(trayItems),
    visible: Boolean(activeTray)
  };
}

function prepareTrayMetrics(_items) {
  return {
    style: ""
  };
}

function prepareActions(activeTray, selectedWeapon, items, abilities, actionGroups, hudIcons = {}) {
  return HUD_ACTIONS.filter(action => action.key !== "weapon").map(action => {
    const count = action.key === "items"
      ? items.length
      : action.key === "abilities"
        ? abilities.length
        : action.key === "actions"
          ? actionGroups.reduce((total, group) => total + (group.actions?.length ?? 0), 0)
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

function prepareHudWeaponSet(actor, weaponSets = [], activeSetKey = "", selectedWeaponId = "", hudIcons = {}) {
  return prepareHudWeaponSets(actor, weaponSets, activeSetKey, selectedWeaponId, hudIcons)
    .find(entry => entry.key === activeSetKey) ?? null;
}

function prepareHudWeaponSets(actor, weaponSets = [], activeSetKey = "", selectedWeaponId = "", hudIcons = {}) {
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
      hudStatusBadges: prepareHudWeaponStatusBadges(actor?.items?.get(slot.item?.id ?? "")),
      weaponSetKey: set.key,
      selected: Boolean(slot.item?.id && slot.item.id === selectedWeaponId)
    })),
    emptySlots: (set.slots ?? [])
      .filter(slot => !slot.item && !slot.phantom)
      .map(slot => ({
        ...slot,
        weaponSetKey: set.key,
        emptyIcon: normalizeImagePath(hudIcons.emptyWeaponSlotIcon, "icons/svg/combat.svg")
      }))
  }));
}

function prepareHudWeaponStatusBadges(item = null) {
  if (!item) return {};
  const weaponData = hasItemFunction(item, ITEM_FUNCTIONS.weapon)
    ? applyWeaponModuleModifiers(getWeaponFunctionById(item, ITEM_FUNCTIONS.weapon) ?? {}, {
      moduleSlots: getWeaponFunctionModuleSlots(item, ITEM_FUNCTIONS.weapon)
    })
    : null;
  const magazine = prepareHudWeaponMagazineBadge(weaponData);
  const condition = prepareHudWeaponConditionBadge(item);
  return { magazine, condition };
}

function prepareHudWeaponMagazineBadge(weaponData = null) {
  if (!weaponData || !hasWeaponResourceCostData(weaponData, "magazine")) return null;
  const max = Math.max(0, toInteger(weaponData?.magazine?.max));
  if (!max) return null;
  const value = Math.max(0, Math.min(max, toInteger(weaponData?.magazine?.value)));
  return {
    label: `${value}/${max}`
  };
}

function prepareHudWeaponConditionBadge(item = null) {
  if (!item || !hasItemFunction(item, ITEM_FUNCTIONS.condition)) return null;
  const condition = getConditionFunction(item);
  const max = Math.max(0, toInteger(condition.max));
  if (!max) return null;
  const value = Math.max(0, Math.min(max, toInteger(condition.value)));
  const percent = Math.max(0, Math.min(100, Math.round((value / max) * 100)));
  return {
    label: `${percent}%`,
    tone: percent >= 67 ? "high" : (percent >= 34 ? "medium" : "low")
  };
}

function getHudItemAspectStyle(item = null) {
  const cachedAspect = getCachedHudImageAspect(item?.img);
  return cachedAspect ? `--fallout-maw-hud-image-aspect: ${cachedAspect};` : "";
}

function getCachedHudImageAspect(src = "") {
  const keys = getHudImageAspectCacheKeys(src);
  for (const key of keys) {
    const value = hudImageAspectCache.get(key);
    if (value) return value;
  }
  return 0;
}

function collectHudImageAspectSources(actor, weaponSets = [], weaponEquipTarget = null) {
  const sources = new Set();
  for (const set of weaponSets ?? []) {
    for (const slot of set.slots ?? []) {
      const img = String(slot?.item?.img ?? "").trim();
      if (img) sources.add(img);
    }
  }

  if (weaponEquipTarget?.weaponSetKey && weaponEquipTarget?.weaponSlotKey) {
    for (const item of actor?.items?.contents ?? []) {
      if (!isHudWeaponEquipCandidate(item)) continue;
      if (!canFitHudWeaponInTarget(actor, item, weaponEquipTarget.weaponSetKey, weaponEquipTarget.weaponSlotKey, {
        replaceItemId: weaponEquipTarget.replaceItemId ?? ""
      })) continue;
      const img = String(item.img ?? "").trim();
      if (img) sources.add(img);
    }
  }

  return Array.from(sources);
}

async function preloadHudImageAspects(sources = []) {
  const pending = Array.from(new Set(sources.map(src => String(src ?? "").trim()).filter(Boolean)))
    .filter(src => !getCachedHudImageAspect(src))
    .map(src => preloadHudImageAspect(src));
  if (!pending.length) return;
  await Promise.allSettled(pending);
}

async function preloadHudImageAspect(src = "") {
  const normalized = normalizeImagePath(src);
  if (!normalized || getCachedHudImageAspect(normalized)) return true;

  let texture = null;
  try {
    texture = await foundry.canvas.loadTexture(normalized);
  } catch (error) {
    console.warn(`${SYSTEM_ID} | HUD weapon image failed to load: ${normalized}`, error);
    return false;
  }

  const width = Number(texture?.width ?? texture?.baseTexture?.width);
  const height = Number(texture?.height ?? texture?.baseTexture?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;

  const aspectText = String(Math.max(1, width / height));
  for (const key of getHudImageAspectCacheKeys(src)) hudImageAspectCache.set(key, aspectText);
  for (const key of getHudImageAspectCacheKeys(normalized)) hudImageAspectCache.set(key, aspectText);
  return true;
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

function prepareHudWeaponEquipChoices(actor, target = null, hudIcons = {}) {
  if (!actor || !target?.weaponSetKey || !target?.weaponSlotKey) return [];
  const cost = getWeaponSwitchActionPointCost(actor);
  return actor.items.contents
    .filter(item => isHudWeaponEquipCandidate(item))
    .filter(item => canFitHudWeaponInTarget(actor, item, target.weaponSetKey, target.weaponSlotKey, {
      replaceItemId: target.replaceItemId ?? ""
    }))
    .map(item => ({
      id: item.id,
      name: item.name,
      img: normalizeImagePath(item.img, normalizeImagePath(hudIcons.emptyWeaponSlotIcon, "icons/svg/combat.svg")),
      weaponSetKey: target.weaponSetKey,
      weaponSlotKey: target.weaponSlotKey,
      hudAspectStyle: getHudItemAspectStyle(item),
      actionPointCostLabel: cost > 0 ? `${cost} ОД` : "",
      disabled: false
    }));
}

function isHudWeaponEquipCandidate(item) {
  return Boolean(
    item
    && item.type === "gear"
    && item.system?.placement?.mode === "inventory"
    && hasItemFunction(item, ITEM_FUNCTIONS.weapon, { ignoreBroken: true })
    && getWeaponSlotRequirement(item).selectedKeys.size
  );
}

async function equipHudWeaponInSlot(actor, item, weaponSetKey = "", weaponSlotKey = "", { replaceItemId = "" } = {}) {
  if (!actor?.isOwner || !item) return null;
  if (!canFitHudWeaponInTarget(actor, item, weaponSetKey, weaponSlotKey, { replaceItemId })) {
    ui.notifications.warn("Оружие не помещается в выбранные слоты.");
    return null;
  }

  const conflicts = getHudWeaponPlacementConflicts(actor, item, weaponSetKey, weaponSlotKey, { replaceItemId });
  const replacementUpdates = createHudWeaponReplacementUpdates(actor, conflicts, [item.id]);
  if (!replacementUpdates) return null;
  if (!canSpendWeaponSwitchActionPoints(actor)) return null;

  const storedPlacement = createStoredPlacement({
    mode: "weapon",
    equipmentSlot: "",
    weaponSet: weaponSetKey,
    weaponSlot: weaponSlotKey,
    limbKey: "",
    x: 1,
    y: 1
  }, item);
  const updates = [
    ...replacementUpdates,
    {
      _id: item.id,
      "system.equipped": false,
      "system.container.parentId": ROOT_CONTAINER_ID,
      "system.placement.mode": storedPlacement.mode,
      "system.placement.equipmentSlot": storedPlacement.equipmentSlot,
      "system.placement.weaponSet": storedPlacement.weaponSet,
      "system.placement.weaponSlot": storedPlacement.weaponSlot,
      "system.placement.limbKey": storedPlacement.limbKey,
      "system.placement.x": storedPlacement.x,
      "system.placement.y": storedPlacement.y,
      "system.placement.width": storedPlacement.width,
      "system.placement.height": storedPlacement.height,
      "system.placement.rotated": storedPlacement.rotated
    }
  ];

  await actor.updateEmbeddedDocuments("Item", updates);
  await spendWeaponSwitchActionPoints(actor);
  return actor.items.get(item.id) ?? item;
}

function canFitHudWeaponInTarget(actor, item, weaponSetKey = "", weaponSlotKey = "", { replaceItemId = "" } = {}) {
  const requiredSlotKeys = getHudWeaponPlacementSlotKeys(actor, item, weaponSetKey, weaponSlotKey);
  if (!requiredSlotKeys.length) return false;
  const occupiedItemIds = getHudWeaponOccupiedItemIds(actor, weaponSetKey, requiredSlotKeys);
  for (const itemId of occupiedItemIds) {
    if (itemId === item.id || itemId === replaceItemId) continue;
    return false;
  }
  return true;
}

function getHudWeaponPlacementSlotKeys(actor, item, weaponSetKey = "", weaponSlotKey = "") {
  const race = getCreatureOptions().races.find(entry => entry.id === actor?.system?.creature?.raceId) ?? null;
  if (!weaponSetKey || !weaponSlotKey) return [];

  if (isContainerWeaponSetKey(weaponSetKey)) {
    const inventory = prepareInventoryContext(actor, race);
    const set = getHudWeaponSets(inventory).find(entry => entry.key === weaponSetKey);
    const slots = set?.slots ?? [];
    const primaryIndex = slots.findIndex(slot => slot.key === weaponSlotKey);
    if (primaryIndex < 0) return [];
    const size = getWeaponSlotRequirementSize(item, race);
    const requiredSlots = slots.slice(primaryIndex, primaryIndex + size);
    return requiredSlots.length === size ? requiredSlots.map(slot => slot.key) : [];
  }

  if (!canUseWeaponSlotForItem(race, item, weaponSetKey, weaponSlotKey)) return [];
  return getRequiredWeaponSlotsForItem(race, item, weaponSetKey, weaponSlotKey).map(slot => slot.key);
}

function getHudWeaponOccupiedItemIds(actor, weaponSetKey = "", slotKeys = []) {
  const race = getCreatureOptions().races.find(entry => entry.id === actor?.system?.creature?.raceId) ?? null;
  const inventory = prepareInventoryContext(actor, race);
  const set = getHudWeaponSets(inventory).find(entry => entry.key === weaponSetKey);
  const targetKeys = new Set(slotKeys);
  return Array.from(new Set((set?.slots ?? [])
    .filter(slot => targetKeys.has(slot.key))
    .map(slot => String(slot.item?.id ?? ""))
    .filter(Boolean)));
}

function getHudWeaponPlacementConflicts(actor, item, weaponSetKey = "", weaponSlotKey = "", { replaceItemId = "" } = {}) {
  const itemIds = getHudWeaponOccupiedItemIds(actor, weaponSetKey, getHudWeaponPlacementSlotKeys(actor, item, weaponSetKey, weaponSlotKey))
    .filter(itemId => itemId !== item.id);
  if (replaceItemId && !itemIds.includes(replaceItemId)) itemIds.push(replaceItemId);
  return Array.from(new Set(itemIds))
    .map(itemId => actor.items.get(itemId))
    .filter(Boolean);
}

function createHudWeaponReplacementUpdates(actor, conflicts = [], excludeItemIds = []) {
  const items = Array.from(new Map(conflicts.filter(Boolean).map(item => [item.id, item])).values());
  if (!items.length) return [];

  const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
  for (const item of items) excluded.add(item.id);

  const reservedPlacementContexts = [];
  const updates = [];

  for (const item of items) {
    const placementContext = getFirstAvailableHudInventoryPlacementContext(actor, item, Array.from(excluded), reservedPlacementContexts);
    if (!placementContext) {
      ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));
      return null;
    }
    reservedPlacementContexts.push({ ...placementContext, itemData: item });
    const storedPlacement = createStoredPlacement(placementContext.placement, item);
    updates.push({
      _id: item.id,
      "system.equipped": false,
      "system.container.parentId": String(placementContext.parentId ?? ROOT_CONTAINER_ID),
      "system.placement.mode": storedPlacement.mode,
      "system.placement.equipmentSlot": storedPlacement.equipmentSlot,
      "system.placement.weaponSet": storedPlacement.weaponSet,
      "system.placement.weaponSlot": storedPlacement.weaponSlot,
      "system.placement.limbKey": storedPlacement.limbKey,
      "system.placement.x": storedPlacement.x,
      "system.placement.y": storedPlacement.y,
      "system.placement.width": storedPlacement.width,
      "system.placement.height": storedPlacement.height,
      "system.placement.rotated": storedPlacement.rotated
    });
  }
  return updates;
}

function getFirstAvailableHudInventoryPlacementContext(actor, itemData = null, excludeItemIds = [], reservedPlacementContexts = []) {
  for (const parentId of getHudInventoryPlacementParentCandidates(actor, itemData, excludeItemIds)) {
    const normalizedParentId = String(parentId ?? ROOT_CONTAINER_ID);
    const reservedPlacements = reservedPlacementContexts
      .filter(entry => String(entry?.parentId ?? ROOT_CONTAINER_ID) === normalizedParentId)
      .map(entry => entry.placement);
    if (!canFitHudItemWeightInParent(actor, itemData, parentId, reservedPlacementContexts, excludeItemIds)) continue;
    const placement = getFirstAvailableHudInventoryPlacement(actor, itemData, excludeItemIds, reservedPlacements, parentId);
    if (placement) return { parentId, placement };
  }
  return null;
}

function getHudInventoryPlacementParentCandidates(actor, itemData = null, excludeItemIds = []) {
  const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
  const candidates = [ROOT_CONTAINER_ID];
  const race = getCreatureOptions().races.find(entry => entry.id === actor?.system?.creature?.raceId) ?? null;
  const inventory = prepareInventoryContext(actor, race);
  for (const container of inventory.containers ?? []) {
    const parentId = String(container?.id ?? "");
    if (!parentId || excluded.has(parentId)) continue;
    if (hasContainerCycle(itemData, parentId, actor.items)) continue;
    candidates.push(parentId);
  }
  return candidates;
}

function canFitHudItemWeightInParent(actor, itemData = null, parentId = ROOT_CONTAINER_ID, reservedPlacementContexts = [], excludeItemIds = []) {
  if (!parentId) return true;
  const container = actor.items.get(parentId);
  if (!container) return false;
  const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
  const releasedLoad = actor.items.contents
    .filter(item => excluded.has(item.id) && String(item.system?.container?.parentId ?? ROOT_CONTAINER_ID) === String(parentId))
    .reduce((total, item) => total + getItemTotalWeight(item, actor.items), 0);
  const currentLoad = Math.max(0, getContainerContentsWeight(container, actor.items) - releasedLoad);
  const reservedLoad = reservedPlacementContexts
    .filter(entry => String(entry?.parentId ?? ROOT_CONTAINER_ID) === String(parentId))
    .reduce((total, entry) => total + getItemTotalWeight(entry.itemData, actor.items), 0);
  return currentLoad + reservedLoad + getItemTotalWeight(itemData, actor.items) <= getContainerMaxLoad(container) + 0.0001;
}

function getFirstAvailableHudInventoryPlacement(actor, itemData = null, excludeItemIds = [], reservedPlacements = [], parentId = ROOT_CONTAINER_ID) {
  const dimensions = getHudInventoryContextDimensions(actor, parentId);
  return findFirstAvailableInventoryPlacement(
    getContextInventoryItems(parentId, actor.items),
    dimensions.columns,
    dimensions.rows,
    itemData,
    actor.items,
    excludeItemIds,
    reservedPlacements,
    getActorRootInventoryGridOptions(actor, parentId)
  );
}

function getHudInventoryContextDimensions(actor, parentId = ROOT_CONTAINER_ID) {
  if (parentId) return getContainerDimensions(actor.items?.get(parentId));
  return getActorRootInventoryDimensions(actor);
}

function isHudWeaponDisabled(actor, weapon) {
  const race = getCreatureOptions().races.find(entry => entry.id === actor?.system?.creature?.raceId);
  const inventory = actor ? prepareInventoryContext(actor, race) : { weaponSets: [] };
  const placement = weapon?.system?.placement ?? {};
  const set = getHudWeaponSets(inventory).find(entry => entry.key === placement.weaponSet);
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

function resolveHudPushAction(actor, weaponSet = null, selectedWeapon = null, selectedWeaponDisabled = false) {
  if (!actor) return null;
  const selected = selectedWeapon ?? resolveSelectedHudWeapon(actor);
  const selectedDisabled = selectedWeapon ? selectedWeaponDisabled : isHudWeaponDisabled(actor, selected);
  const selectedPush = selectedDisabled ? null : getFirstWeaponPushFunction(actor, selected);
  if (selectedPush) return selectedPush;

  const set = weaponSet ?? resolveActivePreparedHudWeaponSet(actor);
  for (const slot of getUniqueHudWeaponSlots(set?.slots ?? [])) {
    const weapon = actor.items.get(slot.item?.id ?? "");
    if (!weapon || slot.useDisabled || isHudWeaponDisabled(actor, weapon)) continue;
    const push = getFirstWeaponPushFunction(actor, weapon);
    if (push) return push;
  }
  return null;
}

function resolveSelectedHudWeapon(actor) {
  const race = getCreatureOptions().races.find(entry => entry.id === actor?.system?.creature?.raceId);
  const inventory = actor ? prepareInventoryContext(actor, race) : { weaponSets: [] };
  const hudWeaponSets = getHudWeaponSets(inventory);
  const activeWeaponSetKey = getActiveHudWeaponSetKey(actor, hudWeaponSets);
  return getSelectedHudWeapon(actor, hudWeaponSets, activeWeaponSetKey);
}

function resolveActivePreparedHudWeaponSet(actor) {
  const race = getCreatureOptions().races.find(entry => entry.id === actor?.system?.creature?.raceId);
  const inventory = actor ? prepareInventoryContext(actor, race) : { weaponSets: [] };
  const hudWeaponSets = getHudWeaponSets(inventory);
  const activeWeaponSetKey = getActiveHudWeaponSetKey(actor, hudWeaponSets);
  const selectedWeapon = getSelectedHudWeapon(actor, hudWeaponSets, activeWeaponSetKey);
  return prepareHudWeaponSet(actor, hudWeaponSets, activeWeaponSetKey, selectedWeapon?.id ?? "", getTokenActionHudIcons());
}

function getFirstWeaponPushFunction(actor, weapon) {
  if (!weapon || !hasItemFunction(weapon, ITEM_FUNCTIONS.weapon)) return null;
  for (const weaponFunction of getEnabledWeaponFunctions(weapon)) {
    const weaponData = applyWeaponModuleModifiers(weaponFunction?.data ?? {}, {
      moduleSlots: getWeaponFunctionModuleSlots(weapon, weaponFunction?.id)
    });
    if (!weaponData?.availableActions?.push) continue;
    if (getWeaponActionBlockState(actor, "push").blocked) continue;
    return {
      weapon,
      weaponFunctionId: weaponFunction.id
    };
  }
  return null;
}

function isMiddleMouseClick(event) {
  return event?.button === 1;
}

function isWeaponActionBrokenForHud(weapon, weaponFunctionId = "") {
  if (!weapon) return false;
  if (isItemBrokenByCondition(weapon)) return true;
  const id = String(weaponFunctionId || ITEM_FUNCTIONS.weapon);
  if (!id || id === ITEM_FUNCTIONS.weapon) return false;
  return getEnabledWeaponFunctions(weapon, { ignoreBroken: true })
    .some(entry => String(entry.id ?? "") === id && Boolean(entry.sourceBroken));
}

function prepareWeaponActionRows(actor, selectedWeapon, forceDisabled = false, hudIcons = {}, selectedWeaponSlot = null, token = null) {
  if (!selectedWeapon) return [];
  const weaponBroken = isItemBrokenByCondition(selectedWeapon);
  const rows = getEnabledWeaponFunctions(selectedWeapon, { ignoreBroken: true })
    .sort((left, right) => {
      if (left.isPrimary === right.isPrimary) return (left.index ?? 0) - (right.index ?? 0);
      return left.isPrimary ? 1 : -1;
    })
    .map((weaponFunction, index) => ({
      id: weaponFunction.id,
      label: weaponFunction.isPrimary
        ? selectedWeapon.name
        : weaponFunction.name || `${game.i18n.localize("FALLOUTMAW.Item.AdditionalWeaponFunction")} ${index + 1}`,
      actions: prepareWeaponActionButtonsForFunction(actor, selectedWeapon, weaponFunction, forceDisabled, hudIcons, { weaponBroken })
    }))
    .filter(row => row.actions.length);
  if (rows.length && selectedWeaponSlot?.weaponSetKey && selectedWeaponSlot?.key) {
    rows.at(-1).actions.push({
      key: "replaceWeapon",
      label: "Заменить",
      isWeaponReplaceControl: true,
      disabled: forceDisabled,
      itemId: selectedWeapon.id,
      weaponSetKey: selectedWeaponSlot.weaponSetKey,
      weaponSlotKey: selectedWeaponSlot.key,
      img: normalizeImagePath(hudIcons.weaponActions?.replaceWeapon, "icons/svg/direction.svg")
    });
  }
  const lightRow = prepareLightSourceActionRow(selectedWeapon, token, forceDisabled, hudIcons);
  if (lightRow) rows.push(lightRow);
  return rows;
}

function prepareLightSourceActionRow(item = null, token = null, forceDisabled = false, hudIcons = {}) {
  if (!item || !hasItemFunction(item, ITEM_FUNCTIONS.lightSource, { ignoreBroken: true })) return null;
  const active = isLightSourceActive(token?.document ?? token, item);
  const canToggleOn = active || canActivateLightSource(item);
  const actions = [
    {
      key: "lightToggle",
      label: game.i18n.localize(active ? "FALLOUTMAW.Item.LightSourceToggleOff" : "FALLOUTMAW.Item.LightSourceToggleOn"),
      itemId: item.id,
      isLightToggleControl: true,
      disabled: forceDisabled || !canToggleOn,
      img: normalizeImagePath(hudIcons.weaponActions?.[active ? "lightOff" : "lightOn"], "icons/svg/light.svg")
    }
  ];
  if (lightSourceUsesEnergyConsumer(item)) {
    actions.push({
      key: "lightRecharge",
      label: game.i18n.localize("FALLOUTMAW.Item.LightSourceRecharge"),
      itemId: item.id,
      isLightRechargeControl: true,
      disabled: forceDisabled,
      img: normalizeImagePath(hudIcons.weaponActions?.lightRecharge, "icons/svg/upgrade.svg")
    });
  }
  return {
    id: "lightSource",
    label: getLightSourceDisplayName(item),
    actions
  };
}

function prepareWeaponActionButtonsForFunction(actor, selectedWeapon, weaponFunction, forceDisabled = false, hudIcons = {}, { weaponBroken = false } = {}) {
  const moduleSlots = getWeaponFunctionModuleSlots(selectedWeapon, weaponFunction?.id);
  const moduleWeaponData = applyWeaponModuleModifiers(weaponFunction?.data ?? {}, {
    moduleSlots
  });
  const attackPowerState = getWeaponAttackPowerState(moduleWeaponData);
  const weaponData = moduleWeaponData;
  const actions = weaponData?.availableActions ?? {};
  const hasMagazineCost = hasWeaponResourceCostData(weaponData, "magazine");
  const buttons = [
    {
      key: "attackPower",
      label: game.i18n.localize("FALLOUTMAW.Item.WeaponSpecialAttackPower"),
      configured: attackPowerState.active,
      visible: attackPowerState.active,
      isAttackPowerControl: true,
      attackPowerLabel: `${attackPowerState.value}/${attackPowerState.max}`
    },
    { key: "aimedShot", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionAimedShot"), configured: Boolean(actions.aimedShot) },
    { key: "snapshot", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionSnapshot"), configured: Boolean(actions.snapshot) },
    { key: "burst", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionBurst"), configured: Boolean(actions.burst), visible: Boolean(actions.burst) },
    { key: "volley", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionVolley"), configured: Boolean(actions.volley), visible: Boolean(actions.volley) },
    { key: "meleeAttack", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionMeleeAttack"), configured: Boolean(actions.meleeAttack) },
    { key: "aimedMeleeAttack", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionAimedMeleeAttack"), configured: Boolean(actions.aimedMeleeAttack) },
    { key: "push", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionPush"), configured: Boolean(actions.push), visible: Boolean(actions.push) },
    { key: "reload", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionReload"), configured: hasMagazineCost, visible: hasMagazineCost }
  ];
  return buttons.filter(action => action.visible !== false && action.configured).map(action => {
    const broken = weaponBroken || Boolean(weaponFunction?.sourceBroken);
    if (action.isAttackPowerControl) {
      return {
        ...action,
        disabled: forceDisabled,
        itemId: selectedWeapon.id,
        weaponFunctionId: weaponFunction.isPrimary ? ITEM_FUNCTIONS.weapon : weaponFunction.id
      };
    }
    const blockState = getWeaponActionBlockState(actor, action.key);
    const actionPointCostState = getWeaponActionPointCostStateForHud(actor, weaponData, action.key, weaponFunction?.data ?? {}, { moduleSlots });
    const actionPointCost = actionPointCostState.cost;
    return {
      ...action,
      label: String(weaponData?.[action.key]?.name ?? "").trim() || action.label,
      disabled: forceDisabled || blockState.blocked,
      itemId: selectedWeapon.id,
      weaponFunctionId: weaponFunction.isPrimary ? ITEM_FUNCTIONS.weapon : weaponFunction.id,
      img: normalizeImagePath(hudIcons.weaponActions?.[action.key], "icons/svg/combat.svg"),
      actionPointCost,
      actionPointCostClass: actionPointCostState.tone ? `cost-${actionPointCostState.tone}` : "",
      actionPointCostLabel: `${actionPointCost} ОД`,
      actionPointCostTooltipHtml: buildActionPointCostTooltipHTML({
        sources: actionPointCostState.sources
      }),
      actionPointCostTooltipLabel: `${actionPointCost} ОД`
    };
  });
}

function getWeaponActionPointCostForHud(actor, weaponData = {}, actionKey = "") {
  return getWeaponActionPointCostStateForHud(actor, weaponData, actionKey).cost;
}

function getWeaponActionPointCostStateForHud(actor, weaponData = {}, actionKey = "", sourceWeaponData = weaponData, { moduleSlots = [] } = {}) {
  const baseCost = getWeaponActionPointBaseCost(sourceWeaponData, actionKey);
  const configuredCost = getWeaponActionPointBaseCost(weaponData, actionKey);
  const atRandomReduction = getActorAtRandomActionPointCostReduction(actor, actionKey);
  const cost = Math.max(0, Math.ceil(
    applyDamageCostModifier(configuredCost, getDamageCostModifierState(actor, { actionKey }).action)
    + getActorPostureWeaponActionPointCostBonus(actor)
    - atRandomReduction
  ));
  const tone = cost < baseCost ? "cheaper" : (cost > baseCost ? "dearer" : "");
  const sources = collectActionPointCostSources(actor, {
    actionKey,
    baseCost,
    configuredCost,
    moduleSlots
  });
  return { baseCost, cost, tone, sources };
}

function getWeaponActionPointBaseCost(weaponData = {}, actionKey = "") {
  const value = Number(weaponData?.[actionKey]?.actionPointCost);
  const fallback = actionKey === "reload" ? 2 : 5;
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : fallback;
}

function collectActionPointCostSources(actor, { actionKey = "", baseCost = 0, configuredCost = 0, moduleSlots = [] } = {}) {
  let runningCost = Math.max(0, toInteger(baseCost));
  const sources = [];
  for (const source of collectModuleActionPointCostSources(moduleSlots, actionKey, runningCost)) {
    sources.push(source);
    runningCost = Math.max(0, runningCost + source.delta);
  }

  runningCost = Math.max(0, toInteger(configuredCost));
  for (const source of collectEffectActionPointCostSources(actor, actionKey, runningCost)) {
    sources.push(source);
    runningCost = Math.max(0, runningCost + source.delta);
  }

  for (const source of collectPostureActionPointCostSources(actor, runningCost)) {
    sources.push(source);
    runningCost = Math.max(0, runningCost + source.delta);
  }

  for (const source of getActorAtRandomActionPointCostSources(actor, actionKey)) {
    const delta = -Math.min(runningCost, Math.max(0, toInteger(source.reduction)));
    if (!delta) continue;
    sources.push({
      key: source.key,
      name: source.name,
      img: normalizeImagePath(source.img, FALLBACK_ICON),
      delta
    });
    runningCost = Math.max(0, runningCost + delta);
  }

  return combineActionPointCostSources(sources);
}

function collectModuleActionPointCostSources(moduleSlots = [], actionKey = "", initialCost = 0) {
  const sources = [];
  let runningCost = Math.max(0, toInteger(initialCost));
  for (const slot of getWeaponModuleSlots({ moduleSlots })) {
    const itemData = getWeaponModuleSlotItemData(slot);
    const module = getModuleFunction(itemData);
    const delta = toInteger(module?.weapon?.actionPointCosts?.[actionKey]);
    if (!delta) continue;
    const nextCost = Math.max(0, runningCost + delta);
    const actualDelta = nextCost - runningCost;
    runningCost = nextCost;
    if (!actualDelta) continue;
    sources.push({
      key: `module:${slot.id}:${String(itemData?.uuid ?? itemData?._id ?? itemData?.name ?? "")}`,
      name: getWeaponModuleDisplayName(itemData),
      img: normalizeImagePath(itemData?.img, FALLBACK_ICON),
      delta: actualDelta
    });
  }
  return sources;
}

function collectEffectActionPointCostSources(actor, actionKey = "", initialCost = 0) {
  const sources = [];
  let runningCost = Math.max(0, Number(initialCost) || 0);
  const keys = [
    "system.costs.action",
    `system.costs.actions.${String(actionKey ?? "").trim()}`
  ];
  for (const key of keys) {
    for (const source of collectActiveEffectCostChangeSources(actor, key, runningCost)) {
      sources.push(source);
      runningCost = Math.max(0, runningCost + source.delta);
    }
  }
  return sources;
}

function collectPostureActionPointCostSources(actor, initialCost = 0) {
  const postureAction = getActorPostureAction(actor);
  if (!postureAction) return [];
  return collectActiveEffectCostChangeSources(
    actor,
    `${POSTURE_EFFECT_CHANGE_ROOT}.${postureAction}.weaponActionCost`,
    Math.max(0, Number(initialCost) || 0)
  );
}

function collectActiveEffectCostChangeSources(actor, key = "", initialCost = 0) {
  const sources = [];
  let runningCost = Math.max(0, Number(initialCost) || 0);
  for (const effect of getActorApplicableEffectsForHud(actor)) {
    if (effect.disabled) continue;
    if (!isPostureEffectApplicableToActor(effect, actor)) continue;
    for (const change of effect.system?.changes ?? effect.changes ?? []) {
      if (String(change?.key ?? "").trim() !== key) continue;
      const value = evaluateActorEffectChangeNumber(actor, { ...change, effect });
      if (!Number.isFinite(value)) continue;
      const nextCost = applyActionPointCostChangeStep(runningCost, value, change.type);
      const actualDelta = Math.ceil(nextCost) - Math.ceil(runningCost);
      runningCost = nextCost;
      if (!actualDelta) continue;
      sources.push({
        key: effect.uuid || effect.id || `${effect.name}:${key}`,
        name: localizeDocumentName(effect.name),
        img: normalizeImagePath(effect.img, FALLBACK_ICON),
        delta: actualDelta
      });
    }
  }
  return sources;
}

function applyActionPointCostChangeStep(cost = 0, value = 0, type = "") {
  let next = Math.max(0, Number(cost) || 0);
  if (String(type ?? "") === "override") next = Number(value);
  else if (String(type ?? "") === "multiply") next *= Number(value);
  else next += Number(value);
  return Math.max(0, Number.isFinite(next) ? next : cost);
}

function getActorApplicableEffectsForHud(actor) {
  if (typeof actor?.allApplicableEffects === "function") return Array.from(actor.allApplicableEffects());
  return Array.from(actor?.effects ?? []);
}

function combineActionPointCostSources(sources = []) {
  const combined = new Map();
  for (const source of sources) {
    const key = String(source?.key ?? "");
    if (!key) continue;
    const existing = combined.get(key);
    if (existing) existing.delta += toInteger(source.delta);
    else combined.set(key, { ...source, delta: toInteger(source.delta) });
  }
  return Array.from(combined.values()).filter(source => source.delta);
}

function buildActionPointCostTooltipHTML({ sources = [] } = {}) {
  const rows = (sources ?? []).filter(source => toInteger(source.delta));
  if (!rows.length) return "";

  return `
    <article class="fallout-maw-effect-tooltip-content fallout-maw-action-cost-tooltip-content">
      ${rows.map(renderActionPointCostTooltipSource).join("")}
    </article>
  `;
}

function renderActionPointCostTooltipSource(source = {}) {
  const delta = toInteger(source.delta);
  const deltaClass = delta < 0 ? "negative" : "positive";
  return `
    <section class="fallout-maw-action-cost-tooltip-source">
      <img src="${escapeAttribute(source.img)}" alt="">
      <div>
        <strong>${escapeHTML(source.name)}</strong>
        <span>${escapeHTML("Изменения")}: <b class="${deltaClass}">${escapeHTML(formatActionPointCostDelta(delta))}</b></span>
      </div>
    </section>
  `;
}

function formatActionPointCostDelta(value) {
  const number = toInteger(value);
  return `${formatSignedNumber(number)} ОД`;
}

function localizeDocumentName(value) {
  const text = String(value ?? "");
  return game.i18n.has(text) ? game.i18n.localize(text) : text;
}

function hasWeaponResourceCostData(weaponData = {}, type = "") {
  if (type === "magazine" && String(weaponData?.damageMode ?? "manual") === "source") return true;
  return (weaponData?.resourceCosts ?? []).some(cost => String(cost?.type ?? "") === type);
}

async function openWeaponAttackPowerDialog({ actor = null, weapon = null, weaponFunctionId = "", application = null } = {}) {
  if (!actor?.isOwner || !weapon) return false;
  const functionId = weaponFunctionId || ITEM_FUNCTIONS.weapon;
  const weaponData = getWeaponFunctionById(weapon, functionId);
  if (!weaponData || !hasWeaponSpecialPropertyData(weaponData, WEAPON_SPECIAL_PROPERTIES.attackPower)) return false;
  const properties = Array.isArray(weaponData.specialProperties) ? weaponData.specialProperties : [];
  const propertyIndex = properties.findIndex(property => getWeaponSpecialPropertyType(property) === WEAPON_SPECIAL_PROPERTIES.attackPower);
  if (propertyIndex < 0) return false;
  const state = getWeaponAttackPowerState(weaponData);
  const min = 1;
  const max = Math.max(min, toInteger(state.max) || min);
  const value = Math.max(min, Math.min(max, toInteger(state.value) || min));
  const previewContext = buildWeaponAttackPowerPreviewContext({ actor, weapon, weaponData, functionId, propertyIndex, startLevel: value });
  const formData = await DialogV2.input({
    window: {
      title: game.i18n.localize("FALLOUTMAW.Item.WeaponSpecialAttackPower")
    },
    content: `
      <label class="fallout-maw-attack-power-dialog">
        <span>${escapeHTML(game.i18n.localize("FALLOUTMAW.Item.WeaponAttackPowerLevels"))}</span>
        <strong data-attack-power-dialog-output>${value}/${max}</strong>
        <input type="range" name="level" value="${value}" min="${min}" max="${max}" step="1" data-attack-power-dialog-range>
        <div class="fallout-maw-attack-power-preview-grid" data-attack-power-dialog-preview>
          ${renderWeaponAttackPowerPreviewRows(previewContext, value)}
        </div>
      </label>
    `,
    ok: {
      label: game.i18n.localize("FALLOUTMAW.Common.Apply"),
      icon: "fa-solid fa-check",
      callback: (_event, button) => new FormDataExtended(button.form).object
    },
    buttons: [{
      action: "cancel",
      label: game.i18n.localize("FALLOUTMAW.Common.Cancel")
    }],
    position: { width: 360 },
    rejectClose: false,
    render: (_event, dialog) => {
      const range = dialog.element?.querySelector?.("[data-attack-power-dialog-range]");
      const output = dialog.element?.querySelector?.("[data-attack-power-dialog-output]");
      const preview = dialog.element?.querySelector?.("[data-attack-power-dialog-preview]");
      const sync = () => {
        const nextLevel = Math.max(min, Math.min(max, toInteger(range?.value) || min));
        if (output) output.textContent = `${nextLevel}/${max}`;
        if (preview) preview.innerHTML = renderWeaponAttackPowerPreviewRows(previewContext, nextLevel);
      };
      range?.addEventListener("input", sync);
      sync();
    }
  });
  if (!formData || formData === "cancel") return false;
  const nextLevel = Math.max(min, Math.min(max, toInteger(formData.level) || min));
  if (nextLevel === value) return false;
  const nextProperties = normalizeWeaponSpecialProperties(properties);
  const nextProperty = foundry.utils.deepClone(nextProperties[propertyIndex] ?? {});
  foundry.utils.setProperty(nextProperty, "attackPower.level.value", nextLevel);
  nextProperties[propertyIndex] = nextProperty;
  const updateData = createWeaponFunctionUpdateData(weapon, functionId, {
    specialProperties: nextProperties
  });
  if (!Object.keys(updateData).length) return false;
  await weapon.update(updateData);
  await application?.render({ force: true });
  return true;
}

function buildWeaponAttackPowerPreviewContext({ actor = null, weapon = null, weaponData = {}, functionId = "", propertyIndex = -1, startLevel = 1 } = {}) {
  const currentData = getWeaponAttackPowerDialogDataForLevel({ weapon, weaponData, functionId, propertyIndex, level: startLevel });
  return {
    actor,
    weapon,
    weaponData,
    functionId,
    propertyIndex,
    startLevel,
    current: getWeaponAttackPowerPreviewStats(actor, weapon, currentData),
    changedKeys: getWeaponAttackPowerChangedKeys(weaponData)
  };
}

function renderWeaponAttackPowerPreviewRows(context = {}, nextLevel = 1) {
  const rows = buildWeaponAttackPowerPreviewRows(context, nextLevel);
  if (!rows.length) return "";
  return rows.map(row => `
    <div class="fallout-maw-attack-power-preview-row">
      <span>${escapeHTML(row.label)}</span>
      <strong>
        <span>${escapeHTML(row.from)}</span>
        <i class="fa-solid fa-arrow-right-long" aria-hidden="true"></i>
        <span class="${escapeAttribute(row.tone)}">${escapeHTML(row.to)}</span>
      </strong>
    </div>
  `).join("");
}

function buildWeaponAttackPowerPreviewRows(context = {}, nextLevel = 1) {
  const data = getWeaponAttackPowerDialogDataForLevel({
    weapon: context.weapon,
    weaponData: context.weaponData,
    functionId: context.functionId,
    propertyIndex: context.propertyIndex,
    level: nextLevel
  });
  const next = getWeaponAttackPowerPreviewStats(context.actor, context.weapon, data);
  const current = context.current ?? {};
  const changedKeys = context.changedKeys ?? new Set();
  const rows = [];
  const push = (key, label, from, to, { higherIsBetter = true, formatter = formatAttackPowerPreviewNumber } = {}) => {
    if (!changedKeys.has(key)) return;
    rows.push({
      label,
      from: formatter(from),
      to: formatter(to),
      tone: getAttackPowerPreviewTone(from, to, { higherIsBetter })
    });
  };

  push("damage", game.i18n.localize("FALLOUTMAW.Item.WeaponDamage"), current.damage, next.damage);
  push("accuracyBonus", game.i18n.localize("FALLOUTMAW.Item.WeaponAccuracyBonus"), current.accuracyBonus, next.accuracyBonus, { formatter: formatAttackPowerPreviewSignedNumber });
  push("criticalChanceModifier", game.i18n.localize("FALLOUTMAW.Item.WeaponCriticalChanceModifier"), current.criticalChanceModifier, next.criticalChanceModifier, { formatter: value => `${formatAttackPowerPreviewSignedNumber(value)}%` });
  push("criticalDamagePercent", game.i18n.localize("FALLOUTMAW.Item.WeaponCriticalDamagePercent"), current.criticalDamagePercent, next.criticalDamagePercent, { formatter: value => `${formatAttackPowerPreviewNumber(value)}%` });
  push("attackConeDegrees", game.i18n.localize("FALLOUTMAW.Item.WeaponAttackCone"), current.attackConeDegrees, next.attackConeDegrees, { formatter: value => `${formatAttackPowerPreviewNumber(value)}°` });
  push("maxRangeMeters", game.i18n.localize("FALLOUTMAW.Item.WeaponMaxRange"), current.maxRangeMeters, next.maxRangeMeters, { formatter: value => `${formatAttackPowerPreviewNumber(value)} м` });
  push("effectiveRange.value", game.i18n.localize("FALLOUTMAW.Item.WeaponEffectiveRange"), current.effectiveRangeValue, next.effectiveRangeValue, { formatter: value => `${formatAttackPowerPreviewNumber(value)} м` });
  push("effectiveRange.max", game.i18n.localize("FALLOUTMAW.Item.WeaponEffectiveRangeMax"), current.effectiveRangeMax, next.effectiveRangeMax, { formatter: value => `${formatAttackPowerPreviewNumber(value)} м` });
  push("penetration", game.i18n.localize("FALLOUTMAW.Item.WeaponPenetration"), current.penetration, next.penetration);

  for (const type of changedKeys) {
    if (!type.startsWith("resourceCost:")) continue;
    const resourceType = type.slice("resourceCost:".length);
    push(
      type,
      getWeaponAttackPowerResourceCostPreviewLabel(resourceType),
      current.resourceCosts?.[resourceType] ?? 0,
      next.resourceCosts?.[resourceType] ?? 0,
      { higherIsBetter: false }
    );
  }
  return rows;
}

function getWeaponAttackPowerDialogDataForLevel({ weapon = null, weaponData = {}, functionId = "", propertyIndex = -1, level = 1 } = {}) {
  const rawData = foundry.utils.deepClone(weaponData ?? {});
  const properties = normalizeWeaponSpecialProperties(rawData.specialProperties);
  if (properties[propertyIndex]) foundry.utils.setProperty(properties[propertyIndex], "attackPower.level.value", level);
  rawData.specialProperties = properties;
  return applyWeaponAttackPowerDialogModifiers(applyWeaponModuleModifiers(
    applyDamageSourceWeaponDialogModifiers(rawData),
    { moduleSlots: getWeaponFunctionModuleSlots(weapon, functionId) }
  ));
}

function applyDamageSourceWeaponDialogModifiers(weaponData = {}) {
  if (String(weaponData?.damageMode ?? "manual") !== "source") return weaponData;
  const sourceItem = getWeaponMagazineSourceItem(weaponData);
  if (!sourceItem || !hasItemFunction(sourceItem, ITEM_FUNCTIONS.damageSource)) {
    return {
      ...weaponData,
      damage: "0",
      damageTypeKey: "firearm",
      damageTypes: [{ key: "firearm", percent: 100 }]
    };
  }
  const source = getDamageSourceFunction(sourceItem);
  return {
    ...weaponData,
    source: "damageSource",
    damage: source.damage,
    pellets: source.pellets,
    damageTypeKey: source.damageTypeKey,
    damageTypes: source.damageTypes,
    accuracyBonus: addFormulaTexts(weaponData.accuracyBonus, source.accuracyBonus),
    criticalChanceModifier: addFormulaTexts(weaponData.criticalChanceModifier, source.criticalChanceModifier),
    criticalDamagePercent: addFormulaTexts(weaponData.criticalDamagePercent, source.criticalDamagePercent),
    maxRangeMeters: addFormulaTexts(weaponData.maxRangeMeters, source.maxRangeMeters),
    effectiveRange: {
      value: addFormulaTexts(weaponData.effectiveRange?.value, source.effectiveRange?.value),
      max: addFormulaTexts(weaponData.effectiveRange?.max, source.effectiveRange?.max)
    },
    penetration: addFormulaTexts(weaponData.penetration, source.penetration)
  };
}

function applyWeaponAttackPowerDialogModifiers(weaponData = {}) {
  const state = getWeaponAttackPowerState(weaponData);
  if (!state.active || state.increments <= 0) return weaponData;
  const result = foundry.utils.deepClone(weaponData);
  const multiplier = Math.max(0, toInteger(state.increments));
  const perLevel = state.perLevel ?? {};

  result.attackPowerDamagePercent = toInteger(perLevel.damagePercent) * multiplier;
  addDialogFormulaNumber(result, "accuracyBonus", perLevel.accuracyBonus, multiplier);
  addDialogFormulaNumber(result, "criticalChanceModifier", perLevel.criticalChanceModifier, multiplier);
  addDialogFormulaNumber(result, "criticalDamagePercent", perLevel.criticalDamagePercent, multiplier, { min: 0 });
  addDialogNumber(result, "attackConeDegrees", perLevel.attackConeDegrees, multiplier, { min: 0 });
  addDialogFormulaNumber(result, "maxRangeMeters", perLevel.maxRangeMeters, multiplier, { min: 0 });
  addDialogFormulaNumber(result, "effectiveRange.value", perLevel.effectiveRange?.value, multiplier, { min: 0 });
  addDialogFormulaNumber(result, "effectiveRange.max", perLevel.effectiveRange?.max, multiplier, { min: 0 });
  addDialogFormulaNumber(result, "penetration", perLevel.penetration, multiplier, { min: 0, integer: true });
  applyWeaponAttackPowerDialogResourceCosts(result, state.resourceCosts, multiplier);
  return result;
}

function applyWeaponAttackPowerDialogResourceCosts(weaponData = {}, resourceCosts = [], multiplier = 0) {
  const costs = Array.isArray(weaponData.resourceCosts) ? foundry.utils.deepClone(weaponData.resourceCosts) : [];
  if (String(weaponData?.damageMode ?? "manual") === "source"
    && !costs.some(cost => String(cost?.type ?? "") === "magazine")) {
    costs.push({ type: "magazine", amount: 1 });
  }
  for (const cost of resourceCosts ?? []) {
    const type = String(cost?.type ?? "").trim();
    const delta = toInteger(cost?.amount) * Math.max(0, toInteger(multiplier));
    if (!type || !delta) continue;
    let target = costs.find(entry => String(entry?.type ?? "") === type);
    if (!target) {
      target = { type, amount: 0 };
      costs.push(target);
    }
    target.amount = Math.max(0, toInteger(target.amount) + delta);
  }
  weaponData.resourceCosts = costs;
}

function getWeaponAttackPowerPreviewStats(actor = null, weapon = null, weaponData = {}) {
  const baseDamage = evaluateDialogFormula(weaponData.damage, actor, { minimum: 0, context: `${weapon?.name ?? "weapon"} attack power preview damage` });
  const attackPowerDamagePercent = toInteger(weaponData.attackPowerDamagePercent);
  const poweredDamage = Math.round(baseDamage * Math.max(0, 100 + attackPowerDamagePercent) / 100);
  const proficiencyDamage = getDialogWeaponProficiencyInfluenceBonus(actor, weaponData, "damage");
  const modifiedDamage = Math.round(poweredDamage * Math.max(0, 100 + proficiencyDamage) / 100);
  const weakening = getConditionWeakeningData(weapon, { minimumRatio: 0.1 });
  const conditionAccuracyPenalty = weakening.active ? weakening.steps * 10 : 0;
  const conditionCritPenalty = weakening.active ? weakening.steps * 3 : 0;
  const resourceCosts = Object.fromEntries(getWeaponAttackPowerPreviewResourceCosts(weaponData).map(cost => [
    String(cost?.type ?? "").trim(),
    Math.max(0, toInteger(cost?.amount))
  ]).filter(([type]) => type));

  return {
    damage: Math.max(0, Math.floor(modifiedDamage * (weakening.active ? weakening.ratio : 1))),
    accuracyBonus: evaluateDialogFormula(weaponData.accuracyBonus, actor, { minimum: -Infinity }) + getDialogWeaponProficiencyInfluenceBonus(actor, weaponData, "accuracy") - conditionAccuracyPenalty,
    criticalChanceModifier: evaluateDialogFormula(weaponData.criticalChanceModifier, actor, { minimum: -Infinity }) + getDialogWeaponProficiencyInfluenceBonus(actor, weaponData, "criticalChance") - conditionCritPenalty,
    criticalDamagePercent: Math.max(0, evaluateDialogFormula(weaponData.criticalDamagePercent, actor, { fallback: 150 }) + getDialogWeaponProficiencyInfluenceBonus(actor, weaponData, "criticalDamage")),
    attackConeDegrees: Math.max(0, Number(weaponData.attackConeDegrees) || 0),
    maxRangeMeters: evaluateDialogFormula(weaponData.maxRangeMeters, actor, { minimum: 0 }),
    effectiveRangeValue: evaluateDialogFormula(weaponData.effectiveRange?.value, actor, { minimum: 0 }),
    effectiveRangeMax: evaluateDialogFormula(weaponData.effectiveRange?.max, actor, { minimum: 0 }),
    penetration: Math.max(0, evaluateDialogFormula(weaponData.penetration, actor)),
    resourceCosts
  };
}

function getWeaponAttackPowerPreviewResourceCosts(weaponData = {}) {
  const costs = Array.isArray(weaponData.resourceCosts) ? foundry.utils.deepClone(weaponData.resourceCosts) : [];
  if (String(weaponData?.damageMode ?? "manual") === "source"
    && !costs.some(cost => String(cost?.type ?? "") === "magazine")) {
    costs.push({ type: "magazine", amount: 1 });
  }
  return costs;
}

function getWeaponAttackPowerChangedKeys(weaponData = {}) {
  const state = getWeaponAttackPowerState(weaponData);
  const perLevel = state.perLevel ?? {};
  const keys = new Set();
  if (toInteger(perLevel.damagePercent)) keys.add("damage");
  if (toInteger(perLevel.accuracyBonus)) keys.add("accuracyBonus");
  if (toInteger(perLevel.criticalChanceModifier)) keys.add("criticalChanceModifier");
  if (toInteger(perLevel.criticalDamagePercent)) keys.add("criticalDamagePercent");
  if (Number(perLevel.attackConeDegrees)) keys.add("attackConeDegrees");
  if (Number(perLevel.maxRangeMeters)) keys.add("maxRangeMeters");
  if (Number(perLevel.effectiveRange?.value)) keys.add("effectiveRange.value");
  if (Number(perLevel.effectiveRange?.max)) keys.add("effectiveRange.max");
  if (toInteger(perLevel.penetration)) keys.add("penetration");
  for (const cost of state.resourceCosts ?? []) {
    const type = String(cost?.type ?? "").trim();
    if (type && toInteger(cost?.amount)) keys.add(`resourceCost:${type}`);
  }
  return keys;
}

function getDialogWeaponProficiencyInfluenceBonus(actor = null, weaponData = {}, influenceKey = "") {
  if (!actor) return 0;
  const proficiency = getProficiencySettings().find(entry => entry.key === String(weaponData?.proficiencyKey ?? ""))
    ?? getProficiencySettings().at(0)
    ?? null;
  if (!proficiency) return 0;
  const range = getProficiencyInfluenceSettings()?.[influenceKey] ?? { min: 0, max: 0 };
  const settingMax = Math.max(0, toInteger(proficiency.max));
  const actorValue = toInteger(actor.system?.proficiencies?.[proficiency.key]?.value);
  const ratio = settingMax > 0 ? Math.max(0, Math.min(1, actorValue / settingMax)) : 0;
  return Math.round(toInteger(range.min) + ((toInteger(range.max) - toInteger(range.min)) * ratio));
}

function getWeaponAttackPowerResourceCostPreviewLabel(type = "") {
  if (type === "magazine") return game.i18n.localize("FALLOUTMAW.Item.WeaponCostMagazine");
  if (type === "condition") return game.i18n.localize("FALLOUTMAW.Item.WeaponCostCondition");
  if (type === "quantity") return game.i18n.localize("FALLOUTMAW.Item.WeaponCostQuantity");
  return String(type || "-");
}

function evaluateDialogFormula(formula, actor = null, options = {}) {
  if (actor) return evaluateActorFormula(formula, actor, options);
  const value = Number(formula);
  if (Number.isFinite(value)) return Math.max(Number(options.minimum ?? -Infinity), value);
  return Number(options.fallback ?? 0) || 0;
}

function addDialogFormulaNumber(target, path, delta, multiplier = 1, { min = null, integer = false } = {}) {
  const change = (integer ? toInteger(delta) : Number(delta)) * Math.max(0, toInteger(multiplier));
  if (!Number.isFinite(change) || change === 0) return;
  const currentRaw = foundry.utils.getProperty(target, path);
  const current = Number(currentRaw);
  if (Number.isFinite(current)) {
    const next = Number.isFinite(Number(min)) ? Math.max(Number(min), current + change) : current + change;
    foundry.utils.setProperty(target, path, integer ? Math.trunc(next) : next);
    return;
  }
  foundry.utils.setProperty(target, path, addFormulaTexts(currentRaw, integer ? Math.trunc(change) : change));
}

function addDialogNumber(target, path, delta, multiplier = 1, { min = null, integer = false } = {}) {
  const change = (integer ? toInteger(delta) : Number(delta)) * Math.max(0, toInteger(multiplier));
  if (!Number.isFinite(change) || change === 0) return;
  const currentRaw = foundry.utils.getProperty(target, path);
  const current = integer ? toInteger(currentRaw) : Number(currentRaw);
  const fallback = Number.isFinite(current) ? current : 0;
  let next = fallback + change;
  if (Number.isFinite(Number(min))) next = Math.max(Number(min), next);
  foundry.utils.setProperty(target, path, integer ? Math.trunc(next) : next);
}

function normalizeFormulaText(value, fallback = "0") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function addFormulaTexts(left, right) {
  const leftText = normalizeFormulaText(left);
  const rightText = normalizeFormulaText(right);
  if (leftText === "0") return rightText;
  if (rightText === "0") return leftText;
  return `(${leftText}) + (${rightText})`;
}

function formatAttackPowerPreviewNumber(value = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return Number.isInteger(number) ? String(number) : String(Math.round(number * 10) / 10);
}

function formatAttackPowerPreviewSignedNumber(value = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return number > 0 ? `+${formatAttackPowerPreviewNumber(number)}` : formatAttackPowerPreviewNumber(number);
}

function getAttackPowerPreviewTone(from = 0, to = 0, { higherIsBetter = true } = {}) {
  const left = Number(from) || 0;
  const right = Number(to) || 0;
  if (left === right) return "neutral";
  const positive = right > left ? higherIsBetter : !higherIsBetter;
  return positive ? "positive" : "negative";
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

  const activeInput = dialog.element.querySelector("[data-reload-active-source]");
  if (activeInput) activeInput.value = state.sourceItem?.uuid ?? "";

  const sourceList = dialog.element.querySelector("[data-reload-source-list]");
  if (sourceList) sourceList.innerHTML = renderReloadSourceCards(state);
}

function buildWeaponReloadDialogState(actor, weaponData = {}) {
  const sourceItems = getAvailableWeaponMagazineSourceItems(actor, weaponData);
  const sourceItem = getActiveWeaponMagazineSourceItem(weaponData, sourceItems);
  const source = getDamageSourceFunction(sourceItem);
  const sourceLabel = sourceItem
    ? String(source?.name ?? "").trim() || sourceItem.name
    : game.i18n.localize("FALLOUTMAW.Item.WeaponMagazineSourceEmpty");
  const current = Math.max(0, toInteger(weaponData.magazine?.value));
  const max = Math.max(0, toInteger(weaponData.magazine?.max));
  const sourceEntries = sourceItems
    .map(item => ({
      uuid: item.uuid,
      name: String(getDamageSourceFunction(item)?.name ?? "").trim() || item.name,
      img: normalizeImagePath(item.img, FALLBACK_ICON),
      quantity: getActorMagazineSourceQuantity(actor, item),
      selected: item.uuid === sourceItem?.uuid
    }));

  return { sourceItems, sourceItem, sourceLabel, current, max, sourceEntries };
}

function renderReloadSourceCards(state = {}) {
  return (state.sourceEntries ?? []).map(entry => `
    <button type="button"
      class="fallout-maw-reload-source-card ${entry.selected ? "active" : ""}"
      data-reload-source-card
      data-reload-source-uuid="${escapeAttribute(entry.uuid)}"
      title="${escapeAttribute(entry.name)}">
      <img src="${escapeAttribute(entry.img)}" alt="">
      <span>${escapeHTML(entry.name)}</span>
      <strong>${escapeHTML(entry.quantity)}</strong>
    </button>
  `).join("");
}

function formatNumberForHud(value) {
  const number = Number(value) || 0;
  return Number.isInteger(number) ? String(number) : number.toFixed(2).replace(/\.?0+$/, "");
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

  const switchReloadSource = async (dialog, sourceUuid) => {
    const nextSourceUuid = String(sourceUuid ?? "").trim();
    if (!nextSourceUuid) return;
    const freshWeapon = actor.items.get(weaponId);
    if (!freshWeapon) return;
    const weaponData = getWeaponFunctionById(freshWeapon, weaponFunctionId) ?? {};
    const loadedUuid = String(weaponData?.magazine?.sourceItemUuid ?? "").trim();
    const configuredSources = getWeaponMagazineSourceItems(weaponData);
    const availableSources = getAvailableWeaponMagazineSourceItems(actor, weaponData, configuredSources);
    const loadedSource = (loadedUuid ? configuredSources.find(item => item.uuid === loadedUuid) : null)
      ?? getActiveWeaponMagazineSourceItem(weaponData, availableSources);
    const currentSourceUuid = String(loadedSource?.uuid ?? loadedUuid).trim();
    const rounds = Math.max(0, toInteger(weaponData?.magazine?.value));
    if (!availableSources.some(item => item.uuid === nextSourceUuid)) return;
    try {
      if (rounds > 0 && currentSourceUuid && nextSourceUuid !== currentSourceUuid) {
        if (!hasRequiredWeaponReloadActionPoints(actor, freshWeapon, weaponFunctionId)) return;
        await requestWeaponReloadOperation({
          actor,
          weapon: freshWeapon,
          weaponFunctionId,
          action: "extract",
          sourceUuid: currentSourceUuid
        });
        await spendWeaponReloadActionPoints(actor, freshWeapon, weaponFunctionId);
      }
      const currentWeapon = actor.items.get(weaponId);
      if (!currentWeapon) return;
      await requestWeaponReloadOperation({
        actor,
        weapon: currentWeapon,
        weaponFunctionId,
        action: "select",
        sourceUuid: nextSourceUuid
      });
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
        <div class="fallout-maw-reload-main">
          <p><strong data-reload-source-label>${escapeHTML(state.sourceLabel)}</strong></p>
          <p data-reload-magazine-readout>${escapeHTML(game.i18n.localize("FALLOUTMAW.Item.WeaponMagazine"))}: ${state.current} / ${state.max}</p>
          <input type="hidden" name="sourceUuid" value="${escapeAttribute(sourceItem.uuid)}" data-reload-active-source>
          <div class="fallout-maw-reload-source-pane">
            <span>${escapeHTML(game.i18n.localize("FALLOUTMAW.Item.WeaponMagazineSource"))}</span>
            <div class="fallout-maw-reload-source-list" data-reload-source-list>
              ${renderReloadSourceCards(state)}
            </div>
          </div>
        </div>
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
        label: game.i18n.localize("FALLOUTMAW.Item.WeaponReloadFinish"),
        icon: "fa-solid fa-xmark",
        type: "button",
        callback: (event, button, dlg) => {
          dlg.close();
        }
      }
    ],
    position: {
      width: 520
    }
  });

  dialog.addEventListener("render", () => {
    const sourceList = dialog.element?.querySelector?.("[data-reload-source-list]");
    if (!sourceList || sourceList.dataset.reloadAmmoWatcher) return;
    sourceList.dataset.reloadAmmoWatcher = "1";
    const selectSource = async event => {
      const card = event.target?.closest?.("[data-reload-source-card]");
      if (!card) return;
      event.preventDefault();
      event.stopPropagation();
      await switchReloadSource(dialog, card.dataset.reloadSourceUuid);
    };
    sourceList.addEventListener("click", selectSource);
    sourceList.addEventListener("contextmenu", selectSource);
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
  const itemMatches = item => {
    if (!item) return false;
    if (item.parent?.uuid === actor?.uuid) return true;
    const weapon = actor?.items?.get(weaponId);
    const weaponData = weapon ? getWeaponFunctionById(weapon, weaponFunctionId) : null;
    return getWeaponMagazineSourceUuids(weaponData).includes(item.uuid);
  };

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
  const availableSources = getAvailableWeaponMagazineSourceItems(actor, weaponData, configuredSources);
  const loadedUuid = String(weaponData?.magazine?.sourceItemUuid ?? "").trim();

  if (String(action) === "select") {
    const selectedSource = availableSources.find(item => item.uuid === sourceUuid);
    if (!selectedSource || selectedSource.actor || !hasItemFunction(selectedSource, ITEM_FUNCTIONS.damageSource)) {
      throw new Error(game.i18n.localize("FALLOUTMAW.Item.WeaponReloadSourceEmpty"));
    }
    return actor.updateEmbeddedDocuments("Item", [{
      _id: weapon.id,
      ...createWeaponFunctionUpdateData(weapon, weaponFunctionId, {
        "magazine.sourceItemUuid": selectedSource.uuid
      })
    }]);
  }

  if (String(action) === "extract") {
    const extractSource = (loadedUuid ? configuredSources.find(item => item.uuid === loadedUuid) : null)
      ?? configuredSources.find(item => item.uuid === sourceUuid)
      ?? getActiveWeaponMagazineSourceItem(weaponData, configuredSources);
    if (!extractSource || extractSource.actor || !hasItemFunction(extractSource, ITEM_FUNCTIONS.damageSource)) {
      throw new Error(game.i18n.localize("FALLOUTMAW.Item.WeaponReloadNoSource"));
    }
    return extractWeaponMagazineSource(actor, weapon, weaponFunctionId, weaponData, extractSource);
  }

  const insertSource = availableSources.find(item => item.uuid === sourceUuid)
    ?? getActiveWeaponMagazineSourceItem(weaponData, availableSources);
  if (!insertSource || insertSource.actor || !hasItemFunction(insertSource, ITEM_FUNCTIONS.damageSource)) {
    throw new Error(game.i18n.localize("FALLOUTMAW.Item.WeaponReloadSourceEmpty"));
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
    ...createWeaponFunctionUpdateData(weapon, weaponFunctionId, {
      "magazine.sourceItemUuid": sourceItem.uuid,
      "magazine.value": current + amount
    })
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
  const returnPlan = createActorMagazineSourceReturnPlan(actor, sourceItem, current);
  if (!returnPlan.valid) throw new Error(returnPlan.message);
  const updates = [{
    _id: weapon.id,
    ...createWeaponFunctionUpdateData(weapon, weaponFunctionId, {
      "magazine.sourceItemUuid": sourceItem.uuid,
      "magazine.value": 0
    })
  }];
  updates.push(...returnPlan.updates);
  await actor.updateEmbeddedDocuments("Item", updates);
  if (returnPlan.creates.length) return actor.createEmbeddedDocuments("Item", returnPlan.creates);
  return undefined;
}

function getWeaponFunctionPath(weapon, weaponFunctionId = "") {
  return getWeaponFunctionUpdatePath(weapon, weaponFunctionId || ITEM_FUNCTIONS.weapon);
}

function getWeaponMagazineSourceItem(weaponData = {}) {
  const uuid = String(weaponData?.magazine?.sourceItemUuid ?? "").trim();
  if (!uuid) return null;
  return resolveWorldItemSync(uuid);
}

function getWeaponMagazineSourceItems(weaponData = {}) {
  return getWeaponMagazineSourceUuids(weaponData)
    .map(uuid => getWeaponMagazineSourceItem({ magazine: { sourceItemUuid: uuid } }))
    .filter(item => item && !item.actor && hasItemFunction(item, ITEM_FUNCTIONS.damageSource));
}

function getAvailableWeaponMagazineSourceItems(actor, weaponData = {}, sourceItems = getWeaponMagazineSourceItems(weaponData)) {
  const loadedUuid = String(weaponData?.magazine?.sourceItemUuid ?? "").trim();
  return sourceItems.filter(item => {
    if (item.uuid === loadedUuid) return true;
    return getActorMagazineSourceQuantity(actor, item) > 0;
  });
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

function createActorMagazineSourceReturnPlan(actor, sourceItem, quantity) {
  if (!actor || !sourceItem) return { valid: false, message: game.i18n.localize("FALLOUTMAW.Item.WeaponReloadSourceEmpty"), updates: [], creates: [] };
  let remaining = Math.max(0, toInteger(quantity));
  const updates = [];
  const creates = [];
  const reservedPlacementContexts = [];
  const maxStack = Math.max(1, getItemMaxStack(sourceItem));

  for (const stack of getActorMagazineSourceStacks(actor, sourceItem).filter(item => canReturnMagazineSourceToStack(actor, item))) {
    if (remaining <= 0) break;
    const room = getMagazineSourceStackReturnRoom(actor, stack, reservedPlacementContexts);
    if (!room) continue;
    const returned = Math.min(remaining, room);
    updates.push({
      _id: stack.id,
      "system.quantity": getItemQuantity(stack) + returned
    });
    reserveMagazineSourceContainerLoad(stack, sourceItem, returned, reservedPlacementContexts);
    remaining -= returned;
  }

  while (remaining > 0) {
    const stackQuantity = Math.min(remaining, maxStack);
    const createData = createActorMagazineSourceStackData(sourceItem, stackQuantity);
    const placementContext = getFirstAvailableHudInventoryPlacementContext(actor, createData, [], reservedPlacementContexts);
    if (!placementContext) {
      return { valid: false, message: game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"), updates: [], creates: [] };
    }
    const storedPlacement = createStoredPlacement(placementContext.placement, createData);
    foundry.utils.mergeObject(createData, {
      system: {
        equipped: false,
        container: {
          parentId: String(placementContext.parentId ?? ROOT_CONTAINER_ID)
        },
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
    creates.push(createData);
    reservedPlacementContexts.push({ ...placementContext, itemData: createData });
    remaining -= stackQuantity;
  }

  return { valid: true, message: "", updates, creates };
}

function createActorMagazineSourceStackData(sourceItem, quantity) {
  const createData = sourceItem.toObject();
  delete createData._id;
  foundry.utils.setProperty(createData, "system.quantity", Math.max(0, toInteger(quantity)));
  foundry.utils.setProperty(createData, `flags.${SYSTEM_ID}.damageSourcePrototypeUuid`, sourceItem.uuid);
  return createData;
}

function canReturnMagazineSourceToStack(actor, item) {
  if (!item || getItemQuantity(item) >= getItemMaxStack(item)) return false;
  if (String(item.system?.placement?.mode ?? "inventory") !== "inventory") return false;
  const parentId = getItemContainerParentId(item);
  return !parentId || Boolean(actor?.items?.get(parentId));
}

function getMagazineSourceStackReturnRoom(actor, item, reservedPlacementContexts = []) {
  const stackRoom = Math.max(0, getItemMaxStack(item) - getItemQuantity(item));
  if (!stackRoom) return 0;
  const parentId = getItemContainerParentId(item);
  if (!parentId) return stackRoom;
  const container = actor?.items?.get(parentId);
  if (!container) return 0;
  const unitWeight = getItemUnitWeight(item);
  if (unitWeight <= 0) return stackRoom;
  const reservedLoad = reservedPlacementContexts
    .filter(entry => String(entry?.parentId ?? ROOT_CONTAINER_ID) === String(parentId))
    .reduce((total, entry) => total + getItemTotalWeight(entry.itemData, actor.items), 0);
  const availableLoad = Math.max(0, getContainerMaxLoad(container) - getContainerContentsWeight(container, actor.items) - reservedLoad);
  return Math.min(stackRoom, Math.floor((availableLoad + 0.0001) / unitWeight));
}

function reserveMagazineSourceContainerLoad(item, sourceItem, quantity, reservedPlacementContexts = []) {
  const parentId = getItemContainerParentId(item);
  if (!parentId || quantity <= 0) return;
  const itemData = createActorMagazineSourceStackData(sourceItem, quantity);
  reservedPlacementContexts.push({ parentId, itemData });
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
        height: storedPlacement.height,
        rotated: storedPlacement.rotated
      }
    }
  });
  return actor.createEmbeddedDocuments("Item", [createData]);
}

function getFirstAvailableRootInventoryPlacement(actor, itemData) {
  const allItems = actor?.items?.contents ?? [];
  const rootItems = getContextInventoryItems(ROOT_CONTAINER_ID, allItems);
  const { columns, rows } = getActorRootInventoryDimensions(actor);
  return findFirstAvailableInventoryPlacement(rootItems, columns, rows, itemData, allItems, [], [], getActorRootInventoryGridOptions(actor, ROOT_CONTAINER_ID));
}

function getHudWeaponSets(inventory = {}) {
  return [
    ...(inventory.naturalWeaponSet ? [inventory.naturalWeaponSet] : []),
    ...(inventory.weaponSets ?? [])
  ];
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
  await deleteActorOverloadEffects(actor);
  await setActorTokensPosture(actor, "walk");
  if (repairItems) await fullyRepairActorItems(actor);
}

async function deleteActorOverloadEffects(actor) {
  const effectIds = Array.from(actor?.effects ?? [])
    .filter(effect => Boolean(effect.getFlag?.(SYSTEM_ID, ABILITY_OVERLOAD_EFFECT_FLAG_KEY)))
    .map(effect => effect.id)
    .filter(Boolean);
  if (effectIds.length) await actor.deleteEmbeddedDocuments("ActiveEffect", effectIds, { animate: false });
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

function getHoveredLimbPart(root, event) {
  if (!(root instanceof SVGSVGElement)) {
    const target = event.target?.closest?.("[data-limb-popover]");
    return target && root?.contains?.(target) ? target : null;
  }
  const svg = root;
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
