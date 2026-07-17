import {
  ABILITY_ACTIVE_APPLICATION_SELECTION_MODES,
  ABILITY_ACTIVE_APPLICATION_TARGET_MODES,
  ABILITY_ACTION_EXECUTOR_MODES,
  ABILITY_ACTION_POINT_COST_MODES,
  ABILITY_ACTION_ROUTE_BUDGET_MODES,
  ABILITY_ACTION_ROUTE_EVALUATION_MODES,
  ABILITY_ACTION_TARGET_MODES,
  ABILITY_ACTION_TYPES,
  ABILITY_MOVEMENT_ROUTE_EXECUTION_MODES,
  ABILITY_ATTACK_ACTION_ALL,
  ABILITY_ATTACKING_WEAPON_ACTION_KEYS,
  ABILITY_FUNCTION_TYPES,
  normalizeAbilityAction,
  normalizeAbilityFunctions,
  normalizeActiveApplicationSettings
} from "../settings/abilities.mjs";
import {
  getAuraRelation,
  hasAuraLineOfSight,
  measureTokenDistanceMeters
} from "./aura-conditions.mjs";
import {
  getNativeMovementRouteOptions,
  requestAbilityMovementRoute,
  resolveNativeMovementPath,
  stopAbilityMovementRoutePreviews
} from "../canvas/ability-movement-route.mjs";
import {
  ABILITY_ROUTE_PREVIEW_MOVEMENT_OPTION,
  clearAbilityRoutePreviewStop,
  markAbilityRoutePreviewStop
} from "../canvas/ability-route-preview-state.mjs";
import { waitForSystemMovementSettlement } from "../canvas/movement-settlement.mjs";
import {
  getCombatMovementResourceState,
  measureTheoreticalMovementPathCost
} from "../combat/movement-resources.mjs";
import {
  canWeaponAttackReachToken,
  collectValidWeaponAttackTargets,
  executeWeaponAttackAgainstToken,
  getActionAttackCount,
  getMissingWeaponResourceCost,
  getWeaponActionPointCost,
  getWeaponAttackData,
  hasWeaponAction,
  isWeaponPlacementDisabled,
  startCommandedWeaponAttacksAndWait,
  startConstrainedAimedAttackSelection,
  startWeaponAttackAndWait
} from "../combat/weapon-attack-controller.mjs";
import { createForcedAttackModifier } from "../combat/weapon-attack-modifiers.mjs";
import {
  canSpendStrictActionPoints,
  getActorActiveCombat,
  getStrictActionPointState,
  isActorInActiveCombat,
  spendStrictActionPoints
} from "../combat/reaction-resources.mjs";
import { getReactionTimeoutMs, getResponsibleOwner, isActorUnableToAct } from "../combat/reaction-hub.mjs";
import { getWeaponActionBlockState } from "./runtime-state.mjs";
import {
  ITEM_FUNCTIONS,
  getEnabledWeaponFunctions,
  hasItemFunction
} from "../utils/item-functions.mjs";
import {
  getEventParticipantActorUuid,
  getEventParticipantTokenUuid
} from "../events/event-reaction-schema.mjs";
import { withSystemEventRoot } from "../events/dispatcher.mjs";
import { evaluateActorFormula } from "../utils/actor-formulas.mjs";
import { createActorOperationLock } from "../utils/actor-operation-lock.mjs";
import { waitForCombatResourceSpending } from "../combat/resource-spending.mjs";

const { DialogV2 } = foundry.applications.api;
const FormDataExtended = foundry.applications.ux.FormDataExtended;
const ATTACK_QUERY = "fallout-maw.abilityAction.attack";
const ATTACK_SELECTION_QUERY = "fallout-maw.abilityAction.select";
const MOVEMENT_QUERY = "fallout-maw.abilityAction.movement";
const movementRouteActorLock = createActorOperationLock();
const retainedMovementRoutePlans = new Map();

export function registerAbilityActionQueries() {
  if (!globalThis.CONFIG?.queries) return;
  CONFIG.queries[ATTACK_QUERY] = handleAbilityActionAttackQuery;
  CONFIG.queries[ATTACK_SELECTION_QUERY] = handleAbilityActionSelectionQuery;
  CONFIG.queries[MOVEMENT_QUERY] = handleAbilityActionMovementQuery;
}

export function collectAbilityWeaponAttackOptions(actor, actionSource = {}, {
  targetToken = null,
  requireReachableTarget = false
} = {}) {
  const action = normalizeAbilityAction(actionSource);
  if (action.type !== ABILITY_ACTION_TYPES.weaponAttack || isActorUnableToAct(actor)) return [];
  const allowedKeys = action.attackActionKeys.includes(ABILITY_ATTACK_ACTION_ALL)
    ? ABILITY_ATTACKING_WEAPON_ACTION_KEYS
    : action.attackActionKeys;
  const options = [];
  for (const weapon of actor?.items?.contents ?? actor?.items ?? []) {
    const placement = weapon?.system?.placement ?? {};
    if (weapon?.type !== "gear" || placement.mode !== "weapon" || !placement.weaponSet) continue;
    if (!hasItemFunction(weapon, ITEM_FUNCTIONS.weapon) || isWeaponPlacementDisabled(actor, weapon)) continue;
    for (const weaponFunction of getEnabledWeaponFunctions(weapon)) {
      const weaponFunctionId = String(weaponFunction?.id ?? ITEM_FUNCTIONS.weapon);
      if (!getWeaponAttackData(weapon, weaponFunctionId)?.enabled) continue;
      for (const actionKey of allowedKeys) {
        if (!hasWeaponAction(weapon, actionKey, weaponFunctionId)) continue;
        if (getWeaponActionBlockState(actor, actionKey).blocked) continue;
        const attackCount = getActionAttackCount(weapon, actionKey, weaponFunctionId);
        if (getMissingWeaponResourceCost(weapon, attackCount, weaponFunctionId)) continue;
        const actionPointCost = getConfiguredActionPointCost(actor, weapon, actionKey, weaponFunctionId, action);
        if (!canAffordConfiguredActionPointCost(actor, actionPointCost)) continue;
        options.push({
          actionId: action.id,
          action,
          actionKey,
          actionLabel: getWeaponActionLabel(actionKey),
          weapon,
          weaponUuid: String(weapon.uuid ?? ""),
          weaponFunctionId,
          weaponFunctionName: String(weaponFunction?.name ?? ""),
          actionPointCost,
          id: [action.id, actionKey, weapon.uuid, weaponFunctionId].join("|")
        });
      }
    }
  }
  if (!requireReachableTarget) return options;
  return options.filter(option => abilityWeaponAttackOptionCanReach(actor, option, targetToken));
}

export function abilityWeaponAttackOptionCanReach(actor, option = null, targetToken = null) {
  const attackerToken = getPrimaryActorToken(actor);
  const weapon = option?.weapon ?? null;
  if (!attackerToken?.actor || !weapon || !option?.actionKey) return false;
  return canWeaponAttackReachToken({
    attackerToken,
    weapon,
    actionKey: option.actionKey,
    weaponFunctionId: option.weaponFunctionId,
    targetToken
  });
}

export function getConfiguredActionPointCost(actor, weapon, actionKey, weaponFunctionId, actionSource = {}) {
  if (!isActorInActiveCombat(actor)) return 0;
  const action = normalizeAbilityAction(actionSource);
  if (action.actionPointCostMode === ABILITY_ACTION_POINT_COST_MODES.none) return 0;
  if (action.actionPointCostMode === ABILITY_ACTION_POINT_COST_MODES.fixed) {
    return Math.max(0, Math.trunc(Number(action.fixedActionPointCost) || 0));
  }
  const actual = getWeaponActionPointCost(actor, weapon, actionKey, weaponFunctionId);
  return Math.max(0, Math.ceil(actual * Math.max(0, Number(action.actualActionPointCostPercent) || 0) / 100));
}

export function buildAbilityActionPointCostLine(actor, amount = 0) {
  const cost = Math.max(0, Math.trunc(Number(amount) || 0));
  if (!cost) return "";
  return `${game.i18n.localize("FALLOUTMAW.Ability.Actions.ActionPoints")}: ${cost}`;
}

export async function resolveAbilityActionTriggerTarget(envelope = {}) {
  const tokenUuid = getEventParticipantTokenUuid(envelope?.source);
  const actorUuid = getEventParticipantActorUuid(envelope?.source);
  let resolved = null;
  let path = "none";
  if (tokenUuid) {
    const token = await globalThis.fromUuid?.(tokenUuid);
    const tokenObject = token?.object ?? token ?? null;
    if (tokenObject?.actor) {
      resolved = tokenObject;
      path = "sourceTokenUuid";
    }
  }
  if (!resolved && actorUuid) {
    const actor = await globalThis.fromUuid?.(actorUuid);
    resolved = canvas?.tokens?.placeables?.find(token => token?.actor?.uuid === actor?.uuid)
      ?? actor?.getActiveTokens?.()?.find(token => token?.scene?.id === canvas?.scene?.id)
      ?? null;
    path = resolved ? "sourceActorUuidFallback" : "actorUuidMiss";
  }
  return resolved;
}

export async function executeAbilityWeaponAttackOption({
  actor = null,
  attackerToken = null,
  option = null,
  targetToken = null,
  actionId = "",
  authorityContext = null,
  chainRef = null,
  damageHubOperationRef = "",
  ignoreReactionLock = false,
  preventCancel = false,
  autoApply = false
} = {}) {
  const freshOption = findFreshOption(actor, option);
  const freeTarget = freshOption?.action?.targetMode === ABILITY_ACTION_TARGET_MODES.free;
  const useAutoApply = Boolean(autoApply);
  if (!freshOption || (!freeTarget && !targetToken?.actor)) return false;
  if (freeTarget && useAutoApply && !targetToken?.actor) return false;
  const resolvedAttackerToken = attackerToken?.object ?? attackerToken ?? getPrimaryActorToken(actor);
  const attackerTokenDocument = resolvedAttackerToken?.document ?? resolvedAttackerToken ?? null;
  const targetTokenDocument = targetToken?.document ?? targetToken ?? null;
  const authoritySourceTokenDocument = authorityContext?.sourceTokenUuid
    ? await globalThis.fromUuid?.(String(authorityContext.sourceTokenUuid))
    : null;
  const owner = getAbilityActionSceneAuthority(actor, attackerTokenDocument, {
    preferredUser: game.user,
    requiredTokenDocuments: [
      authoritySourceTokenDocument,
      ...(freeTarget ? [] : [targetTokenDocument])
    ]
  });
  const normalizedActionId = String(actionId ?? freshOption?.action?.id ?? "").trim();
  if (
    !owner
    || !authorityContext
    || !authoritySourceTokenDocument?.actor
    || !normalizedActionId
    || normalizedActionId !== String(freshOption?.action?.id ?? "")
    || resolvedAttackerToken?.actor?.uuid !== actor?.uuid
  ) return false;
  const timeoutMs = getReactionTimeoutMs();
  const queryTimeoutMs = (timeoutMs * 2) + 2000;
  const data = {
    executionId: foundry.utils.randomID(),
    actorUuid: String(actor.uuid ?? ""),
    attackerTokenUuid: String(resolvedAttackerToken.document?.uuid ?? resolvedAttackerToken.uuid ?? ""),
    targetTokenUuid: (freeTarget && !useAutoApply)
      ? ""
      : String(targetToken?.document?.uuid ?? targetToken?.uuid ?? ""),
    weaponUuid: freshOption.weaponUuid,
    weaponFunctionId: freshOption.weaponFunctionId,
    actionKey: freshOption.actionKey,
    targetMode: freshOption.action.targetMode,
    actionPointCost: freshOption.actionPointCost,
    actionId: normalizedActionId,
    authorityContext,
    chainRef,
    damageHubOperationRef: String(damageHubOperationRef ?? ""),
    ignoreReactionLock,
    preventCancel: Boolean(preventCancel),
    autoApply: useAutoApply,
    timeoutMs
  };
  try {
    return Boolean(owner.isSelf || owner.id === game.user?.id
      ? await handleAbilityActionAttackQuery(data, { user: game.user })
      : await owner.query(ATTACK_QUERY, data, { timeout: queryTimeoutMs }));
  } catch (error) {
    console.warn("fallout-maw | Ability action execution query failed", error);
    return false;
  }
}

export async function executeAbilityFunctionActions({
  actor = null,
  abilityItem = null,
  abilityFunction = {},
  triggerTargets = [],
  title = "",
  sourceToken = null,
  chainRef = null,
  ignoreReactionLock = false
} = {}) {
  const prepared = await prepareAbilityFunctionActions({
    actor,
    abilityItem,
    abilityFunction,
    triggerTargets,
    title,
    sourceToken
  });
  if (prepared.cancelled || prepared.failed) {
    return {
      attempted: 0,
      executed: 0,
      cancelled: Boolean(prepared.cancelled),
      failed: Boolean(prepared.failed),
      reason: String(prepared.reason ?? "")
    };
  }
  return executePreparedAbilityFunctionActions({
    actor,
    abilityItem,
    abilityFunction,
    sourceToken,
    executions: prepared.executions,
    chainRef,
    ignoreReactionLock
  });
}

