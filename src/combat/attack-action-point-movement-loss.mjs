import {
  commitPreparedActiveUseOperations,
  getActiveUseOperationId,
  prepareActiveUseOperation
} from "../abilities/active-use-runtime.mjs";
import { getSourceContextualAbilityChangeValues } from "../abilities/evaluation.mjs";
import { getCombatSettings } from "../settings/accessors.mjs";
import { ATTACK_ACTION_POINT_MOVEMENT_LOSS_MODES } from "../settings/combat.mjs";
import {
  ATTACK_ACTION_POINT_MOVEMENT_LOSS_DISABLED_EFFECT_KEY,
  ATTACK_ACTION_POINT_MOVEMENT_LOSS_PERCENT_BONUS_EFFECT_KEY
} from "../utils/active-effect-keys.mjs";
import { toInteger } from "../utils/numbers.mjs";
import {
  MOVEMENT_RESOURCE_KEY,
  runMovementResourceSpendingSerially
} from "./movement-resources.mjs";
import {
  beginCombatResourceSpending,
  notifyCombatResourcesSpent
} from "./resource-spending.mjs";

const DISABLED_EFFECT_THRESHOLD = 0;

export function calculateAttackActionPointMovementLoss({
  mode = ATTACK_ACTION_POINT_MOVEMENT_LOSS_MODES.percent,
  spentActionPoints = 0,
  percent = 100,
  currentMovementPoints = 0,
  disabledValue = 0
} = {}) {
  const actionPoints = Math.max(0, toInteger(spentActionPoints));
  const current = Math.max(0, toInteger(currentMovementPoints));
  const disabled = Number(disabledValue) > DISABLED_EFFECT_THRESHOLD;
  const normalizedPercent = Math.max(0, Number(percent) || 0);
  if (
    mode === ATTACK_ACTION_POINT_MOVEMENT_LOSS_MODES.disabled
    || disabled
    || actionPoints <= 0
    || current <= 0
  ) {
    return {
      mode,
      percent: normalizedPercent,
      disabled,
      requested: 0,
      amount: 0
    };
  }

  if (mode === ATTACK_ACTION_POINT_MOVEMENT_LOSS_MODES.fullLoss) {
    return {
      mode,
      percent: normalizedPercent,
      disabled: false,
      requested: current,
      amount: current
    };
  }

  const scaled = actionPoints * normalizedPercent / 100;
  const requested = scaled > 0
    ? Number.isFinite(scaled) ? Math.ceil(scaled) : current
    : 0;
  return {
    mode: ATTACK_ACTION_POINT_MOVEMENT_LOSS_MODES.percent,
    percent: normalizedPercent,
    disabled: false,
    requested,
    amount: Math.min(current, requested)
  };
}

/**
 * Remove MP after an attack has already committed its AP spend.
 *
 * This is deliberately a post-spend consequence: it clamps to the current MP
 * remainder and can never make an attack unaffordable.
 */
