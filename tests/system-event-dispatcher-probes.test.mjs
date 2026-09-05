// codex-runtime-debug H21 temporary probe contract fixtures; no Foundry/gameplay access.
import assert from "node:assert/strict";
import test from "node:test";
import { createSystemEventDispatcher } from "../src/events/dispatcher.mjs";
import { SYSTEM_EVENT_CATALOG } from "../src/events/catalog.mjs";

const EVENT = "fallout-maw.damage.beforeApply";
const CHILD = "fallout-maw.damage.resolved";

async function withProbe(operation) {
  const previous = globalThis.__falloutMawGameplayProbe;
  let runKey = "private-run-id";
  const summaries = [];
  globalThis.__falloutMawGameplayProbe = {
    activeRunId: () => runKey,
    count() {},
    event(label, hypothesis, data) {
      assert.equal(label, "events.rootSummary");
      assert.equal(hypothesis, "H21");
      summaries.push(data);
    }
  };
  let id = 0;
  const make = limits => createSystemEventDispatcher({ limits, runtime: {
    getCurrentUserId: () => "private-user", getActiveGMId: () => "private-user",
    randomId: () => `private-document-${++id}`, logger: { warn() {}, error() {} }
  } });
  try { await operation({ make, summaries, setRun: value => { runKey = value; } }); }
  finally { globalThis.__falloutMawGameplayProbe = previous; }
}

test("inactive root probes collect nothing and active summaries exclude IDs and arbitrary input", async () => {
  await withProbe(async ({ make, summaries, setRun }) => {
    const dispatcher = make();
    setRun(null);
    await dispatcher.dispatchSystemEvent(EVENT, { value: "private-payload" });
    assert.equal(summaries.length, 0);
    setRun("private-run-id");
    await dispatcher.withSystemEventRoot({ kind: "private-kind", data: { secret: "private-root-data" } }, async scope => {
      await scope.emit("private-event-name", { value: "private-payload" });
    });
    assert.equal(summaries.length, 1);
    const summary = summaries[0];
    assert.equal(summary.rootKind, "other");
    assert.equal(summary.createdDuringRun, true);
    assert.deepEqual(summary.rejectedReasons, [{ reason: "unknownEvent", count: 1 }]);
    assert.equal(summary.eventTypes[0].eventKey, "other");
    assert.equal(JSON.stringify(summary).includes("private"), false);
  });
});

test("root summaries bound event type cardinality to 23 catalog types and other", async () => {
  await withProbe(async ({ make, summaries }) => {
    const dispatcher = make();
    await dispatcher.withSystemEventRoot({ kind: "weaponAttack" }, async scope => {
      for (const descriptor of SYSTEM_EVENT_CATALOG.slice(0, 40)) {
        const outcome = await scope.emit(descriptor.key, { value: 1 });
        assert.equal(outcome.ok, true);
      }
    });
    assert.equal(summaries.length, 1);
    const summary = summaries[0];
    assert.equal(summary.eventTypes.length, 24);
    assert.equal(summary.eventTypes.find(row => row.eventKey === "other").admitted, 17);
    assert.equal(summary.eventTypes.reduce((n, row) => n + row.attempted, 0), 40);
    assert.equal(summary.admittedTotal, 40);
  });
});

test("root summaries distinguish dedupe, native admission, event limits and inherited leases", async () => {
  await withProbe(async ({ make, summaries }) => {
    const dispatcher = make({ maxEventsPerRoot: 2, completedCacheSize: 1 });
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    dispatcher.registerSystemEventObserver({ id: "wait", eventKeys: EVENT, observe: () => barrier });
    await dispatcher.withSystemEventRoot({ kind: "weaponDamagePrepared" }, async scope => {
      const first = scope.emit(EVENT, {}, { occurrenceKey: "first" });
      const inflight = scope.emit(EVENT, {}, { occurrenceKey: "first" });
      release();
      await Promise.all([first, inflight]);
      await scope.emit(EVENT, {}, { occurrenceKey: "first" });
      await scope.emit(CHILD, {}, { occurrenceKey: "second" });
      await scope.emit(EVENT, {}, { occurrenceKey: "first" });
      const rejected = await scope.emit(CHILD, {}, { occurrenceKey: "third" });
      assert.equal(rejected.reason, "eventLimit");
      await dispatcher.withSystemEventRoot({ kind: "damageHub", chainRef: scope.chainRef }, async () => {});
    });
    const summary = summaries[0];
    assert.equal(summaries.length, 1);
    assert.equal(summary.admittedTotal, 2);
    assert.equal(summary.reactionsDisabled, true);
    assert.equal(summary.inheritedLeases, 1);
    assert.deepEqual(summary.leaseKinds, [{ kind: "damageHub", count: 1 }]);
    const first = summary.eventTypes.find(row => row.eventKey === EVENT);
    assert.deepEqual(first, { eventKey: EVENT, attempted: 4, admitted: 1, rejected: 0,
      completedDedupe: 1, rootDedupe: 1, inflightDedupe: 1 });
    assert.deepEqual(summary.rejectedReasons, [{ reason: "eventLimit", count: 1 }]);
    assert.equal(summary.maxDepth, 0);
    assert.equal(summary.maxLineage, 0);
  });
});

test("root summaries report actual recursive ancestry and reset collection across runs", async () => {
  await withProbe(async ({ make, summaries, setRun }) => {
    const dispatcher = make();
    dispatcher.registerSystemEventObserver({ id: "recursive", eventKeys: EVENT, observe: async ({ scope }) => {
      scope.consumeReactionBudget();
      await scope.emit(EVENT, {}, { occurrenceKey: "child" });
    } });
    await dispatcher.withSystemEventRoot({ kind: "weaponAttack" }, async scope => {
      await scope.emit(CHILD, {}, { occurrenceKey: "before-run-change" });
      setRun("private-next-run");
      await scope.emit(EVENT, {}, { occurrenceKey: "parent" });
    });
    const summary = summaries[0];
    assert.equal(summary.createdDuringRun, false);
    assert.equal(summary.eventTypes.some(row => row.eventKey === CHILD), false);
    assert.equal(summary.maxDepth, 1);
    assert.equal(summary.maxLineage, 1);
    assert.equal(summary.recursionSkips, 1);
    assert.equal(summary.reactionCount, 1);
    assert.equal(JSON.stringify(summary).includes("private"), false);
  });
});

test("throwing diagnostic activity, transport and counters cannot change root settlement", async () => {
  await withProbe(async ({ make }) => {
    const probe = globalThis.__falloutMawGameplayProbe;
    for (const failure of ["activeRunId", "event", "count"]) {
      const original = probe[failure];
      probe[failure] = () => { throw new Error(`diagnostic-${failure}`); };
      try {
        const dispatcher = make();
        let finalizations = 0;
        dispatcher.registerSystemEventRootFinalizer({ id: "finalize", finalize: () => { finalizations += 1; } });
        const result = await dispatcher.withSystemEventRoot({ kind: "weaponAttack" }, async scope => {
          const outcome = await scope.emit(EVENT, { value: 1 });
          assert.equal(outcome.ok, true);
          const failed = await scope.emit("unknown", { value: 2 });
          assert.equal(failed.reason, "unknownEvent");
          return outcome;
        });
        assert.equal(result.data.value, 1);
        assert.equal(finalizations, 1);
      } finally { probe[failure] = original; }
    }
  });
});
