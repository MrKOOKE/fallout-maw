import { FALLOUT_MAW } from "../config/system-config.mjs";
import { SYSTEM_ID, TEMPLATES } from "../constants.mjs";
import {
  getCreatureOptions,
  getActorNeedSettings,
  getResourceSettings,
  getSkillSettings,
  getSystemActionSettings,
  getTokenActionHudDamageIcons,
  setTokenActionHudDamageIcons
} from "../settings/accessors.mjs";
import {
  TOKEN_ACTION_HUD_COLLAPSED_SECTIONS_SETTING,
  TOKEN_ACTION_HUD_ENABLED_SETTING,
  TOKEN_ACTION_HUD_SCALE_SETTING
} from "../settings/constants.mjs";
import { requestSkillCheck } from "../rolls/skill-check.mjs";
import { getLimbHealingCap, getResourceLimitState } from "../combat/damage-hub.mjs";
import { MOVEMENT_RESOURCE_PREVIEW_HOOK } from "../combat/movement-resources.mjs";
import { cancelWeaponAttack, startWeaponAttack } from "../combat/weapon-attack-controller.mjs";
import { openLimbDamageDialog } from "./limb-damage-dialog.mjs";
import { requestMedicineTarget } from "./medicine-dialog.mjs";
import {
  FALLBACK_ICON,
  normalizeImagePath,
  prepareIndicatorEntry,
  prepareInventoryContext
} from "../utils/actor-display-data.mjs";
import { ITEM_FUNCTIONS, getEnabledWeaponFunctions } from "../utils/item-functions.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { createLimbSilhouetteHud } from "../utils/limb-silhouette.mjs";
import { FalloutMaWFormApplicationV2, getFlatFormData } from "./base-form-application-v2.mjs";

const { ApplicationV2, DialogV2, HandlebarsApplicationMixin } = foundry.applications.api;
const FormDataExtended = foundry.applications.ux.FormDataExtended;
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
  if (isHudSilentItemUpdate(changes)) return;
  scheduleTokenActionHudRefreshForItem(item);
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
  #layoutFrame = null;
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
    const displayLimbs = prepareDisplayLimbs(actor);
    const limbSilhouette = createLimbSilhouetteHud(race?.limbSilhouette, displayLimbs);

    return {
      ...context,
      actor,
      token: this.#token,
      limbs: limbSilhouette?.visible ? [] : prepareLimbEntries(displayLimbs),
      limbSilhouette,
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

    const element = this.#limbPopover.element ?? document.createElement("div");
    element.className = "fallout-maw fallout-maw-token-hud-limb-popover";
    element.replaceChildren();
    const title = document.createElement("div");
    title.className = "fallout-maw-token-hud-limb-popover-title";
    title.textContent = label;
    const valueRow = document.createElement("div");
    valueRow.className = "fallout-maw-token-hud-limb-popover-value";
    valueRow.textContent = `${value} / ${max}`;
    element.append(title, valueRow);
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
      width: 420,
      height: "auto"
    },
    window: {
      resizable: false
    },
    form: {
      handler: TokenActionHudSettings.handleFormSubmit,
      submitOnChange: false,
      closeOnSubmit: true
    },
    actions: {
      browseHudDamageIcon: this.#onBrowseHudDamageIcon
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
      max: TOKEN_ACTION_HUD_SCALE_MAX,
      damageIcons: getTokenActionHudDamageIcons()
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
    await setTokenActionHudDamageIcons({
      damageReductionIcon: data.damageReductionIcon,
      damageBlockedIcon: data.damageBlockedIcon
    });
    applyTokenActionHudScale(scale);
  }

  static async #onBrowseHudDamageIcon(event, target) {
    event.preventDefault();
    const field = target.closest("[data-hud-damage-icon-field]");
    const input = field?.querySelector("input");
    if (!input) return undefined;

    const picker = new foundry.applications.apps.FilePicker.implementation({
      type: "image",
      current: input.value ?? "",
      callback: path => {
        input.value = path;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });

    await picker.browse(undefined, { render: false });
    return picker.render({ force: true });
  }

  #previewScale(range, output) {
    const scale = normalizeTokenActionHudScalePercent(range?.value);
    if (scale === this.#lastPreviewPercent) return;
    this.#lastPreviewPercent = scale;
    if (output) output.textContent = `${scale}%`;
    applyTokenActionHudScale(scale);
  }
}

function prepareDisplayLimbs(actor) {
  return Object.fromEntries(Object.entries(actor.system?.limbs ?? {}).map(([key, limb]) => [
    key,
    prepareLimbDisplayData(actor, key, limb)
  ]));
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
  const actions = weaponFunction?.data?.availableActions ?? {};
  const buttons = [
    { key: "aimedShot", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionAimedShot"), configured: Boolean(actions.aimedShot) },
    { key: "snapshot", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionSnapshot"), configured: Boolean(actions.snapshot) },
    { key: "burst", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionBurst"), configured: Boolean(actions.burst), visible: Boolean(actions.burst) },
    { key: "volley", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionVolley"), configured: Boolean(actions.volley), visible: Boolean(actions.volley) },
    { key: "meleeAttack", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionMeleeAttack"), configured: Boolean(actions.meleeAttack) },
    { key: "aimedMeleeAttack", label: game.i18n.localize("FALLOUTMAW.Item.WeaponActionAimedMeleeAttack"), configured: Boolean(actions.aimedMeleeAttack) }
  ];
  return buttons.filter(action => action.visible !== false && action.configured).map(action => ({
    ...action,
    label: String(weaponFunction.data?.[action.key]?.name ?? "").trim() || action.label,
    disabled: forceDisabled,
    itemId: selectedWeapon.id,
    weaponFunctionId: weaponFunction.isPrimary ? ITEM_FUNCTIONS.weapon : weaponFunction.id,
    img: normalizeImagePath(selectedWeapon.img, "icons/svg/combat.svg"),
    actionPointCost: getWeaponActionPointCostForHud(weaponFunction.data, action.key),
    actionPointCostLabel: `${getWeaponActionPointCostForHud(weaponFunction.data, action.key)} ОД`
  }));
}

function getWeaponActionPointCostForHud(weaponData = {}, actionKey = "") {
  const value = Number(weaponData?.[actionKey]?.actionPointCost);
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 5;
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
