import { FALLOUT_MAW } from "../config/system-config.mjs";
import { TOKEN_HUD_EQUIPMENT_SLOTS_ENABLED_SETTING } from "../settings/constants.mjs";
import { openSearchInventoryWindow, requestTradeInventoryWindow } from "../apps/search-inventory.mjs";
import { renderInventoryItemTooltipHTML } from "../sheets/actor-sheet.mjs";
import { prepareInventoryContext } from "../utils/actor-display-data.mjs";
import { activateInventoryTooltipTab } from "../utils/inventory-tooltip-tabs.mjs";
import {
  equipActorItemInEquipmentSlot,
  equipActorItemInWeaponSlot,
  getActorRace,
  getEquipmentSlotCandidateItems,
  getWeaponSlotCandidateItems,
  unequipActorItemToInventory
} from "../utils/equipment-hud-placement.mjs";
import { getConditionFunction, hasItemFunction, ITEM_FUNCTIONS } from "../utils/item-functions.mjs";

const SEARCH_ICON = `systems/${FALLOUT_MAW.id}/assets/Komandy%20dlya%20upravleniya%20tokenom/obysk.webp`;
const TRADE_ICON = `systems/${FALLOUT_MAW.id}/assets/Komandy%20dlya%20upravleniya%20tokenom/torgovlya.webp`;
const SELECTED_HUD_WEAPON_SET_FLAG = "selectedHudWeaponSetKey";
const HUD_BLOCK_CLASS = "fallout-maw-token-equipment-hud";
const HUD_ACTIONS_CLASS = "fallout-maw-token-equipment-hud-actions";
const NON_OWNER_CLASS = "fallout-maw-token-equipment-hud-non-owner";
const SLOT_PICKER_CLASS = "fallout-maw-token-equipment-picker";

let activeSlotPickerCleanup = null;

export function registerTokenEquipmentHudHooks() {
  Hooks.on("renderTokenHUD", decorateTokenHudEquipment);
  Hooks.on("updateActor", refreshTokenEquipmentHudForActor);
  Hooks.on("createItem", refreshTokenEquipmentHudForItem);
  Hooks.on("updateItem", refreshTokenEquipmentHudForItem);
  Hooks.on("deleteItem", refreshTokenEquipmentHudForItem);
  Hooks.on("updateToken", refreshTokenEquipmentHudForTokenDocument);
  Hooks.on("deleteToken", refreshTokenEquipmentHudForTokenDocument);
  Hooks.on("updateSetting", setting => {
    if (setting?.key !== `${FALLOUT_MAW.id}.${TOKEN_HUD_EQUIPMENT_SLOTS_ENABLED_SETTING}`) return;
    refreshTokenEquipmentHud();
  });
}

export function isTokenEquipmentHudEnabled() {
  try {
    return Boolean(game.settings.get(FALLOUT_MAW.id, TOKEN_HUD_EQUIPMENT_SLOTS_ENABLED_SETTING));
  } catch (_error) {
    return true;
  }
}

export async function openTokenHudForInteraction(token) {
  if (!token?.actor || !isTokenEquipmentHudEnabled()) return false;
  const hud = canvas?.hud?.token;
  if (!hud) return false;
  if (hud.object?.id === token.id) {
    await hud.close();
    return true;
  }
  await hud.bind(token);
  return true;
}

export function decorateTokenHudEquipment(app, html) {
  if (!isTokenEquipmentHudEnabled()) return;
  const element = getHTMLElement(html);
  const token = app?.object ?? null;
  const actor = token?.actor ?? null;
  if (!element || !token || !actor) return;

  element.querySelectorAll(`.${HUD_BLOCK_CLASS}, .${HUD_ACTIONS_CLASS}`).forEach(node => node.remove());
  element.classList.toggle(NON_OWNER_CLASS, !token.isOwner);

  const inventory = prepareInventoryContext(actor, getActorRace(actor), { includeLocked: true });
  const equipmentRows = buildEquipmentHudRows(inventory);
  const [leftRows, rightRows] = splitRows(equipmentRows);
  const weaponRows = buildWeaponHudRows(actor, inventory);

  const leftColumn = element.querySelector(".col.left") ?? element;
  const rightColumn = element.querySelector(".col.right") ?? element;
  leftColumn.append(buildSlotColumn(leftRows, "left", { actor, token, owner: token.isOwner }));
  rightColumn.append(buildSlotColumn(rightRows, "right", { actor, token, owner: token.isOwner }));
  if (weaponRows.length) rightColumn.append(buildSlotColumn(weaponRows, "weapons", { actor, token, owner: token.isOwner }));

  if (!token.isOwner) {
    hideDefaultTokenHudControls(element);
    leftColumn.prepend(buildInteractionActions(token));
  }
}

