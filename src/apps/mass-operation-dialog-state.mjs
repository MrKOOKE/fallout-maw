const dialogFormBindings = new WeakMap();

/**
 * Read the live checkbox state which makes a mass-operation dialog submittable.
 *
 * @param {HTMLFormElement|object|null} form
 * @param {object} [options]
 * @param {string[]} [options.categoryNames]
 * @param {string} [options.toolGroupName]
 * @returns {{
 *   hasCategorySelection: boolean,
 *   hasToolGroupSelection: boolean,
 *   valid: boolean
 * }}
 */
export function getMassOperationDialogSelectionState(form, {
  categoryNames = [],
  toolGroupName = "toolGroup"
} = {}) {
  const categorySet = new Set(
    categoryNames
      .map(name => String(name ?? "").trim())
      .filter(Boolean)
  );
  const normalizedToolGroupName = String(toolGroupName ?? "toolGroup").trim();
  const inputs = Array.from(form?.querySelectorAll?.("input") ?? []);
  const hasCategorySelection = categorySet.size === 0 || inputs.some(input => (
    Boolean(input?.checked)
    && categorySet.has(String(input?.name ?? "").trim())
  ));
  const hasToolGroupSelection = inputs.some(input => (
    Boolean(input?.checked)
    && String(input?.name ?? "").trim() === normalizedToolGroupName
    && String(input?.value ?? "").trim().length > 0
  ));
  return {
    hasCategorySelection,
    hasToolGroupSelection,
    valid: hasCategorySelection && hasToolGroupSelection
  };
}

/**
 * Bind the DialogV2 confirmation button to the live form state.
 *
 * DialogV2 always closes after submission; a button callback returning false does
 * not veto that close. Invalid choices therefore have to be blocked by the native
 * disabled state before DialogV2 begins submission.
 *
 * @param {object|null} dialog
 * @param {object} [options]
 * @param {string[]} [options.categoryNames]
 * @param {string} [options.toolGroupName]
 * @param {string} [options.submitAction]
 * @returns {{refresh: Function, destroy: Function}|null}
 */
export function bindMassOperationDialogSubmitState(dialog, {
  categoryNames = [],
  toolGroupName = "toolGroup",
  submitAction = "ok"
} = {}) {
  const form = dialog?.element?.querySelector?.("form") ?? null;
  const submitButton = form?.querySelector?.(`button[data-action="${submitAction}"]`) ?? null;
  if (!form || !submitButton) return null;

  dialogFormBindings.get(form)?.destroy();

  const refresh = () => {
    const state = getMassOperationDialogSelectionState(form, {
      categoryNames,
      toolGroupName
    });
    submitButton.disabled = !state.valid;
    return state;
  };
  const onChange = () => refresh();
  const binding = {
    refresh,
    destroy() {
      form.removeEventListener?.("change", onChange);
      if (dialogFormBindings.get(form) === binding) dialogFormBindings.delete(form);
    }
  };
  dialogFormBindings.set(form, binding);
  form.addEventListener?.("change", onChange);
  refresh();
  return binding;
}
