const OVERLAY_MINIMUM_Z_INDEX = 100000;

export function getOverlayBaseZIndex(ownerElement, { minimum = OVERLAY_MINIMUM_Z_INDEX } = {}) {
  const ownerDocument = ownerElement?.ownerDocument ?? document;
  const view = ownerDocument.defaultView ?? window;
  const documentElement = ownerDocument.documentElement ?? document.documentElement;
  const body = ownerDocument.body ?? document.body;
  const readZIndex = value => {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    return Number.isFinite(parsed) ? parsed : null;
  };

  return Math.max(
    minimum,
    readZIndex(ownerElement ? view.getComputedStyle(ownerElement).zIndex : null) ?? 0,
    readZIndex(view.getComputedStyle(body).getPropertyValue("--z-index-tooltip")) ?? 0,
    readZIndex(view.getComputedStyle(body).getPropertyValue("--z-index-window")) ?? 0,
    readZIndex(view.getComputedStyle(documentElement).getPropertyValue("--z-index-tooltip")) ?? 0,
    readZIndex(view.getComputedStyle(documentElement).getPropertyValue("--z-index-window")) ?? 0
  );
}

export function reserveOverlayZIndex(zIndex) {
  const applicationClass = globalThis.foundry?.applications?.api?.ApplicationV2;
  if (!applicationClass) return;
  const currentZIndex = Number(applicationClass._maxZ);
  const nextZIndex = Number(zIndex);
  if (!Number.isFinite(currentZIndex) || !Number.isFinite(nextZIndex) || currentZIndex >= nextZIndex) return;
  applicationClass._maxZ = nextZIndex;
}