function getHTMLElement(html) {
  if (html instanceof HTMLElement) return html;
  if (html?.[0] instanceof HTMLElement) return html[0];
  return null;
}

function buildEquipmentHudRows(inventory) {
  return (inventory.equipmentSlots ?? []).map(slot => ({
    kind: "equipment",
    key: String(slot.key ?? ""),
    label: String(slot.label ?? slot.key ?? ""),
    item: slot.item ?? null
  }));
}

function splitRows(rows = []) {
  const midpoint = Math.ceil(rows.length / 2);
  return [rows.slice(0, midpoint), rows.slice(midpoint)];
}

function buildWeaponHudRows(actor, inventory) {
  const sets = inventory.weaponSets ?? [];
  if (!sets.length) return [];
  const selectedKey = String(actor.getFlag(FALLOUT_MAW.id, SELECTED_HUD_WEAPON_SET_FLAG) ?? "");
  const set = sets.find(entry => entry.key === selectedKey) ?? sets[0];
  return (set?.slots ?? []).filter(slot => !slot.phantom).map(slot => ({
    kind: "weapon",
    key: String(slot.key ?? ""),
    label: String(slot.label ?? slot.limbLabel ?? slot.key ?? ""),
    item: slot.item ?? null,
    weaponSetKey: String(set.key ?? ""),
    weaponSetLabel: String(set.label ?? set.key ?? "")
  }));
}

function buildSlotColumn(rows, side, context) {
  const column = document.createElement("div");
  column.className = `${HUD_BLOCK_CLASS} ${side}`;
  for (const row of rows) column.append(buildSlotButton(row, context));
  return column;
}

function buildSlotButton(row, { actor, token, owner }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `control-icon fallout-maw-token-equipment-hud-slot ${row.kind}`;
  button.dataset.falloutMawEquipmentHudSlot = row.key;
  button.dataset.slotKind = row.kind;
  button.dataset.tooltip = row.item?.name ? `${row.label}: ${row.item.name}` : row.label;
  button.setAttribute("aria-label", button.dataset.tooltip);
  if (row.item?.id) button.dataset.itemId = row.item.id;
  if (row.weaponSetKey) button.dataset.weaponSet = row.weaponSetKey;

  if (row.item?.img) {
    const img = document.createElement("img");
    img.src = row.item.img;
    img.alt = "";
    img.draggable = false;
    button.append(img);
  } else {
    const icon = document.createElement("i");
    icon.className = owner ? "fa-solid fa-plus" : "fa-regular fa-square";
    button.append(icon);
  }

  if (owner) {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      void onOwnerSlotClick(actor, token, row);
    });
    button.addEventListener("contextmenu", event => {
      event.preventDefault();
      event.stopPropagation();
      void onOwnerSlotContext(actor, token, row);
    });
  } else {
    button.setAttribute("aria-disabled", "true");
  }
  return button;
}

async function onOwnerSlotClick(actor, token, row) {
  const items = row.kind === "weapon"
    ? getWeaponSlotCandidateItems(actor, row.weaponSetKey, row.key)
    : getEquipmentSlotCandidateItems(actor, row);
  if (!items.length) {
    ui.notifications.info(`Нет подходящих предметов для слота "${row.label}".`);
    return;
  }
  const itemId = await chooseHudSlotItem(actor, row, items);
  if (!itemId) return;
  const item = actor.items.get(itemId);
  if (!item) return;
  if (row.kind === "weapon") await equipActorItemInWeaponSlot(actor, item, row.weaponSetKey, row.key);
  else await equipActorItemInEquipmentSlot(actor, item, row.key);
  refreshBoundTokenHud(token);
}

async function onOwnerSlotContext(actor, token, row) {
  const itemId = String(row.item?.id ?? "");
  if (!itemId) return;
  const item = actor.items.get(itemId);
  if (!item) return;
  await unequipActorItemToInventory(actor, item);
  refreshBoundTokenHud(token);
}

