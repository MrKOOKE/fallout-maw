import {
  TURN_CONVERSION_MODES,
  prepareActorTurnEnd,
  prepareCombatTurnRewind,
  prepareCombatTurnStart
} from "../combat/reaction-resources.mjs";
import { COMBAT_DELETION_SETTLED_HOOK, SYSTEM_ID } from "../constants.mjs";
import { isActorUnableToAct } from "../combat/reaction-hub.mjs";
import {
  INITIATIVE_ADVANTAGE_EFFECT_KEY,
  INITIATIVE_DISADVANTAGE_EFFECT_KEY,
  evaluateActorEffectChangeNumber
} from "../utils/active-effect-changes.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { withSystemEventRoot } from "../events/dispatcher.mjs";
import { runTerminalSystemEventWorkflow } from "../utils/system-event-workflow.mjs";
import { getContextualAbilityChangeValues } from "../abilities/evaluation.mjs";
import {
  BLOCK_TURN_ACTOR_OPTION,
  BLOCK_TURN_COMBATANT_OPTION,
  BLOCK_TURN_STATE_FLAG,
  createBlockTurnState,
  getActiveBlockProgress,
  getActiveBlockTokenObjects,
  getBlockTurnTargetCombatant,
  getCombatTurnBlocks,
  getNextBlockTurnIndex,
  isActiveBlockComplete,
  isBlockTurnOrderEnabled,
  isCombatantAutoCompleted,
  isCombatantCompletedInActiveBlock,
  markCombatantCompletedInState
} from "../combat/turn-order-blocks.mjs";
import { callCombatRoundStartHandlers } from "../combat/turn-events.mjs";
import { createCoalescingOperationQueue } from "../combat/coalescing-operation-queue.mjs";
import { waitForWorldTimeQueueIdle } from "../time/world-time-queue.mjs";
import {
  cleanupDeletedCombatResources,
  cleanupStoppedCombatResources
} from "../combat/resource-lifecycle.mjs";
import { requestCombatTurnNavigation } from "../combat/turn-navigation-socket.mjs";
import {
  captureActiveEffectRegistryRefresh,
  trackCombatantCreateActiveEffectRefresh
} from "../combat/active-effect-lifecycle.mjs";
import {
  COMBATANT_LIFECYCLE_OPERATION_OPTION,
  COMBAT_LIFECYCLE_CONTEXT_OPTION,
  COMBAT_LIFECYCLE_SETTLEMENT_OPTION,
  acquireCombatLifecycleLease,
  settleCombatLifecycleLease
} from "../combat/combat-lifecycle-lease.mjs";

const SURPRISED_INITIATIVE_OPTION = "falloutMawSurprisedCombatantIds";

