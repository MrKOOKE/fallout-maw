import { isTargetInFirstAidRange, useFirstAidItem } from "./first-aid.mjs";
import { openLightSourceEnergyDialog } from "./light-source.mjs";
import { useNeedChangeItem } from "./need-change.mjs";
import { useOneTimeUseItem } from "./one-time-use.mjs";
import { requestCustomActorTokenSelection } from "../canvas/custom-token-selection.mjs";
import { startTrapPlacement } from "../canvas/traps.mjs";
import { isActorUnableToAct, isReactionSystemLocked } from "../combat/reaction-hub.mjs";
import { ITEM_FUNCTIONS, getFirstAidFunction, hasItemFunction, isActiveItem, resolveActorItemOrInstalledModule } from "../utils/item-functions.mjs";
import { withSystemEventRoot } from "../events/dispatcher.mjs";
import {
  runTerminalSystemEventWorkflow,
  serializeSystemWorkflowError
} from "../utils/system-event-workflow.mjs";

export function canUseActiveItem(item = null) {
  return Boolean(item?.actor?.isOwner && isActiveItem(item));
}

export async function useActiveItem({
  actor = null,
  token = null,
  item = null,
  application = null,
  targetActor = null,
  targetToken = null,
  chainRef = null,
  options = {},
  source = {}
} = {}) {
  if (isReactionSystemLocked()) {
    ui.notifications.warn("Ожидание реакций: предмет временно заблокирован.");
    return false;
  }
  const sourceActor = actor ?? item?.actor ?? token?.actor ?? token?.document?.actor ?? null;
  if (!sourceActor?.isOwner || !item || !canUseActiveItem(item)) return false;
  if (isActorUnableToAct(sourceActor)) {
    ui.notifications.warn(`${sourceActor.name}: невозможно использовать предмет без сознания или после смерти.`);
    return false;
  }

  const freshItem = resolveActorItemOrInstalledModule(sourceActor, item.id) ?? item;
  const sourceToken = resolveActorToken(sourceActor, token);
  const inheritedChainRef = chainRef
    ?? options?.falloutMawSystemEventChainRef
    ?? options?.chainRef
    ?? source?.chainRef
    ?? null;
  const operationId = String(options?.operationId ?? source?.operationId ?? "").trim() || foundry.utils.randomID();
  const useOccurrenceId = String(options?.occurrenceId ?? source?.occurrenceId ?? "").trim() || foundry.utils.randomID();

  return withSystemEventRoot({
    kind: "itemUse",
    operationId: `item-use:${operationId}`,
    sceneUuid: String(sourceToken?.parent?.uuid ?? sourceToken?.scene?.uuid ?? canvas?.scene?.uuid ?? ""),
    combatUuid: String(game.combat?.uuid ?? ""),
    chainRef: inheritedChainRef
  }, async scope => {
    const eventSource = {
      ...source,
      chainRef: scope.chainRef
    };

    if (hasItemFunction(freshItem, ITEM_FUNCTIONS.lightSource)) {
      await openLightSourceEnergyDialog({
        actor: sourceActor,
        token: sourceToken,
        item: freshItem,
        application,
        showToggle: true,
        chainRef: scope.chainRef,
        options: createSystemEventDocumentOptions(scope.chainRef)
      });
      return true;
    }
    if (hasItemFunction(freshItem, ITEM_FUNCTIONS.trap)) {
      return startTrapPlacement({
        actor: sourceActor,
        token: sourceToken,
        item: freshItem,
        application,
        chainRef: scope.chainRef,
        options: createSystemEventDocumentOptions(scope.chainRef)
      });
    }

    if (hasItemFunction(freshItem, ITEM_FUNCTIONS.oneTimeUse)) {
      return executeActiveItemUse(scope, {
        occurrenceId: useOccurrenceId,
        action: "oneTimeUse",
        sourceActor,
        sourceToken,
        targetActor: sourceActor,
        targetToken: sourceToken,
        item: freshItem,
        application,
        operation: () => useOneTimeUseItem({
          actor: sourceActor,
          item: freshItem,
          source: eventSource,
          options: createSystemEventDocumentOptions(scope.chainRef)
        })
      });
    }

    const isFirstAid = hasItemFunction(freshItem, ITEM_FUNCTIONS.firstAid);
    let target;
    try {
      target = targetActor
        ? { actor: targetActor, token: targetToken?.document ?? targetToken ?? null }
        : (isFirstAid
          ? await requestFirstAidItemTarget(sourceActor, sourceToken, freshItem)
          : resolveActiveItemTarget(sourceActor, sourceToken));
    } catch (error) {
      return executeActiveItemUse(scope, {
        occurrenceId: useOccurrenceId,
        action: isFirstAid ? "firstAid" : "needChange",
        sourceActor,
        sourceToken,
        item: freshItem,
        application,
        forcedResult: { status: "error", reason: "targetSelectionError", value: false, error }
      });
    }
    if (!target?.actor) {
      return executeActiveItemUse(scope, {
        occurrenceId: useOccurrenceId,
        action: isFirstAid ? "firstAid" : "needChange",
        sourceActor,
        sourceToken,
        item: freshItem,
        application,
        forcedResult: { status: "cancelled", reason: "targetSelectionCancelled", value: false }
      });
    }

    return executeActiveItemUse(scope, {
      occurrenceId: useOccurrenceId,
      action: isFirstAid ? "firstAid" : "needChange",
      sourceActor,
      sourceToken,
      targetActor: target.actor,
      targetToken: target.token,
      item: freshItem,
      application,
      operation: isFirstAid
        ? () => useFirstAidItem({
          sourceActor,
          sourceToken,
          targetActor: target.actor,
          targetToken: target.token,
          item: freshItem,
          source: eventSource,
          chainRef: scope.chainRef,
          options: createSystemEventDocumentOptions(scope.chainRef)
        })
        : () => useNeedChangeItem({
          targetActor: target.actor,
          item: freshItem,
          source: eventSource,
          chainRef: scope.chainRef,
          options: createSystemEventDocumentOptions(scope.chainRef)
        })
    });
  });
}