export async function applyAttackActionPointMovementLoss(actor, spentActionPoints = 0, context = {}) {
  const actionPoints = Math.max(0, toInteger(spentActionPoints));
  const configured = getCombatSettings().attackActionPointMovementLoss;
  const mode = String(configured?.mode ?? ATTACK_ACTION_POINT_MOVEMENT_LOSS_MODES.percent);
  if (
    !actor?.update
    || actionPoints <= 0
    || mode === ATTACK_ACTION_POINT_MOVEMENT_LOSS_MODES.disabled
  ) return createEmptyResult(mode);

  const finishSpending = beginCombatResourceSpending(actor);
  try {
    return await runMovementResourceSpendingSerially(actor, async () => {
      const movement = actor.system?.resources?.[MOVEMENT_RESOURCE_KEY];
      const current = Math.max(0, toInteger(movement?.value));
      if (!movement || current <= 0) return createEmptyResult(mode);

      const operationId = getActiveUseOperationId(
        context,
        `attack-movement-loss:${String(actor.uuid ?? actor.id ?? "")}:${randomID()}`
      );
      const conditionContext = {
        ...context,
        actor,
        actionPointCost: actionPoints,
        chanceOperationId: operationId,
        operationId,
        requester: String(context?.requester ?? "weaponAttack")
      };
      const keys = new Set([ATTACK_ACTION_POINT_MOVEMENT_LOSS_DISABLED_EFFECT_KEY]);
      const specs = [{
        id: "disabled",
        key: ATTACK_ACTION_POINT_MOVEMENT_LOSS_DISABLED_EFFECT_KEY,
        baseValue: Number(actor.system?.combat?.attackActionPointMovementLossDisabled) || 0
      }];
      if (mode === ATTACK_ACTION_POINT_MOVEMENT_LOSS_MODES.percent) {
        keys.add(ATTACK_ACTION_POINT_MOVEMENT_LOSS_PERCENT_BONUS_EFFECT_KEY);
        specs.push({
          id: "percent",
          key: ATTACK_ACTION_POINT_MOVEMENT_LOSS_PERCENT_BONUS_EFFECT_KEY,
          baseValue: Math.max(0, Number(configured?.percent) || 0)
            + (Number(actor.system?.combat?.attackActionPointMovementLossPercentBonus) || 0)
        });
      }

      const activeUsePreparation = prepareActiveUseOperation({
        kind: "attackActionPointMovementLoss",
        actor,
        keys,
        conditionContexts: [conditionContext],
        reverseOnly: false
      });
      const values = getSourceContextualAbilityChangeValues(actor, specs, conditionContext);
      const result = calculateAttackActionPointMovementLoss({
        mode,
        spentActionPoints: actionPoints,
        percent: mode === ATTACK_ACTION_POINT_MOVEMENT_LOSS_MODES.percent
          ? values.percent
          : configured?.percent,
        currentMovementPoints: current,
        disabledValue: values.disabled
      });

      let appliedAmount = 0;
      if (result.amount > 0) {
        const next = current - result.amount;
        await actor.update({
          [`system.resources.${MOVEMENT_RESOURCE_KEY}.value`]: next,
          [`system.resources.${MOVEMENT_RESOURCE_KEY}.spent`]: Math.max(
            0,
            toInteger(movement.max) - next
          )
        }, {
          falloutMawAttackActionPointMovementLoss: true,
          ...(context?.chainRef ? {
            chainRef: context.chainRef,
            falloutMawSystemEventChainRef: context.chainRef
          } : {})
        });
        const applied = Math.max(0, toInteger(actor.system?.resources?.[MOVEMENT_RESOURCE_KEY]?.value));
        appliedAmount = Math.min(result.amount, Math.max(0, current - applied));
      }

      const mechanicUsed = result.disabled || result.percent <= 0 || appliedAmount > 0;
      if (mechanicUsed && activeUsePreparation) {
        try {
          await commitPreparedActiveUseOperations([activeUsePreparation], { operationId });
        } catch (error) {
          console.error("Fallout MaW | Attack MP-loss active-use commit failed", error);
        }
      }
      if (appliedAmount > 0) {
        await notifyCombatResourcesSpent(actor, {
          [MOVEMENT_RESOURCE_KEY]: appliedAmount
        }, {
          ...context,
          source: "attackActionPointMovementLoss",
          attackActionPointMovementLoss: true,
          operationId
        });
      }
      return {
        ...result,
        amount: appliedAmount,
        actorUuid: String(actor.uuid ?? ""),
        operationId
      };
    });
  } catch (error) {
    // AP and weapon resources are already committed. Never turn a secondary
    // MP update failure into a retryable attack.
    console.error("Fallout MaW | Failed to apply attack AP-to-MP loss", error);
    return { ...createEmptyResult(mode), error };
  } finally {
    finishSpending();
  }
}

function createEmptyResult(mode = ATTACK_ACTION_POINT_MOVEMENT_LOSS_MODES.percent) {
  return {
    mode,
    percent: 0,
    disabled: false,
    requested: 0,
    amount: 0,
    actorUuid: "",
    operationId: ""
  };
}

function randomID() {
  return globalThis.foundry?.utils?.randomID?.()
    ?? `${Date.now()}-${Math.random()}`;
}
