import { getOverlayBaseZIndex } from "./overlay-layer.mjs";

export function positionAbilityDescriptionTooltip(element, anchor, { layerElement = null } = {}) {
  if (!element || !anchor?.isConnected) return;
  const ownerDocument = element.ownerDocument ?? anchor.ownerDocument ?? globalThis.document;
  const view = ownerDocument?.defaultView ?? globalThis.window;
  const margin = 8;
  const gap = 12;
  const viewportWidth = view.innerWidth || ownerDocument?.documentElement?.clientWidth || 0;
  const viewportHeight = view.innerHeight || ownerDocument?.documentElement?.clientHeight || 0;
  syncTooltipLayerWithApplication(element, layerElement);
  const anchorRect = anchor.getBoundingClientRect();
  let tooltipRect = element.getBoundingClientRect();

  const leftCandidate = anchorRect.left - tooltipRect.width - gap;
  const rightCandidate = anchorRect.right + gap;
  const preferRight = element.classList.contains("fallout-maw-skill-cost-tooltip");
  let left = preferRight ? rightCandidate : leftCandidate;
  let direction = preferRight ? "right" : "left";
  if (preferRight && (left + tooltipRect.width) > (viewportWidth - margin)) {
    left = leftCandidate;
    direction = "left";
  } else if (!preferRight && left < margin) {
    left = rightCandidate;
    direction = "right";
  }
  if (left < margin || (left + tooltipRect.width) > (viewportWidth - margin)) {
    left = Math.max(margin, viewportWidth - tooltipRect.width - margin);
    direction = "clamped";
  }

  let top = anchorRect.top + ((anchorRect.height - tooltipRect.height) / 2);
  if (top < margin) top = margin;
  if ((top + tooltipRect.height) > (viewportHeight - margin)) {
    top = Math.max(margin, viewportHeight - tooltipRect.height - margin);
  }

  element.dataset.tooltipDirection = direction;
  element.style.left = `${Math.round(left)}px`;
  element.style.top = `${Math.round(top)}px`;
  element.style.setProperty("--fallout-maw-tooltip-max-height", `${Math.max(160, viewportHeight - (margin * 2))}px`);

  tooltipRect = element.getBoundingClientRect();
  if ((tooltipRect.top + tooltipRect.height) > (viewportHeight - margin)) {
    element.style.top = `${Math.round(Math.max(margin, viewportHeight - tooltipRect.height - margin))}px`;
  }
}

function syncTooltipLayerWithApplication(element, applicationElement) {
  if (!element || !applicationElement?.isConnected) return;
  element.style.zIndex = String(getOverlayBaseZIndex(applicationElement) + 2);
}