async function executeActiveItemUse(scope, {
  occurrenceId = "use",
  action = "itemUse",
  sourceActor = null,
  sourceToken = null,
  targetActor = null,
  targetToken = null,
  item = null,
  application = null,
  operation = null,
  forcedResult = null
} = {}) {
  const participants = {
    source: createItemUseParticipant(sourceActor, sourceToken, item),
    target: createItemUseParticipant(targetActor, targetToken),
    related: []
  };
  const occurrenceBase = `item-use:${scope.rootId}:${occurrenceId}:${String(item?.uuid ?? item?.id ?? "item")}:${action}`;
  let workflow;
  try {
    workflow = await runTerminalSystemEventWorkflow({
      scope,
      beforeEventKey: "fallout-maw.item.use.before",
      resolvedEventKey: "fallout-maw.item.use.resolved",
      occurrenceBase,
      participants,
      beforeData: buildItemUseEventData({ action, sourceActor, targetActor, item }),
      resolvedData: ({ status }) => ({
        ...buildItemUseEventData({ action, sourceActor, targetActor, item }),
        status
      }),
      operation,
      forcedResult
    });
  } catch (error) {
    await emitSpecializedItemUseResolved(scope, {
      action,
      sourceActor,
      targetActor,
      item,
      participants,
      occurrenceBase,
      status: "error",
      reason: "error",
      error
    });
    throw error;
  }
  await emitSpecializedItemUseResolved(scope, {
    action,
    sourceActor,
    targetActor,
    item,
    participants,
    occurrenceBase,
    status: workflow.status,
    reason: workflow.reason
  });
  const used = workflow.success && Boolean(workflow.value);
  if (used) {
    Hooks.callAll("fallout-maw.itemUsed", {
      actor: sourceActor,
      targetActor,
      token: sourceToken,
      targetToken,
      item,
      action,
      chainRef: scope.chainRef,
      source: { chainRef: scope.chainRef },
      falloutMawSemanticMirror: true
    });
  }
  if (used) await application?.render?.({ force: true });
  return used;
}

