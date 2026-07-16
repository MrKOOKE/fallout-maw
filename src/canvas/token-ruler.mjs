import {
  MOVEMENT_RULER_COLORS,
  applyCombatMovementCostModifier,
  clearCombatMovementResourcePreview,
  getCombatMovementResourceState,
  isGMDebugMovementBypassActive,
  isCombatMovementTracked,
  publishCombatMovementResourcePreview
} from "../combat/movement-resources.mjs";
import { getTravelMovementPreview } from "../global-map/travel-movement.mjs";
import {
  ABILITY_ROUTE_BUDGET_MODES,
  getAbilityRoutePreviewBudget,
  updateAbilityRoutePreviewBudget
} from "./ability-route-preview-state.mjs";

export class FalloutMaWTokenRuler extends foundry.canvas.placeables.tokens.TokenRuler {
  static WAYPOINT_LABEL_TEMPLATE = "systems/fallout-maw/templates/hud/travel-waypoint-label.hbs";

  #selfPlannedMovement = false;

  refresh(rulerData) {
    this.#selfPlannedMovement = isSelfPlannedMovement(this.token, rulerData);
    syncAbilityRouteBudgetPreview(this.token, rulerData);
    super.refresh(rulerData);
    syncCombatMovementResourcePreview(this.token, rulerData, this.#selfPlannedMovement);
  }

  _getWaypointStyle(waypoint) {
    return applyCombatMovementStyle(
      this.token,
      waypoint,
      super._getWaypointStyle(waypoint),
      this.#selfPlannedMovement
    );
  }

  _getSegmentStyle(waypoint) {
    return applyCombatMovementStyle(
      this.token,
      waypoint,
      super._getSegmentStyle(waypoint),
      this.#selfPlannedMovement
    );
  }

  _getGridHighlightStyle(waypoint, offset) {
    return applyCombatMovementStyle(
      this.token,
      waypoint,
      super._getGridHighlightStyle(waypoint, offset),
      this.#selfPlannedMovement
    );
  }

  _getWaypointLabelContext(waypoint, state) {
    const context = super._getWaypointLabelContext(waypoint, state);
    if (!context || waypoint.next) return context;
    context.travel = getTravelMovementPreview(this.token, waypoint);
    const previewUserId = String(
      waypoint?.userId
      ?? this.token?.document?.movement?.user?.id
      ?? game.user?.id
      ?? ""
    );
    const preview = waypoint.stage !== "passed"
      ? getAbilityRoutePreviewBudget(this.token, previewUserId)
      : null;
    if (preview) {
      const used = Number(preview.used);
      const total = Number(preview.total);
      context.abilityRouteBudget = {
        used: preview.searching ? "…" : Number.isFinite(used) ? formatNumber(used) : "—",
        total: Number.isFinite(total) ? formatNumber(total) : "∞",
        unit: preview.mode === ABILITY_ROUTE_BUDGET_MODES.distance
          ? String(canvas.grid?.units ?? "")
          : "ОП",
        over: Boolean(preview.invalid)
          || (Number.isFinite(used) && Number.isFinite(total) && used > total + 1e-6)
      };
      const resourceUsed = Number(preview.resourceUsed);
      const resourceTotal = Number(preview.resourceTotal);
      if (
        preview.mode === ABILITY_ROUTE_BUDGET_MODES.distance
        && Number.isFinite(resourceTotal)
      ) {
        context.abilityRouteResourceBudget = {
          used: preview.searching ? "…" : Number.isFinite(resourceUsed) ? formatNumber(resourceUsed) : "—",
          total: formatNumber(resourceTotal),
          over: Number.isFinite(resourceUsed) && resourceUsed > resourceTotal + 1e-6
        };
      }
    }
    return context;
  }
}

function applyCombatMovementStyle(token, waypoint, style, selfPlannedMovement = false) {
  if (!selfPlannedMovement) return style;
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

function isSelfPlannedMovement(token, rulerData = null) {
  if (game.user?.id && rulerData?.plannedMovement && (game.user.id in rulerData.plannedMovement)) return true;
  const movement = token?.document?.movement;
  return Boolean(
    movement?.user?.isSelf
    && movement?.showRuler
    && ["planned", "pending", "paused"].includes(movement?.state)
  );
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

function syncCombatMovementResourcePreview(token, rulerData, selfPlannedMovement = false) {
  if (!selfPlannedMovement || isGMDebugMovementBypassActive() || !isCombatMovementTracked(token.document)) {
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

function syncAbilityRouteBudgetPreview(token, rulerData = {}) {
  const userId = String(game.user?.id ?? "");
  const preview = getAbilityRoutePreviewBudget(token, userId);
  if (!preview) return;
  const summary = getSelfPlannedMovementSummary(token, rulerData);
  updateAbilityRoutePreviewBudget(token, {
    used: preview.mode === ABILITY_ROUTE_BUDGET_MODES.distance
      ? summary.distance
      : summary.movementCost,
    resourceUsed: summary.movementCost,
    searching: summary.searching,
    invalid: summary.invalid
  }, userId);
}

function getSelfPlannedMovementCost(token, rulerData) {
  return getSelfPlannedMovementSummary(token, rulerData).movementCost;
}

function getSelfPlannedMovementSummary(token, rulerData = {}) {
  const planned = rulerData?.plannedMovement?.[game.user?.id];
  const passed = planned ? (planned.history ?? []) : (rulerData?.passedWaypoints ?? []);
  const pending = planned ? (planned.foundPath ?? []) : (rulerData?.pendingWaypoints ?? []);
  const invalid = Boolean(planned?.unreachableWaypoints?.length);
  const searching = Boolean(planned?.searching);
  if (!pending.length) return { movementCost: 0, distance: 0, invalid, searching };
  const path = [...passed, ...pending];
  if (!path.length) return { movementCost: 0, distance: 0, invalid, searching };

  // Measure through the placeable so Foundry applies the same action/terrain
  // cost function used by the native TokenRuler and the eventual movement.
  const measurement = token.measureMovementPath(path, { preview: Boolean(planned) });
  const waypoints = measurement?.waypoints ?? [];
  const totalCost = Number(waypoints.at(-1)?.cost ?? 0);
  const totalDistance = Number(waypoints.at(-1)?.distance ?? measurement?.distance ?? 0);
  const historyCost = passed.length
    ? Number(waypoints[Math.max(0, passed.length - 1)]?.cost ?? 0)
    : 0;
  const historyDistance = passed.length
    ? Number(waypoints[Math.max(0, passed.length - 1)]?.distance ?? 0)
    : 0;
  const cost = totalCost - historyCost;
  const distance = totalDistance - historyDistance;
  return {
    movementCost: Number.isFinite(cost) && cost > 0
      ? applyCombatMovementCostModifier(token.actor, Math.ceil(cost))
      : 0,
    distance: Number.isFinite(distance) && distance > 0 ? distance : 0,
    invalid,
    searching
  };
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "∞";
  return number.toNearest?.(0.01)?.toLocaleString?.(globalThis.game?.i18n?.lang)
    ?? Number(number.toFixed(2)).toLocaleString(globalThis.game?.i18n?.lang);
}
