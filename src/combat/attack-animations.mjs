import { SYSTEM_ID } from "../constants.mjs";
import {
  resolveAnimationLibraryFile
} from "../utils/animation-library.mjs";
import { getAnimationTemplate } from "../utils/animation-templates.mjs";
import { ITEM_FUNCTIONS, getWeaponFunctionById } from "../utils/item-functions.mjs";

const ATTACK_ANIMATION_SOCKET = `system.${SYSTEM_ID}`;
const ATTACK_ANIMATION_SOCKET_SCOPE = "weaponAttackAnimation";
const STATIC_ANIMATION_DURATION_MS = 600;
const MIN_ANIMATION_DURATION_MS = 120;
const MAX_ANIMATION_DURATION_MS = 12000;
const COMBAT_VISUALIZATION_LAYER_NAME = `${SYSTEM_ID}.combatVisualizations`;
const DEFAULT_COMBAT_VISUALIZATION_Z_INDEX = 999;

let combatVisualizationLayer = null;
const activeCombatVisuals = new Set();

export function getCombatVisualizationLayer() {
  if (!canvas.ready) return null;
  const parent = canvas.interface;
  if (!parent?.addChild) return canvas.controls ?? canvas.stage ?? null;
  if (combatVisualizationLayer?.destroyed || combatVisualizationLayer?.parent !== parent) {
    combatVisualizationLayer = null;
  }
  if (combatVisualizationLayer) return combatVisualizationLayer;

  const existing = parent.children?.find(child => (
    child?.name === COMBAT_VISUALIZATION_LAYER_NAME && !child.destroyed
  ));
  if (existing) return (combatVisualizationLayer = existing);

  const layer = new PIXI.Container();
  layer.name = COMBAT_VISUALIZATION_LAYER_NAME;
  layer.eventMode = "none";
  layer.interactive = false;
  layer.interactiveChildren = false;
  layer.sortableChildren = false;
  const controlsZIndex = Number(canvas.controls?.getZIndex?.() ?? canvas.controls?.zIndex);
  layer.zIndex = Number.isFinite(controlsZIndex) && controlsZIndex > 1
    ? controlsZIndex - 1
    : DEFAULT_COMBAT_VISUALIZATION_Z_INDEX;
  combatVisualizationLayer = parent.addChild(layer);
  return combatVisualizationLayer;
}

export function registerAttackAnimationSocket() {
  game.socket.on(ATTACK_ANIMATION_SOCKET, handleAttackAnimationSocketMessage);
  Hooks.on("canvasTearDown", releaseCombatVisualizationLayer);
}

function releaseCombatVisualizationLayer() {
  for (const visual of [...activeCombatVisuals]) visual.cleanup();
  combatVisualizationLayer = null;
}

function getCombatCanvasContext() {
  return {
    sceneId: String(canvas.scene?.id ?? ""),
    levelId: String(canvas.level?.id ?? "")
  };
}

function isCombatCanvasContextCurrent({ sceneId = "", levelId = "" } = {}) {
  const current = getCombatCanvasContext();
  return String(sceneId ?? "") === current.sceneId
    && String(levelId ?? "") === current.levelId;
}

function isCombatVisualizationLayerCurrent(layer) {
  if (!layer || layer.destroyed) return false;
  if (canvas.interface?.addChild) {
    return combatVisualizationLayer === layer && layer.parent === canvas.interface;
  }
  return layer === canvas.controls || layer === canvas.stage;
}

function createActiveCombatVisual(sprite, texture, ownsBaseTexture = false) {
  let cleaned = false;
  let waitFinisher = null;
  const visual = {
    setWaitFinisher(finisher) {
      if (cleaned) finisher?.();
      else waitFinisher = finisher;
    },
    clearWaitFinisher(finisher) {
      if (waitFinisher === finisher) waitFinisher = null;
    },
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      const finish = waitFinisher;
      waitFinisher = null;
      finish?.();
      if (sprite && !sprite.destroyed) {
        sprite.destroy({ children: true, texture: false, baseTexture: false });
      }
      destroyOwnedAnimationBaseTexture(texture, ownsBaseTexture);
      activeCombatVisuals.delete(visual);
    }
  };
  activeCombatVisuals.add(visual);
  return visual;
}

