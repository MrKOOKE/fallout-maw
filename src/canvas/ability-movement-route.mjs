import { measureTheoreticalMovementPathCost } from "../combat/movement-resources.mjs";
import {
  ABILITY_ROUTE_PREVIEW_MOVEMENT_OPTION,
  ABILITY_ROUTE_BUDGET_MODES,
  clearAbilityRoutePlanCommitter,
  clearAbilityRoutePreviewBudget,
  clearAbilityRoutePreviewStop,
  getAbilityRoutePreviewBudget,
  isAbilityRoutePlanningInteractive,
  markAbilityRoutePreviewStop,
  setAbilityRoutePlanCommitter,
  setAbilityRoutePreviewBudget,
  updateAbilityRoutePreviewBudget
} from "./ability-route-preview-state.mjs";
import { createRightClickPanGuard } from "./right-click-pan-guard.mjs";
import { startCanvasTargetSelectionSession } from "./target-selection-lifecycle.mjs";

const ROUTE_EPSILON = 1e-6;
const ABILITY_ROUTE_PATH_READY_POLL_MS = 5;
const ABILITY_ROUTE_PATH_READY_TIMEOUT_MS = 750;
const ACTIVE_MOVEMENT_STATES = new Set(["planned", "pending", "paused"]);
const MOVEMENT_POSITION_FIELDS = Object.freeze([
  "x", "y", "elevation", "width", "height", "depth", "shape", "level"
]);
const MOVEMENT_WAYPOINT_FIELDS = Object.freeze([
  ...MOVEMENT_POSITION_FIELDS, "action", "snapped", "explicit", "checkpoint"
]);

/**
 * Build one route through Foundry's native Token drag workflow.
 *
 * Foundry owns the drag clone, pathfinding, TokenRuler, grid highlights and
 * activity broadcast. A socket-authorized owner/GM persists the confirmed
 * plan, so the activator can command any valid executor and prior routes stay
 * visible while the remaining actors are planned.
 */
