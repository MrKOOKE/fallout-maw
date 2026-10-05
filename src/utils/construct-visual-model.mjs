import { normalizeConstructPersonalWeapons } from "./construct-firing-port-model.mjs";
import { normalizeRotationCost } from "./construct-rotation-cost.mjs";
export { normalizeConstructPersonalWeapons } from "./construct-firing-port-model.mjs";

/**
 * Serializable modular token model. Positions and image sizes use token extents;
 * image rotation is clockwise, with artwork facing up at zero degrees.
 * Child anchors use offsets from parentId or the pivot of parentSlotId.
 * Runtime angles are body-relative. A saved mount reference preserves joint yaw
 * when its parent turns; active aiming overrides use their current body angle.
 * This module deliberately has no Foundry or PIXI dependencies.
 */
export const CONSTRUCT_VISUAL_FLAG = "constructVisual";
export const CONSTRUCT_VISUAL_STATE_FLAG = "constructVisualState";
export const CONSTRUCT_CREW_FUNCTIONS = Object.freeze(["move", "rotate", "aim", "fire", "reload", "activate"]);
export const CONSTRUCT_CREW_ROLE_FUNCTIONS = Object.freeze({
  passenger: [], driver: ["move", "rotate"], gunner: ["aim", "fire", "reload"], loader: ["reload"], custom: []
});

const runtimeModels = new WeakMap();
let runtimeCacheRegistered = false;
let runtimeRevision = 0;

/** Document updates invalidate local geometry; movement only changes its world transform. */
export function registerConstructVisualModelCache() {
  if (runtimeCacheRegistered) return;
  runtimeCacheRegistered = true;
  const invalidate = document => {
    const actor = document?.documentName === "Actor" ? document : document?.actor ?? document?.parent?.actor ?? document?.parent;
    if (actor?.documentName === "Actor") runtimeModels.delete(actor);
    runtimeRevision++;
  };
  for (const hook of ["updateActor", "updateItem", "createItem", "deleteItem", "createActiveEffect", "updateActiveEffect", "deleteActiveEffect"])
    globalThis.Hooks.on(hook, invalidate);
  for (const hook of ["updateUser", "createUser", "deleteUser"])
    globalThis.Hooks.on(hook, () => { runtimeRevision++; });
  globalThis.Hooks.on("updateToken", (document, changes) => {
    if (Object.keys(changes ?? {}).some(key => key === "delta" || key.startsWith("delta.") || key === "actorId")) {
      runtimeModels.delete(document.actor);
      runtimeRevision++;
    }
  });
}

export function getConstructVisualRuntimeRevision() { return runtimeCacheRegistered ? runtimeRevision : null; }

/** Read-only runtime configuration. Editors continue to use a fresh getConstructVisualConfig draft. */
export function getConstructVisualRuntimeConfig(actor) {
  return getRuntimeModel(actor)?.config ?? getConstructVisualConfig(actor);
}

function getRuntimeModel(actor) {
  if (!runtimeCacheRegistered || actor?.documentName !== "Actor") return null;
  const raw = actor.getFlag?.("fallout-maw", CONSTRUCT_VISUAL_FLAG) ?? actor.flags?.["fallout-maw"]?.[CONSTRUCT_VISUAL_FLAG];
  let entry = runtimeModels.get(actor);
  if (!entry || entry.raw !== raw) {
    entry = { raw, config: getConstructVisualConfig(actor), state: readActorSlotState(actor), resolved: new Map() };
    runtimeModels.set(actor, entry);
  }
  return entry;
}

