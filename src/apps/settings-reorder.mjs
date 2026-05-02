import { getHtmlRoot } from "../utils/dom.mjs";

export function activateSettingsReorder(html, rowSelector = ".fallout-maw-settings-row") {
  const root = getHtmlRoot(html);
  if (!root) return;

  let draggedRow = null;

  root.addEventListener("dragstart", event => {
    const handle = event.target.closest("[data-drag-handle]");
    if (!handle) return;

    draggedRow = handle.closest(rowSelector);
    if (!draggedRow) return;

    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", "");
    draggedRow.classList.add("dragging");
  });

  root.addEventListener("dragend", () => {
    draggedRow?.classList.remove("dragging");
    draggedRow = null;
  });

  root.addEventListener("dragover", event => {
    if (!draggedRow) return;

    const targetRow = event.target.closest(rowSelector);
    if (!targetRow || targetRow === draggedRow || !root.contains(targetRow)) return;

    event.preventDefault();
    const rect = targetRow.getBoundingClientRect();
    const insertBefore = event.clientY < rect.top + rect.height / 2;
    targetRow.parentElement.insertBefore(draggedRow, insertBefore ? targetRow : targetRow.nextSibling);
  });
}
