const TEXT_CONTROL_SELECTOR = [
  "textarea",
  "input:not([type='hidden']):not([type='button']):not([type='checkbox']):not([type='color']):not([type='file']):not([type='image']):not([type='radio']):not([type='range']):not([type='reset']):not([type='submit'])"
].join(", ");

const TEXT_SELECTION_STATE_KEY = "falloutMawTextSelection";

export function preserveTextSelectionBeforePartSync(priorElement, state) {
  if (!priorElement || !state) return;
  const active = priorElement.querySelector(":focus");
  const control = active?.closest?.(TEXT_CONTROL_SELECTOR);
  const selection = captureTextSelection(control);
  if (!selection) return;

  state[TEXT_SELECTION_STATE_KEY] = {
    selector: getTextControlSelector(control),
    value: String(control.value ?? ""),
    selection
  };
}

export function restoreTextSelectionAfterPartSync(newElement, state) {
  const saved = state?.[TEXT_SELECTION_STATE_KEY];
  if (!newElement || !saved?.selector) return;

  const control = newElement.querySelector(saved.selector);
  if (!control || String(control.value ?? "") !== saved.value) return;
  if (typeof control.setSelectionRange !== "function") return;

  const length = String(control.value ?? "").length;
  control.setSelectionRange(
    clampSelectionIndex(saved.selection.start, length),
    clampSelectionIndex(saved.selection.end, length),
    saved.selection.direction
  );
}

function captureTextSelection(control) {
  if (!control || typeof control.selectionStart !== "number" || typeof control.selectionEnd !== "number") return null;
  return {
    start: control.selectionStart,
    end: control.selectionEnd,
    direction: control.selectionDirection ?? "none"
  };
}

function getTextControlSelector(control) {
  if (control.id) return `#${CSS.escape(control.id)}`;
  if (control.name) return `${control.tagName}[name="${CSS.escape(control.name)}"]`;
  const field = control.dataset?.field;
  if (field) return `${control.tagName}[data-field="${CSS.escape(field)}"]`;
  return "";
}

function clampSelectionIndex(value, max) {
  return Math.max(0, Math.min(Math.max(0, Number(max) || 0), Number(value) || 0));
}
