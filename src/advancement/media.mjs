import { SYSTEM_ID } from "../constants.mjs";
import { getTokenActionHudExperienceAwardSettings } from "../settings/accessors.mjs";
import { getLevelThreshold } from "../settings/levels.mjs";
import { resolveAnimationLibraryFile } from "../utils/animation-library.mjs";
import { toInteger } from "../utils/numbers.mjs";

const STATIC_ANIMATION_DURATION_MS = 600;
const MIN_ANIMATION_DURATION_MS = 120;
const MAX_ANIMATION_DURATION_MS = 12000;
const ADVANCEMENT_MEDIA_SOCKET = `system.${SYSTEM_ID}`;
const ADVANCEMENT_MEDIA_SOCKET_SCOPE = "advancementMedia";

export function registerAdvancementMediaSocket() {
  game.socket.on(ADVANCEMENT_MEDIA_SOCKET, handleAdvancementMediaSocketMessage);
}

export function getActorsCrossingLevelThreshold(actors = [], experienceAmount = 0, levelSettings = []) {
  const amount = Math.max(0, toInteger(experienceAmount));
  if (!amount) return [];
  const maxLevel = levelSettings[levelSettings.length - 1]?.level ?? 100;

  return actors.filter(actor => {
    const level = Math.max(1, toInteger(actor?.system?.attributes?.level));
    if (level >= maxLevel) return false;
    const currentExperience = Math.max(0, toInteger(actor?.system?.development?.experience));
    const nextThreshold = getLevelThreshold(levelSettings, level);
    return currentExperience < nextThreshold && currentExperience + amount >= nextThreshold;
  });
}

export async function playExperienceAwardMedia({ leveledActors = [], playExperienceSound = true } = {}) {
  if (Array.isArray(leveledActors) && leveledActors.length) {
    await broadcastAndPlayLevelUpMedia(leveledActors);
    return;
  }
  if (playExperienceSound) await broadcastAndPlayExperienceAwardSound();
}

export async function playExperienceAwardSound() {
  const settings = getTokenActionHudExperienceAwardSettings();
  await playConfiguredSound(settings.experienceSoundPath);
}

export async function playLevelUpMediaForActors(actors = []) {
  const settings = getTokenActionHudExperienceAwardSettings();
  const tokens = getVisibleTokensForActors(actors);
  const promises = tokens.map(token => playLevelUpAnimationForToken(token, settings.levelUpAnimationKey));
  promises.push(playConfiguredSound(settings.levelUpSoundPath));
  await Promise.all(promises);
}

async function broadcastAndPlayExperienceAwardSound() {
  const settings = getTokenActionHudExperienceAwardSettings();
  const payload = {
    scope: ADVANCEMENT_MEDIA_SOCKET_SCOPE,
    action: "experienceSound",
    soundPath: settings.experienceSoundPath,
    senderUserId: game.user?.id ?? ""
  };
  game.socket.emit(ADVANCEMENT_MEDIA_SOCKET, payload);
  await playConfiguredSound(payload.soundPath);
}

async function broadcastAndPlayLevelUpMedia(actors = []) {
  const settings = getTokenActionHudExperienceAwardSettings();
  const actorRefs = actors.map(actor => ({
    id: String(actor?.id ?? ""),
    uuid: String(actor?.uuid ?? "")
  })).filter(ref => ref.id || ref.uuid);
  const payload = {
    scope: ADVANCEMENT_MEDIA_SOCKET_SCOPE,
    action: "levelUp",
    sceneId: canvas?.scene?.id ?? "",
    actorRefs,
    soundPath: settings.levelUpSoundPath,
    animationKey: settings.levelUpAnimationKey,
    senderUserId: game.user?.id ?? ""
  };
  game.socket.emit(ADVANCEMENT_MEDIA_SOCKET, payload);
  await playLevelUpMediaForActorRefs(actorRefs, payload);
}

async function handleAdvancementMediaSocketMessage(payload = {}) {
  if (!payload || payload.scope !== ADVANCEMENT_MEDIA_SOCKET_SCOPE || payload.senderUserId === game.user?.id) return;
  if (payload.action === "experienceSound") {
    await playConfiguredSound(payload.soundPath);
    return;
  }
  if (payload.action === "levelUp") {
    await playLevelUpMediaForActorRefs(payload.actorRefs, payload);
  }
}

async function playLevelUpMediaForActorRefs(actorRefs = [], payload = {}) {
  const tokens = getVisibleTokensForActorRefs(actorRefs, payload.sceneId);
  const promises = tokens.map(token => playLevelUpAnimationForToken(token, payload.animationKey));
  promises.push(playConfiguredSound(payload.soundPath));
  await Promise.all(promises);
}

async function playConfiguredSound(path) {
  const src = String(path ?? "").trim();
  if (!src) return;
  try {
    await game.audio?.play?.(src, {
      context: game.audio?.interface,
      loop: false,
      volume: 0.7
    });
  } catch (error) {
    console.warn(`${SYSTEM_ID} | Failed to play advancement sound: ${src}`, error);
  }
}

function getVisibleTokensForActors(actors = []) {
  return getVisibleTokensForActorRefs(actors.map(actor => ({
    id: String(actor?.id ?? ""),
    uuid: String(actor?.uuid ?? "")
  })));
}

function getVisibleTokensForActorRefs(actorRefs = [], sceneId = canvas?.scene?.id ?? "") {
  if (sceneId && sceneId !== canvas?.scene?.id) return [];
  const refs = Array.isArray(actorRefs) ? actorRefs : [];
  const actorIds = new Set(refs.map(ref => String(ref?.id ?? "")).filter(Boolean));
  const actorUuids = new Set(refs.map(ref => String(ref?.uuid ?? "")).filter(Boolean));
  return (canvas?.tokens?.placeables ?? []).filter(token => {
    const actor = token?.actor;
    if (!actor) return false;
    return actorIds.has(String(actor.id ?? "")) || actorUuids.has(String(actor.uuid ?? ""));
  });
}

async function playLevelUpAnimationForToken(token, animationKey) {
  const key = String(animationKey ?? "").trim();
  if (!key || !token) return;

  const file = await resolveAnimationLibraryFile(key, { mediaType: "video" });
  if (!file) return;

  const layer = canvas?.controls?._rulerPaths ?? canvas?.stage;
  if (!layer) return;

  let texture;
  try {
    texture = await foundry.canvas.loadTexture(file);
  } catch (error) {
    console.warn(`${SYSTEM_ID} | Level-up animation failed to load: ${file}`, error);
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
  sprite.anchor.set(0.5, 0.5);
  const center = token.center ?? {
    x: Number(token.x) + (Number(token.w) || 0) / 2,
    y: Number(token.y) + (Number(token.h) || 0) / 2
  };
  sprite.position.set(Number(center.x) || 0, Number(center.y) || 0);

  const tokenSize = Math.max(1, Number(token.w) || 0, Number(token.h) || 0, Number(canvas?.grid?.size) || 100);
  const textureSize = Math.max(1, Number(texture.width) || 0, Number(texture.height) || 0);
  const scale = Math.max(0.001, (tokenSize * 2) / textureSize);
  sprite.scale.set(scale, scale);

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

function sleep(ms) {
  return new Promise(resolve => window.setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}
