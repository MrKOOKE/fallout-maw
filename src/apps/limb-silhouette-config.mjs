import { TEMPLATES } from "../constants.mjs";
import {
  SILHOUETTE_AREA_TOLERANCE,
  SILHOUETTE_UNASSIGNED_FILL,
  buildSvgPoints,
  clipperDifference,
  clipperIntersect,
  clipperUnion,
  getPathsArea,
  normalizeLimbSilhouette,
  normalizePaths,
  pathsToCompoundSvgData,
  pathsToSvgData,
  smoothSilhouettePaths
} from "../utils/limb-silhouette.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const ALPHA_CONTOUR_THRESHOLD = 0.48;
const ALPHA_BLUR_RADIUS = 2;
const EDITOR_COLORS = Object.freeze([
  "#6abf69",
  "#d8c85c",
  "#d37d45",
  "#4fa9c7",
  "#a77bd8",
  "#c95d75",
  "#92b95d",
  "#c7a45c"
]);

export class LimbSilhouetteConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  #race = null;
  #saveCallback = null;
  #activeLimbKey = "";
  #draftPoints = [];
  #history = [];
  #silhouette = null;
  #remaining = [];

  constructor({ race, onSave } = {}, options = {}) {
    super(options);
    this.#race = race;
    this.#saveCallback = onSave;
    this.#activeLimbKey = race?.limbs?.[0]?.key ?? "";
    this.#setSilhouette(race?.limbSilhouette);
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-limb-silhouette-config",
    classes: ["fallout-maw", "fallout-maw-config-form", "fallout-maw-limb-silhouette-config"],
    position: {
      width: 980,
      height: 720
    },
    window: {
      resizable: true
    },
    actions: {
      chooseImage: LimbSilhouetteConfig.#onChooseImage,
      selectLimb: LimbSilhouetteConfig.#onSelectLimb,
      addPoint: LimbSilhouetteConfig.#onAddPoint,
      finishPolygon: LimbSilhouetteConfig.#onFinishPolygon,
      cancelPolygon: LimbSilhouetteConfig.#onCancelPolygon,
      undo: LimbSilhouetteConfig.#onUndo,
      clearActive: LimbSilhouetteConfig.#onClearActive,
      reset: LimbSilhouetteConfig.#onReset,
      save: LimbSilhouetteConfig.#onSave,
      close: LimbSilhouetteConfig.#onClose
    }
  };

  static PARTS = {
    body: {
      template: TEMPLATES.settings.limbSilhouette
    }
  };

  get title() {
    return `Силуэт: ${this.#race?.name ?? ""}`;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const totalArea = this.#silhouette ? getPathsArea(this.#silhouette.outline) : 0;
    const remainingArea = this.#remaining.length ? getPathsArea(this.#remaining) : 0;
    const unassignedRatio = totalArea > 0 ? remainingArea / totalArea : 0;
    const partsByLimb = new Map((this.#silhouette?.parts ?? []).map(part => [part.limbKey, part]));
    const limbs = (this.#race?.limbs ?? []).map((limb, index) => {
      const paths = partsByLimb.get(limb.key)?.paths ?? [];
      const area = paths.length ? getPathsArea(paths) : 0;
      return {
        ...limb,
        active: limb.key === this.#activeLimbKey,
        color: EDITOR_COLORS[index % EDITOR_COLORS.length],
        assigned: area > 0,
        areaPercent: totalArea > 0 ? Math.round((area / totalArea) * 100) : 0
      };
    });

    return {
      ...context,
      hasSilhouette: Boolean(this.#silhouette),
      viewBox: this.#silhouette ? `0 0 ${this.#silhouette.width} ${this.#silhouette.height}` : "0 0 1 1",
      outline: pathsToSvgData(this.#silhouette?.outline ?? []),
      remaining: pathsToCompoundSvgData(this.#remaining)
        ? [{ ...pathsToCompoundSvgData(this.#remaining), fill: SILHOUETTE_UNASSIGNED_FILL }]
        : [],
      parts: this.#preparePartPaths(limbs),
      limbs,
      activeLimb: limbs.find(limb => limb.active) ?? null,
      draftPoints: buildSvgPoints(this.#draftPoints),
      draftPointMarkers: this.#draftPoints,
      canFinishPolygon: this.#draftPoints.length >= 3,
      canUndo: this.#history.length > 0,
      canClearActive: Boolean(partsByLimb.get(this.#activeLimbKey)?.paths?.length),
      canSave: !this.#silhouette || unassignedRatio <= SILHOUETTE_AREA_TOLERANCE,
      unassignedPercent: totalArea > 0 ? Math.round(unassignedRatio * 1000) / 10 : 0
    };
  }

  #preparePartPaths(limbs) {
    const limbData = new Map(limbs.map(limb => [limb.key, limb]));
    return (this.#silhouette?.parts ?? []).flatMap(part => {
      const limb = limbData.get(part.limbKey);
      if (!limb) return [];
      const path = pathsToCompoundSvgData(part.paths);
      if (!path) return [];
      return [{
        d: path.d,
        limbKey: part.limbKey,
        label: limb.label,
        fill: limb.color
      }];
    });
  }

  #setSilhouette(silhouette) {
    this.#silhouette = normalizeLimbSilhouette(silhouette, this.#race?.limbs ?? []);
    this.#remaining = this.#silhouette ? getRemainingSilhouette(this.#silhouette) : [];
    this.#draftPoints = [];
    this.#history = [];
  }

  #pushHistory() {
    this.#history.push(foundry.utils.deepClone({
      silhouette: this.#silhouette,
      remaining: this.#remaining,
      draftPoints: this.#draftPoints
    }));
  }

  #restoreSnapshot(snapshot) {
    this.#silhouette = snapshot?.silhouette ?? null;
    this.#remaining = snapshot?.remaining ?? [];
    this.#draftPoints = snapshot?.draftPoints ?? [];
  }

  async #loadImage(path) {
    let image;
    try {
      image = await loadImageElement(path);
    } catch (error) {
      ui.notifications.error(`Не удалось загрузить изображение: ${error.message}`);
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context || !canvas.width || !canvas.height) {
      ui.notifications.error("Не удалось прочитать пиксели изображения.");
      return;
    }

    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const outline = extractAlphaOutlinePaths(imageData);
    if (!outline.length) {
      ui.notifications.warn("На изображении не найден непрозрачный контур.");
      return;
    }

    this.#pushHistory();
    this.#silhouette = {
      width: canvas.width,
      height: canvas.height,
      outline,
      parts: []
    };
    this.#remaining = outline;
    this.#draftPoints = [];
    await this.render({ force: true });
  }

  static #onChooseImage(event) {
    event.preventDefault();
    new FilePicker({
      type: "image",
      callback: path => this.#loadImage(path)
    }).render(true);
  }

  static #onSelectLimb(event, target) {
    event.preventDefault();
    this.#activeLimbKey = target.dataset.limbKey ?? this.#activeLimbKey;
    this.#draftPoints = [];
    return this.render({ force: true });
  }

  static #onAddPoint(event, target) {
    event.preventDefault();
    if (!this.#silhouette || !this.#activeLimbKey) return undefined;
    const point = getSvgEventPoint(target, event);
    if (!point) return undefined;
    this.#draftPoints.push(point);
    return this.render({ force: true });
  }

  static #onFinishPolygon(event) {
    event.preventDefault();
    if (!this.#silhouette || this.#draftPoints.length < 3 || !this.#activeLimbKey) return undefined;
    let cutPaths;
    try {
      cutPaths = clipperIntersect(this.#remaining, [this.#draftPoints]);
    } catch (error) {
      ui.notifications.error(error.message);
      return undefined;
    }
    if (!cutPaths.length) {
      ui.notifications.warn("Полигон не пересек доступный остаток силуэта.");
      return undefined;
    }

    this.#pushHistory();
    const parts = this.#silhouette.parts ?? [];
    const existing = parts.find(part => part.limbKey === this.#activeLimbKey);
    if (existing) existing.paths = clipperUnion([...existing.paths, ...cutPaths]);
    else parts.push({ limbKey: this.#activeLimbKey, paths: cutPaths });
    this.#remaining = clipperDifference(this.#remaining, cutPaths);
    this.#draftPoints = [];
    return this.render({ force: true });
  }

  static #onCancelPolygon(event) {
    event.preventDefault();
    this.#draftPoints = [];
    return this.render({ force: true });
  }

  static #onUndo(event) {
    event.preventDefault();
    const snapshot = this.#history.pop();
    if (!snapshot) return undefined;
    this.#restoreSnapshot(snapshot);
    return this.render({ force: true });
  }

  static #onClearActive(event) {
    event.preventDefault();
    if (!this.#silhouette || !this.#activeLimbKey) return undefined;
    const part = (this.#silhouette.parts ?? []).find(entry => entry.limbKey === this.#activeLimbKey);
    if (!part?.paths?.length) return undefined;
    this.#pushHistory();
    this.#remaining = clipperUnion([...this.#remaining, ...part.paths]);
    this.#silhouette.parts = (this.#silhouette.parts ?? []).filter(entry => entry.limbKey !== this.#activeLimbKey);
    this.#draftPoints = [];
    return this.render({ force: true });
  }

  static #onReset(event) {
    event.preventDefault();
    this.#pushHistory();
    this.#silhouette = null;
    this.#remaining = [];
    this.#draftPoints = [];
    return this.render({ force: true });
  }

  static async #onSave(event) {
    event.preventDefault();
    if (this.#silhouette) {
      const totalArea = getPathsArea(this.#silhouette.outline);
      const remainingArea = getPathsArea(this.#remaining);
      if (totalArea > 0 && (remainingArea / totalArea) > SILHOUETTE_AREA_TOLERANCE) {
        ui.notifications.warn("Сначала распределите весь контур силуэта по конечностям.");
        return undefined;
      }
    }

    const silhouette = this.#silhouette
      ? {
        width: this.#silhouette.width,
        height: this.#silhouette.height,
        outline: normalizePaths(this.#silhouette.outline),
        parts: (this.#silhouette.parts ?? [])
          .map(part => ({ limbKey: part.limbKey, paths: normalizePaths(part.paths) }))
          .filter(part => part.paths.length)
      }
      : null;
    await this.#saveCallback?.(silhouette);
    return this.close();
  }

  static #onClose(event) {
    event.preventDefault();
    return this.close();
  }
}

function getRemainingSilhouette(silhouette) {
  const assigned = clipperUnion((silhouette.parts ?? []).flatMap(part => part.paths ?? []));
  return assigned.length ? clipperDifference(silhouette.outline, assigned) : normalizePaths(silhouette.outline);
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(src));
    image.src = src;
  });
}