function destroyOwnedAnimationBaseTexture(texture, owned = false) {
  const baseTexture = texture?.baseTexture;
  if (owned && baseTexture && !baseTexture.destroyed) baseTexture.destroy();
}

function waitForCombatVisual(visual, durationMs, video = null) {
  return new Promise(resolve => {
    let finished = false;
    let timeoutId = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      video?.removeEventListener?.("ended", finish);
      visual?.clearWaitFinisher?.(finish);
      resolve();
    };
    visual?.setWaitFinisher?.(finish);
    if (finished) return;
    video?.addEventListener?.("ended", finish, { once: true });
    timeoutId = window.setTimeout(finish, Math.max(0, Number(durationMs) || 0));
  });
}

export async function playWeaponAttackAnimations({ weapon = null, weaponFunctionId = "", weaponData = null, trajectories = [], delayMs = 0 } = {}) {
  weaponData ??= getWeaponFunctionById(weapon, weaponFunctionId || ITEM_FUNCTIONS.weapon) ?? {};
  const animationKey = String(weaponData?.attackAnimationKey ?? "").trim();
  const soundPath = String(weaponData?.attackSoundPath ?? "").trim();
  const soundVolume = normalizeAttackSoundVolume(weaponData?.attackSoundVolume);
  if (!animationKey && !soundPath) return;
  const canvasContext = getCombatCanvasContext();

  const entries = [];
  const soundGroups = getOrderedDelayGroups(trajectories);
  if (animationKey && trajectories.length) {
    for (const [trajectoryIndex, trajectory] of trajectories.entries()) {
      if (!isCombatCanvasContextCurrent(canvasContext)) return;
      const animationTrajectories = Array.isArray(trajectory?.segments) && trajectory.segments.length
        ? trajectory.segments
        : [trajectory];
      const delayGroup = Number(trajectory.delayGroup ?? entries.length) || 0;
      for (const [segmentIndex, segment] of animationTrajectories.entries()) {
        if (!isCombatCanvasContextCurrent(canvasContext)) return;
        const animationTrajectory = normalizeAnimationTrajectory(segment);
        const file = await resolveAnimationLibraryFile(animationKey, {
          distance: animationTrajectory.distance,
          mediaType: "video"
        });
        if (!file) continue;
        entries.push({
          id: foundry.utils.randomID(),
          file,
          origin: animationTrajectory.origin,
          end: animationTrajectory.end,
          angle: animationTrajectory.angle,
          distance: animationTrajectory.distance,
          halfAngle: animationTrajectory.halfAngle,
          delayGroup,
          chainId: `${delayGroup}:${trajectoryIndex}`,
          segmentIndex
        });
      }
    }
  }
  if ((!entries.length && !soundPath) || !isCombatCanvasContextCurrent(canvasContext)) return;

  const payload = {
    scope: ATTACK_ANIMATION_SOCKET_SCOPE,
    action: "play",
    ...canvasContext,
    entries,
    soundPath,
    soundVolume,
    soundGroups,
    delayMs: Math.max(0, Math.trunc(Number(delayMs) || 0)),
    senderUserId: game.user?.id ?? ""
  };

  game.socket.emit(ATTACK_ANIMATION_SOCKET, payload);
  await playAttackAnimationGroup(payload);
}

