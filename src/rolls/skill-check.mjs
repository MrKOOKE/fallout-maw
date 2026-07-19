import { SYSTEM_ID, TEMPLATES } from "../constants.mjs";
import { isAttackingWeaponAction } from "../abilities/runtime-state.mjs";
import { getSkillSettings } from "../settings/accessors.mjs";
import { getContextualAbilityChangeValue } from "../abilities/evaluation.mjs";
import { normalizeImagePath } from "../utils/actor-display-data.mjs";
import { toInteger } from "../utils/numbers.mjs";
import {
  ALL_COMBAT_ADVANTAGE_EFFECT_KEY,
  ALL_COMBAT_DISADVANTAGE_EFFECT_KEY,
  getActorCombatAttackEdgeCount,
  getActorSmartFudgeResult,
  getCombatAttackAdvantageEffectKey,
  getCombatAttackDisadvantageEffectKey
} from "../utils/active-effect-changes.mjs";
import { getActiveSystemEventOperationId, withSystemEventRoot } from "../events/dispatcher.mjs";
import { runTerminalSystemEventWorkflow } from "../utils/system-event-workflow.mjs";
import { notifyAbilityTriggerCostFailure } from "../abilities/trigger-cost-runtime.mjs";

const { DialogV2 } = foundry.applications.api;
const FormDataExtended = foundry.applications.ux.FormDataExtended;
const { renderTemplate } = foundry.applications.handlebars;

const DEFAULT_CHECK = Object.freeze({
  difficulty: 60,
  situationalModifier: 0,
  criticalSuccessBonus: 0,
  criticalFailureBonus: 0
});
const SKILL_CHECK_SOCKET = `system.${SYSTEM_ID}`;
const ACTIVE_SKILL_CHECK_ANIMATIONS = new Map();
const SKILL_CHECK_ANIMATION_LAYOUT = Object.freeze({
  margin: 18,
  maxRows: 4,
  leftReservedRatio: 0.2,
  closeAnimationMs: 180,
  closeLayoutDelayMs: 650
});
const FORCED_RESULT_TO_SEGMENT = Object.freeze({
  criticalFailure: "critical-failure",
  failure: "failure",
  success: "success",
  criticalSuccess: "critical-success"
});

export function registerSkillCheckSocket() {
  game.socket.on(SKILL_CHECK_SOCKET, handleSkillCheckSocketMessage);
  window.addEventListener("resize", scheduleSkillCheckAnimationLayout);
}

export async function requestSkillCheck({
  actor,
  skillKey = "",
  data = {},
  animate = true,
  createMessage = true,
  messageData = {},
  prompt = false,
  requester = "",
  chainRef = null,
  options = {},
  source = {},
  completionCollector = null
} = {}) {
  const resolvedSkill = resolveSkill(actor, skillKey);
  if (!resolvedSkill) return undefined;
  if (completionCollector && typeof completionCollector.deferTerminal !== "function") {
    throw new TypeError("A skill-check completion collector must provide deferTerminal().");
  }
  const initialData = normalizeRequestData(inheritSystemEventOperationId(data), requester);
  const initialEventContext = createSkillCheckEventContext(actor, resolvedSkill, initialData, {
    source,
    rawData: data
  });
  const inheritedChainRef = resolveSkillCheckChainRef({ chainRef, options, source, data });
  const checkOccurrenceId = getSkillCheckOccurrenceId(options, source);

  const deferredReturn = completionCollector ? createDeferredSkillCheckBarrier() : null;
  let rootPromise;
  rootPromise = withSystemEventRoot({
    kind: "skillCheck",
    operationId: getSkillCheckOperationId(initialData, options, source),
    sceneUuid: initialEventContext.sceneUuid,
    combatUuid: String(game.combat?.uuid ?? ""),
    chainRef: inheritedChainRef
  }, async scope => {
    let requestData;
    try {
      requestData = prompt ? await promptSkillCheckData(actor, resolvedSkill) : data;
    } catch (error) {
      await runTerminalSystemEventWorkflow({
        scope,
        resolvedEventKey: "fallout-maw.skill.check.resolved",
        occurrenceBase: `skill:${scope.rootId}:${checkOccurrenceId}:${actor.uuid}:${resolvedSkill.key}`,
        participants: initialEventContext.participants,
        resolvedData: ({ status }) => buildSkillCheckResolvedEventData(undefined, resolvedSkill, initialData, status),
        forcedResult: { status: "error", reason: "promptError", value: undefined, error }
      });
      return undefined;
    }
    if (!requestData) {
      await runTerminalSystemEventWorkflow({
        scope,
        resolvedEventKey: "fallout-maw.skill.check.resolved",
        occurrenceBase: `skill:${scope.rootId}:${checkOccurrenceId}:${actor.uuid}:${resolvedSkill.key}`,
        participants: initialEventContext.participants,
        resolvedData: ({ status }) => buildSkillCheckResolvedEventData(undefined, resolvedSkill, initialData, status),
        forcedResult: { status: "cancelled", reason: "promptCancelled", value: undefined }
      });
      return undefined;
    }
    const normalizedData = normalizeRequestData(inheritSystemEventOperationId(requestData, initialData), requester);
    const eventContext = createSkillCheckEventContext(actor, resolvedSkill, normalizedData, {
      source,
      rawData: requestData
    });
    let message;
    const occurrenceBase = `skill:${scope.rootId}:${checkOccurrenceId}:${actor.uuid}:${resolvedSkill.key}`;
    const workflow = await runTerminalSystemEventWorkflow({
      scope,
      beforeEventKey: "fallout-maw.skill.check.beforeRoll",
      resolvedEventKey: "fallout-maw.skill.check.resolved",
      occurrenceBase,
      participants: eventContext.participants,
      beforeData: buildSkillCheckBeforeEventData(resolvedSkill, normalizedData),
      resolvedData: ({ value, status }) => buildSkillCheckResolvedEventData(value, resolvedSkill, normalizedData, status),
      operation: () => performSkillCheck(actor, resolvedSkill, normalizedData),
      beforeTerminal: async ({ success, value }) => {
        if (!success || !value) return;
        if (animate) await playSkillCheckAnimation(value);
        if (!createMessage) {
          if (!completionCollector) return;
          const presentationBarrier = completionCollector.deferTerminal(value, () => rootPromise);
          deferredReturn.resolve(value);
          await presentationBarrier;
          return;
        }

        const resolvedMessageData = typeof messageData === "function" ? messageData(value) : messageData;
        message = await publishSkillCheckMessageSafely(() => publishSkillCheckMessage(value, {
          requester,
          messageData: resolvedMessageData
        }));
      }
    });
    notifySkillCheckTriggerCostCancellation(workflow);
    const outcome = workflow.value;
    if (!workflow.success || !outcome) return undefined;

    // Compatibility mirror. Hooks are deliberately invoked only after the
    // awaited semantic event has committed.
    Hooks.callAll("fallout-maw.skillCheckResolved", outcome);
    if (!createMessage) return outcome;
    return {
      ...outcome,
      message
    };
  });
  if (!deferredReturn) return rootPromise;
  void rootPromise.then(deferredReturn.resolve, deferredReturn.reject);
  return deferredReturn.promise;
}