export function normalizeConstructVisual(raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const anchorIds = new Set();
  const anchors = entries(source.anchors).slice(0, 256).map((entry, index) => {
    const id = uniqueId(entry?.id, `anchor-${index + 1}`, anchorIds);
    return {
      id, name: text(entry?.name) || `Якорь ${index + 1}`,
      x: number(entry?.x, 0.5, -8, 8), y: number(entry?.y, 0.5, -8, 8),
      rotation: normalizeConstructVisualRotation(entry?.rotation),
      parentId: text(entry?.parentId), parentSlotId: text(entry?.parentSlotId)
    };
  });
  const partIds = new Set();
  const parts = entries(source.parts).slice(0, 256).map((entry, index) => ({
    id: uniqueId(entry?.id, `part-${index + 1}`, partIds),
    slotId: text(entry?.slotId), anchorId: text(entry?.anchorId), muzzleAnchorId: text(entry?.muzzleAnchorId),
    img: imagePath(entry?.img), damagedImg: imagePath(entry?.damagedImg),
    width: number(entry?.width, 1, 0.01, 16), height: number(entry?.height, 1, 0.01, 16),
    pivotX: number(entry?.pivotX, 0.5, 0, 1), pivotY: number(entry?.pivotY, 0.5, 0, 1),
    rotation: normalizeConstructVisualRotation(entry?.rotation),
    zIndex: Math.trunc(number(entry?.zIndex, index, -10000, 10000)),
    rotates: Boolean(entry?.rotates), rotationSpeed: number(entry?.rotationSpeed, 90, 0.1, 720),
    rotationCost: normalizeRotationCost(entry?.rotationCost),
    rotationSystemIds: [...new Set(entries(entry?.rotationSystemIds).map(text).filter(Boolean))],
    rotationSoundPath: imagePath(entry?.rotationSoundPath),
    rotationSoundVolume: number(entry?.rotationSoundVolume, 0.4, 0, 1),
    minRotation: number(entry?.minRotation, -180, -360, 360),
    maxRotation: number(entry?.maxRotation, 180, -360, 360)
  })).filter(part => part.slotId);
  const anchorById = new Map(anchors.map(anchor => [anchor.id, anchor]));
  const partBySlot = new Map(parts.map(part => [part.slotId, part]));
  for (const anchor of anchors) {
    if (!anchorById.has(anchor.parentId) || anchor.parentId === anchor.id) anchor.parentId = "";
    if (!partBySlot.has(anchor.parentSlotId)) anchor.parentSlotId = "";
  }
  // Detach the first cycle edge in input order, keeping every editable anchor.
  for (const anchor of anchors) {
    const visited = new Set([anchor.id]);
    let dependency = getAnchorDependency(anchor, partBySlot);
    while (dependency && anchorById.has(dependency)) {
      if (visited.has(dependency)) {
        anchor.parentId = "";
        anchor.parentSlotId = "";
        break;
      }
      visited.add(dependency);
      dependency = getAnchorDependency(anchorById.get(dependency), partBySlot);
    }
  }
  for (const part of parts) {
    if (!anchorById.has(part.anchorId)) part.anchorId = "";
    if (!anchorById.has(part.muzzleAnchorId)) part.muzzleAnchorId = "";
    if (part.minRotation > part.maxRotation) [part.minRotation, part.maxRotation] = [part.maxRotation, part.minRotation];
  }
  const seatIds = new Set();
  const seatRefs = new Set();
  const seats = entries(source.seats).slice(0, 256).map((entry, index) => {
    const role = Object.hasOwn(CONSTRUCT_CREW_ROLE_FUNCTIONS, entry?.role) ? entry.role : "passenger";
    const suppliedFunctions = Array.isArray(entry?.functions) ? entry.functions
      : entry?.permissions && typeof entry.permissions === "object"
        ? CONSTRUCT_CREW_FUNCTIONS.filter(key => entry.permissions[key])
        : CONSTRUCT_CREW_ROLE_FUNCTIONS[role];
    return {
      id: uniqueId(entry?.id, `seat-${index + 1}`, seatIds),
      name: text(entry?.name) || `Место ${index + 1}`, role,
      functions: [...new Set(suppliedFunctions)].filter(key => CONSTRUCT_CREW_FUNCTIONS.includes(key)),
      slotId: text(entry?.slotId), slotIndex: Math.trunc(number(entry?.slotIndex, 0, 0, 10000)),
      partSlotId: text(entry?.partSlotId), systemIds: [...new Set(entries(entry?.systemIds).map(text).filter(Boolean))],
      reloadPartSlotIds: [...new Set(entries(entry?.reloadPartSlotIds).slice(0, 256).map(text).filter(Boolean))],
      personalWeapons: normalizeConstructPersonalWeapons(entry?.personalWeapons)
    };
  }).filter(seat => {
    if (!seat.slotId) return true;
    const ref = `${seat.slotId}:${seat.slotIndex}`;
    if (seatRefs.has(ref)) return false;
    seatRefs.add(ref);
    return true;
  });
  for (const seat of seats) if (!anchorById.has(seat.personalWeapons.anchorId)) seat.personalWeapons.anchorId = "";
  return { version: 1, enabled: Boolean(source.enabled), baseImage: imagePath(source.baseImage),
    hullRotationCost: normalizeRotationCost(source.hullRotationCost), anchors, parts, seats };
}

export function getConstructVisualConfig(actorOrConfig = null) {
  const raw = actorOrConfig?.getFlag?.("fallout-maw", CONSTRUCT_VISUAL_FLAG)
    ?? actorOrConfig?.flags?.["fallout-maw"]?.[CONSTRUCT_VISUAL_FLAG]
    ?? actorOrConfig?._source?.flags?.["fallout-maw"]?.[CONSTRUCT_VISUAL_FLAG]
    ?? (isActorInput(actorOrConfig) ? {} : actorOrConfig);
  return normalizeConstructVisual(raw);
}