async function chooseHudSlotItem(actor, row, items) {
  closeActiveSlotPicker();

  const overlay = document.createElement("div");
  overlay.className = `${SLOT_PICKER_CLASS}-overlay`;
  overlay.innerHTML = `
    <section class="${SLOT_PICKER_CLASS}" role="dialog" aria-modal="true" aria-label="${escapeAttribute(row.label)}">
      <header class="${SLOT_PICKER_CLASS}-header">
        <div>
          <span class="${SLOT_PICKER_CLASS}-eyebrow">Слот: ${escapeHTML(row.label)}</span>
        </div>
        <button type="button" class="${SLOT_PICKER_CLASS}-close" aria-label="Закрыть">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </header>
      <div class="${SLOT_PICKER_CLASS}-body">
        <div class="${SLOT_PICKER_CLASS}-grid"></div>
      </div>
    </section>
  `;

  document.body.append(overlay);
  const dialog = overlay.querySelector(`.${SLOT_PICKER_CLASS}`);
  const grid = overlay.querySelector(`.${SLOT_PICKER_CLASS}-grid`);
  const closeButton = overlay.querySelector(`.${SLOT_PICKER_CLASS}-close`);
  const tooltipController = createSlotPickerTooltipController(overlay);

  return new Promise(resolve => {
    let resolved = false;
    const onKeyDown = event => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close("");
    };
    const close = (itemId = "") => {
      if (resolved) return;
      resolved = true;
      document.removeEventListener("keydown", onKeyDown, true);
      tooltipController.destroy();
      game.tooltip?.deactivate();
      overlay.remove();
      if (activeSlotPickerCleanup === close) activeSlotPickerCleanup = null;
      resolve(String(itemId ?? ""));
    };

    activeSlotPickerCleanup = close;
    closeButton?.addEventListener("click", event => {
      event.preventDefault();
      close("");
    });
    overlay.addEventListener("mousedown", event => {
      if (dialog?.contains(event.target)) return;
      close("");
    });
    document.addEventListener("keydown", onKeyDown, true);

    void renderSlotPickerCards(actor, grid, items, close);
    tooltipController.bind(grid, actor);
  });
}

async function renderSlotPickerCards(actor, grid, items, close) {
  if (!grid) return;
  grid.replaceChildren();
  const cards = await Promise.all(items.map(item => buildSlotPickerCard(actor, item, close)));
  grid.append(...cards);
}

async function buildSlotPickerCard(actor, item, close) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = `${SLOT_PICKER_CLASS}-card`;
  card.dataset.itemId = item.id;

  const tooltipHTML = await renderSlotPickerTooltipHTML(item, actor);
  if (tooltipHTML) {
    card.dataset.slotPickerTooltipHtml = tooltipHTML;
  }

  const image = document.createElement("img");
  image.src = item.img || "icons/svg/item-bag.svg";
  image.alt = "";
  image.draggable = false;

  const content = document.createElement("span");
  content.className = `${SLOT_PICKER_CLASS}-card-content`;

  const name = document.createElement("strong");
  name.textContent = item.name ?? "";

  const condition = getSlotPickerCondition(item);
  const conditionLabel = document.createElement("span");
  conditionLabel.className = `${SLOT_PICKER_CLASS}-condition ${condition.tone}`;
  conditionLabel.textContent = condition.label;

  content.append(name, conditionLabel);
  if (condition.percent !== null) {
    const meter = document.createElement("span");
    meter.className = `${SLOT_PICKER_CLASS}-condition-meter ${condition.tone}`;
    meter.style.setProperty("--fallout-maw-slot-picker-condition", `${condition.percent}%`);
    content.append(meter);
  }

  card.append(image, content);
  card.addEventListener("click", event => {
    event.preventDefault();
    close(item.id);
  });
  return card;
}

