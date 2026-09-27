import { enrichSettingDescription } from "./setting-description.mjs";
import { positionAbilityDescriptionTooltip } from "./description-tooltip-position.mjs";

const SELECTOR = "[data-system-description]";

/** Setting descriptions in the same frame as ability descriptions. */
export class DescriptionTooltipController {
  #root = null;
  #abort = null;
  #anchor = null;
  #tooltip = null;
  #timer = null;
  #view = null;
  #pinned = false;
  #actor = null;
  #generation = 0;

  bind(root, { actor = null } = {}) {
    this.destroy();
    if (!root) return;
    this.#root = root;
    this.#actor = actor;
    this.#view = root.ownerDocument.defaultView;
    this.#abort = new this.#view.AbortController();
    const options = { signal: this.#abort.signal };
    root.addEventListener("pointerover", event => {
      if (this.#pinned) return;
      const anchor = this.#getAnchor(event.target);
      if (!anchor || this.#getAnchor(event.relatedTarget) === anchor) return;
      this.#clear();
      this.#anchor = anchor;
      this.#timer = this.#view.setTimeout(() => void this.#show(anchor), 500);
    }, options);
    root.addEventListener("pointerout", event => {
      if (this.#pinned || !this.#anchor) return;
      if (this.#getAnchor(event.relatedTarget) === this.#anchor || this.#tooltip?.contains(event.relatedTarget)) return;
      this.#clear();
    }, options);
    root.addEventListener("auxclick", event => {
      const anchor = this.#getAnchor(event.target);
      if (event.button !== 1 || !anchor) return;
      event.preventDefault();
      event.stopPropagation();
      const unpin = this.#pinned && this.#anchor === anchor;
      this.#clear();
      if (unpin) return;
      this.#anchor = anchor;
      void this.#show(anchor, { pinned: true });
    }, options);
    const onPointerDown = event => {
      const anchor = this.#getAnchor(event.target);
      const inside = this.#tooltip?.contains(event.target);
      if (event.button === 1 && (anchor || inside)) event.preventDefault();
      if (!anchor && !inside) this.#clear();
    };
    root.ownerDocument.addEventListener("pointerdown", onPointerDown, { ...options, capture: true });
    root.ownerDocument.addEventListener("mousedown", onPointerDown, { ...options, capture: true });
    root.ownerDocument.addEventListener("keydown", event => {
      if (event.key === "Escape") this.#clear();
    }, options);
  }

  #getAnchor(target) {
    // Cost and control tooltips take precedence over a row description.
    if (target?.closest?.("button, input, [data-tooltip-ignore]")) return null;
    const anchor = target?.closest?.(SELECTOR);
    return anchor && this.#root?.contains(anchor) ? anchor : null;
  }

  async #show(anchor, { pinned = false } = {}) {
    this.#view.clearTimeout(this.#timer);
    this.#timer = null;
    if (!anchor.isConnected || this.#anchor !== anchor) return;
    const description = String(anchor.dataset.systemDescription ?? "").trim();
    if (!description) return;
    const generation = this.#generation;
    this.#pinned = pinned;
    const html = await enrichSettingDescription(description, this.#actor);
    if (generation !== this.#generation || !anchor.isConnected || this.#anchor !== anchor) return;
    const tooltip = anchor.ownerDocument.createElement("aside");
    tooltip.className = "fallout-maw-inventory-tooltip fallout-maw-ability-description-tooltip";
    tooltip.classList.toggle("pinned", pinned);
    tooltip.setAttribute("role", "tooltip");
    tooltip.innerHTML = `<section class="content fallout-maw-ability-tooltip-content"><section class="description">${html}</section></section>`;
    tooltip.addEventListener("pointerleave", event => {
      if (!this.#pinned && this.#getAnchor(event.relatedTarget) !== anchor) this.#clear();
    });
    anchor.ownerDocument.body.append(tooltip);
    this.#tooltip = tooltip;
    this.#pinned = pinned;
    positionAbilityDescriptionTooltip(tooltip, anchor, { layerElement: this.#root });
    this.#view.requestAnimationFrame(() => {
      if (this.#tooltip === tooltip) positionAbilityDescriptionTooltip(tooltip, anchor, { layerElement: this.#root });
    });
  }

  #clear() {
    this.#generation += 1;
    this.#view?.clearTimeout(this.#timer);
    this.#timer = null;
    this.#tooltip?.remove();
    this.#tooltip = null;
    this.#anchor = null;
    this.#pinned = false;
  }

  destroy() {
    this.#clear();
    this.#abort?.abort();
    this.#abort = null;
    this.#root = null;
    this.#actor = null;
    this.#view = null;
  }
}
