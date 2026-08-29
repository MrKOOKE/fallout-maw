const DEFAULT_ACTIVATION_DELAY_MS = 200;
const DEFAULT_DEACTIVATION_DELAY_MS = 90;
const DEFAULT_TOOLTIP_WIDTH_PX = 460;
const TOOLTIP_MARGIN_PX = 5;
const TOOLTIP_ANCHOR_CLASS = "fallout-maw-token-effect-tooltip-anchor";
const TOOLTIP_CLASS = "fallout-maw-effect-tooltip";
const TOOLTIP_DIRECTION_LEFT = "LEFT";
const TOOLTIP_DIRECTION_RIGHT = "RIGHT";

/**
 * Coordinate rich Active Effect tooltips for both PIXI token icons and ordinary
 * sheet HTML while retaining Foundry's single global TooltipManager.
 */
export class EffectTooltipController {
  #activationDelay;
  #activationTimer = null;
  #activeCanvasContext = null;
  #anchor = null;
  #boundEventSources = new WeakSet();
  #deactivationDelay;
  #deactivationTimer = null;
  #guardWindow = null;
  #iconContexts = new WeakMap();
  #observedTooltip = null;
  #observer = null;
  #pendingCanvasContext = null;
  #renderGeneration = 0;
  #renderHTML;

  constructor({
    renderHTML,
    activationDelay = DEFAULT_ACTIVATION_DELAY_MS,
    deactivationDelay = DEFAULT_DEACTIVATION_DELAY_MS
  } = {}) {
    if (typeof renderHTML !== "function") throw new TypeError("Effect tooltip renderHTML must be a function.");
    this.#renderHTML = renderHTML;
    this.#activationDelay = Math.max(0, Number(activationDelay) || 0);
    this.#deactivationDelay = Math.max(0, Number(deactivationDelay) || 0);
  }

  /** Register an icon with shared callback functions and no per-icon closures. */
  bindCanvasIcon(icon, { token, effect } = {}) {
    if (!icon || !effect) return icon;
    this.#iconContexts.set(icon, { icon, token, effect });
    icon.eventMode = "static";
    icon.cursor = "help";
    // PIXI only notifies listeners on interactive currentTargets; the shared
    // effects parent is intentionally non-interactive.
    const eventSource = icon;
    if (!this.#boundEventSources.has(eventSource)) {
      eventSource.on("pointerover", this.#onCanvasPointerOver);
      eventSource.on("pointerout", this.#onCanvasPointerOut);
      eventSource.on("pointerupoutside", this.#onCanvasPointerUpOutside);
      this.#boundEventSources.add(eventSource);
    }
    this.#ensureMiddleClickGuard();
    return icon;
  }

  /** Observe Foundry's one tooltip node and lazily fill declarative sheet tooltips. */
  observe() {
    const tooltip = globalThis.game?.tooltip?.tooltip;
    if (!tooltip || this.#observedTooltip === tooltip) return;
    this.#observer?.disconnect();
    const Observer = tooltip.ownerDocument?.defaultView?.MutationObserver ?? globalThis.MutationObserver;
    if (typeof Observer !== "function") return;
    this.#observedTooltip = tooltip;
    this.#observer = new Observer(records => {
      const activated = records.some(record => (
        record.type === "attributes"
        && record.attributeName === "class"
        && tooltip.classList.contains("active")
        && !String(record.oldValue ?? "").split(/\s+/).includes("active")
      ));
      if (activated) this.#renderActiveSheetTooltip(tooltip);
    });
    this.#observer.observe(tooltip, {
      attributes: true,
      attributeFilter: ["class"],
      attributeOldValue: true
    });
  }

