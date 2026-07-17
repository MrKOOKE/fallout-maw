import { canTokenPhysicallySeeTarget } from "../combat/weapon-attack-controller.mjs";
import { startCanvasTargetSelectionSession } from "./target-selection-lifecycle.mjs";

const RIGHT_CLICK_CANCEL_DISTANCE_PX = 10;

export function requestCustomTokenSelection({
  rows = [],
  limit = 1,
  title = "Выбор целей",
  noneWarning = "Нет подходящих целей.",
  instructions = "",
  getRowId = row => String(row?.actorUuid ?? row?.token?.actor?.uuid ?? ""),
  getRowLabel = row => String(row?.token?.name ?? row?.token?.actor?.name ?? "Цель")
} = {}) {
  const normalizedRows = (Array.isArray(rows) ? rows : [])
    .filter(row => row?.token)
    .map(row => ({ ...row, selectionId: getRowId(row) }))
    .filter(row => row.selectionId);
  const selectable = normalizedRows.filter(row => row.selectable);
  const selectionLimit = Math.max(1, Math.floor(Number(limit) || 1));
  if (!selectable.length) {
    ui.notifications.warn(noneWarning);
    return Promise.resolve([]);
  }

  return new Promise(resolve => {
    const layer = getCustomTokenSelectionLayer();
    const graphics = new PIXI.Graphics();
    const selected = new Set();
    const canvasView = canvas.app?.view ?? null;
    const previousViewContextMenu = canvasView?.oncontextmenu ?? null;
    layer.addChild(graphics);
    drawCustomTokenSelectionRows(graphics, normalizedRows, selected);

    const targetSelectionSession = startCanvasTargetSelectionSession({
      kind: "tokens",
      rows: normalizedRows,
      selectable,
      limit: selectionLimit,
      title,
      instructions
    });

    const prompt = instructions || `${title}: выберите до ${selectionLimit} целей. ЛКМ на последней цели сразу подтверждает, Enter тоже, ПКМ снимает последнюю цель, Esc отменяет.`;
    ui.notifications.info(prompt);

    let finished = false;
    let rightClickCandidate = null;
    const cleanup = () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("mousemove", onMouseMove, { capture: true });
      document.removeEventListener("pointerdown", onPointerDown, { capture: true });
      document.removeEventListener("pointermove", onPointerMove, { capture: true });
      canvas.stage?.off?.("mousemove", onCanvasMouseMove);
      if (canvasView && canvasView.oncontextmenu === onContextMenu) {
        canvasView.oncontextmenu = previousViewContextMenu;
      }
      graphics.destroy();
    };
    const finish = value => {
      if (finished) return;
      finished = true;
      cleanup();
      targetSelectionSession.finish({
        cancelled: !Array.isArray(value) || !value.length
      });
      resolve(value);
    };
    const getSelection = () => {
      const seen = new Set();
      return normalizedRows.filter(row => {
        if (!selected.has(row.selectionId) || seen.has(row.selectionId)) return false;
        seen.add(row.selectionId);
        return true;
      });
    };
    const confirm = () => {
      const selection = getSelection();
      if (!selection.length) return;
      finish(selection);
    };
    const undoLastSelection = () => {
      const selectionId = Array.from(selected).at(-1);
      if (!selectionId) return false;
      selected.delete(selectionId);
      drawCustomTokenSelectionRows(graphics, normalizedRows, selected);
      return true;
    };
    const onKeyDown = event => {
      if (event.key !== "Escape" && event.key !== "Enter") return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      if (event.key === "Escape") finish([]);
      else confirm();
    };
    const onPointerDown = event => {
      if (!isCanvasViewEvent(event)) return;
      if (event.button === 2) {
        rightClickCandidate = {
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          dragged: false
        };
        return;
      }
      if (event.button !== 0) return;
      const point = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
      const row = getCustomTokenSelectionRowAtPoint(normalizedRows, point);
      if (!row) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      if (!row.selectable) {
        if (row.reason) ui.notifications.warn(`${getRowLabel(row)}: ${row.reason}`);
        return;
      }
      if (selected.has(row.selectionId)) selected.delete(row.selectionId);
      else if (selected.size < selectionLimit) selected.add(row.selectionId);
      drawCustomTokenSelectionRows(graphics, normalizedRows, selected);
      // Filling the last slot is the commit click — same as commanded attacks.
      if (selected.size >= selectionLimit) confirm();
    };
    const onPointerMove = event => {
      if (!rightClickCandidate || event.pointerId !== rightClickCandidate.pointerId) return;
      updateRightClickDragCandidate(event);
    };
    const onMouseMove = event => {
      if (!rightClickCandidate || !(event.buttons & 2)) return;
      updateRightClickDragCandidate(event);
    };
    const onCanvasMouseMove = event => {
      if (!rightClickCandidate) return;
      updateRightClickDragCandidate(getClientPointFromCanvasEvent(event));
    };
    const onContextMenu = event => {
      if (!isCanvasViewEvent(event)) return;
      if (isRightClickDragRelease(event)) {
        rightClickCandidate = null;
        if (typeof previousViewContextMenu === "function") return previousViewContextMenu.call(canvasView, event);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      rightClickCandidate = null;
      if (undoLastSelection()) return;
      finish([]);
    };
    const updateRightClickDragCandidate = event => {
      if (!rightClickCandidate) return;
      if (getPointerDistance(event, rightClickCandidate) >= getFoundryDragResistance()) {
        rightClickCandidate.dragged = true;
      }
    };
    const isRightClickDragRelease = event => {
      if (canvas.mouseInteractionManager?._dragRight && canvas.mouseInteractionManager?.state >= 4) return true;
      if (!rightClickCandidate) return false;
      return rightClickCandidate.dragged || getPointerDistance(event, rightClickCandidate) >= getFoundryDragResistance();
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("mousemove", onMouseMove, { capture: true });
    document.addEventListener("pointerdown", onPointerDown, { capture: true });
    document.addEventListener("pointermove", onPointerMove, { capture: true });
    canvas.stage?.on?.("mousemove", onCanvasMouseMove);
    if (canvasView) canvasView.oncontextmenu = onContextMenu;
  });
}

function getPointerDistance(event, origin = {}) {
  return Math.hypot(
    (Number(event?.clientX) || 0) - (Number(origin.x) || 0),
    (Number(event?.clientY) || 0) - (Number(origin.y) || 0)
  );
}

function getFoundryDragResistance() {
  return Math.max(1, Number(foundry.canvas?.interaction?.MouseInteractionManager?.DEFAULT_DRAG_RESISTANCE_PX) || RIGHT_CLICK_CANCEL_DISTANCE_PX);
}

function getClientPointFromCanvasEvent(event) {
  return {
    clientX: Number(event?.clientX ?? event?.client?.x ?? event?.nativeEvent?.clientX) || 0,
    clientY: Number(event?.clientY ?? event?.client?.y ?? event?.nativeEvent?.clientY) || 0
  };
}

export async function requestCustomActorTokenSelection({
  sourceActor = null,
  sourceToken = null,
  includeSelf = true,
  title = "Выбор цели",
  noneWarning = "Нет подходящих целей.",
  instructions = "",
  getReason = null
} = {}) {
  const sourceActorUuid = String(sourceActor?.uuid ?? "");
  const rows = getCanvasActorSelectionTokens(sourceToken)
    .filter(token => isActorSelectionTokenVisibleToSource(token, sourceToken, sourceActorUuid))
    .map(token => {
      const actor = token?.actor ?? token?.document?.actor ?? null;
      const actorUuid = String(actor?.uuid ?? "");
      const isSelf = Boolean(sourceActorUuid && actorUuid === sourceActorUuid);
      const reason = !actor
        ? "У токена нет актера."
        : (!includeSelf && isSelf ? "Нужна другая цель." : String(getReason?.({ token, actor, isSelf }) ?? ""));
      return {
        token,
        actor,
        actorUuid,
        selectable: Boolean(actor && !reason),
        reason
      };
    });

  const selected = await requestCustomTokenSelection({
    rows,
    limit: 1,
    title,
    noneWarning,
    instructions,
    getRowId: row => String(row?.token?.document?.uuid ?? row?.token?.id ?? row?.actorUuid ?? ""),
    getRowLabel: row => String(row?.token?.name ?? row?.actor?.name ?? "Цель")
  });
  return selected.at(0) ?? null;
}

function getCanvasActorSelectionTokens(sourceToken = null) {
  const tokens = [];
  const seen = new Set();
  const addToken = token => {
    if (!token) return;
    const id = String(token?.document?.uuid ?? token?.id ?? token?.uuid ?? "");
    if (id && seen.has(id)) return;
    if (id) seen.add(id);
    tokens.push(token);
  };

  for (const token of canvas?.tokens?.placeables ?? []) addToken(token);
  addToken(sourceToken?.object ?? sourceToken);
  return tokens;
}

function isActorSelectionTokenVisibleToSource(token = null, sourceToken = null, sourceActorUuid = "") {
  if (!token?.actor && !token?.document?.actor) return false;
  if (token.visible === false || token.renderable === false) return false;
  const actorUuid = String((token.actor ?? token.document?.actor)?.uuid ?? "");
  if (sourceActorUuid && actorUuid === sourceActorUuid) return true;

  const sourceObject = getTokenObjectForActorSelection(sourceToken, { requireSight: true });
  const targetObject = getTokenObjectForActorSelection(token);
  if (!sourceObject) return true;
  if (sourceObject === targetObject) return true;
  return canTokenPhysicallySeeTarget(sourceObject, targetObject);
}

function getTokenObjectForActorSelection(token = null, { requireSight = false } = {}) {
  const object = token?.object ?? token;
  if (!object) return null;
  if (requireSight && typeof object._getVisionSourceData !== "function") return null;
  return object;
}

function drawCustomTokenSelectionRows(graphics, rows = [], selected = new Set()) {
  graphics.clear();
  for (const row of rows) {
    const rect = getTokenRect(row.token);
    const selectedRow = selected.has(row.selectionId);
    const color = row.selectable ? 0x36d06f : 0xd64b4b;
    const lineWidth = selectedRow ? 5 : 3;
    const alpha = selectedRow ? 0.28 : 0.14;
    graphics.lineStyle(lineWidth, color, 0.95);
    graphics.beginFill(color, alpha);
    graphics.drawRect(rect.x, rect.y, rect.width, rect.height);
    graphics.endFill();
  }
}

function getCustomTokenSelectionRowAtPoint(rows = [], point = null) {
  return rows
    .slice()
    .reverse()
    .find(row => isPointInToken(point, row.token)) ?? null;
}

function isPointInToken(point, token) {
  const rect = getTokenRect(token);
  return point
    && point.x >= rect.x
    && point.x <= rect.x + rect.width
    && point.y >= rect.y
    && point.y <= rect.y + rect.height;
}

function getTokenRect(token) {
  const document = token?.document ?? token;
  const size = document?.getSize?.() ?? {
    width: Math.max(1, Number(document?.width) || 1) * canvas.grid.size,
    height: Math.max(1, Number(document?.height) || 1) * canvas.grid.size
  };
  return {
    x: Number(document?.x ?? token?.x) || 0,
    y: Number(document?.y ?? token?.y) || 0,
    width: Math.max(1, Number(size.width) || canvas.grid.size),
    height: Math.max(1, Number(size.height) || canvas.grid.size)
  };
}

function getCustomTokenSelectionLayer() {
  return canvas.controls?._rulerPaths ?? canvas.tokens;
}

function isCanvasViewEvent(event) {
  const view = canvas.app?.view;
  if (!view) return false;
  return event.target === view || Array.from(event.composedPath?.() ?? []).includes(view);
}