export async function prepareAbilityFunctionActions(options = {}) {
  const retainedMovementRoutePreviews = [];
  let result;
  try {
    result = await prepareAbilityFunctionActionsInternal(options, retainedMovementRoutePreviews);
  } catch (error) {
    await stopAbilityMovementRoutePreviews(retainedMovementRoutePreviews);
    throw error;
  }
  const keepPreviews = Boolean(result) && !result.cancelled && !result.failed;
  // Successful preparation transfers ownership of retained native plans to the
  // returned executions so prior routes stay visible until execute/cancel.
  if (!keepPreviews) await stopAbilityMovementRoutePreviews(retainedMovementRoutePreviews);
  return result;
}

async function prepareAbilityFunctionActionsInternal({
  actor = null,
  abilityItem = null,
  abilityFunction = {},
  triggerTargets = [],
  title = "",
  sourceToken = null,
  resourceReservations = new Map()
} = {}, retainedMovementRoutePreviews = []) {
  const executions = [];
  const normalizedTargets = uniqueAbilityActionTargets(triggerTargets);
  const resolvedSourceToken = sourceToken?.object ?? sourceToken ?? getPrimaryActorToken(actor);
  const actionContexts = [];
  for (const actionSource of abilityFunction?.actions ?? []) {
    const action = normalizeAbilityAction(actionSource);
    const executorTargets = action.executorMode === ABILITY_ACTION_EXECUTOR_MODES.targets
      ? normalizedTargets
      : [{ actor, token: resolvedSourceToken }];
    if (!executorTargets.length || executorTargets.some(entry => !entry.actor || !entry.token?.actor)) {
      return { executions: [], cancelled: false, failed: true, reason: "executorUnavailable" };
    }
    actionContexts.push({ action, executorTargets });
  }

  // Foundry v14 stores exactly one native planned movement per TokenDocument.
  // Reject duplicate route actions before opening the first interactive draft
  // instead of letting the second action fail after the user did work.
  const routedTokenUuids = new Set();
  for (const { action, executorTargets } of actionContexts) {
    if (action.type !== ABILITY_ACTION_TYPES.movementRoute) continue;
    for (const executor of executorTargets) {
      const tokenDocument = executor.token?.document ?? executor.token ?? null;
      const tokenUuid = String(tokenDocument?.uuid ?? "").trim();
      if (!tokenUuid || routedTokenUuids.has(tokenUuid)) {
        ui?.notifications?.warn?.(
          `${title || "Способность"}: одному исполнителю нельзя назначить два отдельных нативных маршрута; объедините их в один маршрут.`
        );
        return { executions: [], cancelled: false, failed: true, reason: "duplicateMovementRouteExecutor" };
      }
      routedTokenUuids.add(tokenUuid);
    }
  }

  const preparedMovementRouteCosts = new Map();

  for (const { action, executorTargets } of actionContexts) {
    if (action.type === ABILITY_ACTION_TYPES.movementRoute) {
      const movementAuthorityContext = buildAbilityActionAuthorityContext({
        actor,
        abilityItem,
        abilityFunction,
        sourceToken: resolvedSourceToken,
        executions: executorTargets.map(executor => ({
          batchId: action.id,
          token: executor.token
        }))
      });
      if (!movementAuthorityContext) {
        return { executions: [], cancelled: false, failed: true, reason: "movementAuthorityUnavailable" };
      }
      for (const executor of executorTargets) {
        const executorTokenDocument = executor.token?.document ?? executor.token ?? null;
        if (isActorUnableToAct(executor.actor)) {
          ui?.notifications?.warn?.(`${buildAbilityActionExecutorTitle(title, executor.actor, action.executorMode)}: актёр не может действовать.`);
          return { executions: [], cancelled: false, failed: true, reason: "executorUnableToAct" };
        }
        if (!getMovementRouteAuthority(executor.actor, executorTokenDocument)) {
          ui?.notifications?.warn?.(`${buildAbilityActionExecutorTitle(title, executor.actor, action.executorMode)}: нет владельца или ведущего на сцене для полноценного перемещения.`);
          return { executions: [], cancelled: false, failed: true, reason: "movementAuthorityUnavailable" };
        }
        const formulaActor = action.routeBudgetEvaluation === ABILITY_ACTION_ROUTE_EVALUATION_MODES.source
          ? actor
          : executor.actor;
        const configuredMaxBudget = evaluateRouteBudget(action, formulaActor);
        if (!(configuredMaxBudget > 0)) {
          ui?.notifications?.warn?.(`${buildAbilityActionExecutorTitle(title, executor.actor, action.executorMode)}: бюджет маршрута должен быть больше нуля.`);
          return { executions: [], cancelled: false, failed: true, reason: "invalidRouteBudget" };
        }
        const actorUuid = String(executor.actor?.uuid ?? "").trim();
        const tokenUuid = String(executorTokenDocument?.uuid ?? "").trim();
        const alreadyPreparedCost = Math.max(0, Number(preparedMovementRouteCosts.get(actorUuid)) || 0);
        const alreadyPreparedAttackCost = getPreparedWeaponActionPointCost(executions, actorUuid);
        const resourceState = isActorInActiveCombat(executor.actor)
          ? getCombatMovementResourceState(executor.actor)
          : null;
        const availableMovementCost = resourceState
          ? Math.max(0, getMovementRouteResourceAvailability(
            executor.actor,
            resourceState,
            resourceReservations
          ) - alreadyPreparedCost - alreadyPreparedAttackCost)
          : Infinity;
        if (resourceState && availableMovementCost <= 0) {
          ui?.notifications?.warn?.(
            `${executor.actor?.name ?? "Актёр"}: нет доступных ОП/${resourceState.action?.label ?? "ОД"} для маршрута.`
          );
          return { executions: [], cancelled: false, failed: true, reason: "movementResourcesUnavailable" };
        }
        const maxBudget = action.routeBudgetMode === ABILITY_ACTION_ROUTE_BUDGET_MODES.movementCost
          ? Math.min(configuredMaxBudget, availableMovementCost)
          : configuredMaxBudget;
        const planAuthority = createAbilityMovementRoutePlanAuthority({
          actor: executor.actor,
          tokenDocument: executorTokenDocument,
          action,
          authorityContext: movementAuthorityContext,
          configuredMaxBudget,
          effectiveMaxBudget: maxBudget
        });
        const plannedHistory = Array.from(
          executorTokenDocument?.movementHistory ?? [],
          waypoint => ({ ...waypoint })
        );
        const route = await requestAbilityMovementRoute({
          token: executor.token,
          origin: null,
          history: plannedHistory,
          maxBudget,
          resourceBudget: availableMovementCost,
          budgetMode: action.routeBudgetMode,
          title: buildAbilityActionExecutorTitle(title, executor.actor, action.executorMode),
          movementAction: action.routeMovementAction,
          autoRotate: action.routeAutoRotate,
          showRuler: action.routeShowRuler,
          planAuthority,
          sessionContext: { actionId: action.id, executorActorUuid: executor.actor.uuid }
        });
        if (route?.cancelled) {
          return { executions: [], cancelled: true, failed: false, reason: "routeSelectionCancelled" };
        }
        if (!route || route.failed) {
          return { executions: [], cancelled: false, failed: true, reason: String(route?.reason ?? "routePreparationFailed") };
        }
        route.releasePlan ??= () => planAuthority.release(route);
        retainedMovementRoutePreviews.push(route);
        route.configuredMaxBudget = configuredMaxBudget;
        if (!preflightSingleMovementRouteResources(
          executor.actor,
          executor.token,
          route,
          preparedMovementRouteCosts,
          resourceReservations
        )) {
          return { executions: [], cancelled: false, failed: true, reason: "movementResourcesUnavailable" };
        }
        executions.push({
          kind: "movementRoute",
          actor: executor.actor,
          token: executor.token,
          route,
          action,
          routeExecutionMode: action.routeExecutionMode,
          batchId: action.id,
          title
        });
      }
      continue;
    }

    if (action.type !== ABILITY_ACTION_TYPES.weaponAttack) {
      return { executions: [], cancelled: false, failed: true, reason: "unsupportedActionType" };
    }
    for (const executor of executorTargets) {
      const attackMultiplicity = action.executorMode === ABILITY_ACTION_EXECUTOR_MODES.targets
        || action.targetMode === ABILITY_ACTION_TARGET_MODES.free
        ? 1
        : normalizedTargets.length;
      const availableActionPoints = getPreparedActionPointAvailability(
        executor.actor,
        executions,
        preparedMovementRouteCosts,
        resourceReservations
      );
      const options = collectAbilityWeaponAttackOptions(executor.actor, action)
        .filter(option => (Math.max(0, Number(option.actionPointCost) || 0) * attackMultiplicity) <= availableActionPoints);
      if (!options.length) {
        return { executions: [], cancelled: false, failed: true, reason: "attackOptionsUnavailable" };
      }
      const option = await requestAbilityWeaponAttackOption(options, {
        title: buildAbilityActionExecutorTitle(title, executor.actor, action.executorMode)
      });
      if (!option) return { executions: [], cancelled: true, failed: false, reason: "actionSelectionCancelled" };
      const targets = action.targetMode === ABILITY_ACTION_TARGET_MODES.free
        ? [null]
        : action.executorMode === ABILITY_ACTION_EXECUTOR_MODES.targets
          ? [executor.token]
          : normalizedTargets.map(target => target.token);
      if (!targets.length) {
        return { executions: [], cancelled: false, failed: true, reason: "actionTargetsUnavailable" };
      }
      for (const targetToken of targets) {
        executions.push({
          actor: executor.actor,
          attackerToken: executor.token,
          option,
          targetToken,
          coordinated: action.executorMode === ABILITY_ACTION_EXECUTOR_MODES.targets
            && action.targetMode === ABILITY_ACTION_TARGET_MODES.free,
          batchId: action.id,
          title
        });
      }
    }
  }
  if (!preflightPreparedMovementRouteResources(executions, resourceReservations)) {
    return { executions: [], cancelled: false, failed: true, reason: "movementResourcesUnavailable" };
  }
  if (!preflightPreparedActionResources(executions, resourceReservations)) {
    return { executions: [], cancelled: false, failed: true, reason: "actionResourcesUnavailable" };
  }
  return { executions, cancelled: false, failed: false, reason: "" };
}

function evaluateRouteBudget(action = {}, actor = null) {
  const formula = String(action?.routeBudgetFormula ?? action?.routeDistanceFormula ?? "").trim();
  if (!formula || formula === "0") return Infinity;
  const value = evaluateActorFormula(formula, actor, {
    fallback: 0,
    minimum: 0,
    context: "ability movement route budget"
  });
  return value > 0 ? value : 0;
}

function preflightPreparedMovementRouteResources(executions = [], resourceReservations = new Map()) {
  const costs = new Map();
  for (const execution of executions ?? []) {
    if (execution?.kind !== "movementRoute") continue;
    const actor = execution?.actor ?? null;
    if (!isActorInActiveCombat(actor)) continue;
    const actorUuid = String(actor?.uuid ?? "").trim();
    if (!actorUuid) continue;
    let cost;
    try {
      cost = measureMovementRouteResourceCost(execution?.token, execution?.route);
    } catch (error) {
      console.warn("fallout-maw | Movement route resource preflight failed", error);
      return false;
    }
    const current = costs.get(actorUuid) ?? { actor, amount: 0 };
    current.amount += Math.max(0, Number(cost) || 0);
    costs.set(actorUuid, current);
  }
  for (const { actor, amount } of costs.values()) {
    const state = getCombatMovementResourceState(actor);
    const available = getMovementRouteResourceAvailability(actor, state, resourceReservations);
    if (!state || amount <= available) continue;
    ui?.notifications?.warn?.(
      `${actor?.name ?? "Актёр"}: не хватает ОП/${state.action?.label ?? "ОД"} для маршрута (${Math.ceil(amount)} > ${available}).`
    );
    return false;
  }
  return true;
}

function preflightSingleMovementRouteResources(
  actor,
  token,
  route = {},
  accumulatedCosts = null,
  resourceReservations = new Map()
) {
  if (!isActorInActiveCombat(actor)) return true;
  const state = getCombatMovementResourceState(actor);
  if (!state) return true;
  let cost;
  try {
    cost = measureMovementRouteResourceCost(token, route);
  } catch (error) {
    console.warn("fallout-maw | Movement route resource preflight failed", error);
    return false;
  }
  const actorUuid = String(actor?.uuid ?? "").trim();
  const previousCost = Number(accumulatedCosts?.get(actorUuid) ?? 0);
  const totalCost = previousCost + cost;
  if (accumulatedCosts && actorUuid) accumulatedCosts.set(actorUuid, totalCost);
  const available = getMovementRouteResourceAvailability(actor, state, resourceReservations);
  if (totalCost <= available) return true;
  ui?.notifications?.warn?.(
    `${actor?.name ?? "Актёр"}: не хватает ОП/${state.action?.label ?? "ОД"} для маршрутов (${Math.ceil(totalCost)} > ${available}).`
  );
  return false;
}