export class FalloutMaWCombat extends Combat {
  #turnNavigationQueue = createCoalescingOperationQueue({
    onError: error => console.error(`${SYSTEM_ID} | Combat turn operation failed`, error)
  });
  #permittedNestedTurnMethod = "";
  #turnLifecycleGeneration = 0;
  #latestTurnLifecycle = Promise.resolve();
  #pendingTurnEndConversions = new Map();
  #activeLifecycleContextId = "";
  #permittedCombatUpdateContextId = "";
  #deletionRequested = false;
  #deletionPromise = null;
  #combatEndRefreshPromise = Promise.resolve();
  #combatantOperationLifecycles = new Map();

  async resetAll({ updateTurn = true } = {}) {
    const updates = Array.from(this.combatants ?? [], combatant => ({
      _id: combatant.id,
      initiative: null
    }));
    if (!updates.length) return this;
    const updateOptions = { turnEvents: false };
    if (!updateTurn) updateOptions.combatTurn = this.turn;
    await this.updateEmbeddedDocuments("Combatant", updates, updateOptions);
    return this;
  }

  async rollInitiative(ids, options = {}) {
    const surprisedIds = normalizeCombatantIdSet(options?.[SURPRISED_INITIATIVE_OPTION]);

    const {
      [SURPRISED_INITIATIVE_OPTION]: _surprised,
      formula = null,
      updateTurn = true,
      messageMode,
      messageOptions = {}
    } = options;

    return this.#rollInitiativeWithSurprise(ids, {
      formula,
      updateTurn,
      messageMode,
      messageOptions
    }, surprisedIds);
  }

  get falloutMawTurnTransitionPending() {
    return this.#turnNavigationQueue.busy;
  }

  get falloutMawLifecycleContextId() {
    return this.#activeLifecycleContextId;
  }

  isFalloutMawLifecycleContext(contextId = "") {
    return Boolean(contextId) && String(contextId) === this.#activeLifecycleContextId;
  }

  runFalloutMawLifecycleOperation(key, operation, {
    allowDuringDeletion = false,
    contextId = ""
  } = {}) {
    if (typeof operation !== "function") {
      return Promise.reject(new TypeError("Combat lifecycle operation must be a function."));
    }
    const requestedContextId = String(contextId ?? "");
    if (requestedContextId && this.isFalloutMawLifecycleContext(requestedContextId)) {
      if (!allowDuringDeletion && this.#deletionRequested) {
        return Promise.reject(new Error("The combat is being deleted."));
      }
      if (!game.user?.isActiveGM) {
        return Promise.reject(new Error("Combat authority changed."));
      }
      return Promise.resolve().then(() => operation({
        contextId: requestedContextId,
        reentrant: true
      }));
    }
    const lifecycleContextId = requestedContextId || foundry.utils.randomID();
    return this.#turnNavigationQueue.run(`lifecycle:${String(key ?? "")}`, async () => {
      if (!allowDuringDeletion && this.#deletionRequested) {
        throw new Error("The combat is being deleted.");
      }
      if (!game.user?.isActiveGM) {
        throw new Error("Only the active GM may mutate the combat lifecycle.");
      }
      this.#activeLifecycleContextId = lifecycleContextId;
      try {
        return await operation({
          contextId: lifecycleContextId,
          reentrant: false
        });
      } finally {
        if (this.#activeLifecycleContextId === lifecycleContextId) {
          this.#activeLifecycleContextId = "";
        }
      }
    });
  }

  update(changes = {}, options = {}) {
    const permittedContextId = this.#permittedCombatUpdateContextId;
    if (permittedContextId) {
      this.#permittedCombatUpdateContextId = "";
      return super.update(changes, {
        ...options,
        [COMBAT_LIFECYCLE_CONTEXT_OPTION]: permittedContextId
      });
    }
    return super.update(changes, options);
  }

  async waitForFalloutMawTurnTransition() {
    await this.#turnNavigationQueue.wait();
    await this.waitForFalloutMawTurnLifecycle();
  }

  async waitForFalloutMawTurnLifecycle({ rejectOnError = false } = {}) {
    return this.waitForFalloutMawTurnLifecycleAfter(-1, { rejectOnError });
  }

  async waitForFalloutMawTurnLifecycleAfter(generation, { rejectOnError = false } = {}) {
    let observedGeneration = Number.isInteger(generation) ? generation : -1;
    let firstError = null;
    while (this.#turnLifecycleGeneration > observedGeneration) {
      observedGeneration = this.#turnLifecycleGeneration;
      try {
        await this.#latestTurnLifecycle;
      } catch (error) {
        firstError ??= error;
      }
    }
    if (rejectOnError && firstError) throw firstError;
  }

  async waitForFalloutMawCombatantOperationLifecycle(operationId = "") {
    const id = String(operationId ?? "");
    const lifecycle = this.#combatantOperationLifecycles.get(id);
    if (!id || !lifecycle) return false;
    try {
      await lifecycle;
    } finally {
      if (this.#combatantOperationLifecycles.get(id) === lifecycle) {
        this.#combatantOperationLifecycles.delete(id);
      }
    }
    return true;
  }

  clearFalloutMawCombatantOperationLifecycle(operationId = "") {
    const id = String(operationId ?? "");
    return id ? this.#combatantOperationLifecycles.delete(id) : false;
  }

  static updateDocuments(updates = [], operation = {}) {
    const documents = resolveCombatLifecycleUpdateDocuments(updates, operation);
    if (isUnsupportedCombatBatchPreflight(updates, operation)) {
      return Promise.reject(new Error(
        "Combat lifecycle changes are not supported inside modifyDocumentBatch."
      ));
    }
    if (
      operation.pack
      || operation.dryRun
      || !documents.length
      || !hasCombatLifecycleUpdate(updates)
    ) {
      return super.updateDocuments(updates, operation);
    }
    if (documents.length > 1) {
      return Promise.reject(new Error(
        "Lifecycle-bearing updates for multiple Combats must be submitted separately."
      ));
    }

    const combat = documents[0];
    const contextId = String(operation[COMBAT_LIFECYCLE_CONTEXT_OPTION] ?? "");
    if (contextId && combat.isFalloutMawLifecycleContext(contextId)) {
      return super.updateDocuments(updates, operation);
    }

    const operationId = foundry.utils.randomID();
    if (game.user?.isActiveGM) {
      return combat.runFalloutMawLifecycleOperation(
        `combat-update:${operationId}`,
        ({ contextId: lockedContextId }) => super.updateDocuments(updates, {
          ...operation,
          [COMBAT_LIFECYCLE_CONTEXT_OPTION]: lockedContextId
        })
      );
    }
    return runRemoteCombatUpdate(combat, updates, operation, lockedOperation => (
      super.updateDocuments(updates, lockedOperation)
    ));
  }

  static async deleteDocuments(ids = [], operation = {}) {
    if (operation.dryRun) return super.deleteDocuments(ids, operation);
    const documents = resolveCombatDeletionDocuments(ids, operation);
    if (!game.user?.isActiveGM && documents.length && !operation.pack) {
      for (const combat of documents) {
        await requestCombatTurnNavigation(combat, "delete", { options: operation });
      }
      return documents;
    }

    for (const combat of documents) combat.#deletionRequested = true;
    try {
      const deleted = await super.deleteDocuments(ids, operation);
      const deletedIds = new Set(Array.from(deleted ?? [], combat => combat?.id).filter(Boolean));
      for (const combat of documents) {
        if (!deletedIds.has(combat.id)) combat.#deletionRequested = false;
      }
      return deleted;
    } catch (error) {
      for (const combat of documents) combat.#deletionRequested = false;
      throw error;
    }
  }

  delete(options = {}) {
    if (options.dryRun) return super.delete(options);
    if (this.#deletionPromise) return this.#deletionPromise;
    this.#deletionRequested = true;
    const deletion = (async () => {
      await this.#turnNavigationQueue.wait();
      if (game.user?.isActiveGM) {
        const deleted = await super.delete(options);
        if (!deleted) this.#deletionRequested = false;
        return deleted;
      }
      await requestCombatTurnNavigation(this, "delete", { options });
      return this;
    })();
    const tracked = deletion
      .catch(error => {
        this.#deletionRequested = false;
        throw error;
      })
      .finally(() => {
        if (this.#deletionPromise === tracked) this.#deletionPromise = null;
      });
    this.#deletionPromise = tracked;
    return tracked;
  }

  setTurn(turn, options = {}) {
    const targetTurn = Number(turn);
    if (!Number.isInteger(targetTurn) || targetTurn < 0 || targetTurn >= this.turns.length) {
      return Promise.resolve(this);
    }
    if (!game.user?.isActiveGM) {
      return this.#requestRemoteTurnNavigation("setTurn", {
        turn: targetTurn,
        options
      });
    }
    const requestOptions = { ...options, falloutMawTargetTurn: targetTurn };
    return this.#enqueueTurnNavigation("setTurn", requestOptions, () => (
      this.#callFoundryTurnNavigation(async () => {
        await this.update({ turn: targetTurn }, options);
        return this;
      })
    ));
  }

  startCombat(options = {}) {
    if (!game.user?.isActiveGM) {
      return this.#requestRemoteTurnNavigation("startCombat", { options });
    }
    return this.#enqueueTurnNavigation("startCombat", options, async () => {
      this._playCombatSound("startEncounter");
      const updateData = { round: 1, turn: 0 };
      Hooks.callAll("combatStart", this, updateData);
      await this.#callFoundryTurnNavigation(() => this.update(updateData));
      await ActiveEffect.registry.refresh("combatStart", { combat: this });
      return this;
    });
  }

  nextTurn(options = {}) {
    if (!game.user?.isActiveGM) {
      return this.#requestRemoteTurnNavigation("nextTurn", { options });
    }
    return this.#enqueueTurnNavigation("nextTurn", options, async () => {
      if (isBlockTurnOrderEnabled(this)) return this.#nextBlockTurn(options);
      const actorUuid = this.#stageCurrentTurnEnd(options);
      try {
        return await this.#callFoundryTurnNavigation(
          () => super.nextTurn(options),
          { nestedMethod: this.#foundryNextTurnDelegatesToNextRound() ? "nextRound" : "" }
        );
      } finally {
        if (actorUuid) this.#pendingTurnEndConversions.delete(actorUuid);
      }
    });
  }

  previousTurn(options = {}) {
    if (!game.user?.isActiveGM) {
      return this.#requestRemoteTurnNavigation("previousTurn", { options });
    }
    return this.#enqueueTurnNavigation("previousTurn", options, async () => {
      if (isBlockTurnOrderEnabled(this)) return this.#previousBlockTurn(options);
      const actorUuid = this.#stageCurrentTurnEnd(options);
      try {
        return await this.#callFoundryTurnNavigation(
          () => super.previousTurn(options),
          { nestedMethod: this.#foundryPreviousTurnDelegatesToPreviousRound() ? "previousRound" : "" }
        );
      } finally {
        if (actorUuid) this.#pendingTurnEndConversions.delete(actorUuid);
      }
    });
  }

  nextRound(options = {}) {
    if (this.#consumePermittedNestedTurnMethod("nextRound")) return super.nextRound(options);
    if (!game.user?.isActiveGM) {
      return this.#requestRemoteTurnNavigation("nextRound", { options });
    }
    return this.#enqueueTurnNavigation("nextRound", options, async () => {
      if (isBlockTurnOrderEnabled(this)) {
        await this.#processBlockTurnTargetEnd(options);
        return this.#callFoundryTurnNavigation(() => super.nextRound(options));
      }
      const actorUuid = this.#stageCurrentTurnEnd(options);
      try {
        return await this.#callFoundryTurnNavigation(() => super.nextRound(options));
      } finally {
        if (actorUuid) this.#pendingTurnEndConversions.delete(actorUuid);
      }
    });
  }

  previousRound(options = {}) {
    if (this.#consumePermittedNestedTurnMethod("previousRound")) return super.previousRound(options);
    if (!game.user?.isActiveGM) {
      return this.#requestRemoteTurnNavigation("previousRound", { options });
    }
    return this.#enqueueTurnNavigation("previousRound", options, async () => {
      if (isBlockTurnOrderEnabled(this)) {
        return this.#callFoundryTurnNavigation(() => super.previousRound(options));
      }
      const actorUuid = this.#stageCurrentTurnEnd(options);
      try {
        return await this.#callFoundryTurnNavigation(() => super.previousRound(options));
      } finally {
        if (actorUuid) this.#pendingTurnEndConversions.delete(actorUuid);
      }
    });
  }

  async #nextBlockTurn(options = {}) {
    if (this.round === 0) {
      return this.#callFoundryTurnNavigation(() => super.nextRound(options));
    }
    const progress = getActiveBlockProgress(this);
    if (!progress) return this;

    let state = progress.state;
    const target = getBlockTurnTargetCombatant(this, options);
    if (target && !isCombatantCompletedInActiveBlock(target, this)) {
      state = await this.#completeBlockCombatantTurnEnd(target, options, state);
    }

    if (!isActiveBlockComplete(this, state)) return this;

    const nextTurn = getNextBlockTurnIndex(this, 1);
    if (nextTurn === null) {
      return this.#callFoundryTurnNavigation(() => super.nextRound(options));
    }
    await this.#advanceToTurn(nextTurn, 1);
    return this;
  }

  async #previousBlockTurn(options = {}) {
    if (this.round === 0) return this;
    const previousTurn = getNextBlockTurnIndex(this, -1);
    if (previousTurn === null) {
      return this.#callFoundryTurnNavigation(() => super.previousRound(options));
    }
    await this.#advanceToTurn(previousTurn, -1);
    return this;
  }

  async #processBlockTurnTargetEnd(options = {}) {
    const target = getBlockTurnTargetCombatant(this, options);
    if (!target || isCombatantCompletedInActiveBlock(target, this)) return true;
    const progress = getActiveBlockProgress(this);
    await this.#completeBlockCombatantTurnEnd(
      target,
      options,
      progress?.state ?? createBlockTurnState(this, progress?.block)
    );
    return true;
  }

  async #completeBlockCombatantTurnEnd(combatant, options, state) {
    const next = markCombatantCompletedInState(this, combatant, state);
    await this.#updateBlockTurnState(next);
    try {
      const processed = await this.#processCombatantTurnEnd(combatant, options);
      if (!processed) throw new Error("The active GM could not complete the block turn.");
      return next;
    } catch (error) {
      try {
        await this.#updateBlockTurnState(state);
      } catch (rollbackError) {
        console.error(`${SYSTEM_ID} | Failed to roll back block turn completion`, rollbackError);
      }
      throw error;
    }
  }

  async #processCombatantTurnEnd(combatant, options = {}) {
    if (!game.user?.isActiveGM) return false;
    if (!this.started || !combatant) return false;
    if (!combatant.actor) return true;
    const conversionMode = this.#getTurnEndConversionMode(combatant, options);
    await prepareActorTurnEnd(combatant.actor, { conversionMode, combat: this });
    return true;
  }

  #stageCurrentTurnEnd(options = {}) {
    const combatant = this.combatant;
    const actorUuid = combatant?.actor?.uuid ?? "";
    if (!this.started || !actorUuid) return "";
    this.#pendingTurnEndConversions.set(
      actorUuid,
      this.#getTurnEndConversionMode(combatant, options)
    );
    return actorUuid;
  }

  #getTurnEndConversionMode(combatant, options = {}) {
    if (combatant?.isDefeated || isActorUnableToAct(combatant?.actor)) {
      return TURN_CONVERSION_MODES.skip;
    }
    const requested = options?.falloutMawConversionMode;
    return Object.values(TURN_CONVERSION_MODES).includes(requested)
      ? requested
      : TURN_CONVERSION_MODES.dodge;
  }

  #enqueueTurnNavigation(method, options, operation) {
    const request = this.#createTurnNavigationRequest(method, options);
    return this.runFalloutMawLifecycleOperation(
      request.key,
      async ({ contextId }) => {
        if (!this.#turnNavigationRequestMatches(request)) {
          throw new Error("The combat turn changed while this operation was waiting.");
        }
        return operation(contextId);
      },
      {
        contextId: String(options?.[COMBAT_LIFECYCLE_CONTEXT_OPTION] ?? "")
      }
    );
  }

  async #requestRemoteTurnNavigation(method, request = {}) {
    if (this.#deletionRequested && method !== "delete") {
      throw new Error("The combat is being deleted.");
    }
    await requestCombatTurnNavigation(this, method, request);
    return this;
  }

  #createTurnNavigationRequest(method, options = {}) {
    const snapshot = this.#getTurnNavigationSnapshot(options);
    const intent = {
      method: String(method ?? ""),
      conversionMode: String(options?.falloutMawConversionMode ?? ""),
      targetTurn: Number.isInteger(options?.falloutMawTargetTurn)
        ? options.falloutMawTargetTurn
        : null,
      requestedCombatantId: String(options?.[BLOCK_TURN_COMBATANT_OPTION] ?? ""),
      requestedActorUuid: String(options?.[BLOCK_TURN_ACTOR_OPTION] ?? ""),
      targetCombatantId: snapshot.targetCombatantId,
      targetActorUuid: snapshot.targetActorUuid
    };
    return {
      method: intent.method,
      snapshot,
      options,
      key: JSON.stringify({ snapshot, intent })
    };
  }

  #turnNavigationRequestMatches(request) {
    const expected = request?.snapshot;
    if (!expected?.explicitTargetValid) return false;
    const current = this.#getTurnNavigationSnapshot(request?.options ?? {});
    if (!expected.block) return JSON.stringify(current) === JSON.stringify(expected);
    if (!current.block || !current.explicitTargetValid) return false;
    const stableExpected = {
      round: expected.round,
      turn: expected.turn,
      combatantId: expected.combatantId,
      turnOrder: expected.turnOrder,
      blockSignature: expected.block.signature,
      targetCombatantId: expected.targetCombatantId,
      targetActorUuid: expected.targetActorUuid
    };
    const stableCurrent = {
      round: current.round,
      turn: current.turn,
      combatantId: current.combatantId,
      turnOrder: current.turnOrder,
      blockSignature: current.block.signature,
      targetCombatantId: current.targetCombatantId,
      targetActorUuid: current.targetActorUuid
    };
    if (JSON.stringify(stableCurrent) !== JSON.stringify(stableExpected)) return false;
    if (["previousTurn", "previousRound", "setTurn", "startCombat"].includes(request.method)) {
      return true;
    }
    const target = current.targetCombatantId
      ? this.combatants?.get(current.targetCombatantId)
      : null;
    if (target && !isCombatantCompletedInActiveBlock(target, this)) return true;
    const explicitTargetRequested = Boolean(
      request?.options?.[BLOCK_TURN_COMBATANT_OPTION]
      || request?.options?.[BLOCK_TURN_ACTOR_OPTION]
    );
    if (
      target
      && explicitTargetRequested
      && isCombatantAutoCompleted(target)
      && ["nextTurn", "nextRound"].includes(request.method)
    ) {
      return true;
    }
    return (
      ["nextTurn", "nextRound"].includes(request.method)
      && !current.targetCombatantId
      && isActiveBlockComplete(this)
    );
  }

  #getTurnNavigationSnapshot(options = {}) {
    const progress = isBlockTurnOrderEnabled(this) ? getActiveBlockProgress(this) : null;
    const target = progress ? getBlockTurnTargetCombatant(this, options) : null;
    const requestedCombatantId = String(options?.[BLOCK_TURN_COMBATANT_OPTION] ?? "");
    const requestedActorUuid = String(options?.[BLOCK_TURN_ACTOR_OPTION] ?? "");
    const explicitTargetValid = (
      (!requestedCombatantId || target?.id === requestedCombatantId)
      && (!requestedActorUuid || target?.actor?.uuid === requestedActorUuid)
    );
    return {
      round: Number(this.round) || 0,
      turn: Number.isInteger(this.turn) ? this.turn : null,
      combatantId: String(this.combatant?.id ?? this.current?.combatantId ?? ""),
      turnOrder: Array.from(this.turns ?? [], combatant => String(combatant?.id ?? "")),
      block: progress ? {
        signature: String(progress.block?.signature ?? ""),
        preparedActorUuids: Array.from(progress.preparedActorUuids).sort(),
        completedActorUuids: Array.from(progress.completedActorUuids).sort(),
        completedCombatantIds: Array.from(progress.completedCombatantIds).sort()
      } : null,
      targetCombatantId: String(target?.id ?? ""),
      targetActorUuid: String(target?.actor?.uuid ?? ""),
      explicitTargetValid
    };
  }

  #consumePermittedNestedTurnMethod(method) {
    if (this.#permittedNestedTurnMethod !== method) return false;
    this.#permittedNestedTurnMethod = "";
    return true;
  }

  #foundryNextTurnDelegatesToNextRound() {
    if (this.round === 0) return true;
    const turn = this.turn ?? -1;
    if (!this.settings?.skipDefeated) return (turn + 1) >= this.turns.length;
    return !this.turns.slice(turn + 1).some(combatant => !combatant.isDefeated);
  }

  #foundryPreviousTurnDelegatesToPreviousRound() {
    if (this.round === 0) return false;
    return this.turn === 0 || this.turns.length === 0;
  }

  async #callFoundryTurnNavigation(operation, { nestedMethod = "" } = {}) {
    let resultPromise;
    this.#permittedNestedTurnMethod = nestedMethod;
    this.#permittedCombatUpdateContextId = this.#activeLifecycleContextId;
    try {
      resultPromise = operation();
    } finally {
      this.#permittedNestedTurnMethod = "";
      this.#permittedCombatUpdateContextId = "";
    }
    return resultPromise;
  }

  async #advanceToTurn(turn, direction = 1) {
    if (!Number.isInteger(turn) || turn < 0 || turn >= this.turns.length) return this;
    const advanceTime = this.getTimeDelta(this.round, this.turn, this.round, turn);
    const updateData = { round: this.round, turn };
    const updateOptions = { direction, worldTime: { delta: advanceTime } };
    return this.#callFoundryTurnNavigation(async () => {
      Hooks.callAll("combatTurn", this, updateData, updateOptions);
      await this.update(updateData, updateOptions);
      return this;
    });
  }

  async #updateBlockTurnState(state) {
    const progress = getActiveBlockProgress(this);
    const block = progress?.block;
    if (!block) return this;
    const next = createBlockTurnState(this, block, state);
    await this.update({
      [`flags.${SYSTEM_ID}.${BLOCK_TURN_STATE_FLAG}`]: next
    }, { turnEvents: false });
    this._updateTurnMarkers();
    return this;
  }

  _manageTurnEvents() {
    const previous = { ...(this.previous ?? {}) };
    const current = { ...(this.current ?? {}) };
    const rewind = isCombatTurnRewind(previous, current);
    // Core expands a raw turn-index jump into one lifecycle per skipped
    // Combatant. A faction block is one logical turn, so snapshot its two
    // endpoints and run the equivalent core order once for the whole block.
    const blockTransition = !rewind && isBlockTurnOrderEnabled(this)
      ? createBlockTurnTransitionSnapshot(this, previous, current)
      : null;
    this.#turnLifecycleGeneration += 1;
    const lifecycle = (async () => {
      if (rewind) {
        let turnEndProcessed = false;
        if (game.user?.isActiveGM) {
          const previousCombatant = this.combatants?.get(previous.combatantId) ?? null;
          const previousActor = previousCombatant?.actor ?? null;
          const hasStagedConversion = Boolean(
            previousActor?.uuid
            && this.#pendingTurnEndConversions.has(previousActor.uuid)
          );
          if (previousActor && (hasStagedConversion || (
            this.started && !isBlockTurnOrderEnabled(this)
          ))) {
            const conversionMode = this.#pendingTurnEndConversions.get(previousActor.uuid)
              ?? this.#getTurnEndConversionMode(previousCombatant);
            await prepareActorTurnEnd(previousActor, {
              conversionMode,
              combat: this,
              turnContext: {
                round: previous.round,
                turn: previous.turn,
                rewind: true
              }
            });
            turnEndProcessed = true;
          }
          if (this.started) {
            await ActiveEffect.registry.refresh("combatRewind", {
              combat: this,
              round: current.round,
              turn: current.turn,
              actors: new Set(this.combatants.map(combatant => combatant.actor))
            });
          }
        }
        if (!this.started) {
          if (game.user?.isActiveGM) await cleanupStoppedCombatResources(this);
          return;
        }
        await prepareCombatTurnRewind(this, previous, current, {
          turnEndProcessed,
          lifecycleContextId: this.#activeLifecycleContextId
        });
        Hooks.callAll("combatTurnChange", this, previous, current);
      } else if (blockTransition) {
        await this.#manageBlockTurnEvents(blockTransition);
      } else {
        await super._manageTurnEvents();
      }
    })();
    this.#latestTurnLifecycle = lifecycle;
    void lifecycle.catch(error => {
      console.error(`${SYSTEM_ID} | Combat turn lifecycle failed`, error);
    });
    return lifecycle;
  }

  async #manageBlockTurnEvents(transition) {
    if (!this.started) return;
    const {
      previous,
      current,
      previousBlock,
      currentBlock,
      logicalTurnChanged
    } = transition;

    if (game.user?.isActiveGM) {
      if (logicalTurnChanged && previous.round > 0 && previousBlock) {
        await this.#onEndBlockTurn(previousBlock, createBlockTurnEventContext(previous, previousBlock));
      }
      if (current.round > previous.round) {
        await this.#manageBlockRoundAdvance(previous.round, current.round);
      }
      if (logicalTurnChanged && current.round > 0 && currentBlock) {
        await this.#onStartBlockTurn(currentBlock, createBlockTurnEventContext(current, currentBlock));
      }
    }

    Hooks.callAll("combatTurnChange", this, previous, current);
  }

  async #manageBlockRoundAdvance(previousRound, currentRound) {
    let round = Math.max(0, Number(previousRound) || 0);
    const destination = Math.max(0, Number(currentRound) || 0);
    if (round === 0 && destination > 0) {
      await this.#onEndBlockRound({
        round,
        skipped: false
      });
      round = 1;
      await this.#onStartBlockRound({
        round,
        skipped: round !== destination
      });
    }
    while (round < destination) {
      await this.#onEndBlockRound({
        round,
        skipped: round !== previousRound
      });
      round += 1;
      await this.#onStartBlockRound({
        round,
        skipped: round !== destination
      });
    }
  }

  async #onEndBlockTurn(block, context) {
    const combatant = block.representative;
    if (!combatant) return;
    await this._onEndTurn(combatant, context);
    await ActiveEffect.registry.refresh("turnEnd", { ...context, combat: this });
    void triggerCombatRegionEvents(
      CONST.REGION_EVENTS.TOKEN_TURN_END,
      context,
      block.combatants,
      this
    );
  }

  async #onStartBlockTurn(block, context) {
    const combatant = block.representative;
    if (!combatant) return;
    await this._onStartTurn(combatant, context);
    await this._clearMovementHistoryOnStartTurn(combatant, context);
    await ActiveEffect.registry.refresh("turnStart", { ...context, combat: this });
    void triggerCombatRegionEvents(
      CONST.REGION_EVENTS.TOKEN_TURN_START,
      context,
      block.combatants,
      this
    );
  }

  async #onEndBlockRound(context) {
    await this._onEndRound(context);
    await ActiveEffect.registry.refresh("roundEnd", { ...context, combat: this });
    void triggerCombatRegionEvents(
      CONST.REGION_EVENTS.TOKEN_ROUND_END,
      context,
      this.combatants,
      this
    );
  }

  async #onStartBlockRound(context) {
    if (context.round <= 0) return;
    await this._onStartRound(context);
    await ActiveEffect.registry.refresh("roundStart", { ...context, combat: this });
    void triggerCombatRegionEvents(
      CONST.REGION_EVENTS.TOKEN_ROUND_START,
      context,
      this.combatants,
      this
    );
  }

  async _onEndTurn(combatant, context = {}) {
    await super._onEndTurn(combatant, context);
    if (context.skipped || isBlockTurnOrderEnabled(this) || !combatant?.actor) return;
    const conversionMode = this.#pendingTurnEndConversions.get(combatant.actor.uuid)
      ?? this.#getTurnEndConversionMode(combatant);
    await prepareActorTurnEnd(combatant.actor, {
      conversionMode,
      combat: this,
      turnContext: context
    });
  }

  async _onStartRound(context = {}) {
    await super._onStartRound(context);
    if (!context.skipped) {
      await callCombatRoundStartHandlers({ combat: this, ...context });
    }
    await waitForWorldTimeQueueIdle();
  }

  async _onStartTurn(combatant, context = {}) {
    await super._onStartTurn(combatant, context);
    await prepareCombatTurnStart(this, combatant, {
      ...context,
      lifecycleContextId: this.#activeLifecycleContextId
    });
  }

  _onUpdate(changed, options, userId) {
    super._onUpdate(changed, options, userId);
    if (isBlockTurnOrderEnabled(this) && isBlockTurnStateUpdate(changed)) this._updateTurnMarkers();
  }

  #captureCombatantOperationLifecycle(options, operation) {
    const operationId = String(options?.[COMBATANT_LIFECYCLE_OPERATION_OPTION] ?? "");
    const baseline = this.#turnLifecycleGeneration;
    const result = operation();
    if (operationId) {
      const lifecycle = this.waitForFalloutMawTurnLifecycleAfter(baseline, {
        rejectOnError: true
      });
      this.#combatantOperationLifecycles.set(operationId, lifecycle);
      void lifecycle.catch(() => undefined);
    }
    return result;
  }

  _onCreateDescendantDocuments(parent, collection, documents, data, options, userId) {
    if (collection !== "combatants") {
      return super._onCreateDescendantDocuments(
        parent,
        collection,
        documents,
        data,
        options,
        userId
      );
    }
    return this.#captureCombatantOperationLifecycle(options, () => {
      let combatStartRefresh = Promise.resolve();
      const result = captureActiveEffectRegistryRefresh(
        ActiveEffect.registry,
        {
          event: "combatStart",
          matchesContext: context => context?.combat === this
        },
        () => super._onCreateDescendantDocuments(
          parent,
          collection,
          documents,
          data,
          options,
          userId
        ),
        promise => {
          combatStartRefresh = promise;
        }
      );
      trackCombatantCreateActiveEffectRefresh(documents, combatStartRefresh);
      return result;
    });
  }

  _onUpdateDescendantDocuments(parent, collection, documents, changes, options, userId) {
    if (collection !== "combatants") {
      return super._onUpdateDescendantDocuments(
        parent,
        collection,
        documents,
        changes,
        options,
        userId
      );
    }
    return this.#captureCombatantOperationLifecycle(options, () => (
      super._onUpdateDescendantDocuments(
        parent,
        collection,
        documents,
        changes,
        options,
        userId
      )
    ));
  }

  _onDeleteDescendantDocuments(parent, collection, documents, ids, options, userId) {
    if (collection !== "combatants") {
      return super._onDeleteDescendantDocuments(
        parent,
        collection,
        documents,
        ids,
        options,
        userId
      );
    }
    return this.#captureCombatantOperationLifecycle(options, () => (
      super._onDeleteDescendantDocuments(
        parent,
        collection,
        documents,
        ids,
        options,
        userId
      )
    ));
  }

  _onDelete(options, userId) {
    this.#combatEndRefreshPromise = Promise.resolve();
    return captureActiveEffectRegistryRefresh(
      ActiveEffect.registry,
      {
        event: "combatEnd",
        matchesContext: context => context?.combat === this
      },
      () => super._onDelete(options, userId),
      promise => {
        this.#combatEndRefreshPromise = promise;
      }
    );
  }

  static async _onUpdateOperation(documents, operation, user) {
    try {
      await super._onUpdateOperation(documents, operation, user);
      if (hasCombatLifecycleUpdate(operation.updates)) {
        for (const combat of documents) {
          await combat.waitForFalloutMawTurnLifecycle?.({ rejectOnError: true });
        }
      }
    } finally {
      const contextId = String(operation?.[COMBAT_LIFECYCLE_CONTEXT_OPTION] ?? "");
      if (
        contextId
        && operation?.[COMBAT_LIFECYCLE_SETTLEMENT_OPTION] === "combat-update"
      ) {
        for (const combat of documents) {
          settleCombatLifecycleLease(contextId, {
            combatId: combat?.id,
            purpose: "combat-update",
            requesterUserId: user?.id
          });
        }
      }
    }
  }

  static async _preDeleteOperation(documents, operation, user) {
    if (operation.pack || operation.dryRun) {
      return super._preDeleteOperation(documents, operation, user);
    }
    if (!game.user?.isActiveGM) return false;
    for (const combat of documents) {
      combat.#deletionRequested = true;
      await combat.waitForFalloutMawTurnTransition();
      if (!game.user?.isActiveGM) return false;
    }
    return super._preDeleteOperation(documents, operation, user);
  }

  static async _onDeleteOperation(documents, operation, user) {
    await super._onDeleteOperation(documents, operation, user);
    if (!game.user?.isActiveGM || operation.pack) return;
    for (const combat of documents) {
      await combat.waitForFalloutMawTurnTransition?.();
      try {
        await combat.#combatEndRefreshPromise;
      } catch (error) {
        console.error(`${SYSTEM_ID} | Combat-end Active Effect refresh failed`, error);
      }
      let cleanupResult = null;
      try {
        cleanupResult = await cleanupDeletedCombatResources(combat);
      } catch (error) {
        cleanupResult = {
          cleanedActorUuids: [],
          skippedActorUuids: [],
          errors: [{ actorUuid: "", stage: "lifecycle", error }]
        };
        console.error(`${SYSTEM_ID} | Combat deletion cleanup failed`, error);
      }
      Hooks.callAll(COMBAT_DELETION_SETTLED_HOOK, combat, cleanupResult, operation, user);
    }
  }

  _updateTurnMarkers() {
    if (!isBlockTurnOrderEnabled(this)) return super._updateTurnMarkers();
    if (!canvas.ready) return;
    const activeTokens = new Set(getActiveBlockTokenObjects(this));
    for (const token of canvas.tokens.turnMarkers) {
      if (!activeTokens.has(token)) token.renderFlags.set({ refreshTurnMarker: true });
    }
    if (this.isView) {
      for (const token of activeTokens) {
        if (!token.turnMarker || !canvas.tokens.turnMarkers.has(token)) {
          token.renderFlags.set({ refreshTurnMarker: true });
        }
      }
    }
  }

  async #rollInitiativeWithSurprise(ids, { formula = null, updateTurn = true, messageMode, messageOptions = {} } = {}, surprisedIds = new Set()) {
    ids = typeof ids === "string" ? [ids] : ids;
    if ("rollMode" in messageOptions) {
      foundry.utils.logCompatibilityWarning("The rollMode option of Combat#rollInitiative messageOptions is"
        + " deprecated in favor of the `messageMode` option, a string key of CONFIG.ChatMessage.modes",
      { since: 14, until: 16 });
      messageMode = foundry.dice.Roll._mapLegacyRollMode(messageOptions.rollMode);
      delete messageOptions.rollMode;
    }

    const updates = [];
    const messages = [];
    const initiativeBatchId = foundry.utils.randomID();
    for (const [i, id] of ids.entries()) {
      const combatant = this.combatants.get(id);
      if (!combatant?.isOwner) continue;

      const surprised = surprisedIds.has(id);
      const initiativeFormula = formula || combatant._getInitiativeFormula?.()
        || CONFIG.Combat.initiative.formula
        || game.system.initiative
        || "1d20";
      const requestedFormula = String(initiativeFormula);
      const participant = createInitiativeParticipant(combatant);
      const eventData = {
        combatUuid: String(this.uuid ?? ""),
        combatantUuid: String(combatant.uuid ?? ""),
        combatantId: String(combatant.id ?? id ?? ""),
        actorUuid: String(combatant.actor?.uuid ?? ""),
        tokenUuid: String(combatant.token?.uuid ?? ""),
        requestedFormula,
        surprised
      };
      const operationId = `initiative-roll:${this.uuid}:${initiativeBatchId}:${i}:${id}`;
      eventData.chanceOperationId = operationId;
      const workflow = await withSystemEventRoot({
        kind: "initiativeRoll",
        operationId,
        sceneUuid: getInitiativeSceneUuid(combatant),
        combatUuid: String(this.uuid ?? "")
      }, scope => runTerminalSystemEventWorkflow({
        scope,
        beforeEventKey: "fallout-maw.initiative.roll.beforeRoll",
        resolvedEventKey: "fallout-maw.initiative.roll.resolved",
        occurrenceBase: `initiative:${scope.rootId}:${initiativeBatchId}:${i}:${id}`,
        participants: {
          source: participant,
          target: null,
          related: []
        },
        beforeData: eventData,
        resolvedData: ({ value, status }) => ({
          ...eventData,
          status: String(status ?? ""),
          evaluated: Boolean(value?.roll),
          formula: String(value?.formula ?? ""),
          total: Number.isFinite(Number(value?.roll?.total)) ? Number(value.roll.total) : null
        }),
        operation: async () => {
          const rollFormula = buildInitiativeFormula(initiativeFormula, combatant.actor, {
            surprised,
            chanceOperationId: operationId,
            actorToken: combatant.token?.object ?? combatant.token ?? null
          });
          const roll = combatant.getInitiativeRoll(rollFormula);
          await roll.evaluate();
          return { roll, formula: rollFormula };
        }
      }));
      if (!workflow.success || !workflow.value?.roll) continue;

      const { roll } = workflow.value;
      updates.push({ _id: id, initiative: roll.total });

      const messageData = foundry.utils.mergeObject({
        speaker: foundry.documents.ChatMessage.implementation.getSpeaker({
          actor: combatant.actor,
          token: combatant.token,
          alias: combatant.name
        }),
        flavor: game.i18n.format("COMBAT.RollsInitiative", { name: foundry.utils.escapeHTML(combatant.name) }),
        flags: { "core.initiativeRoll": true }
      }, messageOptions);
      const chatData = await roll.toMessage(messageData, {
        messageMode: messageMode ?? (combatant.hidden ? "gm" : undefined),
        create: false
      });
      if (i > 0) chatData.sound = null;
      messages.push(chatData);
    }
    if (!updates.length) return this;

    const updateOptions = { turnEvents: false };
    if (!updateTurn) updateOptions.combatTurn = this.turn;
    await this.updateEmbeddedDocuments("Combatant", updates, updateOptions);
    await foundry.documents.ChatMessage.implementation.create(messages);
    return this;
  }
}

