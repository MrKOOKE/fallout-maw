import { SYSTEM_ID } from "../constants.mjs";
import { TRAVEL_GROUP_FLAG } from "../global-map/constants.mjs";
import { ACTOR_CONTAINER_FLAG } from "../utils/actor-containers.mjs";
import { collectActiveSceneWorldTimeActors } from "./world-time-actor-scope.mjs";

const actorIndexes = new Set();
const scopedActors = new Map();

let hooksRegistered = false;
let scopeRevision = 0;
let appliedScopeRevision = -1;
let scopeRefreshPromise = null;

/**
 * Maintain a live predicate subset of the active Scene's world-time Actor
 * scope. Candidate reads share one lazy scope refresh, so separate time
 * mechanics never rescan the Scene or Actor directory independently.
 *
 * @param {(actor: Actor) => boolean} predicate
 * @returns {{values: () => Promise<IterableIterator<Actor>>}}
 */
export function registerWorldTimeActorCandidateIndex(predicate) {
  if (typeof predicate !== "function") throw new TypeError("A world-time Actor predicate is required.");

  const index = {
    actors: new Map(),
    predicate,
    dirtyActorUuids: new Set(),
    fullRefresh: true
  };
  actorIndexes.add(index);
  registerIndexHooks();

  return Object.freeze({
    async values() {
      await ensureActiveSceneScope();
      refreshDirtyIndex(index);
      return index.actors.values();
    }
  });
}

export async function getActiveSceneWorldTimeActors() {
  registerIndexHooks();
  await ensureActiveSceneScope();
  return scopedActors.values();
}

function registerIndexHooks() {
  if (hooksRegistered) return;
  Hooks.on("createActor", refreshIndexedActor);
  Hooks.on("updateActor", onUpdateActor);
  Hooks.on("deleteActor", removeIndexedActor);
  for (const documentName of ["Item", "ActiveEffect"]) {
    Hooks.on(`create${documentName}`, refreshIndexedDocumentActor);
    Hooks.on(`update${documentName}`, refreshIndexedDocumentActor);
    Hooks.on(`delete${documentName}`, refreshIndexedDocumentActor);
  }
  Hooks.on("canvasReady", invalidateActiveSceneScope);
  Hooks.on("createToken", invalidateActiveSceneTokenScope);
  Hooks.on("updateToken", onUpdateActiveSceneToken);
  Hooks.on("deleteToken", invalidateActiveSceneTokenScope);
  for (const hookName of ["createSetting", "updateSetting", "deleteSetting", "createUser", "updateUser", "deleteUser"]) {
    Hooks.on(hookName, markAllIndexesDirty);
  }
  const once = typeof Hooks.once === "function" ? Hooks.once.bind(Hooks) : Hooks.on.bind(Hooks);
  once("ready", scheduleScopeWarmup);
  hooksRegistered = true;
}

function scheduleScopeWarmup() {
  const warmup = () => void ensureActiveSceneScope();
  if (typeof globalThis.requestIdleCallback === "function") {
    globalThis.requestIdleCallback(warmup, { timeout: 1000 });
  } else {
    globalThis.setTimeout(warmup, 0);
  }
}

async function ensureActiveSceneScope() {
  while (appliedScopeRevision !== scopeRevision) {
    if (scopeRefreshPromise) {
      await scopeRefreshPromise;
      continue;
    }

    const requestedRevision = scopeRevision;
    scopeRefreshPromise = collectActiveSceneWorldTimeActors()
      .then(actors => applyActiveSceneScope(actors, requestedRevision))
      .catch(error => {
        console.error("Fallout MaW | Active Scene world-time Actor scope refresh failed", error);
        applyActiveSceneScope([], requestedRevision);
      })
      .finally(() => {
        scopeRefreshPromise = null;
      });
    await scopeRefreshPromise;
  }
}

function applyActiveSceneScope(actors, revision) {
  scopedActors.clear();
  for (const actor of actors) {
    if (actor?.uuid) scopedActors.set(actor.uuid, actor);
  }
  for (const index of actorIndexes) {
    index.actors.clear();
    index.dirtyActorUuids.clear();
    index.fullRefresh = true;
  }
  appliedScopeRevision = revision;
}

function refreshIndexedDocumentActor(document) {
  const actor = findOwningActor(document);
  if (actor) refreshIndexedActor(actor);
}

function findOwningActor(document) {
  let parent = document?.parent ?? null;
  while (parent) {
    if (parent.documentName === "Actor") return parent;
    parent = parent.parent ?? null;
  }
  return null;
}