export async function playWeaponExplosionAnimation({ weapon = null, weaponFunctionId = "", weaponData = null, center = null, radiusPixels = 0 } = {}) {
  weaponData ??= getWeaponFunctionById(weapon, weaponFunctionId || ITEM_FUNCTIONS.weapon) ?? {};
  const animationKey = String(weaponData?.volley?.explosionAnimationKey ?? "").trim();
  const soundPath = String(weaponData?.volley?.explosionSoundPath ?? "").trim();
  if (!animationKey && !soundPath) return;
  const canvasContext = getCombatCanvasContext();

  let file = "";
  if (animationKey) {
    file = await resolveAnimationLibraryFile(animationKey, {
      mediaType: "video"
    });
  }
  if ((!file && !soundPath) || !isCombatCanvasContextCurrent(canvasContext)) return;

  const payload = {
    scope: ATTACK_ANIMATION_SOCKET_SCOPE,
    action: "playExplosion",
    ...canvasContext,
    file,
    center: serializePoint(center),
    radiusPixels: Math.max(0, Number(radiusPixels) || 0),
    soundPath,
    senderUserId: game.user?.id ?? ""
  };

  game.socket.emit(ATTACK_ANIMATION_SOCKET, payload);
  await playExplosionAnimation(payload);
}

async function handleAttackAnimationSocketMessage(payload = {}, socketSenderUserId = "") {
  const authenticatedSenderUserId = String(socketSenderUserId ?? "").trim();
  if (
    !payload
    || payload.scope !== ATTACK_ANIMATION_SOCKET_SCOPE
    || !authenticatedSenderUserId
    || payload.senderUserId !== authenticatedSenderUserId
    || authenticatedSenderUserId === game.user?.id
    || !isCombatCanvasContextCurrent(payload)
  ) return;
  if (payload.action === "play") await playAttackAnimationGroup(payload);
  if (payload.action === "playExplosion") await playExplosionAnimation(payload);
}

async function playAttackAnimationGroup(payload = {}) {
  if (!isCombatCanvasContextCurrent(payload)) return;
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  const soundGroups = Array.isArray(payload.soundGroups) && payload.soundGroups.length
    ? payload.soundGroups.map(group => Number(group) || 0)
    : [0];
  const delayMs = Math.max(0, Math.trunc(Number(payload.delayMs) || 0));
  const promises = [];

  const entriesByGroup = new Map();
  for (const [index, entry] of entries.entries()) {
    const delayGroup = Number(entry.delayGroup ?? index) || 0;
    const groupEntries = entriesByGroup.get(delayGroup) ?? [];
    groupEntries.push(entry);
    entriesByGroup.set(delayGroup, groupEntries);
  }

  for (let index = 0; index < soundGroups.length; index += 1) {
    if (index > 0 && delayMs > 0) await sleep(delayMs);
    if (!isCombatCanvasContextCurrent(payload)) break;
    promises.push(playAttackSound(payload.soundPath, payload.soundVolume));
    const groupEntries = entriesByGroup.get(soundGroups[index]) ?? [];
    const chains = new Map();
    for (const entry of groupEntries) {
      const chainId = String(entry.chainId ?? entry.id);
      const chain = chains.get(chainId) ?? [];
      chain.push(entry);
      chains.set(chainId, chain);
    }
    for (const chain of chains.values()) {
      promises.push(playAttackAnimationChain(chain, payload));
    }
  }

  await Promise.all(promises);
}

async function playAttackAnimationChain(entries = [], canvasContext = {}) {
  const ordered = [...entries].sort((left, right) => (Number(left.segmentIndex) || 0) - (Number(right.segmentIndex) || 0));
  for (const entry of ordered) {
    if (!isCombatCanvasContextCurrent(canvasContext)) break;
    await playSingleAttackAnimation(entry, canvasContext);
  }
}

async function playAttackSound(path, volume = 1) {
  const src = String(path ?? "").trim();
  if (!src) return;
  try {
    await game.audio.play(src, {
      context: game.audio.interface,
      volume: normalizeAttackSoundVolume(volume)
    });
  } catch (error) {
    console.warn(`${SYSTEM_ID} | Attack sound failed to play: ${src}`, error);
  }
}

function normalizeAttackSoundVolume(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.min(1, Math.max(0, number));
}

async function playExplosionAnimation(payload = {}) {
  if (!isCombatCanvasContextCurrent(payload)) return;
  const promises = [playAttackSound(payload.soundPath)];
  if (payload.file) promises.push(playSingleExplosionAnimation(payload));
  await Promise.all(promises);
}