function extractAlphaOutlinePaths(imageData) {
  const marchingPaths = traceAlphaIsolines(imageData, {
    threshold: ALPHA_CONTOUR_THRESHOLD,
    blurRadius: ALPHA_BLUR_RADIUS
  });
  if (marchingPaths.length) {
    const smoothed = smoothSilhouettePaths(marchingPaths, {
      iterations: 4,
      simplifyTolerance: 2.25,
      finalSimplifyTolerance: 0.7
    });
    return clipperUnion(smoothed);
  }

  const { width, height, data } = imageData;
  const mask = new Uint8Array(width * height);
  for (let index = 0; index < mask.length; index += 1) {
    mask[index] = data[(index * 4) + 3] > 0 ? 1 : 0;
  }

  const edges = new Map();
  const isFilled = (x, y) => x >= 0 && y >= 0 && x < width && y < height && mask[(y * width) + x] === 1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!isFilled(x, y)) continue;
      if (!isFilled(x, y - 1)) addEdge(edges, { x, y }, { x: x + 1, y });
      if (!isFilled(x + 1, y)) addEdge(edges, { x: x + 1, y }, { x: x + 1, y: y + 1 });
      if (!isFilled(x, y + 1)) addEdge(edges, { x: x + 1, y: y + 1 }, { x, y: y + 1 });
      if (!isFilled(x - 1, y)) addEdge(edges, { x, y: y + 1 }, { x, y });
    }
  }

  const paths = traceEdgeLoops(edges);
  const merged = clipperUnion(paths);
  const smoothed = smoothSilhouettePaths(merged);
  return clipperUnion(smoothed);
}

