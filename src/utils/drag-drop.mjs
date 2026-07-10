import { INVENTORY_DRAG_ROTATION_KEY } from "./inventory-rotation.mjs";
import { getItemFootprint } from "./inventory-containers.mjs";

const POINTER_DRAG_SELECTOR = ".fallout-maw-draggable-item[data-item-id]";
const POINTER_DRAG_THRESHOLD = 4;
const POINTER_DROP_CONTROLLERS = new WeakMap();

export class FalloutMaWDragDrop extends foundry.applications.ux.DragDrop {
  static #payload = null;
  static #lastDragOver = null;
  static #keyDocument = null;
  static #pointerSession = null;
  static #keyHandler = event => {
    if (event.code !== "KeyR" || event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;
    const data = FalloutMaWDragDrop.#payload?.data;
    if (data?.type !== "Item") return;

    data[INVENTORY_DRAG_ROTATION_KEY] = !Boolean(data[INVENTORY_DRAG_ROTATION_KEY]);
    event.preventDefault();
    event.stopImmediatePropagation();
    FalloutMaWDragDrop.#syncPointerDragPreview();

    const hovered = FalloutMaWDragDrop.#lastDragOver;
    if (hovered?.event?.target?.isConnected !== false) hovered?.controller?.callback?.(hovered.event, "dragover");
  };

  /** @override */
  bind(html) {
    super.bind(html);

    const canDrop = this.can("drop", this.dropSelector);
    const droppables = !this.dropSelector || html.matches(this.dropSelector)
      ? [html]
      : html.querySelectorAll(this.dropSelector);
    if (canDrop) {
      for (const element of droppables) POINTER_DROP_CONTROLLERS.set(element, this);
    }

    const canDrag = Boolean(this.dragSelector) && this.can("dragstart", this.dragSelector);
    const draggables = this.dragSelector ? html.querySelectorAll(this.dragSelector) : [];
    for (const element of draggables) {
      if (!element.matches(POINTER_DRAG_SELECTOR)) continue;
      if (!canDrag) {
        element.onpointerdown = null;
        continue;
      }
      element.draggable = false;
      element.ondragstart = null;
      element.ondragend = null;
      element.querySelectorAll("img").forEach(image => { image.draggable = false; });
      element.onpointerdown = this.#handlePointerDown.bind(this);
    }
    return this;
  }

  /** @override */
  async _handleDragStart(event) {
    await this.callback(event, "dragstart");
    if (event.dataTransfer?.items?.length) {
      event.stopPropagation();
      FalloutMaWDragDrop.#cachePayload(event);
      FalloutMaWDragDrop.#bindRotationKey(event);
    } else {
      FalloutMaWDragDrop.#clearRuntimeState();
    }
  }

  /** @override */
  _handleDragOver(event) {
    FalloutMaWDragDrop.#lastDragOver = { controller: this, event };
    return super._handleDragOver(event);
  }

  /** @override */
  _handleDrop(event) {
    try {
      return super._handleDrop(event);
    } finally {
      FalloutMaWDragDrop.#lastDragOver = null;
      FalloutMaWDragDrop.#unbindRotationKey();
    }
  }

  /** @override */
  async _handleDragEnd(event) {
    await this.callback(event, "dragend");
    FalloutMaWDragDrop.#clearRuntimeState();
  }

  static getPayload() {
    return FalloutMaWDragDrop.#payload?.data ?? null;
  }