  /** Cancel pending or visible canvas tooltip work owned by a redrawn token. */
  deactivateForToken(token) {
    if (!token) return;
    if (this.#pendingCanvasContext?.token === token) {
      this.#clearActivationTimer();
      this.#pendingCanvasContext = null;
    }
    if (this.#activeCanvasContext?.token === token) this.#deactivateCanvasTooltip();
  }

  #onCanvasPointerOver = event => {
    const icon = this.#getEventIcon(event);
    const context = this.#iconContexts.get(icon);
    if (!context) return;
    const point = getClientPoint(event);
    if (!point) return;

    this.#clearActivationTimer();
    this.#clearDeactivationTimer();
    if (this.#isCanvasTooltipActive() && this.#activeCanvasContext?.icon === icon) return;

    const request = { ...context, point };
    this.#pendingCanvasContext = request;
    if (this.#isCanvasTooltipActive()) {
      this.#activateCanvasTooltip(request);
      return;
    }

    this.#activationTimer = globalThis.setTimeout(() => {
      this.#activationTimer = null;
      this.#activateCanvasTooltip(request);
    }, this.#activationDelay);
  };

  #onCanvasPointerOut = event => {
    const icon = this.#getEventIcon(event);
    this.#leaveCanvasIcon(icon);
  };

  #onCanvasPointerUpOutside = () => {
    this.#leaveCanvasIcon(this.#pendingCanvasContext?.icon ?? this.#activeCanvasContext?.icon);
  };

  #leaveCanvasIcon(icon) {
    if (!icon) return;
    if (this.#pendingCanvasContext?.icon === icon) {
      this.#clearActivationTimer();
      this.#pendingCanvasContext = null;
    }
    if (this.#activeCanvasContext?.icon !== icon) return;
    this.#clearDeactivationTimer();
    this.#deactivationTimer = globalThis.setTimeout(() => {
      this.#deactivationTimer = null;
      if (!this.#pendingCanvasContext && this.#activeCanvasContext?.icon === icon) {
        this.#deactivateCanvasTooltip();
      }
    }, this.#deactivationDelay);
  }

  #onMiddlePointerUp = event => {
    if (event.button !== 1 || globalThis.game?.tooltip?.element !== this.#anchor) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  #getEventIcon(event) {
    const boundary = event?.currentTarget ?? null;
    let object = event?.target ?? boundary;
    while (object) {
      if (this.#iconContexts.has(object)) return object;
      if (object === boundary) break;
      object = object.parent;
    }
    return null;
  }

  #activateCanvasTooltip(request) {
    if (this.#pendingCanvasContext !== request) return;
    if (request.icon?.destroyed || request.token?.destroyed || !isCanvasTopmostAtPoint(request.point)) {
      this.#pendingCanvasContext = null;
      return;
    }

    const manager = globalThis.game?.tooltip;
    const view = globalThis.canvas?.app?.view;
    const document = view?.ownerDocument ?? globalThis.document;
    if (!manager || !view || !document?.body) {
      this.#pendingCanvasContext = null;
      return;
    }

    let html;
    try {
      html = this.#renderHTML(request.effect, request.token?.actor ?? null);
    } catch (error) {
      console.warn("fallout-maw | Failed to render Active Effect tooltip", error);
      this.#deactivateCanvasTooltip();
      return;
    }

    const rect = getIconClientRect(request.icon, view);
    const anchor = this.#getCanvasAnchor(document);
    positionCanvasAnchor(anchor, rect);
    const direction = getHorizontalTooltipDirection({
      anchorRect: rect,
      viewportWidth: document.defaultView?.innerWidth,
      tooltipWidth: DEFAULT_TOOLTIP_WIDTH_PX,
      preferredDirection: TOOLTIP_DIRECTION_LEFT
    });
    manager.activate(anchor, { html, cssClass: TOOLTIP_CLASS, direction });
    this.#activeCanvasContext = request;
    this.#pendingCanvasContext = null;
  }

  #deactivateCanvasTooltip() {
    this.#clearActivationTimer();
    this.#clearDeactivationTimer();
    this.#pendingCanvasContext = null;
    if (globalThis.game?.tooltip?.element === this.#anchor) globalThis.game.tooltip.deactivate();
    this.#activeCanvasContext = null;
  }

  #getCanvasAnchor(document) {
    if (this.#anchor?.ownerDocument === document && document.body.contains(this.#anchor)) return this.#anchor;
    this.#anchor?.remove();
    const anchor = document.createElement("span");
    anchor.className = TOOLTIP_ANCHOR_CLASS;
    anchor.setAttribute("aria-hidden", "true");
    document.body.append(anchor);
    this.#anchor = anchor;
    return anchor;
  }

  #isCanvasTooltipActive() {
    return Boolean(this.#anchor && globalThis.game?.tooltip?.element === this.#anchor);
  }

  #ensureMiddleClickGuard() {
    const view = globalThis.canvas?.app?.view;
    const window = view?.ownerDocument?.defaultView ?? globalThis.window;
    if (!window || this.#guardWindow === window) return;
    this.#guardWindow?.removeEventListener?.("pointerup", this.#onMiddlePointerUp, true);
    window.addEventListener("pointerup", this.#onMiddlePointerUp, true);
    this.#guardWindow = window;
  }

  #renderActiveSheetTooltip(tooltip) {
    const manager = globalThis.game?.tooltip;
    const anchor = manager?.element;
    if (!anchor || anchor.dataset?.effectTooltip === undefined) return;
    const generation = ++this.#renderGeneration;
    const { effect, actor } = resolveSheetEffectContext(anchor);
    if (!effect) {
      tooltip.textContent = String(anchor.dataset.effectTooltipFallback ?? "").trim();
      this.#queueSheetTooltipPosition(anchor, tooltip, generation);
      return;
    }

    let html;
    try {
      html = this.#renderHTML(effect, actor);
    } catch (error) {
      console.warn("fallout-maw | Failed to render sheet Active Effect tooltip", error);
      tooltip.textContent = String(anchor.dataset.effectTooltipFallback ?? "").trim();
      this.#queueSheetTooltipPosition(anchor, tooltip, generation);
      return;
    }
    if (generation !== this.#renderGeneration || manager.element !== anchor) return;
    tooltip.innerHTML = foundry.utils.cleanHTML(html);
    this.#queueSheetTooltipPosition(anchor, tooltip, generation);
  }

  #queueSheetTooltipPosition(anchor, tooltip, generation) {
    const manager = globalThis.game?.tooltip;
    const view = tooltip.ownerDocument?.defaultView ?? globalThis.window;
    const position = () => {
      if (generation !== this.#renderGeneration || manager?.element !== anchor) return;
      const direction = getHorizontalTooltipDirection({
        anchorRect: anchor.getBoundingClientRect(),
        viewportWidth: view?.innerWidth,
        tooltipWidth: tooltip.offsetWidth || DEFAULT_TOOLTIP_WIDTH_PX,
        preferredDirection: anchor.closest?.("[data-tooltip-direction]")?.dataset.tooltipDirection
          ?? TOOLTIP_DIRECTION_LEFT
      });
      manager._setAnchor?.(direction);
    };
    if (typeof view?.requestAnimationFrame === "function") view.requestAnimationFrame(position);
    else globalThis.setTimeout(position, 0);
  }

  #clearActivationTimer() {
    if (this.#activationTimer === null) return;
    globalThis.clearTimeout(this.#activationTimer);
    this.#activationTimer = null;
  }

  #clearDeactivationTimer() {
    if (this.#deactivationTimer === null) return;
    globalThis.clearTimeout(this.#deactivationTimer);
    this.#deactivationTimer = null;
  }
}

/** Choose a horizontal side which fits, falling back to the roomier side. */
export function getHorizontalTooltipDirection({
  anchorRect = {},
  viewportWidth = 0,
  tooltipWidth = DEFAULT_TOOLTIP_WIDTH_PX,
  preferredDirection = TOOLTIP_DIRECTION_LEFT,
  margin = TOOLTIP_MARGIN_PX
} = {}) {
  const width = Math.max(0, Number(viewportWidth) || 0);
  const required = Math.max(0, Number(tooltipWidth) || 0) + Math.max(0, Number(margin) || 0);
  const leftSpace = Math.max(0, Number(anchorRect.left) || 0);
  const rightSpace = Math.max(0, width - (Number(anchorRect.right) || 0));
  const preferred = preferredDirection === TOOLTIP_DIRECTION_RIGHT
    ? TOOLTIP_DIRECTION_RIGHT
    : TOOLTIP_DIRECTION_LEFT;
  const alternate = preferred === TOOLTIP_DIRECTION_LEFT ? TOOLTIP_DIRECTION_RIGHT : TOOLTIP_DIRECTION_LEFT;
  const spaces = {
    [TOOLTIP_DIRECTION_LEFT]: leftSpace,
    [TOOLTIP_DIRECTION_RIGHT]: rightSpace
  };
  if (spaces[preferred] >= required) return preferred;
  if (spaces[alternate] >= required) return alternate;
  return rightSpace > leftSpace ? TOOLTIP_DIRECTION_RIGHT : TOOLTIP_DIRECTION_LEFT;
}

function resolveSheetEffectContext(anchor) {
  const row = anchor.closest?.("[data-effect-id]") ?? anchor;
  const actor = resolveUuid(row.dataset.effectTooltipActorUuid);
  let effect = resolveUuid(row.dataset.effectUuid);
  if (!effect && actor) {
    const effectId = String(row.dataset.effectId ?? "");
    const parentItemId = String(row.dataset.effectParentItemId ?? "");
    effect = parentItemId
      ? actor.items?.get?.(parentItemId)?.effects?.get?.(effectId)
      : actor.effects?.get?.(effectId);
  }
  return { effect, actor: actor ?? getEffectActor(effect) };
}

function resolveUuid(uuid) {
  const normalized = String(uuid ?? "").trim();
  if (!normalized || typeof globalThis.fromUuidSync !== "function") return null;
  try {
    return globalThis.fromUuidSync(normalized) ?? null;
  } catch (_error) {
    return null;
  }
}

function getEffectActor(effect) {
  if (effect?.target?.documentName === "Actor") return effect.target;
  if (effect?.parent?.documentName === "Actor") return effect.parent;
  if (effect?.parent?.documentName === "Item") {
    return effect.parent.actor ?? (effect.parent.parent?.documentName === "Actor" ? effect.parent.parent : null);
  }
  return null;
}

function getClientPoint(event) {
  const nativeEvent = event?.nativeEvent ?? event?.originalEvent ?? event;
  if (!Number.isFinite(nativeEvent?.clientX) || !Number.isFinite(nativeEvent?.clientY)) return null;
  return { x: nativeEvent.clientX, y: nativeEvent.clientY };
}

function isCanvasTopmostAtPoint(point) {
  const view = globalThis.canvas?.app?.view;
  const document = view?.ownerDocument ?? globalThis.document;
  return Boolean(view && point && document?.elementFromPoint?.(point.x, point.y) === view);
}

function getIconClientRect(icon, view) {
  const bounds = icon?.getBounds?.();
  const rect = view?.getBoundingClientRect?.();
  if (bounds && rect) {
    const screen = globalThis.canvas?.app?.renderer?.screen;
    const scaleX = rect.width / (Number(screen?.width) || rect.width || 1);
    const scaleY = rect.height / (Number(screen?.height) || rect.height || 1);
    return {
      left: rect.left + ((bounds.x - (Number(screen?.x) || 0)) * scaleX),
      right: rect.left + (((bounds.x + bounds.width) - (Number(screen?.x) || 0)) * scaleX),
      top: rect.top + ((bounds.y - (Number(screen?.y) || 0)) * scaleY),
      width: bounds.width * scaleX,
      height: bounds.height * scaleY
    };
  }
  const window = view?.ownerDocument?.defaultView ?? globalThis.window;
  const left = (Number(window?.innerWidth) || 0) / 2;
  return { left, right: left + 1, top: (Number(window?.innerHeight) || 0) / 2, width: 1, height: 1 };
}

function positionCanvasAnchor(anchor, rect) {
  anchor.style.left = `${rect.left}px`;
  anchor.style.top = `${rect.top}px`;
  anchor.style.width = `${Math.max(1, rect.width)}px`;
  anchor.style.height = `${Math.max(1, rect.height)}px`;
}