async function playSingleExplosionAnimation(payload = {}) {
  if (!isCombatCanvasContextCurrent(payload)) return;
  const layer = getCombatVisualizationLayer();
  if (!layer || !payload.file) return;

  let texture = null;
  let ownsBaseTexture = false;
  let visual = null;
  try {
    texture = await foundry.canvas.loadTexture(payload.file);
    if (!texture?.valid) return;

    let video = game.video.getVideoSource(texture);
    if (video) {
      texture = await game.video.cloneTexture(video);
      ownsBaseTexture = true;
      if (!texture?.valid) return;
      video = game.video.getVideoSource(texture);
    }
    if (!isCombatCanvasContextCurrent(payload) || !isCombatVisualizationLayerCurrent(layer)) return;

    const sprite = new PIXI.Sprite(texture);
    sprite.eventMode = "none";
    sprite.anchor.set(0.5, 0.5);
    sprite.position.set(Number(payload.center?.x) || 0, Number(payload.center?.y) || 0);

    const radiusPixels = Math.max(0, Number(payload.radiusPixels) || 0);
    if (radiusPixels > 0) {
      const diameter = radiusPixels * 2;
      const textureSize = Math.max(1, Number(texture.width) || 0, Number(texture.height) || 0);
      const scale = Math.max(0.001, diameter / textureSize);
      sprite.scale.set(scale, scale);
    }

    visual = createActiveCombatVisual(sprite, texture, ownsBaseTexture);
    layer.addChild(sprite);
    if (video) {
      video.loop = false;
      const done = waitForCombatVisual(visual, getVideoDurationMs(video), video);
      await game.video.play(video, { loop: false, offset: 0, volume: 0 });
      await done;
    } else {
      await waitForCombatVisual(visual, STATIC_ANIMATION_DURATION_MS);
    }
  } catch (error) {
    if (isCombatCanvasContextCurrent(payload)) {
      console.warn(`${SYSTEM_ID} | Explosion animation failed to play: ${payload.file}`, error);
    }
  } finally {
    if (visual) visual.cleanup();
    else destroyOwnedAnimationBaseTexture(texture, ownsBaseTexture);
  }
}

function getOrderedDelayGroups(trajectories = []) {
  const groups = [];
  const seen = new Set();
  for (const [index, trajectory] of trajectories.entries()) {
    const group = Number(trajectory?.delayGroup ?? index) || 0;
    if (seen.has(group)) continue;
    seen.add(group);
    groups.push(group);
  }
  return groups.length ? groups : [0];
}

async function playSingleAttackAnimation(entry = {}, canvasContext = {}) {
  if (!isCombatCanvasContextCurrent(canvasContext)) return;
  const layer = getCombatVisualizationLayer();
  if (!layer || !entry.file) return;

  let texture = null;
  let ownsBaseTexture = false;
  let visual = null;
  try {
    texture = await foundry.canvas.loadTexture(entry.file);
    if (!texture?.valid) return;

    let video = game.video.getVideoSource(texture);
    if (video) {
      texture = await game.video.cloneTexture(video);
      ownsBaseTexture = true;
      if (!texture?.valid) return;
      video = game.video.getVideoSource(texture);
    }
    if (!isCombatCanvasContextCurrent(canvasContext) || !isCombatVisualizationLayerCurrent(layer)) return;

    const sprite = new PIXI.Sprite(texture);
    sprite.eventMode = "none";
    sprite.position.set(Number(entry.origin?.x) || 0, Number(entry.origin?.y) || 0);
    sprite.rotation = Number(entry.angle) || 0;

    applySequencerStylePlacement(sprite, texture, entry);
    visual = createActiveCombatVisual(sprite, texture, ownsBaseTexture);
    layer.addChild(sprite);
    if (video) {
      video.loop = false;
      const done = waitForCombatVisual(visual, getVideoDurationMs(video), video);
      await game.video.play(video, { loop: false, offset: 0, volume: 0 });
      await done;
    } else {
      await waitForCombatVisual(visual, STATIC_ANIMATION_DURATION_MS);
    }
  } catch (error) {
    if (isCombatCanvasContextCurrent(canvasContext)) {
      console.warn(`${SYSTEM_ID} | Attack animation failed to play: ${entry.file}`, error);
    }
  } finally {
    if (visual) visual.cleanup();
    else destroyOwnedAnimationBaseTexture(texture, ownsBaseTexture);
  }
}