export async function requestAbilityMovementRoute({
  token = null,
  origin = null,
  history = null,
  maxBudget = Infinity,
  resourceBudget = Infinity,
  budgetMode = ABILITY_ROUTE_BUDGET_MODES.movementCost,
  title = "Маршрут перемещения",
  movementAction = "",
  autoRotate = false,
  showRuler = true,
  planAuthority = null,
  sessionContext = {}
} = {}) {
  const tokenObject = token?.object ?? token ?? null;
  const tokenDocument = tokenObject?.document ?? token?.document ?? token ?? null;
  if (!tokenObject?.actor || !tokenDocument || typeof tokenObject.planAbilityMovement !== "function") {
    return { cancelled: false, failed: true, reason: "executorUnavailable" };
  }
  if (!planAuthority || typeof planAuthority.retain !== "function") {
    return { cancelled: false, failed: true, reason: "movementAuthorityUnavailable" };
  }
  if (isNativeMovementBusy(tokenDocument)) {
    ui?.notifications?.warn?.(`${title}: у токена уже есть незавершённое перемещение.`);
    return { cancelled: false, failed: true, reason: "movementAlreadyActive" };
  }

  const normalizedBudgetMode = normalizeRouteBudgetMode(budgetMode);
  const normalizedMaxBudget = normalizeRouteBudget(maxBudget);
  const normalizedResourceBudget = normalizeRouteBudget(resourceBudget);
  const action = normalizeMovementAction(movementAction, tokenDocument);
  const routeOrigin = copyTokenPosition(tokenDocument, origin);
  if (origin && !sameTokenPosition(routeOrigin, copyTokenPosition(tokenDocument), tokenDocument)) {
    return { cancelled: false, failed: true, reason: "nativePlanningOriginUnavailable" };
  }

  if (typeof planAuthority.authorize === "function") {
    const authorized = await planAuthority.authorize({
      token: tokenObject,
      tokenDocument,
      origin: copyWaypoint(routeOrigin),
      maxBudget: normalizedMaxBudget,
      budgetMode: normalizedBudgetMode,
      movementAction: action,
      autoRotate: Boolean(autoRotate),
      showRuler: Boolean(showRuler)
    });
    if (!authorized) return { cancelled: false, failed: true, reason: "movementAuthorityUnavailable" };
  }

  const userId = String(game?.user?.id ?? "");
  const targetSelectionSession = startCanvasTargetSelectionSession({
    kind: "movementRoute",
    token,
    title,
    maxBudget: normalizedMaxBudget,
    budgetMode: normalizedBudgetMode,
    ...sessionContext
  });
  let nativePlan = null;
  let authorityPlan = null;
  let commitPromise = null;
  let retained = false;
  let outcome = null;

  setAbilityRoutePreviewBudget(tokenObject, {
    mode: normalizedBudgetMode,
    total: normalizedMaxBudget,
    used: 0,
    resourceTotal: normalizedBudgetMode === ABILITY_ROUTE_BUDGET_MODES.distance
      ? normalizedResourceBudget
      : Infinity,
    resourceUsed: 0,
    interactive: true,
    userId
  });

  const onKeyDown = event => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    void tokenObject.completeAbilityRoutePlanning?.();
  };
  const rightClickGuard = createRightClickPanGuard({
    isCanvasEvent: isAbilityRouteCanvasPointerEvent,
    onClick: () => {
      if (!tokenObject.isDragged || !isAbilityRoutePlanningInteractive(tokenObject)) return;
      tokenObject._removeDragWaypoint?.();
    }
  });
  const onPointerDown = event => {
    if (!isAbilityRouteCanvasPointerEvent(event)) return;
    if (!tokenObject.isDragged || !isAbilityRoutePlanningInteractive(tokenObject)) return;
    if (event.button === 2) {
      // Track only; Foundry's ability-route _onDragClickRight is a no-op so the
      // canvas can pan. Short clicks confirm undo via the pan guard.
      rightClickGuard.onPointerDown(event);
      return;
    }
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    const point = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
    tokenObject._addDragWaypoint(point, { snap: !event.shiftKey });
    canvas.mouseInteractionManager?.cancel?.();
    // A click that spends the exact remaining budget is the final destination:
    // confirm immediately instead of requiring a separate Enter.
    void maybeAutoCompleteAbilityRouteAtExactBudget(tokenObject);
  };
  window.addEventListener("keydown", onKeyDown, { capture: true });
  document.addEventListener("pointerdown", onPointerDown, { capture: true });
  rightClickGuard.activate();

  const commitPlan = ({ options = {} } = {}) => {
    if (commitPromise) return commitPromise;
    commitPromise = (async () => {
      const movement = options?.movement?.[tokenDocument.id];
      const plannedResult = tokenObject.layer?._movementPlanningContext?.result;
      const nativePlanId = String(movement?.id ?? plannedResult?.id ?? "").trim();
      const nativeWaypoints = Array.isArray(movement?.waypoints) && movement.waypoints.length
        ? movement.waypoints
        : (Array.isArray(plannedResult?.waypoints) ? plannedResult.waypoints : []);
      const explicitWaypoints = extractExplicitRouteCheckpoints(nativeWaypoints);
      if (!nativePlanId || !explicitWaypoints.length) {
        return false;
      }
      const retainedPlan = await planAuthority.retain({
        token: tokenObject,
        tokenDocument,
        nativePlanId,
        origin: copyWaypoint(routeOrigin),
        explicitWaypoints,
        maxBudget: normalizedMaxBudget,
        budgetMode: normalizedBudgetMode,
        movementAction: action,
        autoRotate: Boolean(autoRotate),
        showRuler: Boolean(showRuler)
      });
      if (!retainedPlan) return false;
      authorityPlan = retainedPlan?.plan ?? retainedPlan;
      return true;
    })();
    return commitPromise;
  };
  setAbilityRoutePlanCommitter(tokenObject, commitPlan);

  try {
    ui?.notifications?.info?.(
      `${title}: маршрут уже привязан к курсору; ЛКМ добавляет точку (на точном максимуме бюджета сразу подтверждает), Enter завершает, ПКМ снимает последнюю точку.`
    );
    const planning = tokenObject.planAbilityMovement({
      allowedActions: [action],
      // Do not truncate an over-budget route. The native TokenRuler remains
      // visible, the counter marks the overuse, and Enter refuses to confirm.
      maxCost: Infinity,
      maxDistance: Infinity,
      preventDrop: false,
      moveOptions: {
        [ABILITY_ROUTE_PREVIEW_MOVEMENT_OPTION]: true,
        autoRotate: Boolean(autoRotate),
        showRuler: Boolean(showRuler)
      }
    });
    if (!(await tokenObject.startMovementPlanningDrag?.())) {
      tokenObject.layer?._cancelMovementPlanning?.();
      await planning;
      outcome = { cancelled: false, failed: true, reason: "movementPlanningStartFailed" };
      return outcome;
    }
    nativePlan = await planning;
    if (commitPromise && !(await commitPromise)) nativePlan = null;
    updateAbilityRoutePreviewBudget(tokenObject, { interactive: false }, userId);
    if (nativePlan && authorityPlan) nativePlan = authorityPlan;

    if (!nativePlan) {
      outcome = { cancelled: true, failed: false, reason: "routeCancelled" };
      return outcome;
    }
    if (
      !nativePlan.id
      || !nativePlan.origin
      || !nativePlan.destination
      || !Array.isArray(nativePlan.waypoints)
      || !nativePlan.waypoints.length
    ) {
      outcome = { cancelled: false, failed: true, reason: "nativeMovementPlanInvalid" };
      return outcome;
    }

    const nativeOrigin = copyWaypoint(nativePlan.origin);
    if (!sameTokenPosition(routeOrigin, nativeOrigin, tokenDocument)) {
      outcome = { cancelled: false, failed: true, reason: "routeOriginChanged" };
      return outcome;
    }
    const nativeWaypoints = nativePlan.waypoints.map(copyResolvedWaypoint);
    const explicitWaypoints = extractExplicitRouteCheckpoints(nativeWaypoints);
    if (
      !explicitWaypoints.length
      || !sameTokenPosition(nativePlan.destination, nativeWaypoints.at(-1), tokenDocument)
    ) {
      outcome = { cancelled: false, failed: true, reason: "nativeMovementPlanInvalid" };
      return outcome;
    }

    const result = await resolveNativeMovementPath(
      tokenObject,
      tokenDocument,
      explicitWaypoints,
      action,
      {
        preview: false,
        origin: nativeOrigin,
        history: Array.isArray(history) ? history : null
      }
    );
    if (!result.ok) {
      notifyRouteValidationFailure(title, result.reason, 0, normalizedMaxBudget, normalizedBudgetMode);
      outcome = { cancelled: false, failed: true, reason: String(result.reason ?? "routePreparationFailed") };
      return outcome;
    }

    const budgetUsed = getResolvedRouteBudgetUsage(result, normalizedBudgetMode);
    if (budgetUsed > normalizedMaxBudget + ROUTE_EPSILON) {
      const reason = normalizedBudgetMode === ABILITY_ROUTE_BUDGET_MODES.distance
        ? "maxDistance"
        : "maxMovementCost";
      notifyRouteValidationFailure(title, reason, budgetUsed, normalizedMaxBudget, normalizedBudgetMode);
      outcome = { cancelled: false, failed: true, reason };
      return outcome;
    }

    retained = true;
    outcome = {
      cancelled: false,
      failed: false,
      reason: "",
      token,
      tokenObject,
      tokenDocument,
      nativePlanId: String(nativePlan?.id ?? ""),
      nativePlan: {
        id: String(nativePlan.id),
        origin: copyWaypoint(nativePlan.origin),
        destination: copyWaypoint(nativePlan.destination),
        waypoints: nativePlan.waypoints.map(copyResolvedWaypoint)
      },
      origin: copyWaypoint(nativePlan.origin),
      destination: copyWaypoint(nativePlan.destination),
      explicitWaypoints: explicitWaypoints.map(copyWaypoint),
      waypoints: nativePlan.waypoints.map(copyResolvedWaypoint),
      distance: result.distance,
      movementCost: result.movementCost,
      budgetUsed,
      maxBudget: normalizedMaxBudget,
      budgetMode: normalizedBudgetMode,
      measurement: result.measurement,
      previewPath: result.previewPath.map(copyResolvedWaypoint),
      movementAction: action
    };
    outcome.releasePlan = typeof planAuthority.release === "function"
      ? () => planAuthority.release({
        token: tokenObject,
        tokenDocument,
        nativePlanId: outcome.nativePlanId
      })
      : null;
    return outcome;
  } catch (error) {
    console.warn("fallout-maw | Native ability movement planning failed", error);
    outcome = { cancelled: false, failed: true, reason: "nativeMovementPlanningFailed" };
    return outcome;
  } finally {
    window.removeEventListener("keydown", onKeyDown, { capture: true });
    document.removeEventListener("pointerdown", onPointerDown, { capture: true });
    rightClickGuard.deactivate();
    clearAbilityRoutePlanCommitter(tokenObject, commitPlan);
    updateAbilityRoutePreviewBudget(tokenObject, { interactive: false }, userId);
    if (!retained) {
      await stopAbilityMovementRoutePreviews([{
        nativePlanId: String(authorityPlan?.id ?? nativePlan?.id ?? ""),
        tokenDocument,
        releasePlan: authorityPlan && typeof planAuthority.release === "function"
          ? () => planAuthority.release({
            token: tokenObject,
            tokenDocument,
            nativePlanId: String(authorityPlan?.id ?? nativePlan?.id ?? "")
          })
          : null
      }]);
    }
    targetSelectionSession.finish({
      cancelled: Boolean(outcome?.cancelled),
      failed: Boolean(outcome?.failed),
      reason: String(outcome?.reason ?? "")
    });
  }
}

