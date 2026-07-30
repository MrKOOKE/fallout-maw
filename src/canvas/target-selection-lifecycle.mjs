export const CANVAS_TARGET_SELECTION_STARTED_HOOK = "fallout-maw.canvasTargetSelectionStarted";
export const CANVAS_TARGET_SELECTION_FINISHED_HOOK = "fallout-maw.canvasTargetSelectionFinished";

let activeCanvasTargetSelectionSession = null;
let lifecycleHooksRegistered = false;
let canvasTargetSelectionGeneration = 0;

export function registerCanvasTargetSelectionLifecycleHooks() {
  if (lifecycleHooksRegistered) return;
  lifecycleHooksRegistered = true;
  Hooks.on("canvasTearDown", () => {
    cancelActiveCanvasTargetSelection({
      reason: "canvasTearDown"
    });
  });
}

export function getActiveCanvasTargetSelectionSession() {
  return activeCanvasTargetSelectionSession;
}

export function cancelActiveCanvasTargetSelection(outcome = {}) {
  return activeCanvasTargetSelectionSession?.cancel?.({
    ...outcome,
    cancelled: true
  }) ?? false;
}

export function startCanvasTargetSelectionSession(context = {}, {
  onCancel = null
} = {}) {
  const generation = ++canvasTargetSelectionGeneration;
  const sessionId = String(context?.sessionId ?? "").trim() || foundry.utils.randomID();
  const sessionContext = {
    ...context,
    sessionId
  };
  const previousSession = activeCanvasTargetSelectionSession;
  let finished = false;
  let started = false;
  let finalOutcome = null;
  const session = {
    sessionId,
    get active() {
      return !finished && activeCanvasTargetSelectionSession === session;
    },
    get finished() {
      return finished;
    },
    get started() {
      return started;
    },
    get outcome() {
      return finalOutcome;
    },
    finish(outcome = {}) {
      return settleSession(outcome);
    },
    cancel(outcome = {}) {
      return settleSession({
        ...outcome,
        cancelled: true
      }, { notifyOwner: true });
    }
  };

  function settleSession(outcome = {}, {
    notifyOwner = false,
    emitFinishedHook = started
  } = {}) {
    if (finished) return false;
    finished = true;
    finalOutcome = {
      ...sessionContext,
      ...outcome,
      sessionId,
      cancelled: Boolean(outcome?.cancelled)
    };
    if (activeCanvasTargetSelectionSession === session) activeCanvasTargetSelectionSession = null;
    if (notifyOwner && typeof onCancel === "function") {
      try {
        onCancel(finalOutcome);
      } catch (error) {
        console.error("fallout-maw | Canvas target-selection owner cancellation failed", error);
      }
    }
    if (emitFinishedHook) Hooks.callAll(CANVAS_TARGET_SELECTION_FINISHED_HOOK, finalOutcome);
    return true;
  }

  previousSession?.cancel?.({
    reason: "superseded",
    supersededBySessionId: sessionId
  });

  // A cancellation callback or FINISHED hook is allowed to synchronously open
  // another selector. That nested invocation is newer and must remain owner;
  // abandon this never-announced session without overwriting it.
  if (generation !== canvasTargetSelectionGeneration) {
    settleSession({
      cancelled: true,
      reason: "supersededDuringStart",
      supersededBySessionId: activeCanvasTargetSelectionSession?.sessionId ?? ""
    }, {
      notifyOwner: true,
      emitFinishedHook: false
    });
    return session;
  }

  activeCanvasTargetSelectionSession = session;
  started = true;
  Hooks.callAll(CANVAS_TARGET_SELECTION_STARTED_HOOK, sessionContext);
  return session;
}
