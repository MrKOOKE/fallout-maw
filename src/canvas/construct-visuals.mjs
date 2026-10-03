import {
  getConstructVisualRuntimeConfig as getConstructVisualConfig, getConstructVisualRuntimeRevision,
  resolveConstructVisualLayers, resolveConstructVisualAnchors,
  normalizeConstructVisualRotation, clampConstructVisualRotation, CONSTRUCT_VISUAL_STATE_FLAG
} from "../utils/construct-visual-model.mjs";
import { calculateConstructAimRotation, constructLocalToWorld, isConstructAimWithinSector, advanceConstructRotation } from "../utils/construct-aim-geometry.mjs";
import { canUserControlConstruct, getConstructWeaponPartSlotId } from "../utils/construct-crew.mjs";
import { canUserUseConstructWeapon, getConstructWeaponOperatorConfig } from "../utils/construct-weapon-operator.mjs";
import { isConstructPersonalWeapon, getConstructPersonalWeaponAimOrigin, getConstructPersonalWeaponSeat,
  getConstructFiringPortWorldTransform, validateConstructPersonalWeaponAim } from "./construct-firing-ports.mjs";
import { constrainConstructFiringPortAimPoint } from "../utils/construct-firing-port-model.mjs";
import { setConstructMotionSound } from "../constructs/system-sounds.mjs";
import { planConstructRotation, purchaseConstructRotation, isConstructRotationPaid, recordConstructRotationProgress, registerConstructRotationTurns,
  getConstructRotationBoundaries, getConstructRotationAngle } from "../constructs/rotation-actions.mjs";
import { refreshConstructRotationLimits, registerConstructRotationLimits, getConstructRotationGuideBounds } from "./construct-rotation-limits.mjs";
import { AimActivationGate } from "../utils/aim-activation-gate.mjs";
import { AimActivationPreview, notifyAimActivationRequired } from "./aim-activation-preview.mjs";
import { registerConstructVisualPreviewSocket, publishConstructVisualPreview, clearConstructVisualPreview,
  validateConstructVisualRotationCommit, resetConstructVisualRotationHistory } from "./construct-visual-preview-socket.mjs";

const SYSTEM = "fallout-maw";
const states = new Map();
const previews = new WeakMap();
const rotatingPreviews = new Map();
const actorModels = new WeakMap();
const imageCache = new Map();
const imageBounds = new WeakMap();
const previewAccess = new WeakMap();
let modelRevision = 0;
let tickerAttached = false;
let tickTime = 0;
let registered = false;
let aimSession = null;

export function registerConstructVisualHooks({ getSelectedContext } = {}) {
  if (registered) return;
  registered = true;
  registerConstructRotationTurns({ partRotations: doc => getConstructPartRotations(doc.object ?? { document: doc }) });
  registerConstructRotationLimits({ getSelectedContext, getPartPose: getConstructPartRotationLimitsPose,
    getAimingSlot: token => [...rotatingPreviews.get(token) ?? []].find(([, motion]) => !motion.stopping)?.[0]
      ?? (aimSession?.token === token ? aimSession.slotId : "") });
  const registerPreview = () => registerConstructVisualPreviewSocket({
    getRotations: getConstructPartRotations,
    onPreview: ({ token, slotId, rotation }) => {
      if (rotatingPreviews.get(token)?.has(slotId)) return;
      previews.set(token, { ...(previews.get(token) ?? {}), [slotId]: rotation });
      void syncConstructVisual(token, { rotationsDirty: true });
      refreshConstructRotationLimits(token);
    },
    onClear: ({ token, slotId }) => {
      if (rotatingPreviews.get(token)?.has(slotId)) return;
      const rotations = { ...(previews.get(token) ?? {}) }; delete rotations[slotId];
      previews.set(token, rotations);
      void syncConstructVisual(token, { rotationsDirty: true });
      refreshConstructRotationLimits(token);
    }
  });
  if (game.ready) registerPreview(); else Hooks.once("ready", registerPreview);
  Hooks.on("drawToken", token => { void syncConstructVisual(token); });
  Hooks.on("refreshToken", token => {
    void syncConstructVisual(token);
    if (aimSession?.token === token) aimSession.updatePreview();
  });
  Hooks.on("updateToken", (doc, changes) => {
    finishStoppedConstructRotations(doc.object);
    const delta = changes?.delta;
    const replaceDelta = Object.hasOwn(changes ?? {}, "-=delta") || Object.hasOwn(changes ?? {}, "delta")
      && (delta === null || typeof delta !== "object" || Object.hasOwn(delta, "_id"));
    void syncConstructVisual(doc.object, { rotationsDirty: hasVisualChange(changes, `flags.${SYSTEM}.${CONSTRUCT_VISUAL_STATE_FLAG}`),
      modelDirty: hasVisualChange(changes, "actorId") || replaceDelta
        || hasVisualChange(changes, `delta.flags.${SYSTEM}.constructVisual`) || hasVisualChange(changes, "delta.system.limbs")
        || hasVisualChange(changes, "delta.type") });
  });
  for (const hook of ["updateActor", "updateItem", "createItem", "deleteItem", "createActiveEffect", "updateActiveEffect", "deleteActiveEffect"]) {
    Hooks.on(hook, (document, changes) => {
      const actor = document.documentName === "Actor" ? document : document.actor ?? document.parent?.actor ?? document.parent;
      const relevant = hook !== "updateActor" && hook !== "updateItem" || (hook === "updateActor"
        ? hasVisualChange(changes, `flags.${SYSTEM}.constructVisual`) || hasVisualChange(changes, "system.limbs") || hasVisualChange(changes, "type")
        : hasVisualChange(changes, "system.placement") || hasVisualChange(changes, "system.functions.condition")
          || hasVisualChange(changes, "system.functions.constructPart"));
      if (!actor || !relevant) return;
      actorModels.delete(actor);
      const tokens = new Set([...states.keys(), ...canvas?.tokens?.placeables ?? []]);
      for (const token of tokens) if (token.actor?.uuid === actor.uuid) void syncConstructVisual(token);
    });
  }
  Hooks.on("destroyToken", destroyConstructVisual);
  Hooks.on("canvasTearDown", () => {
    aimSession?.cancel();
    for (const token of [...states.keys()]) destroyConstructVisual(token);
  });
}

export function getConstructPartRotations(token) {
  return { ...(token?.document?.getFlag?.(SYSTEM, CONSTRUCT_VISUAL_STATE_FLAG)?.rotations ?? {}),
    ...(token?.isPreview ? states.get(token)?.snapshotRotations ?? previews.get(token._original) ?? {} : {}),
    ...(previews.get(token) ?? {}) };
}

function hasVisualChange(changes, prefix) {
  if (!changes || typeof changes !== "object") return false;
  for (const [key, value] of Object.entries(changes)) {
    const clean = key.replace(/(^|\.)-=/g, "$1");
    if (clean === prefix || clean.startsWith(`${prefix}.`)) return true;
    if (prefix.startsWith(`${clean}.`) && hasVisualChange(value, prefix.slice(clean.length + 1))) return true;
  }
  return false;
}