/** Stop only the exact native plans retained by this ability preparation. */
export async function stopAbilityMovementRoutePreviews(routes = []) {
  const stopped = new Set();
  for (const route of Array.from(routes ?? [])) {
    const tokenObject = route?.tokenObject ?? route?.token?.object ?? route?.token ?? null;
    const tokenDocument = route?.tokenDocument ?? tokenObject?.document ?? route?.token?.document ?? null;
    clearAbilityRoutePreviewBudget(tokenObject ?? tokenDocument);
    const nativePlanId = String(route?.nativePlanId ?? route?.nativePlan?.id ?? "").trim();
    const tokenUuid = String(tokenDocument?.uuid ?? "").trim();
    const stopKey = tokenUuid || tokenDocument;
    if (!nativePlanId || !tokenDocument || stopped.has(stopKey)) continue;
    if (typeof route?.releasePlan === "function") {
      try {
        if (await route.releasePlan()) stopped.add(stopKey);
      } catch (error) {
        console.warn("fallout-maw | Failed to release retained ability movement plan", error);
      }
      continue;
    }
    const movement = tokenDocument?.movement;
    if (
      String(movement?.id ?? "") !== nativePlanId
      || movement?.state !== "planned"
      || !movement?.user?.isSelf
      || typeof tokenDocument.stopMovement !== "function"
    ) continue;
    stopped.add(stopKey);
    markAbilityRoutePreviewStop(tokenDocument, nativePlanId);
    try {
      await tokenDocument?.stopMovement();
    } catch (error) {
      console.warn("fallout-maw | Failed to clear retained ability movement plan", error);
    } finally {
      clearAbilityRoutePreviewStop(tokenDocument, nativePlanId);
    }
  }
  return stopped.size;
}

