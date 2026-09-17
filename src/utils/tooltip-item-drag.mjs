import { FalloutMaWDragDrop } from "./drag-drop.mjs";

const registeredDocuments = new WeakSet();

/** Use document references where available; installed module snapshots remain copies. */
export function getTooltipItemDragData(item, user = globalThis.game?.user) {
  if (!user?.isGM || !item?.system) return null;
  if (typeof item.toDragData === "function") {
    const payload = item.toDragData();
    if (payload?.type === "Item" && payload.uuid) return payload;
  }
  if (!item.type || !item.name) return null;
  const data = typeof item.toObject === "function" ? item.toObject() : structuredClone(item);
  delete data._id;
  return { type: "Item", data };
}

/** Delegate so refreshed, nested, and locked tooltip copies work without rebinding. */
export function registerTooltipItemDrag(documentRoot = globalThis.document) {
  if (!documentRoot || registeredDocuments.has(documentRoot)) return;
  registeredDocuments.add(documentRoot);
  let suppressClick = false;
  const controller = new FalloutMaWDragDrop({
    permissions: { dragstart: () => Boolean(globalThis.game?.user?.isGM) },
    callbacks: {
      dragstart: event => {
        if (!globalThis.game?.user?.isGM) return;
        let payload;
        try { payload = JSON.parse(event.currentTarget.dataset.tooltipDragItem); }
        catch { return; }
        if (payload?.type !== "Item" || (!payload.uuid && !payload.data?.system)) return;
        const serialized = JSON.stringify(payload);
        event.dataTransfer.setData("application/json", serialized);
        event.dataTransfer.setData("text/plain", serialized);
        event.dataTransfer.effectAllowed = "copy";
        suppressClick = true;
        documentRoot.body?.classList.add("fallout-maw-tooltip-item-dragging");
        // Tooltips may close as the pointer leaves; the drag retains its own payload.
        globalThis.game?.tooltip?.deactivate?.();
      },
      dragend: () => {
        documentRoot.body?.classList.remove("fallout-maw-tooltip-item-dragging");
        (documentRoot.defaultView ?? globalThis.window).setTimeout(() => { suppressClick = false; }, 0);
      }
    }
  });
  documentRoot.addEventListener("pointerdown", event => {
    if (event.button !== 0 || !globalThis.game?.user?.isGM) return;
    const source = event.target?.closest?.("[data-tooltip-drag-item]");
    if (!source) return;
    // Prevent a surrounding inventory item from starting a second drag.
    event.stopImmediatePropagation();
    controller.startPointerDrag(event, source);
  }, true);
  documentRoot.addEventListener("click", event => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}
