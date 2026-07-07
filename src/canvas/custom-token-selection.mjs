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
    layer.addChild(graphics);
    drawCustomTokenSelectionRows(graphics, normalizedRows, selected);

    const prompt = instructions || `${title}: выберите до ${selectionLimit} целей. Enter подтверждает, Esc отменяет.`;
    ui.notifications.info(prompt);

    const cleanup = () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      document.removeEventListener("pointerdown", onPointerDown, { capture: true });
      graphics.destroy();
    };
    const finish = value => {
      cleanup();
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
    const onKeyDown = event => {
      if (event.key !== "Escape" && event.key !== "Enter") return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      if (event.key === "Escape") finish([]);
      else confirm();
    };
    const onPointerDown = event => {
      if (event.button !== 0) return;
      if (!isCanvasViewEvent(event)) return;
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
      if (selected.size >= selectionLimit) confirm();
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    document.addEventListener("pointerdown", onPointerDown, { capture: true });
  });
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