/** Resolve Foundry pathfinding, terrain, distance and adjusted movement cost. */
export async function resolveNativeMovementPath(
  tokenObject,
  tokenDocument,
  waypoints = [],
  movementAction = "",
  { preview = false, registerSearch = null, origin = null, history = null } = {}
) {
  const normalizedAction = normalizeMovementAction(movementAction, tokenDocument);
  const routeOrigin = copyTokenPosition(tokenDocument, origin);
  const normalized = [];
  for (const waypoint of Array.isArray(waypoints) ? waypoints : []) {
    const validated = validateExplicitWaypoint(tokenDocument, waypoint, normalizedAction, routeOrigin);
    if (!validated) {
      return { ok: false, reason: "invalidWaypoint", path: [], previewPath: [], distance: 0, movementCost: 0 };
    }
    normalized.push(validated);
  }
  if (!normalized.length) {
    return { ok: false, reason: "emptyRoute", path: [], previewPath: [], distance: 0, movementCost: 0 };
  }
  const explicit = [routeOrigin, ...normalized];
  const nativeOptions = getNativeMovementRouteOptions(tokenObject, { preview, history });
  let path = explicit;
  try {
    if (typeof tokenObject?.findMovementPath === "function") {
      const job = tokenObject.findMovementPath(explicit, nativeOptions.pathfindingOptions);
      const releaseSearch = typeof registerSearch === "function" ? registerSearch(job) : null;
      try {
        path = job?.result ?? await job?.promise;
      } finally {
        releaseSearch?.();
      }
    }
  } catch (error) {
    console.warn("fallout-maw | Native movement path planning failed", error);
    return { ok: false, reason: "pathPlanningFailed", path: [], previewPath: [], distance: 0, movementCost: 0, error };
  }
  if (!Array.isArray(path) || path.length < 2) {
    return { ok: false, reason: "unreachable", path: path ?? [], previewPath: [], distance: 0, movementCost: 0 };
  }
  if (!pathReachesExplicitWaypoints(explicit, path, tokenDocument)) {
    return { ok: false, reason: "unreachable", path, previewPath: [], distance: 0, movementCost: 0 };
  }

  let previewPath;
  let measurement;
  let movementCost;
  try {
    previewPath = path.map(copyResolvedWaypoint);
    if (typeof tokenObject?.createTerrainMovementPath === "function") {
      previewPath = tokenObject.createTerrainMovementPath(previewPath, {
        ...nativeOptions.terrainOptions,
        preview
      });
    }
    if (typeof tokenDocument?.getCompleteMovementPath === "function") {
      previewPath = tokenDocument.getCompleteMovementPath(previewPath);
    }
    measurement = typeof tokenObject?.measureMovementPath === "function"
      ? tokenObject.measureMovementPath(previewPath, { ...nativeOptions.measureOptions, preview })
      : tokenDocument.measureMovementPath(previewPath, nativeOptions.measureOptions);
    movementCost = measureTheoreticalMovementPathCost(tokenDocument, previewPath, {
      preview,
      measureOptions: nativeOptions.measureOptions,
      history
    });
  } catch (error) {
    console.warn("fallout-maw | Native movement path measurement failed", error);
    return { ok: false, reason: "measurementFailed", path, previewPath: [], distance: 0, movementCost: 0, error };
  }
  const distance = Number(measurement?.distance ?? measurement?.waypoints?.at(-1)?.distance ?? 0);
  if (!Number.isFinite(distance) || distance < 0 || !Number.isFinite(movementCost) || movementCost < 0) {
    return { ok: false, reason: "measurementFailed", path, previewPath, distance: 0, movementCost: 0 };
  }
  return {
    ok: true,
    path: path.map(copyResolvedWaypoint),
    previewPath: previewPath.map(copyResolvedWaypoint),
    measurement,
    distance,
    movementCost,
    movementAction: normalizedAction
  };
}

