import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("scalar autosubmit preserves the live target control without suppressing unrelated renders", async t => {
  const {
    createFormSelfRenderSuppressionController
  } = await import("../src/utils/form-self-render-suppression.mjs");

  await t.test("the originating updateItem render cannot replace B after change A", async () => {
    const controller = createFormSelfRenderSuppressionController();
    const source = createControl("INPUT", { type: "number", name: "damage", value: "60" });
    const target = createControl("INPUT", { type: "number", name: "critical", value: "150" });
    const gate = createDeferred();
    let activeControl = target;
    let renderedControl = target;
    let renderCount = 0;

    // The browser has already completed the ordinary pointerdown on B while
    // the async Document.update submitted by change(A) is in flight.
    target.caret = 2;

    const render = renderContext => {
      if (controller.shouldSuppress(renderContext)) return false;
      renderCount += 1;
      renderedControl = createControl("INPUT", {
        type: target.type,
        name: target.name,
        value: target.value
      });
      renderedControl.caret = 0;
      activeControl = renderedControl;
      return true;
    };

    const submission = controller.run({ type: "change", target: source }, async () => {
      // This models the render triggered by the response to this exact Item
      // update. Replacing the form here would destroy B and its native caret.
      assert.equal(render("updateItem"), false);
      await gate.promise;
    });

    assert.equal(renderCount, 0);
    assert.equal(renderedControl, target);
    assert.equal(activeControl, target);
    assert.equal(target.caret, 2);

    gate.resolve();
    await submission;

    // Suppression is scoped to one in-flight scalar submission. A subsequent
    // update, including one received from another user, renders normally.
    assert.equal(render("updateItem"), true);
    assert.equal(renderCount, 1);
    assert.notEqual(renderedControl, target);
  });

  await t.test("non-Item render contexts are never hidden by the marker", async () => {
    const controller = createFormSelfRenderSuppressionController();
    const source = createControl("TEXTAREA", { name: "description", value: "changed" });
    const gate = createDeferred();

    const submission = controller.run({ type: "change", target: source }, () => gate.promise);

    assert.equal(controller.shouldSuppress("updateActor"), false);
    assert.equal(controller.shouldSuppress("updateActiveEffect"), false);
    assert.equal(controller.shouldSuppress("manual"), false);
    assert.equal(controller.shouldSuppress("updateItem"), true);

    gate.resolve();
    await submission;
    assert.equal(controller.shouldSuppress("updateItem"), false);
  });

  await t.test("a concurrent unrelated Item update is not mistaken for the local field commit", async () => {
    const controller = createFormSelfRenderSuppressionController();
    const source = createControl("INPUT", {
      type: "number",
      name: "system.damage",
      value: "60"
    });
    const gate = createDeferred();
    const submission = controller.run({ type: "change", target: source }, () => gate.promise);

    assert.equal(controller.shouldSuppress("updateItem", {
      system: { condition: 375 }
    }), false);
    assert.equal(controller.shouldSuppress("updateItem", {
      system: { damage: 60 }
    }), true);
    assert.equal(controller.shouldSuppress("updateItem", {
      "system.damage": 60
    }), true);

    gate.resolve();
    await submission;
  });

  await t.test("select and checkbox changes retain normal structural renders", async () => {
    for (const control of [
      createControl("SELECT", { name: "mode", value: "burst" }),
      createControl("INPUT", { type: "checkbox", name: "equipped", checked: true })
    ]) {
      const controller = createFormSelfRenderSuppressionController();
      let rendered = false;

      await controller.run({ type: "change", target: control }, async () => {
        if (!controller.shouldSuppress("updateItem")) rendered = true;
      });

      assert.equal(rendered, true, `${control.tagName}:${control.type} must render`);
      assert.equal(controller.shouldSuppress("updateItem"), false);
    }
  });

  await t.test("a failed scalar submit cannot leave suppression armed", async () => {
    const controller = createFormSelfRenderSuppressionController();
    const source = createControl("INPUT", { type: "text", name: "name", value: "changed" });
    const expected = new Error("update rejected");

    await assert.rejects(
      controller.run({ type: "change", target: source }, async () => {
        assert.equal(controller.shouldSuppress("updateItem"), true);
        throw expected;
      }),
      expected
    );

    assert.equal(controller.shouldSuppress("updateItem"), false);
  });

  await t.test("ItemSheet preserves Foundry's two-argument render contract and gates the queued write", async () => {
    const source = await readFile(
      new URL("../src/sheets/item-sheet.mjs", import.meta.url),
      "utf8"
    );

    assert.match(source, /render\(options = \{\}, legacyOptions = \{\}\)/);
    assert.match(source, /super\.render\(options, legacyOptions\)/);
    assert.match(
      source,
      /#selfRenderSuppression\.shouldSuppress\(\s*renderOptions\?\.renderContext,\s*renderOptions\?\.renderData/
    );
    assert.match(
      source,
      /#selfRenderSuppression\.run\(\s*event,\s*\(\) => super\._processSubmitData/
    );
    assert.doesNotMatch(source, /_processSubmitData[\s\S]{0,500}render:\s*false/);
  });
});

function createControl(tagName, properties = {}) {
  return {
    tagName,
    type: "",
    name: "",
    value: "",
    checked: false,
    caret: null,
    ...properties
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
