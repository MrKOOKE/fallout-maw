const DEFAULT_SHOW_DELAY_MS = 400;
const REPOSITION_SHOW_DELAY_MS = 200;
const HIDE_DELAY_MS = 200;

/**
 * Shared hover popover used by limb silhouettes and fallback limb cards.
 */
export class LimbPopoverController {
  constructor() {
    this.element = null;
    this.showTimer = null;
    this.hideTimer = null;
    this.hoveredPart = null;
    this.boundRoot = null;
    this.ownerRoot = null;
    this.view = null;
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerLeave = this._onPointerLeave.bind(this);
  }

  bind(root, ownerRoot = root) {
    if (!root) {
      this.destroy();
      return;
    }
    if (root === this.boundRoot && ownerRoot === this.ownerRoot) return;

    this.destroy();
    this.boundRoot = root;
    this.ownerRoot = ownerRoot;
    this.view = root.ownerDocument?.defaultView ?? globalThis.window;
    root.addEventListener("pointermove", this._onPointerMove);
    root.addEventListener("pointerleave", this._onPointerLeave);
  }

  sync(ownerRoot = this.ownerRoot) {
    if (!this.element) return;
    if (
      !this.hoveredPart?.isConnected
      || (ownerRoot && !ownerRoot.contains?.(this.hoveredPart))
    ) this.destroy();
  }

  hide() {
    this._clearTimers();
    this.element?.remove();
    this.element = null;
    this.hoveredPart = null;
  }

  destroy() {
    this.hide();
    this.boundRoot?.removeEventListener?.("pointermove", this._onPointerMove);
    this.boundRoot?.removeEventListener?.("pointerleave", this._onPointerLeave);
    this.boundRoot = null;
    this.ownerRoot = null;
    this.view = null;
  }

  _onPointerMove(event) {
    const target = getHoveredLimbPopoverTarget(event.currentTarget, event);
    if (target === this.hoveredPart) return;
    this.hoveredPart = target;
    if (!target) {
      this._scheduleClose();
      return;
    }

    this._clearTimers();
    const delay = this.element?.isConnected ? REPOSITION_SHOW_DELAY_MS : DEFAULT_SHOW_DELAY_MS;
    this.showTimer = this.view.setTimeout(() => this._show(target), delay);
  }

  _onPointerLeave() {
    this.hoveredPart = null;
    this._scheduleClose();
  }

  _scheduleClose() {
    if (this.showTimer) {
      this.view.clearTimeout(this.showTimer);
      this.showTimer = null;
    }
    this.hideTimer = this.view.setTimeout(() => this.hide(), HIDE_DELAY_MS);
  }

  _show(target) {
    if (!target?.isConnected) return;
    this._clearTimers();
    const label = String(target.dataset.label ?? "");
    const value = String(target.dataset.value ?? "0");
    const max = String(target.dataset.max ?? "0");
    const rows = parseLimbPopoverRows(target);
    const document = target.ownerDocument ?? globalThis.document;
    if (!document?.body) return;

    const element = this.element ?? document.createElement("div");
    element.className = "fallout-maw fallout-maw-token-hud-limb-popover";
    element.replaceChildren();

    const title = document.createElement("div");
    title.className = "fallout-maw-token-hud-limb-popover-title";
    title.textContent = label;
    element.append(title);

    if (rows.length) {
      for (const row of rows) {
        const valueRow = document.createElement("div");
        valueRow.className = "fallout-maw-token-hud-limb-popover-row";
        const rowLabel = document.createElement("span");
        rowLabel.textContent = row.label;
        const rowValue = document.createElement("strong");
        rowValue.textContent = row.value;
        valueRow.append(rowLabel, rowValue);
        element.append(valueRow);
      }
    } else {
      const valueRow = document.createElement("div");
      valueRow.className = "fallout-maw-token-hud-limb-popover-value";
      valueRow.textContent = max ? `${value} / ${max}` : value;
      element.append(valueRow);
    }

    document.body.append(element);
    this.element = element;
    positionLimbPopover(element, target, this.view);
  }

  _clearTimers() {
    const view = this.view ?? globalThis.window;
    if (this.showTimer) view?.clearTimeout?.(this.showTimer);
    if (this.hideTimer) view?.clearTimeout?.(this.hideTimer);
    this.showTimer = null;
    this.hideTimer = null;
  }
}

export function getHoveredLimbPopoverTarget(root, event) {
  const directTarget = event.target?.closest?.("[data-limb-popover]");
  const directPart = directTarget && root?.contains?.(directTarget) ? directTarget : null;
  const SVGElement = root?.ownerDocument?.defaultView?.SVGSVGElement ?? globalThis.SVGSVGElement;
  if (!SVGElement || !(root instanceof SVGElement)) return directPart;
  if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return directPart;

  const screenPoint = root.createSVGPoint();
  screenPoint.x = event.clientX;
  screenPoint.y = event.clientY;

  const parts = Array.from(root.querySelectorAll("[data-limb-popover]")).reverse();
  for (const part of parts) {
    const matrix = part.getScreenCTM()?.inverse();
    if (!matrix || typeof part.isPointInFill !== "function") continue;
    const localPoint = screenPoint.matrixTransform(matrix);
    if (part.isPointInFill(localPoint)) return part;
  }
  return directPart;
}

export function parseLimbPopoverRows(target) {
  const text = String(target?.dataset?.popoverRows ?? "").trim();
  if (!text) return [];
  try {
    const rows = JSON.parse(text);
    if (!Array.isArray(rows)) return [];
    return rows.map(row => ({
      label: String(Array.isArray(row) ? row[0] : row?.label ?? ""),
      value: String(Array.isArray(row) ? row[1] : row?.value ?? "")
    }));
  } catch (_error) {
    return [];
  }
}

export function positionLimbPopover(popover, target, view = null) {
  const window = view ?? target?.ownerDocument?.defaultView ?? globalThis.window;
  if (!window) return;
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