/** Use the same protected extension hooks as Foundry's native drag workflow. */
export function getNativeMovementRouteOptions(tokenObject, { preview = false, history = null } = {}) {
  const terrainOptions = clonePlainOptions(tokenObject?._getDragTerrainOptions?.());
  const constrainOptions = clonePlainOptions(tokenObject?._getDragConstrainOptions?.());
  const measureOptions = clonePlainOptions(tokenObject?._getDragMeasureOptions?.());
  const pathfindingOptions = clonePlainOptions(tokenObject?._getDragPathfindingOptions?.());
  if (Array.isArray(history)) constrainOptions.history = history.map(copyResolvedWaypoint);
  if (!preview) delete pathfindingOptions.delay;
  Object.assign(pathfindingOptions, {
    preview,
    terrainOptions,
    constrainOptions,
    measureOptions
  });
  return { terrainOptions, constrainOptions, measureOptions, pathfindingOptions };
}

function clonePlainOptions(value) {
  if (!value || typeof value !== "object") return {};
  return globalThis.foundry?.utils?.deepClone?.(value) ?? { ...value };
}

export function getResolvedRouteBudgetUsage(result = {}, mode = ABILITY_ROUTE_BUDGET_MODES.movementCost) {
  return normalizeRouteBudgetMode(mode) === ABILITY_ROUTE_BUDGET_MODES.distance
    ? Math.max(0, Number(result?.distance) || 0)
    : Math.max(0, Number(result?.movementCost) || 0);
}