function getRenderModel(token, dirty = false) {
  const actor = token._original?.actor ?? token.actor;
  if (!actor || actor.type !== "construct") return null;
  if (dirty) actorModels.delete(actor);
  let model = actorModels.get(actor);
  if (model) return model;
  model = { actor, config: getConstructVisualConfig(actor), revision: ++modelRevision };
  actorModels.set(actor, model);
  return model;
}

function visualOptions(token, rotations = getConstructPartRotations(token)) {
  const scale = tokenVisualScale(token);
  return { rotations, width: token.w * scale.x, height: token.h * scale.y };
}

function tokenVisualScale(token) {
  const native = token.mesh;
  return { x: Number(native?.width) > 0 && token.w > 0 ? native.width / token.w : Math.abs(Number(token.document.texture?.scaleX) || 1),
    y: Number(native?.height) > 0 && token.h > 0 ? native.height / token.h : Math.abs(Number(token.document.texture?.scaleY) || 1),
    signX: Math.sign(native?.scale?.x ?? Number(token.document.texture?.scaleX)) || 1,
    signY: Math.sign(native?.scale?.y ?? Number(token.document.texture?.scaleY)) || 1,
    anchorX: native?.anchor?.x ?? token.document.texture?.anchorX ?? 0.5,
    anchorY: native?.anchor?.y ?? token.document.texture?.anchorY ?? 0.5 };
}

function constructPointToWorld(point, token) {
  const scale = tokenVisualScale(token);
  return constructLocalToWorld({ x: 0.5 + (point.x - scale.anchorX) * scale.x * scale.signX,
    y: 0.5 + (point.y - scale.anchorY) * scale.y * scale.signY }, tokenFrame(token));
}

function mirrorConstructRotation(token, rotation) {
  const { signX, signY } = tokenVisualScale(token), radians = rotation * Math.PI / 180;
  return normalizeConstructVisualRotation(Math.atan2(signX * Math.sin(radians), signY * Math.cos(radians)) * 180 / Math.PI);
}

function tokenFrame(token) {
  // The mesh center follows native movement animations and drag previews.
  const mesh = token.mesh;
  return { x: (mesh?.position?.x ?? token.center.x) - token.w / 2,
    y: (mesh?.position?.y ?? token.center.y) - token.h / 2,
    width: token.w, height: token.h, rotation: token.document.lockRotation ? 0 : (mesh?.angle ?? token.document.rotation) };
}

/** Guides use the exact pivot and mirroring of the rendered barrel. */
export function getConstructPartRotationLimitsPose(token, slotId) {
  const layer = resolveConstructVisualLayers(token.actor, visualOptions(token)).find(row => row.slotId === slotId);
  if (!layer?.visible || layer.broken) return null;
  return { origin: constructPointToWorld(layer, token),
    toWorldAngle: angle => tokenFrame(token).rotation + mirrorConstructRotation(token, angle) };
}

export function getConstructPartRotationActivationSector(token, slotId) {
  const context = getConstructRotationBoundaries(token.document, slotId);
  if (!context) return null;
  const pose = getConstructPartRotationLimitsPose(token, slotId);
  if (!pose) return null;
  const bounds = getConstructRotationGuideBounds(context, slotId);
  const { signX, signY } = tokenVisualScale(token), direction = signX * signY;
  const offsets = [bounds.min, bounds.max].map(angle => (angle - context.state.origin) * direction);
  return { origin: pose.origin, rotation: pose.toWorldAngle(context.state.origin),
    minRotation: Math.min(...offsets), maxRotation: Math.max(...offsets),
    initialRotation: pose.toWorldAngle(getConstructRotationAngle(token.document, slotId)),
    radius: Math.max(token.w, token.h) * 1.15,
    seedDistance: Math.max(token.w, token.h) * 1.5 };
}

export function getConstructWeaponRotationActivationSector(controller) {
  if (controller?.token?.actor?.type !== "construct" || isConstructPersonalWeapon(controller.token, controller.weapon)) return null;
  const slotId = getConstructWeaponControlSlot(controller.token.actor, controller.weapon, controller.weaponFunctionId);
  return slotId ? getConstructPartRotationActivationSector(controller.token, slotId) : null;
}

function getConstructWeaponControlSlot(actor, weapon, weaponFunctionId = "") {
  return getConstructWeaponOperatorConfig(weapon, weaponFunctionId).partSlotId
    || getConstructWeaponPartSlotId(actor, weapon);
}

/** One native primary mesh applies lighting, occlusion and drag opacity to the whole assembly. */
export function syncConstructVisual(token, { rotationsDirty = false, modelDirty = false } = {}) {
  if (!token?.document || token.destroyed || !token.mesh || !canvas?.primary) return;
  const model = getRenderModel(token, modelDirty);
  if (!model?.config.enabled || !model.config.parts.length && !model.config.baseImage) {
    destroyConstructVisual(token);
    return;
  }
  let state = states.get(token);
  if (!state) {
    const mesh = new foundry.canvas.primary.PrimarySpriteMesh({ name: `${token.objectId}.construct.composite`, object: token });
    mesh.eventMode = "none";
    mesh.hoverFade = false;
    mesh.visible = false;
    canvas.primary.addChild(mesh);
    state = { mesh, meshes: new Map([["composite", mesh]]), generation: 0,
      baseRenderable: token.mesh.renderable, baseMesh: token.mesh, model, rotations: {}, layoutDirty: true,
      renderCount: 0, resolveCount: 0, frameCount: 0 };
    bindCompositeContainment(state);
    states.set(token, state);
    const original = token.isPreview && states.get(token._original);
    if (original) {
      state.snapshotRotations = { ...original.rotations };
      state.rotations = { ...original.rotations };
      if (original.composite?.ready && original.model === model) {
        setComposite(state, original.composite);
        state.model = original.model;
        state.layoutDirty = false;
      }
    }
  }
  syncConstructInterfaceVoid(token, state);
  const { x: sx, y: sy } = tokenVisualScale(token);
  const width = token.w * sx, height = token.h * sy;
  if (!(width > 0 && height > 0)) return;
  const aspect = width / height;
  if (state.model !== model || Math.abs((state.aspect ?? state.composite?.aspect ?? aspect) - aspect) > 0.000001) {
    state.model = model;
    state.layoutDirty = true;
  }
  state.aspect = aspect;
  if (rotationsDirty || state.layoutDirty && !state.snapshotRotations) {
    state.rotations = getConstructPartRotations(token);
    state.rotationsDirty = true;
  }
  state.frameCount++;
  if (state.layoutDirty || state.rotationsDirty) updateComposite(token, state, width, height);
  positionComposite(token, state, width, height);
  // Body motion only reaches this cheap native-state copy; cached pixels remain untouched.
  return state.loading;
}

