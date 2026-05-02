import { getHtmlRoot } from "../utils/dom.mjs";

export function activateSettingsReorder(html, rowSelector = ".fallout-maw-settings-row") {
  const root = getHtmlRoot(html);
  if (!root) return;

  let draggedRow = null;
  let dragContainer = null;
  let activePointerId = null;

  const stopDragging = () => {
    draggedRow?.classList.remove("dragging");
    draggedRow = null;
    dragContainer = null;
    activePointerId = null;
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
    document.removeEventListener("pointercancel", onPointerUp);
  };

  const onPointerMove = event => {
    if (!draggedRow || event.pointerId !== activePointerId) return;

    const targetRow = document.elementFromPoint(event.clientX, event.clientY)?.closest(rowSelector);
    if (!targetRow || targetRow === draggedRow || targetRow.parentElement !== dragContainer) return;

    event.preventDefault();
    const rect = targetRow.getBoundingClientRect();
    const insertBefore = event.clientY < rect.top + rect.height / 2;
    dragContainer.insertBefore(draggedRow, insertBefore ? targetRow : targetRow.nextSibling);
  };

  const onPointerUp = event => {
    if (event.pointerId !== activePointerId) return;
    stopDragging();
  };

  root.addEventListener("pointerdown", event => {
    const handle = event.target.closest("[data-drag-handle]");
    if (!handle) return;

    draggedRow = handle.closest(rowSelector);
    if (!draggedRow) return;

    event.preventDefault();
    dragContainer = draggedRow.parentElement;
    activePointerId = event.pointerId;
    draggedRow.classList.add("dragging");

    handle.setPointerCapture?.(event.pointerId);
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerUp);
  });
}
