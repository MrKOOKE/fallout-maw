import { FALLOUT_MAW } from "../config/system-config.mjs";
import { TEMPLATES } from "../constants.mjs";
import {
  getCreatureOptions,
  getNeedSettings,
  getResourceSettings,
  getSkillSettings
} from "../settings/accessors.mjs";
import { TOKEN_ACTION_HUD_ENABLED_SETTING } from "../settings/constants.mjs";
import { requestSkillCheck } from "../rolls/skill-check.mjs";
import {
  FALLBACK_ICON,
  normalizeImagePath,
  prepareIndicatorEntry,
  prepareInventoryContext
} from "../utils/actor-display-data.mjs";
import { toInteger } from "../utils/numbers.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const ACTIVE_WEAPON_SET_FLAG = "activeWeaponSet";
const HUD_ACTIONS = Object.freeze([
  { key: "weapon", label: "Оружие", icon: "icons/svg/combat.svg" },
  { key: "items", label: "Предметы", icon: "icons/svg/item-bag.svg" },
  { key: "abilities", label: "Способности", icon: "icons/svg/aura.svg" },
  { key: "skills", label: "Испытания", icon: "icons/svg/dice-target.svg" }
]);

let tokenActionHud = null;
let hooksRegistered = false;
let tokenActionHudRefresh = null;

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
      cycleWeaponSet: TokenActionHud.#onCycleWeaponSet,
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

    return {
      ...context,
      actor,
      token: this.#token,
      limbs: prepareLimbEntries(actor),
      resources: prepareResourceEntries(actor),
      needs: prepareNeedEntries(actor),
      activeTray: this.#activeTray,
      activeWeaponSet,
      actions,
      tray,
      fallbackIcon: FALLBACK_ICON
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.element?.classList.remove("layout-ready");
    this.#scheduleLayout();
  }

  async _onClose(options) {
    await super._onClose(options);
    if (this.#layoutFrame) cancelAnimationFrame(this.#layoutFrame);
    this.#layoutFrame = null;
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
}

function prepareLimbEntries(actor) {
  return Object.entries(actor.system?.limbs ?? {}).map(([key, limb]) => prepareIndicatorEntry({
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
  const maxLength = items.reduce((max, item) => {
    const label = String(item.label ?? item.name ?? "");
    return Math.max(max, label.length);
  }, 0);
  const tileWidth = Math.ceil(Math.min(360, Math.max(116, (maxLength * 8.2) + 34)));
  return {
    style: `--fallout-maw-token-hud-action-tile-width: ${tileWidth}px;`
  };
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
  normalizePopupTileMetrics(element);

  const margin = 12;
  const safeRight = getSafeRight(margin);
  const actions = element.querySelector("[data-token-action-hud-actions]");
  const popup = element.querySelector("[data-token-action-hud-popup]");
  const actionsRect = actions?.getBoundingClientRect();
  const rootRect = element.getBoundingClientRect();

  const availableWidth = actionsRect
    ? Math.max(96, safeRight - actionsRect.left)
    : Math.max(96, safeRight - rootRect.left);
  element.style.setProperty("--fallout-maw-token-hud-actions-width", `${Math.floor(availableWidth)}px`);

  if (popup) {
    const popupBottom = actionsRect?.top ?? rootRect.top;
    const maxHeight = Math.max(72, popupBottom - margin);
    element.style.setProperty("--fallout-maw-token-hud-popup-max-height", `${Math.floor(maxHeight)}px`);
  }

  element.classList.add("layout-ready");
}

function normalizePopupTileMetrics(element) {
  const labels = Array.from(element.querySelectorAll(".fallout-maw-token-hud-action-tile span"));
  if (!labels.length) return;

  const canvas = normalizePopupTileMetrics.canvas ??= document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return;
  const labelStyle = getComputedStyle(labels[0]);
  context.font = `${labelStyle.fontWeight} ${labelStyle.fontSize} ${labelStyle.fontFamily}`;

  const maxTextWidth = labels.reduce((max, label) => {
    const text = label.textContent.trim();
    return Math.max(max, context.measureText(text).width);
  }, 0);
  const tileWidth = Math.ceil(Math.min(360, Math.max(116, maxTextWidth + 30)));
  const lineHeight = Number.parseFloat(labelStyle.lineHeight) || (Number.parseFloat(labelStyle.fontSize) * 1.15) || 12;
  const labelHeight = Math.ceil(lineHeight);

  element.style.setProperty("--fallout-maw-token-hud-action-tile-width", `${tileWidth}px`);
  element.style.setProperty("--fallout-maw-token-hud-action-label-height", `${labelHeight}px`);
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