function resolveRenderLayers(state, width, height) {
  const model = state.model;
  const layers = [...resolveConstructVisualLayers(model.actor, { width, height, rotations: state.rotations })];
  if (model.config.baseImage) layers.unshift({ id: "__constructBaseImage", img: model.config.baseImage,
    x: 0.5, y: 0.5, width: 1, height: 1, pivotX: 0.5, pivotY: 0.5, rotation: 0,
    zIndex: -10000, visible: true });
  state.resolveCount++;
  return layers;
}

function isValidImage(texture) {
  return texture && texture !== PIXI.Texture.EMPTY && !texture.destroyed
    && (texture.valid ?? texture.baseTexture?.valid ?? false);
}

function loadCompositeImage(img) {
  let entry = imageCache.get(img);
  if (entry && (entry.promise || isValidImage(entry.texture) || entry.failed)) return entry;
  entry = { texture: null, promise: null, failed: false };
  imageCache.set(img, entry);
  entry.promise = Promise.resolve(foundry.canvas.loadTexture(img)).then(texture => {
    entry.texture = isValidImage(texture) ? texture : null;
    entry.failed = !entry.texture;
  }).catch(error => {
    entry.failed = true;
    console.warn("Fallout-MaW | Construct image could not load", img, error);
  }).finally(() => { entry.promise = null; });
  return entry;
}

function updateComposite(token, state, width, height) {
  if (state.loading) return;
  const layoutDirty = state.layoutDirty;
  const composite = state.composite;
  const sameAspect = composite && Math.abs(composite.aspect - width / height) <= 0.000001;
  const basisWidth = sameAspect ? composite.width : width;
  const basisHeight = sameAspect ? composite.height : height;
  const layers = resolveRenderLayers(state, basisWidth, basisHeight);
  const paths = new Set(layers.filter(layer => layer.visible && layer.img).map(layer => layer.img));
  const pending = [];
  for (const img of paths) {
    const entry = loadCompositeImage(img);
    if (entry.promise) pending.push(entry.promise);
  }
  if (pending.length) {
    const generation = ++state.generation;
    state.loading = Promise.all(pending).then(() => {
      if (token.destroyed || states.get(token) !== state || state.generation !== generation) return;
      state.loading = null;
      syncConstructVisual(token);
    }).catch(error => {
      if (states.get(token) === state) state.loading = null;
      console.warn("Fallout-MaW | Construct assembly could not load", error);
    });
    return;
  }
  const bounds = layoutDirty || !composite
    ? compositeSweepBounds(state.model.config, layers, basisWidth, basisHeight) : composite.bounds;
  const sameBounds = composite && ["x", "y", "width", "height"].every(key => composite.bounds[key] === bounds[key]);
  if (!composite || composite.refs > 1 || !sameAspect || !sameBounds) {
    // Shared drag snapshots are immutable: a changing assembly gets its own retained buffer.
    const next = createComposite(state, layers, basisWidth, basisHeight, bounds);
    setComposite(state, next);
  }
  renderComposite(state, layers);
  state.layoutDirty = false;
  state.rotationsDirty = false;
}

function textureContentBounds(texture) {
  let bounds = imageBounds.get(texture);
  if (bounds) return bounds;
  const data = foundry.canvas.TextureLoader?.getTextureAlphaData?.(texture, 0.25);
  bounds = data && data.width > 0 && data.height > 0 ? {
    x0: Math.max(0, (data.minX - 1) / data.width), y0: Math.max(0, (data.minY - 1) / data.height),
    x1: Math.min(1, (data.maxX + 1) / data.width), y1: Math.min(1, (data.maxY + 1) / data.height)
  } : { x0: 0, y0: 0, x1: 1, y1: 1 };
  imageBounds.set(texture, bounds);
  return bounds;
}

/** Reserve the full local sweep once, so turning a barrel never reallocates or clips it. */
function compositeSweepBounds(config, layers, width, height) {
  const anchors = new Map(config.anchors.map(anchor => [anchor.id, anchor]));
  const parts = new Map(config.parts.map(part => [part.slotId, part]));
  const resolved = new Map();
  const resolve = id => {
    if (resolved.has(id)) return resolved.get(id);
    const anchor = anchors.get(id);
    if (!anchor) return { x: width / 2, y: height / 2, radius: 0, rotation: 0, rotating: false };
    // Normalized configuration has already removed dependency cycles.
    const parentPart = parts.get(anchor.parentSlotId);
    const parentId = parentPart?.anchorId || anchor.parentId;
    let result;
    if (parentPart || parentId) {
      const parent = resolve(parentId);
      const rotating = parent.rotating || Boolean(parentPart?.rotates);
      const rotation = parent.rotation + (parentPart?.rotation ?? 0);
      const dx = anchor.x * width, dy = anchor.y * height;
      const radians = rotation * Math.PI / 180;
      result = rotating ? { x: parent.x, y: parent.y, radius: parent.radius + Math.hypot(dx, dy),
        rotation: 0, rotating: true } : { x: parent.x + dx * Math.cos(radians) - dy * Math.sin(radians),
        y: parent.y + dx * Math.sin(radians) + dy * Math.cos(radians), radius: parent.radius,
        rotation: rotation + anchor.rotation, rotating: false };
    } else result = { x: anchor.x * width, y: anchor.y * height, radius: 0,
      rotation: anchor.rotation, rotating: false };
    resolved.set(id, result);
    return result;
  };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const include = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const layer of layers) {
    const texture = imageCache.get(layer.img)?.texture;
    if (!layer.visible || !isValidImage(texture)) continue;
    const bounds = textureContentBounds(texture), parent = resolve(layer.anchorId);
    const w = layer.width * width, h = layer.height * height;
    const corners = [[bounds.x0, bounds.y0], [bounds.x1, bounds.y0], [bounds.x1, bounds.y1], [bounds.x0, bounds.y1]]
      .map(([x, y]) => ({ x: (x - layer.pivotX) * w, y: (y - layer.pivotY) * h }));
    if (layer.rotates || parent.rotating) {
      const radius = parent.radius + Math.max(...corners.map(point => Math.hypot(point.x, point.y)));
      include(parent.x - radius, parent.y - radius); include(parent.x + radius, parent.y + radius);
    } else {
      const radians = layer.rotation * Math.PI / 180;
      for (const point of corners) include(layer.x * width + point.x * Math.cos(radians) - point.y * Math.sin(radians),
        layer.y * height + point.x * Math.sin(radians) + point.y * Math.cos(radians));
    }
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, width: Math.max(1, width), height: Math.max(1, height) };
  x0 = Math.floor(x0) - 2; y0 = Math.floor(y0) - 2;
  return { x: x0, y: y0, width: Math.max(1, Math.ceil(x1) + 2 - x0), height: Math.max(1, Math.ceil(y1) + 2 - y0) };
}

