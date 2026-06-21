export function queueGlobalMapApplicationPosition(application) {
  const view = application.element?.ownerDocument?.defaultView ?? globalThis;
  view.requestAnimationFrame?.(() => positionGlobalMapApplication(application))
    ?? positionGlobalMapApplication(application);
}

function positionGlobalMapApplication(application) {
  const element = application.element;
  if (!element) return;
  const document = element.ownerDocument;
  const sidebar = document.querySelector("#sidebar");
  const viewportWidth = document.defaultView?.innerWidth ?? document.documentElement.clientWidth;
  const sidebarLeft = sidebar?.getBoundingClientRect().left;
  const rightBoundary = Number.isFinite(sidebarLeft) && sidebarLeft > 0 ? sidebarLeft : viewportWidth;
  const width = element.getBoundingClientRect().width
    || Number(application.position?.width)
    || Number(application.options?.position?.width)
    || 440;
  application.setPosition({
    left: Math.max(8, Math.round(rightBoundary - width - 12)),
    top: 16
  });
}
