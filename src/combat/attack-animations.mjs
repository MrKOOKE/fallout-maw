import { SYSTEM_ID } from "../constants.mjs";
import {
  resolveAnimationLibraryFile
} from "../utils/animation-library.mjs";

const ATTACK_ANIMATION_SOCKET = `system.${SYSTEM_ID}`;
const ATTACK_ANIMATION_SOCKET_SCOPE = "weaponAttackAnimation";
const STATIC_ANIMATION_DURATION_MS = 600;
const MIN_ANIMATION_DURATION_MS = 120;
const MAX_ANIMATION_DURATION_MS = 12000;
const DISTANCE_FILE_PATTERN = /(?:^|[_\-\s])\d{1,3}(?:ft|m)(?=$|[_\-\s.])/i;
const RANGED_TEMPLATE = Object.freeze({
  gridSize: 200,
  startPoint: 200,
  endPoint: 200
});

export function registerAttackAnimationSocket() {
  game.socket.on(ATTACK_ANIMATION_SOCKET, handleAttackAnimationSocketMessage);
}

export async function playWeaponAttackAnimations({ weapon = null, trajectories = [], delayMs = 0 } = {}) {
  const animationKey = String(weapon?.system?.functions?.weapon?.attackAnimationKey ?? "").trim();
  const soundPath = String(weapon?.system?.functions?.weapon?.attackSoundPath ?? "").trim();
  if (!animationKey && !soundPath) return;

  const entries = [];
  if (animationKey && trajectories.length) {
    for (const trajectory of trajectories) {
      const file = await resolveAnimationLibraryFile(animationKey, {
        distance: Number(trajectory.distance) || 0,
        mediaType: "video"
      });
      if (!file) continue;
      entries.push({
        id: foundry.utils.randomID(),
        file,
        origin: serializePoint(trajectory.origin),
        end: serializePoint(trajectory.end),
        angle: Number(trajectory.angle) || 0,
        distance: Number(trajectory.distance) || 0,
        delayGroup: Number(trajectory.delayGroup ?? entries.length) || 0
      });
    }
  }
  if (!entries.length && !soundPath) return;

  const payload = {
    scope: ATTACK_ANIMATION_SOCKET_SCOPE,
    action: "play",
    sceneId: canvas.scene?.id ?? "",
    entries,
    soundPath,
    delayMs: Math.max(0, Math.trunc(Number(delayMs) || 0)),
    senderUserId: game.user?.id ?? ""
  };

  game.socket.emit(ATTACK_ANIMATION_SOCKET, payload);
  await playAttackAnimationGroup(payload);
}

async function handleAttackAnimationSocketMessage(payload = {}) {
  if (!payload || payload.scope !== ATTACK_ANIMATION_SOCKET_SCOPE || payload.senderUserId === game.user?.id) return;
  if (payload.action !== "play" || payload.sceneId !== canvas.scene?.id) return;
  await playAttackAnimationGroup(payload);
}

async function playAttackAnimationGroup(payload = {}) {
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  const delayMs = Math.max(0, Math.trunc(Number(payload.delayMs) || 0));
  const promises = [];
  let previousGroup = null;

  await playAttackSound(payload.soundPath);

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const delayGroup = Number(entry.delayGroup ?? index) || 0;
    if (index > 0 && delayMs > 0 && delayGroup !== previousGroup) await sleep(delayMs);
    previousGroup = delayGroup;
    promises.push(playSingleAttackAnimation(entry));
  }

  await Promise.all(promises);
}

async function playAttackSound(path) {
  const src = String(path ?? "").trim();
  if (!src) return;
  try {
    await game.audio.play(src, { context: game.audio.interface });
  } catch (error) {
    console.warn(`${SYSTEM_ID} | Attack sound failed to play: ${src}`, error);
  }
}

async function playSingleAttackAnimation(entry = {}) {
  const layer = getAttackAnimationLayer();
  if (!layer || !entry.file) return;

  let texture;
  try {
    texture = await foundry.canvas.loadTexture(entry.file);
  } catch (error) {
    console.warn(`${SYSTEM_ID} | Attack animation failed to load: ${entry.file}`, error);
    return;
  }
  if (!texture?.valid) return;

  let video = game.video.getVideoSource(texture);
  if (video) {
    texture = await game.video.cloneTexture(video);
    video = game.video.getVideoSource(texture);
  }

  const sprite = new PIXI.Sprite(texture);
  sprite.eventMode = "none";
  sprite.position.set(Number(entry.origin?.x) || 0, Number(entry.origin?.y) || 0);
  sprite.rotation = Number(entry.angle) || 0;

  applySequencerStylePlacement(sprite, texture, entry);
  layer.addChild(sprite);

  if (video) {
    video.loop = false;
    const durationMs = getVideoDurationMs(video);
    const done = waitForVideoEnd(video, durationMs);
    await game.video.play(video, { loop: false, offset: 0, volume: 0 });
    await done;
  } else {
    await sleep(STATIC_ANIMATION_DURATION_MS);
  }

  sprite.destroy({ children: true, texture: false, baseTexture: false });
}

function waitForVideoEnd(video, durationMs) {
  return new Promise(resolve => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      video.removeEventListener("ended", finish);
      resolve();
    };
    video.addEventListener("ended", finish, { once: true });
    window.setTimeout(finish, durationMs);
  });
}

function getVideoDurationMs(video) {
  const duration = Number(video?.duration) || 0;
  if (!Number.isFinite(duration) || duration <= 0) return STATIC_ANIMATION_DURATION_MS;
  return Math.max(MIN_ANIMATION_DURATION_MS, Math.min(MAX_ANIMATION_DURATION_MS, Math.ceil(duration * 1000)));
}

function getAttackAnimationLayer() {
  return canvas.controls?._rulerPaths ?? canvas.stage;
}

function applySequencerStylePlacement(sprite, texture, entry) {
  const template = getAnimationTemplate(entry.file);
  if (!template) {
    sprite.anchor.set(0.5, 0.5);
    return;
  }

  const textureWidth = Math.max(1, Number(texture.width) || 1);
  const textureHeight = Math.max(1, Number(texture.height) || 1);
  const startPoint = Math.max(0, Math.min(textureWidth, Number(template.startPoint) || 0));
  const endPoint = Math.max(0, Math.min(textureWidth - startPoint, Number(template.endPoint) || 0));
  const widthWithoutPadding = Math.max(1, textureWidth - (startPoint + endPoint));
  const scale = Math.max(0.001, (Number(entry.distance) || 0) / widthWithoutPadding);

  sprite.anchor.set(startPoint / textureWidth, 0.5);
  sprite.scale.set(scale, scale);
  sprite.height = textureHeight * scale;
}

function getAnimationTemplate(file) {
  if (!DISTANCE_FILE_PATTERN.test(String(file ?? ""))) return null;
  return RANGED_TEMPLATE;
}

function serializePoint(point) {
  return {
    x: Number(point?.x) || 0,
    y: Number(point?.y) || 0
  };
}

function sleep(ms) {
  return new Promise(resolve => window.setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}