function getVideoDurationMs(video) {
  const duration = Number(video?.duration) || 0;
  if (!Number.isFinite(duration) || duration <= 0) return STATIC_ANIMATION_DURATION_MS;
  return Math.max(MIN_ANIMATION_DURATION_MS, Math.min(MAX_ANIMATION_DURATION_MS, Math.ceil(duration * 1000)));
}

function applySequencerStylePlacement(sprite, texture, entry) {
  const template = getAnimationTemplate(entry.file);

  if (template.type === "cone") {
    applyConeTemplatePlacement(sprite, texture, entry);
    return;
  }

  const textureWidth = Math.max(1, Number(texture.width) || 1);
  const textureHeight = Math.max(1, Number(texture.height) || 1);
  const startPoint = Number(template.startPoint) || 0;
  const endPoint = Number(template.endPoint) || 0;
  const widthWithoutPadding = textureWidth - (startPoint + endPoint);
  const scale = Math.max(0.001, (Number(entry.distance) || 0) / Math.max(1, widthWithoutPadding));

  sprite.anchor.set(startPoint / textureWidth, 0.5);
  sprite.scale.set(scale, scale);
  sprite.height = textureHeight * scale;
}

function applyConeTemplatePlacement(sprite, texture, entry) {
  const textureWidth = Math.max(1, Number(texture.width) || 1);
  const textureHeight = Math.max(1, Number(texture.height) || 1);
  const distanceScale = Math.max(0.001, (Number(entry.distance) || textureWidth) / textureWidth);
  const coneScale = getConeAngleScale(entry);
  sprite.anchor.set(0, 0.5);
  sprite.scale.set(distanceScale, distanceScale * coneScale);
  sprite.height = textureHeight * distanceScale * coneScale;
}

function getConeAngleScale(entry) {
  const halfAngle = Math.max(0, Number(entry.halfAngle) || 0);
  if (halfAngle <= 0) return 1;
  const fullAngleDegrees = halfAngle * 2 * (180 / Math.PI);
  return Math.max(0.35, Math.min(2, fullAngleDegrees / 60));
}

function serializePoint(point) {
  return {
    x: Number(point?.x) || 0,
    y: Number(point?.y) || 0
  };
}

function normalizeAnimationTrajectory(trajectory = {}) {
  const origin = serializePoint(trajectory.origin);
  const hasEnd = Number.isFinite(Number(trajectory?.end?.x)) && Number.isFinite(Number(trajectory?.end?.y));
  if (hasEnd) {
    const end = serializePoint(trajectory.end);
    const dx = end.x - origin.x;
    const dy = end.y - origin.y;
    const distance = Math.hypot(dx, dy);
    if (distance > 0.0001) {
      return {
        origin,
        end,
        angle: Math.atan2(dy, dx),
        distance,
        halfAngle: Math.max(0, Number(trajectory.halfAngle) || 0)
      };
    }
  }

  const angle = Number.isFinite(Number(trajectory.angle)) ? Number(trajectory.angle) : 0;
  const distance = Math.max(0, Number(trajectory.distance) || 0);
  return {
    origin,
    end: {
      x: origin.x + (Math.cos(angle) * distance),
      y: origin.y + (Math.sin(angle) * distance)
    },
    angle,
    distance,
    halfAngle: Math.max(0, Number(trajectory.halfAngle) || 0)
  };
}

function sleep(ms) {
  return new Promise(resolve => window.setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}