function createComposite(state, layers, width, height, bounds) {
  const gl = canvas.app.renderer.gl;
  const maxSize = Math.min(2048, Number(gl?.getParameter?.(gl.MAX_TEXTURE_SIZE)) || 2048);
  const resolution = Math.min(2, maxSize / Math.max(bounds.width, bounds.height));
  const texture = PIXI.RenderTexture.create({ width: bounds.width, height: bounds.height,
    resolution, scaleMode: PIXI.SCALE_MODES.LINEAR });
  texture.baseTexture.clearColor = [0, 0, 0, 0];
  const container = new PIXI.Container();
  container.position.set(-bounds.x, -bounds.y);
  return { texture, container, sprites: new Map(), bounds, width, height, aspect: width / height,
    refs: 0, ready: false, hasContent: false, renderCount: 0, alphaRevision: -1, alphaData: null };
}

/** Mutable render textures need current pixels; Foundry's image cache assumes immutable textures. */
function bindCompositeContainment(state) {
  for (const method of ["containsCanvasPoint", "containsPoint"]) {
    const nativeContains = state.mesh[method];
    state.mesh[method] = function(point, threshold = this.textureAlphaThreshold) {
      if (threshold > 0 && threshold <= 1) refreshCompositeAlphaData(state);
      return nativeContains.call(this, point, threshold);
    };
  }
}

function refreshCompositeAlphaData(state) {
  const composite = state.composite;
  if (!composite?.ready || !composite.texture.valid) return;
  if (composite.alphaRevision !== composite.renderCount) {
    composite.alphaData = extractCompositeAlphaData(composite.texture);
    composite.alphaRevision = composite.renderCount;
  }
  if (state.mesh._textureAlphaData !== composite.alphaData) {
    state.mesh._textureAlphaData = composite.alphaData;
    // Native containment checks canvas bounds before sampling, so new silhouette bounds must be live too.
    state.mesh._canvasBoundsID++;
  }
}

function extractCompositeAlphaData(texture) {
  // Match native PrimarySpriteMesh's quarter-resolution CPU alpha representation without its immutable cache.
  const width = Math.max(1, Math.ceil(Math.round(texture.width * texture.resolution) * 0.25));
  const height = Math.max(1, Math.ceil(Math.round(texture.height * texture.resolution) * 0.25));
  const sprite = new PIXI.Sprite(texture);
  sprite.anchor.set(0, 0);
  sprite.width = width;
  sprite.height = height;
  const raster = PIXI.RenderTexture.create({ width, height, resolution: 1 });
  raster.baseTexture.clearColor = [0, 0, 0, 0];
  let pixels;
  try {
    canvas.app.renderer.render(sprite, { renderTexture: raster, clear: true });
    pixels = canvas.app.renderer.extract.pixels(raster);
  } finally {
    sprite.destroy({ texture: false, baseTexture: false });
    raster.destroy(true);
  }
  let minX = width, minY = height, maxX = 0, maxY = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!pixels[(width * y + x) * 4 + 3]) continue;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + 1); maxY = Math.max(maxY, y + 1);
  }
  if (minX > maxX) minX = minY = maxX = maxY = 0;
  const data = new Uint8Array((maxX - minX) * (maxY - minY));
  for (let y = minY, index = 0; y < maxY; y++) for (let x = minX; x < maxX; x++, index++) {
    data[index] = pixels[(width * y + x) * 4 + 3];
  }
  return { width, height, minX, minY, maxX, maxY, data };
}

function setComposite(state, composite) {
  if (state.composite === composite) return;
  releaseComposite(state.composite);
  state.composite = composite;
  composite.refs++;
  state.mesh.texture = composite.texture;
  state.mesh.anchor.set((composite.width / 2 - composite.bounds.x) / composite.bounds.width,
    (composite.height / 2 - composite.bounds.y) / composite.bounds.height);
}

function releaseComposite(composite) {
  if (!composite || --composite.refs > 0) return;
  // Loaded image textures belong to Foundry; only our raster buffer and display objects are owned here.
  composite.container.destroy({ children: true, texture: false, baseTexture: false });
  composite.texture.destroy(true);
}

function renderComposite(state, layers) {
  const composite = state.composite;
  const wanted = new Set(layers.map(layer => layer.id));
  for (const [id, sprite] of composite.sprites) if (!wanted.has(id)) {
    sprite.destroy({ texture: false, baseTexture: false }); composite.sprites.delete(id);
  }
  let visible = false;
  for (const layer of layers) {
    const texture = imageCache.get(layer.img)?.texture;
    let sprite = composite.sprites.get(layer.id);
    if (!sprite && isValidImage(texture)) {
      sprite = new PIXI.Sprite(texture); composite.sprites.set(layer.id, sprite);
      composite.container.addChild(sprite);
    }
    if (!sprite) continue;
    sprite.visible = Boolean(layer.visible && isValidImage(texture));
    if (!sprite.visible) continue;
    visible = true;
    sprite.texture = texture;
    sprite.anchor.set(layer.pivotX, layer.pivotY);
    sprite.position.set(layer.x * composite.width, layer.y * composite.height);
    sprite.width = layer.width * composite.width;
    sprite.height = layer.height * composite.height;
    sprite.angle = layer.rotation;
    sprite.alpha = 1;
    // Child order comes from the stable layer z-order, never from body movement.
    composite.container.setChildIndex(sprite, composite.container.children.length - 1);
  }
  canvas.app.renderer.render(composite.container, { renderTexture: composite.texture, clear: true });
  composite.hasContent = visible;
  composite.ready = true;
  composite.renderCount++;
  state.renderCount++;
  state.mesh._textureAlphaData = null;
  state.mesh._canvasBoundsID++;
}

function positionComposite(token, state, width, height) {
  const mesh = state.mesh, native = token.mesh, composite = state.composite;
  const ready = composite?.ready;
  if (ready) {
    const scale = tokenVisualScale(token);
    mesh.position.copyFrom(native.position);
    mesh.width = composite.bounds.width * width / composite.width;
    mesh.height = composite.bounds.height * height / composite.height;
    mesh.scale.x = Math.abs(mesh.scale.x) * scale.signX;
    mesh.scale.y = Math.abs(mesh.scale.y) * scale.signY;
    mesh.anchor.set((composite.width * scale.anchorX - composite.bounds.x) / composite.bounds.width,
      (composite.height * scale.anchorY - composite.bounds.y) / composite.bounds.height);
    mesh.angle = token.document.lockRotation ? 0 : native.angle;
  }
  mesh.elevation = native.elevation;
  mesh.sortLayer = native.sortLayer;
  mesh.sort = native.sort;
  mesh.zIndex = native.zIndex;
  mesh.alpha = native.alpha;
  mesh.unoccludedAlpha = native.unoccludedAlpha;
  mesh.tint = native.tint;
  mesh.occludedAlpha = native.occludedAlpha;
  mesh.textureAlphaThreshold = native.textureAlphaThreshold;
  mesh.hidden = native.hidden;
  mesh.occlusionMode = native.occlusionMode;
  mesh.occluded = native.occluded;
  mesh.visible = Boolean(ready && composite.hasContent && native.visible && token.visible && token.renderable);
  mesh.renderable = Boolean(ready && composite.hasContent && token.renderable);
  // While first-use images load, the native assembled image remains the fallback.
  native.renderable = ready ? false : state.baseRenderable;
}