function createInitiativeParticipant(combatant) {
  const participant = {
    actorUuid: String(combatant?.actor?.uuid ?? ""),
    tokenUuid: String(combatant?.token?.uuid ?? ""),
    itemUuid: ""
  };
  return Object.values(participant).some(Boolean) ? participant : null;
}

function getInitiativeSceneUuid(combatant) {
  return String(
    combatant?.token?.parent?.uuid
    ?? combatant?.scene?.uuid
    ?? globalThis.canvas?.scene?.uuid
    ?? ""
  );
}

function isBlockTurnStateUpdate(changed = {}) {
  return foundry.utils.getProperty(changed, `flags.${SYSTEM_ID}.${BLOCK_TURN_STATE_FLAG}`) !== undefined
    || changed.flags?.[SYSTEM_ID]?.[BLOCK_TURN_STATE_FLAG] !== undefined;
}

function createBlockTurnTransitionSnapshot(combat, previous = {}, current = {}) {
  const blocks = getCombatTurnBlocks(combat);
  const previousBlock = snapshotTurnBlock(resolveTurnBlock(blocks, previous), previous);
  const currentBlock = snapshotTurnBlock(resolveTurnBlock(blocks, current), current);
  const previousRound = Math.max(0, Number(previous.round) || 0);
  const currentRound = Math.max(0, Number(current.round) || 0);
  const previousKey = previousBlock ? `${previousRound}:${previousBlock.signature}` : "";
  const currentKey = currentBlock ? `${currentRound}:${currentBlock.signature}` : "";
  return {
    previous: { ...previous },
    current: { ...current },
    previousBlock,
    currentBlock,
    logicalTurnChanged: previousKey !== currentKey
  };
}

