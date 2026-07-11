/** Activate one weapon-function tab using the shared inventory-tooltip contract. */
export function activateInventoryTooltipTab(root, index = 0) {
  if (!root) return;
  const activeIndex = Math.max(0, Math.trunc(Number(index) || 0));
  root.querySelectorAll("[data-tooltip-weapon-tab]").forEach(button => {
    const active = Math.trunc(Number(button.dataset.tooltipWeaponTab) || 0) === activeIndex;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  root.querySelectorAll("[data-tooltip-weapon-panel]").forEach(panel => {
    panel.classList.toggle("active", Math.trunc(Number(panel.dataset.tooltipWeaponPanel) || 0) === activeIndex);
  });
}
