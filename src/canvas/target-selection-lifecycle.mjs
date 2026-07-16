export const CANVAS_TARGET_SELECTION_STARTED_HOOK = "fallout-maw.canvasTargetSelectionStarted";
export const CANVAS_TARGET_SELECTION_FINISHED_HOOK = "fallout-maw.canvasTargetSelectionFinished";

export function startCanvasTargetSelectionSession(context = {}) {
  const sessionId = String(context?.sessionId ?? "").trim() || foundry.utils.randomID();
  const sessionContext = {
    ...context,
    sessionId
  };
  let finished = false;
  Hooks.callAll(CANVAS_TARGET_SELECTION_STARTED_HOOK, sessionContext);
  return {
    sessionId,
    finish(outcome = {}) {
      if (finished) return false;
      finished = true;
      Hooks.callAll(CANVAS_TARGET_SELECTION_FINISHED_HOOK, {
        ...sessionContext,
        ...outcome,
        sessionId,
        cancelled: Boolean(outcome?.cancelled)
      });
      return true;
    }
  };
}