  #handlePointerDown(event) {
    if (event.button !== 0 || FalloutMaWDragDrop.#pointerSession) return;
    const source = event.currentTarget;
    if (!source?.matches?.(POINTER_DRAG_SELECTOR)) return;

    const session = {
      sourceController: this,
      source,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastPointer: event,
      dataTransfer: new MemoryDataTransfer(),
      started: false,
      starting: false,
      releasedEvent: null,
      targetController: null,
      targetElement: null,
      targetPointElement: null,
      preview: null,
      previewInitialRotated: false,
      previewWidth: 0,
      previewHeight: 0,
      previewInset: 0,
      previewItemData: null,
      previewItems: null,
      previewGridMetrics: null
    };
    session.moveHandler = pointerEvent => { void FalloutMaWDragDrop.#handlePointerMove(pointerEvent); };
    session.upHandler = pointerEvent => { void FalloutMaWDragDrop.#handlePointerUp(pointerEvent); };
    session.cancelHandler = pointerEvent => { void FalloutMaWDragDrop.#handlePointerCancel(pointerEvent); };
    FalloutMaWDragDrop.#pointerSession = session;

    source.setPointerCapture?.(event.pointerId);
    source.addEventListener("pointermove", session.moveHandler);
    source.addEventListener("pointerup", session.upHandler);
    source.addEventListener("pointercancel", session.cancelHandler);
  }

  static async #handlePointerMove(event) {
    const session = FalloutMaWDragDrop.#pointerSession;
    if (!session || event.pointerId !== session.pointerId) return;
    session.lastPointer = event;

    if (!session.started && !session.starting) {
      const distance = Math.hypot(event.clientX - session.startX, event.clientY - session.startY);
      if (distance < POINTER_DRAG_THRESHOLD) return;
      await FalloutMaWDragDrop.#startPointerDrag(session, event);
    }
    if (FalloutMaWDragDrop.#pointerSession !== session || !session.started) return;

    event.preventDefault();
    FalloutMaWDragDrop.#positionPointerDragPreview(event);
    FalloutMaWDragDrop.#dispatchPointerDragOver(session, event);
  }

  static async #startPointerDrag(session, event) {
    session.starting = true;
    const dragStartEvent = createPointerDragEvent("dragstart", event, session, session.source, session.source);
    try {
      await session.sourceController.callback(dragStartEvent, "dragstart");
    } catch (error) {
      console.error("fallout-maw | Inventory pointer drag start failed", error);
      FalloutMaWDragDrop.#cleanupPointerSession(session);
      return;
    }
    if (FalloutMaWDragDrop.#pointerSession !== session) return;

    FalloutMaWDragDrop.#cachePayload(dragStartEvent);
    if (!FalloutMaWDragDrop.#payload) {
      FalloutMaWDragDrop.#cleanupPointerSession(session);
      return;
    }
    session.started = true;
    session.starting = false;
    FalloutMaWDragDrop.#bindRotationKey(dragStartEvent);
    FalloutMaWDragDrop.#createPointerDragPreview(session);
    FalloutMaWDragDrop.#positionPointerDragPreview(event);
    FalloutMaWDragDrop.#dispatchPointerDragOver(session, event);

    if (session.releasedEvent) await FalloutMaWDragDrop.#completePointerDrag(session, session.releasedEvent, { drop: true });
  }

  static async #handlePointerUp(event) {
    const session = FalloutMaWDragDrop.#pointerSession;
    if (!session || event.pointerId !== session.pointerId) return;
    session.lastPointer = event;
    if (session.starting && !session.started) {
      session.releasedEvent = event;
      return;
    }
    if (!session.started) {
      FalloutMaWDragDrop.#cleanupPointerSession(session);
      return;
    }
    event.preventDefault();
    await FalloutMaWDragDrop.#completePointerDrag(session, event, { drop: true });
  }

  static async #handlePointerCancel(event) {
    const session = FalloutMaWDragDrop.#pointerSession;
    if (!session || event.pointerId !== session.pointerId) return;
    if (!session.started) {
      FalloutMaWDragDrop.#cleanupPointerSession(session);
      return;
    }
    await FalloutMaWDragDrop.#completePointerDrag(session, event, { drop: false });
  }

  static #dispatchPointerDragOver(session, pointerEvent) {
    const target = findPointerDropTarget(pointerEvent);
    if (!target) {
      FalloutMaWDragDrop.#dispatchPointerDragLeave(session, pointerEvent);
      FalloutMaWDragDrop.#lastDragOver = null;
      return;
    }

    if (target.controller !== session.targetController || target.element !== session.targetElement) {
      FalloutMaWDragDrop.#dispatchPointerDragLeave(session, pointerEvent);
      const enterEvent = createPointerDragEvent("dragenter", pointerEvent, session, target.pointElement, target.element);
      target.controller._handleDragEnter(enterEvent);
    }

    session.targetController = target.controller;
    session.targetElement = target.element;
    session.targetPointElement = target.pointElement;
    const dragOverEvent = createPointerDragEvent("dragover", pointerEvent, session, target.pointElement, target.element);
    target.controller._handleDragOver(dragOverEvent);
  }

