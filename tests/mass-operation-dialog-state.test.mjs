import assert from "node:assert/strict";
import test from "node:test";

import {
  bindMassOperationDialogSubmitState,
  getMassOperationDialogSelectionState
} from "../src/apps/mass-operation-dialog-state.mjs";

function createCheckbox(name, value, checked = false) {
  return { name, value, checked };
}

function createDialogHarness(inputs) {
  const listeners = new Map();
  const submitButton = { disabled: false };
  const form = {
    querySelector(selector) {
      return selector === 'button[data-action="ok"]' ? submitButton : null;
    },
    querySelectorAll(selector) {
      return selector === "input" ? inputs : [];
    },
    addEventListener(type, listener) {
      const registered = listeners.get(type) ?? new Set();
      registered.add(listener);
      listeners.set(type, registered);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    }
  };
  const dialog = {
    element: {
      querySelector(selector) {
        return selector === "form" ? form : null;
      }
    }
  };
  return {
    dialog,
    form,
    submitButton,
    dispatch(type) {
      for (const listener of listeners.get(type) ?? []) listener({ type });
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    }
  };
}

test("mass medicine confirmation follows live category and tool-group choices", () => {
  const trauma = createCheckbox("includeTraumas", "on", true);
  const limbHealth = createCheckbox("includeLimbHealth", "on", true);
  const tools = createCheckbox("toolGroup", "medical:D", true);
  const harness = createDialogHarness([trauma, limbHealth, tools]);

  const binding = bindMassOperationDialogSubmitState(harness.dialog, {
    categoryNames: ["includeTraumas", "includeLimbHealth"]
  });
  assert.ok(binding);
  assert.equal(harness.submitButton.disabled, false);

  trauma.checked = false;
  limbHealth.checked = false;
  harness.dispatch("change");
  assert.equal(harness.submitButton.disabled, true);

  limbHealth.checked = true;
  harness.dispatch("change");
  assert.equal(harness.submitButton.disabled, false);

  tools.checked = false;
  harness.dispatch("change");
  assert.equal(harness.submitButton.disabled, true);

  tools.checked = true;
  harness.dispatch("change");
  assert.equal(harness.submitButton.disabled, false);
});

test("mass repair confirmation requires a non-empty selected tool group", () => {
  const blankGroup = createCheckbox("toolGroup", "   ", true);
  const validGroup = createCheckbox("toolGroup", "repair:C", false);
  const harness = createDialogHarness([blankGroup, validGroup]);

  const binding = bindMassOperationDialogSubmitState(harness.dialog);
  assert.ok(binding);
  assert.equal(harness.submitButton.disabled, true);

  validGroup.checked = true;
  harness.dispatch("change");
  assert.equal(harness.submitButton.disabled, false);

  const state = getMassOperationDialogSelectionState(harness.form);
  assert.deepEqual(state, {
    hasCategorySelection: true,
    hasToolGroupSelection: true,
    valid: true
  });
});

test("rebinding a rendered DialogV2 form replaces its old change listener", () => {
  const tools = createCheckbox("toolGroup", "repair:D", true);
  const harness = createDialogHarness([tools]);

  const first = bindMassOperationDialogSubmitState(harness.dialog);
  const second = bindMassOperationDialogSubmitState(harness.dialog);
  assert.ok(first);
  assert.ok(second);
  assert.equal(harness.listenerCount("change"), 1);

  second.destroy();
  assert.equal(harness.listenerCount("change"), 0);
});