export async function requestSkillCheckBatch({
  actor,
  skillKey = "",
  entries = [],
  animate = false,
  createMessage = true,
  requester = "",
  title = "",
  chainRef = null,
  options = {},
  source = {}
} = {}) {
  const preparedEntries = prepareSkillCheckBatchEntries({ actor, skillKey, entries });
  if (!preparedEntries) return undefined;
  const firstData = preparedEntries[0]?.data ?? {};
  const inheritedChainRef = resolveSkillCheckChainRef({ chainRef, options, source, data: firstData });
  const operationId = String(options?.operationId ?? source?.operationId ?? "").trim() || foundry.utils.randomID();
  const batchOccurrenceId = getSkillCheckOccurrenceId(options, source);

  return withSystemEventRoot({
    kind: "skillCheckBatch",
    operationId: `skill-batch:${operationId}`,
    sceneUuid: getSkillCheckSceneUuid(firstData?.actorToken),
    combatUuid: String(game.combat?.uuid ?? ""),
    chainRef: inheritedChainRef
  }, async scope => {
    const outcomes = [];
    const pendingChecks = [];
    let cancelledCount = 0;
    let failedCount = 0;
    let cancelRemaining = false;
    let operationError = null;
    const finalizePendingCheck = async pending => {
      if (pending.presentationError) pending.terminalRelease.reject(pending.presentationError);
      else pending.terminalRelease.resolve();

      try {
        const workflow = await pending.workflowPromise;
        if (workflow.cancelled) {
          notifySkillCheckTriggerCostCancellation(workflow);
          cancelledCount += 1;
          return false;
        }
        if (!workflow.success || !workflow.value) {
          failedCount += 1;
          return false;
        }
        outcomes.push(workflow.value);
        Hooks.callAll("fallout-maw.skillCheckResolved", workflow.value);
        return false;
      } catch (error) {
        failedCount += 1;
        operationError ??= error;
        return true;
      }
    };

    for (const [index, entry] of preparedEntries.entries()) {
      const normalizedData = normalizeRequestData(entry.data, requester);
      const eventContext = createSkillCheckEventContext(entry.actor, entry.skill, normalizedData, {
        source,
        rawData: entry.data
      });
      const occurrenceBase = `skill:${scope.rootId}:${batchOccurrenceId}:${index}:${entry.actor.uuid}:${entry.skill.key}`;
      const terminalReady = createDeferredSkillCheckBarrier();
      const terminalRelease = createDeferredSkillCheckBarrier();
      const workflowPromise = runTerminalSystemEventWorkflow({
        scope,
        beforeEventKey: "fallout-maw.skill.check.beforeRoll",
        resolvedEventKey: "fallout-maw.skill.check.resolved",
        occurrenceBase,
        participants: eventContext.participants,
        beforeData: buildSkillCheckBeforeEventData(entry.skill, normalizedData),
        resolvedData: ({ value, status }) => buildSkillCheckResolvedEventData(value, entry.skill, normalizedData, status),
        operation: () => performSkillCheck(entry.actor, entry.skill, normalizedData),
        beforeTerminal: terminalContext => {
          terminalReady.resolve(terminalContext);
          return terminalRelease.promise;
        },
        ...(cancelRemaining ? {
          forcedResult: { status: "cancelled", reason: "cancelRemaining", value: undefined }
        } : {})
      });
      // Observe an unexpected pre-terminal rejection immediately so it cannot
      // become an unhandled promise while the rest of the batch is prepared.
      void workflowPromise.catch(error => terminalReady.reject(error));

      try {
        const terminalContext = await terminalReady.promise;
        const pending = {
          workflowPromise,
          terminalRelease,
          terminalContext,
          presentationError: null
        };
        if (terminalContext.cancelled && (terminalContext.gate?.control?.remaining || terminalContext.gate?.control?.root)) {
          cancelRemaining = true;
        }
        if (terminalContext.error) cancelRemaining = true;
        if (createMessage && terminalContext.success && terminalContext.value) {
          pendingChecks.push(pending);
          continue;
        }

        if (terminalContext.success && terminalContext.value && animate) {
          try {
            await playSkillCheckAnimation(terminalContext.value);
          } catch (error) {
            pending.presentationError = error;
          }
        }
        if (await finalizePendingCheck(pending)) cancelRemaining = true;
      } catch (error) {
        operationError ??= error;
        cancelRemaining = true;
      }
    }

    for (const pending of pendingChecks) {
      if (!pending.terminalContext.success || !pending.terminalContext.value || !animate) continue;
      try {
        await playSkillCheckAnimation(pending.terminalContext.value);
      } catch (error) {
        pending.presentationError = error;
      }
    }

    const presentableOutcomes = pendingChecks
      .filter(pending => pending.terminalContext.success && pending.terminalContext.value && !pending.presentationError)
      .map(pending => pending.terminalContext.value);
    const message = createMessage
      ? await publishSkillCheckMessageSafely(() => publishSkillCheckBatchMessage(presentableOutcomes, { requester, title }))
      : undefined;

    for (const pending of pendingChecks) {
      await finalizePendingCheck(pending);
    }

    await scope.emit("fallout-maw.skill.batch.resolved", {
      data: {
        requestedCount: preparedEntries.length,
        resolvedCount: outcomes.length,
        cancelledCount,
        failedCount,
        skillKeys: Array.from(new Set(preparedEntries.map(entry => entry.skill.key))),
        damageHubOperationRef: String(firstData?.damageHubOperationRef ?? source?.damageHubOperationRef ?? "")
      },
      outcome: {
        success: !operationError && failedCount === 0,
        cancelled: cancelledCount > 0,
        failed: failedCount > 0
      },
      reason: operationError ? "error" : (cancelledCount ? "cancelled" : (failedCount ? "failed" : "resolved"))
    }, {
      occurrenceKey: `skill:${scope.rootId}:${batchOccurrenceId}:batch:resolved`,
      participants: {
        source: null,
        target: null,
        related: buildSkillCheckBatchParticipants(preparedEntries)
      }
    });

    if (operationError) throw operationError;
    return { outcomes, message };
  });
}

function createDeferredSkillCheckBarrier() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function notifySkillCheckTriggerCostCancellation(workflow = {}) {
  const reason = String(workflow?.reason ?? "").trim();
  const prefix = "triggerCost:";
  if (!workflow?.cancelled || !reason.startsWith(prefix)) return;
  notifyAbilityTriggerCostFailure({
    ok: false,
    reason: reason.slice(prefix.length) || "spendFailed"
  });
}

export function createSkillCheckBatchCollector({ requester = "", title = "" } = {}) {
  const outcomes = [];
  const outcomeSet = new Set();
  const pendingTerminals = [];
  const pendingByOutcome = new Map();
  const settledCallbacks = new Set();
  let settlePromise = null;
  let settled = false;
  const add = outcome => {
    if (!outcome || outcomeSet.has(outcome)) return outcome;
    outcomeSet.add(outcome);
    outcomes.push(outcome);
    return outcome;
  };
  const settle = ({ createMessage = false, forceBatch = true } = {}) => {
    if (settlePromise) return settlePromise;
    settlePromise = (async () => {
      let message;
      let firstError = null;
      try {
        if (createMessage) {
          const normalizedOutcomes = outcomes.filter(Boolean);
          message = normalizedOutcomes.length === 1 && !forceBatch
            ? await publishSkillCheckMessage(normalizedOutcomes[0], { requester })
            : await publishSkillCheckBatchMessage(normalizedOutcomes, { requester, title });
        }
      } catch (error) {
        firstError = error;
      }

      // A collected check owns an explicit terminal barrier. Whether its
      // owner publishes the common card or aborts the surrounding operation,
      // every barrier is released exactly once and completed in stable order.
      for (const pending of pendingTerminals) {
        pending.release.resolve();
        try {
          await pending.getCompletionPromise?.();
        } catch (error) {
          firstError ??= error;
        }
        for (const callback of pending.callbacks) {
          try {
            await callback();
          } catch (error) {
            firstError ??= error;
          }
        }
      }

      if (firstError) throw firstError;
      return message;
    })().finally(() => {
      settled = true;
      for (const callback of settledCallbacks) {
        try {
          callback();
        } catch (error) {
          console.error(`${SYSTEM_ID} | Skill check collector settlement callback failed`, error);
        }
      }
      settledCallbacks.clear();
    });
    return settlePromise;
  };
  return {
    get size() {
      return outcomes.length;
    },
    get settled() {
      return settled;
    },
    add,
    deferTerminal(outcome, getCompletionPromise) {
      if (settlePromise) throw new Error("Cannot add a skill check after its completion has started settling.");
      add(outcome);
      const release = createDeferredSkillCheckBarrier();
      const pending = { release, getCompletionPromise, callbacks: [] };
      pendingTerminals.push(pending);
      pendingByOutcome.set(outcome, pending);
      return release.promise;
    },
    afterTerminal(outcome, callback) {
      const pending = pendingByOutcome.get(outcome);
      if (!pending || typeof callback !== "function") return false;
      pending.callbacks.push(callback);
      return true;
    },
    onSettled(callback) {
      if (typeof callback !== "function") return false;
      if (settled) callback();
      else settledCallbacks.add(callback);
      return true;
    },
    publish({ forceBatch = true } = {}) {
      return settle({ createMessage: true, forceBatch });
    },
    abort() {
      return settle({ createMessage: false });
    }
  };
}

async function publishSkillCheckMessageSafely(publisher) {
  try {
    return await publisher();
  } catch (error) {
    console.error(`${SYSTEM_ID} | Skill check chat card failed`, error);
    ui.notifications.warn("Проверка выполнена, но карточка проверки навыка не была создана.");
    return undefined;
  }
}

async function publishSkillCheckBatchMessage(outcomes = [], { requester = "", title = "" } = {}) {
  const normalizedOutcomes = outcomes.filter(Boolean);
  if (!normalizedOutcomes.length) return undefined;

  const context = buildSkillCheckBatchViewContext(normalizedOutcomes, { title });
  const content = await renderTemplate(TEMPLATES.skillCheckBatchChatCard, context);
  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: normalizedOutcomes[0]?.actor }),
    content,
    sound: null,
    rolls: normalizedOutcomes.flatMap(outcome => outcome.rolls.map(roll => roll.toJSON())),
    flags: {
      "fallout-maw": {
        skillCheckBatch: {
          requester,
          count: normalizedOutcomes.length,
          results: Object.fromEntries(context.resultRows.map(row => [row.key, row.count]))
        }
      }
    }
  });
}

