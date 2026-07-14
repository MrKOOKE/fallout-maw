/**
 * Run one target-atomic system workflow and guarantee one terminal event after
 * its optional pre-event. The caller owns the surrounding system-event root.
 *
 * This module deliberately has no Foundry dependencies so workflow semantics
 * can be covered by plain Node tests.
 */
export async function runTerminalSystemEventWorkflow({
  scope,
  beforeEventKey = "",
  resolvedEventKey = "",
  occurrenceBase = "workflow",
  participants = {},
  beforeData = {},
  resolvedData = null,
  before = null,
  after = null,
  operation,
  isSuccess = value => Boolean(value),
  getResultStatus = null,
  getResultReason = null,
  forcedResult = null
} = {}) {
  if (!scope?.emit || !resolvedEventKey) {
    throw new TypeError("A system-event scope and resolvedEventKey are required.");
  }
  if (typeof operation !== "function" && !forcedResult) {
    throw new TypeError("A system-event workflow operation is required.");
  }

  let gate = null;
  let value = forcedResult?.value;
  let error = forcedResult?.error ?? null;
  let status = normalizeTerminalStatus(forcedResult?.status);
  let reason = String(forcedResult?.reason ?? "").trim();

  if (!forcedResult && beforeEventKey) {
    gate = await scope.emit(beforeEventKey, {
      data: resolveValue(beforeData, createTerminalContext({ gate, value, status, reason, error })),
      ...(before === null ? {} : { before: resolveValue(before, null) })
    }, {
      occurrenceKey: `${occurrenceBase}:before`,
      participants
    });
    if (isSystemEventCancelled(gate)) {
      status = "cancelled";
      reason = getSystemEventCancellationReason(gate) || "cancelled";
    }
  }

  if (!forcedResult && status !== "cancelled") {
    try {
      value = await operation({ gate, scope });
      status = normalizeTerminalStatus(typeof getResultStatus === "function" ? getResultStatus(value) : "")
        || (isSuccess(value) ? "success" : "failed");
      reason = String(typeof getResultReason === "function" ? getResultReason(value, status) : "").trim()
        || (status === "success" ? "resolved" : status);
    } catch (caught) {
      error = caught;
      status = "error";
      reason = "error";
    }
  }

  const terminalContext = createTerminalContext({ gate, value, status, reason, error });
  await scope.emit(resolvedEventKey, {
    data: resolveValue(resolvedData, terminalContext) ?? {},
    ...(after === null ? {} : { after: resolveValue(after, terminalContext) }),
    outcome: {
      success: status === "success",
      cancelled: status === "cancelled",
      failed: status === "failed" || status === "error",
      status,
      ...(error ? { error: serializeSystemWorkflowError(error) } : {})
    },
    reason
  }, {
    occurrenceKey: `${occurrenceBase}:resolved`,
    participants
  });

  if (error) throw error;
  return terminalContext;
}

export function isSystemEventCancelled(result = null) {
  return Boolean(result?.control?.current || result?.control?.remaining || result?.control?.root);
}

export function getSystemEventCancellationReason(result = null) {
  const reasons = Array.isArray(result?.control?.reasons) ? result.control.reasons : [];
  return String(reasons.at(-1)?.reason ?? "").trim();
}

export function serializeSystemWorkflowError(error) {
  return {
    name: String(error?.name ?? "Error"),
    message: String(error?.message ?? error ?? "Unknown workflow error"),
    ...(error?.code !== undefined ? { code: String(error.code) } : {})
  };
}

function createTerminalContext({ gate, value, status, reason, error }) {
  return Object.freeze({
    gate,
    value,
    status,
    reason,
    cancelled: status === "cancelled",
    success: status === "success",
    error
  });
}

function normalizeTerminalStatus(value) {
  const status = String(value ?? "").trim();
  return ["success", "cancelled", "failed", "error"].includes(status) ? status : "";
}

function resolveValue(value, context) {
  return typeof value === "function" ? value(context) : value;
}