async function emitSpecializedItemUseResolved(scope, {
  action = "",
  sourceActor = null,
  targetActor = null,
  item = null,
  participants = {},
  occurrenceBase = "item-use",
  status = "failed",
  reason = "failed",
  error = null
} = {}) {
  const eventKey = ({
    oneTimeUse: "fallout-maw.item.oneTimeUse.resolved",
    needChange: "fallout-maw.item.needChange.resolved",
    firstAid: "fallout-maw.medicine.firstAid.resolved"
  })[action];
  if (!eventKey) return;
  await scope.emit(eventKey, {
    data: {
      ...buildItemUseEventData({ action, sourceActor, targetActor, item }),
      status
    },
    outcome: {
      success: status === "success",
      cancelled: status === "cancelled",
      failed: status === "failed" || status === "error",
      status,
      ...(error ? { error: serializeSystemWorkflowError(error) } : {})
    },
    reason
  }, {
    occurrenceKey: `${occurrenceBase}:specialized:resolved`,
    participants
  });
}

function buildItemUseEventData({ action = "", sourceActor = null, targetActor = null, item = null } = {}) {
  return {
    action: String(action ?? ""),
    item: {
      uuid: String(item?.uuid ?? ""),
      id: String(item?.id ?? ""),
      name: String(item?.name ?? ""),
      type: String(item?.type ?? ""),
      itemCategory: String(item?.system?.itemCategory ?? "")
    },
    sourceActorUuid: String(sourceActor?.uuid ?? ""),
    targetActorUuid: String(targetActor?.uuid ?? "")
  };
}

function createItemUseParticipant(actor = null, token = null, item = null) {
  const tokenDocument = token?.document ?? token ?? null;
  const participant = {
    actorUuid: String(actor?.uuid ?? tokenDocument?.actor?.uuid ?? "").trim(),
    tokenUuid: String(tokenDocument?.uuid ?? "").trim(),
    itemUuid: String(item?.uuid ?? "").trim()
  };
  return Object.values(participant).some(Boolean) ? participant : null;
}

function createSystemEventDocumentOptions(chainRef = null) {
  return chainRef
    ? { chainRef, falloutMawSystemEventChainRef: chainRef }
    : {};
}

async function requestFirstAidItemTarget(sourceActor = null, sourceToken = null, item = null) {
  const firstAid = getFirstAidFunction(item);
  const selected = await requestCustomActorTokenSelection({
    sourceActor,
    sourceToken,
    includeSelf: true,
    title: "Первая помощь",
    noneWarning: "Нет подходящих целей для первой помощи.",
    instructions: "Первая помощь: выберите цель. Esc/ПКМ отменяет.",
    getReason: ({ token }) => {
      if (isTargetInFirstAidRange(sourceToken, token, firstAid, { warn: false })) return "";
      return "Цель слишком далеко.";
    }
  });
  if (!selected?.actor) return { actor: null, token: null };
  return {
    actor: selected.actor,
    token: selected.token?.document ?? selected.token
  };
}

function resolveActiveItemTarget(actor = null, sourceToken = null) {
  const targetToken = Array.from(game.user?.targets ?? [])
    .find(target => target?.actor) ?? null;
  return {
    token: targetToken ?? sourceToken,
    actor: targetToken?.actor ?? actor
  };
}

function resolveActorToken(actor = null, token = null) {
  const tokenDocument = token?.document ?? token ?? null;
  if (tokenDocument?.actor?.uuid === actor?.uuid) return tokenDocument;
  return (canvas?.tokens?.controlled ?? [])
    .map(controlled => controlled?.document ?? controlled)
    .find(document => document?.actor?.uuid === actor?.uuid) ?? findActorTokenDocument(actor);
}

function findActorTokenDocument(actor = null) {
  if (!actor) return null;
  for (const token of canvas?.tokens?.placeables ?? []) {
    const document = token?.document ?? token;
    if (document?.actor?.uuid === actor.uuid) return document;
  }
  return null;
}