function syncConstructInterfaceVoid(token, state) {
  const voidMesh = token.voidMesh;
  if (!voidMesh || state.voidMesh === voidMesh) return;
  state.voidMesh = voidMesh;
  state.baseVoidRender = voidMesh.render;
  state.renderVoid = renderer => {
    if (token.mesh?.renderable) return state.baseVoidRender?.call(voidMesh, renderer);
    // Native tokens erase interface/grid through their rendered pixel silhouette.
    // Their original mesh is hidden here, so the single composite supplies the silhouette.
    if (!state.mesh.destroyed) state.mesh._renderVoid?.(renderer);
  };
  voidMesh.render = state.renderVoid;
}

export function destroyConstructVisual(token) {
  const state = states.get(token);
  if (!state) return;
  if (!token.isPreview) clearConstructVisualPreview({ token });
  state.generation++;
  if (!state.mesh.destroyed) state.mesh.destroy();
  releaseComposite(state.composite);
  if (state.voidMesh?.render === state.renderVoid) state.voidMesh.render = state.baseVoidRender;
  if (state.baseMesh && !state.baseMesh.destroyed) state.baseMesh.renderable = state.baseRenderable;
  states.delete(token);
  previews.delete(token);
  rotatingPreviews.delete(token);
  setConstructMotionSound(token, "rotate", false);
}

export function previewConstructPartRotation(token, slotId, rotation, { controller = null } = {}) {
  const part = getConstructVisualConfig(token.actor).parts.find(part => part.slotId === slotId);
  if (!part) return;
  let motions = rotatingPreviews.get(token);
  if (!motions) { motions = new Map(); rotatingPreviews.set(token, motions); }
  let motion = motions.get(slotId);
  if (!motion) {
    const layer = resolveConstructVisualLayers(token.actor, visualOptions(token)).find(layer => layer.slotId === slotId);
    motion = { current: layer?.rotation ?? 0, revision: 0 };
    motions.set(slotId, motion);
  }
  if (motion.stopping && motion.stopPromise && !motion.stopFailed) {
    // A context switch waits for this reached angle's handoff before resuming.
    // Otherwise later frames could invalidate an earlier in-flight rate commit.
    motion.resume = { rotation, controller };
    return;
  }
  if (motion.stopping || motion.controller !== controller) motion.revision++;
  motion.stopping = false;
  motion.stopFailed = false;
  motion.committedRotation = null;
  const targetLayers = resolveConstructVisualLayers(token.actor, visualOptions(token, { ...getConstructPartRotations(token), [slotId]: rotation }));
  motion.target = targetLayers.find(layer => layer.slotId === slotId)?.rotation ?? rotation;
  motion.speed = part.rotationSpeed;
  const anchor = resolveConstructVisualAnchors(token.actor, visualOptions(token)).find(anchor => anchor.id === part.anchorId);
  motion.sector = { minRotation: part.minRotation, maxRotation: part.maxRotation, anchorRotation: anchor?.rotation ?? 0 };
  motion.controller = controller;
  motion.authorization = { weapon: controller?.weapon ?? null, weaponFunctionId: controller?.weaponFunctionId ?? "",
    passengerId: controller?.operatorPassengerId ?? "" };
  if (!tickerAttached && canvas?.app?.ticker) {
    tickerAttached = true; tickTime = performance.now();
    canvas.app.ticker.add(tickConstructRotations);
  }
}

function tickConstructRotations() {
  const now = performance.now(), dt = Math.min(0.1, Math.max(0, (now - tickTime) / 1000));
  tickTime = now;
  for (const [token, motions] of rotatingPreviews) {
    if (token.destroyed || !states.has(token)) {
      rotatingPreviews.delete(token); setConstructMotionSound(token, "rotate", false); continue;
    }
    let changed = false;
    for (const [slotId, motion] of motions) {
      if (finishStoppedConstructRotation(token, slotId, motion)) continue;
      const requested = advanceConstructRotation(motion.current, motion.target, motion.speed, dt, motion.sector);
      const allowance = planConstructRotation(token.document, slotId, requested, { budget: 0 });
      const current = allowance.powered ? allowance.rotation : motion.current;
      if (allowance.powered && !allowance.reached && !motion.paymentPromise) {
        const affordable = planConstructRotation(token.document, slotId, requested);
        // A failed request retries only when its sector or available budget changes.
        const signature = JSON.stringify([affordable.state.origin, affordable.state.min, affordable.state.max,
          affordable.budget, affordable.profile, Math.sign(normalizeConstructVisualRotation(requested - motion.current))]);
        if (affordable.cost > 0 && motion.blockedPayment !== signature) {
          motion.paymentPromise = requestConstructRotationBudget(token, slotId, requested, motion.authorization)
            .catch(error => { motion.blockedPayment = signature; ui.notifications.warn(error.message); })
            .finally(() => { motion.paymentPromise = null; });
        } else if (!affordable.reached && motion.blockedPayment !== signature) {
          motion.blockedPayment = signature; ui.notifications.warn("Не хватает ОП или энергии для следующего сектора поворота.");
        }
      }
      if (Math.abs(normalizeConstructVisualRotation(current - motion.current)) > 0.0001) {
        changed = true; motion.current = current;
        recordConstructRotationProgress(token.document, slotId, current);
        previews.set(token, { ...(previews.get(token) ?? {}), [slotId]: current });
        motion.controller?.previewFrameScheduler?.request?.();
      }
      publishConstructVisualPreview({ token, slotId, rotation: motion.current,
        ...motion.authorization });
    }
    setConstructMotionSound(token, "rotate", changed);
    if (changed) void syncConstructVisual(token, { rotationsDirty: true });
    refreshConstructRotationLimits(token);
  }
  if (!rotatingPreviews.size) {
    canvas?.app?.ticker?.remove?.(tickConstructRotations);
    tickerAttached = false;
  }
}

