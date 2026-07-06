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
const SUPPRESSION_DURATION_MS = 250;

let dragState = null;
let suppressedFocusTransfer = null;

export function registerFormFocusDragGuard(doc = document) {
  const root = doc?.documentElement;
  if (!root || root.dataset.falloutMawFormFocusDragGuard === "true") return;
  root.dataset.falloutMawFormFocusDragGuard = "true";

  doc.addEventListener("pointerdown", onPointerDown, { capture: true });
  doc.addEventListener("pointermove", onPointerMove, { capture: true, passive: true });
  doc.addEventListener("pointerup", onPointerUp, { capture: true });
  doc.addEventListener("pointercancel", clearDragState, { capture: true });
  doc.addEventListener("mouseup", onMouseUp, { capture: true });
  doc.addEventListener("click", onClick, { capture: true });
  doc.addEventListener("focusin", onFocusIn, { capture: true });
}

function onPointerDown(event) {
  if (event.button !== 0) {
    clearDragState();
    return;
  }

  const source = getClosestControl(event.target, TEXT_SELECTION_CONTROL_SELECTOR);
  if (!source || !isFalloutMawElement(source)) {
    clearDragState();
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
  handleRelease(event);
}

function onMouseUp(event) {
  if (!dragState || event.button !== 0) return;
  handleRelease(event);
}

function handleRelease(event) {
  const state = dragState;
  dragState = null;
  if (!state.moved || !state.source?.isConnected) return;

  const target = getReleaseTargetControl(event);
  if (!target || isSameControl(state.source, target) || !isFalloutMawElement(target)) return;

  event.preventDefault();
  const selection = captureSelection(state.source);
  suppressedFocusTransfer = {
    source: state.source,
    target,
    selection,
    until: performance.now() + SUPPRESSION_DURATION_MS
  };
  window.setTimeout(clearSuppressedFocusTransfer, SUPPRESSION_DURATION_MS);
}

function onClick(event) {
  const suppressed = getSuppressedFocusTransfer(event);
  if (!suppressed) return;

  const target = getReleaseTargetControl(event);
  if (!target || !isSameControl(target, suppressed.target)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  restoreSourceFocus(suppressed);
  clearSuppressedFocusTransfer();
}

function onFocusIn(event) {
  const suppressed = getSuppressedFocusTransfer(event);
  if (!suppressed) return;

  const target = getClosestControl(event.target, FORM_CONTROL_SELECTOR);
  if (!target || isSameControl(target, suppressed.source)) return;
  queueMicrotask(() => restoreSourceFocus(suppressed));
}

function getSuppressedFocusTransfer(event) {
  if (!suppressedFocusTransfer) return null;
  if (performance.now() > suppressedFocusTransfer.until) {
    clearSuppressedFocusTransfer();
    return null;
  }
  if (event?.target && !isFalloutMawElement(event.target)) return null;
  return suppressedFocusTransfer;
}

function clearDragState() {
  dragState = null;
}

function clearSuppressedFocusTransfer() {
  suppressedFocusTransfer = null;
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

function captureSelection(control) {
  if (!isTextSelectionElement(control)) return null;
  if (typeof control.selectionStart !== "number" || typeof control.selectionEnd !== "number") return null;
  return {
    start: control.selectionStart,
    end: control.selectionEnd,
    direction: control.selectionDirection ?? "none"
  };
}

function isTextSelectionElement(control) {
  return ["INPUT", "TEXTAREA"].includes(control?.tagName);
}

function restoreSourceFocus({ source, selection }) {
  if (!source?.isConnected || source.disabled || source.readOnly) return;
  source.focus?.({ preventScroll: true });
  if (!selection || (typeof source.setSelectionRange !== "function")) return;
  source.setSelectionRange(selection.start, selection.end, selection.direction);
}