function traceAlphaIsolines(imageData, { threshold = ALPHA_CONTOUR_THRESHOLD, blurRadius = ALPHA_BLUR_RADIUS } = {}) {
  const field = createBlurredPaddedAlphaField(imageData, blurRadius);
  const segments = [];
  for (let y = 0; y < field.height - 1; y += 1) {
    for (let x = 0; x < field.width - 1; x += 1) {
      const values = {
        tl: field.values[(y * field.width) + x],
        tr: field.values[(y * field.width) + x + 1],
        br: field.values[((y + 1) * field.width) + x + 1],
        bl: field.values[((y + 1) * field.width) + x]
      };
      const cellSegments = getMarchingSquareSegments(x, y, values, threshold);
      segments.push(...cellSegments);
    }
  }
  return connectLineSegments(segments)
    .map(path => path.map(point => ({
      x: Math.min(Math.max(point.x - 0.5, 0), imageData.width),
      y: Math.min(Math.max(point.y - 0.5, 0), imageData.height)
    })))
    .filter(path => path.length >= 3);
}

function createBlurredPaddedAlphaField(imageData, radius) {
  const { width, height, data } = imageData;
  const paddedWidth = width + 2;
  const paddedHeight = height + 2;
  let values = new Float32Array(paddedWidth * paddedHeight);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      values[((y + 1) * paddedWidth) + x + 1] = data[(((y * width) + x) * 4) + 3] / 255;
    }
  }

  const passes = 2;
  for (let pass = 0; pass < passes; pass += 1) {
    values = boxBlurAlpha(values, paddedWidth, paddedHeight, radius);
  }
  return { width: paddedWidth, height: paddedHeight, values };
}

