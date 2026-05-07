import { FALLOUT_MAW } from "../config/system-config.mjs";
import { TEMPLATES } from "../constants.mjs";
import {
  getCreatureOptions,
  getNeedSettings,
  getResourceSettings,
  getSkillSettings
} from "../settings/accessors.mjs";
import {
  TOKEN_ACTION_HUD_COLLAPSED_SECTIONS_SETTING,
  TOKEN_ACTION_HUD_ENABLED_SETTING,
  TOKEN_ACTION_HUD_SCALE_SETTING
} from "../settings/constants.mjs";
import { requestSkillCheck } from "../rolls/skill-check.mjs";
import { getLimbHealingCap } from "../combat/damage-hub.mjs";
import { openLimbDamageDialog } from "./limb-damage-dialog.mjs";
import {
  FALLBACK_ICON,
  normalizeImagePath,
  prepareIndicatorEntry,
  prepareInventoryContext
} from "../utils/actor-display-data.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { createLimbSilhouetteHud } from "../utils/limb-silhouette.mjs";
import { FalloutMaWFormApplicationV2, getFlatFormData } from "./base-form-application-v2.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const ACTIVE_WEAPON_SET_FLAG = "activeWeaponSet";
const TOKEN_ACTION_HUD_SCALE_DEFAULT = 50;
const TOKEN_ACTION_HUD_SCALE_MIN = 25;
const TOKEN_ACTION_HUD_SCALE_MAX = 100;
const HUD_ACTION_TILE_MIN_WIDTH = 116;
const HUD_ACTION_TILE_MAX_WIDTH = 260;
const HUD_ACTION_TILE_HORIZONTAL_CHROME = 30;
const HUD_ACTION_TILE_LABEL_FONT_WEIGHT = 700;
const HUD_ACTION_TILE_LABEL_FONT_SIZE_REM = 0.8;
const HUD_METER_SECTION_KEYS = Object.freeze(["resources", "needs"]);
const HUD_ACTIONS = Object.freeze([
  { key: "weapon", label: "Оружие", icon: "icons/svg/combat.svg" },
  { key: "items", label: "Предметы", icon: "icons/svg/item-bag.svg" },
  { key: "abilities", label: "Способности", icon: "icons/svg/aura.svg" },
  { key: "skills", label: "Испытания", icon: "icons/svg/dice-target.svg" },
  { key: "settings", label: "Настройки", icon: "icons/svg/lever.svg" }
]);

let tokenActionHud = null;
let tokenActionHudSettings = null;
let hooksRegistered = false;
let tokenActionHudRefresh = null;
let tokenActionHudLayoutRefresh = null;
let tokenActionHudPreviewPercent = null;