function buildSkillCheckBatchViewContext(outcomes = [], { title = "" } = {}) {
  const first = outcomes[0];
  const counts = countSkillCheckResults(outcomes);
  const total = outcomes.length;
  return {
    actor: prepareSkillCheckActorView(first.actor),
    skill: first.skill,
    title: String(title || first.skill?.label || game.i18n.localize("FALLOUTMAW.SkillCheck.TerminalTitle")),
    total,
    resultRows: [
      buildBatchResultRow("criticalSuccess", "critical-success", "FALLOUTMAW.SkillCheck.CriticalSuccess", counts, total),
      buildBatchResultRow("success", "success", "FALLOUTMAW.SkillCheck.Success", counts, total),
      buildBatchResultRow("failure", "failure", "FALLOUTMAW.SkillCheck.Failure", counts, total),
      buildBatchResultRow("criticalFailure", "critical-failure", "FALLOUTMAW.SkillCheck.CriticalFailure", counts, total),
      buildBatchResultRow("automaticFailure", "automatic-failure", "FALLOUTMAW.SkillCheck.AutomaticFailure", counts, total)
    ].filter(row => row.count > 0),
    difficultyRange: formatBatchDifficultyRange(outcomes),
    skillValueRange: formatBatchSkillValueRange(outcomes)
  };
}

