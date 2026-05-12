import {
  MOVEMENT_RULER_COLORS,
  applyCombatMovementCostModifier,
  clearCombatMovementResourcePreview,
  getCombatMovementResourceState,
  isGMDebugMovementBypassActive,
  isCombatMovementTracked,
  publishCombatMovementResourcePreview
} from "../combat/movement-resources.mjs";

export class FalloutMaWTokenRuler extends foundry.canvas.placeables.tokens.TokenRuler {
  refresh(rulerData) {
    super.refresh(rulerData);
    syncCombatMovementResourcePreview(this.token, rulerData);
  }

  _getWaypointStyle(waypoint) {
    return applyCombatMovementStyle(this.token, waypoint, super._getWaypointStyle(waypoint));
  }

  _getSegmentStyle(waypoint) {
    return applyCombatMovementStyle(this.token, waypoint, super._getSegmentStyle(waypoint));
  }

  _getGridHighlightStyle(waypoint, offset) {
    return applyCombatMovementStyle(this.token, waypoint, super._getGridHighlightStyle(waypoint, offset));
  }
}

function applyCombatMovementStyle(token, waypoint, style) {
  if (!isSelfPlannedMovement(token)) return style;
  if (waypoint.stage === "passed") return style;
  if (isGMDebugMovementBypassActive()) return style;
  if (!isCombatMovementTracked(token.document)) return style;
  if (CONFIG.Token.movement.actions[waypoint.action]?.teleport) return style;

  const state = getCombatMovementResourceState(token.actor);
  if (!state) return style;

  const cost = getWaypointCost(token.actor, waypoint);
  if (cost <= state.movement.value) return { ...style, color: MOVEMENT_RULER_COLORS.movement };
  if (cost <= state.total) return { ...style, color: MOVEMENT_RULER_COLORS.action };
  return { ...style, color: MOVEMENT_RULER_COLORS.exhausted };
}

function isSelfPlannedMovement(token) {
  return Boolean(game.user?.id && token?._plannedMovement && (game.user.id in token._plannedMovement));
}

function getWaypointCost(actor, waypoint) {
  const cost = Number(waypoint?.measurement?.cost ?? 0) - getPassedHistoryCost(waypoint);
  if (!Number.isFinite(cost) || cost <= 0) return 0;
  return applyCombatMovementCostModifier(actor, Math.ceil(cost));
}

function getPassedHistoryCost(waypoint) {
  let previous = waypoint?.previous;
  while (previous) {
    if (previous.stage === "passed") return Number(previous.measurement?.cost ?? 0) || 0;
    previous = previous.previous;
  }
  return 0;
}

function syncCombatMovementResourcePreview(token, rulerData) {
  if (!isSelfPlannedMovement(token) || isGMDebugMovementBypassActive() || !isCombatMovementTracked(token.document)) {
    clearCombatMovementResourcePreview(token.document);
    return;
  }

  const cost = getSelfPlannedMovementCost(token, rulerData);
  if (cost <= 0) {
    clearCombatMovementResourcePreview(token.document);
    return;
  }

  publishCombatMovementResourcePreview(token.document, cost);
}

function getSelfPlannedMovementCost(token, rulerData) {
  const planned = rulerData?.plannedMovement?.[game.user?.id];
  if (!planned?.foundPath?.length) return 0;

  const path = [
    ...(planned.history ?? []),
    ...(planned.foundPath ?? [])
  ];
  if (!path.length) return 0;

  const measurement = token.document.measureMovementPath(path);
  const waypoints = measurement?.waypoints ?? [];
  const totalCost = Number(waypoints.at(-1)?.cost ?? 0);
  const historyCost = planned.history?.length
    ? Number(waypoints[Math.max(0, planned.history.length - 1)]?.cost ?? 0)
    : 0;
  const cost = totalCost - historyCost;
  if (!Number.isFinite(cost) || cost <= 0) return 0;
  return applyCombatMovementCostModifier(token.actor, Math.ceil(cost));
}
