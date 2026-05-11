import { FALLOUT_MAW } from "../config/system-config.mjs";
import { SYSTEM_ID, TEMPLATES } from "../constants.mjs";
import {
  getCreatureOptions,
  getActorNeedSettings,
  getDamageTypeSettings,
  getResourceSettings,
  getSkillSettings,
  getSystemActionSettings
} from "../settings/accessors.mjs";
import {
  TOKEN_ACTION_HUD_COLLAPSED_SECTIONS_SETTING,
  TOKEN_ACTION_HUD_ENABLED_SETTING,
  TOKEN_ACTION_HUD_SCALE_SETTING
} from "../settings/constants.mjs";
import { requestSkillCheck } from "../rolls/skill-check.mjs";
import { getLimbHealingCap, getResourceLimitState } from "../combat/damage-hub.mjs";
import { MOVEMENT_RESOURCE_PREVIEW_HOOK } from "../combat/movement-resources.mjs";
import {
  cancelWeaponAttack,
  hasRequiredWeaponReloadActionPoints,
  spendWeaponReloadActionPoints,
  startWeaponAttack
} from "../combat/weapon-attack-controller.mjs";
import { openLimbDamageDialog } from "./limb-damage-dialog.mjs";
import { requestMedicineTarget } from "./medicine-dialog.mjs";
import {
  FALLBACK_ICON,
  normalizeImagePath,
  prepareIndicatorEntry,
  prepareInventoryContext
} from "../utils/actor-display-data.mjs";
import { createDefaultInventorySize } from "../settings/creature-options.mjs";
import {
  ROOT_CONTAINER_ID,
  createStoredPlacement,
  findFirstAvailableInventoryPlacement,
  getItemMaxStack,
  getContextInventoryItems,
  getItemQuantity
} from "../utils/inventory-containers.mjs";
import { ITEM_FUNCTIONS, getConditionWeakeningData, getDamageMitigationFunction, getDamageSourceFunction, getEnabledWeaponFunctions, getWeaponFunctionById, hasItemFunction } from "../utils/item-functions.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { createLimbSilhouetteHud } from "../utils/limb-silhouette.mjs";
import { renderInventoryItemTooltipHTML } from "../sheets/actor-sheet.mjs";
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
const DAMAGE_EFFECT_FLAG_KEY = "damageEffect";
const SELECTED_HUD_WEAPON_FLAG = "selectedHudWeaponItemId";
const SELECTED_HUD_WEAPON_SET_FLAG = "selectedHudWeaponSetKey";
const TOKEN_ACTION_HUD_SCALE_DEFAULT = 50;
const TOKEN_ACTION_HUD_SCALE_MIN = 25;
const TOKEN_ACTION_HUD_SCALE_MAX = 100;
const HUD_ACTION_TILE_MIN_WIDTH = 116;
const HUD_ACTION_TILE_MAX_WIDTH = 260;
const HUD_ACTION_TILE_HORIZONTAL_CHROME = 30;
const HUD_ACTION_TILE_LABEL_FONT_WEIGHT = 700;
const HUD_ACTION_TILE_LABEL_FONT_SIZE_REM = 0.8;
const HUD_METER_SECTION_KEYS = Object.freeze(["resources", "needs"]);
const HUD_LIMB_LAYER_KEYS = Object.freeze(["state", "defense", "resistance", "reduction"]);
const HUD_LIMB_LAYERS = Object.freeze([
  { key: "state", label: "Состояние" },
  { key: "defense", label: "Защита" },
  { key: "resistance", label: "Сопротивление" },
  { key: "reduction", label: "Итоговое снижение" }
]);
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
let tokenActionHudSettings = null;
let hooksRegistered = false;
let tokenActionHudRefresh = null;
let tokenActionHudLayoutRefresh = null;
let tokenActionHudPreviewPercent = null;
let tokenActionHudMovementPreview = null;
const pendingTokenActionHudSocketRequests = new Map();

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

