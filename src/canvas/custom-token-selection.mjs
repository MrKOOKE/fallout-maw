import { canTokenPhysicallySeeTarget } from "./physical-los.mjs";
import { createRightClickPanGuard } from "./right-click-pan-guard.mjs";
import { startCanvasTargetSelectionSession } from "./target-selection-lifecycle.mjs";

export function requestCustomTokenSelection({
  rows = [],
  limit = 1,
  allowRepeated = false,
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
    const selected = [];
    layer.addChild(graphics);
    drawCustomTokenSelectionRows(graphics, normalizedRows, new Set(selected));

    const targetSelectionSession = startCanvasTargetSelectionSession({
      kind: "tokens",
      rows: normalizedRows,
      selectable,
      limit: selectionLimit,
      allowRepeated: Boolean(allowRepeated),
      title,
      instructions
    });

    const prompt = instructions || `${title}: выберите до ${selectionLimit} целей. ЛКМ на последней цели сразу подтверждает, Enter тоже, ПКМ снимает последнюю цель, Esc отменяет.`;
    ui.notifications.info(prompt);

    let finished = false;
    const cleanup = () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      document.removeEventListener("pointerdown", onPointerDown, { capture: true });
      rightClickGuard.deactivate();
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
    const rowsById = new Map(normalizedRows.map(row => [row.selectionId, row]));
    const getSelection = () => selected.map(selectionId => rowsById.get(selectionId)).filter(Boolean);
    const confirm = () => {
      const selection = getSelection();
      if (!selection.length) return;
      finish(selection);
    };
    const undoLastSelection = () => {
      const selectionId = selected.at(-1);
      if (!selectionId) return false;
      selected.pop();
      drawCustomTokenSelectionRows(graphics, normalizedRows, new Set(selected));
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
    const rightClickGuard = createRightClickPanGuard({
      isCanvasEvent: isCanvasViewEvent,
      onClick: () => {
        if (undoLastSelection()) return;
        finish([]);
      }
    });
    const onPointerDown = event => {
      if (!isCanvasViewEvent(event)) return;
      if (event.button === 2) {
        rightClickGuard.onPointerDown(event);
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
      const selectedIndex = selected.indexOf(row.selectionId);
      if (!allowRepeated && selectedIndex >= 0) selected.splice(selectedIndex, 1);
      else if (selected.length < selectionLimit) selected.push(row.selectionId);
      drawCustomTokenSelectionRows(graphics, normalizedRows, new Set(selected));
      // Filling the last slot is the commit click — same as commanded attacks.
      if (selected.length >= selectionLimit) confirm();
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    document.addEventListener("pointerdown", onPointerDown, { capture: true });
    rightClickGuard.activate();
  });
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
