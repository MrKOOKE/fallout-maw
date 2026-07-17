const FALLBACK_DRAG_RESISTANCE_PX = 10;

/**
 * Distinguish a short right-click (cancel/undo) from an RMB camera pan.
 * Foundry clears `_dragRight` before `contextmenu`, so we keep a sticky
 * drag flag from pointer/mouse movement and release distance.
 */
export function createRightClickPanGuard({
  isCanvasEvent = event => Boolean(event),
  onClick = null
} = {}) {
  let candidate = null;
  const canvasView = globalThis.canvas?.app?.view ?? null;

  const getResistance = () => Math.max(
    1,
    Number(globalThis.foundry?.canvas?.interaction?.MouseInteractionManager?.DEFAULT_DRAG_RESISTANCE_PX)
      || FALLBACK_DRAG_RESISTANCE_PX
  );

  const getClientPoint = event => ({
    x: Number(event?.clientX ?? event?.client?.x ?? event?.nativeEvent?.clientX) || 0,
    y: Number(event?.clientY ?? event?.client?.y ?? event?.nativeEvent?.clientY) || 0
  });

  const getDistance = (event, origin = {}) => {
    const point = getClientPoint(event);
    return Math.hypot(point.x - (Number(origin.x) || 0), point.y - (Number(origin.y) || 0));
  };

  const markDraggedIfNeeded = event => {
    if (!candidate) return;
    const manager = globalThis.canvas?.mouseInteractionManager;
    if (manager?._dragRight && manager?.state >= 4) candidate.dragged = true;
    if (event && getDistance(event, candidate) >= getResistance()) candidate.dragged = true;
  };

  const wasPan = event => {
    markDraggedIfNeeded(event);
    if (candidate?.dragged) return true;
    if (candidate && event && getDistance(event, candidate) >= getResistance()) return true;
    const manager = globalThis.canvas?.mouseInteractionManager;
    return Boolean(manager?._dragRight && manager?.state >= 4);
  };

  const onPointerDown = event => {
    if (!isCanvasEvent(event) || event.button !== 2) return false;
    const point = getClientPoint(event);
    candidate = {
      pointerId: event.pointerId,
      x: point.x,
      y: point.y,
      dragged: false
    };
    return true;
  };

  const onPointerMove = event => {
    if (!candidate) return;
    const pointerId = event?.pointerId ?? event?.nativeEvent?.pointerId;
    if (
      pointerId !== undefined
      && candidate.pointerId !== undefined
      && pointerId !== candidate.pointerId
      && !(Number(event?.buttons) & 2)
    ) return;
    markDraggedIfNeeded(event);
  };

  const onContextMenu = event => {
    if (!isCanvasEvent(event)) return false;
    event.preventDefault?.();
    if (wasPan(event)) {
      candidate = null;
      return true; // pan — swallow browser menu, do not cancel workflow
    }
    event.stopPropagation?.();
    event.stopImmediatePropagation?.();
    candidate = null;
    onClick?.(event);
    return true;
  };

  const activate = () => {
    window.addEventListener("mousemove", onPointerMove, { capture: true });
    document.addEventListener("pointermove", onPointerMove, { capture: true });
    canvas.stage?.on?.("mousemove", onPointerMove);
    if (canvasView) canvasView.addEventListener("contextmenu", onContextMenu, { capture: true });
  };

  const deactivate = () => {
    window.removeEventListener("mousemove", onPointerMove, { capture: true });
    document.removeEventListener("pointermove", onPointerMove, { capture: true });
    canvas.stage?.off?.("mousemove", onPointerMove);
    if (canvasView) canvasView.removeEventListener("contextmenu", onContextMenu, { capture: true });
    candidate = null;
  };

  return {
    onPointerDown,
    wasPan,
    activate,
    deactivate,
    get candidate() {
      return candidate;
    }
  };
}