  static #dispatchPointerDragLeave(session, pointerEvent) {
    if (!session.targetController || !session.targetElement) return;
    const leaveEvent = createPointerDragEvent(
      "dragleave",
      pointerEvent,
      session,
      session.targetPointElement ?? session.targetElement,
      session.targetElement
    );
    session.targetController._handleDragLeave(leaveEvent);
    session.targetController = null;
    session.targetElement = null;
    session.targetPointElement = null;
  }

  static async #completePointerDrag(session, pointerEvent, { drop = false } = {}) {
    if (FalloutMaWDragDrop.#pointerSession !== session) return;
    FalloutMaWDragDrop.#dispatchPointerDragOver(session, pointerEvent);
    const targetController = session.targetController;
    const targetElement = session.targetElement;
    const pointElement = session.targetPointElement;

    try {
      if (drop && targetController && targetElement) {
        const dropEvent = createPointerDragEvent("drop", pointerEvent, session, pointElement ?? targetElement, targetElement);
        await targetController._handleDrop(dropEvent);
      }
    } catch (error) {
      console.error("fallout-maw | Inventory pointer drop failed", error);
    } finally {
      const dragEndEvent = createPointerDragEvent("dragend", pointerEvent, session, session.source, session.source);
      try {
        await session.sourceController._handleDragEnd(dragEndEvent);
      } finally {
        FalloutMaWDragDrop.#cleanupPointerSession(session);
      }
    }
  }

  static #cachePayload(event) {
    let data = event.dataTransfer?.getData("application/json") || event.dataTransfer?.getData("text/plain");
    try {
      data = JSON.parse(data);
    } catch (_error) {
      data = null;
    }
    if (data?.type === "Item") data[INVENTORY_DRAG_ROTATION_KEY] = resolveInitialItemRotation(data);
    FalloutMaWDragDrop.#payload = data ? { event, data } : null;
  }

  static #bindRotationKey(event) {
    const keyDocument = event?.currentTarget?.ownerDocument ?? event?.target?.ownerDocument ?? globalThis.document;
    if (!keyDocument || FalloutMaWDragDrop.#keyDocument === keyDocument) return;
    FalloutMaWDragDrop.#unbindRotationKey();
    FalloutMaWDragDrop.#keyDocument = keyDocument;
    keyDocument.addEventListener("keydown", FalloutMaWDragDrop.#keyHandler, { capture: true });
  }

  static #unbindRotationKey() {
    FalloutMaWDragDrop.#keyDocument?.removeEventListener?.("keydown", FalloutMaWDragDrop.#keyHandler, { capture: true });
    FalloutMaWDragDrop.#keyDocument = null;
  }

  static #createPointerDragPreview(session) {
    const preview = session.source.cloneNode(true);
    const rect = session.source.getBoundingClientRect();
    preview.removeAttribute("id");
    preview.classList.remove("dragging");
    preview.classList.add("fallout-maw-pointer-drag-preview");
    preview.querySelectorAll("[id]").forEach(element => element.removeAttribute("id"));
    session.preview = preview;
    session.previewInitialRotated = session.source.classList.contains("rotated");
    session.previewWidth = rect.width;
    session.previewHeight = rect.height;
    const previewItem = resolvePointerDragItem(FalloutMaWDragDrop.#payload?.data);
    session.previewItemData = previewItem?.itemData ?? null;
    session.previewItems = previewItem?.items ?? null;
    session.previewGridMetrics = getPointerInventoryGridMetrics(session.source);
    const view = session.source.ownerDocument?.defaultView ?? globalThis.window;
    const rootFontSize = Number.parseFloat(view?.getComputedStyle?.(session.source.ownerDocument?.documentElement)?.fontSize);
    session.previewInset = Math.max(0, (Number.isFinite(rootFontSize) ? rootFontSize : 16) * 0.2);
    session.source.ownerDocument?.body?.append(preview);
    FalloutMaWDragDrop.#syncPointerDragPreview();
  }

  static #syncPointerDragPreview() {
    const session = FalloutMaWDragDrop.#pointerSession;
    const preview = session?.preview;
    if (!session || !preview) return;
    const rotated = Boolean(FalloutMaWDragDrop.#payload?.data?.[INVENTORY_DRAG_ROTATION_KEY]);
    const swapsDimensions = rotated !== session.previewInitialRotated;
    const footprint = getPointerDragFootprint(session, rotated);
    const metrics = session.previewGridMetrics;
    const width = footprint && metrics
      ? getPointerDragSpanSize(footprint.width, metrics.cellWidth, metrics.columnGap)
      : (swapsDimensions ? session.previewHeight : session.previewWidth);
    const height = footprint && metrics
      ? getPointerDragSpanSize(footprint.height, metrics.cellHeight, metrics.rowGap)
      : (swapsDimensions ? session.previewWidth : session.previewHeight);
    const imageWidth = Math.max(1, (rotated ? height : width) - (session.previewInset * 2));
    const imageHeight = Math.max(1, (rotated ? width : height) - (session.previewInset * 2));
    preview.classList.toggle("rotated", rotated);
    preview.style.width = `${width}px`;
    preview.style.height = `${height}px`;
    preview.style.setProperty("--fallout-maw-pointer-drag-image-inset", `${session.previewInset}px`);
    preview.style.setProperty("--fallout-maw-pointer-drag-image-width", `${imageWidth}px`);
    preview.style.setProperty("--fallout-maw-pointer-drag-image-height", `${imageHeight}px`);
  }

  static #positionPointerDragPreview(event) {
    const preview = FalloutMaWDragDrop.#pointerSession?.preview;
    if (!preview) return;
    preview.style.left = `${event.clientX + 14}px`;
    preview.style.top = `${event.clientY + 14}px`;
  }

  static #cleanupPointerSession(session) {
    if (!session) return;
    session.source.removeEventListener("pointermove", session.moveHandler);
    session.source.removeEventListener("pointerup", session.upHandler);
    session.source.removeEventListener("pointercancel", session.cancelHandler);
    if (session.source.hasPointerCapture?.(session.pointerId)) session.source.releasePointerCapture(session.pointerId);
    session.preview?.remove();
    if (FalloutMaWDragDrop.#pointerSession === session) FalloutMaWDragDrop.#pointerSession = null;
    FalloutMaWDragDrop.#clearRuntimeState();
  }

  static #clearRuntimeState() {
    FalloutMaWDragDrop.#payload = null;
    FalloutMaWDragDrop.#lastDragOver = null;
    FalloutMaWDragDrop.#unbindRotationKey();
  }
}