function createSlotPickerTooltipController(overlay) {
  let actor = null;
  let root = null;
  let element = null;
  let anchor = null;
  let itemId = "";
  let pinned = false;
  let renderSequence = 0;
  let documentPointerDownHandler = null;
  let closeTimer = null;

  const onPointerOver = event => {
    if (pinned) return;
    const nextAnchor = getSlotPickerTooltipAnchor(event.target, root);
    if (!nextAnchor) return;
    if (nextAnchor.contains(event.relatedTarget)) return;
    cancelTooltipClose();
    anchor = nextAnchor;
    itemId = String(nextAnchor.dataset.itemId ?? "");
    void showTooltip(nextAnchor, itemId);
  };

  const onPointerOut = event => {
    if (pinned) return;
    const currentAnchor = getSlotPickerTooltipAnchor(event.target, root);
    if (!currentAnchor) return;
    if (currentAnchor.contains(event.relatedTarget)) return;
    if (element?.contains(event.relatedTarget)) {
      cancelTooltipClose();
      return;
    }
    const nextAnchor = getSlotPickerTooltipAnchor(event.relatedTarget, root);
    if (nextAnchor) return;
    scheduleTooltipClose();
  };

  const onPointerDown = event => {
    if (event.button !== 1) return;
    if (!getSlotPickerTooltipAnchor(event.target, root) && !element?.contains(event.target)) return;
    event.preventDefault();
  };

  const onAuxClick = event => {
    if (event.button !== 1) return;
    const nextAnchor = getSlotPickerTooltipAnchor(event.target, root);
    if (!nextAnchor) return;
    event.preventDefault();
    event.stopPropagation();

    const nextItemId = String(nextAnchor.dataset.itemId ?? "");
    if (pinned && anchor === nextAnchor && itemId === nextItemId) {
      clearTooltip({ force: true });
      return;
    }

    anchor = nextAnchor;
    itemId = nextItemId;
    pinned = true;
    void showTooltip(nextAnchor, nextItemId, { pinned: true });
  };

  const bind = (nextRoot, nextActor) => {
    root = nextRoot;
    actor = nextActor;
    root?.addEventListener("pointerover", onPointerOver);
    root?.addEventListener("pointerout", onPointerOut);
    root?.addEventListener("mousedown", onPointerDown);
    root?.addEventListener("auxclick", onAuxClick);
  };

  const destroy = () => {
    root?.removeEventListener("pointerover", onPointerOver);
    root?.removeEventListener("pointerout", onPointerOut);
    root?.removeEventListener("mousedown", onPointerDown);
    root?.removeEventListener("auxclick", onAuxClick);
    root = null;
    actor = null;
    clearTooltip({ force: true });
  };

  const showTooltip = async (nextAnchor, nextItemId, { pinned: pinTooltip = pinned } = {}) => {
    const sequence = ++renderSequence;
    const html = String(nextAnchor.dataset.slotPickerTooltipHtml ?? "");
    if (!html || !actor?.items?.get(nextItemId)) {
      clearTooltip({ force: true });
      return;
    }

    if (!element) {
      element = document.createElement("aside");
      element.className = "fallout-maw-inventory-tooltip fallout-maw-slot-picker-tooltip";
      element.addEventListener("click", onTooltipClick);
      element.addEventListener("auxclick", onTooltipAuxClick);
      element.addEventListener("mousedown", onPointerDown);
      element.addEventListener("pointerenter", cancelTooltipClose);
      element.addEventListener("pointerleave", onTooltipPointerLeave);
      document.body.append(element);
    }

    pinned = Boolean(pinTooltip);
    element.innerHTML = html;
    syncPinnedState();
    if (sequence !== renderSequence || anchor !== nextAnchor || itemId !== nextItemId) return;
    positionSlotPickerTooltip(element, nextAnchor);
    requestAnimationFrame(() => {
      if (sequence !== renderSequence || anchor !== nextAnchor || itemId !== nextItemId) return;
      updateSlotPickerTooltipOverflow(element);
      positionSlotPickerTooltip(element, nextAnchor);
    });
  };

  const onTooltipAuxClick = event => {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    const nestedAnchor = event.target?.closest?.("[data-tooltip-html]");
    if (nestedAnchor && element?.contains(nestedAnchor)) {
      return;
    }
    clearTooltip({ force: true });
  };

  const onTooltipClick = event => {
    const button = event.target?.closest?.("[data-tooltip-weapon-tab]");
    if (!button || !element?.contains(button)) return;
    event.preventDefault();
    event.stopPropagation();
    const index = Math.max(0, toInteger(button.dataset.tooltipWeaponTab));
    activateInventoryTooltipTab(element, index);
    if (anchor) positionSlotPickerTooltip(element, anchor);
  };

  const onTooltipPointerLeave = event => {
    if (pinned || element?.contains(event.relatedTarget)) return;
    if (getSlotPickerTooltipAnchor(event.relatedTarget, root)) {
      cancelTooltipClose();
      return;
    }
    scheduleTooltipClose();
  };

  const scheduleTooltipClose = () => {
    if (pinned || closeTimer) return;
    closeTimer = window.setTimeout(() => {
      closeTimer = null;
      if (pinned || element?.matches?.(":hover") || anchor?.matches?.(":hover")) return;
      clearTooltip();
    }, 160);
  };

  const cancelTooltipClose = () => {
    if (!closeTimer) return;
    window.clearTimeout(closeTimer);
    closeTimer = null;
  };

  const syncPinnedState = () => {
    if (!element) return;
    element.classList.toggle("pinned", pinned);
    element.style.pointerEvents = pinned ? "auto" : "none";
    if (pinned) bindDocumentPointerDown();
    else unbindDocumentPointerDown();
  };

  const bindDocumentPointerDown = () => {
    if (documentPointerDownHandler) return;
    documentPointerDownHandler = event => {
      if (element?.contains(event.target)) return;
      if (anchor?.contains(event.target)) return;
      clearTooltip({ force: true });
    };
    document.addEventListener("pointerdown", documentPointerDownHandler, true);
  };

  const unbindDocumentPointerDown = () => {
    if (!documentPointerDownHandler) return;
    document.removeEventListener("pointerdown", documentPointerDownHandler, true);
    documentPointerDownHandler = null;
  };

  const clearTooltip = ({ force = false } = {}) => {
    if (pinned && !force) return;
    renderSequence += 1;
    cancelTooltipClose();
    unbindDocumentPointerDown();
    element?.remove();
    element = null;
    anchor = null;
    itemId = "";
    pinned = false;
  };

  return { bind, destroy };
}

