import { testObserverVisibilityBatch } from "./physical-los.mjs";
import { createRightClickPanGuard } from "./right-click-pan-guard.mjs";
import {
  cancelActiveCanvasTargetSelection,
  startCanvasTargetSelectionSession
} from "./target-selection-lifecycle.mjs";
import { changedDataIntersectsPaths } from "../utils/document-change-paths.mjs";

const TARGET_SELECTION_REFRESH_DELAY_MS = 50;
const TOKEN_TARGET_PATHS = [
  "x",
  "y",
  "elevation",
  "width",
  "height",
  "depth",
  "hidden",
  "actorId",
  "actorLink",
  "sight",
  "detectionModes",
  "texture.scaleX",
  "texture.scaleY"
];
const SCENE_TARGET_PATHS = ["darkness", "environment", "globalLight", "grid", "tokenVision"];

export function requestCustomTokenSelection({
  rows = [],
  limit = 1,
  allowRepeated = false,
  title = "Выбор целей",
  noneWarning = "Нет подходящих целей.",
  instructions = "",
  sourceToken = null,
  refreshRows = null,
  getRowId = row => String(row?.actorUuid ?? row?.token?.actor?.uuid ?? ""),
  getRowLabel = row => String(row?.token?.name ?? row?.token?.actor?.name ?? "Цель")
} = {}) {
  // An invocation is itself an ownership change, even when it cannot offer a
  // target. Otherwise the previous selector remains painted and interactive.
  cancelActiveCanvasTargetSelection({
    reason: "superseded"
  });
  let normalizedRows = normalizeSelectionRows(rows, getRowId);
  const selectable = normalizedRows.filter(row => row.selectable && row.displayed !== false);
  const selectionLimit = Math.max(1, Math.floor(Number(limit) || 1));
  if (!selectable.length) {
    ui.notifications.warn(noneWarning);
    return Promise.resolve([]);
  }

  return new Promise(resolve => {
    const layer = getCustomTokenSelectionLayer();
    if (!layer?.addChild) {
      ui.notifications.warn(`${title}: слой выбора целей недоступен.`);
      resolve([]);
      return;
    }

    const overlay = new PIXI.Container();
    overlay.eventMode = "none";
    overlay.interactiveChildren = false;
    overlay.zIndex = Number.MAX_SAFE_INTEGER;
    const graphicsByRowId = new Map();
    const selected = [];
    let rowsById = new Map();
    let rowIdsByTokenUuid = new Map();
    let targetSelectionSession = null;
    let finished = false;
    let refreshTimerId = null;
    let pendingFullRefresh = false;
    const pendingChangedTokens = new Map();
    const pendingRemovedTokenUuids = new Set();
    const hookBindings = [];

    const rebuildRowIndexes = () => {
      rowsById = new Map(normalizedRows.map(row => [row.selectionId, row]));
      rowIdsByTokenUuid = new Map();
      for (const row of normalizedRows) {
        const tokenUuid = getTokenDocumentUuid(row.token);
        if (!tokenUuid) continue;
        const ids = rowIdsByTokenUuid.get(tokenUuid) ?? new Set();
        ids.add(row.selectionId);
        rowIdsByTokenUuid.set(tokenUuid, ids);
      }
      for (let index = selected.length - 1; index >= 0; index -= 1) {
        const row = rowsById.get(selected[index]);
        if (!row?.selectable || row.displayed === false) selected.splice(index, 1);
      }
    };

    const setRows = nextRows => {
      normalizedRows = normalizeSelectionRows(nextRows, getRowId);
      rebuildRowIndexes();
      syncCustomTokenSelectionGraphics(
        overlay,
        graphicsByRowId,
        normalizedRows,
        new Set(selected)
      );
    };

    const cleanup = () => {
      if (refreshTimerId !== null) globalThis.clearTimeout(refreshTimerId);
      refreshTimerId = null;
      pendingChangedTokens.clear();
      pendingRemovedTokenUuids.clear();
      pendingFullRefresh = false;
      for (const [hook, id] of hookBindings.splice(0)) Hooks.off(hook, id);
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      document.removeEventListener("pointerdown", onPointerDown, { capture: true });
      rightClickGuard.deactivate();
      overlay.parent?.removeChild?.(overlay);
      if (!overlay.destroyed) overlay.destroy({ children: true });
      graphicsByRowId.clear();
    };

    const finish = (value, { fromLifecycle = false } = {}) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (!fromLifecycle) {
        targetSelectionSession?.finish({
          cancelled: !Array.isArray(value) || !value.length
        });
      }
      resolve(value);
    };

    const getSelection = () => selected
      .map(selectionId => rowsById.get(selectionId))
      .filter(row => row?.selectable && row.displayed !== false);

    const confirm = () => {
      const selection = getSelection();
      if (!selection.length) return;
      finish(selection);
    };

    const undoLastSelection = () => {
      const selectionId = selected.at(-1);
      if (!selectionId) return false;
      selected.pop();
      syncCustomTokenSelectionRowGraphic(
        overlay,
        graphicsByRowId,
        rowsById.get(selectionId),
        selected.includes(selectionId)
      );
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
      // A click is a commit boundary. Never resolve it against a row whose
      // range/LOS/status refresh is still waiting in the coalescing window.
      if (refreshTimerId !== null || pendingFullRefresh || pendingChangedTokens.size || pendingRemovedTokenUuids.size) {
        flushDynamicRows();
      }
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
      syncCustomTokenSelectionRowGraphic(
        overlay,
        graphicsByRowId,
        row,
        selected.includes(row.selectionId)
      );
      // Filling the last slot is the commit click — same as commanded attacks.
      if (selected.length >= selectionLimit) confirm();
    };

    const flushDynamicRows = () => {
      if (refreshTimerId !== null) globalThis.clearTimeout(refreshTimerId);
      refreshTimerId = null;
      if (finished) return;
      const changedTokens = Array.from(pendingChangedTokens.values());
      const removedTokenUuids = Array.from(pendingRemovedTokenUuids);
      const full = pendingFullRefresh;
      pendingChangedTokens.clear();
      pendingRemovedTokenUuids.clear();
      pendingFullRefresh = false;

      let nextRows = normalizedRows;
      if (typeof refreshRows === "function") {
        try {
          const refreshed = refreshRows({
            rows: normalizedRows,
            sourceToken,
            changedTokens,
            removedTokenUuids,
            full
          });
          if (Array.isArray(refreshed)) nextRows = refreshed;
        } catch (error) {
          console.error("fallout-maw | Canvas target-selection refresh failed", error);
        }
      } else {
        nextRows = refreshDefaultSelectionRows(normalizedRows, {
          changedTokens,
          removedTokenUuids
        });
      }
      setRows(nextRows);
    };

    const scheduleDynamicRows = ({
      token = null,
      tokenUuid = "",
      full = false,
      removed = false,
      immediate = false
    } = {}) => {
      if (finished) return;
      const uuid = String(tokenUuid || getTokenDocumentUuid(token)).trim();
      if (full) pendingFullRefresh = true;
      if (uuid) {
        if (removed) {
          pendingChangedTokens.delete(uuid);
          pendingRemovedTokenUuids.add(uuid);
        } else if (!pendingRemovedTokenUuids.has(uuid) && token) {
          pendingChangedTokens.set(uuid, getTokenObject(token) ?? token);
        }
      }
      if (immediate) {
        flushDynamicRows();
        return;
      }
      // Fixed-window coalescing refreshes during movement instead of postponing
      // semantic eligibility forever while refreshToken fires every frame.
      if (refreshTimerId === null) {
        refreshTimerId = globalThis.setTimeout(flushDynamicRows, TARGET_SELECTION_REFRESH_DELAY_MS);
      }
    };

    const sourceTokenUuid = getTokenDocumentUuid(sourceToken);
    const sourceActorUuid = String(getTokenActor(sourceToken)?.uuid ?? "");
    const supportsDynamicMembership = typeof refreshRows === "function";
    const isRelevantTokenUuid = uuid => Boolean(
      uuid && (
        uuid === sourceTokenUuid
        || rowIdsByTokenUuid.has(uuid)
        || supportsDynamicMembership
      )
    );
    const scheduleTokenRefresh = (token, { removed = false } = {}) => {
      if (!isCanvasSceneDocument(token)) return;
      const uuid = getTokenDocumentUuid(token);
      if (!uuid) return;
      if (uuid === sourceTokenUuid) {
        if (removed) {
          targetSelectionSession?.cancel({
            reason: "sourceTokenDeleted"
          });
          return;
        }
        scheduleDynamicRows({ token, full: true });
        return;
      }
      if (!supportsDynamicMembership && !rowIdsByTokenUuid.has(uuid) && !removed) return;
      scheduleDynamicRows({ token, tokenUuid: uuid, removed });
    };
    const scheduleActorRefresh = actor => {
      if (!actor) return;
      if (sourceActorUuid && actor.uuid === sourceActorUuid) {
        scheduleDynamicRows({ full: true });
        return;
      }
      for (const tokenDocument of actor.getDependentTokens?.({ scenes: canvas.scene }) ?? []) {
        const uuid = getTokenDocumentUuid(tokenDocument);
        if (!supportsDynamicMembership && !rowIdsByTokenUuid.has(uuid)) continue;
        scheduleDynamicRows({ token: tokenDocument.object ?? tokenDocument });
      }
    };
    const bindHook = (hook, callback) => {
      const id = Hooks.on(hook, callback);
      hookBindings.push([hook, id]);
    };

    layer.addChild(overlay);
    setRows(normalizedRows);
    targetSelectionSession = startCanvasTargetSelectionSession({
      kind: "tokens",
      rows: normalizedRows,
      selectable,
      limit: selectionLimit,
      allowRepeated: Boolean(allowRepeated),
      title,
      instructions,
      sourceTokenUuid
    }, {
      onCancel: () => finish([], { fromLifecycle: true })
    });
    overlay.name = `fallout-maw-target-selection.${targetSelectionSession.sessionId}`;
    if (finished) return;

    bindHook("refreshToken", (token, flags = {}) => {
      if (!isCanvasSceneDocument(token)) return;
      const uuid = getTokenDocumentUuid(token);
      if (!isRelevantTokenUuid(uuid)) return;
      if (
        flags.refreshPosition
        || flags.refreshSize
        || flags.refreshShape
        || flags.refreshVisibility
        || flags.refreshState
      ) {
        for (const rowId of rowIdsByTokenUuid.get(uuid) ?? []) {
          syncCustomTokenSelectionRowGraphic(
            overlay,
            graphicsByRowId,
            rowsById.get(rowId),
            selected.includes(rowId)
          );
        }
        scheduleTokenRefresh(token);
      }
    });
    bindHook("updateToken", (tokenDocument, changes = {}) => {
      if (!isCanvasSceneDocument(tokenDocument)) return;
      const uuid = getTokenDocumentUuid(tokenDocument);
      if (!isRelevantTokenUuid(uuid)) return;
      if (changedDataIntersectsPaths(changes, TOKEN_TARGET_PATHS)) {
        scheduleTokenRefresh(tokenDocument.object ?? tokenDocument);
      }
    });
    bindHook("moveToken", tokenDocument => {
      if (!isCanvasSceneDocument(tokenDocument)) return;
      if (!isRelevantTokenUuid(getTokenDocumentUuid(tokenDocument))) return;
      scheduleTokenRefresh(tokenDocument.object ?? tokenDocument);
    });
    bindHook("createToken", tokenDocument => {
      if (isCanvasSceneDocument(tokenDocument)) scheduleDynamicRows({ full: true });
    });
    bindHook("drawToken", token => {
      if (isCanvasSceneDocument(token)) scheduleDynamicRows({ full: true });
    });
    bindHook("deleteToken", tokenDocument => scheduleTokenRefresh(tokenDocument, { removed: true }));
    bindHook("destroyToken", token => scheduleTokenRefresh(token, { removed: true }));
    for (const documentName of ["Wall", "AmbientLight"]) {
      for (const operation of ["create", "update", "delete"]) {
        bindHook(`${operation}${documentName}`, document => {
          if (isCanvasSceneDocument(document)) scheduleDynamicRows({ full: true });
        });
      }
    }
    bindHook("updateScene", (scene, changes = {}) => {
      if (
        isActiveCanvasScene(scene)
        && changedDataIntersectsPaths(changes, SCENE_TARGET_PATHS)
      ) scheduleDynamicRows({ full: true });
    });
    bindHook("updateActor", actor => scheduleActorRefresh(actor));
    for (const hook of ["createItem", "updateItem", "deleteItem"]) {
      bindHook(hook, item => scheduleActorRefresh(item?.actor ?? item?.parent));
    }
    for (const hook of ["createActiveEffect", "updateActiveEffect", "deleteActiveEffect"]) {
      bindHook(hook, effect => {
        const parent = effect?.parent;
        scheduleActorRefresh(parent?.documentName === "Actor" ? parent : parent?.actor);
      });
    }
    bindHook("canvasTearDown", () => {
      targetSelectionSession?.cancel({
        reason: "canvasTearDown"
      });
    });

    window.addEventListener("keydown", onKeyDown, { capture: true });
    document.addEventListener("pointerdown", onPointerDown, { capture: true });
    rightClickGuard.activate();

    const prompt = instructions || `${title}: выберите до ${selectionLimit} целей. ЛКМ на последней цели сразу подтверждает, Enter тоже, ПКМ снимает последнюю цель, Esc отменяет.`;
    ui.notifications.info(prompt);
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
  const buildRows = tokens => buildActorSelectionRows(tokens, {
    sourceActorUuid,
    sourceToken,
    includeSelf,
    getReason
  });
  const rows = buildRows(getCanvasActorSelectionTokens(sourceToken));
  const refreshRows = ({
    rows: currentRows,
    changedTokens = [],
    removedTokenUuids = [],
    full = false
  } = {}) => {
    if (full) return buildRows(getCanvasActorSelectionTokens(sourceToken));
    const removed = new Set(removedTokenUuids.map(uuid => String(uuid ?? "")).filter(Boolean));
    const nextByUuid = new Map(
      currentRows
        .filter(row => !removed.has(getTokenDocumentUuid(row.token)))
        .map(row => [getTokenDocumentUuid(row.token), row])
        .filter(([uuid]) => uuid)
    );
    for (const changedToken of changedTokens) {
      if (!isCanvasSceneDocument(changedToken)) continue;
      const uuid = getTokenDocumentUuid(changedToken);
      if (!uuid || removed.has(uuid)) continue;
      const [row] = buildRows([getTokenObject(changedToken) ?? changedToken]);
      if (row) nextByUuid.set(uuid, row);
      else nextByUuid.delete(uuid);
    }
    return Array.from(nextByUuid.values());
  };

  const selected = await requestCustomTokenSelection({
    rows,
    limit: 1,
    title,
    noneWarning,
    instructions,
    sourceToken,
    refreshRows,
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

function buildActorSelectionRows(tokens = [], {
  sourceActorUuid = "",
  sourceToken = null,
  includeSelf = true,
  getReason = null
} = {}) {
  const sourceObject = getTokenObjectForActorSelection(sourceToken, { requireSight: true });
  const tokenObjects = (Array.isArray(tokens) ? tokens : [])
    .map(token => getTokenObject(token) ?? token)
    .filter(token => getTokenActor(token));
  const visibility = getActorSelectionVisibility(tokenObjects, {
    sourceActorUuid,
    sourceObject
  });

  return tokenObjects.map(token => {
    const actor = getTokenActor(token);
    const actorUuid = String(actor?.uuid ?? "");
    const isSelf = Boolean(sourceActorUuid && actorUuid === sourceActorUuid);
    const displayed = Boolean(visibility.get(getTokenDocumentUuid(token)));
    const reason = !actor
      ? "У токена нет актера."
      : (!includeSelf && isSelf
        ? "Нужна другая цель."
        : String(getReason?.({ token, actor, isSelf }) ?? ""));
    return {
      token,
      actor,
      actorUuid,
      displayed,
      selectable: Boolean(displayed && actor && !reason),
      reason
    };
  });
}

function getActorSelectionVisibility(tokens = [], {
  sourceActorUuid = "",
  sourceObject = null
} = {}) {
  const visibility = new Map();
  const testTargets = [];
  for (const token of tokens) {
    const tokenUuid = getTokenDocumentUuid(token);
    if (!tokenUuid) continue;
    const actorUuid = String(getTokenActor(token)?.uuid ?? "");
    const isSelf = Boolean(sourceActorUuid && actorUuid === sourceActorUuid);
    const nativelyVisible = token.visible !== false && token.renderable !== false;
    if (!nativelyVisible) {
      visibility.set(tokenUuid, false);
      continue;
    }
    if (isSelf) {
      visibility.set(tokenUuid, true);
      continue;
    }
    if (!sourceObject || sourceObject === token) {
      visibility.set(tokenUuid, true);
      continue;
    }
    testTargets.push(token);
  }

  if (sourceObject && testTargets.length) {
    const physicalVisibility = testObserverVisibilityBatch(sourceObject, testTargets);
    for (const token of testTargets) {
      const tokenUuid = getTokenDocumentUuid(token);
      visibility.set(tokenUuid, Boolean(physicalVisibility.get(tokenUuid)));
    }
  }
  return visibility;
}

function getTokenObjectForActorSelection(token = null, { requireSight = false } = {}) {
  const object = getTokenObject(token);
  if (!object) return null;
  if (requireSight && typeof object._getVisionSourceData !== "function") return null;
  return object;
}

function normalizeSelectionRows(rows = [], getRowId = () => "") {
  const normalized = [];
  const duplicateCounts = new Map();
  for (const row of rows) {
    if (!row?.token) continue;
    const baseId = String(getRowId(row) ?? "").trim() || getTokenDocumentUuid(row.token);
    if (!baseId) continue;
    const duplicateIndex = duplicateCounts.get(baseId) ?? 0;
    duplicateCounts.set(baseId, duplicateIndex + 1);
    normalized.push({
      ...row,
      displayed: row.displayed !== false,
      selectionId: duplicateIndex ? `${baseId}.${duplicateIndex}` : baseId
    });
  }
  return normalized;
}

function refreshDefaultSelectionRows(rows = [], {
  changedTokens = [],
  removedTokenUuids = []
} = {}) {
  const removed = new Set(removedTokenUuids.map(uuid => String(uuid ?? "")).filter(Boolean));
  const changed = new Map(changedTokens.map(token => [getTokenDocumentUuid(token), token]));
  return rows
    .filter(row => !removed.has(getTokenDocumentUuid(row.token)))
    .map(row => {
      const tokenUuid = getTokenDocumentUuid(row.token);
      const token = getTokenObject(changed.get(tokenUuid)) ?? changed.get(tokenUuid) ?? row.token;
      return {
        ...row,
        token,
        actor: getTokenActor(token) ?? row.actor,
        actorUuid: String(getTokenActor(token)?.uuid ?? row.actorUuid ?? ""),
        displayed: token?.visible !== false && token?.renderable !== false
      };
    });
}

function syncCustomTokenSelectionGraphics(
  overlay,
  graphicsByRowId,
  rows = [],
  selected = new Set()
) {
  const currentIds = new Set(rows.map(row => row.selectionId));
  for (const [selectionId, graphics] of graphicsByRowId) {
    if (currentIds.has(selectionId)) continue;
    graphicsByRowId.delete(selectionId);
    graphics.parent?.removeChild?.(graphics);
    if (!graphics.destroyed) graphics.destroy();
  }
  for (const row of rows) {
    syncCustomTokenSelectionRowGraphic(
      overlay,
      graphicsByRowId,
      row,
      selected.has(row.selectionId)
    );
  }
}

function syncCustomTokenSelectionRowGraphic(
  overlay,
  graphicsByRowId,
  row,
  selected = false
) {
  if (!row?.selectionId || !row?.token) return;
  let graphics = graphicsByRowId.get(row.selectionId);
  if (!graphics || graphics.destroyed) {
    graphics = new PIXI.Graphics();
    graphics.eventMode = "none";
    graphics.interactive = false;
    graphicsByRowId.set(row.selectionId, graphics);
    overlay.addChild(graphics);
  }

  graphics.visible = row.displayed !== false;
  if (!graphics.visible) return;
  const rect = getTokenRect(row.token);
  const color = row.selectable ? 0x36d06f : 0xd64b4b;
  const lineWidth = selected ? 5 : 3;
  const alpha = selected ? 0.28 : 0.14;
  const styleSignature = `${rect.width}:${rect.height}:${color}:${lineWidth}:${alpha}`;
  if (graphics.falloutMawStyleSignature !== styleSignature) {
    graphics.clear();
    graphics.lineStyle(lineWidth, color, 0.95);
    graphics.beginFill(color, alpha);
    graphics.drawRect(0, 0, rect.width, rect.height);
    graphics.endFill();
    graphics.falloutMawStyleSignature = styleSignature;
  }
  graphics.position.set(rect.x, rect.y);
}

function getCustomTokenSelectionRowAtPoint(rows = [], point = null) {
  return rows
    .slice()
    .reverse()
    .find(row => row.displayed !== false && isPointInToken(point, row.token)) ?? null;
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
  const object = getTokenObject(token);
  const document = object?.document ?? token?.document ?? token;
  const size = document?.getSize?.() ?? {
    width: Math.max(1, Number(document?.width) || 1) * canvas.grid.size,
    height: Math.max(1, Number(document?.height) || 1) * canvas.grid.size
  };
  return {
    x: Number(document?.x ?? object?.x ?? token?.x) || 0,
    y: Number(document?.y ?? object?.y ?? token?.y) || 0,
    width: Math.max(1, Number(size.width) || canvas.grid.size),
    height: Math.max(1, Number(size.height) || canvas.grid.size)
  };
}

function getTokenObject(token = null) {
  return token?.object ?? token ?? null;
}

function getTokenActor(token = null) {
  const object = getTokenObject(token);
  return object?.actor ?? object?.document?.actor ?? token?.actor ?? token?.document?.actor ?? null;
}

function getTokenDocumentUuid(token = null) {
  const object = getTokenObject(token);
  return String(
    object?.document?.uuid
    ?? token?.document?.uuid
    ?? object?.uuid
    ?? token?.uuid
    ?? ""
  ).trim();
}

function isCanvasSceneDocument(documentOrObject = null) {
  const document = documentOrObject?.document ?? documentOrObject;
  const parent = document?.parent ?? null;
  // Foundry embedded canvas documents always expose their parent Scene.
  // Keeping parent-less objects eligible preserves compatibility with
  // synthetic placeables used by system tests and one-off previews.
  if (!parent) return true;
  return isActiveCanvasScene(parent);
}

function isActiveCanvasScene(scene = null) {
  const activeScene = canvas?.scene ?? null;
  if (!scene || !activeScene) return false;
  if (scene === activeScene) return true;
  const sceneId = String(scene.id ?? scene._id ?? "");
  const activeSceneId = String(activeScene.id ?? activeScene._id ?? "");
  return Boolean(sceneId && activeSceneId && sceneId === activeSceneId);
}

function getCustomTokenSelectionLayer() {
  return canvas.interface ?? canvas.tokens ?? null;
}

function isCanvasViewEvent(event) {
  const view = canvas.app?.view;
  if (!view) return false;
  return event.target === view || Array.from(event.composedPath?.() ?? []).includes(view);
}
