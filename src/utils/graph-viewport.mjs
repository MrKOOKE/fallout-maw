export function readGraphViewportMetrics(element) {
  const rect = element?.getBoundingClientRect?.();
  const width = Math.max(0, Number(element?.clientWidth) || Number(element?.offsetWidth) || Number(rect?.width) || 0);
  const height = Math.max(0, Number(element?.clientHeight) || Number(element?.offsetHeight) || Number(rect?.height) || 0);
  const borderBoxWidth = Math.max(0, Number(element?.offsetWidth) || width);
  const borderBoxHeight = Math.max(0, Number(element?.offsetHeight) || height);
  const scaleX = borderBoxWidth > 0 && Number(rect?.width) > 0 ? rect.width / borderBoxWidth : 1;
  const scaleY = borderBoxHeight > 0 && Number(rect?.height) > 0 ? rect.height / borderBoxHeight : 1;
  return {
    height,
    left: (Number(rect?.left) || 0) + ((Number(element?.clientLeft) || 0) * scaleX),
    scaleX,
    scaleY,
    top: (Number(rect?.top) || 0) + ((Number(element?.clientTop) || 0) * scaleY),
    width
  };
}

/**
 * Keep at least one complete graph node inside a viewport. Node coordinates are
 * unscaled stage coordinates while viewport x/y and the origin are local CSS pixels.
 */

export function clampGraphViewportToVisibleNode(viewport = {}, {
  height = 0,
  nodeHeight = 1,
  nodeWidth = 1,
  nodes = [],
  originX = 0,
  originY = 0,
  width = 0
} = {}) {
  const normalized = normalizeGraphViewport(viewport);
  const viewportWidth = Number(width) || 0;
  const viewportHeight = Number(height) || 0;
  if (viewportWidth <= 0 || viewportHeight <= 0) return normalized;

  let nearestAdjustment = null;
  let hasNodes = false;
  for (const node of nodes) {
    if (!node) continue;
    hasNodes = true;
    const rect = getGraphNodeScreenRect(node, normalized, {
      nodeHeight,
      nodeWidth,
      originX,
      originY
    });
    if (rect.left >= 0
      && rect.right <= viewportWidth
      && rect.top >= 0
      && rect.bottom <= viewportHeight) return normalized;

    const dx = getContainmentDelta(rect.left, rect.right, viewportWidth);
    const dy = getContainmentDelta(rect.top, rect.bottom, viewportHeight);
    const distance = Math.hypot(dx, dy);
    if (!nearestAdjustment || distance < nearestAdjustment.distance) {
      nearestAdjustment = { distance, dx, dy };
    }
  }
  if (!hasNodes || !nearestAdjustment) return normalized;
  return {
    ...normalized,
    x: normalized.x + nearestAdjustment.dx,
    y: normalized.y + nearestAdjustment.dy
  };
}

/**
 * Create an initial camera which frames the current node and its immediate next
 * choices. At a leaf it includes the immediate predecessor for branch context.
 */
export function createGraphSegmentViewport({
  focusNodeIds = [],
  height = 0,
  links = [],
  maxZoom = 1,
  minZoom = 0.1,
  nodeHeight = 1,
  nodeWidth = 1,
  nodes = [],
  padding = 24,
  width = 0
} = {}) {
  const viewportWidth = Math.max(0, Number(width) || 0);
  const viewportHeight = Math.max(0, Number(height) || 0);
  const byId = new Map();
  for (const node of nodes) {
    const id = String(node?.id ?? "").trim();
    if (id) byId.set(id, node);
  }
  if (!byId.size || viewportWidth <= 0 || viewportHeight <= 0) {
    return { x: 0, y: 0, zoom: clampZoom(maxZoom, minZoom, maxZoom) };
  }

  const focused = new Set(Array.from(focusNodeIds, id => String(id ?? "").trim())
    .filter(id => byId.has(id)));
  if (!focused.size) focused.add(byId.keys().next().value);
  const focusAnchors = new Set(focused);

  let hasNextNodes = false;
  for (const link of links) {
    const fromId = String(link?.fromId ?? "").trim();
    const toId = String(link?.toId ?? "").trim();
    if (!focusAnchors.has(fromId) || !byId.has(toId)) continue;
    focused.add(toId);
    hasNextNodes = true;
  }
  if (!hasNextNodes) {
    for (const link of links) {
      const fromId = String(link?.fromId ?? "").trim();
      const toId = String(link?.toId ?? "").trim();
      if (focusAnchors.has(toId) && byId.has(fromId)) focused.add(fromId);
    }
  }

  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const id of focused) {
    const node = byId.get(id);
    const x = Number(node?.x) || 0;
    const y = Number(node?.y) || 0;
    const currentWidth = Math.max(1, Number(node?.width) || Number(nodeWidth) || 1);
    const currentHeight = Math.max(1, Number(node?.height) || Number(nodeHeight) || 1);
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x + currentWidth);
    bottom = Math.max(bottom, y + currentHeight);
  }

  const safePadding = Math.max(0, Number(padding) || 0);
  const availableWidth = Math.max(1, viewportWidth - (safePadding * 2));
  const availableHeight = Math.max(1, viewportHeight - (safePadding * 2));
  const maximumZoom = Math.max(Number(minZoom) || 0.1, Number(maxZoom) || 1);
  const zoom = clampZoom(Math.min(
    maximumZoom,
    availableWidth / Math.max(1, right - left),
    availableHeight / Math.max(1, bottom - top)
  ), minZoom, maximumZoom);
  return {
    x: (viewportWidth / 2) - (((left + right) / 2) * zoom),
    y: (viewportHeight / 2) - (((top + bottom) / 2) * zoom),
    zoom
  };
}

function getGraphNodeScreenRect(node, viewport, {
  nodeHeight = 1,
  nodeWidth = 1,
  originX = 0,
  originY = 0
} = {}) {
  const width = Math.max(1, Number(node?.width) || Number(nodeWidth) || 1);
  const height = Math.max(1, Number(node?.height) || Number(nodeHeight) || 1);
  const left = (Number(originX) || 0) + viewport.x + ((Number(node?.x) || 0) * viewport.zoom);
  const top = (Number(originY) || 0) + viewport.y + ((Number(node?.y) || 0) * viewport.zoom);
  return {
    bottom: top + (height * viewport.zoom),
    left,
    right: left + (width * viewport.zoom),
    top
  };
}

function getContainmentDelta(start, end, size) {
  const nodeSize = end - start;
  if (nodeSize > size) return (size / 2) - ((start + end) / 2);
  if (start < 0) return -start;
  if (end > size) return size - end;
  return 0;
}

function normalizeGraphViewport(viewport = {}) {
  const zoom = Number(viewport?.zoom);
  return {
    x: Number(viewport?.x) || 0,
    y: Number(viewport?.y) || 0,
    zoom: Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  };
}

function clampZoom(value, minimum, maximum) {
  const min = Math.max(0.01, Number(minimum) || 0.1);
  const max = Math.max(min, Number(maximum) || 1);
  const zoom = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(zoom) ? zoom : max));
}