function getMovementRouteResourceAvailability(actor, state = null, resourceReservations = new Map()) {
  if (!state) return 0;
  const actorUuid = String(actor?.uuid ?? "").trim();
  const vector = resourceReservations instanceof Map
    ? resourceReservations.get(actorUuid)
    : resourceReservations?.[actorUuid];
  const movementReserved = getReservedResourceAmount(vector, "movementPoints");
  const actionReserved = getReservedResourceAmount(vector, state.action?.key);
  return Math.max(0, Number(state.movement?.value) - movementReserved)
    + Math.max(0, Number(state.action?.value) - actionReserved);
}

function getPreparedWeaponActionPointCost(executions = [], actorUuid = "") {
  const normalizedActorUuid = String(actorUuid ?? "").trim();
  if (!normalizedActorUuid) return 0;
  return Array.from(executions ?? []).reduce((total, execution) => {
    if (execution?.kind === "movementRoute") return total;
    if (String(execution?.actor?.uuid ?? "").trim() !== normalizedActorUuid) return total;
    return total + Math.max(0, Number(execution?.option?.actionPointCost) || 0);
  }, 0);
}

function getPreparedActionPointAvailability(
  actor,
  executions = [],
  preparedMovementRouteCosts = new Map(),
  resourceReservations = new Map()
) {
  if (!isActorInActiveCombat(actor)) return Infinity;
  const state = getCombatMovementResourceState(actor);
  if (!state) return 0;
  const actorUuid = String(actor?.uuid ?? "").trim();
  const vector = resourceReservations instanceof Map
    ? resourceReservations.get(actorUuid)
    : resourceReservations?.[actorUuid];
  const availableMovement = Math.max(
    0,
    Number(state.movement?.value) - getReservedResourceAmount(vector, "movementPoints")
  );
  const availableAction = Math.max(
    0,
    Number(state.action?.value) - getReservedResourceAmount(vector, state.action?.key)
  );
  const movementCost = Math.max(0, Number(preparedMovementRouteCosts?.get?.(actorUuid)) || 0);
  const movementPaidWithAction = Math.max(0, movementCost - availableMovement);
  const preparedAttackCost = getPreparedWeaponActionPointCost(executions, actorUuid);
  return Math.max(0, availableAction - movementPaidWithAction - preparedAttackCost);
}

function preflightPreparedActionResources(executions = [], resourceReservations = new Map()) {
  const costs = new Map();
  for (const execution of executions ?? []) {
    const actor = execution?.actor ?? null;
    if (!isActorInActiveCombat(actor)) continue;
    const actorUuid = String(actor?.uuid ?? "").trim();
    if (!actorUuid) continue;
    const current = costs.get(actorUuid) ?? { actor, movement: 0, action: 0 };
    if (execution?.kind === "movementRoute") {
      try {
        current.movement += Math.max(0, Number(measureMovementRouteResourceCost(
          execution?.token,
          execution?.route
        )) || 0);
      } catch (error) {
        console.warn("fallout-maw | Combined action resource preflight failed", error);
        return false;
      }
    } else {
      current.action += Math.max(0, Number(execution?.option?.actionPointCost) || 0);
    }
    costs.set(actorUuid, current);
  }

  for (const { actor, movement, action } of costs.values()) {
    const state = getCombatMovementResourceState(actor);
    if (!state) return false;
    const actorUuid = String(actor?.uuid ?? "").trim();
    const vector = resourceReservations instanceof Map
      ? resourceReservations.get(actorUuid)
      : resourceReservations?.[actorUuid];
    const availableMovement = Math.max(
      0,
      Number(state.movement?.value) - getReservedResourceAmount(vector, "movementPoints")
    );
    const availableAction = Math.max(
      0,
      Number(state.action?.value) - getReservedResourceAmount(vector, state.action?.key)
    );
    const movementPaidWithAction = Math.max(0, movement - availableMovement);
    const requiredAction = movementPaidWithAction + action;
    if (requiredAction <= availableAction) continue;
    ui?.notifications?.warn?.(
      `${actor?.name ?? "Актёр"}: не хватает общего остатка ОП/${state.action?.label ?? "ОД"} `
      + `для подготовленных действий (${Math.ceil(requiredAction)} > ${availableAction} ${state.action?.label ?? "ОД"}).`
    );
    return false;
  }
  return true;
}

function getReservedResourceAmount(vector, resourceKey) {
  if (!vector || !resourceKey) return 0;
  const value = vector instanceof Map ? vector.get(resourceKey) : vector[resourceKey];
  return Math.max(0, Math.trunc(Number(value) || 0));
}

function measureMovementRouteResourceCost(token, route = {}) {
  const resolvedCost = Number(route?.movementCost);
  if (Number.isFinite(resolvedCost) && resolvedCost >= 0) return resolvedCost;
  const tokenDocument = route?.tokenDocument ?? token?.document ?? token ?? null;
  const waypoints = getMovementRouteWaypointsWithOrigin(tokenDocument, route?.waypoints ?? []);
  return measureTheoreticalMovementPathCost(tokenDocument, waypoints);
}

function getMovementRouteWaypointsWithOrigin(tokenDocument, waypoints = []) {
  const normalized = Array.isArray(waypoints) ? waypoints.filter(Boolean) : [];
  const source = tokenDocument?._source ?? tokenDocument ?? null;
  if (!source || !normalized.length) return normalized;
  // Route planner results normally omit the origin. Always prepend it rather
  // than using a pixel tolerance: on a gridless scene a legitimate short move
  // can be within that tolerance and would otherwise be measured as zero.
  return [{
    x: Number(source.x) || 0,
    y: Number(source.y) || 0,
    elevation: source.elevation ?? 0,
    width: source.width,
    height: source.height,
    depth: source.depth,
    shape: source.shape,
    level: source.level,
    action: source.action ?? tokenDocument?.movementAction,
    snapped: false,
    explicit: false,
    checkpoint: true
  }, ...normalized];
}

export async function executePreparedAbilityFunctionActions({
  actor = null,
  abilityItem = null,
  abilityFunction = null,
  sourceToken = null,
  executions = [],
  chainRef = null,
  ignoreReactionLock = false,
  onBeforeFirstExecute = null
} = {}) {
  let attempted = 0;
  let executed = 0;
  let committed = false;
  const ordinaryAttackAuthority = new Map();
  const ordinaryAttackGroups = new Map();
  for (const execution of executions) {
    if (execution?.kind === "movementRoute" || execution?.coordinated) continue;
    const actionId = String(execution?.batchId ?? execution?.option?.action?.id ?? "").trim();
    if (!actionId) continue;
    const group = ordinaryAttackGroups.get(actionId) ?? [];
    group.push(execution);
    ordinaryAttackGroups.set(actionId, group);
  }
  for (const group of ordinaryAttackGroups.values()) {
    const authorityContext = buildAbilityActionAuthorityContext({
      actor,
      abilityItem,
      abilityFunction,
      sourceToken,
      executions: group
    });
    for (const execution of group) ordinaryAttackAuthority.set(execution, authorityContext);
  }
  const commit = async () => {
    if (committed) return true;
    if (typeof onBeforeFirstExecute === "function" && (await onBeforeFirstExecute()) === false) return false;
    committed = true;
    return true;
  };
  for (let index = 0; index < executions.length;) {
    const execution = executions[index];
    if (execution?.kind === "movementRoute") {
      const batch = [];
      while (index < executions.length) {
        const candidate = executions[index];
        if (candidate?.kind !== "movementRoute" || candidate.batchId !== execution.batchId) break;
        batch.push(candidate);
        index += 1;
      }
      attempted += batch.length;
      const authorityContext = buildAbilityActionAuthorityContext({
        actor,
        abilityItem,
        abilityFunction,
        sourceToken,
        executions: batch
      });
      if (!authorityContext) {
        return { attempted, executed, cancelled: false, committed, commitFailed: true };
      }
      if (!(await commit())) return { attempted, executed, cancelled: false, committed: false, commitFailed: true };
      const result = await executeMovementRouteBatch(batch, {
        chainRef,
        sourceActor: actor,
        authorityContext
      });
      executed += Math.min(batch.length, Math.max(0, Math.trunc(Number(result.executedCount) || 0)));
      if (result.cancelled) return { attempted, executed, cancelled: true, committed };
      continue;
    }
    if (execution?.coordinated) {
      const batch = [];
      while (index < executions.length) {
        const candidate = executions[index];
        if (!candidate?.coordinated) break;
        batch.push(candidate);
        index += 1;
      }
      attempted += batch.length;
      const result = await executeCoordinatedAbilityWeaponAttacks(batch, {
        title: execution.title,
        chainRef,
        onBeforeExecute: commit,
        authorityContext: buildAbilityActionAuthorityContext({
          actor,
          abilityItem,
          abilityFunction,
          sourceToken,
          executions: batch
        })
      });
      if (result.cancelled) return { attempted, executed, cancelled: true, committed };
      executed += Math.min(batch.length, Math.max(0, Math.trunc(Number(result.executedCount) || 0)));
      continue;
    }
    index += 1;
    attempted += 1;
    const authorityContext = ordinaryAttackAuthority.get(execution) ?? null;
    if (!authorityContext) {
      return { attempted, executed, cancelled: false, committed, commitFailed: true };
    }
    if (!(await commit())) return { attempted, executed, cancelled: false, committed: false, commitFailed: true };
    const executionActor = execution?.actor ?? actor;
    if (await executeAbilityWeaponAttackOption({
      actor: executionActor,
      ...execution,
      actionId: String(execution?.batchId ?? execution?.option?.action?.id ?? ""),
      authorityContext,
      chainRef,
      ignoreReactionLock
    })) executed += 1;
  }
  if (!executions.length && !(await commit())) {
    return { attempted: 0, executed: 0, cancelled: false, committed: false, commitFailed: true };
  }
  return { attempted, executed, cancelled: false, committed };
}

async function executeMovementRouteBatch(batch = [], {
  chainRef = null,
  sourceActor = null,
  authorityContext = null
} = {}) {
  if (!batch.length) return { executedCount: 0, failedCount: 0, cancelled: false };
  const executeOne = execution => executeAbilityMovementRouteExecution(execution, {
    chainRef,
    sourceActor,
    authorityContext
  });
  if (batch[0]?.routeExecutionMode === ABILITY_MOVEMENT_ROUTE_EXECUTION_MODES.parallel) {
    const results = await Promise.all(batch.map(executeOne));
    const executedCount = results.filter(Boolean).length;
    return { executedCount, failedCount: batch.length - executedCount, cancelled: false };
  }
  let executedCount = 0;
  for (const execution of batch) {
    if (await executeOne(execution)) executedCount += 1;
  }
  return { executedCount, failedCount: batch.length - executedCount, cancelled: false };
}

export function getAbilityTargetExecutorAvailability(actor = null, abilityFunction = {}, token = null) {
  const targetExecutorActions = (abilityFunction?.actions ?? [])
    .map(action => normalizeAbilityAction(action))
    .filter(action => action.executorMode === ABILITY_ACTION_EXECUTOR_MODES.targets);
  if (!targetExecutorActions.length) return { available: true, reason: "" };
  if (!actor || !token?.actor || token.actor.uuid !== actor.uuid) {
    return { available: false, reason: "нет токена исполнителя" };
  }
  if (isActorUnableToAct(actor)) return { available: false, reason: "актёр не может действовать" };
  for (const action of targetExecutorActions) {
    if (action.type === ABILITY_ACTION_TYPES.movementRoute) continue;
    if (!collectAbilityWeaponAttackOptions(actor, action).length) {
      return { available: false, reason: "нет доступного атакующего действия или ресурсов" };
    }
  }
  return { available: true, reason: "" };
}

async function executeCoordinatedAbilityWeaponAttacks(executions = [], {
  title = "",
  chainRef = null,
  onBeforeExecute = null,
  authorityContext = null
} = {}) {
  const attacks = [];
  for (const execution of executions) {
    const executionActor = execution?.actor ?? null;
    const attackerToken = execution?.attackerToken?.object ?? execution?.attackerToken ?? null;
    const freshOption = findFreshOption(executionActor, execution?.option);
    if (!executionActor || attackerToken?.actor?.uuid !== executionActor.uuid || !freshOption) {
      return { started: false, executed: false, cancelled: false };
    }
    attacks.push({
      token: attackerToken,
      weapon: freshOption.weapon,
      actionKey: freshOption.actionKey,
      weaponFunctionId: freshOption.weaponFunctionId,
      actionPointCost: freshOption.actionPointCost
    });
  }
  return startCommandedWeaponAttacksAndWait({
    attacks,
    label: String(title ?? "") || game.i18n.localize("FALLOUTMAW.Ability.Actions.Execute"),
    chainRef,
    onBeforeExecute: async () => {
      if (!preflightCoordinatedActionPointCosts(attacks)) return false;
      return typeof onBeforeExecute !== "function" || (await onBeforeExecute()) !== false;
    },
    authorityContext
  });
}

function preflightCoordinatedActionPointCosts(attacks = []) {
  const costsByActor = new Map();
  for (const attack of attacks ?? []) {
    const actor = attack?.token?.actor ?? null;
    const actorUuid = String(actor?.uuid ?? "").trim();
    if (!actorUuid) return false;
    const current = costsByActor.get(actorUuid) ?? { actor, amount: 0 };
    current.amount += Math.max(0, Math.trunc(Number(attack?.actionPointCost) || 0));
    costsByActor.set(actorUuid, current);
  }
  return Array.from(costsByActor.values())
    .every(({ actor, amount }) => canSpendStrictActionPoints(actor, amount, { label: "командная атака" }));
}