export const getActorConstructVisual = getConstructVisualConfig;

export function getConstructVisualSeatDefinitions(actorOrConfig = null) {
  return getConstructVisualConfig(actorOrConfig).seats;
}

export function normalizeConstructVisualRotation(angle = 0) {
  const finite = Number(angle);
  return Number.isFinite(finite) ? ((finite + 180) % 360 + 360) % 360 - 180 : 0;
}

export function clampConstructVisualRotation(angle, min = -180, max = 180) {
  const normalized = normalizeConstructVisualRotation(angle);
  const low = number(min, -180, -360, 360);
  const high = number(max, 180, -360, 360);
  if (high - low >= 360) return normalized;
  return Math.min(Math.max(normalized, Math.min(low, high)), Math.max(low, high));
}

export function rotateConstructVisualOffset(x, y, rotation, { width = 1, height = 1 } = {}) {
  const w = number(width, 1, 0.0001, 1000000);
  const h = number(height, 1, 0.0001, 1000000);
  const angle = normalizeConstructVisualRotation(rotation) * Math.PI / 180;
  return { x: (x * w * Math.cos(angle) - y * h * Math.sin(angle)) / w,
    y: (x * w * Math.sin(angle) + y * h * Math.cos(angle)) / h };
}

/** Returns normalized anchor transforms, with rotating part parents resolved. */
export function resolveConstructVisualAnchors(actorOrConfig, options = {}) {
  return resolveModel(actorOrConfig, options).anchors;
}

/** A hidden layer remains in this list to make missing/broken modules inspectable. */
export function resolveConstructVisualLayers(actorOrConfig, options = {}) {
  return resolveModel(actorOrConfig, options).layers;
}

export const buildConstructVisualLayers = resolveConstructVisualLayers;

function resolveModel(actorOrConfig, options) {
  const runtime = getRuntimeModel(actorOrConfig);
  const config = runtime?.config ?? getConstructVisualConfig(actorOrConfig);
  const state = runtime?.state ?? (isActorInput(actorOrConfig) ? readActorSlotState(actorOrConfig) : {});
  const installed = asSet(options.installedSlots ?? state.installed);
  const broken = asSet(options.brokenSlots ?? state.broken) ?? new Set();
  const missing = asSet(options.missingSlots ?? state.missing) ?? new Set();
  const rotations = options.rotations ?? options.partRotations ?? options.token?.getFlag?.("fallout-maw", CONSTRUCT_VISUAL_STATE_FLAG)?.rotations
    ?? options.token?.flags?.["fallout-maw"]?.[CONSTRUCT_VISUAL_STATE_FLAG]?.rotations ?? {};
  const cacheable = runtime && options.installedSlots === undefined && options.brokenSlots === undefined && options.missingSlots === undefined;
  const rotationEntries = rotations instanceof Map ? [...rotations] : Object.entries(rotations);
  const rotationAnchors = options.rotationAnchors ?? {};
  const rotationOverrides = options.rotationOverrides ?? {};
  const signature = cacheable ? JSON.stringify([options.width ?? 1, options.height ?? 1, Boolean(options.includeUninstalled),
    rotationEntries.sort(([a], [b]) => String(a).localeCompare(String(b))), rotationAnchors, rotationOverrides]) : "";
  if (cacheable && runtime.resolved.has(signature)) return runtime.resolved.get(signature);
  const anchorById = new Map(config.anchors.map(anchor => [anchor.id, anchor]));
  const partBySlot = new Map(config.parts.map(part => [part.slotId, part]));
  const resolved = new Map();
  const resolving = new Set();
  const partAngle = (part, anchor) => {
    const override = rotationOverrides[part.slotId];
    const saved = rotations instanceof Map ? rotations.get(part.slotId) : rotations?.[part.slotId];
    const reference = rotationAnchors[part.slotId];
    const runtime = Number.isFinite(Number(override)) && override !== null && override !== undefined ? override
      : Number.isFinite(Number(saved)) && saved !== null && saved !== undefined
        ? Number(saved) + (reference !== null && reference !== undefined && Number.isFinite(Number(reference))
          ? anchor.rotation - Number(reference) : 0) : saved;
    const angle = part.rotates && Number.isFinite(Number(runtime)) && runtime !== null && runtime !== undefined
      ? Number(runtime) : anchor.rotation + part.rotation;
    return normalizeConstructVisualRotation(part.rotates
      ? anchor.rotation + clampConstructVisualRotation(angle - anchor.rotation, part.minRotation, part.maxRotation)
      : angle);
  };
  const resolve = id => {
    if (resolved.has(id)) return resolved.get(id);
    const anchor = anchorById.get(id);
    if (!anchor) return { id: "", x: 0.5, y: 0.5, rotation: 0, parentVisible: true };
    if (resolving.has(id)) return { ...anchor, parentId: "", parentSlotId: "", parentVisible: true };
    resolving.add(id);
    const parentPart = partBySlot.get(anchor.parentSlotId);
    const parentAnchorId = parentPart?.anchorId || anchor.parentId;
    let result = { ...anchor, parentVisible: true };
    if (parentPart || parentAnchorId) {
      const parent = resolve(parentAnchorId);
      const angle = parentPart ? partAngle(parentPart, parent) : parent.rotation;
      const offset = rotateConstructVisualOffset(anchor.x, anchor.y, angle, options);
      const partVisible = !parentPart || (installed === null || installed.has(parentPart.slotId))
        && !missing.has(parentPart.slotId) && !broken.has(parentPart.slotId);
      result = { ...anchor, x: parent.x + offset.x, y: parent.y + offset.y,
        rotation: normalizeConstructVisualRotation(angle + anchor.rotation),
        parentVisible: parent.parentVisible && partVisible };
    }
    resolving.delete(id);
    resolved.set(id, result);
    return result;
  };
  const layers = config.parts.map(part => {
    const anchor = resolve(part.anchorId);
    const isBroken = broken.has(part.slotId);
    const isInstalled = installed === null || installed.has(part.slotId);
    return { ...part, x: anchor.x, y: anchor.y, rotation: partAngle(part, anchor),
      img: isBroken ? part.damagedImg : part.img, installed: isInstalled, broken: isBroken,
      visible: Boolean((options.includeUninstalled || isInstalled) && !missing.has(part.slotId)
        && anchor.parentVisible && (isBroken ? part.damagedImg : part.img)) };
  }).sort((a, b) => a.zIndex - b.zIndex || a.id.localeCompare(b.id));
  config.anchors.forEach(anchor => resolve(anchor.id));
  const result = { config, anchors: [...resolved.values()], layers };
  if (cacheable) {
    if (runtime.resolved.size >= 8) runtime.resolved.delete(runtime.resolved.keys().next().value);
    runtime.resolved.set(signature, result);
  }
  return result;
}