/** Stop at the reached angle. Keep the preview until the saved Token yaw arrives. */
export function clearConstructPartPreview(token, slotId = "") {
  const motions = rotatingPreviews.get(token);
  const slots = slotId ? [slotId] : [...new Set([...motions?.keys() ?? [], ...Object.keys(previews.get(token) ?? {})])];
  const stops = slots.map(id => {
    const motion = motions?.get(id);
    if (!motion) { removeConstructPartPreview(token, id); return Promise.resolve(true); }
    if (motion.stopping && motion.stopPromise) { motion.resume = null; return motion.stopPromise; }
    motion.stopping = true;
    motion.target = motion.current;
    motion.controller = null;
    const revision = motion.revision;
    const rotation = motion.current;
    previews.set(token, { ...(previews.get(token) ?? {}), [id]: rotation });
    motion.stopPromise = (async () => {
      const saved = savedConstructPartRotation(token, id);
      if (Number.isFinite(saved) && Math.abs(normalizeConstructVisualRotation(saved - rotation)) <= 0.001) {
        motion.committedRotation = saved;
        finishStoppedConstructRotation(token, id, motion);
        return true;
      }
      // A final reached frame must reach authority before its validated commit.
      publishConstructVisualPreview({ token, slotId: id, rotation, ...motion.authorization, force: true });
      try {
        const result = await requestConstructPartRotation({ tokenUuid: token.document.uuid, slotId: id, rotation });
        if (!result?.ok) throw new Error("Не удалось сохранить достигнутое направление башни.");
        if (motion.revision !== revision || !motion.stopping) return true;
        motion.committedRotation = result.rotation;
        finishStoppedConstructRotation(token, id, motion);
        return true;
      } catch (error) {
        // Retain the reached visual; a failed request cannot reset physical progress.
        motion.stopFailed = true;
        console.warn("Fallout-MaW | Reached construct rotation could not be saved", error);
        globalThis.ui?.notifications?.warn?.(error.message);
        return false;
      }
    })();
    return motion.stopPromise;
  });
  void syncConstructVisual(token, { rotationsDirty: true });
  return Promise.all(stops);
}

function savedConstructPartRotation(token, slotId) {
  const rotations = token.document.getFlag(SYSTEM, CONSTRUCT_VISUAL_STATE_FLAG)?.rotations ?? {};
  return resolveConstructVisualLayers(token.actor, visualOptions(token, rotations)).find(layer => layer.slotId === slotId)?.rotation;
}

function finishStoppedConstructRotations(token) {
  if (!token) return;
  for (const [slotId, motion] of rotatingPreviews.get(token) ?? []) finishStoppedConstructRotation(token, slotId, motion);
}

function finishStoppedConstructRotation(token, slotId, motion) {
  if (!motion.stopping || !Number.isFinite(motion.committedRotation)) return false;
  const saved = savedConstructPartRotation(token, slotId);
  if (!Number.isFinite(saved) || Math.abs(normalizeConstructVisualRotation(saved - motion.committedRotation)) > 0.001) return false;
  const resume = motion.resume;
  removeConstructPartPreview(token, slotId, motion.committedRotation);
  if (resume && !resume.controller?.destroyed) previewConstructPartRotation(token, slotId, resume.rotation, { controller: resume.controller });
  return true;
}

function removeConstructPartPreview(token, slotId, committedRotation = null) {
  clearConstructVisualPreview({ token, slotId, committedRotation });
  const rotations = { ...(previews.get(token) ?? {}) }; delete rotations[slotId]; previews.set(token, rotations);
  rotatingPreviews.get(token)?.delete(slotId);
  if (!rotatingPreviews.get(token)?.size) rotatingPreviews.delete(token);
  void syncConstructVisual(token, { rotationsDirty: true });
  refreshConstructRotationLimits(token);
}

export function getConstructPartAim(token, slotId, point, { muzzleAnchorId = "" } = {}) {
  const config = getConstructVisualConfig(token?.actor);
  const part = config.parts.find(part => part.slotId === slotId && part.rotates);
  if (!config.enabled || !part) return null;
  const options = visualOptions(token);
  const layer = resolveConstructVisualLayers(token.actor, options).find(layer => layer.slotId === slotId);
  if (!layer?.visible || layer.broken) return null;
  const anchor = resolveConstructVisualAnchors(token.actor, options).find(anchor => anchor.id === part.anchorId);
  const frame = tokenFrame(token);
  const origin = constructPointToWorld(layer, token);
  let rotation = calculateConstructAimRotation({ origin, point, bodyRotation: frame.rotation });
  if (rotation === null) return null;
  // Account for an off-center barrel: its ray must converge on the cursor.
  const muzzle = resolveConstructVisualAnchors(token.actor, options).find(anchor => anchor.id === (muzzleAnchorId || part.muzzleAnchorId) && anchor.parentVisible);
  if (muzzleAnchorId && !muzzle) return null;
  if (muzzle) {
    const muzzleWorld = constructPointToWorld(muzzle, token);
    const radians = (frame.rotation + mirrorConstructRotation(token, layer.rotation)) * Math.PI / 180;
    const lateral = (muzzleWorld.x - origin.x) * Math.cos(radians) + (muzzleWorld.y - origin.y) * Math.sin(radians);
    const distance = Math.hypot(point.x - origin.x, point.y - origin.y);
    if (distance < Math.abs(lateral) + 0.001) return null;
    const longitudinal = (muzzleWorld.x - origin.x) * Math.sin(radians) - (muzzleWorld.y - origin.y) * Math.cos(radians);
    // A projectile begins at the barrel tip: targets inside its length are behind the shot.
    if (Math.sqrt(Math.max(0, distance ** 2 - lateral ** 2)) <= longitudinal + 0.001) return null;
    rotation = normalizeConstructVisualRotation(rotation - Math.asin(lateral / distance) * 180 / Math.PI);
  }
  rotation = mirrorConstructRotation(token, rotation);
  const requestedRotation = rotation;
  rotation = normalizeConstructVisualRotation((anchor?.rotation ?? 0)
    + clampConstructVisualRotation(rotation - (anchor?.rotation ?? 0), part.minRotation, part.maxRotation));
  return { slotId, rotation, requestedRotation, origin, allowed: isConstructAimWithinSector(requestedRotation, part, anchor?.rotation ?? 0) };
}

export async function performConstructPartRotation(tokenDocument, { partSlotId, slotId = partSlotId, rotation }, { user = game.user, buyOnly = false } = {}) {
  const token = tokenDocument?.object;
  if (!token || !canUserControlConstruct(token.actor, user, "aim", { partSlotId: slotId })) {
    resetConstructVisualRotationHistory(tokenDocument, slotId, user?.id);
    throw new Error("Нет доступа к прицеливанию этой деталью.");
  }
  const config = getConstructVisualConfig(token.actor);
  const part = config.parts.find(part => part.slotId === slotId && part.rotates);
  const layer = resolveConstructVisualLayers(token.actor, visualOptions(token)).find(layer => layer.slotId === slotId);
  const anchor = resolveConstructVisualAnchors(token.actor, visualOptions(token)).find(anchor => anchor.id === part?.anchorId);
  if (!config.enabled || !part || !layer?.visible || layer.broken || !Number.isFinite(rotation)) {
    resetConstructVisualRotationHistory(tokenDocument, slotId, user?.id);
    throw new Error("Поворот детали недоступен.");
  }
  if (!isConstructAimWithinSector(rotation, part, anchor?.rotation ?? 0)) throw new Error("Направление выходит за сектор поворота детали.");
  if (buyOnly) {
    const paid = await purchaseConstructRotation(tokenDocument, slotId, rotation);
    return { ok: paid.reached, rotation: paid.rotation, cost: paid.cost };
  }
  if (!isConstructRotationPaid(tokenDocument, slotId, rotation)) throw new Error("Поворот выходит за оплаченный сектор или требуемая система выключена.");
  const reached = validateConstructVisualRotationCommit(tokenDocument, slotId, rotation, user);
  if (!reached.ok) throw new Error("Башня ещё не достигла этого направления. Дождитесь её поворота при прицеливании.");
  const stored = tokenDocument.getFlag(SYSTEM, CONSTRUCT_VISUAL_STATE_FLAG) ?? {};
  await tokenDocument.setFlag(SYSTEM, CONSTRUCT_VISUAL_STATE_FLAG, { ...stored,
    rotations: { ...(stored.rotations ?? {}), [slotId]: reached.rotation } });
  return { ok: true, rotation: reached.rotation };
}

