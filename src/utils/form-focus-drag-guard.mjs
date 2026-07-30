const FORM_CONTROL_SELECTOR = [
  "input:not([type='hidden'])",
  "select",
  "textarea",
  "[contenteditable='']",
  "[contenteditable='true']",
  "prose-mirror",
  "code-mirror"
].join(", ");
const TEXT_SELECTION_CONTROL_SELECTOR = [
  "textarea",
  "[contenteditable='']",
  "[contenteditable='true']",
  "prose-mirror",
  "code-mirror",
  "input:not([type='hidden']):not([type='button']):not([type='checkbox']):not([type='color']):not([type='file']):not([type='image']):not([type='radio']):not([type='range']):not([type='reset']):not([type='submit'])"
].join(", ");
const FALLOUT_MAW_SCOPE_SELECTOR = ".fallout-maw, [class*='fallout-maw-']";
const DRAG_THRESHOLD_PX = 4;

export function registerFormFocusDragGuard(doc = document) {
  const root = doc?.documentElement;
  if (!root || root.dataset.falloutMawFormFocusDragGuard === "true") return;
  root.dataset.falloutMawFormFocusDragGuard = "true";

  let dragState = null;
  let pendingClickTarget = null;
  let pendingClickClearId = null;

  doc.addEventListener("pointerdown", onPointerDown, { capture: true });
  doc.addEventListener("pointermove", onPointerMove, { capture: true, passive: true });
  doc.addEventListener("pointerup", onPointerUp, { capture: true });
  doc.addEventListener("pointercancel", clearPointerGesture, { capture: true });
  doc.addEventListener("click", onClick, { capture: true });

  function onPointerDown(event) {
    // A click which belongs to the previous release is dispatched before any
    // subsequent pointerdown. Reaching a new press therefore makes an
    // unmatched pending click stale.
    clearPendingClick();
    if (event.button !== 0) {
      dragState = null;
      return;
    }

    const source = getClosestControl(event.target, TEXT_SELECTION_CONTROL_SELECTOR);
    if (!source || !isFalloutMawElement(source)) {
      dragState = null;
      return;
    }

    dragState = {
      pointerId: event.pointerId,
      source,
      startX: event.clientX,
      startY: event.clientY,
      moved: false
    };
  }

  function onPointerMove(event) {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    const dx = Math.abs(event.clientX - dragState.startX);
    const dy = Math.abs(event.clientY - dragState.startY);
    if ((dx >= DRAG_THRESHOLD_PX) || (dy >= DRAG_THRESHOLD_PX)) dragState.moved = true;
  }

  function onPointerUp(event) {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    const state = dragState;
    dragState = null;
    if (!state.moved || !state.source?.isConnected) return;

    const target = getReleaseTargetControl(event);
    if (!target || isSameControl(state.source, target) || !isFalloutMawElement(target)) return;

    // Cancel only the activation produced by this cross-control release.
    // Native focus and selection on the source are intentionally untouched.
    event.preventDefault();
    pendingClickTarget = target;
    const view = doc.defaultView ?? globalThis.window;
    pendingClickClearId = view?.setTimeout?.(() => {
      pendingClickTarget = null;
      pendingClickClearId = null;
    }, 0) ?? null;
  }

  function onClick(event) {
    if (!pendingClickTarget) return;
    const pendingTarget = pendingClickTarget;
    clearPendingClick();

    const target = getReleaseTargetControl(event);
    if (!target || !isSameControl(target, pendingTarget)) return;

    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function clearPointerGesture() {
    dragState = null;
    clearPendingClick();
  }

  function clearPendingClick() {
    pendingClickTarget = null;
    if (pendingClickClearId === null) return;
    const view = doc.defaultView ?? globalThis.window;
    view?.clearTimeout?.(pendingClickClearId);
    pendingClickClearId = null;
  }
}

function getReleaseTargetControl(event) {
  const doc = event.target?.ownerDocument ?? document;
  const pointedElement = Number.isFinite(event.clientX) && Number.isFinite(event.clientY)
    ? doc.elementFromPoint(event.clientX, event.clientY)
    : null;
  return getClosestControl(pointedElement, FORM_CONTROL_SELECTOR)
    ?? getClosestControl(event.target, FORM_CONTROL_SELECTOR);
}

function getClosestControl(target, selector) {
  const element = getElementTarget(target);
  return element?.closest?.(selector) ?? null;
}

function getElementTarget(target) {
  if (target?.nodeType === Node.ELEMENT_NODE) return target;
  return target?.parentElement?.nodeType === Node.ELEMENT_NODE ? target.parentElement : null;
}

function isFalloutMawElement(target) {
  return Boolean(getElementTarget(target)?.closest?.(FALLOUT_MAW_SCOPE_SELECTOR));
}

function isSameControl(a, b) {
  return (a === b) || a.contains?.(b) || b.contains?.(a);
}
