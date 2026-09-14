import { isSameContentsZone, transferOwnedInventoryContents } from "../inventory/contents-transfer.mjs";
import { InventoryRenderBatch, runInventoryRenderBatch, registerInventoryRenderView, unregisterInventoryRenderView } from "./inventory-render-batch.mjs";

const views = new Set();
let selection = null;
let inProgress = false;
let listenerDocument = null;

/** One selection across the open sheets, container windows, search and craft. */
export class InventoryTransferMode {
  renderBatch = new InventoryRenderBatch();
  root = null;
  zones = [];
  options = null;

  bind(root, options) {
    this.root = root;
    this.options = options;
    this.zones = [];
    if (!root) return;
    views.add(this);
    registerInventoryRenderView(this);
    if (!listenerDocument) {
      listenerDocument = root.ownerDocument;
      listenerDocument.addEventListener("click", onClick, true);
      listenerDocument.addEventListener("contextmenu", onCancel, true);
      listenerDocument.addEventListener("keydown", onKeyDown, true);
      listenerDocument.addEventListener("dragstart", onDragStart, true);
      for (const type of ["mouseover", "pointerover", "mouseenter", "pointerenter"]) {
        listenerDocument.addEventListener(type, onPointerEnter, true);
      }
    }
    for (const element of root.querySelectorAll("[data-contents-transfer-zone]")) {
      const actor = options.getActor(element.dataset.searchActorUuid);
      if (!actor) continue;
      const zone = {
        actor, parentId: element.dataset.inventoryParentId ?? "",
        kind: element.dataset.contentsTransferZone || "inventory", element, view: this
      };
      const title = element.querySelector("[data-contents-transfer-title]");
      if (!title) continue;
      let highlight = element.querySelector(":scope > .fallout-maw-contents-transfer-highlight");
      if (!highlight) {
        highlight = root.ownerDocument.createElement("div");
        highlight.className = "fallout-maw-contents-transfer-highlight";
        highlight.setAttribute("aria-hidden", "true");
        element.append(highlight);
      }
      this.zones.push(zone);
      if (zone.kind !== "offer") {
        title.classList.add("fallout-maw-contents-transfer-heading");
        let button = title.querySelector("[data-contents-transfer-button]");
        if (!button) {
          button = root.ownerDocument.createElement("button");
          button.type = "button";
          button.dataset.contentsTransferButton = "";
          button.dataset.tooltipIgnore = "";
          button.className = "fallout-maw-contents-transfer-button";
          button.textContent = "⇄";
          button.title = "Перенести содержимое: выберите место ЛКМ; ПКМ — отмена";
          button.setAttribute("aria-label", "Перенести содержимое");
          title.append(button);
        }
        zone.button = button;
      }
    }
    if (selection?.view === this) {
      selection = this.zones.find(zone => isSameContentsZone(zone, selection)) ?? null;
    }
    refresh();
  }

  destroy() {
    if (selection?.view === this) selection = null;
    views.delete(this);
    unregisterInventoryRenderView(this);
    this.root = null;
    this.zones = [];
    refresh();
    if (!views.size && listenerDocument) {
      listenerDocument.removeEventListener("click", onClick, true);
      listenerDocument.removeEventListener("contextmenu", onCancel, true);
      listenerDocument.removeEventListener("keydown", onKeyDown, true);
      listenerDocument.removeEventListener("dragstart", onDragStart, true);
      for (const type of ["mouseover", "pointerover", "mouseenter", "pointerenter"]) {
        listenerDocument.removeEventListener(type, onPointerEnter, true);
      }
      listenerDocument = null;
    }
  }
}

function zones() { return [...views].flatMap(view => view.zones); }
function available(source, target) {
  return Boolean(source.view.root?.isConnected && target.view.root?.isConnected)
    && !isSameContentsZone(source, target) && target.view.options.canUse(target)
    && source.view.options.canTransfer(source, target);
}
function refresh() {
  for (const zone of zones()) {
    zone.element.classList.toggle("contents-transfer-source", Boolean(selection && isSameContentsZone(zone, selection)));
    zone.element.classList.toggle("contents-transfer-target", Boolean(selection && available(selection, zone)));
    zone.element.classList.toggle("contents-transfer-pending", inProgress);
    if (zone.button) {
      zone.button.disabled = inProgress || !zone.view.options.canUse(zone);
      zone.button.setAttribute("aria-pressed", String(Boolean(selection && isSameContentsZone(zone, selection))));
    }
  }
}
function consume(event) { event.preventDefault(); event.stopImmediatePropagation(); }
function cancel() { selection = null; refresh(); }
function onCancel(event) { if (selection) { consume(event); cancel(); } }
function onKeyDown(event) { if (event.key === "Escape" && selection) { consume(event); cancel(); } }
function onDragStart(event) { if (selection || inProgress) consume(event); }
function onPointerEnter(event) {
  if (selection && [...views].some(view => view.root?.contains(event.target))) event.stopImmediatePropagation();
}

function onClick(event) {
  const element = event.target?.closest?.("[data-contents-transfer-zone]");
  const zone = zones().find(entry => entry.element === element);
  if (!zone) return;
  const button = event.target.closest("[data-contents-transfer-button]");
  if (inProgress) { consume(event); return; }
  if (button) {
    consume(event);
    if (!zone.view.options.canUse(zone)) return;
    selection = selection && isSameContentsZone(zone, selection) ? null : zone;
    zone.view.options.onSelect?.();
    refresh();
    return;
  }
  if (!selection) return;
  consume(event);
  if (!available(selection, zone)) return;
  const source = selection;
  selection = null;
  inProgress = true;
  refresh();
  const actorUuids = new Set([source.actor.uuid, zone.actor.uuid]);
  const affectedViews = [...views].filter(view => view.zones.some(entry => actorUuids.has(entry.actor.uuid)));
  void runInventoryRenderBatch(affectedViews.map(view => ({
    batch: view.renderBatch, application: view.options.application,
    before: view.options.beforeTransfer, after: view.options.afterTransfer
  })), () => (source.view.options.transfer ?? transferOwnedInventoryContents)({ source, target: zone })).then(result => {
    if (result.failed) ui.notifications.warn(`Перенесено стопок: ${result.moved}. Осталось на месте: ${result.failed}.${result.errors.length ? ` ${result.errors[0]}` : ""}`);
    else if (!result.moved) ui.notifications.info("Нечего переносить.");
  }).catch(error => ui.notifications.error(error.message || "Не удалось перенести содержимое."))
    .finally(() => { inProgress = false; refresh(); });
}