export function registerTokenActionHudHooks() {
  if (hooksRegistered) return;
  Hooks.on("getSceneControlButtons", addTokenActionHudControlButton);
  Hooks.on("controlToken", scheduleTokenActionHudRefresh);
  Hooks.on("canvasReady", scheduleTokenActionHudRefresh);
  Hooks.on("canvasTearDown", closeTokenActionHud);
  Hooks.on("updateActor", scheduleTokenActionHudRefreshForActor);
  Hooks.on("updateItem", scheduleTokenActionHudRefreshForItem);
  Hooks.on("createItem", scheduleTokenActionHudRefreshForItem);
  Hooks.on("deleteItem", scheduleTokenActionHudRefreshForItem);
  Hooks.on("updateToken", scheduleTokenActionHudRefresh);
  Hooks.on("updateSetting", scheduleTokenActionHudRefreshForSetting);
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
  tokenActionHud.element.classList.remove("layout-ready");
  layoutTokenActionHud(tokenActionHud.element);
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
  if (controlled.length !== 1) return null;
  const token = controlled[0];
  const actor = token?.actor;
  if (!actor?.testUserPermission?.(game.user, "LIMITED")) return null;
  return token;
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
      cycleWeaponSet: TokenActionHud.#onCycleWeaponSet,
      openSettings: TokenActionHud.#onOpenSettings,
      rollSkill: TokenActionHud.#onRollSkill,
      openItem: TokenActionHud.#onOpenItem
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

  setToken(token) {
    if (this.#token?.id !== token?.id) this.#activeTray = "";
    this.#token = token;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const actor = this.actor;
    const race = getCreatureOptions().races.find(entry => entry.id === actor.system?.creature?.raceId);
    const inventory = prepareInventoryContext(actor, race);
    const activeWeaponSet = getActiveWeaponSet(actor, inventory.weaponSets);
    const skills = prepareSkillButtons(actor);
    const items = prepareOwnedItemButtons(actor, "gear", "icons/svg/item-bag.svg");
    const abilities = prepareOwnedItemButtons(actor, "ability", "icons/svg/aura.svg");
    const actions = prepareActions(this.#activeTray, activeWeaponSet, items, abilities);
    const tray = prepareTrayContext(this.#activeTray, skills, items, abilities);
    const meterSections = prepareMeterSectionStates();
    const displayLimbs = prepareDisplayLimbs(actor);
    const limbSilhouette = createLimbSilhouetteHud(race?.limbSilhouette, displayLimbs);

    return {
      ...context,
      actor,
      token: this.#token,
      limbs: limbSilhouette?.visible ? [] : prepareLimbEntries(displayLimbs),
      limbSilhouette,
      resources: prepareResourceEntries(actor),
      needs: prepareNeedEntries(actor),
      activeTray: this.#activeTray,
      activeWeaponSet,
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
    this.element?.classList.remove("layout-ready");
    this.#scheduleLayout();
  }

  async _onClose(options) {
    await super._onClose(options);
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
    this.element?.classList.remove("layout-ready");
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

  static async #onCycleWeaponSet(event) {
    event.preventDefault();
    const actor = this.actor;
    if (!actor?.isOwner) return undefined;
    const race = getCreatureOptions().races.find(entry => entry.id === actor.system?.creature?.raceId);
    const weaponSets = prepareInventoryContext(actor, race).weaponSets;
    if (weaponSets.length <= 1) return undefined;

    const active = getActiveWeaponSet(actor, weaponSets);
    const activeIndex = Math.max(0, weaponSets.findIndex(set => set.key === active?.key));
    const next = weaponSets[(activeIndex + 1) % weaponSets.length];
    await actor.setFlag(FALLOUT_MAW.id, ACTIVE_WEAPON_SET_FLAG, next.key);
    return this.render({ force: true });
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
    const item = this.actor?.items.get(target.dataset.itemId ?? "");
    return item?.sheet?.render(true);
  }

  #activateLimbControlClicks() {
    const root = this.element;
    if (!root || root.dataset.limbControlClicksBound === "true") return;
    root.dataset.limbControlClicksBound = "true";
    root.addEventListener("click", event => this.#onLimbControlClick(event), { capture: true });
    root.addEventListener("keydown", event => this.#onLimbControlKeyDown(event), { capture: true });
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

class TokenActionHudSettings extends FalloutMaWFormApplicationV2 {
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
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.settings.tokenActionHud
    }
  };

  get title() {
    return "Настройки HUD";
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
  return getResourceSettings().map(resource => prepareIndicatorEntry({
    ...resource,
    data: actor.system.resources?.[resource.key]
  }));
}

function prepareNeedEntries(actor) {
  return getNeedSettings().map(need => prepareIndicatorEntry({
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

function prepareTrayContext(activeTray, skills, items, abilities) {
  const trayItems = activeTray === "skills"
    ? skills
    : activeTray === "items"
      ? items
      : activeTray === "abilities"
        ? abilities
        : [];
  return {
    skills,
    items,
    abilities,
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

function prepareActions(activeTray, activeWeaponSet, items, abilities) {
  return HUD_ACTIONS.map(action => {
    if (action.key === "weapon") {
      const firstItem = activeWeaponSet?.slots?.find(slot => slot.item)?.item;
      return {
        ...action,
        active: false,
        disabled: false,
        icon: normalizeImagePath(firstItem?.img, action.icon),
        caption: activeWeaponSet?.label ?? action.label,
        count: activeWeaponSet?.slots?.filter(slot => slot.item).length ?? 0
      };
    }

    const count = action.key === "items" ? items.length : action.key === "abilities" ? abilities.length : 0;
    return {
      ...action,
      active: activeTray === action.key,
      disabled: false,
      caption: action.label,
      count
    };
  });
}

function getActiveWeaponSet(actor, weaponSets = []) {
  if (!weaponSets.length) return null;
  const activeKey = String(actor.getFlag(FALLOUT_MAW.id, ACTIVE_WEAPON_SET_FLAG) ?? "");
  return weaponSets.find(set => set.key === activeKey) ?? weaponSets[0];
}

function layoutTokenActionHud(element) {
  if (!element?.isConnected) return;
  const margin = 12;
  const safeRight = getSafeRight(margin);
  const actions = element.querySelector("[data-token-action-hud-actions]");
  const popup = element.querySelector("[data-token-action-hud-popup]");
  const actionsRect = actions?.getBoundingClientRect();
  const rootRect = element.getBoundingClientRect();

  const availableWidth = actionsRect
    ? Math.max(96, (safeRight - actionsRect.left) / getActiveTokenActionHudScaleFactor())
    : Math.max(96, (safeRight - rootRect.left) / getActiveTokenActionHudScaleFactor());
  element.style.setProperty("--fallout-maw-token-hud-actions-width", `${Math.floor(availableWidth)}px`);

  if (popup) {
    const popupBottom = actionsRect?.top ?? rootRect.top;
    const maxHeight = Math.max(72, (popupBottom - margin) / getActiveTokenActionHudScaleFactor());
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