function resolveTurnBlock(blocks = [], state = {}) {
  const combatantId = String(state?.combatantId ?? "");
  if (combatantId) {
    const byCombatant = blocks.find(block => (
      block.combatants.some(combatant => combatant?.id === combatantId)
    ));
    return byCombatant ?? null;
  }
  const turn = Number(state?.turn);
  if (!Number.isInteger(turn)) return null;
  return blocks.find(block => block.start <= turn && turn <= block.end) ?? null;
}

function snapshotTurnBlock(block, state = {}) {
  if (!block) return null;
  const combatants = Array.from(block.combatants ?? []);
  const representative = combatants.find(combatant => combatant?.id === state?.combatantId)
    ?? combatants[0]
    ?? null;
  return {
    signature: String(block.signature ?? ""),
    start: Number(block.start) || 0,
    end: Number(block.end) || 0,
    combatants,
    representative
  };
}

function createBlockTurnEventContext(state = {}, block = null) {
  return {
    round: Math.max(0, Number(state.round) || 0),
    turn: Number.isInteger(state.turn) ? state.turn : null,
    skipped: false,
    falloutMawBlockCombatantIds: Array.from(
      block?.combatants ?? [],
      combatant => String(combatant?.id ?? "")
    ).filter(Boolean)
  };
}