function buildAbilityActionAuthorityContext({
  actor = null,
  abilityItem = null,
  abilityFunction = null,
  sourceToken = null,
  executions = []
} = {}) {
  const sourceTokenPlaceable = sourceToken?.object ?? sourceToken ?? getPrimaryActorToken(actor);
  const sourceTokenUuid = String(sourceTokenPlaceable?.document?.uuid ?? sourceTokenPlaceable?.uuid ?? "");
  if (
    !actor?.uuid
    || !abilityItem?.id
    || abilityItem.parent?.uuid !== actor.uuid
    || !abilityFunction?.id
    || !sourceTokenUuid
    || sourceTokenPlaceable?.actor?.uuid !== actor.uuid
  ) return null;
  const executionPairs = executions.map(execution => {
    const executorToken = execution?.attackerToken?.object
      ?? execution?.attackerToken
      ?? execution?.token?.object
      ?? execution?.token
      ?? null;
    const attackTargetToken = execution?.targetToken?.object ?? execution?.targetToken ?? null;
    const executorTokenUuid = String(executorToken?.document?.uuid ?? executorToken?.uuid ?? "");
    return {
      actionId: String(execution?.batchId ?? ""),
      // targetTokenUuid is retained for the coordinated/movement validators,
      // where it has always meant the action executor rather than the weapon target.
      targetTokenUuid: executorTokenUuid,
      executorTokenUuid,
      attackTargetTokenUuid: String(attackTargetToken?.document?.uuid ?? attackTargetToken?.uuid ?? "")
    };
  });
  if (executionPairs.some(pair => !pair.actionId || !pair.targetTokenUuid)) return null;
  return {
    kind: "abilityAction",
    actorUuid: String(actor.uuid),
    sourceTokenUuid,
    abilityItemId: String(abilityItem.id),
    abilityFunctionId: String(abilityFunction.id),
    abilityFunctionSignature: JSON.stringify(abilityFunction),
    actionIds: executionPairs.map(pair => pair.actionId),
    targetTokenUuids: Array.from(new Set(executionPairs.map(pair => pair.targetTokenUuid))),
    executionPairs
  };
}

function uniqueAbilityActionTargets(targets = []) {
  const seen = new Set();
  const result = [];
  for (const target of targets ?? []) {
    const token = target?.token?.object ?? target?.token ?? target?.object ?? target ?? null;
    const actor = target?.actor ?? token?.actor ?? null;
    const actorUuid = String(actor?.uuid ?? "").trim();
    if (!actorUuid || !token?.actor || seen.has(actorUuid)) continue;
    seen.add(actorUuid);
    result.push({ actor, token });
  }
  return result;
}

function buildAbilityActionExecutorTitle(title = "", actor = null, executorMode = "") {
  if (executorMode !== ABILITY_ACTION_EXECUTOR_MODES.targets) return String(title ?? "");
  return [String(title ?? "").trim(), String(actor?.name ?? "").trim()].filter(Boolean).join(": ");
}

/** Select an owner/GM which both owns the executor and renders its scene/level. */
function getAbilityActionSceneAuthority(actor = null, tokenDocument = null, {
  preferredUser = null,
  requiredTokenDocuments = []
} = {}) {
  const sceneId = String(tokenDocument?.parent?.id ?? "").trim();
  if (!actor || !sceneId) return null;
  const requiredDocuments = [tokenDocument, ...Array.from(requiredTokenDocuments ?? [])].filter(Boolean);
  if (requiredDocuments.some(document => String(document?.parent?.id ?? "") !== sceneId)) return null;
  const users = Array.from(game.users?.contents ?? game.users ?? []);
  const eligible = users.filter(user => (
    user?.active
    && String(user.viewedScene ?? "") === sceneId
    && requiredDocuments.every(document => isTokenIncludedForUserLevel(document, user))
    && (user.isGM || actor.testUserPermission?.(user, "OWNER"))
  ));
  const preferred = eligible.find(user => user.id === preferredUser?.id) ?? null;
  if (preferred) return preferred;
  const playerOwner = eligible
    .filter(user => !user.isGM)
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    .at(0);
  if (playerOwner) return playerOwner;
  const activeGM = game.users?.activeGM ?? null;
  if (activeGM && eligible.some(user => user.id === activeGM.id)) return activeGM;
  return eligible
    .filter(user => user.isGM)
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    .at(0) ?? null;
}

/** Native route planning additionally relies on the rendered Token placeable. */
function getMovementRouteAuthority(actor = null, tokenDocument = null) {
  return getAbilityActionSceneAuthority(actor, tokenDocument);
}

function isTokenIncludedForUserLevel(tokenDocument, user) {
  if (typeof tokenDocument?.includedInLevel !== "function") return true;
  try {
    return Boolean(tokenDocument.includedInLevel(user?.viewedLevel ?? null));
  } catch (_error) {
    return false;
  }
}

function createAbilityMovementRoutePlanAuthority({
  actor = null,
  tokenDocument = null,
  action = {},
  authorityContext = null,
  configuredMaxBudget = Infinity,
  effectiveMaxBudget = Infinity
} = {}) {
  let retainedPlan = null;
  const buildData = (operation, route = {}) => ({
    operation,
    actorUuid: String(actor?.uuid ?? ""),
    tokenUuid: String(tokenDocument?.uuid ?? ""),
    nativePlanId: String(route?.nativePlanId ?? route?.nativePlan?.id ?? retainedPlan?.planId ?? ""),
    explicitWaypoints: serializeMovementWaypoints(route?.explicitWaypoints),
    plannedOrigin: serializeMovementPosition(
      route?.origin ?? route?.plannedOrigin ?? retainedPlan?.origin ?? getTokenDocumentPosition(tokenDocument)
    ),
    maxBudget: Number.isFinite(Number(configuredMaxBudget)) ? Number(configuredMaxBudget) : null,
    effectiveMaxBudget: Number.isFinite(Number(effectiveMaxBudget)) ? Number(effectiveMaxBudget) : null,
    routeBudgetMode: String(action?.routeBudgetMode ?? ""),
    routeMovementAction: getExpectedMovementRouteAction(action, tokenDocument),
    autoRotate: Boolean(action?.routeAutoRotate),
    showRuler: Boolean(action?.routeShowRuler),
    actionId: String(action?.id ?? ""),
    authorityContext
  });
  const query = async (operation, route = {}) => {
    let authority = retainedPlan?.authorityUserId
      ? game.users?.get?.(retainedPlan.authorityUserId)
      : null;
    authority ??= getMovementRouteAuthority(actor, tokenDocument);
    if (!authority?.active) {
      return false;
    }
    const data = buildData(operation, route);
    const timeout = Math.max(getReactionTimeoutMs() * 4, 30000);
    try {
      const result = authority.isSelf || authority.id === game.user?.id
        ? await handleAbilityActionMovementQuery(data, { user: game.user })
        : await authority.query(MOVEMENT_QUERY, data, { timeout });
      return result;
    } catch (error) {
      console.warn(`fallout-maw | Ability movement ${operation} query failed`, error);
      return false;
    }
  };
  return {
    async authorize(route = {}) {
      const result = await query("authorizePlan", route);
      return Boolean(result?.authorized);
    },
    async retain(route = {}) {
      const result = await query("retainPlan", route);
      if (!result?.retained || !result?.planId) return false;
      retainedPlan = {
        planId: String(result.planId),
        authorityUserId: String(result.authorityUserId ?? ""),
        origin: result.origin ?? route?.origin ?? null
      };
      const nativePlan = result.nativePlan ?? {
        id: String(result.planId),
        origin: result.origin,
        destination: result.destination,
        waypoints: result.waypoints ?? []
      };
      return {
        ...result,
        id: String(result.planId),
        nativePlanId: String(result.planId),
        nativePlan,
        plan: nativePlan
      };
    },
    async release(route = {}) {
      const planId = String(route?.nativePlanId ?? route?.nativePlan?.id ?? retainedPlan?.planId ?? "");
      if (!planId) return true;
      const result = await query("releasePlan", { ...route, nativePlanId: planId });
      if (result?.released) retainedPlan = null;
      return Boolean(result?.released);
    }
  };
}

export async function requestAbilityWeaponAttackOption(options = [], { title = "", autoApply = false } = {}) {
  if (!options.length) return null;
  if (autoApply || options.length === 1) return pickRandomAbilityAttackOption(options);
  const weaponGroups = groupAbilityAttackOptionsByWeapon(options);
  let selectedGroup = weaponGroups[0] ?? null;
  if (weaponGroups.length > 1) {
    const weaponRows = weaponGroups.map((group, index) => `
      <label class="fallout-maw-radio-card fallout-maw-weapon-choice-card">
        <input type="radio" name="weaponUuid" value="${escapeAttribute(group.weaponUuid)}" ${index === 0 ? "checked" : ""}>
        <img src="${escapeAttribute(group.img)}" alt="">
        <span><strong>${escapeHTML(group.name)}</strong></span>
      </label>
    `).join("");
    const weaponData = await DialogV2.input({
      window: { title: buildAbilityActionDialogTitle(title, "SelectWeapon") },
      content: `<div class="fallout-maw-disarm-choice-grid">${weaponRows}</div>`,
      ok: {
        label: game.i18n.localize("FALLOUTMAW.Ability.Actions.Next"),
        icon: "fa-solid fa-arrow-right",
        callback: (_event, button) => new FormDataExtended(button.form).object
      },
      buttons: [{ action: "cancel", label: game.i18n.localize("FALLOUTMAW.Common.Cancel") }],
      position: { width: 520 },
      rejectClose: false
    });
    selectedGroup = weaponGroups.find(group => group.weaponUuid === String(weaponData?.weaponUuid ?? "")) ?? null;
    if (!selectedGroup) return null;
  }
  if (!selectedGroup) return null;
  if (selectedGroup.options.length === 1) return selectedGroup.options[0];

  const actionRows = selectedGroup.options.map((option, index) => `
    <label class="fallout-maw-radio-card">
      <input type="radio" name="optionId" value="${escapeAttribute(option.id)}" ${index === 0 ? "checked" : ""}>
      <span><strong>${escapeHTML(option.actionLabel || getWeaponActionLabel(option.actionKey))}</strong>${formatActionOptionDetails(option)}</span>
    </label>
  `).join("");
  const actionData = await DialogV2.input({
    window: { title: buildAbilityActionDialogTitle(title, "SelectAction") },
    content: `<div class="fallout-maw-disarm-choice-grid"><p>${escapeHTML(game.i18n.localize("FALLOUTMAW.Ability.Actions.Weapon"))}: <strong>${escapeHTML(selectedGroup.name)}</strong></p>${actionRows}</div>`,
    ok: {
      label: game.i18n.localize("FALLOUTMAW.Ability.Actions.Execute"),
      icon: "fa-solid fa-crosshairs",
      callback: (_event, button) => new FormDataExtended(button.form).object
    },
    buttons: [{ action: "cancel", label: game.i18n.localize("FALLOUTMAW.Common.Cancel") }],
    position: { width: 520 },
    rejectClose: false
  });
  const optionId = String(actionData?.optionId ?? "");
  return selectedGroup.options.find(option => option.id === optionId) ?? null;
}

export async function selectAbilityWeaponAttackOption(actor, options = [], { title = "", autoApply = false } = {}) {
  if (!options.length) return null;
  if (autoApply || options.length === 1) return pickRandomAbilityAttackOption(options);
  const owner = getResponsibleOwner(actor) ?? game.users?.activeGM ?? null;
  if (!owner) return null;
  const timeoutMs = getReactionTimeoutMs();
  const query = {
    actorUuid: String(actor?.uuid ?? ""),
    title: String(title ?? ""),
    options: options.map(serializeAbilityAttackSelectionOption)
  };
  try {
    const response = owner.isSelf
      ? await handleAbilityActionSelectionQuery(query)
      : await owner.query(ATTACK_SELECTION_QUERY, query, { timeout: (timeoutMs * 2) + 2000 });
    const optionId = String(response?.optionId ?? "");
    return options.find(option => option.id === optionId) ?? null;
  } catch (error) {
    console.warn("fallout-maw | Ability attack selection query failed", error);
    return null;
  }
}

export async function pickRandomAbilityFreeAttackTarget(actor = null, option = null) {
  const freshOption = findFreshOption(actor, option) ?? option;
  const attackerToken = getPrimaryActorToken(actor);
  const weapon = freshOption?.weapon
    ?? (freshOption?.weaponUuid ? await globalThis.fromUuid?.(freshOption.weaponUuid) : null);
  if (!attackerToken?.actor || !weapon || !freshOption?.actionKey) return null;
  const targets = collectValidWeaponAttackTargets({
    attackerToken,
    weapon,
    actionKey: freshOption.actionKey,
    weaponFunctionId: freshOption.weaponFunctionId
  });
  return pickRandomAbilityAttackOption(targets);
}

