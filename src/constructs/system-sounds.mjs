import { getConstructSystems, getConstructSystemState } from "../utils/construct-systems.mjs";
import { ConstructSpatialSound } from "./spatial-system-sound.mjs";
import { isTokenMovementTravel } from "../utils/token-movement-kind.mjs";

const loops = new Map(), oneShots = new Map(), starts = new Map();
const motions = new WeakMap(), previousStates = new WeakMap(), tokenSources = new WeakMap();

function selectSound(system, action) {
  const data = system.sounds?.[action], paths = (data?.paths ?? []).filter(Boolean);
  return paths.length ? { path: paths[Math.floor(Math.random() * paths.length)], volume: data.volume ?? 0.5,
    radius: system.soundRadius ?? 30, edgeVolume: system.soundEdgeVolume ?? 0.25, walls: system.soundWalls ?? true,
    fadeIn: system.soundFadeIn ?? 180, fadeOut: system.soundFadeOut ?? 300, resumeWindow: system.soundResumeWindow ?? 250 } : null;
}
function tokenSystemKey(token, system) { return `${token.document.uuid}:${system.id}`; }
function loopKey(token, system, action) { return `${tokenSystemKey(token, system)}:${action}`; }
function trackSource(token, entry) {
  const sources = tokenSources.get(token) ?? new Set(); sources.add(entry); tokenSources.set(token, sources);
}
function destroyEntry(entry) {
  if (!entry) return;
  clearTimeout(entry.stopTimer);
  tokenSources.get(entry.token)?.delete(entry); entry.spatial.destroy();
}
function stopLoop(key) {
  const entry = loops.get(key); if (!entry) return;
  loops.delete(key); destroyEntry(entry);
}
function matches(entry, system, action) {
  const data = system.sounds?.[action], config = entry.spatial.config;
  return data?.paths.includes(config.path) && config.volume === data.volume
    && config.radius === (system.soundRadius ?? 30) && config.edgeVolume === (system.soundEdgeVolume ?? 0.25)
    && config.walls === (system.soundWalls ?? true) && config.fadeIn === (system.soundFadeIn ?? 180)
    && config.fadeOut === (system.soundFadeOut ?? 300) && config.resumeWindow === (system.soundResumeWindow ?? 250);
}
function setLoop(token, system, action, level, { retain = false } = {}) {
  const key = loopKey(token, system, action), entry = loops.get(key);
  if (!level) {
    if (!entry) return;
    if (retain) { clearTimeout(entry.stopTimer); entry.stopTimer = null; }
    else if (entry.stopTimer) return;
    entry.spatial.setLevel(0);
    if (retain) return;
    entry.stopTimer = setTimeout(() => stopLoop(key), entry.spatial.config.fadeOut + entry.spatial.config.resumeWindow);
    return;
  }
  if (entry && matches(entry, system, action)) {
    clearTimeout(entry.stopTimer); entry.stopTimer = null; entry.spatial.setLevel(level); return;
  }
  if (entry) stopLoop(key);
  const config = selectSound(system, action); if (!config) return;
  const spatial = new ConstructSpatialSound(token, config, { sourceId: `fallout-maw:${key}` });
  spatial.setLevel(level);
  const next = { token, spatial, sound: spatial.sound, actorUuid: token.actor.uuid, systemId: system.id };
  loops.set(key, next); trackSource(token, next);
}
function cancelStart(key) {
  const entry = starts.get(key); if (!entry) return;
  starts.delete(key); oneShots.delete(entry.id); destroyEntry(entry);
}
function playTransition(token, system, action) {
  // A transient event is not replayed minutes later after an unrelated browser audio unlock.
  if (game.audio.locked) return;
  const config = selectSound(system, action); if (!config) return;
  const key = tokenSystemKey(token, system), id = `${key}:${action}:${foundry.utils.randomID()}`;
  for (const [oldId, old] of oneShots) if (old.token === token && old.systemId === system.id) {
    oneShots.delete(oldId); if (starts.get(key) === old) starts.delete(key); destroyEntry(old);
  }
  if (action === "start") for (const phase of ["idle", "move"]) for (const path of system.sounds?.[phase]?.paths ?? [])
    void game.audio.create({ src: path, context: game.audio.environment, singleton: true }).load()
      .catch(error => console.warn("Загрузка звука конструкта", error));
  let entry;
  const onEnded = () => {
    if (!oneShots.has(id)) return;
    oneShots.delete(id);
    if (starts.get(key) === entry) starts.delete(key);
    destroyEntry(entry); syncActorSounds(token.actor);
  };
  const spatial = new ConstructSpatialSound(token, config, { sourceId: `fallout-maw:${id}`, loop: false, onEnded });
  entry = { id, token, spatial, sound: spatial.sound, actorUuid: token.actor.uuid, systemId: system.id };
  oneShots.set(id, entry); trackSource(token, entry);
  if (action === "start") starts.set(key, entry);
}
function syncActorSounds(actor, { transitions = false } = {}) {
  const previous = previousStates.get(actor) ?? new Map(), next = new Map();
  const tokens = (canvas.tokens?.placeables ?? []).filter(token => token.actor === actor && !token.isPreview && !token.document.hidden);
  const systems = getConstructSystems(actor);
  for (const [key, entry] of loops) if (entry.actorUuid === actor.uuid
    && !systems.some(system => system.id === entry.systemId && system.enabled)) stopLoop(key);
  for (const [key, entry] of starts) if (entry.actorUuid === actor.uuid
    && !systems.some(system => system.id === entry.systemId && system.enabled)) cancelStart(key);
  for (const system of systems) {
    const state = getConstructSystemState(actor, system), active = state.operational && state.stored > 0;
    next.set(system.id, active);
    for (const token of tokens) {
      const key = tokenSystemKey(token, system);
      if (!active) cancelStart(key);
      if (transitions && previous.has(system.id) && previous.get(system.id) !== active)
        playTransition(token, system, active ? "start" : "stop");
      const running = active && !starts.has(key);
      syncTokenSystemLoops(token, system, active, running);
    }
  }
  previousStates.set(actor, next);
}
function syncTokenSystemLoops(token, system, active, running = active && !starts.has(tokenSystemKey(token, system))) {
  const motion = motions.get(token) ?? {}, moving = Boolean(motion.move || motion.hullRotate || motion.releaseTimer);
  // Keep a quiet engine bed under travel, so a changing track layer never creates a silence hole.
  setLoop(token, system, "idle", running ? (moving ? 0.25 : 1) : 0, { retain: active });
  setLoop(token, system, "move", running && moving ? 1 : 0, { retain: active });
  setLoop(token, system, "rotate", system.enabled && motion.rotate ? 1 : 0, { retain: system.enabled });
}
export function setConstructMotionSound(token, action, active) {
  if (!token?.document || token.destroyed || token.actor?.type !== "construct" || token.isPreview) return;
  const state = motions.get(token) ?? {};
  if (Boolean(state[action]) === Boolean(active)) return;
  const wasMoving = Boolean(state.move || state.hullRotate);
  state[action] = Boolean(active); motions.set(token, state);
  const moving = Boolean(state.move || state.hullRotate);
  const sync = () => {
    for (const system of getConstructSystems(token.actor)) {
      const systemState = getConstructSystemState(token.actor, system);
      const running = !token.document.hidden && systemState.operational && systemState.stored > 0;
      syncTokenSystemLoops(token, system, running);
    }
  };
  if (action !== "rotate") {
    if (moving) { clearTimeout(state.releaseTimer); state.releaseTimer = null; }
    else if (wasMoving) {
      const hold = Math.max(0, ...getConstructSystems(token.actor).map(system => system.soundResumeWindow ?? 250));
      clearTimeout(state.releaseTimer);
      state.releaseTimer = setTimeout(() => { state.releaseTimer = null; if (!token.destroyed) sync(); }, hold);
      return;
    }
    if (wasMoving === moving) return;
  }
  sync();
}
function removeTokenSounds(token) {
  clearTimeout(motions.get(token)?.releaseTimer);
  motions.delete(token);
  for (const [key, entry] of loops) if (entry.token === token) stopLoop(key);
  for (const [key, entry] of starts) if (entry.token === token) cancelStart(key);
  for (const [key, entry] of oneShots) if (entry.token === token) { oneShots.delete(key); destroyEntry(entry); }
}
export function registerConstructSystemSoundHooks() {
  Hooks.on("canvasReady", () => {
    for (const actor of new Set((canvas.tokens?.placeables ?? []).map(token => token.actor)))
      if (actor?.type === "construct") syncActorSounds(actor);
  });
  Hooks.on("canvasTearDown", () => {
    for (const token of canvas.tokens?.placeables ?? []) { clearTimeout(motions.get(token)?.releaseTimer); motions.delete(token); }
    for (const key of loops.keys()) stopLoop(key);
    starts.clear(); for (const entry of oneShots.values()) destroyEntry(entry); oneShots.clear();
  });
  Hooks.on("updateActor", (actor, changes) => {
    if (actor.type === "construct" && Object.keys(foundry.utils.flattenObject(changes))
      .some(key => key.startsWith("system.constructSystems") || key.startsWith("system.resources"))) syncActorSounds(actor, { transitions: true });
  });
  for (const event of ["updateItem", "createItem", "deleteItem"]) Hooks.on(event, item => {
    if (item.actor?.type === "construct") syncActorSounds(item.actor, { transitions: true });
  });
  Hooks.on("deleteToken", document => { if (document.object) removeTokenSounds(document.object); });
  Hooks.on("createToken", document => { if (document.actor?.type === "construct") syncActorSounds(document.actor); });
  Hooks.on("updateToken", (document, changes) => {
    if (document.actor?.type !== "construct") return;
    if (changes.hidden === true) removeTokenSounds(document.object);
    else if (changes.hidden === false) syncActorSounds(document.actor);
  });
  Hooks.on("refreshToken", token => {
    const entries = tokenSources.get(token); if (!entries?.size) return;
    let changed = false;
    for (const entry of entries) changed = entry.spatial.updatePosition() || changed;
    if (changed) canvas.perception.update({ refreshSounds: true });
  });
  Hooks.on("moveToken", (document, movement) => {
    const token = document.object;
    if (!isTokenMovementTravel(movement) || !token || token.actor?.type !== "construct" || token.isPreview || !getConstructSystems(token.actor).length
      || !(movement?.animation?.ended instanceof Promise)) return;
    const state = motions.get(token) ?? {}; state.moveCount = (state.moveCount ?? 0) + 1; motions.set(token, state);
    setConstructMotionSound(token, "move", true);
    void movement.animation.ended.finally(() => {
      state.moveCount = Math.max(0, state.moveCount - 1);
      if (!state.moveCount) setConstructMotionSound(token, "move", false);
    }).catch(() => undefined);
  });
}