async function triggerCombatRegionEvents(eventName, eventData, combatants, combat) {
  const promises = [];
  for (const combatant of combatants ?? []) {
    const token = combatant?.token;
    if (!token) continue;
    for (const region of token.regions ?? []) {
      promises.push(region._triggerEvent(eventName, {
        token,
        combatant,
        combat,
        ...eventData
      }));
    }
  }
  await Promise.allSettled(promises);
}

function isCombatTurnRewind(previous = {}, current = {}) {
  const previousRound = Number(previous.round) || 0;
  const currentRound = Number(current.round) || 0;
  if (currentRound !== previousRound) return currentRound < previousRound;
  const previousTurn = Number.isInteger(previous.turn) ? previous.turn : -1;
  const currentTurn = Number.isInteger(current.turn) ? current.turn : -1;
  return currentTurn < previousTurn;
}

function resolveCombatDeletionDocuments(ids = [], operation = {}) {
  if (operation.pack || operation.parent) return [];
  const requestedIds = operation.deleteAll
    ? Array.from(game.combats?.contents ?? [], combat => combat.id)
    : Array.from(ids ?? [], value => String(value ?? "")).filter(Boolean);
  return requestedIds
    .map(id => game.combats?.get?.(id))
    .filter(Boolean);
}

function resolveCombatLifecycleUpdateDocuments(updates = [], operation = {}) {
  if (operation.pack || operation.parent) return [];
  const ids = Array.from(updates ?? [], update => (
    String(update?._id ?? update?.id ?? "").trim()
  )).filter(Boolean);
  return Array.from(new Set(ids))
    .map(id => game.combats?.get?.(id))
    .filter(Boolean);
}

