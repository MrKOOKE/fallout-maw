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
const SELECTION_RESTORE_DURATION_MS = 2000;

let dragState = null;
let suppressedFocusTransfer = null;
let lastTextSelection = null;
let lastPointerDownTarget = null;
let restoringSelection = false;

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
  doc.addEventListener("selectionchange", onSelectionChange);
  doc.addEventListener("select", onSelect, { capture: true });
  doc.addEventListener("input", onTextInput, { capture: true });
  doc.addEventListener("keyup", onKeyUp, { capture: true });
}

function onPointerDown(event) {
  lastPointerDownTarget = {
    element: getElementTarget(event.target),
    time: performance.now()
  };

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
  rememberTextSelection(source);
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
  if (!suppressed) {
    restoreTextSelectionForFocus(event.target);
    return;
  }

  const target = getClosestControl(event.target, FORM_CONTROL_SELECTOR);
  if (!target || isSameControl(target, suppressed.source)) {
    restoreTextSelectionForFocus(event.target);
    return;
  }
  queueMicrotask(() => {
    restoreSourceFocus(suppressed);
    restoreTextSelectionForFocus(suppressed.source);
  });
}

function onSelectionChange(event) {
  if (restoringSelection) return;
  const control = getClosestControl(event.target?.activeElement ?? event.currentTarget?.activeElement, TEXT_SELECTION_CONTROL_SELECTOR);
  rememberTextSelection(control);
}

function onSelect(event) {
  if (restoringSelection) return;
  rememberTextSelection(getClosestControl(event.target, TEXT_SELECTION_CONTROL_SELECTOR));
}

function onTextInput(event) {
  if (restoringSelection) return;
  rememberTextSelection(getClosestControl(event.target, TEXT_SELECTION_CONTROL_SELECTOR));
}

function onKeyUp(event) {
  if (restoringSelection) return;
  rememberTextSelection(getClosestControl(event.target, TEXT_SELECTION_CONTROL_SELECTOR));
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

function rememberTextSelection(control) {
  if (!control || !isFalloutMawElement(control) || !isTextSelectionElement(control)) return;
  const selection = captureSelection(control);
  if (!selection) return;
  const signature = getControlSignature(control);
  const value = String(control.value ?? "");
  if (
    lastTextSelection
    && performance.now() <= lastTextSelection.until
    && control !== lastTextSelection.source
    && isSameControlSignature(signature, lastTextSelection.signature)
    && value === lastTextSelection.value
    && selection.start === 0
    && selection.end === 0
    && (lastTextSelection.selection.start !== 0 || lastTextSelection.selection.end !== 0)
    && lastPointerDownTarget?.element !== control
  ) return;

  lastTextSelection = {
    source: control,
    signature,
    value,
    selection,
    until: performance.now() + SELECTION_RESTORE_DURATION_MS
  };
}

function restoreTextSelectionForFocus(target) {
  const control = getClosestControl(target, TEXT_SELECTION_CONTROL_SELECTOR);
  const saved = getRestorableTextSelection(control);
  if (!saved) return;

  const restore = () => {
    const doc = control.ownerDocument ?? document;
    if (!control.isConnected || doc.activeElement !== control || typeof control.setSelectionRange !== "function") return;
    const valueLength = String(control.value ?? "").length;
    const start = clampSelectionIndex(saved.selection.start, valueLength);
    const end = clampSelectionIndex(saved.selection.end, valueLength);
    restoringSelection = true;
    try {
      control.setSelectionRange(start, end, saved.selection.direction);
    } finally {
      restoringSelection = false;
    }
  };

  queueMicrotask(() => {
    restore();
    const view = control.ownerDocument?.defaultView ?? window;
    view.requestAnimationFrame?.(restore);
  });
}

function getRestorableTextSelection(control) {
  if (!control || !lastTextSelection || !isFalloutMawElement(control) || !isTextSelectionElement(control)) return null;
  if (performance.now() > lastTextSelection.until) {
    lastTextSelection = null;
    return null;
  }
  if (control === lastTextSelection.source) return null;
  if (lastPointerDownTarget?.element === control && performance.now() - lastPointerDownTarget.time < SUPPRESSION_DURATION_MS) return null;
  if (!isSameControlSignature(getControlSignature(control), lastTextSelection.signature)) return null;
  if (String(control.value ?? "") !== lastTextSelection.value) return null;
  return lastTextSelection;
}

function getControlSignature(control) {
  const path = [];
  for (let element = control; element && isFalloutMawElement(element); element = element.parentElement) {
    if (element.dataset?.tab) path.push(`tab:${element.dataset.tab}`);
    if (element.dataset?.itemId) path.push(`item:${element.dataset.itemId}`);
    if (element.dataset?.entryId) path.push(`entry:${element.dataset.entryId}`);
    if (element.dataset?.changeIndex) path.push(`change:${element.dataset.changeIndex}`);
  }

  return {
    tagName: String(control.tagName ?? ""),
    type: String(control.type ?? ""),
    id: String(control.id ?? ""),
    name: String(control.name ?? ""),
    field: String(control.dataset?.field ?? ""),
    path: path.reverse().join("|")
  };
}

function isSameControlSignature(left, right) {
  if (!left || !right) return false;
  if (left.id && right.id) return left.id === right.id;
  if (left.name && right.name) return left.tagName === right.tagName && left.name === right.name;
  if (left.field && right.field) return left.tagName === right.tagName && left.field === right.field && left.path === right.path;
  return false;
}

function clampSelectionIndex(value, max) {
  return Math.max(0, Math.min(Math.max(0, Number(max) || 0), Number(value) || 0));
}

function restoreSourceFocus({ source, selection }) {
  if (!source?.isConnected || source.disabled || source.readOnly) return;
  source.focus?.({ preventScroll: true });
  if (!selection || (typeof source.setSelectionRange !== "function")) return;
  restoringSelection = true;
  try {
    source.setSelectionRange(selection.start, selection.end, selection.direction);
  } finally {
    restoringSelection = false;
  }
}