function readActorSlotState(actor) {
  const installed = new Set(), broken = new Set(), missing = new Set();
  const items = Array.isArray(actor?.items) ? actor.items : actor?.items?.contents ?? [];
  for (const item of items) {
    const system = item?.system ?? {};
    if (item?.type !== "gear" || !system.functions?.constructPart?.enabled || system.placement?.mode !== "constructPart") continue;
    const rawId = text(system.placement.limbKey) || text(item.id ?? item._id);
    const id = rawId.replace(/^constructPart[:.]/, "");
    installed.add(id);
    const condition = system.functions?.condition;
    const limb = actor?.system?.limbs?.[`constructPart:${id}`] ?? actor?.system?.limbs?.[`constructPart.${id}`];
    if (limb?.missing) missing.add(id);
    if (condition?.enabled && Number(condition.max) > 0 && Number(condition.value) <= 0
      || limb && Number(limb.value) <= Number(limb.min ?? 0)) broken.add(id);
  }
  return { installed, broken, missing };
}

function getAnchorDependency(anchor, parts) {
  return parts.get(anchor.parentSlotId)?.anchorId || anchor.parentId;
}

function isActorInput(value) { return Boolean(value?.documentName === "Actor" || value?.type === "construct" || value?.items && value?.system); }
function asSet(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Set) return value;
  if (value instanceof Map) return new Set(value.keys());
  if (Array.isArray(value)) return new Set(value.map(entry => text(entry?.id ?? entry)));
  return new Set(Object.keys(value).filter(key => value[key]));
}
function entries(value) { return Array.isArray(value) ? value : []; }
function text(value) { return String(value ?? "").trim().slice(0, 1000); }
function imagePath(value) {
  const path = text(value);
  return /^(?:javascript|data:text\/html|vbscript):/i.test(path) ? "" : path;
}
function number(value, fallback, min, max) {
  if (value === null || value === "" || value === undefined) return fallback;
  const finite = Number(value);
  return Number.isFinite(finite) ? Math.min(max, Math.max(min, finite)) : fallback;
}
function uniqueId(value, fallback, used) {
  const base = text(value) || fallback;
  let candidate = base, index = 1;
  while (used.has(candidate)) candidate = `${base}-${++index}`;
  used.add(candidate);
  return candidate;
}