class TokenActionHud extends HandlebarsApplicationMixin(ApplicationV2) {
  #token = null;
  #activeTray = "";
  #limbDisplayLayer = "state";
  #layoutFrame = null;
  #itemTooltipElement = null;
  #itemTooltipAnchorElement = null;
  #itemTooltipItemId = "";
  #itemTooltipWeaponTabIndex = 0;
  #itemTooltipBaseMode = false;
  #itemTooltipPointerDownHandler = null;
  #itemTooltipKeyHandler = null;
  #itemTooltipSuppressHudActivation = false;
  #itemTooltipSuppressHudActivationTimer = null;
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
      selectHudWeapon: { handler: TokenActionHud.#onSelectHudWeapon, buttons: [0, 1] },
      cycleHudWeaponSet: TokenActionHud.#onCycleHudWeaponSet,
      toggleWeaponActions: { handler: TokenActionHud.#onToggleWeaponActions, buttons: [0, 1] },
      useWeaponAction: { handler: TokenActionHud.#onUseWeaponAction, buttons: [0, 1] },
      gmHealSelected: TokenActionHud.#onGmHealSelected,
      gmAwardExperience: TokenActionHud.#onGmAwardExperience,
      openSettings: TokenActionHud.#onOpenSettings,
      rollSkill: TokenActionHud.#onRollSkill,
      openItem: { handler: TokenActionHud.#onOpenItem, buttons: [1] },
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
    const weaponSet = prepareHudWeaponSet(inventory.weaponSets, activeWeaponSetKey, selectedWeapon?.id ?? "");
    const selectedWeaponSlot = getSelectedHudWeaponSlot(weaponSet, selectedWeapon?.id ?? "");
    const selectedWeaponDisabled = Boolean(selectedWeaponSlot?.disabled);
    const weaponActionRows = prepareWeaponActionRows(selectedWeapon, selectedWeaponDisabled);
    const skills = prepareSkillButtons(actor);
    const items = prepareOwnedItemButtons(actor, "gear", "icons/svg/item-bag.svg");
    const abilities = prepareOwnedItemButtons(actor, "ability", "icons/svg/aura.svg");
    const systemActions = prepareSystemActionButtons();
    const actions = prepareActions(this.#activeTray, selectedWeapon, items, abilities, systemActions);
    const tray = prepareTrayContext(this.#activeTray, skills, items, abilities, systemActions, weaponActionRows);
    const meterSections = prepareMeterSectionStates();
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
      weaponSetCount: inventory.weaponSets.length,
      selectedWeapon,
      actions,
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
    this.#scheduleLayout();
  }

  _attachFrameListeners() {
    super._attachFrameListeners();
    this.element.addEventListener("pointerdown", event => this.#onHudItemMiddlePointerDown(event));
    this.element.addEventListener("click", event => this.#onHudItemTooltipHudActivation(event), { capture: true });
    this.element.addEventListener("auxclick", event => this.#onHudItemTooltipHudActivation(event), { capture: true });
    this.element.addEventListener("contextmenu", event => this.#onHudItemTooltipHudActivation(event), { capture: true });
    this.element.addEventListener("contextmenu", event => this.#onHudContextMenu(event));
    this.element.addEventListener("click", event => this.#onLimbLayerOptionClick(event));
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

  static #onToggleTray(event, target) {
    event.preventDefault();
    const tray = target.dataset.tray ?? "";
    this.#activeTray = this.#activeTray === tray ? "" : tray;
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

  static #onOpenSettings(event) {
    event.preventDefault();
    tokenActionHudSettings ??= new TokenActionHudSettings();
    return tokenActionHudSettings.render({ force: true });
  }

  static async #onGmHealSelected(event) {
    event.preventDefault();
    if (!game.user?.isGM) return undefined;

    const actors = getSelectedHudActors();
    if (!actors.length) return undefined;
    const confirmed = await DialogV2.confirm({
      window: {
        title: "Полное восстановление"
      },
      content: `<p>Полностью вылечить выбранных актеров: ${actors.length}?</p>`,
      yes: {
        label: "Вылечить",
        icon: "fa-solid fa-kit-medical"
      },
      no: {
        label: "Отмена"
      },
      rejectClose: false
    });
    if (!confirmed) return undefined;

    for (const actor of actors) await fullyRestoreActor(actor);
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

  static async #onCycleHudWeaponSet(event) {
    event.preventDefault();
    const actor = this.actor;
    if (!actor?.isOwner) return undefined;

    const race = getCreatureOptions().races.find(entry => entry.id === actor.system?.creature?.raceId);
    const weaponSets = prepareInventoryContext(actor, race).weaponSets;
    if (weaponSets.length <= 1) return undefined;

    const currentKey = getActiveHudWeaponSetKey(actor, weaponSets);
    const currentIndex = Math.max(0, weaponSets.findIndex(set => set.key === currentKey));
    const nextSet = weaponSets[(currentIndex + 1) % weaponSets.length];
    await actor.setFlag(FALLOUT_MAW.id, SELECTED_HUD_WEAPON_SET_FLAG, nextSet.key);

    const nextWeaponId = getFirstWeaponIdInSet(nextSet);
    if (nextWeaponId) await actor.setFlag(FALLOUT_MAW.id, SELECTED_HUD_WEAPON_FLAG, nextWeaponId);
    else await actor.unsetFlag(FALLOUT_MAW.id, SELECTED_HUD_WEAPON_FLAG);

    this.#activeTray = "";
    return this.render({ force: true });
  }

  static #onToggleWeaponActions(event, target) {
    event.preventDefault();
    if (isMiddleMouseClick(event)) {
      const item = this.actor?.items.get(String(target.dataset.itemId ?? ""));
      return item?.sheet?.render(true);
    }
    if (event.button !== 0) return undefined;
    this.#activeTray = this.#activeTray === "weaponActions" ? "" : "weaponActions";
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

  static #onUseSystemAction(event, target) {
    event.preventDefault();
    const key = String(target.dataset.systemActionKey ?? "");
    if (key !== "medicine") return undefined;

    this.#activeTray = "";
    void this.render({ force: true });
    return requestMedicineTarget(this.token);
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
    void this.#showHudItemTooltip(item, button);
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
    return ["openItem", "selectHudWeapon", "useWeaponAction", "toggleWeaponActions"].includes(action) ? button : null;
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

    event.preventDefault();
    event.stopPropagation();
    this.#destroyLimbPopover();
    void openLimbDamageDialog(this.actor, target.dataset.limbKey ?? "");
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

  async #showHudItemTooltip(item, anchor) {
    this.#clearHudItemTooltip();
    const tooltip = document.createElement("aside");
    tooltip.className = "fallout-maw-inventory-tooltip pinned";
    tooltip.style.setProperty("--fallout-maw-ui-scale", String(tokenActionHudScaleFactor(getTokenActionHudScalePercent())));
    tooltip.innerHTML = await renderInventoryItemTooltipHTML(item, this.actor, {
      activeWeaponIndex: this.#itemTooltipWeaponTabIndex,
      baseMode: this.#itemTooltipBaseMode
    });
    tooltip.addEventListener("click", event => this.#onHudItemTooltipClick(event));
    tooltip.addEventListener("contextmenu", event => this.#onHudItemTooltipContextMenu(event));
    document.body.append(tooltip);
    this.#itemTooltipElement = tooltip;
    this.#itemTooltipAnchorElement = anchor;
    this.#itemTooltipItemId = item.id;
    this.#bindHudItemTooltipDocumentListeners();
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
    const anchor = this.#itemTooltipAnchorElement;
    if (!item || !anchor?.isConnected) return this.#clearHudItemTooltip();
    this.#itemTooltipElement.innerHTML = await renderInventoryItemTooltipHTML(item, this.actor, {
      activeWeaponIndex: this.#itemTooltipWeaponTabIndex,
      baseMode: this.#itemTooltipBaseMode
    });
    this.#positionHudItemTooltip();
  }

  #onHudItemTooltipClick(event) {
    const moduleSlot = event.target?.closest?.("[data-tooltip-module-slot]");
    if (moduleSlot && this.#itemTooltipElement?.contains(moduleSlot)) {
      event.preventDefault();
      event.stopPropagation();
      void this.#openHudWeaponModuleSelection(moduleSlot);
      return;
    }

    const button = event.target?.closest?.("[data-tooltip-weapon-tab]");
    if (!button || !this.#itemTooltipElement?.contains(button)) return;
    event.preventDefault();
    event.stopPropagation();
    this.#itemTooltipWeaponTabIndex = Math.max(0, toInteger(button.dataset.tooltipWeaponTab));
    void this.#refreshHudItemTooltip();
  }

  async #onHudItemTooltipContextMenu(event) {
    const moduleSlot = event.target?.closest?.("[data-tooltip-module-slot]");
    if (!moduleSlot || !this.#itemTooltipElement?.contains(moduleSlot)) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    await this.#removeHudWeaponModule(moduleSlot);
  }

  async #openHudWeaponModuleSelection(slotElement) {
    const { weapon, entries, weaponIndex, slotIndex, slot } = this.#getHudWeaponModuleSlotContext(slotElement);
    if (!weapon || !slot) return;
    const modules = this.actor.items.contents
      .filter(candidate => candidate.id !== weapon.id && isModuleItemCompatibleWithSlot(candidate, slot) && getItemQuantity(candidate) > 0)
      .map(candidate => ({ id: candidate.id, name: getWeaponModuleTechnicalName(candidate) }));
    if (!modules.length) return ui.notifications.warn("Подходящих модулей нет.");
    const result = await DialogV2.input({
      classes: ["dialog", "fallout-maw-module-selection-dialog"],
      position: { width: 400 },
      window: { title: game.i18n.localize("FALLOUTMAW.Item.WeaponModuleSlots") },
      content: `
        <div class="fallout-maw-terminal-dialog">
          <label class="fallout-maw-stacked-field">
            <span>${escapeHTML(slot.moduleKey || game.i18n.localize("FALLOUTMAW.Item.WeaponModuleSlots"))}</span>
            <select name="moduleId">
              ${modules.map(module => `<option value="${escapeAttribute(module.id)}">${escapeHTML(module.name)}</option>`).join("")}
            </select>
          </label>
        </div>
      `,
      ok: {
        label: "Выбрать",
        icon: "fa-solid fa-check",
        callback: (_event, button) => new FormDataExtended(button.form).object
      },
      rejectClose: false
    });
    const moduleItem = this.actor.items.get(String(result?.moduleId ?? ""));
    if (!moduleItem) return undefined;
    return this.#installHudWeaponModule(weapon, entries[weaponIndex], slotIndex, moduleItem);
  }

  async #removeHudWeaponModule(slotElement) {
    const { weapon, entry, slotIndex, slot } = this.#getHudWeaponModuleSlotContext(slotElement);
    const itemData = getWeaponModuleSlotItemData(slot);
    if (!weapon || !entry || !itemData?.system) return undefined;
    const confirmed = await DialogV2.confirm({
      window: { title: game.i18n.localize("FALLOUTMAW.Item.WeaponModuleSlots") },
      content: `<p>Снять модуль "${escapeHTML(getWeaponModuleTechnicalName(itemData))}"?</p>`,
      yes: { icon: "fa-solid fa-arrow-up", label: "Да" },
      no: { label: game.i18n.localize("Cancel") },
      rejectClose: false,
      modal: true
    });
    if (!confirmed) return undefined;
    return this.#uninstallHudWeaponModule(weapon, entry, slotIndex, itemData);
  }

  #getHudWeaponModuleSlotContext(slotElement) {
    const weapon = this.#itemTooltipItemId ? this.actor?.items.get(this.#itemTooltipItemId) : null;
    const entries = weapon ? getEnabledWeaponFunctions(weapon) : [];
    const weaponIndex = Math.max(0, toInteger(slotElement?.dataset?.tooltipWeaponIndex));
    const slotIndex = Math.max(0, toInteger(slotElement?.dataset?.tooltipModuleSlotIndex));
    const entry = entries[weaponIndex] ?? null;
    const slot = getWeaponModuleSlots(entry?.data ?? {})[slotIndex] ?? null;
    return { weapon, entries, entry, weaponIndex, slotIndex, slot };
  }

  async #installHudWeaponModule(weapon, entry, slotIndex, moduleItem) {
    const path = getWeaponFunctionPath(entry?.isPrimary ? ITEM_FUNCTIONS.weapon : entry?.id);
    const slots = getWeaponModuleSlots(entry?.data ?? {});
    const slot = slots[slotIndex];
    if (!slot || !isModuleItemCompatibleWithSlot(moduleItem, slot)) return undefined;
    if (getWeaponModuleSlotItemData(slot)?.system) return ui.notifications.warn("Сначала снимите установленный модуль.");

    const itemData = moduleItem.toObject();
    delete itemData._id;
    foundry.utils.setProperty(itemData, "system.quantity", 1);
    slots[slotIndex] = { ...slot, itemUuid: moduleItem.uuid, itemData };
    await weapon.update({ [`${path}.moduleSlots`]: slots });
    const quantity = getItemQuantity(moduleItem);
    if (quantity > 1) await moduleItem.update({ "system.quantity": quantity - 1 });
    else await moduleItem.delete();
    return this.#refreshHudItemTooltip();
  }

  async #uninstallHudWeaponModule(weapon, entry, slotIndex, itemData) {
    const path = getWeaponFunctionPath(entry?.isPrimary ? ITEM_FUNCTIONS.weapon : entry?.id);
    const slots = getWeaponModuleSlots(entry?.data ?? {});
    const slot = slots[slotIndex];
    if (!slot) return undefined;
    slots[slotIndex] = { ...slot, itemUuid: "", itemData: {} };
    await weapon.update({ [`${path}.moduleSlots`]: slots });
    await returnModuleItemToActorInventory(this.actor, itemData);
    return this.#refreshHudItemTooltip();
  }

  #positionHudItemTooltip() {
    const tooltip = this.#itemTooltipElement;
    const anchor = this.#itemTooltipAnchorElement;
    if (!tooltip || !anchor?.isConnected) return;
    const view = this.element?.ownerDocument?.defaultView ?? window;
    const anchorRect = anchor.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const margin = 10;
    const gap = 12;
    let left = anchorRect.left + ((anchorRect.width - tooltipRect.width) / 2);
    left = Math.max(margin, Math.min(view.innerWidth - tooltipRect.width - margin, left));
    let top = anchorRect.top - tooltipRect.height - gap;
    if (top < margin) top = Math.min(view.innerHeight - tooltipRect.height - margin, anchorRect.bottom + gap);
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(Math.max(margin, top))}px`;
    tooltip.dataset.tooltipDirection = "hud";
  }

  #bindHudItemTooltipDocumentListeners() {
    const view = this.element?.ownerDocument?.defaultView ?? window;
    if (!this.#itemTooltipPointerDownHandler) {
      this.#itemTooltipPointerDownHandler = event => {
        if (this.#itemTooltipElement?.contains(event.target)) return;
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
    if (this.#itemTooltipPointerDownHandler) {
      view.document.removeEventListener("pointerdown", this.#itemTooltipPointerDownHandler, { capture: true });
      this.#itemTooltipPointerDownHandler = null;
    }
    if (this.#itemTooltipKeyHandler) {
      view.document.removeEventListener("keydown", this.#itemTooltipKeyHandler, { capture: true });
      view.document.removeEventListener("keyup", this.#itemTooltipKeyHandler, { capture: true });
      this.#itemTooltipKeyHandler = null;
    }
    this.#itemTooltipElement?.remove();
    this.#itemTooltipElement = null;
    this.#itemTooltipAnchorElement = null;
    this.#itemTooltipItemId = "";
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
      valueRow.textContent = `${value} / ${max}`;
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

function prepareMeterSectionStates() {
  const collapsed = getTokenActionHudCollapsedSections();
  return {
    resources: prepareMeterSectionState(collapsed.resources),
    needs: prepareMeterSectionState(collapsed.needs)
  };
}

function prepareMeterSectionState(collapsed) {
  return {
    collapsed: Boolean(collapsed),
    expanded: !collapsed
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

export class TokenActionHudSettings extends FalloutMaWFormApplicationV2 {
  #lastPreviewPercent = null;

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-token-action-hud-settings",
    classes: ["fallout-maw", "fallout-maw-config-form", "fallout-maw-token-action-hud-settings"],
    position: {
      width: 380,
      height: "auto"
    },
    window: {
      resizable: false
    },
    form: {
      handler: TokenActionHudSettings.handleFormSubmit,
      submitOnChange: false,
      closeOnSubmit: true
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.settings.tokenActionHud
    }
  };

  get title() {
    return game.i18n.localize("FALLOUTMAW.Settings.HUD.Title");
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
    tokenActionHudSettings = null;
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
    label: HUD_LIMB_LAYERS.find(layer => layer.key === active)?.label ?? "Состояние",
    choices: HUD_LIMB_LAYERS.map(layer => ({
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
  if (layer === "reduction") return prepareReductionLayerLimbs(actor, baseLimbs);
  return baseLimbs;
}

function prepareMitigationLayerLimbs(actor, limbs = {}, layer = "defense") {
  const damageTypes = getDamageTypeSettings();
  const source = layer === "defense" ? actor.system?.damageDefenses : actor.system?.damageResistances;
  return Object.fromEntries(Object.entries(limbs ?? {}).map(([key, limb]) => {
    const rows = damageTypes.map(damageType => {
      const value = toInteger(source?.[key]?.[damageType.key]);
      return {
        label: String(damageType.label ?? damageType.key),
        value,
        display: `${value}%`
      };
    });
    const score = averageMitigationPercent(rows.map(row => row.value));
    return [key, {
      ...limb,
      fill: getMitigationLayerColor(score),
      displayValue: `${formatSignedNumber(score)}%`,
      displayMax: "100%",
      popoverRows: rows.map(row => ({
        label: row.label,
        value: row.display
      }))
    }];
  }));
}

function prepareReductionLayerLimbs(actor, limbs = {}) {
  const reductions = getFlatLimbFinalReductions(actor);
  return Object.fromEntries(Object.entries(limbs ?? {}).map(([key, limb]) => {
    const value = toInteger(reductions[key]);
    return [key, {
      ...limb,
      fill: getMitigationLayerColor(value),
      displayValue: formatSignedNumber(value),
      displayMax: "100",
      popoverRows: [{
        label: "Итоговое снижение",
        value: formatSignedNumber(value)
      }]
    }];
  }));
}

function averageMitigationPercent(values = []) {
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

function getFlatLimbFinalReductions(actor) {
  const result = Object.fromEntries(Object.keys(actor.system?.limbs ?? {}).map(key => [key, 0]));
  for (const item of actor.items?.contents ?? []) {
    if (item.type !== "gear" || !item.system?.equipped || !hasItemFunction(item, ITEM_FUNCTIONS.damageMitigation)) continue;
    const mitigation = getDamageMitigationFunction(item);
    const weakening = getConditionWeakeningData(item);
    const finalReduction = Math.floor(Math.max(0, toInteger(mitigation.finalReduction)) * (weakening.active ? weakening.ratio : 1));
    if (!finalReduction) continue;
    for (const [limbKey, damageEntries] of Object.entries(mitigation.entries ?? {})) {
      if (!Object.hasOwn(result, limbKey) || !hasAnyMitigationEntry(damageEntries)) continue;
      result[limbKey] += finalReduction;
    }
  }
  return result;
}

function hasAnyMitigationEntry(damageEntries = {}) {
  return Object.values(damageEntries ?? {}).some(entry => toInteger(entry?.value) !== 0);
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

function prepareSkillButtons(actor) {
  return getSkillSettings().map(skill => {
    const actorSkill = actor.system.skills?.[skill.key] ?? {};
    return {
      ...skill,
      img: normalizeImagePath(skill.img),
      value: toInteger(actorSkill.value)
    };
  });
}

function prepareOwnedItemButtons(actor, type, fallbackIcon) {
  return actor.items
    .filter(item => item.type === type)
    .map(item => ({
      id: item.id,
      name: item.name,
      img: normalizeImagePath(item.img, fallbackIcon),
      quantity: toInteger(item.system?.quantity),
      showQuantity: toInteger(item.system?.maxStack) > 1
    }));
}

function prepareSystemActionButtons() {
  return getSystemActionSettings().map(action => ({
    ...action,
    img: normalizeImagePath(action.img, "icons/svg/aura.svg")
  }));
}

function prepareTrayContext(activeTray, skills, items, abilities, systemActions, weaponActionRows) {
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
            : [];
  return {
    skills,
    items,
    abilities,
    systemActions,
    weaponActionRows,
    metrics: prepareTrayMetrics(trayItems),
    visible: Boolean(activeTray)
  };
}

function prepareTrayMetrics(items) {
  const maxTextWidth = measureTrayMaxLabelWidth(items);
  const tileWidth = maxTextWidth
    ? Math.ceil(Math.min(HUD_ACTION_TILE_MAX_WIDTH, Math.max(HUD_ACTION_TILE_MIN_WIDTH, maxTextWidth + HUD_ACTION_TILE_HORIZONTAL_CHROME)))
    : Math.ceil(Math.min(HUD_ACTION_TILE_MAX_WIDTH, Math.max(HUD_ACTION_TILE_MIN_WIDTH, (getTrayMaxLabelLength(items) * 7) + HUD_ACTION_TILE_HORIZONTAL_CHROME)));
  return {
    style: `--fallout-maw-token-hud-action-tile-width: ${tileWidth}px;`
  };
}

function getTrayMaxLabelLength(items) {
  return items.reduce((max, item) => {
    const label = String(item.label ?? item.name ?? "");
    return Math.max(max, label.length);
  }, 0);
}

function measureTrayMaxLabelWidth(items) {
  if (!items.length || typeof document === "undefined" || !document.documentElement) return 0;
  const canvas = measureTrayMaxLabelWidth.canvas ??= document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return 0;

  const rootStyle = getComputedStyle(document.documentElement);
  const rootFontSize = Number.parseFloat(rootStyle.fontSize) || 16;
  const fontFamily = rootStyle.getPropertyValue("--font-primary").trim() || rootStyle.fontFamily || "serif";
  context.font = `${HUD_ACTION_TILE_LABEL_FONT_WEIGHT} ${rootFontSize * HUD_ACTION_TILE_LABEL_FONT_SIZE_REM}px ${fontFamily}`;

  return items.reduce((max, item) => {
    const label = String(item.label ?? item.name ?? "").trim();
    return Math.max(max, context.measureText(label).width);
  }, 0);
}

function prepareActions(activeTray, selectedWeapon, items, abilities, systemActions) {
  return HUD_ACTIONS.map(action => {
    if (action.key === "weapon") {
      return {
        ...action,
        active: activeTray === "weaponActions",
        disabled: !selectedWeapon,
        icon: normalizeImagePath(selectedWeapon?.img, action.icon),
        caption: selectedWeapon?.name ?? action.label,
        itemId: selectedWeapon?.id ?? "",
        count: selectedWeapon ? 1 : 0
      };
    }

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
      caption: action.label,
      count
    };
  });
}

function prepareHudWeaponSet(weaponSets = [], activeSetKey = "", selectedWeaponId = "") {
  const set = weaponSets.find(entry => entry.key === activeSetKey) ?? weaponSets[0] ?? null;
  if (!set) return null;
  return {
    ...set,
    slots: (set.slots ?? []).map(slot => ({
      ...slot,
      selected: Boolean(slot.item?.id && !slot.phantom && slot.item.id === selectedWeaponId)
    }))
  };
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
  return Boolean(slot?.disabled);
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

function getFirstWeaponIdInSet(weaponSet = null) {
  return (weaponSet?.slots ?? []).filter(slot => !slot.phantom).map(slot => slot.item?.id).find(Boolean) ?? "";
}

function isMiddleMouseClick(event) {
  return event?.button === 1;
}

function prepareWeaponActionRows(selectedWeapon, forceDisabled = false) {
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
      actions: prepareWeaponActionButtonsForFunction(selectedWeapon, weaponFunction, forceDisabled)
    }))
    .filter(row => row.actions.length);
}

function prepareWeaponActionButtonsForFunction(selectedWeapon, weaponFunction, forceDisabled = false) {
  const weaponData = applyWeaponModuleModifiers(weaponFunction?.data ?? {});
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
  return buttons.filter(action => action.visible !== false && action.configured).map(action => ({
    ...action,
    label: String(weaponData?.[action.key]?.name ?? "").trim() || action.label,
    disabled: forceDisabled,
    itemId: selectedWeapon.id,
    weaponFunctionId: weaponFunction.isPrimary ? ITEM_FUNCTIONS.weapon : weaponFunction.id,
    img: normalizeImagePath(selectedWeapon.img, "icons/svg/combat.svg"),
    actionPointCost: getWeaponActionPointCostForHud(weaponData, action.key),
    actionPointCostLabel: `${getWeaponActionPointCostForHud(weaponData, action.key)} ОД`
  }));
}

function getWeaponActionPointCostForHud(weaponData = {}, actionKey = "") {
  const value = Number(weaponData?.[actionKey]?.actionPointCost);
  const fallback = actionKey === "reload" ? 2 : 5;
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : fallback;
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

async function openWeaponReloadDialog({ actor = null, weapon = null, weaponFunctionId = "", application = null } = {}) {
  if (!actor?.isOwner || !weapon) return undefined;
  const weaponId = weapon.id;
  const weaponData = getWeaponFunctionById(weapon, weaponFunctionId) ?? {};
  if (!hasWeaponResourceCostData(weaponData, "magazine")) return undefined;

  const sourceItems = getWeaponMagazineSourceItems(weaponData);
  const sourceItem = getActiveWeaponMagazineSourceItem(weaponData, sourceItems);
  if (!sourceItems.length || !sourceItem) {
    ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Item.WeaponReloadNoSource"));
    return undefined;
  }

  const source = getDamageSourceFunction(sourceItem);
  const sourceLabel = String(source?.name ?? "").trim() || sourceItem.name;
  const current = Math.max(0, toInteger(weaponData.magazine?.value));
  const max = Math.max(0, toInteger(weaponData.magazine?.max));
  const availableSources = sourceItems
    .map(item => ({
      uuid: item.uuid,
      name: String(getDamageSourceFunction(item)?.name ?? "").trim() || item.name,
      quantity: getActorMagazineSourceQuantity(actor, item),
      selected: item.uuid === sourceItem.uuid
    }))
    .filter(entry => entry.quantity > 0);

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
    updateReloadDialogMagazineReadout(dialog, actor, weaponId, weaponFunctionId);
    await application?.render({ force: true });
  };

  const dialog = new DialogV2({
    window: {
      title: game.i18n.localize("FALLOUTMAW.Item.WeaponActionReload")
    },
    content: `
      <form class="fallout-maw-reload-dialog-form">
      <div class="fallout-maw-reload-dialog">
        <p><strong>${escapeHTML(sourceLabel)}</strong></p>
        <p data-reload-magazine-readout>${escapeHTML(game.i18n.localize("FALLOUTMAW.Item.WeaponMagazine"))}: ${current} / ${max}</p>
        <label>
          <span>${escapeHTML(game.i18n.localize("FALLOUTMAW.Item.WeaponMagazineSource"))}</span>
          <select name="sourceUuid" data-reload-source-select ${availableSources.length ? "" : "disabled"}>
            ${availableSources.map(entry => `
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

  await dialog.render({ force: true });
  return undefined;
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
    [`${getWeaponFunctionPath(weaponFunctionId)}.magazine.sourceItemUuid`]: sourceItem.uuid,
    [`${getWeaponFunctionPath(weaponFunctionId)}.magazine.value`]: current + amount
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
    [`${getWeaponFunctionPath(weaponFunctionId)}.magazine.sourceItemUuid`]: sourceItem.uuid,
    [`${getWeaponFunctionPath(weaponFunctionId)}.magazine.value`]: 0
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

function getWeaponFunctionPath(weaponFunctionId = "") {
  const id = String(weaponFunctionId ?? "");
  return !id || id === ITEM_FUNCTIONS.weapon
    ? "system.functions.weapon"
    : `system.functions.additionalWeapons.${id}`;
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
  if (String(left?.damageTypeKey ?? "") !== String(right?.damageTypeKey ?? "")) return false;
  const leftTypes = normalizeDamageSourceTypeSignature(left?.damageTypes);
  const rightTypes = normalizeDamageSourceTypeSignature(right?.damageTypes);
  return leftTypes === rightTypes;
}

function normalizeDamageSourceTypeSignature(entries = []) {
  return (entries ?? [])
    .map(entry => `${String(entry?.key ?? "")}:${toInteger(entry?.percent)}`)
    .sort()
    .join("|");
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
  const fallback = createDefaultInventorySize();
  const inventorySize = race?.inventorySize ?? fallback;
  return {
    columns: Math.max(1, toInteger(inventorySize.columns) || fallback.columns),
    rows: Math.max(1, toInteger(inventorySize.rows) || fallback.rows)
  };
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

async function fullyRestoreActor(actor) {
  if (!actor?.isOwner) return;

  const traumaIds = actor.items
    .filter(item => item.type === "trauma" || item.type === "disease")
    .map(item => item.id);
  if (traumaIds.length) await actor.deleteEmbeddedDocuments("Item", traumaIds);

  const damageEffectIds = actor.effects
    .filter(effect => isDamageSystemEffect(effect))
    .map(effect => effect.id);
  if (damageEffectIds.length) await actor.deleteEmbeddedDocuments("ActiveEffect", damageEffectIds);

  const updates = {};
  for (const [key, limb] of Object.entries(actor.system?.limbs ?? {})) {
    const max = Math.max(0, toInteger(limb?.max));
    updates[`system.limbs.${key}.value`] = max;
    updates[`system.limbs.${key}.damageAccumulation`] = {};
  }
  for (const [key, resource] of Object.entries(actor.system?.resources ?? {})) {
    const max = Math.max(Math.max(0, toInteger(resource?.min)), toInteger(resource?.max));
    updates[`system.resources.${key}.value`] = max;
    updates[`system.resources.${key}.spent`] = 0;
  }
  for (const [key, need] of Object.entries(actor.system?.needs ?? {})) {
    const min = Math.max(0, toInteger(need?.min));
    updates[`system.needs.${key}.value`] = min;
    updates[`system.needs.${key}.spent`] = 0;
  }
  if (Object.keys(updates).length) await actor.update(updates);
}

function isDamageSystemEffect(effect) {
  if (!effect) return false;
  const flags = effect.flags?.[SYSTEM_ID] ?? effect.flags?.[FALLOUT_MAW.id] ?? {};
  return Boolean(flags[DAMAGE_EFFECT_FLAG_KEY] || flags.traumaItem || flags.diseaseItem || flags.needEffect);
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
    const popupBottom = actionsRect?.top ?? rootRect.top;
    const maxHeight = Math.max(72, (popupBottom - margin) / scale);
    element.style.setProperty("--fallout-maw-token-hud-popup-max-height", `${Math.floor(maxHeight)}px`);
  }

  element.classList.add("layout-ready");
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