function findFreshOption(actor, option) {
  if (!option?.action) return null;
  return collectAbilityWeaponAttackOptions(actor, option.action).find(candidate => (
    candidate.actionKey === option.actionKey
    && candidate.weaponUuid === option.weaponUuid
    && candidate.weaponFunctionId === option.weaponFunctionId
    && candidate.actionPointCost === option.actionPointCost
  )) ?? null;
}

function canAffordConfiguredActionPointCost(actor, amount) {
  if (!isActorInActiveCombat(actor) || amount <= 0) return true;
  const state = getStrictActionPointState(actor);
  return Boolean(state && amount <= state.current);
}

async function handleAbilityActionAttackQuery(data = {}, { user: sender = null } = {}) {
  const authority = await validateWeaponAttackAbilityAuthority(data, sender);
  if (!authority) return false;
  const executionId = String(data.executionId ?? "").trim() || foundry.utils.randomID();
  const actor = authority.actor;
  const combat = getActorActiveCombat(actor);
  return withSystemEventRoot({
    kind: "abilityActionAttack",
    operationId: `ability-action-attack:${executionId}`,
    sceneUuid: getSceneUuidFromTokenUuid(data.attackerTokenUuid),
    combatUuid: String(combat?.uuid ?? ""),
    chainRef: data.chainRef ?? null
  }, scope => executeAbilityActionAttackQuery(data, scope.chainRef, authority));
}

async function validateWeaponAttackAbilityAuthority(data = {}, sender = null) {
  const authorityContext = data?.authorityContext ?? {};
  if (String(authorityContext.kind ?? "") !== "abilityAction" || !sender?.active) return null;

  const [actor, attackerTokenDocument, targetTokenDocument, sourceActor, sourceTokenDocument] = await Promise.all([
    data.actorUuid ? globalThis.fromUuid?.(String(data.actorUuid)) : null,
    data.attackerTokenUuid ? globalThis.fromUuid?.(String(data.attackerTokenUuid)) : null,
    data.targetTokenUuid ? globalThis.fromUuid?.(String(data.targetTokenUuid)) : null,
    authorityContext.actorUuid ? globalThis.fromUuid?.(String(authorityContext.actorUuid)) : null,
    authorityContext.sourceTokenUuid ? globalThis.fromUuid?.(String(authorityContext.sourceTokenUuid)) : null
  ]);
  if (
    !actor
    || !actor.isOwner
    || !attackerTokenDocument?.isOwner
    || !attackerTokenDocument.rendered
    || !attackerTokenDocument.object?.actor
    || attackerTokenDocument.actor?.uuid !== actor.uuid
    || getAbilityActionSceneAuthority(actor, attackerTokenDocument, {
      preferredUser: sender,
      requiredTokenDocuments: [sourceTokenDocument, targetTokenDocument]
    })?.id !== game.user?.id
    || !sourceActor
    || !sourceTokenDocument?.actor
  ) return null;
  if (!sender.isGM && !sourceActor.testUserPermission?.(sender, "OWNER")) return null;
  if (sourceTokenDocument.actor.uuid !== sourceActor.uuid) return null;
  const sourceSceneId = String(sourceTokenDocument.parent?.id ?? "");
  if (
    !sourceSceneId
    || String(sender.viewedScene ?? "") !== sourceSceneId
    || String(attackerTokenDocument.parent?.id ?? "") !== sourceSceneId
  ) return null;

  const abilityItem = sourceActor.items?.get?.(String(authorityContext.abilityItemId ?? "")) ?? null;
  if (!abilityItem || abilityItem.type !== "ability") return null;
  const abilityFunction = normalizeAbilityFunctions(abilityItem.system?.functions ?? [])
    .find(entry => (
      entry.id === String(authorityContext.abilityFunctionId ?? "")
      && entry.type === ABILITY_FUNCTION_TYPES.activeApplication
    ));
  if (!abilityFunction) return null;
  if (
    !String(authorityContext.abilityFunctionSignature ?? "")
    || String(authorityContext.abilityFunctionSignature) !== JSON.stringify(abilityFunction)
  ) return null;

  const actionId = String(data.actionId ?? "").trim();
  const action = (abilityFunction.actions ?? [])
    .map(actionSource => normalizeAbilityAction(actionSource))
    .find(entry => entry.id === actionId);
  if (!actionId || !action || action.type !== ABILITY_ACTION_TYPES.weaponAttack) return null;
  if (String(data.targetMode ?? "") !== action.targetMode) return null;
  if (
    action.targetMode !== ABILITY_ACTION_TARGET_MODES.free
    && (!targetTokenDocument?.rendered || !targetTokenDocument.object?.actor)
  ) return null;

  const executionPairs = (Array.isArray(authorityContext.executionPairs)
    ? authorityContext.executionPairs
    : [])
    .map(pair => ({
      actionId: String(pair?.actionId ?? "").trim(),
      executorTokenUuid: String(pair?.executorTokenUuid ?? pair?.targetTokenUuid ?? "").trim(),
      attackTargetTokenUuid: String(pair?.attackTargetTokenUuid ?? "").trim()
    }));
  if (
    !executionPairs.length
    || executionPairs.some(pair => !pair.actionId || !pair.executorTokenUuid || pair.actionId !== actionId)
  ) return null;
  const pairKeys = executionPairs.map(pair => (
    `${pair.actionId}\u0000${pair.executorTokenUuid}\u0000${pair.attackTargetTokenUuid}`
  ));
  if (new Set(pairKeys).size !== pairKeys.length) return null;

  const contextActionIds = Array.isArray(authorityContext.actionIds)
    ? authorityContext.actionIds.map(value => String(value ?? "").trim())
    : [];
  const contextExecutorTokenUuids = Array.isArray(authorityContext.targetTokenUuids)
    ? authorityContext.targetTokenUuids.map(value => String(value ?? "").trim()).filter(Boolean)
    : [];
  const executorTokenUuids = Array.from(new Set(executionPairs.map(pair => pair.executorTokenUuid)));
  if (
    contextActionIds.length !== executionPairs.length
    || contextActionIds.some((value, index) => value !== executionPairs[index].actionId)
    || !sameStringSet(contextExecutorTokenUuids, executorTokenUuids)
  ) return null;

  const attackerTokenUuid = String(attackerTokenDocument.uuid ?? "");
  const attackTargetTokenUuid = String(targetTokenDocument?.uuid ?? "");
  const requestedPair = `${actionId}\u0000${attackerTokenUuid}\u0000${attackTargetTokenUuid}`;
  if (!pairKeys.includes(requestedPair)) return null;

  let activeTargetTokenUuids = [];
  if (action.executorMode === ABILITY_ACTION_EXECUTOR_MODES.source) {
    if (
      actor.uuid !== sourceActor.uuid
      || attackerTokenUuid !== String(sourceTokenDocument.uuid ?? "")
      || executionPairs.some(pair => pair.executorTokenUuid !== attackerTokenUuid)
    ) return null;
    if (action.targetMode === ABILITY_ACTION_TARGET_MODES.free) {
      // A free target does not exist until the authority client's native canvas
      // attack controller captures and revalidates its geometry.
      if (data.autoApply || attackTargetTokenUuid || executionPairs.some(pair => pair.attackTargetTokenUuid)) {
        return null;
      }
    } else {
      if (!targetTokenDocument?.actor || executionPairs.some(pair => !pair.attackTargetTokenUuid)) return null;
      activeTargetTokenUuids = executionPairs.map(pair => pair.attackTargetTokenUuid);
    }
  } else if (action.executorMode === ABILITY_ACTION_EXECUTOR_MODES.targets) {
    // targets+free is the coordinated-ray workflow and must never be smuggled
    // through this ordinary owner query.
    if (action.targetMode === ABILITY_ACTION_TARGET_MODES.free) return null;
    if (executionPairs.some(pair => pair.attackTargetTokenUuid !== pair.executorTokenUuid)) return null;
    activeTargetTokenUuids = executorTokenUuids;
  } else return null;

  if (activeTargetTokenUuids.length) {
    const activeTargetTokenDocuments = await Promise.all(
      activeTargetTokenUuids.map(uuid => globalThis.fromUuid?.(uuid))
    );
    if (!(await validateWeaponAttackApplicationTargets({
      abilityFunction,
      sourceActor,
      sourceTokenDocument,
      targetTokenDocuments: activeTargetTokenDocuments,
      sender
    }))) return null;
  }

  if (data.preventCancel || data.autoApply) return null;
  const actionKey = String(data.actionKey ?? "");
  const weaponFunctionId = String(data.weaponFunctionId ?? "");
  const actionPointCost = Math.max(0, Math.trunc(Number(data.actionPointCost) || 0));
  const option = collectAbilityWeaponAttackOptions(actor, action).find(candidate => (
    candidate.actionKey === actionKey
    && candidate.weaponUuid === String(data.weaponUuid ?? "")
    && candidate.weaponFunctionId === weaponFunctionId
    && candidate.actionPointCost === actionPointCost
  )) ?? null;
  if (!option) return null;

  return {
    actor,
    attackerTokenDocument,
    targetTokenDocument,
    weapon: option.weapon,
    action,
    option
  };
}

async function validateWeaponAttackApplicationTargets({
  abilityFunction = {},
  sourceActor = null,
  sourceTokenDocument = null,
  targetTokenDocuments = [],
  sender = null
} = {}) {
  if (!targetTokenDocuments.length || targetTokenDocuments.some(document => !document?.actor)) return false;
  const sourceSceneId = String(sourceTokenDocument?.parent?.id ?? "");
  if (targetTokenDocuments.some(document => String(document.parent?.id ?? "") !== sourceSceneId)) return false;

  const settings = normalizeActiveApplicationSettings(abilityFunction.activeSettings);
  if (settings.targetMode === ABILITY_ACTIVE_APPLICATION_TARGET_MODES.self) {
    return targetTokenDocuments.length === 1
      && targetTokenDocuments[0].uuid === sourceTokenDocument.uuid
      && targetTokenDocuments[0].actor.uuid === sourceActor.uuid;
  }
  if (settings.targetMode !== ABILITY_ACTIVE_APPLICATION_TARGET_MODES.others) return false;
  if (settings.targetSelectionMode === ABILITY_ACTIVE_APPLICATION_SELECTION_MODES.manual) {
    const targetLimit = Math.max(1, Math.floor(evaluateActorFormula(settings.targetLimit, sourceActor, {
      fallback: 1,
      minimum: 1,
      context: "weapon attack ability target limit"
    })));
    if (targetTokenDocuments.length > targetLimit) return false;
  }

  const targetGroups = new Set(settings.targetGroups ?? []);
  const seenActors = new Set();
  for (const targetTokenDocument of targetTokenDocuments) {
    const targetActor = targetTokenDocument.actor;
    if (!sender?.isGM && targetTokenDocument.hidden) return false;
    if (settings.excludeSelf && targetActor.uuid === sourceActor.uuid) return false;
    if (seenActors.has(targetActor.uuid)) return false;
    seenActors.add(targetActor.uuid);
    const relation = targetActor.uuid === sourceActor.uuid
      ? "ally"
      : getAuraRelation(sourceActor, targetActor);
    if (!targetGroups.has(relation)) return false;

    const radiusFormula = String(settings.radiusFormula ?? "").trim();
    if (radiusFormula) {
      const sourceToken = sourceTokenDocument.object ?? null;
      const targetToken = targetTokenDocument.object ?? null;
      if (!sourceToken || !targetToken) return false;
      const radius = Math.max(0, evaluateActorFormula(radiusFormula, sourceActor, {
        fallback: 0,
        minimum: 0,
        context: "weapon attack ability radius"
      }));
      if (measureTokenDistanceMeters(sourceToken, targetToken) > radius + 1e-6) return false;
    }
    if (
      settings.wallsBlock
      && (!sourceTokenDocument.object || !targetTokenDocument.object
        || !hasAuraLineOfSight(sourceTokenDocument.object, targetTokenDocument.object))
    ) return false;
  }
  return true;
}

async function executeAbilityMovementRouteExecution(execution = {}, {
  chainRef = null,
  authorityContext = null
} = {}) {
  const actor = execution?.actor ?? null;
  const token = execution?.token?.object ?? execution?.token ?? execution?.route?.tokenObject ?? null;
  const tokenDocument = execution?.route?.tokenDocument ?? token?.document ?? execution?.token?.document ?? null;
  if (!actor?.uuid || !tokenDocument?.uuid || !Array.isArray(execution?.route?.waypoints)) return false;
  const owner = getMovementRouteAuthority(actor, tokenDocument);
  if (!owner || !authorityContext) {
    notifyMovementRouteExecutionFailure(actor, "movementAuthorityUnavailable");
    return false;
  }
  const data = {
    executionId: foundry.utils.randomID(),
    actorUuid: String(actor.uuid),
    tokenUuid: String(tokenDocument.uuid),
    nativePlanId: String(execution?.route?.nativePlanId ?? execution?.route?.nativePlan?.id ?? ""),
    explicitWaypoints: serializeMovementWaypoints(execution.route.explicitWaypoints),
    plannedOrigin: serializeMovementPosition(execution.route.origin),
    maxBudget: Number.isFinite(Number(execution.route.configuredMaxBudget ?? execution.route.maxBudget))
      ? Number(execution.route.configuredMaxBudget ?? execution.route.maxBudget)
      : null,
    routeBudgetMode: String(execution.route.budgetMode ?? execution?.action?.routeBudgetMode ?? ""),
    routeMovementAction: String(execution?.route?.movementAction ?? execution?.action?.routeMovementAction ?? ""),
    autoRotate: Boolean(execution?.action?.routeAutoRotate),
    showRuler: Boolean(execution?.action?.routeShowRuler),
    actionId: String(execution?.batchId ?? execution?.action?.id ?? ""),
    authorityContext,
    chainRef
  };
  try {
    const isSelf = Boolean(owner.isSelf || owner.id === game.user?.id);
    const timeout = Math.max(getReactionTimeoutMs() * 16, 600000);
    data.timeoutMs = timeout - 2000;
    const result = isSelf
      ? await handleAbilityActionMovementQuery(data, { user: game.user })
      : await owner.query(MOVEMENT_QUERY, data, { timeout });
    const executed = typeof result === "object" ? Boolean(result.executed) : Boolean(result);
    if (!executed && result?.reason) notifyMovementRouteExecutionFailure(actor, result.reason);
    return executed;
  } catch (error) {
    console.warn("fallout-maw | Ability movement execution query failed", error);
    return false;
  }
}