class MemoryDataTransfer {
  #data = new Map();

  dropEffect = "none";
  effectAllowed = "uninitialized";
  files = [];

  get items() {
    return Array.from(this.#data.keys(), type => ({ kind: "string", type }));
  }

  get types() {
    return Array.from(this.#data.keys());
  }

  setData(type, value) {
    this.#data.set(String(type), String(value));
  }

  getData(type) {
    return this.#data.get(String(type)) ?? "";
  }

  clearData(type = null) {
    if (type === null) this.#data.clear();
    else this.#data.delete(String(type));
  }

  setDragImage() {}
}

function createPointerDragEvent(type, pointerEvent, session, target, currentTarget) {
  let defaultPrevented = false;
  return {
    type,
    target,
    currentTarget,
    relatedTarget: null,
    dataTransfer: session.dataTransfer,
    clientX: Number(pointerEvent?.clientX) || 0,
    clientY: Number(pointerEvent?.clientY) || 0,
    screenX: Number(pointerEvent?.screenX) || 0,
    screenY: Number(pointerEvent?.screenY) || 0,
    button: Number(pointerEvent?.button) || 0,
    buttons: Number(pointerEvent?.buttons) || 0,
    altKey: Boolean(pointerEvent?.altKey),
    ctrlKey: Boolean(pointerEvent?.ctrlKey),
    metaKey: Boolean(pointerEvent?.metaKey),
    shiftKey: Boolean(pointerEvent?.shiftKey),
    pointerId: session.pointerId,
    originalEvent: pointerEvent,
    get defaultPrevented() { return defaultPrevented; },
    preventDefault() { defaultPrevented = true; pointerEvent?.preventDefault?.(); },
    stopPropagation() { pointerEvent?.stopPropagation?.(); },
    stopImmediatePropagation() { pointerEvent?.stopImmediatePropagation?.(); }
  };
}

function findPointerDropTarget(event) {
  const document = event?.currentTarget?.ownerDocument ?? event?.target?.ownerDocument ?? globalThis.document;
  const pointElement = document?.elementFromPoint?.(event.clientX, event.clientY) ?? null;
  for (let element = pointElement; element; element = element.parentElement) {
    const controller = POINTER_DROP_CONTROLLERS.get(element);
    if (controller) return { controller, element, pointElement };
  }
  return null;
}

function resolvePointerDragItem(data = null) {
  if (data?.type !== "Item") return null;
  let item = data.uuid ? foundry.utils.fromUuidSync(data.uuid) : null;
  if (!item && data.sourceActorUuid && data.itemId) {
    const actor = foundry.utils.fromUuidSync(data.sourceActorUuid);
    item = actor?.items?.get?.(String(data.itemId)) ?? null;
  }
  if (!item?.toObject) return null;
  return {
    itemData: item.toObject(),
    items: item.parent?.items ?? null
  };
}

function getPointerDragFootprint(session, rotated) {
  if (!session?.previewItemData) return null;
  const itemData = foundry.utils.deepClone(session.previewItemData);
  foundry.utils.setProperty(itemData, "system.placement.rotated", Boolean(rotated));
  return getItemFootprint(itemData, session.previewItems);
}

function getPointerInventoryGridMetrics(source) {
  const root = source?.closest?.(".application") ?? source?.ownerDocument;
  const grids = Array.from(root?.querySelectorAll?.("[data-inventory-grid]") ?? []);
  const view = source?.ownerDocument?.defaultView ?? globalThis.window;
  for (const grid of grids) {
    const rect = grid.getBoundingClientRect();
    const layoutWidth = Number(grid.offsetWidth);
    if (!(rect.width > 0) || !(layoutWidth > 0)) continue;
    const styles = view?.getComputedStyle?.(grid);
    const columns = readPositiveInteger(
      grid.style?.getPropertyValue?.("--fallout-maw-inventory-columns")
      || styles?.getPropertyValue?.("--fallout-maw-inventory-columns")
    );
    if (!columns) continue;
    const scale = rect.width / layoutWidth;
    const columnGap = Math.max(0, Number.parseFloat(styles?.columnGap ?? styles?.gap) || 0);
    const rowGap = Math.max(0, Number.parseFloat(styles?.rowGap ?? styles?.gap) || columnGap);
    const cellWidth = Math.max(1, (layoutWidth - (columnGap * Math.max(0, columns - 1))) / columns);
    return {
      cellWidth: cellWidth * scale,
      cellHeight: cellWidth * scale,
      columnGap: columnGap * scale,
      rowGap: rowGap * scale
    };
  }
  return null;
}

function getPointerDragSpanSize(span, cellSize, gap) {
  span = Math.max(1, readPositiveInteger(span) || 1);
  return (span * cellSize) + (Math.max(0, span - 1) * gap);
}

function readPositiveInteger(value) {
  const number = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function resolveInitialItemRotation(data = {}) {
  if (Object.hasOwn(data, INVENTORY_DRAG_ROTATION_KEY)) return Boolean(data[INVENTORY_DRAG_ROTATION_KEY]);
  const embeddedData = data?.data ?? data;
  const embeddedRotation = foundry.utils.getProperty(embeddedData, "system.placement.rotated");
  if (embeddedRotation !== undefined) return Boolean(embeddedRotation);

  const item = data.uuid ? foundry.utils.fromUuidSync(data.uuid) : null;
  return Boolean(item?.system?.placement?.rotated);
}