function normalizeRouteBudgetMode(value) {
  return value === ABILITY_ROUTE_BUDGET_MODES.distance
    ? ABILITY_ROUTE_BUDGET_MODES.distance
    : ABILITY_ROUTE_BUDGET_MODES.movementCost;
}

function normalizeRouteBudget(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : Infinity;
}

function normalizeMovementAction(value, tokenDocument) {
  const current = String(tokenDocument?.movementAction ?? "walk");
  const action = String(value ?? "").trim() || current;
  if (globalThis.CONFIG?.Token?.movement?.actions && !(action in CONFIG.Token.movement.actions)) {
    ui?.notifications?.warn?.(`Режим перемещения «${action}» недоступен; используется текущий режим.`);
    return current;
  }
  return action;
}

function isNativeMovementBusy(tokenDocument) {
  return ACTIVE_MOVEMENT_STATES.has(String(tokenDocument?.movement?.state ?? ""));
}

function copyTokenPosition(tokenDocument, override = null) {
  const source = tokenDocument?._source ?? tokenDocument ?? {};
  return copyWaypoint({
    x: finiteOr(override?.x, finiteOr(source.x, 0)),
    y: finiteOr(override?.y, finiteOr(source.y, 0)),
    elevation: finiteOr(override?.elevation, finiteOr(source.elevation, 0)),
    width: finiteOr(override?.width, finiteOr(source.width, 1)),
    height: finiteOr(override?.height, finiteOr(source.height, 1)),
    depth: finiteOr(override?.depth, finiteOr(source.depth, 1)),
    shape: override?.shape ?? source.shape,
    level: override?.level ?? source.level,
    action: source.action ?? tokenDocument?.movementAction,
    snapped: false,
    explicit: false,
    checkpoint: true
  });
}

function validateExplicitWaypoint(tokenDocument, waypoint = {}, movementAction = "", origin = {}) {
  const candidate = copyWaypoint(waypoint);
  if (!Number.isInteger(candidate.x) || !Number.isInteger(candidate.y)) return null;
  if (!Number.isFinite(candidate.elevation)) return null;
  if (!Number.isFinite(candidate.width) || candidate.width <= 0) return null;
  if (!Number.isFinite(candidate.height) || candidate.height <= 0) return null;
  if (!Number.isFinite(candidate.depth) || candidate.depth < 0) return null;
  if (candidate.action !== movementAction) return null;
  if (candidate.snapped !== true && candidate.snapped !== false) return null;
  if (candidate.explicit !== true || candidate.checkpoint !== true) return null;

  // This action moves a token but does not resize it or transfer it between
  // scene levels. Those capabilities must be enabled by their own construct.
  for (const field of ["width", "height", "depth", "shape", "level"]) {
    if (candidate[field] !== origin[field]) return null;
  }
  if (candidate.snapped && !canvas.grid?.isGridless && typeof tokenDocument?.getSnappedPosition === "function") {
    const snapped = tokenDocument.getSnappedPosition(candidate);
    if (Number(snapped?.x) !== candidate.x || Number(snapped?.y) !== candidate.y) return null;
  }
  return candidate;
}

function copyWaypoint(waypoint = {}) {
  const result = {};
  for (const key of MOVEMENT_WAYPOINT_FIELDS) {
    if (waypoint?.[key] !== undefined) result[key] = waypoint[key];
  }
  return result;
}

function copyResolvedWaypoint(waypoint = {}) {
  return { ...waypoint };
}

function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function notifyRouteValidationFailure(title, reason, used, maxBudget, budgetMode) {
  if (["maxDistance", "maxMovementCost"].includes(reason)) {
    const unit = budgetMode === ABILITY_ROUTE_BUDGET_MODES.distance
      ? String(canvas?.grid?.units ?? "ед. сцены")
      : "ОП";
    ui?.notifications?.warn?.(
      `${title}: маршрут превышает бюджет (${formatNumber(used)} > ${formatNumber(maxBudget)} ${unit}).`
    );
    return;
  }
  const messages = {
    unreachable: "точка недоступна по правилам перемещения",
    pathPlanningFailed: "не удалось построить путь",
    measurementFailed: "не удалось измерить путь",
    invalidWaypoint: "точки маршрута не прошли проверку Foundry",
    emptyRoute: "маршрут пуст"
  };
  ui?.notifications?.warn?.(`${title}: ${messages[reason] ?? "маршрут недействителен"}.`);
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "∞";
  return Number(number.toFixed(2)).toLocaleString(game?.i18n?.lang);
}