async function validateMovementAbilityAuthority(data = {}, sender = null, {
  actor = null,
  tokenDocument = null
} = {}) {
  const authorityContext = data?.authorityContext ?? {};
  if (String(authorityContext.kind ?? "") !== "abilityAction" || !sender?.active) return false;

  const sourceActor = authorityContext.actorUuid
    ? await globalThis.fromUuid?.(String(authorityContext.actorUuid))
    : null;
  const sourceTokenDocument = authorityContext.sourceTokenUuid
    ? await globalThis.fromUuid?.(String(authorityContext.sourceTokenUuid))
    : null;
  if (!sourceActor || !sourceTokenDocument?.actor) return false;
  if (!sender.isGM && !sourceActor.testUserPermission?.(sender, "OWNER")) return false;
  if (sourceTokenDocument.actor.uuid !== sourceActor.uuid) return false;
  const sourceSceneId = String(sourceTokenDocument.parent?.id ?? "");
  if (!sourceSceneId || String(sender.viewedScene ?? "") !== sourceSceneId) return false;

  const abilityItem = sourceActor.items?.get?.(String(authorityContext.abilityItemId ?? "")) ?? null;
  if (!abilityItem || abilityItem.type !== "ability") return false;
  const abilityFunction = normalizeAbilityFunctions(abilityItem.system?.functions ?? [])
    .find(entry => (
      entry.id === String(authorityContext.abilityFunctionId ?? "")
      && entry.type === ABILITY_FUNCTION_TYPES.activeApplication
    ));
  if (!abilityFunction) return false;
  if (
    !String(authorityContext.abilityFunctionSignature ?? "")
    || String(authorityContext.abilityFunctionSignature) !== JSON.stringify(abilityFunction)
  ) return false;

  const actionId = String(data.actionId ?? "").trim();
  const action = (abilityFunction.actions ?? [])
    .map(actionSource => normalizeAbilityAction(actionSource))
    .find(entry => entry.id === actionId);
  if (!actionId || !action || action.type !== ABILITY_ACTION_TYPES.movementRoute) return false;

  const executionPairs = (Array.isArray(authorityContext.executionPairs)
    ? authorityContext.executionPairs
    : [])
    .map(pair => ({
      actionId: String(pair?.actionId ?? "").trim(),
      targetTokenUuid: String(pair?.targetTokenUuid ?? "").trim()
    }));
  if (
    !executionPairs.length
    || executionPairs.some(pair => !pair.actionId || !pair.targetTokenUuid || pair.actionId !== actionId)
  ) return false;
  const pairKeys = executionPairs.map(pair => `${pair.actionId}\u0000${pair.targetTokenUuid}`);
  if (new Set(pairKeys).size !== pairKeys.length) return false;
  const targetTokenUuids = executionPairs.map(pair => pair.targetTokenUuid);
  if (new Set(targetTokenUuids).size !== targetTokenUuids.length) return false;
  if (!pairKeys.includes(`${actionId}\u0000${String(tokenDocument?.uuid ?? "")}`)) return false;

  const contextActionIds = Array.isArray(authorityContext.actionIds)
    ? authorityContext.actionIds.map(value => String(value ?? "").trim())
    : [];
  const contextTargetTokenUuids = Array.isArray(authorityContext.targetTokenUuids)
    ? authorityContext.targetTokenUuids.map(value => String(value ?? "").trim()).filter(Boolean)
    : [];
  if (
    contextActionIds.length !== executionPairs.length
    || contextActionIds.some((value, index) => value !== executionPairs[index].actionId)
    || !sameStringSet(contextTargetTokenUuids, targetTokenUuids)
  ) return false;

  const targetTokenDocuments = await Promise.all(targetTokenUuids.map(uuid => globalThis.fromUuid?.(uuid)));
  if (targetTokenDocuments.some(document => !document?.actor)) return false;
  if (targetTokenDocuments.some(document => String(document.parent?.id ?? "") !== sourceSceneId)) return false;
  const currentTarget = targetTokenDocuments.find(document => document.uuid === tokenDocument?.uuid) ?? null;
  if (!currentTarget || currentTarget.actor.uuid !== actor?.uuid) return false;

  if (action.executorMode === ABILITY_ACTION_EXECUTOR_MODES.source) {
    if (
      targetTokenDocuments.length !== 1
      || currentTarget.uuid !== sourceTokenDocument.uuid
      || actor?.uuid !== sourceActor.uuid
    ) return false;
  } else if (action.executorMode === ABILITY_ACTION_EXECUTOR_MODES.targets) {
    const settings = normalizeActiveApplicationSettings(abilityFunction.activeSettings);
    if (settings.targetMode !== ABILITY_ACTIVE_APPLICATION_TARGET_MODES.others) return false;
    if (settings.targetSelectionMode === ABILITY_ACTIVE_APPLICATION_SELECTION_MODES.manual) {
      const targetLimit = Math.max(1, Math.floor(evaluateActorFormula(settings.targetLimit, sourceActor, {
        fallback: 1,
        minimum: 1,
        context: "movement ability target limit"
      })));
      if (targetTokenDocuments.length > targetLimit) return false;
    }

    const targetGroups = new Set(settings.targetGroups ?? []);
    const seenActors = new Set();
    for (const target of targetTokenDocuments) {
      const targetActor = target.actor;
      if (!sender.isGM && target.hidden) return false;
      if (settings.excludeSelf && targetActor.uuid === sourceActor.uuid) return false;
      if (seenActors.has(targetActor.uuid)) return false;
      seenActors.add(targetActor.uuid);
      const relation = targetActor.uuid === sourceActor.uuid
        ? "ally"
        : getAuraRelation(sourceActor, targetActor);
      if (!targetGroups.has(relation)) return false;

      const radiusFormula = String(settings.radiusFormula ?? "").trim();
      if (radiusFormula) {
        const sourceToken = sourceTokenDocument.object ?? null;
        const targetToken = target.object ?? null;
        if (!sourceToken || !targetToken) return false;
        const radius = Math.max(0, evaluateActorFormula(radiusFormula, sourceActor, {
          fallback: 0,
          minimum: 0,
          context: "movement ability radius"
        }));
        if (measureTokenDistanceMeters(sourceToken, targetToken) > radius + 1e-6) return false;
      }
      if (
        settings.wallsBlock
        && (!sourceTokenDocument.object || !target.object
          || !hasAuraLineOfSight(sourceTokenDocument.object, target.object))
      ) return false;
    }
  } else return false;

  const formulaActor = action.routeBudgetEvaluation === ABILITY_ACTION_ROUTE_EVALUATION_MODES.source
    ? sourceActor
    : actor;
  const expectedMaxBudget = evaluateRouteBudget(action, formulaActor);
  if (String(data.routeBudgetMode ?? "") !== action.routeBudgetMode) return false;
  if (Number.isFinite(expectedMaxBudget)) {
    const suppliedMaxBudget = Number(data.maxBudget);
    if (!Number.isFinite(suppliedMaxBudget) || Math.abs(suppliedMaxBudget - expectedMaxBudget) > 1e-6) {
      return false;
    }
  } else if (data.maxBudget !== null) return false;

  if (String(data.routeMovementAction ?? "") !== getExpectedMovementRouteAction(action, tokenDocument)) return false;
  if (data.autoRotate !== Boolean(action.routeAutoRotate)) return false;
  if (data.showRuler !== Boolean(action.routeShowRuler)) return false;
  return true;
}

function sameStringSet(left = [], right = []) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && Array.from(leftSet).every(value => rightSet.has(value));
}

function getExpectedMovementRouteAction(action = {}, tokenDocument = null) {
  const configured = String(action?.routeMovementAction ?? "").trim();
  const availableActions = globalThis.CONFIG?.Token?.movement?.actions;
  if (!configured || (availableActions && !(configured in availableActions))) {
    return String(tokenDocument?.movementAction ?? "walk");
  }
  return configured;
}