function getSlotPickerTooltipAnchor(target, root) {
  if (!(target instanceof Element) || !root) return null;
  const anchor = target.closest(`.${SLOT_PICKER_CLASS}-card[data-item-id]`);
  return anchor && root.contains(anchor) ? anchor : null;
}

function positionSlotPickerTooltip(element, anchor) {
  if (!element || !anchor?.isConnected) return;
  const view = element.ownerDocument?.defaultView ?? window;
  const viewportWidth = view.innerWidth || document.documentElement?.clientWidth || 1280;
  const viewportHeight = view.innerHeight || document.documentElement?.clientHeight || 720;
  const margin = 12;
  const gap = 12;
  const anchorRect = anchor.getBoundingClientRect();

  element.style.setProperty("--fallout-maw-tooltip-max-height", `${Math.max(220, viewportHeight - (margin * 2))}px`);
  const tooltipRect = element.getBoundingClientRect();
  let left = anchorRect.right + gap;
  let direction = "right";
  if ((left + tooltipRect.width) > (viewportWidth - margin)) {
    left = anchorRect.left - tooltipRect.width - gap;
    direction = "left";
  }
  if (left < margin) {
    left = Math.max(margin, viewportWidth - tooltipRect.width - margin);
    direction = "clamped";
  }

  let top = anchorRect.top + ((anchorRect.height - tooltipRect.height) / 2);
  top = Math.max(margin, Math.min(viewportHeight - tooltipRect.height - margin, top));
  element.dataset.tooltipDirection = direction;
  element.style.left = `${Math.round(left)}px`;
  element.style.top = `${Math.round(top)}px`;
}

function updateSlotPickerTooltipOverflow(element) {
  const description = element?.querySelector(".description");
  description?.classList.toggle("overflowing", description.clientHeight < description.scrollHeight);
}

async function renderSlotPickerTooltipHTML(item, actor) {
  try {
    return await renderInventoryItemTooltipHTML(item, actor);
  } catch (error) {
    console.error("Fallout MaW | Failed to render token HUD item tooltip", error);
    return "";
  }
}

