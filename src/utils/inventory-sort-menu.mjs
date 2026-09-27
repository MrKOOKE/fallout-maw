import { localize as auditLocalize } from "./i18n.mjs";
import { INVENTORY_SORT_CHOICES } from "../inventory/contents-sort.mjs";

/** A native, nonmodal dropdown in the top layer, anchored to its compact button. */
export class InventorySortMenu {
  constructor(title, transferButton, { canUse, onOpen, onSort }) {
    const document = title.ownerDocument;
    const controls = document.createElement("span");
    controls.className = "fallout-maw-container-controls";
    controls.dataset.inventorySortControl = "";
    controls.addEventListener("pointerdown", event => event.stopPropagation());
    title.append(controls);
    controls.append(transferButton);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "fallout-maw-inventory-sort-button";
    button.dataset.inventorySortControl = "";
    button.dataset.tooltipIgnore = "";
    button.textContent = "≡";
    button.title = auditLocalize("FALLOUTMAW.AuditRuntime.R1300", "Сортировка");
    button.setAttribute("aria-label", auditLocalize("FALLOUTMAW.AuditRuntime.R1301", "Сортировка содержимого"));
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    controls.prepend(button);
    const menu = document.createElement("div");
    menu.className = "fallout-maw-inventory-sort-menu";
    menu.dataset.inventorySortControl = "";
    menu.setAttribute("popover", "auto");
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", auditLocalize("FALLOUTMAW.AuditRuntime.R1300", "Сортировка"));
    menu.addEventListener("pointerdown", event => event.stopPropagation());
    title.append(menu);
    button.popoverTargetElement = menu;
    for (const choice of INVENTORY_SORT_CHOICES) {
      const option = document.createElement("button");
      option.type = "button";
      option.textContent = choice.label;
      option.setAttribute("role", "menuitem");
      option.addEventListener("click", event => {
        event.preventDefault(); event.stopPropagation();
        if (!canUse()) return;
        menu.hidePopover();
        onSort(choice.key);
      });
      menu.append(option);
    }
    button.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      if (!canUse()) return;
      onOpen();
      if (menu.matches(":popover-open")) { menu.hidePopover(); return; }
      const view = document.defaultView;
      const rect = button.getBoundingClientRect();
      menu.style.maxWidth = `${Math.max(0, view.innerWidth - 16)}px`;
      menu.showPopover();
      const bounds = { width: menu.offsetWidth, height: menu.offsetHeight };
      const above = rect.bottom + bounds.height + 6 > view.innerHeight - 8;
      menu.style.left = `${Math.max(8, Math.min(rect.right - bounds.width, view.innerWidth - bounds.width - 8))}px`;
      menu.style.top = `${Math.max(8, above ? rect.top - bounds.height - 6 : rect.bottom + 6)}px`;
      menu.dataset.direction = above ? "up" : "down";
      menu.querySelector("button")?.focus();
    });
    menu.addEventListener("toggle", event => button.setAttribute("aria-expanded", String(event.newState === "open")));
    menu.addEventListener("keydown", event => {
      const buttons = [...menu.querySelectorAll("button")];
      const index = buttons.indexOf(document.activeElement);
      let next;
      if (event.key === "ArrowDown") next = (index + 1) % buttons.length;
      if (event.key === "ArrowUp") next = (index - 1 + buttons.length) % buttons.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = buttons.length - 1;
      if (next === undefined) return;
      event.preventDefault(); event.stopPropagation(); buttons[next].focus();
    });
    this.button = button; this.menu = menu; this.controls = controls; this.transferButton = transferButton;
  }

  destroy() {
    if (this.menu.matches(":popover-open")) this.menu.hidePopover();
    this.controls.before(this.transferButton);
    this.controls.remove(); this.menu.remove();
  }
}