async function handleAbilityActionMovementQuery(data = {}, { user: sender = null } = {}) {
  const actor = data.actorUuid ? await globalThis.fromUuid?.(data.actorUuid) : null;
  const tokenDocument = data.tokenUuid ? await globalThis.fromUuid?.(data.tokenUuid) : null;
  if (
    !actor
    || !actor.isOwner
    || !tokenDocument?.isOwner
    || !tokenDocument.rendered
    || !tokenDocument.object?.actor
    || tokenDocument.actor?.uuid !== actor.uuid
    || getMovementRouteAuthority(actor, tokenDocument)?.id !== game.user?.id
    || !(await validateMovementAbilityAuthority(data, sender, { actor, tokenDocument }))
  ) return false;
  const operation = String(data.operation ?? "execute");
  if (operation === "authorizePlan") {
    if (isActorUnableToAct(actor)) return { authorized: false, reason: "executorUnableToAct" };
    const plannedOrigin = deserializeMovementPosition(data.plannedOrigin);
    if (plannedOrigin && hasTokenDocumentPositionChanged(tokenDocument, plannedOrigin)) {
      return { authorized: false, reason: "routeOriginChanged" };
    }
    const movementState = String(tokenDocument?.movement?.state ?? "");
    if (["planned", "pending", "paused"].includes(movementState)) {
      return { authorized: false, reason: "movementAlreadyActive" };
    }
    return {
      authorized: true,
      authorityUserId: String(game.user?.id ?? ""),
      origin: getTokenDocumentPosition(tokenDocument)
    };
  }
  if (operation === "retainPlan") {
    return retainAbilityMovementRoutePlan(data, sender, { actor, tokenDocument });
  }
  if (operation === "releasePlan") {
    return releaseAbilityMovementRoutePlan(data, sender, { actor, tokenDocument });
  }
  if (operation !== "execute") return false;
  const explicitWaypoints = deserializeMovementWaypoints(data.explicitWaypoints);
  const plannedOrigin = deserializeMovementPosition(data.plannedOrigin);
  if (!explicitWaypoints.length || !plannedOrigin) return false;
  const executionId = String(data.executionId ?? "").trim() || foundry.utils.randomID();
  const combat = getActorActiveCombat(actor);
  return withSystemEventRoot({
    kind: "abilityActionMovement",
    operationId: `ability-action-movement:${executionId}`,
    sceneUuid: getSceneUuidFromTokenUuid(data.tokenUuid),
    combatUuid: String(combat?.uuid ?? ""),
    chainRef: data.chainRef ?? null
  }, scope => movementRouteActorLock.run(actor, scope.chainRef, async () => {
    if (isActorUnableToAct(actor)) {
      return { executed: false, settled: true, reason: "executorUnableToAct" };
    }
    if (hasTokenDocumentPositionChanged(tokenDocument, plannedOrigin)) {
      return { executed: false, settled: true, reason: "routeOriginChanged" };
    }
    const tokenObject = tokenDocument.object ?? null;
    if (!tokenObject?.actor) return { executed: false, settled: true, reason: "executorUnavailable" };
    const revalidated = await resolveNativeMovementPath(
      tokenObject,
      tokenDocument,
      explicitWaypoints,
      String(data.routeMovementAction ?? ""),
      { preview: false }
    );
    if (!revalidated.ok) {
      return { executed: false, settled: true, reason: String(revalidated.reason ?? "routeInvalidated") };
    }
    const maxBudget = data.maxBudget === null || data.maxBudget === undefined
      ? Infinity
      : Number(data.maxBudget);
    const budgetMode = String(data.routeBudgetMode ?? "") === ABILITY_ACTION_ROUTE_BUDGET_MODES.distance
      ? ABILITY_ACTION_ROUTE_BUDGET_MODES.distance
      : ABILITY_ACTION_ROUTE_BUDGET_MODES.movementCost;
    if (!(maxBudget > 0) || !isResolvedRouteWithinBudget(revalidated, budgetMode, maxBudget)) {
      return { executed: false, settled: true, reason: getRouteBudgetFailureReason(budgetMode) };
    }
    if (!preflightOwnedMovementRouteResources(actor, revalidated.movementCost)) {
      return { executed: false, settled: true, reason: "movementResourcesUnavailable" };
    }
    if (isActorUnableToAct(actor)) {
      return { executed: false, settled: true, reason: "executorUnableToAct" };
    }
    if (hasTokenDocumentPositionChanged(tokenDocument, plannedOrigin)) {
      return { executed: false, settled: true, reason: "routeOriginChanged" };
    }
    const finalValidation = await resolveNativeMovementPath(
      tokenObject,
      tokenDocument,
      explicitWaypoints,
      String(data.routeMovementAction ?? ""),
      { preview: false }
    );
    if (
      !finalValidation.ok
      || !isResolvedRouteWithinBudget(finalValidation, budgetMode, maxBudget)
    ) {
      return {
        executed: false,
        settled: true,
        reason: finalValidation.ok
          ? getRouteBudgetFailureReason(budgetMode)
          : String(finalValidation.reason ?? "routeInvalidated")
      };
    }
    const finalWaypoints = finalValidation.path.slice(1);
    if (!preflightOwnedMovementRouteResources(actor, finalValidation.movementCost)) {
      return { executed: false, settled: true, reason: "movementResourcesUnavailable" };
    }
    if (isActorUnableToAct(actor)) {
      return { executed: false, settled: true, reason: "executorUnableToAct" };
    }
    if (hasTokenDocumentPositionChanged(tokenDocument, plannedOrigin)) {
      return { executed: false, settled: true, reason: "routeOriginChanged" };
    }
    if (
      !tokenDocument.rendered
      || !tokenDocument.object?.actor
      || getMovementRouteAuthority(actor, tokenDocument)?.id !== game.user?.id
    ) {
      return { executed: false, settled: true, reason: "movementAuthorityUnavailable" };
    }
    const origin = getTokenDocumentPosition(tokenDocument);
    const suppliedPlanId = String(data.nativePlanId ?? "").trim();
    const existingMovement = tokenDocument.movement;
    const adoptsExistingPlan = Boolean(
      suppliedPlanId
      && String(existingMovement?.id ?? "") === suppliedPlanId
      && existingMovement?.state === "planned"
      && existingMovement?.user?.isSelf
    );
    let movementId = suppliedPlanId;
    let movementPromise = null;
    if (adoptsExistingPlan) {
      const binding = retainedMovementRoutePlans.get(suppliedPlanId);
      movementPromise = binding?.movementPromise
        ?? Promise.resolve(tokenDocument.movement?.promise ?? true);
      retainedMovementRoutePlans.delete(suppliedPlanId);
    } else {
      if (["planned", "pending", "paused"].includes(String(existingMovement?.state ?? ""))) {
        return { executed: false, settled: true, reason: "movementAlreadyActive" };
      }
      const nativeOptions = getNativeMovementRouteOptions(tokenObject, { preview: false });
      movementId = foundry.utils.randomID();
      const movementOptions = {
        id: movementId,
        method: "api",
        planned: true,
        autoRotate: Boolean(data.autoRotate),
        showRuler: Boolean(data.showRuler),
        constrainOptions: nativeOptions.constrainOptions,
        terrainOptions: nativeOptions.terrainOptions,
        measureOptions: nativeOptions.measureOptions
      };
      if (scope.chainRef) {
        movementOptions.chainRef = scope.chainRef;
        movementOptions.falloutMawSystemEventChainRef = scope.chainRef;
      }
      try {
        const planWaiter = createTokenMovementPlanWaiter(tokenDocument, movementId, {
          timeoutMs: Math.min(30000, Math.max(3000, Number(data.timeoutMs) || 30000))
        });
        movementPromise = tokenDocument.move(finalWaypoints, movementOptions);
        const planned = await Promise.race([
          planWaiter.promise,
          movementPromise.then(() => false, () => false)
        ]);
        planWaiter.cancel();
        if (!planned) {
          if (String(tokenDocument?.movement?.id ?? "") === movementId) tokenDocument.stopMovement?.();
          await movementPromise.catch(() => false);
          return { executed: false, settled: true, reason: "movementPlanningFailed" };
        }
      } catch (error) {
        console.warn("fallout-maw | Ability movement execution failed", error);
        return { executed: false, settled: true };
      }
    }
    try {
      // startMovement may return false when a synchronous preMoveToken hook
      // defers the move into the system's asynchronous movement gate. The
      // settlement tracker below is authoritative for that case.
      await tokenDocument.startMovement(movementId);
      const completed = await movementPromise;
      const settlement = await waitForSystemMovementSettlement(tokenDocument, {
        timeoutMs: Math.min(600000, Math.max(1000, Number(data.timeoutMs) || 600000))
      });
      const animation = tokenDocument.movement?.animation?.ended;
      if (animation?.then) await animation.catch(() => undefined);
      await waitForCombatResourceSpending(actor);
      const moved = hasTokenDocumentPositionChanged(tokenDocument, origin);
      const executed = completed !== false
        || (settlement.settled && settlement.completed)
        || moved;
      return { executed, settled: Boolean(settlement.settled), handled: Boolean(settlement.handled) };
    } catch (error) {
      console.warn("fallout-maw | Ability movement execution failed", error);
      return { executed: false, settled: true };
    }
  }));
}

async function retainAbilityMovementRoutePlan(data, sender, { actor, tokenDocument }) {
  const explicitWaypoints = deserializeMovementWaypoints(data.explicitWaypoints);
  const plannedOrigin = deserializeMovementPosition(data.plannedOrigin);
  if (!explicitWaypoints.length || !plannedOrigin) {
    return { retained: false, reason: "emptyRoute" };
  }
  return movementRouteActorLock.run(actor, null, async () => {
    if (isActorUnableToAct(actor)) {
      return { retained: false, reason: "executorUnableToAct" };
    }
    if (hasTokenDocumentPositionChanged(tokenDocument, plannedOrigin)) {
      return { retained: false, reason: "routeOriginChanged" };
    }
    const tokenObject = tokenDocument.object ?? null;
    if (!tokenObject?.actor) return { retained: false, reason: "executorUnavailable" };

    const movementAction = String(data.routeMovementAction ?? "");
    const resolved = await resolveNativeMovementPath(
      tokenObject,
      tokenDocument,
      explicitWaypoints,
      movementAction,
      { preview: false }
    );
    if (!resolved.ok) {
      return { retained: false, reason: String(resolved.reason ?? "routeInvalidated") };
    }
    const configuredMaxBudget = data.maxBudget === null || data.maxBudget === undefined
      ? Infinity
      : Number(data.maxBudget);
    const suppliedEffectiveBudget = data.effectiveMaxBudget === null || data.effectiveMaxBudget === undefined
      ? configuredMaxBudget
      : Number(data.effectiveMaxBudget);
    const effectiveMaxBudget = Math.min(configuredMaxBudget, suppliedEffectiveBudget);
    const budgetMode = String(data.routeBudgetMode ?? "") === ABILITY_ACTION_ROUTE_BUDGET_MODES.distance
      ? ABILITY_ACTION_ROUTE_BUDGET_MODES.distance
      : ABILITY_ACTION_ROUTE_BUDGET_MODES.movementCost;
    const withinBudget = isResolvedRouteWithinBudget(resolved, budgetMode, effectiveMaxBudget);
    if (
      !(configuredMaxBudget > 0)
      || !(effectiveMaxBudget > 0)
      || suppliedEffectiveBudget > configuredMaxBudget + 1e-6
      || !withinBudget
    ) {
      return { retained: false, reason: getRouteBudgetFailureReason(budgetMode) };
    }
    if (!preflightOwnedMovementRouteResources(actor, resolved.movementCost)) {
      return { retained: false, reason: "movementResourcesUnavailable" };
    }
    if (isActorUnableToAct(actor)) return { retained: false, reason: "executorUnableToAct" };
    if (hasTokenDocumentPositionChanged(tokenDocument, plannedOrigin)) {
      return { retained: false, reason: "routeOriginChanged" };
    }

    const suppliedPlanId = String(data.nativePlanId ?? "").trim();
    const movement = tokenDocument.movement;
    const adoptsExistingPlan = Boolean(
      suppliedPlanId
      && String(movement?.id ?? "") === suppliedPlanId
      && movement?.state === "planned"
      && movement?.user?.isSelf
    );
    if (
      !adoptsExistingPlan
      && ["planned", "pending", "paused"].includes(String(movement?.state ?? ""))
    ) {
      return { retained: false, reason: "movementAlreadyActive" };
    }

    const movementId = adoptsExistingPlan ? suppliedPlanId : foundry.utils.randomID();
    const existingBinding = retainedMovementRoutePlans.get(movementId);
    if (existingBinding && !retainedMovementRoutePlanMatches(existingBinding, data, sender, tokenDocument)) {
      return { retained: false, reason: "movementPlanOwnershipMismatch" };
    }

    let movementPromise = existingBinding?.movementPromise ?? null;
    if (!adoptsExistingPlan) {
      const finalWaypoints = resolved.path.slice(1);
      const nativeOptions = getNativeMovementRouteOptions(tokenObject, { preview: false });
      const planWaiter = createTokenMovementPlanWaiter(tokenDocument, movementId, {
        timeoutMs: Math.min(30000, Math.max(3000, Number(data.timeoutMs) || 30000))
      });
      movementPromise = Promise.resolve(tokenDocument.move(finalWaypoints, {
        id: movementId,
        method: "api",
        planned: true,
        autoRotate: Boolean(data.autoRotate),
        showRuler: Boolean(data.showRuler),
        constrainOptions: nativeOptions.constrainOptions,
        terrainOptions: nativeOptions.terrainOptions,
        measureOptions: nativeOptions.measureOptions,
        [ABILITY_ROUTE_PREVIEW_MOVEMENT_OPTION]: true
      })).catch(error => {
        console.warn("fallout-maw | Failed to retain remote ability movement plan", error);
        return false;
      });
      const planned = await Promise.race([
        planWaiter.promise,
        movementPromise.then(() => false)
      ]);
      planWaiter.cancel();
      if (!planned) {
        if (
          String(tokenDocument?.movement?.id ?? "") === movementId
          && tokenDocument?.movement?.user?.isSelf
        ) tokenDocument.stopMovement?.();
        return { retained: false, reason: "movementPlanningFailed" };
      }
    }

    const binding = {
      senderId: String(sender?.id ?? ""),
      tokenUuid: String(tokenDocument.uuid ?? ""),
      actorUuid: String(actor.uuid ?? ""),
      actionId: String(data.actionId ?? ""),
      authoritySignature: JSON.stringify(data.authorityContext ?? null),
      movementPromise
    };
    retainedMovementRoutePlans.set(movementId, binding);
    const origin = getTokenDocumentPosition(tokenDocument);
    const waypoints = resolved.path.slice(1);
    const destination = waypoints.at(-1) ?? origin;
    const budgetUsed = budgetMode === ABILITY_ACTION_ROUTE_BUDGET_MODES.distance
      ? Number(resolved.distance) || 0
      : Number(resolved.movementCost) || 0;
    return {
      retained: true,
      authorityUserId: String(game.user?.id ?? ""),
      planId: movementId,
      origin: serializeMovementWaypoints([origin])[0],
      destination: serializeMovementWaypoints([destination])[0],
      explicitWaypoints: serializeMovementWaypoints(explicitWaypoints),
      waypoints: serializeMovementWaypoints(waypoints),
      previewPath: serializeMovementWaypoints(resolved.previewPath),
      distance: resolved.distance,
      movementCost: resolved.movementCost,
      budgetUsed,
      maxBudget: effectiveMaxBudget,
      configuredMaxBudget,
      budgetMode,
      movementAction,
      nativePlan: {
        id: movementId,
        origin: serializeMovementWaypoints([origin])[0],
        destination: serializeMovementWaypoints([destination])[0],
        waypoints: serializeMovementWaypoints(waypoints)
      }
    };
  });
}

async function releaseAbilityMovementRoutePlan(data, sender, { actor, tokenDocument }) {
  const movementId = String(data.nativePlanId ?? "").trim();
  const binding = retainedMovementRoutePlans.get(movementId);
  if (
    !movementId
    || !binding
    || !retainedMovementRoutePlanMatches(binding, data, sender, tokenDocument)
  ) return { released: false, reason: "movementPlanOwnershipMismatch" };
  return movementRouteActorLock.run(actor, null, async () => {
    markAbilityRoutePreviewStop(tokenDocument, movementId);
    try {
      if (
        String(tokenDocument?.movement?.id ?? "") !== movementId
        || tokenDocument?.movement?.state !== "planned"
        || !tokenDocument?.movement?.user?.isSelf
        || typeof tokenDocument?.stopMovement !== "function"
      ) return { released: false, reason: "movementPlanUnavailable" };
      const released = await tokenDocument.stopMovement();
      return { released: Boolean(released) };
    } finally {
      clearAbilityRoutePreviewStop(tokenDocument, movementId);
      retainedMovementRoutePlans.delete(movementId);
    }
  });
}

function retainedMovementRoutePlanMatches(binding, data, sender, tokenDocument) {
  return Boolean(
    binding
    && binding.senderId === String(sender?.id ?? "")
    && binding.tokenUuid === String(tokenDocument?.uuid ?? "")
    && binding.actorUuid === String(data.actorUuid ?? "")
    && binding.actionId === String(data.actionId ?? "")
    && binding.authoritySignature === JSON.stringify(data.authorityContext ?? null)
  );
}