function hasCombatLifecycleUpdate(updates = []) {
  for (const update of updates ?? []) {
    for (const key of Object.keys(update ?? {})) {
      if (
        key === "round"
        || key === "turn"
        || key === "combatants"
        || key.startsWith("round.")
        || key.startsWith("turn.")
        || key.startsWith("combatants.")
        || key === "settings.skipDefeated"
      ) return true;
    }
    if (
      update?.settings
      && Object.prototype.hasOwnProperty.call(update.settings, "skipDefeated")
    ) return true;
  }
  return false;
}

function isUnsupportedCombatBatchPreflight(updates = [], operation = {}) {
  return Boolean(
    operation.dryRun
    && operation.action
    && operation.documentName === "Combat"
    && hasCombatLifecycleUpdate(updates)
  );
}

async function runRemoteCombatUpdate(combat, updates, operation, invoke) {
  await combat.waitForFalloutMawTurnTransition?.();
  const lease = await acquireCombatLifecycleLease(combat, {
    purpose: "combat-update"
  });
  if (!lease) throw new Error("No active GM is available to lock the combat lifecycle.");
  let expectsSettlement = false;
  try {
    if (game.users?.activeGM?.id !== lease.authorityUserId) {
      throw new Error("Combat authority changed before the document operation started.");
    }
    const result = await invoke({
      ...operation,
      [COMBAT_LIFECYCLE_CONTEXT_OPTION]: lease.leaseId,
      [COMBAT_LIFECYCLE_SETTLEMENT_OPTION]: "combat-update"
    });
    expectsSettlement = Array.isArray(result) && result.length > 0;
    return result;
  } finally {
    await lease.release({ expectsSettlement });
  }
}

