import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runTerminalSystemEventWorkflow } from "../src/utils/system-event-workflow.mjs";

function createScope({ cancel = null } = {}) {
  const calls = [];
  return {
    calls,
    scope: {
      rootId: "root-1",
      chainRef: { version: 1, rootId: "root-1", leaseId: "lease-1" },
      async emit(key, payload, options) {
        calls.push({ key, payload, options });
        if (key.endsWith(".before") && cancel) {
          return {
            control: {
              current: cancel.scope === "current",
              remaining: cancel.scope === "remaining",
              root: cancel.scope === "root",
              reasons: [{ scope: cancel.scope, reason: cancel.reason }]
            }
          };
        }
        return { control: { current: false, remaining: false, root: false, reasons: [] } };
      }
    }
  };
}

test("terminal workflow awaits pre, operation, and exactly one resolved event in order", async () => {
  const { scope, calls } = createScope();
  const order = [];
  const originalEmit = scope.emit;
  scope.emit = async (...args) => {
    order.push(args[0]);
    return originalEmit(...args);
  };

  const result = await runTerminalSystemEventWorkflow({
    scope,
    beforeEventKey: "fallout-maw.skill.check.beforeRoll",
    resolvedEventKey: "fallout-maw.skill.check.resolved",
    occurrenceBase: "skill:one",
    participants: { source: { actorUuid: "Actor.A" }, target: null, related: [] },
    beforeData: { skillKey: "athletics" },
    resolvedData: ({ value, status }) => ({ resultKey: value.key, status }),
    operation: async () => {
      order.push("operation");
      return { key: "success" };
    }
  });

  assert.equal(result.success, true);
  assert.deepEqual(order, [
    "fallout-maw.skill.check.beforeRoll",
    "operation",
    "fallout-maw.skill.check.resolved"
  ]);
  assert.equal(calls.filter(call => call.key === "fallout-maw.skill.check.resolved").length, 1);
  assert.equal(calls[1].payload.outcome.status, "success");
  assert.equal(calls[1].options.occurrenceKey, "skill:one:resolved");
});

test("terminal workflow does not emit resolved until its completion barrier releases", async () => {
  const { scope, calls } = createScope();
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  let barrierReached;
  const reached = new Promise(resolve => { barrierReached = resolve; });

  const workflow = runTerminalSystemEventWorkflow({
    scope,
    resolvedEventKey: "fallout-maw.skill.check.resolved",
    occurrenceBase: "skill:presentation",
    operation: async () => ({ key: "success" }),
    beforeTerminal: async () => {
      barrierReached();
      await barrier;
    }
  });

  await reached;
  assert.equal(calls.length, 0);
  release();
  await workflow;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].key, "fallout-maw.skill.check.resolved");
});

test("pre cancellation skips the operation and still consumes one terminal event", async () => {
  const { scope, calls } = createScope({ cancel: { scope: "remaining", reason: "reaction" } });
  let operationCalls = 0;
  const result = await runTerminalSystemEventWorkflow({
    scope,
    beforeEventKey: "fallout-maw.item.use.before",
    resolvedEventKey: "fallout-maw.item.use.resolved",
    occurrenceBase: "item:one",
    operation: async () => {
      operationCalls += 1;
      return true;
    }
  });

  assert.equal(operationCalls, 0);
  assert.equal(result.cancelled, true);
  assert.equal(result.reason, "reaction");
  assert.equal(calls.filter(call => call.key === "fallout-maw.item.use.resolved").length, 1);
  assert.deepEqual(calls[1].payload.outcome, {
    success: false,
    cancelled: true,
    failed: false,
    status: "cancelled"
  });
});

test("operation errors are rethrown only after the error terminal event", async () => {
  const { scope, calls } = createScope();
  const error = Object.assign(new Error("roll failed"), { code: "ROLL_FAILED" });
  await assert.rejects(() => runTerminalSystemEventWorkflow({
    scope,
    beforeEventKey: "fallout-maw.ability.use.before",
    resolvedEventKey: "fallout-maw.ability.use.resolved",
    occurrenceBase: "ability:one",
    operation: async () => { throw error; }
  }), error);

  assert.equal(calls.length, 2);
  assert.equal(calls[1].payload.outcome.status, "error");
  assert.deepEqual(calls[1].payload.outcome.error, {
    name: "Error",
    message: "roll failed",
    code: "ROLL_FAILED"
  });
});

test("a forced pre-operation error also emits exactly one terminal event", async () => {
  const { scope, calls } = createScope();
  const error = new Error("selection failed");
  await assert.rejects(() => runTerminalSystemEventWorkflow({
    scope,
    resolvedEventKey: "fallout-maw.item.use.resolved",
    occurrenceBase: "item:selection",
    forcedResult: { status: "error", reason: "targetSelectionError", error }
  }), error);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].key, "fallout-maw.item.use.resolved");
  assert.equal(calls[0].payload.outcome.status, "error");
});

test("workflow entry points expose every V1 skill/item/ability event pair", async () => {
  const [skillSource, itemSource, abilitySource] = await Promise.all([
    readFile(new URL("../src/rolls/skill-check.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/items/active-item-use.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/abilities/fixed-functions.mjs", import.meta.url), "utf8")
  ]);

  for (const key of [
    "fallout-maw.skill.check.beforeRoll",
    "fallout-maw.skill.check.resolved",
    "fallout-maw.skill.batch.resolved"
  ]) assert.match(skillSource, new RegExp(key.replaceAll(".", "\\.")));
  for (const key of ["fallout-maw.item.use.before", "fallout-maw.item.use.resolved"]) {
    assert.match(itemSource, new RegExp(key.replaceAll(".", "\\.")));
  }
  for (const key of [
    "fallout-maw.ability.use.before",
    "fallout-maw.ability.use.resolved",
    "fallout-maw.ability.application.before",
    "fallout-maw.ability.application.resolved"
  ]) assert.match(abilitySource, new RegExp(key.replaceAll(".", "\\.")));
});

test("legacy itemUsed is post-mirror only and never an ingress into system events", async () => {
  const [triggerSource, compatibilitySource, itemUseSource] = await Promise.all([
    readFile(new URL("../src/abilities/item-use-triggers.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/events/foundry-compatibility-events.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/items/active-item-use.mjs", import.meta.url), "utf8")
  ]);

  assert.doesNotMatch(triggerSource, /Hooks\.on\(["']fallout-maw\.itemUsed/);
  assert.doesNotMatch(compatibilitySource, /Hooks\.on\(["']fallout-maw\.itemUsed/);
  assert.match(triggerSource, /registerSystemEventObserver/);
  assert.match(triggerSource, /fallout-maw\.item\.use\.resolved/);
  assert.match(itemUseSource, /Hooks\.callAll\(["']fallout-maw\.itemUsed/);
  assert.match(itemUseSource, /falloutMawSemanticMirror:\s*true/);
  for (const key of [
    "fallout-maw.item.oneTimeUse.resolved",
    "fallout-maw.item.needChange.resolved",
    "fallout-maw.medicine.firstAid.resolved"
  ]) assert.match(itemUseSource, new RegExp(key.replaceAll(".", "\\.")));
});