function getSlotPickerCondition(item) {
  if (!hasItemFunction(item, ITEM_FUNCTIONS.condition, { ignoreBroken: true })) {
    return { label: "Состояние не задано", percent: null, tone: "neutral" };
  }

  const condition = getConditionFunction(item);
  const max = Math.max(0, toInteger(condition.max));
  const value = Math.min(Math.max(0, toInteger(condition.value)), max);
  if (max <= 0) return { label: "Состояние не задано", percent: null, tone: "neutral" };

  const percent = Math.round((value / max) * 100);
  const tone = percent <= 25 ? "low" : percent <= 60 ? "medium" : "high";
  return { label: `Состояние ${value}/${max}`, percent, tone };
}

function closeActiveSlotPicker() {
  if (!activeSlotPickerCleanup) return;
  activeSlotPickerCleanup("");
}

function toInteger(value) {
  return Math.trunc(Number(value) || 0);
}

function escapeHTML(value) {
  const element = document.createElement("span");
  element.textContent = String(value ?? "");
  return element.innerHTML;
}

function escapeAttribute(value) {
  return escapeHTML(value).replace(/"/g, "&quot;");
}

function buildInteractionActions(token) {
  const wrapper = document.createElement("div");
  wrapper.className = HUD_ACTIONS_CLASS;
  wrapper.append(buildActionButton("search", "Обыск", SEARCH_ICON, () => openSearchForHudTarget(token)));
  wrapper.append(buildActionButton("trade", "Торговля", TRADE_ICON, () => requestTradeForHudTarget(token)));
  return wrapper;
}

function buildActionButton(key, title, img, callback) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `control-icon fallout-maw-token-equipment-hud-action ${key}`;
  button.dataset.tooltip = title;
  button.setAttribute("aria-label", title);
  const image = document.createElement("img");
  image.src = img;
  image.alt = "";
  image.draggable = false;
  button.append(image);
  button.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    void callback();
  });
  return button;
}

async function openSearchForHudTarget(targetToken) {
  const searcherActor = getControlledOwnerActor();
  const searchedActor = targetToken?.actor ?? null;
  if (!searcherActor || !searchedActor) return;
  await openSearchInventoryWindow({ searcherActor, searchedActor });
}

async function requestTradeForHudTarget(targetToken) {
  const traderActor = getControlledOwnerActor();
  const tradeActor = targetToken?.actor ?? null;
  if (!traderActor || !tradeActor) return;
  await requestTradeInventoryWindow({ traderActor, tradeActor });
}

function getControlledOwnerActor() {
  const token = canvas?.tokens?.controlled?.find(entry => entry?.actor?.isOwner) ?? null;
  const actor = token?.actor ?? null;
  if (!actor) {
    ui.notifications.warn("Выберите свой токен, который будет взаимодействовать с целью.");
    return null;
  }
  return actor;
}

function hideDefaultTokenHudControls(element) {
  element.querySelector(".col.middle")?.classList.add("fallout-maw-token-equipment-hud-hidden");
  element.querySelectorAll(".control-icon").forEach(node => {
    if (node.closest(`.${HUD_BLOCK_CLASS}, .${HUD_ACTIONS_CLASS}`)) return;
    node.classList.add("fallout-maw-token-equipment-hud-hidden");
  });
  element.querySelectorAll(".attribute").forEach(node => {
    node.classList.add("fallout-maw-token-equipment-hud-hidden");
  });
}

function refreshTokenEquipmentHudForActor(actor) {
  const hudActor = canvas?.hud?.token?.object?.actor ?? null;
  if (hudActor?.uuid !== actor?.uuid) return;
  refreshTokenEquipmentHud();
}

function refreshTokenEquipmentHudForItem(item) {
  if (!item?.actor) return;
  refreshTokenEquipmentHudForActor(item.actor);
}

function refreshTokenEquipmentHudForTokenDocument(tokenDocument) {
  const hudToken = canvas?.hud?.token?.object ?? null;
  if (hudToken?.document?.uuid !== tokenDocument?.uuid) return;
  refreshTokenEquipmentHud();
}

function refreshBoundTokenHud(token) {
  if (canvas?.hud?.token?.object?.id !== token?.id) return;
  refreshTokenEquipmentHud();
}

function refreshTokenEquipmentHud() {
  const hud = canvas?.hud?.token;
  if (!hud?.object) return;
  window.setTimeout(() => {
    if (!hud.object) return;
    void hud.render({ force: true, position: true });
  }, 0);
}