function onUpdateActor(actor, changes = {}) {
  refreshIndexedActor(actor);
  if (scopedActors.has(actor?.uuid) && actorScopeMembershipChanged(changes)) invalidateActiveSceneScope();
}

function refreshIndexedActor(actor) {
  if (!actor?.uuid || !scopedActors.has(actor.uuid)) return;
  scopedActors.set(actor.uuid, actor);
  for (const index of actorIndexes) index.dirtyActorUuids.add(actor.uuid);
}

function refreshDirtyIndex(index) {
  if (index.fullRefresh) {
    index.actors.clear();
    for (const actor of scopedActors.values()) refreshActorInIndex(actor, index);
    index.dirtyActorUuids.clear();
    index.fullRefresh = false;
    return;
  }

  for (const uuid of index.dirtyActorUuids) {
    const actor = scopedActors.get(uuid);
    if (actor) refreshActorInIndex(actor, index);
    else index.actors.delete(uuid);
  }
  index.dirtyActorUuids.clear();
}

function refreshActorInIndex(actor, index) {
  let relevant = false;
  try {
    relevant = index.predicate(actor) === true;
  } catch (error) {
    console.error("Fallout MaW | World-time Actor index predicate failed", error);
  }
  if (relevant) index.actors.set(actor.uuid, actor);
  else index.actors.delete(actor.uuid);
}

function removeIndexedActor(actor) {
  const uuid = String(actor?.uuid ?? "");
  if (!uuid) return;
  scopedActors.delete(uuid);
  for (const index of actorIndexes) {
    index.actors.delete(uuid);
    index.dirtyActorUuids.delete(uuid);
  }
}

function invalidateActiveSceneScope() {
  scopeRevision += 1;
}

function invalidateActiveSceneTokenScope(token) {
  const scene = globalThis.canvas?.scene;
  if (!scene || (token?.parent
    && token.parent !== scene
    && token.parent?.id !== scene.id
    && token.parent?.uuid !== scene.uuid)) return;
  invalidateActiveSceneScope();
}

function onUpdateActiveSceneToken(token, changes = {}) {
  if (!isActiveSceneToken(token)) return;
  const paths = getChangedPaths(changes);
  if (paths.some(tokenScopeMembershipChanged)) invalidateActiveSceneScope();
  else if (paths.some(path => path === "delta" || path.startsWith("delta."))) refreshIndexedActor(token?.actor);
}

function isActiveSceneToken(token) {
  const scene = globalThis.canvas?.scene;
  return Boolean(scene && (!token?.parent
    || token.parent === scene
    || token.parent?.id === scene.id
    || token.parent?.uuid === scene.uuid));
}

function tokenScopeMembershipChanged(path) {
  const deltaFlags = `delta.flags.${SYSTEM_ID}`;
  const deltaContainer = `delta.flags.${SYSTEM_ID}.${ACTOR_CONTAINER_FLAG}`;
  const deltaTravel = `delta.flags.${SYSTEM_ID}.${TRAVEL_GROUP_FLAG}`;
  return path === "actorId"
    || path === "actorLink"
    || path === "delta"
    || path === deltaFlags
    || path === deltaContainer
    || path.startsWith(`${deltaContainer}.passengers`)
    || path === deltaTravel
    || path.startsWith(`${deltaTravel}.units`)
    || path.startsWith(`${deltaTravel}.memberActorUuids`);
}

function markAllIndexesDirty() {
  for (const index of actorIndexes) index.fullRefresh = true;
}

function actorScopeMembershipChanged(changes = {}) {
  const paths = getChangedPaths(changes);
  const containerPassengers = `flags.${SYSTEM_ID}.${ACTOR_CONTAINER_FLAG}.passengers`;
  const travelGroup = `flags.${SYSTEM_ID}.${TRAVEL_GROUP_FLAG}`;
  return paths.some(path => (
    path === `flags.${SYSTEM_ID}.${ACTOR_CONTAINER_FLAG}`
    || path === containerPassengers
    || path.startsWith(`${containerPassengers}.`)
    || path === travelGroup
    || path === `${travelGroup}.units`
    || path.startsWith(`${travelGroup}.units.`)
    || path === `${travelGroup}.memberActorUuids`
    || path.startsWith(`${travelGroup}.memberActorUuids.`)
  ));
}

function getChangedPaths(changes, prefix = "", paths = []) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return paths;
  for (const [key, value] of Object.entries(changes)) {
    const normalizedKey = String(key).startsWith("-=") ? String(key).slice(2) : String(key);
    const path = prefix ? `${prefix}.${normalizedKey}` : normalizedKey;
    paths.push(path);
    if (value && typeof value === "object" && !Array.isArray(value)) getChangedPaths(value, path, paths);
  }
  return paths;
}