function createTokenMovementPlanWaiter(tokenDocument, movementId, { timeoutMs = 30000 } = {}) {
  let hookId = null;
  let timer = null;
  let settled = false;
  let resolvePromise;
  const cleanup = () => {
    if (hookId !== null) Hooks.off("planToken", hookId);
    if (timer !== null) clearTimeout(timer);
    hookId = null;
    timer = null;
  };
  const finish = result => {
    if (settled) return;
    settled = true;
    cleanup();
    resolvePromise(Boolean(result));
  };
  const promise = new Promise(resolve => {
    resolvePromise = resolve;
    hookId = Hooks.on("planToken", document => {
      if (document?.uuid !== tokenDocument?.uuid) return;
      if (String(document?.movement?.id ?? "") !== String(movementId)) return;
      finish(document?.movement?.state === "planned");
    });
    timer = setTimeout(() => finish(
      tokenDocument?.movement?.state === "planned"
      && String(tokenDocument?.movement?.id ?? "") === String(movementId)
    ), timeoutMs);
  });
  return { promise, cancel: () => finish(false) };
}

function notifyMovementRouteExecutionFailure(actor, reason = "") {
  const messages = {
    movementPlanningFailed: "Foundry не удалось подготовить нативный план перемещения",
    routeOriginChanged: "позиция изменилась после подтверждения маршрута",
    executorUnavailable: "исполнитель больше недоступен",
    unreachable: "маршрут больше недоступен",
    pathPlanningFailed: "не удалось заново построить маршрут",
    measurementFailed: "не удалось заново измерить маршрут",
    routeInvalidated: "маршрут утратил актуальность",
    maxDistance: "обновлённый маршрут превышает максимальную дистанцию",
    maxMovementCost: "обновлённый маршрут превышает бюджет ОП",
    movementResourcesUnavailable: "после реакций не хватает ОП/ОД для перемещения",
    executorUnableToAct: "исполнитель больше не может действовать",
    movementAuthorityUnavailable: "нет владельца или ведущего на нужной сцене и уровне"
  };
  ui?.notifications?.warn?.(`${actor?.name ?? "Актёр"}: ${messages[reason] ?? "маршрут не выполнен"}.`);
}

function preflightOwnedMovementRouteResources(actor, movementCost = 0) {
  if (!isActorInActiveCombat(actor)) return true;
  const state = getCombatMovementResourceState(actor);
  if (!state) return true;
  const cost = Math.max(0, Number(movementCost) || 0);
  const available = Math.max(0, Number(state.total) || 0);
  if (cost <= available) return true;
  ui?.notifications?.warn?.(
    `${actor?.name ?? "Актёр"}: не хватает ОП/${state.action?.label ?? "ОД"} для маршрута (${Math.ceil(cost)} > ${available}).`
  );
  return false;
}

function isResolvedRouteWithinBudget(result = {}, mode, maxBudget) {
  if (!Number.isFinite(Number(maxBudget))) return true;
  const used = mode === ABILITY_ACTION_ROUTE_BUDGET_MODES.distance
    ? Number(result?.distance)
    : Number(result?.movementCost);
  return Number.isFinite(used) && used <= Number(maxBudget) + 1e-6;
}

function getRouteBudgetFailureReason(mode) {
  return mode === ABILITY_ACTION_ROUTE_BUDGET_MODES.distance ? "maxDistance" : "maxMovementCost";
}

function getTokenDocumentPosition(tokenDocument) {
  const source = tokenDocument?._source ?? tokenDocument ?? {};
  return {
    x: source.x,
    y: source.y,
    elevation: source.elevation,
    width: source.width,
    height: source.height,
    depth: source.depth,
    shape: source.shape,
    level: source.level
  };
}

function hasTokenDocumentPositionChanged(tokenDocument, origin) {
  const current = getTokenDocumentPosition(tokenDocument);
  const compare = tokenDocument?.constructor?.arePositionsEqual;
  if (typeof compare === "function") return !compare.call(tokenDocument.constructor, current, origin);
  return ["x", "y", "elevation", "width", "height", "depth", "shape", "level"]
    .some(field => current[field] !== origin?.[field]);
}

function serializeMovementPosition(source = null) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const result = {};
  for (const key of ["x", "y", "elevation", "width", "height", "depth", "shape", "level"]) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return Object.keys(result).length ? result : null;
}

function serializeMovementWaypoints(waypoints = []) {
  return (Array.isArray(waypoints) ? waypoints : []).map(waypoint => {
    const result = {};
    for (const key of ["x", "y", "elevation", "width", "height", "depth", "shape", "level", "action", "snapped", "explicit", "checkpoint"]) {
      if (waypoint?.[key] !== undefined) result[key] = waypoint[key];
    }
    return result;
  });
}

function deserializeMovementWaypoints(waypoints = []) {
  if (!Array.isArray(waypoints) || !waypoints.length || waypoints.length > 256) return [];
  const allowed = new Set([
    "x", "y", "elevation", "width", "height", "depth", "shape", "level",
    "action", "snapped", "explicit", "checkpoint"
  ]);
  const result = [];
  for (const source of waypoints) {
    if (!source || typeof source !== "object" || Array.isArray(source)) return [];
    if (Object.keys(source).some(key => !allowed.has(key))) return [];
    const waypoint = serializeMovementWaypoints([source])[0] ?? null;
    if (
      !waypoint
      || !Number.isInteger(waypoint.x)
      || !Number.isInteger(waypoint.y)
      || !Number.isFinite(waypoint.elevation)
      || !Number.isFinite(waypoint.width)
      || waypoint.width <= 0
      || !Number.isFinite(waypoint.height)
      || waypoint.height <= 0
      || !Number.isFinite(waypoint.depth)
      || waypoint.depth < 0
      || typeof waypoint.action !== "string"
      || typeof waypoint.snapped !== "boolean"
      || waypoint.explicit !== true
      || waypoint.checkpoint !== true
    ) return [];
    result.push(waypoint);
  }
  return result;
}

function deserializeMovementPosition(source = null) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const allowed = new Set(["x", "y", "elevation", "width", "height", "depth", "shape", "level"]);
  if (Object.keys(source).some(key => !allowed.has(key))) return null;
  const position = {};
  for (const key of allowed) {
    if (source[key] !== undefined) position[key] = source[key];
  }
  if (
    !Number.isInteger(position.x)
    || !Number.isInteger(position.y)
    || !Number.isFinite(position.elevation)
    || !Number.isFinite(position.width)
    || position.width <= 0
    || !Number.isFinite(position.height)
    || position.height <= 0
    || !Number.isFinite(position.depth)
    || position.depth < 0
  ) return null;
  return position;
}

async function executeAbilityActionAttackQuery(data = {}, chainRef = null, authority = null) {
  const actor = authority?.actor ?? null;
  const attackerToken = authority?.attackerTokenDocument?.object ?? null;
  const targetToken = authority?.targetTokenDocument?.object ?? null;
  const weapon = authority?.weapon ?? null;
  const action = authority?.action ?? null;
  const option = authority?.option ?? null;
  if (!actor?.isOwner || attackerToken?.actor?.uuid !== actor.uuid || weapon?.parent?.uuid !== actor.uuid) return false;

  const actionKey = String(option?.actionKey ?? "");
  const weaponFunctionId = String(option?.weaponFunctionId ?? "");
  const actionPointCost = Math.max(0, Math.trunc(Number(option?.actionPointCost) || 0));
  const attackModifier = data.preventCancel
    ? createForcedAttackModifier({ label: getWeaponActionLabel(actionKey) })
    : null;
  const onBeforeExecute = async () => {
    if (actionPointCost <= 0) return true;
    if (!canSpendStrictActionPoints(actor, actionPointCost, { label: getWeaponActionLabel(actionKey) })) return false;
    await spendStrictActionPoints(actor, actionPointCost, {
      source: "abilityAction",
      actionKey,
      chainRef
    });
    return true;
  };

  const suppressGenericEventReactions = Boolean(data.preventCancel || data.autoApply);
  if (action?.targetMode === ABILITY_ACTION_TARGET_MODES.free) {
    return startWeaponAttackAndWait({
      token: attackerToken,
      weapon,
      actionKey,
      weaponFunctionId,
      attackModifier,
      chainRef,
      damageHubOperationRef: data.damageHubOperationRef,
      onBeforeExecute,
      skipActionPointCost: true,
      ignoreReactionLock: Boolean(data.ignoreReactionLock),
      suspendActiveAttack: true,
      timeoutMs: data.timeoutMs,
      suppressGenericEventReactions
    });
  }
  if (!targetToken?.actor) return false;
  if (["aimedShot", "aimedMeleeAttack"].includes(actionKey) && !data.autoApply) {
    return startConstrainedAimedAttackSelection({
      attackerToken,
      targetToken,
      weapon,
      actionKey,
      weaponFunctionId,
      attackModifier,
      chainRef,
      damageHubOperationRef: data.damageHubOperationRef,
      onBeforeExecute,
      timeoutMs: data.timeoutMs,
      suppressGenericEventReactions
    });
  }
  return executeWeaponAttackAgainstToken({
    attackerToken,
    targetToken,
    weapon,
    actionKey,
    weaponFunctionId,
    attackModifier,
    chainRef,
    damageHubOperationRef: data.damageHubOperationRef,
    onBeforeExecute,
    skipActionPointCost: true,
    ignoreReactionLock: Boolean(data.ignoreReactionLock),
    suspendActiveAttack: true,
    suppressGenericEventReactions
  });
}

function pickRandomAbilityAttackOption(options = []) {
  if (!options.length) return null;
  return options[Math.floor(Math.random() * options.length)] ?? null;
}

function getSceneUuidFromTokenUuid(tokenUuid = "") {
  return String(tokenUuid ?? "").match(/^(Scene\.[^.]+)/)?.[1]
    ?? String(canvas?.scene?.uuid ?? "");
}

async function handleAbilityActionSelectionQuery(data = {}) {
  const actor = data.actorUuid ? await globalThis.fromUuid?.(data.actorUuid) : null;
  if (!actor?.isOwner) return null;
  const option = await requestAbilityWeaponAttackOption(
    Array.isArray(data.options) ? data.options : [],
    { title: String(data.title ?? "") }
  );
  return option ? { optionId: String(option.id ?? "") } : null;
}

function getPrimaryActorToken(actor) {
  return canvas?.tokens?.controlled?.find(token => token?.actor?.uuid === actor?.uuid)
    ?? canvas?.tokens?.placeables?.find(token => token?.actor?.uuid === actor?.uuid)
    ?? actor?.getActiveTokens?.()?.[0]
    ?? null;
}

function getWeaponActionLabel(actionKey) {
  const keys = {
    aimedShot: "WeaponActionAimedShot",
    snapshot: "WeaponActionSnapshot",
    burst: "WeaponActionBurst",
    volley: "WeaponActionVolley",
    meleeAttack: "WeaponActionMeleeAttack",
    aimedMeleeAttack: "WeaponActionAimedMeleeAttack",
    push: "WeaponActionPush"
  };
  return game.i18n.localize(`FALLOUTMAW.Item.${keys[actionKey] ?? actionKey}`);
}

function groupAbilityAttackOptionsByWeapon(options = []) {
  const groups = new Map();
  for (const option of options) {
    const weaponUuid = String(option?.weaponUuid ?? option?.weapon?.uuid ?? "");
    if (!weaponUuid) continue;
    const group = groups.get(weaponUuid) ?? {
      weaponUuid,
      name: String(option?.weaponName ?? option?.weapon?.name ?? weaponUuid),
      img: String(option?.weaponImg ?? option?.weapon?.img ?? "icons/svg/sword.svg"),
      options: []
    };
    group.options.push(option);
    groups.set(weaponUuid, group);
  }
  return Array.from(groups.values());
}

function serializeAbilityAttackSelectionOption(option = {}) {
  return {
    id: String(option.id ?? ""),
    weaponUuid: String(option.weaponUuid ?? option.weapon?.uuid ?? ""),
    weaponName: String(option.weapon?.name ?? ""),
    weaponImg: String(option.weapon?.img ?? "icons/svg/sword.svg"),
    weaponFunctionId: String(option.weaponFunctionId ?? ""),
    weaponFunctionName: String(option.weaponFunctionName ?? ""),
    actionKey: String(option.actionKey ?? ""),
    actionPointCost: Math.max(0, Math.trunc(Number(option.actionPointCost) || 0))
  };
}

function buildAbilityActionDialogTitle(title = "", localizationKey = "SelectAttack") {
  const step = game.i18n.localize(`FALLOUTMAW.Ability.Actions.${localizationKey}`);
  return title ? `${title}: ${step}` : step;
}

function formatActionOptionDetails(option) {
  const functionName = String(option.weaponFunctionName ?? "").trim();
  const costLine = buildAbilityActionPointCostLine(option.weapon?.parent, option.actionPointCost);
  const details = [functionName, costLine].filter(Boolean);
  return details.length ? `<br>${escapeHTML(details.join(" · "))}` : "";
}

function escapeHTML(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

function escapeAttribute(value) {
  return escapeHTML(value).replaceAll('"', "&quot;");
}