function sameTokenPosition(a = {}, b = {}, tokenDocument = null) {
  const compare = tokenDocument?.constructor?.arePositionsEqual;
  if (typeof compare === "function") return Boolean(compare.call(tokenDocument.constructor, a, b));
  return MOVEMENT_POSITION_FIELDS.every(field => a?.[field] === b?.[field]);
}

function pathReachesExplicitWaypoints(explicit = [], path = [], tokenDocument = null) {
  let requestedIndex = 0;
  for (const waypoint of path) {
    const requested = explicit[requestedIndex];
    if (!sameTokenPosition(requested, waypoint, tokenDocument)) continue;
    if (
      requested?.action !== waypoint?.action
      || requested?.snapped !== waypoint?.snapped
      || requested?.explicit !== waypoint?.explicit
      || requested?.checkpoint !== waypoint?.checkpoint
    ) continue;
    requestedIndex += 1;
    if (requestedIndex >= explicit.length) return true;
  }
  return requestedIndex >= explicit.length;
}

function isAbilityRouteCanvasPointerEvent(event) {
  const view = canvas?.app?.view;
  if (!view || !event) return false;
  return event.target === view || Array.from(event.composedPath?.() ?? []).includes(view);
}

/** True only when the live preview spends the entire configured budget (not under, not over). */
function isAbilityRoutePreviewAtExactBudget(preview) {
  if (!preview || preview.invalid || preview.searching) return false;
  const used = Number(preview.used);
  const total = Number(preview.total);
  if (!Number.isFinite(used) || !Number.isFinite(total) || !(total > 0)) return false;
  if (Math.abs(used - total) > ROUTE_EPSILON) return false;
  const resourceUsed = Number(preview.resourceUsed);
  const resourceTotal = Number(preview.resourceTotal);
  if (
    Number.isFinite(resourceUsed)
    && Number.isFinite(resourceTotal)
    && resourceUsed > resourceTotal + ROUTE_EPSILON
  ) return false;
  return true;
}

/**
 * After an LKM checkpoint, wait for pathfinding and auto-confirm when the click
 * spends exactly the remaining ability-route budget.
 */
async function maybeAutoCompleteAbilityRouteAtExactBudget(tokenObject) {
  if (!tokenObject?.isDragged || !isAbilityRoutePlanningInteractive(tokenObject)) return false;
  const startedAt = Date.now();
  while ((Date.now() - startedAt) < ABILITY_ROUTE_PATH_READY_TIMEOUT_MS) {
    const preview = getAbilityRoutePreviewBudget(tokenObject);
    if (preview && !preview.searching) {
      const exact = isAbilityRoutePreviewAtExactBudget(preview);
      if (!exact) return false;
      const completed = Boolean(await tokenObject.completeAbilityRoutePlanning?.());
      return completed;
    }
    await new Promise(resolve => globalThis.setTimeout(resolve, ABILITY_ROUTE_PATH_READY_POLL_MS));
  }
  return false;
}

/**
 * Keep user-planted checkpoints and always treat the terminal destination as one.
 * Foundry pathfinding can strip explicit/checkpoint flags from intermediate cells.
 */
function extractExplicitRouteCheckpoints(waypoints = []) {
  const normalized = Array.isArray(waypoints) ? waypoints.filter(Boolean) : [];
  if (!normalized.length) return [];
  const explicit = normalized
    .filter(waypoint => waypoint?.explicit === true && waypoint?.checkpoint === true)
    .map(copyWaypoint);
  if (explicit.length) return explicit;
  const destination = copyWaypoint(normalized.at(-1));
  destination.explicit = true;
  destination.checkpoint = true;
  return [destination];
}
