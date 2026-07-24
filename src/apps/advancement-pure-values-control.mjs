import { isAdvancementPureValueEffectKey } from "../advancement/pure-value-keys.mjs";

const FUNCTION_SELECTOR = "[data-ability-function-row][data-function-type='effectChanges']";
const KEY_SELECTOR = [
  "[data-ability-change-row] input[data-effect-key-autocomplete]",
  "[data-ability-penalty-row] input[data-effect-key-autocomplete]"
].join(", ");

export function activateAdvancementPureValuesControls(root = null) {
  for (const functionRow of root?.querySelectorAll?.(FUNCTION_SELECTOR) ?? []) {
    const syncVisibility = () => syncAdvancementPureValuesControl(functionRow);
    for (const input of functionRow.querySelectorAll(KEY_SELECTOR)) {
      input.addEventListener("input", syncVisibility);
      input.addEventListener("change", syncVisibility);
    }
    syncVisibility();
  }
}

function syncAdvancementPureValuesControl(functionRow) {
  const control = functionRow?.querySelector?.("[data-advancement-pure-values-toggle]");
  if (!control) return;
  const hasRelevantKey = Array.from(functionRow.querySelectorAll(KEY_SELECTOR))
    .some(input => isAdvancementPureValueEffectKey(input.value));
  control.hidden = !hasRelevantKey;
  if (!hasRelevantKey) {
    const checkbox = control.querySelector("[data-advancement-pure-values-input]");
    if (checkbox) checkbox.checked = false;
  }
}