function normalizeCombatantIdSet(value) {
  if (value instanceof Set) return new Set(Array.from(value, normalizeCombatantId).filter(Boolean));
  if (Array.isArray(value)) return new Set(value.map(normalizeCombatantId).filter(Boolean));
  const id = normalizeCombatantId(value);
  return id ? new Set([id]) : new Set();
}

function normalizeCombatantId(value) {
  return String(value ?? "").trim();
}

function buildInitiativeFormula(formula, actor, {
  surprised = false,
  chanceOperationId = "",
  actorToken = null
} = {}) {
  const source = String(formula || CONFIG.Combat.initiative.formula || game.system.initiative || "1d20");
  const baseBonus = toInteger(actor?.system?.attributes?.initiativeBonus);
  const baseAdvantage = getActorInitiativeEdgeCount(actor, INITIATIVE_ADVANTAGE_EFFECT_KEY);
  const baseDisadvantage = getActorInitiativeEdgeCount(actor, INITIATIVE_DISADVANTAGE_EFFECT_KEY);
  const contextual = getContextualAbilityChangeValues(actor, [{
    id: "bonus",
    key: "system.attributes.initiativeBonus",
    baseValue: baseBonus
  }, {
    id: "advantage",
    key: INITIATIVE_ADVANTAGE_EFFECT_KEY,
    baseValue: baseAdvantage
  }, {
    id: "disadvantage",
    key: INITIATIVE_DISADVANTAGE_EFFECT_KEY,
    baseValue: baseDisadvantage
  }], { chanceOperationId, actorToken, requester: "initiative" });
  const edge = calculateInitiativeEdgeFromCounts(contextual.advantage, contextual.disadvantage, { surprised });
  const edgeFormula = applyInitiativeRollMode(source, edge.rollMode);
  const modifier = edge.skillModifier + (toInteger(contextual.bonus) - baseBonus) + (surprised ? -10 : 0);
  return modifier ? `(${edgeFormula}) ${modifier >= 0 ? "+" : "-"} ${Math.abs(modifier)}` : edgeFormula;
}