async function requestConstructRotationBudget(token, slotId, rotation, authorization = {}) {
  const { requestConstructCrewControl } = await import("./construct-crew.mjs");
  const response = await requestConstructCrewControl({ tokenUuid: token.document.uuid, action: "rotationBudget", partSlotId: slotId, rotation,
    weaponUuid: authorization.weapon?.uuid ?? "", weaponFunctionId: authorization.weaponFunctionId ?? "", passengerId: authorization.passengerId ?? "" });
  if (!response?.ok) throw new Error("Не хватает ОП или энергии для следующего сектора поворота.");
  return response;
}

export async function requestConstructPartRotation({ tokenUuid, partSlotId, slotId = partSlotId, rotation } = {}) {
  const { requestConstructCrewControl } = await import("./construct-crew.mjs");
  return requestConstructCrewControl({ tokenUuid, action: "aim", partSlotId: slotId, rotation });
}

/** Aiming turns the physical detail; confirmation and cancel both preserve reached yaw. */
export function startConstructPartAim(token, slotId) {
  aimSession?.cancel();
  if (!canUserControlConstruct(token?.actor, game.user, "aim", { partSlotId: slotId })) return false;
  let latest = null;
  const activation = new AimActivationGate(() => getConstructPartRotationActivationSector(token, slotId));
  activation.initialize();
  const activationPreview = new AimActivationPreview();
  const updatePreview = () => activationPreview.update(activation, canvas.controls);
  const view = canvas.app.view;
  const cleanup = () => {
    view.removeEventListener("pointermove", move);
    view.removeEventListener("pointerdown", down, true);
    document.removeEventListener("keydown", key, true);
    activationPreview.destroy();
    clearConstructPartPreview(token, slotId);
    aimSession = null;
    refreshConstructRotationLimits(token);
  };
  const move = event => {
    const point = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
    const accepted = activation.accept(point);
    updatePreview();
    if (!accepted) return;
    latest = getConstructPartAim(token, slotId, point);
    if (latest) previewConstructPartRotation(token, slotId, latest.rotation);
  };
  const down = event => {
    if (![0, 2].includes(event.button)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.button === 2) return cleanup();
    move(event);
    if (!latest) return;
    const current = getConstructPartRotations(token)[slotId] ?? 0;
    if (Math.abs(normalizeConstructVisualRotation(current - latest.rotation)) > 2) { ui.notifications.info("Башня ещё доворачивается к прицелу."); return; }
    void requestConstructPartRotation({ tokenUuid: token.document.uuid, slotId, rotation: current })
      .then(cleanup).catch(error => { ui.notifications.error(error.message); cleanup(); });
  };
  const key = event => { if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); cleanup(); } };
  view.addEventListener("pointermove", move);
  view.addEventListener("pointerdown", down, true);
  document.addEventListener("keydown", key, true);
  aimSession = { cancel: cleanup, token, slotId, updatePreview };
  updatePreview();
  refreshConstructRotationLimits(token);
  if (activation.waiting) notifyAimActivationRequired(activation);
  else ui.notifications.info("Башня следует за курсором. ЛКМ — подтвердить, Esc/ПКМ — отменить.");
  return true;
}

export function updateConstructWeaponAimPreview(controller) {
  if (controller?.aimActivation?.waiting) return;
  if (isConstructPersonalWeapon(controller?.token, controller?.weapon)) return;
  const access = getConstructWeaponPreviewAccess(controller);
  if (!access.allowed || !access.slotId) return;
  const aim = getConstructPartAim(controller.token, access.slotId, controller.pointer, { muzzleAnchorId: access.muzzleAnchorId });
  if (aim) previewConstructPartRotation(controller.token, access.slotId, aim.rotation, { controller });
}

/** Only preview eligibility is cached. Authority and execution keep their fresh permission checks. */
function getConstructWeaponPreviewAccess(controller) {
  if (!controller || typeof controller !== "object") return { allowed: false, slotId: "" };
  const actor = controller.token?.actor, weapon = controller.weapon, user = game.user;
  const weaponFunctionId = controller.weaponFunctionId ?? "", passengerId = controller.operatorPassengerId ?? "";
  const revision = getConstructVisualRuntimeRevision();
  const previous = previewAccess.get(controller);
  if (revision !== null && previous?.revision === revision && previous.actor === actor && previous.weapon === weapon
    && previous.user === user && previous.weaponFunctionId === weaponFunctionId && previous.passengerId === passengerId) return previous;
  const slotId = getConstructWeaponControlSlot(actor, weapon, weaponFunctionId);
  const allowed = Boolean(slotId && canUserUseConstructWeapon(actor, weapon, user, "aim", weaponFunctionId, { passengerId }));
  const muzzleAnchorId = getConstructWeaponOperatorConfig(weapon, weaponFunctionId).muzzleAnchorId || "";
  const entry = { revision, actor, weapon, user, weaponFunctionId, passengerId, slotId, muzzleAnchorId, allowed };
  if (revision !== null) previewAccess.set(controller, entry);
  return entry;
}

export function clearConstructWeaponAimPreview(controller) {
  if (isConstructPersonalWeapon(controller?.token, controller?.weapon)) return;
  const slotId = getConstructWeaponControlSlot(controller?.token?.actor, controller?.weapon, controller?.weaponFunctionId);
  if (slotId) return clearConstructPartPreview(controller.token, slotId);
}

export function getConstructWeaponAimOrigin(token, weapon, weaponFunctionId = "") {
  if (!token) return null;
  if (isConstructPersonalWeapon(token, weapon)) return getConstructPersonalWeaponAimOrigin(token, weapon);
  const slotId = getConstructWeaponControlSlot(token?.actor, weapon, weaponFunctionId);
  const part = getConstructVisualConfig(token.actor).parts.find(part => part.slotId === slotId);
  const layer = resolveConstructVisualLayers(token?.actor, visualOptions(token)).find(layer => layer.slotId === slotId && layer.visible);
  if (!layer) return null;
  const selectedMuzzleAnchorId = getConstructWeaponOperatorConfig(weapon, weaponFunctionId).muzzleAnchorId;
  const muzzleAnchorId = selectedMuzzleAnchorId || part?.muzzleAnchorId;
  const muzzle = resolveConstructVisualAnchors(token.actor, visualOptions(token)).find(anchor => anchor.id === muzzleAnchorId && anchor.parentVisible);
  if (selectedMuzzleAnchorId && !muzzle) return null;
  return constructPointToWorld(muzzle ?? layer, token);
}