function boxBlurAlpha(values, width, height, radius) {
  const safeRadius = Math.max(0, Math.trunc(radius));
  if (!safeRadius) return values;

  const horizontal = new Float32Array(values.length);
  const output = new Float32Array(values.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let total = 0;
      let count = 0;
      for (let offset = -safeRadius; offset <= safeRadius; offset += 1) {
        const sampleX = x + offset;
        if (sampleX < 0 || sampleX >= width) continue;
        total += values[(y * width) + sampleX];
        count += 1;
      }
      horizontal[(y * width) + x] = total / Math.max(1, count);
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let total = 0;
      let count = 0;
      for (let offset = -safeRadius; offset <= safeRadius; offset += 1) {
        const sampleY = y + offset;
        if (sampleY < 0 || sampleY >= height) continue;
        total += horizontal[(sampleY * width) + x];
        count += 1;
      }
      output[(y * width) + x] = total / Math.max(1, count);
    }
  }
  return output;
}

function getMarchingSquareSegments(x, y, values, threshold) {
  const inside = {
    tl: values.tl >= threshold,
    tr: values.tr >= threshold,
    br: values.br >= threshold,
    bl: values.bl >= threshold
  };
  const state = (inside.tl ? 1 : 0)
    | (inside.tr ? 2 : 0)
    | (inside.br ? 4 : 0)
    | (inside.bl ? 8 : 0);
  if (state === 0 || state === 15) return [];

  const points = [
    interpolateEdge({ x, y }, { x: x + 1, y }, values.tl, values.tr, threshold),
    interpolateEdge({ x: x + 1, y }, { x: x + 1, y: y + 1 }, values.tr, values.br, threshold),
    interpolateEdge({ x: x + 1, y: y + 1 }, { x, y: y + 1 }, values.br, values.bl, threshold),
    interpolateEdge({ x, y: y + 1 }, { x, y }, values.bl, values.tl, threshold)
  ];
  const centerInside = ((values.tl + values.tr + values.br + values.bl) / 4) >= threshold;
  const segmentEdges = getMarchingSquareEdgePairs(state, centerInside);
  return segmentEdges.map(([from, to]) => [points[from], points[to]]);
}