function countSkillCheckResults(outcomes = []) {
  return outcomes.reduce((counts, outcome) => {
    const key = outcome.result?.autoFailure ? "automaticFailure" : String(outcome.result?.key ?? "");
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function buildBatchResultRow(key, cssClass, labelKey, counts, total) {
  const count = counts[key] ?? 0;
  return {
    key,
    cssClass,
    label: game.i18n.localize(labelKey),
    count,
    percent: total > 0 ? Math.round((count / total) * 100) : 0
  };
}

function formatBatchDifficultyRange(outcomes = []) {
  const values = outcomes.map(outcome => toInteger(outcome.check?.difficulty));
  return formatNumberRange(values);
}

function formatBatchSkillValueRange(outcomes = []) {
  const values = outcomes.map(outcome => toInteger(outcome.finalSkillValue));
  return formatNumberRange(values);
}

function formatNumberRange(values = []) {
  const filtered = values.filter(value => Number.isFinite(value));
  if (!filtered.length) return "0";
  const min = Math.min(...filtered);
  const max = Math.max(...filtered);
  return min === max ? String(min) : `${min}-${max}`;
}

function prepareSkillCheckBatchEntries({ actor, skillKey = "", entries = [] } = {}) {
  if (!Array.isArray(entries) || !entries.length) return null;
  const preparedEntries = [];

  for (const entry of entries) {
    const entryActor = entry?.actor ?? actor;
    const entrySkillKey = String(entry?.skillKey ?? skillKey);
    if (!entryActor) return null;
    const skill = resolveSkill(entryActor, entrySkillKey);
    if (!skill) return null;
    preparedEntries.push({
      actor: entryActor,
      skill,
      data: entry?.data ?? {}
    });
  }

  return preparedEntries;
}

function createSkillCheckEventContext(actor, skill, data = {}, { source = {}, rawData = {} } = {}) {
  const sourceToken = getTokenDocument(data.actorToken);
  const targetToken = getTokenDocument(data.targetToken);
  const targetActor = targetToken?.actor ?? data.targetActor ?? null;
  const itemUuid = String(
    source?.itemUuid
    ?? rawData?.itemUuid
    ?? rawData?.sourceItemUuid
    ?? data.weaponData?.uuid
    ?? ""
  ).trim();
  return {
    sceneUuid: getSkillCheckSceneUuid(sourceToken),
    participants: {
      source: normalizeSkillCheckParticipant({ actor, token: sourceToken, itemUuid }),
      target: normalizeSkillCheckParticipant({ actor: targetActor, token: targetToken }),
      related: []
    },
    skillKey: skill?.key ?? ""
  };
}

function buildSkillCheckBeforeEventData(skill, data = {}) {
  return {
    systemEventOperationId: String(data.systemEventOperationId ?? "").trim(),
    suppressGenericEventReactions: data.suppressGenericEventReactions === true,
    skill: {
      key: String(skill?.key ?? ""),
      label: String(skill?.label ?? ""),
      value: toInteger(skill?.value),
      advantage: Math.max(0, toInteger(skill?.advantage)),
      disadvantage: Math.max(0, toInteger(skill?.disadvantage))
    },
    request: serializeSkillCheckRequest(data)
  };
}

function buildSkillCheckResolvedEventData(outcome, skill, data = {}, status = "") {
  return {
    skillKey: String(outcome?.skill?.key ?? skill?.key ?? ""),
    requester: String(data.requester ?? ""),
    status: String(status ?? ""),
    resultKey: String(outcome?.result?.key ?? ""),
    automaticFailure: Boolean(outcome?.result?.autoFailure ?? outcome?.autoFailure),
    difficulty: toInteger(outcome?.check?.difficulty ?? data.difficulty),
    finalSkillValue: toInteger(outcome?.finalSkillValue),
    rollTotal: toInteger(outcome?.selectedRoll?.total),
    total: toInteger(outcome?.total),
    rollCount: Array.isArray(outcome?.rolls) ? outcome.rolls.length : 0,
    weaponAttackId: String(data.weaponAttackId ?? ""),
    weaponActionKey: String(data.weaponActionKey ?? ""),
    damageHubOperationRef: String(data.damageHubOperationRef ?? "")
  };
}

function serializeSkillCheckRequest(data = {}) {
  return {
    difficulty: toInteger(data.difficulty),
    situationalModifier: toInteger(data.situationalModifier),
    criticalSuccessBonus: toInteger(data.criticalSuccessBonus),
    criticalFailureBonus: toInteger(data.criticalFailureBonus),
    advantageCount: Math.max(0, toInteger(data.advantageCount)),
    disadvantageCount: Math.max(0, toInteger(data.disadvantageCount)),
    requester: String(data.requester ?? ""),
    systemEventOperationId: String(data.systemEventOperationId ?? "").trim(),
    weaponAttackId: String(data.weaponAttackId ?? ""),
    weaponActionKey: String(data.weaponActionKey ?? ""),
    weaponData: serializeSkillCheckWeaponData(data.weaponData),
    allOrNothingAttackMode: String(data.allOrNothingAttackMode ?? ""),
    allOrNothingAttackIndex: Math.max(0, toInteger(data.allOrNothingAttackIndex)),
    allOrNothingAttackCount: Math.max(0, toInteger(data.allOrNothingAttackCount)),
    damageHubOperationRef: String(data.damageHubOperationRef ?? ""),
    smartFudgeResult: String(data.smartFudgeResult ?? "")
  };
}

function buildSkillCheckBatchParticipants(entries = []) {
  const participants = [];
  const seen = new Set();
  for (const entry of entries) {
    const participant = normalizeSkillCheckParticipant({
      actor: entry.actor,
      token: entry.data?.actorToken
    });
    if (!participant) continue;
    const key = `${participant.actorUuid}:${participant.tokenUuid}:${participant.itemUuid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    participants.push(participant);
  }
  return participants;
}

function normalizeSkillCheckParticipant({ actor = null, token = null, itemUuid = "" } = {}) {
  const tokenDocument = getTokenDocument(token);
  const participant = {
    actorUuid: String(actor?.uuid ?? tokenDocument?.actor?.uuid ?? "").trim(),
    tokenUuid: String(tokenDocument?.uuid ?? "").trim(),
    itemUuid: String(itemUuid ?? "").trim()
  };
  return Object.values(participant).some(Boolean) ? participant : null;
}

function getTokenDocument(token = null) {
  return token?.document ?? token ?? null;
}

function getSkillCheckSceneUuid(token = null) {
  const document = getTokenDocument(token);
  return String(document?.parent?.uuid ?? document?.scene?.uuid ?? canvas?.scene?.uuid ?? "").trim();
}

function resolveSkillCheckChainRef({ chainRef = null, options = {}, source = {}, data = {} } = {}) {
  return chainRef
    ?? options?.falloutMawSystemEventChainRef
    ?? options?.chainRef
    ?? source?.chainRef
    ?? data?.source?.chainRef
    ?? data?.chainRef
    ?? null;
}

function getSkillCheckOperationId(data = {}, options = {}, source = {}) {
  // Each skill-check root stays unique (dispatcher forbids reopening a closed operationId).
  // Shared Event Reaction coalescing uses data.systemEventOperationId instead.
  const id = String(
    options?.operationId
    ?? source?.operationId
    ?? ""
  ).trim() || foundry.utils.randomID();
  return `skill:${id}`;
}

function getSkillCheckOccurrenceId(options = {}, source = {}) {
  return String(options?.occurrenceId ?? source?.occurrenceId ?? "").trim()
    || foundry.utils.randomID();
}

async function promptSkillCheckData(actor, skill) {
  const content = await renderTemplate(TEMPLATES.skillCheckDialog, {
    actor,
    skill,
    defaults: DEFAULT_CHECK
  });

  return DialogV2.prompt({
    window: {
      title: game.i18n.format("FALLOUTMAW.SkillCheck.Title", { skill: skill.label })
    },
    content,
    position: { width: 460 },
    rejectClose: false,
    render: (_event, dialog) => activateSkillCheckDialog(dialog),
    ok: {
      label: "FALLOUTMAW.SkillCheck.RollButton",
      icon: "fa-solid fa-dice-d20",
      callback: (_event, button) => new FormDataExtended(button.form).object
    }
  });
}

async function performSkillCheck(actor, skill, data = {}) {
  if (!skill) return undefined;

  const check = createMutableCheck(actor, skill, data);
  Hooks.callAll("fallout-maw.modifySkillCheck", check);

  const edge = calculateEdge(check.advantageCount, check.disadvantageCount);
  const finalSkillValue = toInteger(check.skill.value) + toInteger(check.situationalModifier) + edge.skillModifier;
  const critical = calculateCriticalThresholds(check, finalSkillValue, check.difficulty);
  const forcedResult = normalizeForcedResult(check.forcedResult);
  const smartFudgeResult = forcedResult ? "" : normalizeForcedResult(check.smartFudgeResult || getActorSmartFudgeResult(actor, { requester: check.requester, check }));
  const autoFailure = isAutomaticFailure(finalSkillValue, check.difficulty) && !forcedResult;
  const smartFudgeRollRange = smartFudgeResult
    ? getSmartFudgeRollRange(smartFudgeResult, check.difficulty, critical, finalSkillValue, autoFailure)
    : null;
  const forcedRollTotal = forcedResult
    ? getForcedRollTotal(forcedResult, check.difficulty, critical, finalSkillValue)
    : null;
  const rolls = await rollD100(edge.rollMode === "normal" ? 1 : 2, {
    forcedTotal: forcedRollTotal,
    smartRange: smartFudgeRollRange
  });
  const selectedRoll = selectRoll(rolls, edge.rollMode);
  const total = finalSkillValue + selectedRoll.total;
  const result = determineResult(
    selectedRoll.total,
    total,
    check.difficulty,
    critical,
    autoFailure,
    forcedResult
  );

  return {
    actor,
    check,
    skill: check.skill,
    rolls,
    selectedRoll,
    edge,
    finalSkillValue,
    total,
    critical,
    autoFailure,
    result
  };
}

function serializeSkillCheckWeaponData(weaponData = null) {
  if (!weaponData || typeof weaponData !== "object") return null;
  return {
    id: String(weaponData.id ?? weaponData._id ?? ""),
    uuid: String(weaponData.uuid ?? ""),
    skillKey: String(weaponData.skillKey ?? ""),
    proficiencyKey: String(weaponData.proficiencyKey ?? "")
  };
}

async function publishSkillCheckMessage(outcome, { requester = "", messageData = {} } = {}) {
  const { actor, check, rolls, result, total } = outcome;
  const cardContext = buildSkillCheckViewContext(outcome);

  const content = await renderTemplate(TEMPLATES.skillCheckChatCard, cardContext);
  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content,
    sound: null,
    rolls: rolls.map(roll => roll.toJSON()),
    ...normalizeSkillCheckMessageData(messageData),
    flags: {
      "fallout-maw": {
        skillCheck: {
          skillKey: check.skill.key,
          difficulty: check.difficulty,
          requester,
          total,
          result: result.key,
          autoFailure: result.autoFailure
        }
      }
    }
  });
}

function normalizeSkillCheckMessageData(messageData = {}) {
  if (!messageData || typeof messageData !== "object") return {};
  return {
    ...(Array.isArray(messageData.whisper) ? { whisper: messageData.whisper } : {}),
    ...(messageData.blind !== undefined ? { blind: Boolean(messageData.blind) } : {}),
    ...(messageData.type !== undefined ? { type: messageData.type } : {}),
    ...(messageData.includeRolls === false ? { rolls: [] } : {})
  };
}

function buildSkillCheckViewContext(outcome) {
  const { actor, check, skill, rolls, selectedRoll, edge, finalSkillValue, total, critical, autoFailure, result } = outcome;
  return {
    actor: prepareSkillCheckActorView(actor),
    skill,
    difficulty: toInteger(check.difficulty),
    situationalModifier: toInteger(check.situationalModifier),
    finalSkillValue,
    critical,
    total,
    rollEntries: buildRollEntries(rolls, selectedRoll, check.difficulty, critical, finalSkillValue, check.forcedResult, autoFailure),
    thresholdRows: buildThresholdRows(check.difficulty, critical, finalSkillValue, autoFailure),
    scaleSegments: buildScaleSegments(check.difficulty, critical, finalSkillValue, selectedRoll.total, check.forcedResult, autoFailure),
    progressCells: buildProgressCells(check.difficulty, critical, finalSkillValue, autoFailure),
    autoFailure,
    progressTarget: autoFailure ? 100 : clamp(selectedRoll.total, 1, 100),
    edge: {
      ...edge,
      modeLabel: formatEdgeMode(edge),
      hasMultipleRolls: rolls.length > 1
    },
    result
  };
}

function prepareSkillCheckActorView(actor) {
  return {
    name: actor?.name ?? "",
    img: normalizeImagePath(actor?.img, "icons/svg/mystery-man.svg")
  };
}

async function playSkillCheckAnimation(outcome) {
  const checkId = foundry.utils.randomID();
  const context = buildSkillCheckAnimationContext(outcome, {
    checkId,
    ownerUserId: game.user.id
  });
  const animationPromise = showSkillCheckAnimation(context);
  emitSkillCheckSocket({
    action: "start",
    context
  });
  await animationPromise;
}

function buildSkillCheckAnimationContext(outcome, { checkId, ownerUserId }) {
  const context = buildSkillCheckViewContext(outcome);
  const tracks = buildSkillCheckAnimationTracks(context);
  return {
    checkId,
    ownerUserId,
    startedAt: Date.now(),
    actor: {
      name: context.actor.name
    },
    skill: context.skill,
    result: context.result,
    scaleSegments: context.scaleSegments,
    progressCells: context.progressCells,
    progressTarget: context.progressTarget,
    tracks,
    hasMultipleTracks: tracks.length > 1,
    edge: context.edge,
    autoFailure: context.autoFailure
  };
}

function buildSkillCheckAnimationTracks(context) {
  if (context.autoFailure || !context.edge?.hasMultipleRolls) {
    return [{
      index: 1,
      label: "",
      selected: true,
      result: context.result,
      scaleSegments: context.scaleSegments,
      progressCells: buildProgressCellsForTarget(context.progressCells, context.progressTarget),
      progressTarget: context.progressTarget,
      progressMarker: context.progressTarget
    }];
  }

  return context.rollEntries.map(entry => ({
    index: entry.index,
    label: `${game.i18n.localize("FALLOUTMAW.SkillCheck.Roll")} ${entry.index}`,
    selected: entry.selected,
    result: entry.result,
    scaleSegments: buildScaleSegments(
      context.difficulty,
      context.critical,
      context.finalSkillValue,
      entry.total,
      "",
      false
    ),
    progressCells: buildProgressCellsForTarget(context.progressCells, entry.total),
    progressTarget: clamp(entry.total, 1, 100),
    progressMarker: clamp(entry.total, 1, 100)
  }));
}

async function showSkillCheckAnimation(context) {
  const existing = ACTIVE_SKILL_CHECK_ANIMATIONS.get(context.checkId);
  if (existing) return existing.promise;

  let resolvePromise;
  const promise = new Promise(resolve => {
    resolvePromise = resolve;
  });
  const controller = {
    context,
    host: null,
    closing: false,
    close: () => {
      if (controller.closing) return;
      controller.closing = true;
      const hostToRemove = controller.host;
      hostToRemove?.classList.add("is-closing");
      window.setTimeout(() => {
        hostToRemove?.remove();
        resolvePromise();
      }, SKILL_CHECK_ANIMATION_LAYOUT.closeAnimationMs);
      ACTIVE_SKILL_CHECK_ANIMATIONS.delete(context.checkId);
      scheduleSkillCheckAnimationLayoutAfterClose();
    },
    promise
  };
  ACTIVE_SKILL_CHECK_ANIMATIONS.set(context.checkId, controller);

  const canComplete = canCompleteSkillCheckAnimation(context);
  let content;
  try {
    content = await renderTemplate(TEMPLATES.skillCheckAnimation, {
      ...context,
      canComplete
    });
  } catch (error) {
    ACTIVE_SKILL_CHECK_ANIMATIONS.delete(context.checkId);
    resolvePromise();
    throw error;
  }

  const host = document.createElement("div");
  host.className = "fallout-maw-skill-check-animation-host is-positioning";
  host.dataset.skillCheckAnimationId = context.checkId;
  host.innerHTML = content.trim();
  controller.host = host;
  document.body.append(host);

  const animationElement = host.querySelector("[data-skill-check-animation]");
  const tracks = getSkillCheckAnimationTracks(host);
  if (!animationElement || !tracks.length || tracks.some(track => !track.cells.length)) {
    controller.close();
    await controller.promise;
    throw new Error("Skill check animation template is missing required elements.");
  }

  layoutSkillCheckAnimations({ immediate: true });

  await waitForAnimationFrame();
  host.classList.remove("is-positioning");
  if (context.autoFailure) {
    for (const track of tracks) {
      clearProgressCells(track.cells);
      activateProgressCells(track.cells, new Set(), track.cells.length, 100);
    }
  } else {
    await Promise.all(tracks.map(track => animateSkillCheckCells(track.cells, track.target)));
  }

  animationElement.classList.add("complete");
  if (canComplete) {
    animationElement.classList.add("can-complete");
    animationElement.addEventListener("click", () => completeSkillCheckAnimation(context.checkId), { once: true });
  }

  return promise;
}

function getSkillCheckAnimationTracks(host) {
  return Array.from(host.querySelectorAll("[data-skill-check-animation-roll-track]")).map(track => ({
    element: track,
    target: Number(track.dataset.progressTarget) || 1,
    cells: Array.from(track.querySelectorAll("[data-skill-check-animation-cell]"))
  }));
}

let skillCheckAnimationLayoutFrame = null;
let skillCheckAnimationCloseLayoutTimeout = null;

function scheduleSkillCheckAnimationLayout() {
  if (skillCheckAnimationCloseLayoutTimeout) {
    window.clearTimeout(skillCheckAnimationCloseLayoutTimeout);
    skillCheckAnimationCloseLayoutTimeout = null;
  }
  if (skillCheckAnimationLayoutFrame) return;
  skillCheckAnimationLayoutFrame = requestAnimationFrame(() => {
    skillCheckAnimationLayoutFrame = null;
    layoutSkillCheckAnimations();
  });
}

function scheduleSkillCheckAnimationLayoutAfterClose() {
  if (skillCheckAnimationCloseLayoutTimeout) window.clearTimeout(skillCheckAnimationCloseLayoutTimeout);
  skillCheckAnimationCloseLayoutTimeout = window.setTimeout(() => {
    skillCheckAnimationCloseLayoutTimeout = null;
    scheduleSkillCheckAnimationLayout();
  }, SKILL_CHECK_ANIMATION_LAYOUT.closeLayoutDelayMs);
}

function layoutSkillCheckAnimations({ immediate = false } = {}) {
  const entries = Array.from(ACTIVE_SKILL_CHECK_ANIMATIONS.values())
    .filter(controller => controller.host?.isConnected)
    .sort(compareSkillCheckAnimationControllers)
    .map(controller => ({
      controller,
      host: controller.host,
      ...measureSkillCheckAnimationHost(controller.host)
    }))
    .filter(entry => entry.width > 0 && entry.height > 0);

  if (!entries.length) return;

  const positions = calculateSkillCheckAnimationPositions(entries);
  for (const position of positions) {
    position.entry.host.classList.toggle("no-layout-transition", immediate);
    position.entry.host.style.left = `${position.x}px`;
    position.entry.host.style.top = `${position.y}px`;
  }

  if (immediate) {
    requestAnimationFrame(() => {
      for (const entry of entries) entry.host.classList.remove("no-layout-transition");
    });
  }
}

function compareSkillCheckAnimationControllers(left, right) {
  const leftStartedAt = Number(left.context.startedAt) || 0;
  const rightStartedAt = Number(right.context.startedAt) || 0;
  return (leftStartedAt - rightStartedAt) || String(left.context.checkId).localeCompare(String(right.context.checkId));
}

function measureSkillCheckAnimationHost(host) {
  const rect = host.getBoundingClientRect();
  return {
    width: rect.width,
    height: rect.height
  };
}

function calculateSkillCheckAnimationPositions(entries) {
  const { margin } = SKILL_CHECK_ANIMATION_LAYOUT;
  const area = getSkillCheckAnimationAvailableArea(margin);
  const maxRows = getSkillCheckAnimationMaxRows(entries, area, margin);
  const rows = groupSkillCheckAnimationsIntoRows(entries, area.width, margin, maxRows);
  const totalHeight = rows.reduce((sum, row, index) => {
    const rowHeight = Math.max(...row.map(entry => entry.height));
    return sum + rowHeight + (index > 0 ? margin : 0);
  }, 0);
  let currentY = clampNumber(area.top + ((area.height - totalHeight) / 2), area.top, area.bottom);
  const positions = [];

  for (const row of rows) {
    const rowWidth = row.reduce((sum, entry, index) => sum + entry.width + (index > 0 ? margin : 0), 0);
    const rowHeight = Math.max(...row.map(entry => entry.height));
    let currentX = clampNumber(area.left + ((area.width - rowWidth) / 2), area.left, area.right - Math.min(rowWidth, area.width));

    for (const entry of row) {
      const x = clampNumber(currentX, area.left, area.right - entry.width);
      const y = clampNumber(currentY + ((rowHeight - entry.height) / 2), area.top, area.bottom - entry.height);
      positions.push({ entry, x, y });
      currentX += entry.width + margin;
    }

    currentY += rowHeight + margin;
  }

  return positions;
}

function getSkillCheckAnimationMaxRows(entries, area, margin) {
  const maxEntryHeight = Math.max(...entries.map(entry => entry.height), 1);
  const rowsByHeight = Math.max(1, Math.floor((area.height + margin) / (maxEntryHeight + margin)));
  return Math.min(entries.length, SKILL_CHECK_ANIMATION_LAYOUT.maxRows, rowsByHeight);
}

function groupSkillCheckAnimationsIntoRows(entries, availableWidth, margin, maxRows) {
  if (entries.length <= 1) return entries.map(entry => [entry]);

  const rows = [];
  let currentRow = [];
  let currentRowWidth = 0;

  for (const entry of entries) {
    const nextWidth = currentRowWidth + entry.width + (currentRow.length ? margin : 0);
    const canFit = nextWidth <= availableWidth || !currentRow.length;
    const mustUseLastRow = rows.length >= maxRows - 1;

    if (!canFit && currentRow.length && !mustUseLastRow) {
      rows.push(currentRow);
      currentRow = [entry];
      currentRowWidth = entry.width;
      continue;
    }

    currentRow.push(entry);
    currentRowWidth = nextWidth;
  }

  if (currentRow.length) rows.push(currentRow);
  while (rows.length > maxRows) rows[rows.length - 2].push(...rows.pop());
  return rows;
}

function getSkillCheckAnimationAvailableArea(margin) {
  const reservedLeft = Math.floor(window.innerWidth * SKILL_CHECK_ANIMATION_LAYOUT.leftReservedRatio);
  const left = Math.min(window.innerWidth - margin, reservedLeft + margin);
  const top = margin;
  const right = Math.max(left, window.innerWidth - margin);
  const bottom = Math.max(top, window.innerHeight - margin);
  return {
    left,
    top,
    right,
    bottom,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top)
  };
}

function clampNumber(value, min, max) {
  const safeMin = Number.isFinite(min) ? min : 0;
  const safeMax = Number.isFinite(max) ? Math.max(safeMin, max) : safeMin;
  const safeValue = Number.isFinite(value) ? value : safeMin;
  return Math.min(safeMax, Math.max(safeMin, safeValue));
}

function animateSkillCheckCells(cells, target) {
  const targetPercent = clamp(target, 1, 100);
  const fullScaleDuration = 2000;
  const brakeDuration = 500;
  const targetCellCount = Math.ceil(targetPercent / 5);
  const brakeCellCount = Math.max(1, Math.ceil(targetCellCount * 0.2));
  const fastCellCount = Math.max(0, targetCellCount - brakeCellCount);
  const fastDuration = (targetPercent / 100) * fullScaleDuration;
  const targetDuration = fastDuration + brakeDuration;
  const targetCells = cells.slice(0, targetCellCount);
  clearProgressCells(cells);

  return new Promise(resolve => {
    const startedAt = performance.now();
    const activatedCells = new Set();
    const tick = now => {
      const elapsed = now - startedAt;
      let visibleCellCount = targetCellCount;
      if (elapsed <= fastDuration && fastDuration > 0) {
        visibleCellCount = Math.floor(fastCellCount * (elapsed / fastDuration));
      } else if (elapsed < targetDuration) {
        const brakeProgress = (elapsed - fastDuration) / brakeDuration;
        const eased = 1 - ((1 - brakeProgress) ** 3);
        visibleCellCount = fastCellCount + Math.floor(brakeCellCount * eased);
      }

      activateProgressCells(targetCells, activatedCells, visibleCellCount, targetPercent);
      if (elapsed < targetDuration) {
        requestAnimationFrame(tick);
        return;
      }
      activateProgressCells(targetCells, activatedCells, targetCellCount, targetPercent);
      resolve();
    };
    requestAnimationFrame(tick);
  });
}

function completeSkillCheckAnimation(checkId) {
  closeSkillCheckAnimation(checkId);
  emitSkillCheckSocket({
    action: "complete",
    checkId,
    userId: game.user.id
  });
}

function closeSkillCheckAnimation(checkId) {
  ACTIVE_SKILL_CHECK_ANIMATIONS.get(checkId)?.close();
}

function canCompleteSkillCheckAnimation(context) {
  return game.user.isGM || (game.user.id === context.ownerUserId);
}

function emitSkillCheckSocket(payload) {
  game.socket.emit(SKILL_CHECK_SOCKET, payload);
}

function handleSkillCheckSocketMessage(payload = {}) {
  if (!payload || typeof payload !== "object") return;
  if (payload.action === "start" && payload.context) {
    void showSkillCheckAnimation(payload.context);
    return;
  }
  if (payload.action === "complete") {
    const controller = ACTIVE_SKILL_CHECK_ANIMATIONS.get(payload.checkId);
    if (!controller || !canSocketUserCompleteSkillCheckAnimation(payload.userId, controller.context)) return;
    closeSkillCheckAnimation(payload.checkId);
  }
}

function canSocketUserCompleteSkillCheckAnimation(userId, context) {
  const user = game.users.get(userId);
  return Boolean(user?.isGM || (userId === context.ownerUserId));
}

function clearProgressCells(cells) {
  for (const cell of cells) {
    cell.style.setProperty("--cell-fill", "0%");
    cell.classList.remove("filled");
  }
}

function activateProgressCells(cells, activatedCells, visibleCellCount, targetPercent) {
  const count = clamp(Math.floor(visibleCellCount), 0, cells.length);
  for (let index = 0; index < count; index += 1) {
    const cell = cells[index];
    if (activatedCells.has(cell)) continue;
    activatedCells.add(cell);
    cell.style.setProperty("--cell-fill", `${getFinalCellFill(cell, targetPercent)}%`);
    cell.classList.add("filled");
  }
}

function getFinalCellFill(cell, targetPercent) {
  const start = Number(cell.dataset.cellStart) || 0;
  const end = Number(cell.dataset.cellEnd) || start;
  const width = Math.max(1, end - start);
  return clamp(((targetPercent - start) / width) * 100, 0, 100);
}

function waitForAnimationFrame() {
  return new Promise(resolve => requestAnimationFrame(resolve));
}

function resolveSkill(actor, skillKey) {
  const normalizedSkillKey = String(skillKey ?? "").trim();
  const setting = getSkillSettings().find(skill => skill.key === normalizedSkillKey);
  const actorSkill = actor.system?.skills?.[normalizedSkillKey];
  if (!setting || !actorSkill) return null;
  return {
    key: setting.key,
    abbr: setting.abbr,
    label: setting.label,
    value: toInteger(actorSkill.value),
    advantage: Math.max(0, toInteger(actorSkill.advantage)),
    disadvantage: Math.max(0, toInteger(actorSkill.disadvantage))
  };
}

function inheritSystemEventOperationId(data = {}, fallbackData = {}) {
  const source = data && typeof data === "object" ? data : {};
  const fallback = fallbackData && typeof fallbackData === "object" ? fallbackData : {};
  const explicit = String(source.systemEventOperationId ?? fallback.systemEventOperationId ?? "").trim();
  const inherited = explicit || getActiveSystemEventOperationId();
  if (!inherited) return data;
  if (String(source.systemEventOperationId ?? "").trim() === inherited) return data;
  return { ...source, systemEventOperationId: inherited };
}

function normalizeRequestData(data, requester = "") {
  data ??= {};
  const advantage = Boolean(data.advantage);
  const disadvantage = Boolean(data.disadvantage);
  return {
    difficulty: toInteger(data.difficulty),
    situationalModifier: toInteger(data.situationalModifier),
    criticalSuccessBonus: toInteger(data.criticalSuccessBonus),
    criticalFailureBonus: toInteger(data.criticalFailureBonus),
    advantageCount: advantage ? Math.max(1, toInteger(data.advantageCount)) : 0,
    disadvantageCount: disadvantage ? Math.max(1, toInteger(data.disadvantageCount)) : 0,
    requester: String(requester ?? ""),
    allowImplicitTarget: data.allowImplicitTarget !== false,
    actorToken: data.actorToken ?? null,
    targetToken: data.targetToken ?? null,
    targetActor: data.targetActor ?? null,
    weaponData: data.weaponData && typeof data.weaponData === "object" ? data.weaponData : null,
    systemEventOperationId: String(data.systemEventOperationId ?? "").trim(),
    weaponAttackId: String(data.weaponAttackId ?? ""),
    weaponActionKey: String(data.weaponActionKey ?? ""),
    allOrNothingAttackMode: String(data.allOrNothingAttackMode ?? ""),
    allOrNothingAttackIndex: Math.max(0, toInteger(data.allOrNothingAttackIndex)),
    allOrNothingAttackCount: Math.max(0, toInteger(data.allOrNothingAttackCount)),
    damageHubOperationRef: String(data.damageHubOperationRef ?? ""),
    smartFudgeResult: normalizeForcedResult(data.smartFudgeResult)
  };
}

function createMutableCheck(actor, skill, data) {
  const context = resolveSkillCheckContext(actor, data);
  const skillValue = getContextualAbilityChangeValue(actor, `system.skills.${skill.key}.bonus`, {
    ...context,
    baseValue: skill.value,
    alternateKeys: ["system.skills.all.bonus"]
  });
  const skillAdvantage = getContextualAbilityChangeValue(actor, `system.skills.${skill.key}.advantage`, {
    ...context,
    baseValue: skill.advantage,
    alternateKeys: ["system.skills.all.advantage"]
  });
  const skillDisadvantage = getContextualAbilityChangeValue(actor, `system.skills.${skill.key}.disadvantage`, {
    ...context,
    baseValue: skill.disadvantage,
    alternateKeys: ["system.skills.all.disadvantage"]
  });
  const weaponActionKey = String(data.weaponActionKey ?? context.weaponActionKey ?? "").trim();
  const isAttackingCheck = ["weaponAttack", "weaponPush", "activePush"].includes(String(data.requester ?? ""))
    && isAttackingWeaponAction(weaponActionKey);
  const combatAdvantage = isAttackingCheck
    ? getContextualAbilityChangeValue(actor, getCombatAttackAdvantageEffectKey(weaponActionKey), {
      ...context,
      baseValue: getActorCombatAttackEdgeCount(actor, weaponActionKey, "advantage"),
      alternateKeys: [ALL_COMBAT_ADVANTAGE_EFFECT_KEY]
    })
    : 0;
  const combatDisadvantage = isAttackingCheck
    ? getContextualAbilityChangeValue(actor, getCombatAttackDisadvantageEffectKey(weaponActionKey), {
      ...context,
      baseValue: getActorCombatAttackEdgeCount(actor, weaponActionKey, "disadvantage"),
      alternateKeys: [ALL_COMBAT_DISADVANTAGE_EFFECT_KEY]
    })
    : 0;
  return {
    actor,
    skill: { ...skill, value: toInteger(skillValue) },
    difficulty: toInteger(data.difficulty ?? DEFAULT_CHECK.difficulty),
    situationalModifier: toInteger(data.situationalModifier ?? DEFAULT_CHECK.situationalModifier),
    criticalSuccessBonus: toInteger(data.criticalSuccessBonus ?? DEFAULT_CHECK.criticalSuccessBonus),
    criticalFailureBonus: toInteger(data.criticalFailureBonus ?? DEFAULT_CHECK.criticalFailureBonus),
    advantageCount: Math.max(0, toInteger(data.advantageCount))
      + Math.max(0, toInteger(skillAdvantage))
      + Math.max(0, toInteger(combatAdvantage)),
    disadvantageCount: Math.max(0, toInteger(data.disadvantageCount))
      + Math.max(0, toInteger(skillDisadvantage))
      + Math.max(0, toInteger(combatDisadvantage)),
    forcedResult: "",
    smartFudgeResult: String(data.smartFudgeResult ?? ""),
    requester: String(data.requester ?? ""),
    weaponAttackId: String(data.weaponAttackId ?? ""),
    weaponActionKey: String(data.weaponActionKey ?? ""),
    allOrNothingAttackMode: String(data.allOrNothingAttackMode ?? ""),
    allOrNothingAttackIndex: Math.max(0, toInteger(data.allOrNothingAttackIndex)),
    allOrNothingAttackCount: Math.max(0, toInteger(data.allOrNothingAttackCount)),
    modifiers: [],
    ...context
  };
}

function resolveSkillCheckContext(actor, data = {}) {
  const explicitTargetToken = data?.targetToken ?? null;
  const userTargetToken = data?.allowImplicitTarget === false ? null : getSingleUserTarget();
  const selectedTargetToken = explicitTargetToken
    ?? (!data?.targetActor || userTargetToken?.actor === data.targetActor ? userTargetToken : null);
  const targetActor = selectedTargetToken?.actor ?? data?.targetActor ?? null;
  const actorToken = data?.actorToken ?? getActorContextToken(actor);
  return {
    actorToken,
    targetToken: selectedTargetToken,
    targetActor,
    weaponData: data?.weaponData && typeof data.weaponData === "object" ? data.weaponData : null,
    weaponActionKey: String(data?.weaponActionKey ?? "").trim()
  };
}

function getSingleUserTarget() {
  const targets = game.user?.targets;
  if (!targets || targets.size !== 1) return null;
  return targets.first?.() ?? Array.from(targets)[0] ?? null;
}

function getActorContextToken(actor) {
  if (actor?.token?.object) return actor.token.object;
  const controlled = canvas?.tokens?.controlled?.filter(token => token?.actor?.uuid === actor?.uuid) ?? [];
  if (controlled.length === 1) return controlled[0];
  const active = actor?.getActiveTokens?.(false, true) ?? [];
  return active.length === 1 ? active[0] : null;
}

async function rollD100(count, { forcedTotal = null, smartRange = null } = {}) {
  const rolls = [];
  for (let index = 0; index < count; index += 1) {
    if (forcedTotal) {
      const roll = new Roll(String(clamp(forcedTotal, 1, 100)));
      rolls.push(await roll.evaluate());
    } else if (smartRange) {
      rolls.push(await rollD100InRange(smartRange));
    } else {
      const roll = new Roll("1d100");
      rolls.push(await roll.evaluate());
    }
  }
  return rolls;
}

async function rollD100InRange(range = {}) {
  const minimum = clamp(range.minimum, 1, 100);
  const maximum = clamp(range.maximum, minimum, 100);
  let fallback = null;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const roll = await new Roll("1d100").evaluate();
    fallback = roll;
    if (roll.total >= minimum && roll.total <= maximum) return roll;
  }
  return fallback ?? new Roll(String(minimum)).evaluate();
}

function calculateEdge(advantageCount, disadvantageCount) {
  const net = toInteger(advantageCount) - toInteger(disadvantageCount);
  if (net > 0) {
    const extra = Math.max(0, net - 1);
    return {
      net,
      rollMode: "advantage",
      skillModifier: extra * 30,
      extra
    };
  }
  if (net < 0) {
    const extra = Math.max(0, Math.abs(net) - 1);
    return {
      net,
      rollMode: "disadvantage",
      skillModifier: extra * -30,
      extra
    };
  }
  return {
    net: 0,
    rollMode: "normal",
    skillModifier: 0,
    extra: 0
  };
}

function selectRoll(rolls, rollMode) {
  if (rollMode === "advantage") return rolls.reduce((best, roll) => roll.total > best.total ? roll : best, rolls[0]);
  if (rollMode === "disadvantage") return rolls.reduce((worst, roll) => roll.total < worst.total ? roll : worst, rolls[0]);
  return rolls[0];
}

function calculateCriticalThresholds(check, finalSkillValue = 0, difficulty = 0) {
  const gambling = toInteger(check.actor?.system?.skills?.gambling?.value);
  const baseFailureChance = clamp(toInteger(check.criticalFailureBonus) + 5, 0, 100);
  const excessSkillSteps = Math.max(0, Math.floor((toInteger(finalSkillValue) - toInteger(difficulty)) / 20));
  const failureReduction = Math.min(baseFailureChance, excessSkillSteps);
  const criticalSuccessOverflow = Math.max(0, excessSkillSteps - baseFailureChance);
  const failureChance = clamp(baseFailureChance - failureReduction, 0, 100);
  const successChance = clamp(Number(check.criticalSuccessBonus || 0) + 4 + (gambling / 20) + criticalSuccessOverflow, 0, 100);
  return {
    baseFailureChance,
    failureChance,
    successChance,
    failureReduction,
    criticalSuccessOverflow,
    failureMaximum: Math.floor(failureChance),
    successMinimum: successChance > 0 ? Math.ceil(101 - successChance) : 101
  };
}

export function calculateSkillCheckSuccessChance(actor, finalSkillValue, difficulty, {
  criticalSuccessBonus = 0,
  criticalFailureBonus = 0
} = {}) {
  const check = {
    actor,
    criticalSuccessBonus,
    criticalFailureBonus
  };
  const critical = calculateCriticalThresholds(check, finalSkillValue, difficulty);
  if (isAutomaticFailure(finalSkillValue, difficulty)) return 0;

  let successes = 0;
  for (let roll = 1; roll <= 100; roll += 1) {
    if (critical.failureMaximum > 0 && roll <= critical.failureMaximum) continue;
    if (critical.successMinimum <= 100 && roll >= critical.successMinimum) {
      successes += 1;
      continue;
    }
    if (toInteger(finalSkillValue) + roll >= toInteger(difficulty)) successes += 1;
  }
  return clamp(successes, 0, 100);
}

function normalizeForcedResult(value) {
  const normalized = String(value ?? "").trim();
  return Object.hasOwn(FORCED_RESULT_TO_SEGMENT, normalized) ? normalized : "";
}

function getForcedRollTotal(forcedResult, difficulty, critical, finalSkillValue) {
  const segmentClass = FORCED_RESULT_TO_SEGMENT[forcedResult];
  const definitions = buildThresholdDefinitions(difficulty, critical, finalSkillValue, false);
  const target = definitions.find(definition => definition.cssClass === segmentClass);
  if (target) return Math.round((target.minimum + target.maximum) / 2);

  if (forcedResult === "criticalFailure") return Math.max(1, Math.min(5, critical.failureMaximum || 1));
  if (forcedResult === "criticalSuccess") return Math.min(100, Math.max(96, critical.successMinimum || 100));
  if (forcedResult === "failure") return Math.max(1, clamp(toInteger(difficulty) - toInteger(finalSkillValue) - 1, 1, 100));
  if (forcedResult === "success") return Math.min(100, clamp(toInteger(difficulty) - toInteger(finalSkillValue), 1, 100));
  return null;
}

function getSmartFudgeRollRange(targetResult, difficulty, critical, finalSkillValue, autoFailure = false) {
  const segmentClass = FORCED_RESULT_TO_SEGMENT[normalizeForcedResult(targetResult)];
  if (!segmentClass) return null;
  const definitions = buildThresholdDefinitions(difficulty, critical, finalSkillValue, autoFailure);
  const target = definitions.find(definition => definition.cssClass === segmentClass);
  if (!target) return null;
  return {
    minimum: clamp(target.minimum, 1, 100),
    maximum: clamp(target.maximum, 1, 100)
  };
}

function determineResult(roll, total, difficulty, critical, autoFailure = false, forcedResult = "") {
  const forced = normalizeForcedResult(forcedResult);
  if (forced) return buildForcedResult(forced);

  if (autoFailure) {
    return {
      key: "failure",
      label: game.i18n.localize("FALLOUTMAW.SkillCheck.AutomaticFailure"),
      cssClass: "failure automatic-failure",
      autoFailure: true
    };
  }
  if (critical.failureMaximum > 0 && roll <= critical.failureMaximum) {
    return {
      key: "criticalFailure",
      label: game.i18n.localize("FALLOUTMAW.SkillCheck.CriticalFailure"),
      cssClass: "critical-failure",
      autoFailure: false
    };
  }
  if (critical.successMinimum <= 100 && roll >= critical.successMinimum) {
    return {
      key: "criticalSuccess",
      label: game.i18n.localize("FALLOUTMAW.SkillCheck.CriticalSuccess"),
      cssClass: "critical-success",
      autoFailure: false
    };
  }
  if (total >= toInteger(difficulty)) {
    return {
      key: "success",
      label: game.i18n.localize("FALLOUTMAW.SkillCheck.Success"),
      cssClass: "success",
      autoFailure: false
    };
  }
  return {
    key: "failure",
    label: game.i18n.localize(autoFailure ? "FALLOUTMAW.SkillCheck.AutomaticFailure" : "FALLOUTMAW.SkillCheck.Failure"),
    cssClass: "failure",
    autoFailure
  };
}

function buildForcedResult(forcedResult) {
  if (forcedResult === "criticalFailure") {
    return {
      key: "criticalFailure",
      label: game.i18n.localize("FALLOUTMAW.SkillCheck.CriticalFailure"),
      cssClass: "critical-failure",
      autoFailure: false
    };
  }
  if (forcedResult === "criticalSuccess") {
    return {
      key: "criticalSuccess",
      label: game.i18n.localize("FALLOUTMAW.SkillCheck.CriticalSuccess"),
      cssClass: "critical-success",
      autoFailure: false
    };
  }
  if (forcedResult === "success") {
    return {
      key: "success",
      label: game.i18n.localize("FALLOUTMAW.SkillCheck.Success"),
      cssClass: "success",
      autoFailure: false
    };
  }
  return {
    key: "failure",
    label: game.i18n.localize("FALLOUTMAW.SkillCheck.Failure"),
    cssClass: "failure",
    autoFailure: false
  };
}

function isAutomaticFailure(finalSkillValue, difficulty) {
  return (toInteger(difficulty) - toInteger(finalSkillValue)) >= 100;
}

function activateSkillCheckDialog(dialog) {
  const form = dialog.element?.querySelector("form") ?? dialog.form;
  if (!form) return;
  const advantage = form.querySelector("[data-skill-check-advantage]");
  const disadvantage = form.querySelector("[data-skill-check-disadvantage]");
  const advantageCount = form.elements.advantageCount;
  const disadvantageCount = form.elements.disadvantageCount;
  const syncCounters = () => {
    if (advantageCount) advantageCount.disabled = !advantage?.checked;
    if (disadvantageCount) disadvantageCount.disabled = !disadvantage?.checked;
  };
  advantage?.addEventListener("change", () => {
    if (advantage.checked && disadvantage) disadvantage.checked = false;
    syncCounters();
  });
  disadvantage?.addEventListener("change", () => {
    if (disadvantage.checked && advantage) advantage.checked = false;
    syncCounters();
  });
  syncCounters();
}

function formatEdgeMode(edge) {
  if (edge.rollMode === "advantage") return game.i18n.localize("FALLOUTMAW.SkillCheck.Advantage");
  if (edge.rollMode === "disadvantage") return game.i18n.localize("FALLOUTMAW.SkillCheck.Disadvantage");
  return game.i18n.localize("FALLOUTMAW.SkillCheck.Normal");
}

function buildRollEntries(
  rolls,
  selectedRoll,
  difficulty,
  critical,
  finalSkillValue,
  forcedResult = "",
  autoFailure = isAutomaticFailure(finalSkillValue, difficulty)
) {
  return rolls.map((roll, index) => {
    const result = determineResult(
      roll.total,
      toInteger(finalSkillValue) + toInteger(roll.total),
      difficulty,
      critical,
      autoFailure,
      forcedResult
    );
    return {
      index: index + 1,
      total: roll.total,
      selected: roll === selectedRoll,
      result
    };
  });
}

function buildThresholdRows(
  difficulty,
  critical,
  finalSkillValue,
  autoFailure = isAutomaticFailure(finalSkillValue, difficulty)
) {
  return buildThresholdDefinitions(difficulty, critical, finalSkillValue, autoFailure)
    .slice()
    .reverse()
    .map(definition => buildThresholdRow(definition.cssClass, definition.label, definition.minimum, definition.maximum))
    .filter(Boolean);
}

function buildScaleSegments(
  difficulty,
  critical,
  finalSkillValue,
  selectedRollTotal,
  forcedResult = "",
  autoFailure = isAutomaticFailure(finalSkillValue, difficulty)
) {
  const roll = clamp(selectedRollTotal, 1, 100);
  const forcedSegment = FORCED_RESULT_TO_SEGMENT[normalizeForcedResult(forcedResult)] ?? "";
  return buildThresholdDefinitions(difficulty, critical, finalSkillValue, autoFailure)
    .map(definition => ({
      ...definition,
      active: forcedSegment ? definition.cssClass === forcedSegment : roll >= definition.minimum && roll <= definition.maximum,
      width: (((definition.maximum - definition.minimum) + 1) / 100) * 100
    }));
}

function buildProgressCells(
  difficulty,
  critical,
  finalSkillValue,
  autoFailure = isAutomaticFailure(finalSkillValue, difficulty)
) {
  const definitions = buildThresholdDefinitions(difficulty, critical, finalSkillValue, autoFailure);
  return Array.from({ length: 20 }, (_value, index) => {
    const start = index * 5;
    const end = start + 5;
    return {
      index: index + 1,
      start,
      end,
      gradient: buildProgressCellGradient(start, end, definitions),
      definitions
    };
  });
}

function buildProgressCellsForTarget(progressCells, targetPercent) {
  const target = clamp(targetPercent, 1, 100);
  const targetCellIndex = Math.ceil(target / 5);
  return progressCells.map(cell => {
    if (cell.index !== targetCellIndex) return cell;
    return {
      ...cell,
      gradient: buildProgressCellFillGradient(cell, target)
    };
  });
}

function buildProgressCellFillGradient(cell, targetPercent) {
  const cellStart = Number(cell.start) || 0;
  const cellEnd = Number(cell.end) || cellStart + 5;
  const fillEnd = clamp(targetPercent, cellStart, cellEnd);
  const fillWidth = Math.max(0.01, fillEnd - cellStart);
  const stops = [];

  for (const definition of cell.definitions ?? []) {
    const rangeStart = definition.minimum - 1;
    const rangeEnd = definition.maximum;
    const overlapStart = Math.max(cellStart, rangeStart);
    const overlapEnd = Math.min(fillEnd, rangeEnd);
    if (overlapEnd <= overlapStart) continue;

    const color = getThresholdColorVariable(definition.cssClass);
    const localStart = ((overlapStart - cellStart) / fillWidth) * 100;
    const localEnd = ((overlapEnd - cellStart) / fillWidth) * 100;
    stops.push(`${color} ${formatPercent(localStart)} ${formatPercent(localEnd)}`);
  }

  return stops.length ? stops.join(", ") : cell.gradient;
}

function buildProgressCellGradient(cellStart, cellEnd, definitions) {
  const stops = [];
  for (const definition of definitions) {
    const rangeStart = definition.minimum - 1;
    const rangeEnd = definition.maximum;
    const overlapStart = Math.max(cellStart, rangeStart);
    const overlapEnd = Math.min(cellEnd, rangeEnd);
    if (overlapEnd <= overlapStart) continue;

    const color = getThresholdColorVariable(definition.cssClass);
    const localStart = ((overlapStart - cellStart) / (cellEnd - cellStart)) * 100;
    const localEnd = ((overlapEnd - cellStart) / (cellEnd - cellStart)) * 100;
    stops.push(`${color} ${formatPercent(localStart)} ${formatPercent(localEnd)}`);
  }

  return stops.length ? stops.join(", ") : "var(--fallout-maw-animation-muted) 0% 100%";
}

function getThresholdColorVariable(cssClass) {
  if (cssClass === "automatic-failure") return "var(--fallout-maw-animation-red)";
  if (cssClass === "critical-failure") return "var(--fallout-maw-animation-red)";
  if (cssClass === "failure") return "var(--fallout-maw-animation-orange)";
  if (cssClass === "success") return "var(--fallout-maw-animation-cyan)";
  if (cssClass === "critical-success") return "var(--fallout-maw-animation-green)";
  return "var(--fallout-maw-animation-muted)";
}

function formatPercent(value) {
  const rounded = Math.round(value * 100) / 100;
  return `${rounded}%`;
}

function buildThresholdDefinitions(
  difficulty,
  critical,
  finalSkillValue,
  autoFailure = isAutomaticFailure(finalSkillValue, difficulty)
) {
  if (autoFailure) {
    return [
      buildThresholdDefinition(
        "automatic-failure",
        game.i18n.localize("FALLOUTMAW.SkillCheck.AutomaticFailure"),
        game.i18n.localize("FALLOUTMAW.SkillCheck.AutomaticFailureShort"),
        1,
        100
      )
    ];
  }

  const successMinimum = clamp(toInteger(difficulty) - toInteger(finalSkillValue), 1, 100);
  const criticalFailureMaximum = Math.min(critical.failureMaximum, 100);
  const criticalSuccessMinimum = Math.max(critical.successMinimum, 1);
  const failureMinimum = Math.max(1, criticalFailureMaximum + 1);
  const failureMaximum = Math.min(successMinimum - 1, criticalSuccessMinimum - 1);
  const normalSuccessMinimum = Math.max(successMinimum, criticalFailureMaximum + 1);
  const normalSuccessMaximum = Math.min(100, criticalSuccessMinimum - 1);

  return [
    buildThresholdDefinition("critical-failure", game.i18n.localize("FALLOUTMAW.SkillCheck.CriticalFailure"), game.i18n.localize("FALLOUTMAW.SkillCheck.CriticalFailureShort"), 1, criticalFailureMaximum),
    buildThresholdDefinition("failure", game.i18n.localize("FALLOUTMAW.SkillCheck.Failure"), game.i18n.localize("FALLOUTMAW.SkillCheck.FailureShort"), failureMinimum, failureMaximum),
    buildThresholdDefinition("success", game.i18n.localize("FALLOUTMAW.SkillCheck.Success"), game.i18n.localize("FALLOUTMAW.SkillCheck.SuccessShort"), normalSuccessMinimum, normalSuccessMaximum),
    buildThresholdDefinition("critical-success", game.i18n.localize("FALLOUTMAW.SkillCheck.CriticalSuccess"), game.i18n.localize("FALLOUTMAW.SkillCheck.CriticalSuccessShort"), criticalSuccessMinimum, 100)
  ].filter(Boolean);
}

function buildThresholdDefinition(cssClass, label, shortLabel, minimum, maximum) {
  if (maximum < minimum) return null;
  return {
    cssClass,
    label,
    shortLabel,
    minimum,
    maximum
  };
}

function buildThresholdRow(cssClass, label, minimum, maximum) {
  if (maximum < minimum) return null;
  return {
    cssClass,
    label,
    range: minimum === maximum ? String(minimum) : `${minimum}-${maximum}`
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}