/** The sector follows its resolved parent anchor, including live rotation previews. */
export function getConstructWeaponAimSector(token, weapon, weaponFunctionId = "") {
  if (!token) return null;
  if (isConstructPersonalWeapon(token, weapon)) {
    const seat = getConstructPersonalWeaponSeat(token, weapon);
    return seat ? getConstructFiringPortWorldTransform(token, seat) : null;
  }
  const slotId = getConstructWeaponControlSlot(token.actor, weapon, weaponFunctionId);
  const config = getConstructVisualConfig(token.actor);
  const part = config.parts.find(part => part.slotId === slotId && part.rotates);
  if (!part) return null;
  const options = visualOptions(token);
  const layer = resolveConstructVisualLayers(token.actor, options).find(layer => layer.slotId === slotId && layer.visible);
  if (!layer) return null;
  const anchor = resolveConstructVisualAnchors(token.actor, options).find(anchor => anchor.id === part.anchorId);
  const { signX, signY } = tokenVisualScale(token);
  const direction = signX * signY;
  return { rotation: tokenFrame(token).rotation + mirrorConstructRotation(token, anchor?.rotation ?? 0),
    minRotation: direction > 0 ? part.minRotation : -part.maxRotation,
    maxRotation: direction > 0 ? part.maxRotation : -part.minRotation };
}

/** The mechanical ray follows the current barrel direction while the cursor is pursued. */
export function getConstructWeaponAimPoint(token, weapon, cursor, weaponFunctionId = "") {
  if (!token || !cursor) return cursor;
  if (isConstructPersonalWeapon(token, weapon)) {
    const seat = getConstructPersonalWeaponSeat(token, weapon);
    const port = seat && getConstructFiringPortWorldTransform(token, seat);
    return port ? constrainConstructFiringPortAimPoint(port, cursor) : null;
  }
  const slotId = getConstructWeaponControlSlot(token.actor, weapon, weaponFunctionId);
  const layer = resolveConstructVisualLayers(token.actor, visualOptions(token)).find(layer => layer.slotId === slotId && layer.visible && layer.rotates);
  if (!layer) return cursor;
  if (!getConstructPartAim(token, slotId, cursor, { muzzleAnchorId: getConstructWeaponOperatorConfig(weapon, weaponFunctionId).muzzleAnchorId })) return null;
  const origin = getConstructWeaponAimOrigin(token, weapon, weaponFunctionId);
  const angle = (tokenFrame(token).rotation + mirrorConstructRotation(token, layer.rotation)) * Math.PI / 180;
  const distance = Math.max(1, Math.hypot(cursor.x - origin.x, cursor.y - origin.y));
  return { x: origin.x + Math.sin(angle) * distance, y: origin.y - Math.cos(angle) * distance };
}

export async function prepareConstructWeaponAttackExecution(controller) {
  const token = controller?.token;
  if (isConstructPersonalWeapon(token, controller?.weapon)) {
    const user = game.users?.get?.(controller.operatorUserId) ?? game.user;
    const aimPoint = getConstructWeaponAimPoint(token, controller.weapon, controller.pointer, controller.weaponFunctionId);
    const result = validateConstructPersonalWeaponAim(token, controller.weapon, aimPoint,
      { user, passengerId: controller.operatorPassengerId });
    if (!result.allowed) ui.notifications.warn(result.reason);
    return result.allowed;
  }
  if (token?.actor?.type !== "construct" || !getConstructVisualConfig(token.actor).enabled) return true;
  const operatorUser = game.users?.get?.(controller.operatorUserId) ?? game.user;
  if (!canUserUseConstructWeapon(token.actor, controller.weapon, operatorUser, "fire", controller.weaponFunctionId,
    { passengerId: controller.operatorPassengerId })) return false;
  const operatorConfig = getConstructWeaponOperatorConfig(controller.weapon, controller.weaponFunctionId);
  if (operatorConfig.muzzleAnchorId && !getConstructWeaponAimOrigin(token, controller.weapon, controller.weaponFunctionId)) {
    ui.notifications.warn("Точка выстрела недоступна.");
    return false;
  }
  const slotId = getConstructWeaponControlSlot(token.actor, controller.weapon, controller.weaponFunctionId);
  const aim = getConstructPartAim(token, slotId, controller.pointer,
    { muzzleAnchorId: operatorConfig.muzzleAnchorId });
  const rotatingPart = getConstructVisualConfig(token.actor).parts.find(part => part.slotId === slotId && part.rotates);
  if (!aim) {
    if (!rotatingPart) return true;
    ui.notifications.warn("Цель находится позади точки выстрела или внутри длины ствола.");
    return false;
  }
  const current = getConstructPartRotations(token)[slotId] ?? resolveConstructVisualLayers(token.actor, visualOptions(token)).find(layer => layer.slotId === slotId)?.rotation ?? 0;
  if (Math.abs(normalizeConstructVisualRotation(current - aim.rotation)) > 2) { ui.notifications.info("Башня ещё доворачивается к прицелу."); return false; }
  if (!canUserUseConstructWeapon(token.actor, controller.weapon, operatorUser, "aim", controller.weaponFunctionId,
    { passengerId: controller.operatorPassengerId })) return true;
  try {
    if (game.user?.isGM && operatorUser.id !== game.user.id) {
      await performConstructPartRotation(token.document, { slotId, rotation: current }, { user: operatorUser });
    } else await requestConstructPartRotation({ tokenUuid: token.document.uuid, slotId, rotation: current });
    clearConstructPartPreview(token, slotId);
    return true;
  } catch (error) { ui.notifications.error(error.message); return false; }
}

export async function startConstructCrewWeaponAttack({ token, weapon, weaponFunctionId = "", actionKey = "snapshot", operatorPassengerId = "" } = {}) {
  if (!canUserUseConstructWeapon(token?.actor, weapon, game.user, "fire", weaponFunctionId, { passengerId: operatorPassengerId })) return false;
  const { startWeaponAttack } = await import("../combat/weapon-attack-controller.mjs");
  return startWeaponAttack({ token, weapon, weaponFunctionId, actionKey, operatorPassengerId, useGmAuthority: true, finishAfterAttack: true });
}

export const CONSTRUCT_VISUAL_TESTING = { states, previews, rotatingPreviews, tickConstructRotations, tokenFrame,
  imageCache, compositeSweepBounds, constructPointToWorld, tokenVisualScale, mirrorConstructRotation,
  getConstructWeaponPreviewAccess };
