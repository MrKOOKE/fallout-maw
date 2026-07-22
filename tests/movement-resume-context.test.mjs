import assert from "node:assert/strict";
import test from "node:test";

import {
  getMovementResumeContext,
  withMovementResumeContext
} from "../src/canvas/movement-resume-context.mjs";

test("private movement resume metadata follows native checkpoint chains", async () => {
  const token = { uuid: "Scene.scene.Token.mover" };
  const marker = "systemResume";
  const data = { skipped: new Set(["observer"]) };

  await withMovementResumeContext(token, marker, data, async context => {
    assert.equal(getMovementResumeContext(token, { id: "chunk-1", chain: [] }, {
      [marker]: true
    }, marker), context);
    assert.equal(getMovementResumeContext(token, {
      id: "chunk-2",
      chain: ["chunk-1"]
    }, {}, marker), context);
    assert.equal(context.data, data);
    assert.equal(getMovementResumeContext(token, {
      id: "unrelated",
      chain: ["another-move"]
    }, {}, marker), null);
  });

  assert.equal(getMovementResumeContext(token, {
    id: "chunk-3",
    chain: ["chunk-2"]
  }, {}, marker), null);
});