function calculateInitiativeEdge(actor, { surprised = false } = {}) {
  const advantageCount = getActorInitiativeEdgeCount(actor, INITIATIVE_ADVANTAGE_EFFECT_KEY);
  const disadvantageCount = getActorInitiativeEdgeCount(actor, INITIATIVE_DISADVANTAGE_EFFECT_KEY);
  return calculateInitiativeEdgeFromCounts(advantageCount, disadvantageCount, { surprised });
}

function calculateInitiativeEdgeFromCounts(advantage, disadvantage, { surprised = false } = {}) {
  const advantageCount = Math.max(0, toInteger(advantage));
  const disadvantageCount = Math.max(0, toInteger(disadvantage)) + (surprised ? 1 : 0);
  const net = advantageCount - disadvantageCount;
  if (net > 0) return {
    rollMode: "advantage",
    skillModifier: Math.max(0, net - 1) * 4
  };
  if (net < 0) return {
    rollMode: "disadvantage",
    skillModifier: Math.max(0, Math.abs(net) - 1) * -4
  };
  return {
    rollMode: "normal",
    skillModifier: 0
  };
}

function getActorInitiativeEdgeCount(actor, effectKey = "") {
  let total = 0;
  for (const effect of actor?.allApplicableEffects?.() ?? actor?.effects ?? []) {
    if (effect?.disabled || effect?.active === false) continue;
    for (const change of effect?.system?.changes ?? []) {
      if (String(change?.key ?? "").trim() !== effectKey) continue;
      total += Math.max(0, toInteger(evaluateActorEffectChangeNumber(actor, { ...change, effect }, { fallback: 0 })));
    }
  }
  return total;
}

function applyInitiativeRollMode(formula = "", rollMode = "normal") {
  if (rollMode === "advantage") return String(formula).replace(/\b1d20\b/i, "2d20kh");
  if (rollMode === "disadvantage") return String(formula).replace(/\b1d20\b/i, "2d20kl");
  return String(formula);
}