function getMarchingSquareEdgePairs(state, centerInside) {
  const simpleCases = {
    1: [[3, 0]],
    2: [[0, 1]],
    3: [[3, 1]],
    4: [[1, 2]],
    6: [[0, 2]],
    7: [[3, 2]],
    8: [[2, 3]],
    9: [[0, 2]],
    11: [[1, 2]],
    12: [[1, 3]],
    13: [[0, 1]],
    14: [[3, 0]]
  };
  if (state === 5) return centerInside ? [[0, 1], [2, 3]] : [[3, 0], [1, 2]];
  if (state === 10) return centerInside ? [[3, 0], [1, 2]] : [[0, 1], [2, 3]];
  return simpleCases[state] ?? [];
}

function interpolateEdge(from, to, fromValue, toValue, threshold) {
  const range = toValue - fromValue;
  const ratio = Math.abs(range) < 0.000001 ? 0.5 : Math.max(0, Math.min(1, (threshold - fromValue) / range));
  return {
    x: from.x + ((to.x - from.x) * ratio),
    y: from.y + ((to.y - from.y) * ratio)
  };
}

function connectLineSegments(segments) {
  const points = new Map();
  const edges = new Map();
  segments.forEach(([from, to], id) => {
    const fromKey = contourPointKey(from);
    const toKey = contourPointKey(to);
    points.set(fromKey, from);
    points.set(toKey, to);
    addContourEdge(edges, fromKey, toKey, id);
    addContourEdge(edges, toKey, fromKey, id);
  });

  const used = new Set();
  const loops = [];
  for (const [from, to] of segments) {
    const startKey = contourPointKey(from);
    const firstKey = contourPointKey(to);
    const firstEdge = getEdgeId(edges, startKey, firstKey);
    if (firstEdge == null || used.has(firstEdge)) continue;

    used.add(firstEdge);
    const path = [points.get(startKey), points.get(firstKey)];
    let previousKey = startKey;
    let currentKey = firstKey;
    let guard = 0;
    while (currentKey !== startKey && guard < segments.length + 4) {
      const next = (edges.get(currentKey) ?? []).find(edge => edge.to !== previousKey && !used.has(edge.id))
        ?? (edges.get(currentKey) ?? []).find(edge => !used.has(edge.id));
      if (!next) break;
      used.add(next.id);
      previousKey = currentKey;
      currentKey = next.to;
      if (currentKey !== startKey) path.push(points.get(currentKey));
      guard += 1;
    }

    if (currentKey === startKey && path.length >= 3) loops.push(path);
  }
  return loops;
}

function addContourEdge(edges, from, to, id) {
  const entries = edges.get(from) ?? [];
  entries.push({ to, id });
  edges.set(from, entries);
}

function getEdgeId(edges, from, to) {
  return (edges.get(from) ?? []).find(edge => edge.to === to)?.id ?? null;
}

function contourPointKey(point) {
  return `${Math.round(point.x * 1000)},${Math.round(point.y * 1000)}`;
}

function addEdge(edges, from, to) {
  const key = pointKey(from);
  const entries = edges.get(key) ?? [];
  entries.push(to);
  edges.set(key, entries);
}

function traceEdgeLoops(edges) {
  const paths = [];
  while (edges.size) {
    const startKey = edges.keys().next().value;
    const start = pointFromKey(startKey);
    const path = [start];
    let current = takeNextEdge(edges, startKey);
    let guard = 0;
    while (current && pointKey(current) !== startKey && guard < 1000000) {
      path.push(current);
      current = takeNextEdge(edges, pointKey(current));
      guard += 1;
    }
    if (path.length >= 3) paths.push(path);
  }
  return paths;
}

function takeNextEdge(edges, key) {
  const entries = edges.get(key);
  if (!entries?.length) {
    edges.delete(key);
    return null;
  }
  const point = entries.shift();
  if (!entries.length) edges.delete(key);
  return point;
}

function pointKey(point) {
  return `${point.x},${point.y}`;
}

function pointFromKey(key) {
  const [x, y] = key.split(",").map(Number);
  return { x, y };
}

function getSvgEventPoint(svg, event) {
  if (!(svg instanceof SVGSVGElement)) return null;
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  const matrix = svg.getScreenCTM()?.inverse();
  if (!matrix) return null;
  const transformed = point.matrixTransform(matrix);
  return { x: transformed.x, y: transformed.y };
}
